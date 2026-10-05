"use client"

import { useEffect, useMemo, useState } from "react"
import { useLocale, useTranslations } from "next-intl"
import { Gauge } from "lucide-react"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { Progress } from "@/components/ui/progress"
import {
  subscriptionQuotaClaude,
  subscriptionQuotaCodex,
  subscriptionQuotaCursor,
  subscriptionQuotaGrok,
} from "@/lib/api"
import {
  familyFromAgentType,
  familyQuota,
  type FamilyQuota,
  type IsolatableFamily,
  type OfficialQuotaSlot,
} from "@/lib/subscription-quota"
import type { AgentType } from "@/lib/types"

/**
 * Quiet remaining-quota chip for the current conversation header.
 * Same official sources as the Token Usage page; one family only so the
 * chat view does not become a second dashboard.
 */
export function SessionQuotaChip({ agentType }: { agentType: AgentType }) {
  const family = familyFromAgentType(agentType)
  if (!family) return null
  return <SessionQuotaChipInner family={family} />
}

const QUOTA_FETCHERS: Record<
  IsolatableFamily,
  | (() => Promise<{ payload?: unknown; extraSlots?: OfficialQuotaSlot[] }>)
  | null
> = {
  claude: subscriptionQuotaClaude,
  codex: subscriptionQuotaCodex,
  grok: subscriptionQuotaGrok,
  cursor: subscriptionQuotaCursor,
  gemini: null,
  opencode: null,
}

function SessionQuotaChipInner({ family }: { family: IsolatableFamily }) {
  const t = useTranslations("TokenUsage")
  const locale = useLocale()
  const fetchQuota = QUOTA_FETCHERS[family]
  const [fetched, setFetched] = useState<FamilyQuota | null>(null)
  const [fetchDone, setFetchDone] = useState(false)

  useEffect(() => {
    if (!fetchQuota) return
    let cancelled = false
    void fetchQuota()
      .then((value) => {
        if (cancelled) return
        setFetched(
          familyQuota(family, value.payload, undefined, value.extraSlots)
        )
      })
      .catch(() => {
        if (!cancelled) setFetched(familyQuota(family))
      })
      .finally(() => {
        if (!cancelled) setFetchDone(true)
      })
    return () => {
      cancelled = true
    }
  }, [family, fetchQuota])

  // A family with no official endpoint has nothing to wait for, so its row is
  // derived during render rather than pushed through state by the effect.
  const localRow = useMemo(
    () => (fetchQuota ? null : familyQuota(family)),
    [family, fetchQuota]
  )
  const row = fetchQuota ? fetched : localRow
  const loaded = fetchQuota ? fetchDone : true

  const label = useMemo(() => {
    if (!loaded || !row) return t("quotaLoading")
    if (row.kind === "remaining-subscription") {
      return t("quotaRemaining", {
        remaining: Math.round(row.remaining),
        limit: row.limit,
      })
    }
    return t("quotaTitle")
  }, [loaded, row, t])

  const windows =
    row?.kind === "remaining-subscription"
      ? [
          {
            label: row.planType ?? family,
            remaining: row.remaining,
            usedPercent: Math.max(0, Math.min(100, 100 - row.remaining)),
            resetsAt: row.resetsAt,
          },
          ...(row.extras ?? []),
        ]
      : []

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="inline-flex h-7 max-w-[11rem] shrink-0 items-center gap-1 rounded px-1.5 text-[0.6875rem] text-muted-foreground/80 transition-colors hover:text-foreground"
          title={label}
          aria-label={label}
        >
          <Gauge className="size-3.5 shrink-0" aria-hidden />
          <span className="truncate font-medium tabular-nums">{label}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 p-3">
        <div className="text-[0.8125rem] font-semibold">{t("quotaTitle")}</div>
        <p className="mt-1 text-[0.75rem] leading-relaxed text-muted-foreground">
          {t("quotaHint")}
        </p>
        {row?.kind === "remaining-subscription" ? (
          <ul className="mt-3 space-y-2.5">
            {windows.map((w) => (
              <li key={`${w.label ?? family}-${w.usedPercent}`}>
                <div className="flex items-center justify-between gap-2 text-[0.75rem]">
                  <span className="capitalize text-muted-foreground">
                    {w.label ?? family}
                  </span>
                  <span className="tabular-nums">
                    {t("quotaRemaining", {
                      remaining: Math.round(w.remaining),
                      limit: 100,
                    })}
                  </span>
                </div>
                <Progress
                  value={Math.max(0, Math.min(100, 100 - w.usedPercent))}
                  className="mt-1 h-1.5"
                />
                {w.resetsAt ? (
                  <div className="mt-0.5 text-right text-[0.6875rem] text-muted-foreground">
                    {t("quotaResets", {
                      when: new Date(w.resetsAt * 1000).toLocaleString(locale, {
                        month: "short",
                        day: "numeric",
                        hour: "numeric",
                        minute: "2-digit",
                      }),
                    })}
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-3 text-[0.75rem] text-muted-foreground">
            {loaded ? t("quotaProviderLink") : t("quotaLoading")}
          </p>
        )}
      </PopoverContent>
    </Popover>
  )
}
