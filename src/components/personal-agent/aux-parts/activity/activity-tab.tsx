"use client"

/** The activity tab (C1): one list, in four groups by what each thing means
 *  to the owner — what waits on them, what is under way, what comes next
 *  (its routines among it), what was done today, folded to a line at first
 *  — each thing once, read whole in one go. A group shows its first rows
 *  until "show all". The morning brief being written says so on top;
 *  nothing at all is one row. Asked for a row (the pill, a routine), the
 *  list brings it into view once it has it. */

import { useEffect, useMemo, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { Inbox, Plus } from "lucide-react"
import { toast } from "sonner"

import { useTaskDialogs } from "@/components/tasks/use-task-dialogs"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { usePersonalAgent } from "@/contexts/personal-agent-context"
import { useTasksView } from "@/contexts/tasks-view-context"
import type {
  ActivityRow,
  PersonalAgentActivity,
  PersonalAgentSnapshot,
} from "@/lib/types"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"
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

const GROUPS: readonly ActivityGroup[] = ["needs", "watching", "next", "done"]

const GROUP_TONE: Record<ActivityGroup, PanelTone> = {
  needs: "amber",
  watching: "primary",
  next: "muted",
  done: "green",
}

/** Each group's rows, as the list shows them: "Routine: no change" is not
 *  done today's, nor counted there (C2) — its routine's row says it. */
export function groupsOf(
  view: PersonalAgentActivity
): Record<ActivityGroup, ActivityRow[]> {
  return {
    needs: view.needs,
    watching: view.watching,
    next: view.next,
    done: view.done.filter(
      (r) => !(r.today?.kind === "routine_report" && r.today.state === "silent")
    ),
  }
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
  const { openDetail, dialogs } = useTaskDialogs({
    tasks,
    refetch,
    folderNames,
    defaultFolderId: null,
  })
  return (
    <TabBody>
      <ActivityList
        read={read}
        readOnly={readOnly}
        inDrawer={inDrawer}
        openTask={openDetail}
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
}: {
  /** What was read for the page's assistant; `null` while none is. */
  read: ActivityRead | null
  readOnly: boolean
  inDrawer: boolean
  openTask: ((id: number) => void) | null
}) {
  const t = useTranslations("PersonalAgent.feed")
  const tt = useTranslations("PersonalAgent.today")
  const tr = useTranslations("PersonalAgent.routines")
  const { botId, snapshot } = usePersonalAgent()
  const view = read?.view ?? null
  // Its first read failed: nothing to show.
  const failed = read != null && read.view == null
  const now = useNow()
  const opener = useOpener(
    { dispatches: view?.dispatches ?? [] },
    inDrawer,
    openTask
  )
  const openEditor = usePersonalAgentUi((s) => s.openRoutineEditor)
  const ask = usePersonalAgentUi((s) => s.activityAsk)
  const clearAsk = usePersonalAgentUi((s) => s.clearActivityAsk)
  const [all, setAll] = useState<Partial<Record<ActivityGroup, boolean>>>({})
  const [flash, setFlash] = useState<string | null>(null)
  const ref = useRef<HTMLDivElement | null>(null)
  const groups = useMemo(() => (view ? groupsOf(view) : null), [view])

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
    const rows = groups?.[ask.group] ?? []
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
    dispatches: view.dispatches,
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
  const shown = GROUPS.filter((g) => groups[g].length > 0)
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
        const rows = groups[g]
        const whole = all[g] ?? false
        return (
          <PanelGroup
            key={g}
            fold={ACTIVITY_FOLD[g]}
            tone={GROUP_TONE[g]}
            label={t(`groups.${g}`)}
            count={rows.length}
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
          </PanelGroup>
        )
      })}
    </div>
  )
}
