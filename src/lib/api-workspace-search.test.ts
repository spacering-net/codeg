import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { searchWorkspaceFiles } from "./api"

const { call } = vi.hoisted(() => ({ call: vi.fn() }))
vi.mock("@/lib/transport", () => ({
  getTransport: () => ({ call }),
}))

describe("workspace search transport", () => {
  beforeEach(() => call.mockReset().mockResolvedValue([]))
  afterEach(() => vi.unstubAllGlobals())

  it("generates consumer IDs on plain HTTP origins without crypto.randomUUID", async () => {
    vi.stubGlobal("crypto", {
      getRandomValues: crypto.getRandomValues.bind(crypto),
    })
    await searchWorkspaceFiles("/repo", "readme")
    expect(call.mock.calls[0][1].request.consumerId).toMatch(
      /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/
    )
  })

  it("covers native queue and traversal deadlines in web and remote desktop calls", async () => {
    await searchWorkspaceFiles("/repo", "readme", { limit: 51 })
    expect(call).toHaveBeenCalledExactlyOnceWith(
      "search_workspace_files",
      {
        path: "/repo",
        query: "readme",
        limit: 51,
        request: { consumerId: expect.any(String), generation: 0 },
      },
      { timeoutMs: 330_000 }
    )
  })

  it("propagates abort to the captured backend without serializing the signal", async () => {
    let resolve!: (entries: []) => void
    call.mockReturnValueOnce(
      new Promise((done) => {
        resolve = done
      })
    )
    const abort = new AbortController()
    const request = { consumerId: "picker", generation: 2 }
    const pending = searchWorkspaceFiles("/repo", "readme", {
      request,
      signal: abort.signal,
    })
    abort.abort()
    expect(call).toHaveBeenLastCalledWith("cancel_workspace_file_search", {
      request,
    })
    expect(call.mock.calls[0][1]).not.toHaveProperty("signal")
    resolve([])
    await pending
  })

  it("skips an already obsolete query and removes abort listeners after completion", async () => {
    const old = new AbortController()
    old.abort()
    expect(
      await searchWorkspaceFiles("/repo", "old", { signal: old.signal })
    ).toEqual([])
    expect(call).not.toHaveBeenCalled()
    const finished = new AbortController()
    await searchWorkspaceFiles("/repo", "new", { signal: finished.signal })
    finished.abort()
    expect(call).toHaveBeenCalledOnce()
  })
})
