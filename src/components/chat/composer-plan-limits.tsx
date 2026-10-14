"use client"

import { useEffect, useState } from "react"
import { Hourglass } from "lucide-react"
import { useLocale, useTranslations } from "next-intl"
import {
  useComposerConnection,
  useComposerSessionStats,
} from "@/components/chat/use-composer-session"
import {
  headlinePlanLimit,
  isPlanLimitReset,
  planLimitTone,
  planLimitsStaleSince,
  timeUntil,
  type PlanLimitTone,
} from "@/lib/plan-limits"
import type { PlanLimitWindow } from "@/lib/types"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { cn } from "@/lib/utils"

/** The countdown moves by the minute; half a minute keeps it honest. */
const TICK_MS = 30_000

const TONE_TEXT: Record<PlanLimitTone, string> = {
  normal: "",
  warning: "text-amber-600 dark:text-amber-400",
  reached: "text-destructive",
}

const TONE_BAR: Record<PlanLimitTone, string> = {
  normal: "bg-foreground/70",
  warning: "bg-amber-500",
  reached: "bg-destructive",
}

/** Unix seconds, refreshed while mounted. Kept in state rather than read
 *  during render, which would be impure. */
function useNowSeconds(): number {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000))
  useEffect(() => {
    const id = window.setInterval(
      () => setNow(Math.floor(Date.now() / 1000)),
      TICK_MS
    )
    return () => window.clearInterval(id)
  }, [])
  return now
}

/**
 * The subscription plan's usage windows (5-hour, weekly, …) for this tab's
 * agent account, shown in the row below the composer: the countdown to the
 * reset of the window closest to its limit, and every window in a popover.
 *
 * The figures are the agent's own — Claude reports them live and the backend
 * shares them among the agent's connections on the same settings; Codex
 * records them in its transcript (session stats), so the popover says how old
 * they are once that is a while. Nothing renders for API-key sign-ins, which
 * have no plan windows, or once every known window has reset.
 */
export function ComposerPlanLimits({ tabId }: { tabId: string | null }) {
  const t = useTranslations("Folder.statusBar.planLimits")
  const locale = useLocale()
  const conn = useComposerConnection(tabId)
  const sessionStats = useComposerSessionStats(tabId)
  const now = useNowSeconds()

  const live = conn?.planLimits ?? []
  const windows = live.length > 0 ? live : (sessionStats?.plan_limits ?? [])
  const headline = headlinePlanLimit(windows, now)
  if (!headline || headline.resets_at == null) return null

  const label = (window: PlanLimitWindow): string => {
    switch (window.kind) {
      case "five_hour":
        return t("fiveHour")
      case "seven_day":
        return t("sevenDay")
      case "seven_day_opus":
        return t("sevenDayModel", { model: "Opus" })
      case "seven_day_sonnet":
        return t("sevenDayModel", { model: "Sonnet" })
      // A per-model weekly window too; Claude Code itself calls it the
      // "Fable limit".
      case "seven_day_overage_included":
        return t("sevenDayModel", { model: "Fable" })
      case "overage":
        return t("overage")
    }
    const minutes = window.window_minutes ?? 0
    if (minutes > 0 && minutes % (24 * 60) === 0) {
      return t("days", { count: minutes / (24 * 60) })
    }
    if (minutes > 0 && minutes % 60 === 0) {
      return t("hours", { count: minutes / 60 })
    }
    return t("other")
  }

  const timeLeft = (resetsAt: number): string => {
    const { days, hours, minutes } = timeUntil(resetsAt, now)
    if (days > 0) return t("durationDays", { days, hours })
    if (hours > 0) return t("durationHours", { hours, minutes })
    if (minutes > 0) return t("durationMinutes", { minutes })
    return t("durationSoon")
  }

  // A moment, local: "15:10" today, with the day on any other.
  const moment = (seconds: number): string => {
    const date = new Date(seconds * 1000)
    const today = new Date(now * 1000).toDateString() === date.toDateString()
    return new Intl.DateTimeFormat(
      locale,
      today
        ? { hour: "2-digit", minute: "2-digit" }
        : {
            weekday: "short",
            month: "numeric",
            day: "numeric",
            hour: "2-digit",
            minute: "2-digit",
          }
    ).format(date)
  }

  const staleSince = planLimitsStaleSince(windows, now)
  const tone = planLimitTone(headline)
  const time = timeLeft(headline.resets_at)
  const summary =
    headline.used_percent != null
      ? t("triggerTitleUsed", {
          label: label(headline),
          percent: Math.round(headline.used_percent),
          time,
        })
      : t("triggerTitle", { label: label(headline), time })

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          title={summary}
          aria-label={summary}
          className={cn(
            "flex items-center gap-1 transition-colors hover:text-foreground",
            TONE_TEXT[tone]
          )}
        >
          <Hourglass aria-hidden="true" className="size-3.5" />
          <span className="tabular-nums">{time}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="end"
        collisionPadding={12}
        className="gap-2 p-3 text-xs"
      >
        <div className="text-xs font-medium">{t("title")}</div>
        <div className="space-y-2.5">
          {windows.map((window) => {
            const reset = isPlanLimitReset(window, now)
            const windowTone = reset ? "normal" : planLimitTone(window)
            const used = reset ? null : (window.used_percent ?? null)
            return (
              <div key={window.kind} className="space-y-1">
                <div className="flex items-center justify-between gap-2 whitespace-nowrap">
                  <span>{label(window)}</span>
                  <span
                    className={cn(
                      "shrink-0 tabular-nums",
                      TONE_TEXT[windowTone]
                    )}
                  >
                    {windowTone === "reached"
                      ? t("reached")
                      : used != null
                        ? `${Math.round(used)}%`
                        : "—"}
                  </span>
                </div>
                {used != null ? (
                  <div className="relative h-1.5 overflow-hidden rounded-full bg-muted">
                    <div
                      className={cn(
                        "absolute inset-y-0 left-0",
                        TONE_BAR[windowTone]
                      )}
                      style={{ width: `${Math.min(100, used)}%` }}
                    />
                  </div>
                ) : null}
                {reset ? (
                  <div className="leading-snug text-muted-foreground">
                    {t("reset")}
                  </div>
                ) : window.resets_at != null ? (
                  <div className="leading-snug text-muted-foreground tabular-nums">
                    {t("resetsIn", {
                      time: timeLeft(window.resets_at),
                      at: moment(window.resets_at),
                    })}
                  </div>
                ) : null}
              </div>
            )
          })}
        </div>
        {staleSince != null ? (
          <div className="leading-snug text-muted-foreground">
            {t("staleNote", { at: moment(staleSince) })}
          </div>
        ) : null}
      </PopoverContent>
    </Popover>
  )
}
