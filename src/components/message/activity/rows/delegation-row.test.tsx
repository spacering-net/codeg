import { fireEvent, render, screen, within } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import type { DelegationBinding } from "@/contexts/delegation-context"
import type {
  AdaptedContentPart,
  AdaptedToolCallPart,
} from "@/lib/adapters/ai-elements-adapter"
import type { AssistantInfo } from "@/lib/types"
import {
  resetAssistantsStore,
  useAssistantsStore,
} from "@/stores/assistants-store"
import { mockTruncateLayout } from "@/test-layout"

/**
 * The delegation row: one `delegate_to_agent` call, start to finish — who it
 * went to, the task it was handed, how it stands, and the way into the
 * sub-agent's own conversation. Drawn through the reply renderer, the way the
 * thread draws it.
 */

vi.mock("@/hooks/use-delegated-sub-session", () => ({
  useDelegatedSubSession: vi.fn(),
}))

// The row reads the live binding from the delegation hook (mocked above) and
// whether the child is parked on a decision from the connections store.
let mockChildConnection: unknown = undefined

vi.mock("@/contexts/acp-connections-context", async () => {
  const actual = await vi.importActual<
    typeof import("@/contexts/acp-connections-context")
  >("@/contexts/acp-connections-context")
  return {
    ...actual,
    useConnectionStore: () => ({
      subscribeKey: () => () => {},
      getConnection: () => mockChildConnection,
      getConnectPending: () => undefined,
      getConnectError: () => undefined,
      getActiveKey: () => null,
      subscribeActiveKey: () => () => {},
    }),
  }
})

// The session drawer pulls in the whole transcript stack; a sentinel exposing
// which conversation it opened is all this file needs.
vi.mock("@/components/message/sub-agent-session-dialog", () => ({
  SubAgentSessionDialog: ({
    open,
    childConversationId,
  }: {
    open: boolean
    childConversationId: number
  }) =>
    open ? (
      <div
        data-testid="sub-agent-session-dialog"
        data-conversation-id={childConversationId}
      />
    ) : null,
}))

const { useDelegatedSubSession } =
  await import("@/hooks/use-delegated-sub-session")
const mockedHook = vi.mocked(useDelegatedSubSession)
const { ContentPartsRenderer } = await import("../../content-parts-renderer")

function bindingOf(overrides: Partial<DelegationBinding>): DelegationBinding {
  return {
    parentConnectionId: "p1",
    parentToolUseId: "pt-1",
    childConnectionId: "c1",
    childConversationId: 99,
    agentType: "codex",
    status: "running",
    task: null,
    taskId: null,
    assistantId: null,
    assistantName: null,
    ...overrides,
  }
}

function bind(binding: DelegationBinding | undefined) {
  mockedHook.mockReturnValue({
    binding,
    detail: null,
    loading: false,
    error: null,
  })
}

/** A child connection, optionally parked on a decision. */
function childConnWith(pending: Record<string, unknown>) {
  return {
    connectionId: "c1",
    contextKey: "c1",
    agentType: "codex",
    status: "connected",
    liveMessage: null,
    pendingPermission: null,
    pendingAskQuestion: null,
    pendingPlanApproval: null,
    isDelegationChild: true,
    ...pending,
  }
}

function delegation(
  props: {
    id?: string
    input?: string | null
    output?: string | null
    state?: Extract<AdaptedContentPart, { type: "tool-call" }>["state"]
    meta?: Record<string, unknown> | null
  } = {}
): AdaptedContentPart {
  return {
    type: "tool-call",
    toolCallId: props.id ?? "pt-1",
    toolName: "mcp__codeg-mcp__delegate_to_agent",
    input: props.input ?? null,
    state: props.state ?? "input-available",
    output: props.output ?? null,
    meta: props.meta ?? null,
  }
}

function renderRow(part: AdaptedContentPart) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <ContentPartsRenderer parts={[part]} role="assistant" />
    </NextIntlClientProvider>
  )
}

function row(): HTMLElement {
  const li = document.querySelector("li")
  if (!li) throw new Error("no row")
  return li as HTMLElement
}

/** The header button that opens the row's panel, when it has one. */
function toggle(): HTMLElement | null {
  return row().querySelector(":scope > button")
}

const openConversation = () =>
  screen.getByRole("button", { name: /Open conversation/ })

function expectOpens(conversationId: number) {
  fireEvent.click(openConversation())
  expect(screen.getByTestId("sub-agent-session-dialog")).toHaveAttribute(
    "data-conversation-id",
    String(conversationId)
  )
}

beforeEach(() => {
  resetAssistantsStore()
  mockChildConnection = undefined
  bind(undefined)
})

describe("delegation row: who and how it stands", () => {
  it("falls back to a plain row for a call with nothing to read", () => {
    renderRow(delegation())
    expect(
      screen.queryByRole("img", { name: /^Delegated task/ })
    ).not.toBeInTheDocument()
    expect(screen.queryByText("Open conversation")).not.toBeInTheDocument()
  })

  it("names the agent and says it is running while it works", () => {
    bind(bindingOf({ status: "running" }))
    renderRow(delegation())
    expect(within(row()).getAllByText("Codex").length).toBeGreaterThan(0)
    expect(within(row()).getByText("running")).toBeInTheDocument()
  })

  it("shows the task straight from the call's input", () => {
    renderRow(
      delegation({
        input: JSON.stringify({
          agent_type: "codex",
          task: "summarize the failing tests",
        }),
      })
    )
    expect(screen.getByText("summarize the failing tests")).toBeInTheDocument()
    expect(within(row()).getAllByText("Codex").length).toBeGreaterThan(0)
  })

  it("labels itself from the live binding when the input is empty (Cursor)", () => {
    // Cursor announces the call with `{}` and never re-sends the arguments.
    bind(
      bindingOf({
        agentType: "claude_code",
        task: "执行 pnpm build",
        taskId: "task-uuid-42",
      })
    )
    renderRow(delegation({ input: "{}" }))
    expect(screen.getByText("执行 pnpm build")).toBeInTheDocument()
    expect(screen.getByText("#task-uui")).toBeInTheDocument()
  })

  it("renders from the broker's meta alone after a reload (Cursor)", () => {
    renderRow(
      delegation({
        input: "{}",
        state: "output-available",
        meta: {
          "codeg.delegation": {
            status: "completed",
            child_conversation_id: 321,
            task_preview: "执行 pnpm build",
            task_id: "task-uuid-9",
          },
        },
      })
    )
    expect(screen.getByText("执行 pnpm build")).toBeInTheDocument()
    expectOpens(321)
  })

  it("says it is starting, with no way in yet, before the child binds", () => {
    renderRow(
      delegation({
        input: JSON.stringify({ agent_type: "codex", task: "set things up" }),
      })
    )
    expect(within(row()).getByText("starting")).toBeInTheDocument()
    expect(screen.queryByText("running")).not.toBeInTheDocument()
    expect(
      screen.queryByRole("button", { name: /Open conversation/ })
    ).not.toBeInTheDocument()
    expect(screen.getByText("set things up")).toBeInTheDocument()
  })

  it("opens the child's conversation, not the parent's", () => {
    bind(bindingOf({ status: "running" }))
    renderRow(delegation())
    expect(
      screen.queryByTestId("sub-agent-session-dialog")
    ).not.toBeInTheDocument()
    expectOpens(99)
  })

  it("offers no way in while the child id is unknown", () => {
    renderRow(
      delegation({
        input: JSON.stringify({ agent_type: "codex", task: "no child id" }),
      })
    )
    expect(
      screen.queryByRole("button", { name: /Open conversation/ })
    ).not.toBeInTheDocument()
  })

  it("finds the child in the broker's output (synthetic call id)", () => {
    // The broker minted the call id, so no binding and no meta — but its
    // output names the child conversation.
    renderRow(
      delegation({
        id: "delegation-abc",
        input: JSON.stringify({ agent_type: "codex", task: "run the audit" }),
        output: JSON.stringify({
          kind: "ok",
          text: "Audit complete.",
          child_conversation_id: 1234,
        }),
        state: "output-available",
      })
    )
    expectOpens(1234)
  })

  it("finds the child in a wrapped MCP CallToolResult", () => {
    const structured = {
      kind: "ok",
      text: "Shipped.",
      child_conversation_id: 4321,
      turn_count: 1,
    }
    renderRow(
      delegation({
        id: "delegation-xyz",
        input: JSON.stringify({ agent_type: "codex", task: "ship it" }),
        output: JSON.stringify({
          content: [{ type: "text", text: structured.text }],
          isError: false,
          structuredContent: structured,
        }),
        state: "output-available",
      })
    )
    expectOpens(4321)
  })

  it("names the failure by its code", () => {
    bind(bindingOf({ status: "err", errorCode: "timeout" }))
    renderRow(delegation())
    expect(within(row()).getByText("timeout")).toBeInTheDocument()
    expect(row()).toHaveAttribute("data-status", "failed")
  })

  it("says it is done once the child reports back", () => {
    bind(bindingOf({ status: "ok" }))
    renderRow(
      delegation({
        output: JSON.stringify({
          kind: "ok",
          text: "All good, the build passed.",
          child_conversation_id: 99,
        }),
        state: "output-available",
      })
    )
    expect(within(row()).getByText("done")).toBeInTheDocument()
    expect(openConversation()).toBeInTheDocument()
  })

  it("names the refusal of a call no delegation ever started for", () => {
    // Refused before anything ran: the report is the only place the code is.
    renderRow(
      delegation({
        input: JSON.stringify({ assistant_id: 3, task: "review" }),
        output: JSON.stringify({
          status: "failed",
          error_code: "assistant_not_found",
          message: "No assistant has id 3.",
          assistant_id: 3,
        }),
        state: "output-available",
      })
    )
    expect(screen.getByText("assistant not found")).toBeInTheDocument()
  })
})

describe("delegation row: while it works", () => {
  const skeleton = () => row().querySelector('[data-slot="skeleton"]')

  it("holds the line under its title with a skeleton until it has something to show", () => {
    bind(bindingOf({ status: "running", task: "Run the checks." }))
    renderRow(delegation())
    expect(skeleton()).not.toBeNull()
    // Beside the way into its conversation, which it already has.
    expect(openConversation()).toBeInTheDocument()
  })

  it("holds the place while it starts, before there is a way in", () => {
    renderRow(
      delegation({
        input: JSON.stringify({ agent_type: "codex", task: "set things up" }),
      })
    )
    expect(within(row()).getByText("starting")).toBeInTheDocument()
    expect(skeleton()).not.toBeNull()
  })

  it("draws no skeleton once it is done", () => {
    bind(bindingOf({ status: "ok", task: "Run the checks." }))
    renderRow(delegation({ state: "output-available" }))
    expect(skeleton()).toBeNull()
  })

  it("draws no skeleton while the child waits on the user", () => {
    // Nothing is loading: the sub-agent is stopped until the user answers.
    bind(bindingOf({ status: "running", task: "Run the checks." }))
    mockChildConnection = childConnWith({
      pendingPermission: {
        request_id: "r1",
        tool_call: { title: "Run bash", kind: "execute" },
        options: [{ id: "approve", label: "Approve", kind: "allow_once" }],
      },
    })
    renderRow(delegation())
    expect(within(row()).getByText("awaiting approval")).toBeInTheDocument()
    expect(skeleton()).toBeNull()
  })
})

describe("delegation row: a child waiting on the user", () => {
  // Parked is parked, whatever the decision: the backend's `blocked_on` and
  // the status checks count all three, so the row must too.
  it.each([
    {
      kind: "permission",
      pending: {
        pendingPermission: {
          request_id: "req-9",
          tool_call: { title: "Run bash", kind: "execute" },
          options: [{ id: "approve", label: "Approve", kind: "allow_once" }],
        },
      },
    },
    {
      kind: "question",
      pending: {
        pendingAskQuestion: {
          question_id: "q-1",
          questions: [
            {
              id: "q",
              question: "Which DB?",
              header: "DB",
              multi_select: false,
              options: [],
            },
          ],
          created_at: "2026-10-18T00:00:00Z",
        },
      },
    },
    {
      kind: "plan approval",
      pending: {
        pendingPlanApproval: {
          approval_id: "plan-1",
          tool_call_id: "tc-1",
          plan_markdown: "1. migrate",
          created_at: "2026-10-18T00:00:00Z",
        },
      },
    },
  ])(
    "says it is waiting when the child is parked on a $kind",
    ({ pending }) => {
      bind(bindingOf({ status: "running", task: "migrate" }))
      mockChildConnection = childConnWith(pending)
      renderRow(delegation())
      expect(within(row()).getByText("awaiting approval")).toBeInTheDocument()
      expect(screen.queryByText("running")).not.toBeInTheDocument()
      expect(row()).toHaveAttribute("data-status", "awaiting")
      // Still the way in, where the decision is answered.
      expect(openConversation()).toBeInTheDocument()
    }
  )
})

describe("delegation row: reading the task out of wrapped input", () => {
  it.each<{ shape: string; input: string; expectedTask: string }>([
    {
      shape: "{name, arguments}",
      input: JSON.stringify({
        name: "delegate_to_agent",
        arguments: { agent_type: "codex", task: "wrapped via arguments" },
      }),
      expectedTask: "wrapped via arguments",
    },
    {
      shape: "{params: {input: {...}}}",
      input: JSON.stringify({
        params: {
          input: { agent_type: "codex", task: "wrapped via params.input" },
        },
      }),
      expectedTask: "wrapped via params.input",
    },
    {
      shape: "{_meta, agent_type, task}",
      input: JSON.stringify({
        _meta: { claudeCode: { toolName: "delegate_to_agent" } },
        agent_type: "codex",
        task: "direct fields next to _meta",
      }),
      expectedTask: "direct fields next to _meta",
    },
    {
      shape: "double-encoded JSON string",
      input: JSON.stringify(
        JSON.stringify({ agent_type: "codex", task: "double-encoded task" })
      ),
      expectedTask: "double-encoded task",
    },
  ])("finds it in the $shape wrapper", ({ input, expectedTask }) => {
    renderRow(delegation({ input }))
    expect(screen.getByText(expectedTask)).toBeInTheDocument()
  })
})

// Async delegation: the call returns a running *ack*; the result comes later.
describe("delegation row: the running acknowledgement", () => {
  const ackOutput = JSON.stringify({
    content: [{ type: "text", text: "Delegated; running in background" }],
    isError: false,
    structuredContent: {
      task_id: "t1",
      status: "running",
      child_conversation_id: 99,
    },
  })
  const input = JSON.stringify({ agent_type: "codex", task: "do x" })

  it("reads a running ack as running, never as done", () => {
    renderRow(
      delegation({ input, output: ackOutput, state: "output-available" })
    )
    expect(within(row()).getByText("running")).toBeInTheDocument()
    expect(screen.queryByText("done")).not.toBeInTheDocument()
  })

  it("reads an ack inlined in content[0].text, with no structuredContent", () => {
    renderRow(
      delegation({
        id: "delegation-inline",
        input,
        output: JSON.stringify({
          content: [
            {
              type: "text",
              text: JSON.stringify({
                task_id: "t1",
                status: "running",
                child_conversation_id: 4242,
              }),
            },
          ],
          isError: false,
        }),
        state: "output-available",
      })
    )
    expect(within(row()).getByText("running")).toBeInTheDocument()
    expectOpens(4242)
  })

  it("names the broker's task id after the agent", () => {
    renderRow(
      delegation({ input, output: ackOutput, state: "output-available" })
    )
    expect(screen.getByText("#t1")).toBeInTheDocument()
  })

  it("finds the task id in the live ack's message text", () => {
    renderRow(
      delegation({
        input,
        output:
          "Delegated; the sub-agent is running in the background. " +
          "task_id=abcdef12-3456-7890. Call get_delegation_status with this " +
          "id in the task_ids array.",
        state: "output-available",
      })
    )
    expect(screen.getByText("#abcdef12")).toBeInTheDocument()
  })

  it("reads a Codex-wrapped ack (Wall time prefix, no structuredContent)", () => {
    const report = JSON.stringify({
      status: "running",
      child_conversation_id: 909,
    })
    renderRow(
      delegation({
        id: "delegation-codex",
        input,
        output: JSON.stringify({
          content: [
            { type: "text", text: `Wall time: 1 seconds\nOutput:\n${report}_` },
          ],
          isError: false,
        }),
        state: "output-available",
      })
    )
    expect(within(row()).getByText("running")).toBeInTheDocument()
    expectOpens(909)
  })

  it("reads how it ended off a later check when nothing live or stored says", () => {
    // Reopened with the child's record gone: no binding, no meta — only the
    // ack and the agent's own check on the task.
    const check = (report: Record<string, unknown>): AdaptedContentPart => ({
      type: "delegation-status-group",
      polls: [
        {
          type: "tool-call",
          toolCallId: "poll-1",
          toolName: "mcp__codeg-mcp__get_delegation_status",
          input: JSON.stringify({ task_ids: ["t1"] }),
          state: "output-available",
          output: JSON.stringify({ task_id: "t1", ...report }),
        },
      ],
    })
    const call = delegation({
      input,
      output: ackOutput,
      state: "output-available",
    })
    const view = render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <ContentPartsRenderer
          parts={[
            call,
            check({ status: "completed", text: "All four checks passed." }),
          ]}
          role="assistant"
        />
      </NextIntlClientProvider>
    )
    expect(within(row()).getByText(/^done/)).toBeInTheDocument()
    expect(within(row()).queryByText("running")).toBeNull()
    expect(within(row()).getByText("All four checks passed.")).toBeTruthy()
    view.unmount()

    render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <ContentPartsRenderer
          parts={[call, check({ status: "failed", error_code: "timeout" })]}
          role="assistant"
        />
      </NextIntlClientProvider>
    )
    expect(within(row()).queryByText("running")).toBeNull()
    expect(row().getAttribute("data-status")).toBe("failed")
  })
})

describe("delegation row: an assistant's delegation", () => {
  const reviewer = (patch: Partial<AssistantInfo> = {}): AssistantInfo => ({
    id: 3,
    uid: "u-3",
    name: "Reviewer",
    description: "",
    avatar: { kind: "emoji", emoji: "🦉", color: "teal" },
    agent_type: "codex",
    agent_options: { config_values: {} },
    label_snapshot: { agent: "Codex", mode: null, options: [] },
    instructions: "",
    enabled: true,
    sort_order: 1,
    revision: 1,
    created_at: "2026-10-16T00:00:00Z",
    updated_at: "2026-10-16T00:00:00Z",
    deleted_at: null,
    ...patch,
  })

  it("shows the assistant by its current name and avatar, then its agent", () => {
    useAssistantsStore.getState().merge([reviewer()])
    bind(
      bindingOf({
        assistantId: 3,
        assistantName: "Old name",
        agentType: "codex",
      })
    )
    renderRow(delegation())
    expect(row()).toHaveTextContent("Reviewer · Codex")
    expect(row()).not.toHaveTextContent("Old name")
    expect(row()).toHaveTextContent("🦉")
  })

  it("falls back to the name the delegation carried, then to the id", () => {
    bind(bindingOf({ assistantId: 3, assistantName: "Planner" }))
    const { unmount } = renderRow(delegation())
    expect(row()).toHaveTextContent("Planner · Codex")
    unmount()

    bind(undefined)
    renderRow(
      delegation({
        input: "{}",
        state: "output-available",
        meta: {
          "codeg.delegation": {
            status: "completed",
            agent_type: "codex",
            assistant_id: 7,
            child_conversation_id: 70,
          },
        },
      })
    )
    expect(row()).toHaveTextContent("Assistant #7 · Codex")
  })

  it("marks an assistant that has been deleted", () => {
    useAssistantsStore
      .getState()
      .merge([reviewer({ deleted_at: "2026-10-16T01:00:00Z", revision: 2 })])
    bind(bindingOf({ assistantId: 3, assistantName: "Reviewer" }))
    renderRow(delegation())
    expect(row()).toHaveTextContent("Reviewer (deleted) · Codex")
  })

  it("never names the agent the call claims for an assistant", () => {
    useAssistantsStore.getState().merge([reviewer()])
    // The host filled in an agent_type; the backend ignores it — the
    // assistant decides which agent runs.
    const input = JSON.stringify({
      assistant_id: 3,
      agent_type: "gemini",
      task: "review the diff",
    })
    const { unmount } = renderRow(delegation({ input }))
    expect(row()).toHaveTextContent("Reviewer")
    expect(row()).not.toHaveTextContent("Gemini")
    expect(row()).not.toHaveTextContent("·")
    unmount()

    // The broker's ack is the first evidence of the real agent.
    renderRow(
      delegation({
        input,
        output: JSON.stringify({
          task_id: "task-1",
          status: "running",
          agent_type: "codex",
          assistant_id: 3,
          assistant_name: "Reviewer",
          child_conversation_id: 9,
        }),
        state: "output-available",
      })
    )
    expect(row()).toHaveTextContent("Reviewer · Codex")
    expect(row()).not.toHaveTextContent("Gemini")
  })

  it("shows an agent's delegation with no assistant in it", () => {
    bind(bindingOf({ agentType: "codex" }))
    renderRow(delegation())
    expect(row()).toHaveTextContent("Codex")
    expect(row()).not.toHaveTextContent("·")
    expect(row().querySelector('[data-slot="assistant-avatar"]')).toBeNull()
  })
})

describe("delegation row: its checks", () => {
  it("reads its step bar and result from the newest report on its task", () => {
    // Each check is a row of its own, the one right after the hand-over and
    // the one after a line of prose alike — and the newest says the sub-agent
    // finished, and how.
    const TASK = "a1b2c3d4"
    const check = (
      id: string,
      report: Record<string, unknown>
    ): AdaptedToolCallPart => ({
      type: "tool-call",
      toolCallId: id,
      toolName: "mcp__codeg-mcp__get_delegation_status",
      input: JSON.stringify({ task_ids: [TASK], wait_ms: 3000 }),
      output: JSON.stringify({ task_id: TASK, ...report }),
      state: "output-available",
    })
    bind(
      bindingOf({ status: "ok", task: "Run the four checks.", taskId: TASK })
    )
    render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <ContentPartsRenderer
          parts={[
            delegation({
              state: "output-available",
              output: JSON.stringify({ task_id: TASK, status: "started" }),
            }),
            {
              type: "delegation-status-group",
              polls: [
                check("c1", {
                  status: "running",
                  progress: { steps: 1, marks: ["ok"] },
                }),
              ],
            },
            { type: "text", text: "Still waiting on the sub-agent." },
            {
              type: "delegation-status-group",
              polls: [
                check("c2", {
                  status: "completed",
                  text: "Checked all four; one path is missing.",
                  progress: { steps: 4, marks: ["ok", "ok", "failed", "ok"] },
                }),
              ],
            },
          ]}
          role="assistant"
        />
      </NextIntlClientProvider>
    )
    const delegationRow = row()
    expect(document.querySelectorAll("li")).toHaveLength(4)
    expect(delegationRow).toHaveTextContent("4 steps")
    expect(
      within(delegationRow).getByRole("img", { name: /4 steps/ })
    ).toHaveAccessibleName("4 steps, 1 failed")
    expect(delegationRow).toHaveTextContent(
      "Checked all four; one path is missing."
    )
  })
})

describe("delegation row: the task it was handed", () => {
  // Longer than the title line shows: line breaks included.
  const TASK =
    "Audit the sidebar width logic.\n\n1. Read sidebar-context.tsx\n2. Compare the Windows and macOS minimums"

  // jsdom lays nothing out, so every node reads 0 wide — a task that fits.
  // Wider content than box makes the title line actually cut it.
  let restoreMetrics: (() => void) | null = null
  function clipTheTask() {
    restoreMetrics = mockTruncateLayout(600, 200)
  }
  afterEach(() => {
    restoreMetrics?.()
    restoreMetrics = null
  })

  it("says the task on its title line, as one line", () => {
    renderRow(
      delegation({ input: JSON.stringify({ agent_type: "codex", task: TASK }) })
    )
    const header = row().querySelector(":scope > div")!
    const line = within(header as HTMLElement).getByText(
      "Audit the sidebar width logic. 1. Read sidebar-context.tsx 2. Compare the Windows and macOS minimums"
    )
    expect(line).toHaveClass("truncate")
    expect(line).toHaveAttribute("dir", "auto")
    // It takes only the room the rest of the line leaves, and nothing runs
    // past the line's end.
    expect(line).toHaveClass("flex-1")
    expect(line.parentElement).toHaveClass("overflow-hidden")
  })

  it("has nothing to open when the task fits on its title line", () => {
    // The panel would only say it again.
    renderRow(
      delegation({
        input: JSON.stringify({ agent_type: "codex", task: "Run the checks." }),
      })
    )
    expect(toggle()).toBeNull()
    expect(screen.getAllByText("Run the checks.")).toHaveLength(1)
  })

  it("opens to the whole task, verbatim, and folds it back", () => {
    clipTheTask()
    renderRow(
      delegation({ input: JSON.stringify({ agent_type: "codex", task: TASK }) })
    )
    const button = toggle()!
    expect(button).toHaveAttribute("aria-expanded", "false")
    fireEvent.click(button)
    expect(button).toHaveAttribute("aria-expanded", "true")
    const panel = document.getElementById(
      button.getAttribute("aria-controls")!
    )!
    // All of it, line breaks included, nothing rendered as Markdown — the way
    // the sub-agent's own transcript shows its kickoff — in its own direction.
    const text = within(panel).getByText(/Audit the sidebar width logic\./)
    expect(text.textContent).toBe(TASK)
    expect(text).toHaveClass("whitespace-pre-wrap")
    expect(text).toHaveAttribute("dir", "auto")
    fireEvent.click(button)
    expect(button).toHaveAttribute("aria-expanded", "false")
  })

  it("keeps opening the task and opening the conversation apart", () => {
    clipTheTask()
    bind(bindingOf({ status: "running", task: TASK }))
    renderRow(delegation())
    const button = toggle()!
    // Siblings, never nested: each does one thing.
    expect(button).not.toContainElement(openConversation())
    fireEvent.click(openConversation())
    expect(screen.getByTestId("sub-agent-session-dialog")).toBeInTheDocument()
    expect(button).toHaveAttribute("aria-expanded", "false")
  })

  it("has nothing to open when no task is known", () => {
    bind(bindingOf({ status: "running", task: null }))
    renderRow(delegation())
    expect(toggle()).toBeNull()
    expect(screen.getAllByRole("button")).toEqual([openConversation()])
  })

  it("treats a blank task as no task", () => {
    renderRow(
      delegation({
        input: JSON.stringify({ agent_type: "codex", task: "  \n " }),
      })
    )
    expect(toggle()).toBeNull()
  })
})
