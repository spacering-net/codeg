import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { describe, expect, it, vi } from "vitest"
import enMessages from "@/i18n/messages/en.json"
import type { WorkTask } from "@/lib/types"
import { openUrl } from "@/lib/platform"
import { TaskCard } from "./task-card"

// Partial mock: only the opener is stubbed, so anything else the card's module
// graph pulls from `@/lib/platform` later keeps its real implementation.
vi.mock("@/lib/platform", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/platform")>()),
  openUrl: vi.fn(async () => {}),
}))

function task(overrides?: Partial<WorkTask>): WorkTask {
  return {
    id: 7,
    folder_id: 1,
    title: "Answer the question",
    config: null,
    status: "review",
    failure_reason: null,
    last_error: null,
    run_seq: 1,
    sort_order: 1,
    worktree_folder_id: 9,
    conversation_id: null,
    connection_id: null,
    base_branch: "main",
    base_sha: "abc",
    work_branch: "task/7",
    cleanup_state: null,
    verdict: null,
    result_summary: null,
    files_changed: 0,
    additions: 0,
    deletions: 0,
    merge_commit: null,
    preflight: null,
    archived_at: null,
    scheduled_at: null,
    created_at: "2026-08-01T00:00:00Z",
    updated_at: "2026-08-01T00:00:00Z",
    started_at: null,
    settled_at: null,
    finished_at: null,
    ...overrides,
  }
}

function renderCard(
  t: WorkTask,
  handlers?: Partial<Record<string, () => void>>,
  mergeQueueRank?: number
) {
  const noop = () => {}
  const props = {
    onOpen: noop,
    onStart: noop,
    onCancel: noop,
    onRetry: noop,
    onRequeue: noop,
    onViewSession: noop,
    onMerge: noop,
    onDeliverPr: noop,
    onUnqueueMerge: noop,
    onComplete: noop,
    onArchive: noop,
    onEdit: noop,
    onSchedule: noop,
    ...handlers,
  }
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <TaskCard
        task={t}
        folderName="repo"
        now={Date.parse("2026-08-01T01:00:00Z")}
        mergeQueueRank={mergeQueueRank}
        {...props}
      />
    </NextIntlClientProvider>
  )
}

describe("TaskCard review primary", () => {
  it("offers completion — not a merge — when the task changed nothing", async () => {
    const onMerge = vi.fn()
    const onComplete = vi.fn()
    renderCard(task(), { onMerge, onComplete })

    expect(screen.queryByRole("button", { name: "Merge" })).toBeNull()
    await userEvent.click(screen.getByRole("button", { name: "Complete" }))
    expect(onComplete).toHaveBeenCalledTimes(1)
    expect(onMerge).not.toHaveBeenCalled()
  })

  it("keeps the merge button once the task changed something", () => {
    const onMerge = vi.fn()
    const onComplete = vi.fn()
    renderCard(task({ files_changed: 3, additions: 20, deletions: 1 }), {
      onMerge,
      onComplete,
    })

    expect(screen.getByRole("button", { name: "Merge" })).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Complete" })).toBeNull()
  })

  it("says a queued task is waiting, and offers only the way out of the queue", async () => {
    // Already accepted: re-offering "Merge" would read as if the first click
    // never landed.
    const onUnqueueMerge = vi.fn()
    renderCard(
      task({
        files_changed: 3,
        merge_queued: {
          message: null,
          delete_worktree: true,
          queued_at: "2026-08-01T00:30:00Z",
        },
      }),
      { onUnqueueMerge }
    )

    expect(screen.getByText("Queued to merge")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Merge" })).toBeNull()
    await userEvent.click(
      screen.getByRole("button", { name: "Leave merge queue" })
    )
    expect(onUnqueueMerge).toHaveBeenCalledTimes(1)
  })

  it("spells out the place in line when others are ahead", () => {
    const queued = task({
      files_changed: 3,
      merge_queued: {
        message: null,
        delete_worktree: true,
        queued_at: "2026-08-01T00:30:00Z",
      },
    })
    // Next in line reads plainly — a number there would be noise.
    const first = renderCard(queued, undefined, 1)
    expect(screen.getByText("Queued to merge")).toBeInTheDocument()
    first.unmount()

    renderCard(queued, undefined, 2)
    expect(screen.getByText("Queued to merge · #2")).toBeInTheDocument()
  })
})

describe("TaskCard secondaries", () => {
  it("keeps the session viewer on an archived card", () => {
    // Archiving is exactly when someone wants to reread the session: the
    // "unarchive" primary must not displace the viewer.
    const onViewSession = vi.fn()
    renderCard(
      task({
        status: "done",
        archived_at: "2026-08-01T02:00:00Z",
        conversation_id: 42,
      }),
      { onViewSession }
    )
    expect(
      screen.getByRole("button", { name: "View session" })
    ).toBeInTheDocument()
    expect(
      screen.getByRole("button", { name: "Unarchive" })
    ).toBeInTheDocument()
  })

  it("offers scheduling on a pending card, and only there", async () => {
    const onSchedule = vi.fn()
    renderCard(task({ status: "todo", files_changed: null }), { onSchedule })
    await userEvent.click(screen.getByRole("button", { name: "Schedule" }))
    expect(onSchedule).toHaveBeenCalledTimes(1)

    // A task that already has a run of its own has no start left to plan.
    renderCard(task({ status: "review" }))
    expect(screen.queryAllByRole("button", { name: "Schedule" })).toHaveLength(
      1
    )
  })

  it("shows the planned start on a pending card", () => {
    const planned = new Date(2026, 7, 8, 9, 30)
    renderCard(
      task({
        status: "todo",
        files_changed: null,
        scheduled_at: planned.toISOString(),
      })
    )
    expect(screen.getByTitle(/Scheduled to start at/)).toBeInTheDocument()
  })

  it("does not open the sheet when a footer button is activated by keyboard", async () => {
    const onOpen = vi.fn()
    const onMerge = vi.fn()
    renderCard(task({ files_changed: 3 }), { onOpen, onMerge })

    screen.getByRole("button", { name: "Merge" }).focus()
    await userEvent.keyboard("{Enter}")
    expect(onMerge).toHaveBeenCalledTimes(1)
    // The keydown bubbles to the card — which must neither open the sheet nor
    // cancel the button's own activation.
    expect(onOpen).not.toHaveBeenCalled()
  })
})

describe("TaskCard worktree-removed badge", () => {
  it("flags a deleted worktree in any status — done and canceled included", () => {
    // Detached after removal: the pointer is gone, the branch remains.
    renderCard(task({ status: "done", worktree_folder_id: null }))
    expect(screen.getByText("Worktree removed")).toBeInTheDocument()
  })

  it("flags a worktree whose directory vanished behind the app", () => {
    renderCard(task({ status: "canceled", worktree_missing: true }))
    expect(screen.getByText("Worktree removed")).toBeInTheDocument()
    // "Worktree kept" claims the opposite — it must stay silent here.
    expect(screen.queryByText("Worktree kept")).toBeNull()
  })

  it("keeps the kept-badge for a canceled task whose worktree is intact", () => {
    renderCard(task({ status: "canceled" }))
    expect(screen.getByText("Worktree kept")).toBeInTheDocument()
    expect(screen.queryByText("Worktree removed")).toBeNull()
  })

  it("says nothing on a just-created task that never initialized", () => {
    renderCard(
      task({
        status: "todo",
        files_changed: null,
        worktree_folder_id: null,
        work_branch: null,
        base_branch: null,
        base_sha: null,
      })
    )
    expect(screen.queryByText("Worktree removed")).toBeNull()
  })
})

describe("TaskCard agent mark", () => {
  it("names the agent the task runs under", () => {
    renderCard(task({ agent_type: "claude_code" }))
    expect(screen.getByTitle("Claude Code")).toBeInTheDocument()
  })

  it("draws a placeholder when no agent is configured anywhere", () => {
    // The engine refuses to launch this state; the card still has to lay out
    // its title the way every other card does.
    renderCard(task({ agent_type: null }))
    expect(screen.queryByTitle("Claude Code")).toBeNull()
    expect(screen.getByText("Answer the question")).toBeInTheDocument()
  })
})

describe("TaskCard forge provenance", () => {
  const sourced = () =>
    task({
      source_kind: "forge_issue",
      source_meta: {
        provider: "github",
        server_host: "github.com",
        api_base: "https://api.github.com",
        account_id: "acct-1",
        owner_repo: "acme/widgets",
        number: 123,
        url: "https://github.com/acme/widgets/issues/123",
        title: "Answer the question",
      },
    })

  it("links to the work item it came from", () => {
    renderCard(sourced())
    expect(
      screen.getByRole("link", { name: "#123 · acme/widgets" })
    ).toHaveAttribute("href", "https://github.com/acme/widgets/issues/123")
  })

  it("opens the work item through the platform opener, not the card", async () => {
    // `target="_blank"` alone is inert in the desktop webview — the click has
    // to reach `openUrl`. And it must not also open the detail sheet.
    const onOpen = vi.fn()
    renderCard(sourced(), { onOpen })
    await userEvent.click(
      screen.getByRole("link", { name: "#123 · acme/widgets" })
    )
    expect(openUrl).toHaveBeenCalledWith(
      "https://github.com/acme/widgets/issues/123"
    )
    expect(onOpen).not.toHaveBeenCalled()
  })

  it("keeps the link off the folder/branch line", () => {
    // A repo path beside `repo / task/7` either crowds it or truncates itself
    // into uselessness — the link owns its own row.
    renderCard(sourced())
    const link = screen.getByRole("link", { name: "#123 · acme/widgets" })
    const metaLine = screen.getByText("task/7").parentElement
    expect(metaLine).not.toBeNull()
    expect(metaLine?.contains(link)).toBe(false)
  })
})

describe("TaskCard live note", () => {
  it("explains a card that is parked on its context compaction", () => {
    // Card and row share `liveNote`, so this is the card's half of the same
    // contract: a resumed round spends `preparing` (retry, follow-up) or
    // `merging` (a landing) on a real agent turn, and until it ends the card
    // has nothing else to say for itself.
    renderCard(task({ status: "preparing", compacting: true }))
    expect(screen.getByText("Compacting the session context…")).toBeTruthy()
  })

  it("shows this generation's milestone once the compaction is over", () => {
    renderCard(
      task({
        status: "running",
        compacting: false,
        latest_progress: "installing deps",
      })
    )
    expect(screen.getByText("installing deps")).toBeTruthy()
  })
})
