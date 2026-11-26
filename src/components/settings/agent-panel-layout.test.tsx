import { act, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { AgentPanelSaveBar } from "./agent-panel-layout"

type Callback = (entries: IntersectionObserverEntry[]) => void

let lastCallback: Callback | null = null
let lastOptions: IntersectionObserverInit | undefined

class FakeIntersectionObserver {
  constructor(cb: Callback, options?: IntersectionObserverInit) {
    lastCallback = cb
    lastOptions = options
  }
  observe() {}
  disconnect() {}
  unobserve() {}
  takeRecords() {
    return []
  }
}

/** Report one observation: the bar's box against a root ending at y=500. */
function report(ratio: number, barBottom: number) {
  act(() => {
    lastCallback?.([
      {
        intersectionRatio: ratio,
        boundingClientRect: { bottom: barBottom } as DOMRectReadOnly,
        rootBounds: { bottom: 499 } as DOMRectReadOnly,
      } as IntersectionObserverEntry,
    ])
  })
}

describe("AgentPanelSaveBar", () => {
  beforeEach(() => {
    vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver)
    lastCallback = null
    lastOptions = undefined
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function renderBar() {
    render(
      <div style={{ overflowY: "auto" }} data-testid="scroller">
        <AgentPanelSaveBar>
          <button type="button">Save</button>
        </AgentPanelSaveBar>
      </div>
    )
    return screen.getByRole("button", { name: "Save" }).parentElement!
  }

  it("is a sticky row observed against the panel's scroll area", () => {
    const bar = renderBar()
    expect(bar.className).toContain("sticky")
    expect(bar.className).toContain("bottom-0")
    expect(lastOptions?.root).toBe(screen.getByTestId("scroller"))
    expect(bar).not.toHaveAttribute("data-pinned")
  })

  it("takes the pinned look while it sits on the bottom edge", () => {
    const bar = renderBar()
    report(0.95, 500)
    expect(bar).toHaveAttribute("data-pinned")
    expect(bar.className).toContain("bg-card/95")
  })

  it("drops it once the bar is back in its own place", () => {
    const bar = renderBar()
    report(0.95, 500)
    report(1, 320)
    expect(bar).not.toHaveAttribute("data-pinned")
  })

  // Leaving through the top edge also reads as "partly hidden"; only the
  // position tells it apart from being pinned at the bottom.
  it("is not pinned while it scrolls out through the top", () => {
    const bar = renderBar()
    report(0.4, 12)
    expect(bar).not.toHaveAttribute("data-pinned")
  })
})
