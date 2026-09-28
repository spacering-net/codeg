import { type ReactElement } from "react"
import { fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { describe, expect, it } from "vitest"

import { AgentToolCallPart } from "./agent-tool-call"
import type { AdaptedContentPart } from "@/lib/adapters/ai-elements-adapter"
import enMessages from "@/i18n/messages/en.json"

type ToolCallPart = Extract<AdaptedContentPart, { type: "tool-call" }>

function renderCard(part: ToolCallPart) {
  const ui: ReactElement = (
    <AgentToolCallPart part={part} renderToolCall={() => null} />
  )
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      {ui}
    </NextIntlClientProvider>
  )
}

function basePart(
  input: string | null,
  state: ToolCallPart["state"]
): ToolCallPart {
  return {
    type: "tool-call",
    toolCallId: "call-agent",
    toolName: "agent",
    input,
    state,
  }
}

describe("AgentToolCallPart title", () => {
  it("renders the subagent_type prefix in front of the description", () => {
    renderCard(
      basePart(
        JSON.stringify({
          subagent_type: "Explore",
          description: "map the repo",
        }),
        "input-available"
      )
    )
    expect(screen.getByText("Explore: map the repo")).toBeInTheDocument()
    expect(screen.queryByText(/Sub-agent starting/)).not.toBeInTheDocument()
  })

  it("shows the description alone when subagent_type hasn't streamed in yet", () => {
    // Partial / out-of-order streamed input: the description is present but the
    // sub-agent type isn't. The placeholder must NOT be prepended to it.
    renderCard(
      basePart(
        '{"description":"map the repo"', // truncated, no subagent_type yet
        "input-streaming"
      )
    )
    expect(screen.getByText("map the repo")).toBeInTheDocument()
    expect(screen.queryByText(/Sub-agent starting/)).not.toBeInTheDocument()
  })

  it("falls back to the placeholder only when nothing has arrived", () => {
    renderCard(basePart(null, "input-available"))
    expect(screen.getByText("Sub-agent starting…")).toBeInTheDocument()
  })

  it("reads Codex's agent_type field as the prefix", () => {
    // Codex's live spawn_agent payload labels the agent with `agent_type`.
    renderCard(
      basePart(
        JSON.stringify({ agent_type: "codex", description: "do the thing" }),
        "input-available"
      )
    )
    expect(screen.getByText("codex: do the thing")).toBeInTheDocument()
  })

  it("ignores non-string subagent_type / description (no React-child crash)", () => {
    // Some hosts (e.g. CodeBuddy) can hand us a tool input where these fields
    // are objects, not strings. Rendering them directly would throw "Objects
    // are not valid as a React child"; they must be treated as absent.
    expect(() =>
      renderCard(
        basePart(
          JSON.stringify({ subagent_type: {}, description: {} }),
          "input-available"
        )
      )
    ).not.toThrow()
    expect(screen.getByText("Sub-agent starting…")).toBeInTheDocument()
  })

  it("keeps a string description when subagent_type is a non-string object", () => {
    renderCard(
      basePart(
        JSON.stringify({
          subagent_type: { nested: true },
          description: "build",
        }),
        "input-available"
      )
    )
    expect(screen.getByText("build")).toBeInTheDocument()
  })

  it("badges the codex agent_id (shortened to first UUID segment) when present", () => {
    renderCard(
      basePart(
        JSON.stringify({
          subagent_type: "worker",
          description: "build",
          agent_id: "abcd1234-uuid-9",
        }),
        "output-available"
      )
    )
    expect(screen.getByText("abcd1234")).toBeInTheDocument()
    expect(screen.queryByText("abcd1234-uuid-9")).not.toBeInTheDocument()
  })

  it("shows no agent_id badge for non-codex agents (e.g. Claude Task)", () => {
    renderCard(
      basePart(
        JSON.stringify({ subagent_type: "Explore", description: "map" }),
        "output-available"
      )
    )
    expect(screen.queryByText("abcd1234")).not.toBeInTheDocument()
  })

  it("renders a codex native sub-agent by name alone, with no prompt panel", () => {
    // codex 0.147's team-of-agents encrypts the hand-off message, so neither
    // the live signal (`classify_codex_subagent_activity`) nor the rollout can
    // supply a prompt or description — the capsule is name + thread badge.
    renderCard(
      basePart(
        JSON.stringify({
          subagent_type: "pnpm_build",
          prompt: "",
          description: "",
          agent_id: "01a0098a-7e8a-72d3-b7c0-2df130c84063",
          __codegCodexSubagentLaunch: true,
        }),
        "output-available"
      )
    )
    expect(screen.getByText("pnpm_build")).toBeInTheDocument()
    expect(screen.getByText("01a0098a")).toBeInTheDocument()
    // No empty "Prompt" disclosure, and above all no base64 anywhere.
    expect(screen.queryByText("Prompt")).not.toBeInTheDocument()
    // The settled card must not read as "the sub-agent finished": codex only
    // acknowledged the launch, and an async child may still be working. The
    // chip says so without expanding…
    expect(screen.getByText("Outcome unknown")).toBeInTheDocument()
    // …and the caveat behind it is spelled out in the body.
    fireEvent.click(screen.getByRole("button", { name: "Completed" }))
    expect(
      screen.getByText(/hasn't reported how this sub-agent ended/)
    ).toBeInTheDocument()
  })

  it("does not claim launch-only semantics for an ordinary sub-agent card", () => {
    // Claude's Task, the legacy codex collab spawn, … all settle when the
    // sub-agent really is done, and must not carry the caveat.
    renderCard({
      ...basePart(
        JSON.stringify({ subagent_type: "Explore", description: "map" }),
        "output-available"
      ),
      output: "Mapped 12 files.",
    })
    fireEvent.click(screen.getByRole("button", { name: "Completed" }))
    expect(screen.getByText("Mapped 12 files.")).toBeInTheDocument()
    expect(
      screen.queryByText(/hasn't reported how this sub-agent ended/)
    ).not.toBeInTheDocument()
  })

  it("holds the launch caveat back while the spawn is still in flight", () => {
    renderCard(
      basePart(
        JSON.stringify({
          subagent_type: "pnpm_build",
          __codegCodexSubagentLaunch: true,
        }),
        "input-available"
      )
    )
    expect(
      screen.queryByText(/hasn't reported how this sub-agent ended/)
    ).not.toBeInTheDocument()
    // No outcome chip either — the spawn hasn't even been acknowledged yet.
    expect(screen.queryByText("Outcome unknown")).not.toBeInTheDocument()
  })

  it("replaces the caveat with an outcome chip once codex reports one", () => {
    // `SubAgentActivity{kind}` reaches the card as this key — live via
    // `settle_codex_subagent_launch`, on reload via the rollout parser. Both
    // write it onto the same launch capsule, so the two must agree.
    for (const [state, expected] of [
      ["completed", "Finished"],
      ["interrupted", "Interrupted"],
    ] as const) {
      const { unmount } = renderCard(
        basePart(
          JSON.stringify({
            subagent_type: "pnpm_build",
            __codegCodexSubagentLaunch: true,
            __codegCodexSubagentState: state,
          }),
          "output-available"
        )
      )
      // Visible while COLLAPSED: the outcome is the one thing worth seeing
      // without a click, which is why it moved out of the body.
      expect(screen.getByText(expected)).toBeInTheDocument()
      expect(
        screen.queryByText(/hasn't reported how this sub-agent ended/)
      ).not.toBeInTheDocument()
      unmount()
    }
  })

  it("draws no body at all for a settled codex launch with no result", () => {
    // The live case: codex forwards the child's report over no wire, so the
    // capsule has an outcome and nothing else. It must degrade to a bare pill
    // rather than an empty bordered frame — hence no expand trigger.
    renderCard(
      basePart(
        JSON.stringify({
          subagent_type: "pnpm_build",
          agent_id: "01a08145-db62-78b3-9762-9cb2540216c2",
          __codegCodexSubagentLaunch: true,
          __codegCodexSubagentState: "completed",
        }),
        "output-available"
      )
    )
    expect(screen.getByLabelText("Completed")).toBeInTheDocument()
    expect(
      screen.queryByRole("button", { name: "Completed" })
    ).not.toBeInTheDocument()
    // …and the session entry is still reachable, because it is not in the body.
    expect(
      screen.getByRole("button", { name: /View sub-agent session/ })
    ).toBeInTheDocument()
  })

  it("offers the child's own session without expanding the capsule", () => {
    // A codex sub-agent runs as a full rollout of its own and forwards none of
    // it over ACP, so this entry point is the only way to see its work. The
    // badge and the session key are the same string (`agent_id`).
    renderCard({
      ...basePart(
        JSON.stringify({
          subagent_type: "history_limits",
          agent_id: "01a07fc2-db62-78b3-9762-9cb2540216c2",
          __codegCodexSubagentLaunch: true,
          __codegCodexSubagentState: "completed",
        }),
        "output-available"
      ),
      output: "Read 4 files.",
    })
    // The capsule has a body here (the child's report) and mounts collapsed —
    // the action is in the header, so it is reachable without opening it.
    expect(screen.queryByText("Read 4 files.")).not.toBeInTheDocument()
    expect(
      screen.getByRole("button", { name: /View sub-agent session/ })
    ).toBeInTheDocument()
  })

  it("offers no session for a sub-agent card that names no child", () => {
    // Claude's Task and the legacy codex collab spawn have no standalone child
    // session on disk — an entry point there would open nothing.
    renderCard({
      ...basePart(
        JSON.stringify({ subagent_type: "Explore", description: "map" }),
        "output-available"
      ),
      output: "Mapped 12 files.",
    })
    expect(
      screen.queryByRole("button", { name: /View sub-agent session/ })
    ).not.toBeInTheDocument()
  })
})

describe("AgentToolCallPart cursor task outcome envelope", () => {
  it("folds the success envelope into a duration suffix instead of a JSON body", () => {
    renderCard({
      ...basePart(
        JSON.stringify({ _toolName: "task", description: "run the build" }),
        "output-available"
      ),
      output: '{"durationMs":39894,"isBackground":false}',
    })
    expect(screen.getByText("39.9s")).toBeInTheDocument()
    // The folded duration has no body, so the capsule is a static "Completed"
    // chip (not an expandable button) and the raw envelope never renders.
    expect(screen.getByLabelText("Completed")).toBeInTheDocument()
    expect(screen.queryByText(/durationMs/)).not.toBeInTheDocument()
    expect(screen.queryByText(/isBackground/)).not.toBeInTheDocument()
  })

  it("renders the error envelope as an error box (wire status stays completed)", () => {
    renderCard({
      ...basePart(JSON.stringify({ _toolName: "task" }), "output-available"),
      output: '{"error":"Invalid arguments:\\nsubagent_type mismatch"}',
    })
    expect(screen.getByText(/Invalid arguments:/)).toBeInTheDocument()
    expect(screen.queryByText(/{"error"/)).not.toBeInTheDocument()
    // The capsule reports Error, not Completed.
    expect(screen.getByLabelText("Error")).toBeInTheDocument()
  })

  it("shows a background launch as still running instead of Completed", () => {
    renderCard({
      ...basePart(JSON.stringify({ _toolName: "task" }), "output-available"),
      output: '{"isBackground":true}',
    })
    // The completion envelope only acknowledges the launch: the pill carries
    // the running label…
    const trigger = screen.getByLabelText("Running in background")
    // …and the body shows the visible running indicator, not raw JSON.
    fireEvent.click(trigger)
    expect(screen.getByText("Running in background")).toBeInTheDocument()
    expect(screen.queryByText(/isBackground/)).not.toBeInTheDocument()
  })

  it("never folds outputs of non-cursor sub-agents (no _toolName stamp)", () => {
    // Another agent's sub-agent legitimately returning JSON error text: the
    // envelope must NOT repaint the card as failed — the text renders as-is.
    renderCard({
      ...basePart(
        JSON.stringify({ subagent_type: "Explore", description: "map" }),
        "output-available"
      ),
      output: '{"error":"not an envelope"}',
    })
    expect(screen.queryByLabelText("Error")).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Completed" }))
    expect(screen.getByText(/not an envelope/)).toBeInTheDocument()
  })

  it("keeps rendering genuine report text as the body", () => {
    renderCard({
      ...basePart(
        JSON.stringify({ subagent_type: "Explore", description: "map" }),
        "output-available"
      ),
      output: "All 3 checks passed.",
    })
    // Completed non-error capsules mount collapsed; expand to see the body.
    fireEvent.click(screen.getByRole("button", { name: "Completed" }))
    expect(screen.getByText("All 3 checks passed.")).toBeInTheDocument()
  })

  it("reads cursor's subagentType oneof case as the title prefix", () => {
    renderCard(
      basePart(
        JSON.stringify({
          _toolName: "task",
          description: "run the build",
          subagentType: { case: "generalPurpose", value: {} },
        }),
        "input-available"
      )
    )
    expect(
      screen.getByText("generalPurpose: run the build")
    ).toBeInTheDocument()
  })
})

describe("AgentToolCallPart live subagent transcript", () => {
  const withTranscript = (
    state: ToolCallPart["state"],
    entries: NonNullable<ToolCallPart["agentTranscript"]>
  ): ToolCallPart => ({
    ...basePart(
      JSON.stringify({ subagent_type: "Explore", description: "scan" }),
      state
    ),
    agentTranscript: entries,
  })

  /** The capsule body is collapsed by default while running (matching the
   *  existing child-tool-call UX) — expand it via the pill trigger. */
  const expandRunningCapsule = () =>
    fireEvent.click(screen.getByRole("button", { name: "Running" }))

  it("renders text and thinking entries while running", () => {
    renderCard(
      withTranscript("input-available", [
        { type: "thinking", text: "planning the sweep" },
        { type: "text", text: "found three matches" },
      ])
    )
    expandRunningCapsule()
    expect(screen.getByText("Live activity")).toBeInTheDocument()
    expect(screen.getByText("planning the sweep")).toBeInTheDocument()
    expect(screen.getByText("found three matches")).toBeInTheDocument()
  })

  it("skips empty thinking entries and renders nothing when settled", () => {
    renderCard(
      withTranscript("input-available", [{ type: "thinking", text: "   " }])
    )
    expandRunningCapsule()
    // Label shows (the list is non-empty) but the blank entry renders nothing.
    expect(screen.getByText("Live activity")).toBeInTheDocument()

    // A settled card never shows the transcript section — the store stops
    // attaching it, and even a stale prop must not render.
    const settled = withTranscript("output-available", [
      { type: "text", text: "stale transcript" },
    ])
    renderCard({ ...settled, output: "final result" })
    fireEvent.click(screen.getByRole("button", { name: "Completed" }))
    expect(screen.queryByText("stale transcript")).not.toBeInTheDocument()
    expect(screen.getByText("final result")).toBeInTheDocument()
  })

  it("bounds the rendered tail to the newest entries", () => {
    const entries = Array.from({ length: 25 }, (_, i) => ({
      type: "text" as const,
      text: `entry-${i}`,
    }))
    renderCard(withTranscript("input-available", entries))
    expandRunningCapsule()
    // 25 entries, tail bound 20 → the first five never mount.
    expect(screen.queryByText("entry-0")).not.toBeInTheDocument()
    expect(screen.queryByText("entry-4")).not.toBeInTheDocument()
    expect(screen.getByText("entry-5")).toBeInTheDocument()
    expect(screen.getByText("entry-24")).toBeInTheDocument()
  })
})

describe("AgentToolCallPart grok live progress", () => {
  const runningPart = (meta: Record<string, unknown> | null): ToolCallPart => ({
    ...basePart(
      JSON.stringify({ subagent_type: "explore", description: "map repo" }),
      "input-available"
    ),
    meta,
  })

  it("renders the subagent_progress ticker while running", () => {
    renderCard(
      runningPart({
        grokSubagentProgress: {
          durationMs: 4200,
          turnCount: 1,
          toolCallCount: 7,
          contextUsagePct: 12.4,
        },
      })
    )
    fireEvent.click(screen.getByRole("button", { name: "Running" }))
    expect(
      screen.getByText("7 tool calls · 1 turns · 4.2s · context 12%")
    ).toBeInTheDocument()
  })

  it("skips absent fields and non-numeric shapes", () => {
    renderCard(
      runningPart({
        grokSubagentProgress: { toolCallCount: 3, contextUsagePct: "nope" },
      })
    )
    fireEvent.click(screen.getByRole("button", { name: "Running" }))
    expect(screen.getByText("3 tool calls")).toBeInTheDocument()
  })

  it("hides the ticker once the card settles", () => {
    const part: ToolCallPart = {
      ...basePart(
        JSON.stringify({ subagent_type: "explore", description: "map repo" }),
        "output-available"
      ),
      output: "final result",
      meta: { grokSubagentProgress: { toolCallCount: 9 } },
    }
    renderCard(part)
    fireEvent.click(screen.getByRole("button", { name: "Completed" }))
    expect(screen.queryByText(/9 tool calls/)).not.toBeInTheDocument()
    expect(screen.getByText("final result")).toBeInTheDocument()
  })

  it("shows the ticker alongside a background launch ack", () => {
    // A background spawn: the call is settled (ack output), the child still
    // runs — the ticker keeps updating in-turn next to "running in background".
    const part: ToolCallPart = {
      ...basePart(
        JSON.stringify({ subagent_type: "explore", description: "map repo" }),
        "output-available"
      ),
      output: "Subagent started in background.\nsubagent_id: sub-1",
      meta: { grokSubagentProgress: { toolCallCount: 5 } },
    }
    renderCard(part)
    fireEvent.click(
      screen.getByRole("button", { name: /running in background/i })
    )
    expect(screen.getByText("5 tool calls")).toBeInTheDocument()
    // The raw ack text is never dumped as the result body.
    expect(
      screen.queryByText(/Subagent started in background/)
    ).not.toBeInTheDocument()
  })
})

describe("AgentToolCallPart child session action", () => {
  it("offers the child's session from the live spawn meta", () => {
    // Grok forwards none of the child's work over ACP, so the action has to be
    // there WHILE it runs — the meta stamp is what makes that possible.
    renderCard({
      ...basePart(
        JSON.stringify({ subagent_type: "explore", description: "map repo" }),
        "input-available"
      ),
      meta: {
        grokSubagentSession: {
          subagentId: "sub-1",
          childSessionId: "019fe6bf-0bcb-70c2-a02d-e5c006dfc32a",
        },
      },
    })
    fireEvent.click(screen.getByRole("button", { name: "Running" }))
    expect(
      screen.getByRole("button", { name: "View sub-agent session" })
    ).toBeInTheDocument()
  })

  it("offers it from the parsed stats on a settled historical card", () => {
    renderCard({
      ...basePart(
        JSON.stringify({ subagent_type: "explore", description: "map repo" }),
        "output-available"
      ),
      output: "final result",
      agentStats: {
        agent_type: "explore",
        status: "completed",
        child_session_id: "019fe6bf-0bcb-70c2-a02d-e5c006dfc32a",
      },
    })
    fireEvent.click(screen.getByRole("button", { name: "Completed" }))
    expect(
      screen.getByRole("button", { name: "View sub-agent session" })
    ).toBeInTheDocument()
  })

  it("stays hidden for a sub-agent with no session of its own", () => {
    // Every other agent folds its child into the parent transcript — there is
    // nothing to open.
    renderCard({
      ...basePart(
        JSON.stringify({ subagent_type: "Explore", description: "map repo" }),
        "output-available"
      ),
      output: "final result",
    })
    fireEvent.click(screen.getByRole("button", { name: "Completed" }))
    expect(
      screen.queryByRole("button", { name: "View sub-agent session" })
    ).not.toBeInTheDocument()
  })
})
