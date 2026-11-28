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
import {
  parsePluginThemePalette,
  type PluginThemePalette,
} from "@/lib/custom-style"
import * as transportModule from "@/lib/transport"
import { getTransport, type Transport } from "@/lib/transport"

export type PluginTextTranslations = Record<string, string>

export const MAX_PLUGIN_SCREENS = 16
export const MAX_PLUGIN_SIDEBAR_ITEMS = 16
export const MAX_PLUGIN_USAGE_SOURCES = 16

export type PluginSidebarItemPlacement = "header" | "footer"

export interface PluginUsageSourceContribution {
  id: string
  title: string
  titleTranslations?: PluginTextTranslations
  provider?: string
  method: string
}

export interface ResolvedPluginUsageSource {
  key: string
  pluginId: string
  pluginName: string
  id: string
  title: string
  provider?: string
  method: string
}

export interface PluginUsageWindow {
  id: string
  label: string
  usedPercent: number
  resetsAt?: string
  durationSeconds?: number
}

export interface PluginUsageBalance {
  id: string
  label: string
  amount: string
  unit?: string
}

export interface PluginUsageDetail {
  label: string
  value: string
}

export interface PluginUsageProblem {
  kind: "expired" | "rejected" | "no_quota"
  detail?: string
  expiresAt?: string
  status?: number
}

export type PluginUsageReport =
  | {
      status: "available"
      planLabel?: string
      windows: PluginUsageWindow[]
      balances?: PluginUsageBalance[]
      details?: PluginUsageDetail[]
    }
  | { status: "unavailable"; problem: PluginUsageProblem }
  | { status: "error"; error: string }

export interface PluginUsageAccount {
  key: string
  label?: string
  harness?: string
  report: PluginUsageReport
}

export interface PluginUsageQueryResult {
  accounts: PluginUsageAccount[]
}

export interface PluginUsageSourceState {
  loading: boolean
  data?: PluginUsageQueryResult
  error?: string
}

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
      usageSources?: PluginUsageSourceContribution[]
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

export function pluginUsageSourceKey(pluginId: string, sourceId: string) {
  return `${pluginId}:${sourceId}`
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

const PLUGIN_USAGE_PROVIDER_RE = /^[a-z0-9][a-z0-9-]{0,31}$/
const MAX_CONCURRENT_USAGE_QUERIES = 4
const MAX_USAGE_ERROR_CHARS = 512
const useIsomorphicLayoutEffect =
  typeof window !== "undefined" ? useLayoutEffect : useEffect

export function selectPluginUsageSources(
  plugins: readonly InstalledPlugin[] | undefined,
  locale?: string
): ResolvedPluginUsageSource[] {
  if (!plugins?.length) return []
  const items: ResolvedPluginUsageSource[] = []
  const seenPlugins = new Set<string>()
  for (const plugin of plugins) {
    if (seenPlugins.has(plugin.manifest.id)) continue
    seenPlugins.add(plugin.manifest.id)
    if (!plugin.enabled) continue
    const server = plugin.manifest.server
    if (!server?.entry?.trim() || !Array.isArray(server.methods)) continue
    const declaredMethods = new Set(
      server.methods
        .map((method) => (typeof method === "string" ? method.trim() : ""))
        .filter(Boolean)
    )
    if (declaredMethods.size === 0) continue
    const usageSources = plugin.manifest.contributes?.usageSources
    if (!usageSources?.length) continue
    const pluginName =
      resolvePluginText(
        plugin.manifest.name,
        plugin.manifest.nameTranslations,
        locale
      ).trim() || plugin.manifest.id
    const seenIds = new Set<string>()
    let pluginValidCount = 0
    for (const source of usageSources) {
      if (pluginValidCount >= MAX_PLUGIN_USAGE_SOURCES) break
      const id = typeof source.id === "string" ? source.id.trim() : ""
      const fallbackTitle =
        typeof source.title === "string" ? source.title.trim() : ""
      const method =
        typeof source.method === "string" ? source.method.trim() : ""
      if (!id || !fallbackTitle || !method) continue
      if (seenIds.has(id) || !declaredMethods.has(method)) continue
      let provider: string | undefined
      if (source.provider !== undefined) {
        if (
          typeof source.provider !== "string" ||
          !PLUGIN_USAGE_PROVIDER_RE.test(source.provider)
        ) {
          continue
        }
        provider = source.provider
      }
      const title = resolvePluginText(
        fallbackTitle,
        source.titleTranslations,
        locale
      ).trim()
      if (!title) continue
      seenIds.add(id)
      pluginValidCount += 1
      items.push({
        key: pluginUsageSourceKey(plugin.manifest.id, id),
        pluginId: plugin.manifest.id,
        pluginName,
        id,
        title,
        ...(provider ? { provider } : {}),
        method,
      })
    }
  }
  return items
}

function formatUsageQueryError(error: unknown): string {
  const raw =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "Usage query failed"
  const cleaned = raw.replace(/[\u0000-\u001f\u007f]+/g, " ").trim()
  if (!cleaned) return "Usage query failed"
  return cleaned.slice(0, MAX_USAGE_ERROR_CHARS)
}

interface StoredUsageEntry {
  transport: Transport
  scopeKey: string
  loading: boolean
  data?: PluginUsageQueryResult
  error?: string
}

interface QueuedUsageTask {
  source: ResolvedPluginUsageSource
  transport: Transport
  scopeKey: string
  locale: string
  generation: number
  seq: number
}

export function usePluginUsageSources({
  locale = "en",
  enabled = true,
}: {
  locale?: string
  enabled?: boolean
} = {}) {
  const hostScope = usePluginHostScope()
  const { data: plugins, transport } = useHostPlugins(enabled)
  const sources = useMemo(
    () =>
      enabled && hostScope.transportReady
        ? selectPluginUsageSources(plugins, locale)
        : [],
    [enabled, hostScope.transportReady, locale, plugins]
  )
  const liveSourceKeys = useMemo(
    () => new Set(sources.map((source) => source.key)),
    [sources]
  )

  const [entriesByKey, setEntriesByKey] = useState<
    Record<string, StoredUsageEntry>
  >({})

  const generationRef = useRef(0)
  const seqByKeyRef = useRef(new Map<string, number>())
  const activeCountRef = useRef(0)
  const queueRef = useRef<QueuedUsageTask[]>([])
  const liveRef = useRef({
    enabled,
    transportReady: hostScope.transportReady,
    scopeKey: hostScope.scopeKey,
    transport,
    locale,
    liveSourceKeys,
  })

  useIsomorphicLayoutEffect(() => {
    liveRef.current = {
      enabled,
      transportReady: hostScope.transportReady,
      scopeKey: hostScope.scopeKey,
      transport,
      locale,
      liveSourceKeys,
    }
  }, [
    enabled,
    hostScope.transportReady,
    hostScope.scopeKey,
    transport,
    locale,
    liveSourceKeys,
  ])

  // Bump generation & clear pending queue whenever host, transport instance,
  // or enabled flag changes so in-flight responses are guaranteed discarded.
  useEffect(() => {
    generationRef.current += 1
    queueRef.current = []
    seqByKeyRef.current.clear()
  }, [enabled, hostScope.scopeKey, transport])

  // Withdraw sequence tokens for any source removed/disabled in catalog updates.
  useEffect(() => {
    for (const key of Array.from(seqByKeyRef.current.keys())) {
      if (!liveSourceKeys.has(key)) {
        seqByKeyRef.current.delete(key)
      }
    }
    queueRef.current = queueRef.current.filter((task) =>
      liveSourceKeys.has(task.source.key)
    )
  }, [liveSourceKeys])

  useEffect(() => {
    const seqByKey = seqByKeyRef.current
    return () => {
      generationRef.current += 1
      queueRef.current = []
      seqByKey.clear()
    }
  }, [])

  const pumpQueueRef = useRef<() => void>(() => {})

  const runTask = useCallback((task: QueuedUsageTask) => {
    const isTaskStillValid = () => {
      const live = liveRef.current
      return (
        task.generation === generationRef.current &&
        seqByKeyRef.current.get(task.source.key) === task.seq &&
        live.enabled &&
        live.transportReady &&
        live.scopeKey === task.scopeKey &&
        live.transport === task.transport &&
        isCurrentReadyHostTransport(task.transport) &&
        live.liveSourceKeys.has(task.source.key)
      )
    }

    if (!isTaskStillValid() || typeof task.transport.call !== "function") {
      pumpQueueRef.current()
      return
    }

    activeCountRef.current += 1
    void Promise.resolve()
      .then(() =>
        task.transport.call<PluginUsageQueryResult>(
          "host_plugins_usage_query",
          {
            pluginId: task.source.pluginId,
            sourceId: task.source.id,
            locale: task.locale,
          }
        )
      )
      .then(
        (result) => {
          if (!isTaskStillValid()) return
          const accounts = Array.isArray(result?.accounts)
            ? result.accounts
            : []
          setEntriesByKey((previous) => ({
            ...previous,
            [task.source.key]: {
              transport: task.transport,
              scopeKey: task.scopeKey,
              loading: false,
              data: { accounts },
            },
          }))
        },
        (error: unknown) => {
          if (!isTaskStillValid()) return
          const message = formatUsageQueryError(error)
          setEntriesByKey((previous) => ({
            ...previous,
            [task.source.key]: {
              transport: task.transport,
              scopeKey: task.scopeKey,
              loading: false,
              error: message,
            },
          }))
        }
      )
      .finally(() => {
        activeCountRef.current = Math.max(0, activeCountRef.current - 1)
        pumpQueueRef.current()
      })
  }, [])

  const pumpQueue = useCallback(() => {
    while (
      activeCountRef.current < MAX_CONCURRENT_USAGE_QUERIES &&
      queueRef.current.length > 0
    ) {
      const next = queueRef.current.shift()
      if (next) runTask(next)
    }
  }, [runTask])

  useIsomorphicLayoutEffect(() => {
    pumpQueueRef.current = pumpQueue
  }, [pumpQueue])

  const querySource = useCallback(
    (source: ResolvedPluginUsageSource) => {
      const live = liveRef.current
      if (
        !live.enabled ||
        !live.transportReady ||
        !live.transport ||
        !isCurrentReadyHostTransport(live.transport) ||
        !live.liveSourceKeys.has(source.key)
      ) {
        return
      }
      const capturedTransport = live.transport
      const capturedScopeKey = live.scopeKey
      const generation = generationRef.current
      const seq = (seqByKeyRef.current.get(source.key) ?? 0) + 1
      seqByKeyRef.current.set(source.key, seq)

      // Deduplicate queued refresh for the same source key.
      queueRef.current = queueRef.current.filter(
        (pending) => pending.source.key !== source.key
      )

      setEntriesByKey((previous) => {
        const existing = previous[source.key]
        const keepData =
          existing &&
          existing.transport === capturedTransport &&
          existing.scopeKey === capturedScopeKey
            ? existing.data
            : undefined
        return {
          ...previous,
          [source.key]: {
            transport: capturedTransport,
            scopeKey: capturedScopeKey,
            loading: true,
            ...(keepData ? { data: keepData } : {}),
          },
        }
      })

      queueRef.current.push({
        source,
        transport: capturedTransport,
        scopeKey: capturedScopeKey,
        locale: live.locale,
        generation,
        seq,
      })
      pumpQueue()
    },
    [pumpQueue]
  )

  const refreshAll = useCallback(() => {
    for (const source of sources) {
      querySource(source)
    }
  }, [querySource, sources])

  const statesByKey = useMemo(() => {
    const visible: Record<string, PluginUsageSourceState> = {}
    if (!enabled || !hostScope.transportReady || !transport) return visible
    for (const source of sources) {
      const entry = entriesByKey[source.key]
      if (
        entry &&
        entry.transport === transport &&
        entry.scopeKey === hostScope.scopeKey
      ) {
        visible[source.key] = {
          loading: entry.loading,
          ...(entry.data ? { data: entry.data } : {}),
          ...(entry.error ? { error: entry.error } : {}),
        }
      }
    }
    return visible
  }, [
    enabled,
    entriesByKey,
    hostScope.scopeKey,
    hostScope.transportReady,
    sources,
    transport,
  ])

  return {
    sources,
    statesByKey,
    querySource,
    refreshAll,
    transportReady: hostScope.transportReady,
    transport,
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
