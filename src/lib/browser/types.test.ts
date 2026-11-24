import { describe, expect, it } from "vitest"

import type {
  AgentGrant,
  AgentGrantPayload,
  BrowserCapabilities,
  BrowserNavigationBlockedPayload,
  BrowserPopupPayload,
  BrowserTabState,
  FrozenFrame,
  PageSnapshot,
} from "./types"

// These literals are copied from what the Rust side serializes (see the
// `wire_names_are_camel_and_kebab` test in src-tauri/src/browser/types.rs and
// the P0 puppet output). If a field is renamed on one side, `satisfies` fails
// here and the Rust test fails there.
describe("browser wire types", () => {
  it("matches the Rust serialization of BrowserTabState", () => {
    const state = {
      tabId: "t1",
      ownerWindow: "main",
      kind: "page",
      surface: "child",
      channel: "native",
      channelError: null,
      url: "https://example.com/",
      requestedUrl: "https://example.com/",
      title: "Example Domain",
      favicon: null,
      loading: false,
      canGoBack: false,
      canGoForward: false,
      origin: "https://example.com",
      zoom: 1.0,
      error: null,
      remoteHost: null,
      openerTabId: null,
      profile: "default",
      agentGrant: null,
    } satisfies BrowserTabState
    expect(state.surface).toBe("child")
  })

  it("matches the Rust serialization of BrowserCapabilities and popups", () => {
    const caps = {
      available: true,
      surface: "child",
      platform: "macos",
      channel: "degraded",
      reasons: ["page channel not installed yet"],
      isolatedStorage: true,
      proxy: {
        url: "http://127.0.0.1:7890",
        applies: "live",
        reason: null,
      },
      downloadsDir: "/Users/dev/Downloads",
      docGuest: false,
      profiles: false,
      signInUserAgent: false,
      ownedWindowControls: false,
      remoteEgress: false,
      policy: {
        enabled: true,
        managedRules: [{ pattern: "*.internal.example", action: "block" }],
        managedSource: "/etc/codeg/policy.json",
      },
    } satisfies BrowserCapabilities
    const popup = {
      presentation: "adopted",
      openerTabId: "t1",
      tabId: "t1-p1",
      url: "http://127.0.0.1:8765/popup.html",
      requestedSize: [520, 640],
      reason: null,
      profile: "p-work",
    } satisfies BrowserPopupPayload
    expect(caps.available && popup.presentation === "adopted").toBe(true)
  })

  it("matches the Rust serialization of an agent grant and what it unlocks", () => {
    const shared = {
      level: "read",
      origin: "https://example.com",
      grantedAt: 1_700_000_000_000,
    } satisfies AgentGrant
    // The page left the origin it was shared for, so the grant ended without
    // anyone pressing anything: `level` says what it is now, `change` says
    // that the user did not choose it, `origin` says what was lost.
    const revoked = {
      tabId: "t1",
      change: "navigated",
      level: "none",
      origin: "https://example.com",
    } satisfies AgentGrantPayload
    const snapshot = {
      generation: "3.1.nav-7",
      url: "https://example.com/orders",
      title: "Orders",
      viewport: { width: 1280, height: 800, dpr: 2 },
      tree: '- button "Export" [ref=e4]',
      refsCount: 1,
      truncated: false,
    } satisfies PageSnapshot
    expect([shared.level, revoked.level, snapshot.refsCount]).toEqual([
      "read",
      "none",
      1,
    ])
  })

  it("matches the Rust serialization of the blocked-navigation event and the freeze frame", () => {
    const blocked = {
      tabId: "t1",
      url: "https://blocked.example/",
      reason: "host-rule",
    } satisfies BrowserNavigationBlockedPayload
    const frame = {
      mime: "image/jpeg",
      data: "AAAA",
      width: 10,
      height: 4,
    } satisfies FrozenFrame
    expect(blocked.reason === "host-rule" && frame.mime).toBe("image/jpeg")
  })
})
