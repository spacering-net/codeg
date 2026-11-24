"use client"

/**
 * Every window takes the assistants' notifications (`personal-agent://
 * notify`, 1.13) and puts them in front of the owner as the backend routed
 * them (`handlePersonalAgentNotify`). On the desktop it also hands this
 * device's notification switch and "hide contents" to the backend, which
 * posts the assistants' notifications itself: once at start, and whenever
 * they change. The windows that are not the owner at work (as presence
 * has them) stay out of it.
 *
 * The subscription follows the window: made once it leaves a route that
 * stays out (a window that signs in at /login goes on to the workspace
 * without a reload), and made again when a remote-desktop window points
 * its transport at its server — the one running its assistants.
 */

import { useEffect, useRef, useState } from "react"
import { usePathname } from "next/navigation"
import { useTranslations } from "next-intl"

import { skipsPresence } from "@/components/presence-heartbeat"
import { notificationPrefsSync } from "@/lib/api"
import {
  getDesktopNotificationPrefs,
  subscribeDesktopNotificationPrefs,
} from "@/lib/desktop-notification-prefs"
import {
  handlePersonalAgentNotify,
  type NotifyWords,
} from "@/lib/personal-agent-notify"
import { subscribe } from "@/lib/platform"
import { isDesktop, onActiveTransportChange } from "@/lib/transport"
import {
  PERSONAL_AGENT_NOTIFY_EVENT,
  type PersonalAgentNotify,
} from "@/lib/types"

export function PersonalAgentNotifier() {
  const t = useTranslations("PersonalAgent.notify")
  const open = t("open")
  const words = useRef<NotifyWords>({ open })
  useEffect(() => {
    words.current = { open }
  }, [open])

  const pathname = usePathname()
  const skipped = skipsPresence(pathname ?? window.location.pathname)
  const [transport, setTransport] = useState(0)
  useEffect(() => onActiveTransportChange(() => setTransport((n) => n + 1)), [])

  useEffect(() => {
    if (skipped) return
    let live = true
    let off: (() => void) | null = null
    subscribe<PersonalAgentNotify>(PERSONAL_AGENT_NOTIFY_EVENT, (n) => {
      if (live) void handlePersonalAgentNotify(n, words.current)
    })
      .then((unsubscribe) => {
        if (live) off = unsubscribe
        else unsubscribe()
      })
      .catch(() => {})
    return () => {
      live = false
      off?.()
    }
  }, [skipped, transport])

  useEffect(() => {
    if (!isDesktop() || skipped) return
    let sent: string | null = null
    const push = () => {
      const p = getDesktopNotificationPrefs()
      const key = `${p.enabled}:${p.hideBody}`
      if (key === sent) return
      sent = key
      Promise.resolve()
        .then(() => notificationPrefsSync(p.enabled, p.hideBody))
        .catch(() => {
          // Said again with the next change, or the next start.
          if (sent === key) sent = null
        })
    }
    push()
    return subscribeDesktopNotificationPrefs(push)
  }, [skipped])

  return null
}
