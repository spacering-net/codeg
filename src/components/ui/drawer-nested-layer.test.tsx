import { act, fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import { Drawer, DrawerContent, DrawerTitle } from "@/components/ui/drawer"
import { OverlayHostHiddenProvider } from "@/components/ui/overlay-host-hidden"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

function fireMouse(target: Element, type: string) {
  fireEvent(
    target,
    new MouseEvent(type, { bubbles: true, cancelable: true, button: 0 })
  )
}

function click(target: Element) {
  fireMouse(target, "pointerdown")
  fireMouse(target, "mousedown")
  fireMouse(target, "mouseup")
  fireMouse(target, "click")
}

function popup() {
  return document.querySelector("[data-slot=drawer-popup]")
}

function popups() {
  return document.querySelectorAll("[data-slot=drawer-popup]")
}

/**
 * Every press-based case below opts back into pointer dismissal explicitly.
 *
 * `Drawer` defaults to `disablePointerDismissal`, which suppresses the
 * outside-press path in Base UI entirely — so a guard test written against the
 * default would pass no matter what the guard did, or whether it existed. The
 * guard still has to hold for the drawers that DO opt back in (the mobile
 * navigation panels), and that is what these pin down. Escape is unaffected by
 * the default and is tested as-is.
 */
const DISMISSABLE = { disablePointerDismissal: false } as const

describe("drawer with nested/sibling Radix layers", () => {
  it("stays open when a press lands in a sibling Dialog", async () => {
    const onOpenChange = vi.fn()
    render(
      <>
        <Drawer
          open
          onOpenChange={onOpenChange}
          swipeDirection="right"
          {...DISMISSABLE}
        >
          <DrawerContent>
            <DrawerTitle>Task</DrawerTitle>
            <div>drawer body</div>
          </DrawerContent>
        </Drawer>
        <Dialog open>
          <DialogContent>
            <DialogTitle>Diff</DialogTitle>
            <button type="button">inside dialog</button>
          </DialogContent>
        </Dialog>
      </>
    )
    await settle()

    click(screen.getByText("inside dialog"))
    await settle()

    expect(onOpenChange).not.toHaveBeenCalled()
    expect(popup()).toBeTruthy()
  })

  it("stays open when a press lands in a sibling AlertDialog", async () => {
    const onOpenChange = vi.fn()
    render(
      <>
        <Drawer
          open
          onOpenChange={onOpenChange}
          swipeDirection="right"
          {...DISMISSABLE}
        >
          <DrawerContent>
            <DrawerTitle>Task</DrawerTitle>
          </DrawerContent>
        </Drawer>
        <AlertDialog open>
          <AlertDialogContent>
            <AlertDialogTitle>Delete?</AlertDialogTitle>
            <button type="button">inside alert</button>
          </AlertDialogContent>
        </AlertDialog>
      </>
    )
    await settle()

    click(screen.getByText("inside alert"))
    await settle()

    expect(onOpenChange).not.toHaveBeenCalled()
  })

  it("lets Escape close only the topmost layer", async () => {
    const onOpenChange = vi.fn()
    render(
      <Drawer open onOpenChange={onOpenChange} swipeDirection="right">
        <DrawerContent>
          <DrawerTitle>Task</DrawerTitle>
          <Select defaultValue="one">
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="one">One</SelectItem>
              <SelectItem value="two">Two</SelectItem>
            </SelectContent>
          </Select>
        </DrawerContent>
      </Drawer>
    )
    await settle()

    fireEvent.click(screen.getByRole("combobox"))
    await settle()
    expect(screen.queryByText("Two")).toBeInTheDocument()

    fireEvent.keyDown(document.activeElement ?? document.body, {
      key: "Escape",
    })
    await settle()

    // First Escape dismisses the select only.
    expect(screen.queryByText("Two")).not.toBeInTheDocument()
    expect(onOpenChange).not.toHaveBeenCalled()

    // Second Escape reaches the drawer.
    fireEvent.keyDown(document.activeElement ?? document.body, {
      key: "Escape",
    })
    await settle()
    expect(onOpenChange).toHaveBeenCalledWith(false, expect.anything())
  })

  /**
   * The naive version of the test above passes even with a broken guard,
   * because jsdom batches the state update that tears the Radix layer down. In
   * a real engine a keydown is discrete, so React flushes synchronously between
   * Radix's capture-phase handler and Base UI's bubble-phase one and the
   * `pointer-events` shield is already gone by the time the drawer is asked.
   *
   * This reproduces that ordering directly: a capture listener registered after
   * the drawer's own probe (as a later-mounting Radix layer always is) which
   * drops the shield synchronously. Only a guard that sampled during capture
   * survives it.
   */
  it("survives an Escape whose Radix layer tears the shield down synchronously", async () => {
    const onOpenChange = vi.fn()
    render(
      <Drawer open onOpenChange={onOpenChange} swipeDirection="right">
        <DrawerContent>
          <DrawerTitle>Task</DrawerTitle>
        </DrawerContent>
      </Drawer>
    )
    await settle()

    document.body.style.pointerEvents = "none"
    const teardown = () => {
      document.body.style.pointerEvents = ""
    }
    document.addEventListener("keydown", teardown, true)
    try {
      fireEvent.keyDown(document.body, { key: "Escape" })
      await settle()
    } finally {
      document.removeEventListener("keydown", teardown, true)
      document.body.style.pointerEvents = ""
    }

    expect(onOpenChange).not.toHaveBeenCalled()
    expect(popup()).toBeTruthy()
  })

  it("still closes an opted-in drawer on a plain outside press", async () => {
    const onOutside = vi.fn()
    render(
      <Drawer
        open
        onOpenChange={onOutside}
        swipeDirection="right"
        {...DISMISSABLE}
      >
        <DrawerContent>
          <DrawerTitle>Task</DrawerTitle>
        </DrawerContent>
      </Drawer>
    )
    await settle()
    click(document.body)
    await settle()
    expect(onOutside).toHaveBeenCalledWith(false, expect.anything())
  })
})

/**
 * The house default, pinned from both sides. A drawer is meant to be consulted
 * while the page behind it is worked in — so an ordinary press out there must
 * not take it down — but it must still have an obvious way out, or it is a
 * trap.
 */
describe("drawer default dismissal", () => {
  it("survives an outside press", async () => {
    const onOpenChange = vi.fn()
    render(
      <Drawer open onOpenChange={onOpenChange} swipeDirection="right">
        <DrawerContent>
          <DrawerTitle>Task</DrawerTitle>
        </DrawerContent>
      </Drawer>
    )
    await settle()

    click(document.body)
    await settle()

    expect(onOpenChange).not.toHaveBeenCalled()
    expect(popup()).toBeTruthy()
  })

  it("still closes on Escape", async () => {
    const onOpenChange = vi.fn()
    render(
      <Drawer open onOpenChange={onOpenChange} swipeDirection="right">
        <DrawerContent>
          <DrawerTitle>Task</DrawerTitle>
        </DrawerContent>
      </Drawer>
    )
    await settle()

    fireEvent.keyDown(document.body, { key: "Escape" })
    await settle()

    expect(onOpenChange).toHaveBeenCalledWith(false, expect.anything())
  })
})

/**
 * A drawer portals to the body, so nothing its host does to the host's own DOM
 * subtree reaches it. The workbench relies on exactly that kind of treatment:
 * a full-page route (tasks, automations) leaves the conversation surface
 * MOUNTED and merely `invisible` + `inert` so background sessions keep
 * streaming — and a session viewer opened from that surface went on painting
 * over the route, and went on eating clicks meant for it.
 */
describe("drawer under a hidden host surface", () => {
  function viewport() {
    return document.querySelector("[data-slot=drawer-viewport]")
  }

  it("stops painting and stops taking input, without closing", async () => {
    const onOpenChange = vi.fn()
    render(
      <OverlayHostHiddenProvider hidden>
        <Drawer open onOpenChange={onOpenChange} swipeDirection="right">
          <DrawerContent>
            <DrawerTitle>Session</DrawerTitle>
          </DrawerContent>
        </Drawer>
      </OverlayHostHiddenProvider>
    )
    await settle()

    expect(viewport()).toHaveClass("invisible")
    // Hardens the hidden subtree against descendants that declare their own
    // `visibility: visible` — the same class the host surface uses.
    expect(viewport()).toHaveClass("conversation-tab-hidden")
    expect(viewport()).toHaveAttribute("inert")

    // Hidden, NOT closed: the surface behind it is being preserved too, so
    // switching back has to find the drawer where it was left.
    expect(onOpenChange).not.toHaveBeenCalled()
    expect(popup()).toBeTruthy()
  })

  it("paints normally when the host is visible", async () => {
    render(
      <OverlayHostHiddenProvider hidden={false}>
        <Drawer open swipeDirection="right">
          <DrawerContent>
            <DrawerTitle>Session</DrawerTitle>
          </DrawerContent>
        </Drawer>
      </OverlayHostHiddenProvider>
    )
    await settle()

    expect(viewport()).not.toHaveClass("invisible")
    expect(viewport()).not.toHaveAttribute("inert")
  })

  it("defaults to visible with no provider at all", async () => {
    render(
      <Drawer open swipeDirection="right">
        <DrawerContent>
          <DrawerTitle>Session</DrawerTitle>
        </DrawerContent>
      </Drawer>
    )
    await settle()

    expect(viewport()).not.toHaveClass("invisible")
    expect(viewport()).not.toHaveAttribute("inert")
  })

  /**
   * These subtrees nest for real: the SELECTED conversation tab (hidden=false)
   * sits inside the workspace surface, which is what a full-page route hides.
   * Plain context shadowing would let the inner provider announce "visible" and
   * put the drawer back on screen over the task board.
   */
  it("stays hidden when an inner provider says visible", async () => {
    render(
      <OverlayHostHiddenProvider hidden>
        <OverlayHostHiddenProvider hidden={false}>
          <Drawer open swipeDirection="right">
            <DrawerContent>
              <DrawerTitle>Session</DrawerTitle>
            </DrawerContent>
          </Drawer>
        </OverlayHostHiddenProvider>
      </OverlayHostHiddenProvider>
    )
    await settle()

    expect(viewport()).toHaveClass("invisible")
    expect(viewport()).toHaveAttribute("inert")
  })
})

/**
 * Stacking is the reason the session viewers are drawers rather than dialogs:
 * a sub-agent transcript contains delegation cards that open another sub-agent
 * transcript, and the work-task viewer opens over the task detail sheet. Base
 * UI tracks that through `DialogRootContext`, so it only holds for a drawer
 * mounted in the OPENER's React tree — a sibling gets nothing, which is what
 * `tasks-page.tsx` used to render.
 */
describe("nested drawers", () => {
  it("marks the parent popup while a descendant drawer is open", async () => {
    render(
      <Drawer open swipeDirection="right">
        <DrawerContent>
          <DrawerTitle>Task</DrawerTitle>
          <Drawer open swipeDirection="right">
            <DrawerContent>
              <DrawerTitle>Session</DrawerTitle>
            </DrawerContent>
          </Drawer>
        </DrawerContent>
      </Drawer>
    )
    await settle()

    // Both layers are live, and both are on the body: Base UI's own portal
    // ignores our `OverlayPortalContainerProvider` (only `popover.tsx` reads
    // it), so the child is not clipped by the parent's `overflow-hidden`.
    const all = Array.from(popups())
    expect(all).toHaveLength(2)
    for (const p of all) expect(p.closest("body")).toBe(document.body)

    const parent = all.find((p) => p.textContent?.includes("Task"))
    const child = all.find((p) => p.textContent?.includes("Session"))
    expect(parent).toBeTruthy()
    expect(child).toBeTruthy()
    expect(parent).toHaveAttribute("data-nested-drawer-open")
    expect(child).not.toHaveAttribute("data-nested-drawer-open")
  })

  it("gives a sibling drawer no stacking relationship", async () => {
    render(
      <>
        <Drawer open swipeDirection="right">
          <DrawerContent>
            <DrawerTitle>Task</DrawerTitle>
          </DrawerContent>
        </Drawer>
        <Drawer open swipeDirection="right">
          <DrawerContent>
            <DrawerTitle>Session</DrawerTitle>
          </DrawerContent>
        </Drawer>
      </>
    )
    await settle()

    for (const p of Array.from(popups())) {
      expect(p).not.toHaveAttribute("data-nested-drawer-open")
    }
  })
})
