import { fireEvent, renderHook } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { setShortcutRecorderArmed } from "@/lib/keyboard-shortcuts"
import type { AcpAgentInfo, AgentType } from "@/lib/types"

import { useCycleAgentShortcut } from "./use-cycle-agent-shortcut"

vi.mock("@/hooks/use-shortcut-settings", () => ({
  useShortcutSettings: () => ({
    shortcuts: { cycle_agent: "mod+shift+a" },
    updateShortcut: () => true,
    resetShortcuts: () => {},
  }),
}))

function agent(
  agentType: AgentType,
  overrides: Partial<AcpAgentInfo> = {}
): AcpAgentInfo {
  return {
    agent_type: agentType,
    name: agentType,
    enabled: true,
    available: true,
    installed_version: "1.0.0",
    ...overrides,
  } as unknown as AcpAgentInfo
}

function press(target: EventTarget = window, init: KeyboardEventInit = {}) {
  fireEvent.keyDown(target, {
    key: "a",
    ctrlKey: true,
    shiftKey: true,
    ...init,
  })
}

afterEach(() => {
  setShortcutRecorderArmed(false)
})

describe("useCycleAgentShortcut", () => {
  it("selects the next enabled and available agent", () => {
    const onSelect = vi.fn()
    renderHook(() =>
      useCycleAgentShortcut({
        enabled: true,
        agents: [agent("codex"), agent("claude_code")],
        selectedAgent: "codex",
        onSelect,
      })
    )
    press()
    expect(onSelect).toHaveBeenCalledWith("claude_code")
  })

  it("wraps from the last agent to the first", () => {
    const onSelect = vi.fn()
    renderHook(() =>
      useCycleAgentShortcut({
        enabled: true,
        agents: [agent("codex"), agent("claude_code")],
        selectedAgent: "claude_code",
        onSelect,
      })
    )
    press()
    expect(onSelect).toHaveBeenCalledWith("codex")
  })

  it("skips disabled and platform-unavailable agents", () => {
    const onSelect = vi.fn()
    renderHook(() =>
      useCycleAgentShortcut({
        enabled: true,
        agents: [
          agent("codex"),
          agent("claude_code", { available: false }),
          agent("gemini", { enabled: false }),
          agent("open_code"),
        ],
        selectedAgent: "codex",
        onSelect,
      })
    )
    press()
    expect(onSelect).toHaveBeenCalledWith("open_code")
  })

  it("keeps available-but-not-installed agents in the cycle", () => {
    const onSelect = vi.fn()
    renderHook(() =>
      useCycleAgentShortcut({
        enabled: true,
        agents: [
          agent("codex", { installed_version: null }),
          agent("claude_code"),
        ],
        selectedAgent: "claude_code",
        onSelect,
      })
    )
    press()
    expect(onSelect).toHaveBeenCalledWith("codex")
  })

  it("starts from the first agent when the selection is not in the list", () => {
    const onSelect = vi.fn()
    renderHook(() =>
      useCycleAgentShortcut({
        enabled: true,
        agents: [agent("codex"), agent("claude_code")],
        selectedAgent: "gemini",
        onSelect,
      })
    )
    press()
    expect(onSelect).toHaveBeenCalledWith("codex")
  })

  it("does nothing with fewer than two usable agents", () => {
    const onSelect = vi.fn()
    renderHook(() =>
      useCycleAgentShortcut({
        enabled: true,
        agents: [agent("codex"), agent("claude_code", { available: false })],
        selectedAgent: "codex",
        onSelect,
      })
    )
    press()
    expect(onSelect).not.toHaveBeenCalled()
  })

  it("ignores key repeat", () => {
    const onSelect = vi.fn()
    renderHook(() =>
      useCycleAgentShortcut({
        enabled: true,
        agents: [agent("codex"), agent("claude_code")],
        selectedAgent: "codex",
        onSelect,
      })
    )
    press(window, { repeat: true })
    expect(onSelect).not.toHaveBeenCalled()
  })

  it("ignores the shortcut while a shortcut recorder is armed", () => {
    const onSelect = vi.fn()
    renderHook(() =>
      useCycleAgentShortcut({
        enabled: true,
        agents: [agent("codex"), agent("claude_code")],
        selectedAgent: "codex",
        onSelect,
      })
    )
    setShortcutRecorderArmed(true)
    press()
    expect(onSelect).not.toHaveBeenCalled()
  })

  it("does nothing when disabled", () => {
    const onSelect = vi.fn()
    renderHook(() =>
      useCycleAgentShortcut({
        enabled: false,
        agents: [agent("codex"), agent("claude_code")],
        selectedAgent: "codex",
        onSelect,
      })
    )
    press()
    expect(onSelect).not.toHaveBeenCalled()
  })

  it("fires when focus is inside the composer", () => {
    const onSelect = vi.fn()
    renderHook(() =>
      useCycleAgentShortcut({
        enabled: true,
        agents: [agent("codex"), agent("claude_code")],
        selectedAgent: "codex",
        onSelect,
      })
    )
    const input = document.createElement("input")
    document.body.appendChild(input)
    input.focus()
    press(input)
    expect(onSelect).toHaveBeenCalledWith("claude_code")
    input.remove()
  })

  it("ignores a non-matching key", () => {
    const onSelect = vi.fn()
    renderHook(() =>
      useCycleAgentShortcut({
        enabled: true,
        agents: [agent("codex"), agent("claude_code")],
        selectedAgent: "codex",
        onSelect,
      })
    )
    fireEvent.keyDown(window, { key: "b", ctrlKey: true, shiftKey: true })
    expect(onSelect).not.toHaveBeenCalled()
  })
})
