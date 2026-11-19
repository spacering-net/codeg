"use client"

import { useEffect } from "react"

import { useShortcutSettings } from "@/hooks/use-shortcut-settings"
import {
  isShortcutRecorderArmed,
  matchShortcutEvent,
} from "@/lib/keyboard-shortcuts"
import type { AcpAgentInfo, AgentType } from "@/lib/types"

export interface UseCycleAgentShortcutOptions {
  enabled: boolean
  agents: AcpAgentInfo[]
  selectedAgent: AgentType
  onSelect: (agentType: AgentType) => void
}

export function useCycleAgentShortcut({
  enabled,
  agents,
  selectedAgent,
  onSelect,
}: UseCycleAgentShortcutOptions): void {
  const { shortcuts } = useShortcutSettings()
  const shortcut = shortcuts.cycle_agent

  useEffect(() => {
    if (!enabled || !shortcut) return

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.repeat) return
      if (isShortcutRecorderArmed()) return
      if (!matchShortcutEvent(event, shortcut)) return

      event.preventDefault()

      const usable = agents.filter((agent) => agent.enabled && agent.available)
      if (usable.length === 0) return

      const currentIndex = usable.findIndex(
        (agent) => agent.agent_type === selectedAgent
      )
      const next = usable[(currentIndex + 1) % usable.length]
      if (!next || next.agent_type === selectedAgent) return

      onSelect(next.agent_type)
    }

    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [agents, enabled, onSelect, selectedAgent, shortcut])
}
