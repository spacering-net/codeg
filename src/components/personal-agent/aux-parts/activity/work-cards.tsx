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
  Ear,
  Forward,
  ListTodo,
  MessageCircleQuestionMark,
  MessagesSquare,
  type LucideIcon,
} from "lucide-react"
import { formatRelative } from "@/components/conversations/sidebar-conversation-grouping"
import { Button } from "@/components/ui/button"
import type {
  ActivityRow,
  DispatchInfo,
  ItemInfo,
  ItemKind,
  TodayRow,
} from "@/lib/types"
import { cn } from "@/lib/utils"
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
  useOpenWork,
  useWorkMeta,
  workTargetOf,
} from "../../shared"
import { useActivityTranslate } from "../../activity-text"
import { repeatText } from "../../due-text"
import { AnsweredForYou } from "../../event-card"
import { LadderChip, TaskStopButton, TaskStrip } from "../../task-strip"
import { useTodayRowProps, type Opener } from "../../today-section"
import { peerName, useWaited, useWhen } from "../../matter-text"
import {
  hasItemActions,
  MatterActions,
  timeAhead,
  useRowBotName,
  useUndoMatter,
} from "./matter-actions"

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
    // Who it waits on is said on its line: the title is what was written.
    if (words?.key === "waitingAnswer") return words.text
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
      <MatterActions
        row={row}
        item={item}
        group={group}
        dispatch={dispatch}
        now={scope.now}
        inDrawer={scope.inDrawer}
      />
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
  if (today?.kind === "matter_closed")
    return <MatterClosedShell {...shell} today={today} />
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
 *  as the matter did, the message it came from. A matter's row says who
 *  has it and how long, as its own row would. */
function TodayRowShell({
  today,
  group,
  ...p
}: ShellProps & { today: TodayRow; group: ActivityGroup }) {
  const matterTitle = useMatterTitle()
  const matterLine = useMatterLine()
  const jumpTo = useJumpTo(p.scope.inDrawer)
  const item = p.row.item
  const bot = p.row.bot_id
  const matter = item && item.kind !== "dispatch" ? item : null
  const origin = matter ? matter.origin_timeline_id : null
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
  const line = matter ? matterLine(p.row, matter, p.scope.now) : null
  // Its matter's words as its title: codeg's in the page's language.
  const title =
    item && today.title.trim() === item.summary.trim()
      ? matterTitle(item)
      : props.title
  // Where its work stands on the ladder, as its card said it (a pull
  // request stuck on a conflict, not just "finished").
  const chip =
    props.chip ?? (ladder ? <LadderChip ladder={ladder} /> : undefined)
  const shown: PanelItemProps = line
    ? {
        ...props,
        title,
        chip,
        meta: line.meta,
        time: undefined,
        callout: line.callout ?? props.callout,
      }
    : { ...props, title, chip }
  return <PanelItem {...finish(shown, p)} />
}

/** A matter's line under its title (C1): who has it, whether it waits on
 *  the owner, and how long — "阿福在等研发回复 · 已等 3 分钟" — and, for a
 *  question whose answer's turn did not finish, the box that says so. */
function useMatterLine(): (
  row: ActivityRow,
  item: ItemInfo,
  now: number
) => { meta: string; callout: PanelItemProps["callout"] } {
  const t = useTranslations("PersonalAgent.matter.meta")
  const tw = useActivityTranslate()
  const locale = useLocale()
  const nameOf = useRowBotName()
  const waited = useWaited()
  const when = useWhen()
  return (row, item, now) => {
    const name = nameOf(row.bot_id)
    const wait = waited(item.created_at, now)
    const plain = (meta: string) => ({ meta, callout: null })
    if (item.kind === "when_mentioned" && item.mention) {
      const m = item.mention
      return plain(
        t("mention", {
          name,
          words: m.keywords.map((k) => `“${k}”`).join(tw("due.repeat.sep")),
          times: m.times,
          max: m.max_times,
          until: new Date(m.expires_at).toLocaleDateString(locale, {
            month: "short",
            day: "numeric",
          }),
        })
      )
    }
    if (item.kind === "message") {
      return plain(
        t("message", { name, peer: peerName(item) || t("someone"), wait })
      )
    }
    if (item.kind === "question") {
      if (item.answer_state === "linked" && item.waits_for === "agent")
        return plain(t("answered", { name }))
      if (item.answer_state === "interrupted")
        return {
          meta: t("asked", { name }),
          callout: { tone: "wait", text: t("interrupted", { name }) },
        }
    }
    if (item.due_at && timeAhead(item, now)) {
      const at = when(item.due_at)
      if (item.repeat) {
        const rule = repeatText(tw, item.repeat, now, locale)
        return plain(t("repeats", { name, rule, when: at }))
      }
      return plain(
        item.at_due === "act"
          ? t("willDo", { name, when: at })
          : t("willRemind", { name, when: at })
      )
    }
    if (item.due_at && item.waits_for === "owner") {
      const late = (now - Date.parse(item.due_at)) / 1000
      const at = when(item.due_at)
      return plain(
        late >= 60
          ? t("remindsLate", { name, when: at, late: waited(item.due_at, now) })
          : t("reminds", { name, when: at })
      )
    }
    if (item.waits_for === "time" && !item.due_at) return plain(t("setAside"))
    switch (item.waits_for) {
      case "agent":
        return plain(t("following", { name, wait }))
      case "external":
        return plain(t("external", { name, wait }))
      default:
        return plain(
          item.kind === "question"
            ? t("asks", { name, wait })
            : t("needsYou", { name, wait })
        )
    }
  }
}

/** Handed-out work's line under its title: whose, on the primary's page. */
function useWorkLine(): (row: ActivityRow) => string {
  const nameOf = useRowBotName()
  return (row) => nameOf(row.bot_id)
}

/** Handed-out work with no row of "today": who runs it, where it stands. */
function DispatchRowShell({ item, ...p }: ShellProps & { item: ItemInfo }) {
  const t = useTranslations("PersonalAgent")
  const openWork = useOpenWork()
  const workLine = useWorkLine()
  const d = p.dispatch!
  const target = workTargetOf(d)
  const canOpen = canOpenWork(target)
  const error = d.state === "failed" ? d.error?.trim().split("\n")[0] : null
  void item
  const props: PanelItemProps = {
    media: <WorkGlyph mode={d.mode} size={ROW_AVATAR_SIZE} />,
    title: d.title,
    time: formatRelative(d.updated_at, p.scope.now),
    chip: <LadderChip ladder={d.ladder ?? null} />,
    meta: workLine(p.row) || undefined,
    // Why it failed, its first line; the whole of it unfolded.
    callout: error ? { tone: "error", mono: true, text: error } : null,
    onOpen: canOpen ? () => openWork(target) : null,
    openLabel: canOpen ? t("timeline.viewSession") : undefined,
    actions: p.actions,
  }
  return <PanelItem {...finish(props, p)} />
}

/** The icon of a matter's kind, its kind's name for whoever cannot see it
 *  (not in its words: the line says who has it, not what kind it is). */
function MatterIcon({ kind }: { kind: ItemKind }) {
  const t = useTranslations("PersonalAgent.items.kind")
  const Icon = kind === "dispatch" ? ListTodo : (KIND_ICON[kind] ?? ListTodo)
  return (
    <span role="img" aria-label={t(kind)} title={t(kind)} className="contents">
      <PanelIcon icon={Icon} />
    </span>
  )
}

/** A reminder, a follow-up, a question: its kind's icon, who has it and
 *  how long, and the way to the message it came from. */
function ItemRowShell({ item, ...p }: ShellProps & { item: ItemInfo }) {
  const t = useTranslations("PersonalAgent")
  const td = useTranslations("PersonalAgent.detail.item")
  const matterLine = useMatterLine()
  const jumpTo = useJumpTo(p.scope.inDrawer)
  const matterTitle = useMatterTitle()
  const origin = item.origin_timeline_id
  const bot = p.row.bot_id
  const line = matterLine(p.row, item, p.scope.now)
  const props: PanelItemProps = {
    media: <MatterIcon kind={item.kind} />,
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
    meta: line.meta,
    callout: line.callout,
    onOpen: origin != null && bot != null ? () => jumpTo(bot, origin) : null,
    openLabel: origin != null ? t("matters.origin") : undefined,
    actions: p.actions,
  }
  return <PanelItem {...finish(props, p)} />
}

/** A matter settled today (C1, "done today"): what it was, who settled it
 *  and how — and, the owner's act on the panel, [Undo] while it can be. */
function MatterClosedShell({ today, ...p }: ShellProps & { today: TodayRow }) {
  const t = useTranslations("PersonalAgent.matter")
  const tt = useTranslations("PersonalAgent.today")
  const locale = useLocale()
  const nameOf = useRowBotName()
  const undoMatter = useUndoMatter()
  const jumpTo = useJumpTo(p.scope.inDrawer)
  const [acting, setActing] = useState(false)
  const bot = today.bot_id
  const name = nameOf(bot)
  const peer = today.peer?.name?.trim() || t("meta.someone")
  const time = new Date(today.at).toLocaleTimeString(locale, {
    hour: "2-digit",
    minute: "2-digit",
  })
  const by = today.closed_by
  const how = today.closed_how
  const key = ((): string => {
    if (by === "owner") {
      if (how === "withdrawn") return "withdrawn"
      if (how === "stopped_waiting") return "stoppedWaiting"
      if (how === "dropped") return "dropped"
      return "done"
    }
    if (by === "agent") return how === "dropped" ? "agentDropped" : "agentDone"
    switch (how) {
      case "answered":
        return "answered"
      case "replied":
        return "replied"
      case "gone":
        return "gone"
      case "plan_canceled":
        return "planCanceled"
      case "used_up":
        return "usedUp"
      case "expired":
        return "expired"
      default:
        return "ended"
    }
  })()
  const kind = (today.state ?? "reminder") as ItemKind
  const title =
    kind === "message"
      ? (messageMatterWords(today.title)?.text ?? today.title)
      : today.title
  const undo = today.matter_undo
  const itemId = today.item_id
  const action =
    !p.scope.readOnly && undo != null && itemId != null ? (
      <Button
        size="sm"
        variant="outline"
        disabled={acting}
        onClick={() => {
          setActing(true)
          void undoMatter(bot, itemId, undo).finally(() => setActing(false))
        }}
        data-pa-today-act="matter-undo"
      >
        {tt("undo")}
      </Button>
    ) : null
  const target = today.row_id
  const props: PanelItemProps = {
    media: <MatterIcon kind={kind} />,
    title,
    meta: t(`closed.${key}` as "closed.done", { name, peer, time }),
    onOpen: target != null && bot != null ? () => jumpTo(bot, target) : null,
    openLabel: target != null ? tt("open") : undefined,
    action,
    "data-pa-today-row": today.kind,
  } as PanelItemProps
  return <PanelItem {...finish(props, p)} />
}
