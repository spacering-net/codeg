"use client"

/**
 * Per-agent defaults editor for delegation. Lives inside the
 * "Multi-Agent Collaboration" settings card under the "Agent defaults" tab,
 * and reads like the assistant editor's agent card: the agent picked at the
 * top, its options as rows of the same card below it.
 *
 * Isolation guarantees (critical — see the v2 plan):
 *   1. Options come from a LIVE probe (`describeAgentOptions`), not from the
 *      chat-side `selectorsCache`. What the user sees here is what codeg-mcp
 *      will actually receive when it spawns a subagent.
 *   2. Saving a value here does NOT call `acpSetConfigOption` or write to
 *      `selector-prefs-storage.ts` localStorage. The chat input's own
 *      selectors are untouched. Persistence happens through the parent's
 *      `setDelegationSettings` save action only.
 *   3. The 30s in-memory snapshot cache lives in module scope here; it does
 *      NOT bleed into the chat context.
 */

import { useCallback, useEffect, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import {
  AlertCircle,
  AlertTriangle,
  Bot,
  Loader2,
  RotateCw,
} from "lucide-react"

import { SettingCard, SettingRow } from "@/components/shared/setting-card"
import { Button } from "@/components/ui/button"
import {
  type AgentDelegationDefaults,
  type AgentOptionsSnapshot,
  type AgentType,
} from "@/lib/types"
import { describeAgentOptions } from "@/lib/api"
import { useAcpAgents } from "@/hooks/use-acp-agents"
import { toErrorMessage } from "@/lib/app-error"
import {
  AgentSelect,
  findModelRow,
  OptionBlock,
  OverrideOptionRow,
  StatusLine,
  useOptionRows,
  type OptionRow,
} from "./agent-options-editor"
import { PanelNotice } from "./panel-notice"

// Probe debounce. Without this, stepping through agents or models would kick
// off a real probe for every step (the backend serializes them per
// agent_type, but every queued probe still spawns the CLI). 250ms is below
// the threshold of feeling laggy while comfortably absorbing a mid-click
// reconsideration.
const PROBE_DEBOUNCE_MS = 250

interface CachedSnapshot {
  snapshot: AgentOptionsSnapshot
  ts: number
}
const SNAPSHOT_TTL_MS = 30_000
// Keyed by (agent, model): an agent that derives one option's choices from
// another's value (opencode lists `effort` per model) answers differently per
// model, so a cached snapshot for one model must not serve another.
const snapshotCache = new Map<string, CachedSnapshot>()

function snapshotKey(agent: AgentType, model: string | null): string {
  return JSON.stringify([agent, model])
}

function readCache(
  agent: AgentType,
  model: string | null
): AgentOptionsSnapshot | null {
  const key = snapshotKey(agent, model)
  const entry = snapshotCache.get(key)
  if (!entry) return null
  if (Date.now() - entry.ts > SNAPSHOT_TTL_MS) {
    snapshotCache.delete(key)
    return null
  }
  return entry.snapshot
}

function writeCache(
  agent: AgentType,
  model: string | null,
  snapshot: AgentOptionsSnapshot
): void {
  snapshotCache.set(snapshotKey(agent, model), { snapshot, ts: Date.now() })
}

/** How many values an agent's defaults override. */
function overrideCount(defaults: AgentDelegationDefaults | undefined): number {
  if (!defaults) return 0
  return (
    (defaults.mode_id ? 1 : 0) +
    Object.keys(defaults.config_values ?? {}).length
  )
}

export interface DelegationAgentDefaultsPanelProps {
  value: Partial<Record<AgentType, AgentDelegationDefaults>>
  onChange: (next: Partial<Record<AgentType, AgentDelegationDefaults>>) => void
  disabled?: boolean
  /** The form's multi-agent switch: while it is off nothing here can be
   *  edited, and the tab says so. `null` while it loads. */
  delegationEnabled?: boolean | null
  /** Show the General tab, where that switch is. */
  onShowGeneral?: () => void
}

export function DelegationAgentDefaultsPanel({
  value,
  onChange,
  disabled,
  delegationEnabled = null,
  onShowGeneral,
}: DelegationAgentDefaultsPanelProps) {
  const t = useTranslations("AcpAgentSettings.multiAgent")
  // Custom ACP agents are delegation targets too (codeg-mcp advertises them
  // in `delegate_to_agent`'s enum), so the registry's list — in the user's
  // agent order — is the list offered. A disabled agent is left out of the
  // enum, so it is not offered here either.
  const { agents } = useAcpAgents()
  // The agent picked here; until then the first one that can run.
  const [picked, setPicked] = useState<AgentType | null>(null)
  const selectedAgent =
    picked ?? agents.find((a) => a.enabled && a.available)?.agent_type ?? null
  // The latest snapshot and what it was probed FOR (agent + model), in ONE
  // state value. It outlives a newer probe: the agent's list of models does
  // not depend on the model picked, so its model row stays offered while the
  // rest is probed again for a newly picked model.
  const [loaded, setLoaded] = useState<{
    agent: AgentType
    model: string | null
    snapshot: AgentOptionsSnapshot
  } | null>(null)
  // The probe for the latest (agent, model) asked for: running, or failed.
  const [probe, setProbe] = useState<{
    agent: AgentType
    model: string | null
    loading: boolean
    error: string | null
  } | null>(null)
  const reqIdRef = useRef(0)

  const loadSnapshot = useCallback(
    async (agent: AgentType, model: string | null, force: boolean) => {
      // Bump FIRST so a cache hit also invalidates a probe still in flight for
      // the previous (agent, model) — otherwise that probe's late answer would
      // replace the snapshot just shown for the current one.
      const reqId = ++reqIdRef.current
      if (!force) {
        const cached = readCache(agent, model)
        if (cached) {
          setLoaded({ agent, model, snapshot: cached })
          setProbe({ agent, model, loading: false, error: null })
          return
        }
      }
      setProbe({ agent, model, loading: true, error: null })
      try {
        const fresh = await describeAgentOptions(
          agent,
          null,
          model ? { model } : null
        )
        if (reqIdRef.current !== reqId) return
        writeCache(agent, model, fresh)
        setLoaded({ agent, model, snapshot: fresh })
        setProbe({ agent, model, loading: false, error: null })
      } catch (err: unknown) {
        if (reqIdRef.current !== reqId) return
        setProbe({ agent, model, loading: false, error: toErrorMessage(err) })
      }
    },
    []
  )

  // The model currently selected for this agent (its saved override). The
  // probe applies it so option lists an agent derives per model — opencode's
  // `effort` — answer for THAT model instead of the agent's own default.
  const probeModel = selectedAgent
    ? (value[selectedAgent]?.config_values?.model ?? null)
    : null

  useEffect(() => {
    if (!selectedAgent) return
    // Debounce so rapid agent picks / model changes (each would fire a real
    // probe — even with backend serialization, each one still spawns the
    // CLI) collapse into a single load. Cancelling on cleanup means the
    // *last* (agent, model) the user lands on wins, not the first.
    const handle = window.setTimeout(() => {
      void loadSnapshot(selectedAgent, probeModel, false)
    }, PROBE_DEBOUNCE_MS)
    return () => window.clearTimeout(handle)
  }, [selectedAgent, probeModel, loadSnapshot])

  // Rows of the selected agent's latest snapshot, in its producer's
  // vocabulary — whichever model that snapshot was probed for.
  const agentLoaded = loaded && loaded.agent === selectedAgent ? loaded : null
  const rows = useOptionRows(
    agentLoaded?.agent ?? null,
    agentLoaded?.snapshot ?? null
  )
  const forSelection = <T extends { agent: AgentType; model: string | null }>(
    x: T | null
  ): x is T => x !== null && x.agent === selectedAgent && x.model === probeModel
  const probing = forSelection(probe) && probe.loading
  const probeError = forSelection(probe) && !probe.loading ? probe.error : null
  // Only a snapshot probed for EXACTLY the current (agent, model) is offered
  // whole. For the whole debounce window after a pick the selection is
  // already the new one while the snapshot is still the previous one's; a
  // value picked off its other rows would land in the new selection.
  const current =
    probeError === null && !probing && forSelection(agentLoaded) ? rows : null
  const modelRow = rows ? findModelRow(rows) : null
  // The probe asked for the selected model and the agent did not switch to
  // it, so the options shown are its OTHER model's. They stay editable — any
  // of them may be left on Default — but the user is told, right under the
  // model.
  const modelNotSwitched =
    current !== null &&
    (agentLoaded?.snapshot.unapplied_config_ids?.includes("model") ?? false)

  const updateAgentDefaults = useCallback(
    (agent: AgentType, next: AgentDelegationDefaults | null) => {
      const updated: Partial<Record<AgentType, AgentDelegationDefaults>> = {
        ...value,
      }
      if (
        next === null ||
        ((!next.mode_id || next.mode_id.length === 0) &&
          Object.keys(next.config_values).length === 0)
      ) {
        delete updated[agent]
      } else {
        updated[agent] = next
      }
      onChange(updated)
    },
    [value, onChange]
  )

  const saved = selectedAgent ? value[selectedAgent] : undefined
  const currentModeId = saved?.mode_id ?? null
  const currentConfigValues = saved?.config_values ?? {}

  const setRowValue = (row: OptionRow, next: string | null) => {
    if (!selectedAgent) return
    if (row.kind === "mode") {
      updateAgentDefaults(selectedAgent, {
        mode_id: next ?? undefined,
        config_values: { ...currentConfigValues },
      })
      return
    }
    const nextConfig = { ...currentConfigValues }
    if (next === null) {
      delete nextConfig[row.id]
    } else {
      nextConfig[row.id] = next
    }
    updateAgentDefaults(selectedAgent, {
      mode_id: currentModeId ?? undefined,
      config_values: nextConfig,
    })
  }

  const renderRow = (row: OptionRow) => (
    <OptionBlock key={row.id}>
      <OverrideOptionRow
        row={row}
        value={
          row.kind === "mode"
            ? currentModeId
            : (currentConfigValues[row.id] ?? null)
        }
        onChange={(next) => setRowValue(row, next)}
        disabled={disabled}
      />
    </OptionBlock>
  )

  const retry = (
    <Button
      type="button"
      size="xs"
      variant="outline"
      className="bg-background"
      onClick={() => {
        if (selectedAgent) void loadSnapshot(selectedAgent, probeModel, true)
      }}
    >
      <RotateCw aria-hidden />
      {t("retry")}
    </Button>
  )

  // The agent's options, as rows of its card — or, while they cannot be
  // offered, the model row (still the agent's list of models) and the line
  // saying why the rest is not there.
  const options = (): React.ReactNode => {
    // Nothing until the agent list says which agent to start on.
    if (selectedAgent === null) return null
    if (probeError !== null || current === null) {
      return (
        <>
          {modelRow ? renderRow(modelRow) : null}
          <OptionBlock>
            {probeError !== null ? (
              <StatusLine
                tone="error"
                icon={<AlertCircle className="size-3.5" aria-hidden />}
                action={retry}
              >
                {t("probeFailed", { detail: probeError })}
              </StatusLine>
            ) : (
              <StatusLine
                tone="muted"
                icon={<Loader2 className="size-3.5 animate-spin" aria-hidden />}
              >
                {t("probing")}
              </StatusLine>
            )}
          </OptionBlock>
        </>
      )
    }
    if (current.length === 0) {
      return (
        <OptionBlock>
          <StatusLine tone="muted">{t("noConfigAvailable")}</StatusLine>
        </OptionBlock>
      )
    }
    const notSwitched = modelNotSwitched ? (
      <OptionBlock key="model-not-switched">
        <StatusLine
          tone="warning"
          icon={<AlertTriangle className="size-3.5" aria-hidden />}
          action={retry}
        >
          {t("modelNotSwitched")}
        </StatusLine>
      </OptionBlock>
    ) : null
    // The model row comes first (`buildOptionRows`); the warning about it
    // goes right under it, above the options it is about.
    const model = findModelRow(current)
    return (
      <>
        {model ? null : notSwitched}
        {current.flatMap((row) =>
          row === model ? [renderRow(row), notSwitched] : [renderRow(row)]
        )}
      </>
    )
  }

  return (
    <div className="space-y-3">
      <p className="text-xs leading-5 text-muted-foreground">
        {t("agentDefaultsDescription")}
      </p>

      {delegationEnabled === false ? (
        <PanelNotice
          tone="warning"
          icon={<AlertTriangle className="size-3.5" aria-hidden />}
          action={
            onShowGeneral ? (
              <Button
                size="xs"
                variant="outline"
                className="bg-background"
                onClick={onShowGeneral}
              >
                {t("assistants.delegationOffAction", {
                  tab: t("tabGeneral"),
                })}
              </Button>
            ) : null
          }
        >
          {t("agentDefaultsDelegationOff")}
        </PanelNotice>
      ) : null}

      <SettingCard>
        <SettingRow
          icon={Bot}
          title={t("assistants.agentLabel")}
          description={t("agentDefaultsAgentHint")}
          control={
            <AgentSelect
              value={selectedAgent}
              onChange={setPicked}
              agents={agents.filter(
                (a) => a.enabled || a.agent_type === selectedAgent
              )}
              // Which agents already carry overrides, without opening each.
              badge={(agent) => {
                const count = overrideCount(value[agent.agent_type])
                return count > 0 ? t("overrideCount", { count }) : null
              }}
              disabled={disabled}
            />
          }
        />
        {options()}
      </SettingCard>
    </div>
  )
}
