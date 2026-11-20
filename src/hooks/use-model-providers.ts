"use client"

import { useEffect } from "react"
import { create } from "zustand"
import { createTransportModelProviderService } from "@/lib/transport-model-provider-service"
import { onTransportReconnect, subscribe } from "@/lib/platform"
import type { UnsubscribeFn } from "@/lib/transport/types"
import type { ModelProviderRecord } from "@/lib/model-provider-types"

/**
 * Backend event emitted after any models.json write (create/update/delete/
 * reorder/enable). The conversation selector and settings pages refetch the
 * catalog on it so edits take effect in the chat picker without a restart.
 */
const MODEL_PROVIDERS_UPDATED_EVENT = "model-providers://updated"

export interface UseModelProvidersResult {
  /** `null` until the first successful load has settled. */
  records: ModelProviderRecord[] | null
  /** True once a reload has completed while the shared subscription is alive.
   *  Stays true for the lifetime of the subscription; resets when the last
   *  consumer unmounts (the cache drops to a cold state). */
  fresh: boolean
  refresh: () => Promise<void>
}

interface ModelProvidersStore {
  records: ModelProviderRecord[] | null
  fresh: boolean
  reload: () => Promise<void>
}

// Reload race guards, at module scope so they're shared by the single store.
// See the equivalent guards in `use-acp-agents` for why request and success
// ids are tracked separately.
let latestRequestId = 0
let latestSuccessId = 0

// Created lazily so importing the hook (or mounting it) never touches the
// transport until the first reload — keeps tests and pre-transport surfaces
// free of module-load side effects.
let service: ReturnType<typeof createTransportModelProviderService> | null =
  null

const useModelProvidersStore = create<ModelProvidersStore>((set) => ({
  records: null,
  fresh: false,
  reload: async () => {
    const requestId = latestRequestId + 1
    latestRequestId = requestId
    try {
      service ??= createTransportModelProviderService()
      const list = await service.list()
      if (requestId <= latestSuccessId) return
      latestSuccessId = requestId
      set({ records: list, fresh: true })
    } catch {
      // Keep the previous list — clearing on a transient failure would make the
      // chat picker and settings page flash empty for a moment.
    }
  },
}))

// ── Shared subscription, ref-counted across all hook instances ─────────────
// Mirrors the coalescing pattern in `use-acp-agents`: the Model Providers
// catalog is consumed by the settings page, the agent-settings source card, and
// every conversation model picker, so one shared fetch + event subscription
// keeps the network/scan cost flat regardless of how many consumers mount.
let refCount = 0
let disposers: Array<() => void> = []

function startSharedSubscription(): void {
  const reload = () => {
    if (refCount === 0) return
    void useModelProvidersStore.getState().reload()
  }

  // Defer the initial reload so a consumer mounting inside a render effect
  // never triggers a synchronous store write.
  queueMicrotask(reload)

  const onFocus = () => reload()
  window.addEventListener("focus", onFocus)
  disposers.push(() => window.removeEventListener("focus", onFocus))

  let eventUnsub: UnsubscribeFn | null = null
  let eventDisposed = false
  void subscribe<unknown>(MODEL_PROVIDERS_UPDATED_EVENT, reload)
    .then((dispose) => {
      if (eventDisposed) {
        dispose()
        return
      }
      eventUnsub = dispose
    })
    .catch(() => {
      // Transport doesn't support subscribe (shouldn't happen) — fall back to
      // the mount + focus triggers.
    })
  disposers.push(() => {
    eventDisposed = true
    if (eventUnsub) {
      try {
        eventUnsub()
      } catch {
        // Ignore — disposing twice or transport gone is harmless.
      }
    }
  })

  // Web/remote transports lose events emitted during a WS disconnect window
  // (the broadcaster drops them while `receiver_count == 0`). Re-fetching on
  // reconnect is the recovery path; no-op on Tauri IPC.
  const offReconnect = onTransportReconnect(reload)
  disposers.push(() => {
    if (offReconnect) {
      try {
        offReconnect()
      } catch {
        // Ignore.
      }
    }
  })
}

function acquireSharedSubscription(): () => void {
  refCount += 1
  if (refCount === 1) startSharedSubscription()
  return () => {
    refCount -= 1
    if (refCount === 0) {
      for (const dispose of disposers) dispose()
      disposers = []
      // Drop the cache to a COLD, non-authoritative state and invalidate any
      // in-flight reload so it can't repopulate it after the reset; the next
      // mount re-fetches from scratch.
      latestSuccessId = latestRequestId
      useModelProvidersStore.setState({ records: null, fresh: false })
    }
  }
}

/**
 * Subscribe to the shared Model Provider catalog (models.json). Every hook
 * instance shares ONE store, ONE fetch, and ONE set of focus /
 * `model-providers://updated` / reconnect listeners (ref-counted), mirroring
 * `useAcpAgents`.
 *
 * Behavior on error: the records list is **not cleared** — keeping the last
 * good cache prevents a transient API blip from silently degrading the pickers.
 */
export function useModelProviders(): UseModelProvidersResult {
  useEffect(() => acquireSharedSubscription(), [])
  const records = useModelProvidersStore((s) => s.records)
  const fresh = useModelProvidersStore((s) => s.fresh)
  const refresh = useModelProvidersStore((s) => s.reload)
  return { records, fresh, refresh }
}

/** Test-only: reset the shared store + module race/refcount state to a clean
 *  slate (disposing any live subscription). */
export function resetModelProvidersStore(): void {
  for (const dispose of disposers) dispose()
  disposers = []
  refCount = 0
  latestRequestId = 0
  latestSuccessId = 0
  useModelProvidersStore.setState({ records: null, fresh: false })
}
