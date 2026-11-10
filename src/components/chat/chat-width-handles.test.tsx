import type { ReactNode } from "react"
import { act, fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { ChatWidthHandles } from "./chat-width-handles"
import { AppearanceProvider } from "@/components/appearance-provider"
import { STORAGE_KEY_CHAT_CONTENT_WIDTH } from "@/lib/appearance-script"
import {
  CHAT_CONTENT_GUTTER,
  CHAT_CONTENT_WIDTH_VAR,
} from "@/lib/chat-content-width"

const messages = {
  Folder: { chat: { messageList: { resizeWidth: "Resize" } } },
}

function box(left: number, width: number): DOMRect {
  return {
    left,
    width,
    right: left + width,
    top: 0,
    bottom: 0,
    height: 0,
    x: left,
    y: 0,
    toJSON: () => ({}),
  } as DOMRect
}

const root = () => document.documentElement

const rootVar = () => root().style.getPropertyValue(CHAT_CONTENT_WIDTH_VAR)

const stored = () => localStorage.getItem(STORAGE_KEY_CHAT_CONTENT_WIDTH)

/**
 * jsdom has no layout, so stand in for the CSS the handles rely on: the
 * column is `min(var(--chat-content-width, 48rem), 100% - 2 × gutter)`,
 * centred in the host, with rem resolved against the root font size (the app
 * zoom), and each handle (12px) hangs inward from a column edge. Read live, so
 * a width the handles apply moves them the way the browser would.
 */
function stubLayout(
  host: HTMLElement,
  left: HTMLElement,
  right: HTMLElement,
  hostWidth: number
) {
  const remPx = () => Number.parseFloat(root().style.fontSize) || 16
  const column = () => {
    const raw = rootVar()
    const width = (raw ? Number.parseFloat(raw) : 48) * remPx()
    return Math.min(width, hostWidth - 2 * CHAT_CONTENT_GUTTER)
  }
  const center = hostWidth / 2
  host.getBoundingClientRect = () => box(0, hostWidth)
  left.getBoundingClientRect = () => box(center - column() / 2, 12)
  right.getBoundingClientRect = () => box(center + column() / 2 - 12, 12)
}

function setup({
  hostWidth = 1600,
  children,
  provider = false,
}: { hostWidth?: number; children?: ReactNode; provider?: boolean } = {}) {
  const tree = (
    <NextIntlClientProvider locale="en" messages={messages}>
      <div data-testid="host">
        {children}
        <ChatWidthHandles />
      </div>
    </NextIntlClientProvider>
  )
  const view = render(
    provider ? <AppearanceProvider>{tree}</AppearanceProvider> : tree
  )
  const host = screen.getByTestId("host")
  const [left, right] = screen.getAllByRole("separator")
  stubLayout(host, left, right, hostWidth)
  for (const h of [left, right]) {
    h.setPointerCapture = () => {}
    h.releasePointerCapture = () => {}
  }
  return { ...view, host, left, right }
}

// jsdom has no `PointerEvent`, so drive the handlers with real `MouseEvent`s
// under the pointer-event names (same recipe as sidebar-section-header.test).
function pointer(target: Element, type: string, clientX: number) {
  fireEvent(
    target,
    new MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      clientX,
      button: 0,
    })
  )
}

async function nextFrame() {
  await act(async () => {
    await new Promise((r) => requestAnimationFrame(() => r(null)))
  })
}

/** A stored preference, as the pre-hydration script would have applied it. */
function storeWidth(px: number) {
  localStorage.setItem(STORAGE_KEY_CHAT_CONTENT_WIDTH, `${px}`)
  root().style.setProperty(CHAT_CONTENT_WIDTH_VAR, `${px / 16}rem`)
}

beforeEach(() => {
  localStorage.clear()
  root().removeAttribute("style")
})

describe("ChatWidthHandles", () => {
  it("widens symmetrically (2x the outward travel) and persists on release", async () => {
    const { right } = setup()
    // 768px column centred in 1600: right edge at 1184.
    pointer(right, "pointerdown", 1184)
    pointer(right, "pointermove", 1234)
    await nextFrame()
    expect(rootVar()).toBe(`${868 / 16}rem`) // 768 + 50 * 2
    pointer(right, "pointerup", 1234)
    expect(stored()).toBe("868")
  })

  it("treats dragging the left handle leftwards as outward", () => {
    const { left } = setup()
    pointer(left, "pointerdown", 416)
    pointer(left, "pointerup", 376)
    expect(stored()).toBe("848")
  })

  it("does not store a width for a press without movement", () => {
    const { right } = setup()
    pointer(right, "pointerdown", 1184)
    pointer(right, "pointerup", 1184)
    expect(stored()).toBeNull()
  })

  it("clamps to the floor and to the column minus both gutters", () => {
    const { right } = setup()
    pointer(right, "pointerdown", 1184)
    pointer(right, "pointerup", 5000)
    expect(stored()).toBe(`${1600 - 2 * CHAT_CONTENT_GUTTER}`)
    // The column is now 1576 wide: its right edge sits at 1588.
    pointer(right, "pointerdown", 1588)
    pointer(right, "pointerup", -5000)
    expect(stored()).toBe("640")
  })

  it("resets to the default on double-click", () => {
    const { right } = setup()
    storeWidth(900)
    fireEvent.doubleClick(right)
    expect(rootVar()).toBe("")
    expect(stored()).toBeNull()
  })

  it("resizes from the keyboard, outward key widening", () => {
    const { left, right } = setup()
    fireEvent.keyDown(right, { key: "ArrowRight" })
    expect(stored()).toBe("800")
    fireEvent.keyDown(left, { key: "ArrowRight" }) // inward on the left side
    expect(stored()).toBe("768")
  })

  it("resets from the keyboard with Escape or Home", () => {
    const { right } = setup()
    storeWidth(900)
    fireEvent.keyDown(right, { key: "Home" })
    expect(stored()).toBeNull()
    storeWidth(900)
    fireEvent.keyDown(right, { key: "Escape" })
    expect(stored()).toBeNull()
    expect(rootVar()).toBe("")
  })
})

describe("ChatWidthHandles in a host that caps the column", () => {
  it("stores nothing from a host too narrow for the floor", async () => {
    // 500px host: the column is capped at 476 (edges 12 and 488), below the
    // 640 floor, so no width the handles could store would show here.
    const { left, right } = setup({ hostWidth: 500 })
    pointer(right, "pointerdown", 488)
    pointer(right, "pointermove", 498)
    await nextFrame()
    expect(rootVar()).toBe("")
    pointer(right, "pointerup", 498)
    pointer(left, "pointerdown", 12)
    pointer(left, "pointerup", 40)
    fireEvent.keyDown(right, { key: "ArrowRight" })
    fireEvent.keyDown(right, { key: "ArrowLeft" })
    expect(stored()).toBeNull()
    expect(rootVar()).toBe("")
  })

  it("keeps a wider preference when pushed outward at the cap", async () => {
    storeWidth(1400)
    // 1000px host: the 1400 preference is capped to 976 (right edge 988).
    const { right } = setup({ hostWidth: 1000 })
    pointer(right, "pointerdown", 988)
    pointer(right, "pointermove", 1100)
    await nextFrame()
    expect(rootVar()).toBe(`${1400 / 16}rem`)
    pointer(right, "pointerup", 1100)
    fireEvent.keyDown(right, { key: "ArrowRight" })
    expect(stored()).toBe("1400")
  })

  it("narrows from the cap", () => {
    storeWidth(1400)
    const { right } = setup({ hostWidth: 1000 })
    pointer(right, "pointerdown", 988)
    pointer(right, "pointerup", 950) // 38 inward → 976 - 76
    expect(stored()).toBe("900")
  })
})

describe("ChatWidthHandles under app zoom", () => {
  it("stores px at 100% zoom, so the width scales with the zoom like the default", () => {
    root().style.fontSize = "32px" // 200%: the 48rem default is 1536 CSS px
    const { right } = setup()
    // Right edge at 800 + 768 = 1568; 10 CSS px outward is 5px at 100% each
    // side, 10px in all.
    pointer(right, "pointerdown", 1568)
    pointer(right, "pointerup", 1578)
    expect(stored()).toBe("778")
    expect(rootVar()).toBe(`${778 / 16}rem`)
  })

  it("does not jump wider when dragged inward from the default at 80%", () => {
    root().style.fontSize = "12.8px" // 80%: the default column is 614.4 CSS px
    const { right } = setup()
    // Right edge at 800 + 307.2; 4 CSS px inward is 8 CSS px = 10px at 100%.
    pointer(right, "pointerdown", 1107.2)
    pointer(right, "pointerup", 1103.2)
    expect(stored()).toBe("758")
  })
})

describe("ChatWidthHandles interrupted drag", () => {
  it("puts the stored width back when the drag is cancelled", async () => {
    storeWidth(900)
    const { right } = setup()
    pointer(right, "pointerdown", 1250) // 800 + 450
    pointer(right, "pointermove", 1300)
    await nextFrame()
    expect(rootVar()).toBe(`${1000 / 16}rem`)
    pointer(right, "pointercancel", 1300)
    expect(rootVar()).toBe(`${900 / 16}rem`)
    expect(stored()).toBe("900")
  })

  it("restores the default when nothing was stored", async () => {
    const { right } = setup()
    pointer(right, "pointerdown", 1184)
    pointer(right, "pointermove", 1234)
    await nextFrame()
    pointer(right, "lostpointercapture", 1234)
    expect(rootVar()).toBe("")
    expect(stored()).toBeNull()
  })

  it("puts the stored width back when released where the drag began", async () => {
    // Out far enough for a preview frame to land, then back to the press point
    // and released before another frame: nothing is stored, so the preview
    // must not outlive the drag.
    storeWidth(900)
    const { right } = setup()
    pointer(right, "pointerdown", 1250)
    pointer(right, "pointermove", 1300)
    await nextFrame()
    expect(rootVar()).toBe(`${1000 / 16}rem`)
    pointer(right, "pointermove", 1250)
    pointer(right, "pointerup", 1250)
    expect(rootVar()).toBe(`${900 / 16}rem`)
    expect(stored()).toBe("900")
    await nextFrame()
    expect(rootVar()).toBe(`${900 / 16}rem`)
  })

  it("restores a wider capped preference, not the measured width, mid-drag", async () => {
    // 1400 capped to 976 by a 1000px host. Back at the press point, the
    // preview must show the preference itself, not the 976 it measured.
    storeWidth(1400)
    const { right } = setup({ hostWidth: 1000 })
    pointer(right, "pointerdown", 988)
    pointer(right, "pointermove", 950)
    await nextFrame()
    expect(rootVar()).toBe(`${900 / 16}rem`)
    pointer(right, "pointermove", 988)
    await nextFrame()
    expect(rootVar()).toBe(`${1400 / 16}rem`)
    pointer(right, "pointerup", 988)
    expect(stored()).toBe("1400")
  })

  it("restores the width as stored now, not as of the last render", async () => {
    // Another window stores 1200 mid-drag. This window's provider puts it on
    // <html> at once, but its state update is still pending when the drag is
    // cancelled; restoring the render's 900 would stick, since nothing
    // re-applies the width when that update commits.
    storeWidth(900)
    const { right } = setup({ provider: true })
    pointer(right, "pointerdown", 1250)
    pointer(right, "pointermove", 1300)
    await nextFrame()
    expect(rootVar()).toBe(`${1000 / 16}rem`)
    // Outside act on purpose: the provider's state update must still be
    // pending when the cancel arrives.
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {})
    localStorage.setItem(STORAGE_KEY_CHAT_CONTENT_WIDTH, "1200")
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: STORAGE_KEY_CHAT_CONTENT_WIDTH,
        newValue: "1200",
      })
    )
    pointer(right, "pointercancel", 1300)
    await act(async () => {})
    quiet.mockRestore()
    expect(rootVar()).toBe(`${1200 / 16}rem`)
    expect(stored()).toBe("1200")
  })

  it.each([
    ["without a provider", false],
    ["inside the provider", true],
  ])("restores what the previous drag stored (%s)", (_, provider) => {
    const { right } = setup({ provider })
    pointer(right, "pointerdown", 1184)
    pointer(right, "pointerup", 1234) // stores 868
    pointer(right, "pointerdown", 1234)
    pointer(right, "pointermove", 1300)
    pointer(right, "pointercancel", 1300)
    expect(rootVar()).toBe(`${868 / 16}rem`)
  })

  it("ignores the lostpointercapture that follows a normal release", () => {
    const { right } = setup()
    pointer(right, "pointerdown", 1184)
    pointer(right, "pointerup", 1234)
    pointer(right, "lostpointercapture", 1234)
    expect(stored()).toBe("868")
    expect(rootVar()).toBe(`${868 / 16}rem`)
  })
})

describe("ChatWidthHandles wheel", () => {
  it("replays the wheel on the transcript's scrollport, then scrolls it", () => {
    const { right } = setup({
      children: <div className="chat-scroll-port" data-testid="port" />,
    })
    const port = screen.getByTestId("port")
    const scrollBy = vi.fn()
    port.scrollBy = scrollBy as unknown as typeof port.scrollBy
    const heard: WheelEvent[] = []
    port.addEventListener("wheel", (e) => heard.push(e))
    const above = vi.fn()
    document.addEventListener("wheel", above)

    fireEvent.wheel(right, { deltaY: -120, deltaMode: 0 })

    // The port's own wheel listeners (the stick-to-bottom escape) hear the
    // gesture as if it had landed on the transcript ...
    expect(heard).toHaveLength(1)
    expect(heard[0].deltaY).toBe(-120)
    expect(heard[0].target).toBe(port)
    // ... and the transcript scrolls by it.
    expect(scrollBy).toHaveBeenCalledWith({ top: -120 })
    // The replay does not bubble: only the handle's own event reached here.
    expect(above).toHaveBeenCalledTimes(1)
    document.removeEventListener("wheel", above)
  })

  it("leaves a ctrl+wheel (zoom) alone", () => {
    const { right } = setup({
      children: <div className="chat-scroll-port" data-testid="port" />,
    })
    const port = screen.getByTestId("port")
    const scrollBy = vi.fn()
    port.scrollBy = scrollBy as unknown as typeof port.scrollBy
    const heard = vi.fn()
    port.addEventListener("wheel", heard)
    fireEvent.wheel(right, { deltaY: -120, ctrlKey: true })
    expect(heard).not.toHaveBeenCalled()
    expect(scrollBy).not.toHaveBeenCalled()
  })

  it("scrolls the welcome page, which has no transcript yet", () => {
    const { right } = setup({
      children: <div data-overlayscrollbars-viewport="" data-testid="port" />,
    })
    const port = screen.getByTestId("port")
    const scrollBy = vi.fn()
    port.scrollBy = scrollBy as unknown as typeof port.scrollBy
    fireEvent.wheel(right, { deltaY: 80, deltaMode: 0 })
    expect(scrollBy).toHaveBeenCalledWith({ top: 80 })
  })
})

describe("ChatWidthHandles accessibility", () => {
  it("reports the width and its range once focused, and after each key", () => {
    const { right } = setup()
    expect(right).not.toHaveAttribute("aria-valuenow")
    fireEvent.focus(right)
    expect(right).toHaveAttribute("aria-valuenow", "768")
    expect(right).toHaveAttribute("aria-valuemin", "640")
    expect(right).toHaveAttribute(
      "aria-valuemax",
      `${1600 - 2 * CHAT_CONTENT_GUTTER}`
    )
    fireEvent.keyDown(right, { key: "ArrowRight" })
    expect(right).toHaveAttribute("aria-valuenow", "800")
  })
})
