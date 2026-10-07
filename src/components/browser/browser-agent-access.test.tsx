import { act, fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { BrowserWorkspaceTab } from "@/contexts/workspace-context"
import enMessages from "@/i18n/messages/en.json"
import type { BrowserTabState } from "@/lib/browser/types"

const mocks = vi.hoisted(() => ({
  browserAgentGrant: vi.fn(() => Promise.resolve({}) as Promise<unknown>),
  success: vi.fn(),
  error: vi.fn(),
}))
vi.mock("@/lib/browser/browser-api", () => ({
  browserAgentGrant: mocks.browserAgentGrant,
}))
vi.mock("sonner", () => ({
  toast: { success: mocks.success, error: mocks.error },
}))

import {
  resetBrowserPrefsForTests,
  setBrowserDefaultAgentGrant,
} from "@/lib/browser/browser-prefs"
import {
  recordBrowserAgentActivity,
  resetBrowserTabStoreForTests,
} from "@/lib/browser/browser-tab-store"

import {
  BrowserAgentActivityControl,
  BrowserAgentShareControl,
} from "./browser-agent-access"

const tab = {
  id: "browser:abc",
  kind: "browser",
  folderId: 1,
  title: "example.com",
  browser: {
    initialUrl: "https://example.com/",
    openerTabId: null,
    profile: "default",
  },
} as BrowserWorkspaceTab

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

function wrap(node: React.ReactNode) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      {node}
    </NextIntlClientProvider>
  )
}

function read(
  over: Partial<Parameters<typeof recordBrowserAgentActivity>[0]> = {}
) {
  act(() =>
    recordBrowserAgentActivity({
      tabId: "abc",
      action: "read",
      outcome: "done",
      at: 1_700_000_000_000,
      ...over,
    })
  )
}

// jsdom has no `PointerEvent`; Radix reads `button` off the event.
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

describe("the share control", () => {
  beforeEach(() => {
    resetBrowserTabStoreForTests()
    resetBrowserPrefsForTests()
    mocks.browserAgentGrant.mockClear()
    mocks.success.mockClear()
    mocks.error.mockClear()
  })
  afterEach(() => {
    resetBrowserTabStoreForTests()
    resetBrowserPrefsForTests()
  })

  it("offers the two levels, and says which site the page was handed over at", async () => {
    wrap(<BrowserAgentShareControl tab={tab} state={state()} />)
    const button = screen.getByRole("button", { name: "Share with agents" })
    expect(button).not.toBeDisabled()
    await openMenu(button)
    await act(async () => {
      fireEvent.click(screen.getByRole("menuitem", { name: /Read only/ }))
      await Promise.resolve()
    })
    expect(mocks.browserAgentGrant).toHaveBeenCalledWith("abc", "read")
    expect(mocks.success).toHaveBeenCalledWith(
      "Agents can now read example.com"
    )
  })

  // Acting is the second decision, made in the same place as the first — and
  // the toast says which one was made.
  it("hands the page over for acting from the same menu", async () => {
    wrap(<BrowserAgentShareControl tab={tab} state={state()} />)
    await openMenu(screen.getByRole("button", { name: "Share with agents" }))
    await act(async () => {
      fireEvent.click(screen.getByRole("menuitem", { name: /Read and act/ }))
      await Promise.resolve()
    })
    expect(mocks.browserAgentGrant).toHaveBeenCalledWith("abc", "control")
    expect(mocks.success).toHaveBeenCalledWith(
      "Agents can now read and act on example.com"
    )
  })

  // Being the default is being the entry the menu opens onto — first in the
  // list, where the pointer already is and where a keyboard lands — and being
  // marked as such, since "read and act" above "read" inverts the usual
  // narrowest-first order. Nothing is shared by either of them until pressed.
  it("opens onto the default level, and says which one that is", async () => {
    const { unmount } = wrap(
      <BrowserAgentShareControl tab={tab} state={state()} />
    )
    await openMenu(screen.getByRole("button", { name: "Share with agents" }))
    const items = () =>
      screen.getAllByRole("menuitem").map((item) => item.textContent)
    expect(items()).toEqual(["Read and actDefault", "Read only"])
    expect(mocks.browserAgentGrant).not.toHaveBeenCalled()
    unmount()

    setBrowserDefaultAgentGrant("read")
    const second = wrap(<BrowserAgentShareControl tab={tab} state={state()} />)
    await openMenu(screen.getByRole("button", { name: "Share with agents" }))
    expect(items()).toEqual(["Read onlyDefault", "Read and act"])
    second.unmount()

    // With nothing shared by default there is no near entry to mark: the
    // menu is the only way anything is shared, narrowest first.
    setBrowserDefaultAgentGrant("none")
    wrap(<BrowserAgentShareControl tab={tab} state={state()} />)
    await openMenu(screen.getByRole("button", { name: "Share with agents" }))
    expect(items()).toEqual(["Read only", "Read and act"])
  })

  // A tab with no web origin cannot be shared at all — the grant is a binding
  // to one site, and there is nothing here to bind to. Refused up front
  // rather than discovered through an error.
  it("is inert on a page with no web address", () => {
    wrap(
      <BrowserAgentShareControl
        tab={tab}
        state={state({ url: "about:blank", origin: null })}
      />
    )
    const button = screen.getByRole("button", { name: "Share with agents" })
    expect(button).toBeDisabled()
    expect(button).toHaveAttribute(
      "title",
      "This page has no web address to share with agents"
    )
  })

  // A document guest shows a local file, and its address does not give that
  // away: WebView2 serves it from `https://codeg-doc.localhost/…`. The
  // backend refuses to bind a grant to one; the control has to agree, or it
  // would offer a share that can only ever fail.
  it("is inert on a document guest, whose address looks like any other site", () => {
    wrap(
      <BrowserAgentShareControl
        tab={tab}
        state={state({
          kind: "document",
          url: "https://codeg-doc.localhost/report.html",
          origin: "https://codeg-doc.localhost",
        })}
      />
    )
    expect(
      screen.getByRole("button", { name: "Share with agents" })
    ).toBeDisabled()
  })

  it("names the shared site and takes it back from the menu", async () => {
    wrap(
      <BrowserAgentShareControl
        tab={tab}
        state={state({
          agentGrant: {
            level: "read",
            origin: "https://example.com",
            grantedAt: 1,
          },
        })}
      />
    )
    const chip = screen.getByRole("button", {
      name: "Agents can read example.com",
    })
    expect(chip).toHaveTextContent("Shared")
    await openMenu(chip)
    expect(
      screen.getByText("Sharing ends as soon as the page leaves this site.")
    ).toBeVisible()
    await act(async () => {
      fireEvent.click(screen.getByRole("menuitem", { name: "Stop sharing" }))
    })
    expect(mocks.browserAgentGrant).toHaveBeenCalledWith("abc", "none")
    // Taking access back is not an event worth congratulating anyone over.
    expect(mocks.success).not.toHaveBeenCalled()
  })

  // A read-only share can be widened to acting, and an acting share pulled
  // back to reading, without ending it — and the chip says which it is.
  it("moves a shared tab between reading and acting from its menu", async () => {
    const { unmount } = wrap(
      <BrowserAgentShareControl
        tab={tab}
        state={state({
          agentGrant: {
            level: "read",
            origin: "https://example.com",
            grantedAt: 1,
          },
        })}
      />
    )
    await openMenu(
      screen.getByRole("button", { name: "Agents can read example.com" })
    )
    expect(
      screen.queryByRole("menuitem", { name: "Reading only" })
    ).not.toBeInTheDocument()
    await act(async () => {
      fireEvent.click(
        screen.getByRole("menuitem", { name: "Allow actions on this page" })
      )
      await Promise.resolve()
    })
    expect(mocks.browserAgentGrant).toHaveBeenCalledWith("abc", "control")
    unmount()

    wrap(
      <BrowserAgentShareControl
        tab={tab}
        state={state({
          agentGrant: {
            level: "control",
            origin: "https://example.com",
            grantedAt: 1,
          },
        })}
      />
    )
    const chip = screen.getByRole("button", {
      name: "Agents can read and act on example.com",
    })
    expect(chip).toHaveTextContent("Shared · can act")
    await openMenu(chip)
    expect(
      screen.queryByRole("menuitem", { name: "Allow actions on this page" })
    ).not.toBeInTheDocument()
    await act(async () => {
      fireEvent.click(screen.getByRole("menuitem", { name: "Reading only" }))
      await Promise.resolve()
    })
    expect(mocks.browserAgentGrant).toHaveBeenLastCalledWith("abc", "read")
  })

  // For a loopback address the site is not the whole boundary — the port can
  // change hands under a page that never moved — so the menu has to say what
  // the grant is actually pinned to, before the notice that names it.
  it("names the program a loopback grant is pinned to", async () => {
    wrap(
      <BrowserAgentShareControl
        tab={tab}
        state={state({
          origin: "http://localhost:3000",
          agentGrant: {
            level: "read",
            origin: "http://localhost:3000",
            grantedAt: 1,
            listener: {
              program: "/usr/local/bin/node",
              workdir: "/home/dev/project",
            },
          },
        })}
      />
    )
    await openMenu(
      screen.getByRole("button", { name: "Agents can read localhost:3000" })
    )
    expect(
      screen.getByText(
        "It also ends if another program takes this port from node."
      )
    ).toBeVisible()
  })

  // A real site cannot be taken over by a local process, so there is nothing
  // to pin and nothing to warn about.
  it("says nothing about programs for a grant on a real site", async () => {
    wrap(
      <BrowserAgentShareControl
        tab={tab}
        state={state({
          agentGrant: {
            level: "read",
            origin: "https://example.com",
            grantedAt: 1,
          },
        })}
      />
    )
    await openMenu(
      screen.getByRole("button", { name: "Agents can read example.com" })
    )
    expect(screen.queryByText(/takes this port/)).not.toBeInTheDocument()
  })

  it("reports a refused share instead of silently doing nothing", async () => {
    mocks.browserAgentGrant.mockImplementationOnce(() =>
      Promise.reject(new Error("no origin"))
    )
    wrap(<BrowserAgentShareControl tab={tab} state={state()} />)
    await openMenu(screen.getByRole("button", { name: "Share with agents" }))
    await act(async () => {
      fireEvent.click(screen.getByRole("menuitem", { name: /Read only/ }))
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(mocks.error).toHaveBeenCalledWith(
      "This page can't be shared with agents",
      expect.objectContaining({
        description: expect.stringContaining("no origin"),
      })
    )
  })
})

describe("the activity record", () => {
  beforeEach(() => resetBrowserTabStoreForTests())
  afterEach(() => resetBrowserTabStoreForTests())

  // Nothing has touched the tab, so there is nothing to say — and, unlike the
  // band this replaced, nothing takes room in the address field either.
  it("is absent until an agent has done something", () => {
    const { container } = wrap(<BrowserAgentActivityControl tab={tab} />)
    expect(container).toBeEmptyDOMElement()
  })

  // The one case nothing else in the app reports: only the agent is told it
  // was refused. From the closed control the mark is all there is, so the
  // refusal has to reach the glyph — and say so in the one string that is
  // both the tooltip and the accessible name.
  it("shows a refusal on a tab nobody shared", async () => {
    read({ outcome: "refused" })
    wrap(<BrowserAgentActivityControl tab={tab} />)
    const button = screen.getByRole("button", {
      name: "Agent activity: Refused: this page isn't shared",
    })
    expect(button.className).toContain("text-amber-600")
    expect(button).toHaveAttribute(
      "title",
      "Agent activity: Refused: this page isn't shared"
    )
    await openMenu(button)
    expect(screen.getByText(/Refused: this page isn't shared/)).toBeVisible()
  })

  // A plain read leaves the glyph alone: the mark means "something went other
  // than asked", and an agent reading a page it was given did not.
  it("stays quiet when everything an agent did was allowed", () => {
    read()
    wrap(<BrowserAgentActivityControl tab={tab} />)
    expect(
      screen.getByRole("button", { name: "Agent activity: Read the page" })
        .className
    ).not.toContain("text-amber-600")
  })

  // The mark follows the newest line that did NOT go as asked, not the newest
  // line. Sharing the page after a refusal and letting the agent read it
  // would otherwise take the mark back off while the refusal was still in the
  // list — and nothing else in the app ever mentions that refusal.
  it("keeps the mark up after a refusal is followed by a success", () => {
    read({ at: 1, action: "click", outcome: "refused" })
    read({ at: 2 })
    wrap(<BrowserAgentActivityControl tab={tab} />)
    const button = screen.getByRole("button", {
      name: /Refused to click: actions aren't allowed on this page/,
    })
    expect(button.className).toContain("text-amber-600")
  })

  // Each kind of touch is its own line, in its own words, so a run of clicks
  // does not swallow the keystroke among them — and a refused action says
  // what was refused, which is not the same sentence as a refused read. All
  // of them are in the one list: there is no top line and no disclosure.
  it("names each kind of action, done or refused", async () => {
    read({ at: 1, action: "click" })
    read({ at: 2, action: "type" })
    read({ at: 3, action: "select", outcome: "failed" })
    read({ at: 4, action: "press", outcome: "refused" })
    read({ at: 5, action: "capture" })
    read({ at: 6, action: "console", outcome: "refused" })
    wrap(<BrowserAgentActivityControl tab={tab} />)
    await openMenu(screen.getByRole("button", { name: /^Agent activity:/ }))
    // The two reads that are not a snapshot say what was read — a refused
    // console read is not the same sentence as a refused page read.
    expect(
      screen.getByText(/Refused to read the console: this page isn't shared/)
    ).toBeVisible()
    expect(screen.getByText(/Took a screenshot/)).toBeVisible()
    expect(
      screen.getByText(/Refused to press a key: actions aren't allowed/)
    ).toBeVisible()
    expect(screen.getByText(/Couldn't choose the option/)).toBeVisible()
    expect(screen.getByText(/Typed into a field/)).toBeVisible()
    expect(screen.getByText(/^Clicked/)).toBeVisible()
  })

  // The list is a record, not a set of choices, so it holds no menu items —
  // and Radix, finding none to move focus between, swallows the vertical keys
  // rather than letting them scroll. The control takes them back. Pinned
  // because it rests on Radix running its own handler only while the event is
  // un-prevented: an upgrade that changed that would leave a 50-line record
  // that a keyboard cannot read past its first screenful.
  it("scrolls its list with the vertical keys, which the menu would swallow", async () => {
    read({ at: 1 })
    read({ at: 2, outcome: "failed" })
    wrap(<BrowserAgentActivityControl tab={tab} />)
    await openMenu(screen.getByRole("button", { name: /^Agent activity:/ }))
    const list = screen.getByRole("group", {
      name: "What agents did here",
    })
    // jsdom lays nothing out, so `scrollTop` would stay 0 however it is
    // written; stand in for a scroller that remembers, which is also what
    // pins the moves as relative rather than absolute.
    const written: number[] = []
    let top = 0
    Object.defineProperty(list, "scrollTop", {
      configurable: true,
      get: () => top,
      set: (value: number) => {
        top = value
        written.push(value)
      },
    })
    Object.defineProperty(list, "clientHeight", {
      configurable: true,
      get: () => 200,
    })
    const menu = screen.getByRole("menu")
    fireEvent.keyDown(menu, { key: "ArrowDown" })
    fireEvent.keyDown(menu, { key: "ArrowDown" })
    fireEvent.keyDown(menu, { key: "PageDown" })
    fireEvent.keyDown(menu, { key: "ArrowUp" })
    expect(written).toEqual([48, 96, 296, 248])
    // A key the list has no use for is left to the menu.
    written.length = 0
    fireEvent.keyDown(menu, { key: "a" })
    expect(written).toEqual([])
  })

  // A line stands for a run, so the closed control has to say how big it is:
  // one refused click and a retry loop of forty would otherwise look exactly
  // the same, and the loop is the case this control exists for.
  it("says how many attempts the line it names stands for", () => {
    read({ at: 1, action: "click", outcome: "refused" })
    read({ at: 2, action: "click", outcome: "refused" })
    read({ at: 3, action: "click", outcome: "refused" })
    wrap(<BrowserAgentActivityControl tab={tab} />)
    expect(
      screen.getByRole("button", {
        name: "Agent activity: Refused to click: actions aren't allowed on this page 3×",
      })
    ).toBeVisible()
  })

  it("counts a run rather than repeating it", async () => {
    read({ at: 1_700_000_000_000 })
    read({ at: 1_700_000_001_000 })
    read({ at: 1_700_000_002_000, outcome: "failed" })
    wrap(<BrowserAgentActivityControl tab={tab} />)
    // Two lines for three attempts: the pair of reads is one of them.
    await openMenu(screen.getByRole("button", { name: /^Agent activity:/ }))
    expect(screen.getByText(/Couldn't read the page/)).toBeVisible()
    expect(screen.getByText(/Read the page/)).toBeVisible()
    expect(screen.getByText("2×")).toBeVisible()
  })
})
