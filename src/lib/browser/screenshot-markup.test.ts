import { afterEach, describe, expect, it, vi } from "vitest"

import {
  arrowGeometry,
  badgeCenter,
  describeMarkup,
  drawMarkup,
  MARK_COLOR,
  MARKED_IMAGE_MAX_BYTES,
  markFromDrag,
  markupStyle,
  renderMarkedScreenshot,
  visibleBox,
  withMarkup,
  type MarkupMark,
} from "./screenshot-markup"

/** A 2D context that writes down what was drawn, in order, with the paint
 *  each stroke or fill used. */
function recordingContext() {
  const calls: Array<{ op: string; args: unknown[]; paint?: string }> = []
  const ctx = {
    strokeStyle: "",
    fillStyle: "",
    lineWidth: 1,
    lineCap: "butt",
    lineJoin: "miter",
    font: "",
    textAlign: "start",
    textBaseline: "alphabetic",
    calls,
    clearRect: (...args: unknown[]) => calls.push({ op: "clearRect", args }),
    drawImage: (...args: unknown[]) => calls.push({ op: "drawImage", args }),
    beginPath: () => calls.push({ op: "beginPath", args: [] }),
    rect: (...args: unknown[]) => calls.push({ op: "rect", args }),
    moveTo: (...args: unknown[]) => calls.push({ op: "moveTo", args }),
    lineTo: (...args: unknown[]) => calls.push({ op: "lineTo", args }),
    closePath: () => calls.push({ op: "closePath", args: [] }),
    arc: (...args: unknown[]) => calls.push({ op: "arc", args }),
    stroke() {
      calls.push({
        op: "stroke",
        args: [this.lineWidth],
        paint: this.strokeStyle,
      })
    },
    fill() {
      calls.push({ op: "fill", args: [], paint: this.fillStyle })
    },
    fillText: (...args: unknown[]) => calls.push({ op: "fillText", args }),
  }
  return ctx
}

const box = (x: number, y: number, width: number, height: number) =>
  ({ kind: "box", x, y, width, height }) as const
const arrow = (fx: number, fy: number, tx: number, ty: number) =>
  ({ kind: "arrow", from: { x: fx, y: fy }, to: { x: tx, y: ty } }) as const

describe("markFromDrag", () => {
  it("makes the same box whichever corner it was dragged from", () => {
    const forward = markFromDrag("box", { x: 10, y: 20 }, { x: 110, y: 70 }, 8)
    const backward = markFromDrag("box", { x: 110, y: 70 }, { x: 10, y: 20 }, 8)
    expect(forward).toEqual(box(10, 20, 100, 50))
    expect(backward).toEqual(forward)
  })

  it("takes a drag short in every direction for a click", () => {
    expect(markFromDrag("box", { x: 0, y: 0 }, { x: 5, y: 7 }, 8)).toBeNull()
    expect(markFromDrag("box", { x: 0, y: 0 }, { x: 0, y: 0 }, 0)).toBeNull()
  })

  // A long thin box is how a line of text gets underlined.
  it("keeps a long thin box, but not one with no height at all", () => {
    expect(markFromDrag("box", { x: 0, y: 0 }, { x: 100, y: 5 }, 8)).toEqual(
      box(0, 0, 100, 5)
    )
    expect(markFromDrag("box", { x: 0, y: 0 }, { x: 100, y: 0 }, 8)).toBeNull()
  })

  it("points an arrow where the drag ended", () => {
    expect(
      markFromDrag("arrow", { x: 200, y: 10 }, { x: 20, y: 90 }, 8)
    ).toEqual(arrow(200, 10, 20, 90))
  })

  it("does not make an arrow out of a click", () => {
    expect(markFromDrag("arrow", { x: 5, y: 5 }, { x: 9, y: 8 }, 8)).toBeNull()
    expect(markFromDrag("arrow", { x: 5, y: 5 }, { x: 5, y: 5 }, 0)).toBeNull()
  })
})

describe("markupStyle", () => {
  it("scales with the picture and stays within bounds at both ends", () => {
    expect(markupStyle({ width: 1500, height: 900 }).line).toBeCloseTo(5)
    expect(markupStyle({ width: 1500, height: 900 }).line).toBe(
      markupStyle({ width: 900, height: 1500 }).line
    )
    expect(markupStyle({ width: 120, height: 80 }).line).toBe(2.5)
    expect(markupStyle({ width: 9000, height: 9000 }).line).toBe(10)
  })

  it("keeps a number badge big enough to read on a small picture", () => {
    expect(markupStyle({ width: 120, height: 80 }).badge).toBe(9)
  })
})

describe("arrowGeometry", () => {
  const style = markupStyle({ width: 1500, height: 900 })

  it("puts the tip where the arrow points and stops the shaft at the head", () => {
    const { head, shaftEnd } = arrowGeometry(
      { x: 0, y: 0 },
      { x: 300, y: 0 },
      style
    )
    expect(head[0]).toEqual({ x: 300, y: 0 })
    expect(shaftEnd.x).toBeCloseTo(300 - style.head)
    expect(shaftEnd.y).toBeCloseTo(0)
    // The base's two corners sit either side of the shaft, equally far.
    expect(head[1].x).toBeCloseTo(shaftEnd.x)
    expect(head[2].x).toBeCloseTo(shaftEnd.x)
    expect(head[1].y).toBeCloseTo(-head[2].y)
    expect(Math.abs(head[1].y)).toBeGreaterThan(style.line / 2)
  })

  it("shrinks the head of an arrow shorter than it", () => {
    const { shaftEnd } = arrowGeometry({ x: 0, y: 0 }, { x: 0, y: 20 }, style)
    expect(20 - shaftEnd.y).toBeCloseTo(12)
  })
})

describe("badgeCenter", () => {
  const size = { width: 1000, height: 600 }
  const style = markupStyle(size)
  const reach = style.badge + style.halo

  // Off the mark, touching it: a badge is wider than the smallest mark a
  // person can draw, and one sitting on top would hide it.
  it("sits just off a box's corner and just behind an arrow's tail", () => {
    const corner = badgeCenter(box(200, 150, 12, 12), style, size)
    expect(corner.x).toBeLessThan(200)
    expect(corner.y).toBeLessThan(150)
    expect(Math.hypot(corner.x - 200, corner.y - 150)).toBeCloseTo(reach)

    const tail = badgeCenter(arrow(400, 300, 100, 100), style, size)
    expect(Math.hypot(tail.x - 400, tail.y - 300)).toBeCloseTo(reach)
    // On the far side of the tail from the head.
    const along = (tail.x - 400) * (100 - 400) + (tail.y - 300) * (100 - 300)
    expect(along).toBeLessThan(0)
  })

  it("is pulled inside the picture when the mark is on its edge", () => {
    expect(badgeCenter(box(0, 0, 50, 50), style, size)).toEqual({
      x: reach,
      y: reach,
    })
    expect(badgeCenter(arrow(1000, 600, 10, 10), style, size)).toEqual({
      x: 1000 - reach,
      y: 600 - reach,
    })
  })
})

describe("describeMarkup", () => {
  // A 1200×750 CSS px viewport delivered at 1600×1000: 0.75 CSS px a pixel.
  const capture = {
    width: 1600,
    height: 1000,
    region: { x: 0, y: 0, width: 1200, height: 750 },
  }

  it("says nothing when there is nothing drawn", () => {
    expect(describeMarkup([], capture)).toBe("")
  })

  it("numbers every mark and puts it on the page in CSS pixels", () => {
    const text = describeMarkup(
      [box(400, 200, 800, 100), arrow(100, 100, 1000, 600)],
      capture
    )
    expect(text).toBe(
      "- markup: the person drew 2 numbered marks on this screenshot, in red; the marks are not part of the page\n" +
        "  1. box: 600×75 CSS px at (300, 150)\n" +
        "  2. arrow: pointing at (750, 450) CSS px, from (75, 75)\n"
    )
  })

  it("counts one mark as one", () => {
    expect(describeMarkup([box(0, 0, 40, 40)], capture)).toContain(
      "the person drew 1 numbered mark on this screenshot"
    )
  })

  it("offsets by where a cropped picture sat in the viewport", () => {
    const cropped = {
      width: 200,
      height: 100,
      region: { x: 40, y: 500, width: 200, height: 100 },
    }
    expect(describeMarkup([box(10, 20, 30, 40)], cropped)).toContain(
      "1. box: 30×40 CSS px at (50, 520)"
    )
  })

  // A 400 CSS px viewport at three device pixels a CSS pixel: a picture
  // pixel is a third of a CSS pixel, and a box one picture pixel wide would
  // round to nothing.
  it("gives a box too thin for a CSS pixel a size of one", () => {
    const dense = {
      width: 1200,
      height: 1800,
      region: { x: 0, y: 0, width: 400, height: 600 },
    }
    expect(describeMarkup([box(300, 300, 1, 90)], dense)).toContain(
      "1. box: 1×30 CSS px at (100, 100)"
    )
  })
})

describe("withMarkup", () => {
  const capture = {
    width: 100,
    height: 100,
    region: { x: 0, y: 0, width: 100, height: 100 },
  }

  it("leaves the block alone when nothing was drawn", () => {
    expect(withMarkup("- screenshot: …\n", [], capture)).toBe(
      "- screenshot: …\n"
    )
  })

  it("adds the marks after the block, on their own lines", () => {
    const marks: MarkupMark[] = [box(10, 10, 20, 20)]
    expect(withMarkup("- screenshot: …\n", marks, capture)).toBe(
      `- screenshot: …\n${describeMarkup(marks, capture)}`
    )
    expect(withMarkup("- screenshot: …", marks, capture)).toBe(
      `- screenshot: …\n${describeMarkup(marks, capture)}`
    )
  })
})

describe("drawMarkup", () => {
  const size = { width: 800, height: 500 }
  const image = {} as CanvasImageSource

  it("paints the picture first, every white edge before any red, and the numbers last", () => {
    const ctx = recordingContext()
    drawMarkup(
      ctx as unknown as CanvasRenderingContext2D,
      image,
      [box(10, 10, 100, 50), arrow(400, 400, 200, 100)],
      size
    )
    const ops = ctx.calls.map((call) => call.op)
    expect(ctx.calls[0].op).toBe("clearRect")
    expect(ctx.calls[1]).toEqual({
      op: "drawImage",
      args: [image, 0, 0, 800, 500],
    })

    // Three white edges — the box, the arrow's shaft, its head — and only
    // then the two red strokes, so no edge cuts through a red line…
    const strokes = ctx.calls
      .filter((call) => call.op === "stroke")
      .map((call) => call.paint)
    const firstRed = strokes.indexOf(MARK_COLOR)
    expect(firstRed).toBe(3)
    expect(strokes.slice(firstRed)).toEqual([MARK_COLOR, MARK_COLOR])
    // …and the numbers are the last thing drawn, in order.
    const texts = ctx.calls
      .filter((call) => call.op === "fillText")
      .map((call) => call.args[0])
    expect(texts).toEqual(["1", "2"])
    expect(ops.lastIndexOf("stroke")).toBeLessThan(ops.indexOf("fillText"))
  })

  it("draws a box against the edge pulled in, so all of it shows", () => {
    const ctx = recordingContext()
    drawMarkup(
      ctx as unknown as CanvasRenderingContext2D,
      image,
      [box(0, 0, 100, 50)],
      size
    )
    const style = markupStyle(size)
    const edge = style.line / 2 + style.halo
    const rects = ctx.calls.filter((call) => call.op === "rect")
    expect(rects[0].args[0]).toBeCloseTo(edge)
    expect(rects[0].args[1]).toBeCloseTo(edge)
  })

  it("fills an arrow's head and outlines a box", () => {
    const ctx = recordingContext()
    drawMarkup(
      ctx as unknown as CanvasRenderingContext2D,
      image,
      [box(10, 10, 100, 50)],
      size
    )
    expect(ctx.calls.filter((call) => call.op === "rect")).toHaveLength(2)
    const redFills = (c: ReturnType<typeof recordingContext>) =>
      c.calls.filter((call) => call.op === "fill" && call.paint === MARK_COLOR)
    // A box has no red fill but its badge.
    expect(redFills(ctx)).toHaveLength(1)

    const withArrow = recordingContext()
    drawMarkup(
      withArrow as unknown as CanvasRenderingContext2D,
      image,
      [arrow(10, 10, 300, 200)],
      size
    )
    // The head, then the badge.
    expect(redFills(withArrow)).toHaveLength(2)
  })
})

describe("renderMarkedScreenshot", () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  function stubCanvas(sizes: Record<string, number | null>) {
    const ctx = recordingContext()
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
      () => ctx as unknown as CanvasRenderingContext2D
    )
    const encodings: Array<{ type: string; quality?: number }> = []
    vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(
      function (callback, type = "image/png", quality) {
        encodings.push({ type, quality })
        const bytes = sizes[type]
        callback(
          bytes === null || bytes === undefined
            ? null
            : new Blob([new Uint8Array(bytes)], { type })
        )
      }
    )
    return { ctx, encodings }
  }

  it("draws at the picture's own size and sends it as PNG", async () => {
    const { ctx, encodings } = stubCanvas({ "image/png": 1000 })
    const blob = await renderMarkedScreenshot(
      {} as CanvasImageSource,
      [box(10, 10, 50, 50)],
      { width: 640, height: 400 }
    )
    expect(blob.type).toBe("image/png")
    expect(encodings).toEqual([{ type: "image/png", quality: undefined }])
    expect(ctx.calls.find((call) => call.op === "drawImage")?.args).toEqual([
      {},
      0,
      0,
      640,
      400,
    ])
  })

  it("falls back to JPEG when the PNG is heavier than a model takes", async () => {
    const { encodings } = stubCanvas({
      "image/png": MARKED_IMAGE_MAX_BYTES + 1,
      "image/jpeg": 1000,
    })
    const blob = await renderMarkedScreenshot(
      {} as CanvasImageSource,
      [box(10, 10, 50, 50)],
      { width: 640, height: 400 }
    )
    expect(blob.type).toBe("image/jpeg")
    expect(encodings).toEqual([
      { type: "image/png", quality: undefined },
      { type: "image/jpeg", quality: 0.85 },
    ])
  })

  it("fails rather than sending nothing when the canvas cannot encode", async () => {
    stubCanvas({ "image/png": null })
    await expect(
      renderMarkedScreenshot({} as CanvasImageSource, [], {
        width: 10,
        height: 10,
      })
    ).rejects.toThrow("could not be encoded")
  })

  it("fails when there is no 2D context to draw with", async () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
      () => null
    )
    await expect(
      renderMarkedScreenshot({} as CanvasImageSource, [], {
        width: 10,
        height: 10,
      })
    ).rejects.toThrow("could not be drawn on")
  })
})

describe("visibleBox", () => {
  const size = { width: 800, height: 500 }
  const style = markupStyle(size)
  const edge = style.line / 2 + style.halo

  it("draws a box inside the picture exactly where it is", () => {
    expect(visibleBox(box(100, 100, 200, 50), style, size)).toEqual({
      x: 100,
      y: 100,
      width: 200,
      height: 50,
    })
  })

  it("pulls a side along the edge in until its whole stroke shows", () => {
    const drawn = visibleBox(box(0, 300, 800, 200), style, size)
    expect(drawn.x).toBeCloseTo(edge)
    expect(drawn.y).toBe(300)
    expect(drawn.x + drawn.width).toBeCloseTo(800 - edge)
    expect(drawn.y + drawn.height).toBeCloseTo(500 - edge)
  })

  it("leaves a box too small to pull in as it is", () => {
    expect(visibleBox(box(799, 499, 1, 1), style, size)).toEqual({
      x: 799,
      y: 499,
      width: 1,
      height: 1,
    })
  })
})
