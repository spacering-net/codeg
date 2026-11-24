"use client"

import { memo } from "react"
import { useTranslations } from "next-intl"

import type { ActivityStep } from "@/lib/activity/types"
import { PlanEntriesList } from "../../plan-card"
import { ActivityRow } from "../activity-row"
import { useDisclosure } from "../disclosure-store"
import { RailIcon } from "../rail-icon"
import { PLAN_ICON, useStatusText } from "../step-visuals"

type PlanStep = Extract<ActivityStep, { type: "plan" }>

/**
 * `Updated plan · Wire the report filter   3/5`. The plan being written right
 * now opens by itself; an older update stays folded (the newest one says where
 * things stand).
 */
export const PlanRow = memo(function PlanRow({ step }: { step: PlanStep }) {
  const t = useTranslations("Folder.chat.activity")
  const statusText = useStatusText()
  const { entries, isStreaming } = step.part
  const [open, setOpen] = useDisclosure(step.key, { defaultOpen: isStreaming })
  if (entries.length === 0) return null
  const done = entries.filter((e) => e.status === "completed").length
  const current =
    entries.find((e) => e.status === "in_progress") ??
    entries.find((e) => e.status !== "completed")
  const status = isStreaming ? "running" : "succeeded"

  return (
    <ActivityRow
      stepKey={step.key}
      status={status}
      marker={
        <RailIcon
          icon={PLAN_ICON}
          status={status}
          label={`${t("kind.plan")}, ${statusText(status)}`}
        />
      }
      expandable
      expanded={open}
      onExpandedChange={setOpen}
      title={current?.content}
      trailing={`${done}/${entries.length}`}
      detail={() => (
        <PlanEntriesList entries={entries} isStreaming={isStreaming} />
      )}
    >
      <span className="flex min-w-0 items-baseline gap-2">
        <span className="shrink-0 font-medium text-activity-secondary">
          {t("row.planUpdated")}
        </span>
        {current ? (
          <span className="min-w-0 truncate text-activity-secondary" dir="auto">
            {current.content}
          </span>
        ) : null}
      </span>
    </ActivityRow>
  )
})
