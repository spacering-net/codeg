import { fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { describe, expect, it } from "vitest"

import { ContextCompactionCard } from "./context-compaction-card"
import enMessages from "@/i18n/messages/en.json"
import type { ToolCallState } from "@/lib/adapters/ai-elements-adapter"

function renderCard(props: {
  state?: ToolCallState
  meta?: Record<string, unknown> | null
  summary?: string | null
}) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <ContextCompactionCard
        state={props.state}
        meta={props.meta}
        summary={props.summary}
      />
    </NextIntlClientProvider>
  )
}

describe("ContextCompactionCard", () => {
  it("shows the token delta from grok's top-level boolean-marker fields", () => {
    renderCard({
      state: "output-available",
      meta: { contextCompaction: true, tokensBefore: 51777, tokensAfter: 4616 },
    })
    expect(
      screen.getByText("Context compacted · 51,777 → 4,616 tokens")
    ).toBeInTheDocument()
  })

  it("falls back to the plain label for codex 1.3.0's bare versioned payload", () => {
    renderCard({
      state: "output-available",
      meta: { contextCompaction: { version: 1 } },
    })
    expect(screen.getByText("Context compacted")).toBeInTheDocument()
  })

  it("reads preTokens/postTokens and durationMs from the versioned payload", () => {
    renderCard({
      state: "output-available",
      meta: {
        contextCompaction: {
          version: 1,
          preTokens: 51777,
          postTokens: 4616,
          durationMs: 3200,
        },
      },
    })
    expect(
      screen.getByText("Context compacted · 51,777 → 4,616 tokens")
    ).toBeInTheDocument()
    expect(screen.getByText("· 3.2s")).toBeInTheDocument()
  })

  // claude-agent-acp 0.75.0 is the first adapter to actually send `trigger`, so
  // this untranslated vocabulary only becomes user-visible with that bump.
  it.each([
    ["automatic", "Automatically triggered"],
    // deepseek's parser passes the SDK's own spelling through; claude renames
    // it to `automatic`. Both mean the same thing to the reader.
    ["auto", "Automatically triggered"],
    ["manual", "Manually triggered"],
  ])("translates the %s trigger in the tooltip", (trigger, expected) => {
    renderCard({
      state: "output-available",
      meta: { contextCompaction: { version: 1, trigger } },
    })
    expect(screen.getByText("Context compacted").parentElement).toHaveAttribute(
      "title",
      expected
    )
  })

  // `trigger` is adapter-defined, so an unknown value is surfaced verbatim
  // rather than dropped or forced into one of the two known buckets.
  it("passes an unrecognized trigger through untranslated", () => {
    renderCard({
      state: "output-available",
      meta: { contextCompaction: { version: 1, trigger: "threshold" } },
    })
    expect(screen.getByText("Context compacted").parentElement).toHaveAttribute(
      "title",
      "threshold"
    )
  })

  it("shows the failed label when the versioned payload carries an error", () => {
    renderCard({
      state: "output-available",
      meta: {
        contextCompaction: { version: 1, error: "compaction interrupted" },
      },
    })
    const label = screen.getByText("Context compaction failed")
    expect(label).toBeInTheDocument()
    // The raw adapter error string is a tooltip, never inline prose.
    expect(label.parentElement).toHaveAttribute(
      "title",
      "compaction interrupted"
    )
  })

  it("shows the failed label for an output-error lifecycle without payload error", () => {
    renderCard({
      state: "output-error",
      meta: { contextCompaction: { version: 1 } },
    })
    expect(screen.getByText("Context compaction failed")).toBeInTheDocument()
  })

  it("keeps the in-progress label while compacting", () => {
    renderCard({
      state: "input-available",
      meta: { contextCompaction: { version: 1 } },
    })
    expect(screen.getByText("Compacting context…")).toBeInTheDocument()
  })

  it("stays a plain one-line divider when there is no summary", () => {
    renderCard({
      state: "output-available",
      meta: { contextCompaction: { version: 1 } },
      summary: "   ",
    })
    expect(
      screen.queryByRole("button", { name: /Summary/ })
    ).not.toBeInTheDocument()
  })

  it("opens and closes the retained summary beneath the divider", () => {
    renderCard({
      state: "output-available",
      meta: { contextCompaction: { version: 1 } },
      summary: "We refactored **the parser**.",
    })
    const toggle = screen.getByRole("button", { name: /Summary/ })
    // Collapsed by default: the boundary stays one line.
    expect(toggle).toHaveAttribute("aria-expanded", "false")
    expect(
      screen.queryByTestId("context-compaction-summary")
    ).not.toBeInTheDocument()

    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute("aria-expanded", "true")
    const body = screen.getByTestId("context-compaction-summary")
    expect(toggle).toHaveAttribute("aria-controls", body.id)
    // Rendered as markdown, not as the raw source.
    expect(body).toHaveTextContent("We refactored the parser.")
    expect(body.querySelector('[data-streamdown="strong"]')).toHaveTextContent(
      "the parser"
    )

    fireEvent.click(toggle)
    expect(
      screen.queryByTestId("context-compaction-summary")
    ).not.toBeInTheDocument()
  })

  // An unterminated `**` is the tell: streaming mode completes it into bold,
  // static mode prints the asterisks.
  it("renders a summary that is still arriving in streaming mode", () => {
    renderCard({
      state: "input-available",
      meta: { contextCompaction: { version: 1 } },
      summary: "We kept **the pars",
    })
    expect(screen.getByText("Compacting context…")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: /Summary/ }))
    const body = screen.getByTestId("context-compaction-summary")
    expect(body.querySelector('[data-streamdown="strong"]')).toHaveTextContent(
      "the pars"
    )
  })

  it("renders a settled summary as static markdown", () => {
    renderCard({
      state: "output-available",
      meta: { contextCompaction: { version: 1 } },
      summary: "We kept **the pars",
    })
    fireEvent.click(screen.getByRole("button", { name: /Summary/ }))
    const body = screen.getByTestId("context-compaction-summary")
    expect(body.querySelector('[data-streamdown="strong"]')).toBeNull()
    expect(body).toHaveTextContent("We kept **the pars")
  })
})
