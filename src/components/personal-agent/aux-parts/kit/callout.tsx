"use client"

/** What a card says, in a box of its tone: neutral on the muted fill,
 *  waiting on the owner amber, an error red — an error's own text in the
 *  code face. Four lines at most, the whole of it on hover. */

import type { ReactNode } from "react"

import { cn } from "@/lib/utils"

export type CalloutTone = "neutral" | "wait" | "error"

const TONE: Record<CalloutTone, string> = {
  neutral: "bg-muted text-foreground/85",
  wait: "bg-amber-500/10 text-foreground dark:bg-amber-400/10",
  error: "bg-red-500/10 text-red-700 dark:text-red-300",
}

export function Callout({
  tone,
  mono = false,
  className,
  children,
}: {
  tone: CalloutTone
  /** In the code face (an error's text). */
  mono?: boolean
  className?: string
  children: ReactNode
}) {
  return (
    <div
      data-pa-callout={tone}
      title={typeof children === "string" ? children : undefined}
      className={cn(
        "min-w-0 rounded-lg px-3 py-2 text-xs leading-5 break-words whitespace-pre-line",
        TONE[tone],
        mono && "font-mono text-xs leading-5",
        className
      )}
    >
      {/* Clamped inside the padding, so no fifth line shows under it. */}
      <span className="line-clamp-4">{children}</span>
    </div>
  )
}
