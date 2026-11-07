import { type ReactElement } from "react"
import { fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { describe, expect, it, vi } from "vitest"

// The frame owns the sandboxed iframe (postMessage, observers); stand it in
// with a marker so these tests cover the record's own state machine. The
// stand-in echoes the quote handler's presence so the wiring is assertable.
vi.mock("@/components/message/render-page-frame", () => ({
  RenderPageFrame: ({
    html,
    onQuote,
    onAnnotate,
  }: {
    html: string
    onQuote?: (text: string) => void
    onAnnotate?: (text: string) => void
  }) => (
    <div
      data-testid="render-page-frame"
      data-quote={onQuote ? "on" : "off"}
      data-annotate={onAnnotate ? "on" : "off"}
    >
      {html}
    </div>
  ),
}))

import { RenderPageResultCard } from "./render-page-result-card"
import {
  RenderPageAnnotateContext,
  RenderPageQuoteContext,
} from "./render-page-quote"
import enMessages from "@/i18n/messages/en.json"

function renderWithIntl(ui: ReactElement) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      {ui}
    </NextIntlClientProvider>
  )
}

const INPUT = JSON.stringify({
  html: "<h1>Pick a theme</h1>",
  title: "Theme picker",
  awaitAnswer: true,
})
const SHOW_INPUT = JSON.stringify({ html: "<p>report</p>" })

const result = enMessages.Folder.chat.renderPageResult

describe("RenderPageResultCard", () => {
  it("shows the error text when the call failed", () => {
    renderWithIntl(
      <RenderPageResultCard
        input={INPUT}
        errorText="page rejected"
        state="output-available"
      />
    )
    expect(screen.getByText("page rejected")).toBeInTheDocument()
    expect(screen.queryByTestId("render-page-frame")).toBeNull()
  })

  it("shows an awaiting placeholder for an in-flight awaited page", () => {
    renderWithIntl(
      <RenderPageResultCard input={INPUT} state="input-available" />
    )
    // The live interactive page belongs to the pinned card — no second frame
    // here, just the placeholder naming the wait.
    expect(screen.getByText(result.awaiting)).toBeInTheDocument()
    expect(screen.getByText("Theme picker")).toBeInTheDocument()
    expect(screen.queryByTestId("render-page-frame")).toBeNull()
  })

  it("renders the frame for an in-flight show-only call", () => {
    renderWithIntl(
      <RenderPageResultCard input={SHOW_INPUT} state="input-available" />
    )
    expect(screen.getByTestId("render-page-frame")).toHaveTextContent("report")
    expect(screen.queryByText(result.awaiting)).toBeNull()
  })

  it("renders nothing for an in-flight call whose input hasn't streamed in", () => {
    const { container } = renderWithIntl(
      <RenderPageResultCard input="{}" state="input-streaming" />
    )
    expect(container.firstChild).toBeNull()
  })

  it("draws the page for a settled show-only call", () => {
    renderWithIntl(
      <RenderPageResultCard
        input={SHOW_INPUT}
        output={JSON.stringify({ shown: true, title: "", note: "…" })}
        state="output-available"
      />
    )
    expect(screen.getByTestId("render-page-frame")).toHaveTextContent("report")
  })

  it("collapses an answered page into a capsule, expanding to replay it", () => {
    renderWithIntl(
      <RenderPageResultCard
        input={INPUT}
        output={JSON.stringify({
          answered: true,
          summary: "dark",
          data: { theme: "dark" },
        })}
        state="output-available"
      />
    )
    expect(screen.getByText(result.answeredLabel)).toBeInTheDocument()
    expect(screen.getByText("dark")).toBeInTheDocument()
    // Collapsed: no frame in the DOM yet.
    expect(screen.queryByTestId("render-page-frame")).toBeNull()

    fireEvent.click(screen.getByTestId("render-page-result-card"))
    expect(screen.getByTestId("render-page-frame")).toHaveTextContent(
      "Pick a theme"
    )
  })

  it("shows the declined note with the page replay", () => {
    renderWithIntl(
      <RenderPageResultCard
        input={INPUT}
        output={JSON.stringify({ answered: false, note: "…" })}
        state="output-available"
      />
    )
    expect(screen.getByText(result.declined)).toBeInTheDocument()
    expect(screen.getByTestId("render-page-frame")).toBeInTheDocument()
  })

  it("reads the answer from the note text when the CLI dropped the envelope", () => {
    renderWithIntl(
      <RenderPageResultCard
        input={INPUT}
        output={
          "The user answered on the page.\nsummary: ship it\ndata: null\ncontinue"
        }
        state="output-available"
      />
    )
    expect(screen.getByText(result.answeredLabel)).toBeInTheDocument()
    expect(screen.getByText("ship it")).toBeInTheDocument()
  })

  it("offers quote and annotate on a replayed page when the view has a composer", () => {
    const quote = vi.fn()
    const annotate = vi.fn()
    renderWithIntl(
      <RenderPageAnnotateContext.Provider value={annotate}>
        <RenderPageQuoteContext.Provider value={quote}>
          <RenderPageResultCard input={SHOW_INPUT} state="output-available" />
        </RenderPageQuoteContext.Provider>
      </RenderPageAnnotateContext.Provider>
    )
    expect(screen.getByTestId("render-page-frame")).toHaveAttribute(
      "data-quote",
      "on"
    )
    expect(screen.getByTestId("render-page-frame")).toHaveAttribute(
      "data-annotate",
      "on"
    )
  })

  it("stays copy-only outside a quoting view", () => {
    renderWithIntl(
      <RenderPageResultCard input={SHOW_INPUT} state="output-available" />
    )
    expect(screen.getByTestId("render-page-frame")).toHaveAttribute(
      "data-quote",
      "off"
    )
    expect(screen.getByTestId("render-page-frame")).toHaveAttribute(
      "data-annotate",
      "off"
    )
  })
})
