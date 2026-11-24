"use client"

import { useCallback, useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { toErrorMessage } from "@/lib/app-error"
import { isDesktop } from "@/lib/platform"
import {
  listRemoteWorkspaceConnections,
  openRemoteWorkspace,
} from "@/lib/remote-workspace"
import type { RemoteWorkspaceConnection } from "@/lib/types"

/**
 * Shared state + actions behind every "Open remote workspace" menu (the
 * quick-actions submenu in the status bar's account menu, the sidebar list's
 * context menu). Each of them renders its own markup — one is a dropdown, one
 * a context menu — but the loading, the opening and the two failure toasts
 * are identical, so they live here instead of being copy-pasted per surface.
 *
 * `refresh` is deliberately NOT called on mount: connections are only needed
 * once a submenu actually opens, and these menus are mounted for the whole
 * session. Callers wire it to their submenu's `onOpenChange`.
 *
 * `desktop` is re-exported so callers can hide their entry entirely: a web
 * client can't spawn another window bound to a different server.
 */
export function useRemoteWorkspaceConnections() {
  const t = useTranslations("RemoteWorkspace")
  const [connections, setConnections] = useState<RemoteWorkspaceConnection[]>(
    []
  )

  const desktop = isDesktop()

  const refresh = useCallback(async () => {
    if (!desktop) return
    try {
      setConnections(await listRemoteWorkspaceConnections())
    } catch (err) {
      toast.error(t("loadFailed"), { description: toErrorMessage(err) })
    }
  }, [desktop, t])

  const open = useCallback(
    (connectionId: number) => {
      openRemoteWorkspace(connectionId).catch((err) => {
        toast.error(t("openFailed"), { description: toErrorMessage(err) })
      })
    },
    [t]
  )

  return { desktop, connections, refresh, open }
}
