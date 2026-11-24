/**
 * The drawer's follow-up / note box reads the EDITOR, never the render's state.
 *
 * `composerText` trails the document by however long React takes to commit a
 * keystroke, and the editor invokes `onSubmit` out of a ref that a passive
 * effect refreshes — so anything read at render time can be one render behind
 * the keypress that triggered it. These pin the three action paths to the live
 * document instead, and pin the send to one request per submit.
 */
import { act, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { useEffect } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import type { PromptInputBlock, WorkTask } from "@/lib/types"

import { TaskDetailSheet } from "./task-detail-sheet"
import type {
  TaskMessageComposerHandle,
  TaskMessageComposerProps,
} from "./task-message-composer"

const workTaskReturn = vi.fn().mockResolvedValue(undefined)
const workTaskRetry = vi.fn().mockResolvedValue(undefined)
const workTaskRequeue = vi.fn().mockResolvedValue(undefined)

vi.mock("@/lib/api", () => ({
  workTaskGet: vi.fn().mockRejectedValue(new Error("not in this test")),
  workTaskArchive: vi.fn().mockResolvedValue(undefined),
  workTaskCancel: vi.fn().mockResolvedValue(undefined),
  getFolderConversation: vi.fn().mockRejectedValue(new Error("no transcript")),
  workTaskChangedFiles: vi.fn().mockResolvedValue([]),
  workTaskCleanup: vi.fn().mockResolvedValue(undefined),
  workTaskDelete: vi.fn().mockResolvedValue(undefined),
  workTaskDiff: vi.fn().mockResolvedValue(""),
  workTaskEvents: vi.fn().mockResolvedValue([]),
  workTaskRequeue: (...args: unknown[]) => workTaskRequeue(...args),
  workTaskRetry: (...args: unknown[]) => workTaskRetry(...args),
  workTaskReturn: (...args: unknown[]) => workTaskReturn(...args),
  workTaskStart: vi.fn().mockResolvedValue(undefined),
}))
vi.mock("@/lib/platform", () => ({
  subscribe: vi.fn().mockResolvedValue(() => {}),
  onTransportReconnect: vi.fn(() => () => {}),
}))
vi.mock("@/stores/app-workspace-store", () => {
  const state = {
    allFolders: [{ id: 1, path: "/repo", default_agent_type: null }],
  }
  const useStore = (selector: (s: typeof state) => unknown) => selector(state)
  return { useAppWorkspaceStore: useStore }
})
// Heavy leaves that have nothing to do with the composer.
vi.mock("@/components/ai-elements/message", () => ({
  MessageResponse: ({ children }: { children?: string }) => (
    <div>{children}</div>
  ),
}))
vi.mock("@/components/diff/unified-diff-preview", () => ({
  UnifiedDiffPreview: () => <div />,
}))
// The nested session viewer the sheet now hosts. Never opened here, but its
// module graph reaches the tab store, which reads the app-workspace store at
// module scope — and that store is stubbed above down to a bare hook.
vi.mock("./task-transcript-dialog", () => ({
  TaskTranscriptDialog: () => null,
}))

/**
 * The composer, stubbed down to what the drawer talks to: a handle whose text
 * the test sets directly (standing in for a document the parent's state has not
 * caught up with) and the props the drawer passes in.
 */
let editorText = ""
let editorBlocks: PromptInputBlock[] = []
let uploading = false
let composerProps: TaskMessageComposerProps | null = null
vi.mock("./task-message-composer", () => ({
  TaskMessageComposer: (props: TaskMessageComposerProps) => {
    composerProps = props
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
    title: "Fix the retry path",
    config: null,
    status: "review",
    worktree_folder_id: null,
    conversation_id: null,
    archived_at: null,
    scheduled_at: null,
    cleanup_state: null,
    preflight: null,
    files_changed: 0,
    ...overrides,
  } as WorkTask
}

function mount(row: WorkTask) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <TaskDetailSheet
        open
        onOpenChange={() => {}}
        task={row}
        folderName="repo"
        onMerge={() => {}}
        onComplete={() => {}}
        onDeliverPr={() => {}}
        onCancel={() => {}}
        onEdit={() => {}}
        onSchedule={() => {}}
      />
    </NextIntlClientProvider>
  )
}

beforeEach(() => {
  editorText = ""
  editorBlocks = []
  uploading = false
  composerProps = null
  vi.clearAllMocks()
})

describe("task drawer follow-up", () => {
  it("sends what the editor holds, not what the last render saw", async () => {
    const user = userEvent.setup()
    mount(task())
    await user.click(screen.getByRole("button", { name: /follow up/i }))
    await screen.findByTestId("follow-up-composer")

    // The document has text the parent's state hasn't received yet — exactly
    // the state an Enter pressed on the same tick as the keystroke sees.
    editorText = "look at [retry.ts](file:///repo/retry.ts) again"
    await act(async () => {
      composerProps?.onSubmit?.()
    })

    await waitFor(() => expect(workTaskReturn).toHaveBeenCalledTimes(1))
    expect(workTaskReturn).toHaveBeenCalledWith(
      7,
      "look at [retry.ts](file:///repo/retry.ts) again",
      "revise",
      []
    )
  })

  it("sends once when the send key fires twice before React catches up", async () => {
    const user = userEvent.setup()
    let release: (() => void) | undefined
    workTaskReturn.mockImplementationOnce(
      () => new Promise<void>((resolve) => (release = () => resolve()))
    )
    mount(task())
    await user.click(screen.getByRole("button", { name: /follow up/i }))
    await screen.findByTestId("follow-up-composer")

    // State in sync with the document here, so nothing but the latch can be
    // what stops the second send.
    editorText = "one send only"
    await act(async () => {
      composerProps?.onChange("one send only")
    })
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

  it("attaches the live note to a restart", async () => {
    const user = userEvent.setup()
    mount(task({ status: "failed", last_error: "boom" }))
    // The restart button only unfolds the box; the send inside it restarts.
    await user.click(screen.getByRole("button", { name: /^retry$/i }))
    await screen.findByTestId("follow-up-composer")
    expect(workTaskRetry).not.toHaveBeenCalled()

    editorText = "run pnpm install first"
    await user.click(screen.getByRole("button", { name: /^send$/i }))
    await waitFor(() => expect(workTaskRetry).toHaveBeenCalledTimes(1))
    expect(workTaskRetry).toHaveBeenCalledWith(
      7,
      "run pnpm install first",
      [],
      false
    )
  })

  it.each([
    ["failed", "Retry", () => workTaskRetry],
    ["canceled", "Requeue", () => workTaskRequeue],
  ] as const)(
    "restarts a %s task once when the send key fires twice",
    async (status, button, api) => {
      const user = userEvent.setup()
      let release: (() => void) | undefined
      api().mockImplementationOnce(
        () => new Promise<void>((resolve) => (release = () => resolve()))
      )
      mount(task({ status }))
      await user.click(screen.getByRole("button", { name: button }))
      await screen.findByTestId("follow-up-composer")

      // The box sends now, so the restart is reachable from the editor's own
      // keydown ref — `busy` alone cannot stop the second press.
      editorText = "one restart only"
      await act(async () => {
        composerProps?.onSubmit?.()
        composerProps?.onSubmit?.()
      })
      expect(api()).toHaveBeenCalledTimes(1)
      await act(async () => {
        release?.()
      })
      expect(api()).toHaveBeenCalledTimes(1)
    }
  )

  it("restarts with a null note when the box is left empty", async () => {
    const user = userEvent.setup()
    mount(task({ status: "canceled" }))
    await user.click(screen.getByRole("button", { name: /re-?queue/i }))
    await screen.findByTestId("follow-up-composer")

    // An untouched box is the plain one-click restart it replaced.
    await user.click(screen.getByRole("button", { name: /^send$/i }))
    await waitFor(() => expect(workTaskRequeue).toHaveBeenCalledTimes(1))
    expect(workTaskRequeue).toHaveBeenCalledWith(7, null, [], false)
  })

  it("keeps the note box open on a resurrection refusal and waives on the retry", async () => {
    const user = userEvent.setup()
    workTaskRetry.mockRejectedValueOnce(
      new Error(
        "validation error: duplicate_active_source: task #9 (Same issue) is already active for this work item"
      )
    )
    mount(task({ status: "failed", last_error: "boom" }))
    await user.click(screen.getByRole("button", { name: /^retry$/i }))
    await screen.findByTestId("follow-up-composer")

    editorText = "this note must survive"
    await user.click(screen.getByRole("button", { name: /^send$/i }))
    // Announced, not just drawn: focus is in the editor when this arrives.
    expect(await screen.findByRole("alert")).toHaveTextContent(
      /#9 \(Same issue\) is already active/
    )
    // A restart that did NOT happen must not close the box with the note in
    // it — the whole point is that the user answers and sends the same note.
    expect(screen.getByTestId("follow-up-composer")).toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: "Restart anyway" }))
    await waitFor(() => expect(workTaskRetry).toHaveBeenCalledTimes(2))
    expect(workTaskRetry).toHaveBeenLastCalledWith(
      7,
      "this note must survive",
      [],
      true
    )
  })

  it("retires the guard's warning when the note box is closed again", async () => {
    const user = userEvent.setup()
    workTaskRetry.mockRejectedValueOnce(
      new Error(
        "validation error: duplicate_active_source: task #9 (Same issue) is already active for this work item"
      )
    )
    mount(task({ status: "failed", last_error: "boom" }))
    const retry = screen.getByRole("button", { name: /^retry$/i })
    await user.click(retry)
    await screen.findByTestId("follow-up-composer")
    await user.click(screen.getByRole("button", { name: /^send$/i }))
    await screen.findByRole("button", { name: "Restart anyway" })

    // Fold the box away and open it again: the refusal belonged to the box it
    // was raised in. Reopening on a stale "restart anyway" would waive a guard
    // the user never saw refuse anything on this pass.
    await user.click(retry)
    await user.click(retry)
    await screen.findByTestId("follow-up-composer")
    expect(
      screen.queryByRole("button", { name: "Restart anyway" })
    ).not.toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: /^send$/i }))
    await waitFor(() => expect(workTaskRetry).toHaveBeenCalledTimes(2))
    expect(workTaskRetry).toHaveBeenLastCalledWith(7, null, [], false)
  })

  it("follows up on a pasted screenshot with no prose", async () => {
    const user = userEvent.setup()
    editorBlocks = [
      { type: "image", data: "aGk=", mime_type: "image/png", uri: null },
    ]
    mount(task())
    await user.click(screen.getByRole("button", { name: /follow up/i }))
    await screen.findByTestId("follow-up-composer")
    // `revise` normally demands text; an attachment is content in its own
    // right, so the send is live and the image travels as its own block.
    await act(async () => {
      composerProps?.onAttachmentsChange?.(1)
    })
    await user.click(screen.getByRole("button", { name: /^send$/i }))
    await waitFor(() => expect(workTaskReturn).toHaveBeenCalledTimes(1))
    expect(workTaskReturn).toHaveBeenCalledWith(7, "", "revise", editorBlocks)
  })

  it("refuses to send while an image upload is still in flight", async () => {
    const user = userEvent.setup()
    uploading = true
    editorText = "look at this"
    editorBlocks = [
      { type: "image", data: "", mime_type: "image/png", uri: null },
    ]
    mount(task())
    await user.click(screen.getByRole("button", { name: /follow up/i }))
    await screen.findByTestId("follow-up-composer")
    await act(async () => {
      composerProps?.onSubmit?.()
    })
    // The block would reach the agent with neither bytes nor a uri.
    expect(workTaskReturn).not.toHaveBeenCalled()
  })
})
