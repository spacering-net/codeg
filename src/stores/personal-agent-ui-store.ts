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

/** The side panel's tabs (10.1): the details (its status, its open
 *  matters, its numbers — the one it opens on), what it made, and the work
 *  running now. */
export type AuxTab = "details" | "output" | "workspace"

/** Window events the chrome sends the page. */
export const PERSONAL_AGENT_EVENTS = {
  openSession: "codeg:open-personal-agent-session",
  newSession: "codeg:personal-agent-new-session",
} as const

/** The pages of the settings view (13.1): the assistant's own, then the
 *  ones every assistant shares. */
export type SettingsPage =
  | "identity"
  | "persona"
  | "execution"
  | "advanced"
  | "workers"
  | "executors"
  | "division"
  | "communication"
  | "automation"

/** The settings view, while it is open: on which page, and — for the
 *  assistant's own pages — whose (`null`: the page's own assistant). */
export interface SettingsOpen {
  page: SettingsPage
  bot: number | null
}

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
  /** The settings view, open in place of the conversation; kept here so a
   *  request made before the page mounts (another window's "open the
   *  executor configs") finds it open. */
  settings: SettingsOpen | null
  openSettings: (page?: SettingsPage, bot?: number | null) => void
  closeSettings: () => void
  /** The assistant the page shows (`null`: the primary), picked in the
   *  roster. Switching closes what was open about the other one. */
  viewBot: number | null
  setViewBot: (bot: number | null) => void
}

export const usePersonalAgentUi = create<PersonalAgentUiState>((set) => ({
  auxOpen: true,
  auxTab: "details",
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
  settings: null,
  openSettings: (page = "identity", bot = null) =>
    set({ settings: { page, bot } }),
  closeSettings: () => set({ settings: null }),
  viewBot: null,
  setViewBot: (viewBot) =>
    set((s) =>
      s.viewBot === viewBot
        ? s
        : { viewBot, settings: null, workOpen: false, watching: false }
    ),
}))
