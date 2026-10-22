"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import {
  ChevronRight,
  ListTodo,
  Plus,
  Search,
  SquareArrowOutUpRight,
  X,
} from "lucide-react"
import {
  groupTasksByColumn,
  type BoardColumnId,
} from "@/components/tasks/board-columns"
import { mergeQueueRanks } from "@/components/tasks/task-acceptance"
import { TaskCard } from "@/components/tasks/task-card"
import { searchTerms, taskMatchesSearch } from "@/components/tasks/task-search"
import { useTaskDialogs } from "@/components/tasks/use-task-dialogs"
import { Button } from "@/components/ui/button"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Skeleton } from "@/components/ui/skeleton"
import { useTasksView } from "@/contexts/tasks-view-context"
import { useWorkbenchRoute } from "@/contexts/workbench-route-context"
import { useActiveProjectFolderId } from "@/hooks/use-active-project-folder"
import { useTasksBoardFilter } from "@/lib/tasks-board-filter-storage"
import { cn } from "@/lib/utils"
import { requestTasksFocus } from "@/lib/workbench-focus"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"
import { GIT_TOOLBAR_ICON_BUTTON_CLASS } from "./git-toolbar-controls"
import { AuxPanelNoFolderEmpty } from "./aux-panel-no-folder-empty"

/**
 * The board's four columns, stacked — in the order a glance down a sidebar
 * wants them: what is waiting on you, what is running, what is queued, and
 * what is finished. (The board reads them left to right in workflow order; a
 * column of sections reads top-down, and the top is what gets seen.)
 */
const SECTION_ORDER: readonly BoardColumnId[] = [
  "attention",
  "inProgress",
  "todo",
  "done",
]

/** The board's own column names and marker tones, so a section reads as the
 *  column it is. */
const SECTION_LABEL_KEYS = {
  todo: "colTodo",
  inProgress: "colInProgress",
  attention: "colAttention",
  done: "colDone",
} as const satisfies Record<BoardColumnId, string>

const SECTION_TONE: Record<BoardColumnId, string> = {
  todo: "bg-muted-foreground/50",
  inProgress: "bg-primary",
  attention: "bg-amber-500",
  done: "bg-emerald-500",
}

/**
 * The aux panel's task tab: the active project's board, as a column of
 * sections, with the board's own cards.
 *
 * Everything a card can do here it does on the board too — the editor, the
 * detail sheet and the acceptance / restart / follow-up dialogs come from the
 * same `useTaskDialogs` the Tasks page uses. What stays on the page is what
 * needs its room: dragging cards, the list view, the folder picker and the
 * board's settings (one click away, on this project).
 */
export function TasksAuxTab() {
  const t = useTranslations("Tasks")
  const tAux = useTranslations("Folder.auxPanel")
  const { tasks, loading, refetch } = useTasksView()
  const projectFolderId = useActiveProjectFolderId()
  const allFolders = useAppWorkspaceStore((s) => s.allFolders)
  const { setRoute } = useWorkbenchRoute()

  const folderNames = useMemo(() => {
    const map = new Map<number, string>()
    for (const f of allFolders) map.set(f.id, f.alias ?? f.name)
    return map
  }, [allFolders])
  const projectName =
    projectFolderId != null ? (folderNames.get(projectFolderId) ?? null) : null

  // The board's canceled / archived toggles, followed live: one pair of
  // visibility rules for both surfaces.
  const boardFilter = useTasksBoardFilter()
  const [searchInput, setSearchInput] = useState("")
  const terms = useMemo(() => searchTerms(searchInput), [searchInput])
  const searching = terms.length > 0
  // Done starts folded: it only grows, and the sections above it are the ones
  // that ask for something.
  const [collapsed, setCollapsed] = useState<ReadonlySet<BoardColumnId>>(
    () => new Set<BoardColumnId>(["done"])
  )

  // One shared timestamp per tick keeps every card's relative time
  // consistent, like the board's.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 60_000)
    return () => window.clearInterval(id)
  }, [])

  const projectTasks = useMemo(
    () =>
      projectFolderId == null
        ? []
        : tasks.filter((task) => task.folder_id === projectFolderId),
    [tasks, projectFolderId]
  )
  const columns = useMemo(
    () =>
      groupTasksByColumn(
        projectTasks.filter((task) =>
          taskMatchesSearch(task, terms, projectName)
        ),
        boardFilter.showCanceled,
        boardFilter.showArchived
      ),
    [projectTasks, terms, projectName, boardFilter]
  )
  // Over ALL tasks: the merge queue is the project's, and a narrowed view must
  // not renumber it (the board computes it the same way).
  const queueRanks = useMemo(() => mergeQueueRanks(tasks), [tasks])

  const { handlersFor, openDetail, openNewTask, dialogs } = useTaskDialogs({
    tasks,
    refetch,
    folderNames,
    defaultFolderId: projectFolderId,
  })

  const openBoard = useCallback(() => {
    requestTasksFocus({ folderId: projectFolderId })
    setRoute("tasks")
  }, [projectFolderId, setRoute])

  const toggleSection = useCallback((column: BoardColumnId) => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(column)) next.delete(column)
      else next.add(column)
      return next
    })
  }, [])

  if (projectFolderId == null) return <AuxPanelNoFolderEmpty />

  const shownSections = SECTION_ORDER.filter(
    (column) => columns[column].length > 0
  )
  const hasAnyTask = projectTasks.length > 0

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* The h-10 band every aux tab opens with: the search where the changes
          tab keeps its commit field, then the two actions. */}
      <div className="flex h-10 shrink-0 items-center gap-1 border-b border-border/50 pl-2 pr-2">
        <InputGroup className="h-7 min-w-0 flex-1 rounded-full">
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
            className="h-7 text-xs"
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
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className={GIT_TOOLBAR_ICON_BUTTON_CLASS}
          title={t("new")}
          aria-label={t("new")}
          onClick={() => openNewTask()}
        >
          <Plus className="size-3.5" aria-hidden />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className={cn(GIT_TOOLBAR_ICON_BUTTON_CLASS, "-mr-1")}
          title={tAux("openFullPage")}
          aria-label={tAux("openFullPage")}
          onClick={openBoard}
        >
          <SquareArrowOutUpRight className="size-3.5" aria-hidden />
        </Button>
      </div>

      {loading && tasks.length === 0 ? (
        <TasksAuxSkeleton />
      ) : !hasAnyTask ? (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
          <ListTodo
            className="size-8 text-muted-foreground/40"
            aria-hidden="true"
          />
          <div className="flex flex-col gap-1">
            <p className="text-sm font-medium">{t("empty")}</p>
            <p className="text-xs text-muted-foreground">{t("emptyHint")}</p>
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
      ) : shownSections.length === 0 ? (
        // Tasks exist, but none are left to show: a search narrowed them all
        // away, or every one is canceled / archived and the board hides those.
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
          <p className="text-xs text-muted-foreground">
            {searching
              ? t("searchNoResults", { query: searchInput.trim() })
              : t("listEmpty")}
          </p>
          {searching ? (
            <Button
              type="button"
              size="xs"
              variant="outline"
              onClick={() => setSearchInput("")}
            >
              {t("clearSearch")}
            </Button>
          ) : null}
        </div>
      ) : (
        <ScrollArea className="min-h-0 flex-1">
          <div className="flex flex-col gap-3 p-3">
            {shownSections.map((column) => {
              const sectionTasks = columns[column]
              // A search opens every section that has a match: a hit folded
              // away under "Done" reads as no hit at all.
              const open = searching || !collapsed.has(column)
              return (
                <section key={column} className="flex flex-col gap-2">
                  <button
                    type="button"
                    aria-expanded={open}
                    onClick={() => toggleSection(column)}
                    disabled={searching}
                    className="flex h-6 items-center gap-2 rounded-md px-0.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default"
                  >
                    <ChevronRight
                      className={cn(
                        "size-3.5 shrink-0 text-muted-foreground transition-transform",
                        open && "rotate-90"
                      )}
                      aria-hidden="true"
                    />
                    <span
                      className={cn(
                        "h-3.5 w-[3px] shrink-0 rounded-full",
                        SECTION_TONE[column]
                      )}
                      aria-hidden="true"
                    />
                    <span className="text-xs font-semibold">
                      {t(SECTION_LABEL_KEYS[column])}
                    </span>
                    <span
                      className={cn(
                        "rounded-full px-1.5 py-0.5 text-[0.625rem] leading-none tabular-nums",
                        column === "attention"
                          ? "bg-amber-500/15 font-semibold text-amber-600 dark:text-amber-400"
                          : "bg-muted/70 font-medium text-muted-foreground"
                      )}
                    >
                      {sectionTasks.length}
                    </span>
                  </button>
                  {open ? (
                    <div className="flex flex-col gap-2">
                      {sectionTasks.map((task) => (
                        <TaskCard
                          key={task.id}
                          task={task}
                          // Every card here is this project's: naming it on
                          // each would be the same word down the column.
                          folderName={null}
                          now={now}
                          mergeQueueRank={queueRanks.get(task.id)}
                          onOpen={() => openDetail(task.id)}
                          {...handlersFor(task)}
                        />
                      ))}
                    </div>
                  ) : null}
                </section>
              )
            })}
          </div>
        </ScrollArea>
      )}

      {dialogs}
    </div>
  )
}

/** First-paint placeholder: two section headers over ghost cards, on the real
 *  sections' insets. */
function TasksAuxSkeleton() {
  return (
    <div className="flex flex-col gap-3 p-3" aria-hidden>
      {[2, 1].map((cards, section) => (
        <div key={section} className="flex flex-col gap-2">
          <Skeleton className="h-4 w-24" />
          {Array.from({ length: cards }, (_, i) => (
            <Skeleton key={i} className="h-20 w-full rounded-xl" />
          ))}
        </div>
      ))}
    </div>
  )
}
