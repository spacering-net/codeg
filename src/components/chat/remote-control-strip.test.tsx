import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  openInSystemBrowser: vi.fn(() => Promise.resolve()),
  copyTextToClipboard: vi.fn(() => Promise.resolve(true)),
}))

vi.mock("@/lib/link-open", () => ({
  openInSystemBrowser: mocks.openInSystemBrowser,
}))

vi.mock("@/lib/utils", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/utils")>()),
  copyTextToClipboard: mocks.copyTextToClipboard,
}))

import { RemoteControlStrip } from "./remote-control-strip"
import enMessages from "@/i18n/messages/en.json"

const t = enMessages.Folder.chat.remoteControl
const SESSION_URL = "https://claude.ai/code/session_01"

function renderStrip(ui: React.ReactNode) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      {ui}
    </NextIntlClientProvider>
  )
}

beforeEach(() => {
  mocks.openInSystemBrowser.mockClear()
  mocks.copyTextToClipboard.mockClear()
})

describe("RemoteControlStrip", () => {
  it("shows the session link, opens it in the system browser and copies it", async () => {
    const user = userEvent.setup()
    renderStrip(
      <RemoteControlStrip
        remoteControl={{ session_url: SESSION_URL }}
        canTurnOff
      />
    )
    expect(screen.getByText(t.title)).toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: SESSION_URL }))
    expect(mocks.openInSystemBrowser).toHaveBeenCalledWith(SESSION_URL)

    await user.click(screen.getByRole("button", { name: t.copy }))
    expect(mocks.copyTextToClipboard).toHaveBeenCalledWith(SESSION_URL)
    expect(
      await screen.findByRole("button", { name: t.copied })
    ).toBeInTheDocument()
  })

  it("draws the link as a QR code for the phone", async () => {
    const user = userEvent.setup()
    renderStrip(
      <RemoteControlStrip
        remoteControl={{ session_url: SESSION_URL }}
        canTurnOff
      />
    )
    expect(screen.queryByText(t.qrHint)).not.toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: t.qr }))
    expect(await screen.findByText(t.qrHint)).toBeInTheDocument()
    expect(screen.getByTitle(t.qrLabel)).toBeInTheDocument()
  })

  it("says so when Claude Code returned no link, and offers nothing to open", () => {
    renderStrip(
      <RemoteControlStrip remoteControl={{ session_url: null }} canTurnOff />
    )
    expect(screen.getByText(t.noUrl)).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: t.qr })).not.toBeInTheDocument()
    expect(
      screen.queryByRole("button", { name: t.copy })
    ).not.toBeInTheDocument()
  })

  it("turns it off only between turns, and only where there is a connection to ask", async () => {
    const user = userEvent.setup()
    const onTurnOff = vi.fn()
    const { rerender } = renderStrip(
      <RemoteControlStrip
        remoteControl={{ session_url: SESSION_URL }}
        onTurnOff={onTurnOff}
        canTurnOff={false}
      />
    )
    // The adapter refuses the command while Claude is working.
    const button = screen.getByRole("button", { name: t.turnOff })
    expect(button).toBeDisabled()
    expect(button.parentElement).toHaveAttribute("title", t.turnOffBusy)

    rerender(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <RemoteControlStrip
          remoteControl={{ session_url: SESSION_URL }}
          onTurnOff={onTurnOff}
          canTurnOff
        />
      </NextIntlClientProvider>
    )
    await user.click(screen.getByRole("button", { name: t.turnOff }))
    expect(onTurnOff).toHaveBeenCalledTimes(1)

    // A viewer has no connection of its own to send the command on.
    rerender(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <RemoteControlStrip
          remoteControl={{ session_url: SESSION_URL }}
          canTurnOff
        />
      </NextIntlClientProvider>
    )
    expect(
      screen.queryByRole("button", { name: t.turnOff })
    ).not.toBeInTheDocument()
  })
})
