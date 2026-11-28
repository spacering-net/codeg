"use client"

/** The activity tab (C1, 5.1): one list, in groups by whose turn it is —
 *  what waits on the owner (the assistants' suggestions one line at its
 *  end), what an agent is at now, what codeg watches go on outside (folded
 *  to its head at first), what comes next (its routines among it), what was
 *  done today (folded too) — each thing once, read whole in one go. An
 *  older codeg's list is drawn in its four groups (11). A group shows its
 *  first rows until "show all". The morning brief being written says so on
 *  top; nothing at all is one row. Asked for a row (the pill, a routine),
 *  the list brings it into view once it has it. */

import { useEffect, useMemo, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { Inbox, Plus } from "lucide-react"
import { toast } from "sonner"

import { useTaskDialogs } from "@/components/tasks/use-task-dialogs"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { usePersonalAgent } from "@/contexts/personal-agent-context"
import { useTasksView } from "@/contexts/tasks-view-context"
import type { TaskActionHandlers } from "@/components/tasks/task-actions"
import { readGroups } from "@/lib/activity-groups"
import type { PersonalAgentSnapshot, WorkTask } from "@/lib/types"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"
import {
  isAway,
  listOf,
  notePress,
  pressCool,
  settleLeaving,
  useActivityLeaving,
} from "@/stores/personal-agent-activity-leaving-store"
import { markReturn } from "@/stores/personal-agent-return-store"
import {
  refreshActivity,
  useActivityRead,
  type ActivityRead,
} from "@/stores/personal-agent-activity-store"
import {
  ACTIVITY_FOLD,
  usePersonalAgentUi,
  type ActivityGroup,
} from "@/stores/personal-agent-ui-store"

import {
  PanelGroup,
  PanelIcon,
  PanelItem,
  PanelMoreRow,
  PanelStack,
  type PanelTone,
} from "../../panel-section"
import { useNow, useOpener } from "../../today-section"
import { TabBody } from "../tab-body"
import { ActivityRowView, type RowScope } from "./work-cards"

/** Rows a group shows before "show all". */
export const GROUP_SHOWN = 8

/** No tasks read (a list drawn without the board's). */
const NO_TASKS: WorkTask[] = []

const GROUP_TONE: Record<ActivityGroup, PanelTone> = {
  needs: "amber",
  running: "primary",
  watch: "faint",
  watching: "primary",
  next: "muted",
  done: "green",
}

export function ActivityTab({
  snapshot,
  inDrawer,
}: {
  snapshot: PersonalAgentSnapshot
  inDrawer: boolean
}) {
  const { botId, itemVersion, dispatchVersion, routineVersion } =
    usePersonalAgent()
  const readOnly = snapshot.status.engine !== "here"
  const read = useActivityRead(botId, [
    itemVersion,
    dispatchVersion,
    routineVersion,
  ])
  const { tasks, refetch } = useTasksView()
  const allFolders = useAppWorkspaceStore((s) => s.allFolders)
  const folderNames = useMemo(() => {
    const map = new Map<number, string>()
    for (const f of allFolders) map.set(f.id, f.alias ?? f.name)
    return map
  }, [allFolders])
  // A row's cancel, merge or delivery acts on the run its dialog opened on.
  const { openDetail, handlersFor, dialogs } = useTaskDialogs({
    tasks,
    refetch,
    folderNames,
    defaultFolderId: null,
    pinRuns: true,
  })
  // The board's cancel, its dialog: [Stop] on a task no assistant handed
  // out — of the run the row read; one run again since is not this row's.
  const tw = useTranslations("PersonalAgent.work")
  const cancelTask = (id: number, runSeq?: number | null) => {
    const task = tasks.find((t) => t.id === id)
    if (!task) return
    if (runSeq == null || task.run_seq !== runSeq) {
      toast.message(tw("toast.ranAgain"))
      refreshActivity()
      return
    }
    handlersFor(task).onCancel()
  }
  return (
    <TabBody>
      <ActivityList
        read={read}
        readOnly={readOnly}
        inDrawer={inDrawer}
        openTask={openDetail}
        cancelTask={cancelTask}
        tasks={tasks}
        taskHandlers={handlersFor}
      />
      {dialogs}
    </TabBody>
  )
}

export function ActivityList({
  read,
  readOnly,
  inDrawer,
  openTask,
  cancelTask = null,
  tasks = NO_TASKS,
  taskHandlers = null,
}: {
  /** What was read for the page's assistant; `null` while none is. */
  read: ActivityRead | null
  readOnly: boolean
  inDrawer: boolean
  openTask: ((id: number) => void) | null
  /** The board's cancel for a task (its dialog). */
  cancelTask?: ((id: number, runSeq?: number | null) => void) | null
  /** The board's tasks, and what lands one. */
  tasks?: WorkTask[]
  taskHandlers?: ((task: WorkTask) => TaskActionHandlers) | null
}) {
  const t = useTranslations("PersonalAgent.feed")
  const tt = useTranslations("PersonalAgent.today")
  const tr = useTranslations("PersonalAgent.routines")
  const { botId, snapshot } = usePersonalAgent()
  const view = read?.view ?? null
  // Its first read failed: nothing to show.
  const failed = read != null && read.view == null
  const now = useNow()
  const baseOpener = useOpener(
    { dispatches: view?.dispatches ?? [] },
    inDrawer,
    openTask
  )
  // Leaving the drawer for a row's own place: the way back is offered
  // there (7.6), to this activity.
  const opener: typeof baseOpener = (row) => {
    const open = baseOpener(row)
    if (!open || !inDrawer) return open
    // Where it leads closes the drawer when it has to (a card in the
    // conversation); a task's or work's own sheet opens over it — this
    // list's, under it, kept.
    return () => {
      markReturn(usePersonalAgentUi.getState().viewBot)
      open()
    }
  }
  const openEditor = usePersonalAgentUi((s) => s.openRoutineEditor)
  const ask = usePersonalAgentUi((s) => s.activityAsk)
  const clearAsk = usePersonalAgentUi((s) => s.clearActivityAsk)
  const [all, setAll] = useState<Partial<Record<ActivityGroup, boolean>>>({})
  // The suggestions' line opened: they show at the end of "needs you".
  const [suggestionsOpen, setSuggestionsOpen] = useState(false)
  const [flash, setFlash] = useState<string | null>(null)
  const ref = useRef<HTMLDivElement | null>(null)
  const groups = useMemo(() => (view ? readGroups(view) : null), [view])
  // The rows that left their group as they were acted on (7.4): away
  // until a read no longer has them there, or they come back.
  const hidden = useActivityLeaving((s) => s.hidden)
  // Whose list this read is: what its rows left, not another's.
  const list = listOf(read?.bot ?? null)
  useEffect(() => {
    if (!groups) return
    const placed = new Map<string, string>()
    for (const g of groups.order) {
      for (const r of groups.rows[g] ?? []) placed.set(r.key, g)
    }
    for (const r of groups.suggestions) placed.set(r.key, "needs")
    settleLeaving(list, placed)
  }, [groups, list])
  // The second click of a double-click meant for a row that just left
  // lands on the one moved up into its place: let go, whichever button it
  // hits (7.4).
  useEffect(() => {
    const root = ref.current
    if (!root) return
    const onClick = (e: MouseEvent) => {
      const target = e.target as Element | null
      const row = target?.closest("[data-pa-activity-row]")
      if (!row) return
      if (pressCool(e)) {
        e.stopPropagation()
        e.preventDefault()
        return
      }
      // Where it is pressed: a row it makes leave leaves that place cool.
      const rect = row.getBoundingClientRect()
      notePress(rect.top, rect.bottom)
    }
    // A menu opens on the press itself, before any click.
    const onPress = (e: PointerEvent) => {
      const target = e.target as Element | null
      if (target?.closest("[data-pa-activity-row]") && pressCool(e)) {
        e.stopPropagation()
        e.preventDefault()
      }
    }
    root.addEventListener("click", onClick, true)
    root.addEventListener("pointerdown", onPress, true)
    return () => {
      root.removeEventListener("click", onClick, true)
      root.removeEventListener("pointerdown", onPress, true)
    }
  })

  // A row asked for, once this page's list has been read (or could not
  // be) — another assistant's, once the page is on it: its group shown
  // whole when it is further down, the row scrolled to and — a routine —
  // marked a moment; one not there, its group's head, or the
  // top; a routine not there was deleted. Scrolled once drawn; the ask is
  // let go then, not before, so nothing drawn in between takes it back.
  const handled = useRef<number | null>(null)
  const refreshed = useRef<number | null>(null)
  // The primary asked for by its own id (a row's) is this page too.
  const realId = snapshot?.agent?.id ?? null
  useEffect(() => {
    if (ask == null || handled.current === ask.key) return
    const here =
      ask.bot === botId ||
      (botId == null && ask.bot != null && ask.bot === realId)
    if (!here || read == null) return
    // A routine is looked for in a list read after it was asked for — one
    // made since the last read is not "deleted" — or once a read since
    // failed.
    const fresh =
      read.at >= ask.at || (read.failedAt != null && read.failedAt >= ask.at)
    if (ask.routine && ask.row != null && !fresh) {
      if (refreshed.current !== ask.key) {
        refreshed.current = ask.key
        refreshActivity()
      }
      return
    }
    handled.current = ask.key
    const stale = read.failedAt != null && read.failedAt >= read.at
    const rows = groups?.rows[ask.group] ?? []
    const at = ask.row != null ? rows.findIndex((r) => r.key === ask.row) : -1
    const found = at >= 0 ? rows[at] : null
    // An ask from outside (the pill, a routine's link) unfolds its group
    // once, as it is taken.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- answering an ask from outside
    if (at >= GROUP_SHOWN) setAll((a) => ({ ...a, [ask.group]: true }))
    if (ask.routine && ask.row != null && found == null && !failed && !stale) {
      toast.message(t("routineDeleted"))
    }
    const key = ask.key
    const group = ask.group
    requestAnimationFrame(() => {
      clearAsk(key)
      const root = ref.current
      if (!root) return
      const row = found
        ? (Array.from(
            root.querySelectorAll<HTMLElement>("[data-pa-activity-row]")
          ).find((e) => e.dataset.paActivityRow === found.key) ?? null)
        : null
      const head = root.querySelector(`[data-pa-activity-group="${group}"]`)
      const target = row ?? head ?? root
      target.scrollIntoView?.({ block: row ? "center" : "start" })
      if (found) setFlash(found.key)
    })
  }, [ask, botId, realId, read, groups, failed, clearAsk, t])
  useEffect(() => {
    if (flash == null) return
    const id = window.setTimeout(() => setFlash(null), 1500)
    return () => window.clearTimeout(id)
  }, [flash])

  const newRoutine = () =>
    openEditor({ botId, routineId: null, draft: null, noticeId: null })

  if (view == null || groups == null) {
    return (
      <div ref={ref} className="flex flex-col gap-1.5">
        {failed ? (
          <PanelStack>
            <PanelItem
              media={<PanelIcon icon={Inbox} />}
              title={t("failed")}
              data-pa-activity-failed
            />
          </PanelStack>
        ) : (
          <div className="flex flex-col gap-1.5" aria-hidden>
            <Skeleton className="h-4 w-24 rounded-md" />
            <Skeleton className="h-16 w-full rounded-xl" />
          </div>
        )}
      </div>
    )
  }

  const scope: RowScope = {
    now,
    readOnly,
    inDrawer,
    opener,
    openTask,
    cancelTask,
    dispatches: view.dispatches,
    mode: groups.mode,
    list,
    can: groups.can,
    tasks,
    taskHandlers,
  }
  // The morning brief or the wrap-up, while it is being written (6.4).
  const preparing =
    view.brief?.state === "preparing" ? (
      <p
        className="text-xs leading-5 text-muted-foreground"
        data-pa-today-brief={view.brief.kind}
      >
        <span className="activity-shimmer">
          {tt(view.brief.kind === "wrap" ? "preparingWrap" : "preparingBrief")}
        </span>
      </p>
    ) : null
  const rowsOf = (g: ActivityGroup) =>
    (groups.rows[g] ?? []).filter((r) => !isAway(hidden, list, r.key, g))
  const suggestions = groups.suggestions.filter(
    (r) => !isAway(hidden, list, r.key, "needs")
  )
  // "Needs you" shows for its suggestions alone too.
  const shown = groups.order.filter(
    (g) => rowsOf(g).length > 0 || (g === "needs" && suggestions.length > 0)
  )
  // Nothing at all: one row, and the way to make a routine (C5).
  if (shown.length === 0 && preparing == null) {
    return (
      <div ref={ref}>
        <PanelStack>
          <PanelItem
            media={<PanelIcon icon={Inbox} />}
            title={t("empty")}
            action={
              readOnly ? null : (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={newRoutine}
                  data-pa-routine-new
                >
                  <Plus aria-hidden />
                  {tr("new")}
                </Button>
              )
            }
            data-pa-activity-empty
          />
        </PanelStack>
      </div>
    )
  }
  return (
    <div ref={ref} className="flex flex-col gap-4" data-pa-activity>
      {preparing}
      {shown.map((g) => {
        const rows = rowsOf(g)
        const whole = all[g] ?? false
        // The suggestions: one line, uncounted, at the end of "needs you".
        const offered =
          g === "needs" && suggestions.length > 0 ? (
            <div className="flex min-w-0 flex-col" data-pa-activity-suggestions>
              <PanelMoreRow
                onClick={() => setSuggestionsOpen((o) => !o)}
                aria-expanded={suggestionsOpen}
                data-pa-activity-suggestions-toggle
              >
                {t("suggestions", { count: suggestions.length })}
              </PanelMoreRow>
              {suggestionsOpen
                ? suggestions.map((row) => (
                    <ActivityRowView
                      key={row.key}
                      row={row}
                      group={g}
                      scope={scope}
                      flash={flash === row.key}
                    />
                  ))
                : null}
            </div>
          ) : null
        return (
          <PanelGroup
            key={g}
            fold={ACTIVITY_FOLD[g]}
            tone={GROUP_TONE[g]}
            label={t(`groups.${g}`)}
            // Suggestions alone: no count on the head.
            count={rows.length > 0 ? rows.length : null}
            action={
              g === "next" && !readOnly ? (
                <Button
                  size="icon-xs"
                  variant="ghost"
                  className="text-muted-foreground"
                  onClick={newRoutine}
                  title={tr("new")}
                  aria-label={tr("new")}
                  data-pa-routine-new
                >
                  <Plus aria-hidden />
                </Button>
              ) : undefined
            }
            more={
              !whole && rows.length > GROUP_SHOWN ? (
                <PanelMoreRow
                  onClick={() => setAll((a) => ({ ...a, [g]: true }))}
                  data-pa-activity-more={g}
                >
                  {tt("more", { count: rows.length - GROUP_SHOWN })}
                </PanelMoreRow>
              ) : null
            }
            className="scroll-mt-3"
            data-pa-activity-group={g}
          >
            {(whole ? rows : rows.slice(0, GROUP_SHOWN)).map((row) => (
              <ActivityRowView
                key={row.key}
                row={row}
                group={g}
                scope={scope}
                flash={flash === row.key}
              />
            ))}
            {offered}
          </PanelGroup>
        )
      })}
    </div>
  )
}
