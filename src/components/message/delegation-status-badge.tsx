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
import { cn } from "@/lib/utils"

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
      return <ShieldAlert className="text-amber-500" />
    case "running":
      return <Loader2 className="animate-spin" />
    case "checked":
      // A poll returned "still running" — a settled snapshot, not live work.
      // Neutral, non-spinning, so a superseded check stops spinning.
      return <Clock className="text-muted-foreground" />
    case "ok":
      return <CheckCircleIcon className="text-green-600" />
    default:
      return <XCircleIcon className="text-red-600" />
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
  size = "default",
}: {
  status: DelegationStatusValue
  errorCode?: string
  /** `sm`: the narrower pill of the Session Details side panel's sub-agent
   *  cards. */
  size?: "default" | "sm"
}) {
  return (
    <Badge
      className={cn(
        "rounded-full",
        size === "sm" ? "h-[1.125rem] gap-1 px-1.5 text-2xs" : "gap-1.5 text-xs"
      )}
      variant="secondary"
      title={status === "err" ? (errorCode ?? undefined) : undefined}
    >
      <StatusIcon status={status} />
      <StatusText status={status} errorCode={errorCode} />
    </Badge>
  )
}

function ErrorLabel({ code }: { code?: string }) {
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
