import { act, fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({ browserFind: vi.fn() }))
vi.mock("@/lib/browser/browser-api", () => ({ browserFind: mocks.browserFind }))

import type { BrowserWorkspaceTab } from "@/contexts/workspace-context"
import enMessages from "@/i18n/messages/en.json"
import { BrowserFindBar } from "./browser-find-bar"

const tab = {
  id: "browser:abc",
  kind: "browser",
  folderId: null,
  title: "example.com",
  description: null,
  path: null,
  language: "browser",
  content: "",
  loading: false,
  readonly: true,
  browser: {
    initialUrl: "https://example.com/",
    openerTabId: null,
    profile: "default",
  },
} as unknown as BrowserWorkspaceTab

function renderBar(open = true, onClose = vi.fn()) {
  const view = render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <BrowserFindBar tab={tab} open={open} focusToken={0} onClose={onClose} />
    </NextIntlClientProvider>
  )
  return { ...view, onClose }
}

beforeEach(() => {
  mocks.browserFind.mockReset()
  mocks.browserFind.mockResolvedValue(true)
})

describe("BrowserFindBar", () => {
  it("renders nothing while closed", () => {
    const { container } = renderBar(false)
    expect(container).toBeEmptyDOMElement()
  })

  it("searches as the query is typed and steps with Enter", async () => {
    renderBar()
    const input = screen.getByLabelText("Find in page")
    await act(async () => {
      fireEvent.change(input, { target: { value: "needle" } })
    })
    expect(mocks.browserFind).toHaveBeenLastCalledWith("abc", "needle", true)

    // Enter walks forward, Shift+Enter backward — the engine owns the cursor.
    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter" })
    })
    expect(mocks.browserFind).toHaveBeenLastCalledWith("abc", "needle", true)
    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter", shiftKey: true })
    })
    expect(mocks.browserFind).toHaveBeenLastCalledWith("abc", "needle", false)

    await act(async () => {
      fireEvent.click(screen.getByLabelText("Previous match"))
    })
    expect(mocks.browserFind).toHaveBeenLastCalledWith("abc", "needle", false)
  })

  it("says so when nothing matched", async () => {
    mocks.browserFind.mockResolvedValue(false)
    renderBar()
    await act(async () => {
      fireEvent.change(screen.getByLabelText("Find in page"), {
        target: { value: "zzz" },
      })
    })
    expect(screen.getByText("No matches")).toBeInTheDocument()
  })

  it("clears the query without searching for an empty string", async () => {
    renderBar()
    const input = screen.getByLabelText("Find in page")
    await act(async () => {
      fireEvent.change(input, { target: { value: "a" } })
      fireEvent.change(input, { target: { value: "" } })
    })
    // An empty query is the engine's "drop the highlight", not a search.
    expect(mocks.browserFind).toHaveBeenLastCalledWith("abc", "", true)
  })

  // Each search is a round trip; an answer that arrives after a newer search
  // must not relabel the query on screen now.
  it("ignores an answer that a newer search has superseded", async () => {
    let settleFirst: (found: boolean) => void = () => {}
    mocks.browserFind
      .mockImplementationOnce(
        () => new Promise<boolean>((resolve) => (settleFirst = resolve))
      )
      .mockResolvedValueOnce(false)
    renderBar()
    const input = screen.getByLabelText("Find in page")
    await act(async () => {
      fireEvent.change(input, { target: { value: "a" } })
      fireEvent.change(input, { target: { value: "az" } })
    })
    // The newer search already said "no matches".
    expect(screen.getByText("No matches")).toBeInTheDocument()
    await act(async () => {
      settleFirst(true)
    })
    expect(screen.getByText("No matches")).toBeInTheDocument()
  })

  it("closes on Escape and drops the highlight when it goes away", async () => {
    const onClose = vi.fn()
    const { rerender } = renderBar(true, onClose)
    fireEvent.keyDown(screen.getByLabelText("Find in page"), { key: "Escape" })
    expect(onClose).toHaveBeenCalled()

    mocks.browserFind.mockClear()
    await act(async () => {
      rerender(
        <NextIntlClientProvider locale="en" messages={enMessages}>
          <BrowserFindBar
            tab={tab}
            open={false}
            focusToken={0}
            onClose={onClose}
          />
        </NextIntlClientProvider>
      )
    })
    expect(mocks.browserFind).toHaveBeenCalledWith("abc", "", true)
  })
})
