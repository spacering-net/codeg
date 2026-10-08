import { act, fireEvent, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import type { ReactNode } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import messages from "@/i18n/messages/en.json"
import type { MessageTurn } from "@/lib/types"
import { MessageListView, type ThreadRenderItem } from "./message-list-view"

const runtime = vi.hoisted(() => ({ turns: [] as MessageTurn[] }))
vi.mock("@/stores/conversation-runtime-store", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useConversationRuntimeStore: (select: (state: unknown) => unknown) =>
    select({ byConversationId: new Map() }),
  selectTimelineTurns: () =>
    runtime.turns.map((turn) => ({ turn, phase: "persisted" })),
  useConversationRuntimeActions: () => ({}),
}))
vi.mock("@/hooks/use-model-labels", () => ({ useModelLabels: () => ({}) }))
vi.mock("@/lib/browser/use-page-handoff-name", () => ({
  usePageHandoffName: () => "Page",
}))
vi.mock("./use-create-task-from-message", () => ({
  useCreateTaskFromMessage: () => vi.fn(),
}))
vi.mock("./session-viewer-host", () => ({
  SessionViewerHost: ({ children }: { children: ReactNode }) => children,
}))
vi.mock("use-stick-to-bottom", () => ({
  useStickToBottomContext: () => ({ scrollToBottom: vi.fn() }),
}))
vi.mock("@/components/ai-elements/message-thread", () => ({
  MessageThread: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  MessageThreadScrollButton: () => null,
}))
vi.mock("./virtualized-message-thread", () => ({
  VirtualizedMessageThread: ({
    items,
    renderItem,
  }: {
    items: ThreadRenderItem[]
    renderItem: (item: ThreadRenderItem) => ReactNode
  }) => (
    <div>
      {items.map((item) => (
        <div key={item.key}>{renderItem(item)}</div>
      ))}
    </div>
  ),
}))
vi.mock("./collapsible-user-message", () => ({
  CollapsibleUserMessage: () => <p>User text</p>,
}))
vi.mock("./completed-turn-content", () => ({
  CompletedTurnContent: () => <p>Assistant text</p>,
}))
vi.mock("./reply-artifacts", () => ({ ReplyArtifacts: () => null }))
vi.mock("./turn-stats", () => ({
  TurnStats: ({
    onForkFromHere,
    forkDisabled,
  }: {
    onForkFromHere?: () => void
    forkDisabled: boolean
  }) =>
    onForkFromHere ? (
      <button disabled={forkDisabled} onClick={onForkFromHere}>
        Fork from here
      </button>
    ) : null,
}))
vi.mock("./selection-action-bubble", () => ({
  SelectionActionBubble: () => null,
}))
vi.mock("@/components/chat/agent-plan-overlay", () => ({
  AgentPlanOverlay: () => null,
}))
vi.mock("@/components/chat/sub-agent-overlay", () => ({
  SubAgentOverlay: () => null,
}))

function mount(
  props: Partial<React.ComponentProps<typeof MessageListView>> = {}
) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <MessageListView
        conversationId={1}
        agentType="codex"
        showMessageNav={false}
        {...props}
      />
    </NextIntlClientProvider>
  )
}

beforeEach(() => {
  runtime.turns = [
    {
      id: "historical-user",
      source_turn_id: "backend-user",
      role: "user",
      blocks: [{ type: "text", text: "first" }],
      timestamp: "",
    },
    {
      id: "assistant",
      source_turn_id: "backend-assistant",
      role: "assistant",
      blocks: [{ type: "text", text: "reply" }],
      timestamp: "",
    },
    {
      id: "live-latest-user",
      role: "user",
      blocks: [{ type: "text", text: "latest" }],
      timestamp: "",
    },
  ]
})

describe("MessageListView edit action", () => {
  it("edits historical and latest users with the raw source turn, including unresolved live IDs", async () => {
    const onEditUserTurn = vi.fn()
    mount({ onEditUserTurn })
    const controls = screen.getAllByRole("button", { name: "Edit message" })
    expect(controls).toHaveLength(2)
    await userEvent.click(controls[0])
    expect(onEditUserTurn).toHaveBeenLastCalledWith(runtime.turns[0])
    // The control remains visible without hover, and supports keyboard activation.
    expect(controls[1]).toBeVisible()
    expect(controls[1].className).not.toContain("opacity-0")
    act(() => controls[1].focus())
    await userEvent.keyboard("{Enter}")
    expect(onEditUserTurn).toHaveBeenLastCalledWith(runtime.turns[2])
  })

  it("omits controls without a handler", () => {
    mount()
    expect(
      screen.queryByRole("button", { name: "Edit message" })
    ).not.toBeInTheDocument()
  })

  it.each([{ editDisabled: true }, { connStatus: "prompting" as const }])(
    "disables editing when %j",
    (props) => {
      const onEditUserTurn = vi.fn()
      mount({ ...props, onEditUserTurn })
      for (const control of screen.getAllByRole("button", {
        name: "Edit message",
      })) {
        expect(control).toBeDisabled()
        fireEvent.click(control)
      }
      expect(onEditUserTurn).not.toHaveBeenCalled()
    }
  )

  it("retains assistant fork identity and does not gate forking on editDisabled", async () => {
    const onForkFromTurn = vi.fn()
    mount({ onForkFromTurn, onEditUserTurn: vi.fn(), editDisabled: true })
    await userEvent.click(
      screen.getByRole("button", { name: "Fork from here" })
    )
    expect(onForkFromTurn).toHaveBeenCalledWith("backend-assistant")
  })
})
