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
import { ChevronDown, Puzzle } from "lucide-react"
import { useTranslations } from "next-intl"
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
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { useIsMobile } from "@/hooks/use-mobile"
import {
  hostPluginSessionScopeKey,
  selectPluginClientSurfaces,
  useHostPlugins,
  type HostPluginSessionContext,
  type PluginClientSurfaceSlot,
  type PluginComposerInsertResult,
  type ResolvedPluginClientSurface,
} from "@/lib/host-plugins"
import { getTransport, type Transport } from "@/lib/transport"
import { cn } from "@/lib/utils"

const MAX_DESKTOP_INLINE = 2
const useIsomorphicLayoutEffect =
  typeof window !== "undefined" ? useLayoutEffect : useEffect

export interface HostPluginSlotProps {
  slot: PluginClientSurfaceSlot
  sessionContext: HostPluginSessionContext
  /** Disable catalog subscription while the parent view is offscreen. */
  enabled?: boolean
  /** Controlled draft text insertion callback; honored only when `slot === "composer"`. */
  onComposerInsertText?: (
    text: string,
    expectedScopeKey: string
  ) => PluginComposerInsertResult
  className?: string
}

/**
 * Renders plugin-declared client surface triggers for a host UI slot
 * (`sessionHeader` or `composer`) and opens the selected contribution in a
 * Codeg dialog hosting `HostPluginSurface`.
 *
 * Isolation & withdrawal:
 * - Only enabled plugins declaring `client.entry` and a matching slot surface
 *   are rendered.
 * - Opening state is bound to `scopeKey` (`folderId` + `conversationId` +
 *   `sessionKey`), so switching workspaces or sessions withdraws any open
 *   surface immediately and mounts a fresh isolated frame when opened again.
 * - Disabling or removing a plugin withdraws both its triggers and any open
 *   surface on the next catalog update.
 */
export const HostPluginSlot = memo(function HostPluginSlot({
  slot,
  sessionContext,
  enabled = true,
  onComposerInsertText,
  className,
}: HostPluginSlotProps) {
  const t = useTranslations("HostPlugins")
  const isMobile = useIsMobile()
  const { data, transport } = useHostPlugins(enabled)

  const surfaces = useMemo(
    () => (enabled ? selectPluginClientSurfaces(data, slot) : []),
    [data, enabled, slot]
  )
  const scopeKey = hostPluginSessionScopeKey(sessionContext)
  const [opened, setOpened] = useState<{
    surfaceKey: string
    scopeKey: string
    transport: Transport | null
  } | null>(null)

  const activeSurface = useMemo(
    () =>
      enabled &&
      opened &&
      opened.scopeKey === scopeKey &&
      opened.transport === transport
        ? (surfaces.find((surface) => surface.key === opened.surfaceKey) ??
          null)
        : null,
    [enabled, opened, scopeKey, surfaces, transport]
  )
  // Permanently clear open state on withdrawal (session/workspace/host switch,
  // offscreen tab, or plugin disable/removal) so the dialog never resurrects
  // when the tab returns or the plugin is re-enabled later.
  if (opened !== null && !activeSurface) {
    setOpened(null)
  }

  const liveGuardRef = useRef({
    enabled,
    scopeKey,
    transport,
    activeSurfaceKey: activeSurface?.key ?? null,
    onComposerInsertText,
  })
  useIsomorphicLayoutEffect(() => {
    liveGuardRef.current = {
      enabled,
      scopeKey,
      transport,
      activeSurfaceKey: activeSurface?.key ?? null,
      onComposerInsertText,
    }
  }, [enabled, scopeKey, transport, activeSurface?.key, onComposerInsertText])

  const activeSurfaceKey = activeSurface?.key ?? null
  const handleSurfaceComposerInsert = useMemo<
    PluginComposerInsertHandler | undefined
  >(() => {
    if (slot !== "composer" || !activeSurfaceKey || !onComposerInsertText) {
      return undefined
    }
    const expectedSurfaceKey = activeSurfaceKey
    const expectedScopeKey = scopeKey
    const expectedTransport = transport
    return (text: string) => {
      const live = liveGuardRef.current
      if (
        !live.enabled ||
        live.scopeKey !== expectedScopeKey ||
        live.transport !== expectedTransport ||
        (typeof window !== "undefined" &&
          getTransport() !== expectedTransport) ||
        live.activeSurfaceKey !== expectedSurfaceKey ||
        !live.onComposerInsertText
      ) {
        throw new Error("Plugin composer surface is no longer active")
      }
      return live.onComposerInsertText(text, expectedScopeKey)
    }
  }, [slot, activeSurfaceKey, onComposerInsertText, scopeKey, transport])

  const handleOpen = useCallback(
    (surface: ResolvedPluginClientSurface) => {
      setOpened({ surfaceKey: surface.key, scopeKey, transport })
    },
    [scopeKey, transport]
  )

  const handleDialogOpenChange = useCallback((nextOpen: boolean) => {
    if (!nextOpen) setOpened(null)
  }, [])

  if (surfaces.length === 0) return null

  const isHeader = slot === "sessionHeader"
  const compactMenu = isMobile && surfaces.length > 1
  const inlineSurfaces = compactMenu
    ? []
    : isMobile
      ? surfaces.slice(0, 1)
      : surfaces.slice(0, MAX_DESKTOP_INLINE)
  const overflowSurfaces = compactMenu
    ? surfaces
    : isMobile
      ? []
      : surfaces.slice(MAX_DESKTOP_INLINE)

  return (
    <div
      data-slot={`host-plugin-slot-${slot}`}
      className={cn(
        "flex min-w-0 shrink-0 items-center",
        isHeader ? "gap-1" : "gap-0.5",
        className
      )}
    >
      {inlineSurfaces.map((surface) => {
        const isActive = activeSurface?.key === surface.key
        return (
          <Button
            key={surface.key}
            type="button"
            variant="ghost"
            size={isMobile ? (isHeader ? "icon-sm" : "icon-xs") : "xs"}
            aria-label={surface.title}
            aria-haspopup="dialog"
            aria-expanded={isActive}
            title={surface.title}
            onClick={() => handleOpen(surface)}
            className={cn(
              "shrink-0 text-muted-foreground hover:text-foreground",
              isActive && "bg-accent text-accent-foreground",
              isMobile
                ? isHeader
                  ? "h-7 w-7 rounded"
                  : "size-6"
                : isHeader
                  ? "h-7 max-w-32 gap-1 px-2 text-xs"
                  : "h-6 max-w-28 gap-1 px-1.5 text-xs"
            )}
          >
            <Puzzle
              className={cn(
                "shrink-0",
                isHeader && isMobile ? "size-4" : "size-3.5"
              )}
              aria-hidden
            />
            {!isMobile && (
              <span
                data-slot="host-plugin-trigger-label"
                className={cn(
                  "min-w-0 truncate",
                  isHeader ? "@max-[28rem]:sr-only" : "@max-[22rem]:hidden"
                )}
              >
                {surface.title}
              </span>
            )}
          </Button>
        )
      })}

      {overflowSurfaces.length > 0 && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size={compactMenu ? (isHeader ? "icon-sm" : "icon-xs") : "xs"}
              aria-label={
                compactMenu ? t("pluginSurfaces") : t("morePluginSurfaces")
              }
              title={
                compactMenu ? t("pluginSurfaces") : t("morePluginSurfaces")
              }
              className={cn(
                "shrink-0 text-muted-foreground hover:text-foreground",
                compactMenu
                  ? isHeader
                    ? "h-7 w-7 rounded"
                    : "size-6"
                  : isHeader
                    ? "h-7 gap-0.5 px-1.5 text-xs"
                    : "h-6 gap-0.5 px-1.5 text-xs"
              )}
            >
              <Puzzle
                className={cn(
                  "shrink-0",
                  isHeader && compactMenu ? "size-4" : "size-3.5"
                )}
                aria-hidden
              />
              {!compactMenu && (
                <>
                  <span className="tabular-nums">
                    +{overflowSurfaces.length}
                  </span>
                  <ChevronDown className="size-3 shrink-0" aria-hidden />
                </>
              )}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align={isHeader ? "end" : "start"}
            side={isHeader ? "bottom" : "top"}
            className="min-w-44 max-w-[min(18rem,calc(100vw-1rem))]"
          >
            {overflowSurfaces.map((surface) => (
              <DropdownMenuItem
                key={surface.key}
                onSelect={() => handleOpen(surface)}
                className="flex items-center gap-2"
              >
                <Puzzle
                  className="size-3.5 shrink-0 text-muted-foreground"
                  aria-hidden
                />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm">{surface.title}</div>
                  <div className="truncate text-xs text-muted-foreground">
                    {surface.pluginName}
                  </div>
                </div>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}

      {activeSurface && (
        <Dialog open onOpenChange={handleDialogOpenChange}>
          <DialogContent
            className="max-w-2xl gap-3 p-4 sm:gap-4 sm:p-6"
            onKeyDown={(event) => event.stopPropagation()}
          >
            <DialogHeader>
              <DialogTitle className="break-words">
                {activeSurface.title}
              </DialogTitle>
              <DialogDescription className="break-words text-xs">
                {activeSurface.pluginName}
              </DialogDescription>
            </DialogHeader>
            <HostPluginSurface
              key={`${activeSurface.key}:${scopeKey}`}
              pluginId={activeSurface.pluginId}
              title={activeSurface.title}
              className="h-[min(24rem,60dvh)] sm:h-96"
              context={{
                type: "clientSurface",
                slot,
                id: activeSurface.id,
                ...sessionContext,
              }}
              onComposerInsertText={handleSurfaceComposerInsert}
            />
          </DialogContent>
        </Dialog>
      )}
    </div>
  )
})
