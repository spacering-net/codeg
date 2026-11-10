import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const call = vi.fn()
const isDesktop = vi.fn(() => false)

vi.mock("@/lib/transport", () => ({
  getTransport: () => ({ call }),
  isDesktop: () => isDesktop(),
}))

import {
  bridgeClose,
  bridgeEntryUrl,
  bridgeOpen,
  bridgeOrigin,
  bridgeStatus,
  bridgeStatusSnapshot,
  fragmentOf,
  isBridgeableUrl,
  probeBridge,
  resetBridgeStatusForTests,
  STATUS_RETRY_DELAYS_MS,
  type BridgeGrant,
} from "./browser-bridge"

const grant: BridgeGrant = {
  targetPort: 3000,
  bridgePort: 3081,
  bridgeHost: null,
  entryPath: "/__codeg_bridge/enter/cap123",
  publicHost: null,
  path: "/docs?x=1",
}

/** The same target named by hostname: no port of the server's own. */
const hostGrant: BridgeGrant = {
  ...grant,
  bridgePort: null,
  bridgeHost: "3000.codeg.example",
}

beforeEach(() => {
  call.mockReset()
  isDesktop.mockReturnValue(false)
  resetBridgeStatusForTests()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("bridgeStatus", () => {
  it("asks the server once and keeps a synchronous snapshot", async () => {
    call.mockResolvedValue({
      enabled: true,
      ports: [3081],
      publicHost: null,
      hostPattern: null,
    })
    expect(bridgeStatusSnapshot()).toBeNull()
    const first = bridgeStatus()
    const second = bridgeStatus()
    expect(await first).toEqual({
      enabled: true,
      ports: [3081],
      publicHost: null,
      hostPattern: null,
    })
    await second
    expect(call).toHaveBeenCalledTimes(1)
    expect(call).toHaveBeenCalledWith("browser_bridge_status", {})
    expect(bridgeStatusSnapshot()?.enabled).toBe(true)
  })

  it("is off on the desktop without a round trip", async () => {
    isDesktop.mockReturnValue(true)
    expect(await bridgeStatus()).toEqual({
      enabled: false,
      ports: [],
      publicHost: null,
      hostPattern: null,
    })
    expect(call).not.toHaveBeenCalled()
    expect(bridgeStatusSnapshot()?.enabled).toBe(false)
  })

  it("retries a failed call before answering off, then asks again next time", async () => {
    vi.useFakeTimers()
    try {
      call
        .mockRejectedValueOnce(new Error("down"))
        .mockRejectedValueOnce(new Error("down"))
        .mockResolvedValueOnce({
          enabled: true,
          ports: [0],
          publicHost: "h",
          hostPattern: null,
        })
      const pending = bridgeStatus()
      await vi.advanceTimersByTimeAsync(STATUS_RETRY_DELAYS_MS[0])
      await vi.advanceTimersByTimeAsync(STATUS_RETRY_DELAYS_MS[1])
      expect((await pending).enabled).toBe(true)
      expect(call).toHaveBeenCalledTimes(3)

      // Every try failed: off for this call, not cached.
      resetBridgeStatusForTests()
      call.mockReset()
      call.mockRejectedValue(new Error("down"))
      const failing = bridgeStatus()
      for (const delay of STATUS_RETRY_DELAYS_MS) {
        await vi.advanceTimersByTimeAsync(delay)
      }
      expect((await failing).enabled).toBe(false)
      expect(bridgeStatusSnapshot()).toBeNull()
      call.mockReset()
      call.mockResolvedValue({
        enabled: true,
        ports: [0],
        publicHost: null,
        hostPattern: null,
      })
      expect((await bridgeStatus()).enabled).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe("grants", () => {
  it("open and close go through the API with the tab id", async () => {
    call.mockResolvedValueOnce(grant)
    expect(await bridgeOpen("http://localhost:3000/docs?x=1", "tab-1")).toBe(
      grant
    )
    expect(call).toHaveBeenLastCalledWith("browser_bridge_open", {
      url: "http://localhost:3000/docs?x=1",
      tabId: "tab-1",
    })
    call.mockResolvedValueOnce({ ok: true })
    await expect(bridgeClose("tab-1")).resolves.toBeUndefined()
    expect(call).toHaveBeenLastCalledWith("browser_bridge_close", {
      tabId: "tab-1",
    })
  })
})

describe("isBridgeableUrl", () => {
  it.each([
    "http://localhost:3000/",
    "http://127.0.0.1:8080/x",
    "http://[::1]:5173/",
    "http://0.0.0.0:3000/",
    "http://app.localhost/",
  ])("%s can be bridged", (url) => {
    expect(isBridgeableUrl(url)).toBe(true)
  })

  it.each([
    "https://localhost:3000/",
    "http://192.168.1.10:3000/",
    "http://example.com/",
    "ws://localhost:3000/",
    "localhost:3000",
    "",
  ])("%s cannot", (url) => {
    expect(isBridgeableUrl(url)).toBe(false)
  })
})

describe("bridge URLs", () => {
  it("use the page's host and scheme with the bridge port", () => {
    const page = { protocol: "http:", hostname: "192.168.1.5", port: "3080" }
    expect(bridgeOrigin(grant, page)).toBe("http://192.168.1.5:3081")
    expect(bridgeEntryUrl(grant, page)).toBe(
      "http://192.168.1.5:3081/__codeg_bridge/enter/cap123?to=%2Fdocs%3Fx%3D1"
    )
  })

  it("prefer the server's public host and bracket IPv6", () => {
    expect(
      bridgeOrigin(
        { ...grant, publicHost: "bridge.example" },
        { protocol: "https:", hostname: "codeg.example", port: "" }
      )
    ).toBe("https://bridge.example:3081")
    expect(
      bridgeOrigin(grant, { protocol: "http:", hostname: "::1", port: "3080" })
    ).toBe("http://[::1]:3081")
    // `location.hostname` keeps the brackets already.
    expect(
      bridgeOrigin(grant, {
        protocol: "http:",
        hostname: "[::1]",
        port: "3080",
      })
    ).toBe("http://[::1]:3081")
  })

  it("use the server's hostname for this target on the page's own port", () => {
    // Named by hostname the bridge answers on codeg's own listener, so the
    // browser keeps the port it is already talking to — including none at
    // all, which is what a deployment behind 443 looks like.
    const page = { protocol: "https:", hostname: "codeg.example", port: "" }
    expect(bridgeOrigin(hostGrant, page)).toBe("https://3000.codeg.example")
    expect(bridgeEntryUrl(hostGrant, page)).toBe(
      "https://3000.codeg.example/__codeg_bridge/enter/cap123?to=%2Fdocs%3Fx%3D1"
    )
    expect(bridgeOrigin(hostGrant, { ...page, port: "8443" })).toBe(
      "https://3000.codeg.example:8443"
    )
    // The hostname the server worked out wins over the public host it would
    // have used for a bridge port, and over the page's own host.
    expect(
      bridgeOrigin(
        { ...hostGrant, publicHost: "bridge.example" },
        { protocol: "http:", hostname: "elsewhere.example", port: "3080" }
      )
    ).toBe("http://3000.codeg.example:3080")
  })

  it("send an empty path to the root and keep the address's fragment", () => {
    const page = { protocol: "http:", hostname: "h", port: "3080" }
    expect(bridgeEntryUrl({ ...grant, path: "" }, page)).toBe(
      "http://h:3081/__codeg_bridge/enter/cap123?to=%2F"
    )
    expect(bridgeEntryUrl(grant, page, "#install")).toBe(
      "http://h:3081/__codeg_bridge/enter/cap123?to=%2Fdocs%3Fx%3D1%23install"
    )
    expect(bridgeEntryUrl(grant, page, "")).toBe(
      "http://h:3081/__codeg_bridge/enter/cap123?to=%2Fdocs%3Fx%3D1"
    )
    expect(fragmentOf("http://localhost:3000/docs#install")).toBe("#install")
    expect(fragmentOf("http://localhost:3000/docs")).toBe("")
    expect(fragmentOf("not a url")).toBe("")
  })
})

describe("probeBridge", () => {
  it("is true only for an ok answer from the ping route", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true })
    vi.stubGlobal("fetch", fetchMock)
    expect(await probeBridge("http://h:3081")).toBe(true)
    expect(fetchMock).toHaveBeenCalledWith(
      "http://h:3081/__codeg_bridge/ping",
      expect.objectContaining({
        mode: "cors",
        credentials: "omit",
        cache: "no-store",
      })
    )
    fetchMock.mockResolvedValue({ ok: false })
    expect(await probeBridge("http://h:3081")).toBe(false)
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"))
    expect(await probeBridge("http://h:3081")).toBe(false)
  })
})
