import { type ReactElement } from "react"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { describe, expect, it } from "vitest"

import { AgentToolCallPart } from "./agent-tool-call"
import type { AdaptedContentPart } from "@/lib/adapters/ai-elements-adapter"
import { BACKGROUND_TASK_MARKER } from "@/lib/background-agent"
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

describe("AgentToolCallPart model and effort", () => {
  // Claude Code 2.1.292's Agent tool takes an `effort` for the sub-agent.
  it("shows the requested effort beside the model", () => {
    renderCard(
      basePart(
        JSON.stringify({
          subagent_type: "general-purpose",
          description: "probe sub",
          model: "sonnet",
          effort: "high",
        }),
        "output-available"
      )
    )
    fireEvent.click(screen.getByRole("button", { name: "Completed" }))
    expect(screen.getByText("sonnet").parentElement?.textContent).toBe(
      "Model: sonnet"
    )
    expect(screen.getByText("high").parentElement?.textContent).toBe(
      "Effort: high"
    )
  })

  it("shows the effort on its own when no model was named", () => {
    renderCard(
      basePart(
        JSON.stringify({
          subagent_type: "general-purpose",
          description: "probe sub",
          effort: "max",
        }),
        "output-available"
      )
    )
    fireEvent.click(screen.getByRole("button", { name: "Completed" }))
    expect(screen.getByText("max").parentElement?.textContent).toBe(
      "Effort: max"
    )
    expect(screen.queryByText(/Model:/)).not.toBeInTheDocument()
  })

  it("ignores an effort that is not a string", () => {
    renderCard(
      basePart(
        JSON.stringify({
          subagent_type: "general-purpose",
          description: "probe sub",
          prompt: "say ok",
          effort: { level: "high" },
        }),
        "output-available"
      )
    )
    fireEvent.click(screen.getByRole("button", { name: "Completed" }))
    expect(screen.getByText("Prompt")).toBeInTheDocument()
    expect(screen.queryByText(/Effort:/)).not.toBeInTheDocument()
  })

  // The Agent tool's schema: a `model` or `effort` argument is ignored for
  // `subagent_type: "fork"`, which runs on the parent's model and effort.
  it("shows neither the model nor the effort of a fork, which ignores both", () => {
    renderCard(
      basePart(
        JSON.stringify({
          subagent_type: "fork",
          description: "probe fork",
          prompt: "do it",
          model: "haiku",
          effort: "high",
        }),
        "output-available"
      )
    )
    fireEvent.click(screen.getByRole("button", { name: "Completed" }))
    expect(screen.getByText("fork: probe fork")).toBeInTheDocument()
    expect(screen.getByText("Prompt")).toBeInTheDocument()
    expect(screen.queryByText(/Model:/)).not.toBeInTheDocument()
    expect(screen.queryByText(/Effort:/)).not.toBeInTheDocument()
  })

  it("keeps the model and effort of another agent's role named fork", () => {
    renderCard(
      basePart(
        JSON.stringify({
          agent_type: "fork",
          description: "probe role",
          model: "gpt-5.5",
          effort: "high",
        }),
        "output-available"
      )
    )
    fireEvent.click(screen.getByRole("button", { name: "Completed" }))
    expect(screen.getByText("gpt-5.5").parentElement?.textContent).toBe(
      "Model: gpt-5.5"
    )
    expect(screen.getByText("high").parentElement?.textContent).toBe(
      "Effort: high"
    )
  })
})

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

  it("folds thinking entries like the main thread and expands on demand", () => {
    renderCard(
      withTranscript("input-available", [
        { type: "thinking", text: "planning the sweep" },
        { type: "text", text: "found three matches" },
      ])
    )
    expandRunningCapsule()
    expect(screen.getByText("Live activity")).toBeInTheDocument()
    // Folded by default — same contract as the main thread's <Reasoning>.
    expect(screen.queryByText("planning the sweep")).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Thought" }))
    expect(screen.getByText("planning the sweep")).toBeInTheDocument()
    expect(screen.getByText("found three matches")).toBeInTheDocument()
  })

  it("renders child tool-call markers in their chronological position", () => {
    const part: ToolCallPart = {
      ...withTranscript("input-available", [
        { type: "text", text: "before the read" },
        { type: "tool_call", childIndex: 0 },
        { type: "text", text: "after the read" },
      ]),
      agentStats: { tool_calls: [{ tool_name: "Read", is_error: false }] },
    }
    render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <AgentToolCallPart
          part={part}
          renderToolCall={(tc, key) => (
            <span key={key} data-testid="child-tool-call">
              {tc.toolName}
            </span>
          )}
        />
      </NextIntlClientProvider>
    )
    expandRunningCapsule()
    // The lone child call folds into the same one-item pill the main thread
    // uses; open it to reach the card inside.
    fireEvent.click(screen.getByRole("button", { name: "Read files 1 time" }))
    const before = screen.getByText("before the read")
    const child = screen.getByTestId("child-tool-call")
    const after = screen.getByText("after the read")
    // The child's card sits BETWEEN the prose that arrived on either side —
    // not hoisted into a "tool calls first" block of its own.
    expect(
      before.compareDocumentPosition(child) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
    expect(
      child.compareDocumentPosition(after) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
    expect(child.textContent).toBe("Read")
  })

  it("renders blank thinking entries as nothing and collapses the timeline after settle", () => {
    renderCard(
      withTranscript("input-available", [{ type: "thinking", text: "   " }])
    )
    expandRunningCapsule()
    // Blank prose is nothing to show: no live heading over an empty list.
    expect(screen.queryByText("Live activity")).not.toBeInTheDocument()

    // A settled card keeps the timeline data but folds it into one pill,
    // CLOSED by default — the conclusion leads, the process is one click
    // away (history swaps the live transcript for agent_stats.timeline).
    const settled = withTranscript("output-available", [
      { type: "text", text: "settled transcript" },
    ])
    renderCard({ ...settled, output: "final result" })
    fireEvent.click(screen.getByRole("button", { name: "Completed" }))
    // Collapsed by default: the pill shows the step count (singular for one
    // step), the content does not mount.
    const trigger = screen.getByRole("button", {
      name: "Sub-agent activity · 1 step",
    })
    expect(screen.queryByText("settled transcript")).not.toBeInTheDocument()
    expect(screen.getByText("final result")).toBeInTheDocument()
    fireEvent.click(trigger)
    expect(screen.getByText("settled transcript")).toBeInTheDocument()
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

  it("labels the child's newest thought as streaming while the card runs", () => {
    const live = (entries: NonNullable<ToolCallPart["agentTranscript"]>) => (
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <AgentToolCallPart
          part={withTranscript("input-available", entries)}
          renderToolCall={() => null}
        />
      </NextIntlClientProvider>
    )
    const thinking = [
      { type: "text" as const, text: "looking around" },
      { type: "thinking" as const, text: "pondering" },
    ]
    const { rerender } = render(live(thinking))
    expandRunningCapsule()
    // The tail entry is the thought being written right now — the main
    // thread's "Thinking…" contract, not a finished "Thought".
    expect(
      screen.getByRole("button", { name: "Thinking…" })
    ).toBeInTheDocument()

    // Anything after it means the child moved on: the thought is finished.
    rerender(live([...thinking, { type: "text", text: "found it" }]))
    expect(
      screen.queryByRole("button", { name: "Thinking…" })
    ).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Thought" })).toBeInTheDocument()
  })

  it("keeps an opened thought open while the live tail slides past the bound", async () => {
    // 20 entries — exactly the bound, nothing dropped yet: 18 texts, a
    // (finished) thought, one more text.
    const entries: NonNullable<ToolCallPart["agentTranscript"]> = [
      ...Array.from({ length: 18 }, (_, i) => ({
        type: "text" as const,
        text: `entry-${i}`,
      })),
      { type: "thinking", text: "deep thought" },
      { type: "text", text: "entry-18" },
    ]
    const renderLive = (list: typeof entries) => (
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <AgentToolCallPart
          part={withTranscript("input-available", list)}
          renderToolCall={() => null}
        />
      </NextIntlClientProvider>
    )
    const { rerender } = render(renderLive(entries))
    expandRunningCapsule()
    fireEvent.click(screen.getByRole("button", { name: "Thought" }))
    expect(screen.getByText("deep thought")).toBeInTheDocument()

    // One more entry pushes the oldest out of the tail. Every entry keeps its
    // identity — its place in the whole transcript, not in the visible slice:
    // the thought the reader opened stays open, and no rendered paragraph is
    // handed another entry's text (Streamdown memoizes its elements on source
    // position alone, so a reused instance given same-length text keeps
    // painting the old words).
    rerender(renderLive([...entries, { type: "text", text: "entry-19" }]))
    await waitFor(() =>
      expect(
        screen.getAllByText(/^entry-\d+$/).map((el) => el.textContent)
      ).toEqual(Array.from({ length: 19 }, (_, i) => `entry-${i + 1}`))
    )
    expect(screen.getByText("deep thought")).toBeInTheDocument()
  })
})

describe("AgentToolCallPart settled timeline and tool grouping", () => {
  const twoCalls = {
    agentStats: {
      tool_calls: [
        { tool_name: "Read", is_error: false },
        { tool_name: "Read", is_error: false },
      ],
    },
  }

  /** The capsule body is collapsed by default while running — expand it via
   *  the pill trigger (same helper as the live-transcript describe above). */
  const expandRunningCapsule = () =>
    fireEvent.click(screen.getByRole("button", { name: "Running" }))

  /** Child cards stamped with their own id so order can be asserted. */
  const renderWithChildren = (part: ToolCallPart) =>
    render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <AgentToolCallPart
          part={part}
          renderToolCall={(tc, key) => (
            <span key={key} data-testid={tc.toolCallId ?? key}>
              {tc.toolName}
            </span>
          )}
        />
      </NextIntlClientProvider>
    )

  it("keeps the full interleaved order on a settled card and folds the tool run into one pill", () => {
    const part: ToolCallPart = {
      ...basePart(
        JSON.stringify({ subagent_type: "Explore", description: "scan" }),
        "output-available"
      ),
      ...twoCalls,
      agentTranscript: [
        { type: "thinking", text: "planning the sweep" },
        { type: "tool_call", childIndex: 0 },
        { type: "tool_call", childIndex: 1 },
        { type: "text", text: "both files read" },
      ],
    }
    renderWithChildren(part)
    fireEvent.click(screen.getByRole("button", { name: "Completed" }))

    // Settled: the whole timeline folds into one pill carrying the step
    // count, closed by default — the live heading never appears.
    const timeline = screen.getByRole("button", {
      name: "Sub-agent activity · 4 steps",
    })
    expect(screen.queryByText("Live activity")).not.toBeInTheDocument()
    expect(screen.queryByText("planning the sweep")).not.toBeInTheDocument()
    expect(screen.queryByText("both files read")).not.toBeInTheDocument()
    expect(
      screen.queryByRole("button", { name: "Read files 2 times" })
    ).not.toBeInTheDocument()

    fireEvent.click(timeline)

    // The interleaved order survives: thinking → tools → text.
    fireEvent.click(screen.getByRole("button", { name: "Thought" }))
    const thought = screen.getByText("planning the sweep")
    const pill = screen.getByRole("button", { name: "Read files 2 times" })
    const text = screen.getByText("both files read")
    expect(
      timeline.compareDocumentPosition(thought) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
    expect(
      thought.compareDocumentPosition(pill) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
    expect(
      pill.compareDocumentPosition(text) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()

    // Both child cards live inside the one tool pill, in transcript order.
    fireEvent.click(pill)
    const first = screen.getByTestId("call-agent-sub-0")
    const second = screen.getByTestId("call-agent-sub-1")
    expect(
      first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
  })

  it("leads the settled pill with the duration when the stats carry one", () => {
    // formatDuration(138_000) = "2.3m" — the summary prefers the child's
    // total duration (transcript-derived or task-reported) over the entry
    // count, which is only a fallback for agents that supply neither.
    const part: ToolCallPart = {
      ...basePart(
        JSON.stringify({ subagent_type: "Explore", description: "scan" }),
        "output-available"
      ),
      agentStats: {
        tool_calls: twoCalls.agentStats.tool_calls,
        total_duration_ms: 138_000,
      },
      agentTranscript: [
        { type: "tool_call", childIndex: 0 },
        { type: "tool_call", childIndex: 1 },
        { type: "text", text: "both read" },
      ],
    }
    renderWithChildren(part)
    fireEvent.click(screen.getByRole("button", { name: "Completed" }))

    const trigger = screen.getByRole("button", {
      name: "Sub-agent activity · 2.3m",
    })
    // The duration replaces the entry count; no step count shows alongside.
    expect(
      screen.queryByText(/^Sub-agent activity · \d+ steps?$/)
    ).not.toBeInTheDocument()

    fireEvent.click(trigger)
    // The two consecutive calls are one tool pill inside the timeline.
    fireEvent.click(screen.getByRole("button", { name: "Read files 2 times" }))
    expect(screen.getByTestId("call-agent-sub-0")).toBeInTheDocument()
    expect(screen.getByTestId("call-agent-sub-1")).toBeInTheDocument()
  })

  it("folds stats-only cards (no timeline) into one pill and shows no timeline", () => {
    const part: ToolCallPart = {
      ...basePart(
        JSON.stringify({ subagent_type: "Explore", description: "scan" }),
        "output-available"
      ),
      ...twoCalls,
      output: "final result",
    }
    renderWithChildren(part)
    fireEvent.click(screen.getByRole("button", { name: "Completed" }))

    expect(screen.queryByText(/Sub-agent activity/)).not.toBeInTheDocument()
    // Every child call — exactly two — sits inside the single pill group.
    fireEvent.click(screen.getByRole("button", { name: "Read files 2 times" }))
    expect(screen.getByTestId("call-agent-sub-0")).toBeInTheDocument()
    expect(screen.getByTestId("call-agent-sub-1")).toBeInTheDocument()
    expect(screen.getByText("final result")).toBeInTheDocument()
  })

  it("renders a transcript of tool markers alone exactly like a stats-only card", () => {
    // CodeBuddy's child prose never reaches the client, and position-matched
    // children carry none either: their transcript is tool markers alone
    // (blank prose renders nothing, so it counts as none). With no prose
    // there is no order to preserve, so neither the settled activity pill
    // nor the live heading wraps the one tool pill.
    const markersOnly: NonNullable<ToolCallPart["agentTranscript"]> = [
      { type: "tool_call", childIndex: 0 },
      { type: "thinking", text: "  \n" },
      { type: "tool_call", childIndex: 1 },
    ]
    const settled = renderWithChildren({
      ...basePart(
        JSON.stringify({ subagent_type: "Explore", description: "scan" }),
        "output-available"
      ),
      ...twoCalls,
      agentTranscript: markersOnly,
      output: "final result",
    })
    fireEvent.click(screen.getByRole("button", { name: "Completed" }))
    expect(screen.queryByText(/Sub-agent activity/)).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Read files 2 times" }))
    expect(screen.getByTestId("call-agent-sub-0")).toBeInTheDocument()
    expect(screen.getByTestId("call-agent-sub-1")).toBeInTheDocument()
    settled.unmount()

    renderWithChildren({
      ...basePart(
        JSON.stringify({ subagent_type: "Explore", description: "scan" }),
        "input-available"
      ),
      ...twoCalls,
      agentTranscript: markersOnly,
    })
    expandRunningCapsule()
    expect(screen.queryByText("Live activity")).not.toBeInTheDocument()
    expect(
      screen.getByRole("button", { name: "Read files 2 times" })
    ).toBeInTheDocument()
  })

  it("keeps every child call reachable while the live prose tail slides", () => {
    // Two early calls, then enough prose to push the early entries past the
    // live bound. Old prose may age out of the running card; the child's
    // calls may not — before the timeline existed every call stayed listed,
    // and the pill's tally must count all of them.
    const part: ToolCallPart = {
      ...basePart(
        JSON.stringify({ subagent_type: "Explore", description: "scan" }),
        "input-available"
      ),
      ...twoCalls,
      agentTranscript: [
        { type: "tool_call", childIndex: 0 },
        { type: "text", text: "between-calls" },
        { type: "tool_call", childIndex: 1 },
        ...Array.from({ length: 21 }, (_, i) => ({
          type: "text" as const,
          text: `later-${i}`,
        })),
      ],
    }
    renderWithChildren(part)
    expandRunningCapsule()

    // 22 prose entries, bound 20: the two oldest prose entries go…
    expect(screen.queryByText("between-calls")).not.toBeInTheDocument()
    expect(screen.queryByText("later-0")).not.toBeInTheDocument()
    expect(screen.getByText("later-1")).toBeInTheDocument()
    // …and the two calls they separated now sit in one pill, both counted.
    fireEvent.click(screen.getByRole("button", { name: "Read files 2 times" }))
    expect(screen.getByTestId("call-agent-sub-0")).toBeInTheDocument()
    expect(screen.getByTestId("call-agent-sub-1")).toBeInTheDocument()
  })

  it("keeps the live tail bound and the live label while running", () => {
    const entries = [
      ...Array.from({ length: 22 }, (_, i) => ({
        type: "text" as const,
        text: `entry-${i}`,
      })),
      { type: "tool_call" as const, childIndex: 0 },
    ]
    const part: ToolCallPart = {
      ...basePart(
        JSON.stringify({ subagent_type: "Explore", description: "scan" }),
        "input-available"
      ),
      ...twoCalls,
      agentTranscript: entries,
    }
    renderWithChildren(part)
    expandRunningCapsule()

    expect(screen.getByText("Live activity")).toBeInTheDocument()
    expect(screen.queryByText(/Sub-agent activity/)).not.toBeInTheDocument()
    // Tail bound 20 over 22 prose entries → prose 0-1 never mounts; the tool
    // marker is not prose, does not count against the bound, and mounts
    // inside its pill.
    expect(screen.queryByText("entry-1")).not.toBeInTheDocument()
    expect(screen.getByText("entry-2")).toBeInTheDocument()
    expect(
      screen.getByRole("button", { name: "Read files 1 time" })
    ).toBeInTheDocument()
  })

  it("splits the tool run into separate pills when text breaks it", () => {
    const part: ToolCallPart = {
      ...basePart(
        JSON.stringify({ subagent_type: "Explore", description: "scan" }),
        "output-available"
      ),
      ...twoCalls,
      agentTranscript: [
        { type: "tool_call", childIndex: 0 },
        { type: "text", text: "halfway report" },
        { type: "tool_call", childIndex: 1 },
      ],
    }
    renderWithChildren(part)
    fireEvent.click(screen.getByRole("button", { name: "Completed" }))

    // The collapsed timeline holds everything; open it first.
    const timeline = screen.getByRole("button", {
      name: "Sub-agent activity · 3 steps",
    })
    expect(screen.queryByText("halfway report")).not.toBeInTheDocument()
    fireEvent.click(timeline)

    // Two one-call pills, the prose between them.
    const pills = screen.getAllByRole("button", { name: "Read files 1 time" })
    expect(pills).toHaveLength(2)
    expect(screen.getByText("halfway report")).toBeInTheDocument()
    fireEvent.click(pills[0])
    fireEvent.click(pills[1])
    const first = screen.getByTestId("call-agent-sub-0")
    const prose = screen.getByText("halfway report")
    const second = screen.getByTestId("call-agent-sub-1")
    expect(
      first.compareDocumentPosition(prose) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
    expect(
      prose.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
  })

  it("toggles the settled timeline pill closed again", () => {
    const part: ToolCallPart = {
      ...basePart(
        JSON.stringify({ subagent_type: "Explore", description: "scan" }),
        "output-available"
      ),
      agentTranscript: [
        { type: "text", text: "first half" },
        { type: "text", text: "second half" },
      ],
    }
    renderWithChildren(part)
    fireEvent.click(screen.getByRole("button", { name: "Completed" }))

    const trigger = screen.getByRole("button", {
      name: "Sub-agent activity · 2 steps",
    })
    expect(screen.queryByText("first half")).not.toBeInTheDocument()
    fireEvent.click(trigger)
    expect(screen.getByText("first half")).toBeInTheDocument()
    expect(screen.getByText("second half")).toBeInTheDocument()
    fireEvent.click(trigger)
    expect(screen.queryByText("first half")).not.toBeInTheDocument()
    expect(screen.queryByText("second half")).not.toBeInTheDocument()
  })
})

describe("AgentToolCallPart error text", () => {
  // claude-agent-acp fences a failed tool's result for markdown clients; the
  // card shows it as preformatted text, as the transcript records it.
  it("shows a fenced error without its fence", () => {
    renderCard({
      ...basePart(
        JSON.stringify({ subagent_type: "Explore", description: "scan" }),
        "output-error"
      ),
      errorText:
        "```\nThe user doesn't want to proceed with this tool use.\n```",
    })
    expect(
      screen.getByText("The user doesn't want to proceed with this tool use.")
        .textContent
    ).toBe("The user doesn't want to proceed with this tool use.")
  })
})

describe("AgentToolCallPart orphaned result recovery", () => {
  const erroredPart = {
    ...basePart(
      JSON.stringify({ subagent_type: "Explore", description: "scan" }),
      "output-error"
    ),
    errorText: "Error: tool execution produced no result",
  }

  it("renders the recovered report with its note on an errored card", () => {
    // A turn aborted before the async child's result was delivered: the card
    // is an error, the child's report survives only in agent_stats.
    renderCard({
      ...erroredPart,
      agentStats: {
        tool_calls: [{ tool_name: "Read", is_error: false }],
        status: "completed",
        recovered_result: "The full research report.",
      },
    })
    // Errored capsules open by default — the recovery needs no click.
    expect(screen.getByText(/actually finished/)).toBeInTheDocument()
    expect(screen.getByText("The full research report.")).toBeInTheDocument()
    // The original error text stays visible above the recovery.
    expect(
      screen.getByText(/tool execution produced no result/)
    ).toBeInTheDocument()
  })

  it("shows no recovered report unless the child's task completed", () => {
    // Qoder files a `result` on every terminal task, not only a finished one:
    // the error message for `failed`/`cancelled`, and a placeholder ("The
    // process that owned this subagent task is no longer running.") when a
    // dead process's `running` task is rewritten to `interrupted`. None of
    // those is a report the child finished.
    for (const status of ["interrupted", "failed", "cancelled", undefined]) {
      const { unmount } = renderCard({
        ...erroredPart,
        agentStats: {
          tool_calls: [{ tool_name: "Read", is_error: false }],
          ...(status ? { status } : {}),
          recovered_result:
            "The process that owned this subagent task is no longer running.",
        },
      })
      expect(screen.queryByText(/actually finished/)).not.toBeInTheDocument()
      expect(screen.queryByText(/no longer running/)).not.toBeInTheDocument()
      unmount()
    }
  })

  it("renders nothing extra when the errored card has nothing to recover", () => {
    renderCard({
      ...erroredPart,
      agentStats: { tool_calls: [{ tool_name: "Read", is_error: false }] },
    })
    expect(screen.queryByText(/actually finished/)).not.toBeInTheDocument()
  })

  it("never renders the recovered report on a normally completed card", () => {
    // A normally completed async child delivered its result via the
    // notification turn — even when a parser attached the field, the card
    // must not show it.
    renderCard({
      ...basePart(
        JSON.stringify({ subagent_type: "Explore", description: "scan" }),
        "output-available"
      ),
      output: "normal result",
      agentStats: {
        tool_calls: [],
        // A completed task, so only the card's own success keeps this hidden.
        status: "completed",
        recovered_result: "stale duplicate report",
      },
    })
    fireEvent.click(screen.getByRole("button", { name: "Completed" }))
    expect(screen.queryByText(/actually finished/)).not.toBeInTheDocument()
    expect(screen.queryByText("stale duplicate report")).not.toBeInTheDocument()
    expect(screen.getByText("normal result")).toBeInTheDocument()
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

describe("AgentToolCallPart background lifecycle", () => {
  const launch = (payload: Record<string, unknown>): ToolCallPart => ({
    ...basePart(
      JSON.stringify({
        subagent_type: "general-purpose",
        description: "probe sub bg bash",
      }),
      "output-available"
    ),
    output: `${BACKGROUND_TASK_MARKER}${JSON.stringify(payload)}`,
  })

  // Claude Code notifies `completed` for a sub-agent that ended its run while
  // background work of its own still runs, and says it will notify again.
  it("reads an interim notification as an interim result, not as completed", () => {
    renderCard(
      launch({
        task_id: "a0a4",
        status: "completed",
        summary:
          'Agent "probe sub bg bash" is waiting on its own background work',
        result: "interim report",
        interim: true,
      })
    )
    const trigger = screen.getByLabelText("Background task: interim result")
    expect(
      screen.queryByLabelText("Background task completed")
    ).not.toBeInTheDocument()
    fireEvent.click(trigger)
    expect(
      screen.getByText(
        'Agent "probe sub bg bash" is waiting on its own background work'
      )
    ).toBeInTheDocument()
    expect(screen.getByText("interim report")).toBeInTheDocument()
  })

  it("reads the final notification as completed", () => {
    renderCard(
      launch({
        task_id: "a0a4",
        status: "completed",
        summary: 'Agent "probe sub bg bash" finished',
        result: "final report",
      })
    )
    expect(
      screen.getByLabelText("Background task completed")
    ).toBeInTheDocument()
    expect(
      screen.queryByLabelText("Background task: interim result")
    ).not.toBeInTheDocument()
  })
})
