"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  Archive,
  ArchiveRestore,
  ChevronRight,
  FileIcon,
  Loader2,
} from "lucide-react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
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
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu"
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
  FileTreeIcon,
} from "@/components/ai-elements/file-tree"
import { DiffViewer } from "@/components/diff/diff-viewer"
import { ImageDiffView } from "@/components/diff/image-diff-view"
import {
  gitStashList,
  gitStashShow,
  gitStashApply,
  gitStashDrop,
  gitShowFile,
} from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"
import { loadImageDiffSides, type ImageDiffSides } from "@/lib/image-diff"
import { isBinaryImageFile, languageFromPath } from "@/lib/language-detect"
import type { GitStashEntry, GitStatusEntry } from "@/lib/types"
import { cn } from "@/lib/utils"

// --- File tree types & builder (same pattern as commit-dialog) ---

interface TreeFileNode {
  kind: "file"
  name: string
  path: string
  entry: GitStatusEntry
}

interface TreeDirNode {
  kind: "dir"
  name: string
  path: string
  children: TreeNode[]
}

type TreeNode = TreeFileNode | TreeDirNode

function buildFileTree(entries: GitStatusEntry[]): TreeNode[] {
  type BuildDir = {
    name: string
    path: string
    dirs: Map<string, BuildDir>
    files: TreeFileNode[]
  }

  const root: BuildDir = {
    name: "",
    path: "",
    dirs: new Map(),
    files: [],
  }

  for (const entry of entries) {
    const parts = entry.file.split("/").filter(Boolean)
    if (parts.length === 0) continue

    let current = root
    let currentPath = ""

    for (let i = 0; i < parts.length; i += 1) {
      const part = parts[i]
      const isLeaf = i === parts.length - 1
      currentPath = currentPath ? `${currentPath}/${part}` : part

      if (isLeaf) {
        current.files.push({
          kind: "file",
          name: part,
          path: currentPath,
          entry,
        })
      } else {
        const found = current.dirs.get(part)
        if (found) {
          current = found
        } else {
          const next: BuildDir = {
            name: part,
            path: currentPath,
            dirs: new Map(),
            files: [],
          }
          current.dirs.set(part, next)
          current = next
        }
      }
    }
  }

  function sortNodes(nodes: TreeNode[]) {
    return nodes.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1
      return a.name.localeCompare(b.name)
    })
  }

  function toNodes(dir: BuildDir): TreeNode[] {
    const dirs: TreeNode[] = Array.from(dir.dirs.values()).map((child) => ({
      kind: "dir",
      name: child.name,
      path: child.path,
      children: toNodes(child),
    }))
    return sortNodes([...dirs, ...dir.files])
  }

  return toNodes(root)
}

function collectDirPaths(entries: GitStatusEntry[]) {
  const paths = new Set<string>()
  for (const entry of entries) {
    const parts = entry.file.split("/").filter(Boolean)
    if (parts.length < 2) continue
    let p = ""
    for (let i = 0; i < parts.length - 1; i += 1) {
      p = p ? `${p}/${parts[i]}` : parts[i]
      paths.add(p)
    }
  }
  return paths
}

function statusColor(status: string) {
  switch (status.charAt(0).toUpperCase()) {
    case "A":
      return "text-green-500"
    case "D":
      return "text-red-500"
    case "M":
      return "text-blue-500"
    default:
      return "text-muted-foreground"
  }
}

// --- Main component ---

interface StashWorkspaceProps {
  folderPath: string
}

export function StashWorkspace({ folderPath }: StashWorkspaceProps) {
  const t = useTranslations("Folder.branchDropdown.unstashDialog")

  const [stashes, setStashes] = useState<GitStashEntry[]>([])
  const [expandedStash, setExpandedStash] = useState<string | null>(null)
  const [stashFiles, setStashFiles] = useState<
    Record<string, GitStatusEntry[]>
  >({})
  const [filesLoading, setFilesLoading] = useState<string | null>(null)

  const [selectedFile, setSelectedFile] = useState<string | null>(null)
  const [selectedStashRef, setSelectedStashRef] = useState<string | null>(null)
  const [originalContent, setOriginalContent] = useState("")
  const [modifiedContent, setModifiedContent] = useState("")
  // Keyed by the (stash, file) it was loaded for: two quick selections can
  // settle out of order, and the key keeps one stash entry's pixels from being
  // painted under another's label.
  const [imageSides, setImageSides] = useState<{
    stashRef: string
    file: string
    sides: ImageDiffSides
  } | null>(null)

  const [listLoading, setListLoading] = useState(false)
  const [diffLoading, setDiffLoading] = useState(false)
  const diffRequestRef = useRef(0)
  const [actionLoading, setActionLoading] = useState(false)

  const loadStashes = useCallback(async () => {
    setListLoading(true)
    try {
      const list = await gitStashList(folderPath)
      setStashes(list)
    } catch (err) {
      toast.error(toErrorMessage(err))
    } finally {
      setListLoading(false)
    }
  }, [folderPath])

  useEffect(() => {
    loadStashes()
  }, [loadStashes])

  async function handleToggleStash(stashRef: string) {
    if (expandedStash === stashRef) {
      setExpandedStash(null)
      return
    }
    setExpandedStash(stashRef)

    if (!stashFiles[stashRef]) {
      setFilesLoading(stashRef)
      try {
        const fileList = await gitStashShow(folderPath, stashRef)
        setStashFiles((prev) => ({ ...prev, [stashRef]: fileList }))
      } catch (err) {
        toast.error(toErrorMessage(err))
      } finally {
        setFilesLoading(null)
      }
    }
  }

  async function handleSelectFile(stashRef: string, file: string) {
    // Only the newest selection may write to the diff pane: two loads can
    // settle in either order, and an older one landing last would overwrite
    // the current file's content and clear its spinner.
    const requestId = ++diffRequestRef.current
    setSelectedFile(file)
    setSelectedStashRef(stashRef)
    setDiffLoading(true)
    setImageSides(null)
    try {
      if (isBinaryImageFile(file)) {
        const sides = await loadImageDiffSides(
          folderPath,
          file,
          { kind: "ref", ref: `${stashRef}^` },
          { kind: "ref", ref: stashRef }
        )
        if (requestId !== diffRequestRef.current) return
        setImageSides({ stashRef, file, sides })
        return
      }
      const [orig, mod] = await Promise.all([
        gitShowFile(folderPath, file, stashRef + "^").catch(() => ""),
        gitShowFile(folderPath, file, stashRef).catch(() => ""),
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

  async function handleApply(stashRef: string) {
    setActionLoading(true)
    try {
      await gitStashApply(folderPath, stashRef)
      toast.success(t("applySuccess"))
    } catch (err) {
      toast.error(toErrorMessage(err))
    } finally {
      setActionLoading(false)
    }
  }

  async function handleDrop(stashRef: string) {
    setActionLoading(true)
    try {
      await gitStashDrop(folderPath, stashRef)
      toast.success(t("dropSuccess"))
      if (expandedStash === stashRef) {
        setExpandedStash(null)
      }
      if (selectedStashRef === stashRef) {
        setSelectedFile(null)
        setSelectedStashRef(null)
        setOriginalContent("")
        setModifiedContent("")
      }
      setStashFiles((prev) => {
        const next = { ...prev }
        delete next[stashRef]
        return next
      })
      await loadStashes()
    } catch (err) {
      toast.error(toErrorMessage(err))
    } finally {
      setActionLoading(false)
    }
  }

  // Render file tree nodes
  function renderNode(node: TreeNode, stashRef: string): React.ReactNode {
    if (node.kind === "dir") {
      return (
        <FileTreeFolder key={node.path} name={node.name} path={node.path}>
          {node.children.map((child) => renderNode(child, stashRef))}
        </FileTreeFolder>
      )
    }

    return (
      <ContextMenu key={node.path}>
        <ContextMenuTrigger>
          <FileTreeFile name={node.name} path={node.path}>
            {/* The icon fills the leading column a sibling folder spends on its
                chevron; without it the file names hang one glyph LEFT of the
                directory names they sit under. */}
            <FileTreeIcon>
              <FileIcon className="size-4 text-muted-foreground" />
            </FileTreeIcon>
            <span className="flex-1 truncate text-left" title={node.path}>
              {node.name}
            </span>
            <span
              className={cn(
                "w-5 shrink-0 text-right text-xs font-bold",
                statusColor(node.entry.status)
              )}
            >
              {node.entry.status.charAt(0)}
            </span>
          </FileTreeFile>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem
            onClick={() => handleSelectFile(stashRef, node.path)}
          >
            {t("viewDiff")}
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    )
  }

  return (
    <ResizablePanelGroup direction="horizontal" className="h-full">
      {/* Left panel: stash cards */}
      <ResizablePanel defaultSize={35} minSize={25}>
        <ScrollArea className="h-full">
          {listLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : stashes.length === 0 ? (
            <div className="flex items-center justify-center py-12 text-sm text-muted-foreground">
              {t("noStashes")}
            </div>
          ) : (
            <div className="flex flex-col gap-2 p-2">
              {stashes.map((stash) => (
                <StashCard
                  key={stash.ref_name}
                  stash={stash}
                  isExpanded={expandedStash === stash.ref_name}
                  isLoadingFiles={filesLoading === stash.ref_name}
                  actionLoading={actionLoading}
                  files={stashFiles[stash.ref_name]}
                  selectedFile={
                    selectedStashRef === stash.ref_name ? selectedFile : null
                  }
                  onToggle={() => handleToggleStash(stash.ref_name)}
                  onApply={() => handleApply(stash.ref_name)}
                  onDrop={() => handleDrop(stash.ref_name)}
                  onSelectFile={(file) =>
                    handleSelectFile(stash.ref_name, file)
                  }
                  renderNode={(node) => renderNode(node, stash.ref_name)}
                />
              ))}
            </div>
          )}
        </ScrollArea>
      </ResizablePanel>

      <ResizableHandle />

      {/* Right panel: diff viewer */}
      <ResizablePanel defaultSize={65} minSize={40}>
        {diffLoading ? (
          <div className="flex h-full items-center justify-center">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : selectedFile && selectedStashRef ? (
          imageSides &&
          imageSides.file === selectedFile &&
          imageSides.stashRef === selectedStashRef ? (
            <ImageDiffView
              original={imageSides.sides.original}
              modified={imageSides.sides.modified}
              originalLabel={`${selectedStashRef}^ (${t("original")})`}
              modifiedLabel={`${selectedStashRef} (${t("modified")})`}
              className="h-full"
            />
          ) : (
            <DiffViewer
              original={originalContent}
              modified={modifiedContent}
              originalLabel={`${selectedStashRef}^ (${t("original")})`}
              modifiedLabel={`${selectedStashRef} (${t("modified")})`}
              language={languageFromPath(selectedFile)}
              className="h-full"
            />
          )
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            {t("selectFile")}
          </div>
        )}
      </ResizablePanel>
    </ResizablePanelGroup>
  )
}

// --- Stash Card Component ---

interface StashCardProps {
  stash: GitStashEntry
  isExpanded: boolean
  isLoadingFiles: boolean
  actionLoading: boolean
  files?: GitStatusEntry[]
  selectedFile: string | null
  onToggle: () => void
  onApply: () => void
  onDrop: () => void
  onSelectFile: (file: string) => void
  renderNode: (node: TreeNode) => React.ReactNode
}

function StashCard({
  stash,
  isExpanded,
  isLoadingFiles,
  actionLoading,
  files,
  selectedFile,
  onToggle,
  onApply,
  onDrop,
  onSelectFile,
  renderNode,
}: StashCardProps) {
  const t = useTranslations("Folder.branchDropdown.unstashDialog")
  const [confirmApplyOpen, setConfirmApplyOpen] = useState(false)
  const tree = useMemo(() => (files ? buildFileTree(files) : []), [files])

  const defaultExpanded = useMemo(
    () => (files ? collectDirPaths(files) : new Set<string>()),
    [files]
  )

  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger>
          <Collapsible open={isExpanded} onOpenChange={onToggle}>
            <div className="group rounded-lg border bg-card">
              <div className="relative flex items-center">
                <CollapsibleTrigger asChild>
                  <button
                    type="button"
                    className="flex w-full items-center gap-2 rounded-t-lg px-3 py-2 text-left text-sm transition-colors group-hover:bg-muted/50"
                    disabled={actionLoading}
                  >
                    <ChevronRight
                      className={cn(
                        "h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform",
                        isExpanded && "rotate-90"
                      )}
                    />
                    <Archive className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline gap-2">
                        <span className="text-xs font-medium text-muted-foreground">
                          {stash.ref_name}
                        </span>
                        <span className="truncate font-medium">
                          {stash.message}
                        </span>
                      </div>
                      <div className="flex gap-2 text-3xs text-muted-foreground/70">
                        <span>{stash.branch}</span>
                        <span>{stash.date}</span>
                      </div>
                    </div>
                  </button>
                </CollapsibleTrigger>
                <button
                  type="button"
                  className="absolute right-1.5 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-md opacity-0 transition-opacity hover:bg-accent group-hover:opacity-100"
                  title={t("apply") as string}
                  onClick={() => setConfirmApplyOpen(true)}
                  disabled={actionLoading}
                >
                  <ArchiveRestore className="h-3.5 w-3.5 text-muted-foreground" />
                </button>
              </div>

              <CollapsibleContent>
                <div className="border-t">
                  {/* File tree */}
                  {isLoadingFiles ? (
                    <div className="flex items-center justify-center py-4">
                      <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                    </div>
                  ) : tree.length > 0 ? (
                    <div className="px-2 pb-2">
                      <FileTree
                        defaultExpanded={defaultExpanded}
                        selectedPath={selectedFile ?? undefined}
                        onSelect={onSelectFile}
                        className="border-0 bg-transparent"
                      >
                        {tree.map(renderNode)}
                      </FileTree>
                    </div>
                  ) : null}
                </div>
              </CollapsibleContent>
            </div>
          </Collapsible>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem onClick={() => setConfirmApplyOpen(true)}>
            {t("apply")}
          </ContextMenuItem>
          <ContextMenuItem variant="destructive" onClick={onDrop}>
            {t("drop")}
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>

      <AlertDialog open={confirmApplyOpen} onOpenChange={setConfirmApplyOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("apply")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("confirmApply", { ref: stash.ref_name })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setConfirmApplyOpen(false)
                onApply()
              }}
            >
              {t("apply")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
