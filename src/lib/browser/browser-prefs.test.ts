import { act, renderHook } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  DEFAULT_BROWSER_PREFS,
  addBrowserProfile,
  browserProfileExists,
  getBrowserPrefs,
  isBrowserProfileId,
  markBrowserFirstOpenSeen,
  mintBrowserProfileId,
  readBrowserEvalApprovalNow,
  removeBrowserProfile,
  resetBrowserPrefsForTests,
  setAllDefaultLinkTargets,
  setBrowserDevtools,
  setBrowserEvalApproval,
  setBrowserHostRules,
  setBrowserHtmlPreviewEngine,
  setBrowserDefaultAgentGrant,
  setBrowserNewTabProfile,
  setBrowserProfiles,
  setBrowserServiceAutoOpen,
  setBrowserSignInUserAgent,
  setBrowserSurfaceOverride,
  setBrowserTerminalClickMenu,
  setDefaultLinkTarget,
  subscribeBrowserPrefs,
  useBrowserPrefs,
} from "./browser-prefs"

/** Invalidate the in-memory snapshot the way a cross-window change does,
 *  without touching storage. The subscription that clears the cache only
 *  exists while someone listens, hence the throwaway subscriber. */
function resetCacheOnly() {
  const unsubscribe = subscribeBrowserPrefs(() => {})
  window.dispatchEvent(
    new StorageEvent("storage", { key: "browser:host-rules" })
  )
  unsubscribe()
}

describe("browser prefs", () => {
  beforeEach(() => {
    resetBrowserPrefsForTests()
  })

  afterEach(() => {
    resetBrowserPrefsForTests()
  })

  it("defaults every source to the built-in browser", () => {
    expect(getBrowserPrefs()).toEqual(DEFAULT_BROWSER_PREFS)
  })

  it("returns the same snapshot object until something changes", () => {
    const a = getBrowserPrefs()
    expect(getBrowserPrefs()).toBe(a)
    setDefaultLinkTarget("terminal", "system")
    const b = getBrowserPrefs()
    expect(b).not.toBe(a)
    expect(b.defaultTarget.terminal).toBe("system")
    expect(b.defaultTarget.transcript).toBe("builtin")
  })

  it("persists each setting under its own key", () => {
    setDefaultLinkTarget("transcript", "system")
    setBrowserDevtools(true)
    setBrowserSurfaceOverride("window")
    markBrowserFirstOpenSeen()
    expect(localStorage.getItem("browser:default-target:transcript")).toBe(
      "system"
    )
    expect(localStorage.getItem("browser:devtools")).toBe("true")
    expect(localStorage.getItem("browser:surface-override")).toBe("window")
    expect(localStorage.getItem("browser:first-open-seen")).toBe("true")
    expect(getBrowserPrefs()).toMatchObject({
      devtools: true,
      surfaceOverride: "window",
      firstOpenSeen: true,
    })
  })

  // Flipped from off in 2026-09: every engine takes the inspector as a
  // creation-time attribute, so off by default meant "reopen the tab first"
  // was the answer to every look at a page. An unset key, and anything in it
  // that is not the word off, mean on.
  it("has the web inspector on until it is explicitly switched off", () => {
    expect(getBrowserPrefs().devtools).toBe(true)
    localStorage.setItem("browser:devtools", "false")
    resetCacheOnly()
    expect(getBrowserPrefs().devtools).toBe(false)
    localStorage.setItem("browser:devtools", "yes please")
    resetCacheOnly()
    expect(getBrowserPrefs().devtools).toBe(true)
  })

  it("removes the surface override key when set back to auto", () => {
    setBrowserSurfaceOverride("child")
    setBrowserSurfaceOverride("auto")
    expect(localStorage.getItem("browser:surface-override")).toBeNull()
    expect(getBrowserPrefs().surfaceOverride).toBe("auto")
  })

  it("falls back to defaults for unknown stored values", () => {
    localStorage.setItem("browser:default-target:terminal", "popup")
    localStorage.setItem("browser:surface-override", "iframe")
    expect(getBrowserPrefs().defaultTarget.terminal).toBe("builtin")
    expect(getBrowserPrefs().surfaceOverride).toBe("auto")
  })

  it("setAllDefaultLinkTargets flips every source", () => {
    setAllDefaultLinkTargets("system")
    expect(Object.values(getBrowserPrefs().defaultTarget)).toEqual([
      "system",
      "system",
      "system",
      "system",
      "system",
    ])
  })

  it("notifies subscribers on same-window writes and cross-window storage events", () => {
    const listener = vi.fn()
    const unsubscribe = subscribeBrowserPrefs(listener)
    setBrowserDevtools(true)
    expect(listener).toHaveBeenCalledTimes(1)

    // Another window wrote directly to localStorage: the cache must drop.
    localStorage.setItem("browser:devtools", "false")
    window.dispatchEvent(
      new StorageEvent("storage", { key: "browser:devtools" })
    )
    expect(listener).toHaveBeenCalledTimes(2)
    expect(getBrowserPrefs().devtools).toBe(false)

    // Unrelated keys are ignored.
    window.dispatchEvent(new StorageEvent("storage", { key: "other:key" }))
    expect(listener).toHaveBeenCalledTimes(2)

    unsubscribe()
    setBrowserDevtools(true)
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it("stores the site-rule table under one key and drops junk on read", () => {
    expect(getBrowserPrefs().hostRules).toEqual([])
    setBrowserHostRules([
      { pattern: "*.corp.example", action: "builtin" },
      { pattern: "blocked.example", action: "block" },
    ])
    expect(getBrowserPrefs().hostRules).toEqual([
      { pattern: "*.corp.example", action: "builtin" },
      { pattern: "blocked.example", action: "block" },
    ])
    expect(localStorage.getItem("browser:host-rules")).not.toBeNull()

    // A hand-edited or corrupt entry costs that entry, not the table.
    localStorage.setItem(
      "browser:host-rules",
      JSON.stringify([
        { pattern: "ok.example", action: "system" },
        { pattern: "", action: "block" },
        { pattern: "x.example", action: "explode" },
        "junk",
      ])
    )
    resetCacheOnly()
    expect(getBrowserPrefs().hostRules).toEqual([
      { pattern: "ok.example", action: "system" },
    ])
    localStorage.setItem("browser:host-rules", "{ not json")
    resetCacheOnly()
    expect(getBrowserPrefs().hostRules).toEqual([])

    // An empty table removes the key rather than storing `[]`.
    setBrowserHostRules([])
    expect(localStorage.getItem("browser:host-rules")).toBeNull()
  })

  it("stores the terminal link-menu switch under its own key, off by default", () => {
    expect(getBrowserPrefs().terminalClickMenu).toBe(false)
    setBrowserTerminalClickMenu(true)
    expect(localStorage.getItem("browser:terminal-click-menu")).toBe("true")
    expect(getBrowserPrefs().terminalClickMenu).toBe(true)
    // Off is the default, so off removes the key rather than storing it.
    setBrowserTerminalClickMenu(false)
    expect(localStorage.getItem("browser:terminal-click-menu")).toBeNull()
    expect(getBrowserPrefs().terminalClickMenu).toBe(false)
  })

  it("defaults the HTML preview engine to the guest and stores only inline", () => {
    expect(getBrowserPrefs().htmlPreviewEngine).toBe("guest")
    setBrowserHtmlPreviewEngine("inline")
    expect(localStorage.getItem("browser:html-preview-engine")).toBe("inline")
    expect(getBrowserPrefs().htmlPreviewEngine).toBe("inline")
    setBrowserHtmlPreviewEngine("guest")
    expect(localStorage.getItem("browser:html-preview-engine")).toBeNull()
    expect(getBrowserPrefs().htmlPreviewEngine).toBe("guest")
  })

  it("mints profile ids in the backend's alphabet", () => {
    const id = mintBrowserProfileId()
    expect(id).toMatch(/^p-[0-9a-f]{12}$/)
    expect(isBrowserProfileId(id)).toBe(true)
    for (const bad of [
      "",
      "Default",
      "-x",
      "a b",
      "../x",
      7,
      null,
      "x".repeat(41),
    ]) {
      expect(isBrowserProfileId(bad)).toBe(false)
    }
    expect(isBrowserProfileId("default")).toBe(true)
  })

  it("keeps the profile list under one key and drops junk on read", () => {
    expect(getBrowserPrefs().profiles).toEqual([])
    const work = addBrowserProfile("  Work ")
    expect(work.name).toBe("Work")
    expect(getBrowserPrefs().profiles).toEqual([work])
    expect(browserProfileExists(getBrowserPrefs(), work.id)).toBe(true)
    expect(browserProfileExists(getBrowserPrefs(), "default")).toBe(true)
    expect(browserProfileExists(getBrowserPrefs(), "p-nope")).toBe(false)

    // The default profile is implicit; an entry claiming its id, a nameless
    // one, a bad id and a repeated id are all dropped, one at a time.
    localStorage.setItem(
      "browser:profiles",
      JSON.stringify([
        { id: "default", name: "Nope" },
        { id: "p-ok", name: "OK" },
        { id: "p-blank", name: "   " },
        { id: "P-UPPER", name: "Upper" },
        { id: "p-ok", name: "Again" },
        "junk",
      ])
    )
    resetCacheOnly()
    expect(getBrowserPrefs().profiles).toEqual([{ id: "p-ok", name: "OK" }])

    removeBrowserProfile("p-ok")
    expect(getBrowserPrefs().profiles).toEqual([])
    expect(localStorage.getItem("browser:profiles")).toBeNull()
    setBrowserProfiles([{ id: "p-a", name: "A" }])
    expect(getBrowserPrefs().profiles).toEqual([{ id: "p-a", name: "A" }])
  })

  // Two windows: the other one's write has landed in storage but its
  // `storage` event has not been delivered here yet. Adding or removing
  // must build on what is stored, not on this window's stale snapshot.
  it("adds and removes profiles on top of the stored list, not the cached one", () => {
    const work = addBrowserProfile("Work")
    expect(getBrowserPrefs().profiles).toEqual([work])
    localStorage.setItem(
      "browser:profiles",
      JSON.stringify([work, { id: "p-elsewhere", name: "Elsewhere" }])
    )
    const personal = addBrowserProfile("Personal")
    expect(getBrowserPrefs().profiles.map((p) => p.name)).toEqual([
      "Work",
      "Elsewhere",
      "Personal",
    ])
    localStorage.setItem(
      "browser:profiles",
      JSON.stringify([work, personal, { id: "p-late", name: "Late" }])
    )
    removeBrowserProfile(work.id)
    expect(getBrowserPrefs().profiles.map((p) => p.name)).toEqual([
      "Personal",
      "Late",
    ])
  })

  it("resolves the new-tab profile against the list, falling back to the default", () => {
    expect(getBrowserPrefs().newTabProfile).toBe("default")
    const work = addBrowserProfile("Work")
    setBrowserNewTabProfile(work.id)
    expect(localStorage.getItem("browser:new-tab-profile")).toBe(work.id)
    expect(getBrowserPrefs().newTabProfile).toBe(work.id)

    // Deleting the chosen profile: new tabs go back to the default one,
    // with no second write needed.
    removeBrowserProfile(work.id)
    expect(getBrowserPrefs().newTabProfile).toBe("default")

    // A stored id that names no profile (another window deleted it) reads as
    // the default too; the default itself removes the key.
    localStorage.setItem("browser:new-tab-profile", "p-gone")
    resetCacheOnly()
    expect(getBrowserPrefs().newTabProfile).toBe("default")
    setBrowserNewTabProfile("default")
    expect(localStorage.getItem("browser:new-tab-profile")).toBeNull()
  })

  it("stores the sign-in user-agent switch only when turned off", () => {
    expect(getBrowserPrefs().signInUserAgent).toBe(true)
    setBrowserSignInUserAgent(false)
    expect(localStorage.getItem("browser:sign-in-user-agent")).toBe("false")
    expect(getBrowserPrefs().signInUserAgent).toBe(false)
    setBrowserSignInUserAgent(true)
    expect(localStorage.getItem("browser:sign-in-user-agent")).toBeNull()
    expect(getBrowserPrefs().signInUserAgent).toBe(true)
  })

  // Reading and acting is the default, so only the two narrower answers are
  // stored; anything else in the key means the default — including the value
  // a build that had no "share nothing" would have left there.
  it("stores the default sharing level only when it is not the default one", () => {
    expect(getBrowserPrefs().defaultAgentGrant).toBe("control")
    setBrowserDefaultAgentGrant("read")
    expect(localStorage.getItem("browser:default-agent-grant")).toBe("read")
    expect(getBrowserPrefs().defaultAgentGrant).toBe("read")
    setBrowserDefaultAgentGrant("none")
    expect(localStorage.getItem("browser:default-agent-grant")).toBe("none")
    expect(getBrowserPrefs().defaultAgentGrant).toBe("none")
    setBrowserDefaultAgentGrant("control")
    expect(localStorage.getItem("browser:default-agent-grant")).toBeNull()
    expect(getBrowserPrefs().defaultAgentGrant).toBe("control")
    localStorage.setItem("browser:default-agent-grant", "everything")
    resetCacheOnly()
    expect(getBrowserPrefs().defaultAgentGrant).toBe("control")
  })

  // Running without asking is the default — the decision lives on the
  // `browser_eval` tool switch, which ships off — so only the dialog is
  // stored, and anything else in the key means the default.
  it("stores the per-snippet dialog only when it has been asked for", () => {
    expect(getBrowserPrefs().evalApproval).toBe("silent")
    setBrowserEvalApproval("ask")
    expect(localStorage.getItem("browser:eval-approval")).toBe("ask")
    expect(getBrowserPrefs().evalApproval).toBe("ask")
    setBrowserEvalApproval("silent")
    expect(localStorage.getItem("browser:eval-approval")).toBeNull()
    expect(getBrowserPrefs().evalApproval).toBe("silent")

    for (const junk of ["", "Ask", "true", "confirm"]) {
      localStorage.setItem("browser:eval-approval", junk)
      resetCacheOnly()
      expect(getBrowserPrefs().evalApproval).toBe("silent")
    }
  })

  // The cached snapshot is only dropped when a `storage` event is DELIVERED,
  // which is later than the other window's write and conditional on somebody
  // being subscribed at that moment. The one reader that answers on a
  // person's behalf must not be behind by either of those.
  it("reads the eval answer past the cache, unlike the snapshot", () => {
    expect(getBrowserPrefs().evalApproval).toBe("silent")
    // Written the way another window writes it, with nothing dispatched and
    // nobody subscribed to hear it.
    localStorage.setItem("browser:eval-approval", "ask")

    expect(getBrowserPrefs().evalApproval).toBe("silent") // snapshot: stale
    expect(readBrowserEvalApprovalNow()).toBe("ask") // storage: current

    localStorage.removeItem("browser:eval-approval")
    expect(readBrowserEvalApprovalNow()).toBe("silent")
  })

  // Notifying is the default (VS Code's too), so only the two other answers
  // are stored; anything else in the key means the default.
  it("stores the local-server mode only when it is not the default one", () => {
    expect(getBrowserPrefs().serviceAutoOpen).toBe("notify")
    setBrowserServiceAutoOpen("open")
    expect(localStorage.getItem("browser:service-auto-open")).toBe("open")
    expect(getBrowserPrefs().serviceAutoOpen).toBe("open")
    setBrowserServiceAutoOpen("off")
    expect(localStorage.getItem("browser:service-auto-open")).toBe("off")
    expect(getBrowserPrefs().serviceAutoOpen).toBe("off")
    setBrowserServiceAutoOpen("notify")
    expect(localStorage.getItem("browser:service-auto-open")).toBeNull()
    expect(getBrowserPrefs().serviceAutoOpen).toBe("notify")
    localStorage.setItem("browser:service-auto-open", "sometimes")
    resetCacheOnly()
    expect(getBrowserPrefs().serviceAutoOpen).toBe("notify")
  })

  it("useBrowserPrefs re-renders on change", () => {
    const { result } = renderHook(() => useBrowserPrefs())
    expect(result.current.defaultTarget.toolCard).toBe("builtin")
    act(() => {
      setDefaultLinkTarget("toolCard", "system")
    })
    expect(result.current.defaultTarget.toolCard).toBe("system")
  })
})
