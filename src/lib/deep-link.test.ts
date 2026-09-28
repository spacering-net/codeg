import { beforeEach, describe, expect, it, vi } from "vitest"

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

import { takePendingDeepLink } from "./deep-link"

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
