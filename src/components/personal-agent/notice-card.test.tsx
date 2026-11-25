import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import type { FolderDetail, TimelineRow } from "@/lib/types"

const api = vi.hoisted(() => ({ personalAgentNoticeAct: vi.fn() }))
vi.mock("@/lib/api", () => api)
vi.mock("@/contexts/personal-agent-context", () => ({
  useBotId: () => null,
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

import { useAppWorkspaceStore } from "@/stores/app-workspace-store"
import { usePersonalAgentUi } from "@/stores/personal-agent-ui-store"

import { buildMessageItems, type MessageItem } from "./message-items"
import { NoticeCard, pageOf } from "./notice-card"
import { PageScopeContext, type PageScope } from "./shared"

function card(data: Record<string, unknown>): TimelineRow {
  return {
    id: 30,
    segment_id: 1,
    batch_id: 9,
    kind: "notice",
    status: null,
    body: "Research X",
    data: {
      notice: "proposal",
      action: "dispatch",
      display: {
        agent_type: "codex",
        mode: "chat",
        project: null,
        title: "Research X",
        prompt: "Find out X.",
      },
      ...data,
    },
    dispatch_id: null,
    ref_id: "4",
    reply_to: null,
    read_at: null,
    event_id: null,
    seen_at: null,
    created_at: "2026-11-07T10:00:00Z",
    updated_at: "2026-11-07T10:00:00Z",
  }
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

function draw(row: TimelineRow, readOnly = false) {
  const item = buildMessageItems([row]).find((i) => i.kind === "notice")
  if (!item) throw new Error("no notice item")
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <PageScopeContext.Provider value={scope(readOnly)}>
        <NoticeCard item={item as Extract<MessageItem, { kind: "notice" }>} />
      </PageScopeContext.Provider>
    </NextIntlClientProvider>
  )
}

afterEach(() => {
  cleanup()
  api.personalAgentNoticeAct.mockReset()
})

describe("NoticeCard", () => {
  it("shows the whole proposal and answers it as the card says", async () => {
    api.personalAgentNoticeAct.mockResolvedValue(card({ state: "acted" }))
    draw(card({ state: "open" }))
    expect(screen.getByText("Proposal · waiting for you")).toBeTruthy()
    expect(screen.getByText("Research X")).toBeTruthy()
    // How it runs, not who: only the assistant speaks on its page.
    expect(screen.getByText("Chat")).toBeTruthy()
    expect(
      screen
        .getByText("Research X")
        .closest("[data-pa-work]")
        ?.querySelector("[data-pa-work-glyph]")
        ?.getAttribute("data-pa-work-glyph")
    ).toBe("chat")
    expect(screen.getByText("Find out X.")).toBeTruthy()
    // On one sheet in parts: the work's row its head, what it is to do a
    // band of its own, its buttons the last.
    const sheet = screen.getByText("Research X").closest("[data-pa-surface]")
    // The card is the message, no bubble round it: its heading, then the
    // work's row.
    expect(sheet?.hasAttribute("data-pa-card-message")).toBe(true)
    expect(sheet?.closest(".pa-agent-bubble")).toBeNull()
    expect(sheet?.firstElementChild?.hasAttribute("data-pa-sheet-head")).toBe(
      true
    )
    expect(sheet?.children[1]?.getAttribute("data-pa-work")).toBe("head")
    // The heading a header of its own: a band with the hairline under it
    // every band has, the next one's room not cut short.
    expect(sheet?.firstElementChild?.className).toContain("py-2.5")
    expect(sheet?.className).toContain("[&>*+*]:border-t")
    expect(sheet?.className).not.toContain("[&>[data-pa-sheet-head]+*]")
    expect(
      screen.getByText("Find out X.").closest("[data-pa-sheet-part]")
    ).not.toBeNull()
    expect(
      screen
        .getByRole("button", { name: "Do this" })
        .closest("[data-pa-sheet-actions]")
    ).toBe(sheet?.lastElementChild)
    fireEvent.click(screen.getByRole("button", { name: "Do this" }))
    await waitFor(() =>
      expect(api.personalAgentNoticeAct).toHaveBeenCalledWith(4, "accept", null)
    )
  })

  it("names a retry of interrupted work as such", () => {
    draw(
      card({
        state: "open",
        action: "followup",
        why: "confirm",
        display: {
          agent_type: "codex",
          mode: "session",
          title: "Research X",
          message: "Pick it up where you left off.",
          retry: true,
        },
      })
    )
    expect(screen.getByText("Retry “Research X”")).toBeTruthy()
  })

  it("says how it was answered, with nothing left to click", () => {
    draw(card({ state: "dismissed" }))
    expect(screen.getByText("Not taken up")).toBeTruthy()
    expect(screen.queryByRole("button", { name: "Do this" })).toBeNull()
    expect(screen.queryByRole("button", { name: "Not now" })).toBeNull()
  })

  it("shows why an approval could not run, and the answer error", async () => {
    api.personalAgentNoticeAct.mockRejectedValue(
      new Error("assistant #3 is not an enabled role assistant")
    )
    draw(card({ state: "open" }))
    fireEvent.click(screen.getByRole("button", { name: "Do this" }))
    expect((await screen.findByRole("alert")).textContent).toContain(
      "not an enabled role assistant"
    )
  })

  it("reads running while what it runs is on its way, with nothing to click", () => {
    draw(card({ state: "acting" }))
    expect(screen.getByText("Running…")).toBeTruthy()
    expect(screen.queryByRole("button", { name: "Do this" })).toBeNull()
    expect(screen.queryByRole("button", { name: "Not now" })).toBeNull()
  })

  it("offers to run it again when it is not sure it ran", async () => {
    api.personalAgentNoticeAct.mockResolvedValue(card({ state: "acting" }))
    draw(card({ state: "unknown" }))
    expect(screen.getByText("Not sure it ran")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Run again" }))
    await waitFor(() =>
      expect(api.personalAgentNoticeAct).toHaveBeenCalledWith(4, "accept", null)
    )
  })

  it("asks about a step it cannot tell went through, and closes once it did", async () => {
    const uncertain = (state: string) =>
      card({
        notice: "uncertain",
        action: "followup",
        state,
        display: {
          dispatch_id: 12,
          agent_type: "codex",
          mode: "session",
          conversation_id: 40,
          folder_id: 2,
          title: "Investigate",
          message: "and the tests",
        },
      })
    api.personalAgentNoticeAct.mockResolvedValue(uncertain("acting"))
    const { unmount } = draw(uncertain("open"))
    expect(screen.getByText("Not sure this went through")).toBeTruthy()
    expect(screen.getByText("Continue “Investigate”")).toBeTruthy()
    expect(screen.getByText("and the tests")).toBeTruthy()
    expect(screen.getByRole("button", { name: "Look" })).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Send again" }))
    await waitFor(() =>
      expect(api.personalAgentNoticeAct).toHaveBeenCalledWith(4, "accept", null)
    )
    unmount()
    // Sent again and cut off again: still not sure, still answerable.
    const again = draw(uncertain("unknown"))
    expect(screen.getByText("Not sure this went through")).toBeTruthy()
    expect(screen.getByRole("button", { name: "Send again" })).toBeTruthy()
    expect(screen.getByRole("button", { name: "Let it be" })).toBeTruthy()
    again.unmount()
    draw(uncertain("resolved"))
    expect(screen.getByText("It did go through")).toBeTruthy()
    expect(screen.queryByRole("button", { name: "Send again" })).toBeNull()
  })

  it("is read-only where the engine runs elsewhere", () => {
    draw(card({ state: "open" }), true)
    const accept = screen.getByRole("button", { name: "Do this" })
    expect((accept as HTMLButtonElement).disabled).toBe(true)
  })
})

describe("cards about assistants working together", () => {
  const dev = { id: 2, name: "Dev", avatar: null, kind: "worker" }
  const review = { id: 3, name: "Review", avatar: null, kind: "worker" }

  it("stops an exchange that went round, and lets the owner decide", async () => {
    api.personalAgentNoticeAct.mockResolvedValue(card({}))
    draw(
      card({
        notice: "loop",
        state: "open",
        thread_id: 12,
        why: "no_progress",
        count: 6,
        bots: [dev, review],
        refused: "After you.",
      })
    )
    expect(screen.getByText("Exchange stopped · waiting for you")).toBeTruthy()
    expect(
      screen.getByText(
        "Dev and Review went back and forth 6 times with no progress, so codeg stopped them."
      )
    ).toBeTruthy()
    expect(screen.getByText("Held back: “After you.”")).toBeTruthy()
    expect(
      screen.getByRole("button", { name: "See the exchange" })
    ).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Let them go on" }))
    await waitFor(() =>
      expect(api.personalAgentNoticeAct).toHaveBeenCalledWith(4, "accept", null)
    )
    fireEvent.click(screen.getByRole("button", { name: "I'll handle it" }))
    await waitFor(() =>
      expect(api.personalAgentNoticeAct).toHaveBeenCalledWith(
        4,
        "dismiss",
        null
      )
    )
  })

  it("says a circle was stopped, and once answered offers nothing more", () => {
    draw(
      card({
        notice: "loop",
        state: "acted",
        thread_id: 12,
        why: "cycle",
        bots: [dev, review],
      })
    )
    expect(screen.getByText("Let them go on")).toBeTruthy()
    expect(screen.getByText(/went round in a circle/)).toBeTruthy()
    expect(screen.queryByRole("button", { name: "I'll handle it" })).toBeNull()
    // Settled: its heading says so on the done tone; the two it is between
    // over what happened.
    expect(
      screen
        .getByText("Let them go on")
        .closest("[data-pa-settle]")
        ?.getAttribute("data-pa-settle")
    ).toBe("done")
    expect(
      document.querySelector("[data-pa-loop-between]")?.textContent
    ).toContain("Review")
  })

  it("lists what a stop took with it, and stops what it could not on request", async () => {
    api.personalAgentNoticeAct.mockResolvedValue(card({}))
    draw(
      card({
        notice: "stopped",
        state: "open",
        scope: "this",
        dispatches: [{ id: 5, title: "Fix the login" }],
        messages: [{ id: 7, to: dev, excerpt: "Fix it." }],
        handled: [{ id: 8, to: review, excerpt: "Review it." }],
        also_stopped: [],
      })
    )
    expect(screen.getByText("Stopped, with what it set going")).toBeTruthy()
    expect(screen.getByText("Fix the login")).toBeTruthy()
    // A message taken back: whom it was to over what it said.
    expect(screen.getByText("To Dev")).toBeTruthy()
    expect(screen.getByText("Fix it.")).toBeTruthy()
    expect(screen.getByText("Review is on “Review it.”")).toBeTruthy()
    // Each group a band of its own on the sheet, its label over it.
    const parts = screen
      .getByText("Fix the login")
      .closest("[data-pa-surface]")
      ?.querySelectorAll(":scope > [data-pa-sheet-part]")
    expect(parts?.length).toBe(3)
    fireEvent.click(screen.getByRole("button", { name: "Stop Review's too" }))
    await waitFor(() =>
      expect(api.personalAgentNoticeAct).toHaveBeenCalledWith(4, "stop:8", null)
    )
  })

  it("does not offer to stop again what was stopped from the card", () => {
    draw(
      card({
        notice: "stopped",
        state: "open",
        scope: "all",
        dispatches: [],
        messages: [],
        handled: [{ id: 8, to: review, excerpt: "Review it." }],
        also_stopped: [8],
      })
    )
    expect(screen.getByText("Stopped everything")).toBeTruthy()
    expect(screen.getByText("Stopped too")).toBeTruthy()
    expect(
      screen.queryByRole("button", { name: "Stop Review's too" })
    ).toBeNull()
  })
})

// ── 1.5: settings changed from the conversation, and confirm-first cards ──

describe("a settings change card", () => {
  const changed = (data: Record<string, unknown>) =>
    card({
      notice: "changed",
      display: undefined,
      changes: [{ key: "prefs.reply_length", from: "medium", to: "short" }],
      ...data,
    })

  it("says what changed and undoes it", async () => {
    api.personalAgentNoticeAct.mockResolvedValue({})
    draw(changed({ state: "applied", why: "asked", quote: "keep it short" }))
    expect(screen.getByText("Changed, as you said")).toBeInTheDocument()
    expect(screen.getByText("Reply length")).toBeInTheDocument()
    expect(screen.getByText("Medium")).toBeInTheDocument()
    expect(screen.getByText("Short")).toBeInTheDocument()
    expect(screen.getByText("You said: “keep it short”")).toBeInTheDocument()
    // The change, why and the buttons: three bands, the buttons last.
    const sheet = screen.getByText("Reply length").closest("[data-pa-surface]")
    expect(
      screen.getByText("Reply length").closest("[data-pa-sheet-part]")
    ).not.toBeNull()
    expect(
      screen
        .getByText("You said: “keep it short”")
        .closest("[data-pa-sheet-part]")
    ).not.toBe(screen.getByText("Reply length").closest("[data-pa-sheet-part]"))
    expect(
      screen
        .getByRole("button", { name: "Undo" })
        .closest("[data-pa-sheet-actions]")
    ).toBe(sheet?.lastElementChild)
    fireEvent.click(screen.getByRole("button", { name: "Undo" }))
    await waitFor(() =>
      expect(api.personalAgentNoticeAct).toHaveBeenCalledWith(4, "undo", null)
    )
  })

  it("asks first for a suggestion, with its reason", async () => {
    api.personalAgentNoticeAct.mockResolvedValue({})
    draw(changed({ state: "open", why: "suggest", reason: "you trim answers" }))
    expect(screen.getByText("A suggested change")).toBeInTheDocument()
    expect(screen.getByText("Why: you trim answers")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "Change it" }))
    await waitFor(() =>
      expect(api.personalAgentNoticeAct).toHaveBeenCalledWith(4, "accept", null)
    )
  })

  it("is only a record in the primary's conversation", () => {
    draw(
      changed({
        state: "applied",
        why: "line",
        from_bot: { id: 5, name: "Dev", kind: "worker" },
      })
    )
    expect(screen.getByText("Dev changed, as you told it")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull()
    expect(screen.queryByRole("button", { name: "See in settings" })).toBeNull()
  })

  it("names the projects watched, and its settings are their page", () => {
    useAppWorkspaceStore.setState({
      folders: [
        { id: 1, name: "app", alias: null },
        { id: 2, name: "lib", alias: "Library" },
        { id: 3, name: "notes", alias: null },
      ] as unknown as FolderDetail[],
    })
    draw(
      changed({
        state: "applied",
        why: "asked",
        changes: [{ key: "prefs.projects", from: "all", to: [1, 2, 9, 3] }],
      })
    )
    expect(screen.getByText("Your projects")).toBeInTheDocument()
    expect(screen.getByText("All projects")).toBeInTheDocument()
    expect(screen.getByText("app, Library, #9 and 1 more")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "See in settings" }))
    expect(usePersonalAgentUi.getState().settings?.page).toBe("projects")
    cleanup()
    draw(
      changed({
        state: "applied",
        why: "asked",
        changes: [{ key: "prefs.projects", from: [1, 2], to: [] }],
      })
    )
    expect(screen.getByText("app, Library")).toBeInTheDocument()
    expect(screen.getByText("None")).toBeInTheDocument()
  })

  it("lists what an undo had to leave", () => {
    draw(
      changed({
        state: "undone",
        why: "asked",
        kept: ["prefs.reply_length"],
      })
    )
    expect(screen.getByText("Undone")).toBeInTheDocument()
    expect(
      screen.getByText("Changed again since, so left as they are: Reply length")
    ).toBeInTheDocument()
  })
})

describe("a card held for the owner's confirmation", () => {
  it("says it waits for them and sends exactly what it shows", async () => {
    api.personalAgentNoticeAct.mockResolvedValue({})
    draw(card({ state: "open", why: "confirm" }))
    expect(
      screen.getByText("Waiting for your confirmation")
    ).toBeInTheDocument()
    expect(screen.getByText("Find out X.")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Go ahead" }))
    await waitFor(() =>
      expect(api.personalAgentNoticeAct).toHaveBeenCalledWith(4, "accept", null)
    )
  })

  it("shows a message to another assistant as the message", () => {
    draw(
      card({
        state: "open",
        why: "confirm",
        action: "message",
        display: { to: 5, to_name: "Dev", message: "Take the release notes." },
      })
    )
    expect(screen.getByText("Message to Dev")).toBeInTheDocument()
    expect(screen.getByText("Take the release notes.")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Don't" })).toBeInTheDocument()
  })
})

describe("tonight's work and the morning brief (6.4, 6.5)", () => {
  it("offers work for tonight, kept awake for, without the switch over suggestions", async () => {
    api.personalAgentNoticeAct.mockResolvedValue(card({ state: "acted" }))
    draw(
      card({ state: "open", why: "proposal", tonight: true, keep_awake: true })
    )
    expect(screen.getByText("Tonight I can do")).toBeTruthy()
    expect(
      screen.getByText("The computer stays awake until this work is done.")
    ).toBeTruthy()
    expect(screen.queryByRole("button", { name: "Don't suggest these" })).toBe(
      null
    )
    expect(screen.getByRole("button", { name: "Not now" })).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Do it tonight" }))
    await waitFor(() =>
      expect(api.personalAgentNoticeAct).toHaveBeenCalledWith(4, "accept", null)
    )
  })
})

describe("where a change is set", () => {
  it("sends the projects watched to their own page", () => {
    expect(pageOf("prefs.projects")).toBe("projects")
    expect(pageOf("prefs.reply_length")).toBe("communication")
    expect(pageOf("prefs.rule_pr_review")).toBe("proactive")
  })
})
