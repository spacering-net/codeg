import { act, renderHook, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { useSessionBrief, useSessionDigest } from "./use-session-digest"
import type { SessionDigest } from "@/lib/session-digest"

const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  brief: vi.fn(),
  handlers: new Map<string, (payload: unknown) => void>(),
  off: vi.fn(),
}))
vi.mock("@/lib/api", () => ({
  sessionDigestAction: mocks.read,
  sessionBriefRead: mocks.brief,
}))
vi.mock("@/lib/transport", () => ({
  getTransport: () => ({
    subscribe: vi.fn(async (name, handler) => {
      mocks.handlers.set(name, handler)
      return mocks.off
    }),
    onReconnect: vi.fn(() => mocks.off),
  }),
}))
const digest = (revision: number): SessionDigest => ({
  revision,
  updatedAt: "2026-11-24T08:00:00Z",
  now: ["Working"],
  news: [],
  needsYou: [],
  suggestions: [],
  answers: {},
  dismissedSuggestions: [],
})

it("refreshes a brief on its own event and clears it when messaging is disabled", async () => {
  mocks.brief.mockResolvedValue({ text: "Before", updatedAt: null })
  const { result } = renderHook(() => useSessionBrief(42))
  await waitFor(() => expect(result.current?.text).toBe("Before"))
  mocks.brief.mockResolvedValue({ text: "After", updatedAt: null })
  act(() =>
    mocks.handlers.get("session-brief://changed")?.({ conversationId: 42 })
  )
  await waitFor(() => expect(result.current?.text).toBe("After"))
  act(() =>
    mocks.handlers.get("delegation-settings://changed")?.({
      session_messaging_enabled: false,
    })
  )
  expect(result.current).toBeNull()
})

describe("useSessionDigest", () => {
  beforeEach(() => {
    mocks.read.mockReset()
    mocks.handlers.clear()
    mocks.off.mockClear()
  })
  it("keeps a newer broadcast when an earlier read finishes late", async () => {
    let resolve!: (value: SessionDigest) => void
    mocks.read.mockReturnValue(
      new Promise((done) => {
        resolve = done
      })
    )
    const { result } = renderHook(() => useSessionDigest(42))
    await waitFor(() =>
      expect(mocks.handlers.has("session-digest://changed")).toBe(true)
    )
    act(() =>
      mocks.handlers.get("session-digest://changed")?.({
        conversationId: 42,
        digest: digest(3),
      })
    )
    await act(async () => resolve(digest(1)))
    expect(result.current.digest?.revision).toBe(3)
  })
  it("does not resurrect digest after its setting is disabled during a read", async () => {
    let resolve!: (value: SessionDigest) => void
    mocks.read.mockReturnValue(
      new Promise((done) => {
        resolve = done
      })
    )
    const { result } = renderHook(() => useSessionDigest(42))
    await waitFor(() =>
      expect(mocks.handlers.has("delegation-settings://changed")).toBe(true)
    )
    act(() =>
      mocks.handlers.get("delegation-settings://changed")?.({
        session_messaging_enabled: false,
      })
    )
    await act(async () => resolve(digest(1)))
    expect(result.current.digest).toBeNull()
  })
  it("ignores a previous conversation's late read after switching sessions", async () => {
    let resolve!: (value: SessionDigest) => void
    mocks.read.mockImplementation((id) =>
      id === 42
        ? new Promise((done) => {
            resolve = done
          })
        : Promise.resolve(digest(9))
    )
    const { result, rerender } = renderHook(({ id }) => useSessionDigest(id), {
      initialProps: { id: 42 },
    })
    rerender({ id: 43 })
    await waitFor(() => expect(result.current.digest?.revision).toBe(9))
    await act(async () => resolve(digest(1)))
    expect(result.current.digest?.revision).toBe(9)
  })
})
