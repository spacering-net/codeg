"use client"

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  isLiveTurnId,
  selectTimelineTurns,
  useConversationRuntimeActions,
  useConversationRuntimeStore,
} from "@/stores/conversation-runtime-store"
import { isWindowedDetail } from "@/lib/turn-window"
import { CompletedTurnContent } from "./completed-turn-content"
import { ContextCompactionCard } from "./context-compaction-card"
import { CollapsibleUserMessage } from "./collapsible-user-message"
import { CollapsibleSystemMessage } from "./collapsible-system-message"
import {
  contextCompactionPayload,
  contextCompactionSummary,
  isContextCompactionMeta,
} from "@/lib/context-compaction"
import {
  createMessageTurnAdapter,
  groupGoalRuns,
  mergeAdjacentToolGroups,
  mergeAdjacentDelegationStatusGroups,
  mergeAdjacentBackgroundTaskGroups,
  type AdaptedContentPart,
  type AdaptedMessage,
  type MessageTurnAdapter,
  type ToolCallState,
  type UserImageDisplay,
  type UserResourceDisplay,
} from "@/lib/adapters/ai-elements-adapter"
import { TurnStats } from "./turn-stats"
import { LiveTurnStats } from "./live-turn-stats"
import { ModelLabelProvider } from "./model-label-context"
import { ReplyArtifacts } from "./reply-artifacts"
import { UserResourceLinks } from "./user-resource-links"
import { UserImageAttachments } from "./user-image-attachments"
import { AgentPlanOverlay } from "@/components/chat/agent-plan-overlay"
import { SubAgentOverlay } from "@/components/chat/sub-agent-overlay"
import { SessionViewerHost } from "@/components/message/session-viewer-host"
import { normalizeToolName } from "@/lib/tool-call-normalization"
import { parseResumeTaskId } from "@/lib/codeg-mcp-tool"
import {
  isDelegateToAgentToolName,
  isRefusedResume,
} from "@/lib/delegation-card"
import type { DelegationCardSource } from "@/hooks/use-delegation-card-model"
import {
  MessageThread,
  MessageThreadScrollButton,
} from "@/components/ai-elements/message-thread"
import {
  Message,
  MessageContent,
  MessageAction,
} from "@/components/ai-elements/message"
import {
  AlertCircle,
  CheckIcon,
  CopyIcon,
  Loader2,
  Plus,
  RefreshCw,
  ListTodo,
} from "lucide-react"
import { useCreateTaskFromMessage } from "./use-create-task-from-message"
import { Button } from "@/components/ui/button"
import { useTranslations } from "next-intl"
import {
  buildPlanKey,
  extractLatestPlanEntriesFromMessages,
} from "@/lib/agent-plan"
import type { AgentType, ConnectionStatus, MessageTurn } from "@/lib/types"
import { copyTextToClipboard } from "@/lib/utils"
import { VirtualizedMessageThread } from "@/components/message/virtualized-message-thread"
import { SelectionActionBubble } from "@/components/message/selection-action-bubble"
import {
  ConversationMessageNav,
  type MessageNavEntry,
} from "@/components/message/conversation-message-nav"
import type { MessageScrollContextValue } from "@/components/message/message-scroll-context"
import { extractSessionFilesGrouped } from "@/lib/session-files"
import { useModelLabels } from "@/hooks/use-model-labels"
import { usePageHandoffName } from "@/lib/browser/use-page-handoff-name"
import { unescapeComposerText } from "@/lib/composer-copy-text"
import { useStickToBottomContext } from "use-stick-to-bottom"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"
import { MarkdownImageProvider } from "@/components/ai-elements/markdown-local-image"

interface MessageListViewProps {
  conversationId: number
  /** This transcript's working directory, including new-chat drafts. */
  imageRoot?: string | null
  agentType: AgentType
  connStatus?: ConnectionStatus | null
  isActive?: boolean
  sendSignal?: number
  detailLoading?: boolean
  detailError?: string | null
  /**
   * Set when the agent rejected `session/load` non-recoverably (e.g. the
   * historical session_id was deleted, or the conversation's folder is gone).
   * Replaces the message area only when nothing is renderable; when the local
   * DB has the message history, the transcript stays visible and the owning
   * panel surfaces this error as a banner in the composer area instead (with
   * Reload / New session actions), since the agent can't continue the thread.
   */
  acpLoadError?: string | null
  hideEmptyState?: boolean
  onReload?: () => void
  onNewSession?: () => void
  /**
   * Renders the per-conversation message navigator rail. Enabled in the main
   * conversation view; disabled in compact embeds (e.g. the sub-agent dialog).
   */
  showMessageNav?: boolean
  /**
   * Optional phase label for a user turn (work-task transcripts label each
   * engine-dispatched round: work / retry / return / merge). Called at render
   * time per user-role turn; MUST be pure — the thread is virtualized, so
   * items render in arbitrary order and multiplicity. `null` = no divider.
   */
  userTurnHeader?: ((group: ResolvedMessageGroup) => string | null) | null
  /**
   * Quote a text selection made in this transcript into the conversation
   * composer. Enables the "quote" entry on the selection bubble; omitted on
   * read-only surfaces (sub-agent dialog, task transcripts), which then offer
   * copy alone. MUST be referentially stable.
   */
  onQuoteSelection?: (text: string) => void
  /**
   * Ask a question about a text selection made in this transcript: the host
   * opens a new conversation on the same agent and sends the quoted selection
   * followed by the question. Enables the "ask" entry on the selection bubble,
   * on the same terms as `onQuoteSelection`. MUST be referentially stable.
   */
  onAskSelection?: (selection: string, question: string) => void
  /**
   * Keep a text selection from this transcript as a note next to it. Only the
   * canvas has a board to put one on, so every other surface omits it and the
   * action isn't offered. MUST be referentially stable.
   */
  onSaveNoteSelection?: (text: string) => void
  /**
   * Fork the session at a rendered assistant turn ("fork from here"). Undefined
   * hides the affordance everywhere in this view — pass it only where a fork
   * can actually run (live connection, agent supports `session/fork`). Embeds
   * that are not the owning conversation surface leave it unset.
   *
   * "No turn in flight" is deliberately NOT part of this gate: that condition
   * is transient and comes back, so the view renders it as a disabled button
   * (see `forkBusy`) rather than making every reply's footer flicker.
   */
  onForkFromTurn?: (turnId: string) => void
}

export interface ResolvedMessageGroup {
  id: string
  role: "user" | "assistant" | "system"
  parts: AdaptedContentPart[]
  resources: UserResourceDisplay[]
  images: UserImageDisplay[]
  usage?: import("@/lib/types").TurnUsage | null
  duration_ms?: number | null
  model?: string | null
  models?: string[]
  /**
   * Wall-clock completion time supplied by the Rust parser. For merged
   * sub-turns this is the latest non-null completion across the run — the
   * post-turn metadata patch may sit on any sub-turn, not just the last.
   */
  completed_at?: string | null
}

export type ThreadRenderItem =
  | {
      key: string
      kind: "turn"
      group: ResolvedMessageGroup
      phase: "persisted" | "optimistic" | "streaming"
      isResponseComplete: boolean
      showStats: boolean
      isRoleTransition: boolean
      previousUserIndex: number | null
      /** The newest assistant reply in the thread. Together with the view's
       *  `armed` flag this is what makes a run "the current round" — see the
       *  fold state below. */
      isLastAssistantRun: boolean
      /** Nothing follows this item in the thread — not a user message, not a
       *  compaction divider. Distinct from `isLastAssistantRun`, which is still
       *  true for a reply the user interrupted at its very end (that promotes
       *  as assistant then user message, so the newest REPLY is not the tail).
       *  Read by the fork gate, where the two differ by a wrong fork point. */
      isThreadTail: boolean
      /** Raw assistant sub-turn(s) that compose this reply — fed to the
       *  per-reply artifacts card so it can list files changed this reply. */
      sourceTurns: MessageTurn[]
    }
  | {
      key: string
      kind: "typing"
    }
  | {
      // A context-compaction event hoisted OUT of an assistant turn into its own
      // standalone timeline element. In history the compaction lands as its own
      // (assistant-role) turn between the reply that preceded `/compact` and the
      // next message; rendering it as a "turn" would let
      // `mergeConsecutiveAssistantTurns` fold it into the preceding reply (so the
      // divider showed up wedged before that reply's file cards + footer). As a
      // dedicated kind it breaks the assistant-merge run and renders as a
      // chrome-less centered divider in the correct between-turns position.
      key: string
      kind: "compaction"
      meta: Record<string, unknown> | null
      /** The retained summary, when the backend claimed one for this call
       *  (see `contextCompactionSummary`). */
      summary?: string | null
      /** The call's lifecycle, so a `/compact` still running reads as
       *  compacting and its summary streams. */
      state?: ToolCallState
    }

/**
 * Fold state for a thread's assistant replies, owned by the view rather than by
 * the turns themselves.
 *
 * - `armed` — the agent has started replying since the last send, so the newest
 *   assistant run is "the current round" and shows expanded. Within an epoch it
 *   only ever latches TRUE: a round must not fold itself up the moment it
 *   finishes.
 * - `roundOpen` — that round's toggle, so folding it by hand sticks through the
 *   re-adaptations a reply goes through on its way into history.
 * - `epoch` — bumped on every send. `CompletedTurnContent` stamps its manual
 *   fold overrides with it, so one bump folds every reply above the new message
 *   without having to walk the thread.
 *
 * Positional (the newest run) on purpose: a reply's identity changes twice on
 * the way into history — the stream settling into a promoted local turn, then
 * the authoritative detail refetch renaming it — so an id-keyed flag would drop
 * the expansion mid-read, which is the "it folds itself up as soon as it
 * finishes" behaviour this replaces.
 */
export interface ReplyFoldState {
  signal: number
  epoch: number
  armed: boolean
  /**
   * Last observed running flag. A new round has to be detected as an EDGE, not
   * a level: `armed` latches for the life of a round, so on its own it cannot
   * see round two begin.
   */
  running: boolean
  /**
   * Id of the reply this round was armed on, so a rising `running` edge can be
   * told apart from the SAME reply resuming. Only ever compared on that edge.
   */
  runId: string | null
  roundOpen: boolean
}

/** One render's observation of the thread, fed to `advanceReplyFold`. */
export interface ReplyFoldInput {
  sendSignal: number
  /** The newest assistant reply is still being written. */
  running: boolean
  /**
   * Identity of the reply being written: the live message's id, or null when
   * nothing is streaming locally (a passive viewer reading a round the backend
   * flags in-flight, where every rising edge really is a new round).
   *
   * Deliberately NOT the render item's id. A render item is a presentation
   * block: `mergeConsecutiveAssistantTurns` folds consecutive assistant runs
   * into one and pins its id to the FIRST member, so a settled reply and a
   * brand-new streaming one that merge behind it (background / loop turns,
   * which arrive with no user turn between) would share an id and the new one
   * would be mistaken for the old one resuming — arriving folded, with its live
   * content hidden. The live message is the logical run, one per reply.
   */
  runId: string | null
}

/**
 * Advance the fold state for one render, returning `prev` unchanged when
 * nothing moved so the caller can apply it as a render-phase update.
 *
 * Exported for tests.
 */
export function advanceReplyFold(
  prev: ReplyFoldState,
  next: ReplyFoldInput
): ReplyFoldState {
  const { sendSignal, running, runId } = next
  if (prev.signal !== sendSignal) {
    return {
      signal: sendSignal,
      epoch: prev.epoch + 1,
      // Normally false — the previous reply has settled, so the thread folds
      // shut behind the new message. True only for steering, where the send
      // lands mid-reply and the reply being written is at once the new round.
      armed: running,
      running,
      runId,
      roundOpen: true,
    }
  }
  if (running && !prev.running) {
    // Same reply resuming rather than a new one. The runtime completes a live
    // reply prematurely and then re-bridges the SAME `liveMessage` while it is
    // still streaming (see "drops the promoted snapshot when the same
    // liveMessage is still streaming" in `conversation-runtime-context.test`),
    // which reaches here as running true → false → true for ONE reply. Treating
    // that as a new round would fold history the reader had opened and re-open
    // a reply they had folded by hand. A genuinely new reply carries a
    // different live-message id — see `ReplyFoldInput.runId` for why this must
    // be the live message rather than the render item.
    if (runId !== null && runId === prev.runId) {
      return { ...prev, running: true }
    }
    // A reply just STARTED: it is the new round — armed, expanded, and folding
    // whatever sat open above it, exactly as a send does.
    //
    // Keyed off this edge rather than off `sendSignal` alone because not every
    // host has a send: `live-transcript-view` mounts this component for a
    // work-task transcript that the engine drives through many rounds
    // (work / retry / return / merge — that is what its `userTurnHeader`
    // labels) without a single local send. There, a `sendSignal` that never
    // moves would leave every finished round expanded, and a round the reader
    // folded by hand would hand its `roundOpen: false` straight to the next
    // one, so a live reply would arrive already collapsed.
    return {
      ...prev,
      epoch: prev.epoch + 1,
      armed: true,
      running: true,
      runId,
      roundOpen: true,
    }
  }
  if (running && prev.running && runId !== prev.runId) {
    // The identity moved while ONE reply kept running, so this is a
    // re-identification, never a new round — a new round dips `running` first,
    // because the previous reply has to settle before the next can start.
    // Two ways it happens, and both must leave the round alone:
    //   - it arrived late: a viewer attaching mid-turn sees the reply through
    //     the backend's in-flight marker first and bridges the live stream a
    //     beat later, so the round starts anonymous;
    //   - it was rebased: `STATUS_CHANGED(prompting)` mints a client-side
    //     `randomUUID` live message, and a reconnect that hydrates from a
    //     snapshot swaps it wholesale for the backend's (see the SNAPSHOT case
    //     in `acp-connections-context`), mid-reply.
    // Latching is not optional: without it a later re-bridge has nothing to
    // recognise the reply by and would read as new, folding history the reader
    // opened and re-opening a reply they folded by hand.
    //
    // Known gap, deliberately left: `(running, runId)` cannot see a round
    // boundary the client never observed. Fold a reply by hand, disconnect,
    // let it finish and a SECOND client start the next one, then reconnect
    // straight onto that snapshot, and the change reads as a rebase — so the
    // new reply inherits the fold and arrives collapsed under a "working"
    // header (one click away, and self-correcting at the next boundary).
    // Closing it needs an explicit turn-boundary signal plumbed out of the
    // connection layer; not worth that for a disclosure widget's default.
    return { ...prev, runId }
  }
  if (!running && prev.running) {
    // The round settled. Only `running` moves — `armed` and `roundOpen` must
    // survive, or the reply would fold itself up the moment it finishes.
    return { ...prev, running: false }
  }
  return prev
}

// Module-scope so the reference is stable across renders — lets the memoized
// VirtualizedMessageThread bail out when `items` is unchanged.
const getThreadItemKey = (item: ThreadRenderItem) => item.key

// Stable empty reference so the SubAgentOverlay memo can bail out when there
// are no delegations in the last reply.
const EMPTY_DELEGATIONS: DelegationCardSource[] = []

// Stable empty reference so the navigator memo / equality checks don't churn
// when a conversation has no user messages.
const EMPTY_NAV_ENTRIES: MessageNavEntry[] = []

// A single turn's `sourceTurns` is just `[turn]`. Cache the wrapper per turn
// object so an unchanged historical turn keeps a stable `sourceTurns` reference
// across streaming-token re-renders — that's the last prop preventing
// `HistoricalMessageGroup`'s memo from bailing out (its `group` and the
// phase-derived flags are already reference-/value-stable). The streaming turn
// is rebuilt every token, so it gets a fresh wrapper and still re-renders.
const sourceTurnsSingletonCache = new WeakMap<MessageTurn, MessageTurn[]>()
export function singletonSourceTurns(turn: MessageTurn): MessageTurn[] {
  let cached = sourceTurnsSingletonCache.get(turn)
  if (!cached) {
    cached = [turn]
    sourceTurnsSingletonCache.set(turn, cached)
  }
  return cached
}

// Collect the sub-agent delegations within a turn's adapted parts, recursing
// through tool-groups and goal-runs (both kinds are normally standalone parts —
// `isAgentLikeToolName` keeps them out of tool-groups — but we scan nested
// containers defensively so a delegation is never missed).
//
// Two kinds qualify:
//   - `delegate_to_agent`, which STARTED a sub-agent, keyed by its own
//     tool_use_id;
//   - `resume_delegation`, which brought an interrupted one BACK. Its own
//     tool_call_id is not a binding key (the broker re-binds the child to the
//     original delegate call, usually in an earlier turn), so it is keyed by
//     the task id in its arguments — `taskIdHint`, exactly as
//     `ResumedDelegationCard` does. Without this arm a resumed sub-agent would
//     be missing from the overlay while it runs, because the reply that
//     resumed it contains no `delegate_to_agent` call at all.
//
// `seenTaskIds` de-dupes repeated resumes of one task inside a single reply
// (the second is refused, but the overlay renders a row per source regardless).
function collectDelegationSources(
  parts: AdaptedContentPart[],
  out: DelegationCardSource[],
  seenTaskIds: Set<string>
): void {
  for (const part of parts) {
    if (part.type === "tool-call") {
      if (!part.toolCallId) continue
      const name = normalizeToolName(part.toolName)
      if (isDelegateToAgentToolName(name)) {
        out.push({
          parentToolUseId: part.toolCallId,
          input: part.input ?? null,
          output: part.output ?? null,
          errorText: part.errorText ?? null,
          state: part.state,
          meta: part.meta ?? null,
        })
      } else if (name === "resume_delegation") {
        // A refusal names the task's agent and child but revived nothing —
        // listing it would put a sub-agent in the overlay that is not running
        // on this turn's behalf. Same judgement as `ResumedDelegationCard`,
        // which falls back to the plain tool card here.
        if (isRefusedResume(part.output ?? null, part.errorText ?? null)) {
          continue
        }
        const taskId = parseResumeTaskId(part.input ?? null)
        // No task id ⇒ nothing to resolve the sub-agent by; a duplicate ⇒
        // already listed.
        if (!taskId || seenTaskIds.has(taskId)) continue
        seenTaskIds.add(taskId)
        out.push({
          parentToolUseId: part.toolCallId,
          taskIdHint: taskId,
          // Deliberately not the resume's `{task_id, reason}` arguments —
          // `parseInput` looks for `task`/`agent_type`/`working_dir` and would
          // only warn about an unrecognized shape. See `ResumedDelegationCard`.
          input: null,
          output: part.output ?? null,
          errorText: part.errorText ?? null,
          state: part.state,
          meta: part.meta ?? null,
        })
      }
    } else if (part.type === "tool-group") {
      collectDelegationSources(part.items, out, seenTaskIds)
    } else if (part.type === "goal-run") {
      collectDelegationSources(part.items, out, seenTaskIds)
    }
  }
}

export function extractDelegationSources(
  parts: AdaptedContentPart[]
): DelegationCardSource[] {
  const out: DelegationCardSource[] = []
  collectDelegationSources(parts, out, new Set())
  return out
}

function extractTextFromParts(parts: AdaptedContentPart[]): string {
  return parts
    .flatMap((p): string[] => {
      if (p.type === "text") return [p.text]
      if (p.type === "goal-run") return [extractTextFromParts(p.items)]
      return []
    })
    .filter((text) => text.length > 0)
    .join("\n")
}

type AssistantTurnItem = Extract<ThreadRenderItem, { kind: "turn" }>

/**
 * Cache entry for one merged assistant run, keyed on the run's FIRST member
 * group. Valid only while every member's group reference and item key still
 * match: group identity flows through the per-turn adapter + group caches, so
 * member-group equality implies unchanged content AND sourceTurns — the merged
 * item FREEZES its members' `sourceTurns`, so any turn field the adapter's
 * cache ignores would be stale here forever (`source_turn_id`, which the fork
 * affordance reads, is in that tuple for exactly this reason). The keys embed
 * phase/id/index so ordering or phase drift invalidates too. A run
 * containing the streaming turn misses every batch by construction (the
 * streaming turn re-adapts per batch) — that residual rebuild is the point;
 * purely historical runs hit and keep their group/parts/sourceTurns
 * references stable so HistoricalMessageGroup's memo bails out.
 */
export interface MergedAssistantRunCacheEntry {
  memberGroups: ResolvedMessageGroup[]
  memberKeys: string[]
  memberCompletion: boolean[]
  item: AssistantTurnItem
}
export type MergedAssistantRunCache = WeakMap<
  ResolvedMessageGroup,
  MergedAssistantRunCacheEntry
>

function isEmptyTurnItem(item: ThreadRenderItem): boolean {
  if (item.kind !== "turn") return false
  const g = item.group
  if (g.parts.length > 0) return false
  if (g.resources.length > 0) return false
  if (g.images.length > 0) return false
  return true
}

/**
 * When a resolved group's ONLY meaningful content is a single context-compaction
 * tool-call part, return that part's `_meta` and retained summary (so the caller
 * can hoist it to a standalone `"compaction"` divider item); otherwise `null`.
 * Empty text parts are ignored so a bare compaction turn still qualifies. Scoped
 * to assistant groups with no user resources/images. A compaction part always
 * carries a truthy `_meta` (`contextCompaction` as the boolean marker or the
 * 1.3.0+ versioned object), so a non-null return is unambiguous.
 */
export function compactionOnlyPart(group: ResolvedMessageGroup): {
  meta: Record<string, unknown> | null
  summary: string | null
  state: ToolCallState
} | null {
  if (group.role !== "assistant") return null
  if (group.resources.length > 0 || group.images.length > 0) return null
  const meaningful = group.parts.filter(
    (p) => !(p.type === "text" && p.text.trim().length === 0)
  )
  if (meaningful.length !== 1) return null
  const only = meaningful[0]
  if (only.type !== "tool-call" || !isContextCompactionMeta(only.meta)) {
    return null
  }
  return {
    meta: only.meta ?? null,
    summary: contextCompactionSummary(only.meta, only.output),
    state: only.state,
  }
}

/**
 * Identity of a compaction EVENT, or `null` when the payload cannot name one.
 *
 * All three counters are required, and that is the point rather than
 * strictness for its own sake: codex-acp sends a bare `{version: 1}` for every
 * compaction it performs, so a looser key would fold a session's separate
 * compactions into one. Together, the token counts either side of the boundary
 * plus a duration measured in milliseconds identify a single event — two real
 * compactions agreeing on all three does not happen.
 */
function compactionEventKey(
  meta: Record<string, unknown> | null
): string | null {
  const payload = contextCompactionPayload(meta)
  if (!payload) return null
  const nums = ["preTokens", "postTokens", "durationMs"].map((k) => {
    const v = payload[k]
    return typeof v === "number" && Number.isFinite(v) ? v : null
  })
  return nums.some((n) => n === null) ? null : `compaction:${nums.join(":")}`
}

/**
 * Drop repeat renderings of one compaction, keeping the first.
 *
 * A compaction reaches the timeline through two independent channels that no
 * id-keyed dedup can join: the live ACP `tool_call` (a `live-…` turn) and the
 * agent's own transcript, which `parsers::claude` turns into a divider under a
 * parser id. Mid-turn both are in hand at once — and unlike an ordinary
 * partial reply, the usual suppressor cannot help here, because the `/compact`
 * prompt is not persisted until AFTER the boundary, so the backend has no
 * in-flight user turn to anchor on (`apply_in_flight_message_id`).
 *
 * Content is therefore the only usable identity; see [`compactionEventKey`]
 * for why it is safe. Returns the input array when nothing is dropped, so the
 * common path allocates nothing.
 */
export function dedupeCompactionItems(
  items: ThreadRenderItem[]
): ThreadRenderItem[] {
  const seen = new Set<string>()
  let dropped = false
  const kept = items.filter((item) => {
    if (item.kind !== "compaction") return true
    const key = compactionEventKey(item.meta)
    if (key === null) return true
    if (seen.has(key)) {
      dropped = true
      return false
    }
    seen.add(key)
    return true
  })
  return dropped ? kept : items
}

/**
 * Collapse runs of consecutive assistant turn render items into a single
 * synthetic turn so tool-groups straddling a turn boundary fold into one
 * collapsible. Empty (no-content) turn items are treated as transparent and
 * do not break the run — that handles cases where parsers leave empty
 * placeholder turns between tool exchanges.
 *
 * Exported for tests.
 */
export function mergeConsecutiveAssistantTurns(
  items: ThreadRenderItem[],
  mergeCache?: MergedAssistantRunCache
): ThreadRenderItem[] {
  const result: ThreadRenderItem[] = []
  const skipped: ThreadRenderItem[] = []
  let buffer: AssistantTurnItem[] = []

  // Push the cached merged item instead of rebuilding when the run's
  // membership (group references + item keys) is unchanged since last render.
  const reuseCachedMergedRun = (): boolean => {
    if (!mergeCache) return false
    const cached = mergeCache.get(buffer[0].group)
    if (!cached || cached.memberGroups.length !== buffer.length) return false
    for (let i = 0; i < buffer.length; i++) {
      if (
        buffer[i].group !== cached.memberGroups[i] ||
        buffer[i].key !== cached.memberKeys[i] ||
        buffer[i].isResponseComplete !== cached.memberCompletion[i]
      ) {
        return false
      }
    }
    result.push(cached.item)
    return true
  }

  const flush = () => {
    if (buffer.length === 0) {
      // Drain any skipped (empty) items collected since last flush
      for (const s of skipped) result.push(s)
      skipped.length = 0
      return
    }

    if (buffer.length === 1) {
      result.push(buffer[0])
    } else if (reuseCachedMergedRun()) {
      // Reused — nothing to rebuild.
    } else {
      const allParts = buffer.flatMap((it) => it.group.parts)
      // A goal run straddling these merged sub-turns is still live only if the
      // final sub-turn is streaming; once it settles (stop / turn end / reload)
      // the unfinished-run shimmer must stop. Mirror groupGoalRuns' per-turn
      // isStreaming gate at the merge layer.
      const mergedStreaming = buffer.some((it) => it.phase === "streaming")
      // Fold tool-groups straddling the turn boundary, then collapse runs of
      // single-poll delegation-status and background-task groups (each polling
      // round is its own turn) into one merged card.
      const mergedParts = groupGoalRuns(
        mergeAdjacentBackgroundTaskGroups(
          mergeAdjacentDelegationStatusGroups(mergeAdjacentToolGroups(allParts))
        ),
        mergedStreaming
      )
      const last = buffer[buffer.length - 1]
      const first = buffer[0]

      // Aggregate stats across the merged sub-turns so the post-stream
      // stats row reflects the whole assistant response, not just the
      // last sub-turn. Without this, multi-turn agents (Task tool, codex
      // agent loops, etc.) would visibly under-report tokens.
      let mergedUsage: import("@/lib/types").TurnUsage | null = null
      let mergedDuration: number | null = null
      // Post-turn metadata may land on ANY sub-turn (Cursor's reparse patches
      // the FIRST local sub-turn when the parser emits fewer turns than the
      // live stream split into), so the merged completion time is the latest
      // non-null across the run — not whatever the last sub-turn happens to
      // carry.
      let mergedCompletedAt: string | null = null
      const seenModels = new Set<string>()
      const mergedModels: string[] = []
      for (const it of buffer) {
        if (it.group.completed_at) {
          mergedCompletedAt = it.group.completed_at
        }
        const u = it.group.usage
        if (u) {
          if (!mergedUsage) {
            mergedUsage = {
              input_tokens: u.input_tokens,
              output_tokens: u.output_tokens,
              cache_creation_input_tokens: u.cache_creation_input_tokens,
              cache_read_input_tokens: u.cache_read_input_tokens,
            }
          } else {
            mergedUsage.input_tokens += u.input_tokens
            mergedUsage.output_tokens += u.output_tokens
            mergedUsage.cache_creation_input_tokens +=
              u.cache_creation_input_tokens
            mergedUsage.cache_read_input_tokens += u.cache_read_input_tokens
          }
        }
        if (typeof it.group.duration_ms === "number") {
          mergedDuration = (mergedDuration ?? 0) + it.group.duration_ms
        }
        if (it.group.model && !seenModels.has(it.group.model)) {
          seenModels.add(it.group.model)
          mergedModels.push(it.group.model)
        }
      }

      const merged: AssistantTurnItem = {
        ...last,
        key: `merged-${first.key}`,
        isResponseComplete: buffer.every((it) => it.isResponseComplete),
        // Concatenate every sub-turn's raw turns so the artifacts card sees all
        // file edits across the merged reply, not just the last sub-turn.
        sourceTurns: buffer.flatMap((b) => b.sourceTurns),
        group: {
          ...last.group,
          id: first.group.id,
          parts: mergedParts,
          usage: mergedUsage,
          duration_ms: mergedDuration,
          model: mergedModels[0] ?? last.group.model,
          models: mergedModels.length > 1 ? mergedModels : undefined,
          completed_at: mergedCompletedAt,
        },
      }
      result.push(merged)
      mergeCache?.set(first.group, {
        memberGroups: buffer.map((it) => it.group),
        memberKeys: buffer.map((it) => it.key),
        memberCompletion: buffer.map((it) => it.isResponseComplete),
        item: merged,
      })
    }

    // Drop any empty items that were collapsed inside the run
    skipped.length = 0
    buffer = []
  }

  for (const item of items) {
    if (item.kind === "turn" && item.group.role === "assistant") {
      // Flush any leading skipped (empty non-assistant) items before starting
      // a fresh assistant run. This keeps non-assistant placeholders in their
      // original relative order when no merging happens.
      if (buffer.length === 0) {
        for (const s of skipped) result.push(s)
        skipped.length = 0
      }
      buffer.push(item)
      continue
    }

    if (buffer.length > 0 && isEmptyTurnItem(item)) {
      // Transparent: don't break the run, but track in case we end up not
      // merging (single-buffer case still drops them as they're invisible).
      skipped.push(item)
      continue
    }

    flush()
    result.push(item)
  }
  flush()

  return result
}

const UserMessageCopyButton = memo(function UserMessageCopyButton({
  parts,
}: {
  parts: AdaptedContentPart[]
}) {
  const t = useTranslations("Folder.chat.messageList")
  const [isCopied, setIsCopied] = useState(false)
  const timeoutRef = useRef<number>(0)

  const handleCopy = useCallback(async () => {
    if (isCopied) return
    // User text was Markdown-escaped by the composer on send (e.g. a Windows
    // path `C:\…` became `C:\\…`); the transcript renders it back through a
    // Markdown renderer, so the copy must reverse that escaping to match what
    // the user sees. Assistant copies (TurnStats below) keep the raw Markdown.
    const text = unescapeComposerText(extractTextFromParts(parts))
    if (!text) return
    const ok = await copyTextToClipboard(text)
    if (!ok) return
    setIsCopied(true)
    timeoutRef.current = window.setTimeout(() => setIsCopied(false), 2000)
  }, [parts, isCopied])

  useEffect(
    () => () => {
      window.clearTimeout(timeoutRef.current)
    },
    []
  )

  return (
    <MessageAction
      tooltip={isCopied ? t("copied") : t("copyMessage")}
      className="opacity-0 group-hover/user-msg:opacity-100 transition-opacity self-end"
      onClick={handleCopy}
      size="icon-xs"
    >
      {isCopied ? <CheckIcon size={12} /> : <CopyIcon size={12} />}
    </MessageAction>
  )
})

const UserMessageTaskButton = memo(function UserMessageTaskButton({
  parts,
}: {
  parts: AdaptedContentPart[]
}) {
  const t = useTranslations("Tasks")
  const getText = useCallback(
    () => unescapeComposerText(extractTextFromParts(parts)),
    [parts]
  )
  const createTask = useCreateTaskFromMessage(getText)
  return (
    <MessageAction
      tooltip={t("createFromMessage")}
      className="opacity-0 group-hover/user-msg:opacity-100 transition-opacity self-end"
      onClick={createTask}
      size="icon-xs"
    >
      <ListTodo size={12} />
    </MessageAction>
  )
})

/**
 * Flag the thread's last rendered element, which is where the backend's tail
 * fork would land — a user message or a compaction divider after the newest
 * reply means that reply is NOT it. Blocks that render nothing are stepped
 * over: they occupy an index without occupying the thread.
 *
 * Mutates in place, like the loop that resets these flags just before it (a
 * cached merged item is reset there every render, so a stale `true` cannot
 * survive). Exported for tests.
 */
export function markThreadTail(items: ThreadRenderItem[]): void {
  for (let idx = items.length - 1; idx >= 0; idx--) {
    const item = items[idx]
    if (item.kind === "turn" && isEmptyTurnItem(item)) continue
    if (item.kind === "turn") item.isThreadTail = true
    break
  }
}

/**
 * Whether forking at this reply would land somewhere other than where the user
 * pointed — so the affordance greys out until it wouldn't.
 *
 * A turn this session streamed carries a `live-…` id until the post-turn
 * reparse backfills the parser's name (`source_turn_id`). The backend cannot
 * resolve such an id and deliberately degrades to a TAIL fork rather than
 * refusing the click. That is exactly right at the END of the thread — the tail
 * IS the fork point — and a silent lie anywhere before it.
 *
 * Anywhere before it is reachable: a reply the user steered mid-turn promotes
 * as assistant / user message / assistant, so its first half is a settled
 * group carrying a fork button while the backfill is a second and a half away.
 * The exception is therefore the thread TAIL, not the newest assistant reply:
 * steer at the very end of a turn and the promotion is assistant + user message
 * with nothing after it, which leaves the newest reply one message short of the
 * tail — and the parse ending on a user turn means `source_turn_id` never
 * arrives to correct it (see `computeTurnMetadataPatches`). Exported for tests.
 */
export function isForkPointUnnamed(
  forkPoint: MessageTurn | null,
  isThreadTail: boolean
): boolean {
  if (forkPoint === null || isThreadTail) return false
  return forkPoint.source_turn_id == null && isLiveTurnId(forkPoint.id)
}

const HistoricalMessageGroup = memo(function HistoricalMessageGroup({
  group,
  dimmed = false,
  showStats = true,
  previousUserIndex = null,
  isResponseComplete = true,
  sourceTurns,
  currentRound = false,
  roundOpen = true,
  onRoundOpenChange,
  foldEpoch = 0,
  onForkFromTurn,
  forkDisabled = false,
  isThreadTail = false,
}: {
  group: ResolvedMessageGroup
  dimmed?: boolean
  showStats?: boolean
  previousUserIndex?: number | null
  isResponseComplete?: boolean
  sourceTurns?: MessageTurn[]
  currentRound?: boolean
  roundOpen?: boolean
  onRoundOpenChange?: (open: boolean) => void
  foldEpoch?: number
  onForkFromTurn?: (turnId: string) => void
  forkDisabled?: boolean
  /** Whether nothing follows this group in the thread — the one position where
   *  a turn the backend cannot name still forks where the user pointed. */
  isThreadTail?: boolean
}) {
  if (group.role === "system") {
    return <CollapsibleSystemMessage parts={group.parts} />
  }

  // The fork point is the group's LAST turn: forking is "up to and including
  // this reply", and a merged group ends where the reply does.
  const forkPoint = sourceTurns?.length
    ? sourceTurns[sourceTurns.length - 1]
    : null
  const forkPointUnnamed = isForkPointUnnamed(forkPoint, isThreadTail)

  return (
    <div className={dimmed ? "opacity-70" : undefined}>
      <Message from={group.role}>
        {group.role === "user" && group.images.length > 0 ? (
          <UserImageAttachments images={group.images} className="self-end" />
        ) : null}
        {group.role === "user" ? (
          <div className="group/user-msg flex w-fit ml-auto max-w-full items-start gap-1">
            <UserMessageTaskButton parts={group.parts} />
            <UserMessageCopyButton parts={group.parts} />
            <MessageContent>
              <CollapsibleUserMessage parts={group.parts} />
            </MessageContent>
          </div>
        ) : (
          <MessageContent>
            <CompletedTurnContent
              parts={group.parts}
              durationMs={group.duration_ms}
              completed={isResponseComplete}
              currentRound={currentRound}
              roundOpen={roundOpen}
              onRoundOpenChange={onRoundOpenChange}
              foldEpoch={foldEpoch}
            />
          </MessageContent>
        )}
        {group.role === "user" && group.resources.length > 0 ? (
          <UserResourceLinks resources={group.resources} className="self-end" />
        ) : null}
      </Message>
      {showStats && group.role === "assistant" && sourceTurns && (
        <ReplyArtifacts
          sourceTurns={sourceTurns}
          isResponseComplete={isResponseComplete}
        />
      )}
      {showStats && group.role === "assistant" && (
        <TurnStats
          usage={group.usage}
          duration_ms={group.duration_ms}
          model={group.model}
          models={group.models}
          previousUserIndex={previousUserIndex}
          isResponseComplete={isResponseComplete}
          copyText={extractTextFromParts(group.parts)}
          completedAt={group.completed_at}
          forkDisabled={forkDisabled || forkPointUnnamed}
          forkDisabledReason={forkPointUnnamed ? "unnamed" : "busy"}
          onForkFromHere={
            // Gated on a settled turn — forking mid-stream would name a message
            // the agent is still writing.
            //
            // `source_turn_id` first: a turn produced in THIS session is named
            // `live-…`, which the backend cannot resolve against its own parse
            // — sending it forked at the tail and produced a copy of the parent.
            // The post-turn reparse backfills the parser's name; `id` is the
            // right answer only for turns that came from the parser already,
            // and for the newest reply, where the tail IS the fork point.
            onForkFromTurn && isResponseComplete && forkPoint
              ? () => {
                  onForkFromTurn(forkPoint.source_turn_id ?? forkPoint.id)
                }
              : undefined
          }
        />
      )}
    </div>
  )
})

const PendingTypingIndicator = memo(function PendingTypingIndicator() {
  return (
    <Message from="assistant">
      <MessageContent>
        <div className="flex items-center gap-1.5 py-1">
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-muted-foreground/60 animate-[pulse_1.4s_ease-in-out_infinite]" />
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-muted-foreground/60 animate-[pulse_1.4s_ease-in-out_0.2s_infinite]" />
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-muted-foreground/60 animate-[pulse_1.4s_ease-in-out_0.4s_infinite]" />
        </div>
      </MessageContent>
    </Message>
  )
})

const AutoScrollOnSend = memo(function AutoScrollOnSend({
  signal,
}: {
  signal: number
}) {
  const { scrollToBottom } = useStickToBottomContext()
  const lastSignalRef = useRef(signal)

  useEffect(() => {
    if (signal === lastSignalRef.current) return
    lastSignalRef.current = signal

    scrollToBottom()
    const rafId = requestAnimationFrame(() => {
      scrollToBottom()
    })
    return () => {
      cancelAnimationFrame(rafId)
    }
  }, [scrollToBottom, signal])

  return null
})

export function MessageListView({
  conversationId,
  imageRoot,
  agentType,
  connStatus,
  isActive = true,
  sendSignal = 0,
  detailLoading = false,
  detailError = null,
  acpLoadError = null,
  hideEmptyState = false,
  onReload,
  onNewSession,
  showMessageNav = true,
  userTurnHeader = null,
  onQuoteSelection,
  onAskSelection,
  onSaveNoteSelection,
  onForkFromTurn,
}: MessageListViewProps) {
  const t = useTranslations("Folder.chat.messageList")
  const sharedT = useTranslations("Folder.chat.shared")
  const pageHandoffName = usePageHandoffName()
  // Resolved once for the whole thread rather than per reply: the labels are a
  // property of the agent, not of any one turn.
  const modelLabel = useModelLabels(agentType)
  // Subscribe to only this conversation's session + derived timeline. Another
  // conversation's streaming token no longer re-renders this view; the timeline
  // selector returns a reference-stable array (memoized per session object) so
  // unrelated dispatches are inert here.
  const session = useConversationRuntimeStore(
    (s) => s.byConversationId.get(conversationId) ?? null
  )
  const liveMessage = session?.liveMessage ?? null
  const timelineTurns = useConversationRuntimeStore((s) =>
    selectTimelineTurns(s, conversationId)
  )

  // Reverse infinite scroll: older history exists above the loaded window
  // (windowed detail with a non-zero offset). Legacy full responses never
  // report an offset, so the loader row and near-top trigger stay off.
  const detail = session?.detail ?? null
  const imageFolderId = detail?.summary.folder_id
  const storedImageRoot = useAppWorkspaceStore(
    (s) =>
      s.allFolders.find((folder) => folder.id === imageFolderId)?.path ?? null
  )
  const hasOlderTurns = isWindowedDetail(detail) && detail.turns_offset > 0
  const loadingOlderTurns = session?.loadingOlderTurns ?? false
  const { loadOlderTurns, refetchDetail } = useConversationRuntimeActions()
  const handleLoadOlder = useCallback(() => {
    loadOlderTurns(conversationId)
  }, [loadOlderTurns, conversationId])

  // The agent ran a turn on its own and the wire content was dropped unrendered
  // (see `pendingOutOfTurnContent`). Offer a re-read rather than doing one on a
  // timer: the transcript's last write races the wire by single-digit
  // milliseconds — the race that got the refetch-on-turn-complete patch
  // reverted, see `completeTurn` in conversation-runtime-store — and a click
  // lands far outside that window. `preserveLive` so a turn the user started in
  // the meantime keeps streaming underneath. The flag clears on the response,
  // so the pill doubles as its own progress indicator via `detailLoading`.
  const pendingOutOfTurnContent = session?.pendingOutOfTurnContent ?? false
  const handleLoadOutOfTurnContent = useCallback(() => {
    refetchDetail(conversationId, { preserveLive: true })
  }, [refetchDetail, conversationId])

  const shouldUseSmoothResize = !(
    isActive &&
    !detailLoading &&
    timelineTurns.length
  )

  const adapterText = useMemo(
    () => ({
      attachedResources: sharedT("attachedResources"),
      toolCallFailed: sharedT("toolCallFailed"),
      pageHandoffName,
    }),
    [sharedT, pageHandoffName]
  )

  const sessionSyncState = session?.syncState ?? "idle"

  // Per-instance turn adapter: caches per-turn `AdaptedMessage` so unchanged
  // historical turns survive every streaming-token re-render with stable refs.
  const [turnAdapter] = useState<MessageTurnAdapter>(() =>
    createMessageTurnAdapter()
  )

  // Sibling cache mapping each cached `AdaptedMessage` to its derived
  // `ResolvedMessageGroup`, so `HistoricalMessageGroup`'s `memo` can short-
  // circuit on prop reference equality.
  const [groupCache] = useState<WeakMap<AdaptedMessage, ResolvedMessageGroup>>(
    () => new WeakMap()
  )

  // Reuses merged multi-sub-turn assistant items across streaming-batch
  // re-renders — see MergedAssistantRunCacheEntry for the validity contract.
  const [mergedRunCache] = useState<MergedAssistantRunCache>(
    () => new WeakMap()
  )

  const threadState = useMemo(() => {
    const allTurns = timelineTurns.map((item) => item.turn)
    const streamingIndices = new Set<number>()
    const inProgressToolCallIdsByIndex = new Map<number, Set<string>>()
    timelineTurns.forEach((item, i) => {
      if (item.phase === "streaming") streamingIndices.add(i)
      // Not gated on the streaming phase: a PERSISTED turn of a conversation
      // that is still running (viewer without the live stream) also carries
      // in-flight calls, marked by the store from the backend's
      // `in_flight_user_turn_id`. Both phases feed the same adapter knob.
      if (item.inProgressToolCallIds && item.inProgressToolCallIds.size > 0) {
        inProgressToolCallIdsByIndex.set(i, item.inProgressToolCallIds)
      }
    })
    const allAdapted = turnAdapter.adapt(
      allTurns,
      adapterText,
      streamingIndices.size > 0 ? streamingIndices : undefined,
      inProgressToolCallIdsByIndex.size > 0
        ? inProgressToolCallIdsByIndex
        : undefined
    )

    // Collect non-streaming adapted messages for plan extraction
    const nonStreaming = allAdapted.filter(
      (_, index) => timelineTurns[index].phase !== "streaming"
    )

    // Map each adapted message directly to a render item (1:1).
    // Backend group_into_turns() already ensures each turn is a complete unit.
    const rawItems: ThreadRenderItem[] = allAdapted.map((msg, i) => {
      const phase = timelineTurns[i].phase
      const role = msg.role === "tool" ? "assistant" : msg.role
      let group = groupCache.get(msg)
      if (!group) {
        group = {
          id: msg.id,
          role,
          parts: msg.content,
          resources: msg.userResources ?? [],
          images: msg.userImages ?? [],
          usage: msg.usage,
          duration_ms: msg.duration_ms,
          model: msg.model,
          completed_at: msg.completed_at,
        }
        groupCache.set(msg, group)
      }
      // Include phase so a turn that briefly coexists across phases (e.g.
      // a streaming turn that has just been promoted to localTurns while the
      // liveMessage is still attached) doesn't collide with itself in the
      // virtualized list, and role because the timeline dedup deliberately
      // keeps different-role turns that share an id. NO positional index:
      // paging in older history prepends items, and an index-bearing key
      // would shift every existing row's identity — remounting the whole
      // list and dropping the virtualizer's measurement cache mid-scroll.
      const key = `${phase}-${role}-${msg.id}`
      // Hoist a compaction-only turn to its own standalone divider item so it
      // renders BETWEEN turns instead of being merged into (and wedged inside)
      // the preceding assistant reply by `mergeConsecutiveAssistantTurns`.
      const compaction = compactionOnlyPart(group)
      if (compaction !== null) {
        return {
          key,
          kind: "compaction" as const,
          meta: compaction.meta,
          summary: compaction.summary,
          state: compaction.state,
        }
      }
      return {
        key,
        kind: "turn" as const,
        group,
        phase,
        // Persisted does not always mean completed: a passive viewer reads
        // transcript blocks the agent is still writing. The store flags exactly
        // those DB records (`isInFlightRound`); reading the raw
        // `in_flight_user_turn_id` here instead would also catch locally
        // promoted — i.e. finished — replies, which the marker outlives.
        isResponseComplete:
          phase === "persisted" && !timelineTurns[i].isInFlightRound,
        showStats: false,
        isRoleTransition: false,
        previousUserIndex: null,
        isLastAssistantRun: false,
        isThreadTail: false,
        sourceTurns: singletonSourceTurns(allTurns[i]),
      }
    })

    // Collapse consecutive assistant turn render items into a single rendered
    // turn, so tool-groups straddling a turn boundary fold into one collapsible.
    // Compaction dividers are deduped FIRST: the live and persisted copies of
    // one compaction arrive under different ids, and only one of them should
    // reach the merge.
    const items = mergeConsecutiveAssistantTurns(
      dedupeCompactionItems(rawItems),
      mergedRunCache
    )

    // Compute showStats, isRoleTransition, and previousUserIndex for each turn.
    // previousUserIndex points at the closest preceding user turn (used by the
    // post-stream stats row's "jump to previous user message" button).
    let lastUserIdx: number | null = null
    let lastAssistantItem: AssistantTurnItem | null = null
    for (let idx = 0; idx < items.length; idx++) {
      const item = items[idx]
      if (item.kind !== "turn") continue

      // Reset before recomputing: a cached merged item carries last render's
      // values and the conditions below only ever assign `true`.
      item.showStats = false
      item.isRoleTransition = false
      item.previousUserIndex = null
      item.isLastAssistantRun = false
      item.isThreadTail = false

      // isRoleTransition: role differs from previous turn item
      if (idx > 0) {
        const prev = items[idx - 1]
        if (prev.kind === "turn" && prev.group.role !== item.group.role) {
          item.isRoleTransition = true
        }
      }

      if (item.group.role === "user") {
        lastUserIdx = idx
      }

      // showStats: only on the last assistant turn before a non-assistant or end
      if (item.group.role === "assistant") {
        lastAssistantItem = item
        const next = items[idx + 1]
        if (!next || next.kind !== "turn" || next.group.role !== "assistant") {
          item.showStats = true
          item.previousUserIndex = lastUserIdx
        }
      }
    }
    let lastAssistantRunning = false
    if (lastAssistantItem) {
      lastAssistantItem.isLastAssistantRun = true
      lastAssistantRunning = !lastAssistantItem.isResponseComplete
    }
    markThreadTail(items)

    const lastPhase = timelineTurns[timelineTurns.length - 1]?.phase ?? null
    if (
      lastPhase === "optimistic" &&
      (connStatus === "prompting" || sessionSyncState === "awaiting_persist")
    ) {
      items.push({ key: "pending-typing", kind: "typing" })
    }

    return {
      threadItems: items,
      nonStreamingAdapted: nonStreaming,
      // "The agent is replying right now." True for the local stream and for a
      // passive viewer reading a round the backend still flags in-flight, and
      // false the instant the reply settles — see `ReplyFoldState`.
      lastAssistantRunning,
    }
  }, [
    adapterText,
    connStatus,
    sessionSyncState,
    timelineTurns,
    turnAdapter,
    groupCache,
    mergedRunCache,
  ])
  const { threadItems, nonStreamingAdapted, lastAssistantRunning } = threadState

  // See `ReplyFoldState`. Derived during render rather than in an effect so a
  // send and the fold it causes land in the same commit — an effect would paint
  // one frame of the previous reply still expanded under the new message.
  const [storedFold, setFold] = useState<ReplyFoldState>(() => ({
    signal: sendSignal,
    epoch: 0,
    armed: false,
    running: false,
    runId: null,
    roundOpen: true,
  }))
  const fold = advanceReplyFold(storedFold, {
    sendSignal,
    running: lastAssistantRunning,
    runId: liveMessage?.id ?? null,
  })
  if (fold !== storedFold) setFold(fold)
  const handleRoundOpenChange = useCallback((open: boolean) => {
    setFold((prev) =>
      prev.roundOpen === open ? prev : { ...prev, roundOpen: open }
    )
  }, [])

  const historicalPlanEntries = useMemo(
    () => extractLatestPlanEntriesFromMessages(nonStreamingAdapted),
    [nonStreamingAdapted]
  )
  const historicalPlanKey = useMemo(
    () => buildPlanKey(historicalPlanEntries),
    [historicalPlanEntries]
  )

  // A turn in flight doesn't take the fork affordance away, it greys it out:
  // the host keeps `onForkFromTurn` set for the whole "prompting" window (see
  // its gate in `conversation-detail-panel`), and every reply's footer says
  // "not right now" instead of dropping its button and shifting the icon row.
  const forkBusy = connStatus === "prompting"

  const renderThreadItem = useCallback(
    (item: ThreadRenderItem) => {
      switch (item.kind) {
        case "turn": {
          const pt = item.isRoleTransition ? 16 : 0
          const phaseLabel =
            item.group.role === "user" && userTurnHeader
              ? userTurnHeader(item.group)
              : null
          return (
            <div style={pt > 0 ? { paddingTop: pt } : undefined}>
              {phaseLabel ? (
                <div className="flex items-center gap-2 px-1 pb-3 pt-1">
                  <span aria-hidden="true" className="h-px flex-1 bg-border" />
                  <span className="shrink-0 rounded-full border border-border bg-muted/50 px-2 py-0.5 text-[0.625rem] font-medium leading-none text-muted-foreground">
                    {phaseLabel}
                  </span>
                  <span aria-hidden="true" className="h-px flex-1 bg-border" />
                </div>
              ) : null}
              <HistoricalMessageGroup
                group={item.group}
                dimmed={item.phase === "optimistic"}
                showStats={item.showStats}
                previousUserIndex={item.previousUserIndex}
                isResponseComplete={item.isResponseComplete}
                sourceTurns={item.sourceTurns}
                currentRound={item.isLastAssistantRun && fold.armed}
                roundOpen={fold.roundOpen}
                onRoundOpenChange={handleRoundOpenChange}
                foldEpoch={fold.epoch}
                onForkFromTurn={onForkFromTurn}
                forkDisabled={forkBusy}
                isThreadTail={item.isThreadTail}
              />
            </div>
          )
        }
        case "typing":
          return <PendingTypingIndicator />
        case "compaction":
          // Chrome-less centered divider between turns (no avatar / stats footer).
          return (
            <div className="px-1 py-2">
              <ContextCompactionCard
                state={item.state}
                meta={item.meta}
                summary={item.summary}
              />
            </div>
          )
        default:
          return null
      }
    },
    [
      userTurnHeader,
      fold.armed,
      fold.roundOpen,
      fold.epoch,
      handleRoundOpenChange,
      onForkFromTurn,
      forkBusy,
    ]
  )

  const emptyState = useMemo(
    () =>
      hideEmptyState ? null : (
        <div className="px-4 py-12 text-center">
          <p className="text-muted-foreground text-sm">
            {t("emptyConversation")}
          </p>
        </div>
      ),
    [hideEmptyState, t]
  )

  // Namespaced with `plan-` so this key can never equal `subAgentOverlayKey`
  // below: the two overlays are siblings in one container, and both fall back
  // to a per-conversation string when there's no live message / assistant reply
  // yet (the state a freshly-opened sub-agent dialog starts in). Without
  // disjoint namespaces those fallbacks collide → React "two children with the
  // same key".
  const agentPlanOverlayKey =
    liveMessage?.id != null
      ? `plan-${liveMessage.id}`
      : `plan-history-${conversationId}`

  // Sub-agents delegated in the LAST agent reply. Scan the merged timeline
  // backward for the most recent assistant turn (the live streaming turn is
  // merged in too, so this covers both live and historical), and pull its
  // `delegate_to_agent` tool calls. The overlay shows only while the last reply
  // carries delegation cards — a newer non-delegating reply clears it.
  const lastAssistantGroup = useMemo(() => {
    let group: ResolvedMessageGroup | null = null
    for (let i = threadItems.length - 1; i >= 0; i -= 1) {
      const item = threadItems[i]
      if (item.kind === "turn" && item.group.role === "assistant") {
        group = item.group
        break
      }
    }
    return group
  }, [threadItems])
  const lastAssistantDelegations = useMemo(
    () =>
      lastAssistantGroup
        ? extractDelegationSources(lastAssistantGroup.parts)
        : EMPTY_DELEGATIONS,
    [lastAssistantGroup]
  )
  const subAgentOverlayKey = lastAssistantGroup
    ? `subagents-${lastAssistantGroup.id}`
    : `subagents-history-${conversationId}`

  // --- Message navigator panel ------------------------------------------------
  // Lifted scroll handle so the panel (which lives in the overlay stack, outside
  // the MessageScrollProvider subtree) can drive scrollToIndex.
  const scrollApiRef = useRef<MessageScrollContextValue | null>(null)
  // Collapse state is owned here (not in the panel) so the expensive per-file
  // `navEntries` is computed only while the panel is open.
  const [navExpanded, setNavExpanded] = useState(false)

  // Positioning box for the text-selection bubble. It is the transcript's outer
  // (non-scrolling) frame, so the bubble is clipped to the message area and
  // never overlaps the composer or the tab strip.
  const selectionBoxRef = useRef<HTMLDivElement | null>(null)

  // Cheap user-message tally for the collapsed chip — counts user turns without
  // parsing any file diffs.
  const userMessageCount = useMemo(() => {
    if (!showMessageNav) return 0
    let count = 0
    for (const item of threadItems) {
      if (item.kind === "turn" && item.group.role === "user") count += 1
    }
    return count
  }, [showMessageNav, threadItems])

  // One entry per user message — including ones with no edits (placeholders).
  // Computed lazily: only while the panel is expanded, since
  // `extractSessionFilesGrouped` parses every turn's diffs. Collapsed (the
  // default) it stays EMPTY, keeping the streaming hot path free of diff parsing.
  //
  // Windowed loading caveat (accepted degradation): counts, ordinals and file
  // summaries cover only the LOADED window — paging in older history extends
  // them. Nav targets are recomputed with the items on every prepend, so the
  // indices themselves never go stale.
  const navEntries = useMemo<MessageNavEntry[]>(() => {
    if (!showMessageNav || !navExpanded) return EMPTY_NAV_ENTRIES
    const turns = timelineTurns.map((item) => item.turn)
    const groups = extractSessionFilesGrouped(turns, { includeEmpty: true })
    if (groups.length === 0) return EMPTY_NAV_ENTRIES

    const indexByTurnId = new Map<string, number>()
    for (let i = 0; i < threadItems.length; i++) {
      const item = threadItems[i]
      if (item.kind === "turn" && item.group.role === "user") {
        indexByTurnId.set(item.group.id, i)
      }
    }

    const entries: MessageNavEntry[] = []
    for (const group of groups) {
      const threadIndex = indexByTurnId.get(group.userTurnId)
      if (threadIndex == null) continue
      let additions = 0
      let deletions = 0
      for (const file of group.files) {
        additions += file.additions
        deletions += file.deletions
      }
      entries.push({
        threadIndex,
        turnId: group.userTurnId,
        ordinal: entries.length + 1,
        label: group.userMessage,
        additions,
        deletions,
        files: group.files,
        hasChanges: group.files.length > 0,
      })
    }
    return entries.length > 0 ? entries : EMPTY_NAV_ENTRIES
  }, [showMessageNav, navExpanded, timelineTurns, threadItems])

  const hasRenderableContent = threadItems.length > 0 || Boolean(liveMessage)

  if (detailLoading && !hasRenderableContent) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          <span>{t("loading")}</span>
        </div>
      </div>
    )
  }

  // An ACP load failure replaces content only when there is nothing to show
  // (e.g. the DB detail also failed). When the local DB has the conversation,
  // keep the transcript visible — the failure is not silent: the detail panel
  // renders the load error as a banner in the composer area (with Reload /
  // New session actions), so the user still learns that a follow-up message
  // can't extend this thread.
  const blockingLoadError = hasRenderableContent ? null : (acpLoadError ?? null)
  const fallbackLoadError =
    detailError && !hasRenderableContent ? detailError : null
  const renderedLoadError = blockingLoadError ?? fallbackLoadError
  if (renderedLoadError) {
    const showActions = Boolean(onReload || onNewSession)
    const reloading = detailLoading
    return (
      <div role="alert" className="flex h-full items-center justify-center p-6">
        <div className="flex max-w-md flex-col items-center gap-4 text-center">
          <AlertCircle
            aria-hidden="true"
            className="h-8 w-8 text-destructive"
          />
          <div className="space-y-1">
            <h3 className="text-sm font-medium">{t("errorTitle")}</h3>
            <p className="text-sm text-muted-foreground break-words">
              {renderedLoadError}
            </p>
          </div>
          {showActions && (
            <div className="flex flex-wrap items-center justify-center gap-2">
              {onReload && (
                <Button
                  size="sm"
                  onClick={onReload}
                  disabled={reloading}
                  aria-busy={reloading}
                >
                  {reloading ? (
                    <Loader2
                      aria-hidden="true"
                      className="me-1.5 h-4 w-4 animate-spin"
                    />
                  ) : (
                    <RefreshCw aria-hidden="true" className="me-1.5 h-4 w-4" />
                  )}
                  {t("errorActionReload")}
                </Button>
              )}
              {onNewSession && (
                <Button size="sm" variant="outline" onClick={onNewSession}>
                  <Plus aria-hidden="true" className="me-1.5 h-4 w-4" />
                  {t("errorActionNewSession")}
                </Button>
              )}
            </div>
          )}
        </div>
      </div>
    )
  }

  const thread = (
    // The "查看会话" drawers are hosted HERE, not in the cards that offer them:
    // those live in virtua's rows and take their drawer down with them when
    // they scroll out of the buffer. This is the nearest ancestor that owns
    // the virtualizer instead of sitting inside it — and it covers the
    // top-right SubAgentOverlay's rows too.
    <SessionViewerHost>
      <div
        ref={selectionBoxRef}
        className="relative flex h-full min-h-0 flex-col"
      >
        <MessageThread
          className="flex-1 min-h-0"
          resize={shouldUseSmoothResize ? "smooth" : undefined}
        >
          <AutoScrollOnSend signal={sendSignal} />
          <VirtualizedMessageThread
            items={threadItems}
            getItemKey={getThreadItemKey}
            renderItem={renderThreadItem}
            emptyState={emptyState}
            scrollApiRef={scrollApiRef}
            hasOlder={hasOlderTurns}
            isLoadingOlder={loadingOlderTurns}
            onLoadOlder={handleLoadOlder}
            loadOlderLabel={t("loadEarlier")}
            loadingOlderLabel={t("loadingEarlier")}
            prependEpoch={session?.olderTurnsPrependEpoch ?? 0}
            prependScopeKey={conversationId}
          />
          {/* Stacked, not overlapping: both pin to the thread's bottom centre,
          so the scroll button steps up while the pill is showing. */}
          <MessageThreadScrollButton
            className={pendingOutOfTurnContent ? "bottom-16" : undefined}
          />
          {pendingOutOfTurnContent && (
            <Button
              className="absolute bottom-4 left-[50%] translate-x-[-50%] gap-1.5 rounded-full bg-background/90 shadow-sm hover:bg-muted/90"
              disabled={detailLoading}
              onClick={handleLoadOutOfTurnContent}
              size="sm"
              type="button"
              variant="outline"
            >
              {detailLoading ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <RefreshCw className="size-3.5" />
              )}
              {t("loadBackgroundActivity")}
            </Button>
          )}
        </MessageThread>
        {liveMessage && connStatus === "prompting" && (
          <LiveTurnStats
            message={liveMessage}
            agentType={agentType}
            isStreaming={connStatus === "prompting"}
          />
        )}
        {/* Shared overlay stack pinned to the inline-start edge (top-left in LTR,
        top-right in RTL). A flex column keeps the order stable regardless of
        each panel's expand/collapse height: the message navigator first, then
        the plan panel, then the sub-agent panel. Empty panels render null and
        collapse out. Positioning lives here (not in the child overlays); the
        chips are "bullets" — flat on the start side (flush to the pinned
        edge), rounded on the end side — that expand toward the inline-end on
        hover. Logical `start-0` + `items-start` keep the anchor and the bullet
        on the same side, so the whole stack mirrors cleanly in RTL. */}
        <div className="pointer-events-none absolute start-0 top-4 z-20 flex max-w-[min(22rem,calc(100%-2rem))] flex-col items-start gap-2">
          {showMessageNav && userMessageCount > 0 && (
            <ConversationMessageNav
              count={userMessageCount}
              expanded={navExpanded}
              onToggle={setNavExpanded}
              entries={navEntries}
              scrollApiRef={scrollApiRef}
            />
          )}
          <AgentPlanOverlay
            key={agentPlanOverlayKey}
            message={liveMessage ?? null}
            entries={historicalPlanEntries}
            planKey={historicalPlanKey}
            defaultExpanded={false}
            isStreaming={connStatus === "prompting"}
          />
          <SubAgentOverlay
            key={subAgentOverlayKey}
            delegations={lastAssistantDelegations}
            overlayKey={subAgentOverlayKey}
          />
        </div>
        <SelectionActionBubble
          containerRef={selectionBoxRef}
          onQuote={onQuoteSelection}
          onAsk={onAskSelection}
          onSaveAsNote={onSaveNoteSelection}
        />
      </div>
    </SessionViewerHost>
  )

  return (
    <MarkdownImageProvider
      rootPath={imageRoot === undefined ? storedImageRoot : imageRoot}
    >
      <ModelLabelProvider value={modelLabel}>{thread}</ModelLabelProvider>
    </MarkdownImageProvider>
  )
}
