import {
  isModelConfigOption,
  MODEL_CONFIG_OPTION_ID,
  modelListGroups,
  type ModelOptionGroup,
} from "@/lib/model-config-groups"
import type { SessionConfigOptionInfo, SessionModeInfo } from "@/lib/types"

// The composer's agent settings — the session's config options, or the legacy
// mode list for an agent that publishes no config options — normalized into the
// one ordered list the merged trigger summarizes and its popover edits. Pure:
// commits are the caller's (see `SessionSettingTarget`).

/** A list with more options than this gets a search box (the virtualized
 *  `ModelOptionList`); a shorter one is plain buttons. */
export const SESSION_SETTING_SEARCH_THRESHOLD = 8

/** A select with at most this many options is a segmented control, unless it
 *  is the model picker, which is always a list. */
export const SESSION_SETTING_SEGMENTED_MAX = 8

/** Where a picked value goes: a config option by id, or the legacy mode. */
export type SessionSettingTarget =
  | { type: "config"; configId: string }
  | { type: "mode" }

interface SessionSettingBase {
  /** Stable React key, unique across the list. */
  key: string
  target: SessionSettingTarget
  title: string
  description: string | null
  /**
   * What this setting adds to the trigger's merged label, or `null` for
   * nothing. A switch shows its title only while on; a value whose id is
   * `default` shows nothing (it is the baseline, and says nothing out of
   * context) — except on the model picker, whose value is always shown.
   */
  summary: string | null
}

/** A select, rendered as a list (`list`) or a segmented control. */
export interface SessionChoiceSetting extends SessionSettingBase {
  kind: "list" | "segmented"
  /** The model picker (`id: "model"`), whose search box says "models". */
  isModel: boolean
  currentValue: string
  /** The current value's display name — prefix-stripped when the model list
   *  is grouped by provider — or the raw value when it names no option. */
  currentLabel: string
  currentDescription: string | null
  /** Always at least one group; a flat list is one headerless group. */
  groups: ModelOptionGroup[]
  /** The agent's recommendation. It may name no option, in which case nothing
   *  is marked (renderers match it against the options). */
  recommendedValue: string | null
  /** `list` only: past {@link SESSION_SETTING_SEARCH_THRESHOLD} options. */
  searchable: boolean
}

/** An on/off setting: a boolean config option, or a two-value on/off select. */
export interface SessionSwitchSetting extends SessionSettingBase {
  kind: "switch"
  checked: boolean
  /** The values to send for on and off, verbatim from the agent (`"true"` /
   *  `"false"` for a boolean option — the backend encodes them). */
  onValue: string
  offValue: string
}

export type SessionSetting = SessionChoiceSetting | SessionSwitchSetting

const ON_OFF_PAIRS = [
  ["on", "off"],
  ["true", "false"],
] as const

// A two-option select whose values are on/off (Claude's and Codex's "Fast
// mode": codeg does not advertise boolean config options, so both send it as
// a select), read as a switch. Only while the current value is one of the two:
// Kiro reports `default` for a thinking state it has not been told yet, and a
// switch would claim "off" for it — that select stays a segmented control until
// a value is set.
function onOffValues(
  option: SessionConfigOptionInfo
): { onValue: string; offValue: string } | null {
  if (option.kind.type !== "select") return null
  const { options, current_value } = option.kind
  if (options.length !== 2) return null
  for (const [on, off] of ON_OFF_PAIRS) {
    const onOption = options.find((o) => o.value.toLowerCase() === on)
    const offOption = options.find((o) => o.value.toLowerCase() === off)
    if (!onOption || !offOption) continue
    if (current_value !== onOption.value && current_value !== offOption.value)
      return null
    return { onValue: onOption.value, offValue: offOption.value }
  }
  return null
}

function isDefaultValue(value: string): boolean {
  return value.toLowerCase() === "default"
}

// Model first, then effort, then mode, then everything else in the agent's own
// order, then the switches — the trigger reads like "Opus 5.5 / High / Plan".
function rankOf(
  setting: SessionSetting,
  option: SessionConfigOptionInfo | null
): number {
  if (setting.kind === "switch") return 4
  if (option && isModelConfigOption(option)) return 0
  const category = option ? option.category : "mode"
  if (category === "thought_level") return 1
  if (category === "mode") return 2
  return 3
}

function configOptionSetting(
  option: SessionConfigOptionInfo
): SessionSetting | null {
  const base = {
    key: `config:${option.id}`,
    target: { type: "config", configId: option.id } as const,
    title: option.name,
    description: option.description ?? null,
  }
  if (option.kind.type === "boolean") {
    const checked = option.kind.current_value
    return {
      ...base,
      kind: "switch",
      checked,
      onValue: "true",
      offValue: "false",
      summary: checked ? option.name : null,
    }
  }
  if (option.kind.type !== "select") return null
  const onOff = onOffValues(option)
  if (onOff) {
    const checked = option.kind.current_value === onOff.onValue
    return {
      ...base,
      kind: "switch",
      checked,
      ...onOff,
      summary: checked ? option.name : null,
    }
  }
  const currentValue = option.kind.current_value
  // Derived `provider/` groups for the model, else the agent's own groups, else
  // one flat group — the rendered names are what every surface shows.
  const groups = modelListGroups(option)
  const current = groups
    .flatMap((group) => group.options)
    .find((item) => item.value === currentValue)
  const currentLabel = current?.name ?? currentValue
  const optionCount = option.kind.options.length
  const isModel = option.id === MODEL_CONFIG_OPTION_ID
  const isList = isModel || optionCount > SESSION_SETTING_SEGMENTED_MAX
  return {
    ...base,
    kind: isList ? "list" : "segmented",
    isModel,
    currentValue,
    currentLabel,
    currentDescription: current?.description ?? null,
    groups,
    recommendedValue: option.recommended_value ?? null,
    searchable: isList && optionCount > SESSION_SETTING_SEARCH_THRESHOLD,
    summary:
      isModelConfigOption(option) || !isDefaultValue(currentValue)
        ? currentLabel
        : null,
  }
}

function legacyModeSetting(
  modes: SessionModeInfo[],
  currentModeId: string,
  title: string
): SessionChoiceSetting {
  const options = modes.map((mode) => ({
    value: mode.id,
    name: mode.name,
    description: mode.description ?? null,
  }))
  const current = options.find((item) => item.value === currentModeId)
  const currentLabel = current?.name ?? currentModeId
  const isList = options.length > SESSION_SETTING_SEGMENTED_MAX
  return {
    key: "mode",
    target: { type: "mode" },
    title,
    description: null,
    kind: isList ? "list" : "segmented",
    isModel: false,
    currentValue: currentModeId,
    currentLabel,
    currentDescription: current?.description ?? null,
    groups: [{ key: "__modes__", name: null, options }],
    recommendedValue: null,
    searchable: isList && options.length > SESSION_SETTING_SEARCH_THRESHOLD,
    summary: isDefaultValue(currentModeId) ? null : currentLabel,
  }
}

export interface BuildSessionSettingsInput {
  configOptions: SessionConfigOptionInfo[]
  /** The legacy mode list — pass it only when it is the agent's selector
   *  (no config options), with the mode it is on. */
  modes: SessionModeInfo[]
  currentModeId: string | null
  /** Localized title for the legacy mode setting. */
  modeTitle: string
}

export function buildSessionSettings({
  configOptions,
  modes,
  currentModeId,
  modeTitle,
}: BuildSessionSettingsInput): SessionSetting[] {
  const ranked: { setting: SessionSetting; rank: number; index: number }[] = []
  configOptions.forEach((option, index) => {
    const setting = configOptionSetting(option)
    if (setting) ranked.push({ setting, rank: rankOf(setting, option), index })
  })
  if (modes.length > 0 && currentModeId) {
    const setting = legacyModeSetting(modes, currentModeId, modeTitle)
    ranked.push({ setting, rank: rankOf(setting, null), index: ranked.length })
  }
  const settings = ranked
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map((entry) => entry.setting)
  // When every value was left out (Gemini, with only its `default` mode), the
  // trigger would be a bare icon that says nothing — show the first value.
  if (!settings.some((setting) => setting.summary)) {
    const index = settings.findIndex((setting) => setting.kind !== "switch")
    const first = settings[index]
    if (first && first.kind !== "switch") {
      settings[index] = { ...first, summary: first.currentLabel }
    }
  }
  return settings
}
