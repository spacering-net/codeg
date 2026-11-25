"use client"

/** The activity's rows (C1, C3): one for each thing — "today"'s row of it,
 *  the matter it stands for, or a routine — in one shape: who or what it is,
 *  its title, one line of where it stands and when, at most one box (why it
 *  failed, why it waits on the owner), the buttons that settle it, and a ›
 *  at its end that unfolds the rest of it in place. */

import { useState, type ReactNode } from "react"
import { useLocale, useTranslations } from "next-intl"
import {
  Bell,
  Check,
  ChevronDown,
  Clock,
  Ear,
  Forward,
  ListTodo,
  MessageCircleQuestionMark,
  MessagesSquare,
  X,
  type LucideIcon,
} from "lucide-react"
import { toast } from "sonner"
import { formatRelative } from "@/components/conversations/sidebar-conversation-grouping"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { personalAgentItemAct } from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"
import type {
  ActivityRow,
  DispatchInfo,
  ItemInfo,
  ItemKind,
  TodayRow,
} from "@/lib/types"
import { cn } from "@/lib/utils"
import { refreshActivity } from "@/stores/personal-agent-activity-store"
import { useRoster } from "@/stores/personal-agent-roster-store"
import {
  usePersonalAgentUi,
  type ActivityGroup,
} from "@/stores/personal-agent-ui-store"

import { PanelIcon, PanelItem, type PanelItemProps } from "../../panel-section"
import { RoutineRow, UnfoldButton } from "../../routines-section"
import {
  canOpenWork,
  WorkAgentFact,
  WorkGlyph,
  useBotName,
  useOpenWork,
  useWorkMeta,
  workTargetOf,
} from "../../shared"
import { useActivityTranslate } from "../../activity-text"
import { dueWhen, repeatText } from "../../due-text"
import { AnsweredForYou } from "../../event-card"
import { LadderChip, TaskStopButton, TaskStrip } from "../../task-strip"
import { useTodayRowProps, type Opener } from "../../today-section"
import { MOVING } from "../use-work"

/** A piece of work's glyph leading a row, in px at 100% zoom: as a kind's
 *  icon tile. */
export const ROW_AVATAR_SIZE = 24

/** The icon of a matter that is not handed-out work. */
const KIND_ICON: Record<Exclude<ItemKind, "dispatch">, LucideIcon> = {
  reminder: Bell,
  followup: Forward,
  question: MessageCircleQuestionMark,
  message: MessagesSquare,
  when_mentioned: Ear,
}

/** codeg's own words for the matters of a message between assistants
 *  (`messages.rs`): its sender's, and its receiver's. */
const WAITING_ANSWER = /^Waiting for (.+?)'s answer: ([\s\S]*)$/
const WROTE_TO_YOU = /^(.+?) wrote to you: ([\s\S]*)$/

/** A message's matter written by codeg, in the page's language: what it
 *  says with its sender or receiver named; `null` for words of anyone
 *  else's (an assistant's own summary), shown as written. */
export function messageMatterWords(
  summary: string
): { key: "waitingAnswer" | "wroteToYou"; name: string; text: string } | null {
  const waiting = WAITING_ANSWER.exec(summary)
  if (waiting)
    return { key: "waitingAnswer", name: waiting[1]!, text: waiting[2]! }
  const wrote = WROTE_TO_YOU.exec(summary)
  if (wrote) return { key: "wroteToYou", name: wrote[1]!, text: wrote[2]! }
  return null
}

/** A matter's title: its summary — codeg's words for a message's matter in
 *  the page's language. */
function useMatterTitle(): (item: ItemInfo) => string {
  const t = useTranslations("PersonalAgent.items")
  return (item) => {
    const words =
      item.kind === "message" ? messageMatterWords(item.summary) : null
    return words
      ? t(words.key, { name: words.name, text: words.text })
      : item.summary
  }
}

/** Where the rows open, and what they are drawn with: the page around the
 *  list. */
export interface RowScope {
  now: number
  readOnly: boolean
  inDrawer: boolean
  opener: Opener
  /** The board task's detail sheet. */
  openTask: ((id: number) => void) | null
  dispatches: DispatchInfo[]
}

/** A card in an assistant's conversation, shown: the page switched to it,
 *  the drawer out of the way. */
function useJumpTo(inDrawer: boolean): (bot: number, rowId: number) => void {
  const entries = useRoster()
  return (bot, rowId) => {
    const primary = entries?.find((e) => e.id === bot)?.kind === "primary"
    const ui = usePersonalAgentUi.getState()
    ui.setViewBot(primary ? null : bot)
    ui.showConversation()
    ui.setPendingJump({ bot, row: rowId })
    if (inDrawer) ui.setAuxOpen(false)
  }
}

/** When a matter is due, in a few words: due, overdue, reminded — and how
 *  it comes back when it repeats; what brings up one on a mention. */
function useDueNotes(): (item: ItemInfo, now: number) => string[] {
  const tw = useActivityTranslate()
  const t = useTranslations("PersonalAgent.items")
  const locale = useLocale()
  return (item, now) => {
    if (item.mention) {
      const m = item.mention
      return [
        t("mention", {
          words: m.keywords.map((k) => `“${k}”`).join(", "),
          times: m.times,
          max: m.max_times,
          until: new Date(m.expires_at).toLocaleDateString(locale, {
            month: "short",
            day: "numeric",
          }),
        }),
      ]
    }
    if (!item.due_at) return []
    const due = Date.parse(item.due_at)
    const when = dueWhen(tw, item.due_at, now, locale)
    const fired =
      item.fired_at != null && Date.parse(item.fired_at) >= due - 1000
    const line = fired
      ? tw("due.reminded", { when })
      : due < now
        ? tw("due.overdue", { when })
        : tw("due.dueAt", { when })
    const rule = item.repeat ? repeatText(tw, item.repeat, now, locale) : ""
    return [rule ? `${line} · ${rule}` : line]
  }
}

const SNOOZE_CHOICES = [
  { until: "15m", label: "in15m" },
  { until: "1h", label: "in1h" },
  { until: "tomorrow", label: "tomorrow" },
] as const

/** Whether a matter has a way to settle it on its row (`ItemActions`):
 *  handed-out work still moving settles itself. */
function hasItemActions(item: ItemInfo, dispatch: DispatchInfo | null) {
  const state = dispatch?.state ?? item.dispatch_state
  return !(item.kind === "dispatch" && state != null && MOVING.has(state))
}

/** The way to settle a matter on its row (C1): done, dropped — and one that
 *  is not handed-out work later: in 15 minutes, in an hour, tomorrow
 *  morning, or with no set time. Handed-out work settles itself as it
 *  ends; once it no longer moves, the owner closes its matter. Each goes to
 *  the matter's own assistant. */
function ItemActions({
  item,
  bot,
  dispatch,
}: {
  item: ItemInfo
  bot: number | null
  dispatch: DispatchInfo | null
}) {
  const td = useTranslations("PersonalAgent.detail.item")
  const [acting, setActing] = useState(false)
  const settle = (
    act: "done" | "drop" | "later" | "snooze",
    until?: "15m" | "1h" | "tomorrow"
  ) => {
    setActing(true)
    const call =
      act === "snooze"
        ? personalAgentItemAct(bot, item.id, act, until)
        : personalAgentItemAct(bot, item.id, act)
    call
      .then(() => refreshActivity())
      .catch((e) => toast.error(toErrorMessage(e)))
      .finally(() => setActing(false))
  }
  const work = item.kind === "dispatch"
  if (!hasItemActions(item, dispatch)) return null
  const later =
    !work &&
    item.kind !== "when_mentioned" &&
    (item.waits_for !== "time" || item.due_at != null)
  // One set, each its icon before its word: done the main one, later (its
  // menu of when) outlined, dropped in the destructive tone.
  return (
    <>
      <Button
        size="sm"
        disabled={acting}
        onClick={() => settle("done")}
        data-pa-item-act="done"
      >
        <Check aria-hidden />
        {td("done")}
      </Button>
      {later ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              size="sm"
              variant="outline"
              disabled={acting}
              data-pa-item-act="later-menu"
            >
              <Clock aria-hidden />
              {td("later")}
              <ChevronDown aria-hidden className="-ms-0.5 opacity-60" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            {SNOOZE_CHOICES.map((c) => (
              <DropdownMenuItem
                key={c.until}
                onSelect={() => settle("snooze", c.until)}
                data-pa-item-act={`snooze-${c.until}`}
              >
                {td(c.label)}
              </DropdownMenuItem>
            ))}
            <DropdownMenuItem
              onSelect={() => settle("later")}
              data-pa-item-act="later"
            >
              {td("untimed")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
      <Button
        size="sm"
        variant="destructive"
        disabled={acting}
        onClick={() => settle("drop")}
        data-pa-item-act="drop"
      >
        <X aria-hidden />
        {td("drop")}
      </Button>
    </>
  )
}

/** What a row unfolds to (C3): who runs its work, how and where; what done
 *  looks like; how often its assistant answered for the owner; its matter's
 *  notes; the whole of an error; and the other ways in — its reminder's
 *  card, its acceptance check's session, its board task. Nothing: no ›. */
function useDetails({
  row,
  today,
  item,
  dispatch,
  scope,
}: {
  row: ActivityRow
  today: TodayRow | null
  item: ItemInfo | null
  dispatch: DispatchInfo | null
  scope: RowScope
}): ReactNode {
  const t = useTranslations("PersonalAgent")
  const tf = useTranslations("PersonalAgent.feed")
  const meta = useWorkMeta()
  const openWork = useOpenWork()
  const jumpTo = useJumpTo(scope.inDrawer)
  const lines: ReactNode[] = []
  if (dispatch) {
    const who = meta({
      mode: dispatch.mode,
      folder: dispatch.folder_name,
    })
    if (who) lines.push(<p key="who">{who}</p>)
    // The agent it ran on: a fact of the work, here only.
    lines.push(
      <p key="agent">
        <WorkAgentFact agentType={dispatch.work.agent_type} />
      </p>
    )
    if (dispatch.done_when?.trim()) {
      lines.push(
        <div key="done-when" data-pa-done-when>
          <p className="font-medium text-foreground/80">
            {t("dispatchCard.doneWhen")}
          </p>
          <p className="break-words whitespace-pre-line">
            {dispatch.done_when.trim()}
          </p>
        </div>
      )
    }
    if (dispatch.answered_for_you > 0) {
      lines.push(
        <AnsweredForYou key="answered" count={dispatch.answered_for_you} />
      )
    }
    if (dispatch.state === "failed" && dispatch.error?.trim()) {
      lines.push(
        <p
          key="error"
          className="font-mono break-words whitespace-pre-wrap text-red-700 dark:text-red-300"
          data-pa-row-error
        >
          {dispatch.error.trim()}
        </p>
      )
    }
  }
  if (item) {
    const summary = item.summary.trim()
    const title = today?.title.trim() ?? dispatch?.title.trim()
    if (summary && title && summary !== title) {
      lines.push(<p key="summary">{summary}</p>)
    }
    // What happens once it is done: a reminder's, a follow-up's — not
    // handed-out work's, which its assistant is told itself (B5).
    if (item.kind !== "dispatch" && item.on_done) {
      lines.push(
        <p key="on-done" data-pa-item-on-done>
          {t("items.onDone", { text: item.on_done })}
        </p>
      )
    }
  }
  const links: ReactNode[] = []
  const bot = row.bot_id
  // Its reminder's card: from another day's firing, or today's — not a
  // matter coming up, whose row is the message it came from.
  const card =
    row.card_row_id ?? (today?.kind === "reminder" ? today.row_id : null)
  // The row opens the message its matter came from; its reminder's card
  // here (C1): both ways in.
  if (bot != null && card != null) {
    links.push(
      <Button
        key="reminder"
        size="sm"
        variant="outline"
        onClick={() => jumpTo(bot, card)}
        data-pa-row-link="reminder"
      >
        {tf("viewReminder")}
      </Button>
    )
  }
  if (today?.check_dispatch_id != null) {
    const info = scope.dispatches.find((d) => d.id === today.check_dispatch_id)
    const target = workTargetOf(info)
    if (info && canOpenWork(target)) {
      links.push(
        <Button
          key="check"
          size="sm"
          variant="outline"
          onClick={() => openWork(target)}
          data-pa-row-link="check"
        >
          {tf("viewCheck")}
        </Button>
      )
    }
  }
  if (today?.kind === "acceptance" && today.task_id != null && scope.openTask) {
    const id = today.task_id
    const open = scope.openTask
    links.push(
      <Button
        key="task"
        size="sm"
        variant="outline"
        onClick={() => open(id)}
        data-pa-row-link="task"
      >
        {tf("openTask")}
      </Button>
    )
  }
  if (lines.length === 0 && links.length === 0) return null
  return (
    <div
      className="flex min-w-0 flex-col gap-2 text-xs leading-5 text-muted-foreground"
      data-pa-row-details
    >
      {lines}
      {links.length > 0 ? (
        <div className="flex flex-wrap gap-2">{links}</div>
      ) : null}
    </div>
  )
}

/** One row of the activity, as what it is. */
export function ActivityRowView({
  row,
  group,
  scope,
  flash,
}: {
  row: ActivityRow
  group: ActivityGroup
  scope: RowScope
  /** Just brought into view: marked for a moment. */
  flash: boolean
}) {
  const open = usePersonalAgentUi((s) => s.activityOpen[row.thing] ?? false)
  const setOpen = usePersonalAgentUi((s) => s.setActivityOpen)
  const onOpenChange = (o: boolean) => setOpen(row.thing, o)
  if (row.routine) {
    return (
      <RoutineRow
        r={row.routine}
        readOnly={scope.readOnly}
        open={open}
        onOpenChange={onOpenChange}
        flash={flash}
      />
    )
  }
  return (
    <ThingRow
      row={row}
      group={group}
      scope={scope}
      open={open}
      onOpenChange={onOpenChange}
      flash={flash}
    />
  )
}

function ThingRow({
  row,
  group,
  scope,
  open,
  onOpenChange,
  flash,
}: {
  row: ActivityRow
  group: ActivityGroup
  scope: RowScope
  open: boolean
  onOpenChange: (open: boolean) => void
  flash: boolean
}) {
  const today = row.today
  const item = row.item
  const dispatchId = today?.dispatch_id ?? item?.dispatch_id ?? null
  const dispatch =
    dispatchId != null
      ? (scope.dispatches.find((d) => d.id === dispatchId) ?? null)
      : null
  const details = useDetails({ row, today, item, dispatch, scope })
  // Only when it has any: a card with no buttons has no row of them.
  const actions =
    item && !scope.readOnly && hasItemActions(item, dispatch) ? (
      <ItemActions item={item} bot={row.bot_id} dispatch={dispatch} />
    ) : undefined
  const unfold = details ? (
    <UnfoldButton open={open} onOpenChange={onOpenChange} />
  ) : null
  const props = {
    open: open && details != null,
    details,
    unfold,
    flash,
    dispatch,
  }
  const shell = { ...props, row, scope, actions }
  if (today) return <TodayRowShell {...shell} today={today} group={group} />
  if (item && dispatch) return <DispatchRowShell {...shell} item={item} />
  if (item) return <ItemRowShell {...shell} item={item} />
  return null
}

/** What every row adds to its own: the › at its head's end, its task's
 *  strip, what it unfolds to at its foot, its key and its mark. Its work's
 *  [Stop] goes with its other buttons when it has any, at the end of its
 *  strip's line when not. */
function finish(
  props: PanelItemProps,
  {
    row,
    open,
    details,
    unfold,
    flash,
    dispatch,
  }: {
    row: ActivityRow
    open: boolean
    details: ReactNode
    unfold: ReactNode
    flash: boolean
    dispatch: DispatchInfo | null
  }
): PanelItemProps {
  const buttons = props.actions != null
  const strip = dispatch?.task ? (
    <TaskStrip d={dispatch} compact bot={row.bot_id} stop={!buttons} />
  ) : null
  const actions =
    buttons && dispatch?.task ? (
      <>
        {props.actions}
        <TaskStopButton d={dispatch} bot={row.bot_id} className="ms-auto" />
      </>
    ) : (
      props.actions
    )
  return {
    ...props,
    actions,
    unfold: unfold ?? undefined,
    details: open ? details : undefined,
    extra: strip ?? undefined,
    className: cn(
      "scroll-mt-12 transition-colors",
      flash && "bg-primary/10",
      props.className
    ),
    "data-pa-activity-row": row.key,
  } as PanelItemProps
}

interface ShellProps {
  row: ActivityRow
  scope: RowScope
  actions: ReactNode | undefined
  open: boolean
  details: ReactNode
  unfold: ReactNode
  flash: boolean
  dispatch: DispatchInfo | null
}

/** "Today"'s row of it, the matter's buttons and due line on it — opening,
 *  as the matter did, the message it came from. */
function TodayRowShell({
  today,
  group,
  ...p
}: ShellProps & { today: TodayRow; group: ActivityGroup }) {
  const dueNotes = useDueNotes()
  const matterTitle = useMatterTitle()
  const jumpTo = useJumpTo(p.scope.inDrawer)
  const item = p.row.item
  const bot = p.row.bot_id
  const origin =
    item && item.kind !== "dispatch" ? item.origin_timeline_id : null
  const ladder = p.dispatch?.ladder ?? null
  const props = useTodayRowProps({
    row: today,
    waiting: group === "needs",
    now: p.scope.now,
    onOpen:
      origin != null && bot != null
        ? () => jumpTo(bot, origin)
        : p.scope.opener(today),
    readOnly: p.scope.readOnly,
    actions: p.actions,
    // Its work's rung says where it stands: the row's own word for it
    // would say it again, or otherwise.
    chipSaysState: ladder != null,
  })
  const notes =
    item && item.kind !== "dispatch"
      ? [...(props.notes ?? []), ...dueNotes(item, p.scope.now)]
      : props.notes
  // Its matter's words as its title: codeg's in the page's language.
  const title =
    item && today.title.trim() === item.summary.trim()
      ? matterTitle(item)
      : props.title
  // Where its work stands on the ladder, as its card said it (a pull
  // request stuck on a conflict, not just "finished").
  const chip =
    props.chip ?? (ladder ? <LadderChip ladder={ladder} /> : undefined)
  return <PanelItem {...finish({ ...props, title, notes, chip }, p)} />
}

/** A matter's line under its title: its kind (or nothing, for work), whose
 *  on the primary's page, and that its assistant has it. */
function useMatterMeta(): (row: ActivityRow, item: ItemInfo) => string {
  const t = useTranslations("PersonalAgent")
  const tf = useTranslations("PersonalAgent.feed")
  const entries = useRoster()
  const botName = useBotName()
  return (row, item) => {
    const entry =
      row.bot_id != null ? entries?.find((e) => e.id === row.bot_id) : undefined
    const name =
      row.bot_id != null
        ? botName(entry ?? { id: row.bot_id, kind: "worker" })
        : ""
    const parts: string[] = []
    if (item.kind !== "dispatch") parts.push(t(`items.kind.${item.kind}`))
    // Its assistant has it: said as waiting on it, not that it is on it
    // now — the ledger cannot say that.
    if (item.waits_for === "agent" && name) {
      parts.push(tf("waitsAgent", { name }))
    } else if (name) {
      parts.push(name)
    }
    return parts.join(" · ")
  }
}

/** Handed-out work with no row of "today": who runs it, where it stands. */
function DispatchRowShell({ item, ...p }: ShellProps & { item: ItemInfo }) {
  const t = useTranslations("PersonalAgent")
  const openWork = useOpenWork()
  const matterMeta = useMatterMeta()
  const d = p.dispatch!
  const target = workTargetOf(d)
  const canOpen = canOpenWork(target)
  const error = d.state === "failed" ? d.error?.trim().split("\n")[0] : null
  const props: PanelItemProps = {
    media: <WorkGlyph mode={d.mode} size={ROW_AVATAR_SIZE} />,
    title: d.title,
    time: formatRelative(d.updated_at, p.scope.now),
    chip: <LadderChip ladder={d.ladder ?? null} />,
    meta: matterMeta(p.row, item) || undefined,
    // Why it failed, its first line; the whole of it unfolded.
    callout: error ? { tone: "error", mono: true, text: error } : null,
    onOpen: canOpen ? () => openWork(target) : null,
    openLabel: canOpen ? t("timeline.viewSession") : undefined,
    actions: p.actions,
  }
  return <PanelItem {...finish(props, p)} />
}

/** A reminder, a follow-up, a question: its kind's icon, when it is due,
 *  and the way to the message it came from. */
function ItemRowShell({ item, ...p }: ShellProps & { item: ItemInfo }) {
  const t = useTranslations("PersonalAgent")
  const td = useTranslations("PersonalAgent.detail.item")
  const dueNotes = useDueNotes()
  const matterMeta = useMatterMeta()
  const jumpTo = useJumpTo(p.scope.inDrawer)
  const matterTitle = useMatterTitle()
  const Icon =
    item.kind === "dispatch" ? ListTodo : (KIND_ICON[item.kind] ?? ListTodo)
  const origin = item.origin_timeline_id
  const bot = p.row.bot_id
  const props: PanelItemProps = {
    media: <PanelIcon icon={Icon} />,
    title: matterTitle(item),
    chip:
      item.at_due === "act" && item.due_at ? (
        <span
          className="shrink-0 rounded-full bg-muted px-1.5 py-px text-[0.625rem] leading-4 text-muted-foreground"
          data-pa-item-at-due="act"
        >
          {td("act")}
        </span>
      ) : undefined,
    time: formatRelative(item.updated_at, p.scope.now),
    meta: matterMeta(p.row, item),
    notes: dueNotes(item, p.scope.now),
    onOpen: origin != null && bot != null ? () => jumpTo(bot, origin) : null,
    openLabel: origin != null ? t("matters.origin") : undefined,
    actions: p.actions,
  }
  return <PanelItem {...finish(props, p)} />
}
