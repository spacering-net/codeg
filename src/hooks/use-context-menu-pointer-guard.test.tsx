import { fireEvent, render, renderHook, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu"
import { useContextMenuPointerGuard } from "./use-context-menu-pointer-guard"

/**
 * jsdom's `fireEvent.pointerDown` drops `pointerType` (it builds a plain
 * MouseEvent), so the property is pinned by hand — the guard reads exactly
 * that field to distinguish a native text-selection long-press from a mouse
 * right-click.
 */
function pointerDown(element: Element, pointerType: string) {
  const event = new MouseEvent("pointerdown", {
    bubbles: true,
    cancelable: true,
  })
  Object.defineProperty(event, "pointerType", { value: pointerType })
  fireEvent(element, event)
}

function renderGuarded(onContextMenu: (event: Event) => void) {
  const { result } = renderHook(() => useContextMenuPointerGuard())

  return render(
    <div onContextMenu={onContextMenu}>
      <div data-testid="trigger" {...result.current.triggerProps}>
        <span data-testid="text">message text</span>
      </div>
    </div>
  )
}

describe("useContextMenuPointerGuard", () => {
  it("lets a touch long-press reach the native menu but not the app menu", () => {
    const onContextMenu = vi.fn()
    renderGuarded(onContextMenu)
    const text = screen.getByTestId("text")

    pointerDown(text, "touch")
    const event = fireEvent.contextMenu(text)

    expect(onContextMenu).not.toHaveBeenCalled()
    // Stopping Radix's propagation must not cancel the browser's native
    // selection/image menu, which is the whole point on touch.
    expect(event).toBe(true)
  })

  it("lets a pen long-press reach the native menu but not the app menu", () => {
    const onContextMenu = vi.fn()
    renderGuarded(onContextMenu)
    const text = screen.getByTestId("text")

    pointerDown(text, "pen")
    fireEvent.contextMenu(text)

    expect(onContextMenu).not.toHaveBeenCalled()
  })

  it("keeps a mouse right-click on the app menu", () => {
    const onContextMenu = vi.fn()
    renderGuarded(onContextMenu)
    const text = screen.getByTestId("text")

    pointerDown(text, "mouse")
    fireEvent.contextMenu(text)

    expect(onContextMenu).toHaveBeenCalledTimes(1)
  })

  it("keeps an app-menu shortcut usable when no pointer press preceded it", () => {
    const onContextMenu = vi.fn()
    renderGuarded(onContextMenu)

    fireEvent.contextMenu(screen.getByTestId("text"))

    expect(onContextMenu).toHaveBeenCalledTimes(1)
  })
})

describe("context menu integration", () => {
  function renderRadixGuarded() {
    const { result } = renderHook(() => useContextMenuPointerGuard())

    return render(
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div data-testid="trigger" {...result.current.triggerProps}>
            <span data-testid="text">message text</span>
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem>App action</ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    )
  }

  it("keeps a touch long-press from opening the Radix menu", () => {
    renderRadixGuarded()
    const trigger = screen.getByTestId("trigger")

    pointerDown(trigger, "touch")
    const event = fireEvent.contextMenu(trigger)

    expect(screen.queryByRole("menu")).not.toBeInTheDocument()
    expect(event).toBe(true)
  })

  it("opens the Radix menu for a mouse right-click", () => {
    renderRadixGuarded()
    const trigger = screen.getByTestId("trigger")

    pointerDown(trigger, "mouse")
    fireEvent.contextMenu(trigger)

    expect(screen.getByRole("menu")).toBeInTheDocument()
  })
})
