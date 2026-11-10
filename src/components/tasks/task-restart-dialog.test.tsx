/**
 * The card's restart dialog obeys the same rule as the drawer's note box: the
 * note is read from the EDITOR when the action fires, never from the render's
 * state (the editor runs ahead of React by a commit), and one submit means one
 * request even when the send key fires twice.
 */
import { act, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { useEffect, useState } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import type { PromptInputBlock, WorkTask } from "@/lib/types"

import { TaskRestartDialog } from "./task-restart-dialog"
import type {
  TaskMessageComposerHandle,
  TaskMessageComposerProps,
} from "./task-message-composer"

const workTaskRetry = vi.fn().mockResolvedValue(undefined)
const workTaskRequeue = vi.fn().mockResolvedValue(undefined)
const toastError = vi.fn()

vi.mock("sonner", () => ({
  toast: { error: (...a: unknown[]) => toastError(...a) },
}))

vi.mock("@/lib/api", () => ({
  workTaskRequeue: (...args: unknown[]) => workTaskRequeue(...args),
  workTaskRetry: (...args: unknown[]) => workTaskRetry(...args),
}))
vi.mock("@/stores/app-workspace-store", () => {
  const state = {
    allFolders: [{ id: 1, path: "/repo", default_agent_type: null }],
  }
  const useStore = (selector: (s: typeof state) => unknown) => selector(state)
  return { useAppWorkspaceStore: useStore }
})

/** The composer, stubbed to a handle whose text the test sets directly. */
let editorText = ""
let editorBlocks: PromptInputBlock[] = []
let uploading = false
let composerProps: TaskMessageComposerProps | null = null
/** What the box showed when it mounted — the real editor reads `defaultText`
 *  once, at creation, and is uncontrolled after that. */
let composerSeed: string | null = null
vi.mock("./task-message-composer", () => ({
  TaskMessageComposer: (props: TaskMessageComposerProps) => {
    composerProps = props
    const [seed] = useState(props.defaultText)
    composerSeed = seed
    const ref = props.ref
    useEffect(() => {
      if (!ref || typeof ref === "function") return
      ref.current = {
        getText: () => editorText,
        getAttachmentBlocks: () => editorBlocks,
        hasUploadingImage: () => uploading,
        hasAttachments: () => editorBlocks.length > 0,
      } as TaskMessageComposerHandle
      return () => {
        ref.current = null
      }
    }, [ref])
    return <div data-testid="restart-composer" />
  },
}))

function task(overrides: Partial<WorkTask> = {}): WorkTask {
  return {
    id: 7,
    folder_id: 1,
    title: "Fix login",
    config: null,
    status: "failed",
    worktree_folder_id: null,
    ...overrides,
  } as WorkTask
}

function mount(row: WorkTask, kind: "retry" | "requeue" = "retry") {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <TaskRestartDialog open onOpenChange={() => {}} task={row} kind={kind} />
    </NextIntlClientProvider>
  )
}

beforeEach(() => {
  editorText = ""
  editorBlocks = []
  uploading = false
  composerProps = null
  composerSeed = null
  vi.clearAllMocks()
})

describe("TaskRestartDialog", () => {
  it("retries with what the editor holds, not what the last render saw", async () => {
    const user = userEvent.setup()
    mount(task())
    // Text the parent's state has not received yet — exactly what a click on
    // the same tick as the keystroke sees.
    editorText = "look at [retry.ts](file:///repo/retry.ts) first"

    await user.click(screen.getByRole("button", { name: "Retry" }))
    await waitFor(() => expect(workTaskRetry).toHaveBeenCalledTimes(1))
    expect(workTaskRetry).toHaveBeenCalledWith(
      7,
      "look at [retry.ts](file:///repo/retry.ts) first",
      [],
      false
    )
  })

  it("requeues with a null note when the box is untouched", async () => {
    const user = userEvent.setup()
    mount(task({ status: "canceled" }), "requeue")
    await user.click(screen.getByRole("button", { name: "Requeue" }))
    await waitFor(() => expect(workTaskRequeue).toHaveBeenCalledTimes(1))
    expect(workTaskRequeue).toHaveBeenCalledWith(7, null, [], false)
  })

  it("restarts on a pasted screenshot alone, with no note", async () => {
    const user = userEvent.setup()
    editorBlocks = [
      { type: "image", data: "aGk=", mime_type: "image/png", uri: null },
    ]
    mount(task())
    await user.click(screen.getByRole("button", { name: "Retry" }))
    await waitFor(() => expect(workTaskRetry).toHaveBeenCalledTimes(1))
    // No prose, but the image still reaches the next run as its own block.
    expect(workTaskRetry).toHaveBeenCalledWith(7, null, editorBlocks, false)
  })

  it("refuses to send while an image upload is still in flight", async () => {
    const user = userEvent.setup()
    uploading = true
    editorBlocks = [
      { type: "image", data: "", mime_type: "image/png", uri: null },
    ]
    mount(task())
    await user.click(screen.getByRole("button", { name: "Retry" }))
    // The block would carry neither bytes nor a uri to hydrate from.
    expect(workTaskRetry).not.toHaveBeenCalled()
  })

  it("offers the override when the resurrection guard refuses, and only then", async () => {
    const user = userEvent.setup()
    workTaskRetry.mockRejectedValueOnce(
      new Error(
        "validation error: duplicate_active_source: task #9 (Same issue) is already active for this work item"
      )
    )
    editorText = "the note survives the refusal"
    mount(task())

    await user.click(screen.getByRole("button", { name: "Retry" }))
    // The refusal is answerable, so it lands in the dialog rather than in a
    // toast that leaves the card with nowhere to go.
    const alert = await screen.findByRole("alert")
    // Announced, not just drawn: focus is in the editor when this arrives.
    expect(alert).toHaveTextContent(/#9 \(Same issue\) is already active/)
    expect(toastError).not.toHaveBeenCalled()
    expect(
      screen.queryByRole("button", { name: "Retry" })
    ).not.toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: "Restart anyway" }))
    await waitFor(() => expect(workTaskRetry).toHaveBeenCalledTimes(2))
    // Same note, now with the waiver the backend already accepts.
    expect(workTaskRetry).toHaveBeenLastCalledWith(
      7,
      "the note survives the refusal",
      [],
      true
    )
  })

  it("keeps waiving from the send key once the warning is up", async () => {
    workTaskRequeue.mockRejectedValueOnce(
      new Error("validation error: duplicate_active_source: task #9 (X) is")
    )
    mount(task({ status: "canceled" }), "requeue")

    await act(async () => {
      composerProps?.onSubmit?.()
    })
    await screen.findByRole("button", { name: "Restart anyway" })
    await act(async () => {
      composerProps?.onSubmit?.()
    })
    // A send key that re-ran into the same refusal would read as a dead key.
    await waitFor(() => expect(workTaskRequeue).toHaveBeenCalledTimes(2))
    expect(workTaskRequeue).toHaveBeenLastCalledWith(7, null, [], true)
  })

  it("still toasts a failure that has nothing to decide", async () => {
    const user = userEvent.setup()
    workTaskRetry.mockRejectedValueOnce(new Error("task is not in failed"))
    mount(task())

    await user.click(screen.getByRole("button", { name: "Retry" }))
    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith("task is not in failed")
    )
    expect(
      screen.queryByRole("button", { name: "Restart anyway" })
    ).not.toBeInTheDocument()
    // The primary stays what it was — no waiver to offer.
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument()
  })

  it("sends once when the send key fires twice before React catches up", async () => {
    let release: (() => void) | undefined
    workTaskRetry.mockImplementationOnce(
      () => new Promise<void>((resolve) => (release = () => resolve()))
    )
    mount(task())
    editorText = "one restart only"

    await act(async () => {
      composerProps?.onSubmit?.()
      composerProps?.onSubmit?.()
    })
    expect(workTaskRetry).toHaveBeenCalledTimes(1)
    await act(async () => {
      release?.()
    })
    expect(workTaskRetry).toHaveBeenCalledTimes(1)
  })

  it("opens with an empty box every time, never the last restart's note", async () => {
    const user = userEvent.setup()
    const view = (open: boolean, row: WorkTask) => (
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <TaskRestartDialog
          open={open}
          onOpenChange={() => {}}
          task={row}
          kind="retry"
        />
      </NextIntlClientProvider>
    )
    const { rerender } = render(view(true, task()))
    editorText = "run pnpm install first"
    act(() => composerProps?.onChange?.("run pnpm install first"))
    await user.click(screen.getByRole("button", { name: "Retry" }))
    await waitFor(() => expect(workTaskRetry).toHaveBeenCalledTimes(1))

    // The next restart — another card — must not carry that note: the editor
    // reads its text once, when it mounts, so a stale seed is a stale box.
    rerender(view(false, task()))
    rerender(view(true, task({ id: 8 })))
    expect(composerSeed).toBe("")
  })
})
