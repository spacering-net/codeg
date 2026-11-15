import { act, cleanup, render } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const motion = vi.hoisted(() => ({ reduced: false }))
vi.mock("@/hooks/use-chat-motion", () => ({
  useReducedMotion: () => motion.reduced,
}))

import { syncedDelay } from "@/lib/motion/synced-spin"
import type { BotAvatar as BotAvatarValue } from "@/lib/types"

import { BotAvatar } from "./bot-avatar"

const face: BotAvatarValue = { kind: "face", shape: "blob", color: "teal" }

function root(container: HTMLElement): HTMLElement {
  return container.querySelector("[data-slot='bot-avatar']") as HTMLElement
}

beforeEach(() => {
  motion.reduced = false
  vi.useFakeTimers()
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
    act(() => vi.advanceTimersByTime(2800))
    const gaze = el.querySelector(".pa-face-gaze") as SVGGElement
    // A tenth of the face: seen on a roster row's face too.
    expect(gaze.style.transform).toBe("translate(-10px, 0px)")
    act(() => vi.advanceTimersByTime(500))
    expect(gaze.style.transform).toBe("")
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

/** The next frame (the eyes follow the pointer once a frame). */
function frame() {
  act(() => vi.advanceTimersByTime(20))
}

describe("the pointer over a face", () => {
  it("perks it up each time it comes, its eyes following it while it stays", () => {
    const { container } = render(
      <BotAvatar avatar={face} name="Dev" size={28} look="idle" />
    )
    const el = root(container)
    const gaze = el.querySelector(".pa-face-gaze") as SVGGElement
    boxed(el)
    expect(el.hasAttribute("data-perk")).toBe(false)
    // In over its right edge: a perk, the eyes all the way right.
    pointer("pointerenter", el, 128, 114)
    frame()
    expect(el.getAttribute("data-perk")).toBe("a")
    expect(el.hasAttribute("data-hover")).toBe(true)
    expect(gaze.style.transform).toBe("translate(11px, 0px)")
    // Off to the top left: as far as the eyes go that way.
    pointer("pointermove", el, 0, 0)
    frame()
    expect(gaze.style.transform).toBe("translate(-8px, -6px)")
    // Gone: the eyes settle back.
    pointer("pointerleave", el)
    expect(el.hasAttribute("data-hover")).toBe(false)
    expect(gaze.style.transform).toBe("")
    // Back again: the perk again, under its other name so it plays.
    pointer("pointerenter", el, 114, 128)
    frame()
    expect(el.getAttribute("data-perk")).toBe("b")
    expect(gaze.style.transform).toBe("translate(0px, 8px)")
  })

  it("notices it over the row it is the face of", () => {
    const { container } = render(
      <button type="button" data-pa-face-host>
        <BotAvatar avatar={face} name="Dev" size={28} look="working" />
        Dev
      </button>
    )
    const row = container.querySelector("button")!
    const el = root(container)
    boxed(el)
    // At the row's far end: it looks that way.
    pointer("pointerenter", row, 300, 114)
    frame()
    expect(el.getAttribute("data-perk")).toBe("a")
    expect(
      (el.querySelector(".pa-face-gaze") as SVGGElement).style.transform
    ).toBe("translate(11px, 0px)")
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
    // Its eyes open through a blink, then follow the pointer.
    expect(el.hasAttribute("data-blink")).toBe(true)
    act(() => vi.advanceTimersByTime(90))
    expect(el.getAttribute("data-bot-look")).toBe("idle")
    expect(el.querySelectorAll(".pa-face-z")).toHaveLength(0)
    frame()
    act(() => vi.advanceTimersByTime(200))
    expect(
      (el.querySelector(".pa-face-gaze") as SVGGElement).style.transform
    ).toBe("translate(11px, 0px)")
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
    frame()
    expect(root(container).hasAttribute("data-perk")).toBe(false)
    expect(root(container).hasAttribute("data-hover")).toBe(false)
    // A touch.
    rerender(<BotAvatar avatar={face} name="Dev" size={28} look="idle" />)
    pointer("pointerenter", root(container), 128, 114, "touch")
    frame()
    expect(root(container).hasAttribute("data-perk")).toBe(false)
    // Reduced motion.
    motion.reduced = true
    rerender(<BotAvatar avatar={face} name="Dev" size={28} look="waiting" />)
    pointer("pointerenter", root(container), 128, 114)
    frame()
    expect(root(container).hasAttribute("data-perk")).toBe(false)
    expect(root(container).hasAttribute("data-hover")).toBe(false)
  })

  it("keeps its eyes on its body: clipped to its shape, each face its own", () => {
    const { container } = render(
      <>
        <BotAvatar avatar={face} name="Dev" size={28} look="idle" />
        <BotAvatar avatar={face} name="Ops" size={28} look="idle" />
      </>
    )
    const faces = [...container.querySelectorAll("[data-slot='bot-avatar']")]
    const ids = faces.map((f) => {
      const clip = f.querySelector("clipPath")!
      const eyes = f.querySelector(".pa-face-lids")!
      // The group that clips them holds the eyes, and is the body's own.
      const clipped = eyes.closest("[clip-path]")!
      expect(clipped.getAttribute("clip-path")).toBe(`url(#${clip.id})`)
      expect(clip.querySelector("path")!.getAttribute("d")).toBe(
        f.querySelector(".pa-face-perk > path")!.getAttribute("d")
      )
      return clip.id
    })
    expect(new Set(ids).size).toBe(2)
    for (const id of ids) expect(id).toMatch(/^pa-face-clip-[\w-]+$/)
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
