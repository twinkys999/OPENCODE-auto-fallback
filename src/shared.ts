/**
 * Pure helpers shared by the server part, the TUI part and the RPC contract.
 * No Node or OpenCode imports here, so every part can use it.
 */

/** One entry of the fallback chain. */
export interface FallbackEntry {
  readonly providerID: string
  readonly modelID: string
}

export interface FallbackSettings {
  /** Master switch. `false` turns the whole plugin off without unloading it. */
  readonly enabled: boolean
  /** Ordered fallback chain as `providerID/modelID` strings. */
  readonly chain: readonly string[]
  /** How long a model stays skipped after it reported an exhausted quota. */
  readonly cooldownMinutes: number
  /** Upper bound for the delay before OpenCode retries with the new model. */
  readonly maxRetryDelayMs: number
}

/**
 * Default chain: free OpenCode Zen models (`opencode` provider), which need no
 * extra key and are reachable from Russia. Order = quality guess, first one wins.
 */
export const DEFAULT_FREE_CHAIN: readonly string[] = [
  "opencode/glm-5.3-flash-free",
  "opencode/minimax-m3.1-flash-free",
  "opencode/mimo-v2.6-flash-free",
  "opencode/longcat-2.5-free",
  "opencode/deepseek-v4.1-flash-free",
  "opencode/big-pickle",
  "opencode/iceman-free",
  "opencode/inkling-2-small-free",
  "opencode/flint-40b-free",
  "opencode/beam-free",
  "opencode/nemotron-3.5-super-vl-free",
]

export const DEFAULT_SETTINGS: FallbackSettings = {
  enabled: true,
  chain: DEFAULT_FREE_CHAIN,
  cooldownMinutes: 30,
  maxRetryDelayMs: 2000,
}

/**
 * Providers whose models are reachable from Russia. The model picker in the
 * TUI and the desktop app lists only models from these providers, because the
 * others answer `This model is not available in your country` (Google) or are
 * unverified. Everything else stays selectable by editing `auto-fallback.json`.
 */
export const RF_SAFE_PROVIDERS: readonly string[] = ["opencode"]

export function entryKey(providerID: string, modelID: string): string {
  return `${providerID}/${modelID}`
}

/**
 * Split `providerID/modelID`. Model IDs may contain slashes themselves
 * (for example `vercel/openai/gpt-5.4-nano`), so only the first slash splits.
 */
export function splitKey(key: string): FallbackEntry | undefined {
  const text = String(key ?? "").trim()
  const index = text.indexOf("/")
  if (index <= 0 || index === text.length - 1) return undefined
  return { providerID: text.slice(0, index), modelID: text.slice(index + 1) }
}

export function uniqueKeys(values: readonly unknown[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const value of values) {
    if (typeof value !== "string") continue
    const key = value.trim()
    if (!splitKey(key)) continue
    if (seen.has(key)) continue
    seen.add(key)
    out.push(key)
  }
  return out
}

function positiveInt(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === "number" ? value : Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, Math.round(parsed)))
}

/** Accepts anything (file contents, RPC input) and returns usable settings. */
export function normalizeSettings(input: unknown, base: FallbackSettings = DEFAULT_SETTINGS): FallbackSettings {
  const source = (input && typeof input === "object" ? input : {}) as Record<string, unknown>
  const rawChain = Array.isArray(source.chain) ? source.chain : undefined
  const chain = rawChain ? uniqueKeys(rawChain) : [...base.chain]
  return {
    enabled: typeof source.enabled === "boolean" ? source.enabled : base.enabled,
    chain,
    cooldownMinutes: positiveInt(source.cooldownMinutes, base.cooldownMinutes, 1, 24 * 60),
    maxRetryDelayMs: positiveInt(source.maxRetryDelayMs, base.maxRetryDelayMs, 0, 30_000),
  }
}

export interface FailureInfo {
  readonly type?: string
  readonly message?: string
  readonly status?: number
  readonly response?: { readonly body?: string }
  readonly retryAfterMs?: number
}

export interface FailureVerdict {
  /** `true` when the failure means "this model has no quota/tokens left". */
  readonly quota: boolean
  /** Short human-readable reason for a toast. */
  readonly reason: string
}

const QUOTA_STATUS = new Set([402, 429])

const QUOTA_PATTERN =
  /usage limit|usage-limit|rate limit|rate_limit|ratelimit|too many requests|quota|insufficient|out of (credits|tokens|usage)|credit balance|limit reached|limit exceeded|free (usage|tier|plan)|billing|payment required|capacity|overloaded|no tokens left|token budget|not available in your country|not available in your region|unsupported (country|region)|region is not supported/i

/** Context overflow is a different problem: OpenCode compacts, we must not switch models. */
const CONTEXT_PATTERN =
  /context (length|window|size)|maximum context|too many tokens|prompt is too long|input is too long|token limit (?:for|of) (?:this|the) model|reduce the length/i

const AUTH_PATTERN = /unauthorized|forbidden|invalid api key|incorrect api key|authentication|not authorized|permission denied/i

function shortReason(message: string | undefined, status: number | undefined): string {
  const text = (message ?? "").replace(/\s+/g, " ").trim()
  if (text) return text.length > 140 ? `${text.slice(0, 137)}...` : text
  return status === undefined ? "quota exhausted" : `HTTP ${status}`
}

/**
 * Decides whether a provider failure means "switch to the next model".
 *
 * Deliberately conservative: authentication, missing models, server errors and
 * context overflow are left to OpenCode. `429` and `402` always count, because
 * OpenCode Zen reports its free-model limit that way.
 */
export function classifyFailure(error: FailureInfo | undefined): FailureVerdict {
  const type = String(error?.type ?? "")
  const message = String(error?.message ?? "")
  const body = String(error?.response?.body ?? "")
  const status = typeof error?.status === "number" ? error.status : undefined
  const text = `${type} ${message} ${body}`.toLowerCase()

  if (CONTEXT_PATTERN.test(text) && status !== 429) {
    return { quota: false, reason: "context window" }
  }
  if (status === 401 || status === 404) {
    return { quota: false, reason: `HTTP ${status}` }
  }
  if (status !== undefined && status >= 500) {
    return { quota: false, reason: `HTTP ${status}` }
  }
  if (status !== undefined && QUOTA_STATUS.has(status)) {
    return { quota: true, reason: shortReason(message, status) }
  }
  if (AUTH_PATTERN.test(text)) {
    return { quota: false, reason: "auth" }
  }
  if (QUOTA_PATTERN.test(text)) {
    return { quota: true, reason: shortReason(message, status) }
  }
  if (status === 403 && QUOTA_PATTERN.test(text)) {
    return { quota: true, reason: shortReason(message, status) }
  }
  return { quota: false, reason: status === undefined ? "unknown" : `HTTP ${status}` }
}
