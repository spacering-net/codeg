"use client"

import { memo, useMemo } from "react"
import { Puzzle } from "lucide-react"
import { useLocale, useTranslations } from "next-intl"
import { HostPluginSurface } from "@/components/host-plugin-surface"
import {
  resolvePluginText,
  resolvePluginTimelineRenderer,
  useHostPlugins,
  usePluginTimelineItems,
} from "@/lib/host-plugins"
import { cn } from "@/lib/utils"

export interface PluginTimelineItemsProps {
  /** Persisted DB conversation ID; `null` for unsent drafts (renders nothing). */
  conversationId: number | null
  /** Disable subscriptions and unmount surfaces while the parent tab is offscreen. */
  enabled?: boolean
  className?: string
}

/**
 * Renders persisted plugin timeline items for a saved conversation.
 *
 * Isolation & lifecycle:
 * - Never queries or renders for unsent drafts (`conversationId == null`) or
 *   when no items exist (zero extra DOM).
 * - Waits for the ready host Transport (`?remoteConnectionId=N` boot-gated) and
 *   immediately unmounts iframes & drops stale rows when switching conversations,
 *   replacing the host Transport, or disabling/removing the owning plugin.
 * - Falls back to a concise placeholder when an enabled plugin still owns a
 *   stored item whose `(kind, version)` renderer was withdrawn.
 */
export const PluginTimelineItems = memo(function PluginTimelineItems({
  conversationId,
  enabled = true,
  className,
}: PluginTimelineItemsProps) {
  const t = useTranslations("HostPlugins")
  const locale = useLocale()
  const activeEnabled = enabled && conversationId != null
  const { data: plugins, transport: catalogTransport } =
    useHostPlugins(activeEnabled)
  const { data: items, transport: timelineTransport } = usePluginTimelineItems(
    conversationId,
    activeEnabled
  )

  const enabledPluginsById = useMemo(() => {
    const map = new Map<string, NonNullable<typeof plugins>[number]>()
    if (!plugins?.length) return map
    for (const plugin of plugins) {
      if (plugin.enabled && !map.has(plugin.manifest.id)) {
        map.set(plugin.manifest.id, plugin)
      }
    }
    return map
  }, [plugins])

  const visibleItems = useMemo(() => {
    if (
      !activeEnabled ||
      !catalogTransport ||
      !timelineTransport ||
      catalogTransport !== timelineTransport ||
      !plugins ||
      !items?.length
    ) {
      return []
    }
    return items.filter(
      (item) =>
        item.conversationId === conversationId &&
        enabledPluginsById.has(item.pluginId)
    )
  }, [
    activeEnabled,
    catalogTransport,
    conversationId,
    enabledPluginsById,
    items,
    plugins,
    timelineTransport,
  ])

  if (visibleItems.length === 0) return null

  return (
    <div
      data-slot="plugin-timeline-items"
      aria-label={t("timelineItems")}
      className={cn("mx-auto chat-content-w space-y-3 px-4 pb-4", className)}
    >
      {visibleItems.map((item) => {
        const plugin = enabledPluginsById.get(item.pluginId)
        const pluginName = plugin
          ? resolvePluginText(
              plugin.manifest.name,
              plugin.manifest.nameTranslations,
              locale
            ).trim() || item.pluginId
          : item.pluginId
        const renderer = resolvePluginTimelineRenderer(
          plugins,
          item.pluginId,
          item.kind,
          item.version,
          locale
        )
        const itemKey = `${item.pluginId}:${item.id}`

        if (!renderer) {
          return (
            <section
              key={itemKey}
              data-slot="plugin-timeline-item-unavailable"
              data-plugin-id={item.pluginId}
              data-item-id={item.id}
              className="overflow-hidden rounded-lg border border-border/70 bg-card text-card-foreground"
            >
              <header className="flex min-w-0 flex-wrap items-center justify-between gap-x-2 gap-y-1 border-b border-border/60 bg-muted/30 px-3 py-1.5">
                <div className="flex min-w-0 items-center gap-1.5">
                  <Puzzle
                    className="size-3.5 shrink-0 text-muted-foreground"
                    aria-hidden
                  />
                  <span className="truncate font-mono text-xs font-medium text-muted-foreground">
                    {item.kind} v{item.version}
                  </span>
                </div>
                <span className="max-w-40 truncate rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
                  {pluginName}
                </span>
              </header>
              <p className="px-3 py-2.5 text-xs text-muted-foreground">
                {t("timelineRendererUnavailable")}
              </p>
            </section>
          )
        }

        return (
          <section
            key={itemKey}
            data-slot="plugin-timeline-item"
            data-plugin-id={item.pluginId}
            data-item-id={item.id}
            className="overflow-hidden rounded-lg border border-border/70 bg-card text-card-foreground"
          >
            <header className="flex min-w-0 flex-wrap items-center justify-between gap-x-2 gap-y-1 border-b border-border/60 bg-muted/30 px-3 py-1.5">
              <div className="flex min-w-0 items-center gap-1.5">
                <Puzzle
                  className="size-3.5 shrink-0 text-muted-foreground"
                  aria-hidden
                />
                <span className="truncate text-xs font-medium">
                  {renderer.title}
                </span>
              </div>
              <span className="max-w-40 truncate rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
                {renderer.pluginName}
              </span>
            </header>
            <HostPluginSurface
              pluginId={item.pluginId}
              title={renderer.title}
              context={{
                type: "timelineItem",
                kind: item.kind,
                version: item.version,
                itemId: item.id,
                conversationId: item.conversationId,
                data: item.data,
                updatedAt: item.updatedAt,
              }}
              className="h-44 rounded-none border-0"
            />
          </section>
        )
      })}
    </div>
  )
})

PluginTimelineItems.displayName = "PluginTimelineItems"
