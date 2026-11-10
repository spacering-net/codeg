import { render, screen, fireEvent } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import { AgentCapsule } from "./agent-capsule"

describe("AgentCapsule", () => {
  it("shows the title and keeps the body collapsed until the trigger is clicked", () => {
    render(
      <AgentCapsule title="Run the build" isRunning={false} isError={false}>
        <div>BODY CONTENT</div>
      </AgentCapsule>
    )
    expect(screen.getByText("Run the build")).toBeInTheDocument()
    expect(screen.queryByText("BODY CONTENT")).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole("button"))
    expect(screen.getByText("BODY CONTENT")).toBeInTheDocument()
  })

  it("opens by default on error", () => {
    render(
      <AgentCapsule title="Failed op" isRunning={false} isError>
        <div>ERROR BODY</div>
      </AgentCapsule>
    )
    expect(screen.getByText("ERROR BODY")).toBeInTheDocument()
  })

  it("honors defaultOpen over the error default", () => {
    render(
      <AgentCapsule
        title="Open me"
        isRunning={false}
        isError={false}
        defaultOpen
      >
        <div>EAGER BODY</div>
      </AgentCapsule>
    )
    expect(screen.getByText("EAGER BODY")).toBeInTheDocument()
  })

  it("renders the right suffix", () => {
    render(
      <AgentCapsule
        title="With suffix"
        isRunning={false}
        isError={false}
        rightSuffix={<span>12.3s</span>}
      >
        <div>body</div>
      </AgentCapsule>
    )
    expect(screen.getByText("12.3s")).toBeInTheDocument()
  })

  it("renders the idBadge in the (collapsed) pill", () => {
    render(
      <AgentCapsule
        title="Task"
        isRunning={false}
        isError={false}
        idBadge="agent-uuid-xyz"
      >
        <div>BODY</div>
      </AgentCapsule>
    )
    // Visible without expanding the body.
    expect(screen.getByText("agent-uuid-xyz")).toBeInTheDocument()
    expect(screen.queryByText("BODY")).not.toBeInTheDocument()
  })

  it("auto-opens when it transitions into an error state (no remount)", () => {
    const { rerender } = render(
      <AgentCapsule title="Working" isRunning isError={false}>
        <div>ERR BODY</div>
      </AgentCapsule>
    )
    // Running, non-error → collapsed.
    expect(screen.queryByText("ERR BODY")).not.toBeInTheDocument()

    // A failure arrives mid-stream (same instance) → auto-open.
    rerender(
      <AgentCapsule title="Working" isRunning={false} isError>
        <div>ERR BODY</div>
      </AgentCapsule>
    )
    expect(screen.getByText("ERR BODY")).toBeInTheDocument()
  })

  // An expanded capsule of a running sub-agent streams its live transcript and
  // a JS-driven shimmer (a style write every frame) into the body. A scroller
  // that measures its content from a MutationObserver — OverlayScrollbars reads
  // `scrollWidth` in the callback — turns each of those into a synchronous
  // layout. The body must scroll natively instead.
  it("lets a live body change without forcing a synchronous layout read", async () => {
    const native = Object.getOwnPropertyDescriptor(
      Element.prototype,
      "scrollWidth"
    )!
    let reads = 0
    Object.defineProperty(Element.prototype, "scrollWidth", {
      configurable: true,
      get() {
        reads++
        return native.get!.call(this)
      },
    })
    try {
      render(
        <AgentCapsule title="Working" isRunning isError={false} defaultOpen>
          <p data-testid="live">first token</p>
        </AgentCapsule>
      )
      // Past any deferred scroller initialization: overlayscrollbars-react
      // defers to the next animation frame where there is no
      // requestIdleCallback (jsdom), so two frames cover it.
      await new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve))
      )
      reads = 0

      const live = screen.getByTestId("live")
      live.firstChild!.textContent = "first token, second token"
      live.setAttribute("style", "background-position: 40% center")
      await new Promise((resolve) => setTimeout(resolve, 0))

      expect(reads).toBe(0)
    } finally {
      Object.defineProperty(Element.prototype, "scrollWidth", native)
    }
  })

  it("auto-collapses once when running transitions to completed", () => {
    const { rerender } = render(
      <AgentCapsule title="Working" isRunning isError={false}>
        <div>LIVE BODY</div>
      </AgentCapsule>
    )
    // User expands during streaming.
    fireEvent.click(screen.getByRole("button"))
    expect(screen.getByText("LIVE BODY")).toBeInTheDocument()

    // Completion (running → not running, non-error) collapses it once.
    rerender(
      <AgentCapsule title="Working" isRunning={false} isError={false}>
        <div>LIVE BODY</div>
      </AgentCapsule>
    )
    expect(screen.queryByText("LIVE BODY")).not.toBeInTheDocument()
  })
})
