import { act, renderHook } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const api = vi.hoisted(() => ({
  browserClose: vi.fn(() => Promise.resolve()),
  browserAgentGrant: vi.fn(() => Promise.resolve({})),
  isDesktop: vi.fn(() => true),
}))
vi.mock("./browser-api", () => ({
  browserClose: api.browserClose,
  browserAgentGrant: api.browserAgentGrant,
}))
vi.mock("@/lib/transport", () => ({
  isDesktop: api.isDesktop,
  isRemoteDesktopMode: () => false,
}))

import {
  browserTabHiddenAt,
  browserWorkspaceTabId,
  claimSurfaceCreation,
  clearBrowserAgentActivity,
  forgetSurfaceCreation,
  hasSurfaceClaim,
  runSurfaceOp,
  surfaceClaimIsCurrent,
  getBrowserTabState,
  markBrowserTabHidden,
  markBrowserTabShown,
  releaseBrowserTab,
  recordBrowserAgentActivity,
  removeBrowserTabState,
  setBrowserConsoleErrors,
  resetBrowserTabStoreForTests,
  setBrowserTabState,
  subscribeBrowserTabs,
  useBrowserAgentActivity,
  useBrowserConsoleErrors,
  useBrowserTabState,
} from "./browser-tab-store"
import {
  applyDefaultAgentGrant,
  resetDefaultAgentGrantForTests,
} from "./browser-agent-grant"
import { resetBrowserPrefsForTests } from "./browser-prefs"
import type { AgentActivityPayload, AgentGrant, BrowserTabState } from "./types"

function state(over: Partial<BrowserTabState> = {}): BrowserTabState {
  return {
    tabId: "abc",
    ownerWindow: "main",
    kind: "page",
    surface: "child",
    channel: "native",
    channelError: null,
    url: "https://example.com/",
    requestedUrl: "https://example.com/",
    title: "Example",
    favicon: null,
    loading: false,
    canGoBack: false,
    canGoForward: false,
    origin: "https://example.com",
    zoom: 1,
    error: null,
    remoteHost: null,
    openerTabId: null,
    profile: "default",
    agentGrant: null,
    ...over,
  }
}

describe("browser tab store", () => {
  beforeEach(() => {
    resetBrowserTabStoreForTests()
    api.browserClose.mockClear()
    api.isDesktop.mockReturnValue(true)
  })
  afterEach(() => resetBrowserTabStoreForTests())

  it("keys state by the workspace tab id derived from the backend id", () => {
    setBrowserTabState(state())
    expect(browserWorkspaceTabId("abc")).toBe("browser:abc")
    expect(getBrowserTabState("browser:abc")?.title).toBe("Example")
    expect(getBrowserTabState("browser:zzz")).toBeNull()
  })

  it("notifies subscribers only when something actually changed", () => {
    const listener = vi.fn()
    subscribeBrowserTabs(listener)
    setBrowserTabState(state())
    setBrowserTabState(state())
    expect(listener).toHaveBeenCalledTimes(1)
    setBrowserTabState(state({ loading: true }))
    expect(listener).toHaveBeenCalledTimes(2)
    const first = getBrowserTabState("browser:abc")
    setBrowserTabState(state({ loading: true }))
    expect(getBrowserTabState("browser:abc")).toBe(first)
    removeBrowserTabState("browser:abc")
    expect(listener).toHaveBeenCalledTimes(3)
    removeBrowserTabState("browser:abc")
    expect(listener).toHaveBeenCalledTimes(3)
  })

  /// The nested fields arrive as fresh objects in every event, so identity
  /// cannot be the test. A tab whose page is loading emits a stream of
  /// `browser://state`, and an unchanged grant in each of them must not make
  /// every one of them look like news.
  it("an unchanged nested field is not a change", () => {
    const grant: AgentGrant = {
      level: "read",
      origin: "https://example.com",
      grantedAt: 1,
    }
    const listener = vi.fn()
    subscribeBrowserTabs(listener)
    setBrowserTabState(state({ agentGrant: { ...grant } }))
    expect(listener).toHaveBeenCalledTimes(1)
    setBrowserTabState(state({ agentGrant: { ...grant } }))
    expect(listener).toHaveBeenCalledTimes(1)
    // …and a real one still is, in both directions.
    setBrowserTabState(state({ agentGrant: { ...grant, level: "control" } }))
    expect(listener).toHaveBeenCalledTimes(2)
    setBrowserTabState(state({ agentGrant: null }))
    expect(listener).toHaveBeenCalledTimes(3)
  })

  it("useBrowserTabState re-renders for its own tab only", () => {
    const { result, rerender } = renderHook(
      ({ id }: { id: string | null }) => useBrowserTabState(id),
      { initialProps: { id: "browser:abc" as string | null } }
    )
    expect(result.current).toBeNull()
    act(() => setBrowserTabState(state()))
    expect(result.current?.url).toBe("https://example.com/")
    act(() => setBrowserTabState(state({ tabId: "other", url: "https://o/" })))
    expect(result.current?.url).toBe("https://example.com/")
    rerender({ id: null })
    expect(result.current).toBeNull()
  })

  it("releaseBrowserTab forgets the state and closes the backend surface on desktop", () => {
    setBrowserTabState(state())
    releaseBrowserTab("browser:abc")
    expect(getBrowserTabState("browser:abc")).toBeNull()
    // No request id: a close is not a suspend, and there is nothing to tell
    // its `browser://closed` apart from.
    expect(api.browserClose).toHaveBeenCalledWith("abc", undefined)
    api.isDesktop.mockReturnValue(false)
    releaseBrowserTab("browser:abc")
    expect(api.browserClose).toHaveBeenCalledTimes(1)
    releaseBrowserTab("file:%2Fx")
    expect(api.browserClose).toHaveBeenCalledTimes(1)
  })

  // Closing a tab ends it; SUSPENDING it releases the surface and keeps the
  // tab, on the same id and the same page. So a share the person took back
  // has to survive the second and not the first — dropping it on a suspend
  // would hand the site to agents again, on the standing default, the moment
  // the tab is switched back to.
  describe("what a release does to the sharing answers", () => {
    /** The person shares (the standing default), then takes it back. */
    function sharedThenRevoked() {
      const page = state({ origin: "https://example.com" })
      applyDefaultAgentGrant(page)
      applyDefaultAgentGrant(
        state({
          origin: "https://example.com",
          agentGrant: {
            level: "control",
            origin: "https://example.com",
            grantedAt: 1,
          },
        })
      )
      applyDefaultAgentGrant(page)
      api.browserAgentGrant.mockClear()
      return page
    }

    beforeEach(() => {
      resetDefaultAgentGrantForTests()
      resetBrowserPrefsForTests()
      api.browserAgentGrant.mockClear()
    })

    it("keeps them when the tab is only suspended", () => {
      const page = sharedThenRevoked()
      releaseBrowserTab("browser:abc", { suspending: true })
      applyDefaultAgentGrant(page)
      expect(api.browserAgentGrant).not.toHaveBeenCalled()
    })

    it("drops them when the tab is closed", () => {
      const page = sharedThenRevoked()
      releaseBrowserTab("browser:abc")
      applyDefaultAgentGrant(page)
      expect(api.browserAgentGrant).toHaveBeenCalledWith("abc", "control")
    })
  })

  // The ledger is what stops a StrictMode double effect (or a re-mounted
  // host) from creating a second webview for one tab.
  it("hands the surface-creation claim to exactly one caller until released", () => {
    const token = claimSurfaceCreation("abc")
    expect(token).not.toBeNull()
    expect(claimSurfaceCreation("abc")).toBeNull()
    expect(surfaceClaimIsCurrent("abc", token!)).toBe(true)

    forgetSurfaceCreation("abc")
    // The old holder can now tell that the surface it is building is nobody's.
    expect(surfaceClaimIsCurrent("abc", token!)).toBe(false)
    expect(hasSurfaceClaim("abc")).toBe(false)
    const next = claimSurfaceCreation("abc")
    expect(next).not.toBeNull()
    expect(next).not.toBe(token)
    // A claim taken meanwhile does not make the old token current again.
    expect(surfaceClaimIsCurrent("abc", token!)).toBe(false)
  })

  // Releasing a tab returns it to "not loaded": the next host that mounts
  // for it creates a fresh surface. This is what makes a suspended (or
  // restored) tab resumable through the same code path.
  it("releasing a tab frees its claim", () => {
    setBrowserTabState(state())
    const token = claimSurfaceCreation("abc")
    expect(token).not.toBeNull()
    releaseBrowserTab("browser:abc")
    expect(surfaceClaimIsCurrent("abc", token!)).toBe(false)
    expect(claimSurfaceCreation("abc")).not.toBeNull()
  })

  // A backend tab id is reused across generations (suspend, then show
  // again). Without ordering, the close issued for the old generation could
  // reach the backend after the new one registered and destroy it.
  it("runs the create and destroy calls of one tab id in order", async () => {
    const order: string[] = []
    const settle: Array<() => void> = []
    const op = (name: string) => () =>
      new Promise<void>((resolve) => {
        order.push(`${name}:start`)
        settle.push(() => {
          order.push(`${name}:done`)
          resolve()
        })
      })

    const first = runSurfaceOp("abc", op("close"))
    const second = runSurfaceOp("abc", op("open"))
    // The second has not even started: it is waiting on the first.
    expect(order).toEqual(["close:start"])

    settle[0]()
    await first
    await Promise.resolve()
    expect(order).toEqual(["close:start", "close:done", "open:start"])
    settle[1]()
    await second
    expect(order).toEqual([
      "close:start",
      "close:done",
      "open:start",
      "open:done",
    ])

    // A different tab id is an independent chain.
    let otherStarted = false
    void runSurfaceOp("xyz", () => {
      otherStarted = true
      return Promise.resolve()
    })
    await Promise.resolve()
    expect(otherStarted).toBe(true)
  })

  // A failed op must not stall everything queued behind it.
  it("keeps the chain moving after a failed op", async () => {
    const failed = runSurfaceOp("abc", () => Promise.reject(new Error("nope")))
    await expect(failed).rejects.toThrow("nope")
    await expect(
      runSurfaceOp("abc", () => Promise.resolve("ok"))
    ).resolves.toBe("ok")
  })

  describe("agent activity", () => {
    const read = (over: Partial<AgentActivityPayload> = {}) =>
      act(() =>
        recordBrowserAgentActivity({
          tabId: "abc",
          action: "read",
          outcome: "done",
          at: 1,
          ...over,
        })
      )

    it("gives a tab with no activity the same empty list every time", () => {
      const view = renderHook(() => useBrowserAgentActivity("browser:abc"))
      const first = view.result.current
      expect(first).toEqual([])
      // A fresh array each read would make `useSyncExternalStore` believe the
      // store had changed on every notification, forever.
      act(() =>
        recordBrowserAgentActivity({
          tabId: "other",
          action: "read",
          outcome: "done",
          at: 1,
        })
      )
      expect(view.result.current).toBe(first)
      view.unmount()
    })

    it("folds a run of identical attempts into one line and keeps the newest time", () => {
      const view = renderHook(() => useBrowserAgentActivity("browser:abc"))
      read({ at: 100 })
      read({ at: 200 })
      read({ at: 300 })
      expect(view.result.current).toEqual([
        { action: "read", outcome: "done", at: 300, count: 3 },
      ])
      // A different outcome is a different line, and goes on top.
      read({ at: 400, outcome: "refused" })
      read({ at: 500 })
      expect(view.result.current).toEqual([
        { action: "read", outcome: "done", at: 500, count: 1 },
        { action: "read", outcome: "refused", at: 400, count: 1 },
        { action: "read", outcome: "done", at: 300, count: 3 },
      ])
      view.unmount()
    })

    it("keeps only the most recent lines", () => {
      const view = renderHook(() => useBrowserAgentActivity("browser:abc"))
      // Alternating outcomes so nothing folds: 120 distinct lines offered.
      for (let i = 0; i < 120; i += 1) {
        read({ at: i, outcome: i % 2 === 0 ? "done" : "refused" })
      }
      expect(view.result.current).toHaveLength(50)
      expect(view.result.current[0]?.at).toBe(119)
      view.unmount()
    })

    it("forgets a tab's activity with the tab", () => {
      const view = renderHook(() => useBrowserAgentActivity("browser:abc"))
      read()
      expect(view.result.current).toHaveLength(1)
      act(() => removeBrowserTabState("browser:abc"))
      expect(view.result.current).toEqual([])
      view.unmount()
    })

    // Asking for the page again (a reload, an address typed into the bar)
    // clears it: those lines are about the document being replaced.
    it("clears one tab's lines on demand, and only that tab's", () => {
      const view = renderHook(() => useBrowserAgentActivity("browser:abc"))
      const other = renderHook(() => useBrowserAgentActivity("browser:other"))
      read()
      act(() =>
        recordBrowserAgentActivity({
          tabId: "other",
          action: "read",
          outcome: "done",
          at: 1,
        })
      )
      act(() => clearBrowserAgentActivity("browser:abc", 500))
      expect(view.result.current).toEqual([])
      expect(other.result.current).toHaveLength(1)
      // The next attempt starts a fresh list rather than reviving the old one.
      read({ at: 900 })
      expect(view.result.current).toEqual([
        { action: "read", outcome: "done", at: 900, count: 1 },
      ])
      view.unmount()
      other.unmount()
    })

    // The callers ask the backend first and clear when it answers, so the
    // cut-off is the moment they asked, not the moment they were answered.
    // Over a remote workspace that gap is a network round trip — long enough
    // for the new document to land and for an agent to reach for it, and
    // those lines are about the page that is on screen now.
    it("keeps what was recorded after the cut-off", () => {
      const view = renderHook(() => useBrowserAgentActivity("browser:abc"))
      read({ at: 100 })
      read({ at: 700, action: "click", outcome: "refused" })
      act(() => clearBrowserAgentActivity("browser:abc", 500))
      expect(view.result.current).toEqual([
        { action: "click", outcome: "refused", at: 700, count: 1 },
      ])
      view.unmount()
    })

    // The store notifies on a real clear only: a tab with nothing recorded is
    // reloaded on every visit, and waking every subscriber for it would make
    // the reload path cost more the more browser tabs are open. Nor does a
    // clear that kept every line it looked at.
    it("says nothing when there was nothing to clear", () => {
      const listener = vi.fn()
      const unsubscribe = subscribeBrowserTabs(listener)
      clearBrowserAgentActivity("browser:abc", 500)
      expect(listener).not.toHaveBeenCalled()
      read({ at: 900 })
      listener.mockClear()
      clearBrowserAgentActivity("browser:abc", 500)
      expect(listener).not.toHaveBeenCalled()
      clearBrowserAgentActivity("browser:abc", 1000)
      expect(listener).toHaveBeenCalledTimes(1)
      unsubscribe()
    })
  })

  // The mark says "something went wrong on the page in front of you". Both
  // of its edges come from the backend, which raises it on the first error of
  // a document and drops it when the next document clears the tab's console
  // ring — the two moments that move the ring, so the mark cannot drift from
  // what the tab actually holds. It is deliberately NOT derived from the tab
  // state: `loading` is set by more than a commit (a title report mid-load
  // emits state too), and inferring from it took the mark back off while the
  // error was still there.
  describe("the console-error mark", () => {
    it("follows the backend, and no tab state moves it", () => {
      const view = renderHook(() => useBrowserConsoleErrors("browser:abc"))
      expect(view.result.current).toBe(false)
      act(() => setBrowserConsoleErrors("browser:abc", true))
      expect(view.result.current).toBe(true)
      // Every kind of tab state, including the one a mid-load report carries.
      act(() => setBrowserTabState(state({ title: "Orders" })))
      act(() => setBrowserTabState(state({ loading: true })))
      expect(view.result.current).toBe(true)
      act(() => setBrowserConsoleErrors("browser:abc", false))
      expect(view.result.current).toBe(false)
      view.unmount()
    })

    it("goes away with the tab", () => {
      const view = renderHook(() => useBrowserConsoleErrors("browser:abc"))
      act(() => setBrowserConsoleErrors("browser:abc", true))
      expect(view.result.current).toBe(true)
      act(() => removeBrowserTabState("browser:abc"))
      expect(view.result.current).toBe(false)
      view.unmount()
    })
  })

  it("stamps when a tab left the screen", () => {
    expect(browserTabHiddenAt("browser:abc")).toBeUndefined()
    markBrowserTabShown("browser:abc")
    expect(browserTabHiddenAt("browser:abc")).toBeNull()
    markBrowserTabHidden("browser:abc")
    expect(typeof browserTabHiddenAt("browser:abc")).toBe("number")
    // Forgetting the tab forgets the stamp with it.
    removeBrowserTabState("browser:abc")
    expect(browserTabHiddenAt("browser:abc")).toBeUndefined()
  })
})
