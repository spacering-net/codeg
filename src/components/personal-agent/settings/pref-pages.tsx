"use client"

/**
 * The preference pages every assistant shares (13.5): "Communication" and
 * "Dispatch & automation". Each item saves the moment it changes; the page's
 * [Restore defaults] puts its items back. The automation level is read off
 * its items — choose a level and they take its values; change one of them
 * and the level reads "custom".
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import {
  Gauge,
  HandHelping,
  LayoutGrid,
  MessageCircleQuestion,
  MessagesSquare,
  Repeat,
  RotateCcw,
  Send,
  ShieldCheck,
  SlidersHorizontal,
  Text,
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
  },
  ask_more: {
    confirm_dispatch: "code",
    followups: "ask",
    messages: "ask",
    chat_changes: "show",
  },
}

/** The items a level would change from what they are now. */
export function overriddenBy(
  prefs: PersonalAgentPrefs,
  level: "standard" | "ask_more"
): PersonalAgentPrefKey[] {
  return (
    Object.entries(AUTOMATION_PRESETS[level]) as [
      PersonalAgentPrefKey,
      unknown,
    ][]
  )
    .filter(([k, v]) => prefs[k] !== v)
    .map(([k]) => k)
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
}

export const COMMUNICATION_ITEMS: PersonalAgentPrefKey[] = [
  "reply_length",
  "cards",
  "when_unsure",
  "chat_changes",
]

export const AUTOMATION_ITEMS: PersonalAgentPrefKey[] = [
  "confirm_dispatch",
  "followups",
  "messages",
  "worker_handoff",
  "loop_rounds",
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
  const commitCount = () => {
    if (draft == null) return
    const n = Number(draft)
    setDraft(null)
    if (Number.isInteger(n) && n >= 0 && n <= 1000 && n !== value) onPick(n)
  }
  return (
    <SettingRow
      icon={ICONS[item]}
      title={t(`${item}.title` as "reply_length.title")}
      description={t(`${item}.hint` as "reply_length.hint")}
      htmlFor={id}
      control={
        choices ? (
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
                  {t(`${item}.${c}` as "reply_length.short")}
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

export function AutomationPage({ account, disabled }: PageProps) {
  const t = useTranslations("PersonalAgent.settings")
  const tp = useTranslations("PersonalAgent.settings.prefs")
  const { patch } = useSettingsPatch(null)
  const prefs = account.prefs
  const level = account.automation_level
  const [confirm, setConfirm] = useState<{
    level: "standard" | "ask_more"
    count: number
  } | null>(null)
  const restore = restoreChanges(prefs, [
    ...AUTOMATION_ITEMS,
    ...(Object.keys(AUTOMATION_PRESETS.standard) as PersonalAgentPrefKey[]),
  ])
  const choose = (next: "standard" | "ask_more") => {
    if (next === level) return
    const count = overriddenBy(prefs, next).length
    // Only a level of the owner's own making has changes to lose.
    if (level === "custom" && count > 0) {
      setConfirm({ level: next, count })
      return
    }
    void patch([{ key: "prefs.automation_level", value: next }])
  }
  return (
    <div className="flex flex-col gap-3" data-pa-settings-page="automation">
      <PageHead
        title={t("nav.automation")}
        description={t("pages.automation")}
        onRestore={() => void patch(restore)}
        restoreDisabled={disabled || restore.length === 0}
      />
      <SettingCard>
        <SettingRow
          icon={Gauge}
          title={tp("automation_level.title")}
          description={tp(
            `automation_level.${level}Hint` as "automation_level.standardHint"
          )}
          control={
            <div
              role="radiogroup"
              aria-label={tp("automation_level.title")}
              className="inline-flex rounded-lg border border-border/70 bg-background p-0.5"
            >
              {(["standard", "ask_more"] as const).map((l) => (
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
                  {tp(`automation_level.${l}` as "automation_level.standard")}
                </button>
              ))}
              {level === "custom" ? (
                <span
                  data-pa-level="custom"
                  className="rounded-md bg-muted px-2.5 py-1 text-xs text-foreground"
                >
                  {tp("automation_level.custom")}
                </span>
              ) : null}
            </div>
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
      <AlertDialog
        open={confirm != null}
        onOpenChange={(open) => !open && setConfirm(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {tp("automation_level.confirmTitle", {
                level: confirm
                  ? tp(
                      `automation_level.${confirm.level}` as "automation_level.standard"
                    )
                  : "",
              })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {tp("automation_level.confirmBody", {
                count: confirm?.count ?? 0,
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (confirm) {
                  void patch([
                    { key: "prefs.automation_level", value: confirm.level },
                  ])
                }
                setConfirm(null)
              }}
            >
              {tp("automation_level.confirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
