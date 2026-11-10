import { act, renderHook } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { WorkspaceFileEntry } from "@/lib/types"
import { useFileTree } from "./use-file-tree"

const api = vi.hoisted(() => ({ prepare: vi.fn(), search: vi.fn() }))
vi.mock("@/lib/api", () => ({
  prepareWorkspaceFileSearch: api.prepare,
  searchWorkspaceFiles: api.search,
}))

function file(path: string): WorkspaceFileEntry {
  const parts = path.split("/")
  return { name: parts[parts.length - 1], path, kind: "file" }
}

function deferred() {
  let resolve!: (files: WorkspaceFileEntry[]) => void
  const promise = new Promise<WorkspaceFileEntry[]>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe("bounded workspace file search", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    api.prepare.mockReset().mockResolvedValue(undefined)
    api.search.mockReset().mockResolvedValue([])
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it("does no discovery while the picker is disabled", async () => {
    renderHook(() =>
      useFileTree({ folderPath: "/repo", enabled: false, query: "index" })
    )
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })
    expect(api.prepare).not.toHaveBeenCalled()
    expect(api.search).not.toHaveBeenCalled()
  })

  it("debounces typing and requests bounded matches for only the latest query", async () => {
    const { rerender } = renderHook(
      (query: string) =>
        useFileTree({ folderPath: "/repo", enabled: true, query }),
      { initialProps: "a" }
    )
    rerender("auth")
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150)
    })
    expect(api.prepare).toHaveBeenCalledOnce()
    expect(api.search).toHaveBeenCalledExactlyOnceWith("/repo", "auth", {
      limit: 100,
      filesOnly: false,
      refresh: false,
      request: {
        consumerId: expect.any(String),
        generation: expect.any(Number),
      },
      signal: expect.any(AbortSignal),
    })
  })

  it("drops a response from the previous workspace even when it resolves last", async () => {
    const old = deferred()
    api.search.mockImplementation((path: string) =>
      path === "/old" ? old.promise : Promise.resolve([file("new.ts")])
    )
    const { result, rerender } = renderHook(
      (folderPath: string) =>
        useFileTree({ folderPath, enabled: true, query: "ts" }),
      { initialProps: "/old" }
    )
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150)
    })
    rerender("/new")
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150)
    })
    await act(async () => {
      old.resolve([file("old.ts")])
    })
    expect(result.current.allFiles.map((f) => f.relativePath)).toEqual([
      "new.ts",
    ])
    expect(result.current.loading).toBe(false)
  })

  it("reset invalidates in-flight results and requests a fresh native search", async () => {
    const old = deferred()
    api.search
      .mockReturnValueOnce(old.promise)
      .mockResolvedValue([file("fresh.ts")])
    const { result } = renderHook(() =>
      useFileTree({ folderPath: "/repo", enabled: true, query: "ts" })
    )
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150)
    })
    act(() => result.current.reset(true))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150)
    })
    await act(async () => {
      old.resolve([file("obsolete.ts")])
    })
    expect(api.search).toHaveBeenLastCalledWith(
      "/repo",
      "ts",
      expect.objectContaining({ refresh: true })
    )
    expect(result.current.allFiles.map((f) => f.relativePath)).toEqual([
      "fresh.ts",
    ])
  })

  it("closing and reopening clears local results without invalidating a warm index", async () => {
    const { result, rerender } = renderHook(
      (enabled: boolean) =>
        useFileTree({ folderPath: "/repo", enabled, query: "ts" }),
      { initialProps: false }
    )
    act(() => result.current.reset())
    rerender(true)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150)
    })
    expect(api.search).toHaveBeenLastCalledWith(
      "/repo",
      "ts",
      expect.objectContaining({ refresh: false })
    )
  })

  it("cancels backend work for the old query and keeps a per-picker consumer", async () => {
    api.search.mockReturnValue(new Promise(() => {}))
    const { rerender, unmount } = renderHook(
      (query: string) =>
        useFileTree({ folderPath: "/repo", enabled: true, query }),
      { initialProps: "a" }
    )
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150)
    })
    const first = api.search.mock.calls[0][2]
    rerender("ab")
    expect(first.signal.aborted).toBe(true)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150)
    })
    const second = api.search.mock.calls[1][2]
    expect(second.request.consumerId).toBe(first.request.consumerId)
    expect(second.request.generation).toBeGreaterThan(first.request.generation)
    unmount()
    expect(second.signal.aborted).toBe(true)
  })
})
