"use client"

import {
  CheckCircleIcon,
  CircleDashed,
  Clock,
  Loader2,
  ShieldAlert,
  XCircleIcon,
} from "lucide-react"
import { useTranslations } from "next-intl"

import { Badge } from "@/components/ui/badge"
import { useElapsedLabel } from "@/hooks/use-elapsed-label"
import type { StepStatus } from "@/lib/activity/types"
import type { DelegationCardStatus } from "@/lib/delegation-card"

type DelegationStatusValue =
  | "starting"
  | "running"
  | "waiting"
  | "ok"
  | "err"
  | "checked"

function StatusIcon({ status }: { status: DelegationStatusValue }) {
  switch (status) {
    case "starting":
      return <CircleDashed className="animate-spin text-muted-foreground" />
    case "waiting":
      return <ShieldAlert className="text-tone-warning" />
    case "running":
      return <Loader2 className="animate-spin" />
    case "checked":
      // A poll returned "still running" — a settled snapshot, not live work.
      // Neutral, non-spinning, so a superseded check stops spinning.
      return <Clock className="text-muted-foreground" />
    case "ok":
      return <CheckCircleIcon className="text-tone-success" />
    default:
      return <XCircleIcon className="text-tone-danger" />
  }
}

function StatusText({
  status,
  errorCode,
}: {
  status: DelegationStatusValue
  errorCode?: string
}) {
  const t = useTranslations("Folder.chat.delegation.status")
  if (status === "err") return <ErrorLabel code={errorCode} />
  return <>{t(status)}</>
}

export function StatusBadge({
  status,
  errorCode,
}: {
  status: DelegationStatusValue
  errorCode?: string
}) {
  return (
    <Badge
      className="gap-1.5 rounded-full text-xs"
      variant="secondary"
      title={status === "err" ? (errorCode ?? undefined) : undefined}
    >
      <StatusIcon status={status} />
      <StatusText status={status} errorCode={errorCode} />
    </Badge>
  )
}

/** A delegation's status as a step of the activity timeline reads it — what
 *  its status ring (`RailIcon`) shows. */
export function delegationStepStatus(status: DelegationCardStatus): StepStatus {
  switch (status) {
    case "starting":
    case "running":
      return "running"
    case "waiting":
      return "awaiting"
    case "ok":
      return "succeeded"
    case "err":
      return "failed"
  }
}

/**
 * A delegation's status in words, at the end of its line: quiet when it is
 * done or still at work, in the failure colour with what went wrong, amber
 * while it waits on the user. `durationMs` — how long it took — follows a
 * finished one; `clock` — how long it has been at it — a running one.
 */
export function DelegationStatusWord({
  status,
  errorCode,
  durationMs = null,
  clock = null,
}: {
  status: DelegationCardStatus
  errorCode?: string
  durationMs?: number | null
  /** How long it has been running here, once that is worth showing. */
  clock?: string | null
}) {
  const t = useTranslations("Folder.chat.delegation.status")
  const elapsedLabel = useElapsedLabel()
  const took = elapsedLabel(durationMs)
  const duration = took ? ` · ${took}` : ""
  switch (status) {
    case "err":
      return (
        <span className="text-tone-danger">
          <ErrorLabel code={errorCode} />
          {duration}
        </span>
      )
    case "waiting":
      return <span className="text-tone-warning">{t("waiting")}</span>
    case "ok":
      return (
        <>
          {t("ok")}
          {duration}
        </>
      )
    default:
      return (
        <>
          {t(status)}
          {clock ? <span aria-hidden="true">{` ${clock}`}</span> : null}
        </>
      )
  }
}

export function ErrorLabel({ code }: { code?: string }) {
  const t = useTranslations("Folder.chat.delegation.status.err")
  switch (code) {
    case "delegation_disabled":
      return <>{t("delegation_disabled")}</>
    case "depth_limit":
      return <>{t("depth_limit")}</>
    case "invalid_agent_type":
      return <>{t("invalid_agent_type")}</>
    case "spawn_failed":
      return <>{t("spawn_failed")}</>
    case "send_failed":
      return <>{t("send_failed")}</>
    case "timeout":
      return <>{t("timeout")}</>
    case "canceled":
      return <>{t("canceled")}</>
    case "child_refusal":
      return <>{t("child_refusal")}</>
    case "child_max_tokens":
      return <>{t("child_max_tokens")}</>
    case "child_max_turn_requests":
      return <>{t("child_max_turn_requests")}</>
    case "child_empty":
      return <>{t("child_empty")}</>
    case "child_auth_required":
      return <>{t("child_auth_required")}</>
    case "child_rejected":
      return <>{t("child_rejected")}</>
    case "child_unknown":
      return <>{t("child_unknown")}</>
    case "unknown":
      return <>{t("unknown")}</>
    case "assistant_not_found":
      return <>{t("assistant_not_found")}</>
    case "assistants_unsupported":
      return <>{t("assistants_unsupported")}</>
    case "assistant_support_unknown":
      return <>{t("assistant_support_unknown")}</>
    default:
      return <>{t("default")}</>
  }
}
