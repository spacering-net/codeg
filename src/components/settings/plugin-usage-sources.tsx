"use client"

import { memo } from "react"
import { AlertCircle, AlertTriangle, Gauge, RefreshCw } from "lucide-react"
import { useLocale, useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import {
  usePluginUsageSources,
  type PluginUsageAccount,
  type PluginUsageProblem,
  type PluginUsageSourceState,
  type ResolvedPluginUsageSource,
} from "@/lib/host-plugins"
import { cn } from "@/lib/utils"

const MAX_DISPLAY_TEXT_CHARS = 512

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(100, Math.max(0, value))
}

function formatPercent(value: number): string {
  const clamped = clampPercent(value)
  const rounded = Math.round(clamped * 10) / 10
  return `${rounded}%`
}

function formatTimestamp(raw: string, locale: string): string {
  const trimmed = raw.trim()
  if (!trimmed) return ""
  const parsed = Date.parse(trimmed)
  if (Number.isNaN(parsed)) return trimmed
  try {
    return new Intl.DateTimeFormat(locale, {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date(parsed))
  } catch {
    return trimmed
  }
}

function boundDisplayText(value: string): string {
  const trimmed = value.trim()
  return trimmed.length > MAX_DISPLAY_TEXT_CHARS
    ? `${trimmed.slice(0, MAX_DISPLAY_TEXT_CHARS)}…`
    : trimmed
}

export interface PluginUsageSourcesSectionProps {
  enabled?: boolean
  className?: string
}

/**
 * Renders an on-demand Usage Sources section for enabled host plugins declaring
 * `contributes.usageSources`. Renders zero DOM when no enabled sources exist or
 * while a remote host transport is still booting.
 */
export const PluginUsageSourcesSection = memo(
  function PluginUsageSourcesSection({
    enabled = true,
    className,
  }: PluginUsageSourcesSectionProps) {
    const t = useTranslations("HostPlugins")
    const locale = useLocale()
    const { sources, statesByKey, querySource, refreshAll, transportReady } =
      usePluginUsageSources({ locale, enabled })

    if (!transportReady || sources.length === 0) return null

    const anyLoading = sources.some(
      (source) => statesByKey[source.key]?.loading === true
    )

    return (
      <section
        data-slot="plugin-usage-sources"
        aria-label={t("usageSources")}
        className={cn("space-y-3 pt-2", className)}
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold">{t("usageSources")}</h2>
          {sources.length > 1 && (
            <Button
              type="button"
              size="xs"
              variant="outline"
              disabled={anyLoading}
              onClick={refreshAll}
            >
              <RefreshCw
                className={cn("size-3.5", anyLoading && "animate-spin")}
                aria-hidden
              />
              {t("usageRefreshAll")}
            </Button>
          )}
        </div>

        <div className="space-y-3">
          {sources.map((source) => (
            <UsageSourceCard
              key={source.key}
              source={source}
              state={statesByKey[source.key]}
              locale={locale}
              onRefresh={() => querySource(source)}
            />
          ))}
        </div>
      </section>
    )
  }
)

PluginUsageSourcesSection.displayName = "PluginUsageSourcesSection"

function UsageSourceCard({
  source,
  state,
  locale,
  onRefresh,
}: {
  source: ResolvedPluginUsageSource
  state?: PluginUsageSourceState
  locale: string
  onRefresh: () => void
}) {
  const t = useTranslations("HostPlugins")
  const loading = state?.loading === true

  return (
    <section
      data-slot="plugin-usage-source-card"
      data-source-key={source.key}
      className="overflow-hidden rounded-lg border border-border/80 bg-card text-card-foreground"
    >
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-border/60 bg-muted/30 px-3 py-2">
        <div className="min-w-0 flex-1 space-y-0.5">
          <div className="flex min-w-0 items-center gap-1.5">
            <Gauge
              className="size-3.5 shrink-0 text-muted-foreground"
              aria-hidden
            />
            <span className="truncate text-sm font-medium">{source.title}</span>
          </div>
          <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
            <span className="truncate">{source.pluginName}</span>
            {source.provider && (
              <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px]">
                {source.provider}
              </span>
            )}
          </div>
        </div>
        <Button
          type="button"
          size="xs"
          variant="outline"
          disabled={loading}
          aria-label={t("usageRefreshSource", { name: source.title })}
          onClick={onRefresh}
        >
          <RefreshCw
            className={cn("size-3.5", loading && "animate-spin")}
            aria-hidden
          />
          {t("usageRefresh")}
        </Button>
      </header>

      <div className="space-y-3 p-3">
        {state?.error ? (
          <div
            role="alert"
            data-slot="plugin-usage-error"
            className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive"
          >
            <AlertCircle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            <p className="min-w-0 break-words">
              {boundDisplayText(state.error)}
            </p>
          </div>
        ) : !state?.data ? (
          <p className="text-xs text-muted-foreground">
            {loading ? t("loading") : t("usageIdleHint")}
          </p>
        ) : state.data.accounts.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            {t("usageNoAccounts")}
          </p>
        ) : (
          <div className="space-y-3">
            {state.data.accounts.map((account) => (
              <UsageAccountCard
                key={account.key}
                account={account}
                locale={locale}
              />
            ))}
          </div>
        )}
      </div>
    </section>
  )
}

function UsageAccountCard({
  account,
  locale,
}: {
  account: PluginUsageAccount
  locale: string
}) {
  const t = useTranslations("HostPlugins")
  const { report } = account
  const primaryLabel = account.label?.trim() || account.key
  const showSecondaryKey =
    Boolean(account.label?.trim()) && account.label?.trim() !== account.key

  return (
    <article
      data-slot="plugin-usage-account"
      data-account-key={account.key}
      className="space-y-3 rounded-md border border-border/70 bg-background p-3"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="break-words text-sm font-medium">
              {primaryLabel}
            </span>
            {account.harness && (
              <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
                {account.harness}
              </span>
            )}
          </div>
          {showSecondaryKey && (
            <div className="break-all font-mono text-[11px] text-muted-foreground">
              {account.key}
            </div>
          )}
        </div>
        {report.status === "available" && report.planLabel && (
          <span className="shrink-0 rounded-full border border-border bg-muted/50 px-2 py-0.5 text-[11px] font-medium text-foreground">
            {report.planLabel}
          </span>
        )}
      </div>

      {report.status === "available" ? (
        <div className="space-y-3">
          {report.windows.length > 0 && (
            <div className="space-y-2.5">
              {report.windows.map((win) => {
                const percent = clampPercent(win.usedPercent)
                const barTone =
                  percent >= 95
                    ? "bg-destructive"
                    : percent >= 80
                      ? "bg-amber-500"
                      : "bg-primary"
                return (
                  <div key={win.id} className="space-y-1">
                    <div className="flex items-baseline justify-between gap-2 text-xs">
                      <span className="min-w-0 break-words font-medium">
                        {win.label}
                      </span>
                      <span className="shrink-0 font-mono text-muted-foreground">
                        {formatPercent(percent)}
                      </span>
                    </div>
                    <div
                      role="progressbar"
                      aria-label={win.label}
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={Math.round(percent * 10) / 10}
                      className="h-2 w-full overflow-hidden rounded-full bg-muted"
                    >
                      <div
                        className={cn(
                          "h-full rounded-full transition-[width]",
                          barTone
                        )}
                        style={{ width: `${percent}%` }}
                      />
                    </div>
                    {win.resetsAt && (
                      <p className="text-[11px] text-muted-foreground">
                        {t("usageResetsAt", {
                          time: formatTimestamp(win.resetsAt, locale),
                        })}
                      </p>
                    )}
                  </div>
                )
              })}
            </div>
          )}

          {report.balances && report.balances.length > 0 && (
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {report.balances.map((balance) => (
                <div
                  key={balance.id}
                  className="flex items-baseline justify-between gap-2 rounded-md border border-border/60 bg-muted/30 px-2.5 py-1.5 text-xs"
                >
                  <span className="min-w-0 break-words text-muted-foreground">
                    {balance.label}
                  </span>
                  <span className="shrink-0 font-mono font-medium">
                    {balance.amount}
                    {balance.unit ? ` ${balance.unit}` : ""}
                  </span>
                </div>
              ))}
            </div>
          )}

          {report.details && report.details.length > 0 && (
            <dl className="space-y-1 border-t border-border/60 pt-2 text-xs">
              {report.details.map((detail, index) => (
                <div
                  key={`${detail.label}-${index}`}
                  className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5"
                >
                  <dt className="text-muted-foreground">{detail.label}</dt>
                  <dd className="min-w-0 break-words font-medium text-foreground">
                    {boundDisplayText(detail.value)}
                  </dd>
                </div>
              ))}
            </dl>
          )}
        </div>
      ) : report.status === "unavailable" ? (
        <UsageUnavailableNotice problem={report.problem} locale={locale} />
      ) : (
        <div
          role="alert"
          data-slot="plugin-usage-error"
          className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive"
        >
          <AlertCircle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          <p className="min-w-0 break-words">
            {boundDisplayText(report.error)}
          </p>
        </div>
      )}
    </article>
  )
}

function UsageUnavailableNotice({
  problem,
  locale,
}: {
  problem: PluginUsageProblem
  locale: string
}) {
  const t = useTranslations("HostPlugins")
  const titleKey =
    problem.kind === "expired"
      ? "usageProblemExpired"
      : problem.kind === "rejected"
        ? "usageProblemRejected"
        : "usageProblemNoQuota"

  return (
    <div
      data-slot="plugin-usage-unavailable"
      data-problem-kind={problem.kind}
      className="space-y-1.5 rounded-md border border-border/70 bg-muted/40 px-3 py-2 text-xs"
    >
      <div className="flex flex-wrap items-center gap-2 font-medium text-foreground">
        <AlertTriangle
          className="size-3.5 shrink-0 text-amber-500"
          aria-hidden
        />
        <span>{t(titleKey)}</span>
        {typeof problem.status === "number" && (
          <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
            {t("usageHttpStatus", { status: problem.status })}
          </span>
        )}
      </div>
      {problem.detail && (
        <p className="break-words text-muted-foreground">
          {boundDisplayText(problem.detail)}
        </p>
      )}
      {problem.expiresAt && (
        <p className="text-[11px] text-muted-foreground">
          {t("usageExpiresAt", {
            time: formatTimestamp(problem.expiresAt, locale),
          })}
        </p>
      )}
    </div>
  )
}
