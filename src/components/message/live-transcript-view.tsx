"use client"

/**
 * Shared read-only live-transcript surface: the same `MessageListView` used by
 * the main conversation panel, without the input bar, send signal, or
 * reload/new-session handlers — plus the child connection's blocking prompts
 * that resolve WITHOUT driving a new turn (permission request, codeg-mcp
 * `ask_user_question`, Grok plan approval), answered through the viewed
 * connection id.
 *
 * Extracted from the delegation sub-agent dialog so other embeds (the work-task
 * transcript viewer) reuse the exact same streaming pipeline. The host owns the
 * chrome (Dialog/Drawer + header) and, when the viewed connection is not a
 * delegation child already attached by its parent, the host also owns the
 * `attachDelegationChild`/`detachDelegationChild` lifecycle.
 *
 * Streaming: while mounted, the connection's live message and status (from
 * `acp-connections-context`) are mirrored into the runtime session for
 * `conversationId` so `MessageListView` shows real-time deltas. Persistence of
 * completed turns comes from the broker's own DB writes, surfaced via
 * `useConversationDetail`. On unmount the runtime session is dropped, so the
 * next mount starts from a fresh persisted fetch.
 */

import { useCallback, useEffect, useRef, useSyncExternalStore } from "react"

import {
  MessageListView,
  type ResolvedMessageGroup,
} from "@/components/message/message-list-view"
import { useConversationDetail } from "@/hooks/use-conversation-detail"
import { useConversationRuntimeActions } from "@/stores/conversation-runtime-store"
import {
  useAcpActions,
  useConnectionStore,
  type ConnectionState,
} from "@/contexts/acp-connections-context"
import { PermissionDialog } from "@/components/chat/permission-dialog"
import { AskQuestionCard } from "@/components/chat/ask-question-card"
import { PlanApprovalCard } from "@/components/chat/plan-approval-card"
import {
  type AgentType,
  type PlanApprovalAnswer,
  type QuestionAnswer,
} from "@/lib/types"

export function useConnectionStateById(
  connectionId: string | null
): ConnectionState | undefined {
  const store = useConnectionStore()
  const subscribe = useCallback(
    (cb: () => void) => {
      if (!connectionId) return () => {}
      return store.subscribeKey(connectionId, cb)
    },
    [store, connectionId]
  )
  const getSnapshot = useCallback(
    () => (connectionId ? store.getConnection(connectionId) : undefined),
    [store, connectionId]
  )
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

/**
 * Bridge the connection's `liveMessage` and status transitions into the
 * runtime session for `conversationId`, so the read-only `MessageListView`
 * sees streaming turns and turn completions while the viewer is open.
 *
 * Mirrors the effects in `conversation-detail-panel.tsx`, with one concern
 * specific to a read-only viewer:
 *
 *  **Close-mid-stream / reopen-after-complete.** The cleanup of the
 *  mirror-live effect intentionally does not clear `liveMessage` while
 *  still prompting (so it remains promotable for the completeTurn edge).
 *  If the user closes the viewer during that window and the session later
 *  finishes, no bridge is running to dispatch `completeTurn`, leaving stale
 *  `liveMessage` in runtime state. On reopen, `fetchDetail`'s active-data
 *  guard would skip the refetch and the user would see a stale partial
 *  transcript. We solve this by calling `removeConversation` on the viewer
 *  body's full unmount — the runtime session is owned by this viewer alone,
 *  so dropping it forces the next open to fetch the persisted detail from
 *  scratch.
 *
 * The detail-fetch no longer races the streaming bridge: the viewer's mount
 * fetch uses `preserveLive: true`, so `FETCH_DETAIL_SUCCESS` keeps the bridged
 * `liveMessage` instead of wiping it — no re-bridge effect is needed.
 *
 * One more case is handled explicitly: **reopen-after-completion.** If the
 * viewer mounts onto a session that already finished but whose connection
 * still holds its final `liveMessage` (kept for a short grace period after
 * completion), the streaming→settled `completeTurn` edge never fires and the
 * non-live mirror is rejected while the detail loads — so the
 * adopt-settled-reply effect promotes that retained reply directly, covering
 * the window before the persisted transcript catches up.
 */
export function useLiveTranscriptBridge(
  conversationId: number,
  connState: ConnectionState | undefined
) {
  const { setLiveMessage, completeTurn, syncTurnMetadata, removeConversation } =
    useConversationRuntimeActions()

  const connStatus = connState?.status ?? null
  const liveMessage = connState?.liveMessage ?? null

  // Backfill token usage / duration / model into the promoted reply once the
  // session's persisted transcript catches up. `completeTurn` lands the
  // streamed reply WITHOUT those fields — `buildStreamingTurnsFromLiveMessage`
  // carries no usage data; it comes from the DB parser — so without this the
  // post-stream stats row stays blank. Mirrors `conversation-detail-panel.tsx`:
  // a delayed, self-retrying DB roundtrip that PATCHes metadata onto the
  // existing `localTurns` (it never replaces them, so the kept live reply is
  // not blanked, unlike a `refetchDetail`). Cancel the previous sync before
  // starting a new one, and on viewer close, via the ref.
  const syncCancelRef = useRef<(() => void) | null>(null)
  const startMetadataSync = useCallback(() => {
    if (conversationId <= 0) return
    syncCancelRef.current?.()
    syncCancelRef.current = syncTurnMetadata(conversationId)
  }, [conversationId, syncTurnMetadata])

  const connStatusRef = useRef(connStatus)
  useEffect(() => {
    connStatusRef.current = connStatus
  }, [connStatus])

  // When connStatus transitions away from "prompting", completeTurn snapshots
  // and promotes the live reply. This stays correct across the transition
  // because the mirror-live effect's cleanup gates on `connStatusRef` (which
  // still reads "prompting" at cleanup time, since React updates it only in a
  // later setup pass) rather than on effect declaration order. We also latch
  // whether we ever observed streaming this mount, so the adopt-settled-reply
  // effect below can tell a fresh "reopened after the session already
  // finished" mount from a normal streaming→settled handoff.
  const prevStatusRef = useRef(connStatus)
  const everPromptingRef = useRef(connStatus === "prompting")
  useEffect(() => {
    const wasPrompting = prevStatusRef.current === "prompting"
    prevStatusRef.current = connStatus
    if (connStatus === "prompting") everPromptingRef.current = true
    if (!wasPrompting || connStatus === "prompting") return
    completeTurn(conversationId, liveMessage)
    startMetadataSync()
  }, [connStatus, liveMessage, conversationId, completeTurn, startMetadataSync])

  useEffect(() => {
    if (liveMessage != null) {
      setLiveMessage(conversationId, liveMessage, connStatus === "prompting")
    }
    return () => {
      if (connStatusRef.current !== "prompting") {
        setLiveMessage(conversationId, null)
      }
    }
  }, [liveMessage, connStatus, conversationId, setLiveMessage])

  // Adopt-settled-reply: handle reopening the viewer onto a session that
  // ALREADY finished but whose connection still carries its final liveMessage
  // (kept for CHILD_DETACH_GRACE_MS after completion to bridge DB lag). For
  // such a mount the streaming→settled completeTurn edge never fires (we never
  // saw "prompting"), and the non-live mirror above is rejected by the
  // SET_LIVE_MESSAGE guard while the mount fetch is loading — so without this
  // the final reply would vanish whenever the persisted transcript still lags
  // (empty / user-only / partial detail). Adopt the retained reply directly:
  // bridge it as live (a one-shot session's liveMessage is unambiguously its
  // own reply, never a stale reconnect replay) then promote it to a COMPLETED
  // local turn (no streaming affordance), where the `liveOwnsActiveTurn`
  // projection keeps it and dedupes the persisted copy once the DB catches up.
  // Runs at most once, and never when streaming was observed (that path
  // promotes via the settled edge).
  const adoptedRef = useRef(false)
  useEffect(() => {
    if (adoptedRef.current || everPromptingRef.current) return
    if (connStatus == null || connStatus === "prompting") return
    if (liveMessage == null) return
    adoptedRef.current = true
    setLiveMessage(conversationId, liveMessage, true)
    completeTurn(conversationId, liveMessage)
    startMetadataSync()
  }, [
    connStatus,
    liveMessage,
    conversationId,
    setLiveMessage,
    completeTurn,
    startMetadataSync,
  ])

  // Full teardown on viewer close: cancel any in-flight metadata sync, then
  // drop the runtime session so the next open starts from a fresh
  // `fetchDetail` instead of stale bridged state.
  useEffect(() => {
    return () => {
      syncCancelRef.current?.()
      syncCancelRef.current = null
      removeConversation(conversationId)
    }
  }, [conversationId, removeConversation])
}

interface LiveTranscriptViewProps {
  conversationId: number
  /** Live connection to mirror from; null renders the persisted transcript
   *  only. The host attaches/detaches non-delegation connections itself. */
  connectionId: string | null
  agentType: AgentType | null
  /**
   * The kickoff prompt text, known synchronously by the host. Surfaced so the
   * kickoff user turn can be shown immediately while the persisted transcript
   * still lags the live stream (agent CLIs write their JSONL asynchronously).
   */
  kickoffText?: string | null
  /** Pure per-user-turn phase label (see `MessageListView.userTurnHeader`). */
  userTurnHeader?: ((group: ResolvedMessageGroup) => string | null) | null
}

export function LiveTranscriptView({
  conversationId,
  connectionId,
  agentType,
  kickoffText,
  userTurnHeader = null,
}: LiveTranscriptViewProps) {
  const conn = useConnectionStateById(connectionId)
  const connStatus = conn?.status ?? null
  const isStreaming = connStatus === "prompting"

  const { refetchDetail, setLiveOwnsActiveTurn } =
    useConversationRuntimeActions()

  // Enter viewer mode: mark the session live-owned and record the known
  // kickoff text. `getTimelineTurns` then (a) synthesizes the kickoff user
  // turn from this text while the persisted transcript still lags the live
  // stream, so the user message shows immediately, and (b) strips the
  // persisted copy of the reply while the live/local reply is present, so it
  // never duplicates the stream. Re-applies if `kickoffText` resolves late
  // (harmless).
  useEffect(() => {
    setLiveOwnsActiveTurn(conversationId, true, kickoffText ?? null)
  }, [conversationId, kickoffText, setLiveOwnsActiveTurn])

  // Single persisted-detail fetch on mount, always `preserveLive: true` so the
  // bridged/promoted reply is never wiped — the render-time projection above
  // handles dedup against the persisted copy. No settle-time refetch: when the
  // session finishes, `completeTurn` promotes its (complete) live reply into
  // localTurns, which the projection keeps showing; replacing it from the DB
  // would race the still-lagging transcript and could blank the reply.
  useEffect(() => {
    refetchDetail(conversationId, { preserveLive: true })
  }, [conversationId, refetchDetail])

  // Reader only — its built-in auto-fetch is disabled; the effect above is
  // the sole fetch path.
  const { loading, error, acpLoadError } = useConversationDetail(
    conversationId,
    { enabled: false }
  )

  // While streaming, mask loading as false: the live bridge owns the reply and
  // the synthesized kickoff covers the user turn, so we don't want a skeleton
  // over the live stream. Passed to MessageListView only.
  const detailLoading = isStreaming ? false : loading

  useLiveTranscriptBridge(conversationId, conn)

  // The session runs with the user's configured permission level, so it may
  // raise a permission request; it may also call the codeg-mcp
  // `ask_user_question` tool or (Grok) `exit_plan_mode`. All three are
  // blocking prompts resolved WITHOUT driving a new turn — route the answers
  // through the viewed connection id. The legacy free-text `pendingQuestion`
  // path is intentionally NOT hosted here: it is answered by sending a prompt,
  // which a read-only viewer deliberately cannot do.
  const { respondPermission, answerQuestion, answerPlanApproval } =
    useAcpActions()
  const pendingPermission = conn?.pendingPermission ?? null
  const onRespondPermission = useCallback(
    (requestId: string, optionId: string) => {
      if (!connectionId) return
      void respondPermission(connectionId, requestId, optionId)
    },
    [connectionId, respondPermission]
  )

  const pendingAskQuestion = conn?.pendingAskQuestion ?? null
  const onAnswerAskQuestion = useCallback(
    (questionId: string, answer: QuestionAnswer) => {
      if (!connectionId) return
      return answerQuestion(connectionId, questionId, answer)
    },
    [connectionId, answerQuestion]
  )

  const pendingPlanApproval = conn?.pendingPlanApproval ?? null
  const onAnswerPlanApproval = useCallback(
    (approvalId: string, answer: PlanApprovalAnswer) => {
      if (!connectionId) return
      return answerPlanApproval(connectionId, approvalId, answer)
    },
    [connectionId, answerPlanApproval]
  )

  return (
    // Sized as a flex child: fills the host column's remaining height under
    // its header (h-full here would overflow by the header's height).
    <div className="flex min-h-0 flex-1 flex-col">
      {pendingPermission && (
        <div className="border-b border-border px-4 py-3">
          <PermissionDialog
            permission={pendingPermission}
            onRespond={onRespondPermission}
            agentType={agentType}
          />
        </div>
      )}
      {connectionId &&
        pendingAskQuestion &&
        pendingAskQuestion.questions.length > 0 && (
          <div className="border-b border-border px-4 py-3">
            <AskQuestionCard
              question={pendingAskQuestion}
              onAnswer={onAnswerAskQuestion}
            />
          </div>
        )}
      {connectionId && pendingPlanApproval && (
        <div className="border-b border-border px-4 py-3">
          <PlanApprovalCard
            key={pendingPlanApproval.approval_id}
            approval={pendingPlanApproval}
            onAnswer={onAnswerPlanApproval}
          />
        </div>
      )}
      {/* No padding of its own. `MessageListView` insets its own content —
          every virtualized row is wrapped in `mx-auto max-w-3xl px-4` and the
          virtualizer adds 16px above the first row and below the last — so a
          padded wrapper here doubled it, and in a panel this narrow the two
          layers cost the transcript a visible chunk of its width. This is
          exactly how the main conversation panel mounts the same component. */}
      <div className="min-h-0 flex-1">
        <MessageListView
          conversationId={conversationId}
          // The viewed connection's own cwd. A delegation child runs in a
          // scratch dir whose folder row this client may not have seen yet
          // (it is created closed, without a folder-change broadcast), so the
          // folder lookup would come up empty; `undefined` when there is no
          // live connection keeps that lookup as the fallback.
          imageRoot={conn?.workingDir ?? undefined}
          agentType={agentType ?? "claude_code"}
          connStatus={connStatus}
          isActive={false}
          detailLoading={detailLoading}
          detailError={error}
          acpLoadError={acpLoadError}
          hideEmptyState={false}
          showMessageNav={false}
          userTurnHeader={userTurnHeader}
        />
      </div>
    </div>
  )
}
