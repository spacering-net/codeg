import { act, renderHook, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

import type { SrnAsset } from "@/lib/harness/types"

import { __resetSrnAvatarCacheForTests, useSrnAvatar } from "./use-srn-avatar"

vi.mock("@/lib/pet/sprite-url", () => ({
  createPetSpriteObjectUrl: (asset: SrnAsset) => `blob:${asset.dataBase64}`,
  revokePetSpriteObjectUrl: vi.fn(),
}))

function picture(name: string): SrnAsset {
  return { mime: "image/png", dataBase64: btoa(name) }
}

function deferredPicture() {
  let resolve!: (asset: SrnAsset) => void
  let reject!: (error: Error) => void
  const promise = new Promise<SrnAsset>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe("SRN avatar cache", () => {
  beforeEach(__resetSrnAvatarCacheForTests)

  it("shares the latest picture and fetches an older picture again", async () => {
    const fetch = vi.fn(async (path: string) => picture(path))
    const paths = Array.from(
      { length: 12 },
      (_, index) => `/api/avatars/${index}.png`
    )

    for (const path of paths) {
      const view = renderHook(() => useSrnAvatar(path, fetch))
      await waitFor(() =>
        expect(view.result.current).toBe(`blob:${btoa(path)}`)
      )
      view.unmount()
    }

    const mostRecent = paths[paths.length - 1]
    const current = renderHook(() => useSrnAvatar(mostRecent, fetch))
    await waitFor(() =>
      expect(current.result.current).toBe(`blob:${btoa(mostRecent)}`)
    )
    expect(fetch).toHaveBeenCalledTimes(paths.length)
    current.unmount()

    const oldest = paths[0]
    const older = renderHook(() => useSrnAvatar(oldest, fetch))
    await waitFor(() =>
      expect(older.result.current).toBe(`blob:${btoa(oldest)}`)
    )
    expect(fetch).toHaveBeenCalledTimes(paths.length + 1)
    expect(fetch).toHaveBeenLastCalledWith(oldest)
  })

  it("shares an unfinished fetch when a picture becomes current again", async () => {
    const a = "/api/avatars/a.png"
    const b = "/api/avatars/b.png"
    const pending = deferredPicture()
    const fetch = vi.fn((path: string) =>
      path === a ? pending.promise : Promise.resolve(picture(b))
    )
    const { rerender, result } = renderHook(
      ({ path }) => useSrnAvatar(path, fetch),
      { initialProps: { path: a } }
    )

    rerender({ path: b })
    await waitFor(() => expect(result.current).toBe(`blob:${btoa(b)}`))
    rerender({ path: a })
    expect(fetch.mock.calls).toEqual([[a], [b]])
    await act(async () => pending.resolve(picture(a)))
    expect(result.current).toBe(`blob:${btoa(a)}`)
  })

  it("keeps the current picture cached when an older request fails", async () => {
    const old = "/api/avatars/old.png"
    const current = "/api/avatars/current.png"
    const pending = deferredPicture()
    const fetch = vi.fn((path: string) =>
      path === old ? pending.promise : Promise.resolve(picture(current))
    )
    const view = renderHook(({ path }) => useSrnAvatar(path, fetch), {
      initialProps: { path: old },
    })
    view.rerender({ path: current })
    await waitFor(() =>
      expect(view.result.current).toBe(`blob:${btoa(current)}`)
    )
    await act(async () => pending.reject(new Error("Offline")))
    view.unmount()

    const next = renderHook(() => useSrnAvatar(current, fetch))
    await waitFor(() =>
      expect(next.result.current).toBe(`blob:${btoa(current)}`)
    )
    expect(fetch.mock.calls).toEqual([[old], [current]])
  })

  it("retries a failed fetch and keeps other consumers on the shared retry", async () => {
    const path = "/api/avatars/after-failure.png"
    const first = deferredPicture()
    const second = deferredPicture()
    const fetch = vi
      .fn<(path: string) => Promise<SrnAsset>>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
    const initial = renderHook(() => useSrnAvatar(path, fetch))
    await act(async () => first.reject(new Error("Offline")))
    expect(initial.result.current).toBeNull()
    initial.unmount()

    const trigger = renderHook(() => useSrnAvatar(path, fetch))
    const menu = renderHook(() => useSrnAvatar(path, fetch))
    expect(fetch).toHaveBeenCalledTimes(2)
    await act(async () => second.resolve(picture(path)))
    expect(trigger.result.current).toBe(`blob:${btoa(path)}`)
    expect(menu.result.current).toBe(`blob:${btoa(path)}`)
  })
})
