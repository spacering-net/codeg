import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import type { BotImpact, PersonalAgentBotSummary } from "@/lib/types"
import { reloadRoster } from "@/stores/personal-agent-roster-store"
import { usePersonalAgentUi } from "@/stores/personal-agent-ui-store"

const api = vi.hoisted(() => ({
  personalAgentBotCreate: vi.fn(),
  personalAgentBots: vi.fn(),
  personalAgentBotImpact: vi.fn(),
  personalAgentBotDelete: vi.fn(async () => {}),
}))
vi.mock("@/lib/api", () => api)
vi.mock("@/lib/platform", () => ({
  subscribe: () => Promise.resolve(() => {}),
  onTransportReconnect: () => () => {},
  isDesktop: () => false,
}))
vi.mock("@/contexts/personal-agent-context", () => ({
  useBotId: () => null,
  usePersonalAgentChanges: () => {},
  usePrefetchAssistant: () => prefetched.read,
}))
// Who the roster read ahead (its rows' pointer, or a press).
const prefetched = vi.hoisted(() => ({ read: vi.fn() }))
// The agents there are, the list to pick one from, and its options as the
// agent answers them (none to pick).
vi.mock("@/hooks/use-acp-agents", () => ({
  useAcpAgents: () => ({
    agents: [{ agent_type: "claude_code", enabled: true, available: true }],
  }),
}))
vi.mock("@/components/settings/agent-options-editor", () => ({
  AgentSelect: ({ onChange }: { onChange: (a: string) => void }) => (
    <button
      type="button"
      data-testid="agent-select"
      onClick={() => onChange("claude_code")}
    />
  ),
  OptionBlock: ({ children }: { children: React.ReactNode }) => children,
  RequiredOptionRow: () => null,
  optionValueLabel: () => null,
}))
vi.mock("@/components/settings/required-agent-options", () => ({
  RequiredOptionsSection: () => null,
  useRequiredOptionsGate: () => ({
    gate: { kind: "ready", rows: [] },
    probe: { loading: false, reload: vi.fn() },
  }),
}))

import { BotDeleteDialog } from "./bot-delete-dialog"
import { NewBotDialog } from "./new-bot-dialog"
import { PersonalAgentRoster, useRosterUpkeep } from "./roster"
import {
  resetShowHiddenAssistantsForTest,
  setShowHiddenAssistants,
} from "./roster-filter"

function wrap(node: React.ReactNode) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      {node}
    </NextIntlClientProvider>
  )
}

const bot = (id: number, kind: "primary" | "worker", name: string) =>
  ({
    id,
    kind,
    uid: `u${id}`,
    name,
    avatar: {
      kind: "face",
      shape: "ring",
      color: kind === "primary" ? "black" : "teal",
    },
    hidden: false,
    has_brain: true,
    legacy_assistant_id: null,
    created_at: "2026-11-10T10:00:00Z",
  }) as PersonalAgentBotSummary

beforeEach(() => {
  usePersonalAgentUi.setState({ viewBot: null, settings: null, botPage: null })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe("a new work assistant", () => {
  it("is made from a name with its default face, and the page goes to it", async () => {
    api.personalAgentBotCreate.mockResolvedValue({
      bot: bot(9, "worker", "Code review"),
      options_unavailable: null,
    })
    const closed = vi.fn()
    wrap(<NewBotDialog open onOpenChange={closed} />)
    const create = screen.getByRole("button", { name: "Create" })
    expect(create.hasAttribute("disabled")).toBe(true)
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "  Code review " },
    })
    fireEvent.click(create)
    await waitFor(() => expect(api.personalAgentBotCreate).toHaveBeenCalled())
    const draft = api.personalAgentBotCreate.mock.calls[0][0]
    expect(draft.name).toBe("Code review")
    expect(draft.uid).toMatch(/^[0-9a-f]{32}$/)
    expect(draft.avatar).toBeNull()
    // No persona: the default one, until it writes its own; its work on a
    // copy of its brain.
    expect(draft.persona).toBeNull()
    expect(draft.work).toEqual({ kind: "same_as_brain" })
    await waitFor(() => expect(usePersonalAgentUi.getState().viewBot).toBe(9))
    expect(closed).toHaveBeenCalledWith(false)
  })

  it("goes to it once the roster has it: not taken for one deleted (polish round 4)", async () => {
    // The roster as it was read before: the new one not on it yet.
    api.personalAgentBots.mockResolvedValue([bot(1, "primary", "Nova")])
    usePersonalAgentUi.setState({ botPage: { tab: "notify" } })
    wrap(
      <>
        <PersonalAgentRoster variant="sidebar" readOnly={false} />
        <NewBotDialog open onOpenChange={() => {}} />
      </>
    )
    await screen.findByText("Nova")
    api.personalAgentBotCreate.mockResolvedValue({
      bot: bot(9, "worker", "Code review"),
      options_unavailable: null,
    })
    // Read after it is made, the roster has it.
    api.personalAgentBots.mockResolvedValue([
      bot(1, "primary", "Nova"),
      bot(9, "worker", "Code review"),
    ])
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Code review" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Create" }))
    await waitFor(() => expect(usePersonalAgentUi.getState().viewBot).toBe(9))
    // Still on it once the roster has settled, on its conversation.
    await new Promise((r) => setTimeout(r, 50))
    expect(usePersonalAgentUi.getState().viewBot).toBe(9)
    expect(usePersonalAgentUi.getState().botPage).toBeNull()
    expect(
      document
        .querySelector('[data-pa-roster-bot="9"]')
        ?.getAttribute("aria-current")
    ).toBe("page")
  })

  it("goes to it also when the roster is read again while it waits (review round 1)", async () => {
    api.personalAgentBots.mockResolvedValue([bot(1, "primary", "Nova")])
    wrap(
      <>
        <PersonalAgentRoster variant="sidebar" readOnly={false} />
        <NewBotDialog open onOpenChange={() => {}} />
      </>
    )
    await screen.findByText("Nova")
    api.personalAgentBotCreate.mockResolvedValue({
      bot: bot(9, "worker", "Code review"),
      options_unavailable: null,
    })
    const both = [bot(1, "primary", "Nova"), bot(9, "worker", "Code review")]
    let landMine: (v: unknown) => void = () => {}
    let landLater: (v: unknown) => void = () => {}
    api.personalAgentBots.mockClear()
    api.personalAgentBots
      .mockImplementationOnce(() => new Promise((r) => (landMine = r)))
      .mockImplementationOnce(() => new Promise((r) => (landLater = r)))
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Code review" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Create" }))
    // The read it waits for is on its way…
    await waitFor(() => expect(api.personalAgentBots).toHaveBeenCalledTimes(1))
    // …when the "made" event's read is asked for.
    reloadRoster()
    await waitFor(
      () => expect(api.personalAgentBots).toHaveBeenCalledTimes(2),
      { timeout: 2000 }
    )
    // Its own read lands first: shown, and the page goes to it.
    await act(async () => landMine(both))
    await waitFor(() => expect(usePersonalAgentUi.getState().viewBot).toBe(9))
    await act(async () => landLater(both))
    await new Promise((r) => setTimeout(r, 50))
    expect(usePersonalAgentUi.getState().viewBot).toBe(9)
  })

  it("sends the face the owner picked", async () => {
    api.personalAgentBotCreate.mockResolvedValue({
      bot: bot(9, "worker", "Dev"),
      options_unavailable: null,
    })
    wrap(<NewBotDialog open onOpenChange={() => {}} />)
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Dev" },
    })
    // Its face at the head of the box, its name under it; the face
    // editor's bubble behind the face.
    const head = document.querySelector("[data-pa-new-bot-head]")!
    expect(
      head
        .querySelector("[data-pa-face-picker]")!
        .compareDocumentPosition(
          head.querySelector("[data-pa-new-bot-name]")!
        ) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
    fireEvent.click(head.querySelector("[data-pa-face-picker]")!)
    fireEvent.click(await screen.findByRole("button", { name: "Bug" }))
    fireEvent.click(screen.getByRole("button", { name: "Purple" }))
    expect(head.getAttribute("data-pa-face")).toBe("purple")
    fireEvent.click(screen.getByRole("button", { name: "Create" }))
    await waitFor(() =>
      expect(api.personalAgentBotCreate.mock.calls[0][0].avatar).toEqual({
        kind: "face",
        shape: "bug",
        color: "purple",
      })
    )
  })

  it("runs its work on another agent when one is picked (D1)", async () => {
    api.personalAgentBotCreate.mockResolvedValue({
      bot: bot(10, "worker", "Researcher"),
      options_unavailable: null,
    })
    wrap(<NewBotDialog open onOpenChange={() => {}} />)
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Researcher" },
    })
    fireEvent.click(
      document.querySelector('[data-pa-new-bot-work-mode="other"]')!
    )
    fireEvent.click(screen.getByTestId("agent-select"))
    fireEvent.click(screen.getByRole("button", { name: "Create" }))
    await waitFor(() => expect(api.personalAgentBotCreate).toHaveBeenCalled())
    expect(api.personalAgentBotCreate.mock.calls[0][0]).toMatchObject({
      work: { kind: "config", config: { agent_type: "claude_code" } },
    })
    await waitFor(() => expect(usePersonalAgentUi.getState().viewBot).toBe(10))
  })
})

describe("a new assistant's persona", () => {
  it("sends the persona written", async () => {
    api.personalAgentBotCreate.mockResolvedValue({
      bot: bot(9, "worker", "Reviewer"),
      options_unavailable: null,
    })
    wrap(<NewBotDialog open onOpenChange={() => {}} />)
    expect(screen.getByText(/You can leave it empty/)).toBeTruthy()
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Reviewer" },
    })
    fireEvent.change(screen.getByLabelText("Persona"), {
      target: { value: "  I review code changes.\n" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Create" }))
    await waitFor(() => expect(api.personalAgentBotCreate).toHaveBeenCalled())
    expect(api.personalAgentBotCreate.mock.calls[0][0]).toMatchObject({
      name: "Reviewer",
      persona: "I review code changes.",
    })
  })
})

describe("the roster", () => {
  it("lists the primary first and switches the page to the one picked", async () => {
    api.personalAgentBots.mockResolvedValue([
      bot(1, "primary", "Nova"),
      bot(9, "worker", "Reviewer"),
    ])
    wrap(<PersonalAgentRoster variant="sidebar" readOnly={false} />)
    const reviewer = await screen.findByText("Reviewer")
    fireEvent.click(reviewer)
    expect(usePersonalAgentUi.getState().viewBot).toBe(9)
    fireEvent.click(screen.getByText("Nova"))
    expect(usePersonalAgentUi.getState().viewBot).toBeNull()
  })

  it("goes back to the primary when the one shown is gone, drawn or not", async () => {
    usePersonalAgentUi.setState({ viewBot: 42 })
    api.personalAgentBots.mockResolvedValue([bot(1, "primary", "Nova")])
    // The page keeps it, with no roster drawn (the sidebar's section
    // folded, the title's popover closed).
    function Upkeep() {
      useRosterUpkeep(false)
      return null
    }
    wrap(<Upkeep />)
    await waitFor(() =>
      expect(usePersonalAgentUi.getState().viewBot).toBeNull()
    )
  })
})

describe("the roster in the title capsule's popover", () => {
  const dialogs = () => ({
    add: vi.fn(),
    remove: vi.fn(),
    group: vi.fn(),
    edit: vi.fn(),
  })

  it("lists them, the primary's square tile on top, and closes on a pick", async () => {
    api.personalAgentBots.mockResolvedValue([
      bot(1, "primary", "Nova"),
      bot(9, "worker", "Reviewer"),
    ])
    const onPick = vi.fn()
    const held = dialogs()
    wrap(
      <PersonalAgentRoster
        variant="popover"
        readOnly={false}
        dialogs={held}
        onPick={onPick}
      />
    )
    const reviewer = await screen.findByText("Reviewer")
    expect(
      [...document.querySelectorAll("[data-pa-roster-bot]")].map((r) =>
        r.getAttribute("data-pa-roster-bot")
      )
    ).toEqual(["1", "9"])
    // The primary's square tile on top — no hover card in a popover.
    const tile = document.querySelector<HTMLElement>("[data-pa-roster-primary]")
    expect(tile?.getAttribute("data-pa-roster-bot")).toBe("1")
    expect(tile?.textContent).toContain("Nova")
    fireEvent.click(reviewer)
    expect(usePersonalAgentUi.getState().viewBot).toBe(9)
    expect(onPick).toHaveBeenCalledTimes(1)
    // The foot: a new one, alone — no switch to show the roster beside the
    // conversation (it is on the workspace's sidebar); the dialog its
    // holder keeps, the popover closing.
    const foot = document.querySelector<HTMLElement>("[data-pa-roster-foot]")!
    expect(foot.querySelector("[role=switch]")).toBeNull()
    expect([...foot.children].map((c) => c.textContent)).toEqual([
      "New assistant",
    ])
    fireEvent.click(screen.getByRole("button", { name: "New assistant" }))
    expect(held.add).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole("dialog")).toBeNull()
  })

  it("reads a work assistant ahead once the pointer rests on it, or it is pressed", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      prefetched.read.mockClear()
      api.personalAgentBots.mockResolvedValue([
        bot(1, "primary", "Nova"),
        bot(9, "worker", "Reviewer"),
        bot(10, "worker", "Writer"),
      ])
      wrap(
        <PersonalAgentRoster
          variant="popover"
          readOnly={false}
          dialogs={dialogs()}
        />
      )
      const row = (id: number) =>
        document.querySelector<HTMLElement>(`[data-pa-roster-bot="${id}"]`)!
      await screen.findByText("Reviewer")
      // Passing over on the way elsewhere reads none.
      fireEvent.pointerEnter(row(9))
      act(() => vi.advanceTimersByTime(60))
      fireEvent.pointerLeave(row(9))
      act(() => vi.advanceTimersByTime(500))
      expect(prefetched.read).not.toHaveBeenCalled()
      // Resting on it does.
      fireEvent.pointerEnter(row(9))
      act(() => vi.advanceTimersByTime(150))
      expect(prefetched.read).toHaveBeenCalledWith(9)
      // Pressed: at once.
      fireEvent.pointerDown(row(10))
      expect(prefetched.read).toHaveBeenLastCalledWith(10)
      // The primary is always read.
      prefetched.read.mockClear()
      fireEvent.pointerDown(row(1))
      expect(prefetched.read).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it("lists the hidden ones only while the sidebar's filter shows them, the one setting both read", async () => {
    resetShowHiddenAssistantsForTest()
    window.localStorage.removeItem("pa:roster:show-hidden:v1")
    api.personalAgentBots.mockResolvedValue([
      bot(1, "primary", "Nova"),
      bot(9, "worker", "Reviewer"),
      {
        ...bot(10, "worker", "Archivist"),
        hidden: true,
        roster: {
          sort_order: 0,
          pinned_at: null,
          section: null,
          hidden: true,
          muted: false,
          unread_mark: false,
          notify: true,
        },
      },
    ])
    const listed = () =>
      [...document.querySelectorAll("[data-pa-roster-bot]")].map((r) =>
        r.getAttribute("data-pa-roster-bot")
      )
    try {
      wrap(
        <PersonalAgentRoster
          variant="popover"
          readOnly={false}
          dialogs={dialogs()}
        />
      )
      await screen.findByText("Reviewer")
      // Off at first: not listed.
      expect(listed()).toEqual(["1", "9"])
      expect(screen.queryByText("Archivist")).toBeNull()
      // Turned on (by the sidebar's filter): listed at once, last, marked.
      act(() => setShowHiddenAssistants(true))
      expect(listed()).toEqual(["1", "9", "10"])
      expect(
        document
          .querySelector('[data-pa-roster-bot="10"]')
          ?.getAttribute("data-pa-roster-hidden")
      ).toBe("true")
      act(() => setShowHiddenAssistants(false))
      expect(listed()).toEqual(["1", "9"])
    } finally {
      setShowHiddenAssistants(false)
      resetShowHiddenAssistantsForTest()
    }
  })
})

describe("deleting a work assistant", () => {
  const impact: BotImpact = {
    bot_id: 9,
    name: "Reviewer",
    running: [
      {
        dispatch_id: 4,
        title: "Review #12",
        mode: "session",
        state: "running",
      },
    ],
    unanswered_messages: 2,
    plans: [],
    plan_steps: [],
    workdir: "/data/personal-agent-bots/u9",
    workdir_custom: false,
  }

  it("says what it touches and hands the running work over by default", async () => {
    api.personalAgentBotImpact.mockResolvedValue(impact)
    usePersonalAgentUi.setState({ viewBot: 9 })
    const closed = vi.fn()
    wrap(<BotDeleteDialog botId={9} onOpenChange={closed} />)
    expect(await screen.findByText("Delete Reviewer?")).toBeTruthy()
    expect(
      screen.getByText(/1 piece of work it handed out is still running/)
    ).toBeTruthy()
    expect(screen.getByText("#4 Review #12")).toBeTruthy()
    expect(
      screen.getByText(/2 messages to it have not been answered/)
    ).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Delete" }))
    await waitFor(() =>
      expect(api.personalAgentBotDelete).toHaveBeenCalledWith(9, {
        hand_over: true,
        delete_workdir: false,
      })
    )
    await waitFor(() => expect(closed).toHaveBeenCalledWith(false))
    expect(usePersonalAgentUi.getState().viewBot).toBeNull()
  })

  it("shows a long working directory whole, wrapped inside the dialog", async () => {
    const workdir =
      "/Users/someone/Library/Application Support/app.codeg/personal-agent-bots/d783ec9a74546aabf32dab3e398b5dbb"
    api.personalAgentBotImpact.mockResolvedValue({ ...impact, workdir })
    wrap(<BotDeleteDialog botId={9} onOpenChange={() => {}} />)
    await screen.findByText("Delete Reviewer?")
    const path = document.querySelector("[data-pa-delete-workdir]")!
    expect(path.textContent).toBe(workdir)
    expect(path.className).toContain("wrap-anywhere")
    expect(path.className).not.toContain("truncate")
    // The dialog is a grid: its body may shrink below its longest line.
    expect(path.closest(".flex-col")?.className).toContain("min-w-0")
  })

  it("names its plans that stop and the steps of other plans handed to it", async () => {
    api.personalAgentBotImpact.mockResolvedValue({
      ...impact,
      plans: [{ plan_id: 1, title: "Ship 2.0" }],
      plan_steps: [
        {
          plan_id: 2,
          plan_title: "Split the parser",
          bot_name: "Aide",
          seq: 3,
          title: "Review it",
        },
      ],
    })
    wrap(<BotDeleteDialog botId={9} onOpenChange={() => {}} />)
    expect(await screen.findByText("Its plan stops: Ship 2.0.")).toBeTruthy()
    expect(
      screen.getByText(
        /A step of another plan is handed to it: Split the parser · 3\. Review it\./
      )
    ).toBeTruthy()
  })

  it("does not offer to delete a directory the owner picked", async () => {
    api.personalAgentBotImpact.mockResolvedValue({
      ...impact,
      workdir_custom: true,
    })
    wrap(<BotDeleteDialog botId={9} onOpenChange={() => {}} />)
    await screen.findByText("Delete Reviewer?")
    const boxes = screen.getAllByRole("checkbox")
    expect(boxes.every((b) => b.hasAttribute("disabled"))).toBe(true)
  })
})
