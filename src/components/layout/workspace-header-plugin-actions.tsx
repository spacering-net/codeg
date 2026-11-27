"use client"

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react"
import { AppWindow, ChevronDown, Loader2, Puzzle, Zap } from "lucide-react"
import { useLocale, useTranslations } from "next-intl"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { useActiveFolder } from "@/contexts/active-folder-context"
import { useOptionalAuxPanelContext } from "@/contexts/aux-panel-context"
import { useOptionalWorkbenchRoute } from "@/contexts/workbench-route-context"
import { useIsActiveChatMode } from "@/hooks/use-is-active-chat-mode"
import { useIsMobile } from "@/hooks/use-mobile"
import { toErrorMessage } from "@/lib/app-error"
import {
  formatPluginHeaderActionResult,
  isCurrentReadyHostTransport,
  pluginPanelKey,
  selectPluginHeaderActions,
  useHostPlugins,
  usePluginHostScope,
  type ResolvedPluginHeaderAction,
} from "@/lib/host-plugins"
import { cn } from "@/lib/utils"

const MAX_DESKTOP_INLINE = 2
const MAX_ERROR_DESCRIPTION_CHARS = 240
const useIsomorphicLayoutEffect =
  typeof window !== "undefined" ? useLayoutEffect : useEffect

let rightChromeExtraWidth = 0
const extraWidthListeners = new Set<() => void>()

function emitRightChromeExtraWidth(): void {
  for (const listener of [...extraWidthListeners]) listener()
}

function setRightChromeExtraWidth(next: number): void {
  const normalized = Number.isFinite(next) && next > 0 ? Math.ceil(next) : 0
  if (rightChromeExtraWidth === normalized) return
  rightChromeExtraWidth = normalized
  emitRightChromeExtraWidth()
}

function subscribeRightChromeExtraWidth(listener: () => void): () => void {
  extraWidthListeners.add(listener)
  return () => {
    extraWidthListeners.delete(listener)
  }
}

function getRightChromeExtraWidthSnapshot(): number {
  return rightChromeExtraWidth
}

function getRightChromeExtraWidthServerSnapshot(): number {
  return 0
}

/**
 * Extra width (px) occupied by desktop plugin header actions inside
 * `RightEdgeChrome`, so right-edge `ChromeReserve` strips expand in lockstep
 * and tabs/titles never slide underneath plugin controls. Returns `0` when no
 * plugin header actions are mounted.
 */
export function useRightChromeExtraWidth(): number {
  return useSyncExternalStore(
    subscribeRightChromeExtraWidth,
    getRightChromeExtraWidthSnapshot,
    getRightChromeExtraWidthServerSnapshot
  )
}

/** Tests only. */
export function resetRightChromeExtraWidthForTests(): void {
  setRightChromeExtraWidth(0)
}

function truncateErrorDescription(message: string): string {
  const trimmed = message.trim()
  if (trimmed.length <= MAX_ERROR_DESCRIPTION_CHARS) return trimmed
  return `${trimmed.slice(0, MAX_ERROR_DESCRIPTION_CHARS - 1)}…`
}

function ActionIcon({
  action,
  pending,
  className,
}: {
  action: ResolvedPluginHeaderAction
  pending: boolean
  className?: string
}) {
  if (pending) {
    return (
      <Loader2
        className={cn("h-3.5 w-3.5 shrink-0 animate-spin", className)}
        aria-hidden
      />
    )
  }
  switch (action.action.type) {
    case "openWorkspacePanel":
      return (
        <Puzzle className={cn("h-3.5 w-3.5 shrink-0", className)} aria-hidden />
      )
    case "openScreen":
      return (
        <AppWindow
          className={cn("h-3.5 w-3.5 shrink-0", className)}
          aria-hidden
        />
      )
    case "callMethod":
      return (
        <Zap className={cn("h-3.5 w-3.5 shrink-0", className)} aria-hidden />
      )
  }
}

export interface WorkspaceHeaderPluginActionsProps {
  /**
   * Compact mode for narrow/mobile headers (`FolderTitleBar`): collapses ALL
   * plugin header actions into a single overflow menu button so existing header
   * buttons are never squeezed.
   */
  compact?: boolean
  className?: string
}

/**
 * Renders enabled plugins' `contributes.headerActions` in the active workspace
 * header (`RightEdgeChrome` on desktop, `FolderTitleBar` on mobile/narrow).
 *
 * Isolation & withdrawal:
 * - Mounted only when a real workspace folder is active (`folderId != null` and
 *   not in folderless chat mode) and the host transport is ready for the window
 *   scope (never queries local transport while `?remoteConnectionId=N` is
 *   booting).
 * - Renders `null` when no valid actions exist (zero DOM change).
 * - Desktop shows up to 2 compact inline actions before native buttons and
 *   folds extras into an overflow menu; mobile/narrow folds all actions into
 *   the overflow menu.
 * - `callMethod` captures the ready transport, folder, host scope, and a
 *   monotonic generation so stale responses after workspace switch, plugin
 *   withdrawal/disable, or Transport replacement are silently dropped.
 */
export function WorkspaceHeaderPluginActions({
  compact = false,
  className,
}: WorkspaceHeaderPluginActionsProps) {
  const t = useTranslations("HostPlugins")
  const locale = useLocale()
  const isMobile = useIsMobile()
  const { activeFolderId } = useActiveFolder()
  const isChatMode = useIsActiveChatMode()
  const hostScope = usePluginHostScope()
  const auxPanel = useOptionalAuxPanelContext()
  const workbenchRoute = useOptionalWorkbenchRoute()

  const effectiveFolderId =
    activeFolderId != null && !isChatMode ? activeFolderId : null
  const enabled = effectiveFolderId != null
  const { data: plugins, transport } = useHostPlugins(enabled)

  const actions = useMemo(() => {
    if (!enabled || !transport) return []
    return selectPluginHeaderActions(plugins, locale)
  }, [enabled, locale, plugins, transport])

  const [pendingKeys, setPendingKeys] = useState<ReadonlySet<string>>(
    () => new Set()
  )

  const containerRef = useRef<HTMLDivElement>(null)
  const generationRef = useRef(0)
  const mountedRef = useRef(true)
  const liveStateRef = useRef({
    folderId: effectiveFolderId,
    scopeKey: hostScope.scopeKey,
    transport,
    actions,
    generation: 0,
  })

  // Bump generation whenever the active workspace, host scope, or transport
  // object identity changes so any in-flight `callMethod` response is dropped.
  useIsomorphicLayoutEffect(() => {
    generationRef.current += 1
    liveStateRef.current = {
      folderId: effectiveFolderId,
      scopeKey: hostScope.scopeKey,
      transport,
      actions,
      generation: generationRef.current,
    }
    setPendingKeys((prev) => (prev.size > 0 ? new Set() : prev))
  }, [effectiveFolderId, hostScope.scopeKey, transport])

  // Keep live actions catalog up-to-date without resetting generation on
  // unrelated catalog refreshes (e.g. another plugin changing).
  useIsomorphicLayoutEffect(() => {
    liveStateRef.current.actions = actions
  }, [actions])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      generationRef.current += 1
      if (!compact) {
        setRightChromeExtraWidth(0)
      }
    }
  }, [compact])

  const collapseAll = compact || isMobile
  const hasActions = actions.length > 0

  useEffect(() => {
    if (collapseAll) return
    if (!hasActions) {
      setRightChromeExtraWidth(0)
      return
    }
    const el = containerRef.current
    if (!el) return
    const publish = () => {
      const width = el.getBoundingClientRect().width
      // Include the 4px (`gap-1`) gap between plugin actions and native chrome buttons.
      setRightChromeExtraWidth(width > 0 ? Math.ceil(width) + 4 : 0)
    }
    publish()
    if (typeof ResizeObserver === "undefined") {
      return () => setRightChromeExtraWidth(0)
    }
    const observer = new ResizeObserver(publish)
    observer.observe(el)
    return () => {
      observer.disconnect()
      setRightChromeExtraWidth(0)
    }
  }, [collapseAll, hasActions, actions])

  const handleAction = useCallback(
    (action: ResolvedPluginHeaderAction) => {
      if (action.action.type === "openWorkspacePanel") {
        workbenchRoute?.openConversations()
        auxPanel?.openPluginPanel(
          pluginPanelKey(action.pluginId, action.action.panelId)
        )
        return
      }
      if (action.action.type === "openScreen") {
        workbenchRoute?.openPluginScreen({
          pluginId: action.pluginId,
          screenId: action.action.screenId,
        })
        return
      }

      // callMethod
      const folderId = effectiveFolderId
      const activeTransport = transport
      if (
        folderId == null ||
        !activeTransport ||
        !isCurrentReadyHostTransport(activeTransport)
      ) {
        return
      }

      const method = action.action.method
      const capturedGeneration = generationRef.current
      const capturedScopeKey = hostScope.scopeKey

      setPendingKeys((prev) => {
        if (prev.has(action.key)) return prev
        const next = new Set(prev)
        next.add(action.key)
        return next
      })

      const isStillValid = () => {
        const live = liveStateRef.current
        return (
          mountedRef.current &&
          live.generation === capturedGeneration &&
          live.folderId === folderId &&
          live.scopeKey === capturedScopeKey &&
          live.transport === activeTransport &&
          isCurrentReadyHostTransport(activeTransport) &&
          live.actions.some(
            (candidate) =>
              candidate.key === action.key &&
              candidate.action.type === "callMethod" &&
              candidate.action.method === method
          )
        )
      }

      void activeTransport
        .call<unknown>("host_plugins_call", {
          pluginId: action.pluginId,
          method,
          input: { folderId },
        })
        .then(
          (result) => {
            if (!isStillValid()) return
            const feedback = formatPluginHeaderActionResult(result)
            if (feedback) {
              toast.success(action.title, { description: feedback })
            } else {
              toast.success(t("headerActionDone", { title: action.title }))
            }
          },
          (error: unknown) => {
            if (!isStillValid()) return
            toast.error(t("headerActionFailed", { title: action.title }), {
              description: truncateErrorDescription(toErrorMessage(error)),
            })
          }
        )
        .finally(() => {
          if (!mountedRef.current) return
          if (liveStateRef.current.generation !== capturedGeneration) return
          setPendingKeys((prev) => {
            if (!prev.has(action.key)) return prev
            const next = new Set(prev)
            next.delete(action.key)
            return next
          })
        })
    },
    [
      auxPanel,
      effectiveFolderId,
      hostScope.scopeKey,
      t,
      transport,
      workbenchRoute,
    ]
  )

  if (!hasActions) return null

  const inlineActions = collapseAll ? [] : actions.slice(0, MAX_DESKTOP_INLINE)
  const overflowActions = collapseAll
    ? actions
    : actions.slice(MAX_DESKTOP_INLINE)

  return (
    <div
      ref={containerRef}
      data-slot="workspace-header-plugin-actions"
      className={cn("flex shrink-0 items-center gap-1", className)}
    >
      {inlineActions.map((action) => {
        const isPending = pendingKeys.has(action.key)
        if (action.label) {
          return (
            <Button
              key={action.key}
              type="button"
              variant="ghost"
              size="xs"
              disabled={isPending}
              aria-label={action.title}
              title={action.title}
              onClick={() => handleAction(action)}
              className="h-6 max-w-28 shrink-0 gap-1 rounded-full px-2 text-xs text-muted-foreground hover:bg-foreground/10 hover:text-foreground dark:hover:bg-foreground/10"
            >
              <ActionIcon action={action} pending={isPending} />
              <span className="min-w-0 truncate">{action.label}</span>
            </Button>
          )
        }
        return (
          <Button
            key={action.key}
            type="button"
            variant="ghost"
            size="icon"
            disabled={isPending}
            aria-label={action.title}
            title={action.title}
            onClick={() => handleAction(action)}
            className="h-6 w-6 shrink-0 text-muted-foreground hover:bg-foreground/10 hover:text-foreground dark:hover:bg-foreground/10"
          >
            <ActionIcon action={action} pending={isPending} />
          </Button>
        )
      })}

      {overflowActions.length > 0 && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size={collapseAll ? "icon" : "xs"}
              aria-label={
                collapseAll ? t("headerActions") : t("moreHeaderActions")
              }
              title={collapseAll ? t("headerActions") : t("moreHeaderActions")}
              className={cn(
                "shrink-0 text-muted-foreground hover:bg-foreground/10 hover:text-foreground dark:hover:bg-foreground/10",
                collapseAll
                  ? compact
                    ? "h-8 w-8"
                    : "h-6 w-6"
                  : "h-6 gap-0.5 px-1.5 text-xs"
              )}
            >
              <Puzzle
                className={cn(
                  "shrink-0",
                  collapseAll && compact ? "h-4 w-4" : "h-3.5 w-3.5"
                )}
                aria-hidden
              />
              {!collapseAll && (
                <>
                  <span className="tabular-nums">
                    +{overflowActions.length}
                  </span>
                  <ChevronDown className="h-3 w-3 shrink-0" aria-hidden />
                </>
              )}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            className="min-w-48 max-w-[min(18rem,calc(100vw-1rem))]"
          >
            {overflowActions.map((action) => {
              const isPending = pendingKeys.has(action.key)
              return (
                <DropdownMenuItem
                  key={action.key}
                  disabled={isPending}
                  onSelect={() => handleAction(action)}
                  className="flex items-center gap-2"
                >
                  <ActionIcon
                    action={action}
                    pending={isPending}
                    className="text-muted-foreground"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm">{action.title}</div>
                    <div className="truncate text-xs text-muted-foreground">
                      {action.pluginName}
                    </div>
                  </div>
                </DropdownMenuItem>
              )
            })}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  )
}
