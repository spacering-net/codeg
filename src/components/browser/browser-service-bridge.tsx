"use client"

import { useEffect, useRef } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"

import { useOptionalWorkspaceActions } from "@/contexts/workspace-context"
import { useLinkDecision, useOpenUrlTarget } from "@/hooks/use-open-url-target"
import { getBrowserPrefs } from "@/lib/browser/browser-prefs"
import { displayHostPort } from "@/lib/browser/browser-url"
import {
  BROWSER_SERVICE_DETECTED_EVENT,
  type DetectedService,
} from "@/lib/browser/types"
import { getCurrentWindowLabel } from "@/lib/browser/window-label"
import { getTransport, isDesktop } from "@/lib/transport"

/**
 * Long enough to notice and reach for. Every toast holds the native browser
 * surfaces down while it is up (`AppToaster`), so this is a page frozen
 * behind it too — 10 s is the same order as the workspace's other actionable
 * notices and well inside the 20 s cap there.
 */
const NOTICE_MS = 10_000

/**
 * The window's answer to "a local server just started".
 *
 * The backend watches every terminal it runs — the terminal panel, canvas
 * cards, and the terminals agents ask it to run — and says so on
 * `browser://service-detected` once per terminal per address, having first
 * established that the address is a loopback one and that something is
 * listening on it. What to do about that is a preference
 * (`browser:service-auto-open`), and this is the only place that reads it.
 *
 * Mounted beside `BrowserEventsBridge` rather than inside it: that one
 * returns early where no built-in browser exists, and this is useful in web
 * mode too, where a loopback address reaches the codeg-server's port bridge.
 *
 * Three things it deliberately does NOT do:
 *
 * - **Launch the system browser.** Where the link decision says `system`
 *   (someone set terminal links to open there) the notice is raised instead:
 *   a browser window taking over the desktop is not something software should
 *   do without a person pressing something.
 * - **Say anything about a blocked address.** A site rule refusing a host is
 *   an answer the user already gave; repeating it as a toast every time a
 *   server starts would be nagging.
 * - **Dedupe across restarts.** That is the backend's job and it does it per
 *   terminal, so a watcher reprinting its banner is quiet while the same
 *   address started from a second terminal is a new thing to hear about.
 */
export function BrowserServiceBridge() {
  const t = useTranslations("Browser.toast")
  const openBrowserTab = useOptionalWorkspaceActions()?.openBrowserTab ?? null
  const decide = useLinkDecision()
  const openUrl = useOpenUrlTarget()

  // The subscription is set up once; the handlers it calls are read through
  // refs, so a re-render never tears down and rebuilds the stream (and never
  // drops the event that arrives in between).
  const decideRef = useRef(decide)
  const openUrlRef = useRef(openUrl)
  const openBrowserTabRef = useRef(openBrowserTab)
  const tRef = useRef(t)
  useEffect(() => {
    decideRef.current = decide
    openUrlRef.current = openUrl
    openBrowserTabRef.current = openBrowserTab
    tRef.current = t
  }, [decide, openUrl, openBrowserTab, t])

  useEffect(() => {
    let cancelled = false
    let unsubscribe: (() => void) | null = null

    const notify = (service: DetectedService) => {
      const address = displayHostPort(service.url) ?? service.url
      toast(tRef.current("serviceDetected", { address }), {
        // One notice per address: a second terminal on the same port replaces
        // the first toast instead of stacking another under it.
        id: `service:${service.origin}`,
        description: tRef.current("serviceDetectedHint"),
        duration: NOTICE_MS,
        action: {
          label: tRef.current("serviceOpen"),
          // Through the normal link path, not straight to a tab: this one IS
          // a gesture, so the per-source preference (and the system browser,
          // for whoever chose it) applies exactly as it would on a click.
          onClick: () => {
            openUrlRef.current(service.url, { source: "terminal" })
          },
        },
      })
    }

    const handle = (service: DetectedService) => {
      // Every window hears every event; only the one that owns the terminal
      // acts. In web mode the backend has no window to name and says `web`.
      const mine = isDesktop() ? getCurrentWindowLabel() : "web"
      if (service.ownerWindow !== mine) return
      const mode = getBrowserPrefs().serviceAutoOpen
      if (mode === "off") return
      const action = decideRef.current(service.url, { source: "terminal" })
      // `reject` is a site rule (or an address a tab may not show): silence.
      // `file` and `os-handler` cannot arise for an http(s) address.
      if (action.kind !== "builtin" && action.kind !== "system") return
      if (mode === "open" && action.kind === "builtin") {
        // Selected in the strip, so the page is loaded and on screen rather
        // than an unvisited tab next to an empty column — but the pane is
        // left where it is: a server coming up may show its page, it may not
        // pull someone out of the conversation they are reading.
        openBrowserTabRef.current?.(action.url, {
          activate: "tab",
          ...(action.remote ? { remote: true } : {}),
        })
        return
      }
      notify(service)
    }

    void (async () => {
      const stop = await getTransport().subscribe<DetectedService>(
        BROWSER_SERVICE_DETECTED_EVENT,
        handle
      )
      if (cancelled) {
        stop()
        return
      }
      unsubscribe = stop
    })()

    return () => {
      cancelled = true
      unsubscribe?.()
    }
  }, [])

  return null
}
