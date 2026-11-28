import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

// The scrollbar library, counted: a setup is a measure of the box (scrolled
// to its ends and back) and a re-focus of the focused field.
const os = vi.hoisted(() => {
  const destroy = vi.fn()
  return { destroy, create: vi.fn(() => ({ destroy })) }
})
vi.mock("overlayscrollbars", () => ({ OverlayScrollbars: os.create }))

import { Dialog, DialogContent, DialogDescription, DialogTitle } from "./dialog"

/** An open dialog with a field in it, rendered again whenever its host is —
 *  as one is while what is above it renders (the roster, an assistant at
 *  work). */
function Host({ open, tick }: { open: boolean; tick: number }) {
  return (
    <Dialog open={open}>
      {/* Inline, as jsdom has no stylesheet: a box that scrolls itself. */}
      <DialogContent style={{ overflowY: "auto" }}>
        <DialogTitle>Title</DialogTitle>
        <DialogDescription>Rendered {tick} times</DialogDescription>
        <input aria-label="Name" autoFocus />
      </DialogContent>
    </Dialog>
  )
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe("a dialog's scrollbar", () => {
  it("is set up once per opening, not again on every render", () => {
    const { rerender } = render(<Host open tick={0} />)
    expect(os.create).toHaveBeenCalledTimes(1)
    const field = screen.getByLabelText("Name")
    expect(document.activeElement).toBe(field)

    // Radix's FocusScope hands the content a new ref on every render, so
    // React detaches and attaches its refs each time: a setup built on the
    // ref was torn down and made again on each of these.
    for (let tick = 1; tick <= 3; tick++) rerender(<Host open tick={tick} />)
    expect(os.create).toHaveBeenCalledTimes(1)
    expect(os.destroy).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(field)

    rerender(<Host open={false} tick={4} />)
    expect(os.destroy).toHaveBeenCalledTimes(1)
  })
})
