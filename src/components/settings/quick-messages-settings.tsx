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
import { GripVertical, Loader2, Plus, Save, Trash2 } from "lucide-react"
import { Reorder, useDragControls } from "motion/react"
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
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable"
import { Textarea } from "@/components/ui/textarea"
import { cn } from "@/lib/utils"
import {
  quickMessagesCreate,
  quickMessagesDelete,
  quickMessagesList,
  quickMessagesReorder,
  quickMessagesUpdate,
} from "@/lib/api"
import type { QuickMessage } from "@/lib/types"
import { toErrorMessage } from "@/lib/app-error"

const LEFT_MIN_WIDTH = 280
const RIGHT_MIN_WIDTH = 420

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function toPercent(pixels: number, totalPixels: number): number {
  if (totalPixels <= 0) return 0
  return (pixels / totalPixels) * 100
}

interface QuickMessageReorderItemProps {
  message: QuickMessage
  selected: boolean
  reordering: boolean
  onSelect: (id: number) => void
  onDragStart: () => void
  onDragEnd: () => void
  children: (
    startDrag: (event: PointerEvent<HTMLButtonElement>) => void
  ) => ReactNode
}

function QuickMessageReorderItem({
  message,
  selected,
  reordering,
  onSelect,
  onDragStart,
  onDragEnd,
  children,
}: QuickMessageReorderItemProps) {
  const dragControls = useDragControls()

  const startDrag = useCallback(
    (event: PointerEvent<HTMLButtonElement>) => {
      event.preventDefault()
      event.stopPropagation()
      dragControls.start(event)
    },
    [dragControls]
  )

  return (
    <Reorder.Item
      as="section"
      value={message}
      data-quick-message-id={message.id}
      drag={reordering ? false : "y"}
      dragListener={false}
      dragControls={dragControls}
      dragMomentum={false}
      layout="position"
      className={cn(
        "rounded-lg border bg-card p-2.5 transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40",
        selected && "border-primary/60 bg-primary/5"
      )}
      tabIndex={0}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onClick={() => onSelect(message.id)}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return
        if (event.key !== "Enter" && event.key !== " ") return
        event.preventDefault()
        onSelect(message.id)
      }}
    >
      {children(startDrag)}
    </Reorder.Item>
  )
}

export function QuickMessagesSettings() {
  const t = useTranslations("QuickMessagesSettings")

  const [messages, setMessages] = useState<QuickMessage[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [searchQuery, setSearchQuery] = useState("")

  const [draftTitle, setDraftTitle] = useState("")
  const [draftContent, setDraftContent] = useState("")
  const [saving, setSaving] = useState(false)
  const [creating, setCreating] = useState(false)
  const [deleteTargetId, setDeleteTargetId] = useState<number | null>(null)
  const [deleting, setDeleting] = useState(false)

  const [reordering, setReordering] = useState(false)
  const pendingOrderRef = useRef<number[] | null>(null)

  const panelContainerRef = useRef<HTMLDivElement | null>(null)
  const [panelContainerWidth, setPanelContainerWidth] = useState(0)
  const titleInputRef = useRef<HTMLInputElement | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    setLoadError(null)
    try {
      const list = await quickMessagesList()
      setMessages(list)
    } catch (err) {
      const message = toErrorMessage(err)
      setLoadError(message)
      setMessages([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial list fetch; the loader flips its loading flag first
    refresh().catch((err) => {
      console.error("[QuickMessagesSettings] initial refresh failed:", err)
    })
  }, [refresh])

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
  }, [])

  const selectedMessage = useMemo(
    () => messages.find((m) => m.id === selectedId) ?? null,
    [messages, selectedId]
  )

  // Re-seed the editor whenever the selected message (or its stored copy)
  // changes. Adjusted while rendering; both start empty, so mount needs none.
  const [seededMessage, setSeededMessage] = useState(selectedMessage)
  if (selectedMessage !== seededMessage) {
    setSeededMessage(selectedMessage)
    setDraftTitle(selectedMessage?.title ?? "")
    setDraftContent(selectedMessage?.content ?? "")
  }

  // Fall back to the first message whenever nothing is selected.
  if (selectedId === null && messages.length > 0) {
    setSelectedId(messages[0].id)
  }

  const filteredMessages = useMemo(() => {
    const q = searchQuery.trim().toLowerCase()
    if (!q) return messages
    return messages.filter(
      (m) =>
        m.title.toLowerCase().includes(q) || m.content.toLowerCase().includes(q)
    )
  }, [messages, searchQuery])

  const isDirty = useMemo(() => {
    if (!selectedMessage) return false
    return (
      draftTitle !== selectedMessage.title ||
      draftContent !== selectedMessage.content
    )
  }, [selectedMessage, draftTitle, draftContent])

  const persistReorder = useCallback(
    async (ids: number[]) => {
      if (ids.length === 0) return
      setReordering(true)
      try {
        await quickMessagesReorder(ids)
      } catch (err) {
        const message = toErrorMessage(err)
        toast.error(t("toasts.saveOrderFailed"), { description: message })
        await refresh()
      } finally {
        setReordering(false)
      }
    },
    [refresh, t]
  )

  const handleReorder = useCallback((next: QuickMessage[]) => {
    const reordered = next.map((m, index) => ({ ...m, sort_order: index }))
    setMessages(reordered)
    pendingOrderRef.current = reordered.map((m) => m.id)
  }, [])

  const handleCreate = useCallback(async () => {
    setCreating(true)
    try {
      const created = await quickMessagesCreate({ title: "", content: "" })
      setMessages((prev) => [...prev, created])
      setSelectedId(created.id)
      toast.success(t("toasts.created"))
      requestAnimationFrame(() => {
        titleInputRef.current?.focus()
      })
    } catch (err) {
      const message = toErrorMessage(err)
      toast.error(t("toasts.createFailed"), { description: message })
    } finally {
      setCreating(false)
    }
  }, [t])

  const handleSave = useCallback(async () => {
    if (!selectedMessage) return
    setSaving(true)
    try {
      const updated = await quickMessagesUpdate({
        id: selectedMessage.id,
        title: draftTitle,
        content: draftContent,
      })
      setMessages((prev) =>
        prev.map((m) => (m.id === updated.id ? updated : m))
      )
      toast.success(t("toasts.saved"))
    } catch (err) {
      const message = toErrorMessage(err)
      toast.error(t("toasts.saveFailed"), { description: message })
    } finally {
      setSaving(false)
    }
  }, [selectedMessage, draftTitle, draftContent, t])

  const handleDelete = useCallback(async () => {
    if (deleteTargetId === null) return
    const target = deleteTargetId
    setDeleting(true)
    try {
      await quickMessagesDelete(target)
      setMessages((prev) => {
        const next = prev.filter((m) => m.id !== target)
        if (selectedId === target) {
          setSelectedId(next[0]?.id ?? null)
        }
        return next
      })
      toast.success(t("toasts.deleted"))
      setDeleteTargetId(null)
    } catch (err) {
      const message = toErrorMessage(err)
      toast.error(t("toasts.deleteFailed"), { description: message })
    } finally {
      setDeleting(false)
    }
  }, [deleteTargetId, selectedId, t])

  const safeContainerWidth =
    panelContainerWidth > 0 ? panelContainerWidth : 1200
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

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
        {t("loading")}
      </div>
    )
  }

  const deleteTargetMessage =
    deleteTargetId !== null
      ? (messages.find((m) => m.id === deleteTargetId) ?? null)
      : null

  return (
    <div className="h-full flex flex-col p-3 md:p-4">
      <div className="flex items-center justify-between gap-3 pb-4">
        <div>
          <h2 className="text-base font-semibold">{t("title")}</h2>
          <p className="text-xs text-muted-foreground mt-1">
            {t("description")}
          </p>
        </div>
      </div>

      {loadError && (
        <div className="mb-3 rounded-md border border-red-500/30 bg-red-500/5 px-3 py-2 text-xs text-red-400">
          {loadError}
        </div>
      )}

      <div ref={panelContainerRef} className="flex-1 min-h-0 min-w-0">
        <ResizablePanelGroup
          direction="horizontal"
          className="h-full min-h-0 min-w-0"
        >
          <ResizablePanel
            defaultSize={34}
            minSize={leftMinSize}
            maxSize={leftMaxSize}
          >
            <div className="min-h-0 h-full min-w-0 rounded-lg border bg-card flex flex-col overflow-hidden lg:rounded-r-none">
              <div className="border-b p-3 space-y-2.5">
                <div className="flex items-center gap-2">
                  <Input
                    value={searchQuery}
                    onChange={(event) => setSearchQuery(event.target.value)}
                    placeholder={t("searchPlaceholder")}
                  />
                  <Button
                    size="sm"
                    onClick={() => {
                      handleCreate().catch((err) => {
                        console.error(
                          "[QuickMessagesSettings] create failed:",
                          err
                        )
                      })
                    }}
                    disabled={creating}
                  >
                    {creating ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Plus className="h-3.5 w-3.5" />
                    )}
                    {t("actions.new")}
                  </Button>
                </div>
              </div>

              {filteredMessages.length === 0 ? (
                <div className="flex-1 flex items-center justify-center text-xs text-muted-foreground px-4 text-center">
                  {messages.length === 0
                    ? t("emptyList")
                    : t("searchPlaceholder")}
                </div>
              ) : (
                <Reorder.Group
                  as="div"
                  axis="y"
                  values={messages}
                  onReorder={handleReorder}
                  className="flex-1 min-h-0 overflow-y-auto space-y-2 p-2"
                >
                  {filteredMessages.map((m) => (
                    <QuickMessageReorderItem
                      key={m.id}
                      message={m}
                      selected={selectedId === m.id}
                      reordering={reordering}
                      onSelect={(id) => setSelectedId(id)}
                      onDragStart={() => {
                        /* no-op: list re-render handles dragging state */
                      }}
                      onDragEnd={() => {
                        const order = pendingOrderRef.current
                        pendingOrderRef.current = null
                        if (order && !reordering) {
                          persistReorder(order).catch((err) => {
                            console.error(
                              "[QuickMessagesSettings] reorder failed:",
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
                            className="text-muted-foreground cursor-grab active:cursor-grabbing rounded p-0.5 hover:bg-muted"
                            title={t("actions.dragSort")}
                            aria-label={t("actions.dragSortMessage", {
                              name: m.title || t("untitled"),
                            })}
                            onPointerDown={startDrag}
                            onClick={(event) => event.stopPropagation()}
                            disabled={reordering}
                          >
                            <GripVertical className="h-3.5 w-3.5" />
                          </button>
                          <div className="min-w-0 flex-1">
                            <div className="text-sm font-medium truncate">
                              {m.title || (
                                <span className="italic text-muted-foreground">
                                  {t("untitled")}
                                </span>
                              )}
                            </div>
                            {m.content && (
                              <div className="text-2xs text-muted-foreground truncate mt-0.5">
                                {m.content}
                              </div>
                            )}
                          </div>
                        </div>
                      )}
                    </QuickMessageReorderItem>
                  ))}
                </Reorder.Group>
              )}
            </div>
          </ResizablePanel>

          <ResizableHandle withHandle />

          <ResizablePanel defaultSize={66} minSize={rightMinSize}>
            <div className="h-full flex-1 min-h-0 min-w-0 rounded-lg border bg-card overflow-hidden lg:rounded-l-none lg:border-l-0">
              {selectedMessage ? (
                <div className="h-full flex flex-col">
                  <div className="flex-1 overflow-y-auto p-4 space-y-4">
                    <div className="space-y-1.5">
                      <Label htmlFor="quick-message-title" className="text-xs">
                        {t("fields.title")}
                      </Label>
                      <Input
                        id="quick-message-title"
                        ref={titleInputRef}
                        value={draftTitle}
                        onChange={(event) => setDraftTitle(event.target.value)}
                        placeholder={t("fields.titlePlaceholder")}
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label
                        htmlFor="quick-message-content"
                        className="text-xs"
                      >
                        {t("fields.content")}
                      </Label>
                      <Textarea
                        id="quick-message-content"
                        value={draftContent}
                        onChange={(event) =>
                          setDraftContent(event.target.value)
                        }
                        placeholder={t("fields.contentPlaceholder")}
                        className="min-h-[16.25rem]"
                      />
                    </div>
                  </div>
                  <div className="border-t px-4 py-3 flex items-center justify-between gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setDeleteTargetId(selectedMessage.id)}
                      className="text-red-500 hover:text-red-500"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                      {t("actions.delete")}
                    </Button>
                    <Button
                      size="sm"
                      onClick={() => {
                        handleSave().catch((err) => {
                          console.error(
                            "[QuickMessagesSettings] save failed:",
                            err
                          )
                        })
                      }}
                      disabled={saving || !isDirty}
                    >
                      {saving ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Save className="h-3.5 w-3.5" />
                      )}
                      {t("actions.save")}
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="h-full flex items-center justify-center text-xs text-muted-foreground">
                  {t("emptySelection")}
                </div>
              )}
            </div>
          </ResizablePanel>
        </ResizablePanelGroup>
      </div>

      <AlertDialog
        open={deleteTargetId !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTargetId(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("confirmDelete.title")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("confirmDelete.message", {
                name: deleteTargetMessage?.title || t("untitled"),
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>
              {t("confirmDelete.cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={(event) => {
                event.preventDefault()
                handleDelete().catch((err) => {
                  console.error("[QuickMessagesSettings] delete failed:", err)
                })
              }}
              disabled={deleting}
            >
              {deleting ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : null}
              {t("confirmDelete.confirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
