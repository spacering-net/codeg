import { act, cleanup, render } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const motion = vi.hoisted(() => ({ reduced: false }))
vi.mock("@/hooks/use-chat-motion", () => ({
  useReducedMotion: () => motion.reduced,
}))

import { syncedDelay } from "@/lib/motion/synced-spin"
import type { BotAvatar as BotAvatarValue } from "@/lib/types"

import { BotAvatar } from "./bot-avatar"
import {
  __activeFacesForTests,
  __resetFaceMotionForTests,
} from "./bot-face-motion"

const face: BotAvatarValue = { kind: "face", shape: "ring", color: "teal" }

function root(container: HTMLElement): HTMLElement {
  return container.querySelector("[data-slot='bot-avatar']") as HTMLElement
}

/** The group its drawing is in. */
function art(el: Element): SVGGElement {
  return el.querySelector(".pa-face-art") as SVGGElement
}

beforeEach(() => {
  motion.reduced = false
  vi.useFakeTimers()
  __resetFaceMotionForTests()
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe("an assistant's face", () => {
  it("says who and how it is, and wears its dot", () => {
    const { container } = render(
      <BotAvatar
        avatar={face}
        name="Dev"
        size={28}
        look="working"
        dot="waiting"
        label="Dev, working"
      />
    )
    const el = root(container)
    expect(el.getAttribute("role")).toBe("img")
    expect(el.getAttribute("aria-label")).toBe("Dev, working")
    expect(el.getAttribute("data-bot-look")).toBe("working")
    const dot = el.querySelector("[data-bot-dot]") as HTMLElement
    expect(dot.getAttribute("data-bot-dot")).toBe("waiting")
    expect(dot.className).toContain("bg-orange-500")
    expect(dot.className).toContain("-bottom-0.5")
  })

  it("puts the dot at the top on the primary, its star at the foot", () => {
    const { container } = render(
      <BotAvatar avatar={face} name="Nova" size={56} star dot="unread" />
    )
    const dot = root(container).querySelector("[data-bot-dot]") as HTMLElement
    expect(dot.className).toContain("-top-0.5")
    expect(dot.className).toContain("bg-blue-500")
  })

  it("comes to a new look through a blink", () => {
    const { container, rerender } = render(
      <BotAvatar avatar={face} name="Dev" size={28} look="thinking" />
    )
    rerender(<BotAvatar avatar={face} name="Dev" size={28} look="done" />)
    const el = root(container)
    expect(el.hasAttribute("data-blink")).toBe(true)
    expect(el.getAttribute("data-bot-look")).toBe("thinking")
    act(() => vi.advanceTimersByTime(90))
    expect(el.getAttribute("data-bot-look")).toBe("done")
    expect(el.hasAttribute("data-blink")).toBe(true)
    act(() => vi.advanceTimersByTime(120))
    expect(el.hasAttribute("data-blink")).toBe(false)
  })

  it("blinks and glances at rest, now and then", () => {
    // A blink, then a glance up.
    const rolls = [0, 0.9, 0.9, 0, 0, 0, 0]
    vi.spyOn(Math, "random").mockImplementation(() => rolls.shift() ?? 0.9)
    const { container } = render(
      <BotAvatar avatar={face} name="Dev" size={28} look="idle" />
    )
    const el = root(container)
    act(() => vi.advanceTimersByTime(2799))
    expect(el.hasAttribute("data-blink")).toBe(false)
    act(() => vi.advanceTimersByTime(1))
    expect(el.hasAttribute("data-blink")).toBe(true)
    act(() => vi.advanceTimersByTime(120))
    expect(el.hasAttribute("data-blink")).toBe(false)
    const still = art(el).innerHTML
    act(() => vi.advanceTimersByTime(2800))
    expect(el.getAttribute("data-glance")).toBe("left")
    // Its eyes moved, over its drawing at rest.
    act(() => vi.advanceTimersByTime(300))
    expect(art(el).innerHTML).not.toBe(still)
    expect(art(el).innerHTML.startsWith("<use ")).toBe(true)
    act(() => vi.advanceTimersByTime(200))
    expect(el.hasAttribute("data-glance")).toBe(false)
    act(() => vi.advanceTimersByTime(1000))
    expect(art(el).innerHTML).toBe(still)
  })

  it("stays still when given no look, and under reduced motion", () => {
    const { container, rerender } = render(
      <BotAvatar avatar={face} name="Dev" size={28} />
    )
    act(() => vi.advanceTimersByTime(20_000))
    expect(root(container).hasAttribute("data-blink")).toBe(false)
    expect(root(container).hasAttribute("data-bot-look")).toBe(false)
    motion.reduced = true
    rerender(<BotAvatar avatar={face} name="Dev" size={28} look="idle" />)
    rerender(<BotAvatar avatar={face} name="Dev" size={28} look="working" />)
    expect(root(container).getAttribute("data-bot-look")).toBe("working")
    expect(root(container).hasAttribute("data-blink")).toBe(false)
    act(() => vi.advanceTimersByTime(20_000))
    expect(root(container).hasAttribute("data-blink")).toBe(false)
  })

  it("sleeps with z z z over it, but not when too small to read", () => {
    const { container, rerender } = render(
      <BotAvatar avatar={face} name="Dev" size={28} look="sleeping" />
    )
    expect(container.querySelectorAll(".pa-face-z")).toHaveLength(3)
    rerender(<BotAvatar avatar={face} name="Dev" size={16} look="sleeping" />)
    expect(container.querySelectorAll(".pa-face-z")).toHaveLength(0)
  })

  // WebKit cuts an animated SVG off at its own edges on screen: its box has
  // room round the face on every side, the face drawn where it always was,
  // and set inline so an icon rule of a parent (a card head's
  // `[&_svg]:size-3.5`) cannot shrink it.
  it("draws in a box with room round it, laid over the face as it sits", () => {
    const { container } = render(
      <BotAvatar avatar={face} name="Dev" size={28} look="idle" />
    )
    const svg = root(container).querySelector("svg")!
    expect(svg.getAttribute("viewBox")).toBe("-60 -60 220 220")
    expect(svg.style.left).toBe("-60%")
    expect(svg.style.top).toBe("-60%")
    expect(svg.style.width).toBe("220%")
    expect(svg.style.height).toBe("220%")
    expect(svg.getAttribute("class")).toContain("pointer-events-none")
  })

  it("draws each look's eyes", () => {
    for (const look of [
      "idle",
      "thinking",
      "working",
      "waiting",
      "stuck",
      "done",
      "failed",
      "sleeping",
    ] as const) {
      motion.reduced = true
      const { container, unmount } = render(
        <BotAvatar avatar={face} name="Dev" size={28} look={look} />
      )
      const lids = container.querySelector(".pa-face-lids") as SVGGElement
      expect(lids.children.length, look).toBe(2)
      unmount()
    }
  })
})

/** jsdom lays nothing out: the face's box, as a browser would have it. */
function boxed(el: Element, left = 100, top = 100, size = 28) {
  ;(el as HTMLElement).getBoundingClientRect = () =>
    ({
      left,
      top,
      x: left,
      y: top,
      width: size,
      height: size,
      right: left + size,
      bottom: top + size,
      toJSON: () => ({}),
    }) as DOMRect
}

/** A pointer event (jsdom has no PointerEvent: a MouseEvent of its type,
 *  its pointer's kind added). */
function pointer(
  type: "pointerenter" | "pointermove" | "pointerleave",
  target: Element,
  clientX = 0,
  clientY = 0,
  pointerType = "mouse"
) {
  const event = new MouseEvent(type, {
    bubbles: type === "pointermove",
    clientX,
    clientY,
  })
  Object.defineProperty(event, "pointerType", { value: pointerType })
  act(() => {
    target.dispatchEvent(event)
  })
}

/** `n` frames go by. */
function frames(n: number) {
  for (let i = 0; i < n; i++) act(() => vi.advanceTimersByTime(17))
}

describe("the pointer over a face", () => {
  it("perks it up each time it comes, turning it toward it while it stays", () => {
    const { container } = render(
      <BotAvatar avatar={face} name="Dev" size={28} look="idle" />
    )
    const el = root(container)
    const still = art(el).innerHTML
    boxed(el)
    expect(el.hasAttribute("data-perk")).toBe(false)
    // In over its right edge: a perk, and it turns that way — drawn whole.
    pointer("pointerenter", el, 128, 114)
    frames(10)
    expect(el.getAttribute("data-perk")).toBe("a")
    expect(el.hasAttribute("data-hover")).toBe(true)
    const right = art(el).innerHTML
    expect(right.startsWith("<use ")).toBe(false)
    // Off to the top left: it turns again.
    pointer("pointermove", el, 0, 0)
    frames(10)
    expect(art(el).innerHTML).not.toBe(right)
    // Gone: it settles back to its rest, the page's drawing again.
    pointer("pointerleave", el)
    expect(el.hasAttribute("data-hover")).toBe(false)
    frames(120)
    expect(art(el).innerHTML).toBe(still)
    expect(__activeFacesForTests()).toBe(0)
    // Back again: the perk again, under its other name so it plays.
    pointer("pointerenter", el, 114, 128)
    frames(2)
    expect(el.getAttribute("data-perk")).toBe("b")
  })

  it("notices it over the row it is the face of", () => {
    const { container } = render(
      <button type="button" data-pa-face-host>
        <BotAvatar avatar={face} name="Dev" size={28} look="idle" />
        Dev
      </button>
    )
    const row = container.querySelector("button")!
    const el = root(container)
    const still = art(el).innerHTML
    boxed(el)
    // At the row's far end: it turns that way.
    pointer("pointerenter", row, 300, 114)
    frames(10)
    expect(el.getAttribute("data-perk")).toBe("a")
    expect(art(el).innerHTML).not.toBe(still)
    pointer("pointerleave", row)
    expect(el.hasAttribute("data-hover")).toBe(false)
  })

  it("wakes it up when asleep, and lets it sleep again once it leaves", () => {
    const { container } = render(
      <BotAvatar avatar={face} name="Dev" size={28} look="sleeping" />
    )
    const el = root(container)
    boxed(el)
    pointer("pointerenter", el, 128, 114)
    // Its eyes open through a blink, then it turns to the pointer.
    expect(el.hasAttribute("data-blink")).toBe(true)
    act(() => vi.advanceTimersByTime(90))
    expect(el.getAttribute("data-bot-look")).toBe("idle")
    expect(el.querySelectorAll(".pa-face-z")).toHaveLength(0)
    frames(10)
    expect(el.hasAttribute("data-hover")).toBe(true)
    pointer("pointerleave", el)
    act(() => vi.advanceTimersByTime(90))
    expect(el.getAttribute("data-bot-look")).toBe("sleeping")
  })

  it("is not noticed by a face that is still, under reduced motion, or as a touch", () => {
    // Still: no look given.
    const { container, rerender } = render(
      <BotAvatar avatar={face} name="Dev" size={28} />
    )
    boxed(root(container))
    pointer("pointerenter", root(container), 128, 114)
    frames(2)
    expect(root(container).hasAttribute("data-perk")).toBe(false)
    expect(root(container).hasAttribute("data-hover")).toBe(false)
    // A touch.
    rerender(<BotAvatar avatar={face} name="Dev" size={28} look="idle" />)
    pointer("pointerenter", root(container), 128, 114, "touch")
    frames(2)
    expect(root(container).hasAttribute("data-perk")).toBe(false)
    // Reduced motion.
    motion.reduced = true
    rerender(<BotAvatar avatar={face} name="Dev" size={28} look="waiting" />)
    pointer("pointerenter", root(container), 128, 114)
    frames(2)
    expect(root(container).hasAttribute("data-perk")).toBe(false)
    expect(root(container).hasAttribute("data-hover")).toBe(false)
  })

  it("keeps its eyes in the ring's hole: at rest the page's, turned its own", () => {
    const { container } = render(
      <>
        <BotAvatar avatar={face} name="Dev" size={48} look="idle" />
        <BotAvatar avatar={face} name="Ops" size={48} look="idle" />
      </>
    )
    const faces = [
      ...container.querySelectorAll<HTMLElement>("[data-slot='bot-avatar']"),
    ]
    // At rest: both use the page's drawing, their eyes seen through its hole.
    const def = "pa-face-def-ring-idle-f"
    for (const f of faces) {
      expect(f.querySelector("use")!.getAttribute("href")).toBe(`#${def}`)
      const eyes = f.querySelector(".pa-face-lids")!
      expect(eyes.closest("[clip-path]")!.getAttribute("clip-path")).toBe(
        `url(#${def}-h)`
      )
    }
    expect(document.getElementById(def)).not.toBeNull()
    expect(document.getElementById(`${def}-h`)!.tagName).toBe("clipPath")
    // Turned: each its own drawing, its own clips.
    const ids = faces.map((f) => {
      boxed(f)
      pointer("pointerenter", f, 300, 100)
      frames(6)
      const hole = [...f.querySelectorAll("clipPath")].find((c) =>
        c.id.endsWith("-h")
      )!
      const eyes = f.querySelector(".pa-face-lids")!
      expect(eyes.closest("[clip-path]")!.getAttribute("clip-path")).toBe(
        `url(#${hole.id})`
      )
      return hole.id
    })
    expect(new Set(ids).size).toBe(2)
    for (const id of ids) expect(id).toMatch(/^pa-face-[\w-]+-h$/)
    expect(ids).not.toContain(`${def}-h`)
  })
})

describe("what moves a face", () => {
  it("draws it only while its pose changes", () => {
    const { container, rerender, unmount } = render(
      <BotAvatar avatar={face} name="Dev" size={28} look="idle" />
    )
    const el = root(container)
    frames(3)
    // At rest: nothing to draw.
    expect(__activeFacesForTests()).toBe(0)
    const still = art(el).innerHTML
    // Working: it nods over its work.
    rerender(<BotAvatar avatar={face} name="Dev" size={28} look="working" />)
    act(() => vi.advanceTimersByTime(90))
    frames(10)
    expect(__activeFacesForTests()).toBe(1)
    expect(art(el).innerHTML).not.toBe(still)
    const a = art(el).innerHTML
    frames(10)
    expect(art(el).innerHTML).not.toBe(a)
    // Gone: out of the loop.
    unmount()
    frames(2)
    expect(__activeFacesForTests()).toBe(0)
  })

  it("puts a turned face back at rest once it no longer moves", () => {
    const { container, rerender } = render(
      <BotAvatar avatar={face} name="Dev" size={28} look="idle" />
    )
    const el = root(container)
    boxed(el)
    pointer("pointerenter", el, 300, 114)
    frames(6)
    expect(art(el).innerHTML.startsWith("<use ")).toBe(false)
    motion.reduced = true
    rerender(<BotAvatar avatar={face} name="Dev" size={28} look="idle" />)
    expect(art(el).innerHTML.startsWith("<use ")).toBe(true)
  })

  it("turns a done face round once, then rests", () => {
    const { container, rerender } = render(
      <BotAvatar avatar={face} name="Dev" size={28} look="idle" />
    )
    const el = root(container)
    rerender(<BotAvatar avatar={face} name="Dev" size={28} look="done" />)
    act(() => vi.advanceTimersByTime(90))
    frames(20)
    expect(__activeFacesForTests()).toBe(1)
    frames(120)
    expect(__activeFacesForTests()).toBe(0)
    expect(art(el).innerHTML.startsWith("<use ")).toBe(true)
  })
})

describe("what a face is drawn as", () => {
  function drawn(avatar: BotAvatarValue, size = 48) {
    const { container } = render(
      <BotAvatar avatar={avatar} name="Dev" size={size} />
    )
    return root(container)
  }

  /** The page's drawing a face at rest uses. */
  function body(f: HTMLElement): Element {
    const href = f.querySelector("use")!.getAttribute("href")!.slice(1)
    return document.getElementById(href)!
  }

  it("paints with its colour's tones, in either theme", () => {
    const f = drawn({ kind: "face", shape: "mug", color: "gray" })
    expect(f.querySelector("svg")!.getAttribute("data-pa-tone")).toBe("gray")
    const css = document.getElementById("pa-face-tones")!.textContent!
    expect(css).toContain('[data-pa-tone="gray"]{--pa-k-body:')
    expect(css).toContain('.dark [data-pa-tone="gray"]{--pa-k-body:')
    expect(body(f).querySelector(".pa-f-body")).not.toBeNull()
  })

  it("puts its eyes in the paint that reads where they are", () => {
    const eyes = (shape: string) => {
      cleanup()
      return drawn({ kind: "face", shape: shape as never, color: "teal" })
        .querySelector(".pa-face-lids path")!
        .getAttribute("class")
    }
    expect(eyes("mug")).toBe("pa-f-eye-body")
    expect(eyes("terminal")).toBe("pa-f-eye-screen")
    expect(eyes("ring")).toBe("pa-f-eye-hole")
    expect(eyes("braces")).toBe("pa-f-eye-float")
  })

  it("is drawn small under 32px: no edges", () => {
    const big = drawn({ kind: "face", shape: "gear", color: "red" }, 32)
    expect(big.hasAttribute("data-bot-small")).toBe(false)
    expect(body(big).querySelector(".pa-s-edge")).not.toBeNull()
    cleanup()
    const small = drawn({ kind: "face", shape: "gear", color: "red" }, 28)
    expect(small.hasAttribute("data-bot-small")).toBe(true)
    expect(body(small).querySelector(".pa-s-edge")).toBeNull()
  })

  it("draws a shape since renamed as the one it became, one never drawn as the terminal", () => {
    const shapeOf = (name: string) => {
      cleanup()
      return drawn({
        kind: "face",
        shape: name as never,
        color: "red",
      }).getAttribute("data-bot-shape")
    }
    expect(shapeOf("donut")).toBe("braces")
    expect(shapeOf("pebble")).toBe("terminal")
  })
})

describe("a picture or a monogram for a face", () => {
  it("shows its state in a ring and the dot", () => {
    const { container } = render(
      <BotAvatar
        avatar={{ kind: "monogram", text: "D", color: "blue" } as never}
        name="Dev"
        size={28}
        look="working"
        dot="unread"
      />
    )
    const el = root(container)
    expect(el.querySelector(".pa-face-ring")).not.toBeNull()
    expect(el.querySelector("[data-bot-dot='unread']")).not.toBeNull()
  })

  it("is drawn as it always was when it has nothing to show", () => {
    const { container } = render(
      <BotAvatar
        avatar={{ kind: "monogram", text: "D", color: "blue" } as never}
        name="Dev"
        size={28}
      />
    )
    expect(root(container)).toBeNull()
    expect(
      container.querySelector("[data-slot='assistant-avatar']")
    ).not.toBeNull()
  })
})

describe("spinners on one phase", () => {
  it("start as far into their turn as the clock is", () => {
    expect(syncedDelay(1200, 10_000)).toBe("-400ms")
    expect(syncedDelay(700, 700)).toBe("-0ms")
  })
})
