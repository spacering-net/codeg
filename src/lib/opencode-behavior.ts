/**
 * Pure model for the OpenCode config keys that decide how a session BEHAVES,
 * as opposed to which provider/model it talks to (`opencode-connect.ts`) or
 * what it is allowed to do (`opencode-permissions.ts`).
 *
 * Every field here is declared in the official schema
 * (`https://opencode.ai/config.json`, generated from
 * `packages/core/src/v1/config/config.ts`) and previously reachable only by
 * hand-editing the raw JSON box:
 *
 *   "default_agent": "build"       // which primary agent a new session opens in
 *   "share": "manual"              // manual | auto | disabled
 *   "autoupdate": true | false | "notify"
 *   "snapshot": true               // filesystem snapshots behind undo/revert
 *   "subagent_depth": 1            // how deep sub-agents may nest
 *   "compaction": { "auto": true, "prune": false, "tail_turns": 4,
 *                   "preserve_recent_tokens": 20000, "reserved": 10000 }
 *   "tool_output": { "max_lines": 2000, "max_bytes": 51200 }
 *
 * Like the permissions model, every function is pure: it parses the given JSON
 * text, mutates a clone and returns new JSON text, leaving unrelated keys
 * untouched. Invalid JSON is returned unchanged — the raw-JSON editor owns that
 * error.
 *
 * ## Deleting vs. writing a default
 *
 * "Not configured" and "configured to the default" are different documents, and
 * only the first keeps following OpenCode when it changes its own default. So a
 * control set back to its unset state DELETES the key (and prunes the parent
 * object once it goes empty) rather than writing the default value.
 */

export type OpenCodeShareMode = "manual" | "auto" | "disabled"
export const OPENCODE_SHARE_MODES: readonly OpenCodeShareMode[] = [
  "manual",
  "auto",
  "disabled",
] as const

/**
 * `autoupdate` is a union of boolean and the string `"notify"`, so the selector
 * carries all three as strings and the writer maps them back.
 */
export type OpenCodeAutoUpdate = "on" | "notify" | "off"
export const OPENCODE_AUTOUPDATE_MODES: readonly OpenCodeAutoUpdate[] = [
  "on",
  "notify",
  "off",
] as const

/** Numeric behavior fields, addressed by a flat id the UI can map over. */
export type OpenCodeNumberField =
  | "subagent_depth"
  | "compaction.tail_turns"
  | "compaction.preserve_recent_tokens"
  | "compaction.reserved"
  | "tool_output.max_lines"
  | "tool_output.max_bytes"

/** Boolean behavior fields, same addressing. */
export type OpenCodeToggleField =
  | "snapshot"
  | "compaction.auto"
  | "compaction.prune"

export interface OpenCodeNumberFieldMeta {
  field: OpenCodeNumberField
  /** What OpenCode does when the key is unset, for the input placeholder. */
  placeholder: string
  /** Schema floor: `PositiveInt` fields reject 0, `NonNegativeInt` accept it. */
  min: 0 | 1
}

export const OPENCODE_NUMBER_FIELDS: readonly OpenCodeNumberFieldMeta[] = [
  // NonNegativeInt in the schema; 0 means "sub-agents may not launch anything".
  { field: "subagent_depth", placeholder: "1", min: 0 },
  // NonNegativeInt; unset means retention is bounded only by the token budget.
  { field: "compaction.tail_turns", placeholder: "—", min: 0 },
  { field: "compaction.preserve_recent_tokens", placeholder: "—", min: 0 },
  { field: "compaction.reserved", placeholder: "—", min: 0 },
  // Both PositiveInt, with the defaults documented in the schema annotations.
  { field: "tool_output.max_lines", placeholder: "2000", min: 1 },
  { field: "tool_output.max_bytes", placeholder: "51200", min: 1 },
] as const

export interface OpenCodeBehaviorView {
  /** `default_agent`, or "" when unset. */
  defaultAgent: string
  share: OpenCodeShareMode | null
  autoupdate: OpenCodeAutoUpdate | null
  toggles: Record<OpenCodeToggleField, boolean | null>
  numbers: Record<OpenCodeNumberField, number | null>
  /** True when the document could not be parsed, so nothing here is authoritative. */
  invalid: boolean
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function parseConfig(configText: string): Record<string, unknown> | null {
  const trimmed = configText.trim()
  if (!trimmed) return {}
  try {
    return asRecord(JSON.parse(trimmed))
  } catch {
    return null
  }
}

/** Serialize back, collapsing an empty document to "" (= no file). */
function serializeConfig(config: Record<string, unknown>): string {
  return Object.keys(config).length === 0 ? "" : JSON.stringify(config, null, 2)
}

/** Split `"compaction.auto"` into its parent object and leaf key. */
function splitField(field: string): { parent: string | null; key: string } {
  const dot = field.indexOf(".")
  return dot === -1
    ? { parent: null, key: field }
    : { parent: field.slice(0, dot), key: field.slice(dot + 1) }
}

function readLeaf(
  config: Record<string, unknown>,
  field: string
): unknown | undefined {
  const { parent, key } = splitField(field)
  if (!parent) return config[key]
  return asRecord(config[parent])?.[key]
}

/**
 * Write `value` at `field`, or delete the leaf when `value` is `undefined`.
 * A parent object left empty by the delete is removed too, so unsetting every
 * compaction control does not leave `"compaction": {}` behind.
 */
function writeLeaf(
  config: Record<string, unknown>,
  field: string,
  value: unknown | undefined
): void {
  const { parent, key } = splitField(field)
  if (!parent) {
    if (value === undefined) delete config[key]
    else config[key] = value
    return
  }
  const existing = asRecord(config[parent])
  if (value === undefined) {
    if (!existing) return
    const next = { ...existing }
    delete next[key]
    if (Object.keys(next).length === 0) delete config[parent]
    else config[parent] = next
    return
  }
  config[parent] = { ...(existing ?? {}), [key]: value }
}

function readAutoUpdate(raw: unknown): OpenCodeAutoUpdate | null {
  if (raw === true) return "on"
  if (raw === false) return "off"
  if (raw === "notify") return "notify"
  return null
}

function autoUpdateValue(mode: OpenCodeAutoUpdate): boolean | string {
  if (mode === "on") return true
  if (mode === "off") return false
  return "notify"
}

/**
 * Read every behavior field out of the document. An unparsable document reports
 * `invalid` with all fields unset, so the UI can lock itself rather than
 * pretend the config says nothing.
 */
export function readOpenCodeBehavior(configText: string): OpenCodeBehaviorView {
  const config = parseConfig(configText)
  const toggles = {
    snapshot: null,
    "compaction.auto": null,
    "compaction.prune": null,
  } as Record<OpenCodeToggleField, boolean | null>
  const numbers = Object.fromEntries(
    OPENCODE_NUMBER_FIELDS.map((meta) => [meta.field, null])
  ) as Record<OpenCodeNumberField, number | null>

  if (!config) {
    return {
      defaultAgent: "",
      share: null,
      autoupdate: null,
      toggles,
      numbers,
      invalid: true,
    }
  }

  for (const field of Object.keys(toggles) as OpenCodeToggleField[]) {
    const raw = readLeaf(config, field)
    if (typeof raw === "boolean") toggles[field] = raw
  }
  for (const meta of OPENCODE_NUMBER_FIELDS) {
    const raw = readLeaf(config, meta.field)
    if (typeof raw === "number" && Number.isFinite(raw)) {
      numbers[meta.field] = raw
    }
  }

  const share = config.share
  const defaultAgent = config.default_agent

  return {
    defaultAgent: typeof defaultAgent === "string" ? defaultAgent : "",
    share:
      share === "manual" || share === "auto" || share === "disabled"
        ? share
        : null,
    autoupdate: readAutoUpdate(config.autoupdate),
    toggles,
    numbers,
    invalid: false,
  }
}

/** `default_agent`; an empty/whitespace name unsets the key. */
export function setOpenCodeDefaultAgent(
  configText: string,
  agent: string
): string {
  const config = parseConfig(configText)
  if (!config) return configText
  const trimmed = agent.trim()
  writeLeaf(config, "default_agent", trimmed === "" ? undefined : trimmed)
  return serializeConfig(config)
}

export function setOpenCodeShare(
  configText: string,
  share: OpenCodeShareMode | null
): string {
  const config = parseConfig(configText)
  if (!config) return configText
  writeLeaf(config, "share", share ?? undefined)
  return serializeConfig(config)
}

export function setOpenCodeAutoUpdate(
  configText: string,
  mode: OpenCodeAutoUpdate | null
): string {
  const config = parseConfig(configText)
  if (!config) return configText
  writeLeaf(config, "autoupdate", mode ? autoUpdateValue(mode) : undefined)
  return serializeConfig(config)
}

export function setOpenCodeToggle(
  configText: string,
  field: OpenCodeToggleField,
  value: boolean | null
): string {
  const config = parseConfig(configText)
  if (!config) return configText
  writeLeaf(config, field, value ?? undefined)
  return serializeConfig(config)
}

/**
 * Numeric fields. `null` (an emptied input) unsets the key; a value below the
 * field's schema floor, or one that is not a finite integer, is rejected and
 * leaves the document untouched — writing it would produce config OpenCode's
 * own `$schema` rejects.
 */
export function setOpenCodeNumber(
  configText: string,
  field: OpenCodeNumberField,
  value: number | null
): string {
  const config = parseConfig(configText)
  if (!config) return configText
  if (value === null) {
    writeLeaf(config, field, undefined)
    return serializeConfig(config)
  }
  const meta = OPENCODE_NUMBER_FIELDS.find((item) => item.field === field)
  if (!meta) return configText
  if (!Number.isInteger(value) || value < meta.min) return configText
  writeLeaf(config, field, value)
  return serializeConfig(config)
}
