"use client"

import { useCallback, useEffect, useState } from "react"
import {
  parsePluginThemePalette,
  type PluginThemePalette,
} from "@/lib/custom-style"
import { getTransport, type Transport } from "@/lib/transport"

export type PluginTextTranslations = Record<string, string>

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

export interface PluginHostScope {
  /** Storage scope identifying the connected host (e.g. "local" or "remote:5"). */
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

export function useHostPlugins(enabled = true) {
  const transport = enabled ? safeGetTransport() : null
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
  const transport = typeof window !== "undefined" ? getTransport() : null
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
