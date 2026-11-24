import { render } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import { Drawer, DrawerContent, DrawerTitle } from "@/components/ui/drawer"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"

function popoverContent() {
  return document.querySelector("[data-slot=popover-content]")
}

/**
 * Where a popover's content lands in the DOM is not cosmetic inside a modal
 * layer: Radix locks page scrolling with `react-remove-scroll`, which whitelists
 * exactly one subtree — the dialog's content, handed to it as a "shard" — and
 * `preventDefault`s every `wheel` whose target falls outside it. Portalled to
 * the body, a popover's list could only be scrolled by dragging its scrollbar.
 */
describe("overlay portal container", () => {
  it("renders a popover inside the dialog that owns it", () => {
    render(
      <Dialog open>
        <DialogContent>
          <DialogTitle>Title</DialogTitle>
          <Popover open>
            <PopoverTrigger>Pick</PopoverTrigger>
            <PopoverContent>Options</PopoverContent>
          </Popover>
        </DialogContent>
      </Dialog>
    )

    const dialog = document.querySelector("[data-slot=dialog-content]")
    const popover = popoverContent()
    expect(dialog).toBeTruthy()
    expect(popover).toBeTruthy()
    expect(dialog!.contains(popover!)).toBe(true)

    // And it costs the dialog no layout: the content is `display: grid` with a
    // gap, so a popper wrapper that ever stopped being out of flow would show
    // up as a phantom row every time the popover opened.
    const wrapper = popover!.closest<HTMLElement>(
      "[data-radix-popper-content-wrapper]"
    )
    expect(wrapper?.style.position).toBe("fixed")
  })

  /**
   * The drawer is non-modal, so it has no scroll lock to escape — its reason is
   * the popup, not the content: the popup carries a `transform`, making it the
   * containing block for `fixed` descendants, while the content in between is
   * `overflow-hidden` and would clip anything portalled into it.
   */
  it("renders a popover inside the popup of the drawer that owns it", () => {
    render(
      <Drawer open>
        <DrawerContent>
          <DrawerTitle>Title</DrawerTitle>
          <Popover open>
            <PopoverTrigger>Pick</PopoverTrigger>
            <PopoverContent>Options</PopoverContent>
          </Popover>
        </DrawerContent>
      </Drawer>
    )

    const popup = document.querySelector("[data-slot=drawer-popup]")
    expect(popup).toBeTruthy()
    expect(popup!.contains(popoverContent()!)).toBe(true)
  })

  it("leaves a popover outside any modal layer on the body", () => {
    const { container } = render(
      <Popover open>
        <PopoverTrigger>Pick</PopoverTrigger>
        <PopoverContent>Options</PopoverContent>
      </Popover>
    )

    // Radix's default: appended to the body, not into the tree that rendered
    // the trigger. Nothing here clips or scroll-locks, so it stays that way.
    expect(popoverContent()).toBeTruthy()
    expect(container.contains(popoverContent())).toBe(false)
  })
})
