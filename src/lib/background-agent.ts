/**
 * Background-task lifecycle for the Agent tool card.
 *
 * The Claude parser rewrites an async sub-agent launch ack's output — internal
 * metadata text never meant for users — into a structured marker payload
 * (`BACKGROUND_TASK_MARKER` + one-line JSON), joined with the latest matching
 * `<task-notification>` from the same transcript (see
 * `ClaudeRecordAccumulator::finalize_background_lifecycle` in
 * `src-tauri/src/parsers/claude.rs`). This module is the frontend side of that
 * contract.
 *
 * A `null` status means no notification has been observed in the transcript —
 * deliberately rendered as "launched · result pending", NEVER as "running":
 * the transcript alone cannot distinguish a still-running task from one whose
 * CLI died (the zombie-"running" trap). Live "running" presentation is only
 * derived from the in-flight wire ack text (`isAsyncLaunchAckText`), which by
 * construction only exists inside a live session.
 */

export const BACKGROUND_TASK_MARKER = "[[codeg-background-task]]"

/**
 * Agents whose OUT-OF-TURN transcript activity already has a live render path.
 *
 * `background_watch.rs::spawn_if_claude` arms the transcript-tail watcher for
 * Claude Code and returns `None` for everyone else. That watcher is what feeds
 * the `background_activity` overlay turns which `applyStreamingAction`'s
 * out-of-turn guard defers to when it drops wire content outside a prompting
 * turn. For every other agent the guard drops that content with no producer
 * behind it, so nothing renders until the transcript is re-read.
 *
 * Keep in sync with `spawn_if_claude`: arming the watcher for another agent
 * without adding it here makes that agent render its background work twice.
 */
const AGENTS_WITH_TRANSCRIPT_OVERLAY: ReadonlySet<string> = new Set([
  "claude_code",
])

/** See `AGENTS_WITH_TRANSCRIPT_OVERLAY`. */
export function hasTranscriptOverlay(agentType: string): boolean {
  return AGENTS_WITH_TRANSCRIPT_OVERLAY.has(agentType)
}

/**
 * Id prefix of codex-acp's MCP start-up report (`McpStartupReporter`): one
 * failed tool call per MCP server that failed, was cancelled or was skipped
 * while the session opened, id `mcp_startup.<server>.<uuid>`, titled
 * `mcp__<server>__startup`. It goes out whenever start-up settles — right
 * after `session/new` as a rule, after the first turn when a server is slow.
 */
const MCP_STARTUP_REPORT_ID_PREFIX = "mcp_startup."

/**
 * Whether an envelope carries turn material that would be LOST if it arrived
 * outside a prompting turn — i.e. worth telling the user their transcript has
 * content the timeline is not showing.
 *
 * Deliberately narrower than "everything the out-of-turn guard drops":
 *
 * - `tool_call_update` revises a call already on screen. A tool that settles
 *   just after its turn closed is the common case, and it is not new material.
 * - Empty or whitespace-only deltas carry no new readable content. Codex can
 *   flush a final newline after a completed or cancelled turn; treating it as
 *   background work leaves a persistent recovery notice on ordinary replies.
 * - codex-acp's MCP start-up report is a `tool_call` the adapter makes up to
 *   say how the session opened, not one the agent made in a turn: the
 *   transcript never has it, so re-reading it would show nothing new.
 */
export function isOutOfTurnContentEvent(envelope: {
  type: string
  // `null` too: the `prompt_suggestion` event carries `text: null` to withdraw
  // its offer, and is not content either way.
  text?: string | null
  tool_call_id?: string
}): boolean {
  if (envelope.type === "content_delta" || envelope.type === "thinking") {
    return (envelope.text?.trim().length ?? 0) > 0
  }
  if (envelope.type !== "tool_call") return false
  return !envelope.tool_call_id?.startsWith(MCP_STARTUP_REPORT_ID_PREFIX)
}

/**
 * Whether turn content that just reached a connection is a turn the agent ran
 * on its own: content the out-of-turn guard dropped and nothing else renders,
 * so the timeline should offer to re-read the transcript.
 *
 * Takes the connection as the store holds it AFTER the reducer applied the
 * envelope, which is what the guard itself read.
 *
 * - `prompting`: the content belongs to the running turn, which renders it.
 * - No turn has run on the connection yet (`hasPrompted`): the content is the
 *   adapter's own start-up output, such as an MCP server's failed-start report.
 *   A turn an agent runs by itself follows one of ours (it drains a background
 *   task, continues a goal), so nothing before the first turn is one. A new
 *   conversation also has no transcript to re-read before its first prompt.
 *   Arming there is how the notice appeared the instant a new conversation's
 *   first message was sent: it was raised while the welcome screen hid the
 *   thread, and shown as soon as the thread rendered.
 * - Agents with a transcript overlay render this content themselves.
 */
export function isUnrenderedAgentTurnContent(
  connection:
    | { status: string; hasPrompted: boolean; agentType: string }
    | undefined
): boolean {
  if (!connection || connection.status === "prompting") return false
  if (!connection.hasPrompted) return false
  return !hasTranscriptOverlay(connection.agentType)
}

export interface BackgroundTaskLifecycle {
  taskId: string
  /** `<status>` of the latest task-notification ("completed" on success);
   *  `null` while no notification has been observed. */
  status: string | null
  summary: string | null
  /** The notification's `<result>` markdown (parser-capped). */
  result: string | null
  /** The latest notification says the task will notify again (it stopped
   *  while background work of its own still runs, or it is being resumed), so
   *  its result may be interim. Says nothing about whether it still runs. */
  interim: boolean
}

/** Parse a parser-rewritten lifecycle marker out of a tool output preview.
 *  Returns `null` for anything that isn't a well-formed marker. */
export function parseBackgroundTaskMarker(
  output: string | null | undefined
): BackgroundTaskLifecycle | null {
  if (!output) return null
  const trimmed = output.trimStart()
  if (!trimmed.startsWith(BACKGROUND_TASK_MARKER)) return null
  try {
    const payload = JSON.parse(
      trimmed.slice(BACKGROUND_TASK_MARKER.length)
    ) as Record<string, unknown>
    const taskId = typeof payload.task_id === "string" ? payload.task_id : null
    if (!taskId) return null
    return {
      taskId,
      status: typeof payload.status === "string" ? payload.status : null,
      summary: typeof payload.summary === "string" ? payload.summary : null,
      result: typeof payload.result === "string" ? payload.result : null,
      interim: payload.interim === true,
    }
  } catch {
    return null
  }
}

/**
 * Whether a LIVE wire tool output is an async sub-agent launch ack —
 * Claude Code's ("Async agent launched successfully. … You will be
 * notified…"), Grok's `spawn_subagent(background: true)` ack ("Subagent
 * started in background.\nsubagent_id: …\nUse get_command_or_subagent_output
 * …") or OpenCode 2's `subagent(background: true)` one ("The subagent is
 * working in the background (sessionID: …)", packages/core/src/tool/plugin/
 * subagent.ts `backgroundResult`, 2.2.0). Presentation-only: used to show a
 * "running in background" state instead of dumping the internal ack text while
 * the turn's wire data is still what the card renders (the parser marker — or,
 * for Grok, the live `subagent_finished` settle — replaces it).
 */
export function isAsyncLaunchAckText(
  output: string | null | undefined
): boolean {
  if (!output) return false
  const text = output.trimStart()
  return (
    output.includes("Async agent launched successfully") ||
    text.startsWith("Subagent started in background") ||
    text.startsWith("The subagent is working in the background (sessionID:")
  )
}
