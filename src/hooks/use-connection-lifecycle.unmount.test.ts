/**
 * The view's unmount cleanup (tab closed, preview slot taken, the conversation
 * surface swapped out) must hand the teardown gate EVERYTHING the connection
 * knows about its live work. The gate used to see only the turn status and the
 * transcript watcher's count, so work announced on the AIR async-task channel
 * alone — a codex background terminal, a Claude Monitor task — was killed with
 * the agent CLI the moment its view went away.
 *
 * It must also give back the active key the view claimed, or the busy owner it
 * leaves running stays out of both sweeps after its work settles.
 */

import { renderHook } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { AsyncTaskRecord, RemoteControlInfo } from "@/lib/types"

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

const acp = vi.hoisted(() => ({
  setActiveKey: (() => {}) as (key: string | null) => void,
  releaseActiveKey: (() => {}) as (key: string) => void,
  touchActivity: (() => {}) as (key: string) => void,
}))

vi.mock("@/contexts/acp-connections-context", () => ({
  useAcpActions: () => acp,
}))

vi.mock("@/contexts/task-context", () => {
  const context = { addTask: vi.fn(), updateTask: vi.fn(), removeTask: vi.fn() }
  return { useTaskContext: () => context }
})

const conn = vi.hoisted(() => ({
  isViewer: false,
  asyncTasks: [] as AsyncTaskRecord[],
  remoteControl: null as RemoteControlInfo | null,
  delegatedChildren: [] as string[],
  disconnect: (() => Promise.resolve()) as () => Promise<void>,
}))

vi.mock("@/hooks/use-connection", () => {
  const noop = vi.fn().mockResolvedValue(undefined)
  return {
    useConnection: () => ({
      status: "connected",
      agentType: "codex",
      connectError: null,
      selectorsReady: true,
      hasCachedSelectors: true,
      connect: noop,
      disconnect: conn.disconnect,
      sendPrompt: noop,
      setMode: noop,
      setConfigOption: noop,
      cancel: noop,
      respondPermission: noop,
      modes: null,
      configOptions: null,
      isViewer: conn.isViewer,
      backgroundOutstanding: 0,
      asyncTasks: conn.asyncTasks,
      remoteControl: conn.remoteControl,
      delegatedChildren: conn.delegatedChildren,
    }),
  }
})

import { useConnectionLifecycle } from "@/hooks/use-connection-lifecycle"

function backgroundTerminal(state: string): AsyncTaskRecord {
  return {
    task_id: "call_bg_1",
    name: "npm run dev",
    task_type: "shell",
    description: "",
    show_in_transcript: false,
    can_stop: true,
    state,
  }
}

const KEY = "conv-1-codex-42"

function closeView(opts: { isActive?: boolean; transient?: boolean } = {}) {
  const view = renderHook(() =>
    useConnectionLifecycle({
      contextKey: KEY,
      agentType: "codex",
      isActive: opts.isActive ?? false,
      isTransientUnmount: () => opts.transient === true,
    })
  )
  view.unmount()
}

describe("useConnectionLifecycle unmount teardown", () => {
  let disconnect: ReturnType<typeof vi.fn>
  let releaseActiveKey: ReturnType<typeof vi.fn>

  beforeEach(() => {
    disconnect = vi.fn().mockResolvedValue(undefined)
    conn.disconnect = disconnect as unknown as () => Promise<void>
    conn.isViewer = false
    conn.asyncTasks = []
    conn.remoteControl = null
    conn.delegatedChildren = []
    releaseActiveKey = vi.fn()
    acp.setActiveKey = vi.fn()
    acp.releaseActiveKey = releaseActiveKey as unknown as (key: string) => void
    acp.touchActivity = vi.fn()
  })

  it("keeps an owner alive while an async task is still running", () => {
    // Between turns, with nothing in the watcher's count: only the AIR channel
    // knows the terminal is running.
    conn.asyncTasks = [backgroundTerminal("running")]

    closeView()

    expect(disconnect).not.toHaveBeenCalled()
  })

  it("keeps an owner alive while Remote Control is on", () => {
    conn.remoteControl = { session_url: "https://claude.ai/code/session_01" }

    closeView()

    expect(disconnect).not.toHaveBeenCalled()
  })

  it("keeps an owner alive while a delegated sub-agent is running", () => {
    // Ending the parent would cancel the sub-agent with it.
    conn.delegatedChildren = ["child-conn"]

    closeView()

    expect(disconnect).not.toHaveBeenCalled()
  })

  it("disconnects an owner whose tasks have all settled", () => {
    conn.asyncTasks = [backgroundTerminal("completed")]

    closeView()

    expect(disconnect).toHaveBeenCalledTimes(1)
  })

  it("still tears a viewer down, busy or not — its disconnect only detaches", () => {
    conn.isViewer = true
    conn.asyncTasks = [backgroundTerminal("running")]

    closeView()

    expect(disconnect).toHaveBeenCalledTimes(1)
  })

  it("gives back the active key it claimed, even while the owner keeps running", () => {
    conn.asyncTasks = [backgroundTerminal("running")]

    closeView({ isActive: true })

    expect(acp.setActiveKey).toHaveBeenCalledWith(KEY)
    expect(disconnect).not.toHaveBeenCalled()
    expect(releaseActiveKey).toHaveBeenCalledWith(KEY)
  })

  it("keeps the claim across a transient (reparent) unmount", () => {
    closeView({ isActive: true, transient: true })

    expect(disconnect).not.toHaveBeenCalled()
    expect(releaseActiveKey).not.toHaveBeenCalled()
  })
})
