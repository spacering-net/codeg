import type { ReactElement } from "react"
import { act, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"
import enMessages from "@/i18n/messages/en.json"
import type { DelegationBinding } from "@/contexts/delegation-context"
import type { DbConversationSummary } from "@/lib/types"

const h = vi.hoisted(() => ({
  children: [] as DbConversationSummary[],
  loading: false,
  error: false,
  reload: vi.fn(),
  bindings: new Map<number, DelegationBinding>(),
  blocked: new Set<string>(),
  listeners: new Set<() => void>(),
}))
vi.mock("@/hooks/use-conversation-sub-sessions", () => ({
  useConversationSubSessions: () => h,
}))
vi.mock("@/contexts/delegation-context", () => ({
  useDelegation: () => ({
    findByChildConversationId: (id: number) => h.bindings.get(id),
  }),
}))
vi.mock("@/contexts/acp-connections-context", () => {
  const store = {
    getConnection: (id: string) => ({ pendingPermission: h.blocked.has(id) }),
    subscribeKey: (_id: string, callback: () => void) => {
      h.listeners.add(callback)
      return () => h.listeners.delete(callback)
    },
  }
  return { useConnectionStore: () => store }
})
vi.mock("@/components/message/sub-agent-session-dialog", () => ({
  SubAgentSessionDialog: ({
    childConversationId,
    childConnectionId,
    onOpenChange,
  }: {
    childConversationId: number
    childConnectionId: string | null
    onOpenChange: (open: boolean) => void
  }) => (
    <div
      role="dialog"
      aria-label="Child viewer"
      data-connection={childConnectionId}
    >
      Child {childConversationId}
      <button onClick={() => onOpenChange(false)}>Close viewer</button>
    </div>
  ),
}))

import { ConversationSubSessions } from "./conversation-sub-sessions"

function child(id: number, status = "completed"): DbConversationSummary {
  return {
    id,
    folder_id: 1,
    title: `Task ${id}`,
    title_locked: false,
    agent_type: "codex",
    status,
    kind: "delegate",
    model: null,
    git_branch: null,
    external_id: null,
    message_count: 1,
    child_count: 0,
    created_at: new Date(1_700_000_000_000 + id * 1000).toISOString(),
    updated_at: "2026-10-14T00:00:00Z",
    pinned_at: null,
    parent_id: 1,
  }
}

function withIntl(element: ReactElement) {
  return (
    <NextIntlClientProvider locale="en" messages={enMessages}>
      {element}
    </NextIntlClientProvider>
  )
}

describe("ConversationSubSessions", () => {
  beforeEach(() => {
    h.children = [child(1), child(2, "in_progress"), child(3, "pending_review")]
    h.loading = false
    h.error = false
    h.reload.mockReset()
    h.bindings.clear()
    h.blocked.clear()
    h.listeners.clear()
  })

  it("lists history independently of the latest reply and opens the selected child", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    render(
      withIntl(<ConversationSubSessions conversationId={1} childCount={3} />)
    )
    const trigger = screen.getByRole("button", {
      name: "Sub-conversations (3)",
    })
    await user.click(trigger)
    const list = screen.getByRole("dialog", { name: "Sub-conversations" })
    const buttons = within(list).getAllByRole("button")
    expect(
      buttons.map((button) => button.getAttribute("data-sub-session-id"))
    ).toEqual(["2", "3", "1"])
    // pending_review is a finished child turn, matching historical broker meta.
    expect(buttons[1]).toHaveTextContent("done")
    await user.click(
      within(list).getByRole("button", {
        name: "View Codex conversation: Task 1",
      })
    )
    expect(
      screen.getByRole("dialog", { name: "Child viewer" })
    ).toHaveTextContent("Child 1")
    expect(
      screen.queryByRole("dialog", { name: "Sub-conversations" })
    ).toBeNull()
    await user.click(screen.getByRole("button", { name: "Close viewer" }))
    await waitFor(() => expect(trigger).toHaveFocus())
    expect(trigger).toBeVisible()
  })

  it("puts a child awaiting permission before other running children and passes its live connection to the viewer", async () => {
    h.children.push(child(4, "in_progress"))
    h.bindings.set(2, {
      parentConnectionId: "parent",
      parentToolUseId: "tool-2",
      childConnectionId: "live-2",
      childConversationId: 2,
      agentType: "codex",
      status: "running",
      task: null,
      taskId: "task-2",
    })
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    render(
      withIntl(<ConversationSubSessions conversationId={1} childCount={4} />)
    )
    await user.click(
      screen.getByRole("button", { name: "Sub-conversations (4)" })
    )
    act(() => {
      h.blocked.add("live-2")
      h.listeners.forEach((callback) => callback())
    })
    const list = screen.getByRole("dialog", { name: "Sub-conversations" })
    expect(within(list).getAllByRole("button")[0]).toHaveAttribute(
      "data-sub-session-id",
      "2"
    )
    await user.click(
      within(list).getByRole("button", {
        name: "View Codex conversation: Task 2",
      })
    )
    expect(
      screen.getByRole("dialog", { name: "Child viewer" })
    ).toHaveAttribute("data-connection", "live-2")
  })

  it("keeps a known child count available during loading and exposes retry after failure", async () => {
    h.children = []
    h.loading = true
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    const { rerender } = render(
      withIntl(<ConversationSubSessions conversationId={1} childCount={3} />)
    )
    await user.click(
      screen.getByRole("button", { name: "Sub-conversations (3)" })
    )
    expect(screen.getByText("Loading sub-conversations…")).toBeVisible()
    h.loading = false
    h.error = true
    rerender(
      withIntl(<ConversationSubSessions conversationId={1} childCount={3} />)
    )
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Could not load sub-conversations."
    )
    await user.click(screen.getByRole("button", { name: "Retry" }))
    expect(h.reload).toHaveBeenCalledOnce()
  })

  it("closes the previous parent's viewer when the header switches conversations", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    const { rerender } = render(
      withIntl(
        <ConversationSubSessions key={1} conversationId={1} childCount={3} />
      )
    )
    await user.click(
      screen.getByRole("button", { name: "Sub-conversations (3)" })
    )
    await user.click(
      screen.getByRole("button", { name: "View Codex conversation: Task 1" })
    )
    h.children = [child(5)]
    rerender(
      withIntl(
        <ConversationSubSessions key={2} conversationId={2} childCount={1} />
      )
    )
    expect(screen.queryByRole("dialog", { name: "Child viewer" })).toBeNull()
    expect(
      screen.getByRole("button", { name: "Sub-conversations (1)" })
    ).toBeVisible()
  })
})
