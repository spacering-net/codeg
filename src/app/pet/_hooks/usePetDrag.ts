"use client"

import { useCallback, useEffect, useRef } from "react"
import type { PetState } from "@/lib/pet/animation"
import { endPetDrag, startPetDrag } from "@/lib/pet/api"
import { disposeTauriListener } from "@/lib/tauri-listener"
import { isDesktop } from "@/lib/transport"

const CLICK_THRESHOLD_PX = 5
const PET_DRAG_DIRECTION_EVENT = "pet://drag-direction"

export interface UsePetDragOptions {
  /**
   * Fired during drag with the directional running state, or `null` when
   * the cursor stalls (held-still) so the parent can revert to the
   * default animation.
   */
  onDragDirection: (state: PetState | null) => void
  /**
   * Fired on pointer-up when total movement was below the click threshold.
   * Parents typically map this to a one-shot jumping animation.
   */
  onClick: () => void
}

export interface UsePetDragResult {
  onPointerDown: (event: React.PointerEvent) => void
}

interface ActivePointerDrag {
  seq: number
  phase: "starting" | "tracked"
  startX: number
  startY: number
  maxClientTravel: number
}

/**
 * OS-cursor-driven drag controller for the floating pet window.
 *
 * Why drive positioning from Rust (`pet_start_drag` / `pet_end_drag`) instead
 * of per-frame JS `PointerEvent.screenX/Y` + `setPosition`?
 * - Native `WebviewWindow.startDragging()` enters a modal OS run-loop on macOS
 *   and Windows that freezes JS sprite timers mid-drag and hides cursor deltas.
 * - Per-frame JS `screenX/Y` breaks across mixed-DPI displays: on macOS,
 *   `PhysicalPosition` divides by the window's live `scale_factor()` (doubling
 *   coordinates on 2x -> 1x crossings); on Windows, WebView2's `screenX/Y`
 *   jumps mid-drag when `WM_DPICHANGED` changes `devicePixelRatio`.
 * - Polling the OS cursor in Rust at ~120 Hz eliminates per-frame IPC lag,
 *   keeps coordinates in each OS's true global space across monitors, emits
 *   `pet://drag-direction` only on state transitions, and atomically persists
 *   the final `(x, y, scale_factor)` on release.
 */
export function usePetDrag(opts: UsePetDragOptions): UsePetDragResult {
  const activeRef = useRef<ActivePointerDrag | null>(null)
  const seqRef = useRef(0)

  const optsRef = useRef(opts)
  useEffect(() => {
    optsRef.current = opts
  }, [opts])

  // Subscribe once to direction transitions emitted by the Rust drag loop.
  useEffect(() => {
    if (!isDesktop()) return
    let unlisten: (() => void) | null = null
    let cancelled = false

    void (async () => {
      try {
        const { listen } = await import("@tauri-apps/api/event")
        const off = await listen<PetState | null>(
          PET_DRAG_DIRECTION_EVENT,
          (event) => {
            if (cancelled) return
            const payload = event.payload
            optsRef.current.onDragDirection(
              payload === "running_left" || payload === "running_right"
                ? payload
                : null
            )
          }
        )
        if (cancelled) {
          disposeTauriListener(off, "Pet")
        } else {
          unlisten = off
        }
      } catch (err) {
        console.warn("[Pet] drag-direction subscription failed:", err)
      }
    })()

    return () => {
      cancelled = true
      disposeTauriListener(unlisten, "Pet")
    }
  }, [])

  // Track pointer release globally (paired with pointer capture on press) so
  // releasing off-window or before `pet_start_drag` resolves always settles.
  useEffect(() => {
    let disposed = false

    function onPointerMove(e: PointerEvent) {
      const active = activeRef.current
      if (!active || active.phase !== "starting") return
      const dist = Math.hypot(
        e.clientX - active.startX,
        e.clientY - active.startY
      )
      if (dist > active.maxClientTravel) {
        active.maxClientTravel = dist
      }
    }

    function finishPointer(isCancel: boolean) {
      const active = activeRef.current
      if (!active) return
      activeRef.current = null

      if (active.phase === "starting") {
        // Released before `pet_start_drag` resolved; the pending start handler
        // will immediately call `endPetDrag()` once its IPC returns.
        if (!isCancel && active.maxClientTravel < CLICK_THRESHOLD_PX) {
          optsRef.current.onClick()
        } else {
          optsRef.current.onDragDirection(null)
        }
        return
      }

      void endPetDrag()
        .then((res) => {
          if (disposed) return
          if (!isCancel && res.clicked) {
            optsRef.current.onClick()
          } else {
            optsRef.current.onDragDirection(null)
          }
        })
        .catch((err) => {
          console.warn("[Pet] drag end failed:", err)
          if (!disposed) optsRef.current.onDragDirection(null)
        })
    }

    const onPointerUp = () => finishPointer(false)
    const onPointerCancel = () => finishPointer(true)

    window.addEventListener("pointermove", onPointerMove)
    window.addEventListener("pointerup", onPointerUp)
    window.addEventListener("pointercancel", onPointerCancel)
    return () => {
      disposed = true
      if (activeRef.current?.phase === "tracked") {
        void endPetDrag().catch(() => {})
      }
      activeRef.current = null
      window.removeEventListener("pointermove", onPointerMove)
      window.removeEventListener("pointerup", onPointerUp)
      window.removeEventListener("pointercancel", onPointerCancel)
    }
  }, [])

  const onPointerDown = useCallback((event: React.PointerEvent) => {
    if (event.button !== 0) return
    if (!isDesktop()) return
    event.preventDefault()

    try {
      event.currentTarget?.setPointerCapture?.(event.pointerId)
    } catch {
      // Synthetic events or platforms without pointer capture support.
    }

    const seq = ++seqRef.current
    activeRef.current = {
      seq,
      phase: "starting",
      startX: event.clientX,
      startY: event.clientY,
      maxClientTravel: 0,
    }

    void (async () => {
      try {
        const res = await startPetDrag()
        if (activeRef.current?.seq !== seq) {
          if (res.mode === "tracked") {
            void endPetDrag().catch(() => {})
          }
          return
        }

        if (res.mode === "tracked") {
          activeRef.current.phase = "tracked"
          return
        }

        activeRef.current = null
        if (res.mode === "native_os") {
          const { getCurrentWindow } = await import("@tauri-apps/api/window")
          await getCurrentWindow().startDragging()
        }
      } catch (err) {
        console.warn("[Pet] drag start failed:", err)
        if (activeRef.current?.seq === seq) {
          activeRef.current = null
        }
      }
    })()
  }, [])

  return { onPointerDown }
}
