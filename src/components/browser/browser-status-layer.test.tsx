import { act, fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  actions: null as null | { openBrowserTab: ReturnType<typeof vi.fn> },
  openUrl: vi.fn(),
  revealItemInDir: vi.fn(),
  openWithOsHandler: vi.fn(),
  browserAgentGrant: vi.fn(() => Promise.resolve({})),
}))

vi.mock("@/contexts/workspace-context", () => ({
  useOptionalWorkspaceActions: () => mocks.actions,
}))
vi.mock("@/lib/browser/browser-api", () => ({
  browserReload: vi.fn(),
  browserAgentGrant: mocks.browserAgentGrant,
}))
vi.mock("@/lib/link-open", () => ({
  openWithOsHandler: mocks.openWithOsHandler,
  openInSystemBrowser: vi.fn(),
}))
vi.mock("@/lib/platform", () => ({
  openUrl: mocks.openUrl,
  revealItemInDir: mocks.revealItemInDir,
}))

import {
  BrowserDownloadBar,
  BrowserErrorPage,
  BrowserNoticeBar,
} from "./browser-status-layer"
import type { BrowserWorkspaceTab } from "@/contexts/workspace-context"
import enMessages from "@/i18n/messages/en.json"
import {
  resetBrowserTabStoreForTests,
  setBrowserTabNotice,
} from "@/lib/browser/browser-tab-store"
import {
  resetBrowserDownloadsForTests,
  setBrowserDownload,
} from "@/lib/browser/browser-downloads-store"
import {
  resetBrowserEgressStoreForTests,
  setBrowserEgressStatus,
} from "@/lib/browser/browser-egress-store"
import type { BrowserDownload, BrowserTabState } from "@/lib/browser/types"

const tab = {
  id: "browser:abc",
  kind: "browser",
  folderId: null,
  title: "example.com",
  description: null,
  path: null,
  language: "browser",
  content: "",
  loading: true,
  readonly: true,
  browser: {
    initialUrl: "https://example.com/",
    openerTabId: null,
    profile: "default",
  },
} as unknown as BrowserWorkspaceTab

function renderBar() {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <BrowserNoticeBar tab={tab} state={null} />
    </NextIntlClientProvider>
  )
}

beforeEach(() => {
  resetBrowserTabStoreForTests()
  resetBrowserDownloadsForTests()
  resetBrowserEgressStoreForTests()
  mocks.actions = null
  mocks.openUrl.mockClear()
  mocks.revealItemInDir.mockClear()
  mocks.openWithOsHandler.mockClear()
  mocks.browserAgentGrant.mockClear()
})

describe("BrowserNoticeBar", () => {
  // Both ways a grant can end without the user doing anything. They read
  // almost opposite: one says the page moved, the other says it did not —
  // which is why the second one needs saying at all, since nothing else on
  // screen would have changed.
  describe("a grant that ended by itself", () => {
    function renderOn(origin: string) {
      return render(
        <NextIntlClientProvider locale="en" messages={enMessages}>
          <BrowserNoticeBar
            tab={tab}
            state={{ origin } as unknown as BrowserTabState}
          />
        </NextIntlClientProvider>
      )
    }

    it("offers to follow the page to where it landed", async () => {
      renderOn("https://other.example")
      act(() =>
        setBrowserTabNotice(tab.id, {
          kind: "agent-grant-lost",
          origin: "https://example.com",
        })
      )
      expect(
        screen.getByText(/Sharing ended: the page left example\.com/)
      ).toBeInTheDocument()
      // Awaited: acting on the notice also dismisses it, and that happens
      // when the grant call resolves.
      await act(async () => {
        fireEvent.click(
          screen.getByRole("button", { name: "Share other.example too" })
        )
      })
      expect(mocks.browserAgentGrant).toHaveBeenCalledWith("abc", "read")
      expect(screen.queryByText(/Sharing ended/)).not.toBeInTheDocument()
    })

    it("names no new address when a loopback port changed hands", async () => {
      renderOn("http://localhost:3000")
      act(() =>
        setBrowserTabNotice(tab.id, {
          kind: "agent-grant-replaced",
          origin: "http://localhost:3000",
        })
      )
      expect(
        screen.getByText(/a different program is serving localhost:3000 now/)
      ).toBeInTheDocument()
      // The tab did not move, so there is nowhere new to offer: the button
      // re-affirms the same address, now knowing what is behind it.
      expect(
        screen.queryByRole("button", { name: /Share .* too/ })
      ).not.toBeInTheDocument()
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Share it anyway" }))
      })
      expect(mocks.browserAgentGrant).toHaveBeenCalledWith("abc", "read")
      expect(screen.queryByText(/Sharing ended/)).not.toBeInTheDocument()
    })
  })

  describe("a remote tab's banner", () => {
    const remoteState = {
      remoteHost: "box.example.com:8443",
      profile: "remote-4",
    } as unknown as BrowserTabState

    function renderRemote() {
      return render(
        <NextIntlClientProvider locale="en" messages={enMessages}>
          <BrowserNoticeBar tab={tab} state={remoteState} />
        </NextIntlClientProvider>
      )
    }

    it("names the remote host the page comes through", () => {
      renderRemote()
      expect(
        screen.getByText("Opened through box.example.com:8443")
      ).toBeInTheDocument()
    })

    // The tunnel of the tab's own connection, not any other's.
    it("says so while the tunnel is down, and stops once it is back", () => {
      renderRemote()
      act(() => setBrowserEgressStatus(5, { state: "down", reason: "x" }))
      expect(screen.getByText(/Opened through/)).toBeInTheDocument()
      act(() => setBrowserEgressStatus(4, { state: "down", reason: "x" }))
      expect(
        screen.getByText(/Lost the connection to box\.example\.com:8443/)
      ).toBeInTheDocument()
      act(() => setBrowserEgressStatus(4, { state: "ready" }))
      expect(
        screen.getByText("Opened through box.example.com:8443")
      ).toBeInTheDocument()
    })
  })

  it("renders nothing without a notice or a remote host", () => {
    const { container } = renderBar()
    expect(container).toBeEmptyDOMElement()
  })

  it("offers to open a blocked pop-up as a tab next to its opener", () => {
    const openBrowserTab = vi.fn()
    mocks.actions = { openBrowserTab }
    renderBar()
    act(() =>
      setBrowserTabNotice(tab.id, {
        kind: "popup-denied",
        url: "https://accounts.example.com/login?x=1",
        reason: "no-gesture",
      })
    )
    expect(
      screen.getByText(/Pop-up blocked: accounts\.example\.com/)
    ).toBeInTheDocument()

    fireEvent.click(screen.getByRole("button", { name: "Open anyway" }))
    expect(openBrowserTab).toHaveBeenCalledWith(
      "https://accounts.example.com/login?x=1",
      { openerTabId: "browser:abc" }
    )
    // Acting on the notice also dismisses it.
    expect(screen.queryByText(/Pop-up blocked/)).not.toBeInTheDocument()
  })

  it("only reports the block outside the workspace providers", () => {
    renderBar()
    act(() =>
      setBrowserTabNotice(tab.id, {
        kind: "popup-denied",
        url: "https://example.org/",
        reason: "blocked-scheme",
      })
    )
    expect(screen.getByText(/Pop-up blocked/)).toBeInTheDocument()
    expect(
      screen.queryByRole("button", { name: "Open anyway" })
    ).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }))
    expect(screen.queryByText(/Pop-up blocked/)).not.toBeInTheDocument()
  })
})

function renderError(error: {
  kind: string
  message: string
  url: string | null
}) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <BrowserErrorPage
        tab={tab}
        error={error as never}
        url="https://example.com/"
      />
    </NextIntlClientProvider>
  )
}

describe("BrowserNoticeBar — refused navigations", () => {
  it("names the host a site rule blocked, with nothing to click but dismiss", () => {
    mocks.actions = { openBrowserTab: vi.fn() }
    setBrowserTabNotice("browser:abc", {
      kind: "navigation-blocked",
      url: "https://blocked.example/path",
      reason: "host-rule",
    })
    renderBar()
    expect(
      screen.getByText(
        /Navigation blocked: blocked\.example · blocked by a site rule/
      )
    ).toBeInTheDocument()
    expect(screen.queryByText("Open anyway")).not.toBeInTheDocument()
    expect(screen.queryByText("Open with system app")).not.toBeInTheDocument()
    fireEvent.click(screen.getByLabelText("Dismiss"))
    expect(screen.queryByText(/Navigation blocked/)).not.toBeInTheDocument()
  })

  // A `mailto:` the page pointed at is not a page, but the OS can take it —
  // the same hand-off the transcript makes for that scheme.
  it("offers the OS handler for a mailto: the tab refused, and nothing for other schemes", () => {
    setBrowserTabNotice("browser:abc", {
      kind: "navigation-blocked",
      url: "mailto:someone@example.com",
      reason: "scheme",
    })
    const { unmount } = renderBar()
    expect(
      screen.getByText(/address type not allowed here/)
    ).toBeInTheDocument()
    fireEvent.click(screen.getByText("Open with system app"))
    expect(mocks.openWithOsHandler).toHaveBeenCalledWith(
      "mailto:someone@example.com"
    )
    expect(screen.queryByText(/Navigation blocked/)).not.toBeInTheDocument()
    unmount()

    setBrowserTabNotice("browser:abc", {
      kind: "navigation-blocked",
      url: "vscode://file/x",
      reason: "scheme",
    })
    renderBar()
    expect(screen.queryByText("Open with system app")).not.toBeInTheDocument()
  })

  // Windows: the engine asked whether the page may take several files at
  // once, and the host answered for it. Nothing to click — the page is free
  // to ask again once the user actually clicks something.
  it("names the host that wanted several files without being clicked", () => {
    setBrowserTabNotice("browser:abc", {
      kind: "navigation-blocked",
      url: "https://files.example/bundle.zip",
      reason: "download",
    })
    renderBar()
    expect(
      screen.getByText(
        /Downloads blocked: files\.example · several files, not started by a click/
      )
    ).toBeInTheDocument()
    expect(screen.queryByText("Open anyway")).not.toBeInTheDocument()
  })

  it("does not offer to open a pop-up a site rule refused", () => {
    mocks.actions = { openBrowserTab: vi.fn() }
    setBrowserTabNotice("browser:abc", {
      kind: "popup-denied",
      url: "https://blocked.example/",
      reason: "blocked-host",
    })
    renderBar()
    expect(screen.getByText(/blocked by a site rule/)).toBeInTheDocument()
    expect(screen.queryByText("Open anyway")).not.toBeInTheDocument()
  })
})

function tabState(over: Partial<BrowserTabState> = {}): BrowserTabState {
  return {
    tabId: "abc",
    ownerWindow: "main",
    kind: "page",
    surface: "child",
    channel: "degraded",
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

function renderState(state: BrowserTabState) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <BrowserNoticeBar tab={tab} state={state} />
    </NextIntlClientProvider>
  )
}

const degradedText = /Pop-ups are blocked in this tab/

describe("BrowserNoticeBar — page channel", () => {
  beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }))
  afterEach(() => vi.useRealTimers())

  // Every tab is `degraded` between opening and the helper's first message,
  // so the bar has to wait before calling that a fault.
  it("keeps quiet while the page loads and through the grace period", () => {
    const { rerender } = renderState(tabState({ loading: true }))
    act(() => vi.advanceTimersByTime(5000))
    expect(screen.queryByText(degradedText)).not.toBeInTheDocument()

    rerender(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <BrowserNoticeBar tab={tab} state={tabState()} />
      </NextIntlClientProvider>
    )
    expect(screen.queryByText(degradedText)).not.toBeInTheDocument()
    act(() => vi.advanceTimersByTime(1600))
    expect(screen.getByText(degradedText)).toBeInTheDocument()
  })

  it("carries the engine's own words for a bug report, not on the bar", () => {
    renderState(tabState({ channelError: "Runtime.addBinding failed: 0x1" }))
    act(() => vi.advanceTimersByTime(1600))
    expect(screen.getByText(degradedText).parentElement).toHaveAttribute(
      "title",
      expect.stringContaining("Runtime.addBinding failed: 0x1")
    )
    expect(
      screen.queryByText(/Runtime\.addBinding failed/)
    ).not.toBeInTheDocument()
  })

  it("says nothing once the helper reports in, nor for a page-world channel", () => {
    const { unmount } = renderState(tabState({ channel: "native" }))
    act(() => vi.advanceTimersByTime(5000))
    expect(screen.queryByText(degradedText)).not.toBeInTheDocument()
    unmount()

    renderState(tabState({ channel: "legacy" }))
    act(() => vi.advanceTimersByTime(5000))
    expect(screen.queryByText(degradedText)).not.toBeInTheDocument()
  })

  // An owned window has no channel by design, and an error page is not the
  // page whose helper we are waiting for.
  it("stays out of an owned window and off an error page", () => {
    const { unmount } = renderState(tabState({ surface: "window" }))
    act(() => vi.advanceTimersByTime(5000))
    expect(screen.queryByText(degradedText)).not.toBeInTheDocument()
    unmount()

    renderState(
      tabState({
        error: { kind: "dns", message: "", url: "https://example.com/" },
      })
    )
    act(() => vi.advanceTimersByTime(5000))
    expect(screen.queryByText(degradedText)).not.toBeInTheDocument()
  })
})

describe("BrowserErrorPage", () => {
  it("explains a navigation that never produced a page", () => {
    renderError({
      kind: "failed",
      message: "",
      url: "https://news.example.com/",
    })
    expect(screen.getByText("This page can't be loaded")).toBeInTheDocument()
    expect(screen.getByText("https://news.example.com/")).toBeInTheDocument()
    expect(screen.getByText(/a proxy may be required/)).toBeInTheDocument()
  })

  it("prefers the platform's own wording and the tab URL as a fallback", () => {
    renderError({ kind: "tls", message: "certificate expired", url: null })
    expect(
      screen.getByText("This connection is not secure")
    ).toBeInTheDocument()
    expect(screen.getByText("https://example.com/")).toBeInTheDocument()
    expect(screen.getByText("certificate expired")).toBeInTheDocument()
    expect(
      screen.queryByText(/a proxy may be required/)
    ).not.toBeInTheDocument()
    expect(screen.getByText("Open in system browser")).toBeInTheDocument()
  })

  // The engine's description (system language) and our hint (user language)
  // are both worth showing: one says what happened, the other what to do.
  it("shows the platform's description and the hint together for a failed load", () => {
    renderError({
      kind: "failed",
      message: "Could not connect to the server.",
      url: "https://down.example/",
    })
    expect(
      screen.getByText("Could not connect to the server.")
    ).toBeInTheDocument()
    expect(screen.getByText(/a proxy may be required/)).toBeInTheDocument()
  })

  // The engine words any failed proxied connection the same ("bad URL");
  // the tunnel's reason replaces it, and the system browser — this
  // computer's — is not offered for an address of the remote host.
  it("explains a remote tab's failure in the tunnel's terms", () => {
    render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <BrowserErrorPage
          tab={
            {
              ...tab,
              browser: { ...tab.browser, remote: true },
            } as unknown as BrowserWorkspaceTab
          }
          error={{
            kind: "remote-refused",
            message: "bad URL",
            url: "http://remote.localhost:3000/",
          }}
          url="http://remote.localhost:3000/"
        />
      </NextIntlClientProvider>
    )
    expect(
      screen.getByText(
        "Nothing is listening at this address on the remote host"
      )
    ).toBeInTheDocument()
    expect(screen.queryByText("bad URL")).not.toBeInTheDocument()
    expect(screen.getByText(/refused the connection/)).toBeInTheDocument()
    expect(screen.getByText("Retry")).toBeInTheDocument()
    expect(screen.queryByText("Open in system browser")).not.toBeInTheDocument()
  })

  it("does not offer the system browser for any page of a remote tab", () => {
    render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <BrowserErrorPage
          tab={
            {
              ...tab,
              browser: { ...tab.browser, remote: true },
            } as unknown as BrowserWorkspaceTab
          }
          error={{ kind: "tls", message: "certificate expired", url: null }}
          url="https://10.0.0.5/"
        />
      </NextIntlClientProvider>
    )
    expect(screen.getByText("certificate expired")).toBeInTheDocument()
    expect(screen.queryByText("Open in system browser")).not.toBeInTheDocument()
  })

  it("explains a site-rule block and does not offer the system browser", () => {
    renderError({
      kind: "blocked",
      message: "",
      url: "https://blocked.example/",
    })
    expect(
      screen.getByText("This address is blocked in the built-in browser")
    ).toBeInTheDocument()
    expect(
      screen.getByText(/A site rule blocks this address/)
    ).toBeInTheDocument()
    expect(screen.getByText("Retry")).toBeInTheDocument()
    expect(screen.queryByText("Open in system browser")).not.toBeInTheDocument()
  })
})

describe("BrowserDownloadBar", () => {
  function renderDownloads() {
    return render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <BrowserDownloadBar tab={tab} />
      </NextIntlClientProvider>
    )
  }

  const download = (over: Partial<BrowserDownload> = {}): BrowserDownload => ({
    id: "dl-1",
    tabId: "abc",
    url: "https://example.com/a.bin",
    fileName: "a.bin",
    path: "/Users/dev/Downloads/a.bin",
    state: "started",
    ...over,
  })

  it("renders nothing without downloads", () => {
    const { container } = renderDownloads()
    expect(container).toBeEmptyDOMElement()
  })

  // Never "open": a file that just arrived from the web is revealed in the
  // file manager, and running it stays the user's decision.
  it("offers show-in-folder only once a download completed", () => {
    renderDownloads()
    act(() => setBrowserDownload(download()))
    expect(screen.getByText("a.bin")).toBeInTheDocument()
    expect(screen.getByText("Downloading…")).toBeInTheDocument()
    expect(screen.queryByText("Show in folder")).not.toBeInTheDocument()

    act(() => setBrowserDownload(download({ state: "completed" })))
    expect(screen.getByText("Saved")).toBeInTheDocument()
    fireEvent.click(screen.getByText("Show in folder"))
    expect(mocks.revealItemInDir).toHaveBeenCalledWith(
      "/Users/dev/Downloads/a.bin"
    )
  })

  it("shows a failed download and lets the row be dismissed", () => {
    renderDownloads()
    act(() => setBrowserDownload(download({ state: "failed" })))
    expect(screen.getByText("Failed")).toBeInTheDocument()
    expect(screen.queryByText("Show in folder")).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }))
    expect(screen.queryByText("a.bin")).not.toBeInTheDocument()
  })

  it("ignores downloads that belong to another tab", () => {
    const { container } = renderDownloads()
    act(() => setBrowserDownload(download({ tabId: "other" })))
    expect(container).toBeEmptyDOMElement()
  })
})
