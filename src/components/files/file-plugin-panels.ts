"use client"

import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react"
import { useLocale } from "next-intl"
import type {
  FileLikeWorkspaceTab,
  FileWorkspaceTab,
} from "@/contexts/workspace-context"
import { isOfficeFileTab } from "@/components/files/kept-office-previews"
import { useOverlayHostHidden } from "@/components/ui/overlay-host-hidden"
import {
  extractFileBaseName,
  selectPluginFilePanels,
  useHostPlugins,
  usePluginHostScope,
  type PluginHostScope,
  type ResolvedPluginFilePanel,
} from "@/lib/host-plugins"
import { isImageFile, isPdfFile } from "@/lib/language-detect"
import type { Transport } from "@/lib/transport"

interface FilePluginPanelSelection {
  tabId: string
  scopeKey: string
  transport: Transport
  panelKey: string
  writable: boolean
  selectionId: number
}

let activeSelection: FilePluginPanelSelection | null = null
let nextSelectionId = 0
let mountedConsumers = 0
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of [...listeners]) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function getSelectionSnapshot(): FilePluginPanelSelection | null {
  return activeSelection
}

function getServerSelectionSnapshot(): null {
  return null
}

function setSelection(next: FilePluginPanelSelection | null): void {
  if (activeSelection === next) return
  activeSelection = next
  emit()
}

/**
 * True when `tab` represents an ordinary text file tab whose in-memory buffer
 * can be exposed to a plugin file panel. Excludes diffs, browsers, binary
 * previews (images including SVG, PDFs, Office documents), and load-failed tabs
 * whose `content` contains a localized error message.
 */
export function isReadableTextFileTab(
  tab: FileWorkspaceTab | null | undefined
): tab is FileLikeWorkspaceTab {
  if (!tab || tab.kind !== "file") return false
  if (
    tab.language === "image" ||
    tab.language === "pdf" ||
    tab.language === "office" ||
    isOfficeFileTab(tab)
  ) {
    return false
  }
  if (tab.path && (isImageFile(tab.path) || isPdfFile(tab.path))) {
    return false
  }
  if (tab.loadError) return false
  // Defensive fallback for tabs where `rejectTab` left an error in `content`
  // without setting `loadError` (e.g. partial test fixtures).
  if (
    tab.saveState === "error" &&
    !tab.isDirty &&
    tab.etag == null &&
    tab.mtimeMs == null &&
    tab.savedContent === ""
  ) {
    return false
  }
  return true
}

/**
 * True while a file tab is still performing its initial load and has no
 * settled text snapshot yet.
 */
export function isFileTabColdLoading(
  tab: FileWorkspaceTab | null | undefined
): boolean {
  if (!tab || tab.kind !== "file" || !tab.loading) return false
  return (
    tab.content === "" &&
    !tab.isDirty &&
    tab.etag == null &&
    tab.mtimeMs == null
  )
}

export interface ActiveFilePluginPanelsState {
  /** Bare filename (never a directory or absolute path). */
  fileName: string
  /** True when the tab is an eligible loaded text file on a visible file column. */
  eligible: boolean
  /** True when the enclosing workspace column/surface is hidden behind an overlay. */
  hostHidden: boolean
  /** Matching enabled plugin file panels for the active text file. */
  panels: ResolvedPluginFilePanel[]
  /** Currently selected & valid plugin file panel, or `null` for built-in view. */
  activePanel: ResolvedPluginFilePanel | null
  /** Monotonic nonce identifying the active explicit user selection. */
  selectionId: number | null
  hostScope: PluginHostScope
  transport: Transport | null
  /** Explicitly choose a matching plugin panel key, or `null` for built-in view. */
  selectPanel: (panelKey: string | null) => void
}

export function useActiveFilePluginPanels(
  tab: FileWorkspaceTab | null,
  options?: { ownsSurface?: boolean }
): ActiveFilePluginPanelsState {
  const ownsSurface = options?.ownsSurface === true
  const locale = useLocale()
  const hostScope = usePluginHostScope()
  const hostHidden = useOverlayHostHidden()
  const eligible =
    !hostHidden && isReadableTextFileTab(tab) && !isFileTabColdLoading(tab)
  const fileName = useMemo(() => {
    if (!eligible || !tab) return ""
    return extractFileBaseName(tab.title || tab.path)
  }, [eligible, tab])

  const { data: plugins, transport } = useHostPlugins(eligible)

  const panels = useMemo(() => {
    if (!eligible || !fileName || !transport) return []
    return selectPluginFilePanels(plugins, fileName, locale)
  }, [eligible, fileName, locale, plugins, transport])

  const selection = useSyncExternalStore(
    subscribe,
    getSelectionSnapshot,
    getServerSelectionSnapshot
  )

  const activePanel = useMemo(() => {
    if (!selection || !tab || !eligible || !transport) return null
    if (
      selection.tabId !== tab.id ||
      selection.scopeKey !== hostScope.scopeKey ||
      selection.transport !== transport
    ) {
      return null
    }
    const matched = panels.find((panel) => panel.key === selection.panelKey)
    if (!matched || matched.writable !== selection.writable) {
      return null
    }
    return matched
  }, [eligible, hostScope.scopeKey, panels, selection, tab, transport])

  // Withdraw module-level selection when the file panel host unmounts (e.g.
  // mobile Back leaving the files pane) so reopening the same file restores
  // built-in Source/Preview instead of auto-remounting a plugin surface.
  useEffect(() => {
    mountedConsumers += 1
    return () => {
      mountedConsumers = Math.max(0, mountedConsumers - 1)
      if (ownsSurface || mountedConsumers === 0) {
        setSelection(null)
      }
    }
  }, [ownsSurface])

  // Clear stale selection whenever the active tab, visibility, host scope,
  // transport identity, readability, or plugin catalog invalidates it so a
  // later return, tab switch back, or plugin re-enable never auto-mounts.
  useEffect(() => {
    if (!selection) return
    if (
      hostHidden ||
      !tab ||
      !eligible ||
      !transport ||
      selection.tabId !== tab.id ||
      selection.scopeKey !== hostScope.scopeKey ||
      selection.transport !== transport
    ) {
      setSelection(null)
      return
    }
    if (
      plugins !== undefined &&
      !panels.some(
        (panel) =>
          panel.key === selection.panelKey &&
          panel.writable === selection.writable
      )
    ) {
      setSelection(null)
    }
  }, [
    eligible,
    hostHidden,
    hostScope.scopeKey,
    panels,
    plugins,
    selection,
    tab,
    transport,
  ])

  const selectPanel = useCallback(
    (panelKey: string | null) => {
      if (!panelKey) {
        setSelection(null)
        return
      }
      if (hostHidden || !tab || !eligible || !transport) return
      const targetPanel = panels.find((panel) => panel.key === panelKey)
      if (!targetPanel) return
      nextSelectionId += 1
      setSelection({
        tabId: tab.id,
        scopeKey: hostScope.scopeKey,
        transport,
        panelKey,
        writable: targetPanel.writable,
        selectionId: nextSelectionId,
      })
    },
    [eligible, hostHidden, hostScope.scopeKey, panels, tab, transport]
  )

  return {
    fileName,
    eligible,
    hostHidden,
    panels,
    activePanel,
    selectionId: activePanel && selection ? selection.selectionId : null,
    hostScope,
    transport,
    selectPanel,
  }
}

/** Tests only. */
export function resetFilePluginPanelSelectionForTests(): void {
  activeSelection = null
  nextSelectionId = 0
  mountedConsumers = 0
  emit()
}
