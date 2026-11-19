/**
 * 2.4: routines (6.9) — the routine cards, the details' routines, the
 * editor, a result card's "every week", and a reply with nothing to say.
 */

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import zhMessages from "@/i18n/messages/zh-CN.json"
import type { DispatchInfo, Routine, TimelineRow } from "@/lib/types"
import { usePersonalAgentUi } from "@/stores/personal-agent-ui-store"

const api = vi.hoisted(() => ({
  personalAgentNoticeAct: vi.fn(),
  personalAgentRoutines: vi.fn(),
  personalAgentRoutineAct: vi.fn(),
  personalAgentRoutineSave: vi.fn(),
  automationComputeNextRun: vi.fn(),
}))
vi.mock("@/lib/api", () => api)
vi.mock("@/lib/platform", () => ({ openUrl: vi.fn() }))
vi.mock("@/lib/link-open", () => ({ openInSystemBrowser: vi.fn() }))
const ctx = vi.hoisted(() => ({
  dispatchById: new Map<number, unknown>(),
}))
vi.mock("@/contexts/personal-agent-context", () => ({
  useBotId: () => 7,
  usePersonalAgent: () => ({
    botId: 7,
    routineVersion: 0,
    liveReplies: new Map(),
    liveTexts: new Map(),
    dispatchById: ctx.dispatchById,
    quoted: new Map(),
    requestQuoted: () => {},
    rows: [],
  }),
}))
vi.mock("@/contexts/workbench-route-context", () => ({
  useWorkbenchRoute: () => ({ setRoute: vi.fn(), openConversations: vi.fn() }),
}))
vi.mock("@/contexts/tab-context", () => ({
  useTabActions: () => ({ openTab: vi.fn() }),
}))
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }))

import { EventCard } from "./event-card"
import {
  buildMessageItems,
  isDiscarded,
  type MessageItem,
} from "./message-items"
import { NoticeCard } from "./notice-card"
import { RoutineEditor } from "./routine-editor"
import { RoutinesSection } from "./routines-section"
import { PageScopeContext, type PageScope } from "./shared"

function row(
  data: Record<string, unknown>,
  patch: Partial<TimelineRow> = {}
): TimelineRow {
  return {
    id: 61,
    segment_id: 1,
    batch_id: null,
    kind: "notice",
    status: null,
    body: "Routine made: Night CI",
    data,
    dispatch_id: null,
    ref_id: "31",
    reply_to: null,
    read_at: null,
    event_id: null,
    seen_at: null,
    created_at: "2026-11-12T07:00:00Z",
    updated_at: "2026-11-12T07:00:00Z",
    ...patch,
  }
}

const ROUTINE = {
  id: 5,
  title: "Night CI",
  what: "Look at last night's CI; tell me what is red.",
  kind: "brain",
  trigger: "schedule",
  cron: "0 9 * * *",
  timezone: null,
  event: null,
  precheck: null,
}

function scope(readOnly = false): PageScope {
  return {
    readOnly,
    agentName: "Aide",
    liveRowId: null,
    connectionId: null,
    agentType: null,
    onQuote: vi.fn(),
    jumpTo: vi.fn(),
    rowsById: new Map(),
  }
}

function wrap(node: React.ReactNode, { zh = false, readOnly = false } = {}) {
  return render(
    <NextIntlClientProvider
      locale={zh ? "zh-CN" : "en"}
      messages={zh ? zhMessages : enMessages}
      timeZone="UTC"
    >
      <PageScopeContext.Provider value={scope(readOnly)}>
        {node}
      </PageScopeContext.Provider>
    </NextIntlClientProvider>
  )
}

function draw(r: TimelineRow, opts: { zh?: boolean; readOnly?: boolean } = {}) {
  const item = buildMessageItems([r]).find((i) => i.kind === "notice")
  if (!item) throw new Error("no notice item")
  return wrap(
    <NoticeCard item={item as Extract<MessageItem, { kind: "notice" }>} />,
    opts
  )
}

beforeEach(() => {
  api.personalAgentNoticeAct.mockResolvedValue({})
  api.personalAgentRoutineAct.mockResolvedValue({})
  api.personalAgentRoutineSave.mockResolvedValue({})
  api.automationComputeNextRun.mockResolvedValue(null)
  usePersonalAgentUi.setState({ routineEditor: null, routinesAsked: 0 })
  ctx.dispatchById = new Map()
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe("routine cards", () => {
  it("is a card of its own, what it does set in as a quote", () => {
    const { container } = draw(
      row({ notice: "routine", what: "made", state: "made", routine: ROUTINE })
    )
    const card = container.querySelector("[data-pa-card-message]")!
    expect(card.getAttribute("data-pa-routine-card")).toBe("made")
    expect(card.closest(".pa-agent-bubble")).toBeNull()
    expect(screen.getByText(ROUTINE.what).className).toContain("border-s-2")
  })

  it("a routine made in words says what it is and can be undone or edited", async () => {
    draw(
      row({
        notice: "routine",
        what: "made",
        state: "made",
        routine: ROUTINE,
        reason: "you asked for it",
        trial_run_id: 9,
      })
    )
    expect(screen.getByText("Routine made")).toBeTruthy()
    expect(screen.getByText("Night CI")).toBeTruthy()
    expect(screen.getByText(/Why: you asked for it/)).toBeTruthy()
    expect(screen.getByText("Its trial run has started.")).toBeTruthy()
    // Its buttons on the card's last band, under a hairline.
    expect(
      screen.getByText("Undo").closest("[data-pa-sheet-actions]")
    ).not.toBeNull()
    fireEvent.click(screen.getByText("Undo"))
    await waitFor(() =>
      expect(api.personalAgentNoticeAct).toHaveBeenCalledWith(31, "undo", 7)
    )
    fireEvent.click(screen.getByText("Edit"))
    const req = usePersonalAgentUi.getState().routineEditor
    expect(req?.routineId).toBe(5)
    expect(req?.botId).toBe(7)
  })

  it("an undone one has no buttons left", () => {
    draw(
      row({
        notice: "routine",
        what: "made",
        state: "undone",
        routine: ROUTINE,
      })
    )
    expect(screen.getByText("Undone")).toBeTruthy()
    expect(screen.queryByText("Undo")).toBeNull()
  })

  it("a suggestion is made or dropped by the owner", async () => {
    draw(
      row({
        notice: "routine",
        what: "proposal",
        state: "open",
        routine: { ...ROUTINE, id: null },
        draft: ROUTINE,
      })
    )
    expect(screen.getByText("Suggested routine")).toBeTruthy()
    fireEvent.click(screen.getByText("Make it"))
    await waitFor(() =>
      expect(api.personalAgentNoticeAct).toHaveBeenCalledWith(31, "accept", 7)
    )
  })

  it("one the owner asked to see first is theirs to confirm, not a suggestion (2.11)", async () => {
    const { container } = draw(
      row({
        notice: "routine",
        what: "proposal",
        state: "open",
        confirm: true,
        routine: { ...ROUTINE, id: null },
        draft: ROUTINE,
      })
    )
    expect(screen.getByText("Routine to confirm")).toBeTruthy()
    expect(screen.queryByText("Suggested routine")).toBeNull()
    // "Don't suggest these" is for suggestions.
    expect(container.querySelector("[data-pa-mute-kind]")).toBeNull()
    fireEvent.click(screen.getByText("Make it"))
    await waitFor(() =>
      expect(api.personalAgentNoticeAct).toHaveBeenCalledWith(31, "accept", 7)
    )
  })

  it("an offer for a request the owner keeps making opens the editor prefilled", () => {
    const draft = { ...ROUTINE, kind: "dispatch", dispatch: { mode: "chat" } }
    draw(
      row({
        notice: "routine",
        what: "repeat",
        state: "open",
        count: 3,
        draft,
      }),
      { zh: true }
    )
    expect(screen.getByText("做成例程？")).toBeTruthy()
    expect(screen.getByText("30 天里你第 3 次让它做这类事。")).toBeTruthy()
    fireEvent.click(screen.getByText("做成例程"))
    const req = usePersonalAgentUi.getState().routineEditor
    expect(req?.routineId).toBeNull()
    expect(req?.noticeId).toBe(31)
    expect(req?.draft?.kind).toBe("dispatch")
  })

  it("a routine paused for its executor offers another; one paused for failures resumes", async () => {
    draw(
      row({
        notice: "routine",
        what: "paused",
        state: "open",
        reason: "executor",
        why: "executor config #3 is deleted or turned off",
        routine: ROUTINE,
      })
    )
    expect(screen.getByText("Routine paused")).toBeTruthy()
    expect(screen.getByText(/executor config #3 is deleted/)).toBeTruthy()
    fireEvent.click(screen.getByText("Use another"))
    expect(usePersonalAgentUi.getState().routineEditor).toMatchObject({
      routineId: 5,
      noticeId: 31,
    })
    fireEvent.click(screen.getByText("Open routines"))
    expect(usePersonalAgentUi.getState().routinesAsked).toBe(1)
    cleanup()
    draw(
      row({
        notice: "routine",
        what: "paused",
        state: "open",
        reason: "failures",
        routine: ROUTINE,
      })
    )
    fireEvent.click(screen.getByText("Resume"))
    await waitFor(() =>
      expect(api.personalAgentNoticeAct).toHaveBeenCalledWith(31, "resume", 7)
    )
  })

  it("read-only, nothing is acted on", () => {
    draw(
      row({ notice: "routine", what: "made", state: "made", routine: ROUTINE }),
      { readOnly: true }
    )
    expect(screen.queryByText("Undo")).toBeNull()
  })
})

describe("a reply with nothing to say", () => {
  it("is not drawn", () => {
    const reply = row(
      { state: "silent", routine: { id: 5, title: "Night CI", seq: 2 } },
      { kind: "reply", body: "[[silent]]", ref_id: null }
    )
    expect(isDiscarded(reply)).toBe(true)
    expect(buildMessageItems([reply]).some((i) => i.kind === "reply")).toBe(
      false
    )
  })
})

function routine(patch: Partial<Routine> = {}): Routine {
  return {
    id: 5,
    bot_id: 7,
    title: "Night CI",
    what: "Look at CI",
    kind: "brain",
    trigger: "schedule",
    cron: "0 9 * * *",
    timezone: null,
    zone: "UTC",
    event: null,
    dispatch: null,
    precheck: { kind: "items_waiting", hours: 4 },
    enabled: true,
    paused_reason: null,
    source: "owner",
    next_run_at: "2026-11-13T09:00:00Z",
    last_run_at: "2026-11-12T09:00:00Z",
    runs: 3,
    failures: 0,
    created_at: "2026-11-10T09:00:00Z",
    last: [
      {
        id: 9,
        routine_id: 5,
        seq: 3,
        trigger: "schedule",
        due_at: "2026-11-12T09:00:00Z",
        started_at: "2026-11-12T09:00:00Z",
        ended_at: "2026-11-12T09:01:00Z",
        outcome: "silent",
        note: "no change",
        dispatch_id: null,
        notice_id: null,
        row_id: null,
      },
    ],
    ...patch,
  }
}

describe("the details' routines", () => {
  it("lists each with when it runs, its look first and how its last run went", async () => {
    api.personalAgentRoutines.mockResolvedValue([routine()])
    const user = userEvent.setup()
    wrap(<RoutinesSection title="Routines" readOnly={false} />)
    expect(await screen.findByText("Night CI")).toBeTruthy()
    // The section's head: its title, how many, and [+].
    expect(screen.getByRole("heading", { name: "Routines" })).toBeTruthy()
    expect(screen.getByRole("button", { name: "New routine" })).toBeTruthy()
    expect(screen.getByText(/only with matters waiting over 4 h/)).toBeTruthy()
    expect(
      document.querySelector('[data-pa-routine-outcome="silent"]')
    ).toBeTruthy()
    // Run now, from its menu.
    await user.click(screen.getByRole("button", { name: "More actions" }))
    await user.click(await screen.findByRole("menuitem", { name: "Run now" }))
    await waitFor(() =>
      expect(api.personalAgentRoutineAct).toHaveBeenCalledWith(7, 5, "run_now")
    )
    // Its switch pauses it.
    const on = screen.getByRole("switch", { name: "Runs" })
    expect(on.getAttribute("aria-checked")).toBe("true")
    fireEvent.click(on)
    await waitFor(() =>
      expect(api.personalAgentRoutineAct).toHaveBeenCalledWith(7, 5, "pause")
    )
    // Its title opens it to edit.
    fireEvent.click(screen.getByText("Night CI").closest("button")!)
    expect(usePersonalAgentUi.getState().routineEditor?.routineId).toBe(5)
    // Deleted from its menu, once confirmed.
    await user.click(screen.getByRole("button", { name: "More actions" }))
    await user.click(await screen.findByRole("menuitem", { name: "Delete" }))
    fireEvent.click(
      document.querySelector("[data-pa-routine-delete-confirm]") as Element
    )
    await waitFor(() =>
      expect(api.personalAgentRoutineAct).toHaveBeenCalledWith(7, 5, "delete")
    )
  })

  it("a paused one says why and resumes", async () => {
    api.personalAgentRoutines.mockResolvedValue([
      routine({ enabled: false, paused_reason: "failures" }),
    ])
    wrap(<RoutinesSection title="例程" readOnly={false} />, { zh: true })
    expect(await screen.findByText("已暂停：连续失败 3 次")).toBeTruthy()
    const off = screen.getByRole("switch", { name: "启用" })
    expect(off.getAttribute("aria-checked")).toBe("false")
    fireEvent.click(off)
    await waitFor(() =>
      expect(api.personalAgentRoutineAct).toHaveBeenCalledWith(7, 5, "resume")
    )
  })

  it("none yet: how to get one", async () => {
    api.personalAgentRoutines.mockResolvedValue([])
    wrap(<RoutinesSection title="Routines" readOnly={false} />)
    expect(
      await screen.findByText(
        "No routines yet. Ask it in the conversation to set one up."
      )
    ).toBeTruthy()
    // No [+] at the head while the empty line offers it.
    expect(document.querySelector("[data-pa-routine-new]")).toBeNull()
    fireEvent.click(screen.getByText("New routine"))
    expect(usePersonalAgentUi.getState().routineEditor?.routineId).toBeNull()
  })
})

describe("the editor", () => {
  it("saves a prefilled routine as written, in the owner's zone, and runs it once", async () => {
    act(() =>
      usePersonalAgentUi.getState().openRoutineEditor({
        botId: 7,
        routineId: null,
        draft: {
          title: "Deps check",
          what: "Check dependencies",
          kind: "brain",
          cron: "0 9 * * 1",
        },
        noticeId: 31,
      })
    )
    wrap(<RoutineEditor />)
    expect(
      screen.getByText(
        "Once saved it runs once right away, as a trial; after that codeg keeps its rhythm."
      )
    ).toBeTruthy()
    fireEvent.click(screen.getByText("Save and run once"))
    await waitFor(() => expect(api.personalAgentRoutineSave).toHaveBeenCalled())
    const [bot, id, draft, notice] = api.personalAgentRoutineSave.mock.calls[0]
    expect([bot, id, notice]).toEqual([7, null, 31])
    expect(draft).toMatchObject({
      title: "Deps check",
      what: "Check dependencies",
      kind: "brain",
      cron: "0 9 * * 1",
      timezone: "owner",
      event: null,
      dispatch: null,
      precheck: { kind: "none" },
    })
    await waitFor(() =>
      expect(usePersonalAgentUi.getState().routineEditor).toBeNull()
    )
  })

  it("asks for a name first", async () => {
    act(() =>
      usePersonalAgentUi.getState().openRoutineEditor({
        botId: null,
        routineId: null,
        draft: null,
        noticeId: null,
      })
    )
    wrap(<RoutineEditor />)
    fireEvent.click(screen.getByText("Save and run once"))
    expect(await screen.findByText("Give it a name.")).toBeTruthy()
    expect(api.personalAgentRoutineSave).not.toHaveBeenCalled()
  })
})

function info(patch: Partial<DispatchInfo> = {}): DispatchInfo {
  return {
    id: 12,
    mode: "chat",
    executor: {
      assistant_id: 3,
      name: "Researcher",
      agent_type: "codex",
      agent_options: {},
      label_snapshot: null,
      instructions: "",
      dispatcher: null,
    } as unknown as DispatchInfo["executor"],
    folder_id: null,
    folder_name: null,
    deliverable: null,
    title: "Check deps for security updates",
    prompt: "Look at Cargo.lock",
    work_task_id: null,
    conversation_id: 40,
    conversation_folder_id: null,
    connection_id: null,
    state: "completed",
    result_excerpt: "All fine.",
    error: null,
    on_done: null,
    turns: 1,
    created_at: "2026-11-12T07:00:00Z",
    updated_at: "2026-11-12T07:10:00Z",
    finished_at: "2026-11-12T07:10:00Z",
    ladder: "done",
    task: null,
    answered_for_you: 0,
    ...patch,
  } as DispatchInfo
}

describe("a result card", () => {
  function result(): TimelineRow {
    return row(
      { state: "completed", title: "Check deps for security updates" },
      { kind: "result", ref_id: null, dispatch_id: 12, body: "Done" }
    )
  }

  function drawResult() {
    const item = buildMessageItems([result()]).find((i) => i.kind === "event")
    if (!item) throw new Error("no event item")
    return wrap(
      <EventCard item={item as Extract<MessageItem, { kind: "event" }>} />
    )
  }

  it("offers to do the same work every week", () => {
    ctx.dispatchById = new Map([[12, info()]])
    drawResult()
    fireEvent.click(screen.getByText("Do this every week"))
    const req = usePersonalAgentUi.getState().routineEditor
    expect(req?.routineId).toBeNull()
    expect(req?.draft).toMatchObject({
      title: "Check deps for security updates",
      what: "Look at Cargo.lock",
      kind: "dispatch",
      dispatch: { assistant_id: 3, mode: "chat", project_id: null },
    })
    expect(req?.draft?.cron).toMatch(/^\d+ \d+ \* \* [0-6]$/)
  })

  it("not on a routine's own work", () => {
    ctx.dispatchById = new Map([[12, info({ routine_id: 5 })]])
    drawResult()
    expect(screen.queryByText("Do this every week")).toBeNull()
  })
})
