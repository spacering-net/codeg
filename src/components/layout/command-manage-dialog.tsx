"use client"

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent,
  type ReactNode,
} from "react"
import {
  GripVertical,
  Globe,
  Loader2,
  Monitor,
  Plus,
  Save,
  Trash2,
} from "lucide-react"
import { Reorder, useDragControls } from "motion/react"
import { useTranslations } from "next-intl"
import { detectPlatform } from "@/hooks/use-platform"
import {
  createFolderCommand,
  deleteFolderCommand,
  listFolderCommands,
  reorderFolderCommands,
  updateFolderCommand,
} from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"
import {
  createGlobalCommand,
  deleteGlobalCommand,
  isGlobalCommandId,
  listGlobalCommands,
  reorderGlobalCommands,
  requireHostCommand,
  updateGlobalCommand,
  withoutGlobalIds,
} from "@/lib/global-commands"
import { isLocalCommand } from "@/lib/local-command"
import { isDesktop } from "@/lib/transport"
import type { FolderCommand } from "@/lib/types"
import { Button } from "@/components/ui/button"
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
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable"
import { Switch } from "@/components/ui/switch"
import { cn } from "@/lib/utils"

const LEFT_MIN_WIDTH = 260
const RIGHT_MIN_WIDTH = 380

// A value in a hint, set apart from the prose so its punctuation is not read
// as the sentence's. `dir="ltr"` keeps it intact in Arabic.
const hintLiteral = (chunks: ReactNode) => (
  <code dir="ltr" className="rounded bg-muted px-1 font-mono break-words">
    {chunks}
  </code>
)

/** The variables a command run on this computer reads, spelled the way the
 *  shell it runs in here expects: cmd.exe on Windows, a POSIX shell elsewhere. */
function localCommandHintValues() {
  const windows = detectPlatform() === "windows"
  const variable = (name: string) => (windows ? `%${name}%` : `$${name}`)
  const folderVar = variable("CODEG_FOLDER_PATH")
  const hostVar = variable("CODEG_REMOTE_HOST")
  return {
    folderVar,
    hostVar,
    example: `zed "ssh://user@${hostVar}${folderVar}"`,
  }
}

interface CommandManageDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  folderId: number
  onChanged: () => void
}

interface Draft {
  id: number | null
  name: string
  command: string
  /** Shown in every folder (stored on this client) rather than this one. */
  global: boolean
  /** Run on this computer, detached, rather than in a terminal on the
   *  folder's host. */
  runLocal: boolean
}

interface CommandReorderItemProps {
  command: FolderCommand
  selected: boolean
  disabled: boolean
  onSelect: (id: number) => void
  onDragEnd: () => void
  children: (
    startDrag: (event: PointerEvent<HTMLButtonElement>) => void
  ) => ReactNode
}

const EMPTY_DRAFT: Draft = {
  id: null,
  name: "",
  command: "",
  global: false,
  runLocal: false,
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function toPercent(pixels: number, totalPixels: number): number {
  if (totalPixels <= 0) return 0
  return (pixels / totalPixels) * 100
}

/** Folder commands first, then global ones, each group keeping its order —
 *  the order the launcher lists them in. */
function groupByScope(commands: FolderCommand[]): FolderCommand[] {
  return [
    ...commands.filter((command) => !isGlobalCommandId(command.id)),
    ...commands.filter((command) => isGlobalCommandId(command.id)),
  ]
}

function CommandReorderItem({
  command,
  selected,
  disabled,
  onSelect,
  onDragEnd,
  children,
}: CommandReorderItemProps) {
  const dragControls = useDragControls()

  const startDrag = useCallback(
    (event: PointerEvent<HTMLButtonElement>) => {
      event.preventDefault()
      event.stopPropagation()
      if (!disabled) {
        dragControls.start(event)
      }
    },
    [disabled, dragControls]
  )

  return (
    <Reorder.Item
      as="section"
      value={command}
      data-folder-command-id={command.id}
      drag={disabled ? false : "y"}
      dragListener={false}
      dragControls={dragControls}
      dragMomentum={false}
      layout="position"
      className={cn(
        "cursor-pointer rounded-lg border bg-card p-2.5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40",
        selected && "border-primary/60 bg-primary/5"
      )}
      tabIndex={0}
      onDragEnd={onDragEnd}
      onClick={() => onSelect(command.id)}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return
        if (event.key !== "Enter" && event.key !== " ") return
        event.preventDefault()
        onSelect(command.id)
      }}
    >
      {children(startDrag)}
    </Reorder.Item>
  )
}

export function CommandManageDialog({
  open,
  onOpenChange,
  folderId,
  onChanged,
}: CommandManageDialogProps) {
  const t = useTranslations("Folder.commandDropdown.manageDialog")
  const tCommon = useTranslations("Folder.common")
  const [commands, setCommands] = useState<FolderCommand[]>([])
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT)
  const [searchQuery, setSearchQuery] = useState("")
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [deleteTargetId, setDeleteTargetId] = useState<number | null>(null)
  const [reordering, setReordering] = useState(false)
  const pendingOrderRef = useRef<number[] | null>(null)
  const panelContainerRef = useRef<HTMLDivElement | null>(null)
  const [panelContainerWidth, setPanelContainerWidth] = useState(0)
  // Monotonic load token: a folder switch (or reopen) bumps it so a slower
  // listFolderCommands response for the previous folder can't overwrite the
  // newer folder's state.
  const loadSeqRef = useRef(0)

  const refresh = useCallback(async () => {
    if (!folderId) {
      loadSeqRef.current += 1
      setCommands([])
      setSelectedId(null)
      return
    }
    const seq = (loadSeqRef.current += 1)
    setLoading(true)
    setLoadError(null)
    try {
      const list = [
        ...withoutGlobalIds(await listFolderCommands(folderId)),
        ...listGlobalCommands(),
      ]
      if (seq !== loadSeqRef.current) return
      setCommands(list)
      setSelectedId((prev) => {
        if (prev === null) {
          return list[0]?.id ?? null
        }
        if (list.some((item) => item.id === prev)) {
          return prev
        }
        return list[0]?.id ?? null
      })
    } catch (err) {
      if (seq !== loadSeqRef.current) return
      setLoadError(`${t("loadFailed")}: ${toErrorMessage(err)}`)
      setCommands([])
    } finally {
      if (seq === loadSeqRef.current) setLoading(false)
    }
  }, [folderId, t])

  // Reloads on open and whenever folderId changes while open (refresh is keyed
  // on folderId), resetting transient UI so a folder switch never shows stale
  // commands.
  useEffect(() => {
    if (open) {
      setFormError(null)
      setSearchQuery("")
      void refresh()
    }
  }, [open, refresh])

  useEffect(() => {
    const container = panelContainerRef.current
    if (!container) return
    const updateWidth = (next: number) => {
      setPanelContainerWidth((prev) =>
        Math.abs(prev - next) < 1 ? prev : next
      )
    }
    updateWidth(container.getBoundingClientRect().width)
    const observer = new ResizeObserver((entries) => {
      updateWidth(
        entries[0]?.contentRect.width ?? container.getBoundingClientRect().width
      )
    })
    observer.observe(container)
    return () => {
      observer.disconnect()
    }
  }, [open])

  const selected = useMemo(
    () => commands.find((item) => item.id === selectedId) ?? null,
    [commands, selectedId]
  )
  const deleteTarget = useMemo(
    () =>
      deleteTargetId === null
        ? null
        : (commands.find((item) => item.id === deleteTargetId) ?? null),
    [commands, deleteTargetId]
  )

  // The command the form was last filled from. Moving to another one drops
  // the last one's error; the same one read again — the refresh after a failed
  // move — keeps it in view, or the failure would pass unexplained.
  const formCommandIdRef = useRef<number | null>(null)

  useEffect(() => {
    const id = selected?.id ?? null
    if (id !== formCommandIdRef.current) setFormError(null)
    formCommandIdRef.current = id
    if (!selected) {
      setDraft(EMPTY_DRAFT)
      return
    }
    setDraft({
      id: selected.id,
      name: selected.name,
      command: selected.command,
      global: isGlobalCommandId(selected.id),
      runLocal: isLocalCommand(selected),
    })
  }, [selected])

  const filteredCommands = useMemo(() => {
    const query = searchQuery.trim().toLowerCase()
    if (!query) return commands
    return commands.filter(
      (command) =>
        command.name.toLowerCase().includes(query) ||
        command.command.toLowerCase().includes(query)
    )
  }, [commands, searchQuery])

  const searchActive = searchQuery.trim().length > 0
  const localHintValues = useMemo(localCommandHintValues, [])
  const safeContainerWidth = panelContainerWidth > 0 ? panelContainerWidth : 900
  const leftMinSize = clamp(
    toPercent(LEFT_MIN_WIDTH, safeContainerWidth),
    5,
    95
  )
  const rightMinSize = clamp(
    toPercent(RIGHT_MIN_WIDTH, safeContainerWidth),
    5,
    95
  )
  const leftMaxSize = Math.max(leftMinSize, 100 - rightMinSize)

  const updateDraft = useCallback((patch: Partial<Draft>) => {
    setFormError(null)
    setDraft((prev) => ({ ...prev, ...patch }))
  }, [])

  const startNew = useCallback(() => {
    setSelectedId(null)
    setFormError(null)
    setDraft(EMPTY_DRAFT)
  }, [])

  // A save holds the form until it settles, so what it ends in — the saved
  // command, or why it wasn't — shows on the command that was saved.
  const selectCommand = useCallback(
    (id: number) => {
      if (!saving) setSelectedId(id)
    },
    [saving]
  )

  const persistReorder = useCallback(
    async (ids: number[]) => {
      if (ids.length === 0) return
      setReordering(true)
      setFormError(null)
      try {
        reorderGlobalCommands(ids.filter(isGlobalCommandId))
        const folderIds = ids.filter((id) => !isGlobalCommandId(id))
        if (folderIds.length > 0) {
          await reorderFolderCommands(folderId, folderIds)
        }
        onChanged()
      } catch (err) {
        setFormError(`${t("orderFailed")}: ${toErrorMessage(err)}`)
        await refresh()
      } finally {
        setReordering(false)
      }
    },
    [folderId, onChanged, refresh, t]
  )

  const handleReorder = useCallback(
    (next: FolderCommand[]) => {
      if (searchActive) return
      // The two kinds live in different stores and always list folder-first,
      // so a drag only reorders within its own group.
      const reordered = groupByScope(next).map((command, index) => ({
        ...command,
        sort_order: index,
      }))
      setCommands(reordered)
      pendingOrderRef.current = reordered.map((command) => command.id)
    },
    [searchActive]
  )

  const handleSave = useCallback(async () => {
    setSaving(true)
    setFormError(null)
    const previousId = draft.id
    const scopeChanged =
      previousId !== null && isGlobalCommandId(previousId) !== draft.global
    try {
      const name = draft.name.trim()
      const command = draft.command.trim()
      const { runLocal } = draft
      // An older folder host doesn't know "run on this computer": it stores
      // the command without it, to run in its own terminal.
      const notKept = () => new Error(t("runLocalNotKept"))
      let saved: FolderCommand
      if (previousId !== null && !scopeChanged) {
        if (isGlobalCommandId(previousId)) {
          saved = updateGlobalCommand(previousId, name, command, runLocal)
        } else {
          const updated = requireHostCommand(
            await updateFolderCommand(
              previousId,
              name,
              command,
              undefined,
              runLocal
            )
          )
          if (runLocal && !isLocalCommand(updated)) {
            // It kept the rest of the edit: show what it stored.
            setCommands((prev) =>
              prev.map((item) => (item.id === updated.id ? updated : item))
            )
            onChanged()
            throw notKept()
          }
          saved = updated
        }
      } else {
        // New, or moving between this folder and every folder: create it in
        // its new home first, so a failure there loses nothing.
        if (draft.global) {
          saved = createGlobalCommand(name, command, runLocal)
        } else {
          const created = requireHostCommand(
            await createFolderCommand(folderId, name, command, runLocal)
          )
          if (runLocal && !isLocalCommand(created)) {
            // Take it back out, so the save adds nothing — or, when that
            // fails too, show the copy the host kept.
            await deleteFolderCommand(created.id).catch(() => {
              setCommands((prev) => groupByScope([...prev, created]))
              onChanged()
            })
            throw notKept()
          }
          saved = created
        }
        if (previousId !== null) {
          if (isGlobalCommandId(previousId)) deleteGlobalCommand(previousId)
          else await deleteFolderCommand(previousId)
        }
      }
      setCommands((prev) => {
        const exists = prev.some((item) => item.id === saved.id)
        if (exists) {
          return prev.map((item) => (item.id === saved.id ? saved : item))
        }
        return groupByScope([
          ...prev.filter((item) => item.id !== previousId),
          saved,
        ])
      })
      setSelectedId(saved.id)
      setDraft({
        id: saved.id,
        name: saved.name,
        command: saved.command,
        global: isGlobalCommandId(saved.id),
        runLocal: isLocalCommand(saved),
      })
      onChanged()
    } catch (err) {
      setFormError(`${t("saveFailed")}: ${toErrorMessage(err)}`)
      // A move can fail after its copy was made; show what is really stored.
      if (scopeChanged) {
        void refresh()
        onChanged()
      }
    } finally {
      setSaving(false)
    }
  }, [draft, folderId, onChanged, refresh, t])

  const handleDelete = useCallback(async () => {
    if (deleteTargetId === null) return
    const target = deleteTargetId
    setDeleting(true)
    setFormError(null)
    try {
      if (isGlobalCommandId(target)) deleteGlobalCommand(target)
      else await deleteFolderCommand(target)
      setCommands((prev) => {
        const next = prev.filter((item) => item.id !== target)
        setSelectedId((current) =>
          current === target ? (next[0]?.id ?? null) : current
        )
        return next
      })
      onChanged()
      setDeleteTargetId(null)
    } catch (err) {
      setFormError(`${t("deleteFailed")}: ${toErrorMessage(err)}`)
      setDeleteTargetId(null)
    } finally {
      setDeleting(false)
    }
  }, [deleteTargetId, onChanged, t])

  const saveDisabled =
    saving || deleting || loading || !draft.name.trim() || !draft.command.trim()

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="flex h-[min(47.5rem,calc(100vh-4rem))] max-w-[min(61.25rem,calc(100vw-2rem))] flex-col gap-0 overflow-hidden p-0 sm:max-w-5xl">
          <DialogHeader className="border-b px-4 py-3">
            <DialogTitle>{t("title")}</DialogTitle>
          </DialogHeader>

          <div ref={panelContainerRef} className="min-h-0 min-w-0 flex-1 p-3">
            <ResizablePanelGroup
              direction="horizontal"
              className="h-full min-h-0 min-w-0"
            >
              <ResizablePanel
                defaultSize={36}
                minSize={leftMinSize}
                maxSize={leftMaxSize}
              >
                <div className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden rounded-lg border bg-card lg:rounded-r-none">
                  <div className="space-y-2.5 border-b p-3">
                    <div className="flex items-center gap-2">
                      <Input
                        value={searchQuery}
                        onChange={(event) => setSearchQuery(event.target.value)}
                        placeholder={t("searchPlaceholder")}
                      />
                      <Button size="sm" onClick={startNew} disabled={saving}>
                        <Plus className="h-3.5 w-3.5" />
                        {t("newCommand")}
                      </Button>
                    </div>
                  </div>

                  {loadError ? (
                    <div className="m-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                      {loadError}
                    </div>
                  ) : loading ? (
                    <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      {tCommon("loading")}
                    </div>
                  ) : filteredCommands.length === 0 ? (
                    <div className="flex flex-1 items-center justify-center px-4 text-center text-xs text-muted-foreground">
                      {commands.length === 0 ? t("empty") : t("noResults")}
                    </div>
                  ) : (
                    <Reorder.Group
                      as="div"
                      axis="y"
                      values={filteredCommands}
                      onReorder={handleReorder}
                      className="min-h-0 flex-1 space-y-2 overflow-y-auto p-2"
                    >
                      {filteredCommands.map((command) => {
                        const dragDisabled =
                          reordering ||
                          searchActive ||
                          filteredCommands.length < 2
                        return (
                          <CommandReorderItem
                            key={command.id}
                            command={command}
                            selected={selectedId === command.id}
                            disabled={dragDisabled}
                            onSelect={selectCommand}
                            onDragEnd={() => {
                              const order = pendingOrderRef.current
                              pendingOrderRef.current = null
                              if (order && !reordering) {
                                persistReorder(order).catch((err) => {
                                  console.error(
                                    "[CommandManage] reorder failed:",
                                    err
                                  )
                                })
                              }
                            }}
                          >
                            {(startDrag) => (
                              <div className="flex items-center gap-2 overflow-hidden">
                                <button
                                  type="button"
                                  className="cursor-grab rounded p-0.5 text-muted-foreground hover:bg-muted active:cursor-grabbing disabled:cursor-default disabled:opacity-40"
                                  title={t("dragSort")}
                                  aria-label={t("dragSortCommand", {
                                    name: command.name,
                                  })}
                                  onPointerDown={startDrag}
                                  onClick={(event) => event.stopPropagation()}
                                  disabled={dragDisabled}
                                >
                                  <GripVertical className="h-3.5 w-3.5" />
                                </button>
                                <div className="min-w-0 flex-1">
                                  <div className="flex items-center gap-1.5">
                                    <span className="truncate text-sm font-medium">
                                      {command.name}
                                    </span>
                                    {isLocalCommand(command) ? (
                                      <Monitor
                                        className="h-3 w-3 shrink-0 text-muted-foreground"
                                        aria-label={t("runLocalLabel")}
                                      />
                                    ) : null}
                                    {isGlobalCommandId(command.id) ? (
                                      <Globe
                                        className="h-3 w-3 shrink-0 text-muted-foreground"
                                        aria-label={t("globalLabel")}
                                      />
                                    ) : null}
                                  </div>
                                  <div className="mt-0.5 truncate font-mono text-2xs text-muted-foreground">
                                    {command.command}
                                  </div>
                                </div>
                              </div>
                            )}
                          </CommandReorderItem>
                        )
                      })}
                    </Reorder.Group>
                  )}
                </div>
              </ResizablePanel>

              <ResizableHandle withHandle />

              <ResizablePanel defaultSize={64} minSize={rightMinSize}>
                <div className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden rounded-lg border bg-card lg:rounded-l-none lg:border-l-0">
                  <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
                    <div className="space-y-1.5">
                      <Label htmlFor="folder-command-name" className="text-xs">
                        {t("nameLabel")}
                      </Label>
                      <Input
                        id="folder-command-name"
                        value={draft.name}
                        onChange={(event) =>
                          updateDraft({ name: event.target.value })
                        }
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label
                        htmlFor="folder-command-command"
                        className="text-xs"
                      >
                        {t("commandLabel")}
                      </Label>
                      <Input
                        id="folder-command-command"
                        className="font-mono"
                        value={draft.command}
                        placeholder="pnpm dev"
                        onChange={(event) =>
                          updateDraft({ command: event.target.value })
                        }
                      />
                    </div>
                    {/* Only the desktop app runs a command on its own machine. */}
                    {isDesktop() ? (
                      <div className="flex items-start justify-between gap-3">
                        <div className="space-y-0.5">
                          <Label
                            htmlFor="folder-command-run-local"
                            className="text-xs"
                          >
                            {t("runLocalLabel")}
                          </Label>
                          <p className="text-xs text-muted-foreground">
                            {t.rich("runLocalHint", {
                              ...localHintValues,
                              code: hintLiteral,
                            })}
                          </p>
                        </div>
                        <Switch
                          id="folder-command-run-local"
                          checked={draft.runLocal}
                          onCheckedChange={(checked) =>
                            updateDraft({ runLocal: checked })
                          }
                        />
                      </div>
                    ) : null}
                    <div className="flex items-start justify-between gap-3">
                      <div className="space-y-0.5">
                        <Label
                          htmlFor="folder-command-global"
                          className="text-xs"
                        >
                          {t("globalLabel")}
                        </Label>
                        <p className="text-xs text-muted-foreground">
                          {t("globalHint")}
                        </p>
                      </div>
                      <Switch
                        id="folder-command-global"
                        checked={draft.global}
                        onCheckedChange={(checked) =>
                          updateDraft({ global: checked })
                        }
                      />
                    </div>
                  </div>

                  <div className="space-y-3 border-t px-4 py-3">
                    {formError ? (
                      <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                        {formError}
                      </div>
                    ) : null}
                    <div className="flex items-center justify-between gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => setDeleteTargetId(draft.id)}
                        disabled={
                          deleting || saving || loading || draft.id === null
                        }
                        className="text-red-500 hover:text-red-500"
                      >
                        {deleting ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Trash2 className="h-3.5 w-3.5" />
                        )}
                        {tCommon("delete")}
                      </Button>
                      <Button
                        size="sm"
                        onClick={() => {
                          handleSave().catch((err) => {
                            console.error("[CommandManage] save failed:", err)
                          })
                        }}
                        disabled={saveDisabled}
                      >
                        {saving ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Save className="h-3.5 w-3.5" />
                        )}
                        {tCommon("save")}
                      </Button>
                    </div>
                  </div>
                </div>
              </ResizablePanel>
            </ResizablePanelGroup>
          </div>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={deleteTargetId !== null}
        onOpenChange={(nextOpen) => {
          if (!nextOpen && !deleting) setDeleteTargetId(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("confirmDelete.title")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("confirmDelete.message", {
                name: deleteTarget?.name ?? "",
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>
              {tCommon("cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={(event) => {
                event.preventDefault()
                handleDelete().catch((err) => {
                  console.error("[CommandManage] delete failed:", err)
                })
              }}
              disabled={deleting}
            >
              {deleting ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : null}
              {tCommon("delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
