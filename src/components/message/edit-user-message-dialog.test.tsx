import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { Editor } from "@tiptap/core"
import { NextIntlClientProvider } from "next-intl"
import { describe, expect, it, vi } from "vitest"
import messages from "@/i18n/messages/en.json"
import type { ContentBlock, MessageTurn } from "@/lib/types"
import { serializeDocToText } from "@/components/chat/composer/to-prompt-blocks"
import {
  EditUserMessageDialog,
  type CheckpointStatus,
  type EditUserMessageDialogProps,
} from "./edit-user-message-dialog"

const image: ContentBlock = {
  type: "image",
  data: "aW1hZ2U=",
  mime_type: "image/png",
  uri: "file:///original.png",
}
const originalText =
  "  **literal** C:\\repo\\file.ts\n\n[app.ts](file:///repo/app.ts)  "

function turn(
  blocks: ContentBlock[] = [{ type: "text", text: originalText }, image]
): MessageTurn {
  return { id: "turn-1", role: "user", timestamp: "", blocks }
}

function mount(overrides: Partial<EditUserMessageDialogProps> = {}) {
  const props = {
    turn: turn(),
    onSubmit: vi.fn().mockResolvedValue(undefined),
    onCancel: vi.fn(),
    ...overrides,
  }
  let currentProps: EditUserMessageDialogProps = props
  const view = () => (
    <NextIntlClientProvider locale="en" messages={messages}>
      <EditUserMessageDialog {...currentProps} />
    </NextIntlClientProvider>
  )
  const result = render(view())
  return {
    ...result,
    ...props,
    rerenderDialog: (next: Partial<EditUserMessageDialogProps>) => {
      currentProps = { ...currentProps, ...next }
      result.rerender(view())
    },
  }
}

type RestorePreview = Awaited<
  ReturnType<NonNullable<EditUserMessageDialogProps["onPreviewFiles"]>>
>

const preview: RestorePreview = {
  token: "checkpoint-token",
  files: [
    { path: "src/new.ts", change: "created" },
    { path: "src/existing.ts", change: "modified" },
    { path: "src/removed.ts", change: "deleted" },
  ],
  conflicts: [],
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

const restoreCheckbox = () =>
  screen.getByRole("checkbox", {
    name: "Also restore files to before this message",
  })
const saveButton = () => screen.getByRole("button", { name: "Save and resend" })
const recordingCheckbox = () =>
  screen.getByRole("checkbox", {
    name: "Record file checkpoints for this workspace",
  })
const cleanupButton = () =>
  screen.getByRole("button", { name: "Clean up expired checkpoints" })
const checkpointStatus: CheckpointStatus = {
  enabled: false,
  recordCount: 3,
  objectBytes: 2048,
  maxRecords: 20,
  maxObjectBytes: 1048576,
  lastError: null,
}

async function editor() {
  const textbox = await screen.findByRole("textbox", { name: "Edit message" })
  await waitFor(() =>
    expect(textbox).toHaveTextContent(/literal|hello|unsupported/)
  )
  return (textbox as HTMLElement & { editor: Editor }).editor
}

describe("EditUserMessageDialog", () => {
  it("loads status on opening without enabling, cleaning up, previewing or submitting", async () => {
    const request = deferred<CheckpointStatus>()
    const onLoadCheckpointStatus = vi.fn(() => request.promise)
    const onSetCheckpointEnabled = vi.fn()
    const onCleanupCheckpoints = vi.fn()
    const onPreviewFiles = vi.fn()
    const { onSubmit } = mount({
      onLoadCheckpointStatus,
      onSetCheckpointEnabled,
      onCleanupCheckpoints,
      onPreviewFiles,
    })
    await editor()
    expect(onLoadCheckpointStatus).toHaveBeenCalledOnce()
    expect(recordingCheckbox()).not.toBeChecked()
    expect(recordingCheckbox()).toBeDisabled()
    expect(cleanupButton()).toBeDisabled()
    expect(screen.getByText(/Off by default.*future prompts/)).toBeVisible()
    expect(screen.getByText("Loading checkpoint status…")).toBeVisible()
    expect(restoreCheckbox()).toBeEnabled()
    expect(saveButton()).toBeEnabled()
    await act(async () => request.resolve(checkpointStatus))
    expect(recordingCheckbox()).not.toBeChecked()
    expect(recordingCheckbox()).toBeEnabled()
    expect(screen.getByText("Checkpoint recording is off.")).toBeVisible()
    expect(screen.getByText("Recent checkpoints: 3 / 20")).toBeVisible()
    expect(
      screen.getByText("Checkpoint storage: 2,048 / 1,048,576 bytes")
    ).toBeVisible()
    expect(onSetCheckpointEnabled).not.toHaveBeenCalled()
    expect(onCleanupCheckpoints).not.toHaveBeenCalled()
    expect(onPreviewFiles).not.toHaveBeenCalled()
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it("shows last capture errors and keeps restoration available while recording is off", async () => {
    const onSetCheckpointEnabled = vi.fn()
    const onPreviewFiles = vi.fn().mockResolvedValue(preview)
    const { onSubmit } = mount({
      onLoadCheckpointStatus: async () => ({
        ...checkpointStatus,
        lastError: "Checkpoint storage limit reached",
      }),
      onSetCheckpointEnabled,
      onPreviewFiles,
    })
    await editor()
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Last checkpoint error: Checkpoint storage limit reached"
    )
    await userEvent.click(restoreCheckbox())
    await waitFor(() => expect(saveButton()).toBeEnabled())
    expect(recordingCheckbox()).not.toBeChecked()
    await userEvent.click(saveButton())
    expect(onSubmit).toHaveBeenCalledWith(
      {
        displayText: originalText,
        blocks: [{ type: "text", text: originalText }, image],
      },
      preview.token
    )
    expect(onSetCheckpointEnabled).not.toHaveBeenCalled()
  })

  it("saves opt-in and opt-out explicitly without changing the draft or restore consent", async () => {
    const request = deferred<CheckpointStatus>()
    const onSetCheckpointEnabled = vi
      .fn()
      .mockReturnValueOnce(request.promise)
      .mockResolvedValueOnce(checkpointStatus)
    const { onSubmit, onCancel } = mount({
      onLoadCheckpointStatus: async () => checkpointStatus,
      onSetCheckpointEnabled,
      onCleanupCheckpoints: vi.fn(),
      onPreviewFiles: async () => preview,
    })
    const instance = await editor()
    act(() => instance.commands.insertContent(" revised"))
    const draftText = serializeDocToText(instance.state.doc)
    await userEvent.click(recordingCheckbox())
    expect(onSetCheckpointEnabled).toHaveBeenCalledWith(true)
    expect(recordingCheckbox()).toBeDisabled()
    expect(cleanupButton()).toBeDisabled()
    expect(saveButton()).toBeDisabled()
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" })
    expect(onSubmit).not.toHaveBeenCalled()
    await act(async () =>
      request.resolve({ ...checkpointStatus, enabled: true })
    )
    expect(recordingCheckbox()).toBeChecked()
    expect(screen.getByText("Checkpoint recording is on.")).toBeVisible()
    await userEvent.click(recordingCheckbox())
    expect(onSetCheckpointEnabled.mock.calls).toEqual([[true], [false]])
    expect(recordingCheckbox()).not.toBeChecked()
    expect(restoreCheckbox()).not.toBeChecked()
    expect(serializeDocToText(instance.state.doc)).toBe(draftText)
    expect(screen.getByRole("img", { name: "Attached image 1" })).toBeVisible()
    expect(onSubmit).not.toHaveBeenCalled()
    expect(onCancel).not.toHaveBeenCalled()
  })

  it.each([false, true])(
    "preserves saved state (%s), text and images after a toggle failure",
    async (enabled) => {
      const onSetCheckpointEnabled = vi
        .fn()
        .mockRejectedValueOnce(new Error("Preference could not be saved"))
        .mockResolvedValueOnce({ ...checkpointStatus, enabled: !enabled })
      const onSubmit = vi
        .fn()
        .mockRejectedValueOnce(new Error("Send failed"))
        .mockResolvedValueOnce(undefined)
      const { onCancel } = mount({
        onLoadCheckpointStatus: async () => ({ ...checkpointStatus, enabled }),
        onSetCheckpointEnabled,
        onSubmit,
      })
      const instance = await editor()
      act(() => instance.commands.insertContent(" revised"))
      const draftText = serializeDocToText(instance.state.doc)
      await userEvent.click(recordingCheckbox())
      expect(await screen.findByRole("alert")).toHaveTextContent(
        "Could not change checkpoint recording: Preference could not be saved"
      )
      expect(recordingCheckbox()).toHaveAttribute(
        "aria-checked",
        String(enabled)
      )
      expect(saveButton()).toBeEnabled()
      expect(serializeDocToText(instance.state.doc)).toBe(draftText)
      expect(
        screen.getByRole("img", { name: "Attached image 1" })
      ).toBeVisible()
      expect(onCancel).not.toHaveBeenCalled()
      await userEvent.click(recordingCheckbox())
      expect(recordingCheckbox()).toHaveAttribute(
        "aria-checked",
        String(!enabled)
      )
      expect(screen.queryByRole("alert")).not.toBeInTheDocument()
      await userEvent.click(saveButton())
      expect(await screen.findByRole("alert")).toHaveTextContent("Send failed")
      expect(serializeDocToText(instance.state.doc)).toBe(draftText)
      expect(
        screen.getByRole("img", { name: "Attached image 1" })
      ).toBeVisible()
      expect(onCancel).not.toHaveBeenCalled()
      await userEvent.click(saveButton())
      const draft = {
        displayText: draftText,
        blocks: [{ type: "text", text: draftText }, image],
      }
      expect(onSubmit.mock.calls).toEqual([[draft], [draft]])
      expect(onCancel).toHaveBeenCalledOnce()
    }
  )

  it("keeps the editor usable when status loading fails", async () => {
    const { onSubmit } = mount({
      onLoadCheckpointStatus: async () => {
        throw new Error("Status unavailable")
      },
      onSetCheckpointEnabled: vi.fn(),
    })
    await editor()
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not load checkpoint status: Status unavailable"
    )
    expect(screen.getByText("Checkpoint status is unavailable.")).toBeVisible()
    expect(recordingCheckbox()).not.toBeChecked()
    await userEvent.click(saveButton())
    expect(onSubmit).toHaveBeenCalledWith({
      displayText: originalText,
      blocks: [{ type: "text", text: originalText }, image],
    })
  })

  it("loads only once per opening despite parent refetches and callback changes", async () => {
    const request = deferred<CheckpointStatus>()
    const onLoadCheckpointStatus = vi.fn(() => request.promise)
    const nextLoad = vi.fn().mockResolvedValue(checkpointStatus)
    const { rerenderDialog } = mount({ onLoadCheckpointStatus })
    const instance = await editor()
    act(() => instance.commands.insertContent(" revised"))
    const draftText = serializeDocToText(instance.state.doc)
    rerenderDialog({ turn: turn(), onLoadCheckpointStatus: nextLoad })
    await act(async () =>
      request.resolve({ ...checkpointStatus, enabled: true })
    )
    expect(onLoadCheckpointStatus).toHaveBeenCalledOnce()
    expect(nextLoad).not.toHaveBeenCalled()
    expect(recordingCheckbox()).toBeChecked()
    expect(serializeDocToText(instance.state.doc)).toBe(draftText)
    rerenderDialog({ turn: { ...turn(), id: "turn-2" } })
    await waitFor(() => expect(nextLoad).toHaveBeenCalledOnce())
    await waitFor(() => expect(recordingCheckbox()).not.toBeChecked())
  })

  it("serializes cleanup, toggles and submission without starting a restore preview", async () => {
    const request = deferred<CheckpointStatus>()
    const onCleanupCheckpoints = vi.fn(() => request.promise)
    const onSetCheckpointEnabled = vi.fn()
    const onPreviewFiles = vi.fn()
    const { onSubmit } = mount({
      onLoadCheckpointStatus: async () => checkpointStatus,
      onCleanupCheckpoints,
      onSetCheckpointEnabled,
      onPreviewFiles,
    })
    const instance = await editor()
    expect(
      screen.getByText(/Your workspace files are not deleted or changed/)
    ).toBeVisible()
    const button = cleanupButton()
    act(() => {
      button.click()
      button.click()
    })
    expect(onCleanupCheckpoints).toHaveBeenCalledOnce()
    expect(cleanupButton()).toBeDisabled()
    expect(recordingCheckbox()).toBeDisabled()
    expect(restoreCheckbox()).toBeDisabled()
    expect(saveButton()).toBeDisabled()
    act(() => instance.commands.insertContent(" during cleanup"))
    const draftText = serializeDocToText(instance.state.doc)
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" })
    expect(onSubmit).not.toHaveBeenCalled()
    await act(async () =>
      request.resolve({ ...checkpointStatus, recordCount: 1, objectBytes: 512 })
    )
    expect(screen.getByText("Recent checkpoints: 1 / 20")).toBeVisible()
    expect(
      screen.getByText("Checkpoint storage: 512 / 1,048,576 bytes")
    ).toBeVisible()
    expect(recordingCheckbox()).not.toBeChecked()
    expect(onSetCheckpointEnabled).not.toHaveBeenCalled()
    expect(onPreviewFiles).not.toHaveBeenCalled()
    await userEvent.click(saveButton())
    expect(onSubmit).toHaveBeenCalledWith({
      displayText: draftText,
      blocks: [{ type: "text", text: draftText }, image],
    })
  })

  it.each(["pending", "ready"])(
    "refreshes a %s restore preview after cleanup and never submits a stale token",
    async (state) => {
      const oldPreview = deferred<RestorePreview>()
      const freshPreview = deferred<RestorePreview>()
      const cleanup = deferred<CheckpointStatus>()
      const onPreviewFiles = vi
        .fn()
        .mockReturnValueOnce(oldPreview.promise)
        .mockReturnValueOnce(freshPreview.promise)
      const { onSubmit } = mount({
        onPreviewFiles,
        onLoadCheckpointStatus: async () => checkpointStatus,
        onCleanupCheckpoints: () => cleanup.promise,
      })
      await editor()
      await userEvent.click(restoreCheckbox())
      if (state === "ready") await act(async () => oldPreview.resolve(preview))
      await userEvent.click(cleanupButton())
      expect(screen.queryByRole("list")).not.toBeInTheDocument()
      expect(saveButton()).toBeDisabled()
      await act(async () =>
        cleanup.resolve({ ...checkpointStatus, recordCount: 1 })
      )
      expect(onPreviewFiles).toHaveBeenCalledTimes(2)
      expect(saveButton()).toBeDisabled()
      await act(async () =>
        freshPreview.resolve({ ...preview, token: "fresh-after-cleanup" })
      )
      if (state === "pending")
        await act(async () =>
          oldPreview.resolve({ ...preview, conflicts: ["stale conflict"] })
        )
      expect(screen.queryByRole("alert")).not.toBeInTheDocument()
      await userEvent.click(saveButton())
      expect(onSubmit).toHaveBeenCalledWith(
        expect.anything(),
        "fresh-after-cleanup"
      )
    }
  )

  it("preserves status and the editor on cleanup failure and allows retry", async () => {
    const onCleanupCheckpoints = vi
      .fn()
      .mockRejectedValueOnce(new Error("Cleanup unavailable"))
      .mockResolvedValueOnce({
        ...checkpointStatus,
        recordCount: 0,
        objectBytes: 0,
      })
    const { onCancel } = mount({
      onLoadCheckpointStatus: async () => checkpointStatus,
      onCleanupCheckpoints,
    })
    const instance = await editor()
    act(() => instance.commands.insertContent(" revised"))
    const draftText = serializeDocToText(instance.state.doc)
    await userEvent.click(cleanupButton())
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not clean up checkpoints: Cleanup unavailable"
    )
    expect(screen.getByText("Recent checkpoints: 3 / 20")).toBeVisible()
    expect(serializeDocToText(instance.state.doc)).toBe(draftText)
    expect(screen.getByRole("img", { name: "Attached image 1" })).toBeVisible()
    expect(onCancel).not.toHaveBeenCalled()
    expect(saveButton()).toBeEnabled()
    await userEvent.click(cleanupButton())
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
    expect(screen.getByText("Recent checkpoints: 0 / 20")).toBeVisible()
  })

  it("blocks restore after cleanup expires its checkpoint until consent is unchecked", async () => {
    const onPreviewFiles = vi
      .fn()
      .mockResolvedValueOnce(preview)
      .mockRejectedValueOnce(new Error("Checkpoint expired"))
    const { onSubmit } = mount({
      onPreviewFiles,
      onLoadCheckpointStatus: async () => checkpointStatus,
      onCleanupCheckpoints: async () => ({
        ...checkpointStatus,
        recordCount: 0,
        objectBytes: 0,
      }),
    })
    await editor()
    await userEvent.click(restoreCheckbox())
    await userEvent.click(cleanupButton())
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Checkpoint expired"
    )
    expect(saveButton()).toBeDisabled()
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" })
    expect(onSubmit).not.toHaveBeenCalled()
    await userEvent.click(restoreCheckbox())
    await userEvent.click(saveButton())
    expect(vi.mocked(onSubmit).mock.calls[0]).toHaveLength(1)
  })

  it.each(["load", "toggle", "cleanup"] as const)(
    "ignores stale %s results after changing targets",
    async (action) => {
      const request = deferred<CheckpointStatus>()
      const onLoadCheckpointStatus = vi.fn().mockResolvedValue(checkpointStatus)
      if (action === "load")
        onLoadCheckpointStatus.mockReturnValueOnce(request.promise)
      const onPreviewFiles = vi.fn().mockResolvedValue(preview)
      const { rerenderDialog, onSubmit, onCancel } = mount({
        onLoadCheckpointStatus,
        onSetCheckpointEnabled: () => request.promise,
        onCleanupCheckpoints: () => request.promise,
        onPreviewFiles,
      })
      await editor()
      if (action === "toggle") await userEvent.click(recordingCheckbox())
      if (action === "cleanup") {
        await userEvent.click(restoreCheckbox())
        await userEvent.click(cleanupButton())
      }
      rerenderDialog({ turn: { ...turn(), id: "turn-2" } })
      await waitFor(() => expect(recordingCheckbox()).toBeEnabled())
      await act(async () =>
        request.resolve({ ...checkpointStatus, enabled: true, recordCount: 99 })
      )
      expect(recordingCheckbox()).not.toBeChecked()
      expect(screen.getByText("Recent checkpoints: 3 / 20")).toBeVisible()
      expect(restoreCheckbox()).not.toBeChecked()
      expect(onPreviewFiles).toHaveBeenCalledTimes(action === "cleanup" ? 1 : 0)
      expect(onSubmit).not.toHaveBeenCalled()
      expect(onCancel).not.toHaveBeenCalled()
    }
  )

  it.each([
    ["load", "resolve"],
    ["load", "reject"],
    ["toggle", "resolve"],
    ["toggle", "reject"],
    ["cleanup", "resolve"],
    ["cleanup", "reject"],
  ] as const)(
    "ignores %s %s after unmount without triggering preview or submit",
    async (action, settlement) => {
      const request = deferred<CheckpointStatus>()
      const onPreviewFiles = vi.fn().mockResolvedValue(preview)
      const { unmount, onSubmit, onCancel } = mount({
        onLoadCheckpointStatus: () =>
          action === "load"
            ? request.promise
            : Promise.resolve(checkpointStatus),
        onSetCheckpointEnabled: () => request.promise,
        onCleanupCheckpoints: () => request.promise,
        onPreviewFiles,
      })
      await editor()
      if (action === "toggle") await userEvent.click(recordingCheckbox())
      if (action === "cleanup") {
        await userEvent.click(restoreCheckbox())
        await userEvent.click(cleanupButton())
      }
      unmount()
      await act(async () => {
        if (settlement === "resolve") request.resolve(checkpointStatus)
        else request.reject(new Error("Late checkpoint failure"))
      })
      expect(onPreviewFiles).toHaveBeenCalledTimes(action === "cleanup" ? 1 : 0)
      expect(onSubmit).not.toHaveBeenCalled()
      expect(onCancel).not.toHaveBeenCalled()
    }
  )

  it("recovers an interrupted transaction and requires a fresh preview", async () => {
    const onRecoverFiles = vi.fn().mockResolvedValue(undefined)
    const onPreviewFiles = vi
      .fn()
      .mockRejectedValueOnce(
        new Error("Unresolved checkpoint recovery journal")
      )
      .mockResolvedValueOnce({
        token: "after-recovery",
        files: [],
        conflicts: [],
      })
    const { onSubmit } = mount({ onPreviewFiles, onRecoverFiles })
    await editor()
    await userEvent.click(screen.getByRole("checkbox"))
    await userEvent.click(
      await screen.findByRole("button", { name: "Recover interrupted restore" })
    )
    await waitFor(() => expect(onPreviewFiles).toHaveBeenCalledTimes(2))
    expect(onRecoverFiles).toHaveBeenCalledOnce()
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Save and resend" })
      ).toBeEnabled()
    )
    await userEvent.click(
      screen.getByRole("button", { name: "Save and resend" })
    )
    expect(onSubmit).toHaveBeenCalledWith(expect.anything(), "after-recovery")
  })
  it("hides restoration without a preview callback", async () => {
    const { onSubmit } = mount()
    await editor()
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument()
    await userEvent.click(saveButton())
    expect(onSubmit).toHaveBeenCalledWith({
      displayText: originalText,
      blocks: [{ type: "text", text: originalText }, image],
    })
  })

  it("defaults to conversation only and does not load or submit a preview", async () => {
    const onPreviewFiles = vi.fn().mockResolvedValue(preview)
    const { onSubmit } = mount({ onPreviewFiles })
    await editor()
    expect(restoreCheckbox()).not.toBeChecked()
    expect(screen.getByText(/Only regular, nonignored/)).toBeVisible()
    expect(screen.getByText(/Recent retained checkpoints only/)).toBeVisible()
    expect(
      screen.getByText(
        /Conflicting manual edits before or after the captured turn/
      )
    ).toBeVisible()
    expect(
      screen.getByText(/including manual edits during the turn/)
    ).toBeVisible()
    await userEvent.click(saveButton())
    expect(onPreviewFiles).not.toHaveBeenCalled()
    expect(onSubmit).toHaveBeenCalledWith({
      displayText: originalText,
      blocks: [{ type: "text", text: originalText }, image],
    })
  })

  it("loads a preview before enabling consent and sends its token with the edited image draft", async () => {
    const request = deferred<RestorePreview>()
    const onPreviewFiles = vi.fn(() => request.promise)
    const source = turn()
    const snapshot = structuredClone(source)
    const { onSubmit } = mount({ onPreviewFiles, turn: source })
    const instance = await editor()
    await userEvent.click(restoreCheckbox())
    expect(screen.getByRole("status")).toHaveTextContent(
      "Loading file restore preview"
    )
    expect(saveButton()).toBeDisabled()
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" })
    expect(onSubmit).not.toHaveBeenCalled()
    await act(async () => request.resolve(preview))
    expect(screen.getByRole("status")).toHaveTextContent("Files to restore: 3")
    const list = screen.getByRole("list", {
      name: "Current changes since the checkpoint",
    })
    expect(list).toHaveTextContent("src/new.tsCreated")
    expect(list).toHaveTextContent("src/existing.tsModified")
    expect(list).toHaveTextContent("src/removed.tsDeleted")
    expect(screen.getByText(/Previewing does not restore files/)).toBeVisible()
    expect(saveButton()).toBeEnabled()
    expect(onSubmit).not.toHaveBeenCalled()
    act(() => instance.commands.insertContent(" revised"))
    const draftText = serializeDocToText(instance.state.doc)
    expect(onPreviewFiles).toHaveBeenCalledOnce()
    await userEvent.click(saveButton())
    expect(onSubmit).toHaveBeenCalledWith(
      {
        displayText: draftText,
        blocks: [{ type: "text", text: draftText }, image],
      },
      preview.token
    )
    expect(source).toEqual(snapshot)
  })

  it("shows conflicts and blocks both submit paths until restoration is unchecked", async () => {
    const onPreviewFiles = vi.fn().mockResolvedValue({
      ...preview,
      conflicts: [
        "src/existing.ts changed externally",
        "src/locked.ts is unavailable",
      ],
    })
    const { onSubmit } = mount({ onPreviewFiles })
    await editor()
    await userEvent.click(restoreCheckbox())
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "src/existing.ts changed externally"
    )
    expect(screen.getByRole("alert")).toHaveTextContent(
      "src/locked.ts is unavailable"
    )
    expect(saveButton()).toBeDisabled()
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" })
    expect(onSubmit).not.toHaveBeenCalled()
    await userEvent.click(restoreCheckbox())
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
    expect(saveButton()).toBeEnabled()
    await userEvent.click(saveButton())
    expect(onSubmit).toHaveBeenCalledWith({
      displayText: originalText,
      blocks: [{ type: "text", text: originalText }, image],
    })
  })

  it.each(["rejected", "missing-token"])(
    "blocks an unavailable preview (%s) and allows conversation-only submission",
    async (failure) => {
      const onPreviewFiles =
        failure === "rejected"
          ? vi.fn().mockRejectedValue(new Error("No captured checkpoint"))
          : vi.fn().mockResolvedValue({ ...preview, token: " " })
      const { onSubmit } = mount({ onPreviewFiles })
      await editor()
      await userEvent.click(restoreCheckbox())
      expect(await screen.findByRole("alert")).toHaveTextContent(
        failure === "rejected"
          ? "No captured checkpoint"
          : "File restoration is unavailable"
      )
      expect(saveButton()).toBeDisabled()
      fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" })
      expect(onSubmit).not.toHaveBeenCalled()
      await userEvent.click(restoreCheckbox())
      expect(saveButton()).toBeEnabled()
      await userEvent.click(saveButton())
      expect(onSubmit).toHaveBeenCalledWith({
        displayText: originalText,
        blocks: [{ type: "text", text: originalText }, image],
      })
    }
  )

  it.each(["resolve", "reject"] as const)(
    "ignores a late preview %s after unchecking",
    async (settlement) => {
      const request = deferred<RestorePreview>()
      const { onSubmit } = mount({ onPreviewFiles: () => request.promise })
      await editor()
      await userEvent.click(restoreCheckbox())
      await userEvent.click(restoreCheckbox())
      expect(saveButton()).toBeEnabled()
      await act(async () => {
        if (settlement === "resolve") request.resolve(preview)
        else request.reject(new Error("stale failure"))
      })
      expect(restoreCheckbox()).not.toBeChecked()
      expect(screen.queryByRole("alert")).not.toBeInTheDocument()
      expect(screen.queryByRole("list")).not.toBeInTheDocument()
      await userEvent.click(saveButton())
      expect(onSubmit).toHaveBeenCalledWith({
        displayText: originalText,
        blocks: [{ type: "text", text: originalText }, image],
      })
    }
  )

  it("does not let an earlier request replace a newly selected preview", async () => {
    const first = deferred<RestorePreview>()
    const second = deferred<RestorePreview>()
    const onPreviewFiles = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
    const { onSubmit } = mount({ onPreviewFiles })
    await editor()
    await userEvent.click(restoreCheckbox())
    await userEvent.click(restoreCheckbox())
    await userEvent.click(restoreCheckbox())
    await act(async () => second.resolve({ ...preview, token: "new-token" }))
    await act(async () =>
      first.resolve({ ...preview, conflicts: ["stale conflict"] })
    )
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
    await userEvent.click(saveButton())
    expect(onSubmit).toHaveBeenCalledWith(expect.any(Object), "new-token")
  })

  it("discards a pending preview and original draft when the target changes", async () => {
    const request = deferred<RestorePreview>()
    const onPreviewFiles = vi
      .fn()
      .mockReturnValueOnce(request.promise)
      .mockResolvedValueOnce({ ...preview, token: "next-target" })
    const { onSubmit, rerenderDialog } = mount({ onPreviewFiles })
    await editor()
    await userEvent.click(restoreCheckbox())
    rerenderDialog({
      turn: { ...turn([{ type: "text", text: "hello" }]), id: "turn-2" },
    })
    const nextEditor = await editor()
    expect(serializeDocToText(nextEditor.state.doc)).toBe("hello")
    expect(restoreCheckbox()).not.toBeChecked()
    await act(async () => request.resolve(preview))
    expect(screen.queryByRole("list")).not.toBeInTheDocument()
    await userEvent.click(restoreCheckbox())
    await waitFor(() => expect(saveButton()).toBeEnabled())
    await userEvent.click(saveButton())
    expect(onSubmit).toHaveBeenCalledWith(
      { displayText: "hello", blocks: [{ type: "text", text: "hello" }] },
      "next-target"
    )
  })

  it("retains a preview across same-target refetches and callback identity changes", async () => {
    const request = deferred<RestorePreview>()
    const onPreviewFiles = vi.fn(() => request.promise)
    const { onSubmit, rerenderDialog } = mount({ onPreviewFiles })
    await editor()
    await userEvent.click(restoreCheckbox())
    const nextPreview = vi
      .fn()
      .mockResolvedValue({ ...preview, token: "unused" })
    rerenderDialog({ turn: turn(), onPreviewFiles: nextPreview })
    await act(async () => request.resolve(preview))
    await userEvent.click(saveButton())
    expect(onSubmit).toHaveBeenCalledWith(expect.any(Object), preview.token)
    expect(nextPreview).not.toHaveBeenCalled()
  })

  it("keeps draft and images after restoration fails and allows a normal resend", async () => {
    const onSubmit = vi
      .fn()
      .mockRejectedValueOnce(new Error("Files changed since preview"))
      .mockResolvedValueOnce(undefined)
    const { onCancel } = mount({
      onSubmit,
      onPreviewFiles: async () => preview,
    })
    const instance = await editor()
    act(() => instance.commands.insertContent(" revised"))
    const draftText = serializeDocToText(instance.state.doc)
    await userEvent.click(restoreCheckbox())
    await userEvent.click(saveButton())
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Files changed since preview"
    )
    expect(serializeDocToText(instance.state.doc)).toBe(draftText)
    expect(screen.getByRole("img", { name: "Attached image 1" })).toBeVisible()
    expect(onCancel).not.toHaveBeenCalled()
    await userEvent.click(restoreCheckbox())
    await userEvent.click(saveButton())
    expect(onSubmit.mock.calls[1]).toEqual([onSubmit.mock.calls[0][0]])
    expect(onCancel).toHaveBeenCalledOnce()
  })

  it("locks restoration after a successful fork and retries the preserved draft without a token", async () => {
    const request = deferred<void>()
    const onSubmit = vi
      .fn()
      .mockReturnValueOnce(request.promise)
      .mockResolvedValueOnce(undefined)
    const onPreviewFiles = vi.fn().mockResolvedValue(preview)
    const { onCancel, rerenderDialog } = mount({ onSubmit, onPreviewFiles })
    const instance = await editor()
    act(() => instance.commands.insertContent(" revised"))
    const draftText = serializeDocToText(instance.state.doc)
    await userEvent.click(restoreCheckbox())
    await userEvent.click(saveButton())
    expect(restoreCheckbox()).toBeDisabled()
    rerenderDialog({ filesRestored: true })
    await act(async () => request.reject(new Error("Send failed")))
    expect(await screen.findByRole("alert")).toHaveTextContent("Send failed")
    expect(screen.getByRole("status")).toHaveTextContent(
      "Files have already been restored"
    )
    expect(restoreCheckbox()).toBeChecked()
    expect(restoreCheckbox()).toBeDisabled()
    expect(screen.queryByRole("list")).not.toBeInTheDocument()
    expect(serializeDocToText(instance.state.doc)).toBe(draftText)
    expect(screen.getByRole("img", { name: "Attached image 1" })).toBeVisible()
    expect(onCancel).not.toHaveBeenCalled()
    await userEvent.click(saveButton())
    expect(onSubmit.mock.calls[0][1]).toBe(preview.token)
    expect(onSubmit.mock.calls[1]).toEqual([onSubmit.mock.calls[0][0]])
    expect(onPreviewFiles).toHaveBeenCalledOnce()
    expect(onCancel).toHaveBeenCalledOnce()
  })

  it("hides the checkbox when the preview callback disappears and offers conversation-only recovery", async () => {
    const request = deferred<RestorePreview>()
    const { onSubmit, rerenderDialog } = mount({
      onPreviewFiles: () => request.promise,
    })
    await editor()
    await userEvent.click(restoreCheckbox())
    rerenderDialog({ onPreviewFiles: undefined })
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument()
    expect(screen.getByRole("alert")).toHaveTextContent(
      "File restoration is unavailable"
    )
    expect(saveButton()).toBeDisabled()
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" })
    expect(onSubmit).not.toHaveBeenCalled()
    await userEvent.click(
      screen.getByRole("button", { name: "Edit conversation only" })
    )
    await act(async () => request.resolve(preview))
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
    expect(saveButton()).toBeEnabled()
    await userEvent.click(saveButton())
    expect(onSubmit).toHaveBeenCalledWith({
      displayText: originalText,
      blocks: [{ type: "text", text: originalText }, image],
    })
  })

  it("shows the already restored notice without a preview callback and allows retry", async () => {
    const { onSubmit } = mount({ filesRestored: true })
    await editor()
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument()
    expect(screen.getByRole("status")).toHaveTextContent(
      "Files have already been restored"
    )
    await userEvent.click(saveButton())
    expect(onSubmit).toHaveBeenCalledWith({
      displayText: originalText,
      blocks: [{ type: "text", text: originalText }, image],
    })
  })

  it("allows an empty, valid preview and preserves an image-only draft", async () => {
    const { onSubmit } = mount({
      turn: turn([image]),
      onPreviewFiles: async () => ({ ...preview, files: [] }),
    })
    await waitFor(() => expect(saveButton()).toBeEnabled())
    await userEvent.click(restoreCheckbox())
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Files to restore: 0"
    )
    await userEvent.click(saveButton())
    expect(onSubmit).toHaveBeenCalledWith(
      { displayText: "", blocks: [image] },
      preview.token
    )
  })

  it.each(["resolve", "reject"] as const)(
    "ignores a preview %s after unmount",
    async (settlement) => {
      const request = deferred<RestorePreview>()
      const { unmount, onSubmit, onCancel } = mount({
        onPreviewFiles: () => request.promise,
      })
      await editor()
      await userEvent.click(restoreCheckbox())
      unmount()
      await act(async () => {
        if (settlement === "resolve") request.resolve(preview)
        else request.reject(new Error("late failure"))
      })
      expect(onSubmit).not.toHaveBeenCalled()
      expect(onCancel).not.toHaveBeenCalled()
    }
  )

  it("does not turn an image-only display placeholder into sent prose", async () => {
    const source = {
      ...turn([
        { type: "text" as const, text: "Attached 1 attachment" },
        image,
      ]),
      prompt_text: "",
    }
    const { onSubmit } = mount({ turn: source })
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Save and resend" })
      ).toBeEnabled()
    )
    expect(screen.getByRole("textbox")).not.toHaveTextContent(
      "Attached 1 attachment"
    )
    await userEvent.click(
      screen.getByRole("button", { name: "Save and resend" })
    )
    expect(onSubmit).toHaveBeenCalledWith({ displayText: "", blocks: [image] })
  })
  it("opens exact plain text and file links without mutating the turn; cancel never submits", async () => {
    const source = turn()
    const snapshot = structuredClone(source)
    const { onSubmit, onCancel } = mount({ turn: source })
    const instance = await editor()
    expect(serializeDocToText(instance.state.doc)).toBe(originalText)
    expect(
      screen.getByRole("img", { name: "Attached image 1" })
    ).toHaveAttribute("src", "data:image/png;base64,aW1hZ2U=")
    expect(onSubmit).not.toHaveBeenCalled()
    act(() => instance.commands.insertContent(" changed"))
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }))
    expect(onCancel).toHaveBeenCalledOnce()
    expect(onSubmit).not.toHaveBeenCalled()
    expect(source).toEqual(snapshot)
  })

  it("preserves whitespace, file links and every image on resend; closes only after success", async () => {
    let resolve!: () => void
    const onSubmit = vi.fn(
      () =>
        new Promise<void>((done) => {
          resolve = done
        })
    )
    const secondImage: ContentBlock = {
      type: "image",
      data: "c2Vjb25k",
      mime_type: "image/jpeg",
      uri: null,
    }
    const { onCancel } = mount({
      onSubmit,
      turn: turn([
        { type: "text", text: originalText },
        image,
        secondImage,
        image,
      ]),
    })
    await editor()
    await userEvent.click(
      screen.getByRole("button", { name: "Save and resend" })
    )
    expect(onSubmit).toHaveBeenCalledWith({
      displayText: originalText,
      blocks: [{ type: "text", text: originalText }, image, secondImage, image],
    })
    expect(onCancel).not.toHaveBeenCalled()
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled()
    await userEvent.keyboard("{Escape}")
    expect(onCancel).not.toHaveBeenCalled()
    await act(async () => resolve())
    expect(onCancel).toHaveBeenCalledOnce()
  })

  it("keeps the edited draft and images after a failure and permits retry", async () => {
    const onSubmit = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(undefined)
    const { onCancel } = mount({ onSubmit })
    const instance = await editor()
    act(() => instance.commands.insertContent(" revised"))
    const draftText = serializeDocToText(instance.state.doc)
    await userEvent.click(
      screen.getByRole("button", { name: "Save and resend" })
    )
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not edit message: offline"
    )
    expect(serializeDocToText(instance.state.doc)).toBe(draftText)
    expect(screen.getByRole("img", { name: "Attached image 1" })).toBeVisible()
    expect(onCancel).not.toHaveBeenCalled()
    await userEvent.click(
      screen.getByRole("button", { name: "Save and resend" })
    )
    expect(onSubmit.mock.calls[1][0]).toEqual(onSubmit.mock.calls[0][0])
    expect(onCancel).toHaveBeenCalledOnce()
  })

  it("guards same-tick keyboard submissions before disabled state can render", async () => {
    const onSubmit = vi.fn(() => new Promise<void>(() => {}))
    mount({ onSubmit })
    await editor()
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Save and resend" })
      ).toBeEnabled()
    )
    const textbox = screen.getByRole("textbox")
    act(() => {
      textbox.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true })
      )
      textbox.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true })
      )
    })
    expect(onSubmit).toHaveBeenCalledOnce()
    expect(textbox).toHaveAttribute("contenteditable", "false")
  })

  it("rejects empty text from both button and keyboard submission", async () => {
    const { onSubmit } = mount({
      turn: turn([{ type: "text", text: "hello" }]),
    })
    const instance = await editor()
    act(() =>
      instance.commands.setContent({
        type: "doc",
        content: [
          { type: "paragraph", content: [{ type: "text", text: "   " }] },
        ],
      })
    )
    expect(
      screen.getByRole("button", { name: "Save and resend" })
    ).toBeDisabled()
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" })
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it("allows image-only messages", async () => {
    const { onSubmit } = mount({ turn: turn([image]) })
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Save and resend" })
      ).toBeEnabled()
    )
    await userEvent.click(
      screen.getByRole("button", { name: "Save and resend" })
    )
    expect(onSubmit).toHaveBeenCalledWith({ displayText: "", blocks: [image] })
  })

  it("retains the draft when busy or the parent's turn object changes", async () => {
    const { rerender, onSubmit, onCancel } = mount()
    const instance = await editor()
    act(() => instance.commands.insertContent(" edited"))
    const draftText = serializeDocToText(instance.state.doc)
    const renderAgain = (busy: boolean) => (
      <NextIntlClientProvider locale="en" messages={messages}>
        <EditUserMessageDialog
          turn={turn([{ type: "text", text: "refetched" }])}
          busy={busy}
          onSubmit={onSubmit}
          onCancel={onCancel}
        />
      </NextIntlClientProvider>
    )
    rerender(renderAgain(true))
    expect(
      screen.getByRole("button", { name: "Save and resend" })
    ).toBeDisabled()
    expect(serializeDocToText(instance.state.doc)).toBe(draftText)
    rerender(renderAgain(false))
    await userEvent.click(
      screen.getByRole("button", { name: "Save and resend" })
    )
    expect(onSubmit).toHaveBeenCalledWith({
      displayText: draftText,
      blocks: [{ type: "text", text: draftText }, image],
    })
  })

  it("busy prevents button and keyboard submission, while Escape cancels safely", async () => {
    const { onSubmit, onCancel } = mount({ busy: true })
    await editor()
    expect(
      screen.getByRole("button", { name: "Save and resend" })
    ).toBeDisabled()
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" })
    expect(onSubmit).not.toHaveBeenCalled()
    await userEvent.keyboard("{Escape}")
    expect(onCancel).toHaveBeenCalledOnce()
  })

  it.each([
    {
      source: turn([
        { type: "text", text: "unsupported" },
        { type: "thinking", text: "hidden" },
      ]),
      message: "unsupported content",
    },
    {
      source: { ...turn(), role: "assistant" as const },
      message: "unsupported content",
    },
    {
      source: turn([
        {
          type: "image",
          data: "",
          mime_type: "image/png",
          uri: "file:///missing.png",
        },
      ]),
      message: "original image data is unavailable",
    },
  ])(
    "blocks unsafe content without silently dropping it: $message",
    async ({ source, message }) => {
      const { onSubmit } = mount({ turn: source })
      expect(screen.getByRole("alert")).toHaveTextContent(message)
      expect(
        screen.getByRole("button", { name: "Save and resend" })
      ).toBeDisabled()
      fireEvent.keyDown(await screen.findByRole("textbox"), { key: "Enter" })
      expect(onSubmit).not.toHaveBeenCalled()
    }
  )
})
