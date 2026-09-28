"use client"

import type { ReactElement } from "react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  ArrowRight,
  ChevronsDownUp,
  ChevronsUpDown,
  CloudOff,
  GitBranch,
  Loader2,
  Upload,
} from "lucide-react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable"
import {
  FileTree,
  FileTreeFile,
  FileTreeFolder,
} from "@/components/ai-elements/file-tree"
import {
  Commit,
  CommitContent,
  CommitFileAdditions,
  CommitFileChanges,
  CommitFileDeletions,
  CommitFileIcon,
  CommitFileInfo,
  CommitFilePath,
  CommitFiles,
  CommitFileStatus,
  CommitHash,
  CommitHeader,
  CommitInfo,
  CommitMessage,
  CommitMetadata,
  CommitTimestamp,
} from "@/components/ai-elements/commit"
import { DiffViewer } from "@/components/diff/diff-viewer"
import { ImageDiffView } from "@/components/diff/image-diff-view"
import { Button } from "@/components/ui/button"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { gitLog, gitPush, gitPushInfo, gitShowFile } from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"
import { loadImageDiffSides, type ImageDiffSides } from "@/lib/image-diff"
import { isBinaryImageFile, languageFromPath } from "@/lib/language-detect"
import type { GitLogEntry, GitLogFileChange, GitPushInfo } from "@/lib/types"
import {
  useGitCredential,
  type GitRemoteHint,
} from "@/contexts/git-credential-context"

// --- File tree types & builder (same as aux-panel-git-log-tab) ---

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

function parseDate(dateStr: string): Date | null {
  const date = new Date(dateStr)
  return Number.isNaN(date.getTime()) ? null : date
}

// --- Main component ---

interface PushWorkspaceProps {
  folderPath: string
  folderName: string
  folderId?: number | null
  /**
   * Branch to push, from the window's `?branch=` — set when the branch selector
   * opened this window for one specific branch. `null` targets the checked-out
   * branch, which is what every other entry point does.
   */
  initialBranch?: string | null
  onPushed?: () => void
}

export function PushWorkspace({
  folderPath,
  folderName,
  folderId,
  initialBranch = null,
  onPushed,
}: PushWorkspaceProps) {
  const t = useTranslations("Folder.pushWindow")
  const tLog = useTranslations("Folder.gitLogTab")
  const { withCredentialRetry } = useGitCredential()

  // The branch every query below is scoped to. Seeded from the URL, but the
  // window is reused per folder — a second per-branch push raises this same
  // window, so `push://retarget-branch` moves it (see the effect below).
  const [targetBranch, setTargetBranch] = useState<string | null>(initialBranch)
  // Bumped per commit-list load so a superseded response can't land (see
  // `loadCommits`).
  const commitsGenRef = useRef(0)
  // Mirrors the live target so an in-flight load can tell whether the branch it
  // describes is still the one on screen — the generation counter alone can't,
  // since a retarget resets state without going through `loadCommits`.
  const targetBranchRef = useRef(targetBranch)
  targetBranchRef.current = targetBranch
  const [pushInfoData, setPushInfoData] = useState<GitPushInfo | null>(null)
  const [selectedRemote, setSelectedRemote] = useState<string | null>(null)
  const [commits, setCommits] = useState<GitLogEntry[]>([])
  const [hasUpstream, setHasUpstream] = useState(true)
  const [listLoading, setListLoading] = useState(false)
  const [openByCommit, setOpenByCommit] = useState<Record<string, boolean>>({})
  const [pushing, setPushing] = useState(false)

  const [selectedFile, setSelectedFile] = useState<string | null>(null)
  const [selectedCommit, setSelectedCommit] = useState<string | null>(null)
  const [originalContent, setOriginalContent] = useState("")
  const [modifiedContent, setModifiedContent] = useState("")
  // Keyed by the (commit, file) it was loaded for: two quick selections can
  // settle out of order, and the key keeps one revision's pixels from being
  // painted under another's label.
  const [imageSides, setImageSides] = useState<{
    commit: string
    file: string
    sides: ImageDiffSides
  } | null>(null)
  const [diffLoading, setDiffLoading] = useState(false)
  const diffRequestRef = useRef(0)

  const unpushedCommits = useMemo(
    () => commits.filter((c) => c.pushed === false),
    [commits]
  )

  // Everything downstream — the remote picker, the commit list, the push button
  // — describes ONE branch, so a retarget has to tear all of it down together.
  //
  // Done DURING RENDER, not in the effect below. A passive effect commits one
  // render first, and in that render `targetBranch` is already B while
  // `pushInfoData`/`selectedRemote` still describe A — the push button is live
  // in that frame and `handlePush` would publish B to A's remote. It would also
  // let the `[selectedRemote, loadCommits]` effect fire once with A's remote
  // before the queued null lands. React's "adjust state during render" pattern
  // (https://react.dev/reference/react/useState#storing-information-from-previous-renders)
  // re-renders in place, so no such frame is ever committed. Same trick as the
  // git-log tab's per-folder filter restore.
  const [renderedBranch, setRenderedBranch] = useState(targetBranch)
  if (renderedBranch !== targetBranch) {
    setRenderedBranch(targetBranch)
    setPushInfoData(null)
    setSelectedRemote(null)
    setCommits([])
    // Back to the conservative default: paired with `commits: []` this keeps the
    // push button disabled until the new branch's log actually lands.
    setHasUpstream(true)
    setOpenByCommit({})
    setSelectedFile(null)
    setSelectedCommit(null)
  }

  // Load push info (branch, remotes, tracking remote) for the target branch.
  useEffect(() => {
    let cancelled = false
    gitPushInfo(folderPath, targetBranch)
      .then((info) => {
        // A retarget mid-flight supersedes this response — writing it would show
        // the previous branch's remote against the new branch's commits.
        if (cancelled) return
        setPushInfoData(info)
        // Default to tracking remote or first remote
        const defaultRemote =
          info.tracking_remote ??
          (info.remotes.length > 0 ? info.remotes[0].name : null)
        setSelectedRemote(defaultRemote)
      })
      .catch((err) => {
        if (cancelled) return
        toast.error(toErrorMessage(err))
      })
    return () => {
      cancelled = true
    }
  }, [folderPath, targetBranch])

  // A per-branch push raises the folder's existing push window instead of
  // opening a second one, so the backend tells the live window which branch it
  // should now be pointed at.
  //
  // Read off the Tauri channel directly, NOT through `subscribe()`: window
  // management always runs in the LOCAL backend, while on a remote connection
  // this window's transport is bound to the REMOTE server's event stream and
  // would never see this event. Outside Tauri the import just fails and this
  // no-ops — web mode reuses the window by name, which navigates it to the new
  // URL and re-reads `?branch=` instead.
  //
  // Scoped to THIS window rather than the global `listen()`: the backend
  // addresses the event with `emit_to(<label>)`, but Tauri delivers to any
  // JS listener registered with the default `Any` target regardless of that
  // address (see `match_any_or_filter`). Registering against this window's own
  // label is what makes the address actually bind — otherwise a push window for
  // the same folder id on a DIFFERENT connection (ids are scoped per
  // connection) would retarget itself too. The folder_id check below stays as a
  // second line of defence.
  useEffect(() => {
    if (folderId == null) return
    let unlisten: (() => void) | null = null
    let cancelled = false
    import("@tauri-apps/api/webviewWindow")
      .then(({ getCurrentWebviewWindow }) =>
        getCurrentWebviewWindow().listen<{
          folder_id: number
          // null = the plain "push" entry, i.e. back to the checked-out branch.
          branch: string | null
        }>("push://retarget-branch", (event) => {
          if (cancelled || event.payload.folder_id !== folderId) return
          setTargetBranch(event.payload.branch ?? null)
        })
      )
      .then((fn) => {
        if (cancelled) {
          fn()
          return
        }
        unlisten = fn
      })
      .catch(() => {
        // Not in Tauri — see above.
      })
    return () => {
      cancelled = true
      unlisten?.()
    }
  }, [folderId])

  // Deduplicate remotes (git remote -v returns fetch + push entries)
  const uniqueRemotes = useMemo(() => {
    if (!pushInfoData) return []
    const seen = new Set<string>()
    return pushInfoData.remotes.filter((r) => {
      if (seen.has(r.name)) return false
      seen.add(r.name)
      return true
    })
  }, [pushInfoData])

  const loadCommits = useCallback(
    async (remote?: string) => {
      // Two guards, because they catch different things:
      //
      // `gen` catches a NEWER LOAD (a remote switch) superseding this one.
      //
      // `branchAtRequest` catches a RETARGET, which `gen` cannot: the reset runs
      // in the render body without going through this function, so a load
      // already in flight for branch A keeps a matching generation and would
      // happily repaint A's commits over the cleared B window — leaving the user
      // reviewing A's commits under B's push button, which is the one thing this
      // window exists to prevent.
      const gen = ++commitsGenRef.current
      const branchAtRequest = targetBranch
      setListLoading(true)
      try {
        // `git_log` already scopes both the commit list AND the per-commit
        // pushed flag to a named branch, so targeting one needs nothing new.
        const result = await gitLog(
          folderPath,
          100,
          targetBranch ?? undefined,
          remote ?? undefined
        )
        if (
          gen !== commitsGenRef.current ||
          branchAtRequest !== targetBranchRef.current
        )
          return
        setCommits(result.entries)
        setHasUpstream(result.has_upstream)
      } catch (err) {
        if (
          gen !== commitsGenRef.current ||
          branchAtRequest !== targetBranchRef.current
        )
          return
        toast.error(toErrorMessage(err))
      } finally {
        // Deliberately NOT branch-guarded: whoever owns the latest generation
        // owns the flag, so it always clears and can't strand the spinner.
        if (gen === commitsGenRef.current) setListLoading(false)
      }
    },
    [folderPath, targetBranch]
  )

  // Reload commits when selected remote changes
  useEffect(() => {
    if (selectedRemote !== null) {
      loadCommits(selectedRemote)
    }
  }, [selectedRemote, loadCommits])

  async function handleSelectFile(commitHash: string, file: string) {
    // Only the newest selection may write to the diff pane: two loads can
    // settle in either order, and an older one landing last would overwrite
    // the current file's content and clear its spinner.
    const requestId = ++diffRequestRef.current
    setSelectedFile(file)
    setSelectedCommit(commitHash)
    setDiffLoading(true)
    setImageSides(null)
    try {
      if (isBinaryImageFile(file)) {
        const sides = await loadImageDiffSides(
          folderPath,
          file,
          // A parent that does not resolve — root commit, or a shallow
          // clone's boundary — reads as "nothing came before", matching what
          // git itself reports for those commits.
          { kind: "ref", ref: `${commitHash}~1`, missingRefIsAbsent: true },
          { kind: "ref", ref: commitHash }
        )
        if (requestId !== diffRequestRef.current) return
        setImageSides({ commit: commitHash, file, sides })
        return
      }
      const [orig, mod] = await Promise.all([
        gitShowFile(folderPath, file, `${commitHash}~1`).catch(() => ""),
        gitShowFile(folderPath, file, commitHash).catch(() => ""),
      ])
      if (requestId !== diffRequestRef.current) return
      setOriginalContent(orig)
      setModifiedContent(mod)
    } catch {
      if (requestId !== diffRequestRef.current) return
      setOriginalContent("")
      setModifiedContent("")
    } finally {
      if (requestId === diffRequestRef.current) setDiffLoading(false)
    }
  }

  async function handlePush() {
    setPushing(true)
    try {
      // Resolve the selected remote's URL for credential matching
      const remoteUrl = pushInfoData?.remotes.find(
        (r) => r.name === selectedRemote
      )?.url
      const hint: GitRemoteHint = remoteUrl ? { remoteUrl } : { folderPath }
      await withCredentialRetry(
        (creds) =>
          gitPush(folderPath, selectedRemote, creds, folderId, targetBranch),
        hint
      )
      onPushed?.()
    } catch (err) {
      toast.error(t("toasts.pushFailed"), {
        description: toErrorMessage(err),
      })
    } finally {
      setPushing(false)
    }
  }

  return (
    <div className="flex h-full flex-col">
      {/* Push target header: branch → remote/branch */}
      {pushInfoData && (
        <div className="flex items-center gap-2 border-b px-3 py-2">
          <GitBranch className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="truncate text-sm font-medium">
            {pushInfoData.branch}
          </span>
          {uniqueRemotes.length > 0 && (
            <ArrowRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          )}
          {uniqueRemotes.length === 0 ? null : uniqueRemotes.length <= 1 ? (
            <span className="truncate text-sm text-muted-foreground">
              {selectedRemote ?? "origin"}/{pushInfoData.branch}
            </span>
          ) : (
            <div className="flex items-center gap-1">
              <Select
                value={selectedRemote ?? ""}
                onValueChange={setSelectedRemote}
              >
                <SelectTrigger className="h-7 w-auto gap-1 border-none bg-transparent px-1.5 text-sm shadow-none">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {uniqueRemotes.map((r) => (
                    <SelectItem key={r.name} value={r.name}>
                      {r.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <span className="text-sm text-muted-foreground">
                /{pushInfoData.branch}
              </span>
            </div>
          )}
        </div>
      )}

      <ResizablePanelGroup direction="horizontal" className="min-h-0 flex-1">
        {/* Left panel: commit list */}
        <ResizablePanel defaultSize={35} minSize={25}>
          <div className="flex h-full flex-col">
            <ScrollArea className="min-h-0 flex-1">
              {listLoading ? (
                <div className="flex items-center justify-center py-12">
                  <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                </div>
              ) : uniqueRemotes.length === 0 ? (
                <div className="flex items-center justify-center px-4 py-12 text-center text-sm text-muted-foreground whitespace-pre-line">
                  {t("noRemoteConfigured")}
                </div>
              ) : unpushedCommits.length === 0 ? (
                <div className="flex items-center justify-center py-12 text-sm text-muted-foreground">
                  {!hasUpstream
                    ? t("newBranchNoPushedCommits")
                    : t("noUnpushedCommits")}
                </div>
              ) : (
                <div className="flex flex-col gap-2 p-2">
                  {unpushedCommits.map((entry) => {
                    const commitKey = entry.full_hash
                    const commitDate = parseDate(entry.date)
                    const isOpen = !!openByCommit[commitKey]

                    return (
                      <Commit
                        key={commitKey}
                        open={isOpen}
                        onOpenChange={(open) => {
                          setOpenByCommit((prev) => ({
                            ...prev,
                            [commitKey]: open,
                          }))
                        }}
                      >
                        <CommitHeader>
                          <CommitInfo className="min-w-0">
                            <CommitMessage className="line-clamp-1 leading-snug">
                              {entry.message}
                            </CommitMessage>
                            <CommitMetadata className="mt-1 min-w-0 flex items-center gap-1.5">
                              <span
                                className="inline-flex shrink-0"
                                title={t("unpushed")}
                              >
                                <CloudOff
                                  className="text-amber-500"
                                  size={12}
                                />
                              </span>
                              <span className="truncate">{entry.author}</span>
                              <CommitTimestamp
                                className="shrink-0"
                                date={commitDate ?? new Date()}
                              >
                                {formatRelativeTime(entry.date, tLog)}
                              </CommitTimestamp>
                              <CommitHash className="text-primary/70">
                                {entry.hash}
                              </CommitHash>
                            </CommitMetadata>
                          </CommitInfo>
                        </CommitHeader>
                        <CommitContent>
                          {entry.files.length === 0 ? (
                            <p className="text-xs text-muted-foreground">
                              {tLog("noFileChangeDetails")}
                            </p>
                          ) : (
                            <PushCommitFilesTree
                              commitHash={entry.full_hash}
                              files={entry.files}
                              folderName={folderName}
                              onSelectFile={(file) =>
                                handleSelectFile(entry.full_hash, file)
                              }
                            />
                          )}
                        </CommitContent>
                      </Commit>
                    )
                  })}
                </div>
              )}
            </ScrollArea>

            {/* Push button */}
            <div className="border-t p-2">
              <Button
                className="w-full"
                // Also inert until the branch on screen is fully described:
                // mid-retarget the remote and the commit list still belong to
                // the previous branch, and pushing then would publish this
                // branch to that branch's remote.
                disabled={
                  pushing ||
                  listLoading ||
                  !pushInfoData ||
                  uniqueRemotes.length === 0 ||
                  (hasUpstream && unpushedCommits.length === 0)
                }
                onClick={handlePush}
              >
                {pushing ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <Upload className="mr-2 h-4 w-4" />
                )}
                {t("push")}
                {unpushedCommits.length > 0 && ` (${unpushedCommits.length})`}
              </Button>
            </div>
          </div>
        </ResizablePanel>

        <ResizableHandle />

        {/* Right panel: diff viewer */}
        <ResizablePanel defaultSize={65} minSize={40}>
          {diffLoading ? (
            <div className="flex h-full items-center justify-center">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : selectedFile && selectedCommit ? (
            imageSides &&
            imageSides.file === selectedFile &&
            imageSides.commit === selectedCommit ? (
              <ImageDiffView
                original={imageSides.sides.original}
                modified={imageSides.sides.modified}
                originalLabel={`${selectedCommit.slice(0, 7)}~ (${t("before")})`}
                modifiedLabel={`${selectedCommit.slice(0, 7)} (${t("after")})`}
                className="h-full"
              />
            ) : (
              <DiffViewer
                original={originalContent}
                modified={modifiedContent}
                originalLabel={`${selectedCommit.slice(0, 7)}~ (${t("before")})`}
                modifiedLabel={`${selectedCommit.slice(0, 7)} (${t("after")})`}
                language={languageFromPath(selectedFile)}
                className="h-full"
              />
            )
          ) : (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
              {t("selectFileToViewDiff")}
            </div>
          )}
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  )
}

// --- Commit Files Tree for Push Window ---

function PushCommitFilesTree({
  commitHash,
  files,
  folderName,
  onSelectFile,
}: {
  commitHash: string
  files: GitLogFileChange[]
  folderName: string
  onSelectFile: (file: string) => void
}) {
  const tLog = useTranslations("Folder.gitLogTab")
  const rootPath = "__push_file_tree_root__"
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
      <FileTreeFile
        key={`${commitHash}:${file.path}`}
        className="w-full min-w-0 cursor-pointer"
        name={node.name}
        onClick={() => onSelectFile(file.path)}
        path={node.path}
        title={file.path}
      >
        <>
          {/* Leading glyph == the status letter, in the same column as a
              sibling folder's chevron (no spacer in front of it). */}
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
    )
  }

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-2">
        <p className="text-2xs text-muted-foreground">{tLog("filesTitle")}</p>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            className="size-5"
            onClick={toggleExpanded}
            disabled={!canExpandAll && !canCollapseAll}
            title={
              canExpandAll ? tLog("expandAllFiles") : tLog("collapseAllFiles")
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
