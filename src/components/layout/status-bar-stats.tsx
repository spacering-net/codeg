"use client"

import { ChartNoAxesColumn, MonitorCloud } from "lucide-react"
import { useTranslations } from "next-intl"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"
import { useRemoteConnection } from "@/contexts/remote-connection-context"
import { useWorkbenchRoute } from "@/contexts/workbench-route-context"
import { cn } from "@/lib/utils"

/**
 * The workspace-stats cluster at the left end of the status bar.
 *
 * The conversation count doubles as the entry point to the Token Usage
 * dashboard — clicking it swaps the workbench route instead of opening a
 * popover, so the number is a door, not a dead end. The per-agent breakdown
 * the old popover held lives on that page in far richer form.
 *
 * Both hover hints are native `title` attributes, not Radix tooltips: this is a
 * two-element status-bar cluster whose hints are one short line each, so the
 * floating-layer machinery bought nothing. Keeping both on the same mechanism
 * also avoids two different hover delays side by side.
 */
export function StatusBarStats() {
  const t = useTranslations("Folder.statusBar.stats")
  const stats = useAppWorkspaceStore((s) => s.stats)
  // Non-null only in a remote-desktop window (a Tauri client bound to a remote
  // codeg-server); local windows have no RemoteConnection in context.
  const remoteConnection = useRemoteConnection()?.connection ?? null
  const { routeId, setRoute } = useWorkbenchRoute()

  if (!remoteConnection && !stats) return null

  return (
    <div className="flex items-center gap-3">
      {remoteConnection && (
        <span
          className="flex max-w-40 items-center gap-1.5"
          // Name on the first line, service URL on the second — the same two
          // lines the tooltip used to stack.
          title={`${remoteConnection.name}\n${remoteConnection.base_url}`}
        >
          <MonitorCloud className="h-3 w-3 shrink-0" />
          <span className="truncate">{remoteConnection.name}</span>
        </span>
      )}
      {stats && (
        <button
          type="button"
          onClick={() => setRoute("tokenUsage")}
          title={t("openUsage")}
          className={cn(
            "flex items-center gap-1.5 transition-colors hover:text-foreground",
            routeId === "tokenUsage" && "text-foreground"
          )}
        >
          <ChartNoAxesColumn className="h-3 w-3" />
          <span>
            {t("conversations", { count: stats.total_conversations })}
          </span>
        </button>
      )}
    </div>
  )
}
