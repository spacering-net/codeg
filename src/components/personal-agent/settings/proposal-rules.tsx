"use client"

/**
 * "Proposal cards" on "Proactive & notifications" (13.5, 6.7): each of
 * codeg's rules on or off, with its threshold. A rule the owner muted from a
 * card ("Don't suggest these") is off here, and says so; one codeg lowered
 * after three of its cards were dismissed in a row says that, with [Put it
 * back].
 */

import { useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { Lightbulb } from "lucide-react"

import { SettingCard, SettingRow } from "@/components/shared/setting-card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import { personalAgentRuleReset, personalAgentRules } from "@/lib/api"
import type {
  PersonalAgentPrefKey,
  PersonalAgentPrefs,
  ProposalRule,
  ProposalRuleView,
} from "@/lib/types"
import { PROPOSAL_RULES } from "@/lib/types"

import { useSettingsPatch } from "./use-settings"

/** Each rule's threshold item and its unit, when it has one. */
const AFTER: Partial<
  Record<
    ProposalRule,
    { key: PersonalAgentPrefKey; unit: "hours" | "minutes" | "days" | "times" }
  >
> = {
  failed: { key: "rule_failed_hours", unit: "hours" },
  review: { key: "rule_review_hours", unit: "hours" },
  session: { key: "rule_session_minutes", unit: "minutes" },
  pr_review: { key: "rule_pr_review_days", unit: "days" },
  uncommitted: { key: "rule_uncommitted_hours", unit: "hours" },
  idle: { key: "rule_idle_days", unit: "days" },
  repeat: { key: "rule_repeat_count", unit: "times" },
}

/** The most each threshold takes (`PrefKind::Count`). */
const MAX: Record<"hours" | "minutes" | "days" | "times", number> = {
  hours: 720,
  minutes: 1440,
  days: 90,
  times: 20,
}

export function ProposalRules({
  prefs,
  disabled,
}: {
  prefs: PersonalAgentPrefs
  disabled: boolean
}) {
  const t = useTranslations("PersonalAgent.rules.prefs")
  const { patch } = useSettingsPatch(null)
  const [views, setViews] = useState<ProposalRuleView[]>([])
  // Read again whenever an item changes: a rule muted from a card is off.
  const stamp = PROPOSAL_RULES.map(
    (r) => prefs[`rule_${r}` as PersonalAgentPrefKey]
  ).join(",")
  useEffect(() => {
    let alive = true
    personalAgentRules()
      .then((v) => {
        if (alive) setViews(v)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [stamp])
  const viewOf = (r: ProposalRule) => views.find((v) => v.rule === r)
  const putBack = (r: ProposalRule) => {
    personalAgentRuleReset(r)
      .then(setViews)
      .catch(() => {})
  }
  return (
    <div className="space-y-1.5" data-pa-pref-group="rules">
      <h3 className="flex items-center gap-1.5 px-1 text-xs font-medium text-muted-foreground">
        <Lightbulb className="size-3.5" aria-hidden />
        {t("title")}
      </h3>
      <p className="px-1 text-xs leading-5 text-muted-foreground">
        {t("hint")}
      </p>
      <SettingCard>
        {PROPOSAL_RULES.map((r) => (
          <RuleRow
            key={r}
            rule={r}
            prefs={prefs}
            view={viewOf(r)}
            disabled={disabled}
            onSet={(key, value) => void patch([{ key: `prefs.${key}`, value }])}
            onPutBack={() => putBack(r)}
          />
        ))}
      </SettingCard>
    </div>
  )
}

function RuleRow({
  rule,
  prefs,
  view,
  disabled,
  onSet,
  onPutBack,
}: {
  rule: ProposalRule
  prefs: PersonalAgentPrefs
  view: ProposalRuleView | undefined
  disabled: boolean
  onSet: (key: PersonalAgentPrefKey, value: string | number) => void
  onPutBack: () => void
}) {
  const t = useTranslations("PersonalAgent.rules.prefs")
  const switchKey = `rule_${rule}` as PersonalAgentPrefKey
  const on = prefs[switchKey] === "on"
  const after = AFTER[rule]
  const value = after ? Number(prefs[after.key]) : null
  const [draft, setDraft] = useState<string | null>(null)
  const commit = () => {
    if (draft == null || !after) return
    const n = Number(draft)
    setDraft(null)
    const min = after.unit === "times" ? 2 : 0
    if (
      Number.isInteger(n) &&
      n >= min &&
      n <= MAX[after.unit] &&
      n !== value
    ) {
      onSet(after.key, n)
    }
  }
  const id = `pa-rule-${rule}`
  const marks: React.ReactNode[] = []
  if (!on && view?.muted_at) marks.push(t("mutedMark"))
  if (view?.quiet_since) {
    marks.push(
      <span key="quiet" className="text-amber-700 dark:text-amber-300">
        {t("loweredMark")}{" "}
        <Button
          variant="link"
          size="xs"
          className="h-auto p-0 text-xs"
          disabled={disabled}
          onClick={onPutBack}
          data-pa-rule-put-back={rule}
        >
          {t("putBack")}
        </Button>
      </span>
    )
  }
  if (view && view.raised > 0) {
    marks.push(
      t("counts", {
        raised: view.raised,
        acted: view.acted,
        dismissed: view.dismissed,
      })
    )
  }
  return (
    <SettingRow
      title={t(`${rule}.title` as "failed.title")}
      description={
        <>
          {t(`${rule}.hint` as "failed.hint")}
          {marks.map((m, i) => (
            <span key={i} className="block">
              {m}
            </span>
          ))}
        </>
      }
      htmlFor={id}
      control={
        <span className="flex items-center gap-2" data-pa-rule-row={rule}>
          {after && on ? (
            <span className="flex items-center gap-1 text-xs text-muted-foreground">
              <Input
                aria-label={t(`unit.${after.unit}` as "unit.hours")}
                data-pa-rule-after={rule}
                inputMode="numeric"
                value={draft ?? String(value ?? "")}
                disabled={disabled}
                onChange={(e) =>
                  setDraft(e.target.value.replace(/[^0-9]/g, "").slice(0, 4))
                }
                onBlur={commit}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commit()
                }}
                className="h-8 w-16 bg-background text-center text-xs"
              />
              {t(`unit.${after.unit}` as "unit.hours")}
            </span>
          ) : null}
          <Switch
            id={id}
            data-pa-rule-switch={rule}
            checked={on}
            disabled={disabled}
            onCheckedChange={(v) => onSet(switchKey, v ? "on" : "off")}
          />
        </span>
      }
    />
  )
}
