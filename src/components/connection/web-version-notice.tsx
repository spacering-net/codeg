"use client"

import { useEffect, useSyncExternalStore } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import {
  getRunningServerVersion,
  isOwnServerRestartRunning,
  subscribeOwnServerRestart,
} from "@/lib/updater"
import { getCodegToken } from "@/lib/transport/web-auth"
import {
  getWebConnectionServerSnapshot,
  getWebConnectionSnapshot,
  subscribeWebConnection,
  usesWebTransport,
} from "@/lib/transport/web-connection-store"

export const WEB_VERSION_TOAST_ID = "web-version-changed"

/**
 * Offers a reload when the server runs a different release than this page.
 *
 * The desktop app restarts into a new release; a browser tab does not. A
 * server upgraded under an open tab goes on answering it, and the tab goes on
 * running the previous release's code, fixes not included, until it is
 * reloaded. Checked when the page loads and each time the connection comes
 * back, which is what a restarted server looks like from here.
 */
export function WebVersionNotice() {
  const t = useTranslations("WebConnection")
  const state = useSyncExternalStore(
    subscribeWebConnection,
    getWebConnectionSnapshot,
    getWebConnectionServerSnapshot
  )
  // This page's own upgrade or rollback reports its outcome and reloads.
  const ownRestart = useSyncExternalStore(
    subscribeOwnServerRestart,
    isOwnServerRestartRunning,
    () => false
  )

  useEffect(() => {
    if (ownRestart) {
      toast.dismiss(WEB_VERSION_TOAST_ID)
      return
    }
    if (state !== "connected") return
    // The release this page was built from (inlined by next.config.ts). A
    // development build is not one, whatever its version says.
    const pageVersion = process.env.CODEG_APP_VERSION
    if (!pageVersion || process.env.NODE_ENV !== "production") return
    // Without a token the request would be refused, and a refusal reads as an
    // expired session.
    if (!usesWebTransport() || !getCodegToken()) return
    let cancelled = false
    void getRunningServerVersion().then((serverVersion) => {
      // An older server does not report its version.
      if (cancelled || !serverVersion) return
      if (serverVersion === pageVersion) {
        toast.dismiss(WEB_VERSION_TOAST_ID)
        return
      }
      toast(t("versionChangedTitle", { version: serverVersion }), {
        id: WEB_VERSION_TOAST_ID,
        description: t("versionChangedDescription", { version: pageVersion }),
        duration: Infinity,
        action: {
          label: t("reloadPage"),
          onClick: () => window.location.reload(),
        },
      })
    })
    return () => {
      cancelled = true
    }
  }, [state, ownRestart, t])

  return null
}
