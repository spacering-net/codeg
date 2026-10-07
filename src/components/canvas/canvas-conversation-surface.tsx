"use client"

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react"
import { useTranslations } from "next-intl"
import { AgentSelector } from "@/components/chat/agent-selector"
import { ConversationShell } from "@/components/chat/conversation-shell"
import type { ConversationFolderPickerOverride } from "@/components/chat/conversation-context-bar"
import { MessageListView } from "@/components/message/message-list-view"
import { useAcpActions } from "@/contexts/acp-connections-context"
import { useConnectionLifecycle } from "@/hooks/use-connection-lifecycle"
import { useConversationDetail } from "@/hooks/use-conversation-detail"
import {
  acpStopAsyncTask,
  createChatConversation,
  createConversation,
  createChatDir,
} from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"
import { notify } from "@/lib/notify"
import { getAgentLabel } from "@/lib/custom-agents"
import {
  extractUserImagesFromDraft,
  getPromptDraftDisplayText,
  promptDraftTitleSeed,
} from "@/lib/prompt-draft"
import {
  getSavedModeId,
  saveModePreference,
} from "@/lib/selector-prefs-storage"
import type {
  AgentType,
  ContentBlock,
  MessageTurn,
  PlanApprovalAnswer,
  PromptDraft,
  QuestionAnswer,
} from "@/lib/types"
import { cn, randomUUID } from "@/lib/utils"
import { userPromptHistory } from "@/lib/composer-history"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"
import {
  getTimelineTurns,
  useConversationRuntimeActions,
  useConversationRuntimeStore,
} from "@/stores/conversation-runtime-store"
import { useShallow } from "zustand/react/shallow"

/**
 * A live conversation rendered INSIDE a canvas card: transcript, composer,
 * streaming reply, permission / question / plan-approval prompts, and the
 * mode & config selectors.
 *
 * It is deliberately NOT `ConversationTabView` (conversation-detail-panel.tsx),
 * which is welded to the tab store — it resolves its folder from its own tab
 * row, binds drafts through `bindConversationTab`, and pins/closes tabs. A
 * canvas card has no tab. Instead this composes the SAME primitives that view
 * is built from, so the behaviour that matters is shared code rather than a
 * copy:
 *
 *   `useConnectionLifecycle`  connect / send / cancel / respond-permission
 *   `useConversationDetail`   the persisted transcript
 *   `registerLiveMessageSink` streaming deltas → the runtime store
 *   `MessageListView`         the transcript (reads turns by conversation id)
 *   `ConversationShell`       composer + the three interrupt dialogs
 *
 * What it deliberately leaves out: the message queue, live-feedback steering,
 * transcript export and the welcome-page quick actions. Those belong
 * to the full workspace surface, which the card's "open in workspace" menu
 * entry is one click away from.
 *
 * `contextKey` is the ACP connection key and must be STABLE for the card's
 * lifetime; when this conversation is also open in a workspace tab, the two
 * keys differ and the second one attaches to the first's connection as a
 * co-controlling viewer (see the discovery gate in `acp-connections-context`).
 */

// Matches the repo's other pre-paint effects (`agent-selector`,
// `use-reference-search`): the same hook, minus the warning under the static
// export's prerender, where there is no layout to read.
const useIsomorphicLayoutEffect =
  typeof window !== "undefined" ? useLayoutEffect : useEffect

/** Where an unsent draft card will create its conversation. */
export type CanvasDraftTarget =
  | { kind: "folder"; folderId: number; workingDir: string }
  | { kind: "chat" }

interface CanvasConversationSurfaceProps {
  contextKey: string
  /** Persisted conversation, or `null` for a draft that hasn't been sent yet. */
  conversationId: number | null
  agentType: AgentType
  /** Draft cards let the user switch agents before the first send. */
  onAgentTypeChange?: (agentType: AgentType) => void
  /** Draft cards only — where the conversation will be created. */
  draftTarget?: CanvasDraftTarget
  /**
   * Fired once the draft's first send created the row, so the canvas can
   * persist the card as a real `kind=conversation` node and drop the draft.
   */
  onConversationCreated?: (conversationId: number, folderId: number) => void
  /**
   * True while the first send is minting the conversation row. The draft card
   * hides its discard button for that window — the row and the prompt are
   * already in flight and cannot be recalled.
   */
  onCreatingChange?: (creating: boolean) => void
  /** Keep a text selection from this card's transcript as a note on the board.
   *  Omitted where the caller has no geometry to place one (draft cards), and
   *  the bubble then simply doesn't offer it. MUST be referentially stable. */
  onSaveSelectionAsNote?: (text: string) => void
  /**
   * Identity + switching for the folder chip under the composer. A canvas card
   * has no tab, and without this the chip resolves the workspace's ACTIVE tab
   * instead — every card showed that tab's folder and switching moved that tab.
   */
  folderPickerOverride?: ConversationFolderPickerOverride
  /** Focus/priority hint for the connection lifecycle and the transcript. */
  isActive?: boolean
  className?: string
}

/**
 * Stable negative runtime key for a draft (mirrors `ConversationTabView`'s
 * `buildVirtualConversationId`): the runtime session must exist before the row
 * does, and it must not move when the row arrives.
 *
 * Seeded on the CONTEXT KEY rather than on the draft's own id because the two
 * cards involved in a first send are not the same card. The draft's transcript
 * — the optimistic user turn, the reply in flight, `awaiting_persist` — lives
 * under this id, and the pinned card that replaces it mounts on the real
 * conversation id. That card INHERITS the draft's context key (see
 * `materializeDraft`), so this function is how the hand-off names the session
 * it has to carry over. Exported for exactly that one caller.
 */
export function draftRuntimeConversationId(contextKey: string): number {
  let hash = 0
  for (let i = 0; i < contextKey.length; i += 1) {
    hash = (hash * 31 + contextKey.charCodeAt(i)) | 0
  }
  return -(Math.abs(hash) + 1)
}

function buildOptimisticUserTurn(draft: PromptDraft, fallback: string) {
  const text = getPromptDraftDisplayText(draft, fallback)
  const blocks: ContentBlock[] = []
  for (const image of extractUserImagesFromDraft(draft)) {
    blocks.push({
      type: "image",
      data: image.data,
      mime_type: image.mime_type,
      uri: image.uri ?? null,
    })
  }
  blocks.push({ type: "text", text })
  return {
    id: `optimistic-${randomUUID()}`,
    role: "user",
    blocks,
    timestamp: new Date().toISOString(),
  } satisfies MessageTurn
}

export function CanvasConversationSurface({
  contextKey,
  conversationId,
  agentType,
  onAgentTypeChange,
  draftTarget,
  onConversationCreated,
  onCreatingChange,
  onSaveSelectionAsNote,
  folderPickerOverride,
  isActive = true,
  className,
}: CanvasConversationSurfaceProps) {
  const t = useTranslations("Canvas")
  const sharedT = useTranslations("Folder.chat.shared")
  const tAsyncTasks = useTranslations("Folder.chat.asyncTasks")
  const acpActions = useAcpActions()
  const {
    appendOptimisticTurn,
    removeOptimisticTurn,
    completeTurn,
    migrateConversation,
    refetchDetail,
    setDbConversationId,
    setExternalId,
    setLiveMessage,
    setSyncState,
    syncTurnMetadata,
  } = useConversationRuntimeActions()
  const refreshConversations = useAppWorkspaceStore(
    (s) => s.refreshConversations
  )
  const upsertFolder = useAppWorkspaceStore((s) => s.upsertFolder)

  // Fixed at mount, like the tab view's: a draft streams under a virtual id and
  // must keep it after the real row lands, or the live turn loses its session.
  const [effectiveConversationId] = useState(
    () => conversationId ?? draftRuntimeConversationId(contextKey)
  )
  // Whether this card is RE-ENTERING a runtime session some earlier surface
  // already loaded, rather than opening one cold — see the repair effect below.
  // Read at mount, before the hand-off effect can create one, so a card
  // arriving from a draft (whose session is still filed under the draft's
  // virtual id) correctly reads false and is left alone.
  const [reEnteringSession] = useState(
    () =>
      conversationId != null &&
      useConversationRuntimeStore
        .getState()
        .byConversationId.get(conversationId)?.detail != null
  )
  const [createdConversationId, setCreatedConversationId] = useState<
    number | null
  >(null)
  const dbConversationId = conversationId ?? createdConversationId
  const dbConversationIdRef = useRef(dbConversationId)
  useEffect(() => {
    dbConversationIdRef.current = dbConversationId
  }, [dbConversationId])

  /**
   * Adopt the session a draft was streaming into, if this card is the one that
   * replaced it.
   *
   * A pinned card minted by a first send INHERITS the draft's connection key
   * (see `materializeDraft`), and the draft ran under the runtime id that key
   * derives — there was no row yet when the user hit send, so the message they
   * sent, the reply already answering it, and the `awaiting_persist` that keeps
   * the next detail fetch from overwriting either, are all still filed under
   * it. Without this the card mounts on an empty session: the transcript says
   * there are no messages yet, and since the live sink follows the connection
   * key, the agent's answer arrives on its own with the user's message missing.
   *
   * It belongs HERE, in the arriving card, and not in the swap that creates it.
   * ReactFlow applies a changed `nodes` prop from a PASSIVE effect
   * (`StoreUpdater`), so the draft card outlives the render that drops it from
   * the board's node list — and a browser paint can fall in that gap. Moving
   * the session out any earlier empties it under a card that is still on
   * screen, which paints exactly the "no messages yet" this repairs.
   *
   * A layout effect lands it before this card's own first paint. Cards that
   * never were drafts name a session that was never created, and the reducer
   * ignores those; running twice is likewise a no-op, since the second call
   * finds nothing to move.
   */
  useIsomorphicLayoutEffect(() => {
    if (conversationId == null) return
    migrateConversation(
      draftRuntimeConversationId(contextKey),
      effectiveConversationId
    )
  }, [contextKey, conversationId, effectiveConversationId, migrateConversation])

  const [modeId, setModeId] = useState<string | null>(() =>
    getSavedModeId(agentType)
  )
  const [sendSignal, setSendSignal] = useState(0)
  const creatingRef = useRef(false)
  // Mirrors `creatingRef` as state, purely so the card can refuse to be thrown
  // away mid-creation: the row is already being written and the prompt is
  // already on its way, so a discard here would leave a conversation nobody can
  // see and an agent nobody asked to run.
  const [creating, setCreating] = useState(false)
  useEffect(() => {
    onCreatingChange?.(creating)
  }, [creating, onCreatingChange])
  // Draft cards mint their chat scratch dir once, so the ACP cwd never moves
  // between the eager connect and the first send.
  const chatDirRef = useRef<string | null>(null)
  const [chatDir, setChatDir] = useState<string | null>(null)

  const {
    detail,
    loading: detailLoading,
    error: detailError,
    acpLoadError,
  } = useConversationDetail(effectiveConversationId)

  const { externalId: runtimeExternalId } = useConversationRuntimeStore(
    useShallow((s) => ({
      externalId: s.byConversationId.get(effectiveConversationId)?.externalId,
    }))
  )
  const externalId =
    detail?.summary.external_id ?? runtimeExternalId ?? undefined

  // A persisted conversation must not connect before its stored session id has
  // arrived. `sessionId: undefined` makes the backend take `session/new`, and
  // the next prompt overwrites `external_id` with that fresh session — the
  // history the card is displaying is orphaned to an agent nobody can reach
  // again. The tab view gates on the same condition; a canvas card needs it
  // MORE, because a dormant card's detail fetch is still in flight at the
  // moment the user's first touch flips it live. cline can't resume a session
  // at all, so it never waits. A failed fetch waits forever rather than
  // guessing: the error is already on screen with a retry.
  const awaitingHistoricalSessionId =
    dbConversationId != null &&
    agentType !== "cline" &&
    (detailLoading || detailError != null || acpLoadError != null) &&
    externalId == null

  const summary = useAppWorkspaceStore((s) =>
    dbConversationId != null
      ? (s.conversations.find((c) => c.id === dbConversationId) ?? null)
      : null
  )
  const boundFolderId = summary?.folder_id ?? null
  const folderPath = useAppWorkspaceStore((s) => {
    const id =
      boundFolderId ??
      (draftTarget?.kind === "folder" ? draftTarget.folderId : null)
    return id != null
      ? (s.allFolders.find((f) => f.id === id)?.path ?? null)
      : null
  })

  const workingDir =
    folderPath ??
    (draftTarget?.kind === "folder" ? draftTarget.workingDir : null) ??
    chatDir ??
    undefined

  // A folderless draft needs its scratch dir before the connection can be
  // established at all — mint it once, eagerly. Gated on `isActive` because a
  // draft card restored from a previous visit is dormant: minting there would
  // leave a fresh scratch directory on disk on every single canvas visit, for a
  // card the user may never touch again.
  useEffect(() => {
    if (!isActive) return
    if (draftTarget?.kind !== "chat") return
    if (chatDirRef.current != null) return
    let cancelled = false
    void (async () => {
      try {
        const dir = await createChatDir()
        if (cancelled) return
        chatDirRef.current = dir.path
        setChatDir(dir.path)
      } catch (e) {
        console.error("[canvas] prepare chat dir:", e)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [draftTarget?.kind, isActive])

  const {
    conn,
    modeLoading,
    configOptionsLoading,
    selectorsLoading,
    handleFocus,
    handleSend: lifecycleSend,
    handleSetConfigOption,
    handleCancel,
    handleRespondPermission,
  } = useConnectionLifecycle({
    contextKey,
    agentType,
    // Without a cwd there is nothing to connect to yet (a chat draft before its
    // scratch dir lands); auto-connect would fire with an undefined dir.
    isActive: isActive && workingDir != null && !awaitingHistoricalSessionId,
    // The historical-session wait is a WAIT, not idleness — surface it so the
    // card's composer shows selector placeholders instead of a bare row (the
    // cwd wait has nothing to report: a dormant draft card isn't opening).
    preparing: isActive && awaitingHistoricalSessionId,
    workingDir,
    sessionId:
      dbConversationId != null && agentType !== "cline"
        ? externalId
        : undefined,
    // Cross-surface viewer attach: when this conversation is already live on
    // another surface (a workspace tab, another window), join that connection
    // instead of spawning a second agent for the same session.
    conversationId: dbConversationId ?? undefined,
  })
  const connStatus = conn.status
  const connSessionId = conn.sessionId

  /**
   * Re-entry repair: let the database have the last word on a session this
   * card is coming back to.
   *
   * The canvas is a full-page route, so leaving it for the tasks or token page
   * UNMOUNTS every card, while the workspace's own tabs are merely hidden. A
   * card therefore has to survive its conversation moving on without it, and
   * the runtime session it leaves behind does not:
   *
   *   - the live-message sink is registered by THIS component, so `liveMessage`
   *     stops advancing the instant the card unmounts while the agent keeps
   *     streaming. The global `turn_complete` handler that promotes turns for
   *     conversations with no tab open then drains that frozen partial into
   *     `localTurns`, where it masks the complete persisted reply;
   *   - `awaiting_persist`, pinned by the send, is cleared only by a completion
   *     this client observed — a turn that ends unwatched, or dies with its
   *     connection and emits no completion at all, leaves it pinned with the
   *     optimistic user turn duplicated underneath;
   *   - and `useConversationDetail` never re-fetches a detail it already holds,
   *     so none of it heals. Collapsing and re-expanding the card, or coming
   *     back tomorrow, shows the same truncated transcript until the app
   *     restarts.
   *
   * Unpinning `awaiting_persist` first is what lets `FETCH_DETAIL_SUCCESS`
   * replace those buffers, and it re-arms the `SET_LIVE_MESSAGE` guard against
   * the settled replay a reconnect pushes — which is why this effect is
   * declared ABOVE the sink registration below, whose setup replays that very
   * message. It is gated on this card's own connection not being the one
   * prompting, because then the send really is still in flight. A turn running
   * anywhere ELSE is protected by the fetch itself: the backend stamps
   * `in_flight_user_turn_id` on a mid-turn detail and the reducer keeps every
   * live buffer for those — so a reply streaming in right now survives this
   * untouched, and only a settled one is replaced.
   *
   * The one state neither guard covers is a prompt that has left `handleSend`
   * but not yet reached the backend: `sendPrompt` does not set `prompting`
   * optimistically, and the detail cannot be marked in-flight for a turn nobody
   * has been told about. Re-entering THERE would clear the optimistic echo of a
   * message that is on its way. Reaching it means leaving the canvas and coming
   * back inside a single `acp_prompt` round trip — two deliberate navigations,
   * milliseconds apart — and the message itself is not lost either way, since
   * the backend goes on to persist it and the next fetch shows it. Closing it
   * would take a send timestamp the runtime store does not keep; it is left
   * open knowingly rather than by omission.
   *
   * Latching after ONE pass — even a pass that found the card's own connection
   * prompting and so left the pin alone — is likewise deliberate. This is the
   * fallback for turns that ended while the card was ABSENT; a turn that ends
   * while it is MOUNTED is settled by the prompting → idle edge below, which
   * fires for a connection that was removed as readily as one that finished
   * (`useConnection` reports a missing entry as `status: null`). Retrying here
   * would only race that.
   */
  const repairedRef = useRef(false)
  useEffect(() => {
    if (!reEnteringSession || repairedRef.current) return
    repairedRef.current = true
    const session = useConversationRuntimeStore
      .getState()
      .byConversationId.get(effectiveConversationId)
    if (
      session?.syncState === "awaiting_persist" &&
      connStatus !== "prompting"
    ) {
      setSyncState(effectiveConversationId, "idle")
    }
    refetchDetail(effectiveConversationId)
  }, [
    connStatus,
    effectiveConversationId,
    reEnteringSession,
    refetchDetail,
    setSyncState,
  ])

  // Streaming deltas → runtime store, keyed by the CONNECTION and written into
  // this card's runtime session. Registered per contextKey, so a workspace tab
  // showing the same conversation keeps its own sink; both write the same data.
  useEffect(() => {
    return acpActions.registerLiveMessageSink(
      contextKey,
      (liveMessage, isLive) =>
        setLiveMessage(effectiveConversationId, liveMessage, isLive)
    )
  }, [acpActions, contextKey, effectiveConversationId, setLiveMessage])

  // Mirror the resolved session id into the runtime store so a reconnect
  // resumes the same agent session instead of falling back to session/new.
  useEffect(() => {
    if (!connSessionId) return
    setExternalId(effectiveConversationId, connSessionId)
  }, [connSessionId, effectiveConversationId, setExternalId])

  // Promote the finished turn on the prompting → idle edge, then refresh the
  // per-turn metadata (token counts, duration) the summary row shows.
  const prevStatusRef = useRef(connStatus)
  const syncCancelRef = useRef<(() => void) | null>(null)
  useEffect(() => {
    const wasPrompting = prevStatusRef.current === "prompting"
    prevStatusRef.current = connStatus
    if (!wasPrompting || connStatus === "prompting") return
    completeTurn(effectiveConversationId)
    syncCancelRef.current?.()
    syncCancelRef.current = null
    const persistedId = dbConversationIdRef.current
    if (persistedId && persistedId > 0) {
      syncCancelRef.current = syncTurnMetadata(
        persistedId,
        effectiveConversationId
      )
    }
  }, [completeTurn, connStatus, effectiveConversationId, syncTurnMetadata])
  useEffect(() => () => syncCancelRef.current?.(), [])

  const handleModeChange = useCallback(
    (nextModeId: string) => {
      setModeId(nextModeId)
      // The preference stores the whole mode SHAPE, not just the id, so it can
      // be shipped to the backend at connect time.
      if (conn.modes) {
        saveModePreference(agentType, {
          ...conn.modes,
          current_mode_id: nextModeId,
        })
      }
    },
    [agentType, conn.modes]
  )

  const handleSend = useCallback(
    (draft: PromptDraft, selectedModeIdArg?: string | null) => {
      // Bail BEFORE the optimistic turn exists. A second submit while the first
      // one is still minting the conversation row cannot be sent (there is no
      // row to send it against yet), and painting it into the transcript first
      // would leave the user looking at a message that was never delivered and
      // never rolled back.
      const alreadyPersisted = dbConversationIdRef.current != null
      if (!alreadyPersisted && (creatingRef.current || !draftTarget)) return

      const optimisticTurn = buildOptimisticUserTurn(
        draft,
        sharedT("attachedResources")
      )
      appendOptimisticTurn(
        effectiveConversationId,
        optimisticTurn,
        optimisticTurn.id
      )
      setSendSignal((prev) => prev + 1)
      setSyncState(effectiveConversationId, "awaiting_persist")
      // No message queue on this surface: a send the backend bounces (a turn
      // already in flight) rolls back and surfaces as a toast rather than
      // silently parking the draft somewhere the card doesn't render.
      //
      // Rolled back against BOTH ids the turn can be filed under. A rejection
      // is a round trip of its own, so it can land after the row has arrived
      // and the card that replaced this one has adopted the session onto the
      // row id (see the hand-off above). Naming only the id this component
      // mounted with would then no-op on a session that no longer exists and
      // strand the failed message on the card that took over — dimmed, under a
      // typing indicator, with `awaiting_persist` pinned so no refetch clears
      // it either. Both calls ignore a turn that isn't there, so this is
      // unconditional rather than a guess about which one won.
      const onSendFailed = () => {
        removeOptimisticTurn(effectiveConversationId, optimisticTurn.id)
        const persistedId = dbConversationIdRef.current
        if (persistedId != null && persistedId !== effectiveConversationId) {
          removeOptimisticTurn(persistedId, optimisticTurn.id)
        }
      }

      const persistedId = dbConversationIdRef.current
      if (persistedId) {
        lifecycleSend(draft, selectedModeIdArg, {
          folderId: boundFolderId ?? undefined,
          conversationId: persistedId,
          clientMessageId: optimisticTurn.id,
          onTurnInProgress: onSendFailed,
          onSendFailed,
        })
        return
      }

      // Draft: create the row BEFORE the prompt goes out, so the backend adopts
      // it instead of minting a duplicate (same ordering as the tab view). The
      // guard for this branch already ran above, before the optimistic turn.
      if (!draftTarget) return
      creatingRef.current = true
      setCreating(true)
      void (async () => {
        try {
          const title = promptDraftTitleSeed(
            draft,
            sharedT("attachedResources")
          )
          let newId: number
          let sendFolderId: number
          if (draftTarget.kind === "chat") {
            const res = await createChatConversation(
              agentType,
              title || undefined,
              chatDirRef.current ?? undefined
            )
            newId = res.conversationId
            sendFolderId = res.folderId
            // Seed the hidden chat folder so the card's cwd resolves on the
            // next render without waiting for a workspace refresh.
            upsertFolder(res.folder)
          } else {
            newId = await createConversation(
              draftTarget.folderId,
              agentType,
              title || undefined
            )
            sendFolderId = draftTarget.folderId
          }
          dbConversationIdRef.current = newId
          setExternalId(effectiveConversationId, connSessionId ?? null)
          setDbConversationId(effectiveConversationId, newId)
          setCreatedConversationId(newId)
          refreshConversations()
          onConversationCreated?.(newId, sendFolderId)
          lifecycleSend(draft, selectedModeIdArg, {
            folderId: sendFolderId,
            conversationId: newId,
            clientMessageId: optimisticTurn.id,
            onTurnInProgress: onSendFailed,
            onSendFailed,
          })
        } catch (e) {
          console.error("[canvas] create conversation:", e)
          // Restore the pre-send state whole: no ghost turn stuck in
          // awaiting_persist, and the error visible rather than silent — as
          // a notification, like every verdict on a click.
          removeOptimisticTurn(effectiveConversationId, optimisticTurn.id)
          setSyncState(effectiveConversationId, "idle")
          notify({
            level: "error",
            key: `canvas-create-failed:${contextKey}`,
            title: t("createFailed"),
            description: toErrorMessage(e),
          })
        } finally {
          creatingRef.current = false
          setCreating(false)
        }
      })()
    },
    [
      agentType,
      appendOptimisticTurn,
      boundFolderId,
      connSessionId,
      contextKey,
      draftTarget,
      effectiveConversationId,
      lifecycleSend,
      onConversationCreated,
      refreshConversations,
      removeOptimisticTurn,
      setDbConversationId,
      setExternalId,
      setSyncState,
      sharedT,
      t,
      upsertFolder,
    ]
  )

  const handleAnswerQuestion = useCallback(
    (answer: string) => {
      if (connStatus !== "connected") return
      handleSend({
        blocks: [{ type: "text", text: answer }],
        displayText: answer,
      })
    },
    [connStatus, handleSend]
  )

  const handleAnswerAskQuestion = useCallback(
    (questionId: string, answer: QuestionAnswer) =>
      acpActions.answerQuestion(contextKey, questionId, answer),
    [acpActions, contextKey]
  )

  const handleAnswerPlanApproval = useCallback(
    (approvalId: string, answer: PlanApprovalAnswer) =>
      acpActions.answerPlanApproval(contextKey, approvalId, answer),
    [acpActions, contextKey]
  )

  // Client-local, like the conversation panel's — and what lets the muted
  // "recovered" line expire on its own.
  const handleSessionFailureDismiss = useCallback(
    (ids: string[]) => acpActions.dismissSessionFailures(contextKey, ids),
    [acpActions, contextKey]
  )

  /** Stop one AIR async task. `false` (the adapter declined) is surfaced —
   *  a successful stop announces itself by the row leaving the strip, so
   *  silence would be indistinguishable from a click that did nothing. */
  const handleStopAsyncTask = useCallback(
    async (taskId: string) => {
      const connectionId = conn.connectionId
      if (!connectionId) return false
      try {
        const stopped = await acpStopAsyncTask(connectionId, taskId)
        if (!stopped) {
          notify({
            level: "warning",
            key: `async-task-stop:${connectionId}:${taskId}`,
            title: tAsyncTasks("stopDeclined"),
          })
        }
        return stopped
      } catch (err) {
        notify({
          level: "error",
          key: `async-task-stop:${connectionId}:${taskId}`,
          title: tAsyncTasks("stopFailed", { error: toErrorMessage(err) }),
        })
        return false
      }
    },
    [conn.connectionId, tAsyncTasks]
  )

  const connectionModes = useMemo(
    () => conn.modes?.available_modes ?? [],
    [conn.modes]
  )
  const connectionConfigOptions = useMemo(
    () => conn.configOptions ?? [],
    [conn.configOptions]
  )
  const selectedModeId = useMemo(() => {
    if (connectionModes.length === 0) return null
    if (modeId && connectionModes.some((mode) => mode.id === modeId)) {
      return modeId
    }
    return conn.modes?.current_mode_id ?? connectionModes[0]?.id ?? null
  }, [conn.modes, connectionModes, modeId])

  // Arrow-key history source, read lazily on the first Up/Down (see
  // `MessageInput.getSentHistory`) so streaming tokens cost nothing here.
  const getSentHistory = useCallback(
    () =>
      userPromptHistory(
        getTimelineTurns(effectiveConversationId).map((entry) => entry.turn)
      ),
    [effectiveConversationId]
  )

  const isDraft = dbConversationId == null

  return (
    <div className={cn("flex h-full min-h-0 w-full flex-col", className)}>
      {/* `nowheel` keeps the transcript's own scroll from being eaten by the
          canvas zoom. Dragging is already confined to the card's title bar by
          the node's `dragHandle`, so the body needs no `nodrag` — and must not
          have one, or it would be one more thing to remember for every child
          added here later. */}
      <div className="nowheel flex min-h-0 flex-1 flex-col">
        <ConversationShell
          status={connStatus}
          promptCapabilities={conn.promptCapabilities}
          defaultPath={workingDir}
          agentName={getAgentLabel(agentType)}
          claudeApiRetry={conn.claudeApiRetry}
          sessionFailures={conn.sessionFailures}
          onSessionFailureDismiss={handleSessionFailureDismiss}
          asyncTasks={conn.asyncTasks}
          onStopAsyncTask={handleStopAsyncTask}
          pendingPermission={conn.pendingPermission}
          pendingQuestion={conn.pendingQuestion}
          pendingAskQuestion={conn.pendingAskQuestion}
          pendingPlanApproval={conn.pendingPlanApproval}
          onFocus={handleFocus}
          onSend={handleSend}
          onCancel={handleCancel}
          onRespondPermission={handleRespondPermission}
          onAnswerQuestion={handleAnswerQuestion}
          onAnswerAskQuestion={handleAnswerAskQuestion}
          onAnswerPlanApproval={handleAnswerPlanApproval}
          modes={connectionModes}
          configOptions={connectionConfigOptions}
          modeLoading={modeLoading}
          configOptionsLoading={configOptionsLoading}
          selectorsLoading={selectorsLoading}
          selectedModeId={selectedModeId}
          onModeChange={handleModeChange}
          onConfigOptionChange={handleSetConfigOption}
          agentType={agentType}
          availableCommands={conn.availableCommands ?? []}
          draftStorageKey={`canvas-draft:${contextKey}`}
          getSentHistory={getSentHistory}
          // The card's own connection key doubles as its composer scope: the
          // context-usage ring and connection dot in the picker row read it as
          // a contextKey (they showed nothing at all while it was undefined).
          attachmentTabId={contextKey}
          folderPickerOverride={folderPickerOverride}
          isActive={isActive}
        >
          {isDraft && onAgentTypeChange && (
            <div className="flex shrink-0 justify-center border-b border-border/60 px-3 py-2">
              <AgentSelector
                align="center"
                defaultAgentType={agentType}
                onSelect={onAgentTypeChange}
                onFallback={onAgentTypeChange}
                disabled={conn.status === "connecting"}
              />
            </div>
          )}
          <MessageListView
            conversationId={effectiveConversationId}
            // The card's own cwd, which it already knows before any
            // conversation row exists — a draft's first reply has no persisted
            // detail to derive a folder from, so without this its screenshots
            // stay unresolved until a later refetch. `undefined` (never a
            // wrong guess) leaves MessageListView's folder fallback in place.
            imageRoot={workingDir}
            agentType={agentType}
            connStatus={connStatus}
            isActive={isActive}
            sendSignal={sendSignal}
            detailLoading={detailLoading}
            detailError={detailError}
            acpLoadError={acpLoadError}
            hideEmptyState={isDraft}
            showMessageNav={false}
            onSaveNoteSelection={onSaveSelectionAsNote}
          />
        </ConversationShell>
      </div>
    </div>
  )
}
