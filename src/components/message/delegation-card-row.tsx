"use client"

/**
 * The one row every sub-agent delegation card is built from: avatar, the
 * agent's or assistant's name, `#taskId`, status badge, task preview, and the
 * "查看会话" affordance.
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
import { Eye } from "lucide-react"
import { useTranslations } from "next-intl"

import {
  DelegationIdentityAvatar,
  DelegationIdentityName,
} from "@/components/message/delegation-identity"
import { StatusBadge } from "@/components/message/delegation-status-badge"
import type { DelegationIdentity } from "@/hooks/use-delegation-card-model"
import type { DelegationCardStatus } from "@/lib/delegation-card"
import { cn } from "@/lib/utils"

interface Props {
  /** Who ran the task: an assistant, or a bare agent. */
  identity: DelegationIdentity
  /** Broker task id; rendered as a `#`-prefixed 8-char handle when present. */
  taskId: string | null
  status: DelegationCardStatus
  errorCode?: string
  /** The sub-agent's task text, one clamped line. */
  task: string | null
  /** Small mark on the avatar's corner — the ⟳ a resumed run wears (placed
   *  by `DelegationIdentityAvatar`). */
  avatarBadge?: ReactNode
  /** Omitted when the child conversation is unknown (nothing to open). */
  onOpenSession?: () => void
}

export function DelegationCardRow({
  identity,
  taskId,
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
        <DelegationIdentityAvatar
          identity={identity}
          size="card"
          badge={avatarBadge}
        />
        <div className="min-w-0 flex-1 space-y-0.5">
          <div className="flex items-center gap-2">
            <DelegationIdentityName
              identity={identity}
              // An agent's short label never needed to truncate here; an
              // assistant's name plus "· Agent" can run long.
              className={cn(
                "text-sm font-semibold text-foreground",
                identity.assistantId !== null && "min-w-0 truncate"
              )}
            />
            {taskId && (
              <span
                className="shrink-0 font-mono text-xs text-muted-foreground"
                title={taskId}
              >
                #{taskId.slice(0, 8)}
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
