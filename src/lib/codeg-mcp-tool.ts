/**
 * Parsing helpers for the codeg-mcp *workbench* companion tools — the ones that
 * report back into codeg itself rather than driving a sub-agent:
 * `get_session_info`, `task_progress`, `task_complete`, `create_automation` and
 * `create_work_task` — plus `resume_delegation`.
 *
 * `resume_delegation` is the odd one out: it revives a sub-agent, so its
 * primary renderer is `ResumedDelegationCard`, which states WHICH sub-agent
 * came back rather than echoing a task id. This module still parses it, for
 * two jobs the delegation card can't do — supplying that card's `task_id` /
 * `reason` / result text, and being the fallback when the resume was REFUSED
 * (`not_resumable`, unknown task): there is no sub-agent to draw then, only a
 * reason to read.
 *
 * The delegation trio (`delegate_to_agent` / `get_delegation_status` /
 * `cancel_delegation`), `ask_user_question` and `check_user_feedback` each own a
 * richer, purpose-built card; these five had none, so they fell through to the
 * generic tool shell and rendered as a raw argument dump under a name like
 * `"task_progress (codeg-mcp MCP Server)"`. This module resolves the one detail
 * each call is actually about (which session, which message, which verdict) plus
 * its result text, so `CodegMcpToolCard` can state it in one line.
 *
 * Both sides of the wire are host-dependent, so parsing mirrors what the
 * delegation cards already do:
 *   - ARGUMENTS may be nested under a relay's wrapper key (`arguments`,
 *     `params`, `args`, …) and may be double-encoded JSON — see
 *     `ARGS_WRAPPER_KEYS` in `delegation-card.ts`, which this walker matches.
 *   - RESULTS may arrive as the bare text, the full MCP `CallToolResult`, a
 *     codex-acp `{result, error}` envelope, or Codex's `"Wall time:…\nOutput:\n
 *     <json>"` wrap — peeled via `peelMcpResultEnvelope` /
 *     `extractEmbeddedJsonObject`.
 */

import { extractEmbeddedJsonObject } from "@/lib/embedded-json"
import { peelMcpResultEnvelope } from "@/lib/mcp-result-envelope"
import type { ToolCallState } from "@/lib/adapters/ai-elements-adapter"

/**
 * The canonical (post-`normalizeToolName`) names this module covers. Kept in
 * sync with the `*_SUFFIX_RE` rules in `tool-call-normalization.ts`, which
 * collapse every host spelling (`mcp__codeg-mcp__task_progress`,
 * `codeg-mcp/task_progress`, …) onto exactly these.
 */
export const CODEG_MCP_WORKBENCH_TOOLS = [
  "get_session_info",
  "task_progress",
  "task_complete",
  "create_automation",
  "create_work_task",
  "resume_delegation",
] as const

export type CodegMcpWorkbenchTool = (typeof CODEG_MCP_WORKBENCH_TOOLS)[number]

const TOOL_SET: ReadonlySet<string> = new Set(CODEG_MCP_WORKBENCH_TOOLS)

/** Whether `name` is one of the workbench companions, in canonical form. */
export function isCodegMcpWorkbenchTool(
  name: string
): name is CodegMcpWorkbenchTool {
  return TOOL_SET.has(name.toLowerCase().trim())
}

/** `task_complete`'s three allowed verdicts (validated companion-side). */
export type TaskVerdict = "success" | "needs_review" | "blocked"

/**
 * What the board did with a `task_progress` / `task_complete` report: the
 * companion's `{ recorded, note? }` ack (`TaskReportAck` in
 * `src-tauri/src/acp/work_task_tools.rs`).
 */
export interface TaskReportAck {
  /** Whether the report landed on the task (its timeline, or its verdict). */
  recorded: boolean
  /**
   * The companion's reason when it did not ("the task moved on to a new run",
   * …). Agent-facing English, shown as-is; `null` when none survived.
   */
  note: string | null
}

export interface CodegMcpToolModel {
  /**
   * The single argument worth stating in the collapsed row: the session id,
   * the progress message, the completion summary, the automation/task title.
   * `null` when the arguments haven't streamed yet or didn't parse.
   *
   * For `task_progress` / `task_complete` this is also the panel's body: the
   * report is the whole point of the call, and the row cuts it off at one line.
   */
  detail: string | null
  /** `task_complete` only; `null` for every other tool and for a bad verdict. */
  verdict: TaskVerdict | null
  /**
   * The `prompt` argument of `create_automation` / `create_work_task` — the
   * instruction the automation or board task will actually run. `null` for every
   * other tool.
   *
   * Surfaced because these two tools CREATE something persistent, and the prompt
   * is the one argument worth auditing: the companion's `render_authoring_result`
   * reports back id / title / folder / agent / schedule but never echoes it, so
   * without this it would be visible nowhere in the UI — a regression against the
   * generic tool shell this card replaced, which dumped every argument.
   */
  prompt: string | null
  /**
   * `resume_delegation`'s optional `reason` argument — why the run was being
   * revived. `null` for every other tool and when the LLM omitted it.
   *
   * Surfaced for the same reason as `prompt` above: it is the only free-form
   * text a resume carries, it is injected into the child's continuation
   * prompt, and nothing echoes it back in the result — so without this it
   * would be visible nowhere.
   */
  reason: string | null
  /**
   * `task_progress` / `task_complete` only: the ack, read from whichever half
   * of the result the host kept. `null` for every other tool, while the call is
   * in flight, for a failed call, and when the result is not an ack at all —
   * which `resultText` then carries verbatim.
   */
  ack: TaskReportAck | null
  /**
   * The result text, envelopes peeled. `null` while the call is in flight, and
   * when the result was an ack: that is `ack`'s to state, because what Claude
   * Code and Codex persist is the bare `{"recorded":true}`.
   */
  resultText: string | null
  status: "running" | "ok" | "err"
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function str(obj: Record<string, unknown>, key: string): string | null {
  const value = obj[key]
  if (typeof value !== "string") return null
  const trimmed = value.trim()
  return trimmed ? trimmed : null
}

// Same wrapper keys `delegation-card.ts` peels — JSON-RPC/MCP relays pack a
// call as `{name, arguments}` or `{params: {…}}`, Cursor as
// `{providerIdentifier, toolName, args}`, and some agents stash the payload
// under a generic `input`/`payload` key.
const ARGS_WRAPPER_KEYS = [
  "arguments",
  "input",
  "params",
  "payload",
  "_meta",
  "args",
] as const

/**
 * Walk to the object that actually carries this tool's arguments, peeling any
 * host wrapping (and one layer of double-encoding). `hasFields` positively
 * identifies the destination, so a wrapper key that happens to hold something
 * else is skipped rather than mistaken for the payload.
 *
 * DEEPEST match wins: a wrapper is descended BEFORE the current object is
 * accepted. That ordering matters because `create_automation`'s own `name`
 * argument collides with the `name` of the very `{name, arguments}` relay
 * envelope this walker exists to peel — accepting the outer object first would
 * label the card with the TOOL's name ("Creating automation
 * mcp__codeg-mcp__create_automation") instead of the automation's. Safe for all
 * five tools because none of their schemas
 * (`src-tauri/src/acp/delegation/tool_schema.json`) has an argument named after
 * a wrapper key, so a descent can only ever reach a real payload.
 */
function findArgs(
  value: unknown,
  hasFields: (obj: Record<string, unknown>) => boolean,
  depth = 0
): Record<string, unknown> | null {
  if (depth > 4 || value === null || value === undefined) return null
  if (typeof value === "string") {
    try {
      return findArgs(JSON.parse(value), hasFields, depth + 1)
    } catch {
      return null
    }
  }
  const obj = asRecord(value)
  if (!obj) return null
  for (const key of ARGS_WRAPPER_KEYS) {
    if (obj[key] === undefined) continue
    const found = findArgs(obj[key], hasFields, depth + 1)
    if (found) return found
  }
  return hasFields(obj) ? obj : null
}

function parseArgs(
  raw: string | null | undefined,
  hasFields: (obj: Record<string, unknown>) => boolean
): Record<string, unknown> | null {
  if (!raw || typeof raw !== "string") return null
  const trimmed = raw.trim()
  if (!trimmed) return null
  try {
    return findArgs(JSON.parse(trimmed), hasFields)
  } catch {
    return null
  }
}

/** Which argument each tool's row is about, and how to recognize its payload. */
const ARG_SPECS: Record<
  CodegMcpWorkbenchTool,
  {
    /** Keys that identify the arguments object (any one present is enough). */
    fields: readonly string[]
    /** The value the collapsed row states, read from that object. */
    detail: (args: Record<string, unknown>) => string | null
  }
> = {
  get_session_info: {
    fields: ["session_id", "sessionId"],
    detail: (args) => {
      // The companion accepts a JSON number OR a numeric string (some hosts
      // stringify integer args), so both have to render.
      const raw = args.session_id ?? args.sessionId
      if (typeof raw === "number" && Number.isFinite(raw)) return String(raw)
      if (typeof raw === "string" && raw.trim()) return raw.trim()
      return null
    },
  },
  task_progress: {
    fields: ["message"],
    detail: (args) => str(args, "message"),
  },
  task_complete: {
    // `summary` alone identifies the payload too: a `blocked` call may carry
    // only the explanation once the verdict has been read off separately.
    fields: ["verdict", "summary"],
    detail: (args) => str(args, "summary"),
  },
  create_automation: {
    fields: ["name", "cron", "prompt"],
    detail: (args) => str(args, "name"),
  },
  create_work_task: {
    fields: ["title", "prompt"],
    detail: (args) => str(args, "title"),
  },
  resume_delegation: {
    // `task_id` alone identifies the payload; the optional `reason` never
    // appears without it.
    fields: ["task_id"],
    detail: (args) => str(args, "task_id"),
  },
}

/**
 * The `task_id` argument of a `resume_delegation` call — the handle everything
 * about a resumed sub-agent is resolved by (its own tool_call_id is never a
 * delegation binding key). Exported for callers that need only this and not the
 * whole model, notably `collectDelegationSources`.
 */
export function parseResumeTaskId(
  input: string | null | undefined
): string | null {
  const args = parseArgs(input, (obj) => obj.task_id !== undefined)
  return args ? str(args, "task_id") : null
}

function parseVerdict(
  args: Record<string, unknown> | null
): TaskVerdict | null {
  const raw = args ? str(args, "verdict") : null
  return raw === "success" || raw === "needs_review" || raw === "blocked"
    ? raw
    : null
}

/** Whether `obj` is already a shape we can read a result out of. Stops the
 *  host-envelope peel at a `CallToolResult` that itself owns a `result` key. */
function isResolvableResult(obj: Record<string, unknown>): boolean {
  return Array.isArray(obj.content) || asRecord(obj.structuredContent) !== null
}

/**
 * The human-readable result text.
 *
 * Every one of these tools returns its message as `content[0].text` (the
 * companion's `render_*` helpers), so that is the preferred read; the
 * `structuredContent.note` fallback covers a host that forwarded only the
 * structured half. A result that never parses as JSON is the plain text itself
 * — which is exactly what claude-agent-acp hands over.
 */
function parseResultText(raw: string | null | undefined): string | null {
  if (!raw || typeof raw !== "string") return null
  const trimmed = raw.trim()
  if (!trimmed) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    // Not JSON. It may still be Codex's `"Wall time:…\nOutput:\n<json>"` wrap
    // around one — try the embedded scanner before settling for the raw text.
    const embedded = extractEmbeddedJsonObject(trimmed)
    return embedded ? (readResultObject(embedded) ?? trimmed) : trimmed
  }
  // Some hosts re-stringify the result exactly as they do arguments; unwrap one
  // layer of JSON-of-JSON before giving up on the structured read.
  if (typeof parsed === "string") return parseResultText(parsed)
  const obj = asRecord(parsed)
  if (!obj) return trimmed
  return readResultObject(obj) ?? trimmed
}

function readResultObject(obj: Record<string, unknown>): string | null {
  const { obj: result, hostError } = peelMcpResultEnvelope(
    obj,
    isResolvableResult
  )
  if (hostError) return hostError
  if (Array.isArray(result.content)) {
    const first = asRecord(result.content[0])
    const text = first ? str(first, "text") : null
    if (text) return text
  }
  const structured = asRecord(result.structuredContent)
  if (structured) {
    const note = str(structured, "note")
    if (note) return note
  }
  return null
}

/**
 * The texts `render_task_ack` (companion.rs) puts in `content` when the ack has
 * no note — all a host that keeps only that half (OpenCode) leaves behind.
 */
const ACK_TEXT_RECORDED = "Recorded."
const ACK_TEXT_NOT_RECORDED = "Not recorded."

function ackFrom(obj: Record<string, unknown>): TaskReportAck | null {
  return typeof obj.recorded === "boolean"
    ? { recorded: obj.recorded, note: str(obj, "note") }
    : null
}

/**
 * Read a task report's ack out of a raw result, whatever the host wrapped it in:
 * the bare structured `{"recorded":true}` (what Claude Code and Codex persist,
 * since they show the model only `structuredContent`), the full MCP
 * `CallToolResult`, a host `{result, error}` / `{Ok}` envelope, Codex's
 * `"Wall time:…\nOutput:\n<json>"` wrap, JSON-of-JSON, a bare content-block
 * array, or the companion's own `content` text.
 *
 * Positive identification only. A note-bearing plain-text result (OpenCode's
 * half of a refusal) is indistinguishable from any other text, so it returns
 * `null` and the caller shows it verbatim — never mislabelled as an ack.
 */
function readTaskAck(value: unknown, depth = 0): TaskReportAck | null {
  if (depth > 4 || value === null || value === undefined) return null
  if (typeof value === "string") {
    const text = value.trim()
    if (!text) return null
    if (text === ACK_TEXT_RECORDED) return { recorded: true, note: null }
    if (text === ACK_TEXT_NOT_RECORDED) return { recorded: false, note: null }
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      const embedded = extractEmbeddedJsonObject(text)
      return embedded ? readTaskAck(embedded, depth + 1) : null
    }
    return readTaskAck(parsed, depth + 1)
  }
  if (Array.isArray(value)) {
    const first = asRecord(value[0])
    return first ? readTaskAck(first.text, depth + 1) : null
  }
  const obj = asRecord(value)
  if (!obj) return null
  const direct = ackFrom(obj)
  if (direct) return direct
  const { obj: result, hostError } = peelMcpResultEnvelope(
    obj,
    isResolvableResult
  )
  // A failed host call carries an error string, not an ack.
  if (hostError) return null
  const structured = asRecord(result.structuredContent)
  const fromStructured = structured ? ackFrom(structured) : null
  if (fromStructured) return fromStructured
  return Array.isArray(result.content)
    ? readTaskAck(result.content, depth + 1)
    : null
}

/**
 * Resolve everything `CodegMcpToolCard` renders from a tool call's raw input,
 * raw output and lifecycle state.
 *
 * `errorText` (or an `output-error` state) always wins the status: these tools
 * report soft refusals — a disabled feature, an unresolvable folder, a report
 * with no work task to attribute it to — as ordinary `isError: false` text, so
 * an `err` badge really does mean the call itself failed.
 */
export function parseCodegMcpToolCall(params: {
  tool: CodegMcpWorkbenchTool
  input?: string | null
  output?: string | null
  errorText?: string | null
  state?: ToolCallState
}): CodegMcpToolModel {
  const spec = ARG_SPECS[params.tool]
  const args = parseArgs(params.input, (obj) =>
    spec.fields.some((field) => obj[field] !== undefined)
  )
  const isError = !!params.errorText?.trim() || params.state === "output-error"

  const authoring =
    params.tool === "create_automation" || params.tool === "create_work_task"
  const reporting =
    params.tool === "task_progress" || params.tool === "task_complete"
  const ack = reporting && !isError ? readTaskAck(params.output) : null
  const resultText = ack ? null : parseResultText(params.output)

  return {
    detail: args ? spec.detail(args) : null,
    verdict: params.tool === "task_complete" ? parseVerdict(args) : null,
    prompt: authoring && args ? str(args, "prompt") : null,
    reason:
      params.tool === "resume_delegation" && args ? str(args, "reason") : null,
    ack,
    resultText: isError ? (params.errorText?.trim() ?? resultText) : resultText,
    status: isError
      ? "err"
      : params.state === "input-available" || params.state === "input-streaming"
        ? "running"
        : "ok",
  }
}
