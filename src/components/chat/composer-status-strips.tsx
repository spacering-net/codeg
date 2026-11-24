"use client"

/**
 * What the composer dock says about THIS session: only what is in progress
 * right now, in one visual family (`ComposerDockStrip`):
 *
 *   1. the retry line — `claudeApiRetry`: the cause, the HTTP status, attempt
 *      N of M and when the next one goes;
 *   2. the AIR retry incidents and their short "recovered" confirmation
 *      (`SessionFailureBanner`).
 *
 * A retry updates in place and clears itself, which is what a strip docked
 * under the composer is for. As a notification it would pop a toast per
 * attempt, and the alert list would keep a trail of stale "retrying 3/10".
 * Everything the session reports that is NEWS — a failed turn, a dead
 * connection, an advisory, a failed connect — is a notification instead (a
 * toast, recorded in the status-bar alert list; see `lib/notify`), and is never
 * also drawn here.
 *
 * Two rules keep one retry from being drawn twice or after the fact:
 *
 * - the legacy line and an AIR retry incident report the same retry (claude
 *   publishes both for one `api_retry`), and the line carries the cause, the
 *   HTTP status and the delay where the incident only says "attempt N of M" —
 *   so while the line shows, the incident strip yields;
 * - nothing is retrying once the turn is over. An incident the adapter never
 *   settled (the turn failed instead) stays active in the table until the
 *   next prompt, and would otherwise sit here, spinning, over a finished turn.
 */

import { useMemo } from "react"
import { useTranslations } from "next-intl"
import { Loader2 } from "lucide-react"

import { ComposerDockStrip } from "@/components/chat/composer-dock-strip"
import { SessionFailureBanner } from "@/components/chat/session-failure-banner"
import type { ClaudeApiRetryState } from "@/contexts/acp-connections-context"
import type { ConnectionStatus, SessionFailureRecord } from "@/lib/types"

const NO_FAILURES: SessionFailureRecord[] = []

export interface ComposerStatusStripsProps {
  /** The session's status — a retry can only be in flight while `prompting`. */
  status: ConnectionStatus | null
  claudeApiRetry: ClaudeApiRetryState | null
  sessionFailures?: SessionFailureRecord[]
  onSessionFailureDismiss?: (ids: string[]) => void
}

export function ComposerStatusStrips({
  status,
  claudeApiRetry,
  sessionFailures = NO_FAILURES,
  onSessionFailureDismiss,
}: ComposerStatusStripsProps) {
  const retryLineText = useRetryLineText(claudeApiRetry)
  return (
    <>
      {sessionFailures.length > 0 && (
        <SessionFailureBanner
          failures={sessionFailures}
          onDismiss={onSessionFailureDismiss}
          hideRetryIncidents={retryLineText !== null || status !== "prompting"}
        />
      )}

      {retryLineText !== null && (
        <ComposerDockStrip
          // Amber, not red: the agent is retrying on its own.
          role="status"
          tone="warning"
          icon={Loader2}
          iconClassName="animate-spin"
          title={retryLineText}
        />
      )}
    </>
  )
}

/** The one-line text of the in-flight retry line, or `null` when idle. */
function useRetryLineText(retry: ClaudeApiRetryState | null): string | null {
  const tAcp = useTranslations("Folder.chat.acpConnections")
  return useMemo(() => {
    if (!retry) return null

    const retryAttempt =
      retry.attempt !== null && retry.attempt !== undefined
        ? Math.trunc(retry.attempt)
        : null
    const retryMax =
      retry.maxRetries !== null && retry.maxRetries !== undefined
        ? Math.trunc(retry.maxRetries)
        : null
    const retryDelaySeconds =
      retry.retryDelayMs !== null && retry.retryDelayMs !== undefined
        ? (retry.retryDelayMs / 1000).toFixed(1)
        : null
    // `null` only for a source that reports no cause at all (pi, #525) — see
    // `ClaudeApiRetryState.reportsError`. Claude and codex keep the fallback.
    const errorLabel =
      retry.error ??
      (retry.reportsError ? tAcp("claudeApiRetry.fallbackError") : null)
    const statusLabel =
      retry.errorStatus !== null && retry.errorStatus !== undefined
        ? tAcp("claudeApiRetry.httpStatus", {
            status: Math.trunc(retry.errorStatus),
          })
        : ""
    const retryLabel =
      retryAttempt !== null && retryMax !== null
        ? tAcp("claudeApiRetry.retryingWithMax", {
            attempt: retryAttempt,
            max: retryMax,
          })
        : retryAttempt !== null
          ? tAcp("claudeApiRetry.retryingAttempt", {
              attempt: retryAttempt,
            })
          : tAcp("claudeApiRetry.retrying")
    const delayLabel =
      retryDelaySeconds !== null
        ? tAcp("claudeApiRetry.nextRetryIn", {
            seconds: retryDelaySeconds,
          })
        : null

    // With no cause AND no HTTP status there is nothing to put before the
    // separator, and the shared template would render a dangling "· 正在重试".
    // Take the prefix-less pair instead — the counters carry the whole message.
    if (errorLabel === null && statusLabel === "") {
      return delayLabel !== null
        ? tAcp("claudeApiRetry.lineNoErrorWithDelay", {
            retry: retryLabel,
            delay: delayLabel,
          })
        : tAcp("claudeApiRetry.lineNoError", { retry: retryLabel })
    }

    return delayLabel !== null
      ? tAcp("claudeApiRetry.lineWithDelay", {
          error: errorLabel ?? "",
          status: statusLabel,
          retry: retryLabel,
          delay: delayLabel,
        })
      : tAcp("claudeApiRetry.line", {
          error: errorLabel ?? "",
          status: statusLabel,
          retry: retryLabel,
        })
  }, [retry, tAcp])
}
