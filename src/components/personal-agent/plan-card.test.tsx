/**
 * A plan's card (7.6): its steps, who carries each out, what each waits for
 * and how far it got; [Start] [Change] [Cancel] while shown first, [Stop]
 * [Change] while running, [Go on] with each step under way cancelable once
 * stopped; the changes with [Undo].
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import type { PlanStepView, PlanView, TimelineRow } from "@/lib/types"

const api = vi.hoisted(() => ({
  personalAgentNoticeAct: vi.fn(async () => ({})),
}))
vi.mock("@/lib/api", () => api)
vi.mock("@/contexts/personal-agent-context", () => ({
  useBotId: () => null,
}))

import { buildMessageItems, type MessageItem } from "./message-items"
import { waitsForOwner } from "./message-list"
import { PlanCard, planOf, stepWord } from "./plan-card"
import { PageScopeContext, type PageScope } from "./shared"

function step(seq: number, over: Partial<PlanStepView> = {}): PlanStepView {
  return {
    seq,
    title: `Step ${seq}`,
    target_kind: "bot",
    target_id: 2,
    target_name: "Dev",
    face: { id: 2, name: "Dev", avatar: null, kind: "worker" },
    mode: null,
    project_id: null,
    project_name: null,
    deliverable: null,
    prompt: `Do ${seq}.`,
    done_when: null,
    depends_on: [],
    state: "pending",
    confirmed: true,
    ready: false,
    ladder: null,
    dispatch_id: null,
    message_id: null,
    work_task_id: null,
    conversation_id: null,
    conversation_folder_id: null,
    result: null,
    error: null,
    started_at: null,
    ended_at: null,
    ...over,
  }
}

function plan(over: Partial<PlanView> = {}): PlanView {
  return {
    id: 5,
    title: "Split the parser",
    goal: "A faster parser.",
    state: "running",
    stuck_reason: null,
    steps: [
      step(1, { state: "done", ready: true, result: "Slow: the tokenizer." }),
      step(2, {
        state: "running",
        ready: true,
        depends_on: [1],
        target_kind: "self",
        target_id: 3,
        target_name: "Nova",
        mode: "task",
        project_id: 1,
        project_name: "codeg",
        deliverable: "change",
        ladder: "checking",
        dispatch_id: 12,
      }),
      step(3, { depends_on: [1, 2] }),
    ],
    changes: [],
    done: 1,
    total: 3,
    created_at: "2026-11-14T01:00:00Z",
    started_at: "2026-11-14T01:00:00Z",
    ended_at: null,
    ...over,
  }
}

function card(p: PlanView): TimelineRow {
  return {
    id: 41,
    segment_id: 1,
    batch_id: 7,
    kind: "notice",
    status: null,
    body: `Plan #${p.id} "${p.title}"`,
    data: { notice: "plan", state: p.state, plan: p },
    dispatch_id: null,
    ref_id: "9",
    reply_to: null,
    read_at: null,
    event_id: null,
    seen_at: null,
    created_at: "2026-11-14T01:00:00Z",
    updated_at: "2026-11-14T01:00:00Z",
  }
}

const onQuote = vi.fn()
const scope: PageScope = {
  readOnly: false,
  agentName: "Aide",
  liveRowId: null,
  connectionId: null,
  agentType: null,
  onQuote,
  jumpTo: vi.fn(),
  rowsById: new Map(),
}

function draw(row: TimelineRow) {
  const item = buildMessageItems([row]).find((i) => i.kind === "notice")
  if (!item) throw new Error("no notice item")
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <PageScopeContext.Provider value={scope}>
        <PlanCard item={item as Extract<MessageItem, { kind: "notice" }>} />
      </PageScopeContext.Provider>
    </NextIntlClientProvider>
  )
}

function acts(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll("[data-pa-plan-act]")).map(
    (b) => b.getAttribute("data-pa-plan-act") ?? ""
  )
}

beforeEach(() => {
  api.personalAgentNoticeAct.mockClear()
  onQuote.mockClear()
})
afterEach(() => cleanup())

describe("the plan card", () => {
  it("lists the steps with who, what they wait for and where they stand", () => {
    const { container } = draw(card(plan()))
    expect(screen.getByText("Split the parser")).toBeTruthy()
    expect(screen.getByText("1/3 steps")).toBeTruthy()
    const states = Array.from(
      container.querySelectorAll("[data-pa-plan-step]")
    ).map((li) => li.getAttribute("data-pa-plan-step-state"))
    expect(states).toEqual(["done", "running", "pending"])
    // A running step says where its work stands on the ladder.
    const two = container.querySelector("[data-pa-plan-step='2']")!
    expect(two.textContent).toContain("Being checked")
    expect(two.textContent).toContain("Kanban task · codeg")
    // Its own step: "itself", not its name; another's, by name.
    expect(
      two
        .querySelector("[data-pa-plan-step-who]")
        ?.getAttribute("data-pa-plan-step-who")
    ).toBe("self")
    expect(two.querySelector("[data-pa-plan-step-who]")?.textContent).toBe(
      "itself"
    )
    expect(two.textContent).toContain("after step 1")
    const three = container.querySelector("[data-pa-plan-step='3']")!
    expect(three.textContent).toContain("after step 1, 2")
    expect(three.textContent).toContain("waits for its steps")
    expect(screen.getByText("Slow: the tokenizer.")).toBeTruthy()
    // What a step is to do opens on a click.
    expect(screen.queryByText("Do 3.")).toBeNull()
    fireEvent.click(screen.getByText("Step 3"))
    expect(screen.getByText("Do 3.")).toBeTruthy()
  })

  it("shown first, it starts on Start; Change quotes the card", () => {
    const { container } = draw(card(plan({ state: "draft", done: 0 })))
    expect(acts(container)).toEqual(["start", "change", "cancel"])
    // The card's buttons on its last band, a step's own on its line.
    expect(
      container.querySelectorAll("[data-pa-sheet-actions] [data-pa-plan-act]")
    ).toHaveLength(3)
    // A card of its own: no bubble round it.
    const sheet = screen.getByText("Start").closest("[data-pa-card-message]")!
    expect(sheet).not.toBeNull()
    expect(sheet.closest(".pa-agent-bubble")).toBeNull()
    // How far it got, as a bar under its title.
    expect(sheet.querySelector("[data-pa-plan-progress]")).not.toBeNull()
    fireEvent.click(screen.getByText("Start"))
    expect(api.personalAgentNoticeAct).toHaveBeenCalledWith(9, "start", null)
    fireEvent.click(screen.getByText("Change"))
    expect(onQuote).toHaveBeenCalledWith(41)
  })

  it("running it stops; stopped it goes on and a step under way can be canceled", () => {
    const running = draw(card(plan()))
    expect(acts(running.container)).toEqual(["stop", "change"])
    cleanup()
    const { container } = draw(card(plan({ state: "stopped" })))
    expect(acts(container)).toEqual([
      "cancel_step:2",
      "start",
      "change",
      "cancel",
    ])
    expect(screen.getByText("Go on")).toBeTruthy()
    fireEvent.click(
      container.querySelector("[data-pa-plan-act='cancel_step:2']")!
    )
    expect(api.personalAgentNoticeAct).toHaveBeenCalledWith(
      9,
      "cancel_step:2",
      null
    )
  })

  it("a step the owner confirms first has Confirm, and the card waits for them", () => {
    const p = plan({
      steps: [
        step(1, { state: "done", ready: true }),
        step(2, { ready: true, confirmed: false, depends_on: [1] }),
      ],
      total: 2,
    })
    const { container } = draw(card(p))
    expect(stepWord(p.steps[1])).toBe("confirm")
    expect(acts(container)).toContain("confirm:2")
    expect(waitsForOwner(card(p))).toBe(true)
    expect(waitsForOwner(card(plan()))).toBe(false)
    expect(waitsForOwner(card(plan({ state: "stuck" })))).toBe(true)
    expect(waitsForOwner(card(plan({ state: "draft" })))).toBe(true)
  })

  it("stuck, it says on which step; done, it has nothing to press", () => {
    const stuck = plan({
      state: "stuck",
      steps: [
        step(1, { state: "failed", error: "boom" }),
        step(2, { depends_on: [1] }),
      ],
    })
    draw(card(stuck))
    expect(screen.getByText(/Stuck on step 1 “Step 1”: it failed/)).toBeTruthy()
    expect(screen.getByText("boom")).toBeTruthy()
    cleanup()
    const { container } = draw(card(plan({ state: "done", done: 3 })))
    expect(acts(container)).toEqual([])
  })

  it("lists the changes, with Undo where a step it touched has not started", () => {
    const p = plan({
      changes: [
        {
          index: 0,
          at: "2026-11-14T02:00:00Z",
          by: "assistant",
          items: [
            {
              kind: "changed",
              seq: 3,
              title: "Step 3",
              fields: ["prompt", "who"],
            },
            { kind: "added", seq: 4, title: "Release" },
          ],
          reason: "the owner asked",
          undoable: true,
          undone: false,
          kept: [],
        },
        {
          index: 1,
          at: "2026-11-14T03:00:00Z",
          by: "assistant",
          items: [{ kind: "removed", seq: 5, title: "Old" }],
          reason: null,
          undoable: false,
          undone: true,
          kept: [6],
        },
      ],
    })
    const { container } = draw(card(p))
    const first = container.querySelector("[data-pa-plan-change='0']")!
    expect(first.textContent).toContain(
      "changed step 3 “Step 3”: what to do, who does it, added step 4 “Release”"
    )
    expect(first.textContent).toContain("the owner asked")
    fireEvent.click(container.querySelector("[data-pa-plan-undo='0']")!)
    expect(api.personalAgentNoticeAct).toHaveBeenCalledWith(9, "undo:0", null)
    const second = container.querySelector("[data-pa-plan-change='1']")!
    expect(second.textContent).toContain("step 6 had started and kept it")
    expect(container.querySelector("[data-pa-plan-undo='1']")).toBeNull()
  })

  it("reads only what is a plan", () => {
    expect(planOf(null)).toBeNull()
    expect(planOf({ id: 1, title: "x", state: "weird", steps: [] })).toBeNull()
    expect(
      planOf({ id: 1, title: "x", state: "done", steps: [] })?.changes
    ).toEqual([])
  })
})
