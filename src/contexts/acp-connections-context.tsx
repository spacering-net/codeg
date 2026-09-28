"use client"

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  type ReactNode,
} from "react"
import { useTranslations } from "next-intl"
import { subscribe, getEventStream } from "@/lib/platform"
import type {
  AttachHandlers,
  EventStreamSubscription,
} from "@/lib/transport/types"
import { randomUUID } from "@/lib/utils"
import { inferLiveToolName } from "@/lib/tool-call-normalization"
import {
  acpConnect,
  acpGetAgentStatus,
  acpPrompt,
  acpSetMode,
  acpSetConfigOption,
  acpGoalControl,
  acpCancel,
  acpRespondPermission,
  acpAnswerQuestion,
  acpAnswerPlanApproval,
  acpDisconnect,
  acpTouchConnection,
  acpGetSessionSnapshot,
  acpFindConnectionForConversation,
  openSettingsWindow,
} from "@/lib/api"
import { denormalizeSnapshot } from "@/lib/snapshot-denormalize"
import { buildDelegationSeedEnvelopes } from "@/lib/delegation-seed"
import {
  isConnectionBusy,
  isConnectionGoneError,
} from "@/lib/connection-teardown"
import {
  getConversationIdByExternalIdFromStore,
  useConversationRuntimeStore,
} from "@/stores/conversation-runtime-store"
import type {
  AgentType,
  AcpAgentStatus,
  AcpEvent,
  ActiveDelegationState,
  AsyncTaskDelta,
  AsyncTaskRecord,
  AvailableCommandInfo,
  ConfigStaleKind,
  ConnectionStatus,
  ContentBlock,
  ConversationConnectionInfo,
  EventEnvelope,
  PlanEntryInfo,
  PermissionOptionInfo,
  PendingQuestionState,
  QuestionAnswer,
  PendingPlanApprovalState,
  PlanApprovalAnswer,
  SessionConfigKindInfo,
  SessionConfigOptionInfo,
  SessionFailureRecord,
  SessionModeStateInfo,
  SessionUsageUpdateInfo,
  PromptCapabilitiesInfo,
  PromptInputBlock,
  ToolCallImageWire,
  UserMessageBlock,
} from "@/lib/types"
import {
  dismissSessionFailures,
  hasActiveRetryIncident,
  knownSessionFailureActions,
  latestActiveTerminalFailure,
  mergeSessionFailures,
  sessionFailureCategoryLabelKey,
  sessionFailureNotice,
  settleSessionFailures,
  upsertSessionFailure,
  type SessionFailureAction,
  type SessionFailureSettleScope,
} from "@/lib/session-failures"
import {
  adoptUnknownAsyncTasks,
  liveAsyncTasks,
  mergeAsyncTasks,
  upsertAsyncTask,
} from "@/lib/async-tasks"
import { contentBlocksFromUserMessage } from "@/lib/user-message-blocks"
import { presentSessionNotice, splitHeadline } from "@/lib/session-notices"
import {
  acpErrorNotifiesDesktop,
  isTurnFailureCode,
  routeAcpError,
  type AcpErrorLevel,
} from "@/lib/acp-error-presentation"
import { dismissNotification, notify, type NotifyAction } from "@/lib/notify"
import type { SnapshotPatch } from "@/lib/snapshot-denormalize"
import { getAgentLabel } from "@/lib/custom-agents"
import {
  localizeConfigOptionLabel,
  localizeConfigValueLabel,
} from "@/lib/agent-label-vocabulary"
import {
  CONNECTION_IDLE_TIMEOUT_MS,
  CONNECTION_KEEPALIVE_INTERVAL_MS,
  IDLE_SWEEP_INTERVAL_MS,
} from "@/lib/constants"
import {
  notifyDesktop,
  withDesktopNotificationsSuppressed,
} from "@/lib/desktop-notification"
import {
  playEventSound,
  primeNotificationSoundOutput,
  withEventSoundsSuppressed,
} from "@/lib/notification-sound"
import {
  getSavedPrefsForConnect,
  saveModePreference,
  saveConfigPreference,
} from "@/lib/selector-prefs-storage"
import { rememberModelLabels } from "@/lib/model-label-store"
import { useActiveFolder } from "@/contexts/active-folder-context"

/**
 * A session id we are willing to interpolate into a shell command we hand the
 * user to run (`codex unarchive <id>`). Anchored and UUID-shaped on purpose:
 * the whole string must be an id, so no whitespace or shell metacharacter can
 * ride along and turn one command into two. Codex rollout ids are UUIDs.
 */
const SESSION_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// ── Shared types (re-exported for consumers) ──

/** ACP extensibility metadata attached to tool calls. */
export type ToolCallMeta = Record<string, unknown> | null

/**
 * An image attached to a tool call (e.g. codex-acp v0.14+ image generation).
 * Re-exports the wire-level `ToolCallImageWire` from `@/lib/types` so that
 * snapshot, live `tool_call(_update)` events, and `ToolCallInfo` share one
 * shape. `data` is base64 (potentially multi-MB), `mime_type` defaults to
 * `image/png` when the agent omits it, `uri` is the on-disk path when the
 * agent persisted the asset (e.g. codex's `~/.codex/generated_images/...`).
 */
export type ToolCallImage = ToolCallImageWire

export interface ToolCallInfo {
  tool_call_id: string
  title: string
  kind: string
  status: string
  content: string | null
  raw_input: string | null
  raw_output_chunks: string[]
  raw_output_total_bytes: number
  locations: unknown
  meta: ToolCallMeta
  /**
   * Replace-on-update: a fresh ToolCallUpdate carrying images replaces this
   * vec; an absent images field preserves the prior value. Empty array
   * means "no images on this tool call". Persisted via snapshot so a
   * frontend reconnecting mid-turn or after refresh sees the same image.
   */
  images: ToolCallImage[]
}

export interface PendingPermission {
  request_id: string
  tool_call: unknown
  options: PermissionOptionInfo[]
  /** Requests queued behind this card (only one shows at a time). */
  queued?: number
}

/** In-flight user prompt carried on a connection (from a `user_message` event
 *  or a snapshot's `pending_user_message`). Mirrored into the runtime as a
 *  synthesized user turn for cross-client VIEWERS so they see the sender's
 *  message (the sender renders its own optimistic turn and ignores it). */
export interface PendingUserMessage {
  messageId: string
  blocks: UserMessageBlock[]
}

export interface PendingQuestion {
  tool_call_id: string
  question: string
}

export interface ClaudeApiRetryState {
  sessionId: string
  attempt: number | null
  maxRetries: number | null
  error: string | null
  errorStatus: number | null
  retryDelayMs: number | null
  /**
   * Whether the SOURCE reports error text for a retry at all — not whether this
   * particular record carries it.
   *
   * Claude's `api_retry` and codex's `_meta.codex.error` both do, and a missing
   * `error` there means "we didn't catch the cause this time", which is what
   * `claudeApiRetry.fallbackError` covers. pi (#525) reports no cause at any
   * time — only the counters — so the fallback would assert an authentication
   * failure that never happened. False makes the banner render from the
   * counters alone instead of inventing a reason.
   */
  reportsError: boolean
}

export type LiveContentBlock =
  /**
   * `parentToolUseId`: subagent attribution (claude-agent-acp ≥0.63,
   * `_meta.claudeCode.parentToolUseId`). Parented text/thinking belongs to
   * the live Agent capsule of that tool call — the runtime store routes it
   * out of the main thread. `undefined` = main-thread content.
   */
  | { type: "text"; text: string; parentToolUseId?: string }
  | { type: "thinking"; text: string; parentToolUseId?: string }
  | { type: "plan"; entries: PlanEntryInfo[] }
  | { type: "tool_call"; info: ToolCallInfo }
  /**
   * A message the user sent WHILE this turn was running, injected into it via
   * the native `_session/steering` channel. Not agent output: it marks the
   * point in the stream where the user interrupted, so
   * `buildStreamingTurnsFromLiveMessage` can close the assistant turn here,
   * render the message as its own user turn, and start the reply to it as a
   * new turn. Mirrors what the transcript projection already does with a
   * mid-turn `user_message_chunk` (see `parsers/acp_native.rs`), so the live
   * view and a reload agree. `id` is the feedback note id.
   *
   * `createdAt` (ISO, the note's `created_at`) is taken before the backend
   * hands the text to the agent (`submit_feedback_native`), on the machine the
   * agent runs on — so it is directly comparable with, and earlier than, the
   * timestamp the agent writes when it records this message in its own
   * transcript. That ordering is what lets the runtime store tell the agent's
   * copy of THIS message from the same words sent in an earlier round (see
   * `suppressPersistedSteeredPrompts`), and it is the time the message shows.
   *
   * `blocks` is what the user actually sent, present only when the draft
   * carried more than plain text (image attachments). `text` alone cannot
   * stand in for it: it is the composer's DISPLAY form, which collapses
   * attachments into words, so a steered image would render as a sentence
   * about an image until a reload replaced it with the agent's own copy.
   * Absent for a text-only steer, where the renderer falls back to `text` and
   * the historical behaviour is unchanged.
   */
  | {
      type: "steering"
      id: string
      text: string
      createdAt: string
      blocks?: ContentBlock[] | null
    }

export interface LiveMessage {
  id: string
  role: "assistant" | "tool"
  content: LiveContentBlock[]
  startedAt: number
}

// ── Per-connection state ──

export interface ConnectionState {
  connectionId: string
  contextKey: string
  agentType: AgentType
  workingDir: string | null
  status: ConnectionStatus
  promptCapabilities: PromptCapabilitiesInfo
  supportsFork: boolean
  selectorsReady: boolean
  sessionId: string | null
  modes: SessionModeStateInfo | null
  configOptions: SessionConfigOptionInfo[] | null
  availableCommands: AvailableCommandInfo[] | null
  usage: SessionUsageUpdateInfo | null
  liveMessage: LiveMessage | null
  pendingPermission: PendingPermission | null
  /** In-flight user prompt for the current turn — set from a `user_message`
   *  event or a snapshot's `pending_user_message`. A VIEWER mirrors this into
   *  the runtime as a synthesized user turn; `null` outside an active turn. */
  pendingUserMessage: PendingUserMessage | null
  /**
   * Feedback-note ids whose text this turn's `liveMessage` adopted as a
   * `steering` block, i.e. the mid-turn messages now rendered as user turns in
   * the transcript. The notes list above the composer reads this to drop their
   * strips: one message shows in exactly one place. Reset with `liveMessage`
   * at the start of every turn.
   *
   * The reducer is the single decider — a note it could NOT adopt (it arrived
   * out of turn) is absent here, so its strip stays. Deriving this in the
   * notes hook instead would race the reducer's own view of the status and
   * could leave a message showing nowhere at all.
   */
  steeredMessageIds: string[]
  pendingQuestion: PendingQuestion | null
  /** Awaiting-answer multiple-choice `ask_user_question` (the codeg-mcp blocking
   *  tool). Set from a `question_request` event or a snapshot's
   *  `pending_question`; cleared on `question_resolved` or turn end. Distinct
   *  from the free-text `pendingQuestion` above. */
  pendingAskQuestion: PendingQuestionState | null
  /** Awaiting-decision Grok `exit_plan_mode` approval (the plan the agent is
   *  blocked on). Set from a `plan_approval_request` event or a snapshot's
   *  `pending_plan_approval`; cleared on `plan_approval_resolved` or turn end. */
  pendingPlanApproval: PendingPlanApprovalState | null
  claudeApiRetry: ClaudeApiRetryState | null
  /** AIR typed session failure table (see `lib/session-failures.ts` for the
   *  merge/settle contract). Retained resolved — entries double as per-id
   *  revision watermarks; the banner splits active from resolved itself. */
  sessionFailures: SessionFailureRecord[]
  /** AIR async tasks — Claude's background shells / workflows / monitors (see
   *  `lib/async-tasks.ts` for the merge contract). Retained after they settle,
   *  because the adapter keeps revising a finished task; the strip filters to
   *  the live ones itself. */
  asyncTasks: AsyncTaskRecord[]
  /**
   * One-line localized message for this session's current turn / connection
   * error — what the connection-status popover shows. Only `session`-kind
   * codes land here (see `routeAcpError`): the verdict on a click (a refused
   * mode switch, a dropped image) is a notification and nothing more. The
   * error itself was notified when it happened; this is the state it left.
   * Cleared when the next prompt starts.
   */
  error: string | null
  /** `error` (red) or `warning` (amber) — how the popover tints `error`. */
  errorLevel: AcpErrorLevel
  /**
   * Set when the agent rejected `session/load` in a way codeg cannot paper
   * over: no record of the session, the session/process died, or it is
   * archived. Distinct from `error` because the UI surfaces it inline in the
   * message list with reload / new-conversation actions, instead of as a
   * toast. Cleared on the next CONNECTION_CREATED for the same key, or by
   * CLEAR_ACP_LOAD_ERROR (Reload button).
   */
  loadError: string | null
  /**
   * A shell command that undoes the failure in `loadError`, when one exists
   * (today: `codex unarchive <id>` for an archived rollout). Kept beside the
   * localized message rather than only inside it so the banner can offer a
   * copy action — the message renders in a single-line ellipsized strip, and
   * a 36-char session id is exactly what gets truncated away. `null` whenever
   * there is nothing runnable to hand the user. Cleared with `loadError`.
   */
  loadErrorCommand: string | null
  /**
   * Highest envelope.seq applied to this connection. Used to dedup the
   * live `acp://event` stream against the snapshot endpoint: a
   * HYDRATE_FROM_SNAPSHOT sets this to snapshot.event_seq, and incoming
   * envelopes with seq <= lastAppliedSeq are dropped as duplicates.
   * Phase 3b initialises to 0 on CONNECTION_CREATED.
   */
  lastAppliedSeq: number
  /**
   * True when this entry was synthesized for a backend connection that
   * was spawned by the delegation broker (not via a user-driven
   * `connect()`). Such entries piggy-back on the same reducer pipeline
   * as real connections so the child's live message, tool calls, and
   * permission requests reach the UI, but they MUST be hidden from any
   * user-facing connection list / picker, and they MUST NOT be reaped
   * by the idle sweep — their lifetime is governed by the parent's
   * delegation_started / delegation_completed events.
   */
  isDelegationChild: boolean
  /**
   * For delegation-child entries: the parent's `tool_use_id` that owns
   * this child. The DelegatedSubThread component uses this to resolve
   * the child connection state from its parent-side identifier. Null
   * for non-delegation connections.
   */
  parentToolUseId: string | null
  /**
   * For delegation-child entries: the parent connection that spawned
   * this child. Carried for diagnostic / cascade-cancel purposes; not
   * required for the rendering path. Null for non-delegation
   * connections.
   */
  parentConnectionId: string | null
  /**
   * True when this client did NOT spawn the backend connection but attached to
   * one another client already owns (cross-client live streaming, discovered
   * via `acp_find_connection_for_conversation`). A viewer is a NON-OWNING,
   * co-controlling client: it streams the same turn and MAY drive the shared
   * agent (sendPrompt/cancel target the owner's connection, serialized
   * server-side by its prompt_lock; turn-level concurrency rejection is a
   * tracked follow-up). The one hard invariant: on teardown a viewer MUST
   * detach (drop its attach subscription / reverse-map entry) and MUST NOT
   * `acpDisconnect` — that would kill the agent for the owner. Like
   * `isDelegationChild`, viewers are skipped by the idle sweep's disconnect
   * path. Distinct from `isDelegationChild` (broker-owned child bookkeeping);
   * a plain viewer is the lighter cousin with no delegation state.
   */
  isViewer: boolean
  /**
   * True when the agent's effective settings changed after this session was
   * spawned, so the running process is still on its launch-time config (env
   * vars / model provider / native config). Set from a `session_config_stale`
   * event or a hydrated snapshot; cleared when the user reverts the setting or
   * restarts the session via `reapplyConfig`. Drives the per-conversation
   * "restart to apply" banner.
   */
  configStale: boolean
  /** Which settings surface drifted, for the banner's wording. `null` when not stale. */
  configStaleKind: ConfigStaleKind | null
  /**
   * Launched-but-unresolved background tasks (async sub-agents / background
   * shells) on this connection, mirrored from `background_activity` events
   * (authoritative accounting lives in the backend transcript watcher).
   * The count itself is never rendered — it is a busy signal. Non-zero exempts
   * the connection from the frontend idle sweep and the unmount/preview
   * teardowns (killing the connection kills the agent CLI and the background
   * work with it), and marks a manual reconnect destructive so the status
   * popover warns before interrupting that work.
   */
  backgroundOutstanding: number
  /**
   * Tool-call context observed OUT-OF-TURN (status !== "prompting"), kept
   * ONLY so a background permission request can still render its command/
   * diff details. Out-of-turn wire tool events are barred from `liveMessage`
   * (the transcript overlay renders that content), but the permission dialog
   * enriches from the live tool registry — this small bounded map
   * (`OUT_OF_TURN_TOOL_CALL_CAP` newest entries) is that registry's
   * out-of-turn stand-in. Cleared when the next prompting turn starts.
   * `null` when empty (the common case allocates nothing).
   */
  outOfTurnToolCalls: ReadonlyMap<string, ToolCallInfo> | null
  /**
   * Client-local: the user dismissed (X) the stale banner for the CURRENT
   * drift. Hides the banner without touching the underlying `configStale`
   * state. Reset to `false` whenever a fresh `session_config_stale` arrives (a
   * new change re-shows the banner) and on a new connection. Never sourced from
   * the snapshot — dismissal is per-client UI state.
   */
  configStaleDismissed: boolean
}

type ConnectRequest = {
  agentType: AgentType
  workingDir?: string
  sessionId?: string
  // Persisted conversation id (when known) — drives the cross-client viewer
  // discovery gate in connect(). Not part of `sameConnectRequest` equality
  // (sessionId already distinguishes), but carried so a re-fired pending
  // request still runs discovery.
  conversationId?: number
}

function sameConnectRequest(a: ConnectRequest, b: ConnectRequest) {
  return (
    a.agentType === b.agentType &&
    (a.workingDir ?? null) === (b.workingDir ?? null) &&
    (a.sessionId ?? null) === (b.sessionId ?? null)
  )
}

// ── Reducer actions ──

type Action =
  | {
      type: "CONNECTION_CREATED"
      contextKey: string
      connectionId: string
      agentType: AgentType
      workingDir: string | null
      // Set when attaching to a connection another client owns (viewer).
      // Defaults to false (owner) when omitted.
      isViewer?: boolean
    }
  | {
      type: "HYDRATE_FROM_SNAPSHOT"
      contextKey: string
      patch: import("@/lib/snapshot-denormalize").SnapshotPatch
    }
  | { type: "CONNECTION_REMOVED"; contextKey: string }
  | { type: "REMOVE_ALL" }
  | { type: "REKEY_CONNECTION"; fromKey: string; toKey: string }
  | {
      type: "STATUS_CHANGED"
      contextKey: string
      status: ConnectionStatus
    }
  | {
      // One AIR typed session-failure upsert (`session_failure` event).
      // Merged monotonically by id+revision; see `lib/session-failures.ts`.
      type: "SESSION_FAILURE"
      contextKey: string
      record: SessionFailureRecord
    }
  | {
      // One AIR async-task delta (`async_task` event). PARTIAL — merged into
      // the task table by `lib/async-tasks.ts`; only a `spawned` delta creates.
      type: "ASYNC_TASK"
      contextKey: string
      delta: AsyncTaskDelta
    }
  | {
      // Lifecycle settle for the AIR failure table (mirrors
      // `SessionState::apply_event`). `retry_incidents` rides turn PROGRESS —
      // fresh output proves the adapter reconnected. `warnings` is dispatched
      // from the `turn_complete` handler on a CLEAN (`end_turn`) end only: a
      // cancelled/failed exit ended a turn that did NOT recover, so its
      // warnings must stay active.
      type: "SETTLE_SESSION_FAILURES"
      contextKey: string
      scope: SessionFailureSettleScope
    }
  | {
      // The user closed a strip. Client-local, like `DISMISS_CONFIG_STALE`.
      // Takes every id that strip stood for: the collapsed warning bar closes
      // its hidden siblings with it.
      type: "DISMISS_SESSION_FAILURES"
      contextKey: string
      ids: string[]
    }
  | {
      // Mirror of a `background_activity` event's `outstanding` count (the
      // backend transcript watcher's authoritative accounting) onto the
      // connection, where it gates the teardowns. No-op when the count didn't
      // change, so repeat events don't re-render connection consumers.
      type: "SET_BACKGROUND_OUTSTANDING"
      contextKey: string
      outstanding: number
    }
  | StreamingAction
  | { type: "STREAM_BATCH"; actions: StreamingAction[] }
  | {
      type: "TOOL_CALL"
      contextKey: string
      tool_call_id: string
      title: string
      kind: string
      status: string
      content: string | null
      raw_input: string | null
      raw_output: string | null
      locations: unknown
      meta: ToolCallMeta
      /** `null` when the wire event omitted the field (no images). */
      images: ToolCallImage[] | null
    }
  | {
      type: "TOOL_CALL_UPDATE"
      contextKey: string
      tool_call_id: string
      title: string | null
      fallback_title: string
      fallback_kind: string
      status: string | null
      content: string | null
      raw_input: string | null
      raw_output: string | null
      raw_output_append?: boolean
      locations: unknown
      meta: ToolCallMeta
      /**
       * `null` when the wire event omitted the field — preserve prior images.
       * `[]` (empty array) when the agent explicitly cleared images.
       * `[a, b]` to replace.
       */
      images: ToolCallImage[] | null
    }
  | {
      type: "BATCH_TOOL_CALL_UPDATES"
      actions: Array<{
        contextKey: string
        tool_call_id: string
        title: string | null
        fallback_title: string
        fallback_kind: string
        status: string | null
        content: string | null
        raw_input: string | null
        raw_output: string | null
        raw_output_append?: boolean
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        locations: any | null
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        meta: any | null
        images: ToolCallImage[] | null
      }>
    }
  | {
      type: "PERMISSION_REQUEST"
      contextKey: string
      request_id: string
      tool_call: unknown
      fallback_title: string
      fallback_kind: string
      options: PermissionOptionInfo[]
      queued?: number
    }
  | {
      type: "PERMISSION_QUEUE_DEPTH"
      contextKey: string
      depth: number
    }
  | {
      type: "PERMISSION_CLEARED"
      contextKey: string
      /**
       * When present, only clear if the current pendingPermission's request_id
       * matches. Guards against a late `permission_resolved` event wiping out a
       * fresh permission that was raised between resolve and dispatch.
       * Omit for unconditional clears (e.g. cancel paths).
       */
      requestId?: string
    }
  | {
      type: "SET_PENDING_QUESTION"
      contextKey: string
      pendingQuestion: PendingQuestion
    }
  | { type: "CLEAR_PENDING_QUESTION"; contextKey: string }
  | {
      type: "SET_ASK_QUESTION"
      contextKey: string
      pendingAskQuestion: PendingQuestionState
    }
  | {
      type: "CLEAR_ASK_QUESTION"
      contextKey: string
      /** When present, only clear if the current question_id matches (guards a
       *  late `question_resolved` from wiping a freshly-raised question). */
      questionId?: string
    }
  | {
      type: "SET_PLAN_APPROVAL"
      contextKey: string
      pendingPlanApproval: PendingPlanApprovalState
    }
  | {
      type: "CLEAR_PLAN_APPROVAL"
      contextKey: string
      /** When present, only clear if the current approval_id matches (guards a
       *  late `plan_approval_resolved` from wiping a freshly-raised approval). */
      approvalId?: string
    }
  | { type: "SESSION_STARTED"; contextKey: string; sessionId: string }
  | {
      type: "SESSION_MODES"
      contextKey: string
      modes: SessionModeStateInfo
    }
  | {
      type: "SESSION_CONFIG_OPTIONS"
      contextKey: string
      configOptions: SessionConfigOptionInfo[]
    }
  | {
      type: "CONFIG_STALE_CHANGED"
      contextKey: string
      stale: boolean
      kind: ConfigStaleKind
    }
  | {
      type: "DISMISS_CONFIG_STALE"
      contextKey: string
    }
  | {
      type: "SELECTORS_READY"
      contextKey: string
    }
  | {
      type: "PROMPT_CAPABILITIES"
      contextKey: string
      promptCapabilities: PromptCapabilitiesInfo
    }
  | {
      type: "FORK_SUPPORTED"
      contextKey: string
      supported: boolean
    }
  | { type: "MODE_CHANGED"; contextKey: string; modeId: string }
  | {
      type: "CONFIG_OPTION_CHANGED"
      contextKey: string
      configId: string
      valueId: string
    }
  | {
      type: "PLAN_UPDATE"
      contextKey: string
      entries: PlanEntryInfo[]
    }
  | {
      type: "STEERING_MESSAGE"
      contextKey: string
      id: string
      text: string
      /** The note's `created_at` (ISO) — see the `steering` block. */
      createdAt: string
      /** What the user sent, when it was more than plain text — see the
       *  `steering` block. Absent for a text-only steer. */
      blocks?: ContentBlock[] | null
    }
  | {
      type: "CLAUDE_API_RETRY"
      contextKey: string
      retry: ClaudeApiRetryState | null
    }
  | {
      // A `session`-kind `error` event (see `routeAcpError`), localized.
      type: "ERROR"
      contextKey: string
      message: string
      level: AcpErrorLevel
    }
  | {
      type: "ACP_LOAD_ERROR"
      contextKey: string
      message: string
      /** Runnable recovery for this failure, or null when there is none. */
      command?: string | null
    }
  | { type: "CLEAR_ACP_LOAD_ERROR"; contextKey: string }
  | {
      type: "AVAILABLE_COMMANDS"
      contextKey: string
      commands: AvailableCommandInfo[]
    }
  | {
      type: "USAGE_UPDATE"
      contextKey: string
      usage: SessionUsageUpdateInfo
    }
  | {
      type: "EVENT_APPLIED"
      contextKey: string
      seq: number
    }
  | {
      /**
       * Synthesize a ConnectionState for a delegation-spawned child so
       * its acp://event stream lands in the reducer the same way a
       * user-driven connect() does. contextKey == connectionId for these
       * entries — the child has no user-facing tab to anchor a separate
       * key against.
       */
      type: "DELEGATION_CHILD_ATTACH"
      contextKey: string
      connectionId: string
      agentType: AgentType
      parentConnectionId: string
      parentToolUseId: string
    }
  | {
      /**
       * Remove the synthetic child entry once the delegation has wound
       * down (delegation_completed) and any grace window has elapsed.
       * No-op when the entry is already gone.
       */
      type: "DELEGATION_CHILD_DETACH"
      contextKey: string
    }

type StreamingAction =
  | {
      type: "CONTENT_DELTA"
      contextKey: string
      text: string
      parentToolUseId?: string
    }
  | {
      type: "THINKING"
      contextKey: string
      text: string
      parentToolUseId?: string
    }

/** One display frame: the narrowest window streaming deltas coalesce into. */
export const STREAM_FLUSH_FRAME_MS = 16
/**
 * The widest — about five batches a second.
 *
 * Kept well under the 500 ms sample period of the tok/s gauge
 * (`useTokenOutputSpeed`), which reads the live message on its own clock: at
 * most one window's worth of text can be un-flushed when it samples, so the
 * reading stays accurate. Raising this past ~250 ms would make that gauge
 * sawtooth, and is not a free knob.
 */
export const STREAM_FLUSH_MAX_MS = 192
/** Characters of re-rendered live content that buy one more frame. */
const STREAM_FLUSH_CHARS_PER_FRAME = 8 * 1024
/**
 * What one re-rendered non-prose block costs, in prose-equivalent characters.
 *
 * Measured in the real component tree (jsdom, React 19), re-rendering a live
 * turn the way a batch does — growing prose costs 0.00075 ms/char, while each
 * block that re-renders whole costs a FLAT 0.02 ms (a collapsed thinking
 * block) to 0.18 ms (a plan card), with a tool card at 0.06 ms. That is 30 to
 * 235 prose-equivalent characters; 128 sits inside the range, so 64 cards buy
 * one extra frame.
 *
 * Flat, not proportional to the block's content, because that is what the
 * measurement shows: a collapsed thinking block costs the same at 200 and at
 * 4000 characters, since the cards render clamped previews and Radix keeps
 * closed content unmounted.
 */
const STREAM_FLUSH_BLOCK_CHARS = 128
/**
 * Deltas one connection may coalesce before the window is cut short. A safety
 * valve for a burst the timer can't keep up with, not a cadence knob — it
 * bounds one connection's unrendered backlog, so it is per connection like the
 * window it pre-empts.
 */
const STREAM_QUEUE_CAP = 256

/**
 * What the next batch will re-render, in prose-equivalent characters, read off
 * the live message as of the LAST batch.
 *
 * Every batch replaces the live message, so the whole turn is re-adapted and
 * handed to the renderer again. What that costs is NOT uniform:
 *
 * - The trailing text/thinking run — the block this batch grows — is
 *   re-rendered whole: normalized, re-lexed into markdown blocks,
 *   re-highlighted. Linear in its length, and the dominant term.
 * - Settled prose above it is FREE: `TextPart` memoizes on the string by
 *   value, so an unchanged run bails out before the markdown renderer.
 *   (Measured: eight extra settled 8 KB blocks cost nothing.)
 * - Everything else — tool cards, closed thinking blocks, plan cards,
 *   steering notes — re-renders on EVERY batch regardless. They memoize on
 *   the part object, and `createMessageTurnAdapter` refuses to cache a
 *   streaming turn (`cacheable = !isStreaming && !inProgress`), so each batch
 *   hands them freshly built objects. Charged a flat
 *   `STREAM_FLUSH_BLOCK_CHARS` each.
 *
 * A turn that has run a hundred tools and is now writing its summary has a
 * short run and a real per-batch cost; sizing from the run alone would leave
 * it on a single frame while it burns a third of every one.
 */
export function liveRerenderChars(
  content: readonly LiveContentBlock[] | undefined
): number {
  if (!content || content.length === 0) return 0
  let chars = 0
  const lastIndex = content.length - 1
  for (let i = 0; i < content.length; i++) {
    const block = content[i]
    if (block.type === "text" || block.type === "thinking") {
      // Only the trailing run is charged per character — it is the one the
      // batch grows, and the only one whose memo the batch invalidates. (A
      // trailing thinking run is charged in full on the assumption it is
      // expanded while it streams; if it is not, this over-charges by one
      // block, which the ceiling bounds. Same for a trailing run that belongs
      // to a sub-agent: `parentToolUseId` is deliberately not read here, so a
      // delegated run is charged as main prose. It renders inside a capsule
      // that may be collapsed, so this errs toward the wider window — the
      // direction that costs latency, never correctness.)
      if (i === lastIndex) chars += block.text.length
      continue
    }
    chars += STREAM_FLUSH_BLOCK_CHARS
  }
  return chars
}

/**
 * How long streaming deltas coalesce before one `STREAM_BATCH` lands, given
 * what that batch will re-render (see `liveRerenderChars`).
 *
 * The cost is linear in that, and the window was a flat 16 ms — so the work a
 * turn cost grew with the SQUARE of its own output, while the rate it arrived
 * at stayed the same. Past a few tens of KB the renderer could no longer keep
 * up with the stream, which is #589: at ~300 tok/s the whole UI stops
 * responding, on hardware with plenty of headroom.
 *
 * Measured on a 300 tok/s stream, counting the characters re-rendered across
 * a turn: 30 s of output cost 32.5M before and 11.1M after; 120 s cost 518.8M
 * before and 59.9M after.
 *
 * Under 8 KB — nearly every reply — keeps the 16 ms window it has today. Past
 * that each further 8 KB buys one more frame, so the cost per second flattens
 * out instead of climbing with the answer.
 *
 * Nothing about WHAT gets delivered changes: the queue merges and dispatches
 * exactly as before, every chunk lands once and in order, and every event that
 * MUTATES the live message — a tool card, a permission prompt, the end of a
 * turn — flushes the queue first, so none of them waits on this window and
 * none of them can land out of wire order. (Events that touch nothing the
 * transcript renders, such as `permission_resolved` or `async_task`, do not
 * flush; that predates this window and is unchanged by it.)
 */
export function streamFlushDelayMs(liveRunChars: number): number {
  const frames = Math.max(
    1,
    Math.ceil(liveRunChars / STREAM_FLUSH_CHARS_PER_FRAME)
  )
  return Math.min(STREAM_FLUSH_MAX_MS, STREAM_FLUSH_FRAME_MS * frames)
}

type ConnectionsMap = Map<string, ConnectionState>
const MAX_LIVE_TOOL_RAW_OUTPUT_CHARS = 200_000
const MAX_BUFFERED_UNMAPPED_EVENTS_PER_CONNECTION = 64
const MAX_BUFFERED_UNMAPPED_CONNECTIONS = 128
/**
 * How many times a user-driven `reconnect` will wait for an in-flight
 * `connect()` on the same key before giving up and rebuilding anyway. Small on
 * purpose: this only absorbs a connect that was already running (or the one
 * connect() itself re-dispatches for a superseded request), and a key that
 * keeps reconnecting on its own must not hang the button forever.
 */
const MAX_RECONNECT_SETTLE_WAITS = 3
/**
 * How long each of those waits will hold. A connect settles by resolving its
 * IPC, so one that never answers would otherwise park the reconnect FOREVER —
 * and a wedged connect is the very state this button is clicked from. Generous
 * enough to cover a real agent spawn (the wait exists to let that finish);
 * expiring just returns the button to the user to try again.
 */
const CONNECT_SETTLE_WAIT_TIMEOUT_MS = 15_000

// Per-agentType cache for selectors (modes / configOptions).
// Populated when real data arrives from the backend.
// Used as UI-layer fallback when the connection hasn't received real data yet.
const selectorsCache = new Map<
  string,
  {
    modes: SessionModeStateInfo | null
    configOptions: SessionConfigOptionInfo[] | null
  }
>()

export function getCachedSelectors(agentType: string) {
  return selectorsCache.get(agentType) ?? null
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null
  }
  return value as Record<string, unknown>
}

const PERMISSION_TOOL_INPUT_KEYS = [
  "rawInput",
  "raw_input",
  "input",
  "arguments",
  "params",
  "payload",
] as const

function asFiniteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function parseClaudeApiRetryEvent(
  event: Extract<AcpEvent, { type: "claude_sdk_message" }>
): ClaudeApiRetryState | null {
  const message = asRecord(event.message)
  if (!message) return null
  if (message.type !== "system" || message.subtype !== "api_retry") return null

  return {
    sessionId:
      typeof message.session_id === "string"
        ? message.session_id
        : event.session_id,
    attempt: asFiniteNumber(message.attempt),
    maxRetries: asFiniteNumber(message.max_retries),
    error: typeof message.error === "string" ? message.error : null,
    errorStatus: asFiniteNumber(message.error_status),
    retryDelayMs: asFiniteNumber(message.retry_delay_ms),
    // Claude's api_retry always carries a cause in principle; an absent one is a
    // gap in THIS message, so keep the existing fallback wording for it.
    reportsError: true,
  }
}

function extractPermissionToolCallId(toolCall: unknown): string | null {
  const record = asRecord(toolCall)
  if (!record) return null
  const candidates = [
    record.call_id,
    record.callId,
    record.tool_call_id,
    record.toolCallId,
    record.id,
  ]
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate
    }
  }
  return null
}

function pickPermissionToolInput(record: Record<string, unknown>): unknown {
  for (const key of PERMISSION_TOOL_INPUT_KEYS) {
    const value = record[key]
    if (value === undefined || value === null) continue
    if (typeof value === "string" && value.trim().length === 0) continue
    return value
  }
  return null
}

function serializePermissionInput(value: unknown): string | null {
  if (value === undefined || value === null) return null
  if (typeof value === "string") {
    return value.trim().length > 0 ? value : null
  }
  try {
    return JSON.stringify(value)
  } catch {
    return null
  }
}

function serializePermissionToolCall(toolCall: unknown): string | null {
  const record = asRecord(toolCall)
  if (!record) return null
  try {
    // Extract the actual tool input rather than serializing the entire
    // permission wrapper (which includes internal fields like kind/status/id).
    const nestedInput = pickPermissionToolInput(record)
    const serializedNestedInput = serializePermissionInput(nestedInput)
    if (serializedNestedInput) return serializedNestedInput

    // Fallback: strip wrapper-only fields to avoid rendering internal
    // permission structure as raw text.
    const wrapperKeys = new Set([
      "content",
      "kind",
      "status",
      "title",
      "toolCallId",
      "tool_call_id",
      "callId",
      "call_id",
      ...PERMISSION_TOOL_INPUT_KEYS,
    ])
    const rest: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(record)) {
      if (!wrapperKeys.has(k)) rest[k] = v
    }
    return Object.keys(rest).length > 0 ? JSON.stringify(rest) : null
  } catch {
    return null
  }
}

function findLiveToolCallInfo(
  content: LiveContentBlock[],
  toolCallId: string | null
): ToolCallInfo | null {
  if (!toolCallId) return null
  const block = content.find(
    (item) => item.type === "tool_call" && item.info.tool_call_id === toolCallId
  )
  return block?.type === "tool_call" ? block.info : null
}

function mergePermissionToolCallWithLiveInfo(
  toolCall: unknown,
  liveInfo: ToolCallInfo | null
): unknown {
  if (!liveInfo) return toolCall

  const rawInput = serializePermissionInput(liveInfo.raw_input)
  const record = asRecord(toolCall)
  if (!record) {
    if (!rawInput) return toolCall
    return {
      toolCallId: liveInfo.tool_call_id,
      title: liveInfo.title,
      kind: liveInfo.kind,
      rawInput,
    }
  }

  const next = { ...record }
  let changed = false
  const existingInput = serializePermissionInput(pickPermissionToolInput(next))
  if (!existingInput && rawInput) {
    next.rawInput = rawInput
    changed = true
  }
  if (typeof next.title !== "string" || next.title.trim().length === 0) {
    next.title = liveInfo.title
    changed = true
  }
  if (typeof next.kind !== "string" || next.kind.trim().length === 0) {
    next.kind = liveInfo.kind
    changed = true
  }
  if (!extractPermissionToolCallId(next)) {
    next.toolCallId = liveInfo.tool_call_id
    changed = true
  }
  return changed ? next : toolCall
}

function mergePendingPermissionWithLiveInfo(
  pendingPermission: PendingPermission | null,
  liveInfo: ToolCallInfo | null
): PendingPermission | null {
  if (!pendingPermission || !liveInfo) return pendingPermission
  const permissionCallId = extractPermissionToolCallId(
    pendingPermission.tool_call
  )
  if (permissionCallId !== liveInfo.tool_call_id) return pendingPermission

  const toolCall = mergePermissionToolCallWithLiveInfo(
    pendingPermission.tool_call,
    liveInfo
  )
  if (toolCall === pendingPermission.tool_call) return pendingPermission
  return {
    ...pendingPermission,
    tool_call: toolCall,
  }
}

function mergePendingPermissionWithLiveMessage(
  pendingPermission: PendingPermission | null,
  liveMessage: LiveMessage | null
): PendingPermission | null {
  const permissionCallId = extractPermissionToolCallId(
    pendingPermission?.tool_call
  )
  const liveInfo = liveMessage
    ? findLiveToolCallInfo(liveMessage.content, permissionCallId)
    : null
  return mergePendingPermissionWithLiveInfo(pendingPermission, liveInfo)
}

function extractPermissionToolTitle(toolCall: unknown): string | null {
  const record = asRecord(toolCall)
  if (!record) return null
  const candidates = [record.title, record.tool_name, record.name, record.type]
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate
    }
  }
  return null
}

function extractPermissionToolKind(toolCall: unknown): string | null {
  const record = asRecord(toolCall)
  if (!record) return null
  const candidates = [record.kind, record.tool_name, record.name, record.type]
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate
    }
  }
  return null
}

/**
 * Extract the free-text question for the LEGACY `QuestionDialog` from a tool
 * call's raw input — gated on a singular `question` STRING field. Exported so a
 * regression test can prove the new multiple-choice `ask_user_question` tool
 * (whose input is `{ questions: [...] }`, plural array) never trips this legacy
 * path even though tool-name normalization classifies it as "question".
 */
export function extractQuestionText(rawInput: string | null): string | null {
  if (!rawInput) return null
  try {
    const parsed = JSON.parse(rawInput)
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof parsed.question === "string"
    ) {
      return parsed.question
    }
  } catch {
    // not JSON, try using rawInput as-is if it looks like a question
  }
  return null
}

function sameModes(
  a: SessionModeStateInfo | null,
  b: SessionModeStateInfo
): boolean {
  if (a === b) return true
  if (!a) return false
  if (a.current_mode_id !== b.current_mode_id) return false
  if (a.available_modes.length !== b.available_modes.length) return false
  for (let i = 0; i < a.available_modes.length; i += 1) {
    const left = a.available_modes[i]
    const right = b.available_modes[i]
    if (
      left.id !== right.id ||
      left.name !== right.name ||
      left.description !== right.description
    ) {
      return false
    }
  }
  return true
}

function samePromptCapabilities(
  a: PromptCapabilitiesInfo,
  b: PromptCapabilitiesInfo
): boolean {
  return (
    a.image === b.image &&
    a.audio === b.audio &&
    a.embedded_context === b.embedded_context
  )
}

function samePlanEntries(a: PlanEntryInfo[], b: PlanEntryInfo[]): boolean {
  if (a === b) return true
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i += 1) {
    if (
      a[i].content !== b[i].content ||
      a[i].priority !== b[i].priority ||
      a[i].status !== b[i].status
    ) {
      return false
    }
  }
  return true
}

function sameConfigOptions(
  a: SessionConfigOptionInfo[] | null,
  b: SessionConfigOptionInfo[]
): boolean {
  if (a === b) return true
  if (!a) return false
  if (a.length !== b.length) return false

  for (let i = 0; i < a.length; i += 1) {
    const left = a[i]
    const right = b[i]
    if (
      left.id !== right.id ||
      left.name !== right.name ||
      left.description !== right.description ||
      left.category !== right.category ||
      // Rendered (the "recommended" badge), so it has to be compared or a
      // push that changes ONLY the recommendation is swallowed and the badge
      // goes stale. codex publishes `reasoning_effort`'s recommendation as the
      // CURRENT model's default, so it moves on its own schedule.
      (left.recommended_value ?? null) !== (right.recommended_value ?? null)
    ) {
      return false
    }

    const leftKind = left.kind
    const rightKind = right.kind
    if (leftKind.type !== rightKind.type) return false

    // Every kind must compare its own `current_value`. Falling through as
    // "equal" is how the agent's authoritative answer to a boolean toggle got
    // swallowed (#709) — so an unrecognized kind reports *unequal* instead: a
    // redundant re-render on a cold path is the cheap failure, a dropped state
    // update is the expensive one.
    if (leftKind.type === "boolean") {
      if (leftKind.current_value !== rightKind.current_value) return false
      continue
    }

    if (leftKind.type !== "select") return false

    if (leftKind.current_value !== rightKind.current_value) return false
    if (leftKind.options.length !== rightKind.options.length) return false
    if (leftKind.groups.length !== rightKind.groups.length) return false

    for (let j = 0; j < leftKind.options.length; j += 1) {
      const lo = leftKind.options[j]
      const ro = rightKind.options[j]
      if (
        lo.value !== ro.value ||
        lo.name !== ro.name ||
        lo.description !== ro.description
      ) {
        return false
      }
    }

    for (let j = 0; j < leftKind.groups.length; j += 1) {
      const lg = leftKind.groups[j]
      const rg = rightKind.groups[j]
      if (lg.group !== rg.group || lg.name !== rg.name) return false
      if (lg.options.length !== rg.options.length) return false
      for (let k = 0; k < lg.options.length; k += 1) {
        const lgo = lg.options[k]
        const rgo = rg.options[k]
        if (
          lgo.value !== rgo.value ||
          lgo.name !== rgo.name ||
          lgo.description !== rgo.description
        ) {
          return false
        }
      }
    }
  }
  return true
}

function sameCommands(
  a: AvailableCommandInfo[] | null,
  b: AvailableCommandInfo[]
): boolean {
  if (a === b) return true
  if (!a) return false
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i += 1) {
    if (
      a[i].name !== b[i].name ||
      a[i].description !== b[i].description ||
      a[i].input_hint !== b[i].input_hint
    ) {
      return false
    }
  }
  return true
}

/**
 * The kind an optimistic `setConfigOption` lands on, or `null` when the pick
 * changes nothing — or cannot be interpreted here, in which case the agent's
 * own answer is left to settle it.
 *
 * Config values are opaque strings the whole way down (this store, the Tauri
 * command, the web handler, the preference store); only the backend's wire
 * encoder knows an option's kind decides the payload, turning `"true"` into a
 * real JSON boolean. This is the mirror of that decode, and it is deliberately
 * strict about the two values a toggle emits: guessing "off" for anything else
 * would be a silent lie about whether the agent may run tools unasked.
 */
function nextConfigOptionKind(
  kind: SessionConfigKindInfo,
  valueId: string
): SessionConfigKindInfo | null {
  if (kind.type === "select") {
    if (kind.current_value === valueId) return null
    return { ...kind, current_value: valueId }
  }
  if (kind.type === "boolean") {
    if (valueId !== "true" && valueId !== "false") return null
    const nextValue = valueId === "true"
    if (kind.current_value === nextValue) return null
    return { ...kind, current_value: nextValue }
  }
  return null
}

function dedupeCommandsByName(
  commands: AvailableCommandInfo[]
): AvailableCommandInfo[] {
  const seen = new Set<string>()
  let deduped: AvailableCommandInfo[] | null = null

  for (let i = 0; i < commands.length; i += 1) {
    const command = commands[i]
    if (seen.has(command.name)) {
      deduped ??= commands.slice(0, i)
      continue
    }

    seen.add(command.name)
    deduped?.push(command)
  }

  return deduped ?? commands
}

/**
 * Lazy-create a `LiveMessage` shell mirroring the backend's
 * `ensure_live_message` semantic. Required because the backend only
 * initializes `session_state.live_message` when the first `ContentDelta` /
 * `Thinking` / `ToolCall` / `PlanUpdate` arrives — there's a window between
 * `StatusChanged(Prompting)` and the first content event in which the
 * snapshot reports `live_message: null`. After a browser refresh inside
 * that window, the live `STATUS_CHANGED(prompting)` event won't re-fire
 * (status is already prompting in the snapshot), so without this fallback
 * the reducer would drop every subsequent delta / tool call / plan update.
 */
function ensureLiveMessage(prev: LiveMessage | null): LiveMessage {
  if (prev) return prev
  return {
    id: randomUUID(),
    role: "assistant",
    content: [],
    startedAt: Date.now(),
  }
}

/** Shared empty `steeredMessageIds`, so a turn that steers nothing (almost all
 *  of them) keeps a stable reference through `connRenderEqual`. */
const EMPTY_STEERED_MESSAGE_IDS: string[] = []

/** Last time an out-of-turn drop was logged — module-level sampling clock. */
let lastOutOfTurnDropLogAt = 0

function applyStreamingAction(
  conn: ConnectionState,
  action: StreamingAction
): ConnectionState | null {
  // OUT-OF-TURN guard: the backend's idle loop forwards session/updates that
  // arrive BETWEEN turns (background sub-agent completions, the agent's
  // continued autonomous work). Appending those here would graft them onto
  // the previous turn's completed liveMessage — the historical "background
  // results render garbled/incomplete" bug. The transcript watcher's
  // `background_activity` overlay is the single render path for out-of-turn
  // content, so wire deltas outside a prompting turn are dropped. Ordering is
  // safe: the backend emits StatusChanged(prompting) before any turn content,
  // and turn_complete flushes queued deltas before flipping status back.
  if (conn.status !== "prompting") {
    // Sampled: an autonomous (cron//loop) turn streams the ENTIRE wire
    // out-of-turn — logging every dropped delta would spam the console and
    // allocate per token for minutes at a time.
    const now = Date.now()
    if (now - lastOutOfTurnDropLogAt > 5_000) {
      lastOutOfTurnDropLogAt = now
      console.debug(
        "[acp] dropping out-of-turn streaming deltas (transcript overlay renders them)",
        { contextKey: conn.contextKey, type: action.type }
      )
    }
    return null
  }
  // CONTENT_DELTA with empty text is a true no-op. THINKING with empty text
  // is allowed to create the initial placeholder block so the UI can show
  // a "Thinking..." indicator immediately (and for newer Claude models that
  // redact thinking text entirely, keeping the empty block as the signal).
  if (action.type === "CONTENT_DELTA" && action.text.length === 0) return null

  // Orphan gate for subagent-attributed chunks: the parent Agent tool_call
  // always precedes its subagent's chunks on the seq-ordered wire (and
  // `tool_call` dispatch flushes the streaming queue first), so a parented
  // delta whose parent is absent from liveMessage is out-of-turn residue —
  // e.g. an async subagent still streaming after its parent turn settled.
  // Dropping it here keeps liveMessage, its runtime-store sinks, and
  // COMPLETE_TURN promotion consistent, and bounds memory (orphan text never
  // accumulates).
  if (action.parentToolUseId) {
    const parentPresent = conn.liveMessage?.content.some(
      (b) =>
        b.type === "tool_call" && b.info.tool_call_id === action.parentToolUseId
    )
    if (!parentPresent) return null
  }

  const prev = ensureLiveMessage(conn.liveMessage)
  const lastBlock = prev.content[prev.content.length - 1]
  let newContent: LiveContentBlock[] | null = null

  // Merge only into a trailing block of the same kind AND the same subagent
  // attribution — main → subagent → main must produce three blocks. Mirrors
  // the backend's `append_text_delta` predicate so a snapshot-hydrated client
  // converges on identical block boundaries.
  if (action.type === "CONTENT_DELTA") {
    if (
      lastBlock?.type === "text" &&
      lastBlock.parentToolUseId === action.parentToolUseId
    ) {
      newContent = [
        ...prev.content.slice(0, -1),
        {
          type: "text",
          text: lastBlock.text + action.text,
          parentToolUseId: action.parentToolUseId,
        },
      ]
    } else {
      newContent = [
        ...prev.content,
        {
          type: "text",
          text: action.text,
          parentToolUseId: action.parentToolUseId,
        },
      ]
    }
  } else {
    if (
      action.text.length === 0 &&
      lastBlock?.type === "thinking" &&
      lastBlock.parentToolUseId === action.parentToolUseId
    ) {
      // Already have a thinking block of this attribution; an empty
      // follow-up event is a no-op. (A parented empty chunk must not
      // suppress the main thread's "Thinking..." placeholder, nor vice
      // versa — hence the attribution check.)
      return null
    }
    if (
      lastBlock?.type === "thinking" &&
      lastBlock.parentToolUseId === action.parentToolUseId
    ) {
      newContent = [
        ...prev.content.slice(0, -1),
        {
          type: "thinking",
          text: lastBlock.text + action.text,
          parentToolUseId: action.parentToolUseId,
        },
      ]
    } else {
      newContent = [
        ...prev.content,
        {
          type: "thinking",
          text: action.text,
          parentToolUseId: action.parentToolUseId,
        },
      ]
    }
  }

  if (!newContent) return null
  return {
    ...conn,
    liveMessage: { ...prev, content: newContent },
    // Streaming content implies the SDK has recovered from any in-flight
    // Claude API retry, so hide the retry banner immediately instead of
    // waiting for the prompt cycle to end.
    claudeApiRetry: null,
  }
}

/** Newest out-of-turn tool-call contexts kept per connection (see
 *  `ConnectionState.outOfTurnToolCalls`). Permission enrichment only ever
 *  needs the last few. */
const OUT_OF_TURN_TOOL_CALL_CAP = 8

/**
 * Overlay-fold refetch: once a conversation's background overlay exceeds this
 * many turns, fold them into persisted turns via a detail refetch (the
 * watermark rule retires covered entries). Keeps a day-long cron//loop
 * session's overlay — which never settles, so nothing else refetches —
 * bounded. Sized so the fold runs every few dozen autonomous turns, not per
 * turn.
 */
const OVERLAY_FOLD_THRESHOLD = 60
/** Floor between overlay-fold refetches per conversation, so a failing
 *  backend (refetch errors, overlay keeps growing) can't escalate into a
 *  refetch per background event. */
const OVERLAY_FOLD_MIN_INTERVAL_MS = 30_000
/** conversationId → epoch ms of the last overlay-fold refetch. Module-level:
 *  survives provider re-renders; a few entries only (conversations with
 *  active background overlay). */
const overlayFoldRefetchAt = new Map<number, number>()

/** Upsert one out-of-turn tool-call info into the bounded registry,
 *  evicting the oldest entry past the cap. Returns a fresh map. */
function recordOutOfTurnToolCall(
  existing: ReadonlyMap<string, ToolCallInfo> | null,
  info: ToolCallInfo
): ReadonlyMap<string, ToolCallInfo> {
  const next = new Map(existing ?? [])
  next.delete(info.tool_call_id)
  next.set(info.tool_call_id, info)
  while (next.size > OUT_OF_TURN_TOOL_CALL_CAP) {
    const oldest = next.keys().next().value
    if (oldest === undefined) break
    next.delete(oldest)
  }
  return next
}

function connectionsReducer(
  state: ConnectionsMap,
  action: Action
): ConnectionsMap {
  switch (action.type) {
    case "CONNECTION_CREATED": {
      const next = new Map(state)
      next.set(action.contextKey, {
        connectionId: action.connectionId,
        contextKey: action.contextKey,
        agentType: action.agentType,
        workingDir: action.workingDir,
        status: "connecting",
        promptCapabilities: {
          image: false,
          audio: false,
          embedded_context: false,
        },
        supportsFork: false,
        selectorsReady: false,
        sessionId: null,
        modes: null,
        configOptions: null,
        availableCommands: null,
        usage: null,
        liveMessage: null,
        pendingPermission: null,
        pendingUserMessage: null,
        steeredMessageIds: EMPTY_STEERED_MESSAGE_IDS,
        pendingQuestion: null,
        pendingAskQuestion: null,
        pendingPlanApproval: null,
        claudeApiRetry: null,
        sessionFailures: [],
        asyncTasks: [],
        error: null,
        errorLevel: "error",
        loadError: null,
        loadErrorCommand: null,
        lastAppliedSeq: 0,
        isDelegationChild: false,
        parentToolUseId: null,
        parentConnectionId: null,
        isViewer: action.isViewer ?? false,
        configStale: false,
        configStaleKind: null,
        configStaleDismissed: false,
        backgroundOutstanding: 0,
        outOfTurnToolCalls: null,
      })
      return next
    }

    case "DELEGATION_CHILD_ATTACH": {
      // Idempotent: if an entry already exists for this key with the
      // same connectionId, leave it untouched so a duplicate
      // delegation_started (e.g. replayed from snapshot hydration after
      // a refresh) doesn't blow away the live stream that has already
      // populated. If the connectionId differs we replace, since a new
      // spawn won the race.
      const existing = state.get(action.contextKey)
      if (existing && existing.connectionId === action.connectionId) {
        return state
      }
      const next = new Map(state)
      next.set(action.contextKey, {
        connectionId: action.connectionId,
        contextKey: action.contextKey,
        agentType: action.agentType,
        workingDir: null,
        // The child is already alive in the backend by the time
        // delegation_started fires; treat it as connected so any UI
        // surface that gates on status reflects reality.
        status: "connected",
        promptCapabilities: {
          image: false,
          audio: false,
          embedded_context: false,
        },
        supportsFork: false,
        selectorsReady: true,
        sessionId: null,
        modes: null,
        configOptions: null,
        availableCommands: null,
        usage: null,
        liveMessage: null,
        pendingPermission: null,
        pendingUserMessage: null,
        steeredMessageIds: EMPTY_STEERED_MESSAGE_IDS,
        pendingQuestion: null,
        pendingAskQuestion: null,
        pendingPlanApproval: null,
        claudeApiRetry: null,
        sessionFailures: [],
        asyncTasks: [],
        error: null,
        errorLevel: "error",
        loadError: null,
        loadErrorCommand: null,
        lastAppliedSeq: 0,
        isDelegationChild: true,
        parentToolUseId: action.parentToolUseId,
        parentConnectionId: action.parentConnectionId,
        isViewer: false,
        configStale: false,
        configStaleKind: null,
        configStaleDismissed: false,
        backgroundOutstanding: 0,
        outOfTurnToolCalls: null,
      })
      return next
    }

    case "DELEGATION_CHILD_DETACH": {
      const existing = state.get(action.contextKey)
      if (!existing || !existing.isDelegationChild) return state
      const next = new Map(state)
      next.delete(action.contextKey)
      return next
    }

    case "HYDRATE_FROM_SNAPSHOT": {
      const current = state.get(action.contextKey)
      if (!current) return state
      // Identity guard: the connection at this contextKey may have been
      // disconnected and replaced between the snapshot fetch firing and
      // its async response. eventSeq alone is not enough — a stale snapshot
      // from connection A (high seq) would otherwise overwrite a fresh
      // connection B (lastAppliedSeq=0) at the same contextKey.
      if (current.connectionId !== action.patch.connectionId) return state

      // Latched-once / fill-null fields are always safe to merge, even when
      // the snapshot is stale by event_seq. Their producing events
      // (`selectors_ready`, `fork_supported`, `session_modes`,
      // `session_config_options`, `available_commands`, `prompt_capabilities`)
      // typically fire only once during the initial handshake, so the
      // snapshot is the only recovery path after a refresh that missed the
      // original live event. Without this, a mid-stream browser refresh
      // races the snapshot fetch against new content_delta events: the
      // deltas advance lastAppliedSeq past the snapshot's event_seq, the
      // outer guard rejects the patch, and `selectorsReady` never recovers
      // — leaving the bottom status bar stuck on "正在初始化 xxx 会话".
      const mergedSelectorsReady =
        action.patch.selectorsReady || current.selectorsReady
      const mergedSupportsFork =
        action.patch.supportsFork || current.supportsFork
      const mergedModes = current.modes ?? action.patch.modes
      const mergedConfigOptions =
        current.configOptions ?? action.patch.configOptions
      const mergedAvailableCommands =
        current.availableCommands ?? action.patch.availableCommands
      const mergedPromptCapabilities =
        action.patch.promptCapabilities ?? current.promptCapabilities

      // Race guard: the snapshot may have been generated BEFORE events
      // that have since arrived and been applied to in-memory state.
      // Mutable fields (status, sessionId, liveMessage, pendingPermission,
      // usage, error) are fresher in memory than in the snapshot and must NOT
      // be overwritten — but the latched/fill-null fields above are still
      // applied so the once-per-lifetime bits can recover. `error` in
      // particular is cleared on a new prompt (STATUS_CHANGED → prompting), so
      // folding a stale snapshot's `lastError` back in here would resurrect an
      // error the current turn already cleared; it is recovered on the fresh
      // path below instead.
      // AIR failure records merge on BOTH branches: the per-id monotonic rule
      // is idempotent and can only add or upgrade entries, never clobber a
      // fresher live one — so even a stale-by-eventSeq snapshot may safely
      // contribute records this client attached too late to see live.
      const mergedSessionFailures = mergeSessionFailures(
        current.sessionFailures,
        action.patch.sessionFailures
      )
      // Async tasks contribute on both branches — a client that attached
      // mid-episode has no other way to learn about work already running — but
      // NOT by the same rule, because the rows carry no revision. On the fresh
      // branch the snapshot is the backend's merge of every delta up to a seq
      // this client hasn't reached, so replacing by id is right. On the stale
      // branch it predates deltas already applied here, and replacing would
      // walk a task the client watched finish back to `running` with no live
      // event left to correct it. There it may only ADD ids we don't have.
      //
      // Both branches are additionally gated on the snapshot describing the
      // SESSION we are on. The rows are session-scoped and the fork transition
      // clears them, but a snapshot fetch that started before the fork can land
      // after it — a viewer hydrating while the owner's route consumed the fork
      // event is the ordinary way there — and would re-add rows whose terminal
      // frames now publish on a session id this connection has left. Nothing
      // would ever settle them: no live event, no valid stop target, and a live
      // row defers the idle sweep. The same identity-guard shape as the
      // `connectionId` check above, one level down.
      const sameSession =
        action.patch.sessionId === null ||
        current.sessionId === null ||
        action.patch.sessionId === current.sessionId
      const isStaleSnapshot = action.patch.eventSeq <= current.lastAppliedSeq
      const mergedAsyncTasks = !sameSession
        ? current.asyncTasks
        : isStaleSnapshot
          ? adoptUnknownAsyncTasks(current.asyncTasks, action.patch.asyncTasks)
          : mergeAsyncTasks(current.asyncTasks, action.patch.asyncTasks)

      if (isStaleSnapshot) {
        if (
          mergedSelectorsReady === current.selectorsReady &&
          mergedSupportsFork === current.supportsFork &&
          mergedModes === current.modes &&
          mergedConfigOptions === current.configOptions &&
          mergedAvailableCommands === current.availableCommands &&
          mergedPromptCapabilities === current.promptCapabilities &&
          mergedSessionFailures === current.sessionFailures &&
          mergedAsyncTasks === current.asyncTasks
        ) {
          return state
        }
        const next = new Map(state)
        next.set(action.contextKey, {
          ...current,
          modes: mergedModes,
          configOptions: mergedConfigOptions,
          availableCommands: mergedAvailableCommands,
          promptCapabilities: mergedPromptCapabilities,
          selectorsReady: mergedSelectorsReady,
          supportsFork: mergedSupportsFork,
          sessionFailures: mergedSessionFailures,
          asyncTasks: mergedAsyncTasks,
        })
        return next
      }

      const hydratedLiveMessage = action.patch.liveMessage
      const hydratedPendingPermission = mergePendingPermissionWithLiveMessage(
        action.patch.pendingPermission,
        hydratedLiveMessage ?? current.liveMessage
      )
      const next = new Map(state)
      next.set(action.contextKey, {
        ...current,
        status: action.patch.status,
        sessionId: action.patch.sessionId,
        modes: action.patch.modes,
        configOptions: action.patch.configOptions,
        availableCommands: action.patch.availableCommands,
        usage: action.patch.usage,
        liveMessage: hydratedLiveMessage,
        // The snapshot's live message REPLACES the local one, and the wire has
        // no `steering` block (the backend never records one — see
        // `snapshot-denormalize`), so every adopted mid-turn message is gone
        // from the transcript with it. Keeping the adoption ids past that would
        // hide the strips for messages that are no longer rendered anywhere,
        // which is the one failure worse than showing them twice. Drop them:
        // the notes list (hydrated from the same snapshot's `feedback`) shows
        // those messages as strips again.
        //
        // Unconditional, including a null `liveMessage` — where the runtime
        // mirror keeps the previous one (it never writes null) and the steered
        // turn is still on screen for now. Holding the ids would be right for
        // that frame and wrong from the next delta on, which rebuilds the live
        // message without the block and would leave the message nowhere for
        // the rest of the turn. The cost is the opposite way round: a message
        // whose persisted copy the transcript is already showing gets a strip
        // beside it until the turn ends. Turn-scoped, and visible.
        steeredMessageIds: EMPTY_STEERED_MESSAGE_IDS,
        pendingPermission: hydratedPendingPermission,
        pendingAskQuestion: action.patch.pendingAskQuestion,
        pendingPlanApproval: action.patch.pendingPlanApproval,
        pendingUserMessage: action.patch.pendingUserMessage,
        promptCapabilities: mergedPromptCapabilities,
        selectorsReady: mergedSelectorsReady,
        supportsFork: mergedSupportsFork,
        // Staleness is a current-state field (like status): apply the snapshot's
        // value on the fresh path. `configStaleDismissed` is client-local and
        // preserved via `...current`.
        configStale: action.patch.configStale,
        configStaleKind: action.patch.configStaleKind,
        // Current-state field like `status`: a client attaching mid-episode
        // recovers the pending-background count the one-shot events won't
        // replay for it, so its teardown gates hold.
        backgroundOutstanding: action.patch.backgroundOutstanding,
        sessionFailures: mergedSessionFailures,
        asyncTasks: mergedAsyncTasks,
        // Current state, like `status`: the session's error as the backend
        // holds it. Never a notification — that fired when it happened.
        error: action.patch.lastError,
        errorLevel: action.patch.lastErrorLevel,
        lastAppliedSeq: action.patch.eventSeq,
      })
      return next
    }

    case "EVENT_APPLIED": {
      const current = state.get(action.contextKey)
      if (!current) return state
      // Idempotent: only advances if the new seq is strictly higher.
      if (action.seq <= current.lastAppliedSeq) return state
      const next = new Map(state)
      next.set(action.contextKey, {
        ...current,
        lastAppliedSeq: action.seq,
      })
      return next
    }

    case "CONNECTION_REMOVED": {
      const next = new Map(state)
      next.delete(action.contextKey)
      return next
    }

    case "REMOVE_ALL":
      return new Map()

    case "REKEY_CONNECTION": {
      const conn = state.get(action.fromKey)
      if (!conn) return state
      // Defensive: if toKey already has an entry, do not clobber it.
      if (state.has(action.toKey)) return state
      const next = new Map(state)
      next.delete(action.fromKey)
      next.set(action.toKey, { ...conn, contextKey: action.toKey })
      return next
    }

    case "STATUS_CHANGED": {
      const conn = state.get(action.contextKey)
      if (!conn) return state
      const next = new Map(state)
      const updated = { ...conn, status: action.status }
      if (action.status === "prompting") {
        updated.liveMessage = {
          id: randomUUID(),
          role: "assistant",
          content: [],
          startedAt: Date.now(),
        }
        updated.pendingQuestion = null
        updated.claudeApiRetry = null
        updated.error = null
        // Steering adoptions belong to the turn whose stream they split.
        updated.steeredMessageIds = EMPTY_STEERED_MESSAGE_IDS
        // Starting a prompt past an active AIR failure acknowledges it —
        // settle EVERYTHING (watermarks retained). A failure that is still
        // real re-arms via a higher revision on the same id.
        updated.sessionFailures = settleSessionFailures(
          conn.sessionFailures,
          "all"
        )
        // The out-of-turn window ended: its tool-call contexts (kept only for
        // background permission enrichment) are stale for the new turn.
        updated.outOfTurnToolCalls = null
      } else if (conn.status === "prompting") {
        // Prompt cycle ended: clear in-flight Claude API retry banner.
        updated.claudeApiRetry = null
        // AIR failures deliberately NOT settled here: leaving `prompting`
        // covers error/cancel exits too, where the incident did not recover —
        // settling on any exit painted a still-dead connection as a recovered
        // warning. The `turn_complete` handler settles warnings on a clean
        // `end_turn` instead (SETTLE_SESSION_FAILURES), after the response's
        // terminal error escalation (if any) has already landed.
        // A blocked ask_user_question can't outlive its turn. The normal path
        // clears it via `question_resolved`; this is the safety net for a turn
        // that ended without one (agent error / abandoned block).
        updated.pendingAskQuestion = null
        // Likewise a blocked exit_plan_mode approval — cleared via
        // `plan_approval_resolved` normally; this is the turn-end safety net.
        updated.pendingPlanApproval = null
      }
      next.set(action.contextKey, updated)
      return next
    }

    case "SET_BACKGROUND_OUTSTANDING": {
      const conn = state.get(action.contextKey)
      if (!conn) return state
      if (conn.backgroundOutstanding === action.outstanding) return state
      const next = new Map(state)
      next.set(action.contextKey, {
        ...conn,
        backgroundOutstanding: action.outstanding,
      })
      return next
    }

    case "CONTENT_DELTA":
    case "THINKING": {
      const conn = state.get(action.contextKey)
      if (!conn) return state
      const updated = applyStreamingAction(conn, action)
      if (!updated) return state
      const next = new Map(state)
      next.set(action.contextKey, updated)
      return next
    }

    case "STREAM_BATCH": {
      if (action.actions.length === 0) return state
      const grouped = new Map<string, StreamingAction[]>()
      for (const streamAction of action.actions) {
        const list = grouped.get(streamAction.contextKey)
        if (list) {
          list.push(streamAction)
        } else {
          grouped.set(streamAction.contextKey, [streamAction])
        }
      }

      let next: ConnectionsMap | null = null

      for (const [contextKey, streamActions] of grouped) {
        const source = next ?? state
        const conn = source.get(contextKey)
        if (!conn) continue

        let updatedConn = conn
        let hasChange = false
        for (const streamAction of streamActions) {
          const updated = applyStreamingAction(updatedConn, streamAction)
          if (!updated) continue
          updatedConn = updated
          hasChange = true
        }
        if (!hasChange) continue

        if (!next) {
          next = new Map(state)
        }
        next.set(contextKey, updatedConn)
      }

      return next ?? state
    }

    case "TOOL_CALL": {
      const conn = state.get(action.contextKey)
      if (!conn) return state
      // Out-of-turn wire tool activity stays OUT of `liveMessage` (the
      // transcript overlay renders that content — grafting it here recreated
      // the garbled-timeline bug), but its context is still recorded so a
      // background permission request can render command/diff details.
      if (conn.status !== "prompting") {
        const next = new Map(state)
        next.set(action.contextKey, {
          ...conn,
          outOfTurnToolCalls: recordOutOfTurnToolCall(conn.outOfTurnToolCalls, {
            tool_call_id: action.tool_call_id,
            title: action.title,
            kind: action.kind,
            status: action.status,
            content: action.content,
            raw_input: action.raw_input,
            raw_output_chunks:
              action.raw_output !== null ? [action.raw_output] : [],
            raw_output_total_bytes: action.raw_output?.length ?? 0,
            locations: action.locations,
            meta: action.meta,
            images: action.images ?? [],
          }),
        })
        return next
      }
      const prev = ensureLiveMessage(conn.liveMessage)
      const existingIndex = prev.content.findIndex(
        (b) =>
          b.type === "tool_call" && b.info.tool_call_id === action.tool_call_id
      )
      let newContent: LiveContentBlock[]
      if (existingIndex !== -1) {
        const block = prev.content[existingIndex]
        if (block.type === "tool_call") {
          newContent = [
            ...prev.content.slice(0, existingIndex),
            {
              type: "tool_call",
              info: {
                ...block.info,
                title: action.title ?? block.info.title,
                kind: action.kind ?? block.info.kind,
                status: action.status ?? block.info.status,
                content: action.content ?? block.info.content,
                raw_input: action.raw_input ?? block.info.raw_input,
                raw_output_chunks:
                  action.raw_output !== null
                    ? [action.raw_output]
                    : block.info.raw_output_chunks,
                raw_output_total_bytes:
                  action.raw_output !== null
                    ? action.raw_output.length
                    : block.info.raw_output_total_bytes,
                images:
                  action.images !== null ? action.images : block.info.images,
              },
            },
            ...prev.content.slice(existingIndex + 1),
          ]
        } else {
          newContent = prev.content
        }
      } else {
        newContent = [
          ...prev.content,
          {
            type: "tool_call",
            info: {
              tool_call_id: action.tool_call_id,
              title: action.title,
              kind: action.kind,
              status: action.status,
              content: action.content,
              raw_input: action.raw_input,
              raw_output_chunks:
                action.raw_output !== null ? [action.raw_output] : [],
              raw_output_total_bytes: action.raw_output?.length ?? 0,
              locations: action.locations ?? null,
              meta: action.meta ?? null,
              images: action.images ?? [],
            },
          },
        ]
      }
      const nextLiveMessage = { ...prev, content: newContent }
      const nextInfo = findLiveToolCallInfo(newContent, action.tool_call_id)
      const next = new Map(state)
      next.set(action.contextKey, {
        ...conn,
        liveMessage: nextLiveMessage,
        pendingPermission: mergePendingPermissionWithLiveInfo(
          conn.pendingPermission,
          nextInfo
        ),
        claudeApiRetry: null,
      })
      return next
    }

    case "TOOL_CALL_UPDATE": {
      const conn = state.get(action.contextKey)
      if (!conn) return state
      // Out-of-turn: stay out of `liveMessage` (see TOOL_CALL), but merge the
      // registry entry and backfill an open permission dialog waiting for
      // this tool's input — a background permission must still show its
      // command/diff details. In-turn ordering is safe: the panel flushes
      // pending tool-call updates at turn_complete BEFORE status flips back.
      if (conn.status !== "prompting") {
        const existing = conn.outOfTurnToolCalls?.get(action.tool_call_id)
        const merged: ToolCallInfo = existing
          ? {
              ...existing,
              title: action.title ?? existing.title,
              status: action.status ?? existing.status,
              content: action.content ?? existing.content,
              raw_input: action.raw_input ?? existing.raw_input,
              locations: action.locations ?? existing.locations,
              meta: action.meta ?? existing.meta,
              images: action.images !== null ? action.images : existing.images,
            }
          : {
              tool_call_id: action.tool_call_id,
              title: action.title ?? action.fallback_title,
              kind: action.fallback_kind,
              status: action.status ?? "pending",
              content: action.content,
              raw_input: action.raw_input,
              raw_output_chunks: [],
              raw_output_total_bytes: 0,
              locations: action.locations,
              meta: action.meta,
              images: action.images ?? [],
            }
        const next = new Map(state)
        next.set(action.contextKey, {
          ...conn,
          outOfTurnToolCalls: recordOutOfTurnToolCall(
            conn.outOfTurnToolCalls,
            merged
          ),
          pendingPermission: mergePendingPermissionWithLiveInfo(
            conn.pendingPermission,
            merged
          ),
        })
        return next
      }
      const prev = ensureLiveMessage(conn.liveMessage)
      const existingIndex = prev.content.findIndex(
        (b) =>
          b.type === "tool_call" && b.info.tool_call_id === action.tool_call_id
      )
      let newContent: LiveContentBlock[]

      if (existingIndex === -1) {
        const initialChunks =
          action.raw_output !== null ? [action.raw_output] : []
        const initialBytes = action.raw_output?.length ?? 0
        newContent = [
          ...prev.content,
          {
            type: "tool_call",
            info: {
              tool_call_id: action.tool_call_id,
              title: action.title ?? action.fallback_title,
              kind: action.fallback_kind,
              status:
                action.status ??
                (initialChunks.length > 0 ? "in_progress" : "pending"),
              content: action.content,
              raw_input: action.raw_input,
              raw_output_chunks: initialChunks,
              raw_output_total_bytes: initialBytes,
              locations: action.locations ?? null,
              meta: action.meta ?? null,
              images: action.images ?? [],
            },
          },
        ]
      } else {
        const block = prev.content[existingIndex]
        if (block.type !== "tool_call") return state

        let newChunks: string[]
        let newTotalBytes: number

        if (action.raw_output === null) {
          newChunks = block.info.raw_output_chunks
          newTotalBytes = block.info.raw_output_total_bytes
        } else if (action.raw_output_append) {
          newChunks = [...block.info.raw_output_chunks, action.raw_output]
          newTotalBytes =
            block.info.raw_output_total_bytes + action.raw_output.length

          // 超限时从头部批量移除 chunks（单次 slice 替代循环 shift）
          if (
            newTotalBytes > MAX_LIVE_TOOL_RAW_OUTPUT_CHARS &&
            newChunks.length > 1
          ) {
            let evictCount = 0
            let evictedBytes = 0
            while (
              evictCount < newChunks.length - 1 &&
              newTotalBytes - evictedBytes > MAX_LIVE_TOOL_RAW_OUTPUT_CHARS
            ) {
              evictedBytes += newChunks[evictCount].length
              evictCount++
            }
            if (evictCount > 0) {
              newChunks = newChunks.slice(evictCount)
              newTotalBytes -= evictedBytes
            }
          }
        } else {
          // 非 append 模式（替换）
          newChunks = [action.raw_output]
          newTotalBytes = action.raw_output.length
        }

        newContent = [
          ...prev.content.slice(0, existingIndex),
          {
            type: "tool_call" as const,
            info: {
              ...block.info,
              title: action.title ?? block.info.title,
              status: action.status ?? block.info.status,
              content: action.content ?? block.info.content,
              raw_input: action.raw_input ?? block.info.raw_input,
              raw_output_chunks: newChunks,
              locations: action.locations ?? block.info.locations,
              meta: action.meta ?? block.info.meta,
              raw_output_total_bytes: newTotalBytes,
              images:
                action.images !== null ? action.images : block.info.images,
            },
          },
          ...prev.content.slice(existingIndex + 1),
        ]
      }

      const nextLiveMessage = { ...prev, content: newContent }
      const nextInfo = findLiveToolCallInfo(newContent, action.tool_call_id)
      const next = new Map(state)
      next.set(action.contextKey, {
        ...conn,
        liveMessage: nextLiveMessage,
        pendingPermission: mergePendingPermissionWithLiveInfo(
          conn.pendingPermission,
          nextInfo
        ),
        claudeApiRetry: null,
      })
      return next
    }

    case "BATCH_TOOL_CALL_UPDATES": {
      let current = state
      for (const sub of action.actions) {
        current = connectionsReducer(current, {
          type: "TOOL_CALL_UPDATE",
          ...sub,
        })
      }
      return current
    }

    case "PERMISSION_REQUEST": {
      const conn = state.get(action.contextKey)
      if (!conn) return state
      let updatedLiveMessage = conn.liveMessage
      const permissionCallId = extractPermissionToolCallId(action.tool_call)
      // Live tool context first; for an OUT-OF-TURN permission (background
      // sub-agent work — liveMessage intentionally untouched) fall back to
      // the out-of-turn registry so the dialog still shows command/diff.
      const existingInfo =
        (updatedLiveMessage
          ? findLiveToolCallInfo(updatedLiveMessage.content, permissionCallId)
          : null) ??
        (permissionCallId
          ? (conn.outOfTurnToolCalls?.get(permissionCallId) ?? null)
          : null)
      const permissionToolCall = mergePermissionToolCallWithLiveInfo(
        action.tool_call,
        existingInfo
      )
      const permissionToolInput =
        serializePermissionToolCall(permissionToolCall)
      if (
        updatedLiveMessage &&
        permissionCallId &&
        typeof permissionToolInput === "string"
      ) {
        const existingIndex = updatedLiveMessage.content.findIndex(
          (block) =>
            block.type === "tool_call" &&
            block.info.tool_call_id === permissionCallId
        )
        if (existingIndex !== -1) {
          const block = updatedLiveMessage.content[existingIndex]
          if (block.type === "tool_call") {
            const nextContent: LiveContentBlock[] = [
              ...updatedLiveMessage.content.slice(0, existingIndex),
              {
                type: "tool_call",
                info: {
                  ...block.info,
                  raw_input:
                    block.info.raw_input && block.info.raw_input.length > 0
                      ? block.info.raw_input
                      : permissionToolInput,
                },
              },
              ...updatedLiveMessage.content.slice(existingIndex + 1),
            ]
            updatedLiveMessage = {
              ...updatedLiveMessage,
              content: nextContent,
            }
          }
        } else {
          updatedLiveMessage = {
            ...updatedLiveMessage,
            content: [
              ...updatedLiveMessage.content,
              {
                type: "tool_call",
                info: {
                  tool_call_id: permissionCallId,
                  title:
                    extractPermissionToolTitle(action.tool_call) ??
                    action.fallback_title,
                  kind:
                    extractPermissionToolKind(action.tool_call) ??
                    action.fallback_kind,
                  status: "pending",
                  content: null,
                  raw_input: permissionToolInput,
                  raw_output_chunks: [],
                  raw_output_total_bytes: 0,
                  locations: null,
                  meta: null,
                  images: [],
                },
              },
            ],
          }
        }
      }
      const next = new Map(state)
      next.set(action.contextKey, {
        ...conn,
        liveMessage: updatedLiveMessage,
        pendingPermission: {
          request_id: action.request_id,
          tool_call: permissionToolCall,
          options: action.options,
          queued: action.queued,
        },
      })
      return next
    }

    case "PERMISSION_QUEUE_DEPTH": {
      // Depth-only: a request queued up behind the visible card, which emits no
      // PERMISSION_REQUEST of its own. No card up → nothing to annotate (a late
      // depth event after a drain must not resurrect one).
      const conn = state.get(action.contextKey)
      if (!conn?.pendingPermission) return state
      if (conn.pendingPermission.queued === action.depth) return state
      const next = new Map(state)
      next.set(action.contextKey, {
        ...conn,
        pendingPermission: {
          ...conn.pendingPermission,
          queued: action.depth,
        },
      })
      return next
    }

    case "PERMISSION_CLEARED": {
      const conn = state.get(action.contextKey)
      if (!conn) return state
      if (
        action.requestId !== undefined &&
        conn.pendingPermission?.request_id !== action.requestId
      ) {
        return state
      }
      const next = new Map(state)
      next.set(action.contextKey, {
        ...conn,
        pendingPermission: null,
      })
      return next
    }

    case "SET_PENDING_QUESTION": {
      const conn = state.get(action.contextKey)
      if (!conn) return state
      const next = new Map(state)
      next.set(action.contextKey, {
        ...conn,
        pendingQuestion: action.pendingQuestion,
      })
      return next
    }

    case "CLEAR_PENDING_QUESTION": {
      const conn = state.get(action.contextKey)
      if (!conn) return state
      const next = new Map(state)
      next.set(action.contextKey, {
        ...conn,
        pendingQuestion: null,
      })
      return next
    }

    case "SET_ASK_QUESTION": {
      const conn = state.get(action.contextKey)
      if (!conn) return state
      const next = new Map(state)
      next.set(action.contextKey, {
        ...conn,
        pendingAskQuestion: action.pendingAskQuestion,
      })
      return next
    }

    case "CLEAR_ASK_QUESTION": {
      const conn = state.get(action.contextKey)
      if (!conn) return state
      if (
        action.questionId !== undefined &&
        conn.pendingAskQuestion?.question_id !== action.questionId
      ) {
        return state
      }
      const next = new Map(state)
      next.set(action.contextKey, {
        ...conn,
        pendingAskQuestion: null,
      })
      return next
    }

    case "SET_PLAN_APPROVAL": {
      const conn = state.get(action.contextKey)
      if (!conn) return state
      const next = new Map(state)
      next.set(action.contextKey, {
        ...conn,
        pendingPlanApproval: action.pendingPlanApproval,
      })
      return next
    }

    case "CLEAR_PLAN_APPROVAL": {
      const conn = state.get(action.contextKey)
      if (!conn) return state
      if (
        action.approvalId !== undefined &&
        conn.pendingPlanApproval?.approval_id !== action.approvalId
      ) {
        return state
      }
      const next = new Map(state)
      next.set(action.contextKey, {
        ...conn,
        pendingPlanApproval: null,
      })
      return next
    }

    case "SESSION_STARTED": {
      const conn = state.get(action.contextKey)
      if (!conn) return state
      const next = new Map(state)
      // Mirrors the backend's `SessionStarted` arm: a CHANGED session id (a
      // fork) strands the AIR task rows, because their terminal frames are
      // published on the id this connection has left and never route here
      // again. The backend drops its table, and an empty snapshot table can't
      // clear ours for us (`mergeAsyncTasks` treats empty as "nothing to say"),
      // so without this the strip shows tasks that can never finish AND the
      // idle sweep below defers on them forever. Guarded on the id actually
      // changing, so a replayed announcement stays idempotent.
      const forked = conn.sessionId !== action.sessionId
      next.set(action.contextKey, {
        ...conn,
        sessionId: action.sessionId,
        asyncTasks: forked ? [] : conn.asyncTasks,
      })
      return next
    }

    case "SESSION_MODES": {
      const conn = state.get(action.contextKey)
      if (!conn) return state
      if (sameModes(conn.modes, action.modes)) return state
      const next = new Map(state)
      next.set(action.contextKey, {
        ...conn,
        modes: action.modes,
      })
      return next
    }

    case "SESSION_CONFIG_OPTIONS": {
      const conn = state.get(action.contextKey)
      if (!conn) return state
      if (sameConfigOptions(conn.configOptions, action.configOptions)) {
        return state
      }
      const next = new Map(state)
      next.set(action.contextKey, {
        ...conn,
        configOptions: action.configOptions,
      })
      return next
    }

    case "CONFIG_STALE_CHANGED": {
      const conn = state.get(action.contextKey)
      if (!conn) return state
      const kind = action.stale ? action.kind : null
      // A fresh stale=true is a NEW drift → un-dismiss so the banner reappears
      // even if the user had dismissed a previous one. stale=false clears it.
      const dismissed = action.stale ? false : conn.configStaleDismissed
      if (
        conn.configStale === action.stale &&
        conn.configStaleKind === kind &&
        conn.configStaleDismissed === dismissed
      ) {
        return state
      }
      const next = new Map(state)
      next.set(action.contextKey, {
        ...conn,
        configStale: action.stale,
        configStaleKind: kind,
        configStaleDismissed: dismissed,
      })
      return next
    }

    case "DISMISS_CONFIG_STALE": {
      const conn = state.get(action.contextKey)
      if (!conn || conn.configStaleDismissed) return state
      const next = new Map(state)
      next.set(action.contextKey, {
        ...conn,
        configStaleDismissed: true,
      })
      return next
    }

    case "SELECTORS_READY": {
      const conn = state.get(action.contextKey)
      if (!conn || conn.selectorsReady) return state
      const next = new Map(state)
      next.set(action.contextKey, {
        ...conn,
        selectorsReady: true,
      })
      return next
    }

    case "PROMPT_CAPABILITIES": {
      const conn = state.get(action.contextKey)
      if (!conn) return state
      if (
        samePromptCapabilities(
          conn.promptCapabilities,
          action.promptCapabilities
        )
      ) {
        return state
      }
      const next = new Map(state)
      next.set(action.contextKey, {
        ...conn,
        promptCapabilities: action.promptCapabilities,
      })
      return next
    }

    case "FORK_SUPPORTED": {
      const conn = state.get(action.contextKey)
      if (!conn) return state
      if (conn.supportsFork === action.supported) return state
      const next = new Map(state)
      next.set(action.contextKey, {
        ...conn,
        supportsFork: action.supported,
      })
      return next
    }

    case "MODE_CHANGED": {
      const conn = state.get(action.contextKey)
      if (!conn?.modes) return state
      if (conn.modes.current_mode_id === action.modeId) return state
      const next = new Map(state)
      next.set(action.contextKey, {
        ...conn,
        modes: {
          ...conn.modes,
          current_mode_id: action.modeId,
        },
      })
      return next
    }

    case "CONFIG_OPTION_CHANGED": {
      const conn = state.get(action.contextKey)
      if (!conn) return state
      const options =
        conn.configOptions ??
        selectorsCache.get(conn.agentType)?.configOptions ??
        null
      if (!options) return state
      const idx = options.findIndex((o) => o.id === action.configId)
      if (idx === -1) return state
      const opt = options[idx]
      const kind = nextConfigOptionKind(opt.kind, action.valueId)
      if (!kind) return state
      const updated = [...options]
      updated[idx] = { ...opt, kind }
      const next = new Map(state)
      next.set(action.contextKey, { ...conn, configOptions: updated })
      return next
    }

    case "PLAN_UPDATE": {
      const conn = state.get(action.contextKey)
      if (!conn) return state
      // Same out-of-turn guard as TOOL_CALL / streaming deltas.
      if (conn.status !== "prompting") return state
      const prev = ensureLiveMessage(conn.liveMessage)
      const nonPlanContent = prev.content.filter(
        (block) => block.type !== "plan"
      )
      const currentPlan = [...prev.content]
        .reverse()
        .find((block): block is { type: "plan"; entries: PlanEntryInfo[] } => {
          return block.type === "plan"
        })

      if (
        action.entries.length === 0 &&
        currentPlan === undefined &&
        nonPlanContent.length === prev.content.length
      ) {
        return state
      }

      const isAlreadyCanonicalPlan =
        currentPlan !== undefined &&
        samePlanEntries(currentPlan.entries, action.entries) &&
        prev.content.length === nonPlanContent.length + 1 &&
        prev.content[prev.content.length - 1]?.type === "plan"

      if (isAlreadyCanonicalPlan) return state

      const newContent =
        action.entries.length === 0
          ? nonPlanContent
          : [
              ...nonPlanContent,
              { type: "plan" as const, entries: action.entries },
            ]

      const next = new Map(state)
      next.set(action.contextKey, {
        ...conn,
        liveMessage: { ...prev, content: newContent },
        claudeApiRetry: null,
      })
      return next
    }

    case "STEERING_MESSAGE": {
      const conn = state.get(action.contextKey)
      if (!conn) return state
      // Same out-of-turn guard as PLAN_UPDATE / TOOL_CALL / streaming deltas:
      // there is no running turn to split, and appending would graft the
      // message onto the PREVIOUS turn's completed liveMessage. The note keeps
      // its strip in that case (it is absent from `steeredMessageIds`), and
      // the agent recorded it either way, so a reload still shows it.
      if (conn.status !== "prompting") return state
      // Idempotent by note id: the submit broadcast reaches every attached
      // client, and one client is also the sender.
      if (conn.steeredMessageIds.includes(action.id)) return state
      const prev = ensureLiveMessage(conn.liveMessage)
      const next = new Map(state)
      next.set(action.contextKey, {
        ...conn,
        liveMessage: {
          ...prev,
          content: [
            ...prev.content,
            {
              type: "steering" as const,
              id: action.id,
              text: action.text,
              createdAt: action.createdAt,
              blocks: action.blocks ?? null,
            },
          ],
        },
        steeredMessageIds: [...conn.steeredMessageIds, action.id],
      })
      return next
    }

    case "CLAUDE_API_RETRY": {
      const conn = state.get(action.contextKey)
      if (!conn) return state
      const next = new Map(state)
      next.set(action.contextKey, {
        ...conn,
        claudeApiRetry: action.retry,
      })
      return next
    }

    case "SESSION_FAILURE": {
      const conn = state.get(action.contextKey)
      if (!conn) return state
      const merged = upsertSessionFailure(conn.sessionFailures, action.record)
      // Stale/replayed upserts are rejected by reference — no re-render.
      if (merged === conn.sessionFailures) return state
      const next = new Map(state)
      next.set(action.contextKey, { ...conn, sessionFailures: merged })
      return next
    }

    case "ASYNC_TASK": {
      const conn = state.get(action.contextKey)
      if (!conn) return state
      const merged = upsertAsyncTask(conn.asyncTasks, action.delta)
      // A delta for a task we never saw announced changes nothing — same
      // reference, no re-render.
      if (merged === conn.asyncTasks) return state
      const next = new Map(state)
      next.set(action.contextKey, { ...conn, asyncTasks: merged })
      return next
    }

    case "SETTLE_SESSION_FAILURES": {
      const conn = state.get(action.contextKey)
      if (!conn) return state
      const settled = settleSessionFailures(conn.sessionFailures, action.scope)
      // Nothing needed settling — same reference, no re-render.
      if (settled === conn.sessionFailures) return state
      const next = new Map(state)
      next.set(action.contextKey, { ...conn, sessionFailures: settled })
      return next
    }

    case "DISMISS_SESSION_FAILURES": {
      const conn = state.get(action.contextKey)
      if (!conn) return state
      const dismissed = dismissSessionFailures(conn.sessionFailures, action.ids)
      // Unknown ids / already resolved — same reference, no re-render.
      if (dismissed === conn.sessionFailures) return state
      const next = new Map(state)
      next.set(action.contextKey, { ...conn, sessionFailures: dismissed })
      return next
    }

    case "ERROR": {
      const conn = state.get(action.contextKey)
      if (!conn) return state
      const next = new Map(state)
      next.set(action.contextKey, {
        ...conn,
        claudeApiRetry: null,
        error: action.message,
        errorLevel: action.level,
      })
      return next
    }

    case "ACP_LOAD_ERROR": {
      const conn = state.get(action.contextKey)
      if (!conn) return state
      const next = new Map(state)
      next.set(action.contextKey, {
        ...conn,
        loadError: action.message,
        loadErrorCommand: action.command ?? null,
      })
      return next
    }

    case "CLEAR_ACP_LOAD_ERROR": {
      const conn = state.get(action.contextKey)
      if (!conn || (conn.loadError === null && conn.loadErrorCommand === null))
        return state
      const next = new Map(state)
      next.set(action.contextKey, {
        ...conn,
        loadError: null,
        loadErrorCommand: null,
      })
      return next
    }

    case "AVAILABLE_COMMANDS": {
      const conn = state.get(action.contextKey)
      if (!conn) return state
      const commands = dedupeCommandsByName(action.commands)
      if (sameCommands(conn.availableCommands, commands)) return state
      const next = new Map(state)
      next.set(action.contextKey, {
        ...conn,
        availableCommands: commands,
      })
      return next
    }

    case "USAGE_UPDATE": {
      const conn = state.get(action.contextKey)
      if (!conn) return state
      // Ignore usage updates that reset used to 0 when we already have
      // valid data — these come from synthetic responses for local commands
      // like /context and would overwrite the real context window usage.
      if (action.usage.used === 0 && conn.usage && conn.usage.used > 0) {
        return state
      }
      if (
        conn.usage?.used === action.usage.used &&
        conn.usage?.size === action.usage.size
      ) {
        return state
      }
      const next = new Map(state)
      next.set(action.contextKey, {
        ...conn,
        usage: action.usage,
      })
      return next
    }

    default:
      return state
  }
}

// ── Ref-based store (replaces useReducer + Context) ──

/**
 * A `connect()` that has started but has not yet produced a store entry.
 *
 * The whole establishment leg — agent spawn, ACP `initialize`, then
 * `session/resume|load|new` — happens inside ONE `await acpConnect(...)`, and
 * `CONNECTION_CREATED` (the action that first writes `status: "connecting"`)
 * only runs after it resolves. For a historical conversation that await is the
 * SLOW part (seconds to a minute; see the agent-side resume cost), so without
 * this the UI spent the entire wait reading `status === null` — indistinguishable
 * from "nothing is happening": no composer placeholder, no loading cue, no
 * status-bar task, a "disconnected" heart.
 *
 * Kept OUT of `ConnectionsMap` deliberately: there is no connection yet (no id,
 * no session, nothing to route events to), and every reducer/sweep that walks
 * that map would have to learn about a half-entry. It is a separate, reactive
 * side table read only by `useConnection` (which reports it as `connecting`)
 * and the composer's status chip.
 */
export interface ConnectPendingInfo {
  agentType: AgentType
  workingDir: string | null
}

/**
 * Why the last `connect()` for a key failed: the error state of that
 * surface's connection-status heart, and what keeps its notification's Retry
 * live (see `notifyConnectError`).
 *
 * Same side-table shape as `ConnectPendingInfo`, for the same reason: a failed
 * connect never produced a `ConnectionsMap` entry, so there is no
 * `ConnectionState` to hang the failure on. Set by `connect()` alongside the
 * notification; cleared, and its toast dismissed, when the next attempt
 * starts, when the key is disconnected, or on `disconnectAll`.
 */
export interface ConnectErrorInfo {
  agentType: AgentType
  /** One line naming what failed ("Codex connection failed", "Claude Code's
   *  ACP adapter is not installed"). */
  title: string
  /** Why, when there is more to say than the title. */
  detail: string | null
  /** The fix lives in Settings → Agents (install, enable, configure). */
  opensAgentSettings: boolean
}

interface InternalStore {
  connections: ConnectionsMap
  /** contextKey → the in-flight `connect()` for it (see ConnectPendingInfo). */
  connectPending: Map<string, ConnectPendingInfo>
  /** contextKey → why its last `connect()` failed (see ConnectErrorInfo). */
  connectErrors: Map<string, ConnectErrorInfo>
  activeKey: string | null
  keyListeners: Map<string, Set<() => void>>
  activeKeyListeners: Set<() => void>
}

// ── Store API for consumers ──

export interface ConnectionStoreApi {
  getConnection(key: string): ConnectionState | undefined
  /** The in-flight `connect()` for this key, or undefined when none is. The
   *  returned object is reference-stable for the lifetime of that connect, so
   *  it is safe as a `useSyncExternalStore` snapshot. */
  getConnectPending(key: string): ConnectPendingInfo | undefined
  /** Why the last `connect()` for this key failed, or undefined. Reference-
   *  stable until the next change, like `getConnectPending`. */
  getConnectError(key: string): ConnectErrorInfo | undefined
  getActiveKey(): string | null
  subscribeKey(key: string, cb: () => void): () => void
  subscribeActiveKey(cb: () => void): () => void
}

const ConnectionStoreContext = createContext<ConnectionStoreApi | null>(null)

export function useConnectionStore(): ConnectionStoreApi {
  const ctx = useContext(ConnectionStoreContext)
  if (!ctx) {
    throw new Error(
      "useConnectionStore must be used within AcpConnectionsProvider"
    )
  }
  return ctx
}

// ── Actions context (unchanged interface) ──

/**
 * Sink that mirrors a connection's `liveMessage` into the conversation-runtime
 * store OUTSIDE React. Registered per `contextKey` by the conversation panel and
 * invoked synchronously from `dispatch` whenever that connection's `liveMessage`
 * reference changes (streaming deltas, tool updates, the prompt-start reset).
 * Moving this write out of a React effect lets the keep-alive panel stop
 * re-rendering on every streaming token — only the runtime-store subscriber (the
 * message list) re-renders. `isLive` is `status === "prompting"`, which the
 * runtime reducer uses to bypass its stale-reconnect-replay guard.
 */
export type LiveMessageSink = (
  liveMessage: LiveMessage,
  isLive: boolean
) => void

export interface AcpActionsValue {
  connect(
    contextKey: string,
    agentType: AgentType,
    workingDir?: string,
    sessionId?: string,
    conversationId?: number
  ): Promise<void>
  /**
   * Release the connection for `contextKey`. The LOCAL entry always goes away
   * — a stranded one would make the next `connect()` take its "already
   * connected" fast path onto a session that may be dead.
   *
   * Resolves `true` when the backend teardown is confirmed (including a
   * connection that was already gone), `false` when it failed for any other
   * reason and the agent process may still be alive. Callers that report a
   * restart to the user gate on it; fire-and-forget teardowns ignore it.
   */
  disconnect(contextKey: string): Promise<boolean>
  /**
   * Release a connection whose SURFACE went away on its own (a preview tab
   * replaced by the next single-click in the sidebar) — never a user-intent
   * teardown. Disconnects viewers and idle owners; a busy owner (prompting
   * turn, or unresolved background tasks) is left running for the idle sweep,
   * because `acpDisconnect` kills the agent CLI mid-turn and the agent records
   * that as an interrupted request. Use `disconnect` when the user asked to
   * stop.
   */
  disconnectIfIdle(contextKey: string): Promise<void>
  disconnectAll(): Promise<void>
  sendPrompt(
    contextKey: string,
    blocks: PromptInputBlock[],
    opts?: {
      folderId?: number | null
      conversationId?: number | null
      clientMessageId?: string | null
    }
  ): Promise<void>
  setMode(contextKey: string, modeId: string): Promise<void>
  setConfigOption(
    contextKey: string,
    configId: string,
    valueId: string
  ): Promise<void>
  cancel(contextKey: string): Promise<void>
  respondPermission(
    contextKey: string,
    requestId: string,
    optionId: string
  ): Promise<void>
  answerQuestion(
    contextKey: string,
    questionId: string,
    answer: QuestionAnswer
  ): Promise<void>
  answerPlanApproval(
    contextKey: string,
    approvalId: string,
    answer: PlanApprovalAnswer
  ): Promise<void>
  /** Pause or clear the session's active Codex goal (codex-acp #293). */
  goalControl(contextKey: string, action: "pause" | "clear"): Promise<void>
  setActiveKey(key: string | null): void
  touchActivity(contextKey: string): void
  registerOpenTabKeys(keys: Set<string>): void
  /**
   * Same promise as `registerOpenTabKeys`, for surfaces that aren't tabs: while
   * a key is registered, the idle sweep won't reclaim its connection and the
   * backend keepalive keeps touching it. `source` namespaces the set so
   * registrars don't overwrite each other; an empty set unregisters.
   */
  registerLiveSurfaceKeys(source: string, keys: Set<string>): void
  /**
   * Register a sink that mirrors this contextKey's `liveMessage` into the
   * conversation-runtime store from `dispatch` (outside React), replacing the
   * panel's per-token mirror effect. Returns an unregister fn (idempotent —
   * only removes the entry if it still points at this sink). See
   * `LiveMessageSink`.
   */
  registerLiveMessageSink(contextKey: string, sink: LiveMessageSink): () => void
  /**
   * Clear `loadError` (and its `loadErrorCommand`) set by a `session/load`
   * failure so the next auto-connect attempt isn't gated by stale failure
   * state. Wired to the Reload button in the conversation detail panel.
   */
  clearAcpLoadError(contextKey: string): void
  /**
   * Register a delegation-spawned child connection so its acp://event
   * stream lands in the reducer (live message, tool calls, permission
   * requests). The child connection is already alive on the backend —
   * this is a frontend-only attach. Idempotent on connectionId.
   *
   * Routing:
   *   * Tauri: registers the connectionId in the global event router
   *     and drains any envelopes that arrived before registration.
   *   * Web/remote: opens a per-connection WS attach so the snapshot +
   *     replay + live events arrive on a dedicated stream.
   */
  attachDelegationChild(args: {
    connectionId: string
    parentConnectionId: string
    parentToolUseId: string
    agentType: AgentType
    /**
     * Backfill the in-flight turn from a session snapshot before routing
     * live events. Required when attaching MID-TURN, which the desktop
     * firehose cannot serve on its own: `acp://event` only carries FUTURE
     * events, so without a snapshot the viewer misses everything the turn
     * already produced and its status stays `connected` instead of
     * `prompting` (no streaming affordance, empty live message). Real
     * delegation children attach at `delegation_started` — before the
     * child's first event — and leave this off. No effect on web/remote:
     * the attach protocol always opens with a snapshot.
     */
    hydrate?: boolean
  }): void
  /**
   * Tear down a previously-attached delegation child. Releases the
   * synthetic ConnectionState and any per-connection WS attach. Does
   * NOT call acpDisconnect — the broker owns the child's backend
   * lifecycle. No-op when the child isn't attached.
   */
  detachDelegationChild(connectionId: string): void
  /**
   * Restart the session at `contextKey` so it picks up the latest agent/model
   * settings: disconnect the running process, then reconnect with the same
   * `sessionId` (the agent resumes the conversation — history is preserved).
   * The freshly spawned process reads current config, so its recomputed
   * fingerprint matches and `configStale` clears. Wired to the "restart to
   * apply" banner button. Returns `true` if it actually restarted, `false` if
   * it was a no-op (no connection, or a viewer / delegation child that doesn't
   * own the backend process) — callers gate their "applied" confirmation on it.
   */
  reapplyConfig(contextKey: string): Promise<boolean>
  /**
   * User-driven reconnect for the composer's connection-status popover, usable
   * in ANY state — unlike `reapplyConfig`, which only restarts a live owner.
   *
   *   * live owner  → disconnect + connect (a restart; a prompting turn dies
   *     with the agent CLI, which is why the popover warns before offering it)
   *   * viewer      → detach + re-run discovery, so it re-attaches (or spawns
   *     its own agent if the previous owner is gone). Never `acpDisconnect`s.
   *   * no entry    → connect with the params `connect()` last recorded for
   *     this key, which is what makes the button work from `disconnected` /
   *     `error`, where the store holds nothing at all.
   *
   * Returns `false` on a no-op: a delegation child (broker-owned) or a key we
   * have no params for (never connected in this session).
   */
  reconnect(contextKey: string): Promise<boolean>
  /**
   * The params `reconnect(contextKey)` would use, or `null` when it would be a
   * no-op. Lets the status popover name the agent and enable its button while
   * NO connection exists. Non-reactive by design — the values only change when
   * `connect()` runs, which also notifies the store.
   */
  getReconnectInfo(contextKey: string): {
    agentType: AgentType
    workingDir: string | null
    sessionId: string | null
  } | null
  /**
   * Dismiss the "restart to apply" banner for the current drift WITHOUT
   * restarting (client-local; the underlying `configStale` is untouched). A
   * subsequent settings change re-shows it. Wired to the banner's X button.
   */
  dismissConfigStale(contextKey: string): void
  /**
   * Close AIR retry-incident strips (client-local, like `dismissConfigStale`)
   * — one call per strip, carrying every record that strip stood for. The
   * records stay in the table as their revision watermarks, so this silences
   * only what was on screen: a failure that is still real re-arms via a higher
   * revision. Unlike the recovery actions this is NOT gated on owning the
   * session — a viewer dismissing a strip only edits its own projection.
   */
  dismissSessionFailures(contextKey: string, ids: string[]): void
  /**
   * Answer the recovery buttons that need the conversation view itself — a
   * failure notification's "retry" (re-send the last prompt) and "new
   * session". The view that owns `contextKey`'s session registers while it is
   * mounted; a notification only offers those buttons while one is, and a
   * click after it unmounted does nothing. Returns the unregister function.
   */
  registerSessionFailureActions(
    contextKey: string,
    handler: (action: SessionFailureAction) => void
  ): () => void
}

const AcpActionsContext = createContext<AcpActionsValue | null>(null)

export function useAcpActions(): AcpActionsValue {
  const ctx = useContext(AcpActionsContext)
  if (!ctx) {
    throw new Error("useAcpActions must be used within AcpConnectionsProvider")
  }
  return ctx
}

// ── Event subscriber context ──
//
// JS-level fanout of `acp://event` envelopes. The provider owns the single
// physical Tauri/WebSocket subscription; consumers register callbacks here
// instead of opening a second listener. See `useAcpEvent` below.

type EventSubscriberHandler = (envelope: EventEnvelope) => void
type EventSubscriberRef = { current: EventSubscriberHandler }

interface AcpEventSubscriberApi {
  subscribers: Set<EventSubscriberRef>
}

const AcpEventSubscriberContext = createContext<AcpEventSubscriberApi | null>(
  null
)

/**
 * Subscribe to `acp://event` envelopes via the provider's primary listener.
 *
 * The handler is invoked AFTER the context's reducer has dispatched its own
 * actions for that envelope (state is consistent at fire time). It also
 * inherits the provider's `seq` dedup — duplicates the primary listener
 * would skip are skipped here too. Unmapped events (no `contextKey`) do
 * NOT fan out.
 *
 * Stability: the latest `handler` is stored in a ref each render, so callers
 * may pass an inline function. There is no need for caller-side refs to keep
 * the subscription stable across renders.
 *
 * Errors thrown by `handler` are caught and logged so a single buggy
 * subscriber cannot break the central listener.
 */
export function useAcpEvent(handler: EventSubscriberHandler): void {
  const ctx = useContext(AcpEventSubscriberContext)
  if (!ctx) {
    throw new Error("useAcpEvent must be used within AcpConnectionsProvider")
  }
  const handlerRef = useRef(handler)
  // Re-sync each render so the latest closure is used at fire time.
  useEffect(() => {
    handlerRef.current = handler
  })
  // Register / unregister exactly once. Set-of-refs (not Set-of-functions)
  // so unmount cleanup matches the original entry even though `handler`
  // identity may change between renders.
  useEffect(() => {
    const ref = handlerRef
    ctx.subscribers.add(ref)
    return () => {
      ctx.subscribers.delete(ref)
    }
  }, [ctx])
}

// ── Helper: extract affected key from action ──

function getAffectedKey(action: Action): string | null {
  if (action.type === "REMOVE_ALL") return null // special: all keys
  if (action.type === "STREAM_BATCH") return null
  if ("contextKey" in action) return action.contextKey
  return null
}

function normalizeErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

type AlertedError = Error & { alerted: true }

function createAlertedError(message: string): AlertedError {
  const error = new Error(message) as AlertedError
  error.alerted = true
  return error
}

function isAlertedError(error: unknown): error is AlertedError {
  if (!error || typeof error !== "object") return false
  return (error as { alerted?: unknown }).alerted === true
}

/**
 * One account of a failed turn (see `notifyTurnFailure`): an AIR terminal
 * record — the adapter's own wording and recovery buttons — or codeg's
 * `turn_failed_*` verdict, which may carry the agent's stderr tail.
 */
type TurnFailurePart =
  | {
      kind: "typed"
      recordId: string
      title: string
      description?: string
      actions: NotifyAction[]
    }
  | { kind: "verdict"; title: string; evidence?: string }

/** A connect failure's notification key: one per surface. */
function connectErrorNotificationKey(contextKey: string): string {
  return `acp-connect:${contextKey}`
}

/** What a connection's current turn has told about its failures. */
interface TurnFailureState {
  /** Every notification this turn raised — what the next prompt retires. */
  keys: Set<string>
  /** AIR terminal record id → its notification's key. */
  typedKeys: Map<string, string>
  /** The latest typed account — the one a later verdict belongs with. */
  lastTyped?: {
    key: string
    title: string
    description?: string
    actions: NotifyAction[]
  }
  /** codeg's verdict; `paired` once a typed account carries it. */
  verdict?: { key: string; evidence?: string; paired: boolean }
}

// ── Provider ──

export function AcpConnectionsProvider({ children }: { children: ReactNode }) {
  const t = useTranslations("Folder.chat.acpConnections")
  // Separate namespace: the agent-supplied vocabulary this provider has to
  // re-label lives under its own catalogue (see `lib/agent-label-vocabulary`).
  const vocabularyT = useTranslations("AgentVocabulary")
  const tChat = useTranslations("Folder.chat")
  const tFailure = useTranslations("Folder.chat.sessionFailure")
  const { activeFolder: folder } = useActiveFolder()
  const folderNameRef = useRef(folder?.name)
  useEffect(() => {
    folderNameRef.current = folder?.name
  }, [folder?.name])
  // Depth > 0 while REPLAYED envelopes are being applied (see `onReplay`):
  // `handleMappedEvent` then treats them like echoes and skips the one-shot
  // effects — toasts, sounds, OS notifications — while the store catches up.
  const envelopeEffectsMutedRef = useRef(0)
  // contextKey → the conversation view's answer to a failure notification's
  // "retry" / "new session" (see `registerSessionFailureActions`).
  const sessionFailureActionsRef = useRef(
    new Map<string, (action: SessionFailureAction) => void>()
  )
  // connectionId → what its current turn has told about its failures (see
  // `notifyTurnFailure`); retired when the next prompt starts.
  const turnFailuresRef = useRef(new Map<string, TurnFailureState>())
  const turnFailureSerialRef = useRef(0)

  // Notification sounds: browsers only open audio output from inside a user
  // gesture, so start watching for one now. The user's ordinary first click in
  // the workspace unlocks it, well before an agent event needs it — otherwise
  // the session's first cue is lost (the Settings preview cannot stand in for
  // it: that is a different window with its own audio context). No-op while
  // sounds are disabled.
  useEffect(() => primeNotificationSoundOutput(), [])

  // Ref-based store — mutations don't trigger React state updates
  const storeRef = useRef<InternalStore>({
    connections: new Map(),
    connectPending: new Map(),
    connectErrors: new Map(),
    activeKey: null,
    keyListeners: new Map(),
    activeKeyListeners: new Set(),
  })

  // connectionId → the contextKeys whose events are routed from the legacy
  // global `acp://event` listener. Attach-protocol connections (web mode)
  // bypass this entirely — their events are routed by the per-subscription
  // handlers registered in `attachSubscriptionsRef`.
  //
  // One-to-MANY, deliberately. Several surfaces can watch the SAME backend
  // connection at once: a conversation tab plus the work-task transcript
  // viewer (`attachDelegationChild` routes the task's own connection under
  // `contextKey === connectionId`), two split tiles on one conversation, a
  // viewer attach racing an owner re-spawn. While this was a 1:1 Map the last
  // attach silently STOLE routing from the earlier surface and the first
  // detach DELETED routing the surviving surface still depended on. Either way
  // the abandoned surface keeps a live-looking `prompting` ConnectionState that
  // no event can ever settle — and every recovery path (connect()'s fast
  // return, the idle sweep, the keepalive touch) only acts on
  // `disconnected`/`error`, so the tab is stuck on "responding" with a dead
  // Stop button until the app restarts. Always mutate through
  // `bindConnectionRoute` / `releaseConnectionRoute`.
  const reverseMapRef = useRef(new Map<string, Set<string>>())

  /** Route `connectionId`'s firehose events to `contextKey` too. Idempotent. */
  const bindConnectionRoute = useCallback(
    (connectionId: string, contextKey: string) => {
      const keys = reverseMapRef.current.get(connectionId)
      if (keys) keys.add(contextKey)
      else reverseMapRef.current.set(connectionId, new Set([contextKey]))
    },
    []
  )

  /**
   * Drop ONLY this surface's route. A no-op for a connection this contextKey
   * never routed, and — the load-bearing part — it leaves every OTHER surface
   * watching the same connection routed.
   */
  const releaseConnectionRoute = useCallback(
    (connectionId: string, contextKey: string) => {
      const keys = reverseMapRef.current.get(connectionId)
      if (!keys) return
      keys.delete(contextKey)
      if (keys.size === 0) reverseMapRef.current.delete(connectionId)
    },
    []
  )

  // contextKey → active EventStream subscription handle. Populated only for
  // connections established via the Subscribe-with-Snapshot attach
  // protocol (web + remote-desktop). Used to (a) detach on disconnect /
  // tab close, and (b) re-attach with the current cursor when a connection
  // is rekeyed (orphan rescue) so handlers reference the new contextKey.
  const attachSubscriptionsRef = useRef(
    new Map<string, EventStreamSubscription>()
  )

  // contextKey → how many times an entry has been REKEYed OUT of it (orphan
  // rescue moving a connection to its canonical key). `connect()` samples this
  // across its awaits: when its entry is gone afterwards it has to know WHY,
  // and the store's current shape can't say. "Rekeyed away" means another key
  // owns the connection now and this call must stand down — continuing would
  // reach its own orphan rescue and drag the connection back. "Simply gone"
  // (the attach handler's `connection_gone`, a terminal event) means nobody
  // holds it and this call must go on and build one. Inferring either from
  // who currently references the id gets both wrong: two surfaces can legally
  // share an id via backend dedup, and a rekey destination can itself be torn
  // down before the sampler resumes.
  const rekeyGenerationRef = useRef(new Map<string, number>())

  // Open tab keys — updated by child TabProvider via registerOpenTabKeys
  const openTabKeysRef = useRef(new Set<string>())
  // Live surfaces that are NOT tabs, by source. Tabs were the only place a
  // conversation could be live when `openTabKeysRef` was written; the canvas
  // put expanded conversation cards on a board instead, and a surface the idle
  // sweep can't see gets its agent disconnected out from under the user after
  // CONNECTION_IDLE_TIMEOUT_MS while the card is still on screen. Keyed by
  // source so two registrars never clobber each other's set.
  const extraLiveKeysRef = useRef(new Map<string, Set<string>>())

  /** Every contextKey a visible surface is currently holding open. */
  const heldOpenKeys = useCallback((): Set<string> => {
    if (extraLiveKeysRef.current.size === 0) return openTabKeysRef.current
    const all = new Set(openTabKeysRef.current)
    for (const keys of extraLiveKeysRef.current.values()) {
      for (const key of keys) all.add(key)
    }
    return all
  }, [])

  // Guard against concurrent connect() calls
  const connectingKeysRef = useRef(new Set<string>())
  const pendingConnectRequestsRef = useRef(new Map<string, ConnectRequest>())
  // Last params `connect()` was called with, per contextKey — kept AFTER the
  // connection is gone (teardown removes the store entry entirely, so a
  // `disconnected` / `error` composer has nothing left to reconnect from).
  // Recorded even for attempts that fail, which is exactly the `error` case the
  // status popover's Reconnect button has to serve.
  //
  // Backend-RESOLVED identity is folded back in as it arrives (see
  // `rememberResolvedIdentity`): a new conversation connects with no sessionId
  // at all, so the request as issued would reconnect into a FRESH session and
  // silently abandon the conversation's history.
  const lastConnectParamsRef = useRef(new Map<string, ConnectRequest>())
  // Keys whose disconnect was requested while connect was still in flight
  const abandonedKeysRef = useRef(new Set<string>())
  // Resolvers waiting for an in-flight connect() on a key to settle. Only a
  // user-driven `reconnect` uses this: connect() parks a same-parameter request
  // in `pendingConnectRequestsRef` and its `finally` then DROPS it as a
  // duplicate, so a reconnect landing mid-connect would vanish silently.
  const connectSettledWaitersRef = useRef(new Map<string, Array<() => void>>())
  const connectRef = useRef<AcpActionsValue["connect"] | null>(null)
  // `reconnect` for callbacks created before it is (a connect failure's
  // "Retry").
  const reconnectRef = useRef<AcpActionsValue["reconnect"] | null>(null)

  /**
   * Fold backend-resolved identity into the remembered connect params.
   *
   * `connect()` records what the CALLER asked for, and for a new conversation
   * that request carries no `sessionId` / `conversationId` — the backend mints
   * them later and they only ever land on the store entry. But the entry is
   * exactly what disappears when a connection is removed WITHOUT a user
   * teardown (backend GC via `connection_gone`, the idle sweep, the unmount
   * cleanup), which is the main way a composer ends up needing Reconnect. With
   * only the original request left, that button would start a fresh ACP session
   * instead of resuming the conversation.
   *
   * No-op when nothing was remembered for the key: `agentType` alone makes a
   * request reconnectable, and it can only come from `connect()`.
   */
  const rememberResolvedIdentity = useCallback(
    (
      contextKey: string,
      patch: { sessionId?: string; conversationId?: number }
    ) => {
      const remembered = lastConnectParamsRef.current.get(contextKey)
      if (!remembered) return
      lastConnectParamsRef.current.set(contextKey, { ...remembered, ...patch })
    },
    []
  )

  /**
   * Snapshot the live entry's resolved identity into the remembered params
   * immediately BEFORE that entry goes away.
   *
   * Identity reaches the entry by several routes — the `session_started` event,
   * a snapshot hydrate on a cold attach (where the event was already consumed
   * before this client attached, so it is never replayed), a replayed event —
   * but it leaves by exactly one: the entry being removed. Capturing at the
   * single exit covers every route in, including ones added later.
   */
  const captureIdentityBeforeRemoval = useCallback(
    (contextKey: string) => {
      const sessionId = storeRef.current.connections.get(contextKey)?.sessionId
      if (!sessionId) return
      rememberResolvedIdentity(contextKey, { sessionId })
    },
    [rememberResolvedIdentity]
  )

  type ConnectBlockState =
    | { kind: "none"; reason: "" }
    | {
        kind: "missing_config" | "disabled" | "unavailable" | "sdk_missing"
        reason: string
      }

  const resolveConnectBlockState = useCallback(
    (agent: AcpAgentStatus | null): ConnectBlockState => {
      if (!agent) {
        return { kind: "missing_config", reason: t("blocked.missingConfig") }
      }

      const agentLabel = getAgentLabel(agent.agent_type)
      if (!agent.enabled) {
        return {
          kind: "disabled",
          reason: t("blocked.disabled", { agent: agentLabel }),
        }
      }

      if (!agent.available) {
        return {
          kind: "unavailable",
          reason: t("blocked.unavailable", { agent: agentLabel }),
        }
      }

      if (agent.installed_version) {
        return { kind: "none", reason: "" }
      }

      return {
        kind: "sdk_missing",
        // Claude Code / Codex install a separate ACP adapter package, not the
        // vendor CLI — saying "{agent} is not installed" to someone who has
        // `claude` on their PATH reads as a bug in codeg. Name what's actually
        // missing instead.
        reason: agent.is_acp_adapter
          ? t("blocked.adapterMissing", { agent: agentLabel })
          : t("blocked.sdkMissing", { agent: agentLabel }),
      }
    },
    [t]
  )

  // Per-contextKey liveMessage sinks. Fired synchronously from `dispatch` when a
  // connection's liveMessage reference changes, mirroring it into the runtime
  // store outside React (see `LiveMessageSink`). A ref → no re-renders.
  const liveMessageSinksRef = useRef(new Map<string, LiveMessageSink>())

  // Activity tracking (no re-renders)
  const lastActivityRef = useRef(new Map<string, number>())
  // Streaming coalescing queue + its window, PER CONNECTION (see
  // `flushStreamingQueue`). Entries are created on the first delta after a
  // flush and removed by the flush that drains them, so both maps hold only
  // the connections with deltas in flight right now.
  const streamingQueuesRef = useRef(new Map<string, StreamingAction[]>())
  const flushTimersRef = useRef(
    new Map<string, ReturnType<typeof setTimeout>>()
  )
  const pendingUnmappedEventsRef = useRef(new Map<string, EventEnvelope[]>())
  const listenerReadyRef = useRef(false)
  const listenerReadyWaitersRef = useRef<Array<() => void>>([])
  // Set of refs (not callbacks) so unmount cleanup matches the original
  // registration even when caller-side handler identity changes per render.
  // Populated by the `useAcpEvent` hook; read by the primary `acp://event`
  // listener and the buffered-events replay loop.
  const eventSubscribersRef = useRef<Set<EventSubscriberRef>>(new Set())

  // ── Notify helpers ──

  const notifyKeyListeners = useCallback((key: string) => {
    const listeners = storeRef.current.keyListeners.get(key)
    if (listeners) {
      for (const cb of listeners) cb()
    }
  }, [])

  const notifyAllKeyListeners = useCallback(() => {
    for (const [, listeners] of storeRef.current.keyListeners) {
      for (const cb of listeners) cb()
    }
  }, [])

  const notifyActiveKeyListeners = useCallback(() => {
    for (const cb of storeRef.current.activeKeyListeners) cb()
  }, [])

  /**
   * Publish (or retire) the in-flight-`connect()` marker for a key and wake its
   * subscribers. Rides the SAME per-key listener set as the connections map, so
   * a surface watching one key observes the pending → entry handover as one
   * continuous stream rather than two stores it has to reconcile.
   */
  const setConnectPending = useCallback(
    (key: string, info: ConnectPendingInfo | null) => {
      const { connectPending } = storeRef.current
      if (info === null) {
        if (!connectPending.delete(key)) return
      } else {
        connectPending.set(key, info)
      }
      notifyKeyListeners(key)
    },
    [notifyKeyListeners]
  )

  /** Publish (or retire) why the last `connect()` for a key failed — see
   *  `ConnectErrorInfo`. Same per-key listener set as `setConnectPending`.
   *  Retiring one (a new attempt starting, the surface letting go) also takes
   *  its notification's toast off the screen: it no longer says what is true,
   *  and its Retry would act on nothing. */
  const setConnectError = useCallback(
    (key: string, info: ConnectErrorInfo | null) => {
      const { connectErrors } = storeRef.current
      if (info === null) {
        if (!connectErrors.delete(key)) return
        dismissNotification(connectErrorNotificationKey(key))
      } else {
        connectErrors.set(key, info)
      }
      notifyKeyListeners(key)
    },
    [notifyKeyListeners]
  )

  /**
   * Tell the user a `connect()` failed — the notification that goes with
   * `setConnectError` (which the connection-status heart shows). "Open Agents
   * settings" when the fix lives there; "Retry" re-runs the connect, on the
   * toast only, and only while this failure is still the key's latest — the
   * surface closing or a newer attempt starting retires it, and a retry then
   * would spawn an agent for a tab that is gone, or race the attempt running.
   */
  const notifyConnectError = useCallback(
    (contextKey: string, info: ConnectErrorInfo) => {
      const actions: NotifyAction[] = []
      if (info.opensAgentSettings) {
        actions.push({
          label: t("actions.openAgentsSettings"),
          onClick: () => {
            openSettingsWindow("agents", { agentType: info.agentType }).catch(
              (err) => {
                console.error("[AcpConnections] open agent settings:", err)
              }
            )
          },
        })
      }
      actions.push({
        label: t("actions.retry"),
        onClick: () => {
          if (storeRef.current.connectErrors.get(contextKey) !== info) return
          void reconnectRef.current?.(contextKey).catch(() => {
            // A failed retry publishes (and notifies) its own failure.
          })
        },
        toastOnly: true,
      })
      notify({
        level: "error",
        key: connectErrorNotificationKey(contextKey),
        title: info.title,
        description: info.detail,
        actions,
      })
    },
    [t]
  )

  // ── Dispatch (replaces useReducer dispatch) ──

  /**
   * Drop ONE connection's queued deltas and its window, without dispatching.
   *
   * Declared here rather than beside the other streaming helpers because
   * `dispatch` below calls it and needs it in scope; it touches only the two
   * refs, so there is no cycle.
   */
  const discardStreamingKey = useCallback((contextKey: string) => {
    const timer = flushTimersRef.current.get(contextKey)
    if (timer !== undefined) {
      clearTimeout(timer)
      flushTimersRef.current.delete(contextKey)
    }
    streamingQueuesRef.current.delete(contextKey)
  }, [])

  /** The same, for every connection at once. */
  const discardStreamingQueues = useCallback(() => {
    for (const timer of flushTimersRef.current.values()) clearTimeout(timer)
    flushTimersRef.current.clear()
    streamingQueuesRef.current.clear()
  }, [])

  const dispatch = useCallback(
    (action: Action) => {
      const prev = storeRef.current.connections
      const next = connectionsReducer(prev, action)

      // "No entry, no queue." A removed key must not leave deltas armed behind
      // it: they land up to `STREAM_FLUSH_MAX_MS` later, and context keys are
      // REUSED — the same `conv-<id>-<agent>-<folder>` string is handed to the
      // next connection that opens on that tab — so a late batch does not
      // merely waste a dispatch, it can append a dead turn's prose to a live
      // one.
      //
      // Read off the reducer's OWN result rather than from a list of removal
      // actions, so the rule is exactly "the entry is gone" and cannot drift
      // from what the reducer decided. It also declines where the reducer
      // declines — a rekey onto an occupied key is rejected, and discarding
      // for a connection that is still there and still talking would lose its
      // trailing prose.
      //
      // What IS enumerated is the two hot paths, so that the list fails safe:
      // forget to add a case here and the cost is a walk over the open
      // connections, not a stray window. Listing the removals instead reads
      // cheaper and fails the other way — that is how `DELEGATION_CHILD_DETACH`
      // went uncovered, and a size check alone would miss the next action
      // shaped like `REKEY_CONNECTION`, which removes a key and adds another.
      //
      // Discard rather than flush: a flush would re-enter `dispatch`, and
      // there is no one left to render the result. Callers that DO want the
      // deltas landed first call `flushStreamingQueue(key)` before removing —
      // `connect()`'s orphan rescue is the one that does, ahead of its rekey.
      if (
        next !== prev &&
        action.type !== "STREAM_BATCH" &&
        action.type !== "BATCH_TOOL_CALL_UPDATES"
      ) {
        for (const key of prev.keys()) {
          if (!next.has(key)) discardStreamingKey(key)
        }
      }

      if (next === prev) return // no change

      storeRef.current.connections = next

      // Mirror a changed liveMessage into the runtime store OUTSIDE React, so
      // the keep-alive conversation panel no longer has to re-render per
      // streaming token just to run a mirror effect. Fires only when the
      // reference actually changed and a sink is registered for the key; writes
      // non-null values (turn-end clearing is owned by COMPLETE_TURN, unmount by
      // removeConversation). `isLive = status === "prompting"`.
      //
      // Ordering: mirror BEFORE notifying the connection's key listeners, so the
      // runtime store is updated before React observes the connection change —
      // the panel and the runtime-store-driven message list then re-render off a
      // consistent snapshot (not relying on React batching to reconcile the two).
      const mirrorLiveMessage = (key: string) => {
        const sink = liveMessageSinksRef.current.get(key)
        if (!sink) return
        const nextConn = next.get(key)
        if (!nextConn || nextConn.liveMessage == null) return
        if (nextConn.liveMessage === prev.get(key)?.liveMessage) return
        sink(nextConn.liveMessage, nextConn.status === "prompting")
      }

      if (action.type === "REMOVE_ALL") {
        notifyAllKeyListeners()
      } else if (action.type === "STREAM_BATCH") {
        const keys = new Set(action.actions.map((item) => item.contextKey))
        for (const key of keys) {
          mirrorLiveMessage(key)
          notifyKeyListeners(key)
        }
      } else if (action.type === "BATCH_TOOL_CALL_UPDATES") {
        const keys = new Set(action.actions.map((item) => item.contextKey))
        for (const key of keys) {
          mirrorLiveMessage(key)
          notifyKeyListeners(key)
        }
      } else if (action.type === "REKEY_CONNECTION") {
        // The connection (with its in-flight liveMessage) moved to toKey; sync
        // it BEFORE notifying so a close+reopen mid-turn doesn't drop the stream.
        mirrorLiveMessage(action.toKey)
        notifyKeyListeners(action.fromKey)
        notifyKeyListeners(action.toKey)
      } else {
        const key = getAffectedKey(action)
        if (key) {
          mirrorLiveMessage(key)
          notifyKeyListeners(key)
        }
      }
    },
    [discardStreamingKey, notifyKeyListeners, notifyAllKeyListeners]
  )

  // ── setActiveKey ──

  const setActiveKey = useCallback(
    (key: string | null) => {
      if (storeRef.current.activeKey === key) return
      storeRef.current.activeKey = key
      notifyActiveKeyListeners()
    },
    [notifyActiveKeyListeners]
  )

  // ── Store API (stable object — never recreated) ──

  const storeApi = useMemo<ConnectionStoreApi>(() => {
    return {
      getConnection(key: string) {
        return storeRef.current.connections.get(key)
      },
      getConnectPending(key: string) {
        return storeRef.current.connectPending.get(key)
      },
      getConnectError(key: string) {
        return storeRef.current.connectErrors.get(key)
      },
      getActiveKey() {
        return storeRef.current.activeKey
      },
      subscribeKey(key: string, cb: () => void) {
        const { keyListeners } = storeRef.current
        let set = keyListeners.get(key)
        if (!set) {
          set = new Set()
          keyListeners.set(key, set)
        }
        set.add(cb)
        return () => {
          set!.delete(cb)
          if (set!.size === 0) keyListeners.delete(key)
        }
      },
      subscribeActiveKey(cb: () => void) {
        storeRef.current.activeKeyListeners.add(cb)
        return () => {
          storeRef.current.activeKeyListeners.delete(cb)
        }
      },
    }
  }, [])

  const touchActivity = useCallback((contextKey: string) => {
    lastActivityRef.current.set(contextKey, Date.now())
  }, [])

  const registerOpenTabKeys = useCallback((keys: Set<string>) => {
    openTabKeysRef.current = keys
  }, [])

  const registerLiveSurfaceKeys = useCallback(
    (source: string, keys: Set<string>) => {
      if (keys.size === 0) extraLiveKeysRef.current.delete(source)
      else extraLiveKeysRef.current.set(source, keys)
    },
    []
  )

  const registerLiveMessageSink = useCallback(
    (contextKey: string, sink: LiveMessageSink) => {
      liveMessageSinksRef.current.set(contextKey, sink)
      // Replay the CURRENT liveMessage immediately, matching the removed mirror
      // effect's setup write. A panel can mount/remount over a connection that
      // already holds a non-null liveMessage — connection reuse, a viewer
      // attaching mid-turn, or close+reopen mid-turn — and if the stream is
      // paused (e.g. blocked on a permission/question) no further delta would
      // arrive to trigger the sink. Without this replay the runtime store, and
      // thus the message list, would stay blank/stale until the next change.
      const conn = storeRef.current.connections.get(contextKey)
      if (conn?.liveMessage != null) {
        sink(conn.liveMessage, conn.status === "prompting")
      }
      return () => {
        // Idempotent: only drop the entry if it still points at this sink (a
        // remount may have already replaced it).
        if (liveMessageSinksRef.current.get(contextKey) === sink) {
          liveMessageSinksRef.current.delete(contextKey)
        }
      }
    },
    []
  )

  const clearAcpLoadError = useCallback(
    (contextKey: string) => {
      dispatch({ type: "CLEAR_ACP_LOAD_ERROR", contextKey })
    },
    [dispatch]
  )

  /**
   * Drain ONE connection's coalesced deltas into a single `STREAM_BATCH`.
   *
   * Scheduling is PER CONNECTION. The queue and its window used to be global,
   * so the window a batch waited in was whichever connection's delta happened
   * to arm the timer. Harmless while that window was a flat 16 ms; once
   * `streamFlushDelayMs` sizes it from what is being re-rendered, a long reply
   * in one conversation held every OTHER conversation's deltas for up to
   * `STREAM_FLUSH_MAX_MS` — including a background conversation with no panel
   * mounted, which costs nothing to flush and so bought nothing by waiting.
   * Codeg runs several agents at once by design, so that is the normal case,
   * not a corner of one.
   *
   * Connections are independent — own wire, own seq cursor, own
   * `ConnectionState` — so there is nothing to coordinate between them, and
   * per-key ordering is what the reducer and the out-of-turn guards already
   * reason about. Nothing wants "flush everything": teardown discards instead
   * (`discardStreamingQueues`), because a batch dispatched into a key that is
   * being removed is at best wasted and at worst lands on its successor.
   */
  const flushStreamingQueue = useCallback(
    (contextKey: string) => {
      // CANCEL the pending window, don't just forget it. Most callers are
      // event handlers flushing out of turn (a tool card, a permission prompt,
      // a usage update), and a timer that is only dropped from the map still
      // fires: it releases whatever the NEXT window had queued, early, and
      // takes that window's entry with it, so the delta after it arms a third
      // timer. One stray timer per out-of-turn flush, each halving the
      // cadence — which is how a widened window (`streamFlushDelayMs`) decays
      // back to a flat frame over exactly the long turns it exists for.
      const timer = flushTimersRef.current.get(contextKey)
      if (timer !== undefined) {
        clearTimeout(timer)
        flushTimersRef.current.delete(contextKey)
      }
      const queued = streamingQueuesRef.current.get(contextKey)
      if (queued === undefined) return
      streamingQueuesRef.current.delete(contextKey)
      if (queued.length === 0) return

      // Merge adjacent deltas (arrival order preserved), reducing reducer work
      // and string copies under high-frequency streams. Same-type AND same
      // subagent attribution: within one flush window, main-thread and
      // parented deltas (or two different subagents') must not concatenate —
      // this pre-coalescing runs BEFORE the reducer's attribution-aware merge
      // and would otherwise defeat it.
      const compacted: StreamingAction[] = []
      for (const action of queued) {
        const last = compacted[compacted.length - 1]
        if (
          last &&
          last.type === action.type &&
          last.parentToolUseId === action.parentToolUseId
        ) {
          last.text += action.text
        } else {
          compacted.push({ ...action })
        }
      }

      dispatch({ type: "STREAM_BATCH", actions: compacted })
    },
    [dispatch]
  )

  const enqueueStreamingAction = useCallback(
    (action: StreamingAction) => {
      const { contextKey } = action
      let queue = streamingQueuesRef.current.get(contextKey)
      if (queue === undefined) {
        queue = []
        streamingQueuesRef.current.set(contextKey, queue)
      }
      queue.push(action)
      if (queue.length >= STREAM_QUEUE_CAP) {
        // Cap reached — `flushStreamingQueue` clears the pending window itself.
        flushStreamingQueue(contextKey)
        return
      }
      if (!flushTimersRef.current.has(contextKey)) {
        // Size the window from what this batch will re-render, read as of the
        // last batch — so it costs one map lookup plus a walk over the live
        // turn's blocks, and a fresh turn (empty live message) is back to a
        // single frame. See `liveRerenderChars` and `streamFlushDelayMs`.
        const delay = streamFlushDelayMs(
          liveRerenderChars(
            storeRef.current.connections.get(contextKey)?.liveMessage?.content
          )
        )
        flushTimersRef.current.set(
          contextKey,
          setTimeout(() => flushStreamingQueue(contextKey), delay)
        )
      }
    },
    [flushStreamingQueue]
  )

  /**
   * Turn PROGRESS settles in-flight AIR retry incidents — codex's own
   * `completeRetryIncidentOnTurnProgress`: a reconnect warning is published
   * when the upstream drops, and the next byte of turn output is the proof it
   * came back. Without this the only settle points are a clean `end_turn` and
   * the next prompt, so a long turn that reconnected N times kept N permanent
   * strips docked under the composer (issue #496).
   *
   * Called per chunk, so it reads the store and dispatches only when something
   * would actually change; the common case is a `some()` over an empty array.
   */
  const settleRetryIncidentsOnProgress = useCallback(
    (contextKey: string) => {
      const conn = storeRef.current.connections.get(contextKey)
      if (!conn || !hasActiveRetryIncident(conn.sessionFailures)) return
      dispatch({
        type: "SETTLE_SESSION_FAILURES",
        contextKey,
        scope: "retry_incidents",
      })
    },
    [dispatch]
  )

  const registerSessionFailureActions = useCallback(
    (contextKey: string, handler: (action: SessionFailureAction) => void) => {
      const handlers = sessionFailureActionsRef.current
      handlers.set(contextKey, handler)
      return () => {
        if (handlers.get(contextKey) === handler) handlers.delete(contextKey)
      }
    },
    []
  )

  /** The mounted view answering `connectionId`'s failure buttons, if any.
   *  Matched by connection rather than by the key a notification was raised
   *  under: one connection can feed several surfaces, and only the owner's
   *  view registers. */
  const sessionFailureHandlerFor = useCallback((connectionId: string) => {
    for (const [key, handler] of sessionFailureActionsRef.current) {
      if (
        storeRef.current.connections.get(key)?.connectionId === connectionId
      ) {
        return handler
      }
    }
    return null
  }, [])

  /**
   * A failure record's recovery buttons, for its notification. "Sign in" opens
   * the agent's settings page and works from anywhere, the alert list
   * included. "Retry" (re-send the last prompt) and "new session" need the
   * conversation view: offered only while one is registered, looked up again
   * at click time, and kept to the toast — later, in the list, they would act
   * on whatever the conversation has become since.
   */
  const sessionFailureNotifyActions = useCallback(
    (
      connectionId: string,
      agentType: AgentType,
      record: SessionFailureRecord
    ): NotifyAction[] => {
      const actions: NotifyAction[] = []
      for (const action of knownSessionFailureActions(record)) {
        if (action === "login") {
          actions.push({
            label: tFailure("action.login"),
            onClick: () => {
              openSettingsWindow("agents", { agentType }).catch((err) => {
                console.error("[AcpConnections] open agent settings:", err)
              })
            },
          })
        } else if (sessionFailureHandlerFor(connectionId)) {
          actions.push({
            label: tFailure(
              action === "retry" ? "action.retry" : "action.newSession"
            ),
            onClick: () => sessionFailureHandlerFor(connectionId)?.(action),
            toastOnly: true,
          })
        }
      }
      return actions
    },
    [sessionFailureHandlerFor, tFailure]
  )

  /**
   * Tell a failed turn once. claude and codex report one failure twice — their
   * typed AIR record, and codeg's `turn_failed_*` verdict on the same turn —
   * in either order; the two are shown as ONE toast and ONE alert: the typed
   * account's wording and buttons, the verdict's evidence behind the alert's
   * disclosure. A verdict after the typed account only adds that evidence to
   * the latest one's alert (the toast on screen already says it better); a
   * typed account after a lone verdict takes that verdict's notification over.
   * Any OTHER record — a second failure in the same turn, a session-level one
   * while idle — is its own notification, and revisions of a record update it.
   *
   * The toast-only buttons (re-send the prompt, open a new session) act on the
   * turn that failed, so they go inert once the next prompt starts — which
   * also takes the turn's toasts off the screen (see `retireTurnFailures`).
   */
  const notifyTurnFailure = useCallback(
    (connectionId: string, part: TurnFailurePart) => {
      const states = turnFailuresRef.current
      let state = states.get(connectionId)
      if (!state) {
        state = { keys: new Set(), typedKeys: new Map() }
        states.set(connectionId, state)
      }
      const newKey = () =>
        `acp-turn-failure:${connectionId}:${++turnFailureSerialRef.current}`

      if (part.kind === "verdict") {
        const typed = state.lastTyped
        if (typed) {
          state.verdict = {
            key: typed.key,
            evidence: part.evidence,
            paired: true,
          }
          notify({
            level: "error",
            ...typed,
            evidence: part.evidence,
            bellOnly: true,
          })
          return
        }
        const key = state.verdict?.key ?? newKey()
        state.verdict = { key, evidence: part.evidence, paired: false }
        state.keys.add(key)
        notify({
          level: "error",
          key,
          title: part.title,
          evidence: part.evidence,
        })
        return
      }

      let key = state.typedKeys.get(part.recordId)
      if (!key) {
        if (state.verdict && !state.verdict.paired) {
          key = state.verdict.key
          state.verdict.paired = true
        } else {
          key = newKey()
        }
      }
      state.typedKeys.set(part.recordId, key)
      state.keys.add(key)
      const turnKey = key
      const actions = part.actions.map((action) =>
        action.toastOnly
          ? {
              ...action,
              onClick: () => {
                if (
                  turnFailuresRef.current.get(connectionId)?.keys.has(turnKey)
                ) {
                  action.onClick()
                }
              },
            }
          : action
      )
      state.lastTyped = {
        key,
        title: part.title,
        description: part.description,
        actions,
      }
      notify({
        level: "error",
        key,
        title: part.title,
        description: part.description,
        evidence:
          state.verdict?.key === key ? state.verdict.evidence : undefined,
        actions,
      })
    },
    []
  )

  /** The turn is over for good — a new prompt, or the connection released:
   *  its failure toasts come off the screen (the alert list keeps them), and
   *  their toast-only buttons go inert with them. */
  const retireTurnFailures = useCallback((connectionId: string) => {
    const state = turnFailuresRef.current.get(connectionId)
    if (!state) return
    turnFailuresRef.current.delete(connectionId)
    for (const key of state.keys) dismissNotification(key)
  }, [])

  const resolveListenerReadyWaiters = useCallback(() => {
    if (listenerReadyWaitersRef.current.length === 0) return
    const waiters = listenerReadyWaitersRef.current
    listenerReadyWaitersRef.current = []
    for (const resolve of waiters) resolve()
  }, [])

  const waitForListenerReady = useCallback(async () => {
    if (listenerReadyRef.current) return
    await new Promise<void>((resolve) => {
      listenerReadyWaitersRef.current.push(resolve)
    })
  }, [])

  const bufferUnmappedEvent = useCallback((event: EventEnvelope) => {
    const connectionId = event.connection_id
    const buffered = pendingUnmappedEventsRef.current.get(connectionId) ?? []
    if (buffered.length >= MAX_BUFFERED_UNMAPPED_EVENTS_PER_CONNECTION) {
      buffered.shift()
    }
    buffered.push(event)
    pendingUnmappedEventsRef.current.set(connectionId, buffered)

    if (
      pendingUnmappedEventsRef.current.size > MAX_BUFFERED_UNMAPPED_CONNECTIONS
    ) {
      const oldest = pendingUnmappedEventsRef.current.keys().next().value
      if (oldest) {
        pendingUnmappedEventsRef.current.delete(oldest)
      }
    }
  }, [])

  const consumeBufferedEvents = useCallback(
    (connectionId: string): EventEnvelope[] => {
      const buffered = pendingUnmappedEventsRef.current.get(connectionId)
      if (!buffered || buffered.length === 0) return []
      pendingUnmappedEventsRef.current.delete(connectionId)
      return buffered
    },
    []
  )

  // ── RAF batching for tool_call_update events ──
  const pendingToolCallUpdates = useRef<
    Array<{
      contextKey: string
      tool_call_id: string
      title: string | null
      fallback_title: string
      fallback_kind: string
      status: string | null
      content: string | null
      raw_input: string | null
      raw_output: string | null
      raw_output_append?: boolean
      locations: unknown
      meta: ToolCallMeta
      images: ToolCallImage[] | null
    }>
  >([])
  const toolCallUpdateRafId = useRef<number | null>(null)

  const flushPendingToolCallUpdates = useCallback(() => {
    if (pendingToolCallUpdates.current.length === 0) return
    if (toolCallUpdateRafId.current !== null) {
      cancelAnimationFrame(toolCallUpdateRafId.current)
      toolCallUpdateRafId.current = null
    }
    const batch = pendingToolCallUpdates.current
    pendingToolCallUpdates.current = []
    dispatch({ type: "BATCH_TOOL_CALL_UPDATES", actions: batch })
  }, [dispatch])

  const scheduleToolCallUpdateFlush = useCallback(() => {
    if (toolCallUpdateRafId.current !== null) return
    toolCallUpdateRafId.current = requestAnimationFrame(() => {
      toolCallUpdateRafId.current = null
      flushPendingToolCallUpdates()
    })
  }, [flushPendingToolCallUpdates])

  useEffect(() => {
    return () => {
      if (toolCallUpdateRafId.current !== null) {
        cancelAnimationFrame(toolCallUpdateRafId.current)
      }
    }
  }, [])

  /**
   * Say so when the agent settled a config-option pick somewhere else.
   *
   * `session/set_config_option` is advisory: the agent answers with the option
   * list it adopted and codeg renders that verbatim, so a refused or downgraded
   * pick reads as the selector springing back for no reason. pi does this for a
   * model whose reasoning it can't honour; grok does it for a model switch
   * mid-conversation.
   *
   * The request/answer correlation is the backend's (`ConfigOptionRejected`) —
   * `acpSetConfigOption` resolves as soon as the command is queued, and the
   * resulting option list arrives as a broadcast indistinguishable from an
   * unsolicited update. This side only renders the verdict.
   *
   * Reporting only — the saved preference deliberately keeps the ATTEMPTED value.
   * A rejection is often about this session rather than the pick itself (grok's
   * mid-conversation switch succeeds in a fresh one).
   */
  const reportConfigOptionVerdict = useCallback(
    (
      connectionKey: string,
      agentType: AgentType | undefined,
      rejection: {
        config_id: string
        option_name: string
        requested: string
        actual: string
        requested_value?: string
        actual_value?: string
      }
    ) => {
      // The composer's dropdown is localised, so this notice has to name the
      // same things the user was looking at — otherwise an English selector
      // produces a Chinese "your pick was adjusted" toast. The event carries
      // the raw ids beside the labels precisely so this lookup is possible;
      // the labels remain the fallback for any id we do not own.
      const option = localizeConfigOptionLabel(
        agentType,
        rejection.config_id,
        rejection.option_name,
        vocabularyT
      )
      const value = (id: string | undefined, fallback: string) =>
        localizeConfigValueLabel(
          agentType,
          rejection.config_id,
          id,
          fallback,
          vocabularyT
        )
      notify({
        level: "warning",
        key: `acp-config-adjusted:${connectionKey}:${rejection.config_id}`,
        title: t("configOptionAdjusted", {
          agent: agentType ? getAgentLabel(agentType) : "",
          option,
          requested: value(rejection.requested_value, rejection.requested),
          actual: value(rejection.actual_value, rejection.actual),
        }),
      })
    },
    [t, vocabularyT]
  )

  // Localize a backend `error` by its stable `code`. Both the live event and a
  // snapshot's `last_error` go through here, so a client that attached after
  // the fact reads the same sentence one that watched it live did. Unknown
  // codes fall back to the raw message so a useful trace is never swallowed.
  const localizeBackendError = useCallback(
    (
      code: string | null | undefined,
      message: string,
      agentLabel: string
    ): string => {
      switch (code) {
        case "initialize_timeout":
          return t("backendErrors.initializeTimeout", {
            agent: agentLabel,
          })
        case "mcp_rejected_by_agent":
          return t("backendErrors.mcpRejectedByAgent", {
            agent: agentLabel,
            message,
          })
        // The agent refused to OPEN a session for want of a credential.
        // Deliberately drops the agent's own wording: cursor-agent's
        // says to run `agent login`, which is not a command that exists
        // (the binary is `cursor-agent`, and codeg's managed copy is not
        // on PATH) — so echoing it sends the user somewhere they cannot
        // go. The agent's settings panel is where the real command, and
        // the API-key alternative, live. The raw refusal is not lost —
        // it is still `message` — so an agent whose text turns out to
        // be worth showing can be surfaced here without a backend change.
        case "agent_auth_required":
          return t("backendErrors.agentAuthRequired", {
            agent: agentLabel,
          })
        case "sdk_not_installed":
          return t("blocked.sdkMissing", { agent: agentLabel })
        case "platform_not_supported":
          return t("blocked.unavailable", { agent: agentLabel })
        case "process_exited":
          return t("backendErrors.processExited", { agent: agentLabel })
        case "spawn_failed":
          return t("backendErrors.spawnFailed", {
            agent: agentLabel,
            message,
          })
        case "download_failed":
          return t("backendErrors.downloadFailed", {
            agent: agentLabel,
            message,
          })
        case "turn_failed_refusal":
          return t("backendErrors.turnFailedRefusal", {
            agent: agentLabel,
          })
        case "turn_failed_max_tokens":
          return t("backendErrors.turnFailedMaxTokens", {
            agent: agentLabel,
          })
        case "turn_failed_max_turn_requests":
          return t("backendErrors.turnFailedMaxTurnRequests", {
            agent: agentLabel,
          })
        case "turn_failed_unknown":
          return t("backendErrors.turnFailedUnknown", {
            agent: agentLabel,
          })
        // The agent refused the prompt with ACP's `authRequired` instead
        // of running it. The connection is deliberately kept alive, so
        // this reads as "sign in and send it again", not as a crash. An
        // AIR-capable agent additionally publishes an `access` failure
        // record whose Login button opens agent settings.
        case "turn_failed_auth_required":
          return t("backendErrors.turnFailedAuthRequired", {
            agent: agentLabel,
          })
        case "turn_failed_empty":
          return t("backendErrors.turnFailedEmpty", {
            agent: agentLabel,
          })
        // The agent did emit something, but the backend couldn't parse
        // it — points at an agent/protocol version mismatch rather than
        // at the agent's configuration.
        case "turn_failed_empty_protocol":
          return t("backendErrors.turnFailedEmptyProtocol", {
            agent: agentLabel,
          })
        // Only metadata (plan / mode / usage) arrived. Reported as an
        // observation, NOT as "this turn was fine" — a real failure can
        // follow a plan or usage update.
        case "turn_failed_empty_metadata":
          return t("backendErrors.turnFailedEmptyMetadata", {
            agent: agentLabel,
          })
        case "grok_model_switch_incompatible_agent":
          return t("backendErrors.grokModelSwitchIncompatibleAgent", {
            agent: agentLabel,
          })
        // Verdicts on a selector change or a goal action (toasts — see
        // `routeAcpError`); the backend's own reason rides as the detail.
        case "set_mode_failed":
          return t("backendErrors.setModeFailed", { agent: agentLabel })
        case "set_config_option_failed":
          return t("backendErrors.setConfigOptionFailed", {
            agent: agentLabel,
          })
        case "goal_control_failed":
          return t("backendErrors.goalControlFailed", { agent: agentLabel })
        case "image_dropped":
          return t("backendErrors.imageDropped", { agent: agentLabel })
        // `session/load` failed in a way codeg could not classify, so the
        // backend started a NEW session to keep the conversation usable —
        // without the context the agent had before.
        case "session_load_fallback":
          return t("backendErrors.sessionLoadFallback", { agent: agentLabel })
        default:
          return message
      }
    },
    [t]
  )

  /**
   * Route + localize one backend error (see `routeAcpError`):
   *
   * - `text` — the one localized line (the notification's title, and the
   *   session's `error` for the connection-status popover);
   * - `reason` — the raw backend message, for codes whose localized line leaves
   *   it out: the notification's second line;
   * - `evidence` — the backend's diagnostic evidence (agent stderr tail,
   *   unparsed-update counts; already redacted and bounded there, and
   *   whitespace-only collapses to nothing): machine output, so it is kept for
   *   the alert list's disclosure and never put in a toast.
   */
  const presentBackendError = useCallback(
    (
      code: string | null | undefined,
      message: string,
      details: string | null | undefined,
      agentLabel: string
    ) => {
      const route = routeAcpError(code)
      const text = localizeBackendError(code, message, agentLabel)
      const raw = message.trim()
      return {
        route,
        text,
        reason: route.rawAsDetail && raw && raw !== text ? raw : undefined,
        evidence: details?.trim() || undefined,
      }
    },
    [localizeBackendError]
  )

  const handleMappedEvent = useCallback(
    (
      contextKey: string,
      e: EventEnvelope,
      /**
       * True when this envelope was ALREADY delivered to another surface in
       * this same fan-out (one backend connection can be routed to several
       * contextKeys — see `reverseMapRef`). Store effects still run per
       * surface: each has its own ConnectionState. Effects that belong to the
       * ENVELOPE rather than to a surface — the notification sound, OS
       * notifications, toasts — must fire exactly once, or a tab and the
       * work-task transcript viewer on one session would double every ping.
       */
      echo = false
    ) => {
      // One-shot effects are off for an echo, and equally for REPLAYED
      // history (a reconnect catching up on a gap — see `onReplay`): the store
      // still has to catch up, but a toast for a notice from ten minutes ago
      // is noise, and it already fired once if this client was watching.
      const quiet = echo || envelopeEffectsMutedRef.current > 0
      // Audible cue for the events the user opted into (Settings → General →
      // notification sounds). One call for the whole catalogue rather than a
      // line per case: the mapping — including which events are cues at all —
      // lives in `soundEventIdForEnvelope`, alongside the preference schema it
      // mirrors. Off unless configured, and self-throttling, so this is a
      // cheap no-op on the hot path.
      if (!quiet) playEventSound(e)
      switch (e.type) {
        case "status_changed":
          flushStreamingQueue(contextKey)
          if (e.status === "prompting") {
            // A new turn: the last one's failures are behind the user now,
            // and if this one fails, that is a new notification.
            const turnConn = storeRef.current.connections.get(contextKey)
            retireTurnFailures(turnConn?.connectionId ?? contextKey)
          }
          dispatch({ type: "STATUS_CHANGED", contextKey, status: e.status })
          break
        case "content_delta":
          settleRetryIncidentsOnProgress(contextKey)
          enqueueStreamingAction({
            type: "CONTENT_DELTA",
            contextKey,
            text: e.text,
            // Wire `null` normalizes to `undefined` so the reducer's strict
            // attribution equality works on one representation.
            parentToolUseId: e.parent_tool_use_id ?? undefined,
          })
          break
        case "thinking":
          settleRetryIncidentsOnProgress(contextKey)
          enqueueStreamingAction({
            type: "THINKING",
            contextKey,
            text: e.text,
            parentToolUseId: e.parent_tool_use_id ?? undefined,
          })
          break
        case "claude_sdk_message":
          flushStreamingQueue(contextKey)
          dispatch({
            type: "CLAUDE_API_RETRY",
            contextKey,
            retry: parseClaudeApiRetryEvent(e),
          })
          break
        case "tool_call":
          settleRetryIncidentsOnProgress(contextKey)
          flushStreamingQueue(contextKey)
          dispatch({
            type: "TOOL_CALL",
            contextKey,
            tool_call_id: e.tool_call_id,
            title: e.title,
            kind: e.kind,
            status: e.status,
            content: e.content,
            raw_input: e.raw_input,
            raw_output: e.raw_output,
            locations: e.locations ?? null,
            meta: (e.meta as ToolCallMeta) ?? null,
            images: e.images ?? null,
          })
          break
        case "tool_call_update":
          flushStreamingQueue(contextKey)
          pendingToolCallUpdates.current.push({
            contextKey,
            tool_call_id: e.tool_call_id,
            title: e.title,
            fallback_title: t("toolFallbackTitle"),
            fallback_kind: "tool",
            status: e.status,
            content: e.content,
            raw_input: e.raw_input,
            raw_output: e.raw_output,
            raw_output_append: e.raw_output_append,
            locations: e.locations ?? null,
            meta: (e.meta as ToolCallMeta) ?? null,
            images: e.images ?? null,
          })
          scheduleToolCallUpdateFlush()
          break
        case "feedback_submitted": {
          // A note that is ALREADY `delivered` when it is submitted was pushed
          // into the running turn over the native `_session/steering` channel
          // (`FeedbackItem::new_delivered` is that path's only producer). The
          // agent has the text as a user message, so the transcript shows it
          // as one: it closes the assistant turn at this point in the stream
          // and the reply to it starts a new turn.
          //
          // A `pending` note is the cooperative `check_user_feedback` pull
          // channel — the agent has not read it, and when it does it arrives
          // as a tool result, never a user message. Those stay in the notes
          // list above the composer, which is where a reload leaves them too.
          if (e.item.status !== "delivered") break
          flushStreamingQueue(contextKey)
          dispatch({
            type: "STEERING_MESSAGE",
            contextKey,
            id: e.item.id,
            text: e.item.text,
            createdAt: e.item.created_at,
            // Present only when the draft carried attachments. Widened through
            // the same mapping a `user_message` echo uses, so one message
            // renders identically whichever of the two routes it arrives by.
            blocks: e.item.blocks
              ? contentBlocksFromUserMessage(e.item.blocks)
              : null,
          })
          break
        }
        case "permission_resolved":
          // Backend signals a permission was answered (this window's local
          // respondPermission, a sibling window, a server-mode peer, or
          // chat-channel auto-approve). The local-respond path already
          // dispatched PERMISSION_CLEARED synchronously, so this is a no-op
          // there; the other three paths rely on this branch to retire the
          // dialog without waiting for TurnComplete. Matched by request_id so
          // a stale event can't wipe a fresh permission.
          dispatch({
            type: "PERMISSION_CLEARED",
            contextKey,
            requestId: e.request_id,
          })
          break
        case "permission_queue_depth":
          // A request queued up behind the visible card. Only the count on the
          // already-rendered card changes, so no streaming flush is needed.
          dispatch({
            type: "PERMISSION_QUEUE_DEPTH",
            contextKey,
            depth: e.depth,
          })
          break
        case "question_request":
          // Agent called the blocking `ask_user_question` MCP tool. Flush any
          // queued streaming so the card renders against current content, then
          // raise the interactive multiple-choice card above the input box.
          flushStreamingQueue(contextKey)
          dispatch({
            type: "SET_ASK_QUESTION",
            contextKey,
            pendingAskQuestion: {
              question_id: e.question_id,
              questions: e.questions,
              created_at: new Date().toISOString(),
            },
          })
          // A blocked agent is exactly what a notification is for, and this
          // was the one such state that never raised one — the sound path had
          // covered it since it shipped. Body names the agent only: the
          // question text is the agent's own prose.
          {
            const nc = quiet
              ? null
              : storeRef.current.connections.get(contextKey)
            if (nc) {
              const fn = folderNameRef.current
              void notifyDesktop("question_request", {
                title: fn ? `${fn} - Codeg` : "Codeg",
                body: t("notificationQuestion", {
                  agent: getAgentLabel(nc.agentType),
                }),
              })
            }
          }
          break
        case "question_resolved":
          // The question was answered (this or another window) or canceled.
          // Matched by question_id so a stale event can't wipe a fresh one.
          dispatch({
            type: "CLEAR_ASK_QUESTION",
            contextKey,
            questionId: e.question_id,
          })
          break
        case "plan_approval_request":
          // Grok called `exit_plan_mode`: it's blocked on the user's approval of
          // the plan. Flush queued streaming so the card renders against current
          // content, then raise the interactive plan-approval card.
          flushStreamingQueue(contextKey)
          dispatch({
            type: "SET_PLAN_APPROVAL",
            contextKey,
            pendingPlanApproval: {
              approval_id: e.approval_id,
              tool_call_id: e.tool_call_id,
              plan_markdown: e.plan_markdown,
              created_at: new Date().toISOString(),
            },
          })
          break
        case "plan_approval_resolved":
          // The approval was answered (this or another window) or canceled.
          // Matched by approval_id so a stale event can't wipe a fresh one.
          dispatch({
            type: "CLEAR_PLAN_APPROVAL",
            contextKey,
            approvalId: e.approval_id,
          })
          break
        case "background_activity": {
          // Out-of-turn transcript activity from the backend watcher: async
          // task completions, the agent's continued work after them, cron//
          // loop turns. Three consumers:
          // 1. the outstanding mirror, which gates the teardowns (nothing
          //    renders the count);
          dispatch({
            type: "SET_BACKGROUND_OUTSTANDING",
            contextKey,
            outstanding: e.outstanding,
          })
          // 2. overlay turns → the conversation runtime store (resolved via
          //    the external-id index; unresolved = this conversation was never
          //    opened in this client, and its cold detail fetch covers it);
          if (e.turns && e.turns.length > 0) {
            const conversationId = getConversationIdByExternalIdFromStore(
              e.session_id
            )
            if (conversationId != null) {
              const runtime = useConversationRuntimeStore.getState()
              runtime.actions.applyBackgroundActivity(
                conversationId,
                e.turns,
                e.watermark
              )
              // Self-healing bound: cron//loop turns never settle, so nothing
              // else would ever refetch — the overlay would grow for as long
              // as the tab stays open. Past the threshold, fold what's
              // accumulated into persisted turns (the watermark rule retires
              // covered entries). Guarded by the in-flight flag and a
              // per-conversation interval so a failing backend can't turn
              // this into a 1Hz fetch loop.
              const session = useConversationRuntimeStore
                .getState()
                .byConversationId.get(conversationId)
              const now = Date.now()
              const lastAt = overlayFoldRefetchAt.get(conversationId) ?? 0
              if (
                session &&
                session.backgroundTurns.length > OVERLAY_FOLD_THRESHOLD &&
                !session.detailLoading &&
                now - lastAt > OVERLAY_FOLD_MIN_INTERVAL_MS
              ) {
                overlayFoldRefetchAt.set(conversationId, now)
                const oc = storeRef.current.connections.get(contextKey)
                runtime.actions.refetchDetail(conversationId, {
                  preserveLive: oc?.status === "prompting",
                })
              }
            }
          }
          // 3. ONE OS notification for the whole batch (matches the permission
          //    notification's shape; the window-state gate and the user's
          //    per-event switch live inside `notifyDesktop`).
          //
          //    Deliberately not one per task: a fan-out of sub-agents settles
          //    together, and the loop this replaced turned that into N banners
          //    the user had to dismiss one by one. Only the single-task case
          //    still carries the agent's own summary — a count says everything
          //    a batch notification usefully can.
          if (e.settled && e.settled.length > 0) {
            if (!quiet) {
              const nc = storeRef.current.connections.get(contextKey)
              const agentLabel = nc ? getAgentLabel(nc.agentType) : "Agent"
              const fn = folderNameRef.current
              const title = fn ? `${fn} - Codeg` : "Codeg"
              const count = e.settled.length
              const many = tChat("backgroundTasks.notifySettledMany", {
                agent: agentLabel,
                count,
              })
              const single = e.settled[0]
              void notifyDesktop("background_task", {
                body:
                  count === 1
                    ? `${agentLabel}: ${
                        single.summary ??
                        tChat("backgroundTasks.settledFallback", {
                          status: single.status,
                        })
                      }`
                    : many,
                // A summary is the sub-agent's own prose; the count form names
                // nothing and is safe to reuse as the redacted body.
                redactedBody:
                  count === 1
                    ? tChat("backgroundTasks.notifySettledOne", {
                        agent: agentLabel,
                      })
                    : many,
                title,
              })
            }
            // 4. flip each async sub-agent's launch card to its terminal
            //    (completed + result) state IN-MEMORY, by rewriting the
            //    launching tool call's `[[codeg-background-task]]` marker from
            //    the settle payload's own `tool_use_id`/`status`/`result`. This
            //    deliberately replaces the `refetchDetail` this used to do: that
            //    refetch re-parsed the still-open transcript mid-#870-hold,
            //    double-rendering the held turn AND racing the file's last
            //    write. Entries with
            //    no `tool_use_id` (background shells) have no marker card and are
            //    skipped. The store queues a settlement whose launch turn hasn't
            //    promoted yet and applies it at COMPLETE_TURN.
            const conversationId = getConversationIdByExternalIdFromStore(
              e.session_id
            )
            if (conversationId != null) {
              const runtimeActions =
                useConversationRuntimeStore.getState().actions
              for (const settled of e.settled) {
                if (!settled.tool_use_id) continue
                runtimeActions.resolveBackgroundTask(conversationId, {
                  toolUseId: settled.tool_use_id,
                  taskId: settled.task_id,
                  status: settled.status,
                  summary: settled.summary ?? null,
                  result: settled.result ?? null,
                })
              }
            }
          }
          break
        }
        case "permission_request":
          flushStreamingQueue(contextKey)
          flushPendingToolCallUpdates()
          dispatch({
            type: "PERMISSION_REQUEST",
            contextKey,
            request_id: e.request_id,
            tool_call: e.tool_call,
            fallback_title: t("toolFallbackTitle"),
            fallback_kind: "tool",
            options: e.options,
            queued: e.queued,
          })
          // Send OS notification when permission approval is needed
          {
            const nc = quiet
              ? null
              : storeRef.current.connections.get(contextKey)
            if (nc) {
              const agentLabel = getAgentLabel(nc.agentType)
              const fn = folderNameRef.current
              const title = fn ? `${fn} - Codeg` : "Codeg"
              // No redacted variant: the body is a fixed localized string
              // plus the agent's name, and names nothing of the user's.
              void notifyDesktop("permission_request", {
                title,
                body: `${agentLabel}: ${tChat("permissionDialog.subtitle")}`,
              })
            }
          }
          break
        case "session_started":
          flushStreamingQueue(contextKey)
          dispatch({
            type: "SESSION_STARTED",
            contextKey,
            sessionId: e.session_id,
          })
          // The id that turns a later reconnect into a RESUME. It reaches us
          // only here, and only the store entry holds it — which is precisely
          // what a backend GC / idle sweep removes.
          rememberResolvedIdentity(contextKey, { sessionId: e.session_id })
          break
        case "native_session_title":
          // Title is applied on the conversation row by the lifecycle worker
          // and reaches the sidebar via `conversation://changed`. Do not flush
          // the streaming queue: this can arrive mid-turn.
          break
        case "transcript_rolled_over":
          // Backend re-points conversation.external_id after Claude `/clear`.
          // Sidebar converges via `conversation://changed`; do not reconnect.
          break
        case "conversation_linked":
          // Backend just bound (or reaffirmed) the connection's DB conversation
          // row. Phase 3a frontend pre-creates rows for new-tab sends so this
          // event is mostly a confirmation; we log it for visibility. Phase 3b
          // will use this to drive UI mapping when the frontend stops creating
          // rows itself.
          console.log("[acp-context] conversation_linked", {
            contextKey,
            connectionId: e.connection_id,
            conversationId: e.conversation_id,
            folderId: e.folder_id,
          })
          // Same reason as session_started: a reconnect needs the conversation
          // id to be able to attach as a viewer to a surviving owner.
          if (e.conversation_id > 0) {
            rememberResolvedIdentity(contextKey, {
              conversationId: e.conversation_id,
            })
          }
          break
        case "session_modes": {
          flushStreamingQueue(contextKey)
          // Preferences are applied on the backend during connect (see
          // `getSavedPrefsForConnect` + `acp_connect`), so `e.modes` already
          // carries the user's preferred `current_mode_id` — no client-side
          // override or sync-back needed.
          dispatch({
            type: "SESSION_MODES",
            contextKey,
            modes: e.modes,
          })
          const modeConn = storeRef.current.connections.get(contextKey)
          if (modeConn) {
            const entry = selectorsCache.get(modeConn.agentType) ?? {
              modes: null,
              configOptions: null,
            }
            entry.modes = e.modes
            selectorsCache.set(modeConn.agentType, entry)
          }
          break
        }
        case "session_config_options": {
          flushStreamingQueue(contextKey)
          // Same as `session_modes`: backend already merged saved prefs
          // into `current_value` before emitting.
          dispatch({
            type: "SESSION_CONFIG_OPTIONS",
            contextKey,
            configOptions: e.config_options,
          })
          const cfgConn = storeRef.current.connections.get(contextKey)
          if (cfgConn) {
            const entry = selectorsCache.get(cfgConn.agentType) ?? {
              modes: null,
              configOptions: null,
            }
            entry.configOptions = e.config_options
            selectorsCache.set(cfgConn.agentType, entry)
            // This is the only place a model's DISPLAY name and its id are seen
            // together. Transcripts record the id alone, so without capturing
            // the pair here an agent with opaque ids (qoder's `qfmodel`) can
            // never label its own history. The agent comes off the connection,
            // not off whatever is selected in the UI — the settings panels'
            // probe snapshots lag an agent switch by a debounce and would
            // file the labels under the wrong one.
            rememberModelLabels(cfgConn.agentType, e.config_options)
          }
          break
        }
        case "config_option_rejected": {
          // Arrives immediately before the `session_config_options` carrying the
          // value the agent actually adopted, so the notice and the selector
          // settle together.
          if (!quiet) {
            const rejectedConn = storeRef.current.connections.get(contextKey)
            reportConfigOptionVerdict(
              rejectedConn?.connectionId ?? contextKey,
              rejectedConn?.agentType,
              e
            )
          }
          break
        }
        case "session_config_stale": {
          flushStreamingQueue(contextKey)
          dispatch({
            type: "CONFIG_STALE_CHANGED",
            contextKey,
            stale: e.stale,
            kind: e.kind,
          })
          break
        }
        case "selectors_ready": {
          flushStreamingQueue(contextKey)
          dispatch({
            type: "SELECTORS_READY",
            contextKey,
          })
          // Cache for agent types that may not emit session_modes /
          // session_config_options at all (no selectors).
          const rdyConn = storeRef.current.connections.get(contextKey)
          if (rdyConn) {
            if (!selectorsCache.has(rdyConn.agentType)) {
              selectorsCache.set(rdyConn.agentType, {
                modes: rdyConn.modes,
                configOptions: rdyConn.configOptions,
              })
            }
            // Also covers the replay path, where the options were restored onto
            // the connection without a fresh `session_config_options` event.
            rememberModelLabels(rdyConn.agentType, rdyConn.configOptions)
          }
          break
        }
        case "prompt_capabilities":
          flushStreamingQueue(contextKey)
          dispatch({
            type: "PROMPT_CAPABILITIES",
            contextKey,
            promptCapabilities: e.prompt_capabilities,
          })
          break
        case "fork_supported":
          flushStreamingQueue(contextKey)
          dispatch({
            type: "FORK_SUPPORTED",
            contextKey,
            supported: e.supported,
          })
          break
        case "mode_changed":
          flushStreamingQueue(contextKey)
          dispatch({
            type: "MODE_CHANGED",
            contextKey,
            modeId: e.mode_id,
          })
          break
        case "plan_update":
          flushStreamingQueue(contextKey)
          dispatch({
            type: "PLAN_UPDATE",
            contextKey,
            entries: e.entries,
          })
          break
        case "session_failure": {
          // JetBrains AIR typed session failure upsert — merged monotonically
          // by id+revision (stale/replayed records are dropped in the
          // reducer); resolution is inferred at turn/prompt boundaries
          // (STATUS_CHANGED). How it is shown depends on what it is (see
          // `sessionFailureNotice`): a retry incident is progress, drawn live
          // under the composer by `SessionFailureBanner`; an advisory or a
          // terminal failure is news, told once as a notification.
          const failureConn = storeRef.current.connections.get(contextKey)
          const stored = failureConn?.sessionFailures.find(
            (f) => f.id === e.record.id
          )
          dispatch({
            type: "SESSION_FAILURE",
            contextKey,
            record: e.record,
          })
          if (quiet || !failureConn) break
          const noticeKind = sessionFailureNotice(stored, e.record)
          if (noticeKind === null) break
          const connKey = failureConn.connectionId
          // Adapter-authored English, shown verbatim like a notice's text —
          // first line as the headline, the rest (a passed-through upstream
          // body, the record's details) below it. A blank title falls back to
          // the localized category.
          const headline = splitHeadline(e.record.title, e.record.details)
          const title = t("noticeTitle", {
            agent: getAgentLabel(failureConn.agentType),
            title:
              headline?.title ??
              tFailure(sessionFailureCategoryLabelKey(e.record.category)),
          })
          const description = headline
            ? headline.description
            : e.record.details?.trim() || undefined
          if (noticeKind === "advisory") {
            notify({
              level: "warning",
              key: `acp-failure:${connKey}:${e.record.id}`,
              title,
              description,
            })
            break
          }
          notifyTurnFailure(connKey, {
            kind: "typed",
            recordId: e.record.id,
            title,
            description,
            // A viewer watches the session; recovering it is the owner's call.
            actions: failureConn.isViewer
              ? []
              : sessionFailureNotifyActions(
                  connKey,
                  failureConn.agentType,
                  e.record
                ),
          })
          break
        }
        case "session_notice": {
          // ACP Session Notice — fire-and-forget advisory text: a
          // notification (see `lib/notify`), never also a strip under the
          // composer, which used to put the same sentence on screen twice.
          // Nothing is stored — a notice has no lifecycle to track — and
          // notices that only restate a compaction are dropped: the
          // transcript's compaction card already says it (see
          // `lib/session-notices`).
          //
          // The text is adapter-authored English and is shown verbatim, the
          // same way `SessionFailureRecord.title` already is — localizing it
          // is not possible without re-authoring every adapter's vocabulary.
          // The agent's name leads the title, so a notice raised by a session
          // in another tab still says where it came from.
          if (quiet) break
          const nc = storeRef.current.connections.get(contextKey)
          const notice = presentSessionNotice(
            nc?.connectionId ?? contextKey,
            e.notice
          )
          if (!notice) break
          notify({
            level: notice.level,
            key: notice.id,
            title: nc
              ? t("noticeTitle", {
                  agent: getAgentLabel(nc.agentType),
                  title: notice.title,
                })
              : notice.title,
            description: notice.description,
          })
          break
        }
        case "async_task": {
          // JetBrains AIR async-task delta (claude only) — Claude's background
          // shells / workflows / monitors. Merged into the connection's task
          // table; the live rows render in `AsyncTaskStrip` under the composer.
          dispatch({
            type: "ASYNC_TASK",
            contextKey,
            delta: e.delta,
          })
          break
        }
        case "turn_retrying": {
          // codex-acp #289: a retryable turn error keeps the turn alive (codex
          // auto-retries). Reuse the Claude API-retry banner — codex doesn't
          // report attempt/limit/delay, so those stay null; the banner clears
          // as soon as streaming content resumes (`applyStreamingAction`).
          //
          // pi (#525) is the opposite shape: it reports all three counters and
          // NO error text, so its empty `message` normalizes to null rather than
          // painting the banner with a blank error slot. `?? null` (not `||`)
          // keeps a genuine attempt 0 / 0ms delay from collapsing to "unknown".
          //
          // Flush FIRST, like the Claude `claude_sdk_message` path: deltas are
          // queued and applied in batches, and applying one clears the banner.
          // Without this, a delta enqueued just BEFORE the retry arrived lands
          // just AFTER it and wipes the banner we are about to raise — which pi
          // reaches routinely, since it retries mid-stream between prose chunks.
          flushStreamingQueue(contextKey)
          const retryConn = storeRef.current.connections.get(contextKey)
          dispatch({
            type: "CLAUDE_API_RETRY",
            contextKey,
            retry: {
              sessionId: retryConn?.sessionId ?? "",
              attempt: e.attempt ?? null,
              maxRetries: e.max_retries ?? null,
              error: e.message || null,
              errorStatus: e.error_status ?? null,
              retryDelayMs: e.retry_delay_ms ?? null,
              reportsError: e.message.trim().length > 0,
            },
          })
          break
        }
        case "turn_complete": {
          flushStreamingQueue(contextKey)
          flushPendingToolCallUpdates()
          // AIR retry warnings settle only at a CLEAN turn end, mirroring the
          // backend's `apply_event`. A failed turn's terminal failure rides
          // the prompt response and was emitted as a `session_failure` event
          // just before this one (same-id higher-revision error escalation),
          // so settling here can no longer paint an unrecovered incident as
          // recovered; any other exit (cancelled/empty/refusal) keeps the
          // warnings active until the next prompt's settle-all.
          //
          // Incidents that recovered MID-turn are already gone (see
          // `settleRetryIncidentsOnProgress`); this boundary catches the ones
          // still in flight at the end, plus the category-"unknown" notices
          // that progress deliberately skips.
          if (e.stop_reason === "end_turn") {
            dispatch({
              type: "SETTLE_SESSION_FAILURES",
              contextKey,
              scope: "warnings",
            })
          }
          dispatch({
            type: "STATUS_CHANGED",
            contextKey,
            status: "connected",
          })
          // Detect pending question from tool calls in the completed turn
          const turnConn = storeRef.current.connections.get(contextKey)
          if (turnConn?.liveMessage) {
            const blocks = turnConn.liveMessage.content
            for (let i = blocks.length - 1; i >= 0; i--) {
              const block = blocks[i]
              if (block.type !== "tool_call") continue
              const normalized = inferLiveToolName({
                title: block.info.title,
                kind: block.info.kind,
                rawInput: block.info.raw_input,
                meta: block.info.meta,
              })
              if (normalized === "question") {
                const questionText = extractQuestionText(block.info.raw_input)
                if (questionText) {
                  dispatch({
                    type: "SET_PENDING_QUESTION",
                    contextKey,
                    pendingQuestion: {
                      tool_call_id: block.info.tool_call_id,
                      question: questionText,
                    },
                  })
                }
                break
              }
            }
          }
          // Send OS notification when the window state allows it — saying
          // how the turn actually ended. Every failed exit the backend
          // diagnoses has already sent its own `error` notification (the
          // error is raised just before this event), and "finished
          // responding" right behind it was only ever kept off screen by the
          // notifier's 400ms global gap; a cancelled turn is one the user
          // stopped, from this window. The one failure with no `error` event
          // is the adapters' disguised `end_turn` carrying a typed terminal
          // failure (landed just before this event) — that turn failed too.
          {
            const nc =
              quiet || e.stop_reason !== "end_turn"
                ? null
                : storeRef.current.connections.get(contextKey)
            if (nc) {
              const agentLabel = getAgentLabel(nc.agentType)
              const fn = folderNameRef.current
              const title = fn ? `${fn} - Codeg` : "Codeg"
              const failure = latestActiveTerminalFailure(nc.sessionFailures)
              if (failure) {
                void notifyDesktop("error", {
                  title,
                  body: t("notificationError", {
                    agent: agentLabel,
                    message:
                      failure.title.trim() ||
                      tChat("sessionFailure.category.unknown"),
                  }),
                  redactedBody: t("notificationErrorRedacted", {
                    agent: agentLabel,
                  }),
                })
              } else {
                void notifyDesktop("turn_complete", {
                  title,
                  body: t("notificationTurnComplete", { agent: agentLabel }),
                })
              }
            }
          }
          break
        }
        case "error": {
          flushStreamingQueue(contextKey)
          const nc = storeRef.current.connections.get(contextKey)
          const agentLabel = nc
            ? getAgentLabel(nc.agentType)
            : (e.agent_type as string)
          const { route, text, reason, evidence } = presentBackendError(
            e.code,
            e.message,
            e.details,
            agentLabel
          )

          // Already shown by a transcript card (a failed compaction): the
          // event exists for the chat-channel bridges and the pet, not for us.
          if (route.kind === "transcript") break

          if (route.kind === "session") {
            // The session's state went wrong, so this is also its current
            // error until the next prompt (the connection-status popover) —
            // always the one localized line.
            dispatch({
              type: "ERROR",
              contextKey,
              message: text,
              level: route.level,
            })
          }
          // OS notification: only for a session that broke, and message-only —
          // notification centers persist their payload outside the app, so
          // agent output must not be forwarded there. The message can still
          // quote agent stderr for codes we don't recognize, which is what the
          // redacted variant drops.
          if (nc && !quiet && acpErrorNotifiesDesktop(route)) {
            const fn = folderNameRef.current
            const title = fn ? `${fn} - Codeg` : "Codeg"
            void notifyDesktop("error", {
              title,
              body: t("notificationError", {
                agent: agentLabel,
                message: text,
              }),
              redactedBody: t("notificationErrorRedacted", {
                agent: agentLabel,
              }),
            })
          }
          if (quiet) break
          const connKey = nc?.connectionId ?? contextKey
          if (isTurnFailureCode(e.code)) {
            // The same failed turn the adapter may also report as a typed
            // record — told once, together (see `notifyTurnFailure`).
            notifyTurnFailure(connKey, {
              kind: "verdict",
              title: text,
              evidence,
            })
            break
          }
          notify({
            level: route.level,
            // One per connection and code: the same refusal twice in a row, or
            // a second surface on the connection, refreshes it instead.
            key: `acp-error:${connKey}:${e.code || e.message}`,
            title: text,
            description: reason,
            evidence,
          })
          break
        }
        case "session_load_failed": {
          flushStreamingQueue(contextKey)
          // Localize via the stable `code` field ("resource_not_found" —
          // JSON-RPC -32002 — plus "session_unavailable" and
          // "session_archived", both matched on the wire message). Fall back
          // to the raw agent message so an unknown future code still surfaces
          // something intelligible rather than getting swallowed.
          const nc = storeRef.current.connections.get(contextKey)
          const agentLabel = nc ? getAgentLabel(nc.agentType) : ""
          // The one command that undoes `codex archive`, or null when there is
          // nothing runnable to offer. Derived once, outside the message, so
          // the banner can hand the user the exact string to paste instead of
          // relying on them transcribing a UUID out of prose that a one-line
          // strip may well have ellipsed away.
          //
          // The id comes off the event, not the raw RPC body: `session_id` IS
          // the session the load just failed for, so it is exact by
          // construction, while the body only spells it out by convention and
          // re-parsing it would drift the moment codex rewords the error.
          //
          // The classification is matched on the wire message, so it is not
          // codex-exclusive by construction. Only name the codex command when
          // codex is actually the agent — telling anyone else to run it would
          // be worse than saying nothing. They fall back to the agent's own
          // text, which already carries whatever recovery it wants to offer.
          //
          // The id is also shape-checked before it goes into the string. This
          // is a command we are inviting the user to paste into a shell, so it
          // must not be able to carry anything but a session id — a `session_id`
          // holding a space and a second word would become a second command.
          // Codex rollout ids are UUIDs; anything else falls back to the raw
          // message rather than composing a line we can't vouch for.
          const recoveryCommand =
            e.code === "session_archived" &&
            nc?.agentType === "codex" &&
            SESSION_UUID.test(e.session_id)
              ? `codex unarchive ${e.session_id}`
              : null
          const localizedMessage = (() => {
            switch (e.code) {
              case "resource_not_found":
                return t("backendErrors.sessionLoadResourceNotFound", {
                  agent: agentLabel,
                })
              case "session_unavailable":
                return t("backendErrors.sessionLoadUnavailable", {
                  agent: agentLabel,
                })
              // Unlike its neighbours this one is temporary and self-clearing,
              // so the message says what holds the session rather than what
              // went wrong: the fork took the lock, closing it gives it back.
              case "session_busy":
                return t("backendErrors.sessionLoadBusy", {
                  agent: agentLabel,
                })
              case "session_archived":
                return recoveryCommand
                  ? t("backendErrors.sessionArchived", {
                      agent: agentLabel,
                      command: recoveryCommand,
                    })
                  : e.message
              default:
                return e.message
            }
          })()
          dispatch({
            type: "ACP_LOAD_ERROR",
            contextKey,
            message: localizedMessage,
            command: recoveryCommand,
          })
          break
        }
        case "available_commands":
          flushStreamingQueue(contextKey)
          dispatch({
            type: "AVAILABLE_COMMANDS",
            contextKey,
            commands: e.commands,
          })
          break
        case "usage_update":
          flushStreamingQueue(contextKey)
          dispatch({
            type: "USAGE_UPDATE",
            contextKey,
            usage: {
              used: e.used,
              size: e.size,
            },
          })
          break
      }
    },
    [
      dispatch,
      enqueueStreamingAction,
      flushPendingToolCallUpdates,
      flushStreamingQueue,
      notifyTurnFailure,
      rememberResolvedIdentity,
      reportConfigOptionVerdict,
      scheduleToolCallUpdateFlush,
      presentBackendError,
      retireTurnFailures,
      sessionFailureNotifyActions,
      settleRetryIncidentsOnProgress,
      t,
      tChat,
      tFailure,
    ]
  )

  // Latest-ref for the event handler, so nothing downstream has to depend on
  // `handleMappedEvent`'s identity. It closes over the i18n `t` / `tChat`,
  // which are only stable while the locale is unchanged — a language switch
  // (or any future unstable dep added to the callback) would otherwise churn
  // both the global `acp://event` subscription below and every
  // `setupAttachSubscription` consumer that hangs off `applyMappedEnvelope`.
  // Tauri's `listen` / `unlisten` are both async IPC, so re-running that
  // effect briefly leaves two listeners registered and every envelope is
  // delivered twice. Duplicate delivery is already idempotent — the
  // `lastAppliedSeq` guard below runs before the synchronous `EVENT_APPLIED`
  // dispatch — but the subscription should simply never churn in the first
  // place. See the mount-once regression test.
  const handleMappedEventRef = useRef(handleMappedEvent)
  // Re-sync each render so the latest closure is used at fire time.
  useEffect(() => {
    handleMappedEventRef.current = handleMappedEvent
  })

  // Apply a single envelope to the store. Shared by the legacy global
  // listener and the attach-protocol per-subscription handlers so dedup +
  // dispatch ordering + JS subscriber fan-out stays identical between
  // the two paths.
  const applyMappedEnvelope = useCallback(
    (contextKey: string, envelope: EventEnvelope) => {
      const conn = storeRef.current.connections.get(contextKey)
      if (conn && envelope.seq <= conn.lastAppliedSeq) return
      lastActivityRef.current.set(contextKey, Date.now())
      handleMappedEventRef.current(contextKey, envelope)
      dispatch({ type: "EVENT_APPLIED", contextKey, seq: envelope.seq })
      for (const ref of eventSubscribersRef.current) {
        try {
          ref.current(envelope)
        } catch (err) {
          console.error("[acp-context] subscriber threw:", err)
        }
      }
    },
    [dispatch]
  )

  // Re-seed `DelegationProvider` bindings from a snapshot's active_delegations.
  // `delegation_started` / `delegation_completed` are transient — they mutate
  // no SessionState field, so they are NOT in `to_snapshot()` and (on the
  // snapshot attach path) are never replayed. Without this, a web/server client
  // that cold-attaches, re-attaches after a broadcast lag, or refreshes
  // mid-delegation never establishes the live binding: the card shows a
  // premature "completed" and no "查看会话" until the child finally finishes.
  // We synthesize the same envelopes the broker emits live and fan them ONLY to
  // the JS event subscribers (DelegationProvider), bypassing applyMappedEnvelope
  // so we neither run the store reducer (which has no case for these) nor touch
  // `lastAppliedSeq` / trip the seq-dedup. Idempotent with any live/replayed
  // event for the same `parent_tool_use_id` (DelegationProvider overwrites the
  // binding and `attachDelegationChild` early-returns when already attached).
  const seedDelegationsFromSnapshot = useCallback(
    (
      connectionId: string,
      activeDelegations: ActiveDelegationState[],
      eventSeq: number
    ) => {
      const envelopes = buildDelegationSeedEnvelopes(
        connectionId,
        activeDelegations,
        eventSeq
      )
      for (const envelope of envelopes) {
        for (const ref of eventSubscribersRef.current) {
          try {
            ref.current(envelope)
          } catch (err) {
            console.error(
              "[acp-context] delegation seed subscriber threw:",
              err
            )
          }
        }
      }
    },
    []
  )

  // Present a snapshot's `last_error` the way the live `error` event would
  // have been presented, before the patch hydrates the store.
  //
  // The wire carries the backend's raw English message plus its stable code;
  // hydrating that as-is made a refreshed browser (or a second client, or a
  // cold attach mid-session) show a different, untranslated sentence than the
  // client that watched the error happen. And only a `session`-kind error is
  // session state at all: an action verdict or a transcript card, replayed as
  // the session's standing error, would invent a problem.
  //
  // Held in a ref: the attach/hydrate callbacks below are deliberately
  // identity-stable (an empty dep array keeps a re-render from tearing down
  // and re-establishing live subscriptions), so they must not close over a
  // `t`-dependent callback directly.
  const presentSnapshotPatch = useCallback(
    (contextKey: string, patch: SnapshotPatch): SnapshotPatch => {
      if (patch.lastError === null) return patch
      const route = routeAcpError(patch.lastErrorCode)
      const conn = storeRef.current.connections.get(contextKey)
      if (route.kind !== "session") {
        // Never session state when it happened. The backend keeps only its
        // LATEST error, so this says nothing about a session error from before
        // it — keep whatever this client still holds (a fresh client simply
        // holds nothing).
        return {
          ...patch,
          lastError: conn?.error ?? null,
          lastErrorLevel: conn?.errorLevel ?? "error",
        }
      }
      const { text } = presentBackendError(
        patch.lastErrorCode,
        patch.lastError,
        null,
        conn ? getAgentLabel(conn.agentType) : ""
      )
      return { ...patch, lastError: text, lastErrorLevel: route.level }
    },
    [presentBackendError]
  )
  const presentSnapshotPatchRef = useRef(presentSnapshotPatch)
  useEffect(() => {
    presentSnapshotPatchRef.current = presentSnapshotPatch
  }, [presentSnapshotPatch])

  // Open a Subscribe-with-Snapshot stream for `connectionId` and route its
  // frames into the store under `contextKey`. Returns the subscription
  // handle for cleanup, or `null` when the active transport doesn't
  // implement the attach protocol (caller falls back to the legacy
  // snapshot-fetch + global-listener flow).
  //
  // The subscription survives WS reconnects automatically — see
  // `WebEventStream.reattachAll`. Detach reasons are handled here:
  //   - lagged / server_shutdown: re-attach with current cursor so the
  //     consumer doesn't have to think about transient disconnects
  //   - connection_gone: terminal; clean up store entry and let the next
  //     user interaction surface the failure
  const setupAttachSubscription = useCallback(
    (
      contextKey: string,
      connectionId: string,
      sinceSeq: number | undefined
    ): EventStreamSubscription | null => {
      const stream = getEventStream()
      if (!stream) return null

      let activeSub: EventStreamSubscription | null = null
      const handlers: AttachHandlers = {
        onSnapshot: (snapshot) => {
          // Land anything still coalescing BEFORE the snapshot replaces the
          // live message. This handler also runs on an attach-stream
          // RECONNECT, mid-turn, so deltas from before the drop can still be
          // queued — and the hydrate would swap `liveMessage` out from under
          // them, so the flush that follows would append a run the snapshot
          // already contains, duplicating it on screen.
          //
          // Flush, not discard: `HYDRATE_FROM_SNAPSHOT` has a stale-snapshot
          // branch that merges selector fields only and leaves `liveMessage`
          // untouched, so discarding would silently drop prose nothing else
          // redelivers. Flushing is what the queue's contract asks for anyway
          // — every path that reads or replaces `liveMessage` from outside
          // should see the same state it would have seen with no coalescing
          // at all.
          //
          // The other three snapshot consumers don't need this: they hydrate
          // at attach time, before `bindConnectionRoute` gives the key a
          // route, so no delta of theirs can be in flight yet — and a queue
          // left by a PREVIOUS connection under a recycled key is discarded
          // at `CONNECTION_REMOVED` (see `dispatch`), which is the right
          // outcome there, not a flush.
          flushStreamingQueue(contextKey)
          const patch = presentSnapshotPatchRef.current(
            contextKey,
            denormalizeSnapshot(snapshot)
          )
          dispatch({ type: "HYDRATE_FROM_SNAPSHOT", contextKey, patch })
          lastActivityRef.current.set(contextKey, Date.now())
          // Recover delegation bindings the snapshot carries but the transient
          // events don't (the load-bearing fix for the web-only "running shows
          // completed / no 查看会话" bug). Uses the snapshot's own connection_id
          // as the parent id.
          seedDelegationsFromSnapshot(
            patch.connectionId,
            patch.activeDelegations,
            patch.eventSeq
          )
        },
        onReplay: (events) => {
          // Catching up on a gap (reconnect / lagged detach) re-delivers events
          // that already happened. They belong in the UI, but replaying them
          // must not fire a burst of cues for turns that finished minutes ago.
          // Doubly true of OS notifications, which unlike a tone stay in the
          // notification centre until the user clears them by hand — and of
          // toasts, which would re-announce every notice of the gap at once.
          envelopeEffectsMutedRef.current += 1
          try {
            withEventSoundsSuppressed(() =>
              withDesktopNotificationsSuppressed(() => {
                for (const envelope of events) {
                  applyMappedEnvelope(contextKey, envelope)
                }
              })
            )
          } finally {
            envelopeEffectsMutedRef.current -= 1
          }
        },
        onEvent: (envelope) => {
          applyMappedEnvelope(contextKey, envelope)
        },
        onDetached: (reason) => {
          if (reason === "lagged" || reason === "server_shutdown") {
            // Transient: re-attach with the latest cursor so we either
            // replay the gap (small) or hydrate fresh (large). For
            // server_shutdown the WS is closed, so the new attach frame
            // queues until reconnect; for lagged the WS is still open.
            const conn = storeRef.current.connections.get(contextKey)
            const newSinceSeq = conn?.lastAppliedSeq
            const newSub = stream.attach(
              connectionId,
              { sinceSeq: newSinceSeq },
              handlers
            )
            activeSub = newSub
            attachSubscriptionsRef.current.set(contextKey, newSub)
            return
          }
          // connection_gone: backend GC'd the connection. Mirror to UI
          // so the user sees the conversation tab go away rather than
          // staring at stale state forever.
          attachSubscriptionsRef.current.delete(contextKey)
          // The composer that survives this is exactly the one whose Reconnect
          // button has to resume the session rather than start a new one.
          captureIdentityBeforeRemoval(contextKey)
          dispatch({ type: "CONNECTION_REMOVED", contextKey })
        },
      }

      activeSub = stream.attach(connectionId, { sinceSeq }, handlers)
      attachSubscriptionsRef.current.set(contextKey, activeSub)
      return activeSub
    },
    [
      applyMappedEnvelope,
      captureIdentityBeforeRemoval,
      dispatch,
      flushStreamingQueue,
      seedDelegationsFromSnapshot,
    ]
  )

  // Tear down an attach subscription: detach the WS subscription so the
  // server-side forwarder task exits, and clear the local handle.
  // Idempotent — safe to call from disconnect, idle sweep, REKEY, and
  // REMOVE_ALL paths without checking whether a sub exists. No-op for
  // legacy (Tauri) connections that never went through
  // `setupAttachSubscription`.
  const teardownAttachSubscription = useCallback((contextKey: string) => {
    const sub = attachSubscriptionsRef.current.get(contextKey)
    if (!sub) return
    attachSubscriptionsRef.current.delete(contextKey)
    try {
      sub.detach()
    } catch (err) {
      console.warn("[acp-context] attach detach threw:", err)
    }
  }, [])

  // Single global event listener
  useEffect(() => {
    let cancelled = false
    let unlisten: (() => void) | null = null

    // Web / remote-desktop transports: the backend no longer fans ACP
    // events through the WS firehose (Phase 5 dropped the `acp://event`
    // channel; per-connection attach streams are the sole delivery path).
    // Skip the legacy listener entirely — keeping it would register a
    // dead WebSocket subscription and waste a slot on every reconnect.
    // `waitForListenerReady` becomes an immediate no-op since the path
    // it was guarding (Tauri's app.emit handshake) doesn't exist here.
    if (getEventStream() !== null) {
      listenerReadyRef.current = true
      resolveListenerReadyWaiters()
      return
    }

    listenerReadyRef.current = false

    subscribe<EventEnvelope>("acp://event", (envelope) => {
      // Tauri webview path: the desktop frontend receives ACP events here
      // via `app.emit("acp://event", ...)`. Web / remote-desktop transports
      // skipped this useEffect above and route ACP events solely via the
      // per-connection attach streams.
      const routes = reverseMapRef.current.get(envelope.connection_id)
      if (!routes || routes.size === 0) {
        bufferUnmappedEvent(envelope)
        return
      }

      // Deliver to EVERY surface routing this connection (see
      // `reverseMapRef`). Iterated over a copy: a handler may bind or release
      // a route re-entrantly, and mutating the live Set mid-iteration would
      // skip or double-deliver. Each surface keeps its own `lastAppliedSeq`,
      // so they dedup independently.
      let deliveredToAny = false
      for (const contextKey of Array.from(routes)) {
        // Seq dedup: skip envelopes already accounted for by a snapshot or a
        // prior delivery. snapshot.event_seq sets the lower bound; subsequent
        // envelopes with seq <= lastAppliedSeq are no-op duplicates.
        const conn = storeRef.current.connections.get(contextKey)
        if (conn && envelope.seq <= conn.lastAppliedSeq) {
          continue
        }
        // Touch activity on every incoming event
        lastActivityRef.current.set(contextKey, Date.now())
        // `deliveredToAny` doubles as "some surface already ran this
        // envelope's user-facing effects", so the sound / OS notification /
        // alert fire once no matter how many surfaces are watching.
        handleMappedEventRef.current(contextKey, envelope, deliveredToAny)
        deliveredToAny = true

        // Advance lastAppliedSeq after the event's effects have dispatched.
        // EVENT_APPLIED is idempotent (only advances if higher).
        dispatch({
          type: "EVENT_APPLIED",
          contextKey,
          seq: envelope.seq,
        })
      }

      // Fan out to JS-level subscribers (e.g. ConversationDetailPanel's
      // background turn_complete handler). Runs AFTER the reducer dispatches
      // and AFTER seq dedup, so subscribers see a consistent, deduped stream.
      // Unmapped events return early above and never reach here. Fired ONCE
      // per envelope no matter how many surfaces routed it — these subscribers
      // are keyed by connection, not by contextKey, and double-delivery would
      // e.g. re-register a delegation binding. One bad subscriber must not kill
      // the others — wrap each call in try/catch.
      if (!deliveredToAny) return
      for (const ref of eventSubscribersRef.current) {
        try {
          ref.current(envelope)
        } catch (err) {
          console.error("[acp-context] subscriber threw:", err)
        }
      }
    })
      .then((fn) => {
        if (cancelled) {
          fn()
        } else {
          unlisten = fn
          listenerReadyRef.current = true
          resolveListenerReadyWaiters()
        }
      })
      .catch(() => {
        listenerReadyRef.current = true
        resolveListenerReadyWaiters()
      })

    return () => {
      cancelled = true
      listenerReadyRef.current = false
      resolveListenerReadyWaiters()
      unlisten?.()
    }
    // Every dep here is stable for the component's life — each is either a
    // `useCallback(..., [])` or, in `dispatch`'s case, a `useCallback` whose
    // own deps are all `useCallback(..., [])` — so the subscription is
    // registered once per mount and torn down only on unmount. The event
    // handler deliberately isn't a dep; it's reached through
    // `handleMappedEventRef` so a changing closure can't churn the listener.
  }, [bufferUnmappedEvent, dispatch, resolveListenerReadyWaiters])

  // Drop every armed window on unmount. Its own effect, because the listener
  // effect above returns early on web / remote-desktop transports — before it
  // registers any cleanup — and those transports stream through the attach
  // subscriptions, which fill these queues just the same. A timer surviving
  // the provider fires into a `dispatch` whose store nothing is reading, and
  // under a test runner it outlives the test that armed it.
  useEffect(() => discardStreamingQueues, [discardStreamingQueues])

  /**
   * Ask the backend whether it still holds a live connection under this id.
   * `acp_touch_connection` answers `false` for BOTH "unknown id" and "already
   * terminal", which is exactly the question. A transport failure is
   * inconclusive, so it counts as alive — a flaky IPC must never settle a
   * healthy streaming session.
   */
  const isConnectionLiveOnBackend = useCallback(
    async (connectionId: string): Promise<boolean> => {
      try {
        return await acpTouchConnection(connectionId)
      } catch {
        return true
      }
    },
    []
  )

  /**
   * Settle a ConnectionState whose backend connection is gone but whose
   * terminal event never arrived.
   *
   * Without this the entry is IMMORTAL: `prompting` / `connecting` are skipped
   * by the idle sweep and (previously) by the keepalive touch, `connect()` and
   * `handleFocus` only act on `disconnected`/`error`, and `cancel()` swallows
   * the backend's "connection not found" — so the tab shows "responding" with a
   * dead Stop button until the app restarts. Flipping to `disconnected` (rather
   * than dropping the entry) keeps the agent/session identity around, so the
   * composer's Reconnect and the next `connect()` resume this session instead
   * of starting a new one.
   *
   * No-op unless the entry still points at THIS connection, so a settle racing
   * a re-spawn can't knock out the replacement.
   */
  const markConnectionGone = useCallback(
    (contextKey: string, connectionId: string): boolean => {
      const conn = storeRef.current.connections.get(contextKey)
      if (!conn || conn.connectionId !== connectionId) return false
      if (conn.status === "disconnected" || conn.status === "error")
        return false
      releaseConnectionRoute(connectionId, contextKey)
      teardownAttachSubscription(contextKey)
      pendingUnmappedEventsRef.current.delete(connectionId)
      // Land what is still coalescing while the turn is still `prompting`.
      // The status change below is dispatched directly rather than through the
      // event handler, so nothing else drains the queue — and once the entry
      // reads `disconnected` the out-of-turn guard drops the batch, taking the
      // last words this connection managed to say with it. Worth a line
      // because the window is no longer a frame: `streamFlushDelayMs` can be
      // holding up to STREAM_FLUSH_MAX_MS of a live reply when the liveness
      // probe settles a connection out from under it.
      flushStreamingQueue(contextKey)
      dispatch({ type: "STATUS_CHANGED", contextKey, status: "disconnected" })
      return true
    },
    [
      dispatch,
      flushStreamingQueue,
      releaseConnectionRoute,
      teardownAttachSubscription,
    ]
  )

  // ── Backend keepalive + liveness reconciliation timer ──
  // Frontend is the only side that knows which conversation tabs the
  // user has open. Without this, the backend's idle sweep
  // (CODEG_ACP_IDLE_TIMEOUT_SECS, default 180s) would reap connections
  // backing visible tabs whenever the user was just reading without
  // sending — forcing them to re-spawn the agent on next message.
  // Touching only bumps last_activity_at; it does not emit any event.
  //
  // The touch doubles as a liveness probe, and every non-terminal state is
  // probed — not just `connected`. A `prompting` entry whose terminal event
  // went missing is otherwise unreachable: no sweep re-checks it and
  // `connect()` treats it as already connected, so the tab sits on
  // "responding" with a dead Stop button. `false` means the backend has no
  // live connection under that id, which is exactly the condition to settle.
  useEffect(() => {
    const timer = setInterval(() => {
      const currentActiveKey = storeRef.current.activeKey
      const currentOpenTabKeys = heldOpenKeys()
      const seen = new Set<string>()
      const toTouch: { contextKey: string; connectionId: string }[] = []
      const consider = (contextKey: string) => {
        if (seen.has(contextKey)) return
        seen.add(contextKey)
        const conn = storeRef.current.connections.get(contextKey)
        if (!conn) return
        if (conn.status === "disconnected" || conn.status === "error") return
        // Broker-owned children come and go on the parent's schedule and are
        // released by `detachDelegationChild`; settling one here would fight
        // that lifecycle.
        if (conn.isDelegationChild) return
        toTouch.push({ contextKey, connectionId: conn.connectionId })
      }
      if (currentActiveKey) consider(currentActiveKey)
      for (const contextKey of currentOpenTabKeys) consider(contextKey)
      for (const { contextKey, connectionId } of toTouch) {
        void isConnectionLiveOnBackend(connectionId).then((live) => {
          if (!live) markConnectionGone(contextKey, connectionId)
        })
      }
    }, CONNECTION_KEEPALIVE_INTERVAL_MS)

    return () => clearInterval(timer)
  }, [heldOpenKeys, isConnectionLiveOnBackend, markConnectionGone])

  // ── Idle sweep timer ──
  // Complements the backend keepalive: this sweep targets connections
  // that are NOT in `openTabKeys ∪ {activeKey}` — i.e. connections the
  // frontend opened but is no longer surfacing to the user (panel
  // dismissed, navigated away). The backend's own idle sweep would
  // reap them on its 60s cadence regardless; doing it here too keeps
  // the React store free of stale entries and triggers an explicit
  // disconnect rather than waiting for the backend's own timeout.
  // Connections backing currently-open tabs are never reaped here —
  // those are kept alive by the keepalive loop above.
  useEffect(() => {
    const timer = setInterval(() => {
      const now = Date.now()
      const currentActiveKey = storeRef.current.activeKey

      const currentOpenTabKeys = heldOpenKeys()
      const toDisconnect: { contextKey: string; connectionId: string }[] = []
      for (const [contextKey, conn] of storeRef.current.connections) {
        if (contextKey === currentActiveKey) continue
        if (currentOpenTabKeys.has(contextKey)) continue
        if (conn.status === "prompting" || conn.status === "connecting") {
          continue
        }
        if (conn.status !== "connected") continue
        // Delegation children are owned by the broker — the
        // delegation_completed event is the only signal that should
        // tear them down (via detachDelegationChild). The idle sweep
        // would otherwise call acpDisconnect on a backend connection
        // still mid-prompt for the parent's tool_use.
        if (conn.isDelegationChild) continue
        // Viewers don't own their backend connection — acpDisconnect here
        // would kill another client's agent. The viewer is torn down when its
        // tab unmounts (disconnect's isViewer branch detaches it).
        if (conn.isViewer) continue
        // Launched-but-unresolved background work (async sub-agent /
        // background shell): disconnecting would kill the agent CLI and the
        // background task with it. The backend watcher settles or max-age
        // expires the accounting and emits `outstanding: 0`, which re-arms
        // this sweep for the connection.
        if (conn.backgroundOutstanding > 0) continue
        // The AIR channel's half of the same rule. The watcher above only sees
        // background work that leaves a transcript trace; a workflow or monitor
        // task announces itself here and nowhere else, so without this check a
        // quiet interval would disconnect the connection and kill a task the
        // strip is actively showing as running. Mirrors the backend's
        // `has_active_background_work`, which ORs the two the same way.
        if (liveAsyncTasks(conn.asyncTasks).length > 0) continue
        const lastActive = lastActivityRef.current.get(contextKey) ?? 0
        if (now - lastActive > CONNECTION_IDLE_TIMEOUT_MS) {
          toDisconnect.push({
            contextKey,
            connectionId: conn.connectionId,
          })
        }
      }

      for (const { contextKey, connectionId } of toDisconnect) {
        acpDisconnect(connectionId).catch(() => {})
        releaseConnectionRoute(connectionId, contextKey)
        teardownAttachSubscription(contextKey)
        lastActivityRef.current.delete(contextKey)
        pendingUnmappedEventsRef.current.delete(connectionId)
        // Reclaimed for idleness, not closed: the tab is still open and its
        // Reconnect button must resume this session, not start a new one.
        captureIdentityBeforeRemoval(contextKey)
        dispatch({ type: "CONNECTION_REMOVED", contextKey })
      }
    }, IDLE_SWEEP_INTERVAL_MS)

    return () => clearInterval(timer)
  }, [
    captureIdentityBeforeRemoval,
    dispatch,
    heldOpenKeys,
    releaseConnectionRoute,
    teardownAttachSubscription,
  ])

  // Disconnect all on unmount
  useEffect(() => {
    const reverseMap = reverseMapRef.current
    const attachSubs = attachSubscriptionsRef.current
    // Capture the store ref at effect-setup time so the cleanup
    // function doesn't read a moving target (`storeRef.current` is the
    // same object across renders by design, but the lint rule
    // `react-hooks/exhaustive-deps` flags reading it inside cleanup
    // because in the general case a ref's `.current` can be replaced).
    const store = storeRef.current
    return () => {
      // A connection can be routed by several surfaces (see `reverseMapRef`);
      // tear it down at most once, and only if at least one of them OWNS it.
      const alreadyTornDown = new Set<string>()
      for (const [connectionId, contextKeys] of reverseMap) {
        for (const contextKey of contextKeys) {
          // Delegation-child entries are not real user-facing
          // connections — the broker owns their backend lifecycle and
          // will tear them down when the parent's delegation resolves.
          // Calling acpDisconnect on them here would race the broker's
          // own one-shot teardown and emit a benign-but-noisy "unknown
          // connection" error from the backend.
          const conn = store.connections.get(contextKey)
          if (conn?.isDelegationChild) continue
          // Viewers attach to a connection another client owns — never
          // acpDisconnect it on our unmount. The attach-sub detach loop below
          // releases our read-only subscription cleanly.
          if (conn?.isViewer) continue
          if (alreadyTornDown.has(connectionId)) continue
          alreadyTornDown.add(connectionId)
          acpDisconnect(connectionId).catch(() => {})
        }
      }
      for (const [, sub] of attachSubs) {
        try {
          sub.detach()
        } catch {
          // best-effort during teardown
        }
      }
    }
  }, [])

  // The contextKey of the local entry that OWNS the given backend connection —
  // i.e. the one whose teardown `acpDisconnect`s the agent — or null when this
  // client doesn't own it.
  //
  // Non-owning entries (viewers, delegation children — the work-task transcript
  // dialog attaches the task's OWN connection that way) are deliberately NOT
  // ownership. Counting them inverted the guard: with the transcript viewer
  // open, a tab opening the same conversation was refused the viewer path,
  // fell through to `acpConnect`, got the SAME backend connection back by
  // reuse, and registered itself as its owner — so closing that tab killed the
  // running task's agent.
  //
  // NOT the predicate for "may I tear this connection down?" — see
  // `isConnectionReferencedLocally`.
  const localOwnerKeyOf = useCallback((connectionId: string) => {
    for (const [key, conn] of storeRef.current.connections) {
      if (conn.connectionId !== connectionId) continue
      if (conn.isViewer || conn.isDelegationChild) continue
      return key
    }
    return null
  }, [])

  // True when ANY local surface references the connection — owner, viewer,
  // delegation child, or a bare firehose route. This is the teardown guard: an
  // abandoned/superseded `connect()` must only `acpDisconnect` a connection it
  // actually created, and the backend dedups by (agent, cwd, session), so
  // `acpConnect` can hand back one that is already on screen somewhere. A
  // transcript viewer counts here even though it does not count as OWNERSHIP:
  // it does not license a teardown, but it does prove someone is watching, and
  // disconnecting would kill the agent out from under them.
  const isConnectionReferencedLocally = useCallback((connectionId: string) => {
    if (reverseMapRef.current.has(connectionId)) return true
    for (const conn of storeRef.current.connections.values()) {
      if (conn.connectionId === connectionId) return true
    }
    return false
  }, [])

  // Attach this client to a backend connection ANOTHER client owns
  // (cross-client live streaming). The viewer is a NON-OWNING, co-controlling
  // client: it streams the same turn and may also drive the shared agent
  // (sendPrompt/cancel go to the owner's connection, serialized server-side by
  // its prompt_lock; turn-level concurrency rejection is tracked as a
  // follow-up). The one hard invariant: a viewer's teardown DETACHES, never
  // `acpDisconnect`s — that would kill the owner's agent. Generalizes
  // `attachDelegationChild`: Subscribe-with-Snapshot attach on web, snapshot-
  // hydrate + firehose reverse-map on desktop.
  //
  // ALWAYS a COLD attach (no `sinceSeq`): the viewer has applied no prior
  // events, so it must receive a full snapshot of the in-flight turn — passing
  // the discovered `event_seq` as a cursor could yield only a post-cursor
  // replay and miss all earlier live state. Reconnects re-attach with the
  // running `lastAppliedSeq` (see `setupAttachSubscription.onDetached`).
  //
  // Returns `false` when the connection turned out to be already gone, so the
  // caller can fall through and spawn/own one instead of leaving a viewer
  // attached to nothing.
  const connectAsViewer = useCallback(
    async (
      contextKey: string,
      connectionId: string,
      agentType: AgentType,
      workingDir: string | null
    ): Promise<boolean> => {
      dispatch({
        type: "CONNECTION_CREATED",
        contextKey,
        connectionId,
        agentType,
        workingDir,
        isViewer: true,
      })
      lastActivityRef.current.set(contextKey, Date.now())

      const stream = getEventStream()
      if (stream) {
        // Web / remote: the per-connection WS attach delivers snapshot +
        // replay + live events atomically over the same socket.
        setupAttachSubscription(contextKey, connectionId, undefined)
        return true
      }

      // Desktop firehose: the global `acp://event` stream only carries FUTURE
      // events, so fetch a snapshot to backfill the in-flight turn, then route
      // this connection's events via the reverse-map and drain anything that
      // arrived while the snapshot was in flight. Mirrors the legacy owner
      // path in `connect()`.
      let patch: import("@/lib/snapshot-denormalize").SnapshotPatch | null =
        null
      // `null` (as opposed to a thrown error) is the backend saying it holds no
      // state under this id — i.e. the connection is definitively gone, not
      // merely unreachable.
      let connectionGone = false
      try {
        const snapshot = await acpGetSessionSnapshot(connectionId)
        if (snapshot) patch = denormalizeSnapshot(snapshot)
        else connectionGone = true
      } catch (e) {
        console.warn(
          "[acp-context] viewer snapshot fetch failed for",
          connectionId,
          e
        )
      }
      // Detach race: the tab may have disconnected (disconnect() removed the
      // entry) while the snapshot fetch was in flight. Re-check the store still
      // holds THIS viewer connection BEFORE applying the snapshot, seeding
      // delegations, or installing firehose routing — otherwise we'd hydrate /
      // seed child streams / route for a viewer no one is watching anymore.
      if (
        storeRef.current.connections.get(contextKey)?.connectionId !==
        connectionId
      ) {
        return true
      }
      if (connectionGone) {
        // The owner tore the connection down between discovery and this
        // snapshot. That window is small but routinely hit: a work-task run
        // disconnects within milliseconds of `TurnComplete`. Attaching anyway
        // would strand the tab on `connecting` FOREVER — no event can arrive on
        // a dead id, the idle sweep skips viewers, and `connect()` refuses to
        // retry any entry that isn't `disconnected`/`error`. Drop the stillborn
        // viewer and tell the caller to spawn/own instead.
        releaseConnectionRoute(connectionId, contextKey)
        pendingUnmappedEventsRef.current.delete(connectionId)
        lastActivityRef.current.delete(contextKey)
        dispatch({ type: "CONNECTION_REMOVED", contextKey })
        return false
      }
      if (patch) {
        dispatch({
          type: "HYDRATE_FROM_SNAPSHOT",
          contextKey,
          patch: presentSnapshotPatchRef.current(contextKey, patch),
        })
        seedDelegationsFromSnapshot(
          patch.connectionId,
          patch.activeDelegations,
          patch.eventSeq
        )
      }
      bindConnectionRoute(connectionId, contextKey)
      for (const env of consumeBufferedEvents(connectionId)) {
        applyMappedEnvelope(contextKey, env)
      }
      return true
    },
    [
      applyMappedEnvelope,
      bindConnectionRoute,
      consumeBufferedEvents,
      dispatch,
      releaseConnectionRoute,
      seedDelegationsFromSnapshot,
      setupAttachSubscription,
    ]
  )

  const connect = useCallback(
    async (
      contextKey: string,
      agentType: AgentType,
      workingDir?: string,
      sessionId?: string,
      conversationId?: number
    ) => {
      const request: ConnectRequest = {
        agentType,
        workingDir,
        sessionId,
        conversationId,
      }
      // Remember BEFORE the in-flight early return and before the preflight can
      // throw: a connect that never produced a store entry is precisely when
      // `reconnect()` has nothing else to go on.
      lastConnectParamsRef.current.set(contextKey, request)
      if (connectingKeysRef.current.has(contextKey)) {
        pendingConnectRequestsRef.current.set(contextKey, request)
        return
      }
      connectingKeysRef.current.add(contextKey)
      // Reactive twin of `connectingKeysRef` (a plain ref nothing can observe).
      // Published BEFORE the first await so the establishment leg — which for a
      // historical session is the whole multi-second resume — reads as
      // `connecting` in the UI instead of as a blank `null`. Set here, in step
      // with `connectingKeysRef`, so the two retire together: the `finally`
      // clears both, covering the abandoned/superseded returns inside the try
      // as well as a throwing preflight.
      setConnectPending(contextKey, {
        agentType,
        workingDir: workingDir ?? null,
      })
      // A new attempt retires the last one's failure: the heart gives way to
      // the `connecting` state and turns red again only if THIS attempt fails
      // too.
      setConnectError(contextKey, null)
      // Publish THIS attempt's failure — unless the surface let go of the
      // attempt meanwhile (`disconnect()` marks it abandoned): a late
      // rejection must not report a failure over whatever it does next.
      const publishConnectError = (info: ConnectErrorInfo) => {
        if (abandonedKeysRef.current.has(contextKey)) return
        setConnectError(contextKey, info)
        notifyConnectError(contextKey, info)
      }

      // Declared outside the try so the catch below can still tell whether this
      // agent is an ACP adapter when picking its "not installed" wording.
      let configuredAgent: AcpAgentStatus | null = null

      try {
        // Preflight: read agent status and block if the SDK / binary is
        // not installed. The session page must never trigger a download
        // or install — if the agent is not ready, prompt the user to
        // install it from Agent Settings instead.
        //
        // Every failure below is published with `publishConnectError` — a
        // notification with the settings / retry actions, and the error state
        // of the surface's connection-status heart. It is thrown as an
        // "alerted" error so the catch-all at the bottom doesn't publish a
        // second, vaguer copy of it.
        try {
          configuredAgent = await acpGetAgentStatus(agentType)
        } catch (error) {
          const reason = t("unableReadAgentConfig", {
            message: normalizeErrorMessage(error),
          })
          publishConnectError({
            agentType,
            title: t("connectFailedTitle", { agent: getAgentLabel(agentType) }),
            detail: reason,
            opensAgentSettings: true,
          })
          throw createAlertedError(reason)
        }

        const blocked = resolveConnectBlockState(configuredAgent)
        if (blocked.kind !== "none") {
          // "…is not installed" is a whole headline on its own; the other
          // blocks read as the reason a connect failed.
          publishConnectError(
            blocked.kind === "sdk_missing"
              ? {
                  agentType,
                  title: blocked.reason,
                  detail: null,
                  opensAgentSettings: true,
                }
              : {
                  agentType,
                  title: t("connectFailedTitle", {
                    agent: getAgentLabel(agentType),
                  }),
                  detail: blocked.reason,
                  opensAgentSettings: true,
                }
          )
          throw createAlertedError(blocked.reason)
        }

        const nextWorkingDir = workingDir ?? null
        let existing = storeRef.current.connections.get(contextKey)
        // Stale-state gate. The fast path below trusts any non-terminal status
        // as "already connected", which is what makes a routing-less
        // `prompting` / `connecting` entry unrecoverable — the tab keeps saying
        // "responding" and re-opening it changes nothing, because this very
        // return fires. Those two states are also the only ones no sweep ever
        // re-checks, so verify them against the backend before trusting them.
        // `connected` is deliberately not probed: the keepalive already touches
        // it every cycle and settles it when it goes away.
        if (
          existing &&
          (existing.status === "prompting" || existing.status === "connecting")
        ) {
          const staleId = existing.connectionId
          const rekeysBefore = rekeyGenerationRef.current.get(contextKey) ?? 0
          if (!(await isConnectionLiveOnBackend(staleId))) {
            markConnectionGone(contextKey, staleId)
          }
          // Re-read: the probe awaited, and `markConnectionGone` (or a live
          // event, or a concurrent disconnect) may have moved this entry.
          existing = storeRef.current.connections.get(contextKey)
          if (abandonedKeysRef.current.has(contextKey)) {
            return
          }
          // The entry we were probing LEFT this key while we awaited
          // (`markConnectionGone` keeps it — it only flips the status — and the
          // sweeps skip the two states we probe, so something else moved it).
          // Two very different reasons:
          //   * another key's orphan rescue REKEYED it, and the entry is now
          //     over there. Continuing would reach this call's own orphan
          //     rescue and drag the connection straight back to a surface that
          //     just gave it up. Bail.
          //   * the connection is simply gone — the web attach handler drops
          //     the entry on `connection_gone`. Nothing to protect, and bailing
          //     would leave the tab with no connection and no retry (the
          //     auto-connect effect doesn't re-fire on status changes). Carry
          //     on and build one.
          // Which one happened is HISTORY, not state: `rekeyGenerationRef`
          // records it, because two surfaces can legally share a connection id
          // (backend dedup) and a rekey destination can itself be torn down
          // before we get here — so who currently references the id answers
          // neither question.
          if (
            !existing &&
            (rekeyGenerationRef.current.get(contextKey) ?? 0) !== rekeysBefore
          ) {
            return
          }
          const pendingAfterProbe =
            pendingConnectRequestsRef.current.get(contextKey)
          if (
            pendingAfterProbe &&
            !sameConnectRequest(pendingAfterProbe, request)
          ) {
            return
          }
        }
        if (existing) {
          if (
            existing.agentType === agentType &&
            existing.workingDir === nextWorkingDir &&
            existing.status !== "disconnected" &&
            existing.status !== "error"
          ) {
            return
          }
          if (
            existing.status !== "disconnected" &&
            existing.status !== "error"
          ) {
            // A viewer doesn't own the backend connection — detach only, never
            // acpDisconnect (that would kill the owner's agent). Owners are
            // disconnected normally before re-spawning under new params.
            if (!existing.isViewer) {
              await acpDisconnect(existing.connectionId).catch(() => {})
            }
            releaseConnectionRoute(existing.connectionId, contextKey)
            teardownAttachSubscription(contextKey)
            lastActivityRef.current.delete(contextKey)
            pendingUnmappedEventsRef.current.delete(existing.connectionId)
            // Routing is gone, so this entry can no longer be settled by an
            // event. Retire it now rather than counting on the `acpConnect`
            // below to overwrite it: a spawn that throws (agent removed
            // mid-session), is abandoned, or is superseded returns early and
            // would otherwise leave a routing-less non-terminal entry — the
            // same immortal "responding" state this gate exists to prevent.
            captureIdentityBeforeRemoval(contextKey)
            dispatch({ type: "CONNECTION_REMOVED", contextKey })
          }
        }

        // Orphan rescue: when no entry exists at this contextKey but an
        // alive connection with the same sessionId exists at another
        // contextKey, rekey instead of creating a fresh backend connection.
        // This handles tab close+reopen for newly-created conversations:
        // the original tab's contextKey (e.g. "new-XXXX") differs from
        // the canonical sidebar-reopen contextKey (e.g. "conv-{folderId}-
        // {agent}-{convId}"), and the orphaned connection holds the
        // in-flight live state (live_message, pending_permission, etc.)
        // that we want to preserve across the remount.
        if (!existing && sessionId) {
          let orphanKey: string | null = null
          let orphanConn: ConnectionState | null = null
          for (const [key, conn] of storeRef.current.connections) {
            if (key === contextKey) continue
            if (
              conn.sessionId === sessionId &&
              conn.agentType === agentType &&
              conn.workingDir === nextWorkingDir &&
              conn.status !== "disconnected" &&
              conn.status !== "error"
            ) {
              orphanKey = key
              orphanConn = conn
              break
            }
          }
          if (orphanKey && orphanConn) {
            // Land the orphan's coalesced deltas while it still HAS an entry:
            // the reducer drops a `STREAM_BATCH` for a key with no connection,
            // so anything still in its window would be lost text. Up to
            // STREAM_FLUSH_MAX_MS of a live reply, and this runs mid-turn.
            flushStreamingQueue(orphanKey)
            // The entry MOVES (REKEY_CONNECTION below deletes `orphanKey`), so
            // its route has to move with it — a stale orphan-key route would
            // deliver this connection's events to a contextKey with no entry.
            bindConnectionRoute(orphanConn.connectionId, contextKey)
            releaseConnectionRoute(orphanConn.connectionId, orphanKey)
            // Record that `orphanKey` lost its entry to a rekey, for any
            // connect() of that key currently parked on an await.
            rekeyGenerationRef.current.set(
              orphanKey,
              (rekeyGenerationRef.current.get(orphanKey) ?? 0) + 1
            )
            const lastActivity = lastActivityRef.current.get(orphanKey)
            lastActivityRef.current.delete(orphanKey)
            lastActivityRef.current.set(contextKey, lastActivity ?? Date.now())
            if (storeRef.current.activeKey === orphanKey) {
              setActiveKey(contextKey)
            }
            // Migrate any active attach subscription from the orphan key to
            // the new key. The handlers' contextKey was captured by closure
            // at attach time, so a simple Map rename would leave events
            // dispatching to the (now-removed) orphan key. Detach + re-attach
            // with the current cursor is correct: the attach response is
            // either a (possibly empty) replay or a fresh snapshot, both
            // converge on the same state.
            const orphanCursor = orphanConn.lastAppliedSeq
            teardownAttachSubscription(orphanKey)
            dispatch({
              type: "REKEY_CONNECTION",
              fromKey: orphanKey,
              toKey: contextKey,
            })
            setupAttachSubscription(
              contextKey,
              orphanConn.connectionId,
              orphanCursor
            )
            return
          }
        }

        // Cross-client viewer attach. Before spawning a NEW backend agent, ask
        // whether another client already holds a LIVE connection for this
        // persisted conversation; if so, attach to it as a (co-controlling)
        // both clients stream the same in-flight turn (fixes desktop→browser
        // streaming). Only for real persisted conversations (id > 0) — a
        // brand-new conversation has no live owner yet, so we spawn + own.
        // Best-effort: a discovery failure falls through to the owner spawn.
        if (conversationId != null && conversationId > 0) {
          let discovered: ConversationConnectionInfo | null = null
          try {
            // Pass sessionId so discovery can fall back to external_id when the
            // live owner hasn't bound its conversation_id yet (pre-first-prompt
            // window) — without it a second client would reuse the owner's
            // connection as a mis-tagged owner and kill it on tab close. The
            // external_id fallback is matched WITH agentType (external_id is
            // unique only per agent).
            discovered = await acpFindConnectionForConversation(
              conversationId,
              sessionId,
              agentType
            )
          } catch (e) {
            console.warn(
              "[acp-context] connection discovery failed for conversation",
              conversationId,
              e
            )
          }
          // Discovery awaited: re-check the abandon/supersede guards in case a
          // disconnect() or a newer connect() for this key landed meanwhile
          // (mirrors the post-acpConnect guards below). The finally block
          // clears connectingKeys/abandoned, so a bare return is safe.
          if (abandonedKeysRef.current.has(contextKey)) {
            return
          }
          const pendingAfterDiscovery =
            pendingConnectRequestsRef.current.get(contextKey)
          if (
            pendingAfterDiscovery &&
            !sameConnectRequest(pendingAfterDiscovery, request)
          ) {
            return
          }
          // Attach as a viewer unless WE are the owner. The question is
          // deliberately "owned by this contextKey", not "owned locally at
          // all": the guard exists to stop a surface demoting ITSELF to a
          // viewer of its own connection on a re-render (nobody would
          // `acpDisconnect` it, leaking the agent process). A DIFFERENT local
          // surface — a canvas detail card for a conversation already open in
          // a workspace tab — must take the viewer path for the same reason a
          // second browser client does: falling through to `acpConnect` would
          // spawn a second agent CLI on the same session.
          const localOwnerKey = discovered
            ? localOwnerKeyOf(discovered.connection_id)
            : null
          if (discovered && localOwnerKey !== contextKey) {
            const attached = await connectAsViewer(
              contextKey,
              discovered.connection_id,
              agentType,
              nextWorkingDir
            )
            // Attached (or superseded) — done. Otherwise the connection died
            // between discovery and the attach, so fall through and spawn one
            // rather than leaving a viewer bound to a dead id.
            if (attached) return
          }
        }

        // Wait for the legacy global listener to register so Tauri's drain
        // path picks up any events emitted between acpConnect returning
        // and reverseMap.set below. Web/remote use attach which doesn't
        // need this gate, but the wait is a fast no-op once the initial
        // subscribe resolves.
        await waitForListenerReady()
        // Ship the user's saved selector preferences (mode + per-config
        // values, persisted per agentType in localStorage) up to the backend
        // at connect time. The backend applies them on the freshly-attached
        // session before emitting `session_modes` / `session_config_options`,
        // so by the time the frontend sees those events (or a snapshot frame
        // on the Subscribe-with-Snapshot attach), `current_mode_id` and
        // `current_value` already reflect the user's preferences. This
        // eliminates the prior "intercept event → overwrite locally → sync
        // back to agent" path, which fixed new-conversation flow but quietly
        // regressed when the snapshot path replaced the event path on tab
        // re-open (the snapshot frame doesn't carry a `session_modes` event,
        // so the apply-on-event hook never fired).
        const savedPrefs = getSavedPrefsForConnect(agentType)
        const connectionId = await acpConnect(
          agentType,
          workingDir,
          sessionId,
          savedPrefs.modeId,
          savedPrefs.configValues
        )

        // If disconnect was requested while connect was in flight, tear down
        // immediately instead of registering the connection — but tear down
        // ONLY what this connect actually created. The backend dedups by
        // (agent, cwd, session), so `acpConnect` may have handed back a
        // connection this client already holds under another contextKey (a
        // session still running in / behind another tab). Killing that one
        // would end a turn nobody asked to stop; it stays reachable at its own
        // key and is reclaimed by the sweeps.
        // Peek, don't consume: the `finally` clears the flag, and it has to
        // still see it to know this call established nothing (see there).
        if (abandonedKeysRef.current.has(contextKey)) {
          if (!isConnectionReferencedLocally(connectionId)) {
            acpDisconnect(connectionId).catch(() => {})
          }
          return
        }
        const pendingRequest = pendingConnectRequestsRef.current.get(contextKey)
        if (pendingRequest && !sameConnectRequest(pendingRequest, request)) {
          if (!isConnectionReferencedLocally(connectionId)) {
            acpDisconnect(connectionId).catch(() => {})
          }
          return
        }

        lastActivityRef.current.set(contextKey, Date.now())
        dispatch({
          type: "CONNECTION_CREATED",
          contextKey,
          connectionId,
          agentType,
          workingDir: nextWorkingDir,
        })

        // Subscribe-with-Snapshot path. When the active transport supports
        // the attach protocol (currently web mode), the per-connection WS
        // stream delivers snapshot + replay + live events atomically — no
        // separate snapshot HTTP fetch, no reverse-map, no unmapped buffer.
        // Returns null on transports without attach support; we fall
        // through to the legacy snapshot+global-listener path below.
        const attachSub = setupAttachSubscription(
          contextKey,
          connectionId,
          undefined
        )
        if (attachSub) {
          // Done — the EventStream handles snapshot, replay, live events,
          // and reconnect entirely in-band over the same WS.
        } else {
          // Legacy path (Tauri desktop, RemoteDesktop): same flow as
          // before Phase 3. Awaits snapshot HTTP first, then registers
          // reverseMap, then drains any envelopes that arrived on the
          // global listener while the snapshot was in flight.
          let snapshotPatch:
            | import("@/lib/snapshot-denormalize").SnapshotPatch
            | null = null
          try {
            const snapshot = await acpGetSessionSnapshot(connectionId)
            if (snapshot) {
              snapshotPatch = denormalizeSnapshot(snapshot)
            }
          } catch (e: unknown) {
            console.warn(
              "[acp-context] snapshot fetch failed for",
              connectionId,
              e
            )
          }
          // Teardown race, same guard `connectAsViewer` applies: the tab may
          // have been disconnected (entry removed) or replaced while the
          // snapshot was in flight. Hydrating or routing past that point would
          // install a route for a contextKey with no entry — a bare route that
          // nothing releases and that makes every later liveness/ownership
          // question about this connection answer from a surface that is gone.
          if (
            storeRef.current.connections.get(contextKey)?.connectionId !==
            connectionId
          ) {
            return
          }

          if (snapshotPatch) {
            dispatch({
              type: "HYDRATE_FROM_SNAPSHOT",
              contextKey,
              patch: presentSnapshotPatchRef.current(contextKey, snapshotPatch),
            })
            // Recover delegation bindings from the snapshot here too. On
            // Tauri the firehose also delivers the events (so this is an
            // idempotent no-op), but it keeps RemoteDesktop and the legacy
            // path symmetric with the attach path above.
            seedDelegationsFromSnapshot(
              snapshotPatch.connectionId,
              snapshotPatch.activeDelegations,
              snapshotPatch.eventSeq
            )
          }

          bindConnectionRoute(connectionId, contextKey)

          const buffered = consumeBufferedEvents(connectionId)
          if (buffered.length > 0) {
            for (const event of buffered) {
              applyMappedEnvelope(contextKey, event)
            }
          }
        }
      } catch (err) {
        const pendingRequest = pendingConnectRequestsRef.current.get(contextKey)
        const superseded =
          pendingRequest != null && !sameConnectRequest(pendingRequest, request)
        if (!superseded && !isAlertedError(err)) {
          const message = normalizeErrorMessage(err)
          const agentLabel = getAgentLabel(agentType)
          // Backend safety net: if the agent turned out to be not
          // installed (e.g. the binary was removed between preflight
          // and spawn), surface the same install prompt with a direct
          // "Open Agent Settings" action. Title is localized via the
          // same i18n key the preflight path uses.
          //
          // INVARIANT: `AcpError::SdkNotInstalled` renders its payload
          // unchanged, and both producers
          // (`src-tauri/src/commands/acp.rs::verify_agent_installed`
          // and `src-tauri/src/acp/connection.rs::build_agent` Binary
          // branch) format the message with the literal English
          // substring "is not installed". Do NOT translate those two
          // format strings — this branch matches on them as a stable
          // identifier, since `AcpError::Serialize` flattens to a bare
          // message string and does not expose the error `code` for
          // synchronous Tauri command rejections.
          if (message.includes("is not installed")) {
            publishConnectError({
              agentType,
              title: configuredAgent?.is_acp_adapter
                ? t("blocked.adapterMissing", { agent: agentLabel })
                : t("blocked.sdkMissing", { agent: agentLabel }),
              detail: null,
              opensAgentSettings: true,
            })
          } else {
            publishConnectError({
              agentType,
              title: t("connectFailedTitle", { agent: agentLabel }),
              detail: message,
              opensAgentSettings: false,
            })
          }
        }
        if (!superseded) {
          throw err
        }
      } finally {
        // Read before the clear below: the abandon branches leave the flag set
        // so this is the one place that consumes it.
        const wasAbandoned = abandonedKeysRef.current.has(contextKey)
        connectingKeysRef.current.delete(contextKey)
        setConnectPending(contextKey, null)
        abandonedKeysRef.current.delete(contextKey)
        const settledWaiters = connectSettledWaitersRef.current.get(contextKey)
        if (settledWaiters) {
          connectSettledWaitersRef.current.delete(contextKey)
          for (const resolveWaiter of settledWaiters) resolveWaiter()
        }
        const pendingRequest = pendingConnectRequestsRef.current.get(contextKey)
        if (pendingRequest) {
          pendingConnectRequestsRef.current.delete(contextKey)
          // A same-parameter pending request is normally a duplicate of the
          // connection THIS call just established, so it is dropped. An
          // ABANDONED call established nothing, though — `disconnect()` cancels
          // it precisely so it won't — and the queued request is then the only
          // one left to run. Dropping it there is how `reapplyConfig` (and a
          // fast close/reopen of the same key) ended up with no connection at
          // all while still reporting success.
          if (wasAbandoned || !sameConnectRequest(pendingRequest, request)) {
            queueMicrotask(() => {
              connectRef
                .current?.(
                  contextKey,
                  pendingRequest.agentType,
                  pendingRequest.workingDir,
                  pendingRequest.sessionId,
                  pendingRequest.conversationId
                )
                .catch(() => {})
            })
          }
        }
      }
    },
    [
      applyMappedEnvelope,
      bindConnectionRoute,
      captureIdentityBeforeRemoval,
      connectAsViewer,
      consumeBufferedEvents,
      dispatch,
      flushStreamingQueue,
      isConnectionLiveOnBackend,
      isConnectionReferencedLocally,
      localOwnerKeyOf,
      markConnectionGone,
      notifyConnectError,
      releaseConnectionRoute,
      resolveConnectBlockState,
      seedDelegationsFromSnapshot,
      setActiveKey,
      setConnectError,
      setConnectPending,
      setupAttachSubscription,
      t,
      teardownAttachSubscription,
      waitForListenerReady,
    ]
  )
  connectRef.current = connect

  const disconnect = useCallback(
    async (contextKey: string): Promise<boolean> => {
      pendingConnectRequestsRef.current.delete(contextKey)
      // Whatever the surface does next — close, switch agent, reconnect — the
      // last attempt's failure no longer describes it.
      setConnectError(contextKey, null)
      // An in-flight connect() must abandon its result whether or not it has
      // already put an entry in the store. It awaits several times after that
      // point (liveness probe, discovery, acpConnect), and each of those
      // resumption points re-checks `abandonedKeys` — so marking only the
      // no-entry case let a mid-flight connect resurrect a surface the caller
      // had just closed: re-attaching a viewer, or spawning an agent for a tab
      // that is gone.
      if (connectingKeysRef.current.has(contextKey)) {
        abandonedKeysRef.current.add(contextKey)
      }
      const conn = storeRef.current.connections.get(contextKey)
      if (!conn) {
        return true
      }
      // The connection's failure toasts are over once it is torn down (the
      // owner letting go kills the agent) or no surface is left on it — not
      // while a viewer closes and another surface still shows it.
      const connectionStillShown = Array.from(
        storeRef.current.connections
      ).some(
        ([key, other]) =>
          key !== contextKey && other.connectionId === conn.connectionId
      )
      if (!conn.isViewer || !connectionStillShown) {
        retireTurnFailures(conn.connectionId)
      }
      // Before either branch drops the entry: an explicit teardown is also how
      // a `reconnect` starts, and the session it resumes may only ever have
      // been known to the entry (cold attach hydrates it from the snapshot,
      // never from a replayed `session_started`).
      captureIdentityBeforeRemoval(contextKey)
      if (conn.isViewer) {
        // Viewer teardown: drop our read-only attachment WITHOUT
        // `acpDisconnect` — the backend connection belongs to another client,
        // and disconnecting it would kill the owner's agent mid-turn. Mirrors
        // detachDelegationChild. The owner's own disconnect / the idle sweep
        // governs the connection's real lifetime.
        teardownAttachSubscription(contextKey)
        releaseConnectionRoute(conn.connectionId, contextKey)
        pendingUnmappedEventsRef.current.delete(conn.connectionId)
        lastActivityRef.current.delete(contextKey)
        dispatch({ type: "CONNECTION_REMOVED", contextKey })
        return true
      }
      // A failed backend teardown must not strand the local entry: propagating
      // would leak the attach subscription and leave an entry that makes the
      // next `connect()` take its "already connected" fast path, which is
      // exactly the dead session a user-driven `reconnect` has to rebuild. So
      // the local release below is unconditional — the same policy the idle
      // sweep and connect()'s own re-spawn teardown already apply.
      //
      // The OUTCOME still has to be honest, though. "Already gone" is a real
      // teardown (another window reaped it, the agent died, the backend
      // restarted); anything else may have left the agent process running, and
      // a caller that announces "restarted" on one of those would be wrong —
      // the follow-up connect can re-attach to the process it believed it had
      // replaced. Report which happened and let the caller decide.
      let tornDown = true
      await acpDisconnect(conn.connectionId).catch((error: unknown) => {
        if (isConnectionGoneError(error)) return
        console.warn("[Acp] backend teardown failed, releasing locally:", error)
        tornDown = false
      })
      releaseConnectionRoute(conn.connectionId, contextKey)
      teardownAttachSubscription(contextKey)
      lastActivityRef.current.delete(contextKey)
      pendingUnmappedEventsRef.current.delete(conn.connectionId)
      dispatch({ type: "CONNECTION_REMOVED", contextKey })
      return tornDown
    },
    [
      captureIdentityBeforeRemoval,
      dispatch,
      releaseConnectionRoute,
      retireTurnFailures,
      setConnectError,
      teardownAttachSubscription,
    ]
  )

  // Lifecycle release for a surface that vanished on its own — currently the
  // preview tab replaced by the next single-click in the sidebar. `disconnect`
  // stays unconditional because its other callers express user INTENT (agent
  // switch, restart-to-apply, an explicit close); this one must not destroy
  // work nobody asked to stop. Same policy as the unmount cleanup
  // (`shouldDisconnectOnUnmount`): a busy owner keeps running and the idle
  // sweep reclaims it once its turn / background work settles — it is no
  // longer in `openTabKeys`, so nothing else keeps it alive.
  const disconnectIfIdle = useCallback(
    async (contextKey: string) => {
      const conn = storeRef.current.connections.get(contextKey)
      // Owners only: a viewer's disconnect just detaches (it never
      // acpDisconnects), and leaving one attached would leak its subscription
      // — the idle sweep skips viewers.
      if (conn && !conn.isViewer && isConnectionBusy(conn)) return
      await disconnect(contextKey)
    },
    [disconnect]
  )

  const reapplyConfig = useCallback(
    async (contextKey: string): Promise<boolean> => {
      const conn = storeRef.current.connections.get(contextKey)
      // Viewers / delegation children don't own the backend process — restarting
      // would kill another client's (or the broker's) agent. The banner hides
      // its restart button for them, but guard here too. Return false so the
      // caller doesn't show a false "applied" confirmation on this no-op.
      if (!conn || conn.isViewer || conn.isDelegationChild) return false
      // Capture identity BEFORE teardown. `sessionId` is what makes the new
      // process resume this conversation (session/load) rather than start fresh.
      const { agentType, workingDir, sessionId } = conn
      const tornDown = await disconnect(contextKey)
      await connect(
        contextKey,
        agentType,
        workingDir ?? undefined,
        sessionId ?? undefined
      )
      // Reconnect regardless — the user is left with a working connection
      // either way — but an unconfirmed teardown means the old process may
      // still be alive and holding the OLD config, and `connect()` can land
      // right back on it. Returning false keeps the caller from showing an
      // "applied" confirmation it can't stand behind.
      return tornDown
    },
    [connect, disconnect]
  )

  // Params a reconnect would use: the LIVE connection wins (it carries what the
  // backend actually resolved — notably a sessionId minted after connect), with
  // the remembered request filling in what the store doesn't hold
  // (conversationId, and everything at all once the entry is gone).
  const resolveReconnectRequest = useCallback(
    (contextKey: string): ConnectRequest | null => {
      const conn = storeRef.current.connections.get(contextKey)
      // Broker-owned: its lifetime is the parent's delegation_started /
      // _completed pair, and disconnecting would kill a child the user never
      // spawned. Bail before falling back to any remembered params.
      if (conn?.isDelegationChild) return null
      const remembered = lastConnectParamsRef.current.get(contextKey)
      const agentType = conn?.agentType ?? remembered?.agentType
      if (!agentType) return null
      return {
        agentType,
        workingDir: conn?.workingDir ?? remembered?.workingDir ?? undefined,
        sessionId: conn?.sessionId ?? remembered?.sessionId ?? undefined,
        conversationId: remembered?.conversationId,
      }
    },
    []
  )

  const getReconnectInfo = useCallback(
    (contextKey: string) => {
      const request = resolveReconnectRequest(contextKey)
      if (!request) return null
      return {
        agentType: request.agentType,
        workingDir: request.workingDir ?? null,
        sessionId: request.sessionId ?? null,
      }
    },
    [resolveReconnectRequest]
  )

  // Settle-point for an in-flight connect() on a key. Resolves `true` once that
  // connect finishes (immediately when nothing is connecting), `false` if it
  // has not answered within the timeout — a connect whose IPC never settles
  // must not hold the caller forever.
  const waitForConnectSettled = useCallback(
    (contextKey: string): Promise<boolean> => {
      if (!connectingKeysRef.current.has(contextKey))
        return Promise.resolve(true)
      return new Promise<boolean>((resolve) => {
        const onSettled = () => {
          clearTimeout(timer)
          resolve(true)
        }
        const timer = setTimeout(() => {
          // Drop our resolver so the abandoned wait can't accumulate on a key
          // that keeps failing to settle — including the key itself once the
          // last waiter gives up, since a connect that never answers would
          // otherwise leave the empty list behind for good.
          const waiters = connectSettledWaitersRef.current.get(contextKey)
          const at = waiters?.indexOf(onSettled) ?? -1
          if (waiters && at >= 0) waiters.splice(at, 1)
          if (waiters?.length === 0) {
            connectSettledWaitersRef.current.delete(contextKey)
          }
          resolve(false)
        }, CONNECT_SETTLE_WAIT_TIMEOUT_MS)
        const waiters = connectSettledWaitersRef.current.get(contextKey)
        if (waiters) waiters.push(onSettled)
        else connectSettledWaitersRef.current.set(contextKey, [onSettled])
      })
    },
    []
  )

  const reconnect = useCallback(
    async (contextKey: string): Promise<boolean> => {
      // A connect() already in flight would SWALLOW this one: connect() parks a
      // same-parameter request as pending and its `finally` discards it as a
      // duplicate, so the button would spin once and change nothing — with no
      // store entry yet, the teardown below wouldn't run either. Wait for the
      // attempt to settle and then rebuild: the user asked for a new
      // connection, not to join whatever is already running (they typically
      // click precisely BECAUSE the connecting state is stuck).
      //
      // Bounded rather than looped-to-clear: a key that keeps reconnecting on
      // its own must not hang the button forever, and one more contending
      // connect is what connectingKeysRef already exists to serialise.
      //
      // Each wait is also time-bounded, because the connect this one is stuck
      // behind may never answer at all. Rebuilding anyway would be worse than
      // useless — connect() would park it as a duplicate and drop it — so give
      // up and hand the button back instead of spinning on a wedged IPC.
      for (let i = 0; i < MAX_RECONNECT_SETTLE_WAITS; i++) {
        if (!connectingKeysRef.current.has(contextKey)) break
        if (!(await waitForConnectSettled(contextKey))) return false
      }
      // Resolved AFTER the wait: the connect we just waited on may have minted
      // the sessionId that makes this a resume rather than a fresh session.
      const request = resolveReconnectRequest(contextKey)
      if (!request) return false
      // Tear down first even though connect() would: its "same params, still
      // alive → no-op" fast path would otherwise swallow the whole thing, and
      // this button exists precisely to rebuild a connection whose params did
      // NOT change. `disconnect` detaches viewers without killing the owner's
      // agent, so this stays safe for them too.
      //
      // An unconfirmed teardown is deliberately NOT fatal here: the local entry
      // is released either way, and refusing to reconnect would strand the user
      // on the dead connection this button exists to replace.
      if (storeRef.current.connections.has(contextKey)) {
        await disconnect(contextKey)
      }
      await connect(
        contextKey,
        request.agentType,
        request.workingDir,
        request.sessionId,
        request.conversationId
      )
      return true
    },
    [connect, disconnect, resolveReconnectRequest, waitForConnectSettled]
  )

  reconnectRef.current = reconnect

  const dismissConfigStale = useCallback(
    (contextKey: string) => {
      dispatch({ type: "DISMISS_CONFIG_STALE", contextKey })
    },
    [dispatch]
  )

  const dismissSessionFailuresAction = useCallback(
    (contextKey: string, ids: string[]) => {
      dispatch({ type: "DISMISS_SESSION_FAILURES", contextKey, ids })
    },
    [dispatch]
  )

  const disconnectAll = useCallback(async () => {
    const promises: Promise<void>[] = []
    pendingConnectRequestsRef.current.clear()
    for (const [contextKey, conn] of storeRef.current.connections) {
      // Viewers attach to a connection another client owns — detach our
      // read-only subscription but never acpDisconnect (that would kill the
      // owner's agent). Owners are torn down normally.
      if (!conn.isViewer) {
        promises.push(acpDisconnect(conn.connectionId).catch(() => {}))
      }
      teardownAttachSubscription(contextKey)
      pendingUnmappedEventsRef.current.delete(conn.connectionId)
    }
    // Every entry is about to be dropped (REMOVE_ALL below), so drop every
    // route with them — including any held by a surface whose entry this loop
    // didn't visit.
    reverseMapRef.current.clear()
    lastActivityRef.current.clear()
    // Same reuse hazard as the caches below, on a clock: a delta queued just
    // before this would otherwise dispatch up to STREAM_FLUSH_MAX_MS later,
    // into whatever now holds its contextKey. `dispatch` repeats this for
    // REMOVE_ALL; this call is the one ahead of the await below, which is the
    // window a still-armed timer would fire in.
    discardStreamingQueues()
    // Context keys are reused across backends: a connect failure recorded for
    // one must not greet whatever session reuses its key.
    for (const key of Array.from(storeRef.current.connectErrors.keys())) {
      setConnectError(key, null)
    }
    // Same reuse hazard: remembered connect params must not let a reconnect
    // resurrect the previous backend's session under a recycled key.
    lastConnectParamsRef.current.clear()
    for (const connectionId of Array.from(turnFailuresRef.current.keys())) {
      retireTurnFailures(connectionId)
    }
    rekeyGenerationRef.current.clear()
    await Promise.all(promises)
    dispatch({ type: "REMOVE_ALL" })
  }, [
    discardStreamingQueues,
    dispatch,
    retireTurnFailures,
    setConnectError,
    teardownAttachSubscription,
  ])

  const sendPrompt = useCallback(
    async (
      contextKey: string,
      blocks: PromptInputBlock[],
      opts?: {
        folderId?: number | null
        conversationId?: number | null
        clientMessageId?: string | null
      }
    ) => {
      const conn = storeRef.current.connections.get(contextKey)
      if (!conn) return
      lastActivityRef.current.set(contextKey, Date.now())
      try {
        await acpPrompt(
          conn.connectionId,
          blocks,
          opts?.folderId ?? null,
          opts?.conversationId ?? null,
          opts?.clientMessageId ?? null
        )
      } catch (e) {
        // Same reasoning as `cancel`: the backend disowning this id proves the
        // local state is stale. Settle it (the caller still gets the error and
        // surfaces its toast / rolls back its optimistic turn) so the composer
        // doesn't keep sending into a connection that no longer exists.
        if (isConnectionGoneError(e)) {
          markConnectionGone(contextKey, conn.connectionId)
        }
        throw e
      }
    },
    [markConnectionGone]
  )

  const setMode = useCallback(async (contextKey: string, modeId: string) => {
    const conn = storeRef.current.connections.get(contextKey)
    if (!conn) return
    // Persist user's mode selection to localStorage
    const modes =
      conn.modes ?? selectorsCache.get(conn.agentType)?.modes ?? null
    if (modes) {
      saveModePreference(conn.agentType, {
        ...modes,
        current_mode_id: modeId,
      })
    }
    lastActivityRef.current.set(contextKey, Date.now())
    await acpSetMode(conn.connectionId, modeId)
  }, [])

  const setConfigOption = useCallback(
    async (contextKey: string, configId: string, valueId: string) => {
      const conn = storeRef.current.connections.get(contextKey)
      if (!conn) return
      dispatch({
        type: "CONFIG_OPTION_CHANGED",
        contextKey,
        configId,
        valueId,
      })
      // Persist user selection to localStorage so the next `acp_connect`
      // can ship it back to the backend as a preferred config value.
      saveConfigPreference(conn.agentType, configId, valueId)
      lastActivityRef.current.set(contextKey, Date.now())
      await acpSetConfigOption(conn.connectionId, configId, valueId)
    },
    [dispatch]
  )

  const cancel = useCallback(
    async (contextKey: string) => {
      const conn = storeRef.current.connections.get(contextKey)
      if (!conn) return
      try {
        await acpCancel(conn.connectionId)
      } catch (e) {
        // Pressing Stop on a connection the backend no longer has is the
        // clearest evidence that this entry's terminal event went missing —
        // and, before this, the point where the bug became visible: the
        // rejection was logged to the console and the button just did nothing,
        // forever. Settle the state instead so the UI leaves "responding" and
        // offers a reconnect.
        if (isConnectionGoneError(e)) {
          markConnectionGone(contextKey, conn.connectionId)
          return
        }
        throw e
      }
    },
    [markConnectionGone]
  )

  const goalControl = useCallback(
    async (contextKey: string, action: "pause" | "clear") => {
      const conn = storeRef.current.connections.get(contextKey)
      if (!conn) return
      // Fire-and-forget: there is no in-flight card UI to settle (unlike
      // answerQuestion). The resulting goal snapshot arrives as a normal
      // session_info_update, and a wire failure is surfaced by the backend's
      // recoverable Error event — so log here and don't rethrow.
      try {
        lastActivityRef.current.set(contextKey, Date.now())
        await acpGoalControl(conn.connectionId, action)
      } catch (e) {
        console.error("[AcpConnections] goalControl failed:", e)
      }
    },
    []
  )

  const respondPermission = useCallback(
    async (contextKey: string, requestId: string, optionId: string) => {
      const conn = storeRef.current.connections.get(contextKey)
      if (!conn) {
        console.error(
          "[AcpConnections] respondPermission: no connection for",
          contextKey
        )
        return
      }
      try {
        lastActivityRef.current.set(contextKey, Date.now())
        await acpRespondPermission(conn.connectionId, requestId, optionId)
        dispatch({ type: "PERMISSION_CLEARED", contextKey, requestId })
      } catch (e) {
        console.error("[AcpConnections] respondPermission failed:", e)
        throw e
      }
    },
    [dispatch]
  )

  const answerQuestion = useCallback(
    async (contextKey: string, questionId: string, answer: QuestionAnswer) => {
      const conn = storeRef.current.connections.get(contextKey)
      if (!conn) {
        // Throw, don't silently return: AskQuestionCard awaits this and holds a
        // disabled in-flight state (spinner) until it resolves, only re-enabling
        // on rejection. A silent resolve here would leave the card stuck. The
        // throw routes to the card's retryable inline error instead.
        throw new Error(
          `[AcpConnections] answerQuestion: no connection for ${contextKey}`
        )
      }
      try {
        lastActivityRef.current.set(contextKey, Date.now())
        await acpAnswerQuestion(conn.connectionId, questionId, answer)
        // Optimistically clear; the backend also broadcasts question_resolved
        // (idempotent on the matched id).
        dispatch({ type: "CLEAR_ASK_QUESTION", contextKey, questionId })
      } catch (e) {
        console.error("[AcpConnections] answerQuestion failed:", e)
        throw e
      }
    },
    [dispatch]
  )

  const answerPlanApproval = useCallback(
    async (
      contextKey: string,
      approvalId: string,
      answer: PlanApprovalAnswer
    ) => {
      const conn = storeRef.current.connections.get(contextKey)
      if (!conn) {
        // Throw, don't silently return: PlanApprovalCard awaits this and holds a
        // disabled in-flight state until it resolves. A silent resolve would
        // leave the card stuck; the throw routes to its retryable inline error.
        throw new Error(
          `[AcpConnections] answerPlanApproval: no connection for ${contextKey}`
        )
      }
      try {
        lastActivityRef.current.set(contextKey, Date.now())
        await acpAnswerPlanApproval(conn.connectionId, approvalId, answer)
        // Optimistically clear; the backend also broadcasts
        // plan_approval_resolved (idempotent on the matched id).
        dispatch({ type: "CLEAR_PLAN_APPROVAL", contextKey, approvalId })
      } catch (e) {
        console.error("[AcpConnections] answerPlanApproval failed:", e)
        throw e
      }
    },
    [dispatch]
  )

  const attachDelegationChild = useCallback(
    (args: {
      connectionId: string
      parentConnectionId: string
      parentToolUseId: string
      agentType: AgentType
      hydrate?: boolean
    }) => {
      const {
        connectionId,
        parentConnectionId,
        parentToolUseId,
        agentType,
        hydrate,
      } = args
      const existing = storeRef.current.connections.get(connectionId)
      if (
        existing &&
        existing.isDelegationChild &&
        existing.connectionId === connectionId
      ) {
        // Already attached; just refresh activity so the idle sweep
        // doesn't trip on a duplicate delegation_started event.
        lastActivityRef.current.set(connectionId, Date.now())
        return
      }
      dispatch({
        type: "DELEGATION_CHILD_ATTACH",
        contextKey: connectionId,
        connectionId,
        agentType,
        parentConnectionId,
        parentToolUseId,
      })
      lastActivityRef.current.set(connectionId, Date.now())

      const stream = getEventStream()
      if (stream) {
        // Web / remote transport: open a per-connection attach so the
        // child's snapshot + replay + live events flow through the
        // standard handlers. This is independent of any user-driven
        // tab attach because contextKey == connectionId for children.
        setupAttachSubscription(connectionId, connectionId, undefined)
        return
      }

      // Tauri desktop: the global acp://event listener routes by
      // reverseMap. Register the identity mapping and drain any
      // envelopes that arrived between the child's spawn and now.
      // ADDS a route rather than replacing one: the work-task transcript viewer
      // attaches the task's OWN connection through here, and a conversation tab
      // may be watching that same connection.
      const route = () => {
        bindConnectionRoute(connectionId, connectionId)
        for (const env of consumeBufferedEvents(connectionId)) {
          applyMappedEnvelope(connectionId, env)
        }
      }
      if (!hydrate) {
        route()
        return
      }
      // Mid-turn attach: the firehose carries only future events, so backfill
      // the turn already in flight from a snapshot FIRST, then route (same
      // order as `connectAsViewer` — anything that lands while the fetch is in
      // flight stays in the unmapped buffer and is deduped by seq on drain).
      void (async () => {
        let patch: import("@/lib/snapshot-denormalize").SnapshotPatch | null =
          null
        try {
          const snapshot = await acpGetSessionSnapshot(connectionId)
          if (snapshot) patch = denormalizeSnapshot(snapshot)
        } catch (e) {
          console.warn(
            "[acp-context] child snapshot fetch failed for",
            connectionId,
            e
          )
        }
        // The viewer may have closed while the snapshot was in flight —
        // never hydrate or install routing for a detached child.
        const still = storeRef.current.connections.get(connectionId)
        if (!still?.isDelegationChild || still.connectionId !== connectionId) {
          return
        }
        if (patch) {
          dispatch({
            type: "HYDRATE_FROM_SNAPSHOT",
            contextKey: connectionId,
            patch: presentSnapshotPatchRef.current(connectionId, patch),
          })
          // Same recovery the other three snapshot consumers do
          // (`setupAttachSubscription.onSnapshot`, `connectAsViewer`,
          // `connect()`'s legacy branch): `delegation_started` is transient and
          // never replayed, so a viewer opening onto a turn that ALREADY
          // delegated (the work-task transcript dialog is the case) would
          // otherwise establish no binding — no agent icon/label, no child
          // sub-stream, no "待批准" badge on the sub-agent card. Idempotent
          // against any live event for the same `parent_tool_use_id`.
          seedDelegationsFromSnapshot(
            patch.connectionId,
            patch.activeDelegations,
            patch.eventSeq
          )
        }
        route()
      })()
    },
    [
      applyMappedEnvelope,
      bindConnectionRoute,
      consumeBufferedEvents,
      dispatch,
      seedDelegationsFromSnapshot,
      setupAttachSubscription,
    ]
  )

  const detachDelegationChild = useCallback(
    (connectionId: string) => {
      const existing = storeRef.current.connections.get(connectionId)
      if (!existing || !existing.isDelegationChild) return
      teardownAttachSubscription(connectionId)
      // Release only THIS surface's route (contextKey === connectionId for a
      // child). Deleting the whole entry used to cut off a conversation tab
      // watching the same connection — closing the work-task transcript dialog
      // silently blinded the tab, which then sat on `prompting` forever.
      releaseConnectionRoute(connectionId, connectionId)
      pendingUnmappedEventsRef.current.delete(connectionId)
      lastActivityRef.current.delete(connectionId)
      dispatch({ type: "DELEGATION_CHILD_DETACH", contextKey: connectionId })
    },
    [dispatch, releaseConnectionRoute, teardownAttachSubscription]
  )

  const actions = useMemo<AcpActionsValue>(
    () => ({
      connect,
      disconnect,
      disconnectIfIdle,
      disconnectAll,
      sendPrompt,
      setMode,
      setConfigOption,
      cancel,
      goalControl,
      respondPermission,
      answerQuestion,
      answerPlanApproval,
      setActiveKey,
      touchActivity,
      registerOpenTabKeys,
      registerLiveSurfaceKeys,
      registerLiveMessageSink,
      clearAcpLoadError,
      attachDelegationChild,
      detachDelegationChild,
      reapplyConfig,
      reconnect,
      getReconnectInfo,
      dismissConfigStale,
      dismissSessionFailures: dismissSessionFailuresAction,
      registerSessionFailureActions,
    }),
    [
      connect,
      disconnect,
      disconnectIfIdle,
      disconnectAll,
      sendPrompt,
      setMode,
      setConfigOption,
      cancel,
      goalControl,
      respondPermission,
      answerQuestion,
      answerPlanApproval,
      setActiveKey,
      touchActivity,
      registerOpenTabKeys,
      registerLiveSurfaceKeys,
      registerLiveMessageSink,
      clearAcpLoadError,
      attachDelegationChild,
      detachDelegationChild,
      reapplyConfig,
      reconnect,
      getReconnectInfo,
      dismissConfigStale,
      dismissSessionFailuresAction,
      registerSessionFailureActions,
    ]
  )

  const eventSubscriberApi = useMemo<AcpEventSubscriberApi>(
    () => ({ subscribers: eventSubscribersRef.current }),
    []
  )

  return (
    <AcpActionsContext.Provider value={actions}>
      <ConnectionStoreContext.Provider value={storeApi}>
        <AcpEventSubscriberContext.Provider value={eventSubscriberApi}>
          {children}
        </AcpEventSubscriberContext.Provider>
      </ConnectionStoreContext.Provider>
    </AcpActionsContext.Provider>
  )
}
