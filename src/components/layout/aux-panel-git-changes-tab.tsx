"use client"

import {
  type ReactElement,
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react"
import {
  Archive,
  ArchiveRestore,
  ChevronsDownUp,
  ChevronsUpDown,
  CloudDownload,
  CloudSync,
  CloudUpload,
  GitBranch,
  GitCommitHorizontal,
  Loader2,
  MoreHorizontal,
  PlusCircle,
  RefreshCw,
  Undo2,
} from "lucide-react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import {
  CommitFileAdditions,
  CommitFileChanges,
  CommitFileDeletions,
  CommitFileIcon,
  CommitFileInfo,
  CommitFilePath,
  CommitFileStatus,
} from "@/components/ai-elements/commit"
import {
  FileTree,
  FileTreeFile,
  FileTreeFolder,
} from "@/components/ai-elements/file-tree"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Skeleton } from "@/components/ui/skeleton"
import { useActiveFolder } from "@/contexts/active-folder-context"
import { useTabStore } from "@/contexts/tab-context"
import { useWorkspaceActions } from "@/contexts/workspace-context"
import { useWorkspaceStateStore } from "@/hooks/use-workspace-state-store"
import { useGitQuickActions } from "@/hooks/use-git-quick-actions"
import { useImeGuard } from "@/hooks/use-ime-guard"
import { AuxPanelNoFolderEmpty } from "@/components/layout/aux-panel-no-folder-empty"
import { GIT_TOOLBAR_ICON_BUTTON_CLASS } from "@/components/layout/git-toolbar-controls"
import { WorkspaceDegradedBanner } from "@/components/layout/workspace-degraded-banner"
import {
  deleteFileTreeEntry,
  gitAddFiles,
  gitCommit,
  gitRollbackFile,
  gitStatus,
  openCommitWindow,
} from "@/lib/api"
import { joinFsPath } from "@/lib/path-utils"
import { emitAttachFileToSession } from "@/lib/session-attachment-events"
import type { GitStatusEntry } from "@/lib/types"
import { toErrorMessage } from "@/lib/app-error"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"

interface WorkingTreeChange {
  path: string
  status: string
  additions: number
  deletions: number
}

interface GitActionTarget {
  kind: "file" | "dir"
  path: string
  name: string
}

type DirectoryGitAction =
  | "add"
  | "rollback"
  | "delete-tracked"
  | "delete-untracked"

interface DirectoryGitCandidateEntry {
  path: string
  status: string
}

type ChangeTreeDirNode = {
  kind: "dir"
  name: string
  path: string
  children: ChangeTreeNode[]
  fileCount: number
}

type ChangeTreeFileNode = {
  kind: "file"
  name: string
  path: string
  change: WorkingTreeChange
}

export type ChangeTreeNode = ChangeTreeDirNode | ChangeTreeFileNode

interface MutableChangeTreeDirNode {
  kind: "dir"
  name: string
  path: string
  children: Map<string, MutableChangeTreeDirNode | ChangeTreeFileNode>
}

const TRACKED_ROOT_PATH = "__working_tree_tracked_root__"
const UNTRACKED_ROOT_PATH = "__working_tree_untracked_root__"
const UNTRACKED_STATUS = "??"

type GitFileState =
  | "untracked"
  | "modified"
  | "staged"
  | "conflicted"
  | "deleted"
  | "renamed"

function classifyGitFileState(status: string): GitFileState | null {
  const code = status.trim().toUpperCase()
  if (!code) return null
  if (code === UNTRACKED_STATUS) return "untracked"
  if (code.includes("U")) return "conflicted"
  if (code.includes("R") || code.includes("C")) return "renamed"
  if (code.includes("D")) return "deleted"
  if (code.includes("M") || code.includes("T")) return "modified"
  if (code.includes("A")) return "staged"
  return null
}

function normalizePathSegments(path: string): string[] {
  const normalized = path.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "")
  if (!normalized) return []
  return normalized.split("/").filter(Boolean)
}

function normalizeGitStatusPath(path: string): string {
  const normalized = path.trim().replace(/\/+$/, "")
  const renameSeparator = " -> "
  const renameIndex = normalized.lastIndexOf(renameSeparator)
  if (renameIndex < 0) return normalized
  return normalized.slice(renameIndex + renameSeparator.length).trim()
}

function normalizeComparePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "")
}

function isPathInDirectory(path: string, directoryPath: string): boolean {
  const normalizedPath = normalizeComparePath(path)
  const normalizedDir = normalizeComparePath(directoryPath)
  if (!normalizedDir) return normalizedPath.length > 0
  return (
    normalizedPath === normalizedDir ||
    normalizedPath.startsWith(`${normalizedDir}/`)
  )
}

function scopeGitStatusEntriesForDirectory(
  entries: GitStatusEntry[],
  directoryPath: string
): DirectoryGitCandidateEntry[] {
  const normalizedDirPath = normalizeComparePath(directoryPath)
  const scopedEntries: DirectoryGitCandidateEntry[] = []
  const dedupByPath = new Set<string>()

  for (const entry of entries) {
    const normalizedPath = normalizeComparePath(
      normalizeGitStatusPath(entry.file)
    )
    if (!normalizedPath) continue
    if (!isPathInDirectory(normalizedPath, normalizedDirPath)) continue
    if (normalizedPath === normalizedDirPath) continue
    if (dedupByPath.has(normalizedPath)) continue
    dedupByPath.add(normalizedPath)
    scopedEntries.push({ path: normalizedPath, status: entry.status })
  }

  return scopedEntries.sort((left, right) =>
    left.path.localeCompare(right.path, undefined, { sensitivity: "base" })
  )
}

function isDeleteAction(action: DirectoryGitAction): boolean {
  return action === "delete-tracked" || action === "delete-untracked"
}

function filterDirectoryGitCandidates(
  entries: DirectoryGitCandidateEntry[],
  action: DirectoryGitAction
): DirectoryGitCandidateEntry[] {
  if (action === "add") {
    return entries.filter((entry) => {
      const fileState = classifyGitFileState(entry.status)
      return fileState === "untracked"
    })
  }

  if (action === "delete-tracked") {
    return entries.filter((entry) => {
      const fileState = classifyGitFileState(entry.status)
      return fileState !== null && fileState !== "untracked"
    })
  }

  if (action === "delete-untracked") {
    return entries.filter((entry) => {
      const fileState = classifyGitFileState(entry.status)
      return fileState === "untracked"
    })
  }

  return entries.filter((entry) => {
    const fileState = classifyGitFileState(entry.status)
    return fileState !== "untracked"
  })
}

function toSortedTreeNodes(dir: MutableChangeTreeDirNode): ChangeTreeNode[] {
  return Array.from(dir.children.values())
    .map<ChangeTreeNode>((node) => {
      if (node.kind === "file") return node
      return {
        kind: "dir",
        fileCount: 0,
        name: node.name,
        path: node.path,
        children: toSortedTreeNodes(node),
      }
    })
    .sort((left, right) => {
      if (left.kind !== right.kind) return left.kind === "dir" ? -1 : 1
      return left.name.localeCompare(right.name, undefined, {
        sensitivity: "base",
      })
    })
}

function compressAndAnnotateDir(node: ChangeTreeDirNode): ChangeTreeDirNode {
  let compressedChildren = node.children.map((child) => {
    if (child.kind === "file") return child
    return compressAndAnnotateDir(child)
  })

  let fileCount = compressedChildren.reduce((count, child) => {
    if (child.kind === "file") return count + 1
    return count + child.fileCount
  }, 0)

  let nextNode: ChangeTreeDirNode = {
    ...node,
    children: compressedChildren,
    fileCount,
  }

  while (
    nextNode.children.length === 1 &&
    nextNode.children[0].kind === "dir"
  ) {
    const onlyChild = nextNode.children[0]
    nextNode = {
      kind: "dir",
      name: `${nextNode.name}/${onlyChild.name}`,
      path: onlyChild.path,
      children: onlyChild.children,
      fileCount: onlyChild.fileCount,
    }
  }

  compressedChildren = nextNode.children
  fileCount = compressedChildren.reduce((count, child) => {
    if (child.kind === "file") return count + 1
    return count + child.fileCount
  }, 0)

  return {
    ...nextNode,
    children: compressedChildren,
    fileCount,
  }
}

function buildChangeFileTree(changes: WorkingTreeChange[]): ChangeTreeNode[] {
  const root: MutableChangeTreeDirNode = {
    kind: "dir",
    name: "",
    path: "",
    children: new Map(),
  }

  for (const change of changes) {
    const segments = normalizePathSegments(change.path)
    if (segments.length === 0) continue

    let current = root
    for (const [index, segment] of segments.entries()) {
      const nodePath = segments.slice(0, index + 1).join("/")
      const isLeaf = index === segments.length - 1

      if (isLeaf) {
        current.children.set(`file:${nodePath}`, {
          kind: "file",
          name: segment,
          path: nodePath,
          change,
        })
        continue
      }

      const dirKey = `dir:${nodePath}`
      const existing = current.children.get(dirKey)
      if (existing && existing.kind === "dir") {
        current = existing
        continue
      }

      const nextDir: MutableChangeTreeDirNode = {
        kind: "dir",
        name: segment,
        path: nodePath,
        children: new Map(),
      }
      current.children.set(dirKey, nextDir)
      current = nextDir
    }
  }

  const sortedNodes = toSortedTreeNodes(root)
  return sortedNodes.map((node) => {
    if (node.kind === "file") return node
    return compressAndAnnotateDir(node)
  })
}

function collectExpandedDirectoryPaths(
  nodes: ChangeTreeNode[],
  expanded = new Set<string>()
): Set<string> {
  for (const node of nodes) {
    if (node.kind !== "dir") continue
    expanded.add(node.path)
    collectExpandedDirectoryPaths(node.children, expanded)
  }
  return expanded
}

// A large working tree — a sweeping refactor, generated output, an accidentally
// untracked node_modules — can produce thousands of change rows. Every row is a
// Radix ContextMenu (plus a Collapsible for directories), so mounting the whole
// tree at once freezes the panel for seconds. We render at most this many rows
// per tree and offer a one-click reveal for the remainder, mirroring the
// unified-diff preview cap.
export const MAX_VISIBLE_ROWS = 500

// Count the rows a set of nodes contributes to the mounted DOM given the current
// expansion. Radix Collapsible unmounts a collapsed directory's children, so
// they cost nothing until that directory is expanded.
export function countVisibleChangeRows(
  nodes: ChangeTreeNode[],
  expandedPaths: Set<string>
): number {
  let count = 0
  for (const node of nodes) {
    count += 1
    if (node.kind === "dir" && expandedPaths.has(node.path)) {
      count += countVisibleChangeRows(node.children, expandedPaths)
    }
  }
  return count
}

// Return at most `budget` rows worth of nodes, walking in display order so the
// preview is the top of the tree. Collapsed directories keep their children
// (mounted lazily on expand) but do not consume budget, matching what Radix
// actually renders.
export function capChangeTreeToBudget(
  nodes: ChangeTreeNode[],
  expandedPaths: Set<string>,
  budget: number
): { nodes: ChangeTreeNode[]; remaining: number } {
  const capped: ChangeTreeNode[] = []
  let remaining = budget
  for (const node of nodes) {
    if (remaining <= 0) break
    remaining -= 1
    if (
      node.kind === "dir" &&
      expandedPaths.has(node.path) &&
      node.children.length > 0
    ) {
      const child = capChangeTreeToBudget(
        node.children,
        expandedPaths,
        remaining
      )
      remaining = child.remaining
      capped.push({ ...node, children: child.nodes })
    } else {
      capped.push(node)
    }
  }
  return { nodes: capped, remaining }
}

// A tree row that reveals the change rows hidden by MAX_VISIBLE_ROWS. Rendered
// as a child of the root folder so it inherits the tree indentation and is
// unmounted with the rest of the subtree when the root is collapsed.
function ChangeTreeOverflowRow({
  label,
  onReveal,
}: {
  label: string
  onReveal: () => void
}) {
  return (
    <button
      type="button"
      onClick={onReveal}
      className="flex w-full min-w-full items-center gap-1 rounded px-2 py-1 text-left text-xs text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
    >
      {/* Starts in the same leading column as its sibling rows' first glyph
          (a folder's chevron, a file's status letter or icon). */}
      <span className="truncate">{label}</span>
    </button>
  )
}

function isUntrackedStatus(status: string): boolean {
  return status.trim().toUpperCase() === UNTRACKED_STATUS
}

function mapStatus(
  status: string
): "added" | "modified" | "deleted" | "renamed" {
  const normalized = status.trim().toUpperCase()
  if (normalized.includes("A")) return "added"
  if (normalized.includes("R") || normalized.includes("C")) return "renamed"
  if (normalized.includes("D")) return "deleted"
  return "modified"
}

function canOpenFile(status: string): boolean {
  return !status.trim().toUpperCase().includes("D")
}

export function GitChangesTab() {
  const ime = useImeGuard()
  const t = useTranslations("Folder.gitChangesTab")
  const tCommon = useTranslations("Folder.common")
  const tFileTree = useTranslations("Folder.fileTreeTab")
  // The toolbar's git operations reuse the branch selector's wording verbatim —
  // same actions, so the same labels.
  const tBranch = useTranslations("Folder.branchDropdown")
  // Defer the folder so a cross-folder conversation-tab switch commits first and
  // this tab's heavy rebuild (buildChangeFileTree + auto-expand + up to
  // MAX_VISIBLE_ROWS ContextMenu rows) runs in a non-blocking transition a frame
  // later instead of janking the switch. The change tree derives from the store
  // snapshot (path-keyed), so same-path metadata churn is a no-op.
  const { activeFolder } = useActiveFolder()
  const folder = useDeferredValue(activeFolder)
  // True while the deferred render lags a cross-folder switch. During that gap we
  // render the loading skeleton (below) instead of the PREVIOUS folder's rows:
  // besides keeping the heavy rebuild off the switch commit, unmounting those
  // rows closes any open row ContextMenu (it portals outside this subtree, so an
  // inert wrapper wouldn't reach it) — otherwise a click could route an opener to
  // the NEW active folder (openers default to it when folderId is omitted — see
  // resolveTargetFolder) and open/diff a same-named file under the wrong folder.
  // Clears the instant the deferred render catches up.
  const folderStale = activeFolder?.id !== folder?.id
  const tabs = useTabStore((s) => s.tabs)
  const activeTabId = useTabStore((s) => s.activeTabId)
  const { openFilePreview, openWorkingTreeDiff } = useWorkspaceActions()
  const workspaceState = useWorkspaceStateStore(folder?.path ?? null)

  const [expandedTrackedPaths, setExpandedTrackedPaths] = useState<Set<string>>(
    new Set()
  )
  const [expandedUntrackedPaths, setExpandedUntrackedPaths] = useState<
    Set<string>
  >(new Set())
  const [showAllTracked, setShowAllTracked] = useState(false)
  const [showAllUntracked, setShowAllUntracked] = useState(false)
  const [rollbackTarget, setRollbackTarget] = useState<GitActionTarget | null>(
    null
  )
  const [rollingBack, setRollingBack] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<GitActionTarget | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [directoryGitActionType, setDirectoryGitActionType] =
    useState<DirectoryGitAction | null>(null)
  const [directoryGitActionTarget, setDirectoryGitActionTarget] =
    useState<GitActionTarget | null>(null)
  const [directoryGitCandidates, setDirectoryGitCandidates] = useState<
    DirectoryGitCandidateEntry[]
  >([])
  const [directoryGitSelectedPaths, setDirectoryGitSelectedPaths] = useState<
    Set<string>
  >(new Set())
  const [directoryGitLoading, setDirectoryGitLoading] = useState(false)
  const [directoryGitSubmitting, setDirectoryGitSubmitting] = useState(false)
  const [directoryGitError, setDirectoryGitError] = useState<string | null>(
    null
  )
  const [commitMessage, setCommitMessage] = useState("")
  const [committing, setCommitting] = useState(false)

  const hasHydratedTrackedPaths = useRef(false)
  const hasHydratedUntrackedPaths = useRef(false)
  // Request generation for async dialog loaders: bumped on every folder switch so
  // a folder-A `gitStatus` still in flight can't write its candidates into (or
  // close) a dialog the user has since reopened under folder B.
  const loadGenRef = useRef(0)

  const folderName = useMemo(() => {
    const path = folder?.path ?? ""
    const parts = path.split(/[\\/]/).filter(Boolean)
    return (parts[parts.length - 1] ?? path) || t("workspace")
  }, [folder?.path, t])
  const activeSessionTabId = useMemo(() => {
    const activeTab = tabs.find((tab) => tab.id === activeTabId)
    if (!activeTab || activeTab.kind !== "conversation") return null
    return activeTab.id
  }, [activeTabId, tabs])
  const canAttachToSession = Boolean(activeSessionTabId && folder?.path)

  const changes = useMemo<WorkingTreeChange[]>(() => {
    return [...workspaceState.git]
      .map((entry) => ({
        path: entry.path,
        status: entry.status,
        additions: entry.additions,
        deletions: entry.deletions,
      }))
      .sort((left, right) =>
        left.path.localeCompare(right.path, undefined, { sensitivity: "base" })
      )
  }, [workspaceState.git])

  const loading = useMemo(
    () => workspaceState.health === "resyncing" && workspaceState.seq === 0,
    [workspaceState.health, workspaceState.seq]
  )
  const error =
    workspaceState.health === "degraded" ? workspaceState.error : null

  const trackedChanges = useMemo(
    () => changes.filter((change) => !isUntrackedStatus(change.status)),
    [changes]
  )
  const untrackedChanges = useMemo(
    () => changes.filter((change) => isUntrackedStatus(change.status)),
    [changes]
  )

  const trackedTreeNodes = useMemo(
    () => buildChangeFileTree(trackedChanges),
    [trackedChanges]
  )
  const untrackedTreeNodes = useMemo(
    () => buildChangeFileTree(untrackedChanges),
    [untrackedChanges]
  )

  // Reset the reveal when the change set actually changes. The backend only
  // emits a new git snapshot (hence a new node array) when git status truly
  // changed, so this never thrashes on no-op resyncs — but it does re-cap when
  // a fresh, possibly much larger, change set arrives at the same folder. The
  // `treeChanged` flag also caps this very render (the one that schedules the
  // reset and is then discarded), so the discarded pass never maps the uncapped
  // tree even once.
  const [renderedTrackedNodes, setRenderedTrackedNodes] =
    useState(trackedTreeNodes)
  const trackedTreeChanged = trackedTreeNodes !== renderedTrackedNodes
  if (trackedTreeChanged) {
    setRenderedTrackedNodes(trackedTreeNodes)
    setShowAllTracked(false)
  }
  const effectiveShowAllTracked = showAllTracked && !trackedTreeChanged

  const [renderedUntrackedNodes, setRenderedUntrackedNodes] =
    useState(untrackedTreeNodes)
  const untrackedTreeChanged = untrackedTreeNodes !== renderedUntrackedNodes
  if (untrackedTreeChanged) {
    setRenderedUntrackedNodes(untrackedTreeNodes)
    setShowAllUntracked(false)
  }
  const effectiveShowAllUntracked = showAllUntracked && !untrackedTreeChanged

  // Cap each tree to MAX_VISIBLE_ROWS rows (respecting the current expansion,
  // since collapsed directories are unmounted) so a huge change set never
  // mounts thousands of rows at once. The reveal escape hatch renders in full.
  const trackedRender = useMemo(() => {
    const total = countVisibleChangeRows(trackedTreeNodes, expandedTrackedPaths)
    if (effectiveShowAllTracked || total <= MAX_VISIBLE_ROWS) {
      return { nodes: trackedTreeNodes, hiddenCount: 0 }
    }
    const { nodes } = capChangeTreeToBudget(
      trackedTreeNodes,
      expandedTrackedPaths,
      MAX_VISIBLE_ROWS
    )
    return { nodes, hiddenCount: total - MAX_VISIBLE_ROWS }
  }, [trackedTreeNodes, expandedTrackedPaths, effectiveShowAllTracked])

  const untrackedRender = useMemo(() => {
    const total = countVisibleChangeRows(
      untrackedTreeNodes,
      expandedUntrackedPaths
    )
    if (effectiveShowAllUntracked || total <= MAX_VISIBLE_ROWS) {
      return { nodes: untrackedTreeNodes, hiddenCount: 0 }
    }
    const { nodes } = capChangeTreeToBudget(
      untrackedTreeNodes,
      expandedUntrackedPaths,
      MAX_VISIBLE_ROWS
    )
    return { nodes, hiddenCount: total - MAX_VISIBLE_ROWS }
  }, [untrackedTreeNodes, expandedUntrackedPaths, effectiveShowAllUntracked])

  const allTrackedDirectoryPaths = useMemo(() => {
    const paths = collectExpandedDirectoryPaths(trackedTreeNodes)
    paths.add(TRACKED_ROOT_PATH)
    return paths
  }, [trackedTreeNodes])
  const allUntrackedDirectoryPaths = useMemo(() => {
    const paths = collectExpandedDirectoryPaths(untrackedTreeNodes)
    paths.add(UNTRACKED_ROOT_PATH)
    return paths
  }, [untrackedTreeNodes])

  useEffect(() => {
    hasHydratedTrackedPaths.current = false
    hasHydratedUntrackedPaths.current = false
    setExpandedTrackedPaths(new Set())
    setExpandedUntrackedPaths(new Set())
  }, [folder?.path])

  useEffect(() => {
    setExpandedTrackedPaths((prev) => {
      if (!hasHydratedTrackedPaths.current) {
        if (trackedChanges.length === 0) return prev
        hasHydratedTrackedPaths.current = true
        return new Set(allTrackedDirectoryPaths)
      }

      const next = new Set<string>()
      for (const path of prev) {
        if (allTrackedDirectoryPaths.has(path)) next.add(path)
      }
      return next
    })
  }, [allTrackedDirectoryPaths, trackedChanges.length])

  useEffect(() => {
    setExpandedUntrackedPaths((prev) => {
      if (!hasHydratedUntrackedPaths.current) {
        if (untrackedChanges.length === 0) return prev
        hasHydratedUntrackedPaths.current = true
        return new Set()
      }

      const next = new Set<string>()
      for (const path of prev) {
        if (allUntrackedDirectoryPaths.has(path)) next.add(path)
      }
      return next
    })
  }, [allUntrackedDirectoryPaths, untrackedChanges.length])

  const trackedCanExpand = useMemo(() => {
    if (trackedTreeNodes.length === 0) return false
    for (const path of allTrackedDirectoryPaths) {
      if (!expandedTrackedPaths.has(path)) return true
    }
    return false
  }, [allTrackedDirectoryPaths, expandedTrackedPaths, trackedTreeNodes.length])

  const trackedCanCollapse = useMemo(
    () => trackedTreeNodes.length > 0 && expandedTrackedPaths.size > 0,
    [expandedTrackedPaths.size, trackedTreeNodes.length]
  )

  const untrackedCanExpand = useMemo(() => {
    if (untrackedTreeNodes.length === 0) return false
    for (const path of allUntrackedDirectoryPaths) {
      if (!expandedUntrackedPaths.has(path)) return true
    }
    return false
  }, [
    allUntrackedDirectoryPaths,
    expandedUntrackedPaths,
    untrackedTreeNodes.length,
  ])

  const untrackedCanCollapse = useMemo(
    () => untrackedTreeNodes.length > 0 && expandedUntrackedPaths.size > 0,
    [expandedUntrackedPaths.size, untrackedTreeNodes.length]
  )

  const toggleTrackedExpanded = useCallback(() => {
    if (trackedCanExpand) {
      setExpandedTrackedPaths(new Set(allTrackedDirectoryPaths))
      return
    }
    setExpandedTrackedPaths(new Set())
  }, [allTrackedDirectoryPaths, trackedCanExpand])

  const toggleUntrackedExpanded = useCallback(() => {
    if (untrackedCanExpand) {
      setExpandedUntrackedPaths(new Set(allUntrackedDirectoryPaths))
      return
    }
    setExpandedUntrackedPaths(new Set())
  }, [allUntrackedDirectoryPaths, untrackedCanExpand])

  const handleOpenCommitWindow = useCallback(() => {
    if (!folder) return
    openCommitWindow(folder.id).catch((error) => {
      const message = toErrorMessage(error)
      toast.error(t("toasts.openCommitWindowFailed"), {
        description: message,
      })
    })
  }, [folder, t])

  // Pull / fetch / push / stash for the toolbar's "more" menu, sharing the
  // branch selector's task tracking, credential retry and conflict dialog.
  // A pull or stash rewrites the working tree, so resync the change list
  // directly instead of waiting on the file watcher (and, in server mode, on a
  // `folder://git-branch-changed` that is never delivered — it goes out over
  // the Tauri bridge only).
  const gitActions = useGitQuickActions({
    folderId: folder?.id ?? null,
    folderPath: folder?.path ?? null,
    onCompleted: () => {
      void workspaceState.requestResync("git_action:quick_action")
    },
  })

  // Quick commit takes every TRACKED change — untracked files are never staged
  // implicitly, so an unignored build directory can't ride along.
  const trackedPaths = useMemo(
    () => trackedChanges.map((change) => change.path),
    [trackedChanges]
  )
  const canQuickCommit =
    commitMessage.trim().length > 0 && trackedPaths.length > 0 && !committing

  const handleQuickCommit = useCallback(async () => {
    const message = commitMessage.trim()
    if (!folder || !message || trackedPaths.length === 0 || committing) return

    setCommitting(true)
    try {
      const result = await gitCommit(
        folder.path,
        message,
        trackedPaths,
        folder.id
      )
      setCommitMessage("")
      // `git_commit_core` also broadcasts `folder://git-commit-succeeded`, and
      // every mounted BranchDropdown (one per conversation tile) toasts on it.
      // Keying all of them to the same folder-scoped id makes sonner UPDATE one
      // toast instead of stacking N — while still guaranteeing feedback here
      // when no tile is mounted at all (e.g. the Automations route).
      toast.success(tBranch("toasts.commitCodeCompleted"), {
        id: `git-commit-succeeded:${folder.id}`,
        description: tBranch("toasts.committedFiles", {
          count: result.committed_files,
        }),
      })
      await workspaceState.requestResync("git_action:commit")
    } catch (error) {
      toast.error(t("toasts.commitFailed"), {
        description: toErrorMessage(error),
      })
    } finally {
      setCommitting(false)
    }
  }, [
    commitMessage,
    committing,
    folder,
    t,
    tBranch,
    trackedPaths,
    workspaceState,
  ])
  const handleAttachToSession = useCallback(
    (relativePath: string) => {
      if (!activeSessionTabId || !folder?.path) return
      emitAttachFileToSession({
        tabId: activeSessionTabId,
        path: joinFsPath(folder.path, relativePath),
      })
    },
    [activeSessionTabId, folder?.path]
  )

  const resetDirectoryGitActionDialog = useCallback(() => {
    setDirectoryGitActionType(null)
    setDirectoryGitActionTarget(null)
    setDirectoryGitCandidates([])
    setDirectoryGitSelectedPaths(new Set())
    setDirectoryGitError(null)
    setDirectoryGitLoading(false)
    setDirectoryGitSubmitting(false)
  }, [])

  const openDirectoryGitActionDialog = useCallback(
    async (action: DirectoryGitAction, target: GitActionTarget) => {
      if (!folder?.path) return

      const gen = loadGenRef.current
      setDirectoryGitActionType(action)
      setDirectoryGitActionTarget(target)
      setDirectoryGitCandidates([])
      setDirectoryGitSelectedPaths(new Set())
      setDirectoryGitError(null)
      setDirectoryGitLoading(true)

      try {
        const statusEntries = await gitStatus(folder.path, true)
        // Bail if the folder switched while this request was in flight — writing
        // now would clobber (or, on an empty result, close) a dialog reopened
        // under the new folder.
        if (gen !== loadGenRef.current) return
        const scopedEntries = scopeGitStatusEntriesForDirectory(
          statusEntries,
          target.path
        )
        const candidates = filterDirectoryGitCandidates(scopedEntries, action)

        if (candidates.length === 0) {
          resetDirectoryGitActionDialog()
          toast.info(
            action === "add"
              ? t("toasts.noAddableFilesInDir")
              : isDeleteAction(action)
                ? t("toasts.noDeletableFilesInDir")
                : t("toasts.noRollbackFilesInDir")
          )
          return
        }

        setDirectoryGitCandidates(candidates)
        setDirectoryGitSelectedPaths(
          new Set(candidates.map((entry) => entry.path))
        )
      } catch (error) {
        // Same generation guard on the error path: a stale folder-A rejection
        // must not write its error into (nor toggle the loading of) a dialog
        // reopened under folder B.
        if (gen !== loadGenRef.current) return
        const message = toErrorMessage(error)
        setDirectoryGitError(message)
      } finally {
        if (gen === loadGenRef.current) setDirectoryGitLoading(false)
      }
    },
    [folder?.path, resetDirectoryGitActionDialog, t]
  )

  const handleRequestRollback = useCallback(
    (target: GitActionTarget) => {
      if (target.kind === "dir") {
        void openDirectoryGitActionDialog("rollback", target)
        return
      }
      setRollbackTarget(target)
    },
    [openDirectoryGitActionDialog]
  )

  const handleAddToVcs = useCallback(
    async (target: GitActionTarget) => {
      if (target.kind === "dir") {
        await openDirectoryGitActionDialog("add", target)
        return
      }

      if (!folder?.path) return
      try {
        await gitAddFiles(folder.path, [target.path])
        toast.success(t("toasts.addedToVcs", { name: target.name }))
        await workspaceState.requestResync("git_action:add")
      } catch (error) {
        const message = toErrorMessage(error)
        toast.error(t("toasts.addToVcsFailed"), { description: message })
      }
    },
    [folder?.path, openDirectoryGitActionDialog, t, workspaceState]
  )

  const handleRollbackConfirm = useCallback(async () => {
    if (!folder?.path || !rollbackTarget) return

    setRollingBack(true)
    try {
      await gitRollbackFile(folder.path, rollbackTarget.path)
      toast.success(t("toasts.rolledBack", { name: rollbackTarget.name }))
      setRollbackTarget(null)
      await workspaceState.requestResync("git_action:rollback")
    } catch (error) {
      const message = toErrorMessage(error)
      toast.error(t("toasts.rollbackFailed"), { description: message })
    } finally {
      setRollingBack(false)
    }
  }, [folder?.path, rollbackTarget, t, workspaceState])

  const handleRequestDelete = useCallback(
    (target: GitActionTarget, scope: "tracked" | "untracked") => {
      if (target.kind === "dir") {
        void openDirectoryGitActionDialog(
          scope === "tracked" ? "delete-tracked" : "delete-untracked",
          target
        )
        return
      }
      setDeleteTarget(target)
    },
    [openDirectoryGitActionDialog]
  )

  const handleDeleteConfirm = useCallback(async () => {
    if (!folder?.path || !deleteTarget) return

    setDeleting(true)
    try {
      await deleteFileTreeEntry(folder.path, deleteTarget.path)
      toast.success(t("toasts.deleted", { name: deleteTarget.name }))
      setDeleteTarget(null)
      await workspaceState.requestResync("git_action:delete")
    } catch (error) {
      const message = toErrorMessage(error)
      toast.error(t("toasts.deleteFailed"), { description: message })
    } finally {
      setDeleting(false)
    }
  }, [deleteTarget, folder?.path, t, workspaceState])

  const directoryGitAllFilePaths = useMemo(
    () => directoryGitCandidates.map((entry) => entry.path),
    [directoryGitCandidates]
  )

  const directoryGitAllSelected = useMemo(
    () =>
      directoryGitAllFilePaths.length > 0 &&
      directoryGitAllFilePaths.every((path) =>
        directoryGitSelectedPaths.has(path)
      ),
    [directoryGitAllFilePaths, directoryGitSelectedPaths]
  )

  const handleToggleDirectoryGitSelectAll = useCallback(() => {
    setDirectoryGitSelectedPaths((prev) => {
      const next = new Set(prev)
      const allSelected =
        directoryGitAllFilePaths.length > 0 &&
        directoryGitAllFilePaths.every((path) => next.has(path))
      if (allSelected) {
        return new Set<string>()
      }
      return new Set(directoryGitAllFilePaths)
    })
  }, [directoryGitAllFilePaths])

  const handleToggleDirectoryGitFile = useCallback((path: string) => {
    setDirectoryGitSelectedPaths((prev) => {
      const next = new Set(prev)
      if (next.has(path)) {
        next.delete(path)
      } else {
        next.add(path)
      }
      return next
    })
  }, [])

  const handleDirectoryGitActionConfirm = useCallback(async () => {
    if (!folder?.path || !directoryGitActionType) return
    if (directoryGitSelectedPaths.size === 0) return

    const selectedPaths = Array.from(directoryGitSelectedPaths)
    setDirectoryGitSubmitting(true)
    setDirectoryGitError(null)

    try {
      if (directoryGitActionType === "add") {
        await gitAddFiles(folder.path, selectedPaths)
        toast.success(
          t("toasts.addedFilesToVcs", {
            count: selectedPaths.length,
          })
        )
      } else if (isDeleteAction(directoryGitActionType)) {
        for (const filePath of selectedPaths) {
          await deleteFileTreeEntry(folder.path, filePath)
        }
        toast.success(
          t("toasts.deletedFiles", {
            count: selectedPaths.length,
          })
        )
      } else {
        for (const filePath of selectedPaths) {
          await gitRollbackFile(folder.path, filePath)
        }
        toast.success(
          t("toasts.rolledBackFiles", {
            count: selectedPaths.length,
          })
        )
      }

      resetDirectoryGitActionDialog()
      await workspaceState.requestResync("git_action:batch")
    } catch (error) {
      const message = toErrorMessage(error)
      setDirectoryGitError(message)
      toast.error(
        directoryGitActionType === "add"
          ? t("toasts.addToVcsFailed")
          : isDeleteAction(directoryGitActionType)
            ? t("toasts.deleteFailed")
            : t("toasts.rollbackFailed"),
        {
          description: message,
        }
      )
    } finally {
      setDirectoryGitSubmitting(false)
    }
  }, [
    directoryGitActionType,
    directoryGitSelectedPaths,
    folder?.path,
    resetDirectoryGitActionDialog,
    t,
    workspaceState,
  ])

  // Close in-panel dialogs the instant the ACTIVE folder changes (keyed on the
  // live id, not the deferred `folder?.path`) so a dialog opened under the
  // previous folder can't act (delete / rollback / batch) against the new one
  // after the deferred render settles and the dialog re-mounts. The draft commit
  // message is dropped for the same reason: it describes the PREVIOUS folder's
  // changes and must not be committable against the new one.
  useEffect(() => {
    loadGenRef.current++
    setRollbackTarget(null)
    setDeleteTarget(null)
    setCommitMessage("")
    resetDirectoryGitActionDialog()
  }, [activeFolder?.id, resetDirectoryGitActionDialog])

  const renderTrackedNode = useCallback(
    function renderNode(node: ChangeTreeNode): ReactElement {
      if (node.kind === "dir") {
        const target: GitActionTarget = {
          kind: "dir",
          path: node.path,
          name: node.name,
        }

        return (
          <ContextMenu key={`tracked:${node.path}`}>
            <ContextMenuTrigger>
              <FileTreeFolder
                path={node.path}
                name={node.name}
                suffix={`(${node.fileCount})`}
                suffixClassName="text-muted-foreground/45"
                title={node.path}
              >
                {/* Build children only when expanded: Radix unmounts a
                    collapsed folder's children anyway, and skipping the eager
                    recursion keeps a huge collapsed subtree from constructing
                    thousands of elements on every render. */}
                {expandedTrackedPaths.has(node.path)
                  ? node.children.map(renderNode)
                  : null}
              </FileTreeFolder>
            </ContextMenuTrigger>
            <ContextMenuContent>
              <ContextMenuItem
                onSelect={() => {
                  handleOpenCommitWindow()
                }}
              >
                {t("actions.commitCode")}
              </ContextMenuItem>
              <ContextMenuItem
                onSelect={() => {
                  void openWorkingTreeDiff(node.path, { mode: "overview" })
                }}
              >
                {tCommon("viewDiff")}
              </ContextMenuItem>
              <ContextMenuItem
                onSelect={() => {
                  handleAttachToSession(node.path)
                }}
                disabled={!canAttachToSession}
              >
                {tFileTree("attachToCurrentSession")}
              </ContextMenuItem>
              <ContextMenuItem disabled>
                {t("actions.addToVcs")}
              </ContextMenuItem>
              <ContextMenuItem
                onSelect={() => {
                  handleRequestRollback(target)
                }}
                variant="destructive"
              >
                {t("actions.rollback")}
              </ContextMenuItem>
              <ContextMenuItem
                onSelect={() => {
                  handleRequestDelete(target, "tracked")
                }}
                variant="destructive"
              >
                {t("actions.delete")}
              </ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu>
        )
      }

      const file = node.change
      const canOpenCurrentFile = canOpenFile(file.status)
      const target: GitActionTarget = {
        kind: "file",
        path: file.path,
        name: node.name,
      }

      return (
        <ContextMenu key={`tracked:${file.path}`}>
          <ContextMenuTrigger>
            <FileTreeFile
              className="w-full min-w-0 cursor-pointer"
              name={node.name}
              onClick={() => {
                void openWorkingTreeDiff(file.path)
              }}
              path={node.path}
              title={file.path}
            >
              <>
                {/* The status letter is this row's LEADING glyph, sitting in
                    the same column as a sibling folder's chevron — no spacer
                    in front of it, or every file would hang one glyph right of
                    the directory it lives in. */}
                <CommitFileInfo className="flex-1 min-w-0 gap-1.5">
                  <CommitFileStatus status={mapStatus(file.status)}>
                    {file.status}
                  </CommitFileStatus>
                  <CommitFileIcon />
                  <CommitFilePath title={file.path}>{node.name}</CommitFilePath>
                </CommitFileInfo>
                <CommitFileChanges>
                  <CommitFileAdditions count={file.additions} />
                  <CommitFileDeletions count={file.deletions} />
                </CommitFileChanges>
              </>
            </FileTreeFile>
          </ContextMenuTrigger>
          <ContextMenuContent>
            <ContextMenuItem
              onSelect={() => {
                handleOpenCommitWindow()
              }}
            >
              {t("actions.commitCode")}
            </ContextMenuItem>
            <ContextMenuItem
              disabled={!canOpenCurrentFile}
              onSelect={() => {
                if (!canOpenCurrentFile) return
                void openFilePreview(file.path)
              }}
            >
              {tCommon("openFile")}
            </ContextMenuItem>
            <ContextMenuItem
              onSelect={() => {
                void openWorkingTreeDiff(file.path)
              }}
            >
              {tCommon("viewDiff")}
            </ContextMenuItem>
            <ContextMenuItem
              onSelect={() => {
                handleAttachToSession(file.path)
              }}
              disabled={!canAttachToSession}
            >
              {tFileTree("attachToCurrentSession")}
            </ContextMenuItem>
            <ContextMenuItem disabled>{t("actions.addToVcs")}</ContextMenuItem>
            <ContextMenuItem
              onSelect={() => {
                handleRequestRollback(target)
              }}
              variant="destructive"
            >
              {t("actions.rollback")}
            </ContextMenuItem>
            <ContextMenuItem
              onSelect={() => {
                handleRequestDelete(target, "tracked")
              }}
              variant="destructive"
            >
              {t("actions.delete")}
            </ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
      )
    },
    [
      canAttachToSession,
      expandedTrackedPaths,
      handleAttachToSession,
      handleOpenCommitWindow,
      handleRequestDelete,
      handleRequestRollback,
      openFilePreview,
      openWorkingTreeDiff,
      t,
      tCommon,
      tFileTree,
    ]
  )

  const renderUntrackedNode = useCallback(
    function renderNode(node: ChangeTreeNode): ReactElement {
      if (node.kind === "dir") {
        const target: GitActionTarget = {
          kind: "dir",
          path: node.path,
          name: node.name,
        }

        return (
          <ContextMenu key={`untracked:${node.path}`}>
            <ContextMenuTrigger>
              <FileTreeFolder
                path={node.path}
                name={node.name}
                suffix={`(${node.fileCount})`}
                suffixClassName="text-muted-foreground/45"
                title={node.path}
              >
                {/* Build children only when expanded: Radix unmounts a
                    collapsed folder's children anyway, and skipping the eager
                    recursion keeps a huge collapsed subtree from constructing
                    thousands of elements on every render. */}
                {expandedUntrackedPaths.has(node.path)
                  ? node.children.map(renderNode)
                  : null}
              </FileTreeFolder>
            </ContextMenuTrigger>
            <ContextMenuContent>
              <ContextMenuItem
                onSelect={() => {
                  handleOpenCommitWindow()
                }}
              >
                {t("actions.commitCode")}
              </ContextMenuItem>
              <ContextMenuItem
                onSelect={() => {
                  void openWorkingTreeDiff(node.path, { mode: "overview" })
                }}
              >
                {tCommon("viewDiff")}
              </ContextMenuItem>
              <ContextMenuItem
                onSelect={() => {
                  handleAttachToSession(node.path)
                }}
                disabled={!canAttachToSession}
              >
                {tFileTree("attachToCurrentSession")}
              </ContextMenuItem>
              <ContextMenuItem
                onSelect={() => {
                  void handleAddToVcs(target)
                }}
              >
                {t("actions.addToVcs")}
              </ContextMenuItem>
              <ContextMenuItem
                onSelect={() => {
                  handleRequestRollback(target)
                }}
                variant="destructive"
              >
                {t("actions.rollback")}
              </ContextMenuItem>
              <ContextMenuItem
                onSelect={() => {
                  handleRequestDelete(target, "untracked")
                }}
                variant="destructive"
              >
                {t("actions.delete")}
              </ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu>
        )
      }

      const file = node.change
      const target: GitActionTarget = {
        kind: "file",
        path: file.path,
        name: node.name,
      }

      return (
        <ContextMenu key={`untracked:${file.path}`}>
          <ContextMenuTrigger>
            <FileTreeFile
              className="w-full min-w-0 cursor-pointer"
              name={node.name}
              onClick={() => {
                void openWorkingTreeDiff(file.path)
              }}
              path={node.path}
              title={file.path}
            >
              <>
                {/* Untracked rows carry no status letter, so the file icon is
                    the leading glyph and lines up with a sibling folder's
                    chevron. See the tracked renderer above. */}
                <CommitFileInfo className="flex-1 min-w-0 gap-1.5">
                  <CommitFileIcon />
                  <CommitFilePath title={file.path}>{node.name}</CommitFilePath>
                </CommitFileInfo>
              </>
            </FileTreeFile>
          </ContextMenuTrigger>
          <ContextMenuContent>
            <ContextMenuItem
              onSelect={() => {
                handleOpenCommitWindow()
              }}
            >
              {t("actions.commitCode")}
            </ContextMenuItem>
            <ContextMenuItem
              onSelect={() => {
                void openFilePreview(file.path)
              }}
            >
              {tCommon("openFile")}
            </ContextMenuItem>
            <ContextMenuItem
              onSelect={() => {
                void openWorkingTreeDiff(file.path)
              }}
            >
              {tCommon("viewDiff")}
            </ContextMenuItem>
            <ContextMenuItem
              onSelect={() => {
                handleAttachToSession(file.path)
              }}
              disabled={!canAttachToSession}
            >
              {tFileTree("attachToCurrentSession")}
            </ContextMenuItem>
            <ContextMenuItem
              onSelect={() => {
                void handleAddToVcs(target)
              }}
            >
              {t("actions.addToVcs")}
            </ContextMenuItem>
            <ContextMenuItem
              onSelect={() => {
                handleRequestRollback(target)
              }}
              variant="destructive"
            >
              {t("actions.rollback")}
            </ContextMenuItem>
            <ContextMenuItem
              onSelect={() => {
                handleRequestDelete(target, "untracked")
              }}
              variant="destructive"
            >
              {t("actions.delete")}
            </ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
      )
    },
    [
      canAttachToSession,
      expandedUntrackedPaths,
      handleAttachToSession,
      handleOpenCommitWindow,
      handleAddToVcs,
      handleRequestDelete,
      handleRequestRollback,
      openFilePreview,
      openWorkingTreeDiff,
      t,
      tCommon,
      tFileTree,
    ]
  )

  if (!folder) {
    return <AuxPanelNoFolderEmpty />
  }

  // `folderStale`: skeleton over the previous folder's rows while the deferred
  // render catches up to the switch (see the declaration above).
  if (loading || folderStale) {
    return (
      <div className="p-2 space-y-2">
        <Skeleton className="h-6 w-full" />
        <Skeleton className="h-4 w-3/4" />
        <Skeleton className="h-4 w-1/2" />
        <Skeleton className="h-4 w-2/3" />
      </div>
    )
  }

  if (error) {
    return (
      <div className="p-2 text-xs text-destructive">
        <p>{error}</p>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Toolbar: type a message and commit right here with Enter, or reach the
          same git operations the branch selector offers. Just a text field and
          one round "more" circle — no commit button: Enter is the submit (the
          placeholder says so) and the menu's "commit code" row opens the full
          commit window, so a dedicated button would only repeat what both
          already do. The circle matches the commits tab's header, so the two
          tabs read as one panel. Hidden on a non-repo folder — there is nothing
          to commit to (the body shows the "not a repo" hint). */}
      {workspaceState.isGitRepo && (
        <div className="flex h-10 shrink-0 items-center gap-1 border-b border-border/50 px-2">
          <Input
            value={commitMessage}
            onChange={(event) => setCommitMessage(event.target.value)}
            {...ime.props}
            onKeyDown={(event) => {
              // Never submit mid-IME-composition: a CJK candidate is confirmed
              // with Enter, which must not also fire the commit.
              if (ime.isComposing(event)) return
              if (event.key === "Enter" && canQuickCommit) {
                event.preventDefault()
                void handleQuickCommit()
              }
            }}
            disabled={committing}
            placeholder={t("quickCommit.placeholder")}
            aria-label={t("quickCommit.placeholder")}
            className="h-8 min-w-0 flex-1 border-0 bg-transparent px-1.5 text-xs shadow-none focus-visible:ring-0"
          />
          {/* With no button to grey out, this is the only sign a commit is in
              flight besides the disabled field — so it stays. */}
          {committing && (
            <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className={GIT_TOOLBAR_ICON_BUTTON_CLASS}
                title={t("actions.moreActions")}
                aria-label={t("actions.moreActions")}
              >
                <MoreHorizontal className="size-3.5" />
              </Button>
            </DropdownMenuTrigger>
            {/* Blocked like the branch selector's operation list: incoming |
                outgoing | stash | working tree | refresh. */}
            <DropdownMenuContent align="end" className="w-56">
              <DropdownMenuItem
                disabled={gitActions.running}
                onSelect={gitActions.pull}
              >
                <CloudDownload />
                {tBranch("pullCode")}
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={gitActions.running}
                onSelect={gitActions.fetchAll}
              >
                <CloudSync />
                {tBranch("fetchRemoteBranches")}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={handleOpenCommitWindow}>
                <GitCommitHorizontal />
                {tBranch("openCommitWindow")}
              </DropdownMenuItem>
              {/* Wrapped, not passed bare: onSelect hands the handler an Event,
                  which openPushWindow would read as the branch to push. */}
              <DropdownMenuItem onSelect={() => gitActions.openPushWindow()}>
                <CloudUpload />
                {tBranch("pushCode")}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={gitActions.openStashDialog}>
                <Archive />
                {tBranch("stashChanges")}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={gitActions.openUnstashWindow}>
                <ArchiveRestore />
                {tBranch("stashPop")}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              {/* Both fan out to the existing file-picker dialog, so neither is
                  a blind bulk write. */}
              <DropdownMenuItem
                disabled={untrackedChanges.length === 0}
                onSelect={() => {
                  void handleAddToVcs({
                    kind: "dir",
                    path: "",
                    name: folderName,
                  })
                }}
              >
                <PlusCircle />
                {t("actions.addAllToVcs")}
              </DropdownMenuItem>
              <DropdownMenuItem
                variant="destructive"
                disabled={trackedChanges.length === 0}
                onSelect={() => {
                  handleRequestRollback({
                    kind: "dir",
                    path: "",
                    name: folderName,
                  })
                }}
              >
                <Undo2 />
                {t("actions.rollbackAll")}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onSelect={() => {
                  void workspaceState.requestResync("git_action:manual_refresh")
                }}
              >
                <RefreshCw />
                {t("actions.refresh")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      )}
      {workspaceState.degraded && (
        <WorkspaceDegradedBanner onRetry={workspaceState.restart} />
      )}
      <ScrollArea className="flex-1 min-h-0" x="scroll">
        {trackedChanges.length === 0 && untrackedChanges.length === 0 ? (
          !workspaceState.isGitRepo ? (
            <div className="flex flex-col items-center justify-center h-full gap-1 p-6 text-center">
              <GitBranch
                className="size-5 text-muted-foreground/60"
                aria-hidden
              />
              <p className="text-sm font-medium">{t("notAGitRepoTitle")}</p>
              <p className="text-xs text-muted-foreground">
                {t("notAGitRepoHint")}
              </p>
            </div>
          ) : (
            <div className="flex items-center justify-center h-full p-4">
              <p className="text-xs text-muted-foreground text-center">
                {t("noChanges")}
              </p>
            </div>
          )
        ) : (
          <div className="space-y-2 pb-2">
            {trackedChanges.length > 0 && (
              <section className="space-y-1">
                {/* px-3.5 lines this row up with the toolbar above rather than
                    with the panel edge: the label lands on the 14px guide the
                    commit field's placeholder sits on (8px bar padding + the
                    field's own 6px), and the 14px chevron — inset 3px inside its
                    20px button — ends 17px from the right, exactly where the
                    toolbar's "more" glyph ends (8px + the 9px inset of a 14px
                    glyph in a 32px circle). */}
                <div className="flex items-center justify-between px-3.5 py-1 text-2xs text-muted-foreground">
                  <span>
                    {t("trackedChanges", { count: trackedChanges.length })}
                  </span>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-5"
                    onClick={toggleTrackedExpanded}
                    disabled={!trackedCanExpand && !trackedCanCollapse}
                    title={
                      trackedCanExpand
                        ? t("expandTracked")
                        : t("collapseTracked")
                    }
                    aria-label={
                      trackedCanExpand
                        ? t("expandTracked")
                        : t("collapseTracked")
                    }
                  >
                    {trackedCanExpand ? (
                      <ChevronsUpDown className="size-3.5" />
                    ) : (
                      <ChevronsDownUp className="size-3.5" />
                    )}
                  </Button>
                </div>
                <FileTree
                  className="rounded-none border-0 bg-transparent text-xs [&>div]:p-0"
                  expanded={expandedTrackedPaths}
                  onExpandedChange={setExpandedTrackedPaths}
                >
                  <ContextMenu>
                    <ContextMenuTrigger>
                      <FileTreeFolder
                        path={TRACKED_ROOT_PATH}
                        name={folderName}
                        suffix={`(${trackedChanges.length})`}
                        suffixClassName="text-muted-foreground/45"
                        title={folderName}
                      >
                        {trackedRender.nodes.map(renderTrackedNode)}
                        {trackedRender.hiddenCount > 0 && (
                          <ChangeTreeOverflowRow
                            label={t("showRemainingItems", {
                              count: trackedRender.hiddenCount,
                            })}
                            onReveal={() => setShowAllTracked(true)}
                          />
                        )}
                      </FileTreeFolder>
                    </ContextMenuTrigger>
                    <ContextMenuContent>
                      <ContextMenuItem
                        onSelect={() => {
                          handleOpenCommitWindow()
                        }}
                      >
                        {t("actions.commitCode")}
                      </ContextMenuItem>
                      <ContextMenuItem
                        onSelect={() => {
                          void openWorkingTreeDiff(".", {
                            mode: "overview",
                          })
                        }}
                      >
                        {tCommon("viewDiff")}
                      </ContextMenuItem>
                      <ContextMenuItem
                        onSelect={() => {
                          handleAttachToSession("")
                        }}
                        disabled={!canAttachToSession}
                      >
                        {tFileTree("attachToCurrentSession")}
                      </ContextMenuItem>
                      <ContextMenuItem disabled>
                        {t("actions.addToVcs")}
                      </ContextMenuItem>
                      <ContextMenuItem
                        onSelect={() => {
                          handleRequestRollback({
                            kind: "dir",
                            path: "",
                            name: folderName,
                          })
                        }}
                        variant="destructive"
                      >
                        {t("actions.rollback")}
                      </ContextMenuItem>

                      <ContextMenuItem
                        onSelect={() => {
                          handleRequestDelete(
                            {
                              kind: "dir",
                              path: "",
                              name: folderName,
                            },
                            "tracked"
                          )
                        }}
                        variant="destructive"
                      >
                        {t("actions.delete")}
                      </ContextMenuItem>
                    </ContextMenuContent>
                  </ContextMenu>
                </FileTree>
              </section>
            )}

            {untrackedChanges.length > 0 && (
              <section className="space-y-1">
                {/* px-3.5 for the same alignment as the tracked header above. */}
                <div className="flex items-center justify-between px-3.5 py-1 text-2xs text-muted-foreground">
                  <span>
                    {t("untrackedFiles", { count: untrackedChanges.length })}
                  </span>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-5"
                    onClick={toggleUntrackedExpanded}
                    disabled={!untrackedCanExpand && !untrackedCanCollapse}
                    title={
                      untrackedCanExpand
                        ? t("expandUntracked")
                        : t("collapseUntracked")
                    }
                    aria-label={
                      untrackedCanExpand
                        ? t("expandUntracked")
                        : t("collapseUntracked")
                    }
                  >
                    {untrackedCanExpand ? (
                      <ChevronsUpDown className="size-3.5" />
                    ) : (
                      <ChevronsDownUp className="size-3.5" />
                    )}
                  </Button>
                </div>
                <FileTree
                  className="rounded-none border-0 bg-transparent text-xs [&>div]:p-0"
                  expanded={expandedUntrackedPaths}
                  onExpandedChange={setExpandedUntrackedPaths}
                >
                  <ContextMenu>
                    <ContextMenuTrigger>
                      <FileTreeFolder
                        path={UNTRACKED_ROOT_PATH}
                        name={folderName}
                        suffix={`(${untrackedChanges.length})`}
                        suffixClassName="text-muted-foreground/45"
                        title={folderName}
                      >
                        {untrackedRender.nodes.map(renderUntrackedNode)}
                        {untrackedRender.hiddenCount > 0 && (
                          <ChangeTreeOverflowRow
                            label={t("showRemainingItems", {
                              count: untrackedRender.hiddenCount,
                            })}
                            onReveal={() => setShowAllUntracked(true)}
                          />
                        )}
                      </FileTreeFolder>
                    </ContextMenuTrigger>
                    <ContextMenuContent>
                      <ContextMenuItem
                        onSelect={() => {
                          handleOpenCommitWindow()
                        }}
                      >
                        {t("actions.commitCode")}
                      </ContextMenuItem>
                      <ContextMenuItem
                        onSelect={() => {
                          void openWorkingTreeDiff(".", {
                            mode: "overview",
                          })
                        }}
                      >
                        {tCommon("viewDiff")}
                      </ContextMenuItem>
                      <ContextMenuItem
                        onSelect={() => {
                          handleAttachToSession("")
                        }}
                        disabled={!canAttachToSession}
                      >
                        {tFileTree("attachToCurrentSession")}
                      </ContextMenuItem>
                      <ContextMenuItem
                        onSelect={() => {
                          void handleAddToVcs({
                            kind: "dir",
                            path: "",
                            name: folderName,
                          })
                        }}
                      >
                        {t("actions.addToVcs")}
                      </ContextMenuItem>
                      <ContextMenuItem
                        onSelect={() => {
                          handleRequestRollback({
                            kind: "dir",
                            path: "",
                            name: folderName,
                          })
                        }}
                        variant="destructive"
                      >
                        {t("actions.rollback")}
                      </ContextMenuItem>
                      <ContextMenuItem
                        onSelect={() => {
                          handleRequestDelete(
                            {
                              kind: "dir",
                              path: "",
                              name: folderName,
                            },
                            "untracked"
                          )
                        }}
                        variant="destructive"
                      >
                        {t("actions.delete")}
                      </ContextMenuItem>
                    </ContextMenuContent>
                  </ContextMenu>
                </FileTree>
              </section>
            )}
          </div>
        )}
      </ScrollArea>

      <Dialog
        open={Boolean(directoryGitActionType && directoryGitActionTarget)}
        onOpenChange={(open) => {
          if (open) return
          resetDirectoryGitActionDialog()
        }}
      >
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              {directoryGitActionType === "add"
                ? t("actions.addToVcs")
                : directoryGitActionType &&
                    isDeleteAction(directoryGitActionType)
                  ? t("actions.delete")
                  : t("actions.rollback")}
            </DialogTitle>
            <DialogDescription>
              {directoryGitActionTarget
                ? directoryGitActionType === "add"
                  ? t("directoryDialog.descriptionAdd", {
                      path: directoryGitActionTarget.path,
                    })
                  : directoryGitActionType &&
                      isDeleteAction(directoryGitActionType)
                    ? t("directoryDialog.descriptionDelete", {
                        path: directoryGitActionTarget.path,
                      })
                    : t("directoryDialog.descriptionRollback", {
                        path: directoryGitActionTarget.path,
                      })
                : t("directoryDialog.descriptionFallback")}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-2 text-xs">
              <span className="text-muted-foreground">
                {t("directoryDialog.selectionCount", {
                  selected: directoryGitSelectedPaths.size,
                  total: directoryGitAllFilePaths.length,
                })}
              </span>
              <Button
                type="button"
                size="xs"
                variant="outline"
                disabled={directoryGitLoading || directoryGitSubmitting}
                onClick={handleToggleDirectoryGitSelectAll}
              >
                {directoryGitAllSelected
                  ? t("directoryDialog.unselectAll")
                  : t("directoryDialog.selectAll")}
              </Button>
            </div>
            <div className="max-h-80 overflow-auto rounded-md border">
              {directoryGitLoading ? (
                <div className="py-8 text-center text-xs text-muted-foreground">
                  {t("directoryDialog.loadingCandidates")}
                </div>
              ) : directoryGitError ? (
                <div className="p-3 text-xs text-destructive">
                  {directoryGitError}
                </div>
              ) : directoryGitCandidates.length > 0 ? (
                <div className="divide-y">
                  {directoryGitCandidates.map((entry) => {
                    const selected = directoryGitSelectedPaths.has(entry.path)
                    return (
                      <button
                        key={entry.path}
                        type="button"
                        className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs hover:bg-muted/40"
                        onClick={() => {
                          handleToggleDirectoryGitFile(entry.path)
                        }}
                        disabled={directoryGitSubmitting}
                      >
                        <span
                          className={
                            selected
                              ? "flex h-4 w-4 shrink-0 items-center justify-center rounded border border-primary bg-primary text-3xs text-primary-foreground"
                              : "flex h-4 w-4 shrink-0 items-center justify-center rounded border border-input"
                          }
                          aria-hidden
                        >
                          {selected ? "✓" : ""}
                        </span>
                        <span className="flex-1 truncate" title={entry.path}>
                          {entry.path}
                        </span>
                        {entry.status !== UNTRACKED_STATUS && (
                          <span className="shrink-0 text-muted-foreground">
                            {entry.status}
                          </span>
                        )}
                      </button>
                    )
                  })}
                </div>
              ) : (
                <div className="py-8 text-center text-xs text-muted-foreground">
                  {t("directoryDialog.noOperableFiles")}
                </div>
              )}
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                disabled={directoryGitSubmitting}
                onClick={resetDirectoryGitActionDialog}
              >
                {tCommon("cancel")}
              </Button>
              <Button
                type="button"
                variant={
                  directoryGitActionType === "rollback" ||
                  (directoryGitActionType &&
                    isDeleteAction(directoryGitActionType))
                    ? "destructive"
                    : "default"
                }
                disabled={
                  directoryGitLoading ||
                  directoryGitSubmitting ||
                  directoryGitSelectedPaths.size === 0
                }
                onClick={() => {
                  void handleDirectoryGitActionConfirm()
                }}
              >
                {directoryGitActionType === "add"
                  ? t("actions.addToVcs")
                  : directoryGitActionType &&
                      isDeleteAction(directoryGitActionType)
                    ? t("actions.delete")
                    : t("actions.rollback")}
              </Button>
            </DialogFooter>
          </div>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={Boolean(rollbackTarget)}
        onOpenChange={(open) => {
          if (open) return
          setRollbackTarget(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("rollbackConfirm.title")}</AlertDialogTitle>
            <AlertDialogDescription>
              {rollbackTarget
                ? t("rollbackConfirm.descriptionWithTarget", {
                    kind:
                      rollbackTarget.kind === "dir"
                        ? t("rollbackConfirm.kindDirectory")
                        : t("rollbackConfirm.kindFile"),
                    name: rollbackTarget.name,
                  })
                : t("rollbackConfirm.descriptionFallback")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={rollingBack}>
              {tCommon("cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={rollingBack}
              onClick={() => {
                void handleRollbackConfirm()
              }}
            >
              {t("actions.rollback")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={Boolean(deleteTarget)}
        onOpenChange={(open) => {
          if (open) return
          setDeleteTarget(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("deleteConfirm.title")}</AlertDialogTitle>
            <AlertDialogDescription>
              {deleteTarget
                ? t("deleteConfirm.descriptionWithTarget", {
                    kind:
                      deleteTarget.kind === "dir"
                        ? t("deleteConfirm.kindDirectory")
                        : t("deleteConfirm.kindFile"),
                    name: deleteTarget.name,
                  })
                : t("deleteConfirm.descriptionFallback")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>
              {tCommon("cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={deleting}
              onClick={() => {
                void handleDeleteConfirm()
              }}
            >
              {t("actions.delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {gitActions.dialogs}
    </div>
  )
}
