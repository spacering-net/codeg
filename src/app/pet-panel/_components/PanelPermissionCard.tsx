"use client"

import { useEffect, useState } from "react"
import { ShieldAlert, Terminal } from "lucide-react"
import { Button } from "@/components/ui/button"
import { acpRespondPermission } from "@/lib/api"
import { parsePermissionToolCall } from "@/lib/permission-request"
import type { PetPermissionSummary } from "@/lib/pet/types"
import type { AgentType } from "@/lib/types"
import { useAgentVocabulary } from "@/hooks/use-agent-vocabulary"
import { cn } from "@/lib/utils"

interface PanelPermissionCardProps {
  connectionId: string
  permission: PetPermissionSummary
  /**
   * Which agent asked — only used to localise option labels an agent hardcodes
   * in one language. Optional so a caller without it keeps verbatim rendering.
   */
  agentType?: AgentType | null
}

/**
 * Compact, in-panel version of the chat `PermissionDialog`: enough context to
 * decide (title + command / change summary) plus the agent's own option
 * buttons. Approving/rejecting calls the same `acp_respond_permission` command
 * as the main window, so the two stay consistent — the `pet://sessions` stream
 * clears this card once the backend emits `PermissionResolved`.
 */
export function PanelPermissionCard({
  connectionId,
  permission,
  agentType,
}: PanelPermissionCardProps) {
  const [busy, setBusy] = useState(false)
  const parsed = parsePermissionToolCall(permission.toolCall)
  const options = useAgentVocabulary(agentType).permissionOptions(
    permission.options
  )

  const respond = (optionId: string) => {
    if (busy) return
    setBusy(true)
    void acpRespondPermission(
      connectionId,
      permission.requestId,
      optionId
    ).catch((err) => {
      console.warn("[PetPanel] respond permission failed:", err)
      setBusy(false) // hard failure → re-enable for retry
    })
  }

  // The card normally unmounts the instant the session list drops this pending
  // permission (PermissionResolved → pet://sessions rebuild). If that event is
  // missed (dropped subscription, already-resolved request_id), re-enable after
  // a short delay so the buttons aren't stranded disabled rather than relying
  // solely on the event — mirroring the main window's local clear-on-success.
  useEffect(() => {
    if (!busy) return
    const timer = setTimeout(() => setBusy(false), 5000)
    return () => clearTimeout(timer)
  }, [busy])

  const changeSummary =
    parsed.additions > 0 || parsed.deletions > 0
      ? `+${parsed.additions} −${parsed.deletions}`
      : null

  return (
    <div className="mt-1 rounded-md border border-amber-500/30 bg-amber-500/5 p-2">
      <div className="flex items-center gap-1.5 text-xs font-medium">
        <ShieldAlert className="h-3.5 w-3.5 shrink-0 text-amber-500" />
        {/* Same precedence as PermissionDialog: description (≥0.63 meta)
            over the raw command title — the command row below shows it, and
            `parsePermissionToolCall` keeps a description that merely repeats
            the command from taking the heading. */}
        <span className="truncate">{parsed.description ?? parsed.title}</span>
      </div>

      {parsed.command ? (
        <div className="mt-1 flex items-start gap-1 text-2xs text-muted-foreground">
          <Terminal className="mt-0.5 h-3 w-3 shrink-0" />
          <code className="min-w-0 truncate font-mono">{parsed.command}</code>
        </div>
      ) : changeSummary ? (
        <div className="mt-1 font-mono text-2xs text-muted-foreground">
          {changeSummary}
        </div>
      ) : parsed.contentText ? (
        <div className="mt-1 line-clamp-2 text-2xs text-muted-foreground">
          {parsed.contentText}
        </div>
      ) : null}

      <div className="mt-2 flex flex-wrap gap-1.5">
        {options.map((opt) => {
          const isReject = opt.kind.startsWith("reject")
          return (
            <Button
              key={opt.option_id}
              size="sm"
              variant={isReject ? "outline" : "default"}
              disabled={busy}
              className={cn("h-6 px-2 text-2xs")}
              onClick={() => respond(opt.option_id)}
            >
              {opt.name}
            </Button>
          )
        })}
      </div>
    </div>
  )
}
