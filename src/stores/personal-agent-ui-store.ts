import { create } from "zustand"

import type { AgentType, DispatchMode, DispatchState } from "@/lib/types"

/**
 * The personal agent page's view state that other branches of the tree read:
 * whether the side panel is open and on which tab (the window chrome's
 * buttons drive it), whether the page shows the owner the newest messages
 * right now (the sidebar's unread badge stands down while it does), and the
 * handed-out work open in the drawer on the right (any card, in the list or
 * the panel, opens it). One-shot requests (open the settings, the session,
 * the "new session" confirmation) go as window events instead — nothing
 * reads them back.
 */

/** The side panel's tabs: the agent's status (the one it opens on), the
 *  work (what is open, what ended), and its numbers. */
export type AuxTab = "status" | "work" | "stats"

/** Window events the chrome sends the page. */
export const PERSONAL_AGENT_EVENTS = {
  openSettings: "codeg:open-personal-agent-settings",
  openSession: "codeg:open-personal-agent-session",
  newSession: "codeg:personal-agent-new-session",
} as const

/** A piece of handed-out work, as the card that opens it knows it: the
 *  drawer reads the dispatch's newer state by its id when it has it. */
export interface WorkTarget {
  dispatchId: number | null
  mode: DispatchMode | null
  workTaskId: number | null
  conversationId: number | null
  /** The folder the conversation sits in (a chat dispatch's hidden one), or
   *  the task's project. */
  folderId: number | null
  agentType: AgentType | null
  title: string | null
  executorId: number | null
  executorName: string | null
  /** What the work was handed out with: the conversation's first message. */
  prompt: string | null
  connectionId: string | null
  state: DispatchState | null
}

interface PersonalAgentUiState {
  auxOpen: boolean
  auxTab: AuxTab
  setAuxOpen: (open: boolean) => void
  toggleAux: () => void
  /** Open the panel on `tab`. */
  showAux: (tab: AuxTab) => void
  setAuxTab: (tab: AuxTab) => void
  /** The panel's folding sections the owner opened or closed, by key; one
   *  left out is as its section starts. Kept here so a tab switched away
   *  from and back keeps them. */
  auxFolds: Record<string, boolean>
  setAuxFold: (key: string, open: boolean) => void
  /** The page is open in this window, the window has focus, and the list is
   *  at its bottom: what comes in is seen as it lands. */
  watching: boolean
  setWatching: (watching: boolean) => void
  /** The work in the drawer; kept once it closes, for its way out. */
  work: WorkTarget | null
  workOpen: boolean
  openWork: (target: WorkTarget) => void
  setWorkOpen: (open: boolean) => void
}

export const usePersonalAgentUi = create<PersonalAgentUiState>((set) => ({
  auxOpen: true,
  auxTab: "status",
  setAuxOpen: (auxOpen) => set({ auxOpen }),
  toggleAux: () => set((s) => ({ auxOpen: !s.auxOpen })),
  showAux: (auxTab) => set({ auxOpen: true, auxTab }),
  setAuxTab: (auxTab) => set({ auxTab }),
  auxFolds: {},
  setAuxFold: (key, open) =>
    set((s) => ({ auxFolds: { ...s.auxFolds, [key]: open } })),
  watching: false,
  setWatching: (watching) => set({ watching }),
  work: null,
  workOpen: false,
  openWork: (work) => set({ work, workOpen: true }),
  setWorkOpen: (workOpen) => set({ workOpen }),
}))
