"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { formatDistance } from "date-fns"
import {
  Loader2,
  Map as MapIcon,
  MoreHorizontal,
  Pencil,
  Plus,
  Search,
  SquareArrowOutUpRight,
  Trash2,
} from "lucide-react"
import { useLocale, useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import { dateFnsLocale } from "@/lib/date-fns-locale"
import type { CanvasBoard, CanvasBoardSummary } from "@/lib/types"
import { cn } from "@/lib/utils"
import { useCanvasBoardsStore } from "@/stores/canvas-boards-store"
import {
  useCanvasBoardActions,
  useCanvasBoardStatsRefresh,
} from "./canvas-board-actions"
import {
  CanvasBoardDeleteDialog,
  CanvasBoardFormDialog,
  useBoardDisplayName,
} from "./canvas-board-dialogs"
import { CanvasBoardPreview } from "./canvas-board-preview"
import { canvasTint } from "./canvas-swatches"

/** How often "edited 5 minutes ago" is re-evaluated. Minute resolution is all
 *  the phrase has. */
const CLOCK_TICK_MS = 60_000

/**
 * A wall clock for relative times, starting at 0 ("not known yet") and set by
 * the first tick. Not `useState(() => Date.now())`: that still reads the clock
 * during render, and a value read once would never move anyway.
 */
function useNow(): number {
  const [now, setNow] = useState(0)
  useEffect(() => {
    const tick = () => setNow(Date.now())
    tick()
    const id = setInterval(tick, CLOCK_TICK_MS)
    return () => clearInterval(id)
  }, [])
  return now
}

/** Which dialog is up: the form (create when `board` is null, else edit). */
type FormState = { open: boolean; board: CanvasBoard | null }

/**
 * The canvas route's top level: every canvas as a card — its thumbnail, name,
 * description, how much is on it and when it was last edited — with create,
 * edit and delete. Clicking a card opens that canvas.
 */
export function CanvasBoardList() {
  useCanvasBoardStatsRefresh()
  const t = useTranslations("Canvas")
  const boards = useCanvasBoardsStore((s) => s.boards)
  const hydrated = useCanvasBoardsStore((s) => s.hydrated)
  const loadError = useCanvasBoardsStore((s) => s.loadError)
  const openBoard = useCanvasBoardsStore((s) => s.openBoard)
  const { createBoard, updateBoard, deleteBoard } = useCanvasBoardActions()
  const displayName = useBoardDisplayName()
  const now = useNow()

  const [query, setQuery] = useState("")
  const [form, setForm] = useState<FormState>({ open: false, board: null })
  const [deleteTarget, setDeleteTarget] = useState<CanvasBoardSummary | null>(
    null
  )
  const [deleteOpen, setDeleteOpen] = useState(false)

  const openCreate = useCallback(() => setForm({ open: true, board: null }), [])
  const openEdit = useCallback(
    (board: CanvasBoard) => setForm({ open: true, board }),
    []
  )
  const askDelete = useCallback((summary: CanvasBoardSummary) => {
    setDeleteTarget(summary)
    setDeleteOpen(true)
  }, [])

  const visible = useMemo(() => {
    const q = query.trim().toLocaleLowerCase()
    if (!q) return boards
    return boards.filter(
      (s) =>
        displayName(s.board).toLocaleLowerCase().includes(q) ||
        (s.board.description ?? "").toLocaleLowerCase().includes(q)
    )
  }, [boards, query, displayName])

  let body: React.ReactNode
  if (!hydrated && !loadError) {
    body = (
      <div className="flex flex-1 items-center justify-center">
        <Loader2 className="size-5 animate-spin text-muted-foreground/60" />
      </div>
    )
  } else if (!hydrated) {
    body = (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
        <LoadError message={loadError} />
      </div>
    )
  } else if (boards.length === 0) {
    // First visit, or every canvas deleted: the call to action IS the page.
    body = (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
        <MapIcon
          className="size-10 text-muted-foreground/40"
          aria-hidden="true"
        />
        <div className="flex flex-col gap-1">
          <p className="text-sm font-medium">{t("boardsEmpty")}</p>
          <p className="max-w-sm text-xs text-muted-foreground">
            {t("boardsEmptyHint")}
          </p>
        </div>
        <Button size="sm" className="gap-1.5" onClick={openCreate}>
          <Plus className="size-3.5" />
          {t("newBoard")}
        </Button>
      </div>
    )
  } else {
    body = (
      <ScrollArea className="min-h-0 flex-1">
        {/* Outer gutter, then the capped column — the same geometry as the
            toolbar above, so the two stay flush at every width. */}
        <div className="px-4 pb-6">
          <div className="mx-auto w-full max-w-6xl">
            {loadError && (
              <div className="mb-4">
                <LoadError message={loadError} inline />
              </div>
            )}
            {visible.length === 0 ? (
              <p className="py-12 text-center text-sm text-muted-foreground">
                {t("noBoardsMatch", { query: query.trim() })}
              </p>
            ) : (
              // Equal row heights: a card with no description is as tall as
              // one with two lines, and the trailing "new" tile — often alone
              // in its row — matches the cards instead of shrinking.
              <div className="grid auto-rows-fr grid-cols-[repeat(auto-fill,minmax(15rem,1fr))] gap-4">
                {visible.map((summary) => (
                  <BoardCard
                    key={summary.board.id}
                    summary={summary}
                    now={now}
                    onOpen={() => openBoard(summary.board.id)}
                    onEdit={() => openEdit(summary.board)}
                    onDelete={() => askDelete(summary)}
                  />
                ))}
                {!query.trim() && <NewBoardCard onClick={openCreate} />}
              </div>
            )}
          </div>
        </div>
      </ScrollArea>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 px-4 pb-4 pt-5">
        <div className="mx-auto flex w-full max-w-6xl flex-wrap items-end justify-between gap-x-4 gap-y-3">
          <div className="min-w-0">
            <h2 className="flex items-baseline gap-2 text-base font-semibold leading-tight">
              {t("boardsTitle")}
              {hydrated && boards.length > 0 && (
                <span className="text-xs font-normal text-muted-foreground">
                  {t("boardCount", { count: boards.length })}
                </span>
              )}
            </h2>
            <p className="mt-1 max-w-xl text-xs text-muted-foreground">
              {t("boardsSubtitle")}
            </p>
          </div>
          {hydrated && boards.length > 0 && (
            <div className="flex items-center gap-2">
              <div className="relative">
                <Search
                  className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
                  aria-hidden="true"
                />
                <Input
                  type="search"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={t("searchBoards")}
                  aria-label={t("searchBoards")}
                  className="h-8 w-52 pl-8 text-xs"
                />
              </div>
              <Button size="sm" className="gap-1.5" onClick={openCreate}>
                <Plus className="size-3.5" />
                {t("newBoard")}
              </Button>
            </div>
          )}
        </div>
      </div>

      {body}

      <CanvasBoardFormDialog
        open={form.open}
        onOpenChange={(open) => setForm((prev) => ({ ...prev, open }))}
        board={form.board}
        onSubmit={(values) =>
          form.board ? updateBoard(form.board.id, values) : createBoard(values)
        }
      />
      <CanvasBoardDeleteDialog
        summary={deleteTarget}
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        onConfirm={(boardId) => {
          setDeleteOpen(false)
          void deleteBoard(boardId)
        }}
      />
    </div>
  )
}

function LoadError({
  message,
  inline = false,
}: {
  message: string | null
  inline?: boolean
}) {
  const t = useTranslations("Canvas")
  const refetch = useCanvasBoardsStore((s) => s.refetch)
  return (
    <div
      className={cn(
        "flex items-center gap-3 rounded-xl border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm text-destructive",
        !inline && "max-w-md"
      )}
      role="alert"
    >
      <span className="min-w-0 flex-1 text-left">
        {t("boardsLoadFailed")}
        {message ? `: ${message}` : null}
      </span>
      <Button
        size="sm"
        variant="outline"
        className="shrink-0"
        onClick={() => void refetch()}
      >
        {t("retry")}
      </Button>
    </div>
  )
}

function BoardCard({
  summary,
  now,
  onOpen,
  onEdit,
  onDelete,
}: {
  summary: CanvasBoardSummary
  now: number
  onOpen: () => void
  onEdit: () => void
  onDelete: () => void
}) {
  const t = useTranslations("Canvas")
  const locale = useLocale()
  const displayName = useBoardDisplayName()
  const { board } = summary
  const name = displayName(board)
  const tint = canvasTint(board.color)

  const edited = useMemo(() => {
    const at = Date.parse(board.updated_at)
    if (now === 0 || Number.isNaN(at)) return null
    // Never "in 2 seconds": the server's clock may run a moment ahead.
    return formatDistance(Math.min(at, now), now, {
      addSuffix: true,
      locale: dateFnsLocale(locale),
    })
  }, [board.updated_at, now, locale])

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          className={cn(
            "group/board relative flex flex-col overflow-hidden rounded-xl border border-border bg-card",
            "transition-[border-color,box-shadow] hover:border-foreground/25 hover:shadow-sm",
            "focus-within:border-foreground/25"
          )}
          title={new Date(board.updated_at).toLocaleString(locale)}
        >
          {/* The whole card opens the canvas: one real button stretched over
              it, rather than a clickable div wrapping a second control (the
              menu), which would nest one interactive element in another. */}
          <button
            type="button"
            className="absolute inset-0 z-0 rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
            onClick={onOpen}
            aria-label={name}
          />
          <CanvasBoardPreview
            rects={summary.preview}
            className="pointer-events-none relative aspect-[16/10] border-b border-border bg-background"
          />
          {tint && (
            <span
              className="pointer-events-none absolute inset-x-0 top-0 h-1"
              style={{ backgroundColor: tint }}
              aria-hidden="true"
            />
          )}
          <div className="pointer-events-none relative flex min-w-0 flex-col gap-1 px-3 py-2.5">
            <span className="truncate text-sm font-medium">{name}</span>
            {board.description && (
              <p className="line-clamp-2 whitespace-pre-line break-words text-xs text-muted-foreground">
                {board.description}
              </p>
            )}
            <p className="truncate text-[0.6875rem] text-muted-foreground/80">
              {t("boardItemCount", { count: summary.node_count })}
              {edited && <> · {t("boardEditedAt", { time: edited })}</>}
            </p>
          </div>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="secondary"
                size="icon"
                className={cn(
                  "absolute right-2 top-2 z-10 size-7 rounded-lg shadow-sm",
                  // Shown on hover or keyboard focus — and kept while its own
                  // menu is open, when the modal menu takes :hover away.
                  "opacity-0 transition-opacity group-hover/board:opacity-100 group-focus-within/board:opacity-100 data-[state=open]:opacity-100"
                )}
                aria-label={t("boardMenu")}
                title={t("boardMenu")}
              >
                <MoreHorizontal className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-40">
              <DropdownMenuItem onSelect={onOpen}>
                <SquareArrowOutUpRight />
                {t("openBoard")}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={onEdit}>
                <Pencil />
                {t("editBoard")}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onSelect={onDelete}>
                <Trash2 />
                {t("deleteBoard")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent className="min-w-40">
        <ContextMenuItem onSelect={onOpen}>
          <SquareArrowOutUpRight />
          {t("openBoard")}
        </ContextMenuItem>
        <ContextMenuItem onSelect={onEdit}>
          <Pencil />
          {t("editBoard")}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem variant="destructive" onSelect={onDelete}>
          <Trash2 />
          {t("deleteBoard")}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}

/** The trailing "new canvas" tile: the create action where the next card
 *  would go, so it is found without looking back up at the toolbar. The grid
 *  gives it a card's height (see `auto-rows-fr`). */
function NewBoardCard({ onClick }: { onClick: () => void }) {
  const t = useTranslations("Canvas")
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex min-h-[10rem] flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border text-muted-foreground",
        "transition-colors hover:border-foreground/30 hover:bg-foreground/[0.03] hover:text-foreground",
        "outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
      )}
    >
      <Plus className="size-5" />
      <span className="text-xs font-medium">{t("newBoard")}</span>
    </button>
  )
}
