import { useRef } from "react"
import { act, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu"
import { useTouchSelectionMenuGuard } from "./use-touch-selection-menu-guard"

/**
 * jsdom has no PointerEvent, so build MouseEvents and attach `pointerType`
 * (same pattern as use-long-press-to-open-menu.test.tsx).
 */
function pointer(
  type: "pointerdown" | "pointerup",
  target: Element,
  pointerType: "mouse" | "touch" | "pen"
) {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    button: pointerType === "mouse" ? 2 : 0,
  })
  Object.defineProperty(event, "pointerType", { value: pointerType })
  act(() => {
    target.dispatchEvent(event)
  })
}

function contextMenu(target: Element) {
  act(() => {
    target.dispatchEvent(
      new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        button: 2,
      })
    )
  })
}

function selectText(node: Node) {
  const range = document.createRange()
  range.selectNodeContents(node)
  const selection = window.getSelection()!
  selection.removeAllRanges()
  selection.addRange(range)
}

function Panel({ guarded }: { guarded: boolean }) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const guard = useTouchSelectionMenuGuard(containerRef)
  const rootProps = guarded
    ? { open: guard.open, onOpenChange: guard.onOpenChange }
    : {}
  return (
    <ContextMenu {...rootProps}>
      <ContextMenuTrigger asChild>
        <div
          ref={containerRef}
          data-testid="panel"
          onPointerDownCapture={
            guarded ? guard.onPointerDownCapture : undefined
          }
        >
          <p data-testid="text">some transcript text</p>
          <div data-testid="blank" />
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem>New conversation</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}

const menuItem = () => screen.queryByText("New conversation")

describe("useTouchSelectionMenuGuard", () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    window.getSelection()?.removeAllRanges()
    vi.useRealTimers()
  })

  /** Touch long-press on text: browser selects the word, then holds on. */
  function longPressText(text: Element) {
    pointer("pointerdown", text, "touch")
    selectText(text)
    act(() => {
      vi.advanceTimersByTime(700)
    })
  }

  it("without the guard, a touch long-press on text opens the menu over the selection (the bug)", () => {
    render(<Panel guarded={false} />)
    longPressText(screen.getByTestId("text"))
    expect(menuItem()).not.toBeNull()
  })

  it("does not open the menu on Radix's touch long-press timer when text got selected", () => {
    render(<Panel guarded />)
    longPressText(screen.getByTestId("text"))
    expect(menuItem()).toBeNull()
  })

  it("does not open the menu on Android's native contextmenu after a touch selection", () => {
    render(<Panel guarded />)
    const text = screen.getByTestId("text")
    pointer("pointerdown", text, "touch")
    selectText(text)
    contextMenu(text)
    expect(menuItem()).toBeNull()
  })

  it("still opens on a touch long-press over blank space with nothing selected", () => {
    render(<Panel guarded />)
    pointer("pointerdown", screen.getByTestId("blank"), "touch")
    act(() => {
      vi.advanceTimersByTime(700)
    })
    expect(menuItem()).not.toBeNull()
  })

  it("still opens on a mouse right-click, even over selected text", () => {
    render(<Panel guarded />)
    const text = screen.getByTestId("text")
    selectText(text)
    pointer("pointerdown", text, "mouse")
    contextMenu(text)
    expect(menuItem()).not.toBeNull()
  })

  it("ignores a selection outside the trigger", () => {
    const outside = document.createElement("p")
    outside.textContent = "elsewhere"
    document.body.appendChild(outside)
    try {
      render(<Panel guarded />)
      pointer("pointerdown", screen.getByTestId("blank"), "touch")
      selectText(outside)
      act(() => {
        vi.advanceTimersByTime(700)
      })
      expect(menuItem()).not.toBeNull()
    } finally {
      outside.remove()
    }
  })
})
