"use client"

import { useState, useEffect, useCallback, useRef } from "react"
import { useTranslations } from "next-intl"
import { ChevronRight, ChevronUp, FileIcon, Home, Loader2 } from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { useImeGuard } from "@/hooks/use-ime-guard"
import { cn } from "@/lib/utils"
import { getHomeDirectory, listDirectoryWithFiles } from "@/lib/api"
import { parentFsPath } from "@/lib/path-utils"
import type { DirectoryItem } from "@/lib/types"

// One nesting level, in px. Matches the file tree's own step
// (FILE_TREE_INDENT_STEP_REM) so every tree in the app indents alike.
const INDENT_STEP_PX = 16

interface ServerFileBrowserDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSelect: (paths: string[]) => void
  title?: string
  initialPath?: string
  multiple?: boolean
}

export function ServerFileBrowserDialog({
  open,
  onOpenChange,
  onSelect,
  title,
  initialPath,
  multiple = true,
}: ServerFileBrowserDialogProps) {
  const t = useTranslations("ServerFileBrowser")
  const ime = useImeGuard()

  const [rootPath, setRootPath] = useState("")
  const [pathInput, setPathInput] = useState("")
  const [entries, setEntries] = useState<Map<string, DirectoryItem[]>>(
    new Map()
  )
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set())
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState<Set<string>>(new Set())
  const [error, setError] = useState<string | null>(null)

  const initialized = useRef(false)

  const loadEntries = useCallback(
    async (path: string): Promise<DirectoryItem[] | null> => {
      if (entries.has(path)) return entries.get(path)!

      setLoading((prev) => new Set(prev).add(path))
      setError(null)
      try {
        const result = await listDirectoryWithFiles(path)
        setEntries((prev) => new Map(prev).set(path, result))
        return result
      } catch {
        setError(t("errorLoadingDir"))
        return null
      } finally {
        setLoading((prev) => {
          const next = new Set(prev)
          next.delete(path)
          return next
        })
      }
    },
    [entries, t]
  )

  const navigateTo = useCallback(
    async (path: string) => {
      const result = await loadEntries(path)
      if (result !== null) {
        setRootPath(path)
        setPathInput(path)
        setExpandedPaths(new Set())
        setSelectedPaths(new Set())
      }
    },
    [loadEntries]
  )

  useEffect(() => {
    if (!open) {
      initialized.current = false
      return
    }
    if (initialized.current) return
    initialized.current = true

    const init = async () => {
      try {
        const startPath = initialPath || (await getHomeDirectory())
        setRootPath(startPath)
        setPathInput(startPath)
        setSelectedPaths(new Set())
        setExpandedPaths(new Set())
        setEntries(new Map())
        setError(null)
        setLoading(new Set([startPath]))

        const result = await listDirectoryWithFiles(startPath)
        setEntries(new Map([[startPath, result]]))
        setLoading(new Set())
      } catch {
        setError(t("errorLoadingDir"))
        setLoading(new Set())
      }
    }
    init()
  }, [open, initialPath, t])

  const handleToggleExpand = useCallback(
    async (path: string) => {
      const newExpanded = new Set(expandedPaths)
      if (newExpanded.has(path)) {
        newExpanded.delete(path)
        setExpandedPaths(newExpanded)
      } else {
        await loadEntries(path)
        newExpanded.add(path)
        setExpandedPaths(newExpanded)
      }
    },
    [expandedPaths, loadEntries]
  )

  const toggleFileSelection = useCallback(
    (path: string) => {
      setSelectedPaths((prev) => {
        const next = new Set(prev)
        if (next.has(path)) {
          next.delete(path)
        } else {
          if (!multiple) next.clear()
          next.add(path)
        }
        return next
      })
    },
    [multiple]
  )

  const handleConfirm = useCallback(() => {
    if (selectedPaths.size === 0) return
    onSelect(Array.from(selectedPaths))
    onOpenChange(false)
  }, [selectedPaths, onSelect, onOpenChange])

  const handleDoubleClickFile = useCallback(
    (path: string) => {
      onSelect([path])
      onOpenChange(false)
    },
    [onSelect, onOpenChange]
  )

  const handleNavigateUp = useCallback(() => {
    if (!rootPath) return
    const parent = parentFsPath(rootPath)
    if (!parent) return
    navigateTo(parent)
  }, [rootPath, navigateTo])

  const handleGoHome = useCallback(async () => {
    try {
      const home = await getHomeDirectory()
      navigateTo(home)
    } catch {
      setError(t("errorLoadingDir"))
    }
  }, [navigateTo, t])

  const handlePathInputKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (ime.isComposing(e)) return
      if (e.key === "Enter" && pathInput.trim()) {
        navigateTo(pathInput.trim())
      }
    },
    [ime, pathInput, navigateTo]
  )

  const renderEntries = (parentPath: string, depth: number) => {
    const children = entries.get(parentPath)
    const isLoading = loading.has(parentPath)

    if (isLoading) {
      return (
        <div
          className="flex items-center gap-2 py-2 text-sm text-muted-foreground"
          style={{ paddingLeft: `${depth * INDENT_STEP_PX + 8}px` }}
        >
          <Loader2 className="size-3.5 animate-spin" />
          <span>{t("loading")}</span>
        </div>
      )
    }

    if (!children) return null

    if (children.length === 0) {
      return (
        <div
          className="py-2 text-sm text-muted-foreground"
          style={{ paddingLeft: `${depth * INDENT_STEP_PX + 28}px` }}
        >
          {t("emptyDirectory")}
        </div>
      )
    }

    return children.map((entry) => {
      const isExpanded = expandedPaths.has(entry.path)
      const isSelected = selectedPaths.has(entry.path)

      return (
        <div key={entry.path}>
          <button
            className={cn(
              "flex w-full items-center gap-1 rounded px-2 py-1 text-left text-sm transition-colors hover:bg-muted/50",
              isSelected && "bg-accent text-accent-foreground"
            )}
            style={{ paddingLeft: `${depth * INDENT_STEP_PX + 8}px` }}
            onClick={() => {
              if (entry.isDir) {
                handleToggleExpand(entry.path)
              } else {
                toggleFileSelection(entry.path)
              }
            }}
            onDoubleClick={() => {
              if (!entry.isDir) handleDoubleClickFile(entry.path)
            }}
            type="button"
          >
            {/* One leading column for both kinds: a directory states itself
                with the expand chevron alone (no folder icon beside it), a file
                puts its icon in that same slot — so names line up at any
                depth. */}
            <span className="shrink-0 p-0.5">
              {entry.isDir ? (
                <ChevronRight
                  className={cn(
                    "size-3.5 text-muted-foreground transition-transform",
                    isExpanded && "rotate-90",
                    !entry.hasChildren && "invisible"
                  )}
                />
              ) : (
                <FileIcon className="size-3.5 text-muted-foreground" />
              )}
            </span>
            <span className="truncate">{entry.name}</span>
          </button>
          {entry.isDir && isExpanded && renderEntries(entry.path, depth + 1)}
        </div>
      )
    })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{title ?? t("title")}</DialogTitle>
        </DialogHeader>

        <div className="space-y-3">
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="icon"
              className="size-8 shrink-0"
              onClick={handleGoHome}
              title={t("goHome")}
              type="button"
            >
              <Home className="size-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="size-8 shrink-0"
              onClick={handleNavigateUp}
              title={t("navigateUp")}
              type="button"
            >
              <ChevronUp className="size-4" />
            </Button>
            <Input
              value={pathInput}
              onChange={(e) => setPathInput(e.target.value)}
              {...ime.props}
              onKeyDown={handlePathInputKeyDown}
              placeholder={t("pathPlaceholder")}
              className="flex-1 h-8 text-sm font-mono"
            />
          </div>

          <ScrollArea className="h-[20rem] rounded-md border">
            <div className="p-1">
              {renderEntries(rootPath, 0)}
              {error && !loading.size && (
                <div className="p-4 text-center text-sm text-destructive">
                  {error}
                </div>
              )}
            </div>
          </ScrollArea>

          {selectedPaths.size > 0 && (
            <p className="truncate text-xs text-muted-foreground">
              {t("selectedCount", { count: selectedPaths.size })}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            type="button"
          >
            {t("cancel")}
          </Button>
          <Button
            onClick={handleConfirm}
            disabled={selectedPaths.size === 0}
            type="button"
          >
            {t("select")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
