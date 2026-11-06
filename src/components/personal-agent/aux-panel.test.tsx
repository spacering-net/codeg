import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react"
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
}))
const pa = vi.hoisted(() => ({
  snapshot: null as unknown,
  rows: [] as unknown[],
}))
const toasts = vi.hoisted(() => ({ message: vi.fn(), error: vi.fn() }))
vi.mock("@/lib/api", () => api)
vi.mock("sonner", () => ({ toast: toasts }))
vi.mock("@/contexts/personal-agent-context", () => ({
  usePersonalAgent: () => ({
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
// The charts measure their box, which jsdom has none of: their own tests
// cover them.
vi.mock("@/components/token-usage/charts", () => ({
  TrendChart: ({ label }: { label: string }) => <div data-chart={label} />,
  RankedBars: () => <div data-chart="ranked" />,
}))

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
  reserve = null,
}: { inDrawer?: boolean; reserve?: number | null } = {}) {
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
        <PersonalAgentAuxPanel
          snapshot={snapshot()}
          inDrawer={inDrawer}
          reserve={reserve}
        />
      </PageScopeContext.Provider>
    </NextIntlClientProvider>
  )
}

const FIRST_UI_STATE = usePersonalAgentUi.getState()

beforeEach(() => {
  pa.snapshot = snapshot()
  pa.rows = []
  usePersonalAgentUi.setState({
    auxOpen: true,
    auxTab: "work",
    auxFolds: {},
    work: null,
    workOpen: false,
  })
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

describe("the panel", () => {
  it("opens on the status tab", () => {
    expect(FIRST_UI_STATE.auxTab).toBe("status")
    expect(FIRST_UI_STATE.auxOpen).toBe(true)
  })

  it("names the open tab over it and lists the tabs down its edge", async () => {
    draw()
    expect(screen.getByRole("heading", { name: "Work" })).toBeTruthy()
    const rail = screen.getByRole("tablist", { name: "Assistant panel" })
    const tabs = within(rail).getAllByRole("tab")
    expect(tabs.map((tab) => tab.getAttribute("aria-label"))).toEqual([
      "Status",
      "Work",
      "Stats",
    ])
    // A gauge, a clipboard (not the task board's checklist), a pie.
    expect(
      tabs.map((tab) => tab.querySelector("svg")!.getAttribute("class"))
    ).toEqual([
      expect.stringContaining("lucide-circle-gauge"),
      expect.stringContaining("lucide-clipboard-list"),
      expect.stringContaining("lucide-chart-pie"),
    ])
    expect(rail.getAttribute("aria-orientation")).toBe("vertical")
    // Another tab: its name over it.
    fireEvent.mouseDown(within(rail).getByRole("tab", { name: "Stats" }), {
      button: 0,
    })
    expect(usePersonalAgentUi.getState().auxTab).toBe("stats")
    expect(await screen.findByRole("heading", { name: "Stats" })).toBeTruthy()
  })

  it("keeps the window's corner buttons clear when its strip is in the top band", () => {
    const { unmount } = draw({ reserve: 132 })
    const heading = screen.getByRole("heading", { name: "Work" })
    // The strip is the window's top edge there: its name and its empty rest
    // move the window, and its end is the corner buttons' slot.
    expect(heading.hasAttribute("data-tauri-drag-region")).toBe(true)
    const strip = heading.parentElement!
    const slot = strip.lastElementChild as HTMLElement
    expect(slot.classList.contains("chrome-reserve")).toBe(true)
    expect(slot.style.width).toBe("132px")
    // On the page's own ground with a line under it, as the band over the
    // conversation is: the top band reads as one.
    expect(strip.className).toContain("border-b")
    expect(strip.className).not.toContain("bg-muted")
    unmount()
    // Under the band (no slot to keep): its own end padding instead.
    draw()
    const plain = screen.getByRole("heading", { name: "Work" }).parentElement!
    expect(plain.querySelector(".chrome-reserve")).toBeNull()
    expect(plain.className).toContain("pe-3")
  })

  it("hides itself on a click of the tab already open, as the workspace's does", () => {
    draw()
    const tab = screen.getByRole("tab", { name: "Work" })
    // jsdom's `fireEvent.pointerDown` leaves `button` out: a MouseEvent of
    // the pointer's type carries it.
    const press = (target: Element) =>
      act(() => {
        target.dispatchEvent(
          new MouseEvent("pointerdown", { bubbles: true, button: 0 })
        )
      })
    // Another tab first: a click on it only opens it.
    const stats = screen.getByRole("tab", { name: "Stats" })
    press(stats)
    fireEvent.mouseDown(stats, { button: 0 })
    fireEvent.click(stats, { detail: 1 })
    expect(usePersonalAgentUi.getState()).toMatchObject({
      auxTab: "stats",
      auxOpen: true,
    })
    press(tab)
    fireEvent.mouseDown(tab, { button: 0 })
    fireEvent.click(tab, { detail: 1 })
    expect(usePersonalAgentUi.getState().auxOpen).toBe(true)
    // The tab that is open: the panel hides.
    press(tab)
    fireEvent.click(tab, { detail: 1 })
    expect(usePersonalAgentUi.getState().auxOpen).toBe(false)
  })

  it("is a row of named tabs under a line in the drawer", async () => {
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
      ).toEqual(["Status", "Work1", "Stats"])
    )
    // No strip over it: the drawer has its own title.
    expect(screen.queryByRole("heading", { name: "Work" })).toBeNull()
  })
})

describe("the work tab", () => {
  it("groups what is open by whom it waits on, each piece once, then what ended, folded", async () => {
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
    expect(groups).toEqual(["owner", "external", "agent", "time", "ended"])
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
    // What ended starts folded, with its count; it opens.
    const ended = within(group("ended")).getByRole("button", { name: /Ended/ })
    expect(ended.getAttribute("aria-expanded")).toBe("false")
    expect(ended.textContent).toContain("1")
    // Its chevron's stroke on the cards' edge, as the other tabs have it.
    expect(ended.querySelector("svg")!.getAttribute("class")).toContain(
      "-ms-[3px]"
    )
    expect(group("ended").textContent).not.toContain("Write the notes")
    fireEvent.click(ended)
    expect(group("ended").textContent).toContain("Write the notes")
    // Each piece of work once.
    for (const title of [
      "Review the login fix",
      "Run the build",
      "Write the notes",
      "Fix the flaky test",
      "Queue the deploy",
    ]) {
      expect(screen.getAllByText(title)).toHaveLength(1)
    }
    // The rail counts what waits on the owner, and says it.
    const tab = screen.getByRole("tab", { name: /Work/ })
    expect(tab.textContent).toBe("1")
    expect(tab.getAttribute("aria-label")).toBe("Work · 1 thing waits for you")
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
    expect(await screen.findByText("Nothing open")).toBeTruthy()
    expect(
      screen.getByRole("tab", { name: /Work/ }).getAttribute("aria-label")
    ).toBe("Work")
  })
})

describe("the status tab", () => {
  it("shows who it is and what it runs on as a card, then how full its context is", async () => {
    usePersonalAgentUi.setState({ auxTab: "status" })
    draw()
    expect(screen.getByText("Nova")).toBeTruthy()
    expect(screen.getByText("Idle")).toBeTruthy()
    // A row per property, as Session Details has them.
    const row = (label: string) =>
      screen.getByText(label, { selector: "dt" }).parentElement!
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
    expect(screen.getByRole("meter").getAttribute("aria-valuenow")).toBe("45")
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

  it("lines its sections up with the card, the run log in words and times", () => {
    usePersonalAgentUi.setState({ auxTab: "status" })
    pa.rows = [
      marker(1, {
        marker: "segment_start",
        agent: "Claude Code",
        reason: "first",
      }),
      marker(2, { marker: "reconnected" }),
    ]
    draw()
    fireEvent.click(screen.getByRole("button", { name: /Run log/ }))
    fireEvent.click(screen.getByRole("button", { name: /Details/ }))
    // Newest first, a line each and when — no icon before it.
    const lines = screen.getAllByRole("listitem")
    expect(lines.map((li) => li.firstElementChild!.textContent)).toEqual([
      "Reconnected to the same session",
      "A new session started on Claude Code (first session)",
    ])
    for (const li of lines) expect(li.querySelector("svg")).toBeNull()
    // Every section's chevron on the card's edge, its body flush with it.
    for (const name of [/Context/, /Run log/, /Details/]) {
      const header = screen.getByRole("button", { name })
      expect(header.firstElementChild!.className).toContain("-ms-[3px]")
      expect(header.firstElementChild!.className).not.toContain("w-7")
      expect(header.closest("section")!.querySelector(".ps-9")).toBeNull()
    }
    // The agent's avatar, a head taller than the two lines beside it.
    const avatar = document.querySelector<HTMLElement>(
      "[data-pa-aux] section [data-slot=assistant-avatar]"
    )!
    expect(avatar.style.width).toBe("2.5rem")
  })

  it("keeps a section folded or open across a switch of tabs", async () => {
    usePersonalAgentUi.setState({ auxTab: "status" })
    draw()
    fireEvent.click(screen.getByRole("button", { name: /Context/ }))
    expect(screen.queryByRole("meter")).toBeNull()
    act(() => usePersonalAgentUi.setState({ auxTab: "work" }))
    act(() => usePersonalAgentUi.setState({ auxTab: "status" }))
    expect(
      screen
        .getByRole("button", { name: /Context/ })
        .getAttribute("aria-expanded")
    ).toBe("false")
    expect(screen.queryByRole("meter")).toBeNull()
  })
})

describe("the stats tab", () => {
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
    draw()
    const card = (await screen.findByText("Last 14 days")).closest("section")!
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
    fireEvent.click(interactions)
    expect(
      document.querySelector("[data-chart='Daily conversation']")
    ).toBeNull()
  })
})
