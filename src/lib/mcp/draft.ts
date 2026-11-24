/**
 * The editor's form, and its two-way sync with the JSON view.
 *
 * The form is the source of truth while it is shown; the JSON view is the
 * same definition as text, and what is typed there is read back into the
 * form as soon as it is a definition. Text that is not — broken JSON, a field
 * the editor does not write — is never dropped: it stays in the JSON view,
 * marked, and blocks saving until it is fixed or deliberately discarded.
 *
 * The draft keeps a local server's fields and a remote server's side by side,
 * so switching the transport back and forth loses nothing typed; only the
 * chosen transport's fields make up the definition.
 */
import type { McpDefinition, McpTransport } from "./types"

export interface McpDraftArg {
  /** A React key: rows are added, removed and reordered by hand. */
  id: number
  value: string
}

export interface McpDraftPair {
  id: number
  name: string
  value: string
}

export interface McpDraft {
  transport: McpTransport
  command: string
  args: McpDraftArg[]
  env: McpDraftPair[]
  url: string
  headers: McpDraftPair[]
}

let lastRowId = 0
/** A fresh row id. Unique for the page's lifetime, so rows built from two
 *  definitions never share a key. */
export const newRowId = () => ++lastRowId

export function emptyDraft(transport: McpTransport = "stdio"): McpDraft {
  return { transport, command: "", args: [], env: [], url: "", headers: [] }
}

function pairs(record: Record<string, string> | undefined): McpDraftPair[] {
  return Object.entries(record ?? {}).map(([name, value]) => ({
    id: newRowId(),
    name,
    value,
  }))
}

/** A draft holding `definition`, with `base`'s fields of the other transport
 *  kept (empty without a base). */
export function draftFromDefinition(
  definition: McpDefinition,
  base: McpDraft = emptyDraft()
): McpDraft {
  if (definition.type === "stdio") {
    return {
      ...base,
      transport: "stdio",
      command: definition.command,
      args: (definition.args ?? []).map((value) => ({ id: newRowId(), value })),
      env: pairs(definition.env),
    }
  }
  return {
    ...base,
    transport: definition.type,
    url: definition.url,
    headers: pairs(definition.headers),
  }
}

/** A row the user added and left empty in both halves carries nothing. */
const isBlankPair = (pair: McpDraftPair) =>
  pair.name.trim() === "" && pair.value === ""

function record(rows: McpDraftPair[]): Record<string, string> | undefined {
  const out: Record<string, string> = {}
  for (const row of rows) {
    if (isBlankPair(row)) continue
    out[row.name.trim()] = row.value
  }
  return Object.keys(out).length > 0 ? out : undefined
}

/**
 * The definition the draft stands for. Names are trimmed (a stray space in a
 * variable's name is never meant); values, arguments, the command and the
 * address are left exactly as typed — the engine trims the command and the
 * address itself.
 */
export function definitionFromDraft(draft: McpDraft): McpDefinition {
  if (draft.transport === "stdio") {
    const args = draft.args.map((arg) => arg.value)
    const env = record(draft.env)
    return {
      type: "stdio",
      command: draft.command,
      ...(args.length > 0 ? { args } : {}),
      ...(env ? { env } : {}),
    }
  }
  const headers = record(draft.headers)
  return {
    type: draft.transport,
    url: draft.url,
    ...(headers ? { headers } : {}),
  }
}

// ─── What stops a save ────────────────────────────────────────────────

export type McpDraftProblem =
  | { kind: "commandRequired" }
  | { kind: "urlRequired" }
  | { kind: "argEmpty"; index: number }
  | { kind: "nameRequired"; list: "env" | "headers"; index: number }
  | { kind: "nameRepeated"; list: "env" | "headers"; name: string }

/** Everything in the draft that the engine would refuse or that is surely a
 *  slip, in the order the fields are shown. */
export function draftProblems(draft: McpDraft): McpDraftProblem[] {
  const problems: McpDraftProblem[] = []
  const rowProblems = (list: "env" | "headers", rows: McpDraftPair[]) => {
    const seen = new Set<string>()
    const repeated = new Set<string>()
    rows.forEach((row, index) => {
      if (isBlankPair(row)) return
      const name = row.name.trim()
      if (name === "") {
        problems.push({ kind: "nameRequired", list, index })
        return
      }
      if (seen.has(name)) repeated.add(name)
      seen.add(name)
    })
    for (const name of repeated)
      problems.push({ kind: "nameRepeated", list, name })
  }
  if (draft.transport === "stdio") {
    if (draft.command.trim() === "") problems.push({ kind: "commandRequired" })
    draft.args.forEach((arg, index) => {
      if (arg.value === "") problems.push({ kind: "argEmpty", index })
    })
    rowProblems("env", draft.env)
  } else {
    if (draft.url.trim() === "") problems.push({ kind: "urlRequired" })
    rowProblems("headers", draft.headers)
  }
  return problems
}

// ─── Comparing ────────────────────────────────────────────────────────

/** A definition in one canonical spelling: the order of `env` and `headers`
 *  does not matter (it does not to the engine's fingerprint either), the
 *  order of `args` does. */
export function definitionSignature(definition: McpDefinition): string {
  const sorted = (record: Record<string, string> | undefined) =>
    Object.entries(record ?? {}).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0
    )
  if (definition.type === "stdio") {
    return JSON.stringify([
      "stdio",
      definition.command.trim(),
      definition.args ?? [],
      sorted(definition.env),
    ])
  }
  return JSON.stringify([
    definition.type,
    definition.url.trim(),
    sorted(definition.headers),
  ])
}

export function sameDefinition(a: McpDefinition, b: McpDefinition): boolean {
  return definitionSignature(a) === definitionSignature(b)
}

// ─── The JSON view ────────────────────────────────────────────────────

/**
 * The definition as the JSON view shows it: exactly what a save writes. An
 * empty list is left out, as it is from the agent's file — the engine writes
 * no empty `args`, `env` or `headers`, and the view must not show one that
 * will not be there.
 */
export function definitionToJson(definition: McpDefinition): string {
  const shown =
    definition.type === "stdio"
      ? {
          type: definition.type,
          command: definition.command,
          ...(definition.args && definition.args.length > 0
            ? { args: definition.args }
            : {}),
          ...(definition.env && Object.keys(definition.env).length > 0
            ? { env: definition.env }
            : {}),
        }
      : {
          type: definition.type,
          url: definition.url,
          ...(definition.headers && Object.keys(definition.headers).length > 0
            ? { headers: definition.headers }
            : {}),
        }
  return JSON.stringify(shown, null, 2)
}

/** Why the JSON view's text is not a definition. */
export type McpJsonProblem =
  | { kind: "syntax"; detail: string }
  | { kind: "notObject" }
  | { kind: "type"; value: string }
  | { kind: "noTransport" }
  | { kind: "fieldType"; field: string }
  | { kind: "unknownField"; field: string }
  | { kind: "wrongTransportField"; field: string }

const STDIO_FIELDS = new Set(["type", "command", "args", "env"])
const REMOTE_FIELDS = new Set(["type", "url", "headers"])

function readRecord(
  value: unknown,
  field: string
): Record<string, string> | McpJsonProblem {
  if (value === undefined) return {}
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { kind: "fieldType", field }
  }
  const out: Record<string, string> = {}
  for (const [name, item] of Object.entries(value)) {
    if (typeof item !== "string") {
      return { kind: "fieldType", field: `${field}.${name}` }
    }
    out[name] = item
  }
  return out
}

const isProblem = (value: unknown): value is McpJsonProblem =>
  value !== null && typeof value === "object" && "kind" in value

/**
 * The JSON view's text, read strictly: a definition with exactly the fields
 * the editor writes. A missing `type` is read the way the engine reads one —
 * a command makes it local, an address remote over HTTP. Anything else is a
 * problem to show, never something to drop: an agent's own fields (a timeout,
 * a tool list) are kept by the engine on the entry they are already on, and
 * are not set from here.
 */
export function parseDefinitionJson(
  text: string
): { definition: McpDefinition } | { problem: McpJsonProblem } {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (error) {
    return {
      problem: {
        kind: "syntax",
        detail: error instanceof Error ? error.message : String(error),
      },
    }
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { problem: { kind: "notObject" } }
  }
  const raw = value as Record<string, unknown>
  let type = raw.type
  if (type === undefined) {
    if ("command" in raw) type = "stdio"
    else if ("url" in raw) type = "http"
    else return { problem: { kind: "noTransport" } }
  }
  if (type !== "stdio" && type !== "http" && type !== "sse") {
    return {
      problem: {
        kind: "type",
        value: typeof type === "string" ? type : JSON.stringify(type),
      },
    }
  }
  const allowed = type === "stdio" ? STDIO_FIELDS : REMOTE_FIELDS
  for (const field of Object.keys(raw)) {
    if (allowed.has(field)) continue
    const other = type === "stdio" ? REMOTE_FIELDS : STDIO_FIELDS
    return {
      problem: other.has(field)
        ? { kind: "wrongTransportField", field }
        : { kind: "unknownField", field },
    }
  }
  if (type === "stdio") {
    if (typeof raw.command !== "string") {
      return { problem: { kind: "fieldType", field: "command" } }
    }
    let args: string[] = []
    if (raw.args !== undefined) {
      if (
        !Array.isArray(raw.args) ||
        raw.args.some((arg) => typeof arg !== "string")
      ) {
        return { problem: { kind: "fieldType", field: "args" } }
      }
      args = raw.args as string[]
    }
    const env = readRecord(raw.env, "env")
    if (isProblem(env)) return { problem: env }
    return {
      definition: {
        type,
        command: raw.command,
        ...(args.length > 0 ? { args } : {}),
        ...(Object.keys(env).length > 0 ? { env } : {}),
      },
    }
  }
  if (typeof raw.url !== "string") {
    return { problem: { kind: "fieldType", field: "url" } }
  }
  const headers = readRecord(raw.headers, "headers")
  if (isProblem(headers)) return { problem: headers }
  return {
    definition: {
      type,
      url: raw.url,
      ...(Object.keys(headers).length > 0 ? { headers } : {}),
    },
  }
}

// ─── Addresses typed by hand ──────────────────────────────────────────

/**
 * Whether an address deserves a word before it is saved — never a refusal:
 * a plain-`http` server on another machine sends whatever its headers carry
 * in the clear, but it may be exactly what someone means.
 *
 * - `insecure`: neither `https:` nor a loopback address;
 * - `unreadable`: not an address at all.
 *
 * "Loopback" is the agent's host — the machine this page edits, which in a
 * remote window or a browser is not the one in front of the user.
 */
export function remoteUrlHint(url: string): "insecure" | "unreadable" | null {
  const trimmed = url.trim()
  if (trimmed === "") return null
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    return "unreadable"
  }
  if (parsed.protocol === "https:") return null
  return isLoopbackHost(parsed.hostname) ? null : "insecure"
}

export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "")
  if (host === "localhost" || host.endsWith(".localhost")) return true
  if (host === "::1" || host === "0:0:0:0:0:0:0:1") return true
  return /^127(?:\.\d{1,3}){3}$/.test(host)
}
