import { fireEvent, render, screen, within } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, describe, expect, it } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import {
  StaticConnectionStoreProvider,
  type ConnectionStoreApi,
} from "@/contexts/acp-connections-context"
import {
  StaticDelegationProvider,
  type DelegationContextValue,
} from "@/contexts/delegation-context"
import type { AdaptedContentPart } from "@/lib/adapters/ai-elements-adapter"
import { BACKGROUND_TASK_MARKER } from "@/lib/background-agent"
import { mockTruncateLayout } from "@/test-layout"
import { ContentPartsRenderer } from "../../content-parts-renderer"

/**
 * The sub-agent row (Claude Code's Agent/Task, codex's spawned agents, Cursor's
 * task, Grok's sub-agents): what it says about the sub-agent before and after
 * it is opened. Drawn through the reply renderer, the way the thread draws it.
 */

type ToolCallPart = Extract<AdaptedContentPart, { type: "tool-call" }>

const STORE: ConnectionStoreApi = {
  getConnection: () => undefined,
  getConnectPending: () => undefined,
  getConnectError: () => undefined,
  getActiveKey: () => null,
  subscribeKey: () => () => {},
  subscribeActiveKey: () => () => {},
}
const DELEGATION: DelegationContextValue = {
  findByParentToolUseId: () => undefined,
  findByChildConversationId: () => undefined,
  findByTaskId: () => undefined,
}

function renderRow(part: ToolCallPart) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <StaticConnectionStoreProvider store={STORE}>
        <StaticDelegationProvider value={DELEGATION}>
          <ContentPartsRenderer parts={[part]} role="assistant" />
        </StaticDelegationProvider>
      </StaticConnectionStoreProvider>
    </NextIntlClientProvider>
  )
}

function agent(
  input: string | null,
  state: ToolCallPart["state"],
  extra: Partial<ToolCallPart> = {}
): ToolCallPart {
  return {
    type: "tool-call",
    toolCallId: "call-agent",
    toolName: "agent",
    input,
    state,
    ...extra,
  }
}

/** The sub-agent's row: the first row of the reply. */
function row(): HTMLElement {
  const li = document.querySelector("li")
  if (!li) throw new Error("no row")
  return li as HTMLElement
}

/** The row's header — a button when it has a panel to open. */
function header(): HTMLElement {
  const el = row().querySelector(":scope > button, :scope > div")
  if (!el) throw new Error("no header")
  return el as HTMLElement
}

/** Open the row's panel (a failure is already open). */
function open() {
  const button = row().querySelector(":scope > button")
  if (!button) throw new Error("the row has no panel to open")
  if (button.getAttribute("aria-expanded") === "false") fireEvent.click(button)
}

function hasPanel(): boolean {
  return row().querySelector(":scope > button") !== null
}

describe("sub-agent row: model and effort", () => {
  // Claude Code 2.1.292's Agent tool takes an `effort` for the sub-agent.
  it("shows the requested effort beside the model", () => {
    renderRow(
      agent(
        JSON.stringify({
          subagent_type: "general-purpose",
          description: "probe sub",
          model: "sonnet",
          effort: "high",
        }),
        "output-available"
      )
    )
    open()
    expect(screen.getByText("sonnet").parentElement?.textContent).toBe(
      "Model: sonnet"
    )
    expect(screen.getByText("high").parentElement?.textContent).toBe(
      "Effort: high"
    )
  })

  it("shows the effort on its own when no model was named", () => {
    renderRow(
      agent(
        JSON.stringify({
          subagent_type: "general-purpose",
          description: "probe sub",
          prompt: "check",
          effort: "max",
        }),
        "output-available"
      )
    )
    open()
    expect(screen.getByText("max").parentElement?.textContent).toBe(
      "Effort: max"
    )
    expect(screen.queryByText(/Model:/)).not.toBeInTheDocument()
  })

  it("ignores an effort that is not a string", () => {
    renderRow(
      agent(
        JSON.stringify({
          subagent_type: "general-purpose",
          description: "probe sub",
          prompt: "say ok",
          effort: { level: "high" },
        }),
        "output-available",
        { output: "ok" }
      )
    )
    open()
    expect(screen.getAllByText("say ok").length).toBeGreaterThan(0)
    expect(screen.queryByText(/Effort:/)).not.toBeInTheDocument()
  })

  // The Agent tool's schema: a `model` or `effort` argument is ignored for
  // `subagent_type: "fork"`, which runs on the parent's model and effort.
  it("shows neither the model nor the effort of a fork, which ignores both", () => {
    renderRow(
      agent(
        JSON.stringify({
          subagent_type: "fork",
          description: "probe fork",
          prompt: "do it",
          model: "haiku",
          effort: "high",
        }),
        "output-available",
        { output: "done" }
      )
    )
    expect(header().textContent).toContain("forkprobe fork")
    open()
    expect(screen.queryByText(/Model:/)).not.toBeInTheDocument()
    expect(screen.queryByText(/Effort:/)).not.toBeInTheDocument()
  })

  it("keeps the model and effort of another agent's role named fork", () => {
    renderRow(
      agent(
        JSON.stringify({
          agent_type: "fork",
          description: "probe role",
          prompt: "go",
          model: "gpt-5.5",
          effort: "high",
        }),
        "output-available"
      )
    )
    open()
    expect(screen.getByText("gpt-5.5").parentElement?.textContent).toBe(
      "Model: gpt-5.5"
    )
    expect(screen.getByText("high").parentElement?.textContent).toBe(
      "Effort: high"
    )
  })
})

describe("sub-agent row: title", () => {
  it("names the sub-agent type, then the description", () => {
    renderRow(
      agent(
        JSON.stringify({
          subagent_type: "Explore",
          description: "map the repo",
        }),
        "input-available"
      )
    )
    expect(header().textContent).toContain("Exploremap the repo")
    expect(screen.queryByText(/Sub-agent starting/)).not.toBeInTheDocument()
    // The agent's words follow their own direction under an RTL UI.
    expect(screen.getByText("map the repo")).toHaveAttribute("dir", "auto")
  })

  it("shows the description alone when the type hasn't streamed in yet", () => {
    // Partial streamed input: the description is there, the type is not. The
    // placeholder must not be put in front of it.
    renderRow(agent('{"description":"map the repo"', "input-streaming"))
    expect(screen.getByText("map the repo")).toBeInTheDocument()
    expect(screen.queryByText(/Sub-agent starting/)).not.toBeInTheDocument()
  })

  it("falls back to the placeholder only when nothing has arrived", () => {
    renderRow(agent(null, "input-available"))
    expect(screen.getByText("Sub-agent starting…")).toBeInTheDocument()
  })

  it("reads Codex's agent_type field as the type", () => {
    renderRow(
      agent(
        JSON.stringify({ agent_type: "codex", description: "do the thing" }),
        "input-available"
      )
    )
    expect(header().textContent).toContain("codexdo the thing")
  })

  it("ignores a type or description that is not a string", () => {
    // Some hosts (CodeBuddy) hand these over as objects; drawing them would
    // throw "Objects are not valid as a React child".
    expect(() =>
      renderRow(
        agent(
          JSON.stringify({ subagent_type: {}, description: {} }),
          "input-available"
        )
      )
    ).not.toThrow()
    expect(screen.getByText("Sub-agent starting…")).toBeInTheDocument()
  })

  it("keeps a string description when the type is an object", () => {
    renderRow(
      agent(
        JSON.stringify({
          subagent_type: { nested: true },
          description: "build",
        }),
        "input-available"
      )
    )
    expect(screen.getByText("build")).toBeInTheDocument()
  })

  it("reads Cursor's subagentType oneof case as the type", () => {
    renderRow(
      agent(
        JSON.stringify({
          _toolName: "task",
          description: "run the build",
          subagentType: { case: "generalPurpose", value: {} },
        }),
        "input-available"
      )
    )
    expect(header().textContent).toContain("generalPurposerun the build")
  })

  it("badges codex's agent id by its first segment", () => {
    renderRow(
      agent(
        JSON.stringify({
          subagent_type: "worker",
          description: "build",
          agent_id: "abcd1234-uuid-9",
        }),
        "output-available"
      )
    )
    expect(screen.getByText("#abcd1234")).toBeInTheDocument()
    expect(screen.queryByText(/abcd1234-uuid-9/)).not.toBeInTheDocument()
  })

  it("shows no id badge for an agent that has none (Claude's Task)", () => {
    renderRow(
      agent(
        JSON.stringify({ subagent_type: "Explore", description: "map" }),
        "output-available"
      )
    )
    expect(screen.queryByText(/^#/)).not.toBeInTheDocument()
  })
})

describe("sub-agent row: the prompt it was handed", () => {
  // Longer than the title line shows: a paragraph break included.
  const PROMPT =
    "Find every consumer of source_bindings.\n\nReport which ones assume inactive bindings are present."

  // jsdom lays nothing out, so every node reads 0 wide — a prompt that fits.
  let restoreMetrics: (() => void) | null = null
  afterEach(() => {
    restoreMetrics?.()
    restoreMetrics = null
  })

  it("says the prompt on its title line, as one line, after the title", () => {
    renderRow(
      agent(
        JSON.stringify({
          subagent_type: "Explore",
          description: "map the repo",
          prompt: PROMPT,
        }),
        "output-available"
      )
    )
    const line = within(header()).getByText(
      "Find every consumer of source_bindings. Report which ones assume inactive bindings are present."
    )
    expect(line).toHaveClass("truncate", "text-activity-secondary")
    expect(line).toHaveAttribute("dir", "auto")
    // It takes only the room the title leaves, and nothing runs past the
    // line's end.
    expect(line).toHaveClass("flex-1")
    expect(line.parentElement).toHaveClass("overflow-hidden")
    // The type and description are the title it follows, in the darker ink.
    expect(within(header()).getByText("map the repo")).toHaveClass(
      "text-foreground"
    )
    expect(header().textContent).toBe(`Exploremap the repo${line.textContent}`)
    // No lines of its own under the title.
    expect(screen.getAllByText(/Find every consumer/)).toHaveLength(1)
  })

  it("has nothing to open when the prompt fits on its title line", () => {
    renderRow(
      agent(
        JSON.stringify({
          subagent_type: "Explore",
          description: "map",
          prompt: "List the files.",
        }),
        "output-available"
      )
    )
    expect(hasPanel()).toBe(false)
  })

  it("opens to the whole prompt when the title line cuts it short", () => {
    restoreMetrics = mockTruncateLayout(600, 200)
    renderRow(
      agent(
        JSON.stringify({
          subagent_type: "Explore",
          description: "map",
          prompt: PROMPT,
        }),
        "output-available"
      )
    )
    open()
    const panel = within(row().querySelector(".activity-detail") as HTMLElement)
    expect(panel.getByText(/^Report which ones assume/)).toBeInTheDocument()
  })
})

describe("sub-agent row: while it runs", () => {
  const skeleton = () => row().querySelector('[data-slot="skeleton"]')

  it("holds the line under its title with a skeleton until it has something to show", () => {
    renderRow(
      agent(
        JSON.stringify({
          subagent_type: "general-purpose",
          description: "run the build",
          prompt: "Run pnpm build.",
        }),
        "input-available"
      )
    )
    expect(skeleton()).not.toBeNull()
  })

  it("shows what it is doing instead, once it says", () => {
    renderRow(
      agent(
        JSON.stringify({ subagent_type: "Explore", description: "scan" }),
        "input-available",
        { agentTranscript: [{ type: "text", text: "Reading the config" }] }
      )
    )
    expect(within(row()).getByText("Reading the config")).toBeInTheDocument()
    expect(skeleton()).toBeNull()
  })

  it("draws no skeleton under a sub-agent that has finished", () => {
    renderRow(
      agent(
        JSON.stringify({
          subagent_type: "Explore",
          description: "scan",
          prompt: "Scan.",
        }),
        "output-available"
      )
    )
    expect(skeleton()).toBeNull()
  })
})

describe("sub-agent row: codex native sub-agents", () => {
  const launch = (extra: Record<string, unknown>) =>
    JSON.stringify({
      subagent_type: "pnpm_build",
      __codegCodexSubagentLaunch: true,
      ...extra,
    })

  it("never reads a launch codex has not reported on as finished", () => {
    // codex 0.147's team-of-agents encrypts the hand-off: no prompt, no
    // description, just the name and the thread id. Its card settles when codex
    // acknowledges the launch, which says nothing about how the child ended.
    renderRow(
      agent(
        launch({
          prompt: "",
          description: "",
          agent_id: "01a0098a-7e8a-72d3-b7c0-2df130c84063",
        }),
        "output-available"
      )
    )
    expect(screen.getByText("pnpm_build")).toBeInTheDocument()
    expect(screen.getByText("#01a0098a")).toBeInTheDocument()
    expect(within(header()).getByText("outcome unknown")).toBeInTheDocument()
    open()
    expect(
      screen.getByText(/hasn't reported how this sub-agent ended/)
    ).toBeInTheDocument()
  })

  it("holds the caveat back while the launch is still in flight", () => {
    renderRow(agent(launch({}), "input-available"))
    expect(screen.queryByText("outcome unknown")).not.toBeInTheDocument()
    expect(
      screen.queryByText(/hasn't reported how this sub-agent ended/)
    ).not.toBeInTheDocument()
  })

  it("says how it ended once codex reports it", () => {
    for (const [state, word, status] of [
      ["completed", "done", "succeeded"],
      ["interrupted", "interrupted", "cancelled"],
    ] as const) {
      const { unmount } = renderRow(
        agent(launch({ __codegCodexSubagentState: state }), "output-available")
      )
      expect(within(header()).getByText(word)).toBeInTheDocument()
      expect(row()).toHaveAttribute("data-status", status)
      expect(
        screen.queryByText(/hasn't reported how this sub-agent ended/)
      ).not.toBeInTheDocument()
      unmount()
    }
  })

  it("has no panel for a finished launch with nothing to show, but still opens its session", () => {
    // codex forwards the child's report over no wire, so the row has an
    // outcome and nothing else — and the child's own session is the only
    // record of its work.
    renderRow(
      agent(
        launch({
          agent_id: "01a08145-db62-78b3-9762-9cb2540216c2",
          __codegCodexSubagentState: "completed",
        }),
        "output-available"
      )
    )
    expect(hasPanel()).toBe(false)
    expect(
      screen.getByRole("button", { name: /Open conversation/ })
    ).toBeInTheDocument()
  })

  it("offers the child's session without opening the row", () => {
    renderRow(
      agent(
        launch({
          subagent_type: "history_limits",
          agent_id: "01a07fc2-db62-78b3-9762-9cb2540216c2",
          __codegCodexSubagentState: "completed",
        }),
        "output-available",
        { output: "Read 4 files." }
      )
    )
    expect(header()).toHaveAttribute("aria-expanded", "false")
    expect(
      screen.getByRole("button", { name: /Open conversation/ })
    ).toBeInTheDocument()
  })

  it("does not carry the caveat on an ordinary sub-agent", () => {
    // Claude's Task (and the like) settle when the sub-agent really is done.
    renderRow(
      agent(
        JSON.stringify({ subagent_type: "Explore", description: "map" }),
        "output-available",
        { output: "Mapped 12 files." }
      )
    )
    open()
    expect(screen.getAllByText("Mapped 12 files.").length).toBeGreaterThan(0)
    expect(screen.queryByText("outcome unknown")).not.toBeInTheDocument()
    expect(
      screen.queryByText(/hasn't reported how this sub-agent ended/)
    ).not.toBeInTheDocument()
    // Claude's Task has no session of its own to open.
    expect(
      screen.queryByRole("button", { name: /Open conversation/ })
    ).not.toBeInTheDocument()
  })
})

describe("sub-agent row: Cursor's task outcome envelope", () => {
  it("reads the success envelope as the duration, not a JSON body", () => {
    renderRow(
      agent(
        JSON.stringify({ _toolName: "task", description: "run the build" }),
        "output-available",
        { output: '{"durationMs":39894,"isBackground":false}' }
      )
    )
    expect(within(header()).getByText("39s")).toBeInTheDocument()
    expect(row()).toHaveAttribute("data-status", "succeeded")
    expect(document.body.textContent).not.toMatch(/durationMs|isBackground/)
  })

  it("reads the error envelope as a failure, though the wire says completed", () => {
    renderRow(
      agent(JSON.stringify({ _toolName: "task" }), "output-available", {
        output: '{"error":"Invalid arguments:\\nsubagent_type mismatch"}',
      })
    )
    expect(row()).toHaveAttribute("data-status", "failed")
    // A failure opens itself.
    expect(screen.getByText(/Invalid arguments:/)).toBeInTheDocument()
    expect(screen.queryByText(/{"error"/)).not.toBeInTheDocument()
  })

  it("reads a background launch as still running", () => {
    renderRow(
      agent(JSON.stringify({ _toolName: "task" }), "output-available", {
        output: '{"isBackground":true}',
      })
    )
    expect(
      within(header()).getByText("Running in background")
    ).toBeInTheDocument()
    expect(row()).toHaveAttribute("data-status", "running")
    expect(document.body.textContent).not.toContain("isBackground")
  })

  it("leaves another agent's JSON output alone", () => {
    // Without Cursor's `_toolName` stamp, JSON error text is just the
    // sub-agent's report.
    renderRow(
      agent(
        JSON.stringify({ subagent_type: "Explore", description: "map" }),
        "output-available",
        { output: '{"error":"not an envelope"}' }
      )
    )
    expect(row()).toHaveAttribute("data-status", "succeeded")
    open()
    expect(screen.getAllByText(/not an envelope/).length).toBeGreaterThan(0)
  })

  it("shows a genuine report as the result", () => {
    renderRow(
      agent(
        JSON.stringify({ subagent_type: "Explore", description: "map" }),
        "output-available",
        { output: "All 3 checks passed." }
      )
    )
    // Its first line stands under the row; the whole report is in the panel.
    expect(screen.getByText("All 3 checks passed.")).toBeInTheDocument()
    open()
    expect(screen.getAllByText("All 3 checks passed.")).toHaveLength(2)
  })
})

describe("sub-agent row: its own steps", () => {
  const withTranscript = (
    entries: NonNullable<ToolCallPart["agentTranscript"]>,
    extra: Partial<ToolCallPart> = {}
  ) =>
    agent(
      JSON.stringify({ subagent_type: "Explore", description: "scan" }),
      "input-available",
      { agentTranscript: entries, ...extra }
    )

  it("folds the sub-agent's thoughts like the main thread's", () => {
    renderRow(
      withTranscript([
        {
          type: "thinking",
          text: "**Planning the sweep**\n\nList the files, then grep each.",
        },
        { type: "text", text: "found three matches" },
      ])
    )
    open()
    const panel = within(row().querySelector(".activity-detail") as HTMLElement)
    expect(panel.getByText("found three matches")).toBeInTheDocument()
    // A thought shows its heading, folded; its text is one click away.
    expect(panel.getByText("Planning the sweep")).toBeInTheDocument()
    expect(panel.queryByText(/List the files/)).toBeNull()
    fireEvent.click(panel.getByText("Planning the sweep"))
    expect(panel.getByText(/List the files/)).toBeInTheDocument()
  })

  it("draws a child call between the prose that arrived on either side", () => {
    renderRow(
      withTranscript(
        [
          { type: "text", text: "before the read" },
          { type: "tool_call", childIndex: 0 },
          { type: "text", text: "after the read" },
        ],
        {
          agentStats: {
            tool_calls: [
              {
                tool_name: "Read",
                input_preview: JSON.stringify({ file_path: "/r/report.py" }),
                is_error: false,
              },
            ],
          },
        }
      )
    )
    open()
    const panel = within(row().querySelector(".activity-detail") as HTMLElement)
    const before = panel.getByText("before the read")
    const child = panel.getByText("/r/report.py")
    const after = panel.getByText("after the read")
    expect(
      before.compareDocumentPosition(child) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
    expect(
      child.compareDocumentPosition(after) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
  })

  it("ends its steps on the turning ring while it runs, then a row that folds it", () => {
    const steps: NonNullable<ToolCallPart["agentTranscript"]> = [
      { type: "text", text: "scanning the tree" },
    ]
    const view = renderRow(withTranscript(steps))
    open()
    const foot = () =>
      row().querySelector(".activity-detail .activity-timeline")!
        .lastElementChild as HTMLElement
    // Still running: its steps end on the turning ring.
    expect(foot()).toHaveAttribute("data-marker", "working")
    expect(foot().querySelector(".animate-spin")).toBeTruthy()

    // Done: on the row that folds it — no step it counts, so by its kind.
    view.rerender(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <StaticConnectionStoreProvider store={STORE}>
          <StaticDelegationProvider value={DELEGATION}>
            <ContentPartsRenderer
              parts={[
                agent(
                  JSON.stringify({
                    subagent_type: "Explore",
                    description: "scan",
                  }),
                  "output-available",
                  { agentTranscript: steps, output: "three matches" }
                ),
              ]}
              role="assistant"
            />
          </StaticDelegationProvider>
        </StaticConnectionStoreProvider>
      </NextIntlClientProvider>
    )
    expect(foot()).toHaveAttribute("data-marker", "foot")
    const fold = within(foot()).getByRole("button", {
      name: "Collapse Sub-agent",
    })
    expect(fold.querySelector("svg.lucide-chevron-up")).toBeTruthy()

    // Folded from it, the row's header takes the focus the foot had.
    fold.focus()
    fireEvent.click(fold)
    expect(header()).toHaveAttribute("aria-expanded", "false")
    expect(row().querySelector(".activity-detail")).toBeNull()
    expect(document.activeElement).toBe(header())
  })
})

describe("sub-agent row: errors", () => {
  // claude-agent-acp fences a failed tool's result for markdown clients; the
  // row shows it as preformatted text, as the transcript records it.
  it("shows a fenced error without its fence", () => {
    renderRow(
      agent(
        JSON.stringify({ subagent_type: "Explore", description: "scan" }),
        "output-error",
        {
          errorText:
            "```\nThe user doesn't want to proceed with this tool use.\n```",
        }
      )
    )
    expect(
      screen.getByText("The user doesn't want to proceed with this tool use.")
        .textContent
    ).toBe("The user doesn't want to proceed with this tool use.")
  })

  const errored = (extra: Partial<ToolCallPart>) =>
    agent(
      JSON.stringify({ subagent_type: "Explore", description: "scan" }),
      "output-error",
      { errorText: "Error: tool execution produced no result", ...extra }
    )

  it("shows the report a finished child left when the turn aborted", () => {
    // The turn ended before the async child's result was delivered: the call
    // failed, and the child's report survives only in agent_stats.
    renderRow(
      errored({
        agentStats: {
          tool_calls: [{ tool_name: "Read", is_error: false }],
          status: "completed",
          recovered_result: "The full research report.",
        },
      })
    )
    expect(screen.getByText(/actually finished/)).toBeInTheDocument()
    expect(screen.getByText("The full research report.")).toBeInTheDocument()
    expect(
      screen.getByText(/tool execution produced no result/)
    ).toBeInTheDocument()
  })

  it("shows no recovered report unless the child's task completed", () => {
    // Qoder files a `result` on every terminal task — an error message, or a
    // placeholder for a dead process — none of them a finished report.
    for (const status of ["interrupted", "failed", "cancelled", undefined]) {
      const { unmount } = renderRow(
        errored({
          agentStats: {
            tool_calls: [{ tool_name: "Read", is_error: false }],
            ...(status ? { status } : {}),
            recovered_result:
              "The process that owned this subagent task is no longer running.",
          },
        })
      )
      expect(screen.queryByText(/actually finished/)).not.toBeInTheDocument()
      expect(screen.queryByText(/no longer running/)).not.toBeInTheDocument()
      unmount()
    }
  })

  it("adds nothing when there is nothing to recover", () => {
    renderRow(
      errored({
        agentStats: { tool_calls: [{ tool_name: "Read", is_error: false }] },
      })
    )
    expect(screen.queryByText(/actually finished/)).not.toBeInTheDocument()
  })

  it("never shows a recovered report on a call that succeeded", () => {
    renderRow(
      agent(
        JSON.stringify({ subagent_type: "Explore", description: "scan" }),
        "output-available",
        {
          output: "normal result",
          agentStats: {
            tool_calls: [],
            status: "completed",
            recovered_result: "stale duplicate report",
          },
        }
      )
    )
    open()
    expect(screen.queryByText(/actually finished/)).not.toBeInTheDocument()
    expect(screen.queryByText("stale duplicate report")).not.toBeInTheDocument()
    expect(screen.getAllByText("normal result").length).toBeGreaterThan(0)
  })
})

describe("sub-agent row: Grok's live progress", () => {
  const running = (meta: Record<string, unknown>) =>
    agent(
      JSON.stringify({ subagent_type: "explore", description: "map repo" }),
      "input-available",
      { meta }
    )

  it("shows the progress ticker under the row while it runs", () => {
    renderRow(
      running({
        grokSubagentProgress: {
          durationMs: 4200,
          turnCount: 1,
          toolCallCount: 7,
          contextUsagePct: 12.4,
        },
      })
    )
    expect(
      screen.getByText("7 tool calls · 1 turns · 4s · context 12%")
    ).toBeInTheDocument()
  })

  it("skips absent fields and shapes that are not numbers", () => {
    renderRow(
      running({
        grokSubagentProgress: { toolCallCount: 3, contextUsagePct: "nope" },
      })
    )
    expect(screen.getByText("3 tool calls")).toBeInTheDocument()
  })

  it("drops the ticker once the call settles", () => {
    renderRow(
      agent(
        JSON.stringify({ subagent_type: "explore", description: "map repo" }),
        "output-available",
        {
          output: "final result",
          meta: { grokSubagentProgress: { toolCallCount: 9 } },
        }
      )
    )
    expect(screen.queryByText(/9 tool calls/)).not.toBeInTheDocument()
    expect(screen.getByText("final result")).toBeInTheDocument()
  })

  it("keeps the ticker beside a background launch", () => {
    // A background spawn settles its call with an ack while the child runs.
    renderRow(
      agent(
        JSON.stringify({ subagent_type: "explore", description: "map repo" }),
        "output-available",
        {
          output: "Subagent started in background.\nsubagent_id: sub-1",
          meta: { grokSubagentProgress: { toolCallCount: 5 } },
        }
      )
    )
    expect(screen.getByText("5 tool calls")).toBeInTheDocument()
    expect(
      within(header()).getByText("Running in background")
    ).toBeInTheDocument()
    expect(
      screen.queryByText(/Subagent started in background/)
    ).not.toBeInTheDocument()
  })

  // A reloaded card holds the cold parse's pending marker, which alone can't
  // say the child still runs. A tick that reached it since (out of turn, as
  // `background_task_progress`) can.
  const pendingMarker =
    '[[codeg-background-task]]{"task_id":"sub-1","status":null,"summary":null,"result":null}'

  it("reads a reloaded pending card as running once its child ticks", () => {
    renderRow(
      agent(
        JSON.stringify({ description: "map repo", prompt: "map it" }),
        "output-available",
        {
          output: pendingMarker,
          meta: {
            grokSubagentProgress: { toolCallCount: 4, durationMs: 9000 },
          },
        }
      )
    )
    expect(screen.getByText("4 tool calls · 9s")).toBeInTheDocument()
    expect(
      within(header()).getByText("Running in background")
    ).toBeInTheDocument()
  })

  it("leaves a reloaded pending card launched while no tick has come", () => {
    renderRow(
      agent(
        JSON.stringify({ description: "map repo", prompt: "map it" }),
        "output-available",
        { output: pendingMarker }
      )
    )
    expect(
      within(header()).queryByText("Running in background")
    ).not.toBeInTheDocument()
  })
})

describe("sub-agent row: the child's own session", () => {
  it("offers it from the live spawn meta while the child runs", () => {
    // Grok forwards none of the child's work over ACP: the session is the only
    // way to watch it.
    renderRow(
      agent(
        JSON.stringify({ subagent_type: "explore", description: "map repo" }),
        "input-available",
        {
          meta: {
            grokSubagentSession: {
              subagentId: "sub-1",
              childSessionId: "019fe6bf-0bcb-70c2-a02d-e5c006dfc32a",
            },
          },
        }
      )
    )
    expect(
      screen.getByRole("button", { name: /Open conversation/ })
    ).toBeInTheDocument()
  })

  it("offers it from the parsed stats of a finished call", () => {
    renderRow(
      agent(
        JSON.stringify({ subagent_type: "explore", description: "map repo" }),
        "output-available",
        {
          output: "final result",
          agentStats: {
            agent_type: "explore",
            status: "completed",
            child_session_id: "019fe6bf-0bcb-70c2-a02d-e5c006dfc32a",
          },
        }
      )
    )
    expect(
      screen.getByRole("button", { name: /Open conversation/ })
    ).toBeInTheDocument()
  })
})

describe("sub-agent row: background lifecycle", () => {
  const launch = (payload: Record<string, unknown>) =>
    agent(
      JSON.stringify({
        subagent_type: "general-purpose",
        description: "probe sub bg bash",
      }),
      "output-available",
      { output: `${BACKGROUND_TASK_MARKER}${JSON.stringify(payload)}` }
    )

  // Claude Code notifies `completed` for a sub-agent that ended its run while
  // background work of its own still runs, and says it will notify again.
  it("reads an interim notification as an interim result, not as done", () => {
    renderRow(
      launch({
        task_id: "a0a4",
        status: "completed",
        summary:
          'Agent "probe sub bg bash" is waiting on its own background work',
        result: "interim report",
        interim: true,
      })
    )
    expect(within(header()).getByText("interim result")).toBeInTheDocument()
    open()
    expect(
      screen.getByText(
        'Agent "probe sub bg bash" is waiting on its own background work'
      )
    ).toBeInTheDocument()
    expect(screen.getAllByText("interim report").length).toBeGreaterThan(0)
  })

  it("reads the final notification as done", () => {
    renderRow(
      launch({
        task_id: "a0a4",
        status: "completed",
        summary: 'Agent "probe sub bg bash" finished',
        result: "final report",
      })
    )
    expect(screen.queryByText("interim result")).not.toBeInTheDocument()
    expect(row()).toHaveAttribute("data-status", "succeeded")
    open()
    expect(screen.getAllByText("final report").length).toBeGreaterThan(0)
  })

  it("says it was launched while its result has not come back", () => {
    renderRow(launch({ task_id: "a0a4", summary: "started" }))
    expect(within(header()).getByText("launched")).toBeInTheDocument()
    open()
    expect(screen.getByText("Result not returned yet")).toBeInTheDocument()
    expect(document.body.textContent).not.toContain(BACKGROUND_TASK_MARKER)
  })

  // OpenCode settles a background sub-agent from its end, which carries no
  // reply when the sub-agent wrote none.
  it("shows no result, never the marker, for a settle that carries none", () => {
    renderRow(
      launch({
        task_id: "ses_child",
        status: "completed",
        summary: null,
        result: null,
      })
    )
    expect(row()).toHaveAttribute("data-status", "succeeded")
    open()
    expect(document.body.textContent).not.toContain(BACKGROUND_TASK_MARKER)
  })

  it("says how a failed settle ended, without a result", () => {
    renderRow(
      launch({
        task_id: "ses_child",
        status: "failed",
        summary: "Rate limited",
        result: null,
      })
    )
    expect(row()).toHaveAttribute("data-status", "failed")
    expect(within(header()).getByText("failed")).toBeInTheDocument()
    open()
    expect(screen.getByText("Rate limited")).toBeInTheDocument()
    expect(document.body.textContent).not.toContain(BACKGROUND_TASK_MARKER)
  })
})
