/**
 * The activity's list (C1–C5): its four groups, each row under the
 * assistant it is about (or the owner's project), opening what it is about
 * where the owner can act, the acts on the rows themselves, what a row
 * unfolds to, and a row asked for brought into view; and a morning brief's
 * rows, drawn as "today"'s are.
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
  ActivityGroups,
  ActivityRow,
  DispatchInfo,
  ItemInfo,
  PersonalAgentActivity,
  PersonalAgentToday,
  Routine,
  RosterEntry,
  TodayRow,
} from "@/lib/types"
import { usePersonalAgentUi } from "@/stores/personal-agent-ui-store"

const api = vi.hoisted(() => ({
  personalAgentItemAct: vi.fn(async () => ({
    item: null,
    undo: null,
    withdrawn: null,
  })),
  personalAgentNoticeAct: vi.fn(async () => ({})),
  personalAgentItemUndo: vi.fn(async () => ({})),
  personalAgentBots: vi.fn(),
  personalAgentToday: vi.fn(),
  personalAgentCancelTurn: vi.fn(async () => true),
  personalAgentWorkRetry: vi.fn(async () => ({})),
  personalAgentDispatchHand: vi.fn(async () => undefined),
  personalAgentPrMerge: vi.fn(async () => ({ outcome: "merging" })),
  personalAgentMessageNudge: vi.fn(async () => true),
  personalAgentRespondPermission: vi.fn(async () => undefined),
  personalAgentAnswerQuestion: vi.fn(async () => undefined),
  personalAgentAnswerPlan: vi.fn(async () => undefined),
  personalAgentAskAnswer: vi.fn(async () => ({ state: "answered", text: "" })),
  personalAgentChoiceAnswer: vi.fn(async () => ({})),
  acpRespondPermission: vi.fn(async () => undefined),
  acpAnswerQuestion: vi.fn(async () => undefined),
  acpAnswerPlanApproval: vi.fn(async () => undefined),
  openSettingsWindow: vi.fn(async () => undefined),
}))
vi.mock("@/lib/api", () => api)
vi.mock("@/lib/platform", () => ({
  subscribe: () => Promise.resolve(() => {}),
  onTransportReconnect: () => () => {},
}))
const toasts = vi.hoisted(() => ({
  error: vi.fn(),
  message: vi.fn(),
  success: vi.fn(),
}))
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
vi.mock("@/stores/personal-agent-activity-store", () => ({
  refreshActivity: feed.refresh,
}))
// The primary's page: its real id 1.
vi.mock("@/contexts/personal-agent-context", () => ({
  useBotId: () => null,
  usePersonalAgent: () => ({ botId: null, snapshot: { agent: { id: 1 } } }),
}))

import {
  __resetRosterForTests,
  usePersonalAgentRoster,
} from "@/stores/personal-agent-roster-store"

import { ActivityList } from "./aux-parts/activity/activity-tab"
import { BriefRows } from "./today-section"
import { clearSettling } from "./aux-parts/activity/act-settle"
import {
  __resetLeavingForTests,
  LEAVE_COOL_MS,
} from "@/stores/personal-agent-activity-leaving-store"

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
    avatar: { kind: "face", shape: "ring", color: "blue" },
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
    work: {
      name: "Dev",
      bot_uid: "u2",
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

/** "Today"'s row of a thing, as the activity lists it: the matter it
 *  stands for with it, when it has one. */
function thing(r: TodayRow, patch: Partial<ActivityRow> = {}): ActivityRow {
  return {
    key: r.key,
    bot_id: r.bot_id,
    thing: r.key,
    today: r,
    item: null,
    routine: null,
    card_row_id: null,
    ...patch,
  }
}

function matter(patch: Partial<ItemInfo> & Pick<ItemInfo, "id">): ItemInfo {
  return {
    kind: "reminder",
    dispatch_id: null,
    status: "open",
    waits_for: "owner",
    summary: "",
    on_done: null,
    origin_timeline_id: null,
    created_at: "2026-11-11T07:00:00Z",
    updated_at: "2026-11-11T07:30:00Z",
    dispatch_state: null,
    due_at: null,
    repeat: null,
    at_due: null,
    act_spec: null,
    fired_at: null,
    ...patch,
  } as ItemInfo
}

/** The activity of "today"'s groups — its schedule what comes next — and
 *  rows of its own (`extra`) after them. */
function activityOf(
  data: PersonalAgentToday,
  extra: Partial<
    Record<"needs" | "watching" | "next" | "done", ActivityRow[]>
  > = {}
): PersonalAgentActivity {
  const needs = [...data.needs.map((r) => thing(r)), ...(extra.needs ?? [])]
  return {
    needs,
    watching: [
      ...data.watching.map((r) => thing(r)),
      ...(extra.watching ?? []),
    ],
    next: [...data.schedule.map((r) => thing(r)), ...(extra.next ?? [])],
    done: [...data.done.map((r) => thing(r)), ...(extra.done ?? [])],
    waiting: needs.length,
    pill: {
      count: data.needs.length,
      first: data.needs[0]?.key ?? null,
    },
    brief: data.brief ?? null,
    stale_acceptance: data.stale_acceptance ?? [],
    dispatches: data.dispatches,
    day_start: data.day_start,
    day_end: data.day_end,
    as_of: data.at,
  }
}

function draw(
  data: PersonalAgentToday | PersonalAgentActivity | null,
  { inDrawer = false, readOnly = false, at = 1 } = {}
) {
  const view =
    data == null ? null : "schedule" in data ? activityOf(data) : data
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <ActivityList
        read={view ? { bot: null, view, at } : null}
        inDrawer={inDrawer}
        readOnly={readOnly}
        openTask={dialogs.openDetail}
      />
    </NextIntlClientProvider>
  )
}

beforeEach(() => {
  clearSettling()
  __resetLeavingForTests()
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
    activityAsk: null,
    activityOpen: {},
    routineEditor: null,
    // Done today starts folded (C2): open here, to look at its rows.
    auxFolds: { "activity.done": true },
  })
  for (const f of [
    api.personalAgentItemAct,
    api.personalAgentNoticeAct,
    dialogs.openDetail,
    sessions.open,
    feed.refresh,
    toasts.message,
  ]) {
    f.mockClear()
  }
})

afterEach(() => cleanup())

describe("the activity's list", () => {
  it("is one row when every group is empty, with the way to make a routine (C5)", () => {
    draw(today())
    expect(
      screen.getByText("Nothing for you to do, and nothing running.")
    ).toBeTruthy()
    expect(document.querySelector("[data-pa-activity-group]")).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "New routine" }))
    expect(usePersonalAgentUi.getState().routineEditor?.routineId).toBeNull()
    cleanup()
    draw(today(), { readOnly: true })
    expect(screen.queryByRole("button", { name: "New routine" })).toBeNull()
  })

  it("says what a task waits on the owner for, with the button that does it", () => {
    draw(
      today({
        needs: [
          row({
            key: "task:7",
            kind: "task",
            title: "Fix title",
            task_id: 7,
            state: "review",
            reason: "merge_ready",
          }),
          row({
            key: "task:8",
            kind: "task",
            title: "PR fix",
            task_id: 8,
            state: "review",
            reason: "needs_delivery",
          }),
          row({
            key: "task:9",
            kind: "task",
            title: "Own",
            task_id: 9,
            state: "review",
            reason: "review",
          }),
        ],
        watching: [
          row({
            key: "task:10",
            kind: "task",
            title: "Queued",
            task_id: 10,
            state: "review",
            reason: "accepted_queued",
          }),
        ],
      })
    )
    const inRow = (key: string) =>
      within(document.querySelector(`[data-key="${key}"]`) as HTMLElement)
    expect(inRow("task:7").getByText("Accepted — ready to merge")).toBeTruthy()
    fireEvent.click(inRow("task:7").getByRole("button", { name: "Merge…" }))
    expect(dialogs.openDetail).toHaveBeenLastCalledWith(7)
    expect(
      inRow("task:8").getByRole("button", { name: "Open on the board" })
    ).toBeTruthy()
    expect(inRow("task:9").getByRole("button", { name: "Review" })).toBeTruthy()
    // Queued: said, nothing to press.
    expect(
      inRow("task:10").getByText("Accepted — queued to merge")
    ).toBeTruthy()
    expect(
      document.querySelector('[data-key="task:10"] [data-pa-today-act]')
    ).toBeNull()
  })

  it("says failed work its assistant is looking at is theirs for now", () => {
    draw(
      today({
        watching: [
          row({
            key: "failed:4",
            kind: "failed",
            title: "Docs",
            bot_id: 2,
            dispatch_id: 4,
            reason: "looking",
            text: "worktree add failed",
          }),
        ],
      })
    )
    const el = document.querySelector('[data-key="failed:4"]') as HTMLElement
    expect(el.textContent).toMatch(/Didn’t work out — .+ is looking at it/)
    expect(el.textContent).not.toContain("worktree add failed")
  })

  it("opens failed work that never had a session at its result card", () => {
    draw(
      today({
        needs: [
          row({
            key: "failed:3",
            kind: "failed",
            title: "Docs",
            bot_id: 1,
            dispatch_id: 3,
            row_id: 44,
            reason: "failed",
            text: "worktree add failed",
          }),
        ],
      })
    )
    fireEvent.click(
      within(
        document.querySelector('[data-key="failed:3"]') as HTMLElement
      ).getAllByRole("button")[0]
    )
    expect(usePersonalAgentUi.getState().pendingJump).toEqual({
      bot: 1,
      row: 44,
    })
  })

  it("names a check of a message as one, and a stopped one as stopped", () => {
    draw(
      today({
        done: [
          row({
            key: "checked:1",
            kind: "checked",
            title: "Claim A",
            bot_id: 2,
            dispatch_id: 1,
            state: "completed",
          }),
          row({
            key: "checked:2",
            kind: "checked",
            title: "Claim B",
            bot_id: 2,
            dispatch_id: 2,
            state: "canceled",
          }),
        ],
      })
    )
    expect(screen.getByText("Checked a message")).toBeTruthy()
    expect(screen.getByText("Message check stopped")).toBeTruthy()
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
    const groups = [
      ...document.querySelectorAll("[data-pa-activity-group]"),
    ].map((g) => g.getAttribute("data-pa-activity-group"))
    expect(groups).toEqual(["needs", "done"])
    const needs = document.querySelector(
      '[data-pa-activity-group="needs"]'
    ) as HTMLElement
    expect(within(needs).getByText("Needs you")).toBeTruthy()
    expect(within(needs).getByText("1")).toBeTruthy()
    // One card: its head the bar across its top, the chevron at its end;
    // its rows on one list, flat on the card.
    expect(needs.className).toContain("rounded-2xl")
    const head = within(needs).getByRole("button", { name: /Needs you/ })
    expect(head.className).toMatch(/(^| )w-full( |$)/)
    expect(head.lastElementChild!.getAttribute("class")).toContain(
      "lucide-chevron-down"
    )
    const list = within(needs).getByRole("list")
    const items = within(list).getAllByRole("listitem")
    expect(items).toHaveLength(1)
    expect(items[0].className).toContain("rounded-none")
  })

  it("keeps what was done today to one line until opened, no routine that found nothing in it (C2)", () => {
    usePersonalAgentUi.setState({ auxFolds: {} })
    draw(
      today({
        done: [
          row({
            key: "finished:1",
            kind: "finished",
            title: "Docs",
            bot_id: 2,
            dispatch_id: 1,
          }),
          row({
            key: "finished:2",
            kind: "finished",
            title: "Notes",
            bot_id: 2,
            dispatch_id: 2,
          }),
          row({
            key: "routine_report:3",
            kind: "routine_report",
            title: "Night CI",
            bot_id: 1,
            state: "silent",
          }),
        ],
      })
    )
    const done = document.querySelector(
      '[data-pa-activity-group="done"]'
    ) as HTMLElement
    const head = within(done).getByRole("button", { name: /Done today/ })
    expect(head.getAttribute("aria-expanded")).toBe("false")
    expect(within(done).getByText("2")).toBeTruthy()
    expect(screen.queryByText("Docs")).toBeNull()
    fireEvent.click(head)
    expect(screen.getByText("Docs")).toBeTruthy()
    expect(screen.queryByText("Night CI")).toBeNull()
    // Opened, it stays so, and the line stays where it was.
    expect(usePersonalAgentUi.getState().auxFolds["activity.done"]).toBe(true)
  })

  it("draws a row with something to say or settle as a card, a plain one as a row", () => {
    draw(
      today({
        needs: [
          row({
            key: "session:5",
            kind: "session",
            title: "Explore auth",
            text: "Keep the old API?",
            state: "question",
            conversation_id: 5,
          }),
          row({
            key: "failed:3",
            kind: "failed",
            title: "Fix CI",
            text: "worktree add failed: Branch already exists",
            bot_id: 2,
            dispatch_id: 3,
          }),
        ],
        watching: [
          row({
            key: "dispatch:4",
            kind: "dispatch",
            title: "Docs",
            bot_id: 2,
          }),
          row({
            key: "dispatch:5",
            kind: "dispatch",
            title: "Notes",
            bot_id: 2,
          }),
        ],
        done: [
          row({
            key: "changed:1",
            kind: "changed",
            title: "Muted Dev",
            bot_id: 2,
            notice_id: 8,
            undo: true,
          }),
        ],
      })
    )
    const shape = (title: string) =>
      screen
        .getByText(title)
        .closest("[data-slot='item']")
        ?.getAttribute("data-pa-shape")
    // What waits on the owner says it in a box — red and in the code face
    // when it failed.
    expect(shape("Explore auth")).toBe("card")
    const asked = screen.getByText("Keep the old API?")
    expect(
      asked.closest("[data-pa-callout]")?.getAttribute("data-pa-callout")
    ).toBe("wait")
    const failed = screen.getByText(
      "worktree add failed: Branch already exists"
    )
    const box = failed.closest("[data-pa-callout]")!
    expect(box.getAttribute("data-pa-callout")).toBe("error")
    // The assistant's own words, not an error's text: not in the code face.
    expect(box.className).not.toContain("font-mono")
    // Plain ones are rows, one after another; one to take back keeps its
    // one button at its end, a row still.
    expect(shape("Docs")).toBe("row")
    expect(shape("Notes")).toBe("row")
    expect(shape("Muted Dev")).toBe("row")
    expect(screen.getByRole("button", { name: "Undo" })).toBeTruthy()
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

  it("says what an act did, with [Undo] that takes it back (C1)", async () => {
    api.personalAgentItemAct.mockResolvedValueOnce({
      item: matter({ id: 4, summary: "Stretch", status: "done" }),
      undo: 55,
      withdrawn: null,
    } as never)
    const r = row({
      key: "reminder:4",
      kind: "reminder",
      bot_id: 1,
      item_id: 4,
      row_id: 8,
      title: "Stretch",
    })
    draw(
      activityOf(today(), {
        needs: [
          thing(r, {
            thing: "item:4",
            item: matter({ id: 4, summary: "Stretch", origin_timeline_id: 3 }),
          }),
        ],
      })
    )
    const el = document.querySelector('[data-key="reminder:4"]') as HTMLElement
    fireEvent.click(within(el).getByRole("button", { name: "Done" }))
    await waitFor(() => expect(toasts.success).toHaveBeenCalled())
    const calls = toasts.success.mock.calls
    const [text, opts] = calls[calls.length - 1] as [
      string,
      { action?: { label: string; onClick: () => void } },
    ]
    expect(text).toBe("Done: Stretch")
    expect(opts.action?.label).toBe("Undo")
    opts.action!.onClick()
    await waitFor(() =>
      expect(api.personalAgentItemUndo).toHaveBeenCalledWith(1, 4, 55)
    )
  })

  it("lists a matter settled today with who did it, and [Undo] while it can be", async () => {
    const at = "2026-11-11T09:05:00Z"
    draw(
      activityOf(today(), {
        done: [
          thing(
            row({
              key: "matter_closed:9",
              kind: "matter_closed",
              bot_id: 1,
              item_id: 9,
              row_id: 12,
              title: "Pay rent",
              at,
              state: "reminder",
              closed_by: "owner",
              closed_how: "done",
              matter_undo: 77,
            })
          ),
          thing(
            row({
              key: "matter_closed:11",
              kind: "matter_closed",
              bot_id: 1,
              item_id: 11,
              title: "Investigate the crash",
              at,
              state: "dispatch",
              closed_by: "owner",
              closed_how: "dropped",
              matter_undo: 78,
            })
          ),
          thing(
            row({
              key: "matter_closed:10",
              kind: "matter_closed",
              bot_id: 1,
              item_id: 10,
              title: "Waiting for Dev's answer: review it",
              written: "review it",
              direction: "out",
              at,
              state: "message",
              closed_by: "codeg",
              closed_how: "replied",
              peer: { id: 2, name: "Dev", avatar: null, gone: false },
            })
          ),
        ],
      })
    )
    const time = new Date(at).toLocaleTimeString("en", {
      hour: "2-digit",
      minute: "2-digit",
    })
    const mine = document.querySelector(
      '[data-pa-activity-row="matter_closed:9"]'
    ) as HTMLElement
    expect(mine.textContent).toContain(`You did it · ${time}`)
    // Failed work the owner closed: given up, not done — and undoable.
    const givenUp = document.querySelector(
      '[data-pa-activity-row="matter_closed:11"]'
    ) as HTMLElement
    expect(givenUp.textContent).toContain(`You gave up on this work · ${time}`)
    expect(within(givenUp).getByRole("button", { name: "Undo" })).toBeTruthy()
    const replied = document.querySelector(
      '[data-pa-activity-row="matter_closed:10"]'
    ) as HTMLElement
    expect(replied.textContent).toContain(`Dev replied · ${time}`)
    expect(within(replied).getByText("review it")).toBeTruthy()
    expect(within(replied).queryByRole("button", { name: "Undo" })).toBeNull()
    fireEvent.click(within(mine).getByRole("button", { name: "Undo" }))
    await waitFor(() =>
      expect(api.personalAgentItemUndo).toHaveBeenCalledWith(1, 9, 77)
    )
    await waitFor(() => expect(toasts.success).toHaveBeenCalledWith("Undone"))
  })

  it("settles a reminder on its row, its matter folded in", async () => {
    const r = row({
      key: "reminder:4",
      kind: "reminder",
      bot_id: 1,
      item_id: 4,
      row_id: 8,
      title: "Stretch",
    })
    draw(
      activityOf(today(), {
        needs: [
          thing(r, {
            thing: "item:4",
            item: matter({ id: 4, summary: "Stretch", origin_timeline_id: 3 }),
          }),
        ],
      })
    )
    const el = document.querySelector('[data-key="reminder:4"]') as HTMLElement
    fireEvent.click(within(el).getByRole("button", { name: "Done" }))
    await waitFor(() =>
      expect(api.personalAgentItemAct).toHaveBeenCalledWith(
        1,
        4,
        "done",
        undefined,
        "panel",
        "2026-11-11T07:30:00Z"
      )
    )
    await waitFor(() => expect(feed.refresh).toHaveBeenCalled())
    // Its [Put off] too: the matter's whole menu (its own tests elsewhere).
    expect(within(el).getByRole("button", { name: "Put off" })).toBeTruthy()
    // The row opens the message it came from; its card unfolded.
    fireEvent.click(within(el).getAllByRole("button")[0])
    expect(usePersonalAgentUi.getState().pendingJump).toEqual({
      bot: 1,
      row: 3,
    })
    fireEvent.click(within(el).getByRole("button", { name: "Show details" }))
    fireEvent.click(
      within(el).getByRole("button", { name: "View the reminder" })
    )
    expect(usePersonalAgentUi.getState().pendingJump).toEqual({
      bot: 1,
      row: 8,
    })
  })

  it("says a reminder handed to its assistant is theirs, a task under check its round, a merge queued", () => {
    draw(
      today({
        needs: [
          row({
            key: "acceptance:5",
            kind: "acceptance",
            bot_id: 2,
            row_id: 50,
            task_id: 7,
            dispatch_id: 5,
            title: "Fix title",
            queued: true,
          }),
        ],
        watching: [
          row({
            key: "reminder:4",
            kind: "reminder",
            bot_id: 2,
            item_id: 4,
            row_id: 8,
            state: "handed",
            title: "Stretch",
          }),
          row({
            key: "task:9",
            kind: "task",
            task_id: 9,
            state: "checking",
            check_dispatch_id: 12,
            round: 2,
            title: "Docs",
          }),
        ],
        dispatches: [work({ id: 12, mode: "session", conversation_id: 70 })],
      })
    )
    expect(
      document.querySelector('[data-key="reminder:4"]')!.textContent
    ).toContain("Handed to Dev")
    const task = document.querySelector('[data-key="task:9"]') as HTMLElement
    expect(task.textContent).toContain("Being checked · round 2")
    // Its check's session, unfolded.
    fireEvent.click(within(task).getByRole("button", { name: "Show details" }))
    fireEvent.click(
      within(task).getByRole("button", { name: "View the acceptance session" })
    )
    expect(usePersonalAgentUi.getState().work?.dispatchId).toBe(12)
    const acceptance = document.querySelector(
      '[data-key="acceptance:5"]'
    ) as HTMLElement
    expect(acceptance.textContent).toContain("queued to merge")
    // Its board task, unfolded: the row itself opens the card.
    fireEvent.click(
      within(acceptance).getByRole("button", { name: "Show details" })
    )
    fireEvent.click(
      within(acceptance).getByRole("button", { name: "Open the task" })
    )
    expect(dialogs.openDetail).toHaveBeenLastCalledWith(7)
  })

  it("lists a matter with no row of today on its own, its assistant's, waiting on it", () => {
    draw(
      activityOf(today(), {
        watching: [
          {
            key: "item:6",
            bot_id: 2,
            thing: "item:6",
            today: null,
            item: matter({
              id: 6,
              kind: "followup",
              waits_for: "agent",
              summary: "Chase the vendor",
            }),
            routine: null,
            card_row_id: null,
          },
        ],
      })
    )
    const el = document.querySelector('[data-pa-activity-row="item:6"]')!
    // Who has it and how long — not its kind's name.
    expect(el.textContent).toContain("Dev is following up · ")
    expect(el.textContent).not.toContain("follow-up")
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

  it("words a changed setting as its card does, not by its key", async () => {
    draw(
      today({
        done: [
          row({
            key: "changed:7",
            kind: "changed",
            bot_id: 2,
            notice_id: 7,
            title: "prefs.reply_length medium → short",
            state: "acted",
            changes: {
              changes: [
                { key: "prefs.reply_length", from: "medium", to: "short" },
              ],
              names: {},
            },
          }),
          row({
            key: "changed:8",
            kind: "changed",
            bot_id: 2,
            notice_id: 8,
            title: "bot.ab12.persona …",
            state: "acted",
            changes: {
              changes: [
                {
                  key: "bot.ab12.persona",
                  from: "",
                  to: "I look things up and say what I found.",
                },
              ],
              names: { "bot:ab12": "Goose" },
            },
          }),
        ],
      })
    )
    const prefs = document.querySelector(
      '[data-key="changed:7"]'
    ) as HTMLElement
    expect(prefs.textContent).toContain("Reply length: Medium → Short")
    expect(prefs.textContent).not.toContain("prefs.reply_length")
    const persona = document.querySelector(
      '[data-key="changed:8"]'
    ) as HTMLElement
    // A work assistant's item by its name, its persona in a line.
    expect(persona.textContent).toContain(
      "Goose · persona: (empty) → I look things up and say what I found."
    )
    expect(persona.textContent).not.toContain("bot.ab12")
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
    const r = row({
      key: "reminder:4",
      kind: "reminder",
      bot_id: 1,
      item_id: 4,
      title: "Stretch",
    })
    draw(
      activityOf(
        today({
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
        { needs: [thing(r, { item: matter({ id: 4 }) })] }
      ),
      { readOnly: true }
    )
    expect(screen.queryByRole("button", { name: "Done" })).toBeNull()
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull()
    expect(screen.queryByRole("button", { name: "New routine" })).toBeNull()
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
    const r = row({
      key: "item:4",
      kind: "item",
      bot_id: 2,
      item_id: 4,
      title: "Check CI",
      at: "2026-11-11T10:00:00Z",
      state: "followup:act",
    })
    draw(
      activityOf(today(), {
        next: [
          thing(r, {
            item: matter({ id: 4, kind: "followup", waits_for: "time" }),
          }),
        ],
      })
    )
    const card = document.querySelector('[data-key="item:4"]') as HTMLElement
    fireEvent.click(within(card).getAllByRole("button")[0])
    const ui = usePersonalAgentUi.getState()
    expect(ui.viewBot).toBe(2)
    expect(ui.pendingJump).toBeNull()
    // Set aside with no time: a time can be set, or it is not needed.
    expect(
      within(card).getByRole("button", { name: "Set a time" })
    ).toBeTruthy()
    fireEvent.click(within(card).getByRole("button", { name: "Not needed" }))
    await waitFor(() =>
      expect(api.personalAgentItemAct).toHaveBeenCalledWith(
        2,
        4,
        "drop",
        undefined,
        "panel",
        "2026-11-11T07:30:00Z"
      )
    )
  })

  it("brings the first of what waits into view when the pill asks, shown whole when it is further down (C6)", async () => {
    const scroll = vi.fn()
    Element.prototype.scrollIntoView = scroll
    const many = Array.from({ length: 10 }, (_, i) =>
      row({
        key: `session:${i}`,
        kind: "session",
        conversation_id: i,
        title: `S${i}`,
        state: "question",
      })
    )
    usePersonalAgentUi.setState({ viewBot: null })
    draw(today({ needs: many }))
    expect(scroll).not.toHaveBeenCalled()
    act(() => usePersonalAgentUi.getState().showWaiting("session:9"))
    await waitFor(() => expect(scroll).toHaveBeenCalled())
    expect(document.querySelectorAll("[data-pa-today-row]")).toHaveLength(10)
    expect(
      (scroll.mock.contexts[0] as HTMLElement).getAttribute(
        "data-pa-activity-row"
      )
    ).toBe("session:9")
    const ui = usePersonalAgentUi.getState()
    expect([ui.auxOpen, ui.auxTab, ui.activityAsk]).toEqual([
      true,
      "activity",
      null,
    ])
    // Asked again: again.
    scroll.mockClear()
    act(() => usePersonalAgentUi.getState().showWaiting("session:1"))
    await waitFor(() => expect(scroll).toHaveBeenCalled())
  })

  it("opens a routine asked for at its row, once read since; one not there was deleted (C4)", async () => {
    const scroll = vi.fn()
    Element.prototype.scrollIntoView = scroll
    usePersonalAgentUi.setState({ viewBot: null })
    const night: Routine = {
      id: 5,
      bot_id: 1,
      title: "Night CI",
      what: "Look at CI",
      kind: "brain",
      trigger: "schedule",
      cron: "0 9 * * *",
      timezone: null,
      zone: "UTC",
      event: null,
      dispatch: null,
      precheck: null,
      enabled: true,
      paused_reason: null,
      source: "owner",
      next_run_at: "2026-11-13T09:00:00Z",
      last_run_at: null,
      runs: 0,
      failures: 0,
      created_at: "2026-11-10T09:00:00Z",
      last: [],
    } as unknown as Routine
    const view = activityOf(today(), {
      next: [
        {
          key: "routine:5",
          bot_id: 1,
          thing: "routine:5",
          today: null,
          item: null,
          routine: night,
          card_row_id: null,
        },
      ],
    })
    // Read before it was asked: read again first.
    const { rerender } = draw(view, { at: 0 })
    act(() => usePersonalAgentUi.getState().showRoutines(5))
    await waitFor(() => expect(feed.refresh).toHaveBeenCalled())
    expect(scroll).not.toHaveBeenCalled()
    const asked = usePersonalAgentUi.getState().activityAsk!
    rerender(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <ActivityList
          read={{ bot: null, view, at: asked.at + 1 }}
          inDrawer={false}
          readOnly={false}
          openTask={dialogs.openDetail}
        />
      </NextIntlClientProvider>
    )
    await waitFor(() => expect(scroll).toHaveBeenCalled())
    // Nothing to unfold: its row says it all.
    expect(document.querySelector('[data-pa-routine="5"]')).toBeTruthy()
    expect(usePersonalAgentUi.getState().activityOpen["routine:5"]).toBe(
      undefined
    )
    expect(toasts.message).not.toHaveBeenCalled()
    // One not in a list read since: deleted, its group's head shown.
    act(() => usePersonalAgentUi.getState().showRoutines(99))
    const again = usePersonalAgentUi.getState().activityAsk!
    rerender(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <ActivityList
          read={{ bot: null, view, at: again.at + 1 }}
          inDrawer={false}
          readOnly={false}
          openTask={dialogs.openDetail}
        />
      </NextIntlClientProvider>
    )
    await waitFor(() =>
      expect(toasts.message).toHaveBeenCalledWith(
        "This routine has been deleted."
      )
    )
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
    // Being written: not "nothing at all".
    expect(
      screen.queryByText("Nothing for you to do, and nothing running.")
    ).toBeNull()
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

  it("draws a brief's rows as its card's other rows, what they say a note", () => {
    render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <BriefRows
          rows={[
            row({
              key: "failed:3",
              kind: "failed",
              title: "Fix CI",
              text: "it broke",
              bot_id: 2,
            }),
          ]}
          dispatches={[]}
        />
      </NextIntlClientProvider>
    )
    const item = screen.getByText("Fix CI").closest("[data-slot='item']")!
    expect(item.hasAttribute("data-pa-shape")).toBe(false)
    // No surface of its own on the brief's card: a row of a list, a
    // hairline over it.
    expect(item.getAttribute("data-variant")).toBe("default")
    expect(item.getAttribute("role")).toBe("listitem")
    expect(item.parentElement?.hasAttribute("data-pa-brief-rows")).toBe(true)
    expect(document.querySelector("[data-pa-callout]")).toBeNull()
    expect(screen.getByText("it broke")).toBeTruthy()
  })
})

describe("the five groups (5.1)", () => {
  /** A list in the five groups, as a codeg that has them sends it. */
  function inGroups(groups: Partial<ActivityGroups>): PersonalAgentActivity {
    const g: ActivityGroups = {
      needs: [],
      suggestions: [],
      running: [],
      watch: [],
      next: [],
      done: [],
      waiting: 0,
      pill: { count: 0, first: null },
      ...groups,
    }
    g.waiting = g.needs.length
    g.pill = { count: g.needs.length, first: g.needs[0]?.key ?? null }
    return { ...activityOf(today()), groups: g, capabilities: ["groups_v2"] }
  }

  it("draws them by whose turn it is: what is watched folded to its head, the suggestions one uncounted line", async () => {
    const approval = thing(
      row({ key: "card:1:5", kind: "approval", bot_id: 1, title: "rm -rf" })
    )
    const proposal = thing(
      row({ key: "proposal:3", kind: "proposal", bot_id: 1, title: "Tidy" })
    )
    const running = thing(
      row({
        key: "dispatch:9",
        kind: "dispatch",
        bot_id: 2,
        title: "Fix login",
        dispatch_id: 9,
      }),
      {
        stop: { kind: "turn", bot: 2, batch: 50 },
        why: { kind: "in_turn", bot: 2 },
      }
    )
    const watched = thing(
      row({ key: "pr:4", kind: "pr", bot_id: 2, title: "PR #12" }),
      { why: { kind: "platform_blocked" } }
    )
    draw(
      inGroups({
        needs: [approval],
        suggestions: [proposal],
        running: [running],
        watch: [watched],
      })
    )
    const groups = [
      ...document.querySelectorAll("[data-pa-activity-group]"),
    ].map((g) => g.getAttribute("data-pa-activity-group"))
    expect(groups).toEqual(["needs", "running", "watch"])
    const needs = document.querySelector(
      '[data-pa-activity-group="needs"]'
    ) as HTMLElement
    expect(within(needs).getByText("Needs you")).toBeTruthy()
    // The suggestion is not counted, and is one line until opened.
    expect(within(needs).getByText("1")).toBeTruthy()
    expect(
      document.querySelector('[data-pa-activity-row="proposal:3"]')
    ).toBeNull()
    fireEvent.click(within(needs).getByText("1 more suggestion"))
    expect(
      document.querySelector('[data-pa-activity-row="proposal:3"]')
    ).toBeTruthy()
    // Watched: its head and count, its rows folded at first.
    const watch = document.querySelector(
      '[data-pa-activity-group="watch"]'
    ) as HTMLElement
    expect(within(watch).getByText("Watching")).toBeTruthy()
    expect(document.querySelector('[data-pa-activity-row="pr:4"]')).toBeNull()
    // Under way: why it is, and what stops it — its assistant's turn.
    const run = document.querySelector(
      '[data-pa-activity-row="dispatch:9"]'
    ) as HTMLElement
    expect(run.textContent).toContain("Dev is on it")
    fireEvent.click(
      within(run).getByRole("button", { name: "Stop Dev's turn" })
    )
    await waitFor(() =>
      expect(api.personalAgentCancelTurn).toHaveBeenCalledWith(2, 50)
    )
  })

  it("shows the needs group for suggestions alone, with no count on its head", () => {
    const proposal = thing(
      row({ key: "proposal:3", kind: "proposal", bot_id: 1, title: "Tidy" })
    )
    draw(inGroups({ suggestions: [proposal] }))
    const needs = document.querySelector(
      '[data-pa-activity-group="needs"]'
    ) as HTMLElement
    expect(needs).toBeTruthy()
    expect(within(needs).queryByText("1")).toBeNull()
    expect(within(needs).getByText("1 more suggestion")).toBeTruthy()
  })

  it("words letting a message go by where it stands", () => {
    const message = (id: number, why: ActivityRow["why"]) =>
      ({
        key: `item:${id}`,
        bot_id: 1,
        thing: `item:${id}`,
        today: null,
        item: matter({
          id,
          kind: "message",
          waits_for: "agent",
          summary: "Fix the login",
          written: "Fix the login",
          direction: "out",
        }),
        routine: null,
        card_row_id: null,
        why,
      }) as ActivityRow
    usePersonalAgentUi.setState({
      auxFolds: { "activity.done": true, "activity.watch": true },
    })
    draw(
      inGroups({
        needs: [message(1, { kind: "no_reply", peer: 2 })],
        watch: [message(2, { kind: "queued", bot: 2 })],
      })
    )
    const noReply = document.querySelector(
      '[data-pa-activity-row="item:1"]'
    ) as HTMLElement
    expect(
      within(noReply).getByRole("button", { name: "Stop waiting for a reply" })
    ).toBeTruthy()
    expect(noReply.textContent).toContain("No reply from Dev")
    const queued = document.querySelector(
      '[data-pa-activity-row="item:2"]'
    ) as HTMLElement
    expect(
      within(queued).getByRole("button", { name: "Withdraw message" })
    ).toBeTruthy()
  })

  it("puts a row's own acts on it only when the codeg says it can (6.5)", async () => {
    const failed = thing(
      row({
        key: "failed:9",
        kind: "failed",
        bot_id: 2,
        title: "Fix login",
        dispatch_id: 9,
        reason: "failed",
      }),
      { why: { kind: "failed" } }
    )
    const view: PersonalAgentActivity = {
      ...inGroups({ needs: [failed] }),
      dispatches: [work({ id: 9, state: "failed" })],
    }
    const el = () =>
      document.querySelector('[data-pa-activity-row="failed:9"]') as HTMLElement
    // A codeg with the five groups but not the action: no button needing
    // it.
    const { unmount } = draw(view)
    expect(el().querySelector('[data-pa-row-act="retry"]')).toBeNull()
    unmount()
    draw({ ...view, capabilities: ["groups_v2", "work_retry"] })
    expect(el().querySelector('[data-pa-row-act="hand"]')).toBeTruthy()
    fireEvent.click(
      el().querySelector('[data-pa-row-act="retry"]') as HTMLElement
    )
    await waitFor(() =>
      expect(api.personalAgentWorkRetry).toHaveBeenCalledWith(
        2,
        { dispatchId: 9 },
        "2026-11-11T07:30:00Z",
        undefined
      )
    )
  })

  it("hands a reminder its assistant left unfinished again, by name", async () => {
    const reminder = {
      key: "item:7",
      bot_id: 2,
      thing: "item:7",
      today: null,
      item: matter({
        id: 7,
        kind: "reminder",
        waits_for: "agent",
        summary: "Renew the domain",
      }),
      routine: null,
      card_row_id: null,
      hand_notice_id: 70,
      why: { kind: "unfinished" },
    } as ActivityRow
    draw({
      ...inGroups({ needs: [reminder] }),
      capabilities: ["groups_v2", "rehand"],
    })
    const el = document.querySelector(
      '[data-pa-activity-row="item:7"]'
    ) as HTMLElement
    fireEvent.click(
      el.querySelector('[data-pa-row-act="rehand"]') as HTMLElement
    )
    await waitFor(() =>
      expect(api.personalAgentNoticeAct).toHaveBeenCalledWith(
        70,
        "hand_again",
        2,
        expect.stringContaining("Renew the domain"),
        "2026-11-11T07:30:00Z"
      )
    )
  })

  it("answers an acceptance it is asked on its row", async () => {
    const asked = thing(
      row({ key: "card:2:8", kind: "acceptance", bot_id: 2, title: "Login" }),
      {
        notice: {
          id: 80,
          kind: "acceptance",
          phase: "asked",
          has_message: true,
        },
      }
    )
    draw(inGroups({ needs: [asked] }))
    const el = document.querySelector(
      '[data-pa-activity-row="card:2:8"]'
    ) as HTMLElement
    expect(el.querySelector('[data-pa-row-act="revise"]')).toBeTruthy()
    fireEvent.click(
      el.querySelector('[data-pa-row-act="accept"]') as HTMLElement
    )
    await waitFor(() =>
      expect(api.personalAgentNoticeAct).toHaveBeenCalledWith(80, "accept", 2)
    )
  })

  it("answers what a row asks on it, only when the codeg says it can (7.5)", async () => {
    const permission = thing(
      row({
        key: "card:1:5",
        kind: "approval",
        bot_id: 1,
        title: "rm -rf build",
        row_id: 5,
      }),
      {
        ask: {
          kind: "permission",
          via: "assistant",
          request_id: "p1",
          tool_call: { raw_input: { command: "rm -rf build" } },
          options: [
            { option_id: "allow", name: "Allow", kind: "allow_once" },
            {
              option_id: "clear-allow",
              name: "Clear and allow",
              kind: "allow_once",
            },
            { option_id: "reject", name: "Reject", kind: "reject_once" },
          ],
        },
      }
    )
    const plan = thing(
      row({ key: "card:2:6", kind: "approval", bot_id: 2, row_id: 6 }),
      {
        ask: {
          kind: "plan",
          via: "session",
          connection_id: "c-9",
          approval_id: "a1",
          plan: "1. Read\n2. Fix\n3. Test\n4. Ship",
        },
      }
    )
    const view = inGroups({ needs: [permission, plan] })
    const { unmount } = draw(view)
    expect(document.querySelector("[data-pa-row-ask]")).toBeNull()
    unmount()
    draw({ ...view, capabilities: ["groups_v2", "ask_inline"] })
    const el = document.querySelector(
      '[data-pa-activity-row="card:1:5"]'
    ) as HTMLElement
    expect(el.querySelector("[data-pa-row-ask-command]")?.textContent).toBe(
      "rm -rf build"
    )
    expect(el.querySelector('[data-pa-row-ask="clear-allow"]')).toBeNull()
    fireEvent.click(
      el.querySelector('[data-pa-row-ask="allow"]') as HTMLElement
    )
    await waitFor(() =>
      expect(api.personalAgentRespondPermission).toHaveBeenCalledWith(
        "p1",
        "allow",
        1
      )
    )
    const p = document.querySelector(
      '[data-pa-activity-row="card:2:6"]'
    ) as HTMLElement
    const steps = p.querySelectorAll("[data-pa-row-ask-steps] li")
    expect([...steps].map((s) => s.textContent)).toEqual([
      "Read",
      "Fix",
      "Test",
    ])
    fireEvent.click(
      p.querySelector('[data-pa-row-ask="approve-plan"]') as HTMLElement
    )
    await waitFor(() =>
      expect(api.acpAnswerPlanApproval).toHaveBeenCalledWith("c-9", "a1", {
        decision: "approve",
      })
    )
  })

  it("answers an ask forwarded to the owner through its card, as theirs (7.5)", async () => {
    api.acpAnswerQuestion.mockClear()
    api.personalAgentAnswerQuestion.mockClear()
    api.personalAgentAskAnswer.mockClear()
    const forwarded = thing(
      row({ key: "card:2:9", kind: "forwarded", bot_id: 2, row_id: 9 }),
      {
        ask: {
          kind: "question",
          via: "ask",
          ask_id: 90,
          question_id: "q1",
          questions: [
            {
              id: "q-a",
              question: "Which database?",
              header: "DB",
              multi_select: false,
              options: [
                { label: "Postgres", description: "" },
                { label: "SQLite", description: "" },
              ],
            },
          ],
        },
      }
    )
    draw({
      ...inGroups({ needs: [forwarded] }),
      capabilities: ["groups_v2", "ask_inline"],
    })
    const el = document.querySelector(
      '[data-pa-activity-row="card:2:9"]'
    ) as HTMLElement
    expect(el.textContent).toContain("Which database?")
    fireEvent.click(
      el.querySelector('[data-pa-row-ask="option-1"]') as HTMLElement
    )
    await waitFor(() =>
      expect(api.personalAgentAskAnswer).toHaveBeenCalledWith({
        askId: 90,
        answer: {
          answers: [{ questionId: "q-a", labels: ["SQLite"] }],
          declined: false,
        },
      })
    )
    expect(api.acpAnswerQuestion).not.toHaveBeenCalled()
    expect(api.personalAgentAnswerQuestion).not.toHaveBeenCalled()
  })

  it("lets a row leave its group as it is acted on, and brings it back when the act fails (7.4)", async () => {
    const failed = thing(
      row({
        key: "failed:9",
        kind: "failed",
        bot_id: 2,
        title: "Fix login",
        dispatch_id: 9,
        reason: "failed",
      }),
      { why: { kind: "failed" } }
    )
    const view: PersonalAgentActivity = {
      ...inGroups({ needs: [failed] }),
      dispatches: [work({ id: 9, state: "failed" })],
      capabilities: ["groups_v2", "work_retry"],
    }
    const pending: { reject?: (e: Error) => void } = {}
    api.personalAgentWorkRetry.mockImplementationOnce(
      () =>
        new Promise<Record<string, unknown>>((_, reject) => {
          pending.reject = reject
        })
    )
    draw(view)
    const el = () => document.querySelector('[data-pa-activity-row="failed:9"]')
    fireEvent.click(
      (el() as HTMLElement).querySelector(
        '[data-pa-row-act="retry"]'
      ) as HTMLElement
    )
    // Gone at once, its group with it.
    await waitFor(() => expect(el()).toBeNull())
    expect(
      document.querySelector('[data-pa-activity-group="needs"]')
    ).toBeNull()
    // The act failed: back.
    act(() => pending.reject?.(new Error("boom")))
    await waitFor(() => expect(el()).toBeTruthy())
    expect(LEAVE_COOL_MS).toBeGreaterThan(0)
  })

  it("lets the second click of a double-click meant for a row that left go by (7.4)", async () => {
    const message = (id: number) =>
      ({
        key: `item:${id}`,
        bot_id: 1,
        thing: `item:${id}`,
        today: null,
        item: matter({
          id,
          kind: "message",
          waits_for: "agent",
          summary: `Fix ${id}`,
          written: `Fix ${id}`,
          direction: "out",
        }),
        routine: null,
        card_row_id: null,
        why: { kind: "no_reply", peer: 2 },
      }) as ActivityRow
    api.personalAgentItemAct.mockClear()
    draw(inGroups({ needs: [message(1), message(2)] }))
    const stopOf = (id: number) =>
      within(
        document.querySelector(
          `[data-pa-activity-row="item:${id}"]`
        ) as HTMLElement
      ).getByRole("button", { name: "Stop waiting for a reply" })
    fireEvent.click(stopOf(1), { detail: 1 })
    await waitFor(() =>
      expect(
        document.querySelector('[data-pa-activity-row="item:1"]')
      ).toBeNull()
    )
    // The double-click's second click lands on the row moved up: a matter's
    // own button, guarded by the list alone.
    fireEvent.click(stopOf(2), { detail: 2 })
    expect(api.personalAgentItemAct).toHaveBeenCalledTimes(1)
    fireEvent.click(stopOf(2), { detail: 1 })
    await waitFor(() =>
      expect(api.personalAgentItemAct).toHaveBeenCalledTimes(2)
    )
  })

  it("says why a watched PR is the owner's, and sends an account it cannot read to its settings (6.6)", async () => {
    const unread = thing(
      row({
        key: "pr:4",
        kind: "pr",
        bot_id: 2,
        title: "PR #12",
        state: "open",
      }),
      { why: { kind: "read_failed", error: "auth" } }
    )
    const slow = thing(
      row({
        key: "pr:5",
        kind: "pr",
        bot_id: 2,
        title: "PR #13",
        state: "waiting_checks",
      }),
      { why: { kind: "checks_slow", hours: 5 } }
    )
    draw({
      ...inGroups({ needs: [unread, slow] }),
      capabilities: ["groups_v2", "watch_health"],
    })
    const a = document.querySelector(
      '[data-pa-activity-row="pr:4"]'
    ) as HTMLElement
    expect(a.textContent).toContain("Can't read it · sign in again")
    const b = document.querySelector(
      '[data-pa-activity-row="pr:5"]'
    ) as HTMLElement
    expect(b.textContent).toContain("Checks running 5 h with no result")
    expect(b.querySelector('[data-pa-row-act="reconnect"]')).toBeNull()
    fireEvent.click(
      a.querySelector('[data-pa-row-act="reconnect"]') as HTMLElement
    )
    await waitFor(() =>
      expect(api.openSettingsWindow).toHaveBeenCalledWith("version-control")
    )
  })

  it("draws an older codeg's four groups as they were", () => {
    draw(
      activityOf(today(), {
        watching: [
          thing(row({ key: "dispatch:9", kind: "dispatch", bot_id: 2 })),
        ],
      })
    )
    const groups = [
      ...document.querySelectorAll("[data-pa-activity-group]"),
    ].map((g) => g.getAttribute("data-pa-activity-group"))
    expect(groups).toEqual(["watching"])
    expect(screen.getByText("In progress")).toBeTruthy()
  })
})
