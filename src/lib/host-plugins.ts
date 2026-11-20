"use client"

import { useCallback, useEffect, useState } from "react"
import { getTransport, type Transport } from "@/lib/transport"

type WorkspacePanel = { id: string; title: string } & (
  | { view: "turnActivity" }
  | { view: "text"; text: string }
)

export interface InstalledPlugin {
  enabled: boolean
  manifest: {
    id: string
    name: string
    version: string
    contributes: {
      workspacePanels: WorkspacePanel[]
      commands: {
        id: string
        title: string
        action: { type: "openWorkspacePanel"; panelId: string }
      }[]
      hooks: { event: "session.turnCompleted"; action: "recordTurnActivity" }[]
    }
  }
}

export type PluginMutation =
  | { type: "install"; manifest: string }
  | { type: "setEnabled"; id: string; enabled: boolean }
  | { type: "remove"; id: string }

export interface PluginTurn {
  timestamp: string
  agentType: string
  stopReason: string
}

const CATALOG_CHANGED = "host-plugins://changed"
const ACTIVITY_CHANGED = "host-plugins://activity"

function usePluginResource<T, E>(
  transport: Transport | null,
  enabled: boolean,
  load: (transport: Transport) => Promise<T>,
  event: string,
  matches?: (payload: E) => boolean
) {
  const [snapshot, setSnapshot] = useState<{
    transport: Transport
    load: typeof load
    data?: T
    error?: unknown
  }>()
  const [revision, setRevision] = useState(0)
  const refresh = useCallback(() => setRevision((previous) => previous + 1), [])
  useEffect(() => {
    if (!enabled || !transport) return
    let active = true
    let latest = 0
    let unsubscribe: (() => void) | undefined
    const read = () => {
      const request = ++latest
      void load(transport).then(
        (data) => {
          if (active && request === latest)
            setSnapshot({ transport, load, data })
        },
        (error: unknown) => {
          if (active && request === latest)
            setSnapshot({ transport, load, error })
        }
      )
    }
    const stopReconnect = transport.onReconnect?.(read)
    void transport
      .subscribe<E>(event, (payload) => {
        if (!matches || matches(payload)) read()
      })
      .then(
        (stop) => {
          if (active) {
            unsubscribe = stop
            read()
          } else stop()
        },
        () => undefined
      )
    read()
    return () => {
      active = false
      unsubscribe?.()
      stopReconnect?.()
    }
  }, [enabled, event, load, matches, revision, transport])

  return {
    ...(enabled && snapshot?.transport === transport && snapshot.load === load
      ? { data: snapshot.data, error: snapshot.error }
      : undefined),
    refresh,
  }
}

export function useHostPlugins(enabled = true) {
  const transport =
    enabled && typeof window !== "undefined" ? getTransport() : null
  return usePluginResource(transport, enabled, loadCatalog, CATALOG_CHANGED)
}

function loadCatalog(transport: Transport) {
  return transport.call<InstalledPlugin[]>("host_plugins_list")
}

export function applyHostPlugin(mutation: PluginMutation) {
  return getTransport().call<InstalledPlugin[]>("host_plugins_apply", {
    mutation,
  })
}

export function usePluginActivity(pluginId: string, folderId: number) {
  const transport = typeof window === "undefined" ? null : getTransport()
  const load = useCallback(
    (host: Transport) =>
      host.call<PluginTurn[]>("host_plugins_activity", { pluginId, folderId }),
    [pluginId, folderId]
  )
  const matches = useCallback(
    (folder: number) => folder === folderId,
    [folderId]
  )
  return usePluginResource(transport, true, load, ACTIVITY_CHANGED, matches)
}

export function pluginPanelKey(pluginId: string, panelId: string) {
  return `${pluginId}:${panelId}`
}
