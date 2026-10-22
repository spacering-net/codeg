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

// Debounce before the "reconnecting" dialog is shown. Server restarts, brief
// network blips, and laptop sleep/wake usually recover within a few seconds —
// surfacing a modal for every transient drop would flicker. The transport's
// state machine flips to "reconnecting" instantly; this delay is purely the
// UI deciding when the interruption is worth interrupting the user over.
// `unauthorized` and `proxyUnauthorized` bypass this — a rejected session is a
// definitive signal worth telling the user about immediately.
const RECONNECT_DIALOG_GRACE_MS = 4_000

/**
 * Global, single-instance guard mounted once at the root layout. Watches the
 * web transport's connection health and renders a blocking dialog when the
 * link is lost (auto-reconnecting, with a manual "Reconnect now") or the
 * session has expired (prompting re-login). Inert outside web mode — the store
 * returns "connected" for SSR / desktop / remote-desktop, so this renders
 * nothing there.
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

  // Fast recovery on network restore / tab wake. Backoff caps at 32s, but the
  // browser signals the instant connectivity returns (`online`) or the tab
  // becomes visible after sleep — probe right away instead of waiting out the
  // remaining backoff (sleep/wake and Wi‑Fi flaps are the common triggers).
  // Guarded to "reconnecting" so a healthy link is never torn down; the store
  // accessors are no-ops off web, so this is inert on desktop/SSR.
  useEffect(() => {
    const nudgeIfReconnecting = () => {
      if (getWebConnectionSnapshot() === "reconnecting") reconnectWebNow()
    }
    const onVisible = () => {
      if (document.visibilityState === "visible") nudgeIfReconnecting()
    }
    window.addEventListener("online", nudgeIfReconnecting)
    document.addEventListener("visibilitychange", onVisible)
    return () => {
      window.removeEventListener("online", nudgeIfReconnecting)
      document.removeEventListener("visibilitychange", onVisible)
    }
  }, [])

  const showReconnecting = state === "reconnecting" && graceElapsed
  const showUnauthorized = state === "unauthorized"
  // A proxy in front of Codeg (e.g. Cloudflare Access) rejected the request:
  // its session expired, not the Codeg token. A top-level reload lets the
  // proxy run its own login flow and keeps the token; "Go to login" stays as
  // the way out should the proxy keep refusing after the reload.
  const showProxyUnauthorized = state === "proxyUnauthorized"
  const open = showReconnecting || showUnauthorized || showProxyUnauthorized

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
            {showUnauthorized || showProxyUnauthorized ? (
              <ShieldAlert className="text-destructive" />
            ) : (
              <Loader2 className="animate-spin" />
            )}
          </AlertDialogMedia>
          <AlertDialogTitle>
            {showProxyUnauthorized
              ? t("proxySignInTitle")
              : showUnauthorized
                ? t("sessionExpiredTitle")
                : t("disconnectedTitle")}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {showProxyUnauthorized
              ? t("proxySignInDescription")
              : showUnauthorized
                ? t("sessionExpiredDescription")
                : t("reconnectingDescription")}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          {showProxyUnauthorized ? (
            <>
              <Button variant="outline" onClick={() => redirectToCodegLogin()}>
                {t("goToLogin")}
              </Button>
              <Button onClick={() => window.location.reload()}>
                {t("reloadPage")}
              </Button>
            </>
          ) : showUnauthorized ? (
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
