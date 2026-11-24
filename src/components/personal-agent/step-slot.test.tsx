import { act, cleanup, render } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"

import type { SlotView } from "./reply-view"
import { StepSlot } from "./step-slot"

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

function stepView(kind: string, title: string, awaiting?: boolean): SlotView {
  return {
    kind: "step",
    key: "s1",
    step: { t: "step", n: 1, kind, title, awaiting },
  }
}

function slotTree(view: SlotView, running = true) {
  return (
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <StepSlot view={view} running={running} />
    </NextIntlClientProvider>
  )
}

function renderSlot(view: SlotView) {
  return render(slotTree(view))
}

function textView(key: string, text: string): SlotView {
  return { kind: "text", key, text, streaming: true }
}

describe("StepSlot, a step in flight", () => {
  it.each([
    ["read", "Read src/app.ts"],
    ["execute", "pnpm test"],
    ["search", "Grep TODO"],
    ["fetch", "Fetch https://example.com"],
    ["other", "mcp__codeg-mcp__dispatch"],
  ])("draws a %s step as its words alone, no tool icon", (kind, title) => {
    const { container } = renderSlot(stepView(kind, title))
    expect(container.textContent).not.toBe("")
    expect(container.querySelector("svg")).toBeNull()
  })

  it("names the step by its title", () => {
    const { container } = renderSlot(stepView("read", "Read src/app.ts"))
    expect(container.textContent).toContain("Read src/app.ts")
  })

  it("draws a step waiting on the owner without an icon too", () => {
    const { container } = renderSlot(stepView("execute", "rm -rf build", true))
    expect(container.textContent).toContain("rm -rf build")
    expect(container.querySelector("svg")).toBeNull()
  })
})

describe("StepSlot, clipping", () => {
  // The slot is the first element the tree draws.
  const slotOf = (container: HTMLElement) =>
    container.firstElementChild as HTMLElement

  it("clips nothing once settled: a list's bullets hang outside its text", () => {
    const { container } = render(
      slotTree(
        { kind: "text", key: "t1", text: "- one\n- two", streaming: false },
        false
      )
    )
    expect(slotOf(container).className).not.toContain("overflow-hidden")
    expect(slotOf(container).style.overflow).toBe("")
  })

  it("clips only while a replacement plays, and not after", () => {
    vi.useFakeTimers()
    const { container, rerender } = render(
      slotTree({ kind: "waiting", key: "waiting" })
    )
    rerender(slotTree(textView("t1", "First words")))
    expect(container.textContent).toContain("First words")
    expect(slotOf(container).style.overflow).toBe("hidden")
    act(() => {
      vi.advanceTimersByTime(300)
    })
    expect(slotOf(container).style.overflow).toBe("")
    expect(slotOf(container).style.height).toBe("")
  })

  it("leaves nothing behind when a replacement is cut short", () => {
    vi.useFakeTimers()
    const { container, rerender } = render(
      slotTree({ kind: "waiting", key: "waiting" })
    )
    rerender(slotTree(textView("t1", "First words")))
    // Ended mid-replacement: the body shows at once, keyed anew.
    rerender(
      slotTree(
        { kind: "text", key: "t2", text: "Last words", streaming: false },
        false
      )
    )
    act(() => {
      vi.advanceTimersByTime(300)
    })
    expect(container.textContent).toContain("Last words")
    expect(slotOf(container).style.overflow).toBe("")
    expect(slotOf(container).style.height).toBe("")
    expect(slotOf(container).style.transition).toBe("")
  })
})
