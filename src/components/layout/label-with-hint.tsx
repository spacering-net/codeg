import { cn } from "@/lib/utils"

/** A row's label followed by small muted text saying what the page holds.
 *  The hint is shown whole or not at all: when the row is too narrow for it,
 *  it wraps onto a second line the one-line box clips, and only the label is
 *  cut short. */
export function LabelWithHint({
  label,
  hint,
  className,
}: {
  label: string
  hint: string
  className?: string
}) {
  return (
    <span
      className={cn(
        "flex h-5 min-w-0 flex-wrap items-baseline gap-x-1.5 overflow-hidden leading-5",
        className
      )}
    >
      <span className="max-w-full truncate">{label}</span>
      <span className="shrink-0 text-[0.6875rem] text-muted-foreground">
        {hint}
      </span>
    </span>
  )
}
