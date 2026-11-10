import type { ReactNode } from "react"
import { act, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

/**
 * The thread with the real virtualizer under it: what the list does to the
 * page while it scrolls.
 */

const scrollRef = vi.hoisted(() => ({
  current: null as HTMLDivElement | null,
}))

vi.mock("use-stick-to-bottom", () => ({
  useStickToBottomContext: () => ({ scrollRef, stopScroll: vi.fn() }),
}))

vi.mock("@/components/ai-elements/message-thread", () => ({
  MessageThreadContent: ({
    children,
    scrollClassName,
  }: {
    children: ReactNode
    scrollClassName?: string
  }) => (
    <div
      ref={(element) => {
        scrollRef.current = element
      }}
      className={scrollClassName}
      data-testid="viewport"
    >
      {children}
    </div>
  ),
}))

import { VirtualizedMessageThread } from "@/components/message/virtualized-message-thread"

// jsdom lays nothing out: virtua learns its viewport and row sizes from a
// ResizeObserver (of elements with an offsetParent), reported here by hand.
const observed: { target: Element; report: ResizeObserverCallback }[] = []

function lay(viewportHeight: number, rowHeight: number) {
  for (const { target, report } of observed) {
    const height = target === scrollRef.current ? viewportHeight : rowHeight
    report(
      [{ target, contentRect: { height, width: 800 } } as ResizeObserverEntry],
      {} as ResizeObserver
    )
  }
}

beforeEach(() => {
  observed.length = 0
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(private readonly report: ResizeObserverCallback) {}
      observe(target: Element) {
        observed.push({ target, report: this.report })
      }
      unobserve() {}
      disconnect() {}
    }
  )
  Object.defineProperty(HTMLElement.prototype, "offsetParent", {
    configurable: true,
    get: () => document.body,
  })
})

const offsetParent = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  "offsetParent"
)

afterEach(() => {
  vi.unstubAllGlobals()
  if (offsetParent) {
    Object.defineProperty(HTMLElement.prototype, "offsetParent", offsetParent)
  }
})

describe("VirtualizedMessageThread while it scrolls", () => {
  it("leaves pointer events alone on everything it has drawn", async () => {
    render(
      <VirtualizedMessageThread
        items={Array.from({ length: 20 }, (_, i) => ({ id: `m${i}` }))}
        getItemKey={(item) => item.id}
        renderItem={(item) => <p>{item.id}</p>}
      />
    )
    const viewport = screen.getByTestId("viewport")
    // virtua takes up its scroll element in a microtask.
    await act(async () => {})
    act(() => lay(500, 100))
    // virtua's own container, the one element every message sits in.
    const list = viewport.firstElementChild as HTMLElement
    expect(list.style.position).toBe("relative")
    expect(screen.getByText("m0")).toBeTruthy()
    act(() => {
      fireEvent.scroll(viewport, { target: { scrollTop: 120 } })
    })
    // `pointer-events` is inherited: virtua's `none` while scrolling — and
    // the reset after — would restyle every row of every message drawn.
    expect(list.style.pointerEvents).toBe("")
    await act(() => new Promise((done) => setTimeout(done, 400)))
    expect(list.style.pointerEvents).toBe("")
  })
})
