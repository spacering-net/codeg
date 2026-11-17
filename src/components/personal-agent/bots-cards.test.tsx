import {
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
import type { TimelineRow } from "@/lib/types"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"
import { usePersonalAgentUi } from "@/stores/personal-agent-ui-store"

const api = vi.hoisted(() => ({
  personalAgentNoticeAct: vi.fn(),
  personalAgentChoiceAnswer: vi.fn(),
  personalAgentBotSetTemplate: vi.fn(),
  personalAgentTemplates: vi.fn(async () => [
    {
      id: "review",
      name: "Reviewer",
      job: "Look at PRs.",
      description: "",
      instructions: "",
      opener: "Send me a PR.",
      options: ["a", "b", "c"],
      other: "Other",
      modes: ["session"],
      division: "review",
      project_option: null,
    },
    {
      id: "dev",
      name: "Developer",
      job: "Make PRs.",
      description: "",
      instructions: "",
      opener: "Send me a request.",
      options: ["a", "b", "c"],
      other: "Other",
      modes: ["task"],
      division: "code",
      project_option: 2,
    },
  ]),
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
      purpose: "starter",
      state: "open",
      template: "review",
      question: "Send me a PR, a diff or a repository link.",
      options: [
        { key: "A", label: "Review a PR", project: false },
        { key: "B", label: "Look at local changes", project: false },
        { key: "C", label: "Pick a project", project: true },
      ],
      other: "Other",
      made: {
        brain: { agent: "Claude Code", same_as_primary: true, picked: [] },
        executor: {
          id: 3,
          name: "Reviewer",
          agent: "Claude Code",
          created: true,
          picked: [
            {
              id: "model",
              name: "Model",
              value: "sonnet",
              value_label: "Sonnet",
              from: "agent",
            },
            {
              id: "effort",
              name: "Effort",
              value: "high",
              value_label: "High",
              from: "other_config",
            },
          ],
        },
      },
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
  api.personalAgentBotSetTemplate.mockReset()
})

describe("the opening choice card", () => {
  it("answers with a choice, a letter key, or the owner's own words", async () => {
    api.personalAgentChoiceAnswer.mockResolvedValue(starter())
    draw(starter())
    expect(
      screen.getByText("Send me a PR, a diff or a repository link.")
    ).toBeTruthy()
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
    // Its role still said, no longer changed.
    expect(screen.getByText("Role")).toBeTruthy()
    expect(screen.queryByRole("button", { name: /Change role/ })).toBeNull()
  })

  it("says what codeg set up for it, line by line, and changes its role", async () => {
    api.personalAgentBotSetTemplate.mockResolvedValue(starter())
    draw(starter({ template_name: "Reviewer" }))
    const setup = document.querySelector<HTMLElement>("[data-pa-starter-foot]")!
    expect(within(setup).getByText("Set up for it")).toBeTruthy()
    // A label, what it is and how to change it, a line each.
    expect(
      [...setup.querySelector("dl")!.children]
        .filter((c) => c.tagName === "DT")
        .map((d) => d.textContent)
    ).toEqual(["Role", "Brain", "Executor config"])
    expect(within(setup).getByText("Reviewer")).toBeTruthy()
    expect(
      within(setup).getByText("· same as the primary assistant's")
    ).toBeTruthy()
    // The options picked, folded under the executor's line; open, by where
    // each came from.
    const made = within(setup).getByRole("button", {
      name: /2 options picked for you/,
    })
    expect(made.getAttribute("aria-expanded")).toBe("false")
    expect(screen.queryByText("agent's default")).toBeNull()
    fireEvent.click(made)
    const picked = setup.querySelector<HTMLElement>("[data-pa-starter-picked]")!
    expect(
      [...picked.children].map((g) =>
        [...g.querySelectorAll("p, dt, dd")].map((e) => e.textContent)
      )
    ).toEqual([
      ["from another config", "Effort", "High"],
      ["agent's default", "Model", "Sonnet"],
    ])

    fireEvent.click(screen.getByRole("button", { name: "Change brain" }))
    expect(usePersonalAgentUi.getState().botPage).toEqual({ tab: "identity" })
    fireEvent.click(
      screen.getByRole("button", { name: "Change executor config" })
    )
    expect(usePersonalAgentUi.getState().botPage).toEqual({ tab: "execution" })
    const role = screen.getByRole("button", { name: /Change role/ })
    await waitFor(() => expect(role.hasAttribute("disabled")).toBe(false))
    await userEvent.click(role)
    await userEvent.click(await screen.findByText("Developer"))
    await waitFor(() =>
      expect(api.personalAgentBotSetTemplate).toHaveBeenCalledWith(7, "dev")
    )
  })

  it("names the executor config it was bound to, an existing one", () => {
    draw(
      starter({
        made: {
          brain: { agent: "Codex", same_as_primary: false, picked: [] },
          executor: {
            id: 3,
            name: "My Codex",
            agent: "Codex CLI",
            created: false,
            picked: [],
          },
        },
      })
    )
    const setup = document.querySelector<HTMLElement>("[data-pa-starter-foot]")!
    expect(within(setup).getByText("My Codex")).toBeTruthy()
    expect(within(setup).getByText("· an existing one")).toBeTruthy()
    expect(within(setup).getByText("Codex")).toBeTruthy()
    expect(within(setup).queryByText(/same as the primary/)).toBeNull()
    // Nothing picked: nothing to open.
    expect(setup.querySelector("[data-pa-starter-made]")).toBeNull()
  })
})

describe("the card about work assistants made", () => {
  const made = (bots: Record<string, unknown>[], extra = {}) =>
    row({
      notice: "changed",
      what: "bots",
      state: "applied",
      why: "made",
      bots,
      ...extra,
    })
  const bot = (id: number, state = "made") => ({
    bot_id: id,
    name: `Bot ${id}`,
    face: { id, name: `Bot ${id}`, avatar: null, kind: "worker" },
    template_name: "Developer",
    executor_name: `Exec ${id}`,
    executor_agent: "Codex",
    executor_created: false,
    picked: [],
    state,
  })

  it("undoes one of them, or all", async () => {
    api.personalAgentNoticeAct.mockResolvedValue(made([bot(1), bot(2)]))
    draw(made([bot(1), bot(2)]))
    expect(
      screen.getByText("Made 2 work assistants from your executor configs")
    ).toBeTruthy()
    expect(screen.getByText(/keeps Exec 1/)).toBeTruthy()
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
    expect(screen.getByText("Suggestion: a new work assistant")).toBeTruthy()
    expect(screen.getByText("Night cleaner")).toBeTruthy()
    expect(screen.getByText("Why: you keep asking for cleanups")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Make it" }))
    await waitFor(() =>
      expect(api.personalAgentNoticeAct).toHaveBeenCalledWith(12, "accept", 7)
    )
  })
})

describe("the default face", () => {
  it("is picked from the uid the way the backend picks it", () => {
    // FNV-1a("abc") = 0x1a47e90b: colour 1 of 10, shape 1 of 8.
    expect(defaultBotFace("abc")).toEqual({
      kind: "face",
      shape: "pebble",
      color: "red",
    })
  })
})
