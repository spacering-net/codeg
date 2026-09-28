import { act, render } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { DetectedService } from "@/lib/browser/types"
import type { LinkAction } from "@/lib/resolve-link-action"

type Handler = (payload: DetectedService) => void

const mocks = vi.hoisted(() => {
  const handlers = new Map<string, Handler>()
  return {
    handlers,
    toast: vi.fn(),
    openBrowserTab: vi.fn<(...args: unknown[]) => string | null>(
      () => "browser:new"
    ),
    openUrl: vi.fn(),
    decide: vi.fn<(url: string, options: unknown) => LinkAction>(
      (url: string): LinkAction => ({
        kind: "builtin",
        url,
        placement: "tab",
        remoteOverride: false,
        remote: false,
      })
    ),
    windowLabel: "main",
    subscribe: vi.fn((event: string, handler: Handler) => {
      handlers.set(event, handler)
      return Promise.resolve(() => handlers.delete(event))
    }),
  }
})

vi.mock("sonner", () => ({ toast: mocks.toast }))
vi.mock("@/lib/transport", () => ({
  getTransport: () => ({ subscribe: mocks.subscribe }),
  isDesktop: () => true,
}))
vi.mock("@/contexts/workspace-context", () => ({
  useOptionalWorkspaceActions: () => ({ openBrowserTab: mocks.openBrowserTab }),
}))
vi.mock("@/hooks/use-open-url-target", () => ({
  useLinkDecision: () => mocks.decide,
  useOpenUrlTarget: () => mocks.openUrl,
}))
vi.mock("@/lib/browser/window-label", () => ({
  getCurrentWindowLabel: () => mocks.windowLabel,
}))

import enMessages from "@/i18n/messages/en.json"
import {
  resetBrowserPrefsForTests,
  setBrowserServiceAutoOpen,
} from "@/lib/browser/browser-prefs"
import { BROWSER_SERVICE_DETECTED_EVENT } from "@/lib/browser/types"
import { BrowserServiceBridge } from "./browser-service-bridge"

const service: DetectedService = {
  url: "http://localhost:5173/",
  origin: "http://localhost:5173",
  authority: "localhost:5173",
  ownerWindow: "main",
  source: "terminal",
  terminalId: "t1",
}

async function mount() {
  const view = render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <BrowserServiceBridge />
    </NextIntlClientProvider>
  )
  await act(async () => {
    await Promise.resolve()
  })
  return view
}

/** Deliver one `browser://service-detected` the way the backend would. */
function detect(overrides: Partial<DetectedService> = {}) {
  const handler = mocks.handlers.get(BROWSER_SERVICE_DETECTED_EVENT)
  expect(handler).toBeDefined()
  act(() => {
    handler?.({ ...service, ...overrides })
  })
}

/** The options object of the last `toast(...)` call. */
function lastToast() {
  const { calls } = mocks.toast.mock
  const call = calls[calls.length - 1]
  expect(call).toBeDefined()
  return {
    message: call?.[0] as string,
    options: call?.[1] as {
      id?: string
      action?: { label: string; onClick: () => void }
    },
  }
}

describe("BrowserServiceBridge", () => {
  beforeEach(() => {
    mocks.handlers.clear()
    mocks.subscribe.mockClear()
    mocks.toast.mockClear()
    mocks.openBrowserTab.mockClear()
    mocks.openUrl.mockClear()
    // `mockClear` keeps whatever implementation a previous test installed, so
    // the default answer is re-armed rather than cleared: one test's "refuse
    // this address" would otherwise silence every test after it.
    mocks.decide.mockReset()
    mocks.decide.mockImplementation(
      (url: string): LinkAction => ({
        kind: "builtin",
        url,
        remoteOverride: false,
        remote: false,
        placement: "tab",
      })
    )
    mocks.windowLabel = "main"
    resetBrowserPrefsForTests()
  })
  afterEach(() => {
    resetBrowserPrefsForTests()
  })

  it("notifies by default, and the notice's button opens through the link path", async () => {
    await mount()
    detect()
    expect(mocks.openBrowserTab).not.toHaveBeenCalled()
    const { message, options } = lastToast()
    expect(message).toContain("localhost:5173")
    // One notice per address: a second terminal on the same port replaces it.
    expect(options.id).toBe("service:http://localhost:5173")
    act(() => {
      options.action?.onClick()
    })
    // Through the link path, not straight to a tab: pressing it IS a gesture,
    // so someone who set terminal links to the system browser gets that.
    expect(mocks.openUrl).toHaveBeenCalledWith("http://localhost:5173/", {
      source: "terminal",
    })
  })

  it("opens the tab and shows it when set to open, without a notice", async () => {
    setBrowserServiceAutoOpen("open")
    await mount()
    detect()
    // `"tab"`, not `true`: the page is selected (so it loads and is there to
    // look at) but the files pane is not pulled forward over whatever the
    // person is doing.
    expect(mocks.openBrowserTab).toHaveBeenCalledWith(
      "http://localhost:5173/",
      { activate: "tab" }
    )
    expect(mocks.toast).not.toHaveBeenCalled()
  })

  // An address the decision put on the remote host stays there when the
  // page is opened on its own, as it does when a person clicks it.
  it("opens a server of the remote host as a remote tab", async () => {
    setBrowserServiceAutoOpen("open")
    mocks.decide.mockImplementation(
      (url: string): LinkAction => ({
        kind: "builtin",
        url,
        placement: "tab",
        remoteOverride: true,
        remote: true,
      })
    )
    await mount()
    detect()
    expect(mocks.openBrowserTab).toHaveBeenCalledWith(
      "http://localhost:5173/",
      { activate: "tab", remote: true }
    )
  })

  it("does nothing at all when switched off", async () => {
    setBrowserServiceAutoOpen("off")
    await mount()
    detect()
    expect(mocks.toast).not.toHaveBeenCalled()
    expect(mocks.openBrowserTab).not.toHaveBeenCalled()
    // Not even asked: the preference is the first gate.
    expect(mocks.decide).not.toHaveBeenCalled()
  })

  /** Two windows hear the same event; the terminal belongs to one of them. */
  it("ignores a service that belongs to another window", async () => {
    setBrowserServiceAutoOpen("open")
    await mount()
    detect({ ownerWindow: "second" })
    expect(mocks.openBrowserTab).not.toHaveBeenCalled()
    expect(mocks.toast).not.toHaveBeenCalled()
  })

  /** Nothing may take over the whole desktop on its own. */
  it("falls back to a notice rather than launching the system browser", async () => {
    mocks.decide.mockImplementation(
      (url: string): LinkAction => ({ kind: "system", url })
    )
    setBrowserServiceAutoOpen("open")
    await mount()
    detect()
    expect(mocks.openBrowserTab).not.toHaveBeenCalled()
    expect(mocks.openUrl).not.toHaveBeenCalled()
    expect(lastToast().message).toContain("localhost:5173")
  })

  /** A site rule refusing the host is an answer the user already gave. */
  it("stays silent when the link decision refuses the address", async () => {
    mocks.decide.mockImplementation(
      (url: string): LinkAction => ({
        kind: "reject",
        reason: "blocked-host",
        url,
      })
    )
    await mount()
    detect()
    expect(mocks.toast).not.toHaveBeenCalled()
    expect(mocks.openBrowserTab).not.toHaveBeenCalled()
  })

  it("keeps listening across re-renders and stops on unmount", async () => {
    const view = await mount()
    view.rerender(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <BrowserServiceBridge />
      </NextIntlClientProvider>
    )
    // One subscription for the life of the component: a re-subscribe would
    // drop whatever arrived while it was down.
    expect(mocks.subscribe).toHaveBeenCalledTimes(1)
    detect()
    expect(mocks.toast).toHaveBeenCalledTimes(1)
    view.unmount()
    expect(mocks.handlers.size).toBe(0)
  })
})
