/**
 * "以后处理" in the drawer — where every action of a task lives.
 *
 * A reviewed or failed task can be put aside to handle later and brought back;
 * a deferred one keeps every acceptance on offer but leads with the step that
 * picks it back up (the follow-up / the retry), the way its card in Done does.
 * Live and in-flight tasks are never offered the deferral.
 */
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import type { WorkTask } from "@/lib/types"

import { TaskDetailSheet } from "./task-detail-sheet"

const workTaskDefer = vi.fn().mockResolvedValue(undefined)

vi.mock("@/lib/api", () => ({
  workTaskArchive: vi.fn().mockResolvedValue(undefined),
  workTaskCancel: vi.fn().mockResolvedValue(undefined),
  getFolderConversation: vi.fn().mockRejectedValue(new Error("no transcript")),
  workTaskChangedFiles: vi.fn().mockResolvedValue([]),
  workTaskCleanup: vi.fn().mockResolvedValue(undefined),
  workTaskDefer: (...args: unknown[]) => workTaskDefer(...args),
  workTaskDelete: vi.fn().mockResolvedValue(undefined),
  workTaskDiff: vi.fn().mockResolvedValue(""),
  workTaskEvents: vi.fn().mockResolvedValue([]),
  workTaskMergeUnqueue: vi.fn().mockResolvedValue(undefined),
  workTaskRequeue: vi.fn().mockResolvedValue(undefined),
  workTaskRetry: vi.fn().mockResolvedValue(undefined),
  workTaskReturn: vi.fn().mockResolvedValue(undefined),
  workTaskStart: vi.fn().mockResolvedValue(undefined),
  // A local reviewed task asks where its project lives (the pull request
  // offer); none here, which is the board without one.
  folderForgeRemote: vi.fn().mockResolvedValue(null),
}))
vi.mock("@/lib/platform", () => ({
  subscribe: vi.fn().mockResolvedValue(() => {}),
  onTransportReconnect: vi.fn(() => () => {}),
}))
vi.mock("@/stores/app-workspace-store", () => {
  const state = {
    allFolders: [{ id: 1, path: "/repo", default_agent_type: null }],
  }
  const useStore = (selector: (s: typeof state) => unknown) => selector(state)
  return { useAppWorkspaceStore: useStore }
})
// Heavy leaves with nothing to say about the action panel.
vi.mock("@/components/ai-elements/message", () => ({
  MessageResponse: ({ children }: { children?: string }) => (
    <div>{children}</div>
  ),
}))
vi.mock("@/components/diff/unified-diff-preview", () => ({
  UnifiedDiffPreview: () => <div />,
}))
vi.mock("./task-message-composer", () => ({
  TaskMessageComposer: () => <div data-testid="follow-up-composer" />,
}))
// See task-detail-sheet.worktree.test.tsx: its module graph reaches a store
// that is stubbed above down to a bare hook.
vi.mock("./task-transcript-dialog", () => ({
  TaskTranscriptDialog: () => null,
}))

const DEFERRED_AT = "2026-08-01T02:00:00Z"

function task(overrides: Partial<WorkTask> = {}): WorkTask {
  return {
    id: 7,
    folder_id: 1,
    title: "Fix the retry path",
    config: null,
    status: "review",
    work_branch: "task/7",
    worktree_folder_id: 9,
    conversation_id: null,
    archived_at: null,
    scheduled_at: null,
    cleanup_state: null,
    preflight: null,
    files_changed: 3,
    ...overrides,
  } as WorkTask
}

function mount(row: WorkTask, onMerge = vi.fn()) {
  render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <TaskDetailSheet
        open
        onOpenChange={() => {}}
        task={row}
        folderName="repo"
        onMerge={onMerge}
        onComplete={() => {}}
        onDeliverPr={() => {}}
        onCancel={() => {}}
        onEdit={() => {}}
        onSchedule={() => {}}
      />
    </NextIntlClientProvider>
  )
  return { onMerge }
}

const button = (name: string) => screen.queryByRole("button", { name })

beforeEach(() => {
  vi.clearAllMocks()
})

describe("task drawer handle-later", () => {
  it("puts a reviewed task aside, with the merge still leading", async () => {
    const user = userEvent.setup()
    mount(task())
    expect(button("Merge")).toHaveAttribute("data-variant", "default")
    await user.click(button("Handle later")!)
    await waitFor(() => expect(workTaskDefer).toHaveBeenCalledWith(7, true))
    expect(button("Back to Needs you")).toBeNull()
  })

  it("leads a deferred review with the follow-up, every acceptance still there", async () => {
    const user = userEvent.setup()
    const { onMerge } = mount(task({ deferred_at: DEFERRED_AT }))
    // The step that picks it back up leads…
    const followUp = button("Follow up")!
    expect(followUp).toHaveAttribute("data-variant", "default")
    await user.click(followUp)
    expect(screen.getByTestId("follow-up-composer")).toBeInTheDocument()
    // …and accepting it outright is still one click, just not the lead.
    const merge = button("Merge")!
    expect(merge).toHaveAttribute("data-variant", "outline")
    await user.click(merge)
    expect(onMerge).toHaveBeenCalledTimes(1)
    // The way back replaces the deferral.
    expect(button("Handle later")).toBeNull()
    await user.click(button("Back to Needs you")!)
    await waitFor(() => expect(workTaskDefer).toHaveBeenCalledWith(7, false))
  })

  it("puts a failed task aside and brings it back, retry leading throughout", async () => {
    const user = userEvent.setup()
    mount(task({ status: "failed" }))
    expect(button("Retry")).toHaveAttribute("data-variant", "default")
    await user.click(button("Handle later")!)
    await waitFor(() => expect(workTaskDefer).toHaveBeenCalledWith(7, true))
  })

  it("brings a deferred failure back without touching its retry", async () => {
    const user = userEvent.setup()
    mount(task({ status: "failed", deferred_at: DEFERRED_AT }))
    expect(button("Retry")).toHaveAttribute("data-variant", "default")
    await user.click(button("Back to Needs you")!)
    await waitFor(() => expect(workTaskDefer).toHaveBeenCalledWith(7, false))
  })

  it("is not offered to live, in-flight, queued or finished tasks", () => {
    for (const row of [
      task({ status: "running" }),
      task({ status: "awaiting_input" }),
      task({ status: "merging" }),
      task({ status: "done" }),
      task({ status: "canceled" }),
      task({
        merge_queued: {
          message: null,
          delete_worktree: true,
          queued_at: "2026-08-01T00:30:00Z",
        },
      }),
      task({ status: "failed", archived_at: DEFERRED_AT }),
    ]) {
      const view = render(
        <NextIntlClientProvider locale="en" messages={enMessages}>
          <TaskDetailSheet
            open
            onOpenChange={() => {}}
            task={row}
            folderName="repo"
            onMerge={() => {}}
            onComplete={() => {}}
            onDeliverPr={() => {}}
            onCancel={() => {}}
            onEdit={() => {}}
            onSchedule={() => {}}
          />
        </NextIntlClientProvider>
      )
      expect(button("Handle later")).toBeNull()
      expect(button("Back to Needs you")).toBeNull()
      view.unmount()
    }
  })
})
