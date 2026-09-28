import { act, render, screen } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  WorkspaceProvider,
  useWorkspaceActions,
  useWorkspaceContext,
  useWorkspaceExternalConflict,
  useWorkspaceFileTabs,
  useWorkspaceView,
} from "@/contexts/workspace-context"
import * as api from "@/lib/api"
import {
  claimSurfaceCreation,
  forgetSurfaceCreation,
  getBrowserTabState,
  markBrowserTabHidden,
  resetBrowserTabStoreForTests,
  setBrowserTabState,
} from "@/lib/browser/browser-tab-store"
import {
  resetBrowserPrefsForTests,
  setBrowserNewTabProfile,
  setBrowserProfiles,
} from "@/lib/browser/browser-prefs"
import {
  peekClosedTab,
  popClosedTab,
  resetClosedTabStackForTests,
} from "@/lib/closed-tab-stack"
import { resetHomeDirCacheForTests } from "@/lib/file-open-target"
import {
  resetAppWorkspaceStore,
  useAppWorkspaceStore,
} from "@/stores/app-workspace-store"

vi.mock("next-intl", () => {
  // Return a STABLE function instance across renders, mirroring next-intl's
  // real behavior. An unstable `t` would churn every action callback that
  // lists it as a dependency, silently breaking the actions-context
  // stability the render-isolation suite asserts.
  const t = (key: string, values?: Record<string, string>) =>
    values ? `${key}:${JSON.stringify(values)}` : key
  return { useTranslations: () => t }
})

// Active-folder store backing the active-folder mock below. Tests switch the
// active folder inside act() and consumers re-render via
// useSyncExternalStore. Workspace folder lists (allFolders / foldersHydrated)
// live in the REAL app-workspace zustand store — seeded in beforeEach and
// mutated with useAppWorkspaceStore.setState inside act().
const foldersMock = vi.hoisted(() => {
  type FolderLike = { id: number; path: string; name: string; color: string }
  const allFolders: FolderLike[] = [
    { id: 1, path: "/repo", name: "repo", color: "inherit" },
    { id: 2, path: "/repo2", name: "repo2", color: "inherit" },
  ]
  let activeFolderId: number | null = 1
  let snapshot: {
    allFolders: FolderLike[]
    activeFolderId: number | null
  } = { allFolders, activeFolderId }
  const listeners = new Set<() => void>()
  const commit = () => {
    snapshot = { allFolders, activeFolderId }
    for (const listener of [...listeners]) listener()
  }
  return {
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    getSnapshot: () => snapshot,
    setActiveFolderId(id: number | null) {
      activeFolderId = id
      commit()
    },
    reset() {
      activeFolderId = 1
      commit()
    },
  }
})

// A window bound to a remote codeg-server, when a test says so.
const remoteMock = vi.hoisted(() => ({
  remote: false,
  serverBaseUrl: "https://dev.example.com",
}))
vi.mock(import("@/lib/transport"), async (importOriginal) => ({
  ...(await importOriginal()),
  isRemoteDesktopMode: () => remoteMock.remote,
  getServerBaseUrl: () => remoteMock.serverBaseUrl,
}))

vi.mock("@/contexts/active-folder-context", async () => {
  const { useSyncExternalStore } = await import("react")
  return {
    useActiveFolder: () => {
      const snap = useSyncExternalStore(
        foldersMock.subscribe,
        foldersMock.getSnapshot,
        foldersMock.getSnapshot
      )
      const activeFolder =
        snap.allFolders.find((f) => f.id === snap.activeFolderId) ?? null
      return { activeFolder, activeFolderId: snap.activeFolderId }
    },
  }
})

beforeEach(() => {
  foldersMock.reset()
  // The provider reads workspace folders from the real zustand store: restore
  // pristine state, then seed the same default folders the active-folder mock
  // serves (partial FolderDetail shapes — the provider only reads id/path).
  resetAppWorkspaceStore()
  useAppWorkspaceStore.setState({
    allFolders: [
      { id: 1, path: "/repo", name: "repo", color: "inherit" },
      { id: 2, path: "/repo2", name: "repo2", color: "inherit" },
    ] as never,
    foldersHydrated: true,
  })
})

vi.mock("@/lib/api", () => ({
  getHomeDirectory: vi.fn(),
  listDirectoryWithFiles: vi.fn(),
  readFileForEdit: vi.fn(),
  readFileBase64: vi.fn(),
  readFilePreview: vi.fn(),
  gitIsTracked: vi.fn(),
  gitShowFile: vi.fn(),
  gitDiff: vi.fn(),
  gitDiffWithBranch: vi.fn(),
  gitShowDiff: vi.fn(),
  saveFileContent: vi.fn(),
  saveFileCopy: vi.fn(),
}))

// Controllable workspace-state store: WorkspaceProvider subscribes to its
// envelopes to auto-open office previews (hook path), and the tab watcher
// acquires per-root imperative stores (getWorkspaceStateStore path).
// `emitEnvelope` pushes an event on the office/hook stream; `emitRoot`
// pushes on a specific root's imperative store as if that folder's file
// watcher fired. Acquire/release totals are tracked per root so tests can
// assert subscription stability (no churn on keystrokes).
const workspaceStoreMock = vi.hoisted(() => {
  type EnvelopeListener = (env: {
    seq: number
    kind: string
    changed_paths: string[]
  }) => void
  const listeners = new Set<EnvelopeListener>()
  interface FakeRootStore {
    acquired: number
    acquireCalls: number
    listeners: Set<EnvelopeListener>
    store: {
      acquire: () => void
      release: () => void
      subscribeEnvelopes: (listener: EnvelopeListener) => () => void
    }
  }
  const storeByRoot = new Map<string, FakeRootStore>()
  const getRootEntry = (rootPath: string): FakeRootStore => {
    let entry = storeByRoot.get(rootPath)
    if (!entry) {
      const rootListeners = new Set<EnvelopeListener>()
      const created: FakeRootStore = {
        acquired: 0,
        acquireCalls: 0,
        listeners: rootListeners,
        store: {
          acquire: () => {
            created.acquired += 1
            created.acquireCalls += 1
          },
          release: () => {
            created.acquired -= 1
          },
          subscribeEnvelopes: (listener: EnvelopeListener) => {
            rootListeners.add(listener)
            return () => {
              rootListeners.delete(listener)
            }
          },
        },
      }
      entry = created
      storeByRoot.set(rootPath, entry)
    }
    return entry
  }
  return {
    subscribeEnvelopes: (listener: EnvelopeListener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    emitEnvelope: (changed_paths: string[]) => {
      for (const listener of [...listeners]) {
        listener({ seq: 1, kind: "fs_change", changed_paths })
      }
    },
    getStore: (rootPath: string) => getRootEntry(rootPath).store,
    emitRoot: (
      rootPath: string,
      changed_paths: string[],
      kind = "fs_change"
    ) => {
      const entry = storeByRoot.get(rootPath)
      if (!entry) return
      for (const listener of [...entry.listeners]) {
        listener({ seq: 1, kind, changed_paths })
      }
    },
    acquiredCount: (rootPath: string) =>
      storeByRoot.get(rootPath)?.acquired ?? 0,
    acquireCalls: (rootPath: string) =>
      storeByRoot.get(rootPath)?.acquireCalls ?? 0,
    reset: () => {
      listeners.clear()
      storeByRoot.clear()
    },
  }
})

vi.mock("@/hooks/use-workspace-state-store", () => ({
  useWorkspaceStateStore: () => ({
    rootPath: "/repo",
    seq: 0,
    version: 1,
    health: "healthy" as const,
    tree: [],
    git: [],
    error: null,
    degraded: false,
    isGitRepo: true,
    requestResync: async () => {},
    restart: async () => {},
    subscribeEnvelopes: workspaceStoreMock.subscribeEnvelopes,
  }),
  getWorkspaceStateStore: (rootPath: string) =>
    workspaceStoreMock.getStore(rootPath),
}))

beforeEach(() => {
  workspaceStoreMock.reset()
})

const mockedApi = api as unknown as {
  getHomeDirectory: ReturnType<typeof vi.fn>
  readFileForEdit: ReturnType<typeof vi.fn>
  gitIsTracked: ReturnType<typeof vi.fn>
  gitShowFile: ReturnType<typeof vi.fn>
  saveFileContent: ReturnType<typeof vi.fn>
}

// Tab identity under the unified model: file tabs are keyed by the
// absolute path alone.
const fileTabId = (absPath: string) => `file:${encodeURIComponent(absPath)}`

function WorkspaceProbe() {
  const {
    mode,
    activePane,
    fileTabs,
    activeFileTabId,
    filesMaximized,
    openSessionFileDiff,
    openFilePreview,
    closeFileTab,
    closeAllFileTabs,
    toggleFilesMaximized,
    activateConversationPane,
  } = useWorkspaceContext()

  return (
    <div>
      <button type="button" onClick={() => void openFilePreview("report.docx")}>
        Open office by hand
      </button>
      <output data-testid="mode">{mode}</output>
      <output data-testid="file-tab-count">{fileTabs.length}</output>
      <output data-testid="active-pane">{activePane}</output>
      <output data-testid="files-maximized">{String(filesMaximized)}</output>
      <output data-testid="active-file-tab">{activeFileTabId ?? "none"}</output>
      <button
        type="button"
        onClick={() =>
          openSessionFileDiff("src/app.ts", "diff --git", "Turn 1")
        }
      >
        Open diff
      </button>
      <button
        type="button"
        onClick={() =>
          openSessionFileDiff("src/other.ts", "diff --git", "Turn 1")
        }
      >
        Open diff 2
      </button>
      <button
        type="button"
        onClick={() => activeFileTabId && closeFileTab(activeFileTabId)}
      >
        Close active
      </button>
      <button type="button" onClick={closeAllFileTabs}>
        Close all
      </button>
      <button type="button" onClick={toggleFilesMaximized}>
        Toggle maximize
      </button>
      <button type="button" onClick={activateConversationPane}>
        Activate conversation
      </button>
    </div>
  )
}

function renderWorkspace() {
  return render(
    <WorkspaceProvider>
      <WorkspaceProbe />
    </WorkspaceProvider>
  )
}

describe("WorkspaceProvider mode", () => {
  it("derives conversation mode from an empty file workspace", () => {
    localStorage.setItem("workspace:mode", JSON.stringify({ mode: "files" }))

    renderWorkspace()

    expect(screen.getByTestId("mode")).toHaveTextContent("conversation")
    expect(screen.getByTestId("file-tab-count")).toHaveTextContent("0")
  })

  it("derives fusion mode while file tabs are open and returns to conversation when they close", () => {
    renderWorkspace()

    act(() => {
      screen.getByRole("button", { name: "Open diff" }).click()
    })

    expect(screen.getByTestId("mode")).toHaveTextContent("fusion")
    expect(screen.getByTestId("file-tab-count")).toHaveTextContent("1")

    act(() => {
      screen.getByRole("button", { name: "Close all" }).click()
    })

    expect(screen.getByTestId("mode")).toHaveTextContent("conversation")
    expect(screen.getByTestId("file-tab-count")).toHaveTextContent("0")
  })
})

describe("WorkspaceProvider files-maximized", () => {
  it("toggles filesMaximized only while files are open", () => {
    renderWorkspace()

    // No files yet — toggling should not enable maximize (derived value gated
    // on fusion mode).
    act(() => {
      screen.getByRole("button", { name: "Toggle maximize" }).click()
    })
    expect(screen.getByTestId("files-maximized")).toHaveTextContent("false")

    // Open a file, then toggle: maximize flips on, then off.
    act(() => {
      screen.getByRole("button", { name: "Open diff" }).click()
    })
    expect(screen.getByTestId("mode")).toHaveTextContent("fusion")

    act(() => {
      screen.getByRole("button", { name: "Toggle maximize" }).click()
    })
    expect(screen.getByTestId("files-maximized")).toHaveTextContent("true")

    act(() => {
      screen.getByRole("button", { name: "Toggle maximize" }).click()
    })
    expect(screen.getByTestId("files-maximized")).toHaveTextContent("false")
  })

  it("does not mutate active pane on maximize toggle, preserving revert semantics", () => {
    renderWorkspace()

    act(() => {
      screen.getByRole("button", { name: "Open diff" }).click()
    })
    // Opening a file routes activePane to "files".
    expect(screen.getByTestId("active-pane")).toHaveTextContent("files")

    act(() => {
      screen.getByRole("button", { name: "Toggle maximize" }).click()
    })
    // Maximize must not silently rewrite the user's last-active pane.
    expect(screen.getByTestId("active-pane")).toHaveTextContent("files")
    expect(screen.getByTestId("files-maximized")).toHaveTextContent("true")

    act(() => {
      screen.getByRole("button", { name: "Toggle maximize" }).click()
    })
    expect(screen.getByTestId("active-pane")).toHaveTextContent("files")
    expect(screen.getByTestId("files-maximized")).toHaveTextContent("false")
  })

  it("resets filesMaximized when all file tabs close, and does not leak into newly reopened files", () => {
    renderWorkspace()

    act(() => {
      screen.getByRole("button", { name: "Open diff" }).click()
    })
    act(() => {
      screen.getByRole("button", { name: "Toggle maximize" }).click()
    })
    expect(screen.getByTestId("files-maximized")).toHaveTextContent("true")

    act(() => {
      screen.getByRole("button", { name: "Close all" }).click()
    })
    expect(screen.getByTestId("mode")).toHaveTextContent("conversation")
    expect(screen.getByTestId("files-maximized")).toHaveTextContent("false")

    // Reopening a file must start from the normal split, not a stale maximized
    // layout.
    act(() => {
      screen.getByRole("button", { name: "Open diff" }).click()
    })
    expect(screen.getByTestId("mode")).toHaveTextContent("fusion")
    expect(screen.getByTestId("files-maximized")).toHaveTextContent("false")
  })

  it("resets filesMaximized when the last tab is closed individually", () => {
    renderWorkspace()

    act(() => {
      screen.getByRole("button", { name: "Open diff" }).click()
    })
    act(() => {
      screen.getByRole("button", { name: "Toggle maximize" }).click()
    })
    expect(screen.getByTestId("files-maximized")).toHaveTextContent("true")

    act(() => {
      screen.getByRole("button", { name: "Close active" }).click()
    })
    expect(screen.getByTestId("file-tab-count")).toHaveTextContent("0")
    expect(screen.getByTestId("files-maximized")).toHaveTextContent("false")
  })

  it("exits filesMaximized when activating the conversation pane while files stay open", () => {
    renderWorkspace()

    act(() => {
      screen.getByRole("button", { name: "Open diff" }).click()
    })
    act(() => {
      screen.getByRole("button", { name: "Toggle maximize" }).click()
    })
    expect(screen.getByTestId("files-maximized")).toHaveTextContent("true")
    expect(screen.getByTestId("file-tab-count")).toHaveTextContent("1")

    // Mirrors what happens when the user opens a session from the sidebar:
    // TabContext.openTab -> activateConversationPane(). The overlay must
    // release so the conversation becomes visible, but the file tab itself
    // must remain so the user can return to it later.
    act(() => {
      screen.getByRole("button", { name: "Activate conversation" }).click()
    })
    expect(screen.getByTestId("files-maximized")).toHaveTextContent("false")
    expect(screen.getByTestId("active-pane")).toHaveTextContent("conversation")
    expect(screen.getByTestId("file-tab-count")).toHaveTextContent("1")
    expect(screen.getByTestId("mode")).toHaveTextContent("fusion")
  })

  it("does not touch file tab data when toggling maximize", () => {
    renderWorkspace()

    act(() => {
      screen.getByRole("button", { name: "Open diff" }).click()
      screen.getByRole("button", { name: "Open diff 2" }).click()
    })
    const tabCountBefore =
      screen.getByTestId("file-tab-count").textContent ?? ""
    const activeBefore = screen.getByTestId("active-file-tab").textContent ?? ""

    act(() => {
      screen.getByRole("button", { name: "Toggle maximize" }).click()
    })
    expect(screen.getByTestId("file-tab-count")).toHaveTextContent(
      tabCountBefore
    )
    expect(screen.getByTestId("active-file-tab")).toHaveTextContent(
      activeBefore
    )

    act(() => {
      screen.getByRole("button", { name: "Toggle maximize" }).click()
    })
    expect(screen.getByTestId("file-tab-count")).toHaveTextContent(
      tabCountBefore
    )
    expect(screen.getByTestId("active-file-tab")).toHaveTextContent(
      activeBefore
    )
  })
})

interface CapturedTab {
  content: string
  loading: boolean
  saveState?: string
}

function FilePreviewProbe({
  onCapture,
}: {
  onCapture?: (tab: CapturedTab | null) => void
}) {
  const { openFilePreview, activeFileTab } = useWorkspaceContext()
  const snapshot: CapturedTab | null = activeFileTab
    ? {
        content: activeFileTab.content,
        loading: activeFileTab.loading,
        saveState: activeFileTab.saveState,
      }
    : null
  onCapture?.(snapshot)
  return (
    <div>
      <output data-testid="content">{activeFileTab?.content ?? ""}</output>
      <output data-testid="loading">
        {String(activeFileTab?.loading ?? false)}
      </output>
      <output data-testid="save-state">
        {activeFileTab?.saveState ?? "none"}
      </output>
      <button onClick={() => void openFilePreview("a.ts")}>open</button>
      <button onClick={() => void openFilePreview("a.ts", { reload: true })}>
        reload
      </button>
    </div>
  )
}

describe("openFilePreview cache semantics", () => {
  beforeEach(() => {
    mockedApi.readFileForEdit.mockReset()
    mockedApi.gitIsTracked.mockReset()
    mockedApi.gitShowFile.mockReset()
    mockedApi.gitIsTracked.mockResolvedValue(false)
  })

  it("activates an already-loaded tab without refetching", async () => {
    mockedApi.readFileForEdit.mockResolvedValue({
      path: "a.ts",
      content: "hello",
      etag: "e1",
      mtime_ms: 1,
      readonly: false,
      line_ending: "lf",
    })

    render(
      <WorkspaceProvider>
        <FilePreviewProbe />
      </WorkspaceProvider>
    )

    await act(async () => {
      screen.getByText("open").click()
    })
    expect(screen.getByTestId("content")).toHaveTextContent("hello")
    expect(mockedApi.readFileForEdit).toHaveBeenCalledTimes(1)

    // Second click on the same file — pure cache hit.
    await act(async () => {
      screen.getByText("open").click()
    })
    expect(mockedApi.readFileForEdit).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId("loading")).toHaveTextContent("false")
    expect(screen.getByTestId("content")).toHaveTextContent("hello")
  })

  it("forces refetch when reload: true and preserves content during fetch", async () => {
    let resolveSecond:
      | ((v: {
          path: string
          content: string
          etag: string
          mtime_ms: number
          readonly: boolean
          line_ending: "lf"
        }) => void)
      | null = null
    mockedApi.readFileForEdit
      .mockResolvedValueOnce({
        path: "a.ts",
        content: "v1",
        etag: "e1",
        mtime_ms: 1,
        readonly: false,
        line_ending: "lf",
      })
      .mockImplementationOnce(() => new Promise((res) => (resolveSecond = res)))

    let captured = null as CapturedTab | null
    render(
      <WorkspaceProvider>
        <FilePreviewProbe onCapture={(t) => (captured = t)} />
      </WorkspaceProvider>
    )

    await act(async () => {
      screen.getByText("open").click()
    })
    expect(captured).toMatchObject({ content: "v1", loading: false })

    await act(async () => {
      screen.getByText("reload").click()
    })
    // Mid-fetch: content preserved, loading true.
    expect(captured).toMatchObject({ content: "v1", loading: true })

    await act(async () => {
      resolveSecond!({
        path: "a.ts",
        content: "v2",
        etag: "e2",
        mtime_ms: 2,
        readonly: false,
        line_ending: "lf",
      })
    })
    expect(captured).toMatchObject({ content: "v2", loading: false })
  })

  it("deduplicates concurrent opens of the same path", async () => {
    let resolveFirst:
      | ((v: {
          path: string
          content: string
          etag: string
          mtime_ms: number
          readonly: boolean
          line_ending: "lf"
        }) => void)
      | null = null
    mockedApi.readFileForEdit.mockImplementationOnce(
      () => new Promise((res) => (resolveFirst = res))
    )

    render(
      <WorkspaceProvider>
        <FilePreviewProbe />
      </WorkspaceProvider>
    )

    await act(async () => {
      screen.getByText("open").click()
      screen.getByText("open").click()
      screen.getByText("open").click()
    })
    expect(mockedApi.readFileForEdit).toHaveBeenCalledTimes(1)

    await act(async () => {
      resolveFirst!({
        path: "a.ts",
        content: "x",
        etag: "e1",
        mtime_ms: 1,
        readonly: false,
        line_ending: "lf",
      })
    })
  })

  it("retries after an error and clears the error state", async () => {
    mockedApi.readFileForEdit
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce({
        path: "a.ts",
        content: "ok",
        etag: "e",
        mtime_ms: 1,
        readonly: false,
        line_ending: "lf",
      })

    let captured = null as CapturedTab | null
    render(
      <WorkspaceProvider>
        <FilePreviewProbe onCapture={(t) => (captured = t)} />
      </WorkspaceProvider>
    )

    await act(async () => {
      screen.getByText("open").click()
    })
    expect(captured?.saveState).toBe("error")

    await act(async () => {
      screen.getByText("open").click()
    })
    expect(captured).toMatchObject({
      content: "ok",
      loading: false,
      saveState: "idle",
    })
    expect(mockedApi.readFileForEdit).toHaveBeenCalledTimes(2)
  })

  it("does not resurrect a closed tab when reload: true arrives late", async () => {
    mockedApi.readFileForEdit.mockResolvedValue({
      path: "a.ts",
      content: "v1",
      etag: "e1",
      mtime_ms: 1,
      readonly: false,
      line_ending: "lf",
    })

    function Probe() {
      const { openFilePreview, fileTabs, activeFileTabId, closeAllFileTabs } =
        useWorkspaceContext()
      return (
        <div>
          <output data-testid="tab-count">{fileTabs.length}</output>
          <output data-testid="active-id">{activeFileTabId ?? "none"}</output>
          <button onClick={() => void openFilePreview("a.ts")}>open</button>
          <button
            onClick={() => void openFilePreview("a.ts", { reload: true })}
          >
            reload
          </button>
          <button onClick={closeAllFileTabs}>close all</button>
        </div>
      )
    }

    render(
      <WorkspaceProvider>
        <Probe />
      </WorkspaceProvider>
    )

    await act(async () => {
      screen.getByText("open").click()
    })
    expect(screen.getByTestId("tab-count")).toHaveTextContent("1")

    await act(async () => {
      screen.getByText("close all").click()
    })
    expect(screen.getByTestId("tab-count")).toHaveTextContent("0")

    // Simulate a watcher-driven reload that lands after the user closed
    // the tab. The reload should be a no-op — never create a phantom tab.
    await act(async () => {
      screen.getByText("reload").click()
    })
    expect(screen.getByTestId("tab-count")).toHaveTextContent("0")
    expect(screen.getByTestId("active-id")).toHaveTextContent("none")
    // The closed-and-reload sequence triggered only the initial open.
    expect(mockedApi.readFileForEdit).toHaveBeenCalledTimes(1)
  })

  it("clears in-flight tracking on close so reopen is not falsely deduped", async () => {
    let resolveFirst:
      | ((v: {
          path: string
          content: string
          etag: string
          mtime_ms: number
          readonly: boolean
          line_ending: "lf"
        }) => void)
      | null = null
    mockedApi.readFileForEdit
      .mockImplementationOnce(() => new Promise((res) => (resolveFirst = res)))
      .mockResolvedValueOnce({
        path: "a.ts",
        content: "v2",
        etag: "e2",
        mtime_ms: 2,
        readonly: false,
        line_ending: "lf",
      })

    let captured = null as CapturedTab | null
    function Probe({
      onCapture,
    }: {
      onCapture: (tab: CapturedTab | null) => void
    }) {
      const { openFilePreview, activeFileTab, closeAllFileTabs } =
        useWorkspaceContext()
      onCapture(
        activeFileTab
          ? {
              content: activeFileTab.content,
              loading: activeFileTab.loading,
              saveState: activeFileTab.saveState,
            }
          : null
      )
      return (
        <div>
          <button onClick={() => void openFilePreview("a.ts")}>open</button>
          <button onClick={closeAllFileTabs}>close all</button>
        </div>
      )
    }

    render(
      <WorkspaceProvider>
        <Probe onCapture={(t) => (captured = t)} />
      </WorkspaceProvider>
    )

    // Start a load and immediately close (load is still pending).
    await act(async () => {
      screen.getByText("open").click()
    })
    await act(async () => {
      screen.getByText("close all").click()
    })

    // Reopen — the stale in-flight marker should have been cleared, so
    // the second fetch must run and populate content (not get deduped).
    await act(async () => {
      screen.getByText("open").click()
    })

    // Drain the original (now-orphaned) fetch — it should no-op since
    // its target tab id was removed during close.
    await act(async () => {
      resolveFirst!({
        path: "a.ts",
        content: "v1",
        etag: "e1",
        mtime_ms: 1,
        readonly: false,
        line_ending: "lf",
      })
    })

    expect(captured).toMatchObject({ content: "v2", loading: false })
    expect(mockedApi.readFileForEdit).toHaveBeenCalledTimes(2)
  })
})

interface BackgroundProbeSnapshot {
  activeId: string | null
  tabs: Array<{
    id: string
    path: string | null
    content: string
    isDirty: boolean
    stale: boolean
  }>
}

function BackgroundReloadProbe({
  onCapture,
}: {
  onCapture: (snapshot: BackgroundProbeSnapshot) => void
}) {
  const {
    openFilePreview,
    fileTabs,
    activeFileTabId,
    reloadOpenFileBackground,
    markTabsStale,
    updateActiveFileContent,
    switchFileTab,
  } = useWorkspaceContext()
  onCapture({
    activeId: activeFileTabId,
    tabs: fileTabs.map((tab) => ({
      id: tab.id,
      path: tab.path,
      content: tab.content,
      isDirty: Boolean(tab.isDirty),
      stale: Boolean(tab.stale),
    })),
  })
  return (
    <div>
      <button onClick={() => void openFilePreview("a.ts")}>open-a</button>
      <button onClick={() => void openFilePreview("b.ts")}>open-b</button>
      <button onClick={() => void reloadOpenFileBackground("/repo/a.ts")}>
        bg-reload-a
      </button>
      <button onClick={() => markTabsStale("/repo/a.ts")}>stale-a</button>
      <button onClick={() => updateActiveFileContent("dirty-local")}>
        edit
      </button>
      <button onClick={() => switchFileTab(fileTabId("/repo/a.ts"))}>
        switch-a
      </button>
    </div>
  )
}

describe("background reload + stale semantics", () => {
  beforeEach(() => {
    mockedApi.readFileForEdit.mockReset()
    mockedApi.gitIsTracked.mockReset()
    mockedApi.gitShowFile.mockReset()
    mockedApi.gitIsTracked.mockResolvedValue(false)
  })

  it("reloadOpenFileBackground refreshes content without changing activeFileTabId", async () => {
    mockedApi.readFileForEdit
      .mockResolvedValueOnce({
        path: "a.ts",
        content: "a-v1",
        etag: "ea1",
        mtime_ms: 1,
        readonly: false,
        line_ending: "lf",
      })
      .mockResolvedValueOnce({
        path: "b.ts",
        content: "b-v1",
        etag: "eb1",
        mtime_ms: 1,
        readonly: false,
        line_ending: "lf",
      })
      .mockResolvedValueOnce({
        path: "a.ts",
        content: "a-v2",
        etag: "ea2",
        mtime_ms: 2,
        readonly: false,
        line_ending: "lf",
      })

    let snap: BackgroundProbeSnapshot = { activeId: null, tabs: [] }
    render(
      <WorkspaceProvider>
        <BackgroundReloadProbe onCapture={(s) => (snap = s)} />
      </WorkspaceProvider>
    )

    await act(async () => {
      screen.getByText("open-a").click()
    })
    await act(async () => {
      screen.getByText("open-b").click()
    })
    expect(snap.activeId).toBe(fileTabId("/repo/b.ts"))

    await act(async () => {
      screen.getByText("bg-reload-a").click()
    })

    // active tab stays on B; tab A content refreshed in place.
    expect(snap.activeId).toBe(fileTabId("/repo/b.ts"))
    const tabA = snap.tabs.find((t) => t.id === fileTabId("/repo/a.ts"))
    expect(tabA?.content).toBe("a-v2")
    expect(mockedApi.readFileForEdit).toHaveBeenCalledTimes(3)
  })

  it("markTabsStale flips stale=true on the matching non-active tab", async () => {
    mockedApi.readFileForEdit.mockResolvedValue({
      path: "a.ts",
      content: "a-v1",
      etag: "ea1",
      mtime_ms: 1,
      readonly: false,
      line_ending: "lf",
    })

    let snap: BackgroundProbeSnapshot = { activeId: null, tabs: [] }
    render(
      <WorkspaceProvider>
        <BackgroundReloadProbe onCapture={(s) => (snap = s)} />
      </WorkspaceProvider>
    )

    // Open A, then B — A becomes a background tab. (Marking the ACTIVE
    // tab stale is immediately auto-resolved by the provider watcher's
    // stale-on-activation pass, so the flag would not stay observable.)
    await act(async () => {
      screen.getByText("open-a").click()
    })
    await act(async () => {
      screen.getByText("open-b").click()
    })
    expect(snap.tabs.find((t) => t.id === fileTabId("/repo/a.ts"))?.stale).toBe(
      false
    )

    await act(async () => {
      screen.getByText("stale-a").click()
    })
    expect(snap.tabs.find((t) => t.id === fileTabId("/repo/a.ts"))?.stale).toBe(
      true
    )
  })

  it("activates a stale clean tab and refetches as if reload:true was passed", async () => {
    mockedApi.readFileForEdit
      .mockResolvedValueOnce({
        path: "a.ts",
        content: "a-v1",
        etag: "ea1",
        mtime_ms: 1,
        readonly: false,
        line_ending: "lf",
      })
      .mockResolvedValueOnce({
        path: "b.ts",
        content: "b-v1",
        etag: "eb1",
        mtime_ms: 1,
        readonly: false,
        line_ending: "lf",
      })
      .mockResolvedValueOnce({
        path: "a.ts",
        content: "a-v2",
        etag: "ea2",
        mtime_ms: 2,
        readonly: false,
        line_ending: "lf",
      })

    let snap: BackgroundProbeSnapshot = { activeId: null, tabs: [] }
    render(
      <WorkspaceProvider>
        <BackgroundReloadProbe onCapture={(s) => (snap = s)} />
      </WorkspaceProvider>
    )

    await act(async () => {
      screen.getByText("open-a").click()
    })
    await act(async () => {
      screen.getByText("open-b").click()
    })
    await act(async () => {
      screen.getByText("stale-a").click()
    })
    expect(snap.tabs.find((t) => t.id === fileTabId("/repo/a.ts"))?.stale).toBe(
      true
    )

    // Plain activation (no reload option) must still refetch because stale.
    await act(async () => {
      screen.getByText("open-a").click()
    })

    expect(snap.activeId).toBe(fileTabId("/repo/a.ts"))
    const tabA = snap.tabs.find((t) => t.id === fileTabId("/repo/a.ts"))
    expect(tabA?.content).toBe("a-v2")
    expect(tabA?.stale).toBe(false)
    expect(mockedApi.readFileForEdit).toHaveBeenCalledTimes(3)
  })

  it("activates a stale dirty tab without overwriting local edits", async () => {
    mockedApi.readFileForEdit
      .mockResolvedValueOnce({
        path: "a.ts",
        content: "a-v1",
        etag: "ea1",
        mtime_ms: 1,
        readonly: false,
        line_ending: "lf",
      })
      .mockResolvedValueOnce({
        path: "b.ts",
        content: "b-v1",
        etag: "eb1",
        mtime_ms: 1,
        readonly: false,
        line_ending: "lf",
      })
      // Conflict-detection read fired by stale-on-activation for the
      // dirty tab: disk is UNCHANGED (same etag), so no conflict and no
      // content overwrite.
      .mockResolvedValueOnce({
        path: "a.ts",
        content: "a-v1",
        etag: "ea1",
        mtime_ms: 1,
        readonly: false,
        line_ending: "lf",
      })

    let snap: BackgroundProbeSnapshot = { activeId: null, tabs: [] }
    render(
      <WorkspaceProvider>
        <BackgroundReloadProbe onCapture={(s) => (snap = s)} />
      </WorkspaceProvider>
    )

    await act(async () => {
      screen.getByText("open-a").click()
    })
    await act(async () => {
      screen.getByText("edit").click()
    })
    await act(async () => {
      screen.getByText("open-b").click()
    })
    await act(async () => {
      screen.getByText("stale-a").click()
    })

    const callsBefore = mockedApi.readFileForEdit.mock.calls.length

    // Activate the dirty stale tab. The watcher runs ONE conflict-check
    // read (never a content refetch) — unsaved edits must survive.
    await act(async () => {
      screen.getByText("switch-a").click()
    })

    expect(snap.activeId).toBe(fileTabId("/repo/a.ts"))
    const tabA = snap.tabs.find((t) => t.id === fileTabId("/repo/a.ts"))
    expect(tabA?.isDirty).toBe(true)
    expect(tabA?.content).toBe("dirty-local")
    expect(tabA?.stale).toBe(true)
    expect(mockedApi.readFileForEdit.mock.calls.length).toBe(callsBefore + 1)
  })

  it("reloadOpenFileBackground is a no-op when the path is not open", async () => {
    let snap: BackgroundProbeSnapshot = { activeId: null, tabs: [] }
    render(
      <WorkspaceProvider>
        <BackgroundReloadProbe onCapture={(s) => (snap = s)} />
      </WorkspaceProvider>
    )

    await act(async () => {
      screen.getByText("bg-reload-a").click()
    })

    expect(snap.tabs).toHaveLength(0)
    expect(mockedApi.readFileForEdit).not.toHaveBeenCalled()
  })
})

interface ApplyExternalProbeSnapshot {
  activeId: string | null
  tabs: Array<{
    id: string
    content: string
    etag: string | null | undefined
    isDirty: boolean
    stale: boolean
    loading: boolean
  }>
}

function ApplyExternalReloadProbe({
  onCapture,
}: {
  onCapture: (snapshot: ApplyExternalProbeSnapshot) => void
}) {
  const {
    openFilePreview,
    fileTabs,
    activeFileTabId,
    applyExternalReload,
    updateActiveFileContent,
    markTabsStale,
  } = useWorkspaceContext()
  onCapture({
    activeId: activeFileTabId,
    tabs: fileTabs.map((tab) => ({
      id: tab.id,
      content: tab.content,
      etag: tab.etag,
      isDirty: Boolean(tab.isDirty),
      stale: Boolean(tab.stale),
      loading: tab.loading,
    })),
  })
  return (
    <div>
      <button onClick={() => void openFilePreview("a.ts")}>open-a</button>
      <button onClick={() => void openFilePreview("b.ts")}>open-b</button>
      <button onClick={() => updateActiveFileContent("dirty-local")}>
        edit
      </button>
      <button onClick={() => markTabsStale("/repo/a.ts")}>stale-a</button>
      <button
        onClick={() =>
          void applyExternalReload("/repo/a.ts", {
            path: "a.ts",
            content: "ext-content",
            etag: "ext-etag",
            mtime_ms: 99,
            readonly: false,
            line_ending: "lf",
          })
        }
      >
        apply-a
      </button>
      <button
        onClick={() =>
          void applyExternalReload("/repo/missing.ts", {
            path: "missing.ts",
            content: "x",
            etag: "x",
            mtime_ms: 1,
            readonly: false,
            line_ending: "lf",
          })
        }
      >
        apply-missing
      </button>
    </div>
  )
}

describe("applyExternalReload prefetched-write semantics", () => {
  beforeEach(() => {
    mockedApi.readFileForEdit.mockReset()
    mockedApi.gitIsTracked.mockReset()
    mockedApi.gitShowFile.mockReset()
    mockedApi.gitIsTracked.mockResolvedValue(false)
  })

  it("writes prefetched content into the matching tab without a second readFileForEdit", async () => {
    mockedApi.readFileForEdit.mockResolvedValueOnce({
      path: "a.ts",
      content: "a-v1",
      etag: "ea1",
      mtime_ms: 1,
      readonly: false,
      line_ending: "lf",
    })

    let snap: ApplyExternalProbeSnapshot = { activeId: null, tabs: [] }
    render(
      <WorkspaceProvider>
        <ApplyExternalReloadProbe onCapture={(s) => (snap = s)} />
      </WorkspaceProvider>
    )

    await act(async () => {
      screen.getByText("open-a").click()
    })
    expect(mockedApi.readFileForEdit).toHaveBeenCalledTimes(1)

    await act(async () => {
      screen.getByText("apply-a").click()
    })

    const tabA = snap.tabs.find((t) => t.id === fileTabId("/repo/a.ts"))
    expect(tabA?.content).toBe("ext-content")
    expect(tabA?.etag).toBe("ext-etag")
    expect(tabA?.loading).toBe(false)
    // The whole point: the prefetched payload is the source of truth, no
    // additional file read is issued.
    expect(mockedApi.readFileForEdit).toHaveBeenCalledTimes(1)
  })

  it("does not change activeFileTabId when reloading a non-active tab", async () => {
    mockedApi.readFileForEdit
      .mockResolvedValueOnce({
        path: "a.ts",
        content: "a-v1",
        etag: "ea1",
        mtime_ms: 1,
        readonly: false,
        line_ending: "lf",
      })
      .mockResolvedValueOnce({
        path: "b.ts",
        content: "b-v1",
        etag: "eb1",
        mtime_ms: 1,
        readonly: false,
        line_ending: "lf",
      })

    let snap: ApplyExternalProbeSnapshot = { activeId: null, tabs: [] }
    render(
      <WorkspaceProvider>
        <ApplyExternalReloadProbe onCapture={(s) => (snap = s)} />
      </WorkspaceProvider>
    )

    await act(async () => {
      screen.getByText("open-a").click()
    })
    await act(async () => {
      screen.getByText("open-b").click()
    })
    expect(snap.activeId).toBe(fileTabId("/repo/b.ts"))

    await act(async () => {
      screen.getByText("apply-a").click()
    })

    expect(snap.activeId).toBe(fileTabId("/repo/b.ts"))
    const tabA = snap.tabs.find((t) => t.id === fileTabId("/repo/a.ts"))
    expect(tabA?.content).toBe("ext-content")
  })

  it("refuses to overwrite a dirty tab", async () => {
    mockedApi.readFileForEdit.mockResolvedValueOnce({
      path: "a.ts",
      content: "a-v1",
      etag: "ea1",
      mtime_ms: 1,
      readonly: false,
      line_ending: "lf",
    })

    let snap: ApplyExternalProbeSnapshot = { activeId: null, tabs: [] }
    render(
      <WorkspaceProvider>
        <ApplyExternalReloadProbe onCapture={(s) => (snap = s)} />
      </WorkspaceProvider>
    )

    await act(async () => {
      screen.getByText("open-a").click()
    })
    await act(async () => {
      screen.getByText("edit").click()
    })

    await act(async () => {
      screen.getByText("apply-a").click()
    })

    const tabA = snap.tabs.find((t) => t.id === fileTabId("/repo/a.ts"))
    expect(tabA?.isDirty).toBe(true)
    expect(tabA?.content).toBe("dirty-local")
  })

  it("clears stale=true on a successful apply", async () => {
    mockedApi.readFileForEdit
      .mockResolvedValueOnce({
        path: "a.ts",
        content: "a-v1",
        etag: "ea1",
        mtime_ms: 1,
        readonly: false,
        line_ending: "lf",
      })
      .mockResolvedValueOnce({
        path: "b.ts",
        content: "b-v1",
        etag: "eb1",
        mtime_ms: 1,
        readonly: false,
        line_ending: "lf",
      })

    let snap: ApplyExternalProbeSnapshot = { activeId: null, tabs: [] }
    render(
      <WorkspaceProvider>
        <ApplyExternalReloadProbe onCapture={(s) => (snap = s)} />
      </WorkspaceProvider>
    )

    // A must be a BACKGROUND tab when marked stale — an active clean
    // stale tab is auto-reloaded by the watcher before apply could run.
    await act(async () => {
      screen.getByText("open-a").click()
    })
    await act(async () => {
      screen.getByText("open-b").click()
    })
    await act(async () => {
      screen.getByText("stale-a").click()
    })
    expect(snap.tabs.find((t) => t.id === fileTabId("/repo/a.ts"))?.stale).toBe(
      true
    )

    await act(async () => {
      screen.getByText("apply-a").click()
    })

    const tabA = snap.tabs.find((t) => t.id === fileTabId("/repo/a.ts"))
    expect(tabA?.stale).toBe(false)
    expect(tabA?.content).toBe("ext-content")
  })

  it("is a no-op when the path has no open tab", async () => {
    let snap: ApplyExternalProbeSnapshot = { activeId: null, tabs: [] }
    render(
      <WorkspaceProvider>
        <ApplyExternalReloadProbe onCapture={(s) => (snap = s)} />
      </WorkspaceProvider>
    )

    await act(async () => {
      screen.getByText("apply-missing").click()
    })

    expect(snap.tabs).toHaveLength(0)
    expect(mockedApi.readFileForEdit).not.toHaveBeenCalled()
  })
})

interface RejectFileTabSnapshot {
  activeId: string | null
  tabs: Array<{
    id: string
    content: string
    isDirty: boolean
    saveState?: string
    saveError?: string | null
    loading: boolean
  }>
}

function RejectFileTabProbe({
  onCapture,
}: {
  onCapture: (snapshot: RejectFileTabSnapshot) => void
}) {
  const {
    openFilePreview,
    fileTabs,
    activeFileTabId,
    rejectFileTab,
    updateActiveFileContent,
  } = useWorkspaceContext()
  onCapture({
    activeId: activeFileTabId,
    tabs: fileTabs.map((tab) => ({
      id: tab.id,
      content: tab.content,
      isDirty: Boolean(tab.isDirty),
      saveState: tab.saveState,
      saveError: tab.saveError ?? null,
      loading: tab.loading,
    })),
  })
  return (
    <div>
      <button onClick={() => void openFilePreview("a.ts")}>open-a</button>
      <button onClick={() => updateActiveFileContent("dirty-local")}>
        edit
      </button>
      <button
        onClick={() => rejectFileTab("/repo/a.ts", "ENOENT: file removed")}
      >
        reject-a
      </button>
      <button onClick={() => rejectFileTab("/repo/missing.ts", "irrelevant")}>
        reject-missing
      </button>
    </div>
  )
}

describe("rejectFileTab missing-on-disk semantics", () => {
  beforeEach(() => {
    mockedApi.readFileForEdit.mockReset()
    mockedApi.gitIsTracked.mockReset()
    mockedApi.gitShowFile.mockReset()
    mockedApi.gitIsTracked.mockResolvedValue(false)
  })

  it("replaces a clean tab's content with the supplied error and marks it errored", async () => {
    mockedApi.readFileForEdit.mockResolvedValueOnce({
      path: "a.ts",
      content: "fresh",
      etag: "ea1",
      mtime_ms: 1,
      readonly: false,
      line_ending: "lf",
    })

    let snap: RejectFileTabSnapshot = { activeId: null, tabs: [] }
    render(
      <WorkspaceProvider>
        <RejectFileTabProbe onCapture={(s) => (snap = s)} />
      </WorkspaceProvider>
    )

    await act(async () => {
      screen.getByText("open-a").click()
    })
    expect(snap.tabs[0]?.content).toBe("fresh")

    await act(async () => {
      screen.getByText("reject-a").click()
    })

    const tabA = snap.tabs.find((t) => t.id === fileTabId("/repo/a.ts"))
    expect(tabA?.saveState).toBe("error")
    expect(tabA?.saveError).toBe("ENOENT: file removed")
    expect(tabA?.loading).toBe(false)
    // Original content should no longer be presented as the file's body —
    // an error message stands in its place so the user is never silently
    // shown a buffer that no longer matches disk.
    expect(tabA?.content).not.toBe("fresh")
    expect(tabA?.content.length).toBeGreaterThan(0)
  })

  it("refuses to touch a dirty tab so unsaved edits survive an external delete", async () => {
    mockedApi.readFileForEdit.mockResolvedValueOnce({
      path: "a.ts",
      content: "v1",
      etag: "ea1",
      mtime_ms: 1,
      readonly: false,
      line_ending: "lf",
    })

    let snap: RejectFileTabSnapshot = { activeId: null, tabs: [] }
    render(
      <WorkspaceProvider>
        <RejectFileTabProbe onCapture={(s) => (snap = s)} />
      </WorkspaceProvider>
    )

    await act(async () => {
      screen.getByText("open-a").click()
    })
    await act(async () => {
      screen.getByText("edit").click()
    })
    expect(snap.tabs[0]?.isDirty).toBe(true)
    expect(snap.tabs[0]?.content).toBe("dirty-local")

    await act(async () => {
      screen.getByText("reject-a").click()
    })

    const tabA = snap.tabs.find((t) => t.id === fileTabId("/repo/a.ts"))
    expect(tabA?.isDirty).toBe(true)
    expect(tabA?.content).toBe("dirty-local")
    // saveError stays null — only the watcher's markTabsStale path is
    // responsible for surfacing the read failure to the user when the
    // buffer is dirty.
    expect(tabA?.saveError).toBeNull()
  })

  it("is a no-op when the path has no open tab", async () => {
    let snap: RejectFileTabSnapshot = { activeId: null, tabs: [] }
    render(
      <WorkspaceProvider>
        <RejectFileTabProbe onCapture={(s) => (snap = s)} />
      </WorkspaceProvider>
    )

    await act(async () => {
      screen.getByText("reject-missing").click()
    })

    expect(snap.tabs).toHaveLength(0)
  })
})

interface GitHangProbeSnapshot {
  tabs: Array<{ id: string; content: string }>
}

function ApplyThenReloadProbe({
  onCapture,
}: {
  onCapture: (snapshot: GitHangProbeSnapshot) => void
}) {
  const { openFilePreview, fileTabs, applyExternalReload } =
    useWorkspaceContext()
  onCapture({
    tabs: fileTabs.map((tab) => ({ id: tab.id, content: tab.content })),
  })
  return (
    <div>
      <button onClick={() => void openFilePreview("a.ts")}>open-a</button>
      <button
        onClick={() =>
          void applyExternalReload("/repo/a.ts", {
            path: "a.ts",
            content: "ext-content",
            etag: "ext-etag",
            mtime_ms: 99,
            readonly: false,
            line_ending: "lf",
          })
        }
      >
        apply-a
      </button>
      <button onClick={() => void openFilePreview("a.ts", { reload: true })}>
        reload-a
      </button>
    </div>
  )
}

describe("applyExternalReload does not block subsequent reloads on slow git base", () => {
  beforeEach(() => {
    mockedApi.readFileForEdit.mockReset()
    mockedApi.gitIsTracked.mockReset()
    mockedApi.gitShowFile.mockReset()
  })

  it("releases the in-flight marker before awaiting git base so a foreground reload still fires", async () => {
    // First open: git not tracked → no gitShowFile.
    mockedApi.gitIsTracked.mockResolvedValueOnce(false)
    mockedApi.readFileForEdit
      .mockResolvedValueOnce({
        path: "a.ts",
        content: "v1",
        etag: "e1",
        mtime_ms: 1,
        readonly: false,
        line_ending: "lf",
      })
      .mockResolvedValueOnce({
        path: "a.ts",
        content: "v3",
        etag: "e3",
        mtime_ms: 3,
        readonly: false,
        line_ending: "lf",
      })

    let snap: GitHangProbeSnapshot = { tabs: [] }
    render(
      <WorkspaceProvider>
        <ApplyThenReloadProbe onCapture={(s) => (snap = s)} />
      </WorkspaceProvider>
    )

    await act(async () => {
      screen.getByText("open-a").click()
    })
    expect(mockedApi.readFileForEdit).toHaveBeenCalledTimes(1)

    // Now simulate a stuck git: subsequent gitIsTracked/gitShowFile hang
    // forever. applyExternalReload's git base refresh must not block
    // user-initiated reload via the inFlightLoadsRef dedup path.
    mockedApi.gitIsTracked.mockImplementation(() => new Promise(() => {}))
    mockedApi.gitShowFile.mockImplementation(() => new Promise(() => {}))

    await act(async () => {
      screen.getByText("apply-a").click()
    })
    // Content was written from the prefetched payload despite hung git.
    expect(
      snap.tabs.find((t) => t.id === fileTabId("/repo/a.ts"))?.content
    ).toBe("ext-content")

    // Foreground reload — must fire a second readFileForEdit, not be
    // deduplicated by a lingering in-flight marker from applyExternalReload.
    await act(async () => {
      screen.getByText("reload-a").click()
    })

    expect(mockedApi.readFileForEdit).toHaveBeenCalledTimes(2)
  })
})

interface AtomicGuardSnapshot {
  tabs: Array<{
    id: string
    content: string
    isDirty: boolean
    stale: boolean
    saveState?: string
    saveError?: string | null
    etag: string | null | undefined
    gitBaseContent?: string | undefined
  }>
}

function ApplyEditRaceProbe({
  onCapture,
}: {
  onCapture: (snapshot: AtomicGuardSnapshot) => void
}) {
  const {
    openFilePreview,
    fileTabs,
    applyExternalReload,
    updateActiveFileContent,
    closeAllFileTabs,
  } = useWorkspaceContext()
  onCapture({
    tabs: fileTabs.map((tab) => ({
      id: tab.id,
      content: tab.content,
      isDirty: Boolean(tab.isDirty),
      stale: Boolean(tab.stale),
      saveState: tab.saveState,
      saveError: tab.saveError ?? null,
      etag: tab.etag,
      gitBaseContent: tab.gitBaseContent,
    })),
  })
  return (
    <div>
      <button onClick={() => void openFilePreview("a.ts")}>open-a</button>
      <button
        onClick={() => {
          // Single React event handler: both setFileTabs calls land in
          // the same batch. updater1 (from updateActiveFileContent)
          // marks the tab dirty; updater2 (from applyExternalReload)
          // would silently clobber that edit unless its updater performs
          // an atomic isDirty re-check.
          updateActiveFileContent("dirty-local")
          void applyExternalReload("/repo/a.ts", {
            path: "a.ts",
            content: "ext-content",
            etag: "ext-etag",
            mtime_ms: 99,
            readonly: false,
            line_ending: "lf",
          })
        }}
      >
        edit-and-apply
      </button>
      <button
        onClick={() =>
          void applyExternalReload("/repo/a.ts", {
            path: "a.ts",
            content: "ext-content",
            etag: "ext-etag",
            mtime_ms: 99,
            readonly: false,
            line_ending: "lf",
          })
        }
      >
        apply-a
      </button>
      <button onClick={closeAllFileTabs}>close-all</button>
    </div>
  )
}

function RejectEditRaceProbe({
  onCapture,
}: {
  onCapture: (snapshot: AtomicGuardSnapshot) => void
}) {
  const { openFilePreview, fileTabs, rejectFileTab, updateActiveFileContent } =
    useWorkspaceContext()
  onCapture({
    tabs: fileTabs.map((tab) => ({
      id: tab.id,
      content: tab.content,
      isDirty: Boolean(tab.isDirty),
      stale: Boolean(tab.stale),
      saveState: tab.saveState,
      saveError: tab.saveError ?? null,
      etag: tab.etag,
      gitBaseContent: tab.gitBaseContent,
    })),
  })
  return (
    <div>
      <button onClick={() => void openFilePreview("a.ts")}>open-a</button>
      <button
        onClick={() => {
          // Same race shape as the apply probe above, but the second
          // queued updater is rejectFileTab — must also gate on
          // isDirty INSIDE the updater to avoid clobbering the edit.
          updateActiveFileContent("dirty-local")
          rejectFileTab("/repo/a.ts", "boom")
        }}
      >
        edit-and-reject
      </button>
    </div>
  )
}

describe("atomic dirty guard in functional updaters", () => {
  beforeEach(() => {
    mockedApi.readFileForEdit.mockReset()
    mockedApi.gitIsTracked.mockReset()
    mockedApi.gitShowFile.mockReset()
    mockedApi.gitIsTracked.mockResolvedValue(false)
  })

  it("applyExternalReload refuses to overwrite a dirty edit enqueued in the same React batch", async () => {
    mockedApi.readFileForEdit.mockResolvedValueOnce({
      path: "a.ts",
      content: "v1",
      etag: "e1",
      mtime_ms: 1,
      readonly: false,
      line_ending: "lf",
    })

    let snap: AtomicGuardSnapshot = { tabs: [] }
    render(
      <WorkspaceProvider>
        <ApplyEditRaceProbe onCapture={(s) => (snap = s)} />
      </WorkspaceProvider>
    )

    await act(async () => {
      screen.getByText("open-a").click()
    })

    await act(async () => {
      screen.getByText("edit-and-apply").click()
    })

    const tabA = snap.tabs.find((t) => t.id === fileTabId("/repo/a.ts"))
    expect(tabA?.isDirty).toBe(true)
    expect(tabA?.content).toBe("dirty-local")
    // etag stays at the pre-apply value — proof that the apply was
    // refused as a whole, not partially.
    expect(tabA?.etag).toBe("e1")
  })

  it("rejectFileTab refuses to clobber a dirty edit enqueued in the same React batch", async () => {
    mockedApi.readFileForEdit.mockResolvedValueOnce({
      path: "a.ts",
      content: "v1",
      etag: "e1",
      mtime_ms: 1,
      readonly: false,
      line_ending: "lf",
    })

    let snap: AtomicGuardSnapshot = { tabs: [] }
    render(
      <WorkspaceProvider>
        <RejectEditRaceProbe onCapture={(s) => (snap = s)} />
      </WorkspaceProvider>
    )

    await act(async () => {
      screen.getByText("open-a").click()
    })

    await act(async () => {
      screen.getByText("edit-and-reject").click()
    })

    const tabA = snap.tabs.find((t) => t.id === fileTabId("/repo/a.ts"))
    expect(tabA?.isDirty).toBe(true)
    expect(tabA?.content).toBe("dirty-local")
    expect(tabA?.saveState).not.toBe("error")
    expect(tabA?.saveError).toBeNull()
  })

  it("applyExternalReload marks the refused tab stale so the conflict prompt fires without waiting for save", async () => {
    // Refusing the apply protects the dirty buffer from data loss, but
    // the user is then editing against disk that has silently diverged.
    // Marking stale=true wires the dirty refusal into the existing
    // aux-panel effect (tab.stale && tab.isDirty → announceConflict),
    // surfacing the divergence immediately instead of at save time.
    mockedApi.readFileForEdit.mockResolvedValueOnce({
      path: "a.ts",
      content: "v1",
      etag: "e1",
      mtime_ms: 1,
      readonly: false,
      line_ending: "lf",
    })

    let snap: AtomicGuardSnapshot = { tabs: [] }
    render(
      <WorkspaceProvider>
        <ApplyEditRaceProbe onCapture={(s) => (snap = s)} />
      </WorkspaceProvider>
    )

    await act(async () => {
      screen.getByText("open-a").click()
    })

    await act(async () => {
      screen.getByText("edit-and-apply").click()
    })

    const tabA = snap.tabs.find((t) => t.id === fileTabId("/repo/a.ts"))
    expect(tabA?.isDirty).toBe(true)
    expect(tabA?.stale).toBe(true)
  })

  it("rejectFileTab marks the refused dirty tab stale for symmetry with applyExternalReload", async () => {
    // rejectFileTab is normally called from the watcher only after
    // markTabsStale has already flagged the path, so stale=true here is
    // usually idempotent. Setting it inside the updater keeps the API
    // self-consistent: any direct caller that refuses the reject because
    // of a concurrent keystroke still surfaces divergence via the
    // existing stale+dirty conflict path, without relying on callers
    // remembering to call markTabsStale first.
    mockedApi.readFileForEdit.mockResolvedValueOnce({
      path: "a.ts",
      content: "v1",
      etag: "e1",
      mtime_ms: 1,
      readonly: false,
      line_ending: "lf",
    })

    let snap: AtomicGuardSnapshot = { tabs: [] }
    render(
      <WorkspaceProvider>
        <RejectEditRaceProbe onCapture={(s) => (snap = s)} />
      </WorkspaceProvider>
    )

    await act(async () => {
      screen.getByText("open-a").click()
    })

    await act(async () => {
      screen.getByText("edit-and-reject").click()
    })

    const tabA = snap.tabs.find((t) => t.id === fileTabId("/repo/a.ts"))
    expect(tabA?.isDirty).toBe(true)
    expect(tabA?.stale).toBe(true)
  })
})

describe("applyExternalReload git base does not stale-write after close+reopen", () => {
  beforeEach(() => {
    mockedApi.readFileForEdit.mockReset()
    mockedApi.gitIsTracked.mockReset()
    mockedApi.gitShowFile.mockReset()
  })

  it("does not write a stale gitBaseContent into a reopened tab whose etag differs", async () => {
    // Initial open: not tracked → skip git base fetch entirely.
    mockedApi.gitIsTracked.mockResolvedValueOnce(false)
    mockedApi.readFileForEdit.mockResolvedValueOnce({
      path: "a.ts",
      content: "v1",
      etag: "etag-orig",
      mtime_ms: 1,
      readonly: false,
      line_ending: "lf",
    })

    let snap: AtomicGuardSnapshot = { tabs: [] }
    render(
      <WorkspaceProvider>
        <ApplyEditRaceProbe onCapture={(s) => (snap = s)} />
      </WorkspaceProvider>
    )

    await act(async () => {
      screen.getByText("open-a").click()
    })

    // Now the apply path: tracked, gitShowFile hangs (we'll resolve it
    // ourselves after close+reopen to simulate a slow git call).
    let resolveStaleGit: ((value: string) => void) | null = null
    mockedApi.gitIsTracked.mockResolvedValueOnce(true)
    mockedApi.gitShowFile.mockImplementationOnce(
      () => new Promise<string>((res) => (resolveStaleGit = res))
    )

    await act(async () => {
      screen.getByText("apply-a").click()
    })
    // Tab now has etag "ext-etag" (from apply-a's hardcoded fetched).
    expect(snap.tabs.find((t) => t.id === fileTabId("/repo/a.ts"))?.etag).toBe(
      "ext-etag"
    )

    // Close the tab; the stale git fetch is still pending.
    await act(async () => {
      screen.getByText("close-all").click()
    })
    expect(snap.tabs).toHaveLength(0)

    // Reopen the same path with a different etag and no git base
    // (so the only writes to gitBaseContent could come from the stale
    // fetch we have not yet resolved).
    mockedApi.gitIsTracked.mockResolvedValueOnce(false)
    mockedApi.readFileForEdit.mockResolvedValueOnce({
      path: "a.ts",
      content: "v2",
      etag: "etag-different",
      mtime_ms: 2,
      readonly: false,
      line_ending: "lf",
    })

    await act(async () => {
      screen.getByText("open-a").click()
    })
    expect(snap.tabs.find((t) => t.id === fileTabId("/repo/a.ts"))?.etag).toBe(
      "etag-different"
    )
    // Sanity: reopen did not inherit a gitBaseContent (its own git path
    // was skipped via gitIsTracked → false).
    expect(
      snap.tabs.find((t) => t.id === fileTabId("/repo/a.ts"))?.gitBaseContent
    ).toBe(undefined)

    // Resolve the dangling git fetch from the FIRST (closed) tab's apply.
    // It targets the same tabId but a different etag — must be rejected.
    await act(async () => {
      resolveStaleGit!("stale-base")
    })

    const tabA = snap.tabs.find((t) => t.id === fileTabId("/repo/a.ts"))
    expect(tabA?.gitBaseContent).not.toBe("stale-base")
    expect(tabA?.gitBaseContent).toBe(undefined)
  })
})

describe("WorkspaceProvider office auto-preview", () => {
  beforeEach(() => {
    workspaceStoreMock.reset()
    // Preference defaults ON; drop any "false" a prior test left behind.
    localStorage.removeItem("workspace:office-auto-preview")
    // Reset first: call history is what the "one listing per parent" tests
    // assert on, and an unconsumed `…Once` from a prior test would otherwise
    // answer the next one's first lookup.
    vi.mocked(api.listDirectoryWithFiles).mockReset()
    vi.mocked(api.listDirectoryWithFiles).mockImplementation(async (root) =>
      ["report.pptx", "deck.pptx", "report.docx"].map((name) => ({
        name,
        path: `${root}/${name}`,
        isDir: false,
        hasChildren: false,
        size: 100,
      }))
    )
  })

  it("auto-opens an office file's preview when the watcher reports it, with no aux panel involved", async () => {
    renderWorkspace()
    expect(screen.getByTestId("file-tab-count")).toHaveTextContent("0")
    expect(screen.getByTestId("active-pane")).toHaveTextContent("conversation")

    // The provider — not the (closed-by-default) file-tree aux panel — owns
    // this subscription, so a watcher envelope surfaces the preview directly.
    await act(async () => {
      workspaceStoreMock.emitEnvelope(["report.pptx"])
    })

    expect(screen.getByTestId("file-tab-count")).toHaveTextContent("1")
    expect(screen.getByTestId("active-file-tab")).toHaveTextContent(
      fileTabId("/repo/report.pptx")
    )
    expect(screen.getByTestId("active-pane")).toHaveTextContent("files")
    expect(screen.getByTestId("mode")).toHaveTextContent("fusion")
  })

  it("ignores non-office changed paths", async () => {
    renderWorkspace()

    await act(async () => {
      workspaceStoreMock.emitEnvelope(["notes.txt", "src/app.ts"])
    })

    expect(screen.getByTestId("file-tab-count")).toHaveTextContent("0")
    expect(screen.getByTestId("active-pane")).toHaveTextContent("conversation")
  })

  it("ignores hidden office files and office files inside hidden directories", async () => {
    renderWorkspace()

    // Dot-prefixed names are machine-owned byproducts (LibreOffice lock file,
    // AppleDouble sidecar, a doc parked under a scratch dir) — auto-preview
    // must neither open a tab for them nor start their watch.
    await act(async () => {
      workspaceStoreMock.emitEnvelope([
        ".~lock.report.docx#",
        "._report.docx",
        "docs/.draft.xlsx",
        ".git/report.docx",
        "build/.tmp/deck.pptx",
      ])
    })

    expect(screen.getByTestId("file-tab-count")).toHaveTextContent("0")
    expect(screen.getByTestId("active-pane")).toHaveTextContent("conversation")
  })

  it("ignores the burst of `~$` owner files WPS drops when documents are opened", async () => {
    renderWorkspace()

    // The reported failure: opening a folder of documents in WPS (or Word)
    // writes one `~$`-prefixed owner file per document, all at once and all
    // carrying a real office extension. Auto-preview used to answer with a tab
    // and an `officecli watch` process for every one of them.
    await act(async () => {
      workspaceStoreMock.emitEnvelope([
        "~$report.docx",
        "~$budget.xlsx",
        "~$deck.pptx",
        "docs/~$minutes.docx",
        // Word truncates long names to fit the prefix, so the tail need not
        // match any document sitting next to it.
        "~$cument.docx",
      ])
    })

    expect(screen.getByTestId("file-tab-count")).toHaveTextContent("0")
    expect(screen.getByTestId("active-pane")).toHaveTextContent("conversation")
  })

  it("still auto-opens the document whose owner file arrives with it", async () => {
    renderWorkspace()

    // Opening `report.docx` externally touches the document itself as well as
    // its owner file. The owner file is the byproduct; the document is still a
    // legitimate preview, so the filter must not swallow the pair.
    await act(async () => {
      workspaceStoreMock.emitEnvelope(["~$report.docx", "report.docx"])
    })

    expect(screen.getByTestId("file-tab-count")).toHaveTextContent("1")
    expect(screen.getByTestId("active-file-tab")).toHaveTextContent(
      fileTabId("/repo/report.docx")
    )
  })

  it("still auto-opens a visible office file reported alongside hidden ones", async () => {
    renderWorkspace()

    await act(async () => {
      workspaceStoreMock.emitEnvelope(["._report.docx", "report.docx"])
    })

    expect(screen.getByTestId("file-tab-count")).toHaveTextContent("1")
    expect(screen.getByTestId("active-file-tab")).toHaveTextContent(
      fileTabId("/repo/report.docx")
    )
  })

  it("opens each office file once, even when later envelopes re-report it", async () => {
    renderWorkspace()

    await act(async () => {
      workspaceStoreMock.emitEnvelope(["deck.pptx"])
    })
    await act(async () => {
      workspaceStoreMock.emitEnvelope(["deck.pptx"])
    })

    expect(screen.getByTestId("file-tab-count")).toHaveTextContent("1")
  })

  it("does not open a removed document from a changed_paths envelope", async () => {
    vi.mocked(api.listDirectoryWithFiles).mockResolvedValue([])
    renderWorkspace()

    await act(async () => {
      workspaceStoreMock.emitEnvelope(["report.docx"])
    })

    expect(screen.getByTestId("file-tab-count")).toHaveTextContent("0")
    expect(screen.getByTestId("active-pane")).toHaveTextContent("conversation")
  })

  it("does not open documents from a removed parent directory", async () => {
    vi.mocked(api.listDirectoryWithFiles).mockRejectedValue(
      new Error("Path is not a directory")
    )
    renderWorkspace()

    await act(async () => {
      workspaceStoreMock.emitEnvelope(["scratch/report.docx"])
    })

    expect(screen.getByTestId("file-tab-count")).toHaveTextContent("0")
  })

  it("keeps a dismissed preview closed after switching folders and back", async () => {
    renderWorkspace()
    await act(async () => {
      workspaceStoreMock.emitEnvelope(["report.docx"])
    })
    act(() => screen.getByRole("button", { name: "Close active" }).click())
    act(() => foldersMock.setActiveFolderId(2))
    act(() => foldersMock.setActiveFolderId(1))
    await act(async () => {
      workspaceStoreMock.emitEnvelope(["report.docx"])
    })

    expect(screen.getByTestId("file-tab-count")).toHaveTextContent("0")
  })

  it("can open a document recreated after an earlier removal event", async () => {
    vi.mocked(api.listDirectoryWithFiles).mockResolvedValueOnce([])
    renderWorkspace()
    await act(async () => {
      workspaceStoreMock.emitEnvelope(["report.docx"])
    })
    expect(screen.getByTestId("file-tab-count")).toHaveTextContent("0")

    await act(async () => {
      workspaceStoreMock.emitEnvelope(["report.docx"])
    })
    expect(screen.getByTestId("file-tab-count")).toHaveTextContent("1")
  })

  it("does not mistake a directory with an Office suffix for a document", async () => {
    vi.mocked(api.listDirectoryWithFiles).mockResolvedValue([
      {
        name: "report.docx",
        path: "/repo/report.docx",
        isDir: true,
        hasChildren: true,
        size: null,
      },
    ])
    renderWorkspace()
    await act(async () => {
      workspaceStoreMock.emitEnvelope(["report.docx"])
    })
    expect(screen.getByTestId("file-tab-count")).toHaveTextContent("0")
  })

  it("discards a pending preview when its workspace is no longer active", async () => {
    let finish!: (
      entries: Awaited<ReturnType<typeof api.listDirectoryWithFiles>>
    ) => void
    vi.mocked(api.listDirectoryWithFiles).mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve
      })
    )
    renderWorkspace()
    await act(async () => {
      workspaceStoreMock.emitEnvelope(["report.docx"])
    })
    act(() => foldersMock.setActiveFolderId(2))
    await act(async () => {
      finish([
        {
          name: "report.docx",
          path: "/repo/report.docx",
          isDir: false,
          hasChildren: false,
          size: 100,
        },
      ])
    })
    expect(screen.getByTestId("file-tab-count")).toHaveTextContent("0")
  })

  it("lists a parent once per burst and never re-lists a decided path", async () => {
    // The existence probe sits on the watcher's hot path, and the backing
    // command stats every sibling and ships the whole listing to the renderer
    // (over HTTP in server/remote mode). Both bounds below are what keep that
    // affordable: one lookup per parent per envelope, and none at all once a
    // path has been decided.
    renderWorkspace()

    await act(async () => {
      workspaceStoreMock.emitEnvelope([
        "report.docx",
        "deck.pptx",
        "report.pptx",
      ])
    })

    expect(screen.getByTestId("file-tab-count")).toHaveTextContent("3")
    expect(api.listDirectoryWithFiles).toHaveBeenCalledTimes(1)
    expect(api.listDirectoryWithFiles).toHaveBeenCalledWith("/repo")

    await act(async () => {
      workspaceStoreMock.emitEnvelope(["report.docx", "deck.pptx"])
    })

    expect(api.listDirectoryWithFiles).toHaveBeenCalledTimes(1)
  })

  it("does not resurface a document the user opened by hand and closed", async () => {
    renderWorkspace()

    await act(async () => {
      screen.getByRole("button", { name: "Open office by hand" }).click()
    })
    expect(screen.getByTestId("file-tab-count")).toHaveTextContent("1")

    // The agent writes while the hand-opened tab is up: nothing to open, and
    // no existence probe either — the open tab already answers the question.
    await act(async () => {
      workspaceStoreMock.emitEnvelope(["report.docx"])
    })
    expect(api.listDirectoryWithFiles).not.toHaveBeenCalled()

    act(() => screen.getByRole("button", { name: "Close active" }).click())
    expect(screen.getByTestId("file-tab-count")).toHaveTextContent("0")

    // A document the user has already seen and dismissed stays dismissed.
    await act(async () => {
      workspaceStoreMock.emitEnvelope(["report.docx"])
    })
    expect(screen.getByTestId("file-tab-count")).toHaveTextContent("0")
  })

  it("does not auto-open when the preference is disabled", async () => {
    localStorage.setItem("workspace:office-auto-preview", "false")
    renderWorkspace()

    await act(async () => {
      workspaceStoreMock.emitEnvelope(["report.pptx"])
    })

    expect(screen.getByTestId("file-tab-count")).toHaveTextContent("0")
    expect(screen.getByTestId("active-pane")).toHaveTextContent("conversation")
  })
})

describe("context slice render isolation", () => {
  // The whole point of the three-way context split: fileTabs churn
  // (keystrokes, watcher reloads) must not re-render components that only
  // subscribe to actions (conversation path) or view (layout chrome).
  // Render counting goes through an `onRender` callback (same pattern as
  // the `onCapture` probes above) — direct module-scope mutation inside a
  // component body trips react-hooks/immutability.
  const renderCounts = { actions: 0, view: 0, fileTabs: 0 }

  function ActionsProbe({ onRender }: { onRender: () => void }) {
    onRender()
    const { openSessionFileDiff, updateActiveFileContent } =
      useWorkspaceActions()
    return (
      <div>
        <button
          onClick={() => openSessionFileDiff("src/a.ts", "diff --git a", "T1")}
        >
          slice-open-a
        </button>
        <button
          onClick={() => openSessionFileDiff("src/b.ts", "diff --git b", "T1")}
        >
          slice-open-b
        </button>
        <button onClick={() => updateActiveFileContent("typed")}>
          slice-edit
        </button>
      </div>
    )
  }

  function ViewProbe({ onRender }: { onRender: () => void }) {
    onRender()
    const { mode } = useWorkspaceView()
    return <output data-testid="slice-mode">{mode}</output>
  }

  function FileTabsProbe({ onRender }: { onRender: () => void }) {
    onRender()
    const { fileTabs } = useWorkspaceFileTabs()
    return <output data-testid="slice-tab-count">{fileTabs.length}</output>
  }

  const countActions = () => {
    renderCounts.actions += 1
  }
  const countView = () => {
    renderCounts.view += 1
  }
  const countFileTabs = () => {
    renderCounts.fileTabs += 1
  }

  beforeEach(() => {
    renderCounts.actions = 0
    renderCounts.view = 0
    renderCounts.fileTabs = 0
  })

  it("keeps actions/view consumers un-rendered when fileTabs change within fusion mode", async () => {
    render(
      <WorkspaceProvider>
        <ActionsProbe onRender={countActions} />
        <ViewProbe onRender={countView} />
        <FileTabsProbe onRender={countFileTabs} />
      </WorkspaceProvider>
    )

    // First open flips mode conversation→fusion, so the view consumer is
    // expected to render once more here.
    await act(async () => {
      screen.getByText("slice-open-a").click()
    })
    expect(screen.getByTestId("slice-mode")).toHaveTextContent("fusion")
    expect(screen.getByTestId("slice-tab-count")).toHaveTextContent("1")

    const actionsBefore = renderCounts.actions
    const viewBefore = renderCounts.view
    const fileTabsBefore = renderCounts.fileTabs

    // Second open mutates fileTabs but neither mode (stays fusion) nor
    // activePane (stays files) — only the fileTabs consumer may render.
    await act(async () => {
      screen.getByText("slice-open-b").click()
    })
    expect(screen.getByTestId("slice-tab-count")).toHaveTextContent("2")
    expect(renderCounts.actions).toBe(actionsBefore)
    expect(renderCounts.view).toBe(viewBefore)
    expect(renderCounts.fileTabs).toBeGreaterThan(fileTabsBefore)
  })

  it("keeps actions/view consumers un-rendered on per-keystroke content updates", async () => {
    mockedApi.readFileForEdit.mockResolvedValueOnce({
      path: "a.ts",
      content: "v1",
      etag: "e1",
      mtime_ms: 1,
      readonly: false,
      line_ending: "lf",
    })
    mockedApi.gitIsTracked.mockResolvedValue(false)

    function OpenFileProbe() {
      const { openFilePreview } = useWorkspaceActions()
      return (
        <button onClick={() => void openFilePreview("a.ts")}>
          slice-open-file
        </button>
      )
    }

    render(
      <WorkspaceProvider>
        <ActionsProbe onRender={countActions} />
        <ViewProbe onRender={countView} />
        <FileTabsProbe onRender={countFileTabs} />
        <OpenFileProbe />
      </WorkspaceProvider>
    )

    await act(async () => {
      screen.getByText("slice-open-file").click()
    })
    expect(screen.getByTestId("slice-tab-count")).toHaveTextContent("1")

    const actionsBefore = renderCounts.actions
    const viewBefore = renderCounts.view

    // Simulates the editor's onChange — the highest-frequency fileTabs write.
    await act(async () => {
      screen.getByText("slice-edit").click()
    })

    expect(renderCounts.actions).toBe(actionsBefore)
    expect(renderCounts.view).toBe(viewBefore)
  })
})

interface DecoupleSnapshot {
  activeId: string | null
  tabs: Array<{
    id: string
    folderId: number | null
    content: string
    isDirty: boolean
    stale: boolean
  }>
}

function DecoupleProbe({
  onCapture,
}: {
  onCapture: (snapshot: DecoupleSnapshot) => void
}) {
  const {
    openFilePreview,
    fileTabs,
    activeFileTabId,
    updateActiveFileContent,
    updateFileTabContent,
    saveActiveFile,
    setFileTabComposing,
    switchFileTab,
  } = useWorkspaceContext()
  onCapture({
    activeId: activeFileTabId,
    tabs: fileTabs.map((tab) => ({
      id: tab.id,
      folderId: tab.folderId,
      content: tab.content,
      isDirty: Boolean(tab.isDirty),
      stale: Boolean(tab.stale),
    })),
  })
  return (
    <div>
      <button onClick={() => void openFilePreview("a.ts")}>open-a-f1</button>
      <button onClick={() => void openFilePreview("a.ts", { folderId: 2 })}>
        open-a-f2
      </button>
      <button onClick={() => updateActiveFileContent("dirty-local")}>
        edit
      </button>
      <button
        onClick={() =>
          updateFileTabContent(fileTabId("/repo/a.ts"), "composing-local")
        }
      >
        edit-a-by-id
      </button>
      <button
        onClick={() => setFileTabComposing(fileTabId("/repo/a.ts"), true)}
      >
        compose-a-start
      </button>
      <button
        onClick={() => setFileTabComposing(fileTabId("/repo/a.ts"), false)}
      >
        compose-a-end
      </button>
      <button onClick={() => void saveActiveFile()}>save</button>
      <button
        onClick={() => {
          updateActiveFileContent("deleted-content")
          void saveActiveFile()
        }}
      >
        edit-and-save-immediately
      </button>
      <button onClick={() => switchFileTab(fileTabId("/repo2/a.ts"))}>
        switch-a-f2
      </button>
      <button onClick={() => switchFileTab(fileTabId("/repo/a.ts"))}>
        switch-a-f1
      </button>
    </div>
  )
}

describe("file tabs decoupled from the active folder", () => {
  beforeEach(() => {
    mockedApi.readFileForEdit.mockReset()
    mockedApi.gitIsTracked.mockReset()
    mockedApi.gitShowFile.mockReset()
    mockedApi.saveFileContent.mockReset()
    mockedApi.gitIsTracked.mockResolvedValue(false)
    // Distinguishable content per folder root so routing is observable.
    mockedApi.readFileForEdit.mockImplementation((root: string) =>
      Promise.resolve({
        path: "a.ts",
        content: root === "/repo2" ? "from-repo2" : "from-repo1",
        etag: root === "/repo2" ? "e2" : "e1",
        mtime_ms: 1,
        readonly: false,
        line_ending: "lf",
      })
    )
  })

  it("defers every save path during composition and flushes the original tab", async () => {
    mockedApi.saveFileContent.mockResolvedValue({
      path: "a.ts",
      etag: "saved",
      mtime_ms: 2,
      readonly: false,
      line_ending: "lf",
    })
    const snap = renderDecouple()

    await act(async () => screen.getByText("open-a-f1").click())
    await act(async () => screen.getByText("open-a-f2").click())
    await act(async () => screen.getByText("switch-a-f1").click())
    await act(async () => screen.getByText("compose-a-start").click())
    await act(async () => screen.getByText("edit-a-by-id").click())

    await act(async () => screen.getByText("save").click())
    await act(async () => screen.getByText("switch-a-f2").click())
    expect(mockedApi.saveFileContent).not.toHaveBeenCalled()
    expect(snap().activeId).toBe(fileTabId("/repo2/a.ts"))

    await act(async () => screen.getByText("compose-a-end").click())
    expect(mockedApi.saveFileContent).toHaveBeenCalledTimes(1)
    expect(mockedApi.saveFileContent.mock.calls[0][0]).toBe("/repo")
    expect(mockedApi.saveFileContent.mock.calls[0][1]).toBe("a.ts")
    expect(mockedApi.saveFileContent.mock.calls[0][2]).toBe("composing-local")
  })

  it("saves the latest edit when the shortcut follows in the same turn", async () => {
    mockedApi.saveFileContent.mockResolvedValue({
      path: "a.ts",
      etag: "saved",
      mtime_ms: 2,
      readonly: false,
      line_ending: "lf",
    })
    renderDecouple()

    await act(async () => screen.getByText("open-a-f1").click())
    await act(async () => screen.getByText("edit-and-save-immediately").click())

    expect(mockedApi.saveFileContent).toHaveBeenCalledTimes(1)
    expect(mockedApi.saveFileContent.mock.calls[0][2]).toBe("deleted-content")
  })

  function renderDecouple() {
    let snap: DecoupleSnapshot = { activeId: null, tabs: [] }
    render(
      <WorkspaceProvider>
        <DecoupleProbe onCapture={(s) => (snap = s)} />
      </WorkspaceProvider>
    )
    return () => snap
  }

  it("keeps open tabs (content and identity) across an active-folder switch", async () => {
    const snap = renderDecouple()

    await act(async () => {
      screen.getByText("open-a-f1").click()
    })
    expect(snap().tabs).toHaveLength(1)
    expect(snap().tabs[0]).toMatchObject({
      id: fileTabId("/repo/a.ts"),
      content: "from-repo1",
    })

    await act(async () => {
      foldersMock.setActiveFolderId(2)
    })

    expect(snap().tabs).toHaveLength(1)
    expect(snap().tabs[0]).toMatchObject({
      id: fileTabId("/repo/a.ts"),
      // File tabs are folder-free: identity is the absolute path.
      folderId: null,
      content: "from-repo1",
    })
    expect(snap().activeId).toBe(fileTabId("/repo/a.ts"))
  })

  it("opens the same relative path from two folders as two independent tabs", async () => {
    const snap = renderDecouple()

    await act(async () => {
      screen.getByText("open-a-f1").click()
    })
    await act(async () => {
      screen.getByText("open-a-f2").click()
    })

    expect(snap().tabs.map((t) => t.id)).toEqual([
      fileTabId("/repo/a.ts"),
      fileTabId("/repo2/a.ts"),
    ])
    expect(snap().tabs[0].content).toBe("from-repo1")
    expect(snap().tabs[1].content).toBe("from-repo2")
    expect(mockedApi.readFileForEdit).toHaveBeenCalledWith("/repo", "a.ts")
    expect(mockedApi.readFileForEdit).toHaveBeenCalledWith("/repo2", "a.ts")
  })

  it("saves a folder-2 tab through folder 2's root while folder 1 is active", async () => {
    mockedApi.saveFileContent.mockResolvedValue({
      path: "a.ts",
      etag: "e2-saved",
      mtime_ms: 2,
      readonly: false,
      line_ending: "lf",
    })
    const snap = renderDecouple()

    await act(async () => {
      screen.getByText("open-a-f2").click()
    })
    expect(snap().activeId).toBe(fileTabId("/repo2/a.ts"))

    await act(async () => {
      screen.getByText("edit").click()
    })
    expect(snap().tabs[0].isDirty).toBe(true)

    // Active WORKSPACE folder stays 1 — the save must still route to the
    // tab's own folder root.
    await act(async () => {
      screen.getByText("save").click()
    })

    expect(mockedApi.saveFileContent).toHaveBeenCalledTimes(1)
    expect(mockedApi.saveFileContent.mock.calls[0][0]).toBe("/repo2")
    expect(mockedApi.saveFileContent.mock.calls[0][1]).toBe("a.ts")
    expect(mockedApi.saveFileContent.mock.calls[0][2]).toBe("dirty-local")
  })

  it("keeps every tab open when its folder is removed — the files still exist", async () => {
    const snap = renderDecouple()

    await act(async () => {
      screen.getByText("open-a-f1").click()
    })
    await act(async () => {
      screen.getByText("open-a-f2").click()
    })
    expect(snap().tabs).toHaveLength(2)
    expect(workspaceStoreMock.acquiredCount("/repo2")).toBe(1)

    await act(async () => {
      useAppWorkspaceStore.setState({
        allFolders: [
          { id: 1, path: "/repo", name: "repo", color: "inherit" },
        ] as never,
      })
    })

    // Tab identity is the absolute path — removing the workspace folder
    // does not delete the file, so the tab survives; only its live watch
    // subscription (derived from the folder) is released.
    expect(snap().tabs).toHaveLength(2)
    expect(snap().activeId).toBe(fileTabId("/repo2/a.ts"))
    expect(workspaceStoreMock.acquiredCount("/repo2")).toBe(0)
    expect(workspaceStoreMock.acquiredCount("/repo")).toBe(1)
  })

  it("keeps tabs across a transient empty folder list (cold start / refresh)", async () => {
    const snap = renderDecouple()

    await act(async () => {
      screen.getByText("open-a-f1").click()
    })
    expect(snap().tabs).toHaveLength(1)

    await act(async () => {
      useAppWorkspaceStore.setState({ foldersHydrated: false, allFolders: [] })
    })
    expect(snap().tabs).toHaveLength(1)

    await act(async () => {
      useAppWorkspaceStore.setState({
        allFolders: [
          { id: 1, path: "/repo", name: "repo", color: "inherit" },
          { id: 2, path: "/repo2", name: "repo2", color: "inherit" },
        ] as never,
        foldersHydrated: true,
      })
    })
    expect(snap().tabs).toHaveLength(1)
    expect(snap().tabs[0].id).toBe(fileTabId("/repo/a.ts"))
  })

  it("keeps a dirty tab of a removed folder editable and pre-verifies its next save", async () => {
    mockedApi.saveFileContent.mockResolvedValue({
      path: "a.ts",
      etag: "e2-saved",
      mtime_ms: 2,
      readonly: false,
      line_ending: "lf",
    })
    const snap = renderDecouple()

    await act(async () => {
      screen.getByText("open-a-f2").click()
    })
    await act(async () => {
      screen.getByText("edit").click()
    })
    expect(snap().tabs[0]).toMatchObject({
      id: fileTabId("/repo2/a.ts"),
      isDirty: true,
    })

    await act(async () => {
      useAppWorkspaceStore.setState({
        allFolders: [
          { id: 1, path: "/repo", name: "repo", color: "inherit" },
        ] as never,
      })
    })

    // Unsaved edits survive untouched — no orphan wipe, no stale flag.
    expect(snap().tabs[0]).toMatchObject({
      id: fileTabId("/repo2/a.ts"),
      isDirty: true,
      content: "dirty-local",
    })

    // The tab is now UNWATCHED (outside every registered folder), so its
    // save must pre-verify against disk first. The mock keeps reporting
    // the original etag, so the save proceeds through (dirname, basename).
    const readsBefore = mockedApi.readFileForEdit.mock.calls.length
    await act(async () => {
      screen.getByText("save").click()
    })
    expect(mockedApi.readFileForEdit.mock.calls.length).toBe(readsBefore + 1)
    expect(mockedApi.saveFileContent).toHaveBeenCalledTimes(1)
    expect(mockedApi.saveFileContent.mock.calls[0][0]).toBe("/repo2")
    expect(mockedApi.saveFileContent.mock.calls[0][1]).toBe("a.ts")
  })
})

function ConflictProbe() {
  const { externalConflict, dismissExternalConflict } =
    useWorkspaceExternalConflict()
  return (
    <div>
      <output data-testid="conflict-head">
        {externalConflict ? externalConflict.path : "none"}
      </output>
      <button onClick={dismissExternalConflict}>dismiss-conflict</button>
    </div>
  )
}

function WatcherProbe({
  onCapture,
}: {
  onCapture: (snapshot: DecoupleSnapshot) => void
}) {
  const {
    openFilePreview,
    fileTabs,
    activeFileTabId,
    updateActiveFileContent,
    saveActiveFile,
    markTabsStale,
  } = useWorkspaceContext()
  onCapture({
    activeId: activeFileTabId,
    tabs: fileTabs.map((tab) => ({
      id: tab.id,
      folderId: tab.folderId,
      content: tab.content,
      isDirty: Boolean(tab.isDirty),
      stale: Boolean(tab.stale),
    })),
  })
  return (
    <div>
      <button onClick={() => void openFilePreview("a.ts")}>open-a-f1</button>
      <button onClick={() => void openFilePreview("a.ts", { folderId: 2 })}>
        open-a-f2
      </button>
      <button onClick={() => updateActiveFileContent("dirty-local")}>
        edit
      </button>
      <button onClick={() => void saveActiveFile()}>save</button>
      <button onClick={() => markTabsStale("/repo/a.ts")}>stale-a-f1</button>
    </div>
  )
}

describe("provider tab watcher (per-folder streams, lazy staleness)", () => {
  beforeEach(() => {
    mockedApi.readFileForEdit.mockReset()
    mockedApi.gitIsTracked.mockReset()
    mockedApi.gitShowFile.mockReset()
    mockedApi.saveFileContent.mockReset()
    mockedApi.gitIsTracked.mockResolvedValue(false)
    mockedApi.readFileForEdit.mockImplementation((root: string) =>
      Promise.resolve({
        path: "a.ts",
        content: root === "/repo2" ? "from-repo2" : "from-repo1",
        etag: root === "/repo2" ? "e2" : "e1",
        mtime_ms: 1,
        readonly: false,
        line_ending: "lf",
      })
    )
  })

  function renderWatcher() {
    let snap: DecoupleSnapshot = { activeId: null, tabs: [] }
    render(
      <WorkspaceProvider>
        <WatcherProbe onCapture={(s) => (snap = s)} />
        <ConflictProbe />
      </WorkspaceProvider>
    )
    return () => snap
  }

  it("acquires one refcount per folder with open tabs and releases on close, without keystroke churn", async () => {
    renderWatcher()

    await act(async () => {
      screen.getByText("open-a-f1").click()
    })
    expect(workspaceStoreMock.acquiredCount("/repo")).toBe(1)
    const callsAfterOpen = workspaceStoreMock.acquireCalls("/repo")

    // Keystrokes mutate fileTabs every render — the watch signature is
    // unchanged, so the subscription must NOT be rebuilt (blocker #13).
    await act(async () => {
      screen.getByText("edit").click()
    })
    await act(async () => {
      screen.getByText("edit").click()
    })
    expect(workspaceStoreMock.acquireCalls("/repo")).toBe(callsAfterOpen)

    await act(async () => {
      screen.getByText("open-a-f2").click()
    })
    expect(workspaceStoreMock.acquiredCount("/repo")).toBe(1)
    expect(workspaceStoreMock.acquiredCount("/repo2")).toBe(1)
  })

  it("marks a background folder's tab stale on its envelope without any disk read", async () => {
    const snap = renderWatcher()

    await act(async () => {
      screen.getByText("open-a-f1").click()
    })
    await act(async () => {
      screen.getByText("open-a-f2").click()
    })
    expect(snap().activeId).toBe(fileTabId("/repo2/a.ts"))
    const readsBefore = mockedApi.readFileForEdit.mock.calls.length

    await act(async () => {
      workspaceStoreMock.emitRoot("/repo", ["a.ts"])
    })

    const tabF1 = snap().tabs.find((t) => t.id === fileTabId("/repo/a.ts"))
    expect(tabF1?.stale).toBe(true)
    expect(tabF1?.content).toBe("from-repo1")
    // The lazy pillar: zero reads for background tabs.
    expect(mockedApi.readFileForEdit.mock.calls.length).toBe(readsBefore)
  })

  it("eagerly reconciles the ACTIVE tab on its folder's envelope (clean → in-place reload)", async () => {
    const snap = renderWatcher()

    await act(async () => {
      screen.getByText("open-a-f1").click()
    })
    expect(snap().tabs[0]?.content).toBe("from-repo1")

    mockedApi.readFileForEdit.mockResolvedValueOnce({
      path: "a.ts",
      content: "external-v2",
      etag: "e-ext",
      mtime_ms: 2,
      readonly: false,
      line_ending: "lf",
    })

    await act(async () => {
      workspaceStoreMock.emitRoot("/repo", ["a.ts"])
    })

    const tabA = snap().tabs.find((t) => t.id === fileTabId("/repo/a.ts"))
    expect(tabA?.content).toBe("external-v2")
    expect(tabA?.stale).toBe(false)
    expect(snap().activeId).toBe(fileTabId("/repo/a.ts"))
  })

  it("queues a conflict for the ACTIVE dirty tab instead of clobbering the buffer", async () => {
    const snap = renderWatcher()

    await act(async () => {
      screen.getByText("open-a-f1").click()
    })
    await act(async () => {
      screen.getByText("edit").click()
    })

    mockedApi.readFileForEdit.mockResolvedValueOnce({
      path: "a.ts",
      content: "disk-v2",
      etag: "e-ext",
      mtime_ms: 2,
      readonly: false,
      line_ending: "lf",
    })

    await act(async () => {
      workspaceStoreMock.emitRoot("/repo", ["a.ts"])
    })

    expect(screen.getByTestId("conflict-head")).toHaveTextContent("/repo/a.ts")
    const tabA = snap().tabs.find((t) => t.id === fileTabId("/repo/a.ts"))
    expect(tabA?.content).toBe("dirty-local")
    expect(tabA?.isDirty).toBe(true)
  })

  it("treats a resync_hint as a full sweep for that folder only", async () => {
    const snap = renderWatcher()

    await act(async () => {
      screen.getByText("open-a-f1").click()
    })
    await act(async () => {
      screen.getByText("open-a-f2").click()
    })
    expect(snap().activeId).toBe(fileTabId("/repo2/a.ts"))

    await act(async () => {
      workspaceStoreMock.emitRoot("/repo", [], "resync_hint")
    })

    expect(
      snap().tabs.find((t) => t.id === fileTabId("/repo/a.ts"))?.stale
    ).toBe(true)
    // The other folder's tab is untouched — sweeps are per-stream.
    expect(
      snap().tabs.find((t) => t.id === fileTabId("/repo2/a.ts"))?.stale
    ).toBe(false)
  })
})

describe("stale-aware save guard (all write paths funnel through saveFileTab)", () => {
  beforeEach(() => {
    mockedApi.readFileForEdit.mockReset()
    mockedApi.gitIsTracked.mockReset()
    mockedApi.gitShowFile.mockReset()
    mockedApi.saveFileContent.mockReset()
    mockedApi.gitIsTracked.mockResolvedValue(false)
  })

  function renderGuard() {
    let snap: DecoupleSnapshot = { activeId: null, tabs: [] }
    render(
      <WorkspaceProvider>
        <WatcherProbe onCapture={(s) => (snap = s)} />
        <ConflictProbe />
      </WorkspaceProvider>
    )
    return () => snap
  }

  it("refuses to save a stale dirty tab whose disk diverged, surfacing the conflict", async () => {
    // Open (etag e1) — later reads keep reporting a DIVERGED disk (e-div).
    mockedApi.readFileForEdit
      .mockResolvedValueOnce({
        path: "a.ts",
        content: "v1",
        etag: "e1",
        mtime_ms: 1,
        readonly: false,
        line_ending: "lf",
      })
      .mockResolvedValue({
        path: "a.ts",
        content: "disk-v2",
        etag: "e-div",
        mtime_ms: 2,
        readonly: false,
        line_ending: "lf",
      })
    const snap = renderGuard()

    await act(async () => {
      screen.getByText("open-a-f1").click()
    })
    await act(async () => {
      screen.getByText("edit").click()
    })
    await act(async () => {
      screen.getByText("stale-a-f1").click()
    })

    await act(async () => {
      screen.getByText("save").click()
    })

    // Blind write refused: no saveFileContent, buffer intact, conflict up.
    expect(mockedApi.saveFileContent).not.toHaveBeenCalled()
    const tabA = snap().tabs.find((t) => t.id === fileTabId("/repo/a.ts"))
    expect(tabA?.content).toBe("dirty-local")
    expect(tabA?.isDirty).toBe(true)
    expect(screen.getByTestId("conflict-head")).toHaveTextContent("/repo/a.ts")
  })

  it("proceeds with the save when the stale flag proves spurious (etag equal)", async () => {
    // Disk never changed: every read reports etag e1.
    mockedApi.readFileForEdit.mockResolvedValue({
      path: "a.ts",
      content: "v1",
      etag: "e1",
      mtime_ms: 1,
      readonly: false,
      line_ending: "lf",
    })
    mockedApi.saveFileContent.mockResolvedValue({
      path: "a.ts",
      etag: "e-saved",
      mtime_ms: 3,
      readonly: false,
      line_ending: "lf",
    })
    const snap = renderGuard()

    await act(async () => {
      screen.getByText("open-a-f1").click()
    })
    await act(async () => {
      screen.getByText("edit").click()
    })
    await act(async () => {
      screen.getByText("stale-a-f1").click()
    })

    await act(async () => {
      screen.getByText("save").click()
    })

    expect(mockedApi.saveFileContent).toHaveBeenCalledTimes(1)
    const tabA = snap().tabs.find((t) => t.id === fileTabId("/repo/a.ts"))
    expect(tabA?.isDirty).toBe(false)
    expect(tabA?.stale).toBe(false)
    expect(screen.getByTestId("conflict-head")).toHaveTextContent("none")
  })

  it("re-surfaces the conflict when the user saves again after dismissing the dialog", async () => {
    mockedApi.readFileForEdit
      .mockResolvedValueOnce({
        path: "a.ts",
        content: "v1",
        etag: "e1",
        mtime_ms: 1,
        readonly: false,
        line_ending: "lf",
      })
      .mockResolvedValue({
        path: "a.ts",
        content: "disk-v2",
        etag: "e-div",
        mtime_ms: 2,
        readonly: false,
        line_ending: "lf",
      })
    renderGuard()

    await act(async () => {
      screen.getByText("open-a-f1").click()
    })
    await act(async () => {
      screen.getByText("edit").click()
    })
    await act(async () => {
      screen.getByText("stale-a-f1").click()
    })
    await act(async () => {
      screen.getByText("save").click()
    })
    expect(screen.getByTestId("conflict-head")).toHaveTextContent("/repo/a.ts")

    // User closes the dialog without resolving.
    await act(async () => {
      screen.getByText("dismiss-conflict").click()
    })
    expect(screen.getByTestId("conflict-head")).toHaveTextContent("none")

    // Saving again is still refused (disk unchanged, still diverged) —
    // and the dialog MUST come back: a silent no-op would strand the tab.
    await act(async () => {
      screen.getByText("save").click()
    })
    expect(mockedApi.saveFileContent).not.toHaveBeenCalled()
    expect(screen.getByTestId("conflict-head")).toHaveTextContent("/repo/a.ts")
  })
})

function AbsolutePathProbe({
  onCapture,
}: {
  onCapture: (snapshot: DecoupleSnapshot) => void
}) {
  const {
    openFilePreview,
    fileTabs,
    activeFileTabId,
    updateActiveFileContent,
    saveActiveFile,
    switchFileTab,
  } = useWorkspaceContext()
  onCapture({
    activeId: activeFileTabId,
    tabs: fileTabs.map((tab) => ({
      id: tab.id,
      folderId: tab.folderId,
      content: tab.content,
      isDirty: Boolean(tab.isDirty),
      stale: Boolean(tab.stale),
    })),
  })
  return (
    <div>
      <button onClick={() => void openFilePreview("/outside/notes/plan.md")}>
        open-outside
      </button>
      <button onClick={() => void openFilePreview("~/notes/n.md")}>
        open-home
      </button>
      <button onClick={() => void openFilePreview("/repo2/src/x.ts")}>
        open-abs-f2
      </button>
      <button onClick={() => void openFilePreview("a.ts")}>open-a-f1</button>
      <button onClick={() => void openFilePreview("/repo/src/../a.ts")}>
        open-alias-a
      </button>
      <button onClick={() => void openFilePreview("c:/repo/src/a.ts")}>
        open-win-alias
      </button>
      <button onClick={() => void openFilePreview("src/i.ts", { folderId: 3 })}>
        open-nested-rel
      </button>
      <button
        onClick={() => void openFilePreview("/repo/packages/core/src/i.ts")}
      >
        open-nested-abs
      </button>
      <button onClick={() => updateActiveFileContent("dirty-local")}>
        edit
      </button>
      <button onClick={() => void saveActiveFile()}>save</button>
      <button
        onClick={() => switchFileTab(fileTabId("/outside/notes/plan.md"))}
      >
        switch-outside
      </button>
      <button onClick={() => switchFileTab(fileTabId("/repo/a.ts"))}>
        switch-a-f1
      </button>
    </div>
  )
}

describe("unified absolute-path file tabs (outside-workspace opens)", () => {
  beforeEach(() => {
    mockedApi.getHomeDirectory.mockReset()
    mockedApi.readFileForEdit.mockReset()
    mockedApi.gitIsTracked.mockReset()
    mockedApi.gitShowFile.mockReset()
    mockedApi.saveFileContent.mockReset()
    mockedApi.gitIsTracked.mockResolvedValue(false)
    resetHomeDirCacheForTests()
    mockedApi.readFileForEdit.mockImplementation((root: string, rel: string) =>
      Promise.resolve({
        path: rel,
        content: `content-of ${root}/${rel}`,
        etag: `etag ${root}/${rel}`,
        mtime_ms: 1,
        readonly: false,
        line_ending: "lf",
      })
    )
  })

  function renderAbsolute() {
    let snap: DecoupleSnapshot = { activeId: null, tabs: [] }
    render(
      <WorkspaceProvider>
        <AbsolutePathProbe onCapture={(s) => (snap = s)} />
        <ConflictProbe />
      </WorkspaceProvider>
    )
    return () => snap
  }

  it("opens a file outside every folder via (dirname, basename), unwatched and git-free", async () => {
    const snap = renderAbsolute()

    await act(async () => {
      screen.getByText("open-outside").click()
    })

    expect(snap().tabs).toHaveLength(1)
    expect(snap().tabs[0]).toMatchObject({
      id: fileTabId("/outside/notes/plan.md"),
      folderId: null,
      content: "content-of /outside/notes/plan.md",
    })
    expect(mockedApi.readFileForEdit).toHaveBeenCalledWith(
      "/outside/notes",
      "plan.md"
    )
    // No owning folder → no git context and no FS watch on the directory.
    expect(mockedApi.gitIsTracked).not.toHaveBeenCalled()
    expect(workspaceStoreMock.acquiredCount("/outside/notes")).toBe(0)
  })

  it("expands ~ against the backend home directory", async () => {
    mockedApi.getHomeDirectory.mockResolvedValue("/Users/me")
    const snap = renderAbsolute()

    await act(async () => {
      screen.getByText("open-home").click()
    })

    expect(mockedApi.getHomeDirectory).toHaveBeenCalledTimes(1)
    expect(mockedApi.readFileForEdit).toHaveBeenCalledWith(
      "/Users/me/notes",
      "n.md"
    )
    expect(snap().tabs[0].id).toBe(fileTabId("/Users/me/notes/n.md"))
  })

  it("derives the owning folder for an absolute path: git via the folder root, watch on it", async () => {
    const snap = renderAbsolute()

    await act(async () => {
      screen.getByText("open-abs-f2").click()
    })

    // IO is uniform (dirname, basename); the git base comes from the
    // OWNING registered folder, and the watch subscribes to its root.
    expect(mockedApi.readFileForEdit).toHaveBeenCalledWith("/repo2/src", "x.ts")
    expect(mockedApi.gitIsTracked).toHaveBeenCalledWith("/repo2", "src/x.ts")
    expect(workspaceStoreMock.acquiredCount("/repo2")).toBe(1)
    expect(snap().tabs[0].id).toBe(fileTabId("/repo2/src/x.ts"))
  })

  it("collapses dot-segment aliases of one file into a single tab", async () => {
    const snap = renderAbsolute()

    await act(async () => {
      screen.getByText("open-a-f1").click()
    })
    await act(async () => {
      screen.getByText("open-alias-a").click()
    })

    // "/repo/src/../a.ts" IS "/repo/a.ts" — one tab, one read.
    expect(snap().tabs).toHaveLength(1)
    expect(snap().tabs[0].id).toBe(fileTabId("/repo/a.ts"))
    expect(mockedApi.readFileForEdit).toHaveBeenCalledTimes(1)
  })

  it("canonicalizes root casing through the owning folder (Windows aliases)", async () => {
    useAppWorkspaceStore.setState({
      allFolders: [
        { id: 9, path: "C:/Repo", name: "win", color: "inherit" },
      ] as never,
    })
    const snap = renderAbsolute()

    await act(async () => {
      screen.getByText("open-win-alias").click()
    })

    // The agent echoed "c:/repo/…" but the registered folder is "C:/Repo" —
    // the tab identity takes the folder's casing, which is exactly what a
    // watch event (folder root + relative path) joins back to.
    expect(snap().tabs[0].id).toBe(fileTabId("C:/Repo/src/a.ts"))
    expect(workspaceStoreMock.acquiredCount("C:/Repo")).toBe(1)
  })

  it("dedupes the same physical file opened through a nested folder and an absolute path", async () => {
    useAppWorkspaceStore.setState({
      allFolders: [
        { id: 1, path: "/repo", name: "repo", color: "inherit" },
        { id: 2, path: "/repo2", name: "repo2", color: "inherit" },
        { id: 3, path: "/repo/packages/core", name: "core", color: "inherit" },
      ] as never,
    })
    const snap = renderAbsolute()

    await act(async () => {
      screen.getByText("open-nested-rel").click()
    })
    await act(async () => {
      screen.getByText("open-nested-abs").click()
    })

    // One physical file → one tab, regardless of the entrance.
    expect(snap().tabs).toHaveLength(1)
    expect(snap().tabs[0].id).toBe(fileTabId("/repo/packages/core/src/i.ts"))
    expect(mockedApi.readFileForEdit).toHaveBeenCalledTimes(1)
  })

  it("pre-verifies every save of an unwatched file and surfaces divergence as a conflict", async () => {
    const snap = renderAbsolute()

    await act(async () => {
      screen.getByText("open-outside").click()
    })
    await act(async () => {
      screen.getByText("edit").click()
    })

    // Disk moved on since the open — the pre-verify read reports a
    // different etag, so the blind write must be refused.
    mockedApi.readFileForEdit.mockResolvedValueOnce({
      path: "plan.md",
      content: "disk-v2",
      etag: "e-div",
      mtime_ms: 2,
      readonly: false,
      line_ending: "lf",
    })
    await act(async () => {
      screen.getByText("save").click()
    })

    expect(mockedApi.saveFileContent).not.toHaveBeenCalled()
    expect(screen.getByTestId("conflict-head")).toHaveTextContent(
      "/outside/notes/plan.md"
    )
    expect(snap().tabs[0]).toMatchObject({
      isDirty: true,
      content: "dirty-local",
    })
  })

  it("re-verifies an unwatched tab on activation transitions, never on keystrokes", async () => {
    const snap = renderAbsolute()

    await act(async () => {
      screen.getByText("open-outside").click()
    })
    const readsAfterOpen = mockedApi.readFileForEdit.mock.calls.length
    // The just-opened tab is active — the activation pass must NOT
    // immediately re-read what openFilePreview just loaded.
    expect(readsAfterOpen).toBe(1)

    await act(async () => {
      screen.getByText("open-a-f1").click()
    })

    // Disk changed while the outside tab sat inactive. Re-activating it
    // triggers exactly one freshness read and absorbs the new content.
    mockedApi.readFileForEdit.mockResolvedValueOnce({
      path: "plan.md",
      content: "outside-v2",
      etag: "e-v2",
      mtime_ms: 3,
      readonly: false,
      line_ending: "lf",
    })
    await act(async () => {
      screen.getByText("switch-outside").click()
    })

    const outsideTab = snap().tabs.find(
      (t) => t.id === fileTabId("/outside/notes/plan.md")
    )
    expect(outsideTab?.content).toBe("outside-v2")

    // Keystroke re-renders on the same active tab must not re-read.
    const readsAfterFreshness = mockedApi.readFileForEdit.mock.calls.length
    await act(async () => {
      screen.getByText("edit").click()
    })
    await act(async () => {
      screen.getByText("edit").click()
    })
    expect(mockedApi.readFileForEdit.mock.calls.length).toBe(
      readsAfterFreshness
    )
  })
})

describe("browser tabs", () => {
  beforeEach(() => {
    resetBrowserTabStoreForTests()
    resetClosedTabStackForTests()
    resetBrowserPrefsForTests()
    remoteMock.remote = false
    remoteMock.serverBaseUrl = "https://dev.example.com"
  })

  function BrowserProbe() {
    const {
      openBrowserTab,
      adoptBrowserTab,
      closeFileTab,
      restoreBrowserTabs,
      suspendBrowserTab,
      setActivePane,
    } = useWorkspaceActions()
    const { fileTabs, activeFileTabId } = useWorkspaceFileTabs()
    const { activePane } = useWorkspaceView()
    return (
      <div>
        <button onClick={() => openBrowserTab("https://example.com/docs#top")}>
          open
        </button>
        <button
          onClick={() =>
            openBrowserTab("https://example.com/docs#other", {
              activate: true,
            })
          }
        >
          open-same
        </button>
        <button
          onClick={() =>
            openBrowserTab("http://localhost:3000/", { activate: false })
          }
        >
          open-bg
        </button>
        <button
          onClick={() =>
            openBrowserTab("http://localhost:4000/", { activate: "tab" })
          }
        >
          open-shown
        </button>
        <button onClick={() => setActivePane("conversation")}>
          to-conversation
        </button>
        <button onClick={() => openBrowserTab("not a url")}>open-bad</button>
        <button onClick={() => openBrowserTab("about:blank")}>
          open-blank
        </button>
        <button
          onClick={() =>
            openBrowserTab("https://example.com/docs#top", {
              profile: "p-work",
            })
          }
        >
          open-work
        </button>
        <button
          onClick={() => {
            const opener = fileTabs.find((t) => t.kind === "browser")
            if (!opener) return
            openBrowserTab("https://example.com/next", {
              activate: false,
              openerTabId: opener.id,
            })
          }}
        >
          open-next
        </button>
        <button
          onClick={() => {
            const opener = fileTabs.find((t) => t.kind === "browser")
            if (!opener) return
            const parts = opener.id.slice("browser:".length)
            adoptBrowserTab({
              backendTabId: `${parts}-p1`,
              url: "https://example.com/popup",
              openerBackendTabId: parts,
            })
          }}
        >
          adopt
        </button>
        <button
          onClick={() =>
            adoptBrowserTab({
              backendTabId: "orphan-p1",
              url: "https://example.com/orphan-popup",
              openerBackendTabId: "gone",
              profile: "p-work",
            })
          }
        >
          adopt-orphan
        </button>
        <button
          onClick={() => {
            const opener = fileTabs.find(
              (t) => t.kind === "browser" && t.browser.profile === "default"
            )
            if (!opener) return
            adoptBrowserTab({
              backendTabId: "named-p1",
              url: "https://example.com/named-popup",
              openerBackendTabId: opener.id.slice("browser:".length),
              profile: "p-work",
            })
          }}
        >
          adopt-named
        </button>
        <button
          onClick={() => {
            const openers = fileTabs.filter((t) => t.kind === "browser")
            const opener = openers[openers.length - 1]
            if (!opener) return
            openBrowserTab("https://example.com/from-last", {
              activate: false,
              openerTabId: opener.id,
            })
          }}
        >
          open-next-from-last
        </button>
        <button
          onClick={() => {
            if (activeFileTabId) closeFileTab(activeFileTabId)
          }}
        >
          close-active
        </button>
        <button
          onClick={() => {
            const tab = fileTabs[1]
            if (tab) closeFileTab(tab.id)
          }}
        >
          close-second
        </button>
        {/* What the reopen shortcut does with a browser entry it pops. */}
        <button
          onClick={() => {
            const closed = popClosedTab()
            if (closed?.kind !== "browser") return
            openBrowserTab(closed.url, {
              folderId: closed.folderId ?? undefined,
              index: closed.index,
            })
          }}
        >
          reopen-closed
        </button>
        <button
          onClick={() =>
            restoreBrowserTabs([
              {
                url: "https://restored.example/one",
                title: "One",
                folderId: 7,
                profile: "default",
              },
              {
                url: "not a url",
                title: "bad",
                folderId: null,
                profile: "default",
              },
              {
                url: "https://restored.example/two",
                title: "",
                folderId: null,
                profile: "default",
              },
            ])
          }
        >
          restore
        </button>
        <button
          onClick={() => {
            const tab = fileTabs.find((t) => t.kind === "browser")
            if (tab) suspendBrowserTab(tab.id)
          }}
        >
          suspend-first
        </button>
        <button
          onClick={() => {
            const tabs = fileTabs.filter((t) => t.kind === "browser")
            const tab = tabs[tabs.length - 1]
            if (tab) suspendBrowserTab(tab.id)
          }}
        >
          suspend-last
        </button>
        <button
          onClick={() =>
            openBrowserTab("http://localhost:3000/", {
              remote: true,
              profile: "p-work",
            })
          }
        >
          open-remote
        </button>
        <button onClick={() => openBrowserTab("http://localhost:3000/")}>
          open-local-3000
        </button>
        <button
          onClick={() =>
            openBrowserTab("http://localhost:3000/", { profile: "p-work" })
          }
        >
          open-work-3000
        </button>
        <button
          onClick={() =>
            openBrowserTab("http://localhost:3000/", { remote: false })
          }
        >
          open-here-3000
        </button>
        <button onClick={() => openBrowserTab("http://192.168.1.5:3000/")}>
          open-server-host
        </button>
        <button
          onClick={() =>
            restoreBrowserTabs([
              {
                url: "http://127.0.0.1:8080/",
                title: "",
                folderId: null,
                profile: "default",
              },
            ])
          }
        >
          restore-unmarked
        </button>
        <button
          onClick={() => {
            const opener = fileTabs.find(
              (t) => t.kind === "browser" && t.browser.remote === true
            )
            if (!opener) return
            openBrowserTab("http://localhost:3000/next", {
              activate: false,
              openerTabId: opener.id,
            })
          }}
        >
          open-from-remote
        </button>
        <button
          onClick={() => {
            const opener = fileTabs.find(
              (t) => t.kind === "browser" && t.browser.remote === true
            )
            if (!opener) return
            adoptBrowserTab({
              backendTabId: `${opener.id.slice("browser:".length)}-p1`,
              url: "http://localhost:3000/popup",
              openerBackendTabId: opener.id.slice("browser:".length),
            })
          }}
        >
          adopt-from-remote
        </button>
        <button
          onClick={() =>
            restoreBrowserTabs([
              {
                url: "http://localhost:5173/",
                title: "",
                folderId: null,
                profile: "p-work",
                remote: true,
              },
              {
                url: "http://localhost:5173/",
                title: "",
                folderId: null,
                profile: "default",
              },
            ])
          }
        >
          restore-remote
        </button>
        <pre data-testid="tabs">
          {JSON.stringify(
            fileTabs.map((t) => ({
              id: t.id,
              kind: t.kind,
              title: t.title,
              path: t.path,
              opener: t.kind === "browser" ? t.browser.openerTabId : undefined,
              url: t.kind === "browser" ? t.browser.initialUrl : undefined,
              profile: t.kind === "browser" ? t.browser.profile : undefined,
              remote:
                t.kind === "browser" ? t.browser.remote === true : undefined,
            }))
          )}
        </pre>
        <span data-testid="active">{activeFileTabId ?? ""}</span>
        <span data-testid="pane">{activePane}</span>
      </div>
    )
  }

  function readTabs(): Array<{
    id: string
    kind: string
    title: string
    path: string | null
    opener?: string | null
    url?: string
    profile?: string
    remote?: boolean
  }> {
    return JSON.parse(screen.getByTestId("tabs").textContent ?? "[]")
  }

  it("opens one browser tab per URL, activates it, and de-dupes by URL without fragment", () => {
    render(
      <WorkspaceProvider>
        <BrowserProbe />
      </WorkspaceProvider>
    )
    act(() => screen.getByText("open").click())
    let tabs = readTabs()
    expect(tabs).toHaveLength(1)
    expect(tabs[0].kind).toBe("browser")
    expect(tabs[0].id.startsWith("browser:")).toBe(true)
    expect(tabs[0].path).toBeNull()
    expect(tabs[0].title).toBe("example.com")
    expect(screen.getByTestId("active").textContent).toBe(tabs[0].id)
    expect(screen.getByTestId("pane").textContent).toBe("files")

    act(() => screen.getByText("open-same").click())
    tabs = readTabs()
    expect(tabs).toHaveLength(1)

    act(() => screen.getByText("open-bad").click())
    expect(readTabs()).toHaveLength(1)

    act(() => screen.getByText("open-bg").click())
    tabs = readTabs()
    expect(tabs).toHaveLength(2)
    // Background open must not steal the active tab.
    expect(screen.getByTestId("active").textContent).toBe(tabs[0].id)
  })

  it("gives every request for the blank page its own empty tab", () => {
    render(
      <WorkspaceProvider>
        <BrowserProbe />
      </WorkspaceProvider>
    )
    act(() => screen.getByText("open-blank").click())
    act(() => screen.getByText("open-blank").click())
    const tabs = readTabs()
    // Two empty tabs, not one page opened twice. Dedupe by opening URL would
    // also hand back a blank tab the user had since navigated somewhere —
    // the record keeps `about:blank` for the tab's whole life.
    expect(tabs.map((t) => t.url)).toEqual(["about:blank", "about:blank"])
    expect(tabs[0].id).not.toBe(tabs[1].id)
    // The second click is a request for a NEW empty tab, so that is the one
    // brought to the front.
    expect(screen.getByTestId("active").textContent).toBe(tabs[1].id)

    // A real page still de-dupes.
    act(() => screen.getByText("open").click())
    act(() => screen.getByText("open-same").click())
    expect(readTabs()).toHaveLength(3)
  })

  it("inserts an adopted popup right after its opener and activates it", () => {
    render(
      <WorkspaceProvider>
        <BrowserProbe />
      </WorkspaceProvider>
    )
    act(() => screen.getByText("open").click())
    act(() => screen.getByText("open-bg").click())
    act(() => screen.getByText("adopt").click())
    const tabs = readTabs()
    expect(tabs.map((t) => t.url)).toEqual([
      "https://example.com/docs#top",
      "https://example.com/popup",
      "http://localhost:3000/",
    ])
    expect(tabs[1].id).toBe(`${tabs[0].id}-p1`)
    expect(tabs[1].opener).toBe(tabs[0].id)
    expect(screen.getByTestId("active").textContent).toBe(tabs[1].id)
  })

  it("inserts a modifier-click tab right after its opener without activating it", () => {
    render(
      <WorkspaceProvider>
        <BrowserProbe />
      </WorkspaceProvider>
    )
    act(() => screen.getByText("open").click())
    act(() => screen.getByText("open-bg").click())
    act(() => screen.getByText("open-next").click())
    const tabs = readTabs()
    expect(tabs.map((t) => t.url)).toEqual([
      "https://example.com/docs#top",
      "https://example.com/next",
      "http://localhost:3000/",
    ])
    expect(tabs[1].opener).toBe(tabs[0].id)
    // Like a browser: the page the user is reading stays in front.
    expect(screen.getByTestId("active").textContent).toBe(tabs[0].id)
  })

  // The strip and the column are one surface: a tab sitting in the strip
  // while the column shows "open a file from the right panel" is a dead end
  // the user can only leave by clicking the tab already in front of them.
  it("shows a background tab when nothing else holds the selection", () => {
    render(
      <WorkspaceProvider>
        <BrowserProbe />
      </WorkspaceProvider>
    )
    act(() => screen.getByText("open-bg").click())
    const tabs = readTabs()
    expect(tabs).toHaveLength(1)
    expect(screen.getByTestId("active").textContent).toBe(tabs[0].id)
    // Claimed, not activated: whichever pane the user was on is still the
    // one in front.
    expect(screen.getByTestId("pane").textContent).toBe("conversation")
  })

  it("selects a tab opened with `tab` without pulling the files pane forward", () => {
    render(
      <WorkspaceProvider>
        <BrowserProbe />
      </WorkspaceProvider>
    )
    act(() => screen.getByText("open").click())
    act(() => screen.getByText("to-conversation").click())
    expect(screen.getByTestId("pane").textContent).toBe("conversation")

    act(() => screen.getByText("open-shown").click())
    const tabs = readTabs()
    expect(tabs).toHaveLength(2)
    // Selected even though the strip was not empty: a page opened for someone
    // is only opened if it is the one the column shows.
    expect(screen.getByTestId("active").textContent).toBe(tabs[1].id)
    expect(screen.getByTestId("pane").textContent).toBe("conversation")

    // An ordinary open still brings the pane forward...
    act(() => screen.getByText("open").click())
    expect(screen.getByTestId("active").textContent).toBe(tabs[0].id)
    expect(screen.getByTestId("pane").textContent).toBe("files")

    // ...and a second `tab` open of an address already in the strip
    // re-selects that tab, again without moving the pane.
    act(() => screen.getByText("to-conversation").click())
    act(() => screen.getByText("open-shown").click())
    expect(readTabs()).toHaveLength(2)
    expect(screen.getByTestId("active").textContent).toBe(tabs[1].id)
    expect(screen.getByTestId("pane").textContent).toBe("conversation")
  })

  it("closes a browser tab without a dirty prompt and moves activation to a neighbour", () => {
    const confirmSpy = vi.spyOn(window, "confirm")
    render(
      <WorkspaceProvider>
        <BrowserProbe />
      </WorkspaceProvider>
    )
    act(() => screen.getByText("open").click())
    act(() => screen.getByText("open-bg").click())
    act(() => screen.getByText("close-active").click())
    expect(confirmSpy).not.toHaveBeenCalled()
    const tabs = readTabs()
    expect(tabs).toHaveLength(1)
    expect(tabs[0].url).toBe("http://localhost:3000/")
    expect(screen.getByTestId("active").textContent).toBe(tabs[0].id)
    confirmSpy.mockRestore()
  })

  // Restored records carry their stored title and folder, are appended in
  // order, and none is activated: the surface of a restored tab is created
  // when it is first shown, not at startup.
  it("restores stored tabs as inactive records, skipping unusable addresses", () => {
    render(
      <WorkspaceProvider>
        <BrowserProbe />
      </WorkspaceProvider>
    )
    act(() => screen.getByText("restore").click())
    const tabs = readTabs()
    expect(tabs.map((t) => t.url)).toEqual([
      "https://restored.example/one",
      "https://restored.example/two",
    ])
    expect(tabs[0].title).toBe("One")
    // No stored title: the host, as for any freshly opened tab.
    expect(tabs[1].title).toBe("restored.example")
    expect(screen.getByTestId("active").textContent).toBe("")
    expect(screen.getByTestId("pane").textContent).toBe("conversation")

    // A second restore (another document of the same run) is a no-op.
    act(() => screen.getByText("restore").click())
    expect(readTabs()).toHaveLength(2)
  })

  // A tab opened before the restore ran (a deep link, an agent request —
  // the capability probe is a round trip) must not cost the user the stored
  // set; and a page already open must not be duplicated.
  it("merges a restore into tabs this window already has", () => {
    render(
      <WorkspaceProvider>
        <BrowserProbe />
      </WorkspaceProvider>
    )
    act(() => screen.getByText("open").click())
    act(() => screen.getByText("restore").click())
    expect(readTabs().map((t) => t.url)).toEqual([
      "https://example.com/docs#top",
      "https://restored.example/one",
      "https://restored.example/two",
    ])

    // The one-tab-per-URL rule holds across a repeat restore.
    act(() => screen.getByText("restore").click())
    expect(readTabs()).toHaveLength(3)
  })

  // A profile is a separate cookie jar: the same page in two profiles is two
  // sessions, so it is two tabs; within one profile the one-tab rule holds.
  it("keeps one tab per URL per profile and inherits the opener's profile", () => {
    setBrowserProfiles([{ id: "p-work", name: "Work" }])
    render(
      <WorkspaceProvider>
        <BrowserProbe />
      </WorkspaceProvider>
    )
    act(() => screen.getByText("open").click())
    expect(readTabs().map((t) => t.profile)).toEqual(["default"])
    act(() => screen.getByText("open-work").click())
    expect(readTabs().map((t) => t.profile)).toEqual(["default", "p-work"])
    // Same page, same profile: the existing tab is activated instead.
    act(() => screen.getByText("open-work").click())
    expect(readTabs()).toHaveLength(2)
    expect(screen.getByTestId("active").textContent).toBe(readTabs()[1].id)

    // Opened from another tab (⌘-click): the opener's profile wins over the
    // preference — the work tab is last in the strip, the preference is
    // default, so only inheritance yields p-work.
    act(() => screen.getByText("open-next-from-last").click())
    const next = readTabs().find(
      (t) => t.url === "https://example.com/from-last"
    )
    expect(next?.profile).toBe("p-work")
    // `open-next` uses the first browser tab as opener (the default one).
    act(() => screen.getByText("open-next").click())
    expect(
      readTabs().find((t) => t.url === "https://example.com/next")?.profile
    ).toBe("default")
    // A popup adopted from the default tab says so as well.
    act(() => screen.getByText("adopt").click())
    const popup = readTabs().find((t) => t.url === "https://example.com/popup")
    expect(popup?.profile).toBe("default")
  })

  // An address of the remote codeg host is its own kind of tab: never the
  // same tab as the local page on that address, never in a local profile.
  it("keeps a remote tab apart from the local page on the same address", () => {
    setBrowserProfiles([{ id: "p-work", name: "Work" }])
    render(
      <WorkspaceProvider>
        <BrowserProbe />
      </WorkspaceProvider>
    )
    act(() => screen.getByText("open-remote").click())
    let tabs = readTabs()
    expect(tabs).toHaveLength(1)
    expect(tabs[0].remote).toBe(true)
    // The profile asked for has no say: the page is not in any profile of
    // this computer.
    expect(tabs[0].profile).toBe("default")
    // The local page on the same address is a different tab…
    act(() => screen.getByText("open-local-3000").click())
    tabs = readTabs()
    expect(tabs).toHaveLength(2)
    expect(tabs.map((t) => t.remote)).toEqual([true, false])
    // …and asking for the remote one again brings that one back.
    act(() => screen.getByText("open-remote").click())
    expect(readTabs()).toHaveLength(2)
    expect(screen.getByTestId("active").textContent).toBe(tabs[0].id)
  })

  // A remote tab carries the default profile's id but is not a page of that
  // profile: it must never make a local tab of a deleted profile a duplicate.
  it("moves a dormant tab of a deleted profile past a remote tab on its page", () => {
    setBrowserProfiles([{ id: "p-work", name: "Work" }])
    render(
      <WorkspaceProvider>
        <BrowserProbe />
      </WorkspaceProvider>
    )
    act(() => screen.getByText("open-remote").click())
    act(() => screen.getByText("open-work-3000").click())
    act(() => setBrowserProfiles([]))
    expect(readTabs().map((t) => [t.remote, t.profile])).toEqual([
      [true, "default"],
      [false, "default"],
    ])
  })

  it("suspends a loaded tab of a deleted profile past a remote tab on its page", () => {
    setBrowserProfiles([{ id: "p-work", name: "Work" }])
    render(
      <WorkspaceProvider>
        <BrowserProbe />
      </WorkspaceProvider>
    )
    act(() => screen.getByText("open-remote").click())
    act(() => screen.getByText("open-work-3000").click())
    const local = readTabs()[1]
    act(() =>
      setBrowserTabState({
        tabId: local.id.slice("browser:".length),
        ownerWindow: "main",
        kind: "page",
        surface: "child",
        channel: "native",
        channelError: null,
        url: "http://localhost:3000/",
        requestedUrl: "http://localhost:3000/",
        title: "Local",
        favicon: null,
        loading: false,
        canGoBack: false,
        canGoForward: false,
        origin: "http://localhost:3000",
        zoom: 1,
        error: null,
        remoteHost: null,
        openerTabId: null,
        profile: "p-work",
        agentGrant: null,
      })
    )
    act(() => setBrowserProfiles([]))
    act(() => markBrowserTabHidden(local.id))
    act(() => screen.getByText("suspend-last").click())
    expect(readTabs().map((t) => [t.remote, t.profile])).toEqual([
      [true, "default"],
      [false, "default"],
    ])
  })

  // However it came to be opened — a page's ⌘-click, a refused pop-up opened
  // anyway — an address of the remote host is remote in a remote window.
  it("opens any address of the remote host as remote in a remote window", () => {
    remoteMock.remote = true
    render(
      <WorkspaceProvider>
        <BrowserProbe />
      </WorkspaceProvider>
    )
    act(() => screen.getByText("open-local-3000").click())
    act(() => screen.getByText("open").click())
    expect(readTabs().map((t) => [t.url, t.remote])).toEqual([
      ["http://localhost:3000/", true],
      // A public page is the same page from here.
      ["https://example.com/docs#top", false],
    ])
  })

  it("keeps an address a person opens on this computer local", () => {
    remoteMock.remote = true
    render(
      <WorkspaceProvider>
        <BrowserProbe />
      </WorkspaceProvider>
    )
    act(() => screen.getByText("open-here-3000").click())
    expect(readTabs()[0].remote).toBe(false)
  })

  // The window reaches the server itself directly: its own private address
  // is reachable from this computer.
  it("leaves the server's own private address to this computer", () => {
    remoteMock.remote = true
    remoteMock.serverBaseUrl = "http://192.168.1.5:3080"
    render(
      <WorkspaceProvider>
        <BrowserProbe />
      </WorkspaceProvider>
    )
    act(() => screen.getByText("open-server-host").click())
    expect(readTabs()[0].remote).toBe(false)
  })

  it("restores an address of the remote host as remote even without the mark", () => {
    remoteMock.remote = true
    render(
      <WorkspaceProvider>
        <BrowserProbe />
      </WorkspaceProvider>
    )
    act(() => screen.getByText("restore-unmarked").click())
    expect(readTabs()[0].remote).toBe(true)
  })

  it("makes a tab opened from a remote tab, and its popups, remote too", () => {
    render(
      <WorkspaceProvider>
        <BrowserProbe />
      </WorkspaceProvider>
    )
    act(() => screen.getByText("open-remote").click())
    act(() => screen.getByText("open-from-remote").click())
    act(() => screen.getByText("adopt-from-remote").click())
    const byUrl = new Map(readTabs().map((t) => [t.url, t]))
    expect(byUrl.get("http://localhost:3000/next")?.remote).toBe(true)
    expect(byUrl.get("http://localhost:3000/popup")?.remote).toBe(true)
  })

  it("restores a remote tab as remote, beside the local page on its address", () => {
    setBrowserProfiles([{ id: "p-work", name: "Work" }])
    render(
      <WorkspaceProvider>
        <BrowserProbe />
      </WorkspaceProvider>
    )
    act(() => screen.getByText("restore-remote").click())
    const tabs = readTabs()
    expect(tabs.map((t) => [t.url, t.remote, t.profile])).toEqual([
      ["http://localhost:5173/", true, "default"],
      ["http://localhost:5173/", false, "default"],
    ])
  })

  // A tab of a deleted profile must never recreate that profile's store:
  // reopening (⇧⌘T) and dormant records both land in the default profile.
  it("moves tabs of a deleted profile to the default one", () => {
    setBrowserProfiles([{ id: "p-work", name: "Work" }])
    render(
      <WorkspaceProvider>
        <BrowserProbe />
      </WorkspaceProvider>
    )
    act(() => screen.getByText("open-work").click())
    expect(readTabs().map((t) => t.profile)).toEqual(["p-work"])
    // A tab whose surface is being created (claimed, no state yet) is not
    // dormant either: the backend will close it with the profile.
    const claimed = readTabs()[0]
    claimSurfaceCreation(claimed.id.slice("browser:".length))
    act(() => setBrowserProfiles([]))
    expect(readTabs().map((t) => t.profile)).toEqual(["p-work"])
    forgetSurfaceCreation(claimed.id.slice("browser:".length))
    act(() => setBrowserProfiles([{ id: "p-work", name: "Work" }]))

    // A loaded tab keeps naming its profile until the backend closes it
    // (its surface still lives in that store); only dormant records move.
    const loaded = readTabs()[0]
    act(() =>
      setBrowserTabState({
        tabId: loaded.id.slice("browser:".length),
        ownerWindow: "main",
        kind: "page",
        surface: "child",
        channel: "native",
        channelError: null,
        url: "https://example.com/docs",
        requestedUrl: "https://example.com/docs",
        title: "Docs",
        favicon: null,
        loading: false,
        canGoBack: false,
        canGoForward: false,
        origin: "https://example.com",
        zoom: 1,
        error: null,
        remoteHost: null,
        openerTabId: null,
        profile: "p-work",
        agentGrant: null,
      })
    )
    act(() => setBrowserProfiles([]))
    expect(readTabs().map((t) => t.profile)).toEqual(["p-work"])
    // Suspending it now leaves a dormant record that must not name the
    // deleted profile.
    act(() => markBrowserTabHidden(loaded.id))
    act(() => screen.getByText("suspend-first").click())
    expect(readTabs().map((t) => t.profile)).toEqual(["default"])

    // Suspending a loaded tab of a deleted profile whose page the default
    // profile already shows drops the record instead of duplicating it.
    act(() => setBrowserProfiles([{ id: "p-work", name: "Work" }]))
    act(() => screen.getByText("open-work").click())
    const second = readTabs().find((t) => t.profile === "p-work")!
    act(() =>
      setBrowserTabState({
        tabId: second.id.slice("browser:".length),
        ownerWindow: "main",
        kind: "page",
        surface: "child",
        channel: "native",
        channelError: null,
        url: "https://example.com/docs",
        requestedUrl: "https://example.com/docs",
        title: "Docs again",
        favicon: null,
        loading: false,
        canGoBack: false,
        canGoForward: false,
        origin: "https://example.com",
        zoom: 1,
        error: null,
        remoteHost: null,
        openerTabId: null,
        profile: "p-work",
        agentGrant: null,
      })
    )
    act(() => setBrowserProfiles([]))
    // It was the active tab (opened last, activated); the pane may be
    // hidden with it selected, so the pointer must move to the survivor.
    expect(screen.getByTestId("active").textContent).toBe(second.id)
    act(() => markBrowserTabHidden(second.id))
    act(() => screen.getByText("suspend-last").click())
    expect(readTabs().map((t) => t.profile)).toEqual(["default"])
    expect(readTabs()).toHaveLength(1)
    expect(screen.getByTestId("active").textContent).toBe(readTabs()[0].id)

    // A dormant record of a deleted profile whose page the default profile
    // already shows is dropped rather than duplicated.
    act(() => setBrowserProfiles([{ id: "p-work", name: "Work" }]))
    act(() => screen.getByText("open-work").click())
    expect(readTabs().map((t) => t.profile)).toEqual(["default", "p-work"])
    act(() => setBrowserProfiles([]))
    expect(readTabs().map((t) => t.profile)).toEqual(["default"])
    // Asking for the deleted profile outright is answered with the default.
    act(() => screen.getByText("open-work").click())
    expect(readTabs().map((t) => t.profile)).toEqual(["default"])
    expect(readTabs()).toHaveLength(1)
  })

  it("adopts a popup in the profile the backend names, over the opener's and without one", () => {
    render(
      <WorkspaceProvider>
        <BrowserProbe />
      </WorkspaceProvider>
    )
    act(() => screen.getByText("adopt-orphan").click())
    expect(
      readTabs().find((t) => t.url === "https://example.com/orphan-popup")
        ?.profile
    ).toBe("p-work")
    // With an opener present IN THE DEFAULT PROFILE the backend's word
    // (p-work) still wins over the opener's.
    act(() => screen.getByText("open").click())
    expect(
      readTabs().find((t) => t.url === "https://example.com/docs#top")?.profile
    ).toBe("default")
    act(() => screen.getByText("adopt-named").click())
    const named = readTabs().find(
      (t) => t.url === "https://example.com/named-popup"
    )
    expect(named?.profile).toBe("p-work")
    expect(named?.opener).toBe(
      readTabs().find((t) => t.url === "https://example.com/docs#top")?.id
    )
  })

  it("opens new tabs in the preferred profile when it exists", () => {
    setBrowserProfiles([{ id: "p-work", name: "Work" }])
    setBrowserNewTabProfile("p-work")
    render(
      <WorkspaceProvider>
        <BrowserProbe />
      </WorkspaceProvider>
    )
    act(() => screen.getByText("open").click())
    expect(readTabs().map((t) => t.profile)).toEqual(["p-work"])
    // Restored records keep the profile they were saved with.
    act(() => screen.getByText("restore").click())
    expect(
      readTabs()
        .filter((t) => t.url?.startsWith("https://restored.example/"))
        .map((t) => t.profile)
    ).toEqual(["default", "default"])
  })

  it("suspending a loaded tab keeps the record at the page it was showing", () => {
    render(
      <WorkspaceProvider>
        <BrowserProbe />
      </WorkspaceProvider>
    )
    act(() => screen.getByText("open").click())
    const opened = readTabs()[0]
    const backendId = opened.id.slice("browser:".length)
    act(() =>
      setBrowserTabState({
        tabId: backendId,
        ownerWindow: "main",
        kind: "page",
        surface: "child",
        channel: "native",
        channelError: null,
        url: "https://example.com/docs/deep",
        requestedUrl: "https://example.com/docs/deep",
        title: "Deep",
        favicon: null,
        loading: false,
        canGoBack: true,
        canGoForward: false,
        origin: "https://example.com",
        zoom: 1,
        error: null,
        remoteHost: null,
        openerTabId: null,
        profile: "default",
        agentGrant: null,
      })
    )
    // Only a tab that is off screen may be released; the suspender's own
    // bookkeeping says so, and the action re-checks it.
    act(() => screen.getByText("suspend-first").click())
    expect(readTabs()[0].url).toBe("https://example.com/docs#top")
    act(() => markBrowserTabHidden(opened.id))

    act(() => screen.getByText("suspend-first").click())
    const tabs = readTabs()
    expect(tabs).toHaveLength(1)
    expect(tabs[0].id).toBe(opened.id)
    expect(tabs[0].url).toBe("https://example.com/docs/deep")
    expect(tabs[0].title).toBe("Deep")
    // The native surface is gone; the record is "not loaded" again.
    expect(getBrowserTabState(opened.id)).toBeNull()

    // Nothing to release the second time.
    act(() => screen.getByText("suspend-first").click())
    expect(readTabs()).toHaveLength(1)
  })

  it("records a closed browser tab so it can be reopened at its page", () => {
    render(
      <WorkspaceProvider>
        <BrowserProbe />
      </WorkspaceProvider>
    )
    act(() => screen.getByText("open").click())
    const opened = readTabs()[0]
    act(() =>
      setBrowserTabState({
        tabId: opened.id.slice("browser:".length),
        ownerWindow: "main",
        kind: "page",
        surface: "child",
        channel: "native",
        channelError: null,
        url: "https://example.com/docs/deep",
        requestedUrl: "https://example.com/docs/deep",
        title: "Deep",
        favicon: null,
        loading: false,
        canGoBack: false,
        canGoForward: false,
        origin: "https://example.com",
        zoom: 1,
        error: null,
        remoteHost: null,
        openerTabId: null,
        profile: "default",
        agentGrant: null,
      })
    )
    act(() => screen.getByText("close-active").click())
    const closed = popClosedTab()
    expect(closed).toEqual({
      kind: "browser",
      key: opened.id,
      index: 0,
      url: "https://example.com/docs/deep",
      title: "Deep",
      folderId: 1,
      profile: "default",
    })
  })

  // A browser tab shares the file strip with the file tabs, so it obeys the
  // same reopen rule: back at the slot it was closed from, not appended.
  it("puts a reopened browser tab back at the slot it was closed from", () => {
    render(
      <WorkspaceProvider>
        <BrowserProbe />
      </WorkspaceProvider>
    )
    act(() => screen.getByText("open").click())
    act(() => screen.getByText("open-bg").click())
    // Lands right after its opener, i.e. in the middle.
    act(() => screen.getByText("open-next").click())
    expect(readTabs().map((t) => t.url)).toEqual([
      "https://example.com/docs#top",
      "https://example.com/next",
      "http://localhost:3000/",
    ])

    act(() => screen.getByText("close-second").click())
    expect(readTabs().map((t) => t.url)).toEqual([
      "https://example.com/docs#top",
      "http://localhost:3000/",
    ])

    act(() => screen.getByText("reopen-closed").click())
    expect(readTabs().map((t) => t.url)).toEqual([
      "https://example.com/docs#top",
      "https://example.com/next",
      "http://localhost:3000/",
    ])
  })
})

describe("reopening a closed file tab", () => {
  beforeEach(() => {
    resetClosedTabStackForTests()
    mockedApi.readFileForEdit.mockReset()
    mockedApi.gitIsTracked.mockReset()
    mockedApi.gitIsTracked.mockResolvedValue(false)
    mockedApi.readFileForEdit.mockImplementation(
      async (_rootPath: string, ioPath: string) => ({
        path: ioPath,
        content: `${ioPath}-v1`,
        etag: `e-${ioPath}`,
        mtime_ms: 1,
        readonly: false,
        line_ending: "lf",
      })
    )
  })

  function Probe({ onCapture }: { onCapture: (ids: string[]) => void }) {
    const {
      openFilePreview,
      fileTabs,
      closeFileTab,
      closeOtherFileTabs,
      closeAllFileTabs,
    } = useWorkspaceContext()
    onCapture(fileTabs.map((tab) => tab.id))
    // What the reopen shortcut does with the entry it pops: hand the opener
    // the path AND the slot the tab was closed from.
    const restoreLast = () => {
      const closed = popClosedTab()
      if (closed?.kind !== "file") return
      void openFilePreview(closed.path, {
        folderId: closed.folderId ?? undefined,
        index: closed.index,
      })
    }
    return (
      <div>
        <button onClick={() => void openFilePreview("a.ts")}>open-a</button>
        <button onClick={() => void openFilePreview("b.ts")}>open-b</button>
        <button onClick={() => void openFilePreview("c.ts")}>open-c</button>
        <button onClick={() => void openFilePreview("d.ts")}>open-d</button>
        <button onClick={() => closeFileTab(fileTabId("/repo/b.ts"))}>
          close-b
        </button>
        <button onClick={() => closeOtherFileTabs(fileTabId("/repo/c.ts"))}>
          close-others-c
        </button>
        <button onClick={closeAllFileTabs}>close-all</button>
        <button onClick={restoreLast}>restore</button>
        <button onClick={() => void openFilePreview("b.ts", { index: 1 })}>
          reopen-b
        </button>
        <button onClick={() => void openFilePreview("b.ts", { index: 9 })}>
          reopen-b-far
        </button>
        <button onClick={() => void openFilePreview("c.ts", { index: 0 })}>
          front-c
        </button>
      </div>
    )
  }

  async function click(label: string) {
    await act(async () => {
      screen.getByText(label).click()
    })
  }

  function mount() {
    let ids: string[] = []
    render(
      <WorkspaceProvider>
        <Probe onCapture={(next) => (ids = next)} />
      </WorkspaceProvider>
    )
    return () => ids
  }

  it("puts the tab back at the slot it was closed from", async () => {
    const ids = mount()
    await click("open-a")
    await click("open-b")
    await click("open-c")
    expect(ids()).toEqual([
      fileTabId("/repo/a.ts"),
      fileTabId("/repo/b.ts"),
      fileTabId("/repo/c.ts"),
    ])

    await click("close-b")
    expect(ids()).toEqual([fileTabId("/repo/a.ts"), fileTabId("/repo/c.ts")])
    expect(peekClosedTab()).toMatchObject({
      kind: "file",
      path: "/repo/b.ts",
      index: 1,
    })

    await click("reopen-b")
    expect(ids()).toEqual([
      fileTabId("/repo/a.ts"),
      fileTabId("/repo/b.ts"),
      fileTabId("/repo/c.ts"),
    ])

    // A tab that is already open is activated where it is, never moved.
    await click("front-c")
    expect(ids()).toEqual([
      fileTabId("/repo/a.ts"),
      fileTabId("/repo/b.ts"),
      fileTabId("/repo/c.ts"),
    ])
  })

  it("clamps the slot to the strip", async () => {
    const ids = mount()
    await click("open-a")
    await click("open-b")
    await click("open-c")
    await click("close-b")

    await click("reopen-b-far")
    expect(ids()).toEqual([
      fileTabId("/repo/a.ts"),
      fileTabId("/repo/c.ts"),
      fileTabId("/repo/b.ts"),
    ])
  })

  // "Close others" records every tab against the same strip, but the stack is
  // popped newest-first — so each entry carries the slot it would have had if
  // the batch had closed one tab at a time.
  it("walks a close-others batch back into its original order", async () => {
    const ids = mount()
    await click("open-a")
    await click("open-b")
    await click("open-c")
    await click("open-d")

    await click("close-others-c")
    expect(ids()).toEqual([fileTabId("/repo/c.ts")])

    await click("restore")
    expect(ids()).toEqual([fileTabId("/repo/c.ts"), fileTabId("/repo/d.ts")])
    await click("restore")
    expect(ids()).toEqual([
      fileTabId("/repo/b.ts"),
      fileTabId("/repo/c.ts"),
      fileTabId("/repo/d.ts"),
    ])
    await click("restore")
    expect(ids()).toEqual([
      fileTabId("/repo/a.ts"),
      fileTabId("/repo/b.ts"),
      fileTabId("/repo/c.ts"),
      fileTabId("/repo/d.ts"),
    ])
  })

  it("rebuilds a closed-all strip in its original order", async () => {
    const ids = mount()
    await click("open-a")
    await click("open-b")
    await click("open-c")

    await click("close-all")
    expect(ids()).toEqual([])

    await click("restore")
    await click("restore")
    await click("restore")
    expect(ids()).toEqual([
      fileTabId("/repo/a.ts"),
      fileTabId("/repo/b.ts"),
      fileTabId("/repo/c.ts"),
    ])
  })
})
