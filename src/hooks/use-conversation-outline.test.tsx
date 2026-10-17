import { act, cleanup, renderHook, waitFor } from "@testing-library/react"
import { StrictMode } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { ConversationOutline, MessageTurn } from "@/lib/types"
import { extendPrefixFingerprint, FNV_SEED_HEX } from "@/lib/turn-window"
import {
  useConversationOutline,
  type ConversationOutlineRequest,
} from "./use-conversation-outline"

vi.mock("@/lib/api", () => ({
  getFolderConversationOutline: vi.fn(),
}))

const { getFolderConversationOutline } = await import("@/lib/api")
const mockOutline = vi.mocked(getFolderConversationOutline)

function turn(index: number): MessageTurn {
  return {
    id: `turn-${index}`,
    role: index % 2 === 0 ? "user" : "assistant",
    blocks: [{ type: "text", text: `t${index}` }],
    timestamp: new Date(1_700_000_000_000 + index * 1000).toISOString(),
  }
}

const FULL = Array.from({ length: 8 }, (_, i) => turn(i))

function hashOf(count: number): string {
  const hash = extendPrefixFingerprint(FNV_SEED_HEX, FULL.slice(0, count))
  if (hash == null) throw new Error("fingerprint failed")
  return hash
}

function outlineOf(count: number): ConversationOutline {
  return {
    turns: FULL.slice(0, count),
    turns_total: FULL.length,
    prefix_hash: hashOf(count),
  }
}

function request(
  offset: number,
  overrides: Partial<ConversationOutlineRequest> = {}
): ConversationOutlineRequest {
  return {
    fetchId: 7,
    offset,
    prefixHash: hashOf(offset),
    enabled: true,
    ...overrides,
  }
}

function readyIds(state: {
  status: string
  turns?: readonly MessageTurn[]
}): string[] | null {
  return state.status === "ready" && state.turns
    ? state.turns.map((t) => t.id)
    : null
}

function deferred<T>() {
  let resolve: (value: T) => void = () => {}
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

beforeEach(() => {
  mockOutline.mockReset()
})

afterEach(() => {
  cleanup()
})

describe("useConversationOutline", () => {
  it("fetches nothing while disabled or with nothing above the window", () => {
    const { result, rerender } = renderHook(
      (props: ConversationOutlineRequest) => useConversationOutline(props),
      { initialProps: request(4, { enabled: false }) }
    )
    expect(result.current.state).toEqual({ status: "idle" })
    rerender(request(0))
    expect(result.current.state).toEqual({ status: "idle" })
    expect(mockOutline).not.toHaveBeenCalled()
  })

  it("loads the history above the window", async () => {
    mockOutline.mockResolvedValue(outlineOf(4))
    const { result } = renderHook(() => useConversationOutline(request(4)))
    expect(result.current.state).toEqual({ status: "loading" })
    await waitFor(() => expect(result.current.state.status).toBe("ready"))
    expect(mockOutline).toHaveBeenCalledWith(7, 4)
    const state = result.current.state
    expect(state.status === "ready" && state.turns.map((t) => t.id)).toEqual([
      "turn-0",
      "turn-1",
      "turn-2",
      "turn-3",
    ])
  })

  it("keeps serving the window as older pages are prepended", async () => {
    mockOutline.mockResolvedValue(outlineOf(4))
    const { result, rerender } = renderHook(
      (props: ConversationOutlineRequest) => useConversationOutline(props),
      { initialProps: request(4) }
    )
    await waitFor(() => expect(result.current.state.status).toBe("ready"))
    rerender(request(2))
    const state = result.current.state
    expect(state.status === "ready" && state.turns.map((t) => t.id)).toEqual([
      "turn-0",
      "turn-1",
    ])
    expect(mockOutline).toHaveBeenCalledTimes(1)
  })

  it("refetches once the window starts below the outline", async () => {
    mockOutline.mockResolvedValueOnce(outlineOf(4))
    const { result, rerender } = renderHook(
      (props: ConversationOutlineRequest) => useConversationOutline(props),
      { initialProps: request(4) }
    )
    await waitFor(() => expect(result.current.state.status).toBe("ready"))
    mockOutline.mockResolvedValueOnce(outlineOf(6))
    rerender(request(6))
    expect(result.current.state).toEqual({ status: "loading" })
    await waitFor(() => expect(result.current.state.status).toBe("ready"))
    expect(mockOutline).toHaveBeenLastCalledWith(7, 6)
  })

  it("never shows an outline whose history differs from the window's", async () => {
    // The window says the history above it was rewritten (another
    // fingerprint); the outline the server returns doesn't reproduce it.
    mockOutline.mockResolvedValue(outlineOf(4))
    const { result, rerender } = renderHook(
      (props: ConversationOutlineRequest) => useConversationOutline(props),
      { initialProps: request(4, { prefixHash: "00000000000000ff" }) }
    )
    await waitFor(() => expect(result.current.state.status).toBe("error"))
    // Not fetched again for the same window…
    rerender(request(4, { prefixHash: "00000000000000ff" }))
    await act(async () => {})
    expect(mockOutline).toHaveBeenCalledTimes(1)
    // …until the window moves.
    rerender(request(4))
    await waitFor(() => expect(result.current.state.status).toBe("ready"))
  })

  it("retries a failed fetch on request", async () => {
    mockOutline.mockRejectedValueOnce(new Error("offline"))
    const { result } = renderHook(() => useConversationOutline(request(4)))
    await waitFor(() => expect(result.current.state.status).toBe("error"))
    mockOutline.mockResolvedValueOnce(outlineOf(4))
    act(() => result.current.retry())
    await waitFor(() => expect(result.current.state.status).toBe("ready"))
    expect(mockOutline).toHaveBeenCalledTimes(2)
  })

  it("fetches for the current window once a fetch for an older one lands", async () => {
    const first = deferred<ConversationOutline>()
    mockOutline.mockReturnValueOnce(first.promise)
    const { result, rerender } = renderHook(
      (props: ConversationOutlineRequest) => useConversationOutline(props),
      { initialProps: request(4) }
    )
    // The window was reset further down while the first fetch was out.
    rerender(request(6))
    expect(mockOutline).toHaveBeenCalledTimes(1)
    mockOutline.mockResolvedValueOnce(outlineOf(6))
    await act(async () => first.resolve(outlineOf(4)))
    await waitFor(() => expect(result.current.state.status).toBe("ready"))
    expect(mockOutline).toHaveBeenCalledTimes(2)
    expect(mockOutline).toHaveBeenLastCalledWith(7, 6)
    expect(readyIds(result.current.state)).toEqual(
      FULL.slice(0, 6).map((t) => t.id)
    )
  })

  it("fetches once under StrictMode's doubled effects", async () => {
    mockOutline.mockResolvedValue(outlineOf(4))
    const { result } = renderHook(() => useConversationOutline(request(4)), {
      wrapper: StrictMode,
    })
    await waitFor(() => expect(result.current.state.status).toBe("ready"))
    expect(mockOutline).toHaveBeenCalledTimes(1)
  })

  it("never serves one conversation's outline to another", async () => {
    mockOutline.mockResolvedValueOnce(outlineOf(4))
    const { result, rerender } = renderHook(
      (props: ConversationOutlineRequest) => useConversationOutline(props),
      { initialProps: request(4) }
    )
    await waitFor(() => expect(result.current.state.status).toBe("ready"))
    const other = deferred<ConversationOutline>()
    mockOutline.mockReturnValueOnce(other.promise)
    // Same window coordinates, different conversation.
    rerender(request(4, { fetchId: 8 }))
    expect(result.current.state).toEqual({ status: "loading" })
    expect(mockOutline).toHaveBeenLastCalledWith(8, 4)
    await act(async () => other.resolve(outlineOf(4)))
    expect(result.current.state.status).toBe("ready")
  })

  it("keeps a fetch that lands while the panel is closed", async () => {
    const pending = deferred<ConversationOutline>()
    mockOutline.mockReturnValueOnce(pending.promise)
    const { result, rerender } = renderHook(
      (props: ConversationOutlineRequest) => useConversationOutline(props),
      { initialProps: request(4) }
    )
    rerender(request(4, { enabled: false }))
    expect(result.current.state).toEqual({ status: "idle" })
    await act(async () => pending.resolve(outlineOf(4)))
    rerender(request(4))
    expect(readyIds(result.current.state)).toEqual(
      FULL.slice(0, 4).map((t) => t.id)
    )
    expect(mockOutline).toHaveBeenCalledTimes(1)
  })

  it("doesn't fail the current window over an older window's failed fetch", async () => {
    const stale = deferred<ConversationOutline>()
    mockOutline.mockReturnValueOnce(
      stale.promise.then(() => Promise.reject(new Error("offline")))
    )
    const { result, rerender } = renderHook(
      (props: ConversationOutlineRequest) => useConversationOutline(props),
      { initialProps: request(4) }
    )
    rerender(request(6))
    mockOutline.mockResolvedValueOnce(outlineOf(6))
    await act(async () => stale.resolve(outlineOf(4)))
    await waitFor(() => expect(result.current.state.status).toBe("ready"))
    expect(mockOutline).toHaveBeenLastCalledWith(7, 6)
  })

  it("drops a served outline once the shorter prefix it covers was rewritten", async () => {
    mockOutline.mockResolvedValueOnce(outlineOf(4))
    const { result, rerender } = renderHook(
      (props: ConversationOutlineRequest) => useConversationOutline(props),
      { initialProps: request(4) }
    )
    await waitFor(() => expect(result.current.state.status).toBe("ready"))
    const refetch = deferred<ConversationOutline>()
    mockOutline.mockReturnValueOnce(refetch.promise)
    // The window moved up to 2, but its history isn't the one fetched.
    rerender(request(2, { prefixHash: "00000000000000ab" }))
    expect(result.current.state).toEqual({ status: "loading" })
    expect(mockOutline).toHaveBeenLastCalledWith(7, 2)
  })
})
