"use client"

import { useLocale, useTranslations } from "next-intl"
import { ExternalLink, RefreshCw } from "lucide-react"
import { Progress } from "@/components/ui/progress"
import { openUrl } from "@/lib/platform"
import {
  familyQuota,
  PROVIDER_USAGE_URLS,
  type FamilyQuota,
  type IsolatableFamily,
} from "@/lib/subscription-quota"
import type { QuotaRead } from "@/hooks/use-subscription-quota"

export function quotaRow(data: QuotaRead | null): FamilyQuota | null {
  return data ? familyQuota(data.family, data.payload) : null
}

export function QuotaDetails({
  data,
  family,
  loading,
  refresh,
}: {
  data: QuotaRead | null
  family?: IsolatableFamily | null
  loading: boolean
  refresh: () => Promise<void>
}) {
  const t = useTranslations("TokenUsage")
  const locale = useLocale()
  const row = quotaRow(data)
  const url = family ? PROVIDER_USAGE_URLS[family] : undefined
  const windows =
    row?.kind === "remaining-subscription"
      ? [
          {
            label: row.label ?? row.planType ?? family,
            remaining: row.remaining,
            resetsAt: row.resetsAt,
          },
          ...(row.extras ?? []),
        ]
      : []
  function label(value?: string | null) {
    if (value === "5-hour") return t("quotaFiveHour")
    if (value === "weekly") return t("quotaWeekly")
    if (value === "monthly") return t("quotaMonthly")
    return value ?? t("quotaTitle")
  }
  return (
    <div className="space-y-3">
      {windows.length ? (
        <ul className="space-y-3">
          {windows.map((window, index) => (
            <li key={index}>
              <div className="flex items-center justify-between gap-3 text-xs">
                <span className="min-w-0 break-words text-muted-foreground">
                  {label(window.label)}
                </span>
                <span className="shrink-0 tabular-nums">
                  {t("quotaRemaining", {
                    remaining: Math.round(window.remaining),
                    limit: 100,
                  })}
                </span>
              </div>
              <Progress
                value={window.remaining}
                className="mt-1 h-1.5"
                aria-label={label(window.label)}
              />
              {window.resetsAt ? (
                <p className="mt-1 text-xs text-muted-foreground">
                  {t("quotaResets", {
                    when: new Date(window.resetsAt * 1000).toLocaleString(
                      locale,
                      {
                        month: "short",
                        day: "numeric",
                        hour: "numeric",
                        minute: "2-digit",
                      }
                    ),
                  })}
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-muted-foreground" role="status">
          {loading ? t("quotaLoading") : t("quotaUnavailable")}
        </p>
      )}
      {row?.kind === "remaining-subscription" &&
      row.hasOtherCapacity &&
      row.remaining === 0 ? (
        <p className="text-xs text-muted-foreground">
          {t("quotaOtherCapacity")}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
        {url ? (
          <button
            className="inline-flex items-center gap-1 hover:text-foreground"
            onClick={() => void openUrl(url)}
            type="button"
          >
            {t("quotaProviderLink")}
            <ExternalLink className="size-3" aria-hidden />
          </button>
        ) : (
          <span />
        )}
        <button
          className="inline-flex min-h-8 items-center gap-1 hover:text-foreground disabled:opacity-50"
          type="button"
          onClick={() => void refresh()}
          disabled={loading}
        >
          <RefreshCw className="size-3" aria-hidden />
          {t("quotaRefresh")}
        </button>
      </div>
      {data?.checkedAt ? (
        <p className="text-[0.6875rem] text-muted-foreground">
          {t("quotaChecked", {
            when: new Date(data.checkedAt * 1000).toLocaleTimeString(locale, {
              hour: "numeric",
              minute: "2-digit",
            }),
          })}
        </p>
      ) : null}
    </div>
  )
}
