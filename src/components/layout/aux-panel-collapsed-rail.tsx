"use client"

import { useAuxPanelContext } from "@/contexts/aux-panel-context"
import { useActiveFolder } from "@/contexts/active-folder-context"
import { useWorkbenchRoute } from "@/contexts/workbench-route-context"
import { useIsActiveChatMode } from "@/hooks/use-is-active-chat-mode"
import { useAuxTabOrder } from "@/lib/aux-panel-tab-order"
import {
  TAB_ICONS,
  resolveAuxTabView,
  useAuxTabLabel,
} from "./aux-panel-tab-meta"
import { TRIGGER_CLASS } from "./aux-panel-tab-rail"

/**
 * The aux panel's tab rail while the panel itself is closed: the same w-12
 * icon strip, pinned to the window's right edge, so the entry to files /
 * changes / commits and the work tabs never leaves the screen — Ctrl+E and
 * the corner toggle keep working unchanged.
 *
 * Mounted beside the shell's panel group (desktop only — the mobile drawer has
 * its own row). When the panel opens it unmounts in the same commit the panel
 * mounts in: the open panel's own rail is pinned to the panel's right edge,
 * which is the window's right edge from the first slide frame, so the icons
 * read as one continuous strip across the toggle.
 *
 * Not the rail's Reorder wiring — nothing to drag while folded. A press just
 * opens the panel on that tab (`openTab`); the reorder affordance belongs to
 * the open panel.
 */
export function AuxPanelCollapsedRail() {
  const { isOpen, restored, activeTab, openTab } = useAuxPanelContext()
  const { activeFolderId } = useActiveFolder()
  const isChatMode = useIsActiveChatMode()
  // A full-page workbench route hides the corner toggles and collapses the
  // panel for its duration; the fold hides with them, so it can't strand a
  // strip that opens a panel the route covers (mirrors the shell's own
  // `auxOpenRequested && isConversations`).
  const { isConversations } = useWorkbenchRoute()
  const tabOrder = useAuxTabOrder()
  const { showFolderTabs } = resolveAuxTabView(
    activeTab,
    activeFolderId,
    isChatMode
  )
  const tabLabel = useAuxTabLabel(showFolderTabs)

  // While open the panel carries the rail itself; before hydration the stored
  // open state isn't known yet and showing the fold would flash.
  if (isOpen || !restored || !isConversations || !showFolderTabs) return null

  return (
    // Same surface as the open panel's rail column: `bg-background` off-image,
    // the workspace background through `ws-transparent-bg` on-image, the start
    // hairline separating it from the center column.
    <aside className="flex h-full w-12 shrink-0 flex-col overflow-hidden bg-background ws-transparent-bg text-sidebar-foreground select-none">
      {/* The fixed top-right window-chrome overlay — terminal / aux / settings,
          and the native caption strip on Windows/Linux — floats over this
          h-10; the blank keeps the icons clear of it, and being a drag region
          it still moves the window. (ChromeReserve is unnecessary here: the
          whole strip is as wide as the rail it stands under.) */}
      <div data-tauri-drag-region className="h-10 shrink-0" />
      <div
        data-aux-collapsed-rail
        className="flex min-h-0 flex-1 flex-col items-center gap-1 overflow-y-auto border-s border-border py-1.5 ws-chrome-border"
      >
        {tabOrder.map((tab) => {
          const Icon = TAB_ICONS[tab]
          const label = tabLabel(tab)
          return (
            <button
              key={tab}
              type="button"
              title={label}
              aria-label={label}
              onClick={() => openTab(tab)}
              className={TRIGGER_CLASS}
            >
              <Icon className="size-4" />
            </button>
          )
        })}
      </div>
    </aside>
  )
}
