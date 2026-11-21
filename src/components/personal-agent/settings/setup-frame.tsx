"use client"

/**
 * The first setup's screen: the whole page, its content in a narrow column
 * in the middle, over a soft wash of the face's colour (a picture's: the
 * theme's) that follows the face as it is picked (`pa-setup-*` in
 * globals.css). Scrolls when the agent's
 * options make it taller than the window.
 */

import type { BotColor } from "@/lib/types"

export function SetupFrame({
  face,
  children,
}: {
  /** The face's colour; `null` for a picture. */
  face: BotColor | null
  children: React.ReactNode
}) {
  return (
    <div
      className="relative h-full min-h-0 overflow-hidden"
      data-pa-face={face ?? undefined}
      data-pa-setup-frame
    >
      <div
        aria-hidden
        className="pa-setup-wash pointer-events-none absolute inset-0"
      />
      {/* Auto margins centre the column, and still let a taller one scroll
          from its top (centring with justify-content would cut it off). */}
      <div className="relative flex h-full flex-col overflow-x-hidden overflow-y-auto px-6 py-14">
        <div className="m-auto flex w-full max-w-[26rem] flex-col items-center duration-500 motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-3">
          {children}
        </div>
      </div>
    </div>
  )
}
