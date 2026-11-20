import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  shellCall: vi.fn(),
  transportCall: vi.fn(),
}))

vi.mock("@/lib/transport", () => ({
  getShellTransport: () => ({ call: mocks.shellCall }),
  getTransport: () => ({ call: mocks.transportCall }),
}))

import { closePetWindow, isPetWindowOpen, openPetWindow } from "./api"

describe("pet window shell commands", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("routes desktop pet window controls to the local shell transport", async () => {
    mocks.shellCall.mockResolvedValueOnce(undefined)
    mocks.shellCall.mockResolvedValueOnce(true)
    mocks.shellCall.mockResolvedValueOnce(undefined)

    await openPetWindow()
    const open = await isPetWindowOpen()
    await closePetWindow()

    expect(open).toBe(true)
    expect(mocks.shellCall).toHaveBeenNthCalledWith(1, "open_pet_window")
    expect(mocks.shellCall).toHaveBeenNthCalledWith(2, "is_pet_window_open")
    expect(mocks.shellCall).toHaveBeenNthCalledWith(3, "close_pet_window")
    expect(mocks.transportCall).not.toHaveBeenCalled()
  })
})
