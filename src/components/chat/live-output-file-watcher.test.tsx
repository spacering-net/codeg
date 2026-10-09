import { render } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  readFileForEdit: vi.fn(),
  applyExternalReload: vi.fn(),
  rejectFileTab: vi.fn(),
  state: {
    activeFileTab: null as null | {
      id: string
      kind: string
      folderId: number | null
      title: string
      description: string | null
      path: string | null
      language: string
      content: string
      loading: boolean
      isDirty?: boolean
      etag?: string | null
      mtimeMs?: number | null
      readonly?: boolean
      lineEnding?: string
      saveState?: string
      stale?: boolean
    },
  },
}))

vi.mock("@/lib/api", () => ({
  readFileForEdit: (...args: unknown[]) => mocks.readFileForEdit(...args),
}))

vi.mock("@/contexts/workspace-context", () => ({
  useWorkspaceFileTabs: () => ({ activeFileTab: mocks.state.activeFileTab }),
  useWorkspaceActions: () => ({
    applyExternalReload: mocks.applyExternalReload,
    rejectFileTab: mocks.rejectFileTab,
  }),
}))

import { LiveOutputFileWatcher } from "./live-output-file-watcher"
import type { AsyncTaskRecord, FileEditContent } from "@/lib/types"
import type { FileWorkspaceTab } from "@/contexts/workspace-context"

const LOG_PATH = "/private/tmp/claude-501/t1.output"
const POLL = 2000

function liveTask(overrides: Partial<AsyncTaskRecord> = {}): AsyncTaskRecord {
  return {
    task_id: "t1",
    name: "pnpm test",
    task_type: "shell",
    description: "",
    show_in_transcript: true,
    can_stop: true,
    state: "running",
    output_file_path: LOG_PATH,
    ...overrides,
  }
}

function fileTab(overrides: Partial<FileWorkspaceTab> = {}): FileWorkspaceTab {
  return {
    id: `file:${LOG_PATH}`,
    kind: "file",
    folderId: null,
    title: "t1.output",
    description: null,
    path: LOG_PATH,
    language: "text",
    content: "line1",
    loading: false,
    isDirty: false,
    etag: "e1",
    mtimeMs: 1,
    readonly: false,
    lineEnding: "lf",
    saveState: "idle",
    stale: false,
    ...overrides,
  }
}

function fetched(overrides: Partial<FileEditContent> = {}): FileEditContent {
  return {
    path: LOG_PATH,
    content: "line1\nline2",
    etag: "e2",
    mtime_ms: 2,
    readonly: false,
    line_ending: "lf",
    ...overrides,
  }
}

// One interval tick plus a microtask drain so the in-flight async chain
// (read → guard → apply) completes.
async function tick() {
  await vi.advanceTimersByTimeAsync(POLL)
  await vi.advanceTimersByTimeAsync(0)
}

beforeEach(() => {
  vi.useFakeTimers()
  mocks.readFileForEdit.mockReset()
  mocks.applyExternalReload.mockReset().mockResolvedValue(undefined)
  mocks.rejectFileTab.mockReset()
  mocks.state.activeFileTab = null
})

afterEach(() => {
  vi.useRealTimers()
})

describe("LiveOutputFileWatcher", () => {
  it("applies a disk change to the active output tab while its task lives", async () => {
    // The strip's "Output" button opens the log and the user watches it grow;
    // the temp-dir path sits outside every notify-watched root, so polling
    // is the only thing that can surface appends.
    mocks.state.activeFileTab = fileTab()
    mocks.readFileForEdit.mockResolvedValue(fetched())
    render(<LiveOutputFileWatcher tasks={[liveTask()]} />)
    await tick()
    expect(mocks.readFileForEdit).toHaveBeenCalledWith(
      "/private/tmp/claude-501",
      "t1.output"
    )
    expect(mocks.applyExternalReload).toHaveBeenCalledWith(
      LOG_PATH,
      expect.objectContaining({ etag: "e2" })
    )
  })

  it("does nothing while the etag still matches", async () => {
    mocks.state.activeFileTab = fileTab()
    mocks.readFileForEdit.mockResolvedValue(fetched({ etag: "e1" }))
    render(<LiveOutputFileWatcher tasks={[liveTask()]} />)
    await tick()
    await tick()
    expect(mocks.applyExternalReload).not.toHaveBeenCalled()
  })

  it("never polls a tab with unsaved edits", async () => {
    // The buffer belongs to the user; the activation pass surfaces the
    // divergence on switch-back instead of clobbering.
    mocks.state.activeFileTab = fileTab({ isDirty: true })
    render(<LiveOutputFileWatcher tasks={[liveTask()]} />)
    await tick()
    expect(mocks.readFileForEdit).not.toHaveBeenCalled()
  })

  it("stops polling the moment the task settles", async () => {
    mocks.state.activeFileTab = fileTab()
    mocks.readFileForEdit.mockResolvedValue(fetched())
    const { rerender } = render(<LiveOutputFileWatcher tasks={[liveTask()]} />)
    await tick()
    expect(mocks.applyExternalReload).toHaveBeenCalledTimes(1)
    mocks.applyExternalReload.mockClear()

    rerender(
      <LiveOutputFileWatcher tasks={[liveTask({ state: "completed" })]} />
    )
    await tick()
    await tick()
    expect(mocks.applyExternalReload).not.toHaveBeenCalled()
  })

  it("ignores an active tab that is not a live task's output", async () => {
    mocks.state.activeFileTab = fileTab({
      id: "file:/repo/notes.txt",
      path: "/repo/notes.txt",
    })
    render(<LiveOutputFileWatcher tasks={[liveTask()]} />)
    await tick()
    expect(mocks.readFileForEdit).not.toHaveBeenCalled()
  })

  it("surfaces a vanished log through rejectFileTab", async () => {
    // The temp sweep can eat the file while the tab sits open — the tab must
    // say so instead of freezing on a stale buffer.
    mocks.state.activeFileTab = fileTab()
    mocks.readFileForEdit.mockRejectedValue(new Error("file is gone"))
    render(<LiveOutputFileWatcher tasks={[liveTask()]} />)
    await tick()
    expect(mocks.rejectFileTab).toHaveBeenCalledWith(LOG_PATH, "file is gone")
  })

  it("drops the change when the tab is switched away mid-read", async () => {
    // The tab identity check runs against the LIVE ref after the read: a
    // late-arriving payload must not paint onto a tab the user has left.
    let resolveRead: (value: FileEditContent) => void = () => {}
    mocks.readFileForEdit.mockImplementationOnce(
      () =>
        new Promise<FileEditContent>((resolve) => {
          resolveRead = resolve
        })
    )
    mocks.state.activeFileTab = fileTab()
    const { rerender } = render(<LiveOutputFileWatcher tasks={[liveTask()]} />)
    await vi.advanceTimersByTimeAsync(POLL) // tick fires, read in flight

    mocks.state.activeFileTab = null
    rerender(<LiveOutputFileWatcher tasks={[liveTask()]} />)
    resolveRead(fetched())
    await tick()
    expect(mocks.applyExternalReload).not.toHaveBeenCalled()
  })
})
