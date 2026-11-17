import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import type { QuestionSpec, TimelineRow } from "@/lib/types"

const api = vi.hoisted(() => ({ personalAgentAnswerQuestion: vi.fn() }))
vi.mock("@/lib/api", () => api)
vi.mock("@/contexts/personal-agent-context", () => ({
  useBotId: () => 7,
  usePersonalAgent: () => ({ dispatchById: new Map() }),
}))
vi.mock("@/contexts/workbench-route-context", () => ({
  useWorkbenchRoute: () => ({ setRoute: vi.fn(), openConversations: vi.fn() }),
}))
vi.mock("@/contexts/tab-context", () => ({
  useTabActions: () => ({ openTab: vi.fn() }),
}))

import {
  QuestionChoiceCard,
  isChoiceQuestionRow,
  recordedPicks,
} from "./question-choice-card"
import { PageScopeContext, type PageScope } from "./shared"

const QUESTIONS: QuestionSpec[] = [
  {
    id: "q1",
    question: "Where should I look first?",
    header: "Start",
    multi_select: false,
    options: [
      { label: "The PR", description: "" },
      { label: "Local changes", description: "" },
    ],
  },
  {
    id: "q2",
    question: "Which checks?",
    header: "Checks",
    multi_select: true,
    options: [
      { label: "Lint", description: "" },
      { label: "Tests", description: "" },
      { label: "Build", description: "" },
    ],
  },
  {
    id: "q3",
    question: "Anything else?",
    header: "",
    multi_select: false,
    options: [],
  },
]

function questionRow(data: Record<string, unknown>): TimelineRow {
  return {
    id: 61,
    segment_id: null,
    batch_id: 3,
    kind: "question",
    status: null,
    body: "Where should I look first?",
    data: { kind: "ask", questions: QUESTIONS, ...data },
    dispatch_id: null,
    ref_id: "qid-9",
    reply_to: null,
    read_at: null,
    event_id: null,
    seen_at: null,
    created_at: "2026-11-11T10:00:00Z",
    updated_at: "2026-11-11T10:00:00Z",
  }
}

function scope(readOnly = false): PageScope {
  return {
    readOnly,
    agentName: "G",
    liveRowId: null,
    connectionId: null,
    agentType: null,
    onQuote: vi.fn(),
    jumpTo: vi.fn(),
    rowsById: new Map(),
  }
}

function draw(row: TimelineRow, { readOnly = false, live = true } = {}) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <PageScopeContext.Provider value={scope(readOnly)}>
        <QuestionChoiceCard row={row} live={live} />
      </PageScopeContext.Provider>
    </NextIntlClientProvider>
  )
}

const step = () =>
  document
    .querySelector("[data-pa-question-step]")
    ?.getAttribute("data-pa-question-step")

beforeEach(() => {
  api.personalAgentAnswerQuestion.mockReset()
  api.personalAgentAnswerQuestion.mockResolvedValue(undefined)
})

describe("the brain's question as a choice card", () => {
  it("is drawn for a question with its questions on the row, not a plan", () => {
    expect(isChoiceQuestionRow(questionRow({ state: "pending" }))).toBe(true)
    expect(
      isChoiceQuestionRow(
        questionRow({ kind: "plan_approval", state: "pending" })
      )
    ).toBe(false)
    expect(
      isChoiceQuestionRow(questionRow({ questions: undefined, state: "x" }))
    ).toBe(false)
  })

  it("goes one question at a time, back and on, and sends all at the end", async () => {
    draw(questionRow({ state: "pending" }))
    expect(screen.getByText("1 / 3")).toBeInTheDocument()
    const card = document.querySelector("[data-pa-choice-card]")!
    // A letter picks: on to the next one.
    fireEvent.keyDown(card, { key: "b" })
    expect(step()).toBe("2")
    expect(screen.getByText("2 / 3")).toBeInTheDocument()
    // Back: the answer is kept.
    fireEvent.click(screen.getByRole("button", { name: /Back/ }))
    expect(step()).toBe("1")
    expect(document.querySelector('[data-pa-choice="B"]')?.className).toContain(
      "pa-choice-chosen"
    )
    fireEvent.click(screen.getByRole("button", { name: "Next" }))
    expect(step()).toBe("2")
    // Several: toggled, then on.
    fireEvent.click(screen.getByRole("button", { name: /Lint/ }))
    fireEvent.keyDown(document.querySelector("[data-pa-choice-card]")!, {
      key: "c",
    })
    expect(screen.getByRole("button", { name: /Build/ })).toHaveAttribute(
      "aria-pressed",
      "true"
    )
    fireEvent.click(screen.getByRole("button", { name: "Next" }))
    expect(step()).toBe("3")
    // No choices: just the line.
    const input = screen.getByPlaceholderText("Write your own…")
    fireEvent.change(input, { target: { value: "the docs" } })
    fireEvent.submit(input.closest("form")!)
    await waitFor(() =>
      expect(api.personalAgentAnswerQuestion).toHaveBeenCalledWith(
        "qid-9",
        {
          answers: [
            { questionId: "q1", labels: ["Local changes"] },
            { questionId: "q2", labels: ["Lint", "Build"] },
            { questionId: "q3", labels: ["the docs"] },
          ],
          declined: false,
        },
        7
      )
    )
  })

  it("takes the owner's own words as the answer", async () => {
    draw(questionRow({ state: "pending", questions: [QUESTIONS[0]] }))
    fireEvent.click(screen.getByRole("button", { name: /Other/ }))
    const input = screen.getByPlaceholderText("Write your own…")
    fireEvent.change(input, { target: { value: "Both" } })
    fireEvent.submit(input.closest("form")!)
    await waitFor(() =>
      expect(api.personalAgentAnswerQuestion).toHaveBeenCalledWith(
        "qid-9",
        { answers: [{ questionId: "q1", labels: ["Both"] }], declined: false },
        7
      )
    )
  })

  it("cannot be answered on a page that only reads", () => {
    draw(questionRow({ state: "pending" }), { readOnly: true })
    expect(screen.getByRole("button", { name: /The PR/ })).toBeDisabled()
  })

  it("folds to one line once answered, and opens to the card as it was", () => {
    draw(
      questionRow({
        state: "answered",
        answer: {
          answers: [
            {
              question: "Where should I look first?",
              selected: ["Local changes"],
            },
            { question: "Which checks?", selected: ["Lint", "Build"] },
            { question: "Anything else?", selected: ["the docs"] },
          ],
          declined: false,
        },
      })
    )
    const line = screen.getByText(
      "You picked: B. Local changes · A. Lint, C. Build · the docs"
    )
    expect(screen.queryByText("1 / 3")).toBeNull()
    fireEvent.click(line)
    expect(screen.getByText("Which checks?")).toBeInTheDocument()
    expect(screen.getByText("Other: the docs")).toBeInTheDocument()
  })

  it("gives two questions asked in the same words their own answers", () => {
    const twice = [QUESTIONS[0], { ...QUESTIONS[0], id: "again" }]
    const q = QUESTIONS[0]
    expect(
      recordedPicks(twice, {
        answers: [
          {
            question: q.question,
            header: q.header,
            selected: [q.options[0].label],
          },
          {
            question: q.question,
            header: q.header,
            selected: [q.options[1].label],
          },
        ],
      })
    ).toEqual([
      { keys: ["A"], text: "" },
      { keys: ["B"], text: "" },
    ])
  })

  it("reads back what was picked by label", () => {
    expect(
      recordedPicks(QUESTIONS.slice(0, 2), {
        answers: [{ question: "Which checks?", selected: ["Tests", "my own"] }],
      })
    ).toEqual([
      { keys: [], text: "" },
      { keys: ["B"], text: "my own" },
    ])
  })
})
