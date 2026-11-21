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
export const MAX_PLUGIN_WORKSPACE_ROW_BADGES = 16
export const MAX_WORKSPACE_ROW_BADGE_LABEL_CHARS = 32
export const WORKSPACE_ROW_BADGE_BATCH_SIZE = 64
export const MAX_WORKSPACE_ROW_BADGE_INPUT_BYTES = 64 * 1024
export const WORKSPACE_ROW_BADGE_MAX_CONCURRENCY = 2

const utf8Encoder = new TextEncoder()

function utf8ByteLength(value: string): number {
  return utf8Encoder.encode(value).byteLength
}

export const WORKSPACE_ROW_BADGE_TONES = [
  "muted",
  "success",
  "warning",
  "danger",
  "info",
] as const

export type PluginWorkspaceRowBadgeTone =
  (typeof WORKSPACE_ROW_BADGE_TONES)[number]

export interface PluginWorkspaceRowBadgeContribution {
  id: string
  title: string
  titleTranslations?: PluginTextTranslations
  method: string
}

export interface ResolvedPluginWorkspaceRowBadgeDeclaration {
  key: string
  pluginId: string
  pluginName: string
  id: string
  title: string
  method: string
}

export interface WorkspaceRowBadgeFolderLike {
  id: number
  parent_id?: number | null
  git_branch?: string | null
  kind?: string | null
}

export interface WorkspaceRowBadgeInputItem {
  folderId: number
  parentFolderId: number | null
  branch: string | null
}

export interface WorkspaceRowBadgeInput {
  locale: string
  workspaces: WorkspaceRowBadgeInputItem[]
}

export interface ParsedWorkspaceRowBadgeEntry {
  label: string
  tone: PluginWorkspaceRowBadgeTone
}

export interface ResolvedWorkspaceRowBadge {
  key: string
  pluginId: string
  pluginName: string
  badgeId: string
  title: string
  folderId: number
  label: string
  tone: PluginWorkspaceRowBadgeTone
}

export type PluginSidebarItemPlacement = "header" | "footer"

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
      workspaceRowBadges?: PluginWorkspaceRowBadgeContribution[]
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
    version: number
  }>()
  const [revision, setRevision] = useState(0)
  const versionRef = useRef(0)
  const refresh = useCallback(() => {
    versionRef.current += 1
    setRevision((previous) => previous + 1)
  }, [])
  useEffect(() => {
    if (!enabled || !transport) return
    let active = true
    let latest = 0
    let unsubscribe: (() => void) | undefined
    const read = (bumpVersion = false) => {
      if (typeof transport.call !== "function") return
      if (bumpVersion) versionRef.current += 1
      const request = ++latest
      const requestVersion = versionRef.current
      void Promise.resolve()
        .then(() => load(transport))
        .then(
          (data) => {
            if (active && request === latest)
              setSnapshot({ transport, load, data, version: requestVersion })
          },
          (error: unknown) => {
            if (active && request === latest)
              setSnapshot({ transport, load, error, version: requestVersion })
          }
        )
    }
    const stopReconnect = transport.onReconnect?.(() => read(true))
    if (typeof transport.subscribe === "function") {
      void transport
        .subscribe<E>(event, (payload) => {
          if (!matches || matches(payload)) read(true)
        })
        .then(
          (stop) => {
            if (active) {
              unsubscribe = stop
              read(false)
            } else stop()
          },
          () => undefined
        )
    }
    read(false)
    return () => {
      active = false
      unsubscribe?.()
      stopReconnect?.()
    }
  }, [enabled, event, load, matches, revision, transport])

  const current =
    enabled && snapshot?.transport === transport && snapshot.load === load
      ? snapshot
      : undefined
  return {
    ...(current ? { data: current.data, error: current.error } : undefined),
    version: current?.version ?? 0,
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

export function pluginWorkspaceRowBadgeKey(pluginId: string, badgeId: string) {
  return `${pluginId}:${badgeId}`
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

const WORKSPACE_ROW_BADGE_TONE_SET = new Set<string>(WORKSPACE_ROW_BADGE_TONES)

// Rejects C0/C1 control characters (including \t, \n, \r, \0, ESC, DEL),
// Unicode line/paragraph separators, zero-width space, bidi overrides/isolates,
// and BOM.
const WORKSPACE_ROW_BADGE_FORBIDDEN_CHARS_RE =
  /[\p{Cc}\u200B\u2028\u2029\u202A-\u202E\u2066-\u2069\uFEFF]/u

export function sanitizeWorkspaceRowBadgeLabel(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length === 0) return null
  if (raw !== raw.trim()) return null
  if (WORKSPACE_ROW_BADGE_FORBIDDEN_CHARS_RE.test(raw)) return null
  if (Array.from(raw).length > MAX_WORKSPACE_ROW_BADGE_LABEL_CHARS) return null
  return raw
}

export function parseWorkspaceRowBadgeTone(
  raw: unknown
): PluginWorkspaceRowBadgeTone | null {
  if (raw === undefined) return "muted"
  if (typeof raw === "string" && WORKSPACE_ROW_BADGE_TONE_SET.has(raw)) {
    return raw as PluginWorkspaceRowBadgeTone
  }
  return null
}

export function parseWorkspaceRowBadgeResults(
  raw: unknown,
  allowedFolderIds: ReadonlySet<number>
): Map<number, ParsedWorkspaceRowBadgeEntry> {
  const results = new Map<number, ParsedWorkspaceRowBadgeEntry>()
  if (!Array.isArray(raw) || allowedFolderIds.size === 0) return results
  for (const item of raw) {
    if (!item || typeof item !== "object") continue
    const record = item as Record<string, unknown>
    const folderId = record.folderId
    if (
      typeof folderId !== "number" ||
      !Number.isSafeInteger(folderId) ||
      !allowedFolderIds.has(folderId) ||
      results.has(folderId)
    ) {
      continue
    }
    const label = sanitizeWorkspaceRowBadgeLabel(record.label)
    if (!label) continue
    const tone = parseWorkspaceRowBadgeTone(record.tone)
    if (!tone) continue
    results.set(folderId, { label, tone })
  }
  return results
}

export function selectPluginWorkspaceRowBadges(
  plugins: readonly InstalledPlugin[] | undefined,
  locale?: string
): ResolvedPluginWorkspaceRowBadgeDeclaration[] {
  if (!plugins?.length) return []
  const items: ResolvedPluginWorkspaceRowBadgeDeclaration[] = []
  const seenPlugins = new Set<string>()
  for (const plugin of plugins) {
    if (seenPlugins.has(plugin.manifest.id)) continue
    seenPlugins.add(plugin.manifest.id)
    if (!plugin.enabled) continue
    const rawMethods = plugin.manifest.server?.methods
    if (!Array.isArray(rawMethods) || rawMethods.length === 0) continue
    const declaredMethods = new Set(
      rawMethods.filter(
        (method): method is string =>
          typeof method === "string" && method.trim().length > 0
      )
    )
    if (declaredMethods.size === 0) continue
    const badges = plugin.manifest.contributes?.workspaceRowBadges
    if (!badges?.length) continue
    const pluginName =
      resolvePluginText(
        plugin.manifest.name,
        plugin.manifest.nameTranslations,
        locale
      ).trim() || plugin.manifest.id
    const seenIds = new Set<string>()
    let pluginValidCount = 0
    for (const badge of badges) {
      if (pluginValidCount >= MAX_PLUGIN_WORKSPACE_ROW_BADGES) break
      if (
        typeof badge.id !== "string" ||
        typeof badge.title !== "string" ||
        typeof badge.method !== "string"
      ) {
        continue
      }
      const id = badge.id.trim()
      const title = resolvePluginText(
        badge.title,
        badge.titleTranslations,
        locale
      ).trim()
      if (!id || !title || seenIds.has(id)) continue
      // Only allow methods explicitly declared in the SAME plugin's server.methods.
      if (!declaredMethods.has(badge.method)) continue
      seenIds.add(id)
      pluginValidCount += 1
      items.push({
        key: pluginWorkspaceRowBadgeKey(plugin.manifest.id, id),
        pluginId: plugin.manifest.id,
        pluginName,
        id,
        title,
        method: badge.method,
      })
    }
  }
  return items
}

export function buildWorkspaceRowBadgeInputs(
  folders: readonly WorkspaceRowBadgeFolderLike[],
  branches?: ReadonlyMap<number, string | null>
): WorkspaceRowBadgeInputItem[] {
  const inputs: WorkspaceRowBadgeInputItem[] = []
  const seen = new Set<number>()
  for (const folder of folders) {
    if (folder.kind === "chat") continue
    if (!Number.isSafeInteger(folder.id) || seen.has(folder.id)) continue
    seen.add(folder.id)
    const parentFolderId =
      typeof folder.parent_id === "number" &&
      Number.isSafeInteger(folder.parent_id)
        ? folder.parent_id
        : null
    const branch = branches?.has(folder.id)
      ? (branches.get(folder.id) ?? null)
      : (folder.git_branch ?? null)
    inputs.push({
      folderId: folder.id,
      parentFolderId,
      branch,
    })
  }
  return inputs
}

export interface ChunkWorkspaceRowBadgeInputsOptions {
  batchSize?: number
  maxBytes?: number
  locale?: string
}

function fitWorkspaceItemToByteLimit(
  item: WorkspaceRowBadgeInputItem,
  baseBytes: number,
  maxBytes: number
): WorkspaceRowBadgeInputItem {
  if (
    item.branch === null ||
    baseBytes + utf8ByteLength(JSON.stringify(item)) <= maxBytes
  ) {
    return item
  }
  // When a single workspace's branch alone overflows the 64 KiB RPC message
  // limit, omit it (`null`) rather than truncating it into a different-looking
  // branch name. Normal branches stay verbatim.
  return { ...item, branch: null }
}

export function chunkWorkspaceRowBadgeInputs(
  workspaces: readonly WorkspaceRowBadgeInputItem[],
  options?: number | ChunkWorkspaceRowBadgeInputsOptions
): WorkspaceRowBadgeInputItem[][] {
  if (workspaces.length === 0) return []
  const resolved =
    typeof options === "number" ? { batchSize: options } : (options ?? {})
  const size =
    typeof resolved.batchSize === "number" &&
    Number.isSafeInteger(resolved.batchSize) &&
    resolved.batchSize > 0
      ? resolved.batchSize
      : WORKSPACE_ROW_BADGE_BATCH_SIZE
  const maxBytes =
    typeof resolved.maxBytes === "number" &&
    Number.isSafeInteger(resolved.maxBytes) &&
    resolved.maxBytes > 0
      ? resolved.maxBytes
      : MAX_WORKSPACE_ROW_BADGE_INPUT_BYTES
  const locale = resolved.locale ?? ""
  const baseBytes = utf8ByteLength(JSON.stringify({ locale, workspaces: [] }))

  const batches: WorkspaceRowBadgeInputItem[][] = []
  let current: WorkspaceRowBadgeInputItem[] = []
  let currentBytes = baseBytes

  for (const rawItem of workspaces) {
    const item = fitWorkspaceItemToByteLimit(rawItem, baseBytes, maxBytes)
    const itemBytes = utf8ByteLength(JSON.stringify(item))
    const nextBytes =
      current.length === 0
        ? baseBytes + itemBytes
        : currentBytes + 1 + itemBytes

    if (
      current.length > 0 &&
      (current.length >= size || nextBytes > maxBytes)
    ) {
      batches.push(current)
      current = [item]
      currentBytes = baseBytes + itemBytes
    } else {
      current.push(item)
      currentBytes = nextBytes
    }
  }
  if (current.length > 0) {
    batches.push(current)
  }
  return batches
}

interface WorkspaceRowBadgeMethodGroup {
  key: string
  pluginId: string
  method: string
}

interface WorkspaceRowBadgesSnapshot {
  transport: Transport
  resultsByMethod: Map<string, Map<number, ParsedWorkspaceRowBadgeEntry>>
}

const EMPTY_WORKSPACE_ROW_BADGES: ReadonlyMap<
  number,
  readonly ResolvedWorkspaceRowBadge[]
> = new Map()

interface PendingWorkspaceBadgeTask {
  isActive: () => boolean
  run: () => Promise<void>
  onSkip: () => void
}

/**
 * Per-transport bounded concurrency queue shared across refresh epochs.
 * In-flight host RPCs hold their slot until they actually settle so rapid
 * consecutive refreshes on the same host never stack past
 * `WORKSPACE_ROW_BADGE_MAX_CONCURRENCY`, while distinct `Transport` instances
 * maintain independent queues and never block each other.
 */
class WorkspaceBadgeTransportQueue {
  private inFlight = 0
  private readonly queue: PendingWorkspaceBadgeTask[] = []

  enqueue(isActive: () => boolean, fn: () => Promise<void>): () => void {
    let finished = false
    const finish = () => {
      finished = true
    }
    const task: PendingWorkspaceBadgeTask = {
      isActive,
      run: async () => {
        try {
          await fn()
        } finally {
          finish()
        }
      },
      onSkip: finish,
    }
    this.queue.push(task)
    this.drain()
    return () => {
      if (finished) return
      const index = this.queue.indexOf(task)
      if (index >= 0) {
        this.queue.splice(index, 1)
        task.onSkip()
      }
    }
  }

  private drain() {
    while (this.inFlight < WORKSPACE_ROW_BADGE_MAX_CONCURRENCY) {
      const next = this.queue.shift()
      if (!next) return
      if (!next.isActive()) {
        next.onSkip()
        continue
      }
      this.inFlight += 1
      void next.run().finally(() => {
        this.inFlight -= 1
        this.drain()
      })
    }
  }
}

const transportBadgeQueues = new WeakMap<
  Transport,
  WorkspaceBadgeTransportQueue
>()

function getWorkspaceBadgeTransportQueue(
  transport: Transport
): WorkspaceBadgeTransportQueue {
  let queue = transportBadgeQueues.get(transport)
  if (!queue) {
    queue = new WorkspaceBadgeTransportQueue()
    transportBadgeQueues.set(transport, queue)
  }
  return queue
}

function workspaceRowBadgeMethodKey(pluginId: string, method: string) {
  return `${pluginId}\0${method}`
}

export function useWorkspaceRowBadges(
  workspaces: readonly WorkspaceRowBadgeInputItem[],
  locale: string
): ReadonlyMap<number, readonly ResolvedWorkspaceRowBadge[]> {
  const {
    data: hostPlugins,
    transport,
    version: catalogVersion,
  } = useHostPlugins(true)
  const [snapshot, setSnapshot] = useState<WorkspaceRowBadgesSnapshot>()

  const declarations = useMemo(
    () => selectPluginWorkspaceRowBadges(hostPlugins, locale),
    [hostPlugins, locale]
  )

  const methodGroupsSignature = useMemo(() => {
    const groups: WorkspaceRowBadgeMethodGroup[] = []
    const seen = new Set<string>()
    for (const decl of declarations) {
      const key = workspaceRowBadgeMethodKey(decl.pluginId, decl.method)
      if (seen.has(key)) continue
      seen.add(key)
      groups.push({ key, pluginId: decl.pluginId, method: decl.method })
    }
    return JSON.stringify(groups)
  }, [declarations])

  const stableMethodGroups = useMemo<WorkspaceRowBadgeMethodGroup[]>(
    () => JSON.parse(methodGroupsSignature) as WorkspaceRowBadgeMethodGroup[],
    [methodGroupsSignature]
  )

  const workspaceSignature = useMemo(
    () => JSON.stringify(workspaces),
    [workspaces]
  )

  const stableWorkspaces = useMemo<WorkspaceRowBadgeInputItem[]>(
    () => JSON.parse(workspaceSignature) as WorkspaceRowBadgeInputItem[],
    [workspaceSignature]
  )

  useEffect(() => {
    if (!transport || typeof transport.call !== "function") return
    let active = true

    if (stableMethodGroups.length === 0 || stableWorkspaces.length === 0) {
      void Promise.resolve().then(() => {
        if (active) setSnapshot((prev) => (prev ? undefined : prev))
      })
      return () => {
        active = false
      }
    }

    const batches = chunkWorkspaceRowBadgeInputs(stableWorkspaces, { locale })
    const epochResults = new Map<
      string,
      Map<number, ParsedWorkspaceRowBadgeEntry>
    >()
    const settledGroups = new Set<string>()

    const commit = () => {
      if (!active) return
      setSnapshot((prev) => {
        const combined = new Map<
          string,
          Map<number, ParsedWorkspaceRowBadgeEntry>
        >()
        for (const group of stableMethodGroups) {
          if (settledGroups.has(group.key)) {
            const fresh = epochResults.get(group.key)
            if (fresh && fresh.size > 0) combined.set(group.key, fresh)
          } else if (prev?.transport === transport) {
            const existing = prev.resultsByMethod.get(group.key)
            if (existing && existing.size > 0) {
              combined.set(group.key, existing)
            }
          }
        }
        return { transport, resultsByMethod: combined }
      })
    }

    const queue = getWorkspaceBadgeTransportQueue(transport)
    const cancelQueued: (() => void)[] = []

    for (const group of stableMethodGroups) {
      const cancel = queue.enqueue(
        () => active,
        async () => {
          const merged = new Map<number, ParsedWorkspaceRowBadgeEntry>()
          for (const batch of batches) {
            if (!active) return
            const allowedIds = new Set(batch.map((item) => item.folderId))
            try {
              const raw = await transport.call<unknown>("host_plugins_call", {
                pluginId: group.pluginId,
                method: group.method,
                input: {
                  locale,
                  workspaces: batch,
                } satisfies WorkspaceRowBadgeInput,
              })
              if (!active) return
              const parsed = parseWorkspaceRowBadgeResults(raw, allowedIds)
              for (const [folderId, entry] of parsed) {
                if (!merged.has(folderId)) merged.set(folderId, entry)
              }
            } catch {
              // Isolate failing plugin methods / batches so other badges and
              // the sidebar continue rendering cleanly.
            }
          }
          if (!active) return
          epochResults.set(group.key, merged)
          settledGroups.add(group.key)
          commit()
        }
      )
      cancelQueued.push(cancel)
    }

    return () => {
      active = false
      for (const cancel of cancelQueued) {
        cancel()
      }
    }
  }, [catalogVersion, locale, stableMethodGroups, stableWorkspaces, transport])

  return useMemo(() => {
    if (
      !transport ||
      !snapshot ||
      snapshot.transport !== transport ||
      declarations.length === 0 ||
      stableWorkspaces.length === 0
    ) {
      return EMPTY_WORKSPACE_ROW_BADGES
    }
    const byFolder = new Map<number, ResolvedWorkspaceRowBadge[]>()
    for (const workspace of stableWorkspaces) {
      let folderBadges: ResolvedWorkspaceRowBadge[] | undefined
      for (const decl of declarations) {
        const methodKey = workspaceRowBadgeMethodKey(decl.pluginId, decl.method)
        const entry = snapshot.resultsByMethod
          .get(methodKey)
          ?.get(workspace.folderId)
        if (!entry) continue
        if (!folderBadges) folderBadges = []
        folderBadges.push({
          key: decl.key,
          pluginId: decl.pluginId,
          pluginName: decl.pluginName,
          badgeId: decl.id,
          title: decl.title,
          folderId: workspace.folderId,
          label: entry.label,
          tone: entry.tone,
        })
      }
      if (folderBadges && folderBadges.length > 0) {
        byFolder.set(workspace.folderId, folderBadges)
      }
    }
    return byFolder.size > 0 ? byFolder : EMPTY_WORKSPACE_ROW_BADGES
  }, [declarations, snapshot, stableWorkspaces, transport])
}

export function hostPluginSessionScopeKey(
  context: HostPluginSessionContext
): string {
  return `${context.folderId ?? "none"}:${context.conversationId ?? "draft"}:${context.sessionKey}`
}

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
  if (utf8ByteLength(normalized) > MAX_PLUGIN_COMPOSER_INSERT_BYTES) {
    throw new Error("Composer text exceeds 16 KiB limit")
  }
  return normalized
}
