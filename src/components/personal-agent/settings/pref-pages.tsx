"use client"

/**
 * The preference pages every assistant shares (13.5): "Communication",
 * "Proactive & notifications" and "Dispatch & automation". Each item saves
 * the moment it changes; the page's [Restore defaults] puts its items back.
 * The automation level and the disturbance level are read off their items —
 * choose a level and they take its values; change one of them and the level
 * reads "custom".
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import {
  Activity,
  AlarmClock,
  ArrowLeftRight,
  BadgeCheck,
  Bell,
  BellDot,
  CircleX,
  GitMerge,
  GitPullRequest,
  GitPullRequestArrow,
  GitPullRequestDraft,
  BellRing,
  CircleAlert,
  CircleCheck,
  ClipboardCheck,
  Gauge,
  Globe,
  Hand,
  HandHelping,
  Hourglass,
  Inbox,
  Keyboard,
  Layers,
  LayoutGrid,
  ListChecks,
  MessageCircleQuestion,
  MessageSquareReply,
  MessageSquareText,
  MessagesSquare,
  Moon,
  MoonStar,
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
  Text,
  Timer,
  TriangleAlert,
  Undo2,
  Waypoints,
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
import { Button } from "@/components/ui/button"
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
import { cn } from "@/lib/utils"

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
  worker_handoff: "message",
  loop_rounds: 3,
  interrupt_retry: "auto",
  retry_rounds: 2,
  exec_questions: "assistant",
  exec_plans: "assistant",
  auto_accept: "on",
  accept_revise: "auto",
  accept_rounds: 3,
  forge_comment: "auto",
  issue_close: "auto",
  pr_merge: "auto",
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
  },
}

/** What each disturbance level sets (13.4, `disturb_preset`). */
export const DISTURB_PRESETS: Record<
  "quiet" | "standard" | "more",
  Partial<PersonalAgentPrefs>
> = {
  quiet: { normal_via: "today", low_via: "today" },
  standard: { normal_via: "system", low_via: "today", focus_wait: 3 },
  more: { normal_via: "system", low_via: "digest", focus_wait: 0 },
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
]

/** The items that take a time of day, `HH:MM`. */
const CLOCK_ITEMS: ReadonlySet<PersonalAgentPrefKey> = new Set([
  "quiet_from",
  "quiet_to",
  "morning_at",
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
  worker_handoff: ["message", "direct"],
  interrupt_retry: ["auto", "ask"],
  exec_questions: ["assistant", "owner"],
  exec_plans: ["assistant", "owner"],
  auto_accept: ["on", "off"],
  accept_revise: ["auto", "ask"],
  forge_comment: ["auto", "ask"],
  issue_close: ["auto", "ask"],
  pr_merge: ["auto", "ask"],
  proactive: ["on", "off"],
  urgent_via: ["system_attention", "system", "in_page"],
  normal_via: ["system", "in_page", "today"],
  low_via: ["today", "digest"],
  quiet_hours: ["auto", "fixed", "none"],
  quiet_lets: ["reminders", "urgent"],
  morning: ["hours", "fixed"],
  ...Object.fromEntries(LEVEL_ITEMS.map((k) => [k, NEWS_LEVELS])),
}

/** The most a count item takes (`PrefKind::Count`). */
const COUNT_MAX: Partial<Record<PersonalAgentPrefKey, number>> = {
  loop_rounds: 1000,
  retry_rounds: 10,
  accept_rounds: 10,
  focus_wait: 60,
}

const ICONS: Record<PersonalAgentPrefKey, LucideIcon> = {
  reply_length: Text,
  cards: LayoutGrid,
  when_unsure: MessageCircleQuestion,
  chat_changes: SlidersHorizontal,
  confirm_dispatch: ShieldCheck,
  followups: Repeat,
  messages: MessagesSquare,
  worker_handoff: HandHelping,
  loop_rounds: Waypoints,
  interrupt_retry: RotateCw,
  retry_rounds: Timer,
  exec_questions: MessageSquareReply,
  exec_plans: ListChecks,
  auto_accept: ClipboardCheck,
  accept_revise: Undo2,
  accept_rounds: Timer,
  forge_comment: MessageSquareText,
  issue_close: CircleX,
  pr_merge: GitMerge,
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
  "auto_accept",
  "accept_revise",
  "forge_comment",
  "issue_close",
  "pr_merge",
  "messages",
  "worker_handoff",
  "retry_rounds",
  "accept_rounds",
  "loop_rounds",
]

/** The items of the "About you" page (`about-page.tsx`). */
export const ABOUT_ITEMS: PersonalAgentPrefKey[] = ["time_zone", "presence"]

/** The items of "Proactive & notifications", the kinds of news included. */
export const PROACTIVE_ITEMS: PersonalAgentPrefKey[] = [
  "proactive",
  "urgent_via",
  "normal_via",
  "low_via",
  "focus_wait",
  "quiet_hours",
  "quiet_from",
  "quiet_to",
  "quiet_lets",
  "morning",
  "morning_at",
  ...LEVEL_ITEMS,
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
      icon={ICONS[item]}
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
              className="h-8 w-44 bg-background text-xs"
            >
              <SelectValue />
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

/** A page's heading: its title and what it is for, and [Restore defaults]. */
export function PageHead({
  title,
  description,
  onRestore,
  restoreDisabled,
}: {
  title: string
  description?: string
  onRestore?: () => void
  restoreDisabled?: boolean
}) {
  const t = useTranslations("PersonalAgent.settings")
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0 space-y-1">
        <h2 className="text-sm font-semibold">{title}</h2>
        {description ? (
          <p className="text-xs leading-5 text-muted-foreground">
            {description}
          </p>
        ) : null}
      </div>
      {onRestore ? (
        <Button
          size="sm"
          variant="ghost"
          className="shrink-0 text-muted-foreground"
          disabled={restoreDisabled}
          onClick={onRestore}
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
        description={t("pages.communication")}
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
  return (
    <>
      <SettingRow
        icon={icon}
        title={tp(`${item}.title` as "automation_level.title")}
        description={tp(
          `${item}.${level}Hint` as "automation_level.standardHint"
        )}
        control={
          <div
            role="radiogroup"
            aria-label={tp(`${item}.title` as "automation_level.title")}
            className="inline-flex flex-wrap rounded-lg border border-border/70 bg-background p-0.5"
          >
            {levels.map((l) => (
              <button
                key={l}
                type="button"
                role="radio"
                aria-checked={level === l}
                data-pa-level={l}
                disabled={disabled}
                onClick={() => choose(l)}
                className={cn(
                  "rounded-md px-2.5 py-1 text-xs transition-colors disabled:opacity-50",
                  level === l
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                {word(l)}
              </button>
            ))}
            {level === "custom" ? (
              <span
                data-pa-level="custom"
                className="rounded-md bg-muted px-2.5 py-1 text-xs text-foreground"
              >
                {word("custom")}
              </span>
            ) : null}
          </div>
        }
      />
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
        description={t("pages.automation")}
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
        description={t("pages.proactive")}
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
