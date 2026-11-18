"use client"

/**
 * "Today" (6.3, 1.14), first on the primary's activity tab: every
 * assistant's at once, in four groups — what waits on the owner anywhere in
 * codeg, what the assistants keep an eye on, the rest of the day, what was
 * done today — each shown only when it has something, and "nothing needs
 * you today" when none has.
 *
 * Each row leads with the assistant it is about, or the project of the
 * owner's own session or task, and opens what it is about where the owner
 * can act on it: a card in its assistant's conversation, a session as a
 * conversation tab, a board task's detail sheet, handed-out work in the
 * drawer; one with nothing of its own, its assistant. A matter is settled
 * on its row (done, later) — one that came due and one still to come — and
 * a change an assistant made for the owner is taken back on its row. None of it goes
 * through an assistant's brain.
 */

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { useLocale, useTranslations } from "next-intl"
import { ChevronDown, Folder, Sun } from "lucide-react"
import { toast } from "sonner"

import { formatRelative } from "@/components/conversations/sidebar-conversation-grouping"
import { useTaskDialogs } from "@/components/tasks/use-task-dialogs"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Skeleton } from "@/components/ui/skeleton"
import {
  useOptionalTasksView,
  useTasksView,
} from "@/contexts/tasks-view-context"
import { personalAgentItemAct, personalAgentNoticeAct } from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"
import type { DispatchInfo, PersonalAgentToday, TodayRow } from "@/lib/types"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"
import { useRoster } from "@/stores/personal-agent-roster-store"
import { refreshToday } from "@/stores/personal-agent-today-store"
import { usePersonalAgentUi } from "@/stores/personal-agent-ui-store"

import { BotAvatar } from "./bot-avatar"
import {
  PanelEmpty,
  PanelGroup,
  PanelIcon,
  PanelItem,
  PanelMoreRow,
  PanelSection,
  useInPanelList,
  type PanelTone,
} from "./panel-section"
import { useSessionLinkOpener } from "./session-link"
import { canOpenWork, useBotName, useOpenWork, workTargetOf } from "./shared"

/** A row's lead, in px at 100% zoom: in the panel's lists, and on a soft
 *  card of its own (the morning brief's), as a work card's avatar. */
const LEAD_SIZE = 24
const CARD_LEAD_SIZE = 20
/** Rows a group shows before "show all". */
const GROUP_SHOWN = 8

type GroupKey = "needs" | "watching" | "schedule" | "done"
const GROUPS: readonly GroupKey[] = ["needs", "watching", "schedule", "done"]

/** A group's marker, as the matters' sections mark theirs. */
const GROUP_TONE: Record<GroupKey, PanelTone> = {
  needs: "amber",
  watching: "primary",
  schedule: "muted",
  done: "green",
}

/** Where a row opens: its card, a session, a task, a piece of work. */
type Opener = (row: TodayRow) => (() => void) | null

/** How a tidy-up's and a process skill's rows can stand (7.7, 7.8). */
const TIDY_ROW_STATES = new Set([
  "acted",
  "draft",
  "applied",
  "undone",
  "discarded",
  "stale",
])
const SKILL_ROW_STATES = new Set([...TIDY_ROW_STATES, "deleted"])

/** The way each row opens, from the page around it. */
function useOpener(
  today: Pick<PersonalAgentToday, "dispatches">,
  inDrawer: boolean,
  openTask: ((id: number) => void) | null
): Opener {
  const entries = useRoster()
  const openSession = useSessionLinkOpener()
  const openWork = useOpenWork()
  return (row) => {
    // The assistant's conversation, at the row when there is one.
    const toBot = (rowId: number | null) => {
      const bot = row.bot_id as number
      const primary = entries?.find((e) => e.id === bot)?.kind === "primary"
      const ui = usePersonalAgentUi.getState()
      ui.setViewBot(primary ? null : bot)
      ui.showConversation()
      ui.setPendingJump(rowId != null ? { bot, row: rowId } : null)
      // The drawer would cover the card it jumps to.
      if (inDrawer) ui.setAuxOpen(false)
    }
    const jump =
      row.bot_id != null && row.row_id != null ? () => toBot(row.row_id) : null
    // Nothing of its own to open: its assistant.
    const bot = row.bot_id != null ? () => toBot(null) : null
    const task =
      row.task_id != null && openTask ? () => openTask(row.task_id!) : null
    const session =
      row.conversation_id != null
        ? () => openSession(row.conversation_id!)
        : null
    const info =
      row.dispatch_id != null
        ? today.dispatches.find((d) => d.id === row.dispatch_id)
        : undefined
    const target = info ? workTargetOf(info) : null
    const work = target && canOpenWork(target) ? () => openWork(target) : null
    switch (row.kind) {
      // Work waiting in its own session: answered there.
      case "waiting":
        return task ?? session ?? work ?? jump
      case "task":
        return task ?? session
      case "session":
        return session
      case "failed":
      case "dispatch":
      case "finished":
        return work ?? task ?? session
      // A watched pull request: the work it came from, else its assistant.
      case "pr":
      case "pr_merged":
        return work ?? task ?? bot
      // A routine: its assistant's routines.
      case "routine":
        return bot
          ? () => {
              bot()
              usePersonalAgentUi.getState().showRoutines()
            }
          : null
      case "routine_run":
        return work ?? bot
      default:
        return jump ?? work ?? bot
    }
  }
}

/** The words of a row: what it is, a second line under it. */
function useRowWords() {
  const t = useTranslations("PersonalAgent.today")
  const tr = useTranslations("PersonalAgent.rules")
  const locale = useLocale()
  const clock = (iso: string) =>
    new Date(iso).toLocaleTimeString(locale, {
      hour: "2-digit",
      minute: "2-digit",
    })
  return (row: TodayRow): string => {
    switch (row.kind) {
      case "session":
        return t(`session.${row.state ?? "question"}` as "session.question")
      case "task":
        return t(`task.${row.state ?? "running"}` as "task.running")
      case "dispatch":
        return t(`dispatch.${row.state ?? "running"}` as "dispatch.running")
      case "finished":
        return row.state === "canceled"
          ? t("kind.canceled")
          : t("kind.finished")
      case "changed":
        return row.state === "undone" ? t("kind.undone") : t("kind.changed")
      // What an assistant remembered (7.7).
      case "memory":
        return row.state === "undone"
          ? t("kind.memoryUndone")
          : t("kind.memory")
      // Its nightly tidy-up, a process skill it wrote (7.7, 7.8).
      case "tidy":
        return t(
          `tidy.${TIDY_ROW_STATES.has(row.state ?? "") ? row.state : "acted"}` as "tidy.acted"
        )
      case "skill":
        return t(
          `skill.${SKILL_ROW_STATES.has(row.state ?? "") ? row.state : "acted"}` as "skill.acted"
        )
      case "pr":
        return t(`pr.${row.state ?? "open"}` as "pr.open")
      case "item": {
        const does = row.state?.endsWith(":act") ?? false
        return t(does ? "item.act" : "item.notify", { time: clock(row.at) })
      }
      case "routine":
        return t("routine.at", { time: clock(row.at) })
      case "routine_run":
        return row.state === "asked" ? t("routine.asked") : t("routine.running")
      case "routine_report":
        return row.state === "silent"
          ? t("routine.silent")
          : t("routine.reported")
      // One of codeg's proposal rules (6.7): what it found.
      case "rule":
        return tr(`heading.${row.state ?? "idle"}` as "heading.idle")
      default:
        return t(`kind.${row.kind}` as "kind.approval")
    }
  }
}

/** A minute-at-a-time clock, for the rows' "3 min". */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 60_000)
    return () => window.clearInterval(id)
  }, [])
  return now
}

export function TodaySection({
  title,
  today,
  inDrawer,
  readOnly,
}: {
  /** The section's title, as the activity's others have theirs. */
  title: string
  today: PersonalAgentToday | null
  inDrawer: boolean
  /** The assistants run in another process: nothing is acted on here. */
  readOnly: boolean
}) {
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
  // The primary's pill asks for it: brought into view.
  const asked = usePersonalAgentUi((s) => s.todayAsked)
  const ref = useRef<HTMLElement | null>(null)
  useEffect(() => {
    if (asked > 0) ref.current?.scrollIntoView({ block: "start" })
  }, [asked])

  return (
    <PanelSection
      ref={ref}
      title={title}
      className="scroll-mt-3"
      data-pa-detail="today"
    >
      {today == null ? (
        <div className="flex flex-col gap-1.5" aria-hidden>
          <Skeleton className="h-4 w-24 rounded-md" />
          <Skeleton className="h-16 w-full rounded-xl" />
        </div>
      ) : (
        <TodayBody
          today={today}
          inDrawer={inDrawer}
          readOnly={readOnly}
          openTask={openDetail}
        />
      )}
      {dialogs}
    </PanelSection>
  )
}

function TodayBody({
  today,
  inDrawer,
  readOnly,
  openTask,
}: {
  today: PersonalAgentToday
  inDrawer: boolean
  readOnly: boolean
  openTask: (id: number) => void
}) {
  const t = useTranslations("PersonalAgent.today")
  const now = useNow()
  const opener = useOpener(today, inDrawer, openTask)
  const shown = GROUPS.filter((g) => today[g].length > 0)
  // The morning brief or the wrap-up, while it is being written (6.4).
  const preparing =
    today.brief?.state === "preparing" ? (
      <p
        className="text-xs leading-5 text-muted-foreground"
        data-pa-today-brief={today.brief.kind}
      >
        <span className="activity-shimmer">
          {t(today.brief.kind === "wrap" ? "preparingWrap" : "preparingBrief")}
        </span>
      </p>
    ) : null
  if (shown.length === 0) {
    return (
      <div className="flex flex-col gap-1.5">
        {preparing}
        <PanelEmpty icon={Sun} data-pa-today-empty>
          {t("empty")}
        </PanelEmpty>
      </div>
    )
  }
  return (
    <div className="flex flex-col gap-4">
      {preparing}
      {shown.map((g) => (
        <TodayGroup key={g} group={g} count={today[g].length}>
          {(all) =>
            (all ? today[g] : today[g].slice(0, GROUP_SHOWN)).map((row) => (
              <TodayRowCard
                key={row.key}
                row={row}
                now={now}
                onOpen={opener(row)}
                readOnly={readOnly}
              />
            ))
          }
        </TodayGroup>
      ))}
    </div>
  )
}

/** A group: its marker, its name and how many it holds — amber where the
 *  owner is waited on — folding; the rows under it, the first few until
 *  "show all". */
function TodayGroup({
  group,
  count,
  children,
}: {
  group: GroupKey
  count: number
  children: (all: boolean) => ReactNode
}) {
  const t = useTranslations("PersonalAgent.today")
  const [all, setAll] = useState(false)
  return (
    <PanelGroup
      fold={`today.${group}`}
      tone={GROUP_TONE[group]}
      label={t(`groups.${group}`)}
      count={count}
      more={
        !all && count > GROUP_SHOWN ? (
          <PanelMoreRow onClick={() => setAll(true)} data-pa-today-more={group}>
            {t("more", { count: count - GROUP_SHOWN })}
          </PanelMoreRow>
        ) : null
      }
      data-pa-today-group={group}
    >
      {children(all)}
    </PanelGroup>
  )
}

/** What leads a row: the assistant it is about, or the project of the
 *  owner's own. */
function RowLead({ row }: { row: TodayRow }) {
  const entries = useRoster()
  const botName = useBotName()
  const inList = useInPanelList()
  const t = useTranslations("PersonalAgent.today")
  const entry =
    row.bot_id != null ? entries?.find((e) => e.id === row.bot_id) : undefined
  if (row.bot_id != null) {
    return (
      <BotAvatar
        avatar={entry?.avatar}
        name={botName(entry ?? { id: row.bot_id, kind: "worker" })}
        size={inList ? LEAD_SIZE : CARD_LEAD_SIZE}
        star={entry?.kind === "primary"}
      />
    )
  }
  return (
    <span title={row.project?.name ?? t("yours")} className="flex">
      <PanelIcon icon={Folder} />
    </span>
  )
}

/** The way to settle a matter from its row: done, or later. */
function MatterActions({ row }: { row: TodayRow }) {
  const td = useTranslations("PersonalAgent.detail.item")
  const [acting, setActing] = useState(false)
  const act = (kind: "done" | "snooze", until?: "15m" | "1h" | "tomorrow") => {
    if (row.item_id == null) return
    setActing(true)
    personalAgentItemAct(row.bot_id, row.item_id, kind, until)
      .then(() => refreshToday())
      .catch((e) => toast.error(toErrorMessage(e)))
      .finally(() => setActing(false))
  }
  return (
    <>
      <Button
        size="xs"
        variant="outline"
        disabled={acting}
        onClick={() => act("done")}
        data-pa-today-act="done"
      >
        {td("done")}
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            size="xs"
            variant="ghost"
            disabled={acting}
            data-pa-today-act="later"
          >
            {td("later")}
            <ChevronDown className="size-3" aria-hidden />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          {(["15m", "1h", "tomorrow"] as const).map((until) => (
            <DropdownMenuItem
              key={until}
              onSelect={() => act("snooze", until)}
              data-pa-today-act={`snooze-${until}`}
            >
              {td(
                until === "15m" ? "in15m" : until === "1h" ? "in1h" : "tomorrow"
              )}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  )
}

/** [Undo] on a change an assistant made for the owner. */
function UndoAction({ row }: { row: TodayRow }) {
  const t = useTranslations("PersonalAgent.today")
  const [acting, setActing] = useState(false)
  return (
    <Button
      size="xs"
      variant="outline"
      disabled={acting || row.notice_id == null}
      onClick={() => {
        if (row.notice_id == null) return
        setActing(true)
        personalAgentNoticeAct(row.notice_id, "undo", row.bot_id)
          .then(() => refreshToday())
          .catch((e) => toast.error(toErrorMessage(e)))
          .finally(() => setActing(false))
      }}
      data-pa-today-act="undo"
    >
      {t("undo")}
    </Button>
  )
}

/** A tidy-up or a process skill kept as a draft (7.7, 7.8): taken in, or
 *  let go. */
function DraftActions({ row }: { row: TodayRow }) {
  const t = useTranslations("PersonalAgent.today")
  const [acting, setActing] = useState(false)
  const act = (action: "apply" | "dismiss") => {
    if (row.notice_id == null) return
    setActing(true)
    personalAgentNoticeAct(row.notice_id, action, row.bot_id)
      .then(() => refreshToday())
      .catch((e) => toast.error(toErrorMessage(e)))
      .finally(() => setActing(false))
  }
  return (
    <>
      <Button
        size="xs"
        disabled={acting || row.notice_id == null}
        onClick={() => act("apply")}
        data-pa-today-act="apply"
      >
        {row.kind === "skill" ? t("install") : t("apply")}
      </Button>
      <Button
        size="xs"
        variant="ghost"
        disabled={acting || row.notice_id == null}
        onClick={() => act("dismiss")}
        data-pa-today-act="dismiss"
      >
        {t("notThis")}
      </Button>
    </>
  )
}

function TodayRowCard({
  row,
  now,
  onOpen,
  readOnly,
}: {
  row: TodayRow
  now: number
  onOpen: (() => void) | null
  readOnly: boolean
}) {
  const t = useTranslations("PersonalAgent.today")
  const words = useRowWords()
  const entries = useRoster()
  const botName = useBotName()
  const what = words(row)
  const entry =
    row.bot_id != null ? entries?.find((e) => e.id === row.bot_id) : undefined
  const who =
    row.bot_id != null
      ? botName(entry ?? { id: row.bot_id, kind: "worker" })
      : (row.project?.name ?? t("yours"))
  const when = row.kind === "item" ? null : formatRelative(row.at, now)
  // What it is first — red when it failed, the word to look for — then
  // whose; when, at the title's end.
  const meta = (
    <>
      <span
        className={
          row.kind === "failed" ? "text-red-600 dark:text-red-400" : undefined
        }
      >
        {what}
      </span>
      {who ? ` · ${who}` : null}
    </>
  )
  const title = row.title.trim() || what
  // A matter is settled on its row: one that came due, one still to come.
  const actions = readOnly ? null : row.kind === "reminder" ||
    row.kind === "item" ? (
    <MatterActions row={row} />
  ) : (row.kind === "tidy" || row.kind === "skill") && row.state === "draft" ? (
    <DraftActions row={row} />
  ) : (row.kind === "changed" ||
      row.kind === "memory" ||
      row.kind === "tidy" ||
      row.kind === "skill") &&
    row.undo ? (
    <UndoAction row={row} />
  ) : null
  return (
    <PanelItem
      media={<RowLead row={row} />}
      title={title}
      time={when}
      meta={meta}
      notes={row.text ? [row.text] : []}
      onOpen={onOpen}
      openLabel={t("open")}
      actions={actions}
      data-pa-today-row={row.kind}
      data-key={row.key}
    />
  )
}

/** The rows of a morning brief codeg wrote itself (6.4): each opens what it
 *  is about, as "today"'s rows do; nothing is settled from them. */
export function BriefRows({
  rows,
  dispatches,
}: {
  rows: TodayRow[]
  dispatches: DispatchInfo[]
}) {
  const view = useOptionalTasksView()
  return view ? (
    <BriefRowsWithTasks rows={rows} dispatches={dispatches} />
  ) : (
    <BriefRowList rows={rows} dispatches={dispatches} openTask={null} />
  )
}

function BriefRowsWithTasks({
  rows,
  dispatches,
}: {
  rows: TodayRow[]
  dispatches: DispatchInfo[]
}) {
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
    <>
      <BriefRowList rows={rows} dispatches={dispatches} openTask={openDetail} />
      {dialogs}
    </>
  )
}

function BriefRowList({
  rows,
  dispatches,
  openTask,
}: {
  rows: TodayRow[]
  dispatches: DispatchInfo[]
  openTask: ((id: number) => void) | null
}) {
  const now = useNow()
  const opener = useOpener({ dispatches }, false, openTask)
  return (
    <div className="flex flex-col gap-1.5">
      {rows.map((row) => (
        <TodayRowCard
          key={row.key}
          row={row}
          now={now}
          onOpen={opener(row)}
          readOnly
        />
      ))}
    </div>
  )
}
