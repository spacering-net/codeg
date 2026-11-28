/**
 * 2.5: proposal rules (6.7) — a rule's card and its next steps, "Don't
 * suggest these" on a suggestion, and the rules on "Proactive &
 * notifications".
 */

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
import type { ProposalRuleView, TimelineRow } from "@/lib/types"
import { usePersonalAgentUi } from "@/stores/personal-agent-ui-store"

const api = vi.hoisted(() => ({
  // What a card's local Markdown images are read with.
  readWorkspaceFileBase64: vi.fn(),
  readFileBase64: vi.fn(),
  personalAgentNoticeAct: vi.fn(),
  personalAgentRules: vi.fn(),
  personalAgentRuleReset: vi.fn(),
  personalAgentConversationTarget: vi.fn(),
  personalAgentBotImpact: vi.fn(),
  personalAgentBotDelete: vi.fn(),
}))
vi.mock("@/lib/api", () => api)
vi.mock("@/lib/platform", () => ({ openUrl: vi.fn() }))
vi.mock("@/lib/link-open", () => ({ openInSystemBrowser: vi.fn() }))
const nav = vi.hoisted(() => ({
  openConversations: vi.fn(),
  openTab: vi.fn(),
  openNewConversationTab: vi.fn(),
  patch: vi.fn(),
}))
vi.mock("@/contexts/personal-agent-context", () => ({
  useBotId: () => 7,
  usePersonalAgent: () => ({
    botId: 7,
    routineVersion: 0,
    liveReplies: new Map(),
    liveTexts: new Map(),
    dispatchById: new Map(),
    quoted: new Map(),
    requestQuoted: () => {},
    rows: [],
  }),
}))
vi.mock("@/contexts/workbench-route-context", () => ({
  useWorkbenchRoute: () => ({
    setRoute: vi.fn(),
    openConversations: nav.openConversations,
  }),
}))
vi.mock("@/contexts/tab-context", () => ({
  useTabActions: () => ({
    openTab: nav.openTab,
    openNewConversationTab: nav.openNewConversationTab,
  }),
}))
vi.mock("./settings/use-settings", () => ({
  useSettingsPatch: () => ({ patch: nav.patch }),
}))
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }))

import { buildMessageItems, type MessageItem } from "./message-items"
import { JumpRowContext } from "./message-row"
import { NoticeCard } from "./notice-card"
import { DEFAULT_PREFS } from "./settings/pref-pages"
import { ProposalRules } from "./settings/proposal-rules"
import { PageScopeContext, type PageScope } from "./shared"

function row(
  data: Record<string, unknown>,
  patch: Partial<TimelineRow> = {}
): TimelineRow {
  return {
    id: 81,
    segment_id: 1,
    batch_id: null,
    kind: "notice",
    status: null,
    body: "failed: Fix the flaky test",
    data,
    dispatch_id: null,
    ref_id: "41",
    reply_to: null,
    read_at: null,
    event_id: null,
    seen_at: null,
    created_at: "2026-11-12T07:00:00Z",
    updated_at: "2026-11-12T07:00:00Z",
    ...patch,
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

function wrap(
  node: React.ReactNode,
  {
    zh = false,
    readOnly = false,
    pageScope,
  }: { zh?: boolean; readOnly?: boolean; pageScope?: PageScope } = {}
) {
  return render(
    <NextIntlClientProvider
      locale={zh ? "zh-CN" : "en"}
      messages={zh ? zhMessages : enMessages}
      timeZone="UTC"
    >
      <PageScopeContext.Provider value={pageScope ?? scope(readOnly)}>
        {node}
      </PageScopeContext.Provider>
    </NextIntlClientProvider>
  )
}

function draw(r: TimelineRow, opts: { zh?: boolean; readOnly?: boolean } = {}) {
  const item = buildMessageItems([r]).find((i) => i.kind === "notice")
  if (!item) throw new Error("no notice item")
  return wrap(
    <NoticeCard item={item as Extract<MessageItem, { kind: "notice" }>} />,
    opts
  )
}

const FAILED = {
  notice: "rule",
  rule: "failed",
  state: "open",
  object: "dispatch:45",
  since: "2026-11-12T04:00:00Z",
  lowered: false,
  facts: {
    dispatch_id: 45,
    title: "Fix the flaky test",
    error: "the agent crashed",
  },
}

beforeEach(() => {
  api.personalAgentNoticeAct.mockResolvedValue({})
  api.personalAgentRules.mockResolvedValue([])
  api.personalAgentRuleReset.mockResolvedValue([])
  api.personalAgentConversationTarget.mockResolvedValue({
    folder_id: 3,
    conversation_id: 9,
    agent_type: "codex",
    title: "Explore auth",
  })
  usePersonalAgentUi.setState({ settings: null, botPage: null })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe("the weekly review's questions (2.11)", () => {
  it("asks to show the changes the owner keeps undoing first", async () => {
    const { container } = draw(
      row({
        notice: "rule",
        rule: "undo",
        state: "open",
        object: "changes",
        since: "2026-11-13T01:00:00Z",
        lowered: false,
        facts: { undone: 3, made: 4, week: "2026-W46" },
      })
    )
    expect(screen.getByText("Changes you undid")).toBeTruthy()
    expect(
      screen.getByText(
        "You undid 3 of the 4 changes made at your word in the last two weeks."
      )
    ).toBeTruthy()
    fireEvent.click(
      container.querySelector('[data-pa-rule-act="ask_first"]') as HTMLElement
    )
    await waitFor(() =>
      expect(api.personalAgentNoticeAct).toHaveBeenCalledWith(
        41,
        "ask_first",
        7,
        undefined
      )
    )
  })

  it("hides an idle assistant, or deletes it through the usual confirmation", async () => {
    api.personalAgentBotImpact.mockResolvedValue({
      bot_id: 9,
      name: "Docs",
      running: [],
      unanswered_messages: 0,
      plans: [],
      plan_steps: [],
      workdir: "/tmp/docs",
      workdir_custom: false,
    })
    api.personalAgentBotDelete.mockResolvedValue(undefined)
    const idle = {
      notice: "rule",
      rule: "idle_bot",
      state: "open",
      object: "bot:9",
      since: "2026-10-20T01:00:00Z",
      lowered: false,
      facts: { bot_id: 9, name: "Docs", since: "2026-10-20T01:00:00Z" },
    }
    const { container } = draw(row(idle))
    expect(screen.getByText("Idle assistants")).toBeTruthy()
    expect(screen.getByText("Docs")).toBeTruthy()
    fireEvent.click(
      container.querySelector('[data-pa-rule-act="hide"]') as HTMLElement
    )
    await waitFor(() =>
      expect(api.personalAgentNoticeAct).toHaveBeenCalledWith(
        41,
        "hide",
        7,
        undefined
      )
    )
    // [Delete…] asks first; the card settles once it is gone.
    fireEvent.click(
      container.querySelector('[data-pa-rule-act="delete"]') as HTMLElement
    )
    expect(api.personalAgentNoticeAct).not.toHaveBeenCalledWith(41, "delete", 7)
    const confirm = await waitFor(() => {
      const el = document.querySelector(
        "[data-pa-delete-confirm]"
      ) as HTMLButtonElement | null
      expect(el?.disabled).toBe(false)
      return el!
    })
    fireEvent.click(confirm)
    await waitFor(() =>
      expect(api.personalAgentBotDelete).toHaveBeenCalledWith(9, {
        hand_over: true,
        delete_workdir: false,
      })
    )
    await waitFor(() =>
      expect(api.personalAgentNoticeAct).toHaveBeenCalledWith(41, "delete", 7)
    )
  })
})

describe("a rule's card", () => {
  it("is a card of its own, no bubble round it, its outcome on its tone", () => {
    const open = draw(row(FAILED))
    const card = open.container.querySelector("[data-pa-card-message]")!
    expect(card.getAttribute("data-pa-rule-card")).toBe("failed")
    expect(card.closest(".pa-agent-bubble")).toBeNull()
    expect(card.querySelector("[data-pa-sheet-head]")?.textContent).toContain(
      "Failed"
    )
    open.unmount()
    const handed = draw(row({ ...FAILED, state: "handed" }))
    const note = handed.container.querySelector("[data-pa-rule-note]")!
    expect(note.getAttribute("data-pa-outcome")).toBe("done")
    expect(handed.container.querySelector("[data-pa-sheet-actions]")).toBeNull()
  })

  it("says what it found and does its next step", async () => {
    draw(row(FAILED))
    expect(screen.getByText("Failed, and nobody's on it")).toBeTruthy()
    expect(screen.getByText("Fix the flaky test")).toBeTruthy()
    expect(screen.getByText("the agent crashed")).toBeTruthy()
    // Its buttons on the card's last band, under a hairline.
    expect(
      screen.getByText("Retry").closest("[data-pa-sheet-actions]")
    ).not.toBeNull()
    fireEvent.click(screen.getByText("Retry"))
    await waitFor(() =>
      expect(api.personalAgentNoticeAct).toHaveBeenCalledWith(
        41,
        "retry",
        7,
        undefined
      )
    )
  })

  it("hands what needs judging over in the owner's words", async () => {
    draw(row(FAILED), { zh: true })
    expect(screen.getByText("失败了，没人处理")).toBeTruthy()
    fireEvent.click(screen.getByText("交给助手看看"))
    await waitFor(() =>
      expect(api.personalAgentNoticeAct).toHaveBeenCalledWith(
        41,
        "hand",
        7,
        "「Fix the flaky test」失败了，一直没人处理。帮我看看是怎么回事，告诉我你的建议。"
      )
    )
  })

  it("not now, and don't suggest these, are on every one", async () => {
    draw(row(FAILED))
    fireEvent.click(screen.getByText("Not now"))
    await waitFor(() =>
      expect(api.personalAgentNoticeAct).toHaveBeenCalledWith(
        41,
        "dismiss",
        7,
        undefined
      )
    )
    fireEvent.click(screen.getByText("Don't suggest these"))
    await waitFor(() =>
      expect(api.personalAgentNoticeAct).toHaveBeenCalledWith(41, "mute", 7)
    )
  })

  it("opens a waiting session where it is, and settles the card", async () => {
    draw(
      row({
        ...FAILED,
        rule: "session",
        object: "session:9",
        facts: {
          conversation_id: 9,
          folder_id: 3,
          title: "Explore auth",
          wait: "question",
          text: "Keep the old API?",
        },
      })
    )
    expect(screen.getByText("A session is waiting for you")).toBeTruthy()
    expect(screen.getByText(/Asking you · Keep the old API\?/)).toBeTruthy()
    fireEvent.click(screen.getByText("Open the session"))
    await waitFor(() => expect(nav.openTab).toHaveBeenCalled())
    expect(api.personalAgentNoticeAct).toHaveBeenCalledWith(
      41,
      "open",
      7,
      undefined
    )
  })

  it("a settled one says how, with no buttons", () => {
    draw(row({ ...FAILED, state: "retried" }))
    expect(screen.getByText("Retried.")).toBeTruthy()
    expect(screen.queryByText("Retry")).toBeNull()
    cleanup()
    draw(row({ ...FAILED, state: "expired" }))
    expect(screen.getByText("No longer needed: things changed.")).toBeTruthy()
    cleanup()
    draw(row({ ...FAILED, state: "dismissed", lowered_now: true }))
    expect(screen.getByText(/That's three in a row/)).toBeTruthy()
    cleanup()
    draw(row({ ...FAILED, state: "dismissed", muted: "failed" }))
    expect(screen.getByText("This kind won't be suggested again.")).toBeTruthy()
    fireEvent.click(screen.getByText("Turn it back on in preferences"))
    expect(usePersonalAgentUi.getState().settings?.page).toBe("proactive")
  })

  it("a lowered rule's card says it no longer notifies", () => {
    draw(row({ ...FAILED, lowered: true }))
    expect(
      screen.getByText(
        "You passed on the last three of these, so they no longer notify you."
      )
    ).toBeTruthy()
  })

  it("read-only: nothing to press", () => {
    draw(row(FAILED), { readOnly: true })
    expect(screen.queryByText("Retry")).toBeNull()
    expect(screen.queryByText("Don't suggest these")).toBeNull()
  })
})

describe("an assistant's suggestion", () => {
  const proposal = (why: string) =>
    row({
      notice: "proposal",
      state: "open",
      action: "dispatch",
      why,
      display: {
        agent_type: "codex",
        mode: "chat",
        title: "Look at the release notes",
        prompt: "Summarize them.",
      },
      detail: "They read them every Monday.",
    })

  it("has don't-suggest-these; a card to confirm does not", async () => {
    draw(proposal("proposal"))
    fireEvent.click(screen.getByText("Don't suggest these"))
    await waitFor(() =>
      expect(api.personalAgentNoticeAct).toHaveBeenCalledWith(41, "mute", 7)
    )
    cleanup()
    draw(proposal("confirm"))
    expect(screen.queryByText("Don't suggest these")).toBeNull()
  })
})

describe("the rules in the preferences", () => {
  const views = (patch: Partial<ProposalRuleView> = {}): ProposalRuleView[] => [
    {
      rule: "failed",
      muted_at: null,
      quiet_since: null,
      raised: 4,
      acted: 1,
      dismissed: 3,
      ...patch,
    },
  ]

  it("turns a rule off and changes its threshold", async () => {
    api.personalAgentRules.mockResolvedValue(views())
    wrap(<ProposalRules prefs={{ ...DEFAULT_PREFS }} disabled={false} />)
    await waitFor(() =>
      expect(
        screen.getByText("Last 30 days: 4 cards, 1 used, 3 dismissed")
      ).toBeTruthy()
    )
    fireEvent.click(
      document.querySelector('[data-pa-rule-switch="failed"]') as Element
    )
    expect(nav.patch).toHaveBeenCalledWith([
      { key: "prefs.rule_failed", value: "off" },
    ])
    const hours = document.querySelector(
      '[data-pa-rule-after="failed"]'
    ) as HTMLInputElement
    fireEvent.change(hours, { target: { value: "6" } })
    fireEvent.blur(hours)
    expect(nav.patch).toHaveBeenCalledWith([
      { key: "prefs.rule_failed_hours", value: 6 },
    ])
  })

  it("says a rule was muted from a card, or lowered, with a way back", async () => {
    api.personalAgentRules.mockResolvedValue(
      views({
        muted_at: "2026-11-12T08:00:00Z",
        quiet_since: "2026-11-12T08:00:00Z",
      })
    )
    wrap(
      <ProposalRules
        prefs={{ ...DEFAULT_PREFS, rule_failed: "off" }}
        disabled={false}
      />
    )
    await waitFor(() =>
      expect(
        screen.getByText('Turned off with "Don\'t suggest these" on a card.')
      ).toBeTruthy()
    )
    fireEvent.click(screen.getByText("Put it back"))
    await waitFor(() =>
      expect(api.personalAgentRuleReset).toHaveBeenCalledWith("failed")
    )
  })
})

describe("a run of one rule's cards raised together", () => {
  /** `n` review cards the board's first look raised at once, `patch` on
   *  the i-th's data. */
  const reviews = (
    n: number,
    patch: (i: number) => Record<string, unknown> = () => ({})
  ) =>
    Array.from({ length: n }, (_, i) =>
      row(
        {
          notice: "rule",
          rule: "review",
          state: "open",
          object: `task:${i + 1}`,
          since: "2026-11-10T04:00:00Z",
          lowered: false,
          facts: { task_id: i + 1, title: `Task ${i + 1}` },
          ...patch(i),
        },
        {
          id: 200 + i,
          ref_id: String(500 + i),
          body: `review: Task ${i + 1}`,
          created_at: "2026-11-12T07:00:00Z",
        }
      )
    )

  function drawRun(
    rows: TimelineRow[],
    opts: {
      zh?: boolean
      readOnly?: boolean
      pageScope?: PageScope
      jump?: { id: number } | null
    } = {}
  ) {
    const items = buildMessageItems(rows).filter((i) => i.kind === "notice")
    const cards = (jump: { id: number } | null) => (
      <JumpRowContext.Provider value={jump}>
        {items.map((item) => (
          <NoticeCard
            key={item.key}
            item={item as Extract<MessageItem, { kind: "notice" }>}
          />
        ))}
      </JumpRowContext.Provider>
    )
    const drawn = wrap(cards(opts.jump ?? null), opts)
    return {
      items,
      ...drawn,
      /** The list's next jump, to `id`. */
      jumpTo: (id: number) =>
        drawn.rerender(
          <NextIntlClientProvider
            locale={opts.zh ? "zh-CN" : "en"}
            messages={opts.zh ? zhMessages : enMessages}
            timeZone="UTC"
          >
            <PageScopeContext.Provider
              value={opts.pageScope ?? scope(opts.readOnly)}
            >
              {cards({ id })}
            </PageScopeContext.Provider>
          </NextIntlClientProvider>
        ),
    }
  }

  const names = (c: HTMLElement) =>
    [...c.querySelectorAll("[data-pa-rule-name]")].map((e) => e.textContent)
  const toggle = (c: HTMLElement) =>
    c.querySelector("[data-pa-rule-group-toggle]") as HTMLElement | null

  it("none: no card", () => {
    const { container, items } = drawRun([])
    expect(items).toEqual([])
    expect(container.querySelector("[data-pa-rule-card]")).toBeNull()
  })

  it("one: the card of its own, as it always was", () => {
    const { container } = drawRun(reviews(1))
    expect(container.querySelectorAll("[data-pa-rule-card]")).toHaveLength(1)
    expect(container.querySelector("[data-pa-rule-group]")).toBeNull()
    expect(names(container)).toEqual(["Task 1"])
    expect(toggle(container)).toBeNull()
    expect(screen.getByText(/since/)).toBeTruthy()
  })

  it("five: one card with all of them, nothing to show more of", () => {
    const { container } = drawRun(reviews(5))
    const cards = container.querySelectorAll("[data-pa-rule-card]")
    expect(cards).toHaveLength(1)
    expect(cards[0].getAttribute("data-pa-rule-group")).toBe("5")
    expect(
      container.querySelector("[data-pa-rule-group-count]")?.textContent
    ).toContain("5 cards")
    expect(names(container)).toEqual([1, 2, 3, 4, 5].map((i) => `Task ${i}`))
    expect(toggle(container)).toBeNull()
    expect(container.querySelector("[data-pa-rule-group-rest]")).toBeNull()
    // Each still says since when, and keeps its own steps.
    expect(container.querySelectorAll("[data-pa-rule-since]")).toHaveLength(5)
    expect(
      container.querySelectorAll('[data-pa-rule-act="check"]')
    ).toHaveLength(5)
    // "Don't suggest these" is the rule's: once.
    expect(container.querySelectorAll("[data-pa-mute-kind]")).toHaveLength(1)
  })

  it("six: the first five, and one more behind [Show all]", () => {
    const { container } = drawRun(reviews(6))
    expect(names(container)).toHaveLength(5)
    expect(toggle(container)?.textContent).toBe("Show all")
    expect(
      container.querySelector("[data-pa-rule-group-rest]")?.textContent
    ).toBe("1 more")
    fireEvent.click(toggle(container)!)
    expect(names(container)).toHaveLength(6)
    expect(toggle(container)?.textContent).toBe("Show less")
    expect(container.querySelector("[data-pa-rule-group-rest]")).toBeNull()
  })

  it("forty-one: five shown, thirty-six more; open and fold back", () => {
    const { container } = drawRun(reviews(41), { zh: true })
    expect(container.querySelectorAll("[data-pa-rule-card]")).toHaveLength(1)
    expect(names(container)).toEqual([1, 2, 3, 4, 5].map((i) => `Task ${i}`))
    expect(
      container.querySelector("[data-pa-rule-group-count]")?.textContent
    ).toContain("41 条")
    expect(toggle(container)?.textContent).toBe("展开全部")
    expect(
      container.querySelector("[data-pa-rule-group-rest]")?.textContent
    ).toBe("还有 36 条")
    fireEvent.click(toggle(container)!)
    expect(names(container)).toHaveLength(41)
    expect(names(container)[40]).toBe("Task 41")
    expect(toggle(container)?.getAttribute("aria-expanded")).toBe("true")
    expect(toggle(container)?.textContent).toBe("收起")
    // Each but the first keeps its own row id: a jump lands on it.
    expect(container.querySelector('[data-row-id="240"]')).not.toBeNull()
    fireEvent.click(toggle(container)!)
    expect(names(container)).toHaveLength(5)
    expect(
      container.querySelector("[data-pa-rule-group-rest]")?.textContent
    ).toBe("还有 36 条")
  })

  it("each one's steps act on its own card", async () => {
    const { container } = drawRun(reviews(6))
    const entries = container.querySelectorAll("[data-pa-rule-entry]")
    fireEvent.click(
      entries[2].querySelector('[data-pa-rule-act="check"]') as HTMLElement
    )
    await waitFor(() =>
      expect(api.personalAgentNoticeAct).toHaveBeenCalledWith(
        502,
        "check",
        7,
        expect.stringContaining("Task 3")
      )
    )
    fireEvent.click(
      entries[4].querySelector('[data-pa-rule-act="dismiss"]') as HTMLElement
    )
    await waitFor(() =>
      expect(api.personalAgentNoticeAct).toHaveBeenCalledWith(
        504,
        "dismiss",
        7,
        undefined
      )
    )
    // The rule's mute goes through an open one of them.
    fireEvent.click(
      container.querySelector("[data-pa-mute-kind]") as HTMLElement
    )
    await waitFor(() =>
      expect(api.personalAgentNoticeAct).toHaveBeenCalledWith(500, "mute", 7)
    )
  })

  it("says how each stands: dismissed, done, muted", () => {
    const { container } = drawRun(
      reviews(7, (i) =>
        i === 0
          ? { state: "dismissed" }
          : i === 1
            ? { state: "checking" }
            : i === 3
              ? { state: "dismissed", muted: "review" }
              : {}
      )
    )
    const entries = [...container.querySelectorAll("[data-pa-rule-entry]")]
    expect(entries.map((e) => e.getAttribute("data-pa-rule-entry"))).toEqual([
      "dismissed",
      "checking",
      "open",
      "dismissed",
      "open",
    ])
    expect(entries[0].textContent).toContain("Dismissed. Not again for a week.")
    expect(entries[0].querySelector("[data-pa-rule-act]")).toBeNull()
    expect(entries[1].querySelector("[data-pa-rule-note]")).not.toBeNull()
    expect(entries[3].textContent).toContain(
      "Dismissed, and this kind turned off."
    )
    expect(
      entries[2].querySelector('[data-pa-rule-act="check"]')
    ).not.toBeNull()
    // The mute from one of them: said once, with the way back. Others are
    // still open — the rule may be on again — so it can still be muted,
    // as each of them on its own could.
    expect(container.querySelectorAll("[data-pa-muted]")).toHaveLength(1)
    expect(container.querySelectorAll("[data-pa-mute-kind]")).toHaveLength(1)
    // Still more to show.
    expect(
      container.querySelector("[data-pa-rule-group-rest]")?.textContent
    ).toBe("2 more")
  })

  it("none of them open: nothing to mute", () => {
    const { container } = drawRun(
      reviews(3, (i) =>
        i === 0 ? { state: "dismissed", muted: "review" } : { state: "expired" }
      )
    )
    expect(container.querySelectorAll("[data-pa-muted]")).toHaveLength(1)
    expect(container.querySelector("[data-pa-mute-kind]")).toBeNull()
  })

  it("a jump to one folded away unfolds the card; one shown leaves it", () => {
    const { container, jumpTo } = drawRun(reviews(8))
    jumpTo(201)
    expect(names(container)).toHaveLength(5)
    jumpTo(206)
    expect(names(container)).toHaveLength(8)
    expect(container.querySelector('[data-row-id="206"]')).not.toBeNull()
    // Folded back by the owner, it stays so till the next such jump.
    fireEvent.click(toggle(container)!)
    expect(names(container)).toHaveLength(5)
    jumpTo(207)
    expect(names(container)).toHaveLength(8)
  })

  it("drawn after a jump to one folded away: unfolded", () => {
    const { container } = drawRun(reviews(8), { jump: { id: 207 } })
    expect(names(container)).toHaveLength(8)
  })

  it("a right-click on one quotes that one", async () => {
    const pageScope = scope()
    const { container } = drawRun(reviews(6), { pageScope })
    const entry = container.querySelectorAll("[data-pa-rule-entry]")[2]
    expect(entry.getAttribute("data-pa-part-row")).toBe("202")
    fireEvent.contextMenu(entry.querySelector("[data-pa-rule-name]")!)
    fireEvent.click(await screen.findByRole("menuitem", { name: "Quote" }))
    expect(pageScope.onQuote).toHaveBeenCalledWith(202)
  })

  it("read-only: it still opens, but nothing to press on them", () => {
    const { container } = drawRun(reviews(8), { readOnly: true })
    expect(container.querySelector("[data-pa-rule-act]")).toBeNull()
    expect(container.querySelector("[data-pa-mute-kind]")).toBeNull()
    fireEvent.click(toggle(container)!)
    expect(names(container)).toHaveLength(8)
  })
})
