"use client"

/**
 * Everything an Agent / Task (sub-agent) tool call says about itself, derived
 * once from the call: title, status label, prompt, model and effort, the
 * child's timeline, the background lifecycle, the child session to open.
 *
 * Read by the activity timeline's sub-agent row, which keeps every agent's
 * wire quirks (Cursor's task envelope, codex's launch-only capsules, Grok's
 * progress ticker, Claude Code's background launches) in this one place.
 */

import { useMemo, useState } from "react"
import { useTranslations } from "next-intl"

import type {
  AdaptedContentPart,
  AdaptedToolCallPart,
} from "@/lib/adapters/ai-elements-adapter"
import type { AgentToolCall, AgentType } from "@/lib/types"
import { useElapsedLabel } from "@/hooks/use-elapsed-label"
import { extractJsonField, tryParseJson } from "@/lib/activity/json"
import {
  isAsyncLaunchAckText,
  parseBackgroundTaskMarker,
} from "@/lib/background-agent"
import { useSessionViewerHost } from "./session-viewer-host-context"

/** Convert AgentToolCall[] to tool-call parts: the sub-agent's own steps, as
 *  its nested timeline draws them. */
function adaptToolCalls(
  calls: AgentToolCall[],
  parentId: string
): AdaptedToolCallPart[] {
  return calls.map((call, i) => ({
    type: "tool-call",
    toolCallId: `${parentId}-sub-${i}`,
    toolName: call.tool_name,
    input: call.input_preview ?? null,
    state: call.is_error ? "output-error" : "output-available",
    output: call.output_preview ?? null,
    errorText: call.is_error ? (call.output_preview ?? undefined) : undefined,
  }))
}

// A parsed JSON field is only usable here if it's a non-empty STRING. Some
// hosts (e.g. CodeBuddy) hand us inputs where `subagent_type` / `description`
// arrive as objects (or empty `{}`); the old `as string` casts let those leak
// straight into the rendered `title`, crashing React with "Objects are not
// valid as a React child". Coerce so a non-string field is treated as absent.
function asText(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null
}

interface TaskOutcomeEnvelope {
  durationMs: number | null
  isBackground: boolean
  error: string | null
}

// Cursor's live task completions carry a bare JSON envelope instead of report
// text: success → {durationMs, isBackground}, failure → {error} — and the
// wire status stays "completed" either way. `isTask` gates folding to inputs
// that prove the call is a Cursor task (the `_toolName:"task"` stamp): another
// agent's sub-agent legitimately returning `{"error":...}` text must render
// as-is, not get repainted as a failure. Shape stays exact-keys on top.
function parseTaskOutcomeEnvelope(
  output: string | null | undefined,
  isTask: boolean
): TaskOutcomeEnvelope | null {
  if (!isTask || !output) return null
  const trimmed = output.trim()
  if (!trimmed.startsWith("{")) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null
  }
  const obj = parsed as Record<string, unknown>
  const keys = Object.keys(obj)
  if (keys.length === 0) return null
  if (
    keys.every((k) => k === "durationMs" || k === "isBackground") &&
    (!("durationMs" in obj) || typeof obj.durationMs === "number") &&
    (!("isBackground" in obj) || typeof obj.isBackground === "boolean")
  ) {
    const duration = obj.durationMs
    return {
      durationMs:
        typeof duration === "number" && Number.isFinite(duration)
          ? duration
          : null,
      isBackground: obj.isBackground === true,
      error: null,
    }
  }
  if (
    keys.length === 1 &&
    keys[0] === "error" &&
    typeof obj.error === "string" &&
    obj.error.length > 0
  ) {
    return { durationMs: null, isBackground: false, error: obj.error }
  }
  return null
}

interface GrokSubagentProgress {
  durationMs: number | null
  turnCount: number | null
  toolCallCount: number | null
  contextUsagePct: number | null
}

/**
 * Grok's live sub-agent progress, forwarded by the backend as
 * `meta.grokSubagentProgress` on the launching Agent tool call
 * (`connection.rs::map_grok_subagent_notification`, from grok 0.2.11x's
 * `subagent_progress` ext notification). Grok never streams a child's chunks
 * or tool calls over ACP, so this ticker is the only live signal of what the
 * child is doing. `null` for any other meta shape.
 */
function parseGrokSubagentProgress(
  meta: Record<string, unknown> | null | undefined
): GrokSubagentProgress | null {
  if (!meta || typeof meta !== "object") return null
  const raw = (meta as Record<string, unknown>).grokSubagentProgress
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null
  const obj = raw as Record<string, unknown>
  const num = (v: unknown): number | null =>
    typeof v === "number" && Number.isFinite(v) ? v : null
  const progress: GrokSubagentProgress = {
    durationMs: num(obj.durationMs),
    turnCount: num(obj.turnCount),
    toolCallCount: num(obj.toolCallCount),
    contextUsagePct: num(obj.contextUsagePct),
  }
  return progress.durationMs != null ||
    progress.turnCount != null ||
    progress.toolCallCount != null ||
    progress.contextUsagePct != null
    ? progress
    : null
}

/**
 * The child's own session, when the sub-agent ran as a standalone session on
 * disk. TWO agents do this, and for the same reason: the child is a full
 * session that streams its transcript to disk while none of it is forwarded
 * over ACP, so opening that session is the ONLY way to see the child's work.
 *
 * Grok, live, arrives as `meta.grokSubagentSession.childSessionId`
 * (`connection.rs::grok_subagent_meta`, re-sent on every progress tick because
 * meta is replaced wholesale); in history it comes off the parsed
 * `agent_stats.child_session_id` (`parsers/grok.rs::subagent_stats`).
 *
 * Codex needs neither, because its child's thread id IS its rollout's id and
 * the card already carries it as `agent_id` — the badge and the session key are
 * the same string. Both of its paths already write it
 * (`connection.rs::classify_codex_subagent_activity` live,
 * `parsers/codex.rs::inject_agent_id_into_input` on reload), alongside the
 * launch marker that identifies the producer.
 *
 * The agent type is pinned per branch rather than read from the conversation:
 * the card has no conversation-level agent type of its own, and a parent's
 * child is a session of the parent's own kind in both cases. A third producer
 * of `child_session_id` is the line to revisit.
 */
function parseChildSessionId(
  meta: Record<string, unknown> | null | undefined,
  statsChildSessionId: string | null | undefined,
  codexSubagentId: string | null
): { sessionId: string; agentType: AgentType } | null {
  const raw = meta?.grokSubagentSession
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const live = (raw as Record<string, unknown>).childSessionId
    if (typeof live === "string" && live.length > 0) {
      return { sessionId: live, agentType: "grok" }
    }
  }
  if (statsChildSessionId && statsChildSessionId.length > 0) {
    return { sessionId: statsChildSessionId, agentType: "grok" }
  }
  return codexSubagentId
    ? { sessionId: codexSubagentId, agentType: "codex" }
    : null
}

export function useAgentCallModel(
  part: Extract<AdaptedContentPart, { type: "tool-call" }>
) {
  const t = useTranslations("Folder.chat.contentParts")
  const tTool = useTranslations("Folder.chat.tool")
  const tBg = useTranslations("Folder.chat.backgroundTasks")
  const elapsedLabel = useElapsedLabel()

  const isRunning =
    part.state === "input-available" || part.state === "input-streaming"
  const isError = part.state === "output-error"

  const parsed = useMemo(
    () => (part.input ? tryParseJson(part.input) : null),
    [part.input]
  )

  // Background sub-agent lifecycle. Historical/refetched turns carry the
  // parser's structured marker (settled state + summary + result folded from
  // the transcript's task-notification); a live turn still holds the raw wire
  // ack text, shown as "running in background" instead of being dumped. An
  // unsettled marker (null status) deliberately reads "result pending", not
  // "running" — the transcript alone can't prove the task is still alive.
  const backgroundLifecycle = useMemo(
    () => parseBackgroundTaskMarker(part.output),
    [part.output]
  )
  // Cursor task completion envelope — fold into the capsule chrome (duration
  // suffix / error box / background label) instead of dumping raw JSON into
  // the body. Gated on the live input's `_toolName:"task"` identity stamp.
  const taskOutcome = useMemo(
    () => parseTaskOutcomeEnvelope(part.output, parsed?._toolName === "task"),
    [part.output, parsed]
  )
  const outcomeError = taskOutcome?.error ?? null
  const outcomeBackground = taskOutcome?.isBackground === true
  // Grok live sub-agent ticker — the only live signal of the child's work
  // (grok forwards no child chunks/tool calls). Shown while the child runs:
  // in-turn for a blocking spawn, alongside the "running in background" state
  // for a background one (its ticks reach the promoted card out of turn, as
  // `background_task_progress`). Frozen values disappear with those states.
  const grokProgress = useMemo(
    () => parseGrokSubagentProgress(part.meta),
    [part.meta]
  )
  // Running in the background: the launch ack still stands for the card, or
  // the card holds the cold parse's pending marker but its child has ticked
  // since — first-hand word that it still runs, which the transcript alone
  // can't give.
  const isLiveBackgroundLaunch =
    (backgroundLifecycle === null &&
      part.state === "output-available" &&
      isAsyncLaunchAckText(part.output)) ||
    (backgroundLifecycle !== null &&
      backgroundLifecycle.status == null &&
      grokProgress !== null)
  const backgroundSettled = backgroundLifecycle?.status != null
  const backgroundFailed =
    backgroundSettled && backgroundLifecycle?.status !== "completed"

  // The child's timeline: the live transcript while it is attached (it stays
  // attached at settle), the parsed `agent_stats.timeline` once history
  // reloads from disk — same entries, same order.
  const transcript = useMemo(
    () => part.agentTranscript ?? [],
    [part.agentTranscript]
  )
  // A timeline is only worth drawing when it holds prose to interleave the
  // child's tool calls with. A transcript of tool markers alone (CodeBuddy's
  // child prose never reaches the client; position-matched children carry
  // none) has no order beyond the calls' own, which `agent_stats.tool_calls`
  // already keeps — such a card renders exactly like a stats-only one. Blank
  // prose renders nothing, so it counts as none.
  const hasTimeline = useMemo(
    () =>
      transcript.some(
        (entry) => entry.type !== "tool_call" && entry.text.trim() !== ""
      ),
    [transcript]
  )

  const subagentType = useMemo(
    () =>
      asText(parsed?.subagent_type) ??
      // Codex's live `spawn_agent` payload labels the agent with `agent_type`
      // instead of `subagent_type` (the historical parser already maps it
      // across). Read both so the prefix shows during streaming too.
      asText(parsed?.agent_type) ??
      // Cursor's live task payload carries `subagentType` as a protobuf-es
      // oneof object ({case: "generalPurpose", …}); its history parser emits
      // a plain snake_case string, so read the live case here for parity.
      asText(parsed?.subagentType) ??
      asText((parsed?.subagentType as { case?: unknown } | undefined)?.case) ??
      (part.input ? extractJsonField(part.input, "subagent_type") : null) ??
      (part.input ? extractJsonField(part.input, "agent_type") : null),
    [parsed, part.input]
  )

  const description = useMemo(
    () =>
      asText(parsed?.description) ??
      (part.input ? extractJsonField(part.input, "description") : null),
    [parsed, part.input]
  )

  const prompt = useMemo(
    () =>
      asText(parsed?.prompt) ??
      (part.input ? extractJsonField(part.input, "prompt") : null),
    [parsed, part.input]
  )

  // A Claude Code fork (`subagent_type: "fork"`) inherits the parent's
  // conversation, model and effort: the Agent tool's schema says a `model` or
  // `effort` argument is ignored for a fork. claude-agent-acp 0.94.0 (CLI
  // 2.1.303) offers forks in every session, so the card must not present either
  // argument as a setting the sub-agent ran with. Read from Claude's own field
  // only: another agent's type field (Codex's `agent_type`, Cursor's
  // `subagentType`) may name a role "fork" that does honour both.
  const isClaudeFork =
    (asText(parsed?.subagent_type) ??
      (part.input ? extractJsonField(part.input, "subagent_type") : null)) ===
    "fork"

  const model = useMemo(
    () =>
      isClaudeFork
        ? null
        : (asText(parsed?.model) ??
          (part.input ? extractJsonField(part.input, "model") : null)),
    [isClaudeFork, parsed, part.input]
  )

  // Claude Code's Agent tool takes an `effort` (CLI 2.1.292+): the level the
  // sub-agent runs at, set only when the user asked for one.
  const effort = useMemo(
    () =>
      isClaudeFork
        ? null
        : (asText(parsed?.effort) ??
          (part.input ? extractJsonField(part.input, "effort") : null)),
    [isClaudeFork, parsed, part.input]
  )

  // codex 0.147's native team-of-agents marks its capsules as LAUNCH-only
  // (`CODEX_SUBAGENT_LAUNCH_KEY`, written by both the live path and the rollout
  // parser). The card settles when codex acknowledges the spawn, which is not
  // when the child finishes — an asynchronous child can still be working long
  // after. Say so, rather than let a green "completed" claim the sub-agent is
  // done.
  const isCodexSubagent = parsed?.__codegCodexSubagentLaunch === true

  // …and codex DOES eventually say how the child ended
  // (`SubAgentActivity{kind}`), which both paths stamp here. Present only once
  // that has been heard; while it is absent the child's fate is genuinely
  // unknown, which is what the launch note describes.
  const codexSubagentState = asText(parsed?.__codegCodexSubagentState)

  // codex spawn capsules carry the sub-agent's UUID (`agent_id`); show it in the
  // pill so the execution capsule reads uniformly with the live/wait collab
  // capsules. Other agents (e.g. Claude Task) have no `agent_id` → no badge.
  const agentId = useMemo(
    () =>
      asText(parsed?.agent_id) ??
      (part.input ? extractJsonField(part.input, "agent_id") : null),
    [parsed, part.input]
  )

  const title = useMemo(() => {
    if (subagentType) {
      return description ? `${subagentType}: ${description}` : subagentType
    }
    // The sub-agent type hasn't streamed in yet. Prefer the description if it
    // has already arrived, and only fall back to the "starting…" placeholder
    // when there's genuinely nothing to show — never prepend it to a title
    // that already carries real content.
    return description || t("agentFallbackTitle")
  }, [subagentType, description, t])

  const statusLabel = backgroundLifecycle
    ? backgroundFailed
      ? tBg("cardFinishedWithStatus", {
          status: backgroundLifecycle.status ?? "",
        })
      : backgroundSettled
        ? // The sub-agent said it will notify again: its result may be
          // interim. Neither "completed" nor "running" (the transcript can't
          // prove it still runs).
          backgroundLifecycle.interim
          ? tBg("cardInterim")
          : tBg("cardCompleted")
        : isLiveBackgroundLaunch
          ? tBg("cardRunning")
          : tBg("cardLaunchedPending")
    : isLiveBackgroundLaunch
      ? tBg("cardRunning")
      : outcomeError
        ? // Cursor reports a failed task with wire status "completed"; the
          // error envelope is the only failure signal.
          tTool("status.outputError")
        : outcomeBackground
          ? // A background task's completion envelope only acknowledges the
            // launch — the sub-agent is still running.
            tBg("cardRunning")
          : part.state === "input-available"
            ? tTool("status.inputAvailable")
            : part.state === "input-streaming"
              ? tTool("status.inputStreaming")
              : part.state === "output-available"
                ? tTool("status.outputAvailable")
                : tTool("status.outputError")

  const agentStats = part.agentStats ?? null
  const adaptedToolCalls = useMemo(
    () => adaptToolCalls(agentStats?.tool_calls ?? [], part.toolCallId),
    [agentStats?.tool_calls, part.toolCallId]
  )

  // The child's own session, when it has one (grok, codex). Available live —
  // from the spawn notification's meta / id — as well as in history, so a
  // running child can be watched while it works instead of only after it
  // reports back.
  const childSession = useMemo(
    () =>
      parseChildSessionId(
        part.meta,
        agentStats?.child_session_id,
        isCodexSubagent ? agentId : null
      ),
    [part.meta, agentStats?.child_session_id, isCodexSubagent, agentId]
  )
  const viewerHost = useSessionViewerHost()
  const [sessionOpen, setSessionOpen] = useState(false)
  const grokProgressLine = useMemo(() => {
    if (!grokProgress) return null
    const pieces: string[] = []
    if (grokProgress.toolCallCount != null) {
      pieces.push(
        t("agentProgressTools", { count: grokProgress.toolCallCount })
      )
    }
    if (grokProgress.turnCount != null) {
      pieces.push(t("agentProgressTurns", { count: grokProgress.turnCount }))
    }
    const took = elapsedLabel(grokProgress.durationMs)
    if (took) pieces.push(took)
    if (grokProgress.contextUsagePct != null) {
      pieces.push(
        t("agentProgressContext", {
          pct: Math.round(grokProgress.contextUsagePct),
        })
      )
    }
    return pieces.length > 0 ? pieces.join(" · ") : null
  }, [grokProgress, t, elapsedLabel])

  const durationSuffix = elapsedLabel(
    agentStats?.total_duration_ms || taskOutcome?.durationMs
  )

  // Opening the child's transcript is capsule-level, not body-level: while it
  // runs (and, for codex, even after) the child's session is the only record of
  // its work, so the entry point must not depend on the capsule having a body
  // to expand. Same handler as the body version it replaces.
  const openChildSession = useMemo(() => {
    if (!childSession) return null
    return () =>
      // Preferred: the transcript-level host, which survives this card
      // scrolling out of the virtual list. Falls back to owning the drawer here
      // when there is no host (this part also renders inside the grok child
      // transcript, which is not virtualized).
      viewerHost
        ? viewerHost.open({
            kind: "agentSession",
            sessionId: childSession.sessionId,
            agentType: childSession.agentType,
            subagentType,
            description,
            // Keep re-reading the child's transcript from disk while its launch
            // call is unsettled or the background child is still out. A snapshot
            // once handed over — see the note on `AgentSessionRequest.live`.
            live: isRunning || isLiveBackgroundLaunch,
          })
        : setSessionOpen(true)
  }, [
    childSession,
    viewerHost,
    subagentType,
    description,
    isRunning,
    isLiveBackgroundLaunch,
  ])

  return {
    isRunning,
    isError,
    parsed,
    backgroundLifecycle,
    taskOutcome,
    outcomeError,
    outcomeBackground,
    isLiveBackgroundLaunch,
    backgroundSettled,
    backgroundFailed,
    transcript,
    hasTimeline,
    subagentType,
    description,
    prompt,
    model,
    effort,
    isCodexSubagent,
    codexSubagentState,
    agentId,
    title,
    statusLabel,
    agentStats,
    adaptedToolCalls,
    grokProgress,
    childSession,
    viewerHost,
    sessionOpen,
    setSessionOpen,
    grokProgressLine,
    durationSuffix,
    openChildSession,
  }
}

export type AgentCallModel = ReturnType<typeof useAgentCallModel>
