"use client"

/**
 * One collapsible row for a delegation status / cancel poll. Renders the
 * intent label ("waiting for task <id>'s result" / "canceling task <id>") and
 * an optional check-count hint (`×N`, the number of times the task was
 * polled), with the task's status and execution time at the end of the line
 * (`done · 42s`); expands inline to reveal the result, Markdown-rendered.
 * A task polled more than once paginates through
 * each check's result (latest first) via a `< N / M >` footer whose total
 * matches the `×N` hint.
 *
 * The row takes a pre-resolved `report` + `badge` (the latest poll) plus the
 * per-poll `results` list (one entry per check, `null` where a check returned
 * no text), so a lone check and a task's grouped checks share one row. It is
 * drawn on the activity timeline's rail, whose ring carries the icon and the
 * state.
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
import { ChevronLeft, ChevronRight } from "lucide-react"
import { useTranslations } from "next-intl"

import { cn } from "@/lib/utils"
import type { ResolvedBadge, StatusReport } from "@/lib/delegation-status"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { MessageResponse } from "@/components/ai-elements/message"
import { ConnectionBlockingPrompts } from "@/components/chat/connection-blocking-prompts"
import {
  RowChevron,
  RowFigure,
} from "@/components/message/activity/activity-row"
import { ErrorLabel } from "@/components/message/delegation-status-badge"
import { useDelegationStatusContext } from "@/components/message/delegation-status-index-context"
import { useDelegationTaskLive } from "@/hooks/use-delegation-task-live"
import { useElapsedLabel } from "@/hooks/use-elapsed-label"

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
  /** Told the status the row shows whenever it changes — the polled one, or
   *  what the live sub-agent overrides it with — so the rail it sits on can
   *  agree with it. */
  onStatusChange?: (status: ResolvedBadge["status"]) => void
  /** Told whether the row's panel is open, so the rail can run beside it. */
  onOpenChange?: (open: boolean) => void
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
  onStatusChange,
  onOpenChange,
}: DelegationStatusRowProps) {
  const t = useTranslations("Folder.chat.delegation")
  const elapsedLabel = useElapsedLabel()
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
  useEffect(() => {
    onStatusChange?.(badge.status)
  }, [onStatusChange, badge.status])

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

  const isRunning = badge.status === "running"
  const duration = elapsedLabel(report.durationMs)
  const open = expandable && expanded
  useEffect(() => {
    onOpenChange?.(open)
  }, [onOpenChange, open])

  const shortId = taskId ? taskId.slice(0, 8) : null
  const label =
    kind === "cancel"
      ? shortId
        ? t("cancelTask", { task: `#${shortId}` })
        : t("cancelTaskNoTask")
      : shortId
        ? t("waitForResult", { task: `#${shortId}` })
        : t("waitForResultNoTask")

  // Laid out like the timeline's other rows: the label with the chevron
  // after it, and the status and time at the end — as a delegation's own row
  // reads `done · 42s`.
  const row = (
    <>
      <span className="flex min-w-0 items-start gap-1">
        <span className="flex min-w-0 items-baseline gap-2">
          <span
            className={cn(
              "min-w-0 truncate font-medium",
              isRunning ? "activity-shimmer" : "text-activity-secondary"
            )}
            title={taskId ?? undefined}
          >
            {label}
          </span>
          {results.length > 1 && (
            <span className="shrink-0 text-xs tabular-nums text-activity-secondary">
              ×{results.length}
            </span>
          )}
        </span>
        {expandable ? <RowChevron open={open} /> : null}
      </span>
      <RowFigure>
        <PollStatusWord
          status={badge.status}
          errorCode={badge.errorCode}
          duration={duration}
        />
      </RowFigure>
    </>
  )
  const headerClass =
    "group/row flex w-full min-w-0 items-start py-0.5 text-start text-sm leading-6"

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
          className={cn(
            headerClass,
            "activity-row-toggle cursor-pointer rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          )}
        >
          {row}
        </button>
      ) : (
        <div className={headerClass}>{row}</div>
      )}
      {expandable && expanded && (
        <div
          id={panelId}
          className="mt-1 mb-1.5 overflow-hidden rounded-[0.625rem] border border-border bg-background ws-msg-card"
        >
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
          {/* One scroll area for the whole result, on the overlay scrollbars;
              its code blocks grow inside it instead of scrolling on their
              own. */}
          {hasAnyResultText && (
            <ScrollArea key={idx} className="max-h-80">
              <div className="px-3 pb-2 pt-2">
                {hasResultText ? (
                  <div className="prose prose-sm max-w-none break-words text-xs dark:prose-invert [&_ol]:list-inside [&_ul]:list-inside">
                    <MessageResponse>{resultText}</MessageResponse>
                  </div>
                ) : (
                  <p className="text-xs italic text-muted-foreground">
                    {t("noResultText")}
                  </p>
                )}
              </div>
            </ScrollArea>
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

/** The end of a check's row: `done · 1.2s`; red when it failed, amber while
 *  the sub-agent waits on the user. */
function PollStatusWord({
  status,
  errorCode,
  duration,
}: {
  status: ResolvedBadge["status"]
  errorCode?: string
  duration: string | null
}) {
  const t = useTranslations("Folder.chat.delegation.status")
  const time = duration ? ` · ${duration}` : ""
  switch (status) {
    case "err":
      return (
        <span className="text-tone-danger" title={errorCode}>
          <ErrorLabel code={errorCode} />
          {time}
        </span>
      )
    case "waiting":
      return <span className="text-tone-warning">{t("waiting")}</span>
    default:
      return (
        <span>
          {t(status)}
          {time}
        </span>
      )
  }
}
