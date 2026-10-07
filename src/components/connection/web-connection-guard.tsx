"use client"

import { useEffect, useState, useSyncExternalStore } from "react"
import { Loader2, ShieldAlert } from "lucide-react"
import { useTranslations } from "next-intl"
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import {
  getWebConnectionServerSnapshot,
  getWebConnectionSnapshot,
  reconnectWebNow,
  subscribeWebConnection,
} from "@/lib/transport/web-connection-store"
import { redirectToCodegLogin } from "@/lib/transport/web-auth"
import { probeTransportLiveness } from "@/lib/platform"

// Debounce before the "reconnecting" dialog is shown. Server restarts, brief
// network blips, and laptop sleep/wake usually recover within a few seconds —
// surfacing a modal for every transient drop would flicker. The transport's
// state machine flips to "reconnecting" instantly; this delay is purely the
// UI deciding when the interruption is worth interrupting the user over.
// `unauthorized` bypasses this — a rejected token is a definitive signal worth
// telling the user about immediately.
const RECONNECT_DIALOG_GRACE_MS = 4_000

/**
 * Global, single-instance guard mounted once at the root layout. Watches the
 * web transport's connection health and renders a blocking dialog when the
 * link is lost (auto-reconnecting, with a manual "Reconnect now") or the
 * session has expired (prompting re-login). The dialog is inert outside web
 * mode — the store returns "connected" for SSR / desktop / remote-desktop, so
 * it renders nothing there. The wake-time liveness probe below is not: it
 * goes through whichever transport is active, so a remote-workspace desktop
 * window gets the same post-sleep recovery via its Rust-side proxy.
 */
export function WebConnectionGuard() {
  const t = useTranslations("WebConnection")
  const state = useSyncExternalStore(
    subscribeWebConnection,
    getWebConnectionSnapshot,
    getWebConnectionServerSnapshot
  )

  // Grace debounce: only reveal the reconnecting dialog once the link has been
  // down continuously for RECONNECT_DIALOG_GRACE_MS. `graceElapsed` is set
  // true only from the timer callback; the cleanup resets it to false whenever
  // `state` changes (recovered, or escalated to unauthorized), so the next
  // outage starts a fresh grace window rather than flashing instantly.
  const [graceElapsed, setGraceElapsed] = useState(false)
  useEffect(() => {
    if (state !== "reconnecting") return
    const id = setTimeout(
      () => setGraceElapsed(true),
      RECONNECT_DIALOG_GRACE_MS
    )
    return () => {
      clearTimeout(id)
      setGraceElapsed(false)
    }
  }, [state])

  // Fast recovery on network restore / tab wake. Two things can be wrong when
  // the machine wakes. Either the transport already knows the link is down —
  // backoff caps at 32s, so probe right away instead of waiting it out — or
  // it does NOT know: a socket that died during sleep sits in OPEN state
  // until the OS times it out, with no close event to trigger reconnection,
  // and the event stream stays dark for minutes. `probeTransportLiveness`
  // covers both — while reconnecting it skips the remaining backoff; on a
  // seemingly-healthy socket it pings and replaces the socket if no pong
  // comes back within seconds. A healthy link only ever costs one ping.
  // `pageshow` is the bfcache restore on mobile Safari, which fires no
  // `visibilitychange`. Inert on the local desktop transport, whose IPC has
  // no socket to lose.
  useEffect(() => {
    const probe = () => probeTransportLiveness()
    const onVisible = () => {
      if (document.visibilityState === "visible") probe()
    }
    window.addEventListener("online", probe)
    window.addEventListener("pageshow", probe)
    document.addEventListener("visibilitychange", onVisible)
    return () => {
      window.removeEventListener("online", probe)
      window.removeEventListener("pageshow", probe)
      document.removeEventListener("visibilitychange", onVisible)
    }
  }, [])

  const showReconnecting = state === "reconnecting" && graceElapsed
  const showUnauthorized = state === "unauthorized"
  const open = showReconnecting || showUnauthorized

  if (!open) return null

  return (
    <AlertDialog open onOpenChange={() => {}}>
      <AlertDialogContent
        // Forced state: block Esc/outside dismissal. The dialog is driven
        // entirely by connection health — it closes when the link recovers,
        // not on user whim.
        onEscapeKeyDown={(e) => e.preventDefault()}
      >
        <AlertDialogHeader>
          <AlertDialogMedia>
            {showUnauthorized ? (
              <ShieldAlert className="text-destructive" />
            ) : (
              <Loader2 className="animate-spin" />
            )}
          </AlertDialogMedia>
          <AlertDialogTitle>
            {showUnauthorized
              ? t("sessionExpiredTitle")
              : t("disconnectedTitle")}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {showUnauthorized
              ? t("sessionExpiredDescription")
              : t("reconnectingDescription")}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          {showUnauthorized ? (
            <Button onClick={() => redirectToCodegLogin()}>
              {t("goToLogin")}
            </Button>
          ) : (
            <Button onClick={() => reconnectWebNow()}>
              {t("reconnectNow")}
            </Button>
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
