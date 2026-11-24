/**
 * Shared parsing + status-resolution helpers for the codeg-mcp delegation
 * companion tools (`get_delegation_status` / `cancel_delegation`).
 *
 * Extracted from `delegation-status-card.tsx` so both the single card and the
 * merged group card (`delegation-status-group-card.tsx`) resolve a poll's
 * task id, report and badge through one implementation.
 *
 * Status resolution degrades gracefully; precision hinges on the HOST, not on
 * live-vs-persisted. Neither the ACP live wire nor our persisted tool-result
 * model carries `structuredContent` as a field — the helpers only ever see the
 * result TEXT plus an `is_error` flag — so:
 *   - hosts that echo the full MCP `CallToolResult` envelope (or the bare
 *     report JSON) as that text — e.g. Codex's "Wall time:…\nOutput:\n<json>" —
 *     let us recover the structured `DelegationTaskReport`, so badge, duration
 *     and result text are precise;
 *   - hosts that surface only `CallToolResult.content` text — e.g. Claude Code
 *     via claude-agent-acp — give no structured fields, so the badge is derived
 *     from the tool-call state / `is_error`, with no duration.
 *
 * On top of that, a host may wrap the result in an envelope of its own — Codex's
 * live wire sends `{result: <CallToolResult>, error: null}`. `parseResultObject`
 * peels those first (see `@/lib/mcp-result-envelope`), so the shapes below only
 * ever face the result itself.
 */

import { progressFromReport, type StepProgress } from "@/lib/activity/progress"
import { extractEmbeddedJsonObject } from "@/lib/embedded-json"
import { peelMcpResultEnvelope } from "@/lib/mcp-result-envelope"
import { isUnsettledToolCall } from "@/lib/tool-call-lifecycle"
import type {
  AdaptedToolCallPart,
  ToolCallState,
} from "@/lib/adapters/ai-elements-adapter"

/**
 * Visual badge states.
 *
 * `checked` is the neutral, non-spinning state for a poll that RETURNED while
 * the task was still running — a stale snapshot, not live activity. The live
 * spinner (`running`) is reserved for a poll that is still in flight (no
 * result yet). This is what lets a superseded / settled "running" poll stop
 * spinning once the agent has moved past it.
 */
export type BadgeStatus =
  | "starting"
  | "running"
  | "waiting"
  | "ok"
  | "err"
  | "checked"

const TASK_STATUSES = [
  "running",
  "completed",
  "failed",
  "canceled",
  "unknown",
] as const
export type TaskStatus = (typeof TASK_STATUSES)[number]

/** What kind of user decision a blocked sub-agent is parked on. Mirrors Rust
 *  `BlockedKind`; an unrecognized value degrades to a bare "blocked". */
export type BlockedKind = "permission" | "question" | "plan_approval"

export type StatusReport = {
  status: TaskStatus | null
  /** The report's own `task_id` — recovered when the structured report parsed.
   *  Lets a grouper fall back to it when the call input lost the id. */
  taskId: string | null
  /** Result/message text to reveal on expand (verbatim for the live-wire shape). */
  text: string | null
  /** Wire-stable error code for a failed/canceled report (badge specificity). */
  errorCode: string | null
  /** Task execution time in ms — set only for terminal cached results. */
  durationMs: number | null
  /** Set only on a `running` report whose sub-agent is parked on a user
   *  decision (Rust `DelegationTaskReport.blocked_on`). Deliberately NOT a
   *  `status` value: the backend keeps `status: "running"` so every consumer
   *  that predates this field still resolves the poll correctly. `null` means
   *  either "genuinely working" or "host dropped structuredContent" — the
   *  message text's own blocked line covers the latter. */
  blockedOn: BlockedKind | null
  /** How far the sub-agent had got when this report was taken (Rust
   *  `DelegationTaskReport.progress`): live on a running report, final on a
   *  terminal one. `null` when the report predates the field or the sub-agent
   *  called no tool. */
  progress: StepProgress | null
}

/**
 * The verbatim message(s) `get_delegation_status` returns for a still-running
 * task (`running_report` / `attach_live_reply` in
 * `src-tauri/src/acp/delegation/broker.rs`). Hosts that persist only
 * `CallToolResult.content` text drop `structuredContent` — notably Claude Code,
 * which keeps only `content[*].text`. On that path this text is the ONLY signal
 * that the poll returned "still running" rather than "completed", so recognize
 * it and synthesize a `running` status — otherwise the badge degrades to a
 * false `ok` ("done") for a task still in flight. These are backend protocol
 * strings (English-only), never localized UI copy.
 *
 * The running marker is the STANDALONE first line `"Running."`. The optional
 * second line is one of two fixed protocol prefixes — the live hint
 * (`"Latest sub-agent reply: <…>"`) or the blocked note
 * (`"Awaiting your decision: <…>"`, `attach_blocked`) — and what follows either
 * one is child-controlled text we deliberately never match against. Anchoring
 * to the full first line plus a known second-line prefix, instead of
 * prefix-matching arbitrary output, is what keeps a *completed* result whose
 * text merely starts with "Running. …" from being misread as still-running. The
 * legacy long sentinel is still accepted so already-persisted historical rows
 * resolve correctly.
 */
const RUNNING_MARKER = "running."
const RUNNING_REPLY_LINE_PREFIX = "latest sub-agent reply:"
const RUNNING_BLOCKED_LINE_PREFIX = "awaiting your decision:"
const LEGACY_RUNNING_SENTINEL = "sub-agent is still running in the background."

function textRunningStatus(text: string | null): TaskStatus | null {
  if (text == null) return null
  const normalized = text.trim().toLowerCase()
  if (normalized === LEGACY_RUNNING_SENTINEL) return "running"
  // Anchor on the first line being EXACTLY the bare marker. A bare "Running."
  // (no second line) is running; the hint/blocked variants additionally require
  // the second line to start with a fixed protocol prefix — whatever follows it
  // is never inspected.
  const newlineIdx = normalized.indexOf("\n")
  const firstLine = (
    newlineIdx === -1 ? normalized : normalized.slice(0, newlineIdx)
  ).trim()
  if (firstLine !== RUNNING_MARKER) return null
  if (newlineIdx === -1) return "running"
  const secondLine = normalized.slice(newlineIdx + 1).trimStart()
  return secondLine.startsWith(RUNNING_REPLY_LINE_PREFIX) ||
    secondLine.startsWith(RUNNING_BLOCKED_LINE_PREFIX)
    ? "running"
    : null
}

/** Whether a running report's message text carries the blocked note. The
 *  structured `blocked_on` is preferred; this recovers the same fact on hosts
 *  that persist only `CallToolResult.content` text (Claude Code), where the
 *  structured field never survives. Assumes `textRunningStatus` already
 *  validated the shape, so it only has to find the prefix. */
function textIsBlocked(text: string | null): boolean {
  if (text == null) return false
  const newlineIdx = text.indexOf("\n")
  if (newlineIdx === -1) return false
  return text
    .slice(newlineIdx + 1)
    .trimStart()
    .toLowerCase()
    .startsWith(RUNNING_BLOCKED_LINE_PREFIX)
}

const BLOCKED_KINDS: readonly BlockedKind[] = [
  "permission",
  "question",
  "plan_approval",
]

/** The report's `blocked_on.kind`, when it carried a structured one. Falls back
 *  to `"permission"` for a text-only host whose message shows the blocked note
 *  (the overwhelmingly common kind, and the badge treats all three alike). */
function parseBlockedOn(
  report: Record<string, unknown>,
  text: string | null
): BlockedKind | null {
  const blocked = asObject(report.blocked_on)
  if (blocked) {
    const kind = blocked.kind
    if (
      typeof kind === "string" &&
      (BLOCKED_KINDS as readonly string[]).includes(kind)
    ) {
      return kind as BlockedKind
    }
    // Present but unrecognized (a kind added by a newer backend): still blocked.
    return "permission"
  }
  return textIsBlocked(text) ? "permission" : null
}

export type ResolvedBadge = { status: BadgeStatus; errorCode?: string }

function asObject(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null
}

function str(obj: Record<string, unknown>, key: string): string | null {
  const v = obj[key]
  return typeof v === "string" && v.length > 0 ? v : null
}

function num(obj: Record<string, unknown>, key: string): number | null {
  const v = obj[key]
  return typeof v === "number" && Number.isFinite(v) ? v : null
}

function firstContentText(envelope: Record<string, unknown>): string | null {
  if (!Array.isArray(envelope.content)) return null
  const first = asObject(envelope.content[0])
  return first ? str(first, "text") : null
}

/** Whether `obj` is already one of the shapes the resolution below reads — a
 *  report, a batch, or an MCP content envelope. Stops the host-envelope peel at
 *  a result that itself happens to carry a `result` key. (A child's arbitrary
 *  payload is guarded on the other side too: `peelMcpResultEnvelope` only ever
 *  peels TO a real `CallToolResult`.) */
function isResolvableResult(obj: Record<string, unknown>): boolean {
  return (
    validStatus(obj) !== null ||
    Array.isArray(obj.tasks) ||
    Array.isArray(obj.content) ||
    asObject(obj.structuredContent) !== null
  )
}

type ParsedResult = {
  obj: Record<string, unknown> | null
  /** codex-acp's `rawOutput.error` — the only text worth showing when the MCP
   *  call itself failed and carried no result. */
  hostError: string | null
}

const NO_RESULT: ParsedResult = { obj: null, hostError: null }

function peeled(obj: Record<string, unknown> | null): ParsedResult {
  return obj ? peelMcpResultEnvelope(obj, isResolvableResult) : NO_RESULT
}

/**
 * Parse a tool-result string into its envelope/report object, peeling one layer
 * of double-encoding (JSON-of-JSON). Some hosts re-stringify the RESULT text
 * exactly as they do tool arguments (see `findTaskId`): a direct parse then
 * yields a *string* rather than the payload object. Re-parse that once — falling
 * back to the embedded-JSON scanner so a re-stringified Codex "Wall time:…
 * Output:<json>" wrap still resolves. A parse that yields a non-string non-object
 * (array, number) is null, matching the prior inline behavior.
 *
 * The parsed object is then stripped of any host envelope around the MCP result
 * (`peelMcpResultEnvelope`) — codex's LIVE wire hands us
 * `{result: <CallToolResult>, error: null}`, which otherwise resolves to no
 * report at all and paints the raw envelope JSON into the card. (Codex's
 * PERSISTED rollout carries the bare `Wall time:…\nOutput:\n<json>` instead, so
 * only the live path was affected.) Shared by [`parseStatusReport`] and
 * [`parseStatusReports`] so both honor the same shapes.
 */
function parseResultObject(raw: string): ParsedResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return peeled(extractEmbeddedJsonObject(raw))
  }
  if (typeof parsed === "string") {
    try {
      return peeled(
        asObject(JSON.parse(parsed)) ?? extractEmbeddedJsonObject(parsed)
      )
    } catch {
      return peeled(extractEmbeddedJsonObject(parsed))
    }
  }
  return peeled(asObject(parsed))
}

// Wrapper keys hosts use to nest the actual tool arguments (mirrors
// `delegated-sub-thread.tsx`): JSON-RPC/MCP relays pack the call as
// `{name, arguments}` or `{params: {...}}`; some agents stash args under a
// generic `input`/`payload` key. Walked recursively (small depth cap) so any
// single layer of wrapping — including double-encoded JSON strings — peels off.
const TASK_ID_WRAPPER_KEYS = [
  "arguments",
  "input",
  "params",
  "payload",
  "_meta",
] as const

function findTaskId(value: unknown, depth = 0): string | null {
  if (depth > 4 || value === null || value === undefined) return null
  // Some hosts double-encode the input (JSON-of-JSON); parse and recurse once.
  if (typeof value === "string") {
    try {
      return findTaskId(JSON.parse(value), depth + 1)
    } catch {
      return null
    }
  }
  const obj = asObject(value)
  if (!obj) return null
  const direct = str(obj, "task_id")
  if (direct) return direct
  for (const key of TASK_ID_WRAPPER_KEYS) {
    if (obj[key] === undefined) continue
    const found = findTaskId(obj[key], depth + 1)
    if (found) return found
  }
  return null
}

/** Extract the `task_id` the tool was called with (`{ task_id, wait_ms? }`),
 *  peeling host wrappers and double-encoded JSON. These tools require a
 *  non-empty `task_id`, so a miss should be rare — but degrade gracefully. */
export function parseTaskId(raw: string | null | undefined): string | null {
  if (!raw) return null
  try {
    return findTaskId(JSON.parse(raw))
  } catch {
    // unparseable input — the task ref is just a nicety, skip it
    return null
  }
}

/** Array-aware sibling of [`findTaskId`]: collect a status poll's task ids from
 *  a `task_ids` array and/or a legacy single `task_id`, peeling host wrappers
 *  and double-encoded JSON. Order-preserving and de-duplicated. */
function findTaskIds(value: unknown, depth = 0): string[] {
  if (depth > 4 || value === null || value === undefined) return []
  // Double-encoded input (JSON-of-JSON): parse and recurse once.
  if (typeof value === "string") {
    try {
      return findTaskIds(JSON.parse(value), depth + 1)
    } catch {
      return []
    }
  }
  const obj = asObject(value)
  if (!obj) return []
  const out: string[] = []
  const seen = new Set<string>()
  const push = (v: unknown) => {
    if (typeof v === "string" && v.length > 0 && !seen.has(v)) {
      seen.add(v)
      out.push(v)
    }
  }
  // The batch `task_ids` array first, then a lone legacy `task_id`.
  if (Array.isArray(obj.task_ids)) for (const v of obj.task_ids) push(v)
  push(obj.task_id)
  if (out.length > 0) return out
  // Nothing at this level — peel one wrapper layer.
  for (const key of TASK_ID_WRAPPER_KEYS) {
    if (obj[key] === undefined) continue
    const found = findTaskIds(obj[key], depth + 1)
    if (found.length > 0) return found
  }
  return out
}

/** Extract the task id(s) a status poll was called with — `{ task_ids: [...] }`
 *  (current shape) or a legacy single `{ task_id }` from historical transcripts
 *  — peeling host wrappers and double-encoded JSON. Returns `[]` on a miss; the
 *  report's own `task_id` is the primary ref, these are only an index-aligned
 *  fallback. */
export function parseTaskIds(raw: string | null | undefined): string[] {
  if (!raw) return []
  try {
    return findTaskIds(JSON.parse(raw))
  } catch {
    return []
  }
}

/** The `status` value if it's one of the delegation report statuses, else null. */
function validStatus(obj: Record<string, unknown> | null): TaskStatus | null {
  if (!obj) return null
  const s = obj.status
  return typeof s === "string" &&
    (TASK_STATUSES as readonly string[]).includes(s)
    ? (s as TaskStatus)
    : null
}

/**
 * Whether `obj` is a delegation report. `structuredContent` is trusted (the
 * host only surfaces it for an actual `CallToolResult`). An UNtrusted source —
 * raw output text or `content[0].text`, which on the live wire is the child's
 * own (arbitrary) result — must ALSO carry the report's `task_id`; otherwise a
 * child whose output happens to be JSON-with-`status` would be misread as a
 * report (false failure tint / dropped output). Every real status/cancel report
 * carries `task_id`, so this never rejects a genuine one.
 */
function isReport(
  obj: Record<string, unknown> | null,
  trusted: boolean
): boolean {
  if (!validStatus(obj)) return false
  if (trusted) return true
  return typeof obj!.task_id === "string" && obj!.task_id.length > 0
}

/**
 * Parse the tool output into a delegation report. Handles every shape the
 * report can arrive in:
 *   - the MCP `CallToolResult` envelope (`{ content, structuredContent?,
 *     isError? }`) — persisted / snapshot rows;
 *   - a host-wrapped envelope/report — notably Codex's
 *     `"Wall time:…\nOutput:\n<json>"` (recovered via `extractEmbeddedJsonObject`);
 *   - an inlined report (`{ status, ... }`), incl. one embedded in
 *     `content[0].text` when the host surfaces no `structuredContent`;
 *   - the plain-text result the live stream forwards (no structured fields →
 *     status is derived from the tool-call state instead).
 * Recovering the structured `status` matters because terminal outcomes
 * (`unknown` / `failed` / `canceled`) must not degrade into a non-error row.
 */
export function parseStatusReport(
  output: string | null | undefined,
  errorText: string | null | undefined
): StatusReport {
  const empty: StatusReport = {
    status: null,
    taskId: null,
    text: null,
    errorCode: null,
    durationMs: null,
    blockedOn: null,
    progress: null,
  }
  const raw = (output ?? errorText ?? "").trim()
  if (!raw) return empty

  const { obj, hostError } = parseResultObject(raw)
  // Plain text (no recoverable JSON) — the historical content-only shape. The
  // only structured hints left are the backend's running sentinel sentence and,
  // on it, the blocked note.
  if (!obj) {
    return {
      ...empty,
      status: textRunningStatus(raw),
      text: raw,
      blockedOn: textIsBlocked(raw) ? "permission" : null,
    }
  }

  // Locate the structured report across the shapes it can hide in:
  // structuredContent (trusted) → top-level → inlined in content[0].text. The
  // last two are gated on `task_id` so a child's own JSON output isn't misread.
  const contentText = firstContentText(obj)
  const sc = asObject(obj.structuredContent)
  let report: Record<string, unknown> | null = null
  let displayText: string | null = contentText
  if (isReport(sc, true)) {
    report = sc
  } else if (isReport(obj, false)) {
    report = obj
  } else if (contentText) {
    const embedded = extractEmbeddedJsonObject(contentText)
    if (isReport(embedded, false)) {
      report = embedded
      // content[0].text WAS the report JSON, not a human message — fall back to
      // the report's own message/text for display instead of raw JSON.
      displayText = null
    }
  }

  if (report) {
    const text = displayText ?? str(report, "text") ?? str(report, "message")
    return {
      status: validStatus(report),
      taskId: str(report, "task_id"),
      text,
      errorCode: str(report, "error_code"),
      durationMs: num(report, "duration_ms"),
      // Structured `blocked_on` when the host kept it; otherwise recovered from
      // the message text, which is all a content-only host leaves behind.
      blockedOn: parseBlockedOn(
        report,
        text ?? str(report, "message") ?? contentText
      ),
      progress: progressFromReport(report.progress),
    }
  }

  // Parsed JSON but no report (e.g. a content envelope stripped of
  // structuredContent) — still honor the running sentinel in the display text.
  // A host envelope that failed outright carries no result to show, so its own
  // error string beats dumping the envelope JSON.
  const fallbackText = contentText ?? hostError ?? raw
  return {
    ...empty,
    status: textRunningStatus(fallbackText),
    text: fallbackText,
    blockedOn: textIsBlocked(fallbackText) ? "permission" : null,
  }
}

/** Build a `StatusReport` from a known delegation report object — one element
 *  of a `tasks` batch. The element IS the report, so display text comes from
 *  its own `text` / `message` (there's no separate content envelope to show). */
function reportFromObject(report: Record<string, unknown>): StatusReport {
  const text = str(report, "text") ?? str(report, "message")
  return {
    status: validStatus(report),
    taskId: str(report, "task_id"),
    text,
    errorCode: str(report, "error_code"),
    durationMs: num(report, "duration_ms"),
    blockedOn: parseBlockedOn(report, text),
    progress: progressFromReport(report.progress),
  }
}

/**
 * Locate a batch `tasks` array across the shapes a `get_delegation_status`
 * batch result can arrive in: trusted `structuredContent.tasks`; a top-level
 * `tasks`; or a `{ "tasks": [...] }` JSON embedded in `content[0].text` (the
 * content-only host path, e.g. Claude Code). `trusted` mirrors
 * `parseStatusReport`: only the `structuredContent` source is trusted outright;
 * the others are still gated per-element on carrying a real report.
 */
function findTasksArray(
  obj: Record<string, unknown>
): { tasks: unknown[]; trusted: boolean } | null {
  const sc = asObject(obj.structuredContent)
  if (sc && Array.isArray(sc.tasks)) return { tasks: sc.tasks, trusted: true }
  if (Array.isArray(obj.tasks)) return { tasks: obj.tasks, trusted: false }
  const contentText = firstContentText(obj)
  if (contentText) {
    const embedded = extractEmbeddedJsonObject(contentText)
    if (embedded && Array.isArray(embedded.tasks))
      return { tasks: embedded.tasks, trusted: false }
  }
  return null
}

/**
 * Parse a `get_delegation_status` tool output into ONE report per task.
 *
 * A batch poll returns a `{ "tasks": [report, ...] }` envelope (carried in
 * `structuredContent`, at the top level, or — on hosts that persist only
 * `CallToolResult.content` text — as the JSON content text itself). When such
 * an array is found AND at least one element looks like a real report, every
 * element is mapped to a `StatusReport`, preserving order so a grouper can
 * index-align them with the call's `task_ids`. Otherwise this falls back to the
 * single-report [`parseStatusReport`], leaving the historical single-task /
 * cancel shapes unchanged.
 */
export function parseStatusReports(
  output: string | null | undefined,
  errorText: string | null | undefined
): StatusReport[] {
  const raw = (output ?? errorText ?? "").trim()
  if (raw) {
    const { obj } = parseResultObject(raw)
    if (obj) {
      const found = findTasksArray(obj)
      if (
        found &&
        found.tasks.length > 0 &&
        found.tasks.some((t) => isReport(asObject(t), found.trusted))
      ) {
        return found.tasks.map((t) => reportFromObject(asObject(t) ?? {}))
      }
    }
  }
  // Not a batch envelope → single report (one task / cancel, unchanged).
  return [parseStatusReport(output, errorText)]
}

/**
 * Resolve the status badge. The structured `status` wins when present
 * (persisted rows); otherwise fall back to the tool-call lifecycle state
 * (live stream, before / without structured output).
 *
 * A RETURNED `running` poll resolves to `checked` (neutral, no spinner): it is
 * a stale snapshot of "still running at the time of that check", not live
 * activity. The live spinner is only produced by the lifecycle fallback below
 * — i.e. a poll that is genuinely still in flight (`input-*`, no result yet).
 * A running poll that came back BLOCKED is the exception: the sub-agent is
 * parked on the user, which the same `waiting` badge already means everywhere
 * else in the delegation UI (see `resolveDelegationStatus`).
 */
export function deriveBadge(
  kind: "status" | "cancel",
  report: StatusReport,
  state: ToolCallState | undefined,
  hasError: boolean
): ResolvedBadge {
  switch (report.status) {
    case "completed":
      return { status: "ok" }
    case "running":
      // The poll RETURNED while the task was still running — a settled
      // snapshot, not live work. Show a neutral state, not an endless spinner.
      // Unless it is blocked, which needs the user and says so.
      return { status: report.blockedOn ? "waiting" : "checked" }
    case "unknown":
      // Terminal "task id not known" — surface as error, not an endless spinner.
      return { status: "err", errorCode: "unknown" }
    case "failed":
      return { status: "err", errorCode: report.errorCode ?? undefined }
    case "canceled":
      // Canceling is the *success* outcome for `cancel_delegation`; for a
      // status query a canceled task is a terminal error.
      return kind === "cancel"
        ? { status: "ok" }
        : { status: "err", errorCode: report.errorCode ?? "canceled" }
    default:
      break
  }
  if (state === "output-error" || hasError) return { status: "err" }
  if (state === "output-available") return { status: "ok" }
  if (state === "input-available" || state === "input-streaming")
    return { status: "running" }
  return { status: "starting" }
}

/**
 * How a task ended, as a check on it reported — what a delegation's own card
 * reads when nothing live or stored says more: a check that came back after the
 * hand-over is newer than the ack it returned. Null while the task still runs,
 * or when the check named no outcome.
 */
export function taskEnding(
  report: StatusReport | null | undefined
): { status: "ok" | "err"; errorCode?: string } | null {
  if (!report?.status || report.status === "running") return null
  const badge = deriveBadge("status", report, undefined, false)
  return badge.status === "ok" || badge.status === "err"
    ? { status: badge.status, errorCode: badge.errorCode }
    : null
}

/** Compact human duration: `350ms`, `1.2s`, `12s`, `2m 0s`. Total seconds are
 *  rounded once before splitting so the remainder never rolls to `60s`. */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`
  const totalSec = Math.round(ms / 1000)
  if (totalSec < 60) return `${totalSec}s`
  return `${Math.floor(totalSec / 60)}m ${totalSec % 60}s`
}

/** One resolved task row for the status card(s): the task ref, its latest
 *  poll's report + badge, and one result entry per poll that touched the task
 *  (the `×N` hint + the expanded pager). */
export interface DelegationTaskRow {
  key: string
  taskId: string | null
  report: StatusReport
  badge: ResolvedBadge
  /** One entry per poll of this task, chronological (`null` where a poll
   *  returned no text) — paginated on expand; length is the `×N` header hint. */
  results: (string | null)[]
  /**
   * Whether the backend answered any of these polls with a `running` report
   * for the task. It only does that for the CALLER's own task — anyone else's
   * id gets `unknown` (`classify_locked` in `broker.rs`) — so this is what
   * makes `taskId` more than an argument the model wrote, and what entitles
   * the row to reach the live sub-agent behind it (`useDelegationTaskLive`).
   */
  runningConfirmed: boolean
  /** The tool call id of the latest poll behind the row — the one its report
   *  and badge come from. Names the row across the transcript: the
   *  transcript's newest row for a task is the one whose `latestPollId` is the
   *  task's last poll (`@/lib/delegation-status-index`). */
  latestPollId: string
}

interface ParsedPollReport {
  poll: AdaptedToolCallPart
  report: StatusReport
}

const EMPTY_STATUS_REPORT: StatusReport = {
  status: null,
  taskId: null,
  text: null,
  errorCode: null,
  durationMs: null,
  blockedOn: null,
  progress: null,
}

/**
 * Group a run of `get_delegation_status` polls into one row per task.
 *
 * Each poll resolves to ONE report (a single-task poll) or MANY (a batch poll
 * issued with `task_ids`). A report is attributed to a task by its own
 * `task_id`, falling back to the poll's input ids by index, then grouped across
 * all polls — so a task polled N times shows `×N` with its latest outcome, and
 * parallel waits surface as one row each. A report we still can't attribute is
 * keyed by `toolCallId:index` so distinct unknowns (incl. two in one batch
 * poll) never collapse into one row. First-appearance order is preserved.
 */
export function buildDelegationTaskRows(
  polls: AdaptedToolCallPart[]
): DelegationTaskRow[] {
  const order: string[] = []
  const byKey = new Map<
    string,
    { taskId: string | null; polls: ParsedPollReport[] }
  >()
  for (const poll of polls) {
    const reports = parseStatusReports(poll.output, poll.errorText)
    const inputIds = parseTaskIds(poll.input)
    // A poll declares its task set via its input ids too. An in-flight BATCH
    // poll (`task_ids:[a,b]`, no output yet) parses to a single empty fallback
    // report, so iterate the wider of reports/inputIds — every requested task
    // gets a (spinner) row immediately instead of all-but-the-first vanishing
    // until the batch resolves.
    const count = Math.max(reports.length, inputIds.length)
    for (let i = 0; i < count; i++) {
      const report = reports[i] ?? EMPTY_STATUS_REPORT
      const taskId = report.taskId ?? inputIds[i] ?? null
      // Drop an unsettled poll that carries no identity AND nothing to show yet.
      // claude-agent-acp ships an arg-less initial `tool_call` (rawInput `{}`)
      // and only fills the real `task_ids` on a later update — which, for a long
      // `wait_ms` status check, lands near completion — so a poll that is still
      // in flight often parses to this empty, id-less report. Each such re-poll
      // would otherwise become its own anonymous "waiting for a task's result"
      // row, stacking identical duplicates of the same wait. It folds into its
      // task's row the moment an id or report arrives, and the settled transcript
      // (whose polls always carry the id) is unaffected. `isUnsettledToolCall`
      // (not a bare live-state check) also covers an orphan promoted into
      // `localTurns` at COMPLETE_TURN — output-available yet never settled — which
      // would otherwise re-stack after the turn completes. A genuinely settled
      // id-less report — a real interim note or terminal status — still gets its
      // own row below.
      if (
        taskId == null &&
        isUnsettledToolCall(poll) &&
        report.status == null &&
        (report.text == null || report.text.trim() === "")
      ) {
        continue
      }
      const key = taskId ?? `__unattributed__:${poll.toolCallId}:${i}`
      let entry = byKey.get(key)
      if (!entry) {
        entry = { taskId, polls: [] }
        byKey.set(key, entry)
        order.push(key)
      }
      entry.polls.push({ poll, report })
    }
  }
  return order.map((key) => {
    const entry = byKey.get(key)!
    const latest = entry.polls[entry.polls.length - 1]
    const badge = deriveBadge(
      "status",
      latest.report,
      latest.poll.state,
      !!latest.poll.errorText
    )
    // One entry per poll, in order — so `×N` and the pager total both equal the
    // number of times this task was actually checked.
    const results = entry.polls.map(({ report }) => report.text)
    const runningConfirmed = entry.polls.some(
      ({ report }) => report.status === "running"
    )
    return {
      key,
      taskId: entry.taskId,
      report: latest.report,
      badge,
      results,
      runningConfirmed,
      latestPollId: latest.poll.toolCallId,
    }
  })
}
