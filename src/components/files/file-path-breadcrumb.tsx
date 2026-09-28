"use client"

import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react"
import { ChevronRight, MoreHorizontal } from "lucide-react"
import { useTranslations } from "next-intl"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"
import { useWorkspaceActions } from "@/contexts/workspace-context"
import { findOwningFolder } from "@/lib/file-open-target"
import { joinFsPath } from "@/lib/path-utils"
import { getFileTree } from "@/lib/api"
import type { FileTreeNode } from "@/lib/types"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import {
  FileTree,
  FileTreeFile,
  FileTreeFolder,
} from "@/components/ai-elements/file-tree"
import { Skeleton } from "@/components/ui/skeleton"
import { ScrollArea } from "@/components/ui/scroll-area"
import { cn } from "@/lib/utils"

interface DirSegment {
  name: string
  absPath: string
}

function baseName(path: string): string {
  const parts = path.split(/[/\\]/).filter(Boolean)
  return parts[parts.length - 1] || path
}

// Collapse the middle of the trail once it grows past this many directory
// segments (root counts as one), so a deep path stays on one line: the root and
// the immediate parent survive, the rest fold behind a `…` popover.
const MAX_DIR_SEGMENTS = 3

/**
 * Path breadcrumb for the active file, shown in the desktop file-detail header.
 * The trailing segment is the file itself (static, bold); every leading segment
 * is a directory that opens a popover with a lazily-loaded file tree rooted at
 * that directory, so the user can jump to a sibling/nearby file without leaving
 * the header. Falls back to the plain title when the path can't be placed under
 * a known folder (e.g. a folder-less scratch file), so it never shows a raw
 * absolute path.
 */
export function FilePathBreadcrumb({
  path,
  fileName,
  isDirty,
}: {
  path: string
  fileName: string
  isDirty: boolean
}) {
  const allFolders = useAppWorkspaceStore((s) => s.allFolders)

  const model = useMemo(() => {
    const match = findOwningFolder(
      path,
      allFolders.map((f) => ({ id: f.id, path: f.path }))
    )
    if (!match) return null

    const rootName =
      allFolders.find((f) => f.id === match.folderId)?.name ??
      baseName(match.rootPath)
    const relParts = match.relPath.split("/").filter(Boolean)
    // The last part is the file; everything before it is an intermediate dir.
    const dirParts = relParts.slice(0, -1)

    const dirs: DirSegment[] = [{ name: rootName, absPath: match.rootPath }]
    let acc = match.rootPath
    for (const part of dirParts) {
      acc = joinFsPath(acc, part)
      dirs.push({ name: part, absPath: acc })
    }
    return { dirs, leaf: relParts[relParts.length - 1] || fileName }
  }, [allFolders, path, fileName])

  if (!model) {
    return (
      <span className="truncate text-foreground/90" title={path}>
        {fileName}
        {isDirty ? " *" : ""}
      </span>
    )
  }

  const { dirs, leaf } = model

  // Fold the middle directories behind a `…` popover when the trail is deep.
  let leadingDirs = dirs
  let collapsed: { hidden: DirSegment[]; parent: DirSegment } | null = null
  if (dirs.length > MAX_DIR_SEGMENTS) {
    const head = dirs[0]
    const parent = dirs[dirs.length - 1]
    const hidden = dirs.slice(1, dirs.length - 1)
    leadingDirs = [head]
    collapsed = { hidden, parent }
  }

  return (
    <div className="flex min-w-0 items-center gap-0.5 text-sm">
      {leadingDirs.map((dir) => (
        <Fragment key={dir.absPath}>
          <DirSegmentPopover
            label={dir.name}
            title={dir.name}
            absPath={dir.absPath}
            selectedAbsPath={path}
          />
          <Separator />
        </Fragment>
      ))}
      {collapsed && (
        <>
          {/* The `…` popover is rooted at the deepest hidden directory, so the
              folded parents are still reachable by drilling down from it. */}
          <DirSegmentPopover
            label={<MoreHorizontal className="h-3.5 w-3.5" />}
            title={collapsed.hidden.map((d) => d.name).join(" / ")}
            absPath={collapsed.hidden[collapsed.hidden.length - 1].absPath}
            selectedAbsPath={path}
          />
          <Separator />
          <DirSegmentPopover
            label={collapsed.parent.name}
            title={collapsed.parent.name}
            absPath={collapsed.parent.absPath}
            selectedAbsPath={path}
          />
          <Separator />
        </>
      )}
      <span className="truncate font-medium text-foreground/90" title={leaf}>
        {leaf}
        {isDirty ? " *" : ""}
      </span>
    </div>
  )
}

function Separator() {
  return <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground/50" />
}

function DirSegmentPopover({
  label,
  title,
  absPath,
  selectedAbsPath,
}: {
  label: ReactNode
  title: string
  absPath: string
  selectedAbsPath: string
}) {
  const [open, setOpen] = useState(false)
  const { openFilePreview } = useWorkspaceActions()

  const handleOpenFile = useCallback(
    (fileAbs: string) => {
      void openFilePreview(fileAbs)
      setOpen(false)
    },
    [openFilePreview]
  )

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          title={title}
          className={cn(
            // Pill, like every other button on this row — with `px-2` so the
            // label clears the curve (`px-1` had it touching).
            "flex min-w-0 shrink items-center rounded-full px-2 py-0.5",
            "text-muted-foreground transition-colors",
            "hover:bg-muted hover:text-foreground data-[state=open]:bg-muted data-[state=open]:text-foreground"
          )}
        >
          <span className="truncate">{label}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        sideOffset={6}
        className="w-72 rounded-xl p-1"
      >
        {open && (
          <DirectoryTree
            rootAbsPath={absPath}
            selectedAbsPath={selectedAbsPath}
            onOpenFile={handleOpenFile}
          />
        )}
      </PopoverContent>
    </Popover>
  )
}

function DirectoryTree({
  rootAbsPath,
  selectedAbsPath,
  onOpenFile,
}: {
  rootAbsPath: string
  selectedAbsPath: string
  onOpenFile: (fileAbs: string) => void
}) {
  const t = useTranslations("Folder.fileWorkspace")
  const [childrenByDir, setChildrenByDir] = useState<
    Map<string, FileTreeNode[]>
  >(() => new Map())
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const [rootLoading, setRootLoading] = useState(true)
  // Dedup guards for lazy loads — refs so the async guard never races a stale
  // render snapshot.
  const loadedDirsRef = useRef<Set<string>>(new Set())
  const loadingDirsRef = useRef<Set<string>>(new Set())

  const loadDir = useCallback(async (dirAbs: string) => {
    if (loadedDirsRef.current.has(dirAbs)) return
    if (loadingDirsRef.current.has(dirAbs)) return
    loadingDirsRef.current.add(dirAbs)
    try {
      const nodes = await getFileTree(dirAbs, 1)
      loadedDirsRef.current.add(dirAbs)
      setChildrenByDir((prev) => new Map(prev).set(dirAbs, nodes))
    } catch {
      // Treat an unreadable directory as empty rather than surfacing an error
      // in a lightweight breadcrumb popover.
      loadedDirsRef.current.add(dirAbs)
      setChildrenByDir((prev) => new Map(prev).set(dirAbs, []))
    } finally {
      loadingDirsRef.current.delete(dirAbs)
    }
  }, [])

  // Load the root level whenever the popover roots at a new directory.
  useEffect(() => {
    let cancelled = false
    setRootLoading(true)
    setExpanded(new Set())
    loadedDirsRef.current = new Set()
    loadingDirsRef.current = new Set()
    getFileTree(rootAbsPath, 1)
      .then((nodes) => {
        if (cancelled) return
        loadedDirsRef.current.add(rootAbsPath)
        setChildrenByDir(new Map([[rootAbsPath, nodes]]))
      })
      .catch(() => {
        if (cancelled) return
        loadedDirsRef.current.add(rootAbsPath)
        setChildrenByDir(new Map([[rootAbsPath, []]]))
      })
      .finally(() => {
        if (!cancelled) setRootLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [rootAbsPath])

  const handleExpandedChange = useCallback(
    (next: Set<string>) => {
      setExpanded(next)
      for (const dirAbs of next) {
        void loadDir(dirAbs)
      }
    },
    [loadDir]
  )

  // Which absolute paths are files (used to route onSelect — folder rows also
  // fire onSelect but should only toggle expansion, handled by the primitive).
  const fileAbsPaths = useMemo(() => {
    const set = new Set<string>()
    for (const [dirAbs, nodes] of childrenByDir) {
      for (const node of nodes) {
        if (node.kind === "file") set.add(joinFsPath(dirAbs, node.name))
      }
    }
    return set
  }, [childrenByDir])

  const handleSelect = useCallback(
    (nodePath: string) => {
      if (fileAbsPaths.has(nodePath)) onOpenFile(nodePath)
    },
    [fileAbsPaths, onOpenFile]
  )

  const renderNodes = useCallback(
    (dirAbs: string): ReactNode => {
      const nodes = childrenByDir.get(dirAbs)
      if (!nodes) return null
      return nodes.map((node) => {
        const abs = joinFsPath(dirAbs, node.name)
        if (node.kind === "dir") {
          return (
            <FileTreeFolder key={abs} path={abs} name={node.name}>
              {renderNodes(abs)}
            </FileTreeFolder>
          )
        }
        return <FileTreeFile key={abs} path={abs} name={node.name} />
      })
    },
    [childrenByDir]
  )

  if (rootLoading) {
    return (
      <div className="space-y-1 p-1">
        <Skeleton className="h-5 w-3/4" />
        <Skeleton className="h-5 w-2/3" />
        <Skeleton className="h-5 w-4/5" />
      </div>
    )
  }

  const rootNodes = childrenByDir.get(rootAbsPath)
  if (!rootNodes || rootNodes.length === 0) {
    return (
      <div className="px-2 py-3 text-center text-xs text-muted-foreground">
        {t("emptyDirectory")}
      </div>
    )
  }

  return (
    <ScrollArea className="max-h-72" x="scroll">
      <FileTree
        expanded={expanded}
        onExpandedChange={handleExpandedChange}
        selectedPath={selectedAbsPath}
        onSelect={handleSelect}
        className="border-0 bg-transparent text-[0.8125rem]"
      >
        {renderNodes(rootAbsPath)}
      </FileTree>
    </ScrollArea>
  )
}
