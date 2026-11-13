"use client"

/**
 * In the workspace: opens the assistants page's settings when another
 * window asks (`openPersonalAgentPage`), or when the workspace was opened on
 * `?pa=<page>` (the web, when no workspace tab was open to ask). Follows a
 * notification the owner opened (1.13): the assistant on its card, or the
 * conversation it points at, or one of the menu bar's assistants (10.10).
 * And on the desktop hands the backend each assistant's avatar as PNGs, for
 * the icon of the notifications it posts and the menu bar's face.
 */

import { useEffect, useRef } from "react"

import { usePrimaryAgent } from "@/contexts/personal-agent-context"
import { useWorkbenchRoute } from "@/contexts/workbench-route-context"
import { useReducedMotion } from "@/hooks/use-chat-motion"
import { uploadAvatarPngs } from "@/lib/personal-agent-avatar-png"
import { listenPersonalAgentFollow } from "@/lib/personal-agent-notify"
import {
  isSettingsPage,
  listenPersonalAgentOpen,
  PERSONAL_AGENT_OPEN_PARAM,
} from "@/lib/personal-agent-open"
import type { PersonalAgentNotifyLink } from "@/lib/types"
import { useRoster } from "@/stores/personal-agent-roster-store"
import {
  usePersonalAgentUi,
  type SettingsPage,
} from "@/stores/personal-agent-ui-store"

import { useSessionLinkOpener } from "./session-link"

export function PersonalAgentOpenBridge() {
  const { setRoute } = useWorkbenchRoute()
  const openSession = useSessionLinkOpener()
  const { snapshot } = usePrimaryAgent()
  const entries = useRoster()
  const still = useReducedMotion()
  const primaryId = snapshot?.agent?.id ?? null

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

  // Who the primary is, for the page's "`null` is the primary".
  const who = useRef<{ primary: number | null; kinds: Map<number, string> }>({
    primary: null,
    kinds: new Map(),
  })
  useEffect(() => {
    who.current = {
      primary: primaryId,
      kinds: new Map((entries ?? []).map((e) => [e.id, e.kind])),
    }
  }, [primaryId, entries])

  useEffect(
    () =>
      listenPersonalAgentFollow((link: PersonalAgentNotifyLink) => {
        if (link.kind === "conversation") {
          openSession(link.conversation_id)
          return
        }
        const { primary, kinds } = who.current
        const isPrimary =
          link.bot_id === primary || kinds.get(link.bot_id) === "primary"
        const ui = usePersonalAgentUi.getState()
        ui.setViewBot(isPrimary ? null : link.bot_id)
        ui.closeSettings()
        ui.setPendingJump(
          link.row_id != null ? { bot: link.bot_id, row: link.row_id } : null
        )
        setRoute("personalAgent")
      }),
    [openSession, setRoute]
  )

  useEffect(() => {
    if (entries) uploadAvatarPngs(entries, still)
  }, [entries, still])

  return null
}
