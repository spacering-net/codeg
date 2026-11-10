/**
 * Where the images in a task's result resolve.
 *
 * The agent writes its summary the way it writes a reply, local images
 * included, so the drawer gives it the folder the agent worked in.
 */
import { render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import type { WorkTask } from "@/lib/types"
import { useTranscriptRoot } from "@/components/ai-elements/markdown-local-image"

import { TaskDetailSheet } from "./task-detail-sheet"

vi.mock("@/lib/api", () => ({
  readFileBase64: vi.fn(),
  readWorkspaceFileBase64: vi.fn(),
  getFolderConversation: vi.fn().mockRejectedValue(new Error("no transcript")),
  workTaskChangedFiles: vi.fn().mockResolvedValue([]),
  workTaskDiff: vi.fn().mockResolvedValue(""),
  workTaskEvents: vi.fn().mockResolvedValue([]),
}))
vi.mock("@/lib/platform", () => ({
  subscribe: vi.fn().mockResolvedValue(() => {}),
  onTransportReconnect: vi.fn(() => () => {}),
}))
vi.mock("@/stores/app-workspace-store", () => {
  const state = {
    allFolders: [
      { id: 1, path: "/repo", default_agent_type: null },
      { id: 9, path: "/repo/.worktrees/task-7", default_agent_type: null },
    ],
  }
  const useStore = (selector: (s: typeof state) => unknown) => selector(state)
  return { useAppWorkspaceStore: useStore }
})
vi.mock("@/components/ai-elements/message", () => ({
  MessageResponse: function MessageResponse({
    children,
  }: {
    children?: string
  }) {
    return (
      <div data-testid="result" data-root={String(useTranscriptRoot())}>
        {children}
      </div>
    )
  },
}))
vi.mock("@/components/diff/unified-diff-preview", () => ({
  UnifiedDiffPreview: () => <div />,
}))
vi.mock("./task-message-composer", () => ({
  TaskMessageComposer: () => <div />,
}))
vi.mock("./task-transcript-dialog", () => ({
  TaskTranscriptDialog: () => null,
}))

function task(overrides: Partial<WorkTask> = {}): WorkTask {
  return {
    id: 7,
    folder_id: 1,
    title: "Capture the login page",
    config: null,
    status: "done",
    work_branch: "task/7",
    worktree_folder_id: 9,
    conversation_id: null,
    archived_at: null,
    scheduled_at: null,
    cleanup_state: null,
    preflight: null,
    files_changed: 0,
    result_summary: "Done: ![login](shots/login.png)",
    ...overrides,
  } as WorkTask
}

function mount(row: WorkTask) {
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
        onCancel={() => {}}
        onEdit={() => {}}
        onSchedule={() => {}}
      />
    </NextIntlClientProvider>
  )
}

describe("task result images", () => {
  it("resolve in the worktree the agent ran in", () => {
    mount(task())
    expect(screen.getByTestId("result")).toHaveAttribute(
      "data-root",
      "/repo/.worktrees/task-7"
    )
  })

  it("resolve in the project when the task had no worktree", () => {
    mount(task({ worktree_folder_id: null }))
    expect(screen.getByTestId("result")).toHaveAttribute("data-root", "/repo")
  })
})
