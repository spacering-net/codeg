import { act, fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { useEffect, type ReactNode } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import type {
  EmulatedBrowserDevice,
  ViewportSize,
} from "@/lib/browser/browser-device"

import { BrowserDeviceStage, type DeviceStageFit } from "./browser-device-stage"

type StageDevice = "desktop" | EmulatedBrowserDevice

function intl(children: ReactNode) {
  return (
    <NextIntlClientProvider locale="en" messages={enMessages}>
      {children}
    </NextIntlClientProvider>
  )
}

/** Give every element the stage measures this rect (jsdom has no layout). */
function stageOf(width: number, height: number) {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    width,
    height,
    right: width,
    bottom: height,
    toJSON: () => ({}),
  })
}

function renderStage(
  device: StageDevice,
  options: {
    onCustomSize?: (size: ViewportSize) => void
    minZoom?: number
  } = {}
) {
  const seen: DeviceStageFit[] = []
  const result = render(
    intl(
      <BrowserDeviceStage
        device={device}
        onCustomSize={options.onCustomSize}
        minZoom={options.minZoom}
      >
        {(fit) => {
          seen.push(fit)
          return <div data-testid="page" />
        }}
      </BrowserDeviceStage>
    )
  )
  return { ...result, seen }
}

function last<T>(items: readonly T[]): T | undefined {
  return items[items.length - 1]
}

function frameOf(container: HTMLElement): HTMLElement {
  const frame = container.querySelector<HTMLElement>(
    "[data-browser-device-frame]"
  )
  if (!frame) throw new Error("no frame")
  return frame
}

function labelOf(container: HTMLElement): HTMLElement | null {
  return container.querySelector<HTMLElement>("[data-browser-device-label]")
}

describe("BrowserDeviceStage", () => {
  beforeEach(() => {
    vi.stubGlobal("devicePixelRatio", 2)
  })
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it("lets a desktop page fill the slot, as it always has", () => {
    stageOf(1000, 700)
    const { container, seen } = renderStage("desktop")
    expect(labelOf(container)).toBeNull()
    expect(frameOf(container)).toHaveClass("absolute", "inset-0")
    expect(frameOf(container).style.width).toBe("")
    // The desktop's page zoom is not ours to set.
    expect(last(seen)).toMatchObject({
      viewport: null,
      frame: null,
      zoom: null,
    })
  })

  it("shows a phone that fits at its own size, unzoomed", () => {
    // 16px padding twice, a 20px label and an 8px gap leave 932 × 920.
    stageOf(964, 980)
    const { container, seen } = renderStage("phone")
    expect(frameOf(container).style.width).toBe("390px")
    expect(frameOf(container).style.height).toBe("844px")
    expect(labelOf(container)).toHaveTextContent(/^390 × 844$/)
    expect(last(seen)?.zoom).toBe(1)
  })

  it("shrinks a tablet that does not fit, says by how much, and zooms its page to match", () => {
    stageOf(1200, 700)
    const { container, seen } = renderStage("tablet")
    // 700 - 32 - 28 = 640 of the tablet's 1024.
    const width = Math.floor(768 * (640 / 1024))
    expect(frameOf(container).style.width).toBe(`${width}px`)
    expect(frameOf(container).style.height).toBe("640px")
    expect(labelOf(container)).toHaveTextContent("768 × 1024")
    expect(labelOf(container)).toHaveTextContent(
      `· ${Math.round((width / 768) * 100)}%`
    )
    const fit = last(seen)
    expect(fit?.zoom).toBeLessThan(1)
    // The page inside still lays out at the tablet's width.
    expect((width * 2) / (2 * (fit?.zoom ?? 1))).toBeGreaterThanOrEqual(768)
  })

  it("never hands the page a frame it has not measured", () => {
    stageOf(1200, 700)
    const { seen } = renderStage("phone")
    expect(seen.length).toBeGreaterThan(0)
    // A native surface created from an unmeasured frame would be built at
    // the size of the whole slot, then shrink.
    expect(seen.every((fit) => fit.frame !== null)).toBe(true)
  })

  it("keeps the page mounted while the device changes", () => {
    stageOf(1200, 700)
    let mounts = 0
    function Page() {
      useEffect(() => {
        mounts += 1
      }, [])
      return null
    }
    const stage = (device: StageDevice) =>
      intl(
        <BrowserDeviceStage device={device}>
          {() => <Page />}
        </BrowserDeviceStage>
      )
    const { rerender } = render(stage("desktop"))
    rerender(stage("phone"))
    rerender(stage("tablet"))
    rerender(stage({ width: 1440, height: 900 }))
    rerender(stage({ width: 1024, height: 768 }))
    rerender(stage("desktop"))
    // Rebuilt, a page's native surface would hide and come back every time.
    expect(mounts).toBe(1)
  })

  it("follows the stage's size, and moves its layout key so a centred frame is placed again", () => {
    // jsdom has no ResizeObserver: a stand-in that the test can fire, for
    // the elements that were actually put under observation.
    const observers: Array<{ notify: () => void; targets: Set<Element> }> = []
    vi.stubGlobal(
      "ResizeObserver",
      class {
        private entry: { notify: () => void; targets: Set<Element> }
        constructor(callback: () => void) {
          this.entry = { notify: callback, targets: new Set() }
          observers.push(this.entry)
        }
        observe(target: Element) {
          this.entry.targets.add(target)
        }
        disconnect() {
          this.entry.targets.clear()
        }
      }
    )
    const resize = () =>
      act(() =>
        observers
          .filter(({ targets }) => targets.size > 0)
          .forEach(({ notify }) => notify())
      )
    stageOf(1200, 980)
    const { container, seen } = renderStage("phone")
    const before = last(seen)?.layoutKey
    // Wider only: the phone still fits at its own size, so nothing about the
    // frame changes — but it is centred, so it moved.
    stageOf(1400, 980)
    resize()
    expect(frameOf(container).style.width).toBe("390px")
    expect(last(seen)?.layoutKey).not.toBe(before)
    // Shorter: now it has to shrink.
    stageOf(1400, 500)
    resize()
    // 500 - 32 - 28 = 440 to fit into; snapping the width to whole pixels
    // can leave the height a pixel under that, never over.
    const height = parseFloat(frameOf(container).style.height)
    expect(height).toBeLessThanOrEqual(440)
    expect(height).toBeGreaterThan(438)
    expect(last(seen)?.zoom).toBeLessThan(1)
  })
})

describe("BrowserDeviceStage, custom device", () => {
  const custom = { width: 800, height: 600 }

  beforeEach(() => {
    vi.stubGlobal("devicePixelRatio", 2)
    // 968 × 916 to fit into: the custom device fits at its own size.
    stageOf(1000, 980)
  })
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  function fields() {
    return {
      width: screen.getByRole<HTMLInputElement>("textbox", { name: "Width" }),
      height: screen.getByRole<HTMLInputElement>("textbox", { name: "Height" }),
    }
  }

  it("frames it at its own size, with its size as two fields to change it", () => {
    const onCustomSize = vi.fn()
    const { container, seen } = renderStage(custom, { onCustomSize })
    expect(frameOf(container).style.width).toBe("800px")
    expect(frameOf(container).style.height).toBe("600px")
    expect(last(seen)?.zoom).toBe(1)
    const { width, height } = fields()
    expect(width.value).toBe("800")
    expect(height.value).toBe("600")
    expect(labelOf(container)).toContainElement(width)

    act(() => width.focus())
    fireEvent.change(width, { target: { value: "640" } })
    fireEvent.keyDown(width, { key: "Enter" })
    expect(onCustomSize).toHaveBeenCalledWith({ width: 640, height: 600 })
    expect(width).not.toHaveFocus()

    // Leaving the field keeps what was typed, as Enter does.
    act(() => height.focus())
    fireEvent.change(height, { target: { value: "480" } })
    act(() => height.blur())
    expect(onCustomSize).toHaveBeenLastCalledWith({ width: 800, height: 480 })
  })

  it("puts a typed size back with Escape, drops what is not a number, and holds a size to the range", () => {
    const onCustomSize = vi.fn()
    renderStage(custom, { onCustomSize })
    const { width, height } = fields()

    act(() => height.focus())
    fireEvent.change(height, { target: { value: "123" } })
    expect(height.value).toBe("123")
    fireEvent.keyDown(height, { key: "Escape" })
    expect(height.value).toBe("600")
    expect(height).not.toHaveFocus()

    act(() => width.focus())
    fireEvent.change(width, { target: { value: "wide" } })
    expect(width.value).toBe("")
    act(() => width.blur())
    expect(width.value).toBe("800")
    expect(onCustomSize).not.toHaveBeenCalled()

    act(() => width.focus())
    fireEvent.change(width, { target: { value: "99999" } })
    fireEvent.keyDown(width, { key: "Enter" })
    expect(onCustomSize).toHaveBeenLastCalledWith({ width: 8192, height: 600 })
    act(() => height.focus())
    fireEvent.change(height, { target: { value: "5" } })
    fireEvent.keyDown(height, { key: "Enter" })
    expect(onCustomSize).toHaveBeenLastCalledWith({ width: 800, height: 100 })
  })

  it("steps the size with the arrow keys, by ten with Shift, at once", () => {
    const onCustomSize = vi.fn()
    renderStage(custom, { onCustomSize })
    const { width } = fields()
    act(() => width.focus())
    fireEvent.keyDown(width, { key: "ArrowUp" })
    expect(onCustomSize).toHaveBeenLastCalledWith({ width: 801, height: 600 })
    fireEvent.keyDown(width, { key: "ArrowDown", shiftKey: true })
    expect(onCustomSize).toHaveBeenLastCalledWith({ width: 790, height: 600 })
    // Stepping keeps the field: more steps can follow.
    expect(width).toHaveFocus()
  })

  it("shows the size as text when there is nothing to change it with", () => {
    const { container } = renderStage(custom)
    expect(screen.queryByRole("textbox")).toBeNull()
    expect(labelOf(container)).toHaveTextContent(/^800 × 600$/)
  })

  it("says at what size a device too large for the slot is laid out", () => {
    // 468 × 340 to fit 3840 × 2160 into: less than a quarter of it.
    stageOf(500, 400)
    const big = { width: 3840, height: 2160 }
    const { container, unmount } = renderStage(big)
    const short = container.querySelector("[data-browser-device-short]")
    const match = /laid out at \u2066?(\d+) × (\d+)\u2069?$/.exec(
      short?.textContent ?? ""
    )
    expect(match).not.toBeNull()
    const [laidOutWidth, laidOutHeight] = [
      Number(match?.[1]),
      Number(match?.[2]),
    ]
    expect(laidOutWidth).toBeLessThan(3840)
    expect(laidOutWidth / laidOutHeight).toBeCloseTo(3840 / 2160, 1)
    unmount()

    // A frame element is scaled as far as it takes: nothing to say.
    const scaled = renderStage(big, { minZoom: 0 })
    expect(
      scaled.container.querySelector("[data-browser-device-short]")
    ).toBeNull()
    scaled.unmount()

    // Nor for a device the slot does show whole, shrunk or not.
    stageOf(1200, 700)
    expect(
      renderStage("tablet").container.querySelector(
        "[data-browser-device-short]"
      )
    ).toBeNull()
  })
})
