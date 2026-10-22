"use client"

/**
 * Inline-start overlay listing the sub-agents delegated in the LAST agent reply.
 *
 * Mirrors `AgentPlanOverlay` (the "计划任务" panel): collapses to a bullet chip,
 * expands to a card, remembers collapse state per `overlayKey`, and renders
 * nothing when there's nothing to show. Positioning (absolute inline-start/top) is
 * owned by the shared overlay-stack container in `MessageListView`, which
 * places this panel BELOW the plan panel when both are present.
 *
 * The overlay is for transcripts with no side panel (a canvas card, the
 * read-only sub-agent and task drawers); the conversation page lists the same
 * rows in the Session Details side panel instead.
 *
 * Each row (`SubAgentRow`, shared with that panel) resolves its agent type /
 * task / status / child ids from the same `useDelegationCardModel` the inline
 * `DelegatedSubThread` card uses, so the overlay and the message-stream card
 * never disagree. Clicking a row opens the child's full conversation via
 * `SubAgentSessionDialog` ("查看会话").
 */

import { memo, useState } from "react"
import { useTranslations } from "next-intl"
import { BotIcon, ChevronDownIcon } from "lucide-react"

import { CollapsedOverlayChip } from "@/components/chat/collapsed-overlay-chip"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  DelegationIdentityAvatar,
  DelegationIdentityName,
} from "@/components/message/delegation-identity"
import { StatusBadge } from "@/components/message/delegation-status-badge"
import { SubAgentSessionDialog } from "@/components/message/sub-agent-session-dialog"
import { useSessionViewerHost } from "@/components/message/session-viewer-host"
import {
  useDelegationCardModel,
  type DelegationCardSource,
} from "@/hooks/use-delegation-card-model"

interface SubAgentOverlayProps {
  /** The `delegate_to_agent` tool calls in the last assistant reply. */
  delegations: DelegationCardSource[]
  /** Stable key for the current "last assistant reply": collapse/expand state
   *  is remembered per key (and the parent also remounts via `key` on change,
   *  resetting state across conversations/messages). */
  overlayKey?: string | null
  /** Collapsed by default, matching the plan overlay. */
  defaultExpanded?: boolean
}

export const SubAgentOverlay = memo(function SubAgentOverlay({
  delegations,
  overlayKey,
  defaultExpanded = false,
}: SubAgentOverlayProps) {
  const t = useTranslations("Folder.chat.subAgentOverlay")
  const stateKey = overlayKey ?? "__subagents__default__"
  const [collapsedByKey, setCollapsedByKey] = useState<Record<string, boolean>>(
    {}
  )

  const count = delegations.length
  if (count === 0) {
    return null
  }

  const userCollapsed = collapsedByKey[stateKey]
  const isExpanded =
    userCollapsed !== undefined ? !userCollapsed : defaultExpanded

  if (!isExpanded) {
    return (
      <CollapsedOverlayChip
        icon={<BotIcon className="size-3" />}
        summary={t("collapsedSummary", { count })}
        onClick={() =>
          setCollapsedByKey((prev) => ({ ...prev, [stateKey]: false }))
        }
      />
    )
  }

  return (
    <div className="pointer-events-none flex max-w-[min(22rem,calc(100%-2rem))]">
      <div className="pointer-events-auto w-72 max-w-full rounded-xl border bg-card/60 hover:bg-card/95 shadow-lg backdrop-blur transition-colors supports-[backdrop-filter]:bg-card/50 supports-[backdrop-filter]:hover:bg-card/85">
        <div className="flex items-center justify-between border-b px-3 py-2">
          <div className="flex items-center gap-2 min-w-0">
            <BotIcon className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm font-medium truncate">{t("title")}</span>
            <Badge variant="secondary" className="h-5">
              {count}
            </Badge>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={t("collapseAria")}
            onClick={() =>
              setCollapsedByKey((prev) => ({ ...prev, [stateKey]: true }))
            }
          >
            <ChevronDownIcon className="h-4 w-4" />
          </Button>
        </div>

        <div className="max-h-96 overflow-y-auto p-2 space-y-1.5">
          {delegations.map((source) => (
            <SubAgentRow key={source.parentToolUseId} source={source} />
          ))}
        </div>
      </div>
    </div>
  )
})

/** One sub-agent: who runs it, its task id and status, and its task. Opens the
 *  child's conversation when it has one. */
export const SubAgentRow = memo(function SubAgentRow({
  source,
}: {
  source: DelegationCardSource
}) {
  const t = useTranslations("Folder.chat.delegation")
  // Same host as the inline card — so the two entry points share one viewer,
  // and neither depends on its own row surviving. The Session Details side
  // panel brings a host of its own. `null` = rendered outside any host; keep
  // the local drawer then.
  const viewerHost = useSessionViewerHost()
  const [dialogOpen, setDialogOpen] = useState(false)
  const {
    identity,
    task,
    taskId,
    status,
    errorCode,
    childConversationId,
    childConnectionId,
  } = useDelegationCardModel(source)

  // Unlike the inline DelegatedSubThread (which falls through to the generic
  // tool renderer when nothing resolves), the overlay always renders one row
  // per real delegation so the collapsed count never disagrees with the list,
  // and meta/output-only states (e.g. after a refresh) still surface. Rows
  // degrade gracefully: unknown agent → neutral dot + "Sub-agent" label,
  // missing child id → non-clickable.
  const clickable = childConversationId != null

  const rowBody = (
    <div className="min-w-0 flex-1 space-y-1">
      {/* Name line: small icon inline with the name, then task id + status. */}
      <div className="flex items-center gap-1.5">
        <DelegationIdentityAvatar identity={identity} size="overlay" />
        <DelegationIdentityName
          identity={identity}
          className="min-w-0 truncate text-xs font-semibold text-foreground"
        />
        {taskId && (
          <span
            className="shrink-0 font-mono text-2xs text-muted-foreground"
            title={taskId}
          >
            #{taskId.slice(0, 8)}
          </span>
        )}
        <StatusBadge status={status} errorCode={errorCode} />
      </div>
      {task && (
        <div className="truncate text-2xs text-muted-foreground">{task}</div>
      )}
    </div>
  )

  return (
    <>
      {clickable ? (
        <button
          type="button"
          data-testid="sub-agent-row"
          onClick={() =>
            viewerHost
              ? viewerHost.open({ kind: "delegation", source })
              : setDialogOpen(true)
          }
          className="flex w-full items-center gap-2 rounded-lg border bg-transparent px-2 py-1.5 text-left transition-colors hover:bg-muted/60"
          // No aria-label: let the row content (agent name + task) name the
          // button so screen readers can tell rows apart. `title` stays for the
          // pointer tooltip.
          title={t("openDetail")}
        >
          {rowBody}
        </button>
      ) : (
        <div
          data-testid="sub-agent-row"
          className="flex w-full items-center gap-2 rounded-lg border bg-transparent px-2 py-1.5"
        >
          {rowBody}
        </div>
      )}
      {viewerHost == null && childConversationId != null && (
        <SubAgentSessionDialog
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          childConversationId={childConversationId}
          childConnectionId={childConnectionId}
          identity={identity}
          kickoffTask={task}
        />
      )}
    </>
  )
})
