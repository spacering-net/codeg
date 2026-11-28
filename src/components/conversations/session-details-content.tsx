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
import {
  useDelegationIdentityLabel,
  useIdentityAssistant,
} from "@/components/message/delegation-identity"
import { BotAvatar } from "@/components/personal-agent/bot-avatar"
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
  botUid,
  snapshotName,
}: {
  id: number | null
  botUid: string | null
  snapshotName: string | null
}) {
  const t = useTranslations("Folder.chat.delegation")
  const assistant = useIdentityAssistant({ assistantId: id, botUid })
  const { name, deleted } = useDelegationIdentityLabel({
    agentType: null,
    assistantId: id,
    assistantName: snapshotName,
    botUid,
  })
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      <BotAvatar
        avatar={assistant?.avatar ?? null}
        name={name}
        size={16}
        star={assistant?.primary}
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
 * for identifiers worth copying — the session id and the session index.
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
 * A copy button for one property of `SessionDetailsCard`: hidden until its
 * cell is pointed at or holds focus (shown on a touch screen, which can't
 * point), and while it says the copy went through. It hangs off the value's
 * end rather than taking room beside it, so the value stays centred in its
 * column whether it shows or not.
 */
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
      className={cn(
        "absolute start-full top-1/2 ms-0.5 inline-flex size-4 -translate-y-1/2 items-center justify-center rounded text-muted-foreground outline-none transition-[opacity,color] hover:bg-foreground/5 hover:text-foreground focus-visible:opacity-100 focus-visible:ring-[3px] focus-visible:ring-ring/50 group-focus-within/prop:opacity-100 group-hover/prop:opacity-100 [@media(hover:none)]:opacity-100",
        copied ? "opacity-100" : "opacity-0"
      )}
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
 * One cell of `SessionDetailsCard`'s properties, centred in its column: the
 * value, bold and a size up, over its label. The label stays first in the
 * markup — a `dt` before its `dd` — and is only drawn under it. The cells of a
 * line share its width evenly and are split by hairlines.
 * The cell groups its label and value for the hover that lights its copy
 * button.
 */
function PropertyCell({
  label,
  children,
}: {
  label: string
  children: ReactNode
}) {
  return (
    <div className="group/prop flex min-w-0 flex-col-reverse px-2 text-center">
      <dt className="mt-0.5 truncate text-xs leading-4 text-muted-foreground">
        {label}
      </dt>
      <dd className="flex h-6 min-w-0 items-center justify-center gap-1 text-[0.9375rem] font-semibold text-foreground">
        {children}
      </dd>
    </div>
  )
}

/** The properties' tile: a softly tinted, hairlined box, its lines stacked
 *  with a hairline between each two. Its padding keeps the hairlines between
 *  the cells short of its edges. */
const PROPERTY_TILE =
  "min-w-0 rounded-xl border border-border/60 bg-muted/30 px-1 py-2.5 [&>*+*]:mt-2.5 [&>*+*]:border-t [&>*+*]:border-border/50 [&>*+*]:pt-2.5"

/**
 * A copyable value of `PropertyCell`, its copy button hanging off its end.
 * Spacers the button's width flank it: with room to spare the value stays
 * centred in its cell, and the button sits in the end one. Short of room, the
 * start spacer gives way first (its shrink outweighs the value's), so the
 * value moves toward the start and truncates while the button still keeps
 * inside the cell, short of the hairline into the next one.
 */
function CopyableProperty({
  children,
  ...button
}: {
  children: ReactNode
  text: string
  copyLabel: string
  copiedLabel: string
}) {
  return (
    <>
      <span aria-hidden="true" className="w-4.5 shrink-[999]" />
      <span className="relative flex min-w-0">
        {children}
        <CopyPropertyButton {...button} />
      </span>
      <span aria-hidden="true" className="w-4.5 shrink-0" />
    </>
  )
}

/** A line of property cells, as wide as each other, a hairline between each
 *  two. */
const PROPERTY_LINE =
  "grid min-w-0 auto-cols-fr grid-flow-col [&>*+*]:border-s [&>*+*]:border-border/50"

/** The part of the session index (the agent's own id for the session) shown:
 *  its first segment, which is enough to tell two apart at a glance; the
 *  whole one is copied. */
function externalIdHead(value: string): string {
  return value.split("-")[0] || value
}

/** The head of `SessionDetailsCard` for a sub-session run as an assistant:
 *  the assistant's avatar where the agent icon goes, as the conversation list
 *  draws that row. No primary's star — its corner holds the status dot. */
function SessionAssistantAvatar({
  id,
  botUid,
  snapshotName,
}: {
  id: number | null
  botUid: string | null
  snapshotName: string | null
}) {
  const assistant = useIdentityAssistant({ assistantId: id, botUid })
  return (
    <BotAvatar
      avatar={assistant?.avatar ?? null}
      name={assistant?.name ?? snapshotName ?? ""}
      size={36}
    />
  )
}

/** The assistant's name, leading `SessionDetailsCard`'s agent line. */
function SessionAssistantName({
  id,
  botUid,
  snapshotName,
}: {
  id: number | null
  botUid: string | null
  snapshotName: string | null
}) {
  const t = useTranslations("Folder.chat.delegation")
  const { name, deleted } = useDelegationIdentityLabel({
    agentType: null,
    assistantId: id,
    assistantName: snapshotName,
    botUid,
  })
  const label = deleted ? `${name} ${t("deletedAssistant")}` : name
  return (
    <span
      data-testid="session-assistant-name"
      title={label}
      className="max-w-[40%] shrink-0 truncate"
    >
      {label}
    </span>
  )
}

/**
 * The Session Details side panel's summary of the active conversation, drawn
 * straight on the panel. Its head: the agent's icon — the assistant's avatar
 * when it ran as one — the status a dot on its corner as the conversation list
 * draws it; beside it the title, and under the title the assistant's name
 * when it has one, the agent's name and the model. Under it a tile of its
 * properties, value over label, a column each, centred: the branch, the conversation's id and
 * its session index — the agent's own id for it — (both copyable); then the
 * parent conversation when it has one. The panel's room goes to the plan and
 * the message navigator under it; the dialog (`SessionDetailsContent`) is the
 * full view, with token usage and timestamps.
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
  const statusLabel = knownStatus ? tStatus(knownStatus) : summary.status
  const agentLabel = getAgentLabel(summary.agent_type)
  const ranAs = summary.assistant_id != null || summary.bot_uid != null

  return (
    <section className="min-w-0 py-4">
      <div className="flex min-w-0 items-start gap-3">
        {/* Decorative: the line under the title says which agent (and which
            assistant) it is, the icon's SVG carries a <title> of its own that
            would repeat it, and the status is said in words beside the name. */}
        <span
          data-testid="session-agent-avatar"
          aria-hidden="true"
          className="relative mt-0.5 flex shrink-0"
        >
          {ranAs ? (
            <SessionAssistantAvatar
              id={summary.assistant_id ?? null}
              botUid={summary.bot_uid ?? null}
              snapshotName={summary.assistant_name ?? null}
            />
          ) : (
            <AgentIcon agentType={summary.agent_type} className="size-9" />
          )}
          <ConversationStatusDot
            status={knownStatus}
            className={cn(
              "absolute -end-0.5 -bottom-0.5 size-2.5 ring-2 ring-background"
            )}
          />
        </span>
        <div className="min-w-0 flex-1">
          <p
            title={title}
            className="line-clamp-2 text-sm leading-5 font-semibold text-foreground [overflow-wrap:anywhere]"
          >
            {title}
          </p>
          <p
            data-testid="session-agent-line"
            className="mt-1 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground"
          >
            {ranAs && (
              <>
                <SessionAssistantName
                  id={summary.assistant_id ?? null}
                  botUid={summary.bot_uid ?? null}
                  snapshotName={summary.assistant_name ?? null}
                />
                <span aria-hidden="true">·</span>
              </>
            )}
            <span className="max-w-[50%] shrink-0 truncate">{agentLabel}</span>
            {displayModel && (
              <>
                <span aria-hidden="true">·</span>
                <span title={displayModel} className="min-w-0 truncate">
                  {displayModel}
                </span>
              </>
            )}
            <span className="sr-only">{`${t("status")}: ${statusLabel}`}</span>
          </p>
        </div>
      </div>
      <dl className={cn("mt-4", PROPERTY_TILE)}>
        <div className={PROPERTY_LINE}>
          <PropertyCell label={t("gitBranch")}>
            {summary.git_branch ? (
              <span
                dir="ltr"
                title={summary.git_branch}
                className="min-w-0 truncate"
              >
                {summary.git_branch}
              </span>
            ) : (
              t("none")
            )}
          </PropertyCell>
          <PropertyCell label={t("sessionId")}>
            <CopyableProperty
              text={String(summary.id)}
              copyLabel={t("copyField", { field: t("sessionId") })}
              copiedLabel={t("copiedField", { field: t("sessionId") })}
            >
              <span className="truncate tabular-nums">{summary.id}</span>
            </CopyableProperty>
          </PropertyCell>
          <PropertyCell label={t("externalId")}>
            {summary.external_id ? (
              <CopyableProperty
                text={summary.external_id}
                copyLabel={t("copyField", { field: t("externalId") })}
                copiedLabel={t("copiedField", { field: t("externalId") })}
              >
                <span
                  dir="ltr"
                  title={summary.external_id}
                  className="truncate tabular-nums"
                >
                  {externalIdHead(summary.external_id)}
                </span>
              </CopyableProperty>
            ) : (
              t("none")
            )}
          </PropertyCell>
        </div>
        {summary.parent_id != null && (
          <div className={PROPERTY_LINE}>
            <PropertyCell label={t("parentId")}>
              <span className="tabular-nums">{summary.parent_id}</span>
            </PropertyCell>
          </div>
        )}
      </dl>
    </section>
  )
}

/**
 * `SessionDetailsCard`'s stand-in for a conversation that has no messages yet
 * — a new tab, or one whose first message is on its way: laid out like it,
 * with what is already known. Its head: the agent's icon, a status-less "new
 * session", and the agent's name over the wait for the first message; its
 * tile: the branch and the folder it will run in. A folderless chat has
 * neither, and says so. Given a `title`, the conversation is one already
 * whose summary hasn't come through: its title instead, and no wait.
 */
export function DraftSessionDetailsCard({
  agentType,
  branch,
  folder,
  title = null,
}: {
  agentType: AgentType
  branch: string | null
  folder: { name: string; path: string } | null
  title?: string | null
}) {
  const t = useTranslations("Folder.sessionDetails")
  return (
    <section data-testid="draft-session-details" className="min-w-0 py-4">
      <div className="flex min-w-0 items-start gap-3">
        <span aria-hidden="true" className="mt-0.5 flex shrink-0">
          <AgentIcon agentType={agentType} className="size-9" />
        </span>
        <div className="min-w-0 flex-1">
          <p
            title={title ?? undefined}
            className="truncate text-sm leading-5 font-semibold text-foreground"
          >
            {title ?? t("draftTitle")}
          </p>
          <p className="mt-1 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
            <span className="max-w-[50%] shrink-0 truncate">
              {getAgentLabel(agentType)}
            </span>
            {title == null && (
              <>
                <span aria-hidden="true">·</span>
                <span className="min-w-0 truncate">{t("draftWaiting")}</span>
              </>
            )}
          </p>
        </div>
      </div>
      <dl className={cn("mt-4", PROPERTY_TILE)}>
        <div className={PROPERTY_LINE}>
          <PropertyCell label={t("gitBranch")}>
            {branch ? (
              <span dir="ltr" title={branch} className="min-w-0 truncate">
                {branch}
              </span>
            ) : (
              t("none")
            )}
          </PropertyCell>
          <PropertyCell label={t("folder")}>
            {folder ? (
              <span title={folder.path} className="min-w-0 truncate">
                {folder.name}
              </span>
            ) : (
              t("none")
            )}
          </PropertyCell>
        </div>
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
        {(summary.assistant_id != null || summary.bot_uid != null) && (
          <InfoItem label={t("assistant")}>
            <AssistantInline
              id={summary.assistant_id ?? null}
              botUid={summary.bot_uid ?? null}
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
