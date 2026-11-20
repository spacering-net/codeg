"use client"

import type { ReactNode } from "react"
import { TriangleAlert } from "lucide-react"

/**
 * Small pieces the kinds' actions share (`prompt-detail.tsx`,
 * `assistant-detail.tsx`): the actions sit in the detail's heading, in a row
 * that wraps, and what they have to say goes on a line of its own under them.
 */

/** An action that did not work, said under the buttons. */
export function ActionAlert({ children }: { children: ReactNode }) {
  return (
    <div
      role="alert"
      className="flex min-w-0 basis-full items-start gap-1.5 text-xs text-foreground"
    >
      <TriangleAlert
        aria-hidden="true"
        className="mt-px size-3.5 shrink-0 text-tone-warning"
      />
      <div className="min-w-0">{children}</div>
    </div>
  )
}

/**
 * Give the focus back to the button that copied, if the copy took it away.
 * The legacy copy path — a page served over plain HTTP — focuses a hidden
 * field and removes it, which leaves the focus nowhere.
 */
export function refocus(button: HTMLElement): void {
  const active = document.activeElement
  if (!active || active === document.body) {
    button.focus({ preventScroll: true })
  }
}
