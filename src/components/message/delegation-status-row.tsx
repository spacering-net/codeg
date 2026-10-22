"use client"

/**
 * One collapsible row for a delegation status / cancel poll. Renders the
 * intent label ("waiting for task <id>'s result" / "canceling task <id>"), an
 * optional check-count hint (`×N`, the number of times the task was polled),
 * the task execution time, and a status badge; expands inline to reveal the
 * result, Markdown-rendered. A task polled more than once paginates through
 * each check's result (latest first) via a `< N / M >` footer whose total
 * matches the `×N` hint.
 *
 * The row takes a pre-resolved `report` + `badge` (the latest poll) plus the
 * per-poll `results` list (one entry per check, `null` where a check returned
 * no text), so both the single `DelegationStatusCard` and the merged
 * `DelegationStatusGroupCard` (which groups polls per task) share one row. The
 * outer card owns the border / rounded shape / error tint.
 *
 * One thing it reads live: a status row whose wait is not over looks at the
 * sub-agent itself (`useDelegationTaskLive`). While that sub-agent is parked on
 * the user — a permission, a question, a plan approval — the row says so, opens
 * by itself, and carries the prompt, answered through the sub-agent's own
 * connection (#973). Once it is answered the row goes back to what the polls
 * said, minus the stale "awaiting approval" of a poll that predates the answer.
 *
 * Only the task's newest row in the transcript does that (see
 * `@/lib/delegation-status-index`). An agent re-polls a parked sub-agent until
 * it is answered, and whatever it says in between leaves one card per poll;
 * were every one of them to carry the prompt, the same decision would be
 * mounted, opened and re-rendered once per card. An older row is a superseded
 * check: it stays out of the live state, and its "awaiting approval" reads as
 * "checked", the newest row speaking for the task now. The one exception is a
 * row the user has started answering in: it keeps the decision until that is
 * answered, so a re-poll does not pull it — and an unsent answer — away.
 */

import { memo, useEffect, useId, useMemo, useState } from "react"
import {
  Activity,
  Ban,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
} from "lucide-react"
import { useTranslations } from "next-intl"

import { cn } from "@/lib/utils"
import {
  formatDuration,
  type ResolvedBadge,
  type StatusReport,
} from "@/lib/delegation-status"
import { Button } from "@/components/ui/button"
import { MessageResponse } from "@/components/ai-elements/message"
import { Shimmer } from "@/components/ai-elements/shimmer"
import { ConnectionBlockingPrompts } from "@/components/chat/connection-blocking-prompts"
import { StatusBadge } from "@/components/message/delegation-status-badge"
import { useDelegationStatusContext } from "@/components/message/delegation-status-index-context"
import { useDelegationTaskLive } from "@/hooks/use-delegation-task-live"

interface DelegationStatusRowProps {
  /** Which companion tool this row represents — selects the label + icon. */
  kind: "status" | "cancel"
  taskId: string | null
  report: StatusReport
  badge: ResolvedBadge
  /**
   * One entry per poll of this task, in chronological order (`null` where a
   * poll returned no result text). Its length is the `×N` header hint (when
   * >1) and the expanded panel paginates through the entries (latest shown
   * first), so the badge count and the pager total always equal the check
   * count. Falls back to the single `report.text` so the standalone card is
   * unchanged.
   */
  results?: (string | null)[]
  /** The backend vouched for `taskId` by reporting it running to one of these
   *  polls (`DelegationTaskRow.runningConfirmed`) — required before the row
   *  reaches the live sub-agent behind it. The transcript's index can vouch
   *  for the task as well, from a poll drawn in another card. */
  runningConfirmed?: boolean
  /** The call id of the row's latest poll (`DelegationTaskRow.latestPollId`):
   *  matched against the transcript's index to tell the task's newest row
   *  from a superseded one. Without it the row is its own newest. */
  latestPollId?: string | null
}

// Memoized: the rows of a card that keeps its polls are the same objects
// across the parent's streaming batches, so they skip those re-renders.
export const DelegationStatusRow = memo(function DelegationStatusRow({
  kind,
  taskId,
  report,
  badge: polledBadge,
  results: resultsProp,
  runningConfirmed = false,
  latestPollId = null,
}: DelegationStatusRowProps) {
  const t = useTranslations("Folder.chat.delegation")
  const panelId = useId()

  // A later card of this transcript polled the same task: this row is a
  // superseded check. Unknown to the index (a card drawn outside a
  // transcript), the row is its own newest.
  const transcript = useDelegationStatusContext()
  const statusTaskId = kind === "status" ? taskId : null
  const indexed =
    statusTaskId != null ? transcript?.index.get(statusTaskId) : undefined
  const superseded =
    indexed != null &&
    latestPollId != null &&
    indexed.latestPollId !== latestPollId
  // The row the user is answering the task's decision in, if any.
  const hold =
    statusTaskId != null ? transcript?.held.get(statusTaskId) : undefined
  const holding = hold?.token === panelId

  // A wait that is over (the task finished, failed, or is unknown) is history:
  // only an open one looks at the live sub-agent, and only from the newest row
  // or the one holding its decision.
  const waitOpen = polledBadge.status !== "ok" && polledBadge.status !== "err"
  const live = useDelegationTaskLive(
    waitOpen && (!superseded || holding) ? statusTaskId : null,
    runningConfirmed || indexed?.runningConfirmed === true
  )
  const childConnectionId = live.childConnectionId
  const pending = childConnectionId != null ? live.prompts : null
  // A hold stands while a decision it was taken on is still pending; then the
  // decision stays in that row, the newest row included.
  const holdStands =
    hold != null &&
    pending != null &&
    hold.ids.some((id) => pending.ids.includes(id))
  const prompts =
    pending != null && (holdStands ? holding : !superseded) ? pending : null
  // Live beats the poll: parked now is "waiting" even under a still-spinning
  // re-poll, and a poll's "waiting" is stale once the sub-agent is known to
  // wait no more (answered, or its delegation over) — or once a newer row
  // speaks for the task.
  const badge: ResolvedBadge = pending
    ? { status: "waiting" }
    : (superseded || live.notWaiting) && polledBadge.status === "waiting"
      ? { status: "checked" }
      : polledBadge

  // The user reaching into the decision holds it here. Let go once nothing it
  // was taken on is pending, and when the row goes.
  const takeHold = () => {
    if (prompts && statusTaskId != null) {
      transcript?.hold(statusTaskId, panelId, prompts.ids)
    }
  }
  const release = transcript?.release
  useEffect(() => {
    if (holding && !holdStands && statusTaskId != null) {
      release?.(statusTaskId, panelId)
    }
  }, [holding, holdStands, release, statusTaskId, panelId])
  useEffect(() => {
    if (!release || statusTaskId == null) return
    return () => release(statusTaskId, panelId)
  }, [release, statusTaskId, panelId])

  // Opens by itself for each decision the sub-agent asks for, unless the user
  // closed it with that very decision showing; otherwise it is the user's last
  // toggle.
  const [userExpanded, setUserExpanded] = useState(false)
  const [closedPromptIds, setClosedPromptIds] = useState<string[]>([])
  const expanded = prompts
    ? prompts.ids.some((id) => !closedPromptIds.includes(id))
    : userExpanded
  const toggleExpanded = () => {
    const next = !expanded
    setUserExpanded(next)
    if (prompts) setClosedPromptIds(next ? [] : prompts.ids)
  }

  // The group card passes one entry per poll (so `×N` reflects the actual
  // check count); a standalone card passes nothing and falls back to its
  // single report.
  const results = useMemo<(string | null)[]>(() => {
    if (resultsProp && resultsProp.length > 0) return resultsProp
    return report.text ? [report.text] : []
  }, [resultsProp, report.text])

  // `null` = follow the latest result (the default, matching the collapsed
  // header's latest poll); a number = a page the user explicitly navigated to.
  // Tracking "follow latest" rather than a fixed index matters because the row
  // instance is keyed by task id and survives streaming rerenders — pinning an
  // index at mount would strand a row first seen with one result on page 1/M
  // once more polls arrive. Clamp the explicit case so a shrinking list can
  // never index out of range.
  const [pageIdx, setPageIdx] = useState<number | null>(null)
  const lastIdx = Math.max(results.length - 1, 0)
  const idx =
    pageIdx == null ? lastIdx : Math.min(Math.max(pageIdx, 0), lastIdx)
  const resultText = results[idx]
  const hasResultText = resultText != null && resultText.trim() !== ""
  const hasPager = results.length > 1

  // Expandable as long as at least one poll captured result text, or there is
  // a prompt to answer; a lone still-running poll with nothing to show stays a
  // plain (non-expandable) row.
  const hasAnyResultText = results.some((r) => r != null && r.trim() !== "")
  const expandable = hasAnyResultText || prompts != null

  const isError = badge.status === "err"
  const isRunning = badge.status === "running"
  const duration =
    report.durationMs != null ? formatDuration(report.durationMs) : null

  const shortId = taskId ? taskId.slice(0, 8) : null
  const label =
    kind === "cancel"
      ? shortId
        ? t("cancelTask", { task: `#${shortId}` })
        : t("cancelTaskNoTask")
      : shortId
        ? t("waitForResult", { task: `#${shortId}` })
        : t("waitForResultNoTask")

  const Icon = kind === "cancel" ? Ban : Activity

  const row = (
    <>
      <Icon
        className={cn(
          "h-3.5 w-3.5 shrink-0",
          isError ? "text-destructive" : "text-muted-foreground"
        )}
      />
      <span
        className="min-w-0 truncate text-xs font-medium text-foreground"
        title={taskId ?? undefined}
      >
        {isRunning ? (
          <Shimmer as="span" duration={1} shineColor="var(--primary)">
            {label}
          </Shimmer>
        ) : (
          label
        )}
      </span>
      {results.length > 1 && (
        <span className="shrink-0 text-xs tabular-nums text-muted-foreground/70">
          ×{results.length}
        </span>
      )}
      {duration && (
        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
          {duration}
        </span>
      )}
      <StatusBadge status={badge.status} errorCode={badge.errorCode} />
      {expandable &&
        (expanded ? (
          <ChevronDown className="ml-auto h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="ml-auto h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        ))}
    </>
  )

  return (
    <>
      {expandable ? (
        <button
          type="button"
          onClick={toggleExpanded}
          aria-expanded={expanded}
          // The panel is only mounted while expanded (keeps the heavy Markdown
          // renderer out of the collapsed tree), so only reference it then —
          // avoids a dangling `aria-controls` target while collapsed.
          aria-controls={expanded ? panelId : undefined}
          className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-muted/50"
        >
          {row}
        </button>
      ) : (
        <div className="flex w-full items-center gap-2 px-3 py-2">{row}</div>
      )}
      {expandable && expanded && (
        <div id={panelId} className="border-t border-border">
          {/* Above the results and outside their scroll area: the decision is
              why the row opened, and its buttons must not scroll away. */}
          {childConnectionId != null && prompts && (
            <div
              data-testid="delegation-status-prompts"
              className={cn(hasAnyResultText && "border-b border-border")}
              onPointerDownCapture={takeHold}
              onFocusCapture={takeHold}
            >
              <ConnectionBlockingPrompts
                connectionId={childConnectionId}
                prompts={prompts}
                agentType={live.agentType}
                itemClassName="p-3"
              />
            </div>
          )}
          {/* Keyed by the page index so switching results remounts the scroll
              area, resetting it to the top (a scrolled long result would
              otherwise leave the next one scrolled mid-way). */}
          {hasAnyResultText && (
            <div key={idx} className="max-h-80 overflow-auto px-3 pb-2 pt-2">
              {hasResultText ? (
                <div className='prose prose-sm max-w-none break-words text-xs dark:prose-invert [&_ol]:list-inside [&_ul]:list-inside [&_[data-streamdown="code-block-body"]]:max-h-96 [&_[data-streamdown="code-block-body"]]:overflow-auto'>
                  <MessageResponse>{resultText}</MessageResponse>
                </div>
              ) : (
                <p className="text-xs italic text-muted-foreground">
                  {t("noResultText")}
                </p>
              )}
            </div>
          )}
          {hasAnyResultText && hasPager && (
            <div className="flex items-center justify-center gap-1 border-t border-border px-3 py-1">
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                disabled={idx <= 0}
                aria-label={t("prevResult")}
                title={t("prevResult")}
                onClick={() => setPageIdx(idx - 1)}
              >
                <ChevronLeft className="size-3" />
              </Button>
              <span className="min-w-12 text-center text-xs tabular-nums text-muted-foreground">
                {t("resultPageOf", {
                  current: idx + 1,
                  total: results.length,
                })}
              </span>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                disabled={idx >= lastIdx}
                aria-label={t("nextResult")}
                title={t("nextResult")}
                onClick={() => setPageIdx(idx + 1)}
              >
                <ChevronRight className="size-3" />
              </Button>
            </div>
          )}
        </div>
      )}
    </>
  )
})
