"use client"

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react"
import {
  parsePluginThemePalette,
  type PluginThemePalette,
} from "@/lib/custom-style"
import * as transportModule from "@/lib/transport"
import { getTransport, type Transport } from "@/lib/transport"

export type PluginTextTranslations = Record<string, string>

export const MAX_PLUGIN_SCREENS = 16
export const MAX_PLUGIN_SIDEBAR_ITEMS = 16
export const MAX_PLUGIN_TIMELINE_RENDERERS = 16
export const MAX_PLUGIN_TIMELINE_TRANSFORMERS = 16
export const MAX_TIMELINE_TRANSFORM_REPLACEMENTS = 4
export const MAX_TIMELINE_TRANSFORM_TOOL_NAMES = 16
export const MAX_TIMELINE_TRANSFORM_TOOL_NAME_BYTES = 128
export const MAX_TIMELINE_TRANSFORM_ITEM_BYTES = 64 * 1024

export type PluginSidebarItemPlacement = "header" | "footer"

export type TimelineSourceType = "tool_call" | "assistant_message"

export type TimelineTransformPhase = "streaming" | "complete"

export type TimelineTransformer = {
  id: string
  rendererKind: string
  rendererVersion: number
  method: string
} & (
  | {
      itemType: "tool_call"
      toolNames?: string[]
    }
  | {
      itemType: "assistant_message"
      toolNames?: never
    }
)

export interface ResolvedPluginTimelineTransformer {
  key: string
  pluginId: string
  pluginName: string
  id: string
  itemType: TimelineSourceType
  toolNames?: string[]
  rendererKind: string
  rendererVersion: number
  rendererTitle: string
  method: string
}

export interface TimelineSourceItem {
  id: string
  toolName?: string
  status?: string
  rawInput?: unknown
  rawOutput?: unknown
  text?: string
}

export interface TimelineTransformRequest {
  pluginId: string
  transformerId: string
  itemType: TimelineSourceType
  phase: TimelineTransformPhase
  conversationId?: number | null
  locale?: string
  item: TimelineSourceItem
}

export interface TimelineReplacement {
  id?: string
  kind: string
  version: number
  data: unknown
}

export type TimelineTransformResult =
  | { action: "keep" }
  | { action: "omit" }
  | { action: "replace"; items: TimelineReplacement[] }

export type PluginTimelineTransformOutcome =
  | { action: "keep" }
  | {
      action: "omit"
      pluginId: string
      transformerId: string
    }
  | {
      action: "replace"
      pluginId: string
      pluginName: string
      transformerId: string
      rendererKind: string
      rendererVersion: number
      rendererTitle: string
      items: TimelineReplacement[]
    }

export interface PluginTimelineRendererContribution {
  kind: string
  version: number
  title: string
  titleTranslations?: PluginTextTranslations
  dataSchema?: boolean | Record<string, unknown>
}

export interface ResolvedPluginTimelineRenderer {
  key: string
  pluginId: string
  pluginName: string
  kind: string
  version: number
  title: string
}

export interface PluginTimelineItem {
  id: string
  pluginId: string
  conversationId: number
  kind: string
  version: number
  data: unknown
  updatedAt: string
}

export type PluginTimelineEvent =
  | { conversationId: number; pluginId: string; item: PluginTimelineItem }
  | { conversationId: null; pluginId: string; item: null }

export interface PluginThemeContribution {
  id: string
  title: string
  titleTranslations?: PluginTextTranslations
  light?: PluginThemePalette
  dark?: PluginThemePalette
}

export interface ResolvedPluginTheme {
  key: string
  pluginId: string
  pluginName: string
  id: string
  title: string
  light?: PluginThemePalette
  dark?: PluginThemePalette
}

export interface PluginScreenContribution {
  id: string
  title: string
  titleTranslations?: PluginTextTranslations
}

export interface PluginSidebarItemContribution {
  id: string
  title: string
  titleTranslations?: PluginTextTranslations
  placement: PluginSidebarItemPlacement
  screenId: string
}

export interface ResolvedPluginScreen {
  key: string
  pluginId: string
  pluginName: string
  id: string
  title: string
}

export interface ResolvedPluginSidebarItem {
  key: string
  pluginId: string
  pluginName: string
  id: string
  title: string
  placement: PluginSidebarItemPlacement
  screenId: string
  screenKey: string
  screenTitle: string
}

export interface PluginHostScope {
  /** Storage/host scope identifying the connected host (e.g. "local" or "remote:5"). */
  scopeKey: string
  /** True only when the active transport matches the window's target host. */
  transportReady: boolean
}

type WorkspacePanel = {
  id: string
  title: string
  titleTranslations?: PluginTextTranslations
} & (
  | { view: "turnActivity" }
  | {
      view: "text"
      text: string
      textTranslations?: PluginTextTranslations
    }
  | { view: "serverText"; method: string }
  | { view: "client" }
)

export type PluginClientSurfaceSlot = "sessionHeader" | "composer"

export interface PluginClientSurfaceContribution {
  id: string
  title: string
  titleTranslations?: PluginTextTranslations
  slot: PluginClientSurfaceSlot
}

export interface PluginHostSurfaceContribution {
  id: string
  title: string
  titleTranslations?: PluginTextTranslations
}

export interface ResolvedPluginHostSurface {
  id: string
  title: string
}

export type PluginSettingsSurfaceType =
  | "settingsPanel"
  | "pluginDetail"
  | "activationPanel"

export interface ResolvedPluginClientSurface {
  key: string
  pluginId: string
  pluginName: string
  id: string
  title: string
  slot: PluginClientSurfaceSlot
}

export interface HostPluginSessionContext {
  /** Workspace folder ID; `null` for folderless chat sessions/drafts. */
  folderId: number | null
  /** Persisted DB conversation ID when saved; `null` for unsent drafts. */
  conversationId: number | null
  /** Stable UI session identifier (e.g. tab ID or canvas context key) used to
   *  isolate drafts and sibling sessions. */
  sessionKey: string
}

export const MAX_PLUGIN_COMPOSER_INSERT_BYTES = 16 * 1024

export interface PluginComposerInsertResult {
  inserted: true
  length: number
}

export interface InstalledPlugin {
  enabled: boolean
  source?:
    | { type: "directory"; path: string }
    | { type: "gitHub"; repository: string; commit: string; directory?: string }
    | {
        type: "npm"
        package: string
        version: string
        registry?: "npm" | "mirror"
      }
  manifest: {
    id: string
    name: string
    nameTranslations?: PluginTextTranslations
    version: string
    server?: { entry: string; methods: string[] }
    client?: { entry: string }
    contributes: {
      workspacePanels: WorkspacePanel[]
      commands: {
        id: string
        title: string
        titleTranslations?: PluginTextTranslations
        action: { type: "openWorkspacePanel"; panelId: string }
      }[]
      hooks: { event: "session.turnCompleted"; action: "recordTurnActivity" }[]
      settingsPanel?: PluginHostSurfaceContribution
      pluginDetail?: PluginHostSurfaceContribution
      activationPanel?: PluginHostSurfaceContribution
      clientSurfaces?: PluginClientSurfaceContribution[]
      themes?: PluginThemeContribution[]
      screens?: PluginScreenContribution[]
      sidebarItems?: PluginSidebarItemContribution[]
      timelineRenderers?: PluginTimelineRendererContribution[]
      timelineTransformers?: TimelineTransformer[]
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

export interface PluginIndex {
  apiVersion: number
  plugins: PluginIndexEntry[]
}

export interface PluginIndexEntry {
  id: string
  name: string
  description: string
  versions: PluginIndexVersion[]
}

export interface PluginIndexVersion {
  version: string
  source: string
  registry: "npm" | "mirror"
}

const CATALOG_CHANGED = "host-plugins://changed"
const ACTIVITY_CHANGED = "host-plugins://activity"
const TIMELINE_CHANGED = "host-plugins://timeline"

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
      if (typeof transport.call !== "function") return
      const request = ++latest
      void Promise.resolve()
        .then(() => load(transport))
        .then(
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
    if (typeof transport.subscribe === "function") {
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
    }
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

function safeGetTransport(): Transport | null {
  if (typeof window === "undefined") return null
  try {
    return getTransport()
  } catch {
    return null
  }
}

function readActiveRemoteConnectionId(): number | null {
  try {
    const getter = (
      transportModule as {
        getActiveRemoteConnectionId?: () => number | null
      }
    ).getActiveRemoteConnectionId
    return typeof getter === "function" ? getter() : null
  } catch {
    return null
  }
}

export function subscribeHostTransportChange(
  onStoreChange: () => void
): () => void {
  let unsub = () => {}
  try {
    const subscribe = (
      transportModule as {
        subscribeTransportChange?: (listener: () => void) => () => void
      }
    ).subscribeTransportChange
    if (typeof subscribe === "function") {
      unsub = subscribe(onStoreChange)
    }
  } catch {
    // Partial mock in unit tests without subscribeTransportChange.
  }
  if (typeof window !== "undefined") {
    window.addEventListener("popstate", onStoreChange)
  }
  return () => {
    unsub()
    if (typeof window !== "undefined") {
      window.removeEventListener("popstate", onStoreChange)
    }
  }
}

function getHostScopeSnapshot(): string {
  if (typeof window === "undefined") return "::local"
  return `${window.location.search}::${readActiveRemoteConnectionId() ?? "local"}`
}

function getHostScopeServerSnapshot(): string {
  return "::local"
}

export function usePluginHostScope(): PluginHostScope {
  useSyncExternalStore(
    subscribeHostTransportChange,
    getHostScopeSnapshot,
    getHostScopeServerSnapshot
  )
  return resolvePluginHostScope(
    typeof window !== "undefined" ? window.location.search : "",
    readActiveRemoteConnectionId()
  )
}

function getReadyHostTransportSnapshot(): Transport | null {
  if (typeof window === "undefined") return null
  const scope = resolvePluginHostScope(
    window.location.search,
    readActiveRemoteConnectionId()
  )
  if (!scope.transportReady) return null
  return safeGetTransport()
}

export function isCurrentReadyHostTransport(
  transport: Transport | null
): boolean {
  if (!transport) return false
  return getReadyHostTransportSnapshot() === transport
}

function getNullTransportSnapshot(): null {
  return null
}

/**
 * Subscribe to the active host transport when ready. Using the ready `Transport`
 * object identity as the `useSyncExternalStore` snapshot ensures replacing the
 * transport under the same `remoteConnectionId` (e.g. reconnect / reconfiguration)
 * immediately re-renders subscribers and clears stale catalogs or iframes.
 */
function useReadyHostTransport(enabled = true): Transport | null {
  return useSyncExternalStore(
    subscribeHostTransportChange,
    enabled ? getReadyHostTransportSnapshot : getNullTransportSnapshot,
    getNullTransportSnapshot
  )
}

export function useHostPlugins(enabled = true) {
  const transport = useReadyHostTransport(enabled)
  return {
    ...usePluginResource(transport, enabled, loadCatalog, CATALOG_CHANGED),
    transport,
  }
}

function loadCatalog(transport: Transport) {
  return transport.call<InstalledPlugin[]>("host_plugins_list")
}

export function applyHostPlugin(mutation: PluginMutation) {
  return getTransport().call<InstalledPlugin[]>("host_plugins_apply", {
    mutation,
  })
}

export interface PluginInstallPreview {
  ticket: string
  manifest: InstalledPlugin["manifest"]
  source: NonNullable<InstalledPlugin["source"]>
}

export function previewHostPluginInstall(
  input: string,
  registry: "npm" | "mirror",
  expected?: { id: string; version: string }
) {
  return getTransport().call<PluginInstallPreview>(
    "host_plugins_preview_install",
    { input, registry, expected }
  )
}

export function confirmHostPluginInstall(ticket: string) {
  return getTransport().call<InstalledPlugin[]>(
    "host_plugins_confirm_install",
    {
      ticket,
    }
  )
}

export function updateHostPlugin(pluginId: string) {
  return getTransport().call<{
    updated: boolean
    version: string
    disabledForUpdate?: boolean
  }>("host_plugins_update", { pluginId })
}

export function fetchHostPluginIndex(url: string) {
  return getTransport().call<PluginIndex>("host_plugins_fetch_index", { url })
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

export function usePluginPanelText(
  pluginId: string,
  method: string,
  folderId: number
) {
  const transport = typeof window === "undefined" ? null : getTransport()
  const load = useCallback(
    async (host: Transport) => {
      const value = await host.call<unknown>("host_plugins_call", {
        pluginId,
        method,
        input: { folderId },
      })
      if (typeof value !== "string")
        throw new Error("Expected plugin panel text")
      return value
    },
    [pluginId, method, folderId]
  )
  return usePluginResource(transport, true, load, CATALOG_CHANGED)
}

export function usePluginClientHtml(pluginId: string) {
  const transport = useReadyHostTransport(true)
  const load = useCallback(
    (host: Transport) =>
      host.call<string>("host_plugins_client_html", { pluginId }),
    [pluginId]
  )
  return {
    ...usePluginResource(transport, true, load, CATALOG_CHANGED),
    transport,
  }
}

export function usePluginTimelineItems(
  conversationId: number | null,
  enabled = true
) {
  const activeEnabled = enabled && conversationId != null
  const transport = useReadyHostTransport(activeEnabled)
  const [snapshot, setSnapshot] = useState<{
    transport: Transport
    conversationId: number
    data?: PluginTimelineItem[]
    error?: unknown
  }>()
  const [revision, setRevision] = useState(0)
  const refresh = useCallback(() => setRevision((previous) => previous + 1), [])

  useEffect(() => {
    if (!activeEnabled || !transport || conversationId == null) return
    let active = true
    let latest = 0
    let unsubscribeTimeline: (() => void) | undefined
    let unsubscribeCatalog: (() => void) | undefined
    const read = () => {
      if (typeof transport.call !== "function") return
      if (!isCurrentReadyHostTransport(transport)) return
      const request = ++latest
      void Promise.resolve()
        .then(() =>
          transport.call<PluginTimelineItem[]>("host_plugins_timeline_list", {
            conversationId,
          })
        )
        .then(
          (data) => {
            if (
              active &&
              request === latest &&
              isCurrentReadyHostTransport(transport)
            ) {
              setSnapshot({
                transport,
                conversationId,
                data: Array.isArray(data) ? data : [],
              })
            }
          },
          (error: unknown) => {
            if (
              active &&
              request === latest &&
              isCurrentReadyHostTransport(transport)
            ) {
              setSnapshot({ transport, conversationId, error })
            }
          }
        )
    }

    const stopReconnect = transport.onReconnect?.(read)
    if (typeof transport.subscribe === "function") {
      void transport
        .subscribe<PluginTimelineEvent>(TIMELINE_CHANGED, (payload) => {
          if (
            !payload ||
            payload.conversationId === null ||
            payload.conversationId === conversationId
          ) {
            read()
          }
        })
        .then(
          (stop) => {
            if (active) {
              unsubscribeTimeline = stop
              read()
            } else {
              stop()
            }
          },
          () => undefined
        )
      void transport
        .subscribe<unknown>(CATALOG_CHANGED, () => {
          read()
        })
        .then(
          (stop) => {
            if (active) {
              unsubscribeCatalog = stop
              read()
            } else {
              stop()
            }
          },
          () => undefined
        )
    }
    read()
    return () => {
      active = false
      unsubscribeTimeline?.()
      unsubscribeCatalog?.()
      stopReconnect?.()
    }
  }, [activeEnabled, conversationId, revision, transport])

  return {
    ...(activeEnabled &&
    transport &&
    conversationId != null &&
    snapshot?.transport === transport &&
    snapshot.conversationId === conversationId
      ? { data: snapshot.data, error: snapshot.error }
      : undefined),
    refresh,
    transport,
  }
}

export function pluginPanelKey(pluginId: string, panelId: string) {
  return `${pluginId}:${panelId}`
}

export function pluginClientSurfaceKey(pluginId: string, surfaceId: string) {
  return `${pluginId}:${surfaceId}`
}

export function pluginThemeKey(pluginId: string, themeId: string) {
  return `${pluginId}:${themeId}`
}

export function pluginScreenKey(pluginId: string, screenId: string) {
  return `${pluginId}:${screenId}`
}

export function pluginSidebarItemKey(pluginId: string, itemId: string) {
  return `${pluginId}:${itemId}`
}

export function pluginTimelineRendererKey(
  pluginId: string,
  kind: string,
  version: number
) {
  return `${pluginId}:${kind}@${version}`
}

export function pluginTimelineTransformerKey(
  pluginId: string,
  transformerId: string
) {
  return `${pluginId}:${transformerId}`
}

export function resolvePluginHostScope(
  search: string,
  activeRemoteId: number | null
): PluginHostScope {
  const params = new URLSearchParams(search)
  const rawRemoteId = params.get("remoteConnectionId")
  if (rawRemoteId !== null && rawRemoteId.trim() !== "") {
    const parsed = Number(rawRemoteId)
    if (!Number.isFinite(parsed)) {
      return {
        scopeKey: `remote:${rawRemoteId.trim()}`,
        transportReady: false,
      }
    }
    return {
      scopeKey: `remote:${parsed}`,
      transportReady: activeRemoteId === parsed,
    }
  }
  if (activeRemoteId !== null && Number.isFinite(activeRemoteId)) {
    return {
      scopeKey: `remote:${activeRemoteId}`,
      transportReady: true,
    }
  }
  return {
    scopeKey: "local",
    transportReady: true,
  }
}

function canonicalizeLocaleTag(tag: string): string {
  const parts = tag.trim().replace(/_/g, "-").split("-").filter(Boolean)
  if (parts.length === 0) return ""
  return parts
    .map((part, index) => {
      if (index === 0) return part.toLowerCase()
      if (part.length === 4) {
        return part[0].toUpperCase() + part.slice(1).toLowerCase()
      }
      if (part.length === 2 || part.length === 3) {
        return part.toUpperCase()
      }
      return part
    })
    .join("-")
}

/**
 * Resolve a manifest string (`fallback`) with optional sibling `*Translations`
 * (`Record<string, string>`) for the active UI locale using
 * `exact locale > base language > default`.
 */
export function resolvePluginText(
  fallback: string,
  translations?: PluginTextTranslations | null,
  locale?: string
): string {
  if (locale && translations) {
    const raw = locale.trim()
    if (raw && typeof translations[raw] === "string" && translations[raw]) {
      return translations[raw]
    }
    const canonical = canonicalizeLocaleTag(raw)
    if (
      canonical &&
      typeof translations[canonical] === "string" &&
      translations[canonical]
    ) {
      return translations[canonical]
    }
    const baseLanguage = canonical.split("-")[0]
    if (
      baseLanguage &&
      baseLanguage !== canonical &&
      typeof translations[baseLanguage] === "string" &&
      translations[baseLanguage]
    ) {
      return translations[baseLanguage]
    }
  }
  return fallback
}

export function resolvePluginHostSurface(
  plugin: InstalledPlugin,
  type: PluginSettingsSurfaceType,
  locale?: string
): ResolvedPluginHostSurface | null {
  if (!plugin.enabled || !plugin.manifest.client?.entry?.trim()) return null
  const surface = plugin.manifest.contributes[type]
  if (!surface) return null
  const id = surface.id.trim()
  const title = resolvePluginText(
    surface.title,
    surface.titleTranslations,
    locale
  ).trim()
  if (!id || !title) return null
  return { id, title }
}

export function selectPluginClientSurfaces(
  plugins: readonly InstalledPlugin[] | undefined,
  slot: PluginClientSurfaceSlot,
  locale?: string
): ResolvedPluginClientSurface[] {
  if (!plugins?.length) return []
  const items: ResolvedPluginClientSurface[] = []
  const seen = new Set<string>()
  for (const plugin of plugins) {
    if (!plugin.enabled || !plugin.manifest.client?.entry?.trim()) continue
    const surfaces = plugin.manifest.contributes.clientSurfaces
    if (!surfaces?.length) continue
    const pluginName = resolvePluginText(
      plugin.manifest.name,
      plugin.manifest.nameTranslations,
      locale
    ).trim()
    for (const surface of surfaces) {
      if (surface.slot !== slot) continue
      const id = surface.id.trim()
      const title = resolvePluginText(
        surface.title,
        surface.titleTranslations,
        locale
      ).trim()
      if (!id || !title) continue
      const key = pluginClientSurfaceKey(plugin.manifest.id, id)
      if (seen.has(key)) continue
      seen.add(key)
      items.push({
        key,
        pluginId: plugin.manifest.id,
        pluginName: pluginName || plugin.manifest.id,
        id,
        title,
        slot: surface.slot,
      })
    }
  }
  return items
}

export function selectPluginThemes(
  plugins: readonly InstalledPlugin[] | undefined,
  locale?: string
): ResolvedPluginTheme[] {
  if (!plugins?.length) return []
  const items: ResolvedPluginTheme[] = []
  const seen = new Set<string>()
  for (const plugin of plugins) {
    if (!plugin.enabled) continue
    const themes = plugin.manifest.contributes?.themes
    if (!themes?.length) continue
    const pluginName = resolvePluginText(
      plugin.manifest.name,
      plugin.manifest.nameTranslations,
      locale
    ).trim()
    for (const theme of themes) {
      const id = theme.id.trim()
      const title = resolvePluginText(
        theme.title,
        theme.titleTranslations,
        locale
      ).trim()
      if (!id || !title) continue
      const light = parsePluginThemePalette(theme.light)
      const dark = parsePluginThemePalette(theme.dark)
      if (!light || !dark) continue
      const hasLight = Object.keys(light).length > 0
      const hasDark = Object.keys(dark).length > 0
      if (!hasLight && !hasDark) continue
      const key = pluginThemeKey(plugin.manifest.id, id)
      if (seen.has(key)) continue
      seen.add(key)
      items.push({
        key,
        pluginId: plugin.manifest.id,
        pluginName: pluginName || plugin.manifest.id,
        id,
        title,
        ...(hasLight ? { light } : {}),
        ...(hasDark ? { dark } : {}),
      })
    }
  }
  return items
}

function resolvePluginScreensForPlugin(
  plugin: InstalledPlugin,
  locale?: string
): ResolvedPluginScreen[] {
  if (!plugin.enabled || !plugin.manifest.client?.entry?.trim()) return []
  const screens = plugin.manifest.contributes?.screens
  if (!screens?.length) return []
  const pluginName =
    resolvePluginText(
      plugin.manifest.name,
      plugin.manifest.nameTranslations,
      locale
    ).trim() || plugin.manifest.id
  const items: ResolvedPluginScreen[] = []
  const seenIds = new Set<string>()
  for (const screen of screens) {
    if (items.length >= MAX_PLUGIN_SCREENS) break
    const id = screen.id.trim()
    const title = resolvePluginText(
      screen.title,
      screen.titleTranslations,
      locale
    ).trim()
    if (!id || !title || seenIds.has(id)) continue
    seenIds.add(id)
    items.push({
      key: pluginScreenKey(plugin.manifest.id, id),
      pluginId: plugin.manifest.id,
      pluginName,
      id,
      title,
    })
  }
  return items
}

export function selectPluginScreens(
  plugins: readonly InstalledPlugin[] | undefined,
  locale?: string
): ResolvedPluginScreen[] {
  if (!plugins?.length) return []
  const items: ResolvedPluginScreen[] = []
  const seenPlugins = new Set<string>()
  for (const plugin of plugins) {
    if (seenPlugins.has(plugin.manifest.id)) continue
    seenPlugins.add(plugin.manifest.id)
    items.push(...resolvePluginScreensForPlugin(plugin, locale))
  }
  return items
}

export function resolvePluginScreen(
  plugins: readonly InstalledPlugin[] | undefined,
  pluginId: string,
  screenId: string,
  locale?: string
): ResolvedPluginScreen | null {
  if (!plugins?.length) return null
  const normalizedPluginId = pluginId.trim()
  const normalizedScreenId = screenId.trim()
  if (!normalizedPluginId || !normalizedScreenId) return null
  const plugin = plugins.find((item) => item.manifest.id === normalizedPluginId)
  if (!plugin) return null
  const screens = resolvePluginScreensForPlugin(plugin, locale)
  return screens.find((item) => item.id === normalizedScreenId) ?? null
}

export function selectPluginSidebarItems(
  plugins: readonly InstalledPlugin[] | undefined,
  placement?: PluginSidebarItemPlacement,
  locale?: string
): ResolvedPluginSidebarItem[] {
  if (!plugins?.length) return []
  const items: ResolvedPluginSidebarItem[] = []
  const seenPlugins = new Set<string>()
  for (const plugin of plugins) {
    if (seenPlugins.has(plugin.manifest.id)) continue
    seenPlugins.add(plugin.manifest.id)
    if (!plugin.enabled || !plugin.manifest.client?.entry?.trim()) continue
    const sidebarItems = plugin.manifest.contributes?.sidebarItems
    if (!sidebarItems?.length) continue
    const pluginScreens = resolvePluginScreensForPlugin(plugin, locale)
    if (pluginScreens.length === 0) continue
    const screensById = new Map(pluginScreens.map((s) => [s.id, s]))
    const seenItemIds = new Set<string>()
    let pluginValidCount = 0
    for (const item of sidebarItems) {
      if (pluginValidCount >= MAX_PLUGIN_SIDEBAR_ITEMS) break
      const id = item.id.trim()
      const title = resolvePluginText(
        item.title,
        item.titleTranslations,
        locale
      ).trim()
      const screenId = item.screenId.trim()
      if (!id || !title || !screenId) continue
      if (item.placement !== "header" && item.placement !== "footer") continue
      if (seenItemIds.has(id)) continue
      // Only allow routing to a screen declared by the SAME plugin.
      const targetScreen = screensById.get(screenId)
      if (!targetScreen) continue
      seenItemIds.add(id)
      pluginValidCount += 1
      if (placement && item.placement !== placement) continue
      items.push({
        key: pluginSidebarItemKey(plugin.manifest.id, id),
        pluginId: plugin.manifest.id,
        pluginName: targetScreen.pluginName,
        id,
        title,
        placement: item.placement,
        screenId: targetScreen.id,
        screenKey: targetScreen.key,
        screenTitle: targetScreen.title,
      })
    }
  }
  return items
}

const PLUGIN_TIMELINE_KIND_RE = /^[a-z][a-z0-9-]{0,31}$/

function resolvePluginTimelineRenderersForPlugin(
  plugin: InstalledPlugin,
  locale?: string
): ResolvedPluginTimelineRenderer[] {
  if (!plugin.enabled || !plugin.manifest.client?.entry?.trim()) return []
  const renderers = plugin.manifest.contributes?.timelineRenderers
  if (!renderers?.length) return []
  const pluginName =
    resolvePluginText(
      plugin.manifest.name,
      plugin.manifest.nameTranslations,
      locale
    ).trim() || plugin.manifest.id
  const items: ResolvedPluginTimelineRenderer[] = []
  const seenPairs = new Set<string>()
  for (const renderer of renderers) {
    if (items.length >= MAX_PLUGIN_TIMELINE_RENDERERS) break
    if (
      typeof renderer.kind !== "string" ||
      !PLUGIN_TIMELINE_KIND_RE.test(renderer.kind)
    ) {
      continue
    }
    if (
      typeof renderer.version !== "number" ||
      !Number.isSafeInteger(renderer.version) ||
      renderer.version < 1
    ) {
      continue
    }
    const fallbackTitle =
      typeof renderer.title === "string" ? renderer.title.trim() : ""
    if (!fallbackTitle) continue
    const title = resolvePluginText(
      fallbackTitle,
      renderer.titleTranslations,
      locale
    ).trim()
    if (!title) continue
    const pairKey = `${renderer.kind}@${renderer.version}`
    if (seenPairs.has(pairKey)) continue
    seenPairs.add(pairKey)
    items.push({
      key: pluginTimelineRendererKey(
        plugin.manifest.id,
        renderer.kind,
        renderer.version
      ),
      pluginId: plugin.manifest.id,
      pluginName,
      kind: renderer.kind,
      version: renderer.version,
      title,
    })
  }
  return items
}

export function selectPluginTimelineRenderers(
  plugins: readonly InstalledPlugin[] | undefined,
  locale?: string
): ResolvedPluginTimelineRenderer[] {
  if (!plugins?.length) return []
  const items: ResolvedPluginTimelineRenderer[] = []
  const seenPlugins = new Set<string>()
  for (const plugin of plugins) {
    if (seenPlugins.has(plugin.manifest.id)) continue
    seenPlugins.add(plugin.manifest.id)
    items.push(...resolvePluginTimelineRenderersForPlugin(plugin, locale))
  }
  return items
}

export function resolvePluginTimelineRenderer(
  plugins: readonly InstalledPlugin[] | undefined,
  pluginId: string,
  kind: string,
  version: number,
  locale?: string
): ResolvedPluginTimelineRenderer | null {
  if (!plugins?.length) return null
  const normalizedPluginId = pluginId.trim()
  if (
    !normalizedPluginId ||
    typeof kind !== "string" ||
    !PLUGIN_TIMELINE_KIND_RE.test(kind) ||
    typeof version !== "number" ||
    !Number.isSafeInteger(version) ||
    version < 1
  ) {
    return null
  }
  const plugin = plugins.find((item) => item.manifest.id === normalizedPluginId)
  if (!plugin) return null
  const renderers = resolvePluginTimelineRenderersForPlugin(plugin, locale)
  return (
    renderers.find(
      (renderer) => renderer.kind === kind && renderer.version === version
    ) ?? null
  )
}

const PLUGIN_TIMELINE_SLUG_RE = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/

function hasControlChars(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i)
    if (code <= 0x1f || code === 0x7f) return true
  }
  return false
}

function validTimelinePlainText(
  value: unknown,
  maxBytes: number
): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    !hasControlChars(value) &&
    utf8Encoder.encode(value).byteLength <= maxBytes
  )
}

function validTimelineSlug(value: unknown): value is string {
  return typeof value === "string" && PLUGIN_TIMELINE_SLUG_RE.test(value)
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function selectPluginTimelineTransformers(
  plugins: readonly InstalledPlugin[] | undefined,
  itemType?: TimelineSourceType,
  toolName?: string,
  locale?: string
): ResolvedPluginTimelineTransformer[] {
  if (!plugins?.length) return []
  const items: ResolvedPluginTimelineTransformer[] = []
  const seenPlugins = new Set<string>()
  for (const plugin of plugins) {
    if (seenPlugins.has(plugin.manifest.id)) continue
    seenPlugins.add(plugin.manifest.id)
    if (
      !plugin.enabled ||
      !plugin.manifest.server?.entry?.trim() ||
      !plugin.manifest.client?.entry?.trim()
    ) {
      continue
    }
    const transformers = plugin.manifest.contributes?.timelineTransformers
    if (!transformers?.length) continue
    const renderers = resolvePluginTimelineRenderersForPlugin(plugin, locale)
    if (renderers.length === 0) continue
    const rendererByPair = new Map(
      renderers.map((renderer) => [
        `${renderer.kind}@${renderer.version}`,
        renderer,
      ])
    )
    const serverMethods = new Set(plugin.manifest.server.methods ?? [])
    const seenIds = new Set<string>()
    let pluginValidCount = 0

    for (const transformer of transformers) {
      if (pluginValidCount >= MAX_PLUGIN_TIMELINE_TRANSFORMERS) break
      if (!validTimelineSlug(transformer.id) || seenIds.has(transformer.id)) {
        continue
      }
      if (
        transformer.itemType !== "tool_call" &&
        transformer.itemType !== "assistant_message"
      ) {
        continue
      }
      if (
        typeof transformer.method !== "string" ||
        !serverMethods.has(transformer.method)
      ) {
        continue
      }
      if (
        typeof transformer.rendererKind !== "string" ||
        typeof transformer.rendererVersion !== "number" ||
        !Number.isSafeInteger(transformer.rendererVersion) ||
        transformer.rendererVersion < 1
      ) {
        continue
      }
      const renderer = rendererByPair.get(
        `${transformer.rendererKind}@${transformer.rendererVersion}`
      )
      if (!renderer) continue

      let validToolNames: string[] | undefined
      const rawToolNames = (transformer as { toolNames?: unknown }).toolNames
      if (rawToolNames !== undefined) {
        if (
          transformer.itemType !== "tool_call" ||
          !Array.isArray(rawToolNames)
        ) {
          continue
        }
        if (
          rawToolNames.length === 0 ||
          rawToolNames.length > MAX_TIMELINE_TRANSFORM_TOOL_NAMES
        ) {
          continue
        }
        const uniqueToolNames = new Set<string>()
        let allNamesValid = true
        for (const name of rawToolNames) {
          if (
            !validTimelinePlainText(
              name,
              MAX_TIMELINE_TRANSFORM_TOOL_NAME_BYTES
            ) ||
            uniqueToolNames.has(name)
          ) {
            allNamesValid = false
            break
          }
          uniqueToolNames.add(name)
        }
        if (!allNamesValid) continue
        validToolNames = [...uniqueToolNames]
      }

      seenIds.add(transformer.id)
      pluginValidCount += 1

      if (itemType !== undefined && transformer.itemType !== itemType) {
        continue
      }
      if (itemType === "tool_call" && validToolNames) {
        if (
          typeof toolName !== "string" ||
          !validToolNames.includes(toolName)
        ) {
          continue
        }
      }

      items.push({
        key: pluginTimelineTransformerKey(plugin.manifest.id, transformer.id),
        pluginId: plugin.manifest.id,
        pluginName: renderer.pluginName,
        id: transformer.id,
        itemType: transformer.itemType,
        ...(validToolNames ? { toolNames: validToolNames } : {}),
        rendererKind: renderer.kind,
        rendererVersion: renderer.version,
        rendererTitle: renderer.title,
        method: transformer.method,
      })
    }
  }
  return items
}

export function validateTimelineTransformResult(
  raw: unknown,
  expectedKind: string,
  expectedVersion: number
): TimelineTransformResult {
  if (raw === null || raw === undefined) {
    return { action: "keep" }
  }
  if (!isPlainRecord(raw)) {
    throw new Error("Invalid timeline transform result")
  }
  const keys = Object.keys(raw)
  const action = raw.action
  if (action === "keep" || action === "omit") {
    if (keys.length !== 1) {
      throw new Error("Unexpected fields in timeline transform result")
    }
    return { action }
  }
  if (action !== "replace") {
    throw new Error("Unsupported timeline transform action")
  }
  if (keys.some((key) => key !== "action" && key !== "items")) {
    throw new Error("Unexpected fields in timeline transform replacement")
  }
  const rawItems = raw.items
  if (
    !Array.isArray(rawItems) ||
    rawItems.length === 0 ||
    rawItems.length > MAX_TIMELINE_TRANSFORM_REPLACEMENTS
  ) {
    throw new Error("Timeline transform replace requires 1 to 4 items")
  }
  const seenIds = new Set<string>()
  const validated: TimelineReplacement[] = []
  for (const entry of rawItems) {
    if (!isPlainRecord(entry)) {
      throw new Error("Timeline transform replacement item must be an object")
    }
    for (const key of Object.keys(entry)) {
      if (
        key !== "id" &&
        key !== "kind" &&
        key !== "version" &&
        key !== "data"
      ) {
        throw new Error("Unexpected field in timeline replacement item")
      }
    }
    if (entry.kind !== expectedKind || entry.version !== expectedVersion) {
      throw new Error("Timeline replacement renderer kind or version mismatch")
    }
    let id: string | undefined
    if (entry.id !== undefined) {
      if (!validTimelineSlug(entry.id) || seenIds.has(entry.id)) {
        throw new Error("Invalid or duplicate timeline replacement item ID")
      }
      seenIds.add(entry.id)
      id = entry.id
    }
    if (!("data" in entry) || entry.data === undefined) {
      throw new Error("Timeline replacement item requires data")
    }
    let serialized: string
    try {
      serialized = JSON.stringify(entry.data)
    } catch {
      throw new Error("Timeline replacement item data is not JSON-serializable")
    }
    if (
      typeof serialized !== "string" ||
      utf8Encoder.encode(serialized).byteLength >
        MAX_TIMELINE_TRANSFORM_ITEM_BYTES
    ) {
      throw new Error("Timeline replacement item data exceeds 64 KiB")
    }
    validated.push({
      ...(id !== undefined ? { id } : {}),
      kind: expectedKind,
      version: expectedVersion,
      data: entry.data,
    })
  }
  return { action: "replace", items: validated }
}

function truncateUtf8(
  value: string,
  maxBytes: number,
  keep: "head" | "tail"
): string {
  if (maxBytes <= 0) return ""
  if (utf8Encoder.encode(value).byteLength <= maxBytes) return value
  let low = 0
  let high = value.length
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    const slice =
      keep === "tail" ? value.slice(value.length - mid) : value.slice(0, mid)
    if (utf8Encoder.encode(slice).byteLength <= maxBytes) {
      low = mid
    } else {
      high = mid - 1
    }
  }
  return keep === "tail" ? value.slice(value.length - low) : value.slice(0, low)
}

function serializedUtf8Bytes(value: unknown): number | null {
  try {
    const json = JSON.stringify(value)
    if (typeof json !== "string") return null
    return utf8Encoder.encode(json).byteLength
  } catch {
    return null
  }
}

export function prepareTimelineTransformItem(
  item: TimelineSourceItem
): TimelineSourceItem | null {
  if (!validTimelinePlainText(item.id, MAX_TIMELINE_TRANSFORM_ITEM_BYTES)) {
    return null
  }
  const cleaned: TimelineSourceItem = { id: item.id }
  if (item.toolName !== undefined) cleaned.toolName = item.toolName
  if (item.status !== undefined) cleaned.status = item.status
  if (item.rawInput !== undefined) cleaned.rawInput = item.rawInput
  if (item.rawOutput !== undefined) cleaned.rawOutput = item.rawOutput
  if (item.text !== undefined) cleaned.text = item.text

  let size = serializedUtf8Bytes(cleaned)
  if (size !== null && size <= MAX_TIMELINE_TRANSFORM_ITEM_BYTES) {
    return cleaned
  }

  // Fit oversized payloads within the 64 KiB wire cap, keeping the tail of
  // command output (where test summaries appear) and the head of prose text.
  const budget = MAX_TIMELINE_TRANSFORM_ITEM_BYTES - 1024
  const trimmed: TimelineSourceItem = { id: cleaned.id }
  if (cleaned.toolName !== undefined) trimmed.toolName = cleaned.toolName
  if (cleaned.status !== undefined) trimmed.status = cleaned.status
  if (typeof cleaned.rawOutput === "string") {
    trimmed.rawOutput = truncateUtf8(
      cleaned.rawOutput,
      Math.floor(budget * 0.75),
      "tail"
    )
  } else if (cleaned.rawOutput !== undefined) {
    const outputSize = serializedUtf8Bytes(cleaned.rawOutput)
    if (outputSize !== null && outputSize <= Math.floor(budget * 0.75)) {
      trimmed.rawOutput = cleaned.rawOutput
    }
  }
  if (typeof cleaned.text === "string") {
    trimmed.text = truncateUtf8(cleaned.text, Math.floor(budget * 0.75), "head")
  }
  if (cleaned.rawInput !== undefined) {
    const withInput = { ...trimmed, rawInput: cleaned.rawInput }
    const withInputSize = serializedUtf8Bytes(withInput)
    if (
      withInputSize !== null &&
      withInputSize <= MAX_TIMELINE_TRANSFORM_ITEM_BYTES
    ) {
      trimmed.rawInput = cleaned.rawInput
    }
  }
  size = serializedUtf8Bytes(trimmed)
  if (size === null || size > MAX_TIMELINE_TRANSFORM_ITEM_BYTES) {
    return null
  }
  return trimmed
}

export interface RunPluginTimelineTransformsOptions {
  transport: Transport
  transformers: readonly ResolvedPluginTimelineTransformer[]
  itemType: TimelineSourceType
  phase: TimelineTransformPhase
  conversationId: number | null
  locale?: string
  item: TimelineSourceItem
  isActive: () => boolean
}

export async function runPluginTimelineTransforms({
  transport,
  transformers,
  itemType,
  phase,
  conversationId,
  locale,
  item,
  isActive,
}: RunPluginTimelineTransformsOptions): Promise<{
  outcome: PluginTimelineTransformOutcome
  error?: unknown
} | null> {
  if (transformers.length === 0 || typeof transport.call !== "function") {
    return { outcome: { action: "keep" } }
  }
  const wireItem = prepareTimelineTransformItem(item)
  if (!wireItem) {
    return { outcome: { action: "keep" } }
  }
  const normalizedLocale =
    locale && validTimelinePlainText(locale, 128) ? locale : undefined
  let lastError: unknown

  for (const transformer of transformers) {
    if (!isActive() || !isCurrentReadyHostTransport(transport)) {
      return null
    }
    try {
      const request: TimelineTransformRequest = {
        pluginId: transformer.pluginId,
        transformerId: transformer.id,
        itemType,
        phase,
        ...(conversationId != null ? { conversationId } : {}),
        ...(normalizedLocale ? { locale: normalizedLocale } : {}),
        item: wireItem,
      }
      const raw = await transport.call<unknown>(
        "host_plugins_timeline_transform",
        { ...request }
      )
      if (!isActive() || !isCurrentReadyHostTransport(transport)) {
        return null
      }
      const validated = validateTimelineTransformResult(
        raw,
        transformer.rendererKind,
        transformer.rendererVersion
      )
      if (validated.action === "omit") {
        return {
          outcome: {
            action: "omit",
            pluginId: transformer.pluginId,
            transformerId: transformer.id,
          },
        }
      }
      if (validated.action === "replace") {
        return {
          outcome: {
            action: "replace",
            pluginId: transformer.pluginId,
            pluginName: transformer.pluginName,
            transformerId: transformer.id,
            rendererKind: transformer.rendererKind,
            rendererVersion: transformer.rendererVersion,
            rendererTitle: transformer.rendererTitle,
            items: validated.items,
          },
        }
      }
    } catch (error: unknown) {
      if (!isActive() || !isCurrentReadyHostTransport(transport)) {
        return null
      }
      lastError = error
    }
  }

  return {
    outcome: { action: "keep" },
    ...(lastError !== undefined ? { error: lastError } : {}),
  }
}

export interface UsePluginTimelineTransformOptions {
  enabled?: boolean
  plugins: readonly InstalledPlugin[] | undefined
  transport: Transport | null
  scopeKey: string
  itemType: TimelineSourceType
  phase: TimelineTransformPhase
  conversationId: number | null
  locale?: string
  item: TimelineSourceItem | null
  streamingDebounceMs?: number
}

const KEEP_OUTCOME: PluginTimelineTransformOutcome = { action: "keep" }

export function usePluginTimelineTransform({
  enabled = true,
  plugins,
  transport,
  scopeKey,
  itemType,
  phase,
  conversationId,
  locale,
  item,
  streamingDebounceMs = 120,
}: UsePluginTimelineTransformOptions): {
  outcome: PluginTimelineTransformOutcome
  error?: unknown
} {
  const matchingTransformers = useMemo(
    () =>
      enabled && item
        ? selectPluginTimelineTransformers(
            plugins,
            itemType,
            item.toolName,
            locale
          )
        : [],
    [enabled, item, itemType, locale, plugins]
  )
  const transformerSignature = useMemo(
    () =>
      matchingTransformers
        .map(
          (t) =>
            `${t.key}:${t.rendererKind}@${t.rendererVersion}:${t.method}:${t.rendererTitle}`
        )
        .join("|"),
    [matchingTransformers]
  )
  const wireItem = useMemo(
    () => (item ? prepareTimelineTransformItem(item) : null),
    [item]
  )
  const itemJson = useMemo(
    () => (wireItem ? JSON.stringify(wireItem) : ""),
    [wireItem]
  )
  const snapshotKey =
    enabled && transport && wireItem && matchingTransformers.length > 0
      ? `${scopeKey}|${conversationId ?? "draft"}|${itemType}|${phase}|${locale ?? ""}|${transformerSignature}|${itemJson}`
      : ""

  const [snapshot, setSnapshot] = useState<{
    transport: Transport
    scopeKey: string
    conversationId: number | null
    sourceItemId: string
    outcome: PluginTimelineTransformOutcome
    error?: unknown
  }>()
  const requestSeqRef = useRef(0)

  useEffect(() => {
    if (
      !enabled ||
      !transport ||
      !wireItem ||
      matchingTransformers.length === 0 ||
      !snapshotKey
    ) {
      return
    }
    let active = true
    const seq = ++requestSeqRef.current
    const isCurrent = () => active && requestSeqRef.current === seq

    const execute = () => {
      void runPluginTimelineTransforms({
        transport,
        transformers: matchingTransformers,
        itemType,
        phase,
        conversationId,
        locale,
        item: wireItem,
        isActive: isCurrent,
      }).then((result) => {
        if (!result || !isCurrent()) return
        setSnapshot({
          transport,
          scopeKey,
          conversationId,
          sourceItemId: wireItem.id,
          outcome: result.outcome,
          error: result.error,
        })
      })
    }

    if (phase === "streaming" && streamingDebounceMs > 0) {
      const timer = setTimeout(execute, streamingDebounceMs)
      return () => {
        active = false
        clearTimeout(timer)
      }
    }
    execute()
    return () => {
      active = false
    }
  }, [
    conversationId,
    enabled,
    itemType,
    locale,
    matchingTransformers,
    phase,
    scopeKey,
    snapshotKey,
    streamingDebounceMs,
    transport,
    wireItem,
  ])

  if (
    !enabled ||
    !transport ||
    !wireItem ||
    matchingTransformers.length === 0 ||
    !snapshot ||
    snapshot.transport !== transport ||
    snapshot.scopeKey !== scopeKey ||
    snapshot.conversationId !== conversationId ||
    snapshot.sourceItemId !== wireItem.id
  ) {
    return { outcome: KEEP_OUTCOME }
  }

  if (
    snapshot.outcome.action === "replace" ||
    snapshot.outcome.action === "omit"
  ) {
    const owner = snapshot.outcome
    const stillRegistered = matchingTransformers.some(
      (transformer) =>
        transformer.pluginId === owner.pluginId &&
        transformer.id === owner.transformerId
    )
    if (!stillRegistered) {
      return { outcome: KEEP_OUTCOME }
    }
  }

  return {
    outcome: snapshot.outcome,
    ...(snapshot.error !== undefined ? { error: snapshot.error } : {}),
  }
}

export function hostPluginSessionScopeKey(
  context: HostPluginSessionContext
): string {
  return `${context.folderId ?? "none"}:${context.conversationId ?? "draft"}:${context.sessionKey}`
}

const utf8Encoder = new TextEncoder()

export function validatePluginComposerInsertPayload(payload: unknown): string {
  if (
    !payload ||
    typeof payload !== "object" ||
    !("type" in payload) ||
    payload.type !== "insertText" ||
    !("text" in payload) ||
    typeof payload.text !== "string"
  ) {
    throw new Error("Invalid composer insertion payload")
  }
  const normalized = payload.text.replace(/\r\n?/g, "\n")
  if (normalized.length === 0) {
    throw new Error("Composer text must be non-empty")
  }
  if (normalized.includes("\0")) {
    throw new Error("Composer text contains unsupported control characters")
  }
  if (
    utf8Encoder.encode(normalized).byteLength > MAX_PLUGIN_COMPOSER_INSERT_BYTES
  ) {
    throw new Error("Composer text exceeds 16 KiB limit")
  }
  return normalized
}
