import { act, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { toast } from "sonner"

vi.mock("next-themes", () => ({
  useTheme: () => ({ resolvedTheme: "light" }),
}))

import { AppToaster } from "./app-toaster"
import {
  isNativeSurfaceOccluded,
  isNativeSurfaceOcclusionPassive,
  requestNativeSurfaceReclaim,
  resetNativeSurfaceOcclusionForTests,
} from "@/lib/browser/native-surface-occlusion"

/**
 * The toaster must live in the BODY, not where it is mounted. Every dialog
 * portals to the body at z-50, while the workspace shell's root is
 * `fixed inset-0` — a stacking context that would cap sonner's z-index no
 * matter how large it is. A toast raised from an open dialog (the error that
 * explains why a button did nothing) painted underneath it.
 */
describe("AppToaster", () => {
  it("mounts the toaster on the body rather than in the tree that renders it", async () => {
    const { container } = render(
      <div id="shell" className="fixed inset-0">
        <AppToaster position="bottom-right" />
      </div>
    )

    // Sonner's own container is not inside the (stacking-context-forming)
    // shell that rendered it…
    expect(container.querySelector("section[aria-live='polite']")).toBeNull()

    toast.error("project folder is on 'feature'")
    const message = await screen.findByText("project folder is on 'feature'")
    // …and neither is the toast it raises.
    expect(container.contains(message)).toBe(false)
    expect(message.closest("#shell")).toBeNull()
    expect(document.body.contains(message)).toBe(true)
  })
})

/**
 * A toast raised over a built-in browser tab is not behind the page in any
 * way a z-index could fix: a child webview is a native view painted above
 * every DOM element of the window. The toaster therefore holds a passive
 * occlusion lease for as long as a toast is on screen — see
 * `native-surface-occlusion` for what the hosts do with "passive".
 */
describe("AppToaster occlusion", () => {
  beforeEach(() => {
    toast.dismiss()
    resetNativeSurfaceOcclusionForTests()
  })
  afterEach(() => {
    toast.dismiss()
    resetNativeSurfaceOcclusionForTests()
  })

  it("holds the browser surfaces down while a toast is on screen", async () => {
    render(<AppToaster position="bottom-right" />)
    expect(isNativeSurfaceOccluded()).toBe(false)

    const id = toast.error("the folder moved")
    await screen.findByText("the folder moved")
    await waitFor(() => expect(isNativeSurfaceOccluded()).toBe(true))
    // Passive: nobody opened this, so the page keeps the keyboard and gets a
    // say in how long it lasts.
    expect(isNativeSurfaceOcclusionPassive()).toBe(true)

    await act(async () => {
      toast.dismiss(id)
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    await waitFor(() => expect(isNativeSurfaceOccluded()).toBe(false))
  })

  it("takes the toasts away when a page is reached for", async () => {
    render(<AppToaster position="bottom-right" />)
    toast.message("a background task finished")
    await screen.findByText("a background task finished")
    await waitFor(() => expect(isNativeSurfaceOccluded()).toBe(true))

    await act(async () => {
      requestNativeSurfaceReclaim()
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    await waitFor(() => expect(isNativeSurfaceOccluded()).toBe(false))
  })
})
