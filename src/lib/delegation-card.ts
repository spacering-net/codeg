/**
 * Shared parsing + state-resolution helpers for `delegate_to_agent`
 * delegation cards.
 *
 * Extracted from `DelegatedSubThread` so the inline message-stream card AND
 * the top-right sub-agent overlay resolve the same agent type / task / status /
 * child ids from the exact same logic — one source of truth, no drift.
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
  task: string | null
  workingDir: string | null
  /** Session mode the parent pinned for this one delegation, from the
   *  `permission_mode` argument. `null` when omitted, which means the child
   *  used the configured per-agent default. */
  permissionMode: string | null
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
  }
}

const EMPTY_PARSED_INPUT: ParsedInput = {
  agentType: null,
  task: null,
  workingDir: null,
  permissionMode: null,
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
    typeof obj.permission_mode === "string"
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
    task: typeof obj.task === "string" ? obj.task : null,
    workingDir: typeof obj.working_dir === "string" ? obj.working_dir : null,
    permissionMode:
      typeof obj.permission_mode === "string" && obj.permission_mode.trim()
        ? obj.permission_mode.trim()
        : null,
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
  | {
      kind: "ack"
      childConversationId: number | null
      agentType?: AgentType | null
      errorCode?: string | null
    }
  | {
      kind: "outcome"
      text: string
      isError: boolean
      childConversationId: number | null
      agentType?: AgentType | null
      errorCode?: string | null
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
        return { kind: "ack", childConversationId, agentType, errorCode }
      case "completed":
        return {
          kind: "outcome",
          text: typeof obj.text === "string" ? obj.text : "",
          isError: false,
          childConversationId,
          agentType,
          errorCode,
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
        }
      }
      default:
        return { kind: "ack", childConversationId, agentType, errorCode }
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
 * output, in priority order. Pure mirror of the resolution that used to live
 * inline in `DelegatedSubThread`.
 *
 *   waiting (child blocked on permission) > live binding > snapshot meta
 *   > error channel > running ack > terminal outcome > output-available > starting
 */
export function resolveDelegationStatus({
  binding,
  parsedMeta,
  toolOutput,
  state,
  errorText,
  childAwaitingPermission,
}: {
  binding: DelegationBinding | undefined
  parsedMeta: ParsedMeta | null
  toolOutput: ParsedToolOutput | null
  state: ToolCallState | undefined
  errorText: string | null | undefined
  childAwaitingPermission: boolean
}): DelegationCardStatus {
  // A child awaiting a permission decision is blocked until the user acts;
  // surface it over the plain running state so the card cues opening "查看会话".
  if (childAwaitingPermission) return "waiting"
  if (binding) return binding.status
  if (parsedMeta) return parsedMeta.status
  if (state === "output-error" || errorText) return "err"
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
