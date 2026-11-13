/**
 * Server part: watches provider failures and, when a model runs out of tokens
 * or quota, moves the session to the next model of the fallback chain and lets
 * OpenCode retry the same step.
 */
import { Plugin } from "@opencode/plugin"

import { FallbackRpc, type FallbackModel, type FallbackStatus } from "./rpc"
import { defaultConfigPath, readSettings, writeSettings } from "./settings"
import {
  classifyFailure,
  DEFAULT_SETTINGS,
  entryKey,
  normalizeSettings,
  RF_SAFE_PROVIDERS,
  splitKey,
  uniqueKeys,
  type FallbackSettings,
} from "./shared"

/** How long a session's "already exhausted" memory is kept. */
const SESSION_TTL_MS = 6 * 60 * 60 * 1000
/** How long the list of available models is cached. */
const MODELS_TTL_MS = 60 * 1000
/** Safety valve for the session map. */
const MAX_SESSIONS = 500

interface PluginOptions {
  /** Override the settings file location. */
  readonly configPath?: unknown
  /** Initial switch state, used only when the settings file is created. */
  readonly enabled?: unknown
  /** Initial chain, used only when the settings file is created. */
  readonly chain?: unknown
  readonly cooldownMinutes?: unknown
  readonly maxRetryDelayMs?: unknown
}

/** One cost tier of a model: `{ input, output, ... }` in USD per million tokens. */
function freeTier(tier: unknown): boolean {
  if (!tier || typeof tier !== "object") return false
  const info = tier as Record<string, unknown>
  const input = typeof info.input === "number" ? info.input : undefined
  const output = typeof info.output === "number" ? info.output : undefined
  return (input === undefined || input === 0) && (output === undefined || output === 0)
}

export default Plugin.define({
  id: "auto-fallback",
  async setup(ctx) {
    const options = ctx.options as unknown as PluginOptions
    const configPath =
      typeof options?.configPath === "string" && options.configPath.trim().length > 0
        ? options.configPath.trim()
        : defaultConfigPath()

    const seeded: FallbackSettings = normalizeSettings({
      enabled: options?.enabled,
      chain: Array.isArray(options?.chain) ? options.chain : undefined,
      cooldownMinutes: options?.cooldownMinutes,
      maxRetryDelayMs: options?.maxRetryDelayMs,
    })

    const first = await readSettings(configPath)
    let settings: FallbackSettings = first.settings
    let mtimeMs = first.mtimeMs

    // First run: write the file so the chain is visible and editable by hand.
    if (mtimeMs === undefined) {
      mtimeMs = await writeSettings(configPath, seeded)
      if (mtimeMs !== undefined) settings = seeded
    }

    const sessions = new Map<string, { used: Map<string, number>; touched: number }>()
    let modelsCache: { at: number; keys: Set<string> } | undefined
    let events: { emit: (name: "changed" | "switched", data: unknown) => Promise<void> } | undefined
    let disposed = false

    const status = (): FallbackStatus => ({
      enabled: settings.enabled,
      chain: [...settings.chain],
      configPath,
    })

    const emit = async (name: "changed" | "switched", data: unknown) => {
      try {
        await events?.emit(name as never, data as never)
      } catch {
        // No TUI attached, or the RPC is gone: not an error.
      }
    }

    /** Re-read the file when it changed on disk (the person may edit it by hand). */
    const refresh = async (force = false) => {
      const loaded = await readSettings(configPath)
      if (!force && loaded.mtimeMs === mtimeMs) return
      mtimeMs = loaded.mtimeMs
      settings = loaded.settings
    }

    const persist = async (next: FallbackSettings) => {
      settings = normalizeSettings(next)
      const written = await writeSettings(configPath, settings)
      if (written !== undefined) mtimeMs = written
      await emit("changed", status())
      return status()
    }

    const usedFor = (sessionID: string) => {
      const now = Date.now()
      let record = sessions.get(sessionID)
      if (!record) {
        if (sessions.size >= MAX_SESSIONS) sessions.clear()
        record = { used: new Map(), touched: now }
        sessions.set(sessionID, record)
      }
      record.touched = now
      for (const [key, until] of record.used) {
        if (until <= now || now - record.touched > SESSION_TTL_MS) record.used.delete(key)
      }
      return record.used
    }

    /** Models OpenCode currently offers; `undefined` when the list is unavailable. */
    const availableModels = async (): Promise<Set<string> | undefined> => {
      if (modelsCache && Date.now() - modelsCache.at < MODELS_TTL_MS) return modelsCache.keys
      try {
        const result = await ctx.model.list()
        const keys = new Set<string>()
        for (const model of result?.data ?? []) {
          if (!model?.providerID || !model?.modelID) continue
          if (model.enabled === false) continue
          if (model.status === "deprecated") continue
          keys.add(entryKey(model.providerID, model.modelID))
        }
        modelsCache = { at: Date.now(), keys }
        return keys
      } catch {
        return undefined
      }
    }

    const registration = await ctx.rpc.register(FallbackRpc, {
      status: async () => {
        await refresh()
        return status()
      },
      toggle: async (input) => {
        const { enabled } = input as { enabled?: unknown }
        await refresh(true)
        return persist({ ...settings, enabled: typeof enabled === "boolean" ? enabled : !settings.enabled })
      },
      setChain: async (input) => {
        const { chain } = input as { chain?: unknown }
        await refresh(true)
        return persist({ ...settings, chain: uniqueKeys(Array.isArray(chain) ? chain : []) })
      },
      resetCooldowns: async () => {
        sessions.clear()
        return status()
      },
      models: async () => {
        const result = await ctx.model.list()
        const models: FallbackModel[] = []
        for (const raw of result?.data ?? []) {
          const info = raw as Record<string, unknown>
          const providerID = typeof info.providerID === "string" ? info.providerID : ""
          const modelID = typeof info.modelID === "string" ? info.modelID : ""
          if (!providerID || !modelID) continue
          if (info.enabled === false) continue
          if (info.status === "deprecated") continue
          const name = typeof info.name === "string" && info.name.trim() ? info.name.trim() : modelID
          const cost = Array.isArray(info.cost) ? info.cost : []
          const free = cost.length > 0 && cost.every((tier) => freeTier(tier))
          const rf = RF_SAFE_PROVIDERS.includes(providerID)
          models.push({ providerID, modelID, name, free, rf })
        }
        models.sort((left, right) => {
          if (left.free !== right.free) return Number(right.free) - Number(left.free)
          if (left.providerID !== right.providerID) return left.providerID.localeCompare(right.providerID)
          return left.name.localeCompare(right.name)
        })
        return { models }
      },
    })
    events = registration as unknown as typeof events

    await ctx.session.hook("retry", async (event) => {
      if (disposed) return
      try {
        await refresh()
        if (!settings.enabled) return
        if (settings.chain.length === 0) return

        const verdict = classifyFailure(event.error)
        if (!verdict.quota) return

        const currentKey = entryKey(String(event.model.providerID), String(event.model.id))
        const cooldownMs = settings.cooldownMinutes * 60 * 1000
        const used = usedFor(String(event.sessionID))
        used.set(currentKey, Date.now() + cooldownMs)

        const available = await availableModels()
        const now = Date.now()

        for (const key of settings.chain) {
          const entry = splitKey(key)
          if (!entry) continue
          if (key === currentKey) continue
          if ((used.get(key) ?? 0) > now) continue
          if (available && !available.has(key)) continue

          try {
            await ctx.session.switchModel({
              sessionID: event.sessionID,
              model: { id: entry.modelID, providerID: entry.providerID },
            })
          } catch (error) {
            void error
            used.set(key, now + cooldownMs)
            continue
          }

          const delay = Math.min(
            settings.maxRetryDelayMs,
            Math.max(0, Number(event.error.retryAfterMs ?? 0) || 0),
          )
          event.decision = { retry: true, delay }
          console.log(`[auto-fallback] ${currentKey} -> ${key} (${verdict.reason})`)
          await emit("switched", {
            sessionID: String(event.sessionID),
            from: currentKey,
            to: key,
            reason: verdict.reason,
          })
          return
        }

        // Nothing left to try: leave OpenCode's own retry policy alone.
        console.warn(
          `[auto-fallback] ${currentKey} is out of quota and the fallback chain has no usable model left`,
        )
      } catch (error) {
        console.error("[auto-fallback] retry hook failed", error)
      }
    })

    console.log(`[auto-fallback] ready (${settings.enabled ? "on" : "off"}, ${settings.chain.length} models, ${configPath})`)

    return () => {
      disposed = true
      sessions.clear()
    }
  },
})

export { DEFAULT_SETTINGS }
