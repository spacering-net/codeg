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
export const MAX_PLUGIN_COMPOSER_PILLS = 16
export const MAX_PLUGIN_SESSION_ACTIONS = 16
export const MAX_PLUGIN_INPUT_ACTIVITIES = 8
export const MAX_COMPOSER_PILL_MENU_ITEMS = 16
export const MAX_INPUT_ACTIVITY_TITLE_BYTES = 256
export const MAX_INPUT_ACTIVITY_DETAIL_BYTES = 1024
export const MAX_COMPOSER_ACTION_NOTICE_CHARS = 512

export type PluginSidebarItemPlacement = "header" | "footer"

export type ComposerContributionScope = "draft" | "session" | "all"
export type ComposerRuntimeScope = Exclude<ComposerContributionScope, "all">

export type ComposerPillLeafAction =
  | { kind: "openWorkspacePanel"; panelId: string }
  | { kind: "openClientSurface"; surfaceId: string }
  | { kind: "openScreen"; screenId: string }
  | { kind: "callMethod"; method: string }
  | {
      kind: "insertText"
      text: string
      textTranslations?: PluginTextTranslations
    }

export type ResolvedComposerPillLeafAction =
  | { kind: "openWorkspacePanel"; panelId: string }
  | {
      kind: "openClientSurface"
      surfaceId: string
      slot: PluginClientSurfaceSlot
      surfaceTitle: string
    }
  | { kind: "openScreen"; screenId: string }
  | { kind: "callMethod"; method: string }
  | { kind: "insertText"; text: string }

export interface ComposerPillMenuItem {
  id: string
  title: string
  titleTranslations?: PluginTextTranslations
  action: ComposerPillLeafAction
}

export interface ResolvedComposerPillMenuItem {
  id: string
  title: string
  action: ResolvedComposerPillLeafAction
}

export type ComposerPillAction =
  | ComposerPillLeafAction
  | { kind: "menu"; items: ComposerPillMenuItem[] }

export type ResolvedComposerPillAction =
  | ResolvedComposerPillLeafAction
  | { kind: "menu"; items: ResolvedComposerPillMenuItem[] }

export interface ComposerPillContribution {
  id: string
  title: string
  titleTranslations?: PluginTextTranslations
  label?: string
  labelTranslations?: PluginTextTranslations
  description?: string
  descriptionTranslations?: PluginTextTranslations
  scope?: ComposerContributionScope
  action: ComposerPillAction
}

export interface ResolvedPluginComposerPill {
  key: string
  pluginId: string
  pluginName: string
  id: string
  title: string
  label?: string
  description?: string
  scope: ComposerContributionScope
  action: ResolvedComposerPillAction
}

export interface SessionActionContribution {
  id: string
  title: string
  titleTranslations?: PluginTextTranslations
  description?: string
  descriptionTranslations?: PluginTextTranslations
  scope?: ComposerContributionScope
  action: ComposerPillLeafAction
}

export interface ResolvedPluginSessionAction {
  key: string
  pluginId: string
  pluginName: string
  id: string
  title: string
  description?: string
  scope: ComposerContributionScope
  action: ResolvedComposerPillLeafAction
}

export interface InputActivityContribution {
  id: string
  title: string
  titleTranslations?: PluginTextTranslations
  method: string
  scope?: ComposerContributionScope
}

export interface ResolvedPluginInputActivity {
  key: string
  pluginId: string
  pluginName: string
  id: string
  title: string
  method: string
  scope: ComposerContributionScope
}

export type ComposerActionInput = {
  scope: ComposerRuntimeScope
  folderId: number | null
  conversationId: number | null
  locale: string
  itemId: string
} & (
  | { source: "composerPill"; menuItemId?: string }
  | { source: "sessionAction"; menuItemId?: never }
)

export interface ComposerActionResult {
  insertText?: string
  notice?: string
}

export interface InputActivityInput {
  activityId: string
  scope: ComposerRuntimeScope
  folderId: number | null
  conversationId: number | null
  locale: string
}

export type InputActivityResult = {
  visible: boolean
  tone?: "muted" | "warning"
  title: string
  detail?: string
} | null

export interface ValidatedInputActivity {
  visible: boolean
  tone: "muted" | "warning"
  title: string
  detail?: string
}

export interface ActivePluginInputActivity {
  key: string
  pluginId: string
  pluginName: string
  id: string
  tone: "muted" | "warning"
  title: string
  detail?: string
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
      composerPills?: ComposerPillContribution[]
      sessionActions?: SessionActionContribution[]
      inputActivities?: InputActivityContribution[]
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

export function pluginComposerPillKey(pluginId: string, itemId: string) {
  return `${pluginId}:${itemId}`
}

export function pluginSessionActionKey(pluginId: string, itemId: string) {
  return `${pluginId}:${itemId}`
}

export function pluginInputActivityKey(pluginId: string, activityId: string) {
  return `${pluginId}:${activityId}`
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

const COMPOSER_SLUG_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/
const ACTIVITY_CONTROL_CHAR_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/
const NOTICE_CONTROL_CHAR_RE = /[\u0000-\u001f\u007f-\u009f]+/g
const useIsomorphicLayoutEffect =
  typeof window !== "undefined" ? useLayoutEffect : useEffect

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function normalizeAndValidateInsertText(raw: unknown): string {
  if (typeof raw !== "string") {
    throw new Error("Composer text must be a string")
  }
  const normalized = raw.replace(/\r\n?/g, "\n")
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

function resolveOptionalLocalizedText(
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

function isContributionScope(
  value: unknown
): value is ComposerContributionScope {
  return value === "draft" || value === "session" || value === "all"
}

function resolveLeafActionForPlugin(
  plugin: InstalledPlugin,
  action: ComposerPillLeafAction,
  declaredPanelIds: ReadonlySet<string>,
  declaredSurfacesById: ReadonlyMap<
    string,
    { slot: PluginClientSurfaceSlot; title: string }
  >,
  declaredScreenIds: ReadonlySet<string>,
  declaredMethods: ReadonlySet<string>,
  locale?: string
): ResolvedComposerPillLeafAction | null {
  if (!action || typeof action !== "object") return null
  if (action.kind === "openWorkspacePanel") {
    const panelId =
      typeof action.panelId === "string" ? action.panelId.trim() : ""
    if (!panelId || !declaredPanelIds.has(panelId)) return null
    return { kind: "openWorkspacePanel", panelId }
  }
  if (action.kind === "openClientSurface") {
    const surfaceId =
      typeof action.surfaceId === "string" ? action.surfaceId.trim() : ""
    const surface = surfaceId ? declaredSurfacesById.get(surfaceId) : undefined
    if (!surface) return null
    return {
      kind: "openClientSurface",
      surfaceId,
      slot: surface.slot,
      surfaceTitle: surface.title,
    }
  }
  if (action.kind === "openScreen") {
    const screenId =
      typeof action.screenId === "string" ? action.screenId.trim() : ""
    if (!screenId || !declaredScreenIds.has(screenId)) return null
    return { kind: "openScreen", screenId }
  }
  if (action.kind === "callMethod") {
    const method = typeof action.method === "string" ? action.method.trim() : ""
    if (
      !method ||
      !plugin.manifest.server?.entry?.trim() ||
      !declaredMethods.has(method)
    ) {
      return null
    }
    return { kind: "callMethod", method }
  }
  if (action.kind === "insertText") {
    try {
      const fallbackNormalized = normalizeAndValidateInsertText(action.text)
      const localized = resolvePluginText(
        fallbackNormalized,
        action.textTranslations,
        locale
      )
      const normalized = normalizeAndValidateInsertText(localized)
      return { kind: "insertText", text: normalized }
    } catch {
      return null
    }
  }
  return null
}

function buildPluginTargetIndex(plugin: InstalledPlugin, locale?: string) {
  const declaredPanelIds = new Set(
    (plugin.manifest.contributes?.workspacePanels ?? [])
      .map((panel) => (typeof panel.id === "string" ? panel.id.trim() : ""))
      .filter(Boolean)
  )
  const hasClientEntry = Boolean(plugin.manifest.client?.entry?.trim())
  const declaredSurfacesById = new Map<
    string,
    { slot: PluginClientSurfaceSlot; title: string }
  >()
  if (hasClientEntry) {
    for (const surface of plugin.manifest.contributes?.clientSurfaces ?? []) {
      const id = typeof surface.id === "string" ? surface.id.trim() : ""
      if (!id || declaredSurfacesById.has(id)) continue
      if (surface.slot !== "sessionHeader" && surface.slot !== "composer") {
        continue
      }
      const title =
        resolvePluginText(
          surface.title,
          surface.titleTranslations,
          locale
        ).trim() || id
      declaredSurfacesById.set(id, { slot: surface.slot, title })
    }
  }
  const declaredScreenIds = new Set(
    hasClientEntry
      ? resolvePluginScreensForPlugin(plugin, locale).map((screen) => screen.id)
      : []
  )
  const declaredMethods = new Set(
    plugin.manifest.server?.entry?.trim() &&
      Array.isArray(plugin.manifest.server.methods)
      ? plugin.manifest.server.methods
          .map((method) => (typeof method === "string" ? method.trim() : ""))
          .filter(Boolean)
      : []
  )
  return {
    declaredPanelIds,
    declaredSurfacesById,
    declaredScreenIds,
    declaredMethods,
  }
}

export function selectPluginComposerPills(
  plugins: readonly InstalledPlugin[] | undefined,
  scope: ComposerRuntimeScope,
  locale?: string
): ResolvedPluginComposerPill[] {
  if (!plugins?.length) return []
  const results: ResolvedPluginComposerPill[] = []
  const seenPlugins = new Set<string>()
  for (const plugin of plugins) {
    if (seenPlugins.has(plugin.manifest.id)) continue
    seenPlugins.add(plugin.manifest.id)
    if (!plugin.enabled) continue
    const pills = plugin.manifest.contributes?.composerPills
    if (!pills?.length) continue
    const pluginName =
      resolvePluginText(
        plugin.manifest.name,
        plugin.manifest.nameTranslations,
        locale
      ).trim() || plugin.manifest.id
    const {
      declaredPanelIds,
      declaredSurfacesById,
      declaredScreenIds,
      declaredMethods,
    } = buildPluginTargetIndex(plugin, locale)

    const seenIds = new Set<string>()
    let pluginValidCount = 0

    for (const pill of pills) {
      if (pluginValidCount >= MAX_PLUGIN_COMPOSER_PILLS) break
      if (
        typeof pill.id !== "string" ||
        !COMPOSER_SLUG_RE.test(pill.id) ||
        seenIds.has(pill.id)
      ) {
        continue
      }
      const fallbackTitle =
        typeof pill.title === "string" ? pill.title.trim() : ""
      if (!fallbackTitle) continue
      const title = resolvePluginText(
        fallbackTitle,
        pill.titleTranslations,
        locale
      ).trim()
      if (!title) continue
      const label = resolveOptionalLocalizedText(
        pill.label,
        pill.labelTranslations,
        locale
      )
      const description = resolveOptionalLocalizedText(
        pill.description,
        pill.descriptionTranslations,
        locale
      )
      const pillScope: ComposerContributionScope = pill.scope ?? "all"
      if (!isContributionScope(pillScope)) continue

      let resolvedAction: ResolvedComposerPillAction | null = null
      if (pill.action && pill.action.kind === "menu") {
        const rawItems = pill.action.items
        if (
          Array.isArray(rawItems) &&
          rawItems.length >= 1 &&
          rawItems.length <= MAX_COMPOSER_PILL_MENU_ITEMS
        ) {
          const seenMenuIds = new Set<string>()
          const menuItems: ResolvedComposerPillMenuItem[] = []
          let validMenu = true
          for (const menuItem of rawItems) {
            if (
              typeof menuItem.id !== "string" ||
              !COMPOSER_SLUG_RE.test(menuItem.id) ||
              seenMenuIds.has(menuItem.id)
            ) {
              validMenu = false
              break
            }
            const itemFallbackTitle =
              typeof menuItem.title === "string" ? menuItem.title.trim() : ""
            if (!itemFallbackTitle) {
              validMenu = false
              break
            }
            const itemTitle = resolvePluginText(
              itemFallbackTitle,
              menuItem.titleTranslations,
              locale
            ).trim()
            if (!itemTitle) {
              validMenu = false
              break
            }
            const leaf = resolveLeafActionForPlugin(
              plugin,
              menuItem.action,
              declaredPanelIds,
              declaredSurfacesById,
              declaredScreenIds,
              declaredMethods,
              locale
            )
            if (!leaf) {
              validMenu = false
              break
            }
            seenMenuIds.add(menuItem.id)
            menuItems.push({ id: menuItem.id, title: itemTitle, action: leaf })
          }
          if (validMenu && menuItems.length > 0) {
            resolvedAction = { kind: "menu", items: menuItems }
          }
        }
      } else if (pill.action) {
        resolvedAction = resolveLeafActionForPlugin(
          plugin,
          pill.action,
          declaredPanelIds,
          declaredSurfacesById,
          declaredScreenIds,
          declaredMethods,
          locale
        )
      }

      if (!resolvedAction) continue
      seenIds.add(pill.id)
      pluginValidCount += 1
      if (pillScope !== "all" && pillScope !== scope) continue
      results.push({
        key: pluginComposerPillKey(plugin.manifest.id, pill.id),
        pluginId: plugin.manifest.id,
        pluginName,
        id: pill.id,
        title,
        ...(label ? { label } : {}),
        ...(description ? { description } : {}),
        scope: pillScope,
        action: resolvedAction,
      })
    }
  }
  return results
}

export function selectPluginSessionActions(
  plugins: readonly InstalledPlugin[] | undefined,
  scope: ComposerRuntimeScope,
  locale?: string
): ResolvedPluginSessionAction[] {
  if (!plugins?.length) return []
  const results: ResolvedPluginSessionAction[] = []
  const seenPlugins = new Set<string>()
  for (const plugin of plugins) {
    if (seenPlugins.has(plugin.manifest.id)) continue
    seenPlugins.add(plugin.manifest.id)
    if (!plugin.enabled) continue
    const actions = plugin.manifest.contributes?.sessionActions
    if (!actions?.length) continue
    const pluginName =
      resolvePluginText(
        plugin.manifest.name,
        plugin.manifest.nameTranslations,
        locale
      ).trim() || plugin.manifest.id
    const {
      declaredPanelIds,
      declaredSurfacesById,
      declaredScreenIds,
      declaredMethods,
    } = buildPluginTargetIndex(plugin, locale)

    const seenIds = new Set<string>()
    let pluginValidCount = 0

    for (const entry of actions) {
      if (pluginValidCount >= MAX_PLUGIN_SESSION_ACTIONS) break
      if (
        typeof entry.id !== "string" ||
        !COMPOSER_SLUG_RE.test(entry.id) ||
        seenIds.has(entry.id)
      ) {
        continue
      }
      const fallbackTitle =
        typeof entry.title === "string" ? entry.title.trim() : ""
      if (!fallbackTitle) continue
      const title = resolvePluginText(
        fallbackTitle,
        entry.titleTranslations,
        locale
      ).trim()
      if (!title) continue
      const description = resolveOptionalLocalizedText(
        entry.description,
        entry.descriptionTranslations,
        locale
      )
      // Session actions default to "session".
      const entryScope: ComposerContributionScope = entry.scope ?? "session"
      if (!isContributionScope(entryScope)) continue
      const resolvedAction = resolveLeafActionForPlugin(
        plugin,
        entry.action,
        declaredPanelIds,
        declaredSurfacesById,
        declaredScreenIds,
        declaredMethods,
        locale
      )
      if (!resolvedAction) continue
      seenIds.add(entry.id)
      pluginValidCount += 1
      if (entryScope !== "all" && entryScope !== scope) continue
      results.push({
        key: pluginSessionActionKey(plugin.manifest.id, entry.id),
        pluginId: plugin.manifest.id,
        pluginName,
        id: entry.id,
        title,
        ...(description ? { description } : {}),
        scope: entryScope,
        action: resolvedAction,
      })
    }
  }
  return results
}

export function selectPluginInputActivities(
  plugins: readonly InstalledPlugin[] | undefined,
  scope: ComposerRuntimeScope,
  locale?: string
): ResolvedPluginInputActivity[] {
  if (!plugins?.length) return []
  const results: ResolvedPluginInputActivity[] = []
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
    const activities = plugin.manifest.contributes?.inputActivities
    if (!activities?.length) continue
    const pluginName =
      resolvePluginText(
        plugin.manifest.name,
        plugin.manifest.nameTranslations,
        locale
      ).trim() || plugin.manifest.id

    const seenIds = new Set<string>()
    let pluginValidCount = 0

    for (const activity of activities) {
      if (pluginValidCount >= MAX_PLUGIN_INPUT_ACTIVITIES) break
      if (
        typeof activity.id !== "string" ||
        !COMPOSER_SLUG_RE.test(activity.id) ||
        seenIds.has(activity.id)
      ) {
        continue
      }
      const fallbackTitle =
        typeof activity.title === "string" ? activity.title.trim() : ""
      const method =
        typeof activity.method === "string" ? activity.method.trim() : ""
      if (!fallbackTitle || !method || !declaredMethods.has(method)) continue
      const title = resolvePluginText(
        fallbackTitle,
        activity.titleTranslations,
        locale
      ).trim()
      if (!title) continue
      const activityScope: ComposerContributionScope = activity.scope ?? "all"
      if (!isContributionScope(activityScope)) continue
      seenIds.add(activity.id)
      pluginValidCount += 1
      if (activityScope !== "all" && activityScope !== scope) continue
      results.push({
        key: pluginInputActivityKey(plugin.manifest.id, activity.id),
        pluginId: plugin.manifest.id,
        pluginName,
        id: activity.id,
        title,
        method,
        scope: activityScope,
      })
    }
  }
  return results
}

export function validateComposerActionResult(
  raw: unknown
): ComposerActionResult {
  if (!isPlainObject(raw)) {
    throw new Error("Invalid composer action result")
  }
  for (const key of Object.keys(raw)) {
    if (key !== "insertText" && key !== "notice") {
      throw new Error(`Unsupported composer action result field: ${key}`)
    }
  }
  const result: ComposerActionResult = {}
  if (raw.insertText !== undefined) {
    result.insertText = normalizeAndValidateInsertText(raw.insertText)
  }
  if (raw.notice !== undefined) {
    if (typeof raw.notice !== "string") {
      throw new Error("Composer action notice must be a string")
    }
    const cleaned = raw.notice
      .replace(NOTICE_CONTROL_CHAR_RE, " ")
      .trim()
      .slice(0, MAX_COMPOSER_ACTION_NOTICE_CHARS)
      .trim()
    if (cleaned) {
      result.notice = cleaned
    }
  }
  return result
}

export function validateInputActivityResult(
  raw: unknown
): ValidatedInputActivity | null {
  if (raw === null) return null
  if (!isPlainObject(raw)) {
    throw new Error("Invalid input activity result")
  }
  for (const key of Object.keys(raw)) {
    if (
      key !== "visible" &&
      key !== "tone" &&
      key !== "title" &&
      key !== "detail"
    ) {
      throw new Error(`Unsupported input activity field: ${key}`)
    }
  }
  if (typeof raw.visible !== "boolean") {
    throw new Error("Input activity visible must be boolean")
  }
  const tone = raw.tone ?? "muted"
  if (tone !== "muted" && tone !== "warning") {
    throw new Error("Input activity tone must be muted or warning")
  }
  if (
    typeof raw.title !== "string" ||
    !raw.title.trim() ||
    ACTIVITY_CONTROL_CHAR_RE.test(raw.title) ||
    utf8Encoder.encode(raw.title).byteLength > MAX_INPUT_ACTIVITY_TITLE_BYTES
  ) {
    throw new Error("Invalid input activity title")
  }
  let detail: string | undefined
  if (raw.detail !== undefined) {
    if (
      typeof raw.detail !== "string" ||
      ACTIVITY_CONTROL_CHAR_RE.test(raw.detail) ||
      utf8Encoder.encode(raw.detail).byteLength >
        MAX_INPUT_ACTIVITY_DETAIL_BYTES
    ) {
      throw new Error("Invalid input activity detail")
    }
    const trimmedDetail = raw.detail.trim()
    if (trimmedDetail) detail = trimmedDetail
  }
  return {
    visible: raw.visible,
    tone,
    title: raw.title.trim(),
    ...(detail ? { detail } : {}),
  }
}

export function usePluginInputActivities({
  scope,
  folderId,
  conversationId,
  locale,
  enabled = true,
}: {
  scope: ComposerRuntimeScope
  folderId: number | null
  conversationId: number | null
  locale: string
  enabled?: boolean
}): ActivePluginInputActivity[] {
  const hostScope = usePluginHostScope()
  const { data: plugins, transport } = useHostPlugins(enabled)
  const activities = useMemo(
    () =>
      enabled && hostScope.transportReady && transport
        ? selectPluginInputActivities(plugins, scope, locale)
        : [],
    [enabled, hostScope.transportReady, locale, plugins, scope, transport]
  )

  const contextKey = `${hostScope.scopeKey}::${scope}::${folderId ?? "none"}::${conversationId ?? "draft"}::${locale}`
  const [snapshot, setSnapshot] = useState<{
    transport: Transport
    contextKey: string
    results: Record<string, ValidatedInputActivity | null>
  } | null>(null)

  const generationRef = useRef(0)
  const liveRef = useRef({
    enabled,
    transportReady: hostScope.transportReady,
    transport,
    contextKey,
    activityKeys: new Set(activities.map((a) => a.key)),
  })
  useIsomorphicLayoutEffect(() => {
    liveRef.current = {
      enabled,
      transportReady: hostScope.transportReady,
      transport,
      contextKey,
      activityKeys: new Set(activities.map((a) => a.key)),
    }
  }, [activities, contextKey, enabled, hostScope.transportReady, transport])

  useEffect(() => {
    const generation = ++generationRef.current
    if (
      !enabled ||
      !hostScope.transportReady ||
      !transport ||
      activities.length === 0 ||
      typeof transport.call !== "function"
    ) {
      return
    }
    const capturedTransport = transport
    const capturedContextKey = contextKey
    let active = true

    for (const activity of activities) {
      const input: InputActivityInput = {
        activityId: activity.id,
        scope,
        folderId,
        conversationId,
        locale,
      }
      void Promise.resolve()
        .then(() =>
          capturedTransport.call<unknown>("host_plugins_call", {
            pluginId: activity.pluginId,
            method: activity.method,
            input,
          })
        )
        .then((raw) => {
          if (!active || generation !== generationRef.current) return
          const live = liveRef.current
          if (
            !live.enabled ||
            !live.transportReady ||
            live.transport !== capturedTransport ||
            live.contextKey !== capturedContextKey ||
            !isCurrentReadyHostTransport(capturedTransport) ||
            !live.activityKeys.has(activity.key)
          ) {
            return
          }
          const validated = validateInputActivityResult(raw)
          setSnapshot((prev) => {
            const base =
              prev &&
              prev.transport === capturedTransport &&
              prev.contextKey === capturedContextKey
                ? prev.results
                : {}
            return {
              transport: capturedTransport,
              contextKey: capturedContextKey,
              results: { ...base, [activity.key]: validated },
            }
          })
        })
        .catch(() => {
          // Malformed or failing activity calls are silently hidden.
          if (!active || generation !== generationRef.current) return
          const live = liveRef.current
          if (
            !live.enabled ||
            !live.transportReady ||
            live.transport !== capturedTransport ||
            live.contextKey !== capturedContextKey ||
            !isCurrentReadyHostTransport(capturedTransport) ||
            !live.activityKeys.has(activity.key)
          ) {
            return
          }
          setSnapshot((prev) => {
            const base =
              prev &&
              prev.transport === capturedTransport &&
              prev.contextKey === capturedContextKey
                ? prev.results
                : {}
            if (base[activity.key] === null) return prev
            return {
              transport: capturedTransport,
              contextKey: capturedContextKey,
              results: { ...base, [activity.key]: null },
            }
          })
        })
    }

    return () => {
      active = false
      generationRef.current += 1
    }
  }, [
    activities,
    contextKey,
    conversationId,
    enabled,
    folderId,
    hostScope.transportReady,
    locale,
    scope,
    transport,
  ])

  return useMemo(() => {
    if (
      !enabled ||
      !hostScope.transportReady ||
      !transport ||
      !snapshot ||
      snapshot.transport !== transport ||
      snapshot.contextKey !== contextKey
    ) {
      return []
    }
    const visible: ActivePluginInputActivity[] = []
    for (const activity of activities) {
      const result = snapshot.results[activity.key]
      if (result && result.visible) {
        visible.push({
          key: activity.key,
          pluginId: activity.pluginId,
          pluginName: activity.pluginName,
          id: activity.id,
          tone: result.tone,
          title: result.title,
          ...(result.detail ? { detail: result.detail } : {}),
        })
      }
    }
    return visible
  }, [
    activities,
    contextKey,
    enabled,
    hostScope.transportReady,
    snapshot,
    transport,
  ])
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
