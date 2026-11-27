"use client"

/**
 * MCP declaration card on a custom agent's settings page.
 *
 * codeg injects its built-in codeg-mcp companion into `session/new`'s
 * `mcpServers` — that is what backs delegation, live feedback and the task
 * tools. Most ACP agents accept it, but some reject any entry in that field
 * and fail session creation outright, so the agent cannot be connected to at
 * all until the injection stops. codeg cannot detect which kind an arbitrary
 * agent is, so the user declares it here (OpenClaw is the built-in precedent,
 * where the same flag is a compile-time constant).
 *
 * Like the skills declarations this lives on the stored definition
 * (`supports_mcp`), so a change re-saves the whole definition and re-hydrates
 * the launch registry. It takes effect on the next connection — a session
 * already running keeps the servers it was started with.
 */

import { useCallback, useEffect, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { Plug } from "lucide-react"
import { toast } from "sonner"

import { AgentPanelCard } from "@/components/settings/agent-panel-layout"
import { Switch } from "@/components/ui/switch"
import {
  acpListCustomAgents,
  acpPatchCustomAgent,
  type CustomAgentInfo,
} from "@/lib/api"

const MCP_SWITCH_ID = "custom-agent-mcp-supported"

interface CustomAgentMcpToggleProps {
  registryId: string
}

export function CustomAgentMcpToggle({
  registryId,
}: CustomAgentMcpToggleProps) {
  const t = useTranslations("AcpAgentSettings")
  const [info, setInfo] = useState<CustomAgentInfo | null>(null)
  const [saving, setSaving] = useState(false)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    let cancelled = false
    acpListCustomAgents()
      .then((list) => {
        if (cancelled) return
        setInfo(list.find((a) => a.registryId === registryId) ?? null)
      })
      .catch(() => {
        // Leave the card hidden; the surrounding page already surfaces
        // list/load errors.
      })
    return () => {
      cancelled = true
      mountedRef.current = false
    }
  }, [registryId])

  const handleToggle = useCallback(
    async (next: boolean) => {
      if (!info) return
      setSaving(true)
      // Optimistic: the switch reflects the target state while the save runs
      // and snaps back on failure.
      setInfo({ ...info, supportsMcp: next })
      try {
        // Only this declaration is patched — `acpPatchCustomAgent` re-reads the
        // rest, so this card cannot revert a skills change the card above it
        // made after this one mounted.
        await acpPatchCustomAgent(info.registryId, { supportsMcp: next })
      } catch (err) {
        if (mountedRef.current) setInfo({ ...info, supportsMcp: !next })
        toast.error(err instanceof Error ? err.message : String(err))
      } finally {
        if (mountedRef.current) setSaving(false)
      }
    },
    [info]
  )

  if (!info) return null

  return (
    <AgentPanelCard
      icon={Plug}
      title={t("customAgentMcpLabel")}
      description={t("customAgentMcpHint")}
      htmlFor={MCP_SWITCH_ID}
      control={
        <Switch
          id={MCP_SWITCH_ID}
          checked={info.supportsMcp}
          disabled={saving}
          onCheckedChange={(v) => void handleToggle(v)}
        />
      }
    />
  )
}
