import { act, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { isWindowDragPress } from "@/lib/window-drag-region"

// Radix arms its document-level pointer-down listener in a `setTimeout(0)`.
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

// jsdom has no `PointerEvent`: a `MouseEvent` under the pointer-event name
// carries the `button` Radix and the guard read.
function press(target: Element) {
  fireEvent(
    target,
    new MouseEvent("pointerdown", {
      bubbles: true,
      cancelable: true,
      button: 0,
    })
  )
}

function Page({
  open,
  onOpenChange,
}: {
  open?: boolean
  onOpenChange?: (open: boolean) => void
}) {
  return (
    <div>
      <div data-tauri-drag-region data-testid="band">
        <button type="button">In the band</button>
      </div>
      <Popover defaultOpen open={open} onOpenChange={onOpenChange}>
        <PopoverTrigger>Open</PopoverTrigger>
        <PopoverContent>
          <span>Inside</span>
        </PopoverContent>
      </Popover>
    </div>
  )
}

const tauri = window as unknown as { __TAURI_INTERNALS__?: unknown }

describe("a popover on the desktop, pressed on a window-drag region", () => {
  beforeEach(() => {
    tauri.__TAURI_INTERNALS__ = {}
  })
  afterEach(() => {
    delete tauri.__TAURI_INTERNALS__
  })

  it("closes at the press — the click Radix waits for never comes there", async () => {
    render(<Page />)
    await settle()
    expect(screen.getByText("Inside")).toBeInTheDocument()
    press(screen.getByTestId("band"))
    await settle()
    expect(screen.queryByText("Inside")).toBeNull()
  })

  it("tells a controlled one to close", async () => {
    const onOpenChange = vi.fn()
    render(<Page open onOpenChange={onOpenChange} />)
    await settle()
    press(screen.getByTestId("band"))
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it("stays for a button on the band, or a press inside it", async () => {
    const onOpenChange = vi.fn()
    render(<Page open onOpenChange={onOpenChange} />)
    await settle()
    press(screen.getByText("In the band"))
    press(screen.getByText("Inside"))
    expect(onOpenChange).not.toHaveBeenCalled()
  })
})

describe("a popover in the browser, pressed on a drag region", () => {
  it("is left to Radix: it closes on the click, not the press", async () => {
    const onOpenChange = vi.fn()
    render(<Page open onOpenChange={onOpenChange} />)
    await settle()
    press(screen.getByTestId("band"))
    expect(onOpenChange).not.toHaveBeenCalled()
  })
})

describe("whether a press drags the window (Tauri's own test)", () => {
  function pathOf(html: string, id: string): EventTarget[] {
    document.body.innerHTML = html
    const path: EventTarget[] = []
    for (
      let el: Element | null = document.getElementById(id);
      el;
      el = el.parentElement
    ) {
      path.push(el)
    }
    return path
  }

  it("follows the attribute's values and stops at a clickable", () => {
    expect(
      isWindowDragPress(
        pathOf(`<div id="a" data-tauri-drag-region></div>`, "a")
      )
    ).toBe(true)
    expect(
      isWindowDragPress(
        pathOf(`<div data-tauri-drag-region><span id="a"></span></div>`, "a")
      )
    ).toBe(false)
    expect(
      isWindowDragPress(
        pathOf(
          `<div data-tauri-drag-region="deep"><span id="a"></span></div>`,
          "a"
        )
      )
    ).toBe(true)
    expect(
      isWindowDragPress(
        pathOf(
          `<div data-tauri-drag-region="deep"><button><span id="a"></span></button></div>`,
          "a"
        )
      )
    ).toBe(false)
    expect(
      isWindowDragPress(
        pathOf(
          `<div data-tauri-drag-region="deep"><div data-tauri-drag-region="false"><span id="a"></span></div></div>`,
          "a"
        )
      )
    ).toBe(false)
    expect(isWindowDragPress(pathOf(`<div id="a"></div>`, "a"))).toBe(false)
  })
})
