import { act, renderHook, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@/lib/api", () => ({ folderForgeRemote: vi.fn() }))

import { folderForgeRemote } from "@/lib/api"
import type { ForgeRemote } from "@/lib/types"
import {
  rememberForgeProvider,
  resetForgeProviderCacheForTests,
  useFolderForgeProvider,
} from "./forge-provider-cache"

function remote(provider: ForgeRemote["provider"]): ForgeRemote {
  return {
    server_host: "git.example.com",
    owner_repo: "team/app",
    remote_url: "https://git.example.com/team/app.git",
    provider,
    supported: true,
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
    act(() => rememberForgeProvider(4, "gitlab"))
    expect(result.current).toBe("gitlab")
  })
})
