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
  within,
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
  usePersonalAgentUi.setState({
    routineEditor: null,
    routinesAsked: 0,
    auxFolds: {},
  })
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

  it("a routine paused with nothing for its work to run on goes to set it, or resumes; one paused for failures resumes", async () => {
    draw(
      row({
        notice: "routine",
        what: "paused",
        state: "open",
        reason: "executor",
        why: "it has nothing to work with yet",
        routine: ROUTINE,
      })
    )
    expect(screen.getByText("Routine paused")).toBeTruthy()
    expect(screen.getByText(/Its work has nothing set to run on/)).toBeTruthy()
    expect(screen.queryByText("Use another")).toBeNull()
    fireEvent.click(screen.getByText("Set its executor config"))
    expect(usePersonalAgentUi.getState().botPage).toEqual({ tab: "identity" })
    usePersonalAgentUi.getState().showConversation()
    fireEvent.click(screen.getByText("Resume"))
    await waitFor(() =>
      expect(api.personalAgentNoticeAct).toHaveBeenCalledWith(31, "resume", 7)
    )
    api.personalAgentNoticeAct.mockClear()
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
    // One card, as the tab's groups are: no dashed head over it — its bar
    // the part's title, how many, [+] and the chevron.
    const part = document.querySelector<HTMLElement>(
      '[data-pa-detail="routines"]'
    )!
    expect(part.querySelector(".border-dashed")).toBeNull()
    expect(screen.getByRole("heading", { name: /^Routines/ })).toBeTruthy()
    expect(part.querySelector("[data-pa-group-label]")!.textContent).toBe(
      "Routines"
    )
    expect(
      within(part).getByRole("button", { name: "New routine" })
    ).toBeTruthy()
    expect(screen.getByText(/only with matters waiting over 4 h/)).toBeTruthy()
    // Its facts, one to a line, each named: when, how, next, last.
    const facts = [
      ...part.querySelectorAll<HTMLElement>("[data-pa-routine-fact]"),
    ]
    expect(facts.map((f) => f.getAttribute("data-pa-routine-fact"))).toEqual([
      "when",
      "how",
      "next",
      "last",
    ])
    const fact = (k: string) =>
      part.querySelector<HTMLElement>(`[data-pa-routine-fact="${k}"]`)!
    expect(fact("when").querySelector("dt")!.textContent).toBe("When")
    expect(fact("how").textContent).toMatch(
      /^HowThe assistant looks · only with matters waiting over 4 h$/
    )
    const lastRun = fact("last")
    expect(lastRun.querySelector("dt")!.textContent).toBe("Last")
    expect(
      lastRun.querySelector('[data-pa-routine-outcome="silent"]')
    ).toBeTruthy()
    expect(lastRun.textContent).toContain("3 runs in all")
    // How it went a word on the line's baseline as the words round it are:
    // inline, no dot before it.
    const outcome = lastRun.querySelector<HTMLElement>(
      "[data-pa-routine-outcome]"
    )!
    expect(outcome.className).not.toMatch(/(^| )(inline-)?flex( |$)/)
    expect(outcome.children).toHaveLength(0)
    expect(outcome.textContent).toBe("No change")
    // One control at its end, its menu: no switch beside it.
    expect(screen.queryByRole("switch")).toBeNull()
    const row = part.querySelector<HTMLElement>("[data-pa-routine]")!
    expect(
      row.querySelectorAll("button:not([data-pa-item-open])")
    ).toHaveLength(1)
    expect(lastRun.textContent).toContain("no change")
    // Running: no pill saying it is paused.
    expect(part.querySelector("[data-pa-routine-state]")).toBeNull()
    // Run now, from its menu.
    await user.click(screen.getByRole("button", { name: "More actions" }))
    await user.click(await screen.findByRole("menuitem", { name: "Run now" }))
    await waitFor(() =>
      expect(api.personalAgentRoutineAct).toHaveBeenCalledWith(7, 5, "run_now")
    )
    // Paused from its menu.
    await user.click(screen.getByRole("button", { name: "More actions" }))
    expect(screen.queryByRole("menuitem", { name: "Resume" })).toBeNull()
    await user.click(await screen.findByRole("menuitem", { name: "Pause" }))
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
    const why = await screen.findByText("连续失败了 3 次。")
    // Paused by codeg: its pill and why, in the caution's colour.
    expect(why.className).toContain("text-amber-700")
    expect(
      why.closest("[data-pa-routine-fact]")!.querySelector("dt")!.textContent
    ).toBe("原因")
    const pill = document.querySelector<HTMLElement>("[data-pa-routine-state]")!
    expect(pill.textContent).toBe("已暂停")
    expect(pill.className).toContain("text-amber-700")
    // Paused: no next run.
    expect(document.querySelector('[data-pa-routine-fact="next"]')).toBeNull()
    // Resumed from its menu, where it cannot be run now.
    const user = userEvent.setup()
    await user.click(screen.getByRole("button", { name: "更多操作" }))
    expect(
      (await screen.findByRole("menuitem", { name: "立即跑" })).getAttribute(
        "aria-disabled"
      )
    ).toBe("true")
    expect(screen.queryByRole("menuitem", { name: "暂停" })).toBeNull()
    await user.click(screen.getByRole("menuitem", { name: "恢复" }))
    await waitFor(() =>
      expect(api.personalAgentRoutineAct).toHaveBeenCalledWith(7, 5, "resume")
    )
  })

  it("one paused by its owner: its name as ever, a quiet pill after it, no reason", async () => {
    api.personalAgentRoutines.mockResolvedValue([
      routine({ enabled: false, paused_reason: "owner" }),
    ])
    wrap(<RoutinesSection title="Routines" readOnly={false} />)
    const name = await screen.findByText("Night CI")
    // The name keeps its weight and colour: the head of its row.
    expect(name.className).toContain("font-semibold")
    expect(name.className).toContain("text-foreground")
    const pill = document.querySelector<HTMLElement>("[data-pa-routine-state]")!
    expect(pill.textContent).toBe("Paused")
    expect(pill.className).not.toContain("text-amber")
    expect(document.querySelector('[data-pa-routine-fact="why"]')).toBeNull()
  })

  it("one run on an event says what it runs on", async () => {
    api.personalAgentRoutines.mockResolvedValue([
      routine({
        trigger: "event",
        cron: null,
        next_run_at: null,
        event: { kind: "pr_merged" },
      }),
    ])
    wrap(<RoutinesSection title="Routines" readOnly={false} />)
    await screen.findByText("Night CI")
    const when = document.querySelector<HTMLElement>(
      '[data-pa-routine-fact="when"]'
    )!
    expect(when.querySelector("dt")!.textContent).toBe("Trigger")
    expect(when.querySelector("dd")!.textContent).toBe("A watched PR is merged")
    expect(document.querySelector('[data-pa-routine-fact="next"]')).toBeNull()
  })

  it("folds from its bar, the way to add one apart from it", async () => {
    api.personalAgentRoutines.mockResolvedValue([routine()])
    wrap(<RoutinesSection title="Routines" readOnly={false} />)
    await screen.findByText("Night CI")
    fireEvent.click(screen.getByRole("button", { name: "New routine" }))
    expect(usePersonalAgentUi.getState().routineEditor?.routineId).toBeNull()
    // Adding one does not fold it.
    expect(screen.getByText("Night CI")).toBeTruthy()
    const fold = document.querySelector<HTMLElement>("[data-pa-fold]")!
    expect(fold.getAttribute("aria-expanded")).toBe("true")
    fireEvent.click(fold)
    expect(fold.getAttribute("aria-expanded")).toBe("false")
    expect(screen.queryByText("Night CI")).toBeNull()
  })

  it("asked to open its routines, unfolds the card", async () => {
    api.personalAgentRoutines.mockResolvedValue([routine()])
    usePersonalAgentUi.setState({ auxFolds: { "activity.routines": false } })
    wrap(<RoutinesSection title="Routines" readOnly={false} />)
    const fold = await waitFor(() => {
      const el = document.querySelector<HTMLElement>("[data-pa-fold]")
      expect(el).toBeTruthy()
      return el!
    })
    expect(fold.getAttribute("aria-expanded")).toBe("false")
    expect(screen.queryByText("Night CI")).toBeNull()
    act(() => usePersonalAgentUi.getState().showRoutines())
    expect(fold.getAttribute("aria-expanded")).toBe("true")
    expect(screen.getByText("Night CI")).toBeTruthy()
    // Folded since, drawn again: it stays as the owner left it.
    fireEvent.click(fold)
    cleanup()
    wrap(<RoutinesSection title="Routines" readOnly={false} />)
    await screen.findByText("Routines")
    expect(
      document
        .querySelector<HTMLElement>("[data-pa-fold]")!
        .getAttribute("aria-expanded")
    ).toBe("false")
  })

  it("read-only: no [+], no menu", async () => {
    api.personalAgentRoutines.mockResolvedValue([routine()])
    wrap(<RoutinesSection title="Routines" readOnly />)
    await screen.findByText("Night CI")
    expect(document.querySelector("[data-pa-routine-new]")).toBeNull()
    expect(document.querySelector("[data-pa-routine-menu]")).toBeNull()
    expect(
      document.querySelector('[data-pa-routine-outcome="silent"]')
    ).toBeTruthy()
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
      dispatch: { mode: "chat", project_id: null },
    })
    expect(req?.draft?.cron).toMatch(/^\d+ \d+ \* \* [0-6]$/)
    // What its work runs on is taken as it runs: no executor config named.
    expect(req?.draft?.dispatch).not.toHaveProperty("assistant_id")
  })

  it("not on a routine's own work", () => {
    ctx.dispatchById = new Map([[12, info({ routine_id: 5 })]])
    drawResult()
    expect(screen.queryByText("Do this every week")).toBeNull()
  })
})
