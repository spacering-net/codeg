import { act, render, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it } from "vitest"

import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import { Drawer, DrawerContent, DrawerTitle } from "@/components/ui/drawer"
import {
  isNativeSurfaceOccluded,
  nativeSurfaceOcclusionHolders,
  resetNativeSurfaceOcclusionForTests,
} from "@/lib/browser/native-surface-occlusion"

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

/** A transcript in a drawer (the task board's), a session viewer stacked on
 *  it, and the browser viewer stacked on that — with room for a dialog
 *  opened over the page. */
function Stack({
  pageOpen,
  dialogOpen = false,
}: {
  pageOpen: boolean
  dialogOpen?: boolean
}) {
  return (
    <Drawer open swipeDirection="right">
      <DrawerContent>
        <DrawerTitle>Task</DrawerTitle>
        <Drawer open swipeDirection="right">
          <DrawerContent>
            <DrawerTitle>Session</DrawerTitle>
            <Drawer open={pageOpen} swipeDirection="right">
              <DrawerContent nativeSurfaceHost>
                <DrawerTitle>Page</DrawerTitle>
                <Dialog open={dialogOpen}>
                  <DialogContent>
                    <DialogTitle>Over the page</DialogTitle>
                  </DialogContent>
                </Dialog>
              </DrawerContent>
            </Drawer>
          </DrawerContent>
        </Drawer>
      </DrawerContent>
    </Drawer>
  )
}

/** The task detail sheet's shape: its transcript drawer sits under the
 *  sheet's root but BESIDE its content — nested all the same, as far as Base
 *  UI is concerned — and the browser viewer opens inside the transcript. */
function DetailStack({ pageOpen }: { pageOpen: boolean }) {
  return (
    <Drawer open swipeDirection="right">
      <DrawerContent>
        <DrawerTitle>Task detail</DrawerTitle>
      </DrawerContent>
      <Drawer open swipeDirection="right">
        <DrawerContent>
          <DrawerTitle>Transcript</DrawerTitle>
          <Drawer open={pageOpen} swipeDirection="right">
            <DrawerContent nativeSurfaceHost>
              <DrawerTitle>Page</DrawerTitle>
            </DrawerContent>
          </Drawer>
        </DrawerContent>
      </Drawer>
    </Drawer>
  )
}

describe("drawer occlusion leases", () => {
  beforeEach(() => {
    resetNativeSurfaceOcclusionForTests()
  })

  it("holds a lease while open, and none for a drawer hosting a page", async () => {
    const { rerender } = render(
      <Drawer open swipeDirection="right">
        <DrawerContent>
          <DrawerTitle>Task</DrawerTitle>
        </DrawerContent>
      </Drawer>
    )
    await settle()
    expect(nativeSurfaceOcclusionHolders()).toEqual({ drawer: 1 })

    rerender(
      <Drawer open swipeDirection="right">
        <DrawerContent nativeSurfaceHost>
          <DrawerTitle>Page</DrawerTitle>
        </DrawerContent>
      </Drawer>
    )
    await settle()
    expect(isNativeSurfaceOccluded()).toBe(false)
  })

  // The page is in front of every drawer below it: none of them may hide it,
  // and each takes its lease back once the page's drawer is gone.
  it("lifts the lease of every drawer a page's drawer is stacked on while it is open", async () => {
    const { rerender } = render(<Stack pageOpen={false} />)
    await settle()
    expect(nativeSurfaceOcclusionHolders()).toEqual({ drawer: 2 })

    rerender(<Stack pageOpen />)
    await settle()
    expect(isNativeSurfaceOccluded()).toBe(false)

    rerender(<Stack pageOpen={false} />)
    await waitFor(() =>
      expect(nativeSurfaceOcclusionHolders()).toEqual({ drawer: 2 })
    )
  })

  it("lifts the lease of a drawer stacked on beside its content", async () => {
    const { rerender } = render(<DetailStack pageOpen={false} />)
    await settle()
    expect(nativeSurfaceOcclusionHolders()).toEqual({ drawer: 2 })

    rerender(<DetailStack pageOpen />)
    await settle()
    expect(isNativeSurfaceOccluded()).toBe(false)

    rerender(<DetailStack pageOpen={false} />)
    await waitFor(() =>
      expect(nativeSurfaceOcclusionHolders()).toEqual({ drawer: 2 })
    )
  })

  it("still lets an overlay opened over the page hide it", async () => {
    const { rerender } = render(<Stack pageOpen />)
    await settle()
    expect(isNativeSurfaceOccluded()).toBe(false)

    rerender(<Stack pageOpen dialogOpen />)
    await settle()
    expect(nativeSurfaceOcclusionHolders()).toEqual({ dialog: 1 })

    rerender(<Stack pageOpen />)
    await waitFor(() => expect(isNativeSurfaceOccluded()).toBe(false))
  })

  it("gives nothing back to drawers that closed underneath the page", async () => {
    const { rerender } = render(<Stack pageOpen />)
    await settle()
    expect(isNativeSurfaceOccluded()).toBe(false)

    rerender(<></>)
    await waitFor(() => expect(isNativeSurfaceOccluded()).toBe(false))
    expect(nativeSurfaceOcclusionHolders()).toEqual({})
  })
})
