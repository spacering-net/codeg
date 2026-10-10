import { fireEvent, render, screen } from "@testing-library/react"
import { useState } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"

import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "./instant-collapsible"

afterEach(() => {
  vi.restoreAllMocks()
})

// Pretend the collapsible content has an animate-out style. Scoped to the
// content node only — testing-library's role queries call getComputedStyle on
// other elements and need the real implementation.
function mockExitAnimation() {
  const real = window.getComputedStyle.bind(window)
  vi.spyOn(window, "getComputedStyle").mockImplementation((el, pseudo) => {
    const element = el as HTMLElement
    if (element.dataset?.slot === "collapsible-content") {
      return {
        animationName: "exit",
        animationDuration: "0.15s",
        animationDelay: "0s",
      } as CSSStyleDeclaration
    }
    return real(element, pseudo as never)
  })
}

describe("InstantCollapsible", () => {
  it("starts closed (uncontrolled) with no content in the DOM and toggles on click", () => {
    render(
      <Collapsible>
        <CollapsibleTrigger>toggle</CollapsibleTrigger>
        <CollapsibleContent>
          <div data-testid="body" />
        </CollapsibleContent>
      </Collapsible>
    )

    expect(screen.queryByTestId("body")).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole("button", { name: "toggle" }))
    expect(screen.getByTestId("body")).toBeInTheDocument()

    // jsdom has no animations, so closing unmounts synchronously.
    fireEvent.click(screen.getByRole("button", { name: "toggle" }))
    expect(screen.queryByTestId("body")).not.toBeInTheDocument()
  })

  it("respects defaultOpen", () => {
    render(
      <Collapsible defaultOpen>
        <CollapsibleTrigger>toggle</CollapsibleTrigger>
        <CollapsibleContent>
          <div data-testid="body" />
        </CollapsibleContent>
      </Collapsible>
    )

    expect(screen.getByTestId("body")).toBeInTheDocument()
  })

  it("works controlled: reports toggles through onOpenChange and follows the prop", () => {
    const onOpenChange = vi.fn()
    function Harness() {
      const [open, setOpen] = useState(false)
      return (
        <Collapsible
          open={open}
          onOpenChange={(next) => {
            onOpenChange(next)
            setOpen(next)
          }}
        >
          <CollapsibleTrigger>toggle</CollapsibleTrigger>
          <CollapsibleContent>
            <div data-testid="body" />
          </CollapsibleContent>
        </Collapsible>
      )
    }
    render(<Harness />)

    fireEvent.click(screen.getByRole("button", { name: "toggle" }))
    expect(onOpenChange).toHaveBeenLastCalledWith(true)
    expect(screen.getByTestId("body")).toBeInTheDocument()

    fireEvent.click(screen.getByRole("button", { name: "toggle" }))
    expect(onOpenChange).toHaveBeenLastCalledWith(false)
    expect(screen.queryByTestId("body")).not.toBeInTheDocument()
  })

  it("exposes the Radix data/aria contract", () => {
    const { container } = render(
      <Collapsible defaultOpen className="root-class">
        <CollapsibleTrigger>toggle</CollapsibleTrigger>
        <CollapsibleContent>
          <div data-testid="body" />
        </CollapsibleContent>
      </Collapsible>
    )

    const root = container.querySelector('[data-slot="collapsible"]')
    const trigger = screen.getByRole("button", { name: "toggle" })
    const content = container.querySelector('[data-slot="collapsible-content"]')

    expect(root).toHaveClass("root-class")
    expect(root).toHaveAttribute("data-state", "open")
    expect(trigger).toHaveAttribute("data-slot", "collapsible-trigger")
    expect(trigger).toHaveAttribute("data-state", "open")
    expect(trigger).toHaveAttribute("aria-expanded", "true")
    expect(content).toHaveAttribute("data-state", "open")
    expect(content).toHaveAttribute("id", trigger.getAttribute("aria-controls"))

    fireEvent.click(trigger)
    expect(root).toHaveAttribute("data-state", "closed")
    expect(trigger).toHaveAttribute("data-state", "closed")
    expect(trigger).toHaveAttribute("aria-expanded", "false")
  })

  it("does not toggle when the root is disabled", () => {
    render(
      <Collapsible disabled>
        <CollapsibleTrigger>toggle</CollapsibleTrigger>
        <CollapsibleContent>
          <div data-testid="body" />
        </CollapsibleContent>
      </Collapsible>
    )

    const trigger = screen.getByRole("button", { name: "toggle" })
    expect(trigger).toBeDisabled()
    fireEvent.click(trigger)
    expect(screen.queryByTestId("body")).not.toBeInTheDocument()
  })

  it("keeps the content mounted through an exit animation, then unmounts", () => {
    mockExitAnimation()

    render(
      <Collapsible defaultOpen>
        <CollapsibleTrigger>toggle</CollapsibleTrigger>
        <CollapsibleContent>
          <div data-testid="body" />
        </CollapsibleContent>
      </Collapsible>
    )

    fireEvent.click(screen.getByRole("button", { name: "toggle" }))
    // Exit animation in flight: still mounted, in the closed state.
    const body = screen.getByTestId("body")
    const content = body.parentElement as HTMLElement
    expect(content).toHaveAttribute("data-state", "closed")

    fireEvent.animationEnd(content)
    expect(screen.queryByTestId("body")).not.toBeInTheDocument()
  })

  it("cancels a pending exit when reopened mid-animation", () => {
    mockExitAnimation()

    render(
      <Collapsible defaultOpen>
        <CollapsibleTrigger>toggle</CollapsibleTrigger>
        <CollapsibleContent>
          <div data-testid="body" />
        </CollapsibleContent>
      </Collapsible>
    )

    const trigger = screen.getByRole("button", { name: "toggle" })
    fireEvent.click(trigger)
    const content = screen.getByTestId("body").parentElement as HTMLElement

    fireEvent.click(trigger)
    expect(content).toHaveAttribute("data-state", "open")

    // The stale exit animation finishing must not unmount reopened content.
    fireEvent.animationEnd(content)
    expect(screen.getByTestId("body")).toBeInTheDocument()
  })

  it("holds the exit's last keyframe until the content unmounts", () => {
    mockExitAnimation()

    render(
      <Collapsible defaultOpen>
        <CollapsibleTrigger>toggle</CollapsibleTrigger>
        <CollapsibleContent>
          <div data-testid="body" />
        </CollapsibleContent>
      </Collapsible>
    )

    const content = screen.getByTestId("body").parentElement as HTMLElement
    expect(content.style.animationFillMode).toBe("")

    // `animate-out` ends with fill-mode none, which would snap the content
    // back to full opacity for a frame before it unmounts.
    fireEvent.click(screen.getByRole("button", { name: "toggle" }))
    expect(content.style.animationFillMode).toBe("forwards")

    // The unmount lands after the event, so the hold must still be in place
    // when the event has gone all the way through.
    const seen: Array<{ connected: boolean; fillMode: string }> = []
    const record = () =>
      seen.push({
        connected: content.isConnected,
        fillMode: content.style.animationFillMode,
      })
    document.addEventListener("animationend", record)
    try {
      fireEvent.animationEnd(content)
    } finally {
      document.removeEventListener("animationend", record)
    }
    expect(seen).toEqual([{ connected: true, fillMode: "forwards" }])
    expect(screen.queryByTestId("body")).not.toBeInTheDocument()
  })

  it("unmounts at once when the exit animation is cancelled", () => {
    mockExitAnimation()

    render(
      <Collapsible defaultOpen>
        <CollapsibleTrigger>toggle</CollapsibleTrigger>
        <CollapsibleContent>
          <div data-testid="body" />
        </CollapsibleContent>
      </Collapsible>
    )

    fireEvent.click(screen.getByRole("button", { name: "toggle" }))
    const content = screen.getByTestId("body").parentElement as HTMLElement

    // A cancelled animation leaves no keyframe to hold, so the content must
    // be gone before the event finishes dispatching, not a task later.
    const seen: boolean[] = []
    const record = () => seen.push(content.isConnected)
    document.addEventListener("animationcancel", record)
    try {
      fireEvent(content, new Event("animationcancel", { bubbles: true }))
    } finally {
      document.removeEventListener("animationcancel", record)
    }
    expect(seen).toEqual([false])
    expect(screen.queryByTestId("body")).not.toBeInTheDocument()
  })

  it("hands the content its own fill mode back when reopened mid-exit", () => {
    mockExitAnimation()

    render(
      <Collapsible defaultOpen>
        <CollapsibleTrigger>toggle</CollapsibleTrigger>
        <CollapsibleContent style={{ animationFillMode: "backwards" }}>
          <div data-testid="body" />
        </CollapsibleContent>
      </Collapsible>
    )

    const trigger = screen.getByRole("button", { name: "toggle" })
    const content = screen.getByTestId("body").parentElement as HTMLElement

    fireEvent.click(trigger)
    expect(content.style.animationFillMode).toBe("forwards")

    // React leaves the unchanged style prop alone, so the enter animation
    // only gets "backwards" back because the exit restores it.
    fireEvent.click(trigger)
    expect(content).toHaveAttribute("data-state", "open")
    expect(content.style.animationFillMode).toBe("backwards")
  })

  it("still delivers the exit's animationend to the content's onAnimationEnd", () => {
    mockExitAnimation()
    const onAnimationEnd = vi.fn()

    render(
      <Collapsible defaultOpen>
        <CollapsibleTrigger>toggle</CollapsibleTrigger>
        <CollapsibleContent onAnimationEnd={onAnimationEnd}>
          <div data-testid="body" />
        </CollapsibleContent>
      </Collapsible>
    )

    fireEvent.click(screen.getByRole("button", { name: "toggle" }))
    const content = screen.getByTestId("body").parentElement as HTMLElement

    // The unmount must not land inside the native listener: React dispatches
    // the same event to onAnimationEnd afterwards, from the root, and finds
    // nothing there once the node is gone.
    fireEvent.animationEnd(content)
    expect(onAnimationEnd).toHaveBeenCalledTimes(1)
    expect(screen.queryByTestId("body")).not.toBeInTheDocument()
  })

  it("ignores bubbling child animation ends while exiting", () => {
    mockExitAnimation()

    render(
      <Collapsible defaultOpen>
        <CollapsibleTrigger>toggle</CollapsibleTrigger>
        <CollapsibleContent>
          <div data-testid="body" />
        </CollapsibleContent>
      </Collapsible>
    )

    fireEvent.click(screen.getByRole("button", { name: "toggle" }))
    const body = screen.getByTestId("body")

    fireEvent.animationEnd(body)
    expect(screen.getByTestId("body")).toBeInTheDocument()

    fireEvent.animationEnd(body.parentElement as HTMLElement)
    expect(screen.queryByTestId("body")).not.toBeInTheDocument()
  })
})
