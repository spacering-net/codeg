import { act, fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"

// Radix arms its document-level pointer-down listener in a `setTimeout(0)`.
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

// jsdom has no `PointerEvent`, so `fireEvent.pointerDown` yields a bare `Event`
// with no `button` — which Radix reads to tell a left-click apart. Dispatch a
// real `MouseEvent` under the pointer-event name instead.
function fireMouse(target: Element, type: string) {
  fireEvent(
    target,
    new MouseEvent(type, { bubbles: true, cancelable: true, button: 0 })
  )
}

/**
 * A full left-click. Radix's `deferPointerDownOutside` decides on the `click`,
 * not the `pointerdown` — the gap between them is where a press that only
 * dismissed a nested menu used to take the dialog down with it.
 */
function click(target: Element) {
  fireMouse(target, "pointerdown")
  fireMouse(target, "pointerup")
  fireMouse(target, "click")
}

function DialogWithMenu({
  onOpenChange,
}: {
  onOpenChange: (open: boolean) => void
}) {
  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogTitle>Title</DialogTitle>
        <DropdownMenu>
          <DropdownMenuTrigger>Pick</DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuItem>One</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </DialogContent>
    </Dialog>
  )
}

describe("dismissing a nested layer inside a dialog / popover", () => {
  it("keeps the dialog open when the press that closes a nested menu lands inside it", async () => {
    const onOpenChange = vi.fn()
    render(<DialogWithMenu onOpenChange={onOpenChange} />)
    await settle()

    fireMouse(screen.getByText("Pick"), "pointerdown")
    expect(screen.getByText("One")).toBeInTheDocument()
    await settle()

    // With the menu open, the dialog's own layer is `pointer-events: none`, so a
    // press anywhere inside the dialog hit-tests through to the overlay (which
    // Radix keeps clickable). Reproduce that target here — jsdom has no hit
    // testing of its own.
    click(document.querySelector("[data-slot=dialog-overlay]")!)
    await settle()

    // The press dismissed the menu. The dialog must survive it.
    expect(screen.queryByText("One")).not.toBeInTheDocument()
    expect(onOpenChange).not.toHaveBeenCalled()
  })

  it("still closes the dialog on a plain outside click", async () => {
    const onOpenChange = vi.fn()
    render(<DialogWithMenu onOpenChange={onOpenChange} />)
    await settle()

    click(document.querySelector("[data-slot=dialog-overlay]")!)
    await settle()

    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it("still closes the dialog on a later outside click, once the menu is gone", async () => {
    const onOpenChange = vi.fn()
    render(<DialogWithMenu onOpenChange={onOpenChange} />)
    await settle()

    fireMouse(screen.getByText("Pick"), "pointerdown")
    await settle()
    click(document.querySelector("[data-slot=dialog-overlay]")!)
    await settle()
    expect(onOpenChange).not.toHaveBeenCalled()

    // Second click: nothing is shielding the dialog any more.
    click(document.querySelector("[data-slot=dialog-overlay]")!)
    await settle()
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it("keeps a popover open when the press that closes a nested menu lands inside it", async () => {
    const onOpenChange = vi.fn()
    render(
      <Popover open onOpenChange={onOpenChange}>
        <PopoverTrigger>Open</PopoverTrigger>
        <PopoverContent>
          <DropdownMenu>
            <DropdownMenuTrigger>Pick</DropdownMenuTrigger>
            <DropdownMenuContent>
              <DropdownMenuItem>One</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </PopoverContent>
      </Popover>
    )
    await settle()

    fireMouse(screen.getByText("Pick"), "pointerdown")
    expect(screen.getByText("One")).toBeInTheDocument()
    await settle()

    // A non-modal popover has no overlay of its own, so the shielded press
    // lands on whatever is behind it — here the document body.
    click(document.body)
    await settle()

    expect(screen.queryByText("One")).not.toBeInTheDocument()
    expect(onOpenChange).not.toHaveBeenCalled()
  })

  it("still closes a popover on a plain outside click", async () => {
    const onOpenChange = vi.fn()
    render(
      <Popover open onOpenChange={onOpenChange}>
        <PopoverTrigger>Open</PopoverTrigger>
        <PopoverContent>Body</PopoverContent>
      </Popover>
    )
    await settle()

    click(document.body)
    await settle()

    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it("still honours a caller's own ref and onPointerDownOutside", async () => {
    const contentRef = { current: null as HTMLDivElement | null }
    const onPointerDownOutside = vi.fn()
    render(
      <Dialog open>
        <DialogContent
          ref={contentRef}
          onPointerDownOutside={onPointerDownOutside}
        >
          <DialogTitle>Title</DialogTitle>
        </DialogContent>
      </Dialog>
    )
    await settle()
    expect(contentRef.current).toBeInstanceOf(HTMLElement)

    click(document.querySelector("[data-slot=dialog-overlay]")!)
    await settle()

    expect(onPointerDownOutside).toHaveBeenCalledTimes(1)
  })
})
