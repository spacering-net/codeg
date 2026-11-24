"use client"

/**
 * An agent picked with every option of it — an assistant's brain, or the
 * agent its work runs on — as the identity tab, the first setup and the
 * new-assistant box edit one: the agent, the options it asks for (read
 * from the agent itself), what changed from what is saved, and the config
 * to save. The editor's flow and validation; each place lays it out its own
 * way.
 */

import { useMemo, useRef, useState, type ReactNode } from "react"
import { useTranslations } from "next-intl"

import {
  OptionBlock,
  RequiredOptionRow,
  optionValueLabel,
  type OptionRow,
} from "@/components/settings/agent-options-editor"
import {
  buildAgentConfig,
  effectivePick,
  missingRows,
  rowMark,
  selectionFromOptions,
  EMPTY_SELECTION,
  type AssistantSelection,
} from "@/components/settings/assistant-agent-config"
import {
  RequiredOptionsSection,
  useRequiredOptionsGate,
} from "@/components/settings/required-agent-options"
import { useAcpAgents } from "@/hooks/use-acp-agents"
import { getAgentLabel } from "@/lib/custom-agents"
import type { AgentType, AssistantAgentConfig } from "@/lib/types"

/** What a save takes of it: `config` `null` is "as saved". */
export type AgentConfigToSave =
  | { ok: true; config: AssistantAgentConfig | null }
  | { ok: false; error: string }

export interface AgentConfigEditor {
  agentType: AgentType | null
  pickAgent: (next: AgentType) => void
  /** The agent or an option was changed here. */
  touched: boolean
  /** The saved one, when it is still the agent picked. */
  saved: AssistantAgentConfig | null
  /** Its options under the agent's pick, once an agent is picked. */
  options: ReactNode
  /** "2 options to pick" while some are. */
  missingHint: string | null
  /** Its options want a look: some still to pick (an agent just picked, or
   *  one its agent added), its model to pick again or not switched to, or
   *  one no longer as saved. A place that folds them away shows them. */
  needsLook: boolean
  /** The config to save — focusing the first option still to pick when
   *  one is. */
  toSave: () => AgentConfigToSave
  /** Saved: what is there is what is stored now. */
  settle: () => void
}

export function useAgentConfig({
  saved: stored,
  revision,
  disabled,
  compact = false,
  missingText,
}: {
  /** What is stored; `null` for none yet. */
  saved: AssistantAgentConfig | null
  /** Changes when what is stored does: the marks of what changed follow. */
  revision?: number
  disabled: boolean
  /** The first setup's rows: their names alone, picked at a glance. */
  compact?: boolean
  /** "Your agent has 2 options to pick". */
  missingText: (count: number) => string
}): AgentConfigEditor {
  const tm = useTranslations("AcpAgentSettings.multiAgent")
  const ta = useTranslations("AcpAgentSettings.multiAgent.assistants")
  const { agents } = useAcpAgents()

  const [agentType, setAgentType] = useState<AgentType | null>(
    stored?.agent_type ?? null
  )
  const [selection, setSelection] = useState<AssistantSelection>(
    stored ? selectionFromOptions(stored.agent_options) : EMPTY_SELECTION
  )
  const [touched, setTouched] = useState(false)
  const [pickedLabels, setPickedLabels] = useState<Record<string, string>>({})
  const [invalidIds, setInvalidIds] = useState<ReadonlySet<string>>(new Set())
  const triggerRefs = useRef(new Map<string, HTMLButtonElement | null>())

  const saved: AssistantAgentConfig | null =
    stored && stored.agent_type === agentType ? stored : null
  const agentInfo = agents.find((a) => a.agent_type === agentType) ?? null
  const agentUnavailable =
    saved !== null &&
    !touched &&
    agents.length > 0 &&
    !(agentInfo?.enabled && agentInfo.available)
  const { gate, probe } = useRequiredOptionsGate({
    agentType,
    selection,
    unavailable: agentUnavailable,
  })
  const booleanLabels = { on: tm("booleanOn"), off: tm("booleanOff") }
  const savedMarks = useMemo(
    () =>
      saved
        ? {
            selection: selectionFromOptions(saved.agent_options),
            labels: saved.label_snapshot,
          }
        : null,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [saved?.agent_type, revision]
  )
  const readyRows = gate.kind === "ready" ? gate.rows : null
  const missing = readyRows ? missingRows(readyRows, selection) : []
  const driftCount =
    readyRows && savedMarks && !touched
      ? readyRows.filter((row) =>
          rowMark(row, selection, savedMarks, pickedLabels)
        ).length
      : 0

  const pickValue = (row: OptionRow, value: string) => {
    setTouched(true)
    setInvalidIds((prev) => {
      if (!prev.has(row.id)) return prev
      const next = new Set(prev)
      next.delete(row.id)
      return next
    })
    setPickedLabels((prev) => ({
      ...prev,
      [row.id]: optionValueLabel(row, value, booleanLabels) ?? value,
    }))
    setSelection((prev) =>
      row.kind === "mode"
        ? { ...prev, modeId: value }
        : { ...prev, configValues: { ...prev.configValues, [row.id]: value } }
    )
  }

  const pickAgent = (next: AgentType) => {
    if (next === agentType) return
    setAgentType(next)
    setTouched(true)
    setSelection(EMPTY_SELECTION)
    setPickedLabels({})
    setInvalidIds(new Set())
  }

  const renderRow = (row: OptionRow, rowDisabled = false) => (
    <OptionBlock key={row.id}>
      <RequiredOptionRow
        hideHint={compact}
        row={row}
        value={effectivePick(row, selection)}
        onChange={(value) => pickValue(row, value)}
        disabled={rowDisabled || disabled}
        invalid={invalidIds.has(row.id)}
        mark={rowMark(row, selection, savedMarks, pickedLabels)}
        triggerRef={(el) => {
          triggerRefs.current.set(row.id, el)
        }}
      />
    </OptionBlock>
  )

  const toSave = (): AgentConfigToSave => {
    if (agentType === null) return { ok: false, error: ta("pickAgentFirst") }
    if (gate.kind === "ready") {
      const stillMissing = missingRows(gate.rows, selection)
      // Left as saved: the save keeps it as it is (one that now lacks an
      // option the agent added never stops the rest of the page saving).
      if (stillMissing.length > 0 && saved && !touched) {
        return { ok: true, config: null }
      }
      if (stillMissing.length > 0) {
        setInvalidIds(new Set(stillMissing.map((row) => row.id)))
        triggerRefs.current.get(stillMissing[0].id)?.focus()
        return { ok: false, error: missingText(stillMissing.length) }
      }
      const config = buildAgentConfig({
        agentType,
        agentLabel: getAgentLabel(agentType) ?? agentType,
        rows: gate.rows,
        selection,
        modeLabel: tm("modeLabel"),
        booleanLabels,
      })
      return { ok: true, config: saved && !touched ? null : config }
    }
    if (
      saved &&
      !touched &&
      (gate.kind === "error" ||
        gate.kind === "unavailable-agent" ||
        gate.kind === "not-switched" ||
        // A model to pick now (one added, or the saved one gone): kept as
        // it is, as with a missing option above.
        gate.kind === "pick-model")
    ) {
      return { ok: true, config: null }
    }
    return {
      ok: false,
      error:
        gate.kind === "error"
          ? ta("cannotSaveProbeFailed")
          : gate.kind === "pick-model"
            ? missingText(1)
            : gate.kind === "not-switched"
              ? ta("cannotSaveModelNotSwitched")
              : ta("cannotSaveStillLoading"),
    }
  }

  const options =
    agentType !== null ? (
      <RequiredOptionsSection
        gate={gate}
        loading={probe.loading}
        saved={touched ? null : saved}
        driftCount={driftCount}
        renderRow={renderRow}
        onRetry={() => probe.reload()}
      />
    ) : null

  return {
    agentType,
    pickAgent,
    touched,
    saved,
    options,
    missingHint: missing.length > 0 ? missingText(missing.length) : null,
    needsLook:
      (touched && saved === null) ||
      missing.length > 0 ||
      driftCount > 0 ||
      gate.kind === "pick-model" ||
      gate.kind === "not-switched",
    toSave,
    settle: () => setTouched(false),
  }
}
