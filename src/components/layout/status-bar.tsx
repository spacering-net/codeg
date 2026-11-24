"use client"

import { StatusBarStats } from "@/components/layout/status-bar-stats"
import { StatusBarTasks } from "@/components/layout/status-bar-tasks"
import { StatusBarAlerts } from "@/components/layout/status-bar-alerts"
import { StatusBarMcp } from "@/components/layout/status-bar-mcp"
import { StatusBarComputer } from "@/components/layout/status-bar-computer"
import { StatusBarUpdate } from "@/components/layout/status-bar-update"
import { StatusBarWebService } from "@/components/layout/status-bar-web-service"
import { CommandDropdown } from "@/components/layout/command-dropdown"
import { StatusBarSrn } from "@/components/layout/status-bar-srn"
import { useIsMobile } from "@/hooks/use-mobile"

export function StatusBar() {
  const isMobile = useIsMobile()

  if (isMobile) {
    // Mobile mirrors the desktop bar: the SRN entry (whose menu also holds
    // the quick actions) and the workspace stats on the left, the command
    // launcher + alerts on the right. `h-8` (matching desktop) gives the h-6
    // command control room. The branch selector and context-window circle
    // live in the below-composer row, so those are the bar's only two
    // clusters. The SRN entry is its ring or avatar alone here: a name would
    // crowd the stats out.
    return (
      <div className="h-8 shrink-0 border-t border-border ws-chrome-border ws-surface-muted px-3 flex items-center justify-between text-xs text-muted-foreground">
        <div className="flex items-center gap-3">
          <StatusBarSrn compact />
          <StatusBarStats />
        </div>
        <div className="flex items-center gap-3">
          <StatusBarUpdate />
          <CommandDropdown />
          {/* Narrow is a viewport width, not a browser: a desktop window
              shrunk below the breakpoint must still say the web service is
              listening. Renders nothing outside the local desktop. */}
          <StatusBarMcp />
          <StatusBarWebService />
          <StatusBarAlerts />
        </div>
      </div>
    )
  }

  return (
    <div className="h-8 shrink-0 border-t border-border ws-chrome-border ws-surface-muted ps-2 pe-4 flex items-center justify-between text-xs text-muted-foreground">
      {/* The branch selector, context-window circle and agent connection status
          moved to the below-composer folder/branch row; the left side now
          carries the SRN account entry (the window's bottom-left corner) —
          one menu for the account and the quick actions — then the
          workspace stats.

          Leading padding is `ps-2`, not the symmetric `px-4` the trailing edge
          keeps (`pe-4`): it drops the SRN entry's glyph — the ring, or the
          avatar once signed in — onto the same vertical rail as the expanded
          sidebar's nav icons (New chat / Search / Automations / To-dos) and
          the folder / conversation icons below them, so the leading edge reads
          as one column top to bottom. Both are logical, so a right-to-left
          interface keeps the entry at its own leading edge, the right. The sidebar's rail axis is 0.375rem (nav
          container `px-1.5`) + 0.4375rem (row `pl-[0.4375rem]`) + half of its
          0.875rem icon = 1.25rem; the entry's glyph is centered in a 1.5rem
          (`h-6 w-6`) box, so its axis is 0.75rem in from the box's leading
          edge — hence 1.25 − 0.75 = 0.5rem here. Matching the EDGES too (not
          just the axis) additionally requires the glyph to be the sidebar's
          0.875rem: the ring and the avatar are both `size-3.5`. Measured
          against the built stylesheet, the glyph occupies exactly 13–27px.
          Everything is rem-sized, so it stays locked under app zoom.

          The signed-in name follows the box, inside the same capsule. The
          quick actions used to have a launcher of their own beside it; they
          are now the rows of the entry's menu, so nothing else sits
          on the rail. */}
      <div className="flex min-w-0 items-center gap-3">
        <StatusBarSrn />
        <StatusBarStats />
      </div>
      <div className="flex items-center gap-4">
        <StatusBarUpdate />
        <StatusBarTasks />
        {/* Command launcher (moved from the aux "session details" tab), taking
            the slot the old static branch label (StatusBarSessionInfo) held. */}
        <CommandDropdown />
        {/* Computer use: which windows agents may see right now. Renders
            nothing unless the desktop runtime has it switched on. */}
        <StatusBarComputer />
        {/* codeg-mcp service health. Opens a top-anchored popover from this
            corner. */}
        <StatusBarMcp />
        {/* Web service (remote access): whether the desktop is reachable over
            HTTP right now, and how far. Local desktop only. */}
        <StatusBarWebService />
        <StatusBarAlerts />
      </div>
    </div>
  )
}
