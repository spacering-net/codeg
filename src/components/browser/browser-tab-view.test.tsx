import { act, fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { BrowserWorkspaceTab } from "@/contexts/workspace-context"
import enMessages from "@/i18n/messages/en.json"
import type { EmulatedBrowserDevice } from "@/lib/browser/browser-device"
import {
  getBrowserPrefs,
  resetBrowserPrefsForTests,
} from "@/lib/browser/browser-prefs"

type SurfaceHostProps = { zoom?: number | null; layoutKey?: string }

const mocks = vi.hoisted(() => ({
  state: null as null | {
    tabId: string
    surface: "child" | "window"
    error?: { kind: string }
  },
  setWindowViewport: vi.fn(() => Promise.resolve()),
  setBrowserTabDevice: vi.fn(),
  surfaceHost: vi.fn((props: SurfaceHostProps) => {
    void props
    return null
  }),
}))

vi.mock("@/contexts/workspace-context", () => ({
  useOptionalWorkspaceActions: () => ({
    setBrowserTabDevice: mocks.setBrowserTabDevice,
  }),
}))

vi.mock("@/lib/transport", () => ({
  getActiveRemoteConnectionId: () => null,
  isDesktop: () => true,
}))
vi.mock("@/lib/browser/use-browser-capabilities", () => ({
  useBrowserCapabilities: () => null,
}))
vi.mock(import("@/lib/browser/browser-tab-store"), async (importOriginal) => ({
  ...(await importOriginal()),
  useBrowserTabState: () => mocks.state as never,
  useBrowserFindRequest: () => 0,
}))
vi.mock("@/lib/browser/browser-api", () => ({
  browserSetVisible: vi.fn(() => Promise.resolve(null)),
  browserSetWindowViewport: mocks.setWindowViewport,
}))
// The page's chrome is not what these tests are about.
vi.mock("./browser-toolbar", () => ({ BrowserToolbar: () => null }))
vi.mock("./browser-find-bar", () => ({ BrowserFindBar: () => null }))
vi.mock(import("./browser-status-layer"), async (importOriginal) => ({
  ...(await importOriginal()),
  BrowserNoticeBar: () => null,
  BrowserDownloadBar: () => null,
  BrowserErrorPage: () => <p>The page failed</p>,
}))
vi.mock("./browser-surface-host", () => ({
  BrowserSurfaceHost: mocks.surfaceHost,
}))

import { BrowserTabView } from "./browser-tab-view"

function tabAs(device?: EmulatedBrowserDevice): BrowserWorkspaceTab {
  return {
    id: "browser:abc",
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
      initialUrl: "http://localhost:3000/",
      openerTabId: null,
      profile: "default",
      ...(device ? { device } : {}),
    },
  }
}

function view(device?: EmulatedBrowserDevice) {
  return (
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <BrowserTabView tab={tabAs(device)} />
    </NextIntlClientProvider>
  )
}

function lastHostProps(): SurfaceHostProps {
  const calls = mocks.surfaceHost.mock.calls
  return calls[calls.length - 1][0]
}

describe("BrowserTabView devices", () => {
  beforeEach(() => {
    resetBrowserPrefsForTests()
    mocks.state = { tabId: "abc", surface: "child" }
    mocks.setWindowViewport.mockClear()
    mocks.setBrowserTabDevice.mockClear()
    mocks.surfaceHost.mockClear()
    // A slot of 1000 × 600 (jsdom has no layout).
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      width: 1000,
      height: 600,
      right: 1000,
      bottom: 600,
      toJSON: () => ({}),
    })
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("lets a desktop page fill the slot, its zoom left alone", () => {
    const { container } = render(view())
    expect(container.querySelector("[data-browser-device-label]")).toBeNull()
    expect(lastHostProps().zoom).toBeNull()
  })

  it("frames a phone's page and zooms the surface so it lays out at the phone's width", () => {
    const { container } = render(view("phone"))
    // 600 - 32 - 28 = 540 of the phone's 844: shrunk, and saying by how much.
    const label = container.querySelector("[data-browser-device-label]")
    expect(label).toHaveTextContent("390 × 844")
    expect(label).toHaveTextContent(/· \d+%/)
    const zoom = lastHostProps().zoom ?? 1
    expect(zoom).toBeLessThan(1)
    const frame = container.querySelector<HTMLElement>(
      "[data-browser-device-frame]"
    )
    expect(parseFloat(frame?.style.width ?? "0") / zoom).toBeGreaterThanOrEqual(
      390
    )
  })

  it("sizes an owned window to the device instead of framing it, and gives its size back", () => {
    mocks.state = { tabId: "abc", surface: "window" }
    const { container, rerender } = render(view("phone"))
    // Nothing framed here: the window is the device's size itself.
    expect(container.querySelector("[data-browser-device-label]")).toBeNull()
    expect(lastHostProps().zoom).toBeNull()
    expect(mocks.setWindowViewport).toHaveBeenLastCalledWith("abc", {
      width: 390,
      height: 844,
    })
    rerender(view("tablet"))
    expect(mocks.setWindowViewport).toHaveBeenLastCalledWith("abc", {
      width: 768,
      height: 1024,
    })
    rerender(view())
    expect(mocks.setWindowViewport).toHaveBeenLastCalledWith("abc", null)
  })

  it("never asks an embedded page's window to resize", () => {
    render(view("phone"))
    expect(mocks.setWindowViewport).not.toHaveBeenCalled()
  })

  it("frames a custom device, and takes a new size for the tab from the line above the frame", () => {
    const { container } = render(view({ width: 1280, height: 800 }))
    const label = container.querySelector("[data-browser-device-label]")
    const width = screen.getByRole<HTMLInputElement>("textbox", {
      name: "Width",
    })
    expect(label).toContainElement(width)
    expect(width.value).toBe("1280")
    expect(lastHostProps().zoom).toBeLessThan(1)

    act(() => width.focus())
    fireEvent.change(width, { target: { value: "1024" } })
    fireEvent.keyDown(width, { key: "Enter" })
    expect(mocks.setBrowserTabDevice).toHaveBeenCalledWith("browser:abc", {
      width: 1024,
      height: 800,
    })
    // …and the next tab picked as "Custom" starts there.
    expect(getBrowserPrefs().customDevice).toEqual({ width: 1024, height: 800 })
  })

  it("offers no size to change under a page that failed", () => {
    mocks.state = { tabId: "abc", surface: "child", error: { kind: "load" } }
    render(view({ width: 1280, height: 800 }))
    expect(screen.getByText("The page failed")).toBeInTheDocument()
    expect(screen.queryByRole("textbox", { name: "Width" })).toBeNull()
  })

  it("sizes an owned window to a custom device, and changes its size from the window's card", () => {
    mocks.state = { tabId: "abc", surface: "window" }
    const { container, rerender } = render(view({ width: 1280, height: 800 }))
    expect(mocks.setWindowViewport).toHaveBeenLastCalledWith("abc", {
      width: 1280,
      height: 800,
    })
    expect(container.querySelector("[data-browser-device-label]")).toBeNull()
    const card = container.querySelector("[data-browser-device-size]")
    const width = screen.getByRole<HTMLInputElement>("textbox", {
      name: "Width",
    })
    expect(card).toContainElement(width)

    act(() => width.focus())
    fireEvent.change(width, { target: { value: "1440" } })
    act(() => width.blur())
    expect(mocks.setBrowserTabDevice).toHaveBeenCalledWith("browser:abc", {
      width: 1440,
      height: 800,
    })
    // The record takes it; the window follows.
    rerender(view({ width: 1440, height: 800 }))
    expect(mocks.setWindowViewport).toHaveBeenLastCalledWith("abc", {
      width: 1440,
      height: 800,
    })
    // The same size again is no change to make.
    const calls = mocks.setWindowViewport.mock.calls.length
    rerender(view({ width: 1440, height: 800 }))
    expect(mocks.setWindowViewport.mock.calls.length).toBe(calls)
  })

  it("says on an owned window's card which preset it is sized to, with nothing to edit", () => {
    mocks.state = { tabId: "abc", surface: "window" }
    const { container } = render(view("tablet"))
    expect(
      container.querySelector("[data-browser-device-size]")
    ).toHaveTextContent("768 × 1024")
    expect(screen.queryByRole("textbox", { name: "Width" })).toBeNull()
  })
})
