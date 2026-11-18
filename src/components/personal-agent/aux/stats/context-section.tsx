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

import { PanelCard } from "../../panel-section"
import { useWhen } from "./status-rows"

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

/** The context: how full it is, against the threshold where codeg compacts
 *  it, what the reading comes from, the last compaction — and, when
 *  compaction stopped working for this session, the way to resume it. */
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
  return (
    <PanelCard
      fold="status.context"
      title={t("context")}
      // No reading: nothing in the header, the card says why.
      summary={percent == null ? null : `${Math.round(percent)}%`}
    >
      <div className="flex flex-col gap-1">
        <ContextMeter
          percent={percent}
          threshold={status.auto_compact_percent}
        />
        <p className="mt-2 text-xs leading-5 text-muted-foreground">
          {status.auto_compact_percent > 0
            ? t("threshold", { percent: status.auto_compact_percent })
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
          <div className="mt-1.5 flex items-center justify-between gap-2 rounded-lg bg-amber-500/10 px-2.5 py-1.5 text-xs">
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
    </PanelCard>
  )
}
