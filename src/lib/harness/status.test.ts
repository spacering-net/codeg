import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  call: vi.fn(),
  remoteId: null as number | null,
}))

vi.mock("@/lib/transport", () => ({
  getTransport: () => ({ call: mocks.call }),
  getActiveRemoteConnectionId: () => mocks.remoteId,
}))

import {
  __resetHarnessStatusForTests,
  getHarnessStatus,
  refreshHarnessStatus,
} from "./status"

const KEY = "workspace:harness-discover-enabled"

beforeEach(() => {
  mocks.call.mockReset()
  mocks.remoteId = null
  localStorage.clear()
  __resetHarnessStatusForTests()
})

describe("Harness status", () => {
  it("is on, with nothing known, before the backend has been asked", () => {
    expect(getHarnessStatus()).toEqual({
      enabled: true,
      origin: null,
      support: "unknown",
    })
  })

  it("starts from the answer this device got last time", () => {
    localStorage.setItem(KEY, "0")
    expect(getHarnessStatus().enabled).toBe(false)
  })

  it("takes the backend's answer and remembers it", async () => {
    mocks.call.mockResolvedValueOnce({
      enabled: false,
      origin: "https://spacering.net",
    })
    await refreshHarnessStatus()

    expect(mocks.call).toHaveBeenCalledWith("harness_status")
    expect(getHarnessStatus()).toEqual({
      enabled: false,
      origin: "https://spacering.net",
      support: "supported",
    })
    expect(localStorage.getItem(KEY)).toBe("0")

    mocks.call.mockResolvedValueOnce({
      enabled: true,
      origin: "https://spacering.net/",
    })
    await refreshHarnessStatus()
    expect(getHarnessStatus().enabled).toBe(true)
    expect(localStorage.getItem(KEY)).toBe("1")
  })

  it("does not take a backend without the command for a catalog switched off", async () => {
    mocks.call.mockRejectedValueOnce({
      code: "not_implemented",
      message: "API endpoint 'harness_status' is not available in web mode",
    })
    await refreshHarnessStatus()

    expect(getHarnessStatus()).toEqual({
      enabled: true,
      origin: null,
      support: "unsupported",
    })
    // Nothing was learned about the switch, so nothing is remembered.
    expect(localStorage.getItem(KEY)).toBeNull()
  })

  it("keeps a remembered 'off' when the backend turns out to be too old", async () => {
    localStorage.setItem(KEY, "0")
    mocks.call.mockRejectedValueOnce("Command harness_status not found")
    await refreshHarnessStatus()
    expect(getHarnessStatus()).toMatchObject({
      enabled: false,
      support: "unsupported",
    })
  })

  it("changes nothing when the backend cannot be reached", async () => {
    localStorage.setItem(KEY, "0")
    mocks.call.mockRejectedValueOnce(new Error("Request timed out"))
    await refreshHarnessStatus()
    expect(getHarnessStatus()).toEqual({
      enabled: false,
      origin: null,
      support: "unknown",
    })
    expect(localStorage.getItem(KEY)).toBe("0")
  })

  it("links only to an origin that can be linked", async () => {
    mocks.call.mockResolvedValueOnce({
      enabled: true,
      origin: "ftp://spacering",
    })
    await refreshHarnessStatus()
    expect(getHarnessStatus()).toMatchObject({
      origin: null,
      support: "supported",
    })
  })

  it("shares one request between overlapping refreshes", async () => {
    let answer!: (value: unknown) => void
    mocks.call.mockReturnValueOnce(
      new Promise((resolve) => {
        answer = resolve
      })
    )
    const first = refreshHarnessStatus()
    const second = refreshHarnessStatus()
    answer({ enabled: true, origin: "https://spacering.net" })
    await Promise.all([first, second])
    expect(mocks.call).toHaveBeenCalledTimes(1)
  })

  it("remembers each remote connection's answer on its own", async () => {
    mocks.remoteId = 7
    mocks.call.mockResolvedValueOnce({
      enabled: false,
      origin: "https://spacering.net",
    })
    await refreshHarnessStatus()
    expect(localStorage.getItem(`${KEY}:remote-7`)).toBe("0")
    expect(localStorage.getItem(KEY)).toBeNull()

    // The local window, and another remote host, start from their own.
    __resetHarnessStatusForTests()
    mocks.remoteId = null
    expect(getHarnessStatus().enabled).toBe(true)
    __resetHarnessStatusForTests()
    mocks.remoteId = 8
    expect(getHarnessStatus().enabled).toBe(true)
    __resetHarnessStatusForTests()
    mocks.remoteId = 7
    expect(getHarnessStatus().enabled).toBe(false)
  })
})
