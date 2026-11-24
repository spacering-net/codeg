import { act, renderHook, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { AcpAgentInfo, AgentType } from "@/lib/types"

// The registry fetch, driven per test.
const mockAcpListAgents = vi.fn()
vi.mock("@/lib/api", () => ({
  acpListAgents: () => mockAcpListAgents(),
}))

// The hook subscribes through the platform layer. Capture the event handler and
// (optionally) defer the subscribe promise so a test can fire an event / land an
// unmount while the subscription is still pending — the web/remote transports
// register the handler before that promise resolves. Focus is exercised via a
// real `window` event below.
let mockEventHandler: (() => void) | null = null
let mockDeferSubscribe = false
let mockResolveSubscribe: ((dispose: () => void) => void) | null = null
const mockSubscribeDispose = vi.fn()

vi.mock("@/lib/platform", () => ({
  subscribe: vi.fn((_event: string, handler: () => void) => {
    mockEventHandler = handler
    if (mockDeferSubscribe) {
      return new Promise<() => void>((resolve) => {
        mockResolveSubscribe = resolve
      })
    }
    return Promise.resolve(mockSubscribeDispose)
  }),
  onTransportReconnect: vi.fn(() => () => {}),
}))

import { resetAcpAgentsStore, useAcpAgents } from "./use-acp-agents"

function makeAgent(agentType: AgentType, sortOrder: number): AcpAgentInfo {
  return {
    agent_type: agentType,
    skills_capable: true,
    registry_id: agentType,
    registry_version: null,
    supports_custom_version: false,
    name: agentType,
    description: "",
    available: true,
    distribution_type: "npm",
    is_acp_adapter: false,
    custom_source: null,
    enabled: true,
    sort_order: sortOrder,
    installed_version: null,
    host_tools_agent_mode: false,
    env: {},
    config_json: null,
    config_file_path: null,
    codex_auth_json: null,
    codex_config_toml: null,
    codex_model_catalog: null,
    codex_sandbox_settings: null,
    grok_config_toml: null,
    grok_settings: null,
    cline_secrets_json: null,
    hermes_config_yaml: null,
    cursor_cli_config_json: null,
    cursor_settings: null,
    model_provider_id: null,
    icon_url: null,
  }
}

beforeEach(() => {
  mockAcpListAgents.mockReset()
  mockEventHandler = null
  mockDeferSubscribe = false
  mockResolveSubscribe = null
  mockSubscribeDispose.mockClear()
  resetAcpAgentsStore()
})

afterEach(() => {
  resetAcpAgentsStore()
})

describe("useAcpAgents — shared subscription", () => {
  it("shares one fetch across N mounted consumers and coalesces focus reloads", async () => {
    mockAcpListAgents.mockResolvedValue([makeAgent("claude_code", 0)])

    const a = renderHook(() => useAcpAgents())
    const b = renderHook(() => useAcpAgents())

    await waitFor(() => {
      expect(a.result.current.fresh).toBe(true)
      expect(b.result.current.fresh).toBe(true)
    })
    // One shared initial fetch — not one per mounted consumer.
    expect(mockAcpListAgents).toHaveBeenCalledTimes(1)
    // Both read the same shared list.
    expect(a.result.current.agents).toEqual(b.result.current.agents)

    mockAcpListAgents.mockClear()
    await act(async () => {
      window.dispatchEvent(new Event("focus"))
      await Promise.resolve()
    })
    // One coalesced reload on focus, regardless of how many consumers are up
    // (the old per-instance hook fired one scan each).
    expect(mockAcpListAgents).toHaveBeenCalledTimes(1)

    a.unmount()
    b.unmount()
  })

  it("resets to a cold, non-authoritative state when the last consumer unmounts", async () => {
    mockAcpListAgents.mockResolvedValue([makeAgent("claude_code", 0)])

    const first = renderHook(() => useAcpAgents())
    await waitFor(() => expect(first.result.current.fresh).toBe(true))
    expect(first.result.current.agents.map((x) => x.agent_type)).toEqual([
      "claude_code",
    ])

    // Last consumer leaves → subscription disposed, cache dropped to cold.
    first.unmount()

    // The registry changes while nobody is subscribed. Defer the next reload so
    // the pre-reload state on remount is observable.
    let resolveList: (list: AcpAgentInfo[]) => void = () => {}
    mockAcpListAgents.mockReturnValue(
      new Promise<AcpAgentInfo[]>((resolve) => {
        resolveList = resolve
      })
    )

    const second = renderHook(() => useAcpAgents())
    // Kick the queued reload; its fetch is still pending.
    await act(async () => {
      await Promise.resolve()
    })
    // Cold: the missed-update cache is not exposed as authoritative, and there
    // are no stale agents that could drive an (ungated) AgentSelector fallback.
    expect(second.result.current.fresh).toBe(false)
    expect(second.result.current.agents).toEqual([])

    await act(async () => {
      resolveList([makeAgent("claude_code", 0), makeAgent("codex", 1)])
      await Promise.resolve()
    })
    await waitFor(() => expect(second.result.current.fresh).toBe(true))
    expect(second.result.current.agents.map((x) => x.agent_type)).toEqual([
      "claude_code",
      "codex",
    ])

    second.unmount()
  })

  it("skips the queued initial reload if the consumer unmounts before it runs", async () => {
    mockAcpListAgents.mockResolvedValue([makeAgent("claude_code", 0)])

    // Mount then unmount synchronously — the deferred initial reload's microtask
    // has NOT run yet, and (having never started) it never incremented the
    // request counter, so the cleanup's in-flight invalidation can't catch it.
    const first = renderHook(() => useAcpAgents())
    first.unmount()

    // Drain the queued microtask (and any fetch it might have kicked off).
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    // The queued reload must have been skipped (refCount hit 0) — no fetch, so
    // nothing repopulated the cold cache. Without the refCount guard this reload
    // would fire here and set `fresh=true` on the zombie store.
    expect(mockAcpListAgents).not.toHaveBeenCalled()

    // A remount must therefore start cold and re-fetch, not inherit a stale
    // `fresh=true`.
    let resolveList: (list: AcpAgentInfo[]) => void = () => {}
    mockAcpListAgents.mockReturnValue(
      new Promise<AcpAgentInfo[]>((resolve) => {
        resolveList = resolve
      })
    )
    const second = renderHook(() => useAcpAgents())
    await act(async () => {
      await Promise.resolve()
    })
    expect(second.result.current.fresh).toBe(false)
    expect(second.result.current.agents).toEqual([])

    await act(async () => {
      resolveList([makeAgent("codex", 0)])
      await Promise.resolve()
    })
    await waitFor(() => expect(second.result.current.fresh).toBe(true))
    expect(second.result.current.agents.map((x) => x.agent_type)).toEqual([
      "codex",
    ])

    second.unmount()
  })

  it("skips a late event handler that fires after the last unmount while subscribe was still pending", async () => {
    // Defer the subscribe promise: the transport has registered the event
    // handler, but `.then(dispose)` (which sets eventUnsub) has NOT run.
    mockDeferSubscribe = true
    mockAcpListAgents.mockResolvedValue([makeAgent("claude_code", 0)])

    const first = renderHook(() => useAcpAgents())
    // Handler captured; subscribe's promise is still pending (eventUnsub null).
    expect(mockEventHandler).not.toBeNull()

    // Last consumer leaves while subscribe is pending → dispose can't unsub yet
    // (only marks eventDisposed) and cold-resets the cache.
    first.unmount()

    // Drain the queued initial reload (guarded → skipped at refCount 0).
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    // The still-registered handler now fires (an `acp-agents-updated` event)
    // while refCount === 0. Without the shared-`reload` guard this would fetch
    // and repopulate `{fresh:true}` on the zombie store.
    await act(async () => {
      mockEventHandler?.()
      await Promise.resolve()
    })
    expect(mockAcpListAgents).not.toHaveBeenCalled()

    // A remount still starts cold and re-fetches.
    mockDeferSubscribe = false
    let resolveList: (list: AcpAgentInfo[]) => void = () => {}
    mockAcpListAgents.mockReturnValue(
      new Promise<AcpAgentInfo[]>((resolve) => {
        resolveList = resolve
      })
    )
    const second = renderHook(() => useAcpAgents())
    await act(async () => {
      await Promise.resolve()
    })
    expect(second.result.current.fresh).toBe(false)
    expect(second.result.current.agents).toEqual([])

    await act(async () => {
      resolveList([makeAgent("codex", 0)])
      await Promise.resolve()
    })
    await waitFor(() => expect(second.result.current.fresh).toBe(true))

    second.unmount()
    // Resolve the deferred first subscribe so its (eventDisposed) disposer runs.
    mockResolveSubscribe?.(mockSubscribeDispose)
  })
})
