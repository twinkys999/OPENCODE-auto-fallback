/**
 * TUI part: the switch and the model picker.
 *
 *   f3            turn the automatic fallback on/off
 *   <leader>f     open the settings menu
 *   /fallback     same, from the prompt
 *   /aft          quick on/off from the prompt
 *   Ctrl+P        both commands are in the command palette
 */
import { Plugin } from "@opencode/plugin/tui"

import { FallbackRpc, type FallbackStatus, type SwitchedEvent } from "./rpc"
import { DEFAULT_FREE_CHAIN, RF_SAFE_PROVIDERS } from "./shared"

interface LocalModel {
  readonly providerID: string
  readonly modelID: string
  readonly name: string
  readonly type?: string
  readonly enabled?: boolean
  readonly cost?: ReadonlyArray<{ readonly input?: number; readonly output?: number }>
}

const DONE = "__done"
const CLEAR = "__clear"
const RESET = "__reset"

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error ?? "неизвестная ошибка")
}

function keyOf(model: { providerID: string; modelID: string }): string {
  return `${model.providerID}/${model.modelID}`
}

function isFree(model: LocalModel): boolean {
  const cost = model.cost ?? []
  return cost.length > 0 && cost.every((tier) => (tier.input ?? 0) === 0 && (tier.output ?? 0) === 0)
}

export default Plugin.define({
  id: "auto-fallback-tui",
  async setup(context) {
    const [state, setState] = context.storage.memory("auto-fallback", {
      initial: {
        enabled: false,
        chain: [] as string[],
        configPath: "",
        ready: false,
      },
    })

    const rpc = () => context.client.rpc(FallbackRpc)
    const callOptions = () => {
      const directory = context.location?.directory
      return directory ? { location: { directory } } : undefined
    }

    const toast = (message: string, variant: "info" | "success" | "warning" | "error" = "info", title = "Авто-фолбэк") => {
      context.ui.toast.show({ title, message, variant, duration: variant === "error" ? 8000 : 4000 })
    }

    const apply = (value: unknown) => {
      const status = value as FallbackStatus | undefined
      if (!status || typeof status !== "object" || typeof status.enabled !== "boolean") return
      setState((draft) => {
        draft.enabled = status.enabled
        draft.chain = Array.isArray(status.chain) ? [...status.chain] : []
        draft.configPath = typeof status.configPath === "string" ? status.configPath : draft.configPath
        draft.ready = true
      })
    }

    let stopped = false

    const refresh = async (retries = 0): Promise<void> => {
      try {
        apply(await rpc().status({}, callOptions()))
      } catch {
        if (retries > 0 && !stopped) {
          await new Promise((resolve) => setTimeout(resolve, 700))
          return refresh(retries - 1)
        }
      }
    }

    const toggle = async (enabled?: boolean) => {
      const next = typeof enabled === "boolean" ? enabled : !state.enabled
      try {
        apply(await rpc().toggle({ enabled: next }, callOptions()))
        toast(next ? `Включён, моделей в цепочке: ${state.chain.length}` : "Выключен", next ? "success" : "info")
      } catch (error) {
        toast(`Не удалось переключить: ${messageOf(error)}`, "error")
      }
    }

    const setChain = async (chain: readonly string[]) => {
      try {
        apply(await rpc().setChain({ chain: [...chain] }, callOptions()))
        return true
      } catch (error) {
        toast(`Не удалось сохранить список: ${messageOf(error)}`, "error")
        return false
      }
    }

    const loadModels = async (): Promise<LocalModel[]> => {
      const location = context.location
      try {
        await context.data.location.model.sync(location)
      } catch {
        // Offline or not synced yet: fall back to whatever is cached.
      }
      const list = (context.data.location.model.list(location) ?? []) as unknown as LocalModel[]
      return list
        .filter((model) => model && model.providerID && model.modelID)
        .filter((model) => model.enabled !== false)
        .filter((model) => model.type === undefined || model.type === "chat")
        .filter((model) => RF_SAFE_PROVIDERS.includes(model.providerID))
        .sort((left, right) => {
          const free = Number(isFree(right)) - Number(isFree(left))
          if (free !== 0) return free
          if (left.providerID !== right.providerID) return left.providerID.localeCompare(right.providerID)
          return left.name.localeCompare(right.name)
        })
    }

    const chainEditor = async () => {
      for (;;) {
        const models = await loadModels()
        const chain: readonly string[] = state.chain
        const position = new Map(chain.map((key: string, index: number) => [key, index + 1] as const))
        const options = [
          { title: "Готово", value: DONE, category: "Действия", description: "Закрыть список" },
          { title: "Очистить список", value: CLEAR, category: "Действия" },
          {
            title: "Вернуть бесплатные по умолчанию",
            value: RESET,
            category: "Действия",
            description: DEFAULT_FREE_CHAIN.slice(0, 3).join(" → ") + " → …",
          },
          ...models.map((model) => {
            const key = keyOf(model)
            const index = position.get(key)
            return {
              title: `${index ? `${index}. ` : "     "}${model.name}`,
              value: key,
              description: `${key}${isFree(model) ? " · бесплатная" : ""}`,
              category: isFree(model) ? "Бесплатные" : "Другие",
            }
          }),
        ]

        let picked: string | undefined
        try {
          picked = await context.ui.dialog.select({
            title: `Модели для замены (${chain.length})`,
            placeholder: "Имя или provider/model",
            options,
          })
        } catch {
          return
        }
        if (!picked || picked === DONE) return
        if (picked === CLEAR) {
          await setChain([])
          continue
        }
        if (picked === RESET) {
          await setChain(DEFAULT_FREE_CHAIN)
          continue
        }
        const next = chain.includes(picked) ? chain.filter((key: string) => key !== picked) : [...chain, picked]
        if (await setChain(next)) {
          toast(next.includes(picked) ? `Добавил ${picked}` : `Убрал ${picked}`, "info")
        }
      }
    }

    const menu = async () => {
      for (;;) {
        let picked: string | undefined
        try {
          picked = await context.ui.dialog.select({
            title: `Авто-фолбэк: ${state.enabled ? "включён" : "выключен"}`,
            options: [
              {
                title: state.enabled ? "Выключить" : "Включить",
                value: "toggle",
                category: "Переключатель",
                description: state.enabled ? "Перестать менять модель" : "Менять модель, когда кончились токены",
              },
              {
                title: `Модели для замены (${state.chain.length})`,
                value: "chain",
                category: "Настройка",
                description: state.chain.slice(0, 4).join(" → ") + (state.chain.length > 4 ? " → …" : ""),
              },
              {
                title: "Забыть, что модели кончились",
                value: "reset",
                category: "Настройка",
                description: "Снова пробовать все модели из списка",
              },
              {
                title: "Файл настроек",
                value: "path",
                category: "Прочее",
                description: state.configPath || "ещё не создан",
              },
            ],
          })
        } catch {
          return
        }
        if (!picked) return
        if (picked === "toggle") {
          await toggle()
          continue
        }
        if (picked === "chain") {
          await chainEditor()
          continue
        }
        if (picked === "reset") {
          try {
            apply(await rpc().resetCooldowns({}, callOptions()))
            toast("Готово: все модели снова в игре", "success")
          } catch (error) {
            toast(messageOf(error), "error")
          }
          continue
        }
        if (picked === "path") {
          await context.ui.dialog.alert({
            title: "Файл настроек",
            message: state.configPath || "Файл ещё не создан — он появится после первого переключения.",
          })
          continue
        }
      }
    }

    let stopSwitched = () => {}
    let stopChanged = () => {}

    try {
      stopSwitched = rpc().events.on("switched", (event) => {
        const status = event.data as unknown as SwitchedEvent
        toast(
          `Кончились токены: ${status.from} → ${status.to}\n${status.reason}`,
          "warning",
          "Авто-фолбэк: сменил модель",
        )
      })
      stopChanged = rpc().events.on("changed", (event) => apply(event.data))
    } catch {
      // Older server without this RPC: the commands keep working through calls.
    }

    void refresh(4)

    context.keymap.layer(() => ({
      mode: "global",
      priority: 10,
      commands: [
        {
          id: "auto-fallback.toggle",
          title: state.enabled ? "Авто-фолбэк: выключить" : "Авто-фолбэк: включить",
          description: state.enabled ? `Включён · ${state.chain.length} моделей в цепочке` : "Выключен",
          group: "Авто-фолбэк",
          bind: "f3",
          palette: true,
          slash: { name: "fallback-toggle", aliases: ["aft"] },
          run: () => toggle(),
        },
        {
          id: "auto-fallback.menu",
          title: "Авто-фолбэк: настройки",
          description: "Включить, выключить и выбрать модели для замены",
          group: "Авто-фолбэк",
          bind: "<leader>f",
          palette: true,
          slash: { name: "fallback", aliases: ["af"] },
          run: () => menu(),
        },
      ],
    }))

    return () => {
      stopped = true
      stopSwitched()
      stopChanged()
    }
  },
})
