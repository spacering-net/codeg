"use client"

/**
 * The first setup's screen: the whole page, over a soft wash of the face's
 * colour (a picture's: the theme's) that follows the face as it is picked
 * (`pa-setup-*` in globals.css). Its own width decides how it is laid out,
 * not the window's — the side panels take their share of the window:
 *
 * - narrow, one column in the middle — the face and name, the agent, then
 *   [Chat with your agent] — the page scrolling when it is taller;
 * - wide enough (56rem of its own), two halves: the face and name with
 *   [Chat with your agent] under them on the left, held in the middle of
 *   the height; the agent on the right, which alone scrolls when its
 *   options make it taller, its scrollbar at the page's edge (the left
 *   scrolls too, but only in a frame too short to hold it).
 *
 * The scrollbars are the workspace's own (`ScrollArea`), as the sidebar's
 * conversation list has them.
 */

import { useEffect, useRef, useState } from "react"

import { ScrollArea } from "@/components/ui/scroll-area"
import type { BotColor } from "@/lib/types"

/** From this width of its own, in rem, it is two halves. */
const WIDE_REM = 56

/** Whether `el` is at least `rem` root ems wide, kept as it is resized. */
export function useWide(el: React.RefObject<HTMLElement | null>, rem: number) {
  const [wide, setWide] = useState(false)
  useEffect(() => {
    const node = el.current
    if (!node || typeof ResizeObserver === "undefined") return
    const measure = () => {
      const root =
        parseFloat(getComputedStyle(document.documentElement).fontSize) || 16
      setWide(node.getBoundingClientRect().width >= rem * root)
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(node)
    return () => ro.disconnect()
  }, [el, rem])
  return wide
}

const ENTER =
  "duration-500 motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-3"

export function SetupFrame({
  face,
  identity,
  agent,
  start,
  onSubmit,
  overlay,
}: {
  /** The face's colour; `null` for a picture. */
  face: BotColor | null
  /** Its face and name. */
  identity: React.ReactNode
  /** Its agent's card. */
  agent: React.ReactNode
  /** [Chat with your agent] and the line under it. */
  start: React.ReactNode
  onSubmit: () => void
  /** Outside the form (a dialog of its own). */
  overlay?: React.ReactNode
}) {
  const rootRef = useRef<HTMLDivElement>(null)
  const wide = useWide(rootRef, WIDE_REM)
  const form = (className: string, children: React.ReactNode) => (
    <form
      className={className}
      data-pa-settings-page="identity"
      data-pa-setup
      data-pa-setup-layout={wide ? "wide" : "narrow"}
      onSubmit={(event) => {
        event.preventDefault()
        onSubmit()
      }}
    >
      {children}
    </form>
  )

  return (
    <div
      ref={rootRef}
      className="relative h-full min-h-0 overflow-hidden"
      data-pa-face={face ?? undefined}
      data-pa-setup-frame
      data-wide={wide || undefined}
    >
      <div
        aria-hidden
        className="pa-setup-wash pointer-events-none absolute inset-0"
      />
      {wide ? (
        form(
          "relative grid h-full grid-cols-2",
          <>
            {/* Its face and name, and on to its conversation: held in the
                middle of the height, whatever the right half does — a
                scroller of its own only for a frame too short to hold it,
                so [Chat] can always be reached. */}
            <ScrollArea className="h-full min-h-0">
              <div className="flex min-h-full items-center justify-end ps-6 pe-8 py-10">
                <div
                  className={`flex w-full max-w-[25rem] flex-col items-center ${ENTER}`}
                >
                  {identity}
                  <div className="mt-8 flex w-full max-w-xs flex-col">
                    {start}
                  </div>
                </div>
              </div>
            </ScrollArea>
            {/* Its agent: alone scrolling when taller than the page. */}
            <ScrollArea className="h-full min-h-0">
              <div className="flex min-h-full flex-col ps-8 pe-6 py-14">
                <div className={`my-auto w-full max-w-[25rem] ${ENTER}`}>
                  {agent}
                </div>
              </div>
            </ScrollArea>
          </>
        )
      ) : (
        <ScrollArea className="relative h-full">
          {/* Auto margins centre the column, and still let a taller one
              scroll from its top (centring with justify-content would cut
              it off). */}
          <div className="flex min-h-full flex-col px-6 py-14">
            {form(
              `m-auto flex w-full max-w-[26rem] flex-col items-center ${ENTER}`,
              <>
                {identity}
                <div className="mt-9 w-full">{agent}</div>
                <div className="mt-5 flex w-full flex-col">{start}</div>
              </>
            )}
          </div>
        </ScrollArea>
      )}
      {overlay}
    </div>
  )
}
