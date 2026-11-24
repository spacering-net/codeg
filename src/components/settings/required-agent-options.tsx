"use client"

/**
 * An agent with EVERY option it advertises picked explicitly, nothing
 * preselected — the assistant editor's flow, shared with the other settings
 * that save such a selection (the commit message generator's agent).
 *
 * The options come from a live probe of the agent (`useAgentOptions`). Agents
 * that list one option's values per model (opencode's `effort`) make the order
 * matter: the model is picked first, the agent is re-probed FOR it, and only
 * when that snapshot has landed — and the probe confirms the agent really
 * switched (`unapplied_config_ids` without `model`) — are the other rows
 * offered. Picking them off any other snapshot would save values that do not
 * hold for the saved model.
 */

import { useEffect, useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { AlertCircle, AlertTriangle, Loader2, RotateCw } from "lucide-react"

import {
  useAgentOptions,
  type AgentOptionsState,
} from "@/components/automations/use-agent-options"
import { Button } from "@/components/ui/button"
import { useAgentVocabulary } from "@/hooks/use-agent-vocabulary"
import type {
  AgentOptionsSnapshot,
  AgentType,
  AssistantAgentConfig,
} from "@/lib/types"
import {
  buildOptionRows,
  findModelRow,
  OptionBlock,
  StatusLine,
  type OptionRow,
} from "./agent-options-editor"
import {
  effectivePick,
  type AssistantSelection,
} from "./assistant-agent-config"

/**
 * Where the options part of an editor stands. Everything but `ready` means
 * the selection cannot be completed (and so not saved) yet.
 */
export type OptionsGate =
  | { kind: "no-agent" }
  /** The saved agent is disabled or not installed: show the saved names. */
  | { kind: "unavailable-agent" }
  | { kind: "loading"; modelRow: OptionRow | null }
  | { kind: "error"; message: string; modelRow: OptionRow | null }
  /** The agent has a model selector and no model the agent offers is picked. */
  | { kind: "pick-model"; modelRow: OptionRow }
  /** A model is picked; waiting for the snapshot probed for it. */
  | { kind: "confirming"; modelRow: OptionRow }
  /** The probe for the picked model came back holding another model. */
  | { kind: "not-switched"; modelRow: OptionRow }
  | { kind: "ready"; rows: OptionRow[] }

/** A saved selection whose names stand in when the options cannot be read. */
export type SavedAgentSelection = Pick<
  AssistantAgentConfig,
  "agent_options" | "label_snapshot"
>

/**
 * Probe `agentType` — for the picked model, once there is one — and work out
 * which of its rows can be offered yet ({@link OptionsGate}).
 */
export function useRequiredOptionsGate({
  agentType,
  selection,
  unavailable,
}: {
  /** `null` while no agent is picked: nothing is probed. */
  agentType: AgentType | null
  selection: AssistantSelection
  /** The saved agent cannot run here (disabled or not installed): it is not
   *  probed, and the saved names stand in for its options. */
  unavailable: boolean
}): { gate: OptionsGate; probe: AgentOptionsState } {
  const pickedModel = selection.configValues.model ?? null
  const probeConfig = useMemo(
    () => (pickedModel ? { model: pickedModel } : null),
    [pickedModel]
  )
  const probe = useAgentOptions(
    agentType ?? "claude_code",
    null,
    agentType !== null && !unavailable,
    probeConfig
  )
  const vocabulary = useAgentVocabulary(agentType)

  // The latest model row seen for this agent. Which models an agent offers
  // does not depend on the model picked, so while the agent is re-probed for a
  // newly picked model the row stays usable — `useAgentOptions` clears its
  // snapshot at the start of every probe, hence the copy. Another agent's
  // options start from scratch.
  const [modelRowCache, setModelRowCache] = useState<{
    agent: AgentType
    row: OptionRow
  } | null>(null)
  const agentSnapshot: AgentOptionsSnapshot | null =
    probe.snapshot && probe.snapshotAgentType === agentType
      ? probe.snapshot
      : null
  const agentSnapshotRows = useMemo(
    () => (agentSnapshot ? buildOptionRows(agentSnapshot, vocabulary) : null),
    [agentSnapshot, vocabulary]
  )
  const freshModelRow = agentSnapshotRows
    ? findModelRow(agentSnapshotRows)
    : null
  useEffect(() => {
    // A copy kept across the probe's resets (see above), not derived state.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setModelRowCache((prev) =>
      freshModelRow && agentType
        ? { agent: agentType, row: freshModelRow }
        : prev && prev.agent === agentType
          ? prev
          : null
    )
  }, [freshModelRow, agentType])
  const modelRow =
    freshModelRow ??
    (modelRowCache && modelRowCache.agent === agentType
      ? modelRowCache.row
      : null)

  // Rows of the snapshot probed for EXACTLY the current (agent, model).
  const currentRows = probe.current ? agentSnapshotRows : null
  const currentSnapshot = probe.current ? agentSnapshot : null

  // A snapshot without `unapplied_config_ids` can only come from a backend
  // that predates the field — say one left in the 30s cache across a server
  // upgrade — so it confirms nothing. Probe again once, bypassing the cache;
  // the latch is keyed by (agent, model) and outlives the snapshot being
  // cleared by that very probe, so this never loops.
  const [reprobed, setReprobed] = useState<ReadonlySet<string>>(new Set())
  const confirmKey =
    agentType && pickedModel ? JSON.stringify([agentType, pickedModel]) : null
  const pickedModelOffered =
    modelRow !== null && effectivePick(modelRow, selection) !== null

  const gate: OptionsGate = useMemo(() => {
    if (agentType === null) return { kind: "no-agent" }
    if (unavailable) return { kind: "unavailable-agent" }
    if (probe.error && !probe.loading) {
      return { kind: "error", message: probe.error, modelRow }
    }
    if (currentRows && currentSnapshot) {
      const currentModelRow = findModelRow(currentRows)
      if (
        !currentModelRow ||
        (currentModelRow.kind === "select" && currentModelRow.empty)
      ) {
        return { kind: "ready", rows: currentRows }
      }
      if (effectivePick(currentModelRow, selection) === null) {
        return { kind: "pick-model", modelRow: currentModelRow }
      }
      const unapplied = currentSnapshot.unapplied_config_ids
      if (unapplied === undefined) {
        return confirmKey && reprobed.has(confirmKey)
          ? { kind: "not-switched", modelRow: currentModelRow }
          : { kind: "confirming", modelRow: currentModelRow }
      }
      if (unapplied.includes("model")) {
        return { kind: "not-switched", modelRow: currentModelRow }
      }
      return { kind: "ready", rows: currentRows }
    }
    if (!modelRow) return { kind: "loading", modelRow: null }
    if (!pickedModelOffered) return { kind: "pick-model", modelRow }
    return { kind: "confirming", modelRow }
  }, [
    agentType,
    unavailable,
    probe.error,
    probe.loading,
    currentRows,
    currentSnapshot,
    modelRow,
    pickedModelOffered,
    selection,
    confirmKey,
    reprobed,
  ])

  // The forced re-probe for an unconfirmed snapshot (see `reprobed`).
  const needsReprobe =
    currentSnapshot !== null &&
    currentSnapshot.unapplied_config_ids === undefined &&
    pickedModelOffered &&
    confirmKey !== null &&
    !reprobed.has(confirmKey)
  const { reload } = probe
  useEffect(() => {
    if (!needsReprobe || !confirmKey) return
    // State, not a ref: the gate reads the latch while rendering.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setReprobed((prev) => new Set(prev).add(confirmKey))
    reload()
  }, [needsReprobe, confirmKey, reload])

  return { gate, probe }
}

/** The agent's options, as rows of the agent's card — or the line saying why
 *  they are not there yet. */
export function RequiredOptionsSection({
  gate,
  loading,
  saved,
  driftCount,
  renderRow,
  onRetry,
}: {
  gate: OptionsGate
  loading: boolean
  /** The saved selection while the agent and its options are untouched:
   *  whose names stand in when the options cannot be read. */
  saved: SavedAgentSelection | null
  driftCount: number
  renderRow: (row: OptionRow, disabled?: boolean) => React.ReactNode
  onRetry: () => void
}) {
  const t = useTranslations("AcpAgentSettings.multiAgent.assistants")
  const tm = useTranslations("AcpAgentSettings.multiAgent")
  const probing = (
    <OptionBlock>
      <StatusLine
        tone="muted"
        icon={<Loader2 className="size-3.5 animate-spin" aria-hidden />}
      >
        {tm("probing")}
      </StatusLine>
    </OptionBlock>
  )
  const retry = (disabled: boolean) => (
    <Button
      type="button"
      size="xs"
      variant="outline"
      className="bg-background"
      onClick={onRetry}
      disabled={disabled}
    >
      <RotateCw aria-hidden />
      {tm("retry")}
    </Button>
  )
  switch (gate.kind) {
    case "no-agent":
      // The agent row says to pick one; there is nothing to show under it.
      return null
    case "unavailable-agent":
      return (
        <>
          <OptionBlock>
            <StatusLine
              tone="warning"
              icon={<AlertTriangle className="size-3.5" aria-hidden />}
            >
              {t("agentUnavailableHint")}
            </StatusLine>
          </OptionBlock>
          <SavedOptionLabels saved={saved} />
        </>
      )
    case "loading":
      return probing
    case "error":
      return (
        <>
          {gate.modelRow ? renderRow(gate.modelRow) : null}
          <OptionBlock>
            <StatusLine
              tone="error"
              icon={<AlertCircle className="size-3.5" aria-hidden />}
              action={retry(false)}
            >
              {tm("probeFailed", { detail: gate.message })}
            </StatusLine>
          </OptionBlock>
          <SavedOptionLabels saved={saved} />
        </>
      )
    case "pick-model":
      return (
        <>
          {renderRow(gate.modelRow)}
          <OptionBlock>
            <StatusLine tone="muted">{t("pickModelFirst")}</StatusLine>
          </OptionBlock>
        </>
      )
    case "confirming":
      return (
        <>
          {renderRow(gate.modelRow)}
          {probing}
        </>
      )
    case "not-switched":
      return (
        <>
          {renderRow(gate.modelRow)}
          <OptionBlock>
            <StatusLine
              tone="warning"
              icon={<AlertTriangle className="size-3.5" aria-hidden />}
              action={retry(loading)}
            >
              {t("modelNotSwitched")}
            </StatusLine>
          </OptionBlock>
          <SavedOptionLabels saved={saved} />
        </>
      )
    case "ready":
      if (gate.rows.length === 0) {
        return (
          <OptionBlock>
            <StatusLine tone="muted">{tm("noConfigAvailable")}</StatusLine>
          </OptionBlock>
        )
      }
      return (
        <>
          {driftCount > 0 ? (
            <OptionBlock>
              <StatusLine
                tone="warning"
                icon={<AlertTriangle className="size-3.5" aria-hidden />}
              >
                {t("optionsChanged", { count: driftCount })}
              </StatusLine>
            </OptionBlock>
          ) : null}
          {gate.rows.map((row) => renderRow(row))}
        </>
      )
  }
}

/** The saved selection's names, read-only — shown when the options cannot be
 *  read (the agent is unavailable, the probe failed, or the agent would not
 *  switch to the saved model). A switch is named in the current locale from
 *  its stored value; the snapshot holds the label of the locale it was saved
 *  in. */
function SavedOptionLabels({ saved }: { saved: SavedAgentSelection | null }) {
  const t = useTranslations("AcpAgentSettings.multiAgent.assistants")
  const tm = useTranslations("AcpAgentSettings.multiAgent")
  if (!saved) return null
  const { label_snapshot: labels } = saved
  const switchLabel = (id: string, fallback: string) => {
    const stored = saved.agent_options.config_values?.[id]
    return stored === "true"
      ? tm("booleanOn")
      : stored === "false"
        ? tm("booleanOff")
        : fallback
  }
  const items = [
    ...(labels.mode ? [{ name: tm("modeLabel"), value: labels.mode }] : []),
    ...labels.options.map((o) => ({
      name: o.name,
      value:
        o.kind === "boolean" ? switchLabel(o.id, o.value_label) : o.value_label,
    })),
  ]
  if (items.length === 0) {
    return (
      <OptionBlock>
        <StatusLine tone="muted">{t("savedNoOptions")}</StatusLine>
      </OptionBlock>
    )
  }
  return (
    <OptionBlock>
      <p className="mb-2 text-xs font-medium text-muted-foreground">
        {t("savedOptions")}
      </p>
      <dl className="space-y-1.5">
        {items.map((item, idx) => (
          <div key={idx} className="flex justify-between gap-3 text-xs">
            <dt className="text-muted-foreground">{item.name}</dt>
            <dd className="truncate font-medium">{item.value}</dd>
          </div>
        ))}
      </dl>
    </OptionBlock>
  )
}
