"use client"

import { useTranslations } from "next-intl"

import { cn } from "@/lib/utils"

/**
 * The count chip trailing the Harness entry in the sidebar and in the
 * quick-actions menu: how many installed Harness items have an update.
 *
 * Same chip as the To-dos count beside it, in the same primary tint — updates
 * waiting are something to get to, not something that went wrong (that is the
 * Automations badge, in the destructive tint).
 *
 * A bare number says nothing about what is being counted, so the chip also
 * carries the sentence: as its tooltip, and as the text assistive tech reads in
 * place of the digit — the row's name becomes "Harness 3 updates available".
 */
export function HarnessUpdatesBadge({
  count,
  className,
}: {
  count: number
  className?: string
}) {
  const t = useTranslations("Harness")
  const label = t("updatesAvailable", { count })

  return (
    <span
      title={label}
      className={cn(
        "inline-flex h-[0.9375rem] min-w-[0.9375rem] shrink-0 items-center justify-center rounded-full bg-primary/10 px-1 font-mono text-[0.625rem] font-medium leading-none text-primary",
        className
      )}
    >
      <span aria-hidden="true">{count}</span>
      <span className="sr-only">{label}</span>
    </span>
  )
}
