"use client"

import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react"
import { AlertTriangle, ChevronDown, Loader2, Puzzle } from "lucide-react"
import { useLocale, useTranslations } from "next-intl"
import { toast } from "sonner"
import { ComposerDockStrip } from "@/components/chat/composer-dock-strip"
import {
  HostPluginSurface,
  type PluginComposerInsertHandler,
} from "@/components/host-plugin-surface"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { useOptionalAuxPanelContext } from "@/contexts/aux-panel-context"
import { useOptionalWorkbenchRoute } from "@/contexts/workbench-route-context"
import { toErrorMessage } from "@/lib/app-error"
import {
  hostPluginSessionScopeKey,
  isCurrentReadyHostTransport,
  pluginPanelKey,
  selectPluginComposerPills,
  selectPluginSessionActions,
  useHostPlugins,
  usePluginHostScope,
  usePluginInputActivities,
  validateComposerActionResult,
  type ComposerActionInput,
  type ComposerRuntimeScope,
  type HostPluginSessionContext,
  type PluginClientSurfaceSlot,
  type PluginComposerInsertResult,
  type ResolvedComposerPillLeafAction,
} from "@/lib/host-plugins"
import { emitAppendTextToSession } from "@/lib/session-attachment-events"
import type { Transport } from "@/lib/transport"
import { cn } from "@/lib/utils"

const useIsomorphicLayoutEffect =
  typeof window !== "undefined" ? useLayoutEffect : useEffect

interface OpenSurfaceState {
  pluginId: string
  pluginName: string
  surfaceId: string
  slot: PluginClientSurfaceSlot
  title: string
  scopeKey: string
  transport: Transport | null
}

function runtimeScopeOf(
  context: HostPluginSessionContext,
  override?: ComposerRuntimeScope
): ComposerRuntimeScope {
  if (override) return override
  return context.conversationId === null ? "draft" : "session"
}

function usePluginLeafExecutor({
  source,
  sessionContext,
  scope,
  enabled,
  validItemKeys,
  onInsertText,
}: {
  source: "composerPill" | "sessionAction"
  sessionContext: HostPluginSessionContext
  scope: ComposerRuntimeScope
  enabled: boolean
  validItemKeys: ReadonlySet<string>
  onInsertText?: (
    text: string,
    expectedScopeKey: string
  ) => PluginComposerInsertResult | void
}) {
  const t = useTranslations("HostPlugins")
  const locale = useLocale()
  const hostScope = usePluginHostScope()
  const { data: plugins, transport } = useHostPlugins(enabled)
  const auxPanel = useOptionalAuxPanelContext()
  const workbenchRoute = useOptionalWorkbenchRoute()

  const sessionScopeKey = hostPluginSessionScopeKey(sessionContext)
  const fullScopeKey = `${hostScope.scopeKey}:${sessionScopeKey}:${scope}`

  const [openSurface, setOpenSurface] = useState<OpenSurfaceState | null>(null)
  const [busyByKey, setBusyByKey] = useState<{
    transport: Transport | null
    fullScopeKey: string
    entries: Record<string, boolean>
  }>({ transport: null, fullScopeKey: "", entries: {} })

  const activeSurface = useMemo(() => {
    if (
      !enabled ||
      !hostScope.transportReady ||
      !openSurface ||
      openSurface.scopeKey !== fullScopeKey ||
      openSurface.transport !== transport ||
      !plugins
    ) {
      return null
    }
    const plugin = plugins.find(
      (item) => item.enabled && item.manifest.id === openSurface.pluginId
    )
    if (!plugin || !plugin.manifest.client?.entry?.trim()) return null
    const declared = plugin.manifest.contributes?.clientSurfaces?.some(
      (s) => s.id === openSurface.surfaceId && s.slot === openSurface.slot
    )
    return declared ? openSurface : null
  }, [
    enabled,
    fullScopeKey,
    hostScope.transportReady,
    openSurface,
    plugins,
    transport,
  ])

  if (openSurface !== null && !activeSurface) {
    setOpenSurface(null)
  }

  const generationRef = useRef(0)
  const liveRef = useRef({
    enabled,
    transportReady: hostScope.transportReady,
    transport,
    sessionContext,
    sessionScopeKey,
    fullScopeKey,
    scope,
    locale,
    validItemKeys,
    onInsertText,
    auxPanel,
    workbenchRoute,
  })

  useIsomorphicLayoutEffect(() => {
    liveRef.current = {
      enabled,
      transportReady: hostScope.transportReady,
      transport,
      sessionContext,
      sessionScopeKey,
      fullScopeKey,
      scope,
      locale,
      validItemKeys,
      onInsertText,
      auxPanel,
      workbenchRoute,
    }
  }, [
    enabled,
    hostScope.transportReady,
    transport,
    sessionContext,
    sessionScopeKey,
    fullScopeKey,
    scope,
    locale,
    validItemKeys,
    onInsertText,
    auxPanel,
    workbenchRoute,
  ])

  useEffect(() => {
    generationRef.current += 1
  }, [enabled, fullScopeKey, transport])

  useEffect(() => {
    return () => {
      generationRef.current += 1
    }
  }, [])

  const isBusy = (key: string) =>
    busyByKey.transport === transport &&
    busyByKey.fullScopeKey === fullScopeKey &&
    busyByKey.entries[key] === true

  const setBusy = useCallback(
    (
      capturedTransport: Transport,
      capturedFullScope: string,
      key: string,
      busy: boolean
    ) => {
      setBusyByKey((prev) => {
        const base =
          prev.transport === capturedTransport &&
          prev.fullScopeKey === capturedFullScope
            ? prev.entries
            : {}
        return {
          transport: capturedTransport,
          fullScopeKey: capturedFullScope,
          entries: { ...base, [key]: busy },
        }
      })
    },
    []
  )

  const executeLeaf = useCallback(
    (
      item: {
        key: string
        pluginId: string
        pluginName: string
        id: string
      },
      action: ResolvedComposerPillLeafAction,
      menuItemId?: string
    ) => {
      const live = liveRef.current
      if (
        !live.enabled ||
        !live.transportReady ||
        !live.transport ||
        !isCurrentReadyHostTransport(live.transport) ||
        !live.validItemKeys.has(item.key)
      ) {
        return
      }

      if (action.kind === "openWorkspacePanel") {
        if (live.sessionContext.folderId == null) {
          toast.info(t("composerWorkspaceRequired"))
          return
        }
        live.auxPanel?.openPluginPanel(
          pluginPanelKey(item.pluginId, action.panelId)
        )
        return
      }

      if (action.kind === "openScreen") {
        live.workbenchRoute?.openPluginScreen({
          pluginId: item.pluginId,
          screenId: action.screenId,
        })
        return
      }

      if (action.kind === "openClientSurface") {
        setOpenSurface({
          pluginId: item.pluginId,
          pluginName: item.pluginName,
          surfaceId: action.surfaceId,
          slot: action.slot,
          title: action.surfaceTitle,
          scopeKey: live.fullScopeKey,
          transport: live.transport,
        })
        return
      }

      if (action.kind === "insertText") {
        if (live.onInsertText) {
          try {
            live.onInsertText(action.text, live.sessionScopeKey)
          } catch (cause) {
            toast.error(t("composerActionFailed"), {
              description: toErrorMessage(cause),
            })
          }
        }
        return
      }

      if (
        action.kind === "callMethod" &&
        typeof live.transport.call === "function"
      ) {
        const capturedTransport = live.transport
        const capturedFullScope = live.fullScopeKey
        const capturedSessionScope = live.sessionScopeKey
        const generation = generationRef.current
        setBusy(capturedTransport, capturedFullScope, item.key, true)

        const input: ComposerActionInput =
          source === "composerPill"
            ? {
                source: "composerPill",
                itemId: item.id,
                ...(menuItemId ? { menuItemId } : {}),
                scope: live.scope,
                folderId: live.sessionContext.folderId,
                conversationId: live.sessionContext.conversationId,
                locale: live.locale,
              }
            : {
                source: "sessionAction",
                itemId: item.id,
                scope: live.scope,
                folderId: live.sessionContext.folderId,
                conversationId: live.sessionContext.conversationId,
                locale: live.locale,
              }

        void Promise.resolve()
          .then(() =>
            capturedTransport.call<unknown>("host_plugins_call", {
              pluginId: item.pluginId,
              method: action.method,
              input,
            })
          )
          .then((raw) => {
            const current = liveRef.current
            if (
              generation !== generationRef.current ||
              !current.enabled ||
              !current.transportReady ||
              current.transport !== capturedTransport ||
              current.fullScopeKey !== capturedFullScope ||
              !isCurrentReadyHostTransport(capturedTransport) ||
              !current.validItemKeys.has(item.key)
            ) {
              return
            }
            setBusy(capturedTransport, capturedFullScope, item.key, false)
            const validated = validateComposerActionResult(raw)
            if (validated.insertText && current.onInsertText) {
              current.onInsertText(validated.insertText, capturedSessionScope)
            }
            if (validated.notice) {
              toast.info(validated.notice)
            }
          })
          .catch((cause: unknown) => {
            const current = liveRef.current
            if (
              generation !== generationRef.current ||
              !current.enabled ||
              !current.transportReady ||
              current.transport !== capturedTransport ||
              current.fullScopeKey !== capturedFullScope ||
              !isCurrentReadyHostTransport(capturedTransport) ||
              !current.validItemKeys.has(item.key)
            ) {
              return
            }
            setBusy(capturedTransport, capturedFullScope, item.key, false)
            toast.error(t("composerActionFailed"), {
              description: toErrorMessage(cause),
            })
          })
      }
    },
    [setBusy, source, t]
  )

  const handleSurfaceInsert = useMemo<
    PluginComposerInsertHandler | undefined
  >(() => {
    if (!activeSurface || activeSurface.slot !== "composer" || !onInsertText) {
      return undefined
    }
    const expectedFullScope = fullScopeKey
    const expectedSessionScope = sessionScopeKey
    const expectedTransport = transport
    return (text: string) => {
      const live = liveRef.current
      if (
        !live.enabled ||
        live.fullScopeKey !== expectedFullScope ||
        live.transport !== expectedTransport ||
        !isCurrentReadyHostTransport(expectedTransport) ||
        !live.onInsertText
      ) {
        throw new Error("Plugin composer surface is no longer active")
      }
      const result = live.onInsertText(text, expectedSessionScope)
      return result ?? { inserted: true as const, length: text.length }
    }
  }, [activeSurface, fullScopeKey, onInsertText, sessionScopeKey, transport])

  const closeSurface = useCallback(() => setOpenSurface(null), [])

  return {
    plugins,
    transport,
    transportReady: hostScope.transportReady,
    activeSurface,
    closeSurface,
    handleSurfaceInsert,
    executeLeaf,
    isBusy,
  }
}

export interface PluginComposerPillsProps {
  sessionContext: HostPluginSessionContext
  scope?: ComposerRuntimeScope
  enabled?: boolean
  disabled?: boolean
  onComposerInsertText?: (
    text: string,
    expectedScopeKey: string
  ) => PluginComposerInsertResult
  className?: string
}

export const PluginComposerPills = memo(function PluginComposerPills({
  sessionContext,
  scope: scopeOverride,
  enabled = true,
  disabled = false,
  onComposerInsertText,
  className,
}: PluginComposerPillsProps) {
  const t = useTranslations("HostPlugins")
  const locale = useLocale()
  const scope = runtimeScopeOf(sessionContext, scopeOverride)
  const hostScope = usePluginHostScope()
  const { data: plugins, transport } = useHostPlugins(enabled)

  const pills = useMemo(
    () =>
      enabled && hostScope.transportReady && transport
        ? selectPluginComposerPills(plugins, scope, locale)
        : [],
    [enabled, hostScope.transportReady, locale, plugins, scope, transport]
  )

  const validItemKeys = useMemo(
    () => new Set(pills.map((pill) => pill.key)),
    [pills]
  )

  const executor = usePluginLeafExecutor({
    source: "composerPill",
    sessionContext,
    scope,
    enabled,
    validItemKeys,
    onInsertText: onComposerInsertText,
  })

  if (pills.length === 0) return null

  return (
    <div
      data-slot="plugin-composer-pills"
      aria-label={t("composerPills")}
      className={cn("flex min-w-0 shrink-0 items-center gap-0.5", className)}
    >
      {pills.map((pill) => {
        const displayLabel = pill.label ?? pill.title
        const busy = executor.isBusy(pill.key)

        if (pill.action.kind === "menu") {
          const menuItems = pill.action.items
          return (
            <DropdownMenu key={pill.key}>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  disabled={disabled || busy}
                  aria-label={pill.title}
                  title={pill.description ?? pill.title}
                  className="h-6 max-w-32 shrink-0 gap-1 px-1.5 text-xs text-muted-foreground hover:text-foreground"
                >
                  {busy ? (
                    <Loader2
                      className="size-3.5 shrink-0 animate-spin"
                      aria-hidden
                    />
                  ) : (
                    <Puzzle className="size-3.5 shrink-0" aria-hidden />
                  )}
                  <span className="min-w-0 truncate">{displayLabel}</span>
                  <ChevronDown
                    className="size-3 shrink-0 opacity-70"
                    aria-hidden
                  />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent side="top" align="start">
                {menuItems.map((menuItem) => (
                  <DropdownMenuItem
                    key={menuItem.id}
                    onSelect={() =>
                      executor.executeLeaf(pill, menuItem.action, menuItem.id)
                    }
                  >
                    <span className="truncate">{menuItem.title}</span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )
        }

        const leafAction = pill.action
        return (
          <Button
            key={pill.key}
            type="button"
            variant="ghost"
            size="xs"
            disabled={disabled || busy}
            aria-label={pill.title}
            title={pill.description ?? pill.title}
            onClick={() => executor.executeLeaf(pill, leafAction)}
            className="h-6 max-w-32 shrink-0 gap-1 px-1.5 text-xs text-muted-foreground hover:text-foreground"
          >
            {busy ? (
              <Loader2 className="size-3.5 shrink-0 animate-spin" aria-hidden />
            ) : (
              <Puzzle className="size-3.5 shrink-0" aria-hidden />
            )}
            <span className="min-w-0 truncate">{displayLabel}</span>
          </Button>
        )
      })}

      {executor.activeSurface && (
        <Dialog
          open
          onOpenChange={(nextOpen) => {
            if (!nextOpen) executor.closeSurface()
          }}
        >
          <DialogContent className="w-[calc(100vw-2rem)] max-w-xl gap-3 p-4 sm:p-5">
            <DialogHeader className="min-w-0 pr-6 text-left">
              <DialogTitle className="truncate text-sm font-semibold">
                {executor.activeSurface.title}
              </DialogTitle>
              <DialogDescription className="truncate text-xs text-muted-foreground">
                {executor.activeSurface.pluginName}
              </DialogDescription>
            </DialogHeader>
            <HostPluginSurface
              pluginId={executor.activeSurface.pluginId}
              title={executor.activeSurface.title}
              context={{
                type: "clientSurface",
                slot: executor.activeSurface.slot,
                id: executor.activeSurface.surfaceId,
                folderId: sessionContext.folderId,
                conversationId: sessionContext.conversationId,
                sessionKey: sessionContext.sessionKey,
              }}
              onComposerInsertText={executor.handleSurfaceInsert}
            />
          </DialogContent>
        </Dialog>
      )}
    </div>
  )
})

PluginComposerPills.displayName = "PluginComposerPills"

export interface PluginInputActivitiesStripProps {
  sessionContext: HostPluginSessionContext | null
  scope?: ComposerRuntimeScope
  enabled?: boolean
}

export const PluginInputActivitiesStrip = memo(
  function PluginInputActivitiesStrip({
    sessionContext,
    scope: scopeOverride,
    enabled = true,
  }: PluginInputActivitiesStripProps) {
    const locale = useLocale()
    const activeEnabled = enabled && Boolean(sessionContext)
    const scope = sessionContext
      ? runtimeScopeOf(sessionContext, scopeOverride)
      : "draft"
    const activities = usePluginInputActivities({
      scope,
      folderId: sessionContext?.folderId ?? null,
      conversationId: sessionContext?.conversationId ?? null,
      locale,
      enabled: activeEnabled,
    })

    if (activities.length === 0) return null

    return (
      <div data-slot="plugin-input-activities">
        {activities.map((activity) => (
          <ComposerDockStrip
            key={activity.key}
            tone={activity.tone}
            icon={activity.tone === "warning" ? AlertTriangle : Puzzle}
            title={activity.title}
            details={activity.detail ?? null}
            role={activity.tone === "warning" ? "status" : undefined}
          />
        ))}
      </div>
    )
  }
)

PluginInputActivitiesStrip.displayName = "PluginInputActivitiesStrip"

export interface PluginSessionActionsProps {
  sessionContext: HostPluginSessionContext
  tabId?: string
  scope?: ComposerRuntimeScope
  enabled?: boolean
}

export function usePluginSessionActions({
  sessionContext,
  tabId,
  scope: scopeOverride,
  enabled = true,
}: PluginSessionActionsProps) {
  const locale = useLocale()
  const scope = runtimeScopeOf(sessionContext, scopeOverride)
  const hostScope = usePluginHostScope()
  const { data: plugins, transport } = useHostPlugins(enabled)

  const actions = useMemo(
    () =>
      enabled && hostScope.transportReady && transport
        ? selectPluginSessionActions(plugins, scope, locale)
        : [],
    [enabled, hostScope.transportReady, locale, plugins, scope, transport]
  )

  const validItemKeys = useMemo(
    () => new Set(actions.map((action) => action.key)),
    [actions]
  )

  const handleInsertText = useCallback(
    (text: string) => {
      const targetTabId = tabId ?? sessionContext.sessionKey
      if (!targetTabId) return
      emitAppendTextToSession({ tabId: targetTabId, text })
    },
    [sessionContext.sessionKey, tabId]
  )

  const executor = usePluginLeafExecutor({
    source: "sessionAction",
    sessionContext,
    scope,
    enabled,
    validItemKeys,
    onInsertText: handleInsertText,
  })

  const menuItems =
    actions.length > 0 ? (
      <>
        <DropdownMenuSeparator />
        {actions.map((action) => (
          <DropdownMenuItem
            key={action.key}
            data-slot="plugin-session-action"
            disabled={executor.isBusy(action.key)}
            title={action.description ?? action.title}
            onSelect={() => executor.executeLeaf(action, action.action)}
          >
            <Puzzle className="h-4 w-4 shrink-0" aria-hidden />
            <span className="truncate">{action.title}</span>
          </DropdownMenuItem>
        ))}
      </>
    ) : null

  const surfaceDialog = executor.activeSurface ? (
    <Dialog
      open
      onOpenChange={(nextOpen) => {
        if (!nextOpen) executor.closeSurface()
      }}
    >
      <DialogContent className="w-[calc(100vw-2rem)] max-w-xl gap-3 p-4 sm:p-5">
        <DialogHeader className="min-w-0 pr-6 text-left">
          <DialogTitle className="truncate text-sm font-semibold">
            {executor.activeSurface.title}
          </DialogTitle>
          <DialogDescription className="truncate text-xs text-muted-foreground">
            {executor.activeSurface.pluginName}
          </DialogDescription>
        </DialogHeader>
        <HostPluginSurface
          pluginId={executor.activeSurface.pluginId}
          title={executor.activeSurface.title}
          context={{
            type: "clientSurface",
            slot: executor.activeSurface.slot,
            id: executor.activeSurface.surfaceId,
            folderId: sessionContext.folderId,
            conversationId: sessionContext.conversationId,
            sessionKey: sessionContext.sessionKey,
          }}
          onComposerInsertText={executor.handleSurfaceInsert}
        />
      </DialogContent>
    </Dialog>
  ) : null

  return { actions, menuItems, surfaceDialog }
}
