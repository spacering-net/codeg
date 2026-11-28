import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import type { ContextType } from "react"
import { StreamdownContext } from "streamdown"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import { cardIdOf } from "@/lib/json-render/pa-spec"
import type { ItemInfo, RosterEntry, TimelineRow } from "@/lib/types"
import {
  __resetRosterForTests,
  usePersonalAgentRoster,
} from "@/stores/personal-agent-roster-store"
import { usePersonalAgentUi } from "@/stores/personal-agent-ui-store"

const gesture = vi.hoisted(() => ({ trusted: true }))
vi.mock("./pa-gesture", () => ({ isOwnerGesture: () => gesture.trusted }))

const api = vi.hoisted(() => ({
  personalAgentSend: vi.fn(),
  personalAgentCardAct: vi.fn(),
  personalAgentItemAct: vi.fn(),
  personalAgentItems: vi.fn(),
  personalAgentDispatches: vi.fn(),
  personalAgentThread: vi.fn(),
  personalAgentConversationTarget: vi.fn(),
}))
vi.mock("@/lib/api", () => api)
vi.mock("@/contexts/personal-agent-context", () => ({
  useBotId: () => 7,
  usePersonalAgent: () => ({
    botId: 7,
    itemVersion: 0,
    dispatchById: new Map(),
    snapshot: { agent: { id: 7 } },
  }),
}))
vi.mock("@/contexts/workbench-route-context", () => ({
  useWorkbenchRoute: () => ({ setRoute: vi.fn(), openConversations: vi.fn() }),
}))
vi.mock("@/contexts/tab-context", () => ({
  useTabActions: () => ({ openTab: vi.fn() }),
}))
vi.mock("@/components/ai-elements/link-safety", () => ({
  useStreamdownLinkSafety: () => ({ enabled: true }),
  openLinkWithSafety: vi.fn(),
  openExternalTab: vi.fn(),
}))

import { PaReplyScope } from "./pa-card-scope"
import PaJsonRenderBlock from "./pa-json-render-block"
import { PageScopeContext, type PageScope } from "./shared"

const line = (patch: object) => JSON.stringify(patch)
const el = (key: string, value: object) =>
  line({ op: "add", path: `/elements/${key}`, value })

/** A card: a root Stack over the given elements, in order. */
function card(elements: Record<string, object>, state?: object): string {
  const lines = [
    line({ op: "add", path: "/root", value: "main" }),
    el("main", {
      type: "Stack",
      props: {},
      children: Object.keys(elements).filter((k) => !k.startsWith("_")),
    }),
    ...Object.entries(elements).map(([k, v]) => el(k.replace(/^_/, ""), v)),
  ]
  if (state) {
    for (const [k, v] of Object.entries(state)) {
      lines.push(line({ op: "add", path: `/state/${k}`, value: v }))
    }
  }
  return lines.join("\n")
}

const button = (label: string, on?: object, extra: object = {}) => ({
  type: "Button",
  props: { label },
  ...(on ? { on } : {}),
  children: [],
  ...extra,
})
const reply = (params: object = {}) => ({
  press: { action: "pa.reply", params },
})

function replyRow(data: Record<string, unknown> = {}): TimelineRow {
  return {
    id: 120,
    segment_id: null,
    batch_id: 3,
    kind: "reply",
    status: null,
    body: "",
    data: { state: "done", ...data },
    dispatch_id: null,
    ref_id: null,
    reply_to: null,
    read_at: null,
    event_id: null,
    seen_at: null,
    created_at: "2026-11-11T10:00:00Z",
    updated_at: "2026-11-11T10:00:00Z",
  }
}

const onDraft = vi.fn()
function scope(over: Partial<PageScope> = {}): PageScope {
  return {
    readOnly: false,
    agentName: "G",
    liveRowId: null,
    connectionId: null,
    agentType: null,
    onQuote: vi.fn(),
    onDraft,
    jumpTo: vi.fn(),
    rowsById: new Map(),
    ...over,
  }
}

const STATIC = { mode: "static" } as unknown as ContextType<
  typeof StreamdownContext
>

function draw(
  source: string,
  {
    row = replyRow(),
    running = false,
    page = scope(),
    readOnly = false,
  }: {
    row?: TimelineRow
    running?: boolean
    page?: PageScope
    readOnly?: boolean
  } = {}
) {
  const tree = (r: TimelineRow) => (
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <PageScopeContext.Provider value={page}>
        <StreamdownContext.Provider value={STATIC}>
          <PaReplyScope row={r} running={running} readOnly={readOnly}>
            <PaJsonRenderBlock source={source} fallback={<pre>code</pre>} />
          </PaReplyScope>
        </StreamdownContext.Provider>
      </PageScopeContext.Provider>
    </NextIntlClientProvider>
  )
  const view = render(tree(row))
  return { ...view, again: (r: TimelineRow) => view.rerender(tree(r)) }
}

function item(id: number): ItemInfo {
  return {
    id,
    kind: "followup",
    dispatch_id: null,
    status: "open",
    waits_for: null,
    summary: `Matter ${id}`,
    on_done: null,
    origin_timeline_id: null,
    created_at: "2026-11-11T10:00:00Z",
    updated_at: "2026-11-11T10:00:00Z",
  } as unknown as ItemInfo
}

beforeEach(() => {
  gesture.trusted = true
  for (const fn of Object.values(api)) fn.mockReset()
  api.personalAgentSend.mockResolvedValue(replyRow())
  api.personalAgentCardAct.mockResolvedValue(replyRow())
  api.personalAgentItemAct.mockResolvedValue(item(5))
  api.personalAgentItems.mockResolvedValue([item(5)])
  onDraft.mockReset()
  onDraft.mockReturnValue(true)
})
afterEach(() => vi.useRealTimers())

describe("an assistant's card: pa.reply", () => {
  it("says the button's label once, quoting the reply, on the owner's click", async () => {
    const src = card({ a: button("Go with plan A", reply()) })
    draw(src)
    const go = screen.getByRole("button", { name: "Go with plan A" })
    fireEvent.click(go)
    fireEvent.click(go)
    await waitFor(() => expect(api.personalAgentSend).toHaveBeenCalledTimes(1))
    expect(api.personalAgentSend).toHaveBeenCalledWith(
      "Go with plan A",
      null,
      120,
      7,
      { element: `${cardIdOf(src)}/a`, label: "Go with plan A" }
    )
  })

  it("does nothing for a click that is not the owner's", async () => {
    gesture.trusted = false
    draw(card({ a: button("Go", reply()) }))
    fireEvent.click(screen.getByRole("button", { name: "Go" }))
    await act(async () => {})
    expect(api.personalAgentSend).not.toHaveBeenCalled()
  })

  it("never speaks from a watch or a chain, and says it removed them", async () => {
    const src = card(
      {
        field: {
          type: "Input",
          props: { label: "Name", name: "n", value: { $bindState: "/n" } },
          watch: { "/n": { action: "pa.reply", params: { text: "watched" } } },
          children: [],
        },
        chained: button("Save", {
          press: {
            action: "setState",
            params: { statePath: "/saved", value: true },
            onSuccess: { action: "pa.reply", params: { text: "chained" } },
          },
        }),
      },
      { n: "" }
    )
    draw(src)
    expect(
      screen.getByText("Removed actions that would run without your click")
    ).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "x" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Save" }))
    await act(async () => {})
    expect(api.personalAgentSend).not.toHaveBeenCalled()
  })

  it("shows a different text in full first, to send or edit", async () => {
    const src = card(
      {
        a: button(
          "Send the form",
          reply({ text: { $template: "Name: ${/n}" } })
        ),
      },
      { n: "Ada" }
    )
    draw(src)
    fireEvent.click(screen.getByRole("button", { name: "Send the form" }))
    expect(await screen.findByText("Name: Ada")).toBeInTheDocument()
    expect(api.personalAgentSend).not.toHaveBeenCalled()
    fireEvent.click(
      screen.getByRole("button", { name: "Put in the input box" })
    )
    expect(onDraft).toHaveBeenCalledWith(120, "Name: Ada")
    // Not taken (the box is sending): the confirmation stays, its text too.
    onDraft.mockReturnValueOnce(false)
    fireEvent.click(screen.getByRole("button", { name: "Send the form" }))
    fireEvent.click(
      await screen.findByRole("button", { name: "Put in the input box" })
    )
    expect(screen.getByText("Name: Ada")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }))
    fireEvent.click(screen.getByRole("button", { name: "Send the form" }))
    fireEvent.click(await screen.findByRole("button", { name: "Send" }))
    await waitFor(() =>
      expect(api.personalAgentSend).toHaveBeenCalledWith(
        "Name: Ada",
        null,
        120,
        7,
        { element: `${cardIdOf(src)}/a`, label: "Send the form" }
      )
    )
  })

  it("keeps what was picked: chosen, its siblings greyed, after a reload", () => {
    const src = [
      line({ op: "add", path: "/root", value: "main" }),
      el("main", { type: "Stack", props: {}, children: ["pick", "other"] }),
      el("pick", { type: "Stack", props: {}, children: ["a", "b"] }),
      el("other", { type: "Stack", props: {}, children: ["c"] }),
      el("a", button("Plan A", reply())),
      el("b", button("Plan B", reply())),
      el("c", button("Later", reply())),
    ].join("\n")
    const id = cardIdOf(src)
    draw(src, {
      row: replyRow({
        card_acts: {
          [`${id}/a`]: { action: "pa.reply", label: "Plan A", at: "x" },
        },
      }),
    })
    const a = screen.getByRole("button", { name: "Plan A" })
    expect(a).toBeDisabled()
    expect(a).toHaveAttribute("aria-pressed", "true")
    expect(screen.getByRole("button", { name: "Plan B" })).toBeDisabled()
    expect(screen.getByRole("button", { name: "Later" })).toBeEnabled()
  })

  it("waits while the reply is still written, and on a page that only reads", () => {
    const src = card({ a: button("Go", reply()) })
    const { unmount } = draw(src, { running: true })
    expect(screen.getByRole("button", { name: "Go" })).toBeDisabled()
    unmount()
    draw(src, { page: scope({ readOnly: true }) })
    expect(screen.getByRole("button", { name: "Go" })).toBeDisabled()
  })
})

describe("an assistant's card in what its turn said on the way (P6)", () => {
  it("draws its buttons and links, and none of them does anything", async () => {
    const src = card({
      a: button("Go with plan A", reply()),
      b: button("Done", {
        press: { action: "pa.item", params: { item_id: 5, op: "done" } },
      }),
      c: button("Open the task", {
        press: { action: "pa.open", params: { target: "task", id: 3 } },
      }),
      d: {
        type: "Link",
        props: { label: "The docs", href: "https://example.com/docs" },
        children: [],
      },
    })
    draw(src, { readOnly: true })
    for (const name of ["Go with plan A", "Done", "Open the task"]) {
      const b = screen.getByRole("button", { name })
      expect((b as HTMLButtonElement).disabled).toBe(true)
      fireEvent.click(b)
    }
    const link = screen.getByText("The docs")
    expect(link.closest("a")).toBeNull()
    expect(link.getAttribute("aria-disabled")).toBe("true")
    fireEvent.click(link)
    await act(async () => {})
    expect(api.personalAgentSend).not.toHaveBeenCalled()
    expect(api.personalAgentItemAct).not.toHaveBeenCalled()
    expect(onDraft).not.toHaveBeenCalled()
    expect(usePersonalAgentUi.getState().workOpen).not.toBe(true)
  })
})

describe("an assistant's card: pa.item", () => {
  it("is not there for a matter that is not this assistant's open one", async () => {
    draw(
      card({
        a: button("Done", {
          press: { action: "pa.item", params: { id: 9, op: "done" } },
        }),
      })
    )
    await waitFor(() => expect(api.personalAgentItems).toHaveBeenCalled())
    await act(async () => {})
    expect(screen.getByRole("button", { name: "Done" })).toBeDisabled()
  })

  it("snoozes one until the time the button names", async () => {
    const src = card({
      a: button("In an hour", {
        press: {
          action: "pa.item",
          params: { id: 5, op: "snooze", until: "1h" },
        },
      }),
      b: button("Later", {
        press: { action: "pa.item", params: { id: 5, op: "snooze" } },
      }),
      c: button("Odd", {
        press: {
          action: "pa.item",
          params: { id: 5, op: "snooze", until: "x".repeat(65) },
        },
      }),
    })
    draw(src)
    const hour = screen.getByRole("button", { name: "In an hour" })
    await waitFor(() => expect(hour).toBeEnabled())
    // An `until` that is not a short string is not offered.
    expect(screen.getByRole("button", { name: "Odd" })).toBeDisabled()
    fireEvent.click(hour)
    await waitFor(() =>
      expect(api.personalAgentItemAct).toHaveBeenCalledWith(
        7,
        5,
        "snooze",
        "1h",
        "card"
      )
    )
    await waitFor(() =>
      expect(api.personalAgentCardAct).toHaveBeenCalledWith(
        7,
        120,
        `${cardIdOf(src)}/a`,
        { action: "pa.item", label: "In an hour", op: "snooze" }
      )
    )
    // Without one, it waits on time with no due.
    fireEvent.click(screen.getByRole("button", { name: "Later" }))
    await waitFor(() =>
      expect(api.personalAgentItemAct).toHaveBeenLastCalledWith(
        7,
        5,
        "snooze",
        undefined,
        "card"
      )
    )
  })

  it("closes one without a turn, and the card keeps it", async () => {
    const src = card({
      a: button("Done", {
        press: { action: "pa.item", params: { id: 5, op: "done" } },
      }),
    })
    draw(src)
    const done = screen.getByRole("button", { name: "Done" })
    await waitFor(() => expect(done).toBeEnabled())
    fireEvent.click(done)
    await waitFor(() =>
      expect(api.personalAgentCardAct).toHaveBeenCalledWith(
        7,
        120,
        `${cardIdOf(src)}/a`,
        { action: "pa.item", label: "Done", op: "done" }
      )
    )
    // A card's press is the card's: not taken back from the panel.
    expect(api.personalAgentItemAct).toHaveBeenCalledWith(
      7,
      5,
      "done",
      undefined,
      "card"
    )
  })

  it("asks before dropping one", async () => {
    draw(
      card({
        a: button("Drop", {
          press: { action: "pa.item", params: { id: 5, op: "drop" } },
        }),
      })
    )
    const drop = screen.getByRole("button", { name: "Drop" })
    await waitFor(() => expect(drop).toBeEnabled())
    fireEvent.click(drop)
    expect(await screen.findByText("Drop this matter?")).toBeInTheDocument()
    expect(api.personalAgentItemAct).not.toHaveBeenCalled()
    const confirm = screen
      .getAllByRole("button", { name: "Drop" })
      .find((b) => b.hasAttribute("data-pa-card-drop"))!
    fireEvent.click(confirm)
    await waitFor(() =>
      expect(api.personalAgentItemAct).toHaveBeenCalledWith(
        7,
        5,
        "drop",
        undefined,
        "card"
      )
    )
  })
})

describe("an assistant's card: pa.open", () => {
  it("is not there without a place to go", () => {
    draw(
      card({
        a: button("Open", {
          press: { action: "pa.open", params: { target: "session" } },
        }),
        b: button("Somewhere", {
          press: { action: "pa.open", params: { target: "nowhere", id: 2 } },
        }),
      })
    )
    expect(screen.getByRole("button", { name: "Open" })).toBeDisabled()
    expect(screen.getByRole("button", { name: "Somewhere" })).toBeDisabled()
  })

  it("opens the panel on its activity, for a matter", () => {
    usePersonalAgentUi.setState({ auxOpen: false, auxTab: "stats" })
    draw(
      card({
        a: button("See the matter", {
          press: { action: "pa.open", params: { target: "item", id: 3 } },
        }),
      })
    )
    fireEvent.click(screen.getByRole("button", { name: "See the matter" }))
    expect(usePersonalAgentUi.getState()).toMatchObject({
      auxOpen: true,
      auxTab: "activity",
    })
  })

  it("opens the activity's routines at the routine's row (6.9, C4)", () => {
    draw(
      card({
        a: button("See the routine", {
          press: { action: "pa.open", params: { target: "routine", id: 2 } },
        }),
      })
    )
    fireEvent.click(screen.getByRole("button", { name: "See the routine" }))
    expect(usePersonalAgentUi.getState().activityAsk).toMatchObject({
      group: "next",
      row: "routine:2",
      routine: true,
    })
    expect(usePersonalAgentUi.getState().auxTab).toBe("activity")
  })

  it("opens a session", async () => {
    api.personalAgentConversationTarget.mockResolvedValue({
      folder_id: 1,
      conversation_id: 44,
      agent_type: "claude_code",
      title: null,
    })
    draw(
      card({
        a: button("See it", {
          press: { action: "pa.open", params: { target: "session", id: 44 } },
        }),
      })
    )
    fireEvent.click(screen.getByRole("button", { name: "See it" }))
    await waitFor(() =>
      expect(api.personalAgentConversationTarget).toHaveBeenCalledWith(44)
    )
    expect(api.personalAgentSend).not.toHaveBeenCalled()
  })
})

describe("an assistant's card: a list", () => {
  const needs = [
    { key: "t1", text: "Task 1 failed", label: "Open task 1" },
    { key: "t2", text: "Task 2 waits", label: "Open task 2" },
  ]
  /** A brief's list: a line and its buttons, repeated over the state. */
  function listCard(buttons: Record<string, object>): string {
    return [
      line({ op: "add", path: "/root", value: "main" }),
      el("main", {
        type: "Card",
        props: { title: "Brief" },
        children: ["head", "list", "after"],
      }),
      el("head", {
        type: "Heading",
        props: { text: "Needs you" },
        children: [],
      }),
      el("list", {
        type: "Stack",
        props: { gap: "md" },
        repeat: { statePath: "/needs", key: "key" },
        children: ["line", ...Object.keys(buttons)],
      }),
      el("line", {
        type: "Text",
        props: { text: { $item: "text" } },
        children: [],
      }),
      ...Object.entries(buttons).map(([k, v]) => el(k, v)),
      el(
        "after",
        button("See the matter", {
          press: { action: "pa.open", params: { target: "item", id: 3 } },
        })
      ),
      line({ op: "add", path: "/state/needs", value: needs }),
    ].join("\n")
  }

  it("draws each item on a card of its own, its button at its end, acting for that item", async () => {
    const src = listCard({
      go: {
        type: "Button",
        props: { label: { $item: "label" } },
        on: reply(),
        children: [],
      },
    })
    const { container } = draw(src)
    const items = container.querySelectorAll("[data-pa-card-item]")
    expect(items).toHaveLength(2)
    expect(items[0]).toHaveTextContent("Task 1 failed")
    expect(
      within(items[0] as HTMLElement).getByRole("button")
    ).toHaveAccessibleName("Open task 1")
    const second = within(items[1] as HTMLElement).getByRole("button", {
      name: "Open task 2",
    })
    // Its button sits after its line, smaller than one alone on the card.
    expect(second.parentElement?.previousElementSibling).toHaveTextContent(
      "Task 2 waits"
    )
    expect(second).toHaveAttribute("data-size", "sm")
    const alone = screen.getByRole("button", { name: "See the matter" })
    expect(alone.closest("[data-pa-card-item]")).toBeNull()
    expect(alone).toHaveAttribute("data-size", "default")
    fireEvent.click(second)
    await waitFor(() => expect(api.personalAgentSend).toHaveBeenCalledTimes(1))
    expect(api.personalAgentSend).toHaveBeenCalledWith(
      "Open task 2",
      null,
      120,
      7,
      { element: `${cardIdOf(src)}/go#/needs/1`, label: "Open task 2" }
    )
  })

  it("keeps a pick to its own item: the other choice of that item greyed, the other items' open", () => {
    const choice = (label: string) => ({
      type: "Button",
      props: { label },
      on: reply(),
      children: [],
    })
    const src = listCard({ yes: choice("Yes"), no: choice("No") })
    const id = cardIdOf(src)
    const { container } = draw(src, {
      row: replyRow({
        card_acts: {
          [`${id}/yes#/needs/0`]: { action: "pa.reply", label: "Yes", at: "x" },
        },
      }),
    })
    const [first, second] = Array.from(
      container.querySelectorAll<HTMLElement>("[data-pa-card-item]")
    )
    const yes = within(first).getByRole("button", { name: "Yes" })
    expect(yes).toBeDisabled()
    expect(yes).toHaveAttribute("aria-pressed", "true")
    expect(within(first).getByRole("button", { name: "No" })).toBeDisabled()
    expect(within(second).getByRole("button", { name: "Yes" })).toBeEnabled()
    expect(within(second).getByRole("button", { name: "No" })).toBeEnabled()
  })

  it("leads each row with the assistant it opens or its kind's icon, no surface of its own; a button to an assistant says so", () => {
    __resetRosterForTests()
    usePersonalAgentRoster.setState({
      entries: [
        {
          id: 5,
          kind: "worker",
          name: "Dev",
          avatar: { kind: "face", shape: "ring", color: "blue" },
        } as unknown as RosterEntry,
      ],
    })
    const src = [
      line({ op: "add", path: "/root", value: "main" }),
      el("main", { type: "Card", props: {}, children: ["list"] }),
      el("list", {
        type: "Stack",
        props: { gap: "md" },
        repeat: { statePath: "/needs", key: "key" },
        children: ["line", "go"],
      }),
      el("line", {
        type: "Text",
        props: { text: { $item: "text" } },
        children: [],
      }),
      el("go", {
        type: "Button",
        props: { label: { $item: "label" } },
        on: {
          press: {
            action: "pa.open",
            params: { target: { $item: "target" }, id: { $item: "id" } },
          },
        },
        children: [],
      }),
      line({
        op: "add",
        path: "/state/needs",
        value: [
          {
            key: "t4",
            text: "Task 4 failed",
            label: "Open task #4",
            target: "task",
            id: 4,
          },
          {
            key: "b5",
            text: "Dev waits",
            label: "Reply Dev",
            target: "bot",
            id: 5,
          },
          {
            key: "b6",
            text: "Dev's page to accept",
            label: "See the acceptance",
            target: "bot",
            id: 5,
          },
          {
            key: "b7",
            text: "Dev's page, again",
            label: "See Dev's acceptance page",
            target: "bot",
            id: 5,
          },
          {
            key: "b8",
            text: "Dev's page, approved?",
            label: "Verantwortungsbereich von Dev ansehen",
            target: "bot",
            id: 5,
          },
          {
            key: "x",
            text: "Somewhere odd",
            label: "Go",
            target: "constructor",
            id: 1,
          },
          {
            key: "d9",
            text: "Dispatch 9 waits",
            label: "打开派发（＃9）",
            target: "dispatch",
            id: 9,
          },
          {
            key: "n",
            text: "Only a number",
            label: "#3",
            target: "task",
            id: 3,
          },
          {
            key: "w",
            text: "Task 5, written wide",
            label: "打开任务（＃５）",
            target: "task",
            id: 5,
          },
          {
            key: "long",
            text: "A long label, no number",
            label: `Open ${" ".repeat(4000)}it #x`,
            target: "task",
            id: 6,
          },
        ],
      }),
    ].join("\n")
    const { container } = draw(src)
    const [
      task,
      bot,
      accept,
      again,
      approves,
      odd,
      dispatch,
      bare,
      wide,
      long,
    ] = Array.from(
      container.querySelectorAll<HTMLElement>("[data-pa-card-item]")
    )
    // No wash of their own: rows on the card, a hairline between them.
    expect(task.className).not.toContain("bg-")
    expect(bot.className).toContain("border-t")
    expect(task.parentElement?.className).toContain("gap-0")
    expect(task.querySelector("svg.lucide-square-kanban")).not.toBeNull()
    // The row's own line names what it opens: its button without the number.
    expect(within(task).getByRole("button")).toHaveAccessibleName("Open task")
    expect(within(dispatch).getByRole("button")).toHaveAccessibleName(
      "打开派发"
    )
    // Nothing left without it: its words as written.
    expect(within(bare).getByRole("button")).toHaveAccessibleName("#3")
    // Its digits written wide too.
    expect(within(wide).getByRole("button")).toHaveAccessibleName("打开任务")
    // No number at its end: its words as written.
    expect(within(long).getByRole("button").textContent).toBe(
      `Open ${" ".repeat(4000)}it #x`
    )
    expect(within(bot).getByRole("img", { name: "Dev" })).toBeTruthy()
    expect(within(bot).getByRole("button")).toHaveAccessibleName(
      "Reply to the assistant"
    )
    // One that says something else than the assistant's name keeps it —
    // more than a word to it, the name in its middle too.
    expect(within(accept).getByRole("button")).toHaveAccessibleName(
      "See the acceptance"
    )
    expect(within(again).getByRole("button")).toHaveAccessibleName(
      "See Dev's acceptance page"
    )
    // Its name and no word of answering — "antwort" inside another word is
    // none: its own words.
    expect(within(approves).getByRole("button")).toHaveAccessibleName(
      "Verantwortungsbereich von Dev ansehen"
    )
    // A place a card cannot open: the row stays, a neutral mark, its button
    // offered to no one.
    expect(odd).toHaveTextContent("Somewhere odd")
    expect(odd.querySelector("svg.lucide-circle-dot")).not.toBeNull()
    expect(within(odd).getByRole("button", { name: "Go" })).toBeDisabled()
    __resetRosterForTests()
  })

  it("sets the card's title off as its header, a part's heading close over what it heads", () => {
    const src = [
      line({ op: "add", path: "/root", value: "main" }),
      el("main", {
        type: "Card",
        props: { title: "Morning brief" },
        children: ["needs", "text", "inner"],
      }),
      el("needs", {
        type: "Heading",
        props: { text: "Needs you", level: "h3" },
        children: [],
      }),
      el("text", { type: "Text", props: { text: "x" }, children: [] }),
      el("inner", {
        type: "Card",
        props: { title: "Inside" },
        children: [],
      }),
    ].join("\n")
    const { container } = draw(src)
    const [outer, inner] = Array.from(
      container.querySelectorAll<HTMLElement>('[data-slot="card"]')
    )
    // Its title a band of its own, a hairline under it.
    expect(outer.className).toContain("[&>[data-slot=card-header]]:border-b")
    // The title centred in it: as much room over it as under it, the
    // header a column (the library's two-row grid left a gap under it).
    expect(outer.className).toContain("[&>[data-slot=card-header]]:py-3")
    expect(outer.className).toContain("has-[>[data-slot=card-header]]:pt-0")
    expect(outer.className.split(/\s+/)).toContain(
      "[&>[data-slot=card-header]]:flex"
    )
    // A part's heading half the card's gap over what it heads.
    expect(outer.className).toContain(
      "[&>[data-slot=card-content]>:is(h1,h2,h3,h4)+*]:-mt-1.5"
    )
    // A card inside it is one thing on it: no header band.
    expect(inner.className).not.toContain("border-b")
  })

  it("draws a line and the button that opens its thing as a row, not loose under it", () => {
    const src = [
      line({ op: "add", path: "/root", value: "main" }),
      el("main", {
        type: "Card",
        props: {},
        children: ["watch", "watchText", "done", "doneText", "doneButton"],
      }),
      el("watch", {
        type: "Heading",
        props: { text: "Watching", level: "h3" },
        children: [],
      }),
      el("watchText", {
        type: "Text",
        props: { text: "my-app has changes" },
        children: [],
      }),
      el("done", {
        type: "Heading",
        props: { text: "Done yesterday", level: "h3" },
        children: [],
      }),
      el("doneText", {
        type: "Text",
        props: { text: "Dispatch #13 · Tidy: done at 20:55" },
        children: [],
      }),
      el("doneButton", {
        type: "Button",
        props: { label: "See the result #13" },
        on: {
          press: { action: "pa.open", params: { target: "dispatch", id: 13 } },
        },
        children: [],
      }),
    ].join("\n")
    const { container } = draw(src)
    const rows = container.querySelectorAll<HTMLElement>("[data-pa-card-item]")
    expect(rows).toHaveLength(1)
    const [row] = rows
    // Led by the kind of place it opens, its subject over what about it,
    // its button at its end without the number its line names.
    expect(row.querySelector("svg.lucide-send")).not.toBeNull()
    expect(row).toHaveTextContent("Dispatch #13 · Tidy")
    expect(row).toHaveTextContent("done at 20:55")
    expect(within(row).getByRole("button")).toHaveAccessibleName(
      "See the result"
    )
    // Alone in its list: a hairline over and under it.
    expect(row.className).toContain("border-t")
    expect(row.className).toContain("last:border-b")
    expect(row.parentElement?.lastElementChild).toBe(row)
    // A line with nothing to open stays a line.
    expect(
      screen.getByText("my-app has changes").closest("[data-pa-card-item]")
    ).toBeNull()
  })

  it("says a reply button is to the assistant only on a row its face leads", () => {
    __resetRosterForTests()
    usePersonalAgentRoster.setState({
      entries: [
        {
          id: 5,
          kind: "worker",
          name: "Dev",
          avatar: { kind: "face", shape: "ring", color: "blue" },
        } as unknown as RosterEntry,
        {
          id: 6,
          kind: "worker",
          name: "QA",
          avatar: { kind: "face", shape: "ring", color: "green" },
        } as unknown as RosterEntry,
      ],
    })
    const src = [
      line({ op: "add", path: "/root", value: "main" }),
      el("main", { type: "Card", props: {}, children: ["list"] }),
      el("list", {
        type: "Stack",
        props: {},
        repeat: { statePath: "/needs", key: "key" },
        children: ["text", "dev", "qa"],
      }),
      el("text", {
        type: "Text",
        props: { text: { $item: "text" } },
        children: [],
      }),
      el("dev", {
        type: "Button",
        props: { label: "Reply to Dev" },
        visible: { $state: "/shown" },
        on: { press: { action: "pa.open", params: { target: "bot", id: 5 } } },
        children: [],
      }),
      el("qa", {
        type: "Button",
        props: { label: "Reply to QA" },
        on: { press: { action: "pa.open", params: { target: "bot", id: 6 } } },
        children: [],
      }),
      line({ op: "add", path: "/state/shown", value: true }),
      line({
        op: "add",
        path: "/state/needs",
        value: [{ key: "a", text: "Both wait" }],
      }),
    ].join("\n")
    const { container } = draw(src)
    const row = container.querySelector<HTMLElement>("[data-pa-card-item]")!
    // QA's face leads it (the opener always shown): QA's button says it is
    // to the assistant; Dev's, beside QA's face, names Dev still.
    expect(within(row).getByRole("img", { name: "QA" })).toBeTruthy()
    expect(
      within(row)
        .getAllByRole("button")
        .map((b) => b.textContent)
    ).toEqual(["Reply to Dev", "Reply to the assistant"])
    __resetRosterForTests()
  })

  it("keeps the numbers that tell a row's openers apart, and leads it by one always shown", () => {
    const open = (key: string, label: string, target: string, id: number) =>
      el(key, {
        type: "Button",
        props: { label },
        on: { press: { action: "pa.open", params: { target, id } } },
        children: [],
      })
    const src = [
      line({ op: "add", path: "/root", value: "main" }),
      el("main", {
        type: "Card",
        props: {},
        children: ["two", "s13", "s14", "hid", "maybe", "see"],
      }),
      el("two", {
        type: "Text",
        props: { text: "Compare the two sessions" },
        children: [],
      }),
      open("s13", "Open session #13", "session", 13),
      open("s14", "Open session #14", "session", 14),
      el("hid", {
        type: "Text",
        props: { text: "Its session" },
        children: [],
      }),
      el("maybe", {
        type: "Button",
        props: { label: "Reply to Dev" },
        visible: { $state: "/never" },
        on: { press: { action: "pa.open", params: { target: "bot", id: 5 } } },
        children: [],
      }),
      open("see", "Open session #15", "session", 15),
    ].join("\n")
    const { container } = draw(src)
    const [two] = Array.from(
      container.querySelectorAll<HTMLElement>("[data-pa-card-item]")
    )
    // Two openers on one row: each keeps the number that tells them apart.
    expect(
      within(two)
        .getAllByRole("button")
        .map((b) => b.textContent)
    ).toEqual(["Open session #13", "Open session #14"])
    // A button shown only now and then is no part of a row: the line before
    // it stays a line, the button after it as written, no face of Dev's.
    expect(
      screen.getByText("Its session").closest("[data-pa-card-item]")
    ).toBeNull()
    expect(container.querySelectorAll("[data-pa-card-item]")).toHaveLength(1)
    expect(
      screen.getByRole("button", { name: "Open session #15" })
    ).toBeTruthy()
  })

  it("sets an item's subject over what about it, a hairline over and under each row", () => {
    const src = [
      line({ op: "add", path: "/root", value: "main" }),
      el("main", {
        type: "Card",
        props: {},
        children: ["list", "two", "three"],
      }),
      el("list", {
        type: "Stack",
        props: { gap: "md" },
        repeat: { statePath: "/needs", key: "key" },
        children: ["line", "go"],
      }),
      el("line", {
        type: "Text",
        props: { text: { $item: "text" } },
        children: [],
      }),
      el("go", button("Open", { press: { action: "pa.reply" } })),
      // An item of two lines of its own, one of words in a Stack: as
      // written.
      el("two", {
        type: "Stack",
        props: {},
        repeat: { statePath: "/two", key: "key" },
        children: ["a", "b", "go2"],
      }),
      el("three", {
        type: "Stack",
        props: {},
        repeat: { statePath: "/two", key: "key" },
        children: ["words", "go3"],
      }),
      el("words", { type: "Stack", props: {}, children: ["w1", "w2"] }),
      el("w1", { type: "Text", props: { text: "Ops: one" }, children: [] }),
      el("w2", { type: "Text", props: { text: "Ops: two" }, children: [] }),
      el("go3", button("Go", { press: { action: "pa.reply" } })),
      el("a", { type: "Text", props: { text: "Dev: waits" }, children: [] }),
      el("b", { type: "Text", props: { text: "since Monday" }, children: [] }),
      el("go2", button("Reply", { press: { action: "pa.reply" } })),
      line({
        op: "add",
        path: "/state/needs",
        value: [
          { key: "a", text: "任务 #1 · 改标题：失败，等了 8 天" },
          { key: "b", text: "Dev: waiting 3 days for you" },
          { key: "c", text: "Build at 10:30 failed" },
          { key: "d", text: "It failed. Look at it: now" },
        ],
      }),
      line({ op: "add", path: "/state/two", value: [{ key: "k" }] }),
    ].join("\n")
    const { container } = draw(src)
    const rows = Array.from(
      container.querySelectorAll<HTMLElement>("[data-pa-card-item]")
    )
    const lines = (row: HTMLElement) =>
      Array.from(row.querySelectorAll("p")).map((p) => p.textContent)
    expect(lines(rows[0])).toEqual(["任务 #1 · 改标题", "失败，等了 8 天"])
    expect(rows[0].querySelector("p")?.className).toContain(
      "text-muted-foreground"
    )
    expect(lines(rows[1])).toEqual(["Dev", "waiting 3 days for you"])
    // No colon of a subject's: one line as written.
    expect(lines(rows[2])).toEqual(["Build at 10:30 failed"])
    expect(lines(rows[3])).toEqual(["It failed. Look at it: now"])
    expect(lines(rows[4])).toEqual(["Dev: waits", "since Monday"])
    expect(lines(rows[5])).toEqual(["Ops: one", "Ops: two"])
    // Each row the line over it; the last of a list the one under it too.
    for (const r of rows) expect(r.className).toContain("border-t")
    expect(rows[0].className).toContain("last:border-b")
  })
})
