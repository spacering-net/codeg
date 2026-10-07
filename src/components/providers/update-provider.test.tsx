import { useEffect } from "react"
import { render, screen, act, waitFor } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { AppUpdateState } from "@/lib/updater"

// The provider's snapshot/subscribe helpers go through getTransport(), so
// mocking the transport drives the whole provider without stubbing updater.ts.
let snapshot: AppUpdateState = { seq: 0, status: "idle" }
// Per-call overrides for the app_update_state fetch (e.g. a hanging promise so
// a test can interleave events/reconnects before it resolves). Falls back to
// `snapshot` when empty.
let callQueue: Array<AppUpdateState | Promise<AppUpdateState>> = []
// Both real transports keep a Set of reconnect callbacks (see
// web-transport.ts / remote-desktop-transport.ts), and the provider registers
// two — mirror that here so a second registration can't shadow the first.
const reconnectCbs = new Set<() => void>()
const fireReconnect = () => {
  for (const cb of [...reconnectCbs]) cb()
}
let liveHandler: ((s: AppUpdateState) => void) | null = null

// What `check_app_update` answers. A function so a test can hang it, throw, or
// vary the reply per call.
let checkResult: () => unknown = () => ({
  currentVersion: "0.21.7",
  update: null,
  selfUpdateSupported: true,
  liveProgress: true,
  runtime: "standalone",
  rollbackAvailable: false,
})

// Full override, for tests that need to shape several endpoints at once (e.g.
// an older server whose app_update_status 404s).
let callImpl: ((endpoint: string) => Promise<unknown>) | null = null

const call = vi.fn(async (endpoint: string) => {
  if (callImpl) return callImpl(endpoint)
  if (endpoint === "app_update_state") {
    return callQueue.length ? callQueue.shift()! : snapshot
  }
  if (endpoint === "check_app_update") return checkResult()
  if (endpoint === "app_update_status") {
    return {
      currentVersion: "0.21.7",
      selfUpdateSupported: true,
      capability: "supervised",
      runtime: "standalone",
      restartDelayMs: 2000,
      rollbackAvailable: false,
      liveProgress: true,
    }
  }
  throw new Error(`unexpected endpoint: ${endpoint}`)
})
const subscribe = vi.fn(
  async (_event: string, handler: (s: AppUpdateState) => void) => {
    liveHandler = handler
    return () => {}
  }
)
const onReconnect = vi.fn((cb: () => void) => {
  reconnectCbs.add(cb)
  return () => {
    reconnectCbs.delete(cb)
  }
})

vi.mock("@/lib/transport", () => ({
  getTransport: () => ({ call, subscribe, onReconnect }),
  isDesktop: () => false,
  isRemoteDesktopMode: () => false,
  getActiveRemoteConnectionId: () => null,
}))

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

import { UpdateProvider, useAppUpdate } from "./update-provider"
import enMessages from "@/i18n/messages/en.json"

function Probe() {
  const u = useAppUpdate()
  return (
    <div data-testid="status">
      {u?.state.status} #{u?.state.seq}
    </div>
  )
}

const makeTree = () => (
  <NextIntlClientProvider locale="en" messages={enMessages}>
    <UpdateProvider>
      <Probe />
    </UpdateProvider>
  </NextIntlClientProvider>
)

const text = () => screen.getByTestId("status").textContent

beforeEach(() => {
  call.mockClear()
  subscribe.mockClear()
  onReconnect.mockClear()
  reconnectCbs.clear()
  liveHandler = null
  callQueue = []
  callImpl = null
  snapshot = { seq: 0, status: "idle" }
  checkResult = () => ({
    currentVersion: "0.21.7",
    update: null,
    selfUpdateSupported: true,
    liveProgress: true,
    runtime: "standalone",
    rollbackAvailable: false,
  })
  availableIdentities = 0
  offers = []
  // The availability cache lives in localStorage, which jsdom keeps across
  // tests in a file — clear it so each case starts cold.
  localStorage.clear()
})

describe("UpdateProvider", () => {
  it("seeds current state from the snapshot on mount", async () => {
    snapshot = { seq: 50, status: "downloading", downloaded: 10, total: 100 }
    render(makeTree())
    await waitFor(() => expect(text()).toBe("downloading #50"))
  })

  it("accepts a lower-seq snapshot after a reconnect (backend restarted)", async () => {
    snapshot = { seq: 50, status: "downloading", downloaded: 10, total: 100 }
    render(makeTree())
    await waitFor(() => expect(text()).toBe("downloading #50"))

    // The server self-updated and relaunched: the NEW process restarts its seq
    // counter at 0 and is idle. Without resetting the high-water on reconnect,
    // the seq guard would discard this and leave the UI stuck on "downloading".
    snapshot = { seq: 0, status: "idle" }
    await act(async () => {
      fireReconnect()
      await Promise.resolve()
    })
    await waitFor(() => expect(text()).toBe("idle #0"))
  })

  it("keeps a higher-seq live event that arrives during the reconnect fetch", async () => {
    snapshot = { seq: 50, status: "downloading", downloaded: 10, total: 100 }
    render(makeTree())
    await waitFor(() => expect(text()).toBe("downloading #50"))

    // Reconnect with a snapshot fetch that hangs, so we can interleave a live
    // event from the new process before it resolves.
    let resolveSnap!: (s: AppUpdateState) => void
    callQueue = [
      new Promise<AppUpdateState>((r) => {
        resolveSnap = r
      }),
    ]
    await act(async () => {
      fireReconnect()
      await Promise.resolve()
    })

    // New process delivers a fresh, higher-seq event while the snapshot is in
    // flight — it must be applied (the high-water was reset before the fetch).
    await act(async () => {
      liveHandler?.({ seq: 3, status: "installing" })
      await Promise.resolve()
    })
    await waitFor(() => expect(text()).toBe("installing #3"))

    // The in-flight snapshot now resolves with an OLDER seq — it must NOT
    // clobber the newer live event.
    await act(async () => {
      resolveSnap({ seq: 1, status: "downloading", downloaded: 5, total: 100 })
      await Promise.resolve()
    })
    expect(text()).toBe("installing #3")
  })

  it("discards a pre-reconnect snapshot that resolves after the reset", async () => {
    // The mount snapshot fetch hangs; a reconnect happens before it resolves.
    let resolveMount!: (s: AppUpdateState) => void
    callQueue = [
      new Promise<AppUpdateState>((r) => {
        resolveMount = r
      }),
    ]
    render(makeTree())
    // Let the mount resync start and claim the hanging fetch (epoch 1) before
    // the reconnect, so the hang belongs to the pre-reconnect fetch.
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    // Reconnect to the new (idle) process while the mount fetch is still in
    // flight.
    snapshot = { seq: 0, status: "idle" }
    await act(async () => {
      fireReconnect()
      await Promise.resolve()
    })
    await waitFor(() => expect(text()).toBe("idle #0"))

    // The original mount fetch finally resolves with the OLD process's high
    // seq — the epoch guard must discard it rather than resurrect the old
    // "downloading" state.
    await act(async () => {
      resolveMount({ seq: 50, status: "downloading", downloaded: 1, total: 2 })
      await Promise.resolve()
    })
    expect(text()).toBe("idle #0")
  })

  it("ignores a malformed payload (legacy server) without poisoning the guard", async () => {
    snapshot = { seq: 50, status: "downloading", downloaded: 10, total: 100 }
    render(makeTree())
    await waitFor(() => expect(text()).toBe("downloading #50"))

    // An older remote server's perform answers with the legacy
    // `{ version, needRestart }` shape (no seq/status) — it must be ignored.
    await act(async () => {
      liveHandler?.({
        version: "9.9.9",
        needRestart: true,
      } as unknown as AppUpdateState)
      await Promise.resolve()
    })
    expect(text()).toBe("downloading #50")

    // A subsequent valid event still applies — the guard wasn't poisoned by an
    // undefined seq.
    await act(async () => {
      liveHandler?.({ seq: 51, status: "installing" })
      await Promise.resolve()
    })
    await waitFor(() => expect(text()).toBe("installing #51"))
  })
})

// ─── Availability ──────────────────────────────────────────────────────────

const LAST_CHECK_KEY = "codeg.updateCheck.last"
const DISMISSED_KEY = "codeg.updateCheck.dismissedVersion"

let ctx: ReturnType<typeof useAppUpdate> = null
let availableIdentities = 0
// Every release offer consumers were handed, with whether it came with the
// in-place install enabled — so a test can assert on transient states too.
let offers: Array<{ version: string; inPlace: boolean }> = []

function AvailabilityProbe() {
  const u = useAppUpdate()
  // Captured in an effect, not during render: assigning to an outer binding
  // mid-render is a side effect React makes no ordering promises about.
  useEffect(() => {
    ctx = u
  }, [u])
  // Bumped for every distinct `available` object handed to consumers — each one
  // is a re-render for everything downstream, so a test can assert that
  // re-reading an unchanged cache entry stays free. A module binding rather
  // than state: setState in an effect is a lint error here, and would itself
  // add renders to the thing being measured.
  useEffect(() => {
    availableIdentities += 1
  }, [u?.available])
  useEffect(() => {
    if (u?.available) {
      offers.push({
        version: u.available.version,
        inPlace: u.canInstallInPlace,
      })
    }
  }, [u?.available, u?.canInstallInPlace])
  return (
    <div>
      <div data-testid="available">{u?.available?.version ?? "none"}</div>
      <div data-testid="lifecycle">{u?.state.status}</div>
      <div data-testid="checking">{String(u?.checking)}</div>
      <div data-testid="dismissed">{u?.dismissedVersion ?? "none"}</div>
      <div data-testid="current">{u?.currentVersion || "none"}</div>
      <div data-testid="in-place">{String(u?.canInstallInPlace)}</div>
    </div>
  )
}

const availabilityTree = () => (
  <NextIntlClientProvider locale="en" messages={enMessages}>
    <UpdateProvider>
      <AvailabilityProbe />
    </UpdateProvider>
  </NextIntlClientProvider>
)

const checkCalls = () =>
  call.mock.calls.filter(([e]) => e === "check_app_update").length

describe("UpdateProvider — availability", () => {
  it("restores the last result from storage so a reload isn't briefly blind", async () => {
    // Only the timestamp used to be cached, which made a throttled reload claim
    // "you're up to date" for an update the previous check had already found.
    localStorage.setItem(
      LAST_CHECK_KEY,
      JSON.stringify({
        at: Date.now(),
        currentVersion: "0.21.7",
        info: { version: "0.21.9", body: "notes", date: null },
      })
    )

    render(availabilityTree())

    await waitFor(() =>
      expect(screen.getByTestId("available").textContent).toBe("0.21.9")
    )
    // Restored from cache, not re-fetched.
    expect(checkCalls()).toBe(0)
  })

  it("ignores a cache entry with a nonsense timestamp", async () => {
    localStorage.setItem(
      LAST_CHECK_KEY,
      JSON.stringify({ at: "soon", info: { version: "9.9.9", body: "" } })
    )

    render(availabilityTree())
    await waitFor(() => expect(ctx).not.toBeNull())
    expect(screen.getByTestId("available").textContent).toBe("none")
  })

  it("persists a check result so the next mount can restore it", async () => {
    checkResult = () => ({
      currentVersion: "0.21.7",
      update: { version: "0.21.9", body: "notes", date: "2026-07-24" },
      selfUpdateSupported: true,
      liveProgress: true,
      runtime: "standalone",
      rollbackAvailable: false,
    })
    render(availabilityTree())
    await waitFor(() => expect(ctx).not.toBeNull())

    await act(async () => {
      await ctx!.checkNow()
    })

    expect(screen.getByTestId("available").textContent).toBe("0.21.9")
    expect(screen.getByTestId("current").textContent).toBe("0.21.7")
    expect(screen.getByTestId("in-place").textContent).toBe("true")
    const cached = JSON.parse(localStorage.getItem(LAST_CHECK_KEY)!)
    expect(cached.info.version).toBe("0.21.9")
    expect(typeof cached.at).toBe("number")
  })

  it("offers no in-place install until the status probe finds the way clear", async () => {
    // The local status probe finds the install unwritable: an upgrade would
    // fail at its first step, so the UI must fall back to the release page.
    let blocked = true
    callImpl = async (endpoint: string) => {
      if (endpoint === "app_update_state") return snapshot
      if (endpoint === "app_update_status") {
        return {
          currentVersion: "0.21.7",
          selfUpdateSupported: true,
          capability: "supervised",
          runtime: "standalone",
          restartDelayMs: 2000,
          rollbackAvailable: false,
          liveProgress: true,
          ...(blocked && {
            selfUpdateBlocker: {
              code: "permission_denied",
              message: "Update target is not writable: /usr/local/bin",
              i18n_key: "SystemSettings.updateErrors.permissionDenied",
              i18n_params: { path: "/usr/local/bin" },
            },
          }),
        }
      }
      if (endpoint === "check_app_update") return checkResult()
      throw new Error(`unexpected endpoint: ${endpoint}`)
    }
    render(availabilityTree())

    await waitFor(() => expect(ctx?.selfUpdateBlocker).toBeTruthy())
    expect(ctx!.selfUpdateBlocker!.i18n_params).toEqual({
      path: "/usr/local/bin",
    })
    expect(screen.getByTestId("in-place").textContent).toBe("false")

    // The check carries no blocker: it is not a source, so it must not clear
    // what the status probe found.
    await act(async () => {
      await ctx!.checkNow()
    })
    expect(ctx!.selfUpdateBlocker).toBeTruthy()
    expect(screen.getByTestId("in-place").textContent).toBe("false")

    // Fixed from another window; coming back to this one looks again.
    blocked = false
    await act(async () => {
      window.dispatchEvent(new Event("focus"))
    })
    await waitFor(() => expect(ctx!.selfUpdateBlocker).toBeNull())
    expect(screen.getByTestId("in-place").textContent).toBe("true")
  })

  it("offers a release only once the blocker verdict is as fresh as the check", async () => {
    // Nothing blocks at mount; the install turns unwritable later, and the next
    // check surfaces an update. Offering it before the status is read again
    // would offer an upgrade certain to fail.
    let blocked = false
    // Holds the status reply back, to catch the offer arriving ahead of it.
    let statusGate: Promise<void> | null = null
    callImpl = async (endpoint: string) => {
      if (endpoint === "app_update_state") return snapshot
      if (endpoint === "app_update_status") {
        if (statusGate) await statusGate
        return {
          currentVersion: "0.21.7",
          selfUpdateSupported: true,
          capability: "supervised",
          runtime: "standalone",
          restartDelayMs: 2000,
          rollbackAvailable: false,
          liveProgress: true,
          ...(blocked && {
            selfUpdateBlocker: {
              code: "permission_denied",
              message: "Update target is not writable: /usr/local/bin",
              i18n_key: "SystemSettings.updateErrors.permissionDenied",
              i18n_params: { path: "/usr/local/bin" },
            },
          }),
        }
      }
      if (endpoint === "check_app_update") return checkResult()
      throw new Error(`unexpected endpoint: ${endpoint}`)
    }
    const statusCalls = () =>
      call.mock.calls.filter(([e]) => e === "app_update_status").length
    render(availabilityTree())
    await waitFor(() =>
      expect(screen.getByTestId("current").textContent).toBe("0.21.7")
    )
    expect(screen.getByTestId("in-place").textContent).toBe("true")

    blocked = true
    let releaseStatus!: () => void
    statusGate = new Promise<void>((resolve) => {
      releaseStatus = resolve
    })
    checkResult = () => ({
      currentVersion: "0.21.7",
      update: { version: "0.21.9", body: "", date: null },
      selfUpdateSupported: true,
      liveProgress: true,
      runtime: "standalone",
      rollbackAvailable: false,
    })
    const before = statusCalls()
    let checking!: Promise<void>
    act(() => {
      checking = ctx!.checkNow()
    })
    // The check has its answer and is re-reading the status…
    await waitFor(() => expect(statusCalls()).toBe(before + 1))
    // …and offers nothing until that verdict is in.
    expect(screen.getByTestId("available").textContent).toBe("none")

    await act(async () => {
      releaseStatus()
      await checking
    })
    expect(screen.getByTestId("available").textContent).toBe("0.21.9")
    expect(screen.getByTestId("in-place").textContent).toBe("false")
    expect(offers).toEqual([{ version: "0.21.9", inPlace: false }])
  })

  it("never publishes an answer from a process that restarted while the verdict was read", async () => {
    // Another window upgrades the server to the offered release while this
    // check is reading the blocker verdict. The answer must come from the
    // process now running, not re-offer what it already runs.
    let restarted = false
    let statusGate: Promise<void> | null = null
    callImpl = async (endpoint: string) => {
      if (endpoint === "app_update_state") return snapshot
      if (endpoint === "app_update_status") {
        if (statusGate) await statusGate
        return {
          currentVersion: restarted ? "0.21.9" : "0.21.7",
          selfUpdateSupported: true,
          capability: "supervised",
          runtime: "standalone",
          restartDelayMs: 2000,
          rollbackAvailable: false,
          liveProgress: true,
        }
      }
      if (endpoint === "check_app_update") {
        return {
          currentVersion: restarted ? "0.21.9" : "0.21.7",
          update: restarted
            ? null
            : { version: "0.21.9", body: "", date: null },
          selfUpdateSupported: true,
          liveProgress: true,
          runtime: "standalone",
          rollbackAvailable: false,
        }
      }
      throw new Error(`unexpected endpoint: ${endpoint}`)
    }
    const statusCalls = () =>
      call.mock.calls.filter(([e]) => e === "app_update_status").length
    render(availabilityTree())
    await waitFor(() =>
      expect(screen.getByTestId("current").textContent).toBe("0.21.7")
    )

    let releaseStatus!: () => void
    statusGate = new Promise<void>((resolve) => {
      releaseStatus = resolve
    })
    const before = statusCalls()
    let checking!: Promise<void>
    act(() => {
      checking = ctx!.checkNow()
    })
    await waitFor(() => expect(statusCalls()).toBe(before + 1))
    restarted = true
    await act(async () => {
      releaseStatus()
      await checking
    })

    expect(screen.getByTestId("available").textContent).toBe("none")
    expect(screen.getByTestId("current").textContent).toBe("0.21.9")
  })

  it("de-duplicates concurrent checks into a single manifest fetch", async () => {
    // The settings page's button and the scheduler can fire together; two
    // manifest requests for one answer would be pure waste.
    let release!: (v: unknown) => void
    checkResult = () =>
      new Promise((r) => {
        release = r
      })
    render(availabilityTree())
    await waitFor(() => expect(ctx).not.toBeNull())

    let both!: Promise<unknown>
    await act(async () => {
      both = Promise.all([ctx!.checkNow(), ctx!.checkNow({ silent: false })])
      await Promise.resolve()
    })
    expect(checkCalls()).toBe(1)
    expect(screen.getByTestId("checking").textContent).toBe("true")

    await act(async () => {
      release({ currentVersion: "0.21.7", update: null })
      await both
    })
    expect(screen.getByTestId("checking").textContent).toBe("false")

    // Settled: a later check starts a new request rather than reusing the old.
    await act(async () => {
      release = () => {}
      checkResult = () => ({ currentVersion: "0.21.7", update: null })
      await ctx!.checkNow()
    })
    expect(checkCalls()).toBe(2)
  })

  it("records a failed check without persisting it as a completed one", async () => {
    checkResult = () => {
      throw new Error("error sending request for url")
    }
    render(availabilityTree())
    await waitFor(() => expect(ctx).not.toBeNull())

    await act(async () => {
      await ctx!.checkNow()
    })

    expect(ctx!.checkError).toContain("error sending request")
    // A failure must not look like "checked, nothing new" — otherwise the 6h
    // throttle would suppress recovery attempts.
    expect(localStorage.getItem(LAST_CHECK_KEY)).toBeNull()
  })

  it("silences the dismissed release only, and re-surfaces the next one", async () => {
    checkResult = () => ({
      currentVersion: "0.21.7",
      update: { version: "0.21.9", body: "", date: null },
    })
    render(availabilityTree())
    await waitFor(() => expect(ctx).not.toBeNull())
    await act(async () => {
      await ctx!.checkNow()
    })

    await act(async () => {
      ctx!.dismissAvailable()
    })
    expect(screen.getByTestId("dismissed").textContent).toBe("0.21.9")
    expect(localStorage.getItem(DISMISSED_KEY)).toBe("0.21.9")

    // A newer release lands: the stale dismissal must be dropped so the badge
    // comes back.
    checkResult = () => ({
      currentVersion: "0.21.7",
      update: { version: "0.22.0", body: "", date: null },
    })
    await act(async () => {
      await ctx!.checkNow()
    })
    expect(screen.getByTestId("dismissed").textContent).toBe("none")
    expect(localStorage.getItem(DISMISSED_KEY)).toBeNull()
  })

  it("keeps the dismissal while that release is still the newest", async () => {
    checkResult = () => ({
      currentVersion: "0.21.7",
      update: { version: "0.21.9", body: "", date: null },
    })
    render(availabilityTree())
    await waitFor(() => expect(ctx).not.toBeNull())
    await act(async () => {
      await ctx!.checkNow()
    })
    await act(async () => {
      ctx!.dismissAvailable()
    })

    await act(async () => {
      await ctx!.checkNow()
    })
    expect(screen.getByTestId("dismissed").textContent).toBe("0.21.9")
  })
})

describe("UpdateProvider — check scheduling", () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it("runs the first check only after the startup delay", async () => {
    render(availabilityTree())
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })
    // Still inside the delay: workspace boot isn't competing with a manifest
    // fetch.
    expect(checkCalls()).toBe(0)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(9000)
    })
    expect(checkCalls()).toBe(1)
  })

  it("skips the scheduled check while an update is already downloading", async () => {
    snapshot = { seq: 3, status: "downloading", downloaded: 10, total: 100 }
    render(availabilityTree())
    // Let the mount snapshot land (and its effects flush) before the startup
    // timer fires, so the guard sees the real lifecycle rather than the
    // placeholder `idle`.
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(screen.getByTestId("lifecycle").textContent).toBe("downloading")

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000)
    })
    // Nothing to discover: the status bar is already showing this update's
    // progress.
    expect(checkCalls()).toBe(0)
  })

  it("honours a recent check recorded by another window", async () => {
    localStorage.setItem(
      LAST_CHECK_KEY,
      JSON.stringify({ at: Date.now(), currentVersion: "0.21.7", info: null })
    )
    render(availabilityTree())
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000)
    })
    expect(checkCalls()).toBe(0)
  })

  it("re-checks once the cached answer has gone stale", async () => {
    localStorage.setItem(
      LAST_CHECK_KEY,
      JSON.stringify({
        at: Date.now() - 7 * 60 * 60 * 1000,
        currentVersion: "0.21.7",
        info: null,
      })
    )
    render(availabilityTree())
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000)
    })
    expect(checkCalls()).toBe(1)
  })
})

describe("UpdateProvider — stale cache after an upgrade", () => {
  it("drops a cached release once the app is running a different version", async () => {
    // The relaunch right after an update lands: the cache still advertises the
    // release, but it is now the version we are running. Left alone, the 6h
    // freshness guard would keep re-offering the just-installed update all day.
    localStorage.setItem(
      LAST_CHECK_KEY,
      JSON.stringify({
        at: Date.now(),
        currentVersion: "0.21.7",
        info: { version: "0.21.9", body: "", date: null },
      })
    )
    callImpl = async (endpoint: string) => {
      if (endpoint === "app_update_state") return snapshot
      if (endpoint === "app_update_status") {
        return {
          currentVersion: "0.21.9", // the upgrade landed
          selfUpdateSupported: true,
          capability: "supervised",
          runtime: "standalone",
          restartDelayMs: 2000,
          rollbackAvailable: true,
          liveProgress: true,
        }
      }
      if (endpoint === "check_app_update") {
        return { currentVersion: "0.21.9", update: null }
      }
      throw new Error(`unexpected endpoint: ${endpoint}`)
    }

    render(availabilityTree())

    await waitFor(() =>
      expect(screen.getByTestId("current").textContent).toBe("0.21.9")
    )
    await waitFor(() =>
      expect(screen.getByTestId("available").textContent).toBe("none")
    )
    // Re-asked immediately rather than waiting out the interval, so the UI
    // isn't left blank for 6h.
    await waitFor(() => expect(checkCalls()).toBe(1))
  })

  it("keeps a cached release that still applies to the running version", async () => {
    localStorage.setItem(
      LAST_CHECK_KEY,
      JSON.stringify({
        at: Date.now(),
        currentVersion: "0.21.7",
        info: { version: "0.21.9", body: "", date: null },
      })
    )
    render(availabilityTree())

    await waitFor(() =>
      expect(screen.getByTestId("current").textContent).toBe("0.21.7")
    )
    expect(screen.getByTestId("available").textContent).toBe("0.21.9")
    expect(checkCalls()).toBe(0)
    expect(localStorage.getItem(LAST_CHECK_KEY)).not.toBeNull()
  })

  it("falls back to /health when the status route 404s (older server)", async () => {
    // A newer client against an older server: the rejected status call must not
    // abort the whole refresh, or the version goes blank during an outage.
    callImpl = async (endpoint: string) => {
      if (endpoint === "app_update_state") return snapshot
      if (endpoint === "app_update_status") throw new Error("not implemented")
      if (endpoint === "health") return { version: "0.14.11" }
      if (endpoint === "check_app_update") throw new Error("manifest down")
      throw new Error(`unexpected endpoint: ${endpoint}`)
    }

    render(availabilityTree())

    await waitFor(() =>
      expect(screen.getByTestId("current").textContent).toBe("0.14.11")
    )
    expect(call).toHaveBeenCalledWith("health", {}, { timeoutMs: 4000 })
  })
})

describe("UpdateProvider — cross-window cache", () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it("adopts a result a sibling window recorded while we were idle", async () => {
    // Sibling writes a result AFTER we mounted. Our scheduler sees a fresh
    // timestamp and skips its own fetch — so it must take the sibling's answer,
    // otherwise this window shows no badge for the whole interval.
    render(availabilityTree())
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(screen.getByTestId("available").textContent).toBe("none")

    localStorage.setItem(
      LAST_CHECK_KEY,
      JSON.stringify({
        at: Date.now(),
        currentVersion: "0.21.7",
        info: { version: "0.22.0", body: "sibling", date: null },
      })
    )
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"))
      await Promise.resolve()
    })

    expect(screen.getByTestId("available").textContent).toBe("0.22.0")
    // Adopted, not re-fetched.
    expect(checkCalls()).toBe(0)
  })

  it("does not let an older cached result clobber a fresher one in memory", async () => {
    checkResult = () => ({
      currentVersion: "0.21.7",
      update: { version: "0.22.0", body: "", date: null },
    })
    render(availabilityTree())
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    await act(async () => {
      await ctx!.checkNow()
    })
    expect(screen.getByTestId("available").textContent).toBe("0.22.0")

    // A stale entry (e.g. a sibling window that has been offline) must lose to
    // the answer we already applied.
    localStorage.setItem(
      LAST_CHECK_KEY,
      JSON.stringify({
        at: Date.now() - 60_000,
        currentVersion: "0.21.7",
        info: null,
      })
    )
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"))
      await Promise.resolve()
    })
    expect(screen.getByTestId("available").textContent).toBe("0.22.0")
  })
})

describe("UpdateProvider — sibling window survives a backend restart", () => {
  it("stops advertising a release the backend is now running, without reloading", async () => {
    // Two windows on one server. The OTHER window drove the upgrade: it reloads
    // itself and clears the shared cache. THIS window never reloads — its
    // WebSocket just drops and reconnects — so the stale release lives only in
    // its memory, and the manifest is down so no check can correct it.
    let backendVersion = "0.21.7"
    callImpl = async (endpoint: string) => {
      if (endpoint === "app_update_state") return snapshot
      if (endpoint === "app_update_status") {
        return {
          currentVersion: backendVersion,
          selfUpdateSupported: true,
          capability: "supervised",
          runtime: "standalone",
          restartDelayMs: 2000,
          rollbackAvailable: true,
          liveProgress: true,
        }
      }
      if (endpoint === "check_app_update") {
        if (backendVersion === "0.21.7") {
          return {
            currentVersion: "0.21.7",
            update: { version: "0.21.9", body: "", date: null },
          }
        }
        throw new Error("manifest unreachable")
      }
      throw new Error(`unexpected endpoint: ${endpoint}`)
    }

    render(availabilityTree())
    await waitFor(() => expect(ctx).not.toBeNull())
    await act(async () => {
      await ctx!.checkNow()
    })
    expect(screen.getByTestId("available").textContent).toBe("0.21.9")

    // The other window installs it: the server restarts on 0.21.9 and clears
    // the shared cache entry.
    backendVersion = "0.21.9"
    localStorage.removeItem(LAST_CHECK_KEY)

    await act(async () => {
      fireReconnect()
      await Promise.resolve()
    })

    await waitFor(() =>
      expect(screen.getByTestId("current").textContent).toBe("0.21.9")
    )
    // Must clear from the in-memory baseline alone — there is no cache entry
    // left to compare against, and the recovery check fails.
    await waitFor(() =>
      expect(screen.getByTestId("available").textContent).toBe("none")
    )
  })

  it("keeps the release when a reconnect finds the same version (plain drop)", async () => {
    // An ordinary connection blip must not wipe a valid release.
    checkResult = () => ({
      currentVersion: "0.21.7",
      update: { version: "0.21.9", body: "", date: null },
    })
    render(availabilityTree())
    await waitFor(() => expect(ctx).not.toBeNull())
    await act(async () => {
      await ctx!.checkNow()
    })
    expect(screen.getByTestId("available").textContent).toBe("0.21.9")

    await act(async () => {
      fireReconnect()
      await Promise.resolve()
    })
    await act(async () => {
      await Promise.resolve()
    })
    expect(screen.getByTestId("available").textContent).toBe("0.21.9")
  })
})

describe("UpdateProvider — reconnect during an in-flight status refresh", () => {
  it("re-queries after the old process answers instead of folding into its request", async () => {
    // The mount refresh is still in flight when the server self-updates and the
    // socket reconnects. Coalescing the reconnect into that request would pin
    // the version and capabilities to a process that no longer exists — and
    // nothing would ask again until the next reconnect, a manual check, or the
    // six-hour poll.
    let backendVersion = "0.21.7"
    const answer: Array<() => void> = []
    callImpl = async (endpoint: string) => {
      if (endpoint === "app_update_state") return snapshot
      if (endpoint === "app_update_status") {
        // Captured per call, so the first round-trip still reports the version
        // that was current when it was issued.
        const version = backendVersion
        // The test decides when each answers, so the reconnect lands strictly
        // inside the first one.
        return new Promise((resolve) => {
          answer.push(() =>
            resolve({
              currentVersion: version,
              selfUpdateSupported: true,
              capability: "supervised",
              runtime: "standalone",
              restartDelayMs: 2000,
              rollbackAvailable: false,
              liveProgress: true,
            })
          )
        })
      }
      if (endpoint === "check_app_update") {
        throw new Error("manifest unreachable")
      }
      throw new Error(`unexpected endpoint: ${endpoint}`)
    }

    render(availabilityTree())
    await waitFor(() => expect(answer.length).toBe(1))

    // The backend restarts onto a new version while we're still waiting.
    backendVersion = "0.21.9"
    await act(async () => {
      fireReconnect()
      await Promise.resolve()
    })
    // Nothing new can be asked yet — the follow-up is owed, not issued.
    expect(answer.length).toBe(1)

    // The old process finally replies, with its own now-obsolete version.
    await act(async () => {
      answer[0]()
      await Promise.resolve()
    })

    await waitFor(() => expect(answer.length).toBe(2))
    await act(async () => {
      answer[1]()
      await Promise.resolve()
    })
    await waitFor(() =>
      expect(screen.getByTestId("current").textContent).toBe("0.21.9")
    )
  })

  it("owes only one follow-up however many reconnects land mid-flight", async () => {
    // A flapping link is the reason this coalesces at all — the follow-up must
    // not become one round-trip per blip.
    const answer: Array<() => void> = []
    callImpl = async (endpoint: string) => {
      if (endpoint === "app_update_state") return snapshot
      if (endpoint === "app_update_status") {
        return new Promise((resolve) => {
          answer.push(() =>
            resolve({
              currentVersion: "0.21.7",
              selfUpdateSupported: true,
              capability: "supervised",
              runtime: "standalone",
              restartDelayMs: 2000,
              rollbackAvailable: false,
              liveProgress: true,
            })
          )
        })
      }
      if (endpoint === "check_app_update") {
        throw new Error("manifest unreachable")
      }
      throw new Error(`unexpected endpoint: ${endpoint}`)
    }

    render(availabilityTree())
    await waitFor(() => expect(answer.length).toBe(1))

    await act(async () => {
      fireReconnect()
      fireReconnect()
      fireReconnect()
      await Promise.resolve()
    })
    await act(async () => {
      answer[0]()
      await Promise.resolve()
    })

    await waitFor(() => expect(answer.length).toBe(2))
    await act(async () => {
      answer[1]()
      await Promise.resolve()
    })
    // Three blips, one follow-up.
    await act(async () => {
      await Promise.resolve()
    })
    expect(answer.length).toBe(2)
  })
})

describe("UpdateProvider — cross-window dismissal", () => {
  const cachedOffer = (at: number, version = "0.21.9") =>
    JSON.stringify({
      at,
      currentVersion: "0.21.7",
      info: { version, body: "notes", date: null },
    })

  it("adopts a sibling's dismissal even though the check cache is unchanged", async () => {
    // Both windows already hold the same answer, so "Later" next door writes
    // ONLY the dismissal key. Gating that read on a fresher cache timestamp
    // would leave this window showing the full accented badge for a release the
    // user already waved away.
    localStorage.setItem(LAST_CHECK_KEY, cachedOffer(Date.now()))
    render(availabilityTree())
    await waitFor(() =>
      expect(screen.getByTestId("available").textContent).toBe("0.21.9")
    )
    expect(screen.getByTestId("dismissed").textContent).toBe("none")

    localStorage.setItem(DISMISSED_KEY, "0.21.9")
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"))
      await Promise.resolve()
    })

    expect(screen.getByTestId("dismissed").textContent).toBe("0.21.9")
  })

  it("picks the dismissal up immediately from the storage event", async () => {
    localStorage.setItem(LAST_CHECK_KEY, cachedOffer(Date.now()))
    render(availabilityTree())
    await waitFor(() =>
      expect(screen.getByTestId("available").textContent).toBe("0.21.9")
    )

    localStorage.setItem(DISMISSED_KEY, "0.21.9")
    await act(async () => {
      window.dispatchEvent(
        new StorageEvent("storage", {
          key: DISMISSED_KEY,
          newValue: "0.21.9",
        })
      )
      await Promise.resolve()
    })

    expect(screen.getByTestId("dismissed").textContent).toBe("0.21.9")
  })

  it("ignores storage writes that are not the dismissal", async () => {
    localStorage.setItem(DISMISSED_KEY, "0.21.9")
    localStorage.setItem(LAST_CHECK_KEY, cachedOffer(Date.now()))
    render(availabilityTree())
    await waitFor(() =>
      expect(screen.getByTestId("dismissed").textContent).toBe("0.21.9")
    )

    // An unrelated key — including another backend's scoped dismissal, which
    // shares this origin — must not disturb what we hold.
    localStorage.removeItem(DISMISSED_KEY)
    await act(async () => {
      window.dispatchEvent(
        new StorageEvent("storage", {
          key: `${DISMISSED_KEY}:remote-other`,
          newValue: "9.9.9",
        })
      )
      await Promise.resolve()
    })

    expect(screen.getByTestId("dismissed").textContent).toBe("0.21.9")
  })

  it("follows a sibling onto the new release from storage events alone", async () => {
    // The two keys move together but NOT atomically: a window that finds a
    // newer release writes the cache first, then drops the now-stale
    // dismissal. Reacting only to the dismissal would un-mute this window
    // while it still held the OLD offer — a loud badge advertising the
    // previous version number and release notes. No visibilitychange here on
    // purpose: that is the escape hatch that hides this path.
    localStorage.setItem(DISMISSED_KEY, "0.21.9")
    localStorage.setItem(LAST_CHECK_KEY, cachedOffer(Date.now()))
    render(availabilityTree())
    await waitFor(() =>
      expect(screen.getByTestId("dismissed").textContent).toBe("0.21.9")
    )
    expect(screen.getByTestId("available").textContent).toBe("0.21.9")

    // Sibling finds 0.22.0 — in the order the provider actually writes them.
    const fresh = cachedOffer(Date.now() + 1, "0.22.0")
    localStorage.setItem(LAST_CHECK_KEY, fresh)
    await act(async () => {
      window.dispatchEvent(
        new StorageEvent("storage", { key: LAST_CHECK_KEY, newValue: fresh })
      )
      await Promise.resolve()
    })
    localStorage.removeItem(DISMISSED_KEY)
    await act(async () => {
      window.dispatchEvent(
        new StorageEvent("storage", { key: DISMISSED_KEY, newValue: null })
      )
      await Promise.resolve()
    })

    // The badge is loud, and loud about the RIGHT release.
    expect(screen.getByTestId("available").textContent).toBe("0.22.0")
    expect(screen.getByTestId("dismissed").textContent).toBe("none")
  })

  it("adopts a sibling's fresh result from the cache event alone", async () => {
    // Nothing was ever dismissed here, so the cache write is the ONLY event.
    // Watching just the dismissal key would leave this window badge-less until
    // its next visibility change or the six-hour poll.
    render(availabilityTree())
    await waitFor(() => expect(ctx).not.toBeNull())
    expect(screen.getByTestId("available").textContent).toBe("none")

    const fresh = cachedOffer(Date.now())
    localStorage.setItem(LAST_CHECK_KEY, fresh)
    await act(async () => {
      window.dispatchEvent(
        new StorageEvent("storage", { key: LAST_CHECK_KEY, newValue: fresh })
      )
      await Promise.resolve()
    })

    expect(screen.getByTestId("available").textContent).toBe("0.21.9")
    // Adopted from the sibling, not re-fetched.
    expect(checkCalls()).toBe(0)
  })

  it("takes a sibling's different answer stamped in the same millisecond", async () => {
    // Two windows can complete checks a fraction of a millisecond apart and
    // still land on the same `at` — with different answers, if a release was
    // published between the two requests. A `<=` watermark would drop the
    // sibling's, while the dismissal read still un-muted us: a loud badge for
    // the older release and its stale notes.
    const at = Date.now()
    localStorage.setItem(DISMISSED_KEY, "0.21.9")
    localStorage.setItem(LAST_CHECK_KEY, cachedOffer(at))
    render(availabilityTree())
    await waitFor(() =>
      expect(screen.getByTestId("available").textContent).toBe("0.21.9")
    )
    expect(screen.getByTestId("dismissed").textContent).toBe("0.21.9")

    const sameMs = cachedOffer(at, "0.22.0")
    localStorage.setItem(LAST_CHECK_KEY, sameMs)
    localStorage.removeItem(DISMISSED_KEY)
    await act(async () => {
      window.dispatchEvent(
        new StorageEvent("storage", { key: LAST_CHECK_KEY, newValue: sameMs })
      )
      await Promise.resolve()
    })

    expect(screen.getByTestId("available").textContent).toBe("0.22.0")
    expect(screen.getByTestId("dismissed").textContent).toBe("none")
  })

  it("does not re-apply an identical entry stamped in the same millisecond", async () => {
    // The common case for an equal stamp is re-reading our OWN entry. Adopting
    // it again would hand consumers a fresh `available` object to re-render
    // against on every visibility change, so content — not the clock — has to
    // break the tie.
    localStorage.setItem(LAST_CHECK_KEY, cachedOffer(Date.now()))
    render(availabilityTree())
    await waitFor(() =>
      expect(screen.getByTestId("available").textContent).toBe("0.21.9")
    )
    const before = availableIdentities

    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"))
      await Promise.resolve()
    })
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"))
      await Promise.resolve()
    })

    expect(screen.getByTestId("available").textContent).toBe("0.21.9")
    expect(availableIdentities).toBe(before)
  })

  it("goes loud again for the next release a sibling finds", async () => {
    // A dismissal silences exactly one version. Adopting a sibling's newer
    // offer must leave the badge un-muted, or waving one release away would
    // silence every release after it.
    localStorage.setItem(DISMISSED_KEY, "0.21.9")
    localStorage.setItem(LAST_CHECK_KEY, cachedOffer(Date.now()))
    render(availabilityTree())
    await waitFor(() =>
      expect(screen.getByTestId("dismissed").textContent).toBe("0.21.9")
    )

    localStorage.setItem(LAST_CHECK_KEY, cachedOffer(Date.now() + 1, "0.22.0"))
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"))
      await Promise.resolve()
    })

    expect(screen.getByTestId("available").textContent).toBe("0.22.0")
    // Still the old version, which no longer matches the offer — so the badge
    // is loud again (status-bar-update.tsx compares the two).
    expect(screen.getByTestId("dismissed").textContent).toBe("0.21.9")
  })
})
