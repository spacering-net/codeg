"use client"

/**
 * The preference pages every assistant shares (13.5): "Communication",
 * "Proactive & notifications" and "Dispatch & automation". Each item saves
 * the moment it changes; the page's [Restore defaults] puts its items back.
 * The automation level and the disturbance level are read off their items —
 * choose a level and they take its values; change one of them and the level
 * reads "custom".
 */

import { useState, type ReactNode } from "react"
import { useTranslations } from "next-intl"
import {
  Activity,
  AlarmClock,
  ArrowLeftRight,
  BadgeCheck,
  Brain,
  Bell,
  BellDot,
  CircleX,
  Coffee,
  Dock,
  FolderGit2,
  GitBranch,
  GitCompareArrows,
  GitMerge,
  GitPullRequest,
  GitPullRequestArrow,
  GitPullRequestDraft,
  CalendarCheck,
  CalendarClock,
  CalendarRange,
  CalendarX,
  BellRing,
  CircleAlert,
  CircleCheck,
  ClipboardCheck,
  Gauge,
  Globe,
  Hand,
  Hourglass,
  Inbox,
  Keyboard,
  Layers,
  LayoutGrid,
  Lightbulb,
  ListChecks,
  ListTree,
  ListX,
  MessageCircleQuestion,
  MessageSquareDiff,
  MessageSquareReply,
  MessageSquareText,
  MessagesSquare,
  Moon,
  MoonStar,
  MousePointerClick,
  Newspaper,
  NotebookPen,
  PanelTop,
  Repeat,
  Reply,
  RotateCcw,
  RotateCw,
  Send,
  ShieldAlert,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Sunrise,
  Sunset,
  Text,
  Timer,
  TriangleAlert,
  Undo2,
  UserX,
  Waypoints,
  Wrench,
} from "lucide-react"
import type { LucideIcon } from "lucide-react"

import {
  SettingCard,
  SettingNote,
  SettingRow,
} from "@/components/shared/setting-card"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { cn } from "@/lib/utils"
import { isDesktop } from "@/lib/transport"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import type {
  PersonalAgentAccount,
  PersonalAgentPrefKey,
  PersonalAgentPrefs,
} from "@/lib/types"

import { ProposalRules } from "./proposal-rules"
import { useSettingsPatch } from "./use-settings"

/** The backend's defaults (`Prefs::default`). */
export const DEFAULT_PREFS: PersonalAgentPrefs = {
  reply_length: "medium",
  cards: "prefer",
  when_unsure: "assume",
  chat_changes: "apply",
  confirm_dispatch: "never",
  followups: "auto",
  messages: "auto",
  loop_rounds: 3,
  interrupt_retry: "auto",
  retry_rounds: 2,
  exec_questions: "assistant",
  exec_plans: "assistant",
  auto_accept: "on",
  flush: "on",
  accept_revise: "auto",
  accept_rounds: 3,
  forge_comment: "auto",
  issue_close: "auto",
  pr_merge: "auto",
  routine_dispatch: "auto",
  plans: "auto",
  tidy: "auto",
  ci_failure: "fix",
  pr_conflict: "auto",
  review_feedback: "auto",
  outsider_comments: "auto",
  ci_rounds: 3,
  time_zone: "system",
  presence: "on",
  proactive: "on",
  urgent_via: "system_attention",
  normal_via: "system",
  low_via: "today",
  focus_wait: 3,
  quiet_hours: "auto",
  quiet_from: "22:00",
  quiet_to: "08:00",
  quiet_lets: "reminders",
  morning: "hours",
  morning_at: "09:00",
  projects: "all",
  level_reminder: "urgent",
  level_forwarded: "urgent",
  level_approval: "urgent",
  level_waiting: "urgent",
  level_question: "normal",
  level_confirm: "normal",
  level_stuck: "normal",
  level_done: "normal",
  level_reply: "normal",
  level_exchange: "low",
  level_changed: "low",
  level_answered: "low",
  level_acceptance: "normal",
  level_used_up: "urgent",
  level_forge: "low",
  level_pr_ready: "normal",
  level_pr: "low",
  level_routine: "normal",
  level_routine_paused: "urgent",
  level_proposal: "normal",
  level_proposal_low: "low",
  level_brief: "normal",
  level_memory: "low",
  level_plan: "normal",
  level_plan_stuck: "urgent",
  rule_failed: "on",
  rule_failed_hours: 2,
  rule_review: "on",
  rule_review_hours: 24,
  rule_session: "on",
  rule_session_minutes: 10,
  rule_pr_review: "on",
  rule_pr_review_days: 2,
  rule_uncommitted: "on",
  rule_uncommitted_hours: 24,
  rule_idle: "on",
  rule_idle_days: 7,
  rule_behind: "on",
  rule_repeat: "on",
  rule_repeat_count: 3,
  rule_suggest: "on",
  brief: "on",
  brief_time: "hours",
  brief_at: "08:30",
  brief_needs: "on",
  brief_night: "on",
  brief_bots: "on",
  brief_schedule: "on",
  brief_loose: "on",
  brief_yesterday: "on",
  brief_suggestions: 3,
  wrap: "auto",
  wrap_tonight: "on",
  keep_awake: "on",
  menubar: "on",
  dock_badge: "on",
  history_sessions: "on",
  history_tasks: "on",
  reactions: "on",
  weekly_review: "brief",
  rule_undo: "on",
  rule_idle_bot: "on",
}

/** What each automation level sets (`automation_preset`). */
export const AUTOMATION_PRESETS: Record<
  "standard" | "ask_more",
  Partial<PersonalAgentPrefs>
> = {
  standard: {
    confirm_dispatch: "never",
    followups: "auto",
    messages: "auto",
    chat_changes: "apply",
    interrupt_retry: "auto",
    exec_questions: "assistant",
    exec_plans: "assistant",
    accept_revise: "auto",
    forge_comment: "auto",
    issue_close: "auto",
    pr_merge: "auto",
    routine_dispatch: "auto",
    plans: "auto",
    tidy: "auto",
    ci_failure: "fix",
    pr_conflict: "auto",
    review_feedback: "auto",
    outsider_comments: "auto",
  },
  ask_more: {
    confirm_dispatch: "code",
    followups: "ask",
    messages: "ask",
    chat_changes: "show",
    interrupt_retry: "ask",
    exec_questions: "owner",
    exec_plans: "owner",
    accept_revise: "ask",
    forge_comment: "ask",
    issue_close: "ask",
    pr_merge: "ask",
    routine_dispatch: "ask",
    plans: "ask",
    tidy: "draft",
    ci_failure: "ask",
    pr_conflict: "ask",
    review_feedback: "ask",
    outsider_comments: "ask",
  },
}

/** What each disturbance level sets (13.4, `disturb_preset`). */
export const DISTURB_PRESETS: Record<
  "quiet" | "standard" | "more",
  Partial<PersonalAgentPrefs>
> = {
  quiet: {
    normal_via: "today",
    low_via: "today",
    wrap: "ask",
    ...rulePreset("quiet"),
  },
  standard: {
    normal_via: "system",
    low_via: "today",
    focus_wait: 3,
    wrap: "auto",
    ...rulePreset("standard"),
  },
  more: {
    normal_via: "system",
    low_via: "digest",
    focus_wait: 0,
    wrap: "auto",
    ...rulePreset("more"),
  },
}

/** The proposal rules at each disturbance level (13.4, `rule_preset`):
 *  "quiet" keeps only a session waiting and failed work; "more" halves
 *  every threshold. The assistants' own suggestions are not the level's. */
function rulePreset(
  level: "quiet" | "standard" | "more"
): Partial<PersonalAgentPrefs> {
  const keep = (on: boolean) => (on ? "on" : "off") as "on" | "off"
  const time = (n: number) => (level === "more" ? Math.ceil(n / 2) : n)
  const all = level !== "quiet"
  return {
    rule_failed: "on",
    rule_failed_hours: time(2),
    rule_review: keep(all),
    rule_review_hours: time(24),
    rule_session: "on",
    rule_session_minutes: time(10),
    rule_pr_review: keep(all),
    rule_pr_review_days: time(2),
    rule_uncommitted: keep(all),
    rule_uncommitted_hours: time(24),
    rule_idle: keep(all),
    rule_idle_days: time(7),
    rule_behind: keep(all),
    rule_repeat: keep(all),
  }
}

/** The items a preset would change from what they are now. */
export function overriddenBy(
  prefs: PersonalAgentPrefs,
  preset: Partial<PersonalAgentPrefs>
): PersonalAgentPrefKey[] {
  return (Object.entries(preset) as [PersonalAgentPrefKey, unknown][])
    .filter(([k, v]) => prefs[k] !== v)
    .map(([k]) => k)
}

/** How much a kind of news may interrupt the owner. */
export const NEWS_LEVELS = ["urgent", "normal", "low"] as const

/** The kinds of news, each with its level (6.2, "adjust by kind"). */
export const LEVEL_ITEMS: PersonalAgentPrefKey[] = [
  "level_reminder",
  "level_forwarded",
  "level_approval",
  "level_waiting",
  "level_question",
  "level_confirm",
  "level_stuck",
  "level_done",
  "level_reply",
  "level_exchange",
  "level_changed",
  "level_answered",
  "level_acceptance",
  "level_used_up",
  "level_forge",
  "level_pr_ready",
  "level_pr",
  "level_routine",
  "level_routine_paused",
  "level_proposal",
  "level_proposal_low",
  "level_brief",
  "level_memory",
  "level_plan",
  "level_plan_stuck",
]

/** The items that take a time of day, `HH:MM`. */
const CLOCK_ITEMS: ReadonlySet<PersonalAgentPrefKey> = new Set([
  "quiet_from",
  "quiet_to",
  "morning_at",
  "brief_at",
])

/** Whether `item` takes a time of day. */
export function isClockItem(item: string): boolean {
  return CLOCK_ITEMS.has(item as PersonalAgentPrefKey)
}

/** A valid time of day: `HH:MM`, 00:00–23:59. */
export function isClock(v: string): boolean {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(v)
}

/** The message key of one of an item's choices: the kinds of news share
 *  their level words. */
export function choiceKey(item: string, choice: string): string {
  return item.startsWith("level_") ? `level.${choice}` : `${item}.${choice}`
}

/** The choices of each item, in the order they are offered. */
const CHOICES: Partial<Record<PersonalAgentPrefKey, readonly string[]>> = {
  reply_length: ["short", "medium", "long"],
  cards: ["prefer", "decisions", "never"],
  when_unsure: ["assume", "ask"],
  chat_changes: ["apply", "show"],
  confirm_dispatch: ["never", "code", "always"],
  followups: ["auto", "ask"],
  messages: ["auto", "ask"],
  interrupt_retry: ["auto", "ask"],
  exec_questions: ["assistant", "owner"],
  exec_plans: ["assistant", "owner"],
  auto_accept: ["on", "off"],
  flush: ["on", "off"],
  accept_revise: ["auto", "ask"],
  forge_comment: ["auto", "ask"],
  issue_close: ["auto", "ask"],
  pr_merge: ["auto", "ask"],
  routine_dispatch: ["auto", "ask"],
  plans: ["auto", "ask"],
  tidy: ["auto", "draft", "off"],
  ci_failure: ["fix", "ask", "tell"],
  pr_conflict: ["auto", "ask"],
  review_feedback: ["auto", "ask"],
  outsider_comments: ["auto", "ask"],
  proactive: ["on", "off"],
  urgent_via: ["system_attention", "system", "in_page"],
  normal_via: ["system", "in_page", "today"],
  low_via: ["today", "digest"],
  quiet_hours: ["auto", "fixed", "none"],
  quiet_lets: ["reminders", "urgent"],
  morning: ["hours", "fixed"],
  brief: ["on", "off"],
  brief_time: ["hours", "fixed"],
  brief_needs: ["on", "off"],
  brief_night: ["on", "off"],
  brief_bots: ["on", "off"],
  brief_schedule: ["on", "off"],
  brief_loose: ["on", "off"],
  brief_yesterday: ["on", "off"],
  wrap: ["auto", "ask", "off"],
  wrap_tonight: ["on", "off"],
  keep_awake: ["on", "off"],
  menubar: ["on", "off"],
  dock_badge: ["on", "off"],
  history_sessions: ["on", "off"],
  history_tasks: ["on", "off"],
  reactions: ["on", "off"],
  weekly_review: ["brief", "wrap", "off"],
  ...Object.fromEntries(LEVEL_ITEMS.map((k) => [k, NEWS_LEVELS])),
}

/** The most a count item takes (`PrefKind::Count`). */
export const COUNT_MAX: Partial<Record<PersonalAgentPrefKey, number>> = {
  loop_rounds: 1000,
  retry_rounds: 10,
  accept_rounds: 10,
  ci_rounds: 10,
  focus_wait: 60,
  rule_failed_hours: 720,
  rule_review_hours: 720,
  rule_session_minutes: 1440,
  rule_pr_review_days: 90,
  rule_uncommitted_hours: 720,
  rule_idle_days: 90,
  rule_repeat_count: 20,
  brief_suggestions: 5,
}

/** Each preference's glyph, wherever it is set (the settings, the first
 *  meeting's switches). */
export const PREF_ICONS: Record<PersonalAgentPrefKey, LucideIcon> = {
  reply_length: Text,
  cards: LayoutGrid,
  when_unsure: MessageCircleQuestion,
  chat_changes: SlidersHorizontal,
  confirm_dispatch: ShieldCheck,
  followups: Repeat,
  messages: MessagesSquare,
  loop_rounds: Waypoints,
  interrupt_retry: RotateCw,
  retry_rounds: Timer,
  exec_questions: MessageSquareReply,
  exec_plans: ListChecks,
  auto_accept: ClipboardCheck,
  flush: NotebookPen,
  accept_revise: Undo2,
  accept_rounds: Timer,
  forge_comment: MessageSquareText,
  issue_close: CircleX,
  pr_merge: GitMerge,
  routine_dispatch: CalendarClock,
  plans: ListTree,
  tidy: Sparkles,
  ci_failure: Wrench,
  pr_conflict: GitCompareArrows,
  review_feedback: MessageSquareDiff,
  outsider_comments: MessagesSquare,
  ci_rounds: Timer,
  time_zone: Globe,
  presence: Activity,
  proactive: Sparkles,
  urgent_via: BellRing,
  normal_via: Bell,
  low_via: BellDot,
  focus_wait: Keyboard,
  quiet_hours: Moon,
  quiet_from: MoonStar,
  quiet_to: Sunrise,
  quiet_lets: ShieldAlert,
  morning: Sunrise,
  morning_at: AlarmClock,
  projects: FolderGit2,
  level_reminder: AlarmClock,
  level_forwarded: MessageSquareReply,
  level_approval: Hand,
  level_waiting: Hourglass,
  level_question: MessageCircleQuestion,
  level_confirm: ShieldCheck,
  level_stuck: TriangleAlert,
  level_done: CircleCheck,
  level_reply: Reply,
  level_exchange: ArrowLeftRight,
  level_changed: SlidersHorizontal,
  level_answered: Inbox,
  level_acceptance: BadgeCheck,
  level_used_up: CircleAlert,
  level_forge: GitPullRequest,
  level_pr_ready: GitPullRequestArrow,
  level_pr: GitPullRequestDraft,
  level_routine: CalendarCheck,
  level_routine_paused: CalendarX,
  level_proposal: Lightbulb,
  level_proposal_low: Lightbulb,
  level_brief: Newspaper,
  level_memory: Brain,
  level_plan: ListTree,
  level_plan_stuck: ListX,
  rule_failed: TriangleAlert,
  rule_failed_hours: Timer,
  rule_review: Hourglass,
  rule_review_hours: Timer,
  rule_session: MessageCircleQuestion,
  rule_session_minutes: Timer,
  rule_pr_review: GitPullRequest,
  rule_pr_review_days: Timer,
  rule_uncommitted: FolderGit2,
  rule_uncommitted_hours: Timer,
  rule_idle: BellRing,
  rule_idle_days: Timer,
  rule_behind: GitBranch,
  rule_repeat: Repeat,
  rule_repeat_count: Timer,
  rule_suggest: Lightbulb,
  brief: Newspaper,
  brief_time: Sunrise,
  brief_at: AlarmClock,
  brief_needs: Hand,
  brief_night: MoonStar,
  brief_bots: MessagesSquare,
  brief_schedule: CalendarClock,
  brief_loose: ListChecks,
  brief_yesterday: Activity,
  brief_suggestions: Lightbulb,
  wrap: Sunset,
  wrap_tonight: Moon,
  keep_awake: Coffee,
  menubar: PanelTop,
  dock_badge: Dock,
  history_sessions: MessagesSquare,
  history_tasks: LayoutGrid,
  reactions: MousePointerClick,
  weekly_review: CalendarRange,
  rule_undo: Undo2,
  rule_idle_bot: UserX,
}

export const COMMUNICATION_ITEMS: PersonalAgentPrefKey[] = [
  "reply_length",
  "cards",
  "when_unsure",
  "chat_changes",
]

export const AUTOMATION_ITEMS: PersonalAgentPrefKey[] = [
  "confirm_dispatch",
  "interrupt_retry",
  "followups",
  "exec_questions",
  "exec_plans",
  "flush",
  "auto_accept",
  "accept_revise",
  "forge_comment",
  "issue_close",
  "pr_merge",
  "ci_failure",
  "pr_conflict",
  "review_feedback",
  "outsider_comments",
  "routine_dispatch",
  "plans",
  "tidy",
  "messages",
  "retry_rounds",
  "accept_rounds",
  "ci_rounds",
  "loop_rounds",
]

/** The items of the "About you" page (`about-page.tsx`). */
export const ABOUT_ITEMS: PersonalAgentPrefKey[] = [
  "time_zone",
  "presence",
  "history_sessions",
  "history_tasks",
  "reactions",
]

/** The proposal rules' items (6.7): each rule's switch and threshold. */
export const RULE_ITEMS: PersonalAgentPrefKey[] = [
  "rule_failed",
  "rule_failed_hours",
  "rule_review",
  "rule_review_hours",
  "rule_session",
  "rule_session_minutes",
  "rule_pr_review",
  "rule_pr_review_days",
  "rule_uncommitted",
  "rule_uncommitted_hours",
  "rule_idle",
  "rule_idle_days",
  "rule_behind",
  "rule_repeat",
  "rule_repeat_count",
  "rule_suggest",
  "rule_undo",
  "rule_idle_bot",
]

/** The parts of the morning brief (6.4), each on or off. */
export const BRIEF_PART_ITEMS: PersonalAgentPrefKey[] = [
  "brief_needs",
  "brief_night",
  "brief_bots",
  "brief_schedule",
  "brief_loose",
  "brief_yesterday",
]

/** The morning brief's and the wrap-up's items (6.4, 6.5). */
export const BRIEF_ITEMS: PersonalAgentPrefKey[] = [
  "brief",
  "brief_time",
  "brief_at",
  ...BRIEF_PART_ITEMS,
  "brief_suggestions",
  "wrap",
  "wrap_tonight",
  "keep_awake",
  "weekly_review",
]

/** What the desktop shows outside codeg's windows (10.10). */
export const DESKTOP_ITEMS: PersonalAgentPrefKey[] = ["menubar", "dock_badge"]

/** The items of "Proactive & notifications", the kinds of news included. */
export const PROACTIVE_ITEMS: PersonalAgentPrefKey[] = [
  "proactive",
  "urgent_via",
  "normal_via",
  "low_via",
  "focus_wait",
  ...DESKTOP_ITEMS,
  "quiet_hours",
  "quiet_from",
  "quiet_to",
  "quiet_lets",
  "morning",
  "morning_at",
  ...BRIEF_ITEMS,
  ...LEVEL_ITEMS,
  ...RULE_ITEMS,
]

interface PageProps {
  account: PersonalAgentAccount
  /** Nothing can change here: the engine runs elsewhere, or the primary
   *  is not set up. */
  disabled: boolean
}

/** One item: its title and what it does, and its choices. */
function PrefRow({
  item,
  value,
  disabled,
  onPick,
}: {
  item: PersonalAgentPrefKey
  value: PersonalAgentPrefs[PersonalAgentPrefKey]
  disabled: boolean
  onPick: (value: string | number) => void
}) {
  const t = useTranslations("PersonalAgent.settings.prefs")
  const choices = CHOICES[item]
  const id = `pa-pref-${item}`
  const [draft, setDraft] = useState<string | null>(null)
  const clock = isClockItem(item)
  const commitCount = () => {
    if (draft == null) return
    const n = Number(draft)
    setDraft(null)
    const max = COUNT_MAX[item] ?? 1000
    if (Number.isInteger(n) && n >= 0 && n <= max && n !== value) onPick(n)
  }
  const commitClock = () => {
    if (draft == null) return
    const v = draft.trim()
    setDraft(null)
    if (isClock(v) && v !== value) onPick(v)
  }
  return (
    <SettingRow
      icon={PREF_ICONS[item]}
      title={t(`${item}.title` as "reply_length.title")}
      description={t(`${item}.hint` as "reply_length.hint")}
      htmlFor={id}
      control={
        clock ? (
          <Input
            id={id}
            data-pa-pref={item}
            type="time"
            step={60}
            value={draft ?? String(value)}
            disabled={disabled}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commitClock}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitClock()
            }}
            className="h-8 w-28 bg-background text-center text-xs"
          />
        ) : choices ? (
          <Select
            value={String(value)}
            onValueChange={(v) => v !== value && onPick(v)}
            disabled={disabled}
          >
            <SelectTrigger
              id={id}
              data-pa-pref={item}
              // As wide as its choice, within reason: the long ones whole.
              className="h-8 w-auto max-w-72 min-w-44 bg-background text-xs"
            >
              {/* The choice alone: "(default)" is the open list's, room
                  kept for the choice itself. */}
              <SelectValue>
                {choices.includes(String(value))
                  ? t(choiceKey(item, String(value)) as "reply_length.short")
                  : String(value)}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {choices.map((c) => (
                <SelectItem key={c} value={c} className="text-xs">
                  {t(choiceKey(item, c) as "reply_length.short")}
                  {c === DEFAULT_PREFS[item] ? (
                    <span className="ms-1 text-muted-foreground">
                      {t("default")}
                    </span>
                  ) : null}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <Input
            id={id}
            data-pa-pref={item}
            inputMode="numeric"
            value={draft ?? String(value)}
            disabled={disabled}
            onChange={(e) =>
              setDraft(e.target.value.replace(/[^0-9]/g, "").slice(0, 4))
            }
            onBlur={commitCount}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitCount()
            }}
            className="h-8 w-20 bg-background text-center text-xs"
          />
        )
      }
    />
  )
}

/** A page's head: its title — the navigation's word for it — and at its
 *  end what the page does first ([New work assistant]) or, on a page of
 *  preferences, [Restore defaults]. */
export function PageHead({
  title,
  onRestore,
  restoreDisabled,
  action,
}: {
  title: string
  onRestore?: () => void
  restoreDisabled?: boolean
  action?: ReactNode
}) {
  const t = useTranslations("PersonalAgent.settings")
  return (
    <div className="flex min-h-8 items-center justify-between gap-4 pb-2">
      <h2 className="min-w-0 truncate text-xl leading-8 font-semibold tracking-tight">
        {title}
      </h2>
      {action ? <div className="shrink-0">{action}</div> : null}
      {onRestore ? (
        <Button
          size="sm"
          variant="ghost"
          className="shrink-0 text-muted-foreground"
          disabled={restoreDisabled}
          onClick={onRestore}
          data-pa-restore
        >
          <RotateCcw aria-hidden />
          {t("restoreDefaults")}
        </Button>
      ) : null}
    </div>
  )
}

/** Put `items` back to their defaults. */
function restoreChanges(
  prefs: PersonalAgentPrefs,
  items: PersonalAgentPrefKey[]
) {
  return items
    .filter((k) => prefs[k] !== DEFAULT_PREFS[k])
    .map((k) => ({ key: `prefs.${k}`, value: DEFAULT_PREFS[k] }))
}

export function CommunicationPage({ account, disabled }: PageProps) {
  const t = useTranslations("PersonalAgent.settings")
  const { patch } = useSettingsPatch(null)
  const prefs = account.prefs
  const restore = restoreChanges(prefs, COMMUNICATION_ITEMS)
  return (
    <div className="flex flex-col gap-3" data-pa-settings-page="communication">
      <PageHead
        title={t("nav.communication")}
        onRestore={() => void patch(restore)}
        restoreDisabled={disabled || restore.length === 0}
      />
      <SettingCard>
        {COMMUNICATION_ITEMS.map((item) => (
          <PrefRow
            key={item}
            item={item}
            value={prefs[item]}
            disabled={disabled}
            onPick={(value) => void patch([{ key: `prefs.${item}`, value }])}
          />
        ))}
      </SettingCard>
      <SettingNote icon={Send}>{t("pages.communicationNote")}</SettingNote>
    </div>
  )
}

/**
 * A level read off its items (13.4): pick one and its items take its values
 * — after a warning when that overwrites items the owner set their own way
 * (the level reads "custom" then).
 */
export function PresetPicker<L extends string>({
  item,
  levels,
  level,
  presets,
  prefs,
  icon,
  disabled,
  stacked,
  onPick,
}: {
  /** `automation_level` or `disturb_level`: its words and its patch key. */
  item: "automation_level" | "disturb_level"
  levels: readonly L[]
  level: L | "custom"
  presets: Record<L, Partial<PersonalAgentPrefs>>
  prefs: PersonalAgentPrefs
  icon: LucideIcon
  disabled: boolean
  /** The choice under the words rather than beside them (a narrow place,
   *  a card in the conversation). */
  stacked?: boolean
  onPick: (level: L) => void
}) {
  const t = useTranslations("PersonalAgent.settings")
  const tp = useTranslations("PersonalAgent.settings.prefs")
  const [confirm, setConfirm] = useState<{ level: L; count: number } | null>(
    null
  )
  const choose = (next: L) => {
    if (next === level) return
    const count = overriddenBy(prefs, presets[next]).length
    // Only a level of the owner's own making has changes to lose.
    if (level === "custom" && count > 0) {
      setConfirm({ level: next, count })
      return
    }
    onPick(next)
  }
  const word = (l: string) => tp(`${item}.${l}` as "automation_level.standard")
  const choice = (
    // One segmented control (a radio group: the arrow keys move through
    // it); a level of the owner's own making is a badge beside it, not a
    // choice in it.
    <div
      className={cn(
        "flex flex-wrap items-center gap-1.5",
        stacked ? "flex-row-reverse justify-end" : "justify-end"
      )}
    >
      {level === "custom" ? (
        <Badge
          variant="secondary"
          data-pa-level="custom"
          className="font-normal"
        >
          {word("custom")}
        </Badge>
      ) : null}
      <ToggleGroup
        type="single"
        variant="outline"
        size="sm"
        spacing={0}
        value={level === "custom" ? "" : level}
        onValueChange={(v) => {
          if (v) choose(v as L)
        }}
        disabled={disabled}
        aria-label={tp(`${item}.title` as "automation_level.title")}
        className="bg-background"
      >
        {levels.map((l) => (
          <ToggleGroupItem
            key={l}
            value={l}
            data-pa-level={l}
            className="h-7 px-3 text-xs font-normal text-muted-foreground data-[state=on]:font-medium data-[state=on]:text-foreground"
          >
            {word(l)}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
    </div>
  )
  return (
    <>
      <SettingRow
        icon={icon}
        title={tp(`${item}.title` as "automation_level.title")}
        description={tp(
          `${item}.${level}Hint` as "automation_level.standardHint"
        )}
        control={stacked ? undefined : choice}
      >
        {stacked ? choice : null}
      </SettingRow>
      <AlertDialog
        open={confirm != null}
        onOpenChange={(open) => !open && setConfirm(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {tp(`${item}.confirmTitle` as "automation_level.confirmTitle", {
                level: confirm ? word(confirm.level) : "",
              })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {tp(`${item}.confirmBody` as "automation_level.confirmBody", {
                count: confirm?.count ?? 0,
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (confirm) onPick(confirm.level)
                setConfirm(null)
              }}
            >
              {tp(`${item}.confirm` as "automation_level.confirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

export function AutomationPage({ account, disabled }: PageProps) {
  const t = useTranslations("PersonalAgent.settings")
  const { patch } = useSettingsPatch(null)
  const prefs = account.prefs
  const restore = restoreChanges(prefs, [
    ...AUTOMATION_ITEMS,
    ...(Object.keys(AUTOMATION_PRESETS.standard) as PersonalAgentPrefKey[]),
  ])
  return (
    <div className="flex flex-col gap-3" data-pa-settings-page="automation">
      <PageHead
        title={t("nav.automation")}
        onRestore={() => void patch(restore)}
        restoreDisabled={disabled || restore.length === 0}
      />
      <SettingCard>
        <PresetPicker
          item="automation_level"
          levels={["standard", "ask_more"] as const}
          level={account.automation_level}
          presets={AUTOMATION_PRESETS}
          prefs={prefs}
          icon={Gauge}
          disabled={disabled}
          onPick={(level) =>
            void patch([{ key: "prefs.automation_level", value: level }])
          }
        />
      </SettingCard>
      <SettingCard>
        {AUTOMATION_ITEMS.map((item) => (
          <PrefRow
            key={item}
            item={item}
            value={prefs[item]}
            disabled={disabled}
            onPick={(value) => void patch([{ key: `prefs.${item}`, value }])}
          />
        ))}
      </SettingCard>
      <SettingNote icon={ShieldCheck}>{t("pages.automationNote")}</SettingNote>
    </div>
  )
}

/** The disturbance level the items add up to, when the backend did not
 *  say (an older one): read off them as it would. */
export function disturbOf(
  account: PersonalAgentAccount
): "quiet" | "standard" | "more" | "custom" {
  if (account.disturb_level) return account.disturb_level
  for (const l of ["quiet", "standard", "more"] as const) {
    if (overriddenBy(account.prefs, DISTURB_PRESETS[l]).length === 0) return l
  }
  return "custom"
}

/** "Proactive & notifications" (13.5, 1.13): how much the assistants may
 *  interrupt the owner, and when they hold back. */
export function ProactivePage({ account, disabled }: PageProps) {
  const t = useTranslations("PersonalAgent.settings")
  const { patch } = useSettingsPatch(null)
  const prefs = account.prefs
  const restore = restoreChanges(prefs, PROACTIVE_ITEMS)
  const row = (item: PersonalAgentPrefKey) => (
    <PrefRow
      key={item}
      item={item}
      value={prefs[item]}
      disabled={disabled}
      onPick={(value) => void patch([{ key: `prefs.${item}`, value }])}
    />
  )
  return (
    <div className="flex flex-col gap-3" data-pa-settings-page="proactive">
      <PageHead
        title={t("nav.proactive")}
        onRestore={() => void patch(restore)}
        restoreDisabled={disabled || restore.length === 0}
      />
      <SettingCard>
        <PresetPicker
          item="disturb_level"
          levels={["quiet", "standard", "more"] as const}
          level={disturbOf(account)}
          presets={DISTURB_PRESETS}
          prefs={prefs}
          icon={Gauge}
          disabled={disabled}
          onPick={(level) =>
            void patch([{ key: "prefs.disturb_level", value: level }])
          }
        />
      </SettingCard>
      <SettingCard>
        {(
          [
            "proactive",
            "urgent_via",
            "normal_via",
            "low_via",
            "focus_wait",
          ] as const
        ).map(row)}
      </SettingCard>
      {isDesktop() ? (
        <SettingCard data-pa-pref-group="desktop">
          {DESKTOP_ITEMS.map(row)}
        </SettingCard>
      ) : null}
      <SettingCard data-pa-pref-group="quiet">
        {row("quiet_hours")}
        {prefs.quiet_hours === "fixed"
          ? (["quiet_from", "quiet_to"] as const).map(row)
          : null}
        {row("quiet_lets")}
      </SettingCard>
      <SettingCard data-pa-pref-group="morning">
        {row("morning")}
        {prefs.morning === "fixed" ? row("morning_at") : null}
      </SettingCard>
      <SettingCard data-pa-pref-group="brief">
        {row("brief")}
        {prefs.brief === "on" ? (
          <>
            {row("brief_time")}
            {prefs.brief_time === "fixed" ? row("brief_at") : null}
            {BRIEF_PART_ITEMS.map(row)}
            {row("brief_suggestions")}
          </>
        ) : null}
      </SettingCard>
      <SettingCard data-pa-pref-group="wrap">
        {row("wrap")}
        {row("wrap_tonight")}
        {isDesktop() ? row("keep_awake") : null}
        {row("weekly_review")}
      </SettingCard>
      <ProposalRules prefs={prefs} disabled={disabled} />
      <div className="space-y-1.5">
        <h3 className="flex items-center gap-1.5 px-1 text-xs font-medium text-muted-foreground">
          <Layers className="size-3.5" aria-hidden />
          {t("pages.byKind")}
        </h3>
        <p className="px-1 text-xs leading-5 text-muted-foreground">
          {t("pages.byKindHint")}
        </p>
        <SettingCard data-pa-pref-group="levels">
          {LEVEL_ITEMS.map(row)}
        </SettingCard>
      </div>
      <SettingNote icon={Bell}>{t("pages.proactiveNote")}</SettingNote>
    </div>
  )
}
