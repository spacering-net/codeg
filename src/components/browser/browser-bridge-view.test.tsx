import { StrictMode } from "react"
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"

import type { BrowserWorkspaceTab } from "@/contexts/workspace-context"
import type { BridgeGrant } from "@/lib/browser/browser-bridge"

const api = vi.hoisted(() => ({
  bridgeOpen: vi.fn(),
  bridgeClose: vi.fn(() => Promise.resolve()),
  probeBridge: vi.fn(() => Promise.resolve(true)),
  openExternalTab: vi.fn(),
  copyTextToClipboard: vi.fn(() => Promise.resolve(true)),
  isDesktop: vi.fn(() => false),
}))

vi.mock("@/lib/browser/browser-bridge", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/browser/browser-bridge")>()),
  bridgeOpen: api.bridgeOpen,
  bridgeClose: api.bridgeClose,
  probeBridge: api.probeBridge,
}))
vi.mock("@/lib/link-open", () => ({
  openExternalTab: api.openExternalTab,
}))
vi.mock("@/lib/utils", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/utils")>()),
  copyTextToClipboard: api.copyTextToClipboard,
}))
vi.mock("@/lib/transport", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/transport")>()),
  isDesktop: () => api.isDesktop(),
}))
// The native view pulls in the surface host and the tab store; the web
// branch must not need any of it.
vi.mock("./browser-surface-host", () => ({
  BrowserSurfaceHost: () => <div data-testid="native-surface" />,
}))

import enMessages from "@/i18n/messages/en.json"
import { bridgeEntryUrl } from "@/lib/browser/browser-bridge"
import { buildFileTabId } from "@/lib/file-tab-id"

import { BRIDGE_FRAME_SANDBOX, BrowserBridgeView } from "./browser-bridge-view"
import { BrowserTabView } from "./browser-tab-view"

const grant: BridgeGrant = {
  targetPort: 3000,
  bridgePort: 3081,
  bridgeHost: null,
  entryPath: "/__codeg_bridge/enter/cap-one",
  publicHost: null,
  path: "/docs?x=1",
}

function tab(url = "http://localhost:3000/docs?x=1"): BrowserWorkspaceTab {
  return {
    id: buildFileTabId({ kind: "browser", id: "tab-1" }),
    kind: "browser",
    folderId: null,
    title: "localhost:3000",
    description: null,
    path: null,
    language: "browser",
    content: "",
    loading: true,
    readonly: true,
    browser: { initialUrl: url, openerTabId: null, profile: "default" },
  }
}

function renderView(ui: React.ReactElement) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      {ui}
    </NextIntlClientProvider>
  )
}

beforeEach(() => {
  api.bridgeOpen.mockReset()
  api.bridgeClose.mockClear()
  api.probeBridge.mockReset()
  api.probeBridge.mockResolvedValue(true)
  api.openExternalTab.mockClear()
  api.copyTextToClipboard.mockClear()
  api.isDesktop.mockReturnValue(false)
})

describe("BrowserBridgeView", () => {
  it("mints a grant for the tab and shows the page in a sandboxed frame", async () => {
    api.bridgeOpen.mockResolvedValue(grant)
    renderView(<BrowserBridgeView tab={tab()} />)
    expect(screen.getByRole("status")).toHaveTextContent(
      "Connecting through the server"
    )
    const frame = (await screen.findByTitle(
      "Dev server preview"
    )) as HTMLIFrameElement
    expect(api.bridgeOpen).toHaveBeenCalledWith(
      "http://localhost:3000/docs?x=1",
      expect.stringMatching(/^tab-1:/)
    )
    const expectedSrc = bridgeEntryUrl(grant, window.location)
    expect(frame.getAttribute("src")).toBe(expectedSrc)
    expect(expectedSrc).toContain(":3081/__codeg_bridge/enter/cap-one?to=")
    expect(frame.getAttribute("sandbox")).toBe(BRIDGE_FRAME_SANDBOX)
    expect(frame.getAttribute("sandbox")).not.toContain("allow-top-navigation")
    expect(frame.getAttribute("referrerpolicy")).toBe("no-referrer")
    expect(api.probeBridge).toHaveBeenCalledWith(
      expectedSrc.slice(0, expectedSrc.indexOf("/__codeg_bridge"))
    )
    // The address shown is the one the user opened, not the bridge's.
    expect(screen.getByTitle("http://localhost:3000/docs?x=1")).toBeTruthy()
  })

  it("opens the same entry in a new tab and copies the address", async () => {
    api.bridgeOpen.mockResolvedValue(grant)
    renderView(<BrowserBridgeView tab={tab()} />)
    await screen.findByTitle("Dev server preview")
    fireEvent.click(screen.getByRole("button", { name: "Open in a new tab" }))
    expect(api.openExternalTab).toHaveBeenCalledWith(
      bridgeEntryUrl(grant, window.location)
    )
    fireEvent.click(screen.getByRole("button", { name: "Copy address" }))
    await waitFor(() =>
      expect(api.copyTextToClipboard).toHaveBeenCalledWith(
        "http://localhost:3000/docs?x=1"
      )
    )
  })

  it("reload mints a fresh grant and reloads the frame with it", async () => {
    api.bridgeOpen.mockResolvedValueOnce(grant).mockResolvedValueOnce({
      ...grant,
      entryPath: "/__codeg_bridge/enter/cap-two",
    })
    renderView(<BrowserBridgeView tab={tab()} />)
    await screen.findByTitle("Dev server preview")
    fireEvent.click(screen.getByRole("button", { name: "Reload" }))
    await waitFor(() =>
      expect(
        screen.getByTitle("Dev server preview").getAttribute("src")
      ).toContain("cap-two")
    )
    expect(api.bridgeOpen).toHaveBeenCalledTimes(2)
  })

  it("explains an unreachable bridge port instead of a blank frame", async () => {
    api.bridgeOpen.mockResolvedValue(grant)
    api.probeBridge.mockResolvedValue(false)
    renderView(<BrowserBridgeView tab={tab()} />)
    await screen.findByText("The bridge port can't be reached")
    expect(screen.getByRole("status")).toHaveTextContent(":3081")
    expect(screen.getByRole("status")).toHaveTextContent("CODEG_BRIDGE_PORTS")
    expect(screen.queryByTitle("Dev server preview")).toBeNull()
    // A top-level tab may still get there (a VPN, a different route), so
    // the new-tab action stays.
    fireEvent.click(
      screen.getAllByRole("button", { name: "Open in a new tab" })[0]
    )
    expect(api.openExternalTab).toHaveBeenCalledWith(
      bridgeEntryUrl(grant, window.location)
    )
  })

  it("names DNS, not a published port, when the target has a hostname", async () => {
    // Nothing to publish there — the bridge answers on the port the
    // workbench already uses — so the port advice would send the reader
    // after the wrong thing.
    const hostGrant: BridgeGrant = {
      ...grant,
      bridgePort: null,
      bridgeHost: "3000.codeg.example",
    }
    api.bridgeOpen.mockResolvedValue(hostGrant)
    api.probeBridge.mockResolvedValue(false)
    renderView(<BrowserBridgeView tab={tab()} />)
    await screen.findByText("The bridge port can't be reached")
    const notice = screen.getByRole("status")
    expect(notice).toHaveTextContent("3000.codeg.example")
    expect(notice).toHaveTextContent("CODEG_BRIDGE_HOST_PATTERN")
    expect(notice).not.toHaveTextContent("CODEG_BRIDGE_PORTS")
  })

  it("shows the server's refusal", async () => {
    api.bridgeOpen.mockRejectedValue(
      new Error("192.168.1.9 is not the server's loopback")
    )
    renderView(<BrowserBridgeView tab={tab("http://192.168.1.9:3000/")} />)
    await screen.findByText("This page can't be shown here")
    expect(screen.getByRole("status")).toHaveTextContent(
      "192.168.1.9 is not the server's loopback"
    )
    expect(
      screen.getByRole("button", { name: "Open in a new tab" })
    ).toBeDisabled()
  })

  it("keeps the address's fragment for the frame", async () => {
    api.bridgeOpen.mockResolvedValue(grant)
    renderView(
      <BrowserBridgeView tab={tab("http://localhost:3000/docs?x=1#install")} />
    )
    const frame = await screen.findByTitle("Dev server preview")
    expect(frame.getAttribute("src")).toBe(
      bridgeEntryUrl(grant, window.location, "#install")
    )
    expect(frame.getAttribute("src")).toContain("%23install")
  })

  it("releases exactly the hold it opened, once the open has settled", async () => {
    api.bridgeOpen.mockResolvedValue(grant)
    const view = renderView(<BrowserBridgeView tab={tab()} />)
    await screen.findByTitle("Dev server preview")
    const holdId = api.bridgeOpen.mock.calls[0][1]
    expect(api.bridgeClose).not.toHaveBeenCalled()
    await act(async () => {
      view.unmount()
    })
    expect(api.bridgeClose).toHaveBeenCalledTimes(1)
    expect(api.bridgeClose).toHaveBeenCalledWith(holdId)
  })

  it("unmounted while the open is pending: closes after it lands, never before", async () => {
    let resolveOpen: (grant: BridgeGrant) => void = () => {}
    api.bridgeOpen.mockReturnValue(
      new Promise<BridgeGrant>((resolve) => {
        resolveOpen = resolve
      })
    )
    const view = renderView(<BrowserBridgeView tab={tab()} />)
    const holdId = api.bridgeOpen.mock.calls[0][1]
    await act(async () => {
      view.unmount()
    })
    expect(api.bridgeClose).not.toHaveBeenCalled()
    await act(async () => {
      resolveOpen(grant)
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(api.bridgeClose).toHaveBeenCalledWith(holdId)
  })

  it("a failed open is released too: the server may have recorded it", async () => {
    api.bridgeOpen.mockRejectedValue(new Error("Request timed out"))
    const view = renderView(<BrowserBridgeView tab={tab()} />)
    await screen.findByText("This page can't be shown here")
    const holdId = api.bridgeOpen.mock.calls[0][1]
    await act(async () => {
      view.unmount()
    })
    expect(api.bridgeClose).toHaveBeenCalledTimes(1)
    expect(api.bridgeClose).toHaveBeenCalledWith(holdId)
  })

  it("unmounted while the probe is pending: the hold is released, no outcome is painted", async () => {
    api.bridgeOpen.mockResolvedValue(grant)
    let resolveProbe: (ok: boolean) => void = () => {}
    api.probeBridge.mockReturnValue(
      new Promise<boolean>((resolve) => {
        resolveProbe = resolve
      })
    )
    const view = renderView(<BrowserBridgeView tab={tab()} />)
    await waitFor(() => expect(api.probeBridge).toHaveBeenCalled())
    const holdId = api.bridgeOpen.mock.calls[0][1]
    await act(async () => {
      view.unmount()
    })
    await waitFor(() => expect(api.bridgeClose).toHaveBeenCalledWith(holdId))
    await act(async () => {
      resolveProbe(true)
    })
    expect(api.bridgeClose).toHaveBeenCalledTimes(1)
  })

  it("two quick reloads: every earlier hold released once, the newest kept", async () => {
    api.bridgeOpen.mockImplementation(() =>
      Promise.resolve({
        ...grant,
        entryPath: `/__codeg_bridge/enter/cap-${api.bridgeOpen.mock.calls.length}`,
      })
    )
    renderView(<BrowserBridgeView tab={tab()} />)
    await screen.findByTitle("Dev server preview")
    fireEvent.click(screen.getByRole("button", { name: "Reload" }))
    fireEvent.click(screen.getByRole("button", { name: "Reload" }))
    await waitFor(() => expect(api.bridgeOpen).toHaveBeenCalledTimes(3))
    const ids = api.bridgeOpen.mock.calls.map((call) => call[1] as string)
    expect(new Set(ids).size).toBe(3)
    await waitFor(() => expect(api.bridgeClose).toHaveBeenCalledTimes(2))
    expect(api.bridgeClose).toHaveBeenCalledWith(ids[0])
    expect(api.bridgeClose).toHaveBeenCalledWith(ids[1])
    expect(api.bridgeClose).not.toHaveBeenCalledWith(ids[2])
    await waitFor(() =>
      expect(
        screen.getByTitle("Dev server preview").getAttribute("src")
      ).toContain("cap-3")
    )
  })

  it("under StrictMode's effect replay exactly one hold stays open", async () => {
    api.bridgeOpen.mockImplementation(() =>
      Promise.resolve({
        ...grant,
        entryPath: `/__codeg_bridge/enter/cap-${api.bridgeOpen.mock.calls.length}`,
      })
    )
    render(
      <StrictMode>
        <NextIntlClientProvider locale="en" messages={enMessages}>
          <BrowserBridgeView tab={tab()} />
        </NextIntlClientProvider>
      </StrictMode>
    )
    await screen.findByTitle("Dev server preview")
    await waitFor(() => expect(api.bridgeOpen).toHaveBeenCalledTimes(2))
    const [first, second] = api.bridgeOpen.mock.calls.map(
      (call) => call[1] as string
    )
    expect(first).not.toBe(second)
    await waitFor(() => expect(api.bridgeClose).toHaveBeenCalledWith(first))
    expect(api.bridgeClose).toHaveBeenCalledTimes(1)
    expect(api.bridgeClose).not.toHaveBeenCalledWith(second)
    // The frame shows the surviving attempt's entry.
    expect(
      screen.getByTitle("Dev server preview").getAttribute("src")
    ).toContain("cap-2")
  })

  it("a reload releases the previous attempt's hold, not the new one's", async () => {
    api.bridgeOpen.mockResolvedValueOnce(grant).mockResolvedValueOnce({
      ...grant,
      entryPath: "/__codeg_bridge/enter/cap-two",
    })
    renderView(<BrowserBridgeView tab={tab()} />)
    await screen.findByTitle("Dev server preview")
    const first = api.bridgeOpen.mock.calls[0][1]
    fireEvent.click(screen.getByRole("button", { name: "Reload" }))
    await waitFor(() =>
      expect(
        screen.getByTitle("Dev server preview").getAttribute("src")
      ).toContain("cap-two")
    )
    const second = api.bridgeOpen.mock.calls[1][1]
    expect(second).not.toBe(first)
    await waitFor(() => expect(api.bridgeClose).toHaveBeenCalledWith(first))
    expect(api.bridgeClose).not.toHaveBeenCalledWith(second)
  })
})

describe("BrowserTabView in a browser", () => {
  it("renders the bridge view, never the native surface", async () => {
    api.bridgeOpen.mockResolvedValue(grant)
    renderView(<BrowserTabView tab={tab()} />)
    await screen.findByTitle("Dev server preview")
    expect(screen.queryByTestId("native-surface")).toBeNull()
  })
})
