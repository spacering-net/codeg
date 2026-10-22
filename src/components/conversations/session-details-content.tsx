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
import { useModelLabels } from "@/hooks/use-model-labels"
import { pickModelFromTurns } from "./active-session-details"
import { AgentIcon } from "@/components/agent-icon"
import { AssistantAvatar } from "@/components/assistants/assistant-avatar"
import { useDelegationIdentityLabel } from "@/components/message/delegation-identity"
import { useAssistant } from "@/stores/assistants-store"
import { ConversationStatusDot } from "./conversation-status-dot"

interface SessionDetailsContentProps {
  summary: DbConversationSummary
  /**
   * Pre-loaded session stats. When a value (or `null`) is passed the content
   * trusts it and renders without a fetch — the detail panel reads it
   * straight from the live runtime session. When `undefined` (the
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
   * dialog passes its `open` flag. Defaults to `true`.
   */
  active?: boolean
}

function isKnownStatus(value: string): value is ConversationStatus {
  return (STATUS_ORDER as string[]).includes(value)
}

/**
 * The identity chips that sit under a conversation's title: the agent always,
 * then the model and the status when the surface wants them. Shared with the
 * sidebar's hover bubble (`sidebar-conversation-hover-details.tsx`) so the two
 * stay identical — including the a11y details below, which are easy to lose in
 * a copy.
 *
 * The two surfaces ask for different chips because they sit beside different
 * things. This dialog spells the model out in its own labelled field and its
 * status is worth naming next to the title, so it passes `status` and no
 * `model`. The bubble hangs off a row that already badges a running or
 * cancelled session, and has no field to spare for the model, so it does the
 * reverse.
 */
export function SessionIdentityChips({
  agentType,
  status,
  model,
}: {
  agentType: AgentType
  /** Omit to drop the status chip. */
  status?: string | null
  /** Omit (or pass empty) to drop the model chip. The RAW id as recorded — the
   *  chip renders whatever the agent calls it when that is known. */
  model?: string | null
}) {
  const tStatus = useTranslations("Folder.statusLabels")
  const modelLabel = useModelLabels(agentType)
  const displayModel = modelLabel(model)
  return (
    <div className="flex flex-wrap items-center gap-x-1 gap-y-1 text-xs text-muted-foreground">
      <span className="inline-flex items-center gap-1.5">
        {/* Decorative: the visible label already names the agent, and the icon
            SVG carries its own <title>, so hide it from the a11y tree to avoid
            a duplicate reading. */}
        <span aria-hidden="true" className="inline-flex">
          <AgentIcon agentType={agentType} className="h-3.5 w-3.5" />
        </span>
        {getAgentLabel(agentType)}
      </span>
      {displayModel && (
        // The separator rides INSIDE the model chip, with the row's own gap
        // repeated around it so it sits evenly between the two names, and so
        // the two are one flex item: a dot of its own would be left on the line
        // above when a long model id wraps, orphaned at the end of it. Wrapping
        // rather than truncating — a chip row has no width of its own to
        // truncate against, and a model id is the kind of value whose tail is
        // what distinguishes it.
        <span className="inline-flex min-w-0 items-center gap-x-1">
          <span aria-hidden="true">·</span>
          <span dir="ltr" className="wrap-anywhere min-w-0 font-mono">
            {displayModel}
          </span>
        </span>
      )}
      {status != null && (
        // `ms-2` puts back what the row gap gave up. That gap is tight so the
        // model's separator can hug the two names it divides; this chip is a
        // second label rather than a division, and reads as crowded against the
        // agent without the 0.75rem it had.
        <span className="ms-2 inline-flex items-center gap-1.5">
          <ConversationStatusDot
            status={isKnownStatus(status) ? status : null}
            size="sm"
          />
          {isKnownStatus(status) ? tStatus(status) : status}
        </span>
      )}
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
/** The assistant a delegation sub-session ran as: its avatar and name, by
 *  the same fallback order the delegation cards use. */
function AssistantInline({
  id,
  snapshotName,
}: {
  id: number
  snapshotName: string | null
}) {
  const t = useTranslations("Folder.chat.delegation")
  const assistant = useAssistant(id)
  const { name, deleted } = useDelegationIdentityLabel({
    agentType: null,
    assistantId: id,
    assistantName: snapshotName,
  })
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      <AssistantAvatar
        avatar={assistant?.avatar ?? null}
        name={name}
        size={16}
      />
      <span className="min-w-0 truncate">{name}</span>
      {deleted ? (
        <span className="shrink-0 text-muted-foreground">
          {t("deletedAssistant")}
        </span>
      ) : null}
    </span>
  )
}

export function InfoItem({
  label,
  children,
  className,
  valueClassName,
}: {
  /** Usually plain text; a node so a caller can hang a badge off the label. */
  label: ReactNode
  children: ReactNode
  className?: string
  valueClassName?: string
}) {
  return (
    <div className={cn("min-w-0 space-y-0.5", className)}>
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

/** A copy button for one property row of `SessionDetailsCard`: it shows while
 *  the row is hovered or holds focus. */
function CopyPropertyButton({
  text,
  copyLabel,
  copiedLabel,
}: {
  text: string
  copyLabel: string
  copiedLabel: string
}) {
  const [copied, markCopied] = useCopiedFlag()
  const handleCopy = () => {
    void copyTextToClipboard(text).then((ok) => {
      if (ok) markCopied()
    })
  }
  return (
    <button
      type="button"
      onClick={handleCopy}
      aria-label={copied ? copiedLabel : copyLabel}
      title={copied ? copiedLabel : copyLabel}
      className="ms-auto inline-flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-accent-foreground focus-visible:opacity-100 group-hover/prop:opacity-100 group-focus-within/prop:opacity-100"
    >
      {copied ? (
        <Check className="size-3 text-green-500" />
      ) : (
        <Copy className="size-3" />
      )}
    </button>
  )
}

/**
 * An id cut in the middle when it doesn't fit: its head gives way and its
 * last characters stay, which is where two ids of one agent tell apart.
 */
function MiddleTruncatedId({ value }: { value: string }) {
  const tail = value.length > 16 ? value.slice(-8) : ""
  const head = tail ? value.slice(0, -8) : value
  return (
    <span dir="ltr" title={value} className="flex min-w-0 font-mono">
      <span className="min-w-0 truncate">{head}</span>
      {tail && <span className="shrink-0">{tail}</span>}
    </span>
  )
}

/** One label–value row of `SessionDetailsCard`'s property grid. */
function PropertyRow({
  label,
  children,
}: {
  label: string
  children: ReactNode
}) {
  return (
    <div className="group/prop col-span-2 grid grid-cols-subgrid items-center">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="flex h-5 min-w-0 items-center gap-1 text-foreground/80">
        {children}
      </dd>
    </div>
  )
}

/**
 * The Session Details side panel's summary of the active conversation: the
 * title on a row of its own, the agent (its icon and name) and the status
 * under it, then one row per property — the model, the branch, the
 * conversation's and the agent's session ids (copyable), and the parent
 * conversation and the assistant when it has them. The panel's room goes to
 * the plan and the message navigator under it, so this is a card; the dialog
 * (`SessionDetailsContent`) is the full view, with token usage and
 * timestamps.
 *
 * `model` is the raw id the transcript recorded (the tab resolves it the way
 * the detail panel does); it is shown by the name the agent's picker uses.
 */
export function SessionDetailsCard({
  summary,
  model,
}: {
  summary: DbConversationSummary
  model: string | null
}) {
  const t = useTranslations("Folder.sessionDetails")
  const tStatus = useTranslations("Folder.statusLabels")
  const modelLabel = useModelLabels(summary.agent_type)
  const displayModel = modelLabel(model ?? summary.model ?? null)
  const title = formatConversationTitle(summary.title) || t("untitled")
  const knownStatus = isKnownStatus(summary.status) ? summary.status : null

  return (
    <section className="min-w-0 rounded-lg border border-border/70 bg-muted/40 p-3">
      <p
        title={title}
        className="line-clamp-2 text-[0.8125rem] leading-[1.125rem] font-semibold [overflow-wrap:anywhere]"
      >
        {title}
      </p>
      <p className="mt-1 flex min-w-0 items-center gap-1.5 text-2xs text-muted-foreground">
        {/* Decorative: the name beside it says which agent it is, and the
            icon's SVG carries a <title> of its own that would repeat it. */}
        <span aria-hidden="true" className="inline-flex shrink-0">
          <AgentIcon agentType={summary.agent_type} className="size-3.5" />
        </span>
        <span className="truncate">{getAgentLabel(summary.agent_type)}</span>
        <span aria-hidden="true">·</span>
        <span className="inline-flex shrink-0 items-center gap-1 text-foreground/80">
          <ConversationStatusDot status={knownStatus} size="sm" />
          {knownStatus ? tStatus(knownStatus) : summary.status}
        </span>
      </p>
      <dl className="mt-2.5 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 text-2xs">
        <PropertyRow label={t("model")}>
          <span className="min-w-0 truncate" title={displayModel || undefined}>
            {displayModel || t("none")}
          </span>
        </PropertyRow>
        <PropertyRow label={t("gitBranch")}>
          {summary.git_branch ? (
            <span
              dir="ltr"
              title={summary.git_branch}
              className="min-w-0 truncate font-mono"
            >
              {summary.git_branch}
            </span>
          ) : (
            t("none")
          )}
        </PropertyRow>
        <PropertyRow label={t("sessionId")}>
          <span className="font-mono tabular-nums">{summary.id}</span>
          <CopyPropertyButton
            text={String(summary.id)}
            copyLabel={t("copyField", { field: t("sessionId") })}
            copiedLabel={t("copiedField", { field: t("sessionId") })}
          />
        </PropertyRow>
        <PropertyRow label={t("externalId")}>
          {summary.external_id ? (
            <>
              <MiddleTruncatedId value={summary.external_id} />
              <CopyPropertyButton
                text={summary.external_id}
                copyLabel={t("copyField", { field: t("externalId") })}
                copiedLabel={t("copiedField", { field: t("externalId") })}
              />
            </>
          ) : (
            t("none")
          )}
        </PropertyRow>
        {summary.parent_id != null && (
          <PropertyRow label={t("parentId")}>
            <span className="font-mono tabular-nums">{summary.parent_id}</span>
          </PropertyRow>
        )}
        {summary.assistant_id != null && (
          <PropertyRow label={t("assistant")}>
            <AssistantInline
              id={summary.assistant_id}
              snapshotName={summary.assistant_name ?? null}
            />
          </PropertyRow>
        )}
      </dl>
    </section>
  )
}

/**
 * The presentational body of the Session Details dialog — the conversation's
 * identity, identifiers, token usage, and timestamps. Kept apart from the
 * modal (`SessionDetailsDialog`) so its data contract is dialog-agnostic: a
 * `summary` plus the tri-state `stats`/`model` contract (see the prop docs).
 * The aux-panel Session Details tab shows the compact `SessionDetailsCard`
 * instead.
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
  const rawModel = resolvedModel ?? summary.model ?? null
  // Every source above yields the id the transcript recorded. Some agents name
  // their models with an account-internal key, so show what the agent's own
  // picker calls it (unknown ids fall through unchanged).
  const modelLabel = useModelLabels(summary.agent_type)
  const displayModel = modelLabel(rawModel)

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
    stats != null &&
    (totalTokens != null ||
      usage != null ||
      contextWindowValue != null ||
      durationMs > 0)

  const numeric = "font-mono tabular-nums"

  return (
    // `@container` drives the identifier / token / timestamp grids: one column
    // when the dialog is narrow, two once it has the room.
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
        {summary.assistant_id != null && (
          <InfoItem label={t("assistant")}>
            <AssistantInline
              id={summary.assistant_id}
              snapshotName={summary.assistant_name ?? null}
            />
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
