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
import { LadderChip, TaskStrip } from "./task-strip"

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
    ...patch,
  }
}

function dispatch(patch: Partial<DispatchInfo> = {}): DispatchInfo {
  return {
    id: 234,
    mode: "task",
    executor: {
      assistant_id: 3,
      name: "Builder",
      agent_type: "codex",
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
      executor: "Builder",
      executor_id: 3,
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
      "已提 PR · PR 状态还没跟踪"
    )
    // Left out of the strip: the row above says the rung.
    expect(container.querySelector("[data-pa-ladder]")).toBeNull()
  })

  it("views the pull request, opens the session and stops the work", async () => {
    draw(
      <TaskStrip
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
      <TaskStrip
        d={dispatch({
          ladder: "merged",
          state: "completed",
          task: facts({ status: "done", completion_kind: "merged" }),
        })}
      />
    )
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull()
    merged.unmount()
    draw(<TaskStrip d={dispatch()} />, { readOnly: true })
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
