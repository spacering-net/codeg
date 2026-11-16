"use client"

/**
 * The personal agent page's side panel, under the window's top band as the
 * other full pages have it (the tasks' board). On top, who it is: its face,
 * alive, and its name, with the bell that says whether it notifies the
 * owner at the top's end; under them shadcn's tabs (10.1), the first open by
 * default — each tab of shadcn's pieces (`panel-section.tsx`):
 * - Activity: on the primary, "Today": every assistant's day in four groups
 *   (6.3, `today-section.tsx`); its open matters, as the workspace's task
 *   tab shows a board: sections by whom each piece waits on — the owner
 *   first, then the work still moving, what the agent has to pick up, what
 *   comes later — each piece once, as a card. A piece of handed-out work
 *   says where it stands on the PR ladder and opens its session in the
 *   drawer; a task carries its task card (8.5), and an entry whose work has
 *   ended (a pull request codeg does not follow yet) the owner closes there:
 *   done or dropped. A reminder, a follow-up or a question jumps to the
 *   message it came from, says when it is due and how it comes back, and the
 *   owner can settle it there: done, put off (15 minutes, an hour, tomorrow
 *   morning, or with no set time), dropped. Then its routines. The tab
 *   counts what waits on the owner.
 * - Output: what it made, newest first — the work that ended (tasks, the
 *   reports of the rest) and the documents it wrote in its working
 *   directory — filtered by kind.
 * - Workspace: the work running now, each as a small live view of its
 *   session; a screen with its face asleep on it when nothing runs.
 * - Stats: how it runs, as Session Details shows a conversation — what it
 *   runs on, its state, model and mode, its session (which opens), its
 *   connection, its working directory (copyable) — then folding cards: its
 *   context, the run log, the details; then its numbers: the last two weeks
 *   in four figures, then the charts.
 *
 * Its own panel rather than the workspace's aux panel, which a full-page
 * route closes. Its pieces are the workspace panel's own where they can be
 * (Session Details' property rows and sections).
 */

import {
  useEffect,
  useMemo,
  useState,
  type ComponentProps,
  type ReactNode,
} from "react"
import { useLocale, useTranslations } from "next-intl"
import {
  Bell,
  BellOff,
  ChevronDown,
  Ear,
  FileText,
  Forward,
  ListTodo,
  MessageCircleQuestionMark,
  MessagesSquare,
  Monitor,
  Package,
  Play,
  Settings2,
  SquareArrowOutUpRight,
  type LucideIcon,
} from "lucide-react"
import { toast } from "sonner"

import { SyncedSpinner } from "@/components/ui/synced-spinner"
import { AgentIcon } from "@/components/agent-icon"
import {
  PanelCard,
  PanelGroup,
  PanelIcon,
  PanelItem,
  PanelSection,
  type PanelTone,
} from "./panel-section"
import { CopyPropertyButton, PropertyRow } from "./property-row"
import { formatRelative } from "@/components/conversations/sidebar-conversation-grouping"
import {
  RankedBars,
  TrendChart,
  type RankedDatum,
  type TrendDatum,
} from "@/components/token-usage/charts"
import { MessageResponse } from "@/components/ai-elements/message"
import { LiveTranscriptView } from "@/components/message/live-transcript-view"
import { TaskTranscriptView } from "@/components/tasks/task-transcript-dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import { Progress } from "@/components/ui/progress"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Skeleton } from "@/components/ui/skeleton"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Toggle } from "@/components/ui/toggle"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { useAcpActions } from "@/contexts/acp-connections-context"
import { useBotId, usePersonalAgent } from "@/contexts/personal-agent-context"
import { useTasksView } from "@/contexts/tasks-view-context"
import {
  personalAgentDispatches,
  personalAgentItemAct,
  personalAgentItems,
  personalAgentOutputRead,
  personalAgentOutputs,
  personalAgentResumeAutoCompact,
  personalAgentRosterAct,
  personalAgentStats,
} from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"
import { formatTokenCount } from "@/lib/token-format"
import type {
  DispatchInfo,
  DispatchState,
  ItemInfo,
  ItemKind,
  PersonalAgentOutputDoc,
  PersonalAgentSnapshot,
  PersonalAgentStats,
  TimelineRow,
  WaitsFor,
} from "@/lib/types"
import { cn } from "@/lib/utils"
import {
  usePersonalAgentRoster,
  useRoster,
} from "@/stores/personal-agent-roster-store"
import { useToday } from "@/stores/personal-agent-today-store"
import {
  PERSONAL_AGENT_EVENTS,
  usePersonalAgentUi,
  type AuxTab,
} from "@/stores/personal-agent-ui-store"

import {
  canOpenWork,
  ExecutorAvatar,
  num,
  str,
  useBotLook,
  useOpenWork,
  usePageScope,
  useStatusWord,
  useWorkMeta,
  workTargetOf,
} from "./shared"

import { CheckLabel, DoneWhen } from "./acceptance-bits"
import { useActivityTranslate } from "./activity-text"
import { BotAvatar } from "./bot-avatar"
import { dueWhen, repeatText } from "./due-text"
import { AnsweredForYou } from "./event-card"
import { LadderChip, TaskStrip } from "./task-strip"
import { RoutinesSection } from "./routines-section"
import { TodaySection } from "./today-section"

/** Run-log lines the status tab lists. */
const RUN_LOG_LINES = 50
/** An executor's avatar on a work card, in px at 100% zoom: as a kind's
 *  icon tile. */
const CARD_AVATAR_SIZE = 20
/** The assistant's face at the head of the panel, in px at 100% zoom. */
const HEAD_AVATAR_SIZE = 64
/** Its face on the workspace's empty screen, in px at 100% zoom. */
const WORKSPACE_FACE = 44
/** The dispatches the work tab reads: enough for the ended list. */
const DISPATCH_PAGE = 200
/** Days the stats tab covers. */
const STATS_DAYS = 14
/** The panel's charts, in px: shorter than the token dashboard's. */
const CHART_HEIGHT = 148

const TABS: readonly AuxTab[] = ["activity", "output", "workspace", "stats"]

/** Work that has not ended. */
const MOVING: ReadonlySet<DispatchState> = new Set([
  "queued",
  "running",
  "waiting_input",
  "review",
])

/** The sections of the work tab, in order: who each piece waits on. */
type Group = WaitsFor | "none"
const GROUPS: Group[] = ["owner", "external", "agent", "time", "none"]

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

/** One open thing in the work tab: an entry of the ledger, with its
 *  dispatch when it is handed-out work — or a dispatch still moving that no
 *  open entry covers (its entry dropped). */
interface Matter {
  key: string
  item: ItemInfo | null
  dispatch: DispatchInfo | null
  group: Group
  at: string
}

/** Work waiting for review or an answer waits on the owner, whatever its
 *  entry says. */
function waitsOwner(state: DispatchState | null | undefined): boolean {
  return state === "waiting_input" || state === "review"
}

/** A read, and the assistant it is of (`null`: the primary). */
interface Of<T> {
  bot: number | null
  value: T
}

/** What was read for `bot`; `null` while only another one's is held. */
function ofBot<T>(read: Of<T> | null, bot: number | null): T | null {
  return read != null && read.bot === bot ? read.value : null
}

/** The open matters and the dispatches, loaded for the panel: the work tab
 *  lists them, the rail counts what waits on the owner. */
function useWork() {
  const { botId, itemVersion, dispatchVersion, dispatchById } =
    usePersonalAgent()
  // Each read kept with the assistant it is of: another one shown waits for
  // its own, never drawing the last one's.
  const [itemsOf, setItemsOf] = useState<Of<ItemInfo[]> | null>(null)
  const [dispatchesOf, setDispatchesOf] = useState<Of<DispatchInfo[]> | null>(
    null
  )
  useEffect(() => {
    let cancelled = false
    personalAgentItems("active", botId)
      .then((list) => {
        if (!cancelled) setItemsOf({ bot: botId, value: list })
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [itemVersion, dispatchVersion, botId])
  useEffect(() => {
    let cancelled = false
    personalAgentDispatches(null, DISPATCH_PAGE, null, botId)
      .then((list) => {
        if (!cancelled) setDispatchesOf({ bot: botId, value: list })
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [dispatchVersion, botId])
  const items = ofBot(itemsOf, botId)
  const dispatches = ofBot(dispatchesOf, botId)
  return useMemo(() => {
    if (items == null || dispatches == null) return null
    const byId = new Map(dispatches.map((d) => [d.id, d]))
    const covered = new Set<number>()
    const open: Matter[] = []
    for (const item of items) {
      const dispatch =
        item.dispatch_id != null
          ? (byId.get(item.dispatch_id) ??
            dispatchById.get(item.dispatch_id) ??
            null)
          : null
      if (item.dispatch_id != null) covered.add(item.dispatch_id)
      const state = dispatch?.state ?? item.dispatch_state
      open.push({
        key: `i${item.id}`,
        item,
        dispatch,
        group: waitsOwner(state) ? "owner" : (item.waits_for ?? "none"),
        at: dispatch?.updated_at ?? item.updated_at,
      })
    }
    for (const d of dispatches) {
      if (covered.has(d.id) || !MOVING.has(d.state)) continue
      open.push({
        key: `d${d.id}`,
        item: null,
        dispatch: d,
        group: waitsOwner(d.state) ? "owner" : "external",
        at: d.updated_at,
      })
    }
    const newest = (a: string, b: string) => Date.parse(b) - Date.parse(a)
    open.sort((a, b) => newest(a.at, b.at))
    const ended = dispatches
      .filter((d) => !covered.has(d.id) && !MOVING.has(d.state))
      .sort((a, b) =>
        newest(a.finished_at ?? a.updated_at, b.finished_at ?? b.updated_at)
      )
    return { open, ended }
  }, [items, dispatches, dispatchById])
}

/** The current time, a minute at a time: the cards' "3h" all read one
 *  clock, as the task tab's do. */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 60_000)
    return () => window.clearInterval(id)
  }, [])
  return now
}

export function PersonalAgentAuxPanel({
  snapshot,
  inDrawer = false,
}: {
  snapshot: PersonalAgentSnapshot
  /** In the narrow screen's drawer, whose close button sits at the top
   *  end. */
  inDrawer?: boolean
}) {
  const t = useTranslations("PersonalAgent.aux")
  const tabs = useTranslations("PersonalAgent.detail.tabs")
  const tab = usePersonalAgentUi((s) => s.auxTab)
  const setTab = usePersonalAgentUi((s) => s.setAuxTab)
  const work = useWork()
  const waiting = work?.open.filter((m) => m.group === "owner").length ?? 0
  return (
    <aside
      data-pa-aux
      aria-label={t("title")}
      className="flex h-full min-h-0 flex-col overflow-hidden"
    >
      <Tabs
        value={tab}
        onValueChange={(v) => setTab(v as AuxTab)}
        className="flex h-full min-h-0 flex-col gap-0"
      >
        <AuxHead snapshot={snapshot} inDrawer={inDrawer}>
          {/* shadcn's own tabs, the width of the panel: a word too long
              for a narrow one gives way at its end. */}
          <TabsList aria-label={t("title")} className="w-full">
            {TABS.map((value) => {
              const label = tabs(value)
              // What waits on the owner is in their activity: counted
              // there, for a pointer and a screen reader too.
              const count = value === "activity" ? waiting : 0
              const name =
                count > 0
                  ? `${label} · ${t("waiting", { count: waiting })}`
                  : label
              return (
                <TabsTrigger
                  key={value}
                  value={value}
                  title={name}
                  aria-label={name}
                  data-pa-aux-tab={value}
                  // Each as wide as its word, the rest shared: a longer
                  // word is not cut while the panel has room for it.
                  className="min-w-0 flex-auto px-1.5"
                >
                  <span className="min-w-0 truncate">{label}</span>
                  {count > 0 ? (
                    <Badge
                      aria-hidden
                      className="h-4 min-w-4 bg-amber-500/15 px-1 text-[0.625rem] text-amber-700 tabular-nums dark:bg-amber-400/15 dark:text-amber-300"
                    >
                      {count}
                    </Badge>
                  ) : null}
                </TabsTrigger>
              )
            })}
          </TabsList>
        </AuxHead>
        <TabsContent value="activity" className="mt-0 min-h-0 flex-1">
          <ActivityTab snapshot={snapshot} work={work} inDrawer={inDrawer} />
        </TabsContent>
        <TabsContent value="output" className="mt-0 min-h-0 flex-1">
          <OutputTab work={work} />
        </TabsContent>
        <TabsContent value="workspace" className="mt-0 min-h-0 flex-1">
          <WorkspaceTab snapshot={snapshot} work={work} />
        </TabsContent>
        <TabsContent value="stats" className="mt-0 min-h-0 flex-1">
          <StatsTab snapshot={snapshot} />
        </TabsContent>
      </Tabs>
    </aside>
  )
}

/** Who the panel is about, over its tabs: its face — alive, as on the
 *  roster, its star on the primary's — and its name; at the top's end
 *  (its start in the drawer, whose close button has the end) whether it
 *  notifies the owner. */
function AuxHead({
  snapshot,
  inDrawer,
  children,
}: {
  snapshot: PersonalAgentSnapshot
  inDrawer: boolean
  children: ReactNode
}) {
  const t = useTranslations("PersonalAgent")
  const { botId } = usePersonalAgent()
  const agent = snapshot.agent
  const name = agent?.name?.trim() || t("title")
  const look = useBotLook(agent?.id ?? null)
  return (
    <header
      data-pa-aux-head
      className="relative flex shrink-0 flex-col items-center gap-3 px-4 pt-7 pb-3"
    >
      {agent ? (
        <NotifyToggle
          snapshot={snapshot}
          className={cn("absolute top-2", inDrawer ? "start-2" : "end-2")}
        />
      ) : null}
      {agent ? (
        <BotAvatar
          avatar={agent.avatar}
          name={name}
          size={HEAD_AVATAR_SIZE}
          star={botId == null}
          look={look}
        />
      ) : null}
      <h2
        title={name}
        className="max-w-full truncate text-base leading-6 font-semibold"
      >
        {name}
      </h2>
      {children}
    </header>
  )
}

/** "Notify me" (10.10): whether it notifies the owner when it is done or
 *  waits for them — the roster's switch, a bell pressed while it does. */
function NotifyToggle({
  snapshot,
  className,
}: {
  snapshot: PersonalAgentSnapshot
  className?: string
}) {
  const t = useTranslations("PersonalAgent.detail")
  const { botId } = usePersonalAgent()
  const readOnly = snapshot.status.engine !== "here"
  const entry = usePersonalAgentRoster((s) =>
    s.entries?.find((e) => e.id === (snapshot.agent?.id ?? botId))
  )
  useRoster()
  const on = entry?.roster.notify ?? true
  const label = `${t("notify")} · ${on ? t("notifyOn") : t("notifyOff")}`
  return (
    <Toggle
      size="sm"
      pressed={on}
      disabled={readOnly || !entry}
      onPressedChange={(next) => {
        if (!entry) return
        void personalAgentRosterAct(entry.id, {
          act: "notify",
          on: next,
        }).catch((e) => toast.error(toErrorMessage(e)))
      }}
      aria-label={t("notify")}
      title={`${label}\n${t("notifyHint")}`}
      data-pa-detail-notify={on ? "on" : "off"}
      className={cn(
        "size-8 min-w-8 px-0 text-muted-foreground aria-pressed:bg-transparent aria-pressed:text-foreground hover:aria-pressed:bg-muted",
        className
      )}
    >
      {on ? <Bell aria-hidden /> : <BellOff aria-hidden />}
    </Toggle>
  )
}

/** A tab's body when it has nothing to show: shadcn's empty state on a
 *  soft tile — its icon, what that means and, when there is something to
 *  say, what would fill it. */
function EmptyState({
  icon: Icon,
  title,
  hint,
  children,
}: {
  icon: LucideIcon
  title: string
  hint?: string
  children?: ReactNode
}) {
  return (
    <Empty className="flex-none gap-3 rounded-2xl bg-muted/50 px-6 py-10">
      <EmptyHeader className="gap-1.5">
        {children ?? (
          <EmptyMedia variant="icon" className="mb-1 bg-background shadow-xs">
            <Icon className="size-5 text-muted-foreground" aria-hidden />
          </EmptyMedia>
        )}
        <EmptyTitle className="text-sm font-medium tracking-normal">
          {title}
        </EmptyTitle>
        {hint ? (
          <EmptyDescription className="text-xs/relaxed">
            {hint}
          </EmptyDescription>
        ) : null}
      </EmptyHeader>
    </Empty>
  )
}

/** A line that says a list is empty, on the items' soft ground. */
function NoneLine({ children, ...props }: ComponentProps<"p">) {
  return (
    <p
      className="rounded-2xl bg-muted/50 px-3 py-2.5 text-xs leading-5 text-muted-foreground"
      {...props}
    >
      {children}
    </p>
  )
}

// ── work ────────────────────────────────────────────────────────────────────

/** A section of the work tab, as the task tab draws its columns: its
 *  marker, its name and how many it holds — the count amber where the
 *  owner is waited on — folding. */
function WorkSection({
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
      strong={group === "owner"}
      data-pa-group={group}
    >
      {children}
    </PanelGroup>
  )
}

/** A piece of handed-out work: who runs it, titled as in the list, where it
 *  stands; opening its session in the drawer. */
function DispatchCard({
  d,
  notes,
  now,
  actions,
}: {
  d: DispatchInfo
  /** What its entry says beyond the title: how the agent sums it up now,
   *  what it will do once the work is done. */
  notes?: string[]
  now: number
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
          size={CARD_AVATAR_SIZE}
        />
      }
      title={d.title}
      chip={<LadderChip ladder={d.ladder ?? null} />}
      meta={[
        meta({
          executor: d.executor.name,
          mode: d.mode,
          folder: d.folder_name,
        }),
        formatRelative(d.updated_at, now),
      ]
        .filter(Boolean)
        .join(" · ")}
      notes={notes}
      onOpen={canOpen ? () => openWork(target) : null}
      openLabel={canOpen ? t("timeline.viewSession") : undefined}
      extra={
        d.task ||
        d.answered_for_you > 0 ||
        d.done_when ||
        d.check_for != null ? (
          <>
            {d.check_for != null ? (
              <CheckLabel round={d.check_round ?? null} via={null} />
            ) : null}
            {d.task ? <TaskStrip d={d} /> : null}
            {d.answered_for_you > 0 ? (
              <AnsweredForYou count={d.answered_for_you} className="mt-1.5" />
            ) : null}
            <DoneWhen text={d.done_when} className="mt-1.5" />
          </>
        ) : undefined
      }
      actions={actions}
    />
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
          size="xs"
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
          size="xs"
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
          size="xs"
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
      meta={[t(`items.kind.${item.kind}`), formatRelative(item.updated_at, now)]
        .filter(Boolean)
        .join(" · ")}
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

function MatterCard({
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
            size="xs"
            variant="outline"
            disabled={acting}
            onClick={() => settle("done")}
            data-pa-item-act="done"
          >
            {td("done")}
          </Button>
          <Button
            size="xs"
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

/** First paint: two section headers over ghost cards, on the real ones'
 *  insets. */
function WorkSkeleton() {
  return (
    <div className="flex flex-col gap-4" aria-hidden>
      {[2, 1].map((cards, section) => (
        <div key={section} className="flex flex-col gap-1.5">
          <Skeleton className="h-4 w-24 rounded-md" />
          {Array.from({ length: cards }, (_, i) => (
            <Skeleton key={i} className="h-16 w-full rounded-2xl" />
          ))}
        </div>
      ))}
    </div>
  )
}

/** The open matters, by whom each waits on: the activity's middle. */
function WorkBody({
  work,
  inDrawer,
}: {
  work: ReturnType<typeof useWork>
  inDrawer: boolean
}) {
  const t = useTranslations("PersonalAgent")
  const now = useNow()
  if (work == null) return <WorkSkeleton />
  const { open } = work
  if (open.length === 0) return <NoneLine>{t("matters.noneOpen")}</NoneLine>
  return (
    <div className="flex flex-col gap-3">
      {GROUPS.map((g) => {
        const list = open.filter((m) => m.group === g)
        if (list.length === 0) return null
        return (
          <WorkSection
            key={g}
            group={g}
            label={t(`items.waits.${g}`)}
            count={list.length}
          >
            {list.map((m) => (
              <MatterCard key={m.key} m={m} inDrawer={inDrawer} now={now} />
            ))}
          </WorkSection>
        )
      })}
    </div>
  )
}

// ── status ──────────────────────────────────────────────────────────────────

/** A path in one line that, when it does not fit, gives way in its middle:
 *  the folder it starts from and its last name stay, which is where two
 *  working directories tell apart. Left to right in any language — under
 *  RTL its leading slash would otherwise jump to the far end. */
function PathValue({ path }: { path: string }) {
  const cut = path.replace(/[\\/]+$/, "").search(/[^\\/]+$/)
  const head = cut > 0 ? path.slice(0, cut) : ""
  const tail = cut > 0 ? path.slice(cut) : path
  return (
    <span dir="ltr" title={path} className="flex min-w-0 font-mono">
      <span className="min-w-0 truncate">{head}</span>
      <span className="shrink-0">{tail}</span>
    </span>
  )
}

/** How full the context is: shadcn's progress bar, amber past the
 *  auto-compaction threshold, which is a tick across it. */
function ContextMeter({
  percent,
  threshold,
}: {
  percent: number | null
  threshold: number
}) {
  const ratio = percent == null ? 0 : Math.min(100, Math.max(0, percent))
  const hot = percent != null && threshold > 0 && percent >= threshold
  return (
    <div className="relative">
      <Progress
        value={percent == null ? null : Math.round(ratio)}
        // shadcn's bar draws the value but leaves it off the root.
        aria-valuenow={percent == null ? undefined : Math.round(ratio)}
        className={cn(
          // Filled from the reading's start in either direction.
          "h-1.5 bg-foreground/10 rtl:-scale-x-100",
          hot && "[&>[data-slot=progress-indicator]]:bg-amber-500"
        )}
      />
      {threshold > 0 && threshold < 100 ? (
        <span
          aria-hidden
          className="absolute -top-1 h-3.5 w-0.5 -translate-x-1/2 rounded-full bg-foreground/50 ring-2 ring-card rtl:translate-x-1/2"
          style={{ insetInlineStart: `${threshold}%` }}
        />
      ) : null}
    </div>
  )
}

/** A marker row in words, for the run log. */
function useRunLogLine(): (row: TimelineRow) => string {
  const t = useTranslations("PersonalAgent.runLog")
  const tr = useTranslations("PersonalAgent.reason")
  return (row) => {
    const data = row.data
    switch (str(data, "marker")) {
      case "segment_start":
        return t("newSession", {
          agent: str(data, "agent") ?? "",
          reason: tr(`${str(data, "reason") ?? "first"}` as "first"),
        })
      case "pending_switch":
        return t("pendingSwitch", {
          reason: tr(`${str(data, "reason") ?? "manual"}` as "manual"),
        })
      case "reconnected":
        return t("reconnected")
      case "options_changed":
        return t("optionsChanged")
      case "compaction": {
        const status = str(data, "status") ?? "ok"
        const who = str(data, "initiator") ?? "auto"
        const before = num(data, "before_percent")
        const after = num(data, "after_percent")
        const range =
          before != null && after != null
            ? t("range", {
                before: Math.round(before),
                after: Math.round(after),
              })
            : ""
        const said = t(`compaction.${status}` as "compaction.ok", {
          who: t(`by.${who}` as "by.auto"),
          range,
        })
        // Notes taken before it (7.7).
        return str(data, "notes") === "ok" ? `${said}${t("notesFirst")}` : said
      }
      case "compaction_paused":
        return t("compactionPaused")
      case "overflow":
        return str(data, "action") === "new_segment"
          ? t("overflowNewSession")
          : t("overflowCompact")
      case "turn_canceled":
        return t("turnStopped")
      case "turn_failed":
        return t("turnFailed", { error: str(data, "error") ?? "" })
      case "turn_interrupted":
        return str(data, "why") === "preempted"
          ? t("turnPreempted")
          : t("turnInterrupted")
      case "workdir_changed":
        return t("workdirChanged", { path: str(data, "path") ?? "" })
      default:
        return row.body
    }
  }
}

/** A date and time, short. */
function useWhen(): (iso: string) => string {
  const locale = useLocale()
  return (iso) =>
    new Date(iso).toLocaleString(locale, {
      month: "numeric",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    })
}

/** How it runs, as Session Details shows a conversation: a row per
 *  property — what it runs on (the way to change it at the row's end), its
 *  state, its model and mode, its session (which opens), when that started,
 *  its connection, its working directory (copyable). Who it is is the
 *  panel's head. */
function StatusRows({
  snapshot,
  readOnly,
}: {
  snapshot: PersonalAgentSnapshot
  readOnly: boolean
}) {
  const t = useTranslations("PersonalAgent.status")
  const tPage = useTranslations("PersonalAgent")
  const to = useTranslations("PersonalAgent.overview")
  const tr = useTranslations("PersonalAgent.reason")
  const word = useStatusWord()
  const when = useWhen()
  const { agent, status } = snapshot
  const seg = status.segment
  const model = agent?.label_snapshot.options.find(
    (o) => o.id === "model"
  )?.value_label
  const mode = agent?.label_snapshot.mode
  // The dot beside its state: at work, waiting on the owner, idle and
  // connected, or neither.
  const dot =
    status.engine !== "here" || !status.connected
      ? "bg-muted-foreground/40"
      : status.pending_permission || status.pending_question
        ? "bg-amber-500"
        : status.turn
          ? "bg-primary motion-safe:animate-pulse"
          : "bg-emerald-500"
  return (
    <div data-pa-status className="min-w-0">
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 text-xs">
        <PropertyRow label={t("agent")}>
          {agent ? (
            <span aria-hidden className="inline-flex shrink-0">
              <AgentIcon agentType={agent.agent_type} className="size-3.5" />
            </span>
          ) : null}
          <span className="min-w-0 truncate">
            {agent?.label_snapshot.agent ?? "—"}
          </span>
          {readOnly ? null : (
            <Button
              size="icon-xs"
              variant="ghost"
              className="-me-1 ms-auto shrink-0 text-muted-foreground"
              title={to("editBrain")}
              aria-label={to("editBrain")}
              onClick={() =>
                usePersonalAgentUi.getState().openBotPage("identity")
              }
            >
              <Settings2 aria-hidden />
            </Button>
          )}
        </PropertyRow>
        {word ? (
          <PropertyRow label={t("state")}>
            <span
              aria-hidden
              className={cn("size-1.5 shrink-0 rounded-full", dot)}
            />
            <span className="min-w-0 truncate">{word}</span>
          </PropertyRow>
        ) : null}
        <PropertyRow label={t("model")}>
          <span className="min-w-0 truncate" title={model ?? undefined}>
            {model || "—"}
          </span>
        </PropertyRow>
        {mode ? (
          <PropertyRow label={t("mode")}>
            <span className="min-w-0 truncate" title={mode}>
              {mode}
            </span>
          </PropertyRow>
        ) : null}
        <PropertyRow label={t("session")}>
          <span className="min-w-0 truncate">
            {seg
              ? t("segmentValue", {
                  seq: seg.seq,
                  reason: tr(seg.start_reason),
                })
              : t("noSegment")}
          </span>
          {seg?.conversation_id != null ? (
            <Button
              size="icon-xs"
              variant="ghost"
              className="-me-1 ms-auto shrink-0 text-muted-foreground"
              title={tPage("viewSession")}
              aria-label={tPage("viewSession")}
              onClick={() =>
                window.dispatchEvent(
                  new Event(PERSONAL_AGENT_EVENTS.openSession)
                )
              }
            >
              <SquareArrowOutUpRight aria-hidden />
            </Button>
          ) : null}
        </PropertyRow>
        {seg ? (
          <PropertyRow label={t("started")}>
            <span className="min-w-0 truncate tabular-nums">
              {when(seg.started_at)}
            </span>
          </PropertyRow>
        ) : null}
        <PropertyRow label={t("connection")}>
          <span
            className="min-w-0 truncate"
            title={status.connected ? t("connected") : t("disconnected")}
          >
            {status.connected ? t("connected") : t("disconnected")}
          </span>
        </PropertyRow>
        {status.workdir ? (
          <PropertyRow label={t("workdir")}>
            <PathValue path={status.workdir} />
            <CopyPropertyButton
              text={status.workdir}
              copyLabel={t("copyPath")}
              copiedLabel={t("copied")}
            />
          </PropertyRow>
        ) : null}
      </dl>
      {seg?.pending_reason ? (
        <p className="mt-1.5 rounded-lg bg-amber-500/10 px-2.5 py-1.5 text-xs leading-5 text-amber-800 dark:text-amber-200">
          {t("pendingValue", { reason: tr(seg.pending_reason) })}
        </p>
      ) : null}
    </div>
  )
}

/** The context: how full it is, against the threshold where codeg compacts
 *  it, what the reading comes from, the last compaction — and, when
 *  compaction stopped working for this session, the way to resume it. */
function ContextSection({
  snapshot,
  readOnly,
}: {
  snapshot: PersonalAgentSnapshot
  readOnly: boolean
}) {
  const t = useTranslations("PersonalAgent.status")
  const to = useTranslations("PersonalAgent.overview")
  const when = useWhen()
  const [resuming, setResuming] = useState(false)
  const botId = useBotId()
  const { status } = snapshot
  const seg = status.segment
  const last = status.last_compaction
  const percent = status.usage?.percent ?? null
  return (
    <PanelCard
      fold="status.context"
      title={t("context")}
      summary={percent == null ? "—" : `${Math.round(percent)}%`}
    >
      <div className="flex flex-col gap-1">
        <ContextMeter
          percent={percent}
          threshold={status.auto_compact_percent}
        />
        <p className="mt-2 text-xs leading-5 text-muted-foreground">
          {status.auto_compact_percent > 0
            ? t("threshold", { percent: status.auto_compact_percent })
            : t("thresholdOff")}
        </p>
        <p className="text-xs leading-5 text-muted-foreground">
          {status.usage
            ? t("usageValue", {
                percent: Math.round(status.usage.percent),
                source: t(`usageSource.${status.usage.source}`),
              })
            : status.connected
              ? t("usageUnknown")
              : t("usageUnknownOffline")}
        </p>
        {last ? (
          <p className="text-xs leading-5 text-muted-foreground">
            {to("lastCompaction", {
              when: when(last.at),
              outcome: t(`compactionStatus.${last.status}`),
              range:
                last.before_percent != null && last.after_percent != null
                  ? ` · ${Math.round(last.before_percent)}% → ${Math.round(last.after_percent)}%`
                  : "",
            })}
          </p>
        ) : null}
        {seg?.auto_compact_paused ? (
          <div className="mt-1.5 flex items-center justify-between gap-2 rounded-lg bg-amber-500/10 px-2.5 py-1.5 text-xs">
            <span className="text-amber-800 dark:text-amber-200">
              {t("paused")}
            </span>
            <Button
              variant="outline"
              size="xs"
              className="gap-1 bg-background"
              disabled={resuming || readOnly}
              onClick={() => {
                setResuming(true)
                personalAgentResumeAutoCompact(botId)
                  .catch((e) => toast.error(toErrorMessage(e)))
                  .finally(() => setResuming(false))
              }}
            >
              <Play aria-hidden />
              {t("resume")}
            </Button>
          </div>
        ) : null}
      </div>
    </PanelCard>
  )
}

/** The run log: what happened to the agent's sessions, newest first, a line
 *  each and when. */
function RunLogSection() {
  const t = useTranslations("PersonalAgent.runLog")
  const to = useTranslations("PersonalAgent.overview")
  const when = useWhen()
  const { rows } = usePersonalAgent()
  const line = useRunLogLine()
  const markers = useMemo(
    () =>
      rows
        .filter((r) => r.kind === "marker")
        .slice(-RUN_LOG_LINES)
        .reverse(),
    [rows]
  )
  return (
    <PanelCard
      fold="status.runLog"
      title={to("runLog")}
      summary={markers.length}
    >
      {markers.length === 0 ? (
        <p className="text-xs leading-5 text-muted-foreground">{t("empty")}</p>
      ) : (
        <ul className="flex flex-col divide-y divide-border/50">
          {markers.map((m) => (
            <li key={m.id} className="flex min-w-0 items-start gap-3 py-1.5">
              <span className="min-w-0 flex-1 text-xs leading-5 break-words text-foreground/85">
                {line(m)}
              </span>
              <span className="shrink-0 text-2xs leading-5 text-muted-foreground tabular-nums">
                {when(m.created_at)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </PanelCard>
  )
}

/** One label and its value in the details: the value wraps, as some run
 *  long (an error). */
function DetailRow({
  label,
  children,
}: {
  label: string
  children: ReactNode
}) {
  return (
    <div className="col-span-2 grid grid-cols-subgrid items-baseline border-b border-border/50 py-1.5 last:border-b-0">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 leading-5 break-words text-foreground/85">
        {children}
      </dd>
    </div>
  )
}

function DetailsSection({ snapshot }: { snapshot: PersonalAgentSnapshot }) {
  const t = useTranslations("PersonalAgent.status")
  const to = useTranslations("PersonalAgent.overview")
  const { status } = snapshot
  const seg = status.segment
  const check = status.last_check
  return (
    <PanelCard fold="status.details" title={to("details")}>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 text-xs">
        {seg?.handoff_size != null ? (
          <DetailRow label={t("handoff")}>
            {t("handoffSize", { size: seg.handoff_size })}
            {seg.handoff_trimmed ? ` · ${t("handoffTrimmed")}` : ""}
          </DetailRow>
        ) : null}
        {seg ? (
          <DetailRow label={t("compactions")}>
            {t("compactionCounts", {
              auto: seg.compactions_auto,
              manual: seg.compactions_manual,
              agent: seg.compactions_agent,
            })}
          </DetailRow>
        ) : null}
        <DetailRow label={to("command")}>
          {status.compact_command ? (
            <span dir="ltr" className="font-mono">
              {status.compact_command}
            </span>
          ) : (
            t("noCommand")
          )}
        </DetailRow>
        {check ? (
          <DetailRow label={t("lastCheck")}>
            {t(`check.${check.outcome}`)}
          </DetailRow>
        ) : null}
        <DetailRow label={t("queued")}>
          {t("queuedValue", {
            messages: status.queued_messages,
            events: status.pending_events,
          })}
        </DetailRow>
        <DetailRow label={t("dispatchSlots")}>
          {status.dispatch_limit > 0
            ? t("slotsValue", {
                running: status.dispatch_running,
                limit: status.dispatch_limit,
                queued: status.dispatch_queued,
              })
            : t("slotsUnlimited", {
                running: status.dispatch_running,
                queued: status.dispatch_queued,
              })}
        </DetailRow>
        <DetailRow label={t("engine")}>
          {status.engine === "here" ? t("engineHere") : t("engineElsewhere")}
        </DetailRow>
        {status.last_error ? (
          <DetailRow label={t("lastError")}>
            <span className="text-red-700 dark:text-red-300">
              {status.last_error}
            </span>
          </DetailRow>
        ) : null}
      </dl>
    </PanelCard>
  )
}

// ── stats ───────────────────────────────────────────────────────────────────

/** One figure of the last two weeks: what it counts, how many, what it is
 *  made of. */
function Figure({
  label,
  value,
  sub,
}: {
  label: string
  value: string
  sub?: string
}) {
  return (
    <div className="ws-msg-card min-w-0 rounded-2xl bg-muted/50 px-3 py-2.5">
      <dt className="truncate text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 text-xl leading-7 font-semibold tracking-tight text-foreground tabular-nums">
        {value}
      </dd>
      {sub ? (
        <dd className="truncate text-2xs leading-4 text-muted-foreground">
          {sub}
        </dd>
      ) : null}
    </div>
  )
}

/** The context-usage curve: the reading before each delivery and the two
 *  ends of each compaction, with each new session as a break. */
function UsageCurve({ stats }: { stats: PersonalAgentStats }) {
  const t = useTranslations("PersonalAgent.data")
  const points = stats.usage
  if (points.length < 2) {
    return (
      <p className="py-4 text-center text-xs text-muted-foreground">
        {t("noUsage")}
      </p>
    )
  }
  const w = 320
  const h = 110
  const t0 = new Date(points[0].at).getTime()
  const t1 = new Date(points[points.length - 1].at).getTime()
  const span = Math.max(1, t1 - t0)
  const x = (at: string) => ((new Date(at).getTime() - t0) / span) * (w - 8) + 4
  const y = (p: number) =>
    h - 6 - (Math.min(100, Math.max(0, p)) / 100) * (h - 12)
  // One polyline per segment: a new session starts from an empty context.
  const lines: string[] = []
  let current: string[] = []
  for (const p of points) {
    if (p.kind === "segment_start") {
      if (current.length > 1) lines.push(current.join(" "))
      current = []
      continue
    }
    current.push(`${x(p.at).toFixed(1)},${y(p.percent).toFixed(1)}`)
  }
  if (current.length > 1) lines.push(current.join(" "))
  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      className="h-28 w-full"
      role="img"
      aria-label={t("usageCurve")}
    >
      {[25, 50, 75].map((g) => (
        <line
          key={g}
          x1={0}
          x2={w}
          y1={y(g)}
          y2={y(g)}
          stroke="var(--border)"
          strokeWidth={0.5}
        />
      ))}
      {lines.map((pts, i) => (
        <polyline
          key={i}
          points={pts}
          fill="none"
          stroke="var(--tu-accent)"
          strokeWidth={1.5}
        />
      ))}
      {points
        .filter((p) => p.kind === "compaction_after")
        .map((p, i) => (
          <circle
            key={`c${i}`}
            cx={x(p.at)}
            cy={y(p.percent)}
            r={2.5}
            fill="var(--color-amber-500, #f59e0b)"
          />
        ))}
      {points
        .filter((p) => p.kind === "segment_start")
        .map((p, i) => (
          <line
            key={`s${i}`}
            x1={x(p.at)}
            x2={x(p.at)}
            y1={4}
            y2={h - 4}
            stroke="var(--muted-foreground)"
            strokeDasharray="2 2"
            strokeWidth={0.75}
          />
        ))}
    </svg>
  )
}

/** A chart of the stats tab, as a folding card: its title and total in
 *  its header. */
const ChartSection = PanelCard

/** Its numbers: the stats tab's second part. */
function StatsBody() {
  const t = useTranslations("PersonalAgent.data")
  const locale = useLocale()
  const tm = useTranslations("PersonalAgent.mode")
  const { botId, dispatchVersion } = usePersonalAgent()
  const [statsOf, setStatsOf] = useState<Of<PersonalAgentStats> | null>(null)
  useEffect(() => {
    let cancelled = false
    personalAgentStats(STATS_DAYS, botId)
      .then((s) => {
        if (!cancelled) setStatsOf({ bot: botId, value: s })
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [dispatchVersion, botId])
  const stats = ofBot(statsOf, botId)
  if (!stats) {
    return (
      <div className="grid grid-cols-2 gap-2" aria-hidden>
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-[4.75rem] rounded-2xl" />
        ))}
      </div>
    )
  }
  const sum = (pick: (d: PersonalAgentStats["days"][number]) => number) =>
    stats.days.reduce((n, d) => n + pick(d), 0)
  const owner = sum((d) => d.owner_messages)
  const replies = sum((d) => d.replies)
  const handed = sum(
    (d) => d.dispatches_task + d.dispatches_chat + d.dispatches_session
  )
  const completed = sum((d) => d.dispatches_completed)
  const failed = sum((d) => d.dispatches_failed)
  const agentTokens = sum((d) => d.agent_tokens)
  const dispatchTokens = sum((d) => d.dispatch_tokens)
  const synced = stats.tokens_synced_at != null
  const label = (date: string) => date.slice(5)
  const interactions: TrendDatum[] = stats.days.map((d) => ({
    key: d.date,
    label: label(d.date),
    tooltipLabel: d.date,
    cache: d.replies,
    fresh: d.owner_messages,
    detail: [],
  }))
  const dispatches: TrendDatum[] = stats.days.map((d) => ({
    key: d.date,
    label: label(d.date),
    tooltipLabel: d.date,
    cache: d.dispatches_completed,
    fresh: Math.max(
      0,
      d.dispatches_task +
        d.dispatches_chat +
        d.dispatches_session -
        d.dispatches_completed
    ),
    detail: [
      { label: tm("task"), value: String(d.dispatches_task) },
      { label: tm("chat"), value: String(d.dispatches_chat) },
      { label: tm("session"), value: String(d.dispatches_session) },
      { label: t("failed"), value: String(d.dispatches_failed) },
    ],
  }))
  const tokens: TrendDatum[] = stats.days.map((d) => ({
    key: d.date,
    label: label(d.date),
    tooltipLabel: d.date,
    cache: d.dispatch_tokens,
    fresh: d.agent_tokens,
    detail: [],
  }))
  const totalDispatches = stats.executors.reduce((n, e) => n + e.dispatches, 0)
  const executors: RankedDatum[] = stats.executors.map((e) => ({
    key: String(e.assistant_id),
    label: e.name,
    value: e.dispatches,
    share: totalDispatches > 0 ? e.dispatches / totalDispatches : null,
    hint: t("completedHint", { count: e.completed }),
  }))
  return (
    <div className="tu-viz flex min-w-0 flex-col gap-2 text-sm">
      <dl className="grid grid-cols-2 gap-2">
        <Figure
          label={t("figure.conversation")}
          value={String(owner + replies)}
          sub={t("figure.conversationSub", { owner, replies })}
        />
        <Figure
          label={t("figure.dispatches")}
          value={String(handed)}
          sub={t("figure.dispatchesSub", { completed, failed })}
        />
        <Figure
          label={t("figure.completion")}
          value={
            handed > 0 ? `${Math.round((completed / handed) * 100)}%` : "—"
          }
          sub={t("figure.completionSub")}
        />
        <Figure
          label={t("figure.tokens")}
          value={synced ? formatTokenCount(agentTokens + dispatchTokens) : "—"}
          sub={
            synced
              ? t("figure.tokensSub", {
                  agent: formatTokenCount(agentTokens),
                  dispatch: formatTokenCount(dispatchTokens),
                })
              : t("figure.tokensUnsynced")
          }
        />
      </dl>
      <ChartSection
        fold="stats.interactions"
        title={t("interactions")}
        summary={owner + replies}
      >
        <TrendChart
          data={interactions}
          label={t("interactions")}
          cacheLabel={t("replies")}
          freshLabel={t("messages")}
          emptyLabel={t("empty")}
          height={CHART_HEIGHT}
        />
      </ChartSection>
      <ChartSection
        fold="stats.dispatches"
        title={t("dispatches")}
        summary={handed}
      >
        <TrendChart
          data={dispatches}
          label={t("dispatches")}
          cacheLabel={t("completed")}
          freshLabel={t("other")}
          emptyLabel={t("empty")}
          height={CHART_HEIGHT}
        />
      </ChartSection>
      <ChartSection
        fold="stats.executors"
        title={t("executors")}
        summary={stats.executors.length}
      >
        <RankedBars data={executors} emptyLabel={t("empty")} />
      </ChartSection>
      <ChartSection
        fold="stats.tokens"
        title={t("tokens")}
        summary={synced ? formatTokenCount(agentTokens + dispatchTokens) : "—"}
      >
        <TrendChart
          data={tokens}
          label={t("tokens")}
          cacheLabel={t("dispatchTokens")}
          freshLabel={t("agentTokens")}
          emptyLabel={t("empty")}
          height={CHART_HEIGHT}
        />
        <p className="pt-1 text-[0.6875rem] leading-4 text-muted-foreground">
          {synced
            ? t("syncedAt", {
                when: new Date(stats.tokens_synced_at!).toLocaleString(locale),
              })
            : t("notSynced")}
        </p>
      </ChartSection>
      <ChartSection fold="stats.usage" title={t("usageCurve")} summary={null}>
        <UsageCurve stats={stats} />
      </ChartSection>
    </div>
  )
}

// ── the tabs ────────────────────────────────────────────────────────────────

/** A tab's body, scrolled: its parts one under another. */
function TabBody({ children }: { children: ReactNode }) {
  return (
    <ScrollArea className="h-full">
      <div className="flex min-w-0 flex-col gap-6 px-4 pt-3 pb-6">
        {children}
      </div>
    </ScrollArea>
  )
}

/** What it is about: on the primary, today; its open matters, its
 *  routines. */
function ActivityTab({
  snapshot,
  work,
  inDrawer,
}: {
  snapshot: PersonalAgentSnapshot
  work: ReturnType<typeof useWork>
  inDrawer: boolean
}) {
  const t = useTranslations("PersonalAgent.detail")
  const { botId } = usePersonalAgent()
  const readOnly = snapshot.status.engine !== "here"
  // "Today" is the primary's: every assistant's, held while it shows.
  const today = useToday(botId == null)
  return (
    <TabBody>
      {botId == null ? (
        <TodaySection
          title={t("sections.today")}
          today={today}
          inDrawer={inDrawer}
          readOnly={readOnly}
        />
      ) : null}
      <PanelSection
        title={t("sections.matters")}
        count={work?.open.length ?? null}
        data-pa-detail="matters"
      >
        <WorkBody work={work} inDrawer={inDrawer} />
      </PanelSection>
      <RoutinesSection title={t("sections.routines")} readOnly={readOnly} />
    </TabBody>
  )
}

/** How it runs — what on, its context, its run log and details — then its
 *  numbers. */
function StatsTab({ snapshot }: { snapshot: PersonalAgentSnapshot }) {
  const td = useTranslations("PersonalAgent.data")
  const ts = useTranslations("PersonalAgent.status")
  const readOnly = snapshot.status.engine !== "here"
  return (
    <TabBody>
      {/* How it runs: its rows under the tabs, no heading of their own,
          then the folding cards. */}
      <section
        className="flex min-w-0 flex-col gap-2.5 text-sm"
        data-pa-detail="status"
      >
        {readOnly ? (
          <p className="rounded-xl bg-amber-500/10 px-3 py-2 text-xs leading-5 text-amber-800 dark:text-amber-200">
            {ts("elsewhere")}
          </p>
        ) : null}
        <StatusRows snapshot={snapshot} readOnly={readOnly} />
        <ContextSection snapshot={snapshot} readOnly={readOnly} />
        <RunLogSection />
        <DetailsSection snapshot={snapshot} />
      </section>
      <PanelSection
        title={td("range", { days: STATS_DAYS })}
        data-pa-detail="data"
      >
        <StatsBody />
      </PanelSection>
    </TabBody>
  )
}

type OutputKind = "all" | "tasks" | "reports" | "docs"
const OUTPUT_KINDS: readonly OutputKind[] = ["all", "tasks", "reports", "docs"]

/** What it made, newest first: the work that ended — a task's card, the
 *  report of the rest — and the documents it wrote in its working
 *  directory. */
function OutputTab({ work }: { work: ReturnType<typeof useWork> }) {
  const t = useTranslations("PersonalAgent.detail.output")
  const tabs = useTranslations("PersonalAgent.detail.tabs")
  const { botId, dispatchVersion } = usePersonalAgent()
  const now = useNow()
  const [kind, setKind] = useState<OutputKind>("all")
  const [docsOf, setDocsOf] = useState<Of<PersonalAgentOutputDoc[]> | null>(
    null
  )
  const [readingOf, setReading] = useState<{
    bot: number | null
    path: string
    text: string | null
  } | null>(null)
  useEffect(() => {
    let live = true
    personalAgentOutputs(botId)
      .then((list) => {
        if (live) setDocsOf({ bot: botId, value: list })
      })
      .catch(() => {
        if (live) setDocsOf({ bot: botId, value: [] })
      })
    return () => {
      live = false
    }
  }, [botId, dispatchVersion])
  const docs = ofBot(docsOf, botId)
  // A document of the assistant shown, not of the last one.
  const reading = readingOf?.bot === botId ? readingOf : null
  const open = (path: string) => {
    setReading({ bot: botId, path, text: null })
    personalAgentOutputRead(botId, path)
      .then((text) => setReading({ bot: botId, path, text }))
      .catch((e) => {
        setReading(null)
        toast.error(toErrorMessage(e))
      })
  }
  const ended = work?.ended ?? []
  const tasks = ended.filter((d) => d.mode === "task")
  const reports = ended.filter((d) => d.mode !== "task")
  type Shown =
    | { at: string; key: string; dispatch: DispatchInfo }
    | { at: string; key: string; doc: PersonalAgentOutputDoc }
  const shown: Shown[] = [
    ...(kind === "all" || kind === "tasks" ? tasks : []).map((d) => ({
      at: d.finished_at ?? d.updated_at,
      key: `d${d.id}`,
      dispatch: d,
    })),
    ...(kind === "all" || kind === "reports" ? reports : []).map((d) => ({
      at: d.finished_at ?? d.updated_at,
      key: `d${d.id}`,
      dispatch: d,
    })),
    ...(kind === "all" || kind === "docs" ? (docs ?? []) : []).map((doc) => ({
      at: doc.modified_at,
      key: `f${doc.path}`,
      doc,
    })),
  ].sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Which kind: shadcn's toggle group, a pill each. */}
      <div className="shrink-0 px-4 pt-3 pb-2">
        <ToggleGroup
          type="single"
          size="sm"
          spacing={1}
          value={kind}
          onValueChange={(v) => {
            if (v) setKind(v as OutputKind)
          }}
          aria-label={tabs("output")}
          className="flex-wrap"
        >
          {OUTPUT_KINDS.map((k) => (
            <ToggleGroupItem
              key={k}
              value={k}
              data-pa-output-kind={k}
              className="h-7 min-w-0 px-2.5 text-xs font-normal text-muted-foreground data-[state=on]:font-medium data-[state=on]:text-foreground"
            >
              <span className="truncate">{t(k)}</span>
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-1.5 px-4 pt-1 pb-6">
          {work == null || docs == null ? (
            <WorkSkeleton />
          ) : shown.length === 0 ? (
            <EmptyState icon={Package} title={t("empty")} />
          ) : (
            shown.map((x) =>
              "dispatch" in x ? (
                <DispatchCard key={x.key} d={x.dispatch} now={now} />
              ) : (
                <PanelItem
                  key={x.key}
                  media={<PanelIcon icon={FileText} />}
                  title={x.doc.path}
                  meta={t("docEdited", {
                    when: formatRelative(x.doc.modified_at, now),
                  })}
                  onOpen={() => open(x.doc.path)}
                />
              )
            )
          )}
        </div>
      </ScrollArea>
      <Dialog
        open={reading != null}
        onOpenChange={(o) => (o ? null : setReading(null))}
      >
        <DialogContent className="max-h-[80vh] sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle className="truncate font-mono text-sm">
              {reading?.path}
            </DialogTitle>
          </DialogHeader>
          <div className="min-h-0 overflow-y-auto">
            {reading?.text == null ? (
              <SyncedSpinner
                small
                className="mx-auto my-6 size-4 text-muted-foreground"
              />
            ) : /\.(md|markdown)$/i.test(reading.path) ? (
              <MessageResponse>{reading.text}</MessageResponse>
            ) : (
              <pre className="text-xs whitespace-pre-wrap">{reading.text}</pre>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}

/** The states a dispatch's conversation streams in. */
const STREAMING: ReadonlySet<DispatchState> = new Set([
  "running",
  "waiting_input",
])

/** A chat or session dispatch's conversation, live: its connection
 *  attached (hydrated, forward only) while the preview is shown, as the work
 *  drawer does. */
function ConversationPreview({ d }: { d: DispatchInfo }) {
  const { attachDelegationChild, detachDelegationChild } = useAcpActions()
  const agentType = d.executor.agent_type
  const liveId = STREAMING.has(d.state) ? d.connection_id : null
  const [attachId, setAttachId] = useState<string | null>(liveId)
  if (liveId !== null && liveId !== attachId) setAttachId(liveId)
  useEffect(() => {
    if (attachId == null || agentType == null) return
    attachDelegationChild({
      connectionId: attachId,
      parentConnectionId: attachId,
      parentToolUseId: `personal-agent-dispatch-${d.id}`,
      agentType,
      hydrate: true,
    })
    return () => detachDelegationChild(attachId)
  }, [attachId, agentType, d.id, attachDelegationChild, detachDelegationChild])
  if (d.conversation_id == null || agentType == null) return null
  return (
    <LiveTranscriptView
      conversationId={d.conversation_id}
      connectionId={attachId}
      agentType={agentType}
    />
  )
}

/** A task dispatch's session, live, from the board's task. */
function TaskPreview({ taskId }: { taskId: number }) {
  const { tasks } = useTasksView()
  const task = tasks.find((x) => x.id === taskId) ?? null
  if (!task || task.conversation_id == null) return null
  return <TaskTranscriptView task={task} />
}

/** The work running now, each as a small live view of its session; an
 *  empty screen when nothing runs. While the drawer shows one of them, the previews stand
 *  aside: one surface follows a connection at a time. */
function WorkspaceTab({
  snapshot,
  work,
}: {
  snapshot: PersonalAgentSnapshot
  work: ReturnType<typeof useWork>
}) {
  const t = useTranslations("PersonalAgent.detail.workspace")
  const tPage = useTranslations("PersonalAgent")
  const openWork = useOpenWork()
  const agent = snapshot.agent
  const name = agent?.name?.trim() || tPage("title")
  const drawerOpen = usePersonalAgentUi((s) => s.workOpen)
  const running = (work?.open ?? [])
    .map((m) => m.dispatch)
    .filter((d): d is DispatchInfo => d != null && STREAMING.has(d.state))
  if (work == null) {
    return (
      <div className="px-4 pt-3">
        <WorkSkeleton />
      </div>
    )
  }
  // A screen with nothing on it, its face asleep on it as over the tabs;
  // whose screen it is under it.
  if (running.length === 0) {
    return (
      <div data-pa-workspace-empty className="flex flex-col gap-2 px-4 pt-3">
        <EmptyState icon={Monitor} title={t("empty")} hint={t("emptyHint")}>
          {agent ? (
            <EmptyMedia className="mb-1">
              <BotAvatar
                avatar={agent.avatar}
                name={name}
                size={WORKSPACE_FACE}
                look="sleeping"
              />
            </EmptyMedia>
          ) : null}
        </EmptyState>
        <p className="text-center text-xs text-muted-foreground">
          {t("whose", { name })}
        </p>
      </div>
    )
  }
  return (
    <ScrollArea className="h-full">
      <div className="flex flex-col gap-3 px-4 pt-3 pb-6">
        {running.map((d) => {
          const target = workTargetOf(d)
          return (
            <Card
              key={d.id}
              data-pa-workspace-item={d.id}
              className="ws-msg-card min-w-0 gap-0 py-0"
            >
              <div className="flex items-center gap-2 border-b border-border/60 px-3 py-2">
                <ExecutorAvatar
                  id={d.executor.assistant_id}
                  name={d.executor.name}
                  size={CARD_AVATAR_SIZE}
                />
                <span className="min-w-0 flex-1 truncate text-[0.8125rem] font-medium">
                  #{d.id} {d.title}
                </span>
                <LadderChip ladder={d.ladder ?? null} />
                {canOpenWork(target) ? (
                  <Button
                    size="xs"
                    variant="ghost"
                    onClick={() => openWork(target)}
                  >
                    {t("open")}
                  </Button>
                ) : null}
              </div>
              {drawerOpen ? null : (
                <div
                  data-pa-workspace-preview={d.id}
                  className="pointer-events-none h-56 overflow-hidden text-xs [&_*]:select-none"
                >
                  {d.mode === "task" ? (
                    d.work_task_id != null ? (
                      <TaskPreview taskId={d.work_task_id} />
                    ) : null
                  ) : (
                    <ConversationPreview d={d} />
                  )}
                </div>
              )}
            </Card>
          )
        })}
      </div>
    </ScrollArea>
  )
}
