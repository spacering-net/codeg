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
import type { BotImpact, PersonalAgentBotSummary } from "@/lib/types"
import { usePersonalAgentUi } from "@/stores/personal-agent-ui-store"

const api = vi.hoisted(() => ({
  personalAgentBotCreate: vi.fn(),
  personalAgentBots: vi.fn(),
  personalAgentBotImpact: vi.fn(),
  personalAgentBotDelete: vi.fn(async () => {}),
  personalAgentTemplates: vi.fn(async () => [
    {
      id: "research",
      name: "Researcher",
      job: "Look things up.",
      description: "Looks things up.",
      instructions: "- Conclusion first.",
      opener: "What do you want to find out?",
      options: ["a", "b", "c"],
      other: "Other",
      modes: ["chat", "session"],
      division: "research",
      project_option: null,
    },
  ]),
}))
vi.mock("@/lib/api", () => api)
vi.mock("@/lib/platform", () => ({
  subscribe: () => Promise.resolve(() => {}),
  onTransportReconnect: () => () => {},
}))
vi.mock("@/contexts/personal-agent-context", () => ({
  useBotId: () => null,
  usePersonalAgentChanges: () => {},
}))
const editor = vi.hoisted(() => ({
  props: null as Record<string, unknown> | null,
}))
vi.mock("@/components/settings/assistant-editor-dialog", () => ({
  AssistantEditorDialog: (props: Record<string, unknown>) => {
    editor.props = props
    return <div data-testid="executor-editor" />
  },
}))

import { BotDeleteDialog } from "./bot-delete-dialog"
import { NewBotDialog } from "./new-bot-dialog"
import { PersonalAgentRoster } from "./roster"

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
      shape: "blob",
      color: kind === "primary" ? "black" : "teal",
    },
    template: kind === "worker" ? "review" : null,
    executor_assistant_id: kind === "worker" ? 3 : null,
    created_at: "2026-11-10T10:00:00Z",
  }) as PersonalAgentBotSummary

beforeEach(() => {
  usePersonalAgentUi.setState({ viewBot: null, settings: null })
  editor.props = null
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe("a new work assistant", () => {
  it("is made from a name with its default face, and the page goes to it", async () => {
    api.personalAgentBotCreate.mockResolvedValue({
      bot: bot(9, "worker", "Code review"),
      executor_assistant_id: 3,
      template: "review",
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
    expect(draft.executor_made_for_it).toBe(false)
    await waitFor(() => expect(usePersonalAgentUi.getState().viewBot).toBe(9))
    expect(closed).toHaveBeenCalledWith(false)
  })

  it("sends the face the owner picked", async () => {
    api.personalAgentBotCreate.mockResolvedValue({
      bot: bot(9, "worker", "Dev"),
      executor_assistant_id: 3,
      template: "dev",
      options_unavailable: null,
    })
    wrap(<NewBotDialog open onOpenChange={() => {}} />)
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Dev" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Hexagon" }))
    fireEvent.click(screen.getByRole("button", { name: "Purple" }))
    fireEvent.click(screen.getByRole("button", { name: "Create" }))
    await waitFor(() =>
      expect(api.personalAgentBotCreate.mock.calls[0][0].avatar).toEqual({
        kind: "face",
        shape: "hexagon",
        color: "purple",
      })
    )
  })

  it("opens the executor config editor, prefilled, when the agent's options cannot be read", async () => {
    api.personalAgentBotCreate
      .mockResolvedValueOnce({
        bot: null,
        executor_assistant_id: null,
        template: "research",
        options_unavailable: { agent_type: "gemini", why: "not installed" },
      })
      .mockResolvedValueOnce({
        bot: bot(10, "worker", "Researcher"),
        executor_assistant_id: 21,
        template: "research",
        options_unavailable: null,
      })
    wrap(<NewBotDialog open onOpenChange={() => {}} />)
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Researcher" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Create" }))
    await screen.findByTestId("executor-editor")
    expect(editor.props?.prefill).toMatchObject({
      name: "Researcher",
      description: "Looks things up.",
      instructions: "- Conclusion first.",
      agentType: "gemini",
    })
    ;(editor.props?.onSaved as (a: { id: number }) => void)({ id: 21 })
    await waitFor(() =>
      expect(api.personalAgentBotCreate).toHaveBeenLastCalledWith(
        expect.objectContaining({
          template: "research",
          executor_assistant_id: 21,
          executor_made_for_it: true,
        })
      )
    )
    await waitFor(() => expect(usePersonalAgentUi.getState().viewBot).toBe(10))
  })
})

describe("the roster", () => {
  it("lists the primary first and switches the page to the one picked", async () => {
    api.personalAgentBots.mockResolvedValue([
      bot(1, "primary", "Nova"),
      bot(9, "worker", "Reviewer"),
    ])
    wrap(<PersonalAgentRoster compact={false} readOnly={false} />)
    const reviewer = await screen.findByText("Reviewer")
    fireEvent.click(reviewer)
    expect(usePersonalAgentUi.getState().viewBot).toBe(9)
    fireEvent.click(screen.getByText("Nova"))
    expect(usePersonalAgentUi.getState().viewBot).toBeNull()
  })

  it("goes back to the primary when the one shown is gone", async () => {
    usePersonalAgentUi.setState({ viewBot: 42 })
    api.personalAgentBots.mockResolvedValue([bot(1, "primary", "Nova")])
    wrap(<PersonalAgentRoster compact readOnly={false} />)
    await waitFor(() =>
      expect(usePersonalAgentUi.getState().viewBot).toBeNull()
    )
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
    executor: { id: 3, name: "Reviewer", shared_with: [] },
    division: ["review"],
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
    expect(screen.getByText(/It is the first pick for Review/)).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Delete" }))
    await waitFor(() =>
      expect(api.personalAgentBotDelete).toHaveBeenCalledWith(9, {
        hand_over: true,
        delete_executor: false,
        delete_workdir: false,
      })
    )
    await waitFor(() => expect(closed).toHaveBeenCalledWith(false))
    expect(usePersonalAgentUi.getState().viewBot).toBeNull()
  })

  it("keeps an executor config another assistant uses", async () => {
    api.personalAgentBotImpact.mockResolvedValue({
      ...impact,
      executor: { id: 3, name: "Reviewer", shared_with: ["Reviewer 2"] },
      workdir_custom: true,
    })
    wrap(<BotDeleteDialog botId={9} onOpenChange={() => {}} />)
    expect(await screen.findByText("Kept: Reviewer 2 use it too.")).toBeTruthy()
    const boxes = screen.getAllByRole("checkbox")
    expect(boxes.every((b) => b.hasAttribute("disabled"))).toBe(true)
  })
})
