import { act, cleanup, renderHook } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
import {
  listPendingSessionMessages,
  type PendingSessionMessage,
} from "@/lib/api"
import { usePendingSessionMessages } from "./use-pending-session-messages"

vi.mock("@/lib/api", () => ({ listPendingSessionMessages: vi.fn() }))
const list = vi.mocked(listPendingSessionMessages)
const report: PendingSessionMessage = {
  message_id: "r1",
  message: "Review needed",
  source_conversation_id: 6,
  source_title: "API review",
  source_kind: "child",
  created_at: "2026-11-11T05:43:41Z",
}

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.resetAllMocks()
})

it("loads persisted messages on reopen and removes them after backend dispatch", async () => {
  vi.useFakeTimers()
  list.mockResolvedValueOnce([report]).mockResolvedValue([])
  const { result, unmount } = renderHook(() =>
    usePendingSessionMessages(5, true)
  )
  await act(async () => {})
  expect(result.current).toEqual([report])
  await act(() => vi.advanceTimersByTimeAsync(1000))
  expect(result.current).toEqual([])
  unmount()
  list.mockResolvedValue([report])
  const reopened = renderHook(() => usePendingSessionMessages(5, true))
  await act(async () => {})
  expect(reopened.result.current).toEqual([report])
})

it("ignores an old conversation's delayed response and stops polling when inactive", async () => {
  vi.useFakeTimers()
  let resolveOld!: (items: PendingSessionMessage[]) => void
  list
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOld = resolve
        })
    )
    .mockResolvedValue([])
  const { result, rerender } = renderHook(
    ({ id, active }) => usePendingSessionMessages(id, active),
    { initialProps: { id: 5, active: true } }
  )
  rerender({ id: 7, active: true })
  await act(async () => {
    resolveOld([report])
  })
  expect(result.current).toEqual([])
  rerender({ id: 7, active: false })
  const calls = list.mock.calls.length
  await act(() => vi.advanceTimersByTimeAsync(3000))
  expect(list).toHaveBeenCalledTimes(calls)
})
