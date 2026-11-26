"use client"

import {
  shouldSeedConversation,
  useFolderTabsStore,
} from "@/stores/folder-tabs-store"
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  AlertCircle,
  Check,
  Copy,
  Download,
  FileCode,
  FileImage,
  FileText,
  Info,
  Loader2,
  Plus,
  RefreshCw,
  SquarePen,
  X,
} from "lucide-react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import {
  extractPermissionToolCallId,
  getCachedSelectors,
  useAcpActions,
  useAcpEvent,
} from "@/contexts/acp-connections-context"
import { ActivityLiveProvider } from "@/components/message/activity/activity-live-context"
import { SelectionAskComposer } from "@/components/message/selection-ask-composer"
import { formatConversationTitle } from "@/lib/conversation-title"
import { useAskConversationDrawerStore } from "@/stores/ask-conversation-drawer-store"
import { useAcpAgents } from "@/hooks/use-acp-agents"
import { useActiveFolder } from "@/contexts/active-folder-context"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"
import { FolderTabsEmptyState } from "@/components/conversations/folder-tabs-empty-state"
import { useTabActions, useTabStore } from "@/contexts/tab-context"
import {
  groupOfTab,
  useVisibleConversationTabs,
  useVisibleConversationLayout,
  shellGroupOfTab,
  isReparentUnmount,
  reparentedViewRuntimeConversationId,
  trackConversationView,
} from "@/stores/tab-store"
import { computeRects, leafIds } from "@/lib/tab-group-layout"
import { useTaskContext } from "@/contexts/task-context"
import { cn, copyTextToClipboard, randomUUID } from "@/lib/utils"
import { buildQuotedMarkdown } from "@/lib/message-quote"
import { useConnectionLifecycle } from "@/hooks/use-connection-lifecycle"
import { useMessageQueue, type QueuedMessage } from "@/hooks/use-message-queue"
import { useTouchSelectionMenuGuard } from "@/hooks/use-touch-selection-menu-guard"
import {
  MessageListView,
  type LiveRunsSource,
} from "@/components/message/message-list-view"
import {
  GoalControlProvider,
  type GoalControlValue,
} from "@/components/message/goal-control-context"
import { useAdvertisedGoalActions } from "@/hooks/use-goal-actions"
import { ConversationShell } from "@/components/chat/conversation-shell"
import { SessionConfigStaleBanner } from "@/components/chat/session-config-stale-banner"
import { PiProjectTrustBanner } from "@/components/chat/pi-project-trust-banner"
import { FeedbackNotesDisplay } from "@/components/chat/feedback-notes-display"
import { FeedbackDialog } from "@/components/chat/feedback-dialog"
import { AgentDiagnosticsDialog } from "@/components/settings/agent-diagnostics-dialog"
import { useFeedbackEnabled } from "@/hooks/use-feedback-enabled"
import { useSessionFeedback } from "@/hooks/use-session-feedback"
import { AgentSelector } from "@/components/chat/agent-selector"
import { ChatInput } from "@/components/chat/chat-input"
import { WelcomeHero, WelcomeTip } from "@/components/chat/welcome-hero"
import { QuickActions } from "@/components/chat/quick-actions"
import type { ComposerInjectContent } from "@/components/chat/message-input"
import { TileScrollContainer } from "@/components/conversations/tile-scroll-container"
import { stableTabViewOrder } from "@/lib/tab-view-order"
import { GroupSplitHandle } from "@/components/conversations/group-split-handle"
import { OverlayHostHiddenProvider } from "@/components/ui/overlay-host-hidden"
import { ScrollArea } from "@/components/ui/scroll-area"
import { TabBar } from "@/components/tabs/tab-bar"
import { TabDragGhost } from "@/components/tabs/tab-drag-ghost"
import { useSidebarContext } from "@/contexts/sidebar-context"
import { useAuxPanelContext } from "@/contexts/aux-panel-context"
import { useWorkspaceView } from "@/contexts/workspace-context"
import { useIsMobile } from "@/hooks/use-mobile"
import { usePlatform } from "@/hooks/use-platform"
import { useZoomLevel } from "@/hooks/use-appearance"
import { isDesktop } from "@/lib/platform"
import { ChromeReserve } from "@/components/layout/chrome-reserve"
import { leftChromeReserve, rightChromeReserve } from "@/lib/window-chrome"
import {
  acpFork,
  acpStopAsyncTask,
  createChatConversation,
  createChatDir,
  createConversation,
  getFolderConversation,
  openSettingsWindow,
  type PromptRewindTarget,
} from "@/lib/api"
import { isWindowedDetail } from "@/lib/turn-window"
import {
  flushRetryDelayMs,
  isConnectionReady,
  shouldQueueDirectSend,
  shouldRejectDuplicateCreate,
} from "@/lib/queue-flush"
import { TurnBusyError } from "@/lib/turn-busy"
import { deliverQueuedSteer } from "@/lib/queued-steer"
import { toErrorMessage } from "@/lib/app-error"
import { blockingPrompts } from "@/lib/blocking-prompts"
import { notify } from "@/lib/notify"
import {
  claimRuntimeSession,
  getConversationIdByExternalIdFromStore,
  getRuntimeSession,
  getTimelineTurns,
  releaseRuntimeSession,
  useConversationRuntimeActions,
  useConversationRuntimeStore,
} from "@/stores/conversation-runtime-store"
import { useShallow } from "zustand/react/shallow"
import { useConversationDetail } from "@/hooks/use-conversation-detail"
import { useOutOfTurnContentNotice } from "@/hooks/use-out-of-turn-content-notice"
import {
  buildSteerPayload,
  extractUserImagesFromDraft,
  getPromptDraftDisplayText,
  promptDraftTitleSeed,
} from "@/lib/prompt-draft"
import {
  type AgentType,
  type ContentBlock,
  type ConversationStatus,
  type EventEnvelope,
  type MessageTurn,
  type PlanApprovalAnswer,
  type PromptDraft,
  type PromptInputBlock,
  type QuestionAnswer,
  type UserMessageBlock,
} from "@/lib/types"
import {
  lastUserPromptText,
  type SessionFailureAction,
} from "@/lib/session-failures"
import { userPromptHistory } from "@/lib/composer-history"
import { contentBlocksFromUserMessage } from "@/lib/user-message-blocks"
import { getAgentLabel } from "@/lib/custom-agents"
import {
  getSavedModeId,
  saveModePreference,
} from "@/lib/selector-prefs-storage"
import {
  adoptLegacyNewConversationDraft,
  buildConversationDraftStorageKey,
  buildNewConversationDraftStorageKey,
  clearMessageInputDraft,
  saveMessageInputDraft,
} from "@/lib/message-input-draft"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu"
import {
  exportAsHtml,
  exportAsImage,
  exportAsMarkdown,
  ExportTooLongError,
} from "@/lib/export-conversation"
import { useExportLabels } from "@/lib/use-export-labels"
import {
  projectRuntimeSessionDetails,
  resolveActiveSessionDetailsFromSnapshot,
} from "./active-session-details"
import { AskConversationDrawer } from "./ask-conversation-drawer"
import { ConversationDetailHeader } from "./conversation-detail-header"
import { SessionDetailsDialog } from "./session-details-dialog"

interface ConversationTabViewProps {
  tabId: string
  conversationId: number | null
  agentType: AgentType
  workingDir?: string
  isActive: boolean
  /** Drive the composer's flowing active-session border. True only for the
   *  active tab while several sessions are visible (tiled within a group
   *  and/or split across groups) — the places the flow serves as the "which
   *  session is active" cue. Distinct from `isActive`, which also governs
   *  auto-focus/connect and is true even for a lone session. */
  showActiveFlow: boolean
  reloadSignal: number
  /** The split group this view is rendered under. Used ONLY to tell a
   *  reparent (the tab moved to another group — remount, keep the connection)
   *  apart from a real teardown (pane switch / route change — disconnect). */
  groupId: string
  /** Whether this view is actually on screen: the active tab, or every member
   *  of a tiled group. A mounted-but-hidden tab keeps its runtime session
   *  alive, but it must NOT auto-fetch its own detail. Restoring a workspace
   *  with N open tabs used to issue N concurrent `get_folder_conversation`
   *  calls — each one a tail window of up to `TAIL_TURNS_DEFAULT` (120) turns,
   *  so tens of MB across a large tab set — before the user had looked at a
   *  single one of them. A hidden tab now fetches on the first frame it
   *  becomes visible, so the workspace opens fetching only the tabs on screen
   *  (one per split group, or every member of a tiled one) instead of all N.
   *  Only that first load waits: see the fetch gate in the view. */
  isVisible: boolean
}

function buildOptimisticUserTurnFromDraft(
  draft: PromptDraft,
  attachedResourcesFallback: string
): MessageTurn {
  // `draft.displayText` is the composer's full Markdown, which already renders
  // every inline file/resource badge as a `[label](uri)` link (see
  // `referenceToMarkdown`). Re-appending the resource blocks here would duplicate
  // each attached file in the optimistic bubble, so the display text is used
  // as-is — images are the only out-of-band content left to add as blocks.
  const text = getPromptDraftDisplayText(draft, attachedResourcesFallback)

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
  }
}

/** Build a user `MessageTurn` from a broadcast `user_message` (event or
 *  snapshot `pending_user_message`). Used by cross-client VIEWERS to render the
 *  sender's prompt. The turn `id` is the broadcast `message_id` so the runtime
 *  reducer can dedup it idempotently. */
function buildUserTurnFromMessageBlocks(
  messageId: string,
  blocks: UserMessageBlock[]
): MessageTurn {
  return {
    id: messageId,
    role: "user",
    blocks: contentBlocksFromUserMessage(blocks),
    timestamp: new Date().toISOString(),
  }
}

function buildVirtualConversationId(seed: string): number {
  let hash = 0
  for (let i = 0; i < seed.length; i += 1) {
    hash = (hash * 31 + seed.charCodeAt(i)) | 0
  }
  const normalized = Math.abs(hash) + 1
  return -normalized
}

const ConversationTabView = memo(function ConversationTabView({
  tabId,
  conversationId,
  agentType,
  workingDir,
  isActive,
  showActiveFlow,
  reloadSignal,
  groupId,
  isVisible,
}: ConversationTabViewProps) {
  const t = useTranslations("Folder.conversation")
  // Composer-namespace copy for the queue row's click-to-insert outcomes
  // (same keys the composer's own mid-turn send reports).
  const tCmp = useTranslations("Folder.chat.messageInput")
  const tWelcome = useTranslations("Folder.chat.welcomeInputPanel")
  const tDiag = useTranslations("DiagnosticsSettings")
  const sharedT = useTranslations("Folder.chat.shared")
  const tMessageList = useTranslations("Folder.chat.messageList")
  const tAsyncTasks = useTranslations("Folder.chat.asyncTasks")
  const tAskConversations = useTranslations("Folder.askConversations")
  const refreshConversations = useAppWorkspaceStore(
    (s) => s.refreshConversations
  )
  const upsertFolder = useAppWorkspaceStore((s) => s.upsertFolder)
  // Subscribe to ONLY this tab's own row (identified by `tabId`), not the whole
  // `tabs` array — so a sibling tab changing, or a tab-switch (isActive rides in
  // as a prop), never re-renders this keep-alive panel. `find` returns the same
  // object reference across derives until this tab itself changes.
  const ownTab = useTabStore(
    (s) => s.tabs.find((tab) => tab.id === tabId) ?? null
  )
  // Resolve this panel's folder from ITS OWN tab, not the global active folder.
  // A keep-alive panel for a background tab must NOT re-render when the active
  // tab switches to a different folder. For the active tab this equals the old
  // `activeFolderId` (which is itself derived from the active tab's folderId via
  // `syncActiveFolderId`); it also avoids the brief post-switch window where the
  // global `activeFolderId` still lags on the previous tab's folder (same
  // rationale as the per-tab `workingDir` used for the connection below).
  const ownFolderId = ownTab?.folderId ?? null
  const folder = useAppWorkspaceStore((s) =>
    ownFolderId != null
      ? (s.allFolders.find((f) => f.id === ownFolderId) ?? null)
      : null
  )
  const folderId = ownFolderId ?? 0
  const {
    bindConversationTab,
    setChatDraftWorkingDir,
    setTabRuntimeConversationId,
    pinTab,
    openNewConversationTab,
    closeTab,
    confirmDraftAgent,
    setDraftAgentFromFallback,
  } = useTabActions()
  const {
    appendOptimisticTurn,
    removeOptimisticTurn,
    truncateAtTurn,
    markOptimisticUnsent,
    appendViewerUserTurn,
    completeTurn,
    refetchDetail,
    syncTurnMetadata,
    setAcpLoadError,
    setDbConversationId,
    setExternalId,
    setLiveMessage,
    setPendingCleanup,
    setSyncState,
  } = useConversationRuntimeActions()
  const acpActions = useAcpActions()

  // Stable runtime session key — set once at mount, never changes.
  // For new conversations this is a virtual (negative) ID; for existing
  // conversations opened from the sidebar it equals the real DB ID. A view
  // remounted by a reparent carries on with its predecessor's key, which for a
  // tab that started as a draft is still the virtual one (see
  // `reparentedViewRuntimeConversationId`).
  const [effectiveConversationId] = useState(
    () =>
      reparentedViewRuntimeConversationId(useTabStore.getState(), tabId) ??
      conversationId ??
      buildVirtualConversationId(`draft-${tabId}`)
  )
  useEffect(
    () => trackConversationView(tabId, groupId, effectiveConversationId),
    [tabId, groupId, effectiveConversationId]
  )
  const [createdConversationId, setCreatedConversationId] = useState<
    number | null
  >(null)
  const dbConversationId = conversationId ?? createdConversationId
  const [draftAgentType, setDraftAgentType] = useState<AgentType>(agentType)
  const selectedAgent = conversationId != null ? agentType : draftAgentType
  // Seed from localStorage so the React state reflects the user's saved
  // mode for this agent immediately on mount. Without this seed, a reuse-
  // path connect (idle window after a refresh, before the agent is GC'd)
  // would silently fall back to whatever `current_mode_id` the backend
  // happens to be on: `handleModeChange` updates only React state and
  // localStorage, not the agent — the agent gets synced inside
  // `handleSend` by diffing `modeId` against `modes.current_mode_id`.
  // A null seed here means that diff is "agent default vs null", which
  // resolves the displayed mode through `conn.modes.current_mode_id`
  // and never triggers the catch-up `setMode`.
  //
  // Drafts only (codeg#1179): a persisted conversation keeps no local mode
  // pick — its composer reads the connection's recorded pick
  // (`conn.composerModeId`), else the mode the backend restored from the
  // conversation's own stored selection. Seeding it from the per-agent
  // default would import another conversation's mode at the next send.
  const [modeId, setModeId] = useState<string | null>(() =>
    conversationId != null ? null : getSavedModeId(agentType)
  )
  const [sendSignal, setSendSignal] = useState(0)
  const [agentsLoaded, setAgentsLoaded] = useState(false)
  const [usableAgentCount, setUsableAgentCount] = useState(0)
  const [composerDiagnosticsOpen, setComposerDiagnosticsOpen] = useState(false)
  const [agentConnectError, setAgentConnectError] = useState<string | null>(
    null
  )
  const [hasSentMessage, setHasSentMessage] = useState(false)
  // One inbox for everything pushed into this tab's composer from outside it:
  // welcome-page quick actions (replace) and quoted transcript selections
  // (append). Exactly one composer is mounted at a time — the welcome one or the
  // docked one — so a single slot can serve both.
  const [composerInject, setComposerInject] =
    useState<ComposerInjectContent | null>(null)
  // An edited message is between its rewind and its send (see
  // `handleEditUserTurn`). Nothing else may reach the agent meanwhile — it
  // would take the cut session's first turn — so a direct send waits in the
  // queue and the queue's auto-flush holds until the edited message is out.
  const [editInFlight, setEditInFlight] = useState(false)
  const editInFlightRef = useRef(false)
  // Drafts handed back to the composer and not yet taken in. The composer has
  // one inject slot, taken on its next frame; two hand-backs before then would
  // overwrite each other, so they accumulate and go in together.
  const handBackRef = useRef<PromptInputBlock[]>([])
  const handBackToComposer = useCallback((blocks: PromptInputBlock[]) => {
    const pending = handBackRef.current
    const last = pending[pending.length - 1]
    const first = blocks[0]
    // Two texts meet as two paragraphs (a whitespace-only block of its own
    // would be dropped by the composer and glue them together).
    handBackRef.current =
      last?.type === "text" && first?.type === "text"
        ? [
            ...pending.slice(0, -1),
            { type: "text", text: `${last.text}\n\n${first.text}` },
            ...blocks.slice(1),
          ]
        : [...pending, ...blocks]
    setComposerInject({ handBack: handBackRef.current })
  }, [])

  const hasPersistedConversation = dbConversationId != null

  // A folderless chat draft before its first send (chat tab, not yet persisted).
  // Used to trigger the eager scratch-dir prepare below, which gives the draft a
  // real workingDir so the ACP connection can spawn BEFORE the first send — the
  // composer is gated on `connected` like any normal conversation (no offline
  // compose). Once bound it has a persisted row + workingDir and this is false.
  const isChatDraft = useMemo(
    () => ownTab?.isChat === true && !hasPersistedConversation,
    [ownTab, hasPersistedConversation]
  )

  // Expose the runtime session key to the tab so the aux panel (Diff sidebar)
  // can look up live turns even before the DB conversation is created.
  useEffect(() => {
    if (effectiveConversationId !== conversationId) {
      setTabRuntimeConversationId(tabId, effectiveConversationId)
    }
  }, [
    tabId,
    effectiveConversationId,
    conversationId,
    setTabRuntimeConversationId,
  ])

  // Clear pendingCleanup when tab is (re)opened, and take the session back from
  // a release the view just before this one scheduled on it.
  useEffect(() => {
    claimRuntimeSession(effectiveConversationId)
    setPendingCleanup(effectiveConversationId, false)
  }, [effectiveConversationId, setPendingCleanup])

  const latestReloadSignal = useRef(reloadSignal)
  const pendingReloadState = useRef<{
    signal: number
    sawLoading: boolean
  } | null>(null)
  const dbConvIdRef = useRef<number | null>(conversationId)
  const mountedRef = useRef(true)
  const selectedAgentRef = useRef(selectedAgent)
  const createConversationPendingRef = useRef(false)
  // Single-flight guard for the eager scratch-dir prepare (on chat-mode select).
  const prepareChatDirPendingRef = useRef(false)
  const sessionIdRef = useRef<string | null>(null)
  const syncCancelRef = useRef<(() => void) | null>(null)

  useEffect(() => {
    dbConvIdRef.current = dbConversationId
    // Bind the DB row id onto the runtime session when the two ids diverge
    // (draft-started tab: virtual runtime key, row created on first send).
    // `refetchDetail` on the runtime key fetches with this binding — without
    // it, a settle-driven refetch (background task finished) asks the backend
    // for the virtual id and silently fails, leaving stale live turns on
    // screen forever.
    if (
      dbConversationId != null &&
      dbConversationId !== effectiveConversationId
    ) {
      setDbConversationId(effectiveConversationId, dbConversationId)
    }
  }, [dbConversationId, effectiveConversationId, setDbConversationId])

  useEffect(() => {
    selectedAgentRef.current = selectedAgent
  }, [selectedAgent])

  // Eagerly create the chat-mode scratch dir the moment this becomes an unbound
  // chat draft, so the ACP connection can spawn at a real cwd BEFORE the first
  // send — picking "no-folder mode" no longer leaves the agent unconnected.
  // Filesystem-only (writes no DB rows), so the lazy-conversation invariant
  // holds; the first send reuses this dir via createChatConversation(existingDir),
  // keeping the connection's cwd put across the bind. Single-flight and
  // self-disarming: once workingDir lands the guard flips false. openChatModeTab
  // clears workingDir on re-entry, so a fresh dir is prepared each time.
  useEffect(() => {
    if (!isActive || !isChatDraft || workingDir) return
    if (prepareChatDirPendingRef.current) return
    prepareChatDirPendingRef.current = true
    void (async () => {
      try {
        const res = await createChatDir()
        if (mountedRef.current) {
          setChatDraftWorkingDir(tabId, res.path)
        }
      } catch (e) {
        // The composer is gated on a live connection (no offline compose), and
        // the connection needs this scratch dir. If the mkdir fails the draft
        // would otherwise sit with a permanently disabled composer and no
        // explanation — surface it on the welcome screen's error banner so the
        // user can re-enter chat mode to retry.
        console.error("[ConversationTabView] prepare chat dir:", e)
        if (mountedRef.current) {
          setAgentConnectError(tWelcome("prepareSessionFailed"))
        }
      } finally {
        prepareChatDirPendingRef.current = false
      }
    })()
  }, [
    isActive,
    isChatDraft,
    workingDir,
    tabId,
    setChatDraftWorkingDir,
    tWelcome,
  ])

  // Sync the agentType prop into draftAgentType for draft tabs. The prop
  // changes when openNewConversationTab re-points an existing draft at a
  // different folder's default agent (or when any other external mutation
  // updates tab.agentType). Without this mirror, the local draftAgentType
  // would stay frozen at its mount value and the UI/connection would not
  // follow. Persisted conversations read agentType directly from the prop
  // via selectedAgent, so they are unaffected.
  useEffect(() => {
    if (conversationId != null) return
    if (agentType === selectedAgentRef.current) return
    setDraftAgentType(agentType)
    setModeId(getSavedModeId(agentType))
    setAgentConnectError(null)
  }, [agentType, conversationId])

  // Gate the auto-fetch on VISIBILITY, not on mount. Every open tab stays
  // mounted (that is what keeps a background session's stream and scroll state
  // alive), so an ungated hook here would fire one detail fetch per open tab
  // the moment the workspace restores — the N-concurrent-requests /
  // tens-of-MB first paint described on `isVisible`. A hidden tab's effect
  // re-runs when `isVisible` flips true (tab switch, group selection, tiling),
  // which is also the moment its detail is first needed; until then the panel
  // renders an empty transcript behind `invisible`, costing nothing. The
  // render that first shows it already reports `detailLoading` (the hook
  // counts a fetch it is about to start as loading) — that is what keeps
  // `awaitingHistoricalSessionId` below closed on that render. `isActive` is in
  // the gate as well, so that holds without leaning on the tab store always
  // keeping the active tab its group's selected one.
  //
  // Only the FIRST load waits. Once this view has held a detail it fetches the
  // way every view did before the gate, on screen or not. A hidden view can
  // lose its session (closing the sub-agent viewer drops the session it shares
  // with an open tab), and if the tab holds a live connection, the next
  // streamed batch recreates that session with live data and no detail, which
  // `fetchDetail` then never fills in: the tab came back without its history.
  // Refetching straight away, as before, normally starts ahead of that batch.
  // Latched on a held detail rather than on having been shown, so a view
  // remounted while hidden onto a session that is already loaded (a move to
  // another group) keeps it loaded too.
  const [heldDetail, setHeldDetail] = useState(false)
  const {
    detail,
    loading: detailLoading,
    error: detailError,
    acpLoadError,
  } = useConversationDetail(effectiveConversationId, {
    enabled: isVisible || isActive || heldDetail,
  })
  if (detail != null && !heldDetail) setHeldDetail(true)

  // Subscribe to only the fields this panel actually reads from its runtime
  // session — NOT the whole session object. The live-message sink rewrites the
  // session object on every streaming batch (~60/s, via SET_LIVE_MESSAGE); a
  // whole-object selector here would re-render this keep-alive panel (and the
  // composer subtree it wraps) on every streaming token, even though neither of
  // these two fields changes mid-stream. `useShallow` keeps the returned slice
  // reference-stable across batches, so the panel re-renders only when one of
  // them actually changes. (message-list-view subscribes to the session's
  // liveMessage separately to render the live stream; the context indicator
  // reads its own session stats from the runtime store directly.)
  const { externalId: runtimeExternalId, syncState: runtimeSyncState } =
    useConversationRuntimeStore(
      useShallow((s) => {
        const session = s.byConversationId.get(effectiveConversationId)
        return {
          externalId: session?.externalId ?? null,
          syncState: session?.syncState ?? "idle",
        }
      })
    )

  // Session id passed to acp_connect. `runtimeExternalId` is the single
  // resolution point, NOT a fallback behind `detail`: it is fed by BOTH
  // sources — the effect below writes `detail.summary.external_id` into it
  // whenever the DB value changes, and the `connSessionId` effect writes the
  // live session id — so it is always the more recently established of the
  // two. `detail` remains as the fallback for the first render after a cold
  // open, before that effect has run.
  //
  // Ordering it the other way round silently un-forked a conversation. A fork
  // re-points THIS row at S2 and inserts a sibling row holding S1; the panel
  // learns S2 immediately (`setExternalId` from the fork response) but
  // `detail` still holds S1 until its refetch lands. With `detail` winning,
  // the next reconnect asked for S1 — which the new sibling row now owns — so
  // the tab re-homed onto the sibling and the user was looking at the pre-fork
  // history again, `[Fork]` row abandoned. Forking from there forked S1 a
  // second time, which is exactly the chain the conversation table records:
  // each row created at one fork's timestamp, then itself forked at the next.
  // Because the tab landed on a session it had not established, the composer's
  // selectors came back as the agent's defaults too — the reported "model
  // changed after forking".
  //
  // The `detail` fallback still matters for tabs that started as a new
  // conversation: their `effectiveConversationId` is locked to a virtual
  // negative id (line 186's useState initializer runs once),
  // useConversationDetail skips fetching for virtual ids, and `detail` stays
  // null forever — there, `runtimeExternalId` is the ONLY source, and without
  // it every reconnect passes sessionId=undefined → backend takes session/new
  // → DB.external_id is overwritten on the next prompt → original sid
  // orphaned, agent loses prior context.
  const externalId =
    runtimeExternalId ?? detail?.summary.external_id ?? undefined
  // For persisted conversations opened from the sidebar, wait until the
  // session's external_id has been resolved before auto-connecting.
  // Otherwise the auto-connect effect fires with sessionId=undefined and
  // the backend falls back to session/new, orphaning the historical
  // context. cline doesn't support session resume, so it connects
  // immediately regardless.
  //
  // `detailLoading` must already be true on the render a tab turns active,
  // since the auto-connect effect reads this gate from that very render: a
  // restored tab that was hidden has a runtime session but no detail, and its
  // fetch starts only in that render's effects. `useConversationDetail`
  // reports the fetch it is about to start as loading for exactly this.
  const awaitingHistoricalSessionId =
    hasPersistedConversation && selectedAgent !== "cline" && detailLoading
  // Install status of the currently selected agent. An agent can be enabled and
  // platform-available yet have no CLI/SDK installed; selecting one can never
  // connect. Rather than firing a doomed (and racy) auto-connect whose only
  // outcome is a transient "not installed" toast, we skip the connect and
  // surface a persistent install prompt instead (see composerBlockedMessage).
  const { agents: acpAgents } = useAcpAgents()
  const selectedAgentNotInstalled = useMemo(() => {
    const info = acpAgents.find((a) => a.agent_type === selectedAgent)
    return (
      info != null && info.enabled && info.available && !info.installed_version
    )
  }, [acpAgents, selectedAgent])
  // Claude Code / Codex install a separate ACP adapter package rather than the
  // vendor CLI, so the generic "not installed" banner reads as wrong to anyone
  // who has `claude`/`codex` in their terminal. Name the adapter instead.
  const selectedAgentIsAcpAdapter = useMemo(
    () =>
      acpAgents.find((a) => a.agent_type === selectedAgent)?.is_acp_adapter ===
      true,
    [acpAgents, selectedAgent]
  )
  const canAutoConnect =
    (hasPersistedConversation || (agentsLoaded && usableAgentCount > 0)) &&
    !awaitingHistoricalSessionId &&
    // Skip the doomed auto-connect for a not-installed agent ONLY in the draft
    // surfaces, where the persistent install banner explains it instead. A
    // persisted conversation keeps its existing connect-and-surface-the-error
    // behavior (its agent can't be swapped from the picker anyway).
    !(selectedAgentNotInstalled && !hasPersistedConversation) &&
    !(hasPersistedConversation && detailError) &&
    !(hasPersistedConversation && acpLoadError)
  // Draft composer text is keyed PER TAB while unbound: each split group has its
  // own draft, and a single shared key made them overwrite each other. The key
  // survives restarts with the tab id (persisted in the group blob).
  const draftStorageKey = useMemo(() => {
    if (dbConversationId != null) {
      return buildConversationDraftStorageKey(dbConversationId)
    }
    return buildNewConversationDraftStorageKey(tabId)
  }, [dbConversationId, tabId])
  // One-shot handover of the pre-per-tab shared draft, so an in-flight draft
  // isn't stranded by the upgrade (no-ops for every later draft tab).
  useEffect(() => {
    if (dbConversationId != null) return
    adoptLegacyNewConversationDraft(draftStorageKey)
  }, [dbConversationId, draftStorageKey])
  // Use the per-tab workingDir (derived from the tab's own folderId by the
  // parent) rather than the active folder's path — otherwise switching tabs
  // briefly exposes the previous folder's path to the ACP auto-connect
  // effect, and the connection sticks with the wrong cwd.
  const workingDirForConnection = workingDir ?? folder?.path

  const {
    conn,
    modeLoading,
    configOptionsLoading,
    selectorsLoading,
    autoConnectError,
    handleFocus,
    handleSend: lifecycleSend,
    handleSetConfigOption,
    handleCancel,
    handleRespondPermission,
  } = useConnectionLifecycle({
    contextKey: tabId,
    agentType: selectedAgent,
    isActive: isActive && canAutoConnect,
    workingDir: workingDirForConnection,
    sessionId:
      dbConversationId != null && selectedAgent !== "cline"
        ? externalId
        : undefined,
    // Drives cross-client viewer discovery: when another client is already
    // live on this conversation, attach to its connection instead of spawning.
    conversationId: dbConversationId ?? undefined,
    // The auto-connect gate above is a WAIT, not an idle state: report it so the
    // composer and the status bar can show the conversation is opening instead
    // of an empty, connection-less composer. Scoped to the active tab — the
    // status bar is global.
    preparing: isActive && awaitingHistoricalSessionId,
    // A cross-group move / unsplit reparents this view (React remounts it)
    // while the tab stays open — that unmount must not tear the connection
    // down. See `isReparentUnmount` for why "still open" alone is too broad.
    isTransientUnmount: useCallback(
      () => isReparentUnmount(useTabStore.getState(), tabId, groupId),
      [tabId, groupId]
    ),
  })
  const { status: connStatus, sessionId: connSessionId } = conn
  const messageQueue = useMessageQueue()
  const {
    queue: msgQueue,
    enqueue: mqEnqueue,
    requeueFront: mqRequeueFront,
    getQueueLength: mqGetQueueLength,
    dequeue: mqDequeue,
    remove: mqRemove,
    reorder: mqReorder,
    moveToFront: mqMoveToFront,
    updateItem: mqUpdateItem,
    editingItemId: mqEditingItemId,
    startEditing: mqStartEditing,
    cancelEditing: mqCancelEditing,
  } = messageQueue
  const connStatusRef = useRef(connStatus)
  useEffect(() => {
    connStatusRef.current = connStatus
  }, [connStatus])
  const isViewerRef = useRef(conn.isViewer)
  useEffect(() => {
    isViewerRef.current = conn.isViewer
  }, [conn.isViewer])
  // The tab's connection is keyed by a stable tabId, but agent switching is
  // async — and for a not-installed target, connect()'s preflight throws BEFORE
  // it tears down the old connection. So `conn` can still describe the PREVIOUS
  // agent while `selectedAgent` has already advanced. When that's the case we
  // must NOT surface the previous agent's selectors / ready-state as the
  // selected one's: doing so showed the old agent's model + config list and
  // (worse) let a send reach the wrong agent. Reconcile everything the composer
  // reads against `selectedAgent`, falling back to that agent's own cached
  // selectors (empty until it connects).
  const connIsForOtherAgent =
    conn.agentType != null && conn.agentType !== selectedAgent
  const effectiveModes = connIsForOtherAgent
    ? (getCachedSelectors(selectedAgent)?.modes ?? null)
    : conn.modes
  const effectiveConfigOptions = connIsForOtherAgent
    ? (getCachedSelectors(selectedAgent)?.configOptions ?? null)
    : conn.configOptions
  // The live connection is ready for THIS tab only when it's connected AND its
  // cwd matches the tab's intended working dir. A just-retargeted chat draft (or
  // any mid-reconnect) can briefly read a stale "connected" for the PREVIOUS cwd;
  // sending then would deliver the prompt to the wrong agent/workspace. Every
  // direct send gates on this (handleSend), mirroring the flush effect's guard.
  // No-op for normal conversations, whose connected cwd always equals intended.
  // A connection still bound to a different agent is never "ready" for the
  // selected one — it would otherwise let a send reach the previous agent.
  const connectionReady = isConnectionReady(
    connStatus,
    conn.connectedWorkingDir,
    workingDirForConnection,
    conn.agentType,
    selectedAgent
  )
  // Read by the queue auto-flush's deferred timer, which must not act on a
  // readiness reading captured a tick ago.
  const connectionReadyRef = useRef(connectionReady)
  useEffect(() => {
    connectionReadyRef.current = connectionReady
  }, [connectionReady])
  // Present "connecting" to the composer while connected-but-not-ready, so it
  // disables its send affordance instead of inviting a submit handleSend rejects.
  // While the live connection still belongs to a different agent, present the
  // selected agent's real state: "disconnected" when it isn't installed (the
  // install banner explains why), otherwise "connecting" (the switch is in
  // flight). Only ever differs from connStatus during those transient windows.
  const composerConnStatus = connIsForOtherAgent
    ? selectedAgentNotInstalled
      ? "disconnected"
      : "connecting"
    : connStatus === "connected" && !connectionReady
      ? "connecting"
      : connStatus
  const connectionModes = useMemo(
    () => effectiveModes?.available_modes ?? [],
    [effectiveModes]
  )
  const connectionConfigOptions = useMemo(
    () => effectiveConfigOptions ?? [],
    [effectiveConfigOptions]
  )
  // `null` until this tab's agent has advertised (no connection, one still
  // coming up, or one still bound to another agent), never `[]`, which is an
  // answer: the agent offers no commands. The composers read the two alike;
  // the transcript tells them apart, badging from what this agent last
  // advertised in this folder while the list is unknown.
  const connectionCommands = connIsForOtherAgent ? null : conn.availableCommands
  // A persisted conversation follows the backend's record of the composer's
  // pending pick; a draft its local pick (codeg#1179).
  const isPersistedConversation = dbConversationId != null
  // `modeId` stays null for a persisted conversation, except as the fallback
  // when the server predates the composer record (the send applies it then).
  const composerPick = isPersistedConversation
    ? connIsForOtherAgent
      ? null
      : (conn.composerModeId ?? modeId)
    : modeId
  const selectedModeId = useMemo(() => {
    if (connectionModes.length === 0) return null
    if (
      composerPick &&
      connectionModes.some((mode) => mode.id === composerPick)
    ) {
      return composerPick
    }
    return effectiveModes?.current_mode_id ?? connectionModes[0]?.id ?? null
  }, [effectiveModes, connectionModes, composerPick])
  // For the first send's draft → persisted hand-over (read inside an async
  // continuation, after the row exists).
  const draftModeIdRef = useRef(modeId)
  const appliedModeIdRef = useRef(effectiveModes?.current_mode_id ?? null)
  const connRef = useRef(conn)
  useEffect(() => {
    draftModeIdRef.current = modeId
    appliedModeIdRef.current = effectiveModes?.current_mode_id ?? null
    connRef.current = conn
  })
  // Whether a pick here is still a DRAFT's — the only picks that write the
  // new-conversation default. Decided synchronously at pick time: no row id
  // yet AND no row creation in flight (a failed create re-opens it).
  const isDraftForDefaults = useCallback(
    () => dbConvIdRef.current == null && !createConversationPendingRef.current,
    []
  )
  const handleConfigOptionChange = useCallback(
    (configId: string, valueId: string) => {
      // The first send is being admitted: the prompt runs with what was
      // showing at submit.
      if (connRef.current.selectorsLocked) return
      handleSetConfigOption(configId, valueId, {
        saveAsDefault: isDraftForDefaults(),
      })
    },
    [handleSetConfigOption, isDraftForDefaults]
  )
  // Read by the queue auto-flush for items that were queued before this tab knew
  // its modes (it runs from a timer, so it must not close over a stale value).
  const selectedModeIdRef = useRef(selectedModeId)
  useEffect(() => {
    selectedModeIdRef.current = selectedModeId
  }, [selectedModeId])

  // The single blocking message shown in the composer's inline banner (clicking
  // it opens Agent Settings). The not-installed prompt takes priority: it's the
  // actionable one and, unlike the connect-time toast, it's deterministic — it
  // appears the moment a not-installed agent is selected, independent of whether
  // a (deduped/superseded) connect attempt ever reached the preflight.
  const composerBlockedMessage = selectedAgentNotInstalled
    ? tWelcome(
        selectedAgentIsAcpAdapter
          ? "agentAdapterNotInstalled"
          : "agentNotInstalled",
        { agent: getAgentLabel(selectedAgent) }
      )
    : (autoConnectError ?? agentConnectError)

  useEffect(() => {
    if (connSessionId) {
      sessionIdRef.current = connSessionId
    }
  }, [connSessionId])

  // Mirror the connection's load failure (set on `session_load_failed` from
  // the agent) onto the per-conversation runtime session so the detail UI
  // can surface it next to detail-load errors. Cleared automatically when
  // the connection's loadError clears (e.g. via Reload).
  const connLoadError = conn.loadError
  useEffect(() => {
    setAcpLoadError(effectiveConversationId, connLoadError ?? null)
  }, [connLoadError, effectiveConversationId, setAcpLoadError])

  // Promote the completed turn on the prompting→idle edge. (There is no longer
  // an ordering constraint against a setLiveMessage cleanup: the liveMessage
  // sink writes the runtime store from the connection dispatch, not a React
  // effect — see registerLiveMessageSink.)
  const prevConnStatusRef = useRef(connStatus)
  useEffect(() => {
    const wasPrompting = prevConnStatusRef.current === "prompting"
    prevConnStatusRef.current = connStatus
    if (!wasPrompting || connStatus === "prompting") return

    // Turn completed — promote liveMessage + optimisticTurns to localTurns.
    // Don't pass conn.liveMessage: this panel no longer subscribes to it (the
    // connection snapshot is stable across streaming tokens — see useConnection),
    // so reading it here would be stale. COMPLETE_TURN falls back to
    // session.liveMessage, which the connection dispatch's sink wrote
    // synchronously as the final chunk landed (turn_complete flushes the stream
    // queue BEFORE the status change), so it already holds the final message.
    completeTurn(effectiveConversationId)

    // Cancel previous metadata sync (handles rapid consecutive turns)
    syncCancelRef.current?.()
    syncCancelRef.current = null

    const persistedId = dbConvIdRef.current
    if (persistedId && persistedId > 0) {
      syncCancelRef.current = syncTurnMetadata(
        persistedId,
        effectiveConversationId
      )
    }
  }, [completeTurn, connStatus, effectiveConversationId, syncTurnMetadata])

  // Auto-send queued messages when agent finishes responding.
  // Refs are synced via useEffect; the auto-send effect is declared
  // AFTER completeTurn so React runs it second.
  const autoSendQueueRef = useRef<() => QueuedMessage | undefined>(mqDequeue)
  useEffect(() => {
    autoSendQueueRef.current = mqDequeue
  }, [mqDequeue])
  const handleSendRef = useRef<
    (
      draft: PromptDraft,
      modeId?: string | null,
      opts?: { fromQueueFlush?: boolean }
    ) => void
  >(() => {})
  // Timestamp of the last send that bounced with TurnBusyError. The flush below
  // backs off after a bounce so repeated busy rejections (backend still running
  // another turn while this client believes it is idle) don't spin one failed
  // send per round-trip.
  const lastFlushBounceAtRef = useRef(0)
  // Whether a queued row's click-to-insert (`handleQueueSteer`) is mid-flight.
  // The row STAYS in the queue for the whole round-trip — it only leaves once
  // the backend confirms delivery — so without this the turn-end edge would
  // hand the same row to the flush below while the insert is still settling:
  // admitted against the ending turn AND re-sent as the next turn's prompt,
  // i.e. the agent reads the same instruction twice. Holding the flush for one
  // round-trip is enough, and cannot strand the queue: `handleQueueSteer`
  // always clears this in a `finally`, which re-runs the flush effect.
  const [queueSteerInFlight, setQueueSteerInFlight] = useState(false)

  // Flush queued messages whenever the agent is idle. This is the queue's send
  // engine, covering BOTH:
  //   - the normal case: a message queued while the agent was prompting, sent
  //     once the turn completes (prompting→connected drives syncState→idle); and
  //   - a draft re-queued by a bounced concurrent send that landed AFTER the
  //     prompting→connected transition already passed — which an edge-triggered
  //     flush would strand until the next turn.
  // Gated on syncState !== "awaiting_persist" so exactly one item flushes at a
  // time: dequeuing + sending appends an optimistic turn → awaiting_persist,
  // which blocks re-entry until that send settles (the turn completes, or it
  // bounces and rolls back to idle to retry the next item). A bounce backoff
  // rate-limits retries against a still-busy backend.
  useEffect(() => {
    // The SAME readiness predicate `handleSend` gates on — deliberately the one
    // variable, not a re-spelling of it. This effect DEQUEUES before handing the
    // message over, so any gate weaker than the send's own check takes a message
    // off the queue and then watches `handleSend` silently drop it. Bare
    // "connected" is two such weakenings: a just-bound chat conversation can
    // read a stale "connected" for the PREVIOUS cwd, and a draft whose agent was
    // switched keeps the OLD agent's connection live at the same cwd until the
    // lifecycle reconnects — which, for a not-installed target, never happens.
    if (!connectionReady) return
    if (runtimeSyncState === "awaiting_persist") return
    // A row being inserted into the (just-ended) turn is still queued; sending
    // it now would deliver it twice. See `queueSteerInFlight`.
    if (queueSteerInFlight) return
    if (editInFlight) return
    if (msgQueue.length === 0) return
    // setTimeout (not microtask) so a COMPLETE_TURN commit settles first AND so
    // a just-bounced retry waits out the backoff window before re-sending.
    const wait = flushRetryDelayMs(Date.now(), lastFlushBounceAtRef.current)
    const timer = setTimeout(() => {
      if (!connectionReadyRef.current) return
      if (editInFlightRef.current) return
      const next = autoSendQueueRef.current()
      if (next) {
        // Mark this as the queue auto-flush: it sends the dequeued head now and,
        // on a bounce, returns it to the FRONT (vs a direct send → tail).
        //
        // `adoptSendTimeMode` items were queued before this tab could know its
        // modes (an "ask about this selection" prompt parked on a brand-new
        // draft), so they take the mode in effect NOW. A plain `modeId === null`
        // is left alone — that is the answer / plan-notes retry paths saying
        // "don't touch the agent's mode", which is a different intent.
        handleSendRef.current(
          next.draft,
          next.adoptSendTimeMode ? selectedModeIdRef.current : next.modeId,
          { fromQueueFlush: true }
        )
      }
    }, wait)
    return () => clearTimeout(timer)
    // `connectionReady` subsumes connStatus, the connection's cwd and its agent,
    // so it is the only connection dependency this effect needs.
  }, [
    connectionReady,
    runtimeSyncState,
    msgQueue.length,
    queueSteerInFlight,
    editInFlight,
  ])

  // Mirror the connection's liveMessage into the runtime session OUTSIDE React.
  // The connection dispatch invokes this sink synchronously whenever liveMessage
  // changes (streaming deltas, tool updates, the prompt-start reset), so the
  // streaming content flows straight to the runtime store — which the message
  // list renders — WITHOUT this keep-alive panel re-rendering per token (the old
  // mirror effect required a per-token render just to run). The sink writes
  // non-null values with isLive = (status === "prompting"), which tells the
  // runtime reducer to bypass its stale-reconnect-replay guard (matters for the
  // rekey path: close+reopen mid-turn, where detail.turns may already hold user
  // turns that would otherwise drop the live assistant stream). Turn-end clearing
  // is owned by COMPLETE_TURN (nulls liveMessage); unmount clearing by
  // releaseRuntimeSession. `tabId` is the connection contextKey.
  useEffect(() => {
    return acpActions.registerLiveMessageSink(tabId, (liveMessage, isLive) =>
      setLiveMessage(effectiveConversationId, liveMessage, isLive)
    )
  }, [acpActions, tabId, effectiveConversationId, setLiveMessage])

  // Cross-client VIEWER (Bug 2): mirror the connection's in-flight user prompt
  // (from a snapshot's `pending_user_message`, captured when we attach
  // mid-turn) into the runtime as a synthesized user turn. The reducer
  // sender-guards + dedups by id, so this is a no-op on the sender and
  // idempotent against the live `user_message` event below. This branch covers
  // the prompt that was sent BEFORE we attached; the live handler covers
  // prompts sent AFTER.
  useEffect(() => {
    const pending = conn.pendingUserMessage
    if (!pending) return
    appendViewerUserTurn(
      effectiveConversationId,
      buildUserTurnFromMessageBlocks(pending.messageId, pending.blocks)
    )
  }, [conn.pendingUserMessage, effectiveConversationId, appendViewerUserTurn])

  // Cross-client VIEWER (Bug 2): a `user_message` event for THIS connection
  // that arrives while we're attached. The owner added its user turn
  // optimistically; a viewer only receives the assistant stream, so without
  // this the reply would render with no user message above it. Sender-guarded +
  // idempotent in the reducer (the sender's own echo is a no-op).
  useAcpEvent(
    useCallback(
      (envelope: EventEnvelope) => {
        if (envelope.type !== "user_message") return
        if (envelope.connection_id !== conn.connectionId) return
        appendViewerUserTurn(
          effectiveConversationId,
          buildUserTurnFromMessageBlocks(envelope.message_id, envelope.blocks)
        )
      },
      [conn.connectionId, effectiveConversationId, appendViewerUserTurn]
    )
  )

  // A turn the agent runs on its own renders nowhere live; offer a re-read.
  useOutOfTurnContentNotice(tabId, conn.connectionId, effectiveConversationId)

  useEffect(() => {
    if (effectiveConversationId <= 0) return
    // Only ever WRITE a real id — never clear one. `detail` is null while a
    // (re)fetch is in flight, and writing null then would wipe a session id the
    // connSessionId effect below had already resolved. That store value is one
    // of the two sources `externalId` (and therefore the sessionId passed to
    // acp_connect) resolves from, so clearing it can turn a reconnect into
    // session/new and strand the conversation's history. Nothing ever nulls a
    // row's external_id, and switching conversations changes the store key
    // rather than clearing this one, so there is no case that needs the clear.
    const persisted = detail?.summary.external_id
    if (!persisted) return
    setExternalId(effectiveConversationId, persisted)
  }, [effectiveConversationId, detail?.summary.external_id, setExternalId])

  useEffect(() => {
    if (!connSessionId) return
    setExternalId(effectiveConversationId, connSessionId)
  }, [connSessionId, effectiveConversationId, setExternalId])

  useEffect(() => {
    if (dbConversationId == null) return
    if (reloadSignal === latestReloadSignal.current) return
    latestReloadSignal.current = reloadSignal
    pendingReloadState.current = {
      signal: reloadSignal,
      sawLoading: false,
    }
    refetchDetail(dbConversationId)
  }, [dbConversationId, reloadSignal, refetchDetail])

  useEffect(() => {
    const pending = pendingReloadState.current
    if (!pending) return

    if (detailLoading) {
      pending.sawLoading = true
      return
    }

    if (!pending.sawLoading) return

    pendingReloadState.current = null

    if (detailError) {
      toast.error(t("reloadFailed", { message: detailError }))
      return
    }

    toast.success(t("reloaded"))
  }, [detailLoading, detailError, t])

  // Cleanup runtime data on unmount (tab close)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      if (isReparentUnmount(useTabStore.getState(), tabId, groupId)) {
        // Dragging the tab into another group reparents this view: React
        // remounts it under that group's shell while the tab stays open. The
        // connection is already held across that unmount (see
        // `isTransientUnmount` above) and the runtime session has to be held
        // with it — it holds the transcript. Dropping it emptied the message
        // list and nothing brought it back: the remounted view re-registers
        // its live-message sink on the connection it just kept, which recreates
        // the session with a `liveMessage` and no `detail`, and `fetchDetail`
        // skips a session that already has live data. Header, title and
        // composer all read the tab row, so they looked untouched while the
        // transcript stayed blank until the tab was closed and reopened.
        //
        // The post-turn metadata sync is left running for the same reason: it
        // patches the session, not this view, and short of reopening the
        // conversation it is the only thing that lands a live reply's usage,
        // model and fork-point name. Cancelling it here lost them whenever the
        // drag came within its retry window of a reply finishing.
        return
      }
      syncCancelRef.current?.()
      if (connStatusRef.current === "prompting" && !isViewerRef.current) {
        // Owner, agent still responding — keep the session for deferred cleanup
        // (the background turn_complete handler removes it once done).
        setPendingCleanup(effectiveConversationId, true)
      } else {
        // Idle owner, or a VIEWER (any status): remove now rather than on a
        // turn_complete. A viewer's unmount detaches its attach subscription,
        // so no turn_complete will arrive to resolve a deferred cleanup —
        // waiting for one would leak the runtime session (especially in web
        // mode, which has no event firehose after detach). "Now" is the end of
        // this task, so a view mounting straight back onto the session can
        // still claim it (see `releaseRuntimeSession`).
        releaseRuntimeSession(effectiveConversationId)
      }
    }
  }, [effectiveConversationId, groupId, setPendingCleanup, tabId])

  const handleSend = useCallback(
    (
      draft: PromptDraft,
      selectedModeIdArg?: string | null,
      // `fromQueueFlush` marks the auto-flush draining the queue head — that
      // path always sends and, on a bounce, re-queues at the FRONT. A direct
      // input send (no flag) must NOT jump ahead of already-queued items: when
      // a queue exists it tail-enqueues instead of sending, and on a bounce it
      // re-queues at the TAIL.
      //
      // `onSendFailed` runs after the rollback below when the send fails for
      // good — for a caller whose draft lives nowhere else (an edited message:
      // its editor is closed by then). `fromEdit` is that edited message's
      // own send, the one send an edit in flight lets through.
      opts?: {
        fromQueueFlush?: boolean
        fromEdit?: boolean
        onSendFailed?: () => void
        /** The id the optimistic turn (and so the prompt's
         *  `clientMessageId`) takes, for a caller that must know it up front:
         *  the edited message cuts the view to keep exactly it. */
        clientMessageId?: string
        /** An edited message's rewind, done by the backend in the same step
         *  as the send (`acpPrompt`). Persisted conversations only. */
        rewind?: PromptRewindTarget
        /** The agent declined `rewind`: nothing changed, nothing was sent. */
        onRewindRefused?: (reason: string) => void
        /** Replaces the busy bounce's re-queue: a caller that cannot let its
         *  message go out later as an ordinary prompt (an edited message
         *  without its rewind) settles it itself. */
        onTurnInProgress?: () => void
        /** Leave the list where it is (no scroll to the new message): the
         *  edited message's editor must stay mounted until the edit is
         *  answered. The caller scrolls once it went through. */
        noScroll?: boolean
      }
    ): Promise<unknown> | void => {
      // Capture the tab's chat-draft state + eager scratch dir synchronously,
      // before any await. A folderless chat draft is NOT special-cased here:
      // its first send takes the exact same gated, inline path as a normal new
      // conversation (the new-tab branch below just creates the row via
      // createChatConversation, reusing this eager dir). The composer is gated
      // on `connected` for chat drafts too, so by the time we get here the agent
      // is live and the prompt is delivered inline — never parked in the queue.
      const sendOwnTab = ownTab

      if (!hasPersistedConversation && !canAutoConnect) {
        setAgentConnectError(tWelcome("enableAgentFirstPlaceholder"))
        return
      }
      // Connected AND the connection's cwd matches this tab's working dir. Bare
      // `connStatus === "connected"` is not enough: a chat draft mid-reconnect can
      // read a stale "connected" for the old cwd, and an inline send then would
      // deliver to the wrong workspace. Same predicate the flush effect uses.
      if (!connectionReady) return

      // While an edited message is on its way nothing else is sent or queued:
      // if the edit does not go through, a follow-up typed meanwhile must not
      // run ahead of it on its own. The composer takes the draft back whole.
      if (editInFlightRef.current && !opts?.fromEdit) {
        handBackToComposer(draft.blocks)
        return
      }
      const fromQueueFlush = opts?.fromQueueFlush ?? false
      // Preserve FIFO: a direct send issued while the queue is non-empty joins
      // the tail rather than racing ahead of the queued items. Read the
      // queue length synchronously (it reflects a same-tick bounce requeue).
      if (shouldQueueDirectSend(fromQueueFlush, mqGetQueueLength())) {
        mqEnqueue(draft, selectedModeIdArg ?? null)
        return
      }

      // Single-flight the unbound new-tab create. A second direct submit fired
      // before the first create resolves (a double Enter / double click) would
      // otherwise append an optimistic turn it can never deliver: the
      // createConversationPendingRef guard further down returns AFTER the
      // optimistic append. Reject the duplicate here, before any optimistic
      // mutation. Only the unbound path (no persisted id yet) is single-flighted,
      // so persisted sends keep their concurrent queued-send behavior. Applies
      // equally to chat and normal new conversations.
      if (
        shouldRejectDuplicateCreate(
          dbConvIdRef.current != null,
          createConversationPendingRef.current
        )
      ) {
        return
      }

      const builtTurn = buildOptimisticUserTurnFromDraft(
        draft,
        sharedT("attachedResources")
      )
      const optimisticTurn = opts?.clientMessageId
        ? { ...builtTurn, id: opts.clientMessageId }
        : builtTurn
      appendOptimisticTurn(
        effectiveConversationId,
        optimisticTurn,
        optimisticTurn.id
      )
      if (!opts?.noScroll) setSendSignal((prev) => prev + 1)
      setSyncState(effectiveConversationId, "awaiting_persist")
      setHasSentMessage(true)

      // Backend rejected the send because a turn was already in flight (another
      // co-controlling client, or a "prompting" status this client hadn't
      // observed yet). Roll back the optimistic user turn and drop the draft
      // into the queue above the input box — it auto-sends when the current
      // turn completes, identical to enqueuing while already prompting. Stamp
      // the bounce so the flush backs off instead of immediately retrying.
      const onTurnInProgress = () => {
        if (opts?.onTurnInProgress) {
          removeOptimisticTurn(effectiveConversationId, optimisticTurn.id)
          opts.onTurnInProgress()
          return
        }
        lastFlushBounceAtRef.current = Date.now()
        removeOptimisticTurn(effectiveConversationId, optimisticTurn.id)
        // FIFO: the auto-flush draft WAS the queue head → return it to the
        // front; a direct send (queue was empty when it left) → tail.
        if (fromQueueFlush) {
          mqRequeueFront(draft, selectedModeIdArg ?? null)
        } else {
          mqEnqueue(draft, selectedModeIdArg ?? null)
        }
      }

      // Any OTHER send failure (413, image-hydration failure, network drop):
      // the lifecycle hook already toasts the error; here we roll back the
      // optimistic user turn so the failed prompt isn't displayed as though
      // it were sent — and, via REMOVE_OPTIMISTIC_TURN's settle-to-idle, the
      // conversation drops out of `awaiting_persist` so queue auto-flush
      // isn't blocked forever. The draft is NOT re-queued (unlike the busy
      // bounce): a deterministic failure would retry — and toast — forever.
      const onSendFailed = () => {
        removeOptimisticTurn(effectiveConversationId, optimisticTurn.id)
        opts?.onSendFailed?.()
      }

      // Nothing went out: there was no connection to send on by the time the
      // send got to it (a reconnect removed it). The bubble stays where it is,
      // as it always has; the store only notes that it never went out, so an
      // edit does not wait on it (see `handleEditUserTurn`).
      const onNotSent = () =>
        markOptimisticUnsent(effectiveConversationId, optimisticTurn.id)

      // Pin the tab if it was a temporary preview (single-click opened)
      if (ownTab && !ownTab.isPinned) {
        pinTab(tabId)
      }

      const persistedId = dbConvIdRef.current
      if (persistedId) {
        // Existing-tab path: row already exists, send immediately with the
        // conversation_id pinned so the backend reuses our row instead of
        // creating a duplicate.
        return lifecycleSend(draft, selectedModeIdArg, {
          folderId,
          conversationId: persistedId,
          // The backend echoes this as the broadcast UserMessage's message_id,
          // so viewers' synthesized user turn dedups against our own optimistic
          // turn by exact id (and never suppresses a different sender's prompt).
          clientMessageId: optimisticTurn.id,
          rewind: opts?.rewind,
          onRewindRefused: opts?.onRewindRefused
            ? (reason: string) => {
                removeOptimisticTurn(effectiveConversationId, optimisticTurn.id)
                opts.onRewindRefused?.(reason)
              }
            : undefined,
          onNotSent,
          onTurnInProgress,
          onSendFailed,
        })
      }
      // Only a persisted conversation has a message to edit.
      if (opts?.rewind) return

      // New-tab path: create the DB row first, then send with the new id
      // pinned. This prevents the backend's send_prompt_linked from racing
      // us to create its own conversation row. A folderless chat draft creates
      // via createChatConversation (reusing the eager scratch dir) and binds to
      // its hidden chat folder; every other step — the optimistic turn
      // appended above, the inline lifecycleSend, the rollback — is identical to
      // a normal new conversation. This is the whole point of the fix: after the
      // scratch dir exists, chat mode shares the normal send path and never
      // depends on the flush-on-connect queue to deliver its first prompt.
      if (createConversationPendingRef.current) return
      createConversationPendingRef.current = true
      const title = promptDraftTitleSeed(draft, sharedT("attachedResources"))
      const chatSend = sendOwnTab?.isChat === true
      const chatExistingDir = sendOwnTab?.workingDir
      // Lock the selectors for the whole first-send attempt (codeg#1179):
      // the prompt runs with — and the new row records — exactly the
      // selection showing at submit. One `finally` releases it on every exit.
      const firstSendLock = connRef.current.beginFirstSend()
      let handOver: Promise<unknown> | null = null
      // Draft → persisted: hand the draft's mode pick to the connection's
      // composer record in the same step that publishes the row id, so the
      // composer (and a message queued meanwhile) keeps showing it until the
      // agent's mode reached it.
      const handOverDraftMode = () => {
        const pick = draftModeIdRef.current
        if (!pick || pick === appliedModeIdRef.current) {
          // Nothing pending: the persisted conversation follows its
          // connection from here; a leftover local pick would resurface as
          // a stale fallback once a later pick is cleared.
          setModeId(null)
          return
        }
        handOver = connRef.current
          .setComposerMode(pick, { initial: true })
          // Recorded (or vetoed in favour of another surface's pick): the
          // connection's record is the source from now on.
          .then(() => {
            if (mountedRef.current) setModeId(null)
          })
          .catch((e: unknown) =>
            // An older server: keep the local pick, the send applies it.
            console.error("[ConversationTabView] composer hand-over:", e)
          )
      }

      void (async () => {
        try {
          let newConversationId: number
          // The send's folderId defaults to the active folder; a chat send
          // overrides it with the backend-created hidden chat folder.
          let sendFolderId = folderId
          if (chatSend) {
            const res = await createChatConversation(
              selectedAgent,
              title,
              chatExistingDir
            )
            newConversationId = res.conversationId
            sendFolderId = res.folderId
            dbConvIdRef.current = newConversationId
            handOverDraftMode()
            setExternalId(effectiveConversationId, sessionIdRef.current ?? null)
            // Bind the DB id BEFORE the prompt goes out. The mirror effect
            // below also binds, but only after a re-render — this closes that
            // window and covers the unmounted-early return just under it.
            setDbConversationId(effectiveConversationId, newConversationId)
            if (!mountedRef.current) {
              setPendingCleanup(effectiveConversationId, true)
              refreshConversations()
              return
            }
            // Seed allFolders with the hidden chat folder so the tab's new
            // folderId resolves (cwd / active-folder) on the next render. bind
            // reuses the eager scratch dir as workingDir, so the connection's
            // cwd does not move and no reconnect is triggered.
            upsertFolder(res.folder)
            setCreatedConversationId(newConversationId)
            bindConversationTab(
              tabId,
              newConversationId,
              selectedAgent,
              title,
              effectiveConversationId,
              res.folderId,
              res.folder.path
            )
          } else {
            newConversationId = await createConversation(
              folderId,
              selectedAgent,
              title
            )
            dbConvIdRef.current = newConversationId
            handOverDraftMode()
            // Set external ID on the stable virtual session (no migration needed —
            // effectiveConversationId never changes, so the session stays in place).
            // DB persistence of external_id is now backend-driven from
            // send_prompt_linked once the row is linked, so no explicit DB write here.
            setExternalId(effectiveConversationId, sessionIdRef.current ?? null)
            // Bind the DB id BEFORE the prompt goes out (see the chat branch).
            setDbConversationId(effectiveConversationId, newConversationId)
            if (!mountedRef.current) {
              // Component unmounted while creating — mark for deferred cleanup
              // so the background turn_complete handler can clean up later.
              setPendingCleanup(effectiveConversationId, true)
              refreshConversations()
              return
            }
            setCreatedConversationId(newConversationId)
            bindConversationTab(
              tabId,
              newConversationId,
              selectedAgent,
              title,
              effectiveConversationId
            )
          }
          clearMessageInputDraft(buildNewConversationDraftStorageKey(tabId))
          refreshConversations()

          // Now that the row exists, kick off the actual prompt with the
          // conversation_id pinned so the backend adopts our row instead of
          // creating a duplicate one.
          await lifecycleSend(draft, selectedModeIdArg, {
            folderId: sendFolderId,
            conversationId: newConversationId,
            clientMessageId: optimisticTurn.id,
            onNotSent,
            onTurnInProgress,
            onSendFailed,
          })
        } catch (e) {
          console.error("[ConversationTabView] create conversation:", e)
          // A failed create (chat OR normal) must fully restore the pre-send
          // state, not strand the user behind a blank panel:
          //   1. drop the optimistic turn (no ghost stuck in awaiting_persist),
          //   2. return syncState to idle,
          //   3. setHasSentMessage(false) → re-enters welcome mode (otherwise the
          //      welcome screen never returns and the list is empty),
          //   4. re-seed the draft text — message-input clears it synchronously on
          //      send, so without this the user's prompt is lost on failure,
          //   5. surface the error on the welcome banner so it isn't silent.
          removeOptimisticTurn(effectiveConversationId, optimisticTurn.id)
          setSyncState(effectiveConversationId, "idle")
          setHasSentMessage(false)
          const draftText = draft.displayText.trim()
          if (draftText) {
            saveMessageInputDraft(
              buildNewConversationDraftStorageKey(tabId),
              draftText
            )
          }
          if (mountedRef.current) {
            setAgentConnectError(tWelcome("createConversationFailed"))
          }
        } finally {
          createConversationPendingRef.current = false
          if (handOver) await handOver
          connRef.current.releaseFirstSend(firstSendLock)
        }
      })()
    },
    [
      markOptimisticUnsent,
      handBackToComposer,
      appendOptimisticTurn,
      removeOptimisticTurn,
      mqEnqueue,
      mqRequeueFront,
      mqGetQueueLength,
      bindConversationTab,
      canAutoConnect,
      connectionReady,
      effectiveConversationId,
      folderId,
      hasPersistedConversation,
      lifecycleSend,
      pinTab,
      refreshConversations,
      selectedAgent,
      setDbConversationId,
      setExternalId,
      setPendingCleanup,
      setSyncState,
      sharedT,
      ownTab,
      tWelcome,
      tabId,
      upsertFolder,
    ]
  )

  // Sync handleSend ref for auto-send effect (declared before handleSend)
  useEffect(() => {
    handleSendRef.current = handleSend
  }, [handleSend])

  // "Fork from here": fork at a rendered assistant turn, sending nothing. The
  // ONLY fork entry point — the composer's fork-and-send was removed once this
  // existed, since the tail is just one of the turns this can be aimed at.
  //
  // No draft is at stake, so a failure is simply reported: the session is
  // untouched and the same click can be retried, or aimed elsewhere.
  //
  // Which turns the agent can actually name is the backend's call
  // (`resolve_fork_point`): a turn it cannot name forks at the tail rather than
  // failing, so this never has to reason about per-agent identity.
  //
  // Liveness is read off `connStatusRef` rather than captured: this callback is
  // handed to every rendered reply, so taking `connStatus` as a dependency
  // would swap its identity at both ends of every turn and re-render the whole
  // mounted transcript window for nothing. The ref is also the fresher answer
  // at click time.
  const handleForkFromTurn = useCallback(
    async (turnId: string) => {
      const connectionId = conn.connectionId
      if (!connectionId || connStatusRef.current !== "connected") return
      // An edited message is between its rewind and its send: a fork now
      // would move the connection off the session it was cut on (the backend
      // turns it away too, see `RewindHold`).
      if (editInFlightRef.current) return
      // Snapshot which live turns belong to the PRE-fork session, before the
      // await. The fork RPC is a window in which a send can still start — a
      // queued auto-flush, a fast typist, another client — and such a turn
      // legitimately runs on the forked session, so it must not be swept away
      // with the history it isn't part of. Naming the stale turns instead of
      // clearing wholesale is what keeps that distinction.
      //
      // COMPLETED turns only. An optimistic user turn is one whose prompt has
      // not reached the agent yet, and the backend refuses a fork while a turn
      // is in flight (`AcpError::TurnInProgress`) — so a fork that SUCCEEDS
      // proves any optimistic turn standing at this moment never started a
      // turn on the old session, and it will therefore run on the forked one.
      // Sweeping it would erase the user's own message while its reply streams
      // in underneath.
      const preForkSession = useConversationRuntimeStore
        .getState()
        .byConversationId.get(effectiveConversationId)
      const staleLiveTurnIds = (preForkSession?.localTurns ?? []).map(
        (t) => t.id
      )
      try {
        const { forkedSessionId } = await acpFork(
          connectionId,
          dbConvIdRef.current,
          folderId,
          turnId
        )
        sessionIdRef.current = forkedSessionId
        setExternalId(effectiveConversationId, forkedSessionId)
        // The backend's two-row reshuffle: the current row now points at S2
        // and a freshly inserted sibling preserves S1.
        refreshConversations()
        // This row's HISTORY just changed — the whole point is that S2 ends
        // at the chosen turn. The turns rendered right now came
        // from S1 — the persisted detail plus every turn this session streamed
        // — so leaving them would show the fork with the parent's full history
        // until the tab is closed and reopened.
        //
        // The removal rides ON the refetch rather than preceding it, so the
        // two land as one dispatch: no frame shows S2's history beside S1's
        // turns, and a refetch that FAILS removes nothing (it dispatches
        // `FETCH_DETAIL_ERROR`, leaving the timeline as it was rather than
        // stranding the row with neither the old turns nor new ones).
        // `preserveLive` keeps everything else — the point of naming the stale
        // turns is that a reply started during the fork survives.
        refetchDetail(effectiveConversationId, {
          preserveLive: true,
          dropLiveTurnIds: staleLiveTurnIds,
        })
      } catch (err) {
        // A turn in flight is transient here, not a failure to report as one —
        // there is no draft to re-queue, so say so and let the user retry.
        notify({
          level: "error",
          key: `fork-failed:${connectionId}`,
          title:
            err instanceof TurnBusyError
              ? t("forkSessionBusy")
              : t("forkSessionFailed", {
                  error:
                    err instanceof Error
                      ? err.message
                      : typeof err === "object" && err !== null
                        ? JSON.stringify(err)
                        : String(err),
                }),
        })
      }
    },
    [
      conn.connectionId,
      effectiveConversationId,
      folderId,
      refetchDetail,
      refreshConversations,
      setExternalId,
      t,
    ]
  )

  /**
   * Edit a sent message and send it again in its place. The edited text goes
   * out through the ordinary send path carrying a `rewind` target: the backend
   * cuts the agent's session back to just before the message (checked against
   * a fresh parse) and admits the prompt in the same step, then the view is
   * cut the same way. The original message's images go with it: the editor
   * edits only the text.
   *
   * Resolves whether the edit went through; the inline editor stays open
   * otherwise, with what the user typed.
   */
  // The composer queues by itself while a turn runs. During an edit nothing
  // is queued (see `editInFlight`): the draft goes back to the composer.
  const handleComposerEnqueue = useCallback(
    (draft: PromptDraft, modeId?: string | null) => {
      if (editInFlightRef.current) {
        handBackToComposer(draft.blocks)
        return
      }
      mqEnqueue(draft, modeId ?? null)
    },
    [mqEnqueue, handBackToComposer]
  )

  const handleEditUserTurn = useCallback(
    async (turnId: string, text: string): Promise<boolean> => {
      const connectionId = conn.connectionId
      if (!connectionId || connStatusRef.current !== "connected") return false
      // The same readiness the send itself gates on (a connection still in
      // the folder a conversation was moved out of reads "connected").
      if (!connectionReadyRef.current || !dbConvIdRef.current) return false
      if (editInFlightRef.current) return false
      // A send of this tab still on its way: its turn would complete into the
      // middle of the edit (busy otherwise when it reaches the agent).
      const pending = useConversationRuntimeStore
        .getState()
        .byConversationId.get(effectiveConversationId)
      // A bubble whose send never went out (`onNotSent`) is not one — it
      // stays where it is, as it always has.
      const unsentIds = new Set(pending?.unsentOptimisticIds ?? [])
      const optimistic = pending?.optimisticTurns ?? []
      if (optimistic.some((turn) => !unsentIds.has(turn.id))) {
        notify({
          level: "warning",
          key: `edit-message-busy:${connectionId}`,
          title: t("editMessageBusy"),
        })
        return false
      }
      // A queued message would go out on the cut history ahead of the edited
      // one, so the order the user typed in would not survive the edit.
      if (mqGetQueueLength() > 0) {
        notify({
          level: "warning",
          key: `edit-message-queued:${connectionId}`,
          title: t("editMessageQueued"),
        })
        return false
      }
      const target = getTimelineTurns(effectiveConversationId)
        .map((entry) => entry.turn)
        .find((turn) => turn.id === turnId)
      // The agent's own id for the message: the parser's, or the one the
      // post-turn reparse put on a message this session sent.
      const agentMessageId = target?.agent_message_id
      if (!target || target.role !== "user" || !agentMessageId) return false
      const originalText = target.blocks
        .flatMap((block) => (block.type === "text" ? [block.text] : []))
        .join("\n")
      const images = target.blocks.flatMap((block) =>
        block.type === "image"
          ? [
              {
                type: "image" as const,
                data: block.data,
                mime_type: block.mime_type,
                uri: block.uri ?? null,
              },
            ]
          : []
      )
      const clientMessageId = `optimistic-${randomUUID()}`
      const staleLiveTurnIds = (
        useConversationRuntimeStore
          .getState()
          .byConversationId.get(effectiveConversationId)?.localTurns ?? []
      ).map((turn) => turn.id)
      // Written by the send's callbacks (an object, so the reads below are not
      // narrowed to the initial value).
      const result: {
        outcome: "sent" | "refused" | "busy" | "failed"
        reason: string
      } = { outcome: "sent", reason: "other" }
      editInFlightRef.current = true
      setEditInFlight(true)
      try {
        // One request: the backend cuts the agent's session back to just
        // before the message and admits the edited prompt in the same step,
        // under the prompt lock every other prompt, fork and rewind takes —
        // nothing can come between the cut and the edited message.
        const sending = handleSend(
          { blocks: [{ type: "text", text }, ...images], displayText: text },
          selectedModeIdRef.current,
          {
            fromEdit: true,
            noScroll: true,
            // Not behind anything typed while this was on its way.
            fromQueueFlush: true,
            clientMessageId,
            rewind: { agentMessageId, text: originalText },
            onRewindRefused: (reason) => {
              result.outcome = "refused"
              result.reason = reason
            },
            onTurnInProgress: () => {
              result.outcome = "busy"
            },
            // The lifecycle has toasted the failure; the editor keeps the text.
            onSendFailed: () => {
              result.outcome = "failed"
            },
          }
        )
        // No send started at all (a gate in `handleSend` turned it away).
        if (!sending) return false
        await sending
        if (result.outcome === "refused") {
          notify({
            level: "warning",
            key: `edit-message-refused:${connectionId}`,
            title: t("editMessageRefused", { reason: result.reason }),
          })
          return false
        }
        if (result.outcome === "busy") {
          notify({
            level: "warning",
            key: `edit-message-busy:${connectionId}`,
            title: t("editMessageBusy"),
          })
          return false
        }
        if (result.outcome === "failed") return false
        // Sent: the agent's session is cut and the edited message is its turn.
        // Cut the view the same way, keeping the new prompt, and anchor the
        // new batch on what is left (the reparse that names its reply — "fork
        // from here" — pairs from there). Should a reload have renamed the
        // message out from under us, the history comes back from the
        // transcript instead and the batch re-anchors on it.
        const cut = truncateAtTurn(effectiveConversationId, {
          turnId,
          agentMessageId,
          keepFromTurnId: clientMessageId,
          staleLiveTurnIds,
        })
        if (!cut) {
          // The store drops the stale live turns and re-anchors the batch on
          // whichever load lands next; this one makes sure there is one.
          void refetchDetail(effectiveConversationId, { preserveLive: true })
        }
        // Now the edited message is where the conversation goes on.
        setSendSignal((prev) => prev + 1)
        return true
      } finally {
        editInFlightRef.current = false
        setEditInFlight(false)
      }
    },
    [
      conn.connectionId,
      effectiveConversationId,
      handleSend,
      mqGetQueueLength,
      refetchDetail,
      truncateAtTurn,
      t,
    ]
  )

  /** Stop one AIR async task. Returns the adapter's verdict so the row can
   *  release its button; `false` (the adapter declined) is reported, because
   *  nothing else would tell the user their click did nothing — a successful
   *  stop announces itself by the row disappearing. */
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
          title: tAsyncTasks("stopFailed", {
            error: err instanceof Error ? err.message : String(err),
          }),
        })
        return false
      }
    },
    [conn.connectionId, tAsyncTasks]
  )

  /** Turn Claude Code's Remote Control off the way the user would: by sending
   *  `/remote-control off`, which the adapter answers itself. */
  const handleRemoteControlOff = useCallback(() => {
    const command = "/remote-control off"
    handleSend({
      blocks: [{ type: "text", text: command }],
      displayText: command,
    })
  }, [handleSend])

  const handleOpenAgentsSettings = useCallback(() => {
    openSettingsWindow("agents", { agentType: selectedAgent }).catch((err) => {
      console.error(
        "[ConversationTabView] failed to open settings window:",
        err
      )
    })
  }, [selectedAgent])

  // Manual agent switch only updates local draft state. The single source of
  // truth for (dis)connecting is `useConnectionLifecycle`'s auto-connect
  // effect: when `selectedAgent` changes, the hook re-fires `connect()`,
  // which internally disconnects the old agent's connection at the same
  // contextKey before creating the new one (acp-connections-context.tsx).
  // Doing the disconnect+reconnect here too would race the lifecycle path:
  // a late-returning disconnect would dispatch CONNECTION_REMOVED by
  // contextKey and wipe the new connection's frontend state, leaving a
  // backend orphan.
  const handleAgentSelect = useCallback(
    (nextAgentType: AgentType) => {
      if (nextAgentType === selectedAgentRef.current) return
      if (dbConvIdRef.current) return

      setDraftAgentType(nextAgentType)
      setModeId(getSavedModeId(nextAgentType))
      setAgentConnectError(null)
      // Real user click — clear the provisional flag so TabProvider's
      // correction effect leaves this tab alone.
      confirmDraftAgent(tabId, nextAgentType)
    },
    [confirmDraftAgent, tabId]
  )

  // AgentSelector auto-fallback: the requested default agent was missing
  // or unavailable, so it picked a substitute on its own. Sync local UI
  // state (so the connection points at the right agent immediately) but
  // mark the tab as still provisional — TabProvider's correction effect
  // will re-resolve against the folder's saved default once all three
  // hydration gates are open, and overwrite this substitute if needed.
  const handleAgentFallback = useCallback(
    (nextAgentType: AgentType) => {
      if (nextAgentType === selectedAgentRef.current) return
      if (dbConvIdRef.current) return

      setDraftAgentType(nextAgentType)
      setModeId(getSavedModeId(nextAgentType))
      setAgentConnectError(null)
      setDraftAgentFromFallback(tabId, nextAgentType)
    },
    [setDraftAgentFromFallback, tabId]
  )

  const handleModeChange = useCallback(
    (newModeId: string) => {
      if (connRef.current.selectorsLocked) return
      if (!isDraftForDefaults()) {
        // An existing conversation: record the pick on its connection (the
        // backend persists it on the row and every attached client follows);
        // the send applies it. Never the new-conversation default.
        connRef.current.setComposerMode(newModeId).catch((e: unknown) => {
          // An older server without the composer record: keep the pick
          // locally, as before — the send applies it.
          console.error("[ConversationTabView] setComposerMode:", e)
          setModeId(newModeId)
        })
        return
      }
      setModeId(newModeId)
      // A draft's pick IS the new-conversation default. Use effectiveModes
      // (reconciled to selectedAgent) rather than the raw connection modes, so a
      // mode change made during a cross-agent switch window can't save the
      // previous agent's mode shape under the selected agent.
      if (effectiveModes) {
        saveModePreference(selectedAgent, {
          ...effectiveModes,
          current_mode_id: newModeId,
        })
      }
    },
    [effectiveModes, isDraftForDefaults, selectedAgent]
  )

  const handleAnswerQuestion = useCallback(
    (answer: string) => {
      if (connStatus !== "connected") return
      const optimisticTurn: MessageTurn = {
        id: `optimistic-${randomUUID()}`,
        role: "user",
        blocks: [{ type: "text", text: answer }],
        timestamp: new Date().toISOString(),
      }
      const draft: PromptDraft = {
        blocks: [{ type: "text", text: answer }],
        displayText: answer,
      }
      appendOptimisticTurn(
        effectiveConversationId,
        optimisticTurn,
        optimisticTurn.id
      )
      setSendSignal((prev) => prev + 1)
      setSyncState(effectiveConversationId, "awaiting_persist")
      lifecycleSend(draft, null, {
        clientMessageId: optimisticTurn.id,
        // Rejected because a turn was already in flight — roll back the
        // optimistic turn and re-queue so it isn't stranded or lost.
        onTurnInProgress: () => {
          lastFlushBounceAtRef.current = Date.now()
          removeOptimisticTurn(effectiveConversationId, optimisticTurn.id)
          // A direct answer (never dequeued from the queue) re-queues at the
          // TAIL — it was sent after any already-queued items, so FIFO keeps it
          // behind them. (Only the auto-flush path, whose draft WAS the head,
          // re-queues at the front.)
          mqEnqueue(draft, null)
        },
        // Nothing went out (no connection): noted, as on the composer path.
        onNotSent: () =>
          markOptimisticUnsent(effectiveConversationId, optimisticTurn.id),
        // Any other failure: settle the optimistic state (the lifecycle hook
        // already toasted). No re-queue — deterministic failures would loop.
        onSendFailed: () => {
          removeOptimisticTurn(effectiveConversationId, optimisticTurn.id)
        },
      })
    },
    [
      markOptimisticUnsent,
      appendOptimisticTurn,
      removeOptimisticTurn,
      mqEnqueue,
      connStatus,
      effectiveConversationId,
      lifecycleSend,
      setSyncState,
    ]
  )

  // Answer a blocking multiple-choice `ask_user_question`. Routes straight to
  // the dedicated answer endpoint (NOT a prompt) so it resolves the parked tool
  // call; the backend broadcasts `question_resolved` to clear the card on every
  // client.
  const handleAnswerAskQuestion = useCallback(
    (questionId: string, answer: QuestionAnswer) =>
      acpActions.answerQuestion(tabId, questionId, answer),
    [acpActions, tabId]
  )

  // Grok `exit_plan_mode` approval: resolve the blocked ext request. The backend
  // broadcasts `plan_approval_resolved` to clear the card on every client.
  //
  // "Request changes" is special. Grok discards the reply `feedback` on the
  // keep-planning path (confirmed against 0.2.111 — only `approved`/`abandoned`
  // consume it), and its own TUI instead delivers the revision notes as a
  // follow-up user turn (`s` moves focus to the prompt). Mirror that: after
  // resolving keep-planning, send the notes as a normal prompt so Grok — still
  // in plan mode — revises and re-presents the plan. The send path queues the
  // prompt if the keep-planning turn is still winding down, then flushes when
  // idle (same optimistic-turn + re-queue dance as `handleAnswerQuestion`).
  const handleAnswerPlanApproval = useCallback(
    (approvalId: string, answer: PlanApprovalAnswer) => {
      const result = acpActions.answerPlanApproval(tabId, approvalId, answer)
      const notes = answer.feedback?.trim()
      if (
        answer.decision === "request_changes" &&
        notes &&
        connStatus === "connected"
      ) {
        const optimisticTurn: MessageTurn = {
          id: `optimistic-${randomUUID()}`,
          role: "user",
          blocks: [{ type: "text", text: notes }],
          timestamp: new Date().toISOString(),
        }
        const draft: PromptDraft = {
          blocks: [{ type: "text", text: notes }],
          displayText: notes,
        }
        appendOptimisticTurn(
          effectiveConversationId,
          optimisticTurn,
          optimisticTurn.id
        )
        setSendSignal((prev) => prev + 1)
        setSyncState(effectiveConversationId, "awaiting_persist")
        lifecycleSend(draft, null, {
          clientMessageId: optimisticTurn.id,
          // Rejected because the keep-planning turn was still in flight — roll
          // back the optimistic turn and re-queue at the tail so it isn't lost.
          onTurnInProgress: () => {
            lastFlushBounceAtRef.current = Date.now()
            removeOptimisticTurn(effectiveConversationId, optimisticTurn.id)
            mqEnqueue(draft, null)
          },
          // Nothing went out (no connection): noted, as on the composer path.
          onNotSent: () =>
            markOptimisticUnsent(effectiveConversationId, optimisticTurn.id),
          // Any other failure: settle the optimistic state (the lifecycle
          // hook already toasted). No re-queue — deterministic failures loop.
          onSendFailed: () => {
            removeOptimisticTurn(effectiveConversationId, optimisticTurn.id)
          },
        })
      }
      return result
    },
    [
      markOptimisticUnsent,
      acpActions,
      tabId,
      connStatus,
      appendOptimisticTurn,
      removeOptimisticTurn,
      mqEnqueue,
      effectiveConversationId,
      lifecycleSend,
      setSyncState,
    ]
  )

  // Queue edit flow: derive editing draft text from queue state
  const editingQueueDraftText = useMemo(() => {
    if (!mqEditingItemId) return null
    const item = msgQueue.find((m) => m.id === mqEditingItemId)
    return item?.draft.displayText ?? null
  }, [mqEditingItemId, msgQueue])

  // The editing item's full blocks, so the composer can restore inline badges +
  // attachments (not just the display text) when re-opening a queued message.
  const editingQueueDraftBlocks = useMemo(() => {
    if (!mqEditingItemId) return null
    const item = msgQueue.find((m) => m.id === mqEditingItemId)
    return item?.draft.blocks ?? null
  }, [mqEditingItemId, msgQueue])

  const handleQueueEdit = useCallback(
    (id: string) => {
      mqStartEditing(id)
    },
    [mqStartEditing]
  )

  const handleQueueCancelEdit = useCallback(() => {
    mqCancelEditing()
  }, [mqCancelEditing])

  const handleSaveQueueEdit = useCallback(
    (draft: PromptDraft) => {
      if (mqEditingItemId) {
        mqUpdateItem(mqEditingItemId, draft)
      }
    },
    [mqEditingItemId, mqUpdateItem]
  )

  const showDraftHeader = !hasPersistedConversation && !hasSentMessage
  const isWelcomeMode = showDraftHeader

  const handleQuickAction = useCallback((payload: ComposerInjectContent) => {
    setComposerInject(payload)
  }, [])

  const handleComposerInjectConsumed = useCallback(() => {
    handBackRef.current = []
    setComposerInject(null)
  }, [])

  // Quote a transcript selection into the composer. A fresh object every time so
  // quoting the same passage twice still re-fires the composer's inject effect.
  const handleQuoteSelection = useCallback((selected: string) => {
    const quoted = buildQuotedMarkdown(selected)
    if (!quoted) return
    setComposerInject({ text: quoted, mode: "append" })
  }, [])

  /**
   * "Ask about this selection": the selection bubble opens this conversation's
   * own composer kind, holding the selection as a quote and a mention of this
   * conversation, and sending it opens an ASK CONVERSATION in the side drawer —
   * a separate conversation rather than another turn here, so a side question
   * neither derails nor pollutes the thread the user is reading. It is linked
   * to this one, listed under its Session Details rather than in the sidebar.
   *
   * The ask is pinned to THIS conversation's agent — the answer is a
   * continuation of what that agent just said — and runs in this
   * conversation's folder. It needs a persisted row: that is what the mention
   * names and what the ask is linked to.
   */
  // Depends on primitives, not the folder OBJECT: branch polling rewrites that
  // row regularly, and the render prop has to stay referentially stable (it is
  // a MessageListView prop).
  const askFolderId = folder?.id ?? null
  const askMainTitle = ownTab?.title ?? null
  const askPromptCapabilities = conn.promptCapabilities
  const askModes = effectiveModes?.available_modes ?? null
  const openAskDrawer = useAskConversationDrawerStore((s) => s.openNew)
  const canAskSelection =
    askFolderId != null &&
    workingDirForConnection != null &&
    dbConversationId != null
  const renderAskComposer = useCallback(
    (selected: string, close: () => void) => {
      if (askFolderId == null || dbConversationId == null) return null
      return (
        <SelectionAskComposer
          selection={selected}
          mention={{
            conversationId: dbConversationId,
            label:
              formatConversationTitle(askMainTitle).trim() ||
              `#${dbConversationId}`,
          }}
          agentType={selectedAgent}
          promptCapabilities={askPromptCapabilities}
          modes={askModes}
          defaultPath={workingDirForConnection}
          onClose={close}
          onSubmit={(draft, modeId) => {
            const opened = openAskDrawer({
              parentConversationId: dbConversationId,
              agentType: selectedAgent,
              folderId: askFolderId,
              workingDir: workingDirForConnection ?? null,
              initialSend: { draft, modeId },
            })
            // The drawer still holds another ask's unsent first message:
            // keep this one in the bubble rather than dropping either.
            if (opened) close()
            else toast.warning(tAskConversations("pendingFirstMessage"))
            return opened
          }}
        />
      )
    },
    [
      askFolderId,
      askMainTitle,
      askModes,
      askPromptCapabilities,
      dbConversationId,
      openAskDrawer,
      selectedAgent,
      tAskConversations,
      workingDirForConnection,
    ]
  )

  const canShowDetailErrorActions =
    hasPersistedConversation && dbConversationId != null && !!folder
  const handleReloadDetail = useCallback(() => {
    if (dbConversationId == null) return
    // Clear the ACP load failure so canAutoConnect re-enables and the next
    // auto-connect attempt is allowed to retry session/load. The mirror
    // effect above syncs this back into the runtime session as null.
    if (acpLoadError) {
      acpActions.clearAcpLoadError(tabId)
    }
    refetchDetail(dbConversationId)
  }, [acpActions, acpLoadError, dbConversationId, refetchDetail, tabId])
  // Open (or re-activate) the singleton draft tab BEFORE closing the failing
  // tab. closeTab auto-creates a replacement draft when it removes the last
  // tab, and `openNewConversationTab` reads `rawTabsRef.current` which
  // wouldn't yet reflect either pending update if we closed first — the
  // singleton check would miss the replacement and we'd end up with two
  // drafts. Doing it in this order means the second `setTabs` (closeTab)
  // runs against the result of the first.
  const handleOpenNewSession = useCallback(() => {
    if (!folder) return
    // Retry-from-error: user wants a fresh draft in the same conversation
    // context, so inherit the active tab's agent when the folder has no
    // pinned default.
    openNewConversationTab(folder.id, workingDirForConnection ?? folder.path, {
      inheritFromActive: true,
    })
    closeTab(tabId)
  }, [closeTab, folder, openNewConversationTab, tabId, workingDirForConnection])

  // Some load failures come with a shell command that undoes them (today:
  // `codex unarchive <id>`). The banner names it in prose, but prose here is
  // one ellipsized line — so offer the exact string as a copy action too,
  // rather than asking the user to retype a session id they may not even be
  // able to see. Read off the connection, which is where the connections
  // layer parks it beside the localized message.
  const recoveryCommand = conn.loadErrorCommand
  const [commandCopied, setCommandCopied] = useState(false)
  const copiedResetRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(
    () => () => {
      if (copiedResetRef.current) clearTimeout(copiedResetRef.current)
    },
    []
  )
  const handleCopyRecoveryCommand = useCallback(async () => {
    if (!recoveryCommand) return
    const ok = await copyTextToClipboard(recoveryCommand)
    if (!ok) return
    setCommandCopied(true)
    if (copiedResetRef.current) clearTimeout(copiedResetRef.current)
    copiedResetRef.current = setTimeout(() => setCommandCopied(false), 1500)
  }, [recoveryCommand])

  // A session/load failure no longer hijacks the whole message area (the
  // transcript stays readable — see message-list-view's blockingLoadError);
  // instead the failure lands here, as a banner docked where the composer
  // sits, carrying the same Reload / New session recovery actions. Persisted
  // conversations only: drafts never session/load.
  const acpLoadErrorBanner =
    hasPersistedConversation && acpLoadError ? (
      // `flex-wrap` + a message floor, because the actions are all `shrink-0`
      // and the row has no other give: without them a third action pushes the
      // message to zero width and shoves "New conversation" outside the
      // banner (measured: 34-172px past the edge at 320-384px, worse in
      // French/German). Wrapping costs a second row only when the panel is
      // actually too narrow — at >=700px this lays out exactly as before.
      <div
        role="alert"
        className="flex w-full flex-wrap items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive"
      >
        <AlertCircle aria-hidden="true" className="h-4 w-4 shrink-0" />
        <span
          className="min-w-40 flex-1 overflow-hidden text-ellipsis whitespace-nowrap"
          title={acpLoadError}
        >
          {acpLoadError}
        </span>
        {/* Deliberately outside `canShowDetailErrorActions`: that gate exists
            because Reload refetches the DB detail and New session opens a tab
            in the folder, so both need a conversation id and a folder. Copying
            a string needs neither — withholding the one recovery the user can
            still act on would be the wrong call. */}
        {recoveryCommand && (
          <button
            type="button"
            onClick={handleCopyRecoveryCommand}
            title={recoveryCommand}
            className="flex shrink-0 items-center gap-1 rounded border border-destructive/40 px-2 py-0.5 font-medium transition-colors hover:bg-destructive/10"
          >
            {commandCopied ? (
              <Check aria-hidden="true" className="h-3 w-3" />
            ) : (
              <Copy aria-hidden="true" className="h-3 w-3" />
            )}
            {commandCopied
              ? tMessageList("errorActionCommandCopied")
              : tMessageList("errorActionCopyCommand")}
          </button>
        )}
        {canShowDetailErrorActions && (
          <>
            <button
              type="button"
              onClick={handleReloadDetail}
              disabled={detailLoading}
              aria-busy={detailLoading}
              className="flex shrink-0 items-center gap-1 rounded border border-destructive/40 px-2 py-0.5 font-medium transition-colors hover:bg-destructive/10 disabled:pointer-events-none disabled:opacity-50"
            >
              {detailLoading ? (
                <Loader2 aria-hidden="true" className="h-3 w-3 animate-spin" />
              ) : (
                <RefreshCw aria-hidden="true" className="h-3 w-3" />
              )}
              {tMessageList("errorActionReload")}
            </button>
            <button
              type="button"
              onClick={handleOpenNewSession}
              className="flex shrink-0 items-center gap-1 rounded border border-destructive/40 px-2 py-0.5 font-medium transition-colors hover:bg-destructive/10"
            >
              <Plus aria-hidden="true" className="h-3 w-3" />
              {tMessageList("errorActionNewSession")}
            </button>
          </>
        )}
      </div>
    ) : null

  // Goal pause/clear is a live, owner-only action, so decide availability once
  // here (where the connection is owned) rather than in the deep goal card.
  // `null` when the session isn't live or the user is a viewer → the card hides
  // its buttons. Codex is the only agent that produces goal cards, so no
  // agent-type gate is needed. Provided only around the main panel's list; the
  // read-only sub-agent dialog renders its own MessageListView with no provider.
  // The adapter's ADVERTISED goal-control vocabulary (fail-closed: no
  // controls until the snapshot for this exact connectionId reports a known
  // one — see `useAdvertisedGoalActions`). `connStatus` is what brings the
  // hook back for a second read: a brand-new conversation hands us its
  // connection id while `initialize` is still in flight, and the vocabulary
  // isn't decided until that response lands.
  const goalActions = useAdvertisedGoalActions(conn.connectionId, connStatus)

  const goalControlValue = useMemo<GoalControlValue>(() => {
    const live =
      conn.connectionId !== null &&
      (connStatus === "connected" || connStatus === "prompting") &&
      !conn.isViewer
    return {
      onGoalControl: live
        ? (action) => {
            void acpActions.goalControl(tabId, action)
          }
        : null,
      actions: goalActions,
    }
  }, [
    conn.connectionId,
    conn.isViewer,
    connStatus,
    acpActions,
    tabId,
    goalActions,
  ])

  // AIR session-failure recovery actions — the buttons on a failed turn's
  // notification (the provider raises it; this view answers it). `retry`
  // re-submits the LAST user prompt through the message queue — same
  // mechanism as the live-feedback resend fallback: enqueue survives the
  // turn-end status race and flushes as soon as the connection can take a
  // prompt, so the retry is never silently dropped. `login` opens the settings
  // window on this agent's page (auth lives there) — a `router.push` would
  // swap the workspace itself for the settings route; `new_session` reuses
  // the load-error banner's fresh-draft path.
  const tSessionFailure = useTranslations("Folder.chat.sessionFailure")
  const detailTurns = detail?.turns
  const handleSessionFailureAction = useCallback(
    (action: SessionFailureAction) => {
      switch (action) {
        case "retry": {
          // Prompt text source: the runtime TIMELINE first — it is what the
          // user sees, and a failed turn's prompt lives there as an
          // optimistic/promoted turn even when the persisted detail is stale
          // (field report 2026-08-16: after a network-drop terminal failure
          // the detail had no user turn yet, so retry read null and silently
          // did nothing). Persisted detail is the fallback for a conversation
          // whose runtime session was evicted.
          const text =
            lastUserPromptText(
              getTimelineTurns(effectiveConversationId).map((e) => e.turn)
            ) ?? lastUserPromptText(detailTurns)
          if (!text) {
            // Nothing resendable is a dead end for this action — say so
            // instead of swallowing the click.
            toast.warning(tSessionFailure("retryUnavailable"))
            return
          }
          mqEnqueue(
            { blocks: [{ type: "text", text }], displayText: text },
            selectedModeId
          )
          break
        }
        case "login":
          handleOpenAgentsSettings()
          break
        case "new_session":
          handleOpenNewSession()
          break
      }
    },
    [
      effectiveConversationId,
      detailTurns,
      mqEnqueue,
      selectedModeId,
      handleOpenAgentsSettings,
      handleOpenNewSession,
      tSessionFailure,
    ]
  )
  // Offered to this session's failure notifications while the view is
  // mounted (see `AcpActionsValue.registerSessionFailureActions`). Owners of a
  // live connection only — mirrors the goal-control gate: a viewer watches the
  // session, and recovering it is the owner's call.
  const canRecoverSession = conn.connectionId !== null && !conn.isViewer
  useEffect(() => {
    if (!canRecoverSession) return
    return acpActions.registerSessionFailureActions(
      tabId,
      handleSessionFailureAction
    )
  }, [acpActions, canRecoverSession, handleSessionFailureAction, tabId])

  // Closing a strip is client-local (it only resolves the record in this
  // client's projection), so unlike the recovery actions it is offered to
  // viewers too — see `AcpActionsValue.dismissSessionFailure`.
  const handleSessionFailureDismiss = useCallback(
    (ids: string[]) => {
      acpActions.dismissSessionFailures(tabId, ids)
    },
    [acpActions, tabId]
  )

  // The docked composer is the only place a quote can land, so the selection
  // bubble offers "quote" exactly when that composer is on screen (see
  // `hideInput` below). Without a composer the inject would never be consumed
  // and the action would silently do nothing.
  const composerAvailable = !isWelcomeMode && !acpLoadError

  // Arrow-key history source: read lazily when the user actually steps into
  // history, so streaming tokens neither recompute it nor re-render the panel.
  const getSentHistory = useCallback(
    () =>
      userPromptHistory(
        getTimelineTurns(effectiveConversationId).map((entry) => entry.turn)
      ),
    [effectiveConversationId]
  )

  // Which tool call a pending approval is about, so the activity timeline can
  // mark that step as waiting on the user; whether any blocking prompt is
  // open, so a live reply stops saying its agent is at work; and how the
  // connection's answered approvals went, for the chips on their rows.
  const awaitingToolCallId = extractPermissionToolCallId(
    conn.pendingPermission?.tool_call
  )
  const awaitingUser = blockingPrompts(conn) !== null
  const approvals = conn.toolApprovals
  const activityLive = useMemo(
    () => ({ awaitingToolCallId, awaitingUser, approvals }),
    [awaitingToolCallId, awaitingUser, approvals]
  )

  // The work this connection has running beyond the turn, for the "N running"
  // chip on the live activity row. The stop is for owners of a live connection
  // only — same gate as the failure actions: a viewer has no connection to send
  // it on.
  const canStopAsyncTask = conn.connectionId !== null && !conn.isViewer
  const runsAgentName = getAgentLabel(selectedAgent)
  const liveRuns = useMemo<LiveRunsSource>(
    () => ({
      connectionId: conn.connectionId,
      asyncTasks: conn.asyncTasks,
      backgroundTasks: conn.backgroundTasks,
      delegatedChildren: conn.delegatedChildren,
      onStopAsyncTask: canStopAsyncTask ? handleStopAsyncTask : undefined,
      agentName: runsAgentName,
    }),
    [
      conn.connectionId,
      conn.asyncTasks,
      conn.backgroundTasks,
      conn.delegatedChildren,
      canStopAsyncTask,
      handleStopAsyncTask,
      runsAgentName,
    ]
  )

  const messageListNode = (
    <GoalControlProvider value={goalControlValue}>
      <ActivityLiveProvider value={activityLive}>
        <MessageListView
          conversationId={effectiveConversationId}
          imageRoot={workingDirForConnection ?? null}
          agentType={selectedAgent}
          availableCommands={connectionCommands}
          connStatus={connStatus}
          isActive={isActive}
          isVisible={isVisible}
          sendSignal={sendSignal}
          detailLoading={detailLoading}
          detailError={detailError}
          acpLoadError={acpLoadError}
          hideEmptyState={!hasPersistedConversation || hasSentMessage}
          // The conversation page's navigator, plan and sub-agents show in the
          // Session Details side panel rather than over the messages.
          insightsInSidebar
          liveRuns={liveRuns}
          onReload={canShowDetailErrorActions ? handleReloadDetail : undefined}
          onNewSession={
            canShowDetailErrorActions ? handleOpenNewSession : undefined
          }
          onQuoteSelection={
            composerAvailable ? handleQuoteSelection : undefined
          }
          // Asking opens its own conversation, so it needs a folder to open it in
          // rather than a usable composer here — a transcript whose composer is
          // blocked (session/load failure) can still spawn the question elsewhere.
          renderAskComposer={canAskSelection ? renderAskComposer : undefined}
          // The ask drawer is mounted beside this transcript (below): a
          // check's conversation opens in it.
          checksOpenInDrawer
          // Fork carries no draft, so — unlike a send — a non-empty queue is
          // not at risk of being jumped and needs no guard here. A turn in
          // flight is still rejected, by the backend, which is the only place
          // that can see it without racing.
          //
          // "prompting" belongs on this side of the gate (same shape as the
          // goal-control gate above): this answers "can this surface fork at
          // all", and a turn in flight is a passing "not right now" that the
          // view greys the button out for. Dropping the handler instead made
          // every reply's fork icon disappear for the length of each reply.
          // `handleForkFromTurn` re-checks liveness at click time.
          onForkFromTurn={
            (connStatus === "connected" || connStatus === "prompting") &&
            hasPersistedConversation &&
            conn.supportsFork
              ? handleForkFromTurn
              : undefined
          }
          // Same gate as fork: a turn in flight greys the button out.
          onEditUserTurn={
            (connStatus === "connected" || connStatus === "prompting") &&
            hasPersistedConversation &&
            conn.supportsRewind &&
            !conn.isViewer
              ? handleEditUserTurn
              : undefined
          }
        />
      </ActivityLiveProvider>
    </GoalControlProvider>
  )

  // Live-feedback bar gating + the "agent never read your note" resend fallback.
  // Enqueue rather than `handleSend`: this fallback fires on a turn-end race
  // where the backend already reports no active turn but the frontend may still
  // read `connStatus === "prompting"`, and `handleSend` no-ops unless
  // "connected" — which would silently drop the note. The message queue holds it
  // (visible above the composer) and auto-flushes when the turn completes, so
  // the user's note is never lost.
  const feedbackEnabled = useFeedbackEnabled()
  const resendFeedbackAsPrompt = useCallback(
    (text: string) => {
      mqEnqueue(
        { blocks: [{ type: "text", text }], displayText: text },
        selectedModeId
      )
    },
    [mqEnqueue, selectedModeId]
  )
  const feedback = useSessionFeedback({
    connectionId: conn.connectionId,
    connStatus,
    enabled: feedbackEnabled,
    // Notes the transcript adopted as mid-turn user turns show as messages,
    // not as strips above the composer.
    steeredMessageIds: conn.steeredMessageIds,
    onResendAsPrompt: resendFeedbackAsPrompt,
  })
  // Composer mid-turn send, over whichever live-feedback channel this session
  // has (native push or the pull tool). Rethrows — MessageInput owns the
  // enqueue fallback and draft-preservation policy, so this wrapper must not
  // swallow the turn-end race the way `submit` does. `blocks` rides along when
  // the draft carries attachments (images steer natively; the pull path
  // rejects them into the composer's queue fallback); `text` stays the
  // recorded/display form.
  const feedbackSteer = feedback.steer
  const handleSteer = useCallback(
    async (text: string, blocks?: PromptInputBlock[]) => {
      await feedbackSteer(text, blocks)
    },
    [feedbackSteer]
  )

  // Click-to-insert for a queued row: send THAT item into the running turn
  // over the same live-feedback channel the composer's mid-turn dropdown uses.
  // The block/text encoding is the shared `buildSteerPayload` — one call site,
  // no policy here beyond the row's own lifecycle: success removes the row;
  // a turn-end race prioritizes the row for the existing queue auto-flush.
  // Failures keep the row available for retry.
  const handleQueueSteer = useCallback(
    async (id: string) => {
      const item = msgQueue.find((m) => m.id === id)
      if (!item) return
      const payload = buildSteerPayload(item.draft)
      // Nothing sendable in this row (no text, and no display text standing in
      // for its attachments). Leave it alone: removing it would delete queued
      // content — including whatever blocks it carries — on a button that
      // promises to SEND it.
      if (!payload) return
      // Set before the first await so the flush effect above is already held
      // when the turn-end edge lands mid-round-trip.
      setQueueSteerInFlight(true)
      try {
        const delivered = await deliverQueuedSteer(
          () => feedbackSteer(payload.text, payload.blocks),
          () => mqMoveToFront(id)
        )
        // Not delivered means the turn ended first, so the row goes out as the
        // next turn instead; say so, as the composer's steer does.
        if (delivered) mqRemove(id)
        else toast.info(tCmp("steerQueuedInstead"))
      } catch (err: unknown) {
        notify({
          level: "error",
          key: `steer-failed:${tabId}`,
          title: tCmp(
            feedback.channel === "pull" ? "steerNoteFailed" : "steerFailed"
          ),
          description: toErrorMessage(err),
        })
      } finally {
        setQueueSteerInFlight(false)
      }
    },
    [
      msgQueue,
      feedbackSteer,
      mqRemove,
      feedback.channel,
      tabId,
      tCmp,
      mqMoveToFront,
    ]
  )

  return (
    <ConversationShell
      resizableWidth
      getSentHistory={getSentHistory}
      topBanner={
        <>
          <SessionConfigStaleBanner contextKey={tabId} />
          <PiProjectTrustBanner
            contextKey={tabId}
            agentType={selectedAgent}
            workingDir={workingDirForConnection}
          />
        </>
      }
      status={connStatus}
      promptCapabilities={conn.promptCapabilities}
      defaultPath={workingDirForConnection}
      agentName={getAgentLabel(selectedAgent)}
      claudeApiRetry={conn.claudeApiRetry}
      sessionFailures={conn.sessionFailures}
      onSessionFailureDismiss={handleSessionFailureDismiss}
      remoteControl={connIsForOtherAgent ? null : conn.remoteControl}
      onRemoteControlOff={
        // Owners of a live connection only, like the stop above.
        conn.connectionId !== null && !conn.isViewer
          ? handleRemoteControlOff
          : undefined
      }
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
      onConfigOptionChange={handleConfigOptionChange}
      agentType={selectedAgent}
      availableCommands={connectionCommands}
      // The previous agent's prediction is no use to the one just picked.
      promptSuggestion={connIsForOtherAgent ? null : conn.promptSuggestion}
      attachmentTabId={tabId}
      draftStorageKey={draftStorageKey}
      hideInput={isWelcomeMode || Boolean(acpLoadError)}
      injectContent={composerInject}
      onInjectConsumed={handleComposerInjectConsumed}
      composerBanner={acpLoadErrorBanner}
      feedbackList={
        feedback.showList ? (
          <FeedbackNotesDisplay
            notes={feedback.notes}
            // Past the turn the list is the only place an unread note still
            // exists on screen, so it carries its own recovery actions rather
            // than disappearing with the turn that never read it.
            expired={feedback.notesExpired}
            onResend={feedback.resendNote}
            onDismiss={feedback.dismissNote}
          />
        ) : null
      }
      onAddFeedback={feedback.featureEnabled ? feedback.openDialog : undefined}
      feedbackAddDisabled={!feedback.canSubmit}
      isActive={isActive}
      showActiveFlow={showActiveFlow}
      queue={msgQueue}
      onEnqueue={handleComposerEnqueue}
      onQueueReorder={mqReorder}
      onQueueEdit={handleQueueEdit}
      onQueueDelete={mqRemove}
      onQueueSteer={
        // Same gate as the composer's mid-turn send, plus a turn actually in
        // flight: a queued row can only be inserted into a RUNNING turn —
        // idle sessions have the queue's own auto-flush for that.
        feedback.featureEnabled &&
        feedback.steerAvailable &&
        connStatus === "prompting"
          ? handleQueueSteer
          : undefined
      }
      editingItemId={mqEditingItemId}
      editingDraftText={editingQueueDraftText}
      editingDraftBlocks={editingQueueDraftBlocks}
      isEditingQueueItem={mqEditingItemId != null}
      onSaveQueueEdit={handleSaveQueueEdit}
      onCancelQueueEdit={handleQueueCancelEdit}
      onSteer={
        // Any working delivery channel, not just the native push: the pull
        // tool records a waiting note the agent reads on its next check, and
        // `steerChannel` swaps the copy so pull sessions never promise an
        // instant insert. Sessions with NEITHER channel keep the historical
        // prompting branch (Stop button alone, Enter queues). The prompting
        // scope itself is enforced where the button renders.
        feedback.featureEnabled && feedback.steerAvailable
          ? handleSteer
          : undefined
      }
      steerChannel={feedback.channel}
    >
      {isWelcomeMode ? (
        // Same overlay scrollbar as the sidebar / file lists (os-theme-codeg)
        // instead of the platform's native bar. `min-h-full` on the inner column
        // keeps the original layout: content parked between two spacers, the
        // page scrolling only once it outgrows the viewport.
        <ScrollArea
          className="relative isolate h-full min-h-0"
          x="hidden"
          y="scroll"
        >
          <div className="flex min-h-full flex-col">
            <div className="flex-1" />
            <div className="mx-auto flex w-full chat-content-w shrink-0 flex-col gap-6 px-4 py-4">
              <WelcomeHero />
              <QuickActions
                onSelect={handleQuickAction}
                agentType={selectedAgent}
              />
              <div className="flex justify-center">
                <AgentSelector
                  // The selector spans the row it is given (it has to measure
                  // how much room it has), so the centring lives inside it now
                  // — the `justify-center` above only centres a full-width box.
                  align="center"
                  defaultAgentType={selectedAgent}
                  onSelect={handleAgentSelect}
                  onFallback={handleAgentFallback}
                  onAgentsLoaded={(agents) => {
                    setAgentsLoaded(true)
                    setUsableAgentCount(
                      agents.filter((agent) => agent.enabled && agent.available)
                        .length
                    )
                  }}
                  onOpenAgentsSettings={handleOpenAgentsSettings}
                  // Drafts remain switchable while connecting; saved
                  // conversations retain the agent they were created with.
                  disabled={dbConversationId != null}
                />
              </div>
              {composerBlockedMessage ? (
                <div className="flex w-full items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
                  <button
                    type="button"
                    onClick={handleOpenAgentsSettings}
                    title={composerBlockedMessage}
                    className="min-w-0 flex-1 cursor-pointer overflow-hidden text-ellipsis whitespace-nowrap text-left transition-colors hover:text-destructive/80"
                  >
                    {composerBlockedMessage}
                  </button>
                  {selectedAgentNotInstalled ? (
                    <button
                      type="button"
                      onClick={() => setComposerDiagnosticsOpen(true)}
                      className="shrink-0 rounded border border-destructive/40 px-2 py-0.5 font-medium transition-colors hover:bg-destructive/10"
                    >
                      {tDiag("button")}
                    </button>
                  ) : null}
                </div>
              ) : null}
              <ChatInput
                // composerConnStatus (not connStatus): a chat draft mid-reconnect
                // reads "connecting" until the connection's cwd matches, so the
                // send affordance stays disabled until handleSend would accept it.
                status={composerConnStatus}
                promptCapabilities={conn.promptCapabilities}
                defaultPath={workingDirForConnection}
                agentName={getAgentLabel(selectedAgent)}
                onFocus={handleFocus}
                onSend={handleSend}
                onCancel={handleCancel}
                modes={connectionModes}
                configOptions={connectionConfigOptions}
                modeLoading={modeLoading}
                configOptionsLoading={configOptionsLoading}
                selectorsLoading={selectorsLoading}
                selectedModeId={selectedModeId}
                onModeChange={handleModeChange}
                onConfigOptionChange={handleConfigOptionChange}
                agentType={selectedAgent}
                availableCommands={connectionCommands}
                attachmentTabId={tabId}
                draftStorageKey={draftStorageKey}
                isActive={isActive}
                showActiveFlow={showActiveFlow}
                onAddFeedback={
                  feedback.featureEnabled ? feedback.openDialog : undefined
                }
                feedbackAddDisabled={!feedback.canSubmit}
                injectContent={composerInject}
                onInjectConsumed={handleComposerInjectConsumed}
                flush
                tall
              />
            </div>
            <div className="flex-1" />
            <div className="mx-auto w-full chat-content-w shrink-0 px-4 pb-6">
              <WelcomeTip />
            </div>
          </div>
        </ScrollArea>
      ) : showDraftHeader ? (
        <div className="flex h-full min-h-0 flex-col">
          <div className="px-4 pt-3 pb-2">
            <AgentSelector
              defaultAgentType={selectedAgent}
              onSelect={handleAgentSelect}
              onFallback={handleAgentFallback}
              onAgentsLoaded={(agents) => {
                setAgentsLoaded(true)
                setUsableAgentCount(
                  agents.filter((agent) => agent.enabled && agent.available)
                    .length
                )
              }}
              onOpenAgentsSettings={handleOpenAgentsSettings}
              // Same draft/saved rule as the welcome-mode picker above.
              disabled={dbConversationId != null}
            />
            {composerBlockedMessage ? (
              <div className="mt-2 flex w-full items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
                <button
                  type="button"
                  onClick={handleOpenAgentsSettings}
                  title={composerBlockedMessage}
                  className="min-w-0 flex-1 cursor-pointer overflow-hidden text-ellipsis whitespace-nowrap text-left transition-colors hover:text-destructive/80"
                >
                  {composerBlockedMessage}
                </button>
                {selectedAgentNotInstalled ? (
                  <button
                    type="button"
                    onClick={() => setComposerDiagnosticsOpen(true)}
                    className="shrink-0 rounded border border-destructive/40 px-2 py-0.5 font-medium transition-colors hover:bg-destructive/10"
                  >
                    {tDiag("button")}
                  </button>
                ) : null}
              </div>
            ) : null}
          </div>
          <div className="min-h-0 flex-1">{messageListNode}</div>
        </div>
      ) : (
        messageListNode
      )}
      <FeedbackDialog
        open={feedback.dialogOpen}
        onOpenChange={(open) => {
          if (open) feedback.openDialog()
          else feedback.closeDialog()
        }}
        onSubmit={feedback.submit}
        submitting={feedback.submitting}
        agentName={getAgentLabel(selectedAgent)}
        channel={feedback.channel}
      />
      <AgentDiagnosticsDialog
        open={composerDiagnosticsOpen}
        onOpenChange={setComposerDiagnosticsOpen}
        agentType={selectedAgent}
      />
    </ConversationShell>
  )
})

// A group rect (percentages) counts as touching a container edge within this
// tolerance — ratio math can land a hair off exact 0 / 100.
const GROUP_EDGE_EPSILON = 0.1

/**
 * Corner reserve for a TOP-EDGE split-group strip. While split there is no
 * dedicated title-bar row above the shells (the workspace layout drops it
 * entirely instead of leaving a blank drag strip), so the strips along the
 * window's top edge must reserve the fixed corner overlays' width themselves —
 * exactly what the unsplit strip row does: left for LeftEdgeChrome while the
 * sidebar is collapsed (the conversation column then owns the window's left
 * edge), right for RightEdgeChrome while the column owns the right edge (aux
 * panel closed + conversation mode, or the column maximized over the file
 * column). Like that row, the reserve is mounted while its column holds the
 * corner — the right one only then; a mode switch or a maximize toggle snaps
 * the layout — and sized by the side panel over the corner, so a sidebar/aux
 * toggle slides it (ChromeReserve). Mobile shows the full-width FolderTitleBar
 * instead of corner overlays — no reserve. Self-subscribed so sidebar/aux/zoom
 * toggles re-render these slivers, not the whole panel.
 */
function SplitStripCornerReserve({ side }: { side: "left" | "right" }) {
  const isMobile = useIsMobile()
  const { isOpen: sidebarOpen } = useSidebarContext()
  const { isOpen: auxOpen } = useAuxPanelContext()
  const { mode, conversationMaximized } = useWorkspaceView()
  const { isMac, isWindows, isLinux } = usePlatform()
  const { zoomLevel } = useZoomLevel()
  if (isMobile) return null
  const holdsRight = mode === "conversation" || conversationMaximized
  if (side === "right" && !holdsRight) return null
  const width =
    side === "left"
      ? sidebarOpen
        ? 0
        : leftChromeReserve(isMac && isDesktop(), zoomLevel)
      : auxOpen
        ? 0
        : rightChromeReserve(isDesktop() && (isWindows || isLinux), zoomLevel)
  return <ChromeReserve width={width} />
}

export function ConversationDetailPanel() {
  const t = useTranslations("Folder.conversation")
  const tDetails = useTranslations("Folder.sessionDetails")
  const {
    completeTurn: runtimeCompleteTurn,
    removeConversation: runtimeRemoveConversation,
  } = useConversationRuntimeActions()
  const { activeFolder: folder } = useActiveFolder()
  const conversations = useAppWorkspaceStore((s) => s.conversations)
  const allFolders = useAppWorkspaceStore((s) => s.allFolders)
  const tabs = useTabStore((s) => s.tabs)
  const tabsFollowFolder = useFolderTabsStore((s) => s.enabled)
  const visibleTabs = useVisibleConversationTabs()
  const visibleLayout = useVisibleConversationLayout()
  const visibleTabIds = useMemo(
    () => new Set(visibleTabs.map((tab) => tab.id)),
    [visibleTabs]
  )
  const activeTabId = useTabStore((s) => s.activeTabId)
  const groupLayout = useTabStore((s) => s.groupLayout)
  const groupOf = useTabStore((s) => s.groupOf)
  const groupViews = useTabStore((s) => s.groupViews)
  const groupSelection = useTabStore((s) => s.groupSelection)
  const tileByGroup = useTabStore((s) => s.tileByGroup)
  // Narrow: only the drop-TARGET group id (for the shell highlight ring) — the
  // per-frame x/y writes during a drag never re-render the panel.
  const dragOverGroupId = useTabStore((s) => s.tabDrag?.overGroupId ?? null)
  const {
    openNewConversationTab,
    closeTab,
    switchTab,
    resizeGroupSplit,
    onPreviewTabReplaced,
  } = useTabActions()
  const newConversation = useMemo(() => {
    const activeTab = tabs.find((tab) => tab.id === activeTabId)
    if (!activeTab || activeTab.conversationId != null) return null
    const workingDir = activeTab.workingDir ?? folder?.path
    if (!workingDir) return null
    return { workingDir, folderId: activeTab.folderId }
  }, [tabs, activeTabId, folder?.path])
  const { disconnectIfIdle } = useAcpActions()
  const { addTask, updateTask } = useTaskContext()
  const [reloadByTabId, setReloadByTabId] = useState<Record<string, number>>({})
  const [detailsOpen, setDetailsOpen] = useState(false)

  const exportLabels = useExportLabels()

  // Release the old connection as soon as a preview tab is replaced (the next
  // single-click in the sidebar takes its slot) instead of waiting for a sweep.
  // Idle-gated on purpose: the replaced tab may hold a session that is still
  // working — often one the user only clicked in to watch — and disconnecting
  // an owner mid-turn kills the agent CLI, which lands in the transcript as an
  // interrupted request. Busy owners keep running; the idle sweep reclaims them
  // once they settle.
  useEffect(() => {
    return onPreviewTabReplaced((replacedTabId) => {
      disconnectIfIdle(replacedTabId).catch(() => {})
    })
  }, [onPreviewTabReplaced, disconnectIfIdle])

  // Background turn_complete handler: for conversations not open in tabs.
  // Subscribes via the context's primary `acp://event` listener (single
  // physical Tauri/WebSocket subscription, plus seq dedup from Phase 3b).
  // `useAcpEvent` stabilizes handler identity internally, so the callback
  // can read closure values directly — no caller-side refs needed.
  useAcpEvent(
    useCallback(
      (envelope: EventEnvelope) => {
        if (envelope.type !== "turn_complete") return

        const runtimeConversationId = getConversationIdByExternalIdFromStore(
          envelope.session_id
        )
        // Event-time read: fresher than a render capture ("`conversations`
        // may lag the tab update on fast turns" below applies to the render
        // snapshot; getState() narrows that window).
        const summary = useAppWorkspaceStore
          .getState()
          .conversations.find(
            (item) => item.external_id === envelope.session_id
          )
        const matchedConversationId =
          runtimeConversationId ?? summary?.id ?? null
        if (!matchedConversationId) return

        // Match against every identifier the panel may carry for the same
        // runtime session — otherwise this background handler races the
        // panel's own completeTurn effect and double-promotes streamingTurns
        // into localTurns (visible as a duplicated assistant message until
        // the conversation is reopened from DB).
        //
        // Invariant: `tab.runtimeConversationId` is only set when the panel's
        // effectiveConversationId differs from its bound conversationId, i.e.
        // for new conversations whose session lives under a virtual (negative)
        // id. `dbId2` is always a real DB id, so a runtimeConversationId vs.
        // dbId2 comparison is unreachable and intentionally omitted.
        // `conversations` may lag the tab update on fast turns, so dbId2
        // alone (without the runtime id branch) is not a reliable signal.
        const dbId2 = summary?.id
        const isOpenInTabs = tabs.some(
          (tab) =>
            tab.conversationId === matchedConversationId ||
            tab.runtimeConversationId === matchedConversationId ||
            (dbId2 != null && tab.conversationId === dbId2)
        )
        if (isOpenInTabs) return

        // Promote liveMessage + optimisticTurns to localTurns immediately
        runtimeCompleteTurn(matchedConversationId)

        // If tab was closed while agent was responding, clean up now.
        // Event-time read: fresh via getState(), no reactive subscription.
        const session = getRuntimeSession(matchedConversationId)
        if (session?.pendingCleanup) {
          runtimeRemoveConversation(matchedConversationId)
        }
      },
      [tabs, runtimeCompleteTurn, runtimeRemoveConversation]
    )
  )

  const hasNoTabs = tabs.length === 0 && !activeTabId
  const activeConversationTab = useMemo(
    () =>
      tabs.find(
        (tab) => tab.id === activeTabId && tab.conversationId != null
      ) ?? null,
    [tabs, activeTabId]
  )
  const canReloadActiveConversation = activeConversationTab != null
  const handleReloadActiveConversation = useCallback(() => {
    if (!activeConversationTab) return
    setReloadByTabId((prev) => ({
      ...prev,
      [activeConversationTab.id]: (prev[activeConversationTab.id] ?? 0) + 1,
    }))
  }, [activeConversationTab])

  const handleNewConversation = useCallback(() => {
    if (!folder) return
    // Right-click "new conversation" inside a conversation tab: keep the
    // active agent when the target folder has no pinned default.
    openNewConversationTab(folder.id, folder.path, { inheritFromActive: true })
  }, [folder, openNewConversationTab])

  const handleCloseActiveTab = useCallback(() => {
    if (!activeTabId) return
    closeTab(activeTabId)
  }, [activeTabId, closeTab])

  // Narrow reactive reads for the ACTIVE conversation only — a background
  // conversation's streaming token no longer re-renders this panel. `canExport`
  // keys on the tab's persisted `conversationId`; the session-details
  // resolution keys on `runtimeConversationId ?? conversationId` (a brand-new
  // conversation streams under a virtual runtime id whose live stats differ), so
  // the two are subscribed SEPARATELY — collapsing them to one lookup would
  // diverge during the virtual→persisted reconciliation window.
  const activeExportConversationId =
    activeConversationTab?.conversationId ?? null
  const canExport = useConversationRuntimeStore(
    (s) =>
      activeExportConversationId != null &&
      s.byConversationId.get(activeExportConversationId)?.detail != null
  )

  // Resolve the active conversation's summary + live token usage the same way
  // the tab view renders them — a new conversation streams under a virtual
  // `runtimeConversationId` with its usage on `sessionStats`. Extracted so the
  // resolution is unit-tested (see active-session-details.test.ts).
  const activeRuntimeId =
    activeConversationTab?.runtimeConversationId ??
    activeConversationTab?.conversationId ??
    null
  // A persistent metadata consumer's previous hook snapshot can outlive a
  // removed session. Select its display values before React keeps that snapshot.
  const activeRuntimeDetails = useConversationRuntimeStore(
    useShallow((s) =>
      projectRuntimeSessionDetails(
        activeRuntimeId != null ? s.byConversationId.get(activeRuntimeId) : null
      )
    )
  )
  const {
    summary: activeSessionSummary,
    stats: activeSessionStats,
    model: activeSessionModel,
  } = resolveActiveSessionDetailsFromSnapshot(
    activeConversationTab,
    activeRuntimeDetails,
    conversations
  )

  const getExportData = useCallback(async () => {
    if (!activeConversationTab?.conversationId) return null
    const session = getRuntimeSession(activeConversationTab.conversationId)
    if (!session?.detail) return null
    let detail = session.detail
    // The loaded detail may be a tail WINDOW (paginated loading); an export
    // must cover the whole transcript, so fetch the legacy full response on
    // demand. The window is full when it starts at offset 0.
    if (isWindowedDetail(detail) && detail.turns_offset > 0) {
      detail = await getFolderConversation(
        session.dbConversationId ?? activeConversationTab.conversationId
      )
    }
    return {
      summary: detail.summary,
      turns: detail.turns,
      sessionStats: detail.session_stats,
      labels: exportLabels,
    }
  }, [activeConversationTab, exportLabels])

  const handleExportMarkdown = useCallback(async () => {
    try {
      const data = await getExportData()
      if (!data) return
      const result = await exportAsMarkdown(data)
      if (result === "saved") toast.success(t("exportSuccess"))
      // "cancelled": user dismissed the Save dialog — stay silent,
      // matching the downloadImage / workspace-download conventions.
    } catch (err) {
      toast.error(t("exportFailed"))
      console.error("[ConversationDetailPanel] export markdown:", err)
    }
  }, [getExportData, t])

  const handleExportHtml = useCallback(async () => {
    try {
      const data = await getExportData()
      if (!data) return
      const result = await exportAsHtml(data)
      if (result === "saved") toast.success(t("exportSuccess"))
    } catch (err) {
      toast.error(t("exportFailed"))
      console.error("[ConversationDetailPanel] export html:", err)
    }
  }, [getExportData, t])

  const handleExportImage = useCallback(async () => {
    const taskId = `export-image-${Date.now()}`
    addTask(taskId, t("exportImage"))
    updateTask(taskId, { status: "running" })
    try {
      const data = await getExportData()
      if (!data) {
        updateTask(taskId, { status: "completed" })
        return
      }
      const result = await exportAsImage(data)
      updateTask(taskId, { status: "completed" })
      if (result === "saved") toast.success(t("exportSuccess"))
    } catch (err) {
      updateTask(taskId, { status: "failed" })
      if (err instanceof ExportTooLongError) {
        toast.error(t("exportImageTooLong"))
      } else {
        toast.error(t("exportFailed"))
      }
      console.error("[ConversationDetailPanel] export image:", err)
    }
  }, [getExportData, t, addTask, updateTask])

  // Ensure no-tab state is immediately bridged to a real new-conversation tab.
  useEffect(() => {
    if (!folder) return

    if (
      shouldSeedConversation(useFolderTabsStore.getState().enabled, hasNoTabs)
    ) {
      openNewConversationTab(
        folder.id,
        newConversation?.workingDir ?? folder.path
      )
    }
  }, [
    folder,
    hasNoTabs,
    newConversation?.workingDir,
    openNewConversationTab,
    tabsFollowFolder,
  ])

  // Split-group render model: the layout tree only ever produces PERCENTAGE
  // RECTS — every group shell is an absolutely-positioned SIBLING keyed by its
  // stable group id, so splits/merges/orientation flips/divider drags are pure
  // style changes and a tab that stays in its group is never reparented (a
  // reparent would remount the view and tear down a live streaming response).
  const { groups: groupRects, handles: groupHandles } = useMemo(
    () => computeRects(visibleLayout),
    [visibleLayout]
  )
  const isSplit = leafIds(visibleLayout).length > 1
  // Every tab sits in its own view's group shell (`shellGroupOfTab`): the
  // folder views not on screen keep their shells, hidden, so a folder switch
  // reparents nothing. Shells come in id order — a fixed order whatever view
  // is on screen, so a switch never moves one (a moved node resets every
  // transcript inside it); new shells only ever insert.
  const tabsByGroup = useMemo(() => {
    const byGroup = new Map<string, typeof tabs>()
    for (const groupId of leafIds(groupLayout)) byGroup.set(groupId, [])
    const state = { rawTabs: tabs, groupOf, groupLayout, groupViews }
    for (const tab of tabs) {
      const groupId = visibleTabIds.has(tab.id)
        ? groupOfTab(groupOf, groupLayout, tab.id)
        : shellGroupOfTab(state, tab.id)
      const bucket = byGroup.get(groupId)
      if (bucket) {
        bucket.push(tab)
      } else {
        byGroup.set(groupId, [tab])
      }
    }
    return byGroup
  }, [tabs, groupOf, groupLayout, groupViews, visibleTabIds])
  const orderedGroupIds = useMemo(
    () => [...tabsByGroup.keys()].sort(),
    [tabsByGroup]
  )

  const tileTabRefs = useRef<Map<string, HTMLDivElement | null>>(new Map())
  const groupContainerRef = useRef<HTMLDivElement | null>(null)
  // The panel's context menu wraps the transcript, so a touch long-press that
  // selects text would also open it — modal, over the selection's copy bubble.
  const panelMenu = useTouchSelectionMenuGuard(groupContainerRef)

  // Scroll each TILED group's selected tab into view when the selection (or
  // the group's tiled-ness) changes — the signature string keeps the effect
  // from refiring on unrelated tab updates.
  const tiledSelectionKey = useMemo(
    () =>
      orderedGroupIds
        .filter(
          (groupId) =>
            tileByGroup[groupId] &&
            (tabsByGroup.get(groupId) ?? []).filter((tab) =>
              visibleTabIds.has(tab.id)
            ).length > 1 &&
            groupSelection[groupId] != null
        )
        .map((groupId) => groupSelection[groupId])
        .join("|"),
    [orderedGroupIds, tileByGroup, tabsByGroup, groupSelection, visibleTabIds]
  )
  useEffect(() => {
    if (!tiledSelectionKey) return
    for (const selectedId of tiledSelectionKey.split("|")) {
      tileTabRefs.current.get(selectedId)?.scrollIntoView({
        behavior: "smooth",
        inline: "center",
        block: "nearest",
      })
    }
  }, [tiledSelectionKey])

  // Safety valve: if the dragged tab vanishes mid-drag (a remote snapshot
  // closing it), the drag-end callback on its unmounted item never fires —
  // clear the transient drag so the ghost/highlight can't linger.
  useEffect(() => {
    const st = useTabStore.getState()
    if (st.tabDrag && !tabs.some((tab) => tab.id === st.tabDrag?.tabId)) {
      st.endTabDrag()
    }
  }, [tabs])

  if (hasNoTabs) {
    return tabsFollowFolder ? <FolderTabsEmptyState /> : null
  }

  const renderTabWrapper = (
    tab: (typeof tabs)[number],
    indexInGroup: number,
    groupId: string,
    canTileG: boolean
  ) => {
    const inScope = visibleTabIds.has(tab.id)
    const active = inScope && tab.id === activeTabId
    // Visible = tiled (all group members shown) or the group's selected tab.
    const visible = inScope && (canTileG || tab.id === groupSelection[groupId])
    const folderPath = allFolders.find((f) => f.id === tab.folderId)?.path
    const view = (
      <ConversationTabView
        tabId={tab.id}
        conversationId={tab.conversationId}
        agentType={tab.agentType}
        workingDir={tab.workingDir ?? folderPath}
        isActive={active}
        showActiveFlow={(isSplit || canTileG) && active}
        reloadSignal={reloadByTabId[tab.id] ?? 0}
        groupId={groupId}
        isVisible={visible}
      />
    )
    return (
      <div
        key={tab.id}
        ref={(el) => {
          if (el) {
            tileTabRefs.current.set(tab.id, el)
          } else {
            tileTabRefs.current.delete(tab.id)
          }
        }}
        // Tiled, everything below this wrapper is invisible to the row's
        // scrollbar (a tile clips its content), so TileScrollContainer skips
        // the layout read its observer would otherwise force per mutation.
        data-tile-scroll-item=""
        style={canTileG ? { order: indexInGroup } : undefined}
        className={cn(
          !inScope
            ? "conversation-tab-hidden absolute inset-0 invisible pointer-events-none"
            : canTileG
              ? cn(
                  "relative h-full min-w-[24rem] flex-1 overflow-hidden",
                  indexInGroup > 0 && "border-l border-border/50"
                )
              : visible
                ? "h-full"
                : "conversation-tab-hidden absolute inset-0 invisible pointer-events-none"
        )}
        onPointerDownCapture={
          visible && !active ? () => switchTab(tab.id) : undefined
        }
      >
        {/* The visible active cue is now the composer's flowing gradient border
            (see message-input.tsx); keep a non-visual cue for assistive tech
            when several sessions are visible (tiled and/or split). */}
        {(isSplit || canTileG) && active && (
          <span className="sr-only">{t("activeConversationIndicator")}</span>
        )}
        {/* A backgrounded tab is kept mounted and merely hidden (its session is
            still live), but a "查看会话" drawer opened from it portals to the
            body — so without this it went on painting over whichever tab the
            user switched to. The flag is additive, so a visible tab inside a
            covered workspace stays hidden. */}
        <OverlayHostHiddenProvider hidden={!visible}>
          {view}
        </OverlayHostHiddenProvider>
      </div>
    )
  }

  // Plain function (NOT a component defined in render — that type identity
  // would change every render and remount the whole shell subtree).
  const renderGroupShell = (groupId: string) => {
    const inScope = groupRects.has(groupId)
    const rect = groupRects.get(groupId) ?? { x: 0, y: 0, w: 100, h: 100 }
    const groupTabs = tabsByGroup.get(groupId) ?? []
    const visibleGroupTabs = groupTabs.filter((tab) =>
      visibleTabIds.has(tab.id)
    )
    const canTileG = !!tileByGroup[groupId] && visibleGroupTabs.length > 1
    // Only the TOP-edge strips sit under the fixed corner overlays (the split
    // layout has no title-bar row above them) — the leftmost/rightmost of that
    // row carry the corner reserves the unsplit strip row normally provides.
    const touchesTop = rect.y <= GROUP_EDGE_EPSILON
    const touchesLeft = touchesTop && rect.x <= GROUP_EDGE_EPSILON
    const touchesRight =
      touchesTop && rect.x + rect.w >= 100 - GROUP_EDGE_EPSILON
    // The group's SELECTED tab drives its header — each split group keeps the
    // full "tabs + conversation title bar" pairing of the unsplit layout.
    const selTab =
      visibleGroupTabs.find((tab) => tab.id === groupSelection[groupId]) ??
      visibleGroupTabs[0] ??
      null
    const selTabFolder = selTab
      ? allFolders.find((f) => f.id === selTab.folderId)
      : undefined
    // NOTE: the strip / header / content stay PLAIN SIBLING SLOTS (no fragment
    // around any pair) — a `false` conditional is a reconciliation hole, so the
    // content keeps its slot across split flips; wrapping would shift slots and
    // remount every live view (see group-shell-reconciliation.test.tsx).
    return (
      <div
        key={groupId}
        data-conv-group-shell={groupId}
        className="absolute flex min-h-0 flex-col overflow-hidden"
        style={{
          left: `${rect.x}%`,
          top: `${rect.y}%`,
          width: `${rect.w}%`,
          height: `${rect.h}%`,
          visibility: inScope ? undefined : "hidden",
          pointerEvents: inScope ? undefined : "none",
        }}
      >
        {/* While split, each group owns its own strip (the workspace layout's
            title-bar row is gone entirely), and the TOP-edge strips add the
            corner reserves that row normally carries. The top-right one also
            takes over the unsplit strip's maximize/restore button — the
            column has one, so only one strip may carry it. */}
        {isSplit && (
          <div className="flex h-10 shrink-0 items-stretch bg-muted ws-transparent-bg">
            {touchesLeft && <SplitStripCornerReserve side="left" />}
            <TabBar groupId={groupId} maximizeControl={touchesRight} />
            {touchesRight && <SplitStripCornerReserve side="right" />}
          </div>
        )}
        {isSplit && selTab && (
          <div
            className="shrink-0"
            // Clicking a non-focused group's title bar focuses that group
            // (same gesture as clicking its content) — capture phase so the
            // header's own controls still receive the event afterwards.
            onPointerDownCapture={() => {
              const selected = groupSelection[groupId]
              if (selected && selected !== useTabStore.getState().activeTabId) {
                switchTab(selected)
              }
            }}
          >
            <ConversationDetailHeader
              tabId={selTab.id}
              conversationId={selTab.conversationId}
              runtimeConversationId={selTab.runtimeConversationId ?? null}
              folderId={selTab.folderId}
              folderPath={selTabFolder?.path}
              title={selTab.title}
              status={selTab.status as ConversationStatus | undefined}
            />
          </div>
        )}
        <div className="relative min-h-0 flex-1 overflow-hidden">
          <TileScrollContainer canTile={canTileG}>
            <div
              className={cn(
                "relative h-full",
                canTileG && "flex min-w-full flex-row"
              )}
            >
              {/* Strip order reaches the screen only through CSS `order`:
                  a reorder that moved these nodes would reset each moved
                  transcript's scroll offset and blank it (see
                  stableTabViewOrder). */}
              {stableTabViewOrder(groupTabs).map(({ tab, visualIndex }) =>
                renderTabWrapper(tab, visualIndex, groupId, canTileG)
              )}
            </div>
          </TileScrollContainer>
          {/* Drop-target cue while a tab from another group hovers here. */}
          {dragOverGroupId === groupId && (
            <div className="pointer-events-none absolute inset-0 z-30 bg-primary/5 ring-2 ring-inset ring-primary/30" />
          )}
        </div>
      </div>
    )
  }

  // While UNSPLIT, a single header sits fixed above the horizontally-scrolling
  // tile row, so it never scrolls on the x-axis when conversations are tiled.
  // It reflects the ACTIVE conversation (title + owning folder). On mobile
  // there's no tile row — it's simply the sole conversation's header. While
  // SPLIT, every group shell renders its own header under its strip (the
  // "tabs + title bar" pairing per group), so the global one steps aside.
  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? null
  const activeTabFolder = activeTab
    ? allFolders.find((f) => f.id === activeTab.folderId)
    : undefined

  return (
    <>
      <div className="flex h-full min-h-0 flex-col overflow-hidden">
        {!isSplit && activeTab && (
          <ConversationDetailHeader
            tabId={activeTab.id}
            conversationId={activeTab.conversationId}
            runtimeConversationId={activeTab.runtimeConversationId ?? null}
            folderId={activeTab.folderId}
            folderPath={activeTabFolder?.path}
            title={activeTab.title}
            status={activeTab.status as ConversationStatus | undefined}
          />
        )}
        <ContextMenu
          open={panelMenu.open}
          onOpenChange={panelMenu.onOpenChange}
        >
          <ContextMenuTrigger asChild>
            <div
              ref={groupContainerRef}
              className="relative min-h-0 flex-1 overflow-hidden"
              onPointerDownCapture={panelMenu.onPointerDownCapture}
            >
              {/* Flat sibling shells keyed by stable group id + divider
                  overlays — stable across every split/tile flip, otherwise
                  sibling tabs remount and a live streaming response is torn
                  down. */}
              {orderedGroupIds.map((groupId) => renderGroupShell(groupId))}
              {/* The handles resize the on-screen view's own layout (a
                  folder's, while tabs follow the folder), which the visible
                  one only differs from before the tab set is known. */}
              {isSplit &&
                visibleLayout === groupLayout &&
                groupHandles.map((handle) => (
                  <GroupSplitHandle
                    key={`${handle.splitId}:${handle.index}`}
                    handle={handle}
                    containerRef={groupContainerRef}
                    onResize={resizeGroupSplit}
                  />
                ))}
              {/* The selected folder has nothing open: every shell above is
                  hidden, other folders' live tabs included. */}
              {tabsFollowFolder && visibleTabs.length === 0 && (
                <div className="absolute inset-0">
                  <FolderTabsEmptyState />
                </div>
              )}
            </div>
          </ContextMenuTrigger>
          <ContextMenuContent>
            <ContextMenuItem
              disabled={!folder?.path}
              onSelect={handleNewConversation}
            >
              <SquarePen className="h-4 w-4" />
              {t("newConversation")}
            </ContextMenuItem>
            <ContextMenuSub>
              <ContextMenuSubTrigger disabled={!canExport}>
                <Download className="h-4 w-4" />
                {t("exportConversation")}
              </ContextMenuSubTrigger>
              <ContextMenuSubContent>
                <ContextMenuItem onSelect={handleExportImage}>
                  <FileImage className="h-4 w-4" />
                  {t("exportImage")}
                </ContextMenuItem>
                <ContextMenuItem onSelect={handleExportMarkdown}>
                  <FileText className="h-4 w-4" />
                  {t("exportMarkdown")}
                </ContextMenuItem>
                <ContextMenuItem onSelect={handleExportHtml}>
                  <FileCode className="h-4 w-4" />
                  {t("exportHtml")}
                </ContextMenuItem>
              </ContextMenuSubContent>
            </ContextMenuSub>
            <ContextMenuItem
              disabled={!canReloadActiveConversation}
              onSelect={handleReloadActiveConversation}
            >
              <RefreshCw className="h-4 w-4" />
              {t("reload")}
            </ContextMenuItem>
            <ContextMenuItem
              disabled={!activeSessionSummary}
              onSelect={() => setDetailsOpen(true)}
            >
              <Info className="h-4 w-4" />
              {tDetails("menuLabel")}
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem
              disabled={!activeTabId}
              onSelect={handleCloseActiveTab}
            >
              <X className="h-4 w-4" />
              {t("closeConversation")}
            </ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
      </div>
      <TabDragGhost />
      <AskConversationDrawer />
      {activeSessionSummary && (
        <SessionDetailsDialog
          open={detailsOpen}
          onOpenChange={setDetailsOpen}
          summary={activeSessionSummary}
          stats={activeSessionStats}
          model={activeSessionModel}
        />
      )}
    </>
  )
}
