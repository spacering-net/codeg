"use client"

import { useTranslations } from "next-intl"
import { ListFilter } from "lucide-react"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { TooltipProvider } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import type { TaskActionHandlers } from "./task-actions"
import { TASK_LIST_CELLS, TASK_LIST_LINE, TaskRow } from "./task-row"
import type { WorkTask } from "@/lib/types"

interface TaskListProps {
  tasks: WorkTask[]
  /** folder id → display name, for the location column. */
  folderNames: Map<number, string>
  /** Shared render-tick timestamp for relative times (refreshed by the page). */
  now: number
  /** task id → place in its project's merge queue (see `mergeQueueRanks`). */
  mergeQueueRanks: Map<number, number>
  /** Whether a status filter is narrowing the list — drives the empty state's
   *  offer to clear it, instead of leaving a dead end. */
  filtered: boolean
  onClearFilter: () => void
  /** The keyword search narrowing the list, or null when there is none. An
   *  empty list under a search names the query and offers to clear it. */
  searchQuery?: string | null
  onClearSearch?: () => void
  onOpen: (taskId: number) => void
  handlersFor: (task: WorkTask) => TaskActionHandlers
}

/**
 * The list view: one bounded card with a fixed column header and a scrolling
 * body, rather than a stack of rows that scrolls the whole page. The header is
 * what makes the columns read as columns — and it shares TASK_LIST_CELLS with
 * the rows, so the two cannot drift out of alignment.
 *
 * pt-2, the same as the board's grid: switching views must not shift the
 * content rail, and one number for both is what keeps that true as either view
 * changes. With the toolbar's pb-2 that puts 16px under the pills, matching the
 * pt-4 above them.
 */
export function TaskList({
  tasks,
  folderNames,
  now,
  mergeQueueRanks,
  filtered,
  onClearFilter,
  searchQuery = null,
  onClearSearch,
  onOpen,
  handlersFor,
}: TaskListProps) {
  const t = useTranslations("Tasks")

  return (
    <div className="flex min-h-0 flex-1 flex-col px-4 pb-4 pt-2">
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-foreground/15 bg-card ws-msg-card">
        {/* Column header. Quiet on purpose — it labels, it doesn't compete. */}
        <div
          className={cn(
            TASK_LIST_LINE,
            "shrink-0 border-b border-border/60 bg-muted/30 py-1.5 text-[0.625rem] font-medium tracking-wide text-muted-foreground"
          )}
        >
          <div className={TASK_LIST_CELLS.status}>{t("listColStatus")}</div>
          {/* pl-5 clears the rows' agent-mark gutter (14px mark + 6px gap), so
              the heading sits over the titles rather than over their icons. */}
          <div
            className={cn(
              TASK_LIST_CELLS.title,
              "flex items-center gap-1.5 pl-5"
            )}
          >
            {t("listColTask")}
            <span className="rounded-full bg-muted/70 px-1.5 py-0.5 text-[0.625rem] font-medium leading-none tabular-nums">
              {tasks.length}
            </span>
          </div>
          <div className={TASK_LIST_CELLS.location}>{t("listColLocation")}</div>
          <div className={TASK_LIST_CELLS.changes}>{t("listColChanges")}</div>
          <div className={TASK_LIST_CELLS.updated}>{t("listColUpdated")}</div>
          {/* Unlabelled: the actions column heads a set of buttons, not data. */}
          <div className={TASK_LIST_CELLS.actions} aria-hidden="true" />
        </div>

        {tasks.length === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
            <ListFilter
              className="size-8 text-muted-foreground/40"
              aria-hidden="true"
            />
            <p className="text-xs text-muted-foreground">
              {searchQuery
                ? t("searchNoResults", { query: searchQuery })
                : t("listEmpty")}
            </p>
            {/* A search or a status filter is what can empty a list that has
                tasks behind it, so those are the ways out worth offering. */}
            <div className="flex flex-wrap items-center justify-center gap-2">
              {searchQuery && onClearSearch ? (
                <Button
                  type="button"
                  size="xs"
                  variant="outline"
                  onClick={onClearSearch}
                >
                  {t("clearSearch")}
                </Button>
              ) : null}
              {filtered ? (
                <Button
                  type="button"
                  size="xs"
                  variant="outline"
                  onClick={onClearFilter}
                >
                  {t("statusFilterAll")}
                </Button>
              ) : null}
            </div>
          </div>
        ) : (
          <ScrollArea className="min-h-0 flex-1">
            {/* One provider for the whole list: the rows' action tooltips share
                its skip-delay, so sweeping across a row's buttons names them
                instantly while merely crossing the list doesn't flash one. */}
            <TooltipProvider delayDuration={400}>
              <div className="divide-y divide-border/50">
                {tasks.map((task) => (
                  <TaskRow
                    key={task.id}
                    task={task}
                    folderName={folderNames.get(task.folder_id) ?? null}
                    now={now}
                    mergeQueueRank={mergeQueueRanks.get(task.id)}
                    onOpen={() => onOpen(task.id)}
                    {...handlersFor(task)}
                  />
                ))}
              </div>
            </TooltipProvider>
          </ScrollArea>
        )}
      </div>
    </div>
  )
}
