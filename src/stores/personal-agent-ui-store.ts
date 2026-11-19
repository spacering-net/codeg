import { create } from "zustand"

import type {
  AgentType,
  DispatchMode,
  DispatchState,
  RoutineDraft,
} from "@/lib/types"

/** Where the activity's routines' card keeps whether it is folded. */
export const ROUTINES_FOLD = "activity.routines"

/**
 * The personal agent page's view state that other branches of the tree read:
 * whether the side panel is open and on which tab (the window chrome's
 * buttons drive it), whether the page shows the owner the newest messages
 * right now (the sidebar's unread badge stands down while it does), the
 * handed-out work open in the drawer on the right (any card, in the list or
 * the panel, opens it), and what is shown in place of the conversation — the
 * settings every assistant shares, or an assistant's own page. One-shot
 * requests (the session, the "new session" confirmation) go as window events
 * instead — nothing reads them back.
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

/** The pages of the settings view (13.1): what every assistant shares —
 *  the team, then the preferences. */
export type SettingsPage =
  | "workers"
  | "executors"
  | "division"
  | "communication"
  | "proactive"
  | "automation"
  | "about"

/** The tabs of an assistant's own page (13.1): who it is and the agent it
 *  runs on, its persona and memory, a work assistant's execution, its
 *  notifications, the advanced. */
export type BotTab =
  | "identity"
  | "persona"
  | "execution"
  | "notify"
  | "advanced"

/** The settings view, while it is open: on which page. */
export interface SettingsOpen {
  page: SettingsPage
}

/** An assistant's own page, while it is open — the page's assistant's (the
 *  one `viewBot` says): on which tab. */
export interface BotPageOpen {
  tab: BotTab
  /** The persona tab's file to open on: a memory entry a card or a reply
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
  openSettings: (page?: SettingsPage) => void
  /** The assistant's own page, open in place of the conversation. */
  botPage: BotPageOpen | null
  /** Open an assistant's own page on `tab`: the page's assistant's, or —
   *  `bot` given — that one's, switched to (`null`: the primary). */
  openBotPage: (
    tab?: BotTab,
    opts?: { bot?: number | null; entry?: string | null }
  ) => void
  /** Back to the conversation: the settings or the assistant's page over it
   *  closed. */
  showConversation: () => void
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
  /** Bumped to bring the activity's routines into view (`pa.open`),
   *  their card unfolded. */
  routinesAsked: number
  showRoutines: () => void
  /** The assistant the page shows (`null`: the primary), picked in the
   *  roster. Switching closes what was open about the other one — its page
   *  and the settings with it. */
  viewBot: number | null
  setViewBot: (bot: number | null) => void
  /** The assistant whose conversation this window shows the owner right
   *  now (its real id, the primary's too): the page is the active route
   *  and neither the settings nor the assistant's page is over it. The presence beat carries it —
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
  // The panel stands beside the conversation: asked for, it brings it back.
  showAux: (auxTab) =>
    set({ auxOpen: true, auxTab, settings: null, botPage: null }),
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
  openSettings: (page = "workers") =>
    set({ settings: { page }, botPage: null }),
  botPage: null,
  openBotPage: (tab = "identity", opts = {}) =>
    set((s) => {
      const botPage: BotPageOpen = opts.entry
        ? { tab, entry: opts.entry }
        : { tab }
      return opts.bot === undefined || opts.bot === s.viewBot
        ? { botPage, settings: null }
        : {
            viewBot: opts.bot,
            botPage,
            settings: null,
            workOpen: false,
            watching: false,
          }
    }),
  showConversation: () => set({ settings: null, botPage: null }),
  executorEditor: null,
  openExecutorEditor: (assistantId, prefill = null) =>
    set((s) => ({
      settings: { page: "executors" },
      botPage: null,
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
      settings: null,
      botPage: null,
      routinesAsked: s.routinesAsked + 1,
      // The routines' card unfolded, as it is asked for: not again each time
      // it is drawn, a fold the owner made since kept.
      auxFolds: { ...s.auxFolds, [ROUTINES_FOLD]: true },
    })),
  viewBot: null,
  setViewBot: (viewBot) =>
    set((s) =>
      s.viewBot === viewBot
        ? s
        : {
            viewBot,
            settings: null,
            botPage: null,
            workOpen: false,
            watching: false,
          }
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
      settings: null,
      botPage: null,
      todayAsked: s.todayAsked + 1,
    })),
  searchOpen: false,
  setSearchOpen: (searchOpen) => set({ searchOpen }),
}))
