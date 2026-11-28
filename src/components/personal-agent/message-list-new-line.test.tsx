import { act, cleanup, fireEvent, render } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"

const motion = vi.hoisted(() => ({ reduced: false }))
vi.mock("@/hooks/use-chat-motion", () => ({
  useReducedMotion: () => motion.reduced,
}))

import { NewLine } from "./message-list"

function draw(onSeen: () => void) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <div data-pa-row="x" className="flex flex-col">
        <NewLine onSeen={onSeen} />
        <div className="mt-8">message</div>
      </div>
    </NextIntlClientProvider>
  )
}

const line = () => document.querySelector<HTMLElement>("[data-pa-new]")!

beforeEach(() => {
  vi.useFakeTimers()
  motion.reduced = false
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('the "new messages" line', () => {
  it("stays while nothing comes over it", () => {
    const onSeen = vi.fn()
    draw(onSeen)
    act(() => vi.advanceTimersByTime(60_000))
    expect(onSeen).not.toHaveBeenCalled()
    expect(line().dataset.paNew).toBe("shown")
    expect(line().hasAttribute("data-pa-divider")).toBe(true)
  })

  it("goes once the pointer has been over it: it fades, then folds away", () => {
    const onSeen = vi.fn()
    draw(onSeen)
    fireEvent.pointerEnter(line())
    // Gone over and off again: it goes all the same.
    fireEvent.pointerLeave(line())
    act(() => vi.advanceTimersByTime(599))
    expect(line().dataset.paNew).toBe("shown")
    act(() => vi.advanceTimersByTime(1))
    expect(line().dataset.paNew).toBe("fading")
    expect(onSeen).not.toHaveBeenCalled()
    act(() => vi.advanceTimersByTime(200))
    // Folding, no longer a line the message under it takes its room from
    // (no animation in jsdom: told at once).
    expect(line().dataset.paNew).toBe("folding")
    expect(line().hasAttribute("data-pa-divider")).toBe(false)
    expect(onSeen).toHaveBeenCalledTimes(1)
  })

  it("goes at once with reduced motion", () => {
    motion.reduced = true
    const onSeen = vi.fn()
    draw(onSeen)
    fireEvent.pointerEnter(line())
    act(() => vi.advanceTimersByTime(600))
    expect(onSeen).toHaveBeenCalledTimes(1)
    expect(line().dataset.paNew).toBe("shown")
  })
})
