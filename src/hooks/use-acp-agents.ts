"use client"

import { useEffect } from "react"
import { create } from "zustand"
import { acpListAgents } from "@/lib/api"
import { setCustomAgentDisplay } from "@/lib/custom-agents"
import { onTransportReconnect, subscribe } from "@/lib/platform"
import type { UnsubscribeFn } from "@/lib/transport/types"
import type { AcpAgentInfo } from "@/lib/types"

const ACP_AGENTS_UPDATED_EVENT = "app://acp-agents-updated"

export interface UseAcpAgentsResult {
  /** Agents sorted by `sort_order` then `name`. No filtering applied. */
  agents: AcpAgentInfo[]
  /**
   * Whether a successful reload has completed while the shared subscription is
   * alive. Stays true for the lifetime of that subscription; it resets to false
   * only when the last consumer unmounts, at which point the shared cache is
   * dropped to a cold state (see the store module). Consumers use this to decide
   * when "best-guess" defaults can be replaced with the real list.
   */
  fresh: boolean
  /** Manual refresh — useful for explicit user-driven retries. */
  refresh: () => Promise<void>
}

interface AcpAgentsStore {
  agents: AcpAgentInfo[]
  fresh: boolean
  reload: () => Promise<void>
}

// Reload race guards, at module scope so they're shared by the single store.
// `latestRequestId` tracks the most recently issued reload; `latestSuccessId`
// the most recent reload that actually wrote state. Splitting these matters
// when reloads race: if #1 starts then #2 starts then #1 succeeds, a single
// counter would discard #1's valid data (requestId(1) !== latest(2)); if #2
// then failed or was still pending, `fresh` would stay false forever despite
// #1 having returned a usable list. The success-id counter only bumps on actual
// writes, so #1's success can latch `fresh`, and a later #2 success can still
// overwrite #1's data (monotonic).
let latestRequestId = 0
let latestSuccessId = 0

const useAcpAgentsStore = create<AcpAgentsStore>((set) => ({
  agents: [],
  fresh: false,
  reload: async () => {
    const requestId = latestRequestId + 1
    latestRequestId = requestId
    try {
      const list = await acpListAgents()
      // Only bail if a strictly later success has already committed state —
      // older successes are still useful when newer requests are pending or
      // failed.
      if (requestId <= latestSuccessId) return
      latestSuccessId = requestId
      const sorted = [...list].sort(
        (a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name)
      )
      // Publish custom agents' display names and icons for `getAgentLabel` /
      // `getAgentIconUrl`. This hook is the app's single, always-mounted source
      // of the agent registry, so hydrating here covers every label call site
      // (sidebar, composer, status bar) without threading a context through all
      // of them.
      setCustomAgentDisplay(
        sorted.map((agent) => ({
          agentType: agent.agent_type,
          name: agent.name,
          iconUrl: agent.icon_url,
        }))
      )
      set({ agents: sorted, fresh: true })
    } catch {
      // Keep the previous list — clearing on transient failure would silently
      // regress downstream defaults to AGENT_DISPLAY_ORDER[0].
    }
  },
}))

// ── Shared subscription, ref-counted across all hook instances ─────────────
// Previously EACH useAcpAgents() instance ran its own initial fetch, `window`
// focus listener, `app://acp-agents-updated` subscription, and reconnect
// handler. With the registry consumed by TabProvider + SidebarConversationList
// (both always mounted) plus AgentSelector / reference search / skill-id
// resolution, that meant several duplicate `acpListAgents()` scans on every
// window focus and every registry-updated event. One shared, ref-counted
// subscription keeps that cost flat regardless of how many consumers mount —
// mirroring the coalescing `use-enabled-skill-ids` already does for its own
// status snapshot. When the last consumer leaves, the cleanup resets the store
// to a cold state (see `acquireSharedSubscription`), so a later remount always
// re-fetches from scratch rather than exposing a possibly-missed-update cache.
let refCount = 0
let disposers: Array<() => void> = []

function startSharedSubscription(): void {
  // A shared reload that no-ops when no consumer is subscribed. Guarding here
  // (rather than at each call site) closes every "a reload fires after the last
  // consumer unmounts" path at once: the deferred initial microtask below, and
  // — because `subscribe()` is async and web/remote transports register the
  // handler BEFORE the returned promise resolves — an `acp-agents-updated` event
  // arriving after dispose but before `.then(dispose)` has run. A not-yet-started
  // reload hasn't incremented `latestRequestId`, so the cleanup's in-flight
  // invalidation can't catch it; skipping at `refCount === 0` keeps it from
  // fetching and repopulating `{fresh:true}` on the cold, zero-ref store. (An
  // explicit `refresh()` from a mounted consumer bypasses this by calling the
  // store's reload directly, which is correct — its refCount is ≥ 1.)
  const reload = () => {
    if (refCount === 0) return
    void useAcpAgentsStore.getState().reload()
  }

  // Defer the initial reload to the next microtask so a caller mounting this
  // (inside a render effect) never triggers a synchronous store write. The
  // reload's writes fire post-await regardless; this only keeps analysis simple
  // and has no user-visible cost (still resolves before paint).
  queueMicrotask(reload)

  const onFocus = () => reload()
  window.addEventListener("focus", onFocus)
  disposers.push(() => window.removeEventListener("focus", onFocus))

  let eventUnsub: UnsubscribeFn | null = null
  let eventDisposed = false
  void subscribe<unknown>(ACP_AGENTS_UPDATED_EVENT, reload)
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
      // With zero subscribers the listeners are gone, so a registry update
      // during this gap would be missed. Drop the cache to a COLD,
      // non-authoritative state (and invalidate any in-flight reload so it
      // can't repopulate it after the reset) so the next mount re-fetches from
      // scratch — exactly like the old per-instance hook, where every mount
      // started `fresh=false` with no agents. Without this, a remount would see
      // the possibly-stale cache as `fresh=true` and drive a `fresh`-gated
      // default (or an AgentSelector fallback, which reads `agents` ungated)
      // before the fresh reload lands. In the running app TabProvider +
      // SidebarConversationList keep the refcount ≥ 1 for the whole session, so
      // this only fires on full teardown.
      latestSuccessId = latestRequestId
      useAcpAgentsStore.setState({ agents: [], fresh: false })
    }
  }
}

/**
 * Subscribe to the ACP agent registry. Every hook instance shares ONE store,
 * ONE fetch, and ONE set of focus / `app://acp-agents-updated` / reconnect
 * listeners (ref-counted) — previously each instance duplicated all of them and
 * the direct Tauri event API, bypassing the platform layer. Uses the
 * platform-agnostic `subscribe()` so the event path works in desktop and web.
 *
 * Behavior on error: the agents list is **not cleared** — keeping the last good
 * cache prevents a transient API blip from silently degrading downstream
 * defaults.
 */
export function useAcpAgents(): UseAcpAgentsResult {
  useEffect(() => acquireSharedSubscription(), [])
  const agents = useAcpAgentsStore((s) => s.agents)
  const fresh = useAcpAgentsStore((s) => s.fresh)
  const refresh = useAcpAgentsStore((s) => s.reload)
  return { agents, fresh, refresh }
}

/**
 * Read the shared registry WITHOUT subscribing — for event handlers (a send, a
 * menu action) that need the current list at the moment they run and must not
 * re-render their host on every reload. In the running app TabProvider +
 * SidebarConversationList hold the refcount ≥ 1 for the whole session, so this
 * is warm; a cold store answers `[]`, which callers must read as "registry
 * unknown" rather than "no agents exist".
 */
export function acpAgentsSnapshot(): AcpAgentInfo[] {
  return useAcpAgentsStore.getState().agents
}

/** Test-only: reset the shared store + module race/refcount state to a clean
 *  slate (disposing any live subscription). */
export function resetAcpAgentsStore(): void {
  for (const dispose of disposers) dispose()
  disposers = []
  refCount = 0
  latestRequestId = 0
  latestSuccessId = 0
  useAcpAgentsStore.setState({ agents: [], fresh: false })
}
