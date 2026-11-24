import { describe, expect, it } from "vitest"

import { DEFAULT_BROWSER_PREFS, LINK_SOURCES } from "./browser/browser-prefs"
import {
  matchHostRule,
  resolveLinkAction,
  type LinkSurface,
  type ResolveLinkContext,
} from "./resolve-link-action"

const desktopSurface: LinkSurface = {
  builtinAvailable: true,
  fileColumnVisible: true,
  viewerHostAvailable: true,
  remoteDesktop: false,
}

const webSurface: LinkSurface = {
  builtinAvailable: false,
  fileColumnVisible: true,
  viewerHostAvailable: false,
  remoteDesktop: false,
}

function ctx(overrides: Partial<ResolveLinkContext> = {}): ResolveLinkContext {
  return {
    source: "transcript",
    modifier: false,
    surface: desktopSurface,
    prefs: DEFAULT_BROWSER_PREFS,
    ...overrides,
  }
}

const systemPrefs = {
  defaultTarget: {
    transcript: "system",
    toolCard: "system",
    terminal: "system",
    editor: "system",
    notification: "system",
  },
} as const

describe("resolveLinkAction — classification passthrough", () => {
  it("routes local paths to the file panel untouched", () => {
    expect(resolveLinkAction("/repo/a.ts:12", ctx())).toEqual({
      kind: "file",
      target: { path: "/repo/a.ts", line: 12 },
    })
  })

  it("routes mailto/tel to the OS handler", () => {
    expect(resolveLinkAction("mailto:x@y.z", ctx())).toEqual({
      kind: "os-handler",
      protocol: "mailto:",
      url: "mailto:x@y.z",
    })
  })

  it.each(["vscode://file/x", "javascript:alert(1)", "src/main.rs"])(
    "still rejects %s (unknown scheme is never handed to the OS)",
    (url) => {
      expect(resolveLinkAction(url, ctx())).toEqual({
        kind: "reject",
        reason: "unsupported-scheme",
        url,
      })
    }
  )

  it("rejects empty input", () => {
    expect(resolveLinkAction("  ", ctx())).toMatchObject({
      kind: "reject",
      reason: "empty",
    })
  })

  it("canonicalizes a protocol-relative URL before deciding", () => {
    expect(resolveLinkAction("//example.com/x", ctx())).toMatchObject({
      kind: "builtin",
      url: "https://example.com/x",
    })
  })
})

describe("resolveLinkAction — base target and preferences", () => {
  it.each(LINK_SOURCES)("defaults %s to the built-in browser", (source) => {
    expect(resolveLinkAction("https://example.com", ctx({ source }))).toEqual({
      kind: "builtin",
      url: "https://example.com",
      placement: "tab",
      remoteOverride: false,
      remote: false,
    })
  })

  it.each(LINK_SOURCES)(
    "honours a per-source system preference for %s",
    (source) => {
      const prefs = {
        defaultTarget: {
          ...DEFAULT_BROWSER_PREFS.defaultTarget,
          [source]: "system" as const,
        },
      }
      expect(
        resolveLinkAction("https://example.com", ctx({ source, prefs }))
      ).toEqual({ kind: "system", url: "https://example.com" })
      // Other sources are unaffected.
      const other = LINK_SOURCES.find((s) => s !== source)!
      expect(
        resolveLinkAction("https://example.com", ctx({ source: other, prefs }))
      ).toMatchObject({ kind: "builtin" })
    }
  )

  it("is always system when no built-in browser is available (web mode)", () => {
    expect(
      resolveLinkAction("https://example.com", ctx({ surface: webSurface }))
    ).toEqual({ kind: "system", url: "https://example.com" })
    expect(
      resolveLinkAction(
        "https://example.com",
        ctx({ surface: webSurface, modifier: true })
      )
    ).toEqual({ kind: "system", url: "https://example.com" })
    expect(
      resolveLinkAction(
        "https://example.com",
        ctx({ surface: webSurface, forceTarget: "builtin" })
      )
    ).toEqual({ kind: "system", url: "https://example.com" })
  })
})

describe("resolveLinkAction — modifier inversion", () => {
  it("inverts builtin → system", () => {
    expect(
      resolveLinkAction("https://example.com", ctx({ modifier: true }))
    ).toEqual({ kind: "system", url: "https://example.com" })
  })

  it("inverts system → builtin", () => {
    expect(
      resolveLinkAction(
        "https://example.com",
        ctx({ modifier: true, prefs: systemPrefs })
      )
    ).toMatchObject({ kind: "builtin", remoteOverride: false })
  })

  it("applies to every source the same way", () => {
    for (const source of LINK_SOURCES) {
      expect(
        resolveLinkAction(
          "https://example.com",
          ctx({ source, modifier: true })
        )
      ).toMatchObject({ kind: "system" })
    }
  })
})

describe("resolveLinkAction — explicit choice (context menu)", () => {
  it("forceTarget replaces the preference", () => {
    expect(
      resolveLinkAction("https://example.com", ctx({ forceTarget: "system" }))
    ).toEqual({ kind: "system", url: "https://example.com" })
    expect(
      resolveLinkAction(
        "https://example.com",
        ctx({ forceTarget: "builtin", prefs: systemPrefs })
      )
    ).toMatchObject({ kind: "builtin" })
  })

  it("forceTarget ignores the modifier", () => {
    expect(
      resolveLinkAction(
        "https://example.com",
        ctx({ forceTarget: "system", modifier: true })
      )
    ).toEqual({ kind: "system", url: "https://example.com" })
  })
})

describe("resolveLinkAction — host rules", () => {
  const hostRules = [
    { pattern: "blocked.example", action: "block" as const },
    { pattern: "*.corp.example:8443", action: "system" as const },
    { pattern: "*.corp.example", action: "builtin" as const },
    { pattern: "localhost", action: "builtin" as const },
  ]

  it("block is terminal: not invertible, not forceable", () => {
    for (const extra of [
      {},
      { modifier: true },
      { forceTarget: "system" as const },
      { forceTarget: "builtin" as const },
    ]) {
      expect(
        resolveLinkAction(
          "https://blocked.example/path",
          ctx({ hostRules, ...extra })
        )
      ).toEqual({
        kind: "reject",
        reason: "blocked-host",
        url: "https://blocked.example/path",
      })
    }
  })

  it("a builtin/system rule is the base target and stays invertible", () => {
    expect(
      resolveLinkAction(
        "https://wiki.corp.example/",
        ctx({ hostRules, prefs: systemPrefs })
      )
    ).toMatchObject({ kind: "builtin" })
    expect(
      resolveLinkAction(
        "https://wiki.corp.example/",
        ctx({ hostRules, prefs: systemPrefs, modifier: true })
      )
    ).toMatchObject({ kind: "system" })
  })

  it("the most specific rule wins and ports pin a rule", () => {
    expect(
      resolveLinkAction("https://sso.corp.example:8443/", ctx({ hostRules }))
    ).toMatchObject({ kind: "system" })
    expect(
      resolveLinkAction("https://sso.corp.example/", ctx({ hostRules }))
    ).toMatchObject({ kind: "builtin" })
    // Order in the table does not matter: an exact host beats a wildcard.
    const reversed = [
      { pattern: "*.corp.example", action: "system" as const },
      { pattern: "wiki.corp.example", action: "builtin" as const },
    ]
    expect(
      resolveLinkAction(
        "https://wiki.corp.example/",
        ctx({ hostRules: reversed })
      )
    ).toMatchObject({ kind: "builtin" })
  })

  it("the administrator's rules are consulted before the user's", () => {
    const managedHostRules = [
      { pattern: "*.internal.example", action: "block" as const },
    ]
    // A more specific user rule does not lift a managed block …
    expect(
      resolveLinkAction(
        "https://wiki.internal.example/",
        ctx({
          managedHostRules,
          hostRules: [
            { pattern: "wiki.internal.example", action: "builtin" as const },
          ],
        })
      )
    ).toMatchObject({ kind: "reject", reason: "blocked-host" })
    // … and a host the managed table says nothing about falls through.
    expect(
      resolveLinkAction(
        "https://example.com/",
        ctx({
          managedHostRules,
          hostRules: [{ pattern: "example.com", action: "system" as const }],
        })
      )
    ).toMatchObject({ kind: "system" })
  })

  it("matchHostRule: wildcard semantics", () => {
    const rules = [{ pattern: "*.example.com", action: "block" as const }]
    expect(
      matchHostRule(rules, new URL("https://a.example.com/"))
    ).not.toBeNull()
    expect(
      matchHostRule(rules, new URL("https://a.b.example.com/"))
    ).not.toBeNull()
    expect(matchHostRule(rules, new URL("https://example.com/"))).toBeNull()
    expect(matchHostRule(rules, new URL("https://notexample.com/"))).toBeNull()
    expect(
      matchHostRule([{ pattern: "*", action: "system" }], new URL("http://x/"))
    ).not.toBeNull()
    expect(
      matchHostRule(
        [{ pattern: "[::1]:3000", action: "builtin" }],
        new URL("http://[::1]:3000/")
      )
    ).not.toBeNull()
    expect(
      matchHostRule(
        [{ pattern: "example.com:443", action: "builtin" }],
        new URL("https://EXAMPLE.com/")
      )
    ).not.toBeNull()
    expect(
      matchHostRule(
        [{ pattern: "example.com:80", action: "builtin" }],
        new URL("https://example.com/")
      )
    ).toBeNull()
  })
})

describe("resolveLinkAction — remote workspace override", () => {
  const remote: LinkSurface = { ...desktopSurface, remoteDesktop: true }

  it.each([
    "http://localhost:3000/",
    "http://127.0.0.1:8080/x",
    "http://[::1]:5173/",
    "http://192.168.1.10:3000/",
    "http://api.internal.local/",
  ])("%s in a remote window opens built-in with the remote flag", (url) => {
    expect(resolveLinkAction(url, ctx({ surface: remote }))).toEqual({
      kind: "builtin",
      url,
      placement: "tab",
      remoteOverride: true,
      remote: true,
    })
  })

  it("cannot be inverted or forced to the system browser", () => {
    expect(
      resolveLinkAction(
        "http://localhost:3000/",
        ctx({ surface: remote, modifier: true })
      )
    ).toMatchObject({ kind: "builtin", remoteOverride: true })
    expect(
      resolveLinkAction(
        "http://localhost:3000/",
        ctx({ surface: remote, forceTarget: "system", prefs: systemPrefs })
      )
    ).toMatchObject({ kind: "builtin", remoteOverride: true })
  })

  // The window reaches its server directly: the server's own private
  // address is reachable from here, and follows the ordinary rules.
  it("leaves the server's own private address to the ordinary rules", () => {
    expect(
      resolveLinkAction(
        "http://192.168.1.5:3000/",
        ctx({ surface: { ...remote, remoteServerHost: "192.168.1.5" } })
      )
    ).toMatchObject({ kind: "builtin", remoteOverride: false, remote: false })
    // Another private address is still the remote host's.
    expect(
      resolveLinkAction(
        "http://192.168.1.6:3000/",
        ctx({ surface: { ...remote, remoteServerHost: "192.168.1.5" } })
      )
    ).toMatchObject({ kind: "builtin", remoteOverride: true, remote: true })
  })

  it("does not apply to public hosts in a remote window", () => {
    expect(
      resolveLinkAction(
        "https://github.com/",
        ctx({ surface: remote, prefs: systemPrefs })
      )
    ).toEqual({ kind: "system", url: "https://github.com/" })
    // A public page is the same page from here: an ordinary tab of this
    // computer, not a remote one.
    expect(
      resolveLinkAction("https://github.com/", ctx({ surface: remote }))
    ).toMatchObject({ kind: "builtin", remoteOverride: false, remote: false })
  })

  it("falls back to the ordinary rules when no built-in browser exists", () => {
    expect(
      resolveLinkAction(
        "http://localhost:3000/",
        ctx({ surface: { ...remote, builtinAvailable: false } })
      )
    ).toEqual({ kind: "system", url: "http://localhost:3000/" })
  })
})

describe("resolveLinkAction — placement", () => {
  it("uses the file column when it is visible", () => {
    expect(resolveLinkAction("https://example.com", ctx())).toMatchObject({
      placement: "tab",
    })
  })

  it("uses the viewer drawer on a full-page route", () => {
    expect(
      resolveLinkAction(
        "https://example.com",
        ctx({ surface: { ...desktopSurface, fileColumnVisible: false } })
      )
    ).toMatchObject({ placement: "drawer" })
  })

  it("falls back to the column when no viewer host exists", () => {
    expect(
      resolveLinkAction(
        "https://example.com",
        ctx({
          surface: {
            ...desktopSurface,
            fileColumnVisible: false,
            viewerHostAvailable: false,
          },
        })
      )
    ).toMatchObject({ placement: "tab" })
  })
})

describe("resolveLinkAction — web mode with the port bridge", () => {
  const bridged: LinkSurface = { ...webSurface, bridgeAvailable: true }

  it.each([
    "http://localhost:3000/",
    "http://127.0.0.1:8080/x?y=1",
    "http://[::1]:5173/",
    "http://0.0.0.0:3000/",
    "http://app.localhost:4000/",
  ])("%s opens built-in through the bridge", (url) => {
    expect(resolveLinkAction(url, ctx({ surface: bridged }))).toEqual({
      kind: "builtin",
      url,
      placement: "tab",
      remoteOverride: true,
      remote: false,
    })
  })

  it("cannot be inverted or forced to the system browser", () => {
    expect(
      resolveLinkAction(
        "http://localhost:3000/",
        ctx({ surface: bridged, modifier: true })
      )
    ).toMatchObject({ kind: "builtin", remoteOverride: true })
    expect(
      resolveLinkAction(
        "http://localhost:3000/",
        ctx({ surface: bridged, forceTarget: "system", prefs: systemPrefs })
      )
    ).toMatchObject({ kind: "builtin", remoteOverride: true })
  })

  it("lands in the drawer under a full-page route", () => {
    expect(
      resolveLinkAction(
        "http://localhost:3000/",
        ctx({
          surface: {
            ...bridged,
            fileColumnVisible: false,
            viewerHostAvailable: true,
          },
        })
      )
    ).toMatchObject({ kind: "builtin", placement: "drawer" })
  })

  it.each([
    "https://localhost:3000/",
    "http://192.168.1.10:3000/",
    "http://api.internal.local/",
    "https://example.com/",
  ])("%s still goes to a new tab: only loopback http is bridged", (url) => {
    expect(resolveLinkAction(url, ctx({ surface: bridged }))).toEqual({
      kind: "system",
      url,
    })
  })

  it("leaves the new-tab behaviour without the bridge, and yields to a block rule", () => {
    expect(
      resolveLinkAction("http://localhost:3000/", ctx({ surface: webSurface }))
    ).toEqual({ kind: "system", url: "http://localhost:3000/" })
    expect(
      resolveLinkAction(
        "http://localhost:3000/",
        ctx({
          surface: bridged,
          hostRules: [{ pattern: "localhost", action: "block" }],
        })
      )
    ).toMatchObject({ kind: "reject", reason: "blocked-host" })
  })

  it("is ignored on the desktop, where the native tab wins", () => {
    expect(
      resolveLinkAction(
        "http://localhost:3000/",
        ctx({ surface: { ...desktopSurface, bridgeAvailable: true } })
      )
    ).toEqual({
      kind: "builtin",
      url: "http://localhost:3000/",
      placement: "tab",
      remoteOverride: false,
      remote: false,
    })
  })
})
