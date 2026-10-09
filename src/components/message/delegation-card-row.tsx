"use client"

/**
 * The one row every sub-agent delegation card is built from: avatar, agent
 * label, `#taskId`, status badge, task preview, and the "查看会话" affordance.
 *
 * Shared by `DelegatedSubThread` (the `delegate_to_agent` card) and
 * `ResumedDelegationCard` (the `resume_delegation` card) so the two can never
 * disagree about how a sub-agent looks — the same relationship
 * `DelegationStatusRow` has with `DelegationStatusCard` /
 * `DelegationStatusGroupCard`.
 *
 * Presentation only: every id and status it draws is resolved upstream by
 * `useDelegationCardModel`, and opening the viewer is the caller's business
 * (the two cards reach the same `SessionViewerHost`, but only the caller knows
 * which `DelegationCardSource` to hand it).
 */

import type { ReactNode } from "react"
import { getAgentLabel } from "@/lib/custom-agents"
import { Eye } from "lucide-react"
import { useTranslations } from "next-intl"

import { AgentIcon } from "@/components/agent-icon"
import { StatusBadge } from "@/components/message/delegation-status-badge"
import type { DelegationCardStatus } from "@/lib/delegation-card"
import type { AgentType } from "@/lib/types"

interface Props {
  agentType: AgentType | null
  /** Broker task id; rendered as a `#`-prefixed 8-char handle when present. */
  taskId: string | null
  /** Model the parent pinned for this one delegation. Omitted / `null` means
   *  the child used the configured default, which is the common case — then
   *  no chip is drawn and the row reads as it always did. */
  pinnedModel?: string | null
  status: DelegationCardStatus
  errorCode?: string
  /** The sub-agent's task text, one clamped line. */
  task: string | null
  /** Small overlay on the avatar's corner — the ⟳ a resumed run wears. */
  avatarBadge?: ReactNode
  /** Omitted when the child conversation is unknown (nothing to open). */
  onOpenSession?: () => void
}

export function DelegationCardRow({
  agentType,
  taskId,
  pinnedModel,
  status,
  errorCode,
  task,
  avatarBadge,
  onOpenSession,
}: Props) {
  const t = useTranslations("Folder.chat.delegation")

  return (
    <div className="flex w-full items-stretch rounded-lg overflow-hidden">
      <div className="flex flex-1 min-w-0 items-center gap-3 px-3 py-2.5 text-left">
        <span className="relative shrink-0">
          <span className="inline-flex h-9 w-9 items-center justify-center rounded-full border border-border bg-background text-foreground">
            {agentType ? (
              <AgentIcon agentType={agentType} className="h-5 w-5" />
            ) : (
              <span className="h-2.5 w-2.5 rounded-sm bg-muted-foreground/60" />
            )}
          </span>
          {avatarBadge}
        </span>
        <div className="min-w-0 flex-1 space-y-0.5">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold text-foreground">
              {agentType ? getAgentLabel(agentType) : t("unknownAgent")}
            </span>
            {taskId && (
              <span
                className="shrink-0 font-mono text-xs text-muted-foreground"
                title={taskId}
              >
                #{taskId.slice(0, 8)}
              </span>
            )}
            {pinnedModel && (
              <span
                className="shrink-0 rounded border border-border px-1 py-px font-mono text-[10px] leading-none text-muted-foreground"
                title={t("delegationPinnedModel", { model: pinnedModel })}
              >
                {pinnedModel}
              </span>
            )}
            <StatusBadge status={status} errorCode={errorCode} />
          </div>
          {task && (
            <div className="text-xs text-muted-foreground whitespace-pre-wrap break-words line-clamp-1">
              {task}
            </div>
          )}
        </div>
      </div>
      {onOpenSession && (
        <button
          type="button"
          onClick={onOpenSession}
          className="shrink-0 flex items-center gap-1.5 px-3 border-l border-border text-xs font-medium text-foreground/80 hover:bg-muted/60 hover:text-foreground transition-colors"
          title={t("openDetail")}
          aria-label={t("openDetail")}
        >
          <Eye className="h-3.5 w-3.5" />
          <span className="hidden @[24rem]/delegcard:inline">
            {t("openDetail")}
          </span>
        </button>
      )}
    </div>
  )
}
