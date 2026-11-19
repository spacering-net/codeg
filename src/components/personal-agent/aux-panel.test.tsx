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
import { __resetThumbsForTests } from "./aux/output/use-thumb"

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
    Object.assign(worker.agent!, { kind: "worker", template: "dev" })
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
    // No pill over the matters: "Matters" leads each group's bar, before
    // its own name.
    const part = container.querySelector<HTMLElement>(
      '[data-pa-detail="matters"]'
    )!
    expect(part.querySelector(".border-dashed")).toBeNull()
    for (const g of groups) {
      const bar = group(g!).querySelector("button")!
      expect(bar.querySelector("[data-pa-group-section]")!.textContent).toBe(
        "Matters"
      )
      expect(bar.textContent).toMatch(/^Matters·/)
    }
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
    fireEvent.click(screen.getByRole("button", { name: /By assistant/ }))
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
      executors: [],
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
