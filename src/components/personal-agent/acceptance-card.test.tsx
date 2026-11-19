import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import zhMessages from "@/i18n/messages/zh-CN.json"
import type { TimelineRow } from "@/lib/types"
import { usePersonalAgentUi } from "@/stores/personal-agent-ui-store"

const api = vi.hoisted(() => ({ personalAgentNoticeAct: vi.fn() }))
vi.mock("@/lib/api", () => api)
vi.mock("@/contexts/personal-agent-context", () => ({
  useBotId: () => 7,
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

import { waitsForOwner } from "./message-list"
import { buildMessageItems, type MessageItem } from "./message-items"
import { NoticeCard } from "./notice-card"
import { PageScopeContext, type PageScope } from "./shared"

function card(data: Record<string, unknown>): TimelineRow {
  return {
    id: 50,
    segment_id: 1,
    batch_id: null,
    kind: "notice",
    status: null,
    body: "Fix cold start\nAcceptance (round 1): check FAIL — the owner's call.",
    data: {
      notice: "acceptance",
      state: "open",
      round_id: 3,
      round: 1,
      max_rounds: 3,
      phase: "asked",
      dispatch_id: 4,
      title: "Fix cold start",
      work_task_id: 9,
      folder_id: 2,
      executor: "Coder",
      executor_agent: "claude_code",
      checker: "Checker",
      checker_agent: "codex",
      check_dispatch_id: 5,
      verdict: "fail",
      evidence: "- evidence: a.txt:1 still says two",
      unchecked: false,
      decision: "ask_owner",
      decided_by: "assistant",
      reason: "The check reads a choice you never made.",
      message: "Keep two, it is meant.",
      question: "Should a.txt say two?",
      history: [],
      delivered_head: null,
      merge_commit: null,
      version_guaranteed: null,
      pr_url: null,
      ...data,
    },
    dispatch_id: 4,
    ref_id: "12",
    reply_to: null,
    read_at: null,
    event_id: null,
    seen_at: null,
    created_at: "2026-11-12T07:00:00Z",
    updated_at: "2026-11-12T07:00:00Z",
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

function draw(row: TimelineRow, { readOnly = false, zh = false } = {}) {
  const item = buildMessageItems([row]).find((i) => i.kind === "notice")
  if (!item) throw new Error("no notice item")
  return render(
    <NextIntlClientProvider
      locale={zh ? "zh-CN" : "en"}
      messages={zh ? zhMessages : enMessages}
    >
      <PageScopeContext.Provider value={scope(readOnly)}>
        <NoticeCard item={item as Extract<MessageItem, { kind: "notice" }>} />
      </PageScopeContext.Provider>
    </NextIntlClientProvider>
  )
}

beforeEach(() => {
  usePersonalAgentUi.setState({ work: null, workOpen: false })
})

afterEach(() => {
  cleanup()
  api.personalAgentNoticeAct.mockReset()
})

describe("an acceptance card", () => {
  it("puts the owner's call to them with the question, the check and what sending it back says", async () => {
    api.personalAgentNoticeAct.mockResolvedValue(card({}))
    const { container } = draw(card({}))
    expect(screen.getByText("Acceptance · round 1 of at most 3")).toBeTruthy()
    expect(screen.getByText("Coder did it · Checker checked it")).toBeTruthy()
    expect(container.querySelector("[data-pa-verdict]")?.textContent).toBe(
      "Not passed"
    )
    expect(screen.getByText("It asks you: Should a.txt say two?")).toBeTruthy()
    expect(screen.getByText("What sending it back would say")).toBeTruthy()
    expect(screen.getByText("Keep two, it is meant.")).toBeTruthy()
    expect(container.textContent).toContain("a.txt:1 still says two")
    // Not the brain's English line.
    expect(container.textContent).not.toContain("the owner's call")
    expect(waitsForOwner(card({}))).toBe(true)

    for (const [name, action] of [
      ["Send it back as written", "revise"],
      ["Accept it", "accept"],
    ] as const) {
      fireEvent.click(screen.getByRole("button", { name }))
      await waitFor(() =>
        expect(api.personalAgentNoticeAct).toHaveBeenLastCalledWith(
          12,
          action,
          7
        )
      )
    }
    fireEvent.click(screen.getByRole("button", { name: "Open task" }))
    expect(usePersonalAgentUi.getState().work).toMatchObject({
      dispatchId: 4,
      mode: "task",
      workTaskId: 9,
    })
  })

  it("sends nothing back without words, and is read-only where the engine is not", () => {
    draw(card({ message: null }), { readOnly: true })
    expect(
      screen.queryByRole("button", { name: "Send it back as written" })
    ).toBeNull()
    expect(
      (screen.getByRole("button", { name: "Accept it" }) as HTMLButtonElement)
        .disabled
    ).toBe(true)
  })

  it("shows a refusal as other cards do", async () => {
    api.personalAgentNoticeAct.mockRejectedValue(
      new Error("this round no longer applies")
    )
    draw(card({}))
    fireEvent.click(screen.getByRole("button", { name: "Accept it" }))
    expect((await screen.findByRole("alert")).textContent).toContain(
      "this round no longer applies"
    )
  })

  it("says the rounds ran out", () => {
    draw(card({ round: 3, max_rounds: 3 }))
    expect(
      screen.getByText("Checked 3 rounds — as many as you allow")
    ).toBeTruthy()
  })

  it("shows both when the assistant goes against the check", () => {
    const { container } = draw(
      card({
        state: "acted",
        phase: "accepted",
        decision: "accept",
        reason: "a.txt is meant to say two.",
      }),
      { zh: true }
    )
    expect(container.querySelector("[data-pa-conclusion]")?.textContent).toBe(
      "检查：不通过 · 助手：通过，理由：a.txt is meant to say two."
    )
    expect(container.querySelector("[data-pa-accept-ended]")?.textContent).toBe(
      "已通过"
    )
    expect(screen.queryByRole("button", { name: "算通过" })).toBeNull()
    expect(waitsForOwner(card({ state: "acted", phase: "accepted" }))).toBe(
      false
    )
  })

  it("says codeg went by the check, or that the owner decided", () => {
    const fallback = draw(
      card({
        state: "acted",
        phase: "revised",
        decision: "revise",
        decided_by: "fallback",
        message: "Fix the tests.",
      })
    )
    expect(
      fallback.container.querySelector("[data-pa-conclusion]")?.textContent
    ).toBe("The assistant gave no conclusion: codeg went by the check")
    expect(screen.getByText("Sent back to be changed")).toBeTruthy()
    expect(screen.getByText("Fix the tests.")).toBeTruthy()
    fallback.unmount()
    const owner = draw(
      card({
        state: "acted",
        phase: "accepted",
        decision: "accept",
        decided_by: "owner",
        verdict: "pass",
      })
    )
    expect(
      owner.container.querySelector("[data-pa-conclusion]")?.textContent
    ).toBe("Your decision: accept")
  })

  it("says work accepted unchecked or unverified, and what was merged or delivered", () => {
    const unchecked = draw(
      card({
        state: "acted",
        phase: "accepted",
        decision: "accept",
        unchecked: true,
        checker: null,
        verdict: null,
        merge_commit: "def4567890",
      })
    )
    expect(screen.getByText("Not checked independently")).toBeTruthy()
    expect(screen.getByText("Coder did it")).toBeTruthy()
    expect(screen.getByText("Merged def4567")).toBeTruthy()
    unchecked.unmount()
    draw(
      card({
        state: "acted",
        phase: "accepted",
        decision: "accept",
        verdict: "unverified",
        delivered_head: "abc1234999",
      })
    )
    expect(screen.getByText("Not verified")).toBeTruthy()
    expect(screen.getByText("Delivered, head abc1234")).toBeTruthy()
  })

  it("offers to check again when the worktree changed during or after its check", async () => {
    api.personalAgentNoticeAct.mockResolvedValue(card({}))
    const voided = draw(
      card({ state: "changed", phase: "void", decision: null }),
      { zh: true }
    )
    expect(screen.getByText("检查期间工作树被改动，这一轮作废")).toBeTruthy()
    expect(waitsForOwner(card({ state: "changed", phase: "void" }))).toBe(true)
    fireEvent.click(screen.getByRole("button", { name: "重新检查" }))
    await waitFor(() =>
      expect(api.personalAgentNoticeAct).toHaveBeenCalledWith(12, "recheck", 7)
    )
    voided.unmount()
    const after = draw(
      card({ state: "changed", phase: "changed", decision: "accept" }),
      { zh: true }
    )
    expect(screen.getByText("验收之后工作树变了")).toBeTruthy()
    after.unmount()
    draw(card({ state: "changed", phase: "changed", decision: "ask_owner" }), {
      zh: true,
    })
    expect(screen.getByText("工作树在检查后被改动，验收已失效")).toBeTruthy()
  })

  it("asks nothing more of a round that was checked again since", () => {
    const old = card({
      state: "acted",
      phase: "void",
      decision: null,
      superseded: true,
    })
    draw(old, { zh: true })
    expect(screen.getByText("已重新检查")).toBeTruthy()
    expect(screen.queryByRole("button", { name: "重新检查" })).toBeNull()
    expect(waitsForOwner(old)).toBe(false)
  })

  it("says a round that no longer applies, and lists the earlier rounds", () => {
    draw(
      card({
        state: "stale",
        phase: "stale",
        round: 2,
        history: [
          {
            round: 1,
            state: "revised",
            verdict: "fail",
            message: "Fix the tests.",
          },
        ],
      }),
      { zh: true }
    )
    expect(screen.getByText("已失效，没有执行")).toBeTruthy()
    expect(screen.getByText("之前几轮")).toBeTruthy()
    expect(screen.getByText("第 1 轮：退回「Fix the tests.」")).toBeTruthy()
    expect(screen.queryByRole("button", { name: "算通过" })).toBeNull()
    expect(screen.queryByRole("button", { name: "重新检查" })).toBeNull()
    // Alone on the settled card, the way to the task looks a button: the
    // secondary one, on the card's white sheet.
    expect(
      screen
        .getByRole("button", { name: "打开任务" })
        .getAttribute("data-variant")
    ).toBe("secondary")
    expect(
      screen.getByText("之前几轮").closest("[data-pa-surface]")
    ).not.toBeNull()
  })
})
