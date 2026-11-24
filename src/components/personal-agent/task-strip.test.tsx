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
import type { DispatchInfo, TaskFacts, TimelineRow } from "@/lib/types"
import { usePersonalAgentUi } from "@/stores/personal-agent-ui-store"

const api = vi.hoisted(() => ({
  personalAgentDispatchStop: vi.fn(async () => true),
}))
const opener = vi.hoisted(() => ({
  openInSystemBrowser: vi.fn(async () => {}),
}))
const pa = vi.hoisted(() => ({ dispatchById: new Map<number, unknown>() }))
const toasts = vi.hoisted(() => ({ message: vi.fn(), error: vi.fn() }))
vi.mock("@/lib/api", () => api)
vi.mock("@/lib/link-open", () => opener)
vi.mock("sonner", () => ({ toast: toasts }))
vi.mock("@/contexts/personal-agent-context", () => ({
  useBotId: () => 4,
  usePersonalAgent: () => ({
    botId: 4,
    dispatchById: pa.dispatchById,
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

import { EventCard } from "./event-card"
import { buildMessageItems, type MessageItem } from "./message-items"
import { PageScopeContext, type PageScope } from "./shared"
import { LadderChip, TaskActions, TaskStrip } from "./task-strip"

function facts(patch: Partial<TaskFacts> = {}): TaskFacts {
  return {
    task_id: 7,
    status: "running",
    folder_id: 2,
    branch: "pa/fix-cold-start",
    base_branch: "main",
    files_changed: 6,
    additions: 214,
    deletions: 37,
    pr_url: null,
    pr_number: null,
    completion_kind: null,
    conversation_id: 30,
    connection_id: "c7",
    started_at: "2026-11-10T09:00:00Z",
    finished_at: null,
    pr: null,
    ...patch,
  }
}

function dispatch(patch: Partial<DispatchInfo> = {}): DispatchInfo {
  return {
    id: 234,
    mode: "task",
    work: {
      name: "Nova",
      bot_uid: "u4",
      agent_type: "codex",
      agent_options: { config_values: {} },
      label_snapshot: null,
      instructions: "",
    },
    folder_id: 2,
    folder_name: "my-app",
    deliverable: null,
    title: "Fix the cold start",
    prompt: "Fix it",
    work_task_id: 7,
    conversation_id: null,
    conversation_folder_id: null,
    connection_id: null,
    state: "running",
    result_excerpt: null,
    error: null,
    on_done: null,
    turns: 1,
    created_at: "2026-11-10T09:00:00Z",
    updated_at: "2026-11-10T10:00:00Z",
    finished_at: null,
    ladder: "working",
    task: facts(),
    ...patch,
  } as DispatchInfo
}

function scope(patch: Partial<PageScope> = {}): PageScope {
  return {
    readOnly: false,
    agentName: "Nova",
    liveRowId: null,
    connectionId: null,
    agentType: null,
    onQuote: vi.fn(),
    jumpTo: vi.fn(),
    rowsById: new Map(),
    ...patch,
  }
}

function draw(
  node: React.ReactNode,
  { readOnly = false, zh = false }: { readOnly?: boolean; zh?: boolean } = {}
) {
  return render(
    <NextIntlClientProvider
      locale={zh ? "zh-CN" : "en"}
      messages={zh ? zhMessages : enMessages}
    >
      <PageScopeContext.Provider value={scope({ readOnly })}>
        {node}
      </PageScopeContext.Provider>
    </NextIntlClientProvider>
  )
}

function result(id: number, data: Record<string, unknown>): TimelineRow {
  return {
    id,
    segment_id: 1,
    batch_id: null,
    kind: "result",
    status: null,
    body: "Fix the cold start",
    data: {
      agent_type: "codex",
      title: "Fix the cold start",
      mode: "task",
      work_task_id: 7,
      ...data,
    },
    dispatch_id: 234,
    ref_id: null,
    reply_to: null,
    read_at: null,
    event_id: null,
    seen_at: "2026-11-10T10:00:00Z",
    created_at: "2026-11-10T10:00:00Z",
    updated_at: "2026-11-10T10:00:00Z",
  }
}

beforeEach(() => {
  pa.dispatchById = new Map()
  usePersonalAgentUi.setState({ work: null, workOpen: false })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe("the task card", () => {
  it("says where the task stands, on what branch and project, and what it changed", () => {
    const { container } = draw(<TaskStrip d={dispatch()} chip />)
    expect(
      container
        .querySelector("[data-pa-ladder]")
        ?.getAttribute("data-pa-ladder")
    ).toBe("working")
    expect(container.querySelector("[data-pa-ladder]")?.textContent).toBe(
      "Working"
    )
    expect(container.querySelector("[data-pa-task-branch]")?.textContent).toBe(
      "pa/fix-cold-start"
    )
    expect(container.textContent).toContain("my-app")
    expect(container.querySelector("[data-pa-task-diff]")?.textContent).toBe(
      "+214 −37, 6 files"
    )
    // No pull request yet: nothing to view, nothing to say of one.
    expect(screen.queryByRole("button", { name: "View PR" })).toBeNull()
    expect(container.querySelector("[data-pa-task-pr]")).toBeNull()
  })

  it("says the diff and a pull request in the owner's language", () => {
    const { container } = draw(
      <TaskStrip
        d={dispatch({
          ladder: "pr_open",
          state: "completed",
          task: facts({
            status: "done",
            completion_kind: "delivered_pr",
            pr_url: "https://github.com/o/r/pull/9",
            pr_number: 9,
            files_changed: 1,
          }),
        })}
      />,
      { zh: true }
    )
    expect(container.querySelector("[data-pa-task-diff]")?.textContent).toBe(
      "+214 −37，1 个文件"
    )
    expect(container.querySelector("[data-pa-task-pr]")?.textContent).toBe(
      "已提 PR · codeg 没在看护它"
    )
    // Left out of the strip: the row above says the rung.
    expect(container.querySelector("[data-pa-ladder]")).toBeNull()
  })

  it("views the pull request, opens the session and stops the work", async () => {
    draw(
      <TaskActions
        d={dispatch({
          ladder: "mergeable",
          state: "review",
          task: facts({
            status: "review",
            pr_url: "https://github.com/o/r/pull/9",
          }),
        })}
      />
    )
    fireEvent.click(screen.getByRole("button", { name: "View PR" }))
    expect(opener.openInSystemBrowser).toHaveBeenCalledWith(
      "https://github.com/o/r/pull/9"
    )
    fireEvent.click(screen.getByRole("button", { name: "Open session" }))
    expect(usePersonalAgentUi.getState().work).toMatchObject({
      dispatchId: 234,
      workTaskId: 7,
    })
    const stop = screen.getByRole("button", { name: "Stop" })
    api.personalAgentDispatchStop.mockResolvedValueOnce(false)
    fireEvent.click(stop)
    expect(api.personalAgentDispatchStop).toHaveBeenCalledWith(4, 234)
    expect(stop.hasAttribute("disabled")).toBe(true)
    // Past stopping by the time it arrived: said so.
    await waitFor(() =>
      expect(toasts.message).toHaveBeenCalledWith(
        "Too late to stop: it has finished or is merging"
      )
    )
  })

  it("offers no stop on settled work, nor on a read-only page", () => {
    const merged = draw(
      <TaskActions
        d={dispatch({
          ladder: "merged",
          state: "completed",
          task: facts({ status: "done", completion_kind: "merged" }),
        })}
      />
    )
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull()
    merged.unmount()
    draw(<TaskActions d={dispatch()} />, { readOnly: true })
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull()
    expect(screen.getByRole("button", { name: "Open session" })).toBeTruthy()
  })

  it("leaves out a diff it does not know", () => {
    const { container } = draw(
      <TaskStrip
        d={dispatch({ task: facts({ additions: null, deletions: null }) })}
      />
    )
    expect(container.querySelector("[data-pa-task-diff]")).toBeNull()
  })

  it("draws each rung on its tone", () => {
    const { container } = draw(
      <>
        <LadderChip ladder="mergeable" />
        <LadderChip ladder="failed" />
        <LadderChip ladder={null} />
      </>
    )
    const chips = container.querySelectorAll("[data-pa-ladder]")
    expect(chips).toHaveLength(2)
    expect(chips[0].className).toContain("text-teal-700")
    expect(chips[1].className).toContain("text-red-700")
  })
})

describe("the task card on the news", () => {
  function events(rows: TimelineRow[]) {
    return buildMessageItems(rows).filter(
      (i): i is Extract<MessageItem, { kind: "event" }> => i.kind === "event"
    )
  }

  it("rides the latest news of its work only, which says how it stood then", () => {
    pa.dispatchById = new Map([
      [234, dispatch({ ladder: "mergeable", state: "review" })],
    ])
    const [older, latest] = events([
      result(1, { state: "waiting_input", ladder: "waiting_you" }),
      result(2, { state: "review", ladder: "mergeable" }),
    ])
    const first = draw(<EventCard item={older} />)
    // How it stood then, on the row; no card.
    expect(
      first.container.querySelector("[data-pa-work] [data-pa-ladder]")
        ?.textContent
    ).toBe("Waiting for you")
    expect(first.container.querySelector("[data-pa-task-strip]")).toBeNull()
    first.unmount()
    const second = draw(<EventCard item={latest} />)
    const strip = second.container.querySelector("[data-pa-task-strip]")!
    expect(strip).toBeTruthy()
    // The row says the rung it stands on: the strip does not repeat it.
    expect(strip.querySelector("[data-pa-ladder]")).toBeNull()
    expect(strip.textContent).toContain("+214 −37, 6 files")
    // The card in its parts: the work its head, where it stands a band of
    // its own, its buttons the last band — not in the strip.
    const sheet = second.container.querySelector("[data-pa-event-card]")!
    const parts = [...sheet.children]
    expect(parts[0].getAttribute("data-pa-work")).toBe("head")
    expect(strip.closest("[data-pa-sheet-part]")).toBe(parts[1])
    expect(parts[parts.length - 1]?.hasAttribute("data-pa-sheet-actions")).toBe(
      true
    )
    expect(strip.querySelector("button")).toBeNull()
    expect(
      parts[parts.length - 1]?.querySelector('[data-pa-task-act="open"]')
    ).toBeTruthy()
  })

  it("says on the strip where the work stands now when the news is behind it", () => {
    pa.dispatchById = new Map([
      [234, dispatch({ ladder: "merging", state: "running" })],
    ])
    const [news] = events([result(1, { state: "review", ladder: "mergeable" })])
    const { container } = draw(<EventCard item={news} />)
    expect(
      container.querySelector("[data-pa-work] [data-pa-ladder]")?.textContent
    ).toBe("Ready to merge")
    expect(
      container.querySelector("[data-pa-task-strip] [data-pa-ladder]")
        ?.textContent
    ).toBe("Merging")
    // The board is landing it: past stopping.
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull()
  })

  it("keeps the state chip on news from before the ladder", () => {
    const [news] = events([result(1, { state: "completed" })])
    const { container } = draw(<EventCard item={news} />)
    expect(container.querySelector("[data-pa-ladder]")).toBeNull()
    expect(container.querySelector("[data-pa-work]")?.textContent).toContain(
      "Done"
    )
  })
})

describe("acceptance on the news (7.5)", () => {
  function events(rows: TimelineRow[]) {
    return buildMessageItems(rows).filter(
      (i): i is Extract<MessageItem, { kind: "event" }> => i.kind === "event"
    )
  }

  it("says code work in review is being checked, not ready to merge", () => {
    const [news] = events([result(1, { state: "review", ladder: "checking" })])
    const { container } = draw(<EventCard item={news} />, { zh: true })
    const chip = container.querySelector("[data-pa-work] [data-pa-ladder]")!
    expect(chip.textContent).toBe("检查中")
    expect(chip.className).toContain("text-sky-700")
  })

  it("shows a check's round, its verdict and its evidence rather than its whole text", () => {
    const [news] = events([
      result(1, {
        state: "completed",
        ladder: "done",
        mode: "session",
        check_for: 233,
        check_round: 2,
        verdict: "fail",
        evidence: "- evidence: a.txt:1 still says two",
        excerpt: "I read everything first. VERDICT: FAIL",
      }),
    ])
    const { container } = draw(<EventCard item={news} />, { zh: true })
    expect(container.querySelector("[data-pa-check-label]")?.textContent).toBe(
      "验收检查 · 第 2 轮"
    )
    expect(container.querySelector("[data-pa-verdict]")?.textContent).toBe(
      "不通过"
    )
    expect(container.textContent).toContain("a.txt:1 still says two")
    expect(container.textContent).not.toContain("I read everything first")
  })

  it("an interrupted check says its round and no verdict", () => {
    const [news] = events([
      result(1, {
        state: "interrupted",
        mode: "session",
        check_for: 233,
        check_round: 1,
        verdict: null,
        evidence: null,
      }),
    ])
    const { container } = draw(<EventCard item={news} />)
    expect(container.querySelector("[data-pa-check-label]")?.textContent).toBe(
      "Acceptance check · round 1"
    )
    expect(container.querySelector("[data-pa-verdict]")).toBeNull()
  })
})

describe("the acceptance on its work's head (A4)", () => {
  function chain(card: boolean) {
    const head = result(20, { state: "review", ladder: "mergeable" })
    const check: TimelineRow = {
      ...result(21, { check_for: 234, check_round: 1 }),
      kind: "dispatch",
      dispatch_id: 235,
      data: { check_for: 234, check_round: 1, mode: "session" },
    }
    const found: TimelineRow = {
      ...result(22, {}),
      dispatch_id: 235,
      data: {
        check_for: 234,
        check_round: 1,
        verdict: "pass",
        evidence: "- the title reads right",
      },
    }
    const accepted: TimelineRow = {
      ...result(24, {}),
      kind: "notice",
      dispatch_id: null,
      data: {
        notice: "acceptance",
        state: "acted",
        superseded: false,
        phase: "accepted",
        decided_by: "assistant",
        verdict: "pass",
        unchecked: false,
        dispatch_id: 234,
        round: 1,
      },
    }
    const items = buildMessageItems(
      card ? [head, check, found, accepted] : [head, check]
    )
    return items.find((i) => i.kind === "event") as Extract<
      MessageItem,
      { kind: "event" }
    >
  }

  it("says the check is under way, its round, and opens its session", () => {
    pa.dispatchById = new Map([
      [234, dispatch({ ladder: "checking", state: "review" })],
      [
        235,
        dispatch({
          id: 235,
          mode: "session",
          work_task_id: null,
          task: null,
          conversation_id: 50,
        }),
      ],
    ])
    const { container } = draw(<EventCard item={chain(false)} />)
    expect(
      container.querySelector("[data-pa-acceptance-checking]")!.textContent
    ).toBe("Being checked · round 1")
    fireEvent.click(
      container.querySelector("[data-pa-acceptance-session]") as Element
    )
    expect(usePersonalAgentUi.getState().work?.dispatchId).toBe(235)
  })

  it("carries what the check found, its evidence a click away, and the board's next step once accepted", () => {
    pa.dispatchById = new Map([
      [
        234,
        dispatch({
          ladder: "mergeable",
          state: "review",
          task: facts({ status: "review", next: "merge_ready" }),
        }),
      ],
    ])
    const { container } = draw(<EventCard item={chain(true)} />)
    const fold = container.querySelector("[data-pa-acceptance-fold]")!
    expect(fold.querySelector('[data-pa-verdict="pass"]')).toBeTruthy()
    expect(fold.textContent).not.toContain("the title reads right")
    fireEvent.click(
      fold.querySelector("[data-pa-acceptance-evidence]") as Element
    )
    expect(fold.textContent).toContain("the title reads right")
    // [Merge…]: with no board on the page, the work in the drawer.
    const go = container.querySelector(
      '[data-pa-acceptance-go="merge"]'
    ) as HTMLElement
    expect(go.textContent).toBe("Merge…")
    fireEvent.click(go)
    expect(usePersonalAgentUi.getState().work?.dispatchId).toBe(234)
    cleanup()
    // Read-only: said, no button.
    draw(<EventCard item={chain(true)} />, { readOnly: true })
    expect(document.querySelector("[data-pa-acceptance-go]")).toBeNull()
    cleanup()
    // Queued to merge: said so, nothing to press.
    pa.dispatchById = new Map([
      [
        234,
        dispatch({
          ladder: "mergeable",
          state: "review",
          task: facts({ status: "review", next: "accepted_queued" }),
        }),
      ],
    ])
    draw(<EventCard item={chain(true)} />)
    expect(document.querySelector("[data-pa-acceptance-go]")).toBeNull()
    expect(
      document.querySelector('[data-pa-acceptance-next="accepted_queued"]')!
        .textContent
    ).toBe("Accepted — queued to merge")
    cleanup()
    // Merging: the board's own word on the strip, no step of its own.
    pa.dispatchById = new Map([
      [
        234,
        dispatch({
          ladder: "merging",
          state: "review",
          task: facts({ status: "merging" }),
        }),
      ],
    ])
    draw(<EventCard item={chain(true)} />)
    expect(document.querySelector("[data-pa-acceptance-next]")).toBeNull()
  })

  it("says what a round was accepted on from its card when its check is on another page", () => {
    pa.dispatchById = new Map([
      [234, dispatch({ ladder: "mergeable", state: "review" })],
    ])
    const items = buildMessageItems([
      result(20, { state: "review", ladder: "mergeable" }),
      {
        ...result(24, {}),
        kind: "notice",
        dispatch_id: null,
        data: {
          notice: "acceptance",
          state: "acted",
          superseded: false,
          phase: "accepted",
          decided_by: "assistant",
          verdict: "pass",
          unchecked: false,
          dispatch_id: 234,
          round: 2,
          check_dispatch_id: 235,
          evidence: "- it builds",
        },
      },
    ])
    const head = items.find((i) => i.kind === "event") as Extract<
      MessageItem,
      { kind: "event" }
    >
    const { container } = draw(<EventCard item={head} />)
    const fold = container.querySelector("[data-pa-acceptance-fold]")!
    expect(fold.querySelector("[data-pa-acceptance-checking]")).toBeNull()
    expect(fold.querySelector('[data-pa-verdict="pass"]')).toBeTruthy()
    expect(fold.querySelector("[data-pa-acceptance-evidence]")).toBeTruthy()
  })
})
