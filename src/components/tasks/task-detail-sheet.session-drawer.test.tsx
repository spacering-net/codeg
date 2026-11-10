/**
 * The detail drawer's "View session" action, and where its viewer is mounted.
 *
 * Placement is the whole point here. The viewer used to be raised through an
 * `onViewSession` callback and rendered by `tasks-page.tsx` as a SIBLING of
 * this drawer, which is invisible to Base UI: stacking rides
 * `DialogRootContext`, so only a drawer mounted inside the opener's React tree
 * is treated as nested. As siblings the viewer simply covered a sheet still
 * sitting at full size underneath it. So the assertion is not "a viewer
 * opened" but "the sheet knows a drawer opened over it" — the
 * `data-nested-drawer-open` Base UI writes onto the parent popup.
 */
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import type { WorkTask } from "@/lib/types"

import { TaskDetailSheet } from "./task-detail-sheet"

vi.mock("@/lib/api", () => ({
  workTaskArchive: vi.fn().mockResolvedValue(undefined),
  workTaskCancel: vi.fn().mockResolvedValue(undefined),
  getFolderConversation: vi.fn().mockRejectedValue(new Error("no transcript")),
  workTaskChangedFiles: vi.fn().mockResolvedValue([]),
  workTaskCleanup: vi.fn().mockResolvedValue(undefined),
  workTaskDelete: vi.fn().mockResolvedValue(undefined),
  workTaskDiff: vi.fn().mockResolvedValue(""),
  workTaskEvents: vi.fn().mockResolvedValue([]),
  workTaskMergeUnqueue: vi.fn().mockResolvedValue(undefined),
  workTaskRequeue: vi.fn().mockResolvedValue(undefined),
  workTaskRetry: vi.fn().mockResolvedValue(undefined),
  workTaskReturn: vi.fn().mockResolvedValue(undefined),
  workTaskStart: vi.fn().mockResolvedValue(undefined),
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

/**
 * The real viewer's module graph reaches the tab store, which reads the
 * app-workspace store at module scope — and that store is stubbed above down
 * to a bare hook. So it is stubbed here too, but as a REAL `Drawer` rather
 * than a sentinel `<div>`: a sentinel would render identically whether the
 * sheet hosts it or the board does, and would prove nothing about nesting.
 */
vi.mock("./task-transcript-dialog", async () => {
  const { Drawer, DrawerContent, DrawerTitle } =
    await import("@/components/ui/drawer")
  return {
    TaskTranscriptDialog: ({
      open,
      onOpenChange,
    }: {
      open: boolean
      onOpenChange: (open: boolean) => void
    }) => (
      <Drawer open={open} onOpenChange={onOpenChange} swipeDirection="right">
        <DrawerContent>
          <DrawerTitle>Session</DrawerTitle>
        </DrawerContent>
      </Drawer>
    ),
  }
})

function task(overrides: Partial<WorkTask> = {}): WorkTask {
  return {
    id: 7,
    folder_id: 1,
    title: "Fix the retry path",
    config: null,
    status: "done",
    work_branch: "task/7",
    worktree_folder_id: null,
    // The footer only offers "View session" once a session exists.
    conversation_id: 100,
    archived_at: null,
    scheduled_at: null,
    cleanup_state: null,
    preflight: null,
    files_changed: 0,
    ...overrides,
  } as WorkTask
}

function mount(row: WorkTask, onCancel: (task: WorkTask) => void = () => {}) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <TaskDetailSheet
        open
        onOpenChange={() => {}}
        task={row}
        folderName="repo"
        onMerge={() => {}}
        onComplete={() => {}}
        onDeliverPr={() => {}}
        onCancel={onCancel}
        onEdit={() => {}}
        onSchedule={() => {}}
      />
    </NextIntlClientProvider>
  )
}

/** The sheet's own popup — the one that must learn it has a drawer over it. */
function sheetPopup() {
  return Array.from(document.querySelectorAll("[data-slot=drawer-popup]")).find(
    (p) => p.textContent?.includes("Fix the retry path")
  )
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe("task drawer session viewer", () => {
  it("opens the viewer as a drawer nested in the sheet", async () => {
    const user = userEvent.setup()
    mount(task())

    expect(sheetPopup()).toBeTruthy()
    expect(sheetPopup()).not.toHaveAttribute("data-nested-drawer-open")
    expect(screen.queryByText("Session")).not.toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: "View session" }))

    await waitFor(() => expect(screen.getByText("Session")).toBeInTheDocument())
    // Nested, not merely on top: the sheet is told to step back.
    expect(sheetPopup()).toHaveAttribute("data-nested-drawer-open")
  })

  it("offers nothing to open when the task has no session yet", async () => {
    mount(task({ conversation_id: null }))
    // Let the sheet's own event/file loads settle before asserting an absence,
    // so the assertion is about the footer and not about timing.
    await waitFor(() => expect(sheetPopup()).toBeTruthy())
    expect(
      screen.queryByRole("button", { name: "View session" })
    ).not.toBeInTheDocument()
  })
})

describe("task drawer awaiting input", () => {
  /** The next-step panel's buttons, without the footer's utilities. */
  function panelButton(name: string) {
    return screen
      .queryAllByRole("button", { name })
      .find((b) => b.closest("section") != null)
  }

  it("explains the wait and leads with answering it in the session", async () => {
    const user = userEvent.setup()
    mount(task({ status: "awaiting_input" }))

    // Says what the agent is waiting for, where a first-time user looks.
    expect(
      screen.getByText(enMessages.Tasks.awaitingInputHint)
    ).toBeInTheDocument()
    const respond = panelButton("Respond")
    expect(respond).toHaveAttribute("data-variant", "default")
    // No filled "cancel" competing with it.
    expect(panelButton("Cancel")).toBeUndefined()

    await user.click(respond!)
    // The same nested viewer the footer opens — where the prompt is pinned.
    await waitFor(() => expect(screen.getByText("Session")).toBeInTheDocument())
    expect(sheetPopup()).toHaveAttribute("data-nested-drawer-open")
  })

  it("keeps stopping the task as the panel's escape hatch", async () => {
    const user = userEvent.setup()
    const onCancel = vi.fn()
    const row = task({ status: "awaiting_input" })
    mount(row, onCancel)

    const cancel = panelButton("Cancel task")
    expect(cancel).toHaveAttribute("data-variant", "ghost")
    await user.click(cancel!)
    expect(onCancel).toHaveBeenCalledWith(row)
  })

  it("leaves a running task's panel to its cancel", () => {
    mount(task({ status: "running" }))
    expect(panelButton("Cancel")).toHaveAttribute("data-variant", "default")
    expect(panelButton("Respond")).toBeUndefined()
    expect(
      screen.queryByText(enMessages.Tasks.awaitingInputHint)
    ).not.toBeInTheDocument()
  })
})
