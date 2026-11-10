/**
 * "Create a task from this message": the editor opens over the page the
 * message is on, and the page stays put — the task is saved, the board
 * refetched, and a toast leads to the board.
 */
import { act, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"

import {
  useWorkbenchRoute,
  WorkbenchRouteProvider,
} from "@/contexts/workbench-route-context"
import enMessages from "@/i18n/messages/en.json"
import {
  openTaskFromMessage,
  resetTaskFromMessageForTests,
} from "@/lib/task-from-message"
import type { WorkTask, WorkTaskDraft } from "@/lib/types"
import { clearTasksFocus, peekTasksFocus } from "@/lib/workbench-focus"

const scene = vi.hoisted(() => ({
  refetch: vi.fn(async () => {}),
  create: vi.fn(),
  toast: vi.fn(),
}))

vi.mock("@/contexts/tasks-view-context", () => ({
  useTasksView: () => ({ refetch: scene.refetch }),
}))
vi.mock("@/lib/api", () => ({
  workTaskCreate: (draft: WorkTaskDraft) => scene.create(draft),
}))
vi.mock("sonner", () => ({
  toast: { success: (...args: unknown[]) => scene.toast(...args) },
}))

const draft: WorkTaskDraft = {
  folder_id: 7,
  title: "Fix the login timeout",
  config: {
    prompt_blocks: [{ type: "text", text: "Fix the login timeout" }],
    display_text: "Fix the login timeout",
    agent_type: null,
    mode_id: null,
    config_values: {},
    base_branch: null,
  },
}

// The editor reports what it was opened with, and saves or cancels on demand.
// A save that fails stays in the editor, which shows the error itself.
vi.mock("./task-editor-dialog", () => ({
  TaskEditorDialog: ({
    open,
    onOpenChange,
    task,
    defaultFolderId,
    prefillText,
    onSubmit,
  }: {
    open: boolean
    onOpenChange: (open: boolean) => void
    task: WorkTask | null
    defaultFolderId: number | null
    prefillText?: string | null
    onSubmit: (draft: WorkTaskDraft) => Promise<void>
  }) =>
    open ? (
      <div
        role="dialog"
        data-task={String(task)}
        data-default-folder={String(defaultFolderId)}
      >
        {prefillText}
        <button type="button" onClick={() => onSubmit(draft).catch(() => {})}>
          save
        </button>
        <button type="button" onClick={() => onOpenChange(false)}>
          cancel
        </button>
      </div>
    ) : null,
}))

import { TaskFromMessageHost } from "./task-from-message-host"

function RouteProbe() {
  const { routeId, setRoute } = useWorkbenchRoute()
  return (
    <>
      <output aria-label="route">{routeId}</output>
      <button type="button" onClick={() => setRoute("tasks")}>
        to the board
      </button>
    </>
  )
}

function mount() {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <WorkbenchRouteProvider>
        <RouteProbe />
        <TaskFromMessageHost />
      </WorkbenchRouteProvider>
    </NextIntlClientProvider>
  )
}

function open(text: string, folderId: number | null = 7) {
  act(() => openTaskFromMessage({ text, folderId }))
}

const route = () => screen.getByRole("status", { name: "route" }).textContent

beforeEach(() => {
  resetTaskFromMessageForTests()
  clearTasksFocus(peekTasksFocus())
  scene.refetch.mockClear()
  scene.toast.mockClear()
  scene.create.mockReset()
  scene.create.mockImplementation(
    async (d: WorkTaskDraft) =>
      ({ id: 41, folder_id: d.folder_id, title: d.title }) as WorkTask
  )
})

describe("TaskFromMessageHost", () => {
  it("opens a new task's editor over the page, seeded with the message", () => {
    mount()
    expect(screen.queryByRole("dialog")).toBeNull()

    open("Fix the login timeout\nIt logs people out after a minute.", 7)

    const editor = screen.getByRole("dialog")
    expect(editor).toHaveAttribute("data-task", "null")
    expect(editor).toHaveAttribute("data-default-folder", "7")
    expect(editor).toHaveTextContent(
      "Fix the login timeout It logs people out after a minute."
    )
    // The page it was asked from stays on screen.
    expect(route()).toBe("conversations")
  })

  it("saves the task, refetches the board and toasts a way to it", async () => {
    const user = userEvent.setup()
    mount()
    open("Fix the login timeout")

    await user.click(screen.getByRole("button", { name: "save" }))

    expect(scene.create).toHaveBeenCalledWith(draft)
    expect(screen.queryByRole("dialog")).toBeNull()
    expect(scene.refetch).toHaveBeenCalledTimes(1)
    expect(route()).toBe("conversations")
    expect(scene.toast).toHaveBeenCalledTimes(1)
    const [message, options] = scene.toast.mock.calls[0] as [
      string,
      { action: { label: string; onClick: () => void } },
    ]
    expect(message).toBe("Task created: Fix the login timeout")
    expect(options.action.label).toBe("View")

    act(() => options.action.onClick())
    expect(route()).toBe("tasks")
    // The board opens on the task's project.
    expect(peekTasksFocus()).toEqual({ folderId: 7 })
  })

  it("leaves the editor open with nothing saved when the save fails", async () => {
    const user = userEvent.setup()
    scene.create.mockRejectedValueOnce(new Error("disk full"))
    mount()
    open("Fix the login timeout")

    await user.click(screen.getByRole("button", { name: "save" }))

    expect(screen.getByRole("dialog")).toBeInTheDocument()
    expect(scene.refetch).not.toHaveBeenCalled()
    expect(scene.toast).not.toHaveBeenCalled()
  })

  it("offers no way to the board when asked from the board", async () => {
    const user = userEvent.setup()
    mount()
    // A task's session drawer, over the board.
    await user.click(screen.getByRole("button", { name: "to the board" }))
    open("Fix the login timeout")

    await user.click(screen.getByRole("button", { name: "save" }))

    expect(scene.toast).toHaveBeenCalledWith(
      "Task created: Fix the login timeout",
      undefined
    )
    expect(peekTasksFocus()).toBeNull()
  })

  it("parks no focus for a board already on screen when the toast is followed", async () => {
    const user = userEvent.setup()
    mount()
    open("Fix the login timeout")
    await user.click(screen.getByRole("button", { name: "save" }))
    const [, options] = scene.toast.mock.calls[0] as [
      string,
      { action: { onClick: () => void } },
    ]
    // The person went to the board on their own before following the toast.
    await user.click(screen.getByRole("button", { name: "to the board" }))

    act(() => options.action.onClick())

    expect(route()).toBe("tasks")
    expect(peekTasksFocus()).toBeNull()
  })

  it("closes on cancel, and opens fresh on the next message", async () => {
    const user = userEvent.setup()
    mount()
    open("First message", 7)
    await user.click(screen.getByRole("button", { name: "cancel" }))
    expect(screen.queryByRole("dialog")).toBeNull()
    expect(scene.create).not.toHaveBeenCalled()

    open("Second message", null)

    const editor = screen.getByRole("dialog")
    expect(editor).toHaveTextContent("Second message")
    expect(editor).toHaveAttribute("data-default-folder", "null")
  })

  it("keeps the open editor's message when another request comes in", () => {
    mount()
    open("Half-written task", 7)

    open("Another message", 9)

    const editor = screen.getByRole("dialog")
    expect(editor).toHaveTextContent("Half-written task")
    expect(editor).toHaveAttribute("data-default-folder", "7")
  })
})
