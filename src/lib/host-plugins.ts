"use client"

import { useCallback, useEffect, useState, useSyncExternalStore } from "react"
import {
  parsePluginThemePalette,
  type PluginThemePalette,
} from "@/lib/custom-style"
import * as transportModule from "@/lib/transport"
import { getTransport, type Transport } from "@/lib/transport"

export type PluginTextTranslations = Record<string, string>

export const MAX_PLUGIN_SCREENS = 16
export const MAX_PLUGIN_SIDEBAR_ITEMS = 16
export const MAX_PLUGIN_SLASH_COMMANDS = 16
export const MAX_PLUGIN_SLASH_COMMAND_NAME_LENGTH = 48
export const MAX_PLUGIN_SLASH_COMMAND_ARGS_BYTES = 8 * 1024
export const MAX_PLUGIN_SLASH_COMMAND_MESSAGE_CHARS = 512

export type PluginSidebarItemPlacement = "header" | "footer"
export type PluginSlashCommandScope = "workspace" | "session"

export interface PluginSlashCommandContribution {
  name: string
  description: string
  descriptionTranslations?: PluginTextTranslations
  argumentHint?: string
  scope: PluginSlashCommandScope
  method: string
}

export interface ResolvedPluginSlashCommand {
  key: string
  pluginId: string
  pluginName: string
  name: string
  description: string
  argumentHint?: string
  scope: PluginSlashCommandScope
  method: string
}

export type PluginSlashCommandInput =
  | {
      name: string
      args: string
      folderId: number
      conversationId: null
    }
  | {
      name: string
      args: string
      folderId: number | null
      conversationId: number
    }

export type PluginSlashCommandOutput = null | { message: string }

export interface MatchedPluginSlashCommand {
  command: ResolvedPluginSlashCommand
  args: string
}

export type BuildPluginSlashCommandInputResult =
  | { ok: true; input: PluginSlashCommandInput }
  | { ok: false; reason: "outOfScope" | "argsTooLong" }

export type ParsePluginSlashCommandOutputResult =
  | { ok: true; message: string | null }
  | { ok: false }

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
      slashCommands?: PluginSlashCommandContribution[]
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
  return transport !== null && getReadyHostTransportSnapshot() === transport
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

export function pluginSlashCommandKey(pluginId: string, name: string) {
  return `${pluginId}:${name}`
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

export function hostPluginSessionScopeKey(
  context: HostPluginSessionContext
): string {
  return `${context.folderId ?? "none"}:${context.conversationId ?? "draft"}:${context.sessionKey}`
}

const utf8Encoder = new TextEncoder()

const PLUGIN_SLASH_COMMAND_NAME_RE = /^[a-z][a-z0-9-]{0,47}$/
const PLUGIN_LABEL_CONTROL_CHAR_RE = /\p{Cc}/u
// Reject C0/C1 control chars (except \n after CRLF normalization), zero-width
// space, Unicode line/paragraph separators, bidi overrides/isolates, and BOM.
const PLUGIN_SLASH_MESSAGE_FORBIDDEN_RE =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u200B\u2028\u2029\u202A-\u202E\u2066-\u2069\uFEFF]/

function isValidPluginManifestLabel(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    Array.from(value).length <= 100 &&
    !PLUGIN_LABEL_CONTROL_CHAR_RE.test(value)
  )
}

function isPositiveSafeId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
}

export function isPluginSlashCommandInScope(
  scope: PluginSlashCommandScope,
  context: HostPluginSessionContext | null | undefined
): boolean {
  if (!context) return false
  if (scope === "workspace") return isPositiveSafeId(context.folderId)
  if (scope === "session") return isPositiveSafeId(context.conversationId)
  return false
}

export function selectPluginSlashCommands(
  plugins: readonly InstalledPlugin[] | undefined,
  context: HostPluginSessionContext | null | undefined,
  locale?: string,
  reservedNames?: ReadonlySet<string>
): ResolvedPluginSlashCommand[] {
  if (!plugins?.length || !context) return []
  const items: ResolvedPluginSlashCommand[] = []
  const seenPlugins = new Set<string>()
  const seenActiveNames = new Set<string>()

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
    const commands = plugin.manifest.contributes?.slashCommands
    if (!commands?.length) continue

    const pluginName =
      resolvePluginText(
        plugin.manifest.name,
        plugin.manifest.nameTranslations,
        locale
      ).trim() || plugin.manifest.id
    const seenPluginNames = new Set<string>()
    let pluginValidCount = 0

    for (const command of commands) {
      if (pluginValidCount >= MAX_PLUGIN_SLASH_COMMANDS) break
      if (
        typeof command.name !== "string" ||
        !PLUGIN_SLASH_COMMAND_NAME_RE.test(command.name) ||
        seenPluginNames.has(command.name)
      ) {
        continue
      }
      if (command.scope !== "workspace" && command.scope !== "session") {
        continue
      }
      if (
        typeof command.method !== "string" ||
        !declaredMethods.has(command.method)
      ) {
        continue
      }
      if (!isValidPluginManifestLabel(command.description)) continue
      const localizedDescription = resolvePluginText(
        command.description,
        command.descriptionTranslations,
        locale
      )
      if (!isValidPluginManifestLabel(localizedDescription)) continue
      const argumentHint = command.argumentHint
      if (
        argumentHint !== undefined &&
        !isValidPluginManifestLabel(argumentHint)
      ) {
        continue
      }

      seenPluginNames.add(command.name)
      pluginValidCount += 1

      if (!isPluginSlashCommandInScope(command.scope, context)) continue
      if (reservedNames?.has(command.name)) continue
      if (seenActiveNames.has(command.name)) continue

      seenActiveNames.add(command.name)
      items.push({
        key: pluginSlashCommandKey(plugin.manifest.id, command.name),
        pluginId: plugin.manifest.id,
        pluginName,
        name: command.name,
        description: localizedDescription.trim(),
        ...(argumentHint !== undefined
          ? { argumentHint: argumentHint.trim() }
          : {}),
        scope: command.scope,
        method: command.method,
      })
    }
  }
  return items
}

export function matchPluginSlashCommandText(
  rawText: string,
  commands: readonly ResolvedPluginSlashCommand[]
): MatchedPluginSlashCommand | null {
  if (commands.length === 0) return null
  const trimmed = rawText.trim()
  if (!trimmed.startsWith("/")) return null
  const match = /^\/([^\s]+)(?:\s+([\s\S]*))?$/.exec(trimmed)
  if (!match) return null
  const commandName = match[1]
  const command = commands.find((item) => item.name === commandName)
  if (!command) return null
  return {
    command,
    args: (match[2] ?? "").trim(),
  }
}

export function buildPluginSlashCommandInput(
  command: Pick<ResolvedPluginSlashCommand, "name" | "scope">,
  args: string,
  context: HostPluginSessionContext | null | undefined
): BuildPluginSlashCommandInputResult {
  if (!isPluginSlashCommandInScope(command.scope, context) || !context) {
    return { ok: false, reason: "outOfScope" }
  }
  const trimmedArgs = args.trim()
  if (
    utf8Encoder.encode(trimmedArgs).byteLength >
    MAX_PLUGIN_SLASH_COMMAND_ARGS_BYTES
  ) {
    return { ok: false, reason: "argsTooLong" }
  }
  if (command.scope === "workspace") {
    return {
      ok: true,
      input: {
        name: command.name,
        args: trimmedArgs,
        folderId: context.folderId as number,
        conversationId: null,
      },
    }
  }
  return {
    ok: true,
    input: {
      name: command.name,
      args: trimmedArgs,
      folderId: isPositiveSafeId(context.folderId) ? context.folderId : null,
      conversationId: context.conversationId as number,
    },
  }
}

export function parsePluginSlashCommandOutput(
  raw: unknown
): ParsePluginSlashCommandOutputResult {
  if (raw === null) {
    return { ok: true, message: null }
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false }
  }
  const record = raw as Record<string, unknown>
  const keys = Object.keys(record)
  if (keys.length !== 1 || keys[0] !== "message") {
    return { ok: false }
  }
  if (typeof record.message !== "string") {
    return { ok: false }
  }
  const normalized = record.message.replace(/\r\n?/g, "\n").trim()
  if (
    normalized.length === 0 ||
    PLUGIN_SLASH_MESSAGE_FORBIDDEN_RE.test(normalized) ||
    Array.from(normalized).length > MAX_PLUGIN_SLASH_COMMAND_MESSAGE_CHARS
  ) {
    return { ok: false }
  }
  return { ok: true, message: normalized }
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
  if (
    utf8Encoder.encode(normalized).byteLength > MAX_PLUGIN_COMPOSER_INSERT_BYTES
  ) {
    throw new Error("Composer text exceeds 16 KiB limit")
  }
  return normalized
}
