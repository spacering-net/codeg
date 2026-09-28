import { describe, expect, it, vi } from "vitest"

import { textTokenAt } from "@/lib/text-token-at"

import { composerTokenOpenTarget } from "./composer-token-action"

// `link-safety` reaches the desktop opener and the transport at import time;
// neither is exercised here — `composerTokenOpenTarget` only asks it what the
// opener *could* handle.
vi.mock("@/lib/platform", () => ({
  isDesktop: () => false,
  openUrl: vi.fn(),
}))
vi.mock("@/lib/transport", () => ({
  isDesktop: () => false,
  getActiveRemoteConnectionId: () => null,
}))

/** The token the composer would hand the menu for `text`. */
function tokenIn(text: string) {
  const token = textTokenAt(text, 1)
  expect(token).not.toBeNull()
  return token
}

describe("composerTokenOpenTarget", () => {
  it("has nowhere to send a plain word", () => {
    expect(composerTokenOpenTarget(tokenIn("refactor"))).toBeNull()
  })

  it("has nowhere to send a bare repo-relative path", () => {
    // Resolving it needs a folder — that belongs to the transcript's file badge,
    // not to a half-typed draft.
    expect(composerTokenOpenTarget(tokenIn("src/lib/utils.ts"))).toBeNull()
  })

  it("sends an address through mailto and a link through itself", () => {
    expect(composerTokenOpenTarget(tokenIn("adam@example.com"))).toBe(
      "mailto:adam@example.com"
    )
    expect(composerTokenOpenTarget(tokenIn("https://example.com/a"))).toBe(
      "https://example.com/a"
    )
    expect(composerTokenOpenTarget(tokenIn("example.com/a"))).toBe(
      "https://example.com/a"
    )
  })

  it("sends a self-locating path as itself", () => {
    expect(composerTokenOpenTarget(tokenIn("/var/log/app.log:42"))).toBe(
      "/var/log/app.log:42"
    )
    expect(composerTokenOpenTarget(tokenIn("~/.config/codeg"))).toBe(
      "~/.config/codeg"
    )
  })

  it("offers no row for a url the opener would refuse", () => {
    // These classify as links, but the opener's protocol allow-list is http(s)
    // /mailto/tel — a row for them could only ever reach its failure toast.
    for (const url of [
      "ftp://files.example.com",
      "vscode://file/tmp/a.ts",
      "slack://channel?id=1",
      "chrome://settings",
      "javascript://x%0aalert(1)",
    ]) {
      expect(composerTokenOpenTarget(tokenIn(url))).toBeNull()
    }
  })

  it("offers no row for a protocol-relative url read as a path", () => {
    // `//cdn.example.com/app.js` classifies as a path but is a WEB url, which
    // the opener would load as https — a destination the "Open file" label on a
    // path token would describe wrongly.
    expect(composerTokenOpenTarget(tokenIn("//cdn.example.com/app.js"))).toBe(
      null
    )
  })

  it("has nowhere to send nothing", () => {
    expect(composerTokenOpenTarget(null)).toBeNull()
  })
})
