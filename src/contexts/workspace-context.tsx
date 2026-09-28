"use client"

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react"
import { useTranslations } from "next-intl"
import { useActiveFolder } from "@/contexts/active-folder-context"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"
import { browserTabBackendId, buildFileTabId } from "@/lib/file-tab-id"
import {
  gitDiff,
  gitDiffWithBranch,
  gitIsTracked,
  gitShowDiff,
  gitShowFile,
  listDirectoryWithFiles,
  readFileBase64,
  readFileForEdit,
  readFilePreview,
  saveFileContent,
  saveFileCopy,
} from "@/lib/api"
import type { FileEditContent } from "@/lib/types"
import {
  expandHomePath,
  findOwningFolder,
  isHomeRelativePath,
  joinRootRel,
  normalizeAbsPath,
  splitAbsPath,
} from "@/lib/file-open-target"
import { isAbsoluteFilePath } from "@/lib/file-path-display"
import {
  batchCloseSlots,
  pushClosedTab,
  snapshotBrowserTab,
  snapshotFileTab,
} from "@/lib/closed-tab-stack"
import {
  isBinaryImageFile,
  isHiddenPath,
  isHtmlPreviewable,
  isImageFile,
  isOfficeOwnerFile,
  isOfficePreviewable,
  languageFromPath,
} from "@/lib/language-detect"
import {
  loadImageDiffSides,
  type ImageDiffSides,
  type ImageDiffSource,
} from "@/lib/image-diff"
import { toErrorMessage } from "@/lib/app-error"
import {
  HIDDEN_TAB_CONTENT_BUDGET_CHARS,
  selectTabsToUnload,
} from "@/lib/file-tab-memory"
import { useWorkspaceStateStore } from "@/hooks/use-workspace-state-store"
import {
  useOpenFileTabsWatch,
  type WorkspaceExternalConflict,
} from "@/hooks/use-open-file-tabs-watch"
import { useOfficeAutoPreview } from "@/lib/office-preview-prefs"
import {
  browserTabHiddenAt,
  getBrowserTabState,
  hasSurfaceClaim,
  releaseBrowserTab,
} from "@/lib/browser/browser-tab-store"
import {
  BLANK_PAGE_URL,
  displayHostPort,
  normalizeUrlForDedupe,
} from "@/lib/browser/browser-url"
import {
  DEFAULT_BROWSER_PROFILE_ID,
  browserProfileExists,
  getBrowserPrefs,
  subscribeBrowserPrefs,
} from "@/lib/browser/browser-prefs"
import {
  isRemoteHostAddress,
  remoteConnectionOfProfile,
} from "@/lib/browser/remote-host"
import { randomUUID } from "@/lib/utils"

export type WorkspaceMode = "conversation" | "fusion"

/** The closed-stack entry for a browser tab: the page it was showing, read
 *  from the live state while that still exists (it is released right after).
 *  `index` is the strip slot to reopen into — for a batch close, the slot
 *  `batchCloseSlots` assigned, not the position in the pre-close strip. */
function closedBrowserTab(tab: BrowserWorkspaceTab, index: number) {
  const state = getBrowserTabState(tab.id)
  return snapshotBrowserTab(
    tab,
    state?.url || state?.requestedUrl || tab.browser.initialUrl,
    state?.title || tab.title,
    index
  )
}

export type WorkspacePane = "conversation" | "files"

type FileLikeTabKind = "file" | "diff" | "rich-diff"
type FileWorkspaceTabKind = FileLikeTabKind | "browser"
type FileSaveState = "idle" | "saving" | "error"
type LineEnding = "lf" | "crlf" | "mixed" | "none"

/** Seed of a built-in browser tab. Live state (url, title, loading, history)
 *  lives in `lib/browser/browser-tab-store`, keyed by the tab id, so page
 *  activity never churns the `fileTabs` slice. */
export interface BrowserTabSeed {
  /** The URL the tab was opened with; the surface navigates to it once. */
  initialUrl: string
  /** Set on a tab adopted from another tab's `window.open` (popup). */
  openerTabId: string | null
  /** The browser profile the tab lives in (its cookie jar and storage).
   *  Fixed for the tab's life: the surface is built in it. */
  profile: string
  /** The address lives on the codeg host this window is bound to — a
   *  loopback or private address seen from a remote-workspace window. Such a
   *  tab never loads in a profile of this computer: there it would reach this
   *  machine's `localhost`, not the one the address was printed on. Absent on
   *  every other tab. */
  remote?: true
}

interface FileWorkspaceTabBase {
  id: string
  // Repo context for git-scoped diff tabs (working/branch/commit/session
  // diffs are repository operations and need the repo root). Plain file
  // tabs are folder-free: folderId is ALWAYS null and `path` holds the
  // file's absolute normalized path — reads/writes derive (dirname,
  // basename), and folder association (watching, git gutter, preview
  // roots) is derived from the path on demand, never stored.
  folderId: number | null
  title: string
  description: string | null
  path: string | null
  language: string
  content: string
  loading: boolean
  originalContent?: string
  modifiedContent?: string
  gitBaseContent?: string
  savedContent?: string
  /** Both sides of an image diff, on a `rich-diff` tab whose file is a binary
   *  image. Set INSTEAD of originalContent/modifiedContent, which are
   *  text-shaped; `language === "image"` is what tells the panel which of the
   *  two the tab carries. */
  imageDiff?: ImageDiffSides
  isDirty?: boolean
  etag?: string | null
  mtimeMs?: number | null
  readonly?: boolean
  lineEnding?: LineEnding
  saveState?: FileSaveState
  saveError?: string | null
  // True iff an external change to this tab's path was observed by the
  // workspace watcher while the tab was inactive or otherwise not yet
  // resolved against disk. Cleared by any successful content reload.
  stale?: boolean
}

/** A file, a unified diff, or a rich (side-by-side) diff. */
export interface FileLikeWorkspaceTab extends FileWorkspaceTabBase {
  kind: FileLikeTabKind
  browser?: never
}

/** A built-in browser tab: no path, no editable content. */
export interface BrowserWorkspaceTab extends FileWorkspaceTabBase {
  kind: "browser"
  path: null
  language: "browser"
  browser: BrowserTabSeed
}

// A discriminated union rather than optional fields on one shape: a `file`
// tab can never carry browser state and a `browser` tab can never be dirty,
// and the compiler should say so at every switch on `kind`.
export type FileWorkspaceTab = FileLikeWorkspaceTab | BrowserWorkspaceTab

// The provider value is split across three contexts so high-frequency
// fileTabs churn (per-keystroke content updates, watcher-driven reloads)
// only re-renders components that actually read tab data. Action-only
// consumers on the conversation render path (message nav, artifacts,
// links, search) subscribe to WorkspaceActionsContext, whose value is
// stable for the provider's lifetime; layout chrome subscribes to
// WorkspaceViewContext, which only changes on mode/pane/maximize flips.
interface WorkspaceActionsValue {
  setActivePane: (pane: WorkspacePane) => void
  activateConversationPane: () => void
  activateFilePane: () => void
  switchFileTab: (tabId: string) => void
  closeFileTab: (tabId: string) => void
  closeOtherFileTabs: (tabId: string) => void
  closeAllFileTabs: () => void
  reorderFileTabs: (tabs: FileWorkspaceTab[]) => void
  // Open a file tab. Accepts absolute paths, `~/` paths (expanded via the
  // backend home dir), and paths relative to a folder root. `folderId` is
  // ONLY a resolution base for relative paths (defaults to the active
  // folder); once the path is absolute it plays no further role — the tab
  // is identified by the absolute path alone.
  //
  // Resolves with that absolute normalized path — i.e. the tab's identity —
  // or null when the input could not be resolved (a bare relative path with
  // no folder to resolve against). Callers that only want the side effect
  // ignore it; a caller that must then FIND the tab (the file viewer drawer)
  // has no other way to reproduce this resolution.
  //
  // `background` opens the tab WITHOUT bringing the files pane forward or
  // moving its selection (it still claims the selection when nothing holds
  // it). For openers that render the tab themselves and would otherwise
  // rearrange a workspace the user is not looking at — the canvas's file
  // cards, which re-open every tab on the board each time the route mounts.
  //
  // `index` is the strip slot for a tab that is not open yet, clamped to the
  // strip; omitted = append. Reopening a closed tab passes the slot it was
  // closed from. A tab that is already open is activated where it is.
  openFilePreview: (
    path: string,
    options?: {
      line?: number
      reload?: boolean
      folderId?: number
      background?: boolean
      index?: number
    }
  ) => Promise<string | null>
  // Refetch the open tab matching the absolute `path` without changing
  // activeFileTabId. No-op when no tab matches or when the tab has unsaved
  // local edits (use markTabsStale for that case).
  reloadOpenFileBackground: (path: string) => Promise<void>
  // Write prefetched file content into the open tab matching the absolute
  // `path` without issuing a second readFileForEdit. Used by the
  // change-detection watcher whose resolver has already paid for the read —
  // avoids the I/O double when many tabs are affected by a single workspace
  // event. Skips dirty tabs and tabs that aren't open.
  applyExternalReload: (path: string, fetched: FileEditContent) => Promise<void>
  // Flip stale=true on the tab matching the absolute `path`. Activating a
  // stale tab forces a refetch (clean) or triggers conflict resolution
  // (dirty).
  markTabsStale: (path: string) => void
  // Mark a clean open tab as load-failed, replacing its body with the
  // supplied error message and routing it into the editor's error state.
  // No-op when no tab matches OR when the tab is dirty — unsaved edits
  // must never be silently clobbered. Used by the watcher when a workspace
  // event reports a path whose disk read fails (external delete, locked,
  // permission revoked, …), so the user is never shown a stale buffer that
  // no longer corresponds to disk.
  rejectFileTab: (path: string, errorMessage: string) => void
  consumePendingFileReveal: (requestId: number) => void
  openWorkingTreeDiff: (
    path?: string,
    options?: {
      mode?: "auto" | "unified" | "overview"
      folderId?: number
    }
  ) => Promise<void>
  openBranchDiff: (
    branch: string,
    path?: string,
    options?: { mode?: "default" | "overview"; folderId?: number }
  ) => Promise<void>
  openCommitDiff: (
    commit: string,
    path?: string,
    message?: string,
    options?: { folderId?: number }
  ) => Promise<void>
  openSessionFileDiff: (
    filePath: string,
    diffContent: string,
    groupLabel: string,
    options?: { folderId?: number }
  ) => void
  openExternalConflictDiff: (
    filePath: string,
    diskContent: string,
    unsavedContent: string
  ) => void
  updateActiveFileContent: (content: string) => void
  updateFileTabContent: (tabId: string, content: string) => void
  saveActiveFile: (options?: { force?: boolean }) => Promise<boolean>
  setFileTabComposing: (tabId: string, composing: boolean) => void
  reloadActiveFile: () => Promise<void>
  toggleFileTabPreview: (tabId: string) => void
  toggleFilesMaximized: () => void
  // Open (or re-activate) a built-in browser tab for an http(s) URL. One tab
  // per URL (fragment ignored): a second open activates the existing tab.
  // Returns the tab id, or null when the URL does not parse. The native
  // surface is created by the tab's view when it mounts, not here.
  // `openerTabId` (a workspace tab id) places the new tab right after that
  // tab, the way a ⌘/Ctrl-click lands next to the page it came from.
  // `index` is the strip slot for a tab that is not open yet, clamped to the
  // strip; omitted = append, and an `openerTabId` wins over it. Reopening a
  // closed tab passes the slot it was closed from. A tab already on this URL
  // in the same profile is activated where it is — except for the blank page
  // (`BLANK_PAGE_URL`), which always opens a fresh empty tab. `profile`
  // defaults to the opener's, else to the preference for new tabs.
  // `activate`: `true`/omitted shows the tab and brings the files pane
  // forward; `"tab"` selects it in the strip but leaves the pane where it is
  // (for an opener that is not the file column — a local server coming up —
  // which should show its page without pulling anyone out of a conversation);
  // `false` leaves the selection alone, claiming it only when nothing holds
  // it, so the strip never carries a tab with an empty column beside it.
  //
  // `remote` opens the address as one on the remote codeg host (see
  // `BrowserTabSeed.remote`); a tab opened from a remote tab is remote too.
  openBrowserTab: (
    url: string,
    options?: {
      folderId?: number
      activate?: boolean | "tab"
      openerTabId?: string
      index?: number
      profile?: string
      remote?: boolean
    }
  ) => string | null
  // Register a tab for a webview the BACKEND already created — a popup the
  // page opened that the host adopted. `backendTabId` is the backend's id
  // (`<opener>-p<n>`); the record is inserted right after its opener.
  adoptBrowserTab: (params: {
    backendTabId: string
    url: string
    openerBackendTabId: string
    /** The profile the backend built the popup in; null = unknown. */
    profile?: string | null
  }) => string
  // Bring back browser tabs saved by a previous run, as records only: none
  // is activated, and a native surface is created for one when it is first
  // shown. Entries are appended in order; nothing happens when the workspace
  // already has browser tabs (a second document of the same run).
  restoreBrowserTabs: (entries: RestorableBrowserTab[]) => void
  // Release a background tab's native surface (memory) while keeping its
  // record: the record moves to the page the tab was showing, so the next
  // time it is shown a fresh surface loads that page. No-op for a tab that
  // has no surface. Returns whether a surface was released.
  suspendBrowserTab: (tabId: string) => boolean
}

/** What a browser tab needs to come back after a restart (see
 *  `lib/browser/browser-tab-persistence`). */
export interface RestorableBrowserTab {
  url: string
  title: string | null
  folderId: number | null
  /** A profile that exists (the restorer maps deleted ones to the default). */
  profile: string
  /** See `BrowserTabSeed.remote`. */
  remote?: boolean
}

interface WorkspaceViewValue {
  mode: WorkspaceMode
  activePane: WorkspacePane
  filesMaximized: boolean
}

interface WorkspaceFileTabsValue {
  fileTabs: FileWorkspaceTab[]
  activeFileTabId: string | null
  activeFileTab: FileWorkspaceTab | null
  activeFilePath: string | null
  previewFileTabIds: Set<string>
  pendingFileReveal: {
    requestId: number
    // Absolute normalized path — compared against the active tab's path.
    path: string
    line: number
  } | null
}

type WorkspaceContextValue = WorkspaceActionsValue &
  WorkspaceViewValue &
  WorkspaceFileTabsValue

// External disk-vs-buffer conflicts, isolated from the high-frequency
// fileTabs slice so the always-mounted conflict dialog costs nothing while
// idle. Conflicts queue FIFO (multi-folder divergences can land together);
// the head is surfaced one at a time.
interface WorkspaceExternalConflictValue {
  // Head of the conflict queue, or null when there is nothing to resolve.
  externalConflict: WorkspaceExternalConflict | null
  // "Compare": open a disk-vs-unsaved rich diff tab (uses the LATEST
  // buffer content when the tab is still open) and dequeue.
  compareExternalConflict: () => void
  // "Reload": discard the buffer and refetch from disk; clears the shown
  // signature so a subsequent identical divergence prompts again.
  reloadExternalConflict: () => void
  // "Save as copy": write the unsaved buffer next to the original.
  // Resolves with the saved path (dequeues) or throws on failure (the
  // conflict stays queued so the user can retry).
  saveExternalConflictCopy: () => Promise<string>
  // Close the dialog without resolving; the signature stays recorded so
  // the same divergence does not immediately re-prompt.
  dismissExternalConflict: () => void
}

const WorkspaceActionsContext = createContext<WorkspaceActionsValue | null>(
  null
)
const WorkspaceViewContext = createContext<WorkspaceViewValue | null>(null)
const WorkspaceFileTabsContext = createContext<WorkspaceFileTabsValue | null>(
  null
)
const WorkspaceExternalConflictContext =
  createContext<WorkspaceExternalConflictValue | null>(null)

// Queue/dedup key for one file's divergence — the absolute normalized
// path IS the identity, matching the tab id model.
function conflictKey(path: string): string {
  return normalizeAbsPath(path)
}

// One-shot save-echo records: our own saveFileContent writes come back as
// watcher change events; suppress exactly one event per save (etag match,
// clean tab, short TTL) so an autosave before a tab switch doesn't flag
// the tab stale and force a pointless reload on switch-back.
const SELF_WRITE_ECHO_TTL_MS = 5_000

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/")
}

// Most callers pass an already-normalized path, but the working-diff overview
// titles the tab after the FOLDER path, which is native — on Windows a
// "/"-only split handed back `C:\work\repo` as the file name.
function fileName(path: string): string {
  const index = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"))
  return (index >= 0 ? path.slice(index + 1) : path) || path
}

function isDirtyFileTab(tab: FileWorkspaceTab): boolean {
  return tab.kind === "file" && Boolean(tab.isDirty)
}

// Share one string instance when the git base equals the working copy —
// the common case for files without uncommitted changes. Halves the
// retained text per clean tracked file.
function dedupeGitBase(
  content: string,
  gitBaseContent: string | undefined
): string | undefined {
  return gitBaseContent === content ? content : gitBaseContent
}

// Re-exported for existing consumers; the implementation lives in
// lib/language-detect so the tab watcher can use it without a runtime
// import cycle back into this module.
export { isImageFile } from "@/lib/language-detect"

const IMAGE_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  svg: "image/svg+xml",
  webp: "image/webp",
  bmp: "image/bmp",
  ico: "image/x-icon",
}

function loadingTab(
  id: string,
  folderId: number | null,
  kind: FileLikeTabKind,
  title: string,
  description: string | null,
  path: string | null,
  language: string
): FileWorkspaceTab {
  return {
    id,
    kind,
    folderId,
    title,
    description,
    path,
    language,
    content: "",
    loading: true,
    savedContent: "",
    isDirty: false,
    etag: null,
    mtimeMs: null,
    readonly: kind !== "file",
    lineEnding: "none",
    saveState: "idle",
    saveError: null,
  }
}

type LoadDecision = { kind: "skip" } | { kind: "fetch"; gen: number }

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  timeoutMessage: string
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(timeoutMessage))
    }, timeoutMs)
  })

  try {
    return await Promise.race([promise, timeoutPromise])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

interface WorkspaceProviderProps {
  children: ReactNode
}

export function WorkspaceProvider({ children }: WorkspaceProviderProps) {
  const t = useTranslations("Folder.workspaceContext")
  const { activeFolder } = useActiveFolder()
  // Reactive: `useOpenFileTabsWatch` re-derives its per-root FS subscriptions
  // when the registered-folder set changes. Low-frequency (open/close folder).
  const allFolders = useAppWorkspaceStore((s) => s.allFolders)
  const folderPath = activeFolder?.path
  const [activePane, setActivePaneState] =
    useState<WorkspacePane>("conversation")
  const [fileTabs, setFileTabs] = useState<FileWorkspaceTab[]>([])
  const [activeFileTabId, setActiveFileTabId] = useState<string | null>(null)
  const [pendingFileReveal, setPendingFileReveal] = useState<{
    requestId: number
    path: string
    line: number
  } | null>(null)
  const [previewFileTabIds, setPreviewFileTabIds] = useState<Set<string>>(
    new Set()
  )
  const [filesMaximized, setFilesMaximized] = useState(false)
  // FIFO queue of unresolved disk-vs-buffer divergences (head is shown by
  // the always-mounted conflict dialog). Isolated state: never flows into
  // the fileTabs slice, so idle cost is zero.
  const [externalConflictQueue, setExternalConflictQueue] = useState<
    WorkspaceExternalConflict[]
  >([])
  const externalConflictQueueRef = useRef<WorkspaceExternalConflict[]>([])
  // key(folderId,path) -> last announced signature. Suppresses re-prompt
  // flicker when repeated events report the same divergence.
  const conflictSignatureByKeyRef = useRef<Map<string, string>>(new Map())
  // key(folderId,path) -> etag of our own most recent save (one-shot).
  const selfWriteEchoRef = useRef<Map<string, { etag: string; at: number }>>(
    new Map()
  )
  const fileTabsRef = useRef<FileWorkspaceTab[]>([])
  // Keep dismissals across folder changes and effect re-subscriptions. A
  // watcher event must not reopen a preview the user already closed.
  const autoOpenedOfficePathsRef = useRef(new Set<string>())
  // Latest-state mirrors for the stable action callbacks. Actions live in a
  // context value that must NOT change identity when tabs/folder change, so
  // they read these refs instead of capturing render-scoped state. The refs
  // are synced in effects (post-commit), giving the same staleness window a
  // recreated closure would have had — never fresher, never older.
  const activeFileTabIdRef = useRef<string | null>(null)
  const activeFolderRef = useRef<{ id: number; path: string } | null>(null)
  const fileRevealRequestIdRef = useRef(0)
  // tabId -> generation of its current in-flight fetch. Serves two roles:
  //   (a) Dedup: `has(tabId)` collapses rapid re-clicks within one event
  //       loop turn (where fileTabsRef.current is still pre-render-stale).
  //   (b) Staleness check: each fetch captures the generation it was
  //       started with and only commits state on resolve if it still
  //       matches — preventing an orphaned fetch (after close+reopen, or
  //       a superseding refresh) from clobbering the tab.
  const inFlightLoadsRef = useRef<Map<string, number>>(new Map())
  const nextLoadGenRef = useRef(0)
  // Most-recently-active tab ids, most recent first. Drives the memory
  // guardrail's least-recently-active eviction order.
  const tabRecencyRef = useRef<string[]>([])
  const composingFileTabIdsRef = useRef<Set<string>>(new Set())
  const deferredSaveTabsRef = useRef<Map<string, { force?: boolean }>>(
    new Map()
  )
  const saveFileTabRef = useRef<
    ((tabId: string, options?: { force?: boolean }) => Promise<boolean>) | null
  >(null)

  useEffect(() => {
    fileTabsRef.current = fileTabs
  }, [fileTabs])

  useEffect(() => {
    activeFileTabIdRef.current = activeFileTabId
  }, [activeFileTabId])

  useEffect(() => {
    activeFolderRef.current = activeFolder
      ? { id: activeFolder.id, path: activeFolder.path }
      : null
  }, [activeFolder])

  useEffect(() => {
    externalConflictQueueRef.current = externalConflictQueue
  }, [externalConflictQueue])

  const recordSelfWriteEcho = useCallback(
    (path: string, etag: string | null | undefined) => {
      if (!etag) return
      selfWriteEchoRef.current.set(conflictKey(path), {
        etag,
        at: Date.now(),
      })
    },
    []
  )

  // One-shot: a hit consumes the record, so only the single event burst
  // produced by our own write is suppressed — any later change for the
  // same path marks stale normally. The tab-etag equality check is done
  // by the caller being a CLEAN tab whose etag was set by that same save.
  const consumeSelfWriteEcho = useCallback((path: string): boolean => {
    const key = conflictKey(path)
    const record = selfWriteEchoRef.current.get(key)
    if (!record) return false
    selfWriteEchoRef.current.delete(key)
    if (Date.now() - record.at > SELF_WRITE_ECHO_TTL_MS) return false
    const tabId = buildFileTabId({ kind: "file", path: key })
    const tab = fileTabsRef.current.find((t) => t.id === tabId)
    return Boolean(
      tab && tab.kind === "file" && !tab.isDirty && tab.etag === record.etag
    )
  }, [])

  // Resolve the folder an opener should target: an explicitly requested
  // folder wins; otherwise the active folder. Returns null when neither
  // resolves (no folder open, or the requested folder was removed).
  const resolveTargetFolder = useCallback(
    (explicitFolderId?: number): { id: number; path: string } | null => {
      if (explicitFolderId != null) {
        const folder = useAppWorkspaceStore
          .getState()
          .getFolder(explicitFolderId)
        return folder ? { id: folder.id, path: folder.path } : null
      }
      return activeFolderRef.current
    },
    []
  )

  // Resolve an opener input into the canonical absolute path that is the
  // tab's identity. Absolute and `~/` inputs need no folder at all;
  // relative inputs are joined onto `folderId` (or the active folder) —
  // that is the ONLY role a folder plays in opening a file.
  const resolveOpenAbsolutePath = useCallback(
    async (rawPath: string, baseFolderId?: number): Promise<string | null> => {
      const input = isHomeRelativePath(rawPath)
        ? await expandHomePath(rawPath)
        : rawPath
      if (isAbsoluteFilePath(input)) {
        const abs = normalizeAbsPath(input)
        // Re-root through the owning registered folder when there is one:
        // on case-insensitive filesystems an agent may echo the root with
        // different casing (c:/repo vs C:/Repo), and watch events join the
        // FOLDER's stored casing — canonicalizing here collapses those
        // aliases into the one identity the watcher reproduces.
        const owning = findOwningFolder(
          abs,
          useAppWorkspaceStore.getState().allFolders
        )
        return owning ? joinRootRel(owning.rootPath, owning.relPath) : abs
      }
      const base = resolveTargetFolder(baseFolderId)
      if (!base) return null
      return joinRootRel(base.path, normalizePath(input))
    },
    [resolveTargetFolder]
  )

  // Git gutter base for the file at absPath, derived from its owning
  // registered folder at fetch time. Files outside every registered folder
  // get no git context — the parent directory may sit inside some unrelated
  // repo (a dotfiles repo in $HOME), and spawning git there would paint
  // misleading gutters.
  const fetchGitBase = useCallback(
    async (absPath: string): Promise<string | undefined> => {
      const owning = findOwningFolder(
        absPath,
        useAppWorkspaceStore.getState().allFolders
      )
      if (!owning) return undefined
      const tracked = await gitIsTracked(owning.rootPath, owning.relPath).catch(
        () => false
      )
      if (!tracked) return undefined
      return gitShowFile(owning.rootPath, owning.relPath).catch(() => "")
    },
    []
  )

  const mode: WorkspaceMode = fileTabs.length > 0 ? "fusion" : "conversation"
  const effectiveFilesMaximized = mode === "fusion" && filesMaximized

  // Reset maximize state once the file workspace is empty so reopening a file
  // later starts from the normal split instead of a stale maximized layout.
  useEffect(() => {
    if (fileTabs.length === 0 && filesMaximized) {
      /* eslint-disable react-hooks/set-state-in-effect */
      setFilesMaximized(false)
      /* eslint-enable react-hooks/set-state-in-effect */
    }
  }, [fileTabs.length, filesMaximized])

  const toggleFilesMaximized = useCallback(() => {
    setFilesMaximized((prev) => !prev)
  }, [])

  const setActivePane = useCallback((nextPane: WorkspacePane) => {
    setActivePaneState((prev) => (prev === nextPane ? prev : nextPane))
  }, [])

  const activateConversationPane = useCallback(() => {
    setActivePaneState((prev) =>
      prev === "conversation" ? prev : "conversation"
    )
    // Releasing the files overlay so a session opened from the sidebar (or any
    // other path that activates the conversation pane) becomes visible instead
    // of staying hidden behind a maximized files pane.
    setFilesMaximized(false)
  }, [])

  const activateFilePane = useCallback(() => {
    setActivePaneState((prev) => (prev === "files" ? prev : "files"))
  }, [])

  // NOTE: there is deliberately NO folder-removal cleanup for file tabs.
  // A file tab is identified by its absolute path — removing a workspace
  // folder does not delete the files, so its tabs stay open and simply
  // degrade to unwatched (activation-time freshness + save pre-verify).
  // Git-scoped diff tabs keep their folderId but are snapshots; a gone
  // folder surfaces as a load error on the next refresh, not a wipe.

  // Pure activation — no content mutation.
  //
  // `background` is for openers that are not the file column and must not
  // steal it: a canvas file card opens the tab it renders FROM, so bringing
  // the (covered) files pane forward and re-pointing its selection every time
  // the board mounts would rearrange a workspace the user isn't even looking
  // at. It still claims the selection when nothing holds it, so "tabs exist
  // but none is active" never becomes reachable.
  const activateTab = useCallback(
    (tabId: string, background = false) => {
      if (background) {
        setActiveFileTabId((prev) => prev ?? tabId)
        return
      }
      setActiveFileTabId(tabId)
      activateFilePane()
    },
    [activateFilePane]
  )

  // Insert a freshly created (loading, empty) tab at `index` (clamped), or at
  // the end. Caller has verified no tab with this id exists. If a race
  // introduced one, leave it alone.
  const seedLoadingTab = useCallback(
    (nextTab: FileWorkspaceTab, background = false, index?: number) => {
      setFileTabs((prev) => {
        if (prev.some((tab) => tab.id === nextTab.id)) return prev
        const at =
          index == null
            ? prev.length
            : Math.max(0, Math.min(index, prev.length))
        return [...prev.slice(0, at), nextTab, ...prev.slice(at)]
      })
      if (background) {
        setActiveFileTabId((prev) => prev ?? nextTab.id)
      } else {
        setActiveFileTabId(nextTab.id)
        activateFilePane()
      }
      // Open HTML/Markdown file tabs in the rendered preview by default rather
      // than the source editor. Only runs on first seed: reloads go through
      // markTabRefreshing (never here), so if the user later switches to the
      // source view it survives an external change. Restricted to real file
      // tabs — diffs never enter preview, and .vue/.svelte (language "html"
      // but not isHtmlPreviewable) stay on source.
      if (
        nextTab.kind === "file" &&
        (nextTab.language === "markdown" || isHtmlPreviewable(nextTab.path))
      ) {
        setPreviewFileTabIds((prev) => {
          if (prev.has(nextTab.id)) return prev
          const next = new Set(prev)
          next.add(nextTab.id)
          return next
        })
      }
    },
    [activateFilePane]
  )

  const browserTabRecord = useCallback(
    (
      backendTabId: string,
      url: string,
      folderId: number | null,
      openerTabId: string | null,
      profile: string,
      title?: string | null,
      remote?: boolean
    ): BrowserWorkspaceTab => ({
      id: buildFileTabId({ kind: "browser", id: backendTabId }),
      kind: "browser",
      folderId,
      // Host AND port, not just the host: two local servers are two tabs both
      // called "localhost" otherwise, which is now a routine sight — a tab
      // opened in the background (an auto-opened local server, a ⌘-click)
      // keeps this name until someone switches to it and the page says its
      // own. For an ordinary address with no explicit port this is the host,
      // exactly as before.
      title: title || (displayHostPort(url) ?? url),
      description: null,
      path: null,
      language: "browser",
      content: "",
      loading: true,
      readonly: true,
      browser: {
        initialUrl: url,
        openerTabId,
        profile,
        ...(remote ? { remote: true as const } : {}),
      },
    }),
    []
  )

  const openBrowserTab = useCallback(
    (
      url: string,
      options?: {
        folderId?: number
        activate?: boolean | "tab"
        openerTabId?: string
        index?: number
        profile?: string
        remote?: boolean
      }
    ) => {
      const normalized = normalizeUrlForDedupe(url)
      if (!normalized) return null
      const activate = options?.activate ?? true
      const opener = options?.openerTabId
        ? fileTabsRef.current.find((tab) => tab.id === options.openerTabId)
        : undefined
      // A caller that says settles it — "open it on this computer" is a
      // person's decision. Otherwise a tab opened from a remote tab is
      // remote, and so is any address of the remote host however it came to
      // be opened (a page's ⌘-click, a refused pop-up opened anyway): in a
      // profile of this computer it would reach this machine instead.
      const remote =
        options?.remote ??
        ((opener?.kind === "browser" && opener.browser.remote === true) ||
          // A request from a page of a connection's profile (a ⌘-click):
          // its opener's, even when the opener's record is already gone.
          remoteConnectionOfProfile(options?.profile) !== null ||
          isRemoteHostAddress(url))
      // A tab opened from another tab (⌘-click, a popup) belongs with it:
      // same cookies, same signed-in state. Otherwise the preference. A
      // profile that no longer exists (a reopened tab of a deleted one, a
      // stale record) is not recreated on the backend: default instead. A
      // remote address is not in any profile of this computer, so it takes
      // no part in the choice.
      const prefs = getBrowserPrefs()
      const wanted =
        options?.profile ??
        (opener?.kind === "browser" ? opener.browser.profile : undefined) ??
        prefs.newTabProfile
      const profile =
        !remote && browserProfileExists(prefs, wanted)
          ? wanted
          : DEFAULT_BROWSER_PROFILE_ID
      // One tab per page AND profile: the same page in two profiles is two
      // different sessions, and both are worth a tab. A remote tab is its own
      // kind of session: never the same tab as a local one on that address.
      //
      // The blank page is exempt: it is an empty tab, not a page, so two of
      // them are two tabs. Dedupe would also misfire once one is used — a
      // record keeps the URL it was OPENED with, so a blank tab the user has
      // since navigated somewhere would be handed back (and its page brought
      // to the front) in place of the new empty tab they just asked for.
      const existing =
        normalized === BLANK_PAGE_URL
          ? undefined
          : fileTabsRef.current.find(
              (tab) =>
                tab.kind === "browser" &&
                tab.browser.profile === profile &&
                (tab.browser.remote === true) === remote &&
                normalizeUrlForDedupe(tab.browser.initialUrl) === normalized
            )
      if (existing) {
        if (activate === "tab") setActiveFileTabId(existing.id)
        else activateTab(existing.id, activate === false)
        return existing.id
      }
      const record = browserTabRecord(
        randomUUID(),
        url,
        options?.folderId ??
          opener?.folderId ??
          activeFolderRef.current?.id ??
          null,
        opener?.id ?? null,
        profile,
        null,
        remote
      )
      const insert = (prev: FileWorkspaceTab[]) => {
        if (prev.some((tab) => tab.id === record.id)) return prev
        const idx = opener ? prev.findIndex((tab) => tab.id === opener.id) : -1
        const at =
          idx >= 0
            ? idx + 1
            : options?.index == null
              ? prev.length
              : Math.max(0, Math.min(options.index, prev.length))
        const next = [...prev]
        next.splice(at, 0, record)
        return next
      }
      if (activate === false) {
        setFileTabs(insert)
        // Claim the selection only when nothing holds it, exactly as
        // `activateTab`'s background mode does: a strip that holds tabs while
        // the column beside it shows "open a file from the right panel" is a
        // state the user can only get out of by clicking a tab.
        setActiveFileTabId((prev) => prev ?? record.id)
      } else if (activate === "tab") {
        // Shown, but the pane stays put — the page loads and is there to look
        // at without the workspace jumping out of whatever it was on.
        setFileTabs(insert)
        setActiveFileTabId(record.id)
      } else if (opener) {
        setFileTabs(insert)
        setActiveFileTabId(record.id)
        activateFilePane()
      } else {
        seedLoadingTab(record, false, options?.index)
      }
      return record.id
    },
    [activateFilePane, activateTab, browserTabRecord, seedLoadingTab]
  )

  const adoptBrowserTab = useCallback(
    (params: {
      backendTabId: string
      url: string
      openerBackendTabId: string
      /** The profile the backend built the popup in (its opener's). */
      profile?: string | null
    }) => {
      const openerId = buildFileTabId({
        kind: "browser",
        id: params.openerBackendTabId,
      })
      const opener = fileTabsRef.current.find((tab) => tab.id === openerId)
      // A popup shares its opener's data store on the backend whatever is
      // said here; the record says the same so the toolbar shows it. The
      // backend's word comes first — the opener record may be gone by now.
      const record = browserTabRecord(
        params.backendTabId,
        params.url,
        opener?.folderId ?? activeFolderRef.current?.id ?? null,
        openerId,
        params.profile ??
          (opener?.kind === "browser"
            ? opener.browser.profile
            : getBrowserPrefs().newTabProfile),
        null,
        // A popup lives where its opener's traffic goes — which the profile
        // the backend built it in says too, when the opener's record is gone.
        (opener?.kind === "browser" && opener.browser.remote === true) ||
          remoteConnectionOfProfile(params.profile) !== null
      )
      setFileTabs((prev) => {
        if (prev.some((tab) => tab.id === record.id)) return prev
        const idx = prev.findIndex((tab) => tab.id === openerId)
        if (idx < 0) return [...prev, record]
        const next = [...prev]
        next.splice(idx + 1, 0, record)
        return next
      })
      // A popup is what the user just clicked for: show it, like a browser
      // would, and the opener stays one tab to the left.
      setActiveFileTabId(record.id)
      activateFilePane()
      return record.id
    },
    [activateFilePane, browserTabRecord]
  )

  const restoreBrowserTabs = useCallback(
    (entries: RestorableBrowserTab[]) => {
      if (entries.length === 0) return
      setFileTabs((prev) => {
        // Merge, never replace: a tab opened before the restore ran (a deep
        // link, an agent request — the capability probe is a round trip) must
        // not cost the user the whole stored set. Same one-tab-per-URL rule
        // as `openBrowserTab`, so a page already open is not duplicated.
        const open = new Set(
          prev.flatMap((tab) =>
            tab.kind === "browser"
              ? [
                  `${tab.browser.remote === true ? "remote" : tab.browser.profile} ${normalizeUrlForDedupe(tab.browser.initialUrl) ?? ""}`,
                ]
              : []
          )
        )
        const records: FileWorkspaceTab[] = []
        const prefs = getBrowserPrefs()
        for (const entry of entries) {
          const normalized = normalizeUrlForDedupe(entry.url)
          if (!normalized) continue
          // An address of the remote host comes back as a remote tab even
          // if its record did not say so (a page that walked there on its
          // own): never as a page of this computer.
          const remote = entry.remote === true || isRemoteHostAddress(entry.url)
          const profile =
            !remote && browserProfileExists(prefs, entry.profile)
              ? entry.profile
              : DEFAULT_BROWSER_PROFILE_ID
          const key = `${remote ? "remote" : profile} ${normalized}`
          if (open.has(key)) continue
          open.add(key)
          records.push(
            browserTabRecord(
              randomUUID(),
              entry.url,
              entry.folderId,
              null,
              profile,
              entry.title,
              remote
            )
          )
        }
        // Records only; not activated, so no surface is created until the
        // user switches to one. The pane state is left exactly as it was.
        return records.length === 0 ? prev : [...prev, ...records]
      })
    },
    [browserTabRecord]
  )

  // A deleted profile has no store any more. Its loaded tabs are closed by
  // the backend as part of the deletion (their records go with the
  // `browser://closed` event, and until then they still name the store their
  // surface lives in); the records that are NOT loaded (restored, suspended)
  // would recreate the store the moment they are shown, so they move to the
  // default profile as soon as the preference says the profile is gone — or
  // go, if the default profile already has a tab on that page (one tab per
  // page and profile).
  useEffect(
    () =>
      subscribeBrowserPrefs(() => {
        const prefs = getBrowserPrefs()
        setFileTabs((prev) => {
          // Dormant = no live state AND no surface being created: a tab
          // whose create is in flight has no state yet but already has a
          // webview in its profile's store on the way, and the backend will
          // close it with the rest of the profile.
          const dormantOrphan = (tab: FileWorkspaceTab) =>
            tab.kind === "browser" &&
            !browserProfileExists(prefs, tab.browser.profile) &&
            getBrowserTabState(tab.id) === null &&
            !hasSurfaceClaim(browserTabBackendId(tab.id) ?? "")
          if (!prev.some(dormantOrphan)) return prev
          // A remote tab is not a page of the default profile, whatever id it
          // carries: never the tab that makes a local one a duplicate.
          const inDefault = new Set(
            prev.flatMap((tab) =>
              tab.kind === "browser" &&
              tab.browser.remote !== true &&
              tab.browser.profile === DEFAULT_BROWSER_PROFILE_ID
                ? [normalizeUrlForDedupe(tab.browser.initialUrl) ?? ""]
                : []
            )
          )
          const next: FileWorkspaceTab[] = []
          for (const tab of prev) {
            if (!dormantOrphan(tab) || tab.kind !== "browser") {
              next.push(tab)
              continue
            }
            const key = normalizeUrlForDedupe(tab.browser.initialUrl) ?? ""
            if (inDefault.has(key)) continue
            inDefault.add(key)
            next.push({
              ...tab,
              browser: {
                ...tab.browser,
                profile: DEFAULT_BROWSER_PROFILE_ID,
              },
            })
          }
          return next
        })
      }),
    []
  )

  const suspendBrowserTab = useCallback((tabId: string) => {
    const tab = fileTabsRef.current.find((t) => t.id === tabId)
    if (!tab || tab.kind !== "browser") return false
    const state = getBrowserTabState(tabId)
    if (!state) return false
    // Re-checked here, not just by the caller: the surface host may have
    // mounted (the user switched to this tab) between the caller picking it
    // and this call. `null` means "on screen right now", `undefined` "never
    // shown by this document" — releasing either would blank a live pane.
    if (typeof browserTabHiddenAt(tabId) !== "number") return false
    const url = state.url || state.requestedUrl || tab.browser.initialUrl
    const title = state.title || tab.title
    // Move the record to where the page got to before letting the surface
    // go: the tab strip keeps showing the page's title, and the surface
    // created when the tab is next shown loads that page, not the address
    // the tab was opened with. History and scroll position are lost, as in
    // a browser's discarded tab. A profile deleted while the tab was loaded
    // is left behind here too: the dormant record must not name it — and if
    // the default profile already shows that page, the record goes rather
    // than becoming a duplicate (one tab per page and profile).
    const profile = browserProfileExists(getBrowserPrefs(), tab.browser.profile)
      ? tab.browser.profile
      : DEFAULT_BROWSER_PROFILE_ID
    // Decided inside the updater, against the list as it is when the update
    // applies (a queued insert may land first); the active pointer moves to
    // the neighbouring survivor the way `closeFileTab` does — a suspended
    // tab is off screen, but the file pane may be hidden with it selected.
    const normalized = normalizeUrlForDedupe(url)
    setFileTabs((prev) => {
      const duplicate =
        profile !== tab.browser.profile &&
        prev.some(
          (t) =>
            t.kind === "browser" &&
            t.id !== tabId &&
            t.browser.remote !== true &&
            t.browser.profile === profile &&
            normalizeUrlForDedupe(t.browser.initialUrl) === normalized
        )
      if (!duplicate) {
        return prev.map((t) =>
          t.id === tabId && t.kind === "browser"
            ? {
                ...t,
                title,
                browser: { ...t.browser, initialUrl: url, profile },
              }
            : t
        )
      }
      const idx = prev.findIndex((t) => t.id === tabId)
      const next = prev.filter((t) => t.id !== tabId)
      setActiveFileTabId((current) => {
        if (current !== tabId) return current
        if (next.length === 0) return null
        return next[Math.min(Math.max(idx, 0), next.length - 1)].id
      })
      return next
    })
    // The surface goes, the tab stays — so what the person answered for the
    // sites it has been on stays with it, and the `browser://closed` the
    // backend emits for this is about the surface. Only a close ends a tab.
    releaseBrowserTab(tabId, { suspending: true })
    return true
  }, [])

  // Mark an existing tab as refreshing. Preserves content / originalContent /
  // modifiedContent / gitBaseContent / savedContent / etag / mtimeMs /
  // isDirty / readonly / lineEnding. Clears any prior error state.
  const markTabRefreshing = useCallback((tabId: string) => {
    setFileTabs((prev) =>
      prev.map((tab) =>
        tab.id === tabId
          ? {
              ...tab,
              loading: true,
              saveState: "idle",
              saveError: null,
            }
          : tab
      )
    )
  }, [])

  // Reset an errored tab to a clean cold-load state. The previous error
  // message is currently stored in `content`; clear it so the next load
  // re-enters the placeholder branch instead of flashing the error string.
  const markErrorRetry = useCallback(
    (tabId: string, kind: FileWorkspaceTabKind) => {
      setFileTabs((prev) =>
        prev.map((tab) =>
          tab.id === tabId
            ? {
                ...tab,
                loading: true,
                content: "",
                originalContent:
                  kind === "rich-diff" ? undefined : tab.originalContent,
                modifiedContent:
                  kind === "rich-diff" ? undefined : tab.modifiedContent,
                saveState: "idle",
                saveError: null,
              }
            : tab
        )
      )
    },
    []
  )

  // Replace an entire tab atomically. Used for synchronous content sources
  // (session diffs, external-conflict diffs) where the caller already holds
  // the final content.
  const replaceTabContent = useCallback(
    (nextTab: FileWorkspaceTab) => {
      setFileTabs((prev) => {
        const idx = prev.findIndex((tab) => tab.id === nextTab.id)
        if (idx < 0) return [...prev, nextTab]
        const updated = [...prev]
        updated[idx] = nextTab
        return updated
      })
      setActiveFileTabId(nextTab.id)
      activateFilePane()
    },
    [activateFilePane]
  )

  // Orchestrates the "I want to start (or restart) a load for this tab" flow.
  // Encapsulates: cache short-circuit, in-flight dedup, error retry, forced
  // refresh, and cold-load creation. Returns whether the caller should
  // proceed with its fetch.
  const beginFetchGeneration = useCallback((tabId: string): number => {
    nextLoadGenRef.current += 1
    const gen = nextLoadGenRef.current
    inFlightLoadsRef.current.set(tabId, gen)
    return gen
  }, [])

  const decideLoad = useCallback(
    (
      seed: FileWorkspaceTab,
      reload: boolean,
      background = false,
      index?: number
    ): LoadDecision => {
      // Dedup synchronously. inFlightLoadsRef is updated immediately on
      // generation start, so rapid re-clicks within a single event loop
      // turn collapse here — unlike fileTabsRef.current, which only
      // reflects state after React flushes a render.
      if (inFlightLoadsRef.current.has(seed.id)) {
        activateTab(seed.id, background)
        return { kind: "skip" }
      }

      const existing = fileTabsRef.current.find((t) => t.id === seed.id)
      if (!existing) {
        // "reload" means "refresh an existing tab". If the tab is gone —
        // e.g. the user closed it while a watcher-driven reload was in
        // flight — do not resurrect it as a phantom tab.
        if (reload) return { kind: "skip" }
        seedLoadingTab(seed, background, index)
        return { kind: "fetch", gen: beginFetchGeneration(seed.id) }
      }

      activateTab(existing.id, background)

      if (existing.saveState === "error") {
        markErrorRetry(existing.id, existing.kind)
        return { kind: "fetch", gen: beginFetchGeneration(seed.id) }
      }

      // Stale clean tab — the watcher saw an external change while we were
      // inactive. Promote to reload now so the user never sees stale bytes.
      // Stale dirty tabs are NOT auto-reloaded: conflict resolution belongs
      // to the watcher, which surfaces the prompt instead of clobbering
      // unsaved edits.
      const stalePromotesReload =
        existing.kind === "file" && existing.stale === true && !existing.isDirty

      if (!reload && !stalePromotesReload) {
        // Cache hit — nothing to do.
        return { kind: "skip" }
      }

      markTabRefreshing(existing.id)
      return { kind: "fetch", gen: beginFetchGeneration(seed.id) }
    },
    [
      activateTab,
      beginFetchGeneration,
      markErrorRetry,
      markTabRefreshing,
      seedLoadingTab,
    ]
  )

  // Variant of decideLoad for diff tabs: content is inherently volatile
  // (git state changes), so we always refetch — but non-destructively.
  const beginDiffLoad = useCallback(
    (seed: FileWorkspaceTab): { skip: true } | { skip: false; gen: number } => {
      if (inFlightLoadsRef.current.has(seed.id)) {
        activateTab(seed.id)
        return { skip: true }
      }

      const existing = fileTabsRef.current.find((t) => t.id === seed.id)
      if (!existing) {
        seedLoadingTab(seed)
        return { skip: false, gen: beginFetchGeneration(seed.id) }
      }

      activateTab(seed.id)
      if (existing.saveState === "error") {
        markErrorRetry(seed.id, seed.kind)
      } else {
        markTabRefreshing(seed.id)
      }
      return { skip: false, gen: beginFetchGeneration(seed.id) }
    },
    [
      activateTab,
      beginFetchGeneration,
      markErrorRetry,
      markTabRefreshing,
      seedLoadingTab,
    ]
  )

  // Called from every fetch's resolve/error path. Returns true iff this
  // particular fetch is still the canonical in-flight load for the tab —
  // i.e. the user hasn't closed the tab, switched folders, or started a
  // newer fetch in the meantime. Also performs the cleanup atomically.
  const settleFetch = useCallback((tabId: string, gen: number): boolean => {
    if (inFlightLoadsRef.current.get(tabId) !== gen) return false
    inFlightLoadsRef.current.delete(tabId)
    return true
  }, [])

  const resolveTab = useCallback(
    (tabId: string, content: string, loading = false) => {
      setFileTabs((prev) =>
        prev.map((tab) =>
          tab.id === tabId
            ? {
                ...tab,
                content,
                loading,
              }
            : tab
        )
      )
    },
    []
  )

  const rejectTab = useCallback(
    (tabId: string, errorMessage: string) => {
      resolveTab(
        tabId,
        t("unableLoadContent", { message: errorMessage }),
        false
      )
      setFileTabs((prev) =>
        prev.map((tab) =>
          tab.id === tabId
            ? {
                ...tab,
                saveState: "error",
                saveError: errorMessage,
              }
            : tab
        )
      )
    },
    [resolveTab, t]
  )

  const resolveRichDiffTab = useCallback(
    (
      tabId: string,
      originalContent: string,
      modifiedContent: string,
      loading = false
    ) => {
      setFileTabs((prev) =>
        prev.map((tab) =>
          tab.id === tabId
            ? { ...tab, originalContent, modifiedContent, content: "", loading }
            : tab
        )
      )
    },
    []
  )

  const resolveImageDiffTab = useCallback(
    (tabId: string, imageDiff: ImageDiffSides) => {
      setFileTabs((prev) =>
        prev.map((tab) =>
          tab.id === tabId
            ? { ...tab, imageDiff, content: "", loading: false }
            : tab
        )
      )
    },
    []
  )

  const consumePendingFileReveal = useCallback((requestId: number) => {
    setPendingFileReveal((prev) =>
      prev && prev.requestId === requestId ? null : prev
    )
  }, [])

  // Background reload: refresh an open tab's content without changing
  // activeFileTabId or activating the file pane. Used by the workspace
  // watcher when an external change touches a clean tab the user isn't
  // currently looking at — VS Code / IntelliJ silently absorb such changes
  // so the next activation sees the latest bytes. Dirty tabs are off-limits
  // (conflict resolution belongs to the watcher via markTabsStale).
  const reloadOpenFileBackground = useCallback(
    async (rawPath: string) => {
      const absPath = normalizeAbsPath(rawPath)
      const io = splitAbsPath(absPath)
      if (!io) return
      const tabId = buildFileTabId({ kind: "file", path: absPath })
      const existing = fileTabsRef.current.find((t) => t.id === tabId)
      if (!existing || existing.kind !== "file") return
      if (existing.isDirty) return
      if (inFlightLoadsRef.current.has(tabId)) return

      const image = isImageFile(absPath)

      markTabRefreshing(tabId)
      const gen = beginFetchGeneration(tabId)

      try {
        if (image) {
          const ext = absPath.split(".").pop()?.toLowerCase() ?? ""
          const mime = IMAGE_MIME[ext] ?? "image/png"
          const b64 = await withTimeout(
            readFileBase64(absPath),
            15_000,
            t("previewRequestTimedOut")
          )
          if (!settleFetch(tabId, gen)) return
          setFileTabs((prev) =>
            prev.map((tab) =>
              tab.id === tabId
                ? {
                    ...tab,
                    content: `data:${mime};base64,${b64}`,
                    readonly: true,
                    loading: false,
                    saveState: "idle",
                    saveError: null,
                    stale: false,
                  }
                : tab
            )
          )
          return
        }

        const [result, gitBaseContent] = await withTimeout(
          Promise.all([
            readFileForEdit(io.rootPath, io.ioPath),
            fetchGitBase(absPath),
          ]),
          15_000,
          t("previewRequestTimedOut")
        )
        if (!settleFetch(tabId, gen)) return
        setFileTabs((prev) =>
          prev.map((tab) =>
            tab.id === tabId
              ? {
                  ...tab,
                  content: result.content,
                  gitBaseContent: dedupeGitBase(result.content, gitBaseContent),
                  savedContent: result.content,
                  isDirty: false,
                  etag: result.etag,
                  mtimeMs: result.mtime_ms,
                  readonly: result.readonly,
                  lineEnding: result.line_ending,
                  saveState: "idle",
                  saveError: null,
                  loading: false,
                  stale: false,
                }
              : tab
          )
        )
      } catch (error) {
        if (!settleFetch(tabId, gen)) return
        rejectTab(tabId, toErrorMessage(error))
      }
    },
    [
      beginFetchGeneration,
      fetchGitBase,
      markTabRefreshing,
      rejectTab,
      settleFetch,
      t,
    ]
  )

  // Mark the tab matching `path` as stale so the next activation triggers a
  // reload (clean) or a conflict prompt (dirty). The watcher calls this for
  // dirty non-active tabs when an external change is observed, since silently
  // reloading would discard the user's unsaved edits.
  const markTabsStale = useCallback((rawPath: string) => {
    const tabId = buildFileTabId({
      kind: "file",
      path: normalizeAbsPath(rawPath),
    })
    setFileTabs((prev) => {
      const idx = prev.findIndex((tab) => tab.id === tabId)
      if (idx < 0) return prev
      const tab = prev[idx]
      if (tab.stale === true) return prev
      const updated = [...prev]
      updated[idx] = { ...tab, stale: true }
      return updated
    })
  }, [])

  // Batch variant for the watcher's lazy background pass: N affected
  // background tabs cost ONE setState and zero disk reads. Patches ONLY
  // the `stale` flag — never content or any other field — so it composes
  // safely with concurrent keystroke updaters in the same React batch.
  const markTabsStaleBatch = useCallback((rawPaths: string[]) => {
    if (rawPaths.length === 0) return
    const tabIds = new Set(
      rawPaths.map((rawPath) =>
        buildFileTabId({ kind: "file", path: normalizeAbsPath(rawPath) })
      )
    )
    setFileTabs((prev) => {
      let changed = false
      const next = prev.map((tab) => {
        if (!tabIds.has(tab.id) || tab.kind !== "file") return tab
        if (tab.stale === true) return tab
        changed = true
        return { ...tab, stale: true }
      })
      return changed ? next : prev
    })
  }, [])

  // Write a prefetched FileEditContent into the matching tab. The change-
  // detection watcher uses this after its resolver has already read the
  // latest disk content — without this we would re-read every file twice
  // per workspace event (resolver + reload). Dirty tabs are skipped so
  // unsaved edits are never silently clobbered.
  //
  // Concurrency contract: the in-flight marker is bumped to invalidate any
  // concurrent openFilePreview's pending settle (so an older read cannot
  // overwrite our newer payload) and is then settled IMMEDIATELY after the
  // synchronous content write. The slow, cosmetic git-base refresh runs
  // out-of-band — it does NOT extend the in-flight marker's lifetime —
  // so a stuck git invocation cannot block a subsequent user-initiated
  // reload via the openFilePreview dedup path.
  const applyExternalReload = useCallback(
    async (rawPath: string, fetched: FileEditContent) => {
      const absPath = normalizeAbsPath(rawPath)
      const tabId = buildFileTabId({ kind: "file", path: absPath })
      // Outer existence check — purely to avoid bumping the in-flight gen
      // for a non-existent path (which would pollute openFilePreview's
      // dedup). The dirty guard is NOT outer: fileTabsRef can lag a tick
      // behind a user keystroke whose dirty update is already enqueued
      // but not yet committed. The atomic check lives inside the
      // setFileTabs updater below, where prev reflects every earlier
      // queued updater (including the keystroke).
      const existing = fileTabsRef.current.find((t) => t.id === tabId)
      if (!existing || existing.kind !== "file") return

      const gen = beginFetchGeneration(tabId)
      const fetchedEtag = fetched.etag

      // Atomic write: refuses the apply if the tab became dirty between
      // our outer existence check and the actual commit (e.g. user typed
      // in the same React batch as the watcher's apply call). The refused
      // branch flips stale=true so the aux-panel effect (stale && isDirty
      // → announceConflict) surfaces the divergence immediately instead
      // of waiting for the next save to discover the etag mismatch.
      setFileTabs((prev) =>
        prev.map((tab) => {
          if (tab.id !== tabId || tab.kind !== "file") return tab
          if (tab.isDirty) return { ...tab, stale: true }
          return {
            ...tab,
            content: fetched.content,
            savedContent: fetched.content,
            isDirty: false,
            etag: fetched.etag,
            mtimeMs: fetched.mtime_ms,
            readonly: fetched.readonly,
            lineEnding: fetched.line_ending,
            loading: false,
            stale: false,
            saveState: "idle",
            saveError: null,
          }
        })
      )

      // Release the in-flight marker NOW. Two-stage invalidation: the
      // beginFetchGeneration above already poisoned any concurrent
      // openFilePreview fetch (its settleFetch will fail), so clearing
      // here cannot resurrect an in-flight overwrite. The cosmetic git
      // base refresh below is decoupled — slow git must not block user
      // reload dedup. (Each call's settle is mutually exclusive: the
      // last applyExternalReload's gen wins, prior gens are stale.)
      settleFetch(tabId, gen)

      // Fire-and-forget git base refresh, etag-gated.
      //
      // The captured fetchedEtag doubles as a staleness token: if our
      // atomic write above succeeded, the tab now carries fetchedEtag;
      // if it was refused (dirty), or a later applyExternalReload /
      // openFilePreview reload / close+reopen changed the tab, the tab
      // carries a different etag. The final write checks tab.etag ===
      // fetchedEtag inside the updater so a stale fetch can never paint
      // gitter decorations onto a tab whose content has moved on. No
      // separate generation token needed — etag is the natural fingerprint.
      void (async () => {
        try {
          const gitBaseContent = await withTimeout(
            fetchGitBase(absPath),
            15_000,
            t("previewRequestTimedOut")
          )
          setFileTabs((prev) =>
            prev.map((tab) => {
              if (tab.id !== tabId || tab.kind !== "file") return tab
              if (tab.etag !== fetchedEtag) return tab
              return {
                ...tab,
                gitBaseContent: dedupeGitBase(tab.content, gitBaseContent),
              }
            })
          )
        } catch {
          // Timeout or unexpected failure: leave existing gitBaseContent.
        }
      })()
    },
    [beginFetchGeneration, fetchGitBase, settleFetch, t]
  )

  // Mark a clean open tab as load-failed. Used by the change-detection
  // watcher when a readFileForEdit on a changed path fails (most commonly
  // external delete). Dirty tabs are deliberately not touched here — the
  // watcher routes them to markTabsStale so unsaved edits are preserved.
  const rejectFileTab = useCallback(
    (rawPath: string, errorMessage: string) => {
      const tabId = buildFileTabId({
        kind: "file",
        path: normalizeAbsPath(rawPath),
      })
      // Outer existence check only; the dirty guard is atomic inside the
      // updater (see applyExternalReload for the same race shape).
      const existing = fileTabsRef.current.find((t) => t.id === tabId)
      if (!existing || existing.kind !== "file") return

      // Bump generation so any concurrent fetch's settle is invalidated
      // and cannot overwrite the error message we are about to write.
      const gen = beginFetchGeneration(tabId)
      setFileTabs((prev) =>
        prev.map((tab) => {
          if (tab.id !== tabId || tab.kind !== "file") return tab
          // Symmetric with applyExternalReload's dirty refusal: surface
          // the divergence via stale rather than silently no-op. Callers
          // typically also call markTabsStale, so this is usually
          // idempotent; the in-updater write protects direct callers.
          if (tab.isDirty) return { ...tab, stale: true }
          return {
            ...tab,
            content: t("unableLoadContent", { message: errorMessage }),
            loading: false,
            stale: false,
            saveState: "error",
            saveError: errorMessage,
          }
        })
      )
      settleFetch(tabId, gen)
    },
    [beginFetchGeneration, settleFetch, t]
  )

  const openFilePreview = useCallback(
    async (
      rawPath: string,
      options?: {
        line?: number
        reload?: boolean
        folderId?: number
        background?: boolean
        index?: number
      }
    ) => {
      const absPath = await resolveOpenAbsolutePath(rawPath, options?.folderId)
      if (!absPath) return null
      const io = splitAbsPath(absPath)
      if (!io) return null
      // The load runs in an inner closure purely so every early `return`
      // below stays a plain "stop here" — the resolved absolute path is the
      // caller's answer either way, and surfaces that mirror the tab
      // elsewhere (the transcript's file viewer drawer) need it to find the
      // tab this call created.
      await (async () => {
        const background = options?.background === true
        const requestedLine =
          typeof options?.line === "number" && Number.isFinite(options.line)
            ? Math.max(1, Math.floor(options.line))
            : null
        // A background open never touches the pending reveal: it is not
        // asking the file column to scroll anywhere, and clearing the field
        // would cancel a reveal some other opener is waiting on.
        if (!background) {
          if (requestedLine) {
            fileRevealRequestIdRef.current += 1
            setPendingFileReveal({
              requestId: fileRevealRequestIdRef.current,
              path: absPath,
              line: requestedLine,
            })
          } else {
            setPendingFileReveal(null)
          }
        }
        const tabId = buildFileTabId({ kind: "file", path: absPath })
        const image = isImageFile(absPath)
        const office = !image && isOfficePreviewable(absPath)
        const seed = loadingTab(
          tabId,
          null,
          "file",
          fileName(absPath),
          absPath,
          absPath,
          image ? "image" : office ? "office" : languageFromPath(absPath)
        )

        const decision = decideLoad(
          seed,
          options?.reload ?? false,
          background,
          options?.index
        )
        if (decision.kind === "skip") return
        const { gen } = decision

        try {
          // Office files (.docx/.xlsx/.pptx) are binary OpenXML — never read as
          // text. The OfficePreview component renders them via the OfficeCLI
          // backend on its own, so just settle the tab as a ready preview shell.
          if (office) {
            if (!settleFetch(tabId, gen)) return
            setFileTabs((prev) =>
              prev.map((tab) =>
                tab.id === tabId
                  ? {
                      ...tab,
                      content: "",
                      readonly: true,
                      loading: false,
                      saveState: "idle",
                      saveError: null,
                      stale: false,
                    }
                  : tab
              )
            )
            return
          }

          if (image) {
            const ext = absPath.split(".").pop()?.toLowerCase() ?? ""
            const mime = IMAGE_MIME[ext] ?? "image/png"
            const b64 = await withTimeout(
              readFileBase64(absPath),
              15_000,
              t("previewRequestTimedOut")
            )
            if (!settleFetch(tabId, gen)) return
            setFileTabs((prev) =>
              prev.map((tab) =>
                tab.id === tabId
                  ? {
                      ...tab,
                      content: `data:${mime};base64,${b64}`,
                      readonly: true,
                      loading: false,
                      saveState: "idle",
                      saveError: null,
                      stale: false,
                    }
                  : tab
              )
            )
            return
          }

          const [result, gitBaseContent] = await withTimeout(
            Promise.all([
              readFileForEdit(io.rootPath, io.ioPath),
              fetchGitBase(absPath),
            ]),
            15_000,
            t("previewRequestTimedOut")
          )
          if (!settleFetch(tabId, gen)) return
          setFileTabs((prev) =>
            prev.map((tab) =>
              tab.id === tabId
                ? {
                    ...tab,
                    content: result.content,
                    gitBaseContent: dedupeGitBase(
                      result.content,
                      gitBaseContent
                    ),
                    savedContent: result.content,
                    isDirty: false,
                    etag: result.etag,
                    mtimeMs: result.mtime_ms,
                    readonly: result.readonly,
                    lineEnding: result.line_ending,
                    saveState: "idle",
                    saveError: null,
                    loading: false,
                    stale: false,
                  }
                : tab
            )
          )
        } catch (error) {
          if (!settleFetch(tabId, gen)) return
          if (requestedLine) {
            setPendingFileReveal((prev) =>
              prev && prev.path === absPath ? null : prev
            )
          }
          rejectTab(tabId, toErrorMessage(error))
        }
      })()
      return absPath
    },
    [
      decideLoad,
      fetchGitBase,
      rejectTab,
      resolveOpenAbsolutePath,
      settleFetch,
      t,
    ]
  )

  // Auto-surface office files (.docx/.xlsx/.pptx) the agent produces. This used
  // to live in the file-tree aux panel, but that panel is closed by default and
  // unmounts its subscription with it — so the preview never opened unless the
  // user happened to have the sidebar open. The preview itself lands in the
  // files pane (openFilePreview → seedLoadingTab activates it), which is owned
  // here and always mounted, so the trigger belongs here too.
  //
  // We retain the workspace watch stream from this always-mounted provider so
  // change envelopes keep flowing regardless of the aux panel. The store is a
  // per-path refcounted singleton, so this shares the same backend stream the
  // aux panel tabs use. Gated on the preference: with auto-preview off we hold
  // no extra ref, leaving today's aux-panel-scoped lifecycle untouched.
  const officeAutoPreview = useOfficeAutoPreview()
  // Paths-only subscription: this exists for changed_paths envelopes and
  // must never be the reason a root runs tree/git scans.
  const officeWatchStore = useWorkspaceStateStore(
    officeAutoPreview ? (folderPath ?? null) : null,
    "paths"
  )
  const subscribeOfficeEnvelopes = officeWatchStore.subscribeEnvelopes
  const activeFolderIdForOffice = activeFolder?.id
  useEffect(() => {
    if (!folderPath || activeFolderIdForOffice == null || !officeAutoPreview) {
      return
    }
    // Leading-edge with dedup: an agent building a doc fires a burst of writes,
    // so we open on first sighting and remember it in `autoOpened` (which also
    // keeps a tab the user has since closed from popping back open).
    const autoOpened = autoOpenedOfficePathsRef.current
    const pending = new Set<string>()
    let cancelled = false
    const streamRoot = folderPath
    const unsubscribe = subscribeOfficeEnvelopes(({ changed_paths }) => {
      if (!changed_paths || changed_paths.length === 0) return
      const directories = new Map<
        string,
        ReturnType<typeof listDirectoryWithFiles>
      >()
      // Tab identity is the absolute path, so joining the stream root onto
      // the changed relative path compares exactly — an identically-named
      // doc in another folder has a different absolute path and never
      // suppresses this preview.
      const openPaths = new Set(
        fileTabsRef.current
          .filter((tab) => tab.kind === "file" && tab.path)
          .map((tab) => tab.path as string)
      )
      for (const changed of changed_paths) {
        if (!isOfficePreviewable(changed)) continue
        // Dot-prefixed paths are hidden/machine-owned (editor lock files,
        // AppleDouble sidecars, anything under `.git`/`.tmp`) — never a
        // document the agent meant to show. Skipping here means we neither
        // open a tab for one nor spawn its `officecli watch` process; a user
        // who wants one can still open it by hand from the file tree.
        if (isHiddenPath(changed)) continue
        // Office/WPS owner files (`~$report.docx`) are the same story under a
        // different naming convention, and the one that actually bites: they
        // carry a real office extension, so nothing above rejects them, and
        // opening a folder of documents externally drops a whole burst of them
        // at once — which arrived here as a dozen unreadable previews.
        if (isOfficeOwnerFile(changed)) continue
        const abs = joinRootRel(streamRoot, changed)
        if (autoOpened.has(abs) || pending.has(abs)) continue
        // An already-open tab counts as a sighting, not just a skip: this
        // feature exists to surface documents the user has NOT seen, so a tab
        // they opened by hand must not become a fresh auto-open the moment
        // they close it and the agent writes again.
        if (openPaths.has(abs)) {
          autoOpened.add(abs)
          continue
        }
        const io = splitAbsPath(abs)
        if (!io) continue
        pending.add(abs)
        // changed_paths includes removals, including removed worktree copies.
        // Inspect directory metadata before opening a tab, without reading or
        // locking the Office document. Share one listing per parent per burst.
        let listing = directories.get(io.rootPath)
        if (!listing) {
          listing = listDirectoryWithFiles(io.rootPath)
          directories.set(io.rootPath, listing)
        }
        void listing
          .then((entries) => {
            if (cancelled || autoOpened.has(abs)) return
            const exists = entries.some(
              (entry) =>
                !entry.isDir &&
                entry.size != null &&
                normalizeAbsPath(entry.path) === abs
            )
            if (!exists) return
            autoOpened.add(abs)
            // A manual open during the lookup already handled this file.
            if (fileTabsRef.current.some((tab) => tab.path === abs)) return
            return openFilePreview(abs)
          })
          .catch(() => {
            // Covers both halves of the chain: a removed/unreadable parent is
            // not a document to preview, and `openFilePreview` already reports
            // its own failures on the tab it seeded.
          })
          .finally(() => pending.delete(abs))
      }
    })
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [
    folderPath,
    activeFolderIdForOffice,
    officeAutoPreview,
    subscribeOfficeEnvelopes,
    openFilePreview,
  ])

  // The image counterpart of the three rich-diff loaders below: a binary image
  // has no text sides to fetch (`git show` refuses it outright), so both sides
  // come back as bytes and land on the tab as an `imageDiff` instead.
  const loadImageRichDiff = useCallback(
    async (args: {
      tabId: string
      gen: number
      folderPath: string
      file: string
      original: ImageDiffSource
      modified: ImageDiffSource
      timeoutMessage: string
    }) => {
      try {
        const sides = await withTimeout(
          loadImageDiffSides(
            args.folderPath,
            args.file,
            args.original,
            args.modified
          ),
          20_000,
          args.timeoutMessage
        )
        if (settleFetch(args.tabId, args.gen)) {
          resolveImageDiffTab(args.tabId, sides)
        }
      } catch (error) {
        if (settleFetch(args.tabId, args.gen)) {
          rejectTab(args.tabId, toErrorMessage(error))
        }
      }
    },
    [rejectTab, resolveImageDiffTab, settleFetch]
  )

  const openWorkingTreeDiff = useCallback(
    async (
      rawPath?: string,
      options?: {
        mode?: "auto" | "unified" | "overview"
        folderId?: number
      }
    ) => {
      const target = resolveTargetFolder(options?.folderId)
      if (!target) return
      const folderPath = target.path

      if (!rawPath) {
        const tabId = buildFileTabId({
          kind: "diff-working-all",
          folderId: target.id,
        })
        const title = t("diffTitleWorkspace")
        const description = t("diffDescriptionWorkingTree")
        const seed = loadingTab(
          tabId,
          target.id,
          "diff",
          title,
          description,
          null,
          "diff"
        )
        const decision = beginDiffLoad(seed)
        if (decision.skip) return
        const { gen } = decision
        try {
          const result = await withTimeout(
            gitDiff(folderPath),
            20_000,
            t("diffRequestTimedOut")
          )
          if (settleFetch(tabId, gen))
            resolveTab(tabId, result || t("noChanges"), false)
        } catch (error) {
          if (settleFetch(tabId, gen)) rejectTab(tabId, toErrorMessage(error))
        }
        return
      }

      const path = normalizePath(rawPath)
      const mode = options?.mode ?? "auto"

      if (mode === "overview") {
        const isRoot = path === "."
        const displayPath = isRoot ? folderPath : path
        const tabId = buildFileTabId({
          kind: "diff-working-overview",
          folderId: target.id,
          path,
        })
        const title = t("diffTitleFile", {
          name: fileName(displayPath ?? path),
        })
        const description = displayPath ?? path
        const seed = loadingTab(
          tabId,
          target.id,
          "diff",
          title,
          description,
          path,
          "diff"
        )
        const decision = beginDiffLoad(seed)
        if (decision.skip) return
        const { gen } = decision
        try {
          const result = await withTimeout(
            gitDiff(folderPath, path),
            20_000,
            t("diffRequestTimedOut")
          )
          if (settleFetch(tabId, gen))
            resolveTab(tabId, result || t("noChanges"), false)
        } catch (error) {
          if (settleFetch(tabId, gen)) rejectTab(tabId, toErrorMessage(error))
        }
        return
      }

      if (mode === "unified") {
        const tabId = buildFileTabId({
          kind: "diff-working-unified",
          folderId: target.id,
          path,
        })
        const title = t("diffTitleFile", { name: fileName(path) })
        const description = path
        const seed = loadingTab(
          tabId,
          target.id,
          "diff",
          title,
          description,
          path,
          "diff"
        )
        const decision = beginDiffLoad(seed)
        if (decision.skip) return
        const { gen } = decision
        try {
          const result = await withTimeout(
            gitDiff(folderPath, path),
            20_000,
            t("diffRequestTimedOut")
          )
          if (settleFetch(tabId, gen))
            resolveTab(tabId, result || t("noChanges"), false)
        } catch (error) {
          if (settleFetch(tabId, gen)) rejectTab(tabId, toErrorMessage(error))
        }
        return
      }

      const tabId = buildFileTabId({
        kind: "diff-working",
        folderId: target.id,
        path,
      })
      const title = t("diffTitleFile", { name: fileName(path) })
      const description = path
      const isImageDiff = isBinaryImageFile(path)
      const lang = isImageDiff ? "image" : languageFromPath(path)

      const seed = loadingTab(
        tabId,
        target.id,
        "rich-diff",
        title,
        description,
        path,
        lang
      )
      const decision = beginDiffLoad(seed)
      if (decision.skip) return
      const { gen } = decision
      if (isImageDiff) {
        await loadImageRichDiff({
          tabId,
          gen,
          folderPath,
          file: path,
          // A fresh repo has an unborn HEAD: nothing came before, which is
          // an absent side rather than a failed read.
          original: { kind: "ref", ref: "HEAD", missingRefIsAbsent: true },
          modified: { kind: "worktree" },
          timeoutMessage: t("diffRequestTimedOut"),
        })
        return
      }
      try {
        const [originalContent, modifiedResult] = await withTimeout(
          Promise.all([
            gitShowFile(folderPath, path).catch(() => ""),
            readFilePreview(folderPath, path).catch(() => ({
              content: "",
              path: "",
            })),
          ]),
          20_000,
          t("diffRequestTimedOut")
        )
        if (settleFetch(tabId, gen))
          resolveRichDiffTab(tabId, originalContent, modifiedResult.content)
      } catch (error) {
        if (settleFetch(tabId, gen)) rejectTab(tabId, toErrorMessage(error))
      }
    },
    [
      beginDiffLoad,
      loadImageRichDiff,
      rejectTab,
      resolveTab,
      resolveRichDiffTab,
      resolveTargetFolder,
      settleFetch,
      t,
    ]
  )

  const openBranchDiff = useCallback(
    async (
      branch: string,
      rawPath?: string,
      options?: { mode?: "default" | "overview"; folderId?: number }
    ) => {
      const target = resolveTargetFolder(options?.folderId)
      if (!target) return
      const folderPath = target.path
      const targetBranch = branch.trim()
      if (!targetBranch) return

      const path = rawPath ? normalizePath(rawPath) : null
      const mode = options?.mode ?? "default"
      const tabId =
        mode === "overview"
          ? buildFileTabId({
              kind: "diff-branch-overview",
              folderId: target.id,
              branch: targetBranch,
              path,
            })
          : buildFileTabId({
              kind: "diff-branch",
              folderId: target.id,
              branch: targetBranch,
              path,
            })
      const title = path
        ? t("compareTitleFile", { name: fileName(path) })
        : t("compareTitleBranch", { branch: targetBranch })
      const description = path
        ? t("compareDescriptionPath", { path, branch: targetBranch })
        : t("compareDescriptionBranch", { branch: targetBranch })

      if (mode !== "overview" && path) {
        const isImageDiff = isBinaryImageFile(path)
        const lang = isImageDiff ? "image" : languageFromPath(path)
        const seed = loadingTab(
          tabId,
          target.id,
          "rich-diff",
          title,
          description,
          path,
          lang
        )
        const decision = beginDiffLoad(seed)
        if (decision.skip) return
        const { gen } = decision
        if (isImageDiff) {
          await loadImageRichDiff({
            tabId,
            gen,
            folderPath,
            file: path,
            original: { kind: "ref", ref: targetBranch },
            modified: { kind: "worktree" },
            timeoutMessage: t("branchCompareRequestTimedOut"),
          })
          return
        }
        try {
          const [originalContent, modifiedResult] = await withTimeout(
            Promise.all([
              gitShowFile(folderPath, path, targetBranch).catch(() => ""),
              readFilePreview(folderPath, path).catch(() => ({
                content: "",
                path: "",
              })),
            ]),
            20_000,
            t("branchCompareRequestTimedOut")
          )
          if (settleFetch(tabId, gen))
            resolveRichDiffTab(tabId, originalContent, modifiedResult.content)
        } catch (error) {
          if (settleFetch(tabId, gen)) rejectTab(tabId, toErrorMessage(error))
        }
        return
      }

      const seed = loadingTab(
        tabId,
        target.id,
        "diff",
        title,
        description,
        path,
        "diff"
      )
      const decision = beginDiffLoad(seed)
      if (decision.skip) return
      const { gen } = decision
      try {
        const result = await withTimeout(
          gitDiffWithBranch(folderPath, targetBranch, path ?? undefined),
          20_000,
          t("branchCompareRequestTimedOut")
        )
        if (settleFetch(tabId, gen))
          resolveTab(tabId, result || t("noChanges"), false)
      } catch (error) {
        if (settleFetch(tabId, gen)) rejectTab(tabId, toErrorMessage(error))
      }
    },
    [
      beginDiffLoad,
      loadImageRichDiff,
      rejectTab,
      resolveRichDiffTab,
      resolveTab,
      resolveTargetFolder,
      settleFetch,
      t,
    ]
  )

  const openCommitDiff = useCallback(
    async (
      commit: string,
      rawPath?: string,
      message?: string,
      options?: { folderId?: number }
    ) => {
      const target = resolveTargetFolder(options?.folderId)
      if (!target) return
      const folderPath = target.path
      const path = rawPath ? normalizePath(rawPath) : null
      const tabId = buildFileTabId({
        kind: "diff-commit",
        folderId: target.id,
        commit,
        path,
      })
      const title = path
        ? t("diffTitleCommitFile", {
            name: fileName(path),
            hash: commit.slice(0, 7),
          })
        : t("diffTitleCommit", { hash: commit.slice(0, 7) })
      const description = path
        ? t("diffDescriptionCommitPath", { path, commit })
        : message || t("diffDescriptionCommit", { commit })

      if (path) {
        const isImageDiff = isBinaryImageFile(path)
        const lang = isImageDiff ? "image" : languageFromPath(path)
        const seed = loadingTab(
          tabId,
          target.id,
          "rich-diff",
          title,
          description,
          path,
          lang
        )
        const decision = beginDiffLoad(seed)
        if (decision.skip) return
        const { gen } = decision
        if (isImageDiff) {
          await loadImageRichDiff({
            tabId,
            gen,
            folderPath,
            file: path,
            // A commit's parent fails to resolve for two reasons: it is a
            // root commit, or this is a shallow clone's boundary. Both read
            // as "nothing came before" — which is what git itself reports
            // (`git show` at a shallow boundary lists every file as added),
            // and what the text diff beside this one already assumes.
            original: {
              kind: "ref",
              ref: `${commit}~1`,
              missingRefIsAbsent: true,
            },
            modified: { kind: "ref", ref: commit },
            timeoutMessage: t("commitDiffRequestTimedOut"),
          })
          return
        }
        try {
          const [originalContent, modifiedContent] = await withTimeout(
            Promise.all([
              gitShowFile(folderPath, path, `${commit}~1`).catch(() => ""),
              gitShowFile(folderPath, path, commit).catch(() => ""),
            ]),
            20_000,
            t("commitDiffRequestTimedOut")
          )
          if (settleFetch(tabId, gen))
            resolveRichDiffTab(tabId, originalContent, modifiedContent)
        } catch (error) {
          if (settleFetch(tabId, gen)) rejectTab(tabId, toErrorMessage(error))
        }
      } else {
        const seed = loadingTab(
          tabId,
          target.id,
          "diff",
          title,
          description,
          path,
          "diff"
        )
        const decision = beginDiffLoad(seed)
        if (decision.skip) return
        const { gen } = decision
        try {
          const result = await withTimeout(
            gitShowDiff(folderPath, commit, undefined),
            20_000,
            t("commitDiffRequestTimedOut")
          )
          if (settleFetch(tabId, gen))
            resolveTab(tabId, result || t("noDiffOutput"), false)
        } catch (error) {
          if (settleFetch(tabId, gen)) rejectTab(tabId, toErrorMessage(error))
        }
      }
    },
    [
      beginDiffLoad,
      loadImageRichDiff,
      rejectTab,
      resolveTab,
      resolveRichDiffTab,
      resolveTargetFolder,
      settleFetch,
      t,
    ]
  )

  const openSessionFileDiff = useCallback(
    (
      filePath: string,
      diffContent: string,
      groupLabel: string,
      options?: { folderId?: number }
    ) => {
      const target = resolveTargetFolder(options?.folderId)
      if (!target) return
      const path = normalizePath(filePath)
      const tabId = buildFileTabId({
        kind: "diff-session",
        folderId: target.id,
        groupLabel,
        path,
      })
      const title = t("diffTitleFile", { name: fileName(path) })
      const description = `${path} · ${groupLabel}`

      const tab: FileWorkspaceTab = {
        id: tabId,
        kind: "diff",
        folderId: target.id,
        title,
        description,
        path: null,
        language: "diff",
        content: diffContent,
        loading: false,
      }

      replaceTabContent(tab)
    },
    [replaceTabContent, resolveTargetFolder, t]
  )

  const openExternalConflictDiff = useCallback(
    (filePath: string, diskContent: string, unsavedContent: string) => {
      const path = normalizeAbsPath(filePath)
      const tabId = buildFileTabId({ kind: "diff-external-conflict", path })
      const title = t("diffTitleConflictFile", { name: fileName(path) })
      const description = t("diffDescriptionConflict", { path })
      const language = languageFromPath(path)

      const tab: FileWorkspaceTab = {
        id: tabId,
        kind: "rich-diff",
        folderId: null,
        title,
        description,
        path,
        language,
        content: "",
        loading: false,
        originalContent: diskContent,
        modifiedContent: unsavedContent,
      }

      replaceTabContent(tab)
    },
    [replaceTabContent, t]
  )

  // Queue a divergence for the conflict dialog. Deduped two ways: a
  // signature already announced for this path is dropped entirely (no
  // flicker on repeated watcher events); a NEW signature for an
  // already-queued path replaces that entry in place (disk moved again
  // while the prompt waited) instead of queueing a second prompt.
  //
  // `force` bypasses the shown-signature dedup: an explicit USER action
  // (a refused save) must re-surface the dialog even when the same
  // divergence was announced before and dismissed/compared — otherwise
  // the save silently no-ops with no recovery UI. Watcher-driven
  // announcements never force.
  const enqueueExternalConflict = useCallback(
    (conflict: WorkspaceExternalConflict, options?: { force?: boolean }) => {
      const key = conflictKey(conflict.path)
      const shown = conflictSignatureByKeyRef.current.get(key)
      if (!options?.force && shown === conflict.signature) return
      conflictSignatureByKeyRef.current.set(key, conflict.signature)
      setExternalConflictQueue((prev) => {
        const idx = prev.findIndex((queued) => conflictKey(queued.path) === key)
        if (idx >= 0) {
          const next = [...prev]
          next[idx] = conflict
          return next
        }
        return [...prev, conflict]
      })
    },
    []
  )

  // Dequeue the current head. `clearSignature` re-arms the dedup so the
  // same divergence prompts again (used by "reload", which resolves it);
  // compare/save-copy/dismiss keep the signature so the still-diverged
  // file does not immediately re-prompt.
  const dequeueExternalConflict = useCallback(
    (options?: { clearSignature?: boolean }) => {
      const head = externalConflictQueueRef.current[0]
      if (!head) return null
      if (options?.clearSignature) {
        conflictSignatureByKeyRef.current.delete(conflictKey(head.path))
      }
      setExternalConflictQueue((prev) =>
        prev[0] === head ? prev.slice(1) : prev.filter((c) => c !== head)
      )
      return head
    },
    []
  )

  const compareExternalConflict = useCallback(() => {
    const head = dequeueExternalConflict()
    if (!head) return
    // Prefer the LIVE buffer content over the snapshot captured when the
    // conflict was detected — the user may have typed since.
    const tabId = buildFileTabId({ kind: "file", path: head.path })
    const latestTab = fileTabsRef.current.find((t) => t.id === tabId)
    const unsavedContent =
      latestTab && latestTab.kind === "file" && !latestTab.loading
        ? latestTab.content
        : head.unsavedContent
    openExternalConflictDiff(head.path, head.diskContent, unsavedContent)
  }, [dequeueExternalConflict, openExternalConflictDiff])

  const reloadExternalConflict = useCallback(() => {
    const head = dequeueExternalConflict({ clearSignature: true })
    if (!head) return
    void openFilePreview(head.path, { reload: true })
  }, [dequeueExternalConflict, openFilePreview])

  const saveExternalConflictCopy = useCallback(async (): Promise<string> => {
    const head = externalConflictQueueRef.current[0]
    if (!head) throw new Error("no external conflict to resolve")
    const io = splitAbsPath(head.path)
    if (!io) throw new Error("invalid file path")
    const tabId = buildFileTabId({ kind: "file", path: head.path })
    const latestTab = fileTabsRef.current.find(
      (candidate) => candidate.id === tabId
    )
    const unsavedContent =
      latestTab && latestTab.kind === "file" && !latestTab.loading
        ? latestTab.content
        : head.unsavedContent
    // Throws on failure BEFORE dequeueing — the conflict stays queued so
    // the user can retry or pick another resolution.
    const result = await saveFileCopy(io.rootPath, io.ioPath, unsavedContent)
    dequeueExternalConflict()
    return result.path
  }, [dequeueExternalConflict])

  const dismissExternalConflict = useCallback(() => {
    dequeueExternalConflict()
  }, [dequeueExternalConflict])

  const updateFileTabContent = useCallback((tabId: string, content: string) => {
    const updateTabs = (tabs: FileWorkspaceTab[]): FileWorkspaceTab[] =>
      tabs.map((tab) => {
        if (tab.id !== tabId || tab.kind !== "file") return tab
        if (tab.loading || tab.readonly) return tab
        if (tab.content === content) return tab

        const savedContent = tab.savedContent ?? ""
        return {
          ...tab,
          content,
          isDirty: content !== savedContent,
          saveState: tab.saveState === "saving" ? "saving" : "idle",
          saveError: null,
        }
      })

    fileTabsRef.current = updateTabs(fileTabsRef.current)
    setFileTabs(updateTabs)
  }, [])

  const updateActiveFileContent = useCallback(
    (content: string) => {
      const activeId = activeFileTabIdRef.current
      if (!activeId) return
      updateFileTabContent(activeId, content)
    },
    [updateFileTabContent]
  )

  const saveFileTab = useCallback(
    async (tabId: string, options?: { force?: boolean }): Promise<boolean> => {
      if (composingFileTabIdsRef.current.has(tabId)) {
        const deferredOptions = deferredSaveTabsRef.current.get(tabId)
        deferredSaveTabsRef.current.set(tabId, {
          force: Boolean(deferredOptions?.force || options?.force),
        })
        return false
      }
      const tab = fileTabsRef.current.find(
        (candidate) => candidate.id === tabId
      )
      if (!tab || tab.kind !== "file") return false
      if (tab.loading || tab.readonly) return false
      if (!tab.path) return false
      if (!tab.isDirty) return true

      const io = splitAbsPath(tab.path)
      if (!io) return false

      // Divergence guard (covers EVERY write path — manual save, 5s
      // autosave, blur/switch/close saves — because they all funnel here):
      // `stale` means the watcher observed an external change this buffer
      // has not reconciled against; a file OUTSIDE every registered folder
      // has no watcher at all, so its saves ALWAYS pre-verify. Never write
      // blindly: an equal etag proves the flag was spurious (our own save
      // echo) and the save proceeds; a different etag is a real divergence
      // — surface the conflict prompt and refuse the save. `force: true`
      // (the conflict dialog's own overwrite path) bypasses.
      const unwatched = !findOwningFolder(
        tab.path,
        useAppWorkspaceStore.getState().allFolders
      )
      if ((tab.stale || unwatched) && !options?.force) {
        try {
          const latest = await readFileForEdit(io.rootPath, io.ioPath)
          if ((latest.etag ?? null) !== (tab.etag ?? null)) {
            // Forced: the user just asked to save and the save is being
            // refused — the dialog must re-appear even if this divergence
            // was announced before and dismissed/compared.
            enqueueExternalConflict(
              {
                path: tab.path,
                diskContent: latest.content,
                unsavedContent: tab.content,
                signature: latest.etag ?? "",
              },
              { force: true }
            )
            return false
          }
        } catch (error) {
          // Disk unreadable (deleted/locked). Keep the dirty buffer and
          // fail the save visibly; the user decides via the error state.
          const message = toErrorMessage(error)
          setFileTabs((prev) =>
            prev.map((candidate) =>
              candidate.id === tabId
                ? { ...candidate, saveState: "error", saveError: message }
                : candidate
            )
          )
          return false
        }
      }

      const contentAtSaveStart = tab.content
      const expectedEtag = options?.force ? null : (tab.etag ?? null)

      setFileTabs((prev) =>
        prev.map((candidate) =>
          candidate.id === tabId
            ? {
                ...candidate,
                saveState: "saving",
                saveError: null,
              }
            : candidate
        )
      )

      try {
        const result = await withTimeout(
          saveFileContent(
            io.rootPath,
            io.ioPath,
            contentAtSaveStart,
            expectedEtag
          ),
          20_000,
          t("saveRequestTimedOut")
        )

        // One-shot echo record: the watcher will see this write as a
        // change event; suppress that single event for this path.
        recordSelfWriteEcho(tab.path, result.etag)

        setFileTabs((prev) =>
          prev.map((candidate) => {
            if (candidate.id !== tabId || candidate.kind !== "file") {
              return candidate
            }

            const savedContent = contentAtSaveStart
            return {
              ...candidate,
              etag: result.etag,
              mtimeMs: result.mtime_ms,
              readonly: result.readonly,
              lineEnding: result.line_ending,
              savedContent,
              isDirty: candidate.content !== savedContent,
              // An optimistic-locked save succeeding means the buffer IS
              // the disk state now — any prior stale flag is resolved.
              stale: false,
              saveState: "idle",
              saveError: null,
            }
          })
        )

        return true
      } catch (error) {
        const message = toErrorMessage(error)
        setFileTabs((prev) =>
          prev.map((candidate) =>
            candidate.id === tabId
              ? {
                  ...candidate,
                  saveState: "error",
                  saveError: message,
                }
              : candidate
          )
        )
        return false
      }
    },
    [enqueueExternalConflict, recordSelfWriteEcho, t]
  )

  useEffect(() => {
    saveFileTabRef.current = saveFileTab
  }, [saveFileTab])

  const setFileTabComposing = useCallback(
    (tabId: string, composing: boolean) => {
      if (composing) {
        composingFileTabIdsRef.current.add(tabId)
        return
      }

      composingFileTabIdsRef.current.delete(tabId)
      const deferredOptions = deferredSaveTabsRef.current.get(tabId)
      if (!deferredOptions) return
      deferredSaveTabsRef.current.delete(tabId)
      queueMicrotask(() => {
        void saveFileTabRef.current?.(tabId, deferredOptions)
      })
    },
    []
  )

  const saveActiveFile = useCallback(
    async (options?: { force?: boolean }) => {
      const activeId = activeFileTabIdRef.current
      if (!activeId) return false
      return saveFileTab(activeId, options)
    },
    [saveFileTab]
  )

  const reloadFileTab = useCallback(
    async (tabId: string) => {
      const tab = fileTabsRef.current.find(
        (candidate) => candidate.id === tabId
      )
      if (!tab || tab.kind !== "file" || !tab.path) return
      const tabPath = tab.path
      const io = splitAbsPath(tabPath)
      if (!io) return

      setFileTabs((prev) =>
        prev.map((candidate) =>
          candidate.id === tabId
            ? {
                ...candidate,
                loading: true,
                saveError: null,
                saveState: "idle",
              }
            : candidate
        )
      )

      try {
        const [result, gitBaseContent] = await withTimeout(
          Promise.all([
            readFileForEdit(io.rootPath, io.ioPath),
            fetchGitBase(tabPath),
          ]),
          15_000,
          t("reloadRequestTimedOut")
        )
        setFileTabs((prev) =>
          prev.map((candidate) =>
            candidate.id === tabId
              ? {
                  ...candidate,
                  content: result.content,
                  gitBaseContent: dedupeGitBase(result.content, gitBaseContent),
                  savedContent: result.content,
                  isDirty: false,
                  etag: result.etag,
                  mtimeMs: result.mtime_ms,
                  readonly: result.readonly,
                  lineEnding: result.line_ending,
                  saveState: "idle",
                  saveError: null,
                  loading: false,
                  // A successful reload IS the reconciliation a stale flag
                  // asks for — clearing it here keeps the activation pass
                  // from immediately re-reloading the same tab.
                  stale: false,
                }
              : candidate
          )
        )
      } catch (error) {
        const message = toErrorMessage(error)
        setFileTabs((prev) =>
          prev.map((candidate) =>
            candidate.id === tabId
              ? {
                  ...candidate,
                  loading: false,
                  saveState: "error",
                  saveError: message,
                }
              : candidate
          )
        )
      }
    },
    [fetchGitBase, t]
  )

  const reloadActiveFile = useCallback(async () => {
    const activeId = activeFileTabIdRef.current
    if (!activeId) return
    await reloadFileTab(activeId)
  }, [reloadFileTab])

  const switchFileTab = useCallback(
    (tabId: string) => {
      const activeId = activeFileTabIdRef.current
      if (activeId && activeId !== tabId) {
        void saveFileTab(activeId)
      }
      setActiveFileTabId(tabId)
      activateFilePane()
    },
    [activateFilePane, saveFileTab]
  )

  const closeFileTab = useCallback(
    (tabId: string) => {
      setFileTabs((prev) => {
        const idx = prev.findIndex((tab) => tab.id === tabId)
        if (idx < 0) return prev

        const tab = prev[idx]
        if (isDirtyFileTab(tab)) {
          const confirmed = window.confirm(
            t("confirmCloseDirtyTab", { title: tab.title })
          )
          if (!confirmed) return prev
        }

        // `pushClosedTab` keys on the tab id and moves an existing entry to the
        // top, so recording from inside this updater survives React invoking it
        // more than once (StrictMode, or a discarded render replayed).
        const closed = snapshotFileTab(tab, idx)
        if (closed) pushClosedTab(closed)
        // Idempotent on the backend, so safe under a replayed updater.
        if (tab.kind === "browser") {
          pushClosedTab(closedBrowserTab(tab, idx))
          releaseBrowserTab(tab.id)
        }

        const next = prev.filter((candidate) => candidate.id !== tabId)

        setActiveFileTabId((current) => {
          if (current !== tabId) return current
          if (next.length === 0) {
            activateConversationPane()
            return null
          }
          const nextIdx = Math.min(idx, next.length - 1)
          // Closing the active file tab (via its X) keeps the user in the file
          // column, so focus the files pane — mirroring the conversation
          // closeTab. The section pointer-capture used to do this; the tab strip
          // now sits outside the pane-activation wrapper, so do it explicitly.
          activateFilePane()
          return next[nextIdx].id
        })

        setPreviewFileTabIds((prev) => {
          if (!prev.has(tabId)) return prev
          const updated = new Set(prev)
          updated.delete(tabId)
          return updated
        })

        // Drop any in-flight marker so reopening this path does not get
        // deduped against a now-orphaned fetch.
        inFlightLoadsRef.current.delete(tabId)

        return next
      })
    },
    [activateConversationPane, activateFilePane, t]
  )

  const closeOtherFileTabs = useCallback(
    (tabId: string) => {
      setFileTabs((prev) => {
        const remaining = prev.filter((tab) => tab.id === tabId)
        if (remaining.length === 0) return prev

        const closingTabs = prev.filter((tab) => tab.id !== tabId)
        if (closingTabs.some(isDirtyFileTab)) {
          const confirmed = window.confirm(t("confirmCloseOtherDirtyTabs"))
          if (!confirmed) return prev
        }

        // `pushClosedTab` is idempotent per tab id, which is what makes this
        // safe inside an updater React may invoke more than once.
        const slots = batchCloseSlots(prev, (tab) => tab.id !== tabId)
        for (const [closing, slot] of slots) {
          const closed = snapshotFileTab(closing, slot)
          if (closed) pushClosedTab(closed)
          if (closing.kind === "browser") {
            pushClosedTab(closedBrowserTab(closing, slot))
            releaseBrowserTab(closing.id)
          }
          inFlightLoadsRef.current.delete(closing.id)
        }

        setActiveFileTabId(tabId)
        activateFilePane()
        return remaining
      })
    },
    [activateFilePane, t]
  )

  const closeAllFileTabs = useCallback(() => {
    setFileTabs((prev) => {
      if (prev.some(isDirtyFileTab)) {
        const confirmed = window.confirm(t("confirmCloseAllDirtyTabs"))
        if (!confirmed) return prev
      }

      for (const [tab, slot] of batchCloseSlots(prev)) {
        const closed = snapshotFileTab(tab, slot)
        if (closed) pushClosedTab(closed)
        if (tab.kind === "browser") {
          pushClosedTab(closedBrowserTab(tab, slot))
          releaseBrowserTab(tab.id)
        }
      }

      inFlightLoadsRef.current.clear()
      setActiveFileTabId(null)
      setPreviewFileTabIds(new Set())
      activateConversationPane()
      return []
    })
  }, [activateConversationPane, t])

  const reorderFileTabs = useCallback((tabs: FileWorkspaceTab[]) => {
    setFileTabs(tabs)
  }, [])

  const activeFileTab = useMemo(
    () => fileTabs.find((tab) => tab.id === activeFileTabId) ?? null,
    [fileTabs, activeFileTabId]
  )

  const activeFilePath = activeFileTab?.path ?? null

  useEffect(() => {
    if (!activeFileTabId) return
    const recency = tabRecencyRef.current
    const existingIdx = recency.indexOf(activeFileTabId)
    if (existingIdx >= 0) recency.splice(existingIdx, 1)
    recency.unshift(activeFileTabId)
    // Bounded bookkeeping; anything beyond this is "long unused" anyway.
    if (recency.length > 512) recency.length = 512
  }, [activeFileTabId])

  // Memory guardrail: once hidden clean tabs retain more text than the
  // budget, drop the least-recently-active buffers (content + git base;
  // metadata/etag survive) and flag them stale — activation refetches
  // through the existing stale machinery. Dirty/loading/saving tabs are
  // never touched. Converges in one pass: unloaded tabs hold no content,
  // so they stop being candidates.
  useEffect(() => {
    const candidates = fileTabs
      .filter(
        (tab) =>
          tab.kind === "file" &&
          tab.id !== activeFileTabId &&
          !tab.isDirty &&
          !tab.loading &&
          tab.saveState !== "saving" &&
          tab.content.length > 0
      )
      .map((tab) => ({
        id: tab.id,
        charCount:
          tab.content.length +
          (tab.gitBaseContent && tab.gitBaseContent !== tab.content
            ? tab.gitBaseContent.length
            : 0),
      }))
    if (candidates.length === 0) return
    const recencyRank = new Map(
      tabRecencyRef.current.map((id, index) => [id, index])
    )
    const toUnload = selectTabsToUnload(
      candidates,
      recencyRank,
      HIDDEN_TAB_CONTENT_BUDGET_CHARS
    )
    if (toUnload.size === 0) return

    setFileTabs((prev) =>
      prev.map((tab) => {
        if (!toUnload.has(tab.id) || tab.kind !== "file") return tab
        // Atomic re-check: a keystroke/save enqueued in the same batch
        // must win over the eviction.
        if (tab.isDirty || tab.loading || tab.saveState === "saving") {
          return tab
        }
        return {
          ...tab,
          content: "",
          savedContent: "",
          gitBaseContent: undefined,
          stale: true,
        }
      })
    )
  }, [fileTabs, activeFileTabId])

  // Once the active tab is clean and settled (e.g. the user reloaded, or a
  // successful save resolved the divergence), any conflict recorded for
  // its path is moot — drop it and re-arm the signature dedup.
  useEffect(() => {
    const tab = activeFileTab
    if (!tab || tab.kind !== "file" || !tab.path) return
    if (tab.loading || tab.isDirty) return
    const key = conflictKey(tab.path)
    conflictSignatureByKeyRef.current.delete(key)
    /* eslint-disable react-hooks/set-state-in-effect */
    setExternalConflictQueue((prev) =>
      prev.some((conflict) => conflictKey(conflict.path) === key)
        ? prev.filter((conflict) => conflictKey(conflict.path) !== key)
        : prev
    )
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [activeFileTab])

  // The watcher: per-root FS stream subscriptions derived from the open
  // file tabs' absolute paths (owning registered folders only), lazy
  // background staleness, eager active-tab reconciliation, and
  // stale-on-activation. Owned here (always mounted) so detection works
  // with the aux panel closed and across all folders. Tabs outside every
  // registered folder are not live-watched; they get activation-time
  // freshness checks instead.
  useOpenFileTabsWatch({
    fileTabs,
    fileTabsRef,
    activeFileTabIdRef,
    activeFileTab,
    allFolders,
    openFilePreview,
    reloadOpenFileBackground,
    applyExternalReload,
    markTabsStale,
    markTabsStaleBatch,
    rejectFileTab,
    enqueueExternalConflict,
    consumeSelfWriteEcho,
  })

  const toggleFileTabPreview = useCallback((tabId: string) => {
    setPreviewFileTabIds((prev) => {
      const next = new Set(prev)
      if (next.has(tabId)) {
        next.delete(tabId)
      } else {
        next.add(tabId)
      }
      return next
    })
  }, [])

  // Stable for the provider's lifetime: every callback reads mutable state
  // through refs or functional updaters, never through render-scoped
  // closures, so this memo's inputs only change if a callback identity
  // changes (which none do after mount).
  const actions = useMemo<WorkspaceActionsValue>(
    () => ({
      setActivePane,
      activateConversationPane,
      activateFilePane,
      switchFileTab,
      closeFileTab,
      closeOtherFileTabs,
      closeAllFileTabs,
      reorderFileTabs,
      openFilePreview,
      reloadOpenFileBackground,
      applyExternalReload,
      markTabsStale,
      rejectFileTab,
      consumePendingFileReveal,
      openWorkingTreeDiff,
      openBranchDiff,
      openCommitDiff,
      openSessionFileDiff,
      openExternalConflictDiff,
      updateActiveFileContent,
      updateFileTabContent,
      saveActiveFile,
      setFileTabComposing,
      reloadActiveFile,
      toggleFileTabPreview,
      toggleFilesMaximized,
      openBrowserTab,
      adoptBrowserTab,
      restoreBrowserTabs,
      suspendBrowserTab,
    }),
    [
      setActivePane,
      activateConversationPane,
      activateFilePane,
      switchFileTab,
      closeFileTab,
      closeOtherFileTabs,
      closeAllFileTabs,
      reorderFileTabs,
      openFilePreview,
      reloadOpenFileBackground,
      applyExternalReload,
      markTabsStale,
      rejectFileTab,
      consumePendingFileReveal,
      openWorkingTreeDiff,
      openBranchDiff,
      openCommitDiff,
      openSessionFileDiff,
      openExternalConflictDiff,
      updateActiveFileContent,
      updateFileTabContent,
      saveActiveFile,
      setFileTabComposing,
      reloadActiveFile,
      toggleFileTabPreview,
      toggleFilesMaximized,
      openBrowserTab,
      adoptBrowserTab,
      restoreBrowserTabs,
      suspendBrowserTab,
    ]
  )

  const view = useMemo<WorkspaceViewValue>(
    () => ({
      mode,
      activePane,
      filesMaximized: effectiveFilesMaximized,
    }),
    [mode, activePane, effectiveFilesMaximized]
  )

  const fileTabsValue = useMemo<WorkspaceFileTabsValue>(
    () => ({
      fileTabs,
      activeFileTabId,
      activeFileTab,
      activeFilePath,
      previewFileTabIds,
      pendingFileReveal,
    }),
    [
      fileTabs,
      activeFileTabId,
      activeFileTab,
      activeFilePath,
      previewFileTabIds,
      pendingFileReveal,
    ]
  )

  const externalConflictValue = useMemo<WorkspaceExternalConflictValue>(
    () => ({
      externalConflict: externalConflictQueue[0] ?? null,
      compareExternalConflict,
      reloadExternalConflict,
      saveExternalConflictCopy,
      dismissExternalConflict,
    }),
    [
      externalConflictQueue,
      compareExternalConflict,
      reloadExternalConflict,
      saveExternalConflictCopy,
      dismissExternalConflict,
    ]
  )

  return (
    <WorkspaceActionsContext.Provider value={actions}>
      <WorkspaceViewContext.Provider value={view}>
        <WorkspaceExternalConflictContext.Provider
          value={externalConflictValue}
        >
          <WorkspaceFileTabsContext.Provider value={fileTabsValue}>
            {children}
          </WorkspaceFileTabsContext.Provider>
        </WorkspaceExternalConflictContext.Provider>
      </WorkspaceViewContext.Provider>
    </WorkspaceActionsContext.Provider>
  )
}

// Workspace action callbacks. Value identity is stable for the provider's
// lifetime — subscribing here never re-renders on tab/content churn.
export function useWorkspaceActions(): WorkspaceActionsValue {
  const ctx = useContext(WorkspaceActionsContext)
  if (!ctx) {
    throw new Error("useWorkspaceActions must be used within WorkspaceProvider")
  }
  return ctx
}

/** The actions, or `null` outside a `WorkspaceProvider` — for hooks that can
 *  degrade (the link opener falls back to the system browser). */
export function useOptionalWorkspaceActions(): WorkspaceActionsValue | null {
  return useContext(WorkspaceActionsContext)
}

/** The layout state, or `null` outside a `WorkspaceProvider` — the pair of
 *  `useOptionalWorkspaceActions`, for the same callers. */
export function useOptionalWorkspaceView(): WorkspaceViewValue | null {
  return useContext(WorkspaceViewContext)
}

// Low-frequency layout state (mode / activePane / filesMaximized). Changes
// only on fusion transitions, pane switches, and maximize toggles.
export function useWorkspaceView(): WorkspaceViewValue {
  const ctx = useContext(WorkspaceViewContext)
  if (!ctx) {
    throw new Error("useWorkspaceView must be used within WorkspaceProvider")
  }
  return ctx
}

// Disk-vs-buffer conflict queue head + resolutions. Isolated slice: only
// the always-mounted conflict dialog subscribes, and its value changes
// only when conflicts come and go — never on tab/content churn.
export function useWorkspaceExternalConflict(): WorkspaceExternalConflictValue {
  const ctx = useContext(WorkspaceExternalConflictContext)
  if (!ctx) {
    throw new Error(
      "useWorkspaceExternalConflict must be used within WorkspaceProvider"
    )
  }
  return ctx
}

// High-frequency tab data — changes on every keystroke, load, and
// watcher-driven reload. Only file-pane components should subscribe.
export function useWorkspaceFileTabs(): WorkspaceFileTabsValue {
  const ctx = useContext(WorkspaceFileTabsContext)
  if (!ctx) {
    throw new Error(
      "useWorkspaceFileTabs must be used within WorkspaceProvider"
    )
  }
  return ctx
}

/**
 * Aggregate of all three workspace slices.
 *
 * @deprecated Subscribes to the high-frequency fileTabs slice, so callers
 * re-render on every keystroke and watcher reload. Components on the
 * conversation render path must use `useWorkspaceActions` /
 * `useWorkspaceView` / `useWorkspaceFileTabs` instead.
 */
export function useWorkspaceContext(): WorkspaceContextValue {
  const actions = useWorkspaceActions()
  const view = useWorkspaceView()
  const fileTabs = useWorkspaceFileTabs()
  return useMemo(
    () => ({ ...actions, ...view, ...fileTabs }),
    [actions, view, fileTabs]
  )
}
