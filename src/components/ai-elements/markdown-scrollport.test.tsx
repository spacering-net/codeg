import { fireEvent, render, waitFor } from "@testing-library/react"
import { OverlayScrollbars } from "overlayscrollbars"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@/components/ai-elements/link-safety", () => ({
  useStreamdownLinkSafety: () => ({ enabled: false }),
}))

import { attachOverlayScrollport } from "./markdown-scrollport"
import { MessageResponse } from "./message"

const REPLY = [
  "| Scenario | Before | After |",
  "| --- | --- | --- |",
  "| WMI healthy | 16.5 s | 0.4 s |",
  "",
  "```ts",
  "export const answer: number = 42",
  "```",
].join("\n")

const TABLE_PORT = '[data-streamdown="table-wrapper"] > div:has(> table)'
const CODE_PORT = '[data-streamdown="code-block-body"]'

const set = (node: Element) =>
  OverlayScrollbars.valid(OverlayScrollbars(node as HTMLElement))

beforeEach(() => {
  // OverlayScrollbars only measures an element that has a size, and jsdom
  // lays nothing out.
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(200)
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(200)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe("attachOverlayScrollport", () => {
  it.each(["pointerover", "wheel", "touchstart", "focusin"])(
    "hides the native scrollbar, and sets up on the first %s",
    (type) => {
      const node = document.createElement("div")
      document.body.append(node)
      const detach = attachOverlayScrollport(node)
      expect(node).toHaveAttribute("data-overlayscrollbars-initialize")
      expect(set(node)).toBe(false)

      node.dispatchEvent(new Event(type))
      expect(set(node)).toBe(true)
      // The element stays the scrollport, its scrollbars inside it.
      expect(node).toHaveAttribute("data-overlayscrollbars-viewport")
      expect(node.querySelector(":scope > .os-scrollbar")).not.toBeNull()

      detach()
      expect(set(node)).toBe(false)
      expect(node).not.toHaveAttribute("data-overlayscrollbars-initialize")
      expect(node.querySelector(".os-scrollbar")).toBeNull()
      node.remove()
    }
  )

  it("sets up nothing for an element that goes before a reader comes", () => {
    const node = document.createElement("div")
    document.body.append(node)
    attachOverlayScrollport(node)()
    node.dispatchEvent(new Event("pointerover"))
    expect(set(node)).toBe(false)
    expect(node).not.toHaveAttribute("data-overlayscrollbars-initialize")
    node.remove()
  })
})

describe("MessageResponse scrollports", () => {
  it("puts the table's own scroll container on the app's scrollbars", () => {
    const { container, unmount } = render(
      <MessageResponse>{REPLY}</MessageResponse>
    )
    const port = container.querySelector(TABLE_PORT)!
    expect(port).toHaveAttribute("data-overlayscrollbars-initialize")
    expect(set(port)).toBe(false)

    fireEvent.pointerOver(port.querySelector("td")!)
    expect(set(port)).toBe(true)

    unmount()
    expect(set(port)).toBe(false)
  })

  it("puts a code block's body on them, the highlighted body as well as its placeholder", async () => {
    const { container, unmount } = render(
      <MessageResponse>{REPLY}</MessageResponse>
    )
    // Streamdown swaps the plain body for the highlighted one once its
    // highlighter loads; whichever is there is the scrollport.
    await waitFor(() =>
      expect(
        container.querySelector(`${CODE_PORT} code span span`)
      ).not.toBeNull()
    )
    const body = container.querySelector(CODE_PORT)!
    expect(body).toHaveAttribute("data-overlayscrollbars-initialize")

    fireEvent.wheel(body)
    expect(set(body)).toBe(true)

    unmount()
    expect(set(body)).toBe(false)
  })
})
