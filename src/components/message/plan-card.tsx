"use client"

import { memo } from "react"
import { useTranslations } from "next-intl"
import type { PlanEntryInfo } from "@/lib/types"
import { cn } from "@/lib/utils"
import {
  CheckCircle2Icon,
  CircleDashedIcon,
  CircleDotIcon,
  Loader2Icon,
} from "lucide-react"

// ── Shared status/priority label + style helpers ──────────────────────
// Single source of truth for plan entry labels/colors, shared by the timeline's
// plan row and <AgentPlanOverlay> (floating chip) so the two surfaces never
// drift.

export type StatusKey =
  | "status.completed"
  | "status.inProgress"
  | "status.pending"
  | "status.unknown"

export function getStatusKey(status: string): StatusKey {
  switch (status) {
    case "completed":
      return "status.completed"
    case "in_progress":
      return "status.inProgress"
    case "pending":
      return "status.pending"
    default:
      return "status.unknown"
  }
}

export type PriorityKey =
  | "priority.high"
  | "priority.medium"
  | "priority.low"
  | "priority.unknown"

export function getPriorityKey(priority: string): PriorityKey {
  switch (priority) {
    case "high":
      return "priority.high"
    case "medium":
      return "priority.medium"
    case "low":
      return "priority.low"
    default:
      return "priority.unknown"
  }
}

export function getPriorityClassName(priority: string): string {
  switch (priority) {
    case "high":
      return "text-tone-danger bg-tone-danger/10 border-tone-danger/20"
    case "medium":
      return "text-tone-warning bg-tone-warning/10 border-tone-warning/20"
    case "low":
      return "text-muted-foreground bg-muted border-border"
    default:
      return "text-muted-foreground"
  }
}

function StatusIcon({
  status,
  isStreaming,
}: {
  status: string
  isStreaming: boolean
}) {
  // Centred on the entry's 1.5rem line. A finished step is grey like the
  // timeline's finished steps; the one in progress is the one in ink.
  const className = "mt-[0.3125rem] size-3.5 shrink-0"
  if (status === "completed") {
    return (
      <CheckCircle2Icon
        aria-hidden="true"
        className={cn(className, "text-muted-foreground")}
      />
    )
  }
  if (status === "in_progress") {
    return isStreaming ? (
      <Loader2Icon
        aria-hidden="true"
        className={cn(className, "animate-spin text-foreground/80")}
      />
    ) : (
      <CircleDotIcon
        aria-hidden="true"
        className={cn(className, "text-foreground/80")}
      />
    )
  }
  return (
    <CircleDashedIcon
      aria-hidden="true"
      className={cn(className, "text-muted-foreground")}
    />
  )
}

/**
 * The plan entry rows (checklist body) of the timeline's plan and todo rows:
 * one line per step, set in the row's content column — the status glyph under
 * the row's label, the priority at the end, under the row's own figure.
 */
export const PlanEntriesList = memo(function PlanEntriesList({
  entries,
  isStreaming = false,
}: {
  entries: PlanEntryInfo[]
  isStreaming?: boolean
}) {
  const t = useTranslations("Folder.chat.agentPlanOverlay")

  if (entries.length === 0) return null
  // A priority every step shares says nothing — agents that send none get
  // "medium" throughout — so only a plan that ranks its steps shows them.
  const ranked = new Set(entries.map((entry) => entry.priority)).size > 1

  return (
    <ol role="list" className="space-y-1">
      {entries.map((entry, index) => (
        <li
          key={`${entry.content}-${index}`}
          className="flex items-start gap-2.5 text-start text-sm leading-6"
        >
          <StatusIcon status={entry.status} isStreaming={isStreaming} />
          <span className="sr-only">{t(getStatusKey(entry.status))}</span>
          <span
            dir="auto"
            className={cn(
              "min-w-0 break-words [overflow-wrap:anywhere]",
              entry.status === "completed"
                ? "text-muted-foreground"
                : entry.status === "in_progress"
                  ? "font-medium text-foreground"
                  : "text-foreground/90"
            )}
          >
            {entry.content}
          </span>
          {ranked ? (
            <span className="activity-mono ms-auto shrink-0 ps-3 text-xs leading-6 text-muted-foreground">
              {t(getPriorityKey(entry.priority))}
            </span>
          ) : null}
        </li>
      ))}
    </ol>
  )
})
