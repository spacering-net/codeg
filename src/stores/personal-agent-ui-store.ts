import { create } from "zustand"

import { stamp } from "@/lib/stamp"

import type {
  AgentType,
  DispatchMode,
  DispatchState,
  RoutineDraft,
} from "@/lib/types"

/** The activity's groups (C1), in order: what waits on the owner, what is
 *  under way, what comes next, what was done today. */
export type ActivityGroup = "needs" | "watching" | "next" | "done"

/** Where each of the activity's groups keeps whether it is folded. */
export const ACTIVITY_FOLD: Record<ActivityGroup, string> = {
  needs: "activity.needs",
  watching: "activity.watching",
  next: "activity.next",
  done: "activity.done",
}

/** A question the owner is to answer: the assistant's (`bot`, its id),
 *  the matter, and what it asks. */
export interface PendingAnswer {
  bot: number
  itemId: number
  summary: string
}

/** An answer on its way: the question, and the send that carries it. */
export interface AnswerSending {
  itemId: number
  requestId: number
}

/** A row of the activity to bring into view once it is read: the pill's
 *  first (C6), a routine asked for (C4) — its group unfolded, shown whole,
 *  the row scrolled to and opened; `row` `null`, the group's head. */
export interface ActivityAsk {
  /** Unique for the window's life: one asked again is a new ask. */
  key: number
  /** When it was asked (`stamp`): a routine is looked for in a list read
   *  after it, not one read before it was made. */
  at: number
  /** The assistant whose activity it is in (`null`: the primary): the page
   *  shown when it was asked — another one being switched to, its list
   *  waits for that one's. */
  bot: number | null
  group: ActivityGroup
  /** The row's key in the list (`routine:{id}` for a routine). */
  row: string | null
  /** A routine was asked for: one not in the list was deleted. */
  routine: boolean
}

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

/** The pages of the settings view (13.1): the preferences every assistant
 *  shares. */
export type SettingsPage =
  | "communication"
  | "projects"
  | "proactive"
  | "automation"
  | "about"

/** The tabs of an assistant's own page (13.1): who it is, the agent it
 *  thinks on and the one its work runs on, its persona and memory, its
 *  notifications, the advanced. */
export type BotTab = "identity" | "persona" | "notify" | "advanced"

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
  /** The assistant whose work it is, as it was named when it handed it
   *  out. */
  assistantName: string | null
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
  /** The result cards whose full text the owner opened, by row id: kept
   *  here, not in the card, so a card the list unmounts and mounts again
   *  (scrolled away and back) stays as they left it (A1). */
  openResults: Record<number, boolean>
  setResultOpen: (rowId: number, open: boolean) => void
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
  /** The routine editor, when open. */
  routineEditor: RoutineEditorRequest | null
  openRoutineEditor: (req: Omit<RoutineEditorRequest, "key">) => void
  closeRoutineEditor: () => void
  /** The activity's rows the owner opened (C3), by the thing each is
   *  (`ActivityRow.thing`): kept here, not in the row, so a row that moves
   *  to another group, or is drawn again, stays as they left it. */
  activityOpen: Record<string, boolean>
  setActivityOpen: (thing: string, open: boolean) => void
  /** A row of the activity to bring into view, until the list does. */
  activityAsk: ActivityAsk | null
  /** Done with `key`'s ask: a later one is kept. */
  clearActivityAsk: (key: number) => void
  /** Bring the routines into view (`pa.open`, a routine's card): the
   *  activity's "coming up", at `routineId`'s row when given (C4). */
  showRoutines: (routineId?: number | null) => void
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
  /** The question each assistant's composer is to answer ([Answer] on the
   *  activity, C1), by the assistant's id: taken by that assistant's page,
   *  one assistant's never another's. */
  pendingAnswer: Record<number, PendingAnswer>
  /** Ask `answer.bot`'s composer to answer it (in place of any other). */
  setPendingAnswer: (answer: PendingAnswer) => void
  /** Clear `bot`'s question — only `itemId` when given, so a send that
   *  lands late does not clear one picked meanwhile. */
  clearPendingAnswer: (bot: number, itemId?: number) => void
  /** The answer each assistant's composer is sending, by its id: the bar
   *  goes quietly when the push of its own answer comes before the send's
   *  return (it is not "answered already"). */
  answerSending: Record<number, AnswerSending>
  setAnswerSending: (bot: number, sending: AnswerSending) => void
  /** Clear `bot`'s — only the send `requestId`'s. */
  clearAnswerSending: (bot: number, requestId: number) => void
  /** The assistants whose composer is sending right now (it is locked
   *  meanwhile), by id: a card's "put in the box" waits for it. */
  composerSending: Record<number, true>
  setComposerSending: (bot: number, sending: boolean) => void
  /** What waits on the owner, brought into view (the primary's pill, C6):
   *  the panel open on its activity, at `first` (a row's key) when given. */
  showWaiting: (first: string | null) => void
  /** The "N items need you" pill closed, by the conversation (`"primary"`
   *  or an assistant's id): what needed the owner then. It shows again once
   *  something not among them does (`attentionShown`). */
  attentionDismissed: Record<string, readonly string[]>
  dismissAttention: (conversation: string, keys: readonly string[]) => void
  /** The time machine's search is open (8.2). */
  searchOpen: boolean
  setSearchOpen: (open: boolean) => void
}

let asks = 0

/** The panel open on the activity, `group` unfolded as it is asked for —
 *  not again each time it is drawn, a fold the owner made since kept — and
 *  `row` to be brought into view once the list has it. */
function ask(
  s: PersonalAgentUiState,
  group: ActivityGroup,
  row: string | null,
  routine: boolean
): Partial<PersonalAgentUiState> {
  return {
    auxOpen: true,
    auxTab: "activity",
    settings: null,
    botPage: null,
    auxFolds: { ...s.auxFolds, [ACTIVITY_FOLD[group]]: true },
    activityAsk: {
      key: ++asks,
      at: stamp(),
      bot: s.viewBot,
      group,
      row,
      routine,
    },
  }
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
  openResults: {},
  setResultOpen: (rowId, open) =>
    set((s) => ({ openResults: { ...s.openResults, [rowId]: open } })),
  watching: false,
  setWatching: (watching) => set({ watching }),
  work: null,
  workOpen: false,
  openWork: (work) => set({ work, workOpen: true }),
  setWorkOpen: (workOpen) => set({ workOpen }),
  settings: null,
  openSettings: (page = "communication") =>
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
  routineEditor: null,
  openRoutineEditor: (req) =>
    set((s) => ({
      routineEditor: { ...req, key: (s.routineEditor?.key ?? 0) + 1 },
    })),
  closeRoutineEditor: () => set({ routineEditor: null }),
  attentionDismissed: {},
  dismissAttention: (conversation, keys) =>
    set((s) => ({
      attentionDismissed: { ...s.attentionDismissed, [conversation]: keys },
    })),
  activityOpen: {},
  setActivityOpen: (thing, open) =>
    set((s) => ({ activityOpen: { ...s.activityOpen, [thing]: open } })),
  activityAsk: null,
  clearActivityAsk: (key) =>
    set((s) => (s.activityAsk?.key === key ? { activityAsk: null } : s)),
  showRoutines: (routineId) =>
    set((s) =>
      ask(s, "next", routineId != null ? `routine:${routineId}` : null, true)
    ),
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
  pendingAnswer: {},
  setPendingAnswer: (answer) =>
    set((s) => ({
      pendingAnswer: { ...s.pendingAnswer, [answer.bot]: answer },
    })),
  clearPendingAnswer: (bot, itemId) =>
    set((s) => {
      const now = s.pendingAnswer[bot]
      if (!now || (itemId != null && now.itemId !== itemId)) return s
      const pendingAnswer = { ...s.pendingAnswer }
      delete pendingAnswer[bot]
      return { pendingAnswer }
    }),
  answerSending: {},
  setAnswerSending: (bot, sending) =>
    set((s) => ({ answerSending: { ...s.answerSending, [bot]: sending } })),
  clearAnswerSending: (bot, requestId) =>
    set((s) => {
      if (s.answerSending[bot]?.requestId !== requestId) return s
      const answerSending = { ...s.answerSending }
      delete answerSending[bot]
      return { answerSending }
    }),
  composerSending: {},
  setComposerSending: (bot, sending) =>
    set((s) => {
      if (sending === (s.composerSending[bot] === true)) return s
      const composerSending = { ...s.composerSending }
      if (sending) composerSending[bot] = true
      else delete composerSending[bot]
      return { composerSending }
    }),
  showWaiting: (first) => set((s) => ask(s, "needs", first, false)),
  searchOpen: false,
  setSearchOpen: (searchOpen) => set({ searchOpen }),
}))
