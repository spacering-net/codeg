"use client"

import { useLocale, useTranslations } from "next-intl"
import { ShieldCheckIcon, ShieldXIcon } from "lucide-react"

import type { ToolApproval } from "@/lib/activity/approval"
import type { StepStatus } from "@/lib/activity/types"
import { cn } from "@/lib/utils"

/**
 * Whether a row draws its approval chip. A declined call whose row already
 * says "declined" in the end column would only say it twice.
 */
export function showsApproval(
  approval: ToolApproval | null | undefined,
  status: StepStatus | undefined
): approval is ToolApproval {
  if (!approval) return false
  return !(approval.decision === "rejected" && status === "rejected")
}

const timeFormats = new Map<string, Intl.DateTimeFormat>()

function formatDecidedAt(iso: string | null, locale: string): string | null {
  if (!iso) return null
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return null
  let format = timeFormats.get(locale)
  if (!format) {
    format = new Intl.DateTimeFormat(locale, {
      dateStyle: "medium",
      timeStyle: "short",
    })
    timeFormats.set(locale, format)
  }
  return format.format(date)
}

/**
 * `🛡 approved once` — how the call's permission request was answered, in the
 * row's end column. The tooltip has the agent's own wording of the option
 * (what an "always" covers differs by agent), who answered when it was not a
 * person at the card, and when.
 */
export function ApprovalChip({ approval }: { approval: ToolApproval }) {
  const t = useTranslations("Folder.chat.activity.approval")
  const locale = useLocale()
  const rejected = approval.decision === "rejected"
  const Icon = rejected ? ShieldXIcon : ShieldCheckIcon
  const who =
    approval.origin === "chat_channel"
      ? t("viaChatChannel")
      : approval.origin === "cli_policy"
        ? t("byPolicy")
        : null
  const title = [
    approval.optionName,
    who,
    formatDecidedAt(approval.decidedAt, locale),
  ]
    .filter(Boolean)
    .join(" · ")
  return (
    <span
      className="inline-flex items-center gap-1 whitespace-nowrap"
      title={title || undefined}
    >
      <Icon
        aria-hidden="true"
        className={cn(
          "size-3 shrink-0",
          rejected ? "text-muted-foreground" : "text-tone-warning"
        )}
      />
      {t(approval.decision)}
    </span>
  )
}
