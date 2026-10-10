import { act, fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type {
  AgentDelegationDefaults,
  AgentOptionsSnapshot,
  AgentType,
} from "@/lib/types"

const describeAgentOptions = vi.hoisted(() => vi.fn())

vi.mock("@/lib/api", () => ({ describeAgentOptions }))
vi.mock("@/hooks/use-acp-agents", () => ({
  useAcpAgents: () => ({ agents: [], fresh: true, refresh: () => {} }),
}))

import { DelegationAgentDefaultsPanel } from "./delegation-agent-defaults"
import enMessages from "@/i18n/messages/en.json"

type Defaults = Partial<Record<AgentType, AgentDelegationDefaults>>

/** A probe answer whose effort default is named after `tag`, so the
 *  "Agent default: …" hint on screen says which answer is showing. */
function answer(tag: string): AgentOptionsSnapshot {
  return {
    modes: null,
    config_options: [
      {
        id: "effort",
        name: "Effort",
        description: null,
        category: "thought_level",
        kind: {
          type: "select",
          current_value: `${tag}-effort`,
          options: [
            {
              value: `${tag}-effort`,
              name: `${tag} effort`,
              description: null,
            },
          ],
          groups: [],
        },
      },
    ],
    available_commands: [],
  }
}

function panel(value: Defaults) {
  return (
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <DelegationAgentDefaultsPanel value={value} onChange={() => {}} />
    </NextIntlClientProvider>
  )
}

/** Past the panel's 250ms debounce, settling the probe's promise chain. */
async function settle() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(300)
  })
}

// The panel's snapshot cache lives in module scope for 30s, so every test
// probes ids no other test uses.
const unique = () => Math.random().toString(36).slice(2)

describe("DelegationAgentDefaultsPanel probes", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    describeAgentOptions.mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  /** opencode lists `effort` per model: the options shown beside a saved model
   *  have to be that model's, so changing it re-probes with it applied. */
  it("probes with the saved model and re-probes when it changes", async () => {
    describeAgentOptions.mockImplementation(
      (_agent: AgentType, _dir: string | null, cfg: { model: string } | null) =>
        Promise.resolve(answer(cfg?.model ?? "no-model"))
    )
    const first = `model-a-${unique()}`
    const second = `model-b-${unique()}`
    const saved = (model: string): Defaults => ({
      claude_code: { config_values: { model } },
    })

    const { rerender } = render(panel(saved(first)))
    await settle()
    expect(describeAgentOptions).toHaveBeenLastCalledWith("claude_code", null, {
      model: first,
    })
    expect(
      screen.getByText(`Agent default: ${first} effort`)
    ).toBeInTheDocument()

    rerender(panel(saved(second)))
    await settle()
    expect(describeAgentOptions).toHaveBeenCalledTimes(2)
    expect(describeAgentOptions).toHaveBeenLastCalledWith("claude_code", null, {
      model: second,
    })
    expect(
      screen.getByText(`Agent default: ${second} effort`)
    ).toBeInTheDocument()

    // Back to a model probed moments ago: served from the cache, no new probe.
    rerender(panel(saved(first)))
    await settle()
    expect(describeAgentOptions).toHaveBeenCalledTimes(2)
    expect(
      screen.getByText(`Agent default: ${first} effort`)
    ).toBeInTheDocument()
  })

  /** A tab served from the cache must not be overwritten by the answer of a
   *  probe the user already left — that answer is another agent's options. */
  it("drops a probe answer that lands after a cache hit replaced it", async () => {
    const claudeModel = `claude-${unique()}`
    let answerCodex: (snapshot: AgentOptionsSnapshot) => void = () => {}
    describeAgentOptions.mockImplementation((agent: AgentType) =>
      agent === "codex"
        ? new Promise<AgentOptionsSnapshot>((resolve) => {
            answerCodex = resolve
          })
        : Promise.resolve(answer(claudeModel))
    )

    render(panel({ claude_code: { config_values: { model: claudeModel } } }))
    await settle()
    expect(
      screen.getByText(`Agent default: ${claudeModel} effort`)
    ).toBeInTheDocument()

    // Codex's probe is still running when the user goes back to Claude Code,
    // whose snapshot is cached.
    fireEvent.click(screen.getByRole("tab", { name: "Codex" }))
    await settle()
    expect(describeAgentOptions).toHaveBeenLastCalledWith("codex", null, null)
    fireEvent.click(screen.getByRole("tab", { name: "Claude Code" }))
    await settle()
    expect(
      screen.getByText(`Agent default: ${claudeModel} effort`)
    ).toBeInTheDocument()

    await act(async () => {
      answerCodex(answer("codex"))
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(
      screen.getByText(`Agent default: ${claudeModel} effort`)
    ).toBeInTheDocument()
    expect(screen.queryByText("Agent default: codex effort")).toBeNull()
  })
})
