import { type ReactElement } from "react"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { describe, expect, it, vi } from "vitest"

// The frame is under its own coverage (and jsdom won't run the srcdoc);
// stand it in with a button that replays a page submit.
vi.mock("@/components/message/render-page-frame", () => ({
  RenderPageFrame: ({
    onSubmit,
  }: {
    onSubmit?: (s: {
      id: number
      summary: string
      data: unknown
    }) => Promise<void>
  }) => (
    <button
      type="button"
      data-testid="page-submit"
      onClick={() =>
        // The real frame awaits and reports the rejection back to the page;
        // here it only needs to not leak an unhandled rejection.
        void onSubmit?.({ id: 1, summary: "picked A", data: { a: 1 } })?.catch(
          () => {}
        )
      }
    />
  ),
}))

import { RenderPageCard } from "./render-page-card"
import enMessages from "@/i18n/messages/en.json"
import type { PendingRenderPageState } from "@/lib/types"

function renderWithIntl(ui: ReactElement) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      {ui}
    </NextIntlClientProvider>
  )
}

const PAGE: PendingRenderPageState = {
  page_id: "p1",
  title: "Theme picker",
  html: "<h1>hi</h1>",
  created_at: "2026-10-25T00:00:00Z",
}

const ui = enMessages.Folder.chat.renderPage

describe("RenderPageCard", () => {
  it("titles the card with the page title and the waiting hint", () => {
    renderWithIntl(<RenderPageCard page={PAGE} onAnswer={vi.fn()} />)
    expect(screen.getByText("Theme picker")).toBeInTheDocument()
    expect(screen.getByText(ui.waitingHint)).toBeInTheDocument()
  })

  it("falls back to the generic title when the agent gave the page none", () => {
    renderWithIntl(
      <RenderPageCard page={{ ...PAGE, title: "" }} onAnswer={vi.fn()} />
    )
    expect(screen.getByText(ui.title)).toBeInTheDocument()
  })

  it("routes a page submit to the answer callback", async () => {
    const onAnswer = vi.fn().mockResolvedValue(undefined)
    renderWithIntl(<RenderPageCard page={PAGE} onAnswer={onAnswer} />)
    fireEvent.click(screen.getByTestId("page-submit"))
    await waitFor(() =>
      expect(onAnswer).toHaveBeenCalledWith("p1", {
        summary: "picked A",
        data: { a: 1 },
        declined: false,
      })
    )
  })

  it("surfaces a failed submit as the retryable error line", async () => {
    const onAnswer = vi.fn().mockRejectedValue(new Error("offline"))
    renderWithIntl(<RenderPageCard page={PAGE} onAnswer={onAnswer} />)
    fireEvent.click(screen.getByTestId("page-submit"))
    await waitFor(() =>
      expect(screen.getByText(ui.submitError)).toBeInTheDocument()
    )
  })

  it("dismisses with a decline", async () => {
    const onAnswer = vi.fn().mockResolvedValue(undefined)
    renderWithIntl(<RenderPageCard page={PAGE} onAnswer={onAnswer} />)
    fireEvent.click(screen.getByRole("button", { name: ui.dismiss }))
    await waitFor(() =>
      expect(onAnswer).toHaveBeenCalledWith("p1", { declined: true })
    )
  })
})
