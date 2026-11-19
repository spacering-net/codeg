import { act, renderHook, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("./api", () => ({ fetchMarketplaceAsset: vi.fn() }))

// Track blob create/revoke without the real URL object API (jsdom lacks it and
// we want to assert exact lifecycle). Each create returns a unique url so we can
// prove consumers get *distinct* blobs off one shared asset.
let blobSeq = 0
const created: string[] = []
const revoked: string[] = []
vi.mock("./sprite-url", () => ({
  createPetSpriteObjectUrl: vi.fn(() => {
    const url = `blob:pet-${blobSeq++}`
    created.push(url)
    return url
  }),
  revokePetSpriteObjectUrl: vi.fn((url: string | null | undefined) => {
    if (url) revoked.push(url)
  }),
}))

import {
  __resetMarketplaceAssetCacheForTests,
  useProxiedMarketplaceAsset,
} from "./use-proxied-marketplace-asset"
import { fetchMarketplaceAsset } from "./api"
import type { PetSpriteAsset } from "./types"

const mockFetch = vi.mocked(fetchMarketplaceAsset)

function asset(data: string): PetSpriteAsset {
  return { mime: "image/webp", dataBase64: data }
}

async function viewAsset(url: string): Promise<void> {
  const hook = renderHook(() => useProxiedMarketplaceAsset(url))
  await act(async () => {})
  expect(hook.result.current.src).toBeTruthy()
  hook.unmount()
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

beforeEach(() => {
  blobSeq = 0
  created.length = 0
  revoked.length = 0
  mockFetch.mockReset()
  __resetMarketplaceAssetCacheForTests()
})

afterEach(() => {
  vi.clearAllMocks()
})

describe("useProxiedMarketplaceAsset", () => {
  it("resolves a url to a blob and revokes exactly that blob on unmount", async () => {
    mockFetch.mockResolvedValue(asset("AAA"))

    const { result, unmount } = renderHook(() =>
      useProxiedMarketplaceAsset("https://codex-pets.net/a/poster.webp")
    )
    expect(result.current).toEqual({ src: null, loading: true, failed: false })

    await waitFor(() => expect(result.current.src).toBeTruthy())
    const src = result.current.src as string
    expect(result.current.failed).toBe(false)
    expect(created).toContain(src)
    expect(revoked).not.toContain(src)

    unmount()
    expect(revoked).toEqual([src])
  })

  // Guards Codex blocking issue #1: a shared cache entry must never be revoked
  // out from under a still-mounted consumer. Each consumer owns its own blob.
  it("gives each consumer its own blob so unmounting one never blanks another", async () => {
    mockFetch.mockResolvedValue(asset("SHARED"))
    const url = "https://codex-pets.net/shared/poster.webp"

    const a = renderHook(() => useProxiedMarketplaceAsset(url))
    const b = renderHook(() => useProxiedMarketplaceAsset(url))

    await waitFor(() => expect(a.result.current.src).toBeTruthy())
    await waitFor(() => expect(b.result.current.src).toBeTruthy())

    const aSrc = a.result.current.src as string
    const bSrc = b.result.current.src as string
    expect(aSrc).not.toBe(bSrc) // distinct per-consumer blobs...
    expect(mockFetch).toHaveBeenCalledTimes(1) // ...off a single shared fetch

    a.unmount()
    expect(revoked).toContain(aSrc)
    expect(revoked).not.toContain(bSrc) // b's image stays live

    b.unmount()
    expect(revoked).toContain(bSrc)
  })

  // Guards Codex blocking issue #2: a rejection must not be cached (retryable),
  // and a failed fetch surfaces `failed` without ever minting a blob.
  it("does not cache a rejection and reports failure", async () => {
    mockFetch.mockRejectedValueOnce(new Error("network down"))
    mockFetch.mockResolvedValueOnce(asset("RECOVERED"))
    const url = "https://codex-pets.net/flaky/poster.webp"

    const first = renderHook(() => useProxiedMarketplaceAsset(url))
    await waitFor(() => expect(first.result.current.failed).toBe(true))
    expect(first.result.current.src).toBeNull()
    expect(created).toHaveLength(0) // no orphan blob on failure
    first.unmount()

    // A fresh mount re-fetches (rejection was evicted, not cached) and succeeds.
    const second = renderHook(() => useProxiedMarketplaceAsset(url))
    await waitFor(() => expect(second.result.current.src).toBeTruthy())
    expect(mockFetch).toHaveBeenCalledTimes(2)
  })

  it("releases least recently used posters across marketplace pages", async () => {
    mockFetch.mockResolvedValue(asset("AAAA"))
    const poster = (index: number) => `https://codex-pets.net/v/${index}.webp`

    for (let i = 0; i < 64; i++) await viewAsset(poster(i))
    await viewAsset(poster(0)) // Touch it before adding a 65th distinct poster.
    await viewAsset(poster(64))
    await viewAsset(poster(0))
    await viewAsset(poster(1))

    expect(
      mockFetch.mock.calls.filter(([url]) => url === poster(0))
    ).toHaveLength(1)
    expect(
      mockFetch.mock.calls.filter(([url]) => url === poster(1))
    ).toHaveLength(2)
  })

  it("evicts old previews when their combined payload exceeds the cache budget", async () => {
    const urls = ["A", "B", "C", "D", "E"].map(
      (name) => `https://codex-pets.net/v/${name}.webp`
    )
    mockFetch.mockImplementation(async (url) =>
      asset(url.slice(-6, -5).repeat(2 * 1024 * 1024))
    )

    for (const url of urls) await viewAsset(url)
    await viewAsset(urls[4]!)
    expect(mockFetch).toHaveBeenCalledTimes(5)

    await viewAsset(urls[0]!)
    expect(mockFetch).toHaveBeenCalledTimes(6)
    expect(mockFetch).toHaveBeenLastCalledWith(urls[0])
  })

  it("shares an oversized preview in flight but does not retain it after use", async () => {
    const url = "https://codex-pets.net/v/large.webp"
    const response = deferred<PetSpriteAsset>()
    mockFetch.mockReturnValue(response.promise)
    const first = renderHook(() => useProxiedMarketplaceAsset(url))
    const second = renderHook(() => useProxiedMarketplaceAsset(url))
    expect(mockFetch).toHaveBeenCalledTimes(1)
    await act(async () => response.resolve(asset("A".repeat(9 * 1024 * 1024))))
    expect(first.result.current.src).toBeTruthy()
    expect(second.result.current.src).toBeTruthy()
    expect(first.result.current.src).not.toBe(second.result.current.src)
    first.unmount()
    second.unmount()

    await viewAsset(url)
    expect(mockFetch).toHaveBeenCalledTimes(2)
  })

  it("does not mint a blob when unmounted before the fetch settles", async () => {
    const d = deferred<PetSpriteAsset>()
    mockFetch.mockReturnValue(d.promise)

    const { unmount } = renderHook(() =>
      useProxiedMarketplaceAsset("https://codex-pets.net/slow/poster.webp")
    )
    unmount() // cancel before settle
    // Flush the whole load chain so the late consumer callback actually runs.
    await act(async () => d.resolve(asset("LATE")))

    expect(created).toHaveLength(0)
    expect(revoked).toHaveLength(0)
  })

  it("reports not-loading and mints nothing for a nullish url", () => {
    const { result } = renderHook(() => useProxiedMarketplaceAsset(null))
    expect(result.current).toEqual({ src: null, loading: false, failed: false })
    expect(mockFetch).not.toHaveBeenCalled()
  })
})
