import { useRef, type ReactNode } from "react"
import { render } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { ReplyMotion } from "./reply-motion"

/**
 * jsdom lays nothing out: each element says where it is drawn (`data-x`,
 * `data-y`, from the page's corner), and `animate` records what was played.
 */
type Played = { element: Element; keyframes: Keyframe[] }
let played: Played[] = []
/** Draw a glide at its first frame: where it starts takes the element, and
 *  everything inside it, off its own place (`data-shift`). */
let drawGlides = false

const shiftOf = (element: Element) => {
  let x = 0
  let y = 0
  for (let at: Element | null = element; at; at = at.parentElement) {
    const [sx, sy] = (at.getAttribute("data-shift") ?? "0,0")
      .split(",")
      .map(Number)
    x += sx!
    y += sy!
  }
  return { x, y }
}

beforeEach(() => {
  played = []
  drawGlides = false
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
    function (this: Element) {
      const shift = shiftOf(this)
      const x = Number(this.getAttribute("data-x") ?? 0) + shift.x
      const y = Number(this.getAttribute("data-y") ?? 0) + shift.y
      const hidden = this.hasAttribute("data-hidden")
      return {
        x,
        y,
        left: x,
        top: y,
        right: x + (hidden ? 0 : 100),
        bottom: y + (hidden ? 0 : 20),
        width: hidden ? 0 : 100,
        height: hidden ? 0 : 20,
        toJSON: () => ({}),
      } as DOMRect
    }
  )
  Element.prototype.animate = vi.fn(function (
    this: Element,
    keyframes: Keyframe[] | PropertyIndexedKeyframes | null
  ) {
    played.push({ element: this, keyframes: keyframes as Keyframe[] })
    const from = /translate\((-?[\d.]+)px, (-?[\d.]+)px\)/.exec(
      String((keyframes as Keyframe[])[0]?.transform ?? "")
    )
    if (drawGlides && from)
      this.setAttribute("data-shift", `${from[1]},${from[2]}`)
    return {
      cancel: vi.fn(),
      addEventListener: vi.fn(),
    } as unknown as Animation
  }) as unknown as Element["animate"]
})

afterEach(() => {
  vi.restoreAllMocks()
  delete (Element.prototype as Partial<Element>).animate
  document.documentElement.removeAttribute("data-chat-animations")
})

function Reply({
  shape,
  live = true,
  open = true,
  handoff,
  children,
}: {
  shape: string
  live?: boolean
  open?: boolean
  handoff?: "give" | "take"
  children: ReactNode
}) {
  const ref = useRef<HTMLDivElement>(null)
  return (
    <ReplyMotion
      shape={shape}
      live={live}
      open={open}
      rootRef={ref}
      handoff={handoff}
    >
      <div ref={ref} data-x="0" data-y="0">
        {children}
      </div>
    </ReplyMotion>
  )
}

const glidesOf = (key: string) =>
  played
    .filter((p) => p.element.getAttribute("data-motion-key") === key)
    .map((p) => p.keyframes[0]!.transform)

describe("ReplyMotion", () => {
  it("glides a thing from where it was to where the new shape puts it", () => {
    const view = render(
      <Reply shape="a">
        <div data-motion-key="working" data-x="0" data-y="100" />
      </Reply>
    )
    view.rerender(
      <Reply shape="b">
        <div data-motion-key="working" data-x="0" data-y="140" />
      </Reply>
    )
    expect(glidesOf("working")).toEqual(["translate(0px, -40px)"])
    expect(played[0]!.keyframes[1]!.transform).toBe("none")
  })

  it("matches the same key on another element: the prose leaving the rail", () => {
    const view = render(
      <Reply shape="rail">
        <ol>
          <li>
            <div data-motion-key="prose:5" data-x="32" data-y="200" />
          </li>
        </ol>
      </Reply>
    )
    view.rerender(
      <Reply shape="answer">
        <ol />
        <div data-motion-key="prose:5" data-x="0" data-y="242" />
      </Reply>
    )
    expect(glidesOf("prose:5")).toEqual(["translate(32px, -42px)"])
  })

  it("fades in what is new", () => {
    const view = render(
      <Reply shape="a">
        <div data-motion-key="header" data-y="0" />
      </Reply>
    )
    view.rerender(
      <Reply shape="b">
        <div data-motion-key="header" data-y="0" />
        <div data-motion-key="tool:1" data-y="40" />
      </Reply>
    )
    expect(played).toHaveLength(1)
    expect(played[0]!.element.getAttribute("data-motion-key")).toBe("tool:1")
    expect(played[0]!.keyframes[0]!.opacity).toBe(0)
    expect(played[0]!.keyframes[1]!.opacity).toBe(1)
  })

  it("leaves alone a new thing that sees to its own arrival", () => {
    const view = render(<Reply shape="a">{null}</Reply>)
    view.rerender(
      <Reply shape="b">
        <div data-motion-key="thought:1" data-motion-self="" data-y="40" />
      </Reply>
    )
    expect(played).toHaveLength(0)
  })

  it("does not fade a new group in over the command it takes in", () => {
    // The command glides into the group; fading the group in would blink it
    // out first.
    const view = render(
      <Reply shape="one">
        <div data-motion-key="tool:1" data-x="0" data-y="40" />
      </Reply>
    )
    view.rerender(
      <Reply shape="group">
        <div data-motion-key="group:tool:1" data-x="0" data-y="40">
          <div data-motion-key="tool:1" data-x="32" data-y="76" />
          <div data-motion-key="tool:2" data-x="32" data-y="112" />
        </div>
      </Reply>
    )
    expect(glidesOf("group:tool:1")).toEqual([])
    expect(glidesOf("tool:1")).toEqual(["translate(-32px, -36px)"])
    expect(glidesOf("tool:2")).toEqual(["translateY(4px)"])
  })

  it("fades a new group's header in while the command it took in glides out from under it", () => {
    const view = render(
      <Reply shape="one">
        <div data-motion-key="tool:1" data-y="40">
          <div data-motion-key="tool:1:head" data-y="40" />
        </div>
      </Reply>
    )
    view.rerender(
      <Reply shape="group">
        <div data-motion-key="group:tool:1" data-y="40">
          <div data-motion-key="group:tool:1:head" data-y="40" />
          <div data-motion-key="tool:1" data-x="32" data-y="76">
            <div data-motion-key="tool:1:head" data-x="32" data-y="76" />
          </div>
        </div>
      </Reply>
    )
    expect(glidesOf("group:tool:1")).toEqual([])
    expect(glidesOf("group:tool:1:head")).toEqual(["translateY(4px)"])
    expect(glidesOf("tool:1")).toEqual(["translate(-32px, -36px)"])
    // Carried by its row.
    expect(glidesOf("tool:1:head")).toEqual([])
  })

  it("fades a new row in once, not again inside it", () => {
    const view = render(<Reply shape="a">{null}</Reply>)
    view.rerender(
      <Reply shape="b">
        <div data-motion-key="tool:1" data-y="40">
          <div data-motion-key="tool:1:head" data-y="40" />
        </div>
      </Reply>
    )
    expect(glidesOf("tool:1")).toEqual(["translateY(4px)"])
    expect(glidesOf("tool:1:head")).toEqual([])
  })

  it("reads every position before anything glides", () => {
    // A glide is drawn from its start at once: a row read after its group
    // began gliding would be read where the glide draws it, and its header
    // sent back against the glide carrying it.
    drawGlides = true
    const view = render(
      <Reply shape="one">
        <div data-motion-key="tool:1" data-y="40">
          <div data-motion-key="tool:1:head" data-y="40" />
        </div>
      </Reply>
    )
    view.rerender(
      <Reply shape="group">
        <div data-motion-key="group:tool:1" data-y="40">
          <div data-motion-key="tool:1" data-x="32" data-y="76">
            <div data-motion-key="tool:1:head" data-x="32" data-y="76" />
          </div>
        </div>
      </Reply>
    )
    expect(glidesOf("tool:1")).toEqual(["translate(-32px, -36px)"])
    expect(glidesOf("tool:1:head")).toEqual([])
  })

  it("moves a thing inside a gliding one only by its own share", () => {
    const view = render(
      <Reply shape="a">
        <div data-motion-key="row" data-y="100">
          <div data-motion-key="inner" data-y="120" />
        </div>
      </Reply>
    )
    view.rerender(
      <Reply shape="b">
        <div data-motion-key="row" data-y="150">
          <div data-motion-key="inner" data-y="180" />
        </div>
      </Reply>
    )
    // The row carries the inner one 50px; the other 10px are its own.
    expect(glidesOf("row")).toEqual(["translate(0px, -50px)"])
    expect(glidesOf("inner")).toEqual(["translate(0px, -10px)"])
  })

  it("plays nothing while the shape holds (the words of the prose being written)", () => {
    const view = render(
      <Reply shape="a">
        <div data-motion-key="working" data-y="100" />
      </Reply>
    )
    view.rerender(
      <Reply shape="a">
        <div data-motion-key="working" data-y="120" />
      </Reply>
    )
    expect(played).toHaveLength(0)
  })

  it("plays nothing in history, nor on a fold by hand", () => {
    const view = render(
      <Reply shape="a" live={false}>
        <div data-motion-key="working" data-y="100" />
      </Reply>
    )
    view.rerender(
      <Reply shape="b" live={false}>
        <div data-motion-key="working" data-y="140" />
      </Reply>
    )
    view.rerender(
      <Reply shape="c" open={false}>
        <div data-motion-key="working" data-y="40" />
      </Reply>
    )
    expect(played).toHaveLength(0)
  })

  it("plays the change that ends the reply", () => {
    const view = render(
      <Reply shape="live">
        <div data-motion-key="prose:3" data-x="32" data-y="100" />
      </Reply>
    )
    view.rerender(
      <Reply shape="done" live={false}>
        <div data-motion-key="prose:3" data-x="0" data-y="142" />
      </Reply>
    )
    expect(glidesOf("prose:3")).toEqual(["translate(32px, -42px)"])
  })

  it("plays nothing with chat animations off, or with reduced motion", () => {
    document.documentElement.setAttribute("data-chat-animations", "off")
    const view = render(
      <Reply shape="a">
        <div data-motion-key="working" data-y="100" />
      </Reply>
    )
    view.rerender(
      <Reply shape="b">
        <div data-motion-key="working" data-y="140" />
      </Reply>
    )
    expect(played).toHaveLength(0)

    document.documentElement.removeAttribute("data-chat-animations")
    const matchMedia = vi
      .spyOn(window, "matchMedia")
      .mockImplementation(
        (query) => ({ matches: query.includes("reduce") }) as MediaQueryList
      )
    view.rerender(
      <Reply shape="c">
        <div data-motion-key="working" data-y="180" />
      </Reply>
    )
    expect(played).toHaveLength(0)
    matchMedia.mockRestore()
  })

  it("starts the reply from the layout the pending reply left in its place", () => {
    const scope = document.createElement("div")
    scope.className = "chat-motion-scope"
    document.body.append(scope)
    try {
      const view = render(
        <Reply shape="pending" handoff="give">
          <div data-motion-key="header" data-y="0" />
          <div data-motion-key="working" data-y="44" />
        </Reply>,
        { container: scope }
      )
      view.rerender(
        <Reply shape="reply" key="the-reply" handoff="take">
          <div data-motion-key="header" data-y="0" />
          <div data-motion-key="prose:0" data-y="44" />
          <div data-motion-key="working" data-y="80" />
        </Reply>
      )
      expect(glidesOf("header")).toEqual([])
      expect(glidesOf("working")).toEqual(["translate(0px, -36px)"])
      expect(glidesOf("prose:0")).toEqual(["translateY(4px)"])

      // Taken once: a later reply starts as it stands.
      played = []
      view.rerender(
        <Reply shape="reply" key="another" handoff="take">
          <div data-motion-key="working" data-y="200" />
        </Reply>
      )
      expect(played).toHaveLength(0)
    } finally {
      scope.remove()
    }
  })
})
