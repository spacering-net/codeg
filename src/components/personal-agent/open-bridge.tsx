"use client"

/**
 * In the workspace: opens the assistants page's settings when another
 * window asks (`openPersonalAgentPage`), or when the workspace was opened on
 * `?pa=<page>` (the web, when no workspace tab was open to ask).
 */

import { useEffect } from "react"

import { useWorkbenchRoute } from "@/contexts/workbench-route-context"
import {
  isSettingsPage,
  listenPersonalAgentOpen,
  PERSONAL_AGENT_OPEN_PARAM,
} from "@/lib/personal-agent-open"
import {
  usePersonalAgentUi,
  type SettingsPage,
} from "@/stores/personal-agent-ui-store"

export function PersonalAgentOpenBridge() {
  const { setRoute } = useWorkbenchRoute()
  useEffect(() => {
    const open = (page: SettingsPage) => {
      usePersonalAgentUi.getState().openSettings(page)
      setRoute("personalAgent")
    }
    const params = new URLSearchParams(window.location.search)
    const asked = params.get(PERSONAL_AGENT_OPEN_PARAM)
    if (asked != null) {
      params.delete(PERSONAL_AGENT_OPEN_PARAM)
      const rest = params.toString()
      window.history.replaceState(
        window.history.state,
        "",
        `${window.location.pathname}${rest ? `?${rest}` : ""}${window.location.hash}`
      )
      if (isSettingsPage(asked)) open(asked)
    }
    return listenPersonalAgentOpen(open)
  }, [setRoute])
  return null
}
