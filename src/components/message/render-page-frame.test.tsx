import { type ReactElement } from "react"
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, describe, expect, it, vi } from "vitest"

// The bubble confirms a copy with a toast, because it unmounts itself right
// after the action and leaves no button to turn into a checkmark.
const toastSuccess = vi.fn()
const toastError = vi.fn()
vi.mock("sonner", () => ({
  toast: {
    success: (m: unknown) => toastSuccess(m),
    error: (m: unknown) => toastError(m),
  },
}))

import { RenderPageFrame } from "./render-page-frame"
import enMessages from "@/i18n/messages/en.json"
import {
  RENDER_PAGE_ANNOTATE_MESSAGE,
  RENDER_PAGE_ANNOTATION_MESSAGE,
  RENDER_PAGE_CLEAR_SELECTION_MESSAGE,
  RENDER_PAGE_SELECTION_ESCAPE_MESSAGE,
  RENDER_PAGE_SELECTION_MESSAGE,
} from "@/lib/render-page"

const ml = enMessages.Folder.chat.messageList
const rp = enMessages.Folder.chat.renderPage

const ANSWER_WAITING = { waiting: true, answer: null } as const

function renderWithIntl(ui: ReactElement) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      {ui}
    </NextIntlClientProvider>
  )
}

/** Deliver a message as if the page inside the frame posted it: the frame
 *  only trusts events whose source is its own contentWindow. */
function postFromFrame(
  iframe: HTMLIFrameElement,
  data: Record<string, unknown>
) {
  act(() => {
    window.dispatchEvent(
      new MessageEvent("message", { data, source: iframe.contentWindow })
    )
  })
}

function reportSelection(
  iframe: HTMLIFrameElement,
  text: string,
  rect: { x: number; y: number; width: number; height: number } | null
) {
  postFromFrame(iframe, { type: RENDER_PAGE_SELECTION_MESSAGE, text, rect })
}

/** jsdom has no layout, so every box reports width 0 — which makes the
 *  clamp's edge math (and its center-fallback) meaningless. Give the frame
 *  container a believable width before measuring the bubble's anchor. */
function giveWidth(el: Element, width: number) {
  Object.defineProperty(el, "clientWidth", { configurable: true, value: width })
}

afterEach(() => {
  toastSuccess.mockClear()
  toastError.mockClear()
})

describe("RenderPageFrame selection bubble", () => {
  it("hangs the bubble over a reported selection", () => {
    const { container } = renderWithIntl(
      <RenderPageFrame html="<p>hi</p>" answerState={ANSWER_WAITING} />
    )
    const iframe = container.querySelector("iframe")!
    giveWidth(container.firstElementChild!, 400)
    // Mid-page: the bubble sits above the selection, anchored to its center,
    // and the translate takes the -8px gap and the flip over the anchor.
    reportSelection(iframe, "picked text", {
      x: 40,
      y: 120,
      width: 100,
      height: 16,
    })
    const bubble = screen.getByRole("toolbar", {
      name: ml.selectionActions,
    })
    expect(bubble).toHaveStyle({ left: "90px", top: "112px" })
    expect(bubble).toHaveStyle({ transform: "translate(-50%, -100%)" })
  })

  it("flips under a selection that starts near the top of the page", () => {
    const { container } = renderWithIntl(
      <RenderPageFrame html="<p>hi</p>" answerState={ANSWER_WAITING} />
    )
    const iframe = container.querySelector("iframe")!
    giveWidth(container.firstElementChild!, 400)
    reportSelection(iframe, "first line", {
      x: 20,
      y: 10,
      width: 60,
      height: 16,
    })
    const bubble = screen.getByRole("toolbar")
    expect(bubble).toHaveStyle({ left: "50px", top: "34px" })
    expect(bubble).toHaveStyle({ transform: "translate(-50%, 0)" })
  })

  it("hides when the page reports the selection gone or pressed Escape", () => {
    const { container } = renderWithIntl(
      <RenderPageFrame html="<p>hi</p>" answerState={ANSWER_WAITING} />
    )
    const iframe = container.querySelector("iframe")!
    reportSelection(iframe, "here", { x: 40, y: 120, width: 40, height: 10 })
    expect(screen.getByRole("toolbar")).toBeInTheDocument()
    reportSelection(iframe, "", null)
    expect(screen.queryByRole("toolbar")).toBeNull()

    reportSelection(iframe, "here again", {
      x: 40,
      y: 120,
      width: 40,
      height: 10,
    })
    expect(screen.getByRole("toolbar")).toBeInTheDocument()
    postFromFrame(iframe, { type: RENDER_PAGE_SELECTION_ESCAPE_MESSAGE })
    expect(screen.queryByRole("toolbar")).toBeNull()
  })

  it("ignores a message from another window", () => {
    const { container } = renderWithIntl(
      <RenderPageFrame html="<p>hi</p>" answerState={ANSWER_WAITING} />
    )
    act(() => {
      window.dispatchEvent(
        new MessageEvent("message", {
          data: {
            type: RENDER_PAGE_SELECTION_MESSAGE,
            text: "stranger",
            rect: { x: 0, y: 100, width: 10, height: 10 },
          },
        })
      )
    })
    expect(container.querySelector("iframe")).toBeInTheDocument()
    expect(screen.queryByRole("toolbar")).toBeNull()
  })

  it("quotes the text, tells the page to drop the selection, and closes", () => {
    const onQuote = vi.fn()
    const { container } = renderWithIntl(
      <RenderPageFrame
        html="<p>hi</p>"
        answerState={ANSWER_WAITING}
        onQuote={onQuote}
      />
    )
    const iframe = container.querySelector("iframe")!
    const postSpy = vi.spyOn(iframe.contentWindow!, "postMessage")
    reportSelection(iframe, "quote me", {
      x: 40,
      y: 120,
      width: 40,
      height: 10,
    })

    fireEvent.click(screen.getByRole("button", { name: ml.selectionQuote }))
    expect(onQuote).toHaveBeenCalledWith("quote me")
    expect(postSpy).toHaveBeenCalledWith(
      { type: RENDER_PAGE_CLEAR_SELECTION_MESSAGE },
      "*"
    )
    expect(screen.queryByRole("toolbar")).toBeNull()
  })

  it("copies the text and toasts, without a quote handler on read-only surfaces", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    })
    const { container } = renderWithIntl(
      <RenderPageFrame html="<p>hi</p>" answerState={ANSWER_WAITING} />
    )
    const iframe = container.querySelector("iframe")!
    // Without onQuote there is no composer to quote into — only copy remains.
    expect(screen.queryByRole("button", { name: ml.selectionQuote })).toBeNull()

    reportSelection(iframe, "copy me", { x: 40, y: 120, width: 40, height: 10 })
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: ml.selectionCopy }))
    })
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("copy me"))
    expect(toastSuccess).toHaveBeenCalledWith(ml.selectionCopied)
    expect(screen.queryByRole("toolbar")).toBeNull()
  })

  it("toasts an error when the clipboard write fails", async () => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn().mockRejectedValue(new Error("denied")) },
    })
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value: vi.fn().mockReturnValue(false),
    })
    const { container } = renderWithIntl(
      <RenderPageFrame html="<p>hi</p>" answerState={ANSWER_WAITING} />
    )
    const iframe = container.querySelector("iframe")!
    reportSelection(iframe, "x", { x: 40, y: 120, width: 40, height: 10 })
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: ml.selectionCopy }))
    })
    expect(toastError).toHaveBeenCalledWith(ml.selectionCopyFailed)
    expect(toastSuccess).not.toHaveBeenCalled()
  })
})

const ANNOTATION_PAYLOAD = {
  viewport: { width: 1280, height: 800 },
  comment: "make it bigger",
  elements: [
    {
      selector: "#hero > h1",
      html: '<h1 id="hero">Ship it</h1>',
      text: "Ship it",
      attributes: { id: "hero" },
      styles: { display: "block", fontSize: "16px", fontWeight: "700" },
      bounds: { x: 10, y: 20, width: 100, height: 40 },
    },
  ],
  regions: [{ id: "region-1", rect: { x: 1, y: 2, width: 3, height: 4 } }],
  strokes: [
    {
      id: "stroke-1",
      points: [
        { x: 0, y: 0 },
        { x: 5, y: 6 },
      ],
      bounds: { x: 0, y: 0, width: 5, height: 6 },
    },
  ],
}

describe("RenderPageFrame annotation session", () => {
  it("hides the annotate entry without a composer handler", () => {
    const { container } = renderWithIntl(
      <RenderPageFrame html="<p>hi</p>" answerState={ANSWER_WAITING} />
    )
    expect(container.querySelector("iframe")).toBeInTheDocument()
    expect(screen.queryByTestId("render-page-annotate-button")).toBeNull()
  })

  it("opens the overlay with localised labels and closes it on a second press", () => {
    const onAnnotate = vi.fn()
    const { container } = renderWithIntl(
      <RenderPageFrame
        html="<p>hi</p>"
        answerState={ANSWER_WAITING}
        onAnnotate={onAnnotate}
      />
    )
    const iframe = container.querySelector("iframe")!
    const postSpy = vi.spyOn(iframe.contentWindow!, "postMessage")
    const entry = screen.getByTestId("render-page-annotate-button")

    fireEvent.click(entry)
    expect(postSpy).toHaveBeenCalledWith(
      {
        type: RENDER_PAGE_ANNOTATE_MESSAGE,
        action: "start",
        labels: {
          element: rp.annotateElement,
          region: rp.annotateRegion,
          draw: rp.annotateDraw,
          placeholder: rp.annotatePlaceholder,
          send: rp.annotateSend,
          cancel: rp.annotateCancel,
        },
      },
      "*"
    )
    expect(entry).toHaveAttribute("aria-pressed", "true")

    fireEvent.click(entry)
    expect(postSpy).toHaveBeenCalledWith(
      { type: RENDER_PAGE_ANNOTATE_MESSAGE, action: "stop" },
      "*"
    )
    expect(entry).toHaveAttribute("aria-pressed", "false")
  })

  it("sends a finished session to the composer as formatted text", () => {
    const onAnnotate = vi.fn()
    const { container } = renderWithIntl(
      <RenderPageFrame
        html="<p>hi</p>"
        answerState={ANSWER_WAITING}
        onAnnotate={onAnnotate}
        pageTitle="Theme picker"
      />
    )
    const iframe = container.querySelector("iframe")!
    fireEvent.click(screen.getByTestId("render-page-annotate-button"))
    postFromFrame(iframe, {
      type: RENDER_PAGE_ANNOTATION_MESSAGE,
      payload: ANNOTATION_PAYLOAD,
    })
    const [text] = onAnnotate.mock.calls[0] as [string]
    expect(text).toContain("Page: Theme picker")
    expect(text).toContain("Comment: make it bigger")
    expect(text).toContain("Element 1: #hero > h1")
    expect(text).toContain(
      "- Styles: display=block; position=; font=700 16px /  ; color=; background="
    )
    expect(text).toContain("Region 1: x=1, y=2, width=3, height=4")
    expect(text).toContain("Drawing 1: 2 points")
    // The session is over: the entry is no longer pressed.
    expect(screen.getByTestId("render-page-annotate-button")).toHaveAttribute(
      "aria-pressed",
      "false"
    )
  })

  it("resets the session when the page cancels, without calling the handler", () => {
    const onAnnotate = vi.fn()
    const { container } = renderWithIntl(
      <RenderPageFrame
        html="<p>hi</p>"
        answerState={ANSWER_WAITING}
        onAnnotate={onAnnotate}
      />
    )
    const iframe = container.querySelector("iframe")!
    fireEvent.click(screen.getByTestId("render-page-annotate-button"))
    postFromFrame(iframe, {
      type: RENDER_PAGE_ANNOTATION_MESSAGE,
      payload: null,
    })
    expect(onAnnotate).not.toHaveBeenCalled()
    expect(screen.getByTestId("render-page-annotate-button")).toHaveAttribute(
      "aria-pressed",
      "false"
    )
  })
})
