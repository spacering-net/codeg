"use client"

/** Its context: how full it is, against the threshold where codeg
 *  compacts it. */

import { useState } from "react"
import { useTranslations } from "next-intl"
import { Play } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { useBotId } from "@/contexts/personal-agent-context"
import { personalAgentResumeAutoCompact } from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"
import type { PersonalAgentSnapshot } from "@/lib/types"
import { cn } from "@/lib/utils"

import { PANEL_SURFACE } from "../../panel-section"
import { useWhen } from "./runtime-card"

/** How full the context is: shadcn's progress bar, amber past the
 *  auto-compaction threshold, which is a tick across it. */
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
    <div className="relative">
      <Progress
        value={percent == null ? null : Math.round(ratio)}
        // shadcn's bar draws the value but leaves it off the root.
        aria-valuenow={percent == null ? undefined : Math.round(ratio)}
        className={cn(
          // Filled from the reading's start in either direction.
          "h-1.5 bg-foreground/10 rtl:-scale-x-100",
          hot && "[&>[data-slot=progress-indicator]]:bg-amber-500"
        )}
      />
      {threshold > 0 && threshold < 100 ? (
        <span
          aria-hidden
          className="absolute -top-1 h-3.5 w-0.5 -translate-x-1/2 rounded-full bg-foreground/50 ring-2 ring-card rtl:translate-x-1/2"
          style={{ insetInlineStart: `${threshold}%` }}
        />
      ) : null}
    </div>
  )
}

/** The context, a card of its own: how full it is in its head, the meter
 *  under it with its scale — 0, where codeg compacts it, 100% — then what
 *  the reading comes from, the last compaction and, when compaction stopped
 *  working for this session, the way to resume it. */
export function ContextSection({
  snapshot,
  readOnly,
}: {
  snapshot: PersonalAgentSnapshot
  readOnly: boolean
}) {
  const t = useTranslations("PersonalAgent.status")
  const to = useTranslations("PersonalAgent.overview")
  const when = useWhen()
  const [resuming, setResuming] = useState(false)
  const botId = useBotId()
  const { status } = snapshot
  const seg = status.segment
  const last = status.last_compaction
  const percent = status.usage?.percent ?? null
  const threshold = status.auto_compact_percent
  const marked = threshold > 0 && threshold < 100
  return (
    <section
      data-pa-context
      className={cn(PANEL_SURFACE, "flex min-w-0 flex-col gap-3 p-4")}
    >
      <div className="flex min-w-0 items-center justify-between gap-2">
        <h3 className="min-w-0 truncate text-sm font-semibold">
          {t("context")}
        </h3>
        {/* No reading: a dash, the card says why. */}
        <span
          data-pa-context-reading
          className="shrink-0 text-sm font-medium tabular-nums"
        >
          {percent == null ? "—" : `${Math.round(percent)}%`}
        </span>
      </div>
      <div className="flex min-w-0 flex-col gap-1.5">
        <ContextMeter percent={percent} threshold={threshold} />
        {/* Its scale: the ends, and where codeg compacts it — an end left
            out where the mark's words would run into it. */}
        <div
          aria-hidden
          className="relative h-4 text-[0.6875rem] leading-4 text-muted-foreground tabular-nums"
        >
          {!marked || threshold >= 15 ? (
            <span className="absolute start-0">0</span>
          ) : null}
          {marked ? (
            <span
              className="absolute -translate-x-1/2 whitespace-nowrap rtl:translate-x-1/2"
              style={{ insetInlineStart: `${threshold}%` }}
            >
              {t("thresholdMark", { percent: threshold })}
            </span>
          ) : null}
          {!marked || threshold <= 85 ? (
            <span className="absolute end-0">100%</span>
          ) : null}
        </div>
      </div>
      <div className="flex min-w-0 flex-col gap-0.5">
        {/* Where it compacts, in words: for a screen reader where the scale
            marks it; for everyone where it does not. */}
        <p
          className={
            marked ? "sr-only" : "text-xs leading-5 text-muted-foreground"
          }
        >
          {threshold > 0
            ? t("threshold", { percent: threshold })
            : t("thresholdOff")}
        </p>
        <p className="text-xs leading-5 text-muted-foreground">
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
          <p className="text-xs leading-5 text-muted-foreground">
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
          <div className="mt-1.5 flex items-center justify-between gap-2 rounded-xl bg-amber-500/10 px-3 py-2 text-xs">
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
              <Play aria-hidden />
              {t("resume")}
            </Button>
          </div>
        ) : null}
      </div>
    </section>
  )
}
