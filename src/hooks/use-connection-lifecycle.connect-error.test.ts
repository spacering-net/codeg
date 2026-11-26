/**
 * The composer's inline banner reads `autoConnectError`, which the hook used to
 * learn only from the promise its own auto-connect got back. A connect request
 * that lands while another is still in flight for the same key is PARKED: its
 * promise resolves at once, and the provider runs it later from the in-flight
 * call's cleanup, swallowing the rejection there. So when a draft switches
 * agents mid-connect and the agent picked last fails, the hook saw a success.
 * The provider still publishes that failure for the key (it is what the toast
 * and the status chip show); the banner has to read it too.
 */

import { renderHook } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { ConnectErrorInfo } from "@/contexts/acp-connections-context"

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

vi.mock("@/contexts/acp-connections-context", () => {
  const actions = {
    setActiveKey: vi.fn(),
    releaseActiveKey: vi.fn(),
    touchActivity: vi.fn(),
  }
  return { useAcpActions: () => actions }
})

vi.mock("@/contexts/task-context", () => {
  const context = { addTask: vi.fn(), updateTask: vi.fn(), removeTask: vi.fn() }
  return { useTaskContext: () => context }
})

const conn = vi.hoisted(() => ({
  status: null as string | null,
  connectError: null as ConnectErrorInfo | null,
  connect: vi.fn().mockResolvedValue(undefined),
}))

vi.mock("@/hooks/use-connection", () => {
  // A parked request: the call resolves without saying how the request did.
  const noop = vi.fn().mockResolvedValue(undefined)
  return {
    useConnection: () => ({
      status: conn.status,
      agentType: null,
      connectError: conn.connectError,
      selectorsReady: false,
      hasCachedSelectors: false,
      connect: conn.connect,
      disconnect: noop,
      sendPrompt: noop,
      setMode: noop,
      setConfigOption: noop,
      cancel: noop,
      respondPermission: noop,
      modes: null,
      configOptions: null,
      isViewer: false,
      backgroundOutstanding: 0,
      asyncTasks: [],
      remoteControl: null,
      delegatedChildren: [],
    }),
  }
})

import { useConnectionLifecycle } from "@/hooks/use-connection-lifecycle"

function renderDraft() {
  return renderHook(() =>
    useConnectionLifecycle({
      contextKey: "draft-tab",
      agentType: "codex",
      isActive: true,
      workingDir: "/tmp/proj",
    })
  )
}

describe("useConnectionLifecycle autoConnectError", () => {
  beforeEach(() => {
    conn.status = null
    conn.connectError = null
    conn.connect.mockReset()
    conn.connect.mockResolvedValue(undefined)
  })

  it("reports the published failure of a request that was parked", async () => {
    conn.connectError = {
      agentType: "codex",
      title: "connectFailedTitle",
      detail: "spawn failed: exit code 1",
      opensAgentSettings: false,
    }
    const { result } = renderDraft()
    // Let the auto-connect promise resolve, as a parked request's does.
    await vi.waitFor(() => {
      expect(result.current.autoConnectError).toBe("spawn failed: exit code 1")
    })
  })

  it("falls back to the title when the failure has nothing more to say", () => {
    conn.connectError = {
      agentType: "codex",
      title: "Codex's ACP adapter is not installed",
      detail: null,
      opensAgentSettings: true,
    }
    const { result } = renderDraft()
    expect(result.current.autoConnectError).toBe(
      "Codex's ACP adapter is not installed"
    )
  })

  it("ignores a failure published for another agent", () => {
    conn.connectError = {
      agentType: "claude_code",
      title: "connectFailedTitle",
      detail: "old agent failed",
      opensAgentSettings: false,
    }
    const { result } = renderDraft()
    expect(result.current.autoConnectError).toBeNull()
  })

  it("stays quiet once the session is up", () => {
    conn.status = "connected"
    conn.connectError = {
      agentType: "codex",
      title: "connectFailedTitle",
      detail: "stale",
      opensAgentSettings: false,
    }
    const { result } = renderDraft()
    expect(result.current.autoConnectError).toBeNull()
  })

  it("extracts readable text from structured AppCommandError objects instead of [object Object]", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {})
    try {
      conn.connect.mockRejectedValueOnce({
        code: "task_execution_failed",
        message: "Failed to initialize ACP connection",
        detail: "MCP load failed for qa-mismatch-404: 404 Not Found",
      })
      const { result } = renderDraft()
      await vi.waitFor(() => {
        expect(result.current.autoConnectError).toContain(
          "MCP load failed for qa-mismatch-404: 404 Not Found"
        )
      })
      expect(result.current.autoConnectError).not.toContain("[object Object]")
    } finally {
      consoleError.mockRestore()
    }
  })
})
