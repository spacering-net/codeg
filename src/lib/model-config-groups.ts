import type {
  SessionConfigOptionInfo,
  SessionConfigSelectOptionInfo,
} from "@/lib/types"

// A visual group of model options for the composer's model selector. `name`
// being `null` renders the options with no header — used for the leading
// "floating" bucket of values that carry no `provider/` prefix. A non-null
// name is a provider header (e.g. "OpenCode Zen", "anthropic").
export interface ModelOptionGroup {
  key: string
  name: string | null
  options: SessionConfigSelectOptionInfo[]
}

// The id every agent codeg ships publishes its model selector under. ACP
// reserves none, so this is a convention rather than a guarantee — the backend
// pairs it with the `model` category for the same reason
// (`connection.rs::is_model_config_option`).
export const MODEL_CONFIG_OPTION_ID = "model"

// Only the model picker groups by `/` prefix — never the mode picker or any
// other agent config option. The backend ships the model option with
// `id === "model"` and no category; Codex's approval-preset option uses
// `category === "mode"`. Match on either signal so a future relabel stays safe.
export function isModelConfigOption(option: SessionConfigOptionInfo): boolean {
  return option.id === MODEL_CONFIG_OPTION_ID || option.category === "model"
}

// The namespace before the FIRST "/", or `null` when there is no usable prefix
// (no slash, a leading slash, or a trailing slash with an empty suffix). Values
// like `openrouter/anthropic/claude` group under their first segment.
function prefixOf(value: string): string | null {
  const idx = value.indexOf("/")
  if (idx <= 0) return null
  if (idx >= value.length - 1) return null
  return value.slice(0, idx)
}

// Split a display name on its first "/", trimming both sides. Returns null when
// there's no clean split (no slash, or an empty head/tail).
function splitNamePrefix(name: string): { head: string; tail: string } | null {
  const idx = name.indexOf("/")
  if (idx < 0) return null
  const head = name.slice(0, idx).trim()
  const tail = name.slice(idx + 1).trim()
  if (!head || !tail) return null
  return { head, tail }
}

// The leading display-name segment shared by EVERY option in a group (e.g.
// "OpenCode Zen" for names like "OpenCode Zen/Big Pickle"), or null when they
// don't all repeat the same one. This is what's redundant to show on every row.
function sharedNamePrefix(
  items: SessionConfigSelectOptionInfo[]
): string | null {
  let shared: string | null = null
  for (const item of items) {
    const split = splitNamePrefix(item.name)
    if (!split) return null
    if (shared === null) shared = split.head
    else if (shared !== split.head) return null
  }
  return shared
}

// The shared display-name prefix worth stripping from a group's rows, or null to
// leave the rows untouched. A group of 2+ rows that all repeat the same leading
// segment is clearly redundant. A single-row group is only stripped when its
// name's leading segment IS the value-id prefix (a genuine `provider/model` like
// `anthropic/claude-opus`) — a lone slashed display name like `GPT-4o/preview`
// must not be mistaken for a provider prefix.
function strippablePrefix(
  valuePrefix: string,
  items: SessionConfigSelectOptionInfo[]
): string | null {
  const shared = sharedNamePrefix(items)
  if (shared === null) return null
  if (items.length < 2 && shared !== valuePrefix) return null
  return shared
}

// Build one group: when its rows share a strippable prefix, that prefix becomes
// the header and is removed from every row; otherwise the header is the value-id
// prefix and the labels are left as-is.
function buildGroup(
  valuePrefix: string,
  items: SessionConfigSelectOptionInfo[]
): ModelOptionGroup {
  const shared = strippablePrefix(valuePrefix, items)
  if (shared === null) {
    return { key: valuePrefix, name: valuePrefix, options: items }
  }
  return {
    key: valuePrefix,
    name: shared,
    options: items.map((opt) => ({
      ...opt,
      name: splitNamePrefix(opt.name)!.tail,
    })),
  }
}

// Derive `provider/` prefix groups for the model selector's flat value list.
//
// Returns `null` (meaning "render the list as-is, ungrouped") when:
//   - the option is not the model picker,
//   - it is not a select,
//   - the agent already shipped server-side groups (respected verbatim), or
//   - grouping/stripping would add nothing: no value carries a "/", or there is
//     a single provider with nothing floating AND no repeated display prefix to
//     strip (a single provider whose rows DO repeat a prefix is still grouped so
//     that prefix can be stripped — see the lone-provider branch below).
//
// Group MEMBERSHIP is by the VALUE's first-"/" segment (the stable model id, so
// odd display names never fracture a group). The HEADER and the per-row labels
// come from the DISPLAY NAME: when every row in a group repeats the same leading
// `Provider/` (e.g. values `opencode/…` but names `OpenCode Zen/…`), that shared
// segment becomes the header and is stripped from each row so it isn't shown
// twice. When the names don't share a clean segment there's nothing redundant —
// the header falls back to the value-id prefix and labels are left untouched.
// Values are never rewritten; only display labels change.
export function deriveModelGroups(
  option: SessionConfigOptionInfo
): ModelOptionGroup[] | null {
  if (!isModelConfigOption(option)) return null
  if (option.kind.type !== "select") return null
  const kind = option.kind
  if (kind.groups.length > 0) return null

  const prefixes = kind.options.map((opt) => prefixOf(opt.value))
  if (!prefixes.some((prefix) => prefix !== null)) return null

  const floating: SessionConfigSelectOptionInfo[] = []
  const order: string[] = []
  const byPrefix = new Map<string, SessionConfigSelectOptionInfo[]>()

  kind.options.forEach((opt, index) => {
    const prefix = prefixes[index]
    if (prefix === null) {
      floating.push(opt)
      return
    }
    let bucket = byPrefix.get(prefix)
    if (!bucket) {
      bucket = []
      byPrefix.set(prefix, bucket)
      order.push(prefix)
    }
    bucket.push(opt)
  })

  // A single provider with nothing floating beside it is only worth surfacing
  // when its rows share a redundant display prefix to strip (e.g. every row is
  // "OpenCode Zen/…"); a lone header over an already-clean list is just noise,
  // so fall back to the flat list.
  if (order.length === 1 && floating.length === 0) {
    const prefix = order[0]
    const items = byPrefix.get(prefix)!
    if (strippablePrefix(prefix, items) === null) return null
    return [buildGroup(prefix, items)]
  }

  const groups: ModelOptionGroup[] = []
  if (floating.length > 0) {
    groups.push({ key: "__ungrouped__", name: null, options: floating })
  }
  for (const prefix of order) {
    groups.push(buildGroup(prefix, byPrefix.get(prefix)!))
  }
  return groups
}

// Above this many model options the picker switches to the searchable +
// virtualized list (a Radix menu / plain list of hundreds of rows is what janks
// scrolling). Short lists (Claude's handful) keep the lightweight rendering.
export const MODEL_LIST_VIRTUALIZE_THRESHOLD = 24

// The grouped list to render in the searchable model picker: derived `provider/`
// groups when applicable, else the agent's server-provided groups (preserved
// verbatim), else a single headerless group for a flat list. Keeps the wide and
// collapsed pickers consistent for every shape (incl. server-grouped lists).
export function modelListGroups(
  option: SessionConfigOptionInfo
): ModelOptionGroup[] {
  if (option.kind.type !== "select") return []
  const kind = option.kind
  const derived = deriveModelGroups(option)
  if (derived) return derived
  if (kind.groups.length > 0) {
    return kind.groups.map((group) => ({
      key: group.group,
      name: group.name,
      options: group.options,
    }))
  }
  return [{ key: "__all__", name: null, options: kind.options }]
}

// Filter a group list by a search query, matching each option's display name OR
// its value id (case-insensitive substring). Groups left with no matching option
// are dropped. An empty/whitespace query returns the groups unchanged.
export function filterModelGroups(
  groups: ModelOptionGroup[],
  query: string
): ModelOptionGroup[] {
  const q = query.trim().toLowerCase()
  if (!q) return groups
  const result: ModelOptionGroup[] = []
  for (const group of groups) {
    const options = group.options.filter(
      (opt) =>
        opt.name.toLowerCase().includes(q) ||
        opt.value.toLowerCase().includes(q)
    )
    if (options.length > 0) result.push({ ...group, options })
  }
  return result
}

// A single rendered row in the flattened model list: either a group header
// (non-null group name) or a selectable option. Headers carry no value; options
// carry their full option plus the owning group key (for stable React keys).
export type ModelOptionRow =
  | { kind: "header"; key: string; name: string }
  | {
      kind: "option"
      key: string
      groupKey: string
      option: SessionConfigSelectOptionInfo
    }

// Flatten groups into a single row list for a (virtualized) list view: a header
// row per named group (headerless/floating buckets contribute no header row),
// followed by one option row per option. Stable keys are namespaced by group so
// the same value under two groups never collides.
export function flattenModelGroups(
  groups: ModelOptionGroup[]
): ModelOptionRow[] {
  const rows: ModelOptionRow[] = []
  for (const group of groups) {
    if (group.name !== null) {
      rows.push({
        kind: "header",
        key: `header:${group.key}`,
        name: group.name,
      })
    }
    for (const option of group.options) {
      rows.push({
        kind: "option",
        key: `option:${group.key}:${option.value}`,
        groupKey: group.key,
        option,
      })
    }
  }
  return rows
}
