// Optional numeric diagnostics. Never serialize application state or force GC.
import { isDesktop, isRemoteDesktopMode } from "@/lib/transport"

export const MEMORY_METRIC_KEYS = [
  "providersActive",
  "providersMounted",
  "providersUnmounted",
  "retiredStoresTracked",
  "retiredStoresAlive",
  "retiredTrackersDropped",
  "weakRefsAvailable",
  "activeTrackersDropped",
  "surfacesActive",
  "surfacesMounted",
  "surfacesUnmounted",
  "connections",
  "promptingConnections",
  "liveTextUnits",
  "toolTextUnits",
  "liveBlocks",
  "openTabKeys",
  "hydrationCaptures",
  "hydrationEvents",
  "unmappedConnections",
  "unmappedEvents",
  "streamingEvents",
  "pendingToolUpdates",
  "eventSubscribers",
  "runtimeSessions",
  "runtimeDetailTurns",
  "runtimeLocalTurns",
  "runtimeBackgroundTurns",
  "runtimeOptimisticTurns",
  "runtimePendingBackgroundSettlements",
  "runtimeLiveBlocks",
  "runtimeSessionsRetired",
  "retiredRuntimeSessionsAlive",
  "runtimeTurnsRetired",
  "retiredRuntimeTurnsAlive",
  "messageViewsRetired",
  "retiredMessageViewsAlive",
  "lifetimeTrackersDropped",
  "highlightCacheEntries",
  "highlightCacheEstimatedBytes",
  "highlightInFlight",
  "highlightWaiting",
  "documentHidden",
  "documentFocused",
  "overlayFoldRefetchEntries",
  "selectorsCacheEntries",
  "iframeCount",
  "htmlFrames",
  "htmlFrameBytes",
  "htmlViews",
  "htmlViewBytes",
  "htmlPins",
  "sampleDurationMicros",
] as const

export type MemoryMetric = (typeof MEMORY_METRIC_KEYS)[number]
export type MemoryCounters = Partial<Record<MemoryMetric, number>>
export interface FrontendMemorySample {
  reporterId: string
  metrics: MemoryCounters
}
type Reader = () => MemoryCounters
interface WeakReference<T extends object> {
  deref(): T | undefined
}
type WeakReferenceConstructor = new <T extends object>(
  target: T
) => WeakReference<T>
const KEYS = new Set<string>(MEMORY_METRIC_KEYS)
const TRACKER_LIMIT = 128
type RuntimeTarget = "session" | "turn"
const noop = () => {}
let pendingHtmlReader: Reader | undefined

/** Pure collector; scheduling/transport belong to the renderer singleton below. */
export function createFrontendMemoryTracker(options: {
  reporterId: string
  send: (sample: FrontendMemorySample) => Promise<void>
  now?: () => number
  iframeCount?: () => number
  documentState?: () => { hidden: boolean; focused: boolean }
}) {
  const weakReference = (
    globalThis as typeof globalThis & {
      WeakRef?: WeakReferenceConstructor
    }
  ).WeakRef
  const providers = new Map<
    number,
    { read: Reader; weak?: WeakReference<object> }
  >()
  const retired = new Map<number, WeakReference<object>>()
  const retiredSessions = new Map<number, WeakReference<object>>()
  const retiredTurns = new Map<number, WeakReference<object>>()
  const retiredViews = new Map<number, WeakReference<object>>()
  const viewActivations = new WeakMap<object, number>()
  const runtimeTargets = new WeakMap<object, number>()
  let serial = 0
  let sessionsRetired = 0
  let turnsRetired = 0
  let viewsRetired = 0
  let droppedLifetimes = 0
  let disposed = false
  let mounted = 0
  let unmounted = 0
  let droppedActive = 0
  let droppedRetired = 0
  let surfaces = 0
  let surfaceMounts = 0
  let surfaceUnmounts = 0
  let htmlReader: Reader | undefined
  let inFlight = false
  const now = options.now ?? (() => performance.now())

  function remember(
    entries: Map<number, WeakReference<object>>,
    id: number,
    weak: WeakReference<object>
  ) {
    if (entries.has(id)) return false
    if (entries.size >= TRACKER_LIMIT) {
      const oldest = entries.keys().next().value
      if (oldest !== undefined) entries.delete(oldest)
      droppedLifetimes++
    }
    entries.set(id, weak)
    return true
  }

  function recordRuntimeRetirement(kind: RuntimeTarget, target: object) {
    if (disposed || typeof weakReference !== "function") return
    const entries = kind === "session" ? retiredSessions : retiredTurns
    let id = runtimeTargets.get(target)
    if (id === undefined) {
      id = ++serial
      runtimeTargets.set(target, id)
    }
    if (remember(entries, id, new weakReference(target))) {
      if (kind === "session") sessionsRetired++
      else turnsRetired++
    }
  }

  function retireView(id: number, weak: WeakReference<object>) {
    if (disposed) return
    const target = weak.deref()
    // A StrictMode/layout ref replay may already have reclaimed this DOM
    // wrapper. An old cleanup must not retire its newer activation.
    if (!target || viewActivations.get(target) !== id) return
    if (remember(retiredViews, id, weak)) viewsRetired++
  }

  function registerMessageView(target: object) {
    if (disposed || typeof weakReference !== "function") return noop
    const previous = viewActivations.get(target)
    if (previous !== undefined) retiredViews.delete(previous)
    const id = ++serial
    viewActivations.set(target, id)
    // The cleanup may itself survive the view. Bind ONLY its WeakRef and ID,
    // never the DOM wrapper, an application callback, or the view's props.
    return retireView.bind(undefined, id, new weakReference(target))
  }

  function unregisterProvider(id: number) {
    const entry = providers.get(id)
    if (!entry) return
    providers.delete(id)
    unmounted++
    if (entry.weak) {
      if (retired.size >= TRACKER_LIMIT) {
        const oldest = retired.keys().next().value
        if (oldest !== undefined) retired.delete(oldest)
        droppedRetired++
      }
      // A retired entry contains ONLY a WeakRef, never its read callback.
      retired.set(id, entry.weak)
    }
  }

  function registerProvider(tracked: object, read: Reader) {
    if (disposed) return noop
    if (providers.size >= TRACKER_LIMIT) {
      droppedActive++
      return noop
    }
    const id = ++serial
    mounted++
    providers.set(id, {
      read,
      weak:
        typeof weakReference === "function"
          ? new weakReference(tracked)
          : undefined,
    })
    // Native bind captures only the ID and unregister function, not this
    // activation's tracked store/read callback, even on conservative engines.
    return unregisterProvider.bind(undefined, id)
  }

  function registerSurface() {
    if (disposed) return noop
    let active = true
    surfaces++
    surfaceMounts++
    return () => {
      if (!active) return
      active = false
      surfaces--
      surfaceUnmounts++
    }
  }

  function sample(): FrontendMemorySample {
    const started = now()
    for (const [id, weak] of retired) {
      if (!weak.deref()) retired.delete(id)
    }
    for (const entries of [retiredSessions, retiredTurns, retiredViews]) {
      for (const [id, weak] of entries) {
        if (!weak.deref()) entries.delete(id)
      }
    }
    const metrics: MemoryCounters = {
      providersActive: providers.size,
      providersMounted: mounted,
      providersUnmounted: unmounted,
      retiredStoresTracked: retired.size,
      retiredStoresAlive: retired.size,
      retiredTrackersDropped: droppedRetired,
      activeTrackersDropped: droppedActive,
      weakRefsAvailable: typeof weakReference === "function" ? 1 : 0,
      surfacesActive: surfaces,
      surfacesMounted: surfaceMounts,
      surfacesUnmounted: surfaceUnmounts,
      runtimeSessionsRetired: sessionsRetired,
      retiredRuntimeSessionsAlive: retiredSessions.size,
      runtimeTurnsRetired: turnsRetired,
      retiredRuntimeTurnsAlive: retiredTurns.size,
      messageViewsRetired: viewsRetired,
      retiredMessageViewsAlive: retiredViews.size,
      lifetimeTrackersDropped: droppedLifetimes,
    }
    const merge = (values: MemoryCounters) => {
      for (const [key, value] of Object.entries(values)) {
        if (!KEYS.has(key) || !Number.isSafeInteger(value) || value < 0)
          continue
        const name = key as MemoryMetric
        const next = (metrics[name] ?? 0) + value
        if (Number.isSafeInteger(next)) metrics[name] = next
      }
    }
    for (const entry of providers.values()) {
      try {
        merge(entry.read())
      } catch {
        /* diagnostics must not affect UI */
      }
    }
    if (htmlReader) {
      try {
        merge(htmlReader())
      } catch {
        /* optional collector unavailable */
      }
    }
    if (options.iframeCount) {
      try {
        merge({ iframeCount: options.iframeCount() })
      } catch {
        /* detached DOM */
      }
    }
    if (options.documentState) {
      try {
        const state = options.documentState()
        merge({
          documentHidden: state.hidden ? 1 : 0,
          documentFocused: state.focused ? 1 : 0,
        })
      } catch {
        /* page is navigating */
      }
    }
    const elapsed = now() - started
    metrics.sampleDurationMicros = Number.isFinite(elapsed)
      ? Math.min(
          Number.MAX_SAFE_INTEGER,
          Math.max(0, Math.floor(elapsed * 1000))
        )
      : 0
    return { reporterId: options.reporterId, metrics }
  }

  function flush(): Promise<void> {
    if (inFlight) return Promise.resolve()
    // Sampling is synchronous. The pending send owns numbers only, never
    // a read callback or a dereferenced retired store.
    const snapshot = sample()
    inFlight = true
    return Promise.resolve()
      .then(() => options.send(snapshot))
      .catch(() => {})
      .finally(() => {
        inFlight = false
      })
  }

  return {
    registerProvider,
    registerSurface,
    registerMessageView,
    recordRuntimeRetirement,
    setHtmlReader: (read: Reader) => {
      htmlReader = read
    },
    sample,
    flush,
    dispose: () => {
      disposed = true
      providers.clear()
      retired.clear()
      retiredSessions.clear()
      retiredTurns.clear()
      retiredViews.clear()
      htmlReader = undefined
    },
  }
}

type Tracker = ReturnType<typeof createFrontendMemoryTracker>
let singleton: Tracker | undefined

function tracker(): Tracker | undefined {
  if (process.env.NEXT_PUBLIC_CODEG_MEMORY_DIAGNOSTICS !== "1") return
  if (typeof window === "undefined" || !isDesktop() || isRemoteDesktopMode())
    return
  if (!singleton) {
    if (
      typeof crypto === "undefined" ||
      typeof crypto.randomUUID !== "function"
    )
      return
    singleton = createFrontendMemoryTracker({
      reporterId: crypto.randomUUID(),
      iframeCount: () => document.querySelectorAll("iframe").length,
      documentState: () => ({
        hidden: document.hidden,
        focused: document.hasFocus(),
      }),
      send: async (sample) => {
        // Always use the LOCAL shell transport; never send machine diagnostics
        // to a configured remote desktop/server or any external destination.
        const { getShellTransport } = await import("@/lib/transport")
        await getShellTransport().call("report_frontend_memory", { sample })
      },
    })
    if (pendingHtmlReader) singleton.setHtmlReader(pendingHtmlReader)
    const current = singleton
    const timer = window.setInterval(() => {
      if (!isRemoteDesktopMode()) void current.flush()
    }, 15_000)
    window.addEventListener("pagehide", (event) => {
      if (event.persisted) return
      clearInterval(timer)
      current.dispose()
      // A non-persisted pagehide can be followed by a remount in the same
      // renderer during a Tauri navigation. Do not leave a disposed tracker
      // in the singleton: the next Provider must create a fresh timer.
      if (singleton === current) singleton = undefined
    })
  }
  return singleton
}

export function registerFrontendMemoryProvider(tracked: object, read: Reader) {
  return tracker()?.registerProvider(tracked, read) ?? noop
}

export function registerFrontendMemorySurface() {
  return tracker()?.registerSurface() ?? noop
}

/** Weak JS-wrapper observations only; survival is not a retained-byte count. */
export function registerFrontendMemoryMessageView(target: object) {
  return tracker()?.registerMessageView(target) ?? noop
}

export function recordFrontendMemoryRuntimeRetirement(
  kind: RuntimeTarget,
  target: object
) {
  // A late teardown after pagehide must not start a new reporter/timer.
  singleton?.recordRuntimeRetirement(kind, target)
}

export function registerFrontendHtmlMemory(read: Reader) {
  pendingHtmlReader = read
  tracker()?.setHtmlReader(read)
}
