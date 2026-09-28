/**
 * Shared parsing + detection helpers for built-in background-task tools:
 * Claude Code's (`Bash(run_in_background)` launch → `TaskOutput` polls →
 * `TaskStop`) and Grok's (`run_terminal_command(background)` launch →
 * `get_command_or_subagent_output` polls).
 *
 * Claude Code starts a background shell with `Bash(run_in_background: true)`,
 * whose result is a launch line carrying the task id ("Command running in
 * background with ID: <id>. …"). The agent then polls with
 * `TaskOutput({task_id, block, timeout})`, whose result is an XML-tagged
 * envelope, and may finally `TaskStop({task_id})`, whose result is a JSON
 * object carrying the original command.
 *
 *   poll  → <retrieval_status>success|timeout|not_ready</retrieval_status>
 *           <task_id>…</task_id> <task_type>local_bash</task_type>
 *           <status>running|completed</status> <exit_code>0</exit_code>
 *           <output>…(ANSI shell output)…</output>
 *   stop  → {"message":"Successfully stopped task: … (<command>)",
 *           "task_id":…, "task_type":…, "command":…}
 *
 * Grok reports the same lifecycle as a JSON envelope instead — its poll's whole
 * result sits in the ACP `rawOutput`, which both paths hand over verbatim
 * (`parsers/grok.rs::grok_task_output_envelope`, shared with the live path):
 *
 *   poll  → {"type":"TaskOutput","Result":{task_id, command, status,
 *            exit_code, output, …}}   (also `MultiResult` / `TaskNotFound`)
 *   launch→ "Background task <id> started"
 *
 * The same task is polled repeatedly (first timeout/running, then
 * success/completed), so the renderer collapses consecutive polls of one task
 * id into a single lifecycle card — mirroring the delegation-status group
 * (`@/lib/delegation-status`). Codeg owns only the rendering: the backend
 * (`parsers/claude.rs`, `parsers/grok.rs`) passes the tool-result text through
 * verbatim, so all parsing lives here (same convention as
 * `delegation-status.ts`).
 */

import { isUnsettledToolCall } from "@/lib/tool-call-lifecycle"
import type { AdaptedToolCallPart } from "@/lib/adapters/ai-elements-adapter"

export interface BackgroundTaskEnvelope {
  /** `poll` = a `TaskOutput` retrieval; `stop` = a `TaskStop` acknowledgement. */
  kind: "poll" | "stop"
  /** Whether THIS poll fetched fresh data: success | timeout | not_ready. */
  retrievalStatus: string | null
  taskId: string | null
  /** e.g. `local_bash`, `local_workflow`. */
  taskType: string | null
  /** Task run state: running | completed (poll); `stopped` synthesized for stop. */
  status: string | null
  exitCode: number | null
  /** Shell output (may contain ANSI). Poll only. */
  output: string | null
  /** The original command. Stop only. */
  command: string | null
  /** The stop acknowledgement message. Stop only. */
  message: string | null
}

/** Read a single `<name>…</name>` tag (non-greedy, first match). */
function xmlTag(text: string, name: string): string | null {
  const match = text.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, "i"))
  return match ? match[1].trim() : null
}

/** Read `<output>…</output>`, greedy to the LAST close so shell output that
 *  itself contains `<…>` fragments isn't truncated. Outer wrapping newlines
 *  (the envelope's own formatting) are stripped; inner content is preserved. */
function xmlOutputTag(text: string): string | null {
  const match = text.match(/<output>([\s\S]*)<\/output>/i)
  if (!match) return null
  return match[1].replace(/^\r?\n/, "").replace(/\r?\n[ \t]*$/, "")
}

function parsePollEnvelope(text: string): BackgroundTaskEnvelope | null {
  const retrievalStatus = xmlTag(text, "retrieval_status")
  const taskType = xmlTag(text, "task_type")
  const taskId = xmlTag(text, "task_id")
  const status = xmlTag(text, "status")
  // Require at least one of the envelope-defining tags so arbitrary text that
  // merely contains a stray `<task_id>` isn't misread as a poll.
  if (
    retrievalStatus == null &&
    taskType == null &&
    !(taskId != null && status != null)
  ) {
    return null
  }
  const exitRaw = xmlTag(text, "exit_code")
  const exitCode =
    exitRaw != null && /^-?\d+$/.test(exitRaw) ? parseInt(exitRaw, 10) : null
  return {
    kind: "poll",
    retrievalStatus,
    taskId,
    taskType,
    status,
    exitCode,
    output: xmlOutputTag(text),
    command: null,
    message: null,
  }
}

function parseStopEnvelope(text: string): BackgroundTaskEnvelope | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    return null
  const obj = parsed as Record<string, unknown>
  const message = typeof obj.message === "string" ? obj.message : null
  const command = typeof obj.command === "string" ? obj.command : null
  const taskId = typeof obj.task_id === "string" ? obj.task_id : null
  const taskType = typeof obj.task_type === "string" ? obj.task_type : null
  // Strict: must be a stop acknowledgement, so other JSON tool results aren't
  // hijacked. The phrase is the primary signal; the id+command+message shape is
  // a defensive fallback for wording drift.
  const looksLikeStop =
    (message != null && /successfully stopped task/i.test(message)) ||
    (taskId != null && command != null && message != null && taskType != null)
  if (!looksLikeStop) return null
  return {
    kind: "stop",
    retrievalStatus: null,
    taskId,
    taskType,
    status: "stopped",
    exitCode: null,
    output: null,
    command,
    message,
  }
}

/** Statuses Grok reports for a task that was ended rather than allowed to
 *  finish — mapped to the `stop` kind so the row reads "stopped". */
const GROK_STOPPED_STATUSES: ReadonlySet<string> = new Set([
  "killed",
  "stopped",
  "cancelled",
  "canceled",
])

/** Map one Grok `TaskOutputResult` onto the shared envelope. `status` is passed
 *  through verbatim (lower-cased) — `deriveBackgroundBadge` reads it. */
function grokResultToEnvelope(
  result: Record<string, unknown>
): BackgroundTaskEnvelope | null {
  const taskId = typeof result.task_id === "string" ? result.task_id : null
  const command = typeof result.command === "string" ? result.command : null
  const status =
    typeof result.status === "string"
      ? result.status.trim().toLowerCase()
      : null
  // Require something identifying so a stray `{type:"TaskOutput"}` isn't read
  // as a real (blank) task row.
  if (taskId == null && command == null && status == null) return null
  const output = typeof result.output === "string" ? result.output : null
  const exitCode =
    typeof result.exit_code === "number" && Number.isFinite(result.exit_code)
      ? result.exit_code
      : null
  return {
    kind: status != null && GROK_STOPPED_STATUSES.has(status) ? "stop" : "poll",
    retrievalStatus: null,
    taskId,
    taskType: null,
    status,
    exitCode,
    output,
    command,
    message: null,
  }
}

/**
 * Collect the result objects out of a Grok `TaskOutput` envelope. `Result` is
 * the single-task variant (the only one captured from a real session);
 * `MultiResult` wraps several, and `TaskNotFound` carries none. The MultiResult
 * walk is deliberately shape-tolerant — it takes the first array of objects it
 * finds — because its field names aren't pinned by any capture we have.
 */
function grokResultObjects(
  envelope: Record<string, unknown>
): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = []
  const push = (value: unknown) => {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      out.push(value as Record<string, unknown>)
    }
  }
  push(envelope.Result)
  const multi = envelope.MultiResult
  if (multi && typeof multi === "object" && !Array.isArray(multi)) {
    for (const value of Object.values(multi as Record<string, unknown>)) {
      if (Array.isArray(value)) {
        value.forEach(push)
        break
      }
    }
  }
  return out
}

/**
 * Map Grok's `SubagentCompleted` `rawOutput` — the sibling `ToolOutput`
 * variant a `get_command_or_subagent_output` poll returns for a background
 * SUB-AGENT (grok 0.2.11x; 0.2.9x instead folded subagents into a
 * `TaskOutput.Result` whose `command` reads `[subagent:<type>] <description>`)
 * — onto the shared envelope. Its fields sit flat on the envelope object
 * (`subagent_id`, `subagent_type`, `tool_calls`, `turns`, `duration_ms`,
 * `worktree_path`, …); the output text's exact field name isn't pinned by a
 * capture, so read the plausible spellings tolerantly.
 */
function grokSubagentCompletedToEnvelope(
  envelope: Record<string, unknown>
): BackgroundTaskEnvelope | null {
  const str = (v: unknown): string | null =>
    typeof v === "string" && v.length > 0 ? v : null
  const taskId = str(envelope.subagent_id)
  const status = str(envelope.status)?.trim().toLowerCase() ?? null
  const output = str(envelope.output) ?? str(envelope.result)
  if (taskId == null && status == null && output == null) return null
  const subagentType = str(envelope.subagent_type)
  const description = str(envelope.description)
  // Mirror 0.2.9x's command label so both wire eras render the same row title.
  const label = subagentType ? `[subagent:${subagentType}]` : null
  const command =
    label && description ? `${label} ${description}` : (label ?? description)
  return {
    kind: status != null && GROK_STOPPED_STATUSES.has(status) ? "stop" : "poll",
    retrievalStatus: null,
    taskId,
    taskType: "subagent",
    status,
    exitCode: null,
    output,
    command,
    message: null,
  }
}

/** Statuses CodeBuddy reports for an ended task, mapped to the `stop` kind so
 *  the row reads "stopped" (same convention as `GROK_STOPPED_STATUSES`). */
const CODEBUDDY_STOPPED_STATUSES: ReadonlySet<string> = new Set([
  "cancelled",
  "canceled",
  "killed",
])

/** The `<system-reminder data-role="tool-hint">…</system-reminder>` block
 *  CodeBuddy appends to a STILL-RUNNING snapshot ("do NOT poll TaskOutput in a
 *  loop") — addressed to the model, not the reader. */
const CODEBUDDY_TOOL_HINT_RE = /<system-reminder\b[\s\S]*?<\/system-reminder>/gi

/** `--- RESULT ---` separates CodeBuddy's agent snapshot header (+ the `Prompt:`
 *  / `Response:` echoes) from the worker's actual report. */
const CODEBUDDY_RESULT_SEPARATOR = "--- RESULT ---"

/** Read `Label: value` off `line`, or `null` when it doesn't match. */
function labeledLine(line: string | undefined, label: string): string | null {
  if (line == null) return null
  const prefix = `${label}: `
  if (!line.startsWith(prefix)) return null
  const value = line.slice(prefix.length).trim()
  return value.length > 0 ? value : null
}

function cleanCodeBuddyBody(body: string): string | null {
  const cleaned = body.replace(CODEBUDDY_TOOL_HINT_RE, "").trim()
  return cleaned.length > 0 ? cleaned : null
}

/**
 * Parse a CodeBuddy `TaskOutput` snapshot — a plain-text report, not an XML or
 * JSON envelope, so neither of the shapes above claimed it. Without this the
 * poll fell through to `record(poll, null)`: the row rendered a permanent
 * "running" badge with NO output, silently dropping the worker's report.
 *
 * Two shapes, both built line-by-line by CodeBuddy's `TaskOutputTool`
 * (`buildAgentTaskOutputLines` / `executeBackgroundShellTask`):
 *
 *   agent  → `Task ID: …` / `Status: …` / (Duration, Started, Ended, Agent Type,
 *            Task ID (for resume)) / `Prompt:` … / `Response:` … /
 *            `--- RESULT ---` / <report>
 *   shell  → `Shell ID: …` / `Command: …` / `Status: …` / `Duration: …` /
 *            `Timestamp: …` / `Stdout (full):` … / `Stderr (full):` …
 *
 * The agent shape's anchor is its first two lines, which the producer emits
 * unconditionally and adjacently (`[\`Task ID: ${id}\`, \`Status: ${status}\`]`)
 * with a generated single-line id. The shell shape anchors on its whole
 * seven-line header instead, and only parses when that header is locatable with
 * certainty — see [`shellHeaderIsUnambiguous`] for why a multiline command is
 * left unparsed rather than guessed at. Both anchors are strict enough that
 * ordinary tool output can't be hijacked into the background lane by
 * `isBackgroundTaskToolCall`.
 *
 * The agent shape deliberately shows only the `--- RESULT ---` tail: the
 * `Response:` section above it repeats the same report verbatim, and `Prompt:`
 * echoes the dispatch. `taskType: "subagent"` routes the report through the
 * prose renderer (it is Markdown, not a shell stream) — the same lane Grok's
 * sub-agent polls use.
 */
function parseCodeBuddySnapshot(text: string): BackgroundTaskEnvelope | null {
  const lines = text.split("\n")
  const status = (raw: string | null) => raw?.trim().toLowerCase() ?? null
  const kindFor = (s: string | null): "poll" | "stop" =>
    s != null && CODEBUDDY_STOPPED_STATUSES.has(s) ? "stop" : "poll"

  const agentId = labeledLine(lines[0], "Task ID")
  if (agentId != null) {
    const agentStatus = status(labeledLine(lines[1], "Status"))
    if (agentStatus == null) return null
    const separator = lines.indexOf(CODEBUDDY_RESULT_SEPARATOR)
    const body = lines
      .slice(
        separator >= 0
          ? separator + 1
          : // No separator: a team-member snapshot, whose whole body is the
            // note that follows the two header lines.
            2
      )
      .join("\n")
    return {
      kind: kindFor(agentStatus),
      retrievalStatus: null,
      taskId: agentId,
      taskType: "subagent",
      status: agentStatus,
      exitCode: null,
      output: cleanCodeBuddyBody(body),
      command: null,
      message: null,
    }
  }

  const shellId = labeledLine(lines[0], "Shell ID")
  if (shellId == null) return null
  const command = labeledLine(lines[1], "Command")
  if (command == null || !shellHeaderIsUnambiguous(lines)) return null
  const shellStatus = status(labeledLine(lines[2], "Status"))
  return {
    kind: kindFor(shellStatus),
    retrievalStatus: null,
    taskId: shellId,
    taskType: "local_bash",
    status: shellStatus,
    // CodeBuddy's shell snapshot carries no exit code — leaving it null keeps
    // `deriveBackgroundBadge` from inventing a failure.
    exitCode: null,
    // Everything from the `Stdout (…)` line on: stdout AND stderr, in the order
    // the tool wrote them.
    output: cleanCodeBuddyBody(lines.slice(6).join("\n")),
    command,
    message: null,
  }
}

/**
 * Whether a shell snapshot's header can be located with CERTAINTY: the run sits
 * at its fixed offset (line 2, right after `Shell ID:` and a single-line
 * `Command:`) AND occurs nowhere else in the text.
 *
 * Both halves are load-bearing. CodeBuddy interpolates the submitted command
 * into `Command:` verbatim and unescaped (`title: task.originalCommand`), so a
 * MULTILINE command pushes the header down by an unknown amount, and since the
 * command and the captured output are BOTH arbitrary text, either one can
 * reproduce the run. That makes the boundary undecidable by any scan: searching
 * forward adopts a look-alike inside the command (a heredoc is enough),
 * searching backward adopts one inside stdout. Either mistake truncates the
 * command AND reports a status lifted out of unrelated text, which is wrong
 * data rather than merely absent data.
 *
 * Requiring UNIQUENESS is what turns the undecidable case into an honest
 * abstention: whenever a second candidate exists the snapshot is ambiguous, so
 * `parseCodeBuddySnapshot` claims nothing and the poll renders as the generic
 * tool call it did before this parser existed. The cost is abstaining on a
 * snapshot whose captured output happens to contain the full run as well, which
 * is indistinguishable from a forged header by construction.
 */
function shellHeaderIsUnambiguous(lines: string[]): boolean {
  if (!shellHeaderRunAt(lines, 2)) return false
  for (let i = 3; i < lines.length; i++) {
    if (shellHeaderRunAt(lines, i)) return false
  }
  return true
}

/**
 * Whether `lines[i]` opens the five-line run that closes a shell snapshot's
 * header: `Status:` / `Duration:` / `Timestamp:` / blank / a `Stdout`-prefixed
 * line. `executeBackgroundShellTask` emits all five unconditionally and
 * adjacently (every branch ends in a `Stdout` line: `Stdout (full):`,
 * `Stdout (filtered):`, or `Stdout: (no output)`).
 */
function shellHeaderRunAt(lines: string[], i: number): boolean {
  const blank = lines[i + 3]
  return (
    (lines[i] ?? "").startsWith("Status: ") &&
    (lines[i + 1] ?? "").startsWith("Duration: ") &&
    (lines[i + 2] ?? "").startsWith("Timestamp: ") &&
    blank != null &&
    blank.trim() === "" &&
    (lines[i + 4] ?? "").startsWith("Stdout")
  )
}

/** Parse a Grok `get_command_or_subagent_output` result. Strict on the `type`
 *  discriminator so other JSON tool output is never hijacked. */
function parseGrokTaskOutputEnvelopes(text: string): BackgroundTaskEnvelope[] {
  if (!text.startsWith("{")) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    // A truncated envelope (an enormous log) degrades to the generic card
    // rather than rendering a half-parsed task.
    return []
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return []
  const envelope = parsed as Record<string, unknown>
  if (envelope.type === "SubagentCompleted") {
    const single = grokSubagentCompletedToEnvelope(envelope)
    return single ? [single] : []
  }
  if (envelope.type !== "TaskOutput") return []
  return grokResultObjects(envelope)
    .map(grokResultToEnvelope)
    .filter((e): e is BackgroundTaskEnvelope => e !== null)
}

/** Every task reported by one background-task tool result: a single envelope for
 *  Claude Code's poll/stop and CodeBuddy's plain-text snapshot shapes, and one
 *  per task for Grok's `TaskOutput` (whose `MultiResult` variant can cover
 *  several). Empty when the text is none of them (callers fall back to generic
 *  rendering). */
export function parseBackgroundTaskEnvelopes(
  text: string | null | undefined
): BackgroundTaskEnvelope[] {
  const raw = text?.trim()
  if (!raw) return []
  const single =
    parsePollEnvelope(raw) ??
    parseStopEnvelope(raw) ??
    parseCodeBuddySnapshot(raw)
  if (single) return [single]
  return parseGrokTaskOutputEnvelopes(raw)
}

/** Parse a background-task tool result into its structured envelope, or `null`
 *  when the text is none of the recognized shapes (callers fall back to generic
 *  rendering). The FIRST task when a result covers several. */
export function parseBackgroundTaskEnvelope(
  text: string | null | undefined
): BackgroundTaskEnvelope | null {
  return parseBackgroundTaskEnvelopes(text)[0] ?? null
}

const LAUNCH_RE = /Command running in background with ID:\s*([A-Za-z0-9_-]+)/i
/** Grok's `run_terminal_command(background: true)` acknowledgement. */
const GROK_LAUNCH_RE = /Background task\s+([A-Za-z0-9_-]+)\s+started/i

/** Recognize a background launch result and pull the task id. Lets the command
 *  card flag itself as a background launch. */
export function parseBackgroundLaunch(
  text: string | null | undefined
): { taskId: string } | null {
  if (!text) return null
  const match = text.match(LAUNCH_RE) ?? text.match(GROK_LAUNCH_RE)
  return match ? { taskId: match[1] } : null
}

const BACKGROUND_TASK_NAMES: ReadonlySet<string> = new Set([
  "taskoutput",
  "taskstop",
  "task_output",
  "task_stop",
])

function parseInputObject(
  input: string | null | undefined
): Record<string, unknown> | null {
  if (!input) return null
  try {
    const obj = JSON.parse(input)
    return obj && typeof obj === "object" && !Array.isArray(obj)
      ? (obj as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

/** A poll's input shape — Claude Code's `{task_id, block?, timeout?}` or Grok's
 *  `{task_ids: [...], timeout_ms}`. The `block`/`timeout`/`timeout_ms`
 *  requirement is what distinguishes them from `cancel_delegation` / `TaskStop`
 *  (bare `{task_id}`) and `get_delegation_status` (`{task_ids, wait_ms}`);
 *  `subagent_type` is excluded so real sub-agent `Agent`/`Task` calls never
 *  match. Catches the live in-flight poll before its output (and thus its
 *  envelope) has arrived. */
function inputIsBackgroundPoll(input: string | null | undefined): boolean {
  const obj = parseInputObject(input)
  if (!obj) return false
  if ("subagent_type" in obj) return false
  if (typeof obj.task_id === "string" && obj.task_id.length > 0) {
    return "block" in obj || "timeout" in obj
  }
  return (
    Array.isArray(obj.task_ids) &&
    obj.task_ids.length > 0 &&
    obj.task_ids.every((id) => typeof id === "string") &&
    "timeout_ms" in obj
  )
}

/**
 * Whether a tool-call part is a background-task poll/stop. True when ANY holds:
 * the raw tool name is `TaskOutput`/`TaskStop` (Claude Code's historical path);
 * the output parses as a background-task envelope (covers Claude's live `task`
 * alias, Grok's `TaskOutput` JSON, and any naming); or the input is a poll shape
 * (covers the live in-flight poll). Deliberately does NOT match real sub-agent
 * `Agent` calls (`subagent_type`), `get_delegation_status` (`task_ids` +
 * `wait_ms`), or `cancel_delegation` (bare `{task_id}`).
 *
 * Grok's `get_command_or_subagent_output` is intentionally absent from
 * `BACKGROUND_TASK_NAMES`: the same tool also polls sub-agents, whose result is
 * a different payload per era — `SubagentCompleted` (0.2.11x, parsed into this
 * lane by `grokSubagentCompletedToEnvelope`) or a `TaskOutput.Result` labeled
 * `[subagent:<type>]` (0.2.9x). Matching on the envelope (plus the in-flight
 * input shape) means a settled poll is claimed by what it actually returned,
 * and an unknown-shaped result falls back to generic rendering.
 */
export function isBackgroundTaskToolCall(part: AdaptedToolCallPart): boolean {
  if (BACKGROUND_TASK_NAMES.has(part.toolName.trim().toLowerCase())) return true
  if (
    parseBackgroundTaskEnvelope(part.output ?? part.errorText ?? null) !== null
  ) {
    return true
  }
  if (!inputIsBackgroundPoll(part.input)) return false
  // The input shape alone cannot tell a background-command poll from a sub-agent
  // poll — Grok's `get_command_or_subagent_output` does both with identical
  // args. So the input shape only claims a call that is STILL IN FLIGHT (its
  // documented purpose: render the live card in the lane it will settle into).
  // Once settled, the envelope check above is the sole authority: a recognized
  // result (`TaskOutput`, flat `SubagentCompleted`) claims the row, while an
  // unknown-shaped or absent result (an older backend that dropped the
  // envelope) falls back to generic rendering instead of showing a permanently
  // "running" background row. Claude Code's own polls are unaffected: they are
  // claimed by name.
  return isUnsettledToolCall(part)
}

export type BackgroundTaskBadge = "running" | "completed" | "failed" | "stopped"

/** One resolved task row for the card: the latest poll's outcome plus the
 *  freshest output/command gathered across every poll of that task id. */
export interface BackgroundTaskRow {
  key: string
  taskId: string | null
  taskType: string | null
  badge: BackgroundTaskBadge
  /** `true` when the latest poll is still in flight (no result yet) → spinner. */
  isInFlight: boolean
  exitCode: number | null
  output: string | null
  command: string | null
  /** Number of polls collapsed into this row (the `×N` hint). */
  pollCount: number
  /** This row is a Grok SUB-AGENT, not a background shell command. Its output is
   *  a prose report (Markdown), so the card renders it as such instead of
   *  routing it through the ANSI terminal panel. */
  isSubagent: boolean
}

/** `[subagent:<type>] <description>` — the pseudo-command Grok 0.2.9x gives a
 *  sub-agent's `TaskOutput.Result`, and the label 0.2.11x's flat
 *  `SubagentCompleted` is mapped onto (`grokSubagentCompletedToEnvelope`). */
const GROK_SUBAGENT_COMMAND_PREFIX = "[subagent:"

/**
 * Whether a row describes a sub-agent rather than a background shell command.
 * `taskType` is the direct signal (set by the `SubagentCompleted` mapping); the
 * command prefix covers the `TaskOutput.Result` era, which carries no type.
 */
function isSubagentRow(
  taskType: string | null,
  command: string | null
): boolean {
  if (taskType === "subagent") return true
  return command?.trimStart().startsWith(GROK_SUBAGENT_COMMAND_PREFIX) === true
}

/**
 * Drop the machine-facing scaffolding Grok appends to a POLLED sub-agent
 * result: `<subagent_meta>id=…, tool_calls=1, …</subagent_meta>` and
 * `<subagent_result>subagent_id: …\nTo continue this subagent's conversation,
 * use resume_from="…"</subagent_result>`. Both are addressed to the parent
 * model (the numbers are already on the Agent capsule, and `resume_from` is a
 * tool argument), and neither appears in the `subagent_finished` notification's
 * own `output` — so leaving them in only leaks prompt plumbing into the UI.
 *
 * Anything the tags don't cover is returned verbatim, so an output that never
 * had them (every non-Grok background task) is untouched.
 */
export function stripGrokSubagentScaffolding(
  output: string | null
): string | null {
  if (!output) return output
  const stripped = output
    .replace(/<subagent_meta>[\s\S]*?<\/subagent_meta>/gi, "")
    .replace(/<subagent_result>[\s\S]*?<\/subagent_result>/gi, "")
  if (stripped === output) return output
  // Collapse the blank lines the removal leaves behind, then trim the trailing
  // gap — the tags always sit at the end of the report.
  return stripped.replace(/\n{3,}/g, "\n\n").trimEnd()
}

function inputTaskId(input: string | null | undefined): string | null {
  const obj = parseInputObject(input)
  if (!obj) return null
  if (typeof obj.task_id === "string" && obj.task_id.length > 0) {
    return obj.task_id
  }
  // Grok polls by list; a single-task poll still identifies its row, which is
  // what lets an in-flight poll merge into the same row as its settled sibling.
  if (Array.isArray(obj.task_ids) && obj.task_ids.length === 1) {
    const [id] = obj.task_ids
    if (typeof id === "string" && id.length > 0) return id
  }
  return null
}

function isInFlightState(part: AdaptedToolCallPart): boolean {
  return part.state === "input-available" || part.state === "input-streaming"
}

function deriveBackgroundBadge(
  envelope: BackgroundTaskEnvelope | null,
  part: AdaptedToolCallPart
): BackgroundTaskBadge {
  if (envelope?.kind === "stop") return "stopped"
  // Grok reports the outcome in `status` itself; Claude Code only ever says
  // running/completed, so this is inert for it. Checked before `completed` so a
  // failure with no exit code (a spawn error) doesn't read as success.
  if (envelope?.status === "failed") return "failed"
  if (envelope?.status === "completed") {
    return envelope.exitCode != null && envelope.exitCode !== 0
      ? "failed"
      : "completed"
  }
  // An errored poll with no clean "completed" envelope is a failure.
  if (
    part.state === "output-error" ||
    (part.errorText && part.errorText.trim() !== "")
  ) {
    return "failed"
  }
  // running / timeout / not_ready / no envelope yet → still running.
  return "running"
}

interface ParsedBackgroundPoll {
  poll: AdaptedToolCallPart
  envelope: BackgroundTaskEnvelope | null
}

/**
 * Group a run of background-task polls into one row per task id. Mirrors
 * `buildDelegationTaskRows`: a poll is attributed to a task by its envelope's
 * `task_id` (falling back to the call input's `task_id`), so a task polled N
 * times shows one row with its latest outcome, and parallel tasks (interleaved
 * polls) surface as one row each. First-appearance order is preserved.
 */
export function buildBackgroundTaskRows(
  polls: AdaptedToolCallPart[]
): BackgroundTaskRow[] {
  const order: string[] = []
  const byKey = new Map<
    string,
    { taskId: string | null; entries: ParsedBackgroundPoll[] }
  >()
  const record = (
    poll: AdaptedToolCallPart,
    envelope: BackgroundTaskEnvelope | null
  ) => {
    const taskId = envelope?.taskId ?? inputTaskId(poll.input) ?? null
    // Drop an unsettled poll that carries no identity AND no output yet — a live
    // `TaskOutput` whose `task_id` hasn't streamed onto the wire. claude-agent-acp
    // emits an arg-less initial `tool_call` (rawInput `{}`) and fills the real
    // args only on a later update, so a still-blocking poll parses to no envelope
    // and no input id. Each such re-poll would otherwise render as its own
    // anonymous "background task running" row, stacking identical duplicates of
    // the same wait; it folds into its task's row once the id resolves (and the
    // settled transcript, whose polls always carry the id, is unaffected).
    // `isUnsettledToolCall` (not a bare live-state check) also covers an orphan
    // promoted into `localTurns` at COMPLETE_TURN — output-available yet never
    // settled — which would otherwise re-stack after the turn completes.
    // Mirrors `buildDelegationTaskRows`.
    if (taskId == null && envelope == null && isUnsettledToolCall(poll)) {
      return
    }
    const key = taskId ?? `__bg__:${poll.toolCallId}`
    let entry = byKey.get(key)
    if (!entry) {
      entry = { taskId, entries: [] }
      byKey.set(key, entry)
      order.push(key)
    }
    entry.entries.push({ poll, envelope })
  }

  for (const poll of polls) {
    // One poll can report several tasks (Grok's `MultiResult`), so each
    // envelope is attributed to its own row.
    const envelopes = parseBackgroundTaskEnvelopes(
      poll.output ?? poll.errorText ?? null
    )
    if (envelopes.length === 0) {
      record(poll, null)
      continue
    }
    for (const envelope of envelopes) record(poll, envelope)
  }

  return order.map((key) => {
    const entry = byKey.get(key)!
    const latest = entry.entries[entry.entries.length - 1]
    const env = latest.envelope
    // The terminal poll carries the full output; fall back to the last poll that
    // captured any so an in-flight final poll doesn't blank a completed run.
    let output: string | null = null
    let command: string | null = null
    let taskType: string | null = null
    for (const { envelope } of entry.entries) {
      if (envelope?.output != null && envelope.output.trim() !== "") {
        output = envelope.output
      }
      if (envelope?.command) command = envelope.command
      if (envelope?.taskType) taskType = envelope.taskType
    }
    const isSubagent = isSubagentRow(taskType, command)
    return {
      key,
      taskId: entry.taskId,
      taskType,
      badge: deriveBackgroundBadge(env, latest.poll),
      isInFlight:
        isInFlightState(latest.poll) && (env == null || env.output == null),
      exitCode: env?.exitCode ?? null,
      output: isSubagent ? stripGrokSubagentScaffolding(output) : output,
      command,
      pollCount: entry.entries.length,
      isSubagent,
    }
  })
}
