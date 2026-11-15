import { create } from "zustand"

import type {
  AgentType,
  DispatchMode,
  DispatchState,
  RoutineDraft,
} from "@/lib/types"

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

/** The side panel's tabs (10.1): its activity (today, its open matters,
 *  its routines — the one it opens on), what it made, the work running now,
 *  and its numbers (how it runs, its context, its charts). */
export type AuxTab = "activity" | "output" | "workspace" | "stats"

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
  | "notify"
  | "advanced"
  | "workers"
  | "executors"
  | "division"
  | "communication"
  | "proactive"
  | "automation"
  | "about"

/** The settings view, while it is open: on which page, and — for the
 *  assistant's own pages — whose (`null`: the page's own assistant). */
export interface SettingsOpen {
  page: SettingsPage
  bot: number | null
  /** The persona page's file to open on: a memory entry a card or a reply
   *  names (7.7). */
  entry?: string | null
}

/** The executor config editor, asked to open from a card (10.5): an
 *  existing one by id, or a new one with its fields filled in. `key`
 *  tells two requests for the same one apart. */
export interface ExecutorEditorRequest {
  key: number
  assistantId: number | null
  prefill: ExecutorEditorPrefill | null
}

/** A new executor config's starting fields, as a card asks for them. */
export interface ExecutorEditorPrefill {
  name?: string
  description?: string
  instructions?: string
  template?: string
  agentType?: AgentType | null
  options?: { mode_id?: string | null; config_values: Record<string, string> }
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

/** The routine editor (6.9): on one routine, or a new one prefilled. */
export interface RoutineEditorRequest {
  key: number
  /** The assistant whose; `null`: the primary. */
  botId: number | null
  routineId: number | null
  draft: RoutineDraft | null
  /** The card it was opened from: settled when it is saved. */
  noticeId: number | null
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
  openSettings: (
    page?: SettingsPage,
    bot?: number | null,
    entry?: string | null
  ) => void
  closeSettings: () => void
  /** The executor configs' page, with its editor open on one (or a new one
   *  prefilled); taken by the page once it opens it. */
  executorEditor: ExecutorEditorRequest | null
  openExecutorEditor: (
    assistantId: number | null,
    prefill?: ExecutorEditorPrefill | null
  ) => void
  clearExecutorEditor: () => void
  /** The routine editor, when open. */
  routineEditor: RoutineEditorRequest | null
  openRoutineEditor: (req: Omit<RoutineEditorRequest, "key">) => void
  closeRoutineEditor: () => void
  /** Bumped to bring the activity's routines into view (`pa.open`). */
  routinesAsked: number
  showRoutines: () => void
  /** The assistant the page shows (`null`: the primary), picked in the
   *  roster. Switching closes what was open about the other one. */
  viewBot: number | null
  setViewBot: (bot: number | null) => void
  /** The assistant whose conversation this window shows the owner right
   *  now (its real id, the primary's too): the page is the active route
   *  and the settings view is not over it. The presence beat carries it —
   *  an assistant being looked at is not notified (1.13). */
  viewing: number | null
  setViewing: (bot: number | null) => void
  /** A row to show once the page is on its assistant: a notification
   *  followed (1.13). */
  pendingJump: { bot: number; row: number } | null
  setPendingJump: (jump: { bot: number; row: number } | null) => void
  /** Bumped to bring "Today" into view (the primary's pill, 1.14): the
   *  panel opens on its activity, scrolled to it. */
  todayAsked: number
  showToday: () => void
  /** The time machine's search is open (8.2). */
  searchOpen: boolean
  setSearchOpen: (open: boolean) => void
}

export const usePersonalAgentUi = create<PersonalAgentUiState>((set) => ({
  auxOpen: true,
  auxTab: "activity",
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
  openSettings: (page = "identity", bot = null, entry = null) =>
    set({ settings: entry ? { page, bot, entry } : { page, bot } }),
  closeSettings: () => set({ settings: null }),
  executorEditor: null,
  openExecutorEditor: (assistantId, prefill = null) =>
    set((s) => ({
      settings: { page: "executors", bot: null },
      executorEditor: {
        key: (s.executorEditor?.key ?? 0) + 1,
        assistantId,
        prefill,
      },
    })),
  clearExecutorEditor: () => set({ executorEditor: null }),
  routineEditor: null,
  openRoutineEditor: (req) =>
    set((s) => ({
      routineEditor: { ...req, key: (s.routineEditor?.key ?? 0) + 1 },
    })),
  closeRoutineEditor: () => set({ routineEditor: null }),
  routinesAsked: 0,
  showRoutines: () =>
    set((s) => ({
      auxOpen: true,
      auxTab: "activity",
      routinesAsked: s.routinesAsked + 1,
    })),
  viewBot: null,
  setViewBot: (viewBot) =>
    set((s) =>
      s.viewBot === viewBot
        ? s
        : { viewBot, settings: null, workOpen: false, watching: false }
    ),
  viewing: null,
  setViewing: (viewing) =>
    set((s) => (s.viewing === viewing ? s : { viewing })),
  pendingJump: null,
  setPendingJump: (pendingJump) => set({ pendingJump }),
  todayAsked: 0,
  showToday: () =>
    set((s) => ({
      auxOpen: true,
      auxTab: "activity",
      todayAsked: s.todayAsked + 1,
    })),
  searchOpen: false,
  setSearchOpen: (searchOpen) => set({ searchOpen }),
}))
