import { act, renderHook, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { useSubscriptionQuota, type QuotaRead } from "./use-subscription-quota"

const mock = vi.hoisted(() => ({
  call: vi.fn(),
  remote: null as string | null,
}))
vi.mock("@/lib/transport", () => ({
  getTransport: () => ({ call: mock.call }),
  getActiveRemoteConnectionId: () => mock.remote,
}))
vi.mock("@/lib/platform", () => ({ subscribe: async () => () => {} }))

function result(id: string, remaining = 20): QuotaRead {
  return {
    agentType: "claude_code",
    agentAccountId: id,
    family: "claude",
    name: id,
    checkedAt: 1_780_000_000,
    payload: { five_hour: { utilization: 100 - remaining } },
  }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((yes) => {
    resolve = yes
  })
  return { promise, resolve }
}

describe("account-specific quota reads", () => {
  beforeEach(() => {
    mock.call.mockReset()
    mock.remote = null
  })

  it("ignores the previous account's late response after switching", async () => {
    const a = deferred<QuotaRead>(),
      b = deferred<QuotaRead>()
    mock.call.mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise)
    const hook = renderHook(
      ({ id }) =>
        useSubscriptionQuota({
          agentType: "claude_code",
          agentAccountId: id,
          conversationId: 17,
        }),
      { initialProps: { id: "a" } }
    )
    await waitFor(() => expect(mock.call).toHaveBeenCalledTimes(1))
    hook.rerender({ id: "b" })
    expect(hook.result.current.data).toBeNull()
    await waitFor(() => expect(mock.call).toHaveBeenCalledTimes(2))
    await act(async () => a.resolve(result("a", 90)))
    expect(hook.result.current.data).toBeNull()
    await act(async () => b.resolve(result("b", 10)))
    expect(hook.result.current.data?.agentAccountId).toBe("b")
    expect(mock.call).toHaveBeenLastCalledWith("subscription_quota_read", {
      request: {
        agentType: "claude_code",
        agentAccountId: "b",
        conversationId: 17,
      },
    })
  })

  it("clears the previous balance when a refresh fails", async () => {
    mock.call
      .mockResolvedValueOnce(result("a"))
      .mockRejectedValueOnce(new Error("offline"))
    const hook = renderHook(() =>
      useSubscriptionQuota({ agentType: "claude_code", agentAccountId: "a" })
    )
    await waitFor(() => expect(hook.result.current.data).not.toBeNull())
    await act(async () => hook.result.current.refresh())
    expect(hook.result.current.data).toBeNull()
    expect(hook.result.current.loading).toBe(false)
  })

  it("does not carry a cached view across remote servers", async () => {
    mock.call.mockResolvedValueOnce(result("a"))
    const b = deferred<QuotaRead>()
    mock.call.mockReturnValueOnce(b.promise)
    const hook = renderHook(() =>
      useSubscriptionQuota({ agentType: "claude_code", agentAccountId: "a" })
    )
    await waitFor(() => expect(hook.result.current.data).not.toBeNull())
    mock.remote = "server-b"
    hook.rerender()
    expect(hook.result.current.data).toBeNull()
    await act(async () => b.resolve(result("a", 75)))
    await waitFor(() =>
      expect(hook.result.current.data?.payload).toEqual({
        five_hour: { utilization: 25 },
      })
    )
  })
})
