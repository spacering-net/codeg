import { create } from "zustand"
import type { LinkedConversationKind } from "@/hooks/use-ask-conversations"
import type { AgentType, PromptDraft } from "@/lib/types"
import {
  clearConnectSelection,
  setConnectSelection,
} from "@/lib/selector-prefs-storage"
import { randomUUID } from "@/lib/utils"

/** What the ask drawer shows. */
export interface AskConversationDrawerTarget {
  /** ACP connection key of the drawer's surface — stable for as long as this
   *  target is open, and the drawer's remount key. */
  contextKey: string
  /** An ask conversation, or a check of a message (the personal agent's "is
   *  this right?"): which of its main conversation's lists it is on. A new
   *  one is always an ask. */
  kind: LinkedConversationKind
  /** The main conversation the ask belongs to (its list is where the drawer's
   *  header looks the ask's title up). */
  parentConversationId: number
  /** The ask conversation, or `null` until a new ask's first send creates it. */
  conversationId: number | null
  agentType: AgentType
  /** Folder the conversation runs in — the ask's own, or (for a new one) the
   *  main conversation's when the ask was composed, which is where its row is
   *  created. */
  folderId: number
  /** Fallback cwd while the folder list doesn't know `folderId` yet. */
  workingDir: string | null
  /** A new ask's first message, sent as soon as the drawer's agent is ready. */
  initialSend: { draft: PromptDraft; modeId: string | null } | null
}

interface AskConversationDrawerState {
  target: AskConversationDrawerTarget | null
  /**
   * A close or replace was just refused because the open ask's first message
   * hadn't gone out yet (see {@link holdsUnsentMessage}). The next attempt
   * goes through.
   */
  discardArmed: boolean
  /** Connection key of the surface whose first send is creating its row and
   *  sending — until that settles, the message has not reached the agent. */
  creatingKey: string | null
  /** Open an existing ask (or check) conversation. Re-opening the one already
   *  on show keeps its surface (and connection key) as it is. `false` when
   *  refused. */
  openExisting: (args: {
    kind: LinkedConversationKind
    parentConversationId: number
    conversationId: number
    agentType: AgentType
    folderId: number
    workingDir: string | null
  }) => boolean
  /** Open a new ask that sends `initialSend` once connected. `false` when
   *  refused. `configValues` are the config options the ask's composer
   *  showed: its connection starts from them (`setConnectSelection`) rather
   *  than from the agent's saved new-conversation default alone. */
  openNew: (args: {
    parentConversationId: number
    agentType: AgentType
    folderId: number
    workingDir: string | null
    initialSend: { draft: PromptDraft; modeId: string | null }
    configValues?: Record<string, string> | null
  }) => boolean
  /** The open draft's first send created its row, filed under
   *  `parentConversationId`. Ignored for any other key. */
  setCreated: (
    contextKey: string,
    conversationId: number,
    parentConversationId: number
  ) => void
  /** The open target's first message has been handed to the surface. */
  consumeInitialSend: (contextKey: string) => void
  /** The surface under `contextKey` started / finished its first send. */
  setCreating: (contextKey: string, creating: boolean) => void
  /** `false` when refused. */
  close: () => boolean
}

/**
 * Whether taking the drawer's current target away now would throw away a
 * question: a new ask whose first message is still waiting for its agent, or
 * is being created and sent. Its only copy lives in the drawer — the bubble
 * that composed it is gone, and unmounting the surface mid-send drops the
 * connection the send is waiting on — so the first close or replace is
 * refused (the caller says why) and only a second one discards it.
 */
function holdsUnsentMessage(state: AskConversationDrawerState): boolean {
  const target = state.target
  if (!target) return false
  return target.initialSend != null || state.creatingKey === target.contextKey
}

export const useAskConversationDrawerStore =
  create<AskConversationDrawerState>()((set, get) => {
    /** Refuse the first attempt to drop an unsent message; let the next one
     *  through. Returns whether the caller may proceed. */
    const mayLeave = (): boolean => {
      const state = get()
      if (!holdsUnsentMessage(state) || state.discardArmed) return true
      set({ discardArmed: true })
      return false
    }
    /** The target on show is going away: its surface unmounts with it, so the
     *  one-off selection its connection started from has nobody left to read
     *  it. */
    const release = () => {
      const current = get().target
      if (current) clearConnectSelection(current.contextKey)
    }
    return {
      target: null,
      discardArmed: false,
      creatingKey: null,
      openExisting: (args) => {
        const current = get().target
        if (current?.conversationId === args.conversationId) return true
        if (!mayLeave()) return false
        release()
        set({
          discardArmed: false,
          target: {
            ...args,
            // One key per conversation: re-opening it later re-attaches to
            // the connection the previous visit left behind, if it is still
            // up.
            contextKey: `ask-drawer-${args.conversationId}`,
            initialSend: null,
          },
        })
        return true
      },
      openNew: ({ configValues, ...args }) => {
        if (!mayLeave()) return false
        release()
        const contextKey = `ask-drawer-new-${randomUUID()}`
        // Registered before the target is published, so it is in place
        // before the drawer's surface can connect.
        if (configValues) {
          setConnectSelection(contextKey, args.agentType, configValues)
        }
        set({
          discardArmed: false,
          target: {
            ...args,
            kind: "ask",
            contextKey,
            conversationId: null,
          },
        })
        return true
      },
      setCreated: (contextKey, conversationId, parentConversationId) => {
        const current = get().target
        if (current?.contextKey !== contextKey) return
        set({ target: { ...current, conversationId, parentConversationId } })
      },
      consumeInitialSend: (contextKey) => {
        const current = get().target
        if (current?.contextKey !== contextKey || !current.initialSend) return
        set({ discardArmed: false, target: { ...current, initialSend: null } })
      },
      setCreating: (contextKey, creating) => {
        const current = get().creatingKey
        if (creating) {
          if (current !== contextKey) set({ creatingKey: contextKey })
        } else if (current === contextKey) {
          set({ creatingKey: null, discardArmed: false })
        }
      },
      close: () => {
        if (!mayLeave()) return false
        release()
        set({ discardArmed: false, target: null })
        return true
      },
    }
  })
