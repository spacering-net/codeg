/**
 * While a draft switches agents, the connection under its key can still belong
 * to the agent the user just left — for a moment, or for good when the new pick
 * can't connect (its preflight refuses it before anything is torn down). The
 * surfaces then show the SELECTED agent's cached config options. An edit to one
 * must not reach the other agent's connection: it would hand that agent a value
 * from a list that isn't its own and file it under that agent's saved
 * preferences, which its next connect ships back.
 */

import { renderHook } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

vi.mock("@/contexts/acp-connections-context", () => {
  const actions = { setActiveKey: vi.fn(), touchActivity: vi.fn() }
  return { useAcpActions: () => actions }
})

vi.mock("@/contexts/task-context", () => {
  const context = { addTask: vi.fn(), updateTask: vi.fn(), removeTask: vi.fn() }
  return { useTaskContext: () => context }
})

const conn = vi.hoisted(() => ({
  agentType: null as string | null,
  setConfigOption: vi.fn(() => Promise.resolve()),
}))

vi.mock("@/hooks/use-connection", () => {
  const noop = vi.fn().mockResolvedValue(undefined)
  return {
    useConnection: () => ({
      status: "connected",
      agentType: conn.agentType,
      connectError: null,
      selectorsReady: true,
      hasCachedSelectors: true,
      connect: noop,
      disconnect: noop,
      sendPrompt: noop,
      setMode: noop,
      setConfigOption: conn.setConfigOption,
      cancel: noop,
      respondPermission: noop,
      modes: null,
      configOptions: null,
      isViewer: false,
      backgroundOutstanding: 0,
    }),
  }
})

import { useConnectionLifecycle } from "@/hooks/use-connection-lifecycle"

function renderDraft() {
  return renderHook(() =>
    useConnectionLifecycle({
      contextKey: "draft-tab",
      agentType: "codex",
      isActive: false,
    })
  )
}

describe("useConnectionLifecycle config edits across an agent switch", () => {
  beforeEach(() => {
    conn.agentType = null
    conn.setConfigOption.mockClear()
  })

  it("keeps an edit off a connection that belongs to the previous agent", () => {
    conn.agentType = "claude_code"
    const { result } = renderDraft()

    result.current.handleSetConfigOption("model", "gpt-5.4")

    expect(conn.setConfigOption).not.toHaveBeenCalled()
  })

  it("applies the edit once the connection is the selected agent's", () => {
    conn.agentType = "codex"
    const { result } = renderDraft()

    result.current.handleSetConfigOption("model", "gpt-5.4")

    expect(conn.setConfigOption).toHaveBeenCalledWith("model", "gpt-5.4")
  })
})
