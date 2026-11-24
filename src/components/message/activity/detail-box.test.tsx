import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import postcss from "postcss"
import { act, fireEvent, render } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { DetailBox, DetailScroll } from "./detail-box"

// The real OverlayScrollbars: its setup is deferred into an idle callback and
// then an animation frame, queued here and flushed by the test; it measures
// only an element with a size, and jsdom lays nothing out.
const deferred = new Map<number, () => void>()
let nextHandle = 0
function flushDeferred() {
  for (let round = 0; round < 2; round++) {
    act(() => {
      for (const [handle, callback] of [...deferred]) {
        deferred.delete(handle)
        callback()
      }
    })
  }
}

beforeEach(() => {
  const queue = (callback: () => void) => {
    deferred.set(++nextHandle, callback)
    return nextHandle
  }
  const cancel = (handle: number) => deferred.delete(handle)
  vi.stubGlobal("requestIdleCallback", queue)
  vi.stubGlobal("cancelIdleCallback", cancel)
  vi.stubGlobal("requestAnimationFrame", queue)
  vi.stubGlobal("cancelAnimationFrame", cancel)
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(200)
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(200)
})

afterEach(() => {
  deferred.clear()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

/** The viewports under `root`, outermost first. */
const viewportsIn = (root: ParentNode) =>
  [
    ...root.querySelectorAll("[data-overlayscrollbars-viewport]"),
  ] as HTMLElement[]

/** A viewport `height` tall over `content` of content (jsdom keeps no scroll
 *  offsets of its own). */
function sized(viewport: HTMLElement, height: number, content: number) {
  Object.defineProperty(viewport, "clientHeight", { value: height })
  Object.defineProperty(viewport, "scrollHeight", { value: content })
  Object.defineProperty(viewport, "scrollTop", { value: 0, writable: true })
}

describe("DetailBox", () => {
  it("keeps a box anchored at its end on its last line until the reader scrolls up", () => {
    const lines = (count: number) =>
      Array.from({ length: count }, (_, index) => <p key={index}>{index}</p>)
    const { container, rerender } = render(
      <DetailBox anchor="end">{lines(1)}</DetailBox>
    )
    flushDeferred()
    const [viewport] = viewportsIn(container)
    sized(viewport!, 100, 500)
    rerender(<DetailBox anchor="end">{lines(2)}</DetailBox>)
    expect(viewport!.scrollTop).toBe(500)

    // Scrolled up, it stays where the reader left it as more arrives.
    viewport!.scrollTop = 120
    fireEvent.scroll(viewport!)
    rerender(<DetailBox anchor="end">{lines(3)}</DetailBox>)
    expect(viewport!.scrollTop).toBe(120)
  })

  it("leaves a box anchored at its start where it opened", () => {
    const { container, rerender } = render(<DetailBox>one</DetailBox>)
    flushDeferred()
    const [viewport] = viewportsIn(container)
    sized(viewport!, 100, 500)
    rerender(<DetailBox>two</DetailBox>)
    expect(viewport!.scrollTop).toBe(0)
  })

  it("follows its end and re-marks its edges when it or its content changes size", () => {
    // Content can grow with no render of the box (an image, a font): the
    // box observes its viewport and what is in it.
    const observers: {
      notify: () => void
      targets: Element[]
      disconnected: boolean
    }[] = []
    vi.stubGlobal(
      "ResizeObserver",
      class {
        entry: (typeof observers)[number]
        constructor(notify: () => void) {
          this.entry = { notify, targets: [], disconnected: false }
          observers.push(this.entry)
        }
        observe(target: Element) {
          this.entry.targets.push(target)
        }
        unobserve() {}
        disconnect() {
          this.entry.disconnected = true
        }
      }
    )
    const { container, unmount } = render(
      <DetailBox anchor="end">
        <p>one</p>
      </DetailBox>
    )
    flushDeferred()
    const [viewport] = viewportsIn(container)
    const own = observers.find((observer) =>
      observer.targets.includes(viewport!)
    )!
    expect(own.targets).toEqual([viewport, viewport!.firstElementChild])

    sized(viewport!, 100, 500)
    own.notify()
    expect(viewport!.scrollTop).toBe(500)
    expect(viewport!.dataset.overflow).toBe("start")

    unmount()
    expect(own.disconnected).toBe(true)
  })

  it("marks which edge of its body has more beyond it, for the fade", () => {
    const { container } = render(<DetailBox>one</DetailBox>)
    flushDeferred()
    const [viewport] = viewportsIn(container)
    expect(viewport).toHaveClass("activity-detail-viewport")
    sized(viewport!, 100, 500)
    fireEvent.scroll(viewport!)
    expect(viewport!.dataset.overflow).toBe("end")
    viewport!.scrollTop = 200
    fireEvent.scroll(viewport!)
    expect(viewport!.dataset.overflow).toBe("both")
    viewport!.scrollTop = 400
    fireEvent.scroll(viewport!)
    expect(viewport!.dataset.overflow).toBe("start")
  })
})

describe("DetailBox over a workspace background image", () => {
  const stylesheet = postcss.parse(
    readFileSync(resolve(process.cwd(), "src/app/globals.css"), "utf8")
  )
  /** The declarations of the top-level rules written with `selector`. */
  function declarations(selector: string): Record<string, string> {
    const found: Record<string, string> = {}
    stylesheet.each((node) => {
      if (node.type !== "rule" || node.selector !== selector) return
      node.walkDecls((decl) => {
        found[decl.prop] = decl.value
      })
    })
    return found
  }

  it("draws every tone's panel inside a hairline", () => {
    for (const tone of ["neutral", "danger", "plain"] as const) {
      const { container, unmount } = render(
        <DetailBox tone={tone}>body</DetailBox>
      )
      const box = container.firstElementChild
      expect(box).toHaveClass("activity-detail-box", "ws-msg-panel")
      expect(box).toHaveAttribute("data-tone", tone)
      unmount()
    }
    // Off the image a neutral or failed panel is a plain tint with no frame;
    // on it, the tint is translucent and the hairline is what sets it apart.
    expect(declarations('[data-workspace-bg="on"] .ws-msg-panel').border).toBe(
      "1px solid var(--ws-msg-panel-border, var(--border))"
    )
  })

  it("turns a failed panel translucent and its hairline red, through custom properties alone", () => {
    const danger = declarations(
      '[data-workspace-bg="on"] .ws-msg-panel[data-tone="danger"]'
    )
    // A colour-mix written straight into `background-color` gets a build
    // fallback of its first colour ahead of it — the solid failure red, which
    // an engine without colour-mix keeps, painting the whole panel. Of a
    // custom property's two declarations the later always wins, fallback or
    // not: there the panel keeps its own fill.
    expect(Object.keys(danger).sort()).toEqual([
      "--tone-danger-surface",
      "--ws-msg-panel-border",
    ])
    expect(danger["--tone-danger-surface"]).toContain("var(--destructive)")
    expect(danger["--tone-danger-surface"]).toContain("var(--ws-msg-alpha)")
    expect(danger["--ws-msg-panel-border"]).toContain("var(--tone-danger)")
  })
})

describe("DetailScroll", () => {
  it("fades its own body and hands its viewport and scrolls on", () => {
    const onViewportRef = vi.fn()
    const onScroll = vi.fn()
    const { container } = render(
      <DetailBox unbounded>
        <DetailScroll onViewportRef={onViewportRef} onScroll={onScroll}>
          one
        </DetailScroll>
      </DetailBox>
    )
    flushDeferred()
    const [box, own] = viewportsIn(container)
    expect(own).toBeTruthy()
    expect(onViewportRef).toHaveBeenLastCalledWith(own)
    // Capped, and scrolling both ways: the box around it does neither.
    expect(own!.parentElement!.className.split(/\s+/)).toContain("max-h-72")
    expect(box!.parentElement!.className.split(/\s+/)).not.toContain("max-h-72")
    expect(own).toHaveClass("activity-detail-viewport")
    sized(own!, 100, 300)
    fireEvent.scroll(own!)
    expect(onScroll).toHaveBeenCalled()
    expect(own!.dataset.overflow).toBe("end")
  })

  it("keeps to an end anchor as the box's body does", () => {
    // The output under a script: on its last line until the reader scrolls
    // up, while the box around it does not scroll at all.
    const body = (count: number) => (
      <DetailBox unbounded>
        <DetailScroll anchor="end">
          {Array.from({ length: count }, (_, index) => (
            <p key={index}>{index}</p>
          ))}
        </DetailScroll>
      </DetailBox>
    )
    const { container, rerender } = render(body(1))
    flushDeferred()
    const [, own] = viewportsIn(container)
    sized(own!, 100, 500)
    rerender(body(2))
    expect(own!.scrollTop).toBe(500)

    own!.scrollTop = 120
    fireEvent.scroll(own!)
    rerender(body(3))
    expect(own!.scrollTop).toBe(120)
  })
})
