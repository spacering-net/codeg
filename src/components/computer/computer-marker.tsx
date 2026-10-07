"use client"

/**
 * The mark an agent's action leaves where it landed: a ring that opens and
 * fades around the spot, with a pointer for a click or a scroll and a caret
 * for typing. Drawn in its own small window (`computer-marker`) that codeg
 * moves onto the spot, shows for a moment and hides again; clicks pass
 * through it. Violet, the colour codeg marks an agent's doings with.
 *
 * Each mark carries a new id, so a second click on the same spot plays
 * again rather than being taken for the first.
 */

import { useEffect, useState } from "react"
import { MousePointer2, TextCursor } from "lucide-react"

import { subscribe } from "@/lib/platform"
import {
  COMPUTER_MARKER_EVENT,
  type ComputerAction,
  type ComputerMarkerPayload,
} from "@/lib/computer/types"

/** Painted before any script runs, so the window is never a square. */
const TRANSPARENT = "html,body{background:transparent!important}"

const WRITES: ReadonlySet<ComputerAction> = new Set([
  "type",
  "key",
  "set-value",
])

export function ComputerMarker() {
  const [mark, setMark] = useState<ComputerMarkerPayload | null>(null)

  useEffect(() => {
    let disposed = false
    let unsubscribe: (() => void) | undefined
    void subscribe<ComputerMarkerPayload>(COMPUTER_MARKER_EVENT, setMark)
      .then((fn) => {
        if (disposed) fn()
        else unsubscribe = fn
      })
      .catch(() => {})
    return () => {
      disposed = true
      unsubscribe?.()
    }
  }, [])

  const Glyph = mark && WRITES.has(mark.action) ? TextCursor : MousePointer2

  return (
    <div
      className="pointer-events-none flex h-screen w-screen items-center justify-center"
      aria-hidden="true"
    >
      <style>{TRANSPARENT}</style>
      {mark && (
        <div
          key={mark.id}
          data-action={mark.action}
          className="relative size-24 animate-[computer-marker-fade_1100ms_ease-out_forwards]"
        >
          <span className="absolute inset-0 m-auto size-8 animate-[computer-marker-ring_900ms_ease-out_forwards] rounded-full border-2 border-violet-500" />
          <span className="absolute inset-0 m-auto size-2.5 rounded-full bg-violet-500 shadow-[0_0_0_2px_white]" />
          <Glyph
            className="absolute left-1/2 top-1/2 size-5 fill-violet-500 text-white drop-shadow"
            strokeWidth={1.5}
          />
        </div>
      )}
    </div>
  )
}
