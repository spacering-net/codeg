"use client"

/**
 * The rows of "today" (6.3, 1.14, C1): what each says — the assistant it is
 * about, or the project of the owner's own session or task; what it is and
 * where it stands; why it waits on the owner — and where it opens, where the
 * owner can act on it: a card in its assistant's conversation, a session as
 * a conversation tab, a board task's detail sheet, handed-out work in the
 * drawer; one with nothing of its own, its assistant. A change an assistant
 * made for the owner is taken back on its row, a draft taken in or let go.
 * The activity's list draws them (`useTodayRowProps`), and a morning brief
 * its rows (`BriefRows`). None of it goes through an assistant's brain.
 */

import { useEffect, useMemo, useState, type ReactNode } from "react"
import { useLocale, useTranslations } from "next-intl"
import { Folder } from "lucide-react"
import { toast } from "sonner"

import { formatRelative } from "@/components/conversations/sidebar-conversation-grouping"
import { useTaskDialogs } from "@/components/tasks/use-task-dialogs"
import { Button } from "@/components/ui/button"
import {
  useOptionalTasksView,
  useTasksView,
} from "@/contexts/tasks-view-context"
import { personalAgentNoticeAct } from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"
import type { DispatchInfo, TodayRow } from "@/lib/types"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"
import { refreshActivity } from "@/stores/personal-agent-activity-store"
import { useRoster } from "@/stores/personal-agent-roster-store"
import { usePersonalAgentUi } from "@/stores/personal-agent-ui-store"

import { BotAvatar } from "./bot-avatar"
import { ChangesText } from "./change-text"
import {
  PanelIcon,
  PanelItem,
  PanelList,
  useInPanelList,
  type PanelItemProps,
} from "./panel-section"
import { useSessionLinkOpener } from "./session-link"
import { canOpenWork, useBotName, useOpenWork, workTargetOf } from "./shared"

/** A row's lead, in px at 100% zoom: in the panel's lists, and on a soft
 *  card of its own (the morning brief's), as a work card's avatar. */
const LEAD_SIZE = 24
const CARD_LEAD_SIZE = 20
/** Where a row opens: its card, a session, a task, a piece of work. */
export type Opener = (row: TodayRow) => (() => void) | null

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

/** The button a reason puts on its row, by the words it says (B2). */
const GO_OF: Record<string, "merge" | "board" | "review" | undefined> = {
  merge_ready: "merge",
  needs_delivery: "board",
  accepted_unchecked: "review",
  review: "review",
}

/** The way each row opens, from the page around it. */
export function useOpener(
  today: { dispatches: DispatchInfo[] },
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
      // Work that failed before it opened a session: its result card.
      case "failed":
        return work ?? task ?? session ?? jump
      case "dispatch":
      case "finished":
      case "checked":
        return work ?? task ?? session
      // A watched pull request: the work it came from, else its assistant.
      case "pr":
      case "pr_merged":
        return work ?? task ?? bot
      // A routine: its assistant's, at its row.
      case "routine":
        return bot
          ? () => {
              bot()
              usePersonalAgentUi.getState().showRoutines(row.routine_id)
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
      // A check of a message the owner asked about.
      case "checked":
        return row.state === "canceled"
          ? t("kind.checkCanceled")
          : t("kind.checked")
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
export function useNow(): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 60_000)
    return () => window.clearInterval(id)
  }, [])
  return now
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

/** [Undo] on a change an assistant made for the owner. */
function UndoAction({ row }: { row: TodayRow }) {
  const t = useTranslations("PersonalAgent.today")
  const [acting, setActing] = useState(false)
  return (
    <Button
      size="sm"
      variant="outline"
      disabled={acting || row.notice_id == null}
      onClick={() => {
        if (row.notice_id == null) return
        setActing(true)
        personalAgentNoticeAct(row.notice_id, "undo", row.bot_id)
          .then(() => refreshActivity())
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
      .then(() => refreshActivity())
      .catch((e) => toast.error(toErrorMessage(e)))
      .finally(() => setActing(false))
  }
  return (
    <>
      <Button
        size="sm"
        disabled={acting || row.notice_id == null}
        onClick={() => act("apply")}
        data-pa-today-act="apply"
      >
        {row.kind === "skill" ? t("install") : t("apply")}
      </Button>
      <Button
        size="sm"
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

/** What a row of "today" shows, as a `PanelItem`'s props: in the
 *  activity's list (`waiting`: in what waits on the owner — the reason in a
 *  box, the button that does it), or in a morning brief. `actions` given
 *  take the place of its own (a matter's, settled on its row). */
export function useTodayRowProps({
  row,
  waiting,
  now,
  onOpen,
  readOnly,
  actions: given,
  chipSaysState = false,
}: {
  row: TodayRow
  waiting: boolean
  now: number
  onOpen: (() => void) | null
  readOnly: boolean
  actions?: ReactNode
  /** Where it stands is on a chip of its own (its work's rung): the quiet
   *  line does not say it again — in other words, which could read as
   *  another state ("waiting for acceptance" by "ready to merge"). What
   *  the chip cannot say (a check's round, a reminder handed over) it
   *  still does. */
  chipSaysState?: boolean
}): PanelItemProps {
  const t = useTranslations("PersonalAgent.today")
  const ta = useTranslations("PersonalAgent.feed")
  const words = useRowWords()
  const entries = useRoster()
  const botName = useBotName()
  const entry =
    row.bot_id != null ? entries?.find((e) => e.id === row.bot_id) : undefined
  const who =
    row.bot_id != null
      ? botName(entry ?? { id: row.bot_id, kind: "worker" })
      : (row.project?.name ?? t("yours"))
  // A reminder handed to its assistant says so; a task being checked, its
  // round (C1).
  const handed = row.kind === "reminder" && row.state === "handed"
  const checking = row.kind === "task" && row.check_dispatch_id != null
  const what = handed
    ? ta("handed", { name: who })
    : checking
      ? ta("checking", { round: row.round ?? 1 })
      : words(row)
  const when = row.kind === "item" ? null : formatRelative(row.at, now)
  // What it is first — red when it failed, the word to look for — then
  // whose; a merge queued meanwhile; when, at the title's end.
  const parts = [
    chipSaysState && !handed && !checking ? null : (
      <span
        key="what"
        className={
          row.kind === "failed" ? "text-red-600 dark:text-red-400" : undefined
        }
      >
        {what}
      </span>
    ),
    row.queued ? ta("queued") : null,
    who || null,
  ].filter((p) => p != null)
  const meta =
    parts.length > 0 ? (
      <>{parts.flatMap((p, i) => (i === 0 ? [p] : [" · ", p]))}</>
    ) : undefined
  // A setting changed: worded as its card words it, not by its key.
  const title = row.changes ? (
    <ChangesText changes={row.changes.changes} names={row.changes.names} />
  ) : (
    row.title.trim() || what
  )
  // What a board task waits on the owner for, in a sentence (B2); a
  // failure says it in its own words.
  const reason =
    row.reason != null && row.reason !== "failed"
      ? t(`reason.${row.reason}` as "reason.looking", { name: who })
      : null
  // Where to do it: the task's details, which merge and deliver it.
  const go = waiting && onOpen ? GO_OF[row.reason ?? ""] : undefined
  // Its own — a matter's, settled here; a draft's — after it.
  const own = readOnly ? null : given !== undefined ? (
    given
  ) : (row.kind === "tidy" || row.kind === "skill") && row.state === "draft" ? (
    <DraftActions row={row} />
  ) : null
  const actions =
    go || own ? (
      <>
        {go ? (
          <Button
            size="sm"
            variant="outline"
            onClick={onOpen ?? undefined}
            data-pa-today-act={`go-${row.reason}`}
          >
            {t(`go.${go}` as "go.review")}
          </Button>
        ) : null}
        {own}
      </>
    ) : null
  // Taking a change back: one button, at a row's end.
  const action =
    !readOnly &&
    (row.kind === "changed" ||
      row.kind === "memory" ||
      row.kind === "tidy" ||
      row.kind === "skill") &&
    row.undo &&
    row.state !== "draft" ? (
      <UndoAction row={row} />
    ) : null
  // What waits on the owner says it in a box, what failed red; elsewhere —
  // and in a morning brief — a quiet note. The words are the assistant's
  // summing up, not an error's own text: not in the code face.
  const failed = row.kind === "failed" || row.state === "failed"
  // Just failed, its assistant on it (B6): that, not the error.
  const said =
    failed && row.reason !== "looking"
      ? (row.text ?? reason)
      : (reason ?? row.text)
  const callout =
    waiting && said
      ? {
          tone: failed ? ("error" as const) : ("wait" as const),
          text: said,
        }
      : null
  return {
    media: <RowLead row={row} />,
    title,
    time: when,
    meta,
    callout,
    notes: said && !callout ? [said] : [],
    onOpen,
    openLabel: t("open"),
    actions,
    action,
    "data-pa-today-row": row.kind,
    "data-key": row.key,
  } as PanelItemProps
}

/** A row of a morning brief: as "today" draws it, nothing settled on it. */
function TodayRowCard({
  row,
  now,
  onOpen,
}: {
  row: TodayRow
  now: number
  onOpen: (() => void) | null
}) {
  return (
    <PanelItem
      {...useTodayRowProps({
        row,
        waiting: false,
        now,
        onOpen,
        readOnly: true,
      })}
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
  // On the brief's card, rows as its other parts' are: no surface of their
  // own, a hairline over each and under the last, flush with the card's
  // words.
  return (
    <PanelList
      data-pa-brief-rows
      className="rounded-none border-0 bg-transparent [&>[role=listitem]]:border-t! [&>[role=listitem]]:border-t-border/60! [&>[role=listitem]]:border-b-0! [&>[role=listitem]]:px-0! [&>[role=listitem]]:py-3! [&>[role=listitem]:last-child]:border-b!"
    >
      {rows.map((row) => (
        <TodayRowCard key={row.key} row={row} now={now} onOpen={opener(row)} />
      ))}
    </PanelList>
  )
}
