import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { BrowserTabState } from "./types"

const mocks = vi.hoisted(() => ({
  // Typed by its signature rather than by the stub's own (empty) parameter
  // list, so `mock.calls[n][1]` is the level and not an out-of-range index.
  browserAgentGrant: vi.fn<(tabId: string, level: string) => Promise<unknown>>(
    () => Promise.resolve({})
  ),
}))
vi.mock("./browser-api", () => ({
  browserAgentGrant: mocks.browserAgentGrant,
}))

import {
  resetBrowserPrefsForTests,
  setBrowserDefaultAgentGrant,
} from "./browser-prefs"

import {
  applyDefaultAgentGrant,
  forgetDefaultAgentGrant,
  resetDefaultAgentGrantForTests,
  shareableOrigin,
} from "./browser-agent-grant"

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

/** The tab sitting on `origin`, with no grant on it. */
function on(origin: string): BrowserTabState {
  return state({ url: `${origin}/`, origin })
}

/** …and the same page with a grant of `level` on it. */
function shared(
  level: "read" | "control",
  origin = "https://example.com"
): BrowserTabState {
  return state({
    url: `${origin}/`,
    origin,
    agentGrant: { level, origin, grantedAt: 1 },
  })
}

/** The levels the backend was asked for, in order. */
function asked(): string[] {
  return mocks.browserAgentGrant.mock.calls.map((call) => String(call[1]))
}

describe("the standing sharing default", () => {
  beforeEach(() => {
    mocks.browserAgentGrant.mockClear()
    resetBrowserPrefsForTests()
    resetDefaultAgentGrantForTests()
  })
  afterEach(() => {
    resetBrowserPrefsForTests()
    resetDefaultAgentGrantForTests()
  })

  it("shares a page that has committed, at the level the settings hold", () => {
    applyDefaultAgentGrant(state())
    expect(mocks.browserAgentGrant).toHaveBeenCalledWith("abc", "control")

    resetDefaultAgentGrantForTests()
    setBrowserDefaultAgentGrant("read")
    applyDefaultAgentGrant(state())
    expect(mocks.browserAgentGrant).toHaveBeenLastCalledWith("abc", "read")
  })

  // The decisive one: a page emits a stream of `browser://state` events, and
  // one of them is the state right after the person pressed "stop sharing".
  // Asking again there would make that button unpressable.
  it("answers once per site, so a share taken back stays taken back", () => {
    applyDefaultAgentGrant(state())
    expect(mocks.browserAgentGrant).toHaveBeenCalledTimes(1)
    applyDefaultAgentGrant(shared("control"))
    // The person takes it back, and the page goes on loading.
    applyDefaultAgentGrant(state())
    applyDefaultAgentGrant(state({ loading: true }))
    expect(mocks.browserAgentGrant).toHaveBeenCalledTimes(1)
  })

  // …and the tab must not be able to launder that press by leaving the site
  // and coming back, which a page can do to itself with one assignment to
  // `location.href` and a `history.back()`.
  it("does not re-share a site the person ended the share on", () => {
    applyDefaultAgentGrant(state())
    applyDefaultAgentGrant(shared("control"))
    applyDefaultAgentGrant(state())
    // …through a blank document, off to another site, and back.
    applyDefaultAgentGrant(state({ url: "about:blank", origin: null }))
    applyDefaultAgentGrant(on("https://other.test"))
    applyDefaultAgentGrant(state())
    expect(asked()).toEqual(["control", "control"])
  })

  // …nor by filling what this tab remembers. The levels have a budget, and
  // under one shared budget the page chose who fell out of it: 65 origins it
  // controls, each recorded as it was auto-shared, and the press was off the
  // front by the time the tab came back. Revocations have a budget of their
  // own now, and nothing a page can do writes one.
  it("does not re-share a site whose revocation a page tried to crowd out", () => {
    applyDefaultAgentGrant(state())
    applyDefaultAgentGrant(shared("control"))
    applyDefaultAgentGrant(state())
    const asksBefore = mocks.browserAgentGrant.mock.calls.length
    for (let i = 0; i < 65; i++) {
      const origin = `https://s${i}.evil.test`
      applyDefaultAgentGrant(on(origin))
      applyDefaultAgentGrant(shared("control", origin))
    }
    applyDefaultAgentGrant(state({ url: "about:blank", origin: null }))
    applyDefaultAgentGrant(state())
    // The tour's own 65, and not one more for the site it was hiding.
    expect(mocks.browserAgentGrant).toHaveBeenCalledTimes(asksBefore + 65)
  })

  // The same rule from the other direction: a grant the BACKEND took back
  // because the program behind a loopback port changed hands is not re-made
  // on the way back either. The alarm bar that reported it offers reading,
  // and only if the person presses it.
  it("does not re-share a loopback address that changed hands", () => {
    const local = "http://localhost:3000"
    applyDefaultAgentGrant(on(local))
    applyDefaultAgentGrant(shared("control", local))
    applyDefaultAgentGrant(on(local))
    applyDefaultAgentGrant(state())
    applyDefaultAgentGrant(on(local))
    // The first arrival at the loopback address, and the trip to example.com.
    expect(mocks.browserAgentGrant).toHaveBeenCalledTimes(2)
  })

  // A person who narrows a site to reading has said something about that
  // site. An SSO bounce (bank → identity provider → bank) must not hand it
  // back at the wider default just because the tab left and returned.
  it("gives a site back the level it was left at", () => {
    applyDefaultAgentGrant(state())
    applyDefaultAgentGrant(shared("read"))
    applyDefaultAgentGrant(on("https://idp.test"))
    applyDefaultAgentGrant(state())
    expect(asked()).toEqual(["control", "control", "read"])
  })

  // The other side of the same coin: a page it was NOT un-shared on is shared
  // again when the tab comes back to it, whether it left via another site or
  // via a document with no address at all. Those two must not disagree.
  it("shares a site again when the tab returns to it", () => {
    applyDefaultAgentGrant(state())
    applyDefaultAgentGrant(shared("control"))
    applyDefaultAgentGrant(state({ url: "about:blank", origin: null }))
    applyDefaultAgentGrant(state())
    expect(asked()).toEqual(["control", "control"])
  })

  it("applies again at the next site the tab reaches", () => {
    applyDefaultAgentGrant(state())
    applyDefaultAgentGrant(on("https://other.test"))
    expect(mocks.browserAgentGrant).toHaveBeenCalledTimes(2)
    expect(mocks.browserAgentGrant).toHaveBeenLastCalledWith("abc", "control")
  })

  it("hands nothing over when the default is to share nothing", () => {
    setBrowserDefaultAgentGrant("none")
    applyDefaultAgentGrant(state())
    expect(mocks.browserAgentGrant).not.toHaveBeenCalled()
  })

  // Turning the setting on is not a promise about the next site — it is an
  // answer about pages, and the page in front of the person is one. Which is
  // why a tab seen while the default was off is left unanswered rather than
  // written down as decided.
  it("reaches a page that was already open when the default is turned on", () => {
    setBrowserDefaultAgentGrant("none")
    applyDefaultAgentGrant(state())
    setBrowserDefaultAgentGrant("control")
    applyDefaultAgentGrant(state())
    expect(mocks.browserAgentGrant).toHaveBeenCalledWith("abc", "control")
  })

  // …and a share the person made themselves is not widened by it.
  it("leaves a level somebody chose where they put it", () => {
    setBrowserDefaultAgentGrant("none")
    applyDefaultAgentGrant(shared("read"))
    setBrowserDefaultAgentGrant("control")
    applyDefaultAgentGrant(shared("read"))
    expect(mocks.browserAgentGrant).not.toHaveBeenCalled()
  })

  // A CLOSED tab's answers are nobody's. (A suspended one keeps its own —
  // it comes back under the same id, on the same page, so it is the same
  // tab; `browser-tab-store` is where that distinction is made and pinned.)
  it("starts a tab over once the tab itself has gone", () => {
    applyDefaultAgentGrant(state())
    applyDefaultAgentGrant(shared("control"))
    applyDefaultAgentGrant(state())
    forgetDefaultAgentGrant("abc")
    applyDefaultAgentGrant(state())
    expect(mocks.browserAgentGrant).toHaveBeenCalledTimes(2)
  })

  it("never shares a document guest, whose address looks like any other site", () => {
    applyDefaultAgentGrant(
      state({
        kind: "document",
        url: "https://codeg-doc.localhost/report.html",
        origin: "https://codeg-doc.localhost",
      })
    )
    expect(mocks.browserAgentGrant).not.toHaveBeenCalled()
  })

  // Every window hears every tab's state. Without this, a second workspace
  // window would ask for the same grant a second time on every commit.
  it("leaves another window's tab to the window it belongs to", () => {
    applyDefaultAgentGrant(state({ ownerWindow: "workspace-2" }))
    expect(mocks.browserAgentGrant).not.toHaveBeenCalled()
  })

  it("asks nothing for a tab that is already shared", () => {
    applyDefaultAgentGrant(shared("read"))
    expect(mocks.browserAgentGrant).not.toHaveBeenCalled()
  })

  // Nobody asked for this share, so its failure is not an interruption — and
  // it is not retried within the stay either: a refusal repeating on every
  // state event would be a call per frame of a loading page.
  it("says nothing when the backend refuses, and does not ask again", async () => {
    mocks.browserAgentGrant.mockImplementationOnce(() =>
      Promise.reject(new Error("no origin"))
    )
    applyDefaultAgentGrant(state())
    await Promise.resolve()
    applyDefaultAgentGrant(state())
    expect(mocks.browserAgentGrant).toHaveBeenCalledTimes(1)
  })
})

describe("what can be shared at all", () => {
  it("takes http and https origins, and nothing else", () => {
    expect(shareableOrigin(state())).toBe("https://example.com")
    expect(shareableOrigin(state({ origin: "http://localhost:3000" }))).toBe(
      "http://localhost:3000"
    )
    expect(shareableOrigin(state({ origin: null }))).toBeNull()
    expect(shareableOrigin(state({ origin: "codeg-doc://x" }))).toBeNull()
    expect(shareableOrigin(state({ kind: "document" }))).toBeNull()
    expect(shareableOrigin(null)).toBeNull()
  })
})
