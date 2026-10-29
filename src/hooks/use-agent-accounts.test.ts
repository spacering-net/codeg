import { act, renderHook } from "@testing-library/react"
import { beforeEach, expect, it, vi } from "vitest"

import type { AgentAccountsResult } from "@/lib/agent-accounts"
import type { AgentType } from "@/lib/types"

const mockList = vi.fn<(agentType: AgentType) => Promise<AgentAccountsResult>>()
vi.mock("@/lib/agent-accounts", () => ({
  listAgentAccounts: (agentType: AgentType) => mockList(agentType),
}))

// Like the web transport, keep update handlers in a set (so the same function
// subscribed twice is one entry) and let a test hold subscriptions pending.
const mockHandlers = new Set<() => void>()
let mockDeferSubscribe = false
const mockPendingSubscribes: Array<() => void> = []
let mockReconnected: (() => void) | null = null
vi.mock("@/lib/platform", () => ({
  subscribe: vi.fn((_event: string, handler: () => void) => {
    mockHandlers.add(handler)
    const dispose = () => {
      mockHandlers.delete(handler)
    }
    if (!mockDeferSubscribe) return Promise.resolve(dispose)
    return new Promise((resolve) => {
      mockPendingSubscribes.push(() => resolve(dispose))
    })
  }),
  onTransportReconnect: vi.fn((handler: () => void) => {
    mockReconnected = handler
    return () => {
      mockReconnected = null
    }
  }),
}))

function fireUpdate() {
  for (const handler of [...mockHandlers]) handler()
}

import { resetAgentAccountsStore, useAgentAccounts } from "./use-agent-accounts"

function listed(agentType: AgentType, names: string[]): AgentAccountsResult {
  return {
    accounts: names.map((name) => ({
      id: `${agentType}:${name}`,
      agentType,
      name,
      homeDir: `/profiles/${name}`,
      removed: false,
    })),
    capabilities: [
      { agentType, supported: true, reason: null, loginKind: "terminal" },
    ],
  }
}

function names(hook: {
  result: { current: { accounts: { name: string }[] } }
}) {
  return hook.result.current.accounts.map((account) => account.name)
}

// Mount under act and let the deferred first fetch land inside it.
async function mount(agentType: AgentType) {
  const hook = renderHook(() => useAgentAccounts(agentType))
  await settle()
  return hook
}

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

beforeEach(() => {
  mockList.mockReset()
  mockHandlers.clear()
  mockDeferSubscribe = false
  mockPendingSubscribes.length = 0
  mockReconnected = null
  resetAgentAccountsStore()
})

// Every open conversation tab mounts the hook, hidden tabs included. Each one
// used to fetch for itself, so one registry change sent a request per tab.
it("fetches once for every tab showing the same agent", async () => {
  mockList.mockImplementation(async (agent) => listed(agent, ["Work"]))
  const tabs = [0, 1, 2].map(() => renderHook(() => useAgentAccounts("codex")))
  await settle()
  expect(tabs[2].result.current.loading).toBe(false)
  expect(mockList).toHaveBeenCalledTimes(1)
  for (const tab of tabs) expect(names(tab)).toEqual(["Work"])

  mockList.mockImplementation(async (agent) =>
    listed(agent, ["Work", "Personal"])
  )
  act(() => fireUpdate())
  await settle()
  expect(names(tabs[0])).toEqual(["Work", "Personal"])
  expect(mockList).toHaveBeenCalledTimes(2)
  expect(names(tabs[2])).toEqual(["Work", "Personal"])
})

it("keeps one list per agent and refetches them after a reconnect", async () => {
  mockList.mockImplementation(async (agent) => listed(agent, [agent]))
  const codex = await mount("codex")
  const claude = await mount("claude_code")
  expect(names(claude)).toEqual(["claude_code"])
  expect(names(codex)).toEqual(["codex"])
  expect(mockList).toHaveBeenCalledTimes(2)

  // Events emitted while a web client was disconnected are lost.
  act(() => mockReconnected?.())
  await settle()
  expect(mockList).toHaveBeenCalledTimes(4)
  expect(mockList.mock.calls.map(([agent]) => agent).sort()).toEqual([
    "claude_code",
    "claude_code",
    "codex",
    "codex",
  ])
})

// With one shared copy, a transient failure must not empty every tab at once:
// a draft whose picked account drops out of the list reads as unavailable.
it("keeps the last list when a refresh fails", async () => {
  mockList.mockResolvedValueOnce(listed("codex", ["Work"]))
  const tab = await mount("codex")
  expect(names(tab)).toEqual(["Work"])

  mockList.mockRejectedValueOnce(new Error("offline"))
  act(() => fireUpdate())
  await settle()
  expect(tab.result.current.error).toBe(true)
  expect(names(tab)).toEqual(["Work"])

  mockList.mockResolvedValueOnce(listed("codex", ["Work", "Personal"]))
  await act(async () => {
    await tab.result.current.refresh()
  })
  expect(tab.result.current.error).toBe(false)
  expect(names(tab)).toEqual(["Work", "Personal"])
})

it("ignores a response that lands after a newer one", async () => {
  mockList.mockResolvedValueOnce(listed("codex", ["Work"]))
  const tab = await mount("codex")
  expect(names(tab)).toEqual(["Work"])

  let landOld!: (result: AgentAccountsResult) => void
  mockList
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          landOld = resolve
        })
    )
    .mockResolvedValueOnce(listed("codex", ["Renamed"]))
  act(() => fireUpdate())
  act(() => fireUpdate())
  await settle()
  expect(names(tab)).toEqual(["Renamed"])
  landOld(listed("codex", ["Stale"]))
  await settle()
  expect(names(tab)).toEqual(["Renamed"])
})

// Nothing listens for updates while no consumer is mounted, so the next one
// starts from a fresh fetch rather than a list that may have missed one.
it("refetches for a consumer mounted after the last one left", async () => {
  mockList.mockResolvedValueOnce(listed("codex", ["Work"]))
  const first = await mount("codex")
  expect(names(first)).toEqual(["Work"])
  first.unmount()
  expect(mockHandlers.size).toBe(0)

  mockList.mockResolvedValueOnce(listed("codex", ["Personal"]))
  const next = renderHook(() => useAgentAccounts("codex"))
  expect(next.result.current.loading).toBe(true)
  await settle()
  expect(names(next)).toEqual(["Personal"])
  expect(mockList).toHaveBeenCalledTimes(2)
})

// A subscription torn down before it was confirmed (React's dev double-mount,
// or a tab closed right after opening) is disposed when it resolves. It must
// not take the handler of the subscription that replaced it.
it("keeps listening when a remount outruns the first subscription", async () => {
  mockDeferSubscribe = true
  mockList.mockImplementation(async (agent) => listed(agent, ["Work"]))
  renderHook(() => useAgentAccounts("codex")).unmount()
  const tab = renderHook(() => useAgentAccounts("codex"))
  await settle()
  act(() => {
    for (const resolve of mockPendingSubscribes.splice(0)) resolve()
  })
  await settle()
  expect(mockHandlers.size).toBe(1)
  expect(mockList).toHaveBeenCalledTimes(1)

  mockList.mockImplementation(async (agent) =>
    listed(agent, ["Work", "Personal"])
  )
  act(() => fireUpdate())
  await settle()
  expect(names(tab)).toEqual(["Work", "Personal"])
})
