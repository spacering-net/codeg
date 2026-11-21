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
export const MAX_PLUGIN_NEW_WORKSPACE_ITEMS = 16
export const MAX_NEW_WORKSPACE_COMBOBOX_OPTIONS = 20
export const MAX_NEW_WORKSPACE_SELECT_OPTIONS = 32
export const MAX_NEW_WORKSPACE_REF_BYTES = 256
export const MAX_NEW_WORKSPACE_ROOT_PATH_BYTES = 1024
export const MAX_NEW_WORKSPACE_METADATA_KEYS = 16
export const MAX_NEW_WORKSPACE_METADATA_VALUE_BYTES = 512
export const MAX_NEW_WORKSPACE_METADATA_BYTES = 4 * 1024

export type PluginSidebarItemPlacement = "header" | "footer"

export type NewWorkspaceTarget = "workspace" | "worktree" | "all"
export type NewWorkspaceFormTarget = Exclude<NewWorkspaceTarget, "all">
export type NewWorkspaceMetadataValue = string | number | boolean | null

export interface NewWorkspacePatch {
  branch?: string | null
  baseRef?: string | null
  rootPath?: string | null
  metadata?: Record<string, NewWorkspaceMetadataValue>
}

export interface NewWorkspaceOption {
  id: string
  label: string
  labelTranslations?: PluginTextTranslations
  description?: string
  descriptionTranslations?: PluginTextTranslations
  patch?: NewWorkspacePatch
}

export interface ResolvedNewWorkspaceOption {
  id: string
  label: string
  description?: string
  patch?: NewWorkspacePatch
}

type NewWorkspacePlaceholderFields = {
  placeholder?: string
  placeholderTranslations?: PluginTextTranslations
}

type NewWorkspaceToggleControl = {
  kind: "toggle"
  defaultValue?: boolean
  onChangeMethod?: string
  enabledPatch?: NewWorkspacePatch
  disabledPatch?: NewWorkspacePatch
} & (
  | { onChangeMethod: string }
  | { enabledPatch: NewWorkspacePatch }
  | { disabledPatch: NewWorkspacePatch }
)

export type NewWorkspaceItemControl =
  | ({ kind: "combobox"; searchMethod: string } & NewWorkspacePlaceholderFields)
  | ({
      kind: "select"
    } & NewWorkspacePlaceholderFields &
      (
        | { options: NewWorkspaceOption[]; optionsMethod?: never }
        | { options?: never; optionsMethod: string }
      ))
  | NewWorkspaceToggleControl
  | { kind: "action"; method: string }

export interface NewWorkspaceItemContribution {
  id: string
  title: string
  titleTranslations?: PluginTextTranslations
  description?: string
  descriptionTranslations?: PluginTextTranslations
  target?: NewWorkspaceTarget
  control: NewWorkspaceItemControl
}

export type ResolvedNewWorkspaceItemControl =
  | { kind: "combobox"; searchMethod: string; placeholder?: string }
  | {
      kind: "select"
      placeholder?: string
      options?: ResolvedNewWorkspaceOption[]
      optionsMethod?: string
    }
  | {
      kind: "toggle"
      defaultValue: boolean
      onChangeMethod?: string
      enabledPatch?: NewWorkspacePatch
      disabledPatch?: NewWorkspacePatch
    }
  | { kind: "action"; method: string }

export interface ResolvedPluginNewWorkspaceItem {
  key: string
  pluginId: string
  pluginName: string
  id: string
  title: string
  description?: string
  target: NewWorkspaceTarget
  control: ResolvedNewWorkspaceItemControl
}

export interface NewWorkspaceMethodInput {
  itemId: string
  target: NewWorkspaceFormTarget
  query?: string
  value?: boolean
  folderPath?: string
  baseRef?: string
  branch?: string
  metadata?: Record<string, NewWorkspaceMetadataValue>
  locale: string
}

export interface NewWorkspaceOptionsResult {
  items: Pick<NewWorkspaceOption, "id" | "label" | "description" | "patch">[]
}

export interface NewWorkspacePatchResult {
  patch?: NewWorkspacePatch
}

export interface NewWorkspaceDraftState {
  branch?: string
  baseRef?: string
  rootPath?: string
  metadata: Record<string, Exclude<NewWorkspaceMetadataValue, null>>
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
      newWorkspaceItems?: NewWorkspaceItemContribution[]
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

export function pluginNewWorkspaceItemKey(pluginId: string, itemId: string) {
  return `${pluginId}:${itemId}`
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

const NEW_WORKSPACE_SLUG_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/
const NEW_WORKSPACE_METADATA_KEY_RE = /^[a-zA-Z0-9._-]{1,64}$/
const CONTROL_CHAR_RE = /[\u0000-\u001f\u007f-\u009f]/
const LINE_DISALLOWED_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/
const REF_FORBIDDEN_CHARS_RE = /[ ~^:?*[\\]/

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function isValidNewWorkspaceLine(value: string, maxBytes: number): boolean {
  return (
    value.trim().length > 0 &&
    utf8Encoder.encode(value).byteLength <= maxBytes &&
    !LINE_DISALLOWED_RE.test(value)
  )
}

function isValidNewWorkspaceRef(value: string): boolean {
  if (!isValidNewWorkspaceLine(value, MAX_NEW_WORKSPACE_REF_BYTES)) {
    return false
  }
  if (
    value.startsWith("-") ||
    value.endsWith(".") ||
    value === "@" ||
    value.includes("..") ||
    value.includes("@{") ||
    REF_FORBIDDEN_CHARS_RE.test(value)
  ) {
    return false
  }
  return value
    .split("/")
    .every(
      (part) =>
        part.length > 0 && !part.startsWith(".") && !part.endsWith(".lock")
    )
}

function resolveOptionalNewWorkspaceText(
  fallback: string | undefined,
  translations: PluginTextTranslations | undefined,
  locale?: string
): string | undefined {
  if (typeof fallback !== "string") return undefined
  const trimmed = fallback.trim()
  if (!trimmed) return undefined
  const resolved = resolvePluginText(trimmed, translations, locale).trim()
  return resolved || undefined
}

const PATCH_ALLOWED_KEYS = new Set([
  "branch",
  "baseRef",
  "rootPath",
  "metadata",
])
const OPTION_ALLOWED_KEYS = new Set(["id", "label", "description", "patch"])

export function validateNewWorkspacePatch(raw: unknown): NewWorkspacePatch {
  if (!isPlainRecord(raw)) {
    throw new Error("Invalid new workspace patch")
  }
  for (const key of Object.keys(raw)) {
    if (!PATCH_ALLOWED_KEYS.has(key)) {
      throw new Error(`Unsupported patch field: ${key}`)
    }
  }

  const patch: NewWorkspacePatch = {}

  if ("branch" in raw && raw.branch !== undefined) {
    if (raw.branch === null) {
      patch.branch = null
    } else if (
      typeof raw.branch === "string" &&
      isValidNewWorkspaceRef(raw.branch)
    ) {
      patch.branch = raw.branch
    } else {
      throw new Error("Invalid branch suggestion")
    }
  }

  if ("baseRef" in raw && raw.baseRef !== undefined) {
    if (raw.baseRef === null) {
      patch.baseRef = null
    } else if (
      typeof raw.baseRef === "string" &&
      isValidNewWorkspaceRef(raw.baseRef)
    ) {
      patch.baseRef = raw.baseRef
    } else {
      throw new Error("Invalid baseRef suggestion")
    }
  }

  if ("rootPath" in raw && raw.rootPath !== undefined) {
    if (raw.rootPath === null) {
      patch.rootPath = null
    } else if (
      typeof raw.rootPath === "string" &&
      isValidNewWorkspaceLine(raw.rootPath, MAX_NEW_WORKSPACE_ROOT_PATH_BYTES)
    ) {
      patch.rootPath = raw.rootPath
    } else {
      throw new Error("Invalid rootPath suggestion")
    }
  }

  if ("metadata" in raw && raw.metadata !== undefined) {
    if (!isPlainRecord(raw.metadata)) {
      throw new Error("Invalid metadata patch")
    }
    const entries = Object.entries(raw.metadata)
    if (entries.length > MAX_NEW_WORKSPACE_METADATA_KEYS) {
      throw new Error("Too many metadata keys")
    }
    const metadata: Record<string, NewWorkspaceMetadataValue> = {}
    for (const [key, value] of entries) {
      if (!NEW_WORKSPACE_METADATA_KEY_RE.test(key)) {
        throw new Error(`Invalid metadata key: ${key}`)
      }
      if (value === null || typeof value === "boolean") {
        metadata[key] = value
      } else if (typeof value === "number" && Number.isFinite(value)) {
        metadata[key] = value
      } else if (typeof value === "string") {
        if (
          utf8Encoder.encode(value).byteLength >
            MAX_NEW_WORKSPACE_METADATA_VALUE_BYTES ||
          CONTROL_CHAR_RE.test(value)
        ) {
          throw new Error(`Invalid metadata value for ${key}`)
        }
        metadata[key] = value
      } else {
        throw new Error(`Unsupported metadata value for ${key}`)
      }
    }
    if (
      utf8Encoder.encode(JSON.stringify(metadata)).byteLength >
      MAX_NEW_WORKSPACE_METADATA_BYTES
    ) {
      throw new Error("Metadata patch exceeds 4 KiB limit")
    }
    patch.metadata = metadata
  }

  return patch
}

function isPatchEmpty(patch: NewWorkspacePatch | undefined): boolean {
  if (!patch) return true
  return (
    !("branch" in patch) &&
    !("baseRef" in patch) &&
    !("rootPath" in patch) &&
    (!patch.metadata || Object.keys(patch.metadata).length === 0)
  )
}

export function validateNewWorkspaceOptionsResult(
  raw: unknown,
  kind: "combobox" | "select"
): ResolvedNewWorkspaceOption[] {
  if (!isPlainRecord(raw) || !Array.isArray(raw.items)) {
    throw new Error("Invalid new workspace options result")
  }
  for (const key of Object.keys(raw)) {
    if (key !== "items") {
      throw new Error(`Unsupported options result field: ${key}`)
    }
  }
  const maxItems =
    kind === "combobox"
      ? MAX_NEW_WORKSPACE_COMBOBOX_OPTIONS
      : MAX_NEW_WORKSPACE_SELECT_OPTIONS
  if (raw.items.length > maxItems) {
    throw new Error(`Too many ${kind} options`)
  }
  const seenIds = new Set<string>()
  const items: ResolvedNewWorkspaceOption[] = []
  for (const entry of raw.items) {
    if (!isPlainRecord(entry)) {
      throw new Error("Invalid option entry")
    }
    for (const key of Object.keys(entry)) {
      if (!OPTION_ALLOWED_KEYS.has(key)) {
        throw new Error(`Unsupported option field: ${key}`)
      }
    }
    if (
      typeof entry.id !== "string" ||
      !NEW_WORKSPACE_SLUG_RE.test(entry.id) ||
      seenIds.has(entry.id)
    ) {
      throw new Error("Invalid or duplicate option id")
    }
    if (
      typeof entry.label !== "string" ||
      !isValidNewWorkspaceLine(entry.label, 256)
    ) {
      throw new Error("Invalid option label")
    }
    let description: string | undefined
    if (entry.description !== undefined) {
      if (
        typeof entry.description !== "string" ||
        !isValidNewWorkspaceLine(entry.description, 512)
      ) {
        throw new Error("Invalid option description")
      }
      description = entry.description.trim()
    }
    const patch =
      entry.patch !== undefined
        ? validateNewWorkspacePatch(entry.patch)
        : undefined
    seenIds.add(entry.id)
    items.push({
      id: entry.id,
      label: entry.label.trim(),
      ...(description ? { description } : {}),
      ...(patch ? { patch } : {}),
    })
  }
  return items
}

export function validateNewWorkspacePatchResult(
  raw: unknown
): NewWorkspacePatch | undefined {
  if (!isPlainRecord(raw)) {
    throw new Error("Invalid new workspace patch result")
  }
  for (const key of Object.keys(raw)) {
    if (key !== "patch") {
      throw new Error(`Unsupported patch result field: ${key}`)
    }
  }
  if (raw.patch === undefined) return undefined
  return validateNewWorkspacePatch(raw.patch)
}

export function applyNewWorkspacePatch(
  state: NewWorkspaceDraftState,
  patch?: NewWorkspacePatch | null
): NewWorkspaceDraftState {
  if (!patch) return state
  let nextBranch = state.branch
  if ("branch" in patch && patch.branch !== undefined) {
    nextBranch = patch.branch === null ? undefined : patch.branch
  }
  let nextBaseRef = state.baseRef
  if ("baseRef" in patch && patch.baseRef !== undefined) {
    nextBaseRef = patch.baseRef === null ? undefined : patch.baseRef
  }
  let nextRootPath = state.rootPath
  if ("rootPath" in patch && patch.rootPath !== undefined) {
    nextRootPath = patch.rootPath === null ? undefined : patch.rootPath
  }
  let nextMetadata = state.metadata
  if (patch.metadata && Object.keys(patch.metadata).length > 0) {
    nextMetadata = { ...state.metadata }
    for (const [key, value] of Object.entries(patch.metadata)) {
      if (value === null) {
        delete nextMetadata[key]
      } else {
        nextMetadata[key] = value
      }
    }
  }
  return {
    ...(nextBranch !== undefined ? { branch: nextBranch } : {}),
    ...(nextBaseRef !== undefined ? { baseRef: nextBaseRef } : {}),
    ...(nextRootPath !== undefined ? { rootPath: nextRootPath } : {}),
    metadata: nextMetadata,
  }
}

function resolveStaticSelectOptions(
  rawOptions: readonly NewWorkspaceOption[],
  locale?: string
): ResolvedNewWorkspaceOption[] | null {
  if (
    rawOptions.length === 0 ||
    rawOptions.length > MAX_NEW_WORKSPACE_SELECT_OPTIONS
  ) {
    return null
  }
  const seenIds = new Set<string>()
  const resolved: ResolvedNewWorkspaceOption[] = []
  for (const option of rawOptions) {
    if (
      typeof option.id !== "string" ||
      !NEW_WORKSPACE_SLUG_RE.test(option.id) ||
      seenIds.has(option.id)
    ) {
      return null
    }
    const fallbackLabel =
      typeof option.label === "string" ? option.label.trim() : ""
    if (!fallbackLabel) return null
    const label = resolvePluginText(
      fallbackLabel,
      option.labelTranslations,
      locale
    ).trim()
    if (!label) return null
    const description = resolveOptionalNewWorkspaceText(
      option.description,
      option.descriptionTranslations,
      locale
    )
    let patch: NewWorkspacePatch | undefined
    if (option.patch !== undefined) {
      try {
        patch = validateNewWorkspacePatch(option.patch)
      } catch {
        return null
      }
    }
    seenIds.add(option.id)
    resolved.push({
      id: option.id,
      label,
      ...(description ? { description } : {}),
      ...(patch ? { patch } : {}),
    })
  }
  return resolved
}

export function selectPluginNewWorkspaceItems(
  plugins: readonly InstalledPlugin[] | undefined,
  target: NewWorkspaceFormTarget,
  locale?: string
): ResolvedPluginNewWorkspaceItem[] {
  if (!plugins?.length) return []
  const items: ResolvedPluginNewWorkspaceItem[] = []
  const seenPlugins = new Set<string>()

  for (const plugin of plugins) {
    if (seenPlugins.has(plugin.manifest.id)) continue
    seenPlugins.add(plugin.manifest.id)
    if (!plugin.enabled) continue
    const contributions = plugin.manifest.contributes?.newWorkspaceItems
    if (!contributions?.length) continue

    const server = plugin.manifest.server
    const hasServerEntry = Boolean(server?.entry?.trim())
    const declaredMethods = new Set(
      hasServerEntry && Array.isArray(server?.methods)
        ? server.methods
            .map((method) => (typeof method === "string" ? method.trim() : ""))
            .filter(Boolean)
        : []
    )
    const hasMethod = (method: unknown): method is string =>
      typeof method === "string" &&
      method.trim().length > 0 &&
      declaredMethods.has(method.trim())

    const pluginName =
      resolvePluginText(
        plugin.manifest.name,
        plugin.manifest.nameTranslations,
        locale
      ).trim() || plugin.manifest.id

    const seenIds = new Set<string>()
    let pluginValidCount = 0

    for (const item of contributions) {
      if (pluginValidCount >= MAX_PLUGIN_NEW_WORKSPACE_ITEMS) break
      if (
        typeof item.id !== "string" ||
        !NEW_WORKSPACE_SLUG_RE.test(item.id) ||
        seenIds.has(item.id)
      ) {
        continue
      }
      const fallbackTitle =
        typeof item.title === "string" ? item.title.trim() : ""
      if (!fallbackTitle) continue
      const title = resolvePluginText(
        fallbackTitle,
        item.titleTranslations,
        locale
      ).trim()
      if (!title) continue
      const description = resolveOptionalNewWorkspaceText(
        item.description,
        item.descriptionTranslations,
        locale
      )
      const itemTarget: NewWorkspaceTarget = item.target ?? "all"
      if (
        itemTarget !== "all" &&
        itemTarget !== "workspace" &&
        itemTarget !== "worktree"
      ) {
        continue
      }

      const rawControl = item.control
      if (!rawControl || typeof rawControl !== "object") continue
      let resolvedControl: ResolvedNewWorkspaceItemControl | null = null

      if (rawControl.kind === "combobox") {
        if (hasMethod(rawControl.searchMethod)) {
          const placeholder = resolveOptionalNewWorkspaceText(
            rawControl.placeholder,
            rawControl.placeholderTranslations,
            locale
          )
          resolvedControl = {
            kind: "combobox",
            searchMethod: rawControl.searchMethod.trim(),
            ...(placeholder ? { placeholder } : {}),
          }
        }
      } else if (rawControl.kind === "select") {
        const hasStatic = Array.isArray(rawControl.options)
        const hasDynamic = rawControl.optionsMethod !== undefined
        if (hasStatic !== hasDynamic) {
          const placeholder = resolveOptionalNewWorkspaceText(
            rawControl.placeholder,
            rawControl.placeholderTranslations,
            locale
          )
          if (hasStatic) {
            const options = resolveStaticSelectOptions(
              rawControl.options!,
              locale
            )
            if (options) {
              resolvedControl = {
                kind: "select",
                options,
                ...(placeholder ? { placeholder } : {}),
              }
            }
          } else if (hasMethod(rawControl.optionsMethod)) {
            resolvedControl = {
              kind: "select",
              optionsMethod: rawControl.optionsMethod.trim(),
              ...(placeholder ? { placeholder } : {}),
            }
          }
        }
      } else if (rawControl.kind === "toggle") {
        const hasOnChange = rawControl.onChangeMethod !== undefined
        if (!hasOnChange || hasMethod(rawControl.onChangeMethod)) {
          try {
            const enabledPatch =
              rawControl.enabledPatch !== undefined
                ? validateNewWorkspacePatch(rawControl.enabledPatch)
                : undefined
            const disabledPatch =
              rawControl.disabledPatch !== undefined
                ? validateNewWorkspacePatch(rawControl.disabledPatch)
                : undefined
            if (
              hasOnChange ||
              !isPatchEmpty(enabledPatch) ||
              !isPatchEmpty(disabledPatch)
            ) {
              resolvedControl = {
                kind: "toggle",
                defaultValue: rawControl.defaultValue === true,
                ...(hasOnChange
                  ? { onChangeMethod: rawControl.onChangeMethod!.trim() }
                  : {}),
                ...(enabledPatch ? { enabledPatch } : {}),
                ...(disabledPatch ? { disabledPatch } : {}),
              }
            }
          } catch {
            // Invalid static toggle patch — skip item.
          }
        }
      } else if (rawControl.kind === "action") {
        if (hasMethod(rawControl.method)) {
          resolvedControl = {
            kind: "action",
            method: rawControl.method.trim(),
          }
        }
      }

      if (!resolvedControl) continue
      seenIds.add(item.id)
      pluginValidCount += 1
      if (itemTarget !== "all" && itemTarget !== target) continue
      items.push({
        key: pluginNewWorkspaceItemKey(plugin.manifest.id, item.id),
        pluginId: plugin.manifest.id,
        pluginName,
        id: item.id,
        title,
        ...(description ? { description } : {}),
        target: itemTarget,
        control: resolvedControl,
      })
    }
  }

  return items
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
