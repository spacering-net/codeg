import { act, render } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { useMobileViewport } from "./use-mobile-viewport"

function Surface({ mobile = true }: { mobile?: boolean }) {
  const ref = useMobileViewport(mobile)
  return <div ref={ref} data-testid="surface" />
}

afterEach(() => vi.unstubAllGlobals())

describe("mobile keyboard viewport", () => {
  it("leaves desktop layout and unsupported browsers untouched", () => {
    vi.stubGlobal("visualViewport", undefined)
    const view = render(<Surface />)
    expect(view.getByTestId("surface").style.cssText).toBe("")
    view.rerender(<Surface mobile={false} />)
    expect(view.getByTestId("surface").style.cssText).toBe("")
  })

  it("follows keyboard height and panning while preserving pinch zoom", () => {
    const viewport = Object.assign(new EventTarget(), {
      height: 800,
      offsetTop: 0,
      scale: 1,
    })
    vi.stubGlobal("visualViewport", viewport)
    let scheduled: FrameRequestCallback | undefined
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      scheduled = callback
      return 1
    })
    const view = render(<Surface />)
    const element = view.getByTestId("surface")
    expect(element).toHaveStyle({ height: "800px", top: "0px" })
    act(() => {
      viewport.height = 430
      viewport.offsetTop = 20
      viewport.dispatchEvent(new Event("resize"))
      scheduled?.(0)
    })
    expect(element).toHaveStyle({ height: "430px", top: "20px" })
    act(() => {
      viewport.scale = 2
      viewport.height = 200
      viewport.dispatchEvent(new Event("resize"))
      scheduled?.(0)
    })
    expect(element).toHaveStyle({ height: "430px" })
    view.rerender(<Surface mobile={false} />)
    expect(element.style.height).toBe("")
    expect(element.style.top).toBe("")
  })
})
