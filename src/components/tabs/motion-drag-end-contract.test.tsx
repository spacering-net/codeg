import { describe, expect, it, vi } from "vitest"
import { act, render, waitFor } from "@testing-library/react"
import { Reorder } from "motion/react"

/**
 * Dependency contract guard for issue #769 — "sticky" session tabs.
 *
 * Motion tears a drag gesture down from listeners it installs on `window`, not
 * on the dragged element. Up to and including 12.40.x those listeners were
 * registered in the BUBBLE phase, so any descendant calling
 * `event.stopPropagation()` on `pointerup` / `pointercancel` kept the release
 * from ever reaching `window`: `onDragStart` fired, `onDragEnd` never did, and
 * the element stayed latched to the pointer. On the top tab strip that reads as
 * a tab that will not let go after a click.
 *
 * Motion 12.41.0 moved those listeners to the CAPTURE phase (upstream #2794),
 * where nothing below `window` can pre-empt them; 13.x carries the same fix.
 * The repair therefore lives entirely in the dependency version, which means a
 * lockfile refresh, a resolution change or a downgrade can silently reintroduce
 * the bug with no source diff to notice. This test fails on 12.34.0 (the
 * version 0.30.10 shipped) and passes on any build that has the fix.
 *
 * Scope of the claim: the mechanism below is bisected against the upstream
 * tarballs and reproduces #769's symptom exactly, but the specific descendant
 * in the live tab subtree that swallows the release was never pinned down, and
 * 12.35–12.43 carry two further drag repairs ("draggable elements when layout
 * updates due to surrounding element re-renders", and preserving in-flight drag
 * values across React 19 reorder unmount/remount) that could contribute to the
 * same report. This guards the one failure mode we can pin behaviourally.
 *
 * The damage is app-wide, not just to the one tab: Motion holds a MODULE-LEVEL
 * per-axis drag lock (`motion-dom`'s `setDragLock`) that is released ONLY by the
 * gesture teardown — `stop()` / `cancel()`, the same path that fires
 * `onDragEnd`. Unmounting does not release it (`DragGesture.unmount` skips
 * `endPanSession` outright while a drag is live, and `endPanSession` leaves the
 * lock alone in any case), and nothing here calls `dragControls.cancel()`. So a
 * single stranded gesture leaves `isDragging.x` latched and no `drag="x"`
 * element anywhere — either tab strip included — can start a drag for the rest
 * of the page's life. That is also why the second case below reports a missing
 * `onDragStart` rather than a missing `onDragEnd` on an affected build: the
 * first case already ate the lock.
 *
 * `TabItem` drives `Reorder.Item` exactly this way (`drag="x"` over a subtree of
 * interactive descendants), so the group/item pair is the faithful shape to
 * assert against rather than a bare `motion.div`.
 */

// jsdom 25 still ships no `PointerEvent` constructor. Along this path Motion
// reads only `type`, `clientX`/`clientY`, `button`, `pointerType` and
// `isPrimary`, so a `MouseEvent` carrying a pointer event's type name exercises
// the same code: `pointerType` is undefined, which sends `isPrimaryPointer`
// down its non-mouse branch, where an undefined `isPrimary` counts as primary.
const pointerEvent = (type: string, clientX: number, clientY: number) =>
  new MouseEvent(type, { bubbles: true, cancelable: true, clientX, clientY })

/** Motion's pan threshold is 3px; 40px clears it without ambiguity. */
const DRAG_DISTANCE_PX = 40

/**
 * Drives a full press → drag → release and hands back the spies. Motion starts
 * and ends the gesture on its own frame loop, so each step is polled rather than
 * slept on — a fixed delay would either be slack under parallel-worker load or
 * needlessly slow. Failing to reach the drag START throws here, which is the
 * correct outcome: a build that cannot begin the gesture has nothing to assert.
 */
async function dragAndRelease(
  releaseType: "pointerup" | "pointercancel",
  onDragStart: ReturnType<typeof vi.fn>,
  onDragEnd: ReturnType<typeof vi.fn>
) {
  const { getByTestId } = render(
    <Reorder.Group as="div" axis="x" values={["a"]} onReorder={() => {}}>
      <Reorder.Item
        as="div"
        value="a"
        drag="x"
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
      >
        {/* Stands in for any descendant that swallows the release — the close
            button, a Radix trigger, a nested control. */}
        <button
          type="button"
          data-testid="child"
          onPointerUp={(event) => event.stopPropagation()}
          onPointerCancel={(event) => event.stopPropagation()}
        />
      </Reorder.Item>
    </Reorder.Group>
  )

  const child = getByTestId("child")

  await act(async () => {
    child.dispatchEvent(pointerEvent("pointerdown", 0, 0))
  })
  await act(async () => {
    window.dispatchEvent(pointerEvent("pointermove", DRAG_DISTANCE_PX, 0))
  })
  await waitFor(() => expect(onDragStart).toHaveBeenCalled())

  await act(async () => {
    child.dispatchEvent(pointerEvent(releaseType, DRAG_DISTANCE_PX, 0))
  })
}

describe("Motion drag-end contract (issue #769)", () => {
  it("ends the drag when a descendant stops pointerup propagation", async () => {
    const onDragStart = vi.fn()
    const onDragEnd = vi.fn()

    await dragAndRelease("pointerup", onDragStart, onDragEnd)

    // Guards the guard: unless the gesture genuinely started, a satisfied
    // release assertion would mean nothing.
    expect(onDragStart).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(onDragEnd).toHaveBeenCalledTimes(1))
  })

  it("ends the drag when a descendant stops pointercancel propagation", async () => {
    const onDragStart = vi.fn()
    const onDragEnd = vi.fn()

    await dragAndRelease("pointercancel", onDragStart, onDragEnd)

    expect(onDragStart).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(onDragEnd).toHaveBeenCalledTimes(1))
  })
})
