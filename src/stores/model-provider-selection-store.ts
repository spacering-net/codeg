"use client"

import { create } from "zustand"

/** A pre-bind Model Provider choice made in a draft composer. */
export interface ModelProviderDraftSelection {
  providerId: string
  modelId: string
}

interface ModelProviderSelectionStore {
  drafts: Record<string, ModelProviderDraftSelection>
  /**
   * (tabId, agentType) pairs whose remembered-choice auto-restore has already
   * been offered (seeded) or explicitly declined (user reset). Keyed
   * `${tabId}:${agentType}` so switching agents on a draft restores each
   * agent's own memory, while an explicit reset is never fought.
   */
  restoreSettledKeys: Record<string, true>
  /**
   * Tab ids whose draft choice is currently being persisted to a bound
   * conversation (send path). Until the authoritative row broadcast lands, the
   * conversation row still looks selection-less; this marker tells the picker's
   * auto-default that a choice IS being written, so it must not fill the slot
   * with the first visible provider's first model.
   */
  writesInFlight: Record<string, true>
  setDraft: (tabId: string, selection: ModelProviderDraftSelection) => void
  clearDraft: (tabId: string) => void
  consumeDraft: (tabId: string) => ModelProviderDraftSelection | null
  markRestoreSettled: (key: string) => void
  isRestoreSettled: (key: string) => boolean
  markWriteInFlight: (tabId: string) => void
  clearWriteInFlight: (tabId: string) => void
  isWriteInFlight: (tabId: string) => boolean
}

/**
 * Draft Model Provider choices only live until a draft conversation is bound.
 * They are keyed by tab (not component instance) because the composer can mount
 * two picker instances (inline + collapsed) and can remount either one as
 * selectors/connection state changes.
 */
const useModelProviderSelectionStore = create<ModelProviderSelectionStore>(
  (set, get) => ({
    drafts: {},
    restoreSettledKeys: {},
    writesInFlight: {},
    setDraft: (tabId, selection) =>
      set((state) => ({ drafts: { ...state.drafts, [tabId]: selection } })),
    clearDraft: (tabId) =>
      set((state) => {
        if (!(tabId in state.drafts)) return state
        const drafts = { ...state.drafts }
        delete drafts[tabId]
        return { drafts }
      }),
    consumeDraft: (tabId) => {
      const selection = get().drafts[tabId] ?? null
      if (selection) get().clearDraft(tabId)
      return selection
    },
    markRestoreSettled: (key) =>
      set((state) =>
        key in state.restoreSettledKeys
          ? state
          : {
              restoreSettledKeys: {
                ...state.restoreSettledKeys,
                [key]: true,
              },
            }
      ),
    isRestoreSettled: (key) => key in get().restoreSettledKeys,
    markWriteInFlight: (tabId) =>
      set((state) =>
        tabId in state.writesInFlight
          ? state
          : { writesInFlight: { ...state.writesInFlight, [tabId]: true } }
      ),
    clearWriteInFlight: (tabId) =>
      set((state) => {
        if (!(tabId in state.writesInFlight)) return state
        const writesInFlight = { ...state.writesInFlight }
        delete writesInFlight[tabId]
        return { writesInFlight }
      }),
    isWriteInFlight: (tabId) => tabId in get().writesInFlight,
  })
)

/** Read the draft choice outside React (tests and non-hook send paths). */
export function getModelProviderDraftSelection(
  tabId?: string | null
): ModelProviderDraftSelection | null {
  return tabId == null
    ? null
    : (useModelProviderSelectionStore.getState().drafts[tabId] ?? null)
}

/** Subscribe to the draft choice for one composer tab. */
export function useModelProviderDraftSelection(
  tabId?: string | null
): ModelProviderDraftSelection | null {
  return useModelProviderSelectionStore((s) =>
    tabId == null ? null : (s.drafts[tabId] ?? null)
  )
}

/** Store a selection made before the conversation row exists. */
export function setModelProviderDraftSelection(
  tabId: string,
  selection: ModelProviderDraftSelection
): void {
  useModelProviderSelectionStore.getState().setDraft(tabId, selection)
}

/** Remove one tab's draft choice without affecting other tabs. */
export function clearModelProviderDraftSelection(tabId: string): void {
  useModelProviderSelectionStore.getState().clearDraft(tabId)
}

/** Atomically take the draft for the send path, preventing duplicate saves. */
export function consumeModelProviderDraftSelection(
  tabId: string
): ModelProviderDraftSelection | null {
  return useModelProviderSelectionStore.getState().consumeDraft(tabId)
}

/** Mark one (tab, agent) key as settled so remembered choices stop being
 *  auto-restored for it (seeded once, or explicitly declined via reset). */
export function markModelProviderRestoreSettled(key: string): void {
  useModelProviderSelectionStore.getState().markRestoreSettled(key)
}

/** True once the remembered-choice auto-restore was offered/declined for a
 *  (tab, agent) key. */
export function isModelProviderRestoreSettled(key: string): boolean {
  return useModelProviderSelectionStore.getState().isRestoreSettled(key)
}

/** Mark a tab's draft choice as being persisted to its bound conversation
 *  (send path). The picker's auto-default holds off while this is set, so the
 *  still-selection-less row is never mistaken for "no choice was ever made". */
export function markModelProviderSelectionWriteInFlight(tabId: string): void {
  useModelProviderSelectionStore.getState().markWriteInFlight(tabId)
}

/** Release the write-in-flight marker once the save resolved (or failed). */
export function clearModelProviderSelectionWriteInFlight(tabId: string): void {
  useModelProviderSelectionStore.getState().clearWriteInFlight(tabId)
}

/** True while a tab's draft choice is being persisted to its conversation. */
export function isModelProviderSelectionWriteInFlight(
  tabId?: string | null
): boolean {
  return tabId == null
    ? false
    : useModelProviderSelectionStore.getState().isWriteInFlight(tabId)
}

/** Test-only: clear all tab-keyed draft selections and restore markers. */
export function resetModelProviderSelectionStore(): void {
  useModelProviderSelectionStore.setState({
    drafts: {},
    restoreSettledKeys: {},
    writesInFlight: {},
  })
}
