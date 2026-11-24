import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  call: vi.fn(),
  isDesktop: vi.fn(() => true),
  isRemoteDesktopMode: vi.fn(() => false),
}))

vi.mock("@/lib/transport", () => ({
  getTransport: () => ({ call: mocks.call }),
  isDesktop: mocks.isDesktop,
  isRemoteDesktopMode: mocks.isRemoteDesktopMode,
}))

import { takePendingDeepLink, takePendingHarnessLink } from "./deep-link"

describe("takePendingDeepLink", () => {
  beforeEach(() => {
    mocks.call.mockReset()
    mocks.isDesktop.mockReturnValue(true)
    mocks.isRemoteDesktopMode.mockReturnValue(false)
  })

  it("returns the parked target", async () => {
    mocks.call.mockResolvedValue({
      folderId: 3,
      conversationId: 9,
      agent: "grok",
    })
    await expect(takePendingDeepLink()).resolves.toEqual({
      folderId: 3,
      conversationId: 9,
      agent: "grok",
    })
    expect(mocks.call).toHaveBeenCalledWith("take_pending_deep_link")
  })

  it("returns null when nothing was parked", async () => {
    mocks.call.mockResolvedValue(null)
    await expect(takePendingDeepLink()).resolves.toBeNull()
  })

  it("rejects a half-formed target rather than opening tab NaN", async () => {
    mocks.call.mockResolvedValue({ folderId: 3, conversationId: 9 })
    await expect(takePendingDeepLink()).resolves.toBeNull()
  })

  // Browser-only mode has no OS scheme, and a remote-workspace window's
  // transport targets a codeg-server that never registered this command —
  // both must stay off the wire, not fail an invoke on every workspace mount.
  it("does not call the backend outside a local desktop window", async () => {
    mocks.isDesktop.mockReturnValue(false)
    await expect(takePendingDeepLink()).resolves.toBeNull()

    mocks.isDesktop.mockReturnValue(true)
    mocks.isRemoteDesktopMode.mockReturnValue(true)
    await expect(takePendingDeepLink()).resolves.toBeNull()

    expect(mocks.call).not.toHaveBeenCalled()
  })

  it("swallows a transport failure", async () => {
    mocks.call.mockRejectedValue(new Error("no such command"))
    await expect(takePendingDeepLink()).resolves.toBeNull()
  })
})

describe("takePendingHarnessLink", () => {
  beforeEach(() => {
    mocks.call.mockReset()
    mocks.isDesktop.mockReturnValue(true)
    mocks.isRemoteDesktopMode.mockReturnValue(false)
  })
  afterEach(() => vi.restoreAllMocks())

  it("returns the parked item address", async () => {
    mocks.call.mockResolvedValue("acme/pdf-tools")
    await expect(takePendingHarnessLink()).resolves.toBe("acme/pdf-tools")
    // Its own slot, and no arguments.
    expect(mocks.call).toHaveBeenCalledWith("take_pending_harness_link")
    expect(mocks.call).not.toHaveBeenCalledWith("take_pending_deep_link")
  })

  it("returns null when nothing was parked", async () => {
    mocks.call.mockResolvedValue(null)
    await expect(takePendingHarnessLink()).resolves.toBeNull()
  })

  // The backend validates it already; what reaches the Harness page is still
  // checked here.
  it.each([
    "acme",
    "../../other/name",
    "acme/pdf/extra",
    "https://spacering.net/harness/acme/pdf",
    "",
    42,
    { ref: "acme/pdf-tools" },
  ])("refuses %j, which is not an item address", async (value) => {
    mocks.call.mockResolvedValue(value)
    await expect(takePendingHarnessLink()).resolves.toBeNull()
  })

  // A link opens the item on this computer: a remote workspace window never
  // claims one, and browser-only mode has no OS scheme to claim from.
  it("does not call the backend outside a local desktop window", async () => {
    mocks.isDesktop.mockReturnValue(false)
    await expect(takePendingHarnessLink()).resolves.toBeNull()

    mocks.isDesktop.mockReturnValue(true)
    mocks.isRemoteDesktopMode.mockReturnValue(true)
    await expect(takePendingHarnessLink()).resolves.toBeNull()

    expect(mocks.call).not.toHaveBeenCalled()
  })

  // Until the desktop half has the command, Tauri answers with exactly this.
  it("takes a backend without the command for one with nothing parked, quietly", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const error = vi.spyOn(console, "error").mockImplementation(() => {})
    const debug = vi.spyOn(console, "debug").mockImplementation(() => {})
    mocks.call.mockRejectedValue("Command take_pending_harness_link not found")

    await expect(takePendingHarnessLink()).resolves.toBeNull()
    expect(warn).not.toHaveBeenCalled()
    expect(error).not.toHaveBeenCalled()
    expect(debug).toHaveBeenCalledTimes(1)
  })

  it("swallows any other failure, with a warning", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    mocks.call.mockRejectedValue(new Error("ipc closed"))
    await expect(takePendingHarnessLink()).resolves.toBeNull()
    expect(warn).toHaveBeenCalledTimes(1)
  })
})
