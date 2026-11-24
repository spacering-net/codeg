import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import type { TimelineRow } from "@/lib/types"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"
import { usePersonalAgentUi } from "@/stores/personal-agent-ui-store"

const api = vi.hoisted(() => ({
  personalAgentNoticeAct: vi.fn(),
  personalAgentChoiceAnswer: vi.fn(),
}))
vi.mock("@/lib/api", () => api)
vi.mock("@/contexts/personal-agent-context", () => ({
  useBotId: () => 7,
  usePersonalAgent: () => ({
    liveReplies: new Map(),
    dispatchById: new Map(),
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

import { defaultBotFace } from "./bot-avatar"
import { buildMessageItems, type MessageItem } from "./message-items"
import { NoticeCard } from "./notice-card"
import { PageScopeContext, type PageScope } from "./shared"

function row(data: Record<string, unknown>, body = "card"): TimelineRow {
  return {
    id: 40,
    segment_id: null,
    batch_id: null,
    kind: "notice",
    status: null,
    body,
    data,
    dispatch_id: null,
    ref_id: "12",
    reply_to: null,
    read_at: null,
    event_id: null,
    seen_at: null,
    created_at: "2026-11-10T10:00:00Z",
    updated_at: "2026-11-10T10:00:00Z",
  }
}

const scope: PageScope = {
  readOnly: false,
  agentName: "Reviewer",
  liveRowId: null,
  connectionId: null,
  agentType: null,
  onQuote: vi.fn(),
  jumpTo: vi.fn(),
  rowsById: new Map(),
}

function draw(r: TimelineRow) {
  const item = buildMessageItems([r]).find((i) => i.kind === "notice")
  if (!item) throw new Error("no notice item")
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <PageScopeContext.Provider value={scope}>
        <NoticeCard item={item as Extract<MessageItem, { kind: "notice" }>} />
      </PageScopeContext.Provider>
    </NextIntlClientProvider>
  )
}

const starter = (extra: Record<string, unknown> = {}) =>
  row(
    {
      notice: "choice",
      state: "open",
      question: "Send me a PR, a diff or a repository link.",
      options: [
        { key: "A", label: "Review a PR", project: false },
        { key: "B", label: "Look at local changes", project: false },
        { key: "C", label: "Pick a project", project: true },
      ],
      other: "Other",
      ...extra,
    },
    "Send me a PR, a diff or a repository link."
  )

beforeEach(() => {
  usePersonalAgentUi.setState({ settings: null, botPage: null, viewBot: null })
  useAppWorkspaceStore.setState({
    folders: [
      { id: 5, name: "my-app", kind: "regular", parent_id: null },
    ] as never,
  })
})

afterEach(() => {
  cleanup()
  api.personalAgentNoticeAct.mockReset()
  api.personalAgentChoiceAnswer.mockReset()
})

describe("a choice card", () => {
  it("answers with a choice, a letter key, or the owner's own words", async () => {
    api.personalAgentChoiceAnswer.mockResolvedValue(starter())
    draw(starter())
    expect(
      screen.getByText("Send me a PR, a diff or a repository link.")
    ).toBeTruthy()
    // The card is the message, no bubble round it.
    const self = document.querySelector("[data-pa-choice-card]")!
    expect(self.hasAttribute("data-pa-card-message")).toBe(true)
    expect(self.closest(".pa-agent-bubble")).toBeNull()
    fireEvent.click(screen.getByText("Look at local changes"))
    await waitFor(() =>
      expect(api.personalAgentChoiceAnswer).toHaveBeenCalledWith(
        12,
        { key: "B" },
        7
      )
    )
    const card = document.querySelector("[data-pa-choice-card]") as HTMLElement
    fireEvent.keyDown(card, { key: "a" })
    await waitFor(() =>
      expect(api.personalAgentChoiceAnswer).toHaveBeenLastCalledWith(
        12,
        { key: "A" },
        7
      )
    )
    fireEvent.click(screen.getByText("Other"))
    fireEvent.change(screen.getByPlaceholderText("Write your own…"), {
      target: { value: "watch my CI" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Send" }))
    await waitFor(() =>
      expect(api.personalAgentChoiceAnswer).toHaveBeenLastCalledWith(
        12,
        { key: "D", text: "watch my CI" },
        7
      )
    )
  })

  it("asks for the project a choice is about", async () => {
    api.personalAgentChoiceAnswer.mockResolvedValue(starter())
    draw(starter())
    fireEvent.click(screen.getByText("Pick a project"))
    expect(api.personalAgentChoiceAnswer).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole("button", { name: "my-app" }))
    await waitFor(() =>
      expect(api.personalAgentChoiceAnswer).toHaveBeenCalledWith(
        12,
        { key: "C", projectId: 5 },
        7
      )
    )
  })

  it("folds to one line once answered, and opens to the card as it was", () => {
    draw(
      starter({
        state: "answered",
        answer: { key: "B", label: "Look at local changes" },
      })
    )
    const line = screen.getByText("You picked: B. Look at local changes")
    expect(screen.queryByText("Review a PR")).toBeNull()
    fireEvent.click(line)
    expect(screen.getByText("Review a PR")).toBeTruthy()
  })
})

describe("the card about work assistants made", () => {
  const made = (bots: Record<string, unknown>[], extra = {}) =>
    row({
      notice: "changed",
      what: "bots",
      state: "applied",
      why: "asked",
      bots,
      ...extra,
    })
  const bot = (
    id: number,
    state = "made",
    picked: { from: string }[] = []
  ) => ({
    bot_id: id,
    name: `Bot ${id}`,
    face: { id, name: `Bot ${id}`, avatar: null, kind: "worker" },
    work_agent: "Codex",
    picked,
    state,
  })

  it("undoes one of them, or all", async () => {
    const two = [
      bot(1),
      bot(2, "made", [{ from: "given" }, { from: "agent" }, { from: "agent" }]),
    ]
    api.personalAgentNoticeAct.mockResolvedValue(made(two))
    draw(made(two))
    expect(screen.getByText("Made an assistant")).toBeTruthy()
    // The agent each one's work runs on, and how many of its options codeg
    // picked (the owner's own words not counted).
    expect(
      document.querySelector("[data-pa-bot-made='1']")?.textContent
    ).toContain("Works with Codex")
    expect(
      document.querySelector("[data-pa-bot-made='2']")?.textContent
    ).toContain("Works with Codex; 2 options filled in")
    fireEvent.click(
      document.querySelector("[data-pa-undo-bot='2']") as HTMLElement
    )
    await waitFor(() =>
      expect(api.personalAgentNoticeAct).toHaveBeenCalledWith(12, "undo:2", 7)
    )
    fireEvent.click(screen.getByRole("button", { name: "Undo all" }))
    await waitFor(() =>
      expect(api.personalAgentNoticeAct).toHaveBeenLastCalledWith(12, "undo", 7)
    )
    // [Open] goes to its conversation.
    fireEvent.click(screen.getAllByRole("button", { name: "Open" })[0])
    expect(usePersonalAgentUi.getState().viewBot).toBe(1)
  })

  it("strikes one through once it is undone", () => {
    draw(made([bot(1), bot(2, "undone")]))
    expect(
      document
        .querySelector("[data-pa-bot-made='2']")
        ?.getAttribute("data-state")
    ).toBe("undone")
    expect(document.querySelector("[data-pa-undo-bot='2']")).toBeNull()
  })

  it("makes a suggested one when the owner says so", async () => {
    api.personalAgentNoticeAct.mockResolvedValue(made([bot(3)]))
    draw(
      row({
        notice: "changed",
        what: "bots",
        state: "open",
        why: "suggest",
        bots: [],
        pending: { name: "Night cleaner" },
        reason: "you keep asking for cleanups",
      })
    )
    expect(screen.getByText("Suggestion: make a new assistant")).toBeTruthy()
    expect(screen.getByText("Night cleaner")).toBeTruthy()
    expect(screen.getByText("Why: you keep asking for cleanups")).toBeTruthy()
    // What it would make, why, and the buttons: a band each, buttons last.
    // The card is the message: no bubble round it, its heading its first
    // line, on its kind's tone.
    const sheet = screen.getByText("Night cleaner").closest("[data-pa-surface]")
    expect(sheet?.hasAttribute("data-pa-card-message")).toBe(true)
    expect(sheet?.closest(".pa-agent-bubble")).toBeNull()
    expect(sheet?.firstElementChild?.hasAttribute("data-pa-sheet-head")).toBe(
      true
    )
    expect(
      screen.getByText("Night cleaner").closest("[data-pa-sheet-part]")
    ).toBe(sheet?.children[1])
    expect(
      screen
        .getByText("Why: you keep asking for cleanups")
        .closest("[data-pa-sheet-part]")
    ).toBe(sheet?.children[2])
    expect(
      screen
        .getByRole("button", { name: "Make it" })
        .closest("[data-pa-sheet-actions]")
    ).toBe(sheet?.lastElementChild)
    fireEvent.click(screen.getByRole("button", { name: "Make it" }))
    await waitFor(() =>
      expect(api.personalAgentNoticeAct).toHaveBeenCalledWith(12, "accept", 7)
    )
  })
})

describe("a card to make a work assistant (R9)", () => {
  it("shows the whole persona it would be made with, and words not typed this turn as not checked", () => {
    draw(
      row({
        notice: "changed",
        what: "bots",
        state: "open",
        why: "show",
        bots: [],
        pending: {
          name: "Reviewer",
          persona: "I review code changes.\nWhether they are right.",
        },
        quote: null,
        unchecked_quote: "make me a reviewer",
      })
    )
    expect(screen.getByText("Reviewer")).toBeTruthy()
    const persona = document.querySelector("[data-pa-bot-persona]")!
    expect(persona.textContent).toContain(
      "I review code changes.\nWhether they are right."
    )
    // Never shown as the owner's own words.
    expect(screen.queryByText(/You said/)).toBeNull()
    expect(
      screen.getByText(
        "The primary says you said “make me a reviewer” — but you didn't type it this turn"
      )
    ).toBeTruthy()
  })
})

describe("the default face", () => {
  it("is picked from the uid the way the backend picks it", () => {
    // FNV-1a("abc") = 0x1a47e90b: colour 1 of 10, shape 1 of 12.
    expect(defaultBotFace("abc")).toEqual({
      kind: "face",
      shape: "braces",
      color: "red",
    })
  })
})
