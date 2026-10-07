import type {
  ActiveDelegationState,
  AsyncTaskRecord,
  AvailableCommandInfo,
  ConfigStaleKind,
  ConnectionStatus,
  LiveContentBlock as WireLiveContentBlock,
  LiveMessage as WireLiveMessage,
  LiveSessionSnapshot,
  PendingPlanApprovalState,
  PendingQuestionState,
  PromptCapabilitiesInfo,
  SessionConfigOptionInfo,
  SessionFailureRecord,
  SessionModeStateInfo,
  SessionUsageUpdateInfo,
  ToolCallState,
} from "@/lib/types"

import { routeAcpError, type AcpErrorLevel } from "@/lib/acp-error-presentation"
import type {
  LiveContentBlock as LocalLiveContentBlock,
  LiveMessage as LocalLiveMessage,
  PendingPermission,
  PendingUserMessage,
  ToolCallInfo,
} from "@/contexts/acp-connections-context"

/**
 * Snapshot-derived subset of ConnectionState. Fields not present here
 * (pendingQuestion, claudeApiRetry, contextKey, agentType, workingDir) are
 * frontend-only or set elsewhere and must not be touched by
 * HYDRATE_FROM_SNAPSHOT.
 */
export interface SnapshotPatch {
  // Carries the snapshot's source connection_id so the reducer can reject
  // applying it when the connection at the target contextKey was
  // disconnected and replaced (different connectionId) between the
  // snapshot fetch start and its async response. Without this guard the
  // eventSeq race window allows an old connection's snapshot to overwrite
  // a freshly-started replacement at the same contextKey.
  connectionId: string
  status: ConnectionStatus
  sessionId: string | null
  modes: SessionModeStateInfo | null
  configOptions: SessionConfigOptionInfo[] | null
  availableCommands: AvailableCommandInfo[] | null
  usage: SessionUsageUpdateInfo | null
  liveMessage: LocalLiveMessage | null
  pendingPermission: PendingPermission | null
  /** Awaiting-answer multiple-choice `ask_user_question` carried by the
   *  snapshot, so a client attaching mid-turn re-renders the card. `null` when
   *  no question is pending. (Distinct from the frontend-only free-text
   *  `pendingQuestion`, which is NOT in the snapshot.) */
  pendingAskQuestion: PendingQuestionState | null
  /** Awaiting-decision Grok `exit_plan_mode` approval carried by the snapshot,
   *  so a client attaching mid-turn re-renders the plan-approval card. `null`
   *  when no approval is pending. */
  pendingPlanApproval: PendingPlanApprovalState | null
  /** In-flight user prompt carried by the snapshot, so a client attaching
   *  mid-turn can synthesize the user turn (Bug-2 / cross-client viewing).
   *  `null` when no turn is in flight. */
  pendingUserMessage: PendingUserMessage | null
  promptCapabilities: PromptCapabilitiesInfo | null
  selectorsReady: boolean
  supportsFork: boolean
  /** Whether the running session is on stale (launch-time) config — recovered
   *  from the snapshot so a reconnect/refresh/new tile sees the banner state
   *  that the one-shot `session_config_stale` event won't replay. */
  configStale: boolean
  configStaleKind: ConfigStaleKind | null
  /** Launched-but-unresolved background tasks carried by the snapshot, so a
   *  client attaching mid-episode recovers the sweep exemption the one-shot
   *  `background_activity` events won't replay. `0` when the server omitted
   *  the field. */
  backgroundOutstanding: number
  /** AIR typed session failure table carried by the snapshot — resolved
   *  entries and their revision watermarks included. MERGED into the in-memory
   *  table by the monotonic per-id rule (`mergeSessionFailures`) on BOTH
   *  hydrate branches: merging is idempotent and can only add or upgrade
   *  records, never clobber a fresher live one. `[]` when the server omitted
   *  the field. */
  sessionFailures: SessionFailureRecord[]
  /** AIR async tasks carried by the snapshot, already merged backend-side.
   *  Terminal rows included — they are the ids subsequent live deltas revise.
   *  `[]` when the server omitted the field. */
  asyncTasks: AsyncTaskRecord[]
  /** Latest ACP runtime error carried by the snapshot. `null` means none.
   *  Raw backend text here; the connections provider localizes it by
   *  `lastErrorCode` before hydrating, exactly as the live `error` event is. */
  lastError: string | null
  /** Stable code of `lastError` (e.g. `turn_failed_empty`), or `null`. */
  lastErrorCode: string | null
  /** How `lastError` is tinted — see `routeAcpError`. */
  lastErrorLevel: AcpErrorLevel
  eventSeq: number
  /** Live sub-agent delegations carried by the snapshot. Consumed directly at
   *  the attach call sites to re-seed `DelegationProvider` bindings (see
   *  `seedDelegationsFromSnapshot`); the reducer does not store this on
   *  ConnectionState. `[]` when the server omitted the field. */
  activeDelegations: ActiveDelegationState[]
}

const DEFAULT_PROMPT_CAPS: PromptCapabilitiesInfo = {
  image: false,
  audio: false,
  embedded_context: false,
}

export function denormalizeSnapshot(wire: LiveSessionSnapshot): SnapshotPatch {
  const toolMap = new Map<string, ToolCallState>()
  for (const tc of wire.active_tool_calls) {
    toolMap.set(tc.id, tc)
  }
  const lastError = normalizeSnapshotLastError(wire.last_error)
  const lastErrorCode = wire.last_error?.code?.trim() || null

  return {
    connectionId: wire.connection_id,
    status: wire.status,
    sessionId: wire.external_id,
    modes: wire.modes,
    configOptions: wire.config_options,
    availableCommands: wire.available_commands ?? null,
    usage: wire.usage,
    liveMessage: wire.live_message
      ? denormalizeLiveMessage(wire.live_message, toolMap)
      : null,
    pendingPermission: wire.pending_permission
      ? {
          request_id: wire.pending_permission.request_id,
          // Pass the raw forwarded tool_call through unchanged.
          // `parsePermissionToolCall` walks rawInput / content / locations /
          // patch / plan to render the approval dialog — synthesizing
          // `{ description }` here would force the user to approve blind
          // after a refresh.
          tool_call: wire.pending_permission.tool_call,
          options: wire.pending_permission.options,
          // So a client attaching mid-turn sees the same "N more waiting" hint
          // as one that was live for the original event.
          queued: wire.pending_permission.queued,
        }
      : null,
    // The snapshot shape already matches PendingQuestionState; pass through.
    pendingAskQuestion: wire.pending_question ?? null,
    // The snapshot shape already matches PendingPlanApprovalState; pass through.
    pendingPlanApproval: wire.pending_plan_approval ?? null,
    pendingUserMessage: wire.pending_user_message
      ? {
          messageId: wire.pending_user_message.message_id,
          blocks: wire.pending_user_message.blocks,
        }
      : null,
    promptCapabilities: wire.prompt_capabilities ?? DEFAULT_PROMPT_CAPS,
    selectorsReady: wire.selectors_ready,
    supportsFork: wire.fork_supported,
    configStale: wire.config_stale ?? false,
    configStaleKind: wire.config_stale_kind ?? null,
    backgroundOutstanding: wire.background_outstanding ?? 0,
    sessionFailures: wire.session_failures ?? [],
    asyncTasks: wire.async_tasks ?? [],
    lastError,
    lastErrorCode,
    lastErrorLevel: routeAcpError(lastErrorCode).level,
    eventSeq: wire.event_seq,
    activeDelegations: wire.active_delegations ?? [],
  }
}

function normalizeSnapshotLastError(
  lastError: LiveSessionSnapshot["last_error"]
): string | null {
  const message =
    lastError && typeof lastError.message === "string"
      ? lastError.message.trim()
      : ""
  return message || null
}

function denormalizeLiveMessage(
  wire: WireLiveMessage,
  toolMap: Map<string, ToolCallState>
): LocalLiveMessage {
  const startedAtMs = Date.parse(wire.started_at)
  return {
    id: wire.id,
    role: wire.role === "tool" ? "tool" : "assistant",
    content: wire.content
      .map((block) => denormalizeBlock(block, toolMap))
      .filter((b): b is LocalLiveContentBlock => b !== null),
    startedAt: Number.isNaN(startedAtMs) ? Date.now() : startedAtMs,
  }
}

function denormalizeBlock(
  wire: WireLiveContentBlock,
  toolMap: Map<string, ToolCallState>
): LocalLiveContentBlock | null {
  switch (wire.kind) {
    // Subagent attribution must be forwarded explicitly — a mid-run attach
    // (cold attach / refresh while a Claude subagent streams) rebuilds the
    // capsule-vs-main routing from these fields alone.
    case "text":
      return {
        type: "text",
        text: wire.text,
        parentToolUseId: wire.parent_tool_use_id ?? undefined,
      }
    case "thinking":
      return {
        type: "thinking",
        text: wire.text,
        parentToolUseId: wire.parent_tool_use_id ?? undefined,
      }
    case "plan":
      // Wire `plan.entries` is `unknown` (passed through opaque from agent);
      // local shape expects PlanEntryInfo[]. We cast — backend's typed plan
      // payload is structurally identical to the local PlanEntryInfo[] shape
      // in practice (both are the agent's plan output forwarded verbatim).
      return { type: "plan", entries: wire.entries as never }
    case "tool_call_ref": {
      const tc = toolMap.get(wire.tool_call_id)
      if (!tc) {
        // Snapshot referenced a tool_call that wasn't in active_tool_calls.
        // Skip the block — the next tool_call event will recreate it.
        return null
      }
      return { type: "tool_call", info: toolStateToInfo(tc) }
    }
  }
}

/**
 * Rebuild the `raw_output` TEXT a live `tool_call` event would have carried,
 * from the snapshot's already-parsed `ToolCallOutput`.
 *
 * The backend does not keep the agent's raw output string: `upsert_tool_call`
 * runs it through `parse_tool_call_output_text` and stores the tagged enum
 * (`{kind:"json",value}` / `{kind:"text",content}` / `{kind:"error",message}`).
 * `raw_output_chunks`, on the other hand, is by contract the agent's own text —
 * every downstream reader (`delegation-status`, `background-task`,
 * `ask-question`, `feedback-check`, `shell-session-tool`, and the generic tool
 * card) parses it as such. Serializing the enum wholesale therefore hands them
 * `{"kind":"json","value":{…}}`, which matches none of their shapes: the
 * delegation card's `findTasksArray` misses the `tasks` array and falls back to
 * painting the envelope as opaque text.
 *
 * The corruption is intermittent because it only touches tool calls that are in
 * `active_tool_calls` when a hydrate lands (WS re-attach after lag, viewing the
 * session from a second client, refresh mid-turn) AND receive no later
 * `raw_output` event to overwrite the chunk — hence one poll in a run rendering
 * raw JSON while its neighbours are fine.
 *
 * Inverting the enum is faithful for `json` (`JSON.stringify` of the parsed
 * value — key order may differ, which no reader depends on) and for `text`
 * (stored verbatim). `error` is re-wrapped as the `{error: …}` object that made
 * the backend choose that variant, so it round-trips back to the same variant
 * and the message stays where readers scan for it — but the sibling keys the
 * backend dropped when promoting to `Error` are gone for good. One consequence
 * worth knowing: a codex-style `{result: null, error: "…"}` host failure comes
 * back without its `result` key, so `mcp-result-envelope.ts::hostFailureError`
 * (which requires both) no longer recognizes it and the delegation card shows
 * the `{"error": …}` JSON rather than the bare message. The failure is still
 * reported, and the loss happens in the backend, not in this inversion.
 */
function toolOutputRawText(output: ToolCallState["output"]): string | null {
  if (output == null) return null
  // A bare string is what an older backend sent before the enum existed.
  if (typeof output === "string") return output
  if (output.kind === "text") return output.content
  if (output.kind === "json") return JSON.stringify(output.value)
  if (output.kind === "error") return JSON.stringify({ error: output.message })
  // A variant this build doesn't know yet: still better as its own JSON than
  // dropped on the floor.
  return JSON.stringify(output)
}

function toolStateToInfo(tc: ToolCallState): ToolCallInfo {
  // Backend's structured output is collapsed into a single raw chunk for
  // hydration. Chunk history isn't recoverable from the snapshot — the
  // frontend's per-chunk delta tracking will resume from subsequent events.
  const outputChunks: string[] = []
  let outputBytes = 0
  const rawOutput = toolOutputRawText(tc.output)
  if (rawOutput !== null) {
    outputChunks.push(rawOutput)
    outputBytes = rawOutput.length
  }
  return {
    tool_call_id: tc.id,
    title: tc.label,
    kind: tc.kind,
    status: tc.status,
    content: tc.content,
    raw_input: tc.input == null ? null : JSON.stringify(tc.input),
    raw_output_chunks: outputChunks,
    raw_output_total_bytes: outputBytes,
    locations: tc.locations ?? null,
    meta: tc.meta ?? null,
    images: tc.images ?? [],
  }
}
