import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import type { TimelineRow } from "@/lib/types"

const api = vi.hoisted(() => ({
  personalAgentAskAnswer: vi.fn(),
  personalAgentNoticeAct: vi.fn(),
}))
const toast = vi.hoisted(() => ({
  info: vi.fn(),
  error: vi.fn(),
  success: vi.fn(),
}))
vi.mock("@/lib/api", () => api)
vi.mock("sonner", () => ({ toast }))
vi.mock("@/contexts/personal-agent-context", () => ({
  useBotId: () => null,
  usePersonalAgent: () => ({
    liveReplies: new Map(),
    dispatchById: new Map(),
    quoted: new Map(),
    requestQuoted: () => {},
    rows: [],
  }),
}))
vi.mock("@/contexts/workbench-route-context", () => ({
  useWorkbenchRoute: () => ({ setRoute: vi.fn(), openConversations: vi.fn() }),
}))
vi.mock("@/contexts/tab-context", () => ({
  useTabActions: () => ({ openTab: vi.fn() }),
}))

import { AnsweredForYou, EventCard } from "./event-card"
import { waitsForOwner } from "./message-list"
import { buildMessageItems, type MessageItem } from "./message-items"
import { NoticeCard } from "./notice-card"
import { PageScopeContext, type PageScope } from "./shared"

const QUESTION = {
  id: "q1",
  question: "Use A or B?",
  header: "Approach",
  multi_select: false,
  options: [
    { label: "A", description: "the plan" },
    { label: "B", description: "" },
  ],
}

function ask(data: Record<string, unknown>, id = 40): TimelineRow {
  return {
    id,
    segment_id: 1,
    batch_id: null,
    kind: "notice",
    status: null,
    body: "Use A or B?",
    data: {
      notice: "ask",
      ask_id: 12,
      bot_id: 1,
      dispatch_id: 5,
      title: "Fix the cold start",
      executor: "Builder",
      executor_id: 3,
      agent_type: "codex",
      mode: "session",
      conversation_id: 77,
      conversation_folder_id: 2,
      folder_id: 2,
      work_task_id: null,
      request: "question",
      request_id: "qid-1",
      questions: [QUESTION],
      plan: null,
      plan_actions: [],
      state: "asking",
      forward_reason: null,
      suggestion: null,
      reason: null,
      answered_by: null,
      answer: null,
      mirror_of: null,
      ...data,
    },
    dispatch_id: 5,
    ref_id: "12",
    reply_to: null,
    read_at: null,
    event_id: 9,
    seen_at: null,
    created_at: "2026-11-10T10:00:00Z",
    updated_at: "2026-11-10T10:00:00Z",
  }
}

function scope(readOnly = false): PageScope {
  return {
    readOnly,
    agentName: "Aide",
    liveRowId: null,
    connectionId: null,
    agentType: null,
    onQuote: vi.fn(),
    jumpTo: vi.fn(),
    rowsById: new Map(),
  }
}

function draw(row: TimelineRow, readOnly = false) {
  const item = buildMessageItems([row]).find((i) => i.kind === "notice")
  if (!item) throw new Error("no notice item")
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <PageScopeContext.Provider value={scope(readOnly)}>
        <NoticeCard item={item as Extract<MessageItem, { kind: "notice" }>} />
      </PageScopeContext.Provider>
    </NextIntlClientProvider>
  )
}

afterEach(() => {
  cleanup()
  api.personalAgentAskAnswer.mockReset()
  toast.info.mockReset()
  toast.error.mockReset()
})

describe("AskCard", () => {
  it("says the assistant is answering, with the question and nothing to answer", () => {
    const { container } = draw(ask({}))
    expect(screen.getByText("Builder is asking")).toBeTruthy()
    expect(screen.getByText("Aide is answering this for you…")).toBeTruthy()
    expect(screen.getByText("Use A or B?")).toBeTruthy()
    expect(
      container.querySelector("[data-pa-ask]")?.getAttribute("data-pa-ask")
    ).toBe("asking")
    expect(screen.queryByRole("button", { name: /submit/i })).toBeNull()
    expect(screen.getByRole("button", { name: "Open session" })).toBeTruthy()
  })

  it("lets the owner answer a forwarded question here, with the assistant's lean", async () => {
    api.personalAgentAskAnswer.mockResolvedValue({
      state: "answered",
      text: "",
    })
    draw(
      ask({
        state: "forwarded",
        forward_reason: "assistant",
        suggestion: "A",
        reason: "The owner never said",
      })
    )
    expect(screen.getByText("Waiting for your answer")).toBeTruthy()
    expect(
      screen.getByText("Aide could not settle it and passed it to you")
    ).toBeTruthy()
    expect(screen.getByText("Aide leans to: A")).toBeTruthy()
    expect(screen.getByText("Why: The owner never said")).toBeTruthy()
    fireEvent.click(screen.getByText("A"))
    const submit = screen
      .getAllByRole("button")
      .find((b) => /submit/i.test(b.textContent ?? ""))
    if (!submit) throw new Error("no submit button")
    fireEvent.click(submit)
    await waitFor(() =>
      expect(api.personalAgentAskAnswer).toHaveBeenCalledWith({
        askId: 12,
        answer: {
          answers: [{ questionId: "q1", labels: ["A"] }],
          declined: false,
        },
      })
    )
  })

  it("tells the owner when someone answered first", async () => {
    api.personalAgentAskAnswer.mockResolvedValue({
      state: "already_answered",
      text: "",
    })
    draw(
      ask({
        state: "forwarded",
        forward_reason: "timeout",
        request: "plan",
        questions: [],
        plan: "1. Do it",
        plan_actions: ["approve", "revise", "abandon"],
      })
    )
    expect(screen.getByText("No answer from Aide in 10 minutes")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: /approve/i }))
    await waitFor(() =>
      expect(api.personalAgentAskAnswer).toHaveBeenCalledWith({
        askId: 12,
        decision: "approve",
        feedback: null,
      })
    )
    await waitFor(() =>
      expect(toast.info).toHaveBeenCalledWith(
        "Already answered — the card shows whose answer was taken"
      )
    )
  })

  it("says who answered and what, the assistant's reason with it", () => {
    draw(
      ask({
        state: "answered",
        answered_by: { kind: "assistant", bot_id: 1, name: "Aide" },
        answer: {
          answers: [
            {
              question: "Use A or B?",
              header: "Approach",
              multi_select: false,
              selected: ["A"],
            },
          ],
          declined: false,
        },
        reason: "You said “use A” in #58",
      })
    )
    expect(screen.getByText("Aide answered for you: Approach: A")).toBeTruthy()
    expect(screen.getByText("Why: You said “use A” in #58")).toBeTruthy()
    expect(screen.queryByRole("button", { name: "Open session" })).toBeNull()
  })

  it("reads an owner's answer in the session, a plan sent back, a withdrawal", () => {
    draw(
      ask(
        {
          state: "answered",
          request: "plan_permission",
          questions: [],
          plan: "Plan",
          answered_by: { kind: "owner" },
          answer: {
            option_id: "reject",
            name: "No, keep planning",
            kind: "reject_once",
          },
        },
        41
      )
    )
    expect(
      screen.getByText("You answered: sent the plan back (No, keep planning)")
    ).toBeTruthy()
    cleanup()
    draw(
      ask({
        state: "answered",
        answered_by: { kind: "owner", where: "session" },
        answer: { answers: [], declined: true },
      })
    )
    expect(
      screen.getByText("You answered in the session: skipped")
    ).toBeTruthy()
    cleanup()
    draw(ask({ state: "withdrawn" }))
    expect(
      screen.getByText("Withdrawn — it no longer waits for an answer")
    ).toBeTruthy()
  })

  it("on a mirror, names the assistant the work went to", () => {
    draw(
      ask({
        state: "forwarded",
        forward_reason: "turn_ended",
        mirror_of: { bot_id: 4, row_id: 40, ask_id: 12, name: "Scout" },
      })
    )
    expect(
      screen.getByText("From the work Scout took on for you here")
    ).toBeTruthy()
    expect(
      screen.getByText("Scout ended its turn without answering")
    ).toBeTruthy()
  })

  it("only a forwarded ask waits for the owner", () => {
    expect(waitsForOwner(ask({ state: "asking" }))).toBe(false)
    expect(waitsForOwner(ask({ state: "forwarded" }))).toBe(true)
    expect(waitsForOwner(ask({ state: "answered" }))).toBe(false)
  })
})

describe("the work's card", () => {
  function news(autoRetry: unknown): TimelineRow {
    return {
      ...ask({}),
      id: 50,
      kind: "result",
      body: "Fix the cold start",
      data: {
        mode: "session",
        state: "interrupted",
        title: "Fix the cold start",
        executor: "Builder",
        cause: "boot",
        note: "codeg restarted",
        auto_retry: autoRetry,
      },
    }
  }

  function drawNews(row: TimelineRow) {
    const item = buildMessageItems([row]).find((i) => i.kind === "event")
    if (!item) throw new Error("no event item")
    return render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <PageScopeContext.Provider value={scope()}>
          <EventCard item={item as Extract<MessageItem, { kind: "event" }>} />
        </PageScopeContext.Provider>
      </NextIntlClientProvider>
    )
  }

  it("says how codeg went on from a restart's interruption", () => {
    drawNews(news({ state: "retried", attempt: 1, max: 2 }))
    expect(
      screen.getByText("Retried automatically (attempt 1 of 2)")
    ).toBeTruthy()
    cleanup()
    drawNews(news({ state: "exhausted", max: 2 }))
    expect(
      screen.getByText("Retried 2 times already — yours to decide")
    ).toBeTruthy()
    cleanup()
    drawNews(news({ state: "asked" }))
    expect(screen.getByText("Asked you whether to retry it")).toBeTruthy()
    cleanup()
    const { container } = drawNews(news(null))
    expect(container.querySelector("[data-pa-retry]")).toBeNull()
  })

  it("counts the answers its assistant gave for the owner", () => {
    render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <AnsweredForYou count={2} />
        <AnsweredForYou count={0} />
      </NextIntlClientProvider>
    )
    expect(screen.getByText("Answered for you 2 times")).toBeTruthy()
    expect(document.querySelectorAll("[data-pa-answered-for-you]").length).toBe(
      1
    )
  })
})
