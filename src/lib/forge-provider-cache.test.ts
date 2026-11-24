import { act, renderHook, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@/lib/api", () => ({ folderForgeRemote: vi.fn() }))

import { folderForgeRemote } from "@/lib/api"
import type { ForgeRemote } from "@/lib/types"
import {
  rememberForgeRemote,
  resetForgeProviderCacheForTests,
  useFolderForgeProvider,
  useFolderForgeRemote,
  useFreshFolderForgeRemote,
} from "./forge-provider-cache"

function remote(
  provider: ForgeRemote["provider"],
  overrides?: Partial<ForgeRemote>
): ForgeRemote {
  return {
    server_host: "git.example.com",
    owner_repo: "team/app",
    remote_url: "https://git.example.com/team/app.git",
    provider,
    supported: true,
    ...overrides,
  }
}

beforeEach(() => {
  resetForgeProviderCacheForTests()
  vi.mocked(folderForgeRemote).mockReset()
})

describe("forge provider cache", () => {
  it("looks a folder up once, however many read it", async () => {
    vi.mocked(folderForgeRemote).mockResolvedValue(remote("gitlab"))
    const a = renderHook(() => useFolderForgeProvider(1))
    const b = renderHook(() => useFolderForgeProvider(1))
    await waitFor(() => expect(a.result.current).toBe("gitlab"))
    expect(b.result.current).toBe("gitlab")
    expect(folderForgeRemote).toHaveBeenCalledTimes(1)

    // A later reader is answered from memory.
    const c = renderHook(() => useFolderForgeProvider(1))
    expect(c.result.current).toBe("gitlab")
    expect(folderForgeRemote).toHaveBeenCalledTimes(1)
  })

  it("asks nothing for no folder", () => {
    const { result } = renderHook(() => useFolderForgeProvider(null))
    expect(result.current).toBeNull()
    expect(folderForgeRemote).not.toHaveBeenCalled()
  })

  it("remembers a folder without a remote, and retries a failed lookup", async () => {
    vi.mocked(folderForgeRemote).mockResolvedValueOnce(null)
    const none = renderHook(() => useFolderForgeProvider(2))
    await waitFor(() => expect(folderForgeRemote).toHaveBeenCalledTimes(1))
    none.rerender()
    expect(none.result.current).toBeNull()
    renderHook(() => useFolderForgeProvider(2))
    expect(folderForgeRemote).toHaveBeenCalledTimes(1)

    vi.mocked(folderForgeRemote)
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(remote("gitlab"))
    const first = renderHook(() => useFolderForgeProvider(3))
    await waitFor(() => expect(folderForgeRemote).toHaveBeenCalledTimes(2))
    first.unmount()
    // Not pinned to the default wording by one failure: the next reader asks.
    const second = renderHook(() => useFolderForgeProvider(3))
    await waitFor(() => expect(second.result.current).toBe("gitlab"))
    expect(folderForgeRemote).toHaveBeenCalledTimes(3)
  })

  it("follows a forge the repository panel learned", async () => {
    vi.mocked(folderForgeRemote).mockResolvedValue(remote("github"))
    const { result } = renderHook(() => useFolderForgeProvider(4))
    await waitFor(() => expect(result.current).toBe("github"))

    // The backend corrected the host's forge; the panel re-resolved it.
    act(() => rememberForgeRemote(4, remote("gitlab")))
    expect(result.current).toBe("gitlab")
  })

  it("hands the whole remote to a reader that acts on it", async () => {
    vi.mocked(folderForgeRemote).mockResolvedValue(
      remote("gitea", { owner_repo: "team/site" })
    )
    const { result } = renderHook(() => useFolderForgeRemote(5))
    await waitFor(() => expect(result.current?.owner_repo).toBe("team/site"))
    expect(result.current?.supported).toBe(true)
    expect(result.current?.provider).toBe("gitea")
  })

  it("re-reads a remembered folder for a reader that revalidates", async () => {
    vi.mocked(folderForgeRemote).mockResolvedValueOnce(
      remote("github", { supported: false })
    )
    const first = renderHook(() => useFolderForgeRemote(6))
    await waitFor(() => expect(first.result.current?.supported).toBe(false))
    first.unmount()

    // An account was added for the host since: a plain reader is answered
    // from memory, a revalidating one shows that answer while it asks again.
    vi.mocked(folderForgeRemote).mockResolvedValueOnce(remote("github"))
    const plain = renderHook(() => useFolderForgeRemote(6))
    expect(plain.result.current?.supported).toBe(false)
    expect(folderForgeRemote).toHaveBeenCalledTimes(1)
    const fresh = renderHook(() =>
      useFolderForgeRemote(6, { revalidate: true })
    )
    expect(fresh.result.current?.supported).toBe(false)
    await waitFor(() => expect(fresh.result.current?.supported).toBe(true))
    expect(folderForgeRemote).toHaveBeenCalledTimes(2)
    // Every reader follows the new answer.
    expect(plain.result.current?.supported).toBe(true)
  })

  it("keeps the last answer when a revalidation fails", async () => {
    vi.mocked(folderForgeRemote).mockResolvedValueOnce(remote("gitlab"))
    const first = renderHook(() => useFolderForgeRemote(7))
    await waitFor(() => expect(first.result.current?.provider).toBe("gitlab"))
    first.unmount()

    vi.mocked(folderForgeRemote).mockRejectedValueOnce(new Error("offline"))
    const again = renderHook(() =>
      useFolderForgeRemote(7, { revalidate: true })
    )
    await waitFor(() => expect(folderForgeRemote).toHaveBeenCalledTimes(2))
    again.rerender()
    expect(again.result.current?.provider).toBe("gitlab")
  })
})

describe("fresh forge remote", () => {
  it("reads past memory, reports what it read, and starts over per ask", async () => {
    rememberForgeRemote(8, remote("github", { owner_repo: "old/place" }))
    vi.mocked(folderForgeRemote).mockResolvedValueOnce(remote("gitlab"))
    const { result, rerender } = renderHook(
      ({ id }: { id: number | null }) => useFreshFolderForgeRemote(id),
      { initialProps: { id: 8 as number | null } }
    )
    expect(result.current.status).toBe("loading")
    await waitFor(() => expect(result.current.status).toBe("ready"))
    expect(
      result.current.status === "ready" && result.current.remote?.provider
    ).toBe("gitlab")
    // Every other reader learns it too.
    const plain = renderHook(() => useFolderForgeRemote(8))
    expect(plain.result.current?.provider).toBe("gitlab")

    // Closed and asked again: the old answer is not the new one.
    rerender({ id: null })
    expect(result.current.status).toBe("idle")
    vi.mocked(folderForgeRemote).mockRejectedValueOnce(new Error("offline"))
    rerender({ id: 8 })
    expect(result.current.status).toBe("loading")
    await waitFor(() => expect(result.current.status).toBe("failed"))
    expect(folderForgeRemote).toHaveBeenCalledTimes(2)
  })
})
