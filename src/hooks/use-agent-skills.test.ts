import { act, renderHook, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

import type { AgentSkillItem, AgentSkillsListResult } from "@/lib/types"

const mockListSkills =
  vi.fn<
    (params: {
      agentType: string
      workspacePath?: string | null
    }) => Promise<AgentSkillsListResult>
  >()
vi.mock("@/lib/api", () => ({
  acpListAgentSkills: (params: {
    agentType: string
    workspacePath?: string | null
  }) => mockListSkills(params),
}))

import { invalidateAgentSkillsCache, useAgentSkills } from "./use-agent-skills"

function skill(id: string): AgentSkillItem {
  return {
    id,
    name: id,
    scope: "global",
    layout: "skill_directory",
    path: `/skills/${id}`,
    description: null,
    read_only: false,
  }
}

function listing(...ids: string[]): AgentSkillsListResult {
  return {
    supported: true,
    message: null,
    locations: [],
    skills: ids.map(skill),
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function focusWindow() {
  act(() => {
    window.dispatchEvent(new Event("focus"))
  })
}

const ids = (skills: AgentSkillItem[]) => skills.map((s) => s.id)

beforeEach(() => {
  // Readers from the previous test were unmounted by RTL's auto-cleanup, so
  // this forgets every folder rather than rescanning one.
  invalidateAgentSkillsCache()
  mockListSkills.mockReset()
})

describe("useAgentSkills", () => {
  it("reads nothing, and scans nothing, without an agent", () => {
    const { result } = renderHook(() => useAgentSkills(null, "/ws/none"))
    expect(result.current).toEqual([])
    focusWindow()
    expect(mockListSkills).not.toHaveBeenCalled()
  })

  it("never shows one folder's list for another", async () => {
    const pending = deferred<AgentSkillsListResult>()
    mockListSkills.mockImplementation(({ workspacePath }) =>
      workspacePath === "/ws/one"
        ? Promise.resolve(listing("one"))
        : pending.promise
    )
    const { result, rerender } = renderHook(
      ({ path }) => useAgentSkills("codex", path),
      { initialProps: { path: "/ws/one" } }
    )
    await waitFor(() => expect(ids(result.current)).toEqual(["one"]))

    rerender({ path: "/ws/two" })
    expect(result.current).toEqual([])
    await act(async () => {
      pending.resolve(listing("two"))
      await pending.promise
    })
    expect(ids(result.current)).toEqual(["two"])
  })
})

describe("useAgentSkills window-focus refresh", () => {
  it("makes one request per focus for every instance sharing a key", async () => {
    // A Codex tab mounts two instances on the same key: its composer's `$` menu
    // and its transcript's badge check. One focus must not scan the disk twice.
    mockListSkills.mockResolvedValue(listing("deploy"))
    const { result } = renderHook(() => ({
      composer: useAgentSkills("codex", "/ws/a"),
      transcript: useAgentSkills("codex", "/ws/a"),
    }))
    await waitFor(() =>
      expect(ids(result.current.transcript)).toEqual(["deploy"])
    )
    expect(mockListSkills).toHaveBeenCalledTimes(1)

    mockListSkills.mockResolvedValue(listing("deploy", "review"))
    focusWindow()

    expect(mockListSkills).toHaveBeenCalledTimes(2)
    // Both instances still pick up the refreshed list from the shared request.
    await waitFor(() => {
      expect(ids(result.current.composer)).toEqual(["deploy", "review"])
      expect(ids(result.current.transcript)).toEqual(["deploy", "review"])
    })
  })

  it("still refreshes on every focus", async () => {
    mockListSkills.mockResolvedValue(listing("deploy"))
    const { result } = renderHook(() => useAgentSkills("codex", "/ws/b"))
    await waitFor(() => expect(ids(result.current)).toEqual(["deploy"]))

    mockListSkills.mockResolvedValue(listing("review"))
    focusWindow()
    await waitFor(() => expect(ids(result.current)).toEqual(["review"]))

    mockListSkills.mockResolvedValue(listing("ship"))
    focusWindow()
    await waitFor(() => expect(ids(result.current)).toEqual(["ship"]))
    expect(mockListSkills).toHaveBeenCalledTimes(3)
  })

  it("refreshes each distinct key once on the same focus", async () => {
    let version = 1
    mockListSkills.mockImplementation(async ({ workspacePath }) =>
      listing(`${workspacePath === "/ws/c" ? "c" : "d"}${version}`)
    )
    const { result } = renderHook(() => ({
      c: useAgentSkills("codex", "/ws/c"),
      d: useAgentSkills("codex", "/ws/d"),
    }))
    await waitFor(() => {
      expect(ids(result.current.c)).toEqual(["c1"])
      expect(ids(result.current.d)).toEqual(["d1"])
    })
    expect(mockListSkills).toHaveBeenCalledTimes(2)

    version = 2
    focusWindow()
    expect(mockListSkills).toHaveBeenCalledTimes(4)
    expect(
      mockListSkills.mock.calls
        .slice(2)
        .map(([p]) => p.workspacePath)
        .sort()
    ).toEqual(["/ws/c", "/ws/d"])
    // Each folder's readers get that folder's refreshed list.
    await waitFor(() => {
      expect(ids(result.current.c)).toEqual(["c2"])
      expect(ids(result.current.d)).toEqual(["d2"])
    })
  })

  it("refreshes a reader that mounted after the list had loaded", async () => {
    mockListSkills.mockResolvedValue(listing("deploy"))
    const first = renderHook(() => useAgentSkills("codex", "/ws/warm"))
    await waitFor(() => expect(ids(first.result.current)).toEqual(["deploy"]))

    // Mounts straight from the loaded list, without a scan of its own.
    const late = renderHook(() => useAgentSkills("codex", "/ws/warm"))
    expect(ids(late.result.current)).toEqual(["deploy"])
    expect(mockListSkills).toHaveBeenCalledTimes(1)

    mockListSkills.mockResolvedValue(listing("deploy", "review"))
    focusWindow()
    await waitFor(() => {
      expect(ids(late.result.current)).toEqual(["deploy", "review"])
      expect(ids(first.result.current)).toEqual(["deploy", "review"])
    })
    expect(mockListSkills).toHaveBeenCalledTimes(2)
  })

  it("keeps the last list when a refresh fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    mockListSkills.mockResolvedValue(listing("deploy"))
    const { result } = renderHook(() => useAgentSkills("codex", "/ws/fail"))
    await waitFor(() => expect(ids(result.current)).toEqual(["deploy"]))

    const failing = deferred<AgentSkillsListResult>()
    mockListSkills.mockReturnValueOnce(failing.promise)
    focusWindow()
    await act(async () => {
      failing.reject(new Error("scan failed"))
      await failing.promise.catch(() => {})
    })

    // The refresh did run and fail; the list it would have replaced stays up.
    expect(mockListSkills).toHaveBeenCalledTimes(2)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(ids(result.current)).toEqual(["deploy"])
    warn.mockRestore()
  })

  it("lets no earlier scan that answers last overwrite a newer one", async () => {
    mockListSkills.mockResolvedValue(listing("deploy"))
    const { result } = renderHook(() => useAgentSkills("codex", "/ws/order"))
    await waitFor(() => expect(ids(result.current)).toEqual(["deploy"]))

    const earlier = deferred<AgentSkillsListResult>()
    const later = deferred<AgentSkillsListResult>()
    mockListSkills
      .mockReturnValueOnce(earlier.promise)
      .mockReturnValueOnce(later.promise)
    focusWindow()
    focusWindow()

    await act(async () => {
      later.resolve(listing("new"))
      await later.promise
    })
    expect(ids(result.current)).toEqual(["new"])
    await act(async () => {
      earlier.resolve(listing("old"))
      await earlier.promise
    })
    expect(ids(result.current)).toEqual(["new"])
  })

  it("keeps the same list reference when a refresh finds nothing new", async () => {
    // Readers key memos on this reference (the transcript rebuilds its badge
    // list from it), so an unchanged scan must not hand them a new array.
    mockListSkills.mockResolvedValue(listing("deploy"))
    const { result } = renderHook(() => useAgentSkills("codex", "/ws/same"))
    await waitFor(() => expect(ids(result.current)).toEqual(["deploy"]))
    const before = result.current

    const again = deferred<AgentSkillsListResult>()
    mockListSkills.mockReturnValueOnce(again.promise)
    focusWindow()
    await act(async () => {
      again.resolve(listing("deploy"))
      await again.promise
    })
    expect(mockListSkills).toHaveBeenCalledTimes(2)
    expect(result.current).toBe(before)
  })

  it("stops refreshing once nothing reads skills", async () => {
    mockListSkills.mockResolvedValue(listing("deploy"))
    const { result, unmount } = renderHook(() =>
      useAgentSkills("codex", "/ws/gone")
    )
    await waitFor(() => expect(ids(result.current)).toEqual(["deploy"]))
    unmount()
    focusWindow()
    expect(mockListSkills).toHaveBeenCalledTimes(1)
  })
})

describe("invalidateAgentSkillsCache", () => {
  it("rescans a folder on screen at once, and forgets the rest", async () => {
    let version = 1
    mockListSkills.mockImplementation(async ({ workspacePath }) =>
      listing(`${workspacePath === "/ws/x" ? "x" : "y"}${version}`)
    )
    const onScreen = renderHook(() => useAgentSkills("codex", "/ws/x"))
    const closed = renderHook(() => useAgentSkills("codex", "/ws/y"))
    await waitFor(() => {
      expect(ids(onScreen.result.current)).toEqual(["x1"])
      expect(ids(closed.result.current)).toEqual(["y1"])
    })
    closed.unmount()
    expect(mockListSkills).toHaveBeenCalledTimes(2)

    // Another agent's invalidation leaves Codex's folders alone.
    act(() => invalidateAgentSkillsCache("claude_code"))
    expect(mockListSkills).toHaveBeenCalledTimes(2)

    version = 2
    act(() => invalidateAgentSkillsCache("codex"))
    // Only the folder something still reads is rescanned now…
    expect(mockListSkills).toHaveBeenCalledTimes(3)
    expect(mockListSkills.mock.calls[2][0].workspacePath).toBe("/ws/x")
    await waitFor(() => expect(ids(onScreen.result.current)).toEqual(["x2"]))

    // …and the forgotten one is scanned afresh by its next reader instead of
    // coming back with the list from before the change.
    const reopened = renderHook(() => useAgentSkills("codex", "/ws/y"))
    expect(reopened.result.current).toEqual([])
    await waitFor(() => expect(ids(reopened.result.current)).toEqual(["y2"]))
    expect(mockListSkills).toHaveBeenCalledTimes(4)
  })
})
