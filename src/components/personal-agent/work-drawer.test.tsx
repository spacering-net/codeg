import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import type { ReactNode } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import type { DispatchInfo, WorkTask } from "@/lib/types"
import {
  usePersonalAgentUi,
  type WorkTarget,
} from "@/stores/personal-agent-ui-store"

const h = vi.hoisted(() => ({
  attach: vi.fn(),
  detach: vi.fn(),
  setRoute: vi.fn(),
  openConversations: vi.fn(),
  openTab: vi.fn(),
  focusTasks: vi.fn(),
  workTaskGet: vi.fn(),
  dispatchById: new Map<number, unknown>(),
  tasks: [] as unknown[],
  loading: false,
}))

// The two viewers are the conversation's and the board's own, tested there:
// stand-ins show what they were handed.
vi.mock("@/components/message/sub-agent-session-dialog", () => ({
  SubAgentSessionDialog: (props: {
    open: boolean
    childConversationId: number
    childConnectionId: string | null
    identity: { assistantName: string | null }
    kickoffTask?: string | null
    headerActions?: ReactNode
  }) =>
    props.open ? (
      <div
        data-testid="conversation-viewer"
        data-conversation={props.childConversationId}
        data-connection={props.childConnectionId ?? ""}
        data-who={props.identity.assistantName ?? ""}
        data-kickoff={props.kickoffTask ?? ""}
      >
        {props.headerActions}
      </div>
    ) : null,
}))
vi.mock("@/components/tasks/task-transcript-dialog", () => ({
  TaskTranscriptDialog: (props: {
    open: boolean
    task: WorkTask | null
    headerActions?: ReactNode
    fallback?: ReactNode
  }) =>
    !props.open ? null : props.task?.conversation_id != null ? (
      <div data-testid="task-viewer" data-task={props.task.id}>
        {props.headerActions}
      </div>
    ) : (
      props.fallback
    ),
}))
vi.mock("@/components/tasks/task-card", () => ({
  StatusChip: () => <span>status</span>,
}))
vi.mock("@/contexts/acp-connections-context", () => ({
  useAcpActions: () => ({
    attachDelegationChild: h.attach,
    detachDelegationChild: h.detach,
  }),
}))
vi.mock("@/contexts/personal-agent-context", () => ({
  useBotId: () => null,
  usePersonalAgent: () => ({ dispatchById: h.dispatchById }),
}))
vi.mock("@/contexts/tasks-view-context", () => ({
  useTasksView: () => ({ tasks: h.tasks, loading: h.loading }),
}))
vi.mock("@/contexts/workbench-route-context", () => ({
  useWorkbenchRoute: () => ({
    setRoute: h.setRoute,
    openConversations: h.openConversations,
  }),
}))
vi.mock("@/contexts/tab-context", () => ({
  useTabActions: () => ({ openTab: h.openTab }),
}))
vi.mock("@/lib/workbench-focus", () => ({
  requestTasksFocus: h.focusTasks,
}))
vi.mock("@/lib/api", () => ({ workTaskGet: h.workTaskGet }))
vi.mock("@/hooks/use-history-back-dismiss", () => ({
  useHistoryBackDismiss: () => {},
}))

import { PersonalAgentWorkDrawer } from "./work-drawer"

function target(patch: Partial<WorkTarget> = {}): WorkTarget {
  return {
    dispatchId: 9,
    mode: "chat",
    workTaskId: null,
    conversationId: 41,
    folderId: 7,
    agentType: "codex",
    title: "Research the topic",
    executorId: 3,
    executorName: "Scout",
    prompt: "Look into it",
    connectionId: "c-1",
    state: "running",
    ...patch,
  }
}

function dispatch(patch: Partial<DispatchInfo> = {}): DispatchInfo {
  return {
    id: 9,
    mode: "chat",
    executor: {
      assistant_id: 3,
      name: "Scout",
      agent_type: "codex",
    },
    folder_id: null,
    folder_name: null,
    deliverable: null,
    title: "Research the topic",
    prompt: "Look into it",
    work_task_id: null,
    conversation_id: 41,
    conversation_folder_id: 7,
    connection_id: "c-1",
    state: "running",
    result_excerpt: null,
    error: null,
    on_done: null,
    turns: 1,
    created_at: "2026-11-04T10:00:00Z",
    updated_at: "2026-11-04T10:00:00Z",
    finished_at: null,
    ...patch,
  } as DispatchInfo
}

function open(work: WorkTarget) {
  act(() => usePersonalAgentUi.getState().openWork(work))
}

function draw() {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <PersonalAgentWorkDrawer />
    </NextIntlClientProvider>
  )
}

beforeEach(() => {
  for (const fn of [
    h.attach,
    h.detach,
    h.setRoute,
    h.openConversations,
    h.openTab,
    h.focusTasks,
    h.workTaskGet,
  ])
    fn.mockReset()
  h.dispatchById = new Map()
  h.tasks = []
  h.loading = false
  usePersonalAgentUi.setState({ work: null, workOpen: false })
})

afterEach(cleanup)

describe("PersonalAgentWorkDrawer — a conversation", () => {
  it("opens the conversation and follows it while the dispatch works", () => {
    open(target())
    draw()
    const viewer = screen.getByTestId("conversation-viewer")
    expect(viewer.dataset.conversation).toBe("41")
    expect(viewer.dataset.connection).toBe("c-1")
    expect(viewer.dataset.who).toBe("Scout")
    expect(viewer.dataset.kickoff).toBe("Look into it")
    expect(h.attach).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionId: "c-1",
        parentConnectionId: "c-1",
        agentType: "codex",
        hydrate: true,
      })
    )
    act(() => usePersonalAgentUi.getState().setWorkOpen(false))
    expect(h.detach).toHaveBeenCalledWith("c-1")
    expect(screen.queryByTestId("conversation-viewer")).toBeNull()
  })

  it("reads the dispatch as it is now, and attaches nothing once it settled", () => {
    h.dispatchById = new Map([[9, dispatch({ state: "completed" })]])
    open(target())
    draw()
    expect(screen.getByTestId("conversation-viewer").dataset.connection).toBe(
      ""
    )
    expect(h.attach).not.toHaveBeenCalled()
  })

  it("moves to a follow-up's new connection, keeps it as the dispatch settles, and attaches nothing on reopening", () => {
    open(target())
    const view = draw()
    h.dispatchById = new Map([[9, dispatch({ connection_id: "c-2" })]])
    view.rerender(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <PersonalAgentWorkDrawer />
      </NextIntlClientProvider>
    )
    expect(h.detach).toHaveBeenCalledWith("c-1")
    expect(h.attach).toHaveBeenLastCalledWith(
      expect.objectContaining({ connectionId: "c-2" })
    )
    // Settles while watched: the last of its reply still comes in on c-2.
    h.dispatchById = new Map([
      [9, dispatch({ connection_id: "c-2", state: "completed" })],
    ])
    view.rerender(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <PersonalAgentWorkDrawer />
      </NextIntlClientProvider>
    )
    expect(h.detach).not.toHaveBeenCalledWith("c-2")
    expect(screen.getByTestId("conversation-viewer").dataset.connection).toBe(
      "c-2"
    )
    act(() => usePersonalAgentUi.getState().setWorkOpen(false))
    expect(h.detach).toHaveBeenCalledWith("c-2")
    h.attach.mockReset()
    act(() => usePersonalAgentUi.getState().setWorkOpen(true))
    expect(h.attach).not.toHaveBeenCalled()
    expect(screen.getByTestId("conversation-viewer").dataset.connection).toBe(
      ""
    )
  })

  it("takes the conversation to a tab, closing the drawer", () => {
    open(target())
    draw()
    fireEvent.click(
      screen.getByRole("button", { name: "Open the conversation" })
    )
    expect(h.openConversations).toHaveBeenCalledTimes(1)
    expect(h.openTab).toHaveBeenCalledWith(7, 41, "codex")
    expect(usePersonalAgentUi.getState().workOpen).toBe(false)
  })
})

describe("PersonalAgentWorkDrawer — a task", () => {
  const task = (patch: Partial<WorkTask> = {}) =>
    ({
      id: 5,
      title: "Add a test page",
      status: "running",
      folder_id: 2,
      conversation_id: 12,
      ...patch,
    }) as WorkTask

  it("opens the task's session, as the board holds it", () => {
    h.tasks = [task()]
    open(target({ mode: "task", workTaskId: 5, folderId: 2 }))
    draw()
    expect(screen.getByTestId("task-viewer").dataset.task).toBe("5")
    expect(h.workTaskGet).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole("button", { name: "Open on the board" }))
    expect(h.focusTasks).toHaveBeenCalledWith({ folderId: 2 })
    expect(h.setRoute).toHaveBeenCalledWith("tasks")
    expect(usePersonalAgentUi.getState().workOpen).toBe(false)
  })

  it("says a task has not started yet, with the way to the board", () => {
    h.tasks = [task({ status: "queued", conversation_id: null })]
    open(target({ mode: "task", workTaskId: 5 }))
    draw()
    expect(screen.queryByTestId("task-viewer")).toBeNull()
    expect(
      screen.getByText(
        "This task hasn't started yet. Its session shows here once it does."
      )
    ).toBeTruthy()
    expect(
      screen.getByRole("button", { name: "Open on the board" })
    ).toBeTruthy()
  })

  it("reads a task the board does not hold", async () => {
    h.workTaskGet.mockResolvedValue(task())
    open(target({ mode: "task", workTaskId: 5 }))
    draw()
    expect(await screen.findByTestId("task-viewer")).toBeTruthy()
    expect(h.workTaskGet).toHaveBeenCalledWith(5)
  })

  it("says when the task is gone", async () => {
    h.workTaskGet.mockRejectedValue(new Error("no such task"))
    open(target({ mode: "task", workTaskId: 5 }))
    draw()
    expect(
      await screen.findByText(
        "Couldn't find this task — it may have been deleted."
      )
    ).toBeTruthy()
    expect(screen.queryByRole("button", { name: "Open on the board" })).toBe(
      null
    )
  })
})
