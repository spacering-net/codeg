/**
 * Localised names for the vocabulary an agent advertises over ACP.
 *
 * Session modes, session config options and permission options arrive from the
 * agent as already-rendered display strings, and codeg shows them verbatim —
 * which is right, because they are the agent's own concepts and most adapters
 * ship English. `deepseek-acp` does not: it hardcodes Simplified Chinese for
 * every one of them and has no locale mechanism at all (no `LANG`, no setting,
 * nothing), so an English — or Japanese, or German — codeg renders Chinese
 * selectors and Chinese approval buttons.
 *
 * The fix is a lookup keyed on **agent type + the stable id**, never on the
 * text. Upstream's own comments treat those ids as stable (`off` / `high` /
 * `max`, `read-only` / `workspace-write` / `danger-full-access`, …) while the
 * display strings are explicitly "the local vocabulary", so an id is the only
 * thing worth matching. Anything this module does not recognise — another
 * agent, a new option, a tier upstream adds tomorrow — passes through
 * untouched: a missing translation must degrade to the agent's own words, not
 * to a blank or a raw id.
 *
 * Deliberately NOT translated, even though they are Chinese too:
 * - **Model names and descriptions.** They come from the user's own
 *   `~/.dsh/settings.yaml` (`llm-deepseek.models`); rewriting user data would
 *   be worse than leaving it. Only the `model` option's own LABEL is ours.
 * - Slash-command and elicitation prose, which carries no stable key and could
 *   only be matched by its Chinese literal.
 * - The agent's system prompt, which is why the model answers in Chinese. That
 *   is upstream behaviour, not a string codeg renders.
 */

import type {
  AgentType,
  PermissionOptionInfo,
  SessionConfigOptionInfo,
  SessionConfigSelectOptionInfo,
  SessionModeInfo,
} from "@/lib/types"

/** One entry: the message key for the label, and optionally for its blurb. */
interface LabelEntry {
  readonly name: string
  readonly description?: string
}

type EntryKeys<T extends LabelEntry> =
  | T["name"]
  | (T extends { readonly description: infer D } ? D : never)

type TableKeys<T extends Record<string, LabelEntry>> = EntryKeys<T[keyof T]>

const DEEPSEEK_MODES = {
  default: {
    name: "deepseekModeDefault",
    description: "deepseekModeDefaultDescription",
  },
  plan: {
    name: "deepseekModePlan",
    description: "deepseekModePlanDescription",
  },
} as const satisfies Record<string, LabelEntry>

const DEEPSEEK_OPTIONS = {
  model: { name: "deepseekOptionModel" },
  reasoning: {
    name: "deepseekOptionReasoning",
    description: "deepseekOptionReasoningDescription",
  },
  sandbox: {
    name: "deepseekOptionSandbox",
    description: "deepseekOptionSandboxDescription",
  },
} as const satisfies Record<string, LabelEntry>

/**
 * Per-option value vocabularies.
 *
 * `model` is absent on purpose — its values are the user's catalogue (see the
 * module doc), so they fall through the `?? option` path untouched.
 */
const DEEPSEEK_VALUES = {
  reasoning: {
    off: {
      name: "deepseekReasoningOff",
      description: "deepseekReasoningOffDescription",
    },
    low: {
      name: "deepseekReasoningLow",
      description: "deepseekReasoningLowDescription",
    },
    high: {
      name: "deepseekReasoningHigh",
      description: "deepseekReasoningHighDescription",
    },
    max: {
      name: "deepseekReasoningMax",
      description: "deepseekReasoningMaxDescription",
    },
  },
  sandbox: {
    "read-only": {
      name: "deepseekSandboxReadOnly",
      description: "deepseekSandboxReadOnlyDescription",
    },
    "workspace-write": {
      name: "deepseekSandboxWorkspaceWrite",
      description: "deepseekSandboxWorkspaceWriteDescription",
    },
    "danger-full-access": {
      name: "deepseekSandboxFullAccess",
      description: "deepseekSandboxFullAccessDescription",
    },
  },
} as const satisfies Record<string, Record<string, LabelEntry>>

/**
 * Approval buttons. Keyed by option id AND cross-checked against the ACP
 * `kind`: the id alone is the agent's private string, so an upstream that ever
 * reused `reject-once` for an allow would otherwise get a button labelled the
 * opposite of what it does.
 */
const DEEPSEEK_PERMISSION_OPTIONS = {
  "allow-once": { name: "deepseekPermissionAllowOnce", kind: "allow_once" },
  "reject-once": { name: "deepseekPermissionRejectOnce", kind: "reject_once" },
} as const satisfies Record<string, LabelEntry & { readonly kind: string }>

/** Every message key this module can ask for, under the `AgentVocabulary` namespace. */
export type AgentVocabularyKey =
  | TableKeys<typeof DEEPSEEK_MODES>
  | TableKeys<typeof DEEPSEEK_OPTIONS>
  | TableKeys<(typeof DEEPSEEK_VALUES)["reasoning"]>
  | TableKeys<(typeof DEEPSEEK_VALUES)["sandbox"]>
  | TableKeys<typeof DEEPSEEK_PERMISSION_OPTIONS>

/**
 * `useTranslations("AgentVocabulary")` narrowed to what this module uses. A
 * translator accepting the whole namespace is assignable to it, so callers
 * just pass `t`.
 */
export type AgentVocabularyTranslator = (key: AgentVocabularyKey) => string

/** The only agent with a vocabulary to rewrite, today. */
const DEEPSEEK: AgentType = "deepseek"

function isDeepSeek(agentType: AgentType | null | undefined): boolean {
  return agentType === DEEPSEEK
}

function lookup<T>(table: Record<string, T>, id: string): T | undefined {
  // `hasOwnProperty`, not `table[id]`: an option whose id happens to be
  // `constructor` or `toString` would otherwise resolve to something off
  // `Object.prototype` and blow up on `.name`.
  return Object.prototype.hasOwnProperty.call(table, id) ? table[id] : undefined
}

/** Widened once, so the per-option value tables can be looked up by id. */
const DEEPSEEK_VALUE_TABLES: Record<
  string,
  Record<string, LabelEntry>
> = DEEPSEEK_VALUES

/** The entry for one value, under the option that owns it. */
function valueEntry(configId: string, valueId: string): LabelEntry | undefined {
  const table = lookup(DEEPSEEK_VALUE_TABLES, configId)
  return table ? lookup(table, valueId) : undefined
}

/**
 * Apply one entry to a `{name, description}` pair.
 *
 * Returns the SAME object when nothing is rewritten, so a caller's `useMemo`
 * and the store's option-equality checks do not churn on every render.
 */
function relabel<T extends { name: string; description?: string | null }>(
  subject: T,
  entry: LabelEntry | undefined,
  t: AgentVocabularyTranslator
): T {
  if (!entry) return subject
  const name = t(entry.name as AgentVocabularyKey)
  // A description we own REPLACES the agent's, including any platform note it
  // appended — which is why every description below carries its own "may be
  // partial" qualifier rather than dropping the caveat on the floor.
  const description = entry.description
    ? t(entry.description as AgentVocabularyKey)
    : subject.description
  if (name === subject.name && description === subject.description) {
    return subject
  }
  return { ...subject, name, description }
}

/** Map, preserving the original array reference when nothing changed. */
function mapPreservingIdentity<T>(items: T[], map: (item: T) => T): T[] {
  let changed = false
  const next = items.map((item) => {
    const mapped = map(item)
    if (mapped !== item) changed = true
    return mapped
  })
  return changed ? next : items
}

/** Localise the agent's session modes (DeepSeek's `default` / `plan`). */
export function localizeSessionModes(
  agentType: AgentType | null | undefined,
  modes: SessionModeInfo[],
  t: AgentVocabularyTranslator
): SessionModeInfo[] {
  if (!isDeepSeek(agentType)) return modes
  return mapPreservingIdentity(modes, (mode) =>
    relabel(mode, lookup(DEEPSEEK_MODES, mode.id), t)
  )
}

/** The display label for one mode id, for surfaces that render a lone label. */
export function localizeModeLabel(
  agentType: AgentType | null | undefined,
  modeId: string,
  fallback: string,
  t: AgentVocabularyTranslator
): string {
  if (!isDeepSeek(agentType)) return fallback
  const entry = lookup(DEEPSEEK_MODES, modeId)
  return entry ? t(entry.name as AgentVocabularyKey) : fallback
}

function localizeSelectOption(
  configId: string,
  option: SessionConfigSelectOptionInfo,
  t: AgentVocabularyTranslator
): SessionConfigSelectOptionInfo {
  return relabel(option, valueEntry(configId, option.value), t)
}

/** Localise one config option: its own label, and its select values. */
export function localizeConfigOption(
  agentType: AgentType | null | undefined,
  option: SessionConfigOptionInfo,
  t: AgentVocabularyTranslator
): SessionConfigOptionInfo {
  if (!isDeepSeek(agentType)) return option
  const relabelled = relabel(option, lookup(DEEPSEEK_OPTIONS, option.id), t)
  if (relabelled.kind.type !== "select") return relabelled
  const kind = relabelled.kind
  const options = mapPreservingIdentity(kind.options, (item) =>
    localizeSelectOption(option.id, item, t)
  )
  const groups = mapPreservingIdentity(kind.groups, (group) => {
    const groupOptions = mapPreservingIdentity(group.options, (item) =>
      localizeSelectOption(option.id, item, t)
    )
    return groupOptions === group.options
      ? group
      : { ...group, options: groupOptions }
  })
  if (options === kind.options && groups === kind.groups) return relabelled
  return { ...relabelled, kind: { ...kind, options, groups } }
}

export function localizeConfigOptions(
  agentType: AgentType | null | undefined,
  options: SessionConfigOptionInfo[],
  t: AgentVocabularyTranslator
): SessionConfigOptionInfo[] {
  if (!isDeepSeek(agentType)) return options
  return mapPreservingIdentity(options, (option) =>
    localizeConfigOption(agentType, option, t)
  )
}

/**
 * The display label for one config VALUE, for surfaces that hold the ids but
 * not the option object — the persisted automation badges, and the
 * config-rejection toast.
 */
export function localizeConfigValueLabel(
  agentType: AgentType | null | undefined,
  configId: string,
  valueId: string | null | undefined,
  fallback: string,
  t: AgentVocabularyTranslator
): string {
  if (!isDeepSeek(agentType) || !valueId) return fallback
  const entry = valueEntry(configId, valueId)
  return entry ? t(entry.name as AgentVocabularyKey) : fallback
}

/** The display label for one config OPTION id. */
export function localizeConfigOptionLabel(
  agentType: AgentType | null | undefined,
  configId: string,
  fallback: string,
  t: AgentVocabularyTranslator
): string {
  if (!isDeepSeek(agentType)) return fallback
  const entry = lookup(DEEPSEEK_OPTIONS, configId)
  return entry ? t(entry.name as AgentVocabularyKey) : fallback
}

/** Localise the approval buttons of one permission request. */
export function localizePermissionOptions(
  agentType: AgentType | null | undefined,
  options: PermissionOptionInfo[],
  t: AgentVocabularyTranslator
): PermissionOptionInfo[] {
  if (!isDeepSeek(agentType)) return options
  return mapPreservingIdentity(options, (option) => {
    const entry = lookup(DEEPSEEK_PERMISSION_OPTIONS, option.option_id)
    if (!entry || entry.kind !== option.kind) return option
    const name = t(entry.name as AgentVocabularyKey)
    return name === option.name ? option : { ...option, name }
  })
}
