import { fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  copyTextToClipboard: vi.fn(() => Promise.resolve(true)),
}))

vi.mock("@/lib/utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/utils")>()
  return { ...actual, copyTextToClipboard: mocks.copyTextToClipboard }
})

import enMessages from "@/i18n/messages/en.json"

import {
  TerminalLinkMenu,
  terminalLinkClickOpensMenu,
} from "./terminal-link-menu"

function renderMenu(props: {
  onChoose?: (url: string, target: "builtin" | "system") => void
  onClose?: () => void
}) {
  const onChoose = props.onChoose ?? vi.fn()
  const onClose = props.onClose ?? vi.fn()
  render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <TerminalLinkMenu
        click={{ url: "https://example.com/a", x: 40, y: 60 }}
        onChoose={onChoose}
        onClose={onClose}
      />
    </NextIntlClientProvider>
  )
  return { onChoose, onClose }
}

beforeEach(() => {
  mocks.copyTextToClipboard.mockClear()
})

describe("terminalLinkClickOpensMenu", () => {
  it("opens only for a plain click on a web address with the menu turned on", () => {
    const on = { terminalClickMenu: true }
    const off = { terminalClickMenu: false }
    expect(terminalLinkClickOpensMenu(on, false, "https://example.com")).toBe(
      true
    )
    expect(terminalLinkClickOpensMenu(on, false, "http://localhost:3000")).toBe(
      true
    )
    // The preference is off: the link follows the per-source default.
    expect(terminalLinkClickOpensMenu(off, false, "https://example.com")).toBe(
      false
    )
    // A modifier-click already chose the other destination.
    expect(terminalLinkClickOpensMenu(on, true, "https://example.com")).toBe(
      false
    )
    // Not a web address: there is nothing to choose from.
    expect(terminalLinkClickOpensMenu(on, false, "mailto:a@example.com")).toBe(
      false
    )
    expect(terminalLinkClickOpensMenu(on, false, "/tmp/report.txt")).toBe(false)
  })
})

describe("TerminalLinkMenu", () => {
  it("renders nothing without a pending click", () => {
    const { container } = render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <TerminalLinkMenu click={null} onChoose={vi.fn()} onClose={vi.fn()} />
      </NextIntlClientProvider>
    )
    expect(container).toBeEmptyDOMElement()
  })

  it("offers the three actions at the click point and reports the choice", () => {
    const { onChoose } = renderMenu({})
    const anchor = document.querySelector<HTMLElement>(
      "[data-terminal-link-anchor]"
    )
    expect(anchor?.style.left).toBe("40px")
    expect(anchor?.style.top).toBe("60px")

    fireEvent.click(
      screen.getByRole("menuitem", { name: "Open in built-in browser" })
    )
    expect(onChoose).toHaveBeenCalledWith("https://example.com/a", "builtin")
  })

  it("closes after a choice, so the caller can hand focus back", () => {
    const { onChoose, onClose } = renderMenu({})
    fireEvent.click(
      screen.getByRole("menuitem", { name: "Open in system browser" })
    )
    expect(onChoose).toHaveBeenCalledWith("https://example.com/a", "system")
    expect(onClose).toHaveBeenCalled()
  })

  it("chooses the system browser explicitly", () => {
    const { onChoose } = renderMenu({})
    fireEvent.click(
      screen.getByRole("menuitem", { name: "Open in system browser" })
    )
    expect(onChoose).toHaveBeenCalledWith("https://example.com/a", "system")
  })

  it("copies the link without opening it", () => {
    const { onChoose } = renderMenu({})
    fireEvent.click(screen.getByRole("menuitem", { name: "Copy link" }))
    expect(mocks.copyTextToClipboard).toHaveBeenCalledWith(
      "https://example.com/a"
    )
    expect(onChoose).not.toHaveBeenCalled()
  })

  it("reports Escape as a close", () => {
    const { onClose, onChoose } = renderMenu({})
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" })
    expect(onClose).toHaveBeenCalled()
    expect(onChoose).not.toHaveBeenCalled()
  })
})
