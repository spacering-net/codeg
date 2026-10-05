"use client"

import { useEffect, useState } from "react"
import { useLocale, useTranslations } from "next-intl"
import { ExternalLink } from "lucide-react"
import {
  subscriptionQuotaClaude,
  subscriptionQuotaCodex,
  subscriptionQuotaCursor,
  subscriptionQuotaGrok,
  subscriptionQuotaOpencode,
} from "@/lib/api"
import {
  inventory,
  type IsolatableFamily,
  type OfficialQuotaSlot,
} from "@/lib/subscription-quota"
import { openUrl } from "@/lib/platform"

export function SubscriptionQuotaPanel() {
  const t = useTranslations("TokenUsage")
  const locale = useLocale()
  const [official, setOfficial] = useState<
    Partial<Record<IsolatableFamily, unknown>>
  >({})
  const [extraSlots, setExtraSlots] = useState<
    Partial<Record<IsolatableFamily, OfficialQuotaSlot[]>>
  >({})
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    let cancelled = false
    void Promise.allSettled([
      subscriptionQuotaCodex(),
      subscriptionQuotaClaude(),
      subscriptionQuotaGrok(),
      subscriptionQuotaCursor(),
      subscriptionQuotaOpencode(),
    ])
      .then((results) => {
        if (cancelled) return
        const next: Partial<Record<IsolatableFamily, unknown>> = {}
        const slots: Partial<Record<IsolatableFamily, OfficialQuotaSlot[]>> = {}
        const [codex, claude, grok, cursor, opencode] = results
        if (codex.status === "fulfilled") {
          if (codex.value.payload) next.codex = codex.value.payload
          if (codex.value.extraSlots?.length)
            slots.codex = codex.value.extraSlots
        }
        if (claude.status === "fulfilled") {
          if (claude.value.payload) next.claude = claude.value.payload
          if (claude.value.extraSlots?.length)
            slots.claude = claude.value.extraSlots
        }
        if (grok.status === "fulfilled") {
          if (grok.value.payload) next.grok = grok.value.payload
          if (grok.value.extraSlots?.length) slots.grok = grok.value.extraSlots
        }
        if (cursor.status === "fulfilled") {
          if (cursor.value.payload) next.cursor = cursor.value.payload
          if (cursor.value.extraSlots?.length)
            slots.cursor = cursor.value.extraSlots
        }
        if (opencode.status === "fulfilled") {
          if (opencode.value.payload) next.opencode = opencode.value.payload
          if (opencode.value.extraSlots?.length)
            slots.opencode = opencode.value.extraSlots
        }
        setOfficial(next)
        setExtraSlots(slots)
      })
      .finally(() => {
        if (!cancelled) setLoaded(true)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const rows = inventory(official, {}, extraSlots)

  return (
    <section className="rounded-xl border border-border bg-card p-4">
      <h2 className="text-[0.8125rem] font-semibold">{t("quotaTitle")}</h2>
      <p className="mt-1 text-[0.75rem] text-muted-foreground">
        {t("quotaHint")}
      </p>
      <ul className="mt-3 space-y-1.5">
        {rows.map((row) => (
          <li key={row.family} className="text-[0.75rem]">
            <div className="flex items-center justify-between gap-3">
              <span className="capitalize">{row.family}</span>
              {row.kind === "remaining-subscription" ? (
                <span className="text-right">
                  {t("quotaRemaining", {
                    remaining: Math.round(row.remaining),
                    limit: row.limit,
                  })}
                </span>
              ) : (row.family === "codex" ||
                  row.family === "claude" ||
                  row.family === "grok" ||
                  row.family === "cursor" ||
                  row.family === "opencode") &&
                !loaded ? (
                <span className="text-muted-foreground">
                  {t("quotaLoading")}
                </span>
              ) : (
                <button
                  type="button"
                  className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground"
                  onClick={() => {
                    if (row.kind === "unavailable") {
                      void openUrl(row.providerUsageUrl)
                    }
                  }}
                >
                  {t("quotaProviderLink")}
                  <ExternalLink className="size-3" />
                </button>
              )}
            </div>
            {row.kind === "remaining-subscription" && row.resetsAt ? (
              <div className="mt-0.5 text-right text-[0.6875rem] text-muted-foreground">
                {t("quotaResets", {
                  when: new Date(row.resetsAt * 1000).toLocaleString(locale, {
                    month: "short",
                    day: "numeric",
                    hour: "numeric",
                    minute: "2-digit",
                  }),
                })}
              </div>
            ) : null}
            {row.kind === "remaining-subscription"
              ? row.extras?.map((extra) => (
                  <div
                    key={extra.label ?? extra.usedPercent}
                    className="mt-0.5 text-right text-[0.6875rem] text-muted-foreground"
                  >
                    {t("quotaExtraRemaining", {
                      name: extra.label ?? row.family,
                      remaining: Math.round(extra.remaining),
                    })}
                  </div>
                ))
              : null}
          </li>
        ))}
      </ul>
    </section>
  )
}
