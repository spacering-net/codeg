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
    expect(gaze.style.transform).toBe("translate(-4px, 0px)")
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
