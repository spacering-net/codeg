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

async function editor() {
  const textbox = await screen.findByRole("textbox", { name: "Edit message" })
  await waitFor(() =>
    expect(textbox).toHaveTextContent(/literal|hello|unsupported/)
  )
  return (textbox as HTMLElement & { editor: Editor }).editor
}

describe("EditUserMessageDialog", () => {
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
    expect(screen.getByText(/Recent checkpoints only/)).toBeVisible()
    expect(
      screen.getByText(/Manual edits captured within the same turn/)
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
