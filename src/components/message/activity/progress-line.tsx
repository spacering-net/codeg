"use client"

import { useTranslations } from "next-intl"
import { ArrowUpRightIcon } from "lucide-react"

import { Skeleton } from "@/components/ui/skeleton"
import type { StepProgress } from "@/lib/activity/progress"
import { cn } from "@/lib/utils"
import { StepBar } from "./step-bar"

/**
 * The line under a sub-agent's or a delegation's title: its steps, what it is
 * doing now — or, once done, the first line of its result — and "Open
 * conversation ↗" when it has a conversation of its own. While it works with
 * nothing to show yet, a skeleton holds the place of the steps and the text,
 * so the line is neither empty nor late to appear.
 */
export function ProgressLine({
  progress,
  working,
  summary,
  summaryLive,
  onOpenSession,
}: {
  progress: StepProgress | null
  /** Still at it: the step bar ends on the step in hand. */
  working: boolean
  summary: string | null
  /** The summary says what it is doing now, not how it ended. */
  summaryLive: boolean
  onOpenSession: (() => void) | null
}) {
  const t = useTranslations("Folder.chat.delegation")
  const placeholder = working && !progress && !summary
  if (!progress && !summary && !onOpenSession && !placeholder) return null
  return (
    <div className="flex min-w-0 items-center gap-3 pb-0.5 text-sm">
      {progress ? <StepBar progress={progress} live={working} /> : null}
      {summary ? (
        <span
          dir="auto"
          className={cn(
            "min-w-0 flex-1 truncate",
            summaryLive ? "activity-shimmer" : "text-muted-foreground"
          )}
          title={summary}
        >
          {summary}
        </span>
      ) : placeholder ? (
        <div
          aria-hidden="true"
          className="flex min-w-0 flex-1 items-center gap-3"
        >
          <Skeleton className="h-1.5 w-10 shrink-0 rounded-full bg-foreground/10 motion-reduce:animate-none" />
          <Skeleton className="h-2 w-full max-w-60 rounded-full bg-foreground/10 motion-reduce:animate-none" />
        </div>
      ) : (
        <span className="flex-1" />
      )}
      {onOpenSession ? (
        <button
          type="button"
          onClick={onOpenSession}
          className="inline-flex shrink-0 items-center gap-0.5 rounded-sm text-sm text-foreground/80 underline-offset-2 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {t("openDetail")}
          <ArrowUpRightIcon
            aria-hidden="true"
            className="size-3.5 rtl:-scale-x-100"
          />
        </button>
      ) : null}
    </div>
  )
}
