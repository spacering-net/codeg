"use client"

import { memo } from "react"
import { useTranslations } from "next-intl"
import { ChevronRight, FolderOpen } from "lucide-react"
import { AgentIcon } from "@/components/agent-icon"
import { Badge } from "@/components/ui/badge"
import { Checkbox } from "@/components/ui/checkbox"
import type { ScanFolder, ScanSession, ScanSessionStatus } from "@/lib/types"
import { cn } from "@/lib/utils"
import { formatConversationTitle } from "@/lib/conversation-title"

/** Stable selection key — the same `(agent_type, external_id)` identity the
 *  backend dedups imports on. */
export function sessionKey(session: {
  agent_type: string
  external_id: string
}): string {
  return `${session.agent_type}:${session.external_id}`
}

/** Whether a scanned session can be checked for the next import run.
 *
 *  `new` always is. `deleted` is only reachable behind `includeDeleted`: codeg
 *  soft-deletes, so importing such a session restores the existing row rather
 *  than inserting a duplicate — but a deletion was deliberate, so it takes an
 *  explicit opt-in before select-all and the folder tri-state can sweep it up.
 *  `imported` never is: there is nothing to do to a live row here (the scan
 *  already refreshed it in place). */
export function isSessionSelectable(
  session: { status: ScanSessionStatus },
  includeDeleted: boolean
): boolean {
  return (
    session.status === "new" || (includeDeleted && session.status === "deleted")
  )
}

function formatRelative(iso: string): string {
  const ts = Date.parse(iso)
  if (Number.isNaN(ts) || !ts) return ""
  const diff = Math.max(0, Date.now() - ts)
  const m = Math.floor(diff / 60000)
  if (m < 1) return "now"
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h`
  const d = Math.floor(h / 24)
  if (d < 30) return `${d}d`
  const mo = Math.floor(d / 30)
  if (mo < 12) return `${mo}mo`
  const y = Math.floor(mo / 12)
  return `${y}y`
}

interface FolderHeaderRowProps {
  folder: ScanFolder
  /** Sessions visible under the active filters (what the tri-state governs). */
  visibleCount: number
  importableCount: number
  selectedCount: number
  collapsed: boolean
  disabled: boolean
  onToggleCollapse: (path: string) => void
  onToggleFolder: (path: string) => void
}

export const FolderHeaderRow = memo(function FolderHeaderRow({
  folder,
  visibleCount,
  importableCount,
  selectedCount,
  collapsed,
  disabled,
  onToggleCollapse,
  onToggleFolder,
}: FolderHeaderRowProps) {
  const t = useTranslations("ImportSessions")
  const checked =
    importableCount > 0 && selectedCount === importableCount
      ? true
      : selectedCount > 0
        ? ("indeterminate" as const)
        : false

  return (
    <div
      className={cn(
        "flex h-9 items-center gap-2 rounded-md bg-muted/40 px-2",
        disabled && "opacity-60"
      )}
      data-folder-path={folder.path}
    >
      <Checkbox
        checked={checked}
        disabled={disabled || importableCount === 0}
        onCheckedChange={() => onToggleFolder(folder.path)}
        aria-label={t("toggleFolderAria", { name: folder.name })}
      />
      <button
        type="button"
        className="flex min-w-0 flex-1 items-center gap-2 text-left"
        onClick={() => onToggleCollapse(folder.path)}
        disabled={disabled}
        aria-expanded={!collapsed}
      >
        <ChevronRight
          className={cn(
            "h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform",
            !collapsed && "rotate-90"
          )}
        />
        <FolderOpen className="h-4 w-4 shrink-0 text-muted-foreground" />
        <span className="truncate text-sm font-medium">{folder.name}</span>
        <span
          className="hidden min-w-0 truncate text-xs text-muted-foreground sm:inline"
          title={folder.path}
        >
          {folder.path}
        </span>
      </button>
      <span className="flex shrink-0 items-center gap-1.5">
        {folder.agent_types.slice(0, 4).map((agent) => (
          <AgentIcon key={agent} agentType={agent} className="h-3.5 w-3.5" />
        ))}
      </span>
      {!folder.exists_in_codeg && (
        <Badge variant="secondary" className="shrink-0 text-3xs">
          {t("folderNew")}
        </Badge>
      )}
      <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
        {t("folderCounts", {
          importable: importableCount,
          total: visibleCount,
        })}
      </span>
    </div>
  )
})

interface SessionRowProps {
  session: ScanSession
  checked: boolean
  disabled: boolean
  /** Whether deleted sessions are currently offered for restore. */
  includeDeleted: boolean
  onToggle: (key: string) => void
}

export const SessionRow = memo(function SessionRow({
  session,
  checked,
  disabled,
  includeDeleted,
  onToggle,
}: SessionRowProps) {
  const t = useTranslations("ImportSessions")
  const selectable = isSessionSelectable(session, includeDeleted) && !disabled
  const key = sessionKey(session)
  const title = formatConversationTitle(session.title) || t("untitled")

  return (
    <div
      className={cn(
        "flex h-9 items-center gap-2 rounded-md px-2 pl-8",
        selectable && "cursor-pointer hover:bg-muted/50",
        !selectable && "opacity-60"
      )}
      onClick={selectable ? () => onToggle(key) : undefined}
      data-session-key={key}
    >
      <Checkbox
        checked={isSessionSelectable(session, includeDeleted) ? checked : false}
        disabled={!selectable}
        onCheckedChange={() => onToggle(key)}
        onClick={(e) => e.stopPropagation()}
        aria-label={t("toggleSessionAria", { title })}
      />
      <AgentIcon agentType={session.agent_type} className="h-4 w-4 shrink-0" />
      <span className="min-w-0 flex-1 truncate text-sm" title={title}>
        {title}
      </span>
      {session.status === "imported" && (
        <Badge variant="outline" className="shrink-0 text-3xs">
          {t("statusImported")}
        </Badge>
      )}
      {session.status === "deleted" && (
        // Stays "deleted" even when it is selectable: that IS the state the row
        // is in, and it is what tells the user this checkbox restores rather
        // than imports. The tooltip spells out the difference.
        <Badge
          variant="destructive"
          className="shrink-0 text-3xs"
          title={includeDeleted ? t("statusDeletedRestorable") : undefined}
        >
          {t("statusDeleted")}
        </Badge>
      )}
      <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
        {t("messageCount", { count: session.message_count })}
      </span>
      <span className="w-10 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
        {formatRelative(session.started_at)}
      </span>
    </div>
  )
})
