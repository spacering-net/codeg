"use client"

/**
 * The composer dock's view of the AIR session-failure table — only what is
 * still IN PROGRESS, drawn in the dock's `ComposerDockStrip` frame beside the
 * legacy retry line (see `ComposerStatusStrips`):
 *
 * - ACTIVE retry incidents (warnings outside category "unknown": the adapter
 *   lost the upstream and is reconnecting on its own) collapse to ONE amber
 *   strip with a spinner — the LATEST one plus a hidden count. On advertising
 *   connections codex routes what used to be the single-slot `turn_retrying`
 *   channel here, and one strip per record stacked a fresh row for every
 *   reconnect of a long turn (issue #496). The host hides them while its
 *   richer retry line shows the same retry, and whenever no turn is running:
 *   nothing can be retrying then.
 * - Of the RESOLVED records only the most recent incident that recovered ON
 *   ITS OWN renders, as one muted "recovered" line closing the retry the user
 *   just watched. It is a TRANSIENT confirmation: it self-dismisses after
 *   `RECOVERED_VISIBLE_MS`, because records are retained forever as revision
 *   watermarks and nothing else would ever take it down.
 *
 * Everything else in the table is news rather than progress — an advisory, a
 * turn that failed — and the connections provider tells it once, as a
 * notification (see `sessionFailureNotice`). It is never drawn here.
 *
 * Both strips carry a close button: dismissing is always the user's to do, and
 * unlike the settle passes it is available to viewers, since it only touches
 * their own client's projection.
 *
 * Adapter-authored `title`/`details` are shown verbatim (already user-facing
 * prose); a blank title falls back to the localized category label.
 */

import { useEffect } from "react"
import { useTranslations } from "next-intl"
import { CheckCircle2, Loader2 } from "lucide-react"

import { ComposerDockStrip } from "@/components/chat/composer-dock-strip"
import type { SessionFailureRecord } from "@/lib/types"
import {
  activeRetryIncidentView,
  latestActiveTerminalFailure,
  mostRecentRecoveredWarning,
  sessionFailureCategoryLabelKey,
} from "@/lib/session-failures"

/** How long the muted "recovered" confirmation stays before self-dismissing. */
const RECOVERED_VISIBLE_MS = 10_000

interface Props {
  failures: SessionFailureRecord[]
  /** Closes a strip (client-local), taking every id that strip stands for —
   *  the collapsed incident bar closes its hidden siblings too. Omitted only
   *  where there is no store to write back to. */
  onDismiss?: (ids: string[]) => void
  /** Keep the active incidents out of sight: the host is showing the same
   *  retry on its richer legacy line (`claudeApiRetry`), or no turn is
   *  running for one to be in flight. */
  hideRetryIncidents?: boolean
}

export function SessionFailureBanner({
  failures,
  onDismiss,
  hideRetryIncidents = false,
}: Props) {
  const { incident, hiddenCount, ids } = activeRetryIncidentView(failures)
  // Nothing has recovered while an incident is still active (one the host is
  // keeping out of sight included) or while the turn has failed after all. An
  // advisory in the background is beside the point.
  const recovered =
    incident !== null || latestActiveTerminalFailure(failures) !== null
      ? null
      : mostRecentRecoveredWarning(failures)
  const shownIncident = hideRetryIncidents ? null : incident
  if (!shownIncident && !recovered) return null
  return (
    <>
      {shownIncident && (
        <IncidentStrip
          key={shownIncident.id}
          failure={shownIncident}
          hiddenCount={hiddenCount}
          dismissIds={ids}
          onDismiss={onDismiss}
        />
      )}
      {recovered && (
        <RecoveredStrip
          key={`${recovered.id}@${recovered.revision}`}
          failure={recovered}
          onDismiss={onDismiss}
        />
      )}
    </>
  )
}

function IncidentStrip({
  failure,
  hiddenCount,
  dismissIds,
  onDismiss,
}: {
  failure: SessionFailureRecord
  /** Older active incidents folded behind this one, shown as a count. */
  hiddenCount: number
  /** Every record this strip stands for — what its close button dismisses. */
  dismissIds: string[]
  onDismiss?: Props["onDismiss"]
}) {
  const t = useTranslations("Folder.chat.sessionFailure")
  const title =
    failure.title.trim() || t(sessionFailureCategoryLabelKey(failure.category))
  const details = failure.details?.trim() || null
  return (
    <ComposerDockStrip
      // Amber with a spinner, like the retry line: the adapter is on it.
      role="status"
      tone="warning"
      icon={Loader2}
      iconClassName="animate-spin"
      title={title}
      hint={details ?? title}
      meta={
        hiddenCount > 0 ? (
          <span className="shrink-0 text-3xs font-medium opacity-70">
            {t("moreIncidents", { count: hiddenCount })}
          </span>
        ) : null
      }
      details={details}
      onDismiss={onDismiss ? () => onDismiss(dismissIds) : undefined}
    />
  )
}

function RecoveredStrip({
  failure,
  onDismiss,
}: {
  failure: SessionFailureRecord
  onDismiss?: Props["onDismiss"]
}) {
  const t = useTranslations("Folder.chat.sessionFailure")
  const title =
    failure.title.trim() || t(sessionFailureCategoryLabelKey(failure.category))
  // Self-expire. Records are retained forever as revision watermarks, so
  // nothing else would ever take this line down — it used to sit under the
  // composer for the rest of the session announcing a hiccup that was over
  // (field report 2026-08-17). Auto-dismiss WRITES to the store rather than
  // just hiding locally, so remounting the panel cannot resurrect it.
  const id = failure.id
  const dismiss = onDismiss
  useEffect(() => {
    if (!dismiss) return
    const timer = setTimeout(() => dismiss([id]), RECOVERED_VISIBLE_MS)
    return () => clearTimeout(timer)
  }, [dismiss, id])
  return (
    <ComposerDockStrip
      tone="muted"
      icon={CheckCircle2}
      title={`${t("recovered")} · ${title}`}
      onDismiss={dismiss ? () => dismiss([id]) : undefined}
    />
  )
}
