"use client"

import {
  createContext,
  useCallback,
  useContext,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  type HTMLAttributes,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react"
import { revealItemInDir, subscribe } from "@/lib/platform"
import ignore from "ignore"
import { Check, ChevronRight, Link2 } from "lucide-react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { useActiveFolder } from "@/contexts/active-folder-context"
import { useAuxPanelContext } from "@/contexts/aux-panel-context"
import { useTabStore } from "@/contexts/tab-context"
import { useTerminalContext } from "@/contexts/terminal-context"
import { useIsMobile } from "@/hooks/use-mobile"
import {
  useWorkspaceActions,
  useWorkspaceFileTabs,
} from "@/contexts/workspace-context"
import { useWorkspaceStateStore } from "@/hooks/use-workspace-state-store"
import { detectPlatform } from "@/hooks/use-platform"
import { findOwningFolder } from "@/lib/file-open-target"
import { AuxPanelNoFolderEmpty } from "@/components/layout/aux-panel-no-folder-empty"
import { WorkspaceDegradedBanner } from "@/components/layout/workspace-degraded-banner"
import { WorkspaceUploadDialog } from "@/components/layout/workspace-upload-dialog"
import { OpenInSubContent } from "@/components/layout/open-in-menu"
import { RowMoreButton } from "@/components/layout/row-more-button"
import {
  createFileTreeEntry,
  deleteFileTreeEntry,
  downloadWorkspaceDir,
  downloadWorkspaceFile,
  gitAddFiles,
  getFileTree,
  getGitBranch,
  gitListAllBranches,
  gitRollbackFile,
  gitStatus,
  moveFileTreeEntry,
  readFilePreview,
  openCommitWindow,
  openInCode,
  renameFileTreeEntry,
  WORKSPACE_DOWNLOAD_CANCELLED,
} from "@/lib/api"
import { isDesktop, isRemoteDesktopMode } from "@/lib/transport"
import { FileTreeCopySubContent } from "@/components/layout/file-tree-copy-menu"
import { emitAttachFileToSession } from "@/lib/session-attachment-events"
import {
  resolveFileTreeDropZone,
  writeFileTreeDragData,
  type FileTreeDragPayload,
} from "@/lib/file-tree-dnd"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  FOLDER_LINKS_CHANGED_EVENT,
  type FileTreeNode,
  type FolderLinksChanged,
  type GitBranchList,
  type GitStatusEntry,
} from "@/lib/types"
import {
  FileTree,
  FileTreeFolder,
  FileTreeFile,
} from "@/components/ai-elements/file-tree"
import {
  buildVisibleTreeRows,
  resolveTreeKeyboardAction,
} from "@/lib/file-tree-keyboard"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
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
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import { Skeleton } from "@/components/ui/skeleton"
import { joinFsPath } from "@/lib/path-utils"
import { toErrorMessage } from "@/lib/app-error"
import { cn } from "@/lib/utils"

function parentDir(filePath: string): string {
  const slashIndex = filePath.lastIndexOf("/")
  const backslashIndex = filePath.lastIndexOf("\\")
  const splitIndex = Math.max(slashIndex, backslashIndex)
  // No separator at all: the input is a leaf living at its root. For an
  // OS path that's a degenerate "C:" / "foo" — we can't navigate above
  // it, so the caller treated the result as the path itself. For a
  // workspace-relative path like "README.md" the answer is "workspace
  // root", encoded as empty string. The empty-string convention is the
  // safer default and matches what every caller currently expects.
  if (splitIndex < 0) return ""
  if (splitIndex === 0) return filePath.slice(0, 1)
  return filePath.slice(0, splitIndex)
}

function baseName(path: string): string {
  return path.split(/[/\\]/).pop() || path
}

const FILE_TREE_ROOT_PATH = "__workspace_root__"
const GITIGNORE_MUTED_CLASS = "text-muted-foreground/55"

/**
 * The directory drop zone highlighted by an in-flight *desktop* native drag
 * (relative path; `""` = workspace root), or null. On the web each row derives
 * its own drop highlight from the DOM `dragover`/`dragleave` it receives; on
 * desktop WebKit suppresses those target-side events during a native drag
 * (only `dragstart`/`dragend` reach the DOM), so the highlight is instead
 * broadcast here from Tauri's native DRAG_OVER hit-test and OR-ed into each
 * row's `dropActive`. Stays null on the web, so it never forces a re-render there.
 */
const DesktopDropDirContext = createContext<string | null>(null)

interface FileActionTarget {
  kind: "file" | "dir"
  path: string
  name: string
}

type GitFileState =
  | "untracked"
  | "modified"
  | "staged"
  | "conflicted"
  | "deleted"
  | "renamed"

function normalizeGitStatusPath(path: string): string {
  const normalized = path.trim()
  const renameSeparator = " -> "
  const renameIndex = normalized.lastIndexOf(renameSeparator)
  if (renameIndex < 0) return normalized
  return normalized.slice(renameIndex + renameSeparator.length).trim()
}

function normalizeComparePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "")
}

/** Whether the dragged entry may move into `destDir` (relative; `""` = the
 *  workspace root). False when it's a no-op (already that parent) or would move
 *  a directory into itself or one of its own descendants. Pure so both the
 *  dragover highlight and the deferred desktop commit share one rule. */
function canMoveEntry(
  source: { relPath: string; kind: "file" | "dir"; parentDir: string },
  destDir: string
): boolean {
  const dest = normalizeComparePath(destDir)
  const srcPath = normalizeComparePath(source.relPath)
  if (normalizeComparePath(source.parentDir) === dest) return false
  if (
    source.kind === "dir" &&
    (dest === srcPath || dest.startsWith(`${srcPath}/`))
  )
    return false
  return true
}

function prefixFileTreeNodePaths(
  nodes: FileTreeNode[],
  prefix: string
): FileTreeNode[] {
  return nodes.map((node) => {
    const nextPath = prefix ? `${prefix}/${node.path}` : node.path
    if (node.kind === "file") {
      return {
        ...node,
        path: nextPath,
      }
    }
    return {
      ...node,
      path: nextPath,
      children: prefixFileTreeNodePaths(node.children, nextPath),
    }
  })
}

function applyLazyTreeOverrides(
  nodes: FileTreeNode[],
  overrides: ReadonlyMap<string, FileTreeNode[]>
): FileTreeNode[] {
  return nodes.map((node) => {
    if (node.kind === "file") return node
    const overrideChildren = overrides.get(node.path)
    const baseChildren = overrideChildren ?? node.children
    return {
      ...node,
      children: applyLazyTreeOverrides(baseChildren, overrides),
    }
  })
}

function findDirectoryChildren(
  nodes: FileTreeNode[],
  targetPath: string
): FileTreeNode[] | null {
  for (const node of nodes) {
    if (node.kind !== "dir") continue
    if (normalizeComparePath(node.path) === targetPath) {
      return node.children
    }
    const nested = findDirectoryChildren(node.children, targetPath)
    if (nested) return nested
  }
  return null
}

function classifyGitFileState(status: string): GitFileState | null {
  const code = status.trim().toUpperCase()
  if (!code) return null
  if (code === "??") return "untracked"
  if (code.includes("U")) return "conflicted"
  if (code.includes("R") || code.includes("C")) return "renamed"
  if (code.includes("D")) return "deleted"
  if (code.includes("M") || code.includes("T")) return "modified"
  if (code.includes("A")) return "staged"
  return null
}

function getGitFileStateClassName(status?: string): string {
  if (!status) return ""
  const state = classifyGitFileState(status)
  if (state === "untracked") return "text-red-500 dark:text-red-400"
  if (state === "modified") return "text-emerald-600 dark:text-emerald-400"
  if (state === "staged") return "text-emerald-500 dark:text-emerald-400"
  if (state === "conflicted") return "text-amber-500 dark:text-amber-400"
  if (state === "deleted") return "text-orange-500 dark:text-orange-400"
  if (state === "renamed") return "text-violet-500 dark:text-violet-400"
  return ""
}

function getParentPath(path: string): string | null {
  const splitIdx = path.lastIndexOf("/")
  if (splitIdx < 0) return null
  return path.slice(0, splitIdx)
}

function hasIgnoredAncestor(path: string, ignoredPaths: ReadonlySet<string>) {
  let current = path
  while (true) {
    const parent = getParentPath(current)
    if (!parent) return false
    if (ignoredPaths.has(parent)) return true
    current = parent
  }
}

type DirectoryGitAction = "add" | "rollback"

interface DirectoryGitCandidateEntry {
  path: string
  status: string
}

type DirectoryGitTreeNode = DirectoryGitTreeDirNode | DirectoryGitTreeFileNode

interface DirectoryGitTreeDirNode {
  kind: "dir"
  name: string
  path: string
  children: DirectoryGitTreeNode[]
  fileCount: number
}

interface DirectoryGitTreeFileNode {
  kind: "file"
  name: string
  path: string
  status: string
}

interface MutableDirectoryGitTreeDirNode {
  kind: "dir"
  name: string
  path: string
  children: Map<
    string,
    MutableDirectoryGitTreeDirNode | DirectoryGitTreeFileNode
  >
}

const DIRECTORY_GIT_TREE_ROOT_PATH = "__directory_git_tree_root__"

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

  return entries.filter((entry) => {
    const fileState = classifyGitFileState(entry.status)
    return fileState !== "untracked"
  })
}

function buildDirectoryGitTree(
  entries: DirectoryGitCandidateEntry[],
  directoryPath: string
): DirectoryGitTreeNode[] {
  const normalizedDirPath = normalizeComparePath(directoryPath)
  const root: MutableDirectoryGitTreeDirNode = {
    kind: "dir",
    name: "",
    path: "",
    children: new Map(),
  }

  for (const entry of entries) {
    let relativePath = normalizeComparePath(entry.path)
    if (normalizedDirPath && relativePath.startsWith(`${normalizedDirPath}/`)) {
      relativePath = relativePath.slice(normalizedDirPath.length + 1)
    }
    const segments = relativePath.split("/").filter(Boolean)
    if (segments.length === 0) continue

    let current = root
    for (const [index, segment] of segments.entries()) {
      const isLeaf = index === segments.length - 1
      const nestedPath = segments.slice(0, index + 1).join("/")
      const nodePath = normalizedDirPath
        ? `${normalizedDirPath}/${nestedPath}`
        : nestedPath

      if (isLeaf) {
        current.children.set(`file:${nodePath}`, {
          kind: "file",
          name: segment,
          path: nodePath,
          status: entry.status,
        })
        continue
      }

      const dirKey = `dir:${nodePath}`
      const existing = current.children.get(dirKey)
      if (existing && existing.kind === "dir") {
        current = existing
        continue
      }

      const nextDir: MutableDirectoryGitTreeDirNode = {
        kind: "dir",
        name: segment,
        path: nodePath,
        children: new Map(),
      }
      current.children.set(dirKey, nextDir)
      current = nextDir
    }
  }

  const toSortedTreeNodes = (
    dir: MutableDirectoryGitTreeDirNode
  ): DirectoryGitTreeNode[] => {
    return Array.from(dir.children.values())
      .map<DirectoryGitTreeNode>((node) => {
        if (node.kind === "file") return node
        return {
          kind: "dir" as const,
          name: node.name,
          path: node.path,
          children: toSortedTreeNodes(node),
          fileCount: 0,
        }
      })
      .sort((left, right) => {
        if (left.kind !== right.kind) return left.kind === "dir" ? -1 : 1
        return left.name.localeCompare(right.name, undefined, {
          sensitivity: "base",
        })
      })
  }

  const annotateDirectory = (
    node: DirectoryGitTreeDirNode
  ): DirectoryGitTreeDirNode => {
    const nextChildren = node.children.map((child) => {
      if (child.kind === "file") return child
      return annotateDirectory(child)
    })
    const fileCount = nextChildren.reduce((count, child) => {
      if (child.kind === "file") return count + 1
      return count + child.fileCount
    }, 0)
    return {
      ...node,
      children: nextChildren,
      fileCount,
    }
  }

  return toSortedTreeNodes(root).map((node) => {
    if (node.kind === "file") return node
    return annotateDirectory(node)
  })
}

function collectDirectoryGitTreeExpandedPaths(
  nodes: DirectoryGitTreeNode[],
  expanded = new Set<string>()
): Set<string> {
  for (const node of nodes) {
    if (node.kind !== "dir") continue
    expanded.add(node.path)
    collectDirectoryGitTreeExpandedPaths(node.children, expanded)
  }
  return expanded
}

function collectDirectoryGitTreeLeafPaths(
  node: DirectoryGitTreeNode
): string[] {
  if (node.kind === "file") return [node.path]
  return node.children.flatMap(collectDirectoryGitTreeLeafPaths)
}

/**
 * Replace the native drag ghost with a compact labeled chip. The default ghost
 * is a snapshot of the dragged row, which — now that rows are full-width — reads
 * as a big translucent block with a drop shadow (WebKit) that obscures what's
 * being moved. A small off-screen chip is parked for the browser to snapshot,
 * then removed on the next tick. No-op outside the DOM.
 */
function applyCompactDragImage(event: React.DragEvent, name: string) {
  if (typeof document === "undefined") return
  const chip = document.createElement("div")
  chip.textContent = name
  chip.setAttribute("aria-hidden", "true")
  chip.className =
    "pointer-events-none max-w-[16rem] truncate rounded-md border bg-background px-2 py-0.5 font-mono text-xs text-foreground"
  chip.style.position = "fixed"
  chip.style.top = "-1000px"
  chip.style.left = "-1000px"
  document.body.appendChild(chip)
  event.dataTransfer.setDragImage(chip, 12, 12)
  // Remove once the browser has snapshotted it for the ghost.
  window.setTimeout(() => {
    chip.remove()
  }, 0)
}

/**
 * Drag-and-drop bridge shared by every tree row and the workspace-root row. The
 * source of the in-flight drag lives in a ref on the container (set on
 * dragstart), so `canDropInto` can validate a hover without reading the
 * (drag-over–inaccessible) dataTransfer.
 */
interface TreeDndHandlers {
  /** Begin dragging `node`: stash it as the source and write the drag payload
   *  (so the composer can read a file reference off the same drag). */
  onEntryDragStart: (event: React.DragEvent, node: FileTreeNode) => void
  /** Fires continuously while dragging the source row (the DOM `drag` event).
   *  Desktop-only use: WebKit suppresses the target-side dragover, but this
   *  source-side event still fires with the cursor in CSS px, so the drop-target
   *  directory highlight is hit-tested from here. No-op on the web. */
  onEntryDrag: (clientX: number, clientY: number) => void
  /** End the current drag (drop or cancel) — clears the source. */
  onEntryDragEnd: () => void
  /** Whether the in-flight source may drop into `destDir` (relative; `""` =
   *  workspace root). False when there's no drag, it's a no-op (same parent), or
   *  it would move a directory into itself/a descendant. */
  canDropInto: (destDir: string) => boolean
  /** Move the in-flight source into `destDir`. */
  onDropInto: (destDir: string) => void
}

/**
 * The workspace-root row. A drop target (move an entry back to the root) but
 * NOT a drag source — the root itself can't be moved. Kept as its own component
 * so its hover highlight state re-renders only this row, not the whole tab.
 */
function RootDropFolder({
  name,
  dnd,
  children,
  ...props
}: {
  name: string
  dnd: TreeDndHandlers
  children: ReactNode
} & HTMLAttributes<HTMLDivElement>) {
  const [dropActive, setDropActive] = useState(false)
  // On desktop the DOM dragover never reaches this row, so also honor the
  // native-drag highlight broadcast for the workspace root ("").
  const desktopDropActive = useContext(DesktopDropDirContext) === ""
  return (
    <FileTreeFolder
      // Forwarded first so the row's own props win, but forwarded at all: this
      // is the `asChild` target of the workspace-root ContextMenuTrigger, and a
      // component that swallows the props it is handed leaves the trigger with
      // no element to listen on (see the trigger's comment below).
      {...props}
      path={FILE_TREE_ROOT_PATH}
      name={name}
      className={cn("font-medium", props.className)}
      actions={<RowMoreButton />}
      dropActive={dropActive || desktopDropActive}
      dropTargetDir=""
      depth={0}
      rowProps={{
        onDragOver: (event) => {
          if (!dnd.canDropInto("")) return
          event.preventDefault()
          event.dataTransfer.dropEffect = "move"
          setDropActive(true)
        },
        onDragLeave: (event) => {
          const related = event.relatedTarget
          if (related instanceof Node && event.currentTarget.contains(related))
            return
          setDropActive(false)
        },
        onDrop: (event) => {
          setDropActive(false)
          if (!dnd.canDropInto("")) return
          event.preventDefault()
          event.stopPropagation()
          dnd.onDropInto("")
        },
      }}
    >
      {children}
    </FileTreeFolder>
  )
}

interface RenderNodeProps {
  node: FileTreeNode
  depth: number
  expandedPaths: ReadonlySet<string>
  workspacePath: string
  activeSessionTabId: string | null
  dnd: TreeDndHandlers
  gitEnabled: boolean
  webMode: boolean
  folderUploadSupported: boolean
  gitStatusByPath: ReadonlyMap<string, string>
  gitChangedDirPaths: ReadonlySet<string>
  untrackedDirPaths: ReadonlySet<string>
  gitignoreIgnoredPaths: ReadonlySet<string>
  ancestorGitignoreIgnored: boolean
  ancestorUntracked: boolean
  onOpenFilePreview: (path: string) => void
  onOpenFileDiff: (path: string) => void
  onOpenDirDiff: (path: string) => void
  onOpenCommitWindow: () => void
  onRequestCompareWithBranch: (target: FileActionTarget) => void
  onRequestRollback: (target: FileActionTarget) => void
  onOpenDirInTerminal: (dirPath: string, fileName: string) => Promise<void>
  onRequestAddToVcs: (target: FileActionTarget) => void
  onRequestRename: (target: FileActionTarget) => void
  onRequestCreate: (parentPath: string, kind: "file" | "dir") => void
  onRequestDelete: (target: FileActionTarget) => void
  onRequestUpload: (targetPath: string) => void
  onRequestDownloadFile: (target: FileActionTarget) => void
  onRequestDownloadDir: (target: FileActionTarget) => void
  onRefresh: () => void
}

function RenderNode({
  node,
  depth,
  expandedPaths,
  workspacePath,
  activeSessionTabId,
  dnd,
  gitEnabled,
  webMode,
  folderUploadSupported,
  gitStatusByPath,
  gitChangedDirPaths,
  untrackedDirPaths,
  gitignoreIgnoredPaths,
  ancestorGitignoreIgnored,
  ancestorUntracked,
  onOpenFilePreview,
  onOpenFileDiff,
  onOpenDirDiff,
  onOpenCommitWindow,
  onRequestCompareWithBranch,
  onRequestRollback,
  onOpenDirInTerminal,
  onRequestAddToVcs,
  onRequestCreate,
  onRequestRename,
  onRequestDelete,
  onRequestUpload,
  onRequestDownloadFile,
  onRequestDownloadDir,
  onRefresh,
}: RenderNodeProps) {
  const t = useTranslations("Folder.fileTreeTab")
  const tCommon = useTranslations("Folder.common")
  // `dragging` dims this row while it is the drag source; `dropActive` lights a
  // directory row up while a valid drop hovers it (files are never drop targets).
  const [dragging, setDragging] = useState(false)
  const [dropActive, setDropActive] = useState(false)
  // Desktop native drags don't emit DOM dragover, so a directory also lights up
  // when it's the drop zone broadcast from the Tauri DRAG_OVER hit-test.
  const desktopDropDir = useContext(DesktopDropDirContext)
  // The backend flags every directory that is a symlink on disk, so this badges
  // links the user made with `ln -s` at any depth — not just the top-level ones
  // registered through the "link folder" dialog.
  const isLinkedDir = node.kind === "dir" && node.symlink === true
  const isGitignoreIgnored =
    ancestorGitignoreIgnored || gitignoreIgnoredPaths.has(node.path)

  const systemExplorerLabel =
    typeof navigator === "undefined"
      ? t("openInFileManager")
      : (() => {
          const platform =
            `${navigator.platform} ${navigator.userAgent}`.toLowerCase()
          if (platform.includes("mac")) return t("openInFinder")
          if (platform.includes("win")) return t("openInExplorer")
          return t("openInFileManager")
        })()

  if (node.kind === "file") {
    const gitStatusCode =
      gitStatusByPath.get(node.path) ?? (ancestorUntracked ? "??" : undefined)
    const absolutePath = joinFsPath(workspacePath, node.path)
    const dirPath = parentDir(absolutePath)
    const isGitMenuDisabled = !gitEnabled || isGitignoreIgnored

    const handleAttachToSession = () => {
      if (!activeSessionTabId) return
      emitAttachFileToSession({
        tabId: activeSessionTabId,
        path: absolutePath,
      })
    }

    const handleOpenInSystemExplorer = async () => {
      try {
        await revealItemInDir(absolutePath)
      } catch (error) {
        const message = toErrorMessage(error)
        toast.error(t("toasts.openDirectoryFailed"), { description: message })
      }
    }

    const handleOpenInCode = async () => {
      try {
        await openInCode(absolutePath)
      } catch (error) {
        toast.error(t("toasts.openInCodeFailed"), {
          description: toErrorMessage(error),
        })
      }
    }

    return (
      <ContextMenu>
        {/*
          asChild merges the Radix trigger's pointerdown / contextmenu handlers
          and its `WebkitTouchCallout: none` style onto the row's own div
          instead of wrapping it in a <span> whose inline box breaks the row's
          `w-max min-w-full` sizing. Matches every other ContextMenuTrigger in
          the codebase; see the RootDropFolder wrapper below for the one rule
          asChild imposes on the child.
        */}
        <ContextMenuTrigger asChild>
          <FileTreeFile
            path={node.path}
            name={node.name}
            depth={depth}
            className={cn(
              isGitignoreIgnored
                ? GITIGNORE_MUTED_CLASS
                : getGitFileStateClassName(gitStatusCode),
              dragging && "opacity-70"
            )}
            draggable
            onDragStart={(event) => {
              setDragging(true)
              dnd.onEntryDragStart(event, node)
            }}
            onDrag={(event) => dnd.onEntryDrag(event.clientX, event.clientY)}
            onDragEnd={() => {
              setDragging(false)
              dnd.onEntryDragEnd()
            }}
            actions={<RowMoreButton />}
          />
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem onSelect={() => onOpenFilePreview(node.path)}>
            {tCommon("openFile")}
          </ContextMenuItem>
          <ContextMenuItem
            onSelect={() => void handleAttachToSession()}
            disabled={!activeSessionTabId}
          >
            {t("attachToCurrentSession")}
          </ContextMenuItem>
          <ContextMenuSub>
            <ContextMenuSubTrigger>{t("new")}</ContextMenuSubTrigger>
            <ContextMenuSubContent>
              <ContextMenuItem
                onSelect={() => onRequestCreate(node.path, "file")}
              >
                {t("newFile")}
              </ContextMenuItem>
              <ContextMenuItem
                onSelect={() => onRequestCreate(node.path, "dir")}
              >
                {t("newDirectory")}
              </ContextMenuItem>
            </ContextMenuSubContent>
          </ContextMenuSub>
          <ContextMenuSub>
            <ContextMenuSubTrigger disabled={isGitMenuDisabled}>
              {t("git")}
            </ContextMenuSubTrigger>
            <ContextMenuSubContent>
              <ContextMenuItem
                onSelect={() => onOpenCommitWindow()}
                disabled={isGitMenuDisabled}
              >
                {t("actions.commitCode")}
              </ContextMenuItem>
              <ContextMenuItem
                onSelect={() => onRequestAddToVcs(node)}
                disabled={
                  isGitMenuDisabled ||
                  classifyGitFileState(gitStatusCode ?? "") !== "untracked"
                }
              >
                {t("actions.addToVcs")}
              </ContextMenuItem>
              <ContextMenuItem
                onSelect={() => onOpenFileDiff(node.path)}
                disabled={isGitMenuDisabled}
              >
                {tCommon("viewDiff")}
              </ContextMenuItem>
              <ContextMenuItem
                onSelect={() => onRequestCompareWithBranch(node)}
                disabled={isGitMenuDisabled}
              >
                {t("compareWithBranch")}
              </ContextMenuItem>
              <ContextMenuItem
                variant="destructive"
                onSelect={() => onRequestRollback(node)}
                disabled={isGitMenuDisabled}
              >
                {t("actions.rollback")}
              </ContextMenuItem>
            </ContextMenuSubContent>
          </ContextMenuSub>
          <ContextMenuItem onSelect={() => onRequestRename(node)}>
            {tCommon("rename")}
          </ContextMenuItem>
          <ContextMenuItem onSelect={onRefresh}>
            {t("reloadFromDisk")}
          </ContextMenuItem>
          <ContextMenuSub>
            <ContextMenuSubTrigger>{t("openIn")}</ContextMenuSubTrigger>
            <OpenInSubContent
              explorerLabel={systemExplorerLabel}
              terminalLabel={t("openInTerminal")}
              codeLabel={t("openInCode")}
              onOpenExplorer={() => void handleOpenInSystemExplorer()}
              onOpenTerminal={() =>
                void onOpenDirInTerminal(dirPath, node.name)
              }
              onOpenCode={() => void handleOpenInCode()}
            />
          </ContextMenuSub>
          <ContextMenuSub>
            <ContextMenuSubTrigger>{t("copy")}</ContextMenuSubTrigger>
            <FileTreeCopySubContent
              name={node.name}
              relativePath={node.path}
              absolutePath={absolutePath}
              kind="file"
              remote={webMode}
            />
          </ContextMenuSub>
          {webMode && (
            <>
              <ContextMenuItem
                onSelect={() => onRequestUpload(parentDir(node.path))}
              >
                {t("upload")}
              </ContextMenuItem>
              <ContextMenuItem onSelect={() => onRequestDownloadFile(node)}>
                {t("download")}
              </ContextMenuItem>
            </>
          )}
          <ContextMenuItem
            onSelect={() => onRequestDelete(node)}
            variant="destructive"
          >
            {tCommon("delete")}
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    )
  }

  const absolutePath = joinFsPath(workspacePath, node.path)
  const isThisDirUntracked =
    ancestorUntracked || untrackedDirPaths.has(node.path)
  const dirHasChanges =
    !isGitignoreIgnored &&
    (gitChangedDirPaths.has(node.path) || isThisDirUntracked)
  const isGitMenuDisabled = !gitEnabled || isGitignoreIgnored
  const shouldRenderChildren = expandedPaths.has(node.path)

  const handleAttachDirToSession = () => {
    if (!activeSessionTabId) return
    emitAttachFileToSession({
      tabId: activeSessionTabId,
      path: absolutePath,
    })
  }

  const handleOpenDirInSystemExplorer = async () => {
    try {
      await revealItemInDir(absolutePath)
    } catch (error) {
      const message = toErrorMessage(error)
      toast.error(t("toasts.openDirectoryFailed"), { description: message })
    }
  }

  const handleOpenInCode = async () => {
    try {
      await openInCode(absolutePath)
    } catch (error) {
      toast.error(t("toasts.openInCodeFailed"), {
        description: toErrorMessage(error),
      })
    }
  }

  return (
    <ContextMenu>
      {/*
        asChild merges the Radix trigger's pointerdown / contextmenu handlers
        and its `WebkitTouchCallout: none` style onto the FileTreeFolder's own
        div — same reasoning as the FileTreeFile wrapper above.
      */}
      <ContextMenuTrigger asChild>
        <FileTreeFolder
          path={node.path}
          name={node.name}
          actions={<RowMoreButton />}
          suffix={
            isLinkedDir ? (
              <Link2
                className="h-3 w-3 shrink-0 text-muted-foreground"
                aria-label={t("linkedFolder")}
              />
            ) : undefined
          }
          nameClassName={
            isGitignoreIgnored
              ? GITIGNORE_MUTED_CLASS
              : dirHasChanges
                ? "text-emerald-600 dark:text-emerald-400"
                : undefined
          }
          iconClassName={isGitignoreIgnored ? GITIGNORE_MUTED_CLASS : undefined}
          dropActive={dropActive || desktopDropDir === node.path}
          dropTargetDir={node.path}
          depth={depth}
          rowProps={{
            draggable: true,
            className: dragging ? "opacity-70" : undefined,
            onDragStart: (event) => {
              setDragging(true)
              dnd.onEntryDragStart(event, node)
            },
            onDrag: (event) => dnd.onEntryDrag(event.clientX, event.clientY),
            onDragEnd: () => {
              setDragging(false)
              setDropActive(false)
              dnd.onEntryDragEnd()
            },
            onDragOver: (event) => {
              if (!dnd.canDropInto(node.path)) return
              event.preventDefault()
              event.dataTransfer.dropEffect = "move"
              setDropActive(true)
            },
            onDragLeave: (event) => {
              const related = event.relatedTarget
              if (
                related instanceof Node &&
                event.currentTarget.contains(related)
              )
                return
              setDropActive(false)
            },
            onDrop: (event) => {
              setDropActive(false)
              if (!dnd.canDropInto(node.path)) return
              event.preventDefault()
              event.stopPropagation()
              dnd.onDropInto(node.path)
            },
          }}
        >
          {shouldRenderChildren
            ? node.children.map((child) => (
                <RenderNode
                  key={child.path}
                  node={child}
                  depth={depth + 1}
                  expandedPaths={expandedPaths}
                  workspacePath={workspacePath}
                  activeSessionTabId={activeSessionTabId}
                  dnd={dnd}
                  gitEnabled={gitEnabled}
                  webMode={webMode}
                  folderUploadSupported={folderUploadSupported}
                  gitStatusByPath={gitStatusByPath}
                  gitChangedDirPaths={gitChangedDirPaths}
                  untrackedDirPaths={untrackedDirPaths}
                  gitignoreIgnoredPaths={gitignoreIgnoredPaths}
                  ancestorGitignoreIgnored={isGitignoreIgnored}
                  ancestorUntracked={isThisDirUntracked}
                  onOpenFilePreview={onOpenFilePreview}
                  onOpenFileDiff={onOpenFileDiff}
                  onOpenDirDiff={onOpenDirDiff}
                  onOpenCommitWindow={onOpenCommitWindow}
                  onRequestCompareWithBranch={onRequestCompareWithBranch}
                  onRequestRollback={onRequestRollback}
                  onOpenDirInTerminal={onOpenDirInTerminal}
                  onRequestCreate={onRequestCreate}
                  onRequestAddToVcs={onRequestAddToVcs}
                  onRequestRename={onRequestRename}
                  onRequestDelete={onRequestDelete}
                  onRequestUpload={onRequestUpload}
                  onRequestDownloadFile={onRequestDownloadFile}
                  onRequestDownloadDir={onRequestDownloadDir}
                  onRefresh={onRefresh}
                />
              ))
            : null}
        </FileTreeFolder>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem
          onSelect={handleAttachDirToSession}
          disabled={!activeSessionTabId}
        >
          {t("attachToCurrentSession")}
        </ContextMenuItem>
        <ContextMenuSub>
          <ContextMenuSubTrigger>{t("new")}</ContextMenuSubTrigger>
          <ContextMenuSubContent>
            <ContextMenuItem
              onSelect={() => onRequestCreate(node.path, "file")}
            >
              {t("newFile")}
            </ContextMenuItem>
            <ContextMenuItem onSelect={() => onRequestCreate(node.path, "dir")}>
              {t("newDirectory")}
            </ContextMenuItem>
          </ContextMenuSubContent>
        </ContextMenuSub>
        <ContextMenuSub>
          <ContextMenuSubTrigger disabled={isGitMenuDisabled}>
            {t("git")}
          </ContextMenuSubTrigger>
          <ContextMenuSubContent>
            <ContextMenuItem
              onSelect={() => onOpenCommitWindow()}
              disabled={isGitMenuDisabled}
            >
              {t("actions.commitCode")}
            </ContextMenuItem>
            <ContextMenuItem
              onSelect={() => onRequestAddToVcs(node)}
              disabled={isGitMenuDisabled}
            >
              {t("actions.addToVcs")}
            </ContextMenuItem>
            <ContextMenuItem
              onSelect={() => onOpenDirDiff(node.path)}
              disabled={isGitMenuDisabled}
            >
              {tCommon("viewDiff")}
            </ContextMenuItem>
            <ContextMenuItem
              onSelect={() => onRequestCompareWithBranch(node)}
              disabled={isGitMenuDisabled}
            >
              {t("compareWithBranch")}
            </ContextMenuItem>
            <ContextMenuItem
              variant="destructive"
              onSelect={() => onRequestRollback(node)}
              disabled={isGitMenuDisabled}
            >
              {t("actions.rollback")}
            </ContextMenuItem>
          </ContextMenuSubContent>
        </ContextMenuSub>
        <ContextMenuItem onSelect={() => onRequestRename(node)}>
          {tCommon("rename")}
        </ContextMenuItem>
        <ContextMenuSub>
          <ContextMenuSubTrigger>{t("openIn")}</ContextMenuSubTrigger>
          <OpenInSubContent
            explorerLabel={systemExplorerLabel}
            terminalLabel={t("openInTerminal")}
            codeLabel={t("openInCode")}
            onOpenExplorer={() => void handleOpenDirInSystemExplorer()}
            onOpenTerminal={() =>
              void onOpenDirInTerminal(absolutePath, node.name)
            }
            onOpenCode={() => void handleOpenInCode()}
          />
        </ContextMenuSub>
        <ContextMenuSub>
          <ContextMenuSubTrigger>{t("copy")}</ContextMenuSubTrigger>
          <FileTreeCopySubContent
            name={node.name}
            relativePath={node.path}
            absolutePath={absolutePath}
            kind="dir"
            remote={webMode}
          />
        </ContextMenuSub>
        {webMode && (
          <>
            <ContextMenuItem onSelect={() => onRequestUpload(node.path)}>
              {t("upload")}
            </ContextMenuItem>
            <ContextMenuItem onSelect={() => onRequestDownloadDir(node)}>
              {t("downloadAsZip")}
            </ContextMenuItem>
          </>
        )}
        <ContextMenuItem onSelect={onRefresh}>
          {t("reloadFromDisk")}
        </ContextMenuItem>
        <ContextMenuItem
          onSelect={() => onRequestDelete(node)}
          variant="destructive"
        >
          {tCommon("delete")}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}

export function FileTreeTab() {
  const t = useTranslations("Folder.fileTreeTab")
  const tCommon = useTranslations("Folder.common")
  const {
    pendingRevealPath,
    consumePendingRevealPath,
    setOpen: setAuxOpen,
  } = useAuxPanelContext()
  const isMobile = useIsMobile()
  // Defer the folder so a cross-folder conversation-tab switch commits first and
  // this tab's heavy tree rebuild (remount, applyLazyTreeOverrides, per-row
  // ContextMenus) runs in a non-blocking transition a frame later instead of
  // janking the switch. All path-keyed work (store subscription, <FileTree key>,
  // fetch effects) rides the deferred folder; same-path metadata churn is a
  // no-op since the tree derives from the store snapshot, not folder identity.
  const { activeFolder } = useActiveFolder()
  const folder = useDeferredValue(activeFolder)
  // True while the deferred render lags a cross-folder switch. During that gap we
  // render the loading skeleton (below) instead of the PREVIOUS folder's tree:
  // besides keeping the heavy rebuild off the switch commit, unmounting those
  // rows closes any open row ContextMenu (which portals outside this subtree) so
  // a click can't route an opener to the NEW active folder (openers default to it
  // when folderId is omitted — see resolveTargetFolder) and open/diff a
  // same-named file under the wrong folder. Also gates the reveal effect below.
  // Clears the instant the deferred render catches up.
  const folderStale = activeFolder?.id !== folder?.id
  const tabs = useTabStore((s) => s.tabs)
  const activeTabId = useTabStore((s) => s.activeTabId)
  const { createTerminalInDirectory } = useTerminalContext()
  const { activeFilePath } = useWorkspaceFileTabs()
  const { openBranchDiff, openFilePreview, openWorkingTreeDiff } =
    useWorkspaceActions()
  // File tab paths are absolute; the tree's node paths are relative to
  // THIS panel's folder — derive the relative form (undefined when the
  // active file lives outside this folder, which correctly unselects).
  const selectedTreePath = useMemo(() => {
    if (!activeFilePath || !folder) return undefined
    return (
      findOwningFolder(activeFilePath, [{ id: folder.id, path: folder.path }])
        ?.relPath ?? undefined
    )
  }, [activeFilePath, folder])
  const workspaceState = useWorkspaceStateStore(folder?.path ?? null)
  const [nodes, setNodes] = useState<FileTreeNode[]>([])
  // The row the user last clicked (file OR directory). Drives the tree's
  // selection highlight so a clicked directory looks focused too — the active
  // *file* alone (selectedTreePath) can't, since directories are never opened.
  // Kept in sync with the externally-active file by the effect below.
  const [focusedTreePath, setFocusedTreePath] = useState<string | undefined>(
    undefined
  )
  // The tree's single roving-focus host. Keyboard navigation keeps DOM focus
  // here — not on individual rows, which unmount on lazy-load / git refresh and
  // would strand focus — and drives the active row via `focusedTreePath` +
  // aria-activedescendant.
  const treeContainerRef = useRef<HTMLDivElement>(null)
  const [gitStatusByPath, setGitStatusByPath] = useState<Map<string, string>>(
    new Map()
  )
  const [gitEnabled, setGitEnabled] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [renameTarget, setRenameTarget] = useState<FileActionTarget | null>(
    null
  )
  const [renameValue, setRenameValue] = useState("")
  const [renaming, setRenaming] = useState(false)
  const [createParentPath, setCreateParentPath] = useState<string | null>(null)
  const [createKind, setCreateKind] = useState<"file" | "dir">("file")
  const [createName, setCreateName] = useState("")
  const [creating, setCreating] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<FileActionTarget | null>(
    null
  )
  const [deleting, setDeleting] = useState(false)
  const [rollbackTarget, setRollbackTarget] = useState<FileActionTarget | null>(
    null
  )
  const [rollingBack, setRollingBack] = useState(false)
  const [compareTarget, setCompareTarget] = useState<FileActionTarget | null>(
    null
  )
  const [directoryGitActionType, setDirectoryGitActionType] =
    useState<DirectoryGitAction | null>(null)
  const [directoryGitActionTarget, setDirectoryGitActionTarget] =
    useState<FileActionTarget | null>(null)
  const [directoryGitCandidates, setDirectoryGitCandidates] = useState<
    DirectoryGitCandidateEntry[]
  >([])
  const [directoryGitSelectedPaths, setDirectoryGitSelectedPaths] = useState<
    Set<string>
  >(new Set())
  const [directoryGitExpandedPaths, setDirectoryGitExpandedPaths] = useState<
    Set<string>
  >(new Set([DIRECTORY_GIT_TREE_ROOT_PATH]))
  const [directoryGitLoading, setDirectoryGitLoading] = useState(false)
  const [directoryGitSubmitting, setDirectoryGitSubmitting] = useState(false)
  const [directoryGitError, setDirectoryGitError] = useState<string | null>(
    null
  )
  const [compareBranchFilter, setCompareBranchFilter] = useState("")
  const [compareCurrentBranch, setCompareCurrentBranch] = useState<
    string | null
  >(null)
  const [compareBranchList, setCompareBranchList] = useState<GitBranchList>({
    local: [],
    remote: [],
    worktree_branches: [],
    main_worktree_branch: null,
  })
  const [compareBranchLoading, setCompareBranchLoading] = useState(false)
  const [compareRecentOpen, setCompareRecentOpen] = useState(true)
  const [compareLocalOpen, setCompareLocalOpen] = useState(false)
  const [compareRemoteOpen, setCompareRemoteOpen] = useState(false)
  const [comparing, setComparing] = useState(false)
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(
    () => new Set([FILE_TREE_ROOT_PATH])
  )
  const [gitignoreIgnoredPaths, setGitignoreIgnoredPaths] = useState<
    Set<string>
  >(new Set())
  const filePathSetRef = useRef<Set<string>>(new Set())
  // Request generation for async dialog loaders: bumped on every folder switch so
  // a folder-A `gitStatus` / branch fetch still in flight can't write into (or
  // close) a dialog the user has since reopened under folder B.
  const loadGenRef = useRef(0)
  const previousExpandedPathsRef = useRef<Set<string>>(
    new Set([FILE_TREE_ROOT_PATH])
  )
  const lazyLoadedChildrenByPathRef = useRef<Map<string, FileTreeNode[]>>(
    new Map()
  )
  const lazyLoadingDirPathsRef = useRef<Set<string>>(new Set())
  const loadDirectoryChildrenRef = useRef<
    ((dirPath: string) => Promise<void>) | null
  >(null)
  // `fetchTree` is defined below; effects declared above it reach it through
  // this ref (naming it directly in their deps would hit the TDZ).
  const fetchTreeRef = useRef<
    ((options?: { silent?: boolean }) => Promise<void>) | null
  >(null)
  const expandedPathsRef = useRef<Set<string>>(new Set([FILE_TREE_ROOT_PATH]))
  const workspaceTreeRef = useRef<FileTreeNode[]>([])
  // The node currently being dragged (set on dragstart, cleared on drop/cancel).
  // Held in a ref so drop targets can validate a hover during `dragover`, where
  // the drag's dataTransfer payload is not readable.
  const dragSourceRef = useRef<{
    relPath: string
    kind: "file" | "dir"
    parentDir: string
  } | null>(null)
  // Desktop-only: true once our drag has ended but its source is still retained
  // for the trailing native DRAG_DROP (which arrives after `dragend`). The next
  // drag to *enter* the webview evicts the retained source so an unrelated
  // (also path-less) foreign drop can't replay a cancelled tree drag.
  const dragEndedRef = useRef(false)
  // Desktop-only: the directory drop zone (relative path; "" = root) under the
  // in-flight native drag, broadcast to rows via DesktopDropDirContext so they
  // highlight it (WebKit doesn't deliver the DOM dragover that drives the web
  // highlight). Null when no valid directory is under the cursor. Always null on
  // the web, where the DOM path handles the highlight locally.
  const [desktopDropDir, setDesktopDropDir] = useState<string | null>(null)

  useEffect(() => {
    setExpandedPaths(new Set([FILE_TREE_ROOT_PATH]))
    previousExpandedPathsRef.current = new Set([FILE_TREE_ROOT_PATH])
    setGitignoreIgnoredPaths(new Set())
    lazyLoadedChildrenByPathRef.current.clear()
    lazyLoadingDirPathsRef.current.clear()
  }, [folder?.path])

  const folderId = folder?.id ?? null

  // Links can be added from the sidebar menu or another window, so converge on
  // the backend broadcast rather than only on local mutations. The rows' link
  // badges ride along on the refreshed tree — every directory node carries a
  // `symlink` flag — so there is nothing else to refetch here.
  useEffect(() => {
    let disposed = false
    let unlisten: (() => void) | undefined
    void (async () => {
      const dispose = await subscribe<FolderLinksChanged>(
        FOLDER_LINKS_CHANGED_EVENT,
        (payload) => {
          if (payload.folder_id !== folderId) return
          void fetchTreeRef.current?.({ silent: true })
        }
      )
      if (disposed) dispose()
      else unlisten = dispose
    })()
    return () => {
      disposed = true
      unlisten?.()
    }
  }, [folderId])

  // Derive the tree's focus from the externally-active file: opening a file from
  // another surface (search, a file tab) — or clicking one here, which opens it —
  // highlights that row, and clearing the active file (closing it, or switching
  // to one outside this folder) clears the highlight. Unconditional so the
  // `undefined` case clears too — a guard would strand a stale file highlight.
  // Clicking a *directory* changes neither dependency, so a directory focus set
  // by handleTreeSelect survives until the active file next changes. Keyed on
  // folder?.path too, so a folder switch re-derives (or clears) focus.
  useEffect(() => {
    setFocusedTreePath(selectedTreePath)
  }, [selectedTreePath, folder?.path])

  // Handle pending reveal path: expand all ancestor directories once tree is loaded
  const hasNodes = nodes.length > 0
  useEffect(() => {
    // Skip while the deferred tree still lags the active folder — consuming the
    // reveal now would expand it against the PREVIOUS folder's tree (a no-op that
    // drops the request). Re-runs once folderStale clears on the settled tree.
    if (!pendingRevealPath || !hasNodes || folderStale) return
    consumePendingRevealPath()
    setExpandedPaths((prev) => {
      const next = new Set(prev)
      next.add(FILE_TREE_ROOT_PATH)
      let idx = pendingRevealPath.indexOf("/")
      while (idx !== -1) {
        next.add(pendingRevealPath.slice(0, idx))
        idx = pendingRevealPath.indexOf("/", idx + 1)
      }
      next.add(pendingRevealPath)
      return next
    })
  }, [pendingRevealPath, consumePendingRevealPath, hasNodes, folderStale])

  const activeSessionTabId = useMemo(() => {
    const activeTab = tabs.find((tab) => tab.id === activeTabId)
    if (!activeTab) return null
    if (activeTab.kind !== "conversation") {
      return null
    }
    return activeTab.id
  }, [tabs, activeTabId])

  const fetchTree = useCallback(
    async (options?: {
      skipTree?: boolean
      skipStatus?: boolean
      silent?: boolean
      maxDepth?: number
    }) => {
      void options
      if (!folder?.path) {
        setNodes([])
        setGitStatusByPath(new Map())
        setGitEnabled(false)
        setLoading(false)
        setError(null)
        return
      }

      // Drop the lazy-load override cache so the fresh snapshot is not
      // masked by stale children (e.g. after deletes / renames / rollbacks
      // or files the agent just created). Reading expanded paths via a ref
      // keeps fetchTree's identity stable across expand/collapse so
      // downstream memoization is not invalidated on every tree interaction.
      const pathsToReload = Array.from(expandedPathsRef.current).filter(
        (path) => path !== FILE_TREE_ROOT_PATH
      )
      lazyLoadedChildrenByPathRef.current.clear()
      await workspaceState.requestResync("manual_refresh")
      // Re-hydrate children for directories beyond WORKSPACE_TREE_MAX_DEPTH
      // that are still expanded — the backend snapshot does not include them.
      const loader = loadDirectoryChildrenRef.current
      if (loader) {
        for (const path of pathsToReload) {
          void loader(path)
        }
      }
    },
    [folder?.path, workspaceState]
  )

  // Tree updates are the only source that should cause a full setNodes.
  // applyLazyTreeOverrides rebuilds every directory node object, which forces
  // React to re-render the entire tree. Keeping this effect narrow avoids
  // wasted work on health / seq / error / git transitions that don't touch
  // the tree shape (e.g. the intermediate "resyncing" patch during a refresh).
  useEffect(() => {
    workspaceTreeRef.current = workspaceState.tree
    setNodes(
      applyLazyTreeOverrides(
        workspaceState.tree,
        lazyLoadedChildrenByPathRef.current
      )
    )
  }, [folder?.path, workspaceState.tree])

  useEffect(() => {
    const nextStatusByPath = new Map<string, string>()
    for (const entry of workspaceState.git) {
      nextStatusByPath.set(entry.path, entry.status)
    }
    setGitStatusByPath(nextStatusByPath)
    setGitEnabled(true)
  }, [workspaceState.git])

  useEffect(() => {
    setLoading(
      workspaceState.health === "resyncing" && workspaceState.seq === 0
    )
    setError(workspaceState.health === "degraded" ? workspaceState.error : null)
  }, [workspaceState.error, workspaceState.health, workspaceState.seq])

  const loadDirectoryChildren = useCallback(
    async (dirPath: string) => {
      const rootPath = folder?.path
      if (!rootPath) return
      const normalizedDirPath = normalizeComparePath(dirPath)
      if (!normalizedDirPath) return
      if (lazyLoadedChildrenByPathRef.current.has(normalizedDirPath)) return
      if (lazyLoadingDirPathsRef.current.has(normalizedDirPath)) return

      // Check the backend tree (source of truth), not the rendered `nodes`.
      // `nodes` carries stale lazy-cache overrides that don't invalidate
      // until a tree_replace delta arrives — but for directories beyond
      // WORKSPACE_TREE_MAX_DEPTH the backend never emits tree_replace for
      // changes inside them (their children are not in tree_snapshot, so
      // the refreshed tree compares equal to the old one). Checking
      // `nodes` would cause fetchTree's forced reload to short-circuit on
      // the stale override and miss deletions / creations in deep dirs.
      const existingChildren = findDirectoryChildren(
        workspaceTreeRef.current,
        normalizedDirPath
      )
      if (existingChildren && existingChildren.length > 0) {
        return
      }

      lazyLoadingDirPathsRef.current.add(normalizedDirPath)
      try {
        const subtree = await getFileTree(
          joinFsPath(rootPath, normalizedDirPath),
          1
        )
        const prefixed = prefixFileTreeNodePaths(subtree, normalizedDirPath)
        lazyLoadedChildrenByPathRef.current.set(normalizedDirPath, prefixed)
        setNodes((prev) =>
          applyLazyTreeOverrides(prev, lazyLoadedChildrenByPathRef.current)
        )
      } catch {
        // Ignore lazy load failures and keep current collapsed/empty state.
      } finally {
        lazyLoadingDirPathsRef.current.delete(normalizedDirPath)
      }
    },
    [folder?.path]
  )

  useEffect(() => {
    loadDirectoryChildrenRef.current = loadDirectoryChildren
  }, [loadDirectoryChildren])

  useEffect(() => {
    fetchTreeRef.current = fetchTree
  }, [fetchTree])

  useEffect(() => {
    expandedPathsRef.current = expandedPaths
  }, [expandedPaths])

  // Subscribe to workspace envelopes to invalidate lazy-loaded overrides for
  // directories beyond WORKSPACE_TREE_MAX_DEPTH. Those directories are never
  // reflected in the backend's depth-2 tree_snapshot, so changes inside them
  // don't emit a tree_replace delta — the frontend has to target invalidation
  // by matching each `changed_paths` entry against its cached ancestors.
  // The backend already debounces raw FS events (300ms / 1.5s max), so we only
  // need a microtask hop here to merge paths that hit the same cached
  // ancestor within one envelope (or any synchronous burst of envelopes).
  const subscribeWorkspaceEnvelopes = workspaceState.subscribeEnvelopes
  useEffect(() => {
    if (!subscribeWorkspaceEnvelopes) return

    const pendingPaths = new Set<string>()
    let flushScheduled = false
    let disposed = false

    const flushPending = () => {
      flushScheduled = false
      if (disposed || pendingPaths.size === 0) return
      const paths = Array.from(pendingPaths)
      pendingPaths.clear()

      const loader = loadDirectoryChildrenRef.current
      const cache = lazyLoadedChildrenByPathRef.current
      const invalidated = new Set<string>()

      for (const changed of paths) {
        const normalized = normalizeComparePath(changed)
        if (!normalized) continue
        // When the changed path is itself a cached directory (FS events
        // that report the directory directly, e.g. a rename or a dir-level
        // notification), its own entry is stale — invalidate it.
        if (cache.has(normalized)) {
          invalidated.add(normalized)
        }
        // Independently of the above, walk up to the nearest cached
        // ancestor: the ancestor's children listing may also be stale
        // (a child was added, removed, or renamed). Without this, cases
        // where both a parent and child are cached leave the parent
        // holding a ghost reference to the old child.
        let cursor = normalized
        while (cursor.length > 0) {
          const slash = cursor.lastIndexOf("/")
          const parent = slash === -1 ? "" : cursor.slice(0, slash)
          if (parent.length === 0) break
          if (cache.has(parent)) {
            invalidated.add(parent)
            break
          }
          cursor = parent
        }
      }

      if (invalidated.size === 0) return
      for (const path of invalidated) {
        cache.delete(path)
      }
      if (!loader) return
      // Skip refetching directories that are no longer expanded — their
      // cleared cache will be re-hydrated on the next expansion via the
      // expandedPaths effect. This avoids spurious getFileTree traffic
      // for collapsed branches under bursty FS activity.
      const expanded = expandedPathsRef.current
      for (const path of invalidated) {
        if (!expanded.has(path)) continue
        void loader(path)
      }
    }

    const unsubscribe = subscribeWorkspaceEnvelopes(({ changed_paths }) => {
      if (!changed_paths || changed_paths.length === 0) return
      for (const path of changed_paths) {
        pendingPaths.add(path)
      }
      if (flushScheduled) return
      flushScheduled = true
      queueMicrotask(flushPending)
    })

    return () => {
      disposed = true
      unsubscribe()
      pendingPaths.clear()
    }
  }, [subscribeWorkspaceEnvelopes])

  useEffect(() => {
    const previousExpanded = previousExpandedPathsRef.current
    for (const path of expandedPaths) {
      if (path === FILE_TREE_ROOT_PATH) continue
      if (previousExpanded.has(path)) continue
      void loadDirectoryChildren(path)
    }
    previousExpandedPathsRef.current = new Set(expandedPaths)
  }, [expandedPaths, folder?.path, loadDirectoryChildren])

  const filePathSet = useMemo(() => {
    const paths = new Set<string>()
    const collect = (items: FileTreeNode[]) => {
      for (const item of items) {
        if (item.kind === "file") {
          paths.add(item.path)
        } else {
          collect(item.children)
        }
      }
    }
    collect(nodes)
    return paths
  }, [nodes])

  const dirChildrenByPath = useMemo(() => {
    const next = new Map<string, FileTreeNode[]>()
    next.set("", nodes)

    const collect = (items: FileTreeNode[]) => {
      for (const item of items) {
        if (item.kind !== "dir") continue
        next.set(item.path, item.children)
        collect(item.children)
      }
    }

    collect(nodes)
    return next
  }, [nodes])

  const expandedDirPaths = useMemo(() => {
    const dirs = new Set<string>([""])
    for (const path of expandedPaths) {
      if (path === FILE_TREE_ROOT_PATH) continue
      dirs.add(path)
    }
    return Array.from(dirs)
  }, [expandedPaths])

  useEffect(() => {
    filePathSetRef.current = filePathSet
  }, [filePathSet])

  useEffect(() => {
    if (!folder?.path) {
      setGitignoreIgnoredPaths(new Set())
      return
    }

    let canceled = false

    const loadIgnoredPaths = async () => {
      const nextIgnoredPaths = new Set<string>()
      const sortedDirs = [...expandedDirPaths].sort(
        (left, right) => left.length - right.length
      )

      for (const dirPath of sortedDirs) {
        if (hasIgnoredAncestor(dirPath, nextIgnoredPaths)) continue

        const children = dirChildrenByPath.get(dirPath)
        if (!children || children.length === 0) continue

        const gitignoreNode = children.find(
          (child) => child.kind === "file" && child.name === ".gitignore"
        )
        if (!gitignoreNode || gitignoreNode.kind !== "file") continue

        try {
          const result = await readFilePreview(folder.path, gitignoreNode.path)
          const matcher = ignore().add(result.content)

          // Collect all descendant nodes so multi-level patterns like
          // "public/vs" can be matched using relative paths.
          const descendants: FileTreeNode[] = []
          const collectDescendants = (parent: string) => {
            const items = dirChildrenByPath.get(parent)
            if (!items) return
            for (const item of items) {
              descendants.push(item)
              if (item.kind === "dir") collectDescendants(item.path)
            }
          }
          collectDescendants(dirPath)

          for (const desc of descendants) {
            if (hasIgnoredAncestor(desc.path, nextIgnoredPaths)) continue
            const relativePath =
              dirPath === "" ? desc.path : desc.path.slice(dirPath.length + 1)
            if (!relativePath) continue
            const ignored =
              desc.kind === "dir"
                ? matcher.ignores(`${relativePath}/`) ||
                  matcher.ignores(`${relativePath}/.codeg-ignore-probe`)
                : matcher.ignores(relativePath)
            if (ignored) {
              nextIgnoredPaths.add(desc.path)
            }
          }
        } catch {
          // Ignore parser/read failures for non-critical visual hints.
        }
      }

      if (!canceled) {
        setGitignoreIgnoredPaths(nextIgnoredPaths)
      }
    }

    void loadIgnoredPaths()

    return () => {
      canceled = true
    }
  }, [dirChildrenByPath, expandedDirPaths, folder?.path])

  const gitChangedDirPaths = useMemo(() => {
    const dirs = new Set<string>()
    for (const filePath of gitStatusByPath.keys()) {
      let current = filePath
      // Walk up the path collecting all parent directories
      while (true) {
        const slashIdx = current.lastIndexOf("/")
        const backslashIdx = current.lastIndexOf("\\")
        const splitIdx = Math.max(slashIdx, backslashIdx)
        if (splitIdx <= 0) break
        current = current.slice(0, splitIdx)
        dirs.add(current)
      }
    }
    return dirs
  }, [gitStatusByPath])

  // Directories that are entirely untracked (from git status -unormal)
  const untrackedDirPaths = useMemo(() => {
    const dirs = new Set<string>()
    for (const [path, status] of gitStatusByPath.entries()) {
      if (status.trim() === "??") {
        // Check if this path is a directory in the file tree
        if (dirChildrenByPath.has(path)) {
          dirs.add(path)
        }
      }
    }
    return dirs
  }, [gitStatusByPath, dirChildrenByPath])

  const handleTreeSelect = useCallback(
    (path: string) => {
      // Focus any clicked row (file or directory); only files open a preview.
      setFocusedTreePath(path)
      // Home keyboard focus to the stable container so arrow keys work right
      // after a click, and a later re-render can't strand DOM focus on the
      // clicked row (which may unmount on lazy-load / git refresh).
      treeContainerRef.current?.focus({ preventScroll: true })
      if (!filePathSet.has(path)) return
      void openFilePreview(path)
      // On mobile the file tree lives in a Drawer overlay — close it so the
      // opened file is visible in the main pane.
      if (isMobile) setAuxOpen(false)
    },
    [filePathSet, openFilePreview, isMobile, setAuxOpen]
  )

  // ─── File-tree keyboard navigation (IDEA-style project tree) ───
  // Flatten what is actually on screen (root + descendants of expanded dirs) so
  // arrow keys can move by visible row.
  const visibleTreeRows = useMemo(
    () => buildVisibleTreeRows(nodes, expandedPaths, FILE_TREE_ROOT_PATH),
    [nodes, expandedPaths]
  )

  const expandTreePath = useCallback((path: string) => {
    setExpandedPaths((prev) => {
      if (prev.has(path)) return prev
      const next = new Set(prev)
      next.add(path)
      return next
    })
  }, [])

  const collapseTreePath = useCallback((path: string) => {
    setExpandedPaths((prev) => {
      if (!prev.has(path)) return prev
      const next = new Set(prev)
      next.delete(path)
      return next
    })
  }, [])

  const toggleTreePath = useCallback((path: string) => {
    setExpandedPaths((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }, [])

  const focusTreeRow = useCallback((path: string) => {
    setFocusedTreePath(path)
    treeContainerRef.current?.focus({ preventScroll: true })
    // Navigation only ever lands on an already-mounted visible row, so scroll it
    // into view synchronously against the current DOM.
    const row = treeContainerRef.current?.querySelector<HTMLElement>(
      `[data-tree-row-path="${CSS.escape(path)}"]`
    )
    row?.scrollIntoView({ block: "nearest" })
  }, [])

  const handleTreeKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      const action = resolveTreeKeyboardAction(
        event.key,
        visibleTreeRows,
        focusedTreePath
      )
      if (!action) return
      // We own this key — stop the scroll area from also scrolling on it.
      event.preventDefault()
      switch (action.kind) {
        case "focus":
          focusTreeRow(action.path)
          break
        case "expand":
          expandTreePath(action.path)
          break
        case "collapse":
          collapseTreePath(action.path)
          break
        case "toggle":
          toggleTreePath(action.path)
          break
        case "open":
          focusTreeRow(action.path)
          void openFilePreview(action.path)
          break
        case "noop":
          break
      }
    },
    [
      visibleTreeRows,
      focusedTreePath,
      focusTreeRow,
      expandTreePath,
      collapseTreePath,
      toggleTreePath,
      openFilePreview,
    ]
  )

  // ─── File-tree drag & drop (move within tree / drop into composer) ───
  const handleMoveEntry = useCallback(
    async (sourcePath: string, destDir: string) => {
      const rootPath = folder?.path
      if (!rootPath) return
      try {
        await moveFileTreeEntry(rootPath, sourcePath, destDir)
        // Reveal the destination so the moved entry is visible after the tree
        // refreshes (its ancestors are already expanded — it was a drop target).
        if (destDir) {
          setExpandedPaths((prev) => {
            if (prev.has(destDir)) return prev
            const next = new Set(prev)
            next.add(destDir)
            return next
          })
        }
        await fetchTree()
      } catch (error) {
        toast.error(t("toasts.moveFailed"), {
          description: toErrorMessage(error),
        })
      }
    },
    [folder?.path, fetchTree, t]
  )

  const onEntryDragStart = useCallback(
    (event: React.DragEvent, node: FileTreeNode) => {
      const rootPath = folder?.path
      if (!rootPath) return
      const absPath = joinFsPath(rootPath, node.path)
      const payload: FileTreeDragPayload = {
        rootPath,
        relPath: node.path,
        absPath,
        name: node.name,
        kind: node.kind,
      }
      dragSourceRef.current = {
        relPath: node.path,
        kind: node.kind,
        parentDir: parentDir(node.path),
      }
      dragEndedRef.current = false
      writeFileTreeDragData(event.dataTransfer, payload)
      // Let the target choose: "move" for a tree folder, "copy" for the composer.
      event.dataTransfer.effectAllowed = "copyMove"
      applyCompactDragImage(event, node.name)
      // Picking a row up selects it (and, being single-select, deselects every
      // other row). The focus sync keys only on the active file / folder, so
      // this survives the whole drag.
      setFocusedTreePath(node.path)
    },
    [folder?.path]
  )

  // Desktop drop-target highlight. WebKit swallows the target-side DOM dragover
  // during a native drag (only source-side dragstart/drag/dragend reach the DOM
  // — the same reason the drop is committed from Tauri's native event), so the
  // per-row onDragOver highlight never runs on desktop. The source-side `drag`
  // event DOES fire, with the cursor already in CSS px, so we hit-test it here to
  // light up the directory under the cursor. Web keeps its own onDragOver path;
  // this early-returns there so desktopDropDir stays null and forces no re-render.
  const onEntryDrag = useCallback((clientX: number, clientY: number) => {
    if (!isDesktop()) return
    // Some `drag` frames report (0,0) before the cursor is tracked — ignore them
    // so a stray frame doesn't flicker the highlight off.
    if (clientX === 0 && clientY === 0) return
    const src = dragSourceRef.current
    if (!src) {
      setDesktopDropDir(null)
      return
    }
    const zone = resolveFileTreeDropZone(
      document.elementFromPoint(clientX, clientY)
    )
    setDesktopDropDir(
      zone?.kind === "dir" && canMoveEntry(src, zone.destDir)
        ? zone.destDir
        : null
    )
  }, [])

  const onEntryDragEnd = useCallback(() => {
    // On desktop the HTML5 `drop` never fires — Tauri's webview consumes the OS
    // drop before WebKit dispatches it — so the drag is committed later from the
    // native DRAG_DROP event, which arrives *after* this `dragend` and still
    // needs the source. Keep it and mark the drag ended so a subsequent foreign
    // drag entering the webview evicts the now-stale source (see the DRAG_ENTER
    // listener) rather than letting an unrelated path-less drop replay it. On
    // the web the DOM `drop` handler has already committed synchronously by now,
    // so clearing here just tidies up after a drop or a cancel.
    if (isDesktop()) {
      dragEndedRef.current = true
    } else {
      dragSourceRef.current = null
    }
    // Drop the desktop highlight on any drag end (including cancel). `dragend`
    // fires on desktop even though `drop` doesn't, and precedes the trailing
    // native DRAG_DROP; the pending move still reads the retained dragSourceRef.
    // No-op on the web (already null → React bails out).
    setDesktopDropDir(null)
  }, [])

  const canDropInto = useCallback((destDir: string) => {
    const src = dragSourceRef.current
    return src ? canMoveEntry(src, destDir) : false
  }, [])

  const onDropInto = useCallback(
    (destDir: string) => {
      const src = dragSourceRef.current
      dragSourceRef.current = null
      if (!src) return
      void handleMoveEntry(src.relPath, destDir)
    },
    [handleMoveEntry]
  )

  const treeDndValue = useMemo<TreeDndHandlers>(
    () => ({
      onEntryDragStart,
      onEntryDrag,
      onEntryDragEnd,
      canDropInto,
      onDropInto,
    }),
    [onEntryDragStart, onEntryDrag, onEntryDragEnd, canDropInto, onDropInto]
  )

  // Desktop commit path. Tauri's webview drag-drop handler always reports the
  // OS drop as handled, so WebKit never dispatches an HTML5 `drop` to the DOM
  // and the tree/composer `onDrop` handlers (which drive the web path) never
  // run. Tauri does emit its own drag-drop event for the same gesture, so we
  // finish an in-flight tree drag here: an internal drag reports no `paths`
  // (only OS file drops carry paths — those belong to the composer's uploader),
  // and we hit-test the drop coordinates against the `data-tree-drop-*` markers
  // to decide between a directory move and a composer insert.
  const commitDesktopDrop = useCallback(
    (paths: string[], position: { x: number; y: number }) => {
      const src = dragSourceRef.current
      if (!src) return
      // OS file drops carry `paths`; those are the composer uploader's job. An
      // internal tree drag has none — but neither do foreign text/link/other
      // non-file drops, so also require our own retained source (evicted by the
      // DRAG_ENTER listener once a new drag begins) before acting.
      if (paths.length > 0) return
      dragSourceRef.current = null
      dragEndedRef.current = false
      const rootPath = folder?.path
      if (!rootPath) return
      // Resolve one authoritative CSS-pixel point (`elementFromPoint`'s space).
      // On macOS wry reports the drop in window points, which already equal CSS
      // pixels (Tauri mislabels them "physical"), so use them as-is; elsewhere
      // the position is genuinely physical and is scaled down by the DPR.
      const scale =
        detectPlatform() === "macos" ? 1 : window.devicePixelRatio || 1
      const zone = resolveFileTreeDropZone(
        document.elementFromPoint(position.x / scale, position.y / scale)
      )
      if (!zone) return
      if (zone.kind === "dir") {
        if (canMoveEntry(src, zone.destDir)) {
          void handleMoveEntry(src.relPath, zone.destDir)
        }
      } else {
        emitAttachFileToSession({
          tabId: zone.tabId,
          path: joinFsPath(rootPath, src.relPath),
        })
      }
    },
    [folder?.path, handleMoveEntry]
  )
  // Read at event time so the Tauri listener can subscribe once (below) yet
  // always see the latest folder / move handler.
  const commitDesktopDropRef = useRef(commitDesktopDrop)
  useEffect(() => {
    commitDesktopDropRef.current = commitDesktopDrop
  }, [commitDesktopDrop])

  useEffect(() => {
    if (!isDesktop()) return
    let cancelled = false
    const unlisteners: Array<() => void> = []
    const setup = async () => {
      const { getCurrentWebview } = await import("@tauri-apps/api/webview")
      const { TauriEvent } = await import("@tauri-apps/api/event")
      const webview = getCurrentWebview()
      // Which directory zone (relative path; "" = root) the drag is over, or
      // null. Mirrors commitDesktopDrop's hit-test but for the live highlight:
      // same authoritative-CSS-pixel scaling (macOS window points already equal
      // CSS px; elsewhere physical ÷ DPR), and only a *droppable* directory
      // (canMoveEntry) lights up — hovering a file, the composer, or an invalid
      // target clears it.
      const resolveDesktopDropDir = (position: {
        x: number
        y: number
      }): string | null => {
        const src = dragSourceRef.current
        if (!src) return null
        const scale =
          detectPlatform() === "macos" ? 1 : window.devicePixelRatio || 1
        const zone = resolveFileTreeDropZone(
          document.elementFromPoint(position.x / scale, position.y / scale)
        )
        return zone?.kind === "dir" && canMoveEntry(src, zone.destDir)
          ? zone.destDir
          : null
      }
      const unlistenOver = await webview.listen<{
        position: { x: number; y: number }
      }>(TauriEvent.DRAG_OVER, (event) => {
        if (cancelled) return
        setDesktopDropDir(resolveDesktopDropDir(event.payload.position))
      })
      const unlistenLeave = await webview.listen(TauriEvent.DRAG_LEAVE, () => {
        if (cancelled) return
        setDesktopDropDir(null)
      })
      const unlistenDrop = await webview.listen<{
        paths: string[]
        position: { x: number; y: number }
      }>(TauriEvent.DRAG_DROP, (event) => {
        if (cancelled) return
        setDesktopDropDir(null)
        commitDesktopDropRef.current(
          event.payload.paths,
          event.payload.position
        )
      })
      // A new drag entering the webview after our own drag ended means the
      // retained source belongs to a cancelled drag — evict it so this foreign
      // (also path-less) drop can't replay it. Our own drag re-enters while
      // `dragEndedRef` is false (dragstart runs first), so it's untouched.
      const unlistenEnter = await webview.listen(TauriEvent.DRAG_ENTER, () => {
        if (cancelled) return
        if (dragEndedRef.current) {
          dragSourceRef.current = null
          dragEndedRef.current = false
        }
      })
      if (cancelled) {
        unlistenOver()
        unlistenLeave()
        unlistenDrop()
        unlistenEnter()
        return
      }
      unlisteners.push(unlistenOver, unlistenLeave, unlistenDrop, unlistenEnter)
    }
    void setup()
    return () => {
      cancelled = true
      for (const unlisten of unlisteners.splice(0)) unlisten()
    }
  }, [])

  // A workspace-folder switch invalidates any retained drag source: its path is
  // relative to the previous root, so a trailing native drop must not move it
  // under the new root.
  useEffect(() => {
    dragSourceRef.current = null
    dragEndedRef.current = false
    setDesktopDropDir(null)
  }, [folder?.path])

  const handleOpenDirInTerminal = useCallback(
    async (dirPath: string, fileName: string) => {
      const terminalTitle = t("terminalTitle", { name: baseName(fileName) })
      const terminalId = await createTerminalInDirectory(dirPath, terminalTitle)
      if (!terminalId) {
        toast.error(t("toasts.openBuiltinTerminalFailed"))
      }
    },
    [createTerminalInDirectory, t]
  )

  const handleOpenCommitWindow = useCallback(() => {
    if (!folder) return
    openCommitWindow(folder.id).catch((error) => {
      const message = toErrorMessage(error)
      toast.error(t("toasts.openCommitWindowFailed"), {
        description: message,
      })
    })
  }, [folder, t])

  const handleRequestCreate = useCallback(
    (parentPath: string, kind: "file" | "dir") => {
      setCreateParentPath(parentPath)
      setCreateKind(kind)
      setCreateName("")
    },
    []
  )

  const handleRequestRename = useCallback((target: FileActionTarget) => {
    setRenameTarget(target)
    setRenameValue(target.name)
  }, [])

  const handleRequestDelete = useCallback((target: FileActionTarget) => {
    setDeleteTarget(target)
  }, [])

  // ─── Web upload / download (issue #179) ───
  // In web mode the user has no native file dialog, so the file-tree
  // context menu opens `WorkspaceUploadDialog`, which owns the queue,
  // progress UI, and cancellation. We only track which directory the
  // user right-clicked from and whether the dialog is open.
  const [webMode, setWebMode] = useState(false)
  // `webkitdirectory` is non-standard. Chromium, Edge, Firefox, and
  // desktop Safari support it; iOS Safari does not, and historically
  // some embedded webviews lacked it too. Feature-detect at mount and
  // hide the "Select folder" affordance where the picker would silently
  // fall back to single-file selection — that would surprise the user
  // mid-flow and risk corrupting the relative-path contract.
  const [folderUploadSupported, setFolderUploadSupported] = useState(false)
  const [uploadDialogOpen, setUploadDialogOpen] = useState(false)
  const [uploadDialogTarget, setUploadDialogTarget] = useState("")
  useEffect(() => {
    // "webMode" here is a misnomer for "needs in-app upload/download
    // affordances because there's no native OS file picker for the
    // *destination/source* filesystem". That's true in pure-web mode
    // AND in remote-desktop mode (where the workspace lives on the
    // remote server, not on the local disk the OS dialog would target).
    setWebMode(!isDesktop() || isRemoteDesktopMode())
    setFolderUploadSupported(
      "webkitdirectory" in document.createElement("input")
    )
  }, [])

  const handleRequestUpload = useCallback((targetPath: string) => {
    setUploadDialogTarget(targetPath)
    setUploadDialogOpen(true)
  }, [])

  const handleUploadComplete = useCallback(() => {
    void fetchTree()
  }, [fetchTree])

  const handleRequestDownloadFile = useCallback(
    async (target: FileActionTarget) => {
      const folderPath = folder?.path
      if (!folderPath) return
      try {
        const result = await downloadWorkspaceFile(
          folderPath,
          target.path,
          target.name
        )
        // Remote-desktop downloads flow through a save-dialog; surface
        // the cancel-vs-saved outcome instead of silently doing nothing.
        if (result.status === "started") return
        if (result.status === WORKSPACE_DOWNLOAD_CANCELLED) return
        if (result.savedPath) {
          toast.success(t("toasts.downloadSaved", { name: target.name }), {
            description: result.savedPath,
          })
        }
      } catch (error) {
        const message = toErrorMessage(error)
        toast.error(t("toasts.downloadFailed", { name: target.name }), {
          description: message,
        })
      }
    },
    [folder?.path, t]
  )

  const handleRequestDownloadDir = useCallback(
    async (target: FileActionTarget) => {
      const folderPath = folder?.path
      if (!folderPath) return
      const name = target.name || baseName(folderPath) || "workspace"
      try {
        const result = await downloadWorkspaceDir(folderPath, target.path, name)
        if (result.status === "started") return
        if (result.status === WORKSPACE_DOWNLOAD_CANCELLED) return
        if (result.savedPath) {
          toast.success(t("toasts.downloadSaved", { name }), {
            description: result.savedPath,
          })
        }
      } catch (error) {
        const message = toErrorMessage(error)
        toast.error(t("toasts.downloadFailed", { name }), {
          description: message,
        })
      }
    },
    [folder?.path, t]
  )

  const resetDirectoryGitActionDialog = useCallback(() => {
    setDirectoryGitActionType(null)
    setDirectoryGitActionTarget(null)
    setDirectoryGitCandidates([])
    setDirectoryGitSelectedPaths(new Set())
    setDirectoryGitExpandedPaths(new Set([DIRECTORY_GIT_TREE_ROOT_PATH]))
    setDirectoryGitError(null)
    setDirectoryGitLoading(false)
    setDirectoryGitSubmitting(false)
  }, [])

  // Close in-panel dialogs the instant the ACTIVE folder changes (keyed on the
  // live id, not the deferred `folder`) so a dialog opened under the previous
  // folder can't act (rename / create / delete / rollback / compare / batch)
  // against the new one after the deferred render settles and it re-mounts.
  useEffect(() => {
    loadGenRef.current++
    setRenameTarget(null)
    setCreateParentPath(null)
    setDeleteTarget(null)
    setRollbackTarget(null)
    setCompareTarget(null)
    // Also drop the loaded branch list so a compare dialog reopened under the
    // new folder starts empty (loading) rather than briefly showing — and
    // letting the user act on — the previous folder's branches.
    setCompareBranchList({
      local: [],
      remote: [],
      worktree_branches: [],
      main_worktree_branch: null,
    })
    setCompareCurrentBranch(null)
    setCompareBranchLoading(false)
    resetDirectoryGitActionDialog()
  }, [activeFolder?.id, resetDirectoryGitActionDialog])

  const openDirectoryGitActionDialog = useCallback(
    async (action: DirectoryGitAction, target: FileActionTarget) => {
      if (!folder?.path) return
      const gen = loadGenRef.current
      setDirectoryGitActionType(action)
      setDirectoryGitActionTarget(target)
      setDirectoryGitCandidates([])
      setDirectoryGitSelectedPaths(new Set())
      setDirectoryGitExpandedPaths(new Set([DIRECTORY_GIT_TREE_ROOT_PATH]))
      setDirectoryGitError(null)
      setDirectoryGitLoading(true)

      try {
        const statusEntries = await gitStatus(folder.path)
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
              : t("toasts.noRollbackFilesInDir")
          )
          return
        }

        const treeNodes = buildDirectoryGitTree(candidates, target.path)
        const expanded = collectDirectoryGitTreeExpandedPaths(treeNodes)
        expanded.add(DIRECTORY_GIT_TREE_ROOT_PATH)

        setDirectoryGitCandidates(candidates)
        setDirectoryGitSelectedPaths(
          new Set(candidates.map((entry) => entry.path))
        )
        setDirectoryGitExpandedPaths(expanded)
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
    (target: FileActionTarget) => {
      if (target.kind === "dir") {
        void openDirectoryGitActionDialog("rollback", target)
        return
      }
      setRollbackTarget(target)
    },
    [openDirectoryGitActionDialog]
  )

  const handleAddToVcs = useCallback(
    async (target: FileActionTarget) => {
      if (target.kind === "dir") {
        await openDirectoryGitActionDialog("add", target)
        return
      }
      if (!folder?.path) return
      try {
        await gitAddFiles(folder.path, [target.path])
        toast.success(t("toasts.addedToVcs", { name: target.name }))
        await fetchTree()
      } catch (error) {
        const message = toErrorMessage(error)
        toast.error(t("toasts.addToVcsFailed"), { description: message })
      }
    },
    [fetchTree, folder?.path, openDirectoryGitActionDialog, t]
  )

  const loadCompareBranches = useCallback(async () => {
    if (!folder?.path) {
      setCompareBranchList({
        local: [],
        remote: [],
        worktree_branches: [],
        main_worktree_branch: null,
      })
      setCompareCurrentBranch(null)
      return
    }
    const gen = loadGenRef.current
    setCompareBranchLoading(true)
    try {
      const [branchesResult, currentBranchResult] = await Promise.allSettled([
        gitListAllBranches(folder.path),
        getGitBranch(folder.path),
      ])
      // Bail if the folder switched mid-flight — writing folder-A branches into a
      // compare dialog reopened under folder B would let the user diff against the
      // wrong repo's branch.
      if (gen !== loadGenRef.current) return

      if (branchesResult.status === "fulfilled") {
        setCompareBranchList(branchesResult.value)
      } else {
        setCompareBranchList({
          local: [],
          remote: [],
          worktree_branches: [],
          main_worktree_branch: null,
        })
        const message =
          branchesResult.reason instanceof Error
            ? branchesResult.reason.message
            : String(branchesResult.reason)
        toast.error(t("toasts.loadBranchesFailed"), { description: message })
      }

      if (currentBranchResult.status === "fulfilled") {
        setCompareCurrentBranch(currentBranchResult.value)
      } else {
        setCompareCurrentBranch(null)
      }
    } catch (error) {
      // Same generation guard on the error path: a stale folder-A failure must
      // not clobber (nor toggle the loading of) a compare dialog reopened under
      // folder B.
      if (gen !== loadGenRef.current) return
      setCompareBranchList({
        local: [],
        remote: [],
        worktree_branches: [],
        main_worktree_branch: null,
      })
      setCompareCurrentBranch(null)
      const message = toErrorMessage(error)
      toast.error(t("toasts.loadBranchesFailed"), { description: message })
    } finally {
      if (gen === loadGenRef.current) setCompareBranchLoading(false)
    }
  }, [folder?.path, t])

  const handleRequestCompareWithBranch = useCallback(
    (target: FileActionTarget) => {
      setCompareTarget(target)
      setCompareBranchFilter("")
      setCompareRecentOpen(true)
      setCompareLocalOpen(false)
      setCompareRemoteOpen(false)
      void loadCompareBranches()
    },
    [loadCompareBranches]
  )

  const compareFilterKeyword = useMemo(
    () => compareBranchFilter.trim().toLowerCase(),
    [compareBranchFilter]
  )

  const filteredCompareRecentBranches = useMemo(() => {
    if (!compareCurrentBranch) return []
    if (!compareFilterKeyword) return [compareCurrentBranch]
    return compareCurrentBranch.toLowerCase().includes(compareFilterKeyword)
      ? [compareCurrentBranch]
      : []
  }, [compareCurrentBranch, compareFilterKeyword])

  const filteredCompareBranches = useMemo(() => {
    if (!compareFilterKeyword) {
      return compareBranchList
    }

    return {
      local: compareBranchList.local.filter((branch) =>
        branch.toLowerCase().includes(compareFilterKeyword)
      ),
      remote: compareBranchList.remote.filter((branch) =>
        branch.toLowerCase().includes(compareFilterKeyword)
      ),
    }
  }, [compareBranchList, compareFilterKeyword])

  const groupedCompareRemoteBranches = useMemo(() => {
    const groups: Record<string, string[]> = {}
    for (const b of filteredCompareBranches.remote) {
      const slashIndex = b.indexOf("/")
      const remoteName = slashIndex > 0 ? b.substring(0, slashIndex) : "origin"
      if (!groups[remoteName]) groups[remoteName] = []
      groups[remoteName].push(b)
    }
    return groups
  }, [filteredCompareBranches.remote])
  const compareRemoteNames = Object.keys(groupedCompareRemoteBranches)
  const hasMultipleCompareRemotes = compareRemoteNames.length > 1

  const directoryGitTreeNodes = useMemo(() => {
    if (!directoryGitActionTarget) return []
    return buildDirectoryGitTree(
      directoryGitCandidates,
      directoryGitActionTarget.path
    )
  }, [directoryGitActionTarget, directoryGitCandidates])

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

  const directoryGitFilePathSet = useMemo(
    () => new Set(directoryGitAllFilePaths),
    [directoryGitAllFilePaths]
  )

  const directoryGitLeafPathsByDirPath = useMemo(() => {
    const next = new Map<string, string[]>()
    const collect = (node: DirectoryGitTreeNode) => {
      if (node.kind === "file") return
      next.set(node.path, collectDirectoryGitTreeLeafPaths(node))
      for (const child of node.children) {
        if (child.kind === "dir") collect(child)
      }
    }
    for (const node of directoryGitTreeNodes) {
      if (node.kind === "dir") collect(node)
    }
    return next
  }, [directoryGitTreeNodes])

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

  const handleToggleDirectoryGitSelectAll = useCallback(() => {
    setDirectoryGitSelectedPaths((prev) => {
      if (
        directoryGitAllFilePaths.length > 0 &&
        directoryGitAllFilePaths.every((path) => prev.has(path))
      ) {
        return new Set<string>()
      }
      return new Set(directoryGitAllFilePaths)
    })
  }, [directoryGitAllFilePaths])

  const handleToggleDirectoryGitDir = useCallback(
    (dirPath: string) => {
      const leafPaths = directoryGitLeafPathsByDirPath.get(dirPath) ?? []
      if (leafPaths.length === 0) return
      setDirectoryGitSelectedPaths((prev) => {
        const next = new Set(prev)
        const allSelected = leafPaths.every((path) => next.has(path))
        if (allSelected) {
          for (const path of leafPaths) next.delete(path)
        } else {
          for (const path of leafPaths) next.add(path)
        }
        return next
      })
    },
    [directoryGitLeafPathsByDirPath]
  )

  const handleDirectoryGitTreeSelect = useCallback(
    (path: string) => {
      if (path === DIRECTORY_GIT_TREE_ROOT_PATH) {
        handleToggleDirectoryGitSelectAll()
        return
      }

      if (directoryGitLeafPathsByDirPath.has(path)) {
        handleToggleDirectoryGitDir(path)
        return
      }

      if (directoryGitFilePathSet.has(path)) {
        handleToggleDirectoryGitFile(path)
      }
    },
    [
      directoryGitFilePathSet,
      directoryGitLeafPathsByDirPath,
      handleToggleDirectoryGitDir,
      handleToggleDirectoryGitFile,
      handleToggleDirectoryGitSelectAll,
    ]
  )

  const renderDirectoryGitTreeNode = useCallback(
    (node: DirectoryGitTreeNode): ReactNode => {
      if (node.kind === "dir") {
        const leafPaths = directoryGitLeafPathsByDirPath.get(node.path) ?? []
        const allSelected =
          leafPaths.length > 0 &&
          leafPaths.every((path) => directoryGitSelectedPaths.has(path))
        const partiallySelected =
          !allSelected &&
          leafPaths.some((path) => directoryGitSelectedPaths.has(path))
        return (
          <FileTreeFolder
            key={node.path}
            path={node.path}
            name={`${allSelected ? "[x]" : partiallySelected ? "[-]" : "[ ]"} ${node.name}`}
            suffix={`(${node.fileCount})`}
            suffixClassName="text-muted-foreground/45"
            title={node.path}
          >
            {node.children.map(renderDirectoryGitTreeNode)}
          </FileTreeFolder>
        )
      }

      const selected = directoryGitSelectedPaths.has(node.path)
      return (
        // No padding override: the row keeps the primitive's own px-2 so the
        // checkbox lands in the column a sibling folder spends on its chevron.
        <FileTreeFile
          key={node.path}
          path={node.path}
          name={node.name}
          title={node.path}
        >
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation()
              handleToggleDirectoryGitFile(node.path)
            }}
            className={
              selected
                ? "flex h-4 w-4 shrink-0 items-center justify-center rounded border border-primary bg-primary text-primary-foreground transition-colors"
                : "flex h-4 w-4 shrink-0 items-center justify-center rounded border border-input transition-colors"
            }
            aria-label={t("aria.selectPath", {
              action: selected ? t("actions.unselect") : t("actions.select"),
              path: node.path,
            })}
            disabled={directoryGitSubmitting}
          >
            {selected && <Check className="h-3 w-3" />}
          </button>
          <button
            type="button"
            className="flex-1 truncate text-left"
            onClick={(event) => {
              event.stopPropagation()
              handleToggleDirectoryGitFile(node.path)
            }}
            title={node.path}
            disabled={directoryGitSubmitting}
          >
            {node.name}
          </button>
          <span className="w-8 shrink-0 text-right text-3xs font-medium text-muted-foreground">
            {node.status}
          </span>
        </FileTreeFile>
      )
    },
    [
      directoryGitLeafPathsByDirPath,
      directoryGitSelectedPaths,
      directoryGitSubmitting,
      handleToggleDirectoryGitFile,
      t,
    ]
  )

  const handleCreateConfirm = useCallback(async () => {
    if (!folder?.path || createParentPath === null) return
    const trimmedName = createName.trim()
    if (!trimmedName) {
      setCreateParentPath(null)
      return
    }

    setCreating(true)
    try {
      await createFileTreeEntry(
        folder.path,
        createParentPath,
        trimmedName,
        createKind
      )
      setCreateParentPath(null)
      setCreateName("")
      await fetchTree()
    } catch (error) {
      const message = toErrorMessage(error)
      toast.error(t("toasts.createFailed"), { description: message })
    } finally {
      setCreating(false)
    }
  }, [createKind, createName, createParentPath, fetchTree, folder?.path, t])

  const handleRenameConfirm = useCallback(async () => {
    if (!folder?.path || !renameTarget) return
    const nextName = renameValue.trim()
    if (!nextName || nextName === renameTarget.name) {
      setRenameTarget(null)
      return
    }

    setRenaming(true)
    try {
      await renameFileTreeEntry(folder.path, renameTarget.path, nextName)
      setRenameTarget(null)
      setRenameValue("")
      await fetchTree()
    } catch (error) {
      const message = toErrorMessage(error)
      toast.error(t("toasts.renameFailed"), { description: message })
    } finally {
      setRenaming(false)
    }
  }, [fetchTree, folder?.path, renameTarget, renameValue, t])

  const handleDeleteConfirm = useCallback(async () => {
    if (!folder?.path || !deleteTarget) return
    setDeleting(true)
    try {
      await deleteFileTreeEntry(folder.path, deleteTarget.path)
      setDeleteTarget(null)
      await fetchTree()
    } catch (error) {
      const message = toErrorMessage(error)
      toast.error(t("toasts.deleteFailed"), { description: message })
    } finally {
      setDeleting(false)
    }
  }, [deleteTarget, fetchTree, folder?.path, t])

  const handleRollbackConfirm = useCallback(async () => {
    if (!folder?.path || !rollbackTarget) return
    setRollingBack(true)
    try {
      await gitRollbackFile(folder.path, rollbackTarget.path)
      toast.success(t("toasts.rolledBack", { name: rollbackTarget.name }))
      setRollbackTarget(null)
      await fetchTree()
    } catch (error) {
      const message = toErrorMessage(error)
      toast.error(t("toasts.rollbackFailed"), { description: message })
    } finally {
      setRollingBack(false)
    }
  }, [fetchTree, folder?.path, rollbackTarget, t])

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
      await fetchTree()
    } catch (error) {
      const message = toErrorMessage(error)
      setDirectoryGitError(message)
      toast.error(
        directoryGitActionType === "add"
          ? t("toasts.addToVcsFailed")
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
    fetchTree,
    folder?.path,
    resetDirectoryGitActionDialog,
    t,
  ])

  const handleCompareBranchClick = useCallback(
    async (branch: string) => {
      const nextBranch = branch.trim()
      if (!compareTarget || !nextBranch || comparing) return
      setComparing(true)
      try {
        if (compareTarget.kind === "dir") {
          await openBranchDiff(nextBranch, compareTarget.path, {
            mode: "overview",
          })
        } else {
          await openBranchDiff(nextBranch, compareTarget.path)
        }
        setCompareTarget(null)
        setCompareBranchFilter("")
        setCompareCurrentBranch(null)
      } finally {
        setComparing(false)
      }
    },
    [compareTarget, comparing, openBranchDiff]
  )

  const rootNodeName = useMemo(() => {
    if (!folder?.path) return t("workspace")
    return baseName(folder.path)
  }, [folder?.path, t])

  const systemExplorerLabel =
    typeof navigator === "undefined"
      ? t("openInFileManager")
      : (() => {
          const platform =
            `${navigator.platform} ${navigator.userAgent}`.toLowerCase()
          if (platform.includes("mac")) return t("openInFinder")
          if (platform.includes("win")) return t("openInExplorer")
          return t("openInFileManager")
        })()

  const rootTarget: FileActionTarget = useMemo(
    () => ({ kind: "dir", path: "", name: rootNodeName }),
    [rootNodeName]
  )

  if (!folder) {
    return <AuxPanelNoFolderEmpty />
  }

  // `folderStale` forces the skeleton over the previous folder's tree while the
  // deferred render catches up to the switch (its nodes are still loaded, so the
  // `nodes.length === 0` guard alone wouldn't — see the declaration above).
  if (folderStale || (loading && nodes.length === 0)) {
    return (
      <div className="p-3 space-y-2">
        <Skeleton className="h-4 w-3/4" />
        <Skeleton className="h-4 w-1/2 ml-4" />
        <Skeleton className="h-4 w-2/3 ml-4" />
        <Skeleton className="h-4 w-1/2" />
        <Skeleton className="h-4 w-3/4 ml-4" />
      </div>
    )
  }

  if (error) {
    return (
      <div className="p-3 text-xs text-destructive">
        <p>{error}</p>
        <Button
          variant="ghost"
          size="xs"
          className="mt-2"
          onClick={() => {
            void fetchTree()
          }}
        >
          {t("retry")}
        </Button>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full">
      {workspaceState.degraded && (
        <WorkspaceDegradedBanner onRetry={workspaceState.restart} />
      )}
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <ScrollArea className="flex-1 min-h-0 pb-1" x="scroll">
            <FileTree
              key={folder?.path ?? "file-tree-empty"}
              ref={treeContainerRef}
              keyboardNavigation
              onKeyDown={handleTreeKeyDown}
              className="border-0 rounded-none bg-transparent w-max min-w-full px-1.5 focus:outline-none focus-visible:outline-none"
              expanded={expandedPaths}
              onExpandedChange={setExpandedPaths}
              selectedPath={focusedTreePath}
              onSelect={handleTreeSelect}
            >
              {folder?.path && (
                <DesktopDropDirContext.Provider value={desktopDropDir}>
                  <ContextMenu>
                    {/*
                      asChild merges the Radix trigger's pointerdown /
                      contextmenu handlers and its `WebkitTouchCallout: none`
                      style onto the row itself instead of a wrapper <span>,
                      matching every other ContextMenuTrigger in the codebase.

                      The child MUST be a component that forwards the props it
                      is handed down to a real DOM element. Radix's Slot only
                      clones the child element — hand it a Context.Provider (or
                      any component that drops unknown props) and the trigger
                      renders NOTHING: no listener, no menu, on right-click or
                      long-press or the ⋯ button. Hence the provider sits
                      outside, and RootDropFolder spreads `...props`.
                    */}
                    <ContextMenuTrigger asChild>
                      <RootDropFolder name={rootNodeName} dnd={treeDndValue}>
                        {nodes.map((node) => (
                          <RenderNode
                            key={node.path}
                            node={node}
                            depth={1}
                            expandedPaths={expandedPaths}
                            workspacePath={folder.path}
                            activeSessionTabId={activeSessionTabId}
                            dnd={treeDndValue}
                            gitEnabled={gitEnabled}
                            webMode={webMode}
                            folderUploadSupported={folderUploadSupported}
                            gitStatusByPath={gitStatusByPath}
                            gitChangedDirPaths={gitChangedDirPaths}
                            untrackedDirPaths={untrackedDirPaths}
                            gitignoreIgnoredPaths={gitignoreIgnoredPaths}
                            ancestorGitignoreIgnored={false}
                            ancestorUntracked={false}
                            onOpenFilePreview={(path) => {
                              void openFilePreview(path)
                            }}
                            onOpenFileDiff={(path) => {
                              void openWorkingTreeDiff(path)
                            }}
                            onOpenDirDiff={(path) => {
                              void openWorkingTreeDiff(path, {
                                mode: "overview",
                              })
                            }}
                            onOpenCommitWindow={handleOpenCommitWindow}
                            onRequestCompareWithBranch={
                              handleRequestCompareWithBranch
                            }
                            onRequestRollback={handleRequestRollback}
                            onOpenDirInTerminal={handleOpenDirInTerminal}
                            onRequestCreate={handleRequestCreate}
                            onRequestAddToVcs={handleAddToVcs}
                            onRequestRename={handleRequestRename}
                            onRequestDelete={handleRequestDelete}
                            onRequestUpload={handleRequestUpload}
                            onRequestDownloadFile={(target) =>
                              void handleRequestDownloadFile(target)
                            }
                            onRequestDownloadDir={(target) =>
                              void handleRequestDownloadDir(target)
                            }
                            onRefresh={fetchTree}
                          />
                        ))}
                      </RootDropFolder>
                    </ContextMenuTrigger>
                    <ContextMenuContent>
                      <ContextMenuSub>
                        <ContextMenuSubTrigger>
                          {t("new")}
                        </ContextMenuSubTrigger>
                        <ContextMenuSubContent>
                          <ContextMenuItem
                            onSelect={() => handleRequestCreate("", "file")}
                          >
                            {t("newFile")}
                          </ContextMenuItem>
                          <ContextMenuItem
                            onSelect={() => handleRequestCreate("", "dir")}
                          >
                            {t("newDirectory")}
                          </ContextMenuItem>
                        </ContextMenuSubContent>
                      </ContextMenuSub>
                      <ContextMenuSub>
                        <ContextMenuSubTrigger disabled={!gitEnabled}>
                          {t("git")}
                        </ContextMenuSubTrigger>
                        <ContextMenuSubContent>
                          <ContextMenuItem
                            onSelect={() => handleOpenCommitWindow()}
                            disabled={!gitEnabled}
                          >
                            {t("actions.commitCode")}
                          </ContextMenuItem>
                          <ContextMenuItem
                            onSelect={() => void handleAddToVcs(rootTarget)}
                            disabled={!gitEnabled}
                          >
                            {t("actions.addToVcs")}
                          </ContextMenuItem>
                          <ContextMenuItem
                            onSelect={() =>
                              void openWorkingTreeDiff(".", {
                                mode: "overview",
                              })
                            }
                            disabled={!gitEnabled}
                          >
                            {tCommon("viewDiff")}
                          </ContextMenuItem>
                          <ContextMenuItem
                            onSelect={() =>
                              handleRequestCompareWithBranch(rootTarget)
                            }
                            disabled={!gitEnabled}
                          >
                            {t("compareWithBranch")}
                          </ContextMenuItem>
                          <ContextMenuItem
                            variant="destructive"
                            onSelect={() => handleRequestRollback(rootTarget)}
                            disabled={!gitEnabled}
                          >
                            {t("actions.rollback")}
                          </ContextMenuItem>
                        </ContextMenuSubContent>
                      </ContextMenuSub>
                      <ContextMenuItem
                        onSelect={() => {
                          void fetchTree()
                        }}
                      >
                        {t("reloadFromDisk")}
                      </ContextMenuItem>
                      <ContextMenuSub>
                        <ContextMenuSubTrigger>
                          {t("openIn")}
                        </ContextMenuSubTrigger>
                        <OpenInSubContent
                          explorerLabel={systemExplorerLabel}
                          terminalLabel={t("openInTerminal")}
                          codeLabel={t("openInCode")}
                          onOpenExplorer={() => {
                            void revealItemInDir(folder.path)
                          }}
                          onOpenTerminal={() => {
                            void handleOpenDirInTerminal(
                              folder.path,
                              rootNodeName
                            )
                          }}
                          onOpenCode={() => {
                            void openInCode(folder.path).catch((error) => {
                              toast.error(t("toasts.openInCodeFailed"), {
                                description: toErrorMessage(error),
                              })
                            })
                          }}
                        />
                      </ContextMenuSub>
                      <ContextMenuSub>
                        <ContextMenuSubTrigger>
                          {t("copy")}
                        </ContextMenuSubTrigger>
                        <FileTreeCopySubContent
                          name={rootNodeName}
                          // The root's path relative to itself. "." is the
                          // only spelling that stays pasteable (`git add .`);
                          // the literal answer, "", would copy nothing at all.
                          relativePath="."
                          absolutePath={folder.path}
                          kind="dir"
                          remote={webMode}
                        />
                      </ContextMenuSub>
                      {webMode && (
                        <>
                          <ContextMenuItem
                            onSelect={() => handleRequestUpload("")}
                          >
                            {t("upload")}
                          </ContextMenuItem>
                          <ContextMenuItem
                            onSelect={() =>
                              void handleRequestDownloadDir(rootTarget)
                            }
                          >
                            {t("downloadAsZip")}
                          </ContextMenuItem>
                        </>
                      )}
                    </ContextMenuContent>
                  </ContextMenu>
                </DesktopDropDirContext.Provider>
              )}
            </FileTree>
          </ScrollArea>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuSub>
            <ContextMenuSubTrigger>{t("new")}</ContextMenuSubTrigger>
            <ContextMenuSubContent>
              <ContextMenuItem onSelect={() => handleRequestCreate("", "file")}>
                {t("newFile")}
              </ContextMenuItem>
              <ContextMenuItem onSelect={() => handleRequestCreate("", "dir")}>
                {t("newDirectory")}
              </ContextMenuItem>
            </ContextMenuSubContent>
          </ContextMenuSub>
          {webMode && (
            <ContextMenuItem onSelect={() => handleRequestUpload("")}>
              {t("upload")}
            </ContextMenuItem>
          )}
          <ContextMenuItem
            onSelect={() => {
              void fetchTree()
            }}
          >
            {t("reloadFromDisk")}
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      {webMode && folder?.path && (
        <WorkspaceUploadDialog
          open={uploadDialogOpen}
          onOpenChange={setUploadDialogOpen}
          rootPath={folder.path}
          targetPath={uploadDialogTarget}
          folderUploadSupported={folderUploadSupported}
          onComplete={handleUploadComplete}
        />
      )}

      <Dialog
        open={createParentPath !== null}
        onOpenChange={(open) => {
          if (open) return
          setCreateParentPath(null)
          setCreateName("")
        }}
      >
        <DialogContent
          onOpenAutoFocus={(e) => {
            e.preventDefault()
            const input = (
              e.currentTarget as HTMLElement | null
            )?.querySelector("input")
            if (input) requestAnimationFrame(() => input.focus())
          }}
        >
          <DialogHeader>
            <DialogTitle>
              {createKind === "dir"
                ? t("createDialog.newDirectory")
                : t("createDialog.newFile")}
            </DialogTitle>
            <DialogDescription>
              {t("createDialog.description", {
                kind:
                  createKind === "dir"
                    ? t("newDirectory").toLowerCase()
                    : t("newFile").toLowerCase(),
              })}
            </DialogDescription>
          </DialogHeader>
          <form
            onSubmit={(event) => {
              event.preventDefault()
              void handleCreateConfirm()
            }}
            className="space-y-4"
          >
            <Input
              value={createName}
              onChange={(event) => setCreateName(event.target.value)}
              disabled={creating}
              placeholder={
                createKind === "dir"
                  ? t("createDialog.placeholderDirectory")
                  : t("createDialog.placeholderFile")
              }
            />
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                disabled={creating}
                onClick={() => {
                  setCreateParentPath(null)
                  setCreateName("")
                }}
              >
                {tCommon("cancel")}
              </Button>
              <Button type="submit" disabled={creating || !createName.trim()}>
                {tCommon("create")}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog
        open={Boolean(renameTarget)}
        onOpenChange={(open) => {
          if (open) return
          setRenameTarget(null)
          setRenameValue("")
        }}
      >
        <DialogContent
          onOpenAutoFocus={(e) => {
            e.preventDefault()
            const input = (
              e.currentTarget as HTMLElement | null
            )?.querySelector("input")
            if (input) requestAnimationFrame(() => input.focus())
          }}
        >
          <DialogHeader>
            <DialogTitle>
              {renameTarget?.kind === "dir"
                ? t("renameDialog.renameDirectory")
                : t("renameDialog.renameFile")}
            </DialogTitle>
            <DialogDescription>
              {t("renameDialog.description")}
            </DialogDescription>
          </DialogHeader>
          <form
            onSubmit={(event) => {
              event.preventDefault()
              void handleRenameConfirm()
            }}
            className="space-y-4"
          >
            <Input
              value={renameValue}
              onChange={(event) => setRenameValue(event.target.value)}
              disabled={renaming}
              placeholder={
                renameTarget?.kind === "dir"
                  ? t("renameDialog.placeholderDirectory")
                  : t("renameDialog.placeholderFile")
              }
            />
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                disabled={renaming}
                onClick={() => {
                  setRenameTarget(null)
                  setRenameValue("")
                }}
              >
                {tCommon("cancel")}
              </Button>
              <Button type="submit" disabled={renaming}>
                {tCommon("confirm")}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

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
                : t("actions.rollback")}
            </DialogTitle>
            <DialogDescription>
              {directoryGitActionTarget
                ? directoryGitActionType === "add"
                  ? t("directoryDialog.descriptionAdd", {
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
              ) : directoryGitTreeNodes.length > 0 &&
                directoryGitActionTarget ? (
                <FileTree
                  className="text-xs [&>div]:p-1"
                  expanded={directoryGitExpandedPaths}
                  onSelect={handleDirectoryGitTreeSelect}
                  onExpandedChange={setDirectoryGitExpandedPaths}
                >
                  <FileTreeFolder
                    path={DIRECTORY_GIT_TREE_ROOT_PATH}
                    name={directoryGitActionTarget.name}
                    suffix={`(${directoryGitAllFilePaths.length})`}
                    suffixClassName="text-muted-foreground/45"
                    title={directoryGitActionTarget.path}
                  >
                    {directoryGitTreeNodes.map(renderDirectoryGitTreeNode)}
                  </FileTreeFolder>
                </FileTree>
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
                  directoryGitActionType === "rollback"
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
                  : t("actions.rollback")}
              </Button>
            </DialogFooter>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog
        open={Boolean(compareTarget)}
        onOpenChange={(open) => {
          if (open) return
          setCompareTarget(null)
          setCompareBranchFilter("")
          setCompareCurrentBranch(null)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("compareDialog.title")}</DialogTitle>
            <DialogDescription>
              {compareTarget
                ? t("compareDialog.descriptionWithTarget", {
                    kind:
                      compareTarget.kind === "dir"
                        ? t("compareDialog.kindDirectory")
                        : t("compareDialog.kindFile"),
                    path: compareTarget.path,
                  })
                : t("compareDialog.descriptionFallback")}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <Input
              value={compareBranchFilter}
              onChange={(event) => setCompareBranchFilter(event.target.value)}
              placeholder={t("compareDialog.filterPlaceholder")}
              autoFocus
              disabled={comparing}
            />
            <div className="text-xs text-muted-foreground">
              {t("compareDialog.singleClickHint")}
            </div>
            <div className="space-y-2">
              <div className="max-h-56 overflow-y-auto rounded-xl border p-2 space-y-3">
                {compareBranchLoading ? (
                  <div className="py-6 text-center text-xs text-muted-foreground">
                    {t("compareDialog.loadingBranches")}
                  </div>
                ) : (
                  <>
                    <Collapsible
                      open={compareRecentOpen}
                      onOpenChange={setCompareRecentOpen}
                    >
                      <CollapsibleTrigger className="flex w-full items-center gap-2.5 rounded-xl px-2 py-1.5 text-sm hover:bg-accent hover:text-accent-foreground select-none outline-hidden">
                        <ChevronRight className="h-3.5 w-3.5 shrink-0 transition-transform [[data-state=open]>&]:rotate-90" />
                        {t("compareDialog.recentBranches", {
                          count: filteredCompareRecentBranches.length,
                        })}
                      </CollapsibleTrigger>
                      <CollapsibleContent className="space-y-1 pt-1">
                        {filteredCompareRecentBranches.length > 0 ? (
                          filteredCompareRecentBranches.map((branch) => (
                            <Button
                              key={`recent-${branch}`}
                              type="button"
                              size="xs"
                              variant="ghost"
                              className="w-full justify-start"
                              onClick={() => {
                                void handleCompareBranchClick(branch)
                              }}
                              disabled={comparing}
                            >
                              {branch}
                            </Button>
                          ))
                        ) : (
                          <div className="px-2 text-xs text-muted-foreground">
                            {t("compareDialog.noCurrentBranch")}
                          </div>
                        )}
                      </CollapsibleContent>
                    </Collapsible>
                    <Collapsible
                      open={compareLocalOpen}
                      onOpenChange={setCompareLocalOpen}
                    >
                      <CollapsibleTrigger className="flex w-full items-center gap-2.5 rounded-xl px-2 py-1.5 text-sm hover:bg-accent hover:text-accent-foreground select-none outline-hidden">
                        <ChevronRight className="h-3.5 w-3.5 shrink-0 transition-transform [[data-state=open]>&]:rotate-90" />
                        {t("compareDialog.localBranches", {
                          count: filteredCompareBranches.local.length,
                        })}
                      </CollapsibleTrigger>
                      <CollapsibleContent className="space-y-1 pt-1">
                        {filteredCompareBranches.local.length > 0 ? (
                          filteredCompareBranches.local.map((branch) => (
                            <Button
                              key={`local-${branch}`}
                              type="button"
                              size="xs"
                              variant="ghost"
                              className="w-full justify-start"
                              onClick={() => {
                                void handleCompareBranchClick(branch)
                              }}
                              disabled={comparing}
                            >
                              {branch}
                            </Button>
                          ))
                        ) : (
                          <div className="px-2 text-xs text-muted-foreground">
                            {t("compareDialog.noMatchingBranches")}
                          </div>
                        )}
                      </CollapsibleContent>
                    </Collapsible>
                    <Collapsible
                      open={compareRemoteOpen}
                      onOpenChange={setCompareRemoteOpen}
                    >
                      <CollapsibleTrigger className="flex w-full items-center gap-2.5 rounded-xl px-2 py-1.5 text-sm hover:bg-accent hover:text-accent-foreground select-none outline-hidden">
                        <ChevronRight className="h-3.5 w-3.5 shrink-0 transition-transform [[data-state=open]>&]:rotate-90" />
                        {t("compareDialog.remoteBranches", {
                          count: filteredCompareBranches.remote.length,
                        })}
                      </CollapsibleTrigger>
                      <CollapsibleContent className="space-y-1 pt-1">
                        {filteredCompareBranches.remote.length > 0 ? (
                          hasMultipleCompareRemotes ? (
                            compareRemoteNames.map((remoteName) => (
                              <Collapsible key={remoteName}>
                                <CollapsibleTrigger className="flex w-full items-center gap-2.5 rounded-xl px-2 py-1.5 pl-5 text-sm hover:bg-accent hover:text-accent-foreground select-none outline-hidden">
                                  <ChevronRight className="h-3 w-3 shrink-0 transition-transform [[data-state=open]>&]:rotate-90" />
                                  {remoteName} (
                                  {
                                    groupedCompareRemoteBranches[remoteName]
                                      .length
                                  }
                                  )
                                </CollapsibleTrigger>
                                <CollapsibleContent className="space-y-1 pt-1 pl-3">
                                  {groupedCompareRemoteBranches[remoteName].map(
                                    (branch) => (
                                      <Button
                                        key={`remote-${branch}`}
                                        type="button"
                                        size="xs"
                                        variant="ghost"
                                        className="w-full justify-start"
                                        onClick={() => {
                                          void handleCompareBranchClick(branch)
                                        }}
                                        disabled={comparing}
                                      >
                                        {branch.substring(
                                          remoteName.length + 1
                                        )}
                                      </Button>
                                    )
                                  )}
                                </CollapsibleContent>
                              </Collapsible>
                            ))
                          ) : (
                            filteredCompareBranches.remote.map((branch) => {
                              const slashIndex = branch.indexOf("/")
                              const shortName =
                                slashIndex > 0
                                  ? branch.substring(slashIndex + 1)
                                  : branch
                              return (
                                <Button
                                  key={`remote-${branch}`}
                                  type="button"
                                  size="xs"
                                  variant="ghost"
                                  className="w-full justify-start pl-4"
                                  onClick={() => {
                                    void handleCompareBranchClick(branch)
                                  }}
                                  disabled={comparing}
                                >
                                  {shortName}
                                </Button>
                              )
                            })
                          )
                        ) : (
                          <div className="px-2 text-xs text-muted-foreground">
                            {t("compareDialog.noMatchingBranches")}
                          </div>
                        )}
                      </CollapsibleContent>
                    </Collapsible>
                  </>
                )}
              </div>
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                disabled={comparing}
                onClick={() => {
                  setCompareTarget(null)
                  setCompareBranchFilter("")
                  setCompareCurrentBranch(null)
                }}
              >
                {tCommon("cancel")}
              </Button>
            </DialogFooter>
          </div>
        </DialogContent>
      </Dialog>

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
              {tCommon("delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

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
    </div>
  )
}
