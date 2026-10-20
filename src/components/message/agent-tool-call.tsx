import { memo, useMemo, useState, type ReactNode } from "react"
import type { AdaptedContentPart } from "@/lib/adapters/ai-elements-adapter"
import type {
  AgentToolCall,
  AgentTranscriptEntry,
  AgentType,
} from "@/lib/types"
import { tryParseJson, extractJsonField } from "./content-parts-renderer"
import {
  groupConsecutiveToolRuns,
  ToolGroupPart,
  type AdaptedToolCallPart,
} from "./tool-group-part"
import { SubagentSessionDialog } from "./subagent-session-dialog"
import { useSessionViewerHost } from "./session-viewer-host"
import { shortAgentId } from "@/lib/collab-tool"
import { MessageResponse } from "@/components/ai-elements/message"
import {
  Reasoning,
  ReasoningContent,
  ReasoningTrigger,
} from "@/components/ai-elements/reasoning"
import { Shimmer } from "@/components/ai-elements/shimmer"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/instant-collapsible"
import { cn } from "@/lib/utils"
import {
  CheckIcon,
  ChevronRightIcon,
  CircleDashed,
  Clock3,
  Loader2,
  OctagonX,
} from "lucide-react"
import { useTranslations } from "next-intl"
import { AgentCapsule } from "./agent-capsule"
import { SubagentSessionButton } from "./subagent-session-button"
import {
  isAsyncLaunchAckText,
  parseBackgroundTaskMarker,
} from "@/lib/background-agent"
import { unwrapWholeFence } from "@/lib/fenced-text"

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const sec = ms / 1000
  if (sec < 60) return `${sec.toFixed(1)}s`
  return `${(sec / 60).toFixed(1)}m`
}

/** Convert AgentToolCall[] to AdaptedContentPart[] for reuse with ToolCallPart */
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

/** Render bound for the RUNNING card's PROSE — the DATA is uncapped. While the
 *  card runs only the newest thinking/text entries render (prose splits at
 *  every child tool call, so a long sub-agent outgrows any fixed count; this
 *  keeps the live view a tail). The child's tool-call markers are never
 *  dropped: every call stays reachable in its pill, as it was before the
 *  timeline existed. Once the card settles the bound does NOT apply: the full
 *  arrival order is the point of the settled view, so history renders every
 *  entry. */
const AGENT_TRANSCRIPT_RENDER_TAIL = 20

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

/**
 * How the codex sub-agent itself ended, as a pill chip.
 *
 * Separate from the capsule's own status chrome, and deliberately so: the card
 * settles when codex acknowledges the LAUNCH, so its "completed" says nothing
 * about the child, which may still be working. codex reports the real outcome
 * later as `SubAgentActivity{kind}` — live via `settle_codex_subagent_launch`,
 * on reload via the rollout parser — and both write it to the same key.
 *
 * `null` (no outcome heard yet) is a state in its own right, not an absence:
 * the child's fate is genuinely unknown, and saying so is the whole reason this
 * chip exists. That case keeps the full explanation in the body, since a
 * two-word chip cannot carry a caveat.
 */
function CodexSubagentStateBadge({ state }: { state: string | null }) {
  const t = useTranslations("Folder.chat.contentParts")
  const [Icon, label, tone] =
    state === "completed"
      ? ([CheckIcon, t("agentSubagentDone"), "text-green-600"] as const)
      : state === "interrupted"
        ? ([OctagonX, t("agentSubagentInterrupted"), "text-amber-500"] as const)
        : ([
            CircleDashed,
            t("agentSubagentUnknown"),
            "text-muted-foreground/70",
          ] as const)

  return (
    <span className="inline-flex items-center gap-1 text-3xs font-normal text-muted-foreground">
      <Icon aria-hidden className={cn("size-3 shrink-0", tone)} />
      {label}
    </span>
  )
}

// ── main component ────────────────────────────────────────────────────

export const AgentToolCallPart = memo(function AgentToolCallPart({
  part,
  renderToolCall,
}: {
  part: Extract<AdaptedContentPart, { type: "tool-call" }>
  /** Render a single tool-call part — injected by the parent to avoid
   *  circular imports (content-parts-renderer → agent-tool-call → renderer). */
  renderToolCall: (
    part: Extract<AdaptedContentPart, { type: "tool-call" }>,
    key: string
  ) => ReactNode
}) {
  const t = useTranslations("Folder.chat.contentParts")
  const tTool = useTranslations("Folder.chat.tool")
  const tBg = useTranslations("Folder.chat.backgroundTasks")

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
  const isLiveBackgroundLaunch =
    backgroundLifecycle === null &&
    part.state === "output-available" &&
    isAsyncLaunchAckText(part.output)
  const backgroundSettled = backgroundLifecycle?.status != null
  const backgroundFailed =
    backgroundSettled && backgroundLifecycle?.status !== "completed"

  const [promptOpen, setPromptOpen] = useState(false)
  // Settled cards lead with the conclusion; the timeline pill starts closed.
  const [timelineOpen, setTimelineOpen] = useState(false)

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

  // The timeline's display stream: tool_call markers materialize into their
  // child cards and consecutive ones collapse into one pill group (a text or
  // thinking entry breaks the run — same semantics as the main thread's
  // grouping); prose/thinking stay standalone in arrival order. A marker
  // pointing outside `adaptedToolCalls` is dropped rather than rendered as a
  // hole. While the card runs, prose older than the newest
  // AGENT_TRANSCRIPT_RENDER_TAIL entries is skipped; markers never are.
  //
  // Every item carries its index in the WHOLE transcript (`at`) and is keyed
  // by it. Keying by the position in what is visible would hand an entry's
  // component to its neighbour each time the tail slides: an opened
  // <Reasoning> would fold, and Streamdown — which memoizes its elements on
  // source position alone — would keep painting the previous entry's words.
  const transcriptSegments = useMemo(() => {
    if (!hasTimeline) return []
    const proseCount = transcript.filter(
      (entry) => entry.type !== "tool_call"
    ).length
    let proseToSkip = isRunning
      ? Math.max(0, proseCount - AGENT_TRANSCRIPT_RENDER_TAIL)
      : 0
    const display: Array<{
      call?: { part: AdaptedToolCallPart; at: number }
      other?: {
        entry: Extract<AgentTranscriptEntry, { type: "text" | "thinking" }>
        at: number
      }
    }> = []
    transcript.forEach((entry, at) => {
      if (entry.type === "tool_call") {
        const tc = adaptedToolCalls[entry.childIndex]
        if (tc) display.push({ call: { part: tc, at } })
        return
      }
      if (proseToSkip > 0) {
        proseToSkip -= 1
        return
      }
      display.push({ other: { entry, at } })
    })
    return groupConsecutiveToolRuns(display)
  }, [hasTimeline, transcript, isRunning, adaptedToolCalls])

  const transcriptSegmentNodes = transcriptSegments.map((segment) => {
    if (segment.kind === "calls") {
      return (
        <ToolGroupPart
          key={`subagent-embed-group-${segment.calls[0].at}`}
          part={{
            type: "tool-group",
            items: segment.calls.map((call) => call.part),
            isStreaming: isRunning,
          }}
          renderItem={renderToolCall}
        />
      )
    }
    const { entry, at } = segment.value
    if (entry.type === "thinking") {
      return entry.text.trim() ? (
        // Folded like the main thread's thinking (same contract as
        // <ReasoningPart>): a subagent's reasoning is reference
        // material — it stays collapsed until the reader opens it. The
        // running card's newest entry is the thought still being written,
        // so it reads "Thinking…" until anything follows it.
        <Reasoning
          key={`subagent-embed-${at}`}
          isStreaming={isRunning && at === transcript.length - 1}
        >
          <ReasoningTrigger />
          <ReasoningContent>{entry.text}</ReasoningContent>
        </Reasoning>
      ) : null
    }
    return (
      <div
        key={`subagent-embed-${at}`}
        className="text-sm prose prose-sm dark:prose-invert max-w-none [&_ul]:list-inside [&_ol]:list-inside"
      >
        <MessageResponse>{entry.text}</MessageResponse>
      </div>
    )
  })

  // Grok live sub-agent ticker — the only live signal of the child's work
  // (grok forwards no child chunks/tool calls). Shown while the child runs:
  // in-turn for a blocking spawn, alongside the "running in background" state
  // for a background one. Frozen values disappear with those states.
  const grokProgress = useMemo(
    () => parseGrokSubagentProgress(part.meta),
    [part.meta]
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
    if (grokProgress.durationMs != null) {
      pieces.push(formatDuration(grokProgress.durationMs))
    }
    if (grokProgress.contextUsagePct != null) {
      pieces.push(
        t("agentProgressContext", {
          pct: Math.round(grokProgress.contextUsagePct),
        })
      )
    }
    return pieces.length > 0 ? pieces.join(" · ") : null
  }, [grokProgress, t])

  const durationSuffix = useMemo(() => {
    if (agentStats?.total_duration_ms) {
      return formatDuration(agentStats.total_duration_ms)
    }
    if (taskOutcome?.durationMs != null) {
      return formatDuration(taskOutcome.durationMs)
    }
    return null
  }, [agentStats, taskOutcome])

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

  return (
    <>
      <AgentCapsule
        title={title}
        isRunning={isRunning || isLiveBackgroundLaunch || outcomeBackground}
        isError={isError || backgroundFailed || outcomeError != null}
        rightSuffix={durationSuffix}
        idBadge={agentId ? shortAgentId(agentId) : null}
        // codex only: the launch capsule's own state describes the spawn, so the
        // child's outcome needs a chip of its own. Held back while the spawn is
        // still in flight — there is nothing to report yet.
        stateBadge={
          isCodexSubagent && !isRunning ? (
            <CodexSubagentStateBadge state={codexSubagentState} />
          ) : null
        }
        headerAction={
          openChildSession ? (
            <SubagentSessionButton onClick={openChildSession} />
          ) : null
        }
        statusLabel={statusLabel}
      >
        {/* Model and effort summary */}
        {(model || effort) && (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
            {model && (
              <span>
                {t("agentModelLabel")}:{" "}
                <span className="font-mono">{model}</span>
              </span>
            )}
            {effort && (
              <span>
                {t("agentEffortLabel")}:{" "}
                <span className="font-mono">{effort}</span>
              </span>
            )}
          </div>
        )}

        {/* Collapsible prompt */}
        {prompt && (
          <Collapsible open={promptOpen} onOpenChange={setPromptOpen}>
            <CollapsibleTrigger className="flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors">
              <ChevronRightIcon
                aria-hidden="true"
                className={cn(
                  "size-3.5 transition-transform",
                  promptOpen && "rotate-90"
                )}
              />
              {t("agentPromptLabel")}
            </CollapsibleTrigger>
            <CollapsibleContent>
              <div className="mt-2 rounded-md bg-muted/50 p-3 text-xs text-muted-foreground prose prose-sm dark:prose-invert max-w-none [&_ul]:list-inside [&_ol]:list-inside">
                <MessageResponse>{prompt}</MessageResponse>
              </div>
            </CollapsibleContent>
          </Collapsible>
        )}

        {/* Child tool calls when no timeline carries them in position — a
      card whose stats predate timelines, whose child transcript was never
      parsed, or whose transcript holds no prose to interleave them with.
      Rendered through the same pill group the main thread folds consecutive
      tool calls into, single calls included. */}
        {adaptedToolCalls.length > 0 && !hasTimeline && (
          <ToolGroupPart
            key="subagent-tc-group"
            part={{
              type: "tool-group",
              items: adaptedToolCalls,
              isStreaming: isRunning,
            }}
            renderItem={renderToolCall}
          />
        )}

        {/* The child's mixed timeline — thinking/text/child-tool markers in
          arrival order (claude-agent-acp ≥0.63 live, or the child's own JSONL
          parsed into `agent_stats.timeline` on history). While the card runs
          it streams in place (prose tail-bounded) under the live heading; once
          the card settles the whole interleaved record collapses into one pill,
          closed by default — the finished card leads with its conclusion, and
          the process is one click away. That is the settled shape every host
          converges on: Claude Code's `Done (N tool uses · …)` line, codex's
          `⌃t to view transcript`, ZCode's permanently compact capsule. The
          tail bound never applies to settled data.
          The pill's summary prefers the child's total duration (the
          transcript's own span, or the task-reported one); the entry count is
          the fallback for agents that supply neither. Right after settle the
          detail may not have landed yet, so the count can show until
          FETCH_DETAIL_SUCCESS re-renders the card with parsed stats. */}
        {hasTimeline &&
          (isRunning ? (
            <div className="space-y-1.5">
              <div className="text-3xs font-medium uppercase tracking-wide text-muted-foreground/70">
                {t("agentLiveTranscript")}
              </div>
              {transcriptSegmentNodes}
            </div>
          ) : (
            <Collapsible
              open={timelineOpen}
              onOpenChange={setTimelineOpen}
              className="w-full"
            >
              <CollapsibleTrigger
                className={cn(
                  "group inline-flex max-w-full items-center gap-1.5 rounded-full bg-muted/60 px-3.5 py-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground ws-msg-chip"
                )}
              >
                <ChevronRightIcon
                  aria-hidden="true"
                  className={cn(
                    "size-3 shrink-0 opacity-60 transition-transform",
                    timelineOpen && "rotate-90"
                  )}
                />
                <span className="min-w-0 truncate">
                  {agentStats?.total_duration_ms
                    ? t("agentProcessDuration", {
                        duration: formatDuration(agentStats.total_duration_ms),
                      })
                    : t("agentProcessCount", {
                        count: transcript.length,
                      })}
                </span>
              </CollapsibleTrigger>
              <CollapsibleContent
                className={cn(
                  "w-full outline-none",
                  "data-[state=open]:animate-in data-[state=closed]:animate-out",
                  "data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
                  "data-[state=closed]:slide-out-to-top-1 data-[state=open]:slide-in-from-top-1"
                )}
              >
                <div className="mt-3 w-full space-y-3">
                  {transcriptSegmentNodes}
                </div>
              </CollapsibleContent>
            </Collapsible>
          ))}

        {/* Running indicator (in-turn streaming, a live background launch whose
          ack just replaced the stream, or a cursor background-task envelope) */}
        {((isRunning && !part.output) ||
          isLiveBackgroundLaunch ||
          outcomeBackground) && (
          <div className="flex items-center gap-2">
            <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
            <Shimmer
              className="text-sm"
              duration={1}
              shineColor="var(--primary)"
            >
              {isLiveBackgroundLaunch || outcomeBackground
                ? tBg("cardRunning")
                : t("agentRunning")}
            </Shimmer>
          </div>
        )}

        {/* codex native sub-agent whose outcome codex has NOT reported. The chip
          can only say "unknown"; the caveat behind it needs a sentence, because
          the card would otherwise read as "the sub-agent finished" when all
          that finished was the launch. Settled outcomes say it in the chip
          instead and add nothing here — which is what lets a live capsule with
          no result collapse to a bare pill rather than an empty frame. */}
        {isCodexSubagent && !isRunning && codexSubagentState === null && (
          <div className="text-xs text-muted-foreground">
            {t("agentCodexLaunchOnly")}
          </div>
        )}

        {/* Grok live sub-agent ticker (`subagent_progress`) — only while the
          child is still running; the settled card renders stats/result. */}
        {(isRunning || isLiveBackgroundLaunch) && grokProgressLine && (
          <div className="text-xs text-muted-foreground">
            {grokProgressLine}
          </div>
        )}

        {/* Error output */}
        {isError && part.errorText && (
          <div className="rounded-md bg-destructive/10 p-3">
            <pre className="whitespace-pre-wrap break-words text-xs text-destructive">
              {unwrapWholeFence(part.errorText)}
            </pre>
          </div>
        )}

        {/* Orphaned result recovery: a turn the provider killed mid-flight
          leaves its pending async Agent calls as errors ("no result") while
          the children actually finished — their reports exist only in the
          task files the parser recovered into `recovered_result`. Rendered
          ONLY on an errored card whose child's task COMPLETED: a normally
          completed async child delivered its result via the notification
          turn, and a task that did not complete holds no report — Qoder files
          the error message there for `failed`/`cancelled`, and a placeholder
          for a dead process's task it rewrites to `interrupted`. */}
        {isError &&
          agentStats?.status === "completed" &&
          agentStats.recovered_result && (
            <div className="space-y-2">
              <div className="text-xs text-muted-foreground">
                {t("agentRecoveredNote")}
              </div>
              <div className="text-sm prose prose-sm dark:prose-invert max-w-none [&_ul]:list-inside [&_ol]:list-inside">
                <MessageResponse>{agentStats.recovered_result}</MessageResponse>
              </div>
            </div>
          )}

        {/* Cursor task failure envelope ({error}) — the wire marks the call
          "completed", so this renders where the error styling belongs. */}
        {outcomeError && !isError && (
          <div className="rounded-md bg-destructive/10 p-3">
            <pre className="whitespace-pre-wrap break-words text-xs text-destructive">
              {outcomeError}
            </pre>
          </div>
        )}

        {/* Background lifecycle: settled summary + folded result markdown, or a
          neutral "result pending" line for an unsettled launch. Never dumps
          the marker/ack text. */}
        {backgroundLifecycle && !isError && (
          <div className="space-y-2">
            {backgroundLifecycle.summary && (
              <div className="text-xs text-muted-foreground">
                {backgroundLifecycle.summary}
              </div>
            )}
            {backgroundLifecycle.result ? (
              <div className="text-sm prose prose-sm dark:prose-invert max-w-none [&_ul]:list-inside [&_ol]:list-inside">
                <MessageResponse>{backgroundLifecycle.result}</MessageResponse>
              </div>
            ) : !backgroundSettled ? (
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Clock3 className="size-3.5 shrink-0" />
                {tBg("cardResultPending")}
              </div>
            ) : null}
          </div>
        )}

        {/* Final output. A folded task-outcome envelope renders via the
          capsule chrome above (duration suffix / error box), never as body. */}
        {part.output &&
          !isError &&
          !taskOutcome &&
          !backgroundLifecycle &&
          !isLiveBackgroundLaunch && (
            <div className="text-sm prose prose-sm dark:prose-invert max-w-none [&_ul]:list-inside [&_ol]:list-inside">
              <MessageResponse>{part.output}</MessageResponse>
            </div>
          )}
      </AgentCapsule>

      {/* The drawer the header action opens when this card has to own it (no
          `SessionViewerHost` above — see `openChildSession`). A SIBLING of the
          capsule, never one of its children: the capsule counts its children to
          decide whether it has a body, so mounting the drawer inside would grow
          a chevron and a bordered frame the moment the drawer opened — and a
          bodyless capsule never renders its children at all, which is exactly
          the live case this drawer exists for. */}
      {childSession && viewerHost == null && sessionOpen && (
        <SubagentSessionDialog
          open={sessionOpen}
          onOpenChange={setSessionOpen}
          sessionId={childSession.sessionId}
          agentType={childSession.agentType}
          subagentType={subagentType}
          description={description}
          live={isRunning || isLiveBackgroundLaunch}
        />
      )}
    </>
  )
})
