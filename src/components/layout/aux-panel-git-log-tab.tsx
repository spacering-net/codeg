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
import { useTranslations } from "next-intl"
import { Virtualizer, type VirtualizerHandle } from "virtua"
import {
  Check,
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  CircleHelp,
  CloudCheck,
  CloudDownload,
  CloudOff,
  CloudSync,
  CloudUpload,
  GitBranch,
  GitBranchPlus,
  GitCompare,
  Globe,
  Hash,
  LocateFixed,
  MoreHorizontal,
  RefreshCw,
  RotateCcw,
  Upload,
  User,
  X,
} from "lucide-react"
import {
  Commit,
  CommitContent,
  CommitCopyButton,
  CommitFileAdditions,
  CommitFileChanges,
  CommitFileDeletions,
  CommitFileIcon,
  CommitFileInfo,
  CommitFilePath,
  CommitFiles,
  CommitFileStatus,
  CommitHeader,
} from "@/components/ai-elements/commit"
import { cn } from "@/lib/utils"
import { parseDate } from "@/components/layout/git-log-timeline"
import {
  FileTree,
  FileTreeFile,
  FileTreeFolder,
} from "@/components/ai-elements/file-tree"
import { Button } from "@/components/ui/button"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import {
  Command,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command"
import { Skeleton } from "@/components/ui/skeleton"
import { AuxPanelNoFolderEmpty } from "@/components/layout/aux-panel-no-folder-empty"
import { GitLogCommitMessage } from "@/components/layout/git-log-commit-message"
import { GitLogBranchFilterList } from "@/components/layout/git-log-branch-filter-list"
import { GIT_TOOLBAR_ICON_BUTTON_CLASS } from "@/components/layout/git-toolbar-controls"
import { RemoteManageDialog } from "@/components/layout/remote-manage-dialog"
import { subscribe } from "@/lib/platform"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"
import { useActiveFolder } from "@/contexts/active-folder-context"
import { useWorkspaceActions } from "@/contexts/workspace-context"
import { useWorkspaceStateStore } from "@/hooks/use-workspace-state-store"
import { useIsMobile } from "@/hooks/use-mobile"
import { useImeGuard } from "@/hooks/use-ime-guard"
import {
  useGitQuickActions,
  type GitQuickActions,
} from "@/hooks/use-git-quick-actions"
import {
  getGitBranch,
  gitCommitBranches,
  gitCommitFiles,
  gitCurrentUser,
  gitListAllBranches,
  gitLog,
  gitNewBranch,
  gitReset,
  gitSearchAuthors,
  openPushWindow,
} from "@/lib/api"
import type {
  GitBranchList,
  GitLogEntry,
  GitLogFileChange,
  GitResetMode,
} from "@/lib/types"
import { toast } from "sonner"
import { isNotAGitRepoError, toErrorMessage } from "@/lib/app-error"
import { ScrollArea } from "@/components/ui/scroll-area"

// Commits load in pages of PAGE_SIZE via the backend `skip` offset; the next
// page is fetched once the scroll comes within LOAD_MORE_PX of the estimated
// end (VSCode/IDEA-style incremental history loading).
const PAGE_SIZE = 100
const LOAD_MORE_PX = 800

// Recently-filtered authors, persisted per folder (IDEA-style "recent users").
// We deliberately do NOT scan the whole repo for authors (slow); the dropdown is
// seeded from this local history plus the current user, with free-text search.
const RECENT_AUTHORS_KEY_PREFIX = "codeg:gitlog:recent-authors:"
const RECENT_AUTHORS_MAX = 8

function loadRecentAuthors(folderPath: string): string[] {
  if (typeof window === "undefined") return []
  try {
    const raw = window.localStorage.getItem(
      RECENT_AUTHORS_KEY_PREFIX + folderPath
    )
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter((x): x is string => typeof x === "string")
      .slice(0, RECENT_AUTHORS_MAX)
  } catch {
    return []
  }
}

function saveRecentAuthors(folderPath: string, authors: string[]): void {
  if (typeof window === "undefined") return
  try {
    window.localStorage.setItem(
      RECENT_AUTHORS_KEY_PREFIX + folderPath,
      JSON.stringify(authors)
    )
  } catch {
    // Ignore quota / serialization errors — recent authors are best-effort.
  }
}

// Prepend `author` to the recent list, dedupe (exact match), cap length. Pure.
export function addRecentAuthor(recent: string[], author: string): string[] {
  return [author, ...recent.filter((a) => a !== author)].slice(
    0,
    RECENT_AUTHORS_MAX
  )
}

// Drop `author` from the recent list (exact match). Pure.
export function removeRecentAuthor(recent: string[], author: string): string[] {
  return recent.filter((a) => a !== author)
}

// The dynamic "current branch" selection. Sent to git VERBATIM as the log's rev
// argument, so git resolves it per query — the filter follows every checkout
// (and keeps working on a detached HEAD) without the frontend having to know the
// branch name. It can never collide with a real ref: git rejects `HEAD` as a
// local branch name, and git_list_all_branches already drops remote refs
// containing "HEAD" (e.g. `origin/HEAD`).
export const HEAD_BRANCH_FILTER = "HEAD"

export function isHeadFilter(branch: string | null): boolean {
  return branch === HEAD_BRANCH_FILTER
}

// Whether a branch selection still refers to something this repo can log. Used
// to drop a restored branch that has since been deleted; the HEAD sentinel is
// never in the branch list yet is always valid, and `null` is the all-branches
// view. Pure.
export function isLiveBranchSelection(
  branch: string | null,
  list: GitBranchList
): boolean {
  if (branch === null || isHeadFilter(branch)) return true
  return list.local.includes(branch) || list.remote.includes(branch)
}

// Reset always targets the CURRENT branch, so it is allowed from the
// all-branches view, from the HEAD view (which *is* the current branch), or
// while viewing the current branch by name — but not while viewing a different
// specific branch. Pure.
export function canResetFromSelection(
  currentBranch: string | null,
  selectedBranch: string | null
): boolean {
  if (!currentBranch) return false
  return (
    selectedBranch === null ||
    isHeadFilter(selectedBranch) ||
    selectedBranch === currentBranch
  )
}

// The last branch/author filter, persisted per folder path so the tab reopens on
// the same view. `null` for either means the default (all branches / all
// authors); when both are null the entry is dropped to keep storage tidy.
const SELECTION_KEY_PREFIX = "codeg:gitlog:selection:"

type GitLogSelection = { branch: string | null; author: string | null }

function loadSelection(folderPath: string): GitLogSelection {
  if (typeof window === "undefined") return { branch: null, author: null }
  try {
    const raw = window.localStorage.getItem(SELECTION_KEY_PREFIX + folderPath)
    if (!raw) return { branch: null, author: null }
    const parsed = JSON.parse(raw)
    return {
      branch: typeof parsed?.branch === "string" ? parsed.branch : null,
      author: typeof parsed?.author === "string" ? parsed.author : null,
    }
  } catch {
    return { branch: null, author: null }
  }
}

function saveSelection(folderPath: string, selection: GitLogSelection): void {
  if (typeof window === "undefined") return
  try {
    if (selection.branch == null && selection.author == null) {
      window.localStorage.removeItem(SELECTION_KEY_PREFIX + folderPath)
      return
    }
    window.localStorage.setItem(
      SELECTION_KEY_PREFIX + folderPath,
      JSON.stringify(selection)
    )
  } catch {
    // Best-effort — a failed persist just means the view won't be restored.
  }
}

const emitEvent = async (event: string, payload?: unknown) => {
  try {
    const { emit } = await import("@tauri-apps/api/event")
    await emit(event, payload)
  } catch {
    // not in Tauri
  }
}

function formatRelativeTime(
  dateStr: string,
  t: (
    key:
      | "time.monthsAgo"
      | "time.daysAgo"
      | "time.hoursAgo"
      | "time.minsAgo"
      | "time.justNow",
    values?: { count: number }
  ) => string
): string {
  const date = new Date(dateStr)
  if (Number.isNaN(date.getTime())) return dateStr

  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffMin = Math.floor(diffMs / 60_000)
  const diffHour = Math.floor(diffMin / 60)
  const diffDay = Math.floor(diffHour / 24)

  if (diffDay > 30) {
    const diffMonth = Math.floor(diffDay / 30)
    return t("time.monthsAgo", { count: diffMonth })
  }
  if (diffDay > 0) return t("time.daysAgo", { count: diffDay })
  if (diffHour > 0) return t("time.hoursAgo", { count: diffHour })
  if (diffMin > 0) return t("time.minsAgo", { count: diffMin })
  return t("time.justNow", { count: 0 })
}

function filterRecordByCommitHashes<T>(
  record: Record<string, T>,
  hashes: Set<string>
): Record<string, T> {
  const next: Record<string, T> = {}
  for (const [key, value] of Object.entries(record)) {
    if (hashes.has(key)) {
      next[key] = value
    }
  }
  return next
}

function mapFileStatus(
  status: string
): "added" | "modified" | "deleted" | "renamed" {
  switch (status.toUpperCase().charAt(0)) {
    case "A":
      return "added"
    case "D":
      return "deleted"
    case "R":
      return "renamed"
    default:
      return "modified"
  }
}

function getPushStatusMeta(
  pushed: boolean | null,
  labels: {
    pushed: string
    notPushed: string
    unknown: string
  }
): {
  label: string
  icon: typeof CloudCheck
  className: string
} {
  if (pushed === true) {
    return {
      label: labels.pushed,
      icon: CloudCheck,
      className: "text-emerald-500",
    }
  }

  if (pushed === false) {
    return {
      label: labels.notPushed,
      icon: CloudOff,
      className: "text-amber-500",
    }
  }

  return {
    label: labels.unknown,
    icon: CircleHelp,
    className: "text-muted-foreground",
  }
}

type CommitFileTreeDirNode = {
  kind: "dir"
  name: string
  path: string
  children: CommitFileTreeNode[]
  fileCount: number
}

type CommitFileTreeFileNode = {
  kind: "file"
  name: string
  path: string
  change: GitLogFileChange
}

type CommitFileTreeNode = CommitFileTreeDirNode | CommitFileTreeFileNode

interface CommitBranchTarget {
  fullHash: string
  shortHash: string
}

interface CommitResetTarget {
  fullHash: string
  shortHash: string
  message: string
}

interface MutableCommitFileTreeDirNode {
  kind: "dir"
  name: string
  path: string
  children: Map<string, MutableCommitFileTreeDirNode | CommitFileTreeFileNode>
}

function normalizePathSegments(path: string): string[] {
  const normalized = path.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "")
  if (!normalized) return []
  return normalized.split("/").filter(Boolean)
}

function toSortedTreeNodes(
  dir: MutableCommitFileTreeDirNode
): CommitFileTreeNode[] {
  return Array.from(dir.children.values())
    .map<CommitFileTreeNode>((node) => {
      if (node.kind === "file") return node
      return {
        kind: "dir" as const,
        fileCount: 0,
        name: node.name,
        path: node.path,
        children: toSortedTreeNodes(node),
      }
    })
    .sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1
      return a.name.localeCompare(b.name, undefined, { sensitivity: "base" })
    })
}

function compressAndAnnotateDir(
  node: CommitFileTreeDirNode
): CommitFileTreeDirNode {
  let compressedChildren: CommitFileTreeNode[] = node.children.map((child) => {
    if (child.kind === "file") return child
    return compressAndAnnotateDir(child)
  })

  let fileCount = compressedChildren.reduce((count, child) => {
    if (child.kind === "file") return count + 1
    return count + child.fileCount
  }, 0)

  let nextNode: CommitFileTreeDirNode = {
    ...node,
    children: compressedChildren,
    fileCount,
  }

  // Merge "dir/dir/dir" chains where each directory only has one directory child.
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

function buildCommitFileTree(files: GitLogFileChange[]): CommitFileTreeNode[] {
  const root: MutableCommitFileTreeDirNode = {
    kind: "dir",
    name: "",
    path: "",
    children: new Map(),
  }

  for (const change of files) {
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

      const nextDir: MutableCommitFileTreeDirNode = {
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
  nodes: CommitFileTreeNode[],
  expanded = new Set<string>()
): Set<string> {
  for (const node of nodes) {
    if (node.kind !== "dir") continue
    expanded.add(node.path)
    collectExpandedDirectoryPaths(node.children, expanded)
  }
  return expanded
}

function CommitFilesTree({
  commitHash,
  files,
  folderName,
  onOpenCommitDiff,
  onOpenFilePreview,
}: {
  commitHash: string
  files: GitLogFileChange[]
  folderName: string
  onOpenCommitDiff: (
    commit: string,
    path?: string,
    description?: string
  ) => void
  onOpenFilePreview: (path: string) => void
}) {
  const t = useTranslations("Folder.gitLogTab")
  const tCommon = useTranslations("Folder.common")
  const rootPath = "__commit_file_tree_root__"
  const treeNodes = useMemo(() => buildCommitFileTree(files), [files])
  const allDirectoryPaths = useMemo(() => {
    const paths = collectExpandedDirectoryPaths(treeNodes)
    paths.add(rootPath)
    return paths
  }, [treeNodes])
  const [expandedPaths, setExpandedPaths] =
    useState<Set<string>>(allDirectoryPaths)

  useEffect(() => {
    setExpandedPaths(allDirectoryPaths)
  }, [allDirectoryPaths])

  const canExpandAll = useMemo(() => {
    if (allDirectoryPaths.size === 0) return false
    for (const path of allDirectoryPaths) {
      if (!expandedPaths.has(path)) return true
    }
    return false
  }, [allDirectoryPaths, expandedPaths])

  const canCollapseAll = expandedPaths.size > 0

  const toggleExpanded = useCallback(() => {
    if (canExpandAll) {
      setExpandedPaths(new Set(allDirectoryPaths))
      return
    }
    setExpandedPaths(new Set())
  }, [allDirectoryPaths, canExpandAll])

  const renderNode = (node: CommitFileTreeNode): ReactElement => {
    if (node.kind === "dir") {
      return (
        <FileTreeFolder
          key={node.path}
          path={node.path}
          name={node.name}
          suffix={`(${node.fileCount})`}
          suffixClassName="text-muted-foreground/45"
          title={node.path}
        >
          {node.children.map(renderNode)}
        </FileTreeFolder>
      )
    }

    const file = node.change
    return (
      <ContextMenu key={`${commitHash}:${file.path}`}>
        <ContextMenuTrigger>
          <FileTreeFile
            className="w-full min-w-0 cursor-pointer"
            name={node.name}
            onClick={() => {
              void onOpenCommitDiff(commitHash, file.path)
            }}
            path={node.path}
            title={file.path}
          >
            <>
              {/* The status letter is this row's LEADING glyph and shares the
                  column a sibling folder's chevron occupies; a spacer in front
                  of it would hang every file one glyph right of its parent
                  directory. */}
              <CommitFileInfo className="flex-1 min-w-0 gap-1.5">
                <CommitFileStatus status={mapFileStatus(file.status)}>
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
              void onOpenCommitDiff(commitHash, file.path)
            }}
          >
            {tCommon("viewDiff")}
          </ContextMenuItem>
          <ContextMenuItem
            onSelect={() => {
              void onOpenFilePreview(file.path)
            }}
          >
            {tCommon("openFile")}
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    )
  }

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-2">
        <p className="text-2xs text-muted-foreground">{t("filesTitle")}</p>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            className="size-5"
            onClick={toggleExpanded}
            disabled={!canExpandAll && !canCollapseAll}
            title={canExpandAll ? t("expandAllFiles") : t("collapseAllFiles")}
            aria-label={
              canExpandAll ? t("expandAllFiles") : t("collapseAllFiles")
            }
          >
            {canExpandAll ? (
              <ChevronsUpDown className="size-3.5" />
            ) : (
              <ChevronsDownUp className="size-3.5" />
            )}
          </Button>
        </div>
      </div>
      <CommitFiles>
        <FileTree
          className="max-h-[32rem] overflow-auto rounded-md border-border/60 bg-transparent text-xs [&>div]:p-1"
          expanded={expandedPaths}
          onExpandedChange={setExpandedPaths}
        >
          <FileTreeFolder
            path={rootPath}
            name={folderName}
            suffix={`(${files.length})`}
            suffixClassName="text-muted-foreground/45"
            title={folderName}
          >
            {treeNodes.map(renderNode)}
          </FileTreeFolder>
        </FileTree>
      </CommitFiles>
    </div>
  )
}

function BranchSelector({
  branchList,
  currentBranch,
  selectedBranch,
  onBranchChange,
}: {
  branchList: GitBranchList
  currentBranch: string | null
  // null = the default "all branches" view (git log --all);
  // HEAD_BRANCH_FILTER = the dynamic "whatever branch I'm on" view.
  selectedBranch: string | null
  onBranchChange: (branch: string | null) => void
}) {
  const t = useTranslations("Folder.gitLogTab.branchSelector")
  const [popoverOpen, setPopoverOpen] = useState(false)

  const handleSelect = (branch: string | null) => {
    setPopoverOpen(false)
    if (branch !== selectedBranch) onBranchChange(branch)
  }

  const headSelected = isHeadFilter(selectedBranch)

  return (
    // The popover trigger and the clear (✕) button are siblings — never nested
    // — mirroring AuthorFilter. The rounded hover/open background lives on THIS
    // wrapper (not the trigger) so hovering either the trigger or the ✕ lights
    // the whole control as one pill (mirrors the bottom status-bar branch
    // selector). -ml-1 pulls the wrapper's left rim out to the 8px guide so the
    // pill lines up with the expanded commit card's border (8px row inset); the
    // trigger's pl-1 then drops the branch glyph onto the 13px guide (8px + 1px
    // card border + 4px), flush with each commit's leading push glyph. Default
    // (no selection) shows just the "Branch" label; a ✕ appears once a branch is
    // picked to clear back to the all-branches view.
    <div className="-ml-1 flex min-w-0 shrink items-center rounded-full transition-colors hover:bg-foreground/10 has-data-[state=open]:bg-foreground/10">
      <Popover open={popoverOpen} onOpenChange={setPopoverOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className={cn(
              "h-8 max-w-[12rem] min-w-0 shrink justify-start gap-1.5 rounded-full pl-1 text-sm font-normal hover:bg-transparent aria-expanded:bg-transparent dark:hover:bg-transparent",
              // Selected: the trailing chevron is gone (replaced by the sibling
              // ✕ button), so drop the trailing padding to pr-0.5. The ✕ button's
              // own ~5px of internal padding then leaves a tight ~7px gap from the
              // branch name instead of the old 13px chasm. Unselected keeps pr-2
              // so the chevron has breathing room.
              selectedBranch
                ? "pr-0.5 text-foreground/80 hover:text-foreground"
                : "pr-2 text-muted-foreground hover:text-foreground/80"
            )}
            title={
              headSelected
                ? currentBranch
                  ? t("headHintWithBranch", { branch: currentBranch })
                  : t("headHint")
                : (selectedBranch ?? t("label"))
            }
          >
            {headSelected ? (
              <LocateFixed className="size-3.5 shrink-0" />
            ) : (
              <GitBranch className="size-3.5 shrink-0" />
            )}
            <span
              className={cn(
                "min-w-0 truncate text-left",
                // "HEAD" is the label; the resolved branch beside it is the part
                // that gives when the pill runs out of room.
                headSelected && "shrink-0"
              )}
            >
              {headSelected ? t("head") : (selectedBranch ?? t("label"))}
            </span>
            {/* Under the HEAD filter the pill also spells out the branch it
                currently resolves to, so the view is readable at a glance. */}
            {headSelected && currentBranch && (
              <span className="min-w-0 shrink truncate text-xs text-muted-foreground">
                {currentBranch}
              </span>
            )}
            {!selectedBranch && (
              <ChevronDown className="size-3 shrink-0 opacity-50" />
            )}
          </Button>
        </PopoverTrigger>
        {/* `max-h-(--radix-popover-content-available-height)`: the list's own cap
            is a rem (`MAX_LIST_HEIGHT_REM`), so at high zoom it outgrows the room
            below the toolbar and the popup would run off the window. The list
            inside is flex-shrinkable, so it gives way to this cap. */}
        <PopoverContent
          align="start"
          sideOffset={6}
          className="max-h-(--radix-popover-content-available-height) w-72 overflow-hidden p-0"
        >
          <GitLogBranchFilterList
            branchList={branchList}
            currentBranch={currentBranch}
            selectedBranch={
              isHeadFilter(selectedBranch) ? null : selectedBranch
            }
            headSelected={headSelected}
            onSelectBranch={handleSelect}
            onSelectHead={() => handleSelect(HEAD_BRANCH_FILTER)}
          />
        </PopoverContent>
      </Popover>
      {selectedBranch && (
        <Button
          variant="ghost"
          size="icon"
          className="size-6 shrink-0 text-muted-foreground hover:bg-transparent hover:text-foreground dark:hover:bg-transparent"
          onClick={() => handleSelect(null)}
          title={t("clearBranchFilterAria")}
          aria-label={t("clearBranchFilterAria")}
        >
          <X className="size-3.5" />
        </Button>
      )}
    </div>
  )
}

// The header's git operations, worded exactly like the branch selector's — so
// seeing a commit you're behind on is one click from updating, and a commit you
// haven't shared is one click from pushing. Deliberately narrow: this is the
// COMMITS tab, so it carries only the remote-facing operations (the working-tree
// ones — commit, stash — belong to the changes tab's toolbar), the remote
// bookkeeping the branch selector no longer offers, and — pinned at the top —
// the plain reload of this very list.
function GitActionsMenu({
  actions,
  disabled,
  onManageRemotes,
  onRefresh,
  refreshing,
  className,
}: {
  actions: GitQuickActions
  /** Whole menu is inert — see the `folderStale` call site. */
  disabled: boolean
  onManageRemotes: () => void
  onRefresh: () => void
  refreshing: boolean
  className?: string
}) {
  const t = useTranslations("Folder.gitLogTab")
  const tBranch = useTranslations("Folder.branchDropdown")
  const tSelector = useTranslations("Folder.gitLogTab.branchSelector")
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        {/* The header's only icon button: same round hover circle as the changes
            tab's, so both tabs read as one control system. */}
        <Button
          variant="ghost"
          size="icon"
          disabled={disabled}
          className={cn(GIT_TOOLBAR_ICON_BUTTON_CLASS, className)}
          title={t("moreActions")}
          aria-label={t("moreActions")}
        >
          <MoreHorizontal className="size-3.5" />
        </Button>
      </DropdownMenuTrigger>
      {/* Blocked like the branch selector's operation list: refresh | incoming |
          outgoing | remote bookkeeping. Refresh leads because it's the one row
          that touches nothing but this list. */}
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuItem disabled={refreshing} onSelect={onRefresh}>
          <RefreshCw className={cn(refreshing && "animate-spin")} />
          {tSelector("refreshCommitHistory")}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem disabled={actions.running} onSelect={actions.pull}>
          <CloudDownload />
          {tBranch("pullCode")}
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={actions.running}
          onSelect={actions.fetchAll}
        >
          <CloudSync />
          {tBranch("fetchRemoteBranches")}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {/* Wrapped, not passed bare: onSelect hands the handler an Event, which
            openPushWindow would read as the branch to push. */}
        <DropdownMenuItem onSelect={() => actions.openPushWindow()}>
          <CloudUpload />
          {tBranch("pushCode")}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={onManageRemotes}>
          <Globe />
          {tBranch("manageRemotes")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function AuthorFilter({
  meName,
  recentAuthors,
  selectedAuthor,
  folderPath,
  onAuthorChange,
  onRemoveRecent,
}: {
  meName: string | null
  recentAuthors: string[]
  selectedAuthor: string | null
  folderPath: string | null
  onAuthorChange: (author: string | null) => void
  onRemoveRecent: (name: string) => void
}) {
  const t = useTranslations("Folder.gitLogTab.authorFilter")
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")
  // Clear the search each time the popover closes.
  const [prevOpen, setPrevOpen] = useState(open)
  if (open !== prevOpen) {
    setPrevOpen(open)
    if (!open) setQuery("")
  }

  // Backend author search: real repo authors matching the query, most-active
  // first (git shortlog). Runs only while typing — debounced — so there is no
  // upfront full-repo scan. Empty query falls back to the local quick-picks
  // (me + recents). Results are tagged with the query they belong to so the
  // render can tell "still searching" from "searched, no hits" without a separate
  // loading flag — and so the effect never calls setState synchronously.
  const [results, setResults] = useState<{
    folder: string | null
    query: string
    names: string[]
  }>({ folder: null, query: "", names: [] })
  const trimmed = query.trim()
  const isSearching = trimmed.length > 0

  useEffect(() => {
    if (!trimmed || !folderPath) return
    let cancelled = false
    const handle = setTimeout(() => {
      gitSearchAuthors(folderPath, trimmed, 20)
        .then((names) => {
          if (!cancelled)
            setResults({ folder: folderPath, query: trimmed, names })
        })
        .catch(() => {
          if (!cancelled)
            setResults({ folder: folderPath, query: trimmed, names: [] })
        })
    }, 200)
    return () => {
      cancelled = true
      clearTimeout(handle)
    }
  }, [folderPath, trimmed])

  // Results apply to the current query only once their tag matches BOTH the query
  // and the folder (so a popover surviving a repo switch never shows the previous
  // repo's same-query results); until then we're still searching (keeping the
  // "no matches" empty state hidden).
  const resultsReady =
    results.query === trimmed && results.folder === folderPath
  const searchResults = resultsReady ? results.names : []
  const searchPending = isSearching && !resultsReady

  // Recent authors minus "me" (me is pinned separately above them).
  const recentWithoutMe = useMemo(
    () => recentAuthors.filter((name) => name !== meName),
    [recentAuthors, meName]
  )

  // Fallback "Filter by "<query>"" item so an author can always be filtered by
  // the literal typed name even if the backend surfaced nothing (or is
  // unavailable). Hidden when the query already matches a surfaced candidate.
  const showCreate =
    isSearching &&
    trimmed !== meName &&
    !recentAuthors.includes(trimmed) &&
    !searchResults.includes(trimmed)

  const handleSelect = (author: string | null) => {
    setOpen(false)
    if (author !== selectedAuthor) onAuthorChange(author)
  }

  return (
    // The trigger and the clear (✕) button are siblings — never nested (no
    // button-in-button). The rounded hover/open background lives on THIS wrapper
    // (not the trigger) so hovering either the trigger or the ✕ lights the whole
    // control as one pill, mirroring the bottom status-bar branch selector.
    // pl-1 pr-2 matches the branch trigger so the user glyph sits the same 5px
    // inside its pill (13px guide), keeping both selectors' glyphs on one column.
    <div className="flex min-w-0 shrink items-center rounded-full transition-colors hover:bg-foreground/10 has-data-[state=open]:bg-foreground/10">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className={cn(
              "h-8 max-w-[9rem] min-w-0 shrink justify-start gap-1.5 rounded-full pl-1 text-sm font-normal hover:bg-transparent aria-expanded:bg-transparent dark:hover:bg-transparent",
              // Selected: chevron gone (replaced by the sibling ✕), so drop the
              // trailing padding to pr-0.5 — matches the branch trigger so the ✕
              // sits the same tight ~7px gap from the author name.
              selectedAuthor
                ? "pr-0.5 text-foreground/80 hover:text-foreground"
                : "pr-2 text-muted-foreground hover:text-foreground/80"
            )}
            title={selectedAuthor ?? t("filterByAuthorAria")}
            aria-label={t("filterByAuthorAria")}
          >
            <User className="size-3.5 shrink-0" />
            <span className="min-w-0 truncate text-left">
              {selectedAuthor ?? t("label")}
            </span>
            {!selectedAuthor && (
              <ChevronDown className="size-3 shrink-0 opacity-50" />
            )}
          </Button>
        </PopoverTrigger>
        <PopoverContent
          align="end"
          sideOffset={6}
          className="w-64 overflow-hidden p-0"
        >
          {/* shouldFilter=false: the quick-picks (me + recents) and the backend
              search results are both curated here; cmdk must not re-fuzzy-filter
              the already server-filtered results. */}
          <Command className="rounded-2xl" shouldFilter={false}>
            <CommandInput
              placeholder={t("searchPlaceholder")}
              aria-label={t("searchPlaceholder")}
              value={query}
              onValueChange={setQuery}
            />
            <CommandList>
              {isSearching ? (
                <>
                  {searchResults.length > 0 && (
                    <CommandGroup heading={t("matchingAuthors")}>
                      {searchResults.map((name) => (
                        <CommandItem
                          key={name}
                          value={`result:${name}`}
                          title={name}
                          onSelect={() => handleSelect(name)}
                        >
                          <User className="size-3.5 shrink-0 text-muted-foreground" />
                          <span className="min-w-0 flex-1 truncate">
                            {name}
                          </span>
                          {selectedAuthor === name && (
                            <Check className="size-3.5 shrink-0" />
                          )}
                        </CommandItem>
                      ))}
                    </CommandGroup>
                  )}
                  {showCreate && (
                    <CommandGroup>
                      <CommandItem
                        value={`literal:${trimmed}`}
                        onSelect={() => handleSelect(trimmed)}
                      >
                        <User className="size-3.5 shrink-0 text-muted-foreground" />
                        <span className="min-w-0 flex-1 truncate">
                          {t("filterByQuery", { query: trimmed })}
                        </span>
                      </CommandItem>
                    </CommandGroup>
                  )}
                  {!searchPending &&
                    searchResults.length === 0 &&
                    !showCreate && (
                      <div className="py-6 text-center text-sm text-muted-foreground">
                        {t("noAuthors")}
                      </div>
                    )}
                </>
              ) : (
                <>
                  {meName && (
                    <CommandGroup>
                      <CommandItem
                        value={`me:${meName}`}
                        title={meName}
                        onSelect={() => handleSelect(meName)}
                      >
                        <User className="size-3.5 shrink-0 text-muted-foreground" />
                        <span className="min-w-0 flex-1 truncate">
                          {meName}
                        </span>
                        <span className="shrink-0 rounded-sm bg-muted px-1 py-0.5 text-3xs text-muted-foreground">
                          {t("you")}
                        </span>
                        {selectedAuthor === meName && (
                          <Check className="size-3.5 shrink-0" />
                        )}
                      </CommandItem>
                    </CommandGroup>
                  )}
                  {recentWithoutMe.length > 0 && (
                    <CommandGroup heading={t("recent")}>
                      {recentWithoutMe.map((name) => (
                        <CommandItem
                          key={name}
                          value={`recent:${name}`}
                          title={name}
                          onSelect={() => handleSelect(name)}
                          className="group/recent"
                        >
                          <User className="size-3.5 shrink-0 text-muted-foreground" />
                          <span className="min-w-0 flex-1 truncate">
                            {name}
                          </span>
                          {selectedAuthor === name && (
                            <Check className="size-3.5 shrink-0" />
                          )}
                          {/* Remove this author from the recent history. Stops the
                              row's onSelect (cmdk selects on pointer-down/click) so
                              the click only deletes. Revealed on row hover/active. */}
                          <button
                            type="button"
                            title={t("removeFromRecent", { name })}
                            aria-label={t("removeFromRecent", { name })}
                            className="-mr-1 ml-0.5 grid size-5 shrink-0 place-items-center rounded-sm text-muted-foreground/60 opacity-0 transition hover:bg-foreground/10 hover:text-foreground group-hover/recent:opacity-100 group-data-[selected=true]/recent:opacity-100"
                            onPointerDown={(e) => {
                              e.preventDefault()
                              e.stopPropagation()
                            }}
                            onClick={(e) => {
                              e.preventDefault()
                              e.stopPropagation()
                              onRemoveRecent(name)
                            }}
                          >
                            <X className="size-3" />
                          </button>
                        </CommandItem>
                      ))}
                    </CommandGroup>
                  )}
                  {!meName && recentWithoutMe.length === 0 && (
                    <div className="py-6 text-center text-sm text-muted-foreground">
                      {t("noAuthors")}
                    </div>
                  )}
                </>
              )}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      {selectedAuthor && (
        <Button
          variant="ghost"
          size="icon"
          className="size-6 shrink-0 text-muted-foreground hover:bg-transparent hover:text-foreground dark:hover:bg-transparent"
          onClick={() => handleSelect(null)}
          title={t("clearAuthorFilterAria")}
          aria-label={t("clearAuthorFilterAria")}
        >
          <X className="size-3.5" />
        </Button>
      )}
    </div>
  )
}

function LogHeader({
  branchList,
  currentBranch,
  selectedBranch,
  onBranchChange,
  onRefresh,
  refreshing,
  meName,
  recentAuthors,
  selectedAuthor,
  folderPath,
  onAuthorChange,
  onRemoveRecent,
  isMobile,
  gitActions,
  gitActionsStale,
  onManageRemotes,
}: {
  branchList: GitBranchList
  currentBranch: string | null
  selectedBranch: string | null
  onBranchChange: (branch: string | null) => void
  onRefresh: () => void
  refreshing: boolean
  meName: string | null
  recentAuthors: string[]
  selectedAuthor: string | null
  folderPath: string | null
  onAuthorChange: (author: string | null) => void
  onRemoveRecent: (name: string) => void
  isMobile: boolean
  gitActions: GitQuickActions
  /** Deferred render still on the PREVIOUS folder — see the call sites. */
  gitActionsStale: boolean
  onManageRemotes: () => void
}) {
  // The FILTERS need refs to filter, the actions don't — so an empty branch list
  // hides the two pills, not the whole header. A repo created by `git init` has
  // no branch until its first commit (git_log returns an empty list rather than
  // an error there, so this tab renders normally), and that is exactly when
  // "manage remotes" matters most: adding the first remote before the first
  // push. This menu is now its only home, so the header must survive a repo with
  // no refs yet.
  const hasBranches =
    branchList.local.length > 0 || branchList.remote.length > 0

  return (
    <div
      className={cn(
        "flex shrink-0 items-center gap-1 border-b px-3",
        // Match the session-details / conversation / file detail headers:
        // desktop h-10 + lightened border; mobile keeps its own sizing.
        isMobile ? "border-border py-2" : "h-10 border-border/50"
      )}
    >
      {/* Branch selector + author filter sit together at the leading edge; the
          actions menu — the header's only button, refresh included — is pushed
          to the trailing rim with ml-auto (-mr-1 puts that rim on the header's
          8px guide). */}
      {hasBranches && (
        <>
          <BranchSelector
            branchList={branchList}
            currentBranch={currentBranch}
            selectedBranch={selectedBranch}
            onBranchChange={onBranchChange}
          />
          <AuthorFilter
            meName={meName}
            recentAuthors={recentAuthors}
            selectedAuthor={selectedAuthor}
            folderPath={folderPath}
            onAuthorChange={onAuthorChange}
            onRemoveRecent={onRemoveRecent}
          />
        </>
      )}
      <GitActionsMenu
        actions={gitActions}
        disabled={gitActionsStale}
        onManageRemotes={onManageRemotes}
        onRefresh={onRefresh}
        refreshing={refreshing}
        className="-mr-1 ml-auto"
      />
    </div>
  )
}

export function GitLogTab() {
  const ime = useImeGuard()
  const t = useTranslations("Folder.gitLogTab")
  const tCommon = useTranslations("Folder.common")
  const isMobile = useIsMobile()
  // Defer the folder so a cross-folder conversation-tab switch commits first and
  // this tab's git-log refetch + commit-row render runs in a non-blocking
  // transition a frame later instead of janking the switch (see the file-tree /
  // changes tabs). Path-keyed effects ride the deferred folder.
  const { activeFolder } = useActiveFolder()
  const folder = useDeferredValue(activeFolder)
  // True while the deferred render lags a cross-folder switch. During that gap we
  // render the loading skeleton (below) instead of the PREVIOUS folder's commit
  // rows: besides keeping the heavy rebuild off the switch commit, unmounting
  // those rows closes any open row ContextMenu (which portals outside this
  // subtree) so a click can't route a commit diff / file opener to the NEW active
  // folder (openers default to it when folderId is omitted — see
  // resolveTargetFolder). Clears the instant the deferred render catches up.
  const folderStale = activeFolder?.id !== folder?.id
  const { openCommitDiff, openFilePreview } = useWorkspaceActions()
  const workspaceState = useWorkspaceStateStore(folder?.path ?? null)
  const isGitRepo = workspaceState.isGitRepo
  const [entries, setEntries] = useState<GitLogEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notAGitRepo, setNotAGitRepo] = useState(false)
  const [openByCommit, setOpenByCommit] = useState<Record<string, boolean>>({})
  const [branchesByCommit, setBranchesByCommit] = useState<
    Record<string, string[]>
  >({})
  const [branchesLoading, setBranchesLoading] = useState<
    Record<string, boolean>
  >({})
  const [branchesError, setBranchesError] = useState<Record<string, string>>({})

  // Branch filter state
  const [branchList, setBranchList] = useState<GitBranchList>({
    local: [],
    remote: [],
    worktree_branches: [],
    main_worktree_branch: null,
  })
  const [currentBranch, setCurrentBranch] = useState<string | null>(null)
  // null = the default "all branches" view (git log --all); a name narrows to
  // that branch.
  const [selectedBranch, setSelectedBranch] = useState<string | null>(null)

  // Author filter state (IDEA-style "User" filter). The dropdown is seeded from
  // the current user (`meName`) plus a locally-persisted `recentAuthors` list —
  // no full-repo author scan. `selectedAuthor` (null = all authors) is threaded
  // into every gitLog call so the whole history filters server-side.
  const [meName, setMeName] = useState<string | null>(null)
  const [recentAuthors, setRecentAuthors] = useState<string[]>([])
  const [selectedAuthor, setSelectedAuthor] = useState<string | null>(null)

  // The folder path whose persisted selection is currently applied. When the
  // (deferred) folder changes we restore that folder's saved branch/author
  // filter *synchronously during render* — before the first log fetch — so the
  // reopened view lands on the same filter in a single fetch, with no
  // all-branches flash. This is React's "adjust state during render" pattern
  // (https://react.dev/reference/react/useState#storing-information-from-previous-renders);
  // it re-renders in place, so fetchLog below is computed with the restored
  // values. Reading localStorage here is a pure, idempotent read.
  const [selectionFolder, setSelectionFolder] = useState<string | null>(null)
  const currentSelectionPath = folder?.path ?? null
  if (currentSelectionPath !== selectionFolder) {
    setSelectionFolder(currentSelectionPath)
    const restored = currentSelectionPath
      ? loadSelection(currentSelectionPath)
      : { branch: null, author: null }
    setSelectedBranch(restored.branch)
    setSelectedAuthor(restored.author)
  }
  // Mirror the live selection into refs so refreshBranches (keyed only on the
  // folder path) can validate/persist against the latest values without being
  // recreated — and re-running its effect — on every filter change.
  const selectedBranchRef = useRef(selectedBranch)
  selectedBranchRef.current = selectedBranch
  const selectedAuthorRef = useRef(selectedAuthor)
  selectedAuthorRef.current = selectedAuthor

  // Lazy per-commit file changes: the log list is fetched without file stats
  // (withFiles=false) for speed; a commit's files load on demand when its row is
  // expanded (mirrors branchesByCommit above).
  const [filesByCommit, setFilesByCommit] = useState<
    Record<string, GitLogFileChange[]>
  >({})
  const [filesLoading, setFilesLoading] = useState<Record<string, boolean>>({})
  const [filesError, setFilesError] = useState<Record<string, string>>({})
  const [newBranchTarget, setNewBranchTarget] =
    useState<CommitBranchTarget | null>(null)
  const [newBranchName, setNewBranchName] = useState("")
  const [creatingBranch, setCreatingBranch] = useState(false)
  const [resetTarget, setResetTarget] = useState<CommitResetTarget | null>(null)
  const [resetMode, setResetMode] = useState<GitResetMode>("mixed")
  const [resetting, setResetting] = useState(false)
  const [manageRemotesOpen, setManageRemotesOpen] = useState(false)

  // ── Pagination (infinite scroll) ──────────────────────────────────────────
  // The log loads in PAGE_SIZE pages via the backend `skip` offset and appends
  // older commits as the scroll nears the end (see loadMore / handleVirtuaScroll).
  const [hasMore, setHasMore] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  // virtua binds to the real OverlayScrollbars viewport (surfaced via the
  // ScrollArea onViewportRef bridge once OS initializes): a ref for the
  // Virtualizer scrollRef + a state flag so it only mounts once the viewport
  // exists (mirrors the sidebar conversation list).
  const viewportRef = useRef<HTMLElement | null>(null)
  const [viewportEl, setViewportEl] = useState<HTMLElement | null>(null)
  const handleViewportRef = useCallback((element: HTMLElement | null) => {
    viewportRef.current = element
    setViewportEl(element)
  }, [])
  const virtualizerRef = useRef<VirtualizerHandle>(null)
  // Generation guard: bumped on every page-0 (re)load so an in-flight loadMore
  // can't append stale commits after a refresh / branch switch. Live snapshots
  // (entries length, hasMore, in-flight) are mirrored to refs so the scroll
  // callback stays referentially stable and never acts on stale state.
  const logGenRef = useRef(0)
  const loadingMoreRef = useRef(false)
  // True while a page-0 (re)load is in flight: appends must not start (their
  // captured length would be reset by the load, punching an offset gap) until it
  // settles.
  const fetchingRef = useRef(false)
  // Kept in sync with state every render AND eagerly on each mutation below, so
  // the scroll callback / loadMore read the just-committed length within the same
  // tick (before React re-renders) and request the correct next offset.
  const entriesRef = useRef(entries)
  entriesRef.current = entries
  const hasMoreRef = useRef(hasMore)
  hasMoreRef.current = hasMore
  // Always the latest folder path, so an in-flight gitCurrentUser() from a
  // previous folder can be discarded if it resolves after a switch (see
  // refreshCurrentUser).
  const folderPathRef = useRef(folder?.path ?? null)
  folderPathRef.current = folder?.path ?? null
  // Bumped ONLY when the per-commit file maps are cleared (a non-inline full
  // reload / folder switch). fetchCommitFiles captures it so a request from a
  // superseded view discards its loading/error/data writes — preventing a stale
  // request from masking a newer one after the maps were cleared and re-fetched.
  // Deliberately NOT bumped on an inline refresh (which keeps the maps), so a
  // pending request's finally still clears its loading flag (no latch).
  const filesGenRef = useRef(0)

  // Close the create-branch / reset / manage-remotes dialogs the instant the
  // ACTIVE folder changes (keyed on the live id, not the deferred `folder`) so a
  // dialog opened under the previous folder can't create-branch / reset / rewrite
  // remotes against the new one after the deferred render settles. The
  // branch/author selection is NOT reset here — it's restored per folder during
  // render (see the selectionFolder adjustment above), which lands each folder's
  // saved filter before its first fetch, so the previous folder's filter never
  // leaks into the new query.
  useEffect(() => {
    setNewBranchTarget(null)
    setResetTarget(null)
    setManageRemotesOpen(false)
  }, [activeFolder?.id])

  const pushStatusLabels = useMemo(
    () => ({
      pushed: t("pushStatus.pushed"),
      notPushed: t("pushStatus.notPushed"),
      unknown: t("pushStatus.unknown"),
    }),
    [t]
  )
  const folderName = useMemo(() => {
    const path = folder?.path ?? ""
    const parts = path.split(/[\\/]/).filter(Boolean)
    return (parts[parts.length - 1] ?? path) || t("workspace")
  }, [folder?.path, t])

  const handleBranchChange = useCallback(
    (branch: string | null) => {
      setSelectedBranch(branch)
      // Persist the pick (paired with the current author) so the tab restores it
      // the next time this folder is opened.
      if (folder?.path) {
        saveSelection(folder.path, { branch, author: selectedAuthor })
      }
    },
    [folder?.path, selectedAuthor]
  )

  const handleAuthorChange = useCallback(
    (author: string | null) => {
      setSelectedAuthor(author)
      if (folder?.path) {
        // Persist the pick (paired with the current branch) so it restores the
        // next time this folder is opened.
        saveSelection(folder.path, { branch: selectedBranch, author })
        // Remember the chosen author so it surfaces in the dropdown next time.
        if (author) {
          const path = folder.path
          setRecentAuthors((prev) => {
            const next = addRecentAuthor(prev, author)
            saveRecentAuthors(path, next)
            return next
          })
        }
      }
    },
    [folder?.path, selectedBranch]
  )

  const handleRemoveRecent = useCallback(
    (name: string) => {
      if (!folder?.path) return
      const path = folder.path
      setRecentAuthors((prev) => {
        const next = removeRecentAuthor(prev, name)
        saveRecentAuthors(path, next)
        return next
      })
    },
    [folder?.path]
  )

  // Current user (`git config user.name`) for the "me" quick-pick. Cheap — no
  // history walk. Guards on the live folder path so a slow response from a
  // previous folder can't overwrite the current folder's value after a switch.
  const refreshCurrentUser = useCallback(async () => {
    const path = folder?.path
    if (!path) return
    try {
      const me = await gitCurrentUser(path)
      if (folderPathRef.current !== path) return
      setMeName(me)
    } catch {
      if (folderPathRef.current !== path) return
      setMeName(null)
    }
  }, [folder?.path])

  const refreshBranches = useCallback(async () => {
    const path = folder?.path
    if (!path) return
    try {
      const [allBranches, current] = await Promise.all([
        gitListAllBranches(path),
        getGitBranch(path),
      ])
      // Ignore a response that resolved after a folder switch.
      if (folderPathRef.current !== path) return
      setBranchList(allBranches)
      setCurrentBranch(current)
      // A restored/selected branch may no longer exist (deleted since it was
      // last used). Once we have this repo's authoritative branch list, drop it
      // back to the all-branches view and forget it so we don't keep restoring a
      // dead branch (which would make the first fetch error). The HEAD sentinel
      // is exempt — it is never in the branch list yet always resolves (see
      // isLiveBranchSelection). Read via refs so this callback stays keyed only
      // on the folder path — else it'd recreate, and re-run its effect, on every
      // filter change. Otherwise leave selectedBranch alone: the default is "all
      // branches" (null) and an explicit pick is owned by the branch selector /
      // restored per folder.
      if (!isLiveBranchSelection(selectedBranchRef.current, allBranches)) {
        setSelectedBranch(null)
        saveSelection(path, { branch: null, author: selectedAuthorRef.current })
      }
    } catch {
      // Silently ignore — branches dropdown won't appear
    }
  }, [folder?.path])

  // Fetch branches on mount and when git presence flips — the preflight
  // check in `git_list_all_branches` would short-circuit on non-git folders
  // anyway, but skipping the call saves an unnecessary round trip.
  useEffect(() => {
    if (!isGitRepo || notAGitRepo) return
    void refreshBranches()
  }, [isGitRepo, notAGitRepo, refreshBranches])

  // Resolve the current user for the "me" quick-pick on mount / git-presence
  // flip (cheap; the git-events effect below also refreshes it).
  useEffect(() => {
    if (!isGitRepo || notAGitRepo) {
      setMeName(null)
      return
    }
    void refreshCurrentUser()
  }, [isGitRepo, notAGitRepo, refreshCurrentUser])

  // Load the per-folder recently-filtered authors when the folder changes.
  useEffect(() => {
    setRecentAuthors(folder?.path ? loadRecentAuthors(folder.path) : [])
  }, [folder?.path])

  const fetchCommitBranches = useCallback(
    async (fullHash: string) => {
      if (!folder?.path) return
      if (branchesByCommit[fullHash] || branchesLoading[fullHash]) return

      setBranchesLoading((prev) => ({ ...prev, [fullHash]: true }))
      setBranchesError((prev) => {
        if (!prev[fullHash]) return prev
        const next = { ...prev }
        delete next[fullHash]
        return next
      })

      try {
        const branches = await gitCommitBranches(folder.path, fullHash)
        setBranchesByCommit((prev) => ({ ...prev, [fullHash]: branches }))
      } catch (e) {
        setBranchesError((prev) => ({
          ...prev,
          [fullHash]: toErrorMessage(e),
        }))
      } finally {
        setBranchesLoading((prev) => ({ ...prev, [fullHash]: false }))
      }
    },
    [branchesByCommit, branchesLoading, folder?.path]
  )

  // Lazy-load a commit's file changes on expand (git_log runs with
  // withFiles=false so the list stays fast). Mirrors fetchCommitBranches, guarded
  // by filesGenRef: every write is skipped once a full reload / folder switch has
  // cleared the maps (bumping the gen), so a superseded request can neither latch
  // "loading" nor mask a newer request's result with a stale error. An inline
  // refresh does NOT bump the gen, so a pending request still settles normally.
  const fetchCommitFiles = useCallback(
    async (fullHash: string) => {
      if (!folder?.path) return
      if (filesByCommit[fullHash] || filesLoading[fullHash]) return

      const clearError = (prev: Record<string, string>) => {
        if (!prev[fullHash]) return prev
        const next = { ...prev }
        delete next[fullHash]
        return next
      }

      const gen = filesGenRef.current
      setFilesLoading((prev) => ({ ...prev, [fullHash]: true }))
      setFilesError(clearError)

      try {
        const files = await gitCommitFiles(folder.path, fullHash)
        if (gen !== filesGenRef.current) return
        setFilesByCommit((prev) => ({ ...prev, [fullHash]: files }))
        // Clear any prior error so a stale error can't mask loaded files.
        setFilesError(clearError)
      } catch (e) {
        if (gen !== filesGenRef.current) return
        setFilesError((prev) => ({ ...prev, [fullHash]: toErrorMessage(e) }))
      } finally {
        if (gen === filesGenRef.current) {
          setFilesLoading((prev) => ({ ...prev, [fullHash]: false }))
        }
      }
    },
    [filesByCommit, filesLoading, folder?.path]
  )

  const fetchLog = useCallback(
    async (options?: { inline?: boolean; branch?: string | null }) => {
      const inline = options?.inline ?? false
      const branch = options?.branch ?? selectedBranch
      if (!folder?.path) return
      if (inline) {
        setRefreshing(true)
      } else {
        setLoading(true)
        setOpenByCommit({})
        setBranchesByCommit({})
        setBranchesLoading({})
        setBranchesError({})
        setFilesByCommit({})
        setFilesLoading({})
        setFilesError({})
        // Invalidate any in-flight fetchCommitFiles bound to the now-cleared
        // maps so a superseded result can't overwrite the fresh view.
        filesGenRef.current++
      }
      setError(null)
      setNotAGitRepo(false)
      // New generation: this page-0 (re)load supersedes any in-flight loadMore
      // and blocks new appends (via fetchingRef) until it settles. It does NOT
      // touch loadingMoreRef — a superseded append still owns and releases its
      // own lock, so freeing it here could free a newer append's lock.
      const gen = ++logGenRef.current
      fetchingRef.current = true
      setLoadingMore(false)
      try {
        // selectedBranch === null → the default "all branches" view. Always
        // skip file stats (withFiles=false) for speed; a commit's files load
        // lazily on expand.
        const result = await gitLog(
          folder.path,
          PAGE_SIZE,
          branch ?? undefined,
          undefined,
          0,
          selectedAuthor ?? undefined,
          branch === null,
          false
        )
        if (gen !== logGenRef.current) return
        setEntries(result.entries)
        entriesRef.current = result.entries
        const more = result.entries.length >= PAGE_SIZE
        setHasMore(more)
        hasMoreRef.current = more
        if (inline) {
          const commitHashes = new Set(
            result.entries.map((entry) => entry.full_hash)
          )
          setOpenByCommit((prev) =>
            filterRecordByCommitHashes(prev, commitHashes)
          )
          setBranchesByCommit((prev) =>
            filterRecordByCommitHashes(prev, commitHashes)
          )
          setBranchesLoading((prev) =>
            filterRecordByCommitHashes(prev, commitHashes)
          )
          setBranchesError((prev) =>
            filterRecordByCommitHashes(prev, commitHashes)
          )
          setFilesByCommit((prev) =>
            filterRecordByCommitHashes(prev, commitHashes)
          )
          setFilesLoading((prev) =>
            filterRecordByCommitHashes(prev, commitHashes)
          )
          setFilesError((prev) =>
            filterRecordByCommitHashes(prev, commitHashes)
          )
        }
      } catch (e) {
        if (gen !== logGenRef.current) return
        if (isNotAGitRepoError(e)) {
          setNotAGitRepo(true)
          // Workspace state will flip isGitRepo within the next watch flush;
          // clear entries so stale log data does not linger while we wait.
          setEntries([])
          entriesRef.current = []
          setHasMore(false)
          hasMoreRef.current = false
        } else {
          setError(toErrorMessage(e))
        }
      } finally {
        // Only the latest generation owns the UI. Clear BOTH mode flags (so an
        // inline refresh superseded by a full reload — or vice versa — can't
        // latch a spinner/skeleton) and reopen appends.
        if (gen === logGenRef.current) {
          fetchingRef.current = false
          setRefreshing(false)
          setLoading(false)
        }
      }
    },
    [folder?.path, selectedBranch, selectedAuthor]
  )

  useEffect(() => {
    setNotAGitRepo(false)
  }, [folder?.path])

  const handleRefresh = useCallback(() => {
    void fetchLog({ inline: true })
    void refreshCurrentUser()
  }, [fetchLog, refreshCurrentUser])

  // Append the next page (older commits) via the backend `skip` offset. Reads
  // live length/flags from refs; a generation mismatch means a page-0 reload
  // (refresh / branch switch) superseded us, so the result is discarded.
  const loadMore = useCallback(async () => {
    if (!folder?.path) return
    // Bail while a page-0 (re)load is in flight — its result resets the list, so
    // the length captured here would request a wrong offset and drop commits.
    // Single-flight via loadingMoreRef; fetchLog never touches that lock, so this
    // call is its sole owner and releasing it below can't free a newer append.
    if (fetchingRef.current || loadingMoreRef.current || !hasMoreRef.current) {
      return
    }
    loadingMoreRef.current = true
    setLoadingMore(true)
    const gen = logGenRef.current
    const skip = entriesRef.current.length
    try {
      const result = await gitLog(
        folder.path,
        PAGE_SIZE,
        selectedBranch ?? undefined,
        undefined,
        skip,
        selectedAuthor ?? undefined,
        selectedBranch === null,
        false
      )
      if (gen !== logGenRef.current) return
      const next = [...entriesRef.current, ...result.entries]
      entriesRef.current = next
      setEntries(next)
      const more = result.entries.length >= PAGE_SIZE
      hasMoreRef.current = more
      setHasMore(more)
    } catch {
      // Stop auto-paginating on error; the manual refresh retries from page 0.
      if (gen === logGenRef.current) {
        hasMoreRef.current = false
        setHasMore(false)
      }
    } finally {
      loadingMoreRef.current = false
      setLoadingMore(false)
    }
  }, [folder?.path, selectedBranch, selectedAuthor])

  // virtua reports the scroll offset each frame; fetch the next page once the
  // window nears the estimated end.
  const handleVirtuaScroll = useCallback(
    (offset: number) => {
      const handle = virtualizerRef.current
      if (
        !handle ||
        fetchingRef.current ||
        loadingMoreRef.current ||
        !hasMoreRef.current
      ) {
        return
      }
      if (offset + handle.viewportSize >= handle.scrollSize - LOAD_MORE_PX) {
        void loadMore()
      }
    },
    [loadMore]
  )

  const handleOpenNewBranchDialog = useCallback((entry: GitLogEntry) => {
    setNewBranchName("")
    setNewBranchTarget({
      fullHash: entry.full_hash,
      shortHash: entry.hash,
    })
  }, [])

  const handleCreateBranchFromCommit = useCallback(async () => {
    const name = newBranchName.trim()
    if (!folder?.path || !newBranchTarget || !name || creatingBranch) return

    setCreatingBranch(true)
    try {
      await gitNewBranch(folder.path, name, newBranchTarget.fullHash)
      setNewBranchTarget(null)
      setNewBranchName("")
      // Keep the "all branches" view; just refresh branch metadata (currentBranch
      // drives reset gating). The all-branches commit set is unchanged.
      await refreshBranches()
      toast.success(t("toasts.createdAndSwitchedNewBranch"), {
        description: t("toasts.newBranchFromCommit", {
          name,
          shortHash: newBranchTarget.shortHash,
        }),
      })
    } catch (error) {
      toast.error(t("toasts.createBranchFailed"), {
        description: toErrorMessage(error),
      })
    } finally {
      setCreatingBranch(false)
    }
  }, [
    creatingBranch,
    folder?.path,
    newBranchName,
    newBranchTarget,
    refreshBranches,
    t,
  ])

  // Reset always targets the CURRENT branch — allowed from the all-branches
  // view, the HEAD view, or while viewing the current branch by name; blocked
  // only while viewing a DIFFERENT specific branch (see canResetFromSelection).
  const isResetAllowed = useMemo(
    () => canResetFromSelection(currentBranch, selectedBranch),
    [currentBranch, selectedBranch]
  )

  const handleOpenResetDialog = useCallback((entry: GitLogEntry) => {
    setResetMode("mixed")
    setResetTarget({
      fullHash: entry.full_hash,
      shortHash: entry.hash,
      message: entry.message,
    })
  }, [])

  const handleResetCurrentBranchToCommit = useCallback(async () => {
    if (
      !folder?.path ||
      !currentBranch ||
      !resetTarget ||
      !isResetAllowed ||
      resetting
    ) {
      return
    }

    setResetting(true)
    try {
      await gitReset(folder.path, resetTarget.fullHash, resetMode)
      await refreshBranches()
      await fetchLog({ inline: true })
      if (folder.id) {
        void emitEvent("folder://git-branch-changed", {
          folder_id: folder.id,
        })
      }
      toast.success(t("toasts.resetSuccess"), {
        description: t("toasts.resetSuccessDescription", {
          branch: currentBranch,
          shortHash: resetTarget.shortHash,
          mode: t(`dialogs.reset.modes.${resetMode}.label`),
        }),
      })
      setResetTarget(null)
      setResetMode("mixed")
    } catch (error) {
      toast.error(t("toasts.resetFailed"), {
        description: toErrorMessage(error),
      })
    } finally {
      setResetting(false)
    }
  }, [
    currentBranch,
    fetchLog,
    folder?.path,
    folder?.id,
    isResetAllowed,
    refreshBranches,
    resetMode,
    resetTarget,
    resetting,
    t,
  ])

  useEffect(() => {
    if (!folder?.path) return
    // Only fetch when workspaceState says we're in a git repo. When it flips
    // (user runs `git init` / deletes `.git` externally), this effect re-runs
    // and either re-fetches or clears the log to stay aligned with the other
    // workspace panels.
    if (!isGitRepo) {
      setNotAGitRepo(false)
      setEntries([])
      setError(null)
      setLoading(false)
      return
    }
    void fetchLog()
  }, [folder?.path, isGitRepo, fetchLog])

  // What to run when a git event for the active folder arrives. Held in a ref so
  // the subscription effect below can depend only on `folder` — NOT on fetchLog /
  // refreshBranches / refreshCurrentUser, whose identities change on every branch
  // or author switch. Without this, each filter change would tear down and
  // re-register all three Tauri listeners (and widen the async-subscribe leak
  // window below); with it, the listeners persist across filter changes and
  // always call the latest fetchLog (current branch/author).
  const onGitEventRef = useRef<() => void>(() => {})
  useEffect(() => {
    onGitEventRef.current = () => {
      void refreshBranches()
      void refreshCurrentUser()
      void fetchLog({ inline: true })
    }
  }, [refreshBranches, refreshCurrentUser, fetchLog])

  // Keep the HEAD filter honest across checkouts made OUTSIDE the app. In-app
  // branch switches already refresh through folder://git-branch-changed; a
  // `git checkout` in a terminal emits nothing, so we ride the active folder's
  // existing git-HEAD poll (app-workspace-context, every ~10s) and refresh when
  // it reports a different HEAD. Read from `gitHeads` — written ONLY by that
  // poll — rather than `branches`, which fetchFolders also seeds from a possibly
  // stale DB column, and which collapses "detached" and "not polled yet" into
  // the same null.
  const polledHead = useAppWorkspaceStore((s) =>
    folder ? (s.gitHeads.get(folder.id) ?? null) : null
  )
  // What the poll last saw HEAD pointing at: the branch name, or the commit when
  // detached (a detached HEAD has no name, so branch↔detached and
  // detached→another-commit checkouts would otherwise be invisible). null while
  // the folder is unpolled / not a repo — never compared against.
  const polledHeadSignature =
    polledHead?.is_repo === true
      ? (polledHead.branch ?? polledHead.short_sha)
      : null
  const lastPolledHeadRef = useRef<{
    folderId: number
    signature: string | null
  } | null>(null)
  useEffect(() => {
    const folderId = folder?.id ?? null
    if (folderId == null) {
      lastPolledHeadRef.current = null
      return
    }
    const prev = lastPolledHeadRef.current
    lastPolledHeadRef.current = { folderId, signature: polledHeadSignature }
    // First reading for this folder (mount / folder switch): there is nothing to
    // compare against, and the folder's own load already fetched current state.
    if (!prev || prev.folderId !== folderId) return
    if (
      polledHeadSignature === null ||
      prev.signature === polledHeadSignature
    ) {
      return
    }
    // Only the HEAD view is dynamic — every other selection pins a fixed ref.
    // Recording above stays unconditional so a filter change never compares
    // against a signature from several checkouts ago.
    if (folderStale || !isHeadFilter(selectedBranch)) return
    onGitEventRef.current()
  }, [folder?.id, polledHeadSignature, folderStale, selectedBranch])

  // Refresh branches & log on branch change, commit, or push. Keyed on the
  // numeric folder id (not the folder object) so a same-id object replacement
  // from the active-folder context can't churn the subscriptions or open a brief
  // window where a git event is missed. subscribe() is async (a Tauri IPC round
  // trip), so this effect can be cleaned up before a subscription resolves: the
  // `cancelled` flag both silences a callback that fires after cleanup and makes
  // a listener that RESOLVES after cleanup detach itself immediately, instead of
  // leaking a zombie whose unlisten fn would land in an array the cleanup already
  // walked (that zombie would keep firing stale-filter refetches on later events).
  const folderId = folder?.id ?? null

  // Header actions (pull / fetch / push / commit / stash) share the branch
  // selector's machinery. `onCompleted` runs the same handler as the git event
  // subscription below — branches AND log, since "fetch remote branches" exists
  // precisely to surface refs the branch selector doesn't know yet. It can't
  // rely on that subscription: `folder://git-branch-changed` is emitted through
  // the Tauri bridge, so it never arrives in server/web mode. On desktop both
  // fire; `fetchLog` supersedes by generation, so the extra pass is harmless.
  const gitActions = useGitQuickActions({
    folderId,
    folderPath: folder?.path ?? null,
    onCompleted: () => onGitEventRef.current(),
  })

  useEffect(() => {
    if (folderId == null) return
    let cancelled = false
    const unlistens: (() => void)[] = []

    const events = [
      "folder://git-branch-changed",
      "folder://git-commit-succeeded",
      "folder://git-push-succeeded",
    ] as const

    events.forEach((eventName) => {
      subscribe<{ folder_id: number }>(eventName, (payload) => {
        if (cancelled || payload.folder_id !== folderId) return
        onGitEventRef.current()
      })
        .then((fn) => {
          if (cancelled) {
            fn()
            return
          }
          unlistens.push(fn)
        })
        .catch((err) => {
          console.error(`[GitLogTab] failed to listen ${eventName}:`, err)
        })
    })

    return () => {
      cancelled = true
      unlistens.forEach((fn) => fn())
    }
  }, [folderId])

  if (!folder) {
    return <AuxPanelNoFolderEmpty />
  }

  // The header — and so its actions menu — is live in every branch below, so the
  // dialog that menu opens has to mount alongside each of them. Saving rewrites
  // the repo's remotes, which the log's push status is computed against, so it
  // runs the same refresh as an incoming git event.
  //
  // Keyed by path so a folder switch REMOUNTS it: unlike the branch chip (one
  // instance per conversation tile, pinned to that tile's folder) this tab
  // follows the active folder, and the dialog holds its remote drafts in its own
  // state. Merely closing it on a switch — which the effect above does — would
  // leave repo A's drafts in a component whose `folderPath` is now B, and a
  // reopen re-reads the list asynchronously, so a Save landing before that read
  // resolves would delete/rewrite B's remotes from A's drafts. Remounting drops
  // the drafts with the folder they belong to.
  const remoteManageDialog = (
    <RemoteManageDialog
      key={folder.path}
      open={manageRemotesOpen}
      onOpenChange={setManageRemotesOpen}
      folderPath={folder.path}
      onSaved={() => onGitEventRef.current()}
    />
  )

  // `folderStale`: skeleton over the previous folder's commits while the deferred
  // render catches up to the switch (see the declaration above).
  if (loading || folderStale) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <LogHeader
          branchList={branchList}
          currentBranch={currentBranch}
          selectedBranch={selectedBranch}
          onBranchChange={handleBranchChange}
          onRefresh={handleRefresh}
          refreshing={loading || refreshing}
          meName={meName}
          recentAuthors={recentAuthors}
          selectedAuthor={selectedAuthor}
          folderPath={folder?.path ?? null}
          onAuthorChange={handleAuthorChange}
          onRemoveRecent={handleRemoveRecent}
          isMobile={isMobile}
          gitActions={gitActions}
          gitActionsStale={folderStale}
          onManageRemotes={() => setManageRemotesOpen(true)}
        />
        <ScrollArea className="min-h-0 flex-1 px-3 py-3">
          <div className="space-y-4">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="flex gap-2.5">
                <Skeleton className="size-6 shrink-0 rounded-full" />
                <div className="flex-1 space-y-1.5">
                  <Skeleton className="h-3.5 w-3/4" />
                  <Skeleton className="h-2.5 w-1/2" />
                  <Skeleton className="h-2.5 w-2/5" />
                </div>
              </div>
            ))}
          </div>
        </ScrollArea>
        {/* The header (and its actions menu) is live while the log loads, so
            its dialogs have to mount here too. */}
        {gitActions.dialogs}
        {remoteManageDialog}
      </div>
    )
  }

  if (!isGitRepo || notAGitRepo) {
    return (
      <ScrollArea className="h-full px-3 py-3">
        <div className="flex flex-col items-center justify-center min-h-full gap-1 p-6 text-center">
          <GitBranch className="size-5 text-muted-foreground/60" aria-hidden />
          <p className="text-sm font-medium">{t("notAGitRepoTitle")}</p>
          <p className="text-xs text-muted-foreground">
            {t("notAGitRepoHint")}
          </p>
          {isGitRepo && (
            <Button
              variant="ghost"
              size="xs"
              className="mt-2"
              onClick={() => {
                void fetchLog()
              }}
            >
              {t("retry")}
            </Button>
          )}
        </div>
      </ScrollArea>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <LogHeader
        branchList={branchList}
        currentBranch={currentBranch}
        selectedBranch={selectedBranch}
        onBranchChange={handleBranchChange}
        onRefresh={handleRefresh}
        refreshing={loading || refreshing}
        meName={meName}
        recentAuthors={recentAuthors}
        selectedAuthor={selectedAuthor}
        folderPath={folder?.path ?? null}
        onAuthorChange={handleAuthorChange}
        onRemoveRecent={handleRemoveRecent}
        isMobile={isMobile}
        gitActions={gitActions}
        gitActionsStale={folderStale}
        onManageRemotes={() => setManageRemotesOpen(true)}
      />
      {error ? (
        <ScrollArea className="min-h-0 flex-1 px-3 py-3">
          <div className="pt-1 text-xs text-destructive">
            <p>{error}</p>
            <Button
              variant="ghost"
              size="xs"
              className="mt-2"
              onClick={() => {
                void fetchLog()
              }}
            >
              {t("retry")}
            </Button>
          </div>
        </ScrollArea>
      ) : entries.length === 0 ? (
        <div className="flex flex-1 items-center justify-center p-4">
          <p className="text-center text-xs text-muted-foreground">
            {t("noCommitsFound")}
          </p>
        </div>
      ) : (
        <ContextMenu>
          <ContextMenuTrigger asChild>
            <ScrollArea
              className="min-h-0 flex-1"
              onViewportRef={handleViewportRef}
            >
              {/* Full-bleed, virtualized commit timeline: one continuous rail,
                  windowed by virtua bound to the OverlayScrollbars viewport.
                  Older pages load on demand as the scroll nears the end (see
                  handleVirtuaScroll), so the whole history stays reachable. */}
              {viewportEl ? (
                <Virtualizer
                  ref={virtualizerRef}
                  scrollRef={viewportRef}
                  data={entries}
                  itemSize={56}
                  bufferSize={400}
                  onScroll={handleVirtuaScroll}
                >
                  {(entry, index) => {
                    const commitKey = entry.full_hash
                    const commitDate = parseDate(entry.date)
                    const pushStatus = getPushStatusMeta(
                      entry.pushed,
                      pushStatusLabels
                    )
                    const PushStatusIcon = pushStatus.icon
                    const commitBranches = branchesByCommit[commitKey]
                    const isBranchLoading = !!branchesLoading[commitKey]
                    const branchError = branchesError[commitKey]
                    // Lazily-loaded file changes for this commit (undefined until
                    // its row is first expanded).
                    const commitFiles = filesByCommit[commitKey]
                    const isFilesLoading = !!filesLoading[commitKey]
                    const filesLoadError = filesError[commitKey]
                    const isOpen = !!openByCommit[commitKey]

                    return (
                      <div key={entry.full_hash}>
                        <ContextMenu>
                          <ContextMenuTrigger asChild>
                            {/* px-2 floats the card off both rims; the first row
                                adds pt-2 so its gap below the header matches the
                                8px side gaps. The whole commit is one card (push
                                glyph lives inside the header), so right-clicking
                                anywhere on the row — padding included — opens its
                                menu. */}
                            <div
                              className={cn(
                                "px-2 py-0.5",
                                index === 0 && "pt-2"
                              )}
                            >
                              <Commit
                                className={cn(
                                  "rounded-lg border transition-colors",
                                  isOpen
                                    ? "border-border/60 bg-muted/20"
                                    : "border-transparent bg-transparent"
                                )}
                                onOpenChange={(open) => {
                                  setOpenByCommit((prev) => ({
                                    ...prev,
                                    [commitKey]: open,
                                  }))
                                  if (open) {
                                    void fetchCommitBranches(commitKey)
                                    void fetchCommitFiles(commitKey)
                                  }
                                }}
                                open={isOpen}
                              >
                                {/* Push glyph and chevron both land on the 13px
                                    guide — 8px row + 1px card border + 4px — now
                                    that the header's branch AND refresh glyphs
                                    both sit 13px off their own edge. px-1 is
                                    symmetric (RTL-safe): left = right = 13px. */}
                                <CommitHeader className="items-start gap-2 py-2 px-1 hover:opacity-100">
                                  {/* Push-status glyph leads the row — pushed /
                                      not-pushed / unknown, tinted by
                                      getPushStatusMeta. mt-0.5 centers it on the
                                      first message line. */}
                                  <span
                                    className="mt-0.5 flex shrink-0"
                                    title={pushStatus.label}
                                    aria-label={pushStatus.label}
                                    role="img"
                                  >
                                    <PushStatusIcon
                                      className={cn(
                                        "size-4",
                                        pushStatus.className
                                      )}
                                      aria-hidden
                                    />
                                  </span>
                                  <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                                    {/* Dim by default, darken on hover/open
                                        (group = CommitHeader) instead of a hover
                                        background — widens the readable area.
                                        Single line: the subject. */}
                                    <p className="truncate text-[0.8125rem] font-medium leading-snug text-foreground/70 transition-colors group-hover:text-foreground group-data-[state=open]:text-foreground">
                                      {entry.message}
                                    </p>
                                    <div className="flex min-w-0 items-center gap-1.5 text-2xs text-muted-foreground">
                                      <span className="min-w-0 truncate">
                                        {entry.author}
                                      </span>
                                      <span className="shrink-0 opacity-50">
                                        ·
                                      </span>
                                      <time
                                        className="shrink-0"
                                        dateTime={commitDate?.toISOString()}
                                        title={
                                          commitDate
                                            ? commitDate.toLocaleString()
                                            : entry.date
                                        }
                                      >
                                        {formatRelativeTime(entry.date, t)}
                                      </time>
                                      {/* Short hash pinned to this line's end:
                                          a # glyph + the abbrev, no chip
                                          background. ms-auto (not ml-auto) so it
                                          stays on the trailing edge under RTL. */}
                                      <span
                                        className="ms-auto flex shrink-0 items-center gap-0.5 font-mono text-3xs text-primary/80"
                                        title={entry.full_hash}
                                      >
                                        <Hash
                                          className="size-2.5"
                                          aria-hidden
                                        />
                                        <code>{entry.hash}</code>
                                      </span>
                                    </div>
                                  </div>
                                  <ChevronRight
                                    className="mt-0.5 size-3.5 shrink-0 text-muted-foreground/50 transition-transform group-hover:text-muted-foreground group-data-[state=open]:rotate-90"
                                    aria-hidden
                                  />
                                </CommitHeader>
                                <CommitContent className="p-2.5">
                                  <div className="space-y-3">
                                    <div className="grid grid-cols-[4rem_minmax(0,1fr)] items-center gap-x-2 gap-y-1 text-xs">
                                      <span className="text-muted-foreground">
                                        {t("hash")}
                                      </span>
                                      <span className="group/hash flex items-center gap-1 min-w-0">
                                        <code
                                          className="block min-w-0 flex-1 truncate font-mono"
                                          title={entry.full_hash}
                                        >
                                          {entry.full_hash}
                                        </code>
                                        <CommitCopyButton
                                          aria-label={t(
                                            "copyFullCommitHashAria",
                                            {
                                              hash: entry.full_hash,
                                            }
                                          )}
                                          className="size-5 shrink-0 opacity-0 transition-opacity group-hover/hash:opacity-100 group-focus-within/hash:opacity-100"
                                          hash={entry.full_hash}
                                          title={t("copyHash")}
                                        />
                                      </span>
                                      <span className="text-muted-foreground">
                                        {t("author")}
                                      </span>
                                      <span className="min-w-0 flex items-center gap-1">
                                        <span className="min-w-0 truncate">
                                          {entry.author}
                                        </span>
                                        <span className="shrink-0 text-muted-foreground">
                                          ·
                                        </span>
                                        <time
                                          className="shrink-0"
                                          dateTime={commitDate?.toISOString()}
                                        >
                                          {commitDate
                                            ? commitDate.toLocaleString()
                                            : entry.date}
                                        </time>
                                      </span>
                                    </div>
                                    {/* Long release messages are capped with a
                                        Show more / Show less toggle so the file
                                        tree below stays reachable. */}
                                    <GitLogCommitMessage
                                      message={entry.message}
                                    />
                                    {/* File changes load lazily on expand (the
                                        list query runs with withFiles=false).
                                        CommitFilesTree renders its own "Files"
                                        header, so the loading/error/empty states
                                        supply their own. */}
                                    {isFilesLoading && !commitFiles ? (
                                      <div className="space-y-1">
                                        <p className="text-2xs text-muted-foreground">
                                          {t("filesTitle")}
                                        </p>
                                        <p className="text-xs text-muted-foreground">
                                          {t("loadingFiles")}
                                        </p>
                                      </div>
                                    ) : filesLoadError ? (
                                      <div className="space-y-1">
                                        <p className="text-2xs text-muted-foreground">
                                          {t("filesTitle")}
                                        </p>
                                        <p className="text-xs text-destructive">
                                          {filesLoadError}
                                        </p>
                                      </div>
                                    ) : commitFiles &&
                                      commitFiles.length > 0 ? (
                                      <CommitFilesTree
                                        commitHash={entry.full_hash}
                                        files={commitFiles}
                                        folderName={folderName}
                                        onOpenCommitDiff={openCommitDiff}
                                        onOpenFilePreview={openFilePreview}
                                      />
                                    ) : (
                                      <div className="space-y-1">
                                        <p className="text-2xs text-muted-foreground">
                                          {t("filesTitle")}
                                        </p>
                                        <p className="text-xs text-muted-foreground">
                                          {t("noFileChangeDetails")}
                                        </p>
                                      </div>
                                    )}
                                    <div className="pt-3 space-y-1">
                                      <p className="text-2xs text-muted-foreground">
                                        {t("branchesTitle")}
                                      </p>
                                      {isBranchLoading ? (
                                        <p className="text-xs text-muted-foreground">
                                          {t("loadingBranches")}
                                        </p>
                                      ) : branchError ? (
                                        <p className="text-xs text-destructive">
                                          {branchError}
                                        </p>
                                      ) : commitBranches &&
                                        commitBranches.length > 0 ? (
                                        <div className="flex flex-wrap gap-1">
                                          {commitBranches.map((branch) => (
                                            <span
                                              key={`${commitKey}-${branch}`}
                                              className="rounded-md border border-border px-1.5 py-0.5 text-3xs text-muted-foreground"
                                              title={branch}
                                            >
                                              {branch}
                                            </span>
                                          ))}
                                        </div>
                                      ) : (
                                        <p className="text-xs text-muted-foreground">
                                          {t("noContainingBranches")}
                                        </p>
                                      )}
                                    </div>
                                  </div>
                                </CommitContent>
                              </Commit>
                            </div>
                          </ContextMenuTrigger>
                          <ContextMenuContent>
                            <ContextMenuItem
                              onSelect={() => {
                                handleOpenNewBranchDialog(entry)
                              }}
                            >
                              <GitBranchPlus className="h-3.5 w-3.5" />
                              {t("newBranch")}
                            </ContextMenuItem>
                            <ContextMenuItem
                              onSelect={() => {
                                void openCommitDiff(
                                  entry.full_hash,
                                  undefined,
                                  entry.message
                                )
                              }}
                            >
                              <GitCompare className="h-3.5 w-3.5" />
                              {tCommon("viewDiff")}
                            </ContextMenuItem>
                            <ContextMenuItem
                              disabled={!isResetAllowed}
                              onSelect={() => {
                                handleOpenResetDialog(entry)
                              }}
                            >
                              <RotateCcw className="size-3.5" />
                              {t("resetToHere")}
                            </ContextMenuItem>
                            {!isResetAllowed && (
                              <ContextMenuItem disabled>
                                {t("resetDisabledReasonNotCurrentBranchView")}
                              </ContextMenuItem>
                            )}
                            <ContextMenuItem
                              onSelect={() => {
                                void fetchLog()
                              }}
                            >
                              <RefreshCw className="size-3.5" />
                              {tCommon("refresh")}
                            </ContextMenuItem>
                            <ContextMenuItem
                              onSelect={() => {
                                if (!folder) return
                                openPushWindow(folder.id).catch((err) => {
                                  const msg = toErrorMessage(err)
                                  toast.error(
                                    t("toasts.openPushWindowFailed"),
                                    {
                                      description: msg,
                                    }
                                  )
                                })
                              }}
                            >
                              <Upload className="size-3.5" />
                              {tCommon("push")}
                            </ContextMenuItem>
                          </ContextMenuContent>
                        </ContextMenu>
                      </div>
                    )
                  }}
                </Virtualizer>
              ) : null}
              {loadingMore && (
                <div
                  className="flex items-center justify-center py-3"
                  aria-hidden
                >
                  <RefreshCw className="size-3.5 animate-spin text-muted-foreground" />
                </div>
              )}
            </ScrollArea>
          </ContextMenuTrigger>
          <ContextMenuContent>
            <ContextMenuItem
              onSelect={() => {
                void fetchLog()
              }}
            >
              <RefreshCw className="size-3.5" />
              {tCommon("refresh")}
            </ContextMenuItem>
            <ContextMenuItem
              onSelect={() => {
                if (!folder) return
                openPushWindow(folder.id).catch((err) => {
                  const msg = toErrorMessage(err)
                  toast.error(t("toasts.openPushWindowFailed"), {
                    description: msg,
                  })
                })
              }}
            >
              <Upload className="size-3.5" />
              {tCommon("push")}
            </ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
      )}

      <Dialog
        open={newBranchTarget !== null}
        onOpenChange={(open) => {
          if (!open && !creatingBranch) {
            setNewBranchTarget(null)
            setNewBranchName("")
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("dialogs.newBranchTitle")}</DialogTitle>
            <DialogDescription>
              {t("dialogs.newBranchDescription", {
                shortHash: newBranchTarget?.shortHash ?? "-",
              })}
            </DialogDescription>
          </DialogHeader>
          <Input
            placeholder={t("dialogs.branchNamePlaceholder")}
            value={newBranchName}
            onChange={(event) => setNewBranchName(event.target.value)}
            {...ime.props}
            onKeyDown={(event) => {
              if (ime.isComposing(event) || event.key !== "Enter") return
              void handleCreateBranchFromCommit()
            }}
            autoFocus
          />
          <DialogFooter>
            <Button
              variant="outline"
              disabled={creatingBranch}
              onClick={() => {
                setNewBranchTarget(null)
                setNewBranchName("")
              }}
            >
              {tCommon("cancel")}
            </Button>
            <Button
              disabled={!newBranchName.trim() || creatingBranch}
              onClick={() => {
                void handleCreateBranchFromCommit()
              }}
            >
              {tCommon("createAndSwitch")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={resetTarget !== null}
        onOpenChange={(open) => {
          if (!open && !resetting) {
            setResetTarget(null)
            setResetMode("mixed")
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("dialogs.reset.title")}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="grid grid-cols-[4.5rem_minmax(0,1fr)] items-start gap-x-2 gap-y-1 text-xs">
              <span className="text-muted-foreground">
                {t("dialogs.reset.branchLabel")}
              </span>
              <code className="block min-w-0 break-all font-mono">
                {currentBranch ?? "-"}
              </code>
              <span className="text-muted-foreground">
                {t("dialogs.reset.targetLabel")}
              </span>
              <code className="block min-w-0 break-all font-mono">
                {resetTarget?.shortHash ?? "-"}
              </code>
              <span className="text-muted-foreground">
                {t("dialogs.reset.messageLabel")}
              </span>
              <p className="max-h-32 min-w-0 overflow-y-auto whitespace-pre-wrap break-words">
                {resetTarget?.message || "-"}
              </p>
            </div>

            <div className="space-y-2">
              <p className="text-xs text-muted-foreground">
                {t("dialogs.reset.modeLabel")}
              </p>
              <RadioGroup
                value={resetMode}
                onValueChange={(value) => {
                  setResetMode(value as GitResetMode)
                }}
                className="space-y-2"
                disabled={resetting}
              >
                {(["soft", "mixed", "hard", "keep"] as const).map((mode) => {
                  const optionId = `git-reset-mode-${mode}`
                  return (
                    <label
                      key={mode}
                      htmlFor={optionId}
                      className="flex cursor-pointer items-start gap-2 rounded-md border border-border/60 p-2"
                    >
                      <RadioGroupItem
                        id={optionId}
                        value={mode}
                        className="mt-0.5"
                      />
                      <div className="min-w-0">
                        <p className="text-sm font-medium leading-tight">
                          {t(`dialogs.reset.modes.${mode}.label`)}
                        </p>
                        <p className="mt-0.5 whitespace-pre-line text-xs leading-relaxed text-muted-foreground">
                          {t(`dialogs.reset.modes.${mode}.description`)}
                        </p>
                      </div>
                    </label>
                  )
                })}
              </RadioGroup>
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              disabled={resetting}
              onClick={() => {
                setResetTarget(null)
                setResetMode("mixed")
              }}
            >
              {tCommon("cancel")}
            </Button>
            <Button
              disabled={resetting || !isResetAllowed || !resetTarget}
              onClick={() => {
                void handleResetCurrentBranchToCommit()
              }}
            >
              {t("dialogs.reset.confirmButton")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {gitActions.dialogs}
      {remoteManageDialog}
    </div>
  )
}
