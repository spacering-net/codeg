import { renderHook, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const call = vi.hoisted(() => vi.fn())

vi.mock("@/lib/transport", () => ({
  getTransport: () => ({ call }),
}))

import { __resetSrnAssetCacheForTests, useSrnAsset } from "./use-srn-asset"

const AVATAR = "/api/avatars/u/1.png"

let minted = 0
const createObjectURL = vi.fn(() => `blob:test/${++minted}`)
const revokeObjectURL = vi.fn()

beforeEach(() => {
  call.mockReset()
  minted = 0
  createObjectURL.mockClear()
  revokeObjectURL.mockClear()
  __resetSrnAssetCacheForTests()
  // jsdom has neither.
  Object.assign(URL, { createObjectURL, revokeObjectURL })
})

afterEach(() => {
  __resetSrnAssetCacheForTests()
})

describe("useSrnAsset", () => {
  it("shows a proxied image from a blob URL, and lets it go on unmount", async () => {
    call.mockResolvedValue({ mime: "image/png", dataBase64: "AAAA" })
    const { result, unmount } = renderHook(() => useSrnAsset(AVATAR))
    expect(result.current).toEqual({ src: null, failed: false })

    await waitFor(() => expect(result.current.src).toBe("blob:test/1"))
    expect(call).toHaveBeenCalledWith("srn_asset", { path: AVATAR })

    unmount()
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:test/1")
  })

  it("fetches the same image once for every card that shows it", async () => {
    call.mockResolvedValue({ mime: "image/webp", dataBase64: "AAAA" })
    const first = renderHook(() => useSrnAsset(AVATAR))
    const second = renderHook(() => useSrnAsset(AVATAR))
    await waitFor(() => expect(first.result.current.src).not.toBeNull())
    await waitFor(() => expect(second.result.current.src).not.toBeNull())

    expect(call).toHaveBeenCalledTimes(1)
    // Each consumer owns its own blob URL.
    expect(first.result.current.src).not.toBe(second.result.current.src)
  })

  it.each([null, undefined, ""])(
    "asks for nothing without a path (%j)",
    (path) => {
      const { result } = renderHook(() => useSrnAsset(path))
      expect(result.current).toEqual({ src: null, failed: false })
      expect(call).not.toHaveBeenCalled()
    }
  )

  it.each([
    "https://example.com/a.png",
    "/api/harness/v1/items/acme/pdf-tools",
    "/other/place.png",
  ])("asks for nothing from a path the proxy does not serve (%s)", (path) => {
    const { result } = renderHook(() => useSrnAsset(path))
    expect(result.current).toEqual({ src: null, failed: true })
    expect(call).not.toHaveBeenCalled()
  })

  it.each(["image/svg+xml", "text/html", "application/octet-stream", ""])(
    "shows nothing for bytes of type %j",
    async (mime) => {
      call.mockResolvedValue({ mime, dataBase64: "AAAA" })
      const { result } = renderHook(() => useSrnAsset(AVATAR))
      await waitFor(() => expect(result.current.failed).toBe(true))
      expect(result.current.src).toBeNull()
      expect(createObjectURL).not.toHaveBeenCalled()
    }
  )

  it("reports a failed fetch, and tries again for the next consumer", async () => {
    call.mockRejectedValueOnce(new Error("offline"))
    const first = renderHook(() => useSrnAsset(AVATAR))
    await waitFor(() => expect(first.result.current.failed).toBe(true))

    call.mockResolvedValueOnce({ mime: "image/jpeg", dataBase64: "AAAA" })
    const second = renderHook(() => useSrnAsset(AVATAR))
    await waitFor(() => expect(second.result.current.src).not.toBeNull())
    expect(call).toHaveBeenCalledTimes(2)
  })

  it("covers a media path as well as an avatar", async () => {
    call.mockResolvedValue({
      mime: "image/webp; charset=binary",
      dataBase64: "AAAA",
    })
    const path = "/api/harness/v1/media/ab12.webp"
    const { result } = renderHook(() => useSrnAsset(path))
    await waitFor(() => expect(result.current.src).not.toBeNull())
    expect(call).toHaveBeenCalledWith("srn_asset", { path })
  })
})
