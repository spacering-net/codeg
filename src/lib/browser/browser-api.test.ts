import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

type Call = (command: string, args?: unknown) => Promise<unknown>

const mocks = vi.hoisted(() => ({
  shell: vi.fn<Call>(() => Promise.resolve({ available: true })),
  remote: vi.fn<Call>(() => Promise.reject(new Error("501"))),
}))

// A window bound to a remote codeg-server: `getTransport()` talks to that
// host, `getShellTransport()` to this app's own backend.
vi.mock("@/lib/transport", () => ({
  getShellTransport: () => ({ call: mocks.shell }),
  getTransport: () => ({ call: mocks.remote }),
  isDesktop: () => true,
}))

import {
  browserCapabilities,
  browserNavigate,
  browserOpenTab,
  resetBrowserCapabilitiesCacheForTests,
} from "./browser-api"

describe("browser commands in a remote workspace window", () => {
  beforeEach(() => {
    resetBrowserCapabilitiesCacheForTests()
    mocks.shell.mockClear()
    mocks.remote.mockClear()
  })
  afterEach(() => resetBrowserCapabilitiesCacheForTests())

  // The built-in browser is a webview of THIS computer; the remote host has
  // none, and asked it would answer that there is no browser at all.
  it("go to this app's own backend, never to the remote host", async () => {
    await expect(browserCapabilities()).resolves.toMatchObject({
      available: true,
    })
    await browserNavigate("abc", "https://example.com/")
    await browserOpenTab({
      tabId: "abc",
      url: "https://example.com/",
      bounds: { x: 0, y: 0, width: 800, height: 600 },
    })
    expect(mocks.shell.mock.calls.map((call) => call[0])).toEqual([
      "browser_capabilities",
      "browser_navigate",
      "browser_open_tab",
    ])
    expect(mocks.remote).not.toHaveBeenCalled()
  })
})
