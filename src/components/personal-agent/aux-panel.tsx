"use client"

/**
 * The personal agent page's side panel, laid out as the workspace's own aux
 * panel is (`layout/aux-panel.tsx`): the open tab's name in a strip across
 * the top, its content under it, and the tabs as an icon rail down the
 * panel's end edge — on a narrow screen's drawer, a row of tabs under a
 * line. Three tabs, the first open by default:
 * - Status, as Session Details shows a conversation: the agent as a card —
 *   who it is, what it runs on, its session, its working directory — then
 *   folding sections: its context, the run log, the details.
 * - Work, as the workspace's task tab shows a board: sections by whom each
 *   piece waits on — the owner first, then the work still moving, what the
 *   agent has to pick up, what comes later — each piece once, as a card, and
 *   the work that ended, folded. A piece of handed-out work opens its
 *   session in the drawer; a reminder, a follow-up or a question jumps to
 *   the message it came from. The rail counts what waits on the owner.
 * - Stats: the last two weeks in four figures, then the charts, each a
 *   folding section.
 *
 * On the desktop the panel reaches the window's top edge, its strip in the
 * band the page's title is in, as the workspace's panel has it: the strip
 * keeps the window's corner buttons clear (`reserve`).
 *
 * Its own panel rather than the workspace's aux panel, which a full-page
 * route closes. Its pieces are the workspace panel's own where they can be
 * (the rail's classes, Session Details' property rows and sections).
 */

import { useEffect, useMemo, useState, type ReactNode } from "react"
import { useLocale, useTranslations } from "next-intl"
import {
  Bell,
  ChartPie,
  ChevronDown,
  CircleGauge,
  ClipboardList,
  Forward,
  ListTodo,
  Loader2,
  MessageCircleQuestionMark,
  Play,
  Settings2,
  SquareArrowOutUpRight,
  type LucideIcon,
} from "lucide-react"
import { Tabs as TabsPrimitive } from "radix-ui"
import { toast } from "sonner"

import { AgentIcon } from "@/components/agent-icon"
import { AssistantAvatar } from "@/components/assistants/assistant-avatar"
import {
  CopyPropertyButton,
  PropertyRow,
} from "@/components/conversations/session-details-content"
import {
  AUX_RAIL_CLASS,
  AUX_RAIL_TRIGGER_CLASS,
} from "@/components/layout/aux-panel-tab-rail"
import { ChromeReserve } from "@/components/layout/chrome-reserve"
import { InsightsSection } from "@/components/layout/session-details-insights"
import { formatRelative } from "@/components/conversations/sidebar-conversation-grouping"
import {
  RankedBars,
  TrendChart,
  type RankedDatum,
  type TrendDatum,
} from "@/components/token-usage/charts"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Skeleton } from "@/components/ui/skeleton"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { useBotId, usePersonalAgent } from "@/contexts/personal-agent-context"
import { useTabReselect } from "@/hooks/use-tab-reselect"
import {
  personalAgentDispatches,
  personalAgentItems,
  personalAgentResumeAutoCompact,
  personalAgentStats,
} from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"
import { formatTokenCount } from "@/lib/token-format"
import type {
  DispatchInfo,
  DispatchState,
  ItemInfo,
  ItemKind,
  PersonalAgentSnapshot,
  PersonalAgentStats,
  TimelineRow,
  WaitsFor,
} from "@/lib/types"
import { cn } from "@/lib/utils"
import {
  PERSONAL_AGENT_EVENTS,
  usePersonalAgentUi,
  type AuxTab,
} from "@/stores/personal-agent-ui-store"

import {
  canOpenWork,
  DispatchStateChip,
  ExecutorAvatar,
  num,
  str,
  useOpenWork,
  usePageScope,
  useStatusWord,
  useWorkMeta,
  workTargetOf,
} from "./shared"

/** Run-log lines the status tab lists. */
const RUN_LOG_LINES = 50
/** An executor's avatar on a work card, in px at 100% zoom. */
const CARD_AVATAR_SIZE = 18
/** The agent's avatar on the status tab's card, in px at 100% zoom: a head
 *  taller than the two lines beside it. */
const IDENTITY_AVATAR_SIZE = 40
/** Ended work shown before "show all". */
const ENDED_SHOWN = 5
/** The dispatches the work tab reads: enough for the ended list. */
const DISPATCH_PAGE = 200
/** Days the stats tab covers. */
const STATS_DAYS = 14
/** The panel's charts, in px: shorter than the token dashboard's. */
const CHART_HEIGHT = 148

const TABS: readonly AuxTab[] = ["status", "work", "stats"]

/** A gauge for how the agent is, a clipboard for the matters it keeps (not
 *  the task board's checklist: these are not only tasks), a pie for its
 *  numbers. */
const TAB_ICON: Record<AuxTab, LucideIcon> = {
  status: CircleGauge,
  work: ClipboardList,
  stats: ChartPie,
}

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
const GROUP_TONE: Record<Group | "ended", string> = {
  owner: "bg-amber-500",
  external: "bg-primary",
  agent: "bg-violet-500",
  time: "bg-muted-foreground/50",
  none: "bg-muted-foreground/30",
  ended: "bg-muted-foreground/30",
}

/** The icon of a matter that is not handed-out work. */
const KIND_ICON: Record<Exclude<ItemKind, "dispatch">, LucideIcon> = {
  reminder: Bell,
  followup: Forward,
  question: MessageCircleQuestionMark,
}

/** The folding sections, by key, and whether each starts open. */
const FOLD_START: Record<string, boolean> = {
  "work.ended": false,
  "status.context": true,
  "status.runLog": false,
  "status.details": false,
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

/** Whether a folding section is open, and the way to fold it: kept in the
 *  page's store, so switching tabs keeps it. */
function useFold(key: string): [boolean, (open: boolean) => void] {
  const stored = usePersonalAgentUi((s) => s.auxFolds[key])
  const setFold = usePersonalAgentUi((s) => s.setAuxFold)
  return [stored ?? FOLD_START[key] ?? true, (open) => setFold(key, open)]
}

/** The open matters and the dispatches, loaded for the panel: the work tab
 *  lists them, the rail counts what waits on the owner. */
function useWork() {
  const { botId, itemVersion, dispatchVersion, dispatchById } =
    usePersonalAgent()
  const [items, setItems] = useState<ItemInfo[] | null>(null)
  const [dispatches, setDispatches] = useState<DispatchInfo[] | null>(null)
  useEffect(() => {
    let cancelled = false
    personalAgentItems("active", botId)
      .then((list) => {
        if (!cancelled) setItems(list)
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
        if (!cancelled) setDispatches(list)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [dispatchVersion, botId])
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
  reserve = null,
}: {
  snapshot: PersonalAgentSnapshot
  /** In the narrow screen's drawer, whose close button sits at the top end:
   *  the tabs keep clear of it. */
  inDrawer?: boolean
  /** The panel's strip is in the window's top band, at its end edge: the
   *  width it keeps clear there for the window's corner buttons. */
  reserve?: number | null
}) {
  const t = useTranslations("PersonalAgent.aux")
  const tab = usePersonalAgentUi((s) => s.auxTab)
  const setTab = usePersonalAgentUi((s) => s.setAuxTab)
  const setAuxOpen = usePersonalAgentUi((s) => s.setAuxOpen)
  const work = useWork()
  const waiting = work?.open.filter((m) => m.group === "owner").length ?? 0
  const label = (value: AuxTab) => t(`tab.${value}`)
  // The tab's name for a pointer and a screen reader, with what waits on
  // the owner when there is any.
  const fullName = (value: AuxTab) =>
    value === "work" && waiting > 0
      ? `${label(value)} · ${t("waiting", { count: waiting })}`
      : label(value)
  // A click on the tab already showing hides the panel, as the workspace's
  // rail does (and closes the drawer).
  const close = () => setAuxOpen(false)

  const panels = (
    <>
      <TabsContent value="status" className="mt-0 min-h-0 flex-1">
        <StatusTab snapshot={snapshot} />
      </TabsContent>
      <TabsContent value="work" className="mt-0 min-h-0 flex-1">
        <WorkTab work={work} inDrawer={inDrawer} />
      </TabsContent>
      <TabsContent value="stats" className="mt-0 min-h-0 flex-1">
        <StatsTab />
      </TabsContent>
    </>
  )

  return (
    <aside
      data-pa-aux
      aria-label={t("title")}
      className="flex h-full min-h-0 flex-col overflow-hidden"
    >
      <Tabs
        value={tab}
        onValueChange={(v) => setTab(v as AuxTab)}
        orientation={inDrawer ? "horizontal" : "vertical"}
        className="flex h-full min-h-0 flex-col gap-0"
      >
        {inDrawer ? (
          <>
            {/* The drawer's row of tabs, under a line, as the workspace's
                drawer has. */}
            <TabsList
              variant="line"
              className="h-10 w-full shrink-0 justify-start gap-3 border-b border-border ws-chrome-border ps-3 pe-12 group-data-horizontal/tabs:h-10"
            >
              {TABS.map((value) => (
                <DrawerTab
                  key={value}
                  value={value}
                  label={label(value)}
                  name={fullName(value)}
                  waiting={value === "work" ? waiting : 0}
                  selected={value === tab}
                  onReselect={close}
                />
              ))}
            </TabsList>
            {panels}
          </>
        ) : (
          <>
            {/* The open tab's name, where the workspace panel has it: in the
                window's top band, its corner buttons over the slot kept at
                its end; the name and the rest of the strip move the window,
                as the band does. Drawn as the band over the conversation is,
                on the page's own ground with its line under it, so the top
                band reads as one. */}
            <div
              className={cn(
                "flex h-10 shrink-0 items-center border-b border-border/50 ws-chrome-border ps-3",
                reserve == null && "pe-3"
              )}
            >
              <h2
                data-tauri-drag-region
                className="min-w-0 truncate text-[0.8125rem] leading-5 font-semibold"
              >
                {label(tab)}
              </h2>
              <div data-tauri-drag-region className="h-full min-w-0 flex-1" />
              {reserve != null ? (
                <ChromeReserve width={reserve} line={false} />
              ) : null}
            </div>
            <div className="flex min-h-0 flex-1">
              <div className="flex min-w-0 flex-1 flex-col">{panels}</div>
              <TabsPrimitive.List
                data-pa-aux-rail
                aria-label={t("title")}
                className={AUX_RAIL_CLASS}
              >
                <div className="flex flex-col items-center gap-1">
                  {TABS.map((value) => (
                    <RailTab
                      key={value}
                      value={value}
                      name={fullName(value)}
                      waiting={value === "work" ? waiting : 0}
                      selected={value === tab}
                      onReselect={close}
                    />
                  ))}
                </div>
              </TabsPrimitive.List>
            </div>
          </>
        )}
      </Tabs>
    </aside>
  )
}

/** A tab of the rail: its icon, and what waits on the owner as a count at
 *  its corner. */
function RailTab({
  value,
  name,
  waiting,
  selected,
  onReselect,
}: {
  value: AuxTab
  name: string
  waiting: number
  selected: boolean
  onReselect: () => void
}) {
  const { triggerProps } = useTabReselect(selected, onReselect)
  const Icon = TAB_ICON[value]
  return (
    <TabsPrimitive.Trigger
      value={value}
      title={name}
      aria-label={name}
      {...triggerProps}
      className={cn(AUX_RAIL_TRIGGER_CLASS, "relative")}
    >
      <Icon className="size-4" />
      {waiting > 0 ? (
        <span
          aria-hidden
          className="absolute -end-0.5 -top-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-amber-500 px-1 text-[0.5625rem] leading-none font-semibold text-white tabular-nums"
        >
          {waiting}
        </span>
      ) : null}
    </TabsPrimitive.Trigger>
  )
}

/** A tab of the drawer's row: its icon and name, and what waits on the
 *  owner as a count after them. */
function DrawerTab({
  value,
  label,
  name,
  waiting,
  selected,
  onReselect,
}: {
  value: AuxTab
  label: string
  name: string
  waiting: number
  selected: boolean
  onReselect: () => void
}) {
  const { triggerProps } = useTabReselect(selected, onReselect)
  const Icon = TAB_ICON[value]
  return (
    <TabsTrigger
      value={value}
      title={name}
      aria-label={name}
      {...triggerProps}
      className="flex-none px-1 text-[0.8125rem]"
    >
      <Icon className="size-3.5" aria-hidden />
      {label}
      {waiting > 0 ? (
        <span
          aria-hidden
          className="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-amber-500/15 px-1 text-[0.625rem] leading-none font-semibold text-amber-700 tabular-nums dark:text-amber-300"
        >
          {waiting}
        </span>
      ) : null}
    </TabsTrigger>
  )
}

/** A tab's body when it has nothing to show: its icon, what that means and
 *  what would fill it, as the workspace panel's tabs say it. */
function EmptyState({
  icon: Icon,
  title,
  hint,
}: {
  icon: LucideIcon
  title: string
  hint: string
}) {
  return (
    <div className="flex h-full min-h-0 flex-col items-center justify-center gap-3 p-6 text-center">
      <Icon className="size-8 text-muted-foreground/40" aria-hidden />
      <div className="flex flex-col gap-1">
        <p className="text-sm font-medium">{title}</p>
        <p className="text-xs text-muted-foreground">{hint}</p>
      </div>
    </div>
  )
}

// ── work ────────────────────────────────────────────────────────────────────

/** A section of the work tab, as the task tab draws its columns: the
 *  chevron that folds it, its marker, its name and how many it holds — the
 *  count amber where the owner is waited on. What ended starts folded. The
 *  chevron's stroke is on the cards' edge, as the other tabs' sections have
 *  theirs (`InsightsSection`'s `flush`). */
function WorkSection({
  group,
  label,
  count,
  children,
}: {
  group: Group | "ended"
  label: string
  count: number
  children: ReactNode
}) {
  const [open, setOpen] = useFold(`work.${group}`)
  return (
    <section data-pa-group={group} className="flex flex-col gap-2">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex h-6 min-w-0 items-center gap-2 rounded-md pe-0.5 text-start outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <ChevronDown
          className={cn(
            // The glyph's box has 3px of air before its stroke.
            "-ms-[3px] size-3.5 shrink-0 text-muted-foreground transition-transform",
            !open && "-rotate-90 rtl:rotate-90"
          )}
          aria-hidden
        />
        <span
          className={cn(
            "h-3.5 w-[3px] shrink-0 rounded-full",
            GROUP_TONE[group]
          )}
          aria-hidden
        />
        <span className="truncate text-xs font-semibold">{label}</span>
        <span
          className={cn(
            "shrink-0 rounded-full px-1.5 py-0.5 text-[0.625rem] leading-none tabular-nums",
            group === "owner"
              ? "bg-amber-500/15 font-semibold text-amber-600 dark:text-amber-400"
              : "bg-muted/70 font-medium text-muted-foreground"
          )}
        >
          {count}
        </span>
      </button>
      {open ? <div className="flex flex-col gap-2">{children}</div> : null}
    </section>
  )
}

/** One card of the work tab, as the task tab's cards are: what leads it (an
 *  avatar, a kind's icon) beside what it is, where it stands at its end; a
 *  quiet line under them, and notes. The whole card opens what it is about,
 *  when it opens anything. */
function WorkCard({
  mark,
  title,
  chip,
  meta,
  notes = [],
  onOpen,
  openLabel,
}: {
  mark: ReactNode
  title: string
  chip?: ReactNode
  meta: string | null
  notes?: string[]
  onOpen?: (() => void) | null
  openLabel?: string
}) {
  const body = (
    <>
      <span className="flex min-w-0 items-start gap-2">
        {/* On the first line of a title that wraps. */}
        <span className="mt-px flex shrink-0">{mark}</span>
        <span className="min-w-0 flex-1 text-[0.8125rem] leading-snug font-medium break-words text-foreground">
          {title}
        </span>
        {chip}
      </span>
      {meta ? (
        <span className="mt-1.5 block truncate text-[0.6875rem] text-muted-foreground">
          {meta}
        </span>
      ) : null}
      {notes.map((note, i) => (
        <span
          key={i}
          className="mt-1.5 line-clamp-2 text-[0.6875rem] leading-snug break-words text-muted-foreground"
        >
          {note}
        </span>
      ))}
    </>
  )
  // `ws-msg-card` turns it translucent over a workspace background image, as
  // the task cards do; the border is a shade of the text, the token hairline
  // all but vanishing white on white.
  const shape =
    "flex w-full min-w-0 flex-col rounded-xl border border-foreground/15 bg-card ws-msg-card p-3 text-start"
  if (!onOpen) return <div className={shape}>{body}</div>
  return (
    <button
      type="button"
      onClick={onOpen}
      title={openLabel}
      className={cn(
        shape,
        "transition-colors hover:border-primary focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      )}
    >
      {body}
    </button>
  )
}

/** A piece of handed-out work: who runs it, titled as in the list, where it
 *  stands; opening its session in the drawer. */
function DispatchCard({
  d,
  notes,
  now,
}: {
  d: DispatchInfo
  /** What its entry says beyond the title: how the agent sums it up now,
   *  what it will do once the work is done. */
  notes?: string[]
  now: number
}) {
  const t = useTranslations("PersonalAgent")
  const openWork = useOpenWork()
  const meta = useWorkMeta()
  const target = workTargetOf(d)
  const canOpen = canOpenWork(target)
  return (
    <WorkCard
      mark={
        <ExecutorAvatar
          id={d.executor.assistant_id}
          name={d.executor.name}
          size={CARD_AVATAR_SIZE}
        />
      }
      title={d.title}
      chip={<DispatchStateChip state={d.state} />}
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
    />
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
  const { jumpTo } = usePageScope()
  const setAuxOpen = usePersonalAgentUi((s) => s.setAuxOpen)
  const Icon =
    item.kind === "dispatch" ? ListTodo : (KIND_ICON[item.kind] ?? ListTodo)
  const origin = item.origin_timeline_id
  return (
    <WorkCard
      mark={
        <span className="flex size-[1.125rem] items-center justify-center text-muted-foreground">
          <Icon className="size-3.5" aria-hidden />
        </span>
      }
      title={item.summary}
      meta={[t(`items.kind.${item.kind}`), formatRelative(item.updated_at, now)]
        .filter(Boolean)
        .join(" · ")}
      notes={item.on_done ? [t("items.onDone", { text: item.on_done })] : []}
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
  if (m.dispatch) {
    const summary = m.item?.summary?.trim()
    const onDone = m.item?.on_done ?? m.dispatch.on_done
    const notes = [
      summary && summary !== m.dispatch.title ? summary : null,
      onDone ? t("items.onDone", { text: onDone }) : null,
    ].filter((n): n is string => n != null)
    return <DispatchCard d={m.dispatch} notes={notes} now={now} />
  }
  return m.item ? (
    <ItemCard item={m.item} inDrawer={inDrawer} now={now} />
  ) : null
}

/** First paint: two section headers over ghost cards, on the real ones'
 *  insets. */
function WorkSkeleton() {
  return (
    <div className="flex flex-col gap-3 p-3" aria-hidden>
      {[2, 1].map((cards, section) => (
        <div key={section} className="flex flex-col gap-2">
          <Skeleton className="h-4 w-24" />
          {Array.from({ length: cards }, (_, i) => (
            <Skeleton key={i} className="h-16 w-full rounded-xl" />
          ))}
        </div>
      ))}
    </div>
  )
}

function WorkTab({
  work,
  inDrawer,
}: {
  work: ReturnType<typeof useWork>
  inDrawer: boolean
}) {
  const t = useTranslations("PersonalAgent")
  const now = useNow()
  const [allEnded, setAllEnded] = useState(false)
  if (work == null) return <WorkSkeleton />
  const { open, ended } = work
  if (open.length === 0 && ended.length === 0) {
    return (
      <EmptyState
        icon={TAB_ICON.work}
        title={t("matters.emptyTitle")}
        hint={t("matters.emptyHint")}
      />
    )
  }
  const shownEnded = allEnded ? ended : ended.slice(0, ENDED_SHOWN)
  return (
    <ScrollArea className="h-full">
      <div className="flex flex-col gap-3 p-3">
        {open.length === 0 ? (
          <p className="text-xs leading-5 text-muted-foreground">
            {t("matters.noneOpen")}
          </p>
        ) : null}
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
        {ended.length > 0 ? (
          <WorkSection
            group="ended"
            label={t("matters.ended")}
            count={ended.length}
          >
            {shownEnded.map((d) => (
              <DispatchCard key={d.id} d={d} now={now} />
            ))}
            {ended.length > shownEnded.length ? (
              <Button
                type="button"
                size="xs"
                variant="ghost"
                className="self-start text-muted-foreground"
                onClick={() => setAllEnded(true)}
              >
                {t("matters.showAll", { count: ended.length })}
              </Button>
            ) : null}
          </WorkSection>
        ) : null}
      </div>
    </ScrollArea>
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

/** How full the context is: a bar with the auto-compaction threshold as a
 *  tick across it. */
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
    <div
      className="relative h-1.5 rounded-full bg-foreground/10"
      role="meter"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent == null ? undefined : Math.round(ratio)}
    >
      {ratio > 0 ? (
        <span
          className={cn(
            "absolute inset-y-0 start-0 rounded-full",
            hot ? "bg-amber-500" : "bg-primary"
          )}
          style={{ width: `${ratio}%` }}
        />
      ) : null}
      {threshold > 0 && threshold < 100 ? (
        <span
          aria-hidden
          className="absolute -top-1 h-3.5 w-0.5 -translate-x-1/2 rounded-full bg-muted-foreground/70 rtl:translate-x-1/2"
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
        return t(`compaction.${status}` as "compaction.ok", {
          who: t(`by.${who}` as "by.auto"),
          range,
        })
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

/** The agent as Session Details shows a conversation: its avatar, name and
 *  state, what it runs on, then a row per property — its model and mode,
 *  its session (which opens), when that started, its connection, its
 *  working directory (copyable). The way to its settings at the corner. */
function AgentCard({
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
  const name = agent?.name?.trim() || tPage("title")
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
    <section className="min-w-0 rounded-lg border border-border/70 bg-muted/40 p-3">
      <div className="flex min-w-0 items-center gap-3">
        {agent ? (
          <AssistantAvatar
            avatar={agent.avatar}
            name={name}
            size={IDENTITY_AVATAR_SIZE}
          />
        ) : null}
        <div className="min-w-0 flex-1">
          <p
            title={name}
            className="truncate text-[0.8125rem] leading-[1.125rem] font-semibold"
          >
            {name}
          </p>
          <p className="mt-0.5 flex min-w-0 items-center gap-1.5 text-2xs text-muted-foreground">
            {agent ? (
              <span aria-hidden className="inline-flex shrink-0">
                <AgentIcon agentType={agent.agent_type} className="size-3.5" />
              </span>
            ) : null}
            <span className="truncate">
              {agent?.label_snapshot.agent ?? "—"}
            </span>
            {word ? (
              <>
                <span aria-hidden>·</span>
                <span className="inline-flex min-w-0 shrink-0 items-center gap-1 text-foreground/80">
                  <span
                    aria-hidden
                    className={cn("size-1.5 shrink-0 rounded-full", dot)}
                  />
                  {word}
                </span>
              </>
            ) : null}
          </p>
        </div>
        {readOnly ? null : (
          <button
            type="button"
            className="inline-flex size-6 shrink-0 items-center justify-center self-start rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            title={to("editBrain")}
            aria-label={to("editBrain")}
            onClick={() =>
              window.dispatchEvent(
                new Event(PERSONAL_AGENT_EVENTS.openSettings)
              )
            }
          >
            <Settings2 className="size-3.5" aria-hidden />
          </button>
        )}
      </div>
      <dl className="mt-2.5 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 text-2xs">
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
            <button
              type="button"
              className="ms-auto inline-flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
              title={tPage("viewSession")}
              aria-label={tPage("viewSession")}
              onClick={() =>
                window.dispatchEvent(
                  new Event(PERSONAL_AGENT_EVENTS.openSession)
                )
              }
            >
              <SquareArrowOutUpRight className="size-3" aria-hidden />
            </button>
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
        <p className="mt-2 text-2xs leading-4 text-amber-700 dark:text-amber-300">
          {t("pendingValue", { reason: tr(seg.pending_reason) })}
        </p>
      ) : null}
    </section>
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
  const [open, setOpen] = useFold("status.context")
  const [resuming, setResuming] = useState(false)
  const botId = useBotId()
  const { status } = snapshot
  const seg = status.segment
  const last = status.last_compaction
  const percent = status.usage?.percent ?? null
  return (
    <InsightsSection
      title={t("context")}
      summary={percent == null ? "—" : `${Math.round(percent)}%`}
      open={open}
      onOpenChange={setOpen}
      flush
    >
      {open ? (
        <div className="flex flex-col gap-1.5 pt-1.5 pb-1">
          <ContextMeter
            percent={percent}
            threshold={status.auto_compact_percent}
          />
          <p className="mt-1 text-2xs leading-4 text-muted-foreground">
            {status.auto_compact_percent > 0
              ? t("threshold", { percent: status.auto_compact_percent })
              : t("thresholdOff")}
          </p>
          <p className="text-2xs leading-4 text-muted-foreground">
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
            <p className="text-2xs leading-4 text-muted-foreground">
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
            <div className="mt-1 flex items-center justify-between gap-2 rounded-md bg-amber-500/10 px-2 py-1.5 text-2xs">
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
                <Play className="size-3" aria-hidden />
                {t("resume")}
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
    </InsightsSection>
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
  const [open, setOpen] = useFold("status.runLog")
  const markers = useMemo(
    () =>
      rows
        .filter((r) => r.kind === "marker")
        .slice(-RUN_LOG_LINES)
        .reverse(),
    [rows]
  )
  return (
    <InsightsSection
      title={to("runLog")}
      summary={markers.length}
      open={open}
      onOpenChange={setOpen}
      flush
    >
      {open ? (
        markers.length === 0 ? (
          <p className="text-2xs leading-6 text-muted-foreground">
            {t("empty")}
          </p>
        ) : (
          <ul className="flex flex-col">
            {markers.map((m) => (
              <li key={m.id} className="flex min-w-0 items-start gap-3 py-1">
                <span className="min-w-0 flex-1 text-xs leading-4 break-words text-foreground/85">
                  {line(m)}
                </span>
                <span className="shrink-0 text-2xs leading-4 text-muted-foreground tabular-nums">
                  {when(m.created_at)}
                </span>
              </li>
            ))}
          </ul>
        )
      ) : null}
    </InsightsSection>
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
    <div className="col-span-2 grid grid-cols-subgrid items-baseline">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 leading-5 break-words text-foreground/80">
        {children}
      </dd>
    </div>
  )
}

function DetailsSection({ snapshot }: { snapshot: PersonalAgentSnapshot }) {
  const t = useTranslations("PersonalAgent.status")
  const to = useTranslations("PersonalAgent.overview")
  const [open, setOpen] = useFold("status.details")
  const { status } = snapshot
  const seg = status.segment
  const check = status.last_check
  return (
    <InsightsSection
      title={to("details")}
      summary={null}
      open={open}
      onOpenChange={setOpen}
      flush
    >
      {open ? (
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 pt-1 text-2xs">
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
      ) : null}
    </InsightsSection>
  )
}

function StatusTab({ snapshot }: { snapshot: PersonalAgentSnapshot }) {
  const t = useTranslations("PersonalAgent.status")
  const readOnly = snapshot.status.engine !== "here"
  return (
    <ScrollArea className="h-full">
      <div className="min-w-0 space-y-4 p-3 text-sm">
        {readOnly ? (
          <p className="rounded-lg bg-amber-500/10 px-3 py-2 text-xs leading-5 text-amber-800 dark:text-amber-200">
            {t("elsewhere")}
          </p>
        ) : null}
        <AgentCard snapshot={snapshot} readOnly={readOnly} />
        <ContextSection snapshot={snapshot} readOnly={readOnly} />
        <RunLogSection />
        <DetailsSection snapshot={snapshot} />
      </div>
    </ScrollArea>
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
    <div className="min-w-0">
      <dt className="truncate text-2xs text-muted-foreground">{label}</dt>
      <dd className="text-lg leading-6 font-semibold text-foreground tabular-nums">
        {value}
      </dd>
      {sub ? (
        <dd className="truncate text-[0.625rem] leading-4 text-muted-foreground">
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

/** A chart of the stats tab, as a folding section: its title and total
 *  over it. */
function ChartSection({
  fold,
  title,
  summary,
  children,
}: {
  fold: string
  title: string
  summary: ReactNode
  children: ReactNode
}) {
  const [open, setOpen] = useFold(fold)
  return (
    <InsightsSection
      title={title}
      summary={summary}
      open={open}
      onOpenChange={setOpen}
      flush
    >
      {open ? <div className="pt-1">{children}</div> : null}
    </InsightsSection>
  )
}

function StatsTab() {
  const t = useTranslations("PersonalAgent.data")
  const locale = useLocale()
  const tm = useTranslations("PersonalAgent.mode")
  const { botId, dispatchVersion } = usePersonalAgent()
  const [stats, setStats] = useState<PersonalAgentStats | null>(null)
  useEffect(() => {
    let cancelled = false
    personalAgentStats(STATS_DAYS, botId)
      .then((s) => {
        if (!cancelled) setStats(s)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [dispatchVersion, botId])
  if (!stats) {
    return (
      <Loader2 className="mx-auto my-8 size-4 animate-spin text-muted-foreground" />
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
    <ScrollArea className="h-full">
      <div className="tu-viz min-w-0 space-y-4 p-3 text-sm">
        <section className="min-w-0 rounded-lg border border-border/70 bg-muted/40 p-3">
          <p className="text-[0.8125rem] leading-[1.125rem] font-semibold">
            {t("range", { days: STATS_DAYS })}
          </p>
          <dl className="mt-2.5 grid grid-cols-2 gap-x-3 gap-y-3">
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
              value={
                synced ? formatTokenCount(agentTokens + dispatchTokens) : "—"
              }
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
        </section>
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
          summary={
            synced ? formatTokenCount(agentTokens + dispatchTokens) : "—"
          }
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
                  when: new Date(stats.tokens_synced_at!).toLocaleString(
                    locale
                  ),
                })
              : t("notSynced")}
          </p>
        </ChartSection>
        <ChartSection fold="stats.usage" title={t("usageCurve")} summary={null}>
          <UsageCurve stats={stats} />
        </ChartSection>
      </div>
    </ScrollArea>
  )
}
