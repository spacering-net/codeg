"use client"

/**
 * How a card stands, said on its tone — the line a settled card shows
 * where its buttons were (done, put off, taken back, let be), and the
 * short chip beside a card's title. One set of tones for every card:
 * through green, put off or out of date amber, taken back or let be quiet,
 * failed red, a word about it (a draft, a note) quiet with its mark.
 */

import {
  CircleAlert,
  CircleCheck,
  CircleSlash,
  CircleX,
  Clock,
  Info,
  Undo2,
  type LucideIcon,
} from "lucide-react"

import { cn } from "@/lib/utils"

export type OutcomeTone =
  | "done"
  | "later"
  | "warn"
  | "back"
  | "off"
  | "failed"
  | "info"

const TONE: Record<OutcomeTone, { icon: LucideIcon; text: string }> = {
  done: { icon: CircleCheck, text: "text-emerald-700 dark:text-emerald-400" },
  later: { icon: Clock, text: "text-amber-700 dark:text-amber-400" },
  warn: { icon: CircleAlert, text: "text-amber-700 dark:text-amber-400" },
  back: { icon: Undo2, text: "text-muted-foreground" },
  off: { icon: CircleSlash, text: "text-muted-foreground" },
  failed: { icon: CircleX, text: "text-red-700 dark:text-red-400" },
  info: { icon: Info, text: "text-muted-foreground" },
}

/** A line of how it stands, its tone's mark leading it. */
export function OutcomeLine({
  tone,
  icon,
  className,
  children,
  ...props
}: {
  tone: OutcomeTone
  /** Another mark than the tone's own. */
  icon?: LucideIcon
  children: React.ReactNode
} & Omit<React.ComponentProps<"p">, "children">) {
  const Icon = icon ?? TONE[tone].icon
  return (
    <p
      data-pa-outcome={tone}
      className={cn(
        "flex min-w-0 items-start gap-1.5 text-xs leading-5 [overflow-wrap:anywhere]",
        TONE[tone].text,
        className
      )}
      {...props}
    >
      <Icon className="mt-[0.1875rem] size-3.5 shrink-0" aria-hidden />
      <span className="min-w-0">{children}</span>
    </p>
  )
}

export type ChipTone = "emerald" | "sky" | "amber" | "red" | "muted"

const CHIP: Record<ChipTone, string> = {
  emerald: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  sky: "bg-sky-500/15 text-sky-700 dark:text-sky-300",
  amber: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
  red: "bg-red-500/15 text-red-700 dark:text-red-300",
  muted: "bg-muted text-muted-foreground",
}

/** A short state in a word, on its tone: the chips every card shares. */
export function ToneChip({
  tone,
  className,
  ...props
}: { tone: ChipTone } & React.ComponentProps<"span">) {
  return (
    <span
      className={cn(
        "inline-flex h-5 shrink-0 items-center rounded-full px-2 text-[0.6875rem] font-medium whitespace-nowrap",
        CHIP[tone],
        className
      )}
      {...props}
    />
  )
}
