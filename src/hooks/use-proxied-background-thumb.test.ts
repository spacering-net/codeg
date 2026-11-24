import { renderHook, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

import type { BackgroundAsset } from "@/lib/workspace-background"

const fetchMock = vi.fn()

vi.mock("@/lib/workspace-background-market", () => ({
  fetchWorkspaceBgMarketAsset: (url: string) => fetchMock(url),
}))

// Track blob create/revoke without the real URL object API — jsdom does not
// implement `URL.createObjectURL` (same reason the pet-market hook test mocks
// its sprite-url helpers). Each create returns a unique url so we can assert
// the hook's blob is the exact one handed to the consumer.
let blobSeq = 0
const created: string[] = []
const revoked: string[] = []
vi.mock("@/lib/workspace-background", () => ({
  createBackgroundObjectUrl: vi.fn((asset: { dataBase64: string }) => {
    const url = `blob:${asset.dataBase64}#${blobSeq++}`
    created.push(url)
    return url
  }),
  revokeBackgroundObjectUrl: vi.fn((url: string | null | undefined) => {
    if (url) revoked.push(url)
  }),
}))

import {
  __resetBackgroundThumbCacheForTests,
  useProxiedBackgroundThumb,
} from "./use-proxied-background-thumb"

const JPEG: BackgroundAsset = { mime: "image/jpeg", dataBase64: "eHg=" }

beforeEach(() => {
  blobSeq = 0
  created.length = 0
  revoked.length = 0
  fetchMock.mockReset()
  __resetBackgroundThumbCacheForTests()
})

describe("useProxiedBackgroundThumb", () => {
  it("resolves a blob src after the proxied fetch settles", async () => {
    fetchMock.mockResolvedValue(JPEG)
    const { result, unmount } = renderHook(() =>
      useProxiedBackgroundThumb("https://th.wallhaven.cc/small/ab/x.jpg")
    )
    expect(result.current.loading).toBe(true)
    await waitFor(() => expect(result.current.src).toBeTruthy())
    expect(result.current.src).toMatch(/^blob:/)
    expect(created).toContain(result.current.src)
    expect(result.current.failed).toBe(false)

    unmount()
    expect(revoked).toEqual([result.current.src])
  })

  it("reports failure when the fetch rejects", async () => {
    fetchMock.mockRejectedValue(new Error("network"))
    const { result } = renderHook(() =>
      useProxiedBackgroundThumb("https://th.wallhaven.cc/small/ab/y.jpg")
    )
    await waitFor(() => expect(result.current.failed).toBe(true))
    expect(result.current.src).toBeNull()
    expect(created).toHaveLength(0) // no orphan blob on failure
  })

  it("serves a second consumer from the shared asset cache", async () => {
    fetchMock.mockResolvedValue(JPEG)
    const first = renderHook(() =>
      useProxiedBackgroundThumb("https://th.wallhaven.cc/small/ab/z.jpg")
    )
    await waitFor(() => expect(first.result.current.src).toBeTruthy())
    const second = renderHook(() =>
      useProxiedBackgroundThumb("https://th.wallhaven.cc/small/ab/z.jpg")
    )
    await waitFor(() => expect(second.result.current.src).toBeTruthy())
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  // Entries are whole base64 images and nothing evicts them on dialog close, so
  // the map has to bound itself — otherwise every thumbnail ever scrolled past
  // is retained for the life of the page.
  it("evicts the least recently used entry past the cache limit", async () => {
    __resetBackgroundThumbCacheForTests(2)
    fetchMock.mockResolvedValue(JPEG)
    const url = (i: number) => `https://th.wallhaven.cc/small/ab/${i}.jpg`
    const load = async (i: number) => {
      const { result } = renderHook(() => useProxiedBackgroundThumb(url(i)))
      await waitFor(() => expect(result.current.src).toBeTruthy())
    }

    await load(0)
    await load(1)
    // Re-reading 0 makes it the youngest, so 1 is the one the next insert drops.
    await load(0)
    expect(fetchMock).toHaveBeenCalledTimes(2)

    await load(2)
    await load(0)
    expect(fetchMock).toHaveBeenCalledTimes(3) // 0 survived
    await load(1)
    expect(fetchMock).toHaveBeenCalledTimes(4) // 1 was evicted
  })
})
