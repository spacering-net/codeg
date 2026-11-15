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
import type { BotLive, RosterEntry, TimelineRow } from "@/lib/types"
import {
  __resetRosterForTests,
  ELSEWHERE_POLL_MS,
  usePersonalAgentRoster,
} from "@/stores/personal-agent-roster-store"
import { usePersonalAgentUi } from "@/stores/personal-agent-ui-store"

const api = vi.hoisted(() => ({
  personalAgentBots: vi.fn(),
  personalAgentRosterAct: vi.fn(async () => {}),
  personalAgentStopAll: vi.fn(async () => {}),
  personalAgentBotCopy: vi.fn(),
  personalAgentTurnSteps: vi.fn(),
  personalAgentCancel: vi.fn(async () => {}),
  personalAgentTemplates: vi.fn(async () => [
    {
      id: "review",
      name: "Reviewer",
      job: "",
      description: "",
      instructions: "",
      opener: "",
      options: ["a", "b", "c"],
      other: "Other",
      modes: ["session"],
      division: "review",
      project_option: null,
    },
  ]),
  personalAgentResend: vi.fn(),
  personalAgentSave: vi.fn(async () => ({})),
}))
vi.mock("@/lib/api", () => api)
const events = vi.hoisted(() => ({
  handlers: new Map<string, (p: unknown) => void>(),
}))
vi.mock("@/lib/platform", () => ({
  subscribe: (name: string, fn: (p: unknown) => void) => {
    events.handlers.set(name, fn)
    return Promise.resolve(() => events.handlers.delete(name))
  },
  onTransportReconnect: () => () => {},
}))
const pa = vi.hoisted(() => ({ snapshot: null as unknown }))
vi.mock("@/contexts/personal-agent-context", () => ({
  useBotId: () => 1,
  usePersonalAgent: () => ({
    botId: 1,
    snapshot: pa.snapshot,
    dispatchById: new Map(),
    liveReplies: new Map(),
    rows: [],
  }),
}))
vi.mock("@/contexts/workbench-route-context", () => ({
  useWorkbenchRoute: () => ({ setRoute: vi.fn(), openConversations: vi.fn() }),
}))
vi.mock("@/contexts/tab-context", () => ({
  useTabActions: () => ({ openTab: vi.fn() }),
}))

import { OwnerBubble } from "./owner-bubble"
import { buildMessageItems, type MessageItem } from "./message-items"
import { ownerWaitTargets, waitsForOwner } from "./message-list"
import { PersonalAgentRoster } from "./roster"
import { PageScopeContext, type PageScope } from "./shared"
import { StatusLine, VAGUE_DELAY_MS } from "./status-line"

const NOW = Date.now()
const iso = (ms: number) => new Date(NOW + ms).toISOString()

function live(id: number, patch: Partial<BotLive> = {}): BotLive {
  return {
    bot_id: id,
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
    last_activity_at: iso(-60_000),
    updated_at: iso(-1000),
    expires_at: null,
    ...patch,
  }
}

function entry(
  id: number,
  name: string,
  patch: Partial<BotLive> = {},
  roster: Partial<RosterEntry["roster"]> = {}
): RosterEntry {
  return {
    id,
    kind: id === 1 ? "primary" : "worker",
    uid: `u${id}`,
    name,
    avatar: { kind: "face", shape: "blob", color: id === 1 ? "black" : "teal" },
    template: id === 1 ? null : "review",
    executor_assistant_id: null,
    created_at: iso(-86_400_000),
    roster: {
      sort_order: 0,
      pinned_at: null,
      section: null,
      hidden: false,
      muted: false,
      unread_mark: false,
      notify: true,
      ...roster,
    },
    live: live(id, patch),
  }
}

/** Hover a face long enough for its card to open. */
async function hoverOpen(el: Element) {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  try {
    fireEvent.pointerEnter(el)
    act(() => {
      vi.advanceTimersByTime(600)
    })
  } finally {
    vi.useRealTimers()
  }
  await waitFor(() =>
    expect(document.querySelector("[data-pa-roster-hover]")).toBeTruthy()
  )
}

const scope: PageScope = {
  readOnly: false,
  agentName: "Nova",
  liveRowId: null,
  connectionId: null,
  agentType: null,
  onQuote: vi.fn(),
  jumpTo: vi.fn(),
  rowsById: new Map(),
}

function wrap(node: React.ReactNode) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <PageScopeContext.Provider value={scope}>
        {node}
      </PageScopeContext.Provider>
    </NextIntlClientProvider>
  )
}

beforeEach(() => {
  __resetRosterForTests()
  usePersonalAgentUi.setState({ viewBot: null, settings: null, botPage: null })
  pa.snapshot = {
    agent: {
      id: 1,
      name: "Nova",
      avatar: { kind: "face", shape: "blob", color: "black" },
    },
    status: { engine: "here", connected: true, turn: null },
  }
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  vi.useRealTimers()
})

describe("the roster", () => {
  it("says what each is up to: what waits on the owner first, then what it does, then its last words", async () => {
    api.personalAgentBots.mockResolvedValue([
      entry(1, "Nova", { last_line: { text: "All set.", at: iso(-5000) } }),
      entry(2, "Dev", {
        work: "busy",
        face: "working",
        expires_at: iso(30_000),
        activity: {
          step: {
            n: 3,
            kind: "edit",
            target: "startup.rs",
            started_at: iso(-1000),
            status: "in_progress",
          },
          work: { dispatch_id: 234, title: "Fix the white screen" },
        },
        work_on_hand: [
          {
            dispatch_id: 234,
            title: "Fix the white screen",
            mode: "task",
            state: "running",
            work_task_id: 7,
            conversation_id: null,
            ladder: "working",
            pr: null,
          },
        ],
      }),
      entry(3, "Rev", {
        attention: "needs_you",
        face: "waiting",
        needs: {
          kind: "question",
          text: "Keep the old layer?",
          since: iso(-5000),
          row_id: 9,
          count: 1,
        },
      }),
    ])
    wrap(<PersonalAgentRoster compact={false} readOnly={false} />)
    await screen.findByText("Dev")
    const rows = [...document.querySelectorAll("[data-pa-roster-bot]")]
    // The primary on top, then the waiting, then the working.
    expect(rows.map((r) => r.getAttribute("data-pa-roster-bot"))).toEqual([
      "1",
      "3",
      "2",
    ])
    const line = (id: number) =>
      document.querySelector(
        `[data-pa-roster-bot='${id}'] [data-pa-roster-line]`
      )?.textContent
    // The primary says no more than its name: its line is on its card.
    expect(line(1)).toBeUndefined()
    expect(line(3)).toBe("Needs your answer: Keep the old layer?")
    expect(line(2)).toBe("#234 Fix the white screen: Editing startup.rs")
    // Its face is its state, its dot what it wants.
    const face = (id: number) =>
      document.querySelector(`[data-pa-roster-bot='${id}'] [data-bot-look]`)!
    expect(face(2).getAttribute("data-bot-look")).toBe("working")
    expect(face(3).getAttribute("data-bot-look")).toBe("waiting")
    expect(
      face(3).querySelector("[data-bot-dot]")?.getAttribute("data-bot-dot")
    ).toBe("waiting")
    expect(face(3).getAttribute("aria-label")).toBe("Rev, waiting for you")
    await hoverOpen(document.querySelector("[data-pa-roster-bot='1']")!)
    const card = document.querySelector("[data-pa-roster-hover='1']")!
    expect(card.querySelector("[data-pa-roster-line]")?.textContent).toBe(
      "All set."
    )
  })

  it("puts work the owner can merge before what it is doing, in a calm tone", async () => {
    const hand = (id: number, ladder: "working" | "mergeable") => ({
      dispatch_id: id,
      title: `Task ${id}`,
      mode: "task" as const,
      state:
        ladder === "mergeable" ? ("review" as const) : ("running" as const),
      work_task_id: id,
      conversation_id: null,
      ladder,
      pr: null,
    })
    api.personalAgentBots.mockResolvedValue([
      entry(1, "Nova"),
      entry(2, "Dev", {
        work: "busy",
        face: "working",
        expires_at: iso(30_000),
        activity: {
          step: {
            n: 1,
            kind: "edit",
            target: "a.rs",
            started_at: iso(-1000),
            status: "in_progress",
          },
        },
        work_on_hand: [hand(233, "working"), hand(234, "mergeable")],
      }),
    ])
    wrap(<PersonalAgentRoster compact={false} readOnly={false} />)
    await screen.findByText("Dev")
    const line = document.querySelector(
      "[data-pa-roster-bot='2'] [data-pa-roster-line]"
    )!
    expect(line.textContent).toBe("#234 ready to merge: Task 234")
    expect(line.getAttribute("data-pa-roster-line")).toBe("ready")
    expect(line.className).toContain("text-teal-700")
  })

  it("follows each one's state as it is pushed, and lets a stale one rest", async () => {
    api.personalAgentBots.mockResolvedValue([entry(1, "Nova"), entry(2, "Dev")])
    wrap(<PersonalAgentRoster compact={false} readOnly={false} />)
    await screen.findByText("Dev")
    act(() =>
      events.handlers.get("personal-agent://bots")?.({
        kind: "live",
        bot_id: 2,
        live: live(2, {
          work: "busy",
          face: "working",
          updated_at: iso(0),
          expires_at: iso(-1),
          activity: {
            step: {
              n: 1,
              kind: "test",
              started_at: iso(0),
              status: "in_progress",
            },
          },
        }),
      })
    )
    // Pushed, but already past its expiry: at rest, saying so on hover.
    const face = document.querySelector(
      "[data-pa-roster-bot='2'] [data-bot-look]"
    )!
    expect(face.getAttribute("data-bot-look")).toBe("idle")
    expect(face.getAttribute("aria-label")).toBe(
      "Dev, Status unavailable for now"
    )
    act(() =>
      events.handlers.get("personal-agent://bots")?.({
        kind: "live",
        bot_id: 2,
        live: live(2, {
          work: "busy",
          face: "working",
          updated_at: iso(10),
          expires_at: iso(30_000),
          activity: {
            step: {
              n: 1,
              kind: "test",
              started_at: iso(0),
              status: "in_progress",
            },
          },
        }),
      })
    )
    // The face changes through a blink.
    await waitFor(() =>
      expect(
        document
          .querySelector("[data-pa-roster-bot='2'] [data-bot-look]")!
          .getAttribute("data-bot-look")
      ).toBe("working")
    )
    expect(screen.getByText("Running the tests")).toBeTruthy()
  })

  it("arranges one from its menu, and hides the hidden ones under a count", async () => {
    api.personalAgentBots.mockResolvedValue([
      entry(1, "Nova"),
      entry(2, "Dev", {}, { pinned_at: iso(-100) }),
      entry(3, "Ops", {}, { section: "codeg" }),
      entry(4, "Old", {}, { hidden: true }),
      entry(5, "Ann"),
    ])
    wrap(<PersonalAgentRoster compact={false} readOnly={false} />)
    await screen.findByText("Dev")
    // Each group's name where its rows' faces are, a folding one's chevron
    // after its name; one class for them all.
    const pinned = screen.getByText("Pinned").parentElement!
    const fold = screen.getByRole("button", { name: "Fold codeg" })
    expect(fold.firstElementChild!.textContent).toBe("codeg")
    expect(fold.lastElementChild!.tagName.toLowerCase()).toBe("svg")
    expect(fold.className).toContain(pinned.className)
    expect(screen.getByText("Others").parentElement!.className).toBe(
      pinned.className
    )
    // The hidden ones under a count after the list, the same kind of head.
    expect(screen.queryByText("Old")).toBeNull()
    const hidden = screen.getByText("1 hidden").closest("button")!
    expect(hidden.closest("[data-pa-roster-foot]")).toBeNull()
    expect(hidden.className).toContain(pinned.className)
    expect(hidden.getAttribute("aria-expanded")).toBe("false")
    fireEvent.click(hidden)
    expect(hidden.getAttribute("aria-expanded")).toBe("true")
    expect(screen.getByText("Old")).toBeTruthy()
    // Its menu.
    fireEvent.contextMenu(screen.getByText("Ops"))
    const menu = await screen.findByRole("menu")
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Pin" }))
    expect(api.personalAgentRosterAct).toHaveBeenCalledWith(3, { act: "pin" })
    fireEvent.contextMenu(screen.getByText("Ops"))
    fireEvent.click(
      within(await screen.findByRole("menu")).getByRole("menuitem", {
        name: "Mark as unread",
      })
    )
    expect(api.personalAgentRosterAct).toHaveBeenLastCalledWith(3, {
      act: "mark_unread",
    })
    // Folding a group.
    fireEvent.click(screen.getByRole("button", { name: "Fold codeg" }))
    expect(screen.queryByText("Ops")).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "Unfold codeg" }))
    expect(screen.getByText("Ops")).toBeTruthy()
  })

  it("puts the primary in a square on top, no title row over it, and the new one at the foot", async () => {
    api.personalAgentBots.mockResolvedValue([
      entry(1, "Nova", { last_line: { text: "All set.", at: iso(-5000) } }),
      entry(2, "Dev"),
      entry(3, "Ops"),
    ])
    wrap(<PersonalAgentRoster compact={false} readOnly={false} />)
    await screen.findByText("Dev")
    const nav = document.querySelector("[data-pa-roster]")!
    // No title, no search: the primary first.
    expect(within(nav as HTMLElement).queryByText("Assistants")).toBeNull()
    expect(screen.queryByRole("button", { name: /search/i })).toBeNull()
    const primary = nav.querySelector("[data-pa-roster-primary]")!
    expect(primary.querySelector(".size-24")).toBeTruthy()
    expect(primary.textContent).toBe("Nova")
    // A little room between the rows.
    // (inside what folds, which itself has none, so it shuts to nothing).
    const rows = nav.querySelectorAll("[data-pa-roster-row-state] > div")
    expect(rows.length).toBe(2)
    rows.forEach((r) => {
      expect(r.className).toBe("")
      expect((r.firstElementChild as HTMLElement).className).toContain("py-0.5")
    })
    // One measure of room: the list as far from the top as the primary's
    // tile from the rows under it.
    const list = nav.firstElementChild as HTMLElement
    expect(list.className).toContain("pt-4")
    expect((primary.closest("div") as HTMLElement).className).toContain("pb-3")
    // [+ New work assistant] at the foot, a row as the rows are: a circle
    // with a plus where a face would be (drawn, not dashed), its name.
    const foot = nav.querySelector("[data-pa-roster-foot]")!
    const add = foot.querySelector("[data-pa-roster-add]")!
    expect(add.textContent).toBe("New work assistant")
    expect(nav.lastElementChild).toBe(foot)
    const row = nav.querySelector("[data-pa-roster-bot='2']")!
    for (const cls of ["gap-2.5", "px-2", "py-1.5", "rounded-xl"]) {
      expect(add.className).toContain(cls)
      expect(row.className).toContain(cls)
    }
    const circle = add.firstElementChild!
    expect(circle.className).toContain("size-7")
    expect(circle.className).toContain("border")
    expect(circle.className).not.toContain("border-dashed")
    // The foot's room as the list's: its row on the rows' edge.
    expect(foot.className).toContain("p-2")
    expect(list.className).toContain("px-2")
  })

  it("gives a row's time as short as a chat list does", async () => {
    const day = 86_400_000
    api.personalAgentBots.mockResolvedValue([
      entry(1, "Nova"),
      entry(2, "Dev", { last_activity_at: iso(-day) }),
      entry(3, "Ops", { last_activity_at: iso(-30 * day) }),
    ])
    wrap(<PersonalAgentRoster compact={false} readOnly={false} />)
    await screen.findByText("Dev")
    const time = (id: number) =>
      document.querySelector(`[data-pa-roster-bot='${id}'] .tabular-nums`)
        ?.textContent
    expect(time(2)).toBe("Yesterday")
    // A month back: its day and month, no time of day.
    expect(time(3)).not.toMatch(/:/)
  })

  it("folds to a rail of faces: the primary's, a rule, the rest's, each one's line on its card", async () => {
    window.localStorage.setItem("pa:roster:rail:v1", "1")
    api.personalAgentBots.mockResolvedValue([
      entry(1, "Nova"),
      entry(2, "Dev", { last_line: { text: "Done.", at: iso(-5000) } }),
      entry(3, "Ops", {}, { pinned_at: iso(-100) }),
      entry(4, "Old", {}, { hidden: true }),
    ])
    try {
      wrap(<PersonalAgentRoster compact={false} readOnly={false} />)
      const tiles = await waitFor(() => {
        const found = [...document.querySelectorAll("[data-pa-rail-tile]")]
        expect(found.length).toBe(3)
        return found
      })
      const rail = document.querySelector("[data-pa-roster-rail]")!
      // The tiles as far from the top as from the rail's sides; the rule
      // as wide as a tile, as far from the faces either side.
      expect(rail.firstElementChild!.className).toContain("pt-4")
      const rule = rail.querySelector("[aria-hidden].h-px")!
      expect(rule.className).toContain("w-13")
      expect(rule.className).toContain("my-2")
      // The primary, then the pinned, then the rest; faces alone.
      expect(tiles.map((t) => t.getAttribute("data-pa-roster-bot"))).toEqual([
        "1",
        "3",
        "2",
      ])
      expect(screen.queryByText("Dev")).toBeNull()
      expect(tiles[2].getAttribute("aria-label")).toBe("Dev, idle")
      // Its line, on its card.
      await hoverOpen(tiles[2])
      expect(
        document.querySelector(
          "[data-pa-roster-hover='2'] [data-pa-roster-line]"
        )?.textContent
      ).toBe("Done.")
      fireEvent.click(tiles[2])
      expect(usePersonalAgentUi.getState().viewBot).toBe(2)
      // The hidden ones under their count; the new one at the foot.
      fireEvent.click(screen.getByRole("button", { name: "1 hidden" }))
      expect(document.querySelectorAll("[data-pa-rail-tile]").length).toBe(4)
      expect(
        screen.getByRole("button", { name: "New work assistant" })
      ).toBeTruthy()
    } finally {
      window.localStorage.removeItem("pa:roster:rail:v1")
    }
  })

  it("opens one on a click, which takes the owner's unread mark away", async () => {
    api.personalAgentBots.mockResolvedValue([
      entry(1, "Nova"),
      entry(2, "Dev", {}, { unread_mark: true }),
      entry(3, "Ops"),
    ])
    wrap(<PersonalAgentRoster compact={false} readOnly={false} />)
    await screen.findByText("Dev")
    fireEvent.click(screen.getByText("Dev"))
    expect(usePersonalAgentUi.getState().viewBot).toBe(2)
    await waitFor(() =>
      expect(api.personalAgentRosterAct).toHaveBeenCalledWith(2, {
        act: "mark_read",
      })
    )
  })
})

/** A pointer event on `target` (jsdom has no PointerEvent: a MouseEvent of
 *  its type, the pointer's id and kind added). */
function pointer(
  type: "pointerdown" | "pointermove" | "pointerup",
  target: Element,
  x: number,
  y: number,
  buttons = 1
) {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: x,
    clientY: y,
    button: 0,
    buttons,
  })
  Object.defineProperty(event, "pointerId", { value: 1 })
  Object.defineProperty(event, "pointerType", { value: "mouse" })
  act(() => {
    target.dispatchEvent(event)
  })
}

/** What the page finds under the pointer: `under()`'s element. */
function hitTesting(under: () => Element | null) {
  Object.defineProperty(document, "elementFromPoint", {
    configurable: true,
    value: () => under(),
  })
  return () => {
    delete (document as { elementFromPoint?: unknown }).elementFromPoint
  }
}

const rowOf = (name: string) =>
  screen.getByText(name).closest("[data-pa-roster-bot]") as HTMLElement

/** Press on `from`'s row (at `fromY`), move onto `to` (found by the page
 *  under the pointer — twice: what shows only while dragging is there the
 *  second time), and let go. */
function dragRow(from: string, to: () => Element | null, y = 30, fromY = 10) {
  const row = rowOf(from)
  const undo = hitTesting(to)
  try {
    pointer("pointerdown", row, 10, fromY)
    pointer("pointermove", row, 10, y)
    pointer("pointermove", row, 10, y + 1)
    pointer("pointerup", row, 10, y + 1, 0)
  } finally {
    undo()
  }
  return row
}

describe("the roster's menu and drags (polish round 4)", () => {
  it("opens an assistant's page and edits its name and face from its menu, each item with its icon", async () => {
    api.personalAgentBots.mockResolvedValue([entry(1, "Nova"), entry(2, "Dev")])
    wrap(<PersonalAgentRoster compact={false} readOnly={false} />)
    await screen.findByText("Dev")
    fireEvent.contextMenu(screen.getByText("Dev"))
    let menu = await screen.findByRole("menu")
    for (const item of within(menu).getAllByRole("menuitem")) {
      expect(item.querySelector("svg")).not.toBeNull()
    }
    fireEvent.click(
      within(menu).getByRole("menuitem", { name: "View details" })
    )
    expect(usePersonalAgentUi.getState()).toMatchObject({
      viewBot: 2,
      botPage: { tab: "identity" },
    })
    // A click on its row: its conversation, the page closed.
    fireEvent.click(screen.getByText("Dev"))
    expect(usePersonalAgentUi.getState().botPage).toBeNull()
    expect(usePersonalAgentUi.getState().viewBot).toBe(2)
    // Its name and face.
    fireEvent.contextMenu(screen.getByText("Dev"))
    menu = await screen.findByRole("menu")
    fireEvent.click(
      within(menu).getByRole("menuitem", { name: "Edit basic info…" })
    )
    const dialog = await screen.findByRole("dialog", {
      name: "Edit basic info",
    })
    const save = within(dialog).getByRole("button", { name: "Save" })
    // Nothing changed yet; and a work assistant keeps a name.
    expect(save).toBeDisabled()
    const name = within(dialog).getByLabelText("Name")
    fireEvent.change(name, { target: { value: " " } })
    expect(save).toBeDisabled()
    fireEvent.change(name, { target: { value: "  Builder " } })
    fireEvent.click(within(dialog).getByRole("button", { name: "Purple" }))
    fireEvent.click(save)
    await waitFor(() =>
      expect(api.personalAgentSave).toHaveBeenCalledWith(
        {
          name: "Builder",
          avatar: { kind: "face", shape: "blob", color: "purple" },
          locale: "en",
        },
        2
      )
    )
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
  })

  it("lets the primary go by the default name", async () => {
    api.personalAgentBots.mockResolvedValue([entry(1, "Nova"), entry(2, "Dev")])
    wrap(<PersonalAgentRoster compact={false} readOnly={false} />)
    await screen.findByText("Dev")
    fireEvent.contextMenu(screen.getByText("Nova"))
    fireEvent.click(
      within(await screen.findByRole("menu")).getByRole("menuitem", {
        name: "Edit basic info…",
      })
    )
    const dialog = await screen.findByRole("dialog")
    const name = within(dialog).getByLabelText("Name") as HTMLInputElement
    expect(name.placeholder).toBe("Personal agent")
    fireEvent.change(name, { target: { value: "" } })
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }))
    await waitFor(() =>
      expect(api.personalAgentSave).toHaveBeenCalledWith(
        expect.objectContaining({ name: "" }),
        null
      )
    )
  })

  it("puts a row dragged onto a group in it, out of the pinned ones", async () => {
    api.personalAgentBots.mockResolvedValue([
      entry(1, "Nova"),
      entry(2, "Dev", {}, { pinned_at: iso(-100), section: "web" }),
      entry(3, "Ops", {}, { section: "codeg" }),
      entry(5, "Ann"),
    ])
    wrap(<PersonalAgentRoster compact={false} readOnly={false} />)
    await screen.findByText("Ann")
    const group = (name: string) =>
      document.querySelector(`[data-pa-roster-group="${name}"]`)!
    // Mid-drag: the group under it lit, a chip of it under the pointer, a
    // group to name at the end.
    const row = rowOf("Ann")
    const undo = hitTesting(() => screen.getByText("Ops"))
    pointer("pointerdown", row, 10, 10)
    pointer("pointermove", row, 10, 30)
    expect(group("codeg").getAttribute("data-pa-drop-over")).toBe("true")
    expect(document.querySelector('[data-pa-roster-ghost="5"]')).toBeTruthy()
    expect(document.querySelector('[data-pa-drop="new"]')).toBeTruthy()
    expect(row.getAttribute("data-pa-roster-dragged")).toBe("true")
    pointer("pointerup", row, 10, 30, 0)
    // The click the drop ends in, right after it, is not a click on the
    // row.
    fireEvent.click(row)
    expect(usePersonalAgentUi.getState().viewBot).toBeNull()
    undo()
    await waitFor(() =>
      expect(api.personalAgentRosterAct).toHaveBeenCalledWith(5, {
        act: "section",
        name: "codeg",
      })
    )
    expect(document.querySelector("[data-pa-roster-ghost]")).toBeNull()
    expect(document.querySelector('[data-pa-drop="new"]')).toBeNull()
    // A pinned one dropped with the others: out of its group, then unpinned.
    api.personalAgentRosterAct.mockClear()
    dragRow("Dev", () => screen.getByText("Others"))
    await waitFor(() =>
      expect(api.personalAgentRosterAct.mock.calls).toEqual([
        [2, { act: "section", name: null }],
        [2, { act: "unpin" }],
      ])
    )
  })

  it("pins a row dragged among the pinned ones at the slot it is let go over", async () => {
    api.personalAgentBots.mockResolvedValue([
      entry(1, "Nova"),
      entry(2, "Dev", {}, { pinned_at: iso(-300), sort_order: 0 }),
      entry(3, "Ops", {}, { pinned_at: iso(-200), sort_order: 1 }),
      entry(5, "Ann"),
    ])
    wrap(<PersonalAgentRoster compact={false} readOnly={false} />)
    await screen.findByText("Ann")
    // Dev's row from 0 to 40, Ops's from 40 to 80.
    for (const [name, top] of [
      ["Dev", 0],
      ["Ops", 40],
    ] as const) {
      rowOf(name).getBoundingClientRect = () =>
        ({ top, bottom: top + 40, height: 40, left: 0, right: 200 }) as DOMRect
    }
    // Over Ops's upper half: before Ops.
    const row = rowOf("Ann")
    const undo = hitTesting(() => screen.getByText("Ops"))
    pointer("pointerdown", row, 10, 100)
    pointer("pointermove", row, 10, 50)
    expect(
      rowOf("Ops").querySelector('[data-pa-roster-slot="before"]')
    ).toBeTruthy()
    pointer("pointerup", row, 10, 50, 0)
    undo()
    await waitFor(() =>
      expect(api.personalAgentRosterAct.mock.calls).toEqual([
        [5, { act: "pin" }],
        [5, { act: "order", ids: [2, 5, 3] }],
      ])
    )
    // Dev to the end; and over where it is, nothing to do.
    api.personalAgentRosterAct.mockClear()
    dragRow("Dev", () => screen.getByText("Ops"), 70)
    await waitFor(() =>
      expect(api.personalAgentRosterAct).toHaveBeenCalledWith(2, {
        act: "order",
        ids: [3, 2],
      })
    )
    api.personalAgentRosterAct.mockClear()
    // Pressed low on its row, moved up over its own upper half: a drag,
    // but nowhere new (review round 1: not "before itself", the end).
    dragRow(
      "Dev",
      () => document.querySelector('[data-pa-roster-bot="2"]'),
      12,
      35
    )
    expect(document.querySelector("[data-pa-roster-ghost]")).toBeNull()
    await act(async () => {})
    expect(api.personalAgentRosterAct).not.toHaveBeenCalled()
  })

  it("leaves the middle pinned one where it is, let go over its own row", async () => {
    api.personalAgentBots.mockResolvedValue([
      entry(1, "Nova"),
      entry(2, "Dev", {}, { pinned_at: iso(-300), sort_order: 0 }),
      entry(3, "Ops", {}, { pinned_at: iso(-200), sort_order: 1 }),
      entry(5, "Ann", {}, { pinned_at: iso(-100), sort_order: 2 }),
    ])
    wrap(<PersonalAgentRoster compact={false} readOnly={false} />)
    await screen.findByText("Ann")
    for (const [name, top] of [
      ["Dev", 0],
      ["Ops", 40],
      ["Ann", 80],
    ] as const) {
      rowOf(name).getBoundingClientRect = () =>
        ({ top, bottom: top + 40, height: 40, left: 0, right: 200 }) as DOMRect
    }
    const row = rowOf("Ops")
    const undo = hitTesting(() => row)
    pointer("pointerdown", row, 10, 75)
    pointer("pointermove", row, 10, 50)
    // A drag, with no slot shown and the group not lit.
    expect(document.querySelector('[data-pa-roster-ghost="3"]')).toBeTruthy()
    expect(document.querySelector("[data-pa-roster-slot]")).toBeNull()
    expect(document.querySelector("[data-pa-drop-over]")).toBeNull()
    pointer("pointerup", row, 10, 50, 0)
    undo()
    await act(async () => {})
    expect(api.personalAgentRosterAct).not.toHaveBeenCalled()
  })

  it("names a new group for a row dropped on “new group”", async () => {
    api.personalAgentBots.mockResolvedValue([
      entry(1, "Nova"),
      entry(2, "Dev", {}, { pinned_at: iso(-100) }),
      entry(5, "Ann"),
    ])
    wrap(<PersonalAgentRoster compact={false} readOnly={false} />)
    await screen.findByText("Ann")
    dragRow("Dev", () => document.querySelector('[data-pa-drop="new"]'))
    const dialog = await screen.findByRole("dialog", { name: "New group" })
    fireEvent.change(within(dialog).getByLabelText("Group name"), {
      target: { value: "Release" },
    })
    fireEvent.click(within(dialog).getByRole("button", { name: "Move" }))
    await waitFor(() =>
      expect(api.personalAgentRosterAct.mock.calls).toEqual([
        [2, { act: "section", name: "Release" }],
        [2, { act: "unpin" }],
      ])
    )
  })

  it("opens a row pressed without moving, lets go where it was on Esc, and drags nothing read-only", async () => {
    api.personalAgentBots.mockResolvedValue([
      entry(1, "Nova"),
      entry(3, "Ops", {}, { section: "codeg" }),
      entry(5, "Ann"),
    ])
    const { unmount } = wrap(
      <PersonalAgentRoster compact={false} readOnly={false} />
    )
    await screen.findByText("Ann")
    const row = rowOf("Ann")
    // A press that hardly moves is a click.
    pointer("pointerdown", row, 10, 10)
    pointer("pointermove", row, 12, 11)
    pointer("pointerup", row, 12, 11, 0)
    fireEvent.click(row)
    expect(usePersonalAgentUi.getState().viewBot).toBe(5)
    // Esc lets go of it where it was: the rest of the press drags
    // nothing, and the click it ends in opens nothing.
    usePersonalAgentUi.setState({ viewBot: null })
    const undo = hitTesting(() => screen.getByText("Ops"))
    pointer("pointerdown", row, 10, 10)
    pointer("pointermove", row, 10, 40)
    expect(document.querySelector("[data-pa-drop-over]")).toBeTruthy()
    fireEvent.keyDown(window, { key: "Escape" })
    expect(document.querySelector("[data-pa-roster-ghost]")).toBeNull()
    pointer("pointermove", row, 10, 60)
    expect(document.querySelector("[data-pa-roster-ghost]")).toBeNull()
    pointer("pointerup", row, 10, 60, 0)
    fireEvent.click(row)
    expect(usePersonalAgentUi.getState().viewBot).toBeNull()
    undo()
    await act(async () => {})
    expect(api.personalAgentRosterAct).not.toHaveBeenCalledWith(5, {
      act: "section",
      name: "codeg",
    })
    unmount()
    // Read-only: no drag at all.
    wrap(<PersonalAgentRoster compact={false} readOnly />)
    await screen.findByText("Ann")
    dragRow("Ann", () => screen.getByText("Ops"))
    await act(async () => {})
    expect(api.personalAgentRosterAct).not.toHaveBeenCalledWith(5, {
      act: "section",
      name: "codeg",
    })
  })

  it("moves a pinned one to a group from its menu, where it then shows", async () => {
    api.personalAgentBots.mockResolvedValue([
      entry(1, "Nova"),
      entry(2, "Dev", {}, { pinned_at: iso(-100), section: "codeg" }),
      entry(3, "Ops", {}, { section: "codeg" }),
    ])
    wrap(<PersonalAgentRoster compact={false} readOnly={false} />)
    await screen.findByText("Dev")
    fireEvent.contextMenu(screen.getByText("Dev"))
    const menu = await screen.findByRole("menu")
    fireEvent.click(
      within(menu).getByRole("menuitem", { name: "Move to group" })
    )
    // Its own group too: it is pinned, so it shows elsewhere for now.
    const codeg = await screen.findByRole("menuitem", { name: "codeg" })
    expect(codeg.getAttribute("data-disabled")).toBeNull()
    fireEvent.click(codeg)
    await waitFor(() =>
      expect(api.personalAgentRosterAct.mock.calls).toEqual([
        [2, { act: "unpin" }],
      ])
    )
  })
})

describe("the roster's store (review round 1)", () => {
  it("keeps a push newer than a read that was on its way, and one that came before the first read", () => {
    const store = usePersonalAgentRoster.getState()
    // Pushed before anything was read.
    store.applyLive(live(2, { attention: "needs_you", updated_at: iso(50) }))
    store.setEntries([
      entry(1, "Nova"),
      entry(2, "Dev", { updated_at: iso(10) }),
    ])
    expect(
      usePersonalAgentRoster.getState().entries!.find((e) => e.id === 2)!.live
        .attention
    ).toBe("needs_you")
    // A read that left before a newer push lands after it.
    usePersonalAgentRoster
      .getState()
      .applyLive(live(2, { attention: "unread", updated_at: iso(100) }))
    usePersonalAgentRoster
      .getState()
      .setEntries([entry(1, "Nova"), entry(2, "Dev", { updated_at: iso(60) })])
    expect(
      usePersonalAgentRoster.getState().entries!.find((e) => e.id === 2)!.live
        .attention
    ).toBe("unread")
    // An older push does not undo a newer read.
    usePersonalAgentRoster
      .getState()
      .setEntries([
        entry(2, "Dev", { attention: "none", updated_at: iso(200) }),
      ])
    usePersonalAgentRoster
      .getState()
      .applyLive(live(2, { attention: "needs_you", updated_at: iso(150) }))
    expect(usePersonalAgentRoster.getState().entries![0].live.attention).toBe(
      "none"
    )
  })

  it("is read again now and then where another process runs the assistants", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    api.personalAgentBots.mockResolvedValue([
      entry(1, "Nova", { activity_known: false }),
    ])
    wrap(<PersonalAgentRoster compact={false} readOnly />)
    await screen.findByText("Nova")
    const reads = api.personalAgentBots.mock.calls.length
    await act(async () => {
      vi.advanceTimersByTime(ELSEWHERE_POLL_MS + 200)
    })
    await waitFor(() =>
      expect(api.personalAgentBots.mock.calls.length).toBeGreaterThan(reads)
    )
  })

  it("leaves the open one marked when the owner marks it", async () => {
    api.personalAgentBots.mockResolvedValue([entry(1, "Nova"), entry(2, "Dev")])
    usePersonalAgentUi.setState({ viewBot: 2 })
    wrap(<PersonalAgentRoster compact={false} readOnly={false} />)
    await screen.findByText("Dev")
    act(() =>
      usePersonalAgentRoster
        .getState()
        .setEntries([
          entry(1, "Nova"),
          entry(2, "Dev", {}, { unread_mark: true }),
        ])
    )
    await new Promise((r) => setTimeout(r, 30))
    expect(api.personalAgentRosterAct).not.toHaveBeenCalledWith(2, {
      act: "mark_read",
    })
  })
})

describe("the status line", () => {
  const busy = (kind: string, patch: Partial<BotLive> = {}) =>
    live(1, {
      work: "busy",
      face: kind === "think" ? "thinking" : "working",
      expires_at: iso(30_000),
      activity: {
        step: {
          n: 2,
          kind,
          target: "parser.rs",
          started_at: iso(0),
          status: "in_progress",
        },
        turn: 5,
      },
      ...patch,
    })

  it("says what the turn is on, the vague only once it has lasted, and lists the turn's steps", async () => {
    api.personalAgentBots.mockResolvedValue([entry(1, "Nova", busy("edit"))])
    pa.snapshot = {
      agent: {
        id: 1,
        name: "Nova",
        avatar: { kind: "face", shape: "blob", color: "black" },
      },
      status: {
        engine: "here",
        connected: true,
        turn: { batch_id: 5, kind: "delivery" },
      },
    }
    api.personalAgentTurnSteps.mockResolvedValue([
      {
        n: 1,
        kind: "read",
        target: "AGENTS.md",
        started_at: iso(0),
        status: "completed",
      },
      {
        n: 2,
        kind: "edit",
        target: "parser.rs",
        started_at: iso(0),
        status: "completed",
        added: 14,
        removed: 10,
      },
    ])
    wrap(<StatusLine botId={1} name="Nova" />)
    const text = await screen.findByText("Editing parser.rs")
    expect(text.className).toContain("activity-shimmer")
    // A vague step: the specific one stays till it has lasted.
    vi.useFakeTimers({ shouldAdvanceTime: true })
    act(() =>
      usePersonalAgentRoster
        .getState()
        .applyLive(busy("think", { updated_at: iso(100) }))
    )
    expect(screen.getByText("Editing parser.rs")).toBeTruthy()
    act(() => {
      vi.advanceTimersByTime(VAGUE_DELAY_MS + 10)
    })
    expect(
      document.querySelector("[data-pa-status-text]")!.textContent
    ).toMatch(/Thinking|Mulling|Working out/)
    vi.useRealTimers()
    // Its steps.
    fireEvent.click(screen.getByRole("button", { expanded: false }))
    expect(await screen.findByText("Edited parser.rs +14 −10")).toBeTruthy()
    expect(screen.getByText("Read AGENTS.md")).toBeTruthy()
    // And the turn can be stopped from here.
    fireEvent.click(screen.getByRole("button", { name: "Stop the reply" }))
    expect(api.personalAgentCancel).toHaveBeenCalled()
  })

  it("shows three dots, and no chevron, while a turn just begun has nothing to say", async () => {
    api.personalAgentBots.mockResolvedValue([entry(1, "Nova", busy("think"))])
    pa.snapshot = {
      agent: {
        id: 1,
        name: "Nova",
        avatar: { kind: "face", shape: "blob", color: "black" },
      },
      status: {
        engine: "here",
        connected: true,
        turn: { batch_id: 5, kind: "delivery" },
      },
    }
    wrap(<StatusLine botId={1} name="Nova" />)
    const line = await waitFor(() => {
      const found = document.querySelector("[data-pa-status-line]")
      expect(found?.querySelector("[data-pa-status-dots]")).toBeTruthy()
      return found!
    })
    expect(line.querySelectorAll("[data-pa-status-dots] > span").length).toBe(3)
    expect(line.querySelector(".lucide-chevron-down")).toBeNull()
    // Read out once there is something to say; the dots give way to it.
    expect(
      line.querySelector("[data-pa-status-text]")!.getAttribute("aria-live")
    ).toBe("polite")
    await waitFor(
      () =>
        expect(
          line.querySelector("[data-pa-status-text]")!.textContent
        ).toMatch(/Thinking|Mulling|Working out/),
      { timeout: VAGUE_DELAY_MS + 1000 }
    )
    expect(line.querySelector("[data-pa-status-dots]")).toBeNull()
    expect(line.querySelector(".lucide-chevron-down")).toBeTruthy()
  })

  it("folds away when its state went stale, whatever an old snapshot says", async () => {
    api.personalAgentBots.mockResolvedValue([
      entry(1, "Nova", busy("think", { expires_at: iso(-1000) })),
    ])
    pa.snapshot = {
      agent: {
        id: 1,
        name: "Nova",
        avatar: { kind: "face", shape: "blob", color: "black" },
      },
      status: {
        engine: "here",
        connected: true,
        turn: { batch_id: 5, kind: "delivery" },
      },
    }
    wrap(<StatusLine botId={1} name="Nova" />)
    await waitFor(() => expect(api.personalAgentBots).toHaveBeenCalled())
    await new Promise((r) => setTimeout(r, VAGUE_DELAY_MS + 100))
    expect(document.querySelector("[data-pa-status-line]")).toBeNull()
  })

  it("folds away when nothing runs", async () => {
    api.personalAgentBots.mockResolvedValue([entry(1, "Nova")])
    wrap(<StatusLine botId={1} name="Nova" />)
    await waitFor(() => expect(api.personalAgentBots).toHaveBeenCalled())
    expect(document.querySelector("[data-pa-status-line]")).toBeNull()
  })
})

function ownerRow(patch: Partial<TimelineRow>): TimelineRow {
  return {
    id: 30,
    segment_id: null,
    batch_id: null,
    kind: "owner",
    status: "queued",
    body: "Fix the login",
    data: null,
    dispatch_id: null,
    ref_id: null,
    reply_to: null,
    read_at: null,
    event_id: null,
    seen_at: null,
    created_at: iso(0),
    updated_at: iso(0),
    ...patch,
  }
}

function ownerItem(row: TimelineRow) {
  return buildMessageItems([row]).find((i) => i.kind === "owner") as Extract<
    MessageItem,
    { kind: "owner" }
  >
}

describe("the owner's message", () => {
  it("gets a 👍 once taken, popping on only when it comes while shown", () => {
    const { rerender } = wrap(<OwnerBubble item={ownerItem(ownerRow({}))} />)
    expect(document.querySelector("[data-pa-received]")).toBeNull()
    rerender(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <PageScopeContext.Provider value={scope}>
          <OwnerBubble
            item={ownerItem(
              ownerRow({ status: "delivered", read_at: iso(500) })
            )}
          />
        </PageScopeContext.Provider>
      </NextIntlClientProvider>
    )
    const mark = document.querySelector("[data-pa-received]")!
    expect(mark.textContent).toBe("👍")
    expect(mark.className).toContain("motion-pop")
    cleanup()
    wrap(
      <OwnerBubble
        item={ownerItem(ownerRow({ status: "delivered", read_at: iso(500) }))}
      />
    )
    expect(
      document.querySelector("[data-pa-received]")!.className
    ).not.toContain("motion-pop")
  })

  it("says what it waits for after two seconds", () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    pa.snapshot = {
      agent: { id: 1, name: "Nova" },
      status: { engine: "here", connected: false, turn: null },
    }
    // Sent just now.
    wrap(
      <OwnerBubble
        item={ownerItem(ownerRow({ created_at: new Date().toISOString() }))}
      />
    )
    expect(document.querySelector("[data-pa-wait-note]")).toBeNull()
    act(() => {
      vi.advanceTimersByTime(2100)
    })
    expect(document.querySelector("[data-pa-wait-note]")!.textContent).toBe(
      "Waking Nova…"
    )
    cleanup()
    pa.snapshot = {
      agent: { id: 1, name: "Nova" },
      status: {
        engine: "here",
        connected: true,
        turn: { batch_id: 3, kind: "delivery", for_owner: false },
      },
    }
    wrap(<OwnerBubble item={ownerItem(ownerRow({ created_at: iso(-5000) }))} />)
    expect(document.querySelector("[data-pa-wait-note]")!.textContent).toBe(
      "Making way"
    )
  })
})

describe("the pill of what needs the owner", () => {
  it("counts the cards waiting for them, where each is drawn", () => {
    const row = (
      id: number,
      kind: TimelineRow["kind"],
      data: Record<string, unknown>
    ) => ownerRow({ id, kind, data, status: null, body: "x" })
    expect(waitsForOwner(row(1, "question", { state: "pending" }))).toBe(true)
    expect(waitsForOwner(row(2, "question", { state: "answered" }))).toBe(false)
    expect(
      waitsForOwner(row(3, "notice", { notice: "choice", state: "open" }))
    ).toBe(true)
    expect(
      waitsForOwner(
        row(4, "notice", { notice: "proposal", state: "open", why: "suggest" })
      )
    ).toBe(false)
    expect(
      waitsForOwner(row(5, "notice", { notice: "stopped", state: "open" }))
    ).toBe(false)
    const items = buildMessageItems([
      row(10, "notice", { notice: "loop", state: "open" }),
      row(11, "notice", { notice: "changed", state: "applied" }),
    ])
    expect(ownerWaitTargets(items)).toEqual([10])
  })
})
