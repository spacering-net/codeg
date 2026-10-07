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

export function StatusBadge({
  status,
  errorCode,
}: {
  status: "starting" | "running" | "waiting" | "ok" | "err" | "checked"
  errorCode?: string
}) {
  const t = useTranslations("Folder.chat.delegation.status")
  if (status === "starting") {
    return (
      <Badge className="gap-1.5 rounded-full text-xs" variant="secondary">
        <CircleDashed className="animate-spin text-muted-foreground" />
        {t("starting")}
      </Badge>
    )
  }
  if (status === "waiting") {
    return (
      <Badge className="gap-1.5 rounded-full text-xs" variant="secondary">
        <ShieldAlert className="text-amber-500" />
        {t("waiting")}
      </Badge>
    )
  }
  if (status === "running") {
    return (
      <Badge className="gap-1.5 rounded-full text-xs" variant="secondary">
        <Loader2 className="animate-spin" />
        {t("running")}
      </Badge>
    )
  }
  if (status === "checked") {
    // A poll returned "still running" — a settled snapshot, not live work.
    // Neutral, non-spinning, so a superseded check stops spinning.
    return (
      <Badge className="gap-1.5 rounded-full text-xs" variant="secondary">
        <Clock className="text-muted-foreground" />
        {t("checked")}
      </Badge>
    )
  }
  if (status === "ok") {
    return (
      <Badge className="gap-1.5 rounded-full text-xs" variant="secondary">
        <CheckCircleIcon className="text-green-600" />
        {t("ok")}
      </Badge>
    )
  }
  return (
    <Badge
      className="gap-1.5 rounded-full text-xs"
      variant="secondary"
      title={errorCode ?? undefined}
    >
      <XCircleIcon className="text-red-600" />
      <ErrorLabel code={errorCode} />
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
    default:
      return <>{t("default")}</>
  }
}
