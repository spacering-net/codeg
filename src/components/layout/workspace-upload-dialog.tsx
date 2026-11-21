"use client"

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
  type KeyboardEvent,
} from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import {
  AlertCircle,
  CheckCircle2,
  FileIcon,
  Folder,
  Loader2,
  RotateCcw,
  Upload,
  X,
} from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { ScrollArea } from "@/components/ui/scroll-area"
import { cn, randomUUID } from "@/lib/utils"
import {
  cancelWorkspaceTransfer,
  isUploadAbortError,
  listenWorkspaceTransferProgress,
  uploadWorkspaceFile,
  uploadWorkspaceLocalPathsToRemote,
} from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"
import { joinFsPath } from "@/lib/path-utils"
import { isRemoteDesktopMode } from "@/lib/transport"

type QueueStatus = "pending" | "uploading" | "success" | "error" | "cancelled"

type QueueSource =
  | {
      kind: "browserFile"
      file: File
      relativePath: string
      displayName: string
      total: number
    }
  | {
      kind: "localPath"
      localPath: string
      relativePath: string
      displayName: string
      total: number
    }

interface QueueItem {
  id: string
  source: QueueSource
  status: QueueStatus
  loaded: number
  total: number
  error?: string
}

export interface WorkspaceUploadDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  rootPath: string
  // Workspace-relative directory to upload into. Empty string = root.
  targetPath: string
  folderUploadSupported: boolean
  onComplete: () => void
}

// Normalize a user-typed workspace-relative path: collapse backslashes,
// strip leading/trailing/duplicate slashes, drop any "." or ".." segments
// (".." defended at the server too, but we don't want to even *send* it).
// An empty result means "workspace root".
function normalizeTargetPath(input: string): string {
  const trimmed = input.replace(/\\/g, "/").trim()
  const segments = trimmed
    .split("/")
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && s !== "." && s !== "..")
  return segments.join("/")
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—"
  if (bytes < 1024) return `${bytes} B`
  const kb = bytes / 1024
  if (kb < 1024) return `${kb.toFixed(kb < 10 ? 1 : 0)} KB`
  const mb = kb / 1024
  if (mb < 1024) return `${mb.toFixed(mb < 10 ? 1 : 0)} MB`
  const gb = mb / 1024
  return `${gb.toFixed(gb < 10 ? 1 : 0)} GB`
}

function baseName(path: string): string {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "")
  return normalized.split("/").filter(Boolean).pop() || path
}

// `FileSystemDirectoryEntry.createReader()` returns at most ~100 entries
// per call and must be drained in a loop until empty. Used for folder
// drag-and-drop, which is the one upload path that can't piggy-back on
// `webkitRelativePath`.
async function readAllEntries(
  reader: FileSystemDirectoryReader
): Promise<FileSystemEntry[]> {
  const all: FileSystemEntry[] = []
  while (true) {
    const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => {
      reader.readEntries(resolve, reject)
    })
    if (batch.length === 0) break
    all.push(...batch)
  }
  return all
}

async function collectEntry(
  entry: FileSystemEntry,
  prefix: string,
  out: { file: File; relativePath: string }[]
): Promise<void> {
  if (entry.isFile) {
    const fileEntry = entry as FileSystemFileEntry
    const file = await new Promise<File>((resolve, reject) => {
      fileEntry.file(resolve, reject)
    })
    out.push({ file, relativePath: prefix + entry.name })
  } else if (entry.isDirectory) {
    const dirEntry = entry as FileSystemDirectoryEntry
    const children = await readAllEntries(dirEntry.createReader())
    for (const child of children) {
      await collectEntry(child, prefix + entry.name + "/", out)
    }
  }
}

export function WorkspaceUploadDialog({
  open,
  onOpenChange,
  rootPath,
  targetPath,
  folderUploadSupported,
  onComplete,
}: WorkspaceUploadDialogProps) {
  const t = useTranslations("Folder.fileTreeTab.uploadDialog")
  const tCommon = useTranslations("Folder.common")

  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const folderInputRef = useRef<HTMLInputElement | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const activeTransferIdRef = useRef<string | null>(null)
  // Set while a pump loop is running so we never start two in parallel —
  // the same effect would otherwise re-fire on every setItems call.
  const pumpRunningRef = useRef(false)
  // Mirrors `items` so the async pump always reads the latest queue
  // without depending on closure capture or extra effect runs.
  const itemsRef = useRef<QueueItem[]>([])
  // Tracks ids the user removed from the queue. Required because state
  // and `itemsRef` are eventually consistent — between the user's
  // `setItems(filter)` and the next pump iteration, the ref can still
  // surface a since-removed item, and we'd spend a network round-trip
  // uploading something the user already discarded.
  const removedIdsRef = useRef<Set<string>>(new Set())
  const onCompleteRef = useRef(onComplete)
  // Only read once an upload has finished (after an await), so syncing it in
  // a layout effect is always in time.
  useLayoutEffect(() => {
    onCompleteRef.current = onComplete
  })

  const [items, setItems] = useState<QueueItem[]>([])
  const [isDragOver, setIsDragOver] = useState(false)
  // Mirrors `pumpRunningRef` for render-time logic. We need both: the
  // ref so the pump-spawn guard reads a synchronous, latest value
  // without depending on a re-render, and the state so the footer
  // buttons (Cancel / Start / Close) reflect activity without lag.
  const [pumpActive, setPumpActive] = useState(false)
  // The user-editable destination. Seeded from the `targetPath` prop
  // whenever the dialog (re)opens, then drives every upload in the
  // session. We don't watch the prop after that — overwriting an
  // in-progress edit would feel like the dialog fighting the user.
  const [editableTargetPath, setEditableTargetPath] = useState(targetPath)
  const remoteDesktop = isRemoteDesktopMode()
  // Re-seed on every (re)open and on a `targetPath` change while open.
  // Adjusted during render (React's "reset state on prop change" pattern); the
  // initial state already holds `targetPath`, so mount needs no seeding.
  const [prevOpen, setPrevOpen] = useState(open)
  const [prevTargetPath, setPrevTargetPath] = useState(targetPath)
  if (open !== prevOpen || targetPath !== prevTargetPath) {
    setPrevOpen(open)
    setPrevTargetPath(targetPath)
    if (open) setEditableTargetPath(targetPath)
  }

  useEffect(() => {
    itemsRef.current = items
  }, [items])

  const hasPending = useMemo(
    () => items.some((it) => it.status === "pending"),
    [items]
  )
  // Busy = the user has explicitly started an upload session and the
  // pump is still draining. Distinct from "has pending items" — files
  // just added to the queue are NOT busy, the user hasn't committed
  // yet and should still be free to remove them or close the dialog.
  const isBusy = pumpActive
  const successCount = useMemo(
    () => items.filter((it) => it.status === "success").length,
    [items]
  )
  const failedCount = useMemo(
    () => items.filter((it) => it.status === "error").length,
    [items]
  )
  const totalBytes = useMemo(
    () => items.reduce((acc, it) => acc + it.total, 0),
    [items]
  )
  const loadedBytes = useMemo(
    () =>
      items.reduce((acc, it) => {
        if (it.status === "success") return acc + it.total
        if (it.status === "uploading") return acc + it.loaded
        return acc
      }, 0),
    [items]
  )
  const overallPercentage =
    totalBytes > 0
      ? Math.min(100, Math.floor((loadedBytes / totalBytes) * 100))
      : 0

  // Aborting on unmount stops an in-flight XHR from outliving this
  // component — otherwise the network call would dangle and the user
  // would have no way to cancel it after closing the dialog.
  useEffect(() => {
    return () => {
      abortRef.current?.abort()
    }
  }, [])

  useEffect(() => {
    if (!remoteDesktop) return
    let disposed = false
    let cleanup: (() => void) | null = null
    void listenWorkspaceTransferProgress((event) => {
      if (event.direction !== "upload") return
      activeTransferIdRef.current = event.transferId
      setItems((prev) => {
        const active = prev.find((it) => it.status === "uploading")
        if (!active) return prev
        return prev.map((it) =>
          it.id === active.id
            ? {
                ...it,
                loaded: event.loaded,
                total: event.total ?? it.total,
                status:
                  event.state === "cancelled"
                    ? "cancelled"
                    : event.state === "error"
                      ? "error"
                      : it.status,
                error: event.error ?? it.error,
              }
            : it
        )
      })
    }).then((unlisten) => {
      if (disposed) {
        unlisten()
      } else {
        cleanup = unlisten
      }
    })
    return () => {
      disposed = true
      cleanup?.()
    }
  }, [remoteDesktop])

  // Drop the queue once the dialog is closed and idle, so reopening
  // doesn't show stale results from a previous session. Also drain the
  // removed-ids set on close — it's only meaningful within one session.
  useEffect(() => {
    if (!open && !isBusy) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- close-time reset paired with clearing a ref
      setItems([])
      removedIdsRef.current = new Set()
    }
  }, [open, isBusy])

  // Block the browser's native "open dropped file" behavior while the
  // dialog is visible. Without this, dropping anywhere outside the small
  // drop-zone (overlay, queue list, footer) navigates the tab to the
  // file:// URL and kills in-flight uploads. We only intercept *file*
  // drags so text/link drags inside inputs still work normally.
  useEffect(() => {
    if (!open) return
    const prevent = (event: globalThis.DragEvent) => {
      const dt = event.dataTransfer
      if (!dt) return
      // `types` is a `DOMStringList` (older browsers) or array-like.
      // Both expose `length` and indexed access; `Array.from` handles
      // either uniformly.
      const types = Array.from(dt.types)
      if (types.includes("Files")) {
        event.preventDefault()
      }
    }
    window.addEventListener("dragover", prevent)
    window.addEventListener("drop", prevent)
    return () => {
      window.removeEventListener("dragover", prevent)
      window.removeEventListener("drop", prevent)
    }
  }, [open])

  const ensurePump = useCallback(() => {
    if (pumpRunningRef.current) return
    // Don't reuse an aborted controller — its `signal.aborted` is true
    // forever, so a fresh pump would exit immediately on the first loop
    // check. Reset it here for safety; the cancel path also nulls it.
    if (abortRef.current?.signal.aborted) {
      abortRef.current = null
    }
    if (!abortRef.current) abortRef.current = new AbortController()
    const controller = abortRef.current
    pumpRunningRef.current = true
    setPumpActive(true)
    // Lock in the destination at pump start. The user can keep editing
    // the input field after this point, but a session that began
    // streaming bytes to path A must NOT silently flip to path B
    // mid-batch — that would split one apparent operation across two
    // filesystem locations.
    const sessionTargetPath = normalizeTargetPath(editableTargetPath)

    void (async () => {
      let didUpload = false
      try {
        while (true) {
          if (controller.signal.aborted) break
          const next = itemsRef.current.find(
            (it) => it.status === "pending" && !removedIdsRef.current.has(it.id)
          )
          if (!next) break

          activeTransferIdRef.current = null
          setItems((prev) =>
            prev.map((it) =>
              it.id === next.id
                ? { ...it, status: "uploading", loaded: 0, error: undefined }
                : it
            )
          )

          try {
            if (next.source.kind === "browserFile") {
              await uploadWorkspaceFile({
                rootPath,
                targetPath: sessionTargetPath,
                file: next.source.file,
                relativePath: next.source.relativePath || null,
                signal: controller.signal,
                onProgress: (loaded, total) => {
                  setItems((prev) =>
                    prev.map((it) =>
                      it.id === next.id
                        ? {
                            ...it,
                            loaded,
                            total: total || it.total,
                          }
                        : it
                    )
                  )
                },
              })
            } else {
              const result = await uploadWorkspaceLocalPathsToRemote({
                rootPath,
                targetPath: sessionTargetPath,
                entries: [
                  {
                    localPath: next.source.localPath,
                    relativePath: next.source.relativePath || null,
                  },
                ],
              })
              activeTransferIdRef.current = result.transferId
              const loaded = result.bytes || next.total
              setItems((prev) =>
                prev.map((it) =>
                  it.id === next.id ? { ...it, loaded, total: loaded } : it
                )
              )
            }
            didUpload = true
            setItems((prev) =>
              prev.map((it) =>
                it.id === next.id
                  ? {
                      ...it,
                      status: "success",
                      loaded: it.total,
                    }
                  : it
              )
            )
          } catch (err) {
            if (isUploadAbortError(err) || controller.signal.aborted) {
              setItems((prev) =>
                prev.map((it) =>
                  it.id === next.id ? { ...it, status: "cancelled" } : it
                )
              )
              break
            }
            const message = toErrorMessage(err)
            setItems((prev) =>
              prev.map((it) =>
                it.id === next.id
                  ? { ...it, status: "error", error: message }
                  : it
              )
            )
          }
        }
      } finally {
        // Order matters: flush the cancellation sweep BEFORE marking the
        // pump idle. If we cleared `pumpRunningRef` first, a queued
        // `setItems` from the user (e.g. picking new files) could fire
        // the `hasPending` effect, spawn a new pump, and that pump would
        // then have its fresh queue items stomped to "cancelled" by the
        // sweep below.
        if (controller.signal.aborted) {
          setItems((prev) =>
            prev.map((it) =>
              it.status === "pending" || it.status === "uploading"
                ? { ...it, status: "cancelled" }
                : it
            )
          )
          abortRef.current = null
        }
        // Prune the removed-ids set now that the pump is done — any
        // item ids it held were already filtered out of `items`, so
        // the set is no longer load-bearing and would otherwise grow
        // monotonically across a long-lived dialog session.
        removedIdsRef.current = new Set()
        activeTransferIdRef.current = null
        pumpRunningRef.current = false
        setPumpActive(false)
        // Skip the tree refresh when nothing actually landed on disk —
        // a cancelled batch where no file completed, or a pump pass
        // that found no work, doesn't need a server round-trip. Wrap
        // the callout so a parent-side throw can't bubble out of the
        // void IIFE as an unhandled rejection.
        if (didUpload) {
          try {
            onCompleteRef.current()
          } catch {
            // Swallow — the parent's tree refresh is best-effort and
            // shouldn't take the dialog down with it.
          }
        }
      }
    })()
  }, [rootPath, editableTargetPath])

  // Once the user clicks "Start upload", any files dropped or picked
  // later in the same session should join the running batch instead
  // of waiting for another button press. The pump only spawns one
  // loop, so the second condition is just a no-op safety net for
  // when the previous batch has already drained.
  useEffect(() => {
    if (!open) return
    if (!pumpActive) return
    if (hasPending && !pumpRunningRef.current) {
      ensurePump()
    }
  }, [open, pumpActive, hasPending, ensurePump])

  const handleStartUpload = useCallback(() => {
    if (!hasPending) return
    ensurePump()
  }, [hasPending, ensurePump])

  const enqueueFiles = useCallback(
    (newFiles: { file: File; relativePath: string }[]) => {
      if (newFiles.length === 0) return
      const queueItems: QueueItem[] = newFiles.map((entry) => ({
        id: randomUUID(),
        source: {
          kind: "browserFile",
          file: entry.file,
          relativePath: entry.relativePath,
          displayName: entry.relativePath || entry.file.name,
          total: entry.file.size,
        },
        status: "pending",
        loaded: 0,
        total: entry.file.size,
      }))
      setItems((prev) => [...prev, ...queueItems])
    },
    []
  )

  const enqueueLocalPaths = useCallback(
    (paths: { localPath: string; relativePath: string }[]) => {
      if (paths.length === 0) return
      const queueItems: QueueItem[] = paths.map((entry) => ({
        id: randomUUID(),
        source: {
          kind: "localPath",
          localPath: entry.localPath,
          relativePath: entry.relativePath,
          displayName: entry.relativePath || baseName(entry.localPath),
          total: 0,
        },
        status: "pending",
        loaded: 0,
        total: 0,
      }))
      setItems((prev) => [...prev, ...queueItems])
    },
    []
  )

  const handleFileInputChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const target = event.target
      // Snapshot to a plain array BEFORE clearing the input value.
      // Per the HTML spec, `input.files` has a `[SameObject]` annotation
      // and is "live" — setting `value = ""` empties the same FileList
      // we just captured, so `list.length === 0` would early-return and
      // the queue would never see the files. Array.from copies the
      // entries out before we touch `target.value`.
      const files = Array.from(target.files ?? [])
      target.value = ""
      if (files.length === 0) return
      enqueueFiles(files.map((file) => ({ file, relativePath: "" })))
    },
    [enqueueFiles]
  )

  const handleFolderInputChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const target = event.target
      const files = Array.from(target.files ?? [])
      target.value = ""
      if (files.length === 0) return
      enqueueFiles(
        files.map((file) => ({
          file,
          relativePath: file.webkitRelativePath || "",
        }))
      )
    },
    [enqueueFiles]
  )

  const handleDrop = useCallback(
    async (event: DragEvent<HTMLDivElement>) => {
      event.preventDefault()
      setIsDragOver(false)
      if (remoteDesktop) return
      const dt = event.dataTransfer
      if (!dt) return

      // Prefer the entry API so dropped folders are walked recursively.
      // Fall back to the plain `files` list when entries aren't exposed
      // (older browsers, or when DnD originates from a non-filesystem
      // source like a thumbnail in the same page).
      const dtItems = dt.items
      if (dtItems && dtItems.length > 0) {
        const entries: FileSystemEntry[] = []
        for (let i = 0; i < dtItems.length; i++) {
          const entry = dtItems[i].webkitGetAsEntry?.()
          if (entry) entries.push(entry)
        }
        if (entries.length > 0) {
          const collected: { file: File; relativePath: string }[] = []
          const hasDirectory = entries.some((e) => e.isDirectory)
          for (const entry of entries) {
            try {
              await collectEntry(entry, "", collected)
            } catch {
              // Skip entries we can't read — they're typically files
              // dragged from inside other web apps without filesystem
              // backing.
            }
          }
          if (collected.length > 0) {
            enqueueFiles(collected)
            return
          }
          // A dropped folder yielded nothing readable (empty folder, or
          // permissions/symlink errors during walk). Tell the user so
          // they don't think the drop was lost in the void.
          if (hasDirectory) {
            toast.warning(t("folderEmpty"))
            return
          }
        }
      }

      const files = dt.files
      if (files && files.length > 0) {
        enqueueFiles(
          Array.from(files).map((file) => ({ file, relativePath: "" }))
        )
      }
    },
    [enqueueFiles, remoteDesktop, t]
  )

  const handleDragOver = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      event.preventDefault()
      if (remoteDesktop) return
      if (event.dataTransfer) {
        event.dataTransfer.dropEffect = "copy"
      }
      setIsDragOver(true)
    },
    [remoteDesktop]
  )

  const handleDragLeave = useCallback((event: DragEvent<HTMLDivElement>) => {
    // `dragleave` fires when entering child elements too; only mark as
    // left when the related target is outside our drop zone.
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) {
      return
    }
    setIsDragOver(false)
  }, [])

  const handleSelectFiles = useCallback(() => {
    if (!remoteDesktop) {
      fileInputRef.current?.click()
      return
    }
    void (async () => {
      const { open } = await import("@tauri-apps/plugin-dialog")
      const selected = await open({ multiple: true, directory: false })
      const paths = Array.isArray(selected)
        ? selected
        : selected
          ? [selected]
          : []
      enqueueLocalPaths(
        paths.map((path) => ({
          localPath: path,
          relativePath: "",
        }))
      )
    })()
  }, [enqueueLocalPaths, remoteDesktop])

  const handleSelectFolder = useCallback(() => {
    if (!remoteDesktop) {
      folderInputRef.current?.click()
      return
    }
    void (async () => {
      const { open } = await import("@tauri-apps/plugin-dialog")
      const selected = await open({ multiple: false, directory: true })
      const paths = Array.isArray(selected)
        ? selected
        : selected
          ? [selected]
          : []
      enqueueLocalPaths(
        paths.map((path) => ({
          localPath: path,
          relativePath: baseName(path),
        }))
      )
    })()
  }, [enqueueLocalPaths, remoteDesktop])

  // Make the drop zone behave like a button for keyboard users — Enter
  // or Space opens the same file picker as the visible button below.
  // Guard against bubbling: the two inline buttons (Select files /
  // Select folder) also live inside the drop-zone div, and a Space
  // press on one of them would bubble up here and double-fire the
  // picker. Only act when the keydown originated on the drop zone
  // itself (event.target === event.currentTarget).
  const handleDropZoneKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.target !== event.currentTarget) return
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault()
        handleSelectFiles()
      }
    },
    [handleSelectFiles]
  )

  const handleCancelUpload = useCallback(() => {
    abortRef.current?.abort()
    const transferId = activeTransferIdRef.current
    if (transferId) {
      void cancelWorkspaceTransfer(transferId).catch(() => {})
    }
  }, [])

  const handleRemoveItem = useCallback((id: string) => {
    // Record the removal first — the pump may still be holding a stale
    // reference to this item via `itemsRef`, and the synchronous Set
    // gives us an immediate signal that survives ref lag.
    removedIdsRef.current.add(id)
    setItems((prev) => prev.filter((it) => it.id !== id))
  }, [])

  const handleRetryItem = useCallback((id: string) => {
    // Resetting to "pending" is enough — the hasPending effect picks it
    // up and the existing pump (or a new one) drains it.
    setItems((prev) =>
      prev.map((it) =>
        it.id === id
          ? { ...it, status: "pending", loaded: 0, error: undefined }
          : it
      )
    )
  }, [])

  const handleClearQueue = useCallback(() => {
    setItems((prev) =>
      prev.filter((it) => it.status === "uploading" || it.status === "pending")
    )
  }, [])

  const handleDialogOpenChange = useCallback(
    (next: boolean) => {
      // Block closing while uploads are in flight — the user should
      // explicitly cancel first, otherwise the partial state is easy to
      // miss. Cancelling and then closing remains a one-click flow.
      if (!next && isBusy) return
      onOpenChange(next)
    },
    [isBusy, onOpenChange]
  )

  const normalizedTargetForDisplay = normalizeTargetPath(editableTargetPath)
  // The hint is most useful when it shows where files will actually
  // land — the workspace absolute path joined with the relative target.
  // Empty target → just the workspace root.
  const absoluteTargetPath = normalizedTargetForDisplay
    ? joinFsPath(rootPath, normalizedTargetForDisplay)
    : rootPath
  const canSelectFolder = remoteDesktop || folderUploadSupported

  const renderStatusIcon = (status: QueueStatus) => {
    switch (status) {
      case "uploading":
        return <Loader2 className="size-4 shrink-0 animate-spin text-primary" />
      case "success":
        return <CheckCircle2 className="size-4 shrink-0 text-emerald-500" />
      case "error":
        return <AlertCircle className="size-4 shrink-0 text-destructive" />
      case "cancelled":
        return <AlertCircle className="size-4 shrink-0 text-muted-foreground" />
      default:
        return <FileIcon className="size-4 shrink-0 text-muted-foreground" />
    }
  }

  const statusLabel = (status: QueueStatus) => {
    switch (status) {
      case "uploading":
        return t("status.uploading")
      case "success":
        return t("status.success")
      case "error":
        return t("status.error")
      case "cancelled":
        return t("status.cancelled")
      default:
        return t("status.pending")
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleDialogOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor="upload-target-path">{t("targetPathLabel")}</Label>
            <Input
              id="upload-target-path"
              value={editableTargetPath}
              onChange={(event) => setEditableTargetPath(event.target.value)}
              placeholder={t("workspaceRoot")}
              disabled={isBusy}
              autoComplete="off"
              spellCheck={false}
              dir="ltr"
            />
            <p
              className="text-xs text-muted-foreground break-all"
              aria-live="polite"
              dir="ltr"
            >
              {t("targetPathHint", { path: absoluteTargetPath })}
            </p>
          </div>
          <div
            role="button"
            tabIndex={0}
            aria-label={t("dropZoneAria")}
            onClick={handleSelectFiles}
            onKeyDown={handleDropZoneKeyDown}
            onDrop={(e) => void handleDrop(e)}
            onDragOver={handleDragOver}
            onDragEnter={handleDragOver}
            onDragLeave={handleDragLeave}
            className={cn(
              "border-2 border-dashed rounded-2xl p-6 flex flex-col items-center gap-3 text-center transition-colors cursor-pointer",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              isDragOver
                ? "border-primary bg-primary/5"
                : "border-border bg-muted/30 hover:bg-muted/50"
            )}
          >
            <Upload className="size-8 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">
              {isDragOver ? t("dropHintActive") : t("dropHint")}
            </p>
            <div className="flex gap-2" onClick={(e) => e.stopPropagation()}>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={handleSelectFiles}
              >
                <FileIcon className="size-4" />
                {t("selectFiles")}
              </Button>
              {canSelectFolder && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={handleSelectFolder}
                >
                  <Folder className="size-4" />
                  {t("selectFolder")}
                </Button>
              )}
            </div>
          </div>

          {items.length > 0 && (
            <>
              <div className="flex items-center justify-between text-sm">
                <span
                  className="text-muted-foreground"
                  aria-live="polite"
                  aria-atomic="true"
                >
                  {t("summary", {
                    total: items.length,
                    succeeded: successCount,
                    failed: failedCount,
                  })}
                </span>
                <span className="font-medium" dir="ltr">
                  {formatBytes(loadedBytes)} / {formatBytes(totalBytes)} ·{" "}
                  {overallPercentage}%
                </span>
              </div>
              <div
                role="progressbar"
                aria-valuenow={overallPercentage}
                aria-valuemin={0}
                aria-valuemax={100}
                dir="ltr"
                className="h-2 w-full overflow-hidden rounded-full bg-muted"
              >
                <div
                  className={cn(
                    "h-full transition-[width] duration-150 ease-out",
                    failedCount > 0 && successCount === 0
                      ? "bg-destructive"
                      : "bg-primary"
                  )}
                  style={{ width: `${overallPercentage}%` }}
                />
              </div>

              <ScrollArea className="h-64 rounded-2xl border bg-background">
                <ul className="divide-y">
                  {items.map((item) => {
                    const itemTotal = item.total || item.source.total
                    const itemPct =
                      itemTotal > 0
                        ? Math.min(
                            100,
                            Math.floor((item.loaded / itemTotal) * 100)
                          )
                        : item.status === "success"
                          ? 100
                          : 0
                    const displayName = item.source.displayName
                    const canRemove =
                      item.status === "pending" ||
                      item.status === "success" ||
                      item.status === "error" ||
                      item.status === "cancelled"
                    return (
                      <li
                        key={item.id}
                        className="flex items-start gap-3 px-3 py-2 text-sm"
                      >
                        <div className="pt-1">
                          {renderStatusIcon(item.status)}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span
                              className="truncate font-medium"
                              title={displayName}
                            >
                              {displayName}
                            </span>
                            <span className="text-xs text-muted-foreground whitespace-nowrap">
                              {formatBytes(itemTotal)}
                            </span>
                          </div>
                          <div className="mt-1 flex items-center gap-2">
                            <div
                              dir="ltr"
                              className="h-1 flex-1 overflow-hidden rounded-full bg-muted"
                            >
                              <div
                                className={cn(
                                  "h-full transition-[width] duration-150 ease-out",
                                  item.status === "error"
                                    ? "bg-destructive"
                                    : item.status === "cancelled"
                                      ? "bg-muted-foreground/50"
                                      : item.status === "success"
                                        ? "bg-emerald-500"
                                        : "bg-primary"
                                )}
                                style={{ width: `${itemPct}%` }}
                              />
                            </div>
                            <span className="text-xs text-muted-foreground whitespace-nowrap min-w-[3rem] text-right">
                              {statusLabel(item.status)}
                              {item.status === "uploading" && ` ${itemPct}%`}
                            </span>
                          </div>
                          {item.status === "error" && item.error && (
                            <p
                              className="mt-1 text-xs text-destructive truncate"
                              title={item.error}
                            >
                              {item.error}
                            </p>
                          )}
                        </div>
                        <div className="flex items-center gap-1">
                          {(item.status === "error" ||
                            item.status === "cancelled") && (
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon-sm"
                              onClick={() => handleRetryItem(item.id)}
                              aria-label={t("retry")}
                              title={t("retry")}
                            >
                              <RotateCcw className="size-3.5" />
                            </Button>
                          )}
                          {canRemove && (
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon-sm"
                              onClick={() => handleRemoveItem(item.id)}
                              aria-label={t("removeItem")}
                              title={t("removeItem")}
                            >
                              <X className="size-3.5" />
                            </Button>
                          )}
                        </div>
                      </li>
                    )
                  })}
                </ul>
              </ScrollArea>
            </>
          )}
        </div>

        <DialogFooter className="sm:justify-between">
          <div>
            {items.length > 0 && !isBusy && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={handleClearQueue}
              >
                {t("clearQueue")}
              </Button>
            )}
          </div>
          <div className="flex gap-2">
            {isBusy ? (
              <Button
                type="button"
                variant="outline"
                onClick={handleCancelUpload}
              >
                {tCommon("cancel")}
              </Button>
            ) : (
              <>
                <Button
                  type="button"
                  variant={hasPending ? "outline" : "default"}
                  onClick={() => onOpenChange(false)}
                >
                  {tCommon("close")}
                </Button>
                {hasPending && (
                  <Button type="button" onClick={handleStartUpload}>
                    {t("startUpload")}
                  </Button>
                )}
              </>
            )}
          </div>
        </DialogFooter>

        {/*
          Hidden inputs live inside the dialog so the file picker is
          triggered from the same user-gesture frame as the visible
          button click — Chrome and Safari sometimes reject programmatic
          `.click()` on a hidden input if the gesture context was lost
          (which is what was happening when the picker was invoked from
          a radix ContextMenu onSelect handler).
        */}
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={handleFileInputChange}
        />
        {!remoteDesktop && folderUploadSupported && (
          <input
            ref={folderInputRef}
            type="file"
            // `webkitdirectory` is non-standard — supported by Chrome,
            // Edge, Firefox, and desktop Safari. React doesn't have a
            // typed prop for it so we pass via the lowercased DOM
            // attribute name.
            // @ts-expect-error — non-standard attribute used for folder picks
            webkitdirectory=""
            directory=""
            multiple
            className="hidden"
            onChange={handleFolderInputChange}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}
