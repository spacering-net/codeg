import { act, renderHook } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { AgentOptionsSnapshot, AgentType } from "@/lib/types"
import { useAgentOptions } from "./use-agent-options"

const describeAgentOptions = vi.hoisted(() => vi.fn())

vi.mock("@/lib/api", () => ({ describeAgentOptions }))

function snapshotFor(agent: AgentType): AgentOptionsSnapshot {
  return {
    modes: {
      current_mode_id: "default",
      available_modes: [
        { id: "default", name: `${agent} mode`, description: null },
      ],
    },
    config_options: [],
    available_commands: [],
  }
}

/**
 * The probe is debounced, so an agent switch leaves the PREVIOUS agent's
 * snapshot on screen for the whole window. Anything that interprets the
 * snapshot's content — localising the agent's own hardcoded vocabulary, in
 * particular — must key on the agent that produced it, or a switch would
 * briefly paint one agent's options in another agent's wording.
 */
describe("useAgentOptions snapshot ownership", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    describeAgentOptions.mockReset()
    describeAgentOptions.mockImplementation((agent: AgentType) =>
      Promise.resolve(snapshotFor(agent))
    )
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("keeps naming the producing agent while a switch is still debouncing", async () => {
    // A folder path nobody else seeds, so the module-scope probe cache cannot
    // hand this test another test's snapshot.
    const folder = `/tmp/use-agent-options-${Math.random()}`
    const modeName = (state: { snapshot: AgentOptionsSnapshot | null }) =>
      state.snapshot?.modes?.available_modes[0]?.name
    const { result, rerender } = renderHook(
      ({ agent }: { agent: AgentType }) => useAgentOptions(agent, folder),
      { initialProps: { agent: "deepseek" as AgentType } }
    )

    await act(async () => {
      await vi.advanceTimersByTimeAsync(300)
    })
    expect(modeName(result.current)).toBe("deepseek mode")
    expect(result.current.snapshotAgentType).toBe("deepseek")

    // Switch agents but stay inside the debounce window: the snapshot is still
    // DeepSeek's, so what names it must still be DeepSeek.
    rerender({ agent: "codex" as AgentType })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100)
    })
    expect(modeName(result.current)).toBe("deepseek mode")
    expect(result.current.snapshotAgentType).toBe("deepseek")

    // Once the re-probe lands the two move together again.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300)
    })
    expect(modeName(result.current)).toBe("codex mode")
    expect(result.current.snapshotAgentType).toBe("codex")
  })
})

describe("useAgentOptions model-scoped probes", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    describeAgentOptions.mockReset()
    describeAgentOptions.mockImplementation((agent: AgentType) =>
      Promise.resolve(snapshotFor(agent))
    )
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("applies the selected model and re-probes when it changes", async () => {
    const folder = `/tmp/use-agent-options-model-${Math.random()}`
    const { rerender } = renderHook(
      ({ model }: { model: string }) =>
        useAgentOptions("deepseek" as AgentType, folder, true, { model }),
      { initialProps: { model: "opencode-go/deepseek-v4.1-flash" } }
    )

    await act(async () => {
      await vi.advanceTimersByTimeAsync(300)
    })
    expect(describeAgentOptions).toHaveBeenCalledTimes(1)
    expect(describeAgentOptions).toHaveBeenLastCalledWith("deepseek", folder, {
      model: "opencode-go/deepseek-v4.1-flash",
    })

    // A different model derives different option lists — the (agent, folder)
    // cache must not serve the previous model's snapshot.
    rerender({ model: "vercel/callstack/apex" })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300)
    })
    expect(describeAgentOptions).toHaveBeenCalledTimes(2)
    expect(describeAgentOptions).toHaveBeenLastCalledWith("deepseek", folder, {
      model: "vercel/callstack/apex",
    })
  })

  /** The task editor's config bar and its brief composer each run this hook
   *  for the same agent and folder. Only the model keys the probe, so both
   *  read one probe as long as they pass the same model — a host that left it
   *  out would spawn the agent a second time. */
  it("shares one probe between hosts passing the same model", async () => {
    const folder = `/tmp/use-agent-options-shared-${Math.random()}`
    const selections = { model: "opencode/step-5-preview-free", effort: "high" }
    // Held open, so the second host arrives while the first probe is still
    // running rather than after it filled the cache.
    let answer: (snapshot: AgentOptionsSnapshot) => void = () => {}
    describeAgentOptions.mockImplementation(
      () =>
        new Promise<AgentOptionsSnapshot>((resolve) => {
          answer = resolve
        })
    )
    const { result } = renderHook(() => [
      useAgentOptions("deepseek" as AgentType, folder, true, selections),
      useAgentOptions("deepseek" as AgentType, folder, true, selections),
    ])

    await act(async () => {
      await vi.advanceTimersByTimeAsync(300)
    })
    expect(describeAgentOptions).toHaveBeenCalledTimes(1)

    await act(async () => {
      answer(snapshotFor("deepseek"))
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(result.current[0].snapshot).not.toBeNull()
    expect(result.current[1].snapshot).toBe(result.current[0].snapshot)
  })
})
