"use client"

import { useEffect } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { toErrorMessage } from "@/lib/app-error"
import {
  getShellTransport,
  isDesktop,
  isRemoteDesktopMode,
} from "@/lib/transport"
import {
  takeWorkspaceRestoreFailures,
  WORKSPACE_RESTORE_FAILED_EVENT,
} from "@/lib/workspace-restore"

/**
 * Says which remote workspaces the desktop app could not reopen at launch.
 *
 * The backend reopens the workspace windows that were open at the last quit.
 * When a remote one fails its health check, it brings this window (the local
 * workspace) up, parks the failure, and nudges. The nudge can come before this
 * window listens, so the failures are also taken once on mount.
 */
export function WorkspaceRestoreNotices() {
  const t = useTranslations("RemoteWorkspace")

  useEffect(() => {
    if (!isDesktop() || isRemoteDesktopMode()) return
    let cancelled = false
    let unsubscribe: (() => void) | null = null

    // Shown even if this unmounted meanwhile: the failures are taken, so a
    // later mount would find nothing, and the toaster outlives this component.
    const drain = async () => {
      for (const failure of await takeWorkspaceRestoreFailures()) {
        toast.error(t("restoreFailed", { name: failure.name }), {
          description: toErrorMessage(failure.error),
        })
      }
    }

    void (async () => {
      try {
        const off = await getShellTransport().subscribe(
          WORKSPACE_RESTORE_FAILED_EVENT,
          () => {
            void drain()
          }
        )
        if (cancelled) off()
        else unsubscribe = off
      } catch (err) {
        console.warn("[WorkspaceRestoreNotices] subscription failed:", err)
      }
      // After subscribing, so a nudge sent while the subscription was being
      // set up cannot fall between the two.
      if (!cancelled) await drain()
    })()

    return () => {
      cancelled = true
      unsubscribe?.()
    }
  }, [t])

  return null
}
