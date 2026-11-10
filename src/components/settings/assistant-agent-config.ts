/**
 * Pure helpers behind the assistant editor's required-options flow: which rows
 * still need a pick, how a saved selection compares to what the agent offers
 * now, and the `agent_config` a save submits.
 */

import {
  MODE_ROW_ID,
  optionValueLabel,
  rowName,
  rowOffers,
  type OptionRow,
  type RequiredRowMark,
} from "@/components/settings/agent-options-editor"
import type {
  AgentDelegationDefaults,
  AgentType,
  AssistantAgentConfig,
  AssistantLabelSnapshot,
} from "@/lib/types"

/** The picks being edited: the mode row's value and one value per option. */
export interface AssistantSelection {
  modeId: string | null
  configValues: Record<string, string>
}

export const EMPTY_SELECTION: AssistantSelection = {
  modeId: null,
  configValues: {},
}

export function selectionFromOptions(
  options: AgentDelegationDefaults | null | undefined
): AssistantSelection {
  return {
    modeId: options?.mode_id ?? null,
    configValues: { ...(options?.config_values ?? {}) },
  }
}

/** The raw pick for a row, offered or not. */
export function rawPick(
  row: OptionRow,
  selection: AssistantSelection
): string | null {
  return row.kind === "mode"
    ? selection.modeId
    : (selection.configValues[row.id] ?? null)
}

/** The pick a row counts as having: its raw pick if the row still offers it,
 *  otherwise none — a value the agent withdrew is not a choice any more. */
export function effectivePick(
  row: OptionRow,
  selection: AssistantSelection
): string | null {
  const value = rawPick(row, selection)
  return value !== null && rowOffers(row, value) ? value : null
}

/** Whether a row needs a pick at all: a select the agent lists no values for
 *  cannot take one, so it is neither required nor stored. */
export function rowIsRequired(row: OptionRow): boolean {
  return !(row.kind === "select" && row.empty)
}

/** The rows still unpicked, in display order. */
export function missingRows(
  rows: readonly OptionRow[],
  selection: AssistantSelection
): OptionRow[] {
  return rows.filter(
    (row) => rowIsRequired(row) && effectivePick(row, selection) === null
  )
}

/** Where a row stands against the selection as it was SAVED (edit only):
 *  its saved value no longer offered, or the row new since the save. */
export function rowMark(
  row: OptionRow,
  selection: AssistantSelection,
  saved: {
    selection: AssistantSelection
    labels: AssistantLabelSnapshot
  } | null,
  /** Display names of picks made this session, by row id. */
  pickedLabels: Readonly<Record<string, string>>
): RequiredRowMark | null {
  const raw = rawPick(row, selection)
  if (raw !== null && !rowOffers(row, raw)) {
    const savedLabel =
      pickedLabels[row.id] ??
      (row.kind === "mode"
        ? saved?.labels.mode
        : saved?.labels.options.find((o) => o.id === row.id)?.value_label) ??
      raw
    return { kind: "unavailable", savedLabel }
  }
  if (!saved || raw !== null || !rowIsRequired(row)) return null
  const known =
    row.kind === "mode"
      ? saved.selection.modeId !== null
      : saved.labels.options.some((o) => o.id === row.id)
  return known ? null : { kind: "new" }
}

/**
 * The `agent_config` a save submits: the selection rebuilt against the rows
 * the agent offers now — anything else (an option it no longer lists, a value
 * it withdrew) is dropped — and the option list with the names the editor
 * showed, so the settings list reads without probing and the backend can
 * check the selection is complete. Callers only build it once nothing is
 * missing.
 */
export function buildAgentConfig(args: {
  agentType: AgentType
  agentLabel: string
  rows: readonly OptionRow[]
  selection: AssistantSelection
  modeLabel: string
  booleanLabels: { on: string; off: string }
}): AssistantAgentConfig {
  const { agentType, agentLabel, rows, selection, modeLabel, booleanLabels } =
    args
  let mode_id: string | null = null
  let mode: string | null = null
  const config_values: Record<string, string> = {}
  const options: AssistantLabelSnapshot["options"] = []
  for (const row of rows) {
    if (!rowIsRequired(row)) continue
    const value = effectivePick(row, selection)
    if (value === null) continue
    const valueLabel = optionValueLabel(row, value, booleanLabels) ?? value
    if (row.kind === "mode") {
      mode_id = value
      mode = valueLabel
      continue
    }
    config_values[row.id] = value
    options.push({
      id: row.id,
      kind: row.kind === "boolean" ? "boolean" : "select",
      name: rowName(row, modeLabel),
      value_label: valueLabel,
    })
  }
  return {
    agent_type: agentType,
    agent_options: { mode_id, config_values },
    label_snapshot: { agent: agentLabel, mode, options },
  }
}

/** Whether two configs select the same agent and values (names aside). */
export function sameAgentSelection(
  a: { agent_type: AgentType; agent_options: AgentDelegationDefaults },
  b: { agent_type: AgentType; agent_options: AgentDelegationDefaults }
): boolean {
  if (a.agent_type !== b.agent_type) return false
  if ((a.agent_options.mode_id ?? null) !== (b.agent_options.mode_id ?? null))
    return false
  const av = a.agent_options.config_values ?? {}
  const bv = b.agent_options.config_values ?? {}
  const keys = new Set([...Object.keys(av), ...Object.keys(bv)])
  for (const key of keys) {
    if (av[key] !== bv[key]) return false
  }
  return true
}

/** The mode row's id, re-exported for row keys and focus bookkeeping. */
export { MODE_ROW_ID }
