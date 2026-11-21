"use client"

/** The activity's matters as cards — handed-out work, a reminder, a
 *  follow-up, a question — and the ways to settle them from the panel. */

import { useState, type ReactNode } from "react"
import { useLocale, useTranslations } from "next-intl"
import {
  Bell,
  ChevronDown,
  ChevronRight,
  Ear,
  Forward,
  ListTodo,
  MessageCircleQuestionMark,
  MessagesSquare,
  type LucideIcon,
} from "lucide-react"
import { toast } from "sonner"
import { formatRelative } from "@/components/conversations/sidebar-conversation-grouping"
import { Button } from "@/components/ui/button"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { usePersonalAgent } from "@/contexts/personal-agent-context"
import { personalAgentItemAct } from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"
import type { DispatchInfo, ItemInfo, ItemKind } from "@/lib/types"
import { usePersonalAgentUi } from "@/stores/personal-agent-ui-store"

import {
  PanelGroup,
  PanelIcon,
  PanelItem,
  type PanelTone,
} from "../../panel-section"
import {
  canOpenWork,
  ExecutorAvatar,
  useOpenWork,
  usePageScope,
  useWorkMeta,
  workTargetOf,
} from "../../shared"
import { CheckLabel } from "../../acceptance-bits"
import { useActivityTranslate } from "../../activity-text"
import { dueWhen, repeatText } from "../../due-text"
import { AnsweredForYou } from "../../event-card"
import { LadderChip, TaskStrip } from "../../task-strip"
import { MOVING, type Group, type Matter } from "../use-work"

/** An executor's avatar leading a row, in px at 100% zoom: as a kind's
 *  icon tile. */
export const ROW_AVATAR_SIZE = 24

/** A section's marker, as the task tab marks its columns: what waits on the
 *  owner amber, what moves the theme's colour. */
const GROUP_TONE: Record<Group, PanelTone> = {
  owner: "amber",
  external: "primary",
  agent: "violet",
  time: "muted",
  none: "faint",
}

/** The icon of a matter that is not handed-out work. */
const KIND_ICON: Record<Exclude<ItemKind, "dispatch">, LucideIcon> = {
  reminder: Bell,
  followup: Forward,
  question: MessageCircleQuestionMark,
  message: MessagesSquare,
  when_mentioned: Ear,
}

/** A section of the work tab, as the task tab draws its columns: its
 *  marker, its name and how many it holds — the count amber where the
 *  owner is waited on — folding. */
export function WorkSection({
  group,
  label,
  count,
  children,
}: {
  group: Group
  label: string
  count: number
  children: ReactNode
}) {
  return (
    <PanelGroup
      fold={`work.${group}`}
      tone={GROUP_TONE[group]}
      label={label}
      count={count}
      data-pa-group={group}
    >
      {children}
    </PanelGroup>
  )
}

/** A piece of handed-out work: who runs it, titled as in the list, where it
 *  stands; opening its session in the drawer. */
export function DispatchCard({
  d,
  notes,
  now,
  time,
  actions,
}: {
  d: DispatchInfo
  /** What its entry says beyond the title: how the agent sums it up now,
   *  what it will do once the work is done. */
  notes?: string[]
  now: number
  /** When, as the list it is in says it: how long ago by default. */
  time?: string
  /** Settling its entry, once the work no longer moves. */
  actions?: ReactNode
}) {
  const t = useTranslations("PersonalAgent")
  const openWork = useOpenWork()
  const meta = useWorkMeta()
  const target = workTargetOf(d)
  const canOpen = canOpenWork(target)
  return (
    <PanelItem
      media={
        <ExecutorAvatar
          id={d.executor.assistant_id}
          name={d.executor.name}
          size={ROW_AVATAR_SIZE}
        />
      }
      title={d.title}
      time={time ?? formatRelative(d.updated_at, now)}
      chip={<LadderChip ladder={d.ladder ?? null} />}
      meta={meta({
        executor: d.executor.name,
        mode: d.mode,
        folder: d.folder_name,
      })}
      // Why it failed, in a red box.
      callout={
        d.state === "failed" && d.error?.trim()
          ? { tone: "error", mono: true, text: d.error.trim() }
          : null
      }
      notes={notes}
      onOpen={canOpen ? () => openWork(target) : null}
      openLabel={canOpen ? t("timeline.viewSession") : undefined}
      extra={
        d.task ||
        d.answered_for_you > 0 ||
        d.done_when?.trim() ||
        d.check_for != null ? (
          <div className="flex min-w-0 flex-col gap-2">
            {d.check_for != null ? (
              <CheckLabel round={d.check_round ?? null} />
            ) : null}
            <DoneWhenFold text={d.done_when} />
            {d.task ? <TaskStrip d={d} compact /> : null}
            {d.answered_for_you > 0 ? (
              <AnsweredForYou count={d.answered_for_you} />
            ) : null}
          </div>
        ) : undefined
      }
      actions={actions}
    />
  )
}

/** What done looks like (7.5), folded under its label: a quiet bar that
 *  opens to the words the assistant wrote. */
function DoneWhenFold({ text }: { text: string | null | undefined }) {
  const t = useTranslations("PersonalAgent.dispatchCard")
  const body = text?.trim()
  if (!body) return null
  return (
    <Collapsible data-pa-done-when className="min-w-0">
      <CollapsibleTrigger className="group/done relative z-10 flex h-8 w-full min-w-0 items-center gap-1.5 rounded-lg bg-muted px-2.5 text-start text-xs font-medium text-foreground/80 transition-colors outline-none hover:bg-muted/70 focus-visible:ring-2 focus-visible:ring-ring/50 data-[state=open]:rounded-b-none">
        <ChevronRight
          aria-hidden
          className="size-3.5 shrink-0 text-muted-foreground transition-transform group-data-[state=open]/done:rotate-90 rtl:-scale-x-100 rtl:group-data-[state=open]/done:rotate-90"
        />
        <span className="min-w-0 truncate">{t("doneWhen")}</span>
      </CollapsibleTrigger>
      <CollapsibleContent className="rounded-b-lg bg-muted px-2.5 pb-2.5 text-xs leading-5 break-words whitespace-pre-line text-muted-foreground">
        {body}
      </CollapsibleContent>
    </Collapsible>
  )
}

/** The way to settle a matter on the panel: done, dropped, or — for one
 *  that is not handed-out work — later, or put off until `until`. */
function useSettle(item: ItemInfo | null) {
  const { botId } = usePersonalAgent()
  const [acting, setActing] = useState(false)
  const settle = (
    act: "done" | "drop" | "later" | "snooze",
    until?: "15m" | "1h" | "tomorrow"
  ) => {
    if (!item) return
    setActing(true)
    const call =
      act === "snooze"
        ? personalAgentItemAct(botId, item.id, act, until)
        : personalAgentItemAct(botId, item.id, act)
    call
      .catch((e) => toast.error(toErrorMessage(e)))
      .finally(() => setActing(false))
  }
  return { acting, settle }
}

/** When a matter is due, in a few words: due, overdue, reminded — and how
 *  it comes back when it repeats. Nothing for one with no due time. */
function useDueNotes(): (item: ItemInfo, now: number) => string[] {
  const tw = useActivityTranslate()
  const t = useTranslations("PersonalAgent.items")
  const locale = useLocale()
  return (item, now) => {
    // Brought up by a mention (6.8): its words, its times, its last day.
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

/** [Later], as a menu: in 15 minutes, in an hour, tomorrow morning, or
 *  with no set time (it waits on time). */
function LaterMenu({
  disabled,
  onSnooze,
  onLater,
}: {
  disabled: boolean
  onSnooze: (until: "15m" | "1h" | "tomorrow") => void
  onLater: () => void
}) {
  const td = useTranslations("PersonalAgent.detail.item")
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          size="sm"
          variant="ghost"
          disabled={disabled}
          data-pa-item-act="later-menu"
        >
          {td("later")}
          <ChevronDown className="size-3" aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        {SNOOZE_CHOICES.map((c) => (
          <DropdownMenuItem
            key={c.until}
            onSelect={() => onSnooze(c.until)}
            data-pa-item-act={`snooze-${c.until}`}
          >
            {td(c.label)}
          </DropdownMenuItem>
        ))}
        <DropdownMenuItem onSelect={onLater} data-pa-item-act="later">
          {td("untimed")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** A reminder, a follow-up or a question: its kind's icon, and the way to
 *  the message it came from. */
function ItemCard({
  item,
  inDrawer,
  now,
}: {
  item: ItemInfo
  inDrawer: boolean
  now: number
}) {
  const t = useTranslations("PersonalAgent")
  const td = useTranslations("PersonalAgent.detail.item")
  const { jumpTo, readOnly } = usePageScope()
  const setAuxOpen = usePersonalAgentUi((s) => s.setAuxOpen)
  const { acting, settle } = useSettle(item)
  const dueNotes = useDueNotes()
  const Icon =
    item.kind === "dispatch" ? ListTodo : (KIND_ICON[item.kind] ?? ListTodo)
  const origin = item.origin_timeline_id
  const actions =
    readOnly || item.kind === "dispatch" ? null : (
      <>
        <Button
          size="sm"
          variant="outline"
          disabled={acting}
          onClick={() => settle("done")}
          data-pa-item-act="done"
        >
          {td("done")}
        </Button>
        {item.kind !== "when_mentioned" &&
        (item.waits_for !== "time" || item.due_at != null) ? (
          <LaterMenu
            disabled={acting}
            onSnooze={(until) => settle("snooze", until)}
            onLater={() => settle("later")}
          />
        ) : null}
        <Button
          size="sm"
          variant="ghost"
          disabled={acting}
          className="text-muted-foreground"
          onClick={() => settle("drop")}
          data-pa-item-act="drop"
        >
          {td("drop")}
        </Button>
      </>
    )
  return (
    <PanelItem
      media={<PanelIcon icon={Icon} />}
      title={item.summary}
      chip={
        item.at_due === "act" && item.due_at ? (
          <span
            className="shrink-0 rounded-full bg-muted px-1.5 py-px text-[0.625rem] leading-4 text-muted-foreground"
            data-pa-item-at-due="act"
          >
            {td("act")}
          </span>
        ) : undefined
      }
      time={formatRelative(item.updated_at, now)}
      meta={t(`items.kind.${item.kind}`)}
      notes={[
        ...dueNotes(item, now),
        ...(item.on_done ? [t("items.onDone", { text: item.on_done })] : []),
      ]}
      onOpen={
        origin != null
          ? () => {
              jumpTo(origin)
              // The drawer would cover the message it jumped to.
              if (inDrawer) setAuxOpen(false)
            }
          : null
      }
      openLabel={origin != null ? t("matters.origin") : undefined}
      actions={actions}
    />
  )
}

export function MatterCard({
  m,
  inDrawer,
  now,
}: {
  m: Matter
  inDrawer: boolean
  now: number
}) {
  const t = useTranslations("PersonalAgent")
  const td = useTranslations("PersonalAgent.detail.item")
  const { readOnly } = usePageScope()
  const { acting, settle } = useSettle(m.item)
  if (m.dispatch) {
    const summary = m.item?.summary?.trim()
    const onDone = m.item?.on_done ?? m.dispatch.on_done
    const notes = [
      summary && summary !== m.dispatch.title ? summary : null,
      onDone ? t("items.onDone", { text: onDone }) : null,
    ].filter((n): n is string => n != null)
    // Handed-out work settles itself as it ends — but for a pull request
    // codeg does not follow yet, which the owner closes once merged.
    const settled = m.item != null && !MOVING.has(m.dispatch.state)
    const actions =
      settled && !readOnly ? (
        <>
          <Button
            size="sm"
            variant="outline"
            disabled={acting}
            onClick={() => settle("done")}
            data-pa-item-act="done"
          >
            {td("done")}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={acting}
            className="text-muted-foreground"
            onClick={() => settle("drop")}
            data-pa-item-act="drop"
          >
            {td("drop")}
          </Button>
        </>
      ) : undefined
    return (
      <DispatchCard d={m.dispatch} notes={notes} now={now} actions={actions} />
    )
  }
  return m.item ? (
    <ItemCard item={m.item} inDrawer={inDrawer} now={now} />
  ) : null
}
