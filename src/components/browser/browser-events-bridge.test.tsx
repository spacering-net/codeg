import { act, render, renderHook } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { BrowserCapabilities } from "@/lib/browser/types"

type Handler = (payload: unknown) => void

const mocks = vi.hoisted(() => {
  const handlers = new Map<string, Handler>()
  const unsubscribed: string[] = []
  return {
    handlers,
    unsubscribed,
    remoteDesktop: false,
    capabilities: vi.fn(
      (): Promise<BrowserCapabilities> =>
        Promise.resolve({
          available: true,
          surface: "child",
          platform: "macos",
          channel: "native",
          reasons: [],
          isolatedStorage: true,
          proxy: { url: null, applies: "live", reason: null },
          downloadsDir: "/Users/dev/Downloads",
          docGuest: false,
          profiles: false,
          signInUserAgent: false,
          ownedWindowControls: false,
          remoteEgress: false,
          policy: { enabled: true, managedRules: [], managedSource: null },
        })
    ),
    browserSetHostRules: vi.fn(() => Promise.resolve()),
    browserSetSignInUserAgent: vi.fn(() => Promise.resolve()),
    browserAgentGrant: vi.fn(() => Promise.resolve({}) as Promise<unknown>),
    subscribe: vi.fn((event: string, handler: Handler) => {
      handlers.set(event, handler)
      return Promise.resolve(() => {
        unsubscribed.push(event)
        handlers.delete(event)
      })
    }),
    adoptBrowserTab: vi.fn(() => "browser:opener-p1"),
    closeFileTab: vi.fn(),
    // `string | null` like the real one: a workspace that opened no tab
    // (an address it would not take) is one of the cases below.
    openBrowserTab: vi.fn<(...args: unknown[]) => string | null>(
      () => "browser:new"
    ),
    browserAnswerOpenRequest: vi.fn(() => Promise.resolve(true)),
    // Typed by its real signature, so `mock.calls[n][1]` is the request id
    // and not an out-of-range index.
    browserClose: vi.fn<(tabId: string, requestId?: string) => Promise<void>>(
      () => Promise.resolve()
    ),
    browserListTabs: vi.fn(() =>
      Promise.resolve([{ tabId: "stale-1" }, { tabId: "stale-2" }])
    ),
    browserListDownloads: vi.fn(() =>
      Promise.resolve([
        {
          id: "dl-1",
          tabId: "t1",
          url: "https://example.com/a.bin",
          fileName: "a.bin",
          path: "/Users/dev/Downloads/a.bin",
          state: "completed",
        },
      ])
    ),
  }
})

vi.mock("@/lib/browser/browser-api", () => ({
  browserCapabilities: mocks.capabilities,
  browserClose: mocks.browserClose,
  browserListTabs: mocks.browserListTabs,
  browserListDownloads: mocks.browserListDownloads,
  browserSetHostRules: mocks.browserSetHostRules,
  browserSetSignInUserAgent: mocks.browserSetSignInUserAgent,
  browserAgentGrant: mocks.browserAgentGrant,
  browserAnswerOpenRequest: mocks.browserAnswerOpenRequest,
}))
vi.mock("@/lib/transport", () => ({
  getShellTransport: () => ({ subscribe: mocks.subscribe }),
  isDesktop: () => true,
  isRemoteDesktopMode: () => mocks.remoteDesktop,
}))
vi.mock("@/contexts/workspace-context", () => ({
  useWorkspaceActions: () => ({
    adoptBrowserTab: mocks.adoptBrowserTab,
    closeFileTab: mocks.closeFileTab,
    openBrowserTab: mocks.openBrowserTab,
  }),
}))

import { resetDefaultAgentGrantForTests } from "@/lib/browser/browser-agent-grant"
import {
  resetBrowserPrefsForTests,
  setBrowserDefaultAgentGrant,
  setBrowserHostRules,
  setBrowserSignInUserAgent,
} from "@/lib/browser/browser-prefs"
import {
  getBrowserTabState,
  releaseBrowserTab,
  resetBrowserTabStoreForTests,
  setBrowserTabState,
  useBrowserAgentActivity,
  useBrowserBoundsResync,
  useBrowserFindRequest,
  useBrowserTabNotice,
} from "@/lib/browser/browser-tab-store"
import {
  getBrowserDownloads,
  resetBrowserDownloadsForTests,
} from "@/lib/browser/browser-downloads-store"
import {
  resetBrowserEgressStoreForTests,
  useBrowserEgressStatus,
} from "@/lib/browser/browser-egress-store"
import { BrowserEventsBridge } from "./browser-events-bridge"

/** The store's bounds-resync counter for a tab, read as a component would. */
function boundsResyncOf(workspaceTabId: string): number {
  const view = renderHook(() => useBrowserBoundsResync(workspaceTabId))
  const seen = view.result.current
  view.unmount()
  return seen
}

/** The store's find counter, read the way a component would. */
function findRequestOf(workspaceTabId: string): number {
  const view = renderHook(() => useBrowserFindRequest(workspaceTabId))
  const seen = view.result.current
  view.unmount()
  return seen
}

async function flush() {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

describe("BrowserEventsBridge", () => {
  beforeEach(() => {
    mocks.remoteDesktop = false
    resetBrowserEgressStoreForTests()
    mocks.handlers.clear()
    mocks.unsubscribed.length = 0
    mocks.subscribe.mockClear()
    mocks.adoptBrowserTab.mockClear()
    mocks.closeFileTab.mockClear()
    mocks.openBrowserTab.mockClear()
    mocks.browserClose.mockClear()
    mocks.browserListDownloads.mockClear()
    mocks.browserSetHostRules.mockClear()
    mocks.browserSetSignInUserAgent.mockClear()
    mocks.browserAgentGrant.mockClear()
    resetBrowserTabStoreForTests()
    resetBrowserDownloadsForTests()
    resetBrowserPrefsForTests()
    resetDefaultAgentGrantForTests()
  })
  afterEach(() => {
    resetBrowserTabStoreForTests()
    resetBrowserDownloadsForTests()
    resetBrowserPrefsForTests()
    resetDefaultAgentGrantForTests()
  })

  it("subscribes to the streams once the capabilities say a browser exists, after sweeping orphans", async () => {
    const { unmount } = render(<BrowserEventsBridge />)
    await flush()
    // Surfaces left over from a previous document are closed first.
    expect(mocks.browserClose).toHaveBeenCalledWith("stale-1")
    expect(mocks.browserClose).toHaveBeenCalledWith("stale-2")
    expect([...mocks.handlers.keys()].sort()).toEqual([
      "browser://agent-activity",
      "browser://agent-grant",
      "browser://closed",
      "browser://console-errors",
      "browser://devtools-closed",
      "browser://doc-state",
      "browser://download",
      "browser://egress",
      "browser://navigation-blocked",
      "browser://open-request",
      "browser://popup",
      "browser://shortcut",
      "browser://state",
    ])
    // A remote connection's tunnel, as the banners over its tabs read it.
    const egress = renderHook(() => useBrowserEgressStatus(4))
    expect(egress.result.current).toBeNull()
    act(() => {
      mocks.handlers.get("browser://egress")!({
        connectionId: 4,
        status: { state: "down", reason: "the tunnel closed" },
      })
    })
    expect(egress.result.current).toEqual({
      state: "down",
      reason: "the tunnel closed",
    })
    egress.unmount()
    // Downloads already running when this document mounted are shown again.
    expect(getBrowserDownloads().map((d) => d.id)).toEqual(["dl-1"])
    mocks.handlers.get("browser://download")!({
      id: "dl-2",
      tabId: "t1",
      url: "https://example.com/b.bin",
      fileName: "b.bin",
      path: "/Users/dev/Downloads/b.bin",
      state: "started",
    })
    expect(getBrowserDownloads().map((d) => d.id)).toEqual(["dl-2", "dl-1"])

    // ⌘F inside the page reaches the tab's find bar; anything else the page
    // claims is dropped by the host, and an unknown name changes nothing.
    expect(findRequestOf("browser:abc")).toBe(0)
    mocks.handlers.get("browser://shortcut")!({
      tabId: "abc",
      shortcut: "find",
    })
    expect(findRequestOf("browser:abc")).toBe(1)
    mocks.handlers.get("browser://shortcut")!({
      tabId: "abc",
      shortcut: "quit",
    })
    expect(findRequestOf("browser:abc")).toBe(1)

    mocks.handlers.get("browser://open-request")!({
      url: "https://example.com/from-agent",
      source: "agent",
      activate: false,
      ownerWindow: null,
    })
    expect(mocks.openBrowserTab).toHaveBeenCalledWith(
      "https://example.com/from-agent",
      { activate: false }
    )
    mocks.handlers.get("browser://open-request")!({
      url: "https://example.com/other-window",
      source: "agent",
      activate: true,
      ownerWindow: "remote-workspace-3",
    })
    expect(mocks.openBrowserTab).toHaveBeenCalledTimes(1)
    // A modifier-click names its opener; the workspace id is derived here so
    // the context can place the new tab right after it.
    mocks.handlers.get("browser://open-request")!({
      url: "https://example.com/next-to-opener",
      source: "modifier-click",
      activate: false,
      ownerWindow: "main",
      kind: "page",
      openerTabId: "abc",
      profile: "default",
    })
    expect(mocks.openBrowserTab).toHaveBeenCalledTimes(2)
    expect(mocks.openBrowserTab).toHaveBeenLastCalledWith(
      "https://example.com/next-to-opener",
      { activate: false, openerTabId: "browser:abc", profile: "default" }
    )
    // The opener's profile travels with the request: the new tab belongs to
    // the same signed-in session even when the opener record is gone.
    mocks.handlers.get("browser://open-request")!({
      url: "https://example.com/in-work",
      source: "modifier-click",
      activate: false,
      ownerWindow: "main",
      openerTabId: "abc",
      profile: "p-work",
    })
    expect(mocks.openBrowserTab).toHaveBeenLastCalledWith(
      "https://example.com/in-work",
      { activate: false, openerTabId: "browser:abc", profile: "p-work" }
    )
    // A request from an agent or a deep link leaves the profile open.
    mocks.handlers.get("browser://open-request")!({
      url: "https://example.com/no-opinion",
      source: "agent",
      activate: true,
      ownerWindow: "main",
      openerTabId: null,
      profile: null,
    })
    expect(mocks.openBrowserTab).toHaveBeenLastCalledWith(
      "https://example.com/no-opinion",
      { activate: true, openerTabId: undefined, profile: undefined }
    )

    // A request that names itself is one somebody is parked on — an agent's
    // `browser_open_tab`, which has to answer with the id of the tab it got.
    // The backend id is derived from the record, so the answer goes back
    // before any native surface exists.
    mocks.handlers.get("browser://open-request")!({
      url: "https://example.com/awaited",
      source: "agent",
      activate: true,
      ownerWindow: "main",
      requestId: "req-7",
    })
    expect(mocks.browserAnswerOpenRequest).toHaveBeenCalledWith("req-7", "new")
    // A workspace that opened nothing says so, rather than leaving the waiter
    // to time out.
    mocks.openBrowserTab.mockReturnValueOnce(null)
    mocks.handlers.get("browser://open-request")!({
      url: "not-an-address",
      source: "agent",
      activate: true,
      ownerWindow: "main",
      requestId: "req-8",
    })
    expect(mocks.browserAnswerOpenRequest).toHaveBeenLastCalledWith(
      "req-8",
      null
    )
    // A request addressed to another window is not answered by this one —
    // answering for a tab it did not open would hand the waiter a stranger.
    mocks.handlers.get("browser://open-request")!({
      url: "https://example.com/elsewhere",
      source: "agent",
      activate: true,
      ownerWindow: "remote-workspace-3",
      requestId: "req-9",
    })
    expect(mocks.browserAnswerOpenRequest).toHaveBeenCalledTimes(2)
    // And the fire-and-forget askers still say nothing.
    mocks.handlers.get("browser://open-request")!({
      url: "https://example.com/deep-link",
      source: "deeplink",
      activate: true,
      ownerWindow: "main",
    })
    expect(mocks.browserAnswerOpenRequest).toHaveBeenCalledTimes(2)

    mocks.handlers.get("browser://state")!({
      tabId: "abc",
      ownerWindow: "main",
      kind: "page",
      surface: "child",
      channel: "native",
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
    })
    expect(getBrowserTabState("browser:abc")?.title).toBe("Example")

    mocks.handlers.get("browser://popup")!({
      presentation: "adopted",
      openerTabId: "abc",
      profile: "default",
      tabId: "abc-p1",
      url: "https://example.com/popup",
      requestedSize: null,
      reason: null,
    })
    expect(mocks.adoptBrowserTab).toHaveBeenCalledWith({
      backendTabId: "abc-p1",
      url: "https://example.com/popup",
      openerBackendTabId: "abc",
      profile: "default",
    })
    mocks.handlers.get("browser://popup")!({
      presentation: "denied",
      openerTabId: "abc",
      profile: "default",
      tabId: null,
      url: "https://example.com/blocked",
      requestedSize: null,
      reason: "no-gesture",
    })
    expect(mocks.adoptBrowserTab).toHaveBeenCalledTimes(1)

    setBrowserTabState({
      tabId: "abc-p1",
      ownerWindow: "main",
      kind: "page",
      surface: "child",
      channel: "native",
      channelError: null,
      url: "",
      requestedUrl: "https://example.com/popup",
      title: "",
      favicon: null,
      loading: true,
      canGoBack: false,
      canGoForward: false,
      origin: null,
      zoom: 1,
      error: null,
      remoteHost: null,
      openerTabId: "abc",
      profile: "default",
      agentGrant: null,
    })
    mocks.handlers.get("browser://closed")!({
      tabId: "abc-p1",
      ownerWindow: "main",
      kind: "page",
    })
    expect(getBrowserTabState("browser:abc-p1")).toBeNull()
    expect(mocks.closeFileTab).toHaveBeenCalledWith("browser:abc-p1")

    // Every inspector close asks that tab's surface for its bounds again, and
    // only that tab's: an inspector docked into the window left the page
    // filling it while the placeholder never moved, so nothing else would
    // notice. Counted, so a second close asks a second time.
    expect(boundsResyncOf("browser:insp-a")).toBe(0)
    mocks.handlers.get("browser://devtools-closed")!({ tabId: "insp-a" })
    mocks.handlers.get("browser://devtools-closed")!({ tabId: "insp-b" })
    mocks.handlers.get("browser://devtools-closed")!({ tabId: "insp-b" })
    expect(boundsResyncOf("browser:insp-a")).toBe(1)
    expect(boundsResyncOf("browser:insp-b")).toBe(2)

    // …but a close THIS SIDE asked for, to suspend a background tab, is the
    // surface going and the tab staying. The backend emits the same event for
    // it, and acting on that would take the tab off the strip — the suspend
    // feature would be a close with extra steps. It is told apart by the
    // request id the close was made under, which comes back on the event.
    mocks.closeFileTab.mockClear()
    releaseBrowserTab("browser:abc-s1", { suspending: true })
    const closeCalls = mocks.browserClose.mock.calls
    const suspendRequest = closeCalls[closeCalls.length - 1]?.[1]
    expect(typeof suspendRequest).toBe("string")
    mocks.handlers.get("browser://closed")!({
      tabId: "abc-s1",
      ownerWindow: "main",
      requestId: suspendRequest,
    })
    expect(mocks.closeFileTab).not.toHaveBeenCalled()

    // A REAL close of a tab a suspend is in flight for is still acted on.
    // Only one close event is ever emitted per tab — whoever wins the
    // registry removal emits it — so if the user closes the owned window in
    // that moment, the window's event is the only one there will be. Matching
    // on the tab id would have swallowed it and left a dead row on the strip.
    mocks.closeFileTab.mockClear()
    releaseBrowserTab("browser:abc-s2", { suspending: true })
    mocks.handlers.get("browser://closed")!({
      tabId: "abc-s2",
      ownerWindow: "main",
      requestId: null,
    })
    expect(mocks.closeFileTab).toHaveBeenCalledWith("browser:abc-s2")

    unmount()
    expect(mocks.unsubscribed.sort()).toEqual([
      "browser://agent-activity",
      "browser://agent-grant",
      "browser://closed",
      "browser://console-errors",
      "browser://devtools-closed",
      "browser://doc-state",
      "browser://download",
      "browser://egress",
      "browser://navigation-blocked",
      "browser://open-request",
      "browser://popup",
      "browser://shortcut",
      "browser://state",
    ])
  })

  it("stays silent when no built-in browser is available", async () => {
    mocks.capabilities.mockResolvedValueOnce({
      available: false,
      surface: null,
      platform: "web",
      channel: "degraded",
      reasons: ["web"],
      isolatedStorage: false,
      proxy: { url: null, applies: "unsupported", reason: null },
      downloadsDir: "/Users/dev/Downloads",
      docGuest: false,
      profiles: false,
      signInUserAgent: false,
      ownedWindowControls: false,
      remoteEgress: false,
      policy: { enabled: true, managedRules: [], managedSource: null },
    })
    render(<BrowserEventsBridge />)
    await flush()
    expect(mocks.subscribe).not.toHaveBeenCalled()
  })

  it("pushes the user's site rules to the backend at start and whenever they change", async () => {
    const { unmount } = render(<BrowserEventsBridge />)
    await flush()
    expect(mocks.browserSetHostRules).toHaveBeenCalledWith([])
    // The sign-in user agent travels with them, on by default.
    expect(mocks.browserSetSignInUserAgent).toHaveBeenCalledWith(true)
    await act(async () => {
      setBrowserHostRules([{ pattern: "blocked.example", action: "block" }])
    })
    expect(mocks.browserSetHostRules).toHaveBeenLastCalledWith([
      { pattern: "blocked.example", action: "block" },
    ])
    await act(async () => {
      setBrowserSignInUserAgent(false)
    })
    expect(mocks.browserSetSignInUserAgent).toHaveBeenLastCalledWith(false)
    unmount()
    // After unmount the preference subscription is gone with the rest.
    mocks.browserSetHostRules.mockClear()
    mocks.browserSetSignInUserAgent.mockClear()
    await act(async () => {
      setBrowserHostRules([])
    })
    expect(mocks.browserSetHostRules).not.toHaveBeenCalled()
  })

  it("turns a refused navigation into a notice on its tab", async () => {
    render(<BrowserEventsBridge />)
    await flush()
    mocks.handlers.get("browser://navigation-blocked")!({
      tabId: "abc",
      url: "https://blocked.example/",
      reason: "host-rule",
    })
    const view = renderHook(() => useBrowserTabNotice("browser:abc"))
    expect(view.result.current).toEqual({
      kind: "navigation-blocked",
      url: "https://blocked.example/",
      reason: "host-rule",
    })
    view.unmount()
  })

  // The user performed the other two transitions and can see the result in
  // the toolbar; this one happened to them.
  it("only interrupts for the grant the page took away, not the ones the user made", async () => {
    // With pages shared by default the grant that ends here is re-made at the
    // next site, so the notice belongs to the other setting: sharing only
    // where the person asked for it.
    setBrowserDefaultAgentGrant("none")
    render(<BrowserEventsBridge />)
    await flush()
    const grant = mocks.handlers.get("browser://agent-grant")!
    const noticeOf = () => {
      const view = renderHook(() => useBrowserTabNotice("browser:abc"))
      const seen = view.result.current
      view.unmount()
      return seen
    }
    grant({
      tabId: "abc",
      change: "granted",
      level: "read",
      origin: "https://example.com",
    })
    expect(noticeOf()).toBeNull()
    grant({
      tabId: "abc",
      change: "revoked",
      level: "none",
      origin: "https://example.com",
    })
    expect(noticeOf()).toBeNull()
    grant({
      tabId: "abc",
      change: "navigated",
      level: "none",
      origin: "https://example.com",
    })
    expect(noticeOf()).toEqual({
      kind: "agent-grant-lost",
      origin: "https://example.com",
    })
  })

  // A standing default means the person never shared this page in the first
  // place — the browser did, and is about to again at wherever the tab
  // landed. An alarm bar there would be reporting the mechanism working.
  it("says nothing about a page walking off a site it was shared with by default", async () => {
    render(<BrowserEventsBridge />)
    await flush()
    mocks.handlers.get("browser://agent-grant")!({
      tabId: "abc",
      change: "navigated",
      level: "none",
      origin: "https://example.com",
    })
    const view = renderHook(() => useBrowserTabNotice("browser:abc"))
    expect(view.result.current).toBeNull()
    view.unmount()
  })

  // The wiring, which the rule itself (`browser-agent-grant.ts`) cannot show:
  // a committed page reaches it, and the level the settings hold is asked for.
  it("shares a page that has just committed at the standing default", async () => {
    render(<BrowserEventsBridge />)
    await flush()
    mocks.handlers.get("browser://state")!({
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
    })
    expect(mocks.browserAgentGrant).toHaveBeenCalledWith("abc", "control")
  })

  // A remote workspace window has its own bridge now: a popup opened in one
  // window must not become a tab of every other one.
  it("takes in only the popups whose opener lives in this window", async () => {
    render(<BrowserEventsBridge />)
    await flush()
    const popupState = (tabId: string, ownerWindow: string) => ({
      tabId,
      ownerWindow,
      kind: "page",
      surface: "child",
      channel: "native",
      channelError: null,
      url: "",
      requestedUrl: "https://example.com/popup",
      title: "",
      favicon: null,
      loading: true,
      canGoBack: false,
      canGoForward: false,
      origin: null,
      zoom: 1,
      error: null,
      remoteHost: null,
      openerTabId: "abc",
      profile: "default",
      agentGrant: null,
    })
    const popup = (tabId: string) => ({
      presentation: "adopted",
      openerTabId: "abc",
      profile: "default",
      tabId,
      url: "https://example.com/popup",
      requestedSize: null,
      reason: null,
    })
    // The backend sends the popup's state first; it names the opener's window.
    mocks.handlers.get("browser://state")!(
      popupState("abc-p1", "remote-workspace-3")
    )
    mocks.handlers.get("browser://popup")!(popup("abc-p1"))
    expect(mocks.adoptBrowserTab).not.toHaveBeenCalled()

    mocks.handlers.get("browser://state")!(popupState("abc-p2", "main"))
    mocks.handlers.get("browser://popup")!(popup("abc-p2"))
    expect(mocks.adoptBrowserTab).toHaveBeenCalledTimes(1)
    expect(mocks.adoptBrowserTab).toHaveBeenCalledWith(
      expect.objectContaining({ backendTabId: "abc-p2" })
    )

    // No state for the popup itself: its opener's says whose it is.
    mocks.handlers.get("browser://state")!({
      ...popupState("xyz", "remote-workspace-3"),
      openerTabId: null,
    })
    mocks.handlers.get("browser://popup")!({
      ...popup("xyz-p1"),
      openerTabId: "xyz",
    })
    expect(mocks.adoptBrowserTab).toHaveBeenCalledTimes(1)
  })

  // The window's agents run on the remote host and cannot reach this browser:
  // the standing default would only hand the page to another window's agents.
  it("shares nothing at the standing default in a remote workspace window", async () => {
    mocks.remoteDesktop = true
    render(<BrowserEventsBridge />)
    await flush()
    mocks.handlers.get("browser://state")!({
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
    })
    expect(mocks.browserAgentGrant).not.toHaveBeenCalled()
  })

  // The tab never moved, so nothing else on screen changed: the toolbar still
  // shows the address the user shared. That is exactly why it needs its own
  // notice rather than being folded into the one above.
  it("interrupts when a loopback address changes hands under a still tab", async () => {
    render(<BrowserEventsBridge />)
    await flush()
    const grant = mocks.handlers.get("browser://agent-grant")!
    grant({
      tabId: "abc",
      change: "replaced",
      level: "none",
      origin: "http://localhost:3000",
    })
    const view = renderHook(() => useBrowserTabNotice("browser:abc"))
    expect(view.result.current).toEqual({
      kind: "agent-grant-replaced",
      origin: "http://localhost:3000",
    })
    view.unmount()
  })

  it("records what agents did to a tab, refusals included", async () => {
    render(<BrowserEventsBridge />)
    await flush()
    const activity = mocks.handlers.get("browser://agent-activity")!
    activity({ tabId: "abc", action: "read", outcome: "refused", at: 10 })
    activity({ tabId: "abc", action: "read", outcome: "refused", at: 20 })
    activity({ tabId: "abc", action: "read", outcome: "done", at: 30 })
    const view = renderHook(() => useBrowserAgentActivity("browser:abc"))
    // Newest first, and the run of identical attempts is one line.
    expect(view.result.current).toEqual([
      { action: "read", outcome: "done", at: 30, count: 1 },
      { action: "read", outcome: "refused", at: 20, count: 2 },
    ])
    view.unmount()
  })

  // The settings window can write a rule while this document is still
  // waiting for the backend's capabilities. The subscription that carries
  // cross-window changes into this document's cache must already exist
  // then, and the first push must carry that rule.
  it("sends a rule written while the capabilities were still pending", async () => {
    let resolveCapabilities: (caps: BrowserCapabilities) => void = () => {}
    mocks.capabilities.mockImplementationOnce(
      () =>
        new Promise<BrowserCapabilities>((resolve) => {
          resolveCapabilities = resolve
        })
    )
    render(<BrowserEventsBridge />)
    await flush()
    expect(mocks.browserSetHostRules).not.toHaveBeenCalled()
    // Another window's write arrives as a storage event: only a subscriber
    // installs the listener that drops this document's cached snapshot.
    localStorage.setItem(
      "browser:host-rules",
      JSON.stringify([{ pattern: "blocked.example", action: "block" }])
    )
    window.dispatchEvent(
      new StorageEvent("storage", { key: "browser:host-rules" })
    )
    await act(async () => {
      resolveCapabilities({
        available: true,
        surface: "child",
        platform: "macos",
        channel: "native",
        reasons: [],
        isolatedStorage: true,
        proxy: { url: null, applies: "live", reason: null },
        downloadsDir: "/Users/dev/Downloads",
        docGuest: false,
        profiles: false,
        signInUserAgent: false,
        ownedWindowControls: false,
        remoteEgress: false,
        policy: { enabled: true, managedRules: [], managedSource: null },
      })
      await Promise.resolve()
    })
    await flush()
    expect(mocks.browserSetHostRules).toHaveBeenLastCalledWith([
      { pattern: "blocked.example", action: "block" },
    ])
  })

  it("retries a failed push once", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] })
    try {
      mocks.browserSetHostRules.mockImplementationOnce(() =>
        Promise.reject(new Error("backend restarting"))
      )
      render(<BrowserEventsBridge />)
      await flush()
      expect(mocks.browserSetHostRules).toHaveBeenCalledTimes(1)
      await act(async () => {
        vi.advanceTimersByTime(1000)
        await Promise.resolve()
      })
      expect(mocks.browserSetHostRules).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })
})
