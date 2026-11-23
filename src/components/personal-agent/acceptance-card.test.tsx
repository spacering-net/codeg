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
      work_agent: "claude_code",
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
    // Its head says the round alone: only the assistant speaks, no one did
    // or checked it by name.
    expect(container.querySelector("[data-pa-sheet-head]")?.textContent).toBe(
      "Acceptance · round 1 of at most 3"
    )
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
    // The check's verdict on its line; how it ended on the next, whose word
    // it was on that line — not a conclusion line saying "通过" once more —
    // on the caution's tone, as it goes against the check; the reason a
    // fact of its own.
    expect(
      container.querySelector('[data-pa-verdict="fail"]')?.textContent
    ).toBe("不通过")
    expect(container.querySelector("[data-pa-conclusion]")).toBeNull()
    const result = container.querySelector("[data-pa-result-field]")!
    expect(result.querySelector("dt")?.textContent).toBe("结果")
    expect(result.querySelector("dd")?.textContent).toBe("已通过助手决定的")
    const by = container.querySelector('[data-pa-decided-by="assistant"]')!
    expect(by.hasAttribute("data-pa-against")).toBe(true)
    expect(by.className).toContain("text-amber-700")
    const why = container.querySelector("[data-pa-reason]")!
    expect(why.querySelector("dt")?.textContent).toBe("理由")
    expect(why.querySelector("dd")?.textContent).toBe(
      "a.txt is meant to say two."
    )
    // A reason with a long unbroken run (a hash, a path) wraps on the card,
    // which clips what overflows it.
    expect(why.querySelector("dd")?.className).toContain(
      "[overflow-wrap:anywhere]"
    )
    expect(why.querySelector("dd")?.className).toContain("[&>*]:min-w-0")
    expect(container.querySelector("[data-pa-accept-ended]")?.textContent).toBe(
      "已通过"
    )
    // "通过" said twice at most: the check's, and how it ended.
    expect(
      container.querySelector("dl")?.textContent?.split("通过").length
    ).toBe(3)
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
    // The owner's word on the line of how it ended, not a line of its own.
    expect(owner.container.querySelector("[data-pa-conclusion]")).toBeNull()
    const own = owner.container.querySelector('[data-pa-decided-by="owner"]')!
    expect(own.textContent).toBe("your decision")
    expect(own.hasAttribute("data-pa-against")).toBe(false)
    expect(
      owner.container.querySelector("[data-pa-result-field] dd")?.textContent
    ).toBe("Acceptedyour decision")
    expect(owner.container.querySelector("[data-pa-reason]")).toBeNull()
    owner.unmount()
    // Not yet ended as decided: the conclusion its own line still.
    const pending = draw(
      card({
        state: "acted",
        phase: "changed",
        decision: "accept",
        decided_by: "owner",
        verdict: "pass",
      })
    )
    const said = pending.container.querySelector("[data-pa-conclusion]")!
    expect(said.querySelector("dt")?.textContent).toBe("Your decision")
    expect(said.querySelector("dd")?.textContent).toBe("accept")
    expect(pending.container.querySelector("[data-pa-decided-by]")).toBeNull()
  })

  it("says work accepted unchecked or unverified, and what was merged or delivered", () => {
    const unchecked = draw(
      card({
        state: "acted",
        phase: "accepted",
        decision: "accept",
        unchecked: true,
        checker_agent: null,
        verdict: null,
        merge_commit: "def4567890",
      })
    )
    expect(screen.getByText("Not checked independently")).toBeTruthy()
    expect(
      unchecked.container.querySelector("[data-pa-sheet-head]")?.textContent
    ).toBe("Acceptance · round 1 of at most 3")
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

  it("opens an earlier round's long line whole, and closes it again", async () => {
    // A layout that runs every line over its one: the observer reports it.
    const RO = globalThis.ResizeObserver
    globalThis.ResizeObserver = class {
      constructor(private cb: ResizeObserverCallback) {}
      observe() {
        this.cb([], this as unknown as ResizeObserver)
      }
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver
    const sh = vi
      .spyOn(HTMLElement.prototype, "scrollHeight", "get")
      .mockReturnValue(60)
    const ch = vi
      .spyOn(HTMLElement.prototype, "clientHeight", "get")
      .mockReturnValue(20)
    try {
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
              message: "Keep the parent commit; only add the review's record.",
            },
          ],
        }),
        { zh: true }
      )
      const text = document.querySelector("[data-pa-history-text]")!
      // The evidence's own toggle aside: the round's.
      await waitFor(() =>
        expect(
          document.querySelector("[data-pa-history-toggle]")
        ).not.toBeNull()
      )
      const open = document.querySelector("[data-pa-history-toggle]")!
      expect(open.getAttribute("aria-label")).toBe("展开")
      expect(open.getAttribute("aria-expanded")).toBe("false")
      expect(open.getAttribute("aria-controls")).toBe(text.id)
      fireEvent.click(open)
      expect(text.className).not.toContain("line-clamp-1")
      const close = document.querySelector("[data-pa-history-toggle]")!
      expect(close.getAttribute("aria-label")).toBe("收起")
      expect(close.getAttribute("aria-expanded")).toBe("true")
      fireEvent.click(close)
      expect(text.className).toContain("line-clamp-1")
    } finally {
      sh.mockRestore()
      ch.mockRestore()
      globalThis.ResizeObserver = RO
    }
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
    // Each earlier round its round on the left, how it went beside it.
    const earlier = document.querySelector('[data-pa-history="1"]')!
    expect(earlier.querySelector("dt")?.textContent).toBe("第 1 轮")
    expect(earlier.querySelector("dd")?.textContent).toBe(
      "退回「Fix the tests.」"
    )
    // One line each, cut where it runs over.
    expect(
      earlier.querySelector("[data-pa-history-text]")?.className
    ).toContain("line-clamp-1")
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
    // The card in bands: what it is, what the check found, its buttons, the
    // rounds before it.
    const sheet = screen.getByText("之前几轮").closest("[data-pa-surface]")!
    // A card of its own, no bubble round it: its heading its first line.
    expect(sheet.hasAttribute("data-bubble")).toBe(true)
    expect(sheet.closest(".pa-agent-bubble")).toBeNull()
    expect(sheet.children[0].hasAttribute("data-pa-sheet-head")).toBe(true)
    const parts = [...sheet.children].slice(1)
    expect(parts.map((p) => p.hasAttribute("data-pa-sheet-actions"))).toEqual([
      false,
      false,
      true,
      false,
    ])
    expect(parts[1].hasAttribute("data-pa-evidence")).toBe(true)
    expect(parts[3].textContent).toContain("之前几轮")
  })
})
