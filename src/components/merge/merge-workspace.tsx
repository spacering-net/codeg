"use client"

import { useCallback, useEffect, useRef, useState } from "react"
async function emitEvent(event: string, payload?: unknown) {
  try {
    const { emit } = await import("@tauri-apps/api/event")
    await emit(event, payload)
  } catch {
    /* not in Tauri */
  }
}
import { Check, FileWarning, Loader2, X, CheckCheck } from "lucide-react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Button } from "@/components/ui/button"
import {
  gitListConflicts,
  gitConflictFileVersions,
  gitResolveConflict,
  gitAbortOperation,
  gitContinueOperation,
  gitStartPullMerge,
} from "@/lib/api"
import { petCelebrate } from "@/lib/pet/api"
import { languageFromPath } from "@/lib/language-detect"
import { toErrorMessage } from "@/lib/app-error"
import type { GitConflictFileVersions } from "@/lib/types"
import { ThreePaneMergeEditor } from "./three-pane-merge-editor"

interface MergeWorkspaceProps {
  folderId: number
  folderPath: string
  operation: string
  upstreamCommit?: string
  onCompleted: () => void
  onAborted: () => void
}

export function MergeWorkspace({
  folderId,
  folderPath,
  operation,
  upstreamCommit,
  onCompleted,
  onAborted,
}: MergeWorkspaceProps) {
  const t = useTranslations("MergePage")
  const [files, setFiles] = useState<string[]>([])
  const [resolvedFiles, setResolvedFiles] = useState<Set<string>>(new Set())
  const [selectedFile, setSelectedFile] = useState<string | null>(null)
  const [versions, setVersions] = useState<GitConflictFileVersions | null>(null)
  const [loadingVersions, setLoadingVersions] = useState(false)
  const [resolving, setResolving] = useState(false)
  const [aborting, setAborting] = useState(false)
  const [completing, setCompleting] = useState(false)
  const currentContentRef = useRef<string>("")
  const [hasUnresolvedConflicts, setHasUnresolvedConflicts] = useState(true)
  const [preparing, setPreparing] = useState(false)

  async function loadConflicts() {
    try {
      // For pull operations, the merge was aborted during detection to keep
      // working tree clean. Re-start the merge to create conflict state.
      if (operation === "pull") {
        setPreparing(true)
        try {
          await gitStartPullMerge(folderPath, upstreamCommit)
        } finally {
          setPreparing(false)
        }
      }
      const conflictFiles = await gitListConflicts(folderPath)
      setFiles(conflictFiles)
      if (conflictFiles.length > 0 && !selectedFile) {
        selectFile(conflictFiles[0])
      }
    } catch (err) {
      toast.error(toErrorMessage(err))
    }
  }

  async function selectFile(file: string) {
    setSelectedFile(file)
    setLoadingVersions(true)
    try {
      const v = await gitConflictFileVersions(folderPath, file)
      setVersions(v)
      currentContentRef.current = v.base
      setHasUnresolvedConflicts(true)
    } catch (err) {
      toast.error(toErrorMessage(err))
      setVersions(null)
    } finally {
      setLoadingVersions(false)
    }
  }

  // Load conflict files on mount (declared after the loaders it calls)
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- kicks off the conflict fetch, whose loader flips `preparing` before awaiting
    loadConflicts()
  }, [folderPath]) // eslint-disable-line react-hooks/exhaustive-deps

  const handleContentChange = useCallback((content: string) => {
    currentContentRef.current = content
  }, [])

  const handleConflictStatusChange = useCallback((hasUnresolved: boolean) => {
    setHasUnresolvedConflicts(hasUnresolved)
  }, [])

  async function handleResolve() {
    if (!selectedFile) return

    const content = currentContentRef.current
    if (hasUnresolvedConflicts) {
      toast.warning(t("unresolvedConflicts"))
      return
    }

    setResolving(true)
    try {
      await gitResolveConflict(folderPath, selectedFile, content)
      setResolvedFiles((prev) => new Set([...prev, selectedFile]))

      // Notify parent window
      await emitEvent("folder://merge-conflict-resolved", {
        folder_id: folderId,
        file: selectedFile,
      })

      // Auto-select next unresolved file
      const nextUnresolved = files.find(
        (f) => f !== selectedFile && !resolvedFiles.has(f)
      )
      if (nextUnresolved) {
        selectFile(nextUnresolved)
      }
    } catch (err) {
      toast.error(toErrorMessage(err))
    } finally {
      setResolving(false)
    }
  }

  async function handleAbort() {
    setAborting(true)
    try {
      await gitAbortOperation(folderPath, operation)
      toast.success(t("abortSuccess"))
      await emitEvent("folder://merge-aborted", { folder_id: folderId })
      void petCelebrate("failed").catch((err) => {
        console.warn("[Merge] pet celebrate (failed) failed:", err)
      })
      onAborted()
    } catch (err) {
      toast.error(toErrorMessage(err))
    } finally {
      setAborting(false)
    }
  }

  async function handleComplete() {
    setCompleting(true)
    try {
      await gitContinueOperation(folderPath, operation)
      toast.success(t("allResolved"))
      await emitEvent("folder://merge-completed", { folder_id: folderId })
      void petCelebrate("jumping").catch((err) => {
        console.warn("[Merge] pet celebrate (jumping) failed:", err)
      })
      onCompleted()
    } catch (err) {
      toast.error(toErrorMessage(err))
    } finally {
      setCompleting(false)
    }
  }

  const allResolved =
    files.length > 0 && files.every((f) => resolvedFiles.has(f))

  const language = selectedFile ? languageFromPath(selectedFile) : "plaintext"

  return (
    <div className="flex h-full flex-col gap-2">
      <ResizablePanelGroup
        direction="horizontal"
        className="flex-1 min-h-0 rounded-lg border"
      >
        {/* Left sidebar: conflict file list */}
        <ResizablePanel defaultSize={18} minSize={12} maxSize={30}>
          <div className="flex h-full flex-col">
            <div className="border-b px-3 py-2 text-xs font-medium text-muted-foreground">
              {t("conflictFiles")} ({files.length})
            </div>
            <ScrollArea className="flex-1">
              <div className="p-1">
                {files.map((file) => {
                  const isResolved = resolvedFiles.has(file)
                  const isSelected = file === selectedFile
                  return (
                    <button
                      key={file}
                      type="button"
                      className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors ${
                        isSelected
                          ? "bg-accent text-accent-foreground"
                          : "hover:bg-accent/50"
                      }`}
                      onClick={() => !isResolved && selectFile(file)}
                      disabled={isResolved}
                    >
                      {isResolved ? (
                        <Check className="h-3 w-3 shrink-0 text-green-500" />
                      ) : (
                        <FileWarning className="h-3 w-3 shrink-0 text-amber-500" />
                      )}
                      <span
                        className={`truncate ${isResolved ? "text-muted-foreground line-through" : ""}`}
                      >
                        {file}
                      </span>
                    </button>
                  )
                })}
                {files.length === 0 && (
                  <div className="px-2 py-4 text-center text-xs text-muted-foreground">
                    {t("noConflicts")}
                  </div>
                )}
              </div>
            </ScrollArea>
          </div>
        </ResizablePanel>

        <ResizableHandle />

        {/* Main area: three-pane merge editor */}
        <ResizablePanel defaultSize={82}>
          {preparing ? (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              {t("preparingMerge")}
            </div>
          ) : loadingVersions ? (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              {t("loadingFile")}
            </div>
          ) : versions && selectedFile ? (
            <ThreePaneMergeEditor
              key={selectedFile}
              base={versions.base}
              ours={versions.ours}
              theirs={versions.theirs}
              merged={versions.merged}
              language={language}
              onContentChange={handleContentChange}
              onConflictStatusChange={handleConflictStatusChange}
            />
          ) : (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
              {t("selectFile")}
            </div>
          )}
        </ResizablePanel>
      </ResizablePanelGroup>

      {/* Bottom toolbar */}
      <div className="flex items-center justify-end gap-2">
        <Button
          variant="secondary"
          size="sm"
          onClick={handleAbort}
          disabled={aborting || completing || resolving}
        >
          {aborting && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
          <X className="mr-1 h-3.5 w-3.5" />
          {t("abortMerge")}
        </Button>
        <Button
          size="sm"
          onClick={handleResolve}
          disabled={
            !selectedFile ||
            resolving ||
            aborting ||
            completing ||
            (selectedFile !== null && resolvedFiles.has(selectedFile))
          }
        >
          {resolving && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
          <Check className="mr-1 h-3.5 w-3.5" />
          {t("markResolved")}
        </Button>
        {allResolved && (
          <Button
            size="sm"
            onClick={handleComplete}
            disabled={completing || aborting}
          >
            {completing && (
              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
            )}
            <CheckCheck className="mr-1 h-3.5 w-3.5" />
            {t("completeMerge")}
          </Button>
        )}
      </div>
    </div>
  )
}
