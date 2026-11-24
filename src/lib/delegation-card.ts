/**
 * Shared parsing + state-resolution helpers for `delegate_to_agent`
 * delegation cards.
 *
 * Shared so the timeline's delegation row AND the top-right sub-agent overlay
 * resolve the same agent type / task / status / child ids from the exact same
 * logic — one source of truth, no drift.
 *
 * Everything here is pure (no React). The React-specific binding/permission
 * lookups live in `useDelegationCardModel`.
 */

import { extractEmbeddedJsonObject } from "@/lib/embedded-json"
import { peelMcpResultEnvelope } from "@/lib/mcp-result-envelope"
import { ALL_AGENT_TYPES, isCustomAgentType, type AgentType } from "@/lib/types"
import {
  type DelegationBinding,
  type DelegationStatus,
} from "@/contexts/delegation-context"
import type { ToolCallState } from "@/lib/adapters/ai-elements-adapter"

/**
 * The full status a delegation card can render. Extends the wire-level
 * `DelegationStatus` ("running" | "ok" | "err") with UI-only "starting"
 * (binding not yet arrived) and "waiting" (child blocked on a permission
 * decision).
 */
export type DelegationCardStatus =
  | "starting"
  | "running"
  | "waiting"
  | "ok"
  | "err"

export type ParsedInput = {
  agentType: AgentType | null
  /** The assistant the call names (`assistant_id`). When set, the call's
   *  `agent_type` is not evidence of anything: the backend ignores it. */
  assistantId: number | null
  task: string | null
  workingDir: string | null
}

/** Largest assistant id: the backend keeps them in a 32-bit integer. */
const MAX_ASSISTANT_ID = 2_147_483_647

/**
 * Narrow an untrusted wire value to an assistant id, or `null`: a positive
 * integer, or a string of digits (some hosts stringify numeric arguments).
 */
export function coerceAssistantId(value: unknown): number | null {
  const n =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^[1-9]\d{0,9}$/.test(value.trim())
        ? Number(value.trim())
        : null
  return n !== null && Number.isInteger(n) && n >= 1 && n <= MAX_ASSISTANT_ID
    ? n
    : null
}

/** A non-empty assistant name snapshot off the wire, or `null`. */
function coerceAssistantName(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null
}

// Derived from the canonical `ALL_AGENT_TYPES` so a newly added agent is
// recognized here automatically. A hand-maintained duplicate previously drifted
// (it omitted `grok` and `cursor`), so their delegation cards resolved
// `agentType: null` — rendering the blank "unknown sub-agent" avatar/label
// instead of the agent's icon. Keep this sourced from one place.
const KNOWN_AGENT_TYPES: ReadonlySet<string> = new Set<AgentType>(
  ALL_AGENT_TYPES
)

/**
 * Narrow an untrusted wire string to an `AgentType`, or `null`.
 *
 * Accepts the built-ins plus any `custom:<id>` slug — a user-registered ACP
 * agent is as delegatable as a built-in, and `AgentIcon` / `getAgentLabel`
 * already render one.
 */
export function coerceAgentType(value: unknown): AgentType | null {
  if (typeof value !== "string") return null
  const trimmed = value.trim()
  if (!trimmed) return null
  if (KNOWN_AGENT_TYPES.has(trimmed)) return trimmed as AgentType
  return isCustomAgentType(trimmed) ? (trimmed as AgentType) : null
}

export type ParsedMeta = {
  status: DelegationStatus
  childConnectionId: string | null
  childConversationId: number | null
  errorCode: string | null
  /** Bounded task text the broker stamped onto the meta — the label source
   *  when `raw_input` never carried the arguments (Cursor) and the live
   *  binding is gone (refresh / persisted transcript). */
  task: string | null
  /** Broker-minted task id, mirrored on every meta write. */
  taskId: string | null
  /**
   * The child's agent type. Supplied only by the HISTORICAL injection
   * (`commands::conversations::build_historical_delegation_meta`, which reads
   * it off the child's DB row) — the live broker writes never carry it,
   * because the live binding already does. It is the only agent-type source
   * for a reloaded `resume_delegation` card, whose arguments are just
   * `{task_id, reason}`.
   */
  agentType: AgentType | null
  /** The assistant the task ran as, and its name when it started — on every
   *  broker write and on the historical injection alike. */
  assistantId: number | null
  assistantName: string | null
}

/**
 * Extract delegation state from a `ToolCallState.meta` value. Returns
 * `null` when the meta doesn't carry the `codeg.delegation` sub-object —
 * caller falls back to the live binding / `parseInput` chain.
 *
 * The shape mirrors what the broker writes via `DelegationMetaWriter`:
 *   `{ "codeg.delegation": { status, child_connection_id?,
 *     child_conversation_id?, error_code?, task_preview?, task_id? } }`
 */
export function parseDelegationMeta(
  meta: Record<string, unknown> | null | undefined
): ParsedMeta | null {
  if (!meta || typeof meta !== "object") return null
  const inner = meta["codeg.delegation"]
  if (!inner || typeof inner !== "object" || Array.isArray(inner)) return null
  const obj = inner as Record<string, unknown>
  const rawStatus = obj["status"]
  let status: DelegationStatus
  switch (rawStatus) {
    case "running":
    case "pending":
      status = "running"
      break
    case "completed":
    case "ok":
      status = "ok"
      break
    case "failed":
    case "err":
      status = "err"
      break
    default:
      return null
  }
  const child_connection_id = obj["child_connection_id"]
  const child_conversation_id = obj["child_conversation_id"]
  const error_code = obj["error_code"]
  const task_preview = obj["task_preview"]
  const task_id = obj["task_id"]
  return {
    status,
    childConnectionId:
      typeof child_connection_id === "string" ? child_connection_id : null,
    childConversationId:
      typeof child_conversation_id === "number" ? child_conversation_id : null,
    errorCode: typeof error_code === "string" ? error_code : null,
    task:
      typeof task_preview === "string" && task_preview ? task_preview : null,
    taskId: typeof task_id === "string" && task_id ? task_id : null,
    agentType: coerceAgentType(obj["agent_type"]),
    assistantId: coerceAssistantId(obj["assistant_id"]),
    assistantName: coerceAssistantName(obj["assistant_name"]),
  }
}

const EMPTY_PARSED_INPUT: ParsedInput = {
  agentType: null,
  assistantId: null,
  task: null,
  workingDir: null,
}

// Wrapper keys that hosts use to nest the actual tool arguments. JSON-RPC
// servers and various MCP relays will pack the call as `{name, arguments}`
// or `{params: {...}}`; some agents stash the args under a generic
// `input`/`payload` key alongside metadata; Cursor's MCP calls surface as
// `{providerIdentifier, toolName, args: {...}}`. Walked recursively (small
// depth cap) so any single layer of wrapping peels off without false
// positives on legitimate shallow fields. Mirrors `ARGS_WRAPPER_KEYS` in
// `acp/lifecycle.rs` — the two walkers must peel the same shapes.
const ARGS_WRAPPER_KEYS = [
  "arguments",
  "input",
  "params",
  "payload",
  "_meta",
  "args",
] as const

function findDelegationArgs(
  value: unknown,
  depth = 0
): Record<string, unknown> | null {
  if (depth > 4) return null
  if (value === null || value === undefined) return null
  // Some hosts double-encode the raw input (JSON-of-JSON). Recurse once
  // on the parsed inner value before giving up.
  if (typeof value === "string") {
    try {
      return findDelegationArgs(JSON.parse(value), depth + 1)
    } catch {
      return null
    }
  }
  if (typeof value !== "object" || Array.isArray(value)) return null
  const obj = value as Record<string, unknown>
  // Direct hit: this object has at least one of the delegation fields
  // declared on its top level.
  if (
    typeof obj.task === "string" ||
    typeof obj.agent_type === "string" ||
    typeof obj.working_dir === "string" ||
    coerceAssistantId(obj.assistant_id) !== null
  ) {
    return obj
  }
  for (const key of ARGS_WRAPPER_KEYS) {
    const child = obj[key]
    if (child === undefined) continue
    const found = findDelegationArgs(child, depth + 1)
    if (found) return found
  }
  return null
}

// ---------------------------------------------------------------------------
// opencode code-mode (`execute`) payloads
//
// opencode 2.x runs MCP tools through its built-in `execute` tool: the model
// writes `tools["codeg-mcp"].delegate_to_agent({…})` as JS source packed into
// a `{code: "…"}` raw input. These helpers recognize such a payload and read
// the argument values back out of the JS source — the same structural scanner
// as `acp/lifecycle.rs` (`code_mode_call_span` and friends), so the backend's
// registration decision and the frontend's card classification can never
// disagree about what counts as a delegation call. Like the Rust side, the
// scanner is STRICT: `tools` must reach `delegate_to_agent(` through a real
// accessor, strings/templates/comments are skipped (a task text *quoting* a
// call is not a call), and every ambiguity degrades to "unreadable" rather
// than a guessed value — spread / computed-key / escaped-quoted-key syntax
// screens the whole region out, values must end where their property ends,
// quoted keys match only escape-free at brace depth 1, and template text is
// read as the runtime would cook it (escapes decoded, bare line terminators
// TV-normalized to LF).
// ---------------------------------------------------------------------------

// Scan cap in UTF-8 bytes, the unit the backend measures (`code.len()`), so
// the two sides recognize the same payloads.
const CODE_MODE_MAX_CODE_BYTES = 1 << 20
const CODE_MODE_MAX_TEMPLATE_FRAMES = 16

type JsTemplateFrame =
  | { kind: "content" }
  | { kind: "interp"; braceDepth: number }

// Any non-BMP-ish unit counts as an identifier char: the scan only needs
// boundaries of ASCII words (`tools`, `delegate_to_agent`, argument keys), and
// over-approximating Unicode as identifier chars can only reject, never
// mis-split, a boundary. Matches `is_js_ident_byte` (>= 0x80).
function isJsIdentUnit(code: string, at: number): boolean {
  const c = code.charCodeAt(at)
  if (Number.isNaN(c)) return false
  return (
    (c >= 48 && c <= 57) || // 0-9
    (c >= 65 && c <= 90) || // A-Z
    (c >= 97 && c <= 122) || // a-z
    c === 95 || // _
    c === 36 || // $
    c >= 0x80
  )
}

function isJsWordAt(code: string, at: number, word: string): boolean {
  if (at < 0 || at + word.length > code.length) return false
  if (code.slice(at, at + word.length) !== word) return false
  const after = at + word.length
  return (
    (at === 0 || !isJsIdentUnit(code, at - 1)) &&
    (after >= code.length || !isJsIdentUnit(code, after))
  )
}

function jsIdentEnd(code: string, at: number): number {
  let end = at
  while (isJsIdentUnit(code, end)) end += 1
  return end
}

function skipJsString(code: string, open: number): number | null {
  const quote = code[open]
  let i = open + 1
  while (i < code.length) {
    if (code[i] === "\\") {
      i += 2
      continue
    }
    if (code[i] === quote) return i + 1
    i += 1
  }
  return null
}

function skipJsTemplate(code: string, open: number): number | null {
  const stack: JsTemplateFrame[] = [{ kind: "content" }]
  let i = open + 1
  while (stack.length > 0) {
    if (stack.length > CODE_MODE_MAX_TEMPLATE_FRAMES) return null
    if (i >= code.length) return null
    const c = code[i]
    const frame = stack[stack.length - 1]
    if (frame.kind === "content") {
      if (c === "`") {
        stack.pop()
        i += 1
        if (stack.length === 0) return i
      } else if (c === "\\") {
        i += 2
      } else if (c === "$" && code[i + 1] === "{") {
        stack.push({ kind: "interp", braceDepth: 0 })
        i += 2
      } else {
        i += 1
      }
    } else if (c === "{") {
      frame.braceDepth += 1
      i += 1
    } else if (c === "}") {
      if (frame.braceDepth === 0) stack.pop()
      else frame.braceDepth -= 1
      i += 1
    } else if (c === "'" || c === '"') {
      const end = skipJsString(code, i)
      if (end === null) return null
      i = end
    } else if (c === "`") {
      stack.push({ kind: "content" })
      i += 1
    } else if (c === "/" && code[i + 1] === "/") {
      while (i < code.length && !isJsLineTerminator(code[i])) i += 1
    } else if (c === "/" && code[i + 1] === "*") {
      const close = code.indexOf("*/", i + 2)
      if (close === -1) return null
      i = close + 2
    } else {
      i += 1
    }
  }
  return null
}

// Rust's `u8::is_ascii_whitespace`: space, \t, \n, \f, \r (not \v).
function isJsWs(c: string | undefined): boolean {
  return c === " " || c === "\t" || c === "\n" || c === "\f" || c === "\r"
}

// JS LineTerminator: LF, CR, U+2028 (LS), U+2029 (PS) — ECMA-262 line
// comments end at ANY of these, not just LF.
function isJsLineTerminator(c: string | undefined): boolean {
  return c === "\n" || c === "\r" || c === "\u2028" || c === "\u2029"
}

function skipJsWsAndComments(code: string, i: number): number {
  for (;;) {
    if (isJsWs(code[i])) {
      i += 1
      continue
    }
    if (code[i] === "/" && code[i + 1] === "/") {
      i += 2
      while (i < code.length && !isJsLineTerminator(code[i])) i += 1
      continue
    }
    if (code[i] === "/" && code[i + 1] === "*") {
      const close = code.indexOf("*/", i + 2)
      if (close === -1) return code.length
      i = close + 2
      continue
    }
    return i
  }
}

/** Whether `code` is longer than `cap` UTF-8 bytes, counted without
 *  encoding it: a UTF-16 unit is 1–3 bytes (a surrogate pair is 4 for two). */
function utf8LengthExceeds(code: string, cap: number): boolean {
  if (code.length > cap) return true
  if (code.length * 3 <= cap) return false
  let bytes = 0
  for (let i = 0; i < code.length; i += 1) {
    const c = code.charCodeAt(i)
    bytes += c < 0x80 ? 1 : c < 0x800 || (c >= 0xd800 && c <= 0xdfff) ? 2 : 3
    if (bytes > cap) return true
  }
  return false
}

/** Keywords that make what follows them conditional, repeated or deferred;
 *  `function` defers its body and its parameter defaults alike. Mirrors
 *  `CODE_MODE_BRANCH_KEYWORDS` in `acp/lifecycle.rs`. */
const CODE_MODE_BRANCH_KEYWORDS = [
  "if",
  "else",
  "switch",
  "for",
  "while",
  "do",
  "catch",
  "yield",
  "function",
]

/** The first `delegate_to_agent(` call reached via a `tools` accessor: the
 *  `(open, close)` of its argument list, and whether those arguments may be
 *  read as the delegation's — it is the only call site in a scan that
 *  reached the end of the script, or it provably runs before any other (at
 *  brace depth 0, outside any parameter list or destructuring pattern, with
 *  nothing before it that branches, defers or hides code in a `${…}`).
 *  `null` past the scan cap, on unbalanced input before the call, with no
 *  such call, or when a `/` that is no comment precedes the call: a regex
 *  literal is indistinguishable from division here, and its body can carry
 *  the quote or backtick that desynchronizes everything after it. Mirrors
 *  `code_mode_call_site` in `acp/lifecycle.rs`. */
function codeModeCallSite(
  code: string
): { open: number; close: number; readable: boolean } | null {
  if (utf8LengthExceeds(code, CODE_MODE_MAX_CODE_BYTES)) return null
  let i = 0
  let depth = 0
  // The `(` / `[` groups open at `i`, innermost last.
  const groups: string[] = []
  let branched = false
  let first: { open: number; close: number } | null = null
  let runsFirst = false
  // How many groups enclosing the first site have yet to close; each must
  // close as a call, a grouping or an array — not as an arrow's parameter
  // list or a destructuring pattern, whose defaults run only when a value is
  // missing.
  let enclosing = 0
  let sites = 0
  let counted = true
  scan: while (i < code.length) {
    const c = code[i]
    if (c === "'" || c === '"' || c === "`") {
      const end = c === "`" ? skipJsTemplate(code, i) : skipJsString(code, i)
      if (end === null) {
        if (first === null) return null
        counted = false
        break
      }
      // A `${…}` runs code the scan skips: a call in it is one the count
      // cannot see, and before the first site it may run first.
      if (c === "`" && code.slice(i, end).includes("${")) {
        counted = false
        if (first === null) branched = true
      }
      i = end
    } else if (c === "/" && (code[i + 1] === "/" || code[i + 1] === "*")) {
      i = skipJsWsAndComments(code, i)
    } else if (c === "/") {
      if (first === null) return null
      counted = false
      break
    } else if (c === "{") {
      depth += 1
      i += 1
    } else if (c === "}") {
      depth -= 1
      i += 1
    } else if (c === "(" || c === "[") {
      groups.push(c)
      i += 1
    } else if (c === ")" || c === "]") {
      groups.pop()
      i += 1
      if (enclosing > groups.length) {
        enclosing = groups.length
        const next = skipJsWsAndComments(code, i)
        const parameters =
          c === ")" && code[next] === "=" && code[next + 1] === ">"
        const pattern =
          c === "]" &&
          code[next] === "=" &&
          code[next + 1] !== "=" &&
          code[next + 1] !== ">"
        if (parameters || pattern) runsFirst = false
      }
    } else if (c === "?") {
      branched = true
      i += 1
    } else if ((c === "&" || c === "|") && code[i + 1] === c) {
      branched = true
      i += 2
    } else if (c === "=" && code[i + 1] === ">") {
      branched = true
      i += 2
    } else {
      for (const keyword of CODE_MODE_BRANCH_KEYWORDS) {
        if (isJsWordAt(code, i, keyword)) {
          branched = true
          i += 1
          continue scan
        }
      }
      if (isJsWordAt(code, i, "tools")) {
        const open = codeModeToolsCallOpen(code, i)
        if (open !== null) {
          const close = matchingParen(code, open)
          if (close === null) {
            if (first === null) return null
            counted = false
            break
          }
          sites += 1
          if (first === null) {
            first = { open, close }
            runsFirst = depth === 0 && !branched
            enclosing = groups.length
          }
          i = close + 1
          continue
        }
      }
      i += 1
    }
  }
  if (first === null) return null
  // A group around the first site that never closed in the scan could still
  // be a parameter list or a pattern.
  const provable = runsFirst && enclosing === 0
  return {
    open: first.open,
    close: first.close,
    readable: provable || (sites === 1 && counted),
  }
}

function codeModeToolsCallOpen(code: string, toolsAt: number): number | null {
  let i = toolsAt + "tools".length
  i = skipJsWsAndComments(code, i)
  const c = code[i]
  if (c === "[") {
    i = skipJsWsAndComments(code, i + 1)
    const quote = code[i]
    if (quote !== "'" && quote !== '"') return null
    const end = skipJsString(code, i)
    if (end === null) return null
    if (end === i + 2) return null
    i = skipJsWsAndComments(code, end)
    if (code[i] !== "]") return null
    i = skipJsWsAndComments(code, i + 1)
    if (code[i] !== ".") return null
    i = skipJsWsAndComments(code, i + 1)
  } else if (c === ".") {
    i = skipJsWsAndComments(code, i + 1)
    const end = jsIdentEnd(code, i)
    if (end === i) return null
    i = skipJsWsAndComments(code, end)
    if (code[i] !== ".") return null
    i = skipJsWsAndComments(code, i + 1)
  } else {
    return null
  }
  if (!isJsWordAt(code, i, "delegate_to_agent")) return null
  i = skipJsWsAndComments(code, i + "delegate_to_agent".length)
  return code[i] === "(" ? i : null
}

function matchingParen(code: string, open: number): number | null {
  return matchingClose(code, open, "(", ")")
}

/** Offset of the `closeCh` matching the `openCh` at `open`, skipping
 *  strings, templates, and comments. Mirrors `matching_close` in
 *  `acp/lifecycle.rs`. */
function matchingClose(
  code: string,
  open: number,
  openCh: string,
  closeCh: string
): number | null {
  let depth = 0
  let i = open
  while (i < code.length) {
    const c = code[i]
    if (c === "'" || c === '"') {
      const end = skipJsString(code, i)
      if (end === null) return null
      i = end
    } else if (c === "`") {
      const end = skipJsTemplate(code, i)
      if (end === null) return null
      i = end
    } else if (c === "/" && (code[i + 1] === "/" || code[i + 1] === "*")) {
      i = skipJsWsAndComments(code, i)
    } else if (c === openCh) {
      depth += 1
      i += 1
    } else if (c === closeCh) {
      depth -= 1
      if (depth === 0) return i
      i += 1
    } else {
      i += 1
    }
  }
  return null
}

/** Whether the call's argument list `(open, close)` holds exactly ONE object
 *  literal (a trailing comma aside): its first token is `{` and the matching
 *  `}` is followed only by whitespace/comments before the call's `)`. Any
 *  other shape — `c ? {…} : {…}`, `x || {…}`, `{…}.y`, a variable — passes
 *  something the literal alone does not determine. Mirrors
 *  `code_mode_single_object_argument` in `acp/lifecycle.rs`. */
function codeModeSingleObjectArgument(
  code: string,
  open: number,
  close: number
): boolean {
  const start = skipJsWsAndComments(code, open + 1)
  if (code[start] !== "{") return false
  const objectClose = matchingClose(code, start, "{", "}")
  if (objectClose === null) return false
  let after = skipJsWsAndComments(code, objectClose + 1)
  if (code[after] === ",") after = skipJsWsAndComments(code, after + 1)
  return after === close
}

/** Unit offset of the VALUE of a top-level `key:` inside `[start, end)`,
 *  skipping strings/templates/comments. Both spellings of a key match — bare
 *  `agent_type:` and quoted `"agent_type":` / `'agent_type':` — but only
 *  escape-free quoted keys (an escaped quoted key evaluates to an unknowable
 *  spelling) and only at brace depth 1, i.e. directly inside the call's
 *  argument object: the backend reads FLAT args, so a same-named key nested
 *  in a sub-object must not be seen; scanning STOPS when that object closes
 *  (depth 1→0), so a second argument object can never override the first's
 *  keys. Duplicate keys take the LAST occurrence
 *  — the spelling the JS runtime (and the JSON path) actually uses. Missing a
 *  key degrades the card to the generic task row; reading a wrong one could
 *  mislabel it. Mirrors `code_mode_find_key` in `acp/lifecycle.rs`. */
function codeModeFindKey(
  code: string,
  start: number,
  end: number,
  key: string
): number | null {
  let i = start
  let depth = 0
  let found: number | null = null
  while (i < end) {
    const c = code[i]
    if (c === "'" || c === '"') {
      const s = skipJsString(code, i)
      if (s === null) return null
      if (depth === 1 && s >= i + 2) {
        const inner = code.slice(i + 1, s - 1)
        const after = skipJsWsAndComments(code, s)
        if (code[after] === ":" && !inner.includes("\\") && inner === key) {
          found = skipJsWsAndComments(code, after + 1)
        }
      }
      i = s
    } else if (c === "`") {
      const s = skipJsTemplate(code, i)
      if (s === null) return null
      i = s
    } else if (c === "/" && (code[i + 1] === "/" || code[i + 1] === "*")) {
      i = skipJsWsAndComments(code, i)
    } else if (c === "{") {
      depth += 1
      i += 1
    } else if (c === "}") {
      if (depth <= 1) {
        // Closes the call's argument object (or a stray close): everything
        // after lies outside the flat args, so a second object must not
        // contribute keys — last-wins applies within ONE object only.
        break
      }
      depth -= 1
      i += 1
    } else if (depth === 1 && isJsWordAt(code, i, key)) {
      const after = skipJsWsAndComments(code, i + key.length)
      if (code[after] === ":") {
        found = skipJsWsAndComments(code, after + 1)
      }
      i += 1
    } else {
      i += 1
    }
  }
  return found
}

/** Whether the value's last consumed unit is followed (past whitespace and
 *  comments) by `,` or `}` — the literal ends where its object property ends.
 *  A literal followed by an operator (`"a" + b`, `` `a`.trim() ``) evaluates
 *  to something else at runtime and must not be read as the value. */
function valueEndsObjectProperty(code: string, end: number): boolean {
  const after = skipJsWsAndComments(code, end)
  return code[after] === "," || code[after] === "}"
}

/** Contents of the escape-free `'…'`/`"…"` string at `at` plus the offset
 *  past its closing quote; `null` when it contains a backslash (an escaped
 *  value could decode differently than it reads). */
function plainStringValueEnd(
  code: string,
  at: number
): [string, number] | null {
  const quote = code[at]
  if (quote !== "'" && quote !== '"') return null
  const end = skipJsString(code, at)
  if (end === null) return null
  const inner = code.slice(at + 1, end - 1)
  if (inner.includes("\\")) return null
  return [inner, end]
}

/** The evaluated `agent_type` / `working_dir` VALUE at `at`: an escape-free
 *  plain string ending where its property ends; anything else `null`. */
function objectStringValue(code: string, at: number): string | null {
  const r = plainStringValueEnd(code, at)
  if (r === null || !valueEndsObjectProperty(code, r[1])) return null
  return r[0]
}

/** The evaluated `task` VALUE at `at`: template literals via the minimal
 *  unescaper, plain strings only when escape-free, each required to end where
 *  its property ends; anything else (numbers, shorthand) `null`. */
function objectTaskValue(code: string, at: number): string | null {
  const c = code[at]
  let r: [string, number] | null
  if (c === "`") r = templateLiteralTextEnd(code, at)
  else if (c === "'" || c === '"') r = plainStringValueEnd(code, at)
  else return null
  if (r === null || !valueEndsObjectProperty(code, r[1])) return null
  return r[0]
}

function hexDigitValue(c: string): number | null {
  if (c >= "0" && c <= "9") return c.charCodeAt(0) - 48
  if (c >= "a" && c <= "f") return c.charCodeAt(0) - 87
  if (c >= "A" && c <= "F") return c.charCodeAt(0) - 55
  return null
}

// JS `\u` escapes denote scalar values: lone surrogates and anything past
// U+10FFFF are invalid (Rust `char::from_u32` returns `None` for both).
function unicodeFromU32(v: number): string | null {
  if (v > 0x10ffff) return null
  if (v >= 0xd800 && v <= 0xdfff) return null
  return String.fromCodePoint(v)
}

function readHexDigits(
  code: string,
  at: number,
  count: number
): [number, number] | null {
  if (at + count > code.length) return null
  let v = 0
  for (let k = 0; k < count; k += 1) {
    const d = hexDigitValue(code[at + k])
    if (d === null) return null
    v = v * 16 + d
  }
  return [v, at + count]
}

/** The evaluated text of the template literal starting at `at`, plus the unit
 *  offset past its closing backtick — the exact string the JS runtime passes
 *  to the MCP listener. That means the template's cooked text, not its
 *  source: `\n \t \r \b \f \v \0 \\ \` \' \" \$ \u{…} \uXXXX \xXX` decode,
 *  line continuations (`\` + CR/CRLF/LF) contribute nothing, and a BARE CR
 *  or CRLF is TV-normalized to a single LF — ECMA-262's normalization
 *  rewrites only those two, so U+2028/U+2029 pass through verbatim.
 *  `null` for `${…}` interpolation, for any escape outside the
 *  minimal set, and for legacy octal. */
function templateLiteralTextEnd(
  code: string,
  at: number
): [string, number] | null {
  let out = ""
  let i = at + 1
  while (i < code.length) {
    const c = code[i]
    if (c === "`") return [out, i + 1]
    if (c === "\\") {
      i += 1
      const e = code[i]
      if (e === undefined) return null
      i += 1
      if (e === "n") out += "\n"
      else if (e === "t") out += "\t"
      else if (e === "r") out += "\r"
      else if (e === "b") out += "\b"
      else if (e === "f") out += "\f"
      else if (e === "v") out += "\v"
      else if (e === "0") {
        if (code[i] !== undefined && code[i] >= "0" && code[i] <= "9") {
          // Legacy octal (`\01` ≠ `\0` + `1`); not supported.
          return null
        }
        out += "\0"
      } else if (e === "\\") out += "\\"
      else if (e === "`") out += "`"
      else if (e === "$") out += "$"
      else if (e === "'") out += "'"
      else if (e === '"') out += '"'
      else if (e === "u") {
        if (code[i] === "{") {
          const close = code.indexOf("}", i)
          if (close === -1) return null
          const digits = code.slice(i + 1, close)
          if (digits.length === 0 || digits.length > 6) return null
          let v = 0
          for (const d of digits) {
            const h = hexDigitValue(d)
            if (h === null) return null
            v = v * 16 + h
          }
          const cp = unicodeFromU32(v)
          if (cp === null) return null
          out += cp
          i = close + 1
        } else {
          const r = readHexDigits(code, i, 4)
          if (r === null) return null
          const cp = unicodeFromU32(r[0])
          if (cp === null) return null
          out += cp
          i = r[1]
        }
      } else if (e === "x") {
        const r = readHexDigits(code, i, 2)
        if (r === null) return null
        const cp = unicodeFromU32(r[0])
        if (cp === null) return null
        out += cp
        i = r[1]
      } else if (e === "\r") {
        // Line continuation: the newline is dropped.
        if (code[i] === "\n") i += 1
      } else if (e === "\n") {
        // Line continuation: the newline is dropped.
      } else {
        return null
      }
    } else if (c === "$" && code[i + 1] === "{") {
      return null
    } else if (c === "\r") {
      // A bare CR (or the CR of a CRLF) is TV-normalized to a single LF.
      out += "\n"
      i += 1
      if (code[i] === "\n") i += 1
    } else {
      // U+2028/U+2029 are JS line terminators but NOT TV-normalized (only
      // CR and CRLF are); folding them to LF here would mint a key the MCP
      // side never receives.
      out += c
      i += 1
    }
  }
  return null
}

/** The `code` source and its first call site for a recognized code-mode
 *  delegation payload, or `null`. The frontend mirror of
 *  `code_mode_delegation_code` in `acp/lifecycle.rs`: same predicate, so a
 *  card renders exactly when the backend registers the call. */
function codeModeCallOf(parsed: unknown): {
  code: string
  site: { open: number; close: number; readable: boolean }
} | null {
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null
  }
  const code = (parsed as Record<string, unknown>).code
  if (typeof code !== "string") return null
  const site = codeModeCallSite(code)
  return site === null ? null : { code, site }
}

/** The argument keys the scanner reads; a bare one not followed by `:` is a
 *  SHORTHAND property (or a variable in value position) — either way its
 *  value is a runtime value, and a shorthand after an explicit spelling
 *  overrides it. */
const CODE_MODE_ARG_KEYS = ["agent_type", "task", "working_dir", "assistant_id"]

/** Conservative pre-pass over the argument region: `false` when the region
 *  contains syntax whose effect the scanner cannot evaluate. Spread
 *  (`...base`) may carry an `assistant_id`; a `[` covers computed keys
 *  (`["assistant_id"]: 3`) and array values; a quoted KEY containing a
 *  backslash evaluates to an unknowable spelling; a `(`/`)` or a non-comment
 *  `/` is a call/parenthesized/division/regex expression the scanner cannot
 *  evaluate; a `?` is a conditional, optional chain or `??` (a ternary would
 *  also put a value string in front of a `:`, where it reads as a key); a
 *  `\` outside a string is a Unicode-escaped identifier (`\u0074ask` IS
 *  `task`); a non-ASCII character outside a string is a Unicode identifier
 *  or whitespace the ASCII word matcher cannot delimit; a bare argument key
 *  is a SHORTHAND property whose value is the variable's runtime value. Each
 *  degrades the parse to unreadable. Mirrors `code_mode_args_transparent` in
 *  `acp/lifecycle.rs`. */
function codeModeArgsTransparent(
  code: string,
  start: number,
  end: number
): boolean {
  let i = start
  scan: while (i < end) {
    const c = code[i]
    if (c === "'" || c === '"') {
      const s = skipJsString(code, i)
      if (s === null) return false
      const after = skipJsWsAndComments(code, s)
      if (code[after] === ":" && code.slice(i + 1, s - 1).includes("\\")) {
        return false
      }
      i = s
    } else if (c === "`") {
      const s = skipJsTemplate(code, i)
      if (s === null) return false
      i = s
    } else if (c === "/" && (code[i + 1] === "/" || code[i + 1] === "*")) {
      i = skipJsWsAndComments(code, i)
    } else if (c === "/" || c === "(" || c === ")") {
      return false
    } else if (c === "[" || c === "?" || c === "\\") {
      return false
    } else if (code.charCodeAt(i) >= 0x80) {
      return false
    } else if (c === "." && code[i + 1] === "." && code[i + 2] === ".") {
      return false
    } else {
      for (const key of CODE_MODE_ARG_KEYS) {
        if (!isJsWordAt(code, i, key)) continue
        const after = skipJsWsAndComments(code, i + key.length)
        if (code[after] !== ":") return false
        i += key.length
        continue scan
      }
      i += 1
    }
  }
  return true
}

/** The `assistant_id` VALUE at `at`, as a string for `coerceAssistantId`: an
 *  escape-free quoted number, or bare digits. Numbers must be read —
 *  `assistant_id: 3` is the common spelling, and leaving it unread would make
 *  the card fall back to `agent_type` and mislabel an Assistant delegation. */
function readAssistantIdValue(code: string, at: number): string | null {
  const quoted = plainStringValueEnd(code, at)
  if (quoted !== null) {
    return valueEndsObjectProperty(code, quoted[1]) ? quoted[0] : null
  }
  let i = at
  while (i < code.length && code[i] >= "0" && code[i] <= "9") i += 1
  if (i === at) return null
  if (!valueEndsObjectProperty(code, i)) return null
  return code.slice(at, i)
}

/** Parse a code-mode payload's arguments out of the JS source; `null` when the
 *  payload is no code-mode delegation call at all. The argument must be one
 *  object literal ([`codeModeSingleObjectArgument`]) and its region is
 *  screened by [`codeModeArgsTransparent`]: syntax the scanner cannot
 *  evaluate (spread, computed keys, escaped quoted keys, conditionals) could
 *  hide an `assistant_id` or change any value, so every field reads as
 *  unknown and the card renders the generic task row — correlation goes
 *  through the tool_call id binding, not these values, so unlike the backend
 *  key there is nothing to mint wrong. Readable values become card content;
 *  unreadable ones (interpolation, unknown escapes) stay `null` per field. */
function parseCodeModeInput(parsed: unknown): ParsedInput | null {
  const call = codeModeCallOf(parsed)
  if (call === null) return null
  const { code, site } = call
  const { open, close } = site
  const start = open + 1
  // A recognized call whose arguments can't be read is an expected shape,
  // not an unknown wrapper: answer "nothing readable" here so `parseInput`
  // doesn't log its unknown-shape breadcrumb on every render.
  if (
    !site.readable ||
    !codeModeSingleObjectArgument(code, open, close) ||
    !codeModeArgsTransparent(code, start, close)
  ) {
    return EMPTY_PARSED_INPUT
  }
  const assistantAt = codeModeFindKey(code, start, close, "assistant_id")
  const agentAt = codeModeFindKey(code, start, close, "agent_type")
  const workingAt = codeModeFindKey(code, start, close, "working_dir")
  const taskAt = codeModeFindKey(code, start, close, "task")
  return {
    agentType:
      agentAt !== null
        ? coerceAgentType(objectStringValue(code, agentAt))
        : null,
    assistantId:
      assistantAt !== null
        ? coerceAssistantId(readAssistantIdValue(code, assistantAt))
        : null,
    task: taskAt !== null ? objectTaskValue(code, taskAt) : null,
    workingDir: workingAt !== null ? objectStringValue(code, workingAt) : null,
  }
}

/**
 * Whether a raw tool input is an opencode code-mode `execute` payload whose
 * `code` source announces a `delegate_to_agent` call. Shape only — classify a
 * tool call with [`isCodeModeDelegationCall`], which also checks the tool.
 */
export function isCodeModeDelegationInput(
  raw: string | null | undefined
): boolean {
  if (!raw || typeof raw !== "string") return false
  // Cheap pre-gate, same as the backend's: any JSON payload carrying a `code`
  // key contains the literal `"code"` bytes, so skipping the parse for
  // payloads that don't keeps this branch free for every non-code-mode call.
  if (!raw.includes('"code"')) return false
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return false
  }
  return codeModeCallOf(parsed) !== null
}

/**
 * Whether a tool call is opencode's code-mode `execute` running a
 * `delegate_to_agent` call — the frontend half of the backend's code-mode
 * registration branch (`is_delegation_invocation`, gated on the `execute`
 * title), so the call renders as a delegation card exactly when the backend
 * registers it. Takes the NORMALIZED tool name: `execute` normalizes to
 * `bash`, live (before and after the opening frame's name stamp) and in
 * history. The tool gate keeps another tool's `code` argument — a Playwright
 * `browser_run_code` script that mocks the call, say — from passing as one.
 */
export function isCodeModeDelegationCall(
  normalizedToolName: string,
  raw: string | null | undefined
): boolean {
  return normalizedToolName === "bash" && isCodeModeDelegationInput(raw)
}

/**
 * A content-free structural descriptor of a value: object keys (recursively,
 * depth- and width-capped), array lengths, and primitive *types* — never the
 * values themselves. This is exactly what diagnoses an unrecognized wire shape
 * (which keys did the host nest the args under?) without exposing any content.
 */
function describeShape(value: unknown, depth = 0): string {
  if (value === null) return "null"
  if (Array.isArray(value)) return `array(${value.length})`
  if (typeof value !== "object") return typeof value
  if (depth >= 3) return "object{…}"
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj)
  if (keys.length === 0) return "object{}"
  const shown = keys
    .slice(0, 20)
    .map((k) => `${k}: ${describeShape(obj[k], depth + 1)}`)
    .join(", ")
  return `object{ ${shown}${keys.length > 20 ? ", …" : ""} }`
}

// One-line debug breadcrumb. The walker covers the wrappers we know about
// (`arguments`, `input`, `params`, `payload`, `_meta`); if a non-empty raw
// input still doesn't yield delegation args, the host is using a shape we
// haven't accounted for. We log the unrecognized *shape* (keys + types, never
// values) so the next "task didn't show up" report is self-debugging — the
// wire shape lands in the user's devtools — without dumping the raw `task`
// text, `working_dir` path, or anything a user pasted into a prompt into the
// console.
function warnDelegationInputUnparseable(shape: string, reason: string): void {
  console.warn(
    `[delegation-card] could not extract delegation args (${reason}). shape=${shape}`
  )
}

export function parseInput(raw: string | null | undefined): ParsedInput {
  if (!raw || typeof raw !== "string") return EMPTY_PARSED_INPUT
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    warnDelegationInputUnparseable(
      `non-JSON(len=${raw.length})`,
      "JSON.parse threw"
    )
    return EMPTY_PARSED_INPUT
  }
  const obj = findDelegationArgs(parsed)
  if (!obj) {
    // opencode code-mode: the args live as a JS object literal INSIDE the
    // `code` source string, not on the wire object. Return whatever values
    // are readable — a `task` that can't be read still leaves the agent
    // slug, and the card renders the generic task row (same grade as
    // Cursor's identityless `{}`).
    const codeMode = parseCodeModeInput(parsed)
    if (codeMode) return codeMode
    // An empty object is the EXPECTED shape on identity-less hosts (Cursor
    // announces every MCP call with raw_input "{}") — nothing to diagnose,
    // so don't spam the console on every render of those cards.
    const isEmptyObject =
      parsed !== null &&
      typeof parsed === "object" &&
      !Array.isArray(parsed) &&
      Object.keys(parsed as Record<string, unknown>).length === 0
    if (!isEmptyObject) {
      warnDelegationInputUnparseable(
        describeShape(parsed),
        "no known wrapper matched"
      )
    }
    return EMPTY_PARSED_INPUT
  }
  return {
    agentType: coerceAgentType(obj.agent_type),
    assistantId: coerceAssistantId(obj.assistant_id),
    task: typeof obj.task === "string" ? obj.task : null,
    workingDir: typeof obj.working_dir === "string" ? obj.working_dir : null,
  }
}

/**
 * Parsed form of the parent `delegate_to_agent` tool output.
 *
 * Under ASYNC delegation the tool output is a *running ack* — the result
 * arrives later via the `delegation_completed` event / meta, NOT on the tool
 * output. So we must distinguish:
 *   - `ack`     — a running (or otherwise non-terminal) task: there is NO
 *                 result to render on the card yet.
 *   - `outcome` — a terminal result to render (a fast-complete ack where the
 *                 child finished during setup, or a legacy pre-async
 *                 synchronous result).
 * Returning `ack` — rather than letting the raw ack JSON fall through as an
 * "outcome" — is what stops the card from painting the ack as the result and
 * from prematurely flipping the status badge to "ok".
 */
export type ParsedToolOutput =
  | ({
      kind: "ack"
      childConversationId: number | null
      agentType?: AgentType | null
      errorCode?: string | null
    } & ReportedAssistant)
  | ({
      kind: "outcome"
      text: string
      isError: boolean
      childConversationId: number | null
      agentType?: AgentType | null
      errorCode?: string | null
    } & ReportedAssistant)

/** The assistant a broker report names (`DelegationTaskReport.assistant_id` /
 *  `assistant_name`); absent on the text fallbacks. */
type ReportedAssistant = {
  assistantId?: number | null
  assistantName?: string | null
}

/**
 * `DelegationTaskReport.error_code` for a refused `resume_delegation`
 * (`broker.rs::NOT_RESUMABLE_CODE`). Mirror of the Rust constant.
 */
export const NOT_RESUMABLE_CODE = "not_resumable"

/**
 * Opening words of the two `resume_delegation` messages that must stay
 * readable when the structured report is gone. `companion.rs::render_task_report`
 * puts the whole report — `error_code`, `child_conversation_id`, everything —
 * in `structuredContent` and renders only `message` as content text, and some
 * hosts keep only the text: OpenCode "drops the MCP `structuredContent`
 * entirely, so the human-readable lines ARE the whole record"
 * (`acp/connection.rs`, verified against opencode 1.18.23).
 *
 * The backend writes these prefixes deliberately for that case — see
 * `broker.rs::not_resumable_report` ("a message that opens with 'Not resumed'
 * — unambiguous against the ack even on hosts that only surface the content
 * text") and `resume_ack`. Both sides must keep spelling them the same way.
 */
const REFUSED_RESUME_TEXT = "Not resumed:"
const RESUMED_ACK_TEXT = "Delegation resumed"

/**
 * Whether a real `DelegationTaskReport` was recovered, as opposed to opaque
 * result text. `interpretReport` sets `errorCode` on every branch — to `null`
 * when the report carried no code — while the generic text fallbacks leave it
 * absent, so `undefined` means "no structure survived".
 */
function isStructuredReport(parsed: ParsedToolOutput | null): boolean {
  return parsed != null && parsed.errorCode !== undefined
}

/**
 * Does this result OPEN with one of the backend's markers?
 *
 * Anchored, never a substring search, because the text channel is not always
 * the backend's own message: `render_task_report` renders `text` in preference
 * to `message` for a `completed` report, and a resume whose child finished
 * during setup (`broker.rs`'s `Disposition::ChildTerminal`) reports exactly
 * that child's LLM-written output. A sub-agent that merely discusses
 * delegation would otherwise be read as a verdict about its own card.
 *
 * Checks the parsed outcome text as well as the raw string so a host envelope
 * around the message doesn't hide the marker.
 */
function opensWith(
  parsed: ParsedToolOutput | null,
  raw: string | null | undefined,
  marker: string
): boolean {
  const parsedText = parsed?.kind === "outcome" ? parsed.text : null
  return [parsedText, raw].some(
    (candidate) => candidate?.trimStart().startsWith(marker) ?? false
  )
}

/**
 * Whether a `resume_delegation` result is the broker REFUSING to resume.
 *
 * This cannot be read off `status`: a refusal deliberately reports the task's
 * ACTUAL state (`broker.rs::not_resumable_report`), so "already completed"
 * arrives as `status: "completed"` and "still running" as `status: "running"`
 * — indistinguishable from a real resume by status alone. Only `error_code`
 * separates them — or, where no structure survived, the message prefix.
 *
 * It matters because a refusal still carries `agent_type` and
 * `child_conversation_id`, which is otherwise exactly the evidence a resumed
 * sub-agent card runs on: without this check the card paints a live-looking
 * (or done-looking) sub-agent for a resume that never happened, and buries the
 * one thing the user needs — the "Not resumed: …" explanation.
 */
export function isRefusedResume(
  output?: string | null,
  errorText?: string | null
): boolean {
  const parsed = parseResumeResult(output, errorText)
  // Structure survived ⇒ it is the whole answer. Falling through to the text
  // would be reading a child's own output for a verdict about the call.
  if (isStructuredReport(parsed)) {
    return parsed?.errorCode === NOT_RESUMABLE_CODE
  }
  return (
    opensWith(parsed, output, REFUSED_RESUME_TEXT) ||
    opensWith(parsed, errorText, REFUSED_RESUME_TEXT)
  )
}

/**
 * Whether a `resume_delegation` result is the broker CONFIRMING the resume —
 * as opposed to refusing it, or reporting an unknown task
 * (`broker.rs::unknown_report`, which a foreign task id lands on).
 *
 * Used to corroborate a task-id binding lookup when the report itself named no
 * child conversation: on a host that drops `structuredContent` the ack's
 * `child_conversation_id` is gone, so the confirmation text is the only thing
 * left that distinguishes "this call really did revive that task" from "the
 * model named somebody else's task id".
 */
export function isAffirmedResume(
  output?: string | null,
  errorText?: string | null
): boolean {
  if (isRefusedResume(output, errorText)) return false
  const parsed = parseResumeResult(output, errorText)
  // With the report intact, naming a child IS the confirmation — and its
  // absence is what marks `unknown_report`. No need to read prose for it.
  if (isStructuredReport(parsed)) {
    return parsed?.childConversationId != null
  }
  return (
    opensWith(parsed, output, RESUMED_ACK_TEXT) ||
    opensWith(parsed, errorText, RESUMED_ACK_TEXT)
  )
}

function parseResumeResult(
  output?: string | null,
  errorText?: string | null
): ParsedToolOutput | null {
  return (
    (errorText ? parseToolOutput(errorText, true) : null) ??
    parseToolOutput(output)
  )
}

function readChildConversationId(obj: Record<string, unknown>): number | null {
  return typeof obj.child_conversation_id === "number"
    ? obj.child_conversation_id
    : null
}

/**
 * Interpret the broker's inner shape — the async `DelegationTaskReport`
 * (discriminated by `status`) or the legacy synchronous `DelegationOutcome`
 * (discriminated by `kind`). Returns null when neither discriminator is present
 * so the caller can fall through to other unwrapping strategies.
 */
function interpretReport(
  obj: Record<string, unknown>
): ParsedToolOutput | null {
  const childConversationId = readChildConversationId(obj)
  // `DelegationTaskReport.agent_type` (types.rs). For `delegate_to_agent` this
  // merely echoes the `agent_type` argument the card already parsed; it earns
  // its keep on `resume_delegation`, whose arguments are only
  // `{task_id, reason}` — the report is the ONLY place a reloaded resume card
  // can learn which agent it revived.
  const agentType = coerceAgentType(obj.agent_type)
  // Stamped on every report of a task run as an assistant.
  const assistant: ReportedAssistant = {
    assistantId: coerceAssistantId(obj.assistant_id),
    assistantName: coerceAssistantName(obj.assistant_name),
  }
  // Carried on EVERY variant, not just the failed ones: a refused resume pairs
  // `not_resumable` with the task's real status, so the code is the only thing
  // that distinguishes it from the report of a genuine resume. See
  // `isRefusedResume`.
  const errorCode = typeof obj.error_code === "string" ? obj.error_code : null
  const status = typeof obj.status === "string" ? obj.status : null
  if (status) {
    switch (status) {
      case "running":
      case "unknown":
        // No terminal result to show on the card — it's an ack.
        return {
          kind: "ack",
          childConversationId,
          agentType,
          errorCode,
          ...assistant,
        }
      case "completed":
        return {
          kind: "outcome",
          text: typeof obj.text === "string" ? obj.text : "",
          isError: false,
          childConversationId,
          agentType,
          errorCode,
          ...assistant,
        }
      case "failed":
      case "canceled": {
        const message = typeof obj.message === "string" ? obj.message : ""
        const code = errorCode ?? ""
        return {
          kind: "outcome",
          text: message || code || "Delegation failed.",
          isError: true,
          childConversationId,
          agentType,
          errorCode,
          ...assistant,
        }
      }
      default:
        return {
          kind: "ack",
          childConversationId,
          agentType,
          errorCode,
          ...assistant,
        }
    }
  }
  // Legacy synchronous outcome shape. These branches must set `errorCode` too
  // — `null` where there is none — because its ABSENCE is what
  // `isStructuredReport` reads as "no report survived, fall back to the text".
  // Leaving it off here would send a perfectly well-formed legacy result down
  // the text path, where a result that merely opens with "Not resumed:" would
  // be taken for a refusal.
  const kind = typeof obj.kind === "string" ? obj.kind : null
  if (kind === "ok") {
    return {
      kind: "outcome",
      text: typeof obj.text === "string" ? obj.text : "",
      isError: false,
      childConversationId,
      agentType,
      errorCode: null,
      ...assistant,
    }
  }
  if (kind === "err") {
    const message = typeof obj.message === "string" ? obj.message : ""
    // The legacy shape spells the code `code`, not `error_code`.
    const code = typeof obj.code === "string" ? obj.code : ""
    return {
      kind: "outcome",
      text: message || code || "Delegation failed.",
      isError: true,
      errorCode: code || null,
      childConversationId,
      agentType,
      ...assistant,
    }
  }
  return null
}

/**
 * When an MCP `CallToolResult` lacks a usable `structuredContent`, the broker's
 * `DelegationTaskReport` may still be inlined in `content[0]` — either as a
 * structured `.json` object, or (Codex-style) as a JSON string in `.text`
 * (optionally wrapped, e.g. `"Wall time: N seconds\nOutput:\n<json>_"`).
 * Recognize it so a running ack yields `kind:"ack"` (not a premature "ok") and
 * its `child_conversation_id` is preserved for the "查看会话" affordance. Returns
 * null when no report can be recovered from the content array.
 */
function interpretMcpContentArray(
  obj: Record<string, unknown>
): ParsedToolOutput | null {
  if (!Array.isArray(obj.content)) return null
  const first = (obj.content as unknown[])[0]
  if (!first || typeof first !== "object" || Array.isArray(first)) return null
  const firstObj = first as Record<string, unknown>
  // Some hosts attach a structured `json` field on the content item.
  if (
    firstObj.json &&
    typeof firstObj.json === "object" &&
    !Array.isArray(firstObj.json)
  ) {
    const interpreted = interpretReport(
      firstObj.json as Record<string, unknown>
    )
    if (interpreted) return interpreted
  }
  // Codex-style: `content[0].text` is itself the serialized report.
  if (typeof firstObj.text === "string") {
    const embedded = extractEmbeddedJsonObject(firstObj.text)
    if (embedded) {
      const interpreted = interpretReport(embedded)
      if (interpreted) return interpreted
    }
  }
  return null
}

/** Whether `obj` is already one of the shapes [`parseToolOutput`] reads — a
 *  report (`status`), a legacy outcome (`kind`), or an MCP `CallToolResult`.
 *  Stops the host-envelope peel at a result that itself happens to carry a
 *  `result` key. (A child's arbitrary payload is guarded on the other side too:
 *  `peelMcpResultEnvelope` only ever peels TO a real `CallToolResult`.) */
function isResolvableDelegateResult(obj: Record<string, unknown>): boolean {
  return (
    typeof obj.status === "string" ||
    typeof obj.kind === "string" ||
    Array.isArray(obj.content) ||
    (typeof obj.structuredContent === "object" &&
      obj.structuredContent !== null &&
      !Array.isArray(obj.structuredContent))
  )
}

/**
 * Best-effort parse of the `delegate_to_agent` tool output into a
 * `ParsedToolOutput`. Mirrors the old unwrapping chain (direct JSON →
 * embedded-object scan → MCP `CallToolResult` envelope from
 * `companion.rs::render_task_report`) but yields the ack/outcome tagged union
 * so a running ack is never rendered as a result. `forceError` is set when
 * parsing the tool's `errorText` channel.
 *
 * A host envelope around the MCP result — Codex's live wire sends
 * `{result: <CallToolResult>, error: null}` — is peeled first, so the chain
 * below only ever faces the result itself.
 */
export function parseToolOutput(
  raw: string | null | undefined,
  forceError = false
): ParsedToolOutput | null {
  if (!raw || typeof raw !== "string") return null
  const trimmed = raw.trim()
  if (!trimmed) return null

  let obj: Record<string, unknown> | null = null
  try {
    const v = JSON.parse(trimmed) as unknown
    if (v && typeof v === "object" && !Array.isArray(v)) {
      obj = v as Record<string, unknown>
    } else {
      // Top-level primitive (string/number/bool): render directly.
      return {
        kind: "outcome",
        text: String(v),
        isError: forceError,
        childConversationId: null,
      }
    }
  } catch {
    obj = extractEmbeddedJsonObject(trimmed)
  }

  if (!obj) {
    return {
      kind: "outcome",
      text: trimmed,
      isError: forceError,
      childConversationId: null,
    }
  }

  const peel = peelMcpResultEnvelope(obj, isResolvableDelegateResult)
  obj = peel.obj

  // MCP `CallToolResult` envelope: `{ content: [...], structuredContent?, isError? }`.
  if (Array.isArray(obj.content)) {
    const inner =
      obj.structuredContent &&
      typeof obj.structuredContent === "object" &&
      !Array.isArray(obj.structuredContent)
        ? (obj.structuredContent as Record<string, unknown>)
        : null
    // 1. Prefer the full structured report.
    if (inner) {
      const interpreted = interpretReport(inner)
      if (interpreted) {
        // Honor an outer `isError: true` the host already decided.
        if (interpreted.kind === "outcome" && obj.isError === true) {
          return { ...interpreted, isError: true }
        }
        return interpreted
      }
    }
    // 2. No usable `structuredContent` (e.g. a host that surfaces only the
    //    content array): the report may be inlined in `content[0]`. Recognize a
    //    running ack here so it isn't mis-rendered as a terminal "ok" and its
    //    child id survives.
    const fromContent = interpretMcpContentArray(obj)
    if (fromContent) {
      if (fromContent.kind === "outcome" && obj.isError === true) {
        return { ...fromContent, isError: true }
      }
      return fromContent
    }
    // 3. Last resort: render `content[0].text` as opaque outcome text, carrying
    //    any child id from `structuredContent` if it was present but
    //    uninterpretable.
    const first = (obj.content as unknown[])[0]
    if (first && typeof first === "object" && !Array.isArray(first)) {
      const text = (first as Record<string, unknown>).text
      if (typeof text === "string") {
        return {
          kind: "outcome",
          text,
          isError: obj.isError === true || forceError,
          childConversationId: inner ? readChildConversationId(inner) : null,
        }
      }
    }
  }

  const interpreted = interpretReport(obj)
  if (interpreted) {
    if (interpreted.kind === "outcome" && forceError) {
      return { ...interpreted, isError: true }
    }
    return interpreted
  }

  // A host envelope that failed outright carries no result to render — its own
  // error string is the whole story, and beats dumping the envelope JSON.
  if (peel.hostError) {
    return {
      kind: "outcome",
      text: peel.hostError,
      isError: true,
      childConversationId: null,
    }
  }

  // Unrecognized JSON — pretty-print so we don't surface raw braces.
  return {
    kind: "outcome",
    text: "```json\n" + JSON.stringify(obj, null, 2) + "\n```",
    isError: forceError,
    childConversationId: null,
  }
}

/**
 * Surface the broker-minted `task_id` from the `delegate_to_agent` ack so the
 * user can correlate this delegation with the later `get_delegation_status` /
 * `cancel_delegation` cards. It is carried two ways: as
 * `structuredContent.task_id` (persisted / snapshot rows) and embedded in the
 * running-ack message text as `task_id=<id>` (the live wire forwards only the
 * `CallToolResult.content` text, not `structuredContent`). Returns null when no
 * id can be recovered. The structured form is tried first; the text scan is a
 * fallback so a stray `"task_id":...` inside JSON never beats the real field.
 */
export function parseDelegateTaskId(
  output: string | null | undefined,
  errorText: string | null | undefined
): string | null {
  for (const raw of [output, errorText]) {
    if (!raw || typeof raw !== "string") continue
    const trimmed = raw.trim()
    if (!trimmed) continue
    let obj: Record<string, unknown> | null = null
    try {
      const v = JSON.parse(trimmed) as unknown
      if (v && typeof v === "object" && !Array.isArray(v)) {
        obj = v as Record<string, unknown>
      }
    } catch {
      obj = extractEmbeddedJsonObject(trimmed)
    }
    if (obj) {
      // Peel Codex's live `{result, error}` wrapper so `structuredContent` is
      // reachable; a bare `task_id` at this level already ends the walk.
      const { obj: result } = peelMcpResultEnvelope(
        obj,
        (o) => typeof o.task_id === "string" || isResolvableDelegateResult(o)
      )
      const sc = result.structuredContent
      if (sc && typeof sc === "object" && !Array.isArray(sc)) {
        const id = (sc as Record<string, unknown>).task_id
        if (typeof id === "string" && id) return id
      }
      if (typeof result.task_id === "string" && result.task_id)
        return result.task_id
    }
    // Live wire: the ack message text embeds `task_id=<id>`.
    const m = trimmed.match(/task_id[=:]\s*"?([A-Za-z0-9][\w-]*)"?/)
    if (m) return m[1]
  }
  return null
}

/**
 * The broker task id a `delegate_to_agent` call was given, from what the call
 * itself carries: its ack, else the meta the broker stamped on it.
 */
export function delegateCallTaskId(call: {
  output?: string | null
  errorText?: string | null
  meta?: Record<string, unknown> | null
}): string | null {
  return (
    parseDelegateTaskId(call.output, call.errorText) ??
    parseDelegationMeta(call.meta)?.taskId ??
    null
  )
}

/**
 * Whether a (already normalized or raw) tool name denotes the multi-agent
 * `delegate_to_agent` companion tool. Matches the bare canonical name plus any
 * host-specific server-prefixed form (`mcp__<server>__delegate_to_agent`,
 * `<server>/delegate_to_agent`, `<server>.delegate_to_agent`, …).
 */
export function isDelegateToAgentToolName(name: string): boolean {
  const lower = name.toLowerCase()
  return (
    lower === "delegate_to_agent" || /[^a-z0-9]delegate_to_agent$/.test(lower)
  )
}

/**
 * Resolve the card status from the live binding / persisted meta / parsed tool
 * output, in priority order.
 *
 *   waiting (child blocked on permission) > live binding > snapshot meta
 *   > error channel > a later check's outcome > running ack > terminal outcome
 *   > output-available > starting
 */
export function resolveDelegationStatus({
  binding,
  parsedMeta,
  toolOutput,
  state,
  errorText,
  childAwaitingUser,
  ended = null,
}: {
  binding: DelegationBinding | undefined
  parsedMeta: ParsedMeta | null
  toolOutput: ParsedToolOutput | null
  state: ToolCallState | undefined
  errorText: string | null | undefined
  /** The child is parked on a permission, a question or a plan approval. */
  childAwaitingUser: boolean
  /** How the task ended, as a `get_delegation_status` check made after the
   *  call reported it (`taskEnding`). */
  ended?: { status: "ok" | "err" } | null
}): DelegationCardStatus {
  // A child awaiting a decision is blocked until the user acts; surface it
  // over the plain running state so the card cues opening "查看会话".
  if (childAwaitingUser) return "waiting"
  if (binding) return binding.status
  if (parsedMeta) return parsedMeta.status
  if (state === "output-error" || errorText) return "err"
  // A check that came back after the hand-over is newer than the ack: with no
  // binding or meta to go by (the child's record gone, a transcript from
  // elsewhere), the card would otherwise run forever.
  if (ended) return ended.status
  // Async: the parent output is a running ack while the child runs — keep
  // "running" rather than letting output-available flip the badge to "ok".
  if (toolOutput?.kind === "ack") return "running"
  if (toolOutput?.kind === "outcome") return toolOutput.isError ? "err" : "ok"
  if (state === "output-available") return "ok"
  // No binding, no meta, parent tool call not yet terminal: the sub-agent
  // connection is still being set up. Flips the instant a binding, meta, or
  // terminal output arrives.
  return "starting"
}
