/**
 * Pure model for the OpenCode 2 config keys that decide how a session BEHAVES,
 * as opposed to which provider/model it talks to (`opencode-connect.ts`) or
 * what it is allowed to do (`opencode-permissions.ts`).
 *
 * Every field is OpenCode 2's own (`packages/schema/src/config.ts` and
 * `config/*.ts`):
 *
 *   "default_agent": "build"              // primary agent a new session opens in
 *   "update": "auto" | "notify" | "disable"  // the TUI's self-updater
 *   "snapshots": true                     // snapshots behind undo/revert
 *   "compaction": { "auto": true, "keep": { "tokens": 15000 }, "buffer": 20000 | "20%" }
 *   "tool_output": { "max_lines": 2000, "max_bytes": 51200 }
 *   "experimental": { "todo": false, "background_compaction": false,
 *                     "subagent_depth": 1 }
 *
 * OpenCode 2 still loads 1.x's spellings of some of these
 * (`core/src/config/normalize.ts`): `autoupdate` → `update`, `snapshot` →
 * `snapshots`, `compaction.preserve_recent_tokens` → `compaction.keep.tokens`,
 * `compaction.reserved` → `compaction.buffer`, with the 2.x key winning when
 * both are set. Those are read as fallbacks, and writing a field removes its
 * 1.x spelling so the file says one thing. Others it drops with a warning —
 * a top-level `subagent_depth`, `compaction.tail_turns`, `compaction.prune` —
 * and `share` it accepts but no longer acts on; the view lists the ones a
 * document still carries.
 *
 * Every write goes through `patchJsoncText`, so the user's comments and
 * formatting survive. A control set back to its unset state DELETES the key
 * rather than writing OpenCode's default, so the document keeps following
 * OpenCode when its default changes.
 */

import { parseJsoncObject, patchJsoncText, type JsonObject } from "./jsonc-edit"

/** `update`: what the TUI's updater does. `opencode acp` never updates itself. */
export type OpenCodeUpdateMode = "auto" | "notify" | "disable"
export const OPENCODE_UPDATE_MODES: readonly OpenCodeUpdateMode[] = [
  "auto",
  "notify",
  "disable",
] as const

/** Numeric behavior fields, addressed by a flat id the UI can map over. */
export type OpenCodeNumberField =
  | "experimental.subagent_depth"
  | "compaction.keep.tokens"
  | "compaction.buffer"
  | "tool_output.max_lines"
  | "tool_output.max_bytes"

/** Boolean behavior fields, same addressing. */
export type OpenCodeToggleField =
  | "snapshots"
  | "compaction.auto"
  | "experimental.todo"
  | "experimental.background_compaction"

/**
 * A numeric field's value: an integer, or for a field that takes one
 * (`percent`), a share of the model's window such as "20%".
 */
export type OpenCodeNumberValue = number | string

export interface OpenCodeNumberFieldMeta {
  field: OpenCodeNumberField
  /** What OpenCode does when the key is unset, for the input placeholder. */
  placeholder: string
  /** Schema floor: `PositiveInt` fields reject 0, `NonNegativeInt` accept it. */
  min: 0 | 1
  /** Also takes a share of the window (`OPENCODE_WINDOW_SHARE`). */
  percent?: true
}

/**
 * OpenCode 2.2.5's `Config.Compaction.Percent`
 * (`packages/schema/src/config/compaction.ts`): "1%" up to, but not
 * including, "100%", decimals allowed ("12.5%"). OpenCode 2.2.0 accepted only
 * the integer and drops a share with a warning, keeping the rest of the file.
 */
const OPENCODE_WINDOW_SHARE = /^([1-9]\d?(\.\d+)?)%$/

export const OPENCODE_NUMBER_FIELDS: readonly OpenCodeNumberFieldMeta[] = [
  // NonNegativeInt; 0 means "sub-agents may not launch anything". Default 1.
  { field: "experimental.subagent_depth", placeholder: "1", min: 0 },
  // NonNegativeInt; default 15000 (`session/compaction.ts`).
  { field: "compaction.keep.tokens", placeholder: "15000", min: 0 },
  // Percent or NonNegativeInt; unset keeps 15% of the window free, at least
  // 16000 tokens (`RESERVE_SHARE`, `RESERVE_MIN` in `session/compaction.ts`).
  { field: "compaction.buffer", placeholder: "—", min: 0, percent: true },
  // Both PositiveInt, with the defaults documented in the schema.
  { field: "tool_output.max_lines", placeholder: "2000", min: 1 },
  { field: "tool_output.max_bytes", placeholder: "51200", min: 1 },
] as const

/** OpenCode's own default for each switch, which "unset" means. */
export const OPENCODE_TOGGLE_DEFAULTS: Readonly<
  Record<OpenCodeToggleField, boolean>
> = {
  snapshots: true,
  "compaction.auto": true,
  "experimental.todo": false,
  "experimental.background_compaction": false,
}

const PATHS: Record<OpenCodeNumberField | OpenCodeToggleField, string[]> = {
  "experimental.subagent_depth": ["experimental", "subagent_depth"],
  "compaction.keep.tokens": ["compaction", "keep", "tokens"],
  "compaction.buffer": ["compaction", "buffer"],
  "tool_output.max_lines": ["tool_output", "max_lines"],
  "tool_output.max_bytes": ["tool_output", "max_bytes"],
  snapshots: ["snapshots"],
  "compaction.auto": ["compaction", "auto"],
  "experimental.todo": ["experimental", "todo"],
  "experimental.background_compaction": [
    "experimental",
    "background_compaction",
  ],
}

/** The 1.x spelling OpenCode 2 still reads for a field, removed on write. */
const LEGACY_PATHS: Partial<
  Record<OpenCodeNumberField | OpenCodeToggleField, string[]>
> = {
  snapshots: ["snapshot"],
  "compaction.keep.tokens": ["compaction", "preserve_recent_tokens"],
  "compaction.buffer": ["compaction", "reserved"],
}

/** 1.x keys a field's write also removes although OpenCode 2 ignores them:
 *  setting the 2.x key is the user saying what they want instead. */
const DROPPED_ON_WRITE: Partial<
  Record<OpenCodeNumberField | OpenCodeToggleField, string[][]>
> = {
  "experimental.subagent_depth": [["subagent_depth"]],
}

/** 1.x keys OpenCode 2 drops (or, for `share`, accepts and ignores). */
const IGNORED_LEGACY_KEYS: string[][] = [
  ["subagent_depth"],
  ["compaction", "tail_turns"],
  ["compaction", "prune"],
  ["share"],
  ["autoshare"],
]

export interface OpenCodeBehaviorView {
  /** `default_agent`, or "" when unset. */
  defaultAgent: string
  update: OpenCodeUpdateMode | null
  toggles: Record<OpenCodeToggleField, boolean | null>
  /** A string only for a `percent` field, and only one OpenCode accepts. */
  numbers: Record<OpenCodeNumberField, OpenCodeNumberValue | null>
  /** 1.x keys the document carries that OpenCode 2 does not act on. */
  ignoredLegacyKeys: string[]
  /** True when the document could not be parsed, so nothing here is authoritative. */
  invalid: boolean
}

function asRecord(value: unknown): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : null
}

function readPath(config: JsonObject, path: string[]): unknown {
  let node: unknown = config
  for (const key of path) {
    const record = asRecord(node)
    if (!record || !Object.prototype.hasOwnProperty.call(record, key))
      return undefined
    node = record[key]
  }
  return node
}

function hasPath(config: JsonObject, path: string[]): boolean {
  return readPath(config, path) !== undefined
}

/** Delete the leaf, then every ancestor the delete left empty. */
function deletePath(config: JsonObject, path: string[]): void {
  const chain: JsonObject[] = [config]
  for (const key of path.slice(0, -1)) {
    const next = asRecord(chain[chain.length - 1][key])
    if (!next) return
    chain.push(next)
  }
  delete chain[chain.length - 1][path[path.length - 1]]
  for (let depth = chain.length - 1; depth > 0; depth--) {
    if (Object.keys(chain[depth]).length > 0) break
    delete chain[depth - 1][path[depth - 1]]
  }
}

function writePath(config: JsonObject, path: string[], value: unknown): void {
  let node = config
  for (const key of path.slice(0, -1)) {
    const next = asRecord(node[key]) ?? {}
    node[key] = next
    node = next
  }
  node[path[path.length - 1]] = value
}

function readLegacyUpdate(raw: unknown): OpenCodeUpdateMode | null {
  if (raw === true) return "auto"
  if (raw === false) return "disable"
  if (raw === "notify") return "notify"
  return null
}

function readUpdate(config: JsonObject): OpenCodeUpdateMode | null {
  const native = config.update
  if (native === "auto" || native === "notify" || native === "disable")
    return native
  return readLegacyUpdate(config.autoupdate)
}

/**
 * Read every behavior field out of the document. An unparsable document reports
 * `invalid` with all fields unset, so the UI can lock itself rather than
 * pretend the config says nothing.
 */
export function readOpenCodeBehavior(configText: string): OpenCodeBehaviorView {
  const config = parseJsoncObject(configText).value
  const toggles = Object.fromEntries(
    Object.keys(OPENCODE_TOGGLE_DEFAULTS).map((field) => [field, null])
  ) as Record<OpenCodeToggleField, boolean | null>
  const numbers = Object.fromEntries(
    OPENCODE_NUMBER_FIELDS.map((meta) => [meta.field, null])
  ) as Record<OpenCodeNumberField, OpenCodeNumberValue | null>

  if (!config) {
    return {
      defaultAgent: "",
      update: null,
      toggles,
      numbers,
      ignoredLegacyKeys: [],
      invalid: true,
    }
  }

  const read = (field: OpenCodeNumberField | OpenCodeToggleField) => {
    const native = readPath(config, PATHS[field])
    if (native !== undefined) return native
    const legacy = LEGACY_PATHS[field]
    return legacy ? readPath(config, legacy) : undefined
  }
  for (const field of Object.keys(toggles) as OpenCodeToggleField[]) {
    const raw = read(field)
    if (typeof raw === "boolean") toggles[field] = raw
  }
  for (const meta of OPENCODE_NUMBER_FIELDS) {
    const raw = read(meta.field)
    if (typeof raw === "number" && Number.isFinite(raw)) {
      numbers[meta.field] = raw
    } else if (isWindowShare(meta, raw)) {
      numbers[meta.field] = raw
    }
  }

  const defaultAgent = config.default_agent
  return {
    defaultAgent: typeof defaultAgent === "string" ? defaultAgent : "",
    update: readUpdate(config),
    toggles,
    numbers,
    ignoredLegacyKeys: IGNORED_LEGACY_KEYS.filter((path) =>
      hasPath(config, path)
    ).map((path) => path.join(".")),
    invalid: false,
  }
}

/** Apply `edit`, or hand the text back unchanged when it does not parse (the
 *  section locks itself then, so this only guards against a race). */
function patch(configText: string, edit: (config: JsonObject) => void): string {
  try {
    return patchJsoncText(configText, edit)
  } catch {
    return configText
  }
}

/** `default_agent`; an empty/whitespace name unsets the key. */
export function setOpenCodeDefaultAgent(
  configText: string,
  agent: string
): string {
  return patch(configText, (config) => {
    const trimmed = agent.trim()
    if (trimmed) config.default_agent = trimmed
    else delete config.default_agent
  })
}

export function setOpenCodeUpdate(
  configText: string,
  mode: OpenCodeUpdateMode | null
): string {
  return patch(configText, (config) => {
    delete config.autoupdate
    if (mode) config.update = mode
    else delete config.update
  })
}

function clearField(
  config: JsonObject,
  field: OpenCodeNumberField | OpenCodeToggleField
): void {
  deletePath(config, PATHS[field])
  const legacy = LEGACY_PATHS[field]
  if (legacy) deletePath(config, legacy)
  for (const path of DROPPED_ON_WRITE[field] ?? []) deletePath(config, path)
}

export function setOpenCodeToggle(
  configText: string,
  field: OpenCodeToggleField,
  value: boolean | null
): string {
  return patch(configText, (config) => {
    clearField(config, field)
    if (value !== null) writePath(config, PATHS[field], value)
  })
}

function numberFieldMeta(
  field: OpenCodeNumberField
): OpenCodeNumberFieldMeta | undefined {
  return OPENCODE_NUMBER_FIELDS.find((item) => item.field === field)
}

function isWindowShare(
  meta: OpenCodeNumberFieldMeta | undefined,
  value: unknown
): value is string {
  return (
    meta?.percent === true &&
    typeof value === "string" &&
    OPENCODE_WINDOW_SHARE.test(value)
  )
}

/**
 * What a numeric field's input text says: `null` when it is empty (unset
 * the key), the value it spells, or `undefined` while it spells none yet ("1e",
 * "-", "12.5" on the way to "12.5%"), which should be neither written nor
 * shown as an error. Whether the value is in range is `setOpenCodeNumber`'s
 * call.
 */
export function parseOpenCodeNumberInput(
  field: OpenCodeNumberField,
  raw: string
): OpenCodeNumberValue | null | undefined {
  const trimmed = raw.trim()
  if (trimmed === "") return null
  if (trimmed.endsWith("%")) {
    return isWindowShare(numberFieldMeta(field), trimmed) ? trimmed : undefined
  }
  const parsed = Number(trimmed)
  return Number.isInteger(parsed) ? parsed : undefined
}

/**
 * Numeric fields. `null` (an emptied input) unsets the key; a value below the
 * field's schema floor, one that is not a finite integer, or a share of the
 * window for a field that takes none or in a form OpenCode rejects, leaves
 * the document untouched — writing it would produce config OpenCode
 * rejects.
 */
export function setOpenCodeNumber(
  configText: string,
  field: OpenCodeNumberField,
  value: OpenCodeNumberValue | null
): string {
  if (value !== null) {
    const meta = numberFieldMeta(field)
    if (!meta) return configText
    if (typeof value === "string") {
      if (!isWindowShare(meta, value)) return configText
    } else if (!Number.isInteger(value) || value < meta.min) {
      return configText
    }
  }
  return patch(configText, (config) => {
    clearField(config, field)
    if (value !== null) writePath(config, PATHS[field], value)
  })
}

/** Remove the 1.x keys OpenCode 2 does not act on. */
export function removeIgnoredLegacyKeys(configText: string): string {
  return patch(configText, (config) => {
    for (const path of IGNORED_LEGACY_KEYS) deletePath(config, path)
  })
}
