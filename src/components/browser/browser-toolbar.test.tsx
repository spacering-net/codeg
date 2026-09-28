import { describe, expect, it } from "vitest"

import { normalizeTypedAddress } from "./browser-toolbar"

describe("normalizeTypedAddress", () => {
  it("keeps full http(s) URLs and normalizes them", () => {
    expect(normalizeTypedAddress("  https://Example.com/a b ")).toBe(
      "https://example.com/a%20b"
    )
    expect(normalizeTypedAddress("http://localhost:3000")).toBe(
      "http://localhost:3000/"
    )
  })

  it("adds a scheme to bare hosts: http for local, https otherwise", () => {
    expect(normalizeTypedAddress("localhost:3000/app")).toBe(
      "http://localhost:3000/app"
    )
    expect(normalizeTypedAddress("127.0.0.1:8080")).toBe(
      "http://127.0.0.1:8080/"
    )
    expect(normalizeTypedAddress("192.168.1.5")).toBe("http://192.168.1.5/")
    expect(normalizeTypedAddress("example.com/docs?x=1")).toBe(
      "https://example.com/docs?x=1"
    )
  })

  it("refuses other schemes, words and blanks (no search fallback)", () => {
    expect(normalizeTypedAddress("javascript:alert(1)")).toBeNull()
    expect(normalizeTypedAddress("file:///etc/hosts")).toBeNull()
    expect(normalizeTypedAddress("hello world")).toBeNull()
    expect(normalizeTypedAddress("notes")).toBeNull()
    expect(normalizeTypedAddress("")).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// The profile chip and its menu
// ---------------------------------------------------------------------------

import { act, fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, beforeEach, vi } from "vitest"

import type { BrowserWorkspaceTab } from "@/contexts/workspace-context"
import enMessages from "@/i18n/messages/en.json"
import {
  browserNavigate,
  browserOpenDevtools,
  browserReload,
  browserStop,
} from "@/lib/browser/browser-api"
import {
  resetBrowserPrefsForTests,
  setBrowserDevtools,
  setBrowserProfiles,
} from "@/lib/browser/browser-prefs"
import {
  recordBrowserAgentActivity,
  resetBrowserTabStoreForTests,
} from "@/lib/browser/browser-tab-store"
import type { BrowserTabState } from "@/lib/browser/types"

import { openUrl } from "@/lib/platform"

import { BrowserToolbar } from "./browser-toolbar"

const toolbarMocks = vi.hoisted(() => ({
  remoteDesktop: false,
  openBrowserTab: vi.fn(() => "browser:new"),
  workspaceActions: null as null | {
    openBrowserTab: (...a: unknown[]) => unknown
  },
}))

vi.mock("@/contexts/workspace-context", () => ({
  useOptionalWorkspaceActions: () => toolbarMocks.workspaceActions,
}))
vi.mock("@/lib/browser/browser-api", () => ({
  // The toolbar also carries the agent share control.
  browserAgentGrant: vi.fn(() => Promise.resolve()),
  browserGoBack: vi.fn(),
  browserGoForward: vi.fn(),
  browserNavigate: vi.fn(() => Promise.resolve()),
  browserOpenDevtools: vi.fn(() => Promise.resolve()),
  browserReload: vi.fn(() => Promise.resolve()),
  browserStop: vi.fn(() => Promise.resolve()),
  // …and the hand-off control, which asks the tab for its console when its
  // own menu opens.
  browserPageCapture: vi.fn(),
  browserPageConsole: vi.fn(() => Promise.resolve({ count: 0 })),
  browserPickCancel: vi.fn(),
  browserPickElement: vi.fn(),
}))
vi.mock("@/lib/platform", () => ({ openUrl: vi.fn() }))
vi.mock(import("@/lib/transport"), async (importOriginal) => ({
  ...(await importOriginal()),
  isRemoteDesktopMode: () => toolbarMocks.remoteDesktop,
}))

function tabIn(
  profile: string,
  initialUrl = "https://example.com/"
): BrowserWorkspaceTab {
  return {
    id: "browser:abc",
    kind: "browser",
    folderId: 1,
    title: "example.com",
    description: null,
    path: null,
    language: "browser",
    content: "",
    loading: false,
    readonly: true,
    browser: { initialUrl, openerTabId: null, profile },
  } as BrowserWorkspaceTab
}

function renderToolbar(
  profile: string,
  initialUrl?: string,
  state: BrowserTabState | null = null
) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <BrowserToolbar tab={tabIn(profile, initialUrl)} state={state} />
    </NextIntlClientProvider>
  )
}

/** A loaded page on a tab that has been shared with agents for reading. */
function sharedState(): BrowserTabState {
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
    agentGrant: {
      level: "read",
      origin: "https://example.com",
      grantedAt: 1,
    },
  }
}

// jsdom has no `PointerEvent`; Radix reads `button` off the event, so a real
// `MouseEvent` under the pointer-event name is what opens the menu.
function fireMouse(target: Element, type: string) {
  fireEvent(
    target,
    new MouseEvent(type, { bubbles: true, cancelable: true, button: 0 })
  )
}

async function openMenu(trigger: Element) {
  await act(async () => {
    fireMouse(trigger, "pointerdown")
    fireMouse(trigger, "pointerup")
    fireMouse(trigger, "click")
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

describe("BrowserToolbar profile chip", () => {
  beforeEach(() => {
    resetBrowserPrefsForTests()
    // The store is module state: without this, what one case records about a
    // tab is still there for the next one.
    resetBrowserTabStoreForTests()
    toolbarMocks.openBrowserTab.mockClear()
    toolbarMocks.workspaceActions = {
      openBrowserTab: toolbarMocks.openBrowserTab,
    }
  })

  it("stays out of the way while only the default profile exists", () => {
    renderToolbar("default")
    expect(screen.queryByRole("button", { name: /^Profile:/ })).toBeNull()
  })

  it("names the tab's profile and opens the page in another one from the menu", async () => {
    setBrowserProfiles([{ id: "p-work", name: "Work" }])
    renderToolbar("p-work")
    const chip = screen.getByRole("button", { name: "Profile: Work" })
    expect(chip).toHaveTextContent("Work")

    await openMenu(chip)
    expect(screen.getByText("Open this page in another profile")).toBeVisible()
    const items = screen.getAllByRole("menuitemradio")
    expect(items.map((item) => item.textContent)).toEqual(["Default", "Work"])
    expect(items[1]).toHaveAttribute("aria-checked", "true")

    await act(async () => {
      fireEvent.click(items[0])
    })
    expect(toolbarMocks.openBrowserTab).toHaveBeenCalledWith(
      "https://example.com/",
      { profile: "default", openerTabId: "browser:abc" }
    )
  })

  it("leaves an empty tab's address bar blank, focused, and its address actions off", () => {
    renderToolbar("default", "about:blank")
    const bar = screen.getByRole("textbox", { name: "Enter an address" })
    // `about:blank` is the absence of a page, not an address anyone typed —
    // showing it would mean selecting-and-overtyping it on every visit.
    expect(bar).toHaveValue("")
    expect(bar).toHaveFocus()
    // Every item behind "More" acts on the address, and there is none.
    expect(screen.getByRole("button", { name: "More" })).toBeDisabled()
  })

  it("leaves a real address in the bar and does not steal focus", () => {
    renderToolbar("default")
    const bar = screen.getByRole("textbox", { name: "Enter an address" })
    expect(bar).toHaveValue("https://example.com/")
    expect(bar).not.toHaveFocus()
    expect(screen.getByRole("button", { name: "More" })).toBeEnabled()
  })

  it("keeps copy and open-in-system behind the More menu, not on the row", async () => {
    renderToolbar("default")
    // The row itself is down to the controls used while browsing; these two
    // act on the address and cost a click.
    expect(screen.queryByRole("button", { name: "Copy link" })).toBeNull()
    expect(
      screen.queryByRole("button", { name: "Open in system browser" })
    ).toBeNull()

    await openMenu(screen.getByRole("button", { name: "More" }))
    expect(
      await screen.findByRole("menuitem", { name: "Copy link" })
    ).toBeVisible()
    await act(async () => {
      fireEvent.click(
        screen.getByRole("menuitem", { name: "Open in system browser" })
      )
    })
    expect(vi.mocked(openUrl)).toHaveBeenCalledWith("https://example.com/")
  })

  // The inspector is on by default, so the item is there without anyone
  // having gone looking for a setting — which is the point of the default.
  it("opens the inspector from the More menu", async () => {
    renderToolbar("default")
    await openMenu(screen.getByRole("button", { name: "More" }))
    await act(async () => {
      fireEvent.click(screen.getByRole("menuitem", { name: "Open inspector" }))
    })
    expect(vi.mocked(browserOpenDevtools)).toHaveBeenCalledWith("abc")
  })

  // Hidden rather than disabled: somebody who switched the inspector off said
  // they do not want it, and a greyed row repeating that is not agreement.
  it("leaves the inspector out of the menu when the switch is off", async () => {
    act(() => setBrowserDevtools(false))
    renderToolbar("default")
    await openMenu(screen.getByRole("button", { name: "More" }))
    expect(
      await screen.findByRole("menuitem", { name: "Copy link" })
    ).toBeVisible()
    expect(
      screen.queryByRole("menuitem", { name: "Open inspector" })
    ).toBeNull()
  })

  it("shows the chip for a tab whose profile is gone, and cannot open elsewhere without a workspace", async () => {
    toolbarMocks.workspaceActions = null
    renderToolbar("p-gone")
    const chip = screen.getByRole("button", { name: "Profile: p-gone" })
    await openMenu(chip)
    const items = screen.getAllByRole("menuitemradio")
    expect(items.map((item) => item.textContent)).toEqual(["Default", "p-gone"])
    // Nothing to open a tab with: the other profiles are inert.
    expect(items[0]).toHaveAttribute("aria-disabled", "true")
    await act(async () => {
      fireEvent.click(items[0])
    })
    expect(toolbarMocks.openBrowserTab).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Selecting the address
// ---------------------------------------------------------------------------

describe("BrowserToolbar address selection", () => {
  const ADDRESS = "https://example.com/"

  beforeEach(() => {
    resetBrowserPrefsForTests()
    toolbarMocks.workspaceActions = {
      openBrowserTab: toolbarMocks.openBrowserTab,
    }
  })

  function addressBar(): HTMLInputElement {
    return screen.getByRole("textbox", {
      name: "Enter an address",
    }) as HTMLInputElement
  }

  function selection(input: HTMLInputElement) {
    return [input.selectionStart, input.selectionEnd]
  }

  it("selects the whole address whenever the bar takes focus", () => {
    renderToolbar("default")
    const bar = addressBar()
    act(() => bar.focus())
    expect(selection(bar)).toEqual([0, ADDRESS.length])
  })

  it("keeps the address selected through the click that focused it", () => {
    renderToolbar("default")
    const bar = addressBar()
    fireEvent.mouseDown(bar, { clientX: 120, clientY: 20 })
    act(() => bar.focus())
    // jsdom runs no selection default of its own. Stand in for the engine's:
    // it collapses to where the pointer landed, and it runs on the release
    // AFTER this handler, so cancelling the release is the only thing that
    // stops it — hence the `false` below.
    bar.setSelectionRange(8, 8)
    const delivered = fireEvent.mouseUp(bar, { clientX: 121, clientY: 20 })
    expect(delivered).toBe(false)
    expect(selection(bar)).toEqual([0, ADDRESS.length])
  })

  it("keeps its hands off a non-primary press", () => {
    renderToolbar("default")
    const bar = addressBar()
    // A right press is not a click. Cancelling its release would take the
    // context menu with it wherever one is raised from the release (and the
    // X11 middle-click paste, for button 1).
    fireEvent.mouseDown(bar, { clientX: 60, clientY: 20, button: 2 })
    act(() => bar.focus())
    bar.setSelectionRange(8, 8)
    expect(
      fireEvent.mouseUp(bar, { clientX: 60, clientY: 20, button: 2 })
    ).toBe(true)
    expect(selection(bar)).toEqual([8, 8])
  })

  it("does not let a press outlive its own gesture", () => {
    renderToolbar("default")
    const bar = addressBar()
    // Press inside, drag out, release outside: the input never sees a
    // mouseup, so the armed press has to be cleared by the NEXT press rather
    // than survive to cancel someone else's release.
    fireEvent.mouseDown(bar, { clientX: 60, clientY: 20 })
    act(() => bar.focus())
    bar.setSelectionRange(2, 9)
    fireEvent.mouseDown(bar, { clientX: 60, clientY: 20, button: 2 })
    expect(
      fireEvent.mouseUp(bar, { clientX: 60, clientY: 20, button: 2 })
    ).toBe(true)
    expect(selection(bar)).toEqual([2, 9])
  })

  it("leaves a dragged-out range, and a caret click once it has focus, alone", () => {
    renderToolbar("default")
    const bar = addressBar()
    // Dragging picks a range deliberately — that is the user's answer, and
    // the engine's own selection has to reach it.
    fireEvent.mouseDown(bar, { clientX: 60, clientY: 20 })
    act(() => bar.focus())
    bar.setSelectionRange(8, 19)
    expect(fireEvent.mouseUp(bar, { clientX: 140, clientY: 20 })).toBe(true)
    expect(selection(bar)).toEqual([8, 19])

    // And a click inside a bar that already has focus means "edit here".
    bar.setSelectionRange(8, 8)
    fireEvent.mouseDown(bar, { clientX: 60, clientY: 20 })
    expect(fireEvent.mouseUp(bar, { clientX: 60, clientY: 20 })).toBe(true)
    expect(selection(bar)).toEqual([8, 8])
  })
})

// ---------------------------------------------------------------------------
// Asking for the page again
// ---------------------------------------------------------------------------

describe("BrowserToolbar and the agent activity record", () => {
  beforeEach(() => {
    resetBrowserPrefsForTests()
    resetBrowserTabStoreForTests()
    vi.mocked(browserReload).mockClear()
    vi.mocked(browserStop).mockClear()
    vi.mocked(browserNavigate).mockClear()
    toolbarMocks.workspaceActions = {
      openBrowserTab: toolbarMocks.openBrowserTab,
    }
  })
  afterEach(() => resetBrowserTabStoreForTests())

  function touched() {
    act(() =>
      recordBrowserAgentActivity({
        tabId: "abc",
        action: "read",
        outcome: "done",
        at: 1_700_000_000_000,
      })
    )
  }

  function record() {
    return screen.queryByRole("button", { name: /^Agent activity/ })
  }

  // The lines describe attempts on the document that is being replaced, so
  // asking for the page again starts the record again. The grant does not go
  // with them: it is bound to the origin and survives a reload of it, and
  // taking it away here would revoke access nobody took back.
  it("forgets what agents did on a reload, and keeps the tab shared", async () => {
    renderToolbar("default", undefined, sharedState())
    touched()
    expect(record()).toBeInTheDocument()

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Reload" }))
    })
    expect(vi.mocked(browserReload)).toHaveBeenCalledWith("abc")
    expect(record()).toBeNull()
    expect(
      screen.getByRole("button", { name: "Agents can read example.com" })
    ).toBeVisible()
  })

  it("forgets them for an address entered in the bar too", async () => {
    renderToolbar("default", undefined, sharedState())
    touched()
    const bar = screen.getByRole("textbox", { name: "Enter an address" })
    await act(async () => {
      fireEvent.change(bar, { target: { value: "example.com/next" } })
      fireEvent.keyDown(bar, { key: "Enter" })
    })
    expect(vi.mocked(browserNavigate)).toHaveBeenCalledWith(
      "abc",
      "https://example.com/next"
    )
    expect(record()).toBeNull()
  })

  // Stopping a load is the opposite of asking for the page again: the
  // document on screen is the one those lines are about, and it stays.
  it("keeps them when the button is stopping a load rather than starting one", async () => {
    renderToolbar("default", undefined, { ...sharedState(), loading: true })
    touched()
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Stop" }))
    })
    expect(vi.mocked(browserStop)).toHaveBeenCalledWith("abc")
    expect(record()).toBeInTheDocument()
  })

  // The clear waits for the backend to take the request. A tab whose surface
  // has gone refuses it, and then the document those lines are about is still
  // the one on screen.
  it("keeps them when the backend refuses the reload or the address", async () => {
    vi.mocked(browserReload).mockRejectedValueOnce(new Error("no surface"))
    vi.mocked(browserNavigate).mockRejectedValueOnce(new Error("no surface"))
    renderToolbar("default", undefined, sharedState())
    touched()

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Reload" }))
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(record()).toBeInTheDocument()

    const bar = screen.getByRole("textbox", { name: "Enter an address" })
    await act(async () => {
      fireEvent.change(bar, { target: { value: "example.com/next" } })
      fireEvent.keyDown(bar, { key: "Enter" })
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(vi.mocked(browserNavigate)).toHaveBeenCalled()
    expect(record()).toBeInTheDocument()
  })

  // A bar with nothing in it, or something that is not an address, never
  // reaches the backend — and must not take the record with it either.
  it("keeps them when Enter does not navigate anywhere", async () => {
    renderToolbar("default", "about:blank", {
      ...sharedState(),
      url: "about:blank",
      requestedUrl: "about:blank",
    })
    touched()
    const bar = screen.getByRole("textbox", { name: "Enter an address" })
    await act(async () => {
      fireEvent.keyDown(bar, { key: "Enter" })
    })
    await act(async () => {
      fireEvent.change(bar, { target: { value: "not an address" } })
      fireEvent.keyDown(bar, { key: "Enter" })
    })
    expect(vi.mocked(browserNavigate)).not.toHaveBeenCalled()
    expect(record()).toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// A window bound to a remote codeg-server
// ---------------------------------------------------------------------------

describe("BrowserToolbar in a remote workspace window", () => {
  beforeEach(() => {
    resetBrowserPrefsForTests()
    resetBrowserTabStoreForTests()
    vi.mocked(browserNavigate).mockClear()
    toolbarMocks.openBrowserTab.mockClear()
    toolbarMocks.workspaceActions = {
      openBrowserTab: toolbarMocks.openBrowserTab,
    }
    toolbarMocks.remoteDesktop = true
  })
  afterEach(() => {
    toolbarMocks.remoteDesktop = false
    resetBrowserTabStoreForTests()
  })

  function unsharedState(): BrowserTabState {
    return { ...sharedState(), agentGrant: null }
  }

  // This tab is a page of THIS computer; typed here, `localhost:3000` would
  // reach this machine instead of the host the workspace runs on.
  it("opens a typed loopback address as a tab of the remote host", async () => {
    renderToolbar("default", undefined, unsharedState())
    const bar = screen.getByRole("textbox", { name: "Enter an address" })
    await act(async () => {
      fireEvent.change(bar, { target: { value: "localhost:3000/app" } })
      fireEvent.keyDown(bar, { key: "Enter" })
    })
    expect(toolbarMocks.openBrowserTab).toHaveBeenCalledWith(
      "http://localhost:3000/app",
      { remote: true, openerTabId: "browser:abc" }
    )
    expect(vi.mocked(browserNavigate)).not.toHaveBeenCalled()
    // The bar goes back to what this tab is showing.
    expect(bar).toHaveValue("https://example.com/")
  })

  // With no tab strip to open a remote tab in, the address goes nowhere —
  // never into this tab, where it would reach this computer.
  it("refuses a typed loopback address when there is nowhere to open it", async () => {
    toolbarMocks.workspaceActions = null
    renderToolbar("default", undefined, unsharedState())
    const bar = screen.getByRole("textbox", { name: "Enter an address" })
    await act(async () => {
      fireEvent.change(bar, { target: { value: "127.0.0.1:8080" } })
      fireEvent.keyDown(bar, { key: "Enter" })
    })
    expect(vi.mocked(browserNavigate)).not.toHaveBeenCalled()
  })

  it("navigates a typed public address in place, as anywhere else", async () => {
    renderToolbar("default", undefined, unsharedState())
    const bar = screen.getByRole("textbox", { name: "Enter an address" })
    await act(async () => {
      fireEvent.change(bar, { target: { value: "example.com/next" } })
      fireEvent.keyDown(bar, { key: "Enter" })
    })
    expect(vi.mocked(browserNavigate)).toHaveBeenCalledWith(
      "abc",
      "https://example.com/next"
    )
    expect(toolbarMocks.openBrowserTab).not.toHaveBeenCalled()
  })

  describe("on a tab of the remote host", () => {
    function renderRemoteTab(url = "http://remote.localhost:3000/app") {
      const remoteTab = {
        ...tabIn("default", url),
        browser: {
          initialUrl: url,
          openerTabId: null,
          profile: "default",
          remote: true,
        },
      } as BrowserWorkspaceTab
      return render(
        <NextIntlClientProvider locale="en" messages={enMessages}>
          <BrowserToolbar
            tab={remoteTab}
            state={{ ...unsharedState(), url, profile: "remote-4" }}
          />
        </NextIntlClientProvider>
      )
    }

    // Everything a remote tab loads comes from the remote host: another of
    // its addresses is simply where this tab goes next.
    it("navigates a typed loopback address in place", async () => {
      renderRemoteTab()
      const bar = screen.getByRole("textbox", { name: "Enter an address" })
      await act(async () => {
        fireEvent.change(bar, { target: { value: "localhost:5173" } })
        fireEvent.keyDown(bar, { key: "Enter" })
      })
      expect(vi.mocked(browserNavigate)).toHaveBeenCalledWith(
        "abc",
        "http://localhost:5173/"
      )
      expect(toolbarMocks.openBrowserTab).not.toHaveBeenCalled()
    })

    it("has no profile to choose and no system browser to hand the page to", async () => {
      setBrowserProfiles([{ id: "p-work", name: "Work" }])
      renderRemoteTab()
      expect(screen.queryByRole("button", { name: /^Profile:/ })).toBeNull()
      await openMenu(screen.getByRole("button", { name: "More" }))
      expect(
        await screen.findByRole("menuitem", { name: "Copy link" })
      ).toBeVisible()
      expect(
        screen.queryByRole("menuitem", { name: "Open in system browser" })
      ).toBeNull()
    })

    // The macOS alias names nothing outside this tab.
    it("copies the link as the remote host knows it", async () => {
      const copied = vi.fn()
      Object.assign(navigator, { clipboard: { writeText: copied } })
      copied.mockResolvedValue(undefined)
      renderRemoteTab("http://remote.localhost:3000/app?x=1")
      await openMenu(screen.getByRole("button", { name: "More" }))
      await act(async () => {
        fireEvent.click(
          await screen.findByRole("menuitem", { name: "Copy link" })
        )
      })
      expect(copied).toHaveBeenCalledWith("http://localhost:3000/app?x=1")
    })
  })

  // Its agents run on the remote host and cannot reach this browser.
  it("offers no sharing with agents, and says why", () => {
    renderToolbar("default", undefined, unsharedState())
    const share = screen.getByRole("button", { name: "Share with agents" })
    expect(share).toBeDisabled()
    expect(share).toHaveAttribute(
      "title",
      "Agents of a remote workspace run on its host and can't use this computer's browser"
    )
  })
})
