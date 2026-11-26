import { cn } from "@/lib/utils"

/** A "Beta" capsule beside a feature's name (the sidebar's "Assistants"
 *  title, the quick-actions menu's personal-assistant row). A product
 *  mark, so the same word in every language; in the sidebar's count-badge
 *  geometry, primary-tinted. */
export function BetaBadge({ className }: { className?: string }) {
  return (
    <span
      data-beta-badge
      className={cn(
        "inline-flex h-[0.9375rem] shrink-0 items-center rounded-full bg-primary/10 px-1.5 text-[0.625rem] leading-none font-medium text-primary",
        className
      )}
    >
      Beta
    </span>
  )
}
