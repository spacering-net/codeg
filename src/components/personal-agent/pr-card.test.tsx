/**
 * 2.3: the pull requests an assistant watches (7.4) and the PR ladder (8.5)
 * — the card of what one came to, the task card's line of what was last
 * read, and the roster's one line.
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
import type {
  BotLive,
  DispatchInfo,
  PrFacts,
  TaskFacts,
  TimelineRow,
} from "@/lib/types"

const api = vi.hoisted(() => ({
  personalAgentNoticeAct: vi.fn(),
  personalAgentDispatchStop: vi.fn(),
}))
vi.mock("@/lib/api", () => api)
const platform = vi.hoisted(() => ({ openUrl: vi.fn() }))
vi.mock("@/lib/platform", () => platform)
vi.mock("@/lib/link-open", () => ({ openInSystemBrowser: vi.fn() }))
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
import { rowLine } from "./roster"
import { PageScopeContext, type PageScope } from "./shared"
import { LadderChip, TaskStrip } from "./task-strip"

function row(data: Record<string, unknown>): TimelineRow {
  return {
    id: 61,
    segment_id: 1,
    batch_id: null,
    kind: "notice",
    status: null,
    body: "acme/app#7: checks failed",
    data,
    dispatch_id: null,
    ref_id: "31",
    reply_to: null,
    read_at: null,
    event_id: null,
    seen_at: null,
    created_at: "2026-11-12T07:00:00Z",
    updated_at: "2026-11-12T07:00:00Z",
  }
}

function pr(data: Record<string, unknown>): TimelineRow {
  return row({
    notice: "pr",
    event: "checks_failed",
    state: "open",
    watch_id: 4,
    target: "acme/app#7",
    provider: "github",
    number: 7,
    url: "https://github.com/acme/app/pull/7",
    title: "Fix login",
    head: "abc1234",
    checks: {
      available: true,
      partial: false,
      total: 3,
      passed: 1,
      failed: 2,
      pending: 0,
      neutral: 0,
      failing: [
        { name: "build", url: "https://ci/build", summary: null },
        { name: "lint", url: null, summary: "2 errors" },
      ],
    },
    merge_state: null,
    task_id: 45,
    dispatch_id: 12,
    ...data,
  })
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

function wrap(node: React.ReactNode, { zh = false, readOnly = false } = {}) {
  return render(
    <NextIntlClientProvider
      locale={zh ? "zh-CN" : "en"}
      messages={zh ? zhMessages : enMessages}
      timeZone="UTC"
    >
      <PageScopeContext.Provider value={scope(readOnly)}>
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

function watched(patch: Partial<PrFacts> = {}): PrFacts {
  return {
    watch_id: 4,
    phase: "waiting_checks",
    passed: 2,
    failed: 0,
    pending: 1,
    total: 3,
    checks_known: true,
    head: "abc1234",
    merge_state: "unstable",
    last_read_at: "2026-11-12T14:05:00Z",
    stale: false,
    watching: true,
    ...patch,
  }
}

function facts(pr: PrFacts | null): TaskFacts {
  return {
    task_id: 45,
    status: "done",
    folder_id: 2,
    branch: "pa/fix-login",
    base_branch: "main",
    files_changed: 6,
    additions: 214,
    deletions: 37,
    pr_url: "https://github.com/acme/app/pull/7",
    pr_number: 7,
    completion_kind: "delivered_pr",
    conversation_id: null,
    connection_id: null,
    started_at: "2026-11-12T09:00:00Z",
    finished_at: "2026-11-12T10:00:00Z",
    pr,
  }
}

function dispatch(patch: Partial<DispatchInfo>): DispatchInfo {
  return {
    id: 12,
    mode: "task",
    executor: {
      assistant_id: 3,
      name: "Coder",
      agent_type: "claude_code",
    },
    folder_id: 2,
    folder_name: "app",
    deliverable: "change",
    title: "Fix login",
    prompt: "Fix login",
    work_task_id: 45,
    conversation_id: null,
    conversation_folder_id: null,
    connection_id: null,
    state: "completed",
    ladder: "waiting_checks",
    task: facts(watched()),
    ...patch,
  } as DispatchInfo
}

beforeEach(() => {
  api.personalAgentNoticeAct.mockReset().mockResolvedValue({})
  platform.openUrl.mockReset().mockResolvedValue(undefined)
})

afterEach(cleanup)

describe("a PR card", () => {
  it("names the failing checks of its head, with their links", () => {
    const r = pr({})
    expect(waitsForOwner(r)).toBe(false)
    draw(r)
    expect(screen.getByText("Checks failed")).toBeInTheDocument()
    expect(screen.getByText("acme/app#7")).toBeInTheDocument()
    expect(
      screen.getByText("Head abc1234 · Checks 1/3 passed")
    ).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "build" }))
    expect(platform.openUrl).toHaveBeenCalledWith("https://ci/build")
    expect(screen.getByText("lint")).toBeInTheDocument()
    expect(screen.getByText("2 errors")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "View PR" }))
    expect(platform.openUrl).toHaveBeenCalledWith(
      "https://github.com/acme/app/pull/7"
    )
  })

  it("waits on the owner when it can be merged, and stops being watched on [Stop watching]", async () => {
    const r = pr({
      event: "mergeable",
      checks: {
        available: true,
        partial: false,
        total: 3,
        passed: 3,
        failed: 0,
        pending: 0,
        neutral: 0,
        failing: [],
      },
    })
    expect(waitsForOwner(r)).toBe(true)
    draw(r, { zh: true })
    expect(screen.getByText("可以合并了")).toBeInTheDocument()
    expect(
      screen.getByText("头提交 abc1234 · 检查 3/3 通过")
    ).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "不用再盯了" }))
    await waitFor(() =>
      expect(api.personalAgentNoticeAct).toHaveBeenCalledWith(31, "unwatch", 7)
    )
  })

  it("says a card was superseded, and offers nothing but the link then", () => {
    const r = pr({ event: "mergeable", state: "later" })
    expect(waitsForOwner(r)).toBe(false)
    draw(r)
    expect(screen.getByText("It has moved on since.")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Got it" })).toBeNull()
    expect(screen.getByRole("button", { name: "View PR" })).toBeInTheDocument()
  })

  it("never calls a PR whose checks it cannot read ready to merge", () => {
    draw(
      pr({
        event: "no_conflict",
        checks: {
          available: false,
          partial: false,
          total: 0,
          passed: 0,
          failed: 0,
          pending: 0,
          neutral: 0,
          failing: [],
        },
      })
    )
    expect(screen.getByText("No conflict, checks unknown")).toBeInTheDocument()
    expect(screen.queryByText("Ready to merge")).toBeNull()
    expect(
      screen.getByText(/doesn't call it ready to merge/)
    ).toBeInTheDocument()
  })

  it("has no buttons to answer once merged, nor in a read-only page", () => {
    draw(pr({ event: "merged" }))
    expect(screen.getByText("Merged")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Stop watching" })).toBeNull()
    cleanup()
    draw(pr({}), { readOnly: true })
    expect(screen.queryByRole("button", { name: "Got it" })).toBeNull()
  })
})

describe("the PR ladder", () => {
  it("shows how far the checks are, and that the read may be out of date", () => {
    wrap(<LadderChip ladder="waiting_checks" pr={watched()} />, { zh: true })
    expect(screen.getByText("等检查 2/3")).toBeInTheDocument()
    cleanup()
    wrap(
      <TaskStrip
        d={dispatch({ task: facts(watched({ stale: true })) })}
        chip
      />,
      { zh: true }
    )
    expect(
      screen.getByText("检查 2/3 通过 · 1 个在跑 · 头提交 abc1234")
    ).toBeInTheDocument()
    expect(
      screen.getByText("PR 状态可能已过时（上次读到 14:05）")
    ).toBeInTheDocument()
    // Done on the board: past stopping.
    expect(screen.queryByRole("button", { name: "停止" })).toBeNull()
  })

  it("says a pull request ready to merge waits on the forge or is not watched", () => {
    wrap(
      <TaskStrip
        d={dispatch({
          ladder: "pr_open",
          task: facts(
            watched({
              phase: "open",
              passed: 3,
              pending: 0,
              merge_state: "blocked",
            })
          ),
        })}
      />
    )
    expect(
      screen.getByText(
        "Checks 3/3 passed · the forge holds it (blocked) · head abc1234"
      )
    ).toBeInTheDocument()
    cleanup()
    wrap(<TaskStrip d={dispatch({ ladder: "pr_open", task: facts(null) })} />)
    expect(screen.getByText("codeg is not watching it")).toBeInTheDocument()
  })

  it("puts the work to merge first on the roster, then a red one, then the checks", () => {
    const t = ((key: string, values?: Record<string, unknown>) =>
      `${key}${values ? JSON.stringify(values) : ""}`) as never
    const hand = (
      id: number,
      ladder: DispatchInfo["ladder"],
      pr: PrFacts | null = null
    ) => ({
      dispatch_id: id,
      title: `T${id}`,
      mode: "task" as const,
      state: "completed" as const,
      work_task_id: id,
      conversation_id: null,
      ladder,
      pr,
    })
    const live = (patch: Partial<BotLive>): BotLive =>
      ({
        bot_id: 2,
        work: "idle",
        attention: "none",
        needs: null,
        unread: 0,
        activity: null,
        activity_known: true,
        work_on_hand: [],
        awaiting: [],
        face: "idle",
        ...patch,
      }) as BotLive
    const entry = (l: BotLive) => ({ live: l }) as never
    const view = { busy: false } as never
    expect(
      rowLine(
        t,
        entry(
          live({
            attention: "needs_you",
            needs: {
              kind: "mergeable",
              text: "acme/app#7: ready to merge",
              since: "2026-11-12T07:00:00Z",
              row_id: 61,
              count: 1,
            },
            work_on_hand: [hand(12, "mergeable")],
          })
        ),
        view,
        0
      )
    ).toEqual({
      text: 'bots.roster.mergeable{"id":12,"title":"T12"}',
      tone: "ready",
    })
    expect(
      rowLine(
        t,
        entry(
          live({
            work_on_hand: [
              hand(13, "waiting_checks", watched()),
              hand(14, "checks_failed"),
            ],
          })
        ),
        view,
        0
      )?.text
    ).toBe('bots.roster.prFailed{"id":14,"title":"T14"}')
    expect(
      rowLine(
        t,
        entry(live({ work_on_hand: [hand(13, "waiting_checks", watched())] })),
        view,
        0
      )?.text
    ).toBe('bots.roster.prChecks{"id":13,"passed":2,"total":3}')
  })
})
