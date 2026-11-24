"use client"

import { useTranslations } from "next-intl"

import type { StepProgress } from "@/lib/activity/progress"
import { cn } from "@/lib/utils"

/**
 * `+3 ▬▬▬▬▬▬` — a sub-agent's finished steps, one segment each, latest last,
 * colored by how each ended; while it is still working, a dashed segment for
 * the step in hand. Not a progress bar: nobody knows the total while it runs,
 * so it only ever grows. Past the last `MAX_STEP_MARKS` steps the older ones
 * are counted in front.
 */
export function StepBar({
  progress,
  live = false,
  className,
}: {
  progress: StepProgress
  live?: boolean
  className?: string
}) {
  const t = useTranslations("Folder.chat.activity")
  const hidden = progress.steps - progress.marks.length
  const failed = progress.marks.filter((mark) => mark === "failed").length
  const label = [
    t("header.steps", { count: progress.steps }),
    failed > 0 ? t("header.failed", { count: failed }) : null,
  ]
    .filter(Boolean)
    .join(t("row.listJoiner"))
  if (progress.marks.length === 0 && !live) return null
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className={cn("inline-flex shrink-0 items-center gap-0.5", className)}
    >
      {hidden > 0 ? (
        <span
          aria-hidden="true"
          className="activity-mono me-1 text-2xs text-muted-foreground"
        >
          +{hidden}
        </span>
      ) : null}
      {progress.marks.map((mark, index) => (
        <span
          key={index}
          aria-hidden="true"
          className={cn(
            "h-1.5 w-2.5 rounded-full",
            mark === "failed" ? "bg-tone-danger" : "bg-activity-ring"
          )}
        />
      ))}
      {live ? (
        <span
          aria-hidden="true"
          className="h-1.5 w-2.5 rounded-full border border-dashed border-activity-ring"
        />
      ) : null}
    </span>
  )
}
