"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { useAcpActions } from "@/contexts/acp-connections-context"
import { useTaskContext } from "@/contexts/task-context"
import { useConnection, type UseConnectionReturn } from "@/hooks/use-connection"
import { extractAppCommandError } from "@/lib/app-error"
import { notify } from "@/lib/notify"
import { isConnectionBusy } from "@/lib/connection-teardown"
import { TurnBusyError } from "@/lib/turn-busy"
import { type AgentType, type PromptDraft } from "@/lib/types"
import { getAgentLabel } from "@/lib/custom-agents"

interface UseConnectionLifecycleOptions {
  contextKey: string
  agentType: AgentType
  isActive: boolean
  workingDir?: string
  sessionId?: string
  /**
   * Persisted conversation id (when known). Passed to `connect()` so it can
   * discover and attach to a live connection another client already owns
   * (cross-client viewing) instead of always spawning a fresh agent.
   */
  conversationId?: number
  /**
   * True while the CALLER is deliberately holding auto-connect back until it
   * has resolved something the connection needs — today a historical
   * conversation's `external_id`, which must be known before connecting or the
   * backend falls back to `session/new` and orphans the history.
   *
   * It exists because `isActive` cannot say this: callers pass
   * `isActive && canConnectYet`, which collapses "this tab is in the
   * background" (nothing should happen) with "this tab is opening and is
   * waiting on its own fetch" (something IS happening, it just has nothing to
   * show yet). Without the distinction that wait — the first, silent leg of
   * opening an old conversation — produced no loading state and no status-bar
   * task, so the window read as a dead composer.
   *
   * Callers should AND it with their own active flag: a background tab must not
   * put a row in the (global) status bar.
   */
  preparing?: boolean
  /**
   * Read at unmount-cleanup time: true when the component is unmounting
   * because the view is being REPARENTED (its tab moved between split groups /
   * an unsplit merged it), not closed. A transient unmount must not
   * disconnect — the remounted instance re-attaches to the same live
   * connection under the same contextKey.
   */
  isTransientUnmount?: () => boolean
}

export interface UseConnectionLifecycleReturn {
  conn: UseConnectionReturn
  modeLoading: boolean
  configOptionsLoading: boolean
  selectorsLoading: boolean
  autoConnectError: string | null
  handleFocus: () => void
  handleSend: (
    draft: PromptDraft,
    modeId?: string | null,
    opts?: {
      folderId?: number | null
      conversationId?: number | null
      clientMessageId?: string | null
      /**
       * Called when the backend rejected the send because a turn was already
       * in flight (a second, concurrent prompt). The caller re-queues the
       * draft instead of treating it as an error.
       */
      onTurnInProgress?: () => void
      /**
       * Called for every OTHER send failure (413, hydration failure, network
       * drop) after the error toast is shown. The caller must settle any
       * optimistic state it created for this send — roll back the optimistic
       * user turn so the conversation doesn't stay `awaiting_persist` (which
       * would block queue auto-flush) and doesn't display the failed prompt
       * as though it were sent. The draft is deliberately NOT re-queued: a
       * deterministic failure would otherwise retry forever.
       */
      onSendFailed?: (error: unknown) => void
    }
  ) => void
  handleSetConfigOption: (configId: string, valueId: string) => void
  handleCancel: () => void
  handleRespondPermission: (requestId: string, optionId: string) => void
}

/**
 * Unmount-cleanup decision: disconnect unless this client OWNS a connection
 * that still has work in flight — a prompting turn, or launched-but-unresolved
 * background tasks (async sub-agents / background shells). Disconnecting an
 * owner kills the agent CLI, and the background work with it; busy owners are
 * left to the idle sweeps, which exempt them until the work settles (or the
 * backend max-age valve expires it). Viewers always tear down: their
 * disconnect only detaches (never kills the owner's agent), and the sweep
 * skips viewers so leaving one attached would leak its subscription.
 * EXCEPT on a transient unmount (tab reparented across split groups, not
 * closed): the remounted view re-attaches to the same connection, so neither
 * owners nor viewers tear down.
 * Shares `isConnectionBusy` with the preview-replacement release
 * (`disconnectIfIdle`) so the two teardown paths can't drift apart.
 * Exported for tests.
 */
export function shouldDisconnectOnUnmount(args: {
  status: string | null
  isViewer: boolean
  backgroundOutstanding: number
  transientUnmount?: boolean
}): boolean {
  if (args.transientUnmount) return false
  if (args.isViewer) return true
  return !isConnectionBusy(args)
}

function normalizeErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

function isExpectedConnectError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false
  return (error as { alerted?: unknown }).alerted === true
}

export function useConnectionLifecycle({
  contextKey,
  agentType,
  isActive,
  workingDir,
  sessionId,
  conversationId,
  preparing = false,
  isTransientUnmount,
}: UseConnectionLifecycleOptions): UseConnectionLifecycleReturn {
  const t = useTranslations("Folder.chat.connectionLifecycle")
  const { setActiveKey, touchActivity } = useAcpActions()
  const { addTask, updateTask, removeTask } = useTaskContext()
  const conn = useConnection(contextKey)

  // Destructure stable callbacks (depend only on actions + contextKey)
  // vs. volatile derived state (status, modes, etc.)
  const {
    status,
    selectorsReady,
    connect: connConnect,
    disconnect: connDisconnect,
    sendPrompt,
    setMode: connSetMode,
    setConfigOption: connSetConfigOption,
    cancel: connCancel,
    respondPermission: connRespondPermission,
    modes,
    configOptions,
    hasCachedSelectors,
  } = conn
  const isInteractiveStatus = status === "connected" || status === "prompting"
  const hasSelectorsData = modes !== null || configOptions !== null
  const effectiveSelectorsReady = selectorsReady || hasSelectorsData
  const selectorTaskIdRef = useRef<string | null>(null)
  // Visual-only loading indicators for selector chips.
  // Skip loading indicators when we have cached selectors — even if the
  // cache contains no modes/configOptions (the agent simply doesn't have
  // them), we already know what to show and don't need a loading state.
  // `preparing` is the leg BEFORE `connecting`, when the caller is still
  // resolving what to connect to; the selectors are just as unknown there, and
  // leaving it out is what made an opening conversation show a bare composer.
  const selectorsPending =
    preparing ||
    status === "connecting" ||
    (isInteractiveStatus && !effectiveSelectorsReady)
  const modeLoading = !hasCachedSelectors && selectorsPending
  const configOptionsLoading = !hasCachedSelectors && selectorsPending
  // Gate for send button: block until the backend session is fully
  // initialized (selectorsReady from the real backend event, not cache).
  const selectorsLoading = isInteractiveStatus && !selectorsReady
  const [lastAutoConnectError, setLastAutoConnectError] = useState<{
    contextKey: string
    agentType: AgentType
    message: string
  } | null>(null)

  // Refs for auto-connect effect, which intentionally avoids volatile
  // dependencies to prevent reconnect loops. Synced via useEffect —
  // effects run in declaration order, so these are current before
  // the auto-connect effect reads them.
  const statusRef = useRef(status)
  useEffect(() => {
    statusRef.current = status
  }, [status])
  const isViewerRef = useRef(conn.isViewer)
  useEffect(() => {
    isViewerRef.current = conn.isViewer
  }, [conn.isViewer])
  const backgroundOutstandingRef = useRef(conn.backgroundOutstanding)
  useEffect(() => {
    backgroundOutstandingRef.current = conn.backgroundOutstanding
  }, [conn.backgroundOutstanding])
  const contextKeyRef = useRef(contextKey)
  useEffect(() => {
    contextKeyRef.current = contextKey
  }, [contextKey])
  const connConnectRef = useRef(connConnect)
  useEffect(() => {
    connConnectRef.current = connConnect
  }, [connConnect])
  const sessionIdRef = useRef(sessionId)
  useEffect(() => {
    sessionIdRef.current = sessionId
  }, [sessionId])
  const conversationIdRef = useRef(conversationId)
  useEffect(() => {
    conversationIdRef.current = conversationId
  }, [conversationId])
  const modeIdRef = useRef<string | null>(modes?.current_mode_id ?? null)
  useEffect(() => {
    modeIdRef.current = modes?.current_mode_id ?? null
  }, [modes?.current_mode_id])
  // Sync activeKey when this view is the active tab
  useEffect(() => {
    if (isActive && contextKey) {
      setActiveKey(contextKey)
      touchActivity(contextKey)
    }
  }, [isActive, contextKey, setActiveKey, touchActivity])

  // Auto-connect when tab becomes active and workingDir is available.
  // Depends on isActive + workingDir + agentType so that connections wait
  // for folder info to load (workingDir transitions from undefined →
  // folder.path), and so that changing folders or agents on an already-
  // connected tab triggers a reconnect. The context's connect() dedups
  // same-param calls and disconnects+reconnects when workingDir or
  // agentType differs. Status changes must NOT re-trigger this to avoid
  // infinite reconnect loops on transient errors.
  useEffect(() => {
    if (!isActive) return
    if (!workingDir) return
    let cancelled = false
    connConnectRef
      .current(
        agentType,
        workingDir,
        sessionIdRef.current,
        conversationIdRef.current
      )
      .then(() => {
        if (!cancelled) {
          setLastAutoConnectError(null)
        }
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setLastAutoConnectError({
            contextKey: contextKeyRef.current,
            agentType,
            message: normalizeErrorMessage(e),
          })
        }
        if (!isExpectedConnectError(e)) {
          console.error("[ConnLifecycle] auto-connect:", e)
        }
      })
    return () => {
      cancelled = true
    }
  }, [isActive, workingDir, agentType])

  // Status-bar task for the two legs that precede a usable session:
  //   "preparing"  — the caller is resolving what to connect to (see `preparing`)
  //   "connecting" — `connect()` is in flight: agent spawn, ACP `initialize`,
  //                  then `session/resume|load|new`
  // (The third leg, session init after `connected`, has its own task below.)
  // A task's label is fixed when it is added, so a leg change retires the old
  // row and mints a new one rather than leaving stale wording on screen.
  const taskIdRef = useRef<string | null>(null)
  const taskPhaseRef = useRef<"preparing" | "connecting" | null>(null)
  useEffect(() => {
    const phase =
      status === "connecting" ? "connecting" : preparing ? "preparing" : null
    if (phase !== null && phase === taskPhaseRef.current) return
    taskPhaseRef.current = phase
    if (taskIdRef.current) {
      const finished = taskIdRef.current
      taskIdRef.current = null
      if (
        phase === null &&
        (status === "connected" || status === "prompting")
      ) {
        updateTask(finished, { status: "completed" })
      } else if (phase === null && status === "error") {
        updateTask(finished, {
          status: "failed",
          error: t("errors.connectionFailed"),
        })
      } else {
        removeTask(finished)
      }
    }
    if (phase === null) return
    const id = `acp-${phase}-${Date.now()}`
    taskIdRef.current = id
    const agent = getAgentLabel(agentType)
    addTask(
      id,
      phase === "connecting"
        ? t("tasks.connectingTitle", { agent })
        : t("tasks.preparingTitle", { agent }),
      phase === "connecting"
        ? t("tasks.connectingDescription")
        : t("tasks.preparingDescription")
    )
    updateTask(id, { status: "running" })
  }, [status, preparing, addTask, updateTask, removeTask, agentType, t])

  const clearSelectorTask = useCallback(() => {
    if (selectorTaskIdRef.current) {
      removeTask(selectorTaskIdRef.current)
      selectorTaskIdRef.current = null
    }
  }, [removeTask])

  useEffect(() => {
    const isInteractive = status === "connected" || status === "prompting"
    if (!isInteractive) {
      clearSelectorTask()
      return
    }

    if (selectorsReady) {
      clearSelectorTask()
      return
    }

    if (!selectorTaskIdRef.current) {
      const id = `acp-session-init-${Date.now()}`
      selectorTaskIdRef.current = id
      const agent = getAgentLabel(agentType)
      addTask(
        id,
        t("tasks.initSessionTitle", { agent }),
        t("tasks.initSessionDescription")
      )
      updateTask(id, { status: "running" })
    }
  }, [
    status,
    selectorsReady,
    agentType,
    addTask,
    updateTask,
    clearSelectorTask,
    t,
  ])

  // Keep a ref to disconnect so the unmount cleanup always calls the
  // latest version without adding it as a dependency.
  const connDisconnectRef = useRef(connDisconnect)
  useEffect(() => {
    connDisconnectRef.current = connDisconnect
  }, [connDisconnect])
  const isTransientUnmountRef = useRef(isTransientUnmount)
  useEffect(() => {
    isTransientUnmountRef.current = isTransientUnmount
  }, [isTransientUnmount])

  // Clean up on unmount (e.g. tab closed): disconnect the ACP connection
  // so it doesn't leak, and remove lingering tasks.
  // However, if the agent is actively prompting (generating a response),
  // keep it alive so it can finish in the background — the idle sweep
  // will clean it up once it transitions back to "connected".
  useEffect(() => {
    return () => {
      // Owners keep a prompting agent alive in the background to finish the
      // turn (the idle sweep reclaims it once it returns to "connected"), and
      // likewise while background work is still outstanding (async sub-agents
      // / background shells) — disconnecting kills the agent CLI and the
      // background work with it. Both sweeps already exempt such connections;
      // once the work settles (or the max-age valve expires it) outstanding
      // drops to 0 and the normal idle sweep reclaims the connection.
      // Viewers are different: disconnect() only DETACHES them (it never
      // acpDisconnects — that belongs to the owner), so tearing a viewer down
      // mid-turn is safe and leaves the owner's agent untouched. And it's
      // necessary: the idle sweep skips viewers, so a viewer left attached
      // here would leak its WS subscription until the whole provider unmounts.
      if (
        shouldDisconnectOnUnmount({
          status: statusRef.current,
          isViewer: isViewerRef.current,
          backgroundOutstanding: backgroundOutstandingRef.current,
          transientUnmount: isTransientUnmountRef.current?.() === true,
        })
      ) {
        connDisconnectRef.current().catch(() => {})
      }
      // Task cleanup stays unconditional even on transient unmounts — the
      // remounted instance mints fresh task ids, so stale ones would orphan.
      if (taskIdRef.current) {
        removeTask(taskIdRef.current)
      }
      clearSelectorTask()
    }
  }, [removeTask, clearSelectorTask])

  const handleFocus = useCallback(() => {
    // Respect the caller's readiness gate — e.g. historical conversations
    // set isActive=false until the session's external_id resolves, to
    // avoid connecting with sessionId=undefined and orphaning context.
    if (!isActive) return
    touchActivity(contextKey)
    if (!status || status === "disconnected" || status === "error") {
      setLastAutoConnectError(null)
      connConnect(agentType, workingDir, sessionId, conversationId).catch(
        (e: unknown) => {
          if (!isExpectedConnectError(e)) {
            console.error("[ConnLifecycle] connect:", e)
          }
        }
      )
    }
  }, [
    isActive,
    agentType,
    workingDir,
    sessionId,
    conversationId,
    status,
    connConnect,
    contextKey,
    touchActivity,
  ])

  const autoConnectError =
    status === "connected" || status === "prompting"
      ? null
      : lastAutoConnectError?.contextKey === contextKey &&
          lastAutoConnectError.agentType === agentType
        ? lastAutoConnectError.message
        : null

  // sendPrompt, connCancel, connRespondPermission are stable (depend
  // only on actions + contextKey), so these callbacks are effectively stable.
  const handleSend = useCallback(
    (
      draft: PromptDraft,
      modeId?: string | null,
      opts?: {
        folderId?: number | null
        conversationId?: number | null
        clientMessageId?: string | null
        onTurnInProgress?: () => void
        onSendFailed?: (error: unknown) => void
      }
    ) => {
      touchActivity(contextKey)
      const onTurnInProgress = opts?.onTurnInProgress
      const onSendFailed = opts?.onSendFailed
      void (async () => {
        const currentModeId = modeIdRef.current
        if (modeId && modeId !== currentModeId) {
          await connSetMode(modeId)
          // Optimistically track selected mode to avoid duplicate set_mode
          // calls before CurrentModeUpdate arrives from the agent.
          modeIdRef.current = modeId
        }
        await sendPrompt(draft.blocks, opts)
      })().catch((e: unknown) => {
        if (e instanceof TurnBusyError) {
          // A turn was already in flight on the connection (another
          // co-controlling client, or a "prompting" status this client hadn't
          // observed yet). Not an error — the draft is re-queued by the caller
          // so it auto-sends when the current turn finishes.
          onTurnInProgress?.()
          return
        }
        console.error("[ConnLifecycle] sendPrompt:", e)
        // The composer already cleared itself (sends are fire-and-forget), so
        // without a toast a failed send — an oversized body 413'd by the
        // server, a hydration failure, a network drop — looks like the message
        // simply vanished. Surface the failure; prefer the structured backend
        // message over a bare stringification.
        const appError = extractAppCommandError(e)
        const message =
          appError?.message ??
          (e instanceof Error ? e.message : String(e ?? "unknown error"))
        notify({
          level: "error",
          key: `send-failed:${contextKey}`,
          title: t("errors.sendPromptFailed", { error: message }),
        })
        // Let the caller settle its optimistic state (roll back the phantom
        // user turn, drop out of awaiting_persist so the queue keeps
        // flushing). Runs after the toast so the state rollback can't hide
        // the failure.
        onSendFailed?.(e)
      })
    },
    [connSetMode, sendPrompt, contextKey, touchActivity, t]
  )

  const handleCancel = useCallback(() => {
    connCancel().catch((e: unknown) =>
      console.error("[ConnLifecycle] cancel:", e)
    )
  }, [connCancel])

  const handleSetConfigOption = useCallback(
    (configId: string, valueId: string) => {
      touchActivity(contextKey)
      connSetConfigOption(configId, valueId).catch((e: unknown) =>
        console.error("[ConnLifecycle] setConfigOption:", e)
      )
    },
    [connSetConfigOption, contextKey, touchActivity]
  )

  const handleRespondPermission = useCallback(
    (requestId: string, optionId: string) => {
      touchActivity(contextKey)
      connRespondPermission(requestId, optionId).catch((e: unknown) =>
        console.error("[ConnLifecycle] respondPermission:", e)
      )
    },
    [connRespondPermission, contextKey, touchActivity]
  )

  return {
    conn,
    modeLoading,
    configOptionsLoading,
    selectorsLoading,
    autoConnectError,
    handleFocus,
    handleSend,
    handleSetConfigOption,
    handleCancel,
    handleRespondPermission,
  }
}
