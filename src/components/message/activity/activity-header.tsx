"use client"

import { memo, useMemo, type MouseEvent, type Ref } from "react"
import { useTranslations } from "next-intl"

import type { ActivitySummary } from "@/lib/activity/types"
import { cn } from "@/lib/utils"
import { RowChevron } from "./activity-row"

/** Categories the header names, most telling first; at most three are shown
 *  (the full breakdown is in the tooltip) so the line never reads like a
 *  debug dump. */
const CATEGORY_ORDER = [
  "commands",
  "editedFiles",
  "agents",
  "mcp",
  "web",
  "readFiles",
  "searches",
] as const

const CATEGORY_KEY = {
  commands: "header.commands",
  editedFiles: "header.edits",
  agents: "header.agents",
  mcp: "header.mcp",
  web: "header.web",
  readFiles: "header.reads",
  searches: "header.searches",
} as const

/**
 * The turn's activity header: a capsule only as wide as what it says —
 * `Activity 14 steps · 1 failed, recovered · 3m 34s ›` — and 2rem tall, a
 * little taller than a timeline row, the head of the rows hung under it.
 * The count comes first, then how the turn ended, then the time the turn
 * took; the chevron ends it. The breakdown by kind (`6 commands · 1 edit ·
 * …`) is the tooltip's, not the line's, so the capsule stays short however
 * much a turn did. While the turn runs it reads `Working 6 steps` with a
 * shimmer; a reply with no steps keeps a `Reply 3s` header so the slot never
 * blinks in and out as a turn settles.
 *
 * An unrecovered failure is red and, when `onJumpToFailure` is given, a button
 * that opens the turn at that step.
 */
export const ActivityHeader = memo(function ActivityHeader({
  ref,
  summary,
  completed,
  hasSteps,
  elapsed,
  toggle,
  onJumpToFailure,
}: {
  /** The capsule, for the turn to bring back into view as it folds. */
  ref?: Ref<HTMLDivElement>
  summary: ActivitySummary | null
  completed: boolean
  hasSteps: boolean
  elapsed: string | null
  /** Folding the turn away, when it can fold. */
  toggle?: { open: boolean; onToggle: () => void; controls?: string }
  onJumpToFailure?: () => void
}) {
  const t = useTranslations("Folder.chat.activity")
  const separator = t("header.separator")

  // The line carries the step count only — the breakdown by kind is what the
  // tooltip is for. `full` keeps it for that tooltip, most telling first.
  const { pieces, full } = useMemo(() => {
    if (!summary) return { pieces: [] as string[], full: [] as string[] }
    const categories = CATEGORY_ORDER.filter(
      (key) => summary.counts[key] > 0
    ).map((key) => t(CATEGORY_KEY[key], { count: summary.counts[key] }))
    const lead =
      summary.steps > 0 ? [t("header.steps", { count: summary.steps })] : []
    return { pieces: lead, full: [...lead, ...categories] }
  }, [summary, t])

  const label = !completed
    ? t("header.working")
    : hasSteps
      ? t("header.label")
      : t("header.reply")

  const failureClause =
    summary && summary.failed > 0
      ? summary.unrecovered > 0
        ? {
            text: t("header.failed", { count: summary.unrecovered }),
            danger: true,
          }
        : {
            text: t("header.failedRecovered", { count: summary.failed }),
            danger: false,
          }
      : null
  const interruptedClause =
    summary && summary.interrupted > 0
      ? t("header.interrupted", { count: summary.interrupted })
      : null

  const hasSummaryLine =
    pieces.length > 0 || !!failureClause || !!interruptedClause
  const tooltip = full.join(separator)
  // The label takes the same size as the figures beside it; only its weight
  // sets it apart. Where the capsule runs out of room (a narrow column) the
  // summary gives way first, then the label — kept whole until the summary is
  // gone, never wider than the room left — each cut with an ellipsis, so the
  // time and the chevron stay whole and nothing runs over them.
  const labelClass = cn(
    "max-w-full shrink-0 truncate text-xs font-semibold",
    completed ? "text-foreground" : "activity-shimmer"
  )

  // The whole header folds and unfolds the reply; its label is the control
  // for the keyboard and screen readers. A press on a button inside (that
  // label, the failure link) is the button's own. Nothing in the capsule can
  // be selected (`select-none`): a quick second press selected a word in it,
  // which raised the transcript's copy bubble and kept the press from
  // toggling. So a press here never makes a selection, and one made elsewhere
  // is left as it is — no reason not to toggle. (A drag that starts outside
  // and ends here sends its click to an element the two share, not here.)
  const onHeaderClick = toggle
    ? (event: MouseEvent<HTMLDivElement>) => {
        if ((event.target as Element | null)?.closest("button")) return
        toggle.onToggle()
      }
    : undefined

  return (
    <div
      ref={ref}
      // The same capsule in every shape of the reply, the pending one's too
      // (`ReplyMotion`).
      data-motion-key="header"
      // `activity-capsule`: filled like the user's message bubble, over a
      // workspace background image too — translucent there, with its ring —
      // and a step deeper in the same colour when pointed at (globals.css).
      // A block, not inline: no line box around it adds room under it, so
      // what follows starts at its bottom edge.
      className={cn(
        "activity-capsule flex h-8 w-fit max-w-full min-w-0 select-none items-center gap-2 rounded-full bg-activity-capsule px-4 text-xs transition-colors",
        toggle && "group/row cursor-pointer hover:bg-activity-capsule-hover"
      )}
      onClick={onHeaderClick}
    >
      {/* What the capsule says, the time last: the time keeps its width
          while the words before it give way, so it never runs over the
          chevron. */}
      <span className="flex min-w-0 items-center">
        <span className="flex min-w-0 items-center gap-2">
          {toggle ? (
            <button
              type="button"
              className={cn(
                labelClass,
                "cursor-pointer rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              )}
              aria-expanded={toggle.open}
              aria-controls={toggle.controls}
              onClick={toggle.onToggle}
            >
              {label}
            </button>
          ) : (
            <span className={labelClass}>{label}</span>
          )}
          {hasSummaryLine ? (
            <span
              className="activity-mono min-w-0 truncate text-xs text-activity-muted-strong"
              title={tooltip || undefined}
            >
              {pieces.join(separator)}
              {failureClause ? (
                <>
                  {pieces.length > 0 ? separator : null}
                  {failureClause.danger && onJumpToFailure ? (
                    <button
                      type="button"
                      className="rounded-sm text-activity-capsule-danger underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      title={t("header.jumpToFailure")}
                      onClick={onJumpToFailure}
                    >
                      {failureClause.text}
                    </button>
                  ) : (
                    <span
                      className={
                        failureClause.danger
                          ? "text-activity-capsule-danger"
                          : undefined
                      }
                    >
                      {failureClause.text}
                    </span>
                  )}
                </>
              ) : null}
              {interruptedClause ? (
                <>
                  {pieces.length > 0 || failureClause ? separator : null}
                  {interruptedClause}
                </>
              ) : null}
            </span>
          ) : null}
        </span>
        {/* The time closes what the capsule says, after the separator the
            summary uses — kept as written (`whitespace-pre`: a flex item
            would drop its leading space). It stays, a reply with no steps
            keeping its `Reply 3s`, so the slot never blinks in and out as a
            turn settles. */}
        {elapsed && completed ? (
          <span
            className={cn(
              "activity-mono shrink-0 whitespace-pre text-xs text-activity-muted-strong",
              !hasSummaryLine && "ms-2"
            )}
          >
            {hasSummaryLine ? separator : null}
            {elapsed}
          </span>
        ) : null}
      </span>
      {/* The chevron ends the capsule, centred on it (the row's own is
          placed for a 1.5rem line by margin, which the flex centres here). */}
      {toggle ? (
        <RowChevron open={toggle.open} always className="mb-0 mt-0" />
      ) : null}
    </div>
  )
})
