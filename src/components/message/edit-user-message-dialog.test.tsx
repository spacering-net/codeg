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
  const result = render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <EditUserMessageDialog {...props} />
    </NextIntlClientProvider>
  )
  return { ...result, ...props }
}

async function editor() {
  const textbox = await screen.findByRole("textbox", { name: "Edit message" })
  await waitFor(() =>
    expect(textbox).toHaveTextContent(/literal|hello|unsupported/)
  )
  return (textbox as HTMLElement & { editor: Editor }).editor
}

describe("EditUserMessageDialog", () => {
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
