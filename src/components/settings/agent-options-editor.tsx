"use client"

/**
 * Editing an agent's probed options (`describeAgentOptions`), in the two ways
 * settings need it:
 *
 *   * `override` — the delegation "Agent defaults" tab. Every row may stay on
 *     "Default (X)", which stores nothing and leaves the agent's own value.
 *   * `required` — the assistant editor. Every row must be picked explicitly:
 *     no default item, nothing preselected, a placeholder until chosen.
 *
 * Both share the row model ({@link buildOptionRows}), the grouped model list
 * (`modelListGroups`), the agent's localised vocabulary, the row layout and
 * the parts around the rows — the agent picker, the status lines — so the two
 * surfaces cannot drift apart in what they offer or in how they read.
 */

import { useMemo } from "react"
import { useTranslations } from "next-intl"

import { AgentIcon } from "@/components/agent-icon"
import { Badge } from "@/components/ui/badge"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { useAgentVocabulary } from "@/hooks/use-agent-vocabulary"
import { getAgentLabel } from "@/lib/custom-agents"
import {
  deriveModelGroups,
  isModelConfigOption,
  MODEL_CONFIG_OPTION_ID,
  modelListGroups,
  type ModelOptionGroup,
} from "@/lib/model-config-groups"
import type {
  AcpAgentInfo,
  AgentOptionsSnapshot,
  AgentType,
  SessionConfigKindInfo,
  SessionConfigOptionInfo,
} from "@/lib/types"
import { cn } from "@/lib/utils"

/** Row id of the standalone mode row (never a real config option id). */
export const MODE_ROW_ID = "__codeg_mode__"

// The top "Default" item of an override row. Picking it clears the override.
// Must not collide with any real option id an agent could emit.
const DEFAULT_SENTINEL = "__codeg_default__"

/** One width for every control of an options card — the agent picker's too —
 *  so the controls form a single column down the card's trailing edge. */
export const OPTION_CONTROL_CLASS = "w-40 shrink-0 bg-background sm:w-56"

type SelectOption = SessionConfigOptionInfo & {
  kind: Extract<SessionConfigKindInfo, { type: "select" }>
}
type BooleanOption = SessionConfigOptionInfo & {
  kind: Extract<SessionConfigKindInfo, { type: "boolean" }>
}

type SelectRow = {
  kind: "select"
  id: string
  option: SelectOption
  groups: ModelOptionGroup[]
  /** Advertised with no values at all: shown, but nothing can be picked
   *  (and nothing is required or stored for it). */
  empty: boolean
}

export type OptionRow =
  | {
      kind: "mode"
      id: typeof MODE_ROW_ID
      modes: Array<{ id: string; name: string; description?: string | null }>
      /** The agent's own current mode. */
      currentId: string
    }
  | SelectRow
  | {
      kind: "boolean"
      id: string
      option: BooleanOption
    }

type Vocabulary = ReturnType<typeof useAgentVocabulary>

/**
 * The model selector among `rows`, if any: the row the others can hang off
 * (opencode lists `effort` per model). The `model` id wins over the `model`
 * category, as in `model-label-store` — qoder hung its effort selector off
 * that category through 1.1.66.
 */
export function findModelRow(rows: readonly OptionRow[]): OptionRow | null {
  const selects = rows.filter((row): row is SelectRow => row.kind === "select")
  return (
    selects.find((row) => row.id === MODEL_CONFIG_OPTION_ID) ??
    selects.find((row) => isModelConfigOption(row.option)) ??
    null
  )
}

/**
 * The rows a snapshot is edited through, in display order: the model first,
 * then the rest in the agent's own order. The model decides what the other
 * rows offer, so it is the one picked first — and the rows that appear once
 * it is picked then land below it, instead of pushing it down under the
 * pointer.
 *
 * The standalone mode row only appears when the agent advertises modes and NO
 * config options — the chat composer's rule (`message-input.tsx`): agents that
 * have both expose the mode as one of the config options, and a second "Mode"
 * row would duplicate it.
 */
export function buildOptionRows(
  snapshot: AgentOptionsSnapshot,
  vocabulary: Vocabulary
): OptionRow[] {
  const modes = snapshot.modes?.available_modes ?? []
  const hasOptions = snapshot.config_options.length > 0
  const rows: OptionRow[] = []
  if (modes.length > 0 && !hasOptions && snapshot.modes) {
    rows.push({
      kind: "mode",
      id: MODE_ROW_ID,
      modes: vocabulary.modes(modes),
      currentId: snapshot.modes.current_mode_id,
    })
  }
  for (const raw of snapshot.config_options) {
    const option = vocabulary.configOption(raw)
    if (option.kind.type === "boolean") {
      rows.push({
        kind: "boolean",
        id: option.id,
        option: option as BooleanOption,
      })
      continue
    }
    const groups = modelListGroups(option)
    rows.push({
      kind: "select",
      id: option.id,
      option: option as SelectOption,
      groups,
      empty: groups.every((g) => g.options.length === 0),
    })
  }
  const model = findModelRow(rows)
  return model ? [model, ...rows.filter((row) => row !== model)] : rows
}

/** {@link buildOptionRows} for a component, localised for `agentType`. */
export function useOptionRows(
  agentType: AgentType | null,
  snapshot: AgentOptionsSnapshot | null
): OptionRow[] | null {
  const vocabulary = useAgentVocabulary(agentType)
  return useMemo(
    () => (snapshot ? buildOptionRows(snapshot, vocabulary) : null),
    [snapshot, vocabulary]
  )
}

/** The name a row's value is shown with: the rendered (group-stripped) name a
 *  select row's list shows, a mode's name, a switch's on/off label. `null`
 *  when the row offers no such value. */
export function optionValueLabel(
  row: OptionRow,
  value: string,
  booleanLabels: { on: string; off: string }
): string | null {
  switch (row.kind) {
    case "mode":
      return row.modes.find((m) => m.id === value)?.name ?? null
    case "boolean":
      if (value === "true") return booleanLabels.on
      if (value === "false") return booleanLabels.off
      return null
    case "select":
      for (const group of row.groups) {
        const hit = group.options.find((o) => o.value === value)
        if (hit) return hit.name
      }
      return null
  }
}

/** Whether `value` is one the row currently offers. */
export function rowOffers(row: OptionRow, value: string): boolean {
  switch (row.kind) {
    case "mode":
      return row.modes.some((m) => m.id === value)
    case "boolean":
      return value === "true" || value === "false"
    case "select":
      return row.groups.some((g) => g.options.some((o) => o.value === value))
  }
}

/** The display name of a row itself ("Model", "Mode", …). */
export function rowName(row: OptionRow, modeLabel: string): string {
  return row.kind === "mode" ? modeLabel : row.option.name
}

/**
 * The agent's own default as the override row's hint names it. It keeps the
 * option's unstripped name, which already carries the provider when the agent
 * writes names as `Provider/model`. A bare name that another option also uses
 * (two providers both listing `glm-5` under `provider/glm-5` ids) is qualified
 * with the provider header its row is grouped under. A value the agent does
 * not list reads as itself.
 *
 * The backend ships the flat `options` for grouped selects too, so this lookup
 * covers both shapes.
 */
function agentDefaultHintLabel(
  option: SessionConfigOptionInfo,
  value: string
): string {
  if (option.kind.type !== "select") return value
  const options = option.kind.options
  const own = options.find((o) => o.value === value)
  if (!own) return value
  const sharedName = options.some(
    (o) => o.value !== value && o.name === own.name
  )
  if (!sharedName) return own.name
  for (const group of deriveModelGroups(option) ?? []) {
    const row = group.options.find((o) => o.value === value)
    if (!row) continue
    // A stripped row's own name already starts with its header.
    return group.name !== null && row.name === own.name
      ? `${group.name}/${own.name}`
      : own.name
  }
  return own.name
}

/** The items of a select row's list, grouped as the composer groups models. */
function SelectRowItems({
  groups,
  recommended,
  recommendedLabel,
}: {
  groups: ModelOptionGroup[]
  recommended?: string | null
  recommendedLabel?: string
}) {
  return (
    <>
      {groups.map((group) =>
        group.name === null ? (
          group.options.map((item) => (
            <SelectItem
              key={`${group.key}-${item.value}`}
              value={item.value}
              badge={item.value === recommended ? recommendedLabel : null}
            >
              {item.name}
            </SelectItem>
          ))
        ) : (
          <SelectGroup key={group.key}>
            <SelectLabel>{group.name}</SelectLabel>
            {group.options.map((item) => (
              <SelectItem
                key={`${group.key}-${item.value}`}
                value={item.value}
                badge={item.value === recommended ? recommendedLabel : null}
              >
                {item.name}
              </SelectItem>
            ))}
          </SelectGroup>
        )
      )}
    </>
  )
}

/** The chip shape every mark on a row shares, so the marks read as one
 *  family; colour alone says which. */
const MARK_CLASS = "h-4 px-1.5 text-[0.625rem]"

/** "Unavailable (was X)": a value saved before that the agent no longer
 *  offers. */
function UnavailableMark({ label }: { label: string }) {
  const ta = useTranslations("AcpAgentSettings.multiAgent.assistants")
  return (
    <Badge
      variant="outline"
      className={cn(
        MARK_CLASS,
        "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400"
      )}
    >
      {ta("optionUnavailable", { value: label })}
    </Badge>
  )
}

function RowShell({
  label,
  hint,
  badges,
  children,
}: {
  label: string
  hint?: string | null
  badges?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    // `SettingRow`'s rule: with a hint under the label the control aligns to
    // the label's line; without one the two centre on each other, instead of
    // the label hanging off the taller control's top edge.
    <div
      className={cn(
        "flex justify-between gap-3",
        hint ? "items-start" : "items-center"
      )}
    >
      {/* The label and hint are often the agent's own words (English option
          names and descriptions in an Arabic window): an isolated inline run
          keeps their punctuation in place without pulling the line away from
          the row's start. */}
      <div className="min-w-0 space-y-0.5">
        <div className="flex flex-wrap items-center gap-1.5">
          <label className="text-sm font-medium">
            <span dir="auto">{label}</span>
          </label>
          {badges}
        </div>
        {hint ? (
          <p className="text-xs text-muted-foreground">
            <span dir="auto">{hint}</span>
          </p>
        ) : null}
      </div>
      {children}
    </div>
  )
}

export interface OverrideOptionRowProps {
  row: OptionRow
  /** The override, or `null` to leave the agent's own value. */
  value: string | null
  onChange: (value: string | null) => void
  disabled?: boolean
}

/**
 * One row of the `override` variant: "Default (X)" first — the agent's own
 * value, stored as nothing — then every value the agent lists. A switch is the
 * same tri-state: Default, On, Off (an explicit Off is stored as `"false"`, a
 * real override).
 *
 * With no override the trigger shows the Default item, so "inheriting" reads
 * apart from "picked the agent's current default explicitly" — the latter
 * sticks to that literal value even if the agent later changes its own. The
 * Default item is drawn muted, so the rows that do override stand out.
 */
export function OverrideOptionRow({
  row,
  value,
  onChange,
  disabled,
}: OverrideOptionRowProps) {
  const t = useTranslations("AcpAgentSettings.multiAgent")
  const booleanLabels = { on: t("booleanOn"), off: t("booleanOff") }
  const label = rowName(row, t("modeLabel"))

  // The agent's own value, as the hint names it and as the Default item
  // does. For a select the two can differ: the hint names the default with
  // the provider in it — no group header stands beside the hint to supply it
  // — while the Default item and the trigger resolve against the RENDERED
  // rows (`modelListGroups` groups `provider/model` ids under their provider
  // and strips the prefix: two providers can offer the same model id), so a
  // selected model shows its prefix-stripped name exactly as the composer
  // does.
  let hintDefault: string
  let itemDefault: string
  switch (row.kind) {
    case "mode":
      hintDefault = itemDefault =
        row.modes.find((m) => m.id === row.currentId)?.name ?? row.currentId
      break
    case "boolean":
      hintDefault = itemDefault = row.option.kind.current_value
        ? booleanLabels.on
        : booleanLabels.off
      break
    case "select": {
      const agentDefault = row.option.kind.current_value
      hintDefault = agentDefaultHintLabel(row.option, agentDefault)
      itemDefault =
        row.groups
          .flatMap((group) => group.options)
          .find((o) => o.value === agentDefault)?.name ?? hintDefault
      break
    }
  }
  // An override saved for a value the agent no longer lists: the trigger
  // still says what is stored (the list has no item to name it), and the mark
  // says it is gone.
  const withdrawn = value !== null && !rowOffers(row, value)

  return (
    <RowShell
      label={label}
      hint={t("agentDefaultHint", { value: hintDefault })}
      badges={withdrawn ? <UnavailableMark label={value} /> : null}
    >
      <Select
        value={value ?? DEFAULT_SENTINEL}
        onValueChange={(v) => onChange(v === DEFAULT_SENTINEL ? null : v)}
        disabled={disabled}
      >
        <SelectTrigger
          size="sm"
          className={OPTION_CONTROL_CLASS}
          aria-label={label}
        >
          <SelectValue>{withdrawn ? value : undefined}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={DEFAULT_SENTINEL}>
            <span className="text-muted-foreground">
              {t("defaultOptionLabel", { value: itemDefault })}
            </span>
          </SelectItem>
          {row.kind === "mode"
            ? row.modes.map((mode) => (
                <SelectItem key={mode.id} value={mode.id}>
                  {mode.name}
                </SelectItem>
              ))
            : null}
          {row.kind === "boolean" ? (
            <>
              <SelectItem value="true">{booleanLabels.on}</SelectItem>
              <SelectItem value="false">{booleanLabels.off}</SelectItem>
            </>
          ) : null}
          {row.kind === "select" ? (
            <SelectRowItems groups={row.groups} />
          ) : null}
        </SelectContent>
      </Select>
    </RowShell>
  )
}

/** How a required row's saved value relates to what the agent offers now. */
export type RequiredRowMark =
  /** Saved before, no longer offered: shown as "unavailable (was X)". */
  | { kind: "unavailable"; savedLabel: string }
  /** Appeared since the selection was saved. */
  | { kind: "new" }

export interface RequiredOptionRowProps {
  row: OptionRow
  /** The picked value, or `null` for none yet. */
  value: string | null
  onChange: (value: string) => void
  disabled?: boolean
  /** Flagged by a save attempt with this row still unpicked. */
  invalid?: boolean
  mark?: RequiredRowMark | null
  /** Focus target for "jump to the first missing row". */
  triggerRef?: (el: HTMLButtonElement | null) => void
}

/**
 * One row of the `required` variant: no default item and nothing preselected
 * (neither the agent's current value nor its recommendation — the agent's
 * recommended value only gets a "Recommended" chip). Until a value is picked
 * the trigger shows a placeholder and the row carries a "Required" mark.
 */
export function RequiredOptionRow({
  row,
  value,
  onChange,
  disabled,
  invalid,
  mark,
  triggerRef,
}: RequiredOptionRowProps) {
  const t = useTranslations("AcpAgentSettings.multiAgent")
  const ta = useTranslations("AcpAgentSettings.multiAgent.assistants")
  const booleanLabels = { on: t("booleanOn"), off: t("booleanOff") }
  const label = rowName(row, t("modeLabel"))
  const description =
    row.kind === "mode"
      ? row.modes.find((m) => m.id === value)?.description
      : row.option.description
  const unpicked = value === null
  const empty = row.kind === "select" && row.empty

  const badges = (
    <>
      {mark?.kind === "new" ? (
        <Badge variant="secondary" className={MARK_CLASS}>
          {ta("optionNew")}
        </Badge>
      ) : null}
      {mark?.kind === "unavailable" ? (
        <UnavailableMark label={mark.savedLabel} />
      ) : null}
      {unpicked && !empty && !mark ? (
        <Badge
          variant="outline"
          className={cn(
            MARK_CLASS,
            invalid
              ? "border-destructive/40 bg-destructive/10 text-destructive"
              : "border-border/70 bg-transparent font-normal text-muted-foreground"
          )}
        >
          {ta("required")}
        </Badge>
      ) : null}
    </>
  )

  return (
    <RowShell label={label} hint={description} badges={badges}>
      <Select
        value={value ?? ""}
        onValueChange={onChange}
        disabled={disabled || empty}
      >
        <SelectTrigger
          ref={triggerRef}
          size="sm"
          className={OPTION_CONTROL_CLASS}
          aria-label={label}
          aria-invalid={invalid ? true : undefined}
        >
          <SelectValue
            placeholder={
              empty ? ta("noValuesOffered") : ta("selectPlaceholder")
            }
          />
        </SelectTrigger>
        <SelectContent>
          {row.kind === "mode"
            ? row.modes.map((mode) => (
                <SelectItem
                  key={mode.id}
                  value={mode.id}
                  description={mode.description}
                >
                  {mode.name}
                </SelectItem>
              ))
            : null}
          {row.kind === "boolean" ? (
            <>
              <SelectItem value="true">{booleanLabels.on}</SelectItem>
              <SelectItem value="false">{booleanLabels.off}</SelectItem>
            </>
          ) : null}
          {row.kind === "select" ? (
            <SelectRowItems
              groups={row.groups}
              recommended={row.option.recommended_value}
              recommendedLabel={ta("recommended")}
            />
          ) : null}
        </SelectContent>
      </Select>
    </RowShell>
  )
}

/** An agent's mark in a list or on a trigger — decorative: the label next to
 *  it names the agent (the marks carry an SVG title of their own). */
export function AgentGlyph({ agentType }: { agentType: AgentType }) {
  return (
    <span aria-hidden className="flex shrink-0">
      <AgentIcon agentType={agentType} className="size-4" />
    </span>
  )
}

export interface AgentSelectProps {
  value: AgentType | null
  onChange: (agent: AgentType) => void
  /** The agents to offer, in order. One that is not installed or is
   *  disabled is listed with the reason, and cannot be picked. */
  agents: readonly AcpAgentInfo[]
  /** What the trigger calls `value` when `agents` does not hold it — an
   *  agent no longer registered, named as it was saved. */
  fallbackLabel?: string | null
  /** A chip after an agent's name in the open list. */
  badge?: (agent: AcpAgentInfo) => string | null
  disabled?: boolean
}

/** The agent picker heading an options card: each agent with its mark, the
 *  trigger as wide as the option controls below it. */
export function AgentSelect({
  value,
  onChange,
  agents,
  fallbackLabel,
  badge,
  disabled,
}: AgentSelectProps) {
  const t = useTranslations("AcpAgentSettings.multiAgent.assistants")
  const listed = value !== null && agents.some((a) => a.agent_type === value)
  return (
    <Select
      value={value ?? ""}
      onValueChange={(v) => onChange(v as AgentType)}
      disabled={disabled}
    >
      <SelectTrigger
        size="sm"
        className={OPTION_CONTROL_CLASS}
        aria-label={t("agentLabel")}
      >
        <SelectValue placeholder={t("agentPlaceholder")}>
          {value ? (
            <>
              <AgentGlyph agentType={value} />
              <span className="truncate">
                {listed
                  ? getAgentLabel(value)
                  : (fallbackLabel ?? getAgentLabel(value))}
              </span>
            </>
          ) : undefined}
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        {agents.map((agent) => {
          const label = getAgentLabel(agent.agent_type)
          const problem = !agent.available
            ? t("agentNotInstalled")
            : !agent.enabled
              ? t("agentDisabled")
              : null
          return (
            <SelectItem
              key={agent.agent_type}
              value={agent.agent_type}
              disabled={problem !== null}
              textValue={label}
              badge={badge?.(agent) ?? null}
            >
              {/* One flex line of its own: with a badge beside it the item
                  text is no longer the item's flex row. */}
              <span className="flex items-center gap-2">
                <AgentGlyph agentType={agent.agent_type} />
                {label}
                {problem ? (
                  <span className="text-muted-foreground">{` (${problem})`}</span>
                ) : null}
              </span>
            </SelectItem>
          )
        })}
      </SelectContent>
    </Select>
  )
}

/** One row of an options card under the agent row — an option, or a line of
 *  status — padded like the `SettingRow`s around it, so every title in the
 *  card starts at the same edge. */
export function OptionBlock({ children }: { children: React.ReactNode }) {
  return <div className="p-3">{children}</div>
}

/** A line of status in an options card — what is happening, what went
 *  wrong — with the way to act on it at the end. */
export function StatusLine({
  tone,
  icon,
  action,
  children,
}: {
  tone: "muted" | "warning" | "error"
  icon?: React.ReactNode
  action?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <div className="flex items-start justify-between gap-3">
      <p
        className={cn(
          "flex min-w-0 items-start gap-1.5 text-xs leading-5",
          tone === "error"
            ? "text-destructive"
            : tone === "warning"
              ? "text-amber-700 dark:text-amber-400"
              : "text-muted-foreground"
        )}
      >
        {icon ? (
          <span className="flex h-5 shrink-0 items-center">{icon}</span>
        ) : null}
        <span className="min-w-0 break-words">{children}</span>
      </p>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  )
}
