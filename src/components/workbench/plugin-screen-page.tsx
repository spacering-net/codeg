"use client"

import { useEffect, useMemo, useState } from "react"
import { useLocale } from "next-intl"
import { HostPluginSurface } from "@/components/host-plugin-surface"
import { WorkbenchPageTitle } from "@/components/workbench/workbench-page-title"
import { useWorkbenchRoute } from "@/contexts/workbench-route-context"
import { useHistoryBackDismiss } from "@/hooks/use-history-back-dismiss"
import { resolvePluginScreen, useHostPlugins } from "@/lib/host-plugins"
import type { Transport } from "@/lib/transport"

export function PluginScreenPageTitle() {
  const locale = useLocale()
  const { pluginScreen } = useWorkbenchRoute()
  const { data: plugins } = useHostPlugins()
  const resolved = useMemo(
    () =>
      pluginScreen
        ? resolvePluginScreen(
            plugins,
            pluginScreen.pluginId,
            pluginScreen.screenId,
            locale
          )
        : null,
    [locale, pluginScreen, plugins]
  )

  return (
    <WorkbenchPageTitle
      title={resolved?.title ?? pluginScreen?.screenId ?? ""}
      trail={
        resolved ? (
          <span className="truncate pl-2 text-xs text-muted-foreground">
            {resolved.pluginName}
          </span>
        ) : null
      }
    />
  )
}

export function PluginScreenPage() {
  const locale = useLocale()
  const { routeId, pluginScreen, openConversations } = useWorkbenchRoute()
  const { data: plugins, transport } = useHostPlugins()

  const sessionKey = pluginScreen
    ? `${pluginScreen.pluginId}:${pluginScreen.screenId}:${pluginScreen.openSeq}`
    : null
  const [boundSession, setBoundSession] = useState<{
    sessionKey: string
    transport: Transport
  } | null>(null)

  if (!sessionKey) {
    if (boundSession !== null) {
      setBoundSession(null)
    }
  } else if (
    transport &&
    (!boundSession || boundSession.sessionKey !== sessionKey)
  ) {
    setBoundSession({ sessionKey, transport })
  }

  const hostSwitched = Boolean(
    sessionKey &&
    boundSession &&
    boundSession.sessionKey === sessionKey &&
    transport !== boundSession.transport
  )

  const resolved = useMemo(() => {
    if (!pluginScreen || hostSwitched) return null
    return resolvePluginScreen(
      plugins,
      pluginScreen.pluginId,
      pluginScreen.screenId,
      locale
    )
  }, [hostSwitched, locale, pluginScreen, plugins])

  const shouldWithdraw =
    !pluginScreen || hostSwitched || (plugins !== undefined && !resolved)

  useEffect(() => {
    if (routeId === "pluginScreen" && shouldWithdraw) {
      openConversations()
    }
  }, [openConversations, routeId, shouldWithdraw])

  useHistoryBackDismiss(
    routeId === "pluginScreen" && !shouldWithdraw,
    openConversations
  )

  if (!resolved) {
    return null
  }

  return (
    <div
      data-testid="host-plugin-screen-page"
      className="flex h-full min-h-0 w-full flex-col overflow-hidden"
    >
      <HostPluginSurface
        key={`${resolved.pluginId}:screen:${resolved.id}`}
        pluginId={resolved.pluginId}
        title={resolved.title}
        context={{ type: "screen", id: resolved.id }}
        className="h-full min-h-0 w-full flex-1 rounded-none border-0"
      />
    </div>
  )
}
