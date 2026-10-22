"use client"

/**
 * The one row every sub-agent delegation card is built from: avatar, the
 * agent's or assistant's name, `#taskId`, status badge, task preview, and the
 * "查看会话" affordance.
 *
 * Its left part — everything but "查看会话" — is also a toggle: it expands the
 * task the sub-agent was handed, in full, in a panel under the row. That text
 * is the sub-agent's kickoff user message, and the row can only ever show its
 * first line. The sub-agent's OUTPUT never lands here; that is what "查看会话"
 * is for.
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

import { useId, useState, type ReactNode } from "react"
import { ChevronDown, ChevronRight, Eye } from "lucide-react"
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
  /** The sub-agent's task text: one clamped line on the row, all of it in the
   *  panel the row expands. */
  task: string | null
  /** More for the expanded panel, under the task — the resume reason on a
   *  resumed card. Makes the row expandable even when there is no task text. */
  detail?: ReactNode
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
  detail,
  avatarBadge,
  onOpenSession,
}: Props) {
  const t = useTranslations("Folder.chat.delegation")
  const [expanded, setExpanded] = useState(false)
  const panelId = useId()

  const hasTask = task != null && task.trim() !== ""
  const expandable = hasTask || detail != null
  const open = expandable && expanded

  // Spans rather than divs throughout: this is a button's content whenever the
  // row expands, and a button may only hold phrasing content.
  const summary = (
    <>
      <DelegationIdentityAvatar
        identity={identity}
        size="card"
        badge={avatarBadge}
      />
      <span className="block min-w-0 flex-1 space-y-0.5">
        <span className="flex items-center gap-2">
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
        </span>
        {/* Stays while open, though the panel repeats it in full: without
            it the row is a line shorter, and the avatar, name, badge and
            the open button beside them would all shift as the panel opens
            and closes. */}
        {hasTask && (
          // No `block`: `line-clamp-1` sets its own display (-webkit-box), and
          // a competing display utility could silently undo the clamp.
          //
          // The task keeps its own direction (`dir="auto"`): English handed
          // over in an Arabic window, laid out right-to-left, had its full stops
          // moved to the far end, and the clamp put its ellipsis at the left —
          // over the task's first letter. The alignment still follows the
          // window (`text-left rtl:text-right`), so the line stays beside the
          // avatar whichever way the task itself reads.
          <span
            dir="auto"
            className="text-left text-xs text-muted-foreground whitespace-pre-wrap break-words line-clamp-1 rtl:text-right"
          >
            {task}
          </span>
        )}
      </span>
      {expandable &&
        (open ? (
          <ChevronDown
            aria-hidden="true"
            className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
          />
        ) : (
          <ChevronRight
            aria-hidden="true"
            className="h-3.5 w-3.5 shrink-0 text-muted-foreground rtl:-scale-x-100"
          />
        ))}
    </>
  )
  // `text-start`: a button centres its text by default, and `text-left` would
  // pin the task line to the wrong edge in a right-to-left locale.
  const summaryClassName =
    "flex flex-1 min-w-0 items-center gap-3 px-3 py-2.5 text-start"

  return (
    <div className="w-full overflow-hidden rounded-lg">
      <div className="flex w-full items-stretch">
        {expandable ? (
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            aria-expanded={open}
            // The panel is only mounted while open, so only point at it then.
            aria-controls={open ? panelId : undefined}
            className={cn(
              summaryClassName,
              "outline-none transition-colors hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
            )}
          >
            {summary}
          </button>
        ) : (
          <div className={summaryClassName}>{summary}</div>
        )}
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
      {open && (
        <div
          id={panelId}
          data-testid="delegation-card-panel"
          className="divide-y divide-border border-t border-border"
        >
          {hasTask && (
            // Verbatim, like the user message it is in the sub-agent's own
            // transcript: pre-wrapped text, not Markdown. A block of its own,
            // so it reads (and aligns) in the task's direction, not the
            // window's.
            <div
              dir="auto"
              className="max-h-80 overflow-auto whitespace-pre-wrap break-words px-3 py-2 text-xs text-foreground/90"
            >
              {task}
            </div>
          )}
          {detail}
        </div>
      )}
    </div>
  )
}
