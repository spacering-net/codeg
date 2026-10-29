import { useState, type ReactElement } from "react"
import { act, fireEvent, render, screen, within } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import {
  StaticConnectionStoreProvider,
  type ConnectionStoreApi,
} from "@/contexts/acp-connections-context"
import {
  StaticDelegationProvider,
  type DelegationContextValue,
} from "@/contexts/delegation-context"
import {
  StaticWorkspaceActionsProvider,
  type WorkspaceActionsValue,
} from "@/contexts/workspace-context"
import {
  adaptMessageTurn,
  type AdaptedContentPart,
} from "@/lib/adapters/ai-elements-adapter"
import {
  MOCKUP_ADAPTER_TEXT,
  MOCKUP_ASSISTANT_TURN,
  fixtureLines,
  toolResult,
  toolUse,
} from "@/lib/activity/__fixtures__/mockup-turn"
import type { ToolApprovalMap } from "@/lib/activity/approval"
import type { ContentBlock, MessageTurn } from "@/lib/types"
import { CompletedTurnContent } from "../completed-turn-content"
import { ActivityLiveProvider } from "./activity-live-context"
import { resetDisclosureStore } from "./disclosure-store"

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
const WORKSPACE = new Proxy(
  {},
  { get: () => () => {} }
) as unknown as WorkspaceActionsValue

function Round({
  parts,
  completed = true,
}: {
  parts: AdaptedContentPart[]
  completed?: boolean
}) {
  const [open, setOpen] = useState(true)
  return (
    <CompletedTurnContent
      parts={parts}
      durationMs={60000}
      completed={completed}
      currentRound
      roundOpen={open}
      onRoundOpenChange={setOpen}
    />
  )
}

function withProviders(
  ui: ReactElement,
  awaitingToolCallId: string | null = null,
  approvals: ToolApprovalMap = {}
) {
  return (
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <StaticConnectionStoreProvider store={STORE}>
        <StaticDelegationProvider value={DELEGATION}>
          <StaticWorkspaceActionsProvider value={WORKSPACE}>
            <ActivityLiveProvider
              value={{
                awaitingToolCallId,
                awaitingUser: awaitingToolCallId !== null,
                approvals,
              }}
            >
              {ui}
            </ActivityLiveProvider>
          </StaticWorkspaceActionsProvider>
        </StaticDelegationProvider>
      </StaticConnectionStoreProvider>
    </NextIntlClientProvider>
  )
}

function renderUi(
  ui: ReactElement,
  awaitingToolCallId: string | null = null,
  approvals: ToolApprovalMap = {}
) {
  return render(withProviders(ui, awaitingToolCallId, approvals))
}

function turn(blocks: ContentBlock[], id = "t"): MessageTurn {
  return {
    id,
    role: "assistant",
    timestamp: "2026-10-22T10:00:00Z",
    blocks: [...blocks, { type: "text", text: "Done." }],
  }
}

function parts(t: MessageTurn, live = false, inProgress?: string[]) {
  return adaptMessageTurn(
    t,
    MOCKUP_ADAPTER_TEXT,
    live,
    inProgress ? new Set(inProgress) : undefined
  ).content
}

function rowOf(text: string | RegExp): HTMLElement {
  const row = screen.getAllByText(text)[0]!.closest("li")
  if (!row) throw new Error(`no row for ${String(text)}`)
  return row as HTMLElement
}

beforeEach(() => {
  resetDisclosureStore()
})

afterEach(() => {
  vi.useRealTimers()
})

describe("delegation row", () => {
  it("draws the hand-over and the wait for its result as rows of their own", () => {
    renderUi(<Round parts={parts(MOCKUP_ASSISTANT_TURN)} />)
    const row = rowOf("Codex")
    expect(within(row).getByText("#14be49e7")).toBeTruthy()
    expect(row.textContent).toContain("done · 1m 34s")
    expect(
      within(row).getByText(
        "Snapshot updated. 48/48 passing, no regressions in audit artifacts."
      )
    ).toBeTruthy()
    expect(
      within(row).getByRole("button", { name: /Open conversation/ })
    ).toBeTruthy()
    // The agent's check on the task, right after it.
    const wait = rowOf("Waiting for task #14be49e7 result")
    expect(row.nextElementSibling).toBe(wait)
    expect(wait.textContent).toContain("done · 1m 34s")
  })

  it("marks a check whose panel is open, so the rail can run beside it", () => {
    renderUi(<Round parts={parts(MOCKUP_ASSISTANT_TURN)} />)
    const wait = rowOf("Waiting for task #14be49e7 result")
    expect(wait).not.toHaveAttribute("data-body")
    fireEvent.click(within(wait).getAllByRole("button")[0]!)
    expect(wait).toHaveAttribute("data-body")
  })

  it("says the task on its title line, not on a line of its own", () => {
    renderUi(<Round parts={parts(MOCKUP_ASSISTANT_TURN)} />)
    const row = rowOf("Codex")
    const header = row.querySelector(":scope > div, :scope > button")!
    expect(
      within(header as HTMLElement).getByText(/^Update the stale snapshot/)
    ).toHaveClass("truncate")
  })

  it("counts the steps it took and draws one segment per step", () => {
    renderUi(<Round parts={parts(MOCKUP_ASSISTANT_TURN)} />)
    const row = rowOf("Codex")
    expect(within(row).getByText("· 5 steps")).toBeTruthy()
    expect(
      within(row).getByRole("img", { name: "5 steps, 1 failed" })
    ).toBeTruthy()
  })
})

describe("a folded turn", () => {
  const delegated = (id: string, taskId: string, status: string) => [
    toolUse(
      id,
      "mcp__codeg-mcp__delegate_to_agent",
      { agent_type: "codex", task: `Task ${taskId}` },
      { "codeg.delegation": { status, task_id: taskId } }
    ),
    toolResult(id, JSON.stringify({ task_id: taskId, status: "started" })),
  ]
  const checked = (id: string, report: Record<string, unknown>) => [
    toolUse(id, "mcp__codeg-mcp__get_delegation_status", {
      task_ids: [report.task_id],
    }),
    toolResult(id, JSON.stringify(report)),
  ]

  it("keeps the check whose sub-agent waits on the user under its header", () => {
    renderUi(
      <Round
        parts={parts(
          turn([
            ...delegated("d1", "aaaa1111", "running"),
            ...checked("p1", {
              task_id: "aaaa1111",
              status: "running",
              blocked_on: { kind: "permission" },
            }),
            ...delegated("d2", "bbbb2222", "completed"),
            ...checked("p2", {
              task_id: "bbbb2222",
              status: "completed",
              text: "Done.",
            }),
          ])
        )}
      />
    )
    expect(screen.getAllByText(/^Waiting for task/)).toHaveLength(2)
    fireEvent.click(screen.getByRole("button", { name: "Activity" }))
    expect(screen.getByText("#aaaa1111")).toBeTruthy()
    expect(
      rowOf("Waiting for task #aaaa1111 result").getAttribute("data-status")
    ).toBe("awaiting")
    expect(screen.queryByText("#bbbb2222")).toBeNull()
    expect(screen.queryByText("Waiting for task #bbbb2222 result")).toBeNull()
    // What stays in view is no list of the turn's steps: it has no end mark.
    const lists = document.querySelectorAll(".activity-timeline")
    expect(lists).toHaveLength(1)
    expect(lists[0]).not.toHaveAttribute("data-end")
    // It hangs under the header as the open list does: a step's gap below
    // it, the rail running up to it (globals.css), no margin of its own.
    expect(lists[0]).toHaveAttribute("data-headed")
    expect(lists[0]!.className.split(/\s+/)).not.toContain("mt-2")
  })
})

describe("background task row", () => {
  it("names the task after the command that started it", () => {
    renderUi(<Round parts={parts(MOCKUP_ASSISTANT_TURN)} />)
    const row = rowOf("Task finished")
    expect(within(row).getByText("#beecec7d")).toBeTruthy()
    expect(
      within(row).getByText("Regenerate audit report · report.md written")
    ).toBeTruthy()
    expect(within(row).getByText("done")).toBeTruthy()
  })
})

describe("plan, plan-mode and feedback rows", () => {
  const WORKFLOW = turn([
    toolUse("p1", "TodoWrite", {
      todos: [
        { content: "Reproduce", status: "completed" },
        { content: "Fix the filter", status: "in_progress" },
        { content: "Regenerate", status: "pending" },
      ],
    }),
    toolResult("p1", "Todos have been modified successfully."),
    toolUse("p2", "mcp__codeg-mcp__check_user_feedback", {}),
    toolResult(
      "p2",
      '{"count":1,"feedback":[{"created_at":"2026-10-22T09:41:12Z","text":"Keep CSV working"}]}'
    ),
    toolUse("p3", "ExitPlanMode", { plan: "# Keep CSV working\n\n1. Map it" }),
    toolResult("p3", "User has approved your plan."),
  ])

  it("summarizes the plan by its current item", () => {
    renderUi(<Round parts={parts(WORKFLOW)} />)
    const row = rowOf("Updated plan")
    expect(within(row).getByText("Fix the filter")).toBeTruthy()
    expect(within(row).getByText("1/3")).toBeTruthy()
  })

  it("opens the user's feedback notes by default", () => {
    renderUi(<Round parts={parts(WORKFLOW)} />)
    const row = rowOf("1 feedback note")
    expect(within(row).getAllByText("Keep CSV working").length).toBe(2)
  })

  it("opens a submitted plan to the plan itself", () => {
    renderUi(<Round parts={parts(WORKFLOW)} />)
    const row = rowOf("Plan submitted")
    expect(within(row).getByText("Map it")).toBeTruthy()
  })
})

describe("agent row", () => {
  const AGENT = turn([
    toolUse("a1", "Agent", {
      description: "Find binding consumers",
      prompt: "Find every consumer of source_bindings.",
      subagent_type: "Explore",
    }),
    {
      type: "tool_result",
      tool_use_id: "a1",
      is_error: false,
      output_preview: "Only `report.py` assumes inactive bindings.",
      agent_stats: {
        agent_type: "Explore",
        status: "completed",
        total_duration_ms: 48000,
        tool_calls: [
          {
            tool_name: "Grep",
            input_preview: JSON.stringify({ pattern: "source_bindings" }),
            output_preview: "a.py:1:x",
            is_error: false,
          },
          {
            tool_name: "Read",
            input_preview: JSON.stringify({ file_path: "/r/report.py" }),
            output_preview: fixtureLines(3, "report.py"),
            is_error: false,
          },
        ],
      },
    },
  ])

  it("shows the prompt on its title line, the result's first line under it, and opens to its own steps", () => {
    renderUi(<Round parts={parts(AGENT)} />)
    const row = rowOf("Explore")
    const header = row.querySelector(":scope > button")!
    expect(within(row).getByText("Find binding consumers")).toBeTruthy()
    expect(
      within(row).getAllByText("Find every consumer of source_bindings.")
    ).toEqual([
      within(header as HTMLElement).getByText(
        "Find every consumer of source_bindings."
      ),
    ])
    expect(
      within(row).getByText("Only report.py assumes inactive bindings.")
    ).toBeTruthy()
    // Written like the reply's header: whole seconds.
    expect(within(row).getByText("48s")).toBeTruthy()
    expect(within(row).getByRole("img", { name: "2 steps" })).toBeTruthy()
    fireEvent.click(within(row).getAllByRole("button")[0]!)
    expect(within(row).getByText("Explored")).toBeTruthy()
  })
})

describe("waiting on the user", () => {
  it("marks the call a pending approval is about", () => {
    const LIVE = turn([toolUse("c1", "Bash", { command: "rm -rf build" })])
    renderUi(
      <Round parts={parts(LIVE, true, ["c1"])} completed={false} />,
      "c1"
    )
    const row = rowOf("rm -rf build")
    expect(row.getAttribute("data-status")).toBe("awaiting")
    expect(within(row).getByText("needs you")).toBeTruthy()
    expect(
      within(row).getByRole("img", { name: "Command, waiting for you" })
    ).toBeTruthy()
  })
})

describe("jumping to a failure", () => {
  it("opens the turn's first unrecovered failure from the header", () => {
    const FAILING = turn([
      toolUse("r1", "Read", { file_path: "/r/a.ts" }),
      toolResult("r1", "a"),
      toolUse("r2", "Read", { file_path: "/r/b.ts" }),
      toolResult("r2", "Permission denied", true),
    ])
    renderUi(<Round parts={parts(FAILING)} />)
    // Folded, and the failed read sits inside the Explored group.
    fireEvent.click(screen.getByRole("button", { name: "Activity" }))
    expect(screen.queryByText("Permission denied")).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "1 failed" }))
    expect(screen.getByText("Permission denied")).toBeTruthy()
  })
})

describe("long replies", () => {
  function edits(count: number): MessageTurn {
    const blocks: ContentBlock[] = []
    for (let i = 0; i < count; i++) {
      blocks.push(
        toolUse(`e${i}`, "Edit", {
          file_path: `/r/f${i}.ts`,
          old_string: "a",
          new_string: "b",
        })
      )
      blocks.push(toolResult(`e${i}`, "ok"))
    }
    return turn(blocks)
  }

  it("opens a giant reply with its head and tail and a way to see the rest", () => {
    renderUi(<Round parts={parts(edits(200))} />)
    const more = screen.getByRole("button", { name: "Show 130 more steps" })
    expect(screen.getAllByText("Edited")).toHaveLength(70)
    fireEvent.click(more)
    expect(screen.getAllByText("Edited")).toHaveLength(200)
  })

  it("folds a streaming reply's rows away one at a time as it grows", () => {
    // At work on its latest call: no prose after it yet, which would be one
    // more row on the rail.
    const running = (count: number): MessageTurn => {
      const done = edits(count)
      return { ...done, blocks: done.blocks.slice(0, -1) }
    }
    const live = (count: number) => (
      <Round parts={parts(running(count), true)} completed={false} />
    )
    const view = renderUi(live(150))
    expect(screen.getAllByText("Edited")).toHaveLength(150)
    expect(screen.queryByRole("button", { name: /more step/ })).toBeNull()
    const late = rowOf("f149.ts")
    // Past the fold, the oldest row past the head goes, not a whole chunk —
    // and the rows that stay are the same rows, not drawn again.
    view.rerender(withProviders(live(151)))
    expect(
      screen.getByRole("button", { name: "Show 1 more step" })
    ).toBeTruthy()
    expect(screen.getAllByText("Edited")).toHaveLength(150)
    expect(rowOf("f149.ts")).toBe(late)
    view.rerender(withProviders(live(152)))
    expect(
      screen.getByRole("button", { name: "Show 2 more steps" })
    ).toBeTruthy()
    expect(screen.getAllByText("Edited")).toHaveLength(150)
  })
})

describe("running clock", () => {
  it("shows how long a command has run once it passes ten seconds", () => {
    vi.useFakeTimers()
    const LIVE = turn([toolUse("c1", "Bash", { command: "pnpm build" })])
    renderUi(<Round parts={parts(LIVE, true, ["c1"])} completed={false} />)
    const row = rowOf("pnpm build")
    expect(within(row).queryByText(/^0:/)).toBeNull()
    act(() => {
      vi.advanceTimersByTime(12_000)
    })
    expect(within(row).getByText("0:12")).toBeTruthy()
  })
})

describe("approval chips", () => {
  const record = (toolCallId: string, optionKind: string) => ({
    tool_call_id: toolCallId,
    option_kind: optionKind,
    option_name: "Allow",
    origin: "user",
    decided_at: "2026-10-22T09:41:12Z",
  })

  it("draws a reopened conversation's approval on the call's row", () => {
    const REOPENED = turn([
      toolUse(
        "c1",
        "Bash",
        { command: "git commit -am wip" },
        {
          "codeg.approval": {
            option_kind: "allow_always",
            option_name: "Yes, and don't ask again for git commands",
            origin: "chat_channel",
            decided_at: "2026-10-22T09:41:12Z",
          },
        }
      ),
      toolResult("c1", "[main 1a2b3c4] wip"),
    ])
    renderUi(<Round parts={parts(REOPENED)} />)
    const chip = within(rowOf("git commit -am wip")).getByText("always allowed")
    expect(chip.getAttribute("title")).toMatch(
      /^Yes, and don't ask again for git commands · via a chat channel · /
    )
  })

  it("draws the live connection's answer, which the history has yet to carry", () => {
    const LIVE = turn([
      toolUse("c1", "Bash", { command: "pnpm build" }),
      toolResult("c1", "built"),
    ])
    renderUi(<Round parts={parts(LIVE)} />, null, {
      c1: record("c1", "allow_once"),
    })
    expect(within(rowOf("pnpm build")).getByText("approved once")).toBeTruthy()
  })

  it("says a declined call was declined, once", () => {
    const DECLINED = turn([
      toolUse("c1", "Bash", { command: "rm -rf build" }),
      toolResult("c1", "Error: tool call was not run", true),
    ])
    renderUi(<Round parts={parts(DECLINED)} />, null, {
      c1: record("c1", "reject_once"),
    })
    const row = rowOf("rm -rf build")
    expect(row.getAttribute("data-status")).toBe("rejected")
    expect(within(row).getAllByText("declined")).toHaveLength(1)
  })

  it("marks an approved call inside an opened group", () => {
    const RUN = turn([
      toolUse("c1", "Bash", { command: "pnpm lint" }),
      toolResult("c1", "ok"),
      toolUse("c2", "Bash", { command: "pnpm test" }),
      toolResult("c2", "ok"),
    ])
    renderUi(<Round parts={parts(RUN)} />, null, {
      c2: record("c2", "allow_once"),
    })
    fireEvent.click(screen.getByRole("button", { name: /Ran 2 commands/ }))
    expect(within(rowOf("pnpm test")).getByText("approved once")).toBeTruthy()
    expect(within(rowOf("pnpm lint")).queryByText("approved once")).toBeNull()
  })
})

describe("Claude Code's monitors and sandbox network requests", () => {
  const record = (toolCallId: string, optionKind: string) => ({
    tool_call_id: toolCallId,
    option_kind: optionKind,
    option_name: optionKind.startsWith("reject") ? "No" : "Yes",
    origin: "user",
    decided_at: "2026-10-28T09:41:12Z",
  })
  // Claude Code 2.1.310's result for a started Monitor, verbatim.
  const STARTED =
    "Monitor started (task bttyx34fg, expires in 5m unless the source ends first; you get one notice at expiry — re-arm if you still need the watch). You will be notified on each event. Keep working — do not poll or sleep. Events may arrive while you are waiting for the user — an event is not their reply."

  it("draws a monitor as one, by its task, apart from the commands", () => {
    const RUN = turn([
      toolUse("c1", "Bash", { command: "pnpm build" }),
      toolResult("c1", "built"),
      toolUse("m1", "Monitor", {
        command: "tail -f build.log | grep --line-buffered ERROR",
        description: "Build errors",
      }),
      toolResult("m1", STARTED),
      toolUse("c2", "Bash", { command: "pnpm test" }),
      toolResult("c2", "ok"),
    ])
    renderUi(<Round parts={parts(RUN)} />)
    // Not one of the commands around it.
    expect(screen.queryByRole("button", { name: /Ran 2 commands/ })).toBeNull()
    expect(screen.queryByRole("button", { name: /Ran 3 commands/ })).toBeNull()
    const row = rowOf("Build errors")
    expect(within(row).getByText("Monitor")).toBeTruthy()
    expect(within(row).getByText("background · #bttyx34fg")).toBeTruthy()
    fireEvent.click(within(row).getAllByRole("button")[0]!)
    expect(
      within(row).getByText("tail -f build.log | grep --line-buffered ERROR")
    ).toBeTruthy()
    expect(within(row).getByText("$")).toBeTruthy()
    expect(
      within(row).getByText("Watching in background · bttyx34fg")
    ).toBeTruthy()
    // The CLI's instructions to the model are not the reader's output.
    expect(within(row).queryByText(/do not poll or sleep/)).toBeNull()
  })

  it("shows a WebSocket monitor's socket, not a command line", () => {
    const RUN = turn([
      toolUse("m1", "Monitor", {
        ws: { url: "wss://ci.example.com/events" },
        description: "CI events",
      }),
      toolResult("m1", STARTED),
    ])
    renderUi(<Round parts={parts(RUN)} />)
    const row = rowOf("CI events")
    expect(within(row).getByText("background · #bttyx34fg")).toBeTruthy()
    fireEvent.click(within(row).getAllByRole("button")[0]!)
    expect(within(row).getByText("wss://ci.example.com/events")).toBeTruthy()
    expect(within(row).queryByText("$")).toBeNull()
  })

  it("names a declined network request's host, and opens to nothing", () => {
    const DECLINED = turn([
      toolUse("n1", "SandboxNetworkAccess", { host: "example.com" }),
      toolResult("n1", "", true),
    ])
    renderUi(<Round parts={parts(DECLINED)} />, null, {
      n1: record("n1", "reject_once"),
    })
    const row = rowOf("Network access")
    expect(row.getAttribute("data-status")).toBe("rejected")
    expect(within(row).getByText("example.com")).toBeTruthy()
    expect(within(row).getAllByText("declined")).toHaveLength(1)
    // Its one argument is on its line already: no panel of arguments.
    expect(within(row).queryByText(/"host"/)).toBeNull()
    expect(row.querySelector("[aria-expanded]")).toBeNull()
  })

  it("names an allowed network request's host", () => {
    const ALLOWED = turn([
      toolUse("n1", "SandboxNetworkAccess", { host: "registry.npmjs.org" }),
      toolResult("n1", ""),
    ])
    renderUi(<Round parts={parts(ALLOWED)} />, null, {
      n1: record("n1", "allow_once"),
    })
    const row = rowOf("Network access")
    expect(row.getAttribute("data-status")).toBe("succeeded")
    expect(within(row).getByText("registry.npmjs.org")).toBeTruthy()
    expect(within(row).getByText("approved once")).toBeTruthy()
  })
})

describe("a command group in a reply being written", () => {
  const LIVE = turn([
    toolUse("c1", "Bash", { command: "pnpm lint" }),
    toolResult("c1", "ok"),
    toolUse("c2", "Bash", { command: "pnpm test\npnpm build" }),
    toolResult("c2", "ok"),
    toolUse("c3", "Bash", { command: "rm -rf build" }),
  ])

  it("lists every command, one row each, and folds once the reply is done", () => {
    const { rerender } = renderUi(
      <Round parts={parts(LIVE, true, ["c3"])} completed={false} />
    )
    const group = rowOf("Running 3 commands")
    const members = group.querySelectorAll(".activity-child[data-step-key]")
    expect([...members].map((m) => m.getAttribute("data-step-key"))).toEqual([
      "tool:c1",
      "tool:c2",
      "tool:c3",
    ])
    expect(within(rowOf("pnpm lint")).getByText("Command")).toBeTruthy()
    expect(rowOf("pnpm test").getAttribute("data-status")).toBe("succeeded")
    expect(rowOf("rm -rf build").getAttribute("data-status")).toBe("running")

    rerender(withProviders(<Round parts={parts(LIVE)} />, null))
    expect(
      screen.getByRole("button", { name: /Ran 3 commands/ })
    ).toHaveAttribute("aria-expanded", "false")
    expect(screen.queryByText("pnpm lint")).toBeNull()
  })

  it("stays as the reader left it, open or folded", () => {
    const { rerender } = renderUi(
      <Round parts={parts(LIVE, true, ["c3"])} completed={false} />
    )
    // Folded by hand while it runs, it stays folded.
    fireEvent.click(screen.getByRole("button", { name: /Running 3 commands/ }))
    expect(screen.queryByText("pnpm lint")).toBeNull()
    // Opened again, it stays open once the reply is done.
    fireEvent.click(screen.getByRole("button", { name: /Running 3 commands/ }))
    rerender(withProviders(<Round parts={parts(LIVE)} />, null))
    expect(screen.getByText("pnpm lint")).toBeTruthy()
  })

  describe("once the reply moves past it", () => {
    const live = (blocks: ContentBlock[]): MessageTurn => ({
      id: "t-fold",
      role: "assistant",
      timestamp: "2026-10-23T10:00:00Z",
      blocks,
    })
    const DONE = [
      toolUse("c1", "Bash", { command: "pnpm lint" }),
      toolResult("c1", "ok"),
      toolUse("c2", "Bash", { command: "pnpm test" }),
      toolResult("c2", "ok"),
    ]
    const READ = toolUse("r1", "Read", { file_path: "/r/a.ts" })
    // The group's own header, not the row at the foot of its members.
    const header = () =>
      screen.getByRole("button", { name: /^(Ran|Running) 2 commands/ })

    it("folds by itself when the next step comes", () => {
      const view = renderUi(
        <Round parts={parts(live(DONE), true)} completed={false} />
      )
      // Its commands done but still the reply's last row: the next command
      // may join it.
      expect(header()).toHaveAttribute("aria-expanded", "true")

      view.rerender(
        withProviders(
          <Round
            parts={parts(live([...DONE, READ]), true, ["r1"])}
            completed={false}
          />
        )
      )
      expect(header()).toHaveAttribute("aria-expanded", "false")
      expect(screen.queryByText("pnpm lint")).toBeNull()
    })

    it("folds by itself when the answer starts under it", () => {
      const view = renderUi(
        <Round
          parts={parts(live([...DONE, { type: "text", text: " " }]), true)}
          completed={false}
        />
      )
      // Blank text is no answer yet.
      expect(header()).toHaveAttribute("aria-expanded", "true")

      view.rerender(
        withProviders(
          <Round
            parts={parts(
              live([...DONE, { type: "text", text: "Both pass." }]),
              true
            )}
            completed={false}
          />
        )
      )
      expect(header()).toHaveAttribute("aria-expanded", "false")
    })

    it("stays open while one of its commands still runs", () => {
      renderUi(
        <Round
          parts={parts(
            live([
              ...DONE.slice(0, 3),
              { type: "text", text: "While that runs…" },
              READ,
            ]),
            true,
            ["c2", "r1"]
          )}
          completed={false}
        />
      )
      expect(header()).toHaveAttribute("aria-expanded", "true")
    })

    it("stays open once the reader has opened it", () => {
      const view = renderUi(
        <Round parts={parts(live(DONE), true)} completed={false} />
      )
      fireEvent.click(header())
      fireEvent.click(header())
      view.rerender(
        withProviders(
          <Round
            parts={parts(live([...DONE, READ]), true, ["r1"])}
            completed={false}
          />
        )
      )
      expect(header()).toHaveAttribute("aria-expanded", "true")
      expect(screen.getByText("pnpm lint")).toBeTruthy()
      // Ended, its members end on the row that folds it.
      expect(
        screen.getByRole("button", { name: "Collapse 2 commands" })
      ).toBeTruthy()
    })

    it("turns at the foot of its commands until the reply moves past it", () => {
      // Its commands done but the group still the reply's last row: the next
      // command may join it, so its foot keeps turning rather than flicking
      // to the fold row and back between commands.
      const footOf = () =>
        document.querySelector<HTMLElement>(
          '.activity-children > li[data-marker="working"], .activity-children > li[data-marker="foot"]'
        )
      const view = renderUi(
        <Round parts={parts(live(DONE), true)} completed={false} />
      )
      expect(footOf()).toHaveAttribute("data-marker", "working")
      // Waiting on the user — a question elsewhere — nothing is at work: the
      // fold row instead.
      view.rerender(
        withProviders(
          <Round parts={parts(live(DONE), true)} completed={false} />,
          "question-elsewhere"
        )
      )
      expect(footOf()).toHaveAttribute("data-marker", "foot")
    })

    it("slides its members shut, and lets them go once the slide has run", () => {
      // jsdom runs no animations: report the slide the stylesheet starts.
      const computed = window.getComputedStyle
      const spy = vi
        .spyOn(window, "getComputedStyle")
        .mockImplementation((element, pseudo) =>
          element.classList.contains("activity-detail-shut")
            ? ({
                animationName: "activity-detail-shut",
                animationDuration: "0.24s",
              } as CSSStyleDeclaration)
            : computed(element, pseudo)
        )
      try {
        const view = renderUi(
          <Round parts={parts(live(DONE), true)} completed={false} />
        )
        view.rerender(
          withProviders(
            <Round
              parts={parts(live([...DONE, READ]), true, ["r1"])}
              completed={false}
            />
          )
        )
        expect(header()).toHaveAttribute("aria-expanded", "false")
        const panel = view.container.querySelector(".activity-detail-shut")!
        expect(panel).toBeTruthy()
        expect(within(panel as HTMLElement).getByText("pnpm lint")).toBeTruthy()
        // The rail still runs beside it while it slides.
        expect(rowOf("Ran 2 commands")).toHaveAttribute("data-body", "")
        // A member's own animation ending is not the slide's.
        fireEvent.animationEnd(rowOf("pnpm lint"))
        expect(screen.getByText("pnpm lint")).toBeTruthy()

        fireEvent.animationEnd(panel)
        expect(screen.queryByText("pnpm lint")).toBeNull()
        expect(rowOf("Ran 2 commands")).not.toHaveAttribute("data-body")
      } finally {
        spy.mockRestore()
      }
    })

    it("folds at once when the reader closes it", () => {
      const spy = vi.spyOn(window, "getComputedStyle")
      try {
        renderUi(<Round parts={parts(live(DONE), true)} completed={false} />)
        fireEvent.click(header())
        expect(screen.queryByText("pnpm lint")).toBeNull()
        expect(document.querySelector(".activity-detail-shut")).toBeNull()
      } finally {
        spy.mockRestore()
      }
    })

    describe("with a command moved to the background still running in it", () => {
      // codex-acp moves a long command to the background and never settles
      // the call that launched it: the command runs on, its own row saying
      // so, while the reply goes on past the group — and after it is done.
      const BACKGROUNDED: ContentBlock[] = [
        toolUse("c1", "Bash", { command: "pnpm lint" }),
        toolResult("c1", "ok"),
        {
          ...toolUse(
            "c2",
            "Bash",
            { command: "pnpm test" },
            { jetbrains: { air: { asyncTasks: { backgrounded: true } } } }
          ),
          status: "in_progress",
        } as ContentBlock,
      ]
      const THOUGHT: ContentBlock = {
        type: "thinking",
        text: "**Considering design options**",
      }
      /** The last of the group's members: the turning ring or the fold. */
      const footOf = () =>
        document.querySelector<HTMLElement>(
          '.activity-children > li[data-marker="working"], .activity-children > li[data-marker="foot"]'
        )
      const fold = () =>
        screen.getByRole("button", { name: "Collapse 2 commands" })

      it("ends its members on the row that folds it, not the turning ring", () => {
        renderUi(
          <Round
            parts={parts(live([...BACKGROUNDED, THOUGHT]), true)}
            completed={false}
          />
        )
        // Still running, it stays open, and its header says one runs.
        expect(header()).toHaveAttribute("aria-expanded", "true")
        expect(header()).toHaveAccessibleName(/^Running 2 commands/)
        const member = rowOf("pnpm test")
        expect(member).toHaveAttribute("data-status", "running")
        expect(within(member).getByText("background")).toBeTruthy()
        // A step follows it: no command joins it now.
        expect(footOf()).toHaveAttribute("data-marker", "foot")
        expect(within(footOf()!).getByRole("button")).toBe(fold())
        expect(
          document.querySelector('.activity-children > [data-marker="working"]')
        ).toBeNull()
      })

      it("takes the running command in with the rest when it folds", () => {
        renderUi(
          <Round
            parts={parts(live([...BACKGROUNDED, THOUGHT]), true)}
            completed={false}
          />
        )
        fireEvent.click(fold())
        expect(header()).toHaveAttribute("aria-expanded", "false")
        expect(screen.queryByText("pnpm lint")).toBeNull()
        expect(screen.queryByText("pnpm test")).toBeNull()
        expect(document.querySelector(".activity-children")).toBeNull()
        // Its header still says one of them runs.
        expect(rowOf("Running 2 commands")).toHaveAttribute(
          "data-status",
          "running"
        )
      })

      it("turns at its foot, folded shows the command, while it is still the reply's last row", () => {
        // Nothing after it yet: the next command may join it, and the one
        // running is the step under way.
        renderUi(
          <Round parts={parts(live(BACKGROUNDED), true)} completed={false} />
        )
        expect(footOf()).toHaveAttribute("data-marker", "working")
        fireEvent.click(header())
        expect(rowOf("pnpm test")).toHaveAttribute("data-status", "running")
        expect(screen.queryByText("pnpm lint")).toBeNull()
      })

      it("keeps the command in the group once the reply is done, even as its last row", () => {
        for (const blocks of [
          [...BACKGROUNDED, THOUGHT, { type: "text", text: "Done." }],
          BACKGROUNDED,
        ] as ContentBlock[][]) {
          const view = renderUi(<Round parts={parts(live(blocks))} />)
          // Folded by the reply being done, nothing under its header.
          expect(header()).toHaveAttribute("aria-expanded", "false")
          expect(screen.queryByText("pnpm test")).toBeNull()
          // Opened, its members end on the fold, the command running in it.
          fireEvent.click(header())
          expect(rowOf("pnpm test")).toHaveAttribute("data-status", "running")
          expect(footOf()).toHaveAttribute("data-marker", "foot")
          view.unmount()
          resetDisclosureStore()
        }
      })
    })
  })

  it("folded, shows the member that needs the user under its header", () => {
    renderUi(
      <Round parts={parts(LIVE, true, ["c3"])} completed={false} />,
      "c3"
    )
    const header = screen.getByRole("button", { name: /Running 3 commands/ })
    fireEvent.click(header)
    const group = rowOf("Running 3 commands")
    expect(group.getAttribute("data-status")).toBe("awaiting")
    const member = rowOf("rm -rf build")
    expect(member.getAttribute("data-status")).toBe("awaiting")
    expect(within(member).getByText("needs you")).toBeTruthy()
    expect(screen.queryByText("pnpm lint")).toBeNull()
  })
})

describe("an exploration group in a reply being written", () => {
  const live = (blocks: ContentBlock[]): MessageTurn => ({
    id: "t-explore",
    role: "assistant",
    timestamp: "2026-10-23T10:00:00Z",
    blocks,
  })
  // Two reads made together, the second still going.
  const READS: ContentBlock[] = [
    toolUse("r1", "Read", { file_path: "/r/a.ts" }),
    toolResult("r1", "a"),
    toolUse("r2", "Read", { file_path: "/r/b.ts" }),
  ]
  const header = () => screen.getByRole("button", { name: /^Exploring/ })
  // A member's row: the group's own carries its first member's key.
  const read = (id: string) =>
    document.querySelector<HTMLElement>(
      `li.activity-child[data-step-key="tool:${id}"]`
    )
  const footOf = () =>
    document.querySelector<HTMLElement>(
      '.activity-children > li[data-marker="working"], .activity-children > li[data-marker="foot"]'
    )

  it("shows the read under way under its folded header while it is the reply's last row", () => {
    renderUi(<Round parts={parts(live(READS), true)} completed={false} />)
    expect(header()).toHaveAttribute("aria-expanded", "false")
    expect(read("r2")).toHaveAttribute("data-status", "running")
    expect(read("r1")).toBeNull()
    fireEvent.click(header())
    expect(footOf()).toHaveAttribute("data-marker", "working")
  })

  it("keeps a read still going inside once the reply has moved past it", () => {
    // A command made alongside the reads follows them.
    renderUi(
      <Round
        parts={parts(
          live([...READS, toolUse("c9", "Bash", { command: "pnpm test" })]),
          true
        )}
        completed={false}
      />
    )
    expect(header()).toHaveAttribute("aria-expanded", "false")
    expect(read("r2")).toBeNull()
    // Opened, its members end on the fold: nothing joins it now.
    fireEvent.click(header())
    expect(read("r2")).toHaveAttribute("data-status", "running")
    expect(footOf()).toHaveAttribute("data-marker", "foot")
  })
})

describe("a failed command", () => {
  const live = (blocks: ContentBlock[]): MessageTurn => ({
    id: "t-failed",
    role: "assistant",
    timestamp: "2026-10-23T10:00:00Z",
    blocks,
  })
  const FAILED = [
    toolUse("c1", "Bash", { command: "pnpm lint" }),
    toolResult("c1", "ok"),
    toolUse("c2", "Bash", { command: "pnpm test" }),
    toolResult(
      "c2",
      "1 failed, 47 passed\n[terminal exited: exit code: 1]",
      true
    ),
  ]
  const READ = toolUse("r1", "Read", { file_path: "/r/a.ts" })
  const group = () =>
    screen.getByRole("button", { name: /^(Ran|Running) 2 commands/ })

  it("stays folded on its own while the reply is written, and once it is done", () => {
    const LONE = [
      toolUse("c1", "Bash", { command: "pnpm build" }),
      toolResult("c1", "Type error\n[terminal exited: exit code: 2]", true),
    ]
    const view = renderUi(
      <Round
        parts={parts(live([...LONE, READ]), true, ["r1"])}
        completed={false}
      />
    )
    const row = rowOf("pnpm build")
    expect(row.getAttribute("data-status")).toBe("failed")
    expect(within(row).getByText("exit 2")).toBeTruthy()
    expect(within(row).getByRole("button")).toHaveAttribute(
      "aria-expanded",
      "false"
    )
    expect(screen.queryByText(/Type error/)).toBeNull()
    view.rerender(withProviders(<Round parts={parts(turn([...LONE, READ]))} />))
    expect(within(rowOf("pnpm build")).getByRole("button")).toHaveAttribute(
      "aria-expanded",
      "false"
    )
    expect(screen.queryByText(/Type error/)).toBeNull()
  })

  it("keeps its group open no longer than a passing one while the reply is written", () => {
    const view = renderUi(
      <Round parts={parts(live(FAILED), true)} completed={false} />
    )
    // Still the reply's last row: listed, the failed member folded in it.
    expect(group()).toHaveAttribute("aria-expanded", "true")
    expect(within(rowOf("pnpm test")).getByText("exit 1")).toBeTruthy()
    expect(screen.queryByText(/1 failed, 47 passed/)).toBeNull()
    // The reply moves past it: it folds, failure and all.
    view.rerender(
      withProviders(
        <Round
          parts={parts(live([...FAILED, READ]), true, ["r1"])}
          completed={false}
        />
      )
    )
    expect(group()).toHaveAttribute("aria-expanded", "false")
    expect(screen.queryByText("pnpm test")).toBeNull()
    // Its header still counts the failure, in red.
    expect(within(group()).getByText("1 failed")).toHaveClass(
      "text-tone-danger"
    )
  })

  it("leaves its group folded in a reply read back from history", () => {
    renderUi(<Round parts={parts(turn(FAILED))} />)
    expect(group()).toHaveAttribute("aria-expanded", "false")
    expect(screen.queryByText("pnpm test")).toBeNull()
  })
})

describe("the foot of a live reply", () => {
  const LIVE = turn([
    toolUse("c1", "Bash", { command: "pnpm lint" }),
    toolResult("c1", "ok"),
    toolUse("r1", "Read", { file_path: "/r/a.ts" }),
  ])
  const footOf = () =>
    document.querySelector<HTMLElement>(".activity-timeline")!
      .lastElementChild as HTMLElement
  const working = () => document.querySelectorAll('[data-marker="working"]')

  it("turns at the foot of the steps the answer is being written beneath, the reply's one turning mark", () => {
    // The answer has started under the steps: the ring at their foot still
    // turns, and nothing turns under the answer.
    renderUi(<Round parts={parts(LIVE, true, ["r1"])} completed={false} />)
    // Still being written: a character at a time, each its own span.
    expect(
      screen.getByText(
        (_, element) =>
          element?.textContent === "Done." &&
          ![...element.children].some((child) => child.textContent === "Done.")
      )
    ).toBeTruthy()
    expect(footOf()).toHaveAttribute("data-marker", "working")
    expect(footOf().querySelector(".animate-spin")).toBeTruthy()
    expect(working()).toHaveLength(1)
  })

  it("rests on the fold row while the agent waits on the user", () => {
    renderUi(
      <Round parts={parts(LIVE, true, ["r1"])} completed={false} />,
      "r1"
    )
    expect(footOf()).toHaveAttribute("data-marker", "foot")
    console.log("FOOTTEXT", JSON.stringify(footOf().textContent))
    expect(
      within(footOf()).getByRole("button", { name: "Collapse 2 steps" })
    ).toBeTruthy()
    expect(working()).toHaveLength(0)
  })

  it("gives way to the turning mark under the reply once the steps fold", () => {
    renderUi(<Round parts={parts(LIVE, true, ["r1"])} completed={false} />)
    fireEvent.click(screen.getByRole("button", { name: "Working" }))
    expect(document.querySelector(".activity-timeline > li")).toBeNull()
    expect(working()).toHaveLength(1)
    expect(working()[0]!.querySelector(".animate-spin")).toBeTruthy()
    // Unfolded, the foot of the rail takes it back.
    fireEvent.click(screen.getByRole("button", { name: "Working" }))
    expect(footOf()).toHaveAttribute("data-marker", "working")
    expect(working()).toHaveLength(1)
  })
})

describe("a reply's rail while it is written", () => {
  const live = (blocks: ContentBlock[]): MessageTurn => ({
    id: "t-rail",
    role: "assistant",
    timestamp: "2026-10-23T10:00:00Z",
    blocks,
  })
  const C1 = [
    toolUse("c1", "Bash", { command: "pnpm lint" }),
    toolResult("c1", "ok"),
  ]
  const C2 = [
    toolUse("c2", "Bash", { command: "pnpm test" }),
    toolResult("c2", "ok"),
  ]
  const C3 = [toolUse("c3", "Bash", { command: "pnpm build" })]
  const READ = [toolUse("r1", "Read", { file_path: "/r/a.ts" })]
  const marked = (li: Element) =>
    [
      li.hasAttribute("data-rail-enter") && "enter",
      li.hasAttribute("data-rail-extend") && "extend",
    ]
      .filter(Boolean)
      .join(" ")

  it("grows down to each step and group member that joins it", async () => {
    const view = renderUi(
      <Round parts={parts(live([...C1, ...C2]), true)} completed={false} />
    )
    const list = view.container.querySelector(".activity-timeline")!
    const group = rowOf("Ran 2 commands")
    expect(marked(group)).toBe("")

    // A member joins the open group, above the foot its members end on: its
    // rail runs down to the foot, the member before keeps its own.
    view.rerender(
      withProviders(
        <Round
          parts={parts(live([...C1, ...C2, ...C3]), true, ["c3"])}
          completed={false}
        />
      )
    )
    await act(async () => {})
    expect(marked(rowOf("pnpm test"))).toBe("")
    expect(marked(rowOf("pnpm build"))).toBe("enter")
    expect(marked(rowOf("pnpm lint"))).toBe("")
    const members = rowOf("pnpm build").parentElement!
    expect(members.lastElementChild).toHaveAttribute("data-marker", "working")
    expect(rowOf("pnpm build").nextElementSibling).toBe(
      members.lastElementChild
    )

    // A step joins the reply, above the turning ring the rail runs down to.
    view.rerender(
      withProviders(
        <Round
          parts={parts(live([...C1, ...C2, ...C3, ...READ]), true, [
            "c3",
            "r1",
          ])}
          completed={false}
        />
      )
    )
    await act(async () => {})
    const read = rowOf(/a\.ts/)
    expect(marked(read)).toBe("enter")
    expect(marked(rowOf("Running 3 commands"))).toBe("")
    expect(list.lastElementChild).toHaveAttribute("data-marker", "working")
    expect(read.nextElementSibling).toBe(list.lastElementChild)

    // Done, the marks go: nothing replays in history.
    view.rerender(
      withProviders(
        <Round parts={parts(live([...C1, ...C2, ...C3, ...READ]))} />
      )
    )
    expect(view.container.querySelector("[data-rail-enter]")).toBeNull()
    expect(view.container.querySelector("[data-rail-extend]")).toBeNull()
  })
})

describe("file rows", () => {
  it("draw the file they read, write or edit a step lighter than their verb", () => {
    renderUi(
      <Round
        parts={parts(
          turn([
            toolUse("r1", "Read", { file_path: "/repo/src/read.ts" }),
            toolResult("r1", "1→export {}"),
            { type: "text", text: "Now the new file." },
            toolUse("w1", "Write", {
              file_path: "/repo/src/made.ts",
              content: "export const a = 1\n",
            }),
            toolResult("w1", "ok"),
            { type: "text", text: "And the edit." },
            toolUse("e1", "Edit", {
              file_path: "/repo/src/changed.ts",
              old_string: "a",
              new_string: "b",
            }),
            toolResult("e1", "ok"),
          ])
        )}
      />
    )

    expect(screen.getByText("/repo/src/read.ts")).toHaveClass(
      "text-activity-secondary"
    )
    for (const name of ["made.ts", "changed.ts"]) {
      const label = screen.getByText(name)
      expect(label).not.toHaveClass("text-foreground")
      expect(label.parentElement).toHaveClass("text-activity-secondary")
    }
  })
})

describe("command row", () => {
  it("draws its label and its command line in one ink, like a description", () => {
    renderUi(
      <Round
        parts={parts(
          turn([
            toolUse("c1", "Bash", { command: "pnpm lint" }),
            toolResult("c1", "ok"),
            { type: "text", text: "Now the tests." },
            toolUse("c2", "Bash", {
              command: "pnpm test",
              description: "Run the tests",
            }),
            toolResult("c2", "ok"),
          ])
        )}
      />
    )

    expect(screen.getByText("pnpm lint")).toHaveClass("text-activity-secondary")
    expect(screen.getByText("Run the tests")).toHaveClass(
      "text-activity-secondary"
    )
    for (const label of screen.getAllByText("Command")) {
      expect(label).toHaveClass("text-activity-secondary", "font-medium")
    }
  })
})

describe("skill and to-do rows", () => {
  it("set the label and what follows it in one ink", () => {
    renderUi(
      <Round
        parts={parts(
          turn([
            toolUse("s1", "Skill", { skill: "brainstorming" }),
            toolResult("s1", "ok"),
            { type: "text", text: "Now the plan." },
            toolUse("k1", "TaskCreate", { subject: "Fix the login form" }),
            toolResult("k1", "ok"),
          ])
        )}
      />
    )
    for (const text of [
      "Skill",
      "brainstorming",
      "Updated todos",
      "Fix the login form",
    ]) {
      expect(screen.getByText(text)).toHaveClass("text-activity-secondary")
    }
  })
})

describe("a command's exit", () => {
  const EXITS = [
    toolUse("n1", "Bash", { command: "rg -n source_bindings web/lib" }),
    toolResult("n1", "Exit code 1", true),
    { type: "text", text: "Nothing reads it there." },
    toolUse("n2", "Bash", { command: "pyhton x.py" }),
    toolResult(
      "n2",
      "Exit code 127\n(eval):1: command not found: pyhton",
      true
    ),
    { type: "text", text: "Wrong name." },
    toolUse("n3", "Bash", { command: "node crawl.js" }),
    toolResult("n3", "Exit code 137", true),
    { type: "text", text: "It was killed." },
  ] satisfies ContentBlock[]

  it("settles one that answered the command as done, saying the answer", () => {
    renderUi(<Round parts={parts(turn(EXITS))} />)
    const row = rowOf("rg -n source_bindings web/lib")
    expect(row).toHaveAttribute("data-status", "succeeded")
    const figure = within(row).getByText("no matches")
    expect(figure).toHaveAttribute("title", "exit 1")
    expect(figure).not.toHaveClass("text-tone-danger")
    // Not counted with the failures in the reply's header.
    expect(screen.getByText("2 failed")).toBeTruthy()
  })

  it("says a failure in the words its code stands for, the code on hover", () => {
    renderUi(<Round parts={parts(turn(EXITS))} />)
    const missing = rowOf("pyhton x.py")
    expect(missing).toHaveAttribute("data-status", "failed")
    const word = within(missing).getByText("command not found")
    expect(word).toHaveClass("text-tone-danger")
    expect(word).toHaveAttribute("title", "exit 127")
    expect(
      within(rowOf("node crawl.js")).getByText("killed · SIGKILL")
    ).toHaveAttribute("title", "exit 137")
  })
})

describe("a row's figure", () => {
  it("takes the room past the label, which does not grow", () => {
    renderUi(
      <Round
        parts={parts(
          turn([
            toolUse("e1", "Edit", {
              file_path: "/repo/src/changed.ts",
              old_string: "a",
              new_string: "b\nc",
            }),
            toolResult("e1", "ok"),
            { type: "text", text: "Then the lint." },
            toolUse("c1", "Bash", { command: "pnpm lint" }),
            toolResult("c1", "ok"),
          ])
        )}
      />
    )
    // The dashed line to the figure is the figure's own (globals.css), so
    // it is drawn only where there is a figure to reach.
    const edit = within(rowOf("changed.ts")).getAllByRole("button")[0]!
    const figure = edit.querySelector(".activity-figure")!
    expect(figure).toHaveClass("grow", "justify-end")
    expect(figure.previousElementSibling).not.toHaveClass("flex-1")
    // A command with nothing to count leaves its figure empty: no line.
    const command = within(rowOf("pnpm lint")).getAllByRole("button")[0]!
    expect(command.querySelector(".activity-figure")).toBeEmptyDOMElement()
  })
})
