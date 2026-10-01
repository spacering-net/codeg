import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import { ComposerSpeechButton } from "./composer-speech-button"

const m = enMessages.Folder.chat.messageInput

function renderButton(
  props: Partial<React.ComponentProps<typeof ComposerSpeechButton>> = {}
) {
  const onToggle = vi.fn()
  render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <ComposerSpeechButton
        status="idle"
        interimText=""
        unavailableReason={null}
        onToggle={onToggle}
        {...props}
      />
    </NextIntlClientProvider>
  )
  return { onToggle }
}

afterEach(() => cleanup())

describe("ComposerSpeechButton", () => {
  it("idle: labelled start and toggles on click", async () => {
    const { onToggle } = renderButton()
    const button = screen.getByRole("button", { name: m.speechStart })
    expect(button).toBeEnabled()
    await userEvent.click(button)
    expect(onToggle).toHaveBeenCalledTimes(1)
  })

  it("listening: labelled stop, pressed, shows interim text and the Esc hint", async () => {
    const { onToggle } = renderButton({
      status: "listening",
      interimText: "hello wor",
    })
    const button = screen.getByRole("button", { name: m.speechStop })
    expect(button).toHaveAttribute("aria-pressed", "true")
    expect(screen.getByRole("status")).toHaveTextContent("hello wor")
    expect(screen.getByRole("status")).toHaveTextContent(m.speechCancelHint)
    await userEvent.click(button)
    expect(onToggle).toHaveBeenCalledTimes(1)
  })

  it("transcribing: labelled and disabled", () => {
    renderButton({ status: "transcribing" })
    expect(
      screen.getByRole("button", { name: m.speechTranscribing })
    ).toBeDisabled()
    expect(screen.queryByRole("status")).not.toBeInTheDocument()
  })

  it.each([
    ["no-engine", m.speechUnavailableNoEngine],
    ["insecure-context", m.speechUnavailableInsecure],
    ["no-mic", m.speechUnavailableNoMic],
    ["cloud-not-configured", m.speechUnavailableCloud],
  ] as const)("unavailable (%s): disabled with the reason", (reason, label) => {
    renderButton({ status: "unavailable", unavailableReason: reason })
    expect(screen.getByRole("button", { name: label })).toBeDisabled()
  })
})
