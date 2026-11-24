import { act, render } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { FileWorkspaceTab } from "@/contexts/workspace-context"

const mocks = vi.hoisted(() => ({
  suspendBrowserTab: vi.fn(),
  fileTabs: [] as FileWorkspaceTab[],
  isDesktop: vi.fn(() => true),
}))

vi.mock("@/contexts/workspace-context", () => ({
  useWorkspaceActions: () => ({ suspendBrowserTab: mocks.suspendBrowserTab }),
  useWorkspaceFileTabs: () => ({ fileTabs: mocks.fileTabs }),
}))
vi.mock("@/lib/transport", () => ({ isDesktop: mocks.isDesktop }))

import {
  resetBrowserPrefsForTests,
  setBrowserSuspendBackgroundTabs,
} from "@/lib/browser/browser-prefs"
import {
  markBrowserTabHidden,
  markBrowserTabShown,
  resetBrowserTabStoreForTests,
  setBrowserTabState,
} from "@/lib/browser/browser-tab-store"
import { BROWSER_TAB_SUSPEND_AFTER_MS } from "@/lib/browser/browser-tab-persistence"
import { BrowserTabsSuspender, SUSPEND_POLL_MS } from "./browser-tabs-suspender"

function browserTab(id: string): FileWorkspaceTab {
  return {
    id: `browser:${id}`,
    kind: "browser",
    folderId: 1,
    title: "example.com",
    description: null,
    path: null,
    language: "browser",
    content: "",
    loading: false,
    readonly: true,
    browser: {
      initialUrl: "https://example.com/",
      openerTabId: null,
      profile: "default",
    },
  } as FileWorkspaceTab
}

function loaded(id: string) {
  setBrowserTabState({
    tabId: id,
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
}

describe("BrowserTabsSuspender", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    mocks.suspendBrowserTab.mockClear()
    mocks.isDesktop.mockReturnValue(true)
    mocks.fileTabs = []
    resetBrowserPrefsForTests()
    resetBrowserTabStoreForTests()
  })
  afterEach(() => {
    vi.useRealTimers()
    resetBrowserPrefsForTests()
    resetBrowserTabStoreForTests()
  })

  it("does nothing while the preference is off", async () => {
    mocks.fileTabs = [browserTab("t1")]
    loaded("t1")
    markBrowserTabHidden("browser:t1")
    render(<BrowserTabsSuspender />)
    await act(async () => {
      vi.advanceTimersByTime(BROWSER_TAB_SUSPEND_AFTER_MS + SUSPEND_POLL_MS * 2)
    })
    expect(mocks.suspendBrowserTab).not.toHaveBeenCalled()
  })

  it("releases a loaded tab once it has been off screen long enough", async () => {
    setBrowserSuspendBackgroundTabs(true)
    mocks.fileTabs = [browserTab("idle"), browserTab("onscreen")]
    loaded("idle")
    loaded("onscreen")
    markBrowserTabHidden("browser:idle")
    markBrowserTabShown("browser:onscreen")

    render(<BrowserTabsSuspender />)
    await act(async () => {
      vi.advanceTimersByTime(SUSPEND_POLL_MS)
    })
    expect(mocks.suspendBrowserTab).not.toHaveBeenCalled()

    await act(async () => {
      vi.advanceTimersByTime(BROWSER_TAB_SUSPEND_AFTER_MS)
    })
    expect(mocks.suspendBrowserTab).toHaveBeenCalledWith("browser:idle")
    expect(mocks.suspendBrowserTab).not.toHaveBeenCalledWith("browser:onscreen")
  })

  it("stops polling in web mode", async () => {
    setBrowserSuspendBackgroundTabs(true)
    mocks.isDesktop.mockReturnValue(false)
    mocks.fileTabs = [browserTab("t1")]
    loaded("t1")
    markBrowserTabHidden("browser:t1")
    render(<BrowserTabsSuspender />)
    await act(async () => {
      vi.advanceTimersByTime(BROWSER_TAB_SUSPEND_AFTER_MS + SUSPEND_POLL_MS * 2)
    })
    expect(mocks.suspendBrowserTab).not.toHaveBeenCalled()
  })
})
