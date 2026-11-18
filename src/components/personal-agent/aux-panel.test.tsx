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
  DispatchInfo,
  ItemInfo,
  PersonalAgentSnapshot,
  PersonalAgentStats,
  TimelineRow,
} from "@/lib/types"
import { usePersonalAgentUi } from "@/stores/personal-agent-ui-store"

const api = vi.hoisted(() => ({
  personalAgentItems: vi.fn(),
  personalAgentDispatches: vi.fn(),
  personalAgentStats: vi.fn(),
  personalAgentResumeAutoCompact: vi.fn(),
  personalAgentItemAct: vi.fn(async () => ({})),
  personalAgentDispatchStop: vi.fn(async () => true),
  personalAgentOutputs: vi.fn(),
  personalAgentOutputRead: vi.fn(),
  personalAgentRosterAct: vi.fn(async () => {}),
  personalAgentBots: vi.fn(),
  personalAgentRoutines: vi.fn(async () => []),
  personalAgentRoutineAct: vi.fn(async () => ({})),
  personalAgentTemplates: vi.fn(async () => []),
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
// "Today" has its own tests: here, only where it stands.
const todayFeed = vi.hoisted(() => ({ active: [] as boolean[] }))
vi.mock("@/stores/personal-agent-today-store", () => ({
  useToday: (active = true) => {
    todayFeed.active.push(active)
    return null
  },
}))
vi.mock("./today-section", () => ({
  TodaySection: ({ title }: { title: string }) => (
    <section data-pa-detail="today">
      <h3>{title}</h3>
    </section>
  ),
}))
// The charts measure their box, which jsdom has none of: their own tests
// cover them.
vi.mock("@/components/token-usage/charts", () => ({
  TrendChart: ({ label }: { label: string }) => <div data-chart={label} />,
  RankedBars: () => <div data-chart="ranked" />,
}))

import { __resetRosterForTests } from "@/stores/personal-agent-roster-store"
import { __resetTemplatesForTests } from "./use-templates"

import { PersonalAgentAuxPanel } from "./aux-panel"
import { PageScopeContext, type PageScope } from "./shared"

function dispatch(patch: Partial<DispatchInfo>): DispatchInfo {
  return {
    id: 1,
    mode: "task",
    executor: {
      assistant_id: 3,
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
  pa.snapshot = snapshot()
  pa.rows = []
  __resetRosterForTests()
  __resetTemplatesForTests()
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
      template: null,
      executor_assistant_id: null,
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
  api.personalAgentItems.mockResolvedValue([])
  api.personalAgentDispatches.mockResolvedValue([])
  api.personalAgentStats.mockResolvedValue({
    days: [],
    executors: [],
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
    expect(await screen.findByText("Opus")).toBeTruthy()
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

  it("says under its name how it is: its state, the primary's work assistants, a work assistant's role", async () => {
    const entry = (await api.personalAgentBots())[0]
    const worker = (id: number, hidden = false) => ({
      ...entry,
      id,
      kind: "worker",
      name: `W${id}`,
      template: "dev",
      roster: { ...entry.roster, hidden },
    })
    api.personalAgentBots.mockResolvedValue([
      entry,
      worker(2),
      worker(3),
      worker(4, true),
    ])
    api.personalAgentTemplates.mockResolvedValue([
      { id: "dev", name: "Developer" },
    ] as never)
    const { unmount } = draw()
    const line = await screen.findByText("Idle · 2 work assistants")
    expect(line.closest("[data-pa-aux-head-line]")).toBeTruthy()
    expect(line.parentElement?.querySelector(".bg-emerald-500")).toBeTruthy()
    unmount()
    // A work assistant: its role, from the template it was made from.
    const snap = snapshot()
    Object.assign(snap.agent!, { kind: "worker", template: "dev" })
    pa.snapshot = snap
    const { unmount: unmountWorker } = draw({ snap })
    expect(await screen.findByText("Idle · Developer")).toBeTruthy()
    unmountWorker()
    // A role that is its name says nothing more: its state alone.
    const named = snapshot()
    Object.assign(named.agent!, {
      kind: "worker",
      template: "dev",
      name: "Developer",
    })
    pa.snapshot = named
    draw({ snap: named })
    const alone = await screen.findByText("Idle")
    expect(alone.closest("[data-pa-aux-head-line]")?.textContent).toBe("Idle")
  })

  it("is the same in the drawer, its count of what waits on the owner on its activity", async () => {
    api.personalAgentItems.mockResolvedValue([
      item({
        id: 11,
        kind: "question",
        waits_for: "owner",
        summary: "Which branch?",
      }),
    ])
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

describe("the activity's matters", () => {
  it("groups what is open by whom it waits on, each piece once; what ended is output", async () => {
    api.personalAgentDispatches.mockResolvedValue([
      dispatch({ id: 1, title: "Review the login fix", state: "review" }),
      dispatch({ id: 2, title: "Run the build", state: "running" }),
      dispatch({
        id: 3,
        title: "Write the notes",
        state: "completed",
        finished_at: "2026-11-04T11:00:00Z",
      }),
      dispatch({ id: 4, title: "Fix the flaky test", state: "failed" }),
      // Moving, its entry dropped: still listed.
      dispatch({ id: 5, title: "Queue the deploy", state: "queued" }),
    ])
    api.personalAgentItems.mockResolvedValue([
      item({
        id: 11,
        dispatch_id: 1,
        waits_for: "owner",
        status: "waiting",
        dispatch_state: "review",
        summary: "Review the login fix",
      }),
      item({
        id: 12,
        dispatch_id: 2,
        summary: "Run the build",
        dispatch_state: "running",
        on_done: "tell the owner",
      }),
      item({
        id: 14,
        dispatch_id: 4,
        waits_for: "agent",
        summary: "Fix the flaky test",
        dispatch_state: "failed",
      }),
      item({
        id: 15,
        kind: "reminder",
        waits_for: "time",
        summary: "Look at the merge request at 10",
        origin_timeline_id: 40,
      }),
    ])
    const { container } = draw()
    await screen.findByText("Review the login fix")
    const groups = [...container.querySelectorAll("[data-pa-group]")].map((g) =>
      g.getAttribute("data-pa-group")
    )
    expect(groups).toEqual(["owner", "external", "agent", "time"])
    const group = (g: string) =>
      container.querySelector<HTMLElement>(`[data-pa-group='${g}']`)!
    expect(
      within(group("owner")).getByText("Review the login fix")
    ).toBeTruthy()
    expect(group("external").textContent).toContain("Run the build")
    expect(group("external").textContent).toContain("Queue the deploy")
    // What it will do once done, from its entry.
    expect(group("external").textContent).toContain("When done: tell the owner")
    expect(group("agent").textContent).toContain("Fix the flaky test")
    expect(group("time").textContent).toContain("Look at the merge request")
    // A group folds from its head: its marker, name and count, its chevron
    // at the end.
    const head = within(group("owner")).getByRole("button", { name: /Waiting/ })
    expect(head.getAttribute("aria-expanded")).toBe("true")
    expect(head.textContent).toContain("1")
    expect(head.lastElementChild!.getAttribute("class")).toContain(
      "lucide-chevron-down"
    )
    // Each piece of work once; what ended is not among them.
    for (const title of [
      "Review the login fix",
      "Run the build",
      "Fix the flaky test",
      "Queue the deploy",
    ]) {
      expect(screen.getAllByText(title)).toHaveLength(1)
    }
    expect(screen.queryByText("Write the notes")).toBeNull()
    // Its tab counts what waits on the owner, and says it.
    const tab = screen.getByRole("tab", { name: /Activity/ })
    expect(tab.textContent).toBe("Activity1")
    expect(tab.getAttribute("aria-label")).toBe(
      "Activity · 1 thing waits for you"
    )
    // What ended is the output.
    fireEvent.mouseDown(screen.getByRole("tab", { name: "Output" }), {
      button: 0,
    })
    expect(await screen.findByText("Write the notes")).toBeTruthy()
  })

  it("opens a piece of work in the drawer, and goes to where a reminder came from", async () => {
    api.personalAgentDispatches.mockResolvedValue([
      dispatch({ id: 2, title: "Run the build", state: "running" }),
    ])
    api.personalAgentItems.mockResolvedValue([
      item({ id: 12, dispatch_id: 2, summary: "Run the build" }),
      item({
        id: 15,
        kind: "reminder",
        waits_for: "time",
        summary: "Look at the merge request at 10",
        origin_timeline_id: 40,
      }),
    ])
    draw()
    fireEvent.click(
      (await screen.findByText("Run the build")).closest("button")!
    )
    expect(usePersonalAgentUi.getState().work).toMatchObject({
      dispatchId: 2,
      workTaskId: 7,
    })
    const reminder = screen
      .getByText("Look at the merge request at 10")
      .closest("button")!
    expect(reminder.title).toBe("Show the message it came from")
    fireEvent.click(reminder)
    expect(jumpTo).toHaveBeenCalledWith(40)
  })

  it("says when nothing is open", async () => {
    draw()
    expect(await screen.findByText("Nothing open right now.")).toBeTruthy()
    expect(
      screen.getByRole("tab", { name: /Activity/ }).getAttribute("aria-label")
    ).toBe("Activity")
  })

  it("puts no open matters and no routines on one card, a row each with no head over it", async () => {
    draw()
    await screen.findByText("Nothing open right now.")
    await screen.findByText(
      "No routines yet. Ask it in the conversation to set one up."
    )
    const matters = document.querySelector<HTMLElement>(
      '[data-pa-detail="matters"]'
    )!
    const routines = document.querySelector<HTMLElement>(
      '[data-pa-detail="routines"]'
    )!
    // Rows, next to one another in one stack: drawn as one card.
    expect(matters.getAttribute("data-pa-shape")).toBe("row")
    expect(routines.getAttribute("data-pa-shape")).toBe("row")
    expect(matters.parentElement).toBe(routines.parentElement)
    expect(matters.nextElementSibling).toBe(routines)
    // No heads over them, the names on the rows.
    expect(screen.queryByRole("heading", { name: "Matters" })).toBeNull()
    expect(within(matters).getByText("Matters")).toBeTruthy()
    fireEvent.click(
      within(routines).getByRole("button", { name: "New routine" })
    )
    expect(usePersonalAgentUi.getState().routineEditor?.routineId).toBeNull()
  })

  it("keeps routines in their own part while matters are open, the head over them", async () => {
    api.personalAgentRoutines.mockResolvedValue([])
    api.personalAgentItems.mockResolvedValue([
      item({
        id: 11,
        kind: "reminder",
        summary: "Call back",
        waits_for: "time",
      }),
    ])
    draw()
    expect(await screen.findByText("Call back")).toBeTruthy()
    expect(screen.getByRole("heading", { name: "Matters" })).toBeTruthy()
    const routines = await waitFor(() => {
      const el = document.querySelector('[data-pa-detail="routines"]')
      expect(el).toBeTruthy()
      return el as HTMLElement
    })
    expect(routines.getAttribute("data-pa-shape")).toBe("row")
  })

  it("says why a piece of work failed in a red box, and folds what done looks like", async () => {
    api.personalAgentItems.mockResolvedValue([
      item({ id: 12, dispatch_id: 1, waits_for: "owner" }),
    ])
    api.personalAgentDispatches.mockResolvedValue([
      dispatch({
        id: 1,
        title: "Fix the login",
        state: "failed",
        ladder: "failed",
        error: "worktree add failed: Branch already exists",
        done_when: "The login works on Safari",
      }),
    ])
    draw()
    const error = await screen.findByText(
      "worktree add failed: Branch already exists"
    )
    const box = error.closest("[data-pa-callout]")!
    expect(box.getAttribute("data-pa-callout")).toBe("error")
    // An error's own text: in the code face.
    expect(box.className).toContain("font-mono")
    const card = error.closest<HTMLElement>("[data-slot='item']")!
    expect(card.getAttribute("data-pa-shape")).toBe("card")
    // Done when: folded under its label, open on asking.
    const fold = card.querySelector<HTMLElement>("[data-pa-done-when]")!
    expect(within(fold).queryByText("The login works on Safari")).toBeNull()
    fireEvent.click(within(fold).getByRole("button", { name: "Done when" }))
    expect(within(fold).getByText("The login works on Safari")).toBeTruthy()
  })

  it("settles a matter from its card: done, put off, later, dropped", async () => {
    api.personalAgentItems.mockResolvedValue([
      item({
        id: 11,
        kind: "question",
        waits_for: "owner",
        summary: "Which branch?",
      }),
      item({
        id: 15,
        kind: "reminder",
        waits_for: "time",
        summary: "Look at the merge request at 10",
      }),
    ])
    const { container } = draw()
    await screen.findByText("Which branch?")
    const question = container.querySelector<HTMLElement>(
      "[data-pa-group='owner']"
    )!
    // [Later] is a menu: a set time, or none.
    await userEvent.click(
      within(question).getByRole("button", { name: "Later" })
    )
    await userEvent.click(
      await screen.findByRole("menuitem", { name: "In 1 hour" })
    )
    expect(api.personalAgentItemAct).toHaveBeenCalledWith(
      null,
      11,
      "snooze",
      "1h"
    )
    await waitFor(() =>
      expect(
        within(question)
          .getByRole("button", { name: "Later" })
          .hasAttribute("disabled")
      ).toBe(false)
    )
    await userEvent.click(
      within(question).getByRole("button", { name: "Later" })
    )
    await userEvent.click(
      await screen.findByRole("menuitem", { name: "No set time" })
    )
    expect(api.personalAgentItemAct).toHaveBeenLastCalledWith(null, 11, "later")
    const done = within(question).getByRole("button", { name: "Done" })
    await waitFor(() => expect(done.hasAttribute("disabled")).toBe(false))
    fireEvent.click(done)
    expect(api.personalAgentItemAct).toHaveBeenLastCalledWith(null, 11, "done")
    // One already waiting on time has no "later".
    const reminder = container.querySelector<HTMLElement>(
      "[data-pa-group='time']"
    )!
    expect(within(reminder).queryByRole("button", { name: "Later" })).toBeNull()
    fireEvent.click(within(reminder).getByRole("button", { name: "Drop" }))
    expect(api.personalAgentItemAct).toHaveBeenLastCalledWith(null, 15, "drop")
  })

  it("says what brings a reminder on a mention up, and puts it off no time (6.8)", async () => {
    api.personalAgentItems.mockResolvedValue([
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
      }),
    ])
    const { container } = draw()
    await screen.findByText("Update the Homebrew formula first")
    expect(
      screen.getByText(
        /^When you mention “release”, “发版” · 1 of 3 times · until /
      )
    ).toBeTruthy()
    const card = container.querySelector<HTMLElement>("[data-pa-group='none']")!
    expect(within(card).queryByRole("button", { name: "Later" })).toBeNull()
    fireEvent.click(within(card).getByRole("button", { name: "Drop" }))
    expect(api.personalAgentItemAct).toHaveBeenLastCalledWith(null, 31, "drop")
  })

  it("says when a matter is due, how it comes back, and puts off one waiting on time", async () => {
    const hour = 3_600_000
    api.personalAgentItems.mockResolvedValue([
      item({
        id: 21,
        kind: "reminder",
        waits_for: "time",
        summary: "Stand-up notes",
        due_at: new Date(Date.now() + hour).toISOString(),
        repeat: { every: "weekdays", at: "09:00" },
        at_due: "notify",
      }),
      item({
        id: 22,
        kind: "followup",
        waits_for: "time",
        summary: "Check the release",
        due_at: new Date(Date.now() - hour).toISOString(),
        at_due: "act",
      }),
      item({
        id: 23,
        kind: "reminder",
        waits_for: "owner",
        summary: "Call the bank",
        due_at: new Date(Date.now() - hour).toISOString(),
        fired_at: new Date(Date.now() - hour + 5_000).toISOString(),
        at_due: "notify",
      }),
    ])
    const { container } = draw()
    await screen.findByText("Stand-up notes")
    expect(screen.getByText(/^Due .+ · Every weekday 09:00$/)).toBeTruthy()
    expect(screen.getByText(/^Overdue · due /)).toBeTruthy()
    expect(screen.getByText(/^Reminded · due /)).toBeTruthy()
    // The one the assistant does itself says so.
    expect(
      container.querySelectorAll("[data-pa-item-at-due='act']")
    ).toHaveLength(1)
    // Waiting on time with a due time, it can still be put off.
    const card = screen
      .getByText("Stand-up notes")
      .closest<HTMLElement>("[data-slot='item']")!
    await userEvent.click(within(card).getByRole("button", { name: "Later" }))
    await userEvent.click(
      await screen.findByRole("menuitem", { name: "Tomorrow morning" })
    )
    expect(api.personalAgentItemAct).toHaveBeenCalledWith(
      null,
      21,
      "snooze",
      "tomorrow"
    )
  })

  it("carries a task's card, and lets the owner close a pull request codeg does not follow", async () => {
    const facts = {
      task_id: 7,
      status: "review" as const,
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
    api.personalAgentDispatches.mockResolvedValue([
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
    ])
    api.personalAgentItems.mockResolvedValue([
      item({
        id: 11,
        dispatch_id: 1,
        waits_for: "owner",
        status: "waiting",
        dispatch_state: "review",
      }),
      item({
        id: 12,
        dispatch_id: 2,
        waits_for: "external",
        status: "waiting",
        dispatch_state: "completed",
      }),
    ])
    const { container } = draw()
    await screen.findByText("Fix the login")
    const card = (title: string) =>
      screen.getByText(title).closest<HTMLElement>("[data-slot='item']")!
    // In review: ready to merge, with its branch a chip and its diff after
    // it on one line (its project is the row's line), and the way to stop
    // it, red at the line's end — no way to close its entry by hand, nor
    // [Open session]: the row opens it.
    const review = card("Fix the login")
    expect(review.querySelector("[data-pa-ladder]")?.textContent).toBe(
      "Ready to merge"
    )
    expect(review.getAttribute("role")).toBe("listitem")
    const strip = review.querySelector("[data-pa-task-strip]")!
    expect(strip.textContent).toBe("pa/fix-login+214 −37, 6 filesStop")
    expect(
      strip.querySelector("[data-pa-task-branch]")?.getAttribute("title")
    ).toBe("pa/fix-login")
    expect(
      within(review)
        .getByRole("button", { name: "Stop" })
        .getAttribute("data-variant")
    ).toBe("destructive")
    expect(strip.querySelector("[data-pa-task-diff]")?.textContent).toBe(
      "+214 −37, 6 files"
    )
    expect(review.textContent).toContain("my-app")
    expect(
      within(review).queryByRole("button", { name: "Open session" })
    ).toBeNull()
    expect(within(review).queryByRole("button", { name: "Done" })).toBeNull()
    fireEvent.click(within(review).getByRole("button", { name: "Stop" }))
    expect(api.personalAgentDispatchStop).toHaveBeenCalledWith(null, 1)
    // Delivered as a pull request: said so, not stoppable, and its entry the
    // owner's to close.
    const pr = card("Ship the notes")
    expect(pr.querySelector("[data-pa-task-pr]")?.textContent).toBe(
      "PR opened · codeg is not watching it"
    )
    expect(within(pr).getByRole("button", { name: "View PR" })).toBeTruthy()
    expect(within(pr).queryByRole("button", { name: "Stop" })).toBeNull()
    fireEvent.click(within(pr).getByRole("button", { name: "Done" }))
    expect(api.personalAgentItemAct).toHaveBeenLastCalledWith(null, 12, "done")
    expect(container.querySelector("[data-pa-group='external']")).toBeTruthy()
  })

  it("shows Today first on the primary, before its matters; its status is the stats'", async () => {
    todayFeed.active = []
    const { container } = draw()
    await screen.findByRole("button", { name: "Notify me" })
    const order = [...container.querySelectorAll("[data-pa-detail]")].map(
      (el) => el.getAttribute("data-pa-detail")
    )
    expect(order).toEqual(["today", "matters", "routines"])
    // No "Status" heading, no card of it here.
    expect(screen.queryByText("Status")).toBeNull()
    expect(container.querySelector("[data-pa-status]")).toBeNull()
    expect(
      within(
        container.querySelector('[data-pa-detail="today"]') as HTMLElement
      ).getByText("Today")
    ).toBeTruthy()
    // Held while the primary's activity shows.
    expect(todayFeed.active).toContain(true)
  })

  it("has the bell to be told at the panel's top, nothing of it at the activity's end", async () => {
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
    // Neither the switch nor [Settings] under the routines any more.
    expect(screen.queryByRole("switch")).toBeNull()
    expect(screen.queryByRole("button", { name: "Settings" })).toBeNull()
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
    // How many each kind holds, after its name.
    expect(screen.getByRole("radio", { name: "All" }).textContent).toBe("All3")
    expect(screen.getByRole("radio", { name: "Tasks" }).textContent).toBe(
      "Tasks1"
    )
    const titles = () =>
      [
        ...screen
          .getByRole("tabpanel")
          .querySelectorAll(".text-\\[0\\.8125rem\\]"),
      ]
        .map((el) => el.textContent)
        .filter(Boolean)
    expect(titles()).toEqual([
      "weekly.md",
      "Ship the page",
      "Look into the logs",
    ])
    // The kinds, shadcn's toggle group: one picked at a time.
    expect(
      screen.getByRole("radio", { name: "All" }).getAttribute("aria-checked")
    ).toBe("true")
    fireEvent.click(screen.getByRole("radio", { name: "Tasks" }))
    expect(titles()).toEqual(["Ship the page"])
    fireEvent.click(screen.getByRole("radio", { name: "Reports" }))
    expect(titles()).toEqual(["Look into the logs"])
    fireEvent.click(screen.getByRole("radio", { name: "Documents" }))
    fireEvent.click(screen.getByText("weekly.md").closest("button")!)
    expect(api.personalAgentOutputRead).toHaveBeenCalledWith(
      null,
      "notes/weekly.md"
    )
    expect(await screen.findByRole("heading", { name: "Weekly" })).toBeTruthy()
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

  it("shows what it runs on row by row, no card, then how full its context is", async () => {
    draw()
    // A row per property, as Session Details has them — who it is is the
    // panel's head, not a card of its own here.
    expect(document.querySelector("[data-pa-status] section")).toBeNull()
    expect(
      document.querySelectorAll("[data-pa-aux] [data-slot='bot-avatar']")
    ).toHaveLength(1)
    const row = (label: string) =>
      screen.getByText(label, { selector: "dt" }).parentElement!
    // (Its icon carries the agent's name for a screen reader too.)
    expect(row("Agent").textContent).toContain("Claude Code")
    expect(row("State").textContent).toBe("StateIdle")
    // The way to change what it runs on, at its row's end.
    fireEvent.click(
      within(row("Agent")).getByRole("button", {
        name: "Change what it runs on",
      })
    )
    expect(usePersonalAgentUi.getState().botPage).toEqual({ tab: "identity" })
    usePersonalAgentUi.setState({ settings: null, botPage: null })
    expect(row("Model").textContent).toBe("ModelOpus")
    expect(row("Mode").textContent).toBe("ModeDefault")
    expect(row("Session").textContent).toContain("#3")
    expect(row("Working directory").textContent).toContain(
      "/data/personal-agent"
    )
    // Its context, open, its reading in the header.
    expect(
      screen.getByRole("button", { name: /Context/ }).textContent
    ).toContain("45%")
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe(
      "45"
    )
    // The run log and the details stay folded, and open.
    expect(screen.queryByText("Dispatched conversations")).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: /Details/ }))
    expect(screen.getByText("Dispatched conversations")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: /Run log/ }))
    expect(screen.getByText("Nothing yet.")).toBeTruthy()
    // The session it runs in, and the way to it.
    const opened = vi.fn()
    window.addEventListener("codeg:open-personal-agent-session", opened)
    fireEvent.click(screen.getByRole("button", { name: "View session" }))
    expect(opened).toHaveBeenCalledTimes(1)
    window.removeEventListener("codeg:open-personal-agent-session", opened)
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.assign(navigator, { clipboard: { writeText } })
    fireEvent.click(screen.getByRole("button", { name: "Copy path" }))
    expect(writeText).toHaveBeenCalledWith("/data/personal-agent")
    expect(await screen.findByRole("button", { name: "Copied" })).toBeTruthy()
  })

  it("lines its sections up with the rows, the run log in words and times", () => {
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
    fireEvent.click(screen.getByRole("button", { name: /Run log/ }))
    fireEvent.click(screen.getByRole("button", { name: /Details/ }))
    // Newest first, a line each and when — no icon before it.
    const lines = screen.getAllByRole("listitem")
    expect(lines.map((li) => li.firstElementChild!.textContent)).toEqual([
      "A reply did not finish",
      "A reply made way for your message",
      "Reconnected to the same session",
      "A new session started on Claude Code (first session)",
    ])
    for (const li of lines) expect(li.querySelector("svg")).toBeNull()
    // The run log and the details folded on one card, a hairline between;
    // the context a card of its own.
    const runLog = screen.getByRole("button", { name: /Run log/ })
    const shared = runLog.closest("[data-slot='card']")!
    expect(
      screen
        .getByRole("button", { name: /Details/ })
        .closest("[data-slot='card']")
    ).toBe(shared)
    expect(
      screen
        .getByRole("button", { name: /Context/ })
        .closest("[data-slot='card']")
    ).not.toBe(shared)
    // Each a folding card: its title first, its chevron at its head's end.
    for (const name of [/Context/, /Run log/, /Details/]) {
      const header = screen.getByRole("button", { name })
      expect(header.closest("[data-slot='collapsible']")).toBeTruthy()
      expect(header.firstElementChild!.textContent).toMatch(name)
      expect(header.lastElementChild!.getAttribute("class")).toContain(
        "lucide-chevron-down"
      )
    }
  })

  it("keeps a section folded or open across a switch of tabs", async () => {
    draw()
    fireEvent.click(screen.getByRole("button", { name: /Context/ }))
    expect(screen.queryByRole("progressbar")).toBeNull()
    act(() => usePersonalAgentUi.setState({ auxTab: "output" }))
    act(() => usePersonalAgentUi.setState({ auxTab: "stats" }))
    expect(
      screen
        .getByRole("button", { name: /Context/ })
        .getAttribute("aria-expanded")
    ).toBe("false")
    expect(screen.queryByRole("progressbar")).toBeNull()
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
      days: [day("2026-11-03", 2), day("2026-11-04", 4)],
      executors: [],
      usage: [],
      tokens_synced_at: "2026-11-04T12:00:00Z",
    } satisfies PersonalAgentStats)
    // A face: the charts in its colour.
    const faced: PersonalAgentSnapshot = {
      ...snapshot(),
      agent: {
        ...snapshot().agent!,
        avatar: { kind: "face", shape: "blob", color: "orange" },
      },
    }
    pa.snapshot = faced
    draw({ snap: faced })
    // Under its heading, four figures before the charts.
    const card = (await screen.findByText("Last 14 days"))
      .closest("section")!
      .querySelector("dl")!
    // 6 messages and 6 replies; 6 handed out, 4 done, 2 failed.
    expect(within(card).getByText("12")).toBeTruthy()
    expect(within(card).getByText("You 6 · replies 6")).toBeTruthy()
    expect(within(card).getByText("Done 4 · failed 2")).toBeTruthy()
    expect(within(card).getByText("67%")).toBeTruthy()
    expect(within(card).getByText("18K")).toBeTruthy()
    // Then each chart, a folding section with its total.
    const interactions = screen.getByRole("button", {
      name: /Daily conversation/,
    })
    expect(interactions.textContent).toContain("12")
    expect(
      document.querySelector("[data-chart='Daily conversation']")
    ).toBeTruthy()
    const viz = document.querySelector<HTMLElement>(".tu-viz")!
    expect(viz.getAttribute("data-pa-face")).toBe("orange")
    expect(viz.style.getPropertyValue("--tu-accent")).toBe("var(--pa-body)")
    fireEvent.click(interactions)
    expect(
      document.querySelector("[data-chart='Daily conversation']")
    ).toBeNull()
  })

  it("keeps the dashboard's colours for an assistant with no face", async () => {
    usePersonalAgentUi.setState({ auxTab: "stats" })
    api.personalAgentStats.mockResolvedValue({
      days: [],
      executors: [],
      usage: [],
      tokens_synced_at: null,
    } satisfies PersonalAgentStats)
    draw()
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
