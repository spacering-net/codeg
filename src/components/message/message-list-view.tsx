"use client"

import {
  memo,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
} from "react"
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
import { ContentPartsRenderer } from "./content-parts-renderer"
import {
  contextCompactionPayload,
  contextCompactionSummary,
  isContextCompactionMeta,
} from "@/lib/context-compaction"
import {
  createMessageTurnAdapter,
  groupGoalRuns,
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
import { SlideSlot } from "./slide-slot"
import { ModelLabelProvider } from "./model-label-context"
import { KnownInvocationsProvider } from "./known-invocations-context"
import { DelegationStatusIndexProvider } from "./delegation-status-index-context"
import { useTranscriptKnownInvocations } from "./use-transcript-known-invocations"
import { ReplyArtifacts } from "./reply-artifacts"
import { UserResourceLinks } from "./user-resource-links"
import { UserImageAttachments } from "./user-image-attachments"
import {
  AgentPlanOverlay,
  getLatestPlanEntries,
} from "@/components/chat/agent-plan-overlay"
import { SubAgentOverlay } from "@/components/chat/sub-agent-overlay"
import { SessionViewerHost } from "@/components/message/session-viewer-host"
import { normalizeToolName } from "@/lib/tool-call-normalization"
import { parseResumeTaskId } from "@/lib/codeg-mcp-tool"
import {
  isCodeModeDelegationCall,
  isDelegateToAgentToolName,
  isRefusedResume,
  parseDelegateTaskId,
} from "@/lib/delegation-card"
import type { DelegationCardSource } from "@/hooks/use-delegation-card-model"
import {
  collectDelegationStatusTasks,
  createDelegationStatusIndexer,
  type DelegationStatusTaskRef,
} from "@/lib/delegation-status-index"
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
import type {
  AgentType,
  AvailableCommandInfo,
  ConnectionStatus,
  MessageTurn,
  PlanEntryInfo,
} from "@/lib/types"
import { cn, copyTextToClipboard } from "@/lib/utils"
import {
  VirtualizedMessageThread,
  type ViewportTop,
} from "@/components/message/virtualized-message-thread"
import { SelectionActionBubble } from "@/components/message/selection-action-bubble"
import {
  RenderPageAnnotateContext,
  RenderPageQuoteContext,
} from "@/components/message/render-page-quote"
import type { MessageNavEntry } from "@/components/message/conversation-message-nav"
import type { MessageScrollContextValue } from "@/components/message/message-scroll-context"
import {
  buildMessageNavEntries,
  type LoadedMessageSubAgents,
} from "@/components/message/message-nav-entries"
import { useMessageNavJump } from "@/components/message/use-message-nav-jump"
import { useConversationOutline } from "@/hooks/use-conversation-outline"
import {
  publishTranscriptInsights,
  retractTranscriptInsights,
  useTranscriptNavDemanded,
  type TranscriptInsights,
  type TranscriptInsightsActions,
} from "@/stores/transcript-insights-store"
import { useModelLabels } from "@/hooks/use-model-labels"
import { useChatAnimationsEnabled } from "@/hooks/use-appearance"
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
  /**
   * The slash commands this transcript's agent advertises right now (the same
   * list behind the composer's `/` menu). A bare `/word` in a sent user message
   * is shown as a command badge only when it names one of these (or, for Codex,
   * one of its `$` skills).
   *
   * `null`/`undefined` while the agent has not advertised (no connection, or
   * one still coming up): the transcript then badges what this agent last
   * advertised in this folder, and no command if it never has. `[]` is an
   * answer, not that gap: the agent offers no commands, so only Codex's disk
   * skills can badge.
   *
   * Required, though it may be null: a surface that left it out would badge
   * from whatever this agent last advertised in the folder, on any
   * connection, instead of from its own connection's list, so every surface
   * mounting a transcript must decide.
   */
  availableCommands: readonly AvailableCommandInfo[] | null | undefined
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
   * Where this transcript's message navigator, plan and sub-agents show. The
   * conversation page sets it: they move to the Session Details side panel
   * (published to `transcript-insights-store` for the panel to read) and the
   * transcript draws none of them over its messages. Every other surface — a
   * canvas card, the read-only sub-agent and task drawers — leaves it unset and
   * keeps the plan and sub-agent chips in the transcript's top inline-start
   * corner, with no navigator.
   */
  insightsInSidebar?: boolean
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
   * Send a finished `render_page` annotation session (picked elements, boxed
   * regions, freehand marks, note) to the conversation composer, as formatted
   * text. Provided to replayed pages on the same terms as `onQuoteSelection`;
   * omitted on read-only surfaces, which then offer no annotate entry.
   * MUST be referentially stable.
   */
  onAnnotatePage?: (text: string) => void
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
      // Only one a reply does not go on after: a compaction the agent ran
      // mid-turn stays a turn and is merged into that reply as one of its steps
      // (`hoistedCompaction`), as it is drawn live.
      key: string
      kind: "compaction"
      meta: Record<string, unknown> | null
      /** The retained summary, when the backend claimed one for this call
       *  (see `contextCompactionSummary`). */
      summary?: string | null
      /** The call's lifecycle, so a `/compact` still running reads as
       *  compacting and its summary streams. */
      state?: ToolCallState
      /** The compaction call's id — the event's own name wherever the live
       *  and history channels agree on one (see `dedupeCompactionItems`). */
      callId?: string
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

// Stable empty reference for "the live reply has no plan".
const EMPTY_PLAN_ENTRIES: PlanEntryInfo[] = []

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
// into goal runs (a delegation made while a goal runs sits in the run's items).
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
      // Code-mode payloads (opencode's `execute`, which normalizes to `bash`)
      // reach this arm by their INPUT — the delegation call lives inside the
      // `code` string, so the tool name alone can't classify them.
      if (
        isDelegateToAgentToolName(name) ||
        isCodeModeDelegationCall(name, part.input ?? null)
      ) {
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

// Per-group memo for the two scans below. A historical group keeps its object
// identity across streaming batches (the adapter and merged-run caches see to
// that), so only the streaming reply is re-scanned per batch — and its sources
// keep the same objects whenever the group does.
const delegationSourcesByGroup = new WeakMap<
  ResolvedMessageGroup,
  DelegationCardSource[]
>()

// The broker task id a `delegate_to_agent` call reported, memoized per source:
// a finished call's output carries the sub-agent's whole result, and the
// conversation scan below would otherwise re-parse every one of them on every
// streaming batch.
const startedTaskIdBySource = new WeakMap<DelegationCardSource, string | null>()

function startedTaskIdOf(source: DelegationCardSource): string | null {
  let taskId = startedTaskIdBySource.get(source)
  if (taskId === undefined) {
    taskId = parseDelegateTaskId(source.output, source.errorText)
    startedTaskIdBySource.set(source, taskId)
  }
  return taskId
}

export function groupDelegationSources(
  group: ResolvedMessageGroup
): DelegationCardSource[] {
  let sources = delegationSourcesByGroup.get(group)
  if (!sources) {
    const extracted = extractDelegationSources(group.parts)
    sources = extracted.length > 0 ? extracted : EMPTY_DELEGATIONS
    delegationSourcesByGroup.set(group, sources)
  }
  return sources
}

// Per group as well, for the status index below: the rows a historical
// group's status cards draw are read once.
const delegationStatusTasksByGroup = new WeakMap<
  ResolvedMessageGroup,
  readonly DelegationStatusTaskRef[]
>()

/**
 * The `get_delegation_status` task rows the thread's turns draw, turn by turn
 * and in thread order — what the transcript's status index is folded from
 * (`@/lib/delegation-status-index`), so that only a task's newest row carries
 * the decision its sub-agent is parked on.
 */
export function threadDelegationStatusTasks(
  items: readonly ThreadRenderItem[]
): (readonly DelegationStatusTaskRef[])[] {
  const out: (readonly DelegationStatusTaskRef[])[] = []
  for (const item of items) {
    if (item.kind !== "turn") continue
    let tasks = delegationStatusTasksByGroup.get(item.group)
    if (!tasks) {
      tasks = collectDelegationStatusTasks(item.group.parts)
      delegationStatusTasksByGroup.set(item.group, tasks)
    }
    if (tasks.length > 0) out.push(tasks)
  }
  return out
}

/** The sub-agents one message's round lists, in order — see
 *  `extractMessageDelegationSources`. */
class MessageDelegationList {
  readonly sources: DelegationCardSource[] = []
  private readonly indexByCallId = new Map<string, number>()
  private readonly listedTaskIds = new Set<string>()

  add(source: DelegationCardSource): void {
    const resumedTaskId = source.taskIdHint ?? null
    if (resumedTaskId == null) {
      const startedTaskId = startedTaskIdOf(source)
      if (startedTaskId) this.listedTaskIds.add(startedTaskId)
    }
    // Another copy of a call already listed refreshes that row — before the
    // task check below, which would otherwise take a resume's second copy for
    // a second resume of its task and keep the stale first copy.
    const existing = this.indexByCallId.get(source.parentToolUseId)
    if (existing != null) {
      this.sources[existing] = source
      return
    }
    if (resumedTaskId != null) {
      if (this.listedTaskIds.has(resumedTaskId)) return
      this.listedTaskIds.add(resumedTaskId)
    }
    this.indexByCallId.set(source.parentToolUseId, this.sources.length)
    this.sources.push(source)
  }
}

/**
 * The sub-agents each loaded user message's round started or brought back, in
 * order, one source each — what the message navigator of the Session Details
 * panel lists under a message. The sources are the ones the round's delegation
 * cards draw (`groupDelegationSources`).
 *
 * Within a round, a `resume_delegation` is listed only for a task the round
 * didn't already list: the resume re-binds the child to its ORIGINAL
 * `delegate_to_agent` call, so the original's row already tracks the resumed
 * run. A resume of a task an earlier message started is listed under the
 * message that resumed it too — that round put the sub-agent back to work.
 * The same call seen twice (a reply rendered from two copies while it
 * settles) keeps its first position and its latest fields.
 *
 * Replies loaded ahead of the first loaded user message — a round whose prompt
 * sits above the loaded window — are `leading`.
 */
export function extractMessageDelegationSources(
  items: readonly ThreadRenderItem[]
): LoadedMessageSubAgents {
  // A list only for a round that has a sub-agent: this runs on every
  // streaming batch, over every loaded message.
  const lists = new Map<string, MessageDelegationList>()
  let leading: MessageDelegationList | null = null
  // The message whose round is being read; null ahead of the first.
  let currentTurnId: string | null = null
  let current: MessageDelegationList | null = null
  for (const item of items) {
    if (item.kind !== "turn") continue
    if (item.group.role === "user") {
      currentTurnId = item.group.id
      current = lists.get(currentTurnId) ?? null
      continue
    }
    if (item.group.role !== "assistant") continue
    const sources = groupDelegationSources(item.group)
    if (sources.length === 0) continue
    if (!current) {
      current = new MessageDelegationList()
      if (currentTurnId == null) leading = current
      else lists.set(currentTurnId, current)
    }
    for (const source of sources) current.add(source)
  }
  const byUserTurnId = new Map<string, readonly DelegationCardSource[]>()
  for (const [turnId, list] of lists) {
    if (list.sources.length > 0) byUserTurnId.set(turnId, list.sources)
  }
  return {
    byUserTurnId,
    leading:
      leading && leading.sources.length > 0
        ? leading.sources
        : EMPTY_DELEGATIONS,
  }
}

/**
 * The user message the transcript is showing, for the navigator's highlight:
 * the one whose prompt — or whose reply — is at the top of the viewport, or
 * the latest once the view rests at the end. Replies loaded ahead of the first
 * loaded message belong to `earlierRoundTurnId`, the message above the loaded
 * window whose round the window starts inside (null while that is unknown).
 */
export function currentNavTurnIdAt(
  items: readonly ThreadRenderItem[],
  top: ViewportTop,
  earlierRoundTurnId: string | null
): string | null {
  const from = top.atEnd
    ? items.length - 1
    : Math.min(top.index, items.length - 1)
  for (let i = from; i >= 0; i--) {
    const item = items[i]
    if (item.kind === "turn" && item.group.role === "user") {
      return item.group.id
    }
  }
  return earlierRoundTurnId
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
 * role/id so ordering drift invalidates too; a member settling into history
 * re-adapts (a new group) and completes, so phase drift does as well. A run
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

/** A `system` group that is nothing but a failed turn's line
 *  (`TurnErrorPart`): the parsers write one per failed round, and so does the
 *  live stream. */
export function isTurnErrorGroup(group: ResolvedMessageGroup): boolean {
  return (
    group.parts.length > 0 &&
    group.parts.every((part) => part.type === "turn-error")
  )
}

/**
 * When a resolved group's ONLY meaningful content is a single context-compaction
 * tool-call part, return that part's `_meta`, retained summary and call id (so
 * the caller can hoist it to a standalone `"compaction"` divider item);
 * otherwise `null`. Empty text parts are ignored so a bare compaction turn
 * still qualifies. Scoped to assistant groups with no user resources/images. A
 * compaction part always carries a truthy `_meta` (`contextCompaction` as the
 * boolean marker or the 1.3.0+ versioned object), so a non-null return is
 * unambiguous.
 */
export function compactionOnlyPart(group: ResolvedMessageGroup): {
  meta: Record<string, unknown> | null
  summary: string | null
  state: ToolCallState
  callId: string
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
    callId: only.toolCallId,
  }
}

/**
 * The compaction the group at `index` is to be hoisted out as — a standalone
 * divider between turns — or `null` to keep it a turn: not a compaction-only
 * group, or one that falls inside a reply. That is when the next group with
 * anything in it — past the empty placeholders the parsers leave between
 * turns, which `mergeConsecutiveAssistantTurns` sees through too, and past
 * other compactions — is the agent's, not a message.
 *
 * An agent that compacts its context by itself mid-turn (codex, claude) goes
 * on with the same reply afterwards, and live the compaction is one of that
 * reply's steps, inside its timeline. Its history copy is a turn of its own
 * between the reply's two halves; hoisted out as a divider it cut the reply in
 * two, each half with its own header and footer. Kept a turn, it is merged
 * into the reply as live. A compaction the reply does not go on after — a
 * `/compact` between replies, or one at the very end — stays the divider
 * between them. Exported for tests.
 */
export function hoistedCompaction(
  groups: readonly ResolvedMessageGroup[],
  index: number
): ReturnType<typeof compactionOnlyPart> {
  const compaction = compactionOnlyPart(groups[index]!)
  if (compaction === null) return null
  for (let i = index + 1; i < groups.length; i++) {
    const group = groups[i]!
    const empty =
      group.parts.length === 0 &&
      group.resources.length === 0 &&
      group.images.length === 0
    if (empty) continue
    if (group.role !== "assistant") break
    if (compactionOnlyPart(group) === null) return null
  }
  return compaction
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
 * A compaction reaches the timeline through two independent channels: the live
 * ACP `tool_call` (a `live-…` turn) and the agent's own transcript, which the
 * history parsers turn into a divider under a parser turn id. Mid-turn both can
 * be in hand at once — and unlike an ordinary partial reply, the usual
 * suppressor cannot help here, because the `/compact` prompt is not persisted
 * until AFTER the boundary (claude), or ever (codex), so the backend has no
 * in-flight user turn to anchor on (`apply_in_flight_message_id`).
 *
 * Two identities, either one enough:
 * - the call id, where both channels name the event alike — codex-acp's live
 *   `compactionId` is the app-server item id `parsers::codex` names its divider
 *   by, and codex sends no counters for the content key to use;
 * - the content, where they do not — claude's live id is its `compacting`
 *   status message and its transcript's is the boundary record; see
 *   [`compactionEventKey`] for why the content key is safe.
 *
 * Returns the input array when nothing is dropped, so the common path
 * allocates nothing.
 */
export function dedupeCompactionItems(
  items: ThreadRenderItem[]
): ThreadRenderItem[] {
  const seen = new Set<string>()
  let dropped = false
  const kept = items.filter((item) => {
    if (item.kind !== "compaction") return true
    const keys = [
      compactionEventKey(item.meta),
      item.callId ? `call:${item.callId}` : null,
    ].filter((key): key is string => key !== null)
    const repeat = keys.some((key) => seen.has(key))
    // A repeat's other identity names the same event too, so it is recorded
    // even though the item itself goes.
    for (const key of keys) seen.add(key)
    if (repeat) dropped = true
    return !repeat
  })
  return dropped ? kept : items
}

/**
 * Collapse runs of consecutive assistant turn render items into a single
 * synthetic turn, so a reply the agent split across turns (one per tool round
 * trip) draws as one timeline. Empty (no-content) turn items are treated as
 * transparent and do not break the run — that handles cases where parsers
 * leave empty placeholder turns between tool exchanges.
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
      // Collapse runs of single-poll delegation-status and background-task
      // groups (each polling round is its own turn) into one.
      const mergedParts = groupGoalRuns(
        mergeAdjacentBackgroundTaskGroups(
          mergeAdjacentDelegationStatusGroups(allParts)
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
        // The run is drawn where its first turn was, and it stays that row: a
        // reply goes from one turn to two the moment the agent answers its
        // first tool, mid-stream, and a key of its own for the merged run
        // re-mounted the whole reply right then.
        key: first.key,
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
    // Nor is a failed round's closing line where a fork lands: a tail fork
    // keeps everything up to the reply before it — the failure is nothing the
    // agent carries on from — so that reply is still the thread's tail.
    if (item.kind === "turn" && isTurnErrorGroup(item.group)) continue
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
  // A message the user has just sent rises into the thread. Decided once, as
  // it mounts on its way (`dimmed`): the virtual list bringing a stored one
  // back never replays it.
  const [risesIn] = useState(dimmed && group.role === "user")
  if (group.role === "system") {
    // A failed turn's line is the agent's account of the failure, not a
    // message the system sent: it closes the round in place, unboxed.
    if (isTurnErrorGroup(group)) {
      return <ContentPartsRenderer parts={group.parts} role="system" />
    }
    return <CollapsibleSystemMessage parts={group.parts} />
  }

  // The fork point is the group's LAST turn: forking is "up to and including
  // this reply", and a merged group ends where the reply does.
  const forkPoint = sourceTurns?.length
    ? sourceTurns[sourceTurns.length - 1]
    : null
  const forkPointUnnamed = isForkPointUnnamed(forkPoint, isThreadTail)

  return (
    // Dimmed while the message is on its way (not yet stored); it brightens
    // into place rather than at once.
    <div
      className={cn("transition-opacity duration-300", dimmed && "opacity-70")}
    >
      <Message
        from={group.role}
        className={risesIn ? "chat-enter-rise" : undefined}
      >
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

/** No parts yet: the reply the pending one stands for has said nothing. */
const NO_PARTS: AdaptedContentPart[] = []

/**
 * What stands in the thread between a send and the first thing the agent says:
 * the reply itself, before it has anything in it — its "Working" header and
 * the turning ring under it, where the reply will draw them. So when the reply
 * arrives it takes over in place, its first words appearing between the two
 * (the ring moving down to make room, see `ReplyMotion`), rather than a row of
 * dots giving way to a header a line lower. It fades in a beat after the send,
 * as the sent message settles.
 */
const PendingReply = memo(function PendingReply() {
  return (
    <div className="chat-enter-late">
      <Message from="assistant">
        <MessageContent>
          <CompletedTurnContent parts={NO_PARTS} completed={false} pending />
        </MessageContent>
      </Message>
    </div>
  )
})

type LiveStatsMessage = ComponentProps<typeof LiveTurnStats>["message"]

/**
 * The running turn's figures, kept at the turn's last ones while the bar
 * slides away after it ends (the live message goes as the turn does), so the
 * figures leave with the bar instead of blanking it first. Mounted only while
 * the bar is, so a new turn starts from its own.
 */
function HeldLiveTurnStats({ message }: { message: LiveStatsMessage | null }) {
  const [held, setHeld] = useState(message)
  if (message !== null && message !== held) setHeld(message)
  const shown = message ?? held
  // Keyed by its turn: a turn that starts while the last one's bar is still
  // sliding away gets figures of its own, its clock from zero.
  return shown ? (
    <LiveTurnStats key={shown.id} message={shown} />
  ) : (
    <div className="h-8" />
  )
}

const AutoScrollOnSend = memo(function AutoScrollOnSend({
  signal,
}: {
  signal: number
}) {
  const { scrollToBottom } = useStickToBottomContext()
  const chatAnimations = useChatAnimationsEnabled()
  const lastSignalRef = useRef(signal)

  useEffect(() => {
    if (signal === lastSignalRef.current) return
    lastSignalRef.current = signal

    const options = chatAnimations
      ? undefined
      : { animation: "instant" as const }
    scrollToBottom(options)
    const rafId = requestAnimationFrame(() => {
      scrollToBottom(options)
    })
    return () => {
      cancelAnimationFrame(rafId)
    }
  }, [scrollToBottom, signal, chatAnimations])

  return null
})

export function MessageListView({
  conversationId,
  imageRoot,
  agentType,
  availableCommands,
  connStatus,
  isActive = true,
  sendSignal = 0,
  detailLoading = false,
  detailError = null,
  acpLoadError = null,
  hideEmptyState = false,
  onReload,
  onNewSession,
  insightsInSidebar = false,
  userTurnHeader = null,
  onQuoteSelection,
  onAnnotatePage,
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
  const resolvedImageRoot =
    imageRoot === undefined ? storedImageRoot : imageRoot
  // What a bare `/word`·`$word` in a user bubble has to be on to render as a
  // command badge: what the composer's menu offers this agent (or, until its
  // connection advertises, what it last advertised in this folder), so the
  // bubble never claims a command for a path or a word in prose.
  const knownInvocations = useTranscriptKnownInvocations(
    agentType,
    availableCommands,
    resolvedImageRoot
  )
  const hasOlderTurns = isWindowedDetail(detail) && detail.turns_offset > 0
  const loadingOlderTurns = session?.loadingOlderTurns ?? false
  const { loadOlderTurns, loadOlderTurnsThrough, refetchDetail } =
    useConversationRuntimeActions()
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

  const chatAnimations = useChatAnimationsEnabled()
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
    const groups = allAdapted.map((msg) => {
      let group = groupCache.get(msg)
      if (!group) {
        group = {
          id: msg.id,
          role: msg.role === "tool" ? "assistant" : msg.role,
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
      return group
    })
    const rawItems: ThreadRenderItem[] = groups.map((group, i) => {
      const phase = timelineTurns[i].phase
      // Role and id: the timeline holds one turn per role and id (a streaming
      // turn just promoted into localTurns while the liveMessage is still
      // attached is deduped there, `dedupeTimeline`), and deliberately keeps
      // different-role turns that share one. NO phase: a reply settling into
      // history keeps its id, and a key that changed with the phase would
      // remount the whole reply at the moment it finishes. NO positional
      // index either: paging in older history prepends items, and an
      // index-bearing key would shift every existing row's identity —
      // remounting the whole list and dropping the virtualizer's measurement
      // cache mid-scroll.
      const key = `${group.role}-${group.id}`
      // Hoist a compaction-only turn that ends a run to its own standalone
      // divider item so it renders BETWEEN turns instead of being merged into
      // (and wedged inside) the preceding assistant reply by
      // `mergeConsecutiveAssistantTurns`. One the reply goes on after stays a
      // turn, to be merged into that reply as one of its steps.
      const compaction = hoistedCompaction(groups, i)
      if (compaction !== null) {
        return {
          key,
          kind: "compaction" as const,
          meta: compaction.meta,
          summary: compaction.summary,
          state: compaction.state,
          callId: compaction.callId,
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
    // turn, so a reply split across turns draws as one timeline.
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
          // Where the reply will be: under the sent message, as far down as
          // a reply after a message is (`isRoleTransition`).
          return (
            <div style={{ paddingTop: 16 }}>
              <PendingReply />
            </div>
          )
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
  // `delegate_to_agent` tool calls. The list holds only while the last reply
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
        ? groupDelegationSources(lastAssistantGroup)
        : EMPTY_DELEGATIONS,
    [lastAssistantGroup]
  )
  const subAgentOverlayKey = lastAssistantGroup
    ? `subagents-${lastAssistantGroup.id}`
    : `subagents-history-${conversationId}`

  // Which status row of the thread speaks for each delegated task: only that
  // one reaches the live sub-agent and carries the decision it is parked on,
  // however many cards the agent's re-polls left. The indexer keeps its last
  // result while no task's newest row changes, so a streaming batch that
  // leaves them alone re-renders no row through the context.
  const [indexDelegationStatus] = useState(() =>
    createDelegationStatusIndexer()
  )
  const delegationStatusIndex = useMemo(
    () => indexDelegationStatus(threadDelegationStatusTasks(threadItems)),
    [indexDelegationStatus, threadItems]
  )

  // --- Message navigator ------------------------------------------------------
  // Lifted scroll handle so the navigator — in the Session Details side panel,
  // outside the MessageScrollProvider subtree — can drive scrollToIndex.
  const scrollApiRef = useRef<MessageScrollContextValue | null>(null)
  // The per-message rows are computed only while the side panel shows them:
  // grouping them parses every turn's diffs.
  const navDemanded = useTranscriptNavDemanded(
    conversationId,
    insightsInSidebar
  )

  // Positioning box for the text-selection bubble. It is the transcript's outer
  // (non-scrolling) frame, so the bubble is clipped to the message area and
  // never overlaps the composer or the tab strip.
  const selectionBoxRef = useRef<HTMLDivElement | null>(null)

  // The loaded user messages: how many, and where each renders. Cheap — no
  // diff parsing — so the message count and the jumps can use it while
  // streaming.
  const loadedUserMessages = useMemo(() => {
    const threadIndexByTurnId = new Map<string, number>()
    let count = 0
    if (!insightsInSidebar) return { count, threadIndexByTurnId }
    for (let i = 0; i < threadItems.length; i++) {
      const item = threadItems[i]
      if (item.kind === "turn" && item.group.role === "user") {
        count += 1
        threadIndexByTurnId.set(item.group.id, i)
      }
    }
    return { count, threadIndexByTurnId }
  }, [insightsInSidebar, threadItems])

  // A long conversation is loaded a window at a time (reverse infinite
  // scroll), but the navigator covers all of it: the window reports how many
  // user messages lie above it, and their outline is fetched while the rows
  // are shown. A server that doesn't report the count predates the outline
  // too; the navigator then covers the loaded window only.
  const windowedDetail = isWindowedDetail(detail) ? detail : null
  const earlierUserCount = insightsInSidebar
    ? (windowedDetail?.user_turns_before_offset ?? 0)
    : 0
  const userMessageCount = earlierUserCount + loadedUserMessages.count
  const earlierOutline = useConversationOutline({
    fetchId: session?.dbConversationId ?? conversationId,
    offset: windowedDetail?.turns_offset ?? 0,
    prefixHash: windowedDetail?.prefix_hash ?? null,
    enabled: navDemanded && earlierUserCount > 0,
  })
  const earlierOutlineState = earlierOutline.state

  // The sub-agents each loaded message's round ran, from the same sources its
  // delegation cards draw. Only while the rows are shown, like the rows.
  const loadedSubAgents = useMemo<LoadedMessageSubAgents | undefined>(
    () =>
      navDemanded ? extractMessageDelegationSources(threadItems) : undefined,
    [navDemanded, threadItems]
  )

  // One entry per user message — including ones with no edits (placeholders).
  // Computed lazily: only while the side panel shows the rows, since grouping
  // parses every turn's diffs. Otherwise it stays EMPTY, keeping the streaming
  // hot path free of diff parsing. Thread indices are recomputed with the
  // items on every prepend, so the jump targets never go stale.
  const navEntries = useMemo<MessageNavEntry[]>(() => {
    if (!navDemanded) return EMPTY_NAV_ENTRIES
    const entries = buildMessageNavEntries({
      earlierTurns:
        earlierOutlineState.status === "ready"
          ? earlierOutlineState.turns
          : null,
      earlierUserCount,
      loadedTurns: timelineTurns.map((item) => item.turn),
      threadIndexByTurnId: loadedUserMessages.threadIndexByTurnId,
      loadedSubAgents,
    })
    return entries.length > 0 ? entries : EMPTY_NAV_ENTRIES
  }, [
    navDemanded,
    earlierOutlineState,
    earlierUserCount,
    timelineTurns,
    loadedUserMessages,
    loadedSubAgents,
  ])

  // The message the transcript is showing, which the navigator highlights:
  // the one at the top of the viewport (or the one whose reply is there), or
  // the latest once the view is at the end. Tracked only while the rows are
  // shown — the list reports its top row only to a listener.
  const [viewportTop, setViewportTop] = useState<ViewportTop | null>(null)
  // Forgotten once nobody shows the rows, so showing them again never starts
  // from where the view was back then.
  if (!navDemanded && viewportTop !== null) setViewportTop(null)
  // The last message the outline lists: the one whose replies the loaded
  // window starts with, when it starts inside a round.
  const earlierRoundTurnId = useMemo(() => {
    if (earlierOutlineState.status !== "ready") return null
    const { turns } = earlierOutlineState
    for (let i = turns.length - 1; i >= 0; i--) {
      if (turns[i].role === "user") return turns[i].id
    }
    return null
  }, [earlierOutlineState])
  const currentNavTurnId = useMemo(
    () =>
      navDemanded && viewportTop != null
        ? currentNavTurnIdAt(threadItems, viewportTop, earlierRoundTurnId)
        : null,
    [navDemanded, viewportTop, threadItems, earlierRoundTurnId]
  )

  const navJump = useMessageNavJump({
    conversationId,
    threadIndexByTurnId: loadedUserMessages.threadIndexByTurnId,
    scrollApiRef,
    smooth: chatAnimations,
    loadOlderTurnsThrough,
  })

  // --- Session Details side panel ---------------------------------------------
  // The plan it shows: the live reply's latest plan block while it has one,
  // else the latest plan in the history (the inline overlay resolves the same
  // pair itself).
  const livePlanEntries = useMemo(
    () =>
      insightsInSidebar
        ? getLatestPlanEntries(liveMessage ?? null)
        : EMPTY_PLAN_ENTRIES,
    [insightsInSidebar, liveMessage]
  )
  const sidebarPlanEntries =
    livePlanEntries.length > 0 ? livePlanEntries : historicalPlanEntries
  const insightsActions = useMemo<TranscriptInsightsActions>(
    () => ({
      selectNavEntry: navJump.select,
      retryEarlierNav: earlierOutline.retry,
    }),
    [navJump.select, earlierOutline.retry]
  )
  const navEarlier =
    earlierOutlineState.status === "loading" ||
    earlierOutlineState.status === "error"
      ? earlierOutlineState.status
      : null
  const navRevealingTurnId = navJump.revealingTurnId
  const replyStreaming = connStatus === "prompting"
  const transcriptInsights = useMemo<TranscriptInsights | null>(
    () =>
      insightsInSidebar
        ? {
            nav: {
              count: userMessageCount,
              entries: navEntries,
              earlier: navEarlier,
              revealingTurnId: navRevealingTurnId,
              currentTurnId: currentNavTurnId,
            },
            plan: { entries: sidebarPlanEntries, streaming: replyStreaming },
            actions: insightsActions,
          }
        : null,
    [
      insightsInSidebar,
      userMessageCount,
      navEntries,
      navEarlier,
      navRevealingTurnId,
      currentNavTurnId,
      sidebarPlanEntries,
      replyStreaming,
      insightsActions,
    ]
  )
  // Published after every change; the store keeps whatever didn't change, so
  // a batch that moves none of it wakes no reader.
  const insightsOwner = useId()
  useEffect(() => {
    if (transcriptInsights == null) return
    publishTranscriptInsights(conversationId, insightsOwner, transcriptInsights)
  }, [conversationId, insightsOwner, transcriptInsights])
  useEffect(() => {
    if (!insightsInSidebar) return
    return () => retractTranscriptInsights(conversationId, insightsOwner)
  }, [insightsInSidebar, conversationId, insightsOwner])

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
    // inline SubAgentOverlay's rows too. (The Session Details side panel's
    // sub-agent rows sit in another tree and bring their own host.)
    <SessionViewerHost>
      <div
        ref={selectionBoxRef}
        className="chat-motion-scope relative flex h-full min-h-0 flex-col"
      >
        <MessageThread
          className="flex-1 min-h-0"
          resize={
            !chatAnimations
              ? "instant"
              : shouldUseSmoothResize
                ? "smooth"
                : undefined
          }
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
            onViewportTopChange={navDemanded ? setViewportTop : undefined}
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
        {/* Slides in over the composer as a turn starts and out as it ends,
            so the transcript above eases up and back instead of jumping. */}
        <SlideSlot
          className="shrink-0"
          show={liveMessage !== null && connStatus === "prompting"}
        >
          <HeldLiveTurnStats message={liveMessage} />
        </SlideSlot>
        {/* Overlay stack pinned to the inline-start edge (top-left in LTR,
        top-right in RTL) — only where the plan and sub-agents have no side
        panel to go to (see `insightsInSidebar`). A flex column keeps the order
        stable regardless of each panel's expand/collapse height: the plan
        panel first, then the sub-agent panel. Empty panels render null and
        collapse out. Positioning lives here (not in the child overlays); the
        chips are "bullets" — flat on the start side (flush to the pinned
        edge), rounded on the end side — that expand toward the inline-end on
        hover. Logical `start-0` + `items-start` keep the anchor and the bullet
        on the same side, so the whole stack mirrors cleanly in RTL. */}
        {!insightsInSidebar && (
          <div className="pointer-events-none absolute start-0 top-4 z-20 flex max-w-[min(22rem,calc(100%-2rem))] flex-col items-start gap-2">
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
        )}
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
    <MarkdownImageProvider rootPath={resolvedImageRoot}>
      {/* A `render_page` replayed in the transcript gets the same quote
          handler the selection bubble over ordinary text gets, so marking up
          a shown page sends text to the same composer. */}
      {/* A `render_page` replayed in the transcript gets the same quote
          handler the selection bubble over ordinary text gets, and an
          annotation handler next to it, so marking up a shown page sends
          text to the same composer. */}
      <RenderPageAnnotateContext.Provider value={onAnnotatePage ?? null}>
        <RenderPageQuoteContext.Provider value={onQuoteSelection ?? null}>
          <ModelLabelProvider value={modelLabel}>
            <DelegationStatusIndexProvider value={delegationStatusIndex}>
              <KnownInvocationsProvider value={knownInvocations}>
                {thread}
              </KnownInvocationsProvider>
            </DelegationStatusIndexProvider>
          </ModelLabelProvider>
        </RenderPageQuoteContext.Provider>
      </RenderPageAnnotateContext.Provider>
    </MarkdownImageProvider>
  )
}
