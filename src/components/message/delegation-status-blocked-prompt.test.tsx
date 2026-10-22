import { type ReactElement } from "react"
import { act, fireEvent, render, screen, within } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { DelegationStatusCard } from "./delegation-status-card"
import { DelegationStatusGroupCard } from "./delegation-status-group-card"
import { DelegationStatusIndexProvider } from "./delegation-status-index-context"
import enMessages from "@/i18n/messages/en.json"
import type { DelegationBinding } from "@/contexts/delegation-context"
import type {
  AdaptedContentPart,
  AdaptedToolCallPart,
} from "@/lib/adapters/ai-elements-adapter"
import {
  buildDelegationStatusIndex,
  collectDelegationStatusTasks,
} from "@/lib/delegation-status-index"

// A `get_delegation_status` row whose sub-agent is parked on the user must let
// the user answer right there (#973): the card used to badge "awaiting
// approval" and offer nothing to approve with — the prompt only lived in the
// sub-agent's own session drawer, opened from a different card.

vi.mock("@/components/ai-elements/message", () => ({
  MessageResponse: ({ children }: { children: string }) => (
    <div data-testid="markdown-response">{children}</div>
  ),
}))

// The live binding lookup. A real `DelegationProvider` is mounted once in the
// workspace layout; here the map is the whole provider.
const bindings = new Map<string, DelegationBinding>()
const delegation = {
  findByParentToolUseId: () => undefined,
  findByChildConversationId: () => undefined,
  findByTaskId: (taskId: string) => bindings.get(taskId),
}
vi.mock("@/contexts/delegation-context", async () => {
  const actual = await vi.importActual<
    typeof import("@/contexts/delegation-context")
  >("@/contexts/delegation-context")
  return {
    ...actual,
    useDelegation: () => delegation,
    useOptionalDelegation: () => delegation,
  }
})

// The connections store: child connection states by id, plus a notifier so a
// test can play a STATE update from the reducer (the prompt being answered).
const connections = new Map<string, unknown>()
let storeCallbacks: Array<() => void> = []
function notifyStore() {
  for (const cb of storeCallbacks) cb()
}
const store = {
  subscribeKey: (_key: string, cb: () => void) => {
    storeCallbacks.push(cb)
    return () => {
      storeCallbacks = storeCallbacks.filter((c) => c !== cb)
    }
  },
  getConnection: (key: string) => connections.get(key),
  getConnectPending: () => undefined,
  getConnectError: () => undefined,
  getActiveKey: () => null,
  subscribeActiveKey: () => () => {},
}
const respondPermission = vi.fn()
const answerQuestion = vi.fn()
const answerPlanApproval = vi.fn()
vi.mock("@/contexts/acp-connections-context", async () => {
  const actual = await vi.importActual<
    typeof import("@/contexts/acp-connections-context")
  >("@/contexts/acp-connections-context")
  return {
    ...actual,
    useConnectionStore: () => store,
    useOptionalConnectionStore: () => store,
    useAcpActions: () => ({
      respondPermission,
      answerQuestion,
      answerPlanApproval,
    }),
  }
})

// The three prompt cards have their own dependency graphs and suites; stub
// each to a button that answers through the handler it was given.
vi.mock("@/components/chat/permission-dialog", () => ({
  PermissionDialog: ({
    permission,
    onRespond,
  }: {
    permission: { request_id: string } | null
    onRespond: (requestId: string, optionId: string) => void
  }) =>
    permission ? (
      <button
        data-testid="permission-dialog"
        onClick={() => onRespond(permission.request_id, "approve")}
      >
        permission {permission.request_id}
      </button>
    ) : null,
}))
vi.mock("@/components/chat/ask-question-card", () => ({
  AskQuestionCard: ({
    question,
    onAnswer,
  }: {
    question: { question_id: string }
    onAnswer: (questionId: string, answer: unknown) => void
  }) => (
    <>
      <button
        data-testid="ask-question-card"
        onClick={() => onAnswer(question.question_id, { answers: [] })}
      >
        question {question.question_id}
      </button>
      {/* Uncontrolled, like the real card's unsent answer: it survives only
          as long as this instance does. */}
      <input data-testid="ask-question-draft" aria-label="answer" />
    </>
  ),
}))
vi.mock("@/components/chat/plan-approval-card", () => ({
  PlanApprovalCard: ({
    approval,
    onAnswer,
  }: {
    approval: { approval_id: string }
    onAnswer: (approvalId: string, answer: unknown) => void
  }) => (
    <button
      data-testid="plan-approval-card"
      onClick={() => onAnswer(approval.approval_id, { decision: "approve" })}
    >
      plan {approval.approval_id}
    </button>
  ),
}))

const TASK = "7bd4d6ff-0000-4000-8000-000000000001"
const CHILD = "child-conn-1"

function bindingFor(
  taskId: string,
  childConnectionId: string,
  status: DelegationBinding["status"] = "running"
) {
  bindings.set(taskId, {
    parentConnectionId: "parent-conn",
    parentToolUseId: `delegate-${taskId}`,
    childConnectionId,
    childConversationId: 42,
    agentType: "codex",
    status,
    task: "run the migration",
    taskId,
    assistantId: null,
    assistantName: null,
  })
}

const PERMISSION = {
  request_id: "req-1",
  tool_call: { title: "Run bash", kind: "execute" },
  options: [{ option_id: "approve", name: "Allow", kind: "allow_once" }],
}

function childState(
  pending: {
    pendingPermission?: unknown
    pendingAskQuestion?: unknown
    pendingPlanApproval?: unknown
  } = {}
) {
  return {
    connectionId: CHILD,
    contextKey: CHILD,
    agentType: "codex",
    status: "prompting",
    isDelegationChild: true,
    pendingPermission: pending.pendingPermission ?? null,
    pendingAskQuestion: pending.pendingAskQuestion ?? null,
    pendingPlanApproval: pending.pendingPlanApproval ?? null,
  }
}

const BLOCKED_TEXT =
  "Running.\nAwaiting your decision: a tool permission\nThe sub-agent is " +
  "parked until a human answers in Codeg — it is not making progress. Tell " +
  "the user, then wait again."

/** A poll the backend answered "running, parked on the user" — the shape a
 *  host that keeps `structuredContent` persists. */
function blockedPoll(taskId: string, id = "poll-blocked"): AdaptedToolCallPart {
  const report = {
    task_id: taskId,
    status: "running",
    child_conversation_id: 42,
    agent_type: "codex",
    message: BLOCKED_TEXT,
    blocked_on: { kind: "permission", request_id: "req-1" },
  }
  return {
    type: "tool-call",
    toolCallId: id,
    toolName: "get_delegation_status",
    input: JSON.stringify({ task_ids: [taskId] }),
    state: "output-available",
    output: JSON.stringify({
      content: [{ type: "text", text: JSON.stringify({ tasks: [report] }) }],
      isError: false,
      structuredContent: { tasks: [report] },
    }),
  }
}

function renderCard(polls: AdaptedToolCallPart[]) {
  const ui = (p: AdaptedToolCallPart[]): ReactElement => (
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <DelegationStatusGroupCard polls={p} />
    </NextIntlClientProvider>
  )
  const result = render(ui(polls))
  return {
    ...result,
    rerenderPolls: (p: AdaptedToolCallPart[]) => result.rerender(ui(p)),
  }
}

describe("DelegationStatusGroupCard — answering a parked sub-agent (#973)", () => {
  beforeEach(() => {
    bindings.clear()
    connections.clear()
    storeCallbacks = []
    respondPermission.mockReset()
    answerQuestion.mockReset()
    answerPlanApproval.mockReset()
  })

  it("shows the sub-agent's permission prompt in the row, open without a click, and answers through the child", () => {
    bindingFor(TASK, CHILD)
    connections.set(CHILD, childState({ pendingPermission: PERMISSION }))
    renderCard([blockedPoll(TASK)])

    expect(screen.getByText("awaiting approval")).toBeInTheDocument()
    expect(screen.getByRole("button", { expanded: true })).toBeInTheDocument()
    const prompt = screen.getByTestId("permission-dialog")
    fireEvent.click(prompt)
    expect(respondPermission).toHaveBeenCalledWith(CHILD, "req-1", "approve")
  })

  it("finds the sub-agent on a content-only host, which keeps the report as text", () => {
    // Claude Code keeps only `content[*].text` — no `structuredContent` — so
    // the `{tasks:[…]}` report survives as JSON text.
    bindingFor(TASK, CHILD)
    connections.set(CHILD, childState({ pendingPermission: PERMISSION }))
    const report = {
      task_id: TASK,
      status: "running",
      message: BLOCKED_TEXT,
      blocked_on: { kind: "permission", request_id: "req-1" },
    }
    renderCard([
      {
        type: "tool-call",
        toolCallId: "poll-content-only",
        toolName: "get_delegation_status",
        input: JSON.stringify({ task_ids: [TASK] }),
        state: "output-available",
        output: JSON.stringify({
          content: [
            { type: "text", text: JSON.stringify({ tasks: [report] }) },
          ],
          isError: false,
        }),
      },
    ])

    fireEvent.click(screen.getByTestId("permission-dialog"))
    expect(respondPermission).toHaveBeenCalledWith(CHILD, "req-1", "approve")
  })

  it("finds the sub-agent from a historical poll that is bare text", () => {
    // Older transcripts keep just the backend's blocked note, and the task id
    // is the call's own argument.
    bindingFor(TASK, CHILD)
    connections.set(CHILD, childState({ pendingPermission: PERMISSION }))
    renderCard([
      {
        type: "tool-call",
        toolCallId: "poll-text",
        toolName: "get_delegation_status",
        input: JSON.stringify({ task_ids: [TASK] }),
        state: "output-available",
        output: BLOCKED_TEXT,
      },
    ])

    fireEvent.click(screen.getByTestId("permission-dialog"))
    expect(respondPermission).toHaveBeenCalledWith(CHILD, "req-1", "approve")
  })

  it("carries a question or a plan approval the same way", () => {
    bindingFor(TASK, CHILD)
    connections.set(
      CHILD,
      childState({
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
        pendingPlanApproval: {
          approval_id: "plan-1",
          tool_call_id: "tc-1",
          plan_markdown: "1. migrate",
          created_at: "2026-10-18T00:00:00Z",
        },
      })
    )
    renderCard([blockedPoll(TASK)])

    expect(screen.getByText("awaiting approval")).toBeInTheDocument()
    fireEvent.click(screen.getByTestId("ask-question-card"))
    expect(answerQuestion).toHaveBeenCalledWith(CHILD, "q-1", { answers: [] })
    fireEvent.click(screen.getByTestId("plan-approval-card"))
    expect(answerPlanApproval).toHaveBeenCalledWith(CHILD, "plan-1", {
      decision: "approve",
    })
  })

  it("never reaches a sub-agent the backend did not vouch for", () => {
    // The model polled an id that is another conversation's — a binding for it
    // exists in this workspace and is parked — but the backend answered
    // `unknown`. Nothing of that sub-agent may surface here.
    bindingFor(TASK, CHILD)
    connections.set(CHILD, childState({ pendingPermission: PERMISSION }))
    const unknown = {
      task_id: TASK,
      status: "unknown",
      message:
        "Unknown task id — it never existed, isn't owned by this session.",
    }
    renderCard([
      {
        type: "tool-call",
        toolCallId: "poll-foreign",
        toolName: "get_delegation_status",
        input: JSON.stringify({ task_ids: [TASK] }),
        state: "output-available",
        output: JSON.stringify({
          content: [{ type: "text", text: unknown.message }],
          isError: false,
          structuredContent: { tasks: [unknown] },
        }),
      },
    ])

    expect(screen.queryByTestId("permission-dialog")).not.toBeInTheDocument()
    expect(screen.queryByText("awaiting approval")).not.toBeInTheDocument()
  })

  it("does not trust an id the backend has not answered for yet", () => {
    // First poll, still in flight: the id is only the model's argument so far.
    bindingFor(TASK, CHILD)
    connections.set(CHILD, childState({ pendingPermission: PERMISSION }))
    renderCard([
      {
        type: "tool-call",
        toolCallId: "poll-inflight",
        toolName: "get_delegation_status",
        input: JSON.stringify({ task_ids: [TASK] }),
        state: "input-available",
        output: null,
      },
    ])

    expect(screen.queryByTestId("permission-dialog")).not.toBeInTheDocument()
    expect(screen.queryByText("awaiting approval")).not.toBeInTheDocument()
  })

  it("keeps the prompt while the agent is already waiting again on the same task", () => {
    // The re-poll is in flight (it would spin), but the sub-agent is still
    // parked: the row says so, and the prompt stays.
    bindingFor(TASK, CHILD)
    connections.set(CHILD, childState({ pendingPermission: PERMISSION }))
    const { container } = renderCard([
      blockedPoll(TASK),
      {
        type: "tool-call",
        toolCallId: "poll-again",
        toolName: "get_delegation_status",
        input: JSON.stringify({ task_ids: [TASK] }),
        state: "input-available",
        output: null,
      },
    ])

    expect(screen.getByText("awaiting approval")).toBeInTheDocument()
    expect(container.querySelector(".animate-spin")).not.toBeInTheDocument()
    expect(screen.getByTestId("permission-dialog")).toBeInTheDocument()
  })

  it("drops the prompt and the stale 'awaiting approval' once it is answered", () => {
    bindingFor(TASK, CHILD)
    connections.set(CHILD, childState({ pendingPermission: PERMISSION }))
    renderCard([blockedPoll(TASK)])
    expect(screen.getByTestId("permission-dialog")).toBeInTheDocument()

    // Answered (here, or in the sub-agent's own drawer): the store clears it.
    act(() => {
      connections.set(CHILD, childState())
      notifyStore()
    })

    expect(screen.queryByTestId("permission-dialog")).not.toBeInTheDocument()
    expect(screen.queryByText("awaiting approval")).not.toBeInTheDocument()
    expect(screen.getByText("checked")).toBeInTheDocument()
    // It opened only for the decision, so it closes with it.
    expect(screen.getByRole("button", { expanded: false })).toBeInTheDocument()
  })

  it("keeps the poll's word when this window holds no live sub-agent", () => {
    // Running, but its connection is not attached here (not yet, or no
    // longer): nothing live contradicts the poll.
    bindingFor(TASK, CHILD)
    renderCard([blockedPoll(TASK)])

    expect(screen.getByText("awaiting approval")).toBeInTheDocument()
    expect(screen.queryByTestId("permission-dialog")).not.toBeInTheDocument()
  })

  it("stops claiming 'awaiting approval' once the delegation has ended", () => {
    // Answered, then the sub-agent finished and was released before the agent
    // polled again: the poll's "waiting" is history, and so is anything its
    // connection still holds in the moment before it goes.
    bindingFor(TASK, CHILD, "ok")
    const { unmount } = renderCard([blockedPoll(TASK)])
    expect(screen.queryByText("awaiting approval")).not.toBeInTheDocument()
    expect(screen.getByText("checked")).toBeInTheDocument()
    unmount()

    connections.set(CHILD, childState({ pendingPermission: PERMISSION }))
    renderCard([blockedPoll(TASK)])
    expect(screen.queryByTestId("permission-dialog")).not.toBeInTheDocument()
    expect(screen.getByText("checked")).toBeInTheDocument()
  })

  it("stays closed while the decisions it was closed on are still pending", () => {
    bindingFor(TASK, CHILD)
    const plan = {
      approval_id: "plan-1",
      tool_call_id: "tc-1",
      plan_markdown: "1. migrate",
      created_at: "2026-10-18T00:00:00Z",
    }
    connections.set(
      CHILD,
      childState({ pendingPermission: PERMISSION, pendingPlanApproval: plan })
    )
    renderCard([blockedPoll(TASK)])
    fireEvent.click(screen.getByRole("button", { expanded: true }))

    // One of the two is answered elsewhere; the other was already in view
    // when the user closed the row.
    act(() => {
      connections.set(CHILD, childState({ pendingPlanApproval: plan }))
      notifyStore()
    })
    expect(screen.getByRole("button", { expanded: false })).toBeInTheDocument()
    expect(screen.queryByTestId("plan-approval-card")).not.toBeInTheDocument()

    // A decision the user has not seen yet opens it again.
    act(() => {
      connections.set(
        CHILD,
        childState({
          pendingPlanApproval: plan,
          pendingPermission: { ...PERMISSION, request_id: "req-3" },
        })
      )
      notifyStore()
    })
    expect(screen.getByRole("button", { expanded: true })).toBeInTheDocument()
    expect(screen.getByTestId("permission-dialog")).toBeInTheDocument()
  })

  it("stays closed once the user closes it, and opens again for the next decision", () => {
    bindingFor(TASK, CHILD)
    connections.set(CHILD, childState({ pendingPermission: PERMISSION }))
    renderCard([blockedPoll(TASK)])

    fireEvent.click(screen.getByRole("button", { expanded: true }))
    expect(screen.queryByTestId("permission-dialog")).not.toBeInTheDocument()
    expect(screen.getByText("awaiting approval")).toBeInTheDocument()

    act(() => {
      connections.set(
        CHILD,
        childState({
          pendingPermission: { ...PERMISSION, request_id: "req-2" },
        })
      )
      notifyStore()
    })
    fireEvent.click(screen.getByTestId("permission-dialog"))
    expect(respondPermission).toHaveBeenCalledWith(CHILD, "req-2", "approve")
  })

  it("leaves a finished wait alone", () => {
    // The task's latest poll is its result. A sub-agent bound to the same id
    // (a later resume) is that run's business, not this row's.
    bindingFor(TASK, CHILD)
    connections.set(CHILD, childState({ pendingPermission: PERMISSION }))
    const done = {
      task_id: TASK,
      status: "completed",
      text: "Migrated.",
    }
    renderCard([
      blockedPoll(TASK),
      {
        type: "tool-call",
        toolCallId: "poll-done",
        toolName: "get_delegation_status",
        input: JSON.stringify({ task_ids: [TASK] }),
        state: "output-available",
        output: JSON.stringify({
          content: [{ type: "text", text: JSON.stringify({ tasks: [done] }) }],
          isError: false,
          structuredContent: { tasks: [done] },
        }),
      },
    ])

    expect(screen.getByText("done")).toBeInTheDocument()
    expect(screen.queryByTestId("permission-dialog")).not.toBeInTheDocument()
  })
})

/** A re-poll of `taskId` that is still waiting on the backend. */
function inflightPoll(taskId: string, id: string): AdaptedToolCallPart {
  return {
    type: "tool-call",
    toolCallId: id,
    toolName: "get_delegation_status",
    input: JSON.stringify({ task_ids: [taskId] }),
    state: "input-available",
    output: null,
  }
}

/**
 * Status cards as one transcript draws them — a grouped card per entry, or a
 * bare call drawn as its own card — under the transcript's index, built the
 * way `MessageListView` builds it: over the whole thread, including the cards
 * the virtualized list has not mounted (`unmounted`, by first poll id).
 */
function renderTranscript(
  cards: Array<AdaptedToolCallPart[] | AdaptedToolCallPart>
) {
  const firstId = (c: (typeof cards)[number]) =>
    Array.isArray(c) ? c[0].toolCallId : c.toolCallId
  const ui = (cs: typeof cards, unmounted: string[] = []): ReactElement => {
    const parts: AdaptedContentPart[] = cs.map((c) =>
      Array.isArray(c) ? { type: "delegation-status-group", polls: c } : c
    )
    const index = buildDelegationStatusIndex(
      parts.map((part) => collectDelegationStatusTasks([part]))
    )
    return (
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <DelegationStatusIndexProvider value={index}>
          {cs
            .filter((c) => !unmounted.includes(firstId(c)))
            .map((c) =>
              Array.isArray(c) ? (
                <section
                  key={c[0].toolCallId}
                  data-testid={`card-${c[0].toolCallId}`}
                >
                  <DelegationStatusGroupCard polls={c} />
                </section>
              ) : (
                <section
                  key={c.toolCallId}
                  data-testid={`card-${c.toolCallId}`}
                >
                  <DelegationStatusCard
                    kind="status"
                    toolCallId={c.toolCallId}
                    input={c.input}
                    output={c.output}
                    state={c.state}
                  />
                </section>
              )
            )}
        </DelegationStatusIndexProvider>
      </NextIntlClientProvider>
    )
  }
  const result = render(ui(cards))
  return {
    ...result,
    rerenderCards: (cs: typeof cards, unmounted?: string[]) =>
      result.rerender(ui(cs, unmounted)),
  }
}

function card(id: string) {
  return within(screen.getByTestId(`card-${id}`))
}

describe("Status cards of one transcript — one prompt per task", () => {
  beforeEach(() => {
    bindings.clear()
    connections.clear()
    storeCallbacks = []
    respondPermission.mockReset()
    answerQuestion.mockReset()
    answerPlanApproval.mockReset()
  })

  it("carries the decision in the task's newest card only; the older ones read 'checked' and stay out of the live state", () => {
    // The agent told the user about the decision between polls, so each poll
    // is a card of its own.
    bindingFor(TASK, CHILD)
    connections.set(CHILD, childState({ pendingPermission: PERMISSION }))
    renderTranscript([
      [blockedPoll(TASK, "p1")],
      [blockedPoll(TASK, "p2")],
      [blockedPoll(TASK, "p3")],
    ])

    expect(screen.getAllByTestId("permission-dialog")).toHaveLength(1)
    expect(card("p3").getByTestId("permission-dialog")).toBeInTheDocument()
    expect(card("p3").getByText("awaiting approval")).toBeInTheDocument()
    for (const older of ["p1", "p2"]) {
      expect(card(older).getByText("checked")).toBeInTheDocument()
      expect(
        card(older).getByRole("button", { expanded: false })
      ).toBeInTheDocument()
    }
    // Only the newest row watches the sub-agent.
    expect(storeCallbacks).toHaveLength(1)
  })

  it("moves an untouched decision to the card the agent polls in next", () => {
    bindingFor(TASK, CHILD)
    connections.set(CHILD, childState({ pendingPermission: PERMISSION }))
    const { rerenderCards } = renderTranscript([[blockedPoll(TASK, "p1")]])
    expect(card("p1").getByTestId("permission-dialog")).toBeInTheDocument()

    // The re-poll is still in flight: its own polls vouch for nothing yet,
    // the earlier card's `running` answer does.
    rerenderCards([[blockedPoll(TASK, "p1")], [inflightPoll(TASK, "p2")]])

    expect(screen.getAllByTestId("permission-dialog")).toHaveLength(1)
    expect(card("p2").getByTestId("permission-dialog")).toBeInTheDocument()
    expect(card("p2").getByText("awaiting approval")).toBeInTheDocument()
    expect(card("p1").getByText("checked")).toBeInTheDocument()
    fireEvent.click(card("p2").getByTestId("permission-dialog"))
    expect(respondPermission).toHaveBeenCalledWith(CHILD, "req-1", "approve")
  })

  it("keeps a decision the user has started answering where it is when the agent polls again", () => {
    bindingFor(TASK, CHILD)
    const question = {
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
    }
    connections.set(CHILD, childState({ pendingAskQuestion: question }))
    const { rerenderCards } = renderTranscript([[blockedPoll(TASK, "p1")]])
    // The user starts on the answer…
    const draft = card("p1").getByTestId("ask-question-draft")
    fireEvent.pointerDown(draft)
    fireEvent.change(draft, { target: { value: "Postgres" } })

    // …and the agent polls again meanwhile.
    rerenderCards([[blockedPoll(TASK, "p1")], [inflightPoll(TASK, "p2")]])
    expect(screen.getAllByTestId("ask-question-card")).toHaveLength(1)
    expect(card("p1").getByTestId("ask-question-card")).toBeInTheDocument()
    // Not moved, not remounted: the unsent answer is still there.
    expect(card("p1").getByTestId("ask-question-draft")).toHaveValue("Postgres")
    // The newest row still says what the sub-agent is waiting on.
    expect(card("p2").getByText("awaiting approval")).toBeInTheDocument()

    // Answered: the hold goes with it, and the next decision opens in the
    // newest card again.
    act(() => {
      connections.set(CHILD, childState())
      notifyStore()
    })
    expect(screen.queryByTestId("ask-question-card")).not.toBeInTheDocument()
    act(() => {
      connections.set(
        CHILD,
        childState({
          pendingPermission: { ...PERMISSION, request_id: "req-2" },
        })
      )
      notifyStore()
    })
    expect(screen.getAllByTestId("permission-dialog")).toHaveLength(1)
    expect(card("p2").getByTestId("permission-dialog")).toBeInTheDocument()
  })

  it("hands a held decision to the newest card once the holding card is gone", () => {
    bindingFor(TASK, CHILD)
    connections.set(CHILD, childState({ pendingPermission: PERMISSION }))
    const { rerenderCards } = renderTranscript([[blockedPoll(TASK, "p1")]])
    fireEvent.focus(card("p1").getByTestId("permission-dialog"))
    rerenderCards([[blockedPoll(TASK, "p1")], [inflightPoll(TASK, "p2")]])
    expect(card("p1").getByTestId("permission-dialog")).toBeInTheDocument()

    // Scrolled out of the virtualized thread.
    rerenderCards(
      [[blockedPoll(TASK, "p1")], [inflightPoll(TASK, "p2")]],
      ["p1"]
    )
    expect(screen.getAllByTestId("permission-dialog")).toHaveLength(1)
    expect(card("p2").getByTestId("permission-dialog")).toBeInTheDocument()
  })

  it("names a bare status call's row by its own call id", () => {
    bindingFor(TASK, CHILD)
    connections.set(CHILD, childState({ pendingPermission: PERMISSION }))
    renderTranscript([[blockedPoll(TASK, "p1")], blockedPoll(TASK, "p2")])

    expect(screen.getAllByTestId("permission-dialog")).toHaveLength(1)
    expect(card("p2").getByTestId("permission-dialog")).toBeInTheDocument()
    expect(card("p1").getByText("checked")).toBeInTheDocument()
  })

  it("keeps one newest row per task when the agent waits on several", () => {
    const OTHER = "7bd4d6ff-0000-4000-8000-000000000002"
    const OTHER_CHILD = "child-conn-2"
    bindingFor(TASK, CHILD)
    bindingFor(OTHER, OTHER_CHILD)
    connections.set(CHILD, childState({ pendingPermission: PERMISSION }))
    connections.set(OTHER_CHILD, {
      ...childState({
        pendingPermission: { ...PERMISSION, request_id: "req-other" },
      }),
      connectionId: OTHER_CHILD,
      contextKey: OTHER_CHILD,
    })
    const both: AdaptedToolCallPart = {
      ...blockedPoll(TASK, "p1"),
      input: JSON.stringify({ task_ids: [TASK, OTHER] }),
    }
    const reports = [TASK, OTHER].map((taskId) => ({
      task_id: taskId,
      status: "running",
      message: BLOCKED_TEXT,
      blocked_on: { kind: "permission" },
    }))
    both.output = JSON.stringify({
      content: [{ type: "text", text: JSON.stringify({ tasks: reports }) }],
      isError: false,
      structuredContent: { tasks: reports },
    })
    renderTranscript([[both], [inflightPoll(TASK, "p2")]])

    expect(screen.getAllByTestId("permission-dialog")).toHaveLength(2)
    expect(card("p2").getByText("permission req-1")).toBeInTheDocument()
    expect(card("p1").getByText("permission req-other")).toBeInTheDocument()
    expect(card("p1").queryByText("permission req-1")).not.toBeInTheDocument()
  })

  it("never reaches a sub-agent no poll of the transcript found running", () => {
    // The backend answered the id `unknown` (another conversation's task),
    // and the agent is polling it again: nothing in the transcript vouches.
    bindingFor(TASK, CHILD)
    connections.set(CHILD, childState({ pendingPermission: PERMISSION }))
    const unknown = {
      task_id: TASK,
      status: "unknown",
      message: "Unknown task id.",
    }
    renderTranscript([
      [
        {
          ...inflightPoll(TASK, "p1"),
          state: "output-available",
          output: JSON.stringify({
            content: [{ type: "text", text: unknown.message }],
            isError: false,
            structuredContent: { tasks: [unknown] },
          }),
        },
      ],
      [inflightPoll(TASK, "p2")],
    ])

    expect(screen.queryByTestId("permission-dialog")).not.toBeInTheDocument()
    expect(screen.queryByText("awaiting approval")).not.toBeInTheDocument()
  })
})
