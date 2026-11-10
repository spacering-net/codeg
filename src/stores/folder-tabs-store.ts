"use client"

import { create } from "zustand"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"
import { registerBackendScopedStoreReset } from "@/stores/backend-scoped-store-reset"
import { getActiveRemoteConnectionId } from "@/lib/transport"

export type TabScope = number | "global"

export function folderScope(folderId?: number | null): TabScope {
  if (!folderId) return "global"
  return useAppWorkspaceStore
    .getState()
    .allFolders.find((f) => f.id === folderId)?.kind === "chat"
    ? "global"
    : folderId
}

/** Empty scopes are intentional while tabs follow the folder. */
export function shouldSeedConversation(enabled: boolean, hasNoTabs: boolean) {
  return !enabled && hasNoTabs
}

interface FolderTabsState {
  enabled: boolean
  scope: TabScope
  // References own view membership; the workspace provider still owns ONE
  // buffer per normalized absolute path, including when several scopes use it.
  fileRefs: Record<string, string[]>
  fileSelection: Record<string, string | null>
  hydratePreference: () => void
  setEnabled: (enabled: boolean) => void
  activateScope: (scope: TabScope) => void
  addFile: (id: string, scope: TabScope, select?: boolean) => void
  selectFile: (id: string | null) => void
  removeFile: (id: string, scope: TabScope) => boolean
  forgetFile: (id: string) => void
  reorderFiles: (ids: string[]) => void
}

function preferenceKey() {
  const remoteId = getActiveRemoteConnectionId()
  return `workspace:tabs-follow-folder:${remoteId ? `remote-${remoteId}` : "local"}`
}

export function openingScope(folderId?: number | null): TabScope {
  if (folderId != null) return folderScope(folderId)
  const state = useFolderTabsStore.getState()
  return state.enabled
    ? state.scope
    : folderScope(useAppWorkspaceStore.getState().activeFolderId)
}

/** Browser popups inherit their opener's references even after a scope switch. */
export function fileOpeningScope(
  tabId: string,
  fallback = openingScope()
): TabScope {
  const state = useFolderTabsStore.getState()
  const scopes = Object.entries(state.fileRefs)
    .filter(([, ids]) => ids.includes(tabId))
    .map(([scope]) =>
      scope === "global" ? ("global" as const) : Number(scope)
    )
  return scopes.includes(state.scope) ? state.scope : (scopes[0] ?? fallback)
}

const initialState = () => ({
  enabled: false,
  scope: "global" as TabScope,
  fileRefs: {} as Record<string, string[]>,
  fileSelection: {} as Record<string, string | null>,
})

export const useFolderTabsStore = create<FolderTabsState>()((set, get) => ({
  ...initialState(),
  hydratePreference: () => {
    try {
      if (localStorage.getItem(preferenceKey()) === "true") {
        get().setEnabled(true)
      }
    } catch {
      // Storage is optional (private windows, SSR, quota failures).
    }
  },
  // The active folder is NOT written here: the tab store's subscriber runs
  // synchronously inside `set` and syncs it from the scope's restored active
  // tab (a chat conversation keeps its hidden chat folder), which a write
  // after `set` would overwrite.
  setEnabled: (enabled) => {
    if (enabled === get().enabled) return
    const scope = enabled
      ? folderScope(useAppWorkspaceStore.getState().activeFolderId)
      : get().scope
    set({ enabled, scope })
    try {
      localStorage.setItem(preferenceKey(), String(enabled))
    } catch {
      // The in-memory preference still works when storage is unavailable.
    }
  },
  activateScope: (scope) => {
    if (!get().enabled) return
    set({ scope })
  },
  addFile: (id, scope, select = true) => {
    const state = get()
    const refs = state.fileRefs[scope] ?? []
    const selected = select ? id : (state.fileSelection[scope] ?? id)
    if (refs.includes(id) && selected === state.fileSelection[scope]) return
    set({
      fileRefs: {
        ...state.fileRefs,
        [scope]: refs.includes(id) ? refs : [...refs, id],
      },
      fileSelection: { ...state.fileSelection, [scope]: selected },
    })
  },
  selectFile: (id) => {
    const state = get()
    if (id != null && !state.fileRefs[state.scope]?.includes(id)) return
    if (state.fileSelection[state.scope] === id) return
    set({ fileSelection: { ...state.fileSelection, [state.scope]: id } })
  },
  removeFile: (id, scope) => {
    const state = get()
    const refs = state.fileRefs[scope] ?? []
    const next = refs.filter((ref) => ref !== id)
    set({
      fileRefs: { ...state.fileRefs, [scope]: next },
      fileSelection: {
        ...state.fileSelection,
        [scope]:
          state.fileSelection[scope] === id
            ? (next[Math.min(refs.indexOf(id), next.length - 1)] ?? null)
            : state.fileSelection[scope],
      },
    })
    return Object.values(get().fileRefs).some((ids) => ids.includes(id))
  },
  forgetFile: (id) => {
    for (const scope of Object.keys(get().fileRefs)) {
      get().removeFile(id, scope === "global" ? scope : Number(scope))
    }
  },
  reorderFiles: (ids) => {
    const state = get()
    const refs = state.fileRefs[state.scope] ?? []
    const order = ids.filter((id) => refs.includes(id))
    set({
      fileRefs: {
        ...state.fileRefs,
        [state.scope]: [...order, ...refs.filter((id) => !order.includes(id))],
      },
    })
  },
}))

/**
 * `storage` listener: another window switched the mode, so this one follows
 * (keeping its own folder — `setEnabled` scopes to this window's active one).
 * The event's `newValue` is what was written then, possibly older than what is
 * stored by the time a queued event arrives, so the key is read again; an
 * unreadable store leaves the mode alone. `key === null` is a cleared store.
 */
export function followStoredFolderTabsPreference(event: StorageEvent) {
  const key = preferenceKey()
  if (event.key !== null && event.key !== key) return
  let stored: string | null
  try {
    stored = localStorage.getItem(key)
  } catch {
    return
  }
  useFolderTabsStore.getState().setEnabled(stored === "true")
}

export function resetFolderTabsStore() {
  useFolderTabsStore.setState(initialState())
}
registerBackendScopedStoreReset(resetFolderTabsStore)
