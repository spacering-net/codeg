"use client"

import { useEffect, useState } from "react"
import dynamic from "next/dynamic"
import {
  ChevronDown,
  ChevronRight,
  Loader2,
  Pencil,
  Trash2,
} from "lucide-react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { WorkbenchPageTitle } from "@/components/workbench/workbench-page-title"
import type { CanvasBoardSummary } from "@/lib/types"
import { useCanvasBoardsStore } from "@/stores/canvas-boards-store"
import { useCanvasStore } from "@/stores/canvas-store"
import {
  useCanvasBoardActions,
  useCanvasBoardsData,
} from "./canvas-board-actions"
import {
  CanvasBoardDeleteDialog,
  CanvasBoardFormDialog,
  useBoardDisplayName,
} from "./canvas-board-dialogs"
import { CanvasBoardList } from "./canvas-board-list"
import { ColorDot } from "./canvas-swatches"

/**
 * ReactFlow (and the canvas machinery) stays out of the first-paint chunk:
 * the page shell is registered in WORKBENCH_ROUTES, the heavy view loads on
 * first visit. `ssr: false` is moot under static export but explicit — the
 * view reads `window` for viewport math.
 */
const CanvasView = dynamic(() => import("./canvas-view"), {
  ssr: false,
  loading: () => (
    <div className="flex h-full items-center justify-center">
      <Loader2 className="size-5 animate-spin text-muted-foreground/60" />
    </div>
  ),
})

/** Characters no file system accepts in a name, for the PNG export. */
const UNSAFE_FILE_CHARS = /[\\/:*?"<>|\u0000-\u001f]+/g

/**
 * The canvas route: the list of canvases, or — once one is opened — that
 * canvas's board. Which one is showing lives in the boards store rather than
 * here, because the window-chrome strip above the page (the breadcrumb) has to
 * know it too.
 */
export function CanvasPage() {
  useCanvasBoardsData()
  const t = useTranslations("Canvas")
  const activeBoardId = useCanvasBoardsStore((s) => s.activeBoardId)
  const closeMissingBoard = useCanvasBoardsStore((s) => s.closeMissingBoard)
  const closedNotice = useCanvasBoardsStore((s) => s.closedNotice)
  const acknowledgeClosedNotice = useCanvasBoardsStore(
    (s) => s.acknowledgeClosedNotice
  )
  const board = useCanvasBoardsStore((s) =>
    s.activeBoardId == null
      ? null
      : (s.boards.find((b) => b.board.id === s.activeBoardId) ?? null)
  )
  const displayName = useBoardDisplayName()

  // The open board's snapshot came back `not_found`: it was deleted while this
  // client was not listening (another window, while this route was closed, or
  // across a dropped socket). The board event covers the live case; this is
  // the one that catches the rest.
  const missing = useCanvasStore(
    (s) =>
      activeBoardId != null && s.boardId === activeBoardId && s.boardMissing
  )
  useEffect(() => {
    if (missing && activeBoardId != null) closeMissingBoard(activeBoardId)
  }, [missing, activeBoardId, closeMissingBoard])

  useEffect(() => {
    if (closedNotice == null) return
    toast.info(t("boardDeleted"))
    acknowledgeClosedNotice()
  }, [closedNotice, acknowledgeClosedNotice, t])

  if (activeBoardId == null) return <CanvasBoardList />

  const exportName =
    displayName(board?.board).replace(UNSAFE_FILE_CHARS, "-").trim() || "canvas"
  return (
    <div className="h-full min-h-0 w-full">
      {/* Keyed by board: every piece of the view's state (viewport, drafts,
          expansions, selection, live surfaces) is per board, and a remount is
          what starts it from the next board's own memory. */}
      <CanvasView
        key={activeBoardId}
        boardId={activeBoardId}
        exportName={exportName}
      />
    </div>
  )
}

export function CanvasPageTitle() {
  const t = useTranslations("Canvas")
  const activeBoardId = useCanvasBoardsStore((s) => s.activeBoardId)
  const closeBoard = useCanvasBoardsStore((s) => s.closeBoard)
  const summary = useCanvasBoardsStore((s) =>
    s.activeBoardId == null
      ? null
      : (s.boards.find((b) => b.board.id === s.activeBoardId) ?? null)
  )

  if (activeBoardId == null) return <WorkbenchPageTitle title={t("title")} />
  return (
    <WorkbenchPageTitle
      title={t("title")}
      onTitleClick={closeBoard}
      titleActionLabel={t("backToBoards")}
      trail={
        <>
          <ChevronRight
            className="size-3 shrink-0 text-muted-foreground/50"
            aria-hidden="true"
          />
          <BoardTitleMenu summary={summary} />
        </>
      }
    />
  )
}

/**
 * The open board's name in the breadcrumb, doubling as its menu: rename it or
 * delete it without going back to the list first. Before the list has loaded
 * (straight back into a board after a route switch) there is no row to show
 * or act on yet, so it is a quiet placeholder.
 */
function BoardTitleMenu({ summary }: { summary: CanvasBoardSummary | null }) {
  const t = useTranslations("Canvas")
  const displayName = useBoardDisplayName()
  const { updateBoard, deleteBoard } = useCanvasBoardActions()
  const [editOpen, setEditOpen] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)

  if (!summary) {
    return (
      <span className="px-1 text-[0.8125rem] leading-none text-muted-foreground/60">
        …
      </span>
    )
  }
  const { board } = summary
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            // Capped by the window too: the strip does not shrink, and on a
            // phone a long name would otherwise push the title bar's own
            // controls out of reach.
            className="flex min-w-0 max-w-[min(18rem,40vw)] items-center gap-1.5 rounded-md px-1 py-1 text-[0.8125rem] font-semibold leading-none transition-colors hover:bg-foreground/10 data-[state=open]:bg-foreground/10"
            aria-label={t("boardMenu")}
          >
            {board.color && (
              <ColorDot value={board.color} className="size-2.5" />
            )}
            <span className="min-w-0 truncate">{displayName(board)}</span>
            <ChevronDown
              className="size-3 shrink-0 text-muted-foreground"
              aria-hidden="true"
            />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="min-w-44">
          <DropdownMenuItem onSelect={() => setEditOpen(true)}>
            <Pencil />
            {t("editBoard")}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            variant="destructive"
            onSelect={() => setDeleteOpen(true)}
          >
            <Trash2 />
            {t("deleteBoard")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <CanvasBoardFormDialog
        open={editOpen}
        onOpenChange={setEditOpen}
        board={board}
        onSubmit={(values) => updateBoard(board.id, values)}
      />
      <CanvasBoardDeleteDialog
        summary={summary}
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        onConfirm={(boardId) => {
          setDeleteOpen(false)
          void deleteBoard(boardId)
        }}
      />
    </>
  )
}
