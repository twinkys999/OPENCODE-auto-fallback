/**
 * Desktop (GUI) part: the same switch and model picker, as commands and dialogs
 * of the OpenCode Desktop app. Built with the `@opencode/plugin/gui/vite`
 * preset into `dist/gui-experimental.cjs`, which is the `./gui-experimental`
 * export of this package.
 */
import { Command, Plugin } from "@opencode/plugin/gui"

import { FallbackRpc, type FallbackModel, type FallbackStatus, type SwitchedEvent } from "./rpc"
import { DEFAULT_FREE_CHAIN } from "./shared"

const DONE = "__done"
const CLEAR = "__clear"
const RESET = "__reset"
type MenuItem = "toggle" | "chain" | "reset" | "path"

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error ?? "неизвестная ошибка")
}

function keyOf(model: FallbackModel): string {
  return `${model.providerID}/${model.modelID}`
}

export default Plugin.define({
  setup(ctx) {
    const rpc = () => ctx.client.rpc(FallbackRpc)

    /** Last known state, so the menu can show it without a fresh call. */
    let state: FallbackStatus & { ready: boolean } = {
      enabled: false,
      chain: [],
      configPath: "",
      ready: false,
    }

    const apply = (value: unknown) => {
      const next = value as FallbackStatus | undefined
      if (!next || typeof next !== "object" || typeof next.enabled !== "boolean") return
      state = {
        enabled: next.enabled,
        chain: [...(next.chain ?? [])],
        configPath: String(next.configPath ?? state.configPath),
        ready: true,
      }
    }

    const refresh = async (retries = 0): Promise<void> => {
      try {
        apply(await rpc().status({}))
      } catch {
        if (retries > 0) {
          await new Promise((resolve) => setTimeout(resolve, 700))
          return refresh(retries - 1)
        }
      }
    }

    const toastError = (error: unknown): void => {
      ctx.toast.show({
        title: "Авто-фолбэк: ошибка",
        description: messageOf(error),
        variant: "error",
        duration: 8000,
      })
    }

    const toggle = async (enabled?: boolean): Promise<void> => {
      const next = typeof enabled === "boolean" ? enabled : !state.enabled
      try {
        apply(await rpc().toggle({ enabled: next }))
        ctx.toast.show({
          title: next ? "Авто-фолбэк включён" : "Авто-фолбэк выключен",
          description: next ? `Моделей в цепочке: ${state.chain.length}` : undefined,
          variant: next ? "success" : "default",
        })
      } catch (error) {
        toastError(error)
      }
    }

    const setChain = async (chain: readonly string[]): Promise<boolean> => {
      try {
        apply(await rpc().setChain({ chain: [...chain] }))
        return true
      } catch (error) {
        toastError(error)
        return false
      }
    }

    const loadModels = async (): Promise<readonly FallbackModel[]> => {
      try {
        const result = (await rpc().models({})) as unknown as { models?: readonly FallbackModel[] }
        return result?.models ?? []
      } catch {
        return []
      }
    }

    /**
     * The model picker: clicking a model in the list adds it to the end of the
     * chain, clicking again removes it; the list reopens after every pick.
     */
    const chainEditor = async (): Promise<void> => {
      for (;;) {
        const models = (await loadModels()).filter((model) => model.rf)
        const chain = state.chain
        const position = new Map(chain.map((key, index) => [key, index + 1] as const))
        type Pick = typeof DONE | typeof CLEAR | typeof RESET | string
        const options: {
          title: string
          value: Pick
          description?: string
          group?: string
        }[] = [
          { title: "Готово", value: DONE, description: "Закрыть список", group: "Действия" },
          { title: "Очистить список", value: CLEAR, group: "Действия" },
          {
            title: "Вернуть бесплатные по умолчанию",
            value: RESET,
            description: DEFAULT_FREE_CHAIN.slice(0, 3).join(" → ") + " → …",
            group: "Действия",
          },
          ...models.map((model) => {
            const key = keyOf(model)
            const index = position.get(key)
            return {
              title: `${index ? `${index}. ` : "     "}${model.name}`,
              value: key,
              description: model.free ? key : `${key} · платная`,
              group: model.free ? "Бесплатные · работают в РФ" : "Другие · работают в РФ",
            }
          }),
        ]

        let picked: Pick | undefined
        try {
          picked = await ctx.dialogs.select<Pick>({
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
        if (chain.includes(picked)) await setChain(chain.filter((key) => key !== picked))
        else await setChain([...chain, picked])
      }
    }

    const menu = async (): Promise<void> => {
      await refresh(1)
      for (;;) {
        type Pick = MenuItem
        let picked: Pick | undefined
        try {
          picked = await ctx.dialogs.select<Pick>({
            title: state.ready ? `Авто-фолбэк: ${state.enabled ? "включён" : "выключен"}` : "Авто-фолбэк",
            placeholder: "Действие",
            options: [
              {
                title: state.enabled ? "Выключить" : "Включить",
                value: "toggle",
                description: state.enabled ? "Перестать менять модель" : "Менять модель, когда кончились токены",
                group: "Переключатель",
              },
              {
                title: `Модели для замены (${state.chain.length})`,
                value: "chain",
                description: state.chain.slice(0, 4).join(" → ") + (state.chain.length > 4 ? " → …" : ""),
                group: "Настройка",
              },
              {
                title: "Забыть, что модели кончились",
                value: "reset",
                description: "Снова пробовать все модели из списка",
                group: "Настройка",
              },
              {
                title: "Файл настроек",
                value: "path",
                description: state.configPath || "ещё не создан",
                group: "Прочее",
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
            apply(await rpc().resetCooldowns({}))
            ctx.toast.show({ title: "Готово", description: "Все модели снова в игре", variant: "success" })
          } catch (error) {
            toastError(error)
          }
          continue
        }
        if (picked === "path") {
          try {
            await ctx.dialogs.alert({
              title: "Файл настроек",
              description: state.configPath || "Файл ещё не создан — он появится после первого переключения.",
              ok: "Закрыть",
            })
          } catch {
            return
          }
          continue
        }
        return
      }
    }

    let stopChanged: (() => void) | undefined
    let stopSwitched: (() => void) | undefined

    try {
      stopChanged = rpc().events.on("changed", (event) => {
        apply((event as { data?: unknown }).data)
      })
      stopSwitched = rpc().events.on("switched", (event) => {
        const data = (event as { data?: unknown }).data as SwitchedEvent | undefined
        if (!data) return
        ctx.toast.show({
          title: `Кончились токены: ${data.from} → ${data.to}`,
          description: data.reason,
          duration: 6000,
        })
      })
    } catch {
      // Older server without these events: the commands still work through calls.
    }

    void refresh(4)

    ctx.add(
      Command,
      (): Command => ({
        id: "menu",
        title: "Авто-фолбэк: настройки",
        description: "Включить, выключить и выбрать модели для замены",
        keywords: "fallback фолбэк модели цепочка настройки",
        group: "Авто-фолбэк",
        slash: { name: "af" },
        run: () => void menu(),
      }),
    )

    ctx.add(
      Command,
      (): Command => ({
        id: "toggle",
        title: state.enabled ? "Авто-фолбэк: выключить" : "Авто-фолбэк: включить",
        description: state.enabled ? `Включён · ${state.chain.length} моделей в цепочке` : "Выключен",
        keywords: "fallback фолбэк toggle вкл выкл on off",
        group: "Авто-фолбэк",
        bind: "f3",
        slash: { name: "aft" },
        run: () => void toggle(),
      }),
    )

    return () => {
      stopChanged?.()
      stopSwitched?.()
    }
  },
})
