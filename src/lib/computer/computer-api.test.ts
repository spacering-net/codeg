import { act, renderHook, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

const platform = vi.hoisted(() => ({
  local: false,
  reconnect: null as (() => void) | null,
}))
vi.mock("@/lib/platform", () => ({
  isLocalDesktop: () => platform.local,
  onTransportReconnect: (callback: () => void) => {
    platform.reconnect = callback
    return () => {}
  },
}))
const transport = vi.hoisted(() => ({ call: vi.fn() }))
vi.mock("@/lib/transport", () => ({ getTransport: () => transport }))

import {
  askComputerServed,
  computerAvailable,
  computerServerPlatform,
  resetComputerServedForTest,
  useComputerAvailable,
} from "./computer-api"

beforeEach(() => {
  vi.clearAllMocks()
  platform.local = false
  platform.reconnect = null
  resetComputerServedForTest()
})

describe("computer use availability", () => {
  /** The desktop app on its own machine has it, and asks no one. */
  it("is there on the desktop's own machine without asking", async () => {
    platform.local = true
    expect(computerAvailable()).toBe(true)
    expect(await askComputerServed()).toBe(true)
    expect(computerServerPlatform()).toBeNull()
    expect(transport.call).not.toHaveBeenCalled()
  })

  /** A web window has it only once its server says it shares its screen —
   * asked once, and the server's machine is the one that counts. */
  it("follows what the server says, asked once", async () => {
    transport.call.mockResolvedValue({ available: true, platform: "windows" })
    expect(computerAvailable()).toBe(false)
    const { result } = renderHook(() => useComputerAvailable())
    expect(result.current).toBe(false)
    await waitFor(() => expect(result.current).toBe(true))
    expect(computerServerPlatform()).toBe("windows")
    await act(async () => {
      await askComputerServed()
    })
    expect(transport.call).toHaveBeenCalledTimes(1)
    expect(transport.call).toHaveBeenCalledWith("computer_available", {})
  })

  /** A server that does not share its screen has none. */
  it("is not there where the server does not serve it", async () => {
    transport.call.mockResolvedValue({ available: false, platform: "linux" })
    expect(await askComputerServed()).toBe(false)
    expect(computerAvailable()).toBe(false)
    expect(await askComputerServed()).toBe(false)
    expect(transport.call).toHaveBeenCalledTimes(1)
  })

  /** No answer — the server restarting, out of reach, too old to say — is
   * not "no": the next call asks again, and so does the transport coming
   * back, which also hears a server restarted with computer use on. */
  it("asks again after no answer, and once the transport is back", async () => {
    transport.call.mockRejectedValueOnce(new Error("offline"))
    expect(await askComputerServed()).toBe(false)
    expect(computerAvailable()).toBe(false)

    transport.call.mockResolvedValueOnce({
      available: false,
      platform: "macos",
    })
    expect(await askComputerServed()).toBe(false)
    expect(transport.call).toHaveBeenCalledTimes(2)

    // Restarted with CODEG_COMPUTER_USE: heard when the transport is back.
    transport.call.mockResolvedValueOnce({ available: true, platform: "macos" })
    const { result } = renderHook(() => useComputerAvailable())
    expect(result.current).toBe(false)
    await act(async () => {
      platform.reconnect?.()
    })
    await waitFor(() => expect(result.current).toBe(true))
    expect(computerServerPlatform()).toBe("macos")
  })

  /** The transport coming back while a question is still out — asked
   * before it went away — asks again once that one settles. */
  it("asks again after a reconnect that came while it was asking", async () => {
    let fail: (e: Error) => void = () => {}
    transport.call.mockReturnValueOnce(
      new Promise((_, reject) => {
        fail = reject
      })
    )
    transport.call.mockResolvedValueOnce({
      available: true,
      platform: "windows",
    })
    const first = askComputerServed()
    await act(async () => {
      platform.reconnect?.()
      fail(new Error("offline"))
      await first
    })
    await waitFor(() => expect(computerAvailable()).toBe(true))
    expect(transport.call).toHaveBeenCalledTimes(2)
  })
})
