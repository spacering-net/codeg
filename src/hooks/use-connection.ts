"use client"

import { useCallback, useMemo, useRef, useSyncExternalStore } from "react"
import {
  useAcpActions,
  useConnectionStore,
  getCachedSelectors,
  type ClaudeApiRetryState,
  type ConnectionState,
  type PendingPermission,
  type PendingUserMessage,
  type PendingQuestion,
} from "@/contexts/acp-connections-context"
import type {
  AgentType,
  AvailableCommandInfo,
  ConfigStaleKind,
  ConnectionStatus,
  PendingPlanApprovalState,
  PendingQuestionState,
  PromptCapabilitiesInfo,
  QuestionAnswer,
  SessionConfigOptionInfo,
  AsyncTaskRecord,
  SessionFailureRecord,
  SessionModeStateInfo,
  PromptInputBlock,
} from "@/lib/types"

const DEFAULT_PROMPT_CAPABILITIES: PromptCapabilitiesInfo = {
  image: false,
  audio: false,
  embedded_context: false,
}

/** Stable empty table so the no-failures common case never re-renders. */
const EMPTY_SESSION_FAILURES: SessionFailureRecord[] = []
const EMPTY_STEERED_MESSAGE_IDS: string[] = []
// Stable empty reference: a new [] on every render would break the memo below
// for every connection that has no async tasks — i.e. almost all of them.
const EMPTY_ASYNC_TASKS: AsyncTaskRecord[] = []

export interface UseConnectionReturn {
  connectionId: string | null
  /** The agent type of the live connection at this contextKey (null when no
   *  connection exists yet). Lets callers detect a connection still bound to a
   *  PREVIOUS agent — e.g. a draft mid-switch, or a switch the not-installed
   *  preflight blocked before it could tear the old one down — so they can
   *  avoid rendering the previous agent's selectors as the selected one's. */
  agentType: AgentType | null
  /**
   * True when this context attached to a connection another client owns
   * (cross-client viewing). Viewers detach but never `acpDisconnect`, so the
   * unmount cleanup must tear them down even mid-turn (the owner's agent is
   * unaffected) — otherwise the attach subscription leaks past tab close.
   */
  isViewer: boolean
  status: ConnectionStatus | null
  promptCapabilities: PromptCapabilitiesInfo
  supportsFork: boolean
  selectorsReady: boolean
  hasCachedSelectors: boolean
  sessionId: string | null
  /** The working directory the live connection was established with (null when
   *  not connected). Lets callers detect a connection that is mid-reconnect to a
   *  different cwd and avoid acting on the stale one. */
  connectedWorkingDir: string | null
  modes: SessionModeStateInfo | null
  configOptions: SessionConfigOptionInfo[] | null
  availableCommands: AvailableCommandInfo[] | null
  pendingPermission: PendingPermission | null
  pendingUserMessage: PendingUserMessage | null
  /** Feedback-note ids this turn's live message adopted as mid-turn user turns
   *  (native steering). The notes list drops their strips so one message shows
   *  in exactly one place. `[]` when nothing was steered. */
  steeredMessageIds: string[]
  pendingQuestion: PendingQuestion | null
  pendingAskQuestion: PendingQuestionState | null
  pendingPlanApproval: PendingPlanApprovalState | null
  claudeApiRetry: ClaudeApiRetryState | null
  /** AIR typed session failure table (active + resolved; see
   *  `lib/session-failures.ts`). `[]` when the connection has none. */
  sessionFailures: SessionFailureRecord[]
  /** AIR async tasks — Claude's background shells / workflows / monitors
   *  (see `lib/async-tasks.ts`). Retained after they settle; the strip filters
   *  to the live ones. `[]` when the connection has none. */
  asyncTasks: AsyncTaskRecord[]
  error: string | null
  loadError: string | null
  /** Runnable recovery for `loadError` (today `codex unarchive <id>`), or
   *  null when the failure has none. Carried separately from the localized
   *  message so the banner can offer it as a copy action. */
  loadErrorCommand: string | null
  /** True when the running session is on stale (launch-time) config after a
   *  later settings save. Drives the "restart to apply" banner. */
  configStale: boolean
  /** Which settings surface drifted, for the banner's wording. */
  configStaleKind: ConfigStaleKind | null
  /** Client-local: the user dismissed the stale banner for the current drift. */
  configStaleDismissed: boolean
  /** True for a delegation-spawned child connection (broker-owned). The stale
   *  banner hides for these — the user can't restart a broker-owned process. */
  isDelegationChild: boolean
  /** Launched-but-unresolved background tasks on this connection (async
   *  sub-agents / background shells, accounted from the transcript by the
   *  backend watcher). The count is never rendered — it exists so the unmount
   *  teardown (`shouldDisconnectOnUnmount`) spares a connection whose agent CLI
   *  still has background work to finish. */
  backgroundOutstanding: number
  connect: (
    agentType: AgentType,
    workingDir?: string,
    sessionId?: string,
    conversationId?: number
  ) => Promise<void>
  disconnect: () => Promise<void>
  /** Restart the session (disconnect + resume same sessionId) so it picks up
   *  current agent/model settings. Returns `true` if it actually restarted,
   *  `false` on a no-op (viewer / delegation child / no connection). */
  reapplyConfig: () => Promise<boolean>
  /** Dismiss the stale banner for the current drift without restarting. */
  dismissConfigStale: () => void
  sendPrompt: (
    blocks: PromptInputBlock[],
    opts?: {
      folderId?: number | null
      conversationId?: number | null
      clientMessageId?: string | null
    }
  ) => Promise<void>
  setMode: (modeId: string) => Promise<void>
  setConfigOption: (configId: string, valueId: string) => Promise<void>
  cancel: () => Promise<void>
  respondPermission: (requestId: string, optionId: string) => Promise<void>
  answerQuestion: (questionId: string, answer: QuestionAnswer) => Promise<void>
}

function derive(conn: ConnectionState | undefined) {
  if (!conn) return null
  return conn
}

// ConnectionState fields that change at streaming frequency but are NOT part of
// `UseConnectionReturn` (no consumer renders them), so a change to one of these
// alone must NOT re-render this hook's consumers:
//   - `liveMessage`: the accumulating assistant message (per STREAM_BATCH),
//     rendered from the conversation-runtime store instead.
//   - `lastAppliedSeq`: the seq-dedup cursor, advanced by EVENT_APPLIED after
//     EVERY accepted envelope — so without excluding it a `content_delta` token
//     would still churn the snapshot and re-render the keep-alive panel per event.
const CONN_NON_RENDER_KEYS = new Set<keyof ConnectionState>([
  "liveMessage",
  "lastAppliedSeq",
  // Out-of-turn tool-call registry: read only inside the reducer (permission
  // enrichment); no useConnection consumer renders it, and it can churn per
  // background tool event.
  "outOfTurnToolCalls",
])

// Shallow-equal two connection snapshots for RENDER purposes: equal iff every
// field a useConnection consumer can observe is identical. Keys are iterated
// dynamically so a newly-added ConnectionState field is compared by default
// (fail toward re-rendering, never toward a silently-missed update); only the
// explicitly internal keys above are ignored. Exported for tests.
export function connRenderEqual(
  a: ConnectionState | null,
  b: ConnectionState | null
): boolean {
  if (a === b) return true
  if (!a || !b) return false
  const aKeys = Object.keys(a) as (keyof ConnectionState)[]
  if (aKeys.length !== Object.keys(b).length) return false
  for (const key of aKeys) {
    if (CONN_NON_RENDER_KEYS.has(key)) continue
    if (!Object.is(a[key], b[key])) return false
  }
  return true
}

export function useConnection(contextKey: string): UseConnectionReturn {
  const store = useConnectionStore()
  const actions = useAcpActions()

  const subscribe = useCallback(
    (cb: () => void) => store.subscribeKey(contextKey, cb),
    [store, contextKey]
  )
  // Keep the snapshot reference STABLE across streaming-only changes (liveMessage
  // and the lastAppliedSeq dedup cursor) so this hook — and its consumers,
  // notably the keep-alive conversation panel — do NOT re-render on every
  // streaming token. The live message reaches the UI via the conversation-runtime
  // store (mirrored there by the connection dispatch; see
  // `registerLiveMessageSink`), so no useConnection consumer renders it. A
  // per-instance cache recomputes the stable snapshot only when a render-relevant
  // field changes; a contextKey change resets it.
  const cacheRef = useRef<{
    key: string
    raw: ConnectionState | null
    stable: ConnectionState | null
  }>({ key: contextKey, raw: null, stable: null })
  const getSnapshot = useCallback((): ConnectionState | null => {
    const cache = cacheRef.current
    if (cache.key !== contextKey) {
      cache.key = contextKey
      cache.raw = null
      cache.stable = null
    }
    const raw = derive(store.getConnection(contextKey))
    if (raw === cache.raw) return cache.stable
    cache.raw = raw
    if (connRenderEqual(cache.stable, raw)) {
      // Only internal streaming state (liveMessage / lastAppliedSeq) changed →
      // keep the previous reference so consumers don't re-render per token.
      return cache.stable
    }
    cache.stable = raw
    return raw
  }, [store, contextKey])
  const connection = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  // A `connect()` that has started but not yet produced an entry. Rides the
  // same per-key listener set, so one subscription covers both.
  const getPendingSnapshot = useCallback(
    () => store.getConnectPending(contextKey),
    [store, contextKey]
  )
  const connectPending = useSyncExternalStore(
    subscribe,
    getPendingSnapshot,
    getPendingSnapshot
  )

  const connectionId = connection?.connectionId ?? null
  const agentType = connection?.agentType ?? null
  const isViewer = connection?.isViewer ?? false
  // An in-flight `connect()` IS "connecting", even though the store has no
  // entry for it yet: the backend call that creates one only returns after the
  // agent has spawned, handshaken and resumed the session, so reporting `null`
  // for that whole stretch told every consumer "idle, nothing in flight" —
  // which is how opening a historical conversation ended up with no composer
  // placeholder, no loading cue and no status-bar task. A real entry always
  // wins: once it exists, its own status is the more specific truth.
  const status = connection?.status ?? (connectPending ? "connecting" : null)
  const promptCapabilities =
    connection?.promptCapabilities ?? DEFAULT_PROMPT_CAPABILITIES
  const supportsFork = connection?.supportsFork ?? false
  const selectorsReady = connection?.selectorsReady ?? false
  const sessionId = connection?.sessionId ?? null
  const cached = connection?.agentType
    ? getCachedSelectors(connection.agentType)
    : null
  const hasCachedSelectors = cached !== null
  const connectedWorkingDir = connection?.workingDir ?? null
  const modes = connection?.modes ?? cached?.modes ?? null
  const configOptions =
    connection?.configOptions ?? cached?.configOptions ?? null
  const availableCommands = connection?.availableCommands ?? null
  const pendingPermission = connection?.pendingPermission ?? null
  const pendingUserMessage = connection?.pendingUserMessage ?? null
  const steeredMessageIds =
    connection?.steeredMessageIds ?? EMPTY_STEERED_MESSAGE_IDS
  const pendingQuestion = connection?.pendingQuestion ?? null
  const pendingAskQuestion = connection?.pendingAskQuestion ?? null
  const pendingPlanApproval = connection?.pendingPlanApproval ?? null
  const claudeApiRetry = connection?.claudeApiRetry ?? null
  const sessionFailures = connection?.sessionFailures ?? EMPTY_SESSION_FAILURES
  const asyncTasks = connection?.asyncTasks ?? EMPTY_ASYNC_TASKS
  const error = connection?.error ?? null
  const loadError = connection?.loadError ?? null
  const loadErrorCommand = connection?.loadErrorCommand ?? null
  const configStale = connection?.configStale ?? false
  const configStaleKind = connection?.configStaleKind ?? null
  const configStaleDismissed = connection?.configStaleDismissed ?? false
  const isDelegationChild = connection?.isDelegationChild ?? false
  const backgroundOutstanding = connection?.backgroundOutstanding ?? 0

  const connect = useCallback(
    (
      agentType: AgentType,
      workingDir?: string,
      sessionId?: string,
      conversationId?: number
    ) =>
      actions.connect(
        contextKey,
        agentType,
        workingDir,
        sessionId,
        conversationId
      ),
    [actions, contextKey]
  )

  // Drops `actions.disconnect`'s teardown-confirmed flag: this hook's callers
  // are closing a surface, and only a caller that reports a restart back to the
  // user (see `reapplyConfig`) has anything to do with that answer.
  const disconnect = useCallback(async () => {
    await actions.disconnect(contextKey)
  }, [actions, contextKey])

  const sendPrompt = useCallback(
    (
      blocks: PromptInputBlock[],
      opts?: {
        folderId?: number | null
        conversationId?: number | null
        clientMessageId?: string | null
      }
    ) => actions.sendPrompt(contextKey, blocks, opts),
    [actions, contextKey]
  )

  const setMode = useCallback(
    (modeId: string) => actions.setMode(contextKey, modeId),
    [actions, contextKey]
  )

  const setConfigOption = useCallback(
    (configId: string, valueId: string) =>
      actions.setConfigOption(contextKey, configId, valueId),
    [actions, contextKey]
  )

  const cancel = useCallback(
    () => actions.cancel(contextKey),
    [actions, contextKey]
  )

  const respondPermission = useCallback(
    (requestId: string, optionId: string) =>
      actions.respondPermission(contextKey, requestId, optionId),
    [actions, contextKey]
  )

  const answerQuestion = useCallback(
    (questionId: string, answer: QuestionAnswer) =>
      actions.answerQuestion(contextKey, questionId, answer),
    [actions, contextKey]
  )

  const reapplyConfig = useCallback(
    () => actions.reapplyConfig(contextKey),
    [actions, contextKey]
  )

  const dismissConfigStale = useCallback(
    () => actions.dismissConfigStale(contextKey),
    [actions, contextKey]
  )

  return useMemo(
    () => ({
      connectionId,
      agentType,
      isViewer,
      status,
      promptCapabilities,
      supportsFork,
      selectorsReady,
      hasCachedSelectors,
      sessionId,
      connectedWorkingDir,
      modes,
      configOptions,
      availableCommands,
      pendingPermission,
      pendingUserMessage,
      steeredMessageIds,
      pendingQuestion,
      pendingAskQuestion,
      pendingPlanApproval,
      claudeApiRetry,
      sessionFailures,
      asyncTasks,
      error,
      loadError,
      loadErrorCommand,
      configStale,
      configStaleKind,
      configStaleDismissed,
      isDelegationChild,
      backgroundOutstanding,
      connect,
      disconnect,
      reapplyConfig,
      dismissConfigStale,
      sendPrompt,
      setMode,
      setConfigOption,
      cancel,
      respondPermission,
      answerQuestion,
    }),
    [
      connectionId,
      agentType,
      isViewer,
      status,
      promptCapabilities,
      supportsFork,
      selectorsReady,
      hasCachedSelectors,
      sessionId,
      connectedWorkingDir,
      modes,
      configOptions,
      availableCommands,
      pendingPermission,
      pendingUserMessage,
      steeredMessageIds,
      pendingQuestion,
      pendingAskQuestion,
      pendingPlanApproval,
      claudeApiRetry,
      sessionFailures,
      asyncTasks,
      error,
      loadError,
      loadErrorCommand,
      configStale,
      configStaleKind,
      configStaleDismissed,
      isDelegationChild,
      backgroundOutstanding,
      connect,
      disconnect,
      reapplyConfig,
      dismissConfigStale,
      sendPrompt,
      setMode,
      setConfigOption,
      cancel,
      respondPermission,
      answerQuestion,
    ]
  )
}
