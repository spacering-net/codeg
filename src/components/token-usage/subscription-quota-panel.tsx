"use client"

import { useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { ChevronDown, RefreshCw } from "lucide-react"
import {
  listQuotaAccounts,
  useSubscriptionQuota,
  type QuotaAccount,
} from "@/hooks/use-subscription-quota"
import { subscribe } from "@/lib/platform"
import { getAgentLabel } from "@/lib/custom-agents"
import { QuotaDetails, quotaRow } from "./quota-details"

export function SubscriptionQuotaPanel() {
  const t = useTranslations("TokenUsage")
  const [accounts, setAccounts] = useState<QuotaAccount[] | null>(null)
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    let active = true
    const reload = () => {
      void listQuotaAccounts()
        .then((rows) => {
          if (active)
            setAccounts(
              [...rows].sort(
                (a, b) =>
                  a.family.localeCompare(b.family) ||
                  (a.name ?? "").localeCompare(b.name ?? "")
              )
            )
        })
        .catch(() => {
          if (active) setAccounts([])
        })
    }
    reload()
    const stop = subscribe("app://acp-agents-updated", reload).catch(
      () => () => {}
    )
    return () => {
      active = false
      void stop.then((unsubscribe) => unsubscribe())
    }
  }, [revision])
  return (
    <section className="rounded-xl border border-border bg-card p-4">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold">{t("quotaTitle")}</h2>
        <button
          type="button"
          onClick={() => setRevision((n) => n + 1)}
          className="inline-flex min-h-8 items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          <RefreshCw className="size-3" aria-hidden />
          {t("quotaRefresh")}
        </button>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">{t("quotaHint")}</p>
      {accounts?.length ? (
        <ul className="mt-3 divide-y divide-border">
          {accounts.map((account) => (
            <li
              key={`${revision}:${account.agentType}:${account.agentAccountId ?? "default"}`}
            >
              <AccountRow account={account} />
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-3 text-xs text-muted-foreground" role="status">
          {accounts ? t("quotaUnavailable") : t("quotaLoading")}
        </p>
      )}
    </section>
  )
}

function AccountRow({ account }: { account: QuotaAccount }) {
  const t = useTranslations("TokenUsage")
  const a = useTranslations("AgentAccounts")
  const { data, loading, refresh } = useSubscriptionQuota(account)
  const row = quotaRow(data)
  const familyAgent =
    account.family === "claude"
      ? "claude_code"
      : account.family === "opencode"
        ? "open_code"
        : account.family
  return (
    <details className="group py-2">
      <summary className="flex min-h-8 cursor-pointer list-none items-center justify-between gap-3 text-xs [&::-webkit-details-marker]:hidden">
        <span className="min-w-0 break-words">
          <span>
            {account.family === "opencode"
              ? "OpenCode Go"
              : getAgentLabel(familyAgent)}
          </span>
          <span className="text-muted-foreground">
            {" "}
            · {account.name ?? a("default")}
          </span>
        </span>
        <span className="flex shrink-0 items-center gap-2 text-right tabular-nums">
          {row?.kind === "remaining-subscription" && row.hasModelLimits
            ? t("quotaModelLimits")
            : row?.kind === "remaining-subscription"
              ? t("quotaRemaining", {
                  remaining: Math.round(row.remaining),
                  limit: 100,
                })
              : loading
                ? t("quotaLoading")
                : t("quotaUnavailable")}
          <ChevronDown
            className="size-3 transition-transform group-open:rotate-180"
            aria-hidden
          />
        </span>
      </summary>
      <div className="pb-2 pt-3">
        <QuotaDetails
          data={data}
          family={account.family}
          loading={loading}
          refresh={refresh}
        />
      </div>
    </details>
  )
}
