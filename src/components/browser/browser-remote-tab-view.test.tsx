import { act, fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"

import type { BrowserWorkspaceTab } from "@/contexts/workspace-context"
import enMessages from "@/i18n/messages/en.json"

type SurfaceHostProps = {
  egress?: number | null
  showCreateError?: boolean
  pendingLabel?: string
}

const mocks = vi.hoisted(() => ({
  baseUrl: "https://dev.example.com",
  connectionId: 7 as number | null,
  capabilities: { remoteEgress: true } as { remoteEgress: boolean } | null,
  state: null as { tabId: string } | null,
  openBrowserTab: vi.fn(() => "browser:new"),
  copy: vi.fn(() => Promise.resolve(true)),
  toast: { success: vi.fn(), error: vi.fn() },
  surfaceHost: vi.fn((props: SurfaceHostProps) => {
    void props
    return null
  }),
}))

vi.mock("@/lib/transport", () => ({
  getServerBaseUrl: () => mocks.baseUrl,
  getActiveRemoteConnectionId: () => mocks.connectionId,
  isDesktop: () => true,
  isRemoteDesktopMode: () => true,
}))
vi.mock("@/lib/browser/use-browser-capabilities", () => ({
  useBrowserCapabilities: () => mocks.capabilities,
}))
vi.mock(import("@/lib/browser/browser-tab-store"), async (importOriginal) => ({
  ...(await importOriginal()),
  useBrowserTabState: () => mocks.state as never,
  useBrowserFindRequest: () => 0,
}))
// The page's chrome is not what these tests are about.
vi.mock("./browser-toolbar", () => ({ BrowserToolbar: () => null }))
vi.mock("./browser-find-bar", () => ({ BrowserFindBar: () => null }))
vi.mock(import("./browser-status-layer"), async (importOriginal) => ({
  ...(await importOriginal()),
  BrowserNoticeBar: () => null,
  BrowserDownloadBar: () => null,
}))
vi.mock("@/contexts/workspace-context", () => ({
  useOptionalWorkspaceActions: () => ({ openBrowserTab: mocks.openBrowserTab }),
}))
vi.mock(import("@/lib/utils"), async (importOriginal) => ({
  ...(await importOriginal()),
  copyTextToClipboard: mocks.copy,
}))
vi.mock("sonner", () => ({ toast: mocks.toast }))
// The native surface: a remote tab must never get one.
vi.mock("./browser-surface-host", () => ({
  BrowserSurfaceHost: mocks.surfaceHost,
}))

import {
  resetBrowserTabStoreForTests,
  settleBrowserCreate,
} from "@/lib/browser/browser-tab-store"
import { BrowserRemoteTabView } from "./browser-remote-tab-view"
import { BrowserTabView } from "./browser-tab-view"

function remoteTab(url: string): BrowserWorkspaceTab {
  return {
    id: "browser:r",
    kind: "browser",
    folderId: 1,
    title: "localhost:3000",
    description: null,
    path: null,
    language: "browser",
    content: "",
    loading: false,
    readonly: true,
    browser: {
      initialUrl: url,
      openerTabId: null,
      profile: "default",
      remote: true,
    },
  } as BrowserWorkspaceTab
}

function renderView(url: string, view = BrowserRemoteTabView) {
  const View = view
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <View tab={remoteTab(url)} />
    </NextIntlClientProvider>
  )
}

describe("BrowserRemoteTabView", () => {
  beforeEach(() => {
    mocks.baseUrl = "https://dev.example.com"
    mocks.openBrowserTab.mockClear()
    mocks.copy.mockClear()
    mocks.toast.success.mockClear()
    mocks.surfaceHost.mockClear()
  })

  it("says the address is on the remote host, and loads nothing", () => {
    renderView("http://localhost:3000/app")
    expect(screen.getByText("This address is on dev.example.com")).toBeVisible()
    expect(
      screen.getByText(/points at the machine this workspace runs on/)
    ).toBeVisible()
    // Nothing was opened on the person's behalf.
    expect(mocks.openBrowserTab).not.toHaveBeenCalled()
  })

  it("copies the address", async () => {
    renderView("http://localhost:3000/app")
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy address" }))
    })
    expect(mocks.copy).toHaveBeenCalledWith("http://localhost:3000/app")
    expect(mocks.toast.success).toHaveBeenCalledWith("Address copied")
  })

  // A record brought back from a suspended page can hold the macOS alias its
  // page was loaded by; the remote host knows the address as `localhost`.
  it("copies the address as the remote host knows it", async () => {
    renderView("http://remote.localhost:3000/app")
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy address" }))
    })
    expect(mocks.copy).toHaveBeenCalledWith("http://localhost:3000/app")
  })

  // The same page on the remote host's own name: an ordinary tab of this
  // computer, not a remote one (that would just show this card again).
  it("offers the remote host's name for a loopback address with a port", () => {
    renderView("http://localhost:3000/app?x=1#top")
    fireEvent.click(
      screen.getByRole("button", { name: "Try dev.example.com:3000" })
    )
    expect(mocks.openBrowserTab).toHaveBeenCalledWith(
      "http://dev.example.com:3000/app?x=1#top",
      { remote: false }
    )
  })

  it("puts an IPv6 host in brackets", () => {
    mocks.baseUrl = "https://[fd00::5]:3080"
    renderView("http://127.0.0.1:8080/")
    fireEvent.click(screen.getByRole("button", { name: "Try [fd00::5]:8080" }))
    expect(mocks.openBrowserTab).toHaveBeenCalledWith(
      "http://[fd00::5]:8080/",
      {
        remote: false,
      }
    )
  })

  // Through an SSH tunnel the server is this machine's loopback: that name is
  // this computer, so there is nothing of the remote host to try or to name.
  it("offers nothing to try when the server is reached through loopback", () => {
    mocks.baseUrl = "http://127.0.0.1:3080"
    renderView("http://localhost:3000/")
    expect(screen.queryByRole("button", { name: /^Try / })).toBeNull()
    expect(screen.getByText("This address is on the remote host")).toBeVisible()
  })

  // Without a port, the remote name's default port is whatever fronts codeg
  // there — not the page the address meant.
  it("has nothing to try for a loopback address without a port", () => {
    renderView("http://localhost/app")
    expect(screen.queryByRole("button", { name: /^Try / })).toBeNull()
  })

  // A private address may well be reachable from here too (same network):
  // the person can decide to open it on this computer.
  it("lets a private address be opened on this computer", () => {
    renderView("http://192.168.1.20:8080/")
    expect(screen.queryByRole("button", { name: /^Try / })).toBeNull()
    fireEvent.click(
      screen.getByRole("button", { name: "Open on this computer" })
    )
    expect(mocks.openBrowserTab).toHaveBeenCalledWith(
      "http://192.168.1.20:8080/",
      { remote: false }
    )
  })

  it("never offers a loopback address to this computer", () => {
    renderView("http://localhost:3000/")
    expect(
      screen.queryByRole("button", { name: "Open on this computer" })
    ).toBeNull()
  })
})

describe("BrowserTabView", () => {
  beforeEach(() => {
    resetBrowserTabStoreForTests()
    mocks.baseUrl = "https://dev.example.com"
    mocks.surfaceHost.mockClear()
    mocks.connectionId = 7
    mocks.capabilities = { remoteEgress: true }
    mocks.state = null
  })

  const lastSurfaceProps = (): SurfaceHostProps => {
    const calls = mocks.surfaceHost.mock.calls
    return calls[calls.length - 1][0]
  }

  // The backend's refusal, as `browser_open_tab` rejects with it. The raw
  // message differs from the localized one, so the text on screen proves the
  // `i18n_key` was used.
  const refusal = {
    code: "permission_denied",
    message: "RAW BACKEND MESSAGE",
    i18n_key: "browser.remote.error.disabled",
  }

  // Opened in the window's connection's profile, through its tunnel — the
  // backend decides whether it can be, and says why not.
  it("opens a remote tab through the window's connection", () => {
    renderView("http://localhost:3000/", BrowserTabView)
    expect(mocks.surfaceHost).toHaveBeenCalled()
    expect(lastSurfaceProps().egress).toBe(7)
    // The tab shows a refusal itself, in place of the page.
    expect(lastSurfaceProps().showCreateError).toBe(false)
    expect(lastSurfaceProps().pendingLabel).toBe(
      "Connecting through dev.example.com…"
    )
    expect(screen.queryByText("This address is on dev.example.com")).toBeNull()
  })

  it("names no host while connecting through this machine's own loopback", () => {
    mocks.baseUrl = "http://127.0.0.1:3080"
    renderView("http://localhost:3000/", BrowserTabView)
    expect(lastSurfaceProps().pendingLabel).toBe(
      "Connecting through the remote host…"
    )
  })

  it("puts the card back with the reason when the open is refused, and asks again on request", () => {
    renderView("http://localhost:3000/", BrowserTabView)
    act(() => settleBrowserCreate("browser:r", { error: refusal }))
    expect(screen.getByText("This address is on dev.example.com")).toBeVisible()
    expect(
      screen.getByText(
        "The remote codeg-server has its browser tunnel switched off (CODEG_BROWSER_TUNNEL)."
      )
    ).toBeVisible()
    expect(screen.queryByText("RAW BACKEND MESSAGE")).toBeNull()
    mocks.surfaceHost.mockClear()
    fireEvent.click(screen.getByRole("button", { name: "Try again" }))
    expect(mocks.surfaceHost).toHaveBeenCalled()
    expect(lastSurfaceProps().egress).toBe(7)
  })

  // The person switched away and back while the tunnel was being opened:
  // the refusal arrives while a DIFFERENT mount of the tab is on screen, and
  // that one shows it — it reads the refusal from the store, not from the
  // mount that asked (the claim side is `browser-surface-host.test.tsx`).
  it("shows a refusal on whichever mount of the tab is on screen when it arrives", () => {
    const first = renderView("http://localhost:3000/", BrowserTabView)
    first.unmount()
    renderView("http://localhost:3000/", BrowserTabView)
    act(() => settleBrowserCreate("browser:r", { error: refusal }))
    expect(screen.getByRole("button", { name: "Try again" })).toBeVisible()
  })

  it("does not try where this computer cannot carry a remote tab", () => {
    mocks.capabilities = { remoteEgress: false }
    renderView("http://localhost:3000/", BrowserTabView)
    expect(mocks.surfaceHost).not.toHaveBeenCalled()
    expect(screen.getByText(/needs macOS 14 or later/)).toBeVisible()
  })

  it("never gives a surface to a remote tab with no connection to go through", () => {
    mocks.connectionId = null
    renderView("http://localhost:3000/", BrowserTabView)
    expect(mocks.surfaceHost).not.toHaveBeenCalled()
    expect(screen.getByText("This address is on dev.example.com")).toBeVisible()
  })

  // A popup the backend adopted from a remote tab already has its surface:
  // there is nothing left to refuse, whatever the capabilities say.
  it("shows a remote tab that already has a surface", () => {
    mocks.capabilities = { remoteEgress: false }
    mocks.state = { tabId: "r" }
    renderView("http://localhost:3000/", BrowserTabView)
    expect(mocks.surfaceHost).toHaveBeenCalled()
  })

  // A record in a connection's profile whose flag was lost (a popup adopted
  // after its opener's record went) is still the remote host's page.
  it("treats a record in a connection's profile as a remote tab", () => {
    const record = remoteTab("http://remote.localhost:3000/")
    render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <BrowserTabView
          tab={
            {
              ...record,
              browser: {
                ...record.browser,
                remote: undefined,
                profile: "remote-7",
              },
            } as unknown as BrowserWorkspaceTab
          }
        />
      </NextIntlClientProvider>
    )
    expect(lastSurfaceProps().egress).toBe(7)
  })
})
