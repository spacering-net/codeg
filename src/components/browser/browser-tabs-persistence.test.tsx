import { act, render } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { FileWorkspaceTab } from "@/contexts/workspace-context"
import type { BrowserCapabilities } from "@/lib/browser/types"

const mocks = vi.hoisted(() => ({
  capabilities: vi.fn(
    (): Promise<BrowserCapabilities> =>
      Promise.resolve({
        available: true,
        surface: "child",
        platform: "macos",
        channel: "native",
        reasons: [],
        isolatedStorage: true,
        proxy: { url: null, applies: "live", reason: null },
        downloadsDir: "/Users/dev/Downloads",
        docGuest: false,
        profiles: false,
        signInUserAgent: false,
        ownedWindowControls: false,
        remoteEgress: false,
        policy: { enabled: true, managedRules: [], managedSource: null },
      })
  ),
  restoreBrowserTabs: vi.fn(),
  fileTabs: [] as FileWorkspaceTab[],
}))

vi.mock("@/lib/browser/browser-api", () => ({
  browserCapabilities: mocks.capabilities,
}))
vi.mock("@/contexts/workspace-context", () => ({
  useWorkspaceActions: () => ({ restoreBrowserTabs: mocks.restoreBrowserTabs }),
  useWorkspaceFileTabs: () => ({ fileTabs: mocks.fileTabs }),
}))

import {
  browserTabsStorageKey,
  readPersistedBrowserTabs,
  writePersistedBrowserTabs,
} from "@/lib/browser/browser-tab-persistence"
import {
  resetBrowserTabStoreForTests,
  setBrowserTabState,
} from "@/lib/browser/browser-tab-store"
import {
  BrowserTabsPersistence,
  resetBrowserTabsPersistenceForTests,
} from "./browser-tabs-persistence"

function browserTab(id: string, initialUrl: string): FileWorkspaceTab {
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
    browser: { initialUrl, openerTabId: null, profile: "default" },
  } as FileWorkspaceTab
}

async function flush() {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

describe("BrowserTabsPersistence", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    localStorage.clear()
    mocks.restoreBrowserTabs.mockClear()
    mocks.capabilities.mockClear()
    mocks.fileTabs = []
    resetBrowserTabsPersistenceForTests()
    resetBrowserTabStoreForTests()
  })
  afterEach(() => {
    vi.useRealTimers()
    resetBrowserTabsPersistenceForTests()
    resetBrowserTabStoreForTests()
  })

  it("restores the stored tabs once, then persists what the strip shows", async () => {
    writePersistedBrowserTabs(
      [
        {
          url: "https://example.com/a",
          title: "A",
          folderId: 2,
          profile: "default",
        },
      ],
      "main"
    )
    const { rerender } = render(<BrowserTabsPersistence />)
    await flush()
    expect(mocks.restoreBrowserTabs).toHaveBeenCalledWith([
      {
        url: "https://example.com/a",
        title: "A",
        folderId: 2,
        profile: "default",
      },
    ])

    // The provider adds the record; the page then loads and reports a deeper
    // URL and a real title through the store.
    mocks.fileTabs = [browserTab("t1", "https://example.com/a")]
    setBrowserTabState({
      tabId: "t1",
      ownerWindow: "main",
      kind: "page",
      surface: "child",
      channel: "native",
      channelError: null,
      url: "https://example.com/a/deep",
      requestedUrl: "https://example.com/a/deep",
      title: "Deep",
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
    rerender(<BrowserTabsPersistence />)
    await act(async () => {
      vi.advanceTimersByTime(500)
    })
    expect(readPersistedBrowserTabs("main")).toEqual([
      {
        url: "https://example.com/a/deep",
        title: "Deep",
        folderId: 1,
        profile: "default",
      },
    ])
  })

  // The failure this guards: a fresh document mounts with an empty strip, and
  // a write before the restore would erase the previous run's tabs.
  it("does not write before the restore has run", async () => {
    writePersistedBrowserTabs(
      [
        {
          url: "https://example.com/a",
          title: "A",
          folderId: null,
          profile: "default",
        },
      ],
      "main"
    )
    let resolveCaps: (caps: BrowserCapabilities) => void = () => {}
    mocks.capabilities.mockImplementationOnce(
      () =>
        new Promise<BrowserCapabilities>((resolve) => {
          resolveCaps = resolve
        })
    )
    render(<BrowserTabsPersistence />)
    await act(async () => {
      vi.advanceTimersByTime(2000)
    })
    expect(readPersistedBrowserTabs("main")).toEqual([
      {
        url: "https://example.com/a",
        title: "A",
        folderId: null,
        profile: "default",
      },
    ])

    await act(async () => {
      resolveCaps({
        available: true,
        surface: "child",
        platform: "macos",
        channel: "native",
        reasons: [],
        isolatedStorage: true,
        proxy: { url: null, applies: "live", reason: null },
        downloadsDir: "/Users/dev/Downloads",
        docGuest: false,
        profiles: false,
        signInUserAgent: false,
        ownedWindowControls: false,
        remoteEgress: false,
        policy: { enabled: true, managedRules: [], managedSource: null },
      })
      await Promise.resolve()
    })
    expect(mocks.restoreBrowserTabs).toHaveBeenCalledTimes(1)
  })

  it("clears the stored list once the last browser tab is closed", async () => {
    writePersistedBrowserTabs(
      [
        {
          url: "https://example.com/a",
          title: "A",
          folderId: null,
          profile: "default",
        },
      ],
      "main"
    )
    mocks.fileTabs = [browserTab("t1", "https://example.com/a")]
    const { rerender } = render(<BrowserTabsPersistence />)
    await flush()

    mocks.fileTabs = []
    rerender(<BrowserTabsPersistence />)
    await act(async () => {
      vi.advanceTimersByTime(500)
    })
    expect(localStorage.getItem(browserTabsStorageKey("main"))).toBeNull()
  })

  it("stays out of the way in web mode", async () => {
    writePersistedBrowserTabs(
      [
        {
          url: "https://example.com/a",
          title: "A",
          folderId: null,
          profile: "default",
        },
      ],
      "main"
    )
    mocks.capabilities.mockResolvedValueOnce({
      available: false,
      surface: null,
      platform: "web",
      channel: "degraded",
      reasons: [],
      isolatedStorage: false,
      proxy: { url: null, applies: "unsupported", reason: null },
      downloadsDir: "/Users/dev/Downloads",
      docGuest: false,
      profiles: false,
      signInUserAgent: false,
      ownedWindowControls: false,
      remoteEgress: false,
      policy: { enabled: true, managedRules: [], managedSource: null },
    })
    render(<BrowserTabsPersistence />)
    await act(async () => {
      vi.advanceTimersByTime(2000)
    })
    expect(mocks.restoreBrowserTabs).not.toHaveBeenCalled()
    // The desktop run's tabs are still there for the next desktop run.
    expect(readPersistedBrowserTabs("main")).toEqual([
      {
        url: "https://example.com/a",
        title: "A",
        folderId: null,
        profile: "default",
      },
    ])
  })
})
