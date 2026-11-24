import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  desktop: false,
  remote: null as number | null,
  openUrl: vi.fn(() => Promise.resolve()),
}))
vi.mock("@/lib/transport", () => ({
  isDesktop: () => mocks.desktop,
  getActiveRemoteConnectionId: () => mocks.remote,
}))
vi.mock("@/lib/platform", () => ({ openUrl: mocks.openUrl }))

import { openInSystemBrowser, openWithOsHandler } from "./link-open"

describe("link-open", () => {
  beforeEach(() => {
    mocks.desktop = false
    mocks.remote = null
    mocks.openUrl.mockClear()
    vi.spyOn(window, "open").mockReturnValue(null)
  })
  afterEach(() => vi.restoreAllMocks())

  it("web mode: system browser = synchronous window.open with noreferrer", async () => {
    await openInSystemBrowser("https://example.com/")
    expect(window.open).toHaveBeenCalledWith(
      "https://example.com/",
      "_blank",
      "noreferrer"
    )
    expect(mocks.openUrl).not.toHaveBeenCalled()
  })

  it("desktop (local and remote): system browser = the opener plugin", async () => {
    mocks.desktop = true
    await openInSystemBrowser("https://example.com/")
    mocks.remote = 3
    await openInSystemBrowser("https://example.com/2")
    expect(mocks.openUrl).toHaveBeenCalledTimes(2)
    expect(window.open).not.toHaveBeenCalled()
  })

  it("mailto/tel: synthetic anchor on web and remote windows, opener plugin locally", async () => {
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => {})
    await openWithOsHandler("mailto:a@b.c")
    expect(click).toHaveBeenCalledTimes(1)
    mocks.desktop = true
    mocks.remote = 7
    await openWithOsHandler("tel:+1")
    expect(click).toHaveBeenCalledTimes(2)
    mocks.remote = null
    await openWithOsHandler("tel:+2")
    expect(mocks.openUrl).toHaveBeenCalledWith("tel:+2")
  })
})
