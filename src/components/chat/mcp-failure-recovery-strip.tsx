"use client"

/**
 * Chat-session MCP initialization failure recovery strip (#1295).
 *
 * Detects MCP server initialization errors in the current session's active
 * failure records or load/connect error text (automatically ignoring the
 * built-in `chrome_devtools` server) and offers:
 *   1. "Pause `<server>` & reconnect" — reversibly pauses the failing server
 *      for the current agent via `mcpInventory` + `mcpApply(set_enabled: false)`
 *      and reconnects the session.
 *   2. "Open MCP settings" — jumps directly to Harness › MCP on `<server>`.
 *   3. Dismiss — hides only the current failure instance.
 *
 * Renders zero DOM when no actionable MCP initialization failure is present.
 */
import { useMemo, useState } from "react"
import { Loader2, PauseCircle, PlugZap, Settings2 } from "lucide-react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"

import { ComposerDockStrip } from "@/components/chat/composer-dock-strip"
import { Button } from "@/components/ui/button"
import { useOpenHarness } from "@/hooks/use-open-harness"
import { mcpApply, mcpInventory } from "@/lib/mcp/api"
import {
  agentTypeToMcpApp,
  extractMcpInitFailure,
  type McpInitFailure,
} from "@/lib/mcp/failure-recovery"
import { isSaved } from "@/lib/mcp/results"
import type { AgentType, SessionFailureRecord } from "@/lib/types"

export interface McpFailureRecoveryStripProps {
  agentType?: AgentType | null
  sessionFailures?: readonly SessionFailureRecord[]
  /** Extra failure text such as `acpLoadError` or `autoConnectError`. */
  errorText?: string | null
  onReconnect?: () => void | Promise<void>
}

interface DetectedFailure extends McpInitFailure {
  instanceKey: string
}

function detectFailure(
  sessionFailures: readonly SessionFailureRecord[] | undefined,
  errorText: string | null | undefined
): DetectedFailure | null {
  if (sessionFailures && sessionFailures.length > 0) {
    for (let i = sessionFailures.length - 1; i >= 0; i -= 1) {
      const record = sessionFailures[i]
      if (record.resolved) continue
      const candidate =
        (record.details ? extractMcpInitFailure(record.details) : null) ??
        extractMcpInitFailure(record.title)
      if (candidate) {
        return {
          ...candidate,
          instanceKey: `failure:${record.id}:${candidate.serverName}`,
        }
      }
    }
  }
  if (errorText) {
    const candidate = extractMcpInitFailure(errorText)
    if (candidate) {
      return {
        ...candidate,
        instanceKey: `error:${candidate.serverName}:${candidate.reason}`,
      }
    }
  }
  return null
}

export function McpFailureRecoveryStrip({
  agentType,
  sessionFailures,
  errorText,
  onReconnect,
}: McpFailureRecoveryStripProps) {
  const t = useTranslations("Folder.chat.mcpRecovery")
  const { available: harnessAvailable, openHarness } = useOpenHarness()
  const [dismissedKey, setDismissedKey] = useState<string | null>(null)
  const [pausing, setPausing] = useState(false)

  const detected = useMemo(
    () => detectFailure(sessionFailures, errorText),
    [sessionFailures, errorText]
  )

  if (!detected || dismissedKey === detected.instanceKey) return null

  const mcpApp = agentTypeToMcpApp(agentType)

  const handlePauseAndReconnect = async () => {
    if (!mcpApp || pausing) return
    setPausing(true)
    try {
      const inventory = await mcpInventory()
      const agentInv = inventory.agents.find((item) => item.agent === mcpApp)
      const entry = agentInv?.entries.find(
        (item) => item.key === detected.serverName
      )
      if (!agentInv || !entry) {
        toast.error(t("serverNotFound", { server: detected.serverName }))
        return
      }
      if (!entry.enabled) {
        setDismissedKey(detected.instanceKey)
        await onReconnect?.()
        toast.success(
          t("pausedAndReconnecting", { server: detected.serverName })
        )
        return
      }
      if (
        !agentInv.writable ||
        !agentInv.can_disable ||
        entry.read_only ||
        entry.reserved ||
        agentInv.config.basis === null
      ) {
        toast.error(t("cannotPause", { server: detected.serverName }))
        return
      }
      const result = await mcpApply({
        basis: { [mcpApp]: agentInv.config.basis },
        ops: [
          {
            agent: mcpApp,
            key: detected.serverName,
            action: "set_enabled",
            enabled: false,
          },
        ],
      })
      if (!isSaved(result)) {
        toast.error(t("pauseFailed", { server: detected.serverName }))
        return
      }
      setDismissedKey(detected.instanceKey)
      await onReconnect?.()
      toast.success(t("pausedAndReconnecting", { server: detected.serverName }))
    } catch {
      toast.error(t("pauseFailed", { server: detected.serverName }))
    } finally {
      setPausing(false)
    }
  }

  return (
    <ComposerDockStrip
      role="status"
      tone="warning"
      icon={PlugZap}
      title={t("title", { server: detected.serverName })}
      hint={`${detected.serverName}: ${detected.reason}`}
      details={detected.reason}
      onDismiss={() => setDismissedKey(detected.instanceKey)}
      actions={
        <>
          {mcpApp && (
            <Button
              type="button"
              size="xs"
              variant="outline"
              disabled={pausing}
              onClick={() => void handlePauseAndReconnect()}
              className="h-6 border-amber-500/40 bg-background/70 px-2 text-2xs text-amber-800 hover:bg-amber-500/20 dark:text-amber-200"
            >
              {pausing ? (
                <Loader2 aria-hidden="true" className="size-3 animate-spin" />
              ) : (
                <PauseCircle aria-hidden="true" className="size-3" />
              )}
              {pausing
                ? t("pausing")
                : t("pauseAndReconnect", { server: detected.serverName })}
            </Button>
          )}
          {harnessAvailable && (
            <Button
              type="button"
              size="xs"
              variant="ghost"
              disabled={pausing}
              onClick={() =>
                openHarness({
                  section: "mcp",
                  serverKey: detected.serverName,
                })
              }
              className="h-6 px-2 text-2xs text-amber-800 hover:bg-amber-500/20 dark:text-amber-200"
            >
              <Settings2 aria-hidden="true" className="size-3" />
              {t("openSettings")}
            </Button>
          )}
        </>
      }
    />
  )
}
