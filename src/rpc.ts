import { Rpc } from "@opencode/plugin/rpc"

/**
 * Contract between the server part (implements it) and the TUI part (calls it).
 * Inputs and outputs are JSON Schema, so every value is `unknown` in TypeScript.
 */

const StatusSchema = {
  type: "object",
  properties: {
    enabled: { type: "boolean" },
    chain: { type: "array", items: { type: "string" } },
    configPath: { type: "string" },
  },
  required: ["enabled", "chain", "configPath"],
  additionalProperties: false,
} as const

const EmptyInput = {
  type: "object",
  properties: {},
  additionalProperties: false,
} as const

export const FallbackRpc = {
  id: "auto-fallback",
  methods: {
    /** Current switch state and fallback chain, plus the settings file path. */
    status: {
      input: EmptyInput,
      output: StatusSchema,
    },
    /** Turn the automatic fallback on or off. */
    toggle: {
      input: {
        type: "object",
        properties: { enabled: { type: "boolean" } },
        required: ["enabled"],
        additionalProperties: false,
      },
      output: StatusSchema,
    },
    /** Replace the ordered fallback chain. */
    setChain: {
      input: {
        type: "object",
        properties: { chain: { type: "array", items: { type: "string" } } },
        required: ["chain"],
        additionalProperties: false,
      },
      output: StatusSchema,
    },
    /** Drop the in-memory "this model has no quota" memory, so every model is tried again. */
    resetCooldowns: {
      input: EmptyInput,
      output: StatusSchema,
    },
    /** Models OpenCode currently offers, free ones first. */
    models: {
      input: EmptyInput,
      output: {
        type: "object",
        properties: {
          models: {
            type: "array",
            items: {
              type: "object",
              properties: {
                providerID: { type: "string" },
                modelID: { type: "string" },
                name: { type: "string" },
                free: { type: "boolean" },
                rf: { type: "boolean" },
              },
              required: ["providerID", "modelID", "name", "free", "rf"],
              additionalProperties: false,
            },
          },
        },
        required: ["models"],
        additionalProperties: false,
      },
    },
  },
  events: {
    /** Settings changed (through RPC or because the file on disk was edited). */
    changed: { schema: StatusSchema },
    /** A session was moved to another model after its quota ran out. */
    switched: {
      schema: {
        type: "object",
        properties: {
          sessionID: { type: "string" },
          from: { type: "string" },
          to: { type: "string" },
          reason: { type: "string" },
        },
        required: ["sessionID", "from", "to", "reason"],
        additionalProperties: false,
      },
    },
  },
} satisfies Rpc.PortableDefinition

/** Shape of every `status`-returning method. */
export interface FallbackStatus {
  readonly enabled: boolean
  readonly chain: readonly string[]
  readonly configPath: string
}

export interface SwitchedEvent {
  readonly sessionID: string
  readonly from: string
  readonly to: string
  readonly reason: string
}

/** One entry of the `models` output: a model the user can pick from. */
export interface FallbackModel {
  readonly providerID: string
  readonly modelID: string
  readonly name: string
  readonly free: boolean
  /** `true` when the model's provider is reachable from Russia. */
  readonly rf: boolean
}

export interface FallbackModels {
  readonly models: readonly FallbackModel[]
}
