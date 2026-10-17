/**
 * The card's follow-up dialog ("继续处理" on a task put aside to handle later)
 * obeys the drawer box's rules: the text is read from the EDITOR when the send
 * fires, the scenario decides whether an empty box can go, and one submit is
 * one request even when the send key fires twice.
 */
import { act, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { useEffect, useState } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import type { PromptInputBlock, WorkTask } from "@/lib/types"

import { TaskFollowUpDialog } from "./task-follow-up-dialog"
import type {
  TaskMessageComposerHandle,
  TaskMessageComposerProps,
} from "./task-message-composer"

const workTaskReturn = vi.fn().mockResolvedValue(undefined)
const toastError = vi.fn()

vi.mock("sonner", () => ({
  toast: { error: (...a: unknown[]) => toastError(...a) },
}))

vi.mock("@/lib/api", () => ({
  workTaskReturn: (...args: unknown[]) => workTaskReturn(...args),
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
    return <div data-testid="follow-up-composer" />
  },
}))

function task(overrides: Partial<WorkTask> = {}): WorkTask {
  return {
    id: 7,
    folder_id: 1,
    title: "Fix login",
    config: null,
    status: "review",
    deferred_at: "2026-08-01T02:00:00Z",
    worktree_folder_id: null,
    ...overrides,
  } as WorkTask
}

function mount(
  row: WorkTask,
  onOpenChange: (open: boolean) => void = () => {}
) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <TaskFollowUpDialog open onOpenChange={onOpenChange} task={row} />
    </NextIntlClientProvider>
  )
}

/** What the box reports while the user types — the send button reads it. */
function typed(text: string) {
  act(() => composerProps?.onChange?.(text))
}

beforeEach(() => {
  editorText = ""
  editorBlocks = []
  uploading = false
  composerProps = null
  composerSeed = null
  vi.clearAllMocks()
})

describe("TaskFollowUpDialog", () => {
  it("follows up with what the editor holds, framed as a revision by default", async () => {
    const user = userEvent.setup()
    const onOpenChange = vi.fn()
    mount(task(), onOpenChange)
    typed("stale")
    // Text the dialog's state has not received yet — exactly what a click on
    // the same tick as the keystroke sees.
    editorText = "rename it in [auth.ts](file:///repo/auth.ts) too"

    await user.click(screen.getByRole("button", { name: "Send" }))
    await waitFor(() => expect(workTaskReturn).toHaveBeenCalledTimes(1))
    expect(workTaskReturn).toHaveBeenCalledWith(
      7,
      "rename it in [auth.ts](file:///repo/auth.ts) too",
      "revise",
      []
    )
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it("needs something to send unless the scenario stands on its own", async () => {
    const user = userEvent.setup()
    mount(task())
    // A revision with nothing in it is not an instruction.
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled()

    // A self-check is: "look it over before I accept it" needs no words.
    await user.click(screen.getByRole("combobox", { name: "Follow up" }))
    const list = await screen.findByRole("listbox")
    await user.click(within(list).getByRole("option", { name: "Double-check" }))
    const send = screen.getByRole("button", { name: "Send" })
    expect(send).toBeEnabled()
    await user.click(send)
    await waitFor(() => expect(workTaskReturn).toHaveBeenCalledTimes(1))
    expect(workTaskReturn).toHaveBeenCalledWith(7, "", "verify", [])
  })

  it("sends a pasted screenshot alone", async () => {
    const user = userEvent.setup()
    editorBlocks = [
      { type: "image", data: "aGk=", mime_type: "image/png", uri: null },
    ]
    mount(task())
    act(() => composerProps?.onAttachmentsChange?.(1))
    await user.click(screen.getByRole("button", { name: "Send" }))
    await waitFor(() => expect(workTaskReturn).toHaveBeenCalledTimes(1))
    expect(workTaskReturn).toHaveBeenCalledWith(7, "", "revise", editorBlocks)
  })

  it("waits for an image upload still in flight", async () => {
    uploading = true
    editorText = "see the screenshot"
    editorBlocks = [
      { type: "image", data: "", mime_type: "image/png", uri: null },
    ]
    mount(task())
    await act(async () => {
      composerProps?.onSubmit?.()
    })
    // The block would carry neither bytes nor a uri to hydrate from.
    expect(workTaskReturn).not.toHaveBeenCalled()
    expect(toastError).toHaveBeenCalledTimes(1)
  })

  it("keeps a refusal in the dialog, with the text still there", async () => {
    const user = userEvent.setup()
    const onOpenChange = vi.fn()
    workTaskReturn.mockRejectedValueOnce(new Error("task is not in review"))
    mount(task(), onOpenChange)
    typed("try again")
    editorText = "try again"

    await user.click(screen.getByRole("button", { name: "Send" }))
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "task is not in review"
    )
    expect(onOpenChange).not.toHaveBeenCalled()
    // Nothing was spent: the same send can go again once fixed.
    expect(screen.getByRole("button", { name: "Send" })).toBeEnabled()
  })

  it("sends once when the send key fires twice before React catches up", async () => {
    let release: (() => void) | undefined
    workTaskReturn.mockImplementationOnce(
      () => new Promise<void>((resolve) => (release = () => resolve()))
    )
    mount(task())
    editorText = "one follow-up only"

    await act(async () => {
      composerProps?.onSubmit?.()
      composerProps?.onSubmit?.()
    })
    expect(workTaskReturn).toHaveBeenCalledTimes(1)
    await act(async () => {
      release?.()
    })
    expect(workTaskReturn).toHaveBeenCalledTimes(1)
  })

  it("keeps the draft through a board refetch, and starts every open fresh", async () => {
    const user = userEvent.setup()
    const view = (open: boolean, row: WorkTask) => (
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <TaskFollowUpDialog open={open} onOpenChange={() => {}} task={row} />
      </NextIntlClientProvider>
    )
    const { rerender } = render(view(true, task()))
    expect(composerSeed).toBe("")
    typed("half a thought")
    await user.click(screen.getByRole("combobox", { name: "Follow up" }))
    await user.click(
      within(await screen.findByRole("listbox")).getByRole("option", {
        name: "Keep going",
      })
    )

    // The board hands out a fresh row on every refetch — same task, new
    // object. Nothing the user has put in the box may go with it.
    rerender(view(true, task({ updated_at: "2026-08-01T03:00:00Z" })))
    expect(composerProps?.defaultText).toBe("half a thought")
    expect(
      screen.getByRole("combobox", { name: "Follow up" })
    ).toHaveTextContent("Keep going")
    expect(screen.getByRole("button", { name: "Send" })).toBeEnabled()

    // Closed and opened again (another card, or the same one later): a fresh
    // box. The editor reads its text once, when it mounts — so what it mounts
    // with is what the user sees.
    rerender(view(false, task()))
    rerender(view(true, task({ id: 8 })))
    expect(composerSeed).toBe("")
    expect(
      screen.getByRole("combobox", { name: "Follow up" })
    ).toHaveTextContent("Rework")
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled()
  })
})
