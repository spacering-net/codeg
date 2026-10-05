import { act, renderHook, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

import type { HermesModelOptions, SessionConfigOptionInfo } from "@/lib/types"

const api = vi.hoisted(() => ({
  acpHermesModelOptions: vi.fn(),
  acpSetHermesModel: vi.fn(),
}))

vi.mock("@/lib/api", () => api)

// The agent-settings-changed event the hook listens on, driven by hand.
const platform = vi.hoisted(() => {
  const handlers = new Set<() => void>()
  return {
    emitAgentsUpdated: () => {
      for (const h of [...handlers]) h()
    },
    // Deliberately NOT reset between tests: the hook subscribes once per module
    // for the whole app session, so clearing the handlers here would silently
    // disconnect every test after the first one that mounts it.
    subscribe: vi.fn(async (_event: string, handler: () => void) => {
      handlers.add(handler)
      return () => handlers.delete(handler)
    }),
  }
})

vi.mock("@/lib/platform", () => ({ subscribe: platform.subscribe }))

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  },
}))

import {
  HERMES_MODEL_CONFIG_ID,
  useHermesModelOption,
} from "@/hooks/use-hermes-model-option"

function options(over: Partial<HermesModelOptions> = {}): HermesModelOptions {
  return { current_model: "gpt-4o", models: ["gpt-4o"], error: null, ...over }
}

// A fresh agent id per test: the hook caches per agent for the app session, so
// reusing one would leak the previous test's catalogue into the next.
let seq = 0
const nextAgent = () => `custom:hermes-${seq++}`

function render(
  over: Partial<Parameters<typeof useHermesModelOption>[0]> = {}
) {
  const reapplyConfig = vi.fn().mockResolvedValue(true)
  const props = {
    agentType: nextAgent(),
    configOptions: [] as SessionConfigOptionInfo[],
    status: "connected" as const,
    reapplyConfig,
    canReconnect: true,
    ...over,
  }
  const view = renderHook((p: typeof props) => useHermesModelOption(p), {
    initialProps: props,
  })
  return { ...view, props, reapplyConfig }
}

beforeEach(() => {
  vi.clearAllMocks()
  api.acpHermesModelOptions.mockResolvedValue(options())
  api.acpSetHermesModel.mockResolvedValue(0)
})

describe("Hermes model picker", () => {
  // WHY: the composer asks every agent for this. For a non-Hermes agent the
  // backend answers `null`, and offering a picker anyway would write a
  // `model.default` into a config that agent never reads.
  it("contributes nothing when the agent is not Hermes", async () => {
    api.acpHermesModelOptions.mockResolvedValue(null)
    const { result } = render()
    await waitFor(() => expect(api.acpHermesModelOptions).toHaveBeenCalled())
    expect(result.current.option).toBeNull()
  })

  // WHY: an agent that advertises its own model selector over ACP owns it.
  // Appending a second one would give the composer two model dropdowns, and the
  // synthetic one would write to a file the agent may not even read.
  it("stays out of the way when the agent advertises its own model option", () => {
    const { result } = render({
      configOptions: [
        {
          id: "model",
          name: "Model",
          kind: { type: "select", current_value: "x", options: [], groups: [] },
        },
      ],
    })
    expect(result.current.option).toBeNull()
    expect(api.acpHermesModelOptions).not.toHaveBeenCalled()
  })

  // WHY: the trigger label resolves against the option's own value list. A
  // current model missing from the provider's catalogue (a stale id, or a
  // catalogue codeg could not fetch) would otherwise render a blank trigger —
  // the composer would stop saying which model it is on.
  it("always offers the current model, even when the catalogue omits it", async () => {
    api.acpHermesModelOptions.mockResolvedValue(
      options({ current_model: "retired-model", models: ["a", "b"] })
    )
    const { result } = render()
    await waitFor(() => expect(result.current.option).not.toBeNull())
    const kind = result.current.option!.kind
    expect(kind.type).toBe("select")
    if (kind.type !== "select") throw new Error("expected a select option")
    expect(kind.current_value).toBe("retired-model")
    expect(kind.options.map((o) => o.value)).toEqual([
      "retired-model",
      "a",
      "b",
    ])
  })

  // WHY: this is codeg's option, not the agent's. The id must be recognisable
  // as such so the composer routes it to the Hermes writer — handing it to the
  // ACP `session/set_config_option` would give Hermes an id it never published.
  it("marks the option as codeg's own", async () => {
    expect(HERMES_MODEL_CONFIG_ID.startsWith("codeg:")).toBe(true)
    const { result } = render()
    await waitFor(() => expect(result.current.option).not.toBeNull())
    expect(result.current.option!.id).toBe(HERMES_MODEL_CONFIG_ID)
  })

  it("writes the model and reconnects so the agent re-reads its config", async () => {
    const { result, props, reapplyConfig } = render()
    await waitFor(() => expect(result.current.option).not.toBeNull())

    await act(async () => {
      result.current.selectModel("new-model")
    })
    await waitFor(() => expect(reapplyConfig).toHaveBeenCalledTimes(1))
    expect(api.acpSetHermesModel).toHaveBeenCalledWith({
      agentType: props.agentType,
      model: "new-model",
    })
  })

  // WHY the user asked for this: Hermes only reads config.yaml at startup, so
  // applying a model means restarting the process. Doing that mid-turn would
  // throw away the answer being streamed, so the reconnect waits for the turn.
  it("defers the reconnect until the running turn finishes", async () => {
    const { result, rerender, props, reapplyConfig } = render({
      status: "prompting",
    })
    await waitFor(() => expect(result.current.option).not.toBeNull())

    await act(async () => {
      result.current.selectModel("new-model")
    })
    await waitFor(() => expect(api.acpSetHermesModel).toHaveBeenCalled())
    expect(reapplyConfig).not.toHaveBeenCalled()

    rerender({ ...props, status: "connected" })
    await waitFor(() => expect(reapplyConfig).toHaveBeenCalledTimes(1))
  })

  // WHY: the write is async. If the turn finishes while it is in flight, a
  // status captured when the pick was made is already wrong — parking the
  // reconnect on it would wait for a transition that already happened, leaving
  // the new model unapplied until the user happened to run another turn.
  it("still applies when the turn ends while the write is in flight", async () => {
    let resolveWrite: (() => void) | undefined
    api.acpSetHermesModel.mockReturnValue(
      new Promise<number>((resolve) => {
        resolveWrite = () => resolve(0)
      })
    )
    const { result, rerender, props, reapplyConfig } = render({
      status: "prompting",
    })
    await waitFor(() => expect(result.current.option).not.toBeNull())

    act(() => {
      result.current.selectModel("new-model")
    })
    // The turn finishes BEFORE the write resolves.
    rerender({ ...props, status: "connected" })
    await act(async () => {
      resolveWrite?.()
    })

    await waitFor(() => expect(reapplyConfig).toHaveBeenCalledTimes(1))
  })

  /**
   * WHY: the catalogue belongs to ONE provider — whichever the profile's
   * `model.provider` names. Settings live in a separate window, so switching
   * the provider there reaches the composer only through this event. Without
   * the invalidation the picker keeps serving the PREVIOUS provider's models:
   * the list looks perfectly healthy, and the user only finds out it was wrong
   * when the agent rejects the model at send time.
   */
  it("re-lists after the provider changes in settings", async () => {
    api.acpHermesModelOptions.mockResolvedValue(
      options({ current_model: "gpt-4o", models: ["gpt-4o", "gpt-4o-mini"] })
    )
    const { result } = render()
    await waitFor(() => expect(result.current.option).not.toBeNull())

    api.acpHermesModelOptions.mockResolvedValue(
      options({
        current_model: "claude-opus-4",
        models: ["claude-opus-4", "claude-sonnet-4"],
      })
    )
    await act(async () => {
      platform.emitAgentsUpdated()
    })

    await waitFor(() => {
      const kind = result.current.option!.kind
      if (kind.type !== "select") throw new Error("expected a select option")
      expect(kind.options.map((o) => o.value)).toEqual([
        "claude-opus-4",
        "claude-sonnet-4",
      ])
    })
    expect(api.acpHermesModelOptions).toHaveBeenCalledTimes(2)
  })

  // WHY: a viewer or delegation child does not own the agent process, so
  // reconnecting is not theirs to do — the same rule the stale-config banner
  // follows. Killing an owner's process from a viewer's picker would take the
  // owner's session down with it.
  it("never reconnects a session this client does not own", async () => {
    const { result, reapplyConfig } = render({ canReconnect: false })
    await waitFor(() => expect(result.current.option).not.toBeNull())

    await act(async () => {
      result.current.selectModel("new-model")
    })
    await waitFor(() => expect(api.acpSetHermesModel).toHaveBeenCalled())
    expect(reapplyConfig).not.toHaveBeenCalled()
  })

  // WHY: the optimistic pick is what makes the dropdown feel responsive, but if
  // the write failed the composer would then name a model the agent is not on.
  it("puts the real model back when the write fails", async () => {
    api.acpSetHermesModel.mockRejectedValue(new Error("disk full"))
    const { result } = render()
    await waitFor(() => expect(result.current.option).not.toBeNull())

    await act(async () => {
      result.current.selectModel("new-model")
    })
    await waitFor(() => {
      const kind = result.current.option!.kind
      if (kind.type !== "select") throw new Error("expected a select option")
      expect(kind.current_value).toBe("gpt-4o")
    })
  })
})
