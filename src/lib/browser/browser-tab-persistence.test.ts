import { beforeEach, describe, expect, it } from "vitest"

import type { FileWorkspaceTab } from "@/contexts/workspace-context"

import {
  BROWSER_TABS_STORAGE_VERSION,
  browserTabsStorageKey,
  readPersistedBrowserTabs,
  samePersistedBrowserTabs,
  selectBrowserTabsToSuspend,
  snapshotBrowserTabs,
  writePersistedBrowserTabs,
  type PersistedBrowserTab,
} from "./browser-tab-persistence"
import type { BrowserTabState } from "./types"

function browserTab(
  id: string,
  initialUrl: string,
  over: Partial<FileWorkspaceTab> = {}
): FileWorkspaceTab {
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
    ...over,
  } as FileWorkspaceTab
}

function fileTab(path: string): FileWorkspaceTab {
  return {
    id: `file:${path}`,
    kind: "file",
    folderId: null,
    title: "a.ts",
    description: null,
    path,
    language: "typescript",
    content: "x",
    loading: false,
  } as FileWorkspaceTab
}

function state(over: Partial<BrowserTabState> = {}): BrowserTabState {
  return {
    tabId: "abc",
    ownerWindow: "main",
    kind: "page",
    surface: "child",
    channel: "native",
    channelError: null,
    url: "https://example.com/deep",
    requestedUrl: "https://example.com/deep",
    title: "Deep page",
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

const KEY = browserTabsStorageKey("main")

beforeEach(() => {
  localStorage.clear()
})

describe("browser tab persistence", () => {
  it("keys storage per window label", () => {
    expect(browserTabsStorageKey("main")).toBe("browser:tabs:main")
    expect(browserTabsStorageKey("remote-workspace-3")).toBe(
      "browser:tabs:remote-workspace-3"
    )
  })

  it("round-trips a list and removes the key when it becomes empty", () => {
    const tabs: PersistedBrowserTab[] = [
      {
        url: "https://example.com/a",
        title: "A",
        folderId: 2,
        profile: "default",
      },
      {
        url: "http://localhost:3000/",
        title: "",
        folderId: null,
        profile: "p-1a2b3c4d5e6f",
      },
    ]
    writePersistedBrowserTabs(tabs, "main")
    expect(readPersistedBrowserTabs("main")).toEqual(tabs)

    writePersistedBrowserTabs([], "main")
    expect(localStorage.getItem(KEY)).toBeNull()
    expect(readPersistedBrowserTabs("main")).toEqual([])
  })

  // A stored list is user data from a previous run: it must never throw, and
  // one bad entry must not lose the good ones.
  it("drops unusable entries instead of the whole list", () => {
    localStorage.setItem(
      KEY,
      JSON.stringify({
        version: BROWSER_TABS_STORAGE_VERSION,
        tabs: [
          {
            url: "https://ok.example/",
            title: "ok",
            folderId: 1,
            profile: "default",
          },
          {
            url: "file:///etc/passwd",
            title: "no",
            folderId: 1,
            profile: "default",
          },
          {
            url: "javascript:alert(1)",
            title: "no",
            folderId: 1,
            profile: "default",
          },
          { url: "not a url", title: "no", folderId: 1, profile: "default" },
          null,
          { title: "no url" },
          { url: "https://ok2.example/", title: 42, folderId: "x" },
        ],
      })
    )
    expect(readPersistedBrowserTabs("main")).toEqual([
      {
        url: "https://ok.example/",
        title: "ok",
        folderId: 1,
        profile: "default",
      },
      {
        url: "https://ok2.example/",
        title: "",
        folderId: null,
        profile: "default",
      },
    ])
  })

  // Records written before profiles existed have no profile; a profile id
  // from another alphabet is not one the backend would accept.
  it("reads a missing or unusable profile as the default one", () => {
    localStorage.setItem(
      KEY,
      JSON.stringify({
        version: BROWSER_TABS_STORAGE_VERSION,
        tabs: [
          { url: "https://old.example/", title: "old", folderId: 1 },
          {
            url: "https://p.example/",
            title: "p",
            folderId: 1,
            profile: "p-work",
          },
          {
            url: "https://bad.example/",
            title: "bad",
            folderId: 1,
            profile: "../x",
          },
          {
            url: "https://num.example/",
            title: "num",
            folderId: 1,
            profile: 7,
          },
        ],
      })
    )
    expect(readPersistedBrowserTabs("main").map((t) => t.profile)).toEqual([
      "default",
      "p-work",
      "default",
      "default",
    ])
  })

  // A remote tab (an address of the remote codeg host) must come back as
  // one: restored as an ordinary tab it would load this machine's port.
  it("keeps the remote mark through a write, a read and a snapshot", () => {
    writePersistedBrowserTabs(
      [
        {
          url: "http://localhost:3000/",
          title: "",
          folderId: 1,
          profile: "default",
          remote: true,
        },
        {
          url: "https://example.com/",
          title: "",
          folderId: 1,
          profile: "default",
        },
      ],
      "main"
    )
    // Written only where it is set: other records keep their old shape.
    const stored = JSON.parse(localStorage.getItem(KEY) ?? "{}") as {
      tabs: Array<Record<string, unknown>>
    }
    expect(stored.tabs.map((t) => "remote" in t)).toEqual([true, false])
    expect(readPersistedBrowserTabs("main").map((t) => t.remote)).toEqual([
      true,
      undefined,
    ])

    const snapshot = snapshotBrowserTabs(
      [
        browserTab("r", "http://localhost:3000/", {
          browser: {
            initialUrl: "http://localhost:3000/",
            openerTabId: null,
            profile: "default",
            remote: true,
          },
        } as Partial<FileWorkspaceTab>),
        browserTab("l", "https://example.com/"),
      ],
      () => null
    )
    expect(snapshot.map((t) => t.remote)).toEqual([true, undefined])
  })

  it("reads anything but a literal true as not remote", () => {
    localStorage.setItem(
      KEY,
      JSON.stringify({
        version: BROWSER_TABS_STORAGE_VERSION,
        tabs: [
          { url: "http://localhost:1/", title: "", folderId: 1, remote: "yes" },
          { url: "http://localhost:2/", title: "", folderId: 1, remote: 1 },
        ],
      })
    )
    expect(readPersistedBrowserTabs("main").map((t) => t.remote)).toEqual([
      undefined,
      undefined,
    ])
  })

  it("ignores a payload from another version or shape", () => {
    localStorage.setItem(KEY, "{oops")
    expect(readPersistedBrowserTabs("main")).toEqual([])
    localStorage.setItem(
      KEY,
      JSON.stringify({ version: 99, tabs: [{ url: "https://x.example/" }] })
    )
    expect(readPersistedBrowserTabs("main")).toEqual([])
    localStorage.setItem(KEY, JSON.stringify({ version: 1, tabs: "nope" }))
    expect(readPersistedBrowserTabs("main")).toEqual([])
  })

  it("snapshots browser tabs in strip order at their live page", () => {
    const tabs = [
      fileTab("/repo/a.ts"),
      browserTab("one", "https://example.com/"),
      browserTab("two", "http://localhost:3000/", { folderId: null }),
      // Never loaded: falls back to the address it was opened with.
      browserTab("three", "https://never.example/", { title: "never.example" }),
    ]
    const states = new Map<string, BrowserTabState>([
      ["browser:one", state()],
      [
        "browser:two",
        state({
          url: "",
          requestedUrl: "http://localhost:3000/app",
          title: "",
        }),
      ],
    ])
    expect(snapshotBrowserTabs(tabs, (id) => states.get(id) ?? null)).toEqual([
      {
        url: "https://example.com/deep",
        title: "Deep page",
        folderId: 1,
        profile: "default",
      },
      // No committed URL yet, no title: the requested address and the record.
      {
        url: "http://localhost:3000/app",
        title: "example.com",
        folderId: null,
        profile: "default",
      },
      {
        url: "https://never.example/",
        title: "never.example",
        folderId: 1,
        profile: "default",
      },
    ])
  })

  it("skips a tab whose live address is not a web page", () => {
    const tabs = [browserTab("one", "https://example.com/")]
    const states = new Map([
      ["browser:one", state({ url: "about:blank", requestedUrl: "" })],
    ])
    // `about:blank` is what a surface shows before its first navigation;
    // restoring it would bring back a blank tab.
    expect(snapshotBrowserTabs(tabs, (id) => states.get(id) ?? null)).toEqual([
      {
        url: "https://example.com/",
        title: "Deep page",
        folderId: 1,
        profile: "default",
      },
    ])
  })

  it("compares snapshots field by field", () => {
    const a: PersistedBrowserTab[] = [
      {
        url: "https://a.example/",
        title: "A",
        folderId: 1,
        profile: "default",
      },
    ]
    expect(samePersistedBrowserTabs(a, [...a])).toBe(true)
    expect(
      samePersistedBrowserTabs(a, [
        {
          url: "https://a.example/",
          title: "A2",
          folderId: 1,
          profile: "default",
        },
      ])
    ).toBe(false)
    expect(
      samePersistedBrowserTabs(a, [
        {
          url: "https://a.example/",
          title: "A",
          folderId: 2,
          profile: "default",
        },
      ])
    ).toBe(false)
    expect(
      samePersistedBrowserTabs(a, [
        {
          url: "https://a.example/",
          title: "A",
          folderId: 1,
          profile: "p-work",
        },
      ])
    ).toBe(false)
    expect(
      samePersistedBrowserTabs(a, [
        {
          url: "https://a.example/",
          title: "A",
          folderId: 1,
          profile: "default",
          remote: true,
        },
      ])
    ).toBe(false)
    expect(samePersistedBrowserTabs(a, [])).toBe(false)
  })
})

describe("selectBrowserTabsToSuspend", () => {
  const now = 1_000_000

  it("releases only loaded tabs that have been off screen long enough", () => {
    expect(
      selectBrowserTabsToSuspend(
        [
          // On screen right now.
          { id: "visible", hiddenAt: null, loaded: true },
          // Hidden, but not for long enough.
          { id: "recent", hiddenAt: now - 5_000, loaded: true },
          { id: "idle", hiddenAt: now - 60_000, loaded: true },
          // Already unloaded (restored, or suspended earlier).
          { id: "unloaded", hiddenAt: now - 60_000, loaded: false },
          // Never shown: no surface was ever created for it.
          { id: "never", hiddenAt: undefined, loaded: false },
        ],
        now,
        30_000
      )
    ).toEqual(["idle"])
  })

  it("is exact at the threshold", () => {
    const at = [{ id: "x", hiddenAt: now - 30_000, loaded: true }]
    expect(selectBrowserTabsToSuspend(at, now, 30_000)).toEqual(["x"])
    expect(selectBrowserTabsToSuspend(at, now, 30_001)).toEqual([])
  })
})
