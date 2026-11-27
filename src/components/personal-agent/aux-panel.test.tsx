import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import type {
  BotLive,
  DispatchInfo,
  ItemInfo,
  PersonalAgentSnapshot,
  PersonalAgentStats,
  TimelineRow,
  ActivityRow,
  PersonalAgentActivity,
} from "@/lib/types"
import { usePersonalAgentUi } from "@/stores/personal-agent-ui-store"

const api = vi.hoisted(() => ({
  personalAgentItems: vi.fn(),
  personalAgentDispatches: vi.fn(),
  personalAgentStats: vi.fn(),
  personalAgentResumeAutoCompact: vi.fn(),
  personalAgentItemAct: vi.fn(async () => ({})),
  personalAgentDispatchStop: vi.fn(async () => ({ outcome: "past_stopping" })),
  personalAgentOutputs: vi.fn(),
  personalAgentOutputRead: vi.fn(),
  personalAgentRosterAct: vi.fn(async () => {}),
  personalAgentBots: vi.fn(),
  personalAgentRoutines: vi.fn(async () => []),
  personalAgentRoutineAct: vi.fn(async () => ({})),
  personalAgentSave: vi.fn(async () => ({})),
  readWorkspaceFileBase64: vi.fn(),
}))
const pa = vi.hoisted(() => ({
  snapshot: null as unknown,
  rows: [] as unknown[],
}))
const toasts = vi.hoisted(() => ({ message: vi.fn(), error: vi.fn() }))
vi.mock("@/lib/api", () => api)
vi.mock("@/lib/platform", () => ({
  subscribe: () => Promise.resolve(() => {}),
  onTransportReconnect: () => () => {},
  isDesktop: () => false,
}))
vi.mock("sonner", () => ({ toast: toasts }))
vi.mock("@/components/message/live-transcript-view", () => ({
  LiveTranscriptView: ({
    conversationId,
    connectionId,
  }: {
    conversationId: number
    connectionId: string | null
  }) => (
    <div
      data-live-transcript={conversationId}
      data-connection={connectionId ?? ""}
    />
  ),
}))
const acp = vi.hoisted(() => ({
  attachDelegationChild: vi.fn(),
  detachDelegationChild: vi.fn(),
}))
vi.mock("@/contexts/acp-connections-context", () => ({
  useAcpActions: () => acp,
}))
const board = vi.hoisted(() => ({ tasks: [] as unknown[] }))
vi.mock("@/contexts/tasks-view-context", () => ({
  useTasksView: () => ({ tasks: board.tasks, loading: false }),
}))
vi.mock("@/components/tasks/task-transcript-dialog", () => ({
  TaskTranscriptView: ({ task }: { task: { id: number } }) => (
    <div data-task-preview={task.id} />
  ),
}))
vi.mock("@/contexts/personal-agent-context", () => ({
  useBotId: () => null,
  usePersonalAgent: () => ({
    botId: null,
    itemVersion: 0,
    dispatchVersion: 0,
    dispatchById: new Map(),
    rows: pa.rows,
    snapshot: pa.snapshot,
    needsOwner: false,
  }),
}))
vi.mock("@/contexts/workbench-route-context", () => ({
  useWorkbenchRoute: () => ({ setRoute: vi.fn(), openConversations: vi.fn() }),
}))
vi.mock("@/contexts/tab-context", () => ({
  useTabActions: () => ({ openTab: vi.fn() }),
}))
// The activity's read has its own tests: here, what the panel draws of it.
const feed = vi.hoisted(() => ({
  read: null as null | {
    bot: number | null
    view: PersonalAgentActivity | null
    at: number
  },
  refresh: vi.fn(),
}))
vi.mock("@/components/tasks/use-task-dialogs", () => ({
  useTaskDialogs: () => ({ openDetail: vi.fn(), dialogs: null }),
}))
vi.mock("@/stores/personal-agent-activity-store", () => ({
  useActivity: () => feed.read?.view ?? null,
  useActivityRead: () => feed.read,
  refreshActivity: feed.refresh,
}))
// The charts measure their box, which jsdom has none of: their own tests
// cover them.
vi.mock("@/components/token-usage/charts", () => ({
  TrendChart: ({ label }: { label: string }) => <div data-chart={label} />,
  RankedBars: () => <div data-chart="ranked" />,
}))

import {
  __resetRosterForTests,
  usePersonalAgentRoster,
} from "@/stores/personal-agent-roster-store"
import { __resetThumbsForTests } from "./aux-parts/output/use-thumb"

import { PersonalAgentAuxPanel } from "./aux-panel"
import { PageScopeContext, type PageScope } from "./shared"
import { clearSettling } from "./aux-parts/activity/act-settle"

function dispatch(patch: Partial<DispatchInfo>): DispatchInfo {
  return {
    id: 1,
    mode: "task",
    work: {
      name: "Builder",
      agent_type: "codex",
      agent_options: { mode_id: null, config_values: {} },
      label_snapshot: null,
      instructions: "",
    },
    folder_id: 2,
    folder_name: "my-app",
    deliverable: null,
    title: "Work",
    prompt: "Do it",
    work_task_id: 7,
    conversation_id: null,
    conversation_folder_id: null,
    connection_id: null,
    state: "running",
    result_excerpt: null,
    error: null,
    on_done: null,
    turns: 1,
    created_at: "2026-11-04T09:00:00Z",
    updated_at: "2026-11-04T10:00:00Z",
    finished_at: null,
    ladder: "working",
    task: null,
    answered_for_you: 0,
    ...patch,
  }
}

/** What a button says it will do, as a screen reader reads it. */
function hintOf(el: HTMLElement): string {
  const id = el.getAttribute("aria-describedby")
  return (id && document.getElementById(id)?.textContent) || ""
}

function item(patch: Partial<ItemInfo>): ItemInfo {
  return {
    id: 1,
    kind: "dispatch",
    dispatch_id: null,
    status: "open",
    waits_for: "external",
    summary: "",
    on_done: null,
    origin_timeline_id: null,
    created_at: "2026-11-04T09:00:00Z",
    updated_at: "2026-11-04T10:00:00Z",
    dispatch_state: null,
    due_at: null,
    repeat: null,
    at_due: null,
    act_spec: null,
    fired_at: null,
    ...patch,
  }
}

function snapshot(): PersonalAgentSnapshot {
  return {
    agent: {
      id: 1,
      name: "Nova",
      avatar: { kind: "emoji", emoji: "🧭", color: "violet" },
      agent_type: "claude_code",
      agent_options: {},
      label_snapshot: {
        agent: "Claude Code",
        mode: "Default",
        options: [{ id: "model", name: "Model", value_label: "Opus" }],
      },
      settings: {
        auto_compact_percent: 70,
        compact_command: null,
        compact_command_agent: null,
        handoff_budget_chars: 32000,
        dispatch_concurrency: 3,
        skill_enabled: true,
      },
      workdir: "/data/personal-agent",
      workdir_custom: false,
      folder_id: null,
      revision: 1,
      created_at: "2026-11-01T00:00:00Z",
      kind: "primary",
      uid: null,
      updated_at: "2026-11-01T00:00:00Z",
    },
    status: {
      engine: "here",
      configured: true,
      segment: {
        id: 4,
        seq: 3,
        agent_type: "claude_code",
        label_snapshot: { agent: "Claude Code", mode: null, options: [] },
        conversation_id: 9,
        agent_session_id: null,
        start_reason: "switch",
        end_reason: null,
        pending_reason: null,
        started_at: "2026-11-04T08:00:00Z",
        ended_at: null,
        handoff_size: 5120,
        handoff_trimmed: false,
        compactions_auto: 1,
        compactions_manual: 0,
        compactions_agent: 0,
        auto_compact_paused: false,
      },
      connection_id: "c1",
      connected: true,
      turn: null,
      usage: { percent: 45, used: null, size: null, source: "live" },
      auto_compact_percent: 70,
      compact_command: "/compact",
      last_check: null,
      last_compaction: null,
      queued_messages: 0,
      pending_events: 0,
      unseen: 0,
      dispatch_running: 1,
      dispatch_queued: 0,
      dispatch_limit: 3,
      pending_permission: false,
      pending_question: false,
      last_error: null,
      workdir: "/data/personal-agent",
      live_reply: null,
    },
  } as unknown as PersonalAgentSnapshot
}

/** A run-log line: a marker row of the timeline. */
function marker(id: number, data: Record<string, unknown>): TimelineRow {
  const at = `2026-11-04T0${id}:00:00Z`
  return {
    id,
    segment_id: 4,
    batch_id: null,
    kind: "marker",
    status: null,
    body: "",
    data,
    dispatch_id: null,
    ref_id: null,
    reply_to: null,
    read_at: null,
    event_id: null,
    seen_at: null,
    created_at: at,
    updated_at: at,
  }
}

const jumpTo = vi.fn()

function draw({
  inDrawer = false,
  snap = snapshot(),
}: { inDrawer?: boolean; snap?: PersonalAgentSnapshot } = {}) {
  const scope: PageScope = {
    readOnly: false,
    agentName: "Nova",
    liveRowId: null,
    connectionId: null,
    agentType: null,
    onQuote: vi.fn(),
    jumpTo,
    rowsById: new Map(),
  }
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <PageScopeContext.Provider value={scope}>
        <PersonalAgentAuxPanel snapshot={snap} inDrawer={inDrawer} />
      </PageScopeContext.Provider>
    </NextIntlClientProvider>
  )
}

const FIRST_UI_STATE = usePersonalAgentUi.getState()

beforeEach(() => {
  clearSettling()
  pa.snapshot = snapshot()
  pa.rows = []
  __resetRosterForTests()
  __resetThumbsForTests()
  usePersonalAgentUi.setState({
    auxOpen: true,
    auxTab: "activity",
    auxFolds: {},
    work: null,
    workOpen: false,
  })
  api.personalAgentBots.mockResolvedValue([
    {
      id: 1,
      kind: "primary",
      uid: "u1",
      name: "Nova",
      avatar: { kind: "emoji", emoji: "🧭", color: "violet" },
      persona: "",
      persona_unwritten: false,
      hidden: false,
      has_brain: true,
      legacy_assistant_id: null,
      created_at: "2026-11-01T00:00:00Z",
      roster: {
        sort_order: 0,
        pinned_at: null,
        section: null,
        hidden: false,
        muted: false,
        unread_mark: false,
        notify: true,
      },
      live: null,
    },
  ])
  api.personalAgentOutputs.mockResolvedValue([])
  feed.read = null
  api.personalAgentItems.mockResolvedValue([])
  api.personalAgentDispatches.mockResolvedValue([])
  api.personalAgentStats.mockResolvedValue({
    days: [],
    agents: [],
    usage: [],
    tokens_synced_at: null,
  })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

/** Open a tab as a press of the pointer does (Radix opens one on the
 *  mouse going down). */
function openTab(name: RegExp | string) {
  fireEvent.mouseDown(screen.getByRole("tab", { name }), { button: 0 })
}

describe("the panel", () => {
  it("opens on its activity", () => {
    expect(FIRST_UI_STATE.auxTab).toBe("activity")
    expect(FIRST_UI_STATE.auxOpen).toBe(true)
  })

  it("has who it is on top, its face alive, and four tabs in a row under its name", async () => {
    draw()
    const head = document.querySelector<HTMLElement>("[data-pa-aux-head]")!
    // Its face, large, and its name — no tab's name over the panel.
    const face = head.querySelector<HTMLElement>("[data-slot='bot-avatar']")!
    expect(face.getAttribute("aria-label")).toBe("Nova")
    expect(face.style.width).toBe("4rem")
    expect(face.hasAttribute("data-bot-look")).toBe(true)
    // The whole head is where it follows the pointer.
    expect(head.hasAttribute("data-pa-face-host")).toBe(true)
    expect(
      within(head).getByRole("heading", { name: "Nova", level: 2 })
    ).toBeTruthy()
    expect(screen.queryByRole("heading", { name: "Activity" })).toBeNull()
    // The tabs under it, a row of words: no icon rail down its edge.
    const list = within(head).getByRole("tablist", { name: "Assistant panel" })
    expect(list.getAttribute("aria-orientation")).toBe("horizontal")
    const tabs = within(list).getAllByRole("tab")
    expect(tabs.map((tab) => tab.textContent)).toEqual([
      "Activity",
      "Output",
      "Workspace",
      "Stats",
    ])
    for (const tab of tabs) expect(tab.querySelector("svg")).toBeNull()
    expect(document.querySelector("[data-pa-aux-rail]")).toBeNull()
    // Another tab: its body under the same head.
    openTab("Stats")
    expect(usePersonalAgentUi.getState().auxTab).toBe("stats")
    await waitFor(() =>
      expect(
        document.querySelector("[data-pa-runtime-agent]")?.textContent
      ).toContain("Opus")
    )
    expect(head.isConnected).toBe(true)
    // A click on the tab already open leaves the panel be: the chrome's
    // button hides it.
    const stats = screen.getByRole("tab", { name: "Stats" })
    fireEvent.mouseDown(stats, { button: 0 })
    fireEvent.click(stats, { detail: 1 })
    expect(usePersonalAgentUi.getState()).toMatchObject({
      auxTab: "stats",
      auxOpen: true,
    })
  })

  it("keeps its face at rest while the assistant replies and once it has — only waiting, stuck or asleep shows", async () => {
    draw()
    // Live pushes land on the roster once it has been read.
    await waitFor(() =>
      expect(usePersonalAgentRoster.getState().entries).not.toBeNull()
    )
    const look = () =>
      document
        .querySelector("[data-pa-aux-head] [data-slot='bot-avatar']")
        ?.getAttribute("data-bot-look")
    expect(look()).toBe("idle")
    const now = Date.now()
    let n = 0
    const push = (patch: Partial<BotLive>) =>
      act(() =>
        usePersonalAgentRoster.getState().applyLive({
          bot_id: 1,
          work: "done",
          attention: "none",
          needs: null,
          unread: 0,
          activity: null,
          activity_known: true,
          work_on_hand: [],
          awaiting: [],
          face: "idle",
          flash: null,
          connected: true,
          last_line: null,
          last_activity_at: new Date(now).toISOString(),
          updated_at: new Date(now + ++n).toISOString(),
          expires_at: new Date(now + 30_000).toISOString(),
          ...patch,
        })
      )
    // Thinking, writing, then done or failed: no motion of a reply here.
    push({ work: "busy", face: "thinking" })
    expect(look()).toBe("idle")
    push({ work: "busy", face: "working" })
    expect(look()).toBe("idle")
    const until = new Date(now + 8000).toISOString()
    push({ flash: { face: "done", until } })
    expect(look()).toBe("idle")
    push({ flash: { face: "failed", until } })
    expect(look()).toBe("idle")
    // Waiting on its owner is not a reply's: it shows.
    push({ face: "waiting" })
    expect(look()).toBe("waiting")
  })

  it("renames the assistant in place: Enter or leaving the field saves it, Escape takes it back and goes no further", async () => {
    api.personalAgentSave.mockClear()
    draw()
    // No line of how it is under the name: that is on the title.
    expect(document.querySelector("[data-pa-aux-head-line]")).toBeNull()
    const name = () =>
      document.querySelector("[data-pa-aux-head-name]") as HTMLButtonElement
    const field = () =>
      document.querySelector(
        "[data-pa-aux-head-name-input]"
      ) as HTMLInputElement
    expect(name().textContent).toBe("Nova")
    // Pressed: a field with the name, taken whole.
    fireEvent.click(name())
    expect(field().value).toBe("Nova")
    expect(document.activeElement).toBe(field())
    // Enter while a word is composed picks the word, nothing more — and
    // WebKit's, after the composition ended, says so by its key code alone;
    // nor is Escape then the field's.
    fireEvent.change(field(), { target: { value: "Nova 2" } })
    fireEvent.keyDown(field(), { key: "Enter", isComposing: true })
    fireEvent.compositionStart(field())
    fireEvent.keyDown(field(), { key: "Escape" })
    fireEvent.compositionEnd(field())
    fireEvent.keyDown(field(), { key: "Enter", keyCode: 229 })
    expect(api.personalAgentSave).not.toHaveBeenCalled()
    expect(field()).not.toBeNull()
    fireEvent.keyDown(field(), { key: "Enter" })
    expect(api.personalAgentSave).toHaveBeenCalledTimes(1)
    expect(api.personalAgentSave).toHaveBeenCalledWith(
      { name: "Nova 2", locale: "en" },
      null
    )
    // Shown at once, before it is read back.
    expect(field()).toBeNull()
    expect(name().textContent).toBe("Nova 2")
    // Escape takes it back — and does not reach the drawer round it.
    const outside = vi.fn()
    document.addEventListener("keydown", outside)
    fireEvent.click(name())
    fireEvent.change(field(), { target: { value: "Other" } })
    fireEvent.keyDown(field(), { key: "Escape" })
    document.removeEventListener("keydown", outside)
    expect(outside).not.toHaveBeenCalled()
    expect(field()).toBeNull()
    expect(name().textContent).toBe("Nova 2")
    expect(api.personalAgentSave).toHaveBeenCalledTimes(1)
    // Leaving the field saves it; unchanged, nothing is saved.
    fireEvent.click(name())
    fireEvent.change(field(), { target: { value: "  Atlas " } })
    fireEvent.blur(field())
    expect(api.personalAgentSave).toHaveBeenLastCalledWith(
      { name: "Atlas", locale: "en" },
      null
    )
    fireEvent.click(name())
    fireEvent.blur(field())
    expect(api.personalAgentSave).toHaveBeenCalledTimes(2)
  })

  it("shows a renamed name until it is read back, then what is read back — a later rename elsewhere too", async () => {
    api.personalAgentSave.mockClear()
    const { rerender } = draw()
    const name = () =>
      document.querySelector("[data-pa-aux-head-name]") as HTMLButtonElement
    const field = () =>
      document.querySelector(
        "[data-pa-aux-head-name-input]"
      ) as HTMLInputElement
    const redraw = (n: string) => {
      const snap = snapshot()
      snap.agent!.name = n
      pa.snapshot = snap
      rerender(
        <NextIntlClientProvider locale="en" messages={enMessages}>
          <PageScopeContext.Provider
            value={{
              readOnly: false,
              agentName: n,
              liveRowId: null,
              connectionId: null,
              agentType: null,
              onQuote: vi.fn(),
              jumpTo,
              rowsById: new Map(),
            }}
          >
            <PersonalAgentAuxPanel snapshot={snap} inDrawer={false} />
          </PageScopeContext.Provider>
        </NextIntlClientProvider>
      )
    }
    fireEvent.click(name())
    fireEvent.change(field(), { target: { value: "Atlas" } })
    fireEvent.keyDown(field(), { key: "Enter" })
    expect(name().textContent).toBe("Atlas")
    // Read back; then renamed back elsewhere: the panel follows.
    redraw("Atlas")
    expect(name().textContent).toBe("Atlas")
    redraw("Nova")
    expect(name().textContent).toBe("Nova")
  })

  it("keeps a work assistant's name from being left empty, and is not renamed where it runs elsewhere", async () => {
    api.personalAgentSave.mockClear()
    const worker = snapshot()
    Object.assign(worker.agent!, { kind: "worker" })
    pa.snapshot = worker
    const { unmount } = draw({ snap: worker })
    fireEvent.click(
      document.querySelector("[data-pa-aux-head-name]") as HTMLElement
    )
    const field = document.querySelector(
      "[data-pa-aux-head-name-input]"
    ) as HTMLInputElement
    fireEvent.change(field, { target: { value: "   " } })
    fireEvent.keyDown(field, { key: "Enter" })
    expect(api.personalAgentSave).not.toHaveBeenCalled()
    expect(document.querySelector("[data-pa-aux-head-name]")?.textContent).toBe(
      "Nova"
    )
    unmount()
    // Elsewhere: its name, nothing to press.
    const elsewhere = snapshot()
    elsewhere.status.engine = "elsewhere" as never
    pa.snapshot = elsewhere
    draw({ snap: elsewhere })
    expect(document.querySelector("[data-pa-aux-head-name]")).toBeNull()
    expect(document.querySelector("[data-pa-aux-head] h2")?.textContent).toBe(
      "Nova"
    )
  })

  it('changes its face in place: "Edit avatar" over it, the face editor\'s bubble under it, a face picked saved at once — not where it runs elsewhere', async () => {
    api.personalAgentSave.mockClear()
    api.personalAgentSave.mockResolvedValue(undefined as never)
    const { unmount } = draw()
    const head = document.querySelector<HTMLElement>("[data-pa-aux-head]")!
    const picker = head.querySelector<HTMLElement>("[data-pa-face-picker]")!
    expect(picker.getAttribute("aria-label")).toBe("Edit avatar")
    // Its face is still the one alive, its star on the primary's.
    expect(picker.querySelector("[data-slot='bot-avatar']")).not.toBeNull()
    fireEvent.focus(picker)
    await waitFor(() =>
      expect(
        document.querySelector("[data-pa-face-hint]")?.textContent
      ).toContain("Edit avatar")
    )
    fireEvent.click(picker)
    const bubble = await waitFor(() => {
      const el = document.querySelector<HTMLElement>("[data-pa-face-bubble]")
      expect(el).not.toBeNull()
      return el!
    })
    expect(
      within(bubble)
        .getAllByRole("tab")
        .map((tab) => tab.textContent)
    ).toEqual(["Models", "Text", "Upload"])
    // Open on the page its face is from: an emoji's, "Text".
    expect(
      within(bubble)
        .getByRole("tab", { name: "Text" })
        .getAttribute("aria-selected")
    ).toBe("true")
    fireEvent.mouseDown(within(bubble).getByRole("tab", { name: "Models" }), {
      button: 0,
    })
    fireEvent.click(await within(bubble).findByRole("button", { name: "Bug" }))
    await waitFor(() =>
      expect(api.personalAgentSave).toHaveBeenCalledWith(
        expect.objectContaining({
          avatar: expect.objectContaining({ kind: "face", shape: "bug" }),
        }),
        null
      )
    )
    // [Reset]: the primary's own, a black blob.
    fireEvent.click(within(bubble).getByRole("button", { name: "Reset" }))
    await waitFor(() =>
      expect(api.personalAgentSave).toHaveBeenLastCalledWith(
        expect.objectContaining({
          avatar: { kind: "face", shape: "ring", color: "black" },
        }),
        null
      )
    )
    unmount()
    const elsewhere = snapshot()
    elsewhere.status.engine = "elsewhere" as never
    pa.snapshot = elsewhere
    draw({ snap: elsewhere })
    expect(document.querySelector("[data-pa-face-picker]")).toBeNull()
    expect(
      document.querySelector("[data-pa-aux-head] [data-slot='bot-avatar']")
    ).not.toBeNull()
  })

  it("is the same in the drawer, its count of what waits on the owner on its activity", async () => {
    show({
      needs: [
        matter(
          item({
            id: 11,
            kind: "question",
            waits_for: "owner",
            summary: "Which branch?",
          })
        ),
      ],
    })
    draw({ inDrawer: true })
    const list = screen.getByRole("tablist")
    expect(list.getAttribute("aria-orientation")).toBe("horizontal")
    await waitFor(() =>
      expect(
        within(list)
          .getAllByRole("tab")
          .map((tab) => tab.textContent)
      ).toEqual(["Activity1", "Output", "Workspace", "Stats"])
    )
    expect(screen.getByRole("heading", { name: "Nova", level: 2 })).toBeTruthy()
  })
})

/** The page's activity, as read (C1): its groups, what waits, the rows
 *  their work points at. */
function show(patch: Partial<PersonalAgentActivity> = {}) {
  const view: PersonalAgentActivity = {
    needs: [],
    watching: [],
    next: [],
    done: [],
    waiting: 0,
    pill: { count: 0, first: null },
    brief: null,
    stale_acceptance: [],
    dispatches: [],
    day_start: "2026-11-04T00:00:00Z",
    day_end: "2026-11-05T00:00:00Z",
    as_of: "2026-11-04T10:00:00Z",
    ...patch,
  }
  if (patch.waiting === undefined) view.waiting = view.needs.length
  feed.read = { bot: null, view, at: 1 }
}

/** A matter with no row of "today": its own row, its assistant's. */
function matter(i: ItemInfo, bot = 1): ActivityRow {
  return {
    key: `item:${i.id}`,
    bot_id: bot,
    thing: `item:${i.id}`,
    today: null,
    item: i,
    routine: null,
    card_row_id: null,
  }
}

describe("the activity", () => {
  it("lists its four groups from one read, what waits on the owner first; its status is the stats'", async () => {
    show({
      needs: [
        matter(
          item({
            id: 11,
            kind: "question",
            waits_for: "owner",
            summary: "Which branch?",
          })
        ),
      ],
      next: [
        matter(
          item({
            id: 15,
            kind: "reminder",
            waits_for: "time",
            summary: "Look at the merge request",
          })
        ),
      ],
    })
    const { container } = draw()
    await screen.findByText("Which branch?")
    expect(
      [...container.querySelectorAll("[data-pa-activity-group]")].map((g) =>
        g.getAttribute("data-pa-activity-group")
      )
    ).toEqual(["needs", "next"])
    expect(
      within(
        container.querySelector(
          '[data-pa-activity-group="needs"]'
        ) as HTMLElement
      ).getByText("Waiting for you")
    ).toBeTruthy()
    // No "Status" heading, no card of it here.
    expect(screen.queryByText("Status")).toBeNull()
    expect(container.querySelector("[data-pa-status]")).toBeNull()
  })

  it("says nothing waits and nothing runs in one row, with the way to make a routine", async () => {
    show()
    draw()
    expect(
      await screen.findByText("Nothing for you to do, and nothing running.")
    ).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "New routine" }))
    expect(usePersonalAgentUi.getState().routineEditor?.routineId).toBeNull()
  })

  it("says why a piece of work failed in a red box, and unfolds who runs it and what done looks like", async () => {
    show({
      needs: [matter(item({ id: 12, dispatch_id: 1, waits_for: "owner" }))],
      dispatches: [
        dispatch({
          id: 1,
          title: "Fix the login",
          state: "failed",
          ladder: "failed",
          error: "worktree add failed: Branch already exists\nat git worktree",
          done_when: "The login works on Safari",
        }),
      ],
    })
    draw()
    // Its first line in the box, in the code face.
    const error = await screen.findByText(
      "worktree add failed: Branch already exists"
    )
    const box = error.closest("[data-pa-callout]")!
    expect(box.getAttribute("data-pa-callout")).toBe("error")
    expect(box.className).toContain("font-mono")
    const row = error.closest<HTMLElement>("[data-pa-activity-row]")!
    // What it runs on, what done looks like, the whole error: unfolded.
    expect(within(row).queryByText("The login works on Safari")).toBeNull()
    fireEvent.click(within(row).getByRole("button", { name: "Show details" }))
    const details = row.querySelector<HTMLElement>("[data-pa-row-details]")!
    expect(details.textContent).toContain("Ran on Codex")
    expect(details.textContent).toContain("my-app")
    expect(within(details).getByText("The login works on Safari")).toBeTruthy()
    expect(details.querySelector("[data-pa-row-error]")!.textContent).toContain(
      "at git worktree"
    )
    // Kept open as the owner left it, by the thing it is.
    expect(usePersonalAgentUi.getState().activityOpen["item:12"]).toBe(true)
  })

  it("settles a matter on its row by whose move it is: answer, put off, not needed (C1)", async () => {
    show({
      needs: [
        matter(
          item({
            id: 11,
            kind: "question",
            waits_for: "owner",
            summary: "Which branch?",
            origin_timeline_id: 40,
          }),
          2
        ),
      ],
      next: [
        matter(
          item({
            id: 15,
            kind: "reminder",
            waits_for: "time",
            summary: "Look at the merge request at 10",
          })
        ),
      ],
    })
    const { container } = draw()
    await screen.findByText("Which branch?")
    const question = container.querySelector<HTMLElement>(
      '[data-pa-activity-row="item:11"]'
    )!
    // The owner's move: [Answer] first; [Put off] a menu of set times only
    // — sent to the assistant whose matter it is, another one's on the
    // primary's page.
    await userEvent.click(
      within(question).getByRole("button", { name: "Put off" })
    )
    expect(screen.queryByRole("menuitem", { name: "No set time" })).toBeNull()
    await userEvent.click(
      await screen.findByRole("menuitem", { name: "In 1 hour" })
    )
    expect(api.personalAgentItemAct).toHaveBeenCalledWith(
      2,
      11,
      "snooze",
      "1h",
      "panel",
      "2026-11-04T10:00:00Z"
    )
    await waitFor(() => expect(feed.refresh).toHaveBeenCalled())
    const notNeeded = within(question).getByRole("button", {
      name: "Not needed",
    })
    await waitFor(() => expect(notNeeded.hasAttribute("disabled")).toBe(false))
    expect(hintOf(notNeeded)).toMatch(/^No answer needed; .+ is told$/)
    fireEvent.click(notNeeded)
    expect(api.personalAgentItemAct).toHaveBeenLastCalledWith(
      2,
      11,
      "drop",
      undefined,
      "panel",
      "2026-11-04T10:00:00Z"
    )
    // [Answer]: its assistant's conversation at the reply that asked, the
    // box set to answer it.
    const answer = within(question).getByRole("button", { name: "Answer" })
    await waitFor(() => expect(answer.hasAttribute("disabled")).toBe(false))
    fireEvent.click(answer)
    const ui = usePersonalAgentUi.getState()
    expect(ui.pendingAnswer[2]).toEqual({
      bot: 2,
      itemId: 11,
      summary: "Which branch?",
    })
    expect(ui.pendingJump).toEqual({ bot: 2, row: 40 })
    // Set aside with no time: a time can be set — no "done", no "put off".
    const reminder = container.querySelector<HTMLElement>(
      '[data-pa-activity-row="item:15"]'
    )!
    expect(
      within(reminder).queryByRole("button", { name: "Put off" })
    ).toBeNull()
    expect(within(reminder).queryByRole("button", { name: "Done" })).toBeNull()
    expect(
      within(reminder).getByRole("button", { name: "Set a time" })
    ).toBeTruthy()
    expect(reminder.textContent).toContain("Set aside · no time set")
    fireEvent.click(
      within(reminder).getByRole("button", { name: "Not needed" })
    )
    expect(api.personalAgentItemAct).toHaveBeenLastCalledWith(
      1,
      15,
      "drop",
      undefined,
      "panel",
      "2026-11-04T10:00:00Z"
    )
  })

  it("has only “not needed” for what waits on someone else, and says on whom", async () => {
    show({
      watching: [
        matter(
          item({
            id: 41,
            kind: "message",
            status: "waiting",
            waits_for: "agent",
            summary: "Waiting for Dev's answer: review the login fix",
            written: "review the login fix",
            direction: "out",
            peer: { id: 2, name: "Dev", avatar: null, gone: false },
            created_at: new Date(Date.now() - 3 * 60_000).toISOString(),
          })
        ),
      ],
    })
    const { container } = draw()
    const row = await waitFor(
      () =>
        container.querySelector<HTMLElement>(
          '[data-pa-activity-row="item:41"]'
        )!
    )
    // Its title is what was written; who it waits on, on its line.
    expect(within(row).getByText("review the login fix")).toBeTruthy()
    expect(row.textContent).toMatch(/waits for Dev's reply · 3 min/)
    // (What a button says it will do is read out, not shown.)
    const shown = row.cloneNode(true) as HTMLElement
    shown.querySelectorAll(".sr-only").forEach((e) => e.remove())
    expect(shown.textContent).not.toMatch(/message/i)
    const buttons = within(row)
      .getAllByRole("button")
      .filter((b) => b.hasAttribute("data-pa-item-act"))
    expect(buttons.map((b) => b.textContent)).toEqual(["Not needed"])
    expect(hintOf(buttons[0]!)).toMatch(
      /^Takes the message back; if that is too late, .+ stops waiting for Dev's reply$/
    )
  })

  it("says what brings a reminder on a mention up, and puts it off no time (6.8)", async () => {
    show({
      next: [
        matter(
          item({
            id: 31,
            kind: "when_mentioned",
            waits_for: null,
            summary: "Update the Homebrew formula first",
            mention: {
              keywords: ["release", "发版"],
              cooldown_hours: 24,
              max_times: 3,
              expires_at: "2027-02-11T00:00:00Z",
              times: 1,
              last_at: "2026-11-13T00:00:00Z",
            },
          })
        ),
      ],
    })
    const { container } = draw()
    await screen.findByText("Update the Homebrew formula first")
    expect(
      screen.getByText(
        /^When you mention “release”, “发版”, .+ reminds you · 1 of 3 times · until /
      )
    ).toBeTruthy()
    const row = container.querySelector<HTMLElement>(
      '[data-pa-activity-row="item:31"]'
    )!
    expect(within(row).queryByRole("button", { name: "Put off" })).toBeNull()
    fireEvent.click(within(row).getByRole("button", { name: "Stop reminding" }))
    expect(api.personalAgentItemAct).toHaveBeenLastCalledWith(
      1,
      31,
      "drop",
      undefined,
      "panel",
      "2026-11-04T10:00:00Z"
    )
  })

  it("says when a matter is due and how it comes back; what is done once a reminder is, unfolded", async () => {
    const hour = 3_600_000
    show({
      next: [
        matter(
          item({
            id: 21,
            kind: "reminder",
            waits_for: "time",
            summary: "Stand-up notes",
            due_at: new Date(Date.now() + hour).toISOString(),
            repeat: { every: "weekdays", at: "09:00" },
            at_due: "notify",
            on_done: "Post them in #team",
          })
        ),
      ],
      needs: [
        matter(
          item({
            id: 23,
            kind: "reminder",
            waits_for: "owner",
            summary: "Call the bank",
            due_at: new Date(Date.now() - hour).toISOString(),
            fired_at: new Date(Date.now() - hour + 5_000).toISOString(),
            at_due: "notify",
          })
        ),
      ],
    })
    draw()
    await screen.findByText("Stand-up notes")
    expect(
      screen.getByText(/ reminds you: Every weekday 09:00 · next .+$/)
    ).toBeTruthy()
    expect(screen.getByText(/ reminds you · due .+, 1 h ago$/)).toBeTruthy()
    const row = screen
      .getByText("Stand-up notes")
      .closest<HTMLElement>("[data-pa-activity-row]")!
    fireEvent.click(within(row).getByRole("button", { name: "Show details" }))
    expect(row.querySelector("[data-pa-item-on-done]")!.textContent).toContain(
      "Post them in #team"
    )
    // Coming up and repeating: skip this time, or stop it.
    fireEvent.click(within(row).getByRole("button", { name: "Skip this time" }))
    expect(api.personalAgentItemAct).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.any(Number),
      "skip",
      undefined,
      "panel",
      expect.any(String)
    )
    expect(
      within(row).getByRole("button", { name: "Stop reminding" })
    ).toBeTruthy()
    // Come due: done, or put off.
    const due = screen
      .getByText("Call the bank")
      .closest<HTMLElement>("[data-pa-activity-row]")!
    await userEvent.click(within(due).getByRole("button", { name: "Put off" }))
    await userEvent.click(
      await screen.findByRole("menuitem", { name: "Tomorrow morning" })
    )
    expect(api.personalAgentItemAct).toHaveBeenCalledWith(
      1,
      23,
      "snooze",
      "tomorrow",
      "panel",
      "2026-11-04T10:00:00Z"
    )
  })

  it("carries a task's strip, and lets the owner close a pull request codeg does not follow", async () => {
    const facts = {
      task_id: 7,
      status: "review" as const,
      run_seq: 1,
      updated_at: "2026-11-04T10:00:00Z",
      folder_id: 2,
      branch: "pa/fix-login",
      base_branch: "main",
      files_changed: 6,
      additions: 214,
      deletions: 37,
      pr_url: null,
      pr_number: null,
      completion_kind: null,
      conversation_id: 30,
      connection_id: null,
      started_at: "2026-11-04T09:00:00Z",
      finished_at: null,
      pr: null,
    }
    show({
      needs: [
        matter(
          item({
            id: 11,
            dispatch_id: 1,
            waits_for: "owner",
            status: "waiting",
            dispatch_state: "review",
            on_done: "Tell the team",
          }),
          2
        ),
      ],
      watching: [
        matter(
          item({
            id: 12,
            dispatch_id: 2,
            waits_for: "external",
            status: "waiting",
            dispatch_state: "completed",
          })
        ),
      ],
      dispatches: [
        dispatch({
          id: 1,
          title: "Fix the login",
          state: "review",
          ladder: "mergeable",
          task: facts,
        }),
        dispatch({
          id: 2,
          title: "Ship the notes",
          state: "completed",
          ladder: "pr_open",
          task: {
            ...facts,
            task_id: 8,
            status: "done",
            completion_kind: "delivered_pr",
            pr_url: "https://github.com/o/r/pull/9",
            pr_number: 9,
          },
          work_task_id: 8,
        }),
      ],
    })
    draw()
    await screen.findByText("Fix the login")
    const row = (title: string) =>
      screen.getByText(title).closest<HTMLElement>("[data-pa-activity-row]")!
    // In review: where it stands its line's chip; its task's strip on the
    // row, the way to stop it at the strip's end — at the work's own
    // assistant; no way to close its matter by hand while it moves.
    const review = row("Fix the login")
    expect(review.querySelector("[data-pa-ladder]")?.textContent).toBe(
      "Ready to merge"
    )
    const strip = review.querySelector("[data-pa-task-strip]")!
    expect(strip.querySelector("[data-pa-task-diff]")?.textContent).toBe(
      "+214 −37, 6 files"
    )
    expect(within(review).queryByRole("button", { name: "Done" })).toBeNull()
    fireEvent.click(within(review).getByRole("button", { name: "Stop" }))
    // With what the row read: the work's version and its task's run.
    expect(api.personalAgentDispatchStop).toHaveBeenCalledWith(
      2,
      1,
      expect.objectContaining({ runSeq: 1 })
    )
    // What happens once handed-out work is done is its assistant's to know,
    // not said here (B5).
    fireEvent.click(
      within(review).getByRole("button", { name: "Show details" })
    )
    expect(review.querySelector("[data-pa-item-on-done]")).toBeNull()
    expect(review.textContent).not.toContain("Tell the team")
    // Delivered as a pull request: not stoppable, its matter the owner's to
    // close.
    const pr = row("Ship the notes")
    expect(pr.querySelector("[data-pa-task-pr]")?.textContent).toBe(
      "PR opened · codeg is not watching it"
    )
    expect(within(pr).queryByRole("button", { name: "Stop" })).toBeNull()
    fireEvent.click(within(pr).getByRole("button", { name: "Merged" }))
    expect(api.personalAgentItemAct).toHaveBeenLastCalledWith(
      1,
      12,
      "done",
      undefined,
      "panel",
      "2026-11-04T10:00:00Z"
    )
  })

  it("has the bell to be told at the panel's top, nothing of it at the activity's end", async () => {
    show()
    draw()
    const bell = await screen.findByRole("button", { name: "Notify me" })
    await waitFor(() => expect(bell.hasAttribute("disabled")).toBe(false))
    expect(bell.closest("[data-pa-aux-head]")).toBeTruthy()
    // In the top's corners, the bell's and the "⋯"'s boxes each as far from
    // the top as from its side.
    const more = screen.getByRole("button", { name: "More" })
    expect(bell.className).toMatch(/(^| )start-2 top-2( |$)/)
    expect(more.className).toMatch(/(^| )end-2 top-2( |$)/)
    expect(bell.getAttribute("aria-pressed")).toBe("true")
    expect(bell.getAttribute("title")).toContain("Notify me · on")
    fireEvent.click(bell)
    expect(api.personalAgentRosterAct).toHaveBeenCalledWith(1, {
      act: "notify",
      on: false,
    })
    expect(screen.queryByRole("switch")).toBeNull()
    expect(screen.queryByRole("button", { name: "Settings" })).toBeNull()
  })
})

describe("an activity card of a task", () => {
  it("says where it stands once, its › in its head, [Stop] with its buttons, its details at its foot", async () => {
    const task = {
      run_seq: 1,
      updated_at: "2026-11-04T10:00:00Z",
      task_id: 14,
      status: "review" as const,
      folder_id: 2,
      branch: "task/14",
      base_branch: "main",
      files_changed: 1,
      additions: 1,
      deletions: 1,
      pr_url: null,
      pr_number: null,
      completion_kind: null,
      conversation_id: 30,
      connection_id: null,
      started_at: "2026-11-04T09:00:00Z",
      finished_at: null,
      pr: null,
    }
    show({
      needs: [
        {
          key: "t:1",
          bot_id: 1,
          thing: "t:1",
          today: {
            key: "t:1",
            kind: "task",
            bot_id: 1,
            project: { id: 2, name: "my-app" },
            title: "Retitle the test page",
            text: null,
            at: "2026-11-04T09:59:00Z",
            state: "review",
            row_id: null,
            dispatch_id: 1,
            task_id: 14,
            conversation_id: 30,
            item_id: null,
            notice_id: null,
            agent_type: "codex",
            undo: false,
            reason: "merge_ready",
          },
          item: null,
          routine: null,
          card_row_id: null,
        },
      ],
      dispatches: [
        dispatch({
          id: 1,
          title: "Retitle the test page",
          state: "review",
          ladder: "mergeable",
          task,
          done_when: "The tab says Test",
        }),
      ],
    })
    draw()
    await screen.findByText("Retitle the test page")
    const card = screen
      .getByText("Retitle the test page")
      .closest<HTMLElement>("[data-pa-activity-row]")!
    // The rung on its chip, the line under the title not saying a state of
    // its own beside it.
    expect(card.querySelector("[data-pa-ladder]")?.textContent).toBe(
      "Ready to merge"
    )
    const line =
      card.querySelector("[data-pa-ladder]")!.parentElement!.parentElement!
        .textContent
    expect(line).not.toContain("Ready for review")
    expect(line).toContain("Nova")
    // [Stop] next to the way to merge it, not on the strip's line.
    const merge = within(card).getByRole("button", { name: /merge/i })
    const stop = within(card).getByRole("button", { name: "Stop" })
    expect(stop.parentElement).toBe(merge.parentElement)
    expect(
      card.querySelector("[data-pa-task-strip] [data-pa-task-act=stop]")
    ).toBeNull()
    // Its › before its buttons; unfolded, its details after them.
    const unfold = within(card).getByRole("button", { name: "Show details" })
    expect(
      unfold.compareDocumentPosition(merge) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
    fireEvent.click(unfold)
    const details = card.querySelector("[data-pa-row-details]")!
    expect(
      merge.compareDocumentPosition(details) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
  })
})

describe("the output tab", () => {
  it("lists what it made, newest first, by kind, and opens a document", async () => {
    usePersonalAgentUi.setState({ auxTab: "output" })
    // Times in the local calendar, whatever the zone the test runs in:
    // today, yesterday, a day of another year.
    const now = new Date()
    const at = (daysAgo: number, hour: number) =>
      new Date(
        now.getFullYear(),
        now.getMonth(),
        now.getDate() - daysAgo,
        hour
      ).toISOString()
    api.personalAgentDispatches.mockResolvedValue([
      dispatch({
        id: 3,
        title: "Ship the page",
        state: "completed",
        finished_at: at(1, 11),
      }),
      dispatch({
        id: 4,
        mode: "chat",
        title: "Look into the logs",
        state: "completed",
        finished_at: new Date(2025, 2, 3, 9, 30).toISOString(),
      }),
    ])
    api.personalAgentOutputs.mockResolvedValue([
      { path: "notes/weekly.md", modified_at: at(0, 12), size: 9 },
    ])
    api.personalAgentOutputRead.mockResolvedValue("# Weekly")
    draw()
    await screen.findByText("weekly.md")
    // A list a day, its name over it; a document named by its file, its
    // folder on its line, the time of day at its end.
    const days = [...document.querySelectorAll("[data-pa-output-day]")]
    expect(days.map((d) => d.querySelector("h4")!.textContent)).toEqual([
      "Today",
      "Yesterday",
      expect.stringContaining("2025"),
    ])
    expect(
      days.map((d) => d.querySelectorAll("[role='listitem']").length)
    ).toEqual([1, 1, 1])
    expect(days[2].textContent).toContain("Look into the logs")
    const doc = document.querySelector(
      "[data-pa-output-doc='notes/weekly.md']"
    )!
    expect(doc.textContent).toContain("Document · notes")
    // The kind picked from the title, as many as it holds after it.
    const title = () =>
      screen.getByRole("button", { name: /^Output: / }) as HTMLElement
    expect(title().textContent).toBe("All output3")
    const titles = () =>
      [
        ...screen
          .getByRole("tabpanel")
          .querySelectorAll("[role='listitem'] [data-pa-item-open]"),
      ].map((el) => el.textContent)
    expect(titles()).toEqual([
      "weekly.md",
      "Ship the page",
      "Look into the logs",
    ])
    const pick = async (name: RegExp) => {
      await userEvent.click(title())
      await userEvent.click(await screen.findByRole("menuitemradio", { name }))
    }
    // The menu: each kind with how many it holds, the one shown checked.
    await userEvent.click(title())
    const choices = await screen.findAllByRole("menuitemradio")
    expect(choices.map((c) => c.textContent)).toEqual([
      "All3",
      "Tasks1",
      "Reports1",
      "Documents1",
    ])
    expect(choices[0].getAttribute("aria-checked")).toBe("true")
    await userEvent.keyboard("{Escape}")
    await pick(/^Tasks/)
    expect(title().textContent).toBe("Tasks1")
    // Over the tasks, how they came out.
    expect(
      document.querySelector("[data-pa-output-summary]")?.textContent
    ).toContain("The last task")
    expect(titles()).toEqual(["Ship the page"])
    // The round × goes back to them all.
    await userEvent.click(screen.getByRole("button", { name: "Show all" }))
    expect(title().textContent).toBe("All output3")
    expect(screen.queryByRole("button", { name: "Show all" })).toBeNull()
    expect(document.querySelector("[data-pa-output-summary]")).toBeNull()
    await pick(/^Reports/)
    expect(titles()).toEqual(["Look into the logs"])
    await pick(/^Documents/)
    fireEvent.click(screen.getByText("weekly.md").closest("button")!)
    expect(api.personalAgentOutputRead).toHaveBeenCalledWith(
      null,
      "notes/weekly.md"
    )
    expect(await screen.findByRole("heading", { name: "Weekly" })).toBeTruthy()
  })

  it("opens a report in place, one at a time, with the way to its session", async () => {
    usePersonalAgentUi.setState({ auxTab: "output" })
    api.personalAgentDispatches.mockResolvedValue([
      dispatch({
        id: 4,
        mode: "chat",
        title: "Look into the logs",
        state: "completed",
        ladder: "done",
        conversation_id: 40,
        conversation_folder_id: 2,
        result_excerpt: "The logs rotate hourly.",
        finished_at: "2026-11-04T10:00:00Z",
      }),
      dispatch({
        id: 5,
        mode: "chat",
        title: "Check the build",
        state: "failed",
        ladder: "failed",
        error: "cargo: exit 101",
        finished_at: "2026-11-04T09:00:00Z",
      }),
    ])
    draw()
    const logs = await screen.findByText("Look into the logs")
    const button = logs.closest("button")!
    button.focus()
    const card = (title: string) =>
      screen.getByText(title).closest<HTMLElement>("[data-slot='item']")!
    // Folded: a row, what it found not shown.
    expect(button.getAttribute("aria-expanded")).toBe("false")
    expect(card("Look into the logs").getAttribute("data-pa-shape")).toBe("row")
    expect(screen.queryByText("The logs rotate hourly.")).toBeNull()
    fireEvent.click(button)
    // Opened in place: the same button, the focus still on it.
    expect(button.isConnected).toBe(true)
    expect(document.activeElement).toBe(button)
    expect(button.getAttribute("aria-expanded")).toBe("true")
    expect(card("Look into the logs").getAttribute("data-pa-shape")).toBe(
      "card"
    )
    expect(
      screen
        .getByText("The logs rotate hourly.")
        .closest("[data-pa-callout]")
        ?.getAttribute("data-pa-callout")
    ).toBe("neutral")
    expect(
      within(card("Look into the logs")).getByRole("button", {
        name: "View session",
      })
    ).toBeTruthy()
    // Another opened: the first folds; a failed one says why in red.
    fireEvent.click(screen.getByText("Check the build").closest("button")!)
    expect(button.getAttribute("aria-expanded")).toBe("false")
    expect(
      screen
        .getByText("cargo: exit 101")
        .closest("[data-pa-callout]")
        ?.getAttribute("data-pa-callout")
    ).toBe("error")
  })

  it("gathers a folder's documents of a day on one card, its pictures as thumbnails", async () => {
    usePersonalAgentUi.setState({ auxTab: "output" })
    const at = new Date().toISOString()
    api.personalAgentOutputs.mockResolvedValue([
      ...Array.from({ length: 10 }, (_, i) => ({
        path: `avatars/${i + 1}.png`,
        modified_at: at,
        size: 2048,
      })),
      { path: "avatars/readme.md", modified_at: at, size: 10 },
      { path: "avatars/huge.png", modified_at: at, size: 5 * 1024 * 1024 },
    ])
    api.readWorkspaceFileBase64.mockResolvedValue("iVBORw0KGgo=")
    draw()
    const folder = await waitFor(() => {
      const el = document.querySelector<HTMLElement>(
        "[data-pa-output-folder='avatars']"
      )
      expect(el).toBeTruthy()
      return el!
    })
    expect(folder.textContent).toContain("avatars/")
    expect(folder.textContent).toContain("12 files")
    // Two rows of pictures, the other document a line; the rest behind
    // "N more files".
    const pictures = () =>
      [...folder.querySelectorAll("[data-pa-output-doc]")].filter((el) =>
        el.getAttribute("data-pa-output-doc")!.endsWith(".png")
      )
    expect(pictures()).toHaveLength(8)
    // In the order of their names, 2 before 10.
    expect(
      pictures()
        .slice(0, 3)
        .map((el) => el.getAttribute("data-pa-output-doc"))
    ).toEqual(["avatars/1.png", "avatars/2.png", "avatars/3.png"])
    expect(
      folder.querySelector("[data-pa-output-doc='avatars/readme.md']")
    ).toBeTruthy()
    await waitFor(() =>
      expect(folder.querySelectorAll("img").length).toBeGreaterThan(0)
    )
    expect(folder.querySelector("img")!.getAttribute("src")).toBe(
      "data:image/png;base64,iVBORw0KGgo="
    )
    expect(api.readWorkspaceFileBase64).toHaveBeenCalledWith(
      "/data/personal-agent",
      "avatars/1.png",
      1024 * 1024
    )
    fireEvent.click(
      within(folder).getByRole("button", { name: "3 more files" })
    )
    expect(pictures()).toHaveLength(11)
    // One too large is not read: its kind's icon stands for it.
    expect(api.readWorkspaceFileBase64).not.toHaveBeenCalledWith(
      "/data/personal-agent",
      "avatars/huge.png",
      expect.anything()
    )
    // A picture opens as itself, read as bytes.
    fireEvent.click(
      folder.querySelector<HTMLElement>("[data-pa-output-doc='avatars/2.png']")!
    )
    const picture = await waitFor(() => {
      const img = document.querySelector("[data-pa-output-picture]")
      expect(img).toBeTruthy()
      return img!
    })
    expect(picture.getAttribute("src")).toBe(
      "data:image/png;base64,iVBORw0KGgo="
    )
    expect(api.personalAgentOutputRead).not.toHaveBeenCalled()
  })
})

describe("the workspace tab", () => {
  it("follows each piece of work live, a task's from the board, and stands aside while the drawer shows one", async () => {
    usePersonalAgentUi.setState({ auxTab: "workspace" })
    board.tasks = [{ id: 7, conversation_id: 70, status: "running" }]
    api.personalAgentDispatches.mockResolvedValue([
      dispatch({
        id: 2,
        mode: "session",
        title: "Look at the checkout",
        state: "running",
        conversation_id: 31,
        connection_id: "c-31",
        work_task_id: null,
      }),
      dispatch({ id: 3, title: "Fix the bug", state: "running" }),
    ])
    const { unmount } = draw()
    await screen.findByText("#2 Look at the checkout")
    // The session's connection attached, hydrated, for the preview.
    expect(acp.attachDelegationChild).toHaveBeenCalledWith(
      expect.objectContaining({ connectionId: "c-31", hydrate: true })
    )
    expect(
      document
        .querySelector("[data-live-transcript='31']")
        ?.getAttribute("data-connection")
    ).toBe("c-31")
    // The task's session, from the board.
    expect(document.querySelector("[data-task-preview='7']")).toBeTruthy()
    // The drawer opens one: the previews stand aside, and let go.
    act(() => usePersonalAgentUi.setState({ workOpen: true }))
    expect(document.querySelector("[data-pa-workspace-preview]")).toBeNull()
    expect(acp.detachDelegationChild).toHaveBeenCalledWith("c-31")
    unmount()
    board.tasks = []
  })

  it("shows the work running now, and an empty screen when none is", async () => {
    usePersonalAgentUi.setState({ auxTab: "workspace" })
    const { unmount } = draw()
    expect(await screen.findByText("Nothing running right now")).toBeTruthy()
    // A screen with nothing on it, its face asleep on it, whose under it.
    const empty = document.querySelector("[data-pa-workspace-empty]")!
    expect(
      empty
        .querySelector("[data-slot='bot-avatar']")
        ?.getAttribute("data-bot-look")
    ).toBe("sleeping")
    // Whose it is on the window's bar, over the face.
    expect(empty.textContent).toContain("Nova's workspace")
    expect(
      empty.textContent!.indexOf("Nova's workspace") <
        empty.textContent!.indexOf("Nothing running right now")
    ).toBe(true)
    unmount()
    api.personalAgentDispatches.mockResolvedValue([
      dispatch({
        id: 2,
        mode: "session",
        title: "Run the build",
        state: "running",
        conversation_id: 31,
        work_task_id: null,
      }),
    ])
    draw()
    const card = await screen.findByText("#2 Run the build")
    const item = card.closest<HTMLElement>("[data-pa-workspace-item]")!
    expect(item.querySelector("[data-live-transcript='31']")).toBeTruthy()
    // Where it stands under its title; the view opens it, as [Open] does.
    expect(item.querySelector("[data-pa-ladder]")).toBeTruthy()
    fireEvent.click(item.querySelector("[data-pa-workspace-open='2']")!)
    expect(usePersonalAgentUi.getState().work).toMatchObject({
      dispatchId: 2,
    })
  })
})

describe("the stats tab's status", () => {
  beforeEach(() => {
    usePersonalAgentUi.setState({ auxTab: "stats" })
  })

  it("shows what it runs on, on one card, then how full its context is", async () => {
    draw()
    const card = document.querySelector<HTMLElement>("[data-pa-status]")!
    // What it runs on and its model, its session and when that started —
    // its state is the head's, under its name; who it is is the head.
    expect(card.querySelector("[data-pa-runtime-agent]")!.textContent).toBe(
      "Claude Code · Opus"
    )
    expect(
      card.querySelector("[data-pa-runtime-session]")!.textContent
    ).toContain("#3")
    expect(
      document.querySelectorAll("[data-pa-aux] [data-slot='bot-avatar']")
    ).toHaveLength(1)
    // Connected, here, nothing pending: nothing to know now.
    expect(card.querySelector("[data-pa-runtime-notice]")).toBeNull()
    // The way to change what it runs on.
    fireEvent.click(
      within(card).getByRole("button", { name: "Change what it runs on" })
    )
    expect(usePersonalAgentUi.getState().botPage).toEqual({ tab: "identity" })
    usePersonalAgentUi.setState({ settings: null, botPage: null })
    // The session it runs in, and the way to it.
    const opened = vi.fn()
    window.addEventListener("codeg:open-personal-agent-session", opened)
    fireEvent.click(within(card).getByRole("button", { name: "View session" }))
    expect(opened).toHaveBeenCalledTimes(1)
    window.removeEventListener("codeg:open-personal-agent-session", opened)
    // Its working directory, copyable.
    expect(
      card.querySelector("[data-pa-runtime-workdir]")!.textContent
    ).toContain("/data/personal-agent")
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.assign(navigator, { clipboard: { writeText } })
    fireEvent.click(within(card).getByRole("button", { name: "Copy path" }))
    expect(writeText).toHaveBeenCalledWith("/data/personal-agent")
    expect(await screen.findByRole("button", { name: "Copied" })).toBeTruthy()
    // Its context, a card of its own: the reading in its head, the meter
    // marked where codeg compacts it.
    const context = document.querySelector<HTMLElement>("[data-pa-context]")!
    expect(context).not.toBe(card)
    expect(
      context.querySelector("[data-pa-context-reading]")!.textContent
    ).toBe("45%")
    expect(
      within(context).getByRole("progressbar").getAttribute("aria-valuenow")
    ).toBe("45")
    expect(context.textContent).toContain("70% auto-compact")
    // The run log and the rest of how it runs, a dialog each.
    expect(screen.queryByText("Dispatched conversations")).toBeNull()
    const detailsButton = within(card).getByRole("button", { name: /Details/ })
    await userEvent.click(detailsButton)
    const details = await screen.findByRole("dialog")
    expect(
      within(details).getByRole("heading", { name: "Details" })
    ).toBeTruthy()
    expect(within(details).getByText("Dispatched conversations")).toBeTruthy()
    expect(within(details).getByText("Default")).toBeTruthy()
    await userEvent.keyboard("{Escape}")
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
    // Closed: the focus back on the button that opened it.
    await waitFor(() => expect(document.activeElement).toBe(detailsButton))
    fireEvent.click(within(card).getByRole("button", { name: /Run log/ }))
    expect(
      within(await screen.findByRole("dialog")).getByText("Nothing yet.")
    ).toBeTruthy()
  })

  it("says the one thing to know now: not connected, a new session coming, running elsewhere", () => {
    const snap = snapshot()
    snap.status.connected = false
    pa.snapshot = snap
    const { unmount } = draw({ snap })
    expect(
      document.querySelector("[data-pa-runtime-notice]")!.textContent
    ).toBe("Not connected (reconnects with the next message)")
    unmount()
    // Running elsewhere comes first, and nothing is changed from here.
    const elsewhere = snapshot()
    elsewhere.status.connected = false
    elsewhere.status.engine = "elsewhere" as never
    pa.snapshot = elsewhere
    draw({ snap: elsewhere })
    const card = document.querySelector<HTMLElement>("[data-pa-status]")!
    expect(
      card.querySelector("[data-pa-runtime-notice]")!.textContent
    ).not.toContain("Not connected")
    expect(
      within(card).queryByRole("button", { name: "Change what it runs on" })
    ).toBeNull()
  })

  it("lists the run log in words and times, newest first, its count on its button", async () => {
    pa.rows = [
      marker(1, {
        marker: "segment_start",
        agent: "Claude Code",
        reason: "first",
      }),
      marker(2, { marker: "reconnected" }),
      marker(3, { marker: "turn_interrupted", why: "preempted" }),
      marker(4, { marker: "turn_interrupted", why: "restart" }),
    ]
    draw()
    const button = screen.getByRole("button", { name: /Run log/ })
    expect(button.textContent).toBe("Run log4")
    fireEvent.click(button)
    const dialog = await screen.findByRole("dialog")
    // Newest first, a line each and when — no icon before it.
    const lines = within(dialog).getAllByRole("listitem")
    expect(lines.map((li) => li.firstElementChild!.textContent)).toEqual([
      "A reply did not finish",
      "A reply made way for your message",
      "Reconnected to the same session",
      "A new session started on Claude Code (first session)",
    ])
    for (const li of lines) expect(li.querySelector("svg")).toBeNull()
  })
})

describe("the stats tab's data", () => {
  it("leads with the figures of the last two weeks", async () => {
    usePersonalAgentUi.setState({ auxTab: "stats" })
    const day = (date: string, n: number) => ({
      date,
      owner_messages: n,
      replies: n,
      dispatches_task: n,
      dispatches_chat: 0,
      dispatches_session: 0,
      dispatches_completed: n - 1,
      dispatches_failed: 1,
      agent_tokens: 1000 * n,
      dispatch_tokens: 2000 * n,
    })
    api.personalAgentStats.mockResolvedValue({
      days: [
        day("2026-11-03", 2),
        day("2026-11-04", 4),
        // A quiet day: nothing at all.
        {
          ...day("2026-11-05", 0),
          dispatches_completed: 0,
          dispatches_failed: 0,
        },
      ],
      agents: [],
      usage: [],
      tokens_synced_at: "2026-11-04T12:00:00Z",
    } satisfies PersonalAgentStats)
    // A face: the charts in its colour.
    const faced: PersonalAgentSnapshot = {
      ...snapshot(),
      agent: {
        ...snapshot().agent!,
        avatar: { kind: "face", shape: "ring", color: "orange" },
      },
    }
    pa.snapshot = faced
    draw({ snap: faced })
    // The range, picked from its title; then the figures, a tile each.
    expect(
      await screen.findByRole("button", { name: /Last 14 days/ })
    ).toBeTruthy()
    const figures = await waitFor(() => {
      const el = document.querySelector<HTMLElement>("[data-pa-figures]")
      expect(el).toBeTruthy()
      return el!
    })
    // 6 messages and 6 replies; 6 handed out, 4 done, 2 failed.
    expect(within(figures).getByText("12")).toBeTruthy()
    expect(within(figures).getByText("You 6 · replies 6")).toBeTruthy()
    expect(within(figures).getByText("Done 4 · failed 2")).toBeTruthy()
    expect(figures.querySelector("[data-pa-completion]")!.textContent).toBe(
      "67%"
    )
    expect(within(figures).getByText("18K")).toBeTruthy()
    // Enough handed out: no word about a small sample.
    expect(figures.textContent).not.toContain("read it loosely")
    // The daily conversation a chart; the daily work a row of days, red
    // where something failed, quiet where nothing happened.
    expect(
      document.querySelector("[data-chart='Daily conversation']")
    ).toBeTruthy()
    const dots = [...document.querySelectorAll("[data-pa-dot]")].map((d) =>
      d.getAttribute("data-pa-dot")
    )
    expect(dots).toEqual(["failed", "failed", "none"])
    expect(
      document.querySelector("[data-pa-chart-card='dispatches']")!.textContent
    ).toContain("6 in 14 days")
    const viz = document.querySelector<HTMLElement>(".tu-viz")!
    expect(viz.getAttribute("data-pa-face")).toBe("orange")
    expect(viz.style.getPropertyValue("--tu-accent")).toBe("var(--pa-body)")
    // The rest folded at first, on one card; open on asking, and kept so
    // across a switch of tabs.
    expect(document.querySelector("[data-chart='ranked']")).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: /By agent/ }))
    expect(document.querySelector("[data-chart='ranked']")).toBeTruthy()
    act(() => usePersonalAgentUi.setState({ auxTab: "output" }))
    act(() => usePersonalAgentUi.setState({ auxTab: "stats" }))
    expect(
      await waitFor(() => {
        const el = document.querySelector("[data-chart='ranked']")
        expect(el).toBeTruthy()
        return el
      })
    ).toBeTruthy()
  })

  it("reads another range when picked, and keeps it on this device", async () => {
    usePersonalAgentUi.setState({ auxTab: "stats" })
    window.localStorage.removeItem("codeg:personal-agent:stats-days")
    api.personalAgentStats.mockResolvedValue({
      days: [
        {
          date: "2026-11-04",
          owner_messages: 1,
          replies: 1,
          dispatches_task: 1,
          dispatches_chat: 0,
          dispatches_session: 0,
          dispatches_completed: 1,
          dispatches_failed: 0,
          agent_tokens: 0,
          dispatch_tokens: 0,
        },
      ],
      agents: [],
      usage: [],
      tokens_synced_at: null,
    } satisfies PersonalAgentStats)
    draw()
    await userEvent.click(
      await screen.findByRole("button", { name: /Last 14 days/ })
    )
    const choices = await screen.findAllByRole("menuitemradio")
    expect(choices.map((c) => c.textContent)).toEqual([
      "Last 7 days",
      "Last 14 days",
      "Last 30 days",
    ])
    await userEvent.click(choices[0])
    await waitFor(() =>
      expect(api.personalAgentStats).toHaveBeenLastCalledWith(7, null)
    )
    expect(screen.getByRole("button", { name: /Last 7 days/ })).toBeTruthy()
    // No × back: a range has no "all".
    expect(screen.queryByRole("button", { name: "Last 14 days" })).toBeNull()
    expect(window.localStorage.getItem("codeg:personal-agent:stats-days")).toBe(
      "7"
    )
    // One handed out: the rate says it is a small sample.
    expect((await screen.findByText(/read it loosely/)).textContent).toContain(
      "Only 1"
    )
    window.localStorage.removeItem("codeg:personal-agent:stats-days")
  })

  it("takes a text avatar's colour as a face's — the nearest one for an old colour", async () => {
    usePersonalAgentUi.setState({ auxTab: "stats" })
    api.personalAgentStats.mockResolvedValue({
      days: [],
      agents: [],
      usage: [],
      tokens_synced_at: null,
    } satisfies PersonalAgentStats)
    // The fixture's emoji is in the collaboration settings' violet.
    draw()
    await screen.findByText("Last 14 days")
    const viz = await waitFor(() => {
      const el = document.querySelector<HTMLElement>(".tu-viz")
      expect(el).toBeTruthy()
      return el!
    })
    expect(viz.getAttribute("data-pa-face")).toBe("purple")
    expect(viz.style.getPropertyValue("--tu-accent")).toBe("var(--pa-body)")
  })

  it("keeps the dashboard's colours for an assistant with a picture", async () => {
    usePersonalAgentUi.setState({ auxTab: "stats" })
    api.personalAgentStats.mockResolvedValue({
      days: [],
      agents: [],
      usage: [],
      tokens_synced_at: null,
    } satisfies PersonalAgentStats)
    const pictured: PersonalAgentSnapshot = {
      ...snapshot(),
      agent: {
        ...snapshot().agent!,
        avatar: { kind: "image", data_url: "data:image/png;base64,AA" },
      },
    }
    pa.snapshot = pictured
    draw({ snap: pictured })
    await screen.findByText("Last 14 days")
    const viz = await waitFor(() => {
      const el = document.querySelector<HTMLElement>(".tu-viz")
      expect(el).toBeTruthy()
      return el!
    })
    expect(viz.getAttribute("data-pa-face")).toBeNull()
    expect(viz.style.getPropertyValue("--tu-accent")).toBe("")
  })
})
