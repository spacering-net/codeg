import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"

import type { AssistantAvatar } from "@/lib/types"

const encode = vi.hoisted(() => ({ toDataUrl: vi.fn() }))
vi.mock("@/lib/assistant-avatar", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/assistant-avatar")>()),
  imageFileToAvatarDataUrl: encode.toDataUrl,
}))

import enMessages from "@/i18n/messages/en.json"
import { AvatarImageError } from "@/lib/assistant-avatar"
import { AssistantAvatarPicker } from "./assistant-avatar-picker"

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
    encode.toDataUrl.mockReset()
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

  it("drops an upload that a newer pick replaced", async () => {
    let finish: (url: string) => void = () => {}
    encode.toDataUrl.mockReturnValue(
      new Promise<string>((resolve) => {
        finish = resolve
      })
    )
    const user = userEvent.setup()
    const onChange = renderPicker({ kind: "monogram", color: "teal" })
    await open(user)
    await user.click(screen.getByRole("tab", { name: "Image" }))
    await user.upload(
      screen.getByTestId("assistant-avatar-file"),
      new File(["x"], "slow.png", { type: "image/png" })
    )
    // While it is being scaled, the user picks an emoji instead.
    await user.click(screen.getByRole("tab", { name: "Emoji" }))
    await user.click(screen.getByRole("button", { name: "🦉" }))
    await act(async () => finish("data:image/webp;base64,AAAA"))
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenLastCalledWith({
      kind: "emoji",
      emoji: "🦉",
      color: "teal",
    })
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

  it("uploads a picture as a data URL", async () => {
    encode.toDataUrl.mockResolvedValue("data:image/webp;base64,AAAA")
    const user = userEvent.setup()
    const onChange = renderPicker({ kind: "monogram", color: "teal" })
    await open(user)
    await user.click(screen.getByRole("tab", { name: "Image" }))
    // The palette is for the letter and the emoji only.
    expect(screen.queryByRole("button", { name: "teal" })).toBeNull()
    const file = new File(["x"], "me.png", { type: "image/png" })
    await user.upload(screen.getByTestId("assistant-avatar-file"), file)
    await waitFor(() =>
      expect(onChange).toHaveBeenLastCalledWith({
        kind: "image",
        data_url: "data:image/webp;base64,AAAA",
      })
    )
    expect(encode.toDataUrl).toHaveBeenCalledWith(file)
  })

  it("says why a picture could not be used", async () => {
    const user = userEvent.setup()
    const onChange = renderPicker({ kind: "monogram", color: "teal" })
    await open(user)
    await user.click(screen.getByRole("tab", { name: "Image" }))
    const input = screen.getByTestId("assistant-avatar-file")

    encode.toDataUrl.mockRejectedValue(new AvatarImageError("too_large"))
    await user.upload(input, new File(["x"], "huge.png", { type: "image/png" }))
    expect(
      await screen.findByText(/too large even after scaling down/)
    ).toBeInTheDocument()

    encode.toDataUrl.mockRejectedValue(new AvatarImageError("unreadable"))
    await user.upload(input, new File(["x"], "bad.png", { type: "image/png" }))
    expect(
      await screen.findByText("This file couldn't be read as an image.")
    ).toBeInTheDocument()
    expect(onChange).not.toHaveBeenCalled()
  })
})
