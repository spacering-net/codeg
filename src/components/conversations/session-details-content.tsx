"use client"

import { useEffect, useMemo, useState, type ReactNode } from "react"
import { Check, Copy, Loader2 } from "lucide-react"
import { useLocale, useTranslations } from "next-intl"
import type {
  AgentType,
  ConversationStatus,
  DbConversationSummary,
  SessionStats,
} from "@/lib/types"
import { STATUS_ORDER } from "@/lib/types"
import { getAgentLabel } from "@/lib/custom-agents"
import { cn, copyTextToClipboard } from "@/lib/utils"
import { formatConversationTitle } from "@/lib/conversation-title"
import { formatTokenCount } from "@/lib/token-format"
import {
  formatContextWindowPercent,
  resolveContextWindowPercent,
} from "@/lib/context-window"
import { getFolderConversation } from "@/lib/api"
import { useCopiedFlag } from "@/hooks/use-copied-flag"
import { pickModelFromTurns } from "./active-session-details"
import { useSessionOutputSpeed } from "@/hooks/use-session-output-speed"
import { averageOutputTps, formatTokPerSec } from "@/lib/token-speed"
import { AgentIcon } from "@/components/agent-icon"
import { ConversationStatusDot } from "./conversation-status-dot"

interface SessionDetailsContentProps {
  summary: DbConversationSummary
  /**
   * Pre-loaded session stats. When a value (or `null`) is passed the content
   * trusts it and renders without a fetch — the detail panel / session-details
   * tab read it straight from the live runtime session. When `undefined` (the
   * sidebar card, which only holds the summary) it fetches the conversation
   * detail while `active` to fill in token usage.
   */
  stats?: SessionStats | null
  /**
   * Pre-resolved model name, following the same contract as `stats`. A value
   * (or `null`) is trusted as-is — the detail panel resolves it from the live
   * session's turns. `undefined` (the sidebar card) makes the content derive the
   * model from the conversation detail it fetches, since
   * `DbConversationSummary.model` is empty for sessions started live in-app.
   */
  model?: string | null
  /**
   * Whether the content is currently visible/active. Gates the sidebar
   * cold-fetch effect and the loading state so it only runs while shown. The
   * dialog passes its `open` flag; the always-mounted sidebar tab passes whether
   * the panel + tab are actually surfaced. Defaults to `true`.
   */
  active?: boolean
}

function isKnownStatus(value: string): value is ConversationStatus {
  return (STATUS_ORDER as string[]).includes(value)
}

/**
 * The agent + status chips that sit under a conversation's title. Shared with
 * the sidebar's hover bubble (`sidebar-conversation-hover-details.tsx`) so the
 * two surfaces stay identical — including the a11y detail below, which is easy
 * to lose in a copy.
 */
export function SessionIdentityChips({
  agentType,
  status,
}: {
  agentType: AgentType
  status: string
}) {
  const tStatus = useTranslations("Folder.statusLabels")
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
      <span className="inline-flex items-center gap-1.5">
        {/* Decorative: the visible label already names the agent, and the icon
            SVG carries its own <title>, so hide it from the a11y tree to avoid
            a duplicate reading. */}
        <span aria-hidden="true" className="inline-flex">
          <AgentIcon agentType={agentType} className="h-3.5 w-3.5" />
        </span>
        {getAgentLabel(agentType)}
      </span>
      <span className="inline-flex items-center gap-1.5">
        <ConversationStatusDot
          status={isKnownStatus(status) ? status : null}
          size="sm"
        />
        {isKnownStatus(status) ? tStatus(status) : status}
      </span>
    </div>
  )
}

function trimZero(value: string): string {
  return value.replace(/\.0$/, "")
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const seconds = ms / 1000
  if (seconds < 60) return `${trimZero(seconds.toFixed(1))}s`
  const minutes = seconds / 60
  if (minutes < 60) return `${trimZero(minutes.toFixed(1))}m`
  return `${trimZero((minutes / 60).toFixed(1))}h`
}

function parseTimestampMs(value: string): number | null {
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : null
}

function resolveSessionDurationMs(
  summary: DbConversationSummary,
  stats: SessionStats | null
): number {
  const statsDuration = stats?.total_duration_ms ?? 0
  if (statsDuration > 0) return statsDuration
  if (summary.status !== "completed") return 0

  const startedAt = parseTimestampMs(summary.created_at)
  const endedAt = parseTimestampMs(summary.updated_at)
  if (startedAt == null || endedAt == null || endedAt <= startedAt) return 0

  return endedAt - startedAt
}

/**
 * One label-above-value cell inside a responsive `<dl>` grid. Stacking the
 * label on top keeps values left-aligned and tight against their label (no
 * wide gap, no copy button floating far to the right), and the `min-w-0` lets
 * the cell shrink below its content so a long value wraps in place instead of
 * widening the grid track. Rendered as a `<div>` grouping `<dt>`/`<dd>`, which
 * HTML permits as a direct child of `<dl>`.
 *
 * Exported so the sidebar's hover bubble
 * (`sidebar-conversation-hover-details.tsx`) renders its fields in the exact
 * same shape as this view rather than growing a near-copy.
 */
export function InfoItem({
  label,
  children,
  className,
  valueClassName,
  title,
}: {
  /** Usually plain text; a node so a caller can hang a badge off the label. */
  label: ReactNode
  children: ReactNode
  className?: string
  valueClassName?: string
  title?: string
}) {
  return (
    <div className={cn("min-w-0 space-y-0.5", className)} title={title}>
      <dt className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
        {label}
      </dt>
      <dd className={cn("min-w-0 leading-snug", valueClassName)}>{children}</dd>
    </div>
  )
}

/**
 * A value with a copy button that fades in on hover (or keyboard focus). Used
 * for identifiers worth copying — the session id and the extension id.
 */
function CopyableValue({
  text,
  className,
  copyLabel,
  copiedLabel,
  children,
}: {
  text: string
  className?: string
  copyLabel: string
  copiedLabel: string
  children: ReactNode
}) {
  const [copied, markCopied] = useCopiedFlag()
  const handleCopy = () => {
    void copyTextToClipboard(text).then((ok) => {
      if (ok) markCopied()
    })
  }
  return (
    <span className="group/copy inline-flex min-w-0 max-w-full items-center gap-1">
      <span className={cn("min-w-0", className)}>{children}</span>
      <button
        type="button"
        onClick={handleCopy}
        aria-label={copied ? copiedLabel : copyLabel}
        title={copied ? copiedLabel : copyLabel}
        className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-accent-foreground focus-visible:opacity-100 group-hover/copy:opacity-100 group-focus-within/copy:opacity-100"
      >
        {copied ? (
          <Check className="h-3 w-3 text-green-500" />
        ) : (
          <Copy className="h-3 w-3" />
        )}
      </button>
    </span>
  )
}

/**
 * The presentational body of the Session Details view — the conversation's
 * identity, identifiers, token usage, and timestamps. Extracted from the
 * dialog so it can be rendered both inside the modal
 * (`SessionDetailsDialog`) and inline in the aux-panel Session Details tab.
 * Data inputs are dialog-agnostic: a `summary` plus the tri-state
 * `stats`/`model` contract (see the prop docs).
 */
export function SessionDetailsContent({
  summary: summaryProp,
  stats: statsProp,
  model: modelProp,
  active = true,
}: SessionDetailsContentProps) {
  const t = useTranslations("Folder.sessionDetails")
  const locale = useLocale()

  // The only mirrored state is the outcome of the sidebar fetch, held as one
  // keyed union so the latest result simply overwrites the previous one (a
  // success after an error wins, an error never sticks). Everything shown is
  // derived below, so an effect never has to synchronously setState to track
  // the props. `id` tags the result so a stale response — or one left over for
  // a different conversation — is ignored.
  const [fetchResult, setFetchResult] = useState<
    | {
        id: number
        ok: true
        summary: DbConversationSummary
        stats: SessionStats | null
        model: string | null
      }
    | { id: number; ok: false }
    | null
  >(null)

  useEffect(() => {
    // Caller supplied stats (the detail panel / tab read them off the live
    // runtime session): render straight from props, nothing to fetch.
    if (!active || statsProp !== undefined) return
    // Sidebar: only the summary is on hand. Fetch the conversation detail to
    // fill in token usage.
    const id = summaryProp.id
    let cancelled = false
    getFolderConversation(id)
      .then((detail) => {
        if (!cancelled)
          setFetchResult({
            id,
            ok: true,
            summary: detail.summary,
            stats: detail.session_stats ?? null,
            // The summary column is usually empty for live sessions; fall back
            // to the model recorded on the parsed turns.
            model: detail.summary.model ?? pickModelFromTurns(detail.turns),
          })
      })
      .catch(() => {
        if (!cancelled) setFetchResult({ id, ok: false })
      })
    return () => {
      cancelled = true
    }
  }, [active, statsProp, summaryProp.id])

  const result =
    fetchResult && fetchResult.id === summaryProp.id ? fetchResult : null
  const summary = result?.ok ? result.summary : summaryProp
  const stats =
    statsProp !== undefined ? statsProp : result?.ok ? result.stats : null
  const statsError = statsProp === undefined && result?.ok === false
  const loadingStats = active && statsProp === undefined && result == null
  // Model mirrors the stats contract: trust a caller-supplied value, otherwise
  // use what the fetch derived, then fall back to the (usually empty) summary.
  const resolvedModel =
    modelProp !== undefined ? modelProp : result?.ok ? result.model : null
  const displayModel = resolvedModel ?? summary.model ?? null

  const dateFormatter = useMemo(
    () =>
      new Intl.DateTimeFormat(locale, {
        dateStyle: "medium",
        timeStyle: "short",
      }),
    [locale]
  )

  const formatDate = (iso: string): string => {
    const date = new Date(iso)
    return Number.isNaN(date.getTime()) ? iso : dateFormatter.format(date)
  }

  const usage = stats?.total_usage ?? null
  const totalTokens =
    stats?.total_tokens ??
    (usage
      ? usage.input_tokens +
        usage.output_tokens +
        usage.cache_creation_input_tokens +
        usage.cache_read_input_tokens
      : null)
  const ctxUsed = stats?.context_window_used_tokens ?? null
  const ctxMax = stats?.context_window_max_tokens ?? null
  // Compute the percentage the same way the bottom status bar does (trust the
  // backend figure, recompute from used/max only when it is absent, clamped to
  // 0–100) and render one decimal place to match it.
  const ctxPercent = resolveContextWindowPercent(
    stats?.context_window_usage_percent,
    ctxUsed,
    ctxMax
  )
  const durationMs = resolveSessionDurationMs(summary, stats)
  const liveOutputSpeed = useSessionOutputSpeed(summary.id)
  const recordedOutputTps = averageOutputTps(
    usage?.output_tokens ?? 0,
    stats?.total_duration_ms ?? 0
  )
  const outputTps = liveOutputSpeed?.averageTps ?? recordedOutputTps
  // Never coerce an unknown `used` to 0 — some parsers infer the model's
  // context cap without any usage figure, so render "— / max" rather than a
  // bogus "0 / max".
  const ctxPercentText =
    ctxPercent != null ? ` (${formatContextWindowPercent(ctxPercent)})` : ""
  const contextWindowValue =
    ctxMax != null
      ? `${ctxUsed != null ? formatTokenCount(ctxUsed) : t("none")} / ${formatTokenCount(ctxMax)}${ctxPercentText}`
      : ctxUsed != null
        ? formatTokenCount(ctxUsed)
        : null
  const hasTokenInfo =
    outputTps != null ||
    (stats != null &&
      (totalTokens != null ||
        usage != null ||
        contextWindowValue != null ||
        durationMs > 0))

  const numeric = "font-mono tabular-nums"

  return (
    // `@container` drives the identifier / token / timestamp grids: one column
    // in the narrow aux-panel tab, two in the wider details dialog.
    <div className="@container min-w-0 space-y-5 text-sm">
      {/* Identity: the conversation title with its agent and status. */}
      <div className="min-w-0 space-y-2">
        <p className="wrap-anywhere text-base font-medium leading-snug">
          {formatConversationTitle(summary.title) || t("untitled")}
        </p>
        <SessionIdentityChips
          agentType={summary.agent_type}
          status={summary.status}
        />
      </div>

      {/* Identifiers, packed two-up to keep the view short. */}
      <dl className="grid grid-cols-1 gap-x-4 gap-y-3 border-t pt-4 @[20rem]:grid-cols-2">
        <InfoItem label={t("sessionId")}>
          <CopyableValue
            text={String(summary.id)}
            className={numeric}
            copyLabel={t("copyField", { field: t("sessionId") })}
            copiedLabel={t("copiedField", { field: t("sessionId") })}
          >
            {summary.id}
          </CopyableValue>
        </InfoItem>
        <InfoItem label={t("model")} valueClassName="wrap-anywhere">
          {displayModel || t("none")}
        </InfoItem>
        <InfoItem label={t("gitBranch")} valueClassName="font-mono break-all">
          {summary.git_branch || t("none")}
        </InfoItem>
        {summary.parent_id != null && (
          <InfoItem label={t("parentId")} valueClassName={numeric}>
            {summary.parent_id}
          </InfoItem>
        )}
        <InfoItem label={t("externalId")} className="@[20rem]:col-span-2">
          {summary.external_id ? (
            <CopyableValue
              text={summary.external_id}
              className="font-mono break-all"
              copyLabel={t("copyField", { field: t("externalId") })}
              copiedLabel={t("copiedField", { field: t("externalId") })}
            >
              {summary.external_id}
            </CopyableValue>
          ) : (
            <span className="font-mono">{t("none")}</span>
          )}
        </InfoItem>
      </dl>

      <section className="min-w-0 space-y-3 border-t pt-4">
        <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {t("tokensHeading")}
        </h3>
        {loadingStats ? (
          <div className="flex items-center gap-2 text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            {t("loadingStats")}
          </div>
        ) : statsError ? (
          <div className="text-muted-foreground">{t("loadFailed")}</div>
        ) : hasTokenInfo ? (
          <dl className="grid grid-cols-1 gap-x-4 gap-y-3 @[20rem]:grid-cols-2">
            {totalTokens != null && (
              <InfoItem label={t("totalTokens")} valueClassName={numeric}>
                {formatTokenCount(totalTokens)}
              </InfoItem>
            )}
            {usage && (
              <>
                <InfoItem label={t("inputTokens")} valueClassName={numeric}>
                  {formatTokenCount(usage.input_tokens)}
                </InfoItem>
                <InfoItem label={t("outputTokens")} valueClassName={numeric}>
                  {formatTokenCount(usage.output_tokens)}
                </InfoItem>
                {usage.cache_creation_input_tokens > 0 && (
                  <InfoItem label={t("cacheWrite")} valueClassName={numeric}>
                    {formatTokenCount(usage.cache_creation_input_tokens)}
                  </InfoItem>
                )}
                {usage.cache_read_input_tokens > 0 && (
                  <InfoItem label={t("cacheRead")} valueClassName={numeric}>
                    {formatTokenCount(usage.cache_read_input_tokens)}
                  </InfoItem>
                )}
              </>
            )}
            {contextWindowValue != null && (
              <InfoItem label={t("contextWindow")} valueClassName={numeric}>
                {contextWindowValue}
              </InfoItem>
            )}
            {durationMs > 0 && (
              <InfoItem label={t("duration")} valueClassName={numeric}>
                {formatDuration(durationMs)}
              </InfoItem>
            )}
            {outputTps != null && (
              <InfoItem
                label={t("outputSpeed")}
                valueClassName={numeric}
                title={t("outputSpeedTooltip")}
              >
                {formatTokPerSec(outputTps)}
              </InfoItem>
            )}
          </dl>
        ) : (
          <div className="text-muted-foreground">{t("noStats")}</div>
        )}
      </section>

      <section className="min-w-0 space-y-3 border-t pt-4">
        <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {t("timestampsHeading")}
        </h3>
        <dl className="grid grid-cols-1 gap-x-4 gap-y-3 @[20rem]:grid-cols-2">
          <InfoItem label={t("createdAt")}>
            {formatDate(summary.created_at)}
          </InfoItem>
          <InfoItem label={t("updatedAt")}>
            {formatDate(summary.updated_at)}
          </InfoItem>
        </dl>
      </section>
    </div>
  )
}
