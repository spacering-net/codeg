import { describe, expect, it } from "vitest"

import {
  buildRenderPageDocument,
  clampRenderPageHeight,
  formatRenderPageAnnotation,
  parseRenderPageInput,
  parseRenderPageOutcome,
  readRenderPageAnnotationPayload,
  readRenderPageFrameMessage,
  renderPageAnnotateMessage,
  renderPageAnswerFromSubmit,
  RENDER_PAGE_ANNOTATE_MESSAGE,
  RENDER_PAGE_ANNOTATION_MESSAGE,
  RENDER_PAGE_MAX_HEIGHT,
  RENDER_PAGE_MIN_HEIGHT,
  RENDER_PAGE_OPEN_LINK_MESSAGE,
  RENDER_PAGE_SELECTION_ESCAPE_MESSAGE,
  RENDER_PAGE_SELECTION_MAX,
  RENDER_PAGE_SELECTION_MESSAGE,
  RENDER_PAGE_SIZE_MESSAGE,
  RENDER_PAGE_SUBMIT_MESSAGE,
  type RenderPageAnnotationPayload,
  type RenderPageTheme,
} from "./render-page"

const THEME: RenderPageTheme = { appearance: "light", variables: {} }

describe("buildRenderPageDocument", () => {
  it("prepends a doctype and injects the bootstrap when the page is a fragment", () => {
    const doc = buildRenderPageDocument("<p>hello</p>", THEME)
    expect(doc.startsWith("<!doctype html><head>")).toBe(true)
    expect(doc).toContain('<style id="codeg-render-theme">')
    expect(doc).toContain(
      '<script type="application/json" id="codeg-render-answer">'
    )
    expect(doc).toContain("<p>hello</p>")
    // The selection reporter is part of the bootstrap: the page's selection is
    // unreadable from outside the opaque origin, so the page must push it up.
    expect(doc).toContain("selectionchange")
    expect(doc).toContain(RENDER_PAGE_SELECTION_MESSAGE)
  })

  it("injects after an existing <head> opening tag", () => {
    const doc = buildRenderPageDocument(
      "<!doctype html><html><head><title>T</title></head><body></body></html>",
      THEME
    )
    // The bootstrap (charset, viewport, theme, scripts) lands first inside the
    // page's own head, ahead of its original children.
    expect(doc).toMatch(
      /<head><meta charset="utf-8">.*<style id="codeg-render-theme">.*<title>T<\/title>/
    )
  })

  it("keeps the page's own charset/viewport instead of duplicating them", () => {
    const doc = buildRenderPageDocument(
      '<html><head><meta charset="utf-8"><meta name="viewport" content="width=500"></head></html>',
      THEME
    )
    expect(doc.match(/<meta charset/gi)).toHaveLength(1)
    expect(doc.match(/name\s*=\s*"viewport/gi)).toHaveLength(1)
  })

  it("does not mistake a string literal in a script for a head tag", () => {
    const doc = buildRenderPageDocument(
      "<body><script>var s = '<head>'</script></body>",
      THEME
    )
    // The injection point is the real head/html scan, not the first `<head>`
    // text found anywhere: the literal inside the script must stay in the body.
    const injected = doc.indexOf('<style id="codeg-render-theme">')
    const literal = doc.indexOf("var s = '<head>'")
    expect(injected).toBeLessThan(literal)
  })

  it("carries the answer state into the page", () => {
    const doc = buildRenderPageDocument("<p>x</p>", THEME, {
      waiting: true,
      answer: null,
    })
    expect(doc).toContain('"waiting":true')
  })
})

describe("readRenderPageFrameMessage", () => {
  it("reads the protocol messages", () => {
    expect(
      readRenderPageFrameMessage({
        type: RENDER_PAGE_SIZE_MESSAGE,
        height: 120,
      })
    ).toEqual({ kind: "size", height: 120 })
    expect(
      readRenderPageFrameMessage({
        type: RENDER_PAGE_OPEN_LINK_MESSAGE,
        url: "https://example.com",
      })
    ).toEqual({ kind: "open-link", url: "https://example.com" })
    expect(
      readRenderPageFrameMessage({
        type: RENDER_PAGE_SUBMIT_MESSAGE,
        id: 3,
        summary: "picked A",
        data: { a: 1 },
      })
    ).toEqual({ kind: "submit", id: 3, summary: "picked A", data: { a: 1 } })
  })

  it("rejects malformed payloads", () => {
    expect(readRenderPageFrameMessage(null)).toBeNull()
    expect(readRenderPageFrameMessage("size")).toBeNull()
    expect(
      readRenderPageFrameMessage({ type: RENDER_PAGE_SIZE_MESSAGE, height: 0 })
    ).toBeNull()
    expect(
      readRenderPageFrameMessage({
        type: RENDER_PAGE_SIZE_MESSAGE,
        height: "10",
      })
    ).toBeNull()
    expect(
      readRenderPageFrameMessage({
        type: RENDER_PAGE_OPEN_LINK_MESSAGE,
        url: "javascript:alert(1)",
      })
    ).toBeNull()
    expect(
      readRenderPageFrameMessage({ type: RENDER_PAGE_SUBMIT_MESSAGE, id: 1.5 })
    ).toBeNull()
  })

  it("defaults a submit's missing data to null", () => {
    const msg = readRenderPageFrameMessage({
      type: RENDER_PAGE_SUBMIT_MESSAGE,
      id: 7,
      summary: "ok",
    })
    expect(msg).toEqual({ kind: "submit", id: 7, summary: "ok", data: null })
  })

  it("reads a selection report and its removal", () => {
    expect(
      readRenderPageFrameMessage({
        type: RENDER_PAGE_SELECTION_MESSAGE,
        text: "picked text",
        rect: { x: 10, y: -4.5, width: 120, height: 18 },
      })
    ).toEqual({
      kind: "selection",
      text: "picked text",
      rect: { x: 10, y: -4.5, width: 120, height: 18 },
    })
    expect(
      readRenderPageFrameMessage({
        type: RENDER_PAGE_SELECTION_MESSAGE,
        text: "",
        rect: null,
      })
    ).toEqual({ kind: "selection", text: "", rect: null })
    expect(
      readRenderPageFrameMessage({
        type: RENDER_PAGE_SELECTION_ESCAPE_MESSAGE,
      })
    ).toEqual({ kind: "selection-escape" })
  })

  it("rejects malformed selection payloads", () => {
    expect(
      readRenderPageFrameMessage({ type: RENDER_PAGE_SELECTION_MESSAGE })
    ).toBeNull()
    expect(
      readRenderPageFrameMessage({
        type: RENDER_PAGE_SELECTION_MESSAGE,
        text: "x".repeat(RENDER_PAGE_SELECTION_MAX + 1),
        rect: { x: 0, y: 0, width: 1, height: 1 },
      })
    ).toBeNull()
    // A non-empty text with no usable rect has nothing to hang the bubble on.
    expect(
      readRenderPageFrameMessage({
        type: RENDER_PAGE_SELECTION_MESSAGE,
        text: "x",
        rect: null,
      })
    ).toBeNull()
    expect(
      readRenderPageFrameMessage({
        type: RENDER_PAGE_SELECTION_MESSAGE,
        text: "x",
        rect: { x: 0, y: 0, width: -1, height: 1 },
      })
    ).toBeNull()
    expect(
      readRenderPageFrameMessage({
        type: RENDER_PAGE_SELECTION_MESSAGE,
        text: "x",
        rect: { x: Number.NaN, y: 0, width: 1, height: 1 },
      })
    ).toBeNull()
  })

  it("reads an annotation report and its cancel", () => {
    const payload: RenderPageAnnotationPayload = {
      viewport: { width: 1280, height: 800 },
      comment: "make it bigger",
      elements: [
        {
          selector: "#hero > h1",
          html: '<h1 id="hero">Ship it</h1>',
          text: "Ship it",
          attributes: { id: "hero" },
          styles: { fontSize: "16px" },
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
    expect(
      readRenderPageFrameMessage({
        type: RENDER_PAGE_ANNOTATION_MESSAGE,
        payload,
      })
    ).toEqual({ kind: "annotation", payload })
    expect(
      readRenderPageFrameMessage({
        type: RENDER_PAGE_ANNOTATION_MESSAGE,
        payload: null,
      })
    ).toEqual({ kind: "annotation", payload: null })
    // A malformed report is not a report at all — ignored, not delivered.
    expect(
      readRenderPageFrameMessage({
        type: RENDER_PAGE_ANNOTATION_MESSAGE,
        payload: { ...payload, comment: 42 },
      })
    ).toBeNull()
  })
})

describe("clampRenderPageHeight", () => {
  it("keeps the report inside the floor and the cap", () => {
    expect(clampRenderPageHeight(1)).toBe(RENDER_PAGE_MIN_HEIGHT)
    expect(clampRenderPageHeight(240.4)).toBe(241)
    expect(clampRenderPageHeight(99_999)).toBe(RENDER_PAGE_MAX_HEIGHT)
  })
})

describe("renderPageAnswerFromSubmit", () => {
  it("maps a page submit onto the answer envelope", () => {
    expect(
      renderPageAnswerFromSubmit({
        kind: "submit",
        id: 1,
        summary: "go with B",
        data: { choice: "b" },
      })
    ).toEqual({ summary: "go with B", data: { choice: "b" }, declined: false })
  })
})

describe("parseRenderPageInput", () => {
  it("reads the full argument set", () => {
    expect(
      parseRenderPageInput(
        JSON.stringify({
          html: "<h1>hi</h1>",
          title: "Choices",
          awaitAnswer: true,
        })
      )
    ).toEqual({ html: "<h1>hi</h1>", title: "Choices", awaitAnswer: true })
  })

  it("collapses missing fields to the tool's defaults", () => {
    expect(parseRenderPageInput(JSON.stringify({ html: "<p>x</p>" }))).toEqual({
      html: "<p>x</p>",
      title: "",
      awaitAnswer: false,
    })
  })

  it("returns null without a usable html", () => {
    expect(parseRenderPageInput(null)).toBeNull()
    expect(parseRenderPageInput("{trunc")).toBeNull()
    expect(parseRenderPageInput(JSON.stringify({ title: "t" }))).toBeNull()
    expect(parseRenderPageInput(JSON.stringify({ html: "   " }))).toBeNull()
  })
})

describe("parseRenderPageOutcome", () => {
  it("reads the show-only structured envelope", () => {
    expect(
      parseRenderPageOutcome(
        JSON.stringify({ shown: true, title: "P", note: "…shown…" })
      )
    ).toEqual({ kind: "shown" })
  })

  it("reads the answered and declined envelopes", () => {
    expect(
      parseRenderPageOutcome(
        JSON.stringify({ answered: true, summary: "go B", data: null })
      )
    ).toEqual({ kind: "answered", summary: "go B" })
    expect(
      parseRenderPageOutcome(
        JSON.stringify({ answered: false, note: "did not answer" })
      )
    ).toEqual({ kind: "declined" })
  })

  it("falls back into a CLI's structuredContent wrapper", () => {
    expect(
      parseRenderPageOutcome(
        JSON.stringify({ content: [], structuredContent: { shown: true } })
      )
    ).toEqual({ kind: "shown" })
  })

  it("falls back to the note text and the MCP content wrapper", () => {
    expect(
      parseRenderPageOutcome(
        'The user answered on the page.\nsummary: pick B\ndata: {"a":1}\ncontinue'
      )
    ).toEqual({ kind: "answered", summary: "pick B" })
    expect(
      parseRenderPageOutcome(
        "The user did not answer on the page (they dismissed it)."
      )
    ).toEqual({ kind: "declined" })
    expect(
      parseRenderPageOutcome("Shown to the user in the chat above your reply.")
    ).toEqual({ kind: "shown" })
    expect(
      parseRenderPageOutcome(
        JSON.stringify({
          content: [
            {
              type: "text",
              text: "The user answered on the page.\nsummary: ok\ndata: null\nx",
            },
          ],
          isError: false,
        })
      )
    ).toEqual({ kind: "answered", summary: "ok" })
  })

  it("returns null while the call is still in flight", () => {
    expect(parseRenderPageOutcome(null)).toBeNull()
    expect(parseRenderPageOutcome("")).toBeNull()
    expect(parseRenderPageOutcome("some other result")).toBeNull()
  })
})

describe("readRenderPageAnnotationPayload", () => {
  const base = (): RenderPageAnnotationPayload => ({
    viewport: { width: 100, height: 50 },
    comment: "note",
    elements: [],
    regions: [],
    strokes: [],
  })

  it("accepts a well-formed report", () => {
    expect(readRenderPageAnnotationPayload(base())).toEqual(base())
  })

  it("rejects missing or non-finite viewport numbers", () => {
    expect(
      readRenderPageAnnotationPayload({
        ...base(),
        viewport: { width: Infinity, height: 50 },
      })
    ).toBeNull()
    expect(
      readRenderPageAnnotationPayload({ ...base(), viewport: null })
    ).toBeNull()
  })

  it("enforces the comment and array caps", () => {
    expect(
      readRenderPageAnnotationPayload({ ...base(), comment: "x".repeat(4001) })
    ).toBeNull()
    expect(
      readRenderPageAnnotationPayload({
        ...base(),
        comment: "x".repeat(4000),
      })
    ).not.toBeNull()
    expect(
      readRenderPageAnnotationPayload({
        ...base(),
        elements: Array.from({ length: 9 }, () => ({
          selector: "a",
          text: "",
          attributes: {},
          bounds: { x: 0, y: 0, width: 1, height: 1 },
        })),
      })
    ).toBeNull()
  })

  it("validates element fields and attribute values", () => {
    const el = {
      selector: "div",
      html: "<div>t</div>",
      text: "t",
      attributes: { id: "x" },
      styles: { fontSize: "16px" },
      bounds: { x: 0, y: 0, width: 1, height: 1 },
    }
    expect(
      readRenderPageAnnotationPayload({ ...base(), elements: [el] })
    ).not.toBeNull()
    expect(
      readRenderPageAnnotationPayload({
        ...base(),
        elements: [{ ...el, attributes: { id: "x".repeat(201) } }],
      })
    ).toBeNull()
    expect(
      readRenderPageAnnotationPayload({
        ...base(),
        elements: [{ ...el, styles: { fontSize: "x".repeat(201) } }],
      })
    ).toBeNull()
    expect(
      readRenderPageAnnotationPayload({
        ...base(),
        elements: [
          {
            ...el,
            styles: Object.fromEntries(
              Array.from({ length: 23 }, (_, i) => [`p${i}`, "1px"])
            ),
          },
        ],
      })
    ).toBeNull()
    expect(
      readRenderPageAnnotationPayload({
        ...base(),
        elements: [{ ...el, html: "<div>" + "x".repeat(600) }],
      })
    ).toBeNull()
    const noHtml = { ...el } as Partial<typeof el>
    delete noHtml.html
    expect(
      readRenderPageAnnotationPayload({ ...base(), elements: [noHtml] })
    ).toBeNull()
    expect(
      readRenderPageAnnotationPayload({
        ...base(),
        elements: [{ ...el, bounds: { x: 0, y: 0, width: -1, height: 1 } }],
      })
    ).toBeNull()
  })

  it("requires strokes to carry at least two finite points", () => {
    const stroke = {
      id: "stroke-1",
      points: [
        { x: 0, y: 0 },
        { x: 1, y: 1 },
      ],
      bounds: { x: 0, y: 0, width: 1, height: 1 },
    }
    expect(
      readRenderPageAnnotationPayload({ ...base(), strokes: [stroke] })
    ).not.toBeNull()
    expect(
      readRenderPageAnnotationPayload({
        ...base(),
        strokes: [{ ...stroke, points: [{ x: 0, y: 0 }] }],
      })
    ).toBeNull()
    expect(
      readRenderPageAnnotationPayload({
        ...base(),
        strokes: [
          {
            ...stroke,
            points: [
              { x: 0, y: 0 },
              { x: NaN, y: 1 },
            ],
          },
        ],
      })
    ).toBeNull()
  })

  it("rejects a non-object payload", () => {
    expect(readRenderPageAnnotationPayload(null)).toBeNull()
    expect(readRenderPageAnnotationPayload("report")).toBeNull()
  })
})

describe("formatRenderPageAnnotation", () => {
  it("writes the openchamber-shaped report with rounded geometry", () => {
    const text = formatRenderPageAnnotation(
      {
        viewport: { width: 1280.4, height: 800.6 },
        comment: "  make it bigger  ",
        elements: [
          {
            selector: "#hero > h1",
            html: '<h1 id="hero" class="t">Ship it</h1>',
            text: "Ship it",
            attributes: { id: "hero", class: "t" },
            styles: {
              display: "block",
              position: "static",
              fontWeight: "700",
              fontSize: "16px",
              lineHeight: "24px",
              fontFamily: "Arial",
              color: "rgb(0, 0, 0)",
              backgroundColor: "rgba(0, 0, 0, 0)",
            },
            bounds: { x: 10.2, y: 20.8, width: 100, height: 40 },
          },
        ],
        regions: [
          { id: "region-1", rect: { x: 1, y: 2, width: 3.4, height: 4.5 } },
        ],
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
      },
      "Theme picker"
    )
    expect(text.split("\n")).toEqual([
      "The user annotated the page below your request. Apply each note ONLY to the element, region, or drawing it marks — never to the whole page — in your next step.",
      "Page: Theme picker",
      "Viewport: 1280x801",
      "Screenshot: not attached",
      "Comment: make it bigger",
      "Element 1: #hero > h1",
      '- HTML: <h1 id="hero" class="t">Ship it</h1>',
      "- Text: Ship it",
      '- Attributes: id="hero" class="t"',
      "- Bounds: x=10, y=21, width=100, height=40",
      "- Styles: display=block; position=static; font=700 16px / 24px Arial; color=rgb(0, 0, 0); background=rgba(0, 0, 0, 0)",
      "Region 1: x=1, y=2, width=3, height=5",
      "Drawing 1: 2 points over x=0, y=0, width=5, height=6",
    ])
  })

  it("drops the title and comment lines when empty", () => {
    const text = formatRenderPageAnnotation(
      {
        viewport: { width: 10, height: 10 },
        comment: "   ",
        elements: [],
        regions: [],
        strokes: [],
      },
      "  "
    )
    expect(text.split("\n")).toEqual([
      "The user annotated the page below your request. Apply each note ONLY to the element, region, or drawing it marks — never to the whole page — in your next step.",
      "Viewport: 10x10",
      "Screenshot: not attached",
    ])
  })
})

describe("renderPageAnnotateMessage", () => {
  it("carries labels only when given", () => {
    expect(renderPageAnnotateMessage("stop")).toEqual({
      type: RENDER_PAGE_ANNOTATE_MESSAGE,
      action: "stop",
    })
    const labels = {
      element: "E",
      region: "R",
      draw: "D",
      placeholder: "P",
      send: "S",
      cancel: "C",
    }
    expect(renderPageAnnotateMessage("start", labels)).toEqual({
      type: RENDER_PAGE_ANNOTATE_MESSAGE,
      action: "start",
      labels,
    })
  })
})
