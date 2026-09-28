"use client"

import { StatusBarStats } from "@/components/layout/status-bar-stats"
import { StatusBarTasks } from "@/components/layout/status-bar-tasks"
import { StatusBarAlerts } from "@/components/layout/status-bar-alerts"
import { StatusBarMcp } from "@/components/layout/status-bar-mcp"
import { StatusBarUpdate } from "@/components/layout/status-bar-update"
import { CommandDropdown } from "@/components/layout/command-dropdown"
import { QuickActionsDropdown } from "@/components/layout/quick-actions-dropdown"
import { useIsMobile } from "@/hooks/use-mobile"

export function StatusBar() {
  const isMobile = useIsMobile()

  if (isMobile) {
    // Mobile mirrors the desktop bar: workspace stats on the left, the command
    // launcher + alerts on the right. `h-8` (matching desktop) gives the h-6
    // command control room. The branch selector and context-window circle live
    // in the below-composer row, so those are the bar's only two clusters.
    return (
      <div className="h-8 shrink-0 border-t border-border ws-chrome-border ws-surface-muted px-3 flex items-center justify-between text-xs text-muted-foreground">
        <div className="flex items-center gap-3">
          <QuickActionsDropdown />
          <StatusBarStats />
        </div>
        <div className="flex items-center gap-3">
          <StatusBarUpdate />
          <CommandDropdown />
          <StatusBarMcp />
          <StatusBarAlerts />
        </div>
      </div>
    )
  }

  return (
    <div className="h-8 shrink-0 border-t border-border ws-chrome-border ws-surface-muted pl-2 pr-4 flex items-center justify-between text-xs text-muted-foreground">
      {/* The branch selector, context-window circle and agent connection status
          moved to the below-composer folder/branch row; the left side now
          carries the quick-actions launcher (the window's bottom-left corner)
          and the workspace stats.

          Leading padding is `pl-2`, not the symmetric `px-4` the trailing edge
          keeps: it drops the quick-actions glyph onto the same vertical rail as
          the expanded sidebar's nav icons (New chat / Search / Automations /
          To-dos) and the folder / conversation icons below them, so the
          leading edge reads as one column top to bottom. The sidebar's rail
          axis is 0.375rem (nav container `px-1.5`) + 0.4375rem (row
          `pl-[0.4375rem]`) + half of its 0.875rem icon = 1.25rem; the launcher
          glyph is centered in a 1.5rem icon button, so its axis is 0.75rem in
          from the button's leading edge — hence 1.25 − 0.75 = 0.5rem here.
          Matching the EDGES too (not just the axis) additionally requires the
          glyph to be the sidebar's 0.875rem, which is why the trigger sizes it
          `size-3.5` rather than `h-3.5 w-3.5` — see the note there. Measured
          against the built stylesheet, both icons then occupy exactly 13–27px.
          Everything is rem-sized, so they stay locked under app zoom. */}
      <div className="flex items-center gap-3">
        <QuickActionsDropdown />
        <StatusBarStats />
      </div>
      <div className="flex items-center gap-4">
        <StatusBarUpdate />
        <StatusBarTasks />
        {/* Command launcher (moved from the aux "session details" tab), taking
            the slot the old static branch label (StatusBarSessionInfo) held. */}
        <CommandDropdown />
        {/* codeg-mcp service health. Sits next to the alerts bell because the
            two answer adjacent questions — "is something wrong right now?" —
            and both open a top-anchored popover from this corner. */}
        <StatusBarMcp />
        <StatusBarAlerts />
      </div>
    </div>
  )
}
