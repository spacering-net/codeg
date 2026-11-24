import { describe, expect, it, vi } from "vitest"
import { deliverQueuedSteer } from "./queued-steer"

describe("queued native insert", () => {
  it("reports delivery without reordering the row when the insert lands", async () => {
    const steer = vi.fn(async () => {})
    const prioritize = vi.fn()
    expect(await deliverQueuedSteer(steer, prioritize)).toBe(true)
    expect(steer).toHaveBeenCalledOnce()
    expect(prioritize).not.toHaveBeenCalled()
  })

  it("prioritizes the queued row without sending when the turn ended before insertion", async () => {
    const steer = vi.fn(async () => {
      throw new Error("no active turn for feedback")
    })
    const prioritize = vi.fn()
    expect(await deliverQueuedSteer(steer, prioritize)).toBe(false)
    expect(steer).toHaveBeenCalledOnce()
    expect(prioritize).toHaveBeenCalledOnce()
  })

  it("rethrows any other failure and leaves the row where it was", async () => {
    const failure = new Error("connection lost")
    const prioritize = vi.fn()
    await expect(
      deliverQueuedSteer(async () => {
        throw failure
      }, prioritize)
    ).rejects.toBe(failure)
    expect(prioritize).not.toHaveBeenCalled()
  })

  it("does not prioritize or report delivery when the turn is busy", async () => {
    const failure = new Error("turn already in progress")
    const prioritize = vi.fn()
    await expect(
      deliverQueuedSteer(async () => {
        throw failure
      }, prioritize)
    ).rejects.toBe(failure)
    expect(prioritize).not.toHaveBeenCalled()
  })
})
