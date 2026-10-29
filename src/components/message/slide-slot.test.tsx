import { act, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { SlideSlot } from "./slide-slot"

const slotOf = () =>
  screen.queryByText("tail")?.closest<HTMLElement>(".slide-slot") ?? null

afterEach(() => {
  vi.restoreAllMocks()
})

describe("SlideSlot", () => {
  it("shows content it mounts with as it stands", () => {
    // A row the virtual list brought back, a conversation opened mid-turn.
    render(
      <SlideSlot show>
        <span>tail</span>
      </SlideSlot>
    )
    expect(slotOf()).not.toBeNull()
    expect(slotOf()).not.toHaveAttribute("data-motion")
  })

  it("slides open when its content arrives after it mounted", () => {
    const computed = window.getComputedStyle
    vi.spyOn(window, "getComputedStyle").mockImplementation(
      (element, pseudo) =>
        element.classList.contains("slide-slot")
          ? ({
              animationName: "slide-slot-open",
              animationDuration: "0.22s",
            } as CSSStyleDeclaration)
          : computed(element, pseudo)
    )
    const view = render(
      <SlideSlot show={false}>
        <span>tail</span>
      </SlideSlot>
    )
    expect(slotOf()).toBeNull()
    view.rerender(
      <SlideSlot show>
        <span>tail</span>
      </SlideSlot>
    )
    expect(slotOf()).toHaveAttribute("data-motion", "enter")
    fireEvent.animationEnd(slotOf()!)
    expect(slotOf()).not.toHaveAttribute("data-motion")
  })

  it("opens as it stands when nothing animates it", () => {
    // Chat animations off, reduced motion — and jsdom.
    const view = render(
      <SlideSlot show={false}>
        <span>tail</span>
      </SlideSlot>
    )
    view.rerender(
      <SlideSlot show>
        <span>tail</span>
      </SlideSlot>
    )
    expect(slotOf()).not.toBeNull()
    expect(slotOf()).not.toHaveAttribute("data-motion")
  })

  it("closes at once when nothing animates it", () => {
    // Chat animations off, reduced motion — and jsdom.
    const view = render(
      <SlideSlot show>
        <span>tail</span>
      </SlideSlot>
    )
    view.rerender(
      <SlideSlot show={false}>
        <span>tail</span>
      </SlideSlot>
    )
    expect(slotOf()).toBeNull()
  })

  it("holds its content while it slides shut, then lets it go", () => {
    const computed = window.getComputedStyle
    vi.spyOn(window, "getComputedStyle").mockImplementation(
      (element, pseudo) =>
        element.classList.contains("slide-slot")
          ? ({
              animationName: "slide-slot-close",
              animationDuration: "0.18s",
            } as CSSStyleDeclaration)
          : computed(element, pseudo)
    )
    const view = render(
      <SlideSlot show>
        <span>tail</span>
      </SlideSlot>
    )
    view.rerender(
      <SlideSlot show={false}>
        <span>tail</span>
      </SlideSlot>
    )
    const slot = slotOf()
    expect(slot).toHaveAttribute("data-motion", "leave")
    // A child's animation ending is not the slot's.
    act(() => {
      screen
        .getByText("tail")
        .dispatchEvent(new Event("animationend", { bubbles: true }))
    })
    expect(slotOf()).not.toBeNull()
    act(() => {
      slot!.dispatchEvent(new Event("animationend"))
    })
    expect(slotOf()).toBeNull()
  })

  it("opens again if its content comes back while it closes", () => {
    const computed = window.getComputedStyle
    vi.spyOn(window, "getComputedStyle").mockImplementation(
      (element, pseudo) =>
        element.classList.contains("slide-slot")
          ? ({
              animationName: "slide-slot-close",
              animationDuration: "0.18s",
            } as CSSStyleDeclaration)
          : computed(element, pseudo)
    )
    const view = render(
      <SlideSlot show>
        <span>tail</span>
      </SlideSlot>
    )
    view.rerender(
      <SlideSlot show={false}>
        <span>tail</span>
      </SlideSlot>
    )
    view.rerender(
      <SlideSlot show>
        <span>tail</span>
      </SlideSlot>
    )
    expect(slotOf()).toHaveAttribute("data-motion", "enter")
  })
})
