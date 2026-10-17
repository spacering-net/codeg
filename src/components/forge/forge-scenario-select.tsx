"use client"

import { useTranslations } from "next-intl"

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import type { ForgeScenarioId } from "@/lib/types"

/** Literal message keys per scenario — `t()` is typed against the schema, so
 *  these cannot be computed. Shared shape with the trigger dialog's own map;
 *  kept apart from it because the settings surfaces need the LABEL only, not
 *  the trigger hint ("what this will do"). */
export const SCENARIO_LABELS = {
  fix: "scenarioFix",
  plan_first: "scenarioPlanFirst",
  review_fix: "scenarioReviewFix",
  review_only: "scenarioReviewOnly",
} as const satisfies Record<ForgeScenarioId, string>

/** A compact picker over one kind's scenarios, for the panel settings. */
export function ScenarioSelect({
  label,
  value,
  options,
  onChange,
  disabled,
}: {
  label: string
  value: ForgeScenarioId
  options: ForgeScenarioId[]
  onChange: (next: ForgeScenarioId) => void
  disabled?: boolean
}) {
  const t = useTranslations("Forge")
  return (
    <Select
      value={value}
      onValueChange={(v) => onChange(v as ForgeScenarioId)}
      disabled={disabled}
    >
      <SelectTrigger
        className="h-8 w-44 bg-background text-xs"
        aria-label={label}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((id) => (
          <SelectItem key={id} value={id} className="text-xs">
            {t(SCENARIO_LABELS[id])}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
