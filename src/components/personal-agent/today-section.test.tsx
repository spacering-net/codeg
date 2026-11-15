/**
 * "Today" on the primary's details (1.14): its groups, each row under the
 * assistant it is about (or the owner's project), opening what it is about
 * where the owner can act, and the acts on the rows themselves.
 */
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
  PersonalAgentToday,
  RosterEntry,
  TodayRow,
} from "@/lib/types"
import { usePersonalAgentUi } from "@/stores/personal-agent-ui-store"

const api = vi.hoisted(() => ({
  personalAgentItemAct: vi.fn(async () => ({})),
  personalAgentNoticeAct: vi.fn(async () => ({})),
  personalAgentBots: vi.fn(),
  personalAgentToday: vi.fn(),
}))
vi.mock("@/lib/api", () => api)
vi.mock("@/lib/platform", () => ({
  subscribe: () => Promise.resolve(() => {}),
  onTransportReconnect: () => () => {},
}))
const toasts = vi.hoisted(() => ({ error: vi.fn() }))
vi.mock("sonner", () => ({ toast: toasts }))
const tasksView = vi.hoisted(() => ({
  tasks: [] as unknown[],
  refetch: vi.fn(),
}))
vi.mock("@/contexts/tasks-view-context", () => ({
  useTasksView: () => tasksView,
  useOptionalTasksView: () => tasksView,
}))
const dialogs = vi.hoisted(() => ({ openDetail: vi.fn() }))
vi.mock("@/components/tasks/use-task-dialogs", () => ({
  useTaskDialogs: () => ({ openDetail: dialogs.openDetail, dialogs: null }),
}))
const sessions = vi.hoisted(() => ({ open: vi.fn() }))
vi.mock("./session-link", () => ({
  useSessionLinkOpener: () => sessions.open,
}))
const feed = vi.hoisted(() => ({ refresh: vi.fn() }))
vi.mock("@/stores/personal-agent-today-store", () => ({
  refreshToday: feed.refresh,
}))

import {
  __resetRosterForTests,
  usePersonalAgentRoster,
} from "@/stores/personal-agent-roster-store"

import { BriefRows, TodaySection } from "./today-section"

function row(
  patch: Partial<TodayRow> & Pick<TodayRow, "key" | "kind">
): TodayRow {
  return {
    bot_id: null,
    project: null,
    title: "",
    text: null,
    at: new Date(Date.now() - 5 * 60_000).toISOString(),
    state: null,
    row_id: null,
    dispatch_id: null,
    task_id: null,
    conversation_id: null,
    item_id: null,
    notice_id: null,
    agent_type: null,
    undo: false,
    ...patch,
  }
}

function today(patch: Partial<PersonalAgentToday> = {}): PersonalAgentToday {
  return {
    needs: [],
    watching: [],
    schedule: [],
    done: [],
    day_start: "2026-11-10T20:00:00Z",
    day_end: "2026-11-11T20:00:00Z",
    at: "2026-11-11T08:00:00Z",
    dispatches: [],
    ...patch,
  }
}

function entry(
  id: number,
  name: string,
  kind: "primary" | "worker"
): RosterEntry {
  return {
    id,
    kind,
    uid: `u${id}`,
    name,
    avatar: { kind: "face", shape: "blob", color: "blue" },
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
    live: {
      bot_id: id,
      work: "idle",
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
      last_activity_at: null,
      updated_at: "2026-11-11T08:00:00Z",
      expires_at: null,
    },
  } as unknown as RosterEntry
}

function work(patch: Partial<DispatchInfo>): DispatchInfo {
  return {
    id: 1,
    mode: "session",
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
    work_task_id: null,
    conversation_id: 40,
    conversation_folder_id: 2,
    connection_id: null,
    state: "failed",
    result_excerpt: null,
    error: null,
    on_done: null,
    turns: 1,
    created_at: "2026-11-11T07:00:00Z",
    updated_at: "2026-11-11T07:30:00Z",
    finished_at: null,
    ladder: "working",
    task: null,
    answered_for_you: 0,
    ...patch,
  } as DispatchInfo
}

function draw(
  data: PersonalAgentToday | null,
  { inDrawer = false, readOnly = false } = {}
) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <TodaySection
        head={<h3>Today</h3>}
        today={data}
        inDrawer={inDrawer}
        readOnly={readOnly}
      />
    </NextIntlClientProvider>
  )
}

beforeEach(() => {
  __resetRosterForTests()
  api.personalAgentBots.mockResolvedValue([
    entry(1, "Nova", "primary"),
    entry(2, "Dev", "worker"),
  ])
  usePersonalAgentRoster.setState({
    entries: [entry(1, "Nova", "primary"), entry(2, "Dev", "worker")],
  })
  usePersonalAgentUi.setState({
    viewBot: 2,
    pendingJump: null,
    settings: null,
    botPage: null,
    auxOpen: true,
    work: null,
    workOpen: false,
    todayAsked: 0,
    auxFolds: {},
  })
  for (const f of [
    api.personalAgentItemAct,
    api.personalAgentNoticeAct,
    dialogs.openDetail,
    sessions.open,
    feed.refresh,
  ]) {
    f.mockClear()
  }
})

afterEach(() => cleanup())

describe("today", () => {
  it("says nothing needs the owner when every group is empty", () => {
    draw(today())
    expect(screen.getByText("Nothing needs you today")).toBeTruthy()
    expect(document.querySelector("[data-pa-today-group]")).toBeNull()
  })

  it("shows only the groups with something, in order, with how many each holds", () => {
    draw(
      today({
        needs: [
          row({
            key: "session:5",
            kind: "session",
            title: "Auth",
            state: "question",
            conversation_id: 5,
          }),
        ],
        done: [
          row({
            key: "finished:1",
            kind: "finished",
            title: "Docs",
            bot_id: 2,
            dispatch_id: 1,
          }),
        ],
      })
    )
    const groups = [...document.querySelectorAll("[data-pa-today-group]")].map(
      (g) => g.getAttribute("data-pa-today-group")
    )
    expect(groups).toEqual(["needs", "done"])
    const needs = document.querySelector(
      '[data-pa-today-group="needs"]'
    ) as HTMLElement
    expect(within(needs).getByText("Needs you")).toBeTruthy()
    expect(within(needs).getByText("1")).toBeTruthy()
  })

  it("leads each row with its assistant, or the project of the owner's own", () => {
    draw(
      today({
        needs: [
          row({
            key: "card:2:9",
            kind: "approval",
            bot_id: 2,
            row_id: 9,
            title: "git push --force",
          }),
          row({
            key: "session:5",
            kind: "session",
            title: "Explore auth",
            text: "Keep the old API?",
            state: "question",
            conversation_id: 5,
            project: { id: 4, name: "my-app" },
          }),
        ],
      })
    )
    const approval = document.querySelector(
      '[data-key="card:2:9"]'
    ) as HTMLElement
    expect(within(approval).getByText("git push --force")).toBeTruthy()
    expect(approval.textContent).toContain("Needs your approval · Dev")
    const session = document.querySelector(
      '[data-key="session:5"]'
    ) as HTMLElement
    expect(session.textContent).toContain("Asks you · my-app")
    expect(within(session).getByText("Keep the old API?")).toBeTruthy()
    expect(session.querySelector('[title="my-app"]')).toBeTruthy()
  })

  it("opens a card in its assistant's conversation, a session as a tab, a task's sheet, work in the drawer", () => {
    draw(
      today({
        needs: [
          row({
            key: "card:1:9",
            kind: "forwarded",
            bot_id: 1,
            row_id: 9,
            dispatch_id: 1,
            title: "Which?",
          }),
          row({
            key: "session:5",
            kind: "session",
            conversation_id: 5,
            title: "S",
            state: "permission",
          }),
          row({
            key: "task:7",
            kind: "task",
            task_id: 7,
            conversation_id: 70,
            title: "T",
            state: "review",
          }),
          row({
            key: "waiting:2:3",
            kind: "waiting",
            bot_id: 2,
            dispatch_id: 3,
            conversation_id: 30,
            title: "W",
          }),
          row({
            key: "failed:1",
            kind: "failed",
            bot_id: 2,
            dispatch_id: 1,
            conversation_id: 40,
            title: "F",
          }),
        ],
        dispatches: [work({ id: 1 })],
      }),
      { inDrawer: true }
    )
    const open = (key: string) =>
      fireEvent.click(
        within(
          document.querySelector(`[data-key="${key}"]`) as HTMLElement
        ).getAllByRole("button")[0]
      )
    open("card:1:9")
    let ui = usePersonalAgentUi.getState()
    expect(ui.viewBot).toBeNull()
    expect(ui.pendingJump).toEqual({ bot: 1, row: 9 })
    expect(ui.auxOpen).toBe(false)
    open("session:5")
    expect(sessions.open).toHaveBeenCalledWith(5)
    open("task:7")
    expect(dialogs.openDetail).toHaveBeenCalledWith(7)
    open("waiting:2:3")
    expect(sessions.open).toHaveBeenLastCalledWith(30)
    open("failed:1")
    ui = usePersonalAgentUi.getState()
    expect(ui.workOpen).toBe(true)
    expect(ui.work?.dispatchId).toBe(1)
    expect(ui.work?.conversationId).toBe(40)
  })

  it("settles a reminder on its row", async () => {
    draw(
      today({
        needs: [
          row({
            key: "reminder:4",
            kind: "reminder",
            bot_id: 1,
            item_id: 4,
            row_id: 8,
            title: "Stretch",
          }),
        ],
      })
    )
    fireEvent.click(screen.getByRole("button", { name: "Done" }))
    await waitFor(() =>
      expect(api.personalAgentItemAct).toHaveBeenCalledWith(
        1,
        4,
        "done",
        undefined
      )
    )
    await waitFor(() => expect(feed.refresh).toHaveBeenCalled())
  })

  it("takes back a change made for the owner, once", async () => {
    draw(
      today({
        done: [
          row({
            key: "changed:6",
            kind: "changed",
            bot_id: 2,
            notice_id: 6,
            row_id: 11,
            title: "Reply length → short",
            state: "acted",
            undo: true,
          }),
          row({
            key: "changed:5",
            kind: "changed",
            bot_id: 2,
            notice_id: 5,
            row_id: 10,
            title: "Cards → never",
            state: "undone",
          }),
        ],
      })
    )
    const undone = document.querySelector(
      '[data-key="changed:5"]'
    ) as HTMLElement
    expect(undone.textContent).toContain("Changed, then taken back")
    expect(within(undone).queryByRole("button", { name: "Undo" })).toBeNull()
    const acted = document.querySelector(
      '[data-key="changed:6"]'
    ) as HTMLElement
    fireEvent.click(within(acted).getByRole("button", { name: "Undo" }))
    await waitFor(() =>
      expect(api.personalAgentNoticeAct).toHaveBeenCalledWith(6, "undo", 2)
    )
    await waitFor(() => expect(feed.refresh).toHaveBeenCalled())
  })

  it("lists what an assistant remembered, and takes it back (7.7)", async () => {
    draw(
      today({
        done: [
          row({
            key: "memory:8",
            kind: "memory",
            bot_id: 2,
            notice_id: 8,
            row_id: 12,
            title: "Memory updated — new: Release days",
            state: "acted",
            undo: true,
          }),
        ],
      })
    )
    const line = document.querySelector('[data-key="memory:8"]') as HTMLElement
    expect(line.textContent).toContain("Remembered")
    fireEvent.click(within(line).getByRole("button", { name: "Undo" }))
    await waitFor(() =>
      expect(api.personalAgentNoticeAct).toHaveBeenCalledWith(8, "undo", 2)
    )
  })

  it("lists a tidy-up and a process skill with their undo, and a draft to apply or let go (7.7, 7.8)", async () => {
    draw(
      today({
        needs: [
          row({
            key: "tidy:9",
            kind: "tidy",
            bot_id: 2,
            notice_id: 9,
            row_id: 15,
            title: "Tidy-up of 2026-11-14, a draft — 1 new",
            state: "draft",
          }),
          row({
            key: "skill:11",
            kind: "skill",
            bot_id: 2,
            notice_id: 11,
            row_id: 17,
            title: 'Process skill "Release" — a draft to install',
            state: "draft",
          }),
        ],
        done: [
          row({
            key: "tidy:8",
            kind: "tidy",
            bot_id: 2,
            notice_id: 8,
            row_id: 14,
            title: "Tidied memory (2026-11-13) — 1 updated",
            state: "acted",
            undo: true,
          }),
          row({
            key: "skill:10",
            kind: "skill",
            bot_id: 2,
            notice_id: 10,
            row_id: 16,
            title: 'Process skill "Release" — learned, followed next time',
            state: "acted",
            undo: true,
          }),
        ],
      })
    )
    const tidied = document.querySelector('[data-key="tidy:8"]') as HTMLElement
    expect(tidied.textContent).toContain("Tidied up memory")
    fireEvent.click(within(tidied).getByRole("button", { name: "Undo" }))
    await waitFor(() =>
      expect(api.personalAgentNoticeAct).toHaveBeenCalledWith(8, "undo", 2)
    )
    const learned = document.querySelector(
      '[data-key="skill:10"]'
    ) as HTMLElement
    expect(learned.textContent).toContain("Process skill")
    expect(within(learned).getByRole("button", { name: "Undo" })).toBeTruthy()
    const draft = document.querySelector('[data-key="tidy:9"]') as HTMLElement
    expect(draft.textContent).toContain("Tidy-up waiting for you")
    expect(within(draft).queryByRole("button", { name: "Undo" })).toBeNull()
    fireEvent.click(within(draft).getByRole("button", { name: "Apply" }))
    await waitFor(() =>
      expect(api.personalAgentNoticeAct).toHaveBeenCalledWith(9, "apply", 2)
    )
    const skill = document.querySelector('[data-key="skill:11"]') as HTMLElement
    expect(skill.textContent).toContain("Process skill waiting for you")
    fireEvent.click(within(skill).getByRole("button", { name: "Not this one" }))
    await waitFor(() =>
      expect(api.personalAgentNoticeAct).toHaveBeenCalledWith(11, "dismiss", 2)
    )
    expect(within(skill).getByRole("button", { name: "Install" })).toBeTruthy()
  })

  it("lists what an assistant did on a forge, opening its card (7.4)", () => {
    draw(
      today({
        done: [
          row({
            key: "forge:8",
            kind: "forge",
            bot_id: 2,
            notice_id: 8,
            row_id: 14,
            title: "Merge acme/app#9",
            state: "acted",
          }),
        ],
      })
    )
    const done = document.querySelector('[data-key="forge:8"]') as HTMLElement
    expect(done.textContent).toContain("Merge acme/app#9")
    expect(done.textContent).toContain("Done on a forge")
    expect(within(done).queryByRole("button", { name: "Undo" })).toBeNull()
    fireEvent.click(within(done).getAllByRole("button")[0])
    expect(usePersonalAgentUi.getState().pendingJump).toEqual({
      bot: 2,
      row: 14,
    })
  })

  it("acts on nothing where the assistants run elsewhere", () => {
    draw(
      today({
        needs: [
          row({
            key: "reminder:4",
            kind: "reminder",
            bot_id: 1,
            item_id: 4,
            title: "Stretch",
          }),
        ],
        done: [
          row({
            key: "changed:6",
            kind: "changed",
            bot_id: 2,
            notice_id: 6,
            undo: true,
            state: "acted",
          }),
        ],
      }),
      { readOnly: true }
    )
    expect(screen.queryByRole("button", { name: "Done" })).toBeNull()
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull()
  })

  it("shows the first rows of a long group, then all on asking", () => {
    const many = Array.from({ length: 10 }, (_, i) =>
      row({
        key: `session:${i}`,
        kind: "session",
        conversation_id: i,
        title: `S${i}`,
        state: "question",
      })
    )
    draw(today({ needs: many }))
    expect(document.querySelectorAll("[data-pa-today-row]")).toHaveLength(8)
    fireEvent.click(screen.getByRole("button", { name: "Show 2 more" }))
    expect(document.querySelectorAll("[data-pa-today-row]")).toHaveLength(10)
  })

  it("says when the rest of the day's matters are due", () => {
    draw(
      today({
        schedule: [
          row({
            key: "item:3",
            kind: "item",
            bot_id: 1,
            item_id: 3,
            row_id: 2,
            title: "Call the bank",
            at: "2026-11-11T09:30:00Z",
            state: "reminder:notify",
          }),
          row({
            key: "item:4",
            kind: "item",
            bot_id: 2,
            item_id: 4,
            title: "Check CI",
            at: "2026-11-11T10:00:00Z",
            state: "followup:act",
          }),
        ],
      })
    )
    const time = (iso: string) =>
      new Date(iso).toLocaleTimeString("en", {
        hour: "2-digit",
        minute: "2-digit",
      })
    expect(
      document.querySelector('[data-key="item:3"]')?.textContent
    ).toContain(`Reminder at ${time("2026-11-11T09:30:00Z")}`)
    expect(
      document.querySelector('[data-key="item:4"]')?.textContent
    ).toContain(`Does it at ${time("2026-11-11T10:00:00Z")}`)
  })

  it("settles a matter still to come on its row, and opens its assistant when it has no message", async () => {
    draw(
      today({
        schedule: [
          row({
            key: "item:4",
            kind: "item",
            bot_id: 2,
            item_id: 4,
            title: "Check CI",
            at: "2026-11-11T10:00:00Z",
            state: "followup:act",
          }),
        ],
      })
    )
    const card = document.querySelector('[data-key="item:4"]') as HTMLElement
    fireEvent.click(within(card).getAllByRole("button")[0])
    const ui = usePersonalAgentUi.getState()
    expect(ui.viewBot).toBe(2)
    expect(ui.pendingJump).toBeNull()
    fireEvent.click(within(card).getByRole("button", { name: "Done" }))
    await waitFor(() =>
      expect(api.personalAgentItemAct).toHaveBeenCalledWith(
        2,
        4,
        "done",
        undefined
      )
    )
  })

  it("comes into view when the primary's pill asks for it", () => {
    const scroll = vi.fn()
    Element.prototype.scrollIntoView = scroll
    draw(today())
    expect(scroll).not.toHaveBeenCalled()
    act(() => usePersonalAgentUi.getState().showToday())
    expect(scroll).toHaveBeenCalled()
    const ui = usePersonalAgentUi.getState()
    expect([ui.auxOpen, ui.auxTab]).toEqual([true, "activity"])
  })
})

describe("the morning brief (6.4)", () => {
  it("says while it is being prepared", () => {
    draw(
      today({
        brief: { id: 1, kind: "brief", state: "preparing", row_id: null },
      })
    )
    expect(screen.getByText("Preparing your morning brief…")).toBeTruthy()
    expect(screen.getByText("Nothing needs you today")).toBeTruthy()
  })

  it("opens what a brief's rows are about, as today's do", () => {
    render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <BriefRows
          rows={[
            row({
              key: "task:7",
              kind: "task",
              title: "Ship it",
              task_id: 7,
              state: "review",
            }),
          ]}
          dispatches={[]}
        />
      </NextIntlClientProvider>
    )
    fireEvent.click(screen.getByText("Ship it"))
    expect(dialogs.openDetail).toHaveBeenCalledWith(7)
    // Nothing is settled from a brief.
    expect(screen.queryByRole("button", { name: "Done" })).toBe(null)
  })
})
