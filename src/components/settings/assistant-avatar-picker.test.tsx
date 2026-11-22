import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { AssistantAvatar } from "@/lib/types"

const avatarLib = vi.hoisted(() => ({
  loadAvatarImage: vi.fn(),
  cropToAvatarDataUrl: vi.fn(),
}))
vi.mock("@/lib/assistant-avatar", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/assistant-avatar")>()),
  ...avatarLib,
}))
vi.mock("@/lib/platform", () => ({ isDesktop: () => false }))

import enMessages from "@/i18n/messages/en.json"
import { AvatarImageError } from "@/lib/assistant-avatar"
import { AssistantAvatarPicker } from "./assistant-avatar-picker"

const face = enMessages.PersonalAgent.bots.face

function picture(name = "cat.png") {
  return new File([new Uint8Array([1, 2, 3])], name, { type: "image/png" })
}

function fileInput() {
  return document.querySelector<HTMLInputElement>("[data-pa-face-file]")!
}

function renderPicker(avatar: AssistantAvatar, onChange = vi.fn()) {
  render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <AssistantAvatarPicker
        avatar={avatar}
        name="Reviewer"
        onChange={onChange}
      />
    </NextIntlClientProvider>
  )
  return onChange
}

type User = ReturnType<typeof userEvent.setup>

async function open(user: User) {
  await user.click(screen.getByRole("button", { name: "Change avatar" }))
  return screen.findByRole("dialog")
}

describe("AssistantAvatarPicker", () => {
  beforeEach(() => {
    avatarLib.loadAvatarImage.mockReset()
    avatarLib.cropToAvatarDataUrl.mockReset()
    avatarLib.loadAvatarImage.mockResolvedValue({
      naturalWidth: 400,
      naturalHeight: 200,
    })
    avatarLib.cropToAvatarDataUrl.mockReturnValue("data:image/png;base64,AAAA")
    vi.stubGlobal("URL", {
      ...URL,
      createObjectURL: vi.fn(() => "blob:cat"),
      revokeObjectURL: vi.fn(),
    })
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("opens on the page of the avatar's kind", async () => {
    const user = userEvent.setup()
    renderPicker({ kind: "emoji", emoji: "🦊", color: "amber" })
    await open(user)
    expect(screen.getByRole("tab", { name: "Emoji" })).toHaveAttribute(
      "data-state",
      "active"
    )
    expect(screen.getByRole("button", { name: "🦊" })).toBeInTheDocument()
  })

  it("picks an emoji, keeping the colour", async () => {
    const user = userEvent.setup()
    const onChange = renderPicker({ kind: "monogram", color: "violet" })
    await open(user)
    await user.click(screen.getByRole("tab", { name: "Emoji" }))
    await user.click(screen.getByRole("button", { name: "🦉" }))
    expect(onChange).toHaveBeenLastCalledWith({
      kind: "emoji",
      emoji: "🦉",
      color: "violet",
    })
  })

  it("takes only the first character of a typed emoji", async () => {
    const user = userEvent.setup()
    const onChange = renderPicker({ kind: "monogram", color: "teal" })
    await open(user)
    await user.click(screen.getByRole("tab", { name: "Emoji" }))
    const input = screen.getByRole("textbox", {
      name: "Type or paste an emoji",
    })
    const use = screen.getByRole("button", { name: "Use" })
    expect(use).toBeDisabled()
    await user.type(input, "   ")
    expect(use).toBeDisabled()
    await user.clear(input)
    await user.type(input, "👩‍👩‍👧🦊 extra")
    await user.click(use)
    expect(onChange).toHaveBeenLastCalledWith({
      kind: "emoji",
      emoji: "👩‍👩‍👧",
      color: "teal",
    })
    expect(input).toHaveValue("")
  })

  it("refuses a typed character the backend would not take", async () => {
    const user = userEvent.setup()
    renderPicker({ kind: "monogram", color: "teal" })
    await open(user)
    await user.click(screen.getByRole("tab", { name: "Emoji" }))
    const input = screen.getByRole("textbox", {
      name: "Type or paste an emoji",
    })
    const use = screen.getByRole("button", { name: "Use" })
    fireEvent.change(input, { target: { value: "\u001b" } })
    expect(use).toBeDisabled()
    fireEvent.change(input, {
      target: { value: Array(10).fill("👩").join("\u200d") },
    })
    expect(use).toBeDisabled()
    fireEvent.change(input, { target: { value: "🦊" } })
    expect(use).toBeEnabled()
  })

  it("recolours the disc, and goes back to the letter", async () => {
    const user = userEvent.setup()
    const onChange = renderPicker({
      kind: "emoji",
      emoji: "🦊",
      color: "amber",
    })
    await open(user)
    await user.click(screen.getByRole("button", { name: "pink" }))
    expect(onChange).toHaveBeenLastCalledWith({
      kind: "emoji",
      emoji: "🦊",
      color: "pink",
    })
    expect(screen.getByRole("button", { name: "amber" })).toHaveAttribute(
      "aria-pressed",
      "true"
    )

    await user.click(screen.getByRole("tab", { name: "Letter" }))
    await user.click(screen.getByRole("button", { name: "Use the letter" }))
    expect(onChange).toHaveBeenLastCalledWith({
      kind: "monogram",
      color: "amber",
    })
  })

  it("frames an uploaded picture as the work assistants' editor does, and sets what the window shows", async () => {
    const user = userEvent.setup()
    const onChange = renderPicker({ kind: "monogram", color: "teal" })
    await open(user)
    await user.click(screen.getByRole("tab", { name: "Image" }))
    // The palette is for the letter and the emoji only.
    expect(screen.queryByRole("button", { name: "teal" })).toBeNull()
    expect(screen.getByText(face.dropHint)).toBeInTheDocument()
    fireEvent.change(fileInput(), { target: { files: [picture()] } })
    await screen.findByText(face.dragHint)
    expect(
      document.querySelector("[data-pa-face-file-info]")?.textContent
    ).toBe("cat.png · 400×200")
    // [Start over] goes back to the drop zone.
    await user.click(screen.getByRole("button", { name: face.restart }))
    expect(screen.getByText(face.dropHint)).toBeInTheDocument()
    fireEvent.change(fileInput(), { target: { files: [picture()] } })
    await screen.findByText(face.dragHint)
    await user.click(screen.getByRole("button", { name: face.zoomIn }))
    expect(onChange).not.toHaveBeenCalled()
    await user.click(screen.getByRole("button", { name: face.setAvatar }))
    expect(onChange).toHaveBeenLastCalledWith({
      kind: "image",
      data_url: "data:image/png;base64,AAAA",
    })
    // Zoomed once (1.25): a 160 px square of the 400×200 picture.
    const crop = avatarLib.cropToAvatarDataUrl.mock.calls[0][1]
    expect(crop.side).toBeCloseTo(200 / 1.25)
    // Set: the popover closes, and opens again on a fresh drop zone.
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
  })

  it("takes a picture pasted anywhere in the popover, to the image page", async () => {
    const user = userEvent.setup()
    renderPicker({ kind: "emoji", emoji: "🦊", color: "amber" })
    await open(user)
    fireEvent.paste(document.querySelector("[data-assistant-avatar-pages]")!, {
      clipboardData: { files: [picture("shot.png")] },
    })
    await screen.findByText(face.dragHint)
    expect(screen.getByRole("tab", { name: "Image" })).toHaveAttribute(
      "data-state",
      "active"
    )
    expect(
      document.querySelector("[data-pa-face-file-info]")?.textContent
    ).toBe("shot.png · 400×200")
  })

  it("says why a picture could not be used", async () => {
    const user = userEvent.setup()
    const onChange = renderPicker({ kind: "monogram", color: "teal" })
    await open(user)
    await user.click(screen.getByRole("tab", { name: "Image" }))

    avatarLib.loadAvatarImage.mockRejectedValueOnce(new Error("bad"))
    fireEvent.change(fileInput(), { target: { files: [picture()] } })
    expect((await screen.findByRole("alert")).textContent).toBe(face.unreadable)

    fireEvent.change(fileInput(), { target: { files: [picture()] } })
    await screen.findByText(face.dragHint)
    avatarLib.cropToAvatarDataUrl.mockImplementationOnce(() => {
      throw new AvatarImageError("too_large")
    })
    await user.click(screen.getByRole("button", { name: face.setAvatar }))
    expect(screen.getByRole("alert").textContent).toBe(face.tooLarge)
    expect(onChange).not.toHaveBeenCalled()
  })
})
