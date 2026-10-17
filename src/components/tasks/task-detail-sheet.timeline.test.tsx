/**
 * A task the repository panel's auto-processing created says so on its
 * timeline — and which trigger woke it — while a task someone created keeps
 * the plain entry it always had.
 */
import { render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import type { WorkTask, WorkTaskEvent } from "@/lib/types"

import { TaskDetailSheet } from "./task-detail-sheet"

const events: WorkTaskEvent[] = []

vi.mock("@/lib/api", () => ({
  workTaskArchive: vi.fn().mockResolvedValue(undefined),
  workTaskCancel: vi.fn().mockResolvedValue(undefined),
  getFolderConversation: vi.fn().mockRejectedValue(new Error("no transcript")),
  workTaskChangedFiles: vi.fn().mockResolvedValue([]),
  workTaskCleanup: vi.fn().mockResolvedValue(undefined),
  workTaskDelete: vi.fn().mockResolvedValue(undefined),
  workTaskDiff: vi.fn().mockResolvedValue(""),
  workTaskEvents: () => Promise.resolve(events),
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
  TaskMessageComposer: () => <div />,
}))
vi.mock("./task-transcript-dialog", () => ({
  TaskTranscriptDialog: () => null,
}))

function event(id: number, over: Partial<WorkTaskEvent>): WorkTaskEvent {
  return {
    id,
    task_id: 7,
    kind: "created",
    actor: "user",
    payload: null,
    created_at: "2026-10-14T08:00:00Z",
    ...over,
  }
}

function mount() {
  const row = {
    id: 7,
    folder_id: 1,
    title: "#12 · Login times out",
    config: null,
    status: "todo",
    work_branch: null,
    worktree_folder_id: null,
    conversation_id: null,
    archived_at: null,
    scheduled_at: null,
    cleanup_state: null,
    preflight: null,
    files_changed: null,
  } as unknown as WorkTask
  render(
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

describe("task timeline: who created it", () => {
  it("names auto-processing and its trigger", async () => {
    events.splice(
      0,
      events.length,
      event(1, { actor: "auto", payload: { auto: "webhook" } })
    )
    mount()
    expect(
      await screen.findByText("Created by auto-processing")
    ).toBeInTheDocument()
    expect(screen.getByText("webhook")).toBeInTheDocument()
  })

  it("keeps the plain entry for a task someone created", async () => {
    events.splice(0, events.length, event(1, {}))
    mount()
    expect(await screen.findByText("Created")).toBeInTheDocument()
    expect(
      screen.queryByText("Created by auto-processing")
    ).not.toBeInTheDocument()
  })
})
