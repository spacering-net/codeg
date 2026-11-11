import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import type { ContextType } from "react"
import { StreamdownContext } from "streamdown"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import { cardIdOf } from "@/lib/json-render/pa-spec"
import type { ItemInfo, TimelineRow } from "@/lib/types"

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
  }: { row?: TimelineRow; running?: boolean; page?: PageScope } = {}
) {
  const tree = (r: TimelineRow) => (
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <PageScopeContext.Provider value={page}>
        <StreamdownContext.Provider value={STATIC}>
          <PaReplyScope row={r} running={running}>
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

  it("offers no snooze until a set time before matters have due times", async () => {
    draw(
      card({
        a: button("Later", {
          press: { action: "pa.item", params: { id: 5, op: "snooze" } },
        }),
        b: button("In an hour", {
          press: {
            action: "pa.item",
            params: { id: 5, op: "snooze", until: "1h" },
          },
        }),
      })
    )
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Later" })).toBeEnabled()
    )
    expect(screen.getByRole("button", { name: "In an hour" })).toBeDisabled()
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
    expect(api.personalAgentItemAct).toHaveBeenCalledWith(7, 5, "done")
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
      expect(api.personalAgentItemAct).toHaveBeenCalledWith(7, 5, "drop")
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
          press: { action: "pa.open", params: { target: "routine", id: 2 } },
        }),
      })
    )
    expect(screen.getByRole("button", { name: "Open" })).toBeDisabled()
    expect(screen.getByRole("button", { name: "Somewhere" })).toBeDisabled()
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
