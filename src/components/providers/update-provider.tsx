"use client"

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import {
  type AppUpdateInfo,
  type AppUpdateState,
  checkAppUpdateInfo,
  confirmRollbackVersion,
  describeAppUpdateError,
  getAppUpdateState,
  getCurrentAppVersion,
  getRunningServerVersion,
  getServerUpdateStatus,
  normalizeAppUpdateError,
  readServerVersionStrict,
  restartApp,
  rollbackServer,
  startAppUpdate,
  subscribeAppUpdateState,
  usesTauriUpdater,
  waitForServerHealthy,
} from "@/lib/updater"
import {
  type CachedUpdateCheck,
  clearLastCheck,
  dismissedVersionStorageKey,
  lastCheckStorageKey,
  readDismissedVersion,
  readLastCheck,
  writeDismissedVersion,
  writeLastCheck,
} from "@/lib/update-check-storage"
import { getTransport } from "@/lib/transport"
import { extractAppCommandError } from "@/lib/app-error"
import type { AppCommandError } from "@/lib/types"

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

const IDLE_STATE: AppUpdateState = { seq: 0, status: "idle" }

/** How long a completed check stays fresh. Also the polling period for a
 * long-lived window — codeg workspaces are commonly left open for days, so a
 * check-on-boot alone would never surface a release. */
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000
/** Delay before the first automatic check, so the manifest fetch doesn't
 * compete with workspace boot (folder scan, session load, agent connect). */
const FIRST_CHECK_DELAY_MS = 8000
/** Minimum gap between automatic attempts, independent of whether they
 * succeeded. Only completions are persisted, so without this an offline window
 * would re-fetch on every tab focus. */
const AUTO_RETRY_FLOOR_MS = 10 * 60 * 1000

const LIFECYCLES = new Set([
  "idle",
  "downloading",
  "installing",
  "ready_to_restart",
  "restarting",
  "error",
])

/** Reject payloads that aren't a well-formed AppUpdateState — e.g. an older
 * remote server whose `perform_app_update` still returns the legacy
 * `{ version, needRestart, ... }` shape with no seq/status. Without this an
 * undefined `seq` would poison the monotonic guard. */
function isAppUpdateState(x: unknown): x is AppUpdateState {
  if (!x || typeof x !== "object") return false
  const c = x as Record<string, unknown>
  return typeof c.seq === "number" && LIFECYCLES.has(c.status as string)
}

export interface UpdateContextValue {
  /** Backend-owned lifecycle. The single source of truth, re-synced on mount
   * so it survives navigation and reloads. */
  state: AppUpdateState
  /** A download/install is actively in progress. */
  isUpdating: boolean
  /** Seconds remaining on the post-restart countdown (server mode), or null. */
  restartCountdown: number | null
  /** A rollback is being applied. */
  isRollingBack: boolean
  /** A relaunch has been requested and is in progress. */
  isRestarting: boolean
  /** True once the first authoritative state has landed. Before this, `state`
   * is the default `idle` placeholder and must not be treated as a real
   * backend status. */
  hydrated: boolean
  /** Any action (update / restart / rollback) is in flight — for disabling
   * controls without each consumer re-deriving it. */
  isBusy: boolean

  // ─── Availability (is a newer release out there?) ────────────────────────
  // Distinct from the lifecycle above, which only describes an update the user
  // already started. Owned here so the status-bar badge and the settings page
  // share one answer — and one manifest fetch.

  /** The newer release, or null when up to date / not yet checked. */
  available: AppUpdateInfo | null
  /** The running version, from the last check (or "" before the first one). */
  currentVersion: string
  /** A check is in flight. */
  checking: boolean
  /** Raw failure message from the last check; classify with
   * {@link normalizeAppUpdateError}. Cleared by the next successful check. */
  checkError: string | null
  /** When the last check completed (restored from storage across reloads). */
  lastCheckedAt: Date | null
  /** Server-mode capability bits from the last check. Absent on desktop. */
  selfUpdateSupported: boolean
  liveProgress: boolean
  runtime: string | undefined
  rollbackAvailable: boolean
  /** What keeps this server from updating in place although it supports
   * doing so — an install directory it can't write, found by the same
   * preflight the update runs first (a `permission_denied` one rules out a
   * rollback too). Render with `describeAppUpdateError`. Written only by the
   * local status refresh, which runs one request at a time, so an older answer
   * can't land over a newer one. Null when nothing is in the way, on desktop,
   * and on older servers. */
  selfUpdateBlocker: AppCommandError | null
  /** This client can actually drive an in-place install — desktop (Tauri
   * plugin) or a server speaking the live-progress protocol with nothing in
   * the way. When false the UI offers a "view release" link instead. */
  canInstallInPlace: boolean
  /** Version the user dismissed the badge for, if any. */
  dismissedVersion: string | null
  /** Ask the release source now. De-duplicated: a second call while one is in
   * flight attaches to it. `silent` (the default) reports failures only through
   * {@link checkError}; pass false for a user-initiated check that should toast. */
  checkNow: (opts?: { silent?: boolean }) => Promise<void>
  /** Stop surfacing the badge for the currently-available version. */
  dismissAvailable: () => void
  /** Re-read the LOCAL facts (version, capability, rollback availability)
   * without contacting the release source — so those stay accurate during an
   * outage, when a manifest check can't help. */
  refreshLocalStatus: () => Promise<void>

  /** Begin (or attach to) a background download+install of the available
   * update. Progress arrives via {@link state}. */
  startUpdate: () => Promise<void>
  /** Relaunch into the staged update. Call when `state.status` is
   * `ready_to_restart`. Desktop relaunches the app; server drives the
   * countdown + health-poll + reload. */
  restart: () => Promise<void>
  /** Revert to the previously-installed server bundle (server mode only). */
  rollback: () => Promise<void>
}

const UpdateContext = createContext<UpdateContextValue | null>(null)

/** Drive the visible "restarting in N…" countdown over the relaunch delay, then
 * resolve so the caller can start polling /health. */
function countdown(
  delayMs: number,
  onTick: (seconds: number) => void
): Promise<void> {
  const totalWaitMs = delayMs + 1000
  const start = Date.now()
  return new Promise<void>((resolve) => {
    const tick = () => {
      const remaining = Math.max(0, totalWaitMs - (Date.now() - start))
      onTick(Math.ceil(remaining / 1000))
      if (remaining <= 0) resolve()
      else setTimeout(tick, 250)
    }
    tick()
  })
}

export function UpdateProvider({ children }: { children: React.ReactNode }) {
  const t = useTranslations("SystemSettings")
  const [state, setState] = useState<AppUpdateState>(IDLE_STATE)
  const [restartCountdown, setRestartCountdown] = useState<number | null>(null)
  const [isRollingBack, setIsRollingBack] = useState(false)
  // True from the moment a relaunch is requested until it completes (or the app
  // is gone). Covers the desktop window between the click and the backend's
  // `restarting` event — where neither restartCountdown nor status would yet
  // mark us busy — so a second click can't re-trigger the relaunch.
  const [isRestarting, setIsRestarting] = useState(false)
  // False until the first authoritative state (snapshot or event) lands. Until
  // then `state` is the default `idle` placeholder, which consumers must not
  // treat as a real "idle" backend status (e.g. offering rollback).
  const [hydrated, setHydrated] = useState(false)

  // ─── Availability ───────────────────────────────────────────────────────
  const [available, setAvailable] = useState<AppUpdateInfo | null>(null)
  const [currentVersion, setCurrentVersion] = useState("")
  const [checking, setChecking] = useState(false)
  const [checkError, setCheckError] = useState<string | null>(null)
  const [lastCheckedAt, setLastCheckedAt] = useState<Date | null>(null)
  const [selfUpdateSupported, setSelfUpdateSupported] = useState(false)
  const [liveProgress, setLiveProgress] = useState(false)
  const [runtime, setRuntime] = useState<string | undefined>(undefined)
  const [rollbackAvailable, setRollbackAvailable] = useState(false)
  const [selfUpdateBlocker, setSelfUpdateBlocker] =
    useState<AppCommandError | null>(null)
  const [dismissedVersion, setDismissedVersion] = useState<string | null>(null)

  // Completion time of the answer currently applied to state, as a watermark so
  // a cached result is never adopted over a fresher one we already hold.
  const appliedAtRef = useRef(0)
  // The running version the applied answer was computed against. Tracked in
  // memory because the answer can outlive its storage entry: a sibling window
  // that installs the update clears the shared cache, and this window — which
  // never reloaded — would otherwise keep advertising it.
  const appliedBaselineRef = useRef<string | null>(null)
  // Version of the applied offer (null = "up to date"), so an equal-timestamp
  // entry can be told apart from a re-read of the one we already hold. See
  // `adoptCached`.
  const appliedOfferRef = useRef<string | null>(null)

  /** Re-read which release the user waved away. Split out from `adoptCached`
   * because a dismissal moves independently of the check cache: the user can
   * dismiss a release we ALREADY hold, which writes the dismissal key and
   * nothing else. */
  const syncDismissed = useCallback(() => {
    setDismissedVersion(readDismissedVersion())
  }, [])

  /** Apply a stored result — ours from a previous run, or one a sibling window
   * recorded while we sat idle. */
  const adoptCached = useCallback(
    (cached: CachedUpdateCheck) => {
      // Ahead of the freshness guard on purpose. A sibling window's "Later"
      // leaves `cached.at` untouched, so gating this read on a newer cache
      // would strand every window that already holds the same answer: they'd
      // keep showing the full accented badge for a release the user waved away
      // next door, until their own next check happened to find something newer.
      syncDismissed()
      // Strictly older always loses to the answer already applied.
      if (cached.at < appliedAtRef.current) return
      // An EQUAL stamp usually means we're re-reading our own entry, and
      // re-applying it would hand every consumer a fresh `info` object to
      // re-render against on each visibility change. But it can also be a
      // sibling that finished its check in the same millisecond and got a
      // DIFFERENT answer, because a release landed between the two requests.
      // Discarding that one would be worse than a wasted render: the dismissal
      // read above has already un-muted us, so the badge would go loud
      // advertising the older release and its stale notes. Compare the payload
      // and let content, not the clock, break the tie.
      if (
        cached.at === appliedAtRef.current &&
        (cached.info?.version ?? null) === appliedOfferRef.current &&
        (!cached.currentVersion ||
          cached.currentVersion === appliedBaselineRef.current)
      ) {
        return
      }
      appliedAtRef.current = cached.at
      appliedOfferRef.current = cached.info?.version ?? null
      setLastCheckedAt(new Date(cached.at))
      setAvailable(cached.info)
      if (cached.currentVersion) {
        appliedBaselineRef.current = cached.currentVersion
        setCurrentVersion(cached.currentVersion)
      }
    },
    [syncDismissed]
  )

  // Seed from the persisted result once on mount, so a reload shows the badge
  // immediately rather than going quiet until the next check. Reading storage
  // during render would break the static-export pass, so it happens here.
  useEffect(() => {
    syncDismissed()
    const last = readLastCheck()
    if (last) adoptCached(last)
  }, [adoptCached, syncDismissed])

  // `storage` fires in the OTHER windows of this origin, so what one workspace
  // window learns reaches its siblings right away instead of at whatever point
  // they next run a check. Belt-and-braces with the reads in `adoptCached`:
  // this is the immediate path, that one is the reliable fallback if a webview
  // doesn't deliver the event across windows.
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      const key = event.key
      // A null key means storage was cleared wholesale — that touches both.
      if (
        key !== null &&
        key !== dismissedVersionStorageKey() &&
        key !== lastCheckStorageKey()
      ) {
        return
      }
      // Both halves get re-read on either key, because they move together and
      // NOT atomically: a window that finds a newer release writes the cache
      // first and only then drops the now-stale dismissal. Watching just the
      // dismissal would un-mute this window while it still held the previous
      // offer — a loud badge showing the old version number and old release
      // notes until its next check. Re-reading both keeps them in step
      // whichever event arrives first.
      const last = readLastCheck()
      if (last) adoptCached(last)
      else syncDismissed()
    }
    window.addEventListener("storage", onStorage)
    return () => window.removeEventListener("storage", onStorage)
  }, [adoptCached, syncDismissed])

  // Mirror state into a ref so the action callbacks read the latest snapshot
  // without being re-created on every transition.
  const stateRef = useRef(state)
  useEffect(() => {
    stateRef.current = state
  }, [state])

  // Highest seq applied. Guards against a late snapshot clobbering a fresher
  // live event (or vice-versa). seq is per-process and resets to 0 in a new
  // process; on a reconnect the high-water is reset so the new process's
  // snapshot is accepted (see `resync`). The effective transport is fixed for
  // this provider's lifetime: a window is born remote (URL `remoteConnectionId`,
  // preserved across settings navigation) or local and stays so; switching to a
  // different backend goes through `RemoteConnectionGate`'s loading state, which
  // unmounts and remounts this provider. So arming once at mount is correct.
  const latestSeqRef = useRef(0)
  // Bumped on every reconnect reset, so a snapshot fetch started before the
  // reset cannot apply after it.
  const resyncEpochRef = useRef(0)
  const applyState = useCallback((next: unknown) => {
    if (!isAppUpdateState(next)) return
    if (next.seq < latestSeqRef.current) return
    latestSeqRef.current = next.seq
    setState(next)
    setHydrated(true)
  }, [])

  // Arm the subscription BEFORE fetching the snapshot so no transition is
  // missed in the gap. Re-sync on transport reconnect.
  useEffect(() => {
    let cancelled = false
    let unsub: (() => void) | null = null

    const resync = async (resetForReconnect = false) => {
      // A reconnect may mean the backend process restarted (server self-update,
      // crash, supervisor relaunch) with its seq back at 0. Reset the
      // high-water and bump the epoch so the authoritative post-reset snapshot
      // is accepted, and a fetch started before the reset is discarded when it
      // resolves.
      if (resetForReconnect) {
        resyncEpochRef.current += 1
        latestSeqRef.current = 0
      }
      const epoch = resyncEpochRef.current
      try {
        const snap = await getAppUpdateState()
        // Discard if we unmounted, or a newer reset superseded this fetch while
        // it was in flight.
        if (cancelled || epoch !== resyncEpochRef.current) return
        applyState(snap)
      } catch (err) {
        console.error("[Update] snapshot failed:", err)
      }
    }

    const arm = async () => {
      try {
        const u = await subscribeAppUpdateState((s) => {
          if (!cancelled) applyState(s)
        })
        // If we unmounted while subscribing, the cleanup below already ran with
        // a null `unsub` — tear the subscription down here so it doesn't leak.
        if (cancelled) {
          u()
          return
        }
        unsub = u
      } catch (err) {
        // Not fatal: the snapshot below still seeds current state, and a later
        // reconnect re-arms. The login screen (no auth yet) lands here.
        console.error("[Update] subscribe failed:", err)
      }
      if (!cancelled) await resync()
    }

    void arm()
    const offReconnect = getTransport().onReconnect?.(() => {
      void resync(true)
    })

    return () => {
      cancelled = true
      unsub?.()
      offReconnect?.()
    }
  }, [applyState])

  // ─── Availability check ─────────────────────────────────────────────────

  // Live for the provider's lifetime; guards state writes from a check that
  // resolves after the tree is gone.
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  // The in-flight check, so a manual click and the scheduler share one fetch
  // instead of racing two manifest requests.
  const inFlightCheckRef = useRef<Promise<void> | null>(null)
  // Same, for the local-status round-trip (mount, lifecycle error, reconnect).
  const inFlightRefreshRef = useRef<Promise<void> | null>(null)
  // The single follow-up pass owed to callers who arrived while that round-trip
  // was already running. See `refreshLocalStatus`.
  const trailingRefreshRef = useRef<Promise<void> | null>(null)
  // `refreshLocalStatus`, for `runCheck` above its declaration.
  const refreshLocalStatusRef = useRef<() => Promise<void>>(() =>
    Promise.resolve()
  )

  const runCheck = useCallback(
    async (silent: boolean) => {
      setChecking(true)
      try {
        // Read what would block installing an update before asking whether
        // one exists, so an offer never comes with a verdict older than the
        // check itself. Before, not after: nothing may run between an answer
        // and its publication, or a refresh there that found another process
        // running could no longer discard that answer. The status refresh
        // stays the verdict's only writer.
        await refreshLocalStatusRef.current().catch(() => {})
        if (!mountedRef.current) return
        const result = await checkAppUpdateInfo()
        if (!mountedRef.current) return
        setCurrentVersion(result.currentVersion)
        setAvailable(result.update)
        setSelfUpdateSupported(result.selfUpdateSupported ?? false)
        setLiveProgress(result.liveProgress ?? false)
        setRuntime(result.runtime)
        setRollbackAvailable(result.rollbackAvailable ?? false)
        setCheckError(null)

        const now = Date.now()
        writeLastCheck({
          at: now,
          currentVersion: result.currentVersion,
          info: result.update,
        })
        appliedAtRef.current = now
        appliedOfferRef.current = result.update?.version ?? null
        appliedBaselineRef.current = result.currentVersion || null
        setLastCheckedAt(new Date(now))

        // A dismissal silences exactly one release. Once that release is no
        // longer the newest thing on offer, drop it so the next one surfaces.
        setDismissedVersion((prev) => {
          if (!prev || prev === result.update?.version) return prev
          writeDismissedVersion(null)
          return null
        })
      } catch (err) {
        const { rawMessage } = normalizeAppUpdateError(err)
        if (mountedRef.current) setCheckError(rawMessage)
        if (!silent) {
          const reason = describeAppUpdateError(err, "check")
          toast.error(
            t("checkUpdateFailed", {
              message: t(reason.key, reason.values),
            })
          )
        }
        console.error("[Update] check failed:", err)
      } finally {
        if (mountedRef.current) setChecking(false)
      }
    },
    [t]
  )

  const checkNow = useCallback(
    (opts?: { silent?: boolean }) => {
      const existing = inFlightCheckRef.current
      if (existing) return existing
      const p = runCheck(opts?.silent ?? true).finally(() => {
        inFlightCheckRef.current = null
      })
      inFlightCheckRef.current = p
      return p
    },
    [runCheck]
  )

  // Mirrored into a ref so the scheduler below can mount once — re-arming it on
  // every lifecycle transition would keep resetting the interval and the
  // first-check delay.
  const checkNowRef = useRef(checkNow)
  useEffect(() => {
    checkNowRef.current = checkNow
  }, [checkNow])

  /**
   * Drop an availability answer that was computed against a different running
   * version than the one actually running now.
   *
   * The case that matters is an update landing: the answer says "0.21.9 is
   * available" while the app is now *running* 0.21.9, and the 6h freshness
   * guard would keep re-offering the release the user just installed. Two
   * shapes of it:
   *   * the window relaunched/reloaded and re-seeded from the shared cache;
   *   * a *sibling* window that never reloaded (its backend restarted under it)
   *     still holds the answer in memory, and the initiating window has already
   *     cleared the shared cache — hence the in-memory baseline check.
   *
   * Comparing baselines rather than release versions also covers rollbacks and
   * sideways installs, with no need for a semver comparator.
   */
  const discardStaleAvailability = useCallback((running: string) => {
    const cached = readLastCheck()
    const cacheStale =
      !!cached?.currentVersion && cached.currentVersion !== running
    const memoryStale =
      !!appliedBaselineRef.current && appliedBaselineRef.current !== running
    if (cacheStale) clearLastCheck()
    if (!cacheStale && !memoryStale) return
    appliedAtRef.current = 0
    appliedOfferRef.current = null
    appliedBaselineRef.current = null
    setAvailable(null)
    setLastCheckedAt(null)
    // Ask again now: waiting for the next scheduled tick could leave the UI
    // blank for 6h if this landed after the startup timer had already run.
    void checkNowRef.current({ silent: true })
  }, [])

  /**
   * Refresh the LOCAL facts (running version, self-update capability, rollback
   * availability) without contacting the release source. Must stay reachable
   * when the manifest is down — the rollback affordance depends on it, and it
   * is what lets the settings page show a version during an outage.
   */
  const runRefresh = useCallback(async () => {
    let running: string | null = null
    try {
      if (usesTauriUpdater()) {
        const version = await getCurrentAppVersion()
        running = version === "unknown" ? null : version
      } else {
        try {
          const status = await getServerUpdateStatus()
          if (status) {
            running = status.currentVersion
            if (mountedRef.current) {
              setSelfUpdateSupported(status.selfUpdateSupported)
              setLiveProgress(status.liveProgress ?? false)
              setRuntime(status.runtime)
              setRollbackAvailable(status.rollbackAvailable)
              setSelfUpdateBlocker(
                extractAppCommandError(status.selfUpdateBlocker)
              )
            }
          }
        } catch (err) {
          // A newer client talking to an older server 404s here. That must fall
          // through to /health (present on every build) rather than abort the
          // whole refresh — same fail-open contract as getCurrentAppVersion().
          console.error("[Update] status route unavailable:", err)
        }
        if (!running) running = await getRunningServerVersion()
      }
    } catch (err) {
      // Never fatal: this only enriches what the UI can show.
      console.error("[Update] local status refresh failed:", err)
      return
    }
    if (!running || !mountedRef.current) return
    setCurrentVersion(running)
    discardStaleAvailability(running)
  }, [discardStaleAvailability])

  const startRefresh = useCallback((): Promise<void> => {
    const p = runRefresh().finally(() => {
      if (inFlightRefreshRef.current === p) inFlightRefreshRef.current = null
    })
    inFlightRefreshRef.current = p
    return p
  }, [runRefresh])

  /**
   * Re-read the running version and the backend's update capabilities.
   *
   * Overlapping calls coalesce, because this fires on every transport reconnect
   * and a flapping link would otherwise stack round-trips all asking the same
   * question. But they coalesce onto a *trailing* pass, not the one already in
   * flight: a reconnect can mean the backend process was REPLACED (server
   * self-update, supervisor relaunch, crash), so the running request is
   * addressed to a process that may no longer exist. Its answer — a stale
   * version, or an outright failure — says nothing about the new one. Folding
   * the reconnect into it would leave `currentVersion` and the rollback/self-
   * update capabilities pinned to the old process until the next reconnect, a
   * manual check, or the six-hour poll.
   */
  const refreshLocalStatus = useCallback((): Promise<void> => {
    if (!inFlightRefreshRef.current) return startRefresh()
    // One follow-up covers every caller that arrives during this window: they
    // all want the same thing, a look at whatever backend we end up connected
    // to once the current attempt is done.
    const queued = trailingRefreshRef.current
    if (queued) return queued
    const next = inFlightRefreshRef.current
      // The follow-up is owed whether or not the current attempt succeeded —
      // a failure against the old process is precisely when it's needed.
      .catch(() => {})
      .then(() => {
        trailingRefreshRef.current = null
        if (!mountedRef.current) return
        return startRefresh()
      })
    trailingRefreshRef.current = next
    return next
  }, [startRefresh])
  useEffect(() => {
    refreshLocalStatusRef.current = refreshLocalStatus
  }, [refreshLocalStatus])

  // Local status is cheap and offline-safe, so seed it right away rather than
  // waiting out the first manifest check.
  useEffect(() => {
    void refreshLocalStatus()
  }, [refreshLocalStatus])

  // A reconnect means the backend process may have restarted — including onto a
  // NEW version, when another window drove a server self-update. That window
  // reloads itself; this one doesn't, so re-read the running version here or it
  // would go on advertising the release it is already running. Registered
  // separately from the lifecycle subscription (both transports keep a Set of
  // reconnect callbacks) so the seq/epoch effect stays untouched.
  useEffect(() => {
    const off = getTransport().onReconnect?.(() => {
      void refreshLocalStatus()
    })
    return () => off?.()
  }, [refreshLocalStatus])

  // A failed attempt may have left a fresh `.bak` — re-read what can be rolled
  // back. A success relaunches the app/server, so only the failure path needs
  // covering here.
  useEffect(() => {
    if (state.status === "error") void refreshLocalStatus()
  }, [state.status, refreshLocalStatus])

  // What blocks an in-place update gets fixed outside codeg (a chown, a
  // remount), typically in another window. Look again when the user comes
  // back, rather than keeping the manual route up until a reconnect or reload.
  useEffect(() => {
    if (!selfUpdateBlocker) return
    const recheck = () => {
      if (!document.hidden) void refreshLocalStatus()
    }
    window.addEventListener("focus", recheck)
    document.addEventListener("visibilitychange", recheck)
    return () => {
      window.removeEventListener("focus", recheck)
      document.removeEventListener("visibilitychange", recheck)
    }
  }, [selfUpdateBlocker, refreshLocalStatus])

  // Floor between automatic attempts, so a failing check (which deliberately
  // does NOT record a completion time, so recovery isn't blocked for 6h) can't
  // be re-fired on every tab focus.
  const lastAttemptRef = useRef(0)

  const dismissAvailable = useCallback(() => {
    if (!available) return
    writeDismissedVersion(available.version)
    setDismissedVersion(available.version)
  }, [available])

  useEffect(() => {
    let cancelled = false

    const maybeCheck = () => {
      if (cancelled) return
      // Storage is the cross-window source of truth. Adopt a sibling window's
      // newer answer BEFORE deciding whether to fetch: it is what suppresses
      // our own request, so skipping without taking it would leave this window
      // badge-less for the rest of the interval even though an update is out.
      const last = readLastCheck()
      if (last) adoptCached(last)
      // Background tab: skip. `visibilitychange` re-runs this when it returns.
      if (typeof document !== "undefined" && document.hidden) return
      // Nothing to discover while an update is already downloading, staged or
      // restarting — the lifecycle UI owns the status bar then.
      const status = stateRef.current.status
      if (status !== "idle" && status !== "error") return
      if (last && Date.now() - last.at < CHECK_INTERVAL_MS) return
      if (Date.now() - lastAttemptRef.current < AUTO_RETRY_FLOOR_MS) return
      lastAttemptRef.current = Date.now()
      void checkNowRef.current({ silent: true })
    }

    const first = setTimeout(maybeCheck, FIRST_CHECK_DELAY_MS)
    const interval = setInterval(maybeCheck, CHECK_INTERVAL_MS)
    const onVisibility = () => maybeCheck()
    document.addEventListener("visibilitychange", onVisibility)

    return () => {
      cancelled = true
      clearTimeout(first)
      clearInterval(interval)
      document.removeEventListener("visibilitychange", onVisibility)
    }
    // `adoptCached` is stable, so this still arms exactly once.
  }, [adoptCached])

  // ─── Actions ────────────────────────────────────────────────────────────

  const startUpdate = useCallback(async () => {
    try {
      const snap = await startAppUpdate()
      applyState(snap)
    } catch (err) {
      // The detached backend task reports its own failures via the state
      // event; this only fires if the kickoff call itself failed (e.g. the
      // server is unreachable).
      const { rawMessage } = normalizeAppUpdateError(err)
      toast.error(t("installFailed", { message: rawMessage }))
      console.error("[Update] start failed:", err)
    }
  }, [applyState, t])

  const restart = useCallback(async () => {
    setIsRestarting(true)
    // Desktop relaunches the whole app — nothing to verify, the new process
    // boots into the updated build.
    if (usesTauriUpdater()) {
      try {
        await restartApp()
        // Success: the app is relaunching; stay busy until it does.
      } catch (err) {
        setIsRestarting(false)
        const { rawMessage } = normalizeAppUpdateError(err)
        toast.error(t("installFailed", { message: rawMessage }))
        console.error("[Update] restart failed:", err)
      }
      return
    }

    // Server / remote: relaunch, then confirm the new version actually came up
    // (and wasn't auto-rolled-back) before declaring success. Ported from the
    // original in-page upgrade flow so the supervisor trial semantics survive.
    setRestartCountdown(0)
    try {
      // The version running now. The server stays on it through swap + staged
      // until it exits, so reading it here (rather than caching it at download
      // start) is reload-safe: a baseline equal to the post-restart version
      // means the supervisor rolled a failed boot back.
      let baseline: string | null = null
      let reachable = false
      for (let i = 0; i < 3; i++) {
        try {
          baseline = await readServerVersionStrict()
          reachable = true
          break
        } catch {
          await sleep(1000)
        }
      }
      if (!reachable) {
        toast.error(t("serverUnreachable"))
        return
      }
      const isRollback = (v: string | null): boolean =>
        !!v && !!baseline && v === baseline

      const snap = stateRef.current
      const target = snap.version
      const delayMs = snap.restartDelayMs ?? 2000
      const trialSeconds =
        snap.capability === "supervised" ? (snap.trialSeconds ?? 0) : 0

      await restartApp()
      await countdown(delayMs, setRestartCountdown)

      const healthy = await waitForServerHealthy({
        timeoutMs: 90_000,
        intervalMs: 1500,
      })
      if (!healthy) {
        toast.error(t("restartTimeout"))
        return
      }

      // Healthy — but the supervisor may have auto-rolled-back a version that
      // couldn't boot. Confirm the running version advanced.
      const running = await getRunningServerVersion()
      if (isRollback(running)) {
        toast.error(t("upgradeRolledBack"))
        return
      }

      // Supervised trial: keep watching across the probation window; a version
      // that boots but can't stay up is reverted within it.
      if (trialSeconds > 0 && target) {
        const trialDeadline = Date.now() + trialSeconds * 1000 + 3000
        let reverted = false
        while (Date.now() < trialDeadline) {
          setRestartCountdown(Math.ceil((trialDeadline - Date.now()) / 1000))
          await sleep(2000)
          const v = await getRunningServerVersion()
          if (isRollback(v)) {
            reverted = true
            break
          }
        }
        if (reverted) {
          toast.error(t("upgradeRolledBack"))
          return
        }
        // The loop skips transient nulls (briefly down during relaunch), so
        // require one definitive post-window reading before claiming success.
        let finalVersion: string | null = null
        for (let i = 0; i < 5; i++) {
          finalVersion = await getRunningServerVersion()
          if (finalVersion) break
          await sleep(1500)
        }
        if (isRollback(finalVersion)) {
          toast.error(t("upgradeRolledBack"))
          return
        }
        if (!finalVersion) {
          toast.error(t("restartTimeout"))
          return
        }
      }

      toast.success(t("upgradeSuccess"))
      window.location.reload()
    } catch (err) {
      const { rawMessage } = normalizeAppUpdateError(err)
      toast.error(t("installFailed", { message: rawMessage }))
      console.error("[Update] restart flow failed:", err)
    } finally {
      setRestartCountdown(null)
      setIsRestarting(false)
    }
  }, [t])

  const rollback = useCallback(async () => {
    setIsRollingBack(true)
    setRestartCountdown(null)
    try {
      // The version we are rolling back *from*. A successful rollback brings the
      // server back onto a different (previous) version.
      let fromVersion: string | null = null
      let reachable = false
      for (let i = 0; i < 3; i++) {
        try {
          fromVersion = await readServerVersionStrict()
          reachable = true
          break
        } catch {
          await sleep(1000)
        }
      }
      if (!reachable) {
        toast.error(t("serverUnreachable"))
        return
      }

      // Revert + relaunch is a single locked server op: it responds before it
      // exits/re-execs, so there is no separate restart call.
      const result = await rollbackServer()
      const delayMs =
        result.restartDelayMs || (stateRef.current.restartDelayMs ?? 2000)

      await countdown(delayMs, setRestartCountdown)

      const healthy = await waitForServerHealthy({
        timeoutMs: 90_000,
        intervalMs: 1500,
      })
      if (!healthy) {
        toast.error(t("restartTimeout"))
        return
      }

      const outcome = await confirmRollbackVersion(fromVersion)
      if (outcome === "unchanged") {
        toast.error(t("rollbackFailed"))
        return
      }
      if (outcome === "unreachable") {
        toast.error(t("restartTimeout"))
        return
      }

      toast.success(t("rollbackSuccess"))
      window.location.reload()
    } catch (err) {
      toast.error(t("rollbackFailed"))
      console.error("[Update] rollback failed:", err)
    } finally {
      setIsRollingBack(false)
      setRestartCountdown(null)
    }
  }, [t])

  const isUpdating =
    state.status === "downloading" || state.status === "installing"
  const isBusy =
    isUpdating ||
    isRollingBack ||
    isRestarting ||
    restartCountdown !== null ||
    state.status === "restarting"

  // Desktop always drives the Tauri updater; a server only when it speaks the
  // detached live-progress protocol (older ones would block on the legacy
  // endpoint) and reports nothing in the way (an in-place update it already
  // knows would fail), so anything else falls back to a "view release" link.
  const canInstallInPlace =
    usesTauriUpdater() ||
    (selfUpdateSupported && liveProgress && !selfUpdateBlocker)

  const value = useMemo<UpdateContextValue>(
    () => ({
      state,
      isUpdating,
      restartCountdown,
      isRollingBack,
      isRestarting,
      hydrated,
      isBusy,
      available,
      currentVersion,
      checking,
      checkError,
      lastCheckedAt,
      selfUpdateSupported,
      liveProgress,
      runtime,
      rollbackAvailable,
      selfUpdateBlocker,
      canInstallInPlace,
      dismissedVersion,
      checkNow,
      dismissAvailable,
      refreshLocalStatus,
      startUpdate,
      restart,
      rollback,
    }),
    [
      state,
      isUpdating,
      restartCountdown,
      isRollingBack,
      isRestarting,
      hydrated,
      isBusy,
      available,
      currentVersion,
      checking,
      checkError,
      lastCheckedAt,
      selfUpdateSupported,
      liveProgress,
      runtime,
      rollbackAvailable,
      selfUpdateBlocker,
      canInstallInPlace,
      dismissedVersion,
      checkNow,
      dismissAvailable,
      refreshLocalStatus,
      startUpdate,
      restart,
      rollback,
    ]
  )

  return (
    <UpdateContext.Provider value={value}>{children}</UpdateContext.Provider>
  )
}

/** Access the app-update controller. Returns null outside a provider, so the
 * global indicator can render nothing rather than throw on surfaces (login,
 * aux windows) that don't mount it. */
export function useAppUpdate(): UpdateContextValue | null {
  return useContext(UpdateContext)
}
