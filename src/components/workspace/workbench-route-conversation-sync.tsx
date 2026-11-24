"use client"

import { useEffect, useRef } from "react"

import { useTabActions, useTabStore } from "@/contexts/tab-context"
import { useWorkbenchRoute } from "@/contexts/workbench-route-context"

// Single chokepoint that keeps the workbench route honest: opening or switching
// to a conversation from ANY entry point (sidebar, ⌘T, search, deep links, pet
// focus, branch switch, run history …) activates a tab, so leaving a non-default
// route whenever activeTabId changes covers every opener — present and future —
// without patching each call site. Re-selecting the ALREADY-active tab does not
// change activeTabId, so the interactive conversation pickers (sidebar list,
// search dialog, run history) and the deep-link / focus bridges also call
// openConversations() directly.
export function WorkbenchRouteConversationSync() {
  const activeTabId = useTabStore((s) => s.activeTabId)
  const tabsHydrated = useTabStore((s) => s.tabsHydrated)
  const { consumeRemoteActivation } = useTabActions()
  const { openConversations } = useWorkbenchRoute()
  const prevRef = useRef(activeTabId)
  const hydratedRef = useRef(tabsHydrated)
  useEffect(() => {
    const wasHydrated = hydratedRef.current
    hydratedRef.current = tabsHydrated
    if (prevRef.current === activeTabId) return
    prevRef.current = activeTabId
    // The last session's tabs coming back (the focus they had, repaired in the
    // same pass that marks them hydrated) are nobody's activation: the window
    // stays on the view it opened on — the one it was left on. A remote
    // snapshot applied in that same pass leaves its mark: taken here too.
    if (!wasHydrated) {
      consumeRemoteActivation()
      return
    }
    // A remote tab snapshot that mirrors another client's focus also changes
    // activeTabId. That's not a local conversation activation, so don't hijack
    // this window into the conversations route — doing so would unmount whatever
    // non-conversation view it's on (e.g. the Automations editor + unsaved
    // edits). Local activations leave the flag false and switch as before.
    if (consumeRemoteActivation()) return
    openConversations()
  }, [activeTabId, tabsHydrated, openConversations, consumeRemoteActivation])
  return null
}
