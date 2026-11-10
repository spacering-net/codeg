"use client"

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react"
import { createPortal } from "react-dom"
import { Reorder, type PanInfo } from "motion/react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { Funnel, Play, Plus, ListTodo, Search, Tag, X } from "lucide-react"
import { useTasksView } from "@/contexts/tasks-view-context"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"
import { workTaskArchive, workTaskReorder, workTaskStart } from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"
import { clearTasksFocus, peekTasksFocus } from "@/lib/workbench-focus"
import {
  DEFAULT_TASKS_BOARD_FILTER,
  loadTasksBoardFilter,
  loadTasksStatusFilter,
  saveTasksBoardFilter,
  saveTasksStatusFilter,
} from "@/lib/tasks-board-filter-storage"
import { WorkbenchPageTitle } from "@/components/workbench/workbench-page-title"
import { FolderSelect } from "@/components/shared/folder-select"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { cn } from "@/lib/utils"
import {
  BOARD_COLUMN_IDS,
  filterTasksForList,
  groupTasksByColumn,
  type BoardColumnId,
} from "./board-columns"
import { isDeferred, mergeQueueRanks } from "./task-acceptance"
import { StatusChip, TaskCard } from "./task-card"
import { TaskList } from "./task-list"
import { searchTerms, taskMatchesSearch } from "./task-search"
import { TaskSettingsDialog } from "./task-settings-dialog"
import { OPEN_TASK_SETTINGS_EVENT } from "./tasks-chrome-actions"
import { TasksSkeleton } from "./tasks-skeleton"
import { useTaskDialogs } from "./use-task-dialogs"
import type { WorkTask } from "@/lib/types"

const COLUMN_LABEL_KEYS = {
  todo: "colTodo",
  inProgress: "colInProgress",
  attention: "colAttention",
  done: "colDone",
} as const satisfies Record<BoardColumnId, string>

const EMPTY_LABEL_KEYS = {
  todo: "emptyColTodo",
  inProgress: "emptyColInProgress",
  attention: "emptyColAttention",
  done: "emptyColDone",
} as const satisfies Record<BoardColumnId, string>

/** The status select's "no filter" option — a sentinel, because Radix reserves
 *  the empty string for "no value chosen". */
const ALL_STATUSES = "__all__"

/** The cards inside a column. gap-4 — the same gutter the columns keep from
 *  each other and from the window edge — so a card is inset by 1rem on all
 *  four sides instead of being packed tighter vertically than horizontally.
 *  pb-1 keeps the last card clear of the scroll area's edge. */
const CARD_LIST_CLASS = "flex flex-col gap-4 pb-1"

/** Page title rendered into the window-chrome strip above the page (the h-10
 *  band shared with the fixed corner overlays) — the shared breadcrumb header,
 *  nothing else. The page-level controls (view switch, task settings) sit in
 *  the window's top-right chrome cluster instead, next to the settings gear —
 *  see TasksChromeActions. */
export function TasksPageTitle() {
  const t = useTranslations("Tasks")
  return <WorkbenchPageTitle title={t("title")} />
}

/**
 * The Tasks route page: toolbar (folder filter, keyword search, filter popover,
 * status filter, new task) plus the board or the list. The page title lives in the chrome
 * strip above (TasksPageTitle) and the view switch + settings entry in the
 * window's top-right cluster (TasksChromeActions), so the toolbar is purely
 * "narrow what you see" + "add one".
 * Data comes from the always-mounted TasksViewProvider;
 * every mutation is fire-and-refetch — the engine's `task://changed` nudges
 * keep all clients converged.
 */
export function TasksPage() {
  const t = useTranslations("Tasks")
  const { tasks, loading, refetch, viewMode } = useTasksView()
  const folders = useAppWorkspaceStore((s) => s.folders)
  const projectFolders = useMemo(
    () => folders.filter((f) => f.parent_id == null && f.kind === "regular"),
    [folders]
  )
  const folderNames = useMemo(() => {
    const map = new Map<number, string>()
    for (const f of folders) map.set(f.id, f.alias ?? f.name)
    return map
  }, [folders])

  // Opened from the aux panel's task tab: start on the project it was showing.
  // Read in the initializer so the first paint is already filtered; cleared
  // once applied (see `workbench-focus.ts`).
  const [focus] = useState(peekTasksFocus)
  useEffect(() => clearTasksFocus(focus), [focus])
  const [selectedFolderFilter, setFolderFilter] = useState<number | null>(
    () => focus?.folderId ?? null
  )
  // A folder can leave the workspace (closed, or removed) while it is the active
  // filter. Fall back to "all" by derivation — no effect, the same guard the
  // Automations list uses — so the board, the drag scope, the new-task prefill,
  // the settings scope and the pill can never disagree about which folder is in
  // effect: without it the pill would read "all folders" while everything below
  // it still scoped to the folder that vanished.
  const folderFilter =
    selectedFolderFilter != null &&
    !projectFolders.some((f) => f.id === selectedFolderFilter)
      ? null
      : selectedFolderFilter
  // Restored synchronously from localStorage: this page mounts only after a
  // client-side route switch (never prerendered), so there is no SSR markup to
  // mismatch — and the board paints with the remembered filter right away.
  const [boardFilter, setBoardFilter] = useState(loadTasksBoardFilter)
  useEffect(() => {
    saveTasksBoardFilter(boardFilter)
  }, [boardFilter])
  // The list's own status selection — one board COLUMN, or `null` for every
  // status. Restored synchronously for the same reason as the filter above.
  // `viewMode` itself lives in TasksViewProvider — its switch renders in the
  // window's chrome cluster.
  const [statusFilter, setStatusFilter] = useState<BoardColumnId | null>(
    loadTasksStatusFilter
  )
  useEffect(() => {
    saveTasksStatusFilter(statusFilter)
  }, [statusFilter])
  // Keyword search over both views. Deliberately NOT remembered across visits,
  // unlike the toggles above: a search left behind from last time silently
  // hides tasks on a board that otherwise looks normal.
  const [searchInput, setSearchInput] = useState("")
  const terms = useMemo(() => searchTerms(searchInput), [searchInput])
  const searching = terms.length > 0
  // Dragging a pending card is always available: dropping it on In-progress
  // starts the task and needs no order at all. Only the REORDER half waits on
  // a folder — sort_order is per folder, so a mixed-folder列 has nothing it
  // could persist, and the cards simply don't shuffle there.
  const [dragOrder, setDragOrder] = useState<number[] | null>(null)
  const dragOrderRef = useRef<number[] | null>(null)
  const inProgressColRef = useRef<HTMLDivElement | null>(null)
  // A drop acts on the LIVE row, not the snapshot the drag started from: the
  // provider refetches throughout a drag, and the engine's auto-processor can
  // claim a pending task while it is in the air.
  const tasksRef = useRef(tasks)
  // Both read by the drop handler. Synced at commit rather than written during
  // render (react-hooks/refs): a render React throws away must not be what a
  // drop acts on.
  useLayoutEffect(() => {
    dragOrderRef.current = dragOrder
    tasksRef.current = tasks
  }, [dragOrder, tasks])
  // The dragged card cannot visually leave its column — the column is a scroll
  // area, so it clips — which made the drop read as impossible even though it
  // worked. A fixed-position preview follows the pointer instead, portalled
  // clear of every clipping and transformed ancestor.
  const [drag, setDrag] = useState<{ task: WorkTask; width: number } | null>(
    null
  )
  const [dropArmed, setDropArmed] = useState(false)
  const dropArmedRef = useRef(false)
  const ghostRef = useRef<HTMLDivElement | null>(null)
  // Grab offset inside the card and the card's width, both read at pointerdown
  // (the drag events' native `currentTarget` is gone by the time they fire),
  // so the preview appears exactly over the card and tracks the pointer 1:1.
  const grabRef = useRef({ dx: 0, dy: 0, width: 0 })
  const pointRef = useRef({ x: 0, y: 0 })
  // A drag ends with a click on the card underneath; without this latch the
  // detail sheet would open on top of whatever the drop just did.
  const draggedRef = useRef(false)
  // Set when the gesture ended without a deliberate release (see abortDrag).
  const dragAbortedRef = useRef(false)

  // One shared timestamp per render tick keeps every card's relative-time
  // label consistent; a minute interval bounds staleness.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 60_000)
    return () => window.clearInterval(id)
  }, [])

  // The editor, the detail sheet and every dialog a card's buttons open —
  // shared with the aux panel's task tab (see `use-task-dialogs.tsx`).
  const { act, handlersFor, openDetail, openNewTask, dialogs } = useTaskDialogs(
    {
      tasks,
      refetch,
      folderNames,
      defaultFolderId: folderFilter,
    }
  )

  const [settingsOpen, setSettingsOpen] = useState(false)
  // The settings entry lives in the chrome strip (TasksPageTitle), a separate
  // tree branch — it asks this page (which owns the dialog + folder scope) to
  // open via a window event.
  useEffect(() => {
    const open = () => setSettingsOpen(true)
    window.addEventListener(OPEN_TASK_SETTINGS_EVENT, open)
    return () => window.removeEventListener(OPEN_TASK_SETTINGS_EVENT, open)
  }, [])

  const visibleTasks = useMemo(
    () =>
      tasks.filter(
        (task) =>
          (folderFilter == null || task.folder_id === folderFilter) &&
          taskMatchesSearch(
            task,
            terms,
            folderNames.get(task.folder_id) ?? null
          )
      ),
    [tasks, folderFilter, terms, folderNames]
  )
  const columns = useMemo(
    () =>
      groupTasksByColumn(
        visibleTasks,
        boardFilter.showCanceled,
        boardFilter.showArchived
      ),
    [visibleTasks, boardFilter]
  )
  // The list view's rows: one flat, freshest-first sequence, narrowed to a
  // single board column. The visibility toggles apply here exactly as they do
  // on the board — one pair of controls for both views.
  const listTasks = useMemo(
    () =>
      filterTasksForList(
        visibleTasks,
        statusFilter,
        boardFilter.showCanceled,
        boardFilter.showArchived
      ),
    [visibleTasks, statusFilter, boardFilter]
  )

  // Reordering persists the order of the column's cards — and a search shows
  // only some of them, so a drop there would save an order for a column the
  // user is not looking at. Dragging to In-progress (start) needs no order and
  // stays available.
  const dragEnabled = folderFilter != null && !searching
  // Optimistic order while a drag is live; server order otherwise.
  const todoTasks = useMemo(() => {
    const base = columns.todo
    if (!dragEnabled || dragOrder == null) return base
    const byId = new Map(base.map((task) => [task.id, task]))
    const ordered = dragOrder.flatMap((id) => byId.get(id) ?? [])
    for (const task of base) {
      if (!dragOrder.includes(task.id)) ordered.push(task)
    }
    return ordered
  }, [columns.todo, dragEnabled, dragOrder])
  // Place in line for every task waiting on its project's merge slot. Computed
  // over ALL tasks, not the visible ones: the queue is the project's, and a
  // filtered board must not renumber it.
  const queueRanks = useMemo(() => mergeQueueRanks(tasks), [tasks])

  const positionGhost = useCallback((x: number, y: number) => {
    const el = ghostRef.current
    if (!el) return
    const { dx, dy } = grabRef.current
    el.style.transform = `translate3d(${x - dx}px, ${y - dy}px, 0)`
  }, [])

  // Place the preview before its first paint, so it never flashes at the
  // window's top-left corner on the frame it mounts.
  useLayoutEffect(() => {
    if (drag) positionGhost(pointRef.current.x, pointRef.current.y)
  }, [drag, positionGhost])

  const pointerOverInProgress = (x: number, y: number) => {
    const rect = inProgressColRef.current?.getBoundingClientRect()
    return (
      rect != null &&
      x >= rect.left &&
      x <= rect.right &&
      y >= rect.top &&
      y <= rect.bottom
    )
  }

  // Read the grab geometry here rather than in onDragStart: the drag events
  // carry a native pointer event whose `currentTarget` is already gone.
  const handleTodoPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    grabRef.current = {
      dx: e.clientX - rect.left,
      dy: e.clientY - rect.top,
      width: rect.width,
    }
  }

  const handleTodoDragStart = (task: WorkTask, info: PanInfo) => {
    draggedRef.current = true
    dragAbortedRef.current = false
    pointRef.current = { x: info.point.x, y: info.point.y }
    setDrag({ task, width: grabRef.current.width })
  }

  // Pointer-rate: the preview moves by direct style mutation and only the
  // drop-target flip goes through state.
  const handleTodoDrag = (info: PanInfo) => {
    pointRef.current = { x: info.point.x, y: info.point.y }
    positionGhost(info.point.x, info.point.y)
    const over = pointerOverInProgress(info.point.x, info.point.y)
    if (over !== dropArmedRef.current) {
      dropArmedRef.current = over
      setDropArmed(over)
    }
  }

  // `latchNow` clears the post-drag click latch immediately instead of after a
  // frame: only a deliberate release is followed by a click.
  const clearDrag = useCallback((latchNow: boolean) => {
    setDrag(null)
    setDropArmed(false)
    dropArmedRef.current = false
    if (latchNow) {
      draggedRef.current = false
      return
    }
    // The click that ends the drag lands before the next frame.
    requestAnimationFrame(() => {
      draggedRef.current = false
    })
  }, [])

  // A gesture can end without a deliberate drop: the OS cancels it (touch), the
  // window loses focus with the button still held, or the card unmounts because
  // something claimed the task while it was in the air. Motion reports the
  // first case through the same `onDragEnd` as a real release and the last one
  // not at all — so the preview and the click latch have to be torn down here,
  // and the drop itself must not run.
  const abortDrag = useCallback(() => {
    dragAbortedRef.current = true
    setDragOrder(null)
    clearDrag(true)
  }, [clearDrag])

  useEffect(() => {
    if (!drag) return
    const onVisibility = () => {
      if (document.hidden) abortDrag()
    }
    window.addEventListener("blur", abortDrag)
    document.addEventListener("visibilitychange", onVisibility)
    return () => {
      window.removeEventListener("blur", abortDrag)
      document.removeEventListener("visibilitychange", onVisibility)
    }
  }, [drag, abortDrag])

  // The dragged card left the pending column under us — its Reorder.Item
  // unmounts with it and Motion never reports an end, which would strand the
  // preview and leave the latch swallowing every card click. An effect, not a
  // render-time adjustment: tearing the drag down also resets refs the drop
  // handler reads.
  useEffect(() => {
    if (drag && !todoTasks.some((task) => task.id === drag.task.id)) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      abortDrag()
    }
  }, [drag, todoTasks, abortDrag])

  // Drop on the In-progress column = start (the card itself drags on the y
  // axis, but the POINTER is free — droppedness is judged by its position).
  // Anywhere else = persist the reorder, when there is one to persist.
  const handleTodoDragEnd = useCallback(
    (task: WorkTask, event: unknown, info: PanInfo) => {
      // `pointercancel` routes through Motion's pointer-up handler, so an
      // abandoned gesture arrives here looking exactly like a release.
      const aborted =
        dragAbortedRef.current ||
        (event as Event | null | undefined)?.type === "pointercancel"
      clearDrag(aborted)
      if (aborted) {
        setDragOrder(null)
        return
      }
      const rect = inProgressColRef.current?.getBoundingClientRect()
      const droppedOnInProgress =
        rect != null &&
        info.point.x >= rect.left &&
        info.point.x <= rect.right &&
        info.point.y >= rect.top &&
        info.point.y <= rect.bottom
      if (droppedOnInProgress) {
        setDragOrder(null)
        // The row may have advanced during the drag; the engine would reject
        // the stale start anyway, so don't spend a request and a toast on it.
        const live = tasksRef.current.find((row) => row.id === task.id)
        if (live?.status === "todo") void act(() => workTaskStart(task.id))
        return
      }
      const order = dragOrderRef.current
      if (folderFilter != null && order != null) {
        void (async () => {
          try {
            await workTaskReorder(folderFilter, order)
          } catch (e) {
            toast.error(toErrorMessage(e))
          }
          await refetch()
          setDragOrder(null)
        })()
      }
    },
    [act, clearDrag, folderFilter, refetch]
  )

  // Archives whatever the Done column currently shows unarchived — respects
  // the visibility toggles by construction (it reads the grouped column). A
  // task put aside to handle later shares the column but is the opposite of
  // finished: archiving it would bury exactly what the user meant to come back
  // to (and a reviewed one cannot be archived at all).
  const archivableDone = useMemo(
    () =>
      columns.done.filter(
        (task) => task.archived_at == null && !isDeferred(task)
      ),
    [columns.done]
  )
  const archiveAllDone = useCallback(() => {
    const targets = archivableDone
    if (targets.length === 0) return
    void act(() =>
      Promise.all(targets.map((task) => workTaskArchive(task.id, true)))
    )
  }, [act, archivableDone])

  // The badge counts deviations from the DEFAULT view (canceled shown,
  // archived hidden), not checked boxes — a pristine board shows no badge.
  const isList = viewMode === "list"
  const activeFilters =
    (boardFilter.showCanceled === DEFAULT_TASKS_BOARD_FILTER.showCanceled
      ? 0
      : 1) +
    (boardFilter.showArchived === DEFAULT_TASKS_BOARD_FILTER.showArchived
      ? 0
      : 1)
  const hasAnyTask = tasks.length > 0
  // Nothing has arrived yet: draw the page's own shape instead of flashing the
  // "no tasks yet" empty state at someone who has plenty.
  const showSkeleton = loading && !hasAnyTask

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Toolbar (the page title renders in the chrome strip above the page,
          which owns the divider — the toolbar itself is borderless).
          pt-4 / px-4, not py-2: the pills clear the title bar by the same 1rem
          they clear the window's left edge, and pb-2 plus the board's own pt-2
          makes the gap underneath 1rem too — the row sits on one inset.

          Withheld until the first task exists: on an empty board every control
          here filters or starts nothing, and the only action that does
          anything — "new task" — is already the empty state's own button. */}
      {hasAnyTask && (
        <div className="flex shrink-0 flex-wrap items-center gap-2 px-4 pb-2 pt-4">
          {/* Searchable, and each row shows `alias [ name ]` over the folder's
              path — the same list the new-conversation composer opens. Leads
              with a folder glyph like the Automations filter pill: "全部文件夹"
              alone doesn't say WHICH axis the pill filters. */}
          <FolderSelect
            folders={projectFolders}
            value={folderFilter}
            onChange={setFolderFilter}
            allLabel={t("allFolders")}
            onSelectAll={() => setFolderFilter(null)}
          />

          {/* Keyword search — the same pill-shaped field the repository panel
              uses. Filters as you type (it is local, there is no request to
              debounce), and both views at once. A whole row to itself on a
              phone, where sharing one would leave too little to read back. */}
          <InputGroup className="h-8 w-full rounded-full sm:w-56">
            <InputGroupAddon align="inline-start">
              <Search className="size-3.5" aria-hidden />
            </InputGroupAddon>
            <InputGroupInput
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape" && searchInput !== "") {
                  e.preventDefault()
                  setSearchInput("")
                }
              }}
              placeholder={t("searchPlaceholder")}
              aria-label={t("searchPlaceholder")}
              className="h-8 text-[0.8125rem]"
            />
            {searchInput !== "" ? (
              <InputGroupAddon align="inline-end">
                <InputGroupButton
                  size="icon-xs"
                  aria-label={t("clearSearch")}
                  title={t("clearSearch")}
                  onClick={() => setSearchInput("")}
                >
                  <X className="size-3" />
                </InputGroupButton>
              </InputGroupAddon>
            ) : null}
          </InputGroup>

          {/* Same pill treatment as the folder select so the left cluster reads
              as one family of controls (the settings entry lives in the chrome
              strip next to the page title). */}
          <Popover>
            <PopoverTrigger asChild>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-8 gap-1.5 rounded-full bg-muted/70 px-3 text-[0.8125rem] font-medium ws-msg-chip hover:bg-muted"
              >
                <Funnel
                  className="size-3.5 text-muted-foreground"
                  aria-hidden="true"
                />
                {t("filter")}
                {activeFilters > 0 ? (
                  <span className="rounded-full bg-primary/10 px-1.5 py-0.5 text-[0.625rem] font-medium leading-none text-primary tabular-nums">
                    {activeFilters}
                  </span>
                ) : null}
              </Button>
            </PopoverTrigger>
            <PopoverContent
              align="start"
              className="w-52 gap-0.5 rounded-xl p-1.5"
            >
              {/* Both toggles apply to both views: the status filter narrows to
                  a whole column, so it cannot single out `canceled` (which
                  lives inside Done) — this is the only control that can. */}
              <label className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-xs hover:bg-accent/50">
                <Checkbox
                  checked={boardFilter.showCanceled}
                  onCheckedChange={(v) =>
                    setBoardFilter((f) => ({
                      ...f,
                      showCanceled: v === true,
                    }))
                  }
                />
                {t("showCanceled")}
              </label>
              <label className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-xs hover:bg-accent/50">
                <Checkbox
                  checked={boardFilter.showArchived}
                  onCheckedChange={(v) =>
                    setBoardFilter((f) => ({ ...f, showArchived: v === true }))
                  }
                />
                {t("showArchived")}
              </label>
            </PopoverContent>
          </Popover>

          {/* Status filter — list-only: the board already sorts by status into
              its four columns, so there is nothing there for it to narrow.
              One choice out of five, so a select rather than a checkbox menu;
              and it offers the board's four COLUMNS, not the ten underlying
              statuses, because that is the vocabulary the rest of the feature
              already speaks (same COLUMN_LABEL_KEYS the board headers use). */}
          {isList ? (
            <Select
              value={statusFilter ?? ALL_STATUSES}
              onValueChange={(v) =>
                setStatusFilter(
                  v === ALL_STATUSES ? null : (v as BoardColumnId)
                )
              }
            >
              {/* "状态: 等你处理" — the axis AND the value, like the composer's
                  mode selector: a bare aria-label would replace the value with
                  the axis name, and no label at all leaves the axis unsaid. */}
              <SelectTrigger
                size="sm"
                aria-label={`${t("statusFilter")}: ${
                  statusFilter == null
                    ? t("statusFilterAll")
                    : t(COLUMN_LABEL_KEYS[statusFilter])
                }`}
                className="h-8 w-auto min-w-0 gap-1.5 rounded-full border-transparent bg-muted/70 px-3 text-[0.8125rem] font-medium shadow-none ws-msg-chip hover:bg-muted"
              >
                <Tag
                  className="size-3.5 text-muted-foreground"
                  aria-hidden="true"
                />
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL_STATUSES}>
                  {t("statusFilterAll")}
                </SelectItem>
                {BOARD_COLUMN_IDS.map((col) => (
                  <SelectItem key={col} value={col}>
                    {t(COLUMN_LABEL_KEYS[col])}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : null}

          <div className="flex-1" />

          <Button
            type="button"
            size="sm"
            className="h-8 gap-1 rounded-full px-3.5 text-[0.8125rem]"
            onClick={() => openNewTask()}
          >
            <Plus className="size-4" aria-hidden="true" />
            {t("new")}
          </Button>
        </div>
      )}

      {/* Board / list */}
      {showSkeleton ? (
        <TasksSkeleton mode={viewMode} />
      ) : !hasAnyTask ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
          <ListTodo
            className="size-10 text-muted-foreground/40"
            aria-hidden="true"
          />
          <div className="flex flex-col gap-1">
            <p className="text-sm font-medium">{t("empty")}</p>
            <p className="max-w-sm text-xs text-muted-foreground">
              {t("emptyHint")}
            </p>
          </div>
          <Button
            type="button"
            size="sm"
            className="gap-1.5"
            onClick={() => openNewTask()}
          >
            <Plus className="size-3.5" aria-hidden="true" />
            {t("new")}
          </Button>
        </div>
      ) : isList ? (
        <TaskList
          tasks={listTasks}
          folderNames={folderNames}
          now={now}
          mergeQueueRanks={queueRanks}
          filtered={statusFilter != null}
          onClearFilter={() => setStatusFilter(null)}
          searchQuery={searching ? searchInput.trim() : null}
          onClearSearch={() => setSearchInput("")}
          onOpen={openDetail}
          handlersFor={handlersFor}
        />
      ) : (
        <div className="min-h-0 flex-1 overflow-x-auto">
          {/* pt-2, the same as the list view's card: the two views share this
              rail, so toggling between them must not nudge the content up or
              down. With the toolbar's pb-2 that is 16px under the pills — the
              pt-4 they keep above themselves. */}
          <div className="grid h-full min-w-[56rem] grid-cols-4 gap-4 px-4 pb-4 pt-2">
            {BOARD_COLUMN_IDS.map((col) => {
              const colTasks = col === "todo" ? todoTasks : columns[col]
              const cardFor = (task: WorkTask) => (
                <TaskCard
                  key={task.id}
                  task={task}
                  folderName={folderNames.get(task.folder_id) ?? null}
                  now={now}
                  mergeQueueRank={queueRanks.get(task.id)}
                  onOpen={() => {
                    // Swallow the click that closes a drag.
                    if (draggedRef.current) return
                    openDetail(task.id)
                  }}
                  {...handlersFor(task)}
                />
              )
              return (
                <div
                  key={col}
                  ref={col === "inProgress" ? inProgressColRef : undefined}
                  className="flex min-h-0 flex-col gap-2"
                >
                  <div className="flex h-6 shrink-0 items-center gap-2 px-0.5">
                    {/* A short upright bar rather than a dot: it echoes the
                        column it heads (and the pill radius of the toolbar
                        above), and it reads as a marker instead of a bullet.
                        Same tones as before. */}
                    <span
                      className={cn(
                        "h-3.5 w-[3px] shrink-0 rounded-full",
                        col === "todo" && "bg-muted-foreground/50",
                        col === "inProgress" && "bg-primary",
                        col === "attention" && "bg-amber-500",
                        col === "done" && "bg-emerald-500"
                      )}
                      aria-hidden="true"
                    />
                    <h2 className="text-xs font-semibold">
                      {t(COLUMN_LABEL_KEYS[col])}
                    </h2>
                    {/* The count is a pill in the toolbar's muted-pill
                        language, so the two header rows read as one block. */}
                    {col === "attention" && colTasks.length > 0 ? (
                      <span className="rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[0.625rem] font-semibold leading-none text-amber-600 tabular-nums dark:text-amber-400">
                        {colTasks.length}
                      </span>
                    ) : (
                      <span className="rounded-full bg-muted/70 px-1.5 py-0.5 text-[0.625rem] font-medium leading-none text-muted-foreground tabular-nums">
                        {colTasks.length}
                      </span>
                    )}
                    <div className="flex-1" />
                    {col === "done" && archivableDone.length > 0 ? (
                      <Button
                        type="button"
                        size="xs"
                        variant="ghost"
                        className="px-1.5 font-normal text-muted-foreground hover:text-foreground"
                        onClick={archiveAllDone}
                      >
                        {t("archiveAllDone")}
                      </Button>
                    ) : null}
                  </div>
                  {colTasks.length === 0 ? (
                    <div
                      className={cn(
                        // border-border is near-invisible on the plain canvas —
                        // dash with a foreground-derived tone instead.
                        "flex flex-1 flex-col items-center justify-center gap-1.5 rounded-xl border border-dashed border-muted-foreground/30 p-4 text-center",
                        // Drop target while a pending card is dragged: quiet
                        // once the drag starts, loud once the pointer is
                        // actually inside. Otherwise tint like the cards when a
                        // workspace background image is on (ws-msg-card is
                        // inert without one) so the cell stays legible over a
                        // photo.
                        col === "inProgress" && drag
                          ? dropArmed
                            ? "border-primary bg-primary/10"
                            : "border-primary/40"
                          : "ws-msg-card"
                      )}
                    >
                      <p className="text-xs text-muted-foreground">
                        {/* An empty column under a search says nothing
                            matched — not that the column has no tasks. */}
                        {searching
                          ? t("searchEmptyColumn")
                          : t(EMPTY_LABEL_KEYS[col])}
                      </p>
                    </div>
                  ) : (
                    <ScrollArea
                      className={cn(
                        "min-h-0 flex-1 rounded-xl transition-colors",
                        col === "inProgress" &&
                          drag &&
                          (dropArmed
                            ? "bg-primary/5 ring-2 ring-primary"
                            : "ring-1 ring-primary/25")
                      )}
                    >
                      {col === "todo" ? (
                        <Reorder.Group
                          as="div"
                          axis="y"
                          values={todoTasks.map((task) => task.id)}
                          // Without a folder there is no order to save, so the
                          // cards stay put and the drag exists only to start.
                          onReorder={(ids: number[]) => {
                            if (dragEnabled) setDragOrder(ids)
                          }}
                          className={CARD_LIST_CLASS}
                        >
                          {todoTasks.map((task) => (
                            <Reorder.Item
                              key={task.id}
                              value={task.id}
                              as="div"
                              onPointerDown={handleTodoPointerDown}
                              onDragStart={(_e: unknown, info: PanInfo) =>
                                handleTodoDragStart(task, info)
                              }
                              onDrag={(_e: unknown, info: PanInfo) =>
                                handleTodoDrag(info)
                              }
                              onDragEnd={(e: unknown, info: PanInfo) =>
                                handleTodoDragEnd(task, e, info)
                              }
                              className={cn(
                                "cursor-grab active:cursor-grabbing",
                                // The preview is the card now; what stays in
                                // the list is the slot it came from.
                                drag?.task.id === task.id && "opacity-40"
                              )}
                            >
                              {cardFor(task)}
                            </Reorder.Item>
                          ))}
                        </Reorder.Group>
                      ) : (
                        <div className={CARD_LIST_CLASS}>
                          {colTasks.map(cardFor)}
                        </div>
                      )}
                    </ScrollArea>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}

      {dialogs}
      <TaskSettingsDialog
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        folderId={folderFilter}
      />

      {/* Drag preview. Portalled to the body because a fixed element is
          positioned against the nearest transformed ancestor otherwise, and
          the board sits inside several. */}
      {drag
        ? createPortal(
            <div
              ref={ghostRef}
              className="pointer-events-none fixed left-0 top-0 z-50 will-change-transform"
              style={{ width: drag.width }}
              aria-hidden="true"
            >
              <div
                className={cn(
                  "flex -rotate-1 flex-col gap-2 rounded-xl border bg-card p-3 shadow-lg",
                  dropArmed
                    ? "border-primary ring-2 ring-primary/25"
                    : "border-foreground/15"
                )}
              >
                <div className="flex items-start justify-between gap-2">
                  <span className="min-w-0 break-words text-[0.8125rem] font-medium leading-snug">
                    {drag.task.title}
                  </span>
                  <StatusChip task={drag.task} />
                </div>
                {dropArmed ? (
                  <span className="inline-flex items-center gap-1 text-[0.6875rem] font-medium text-primary">
                    <Play className="size-3" aria-hidden="true" />
                    {t("dropToStart")}
                  </span>
                ) : null}
              </div>
            </div>,
            document.body
          )
        : null}
    </div>
  )
}
