"use client"

import { Badge } from "@/components/ui/badge"

interface DropdownRadioItemContentProps {
  label: string
  description?: string | null
  /** Localized "recommended" chip text, or null/absent for the usual row. Set it
   *  only on the value the AGENT recommends (ACP `recommendedValue`) — a claim
   *  independent of what is currently selected, which is the checkmark's job, so
   *  both can land on the same row or on different ones.
   *
   *  Passed in rather than translated here on purpose: every other label this
   *  leaf renders arrives the same way, and the callers all hold a translator
   *  already. */
  recommendedLabel?: string | null
}

export function DropdownRadioItemContent({
  label,
  description,
  recommendedLabel,
}: DropdownRadioItemContentProps) {
  const normalizedDescription = description?.trim()
  const badge = recommendedLabel?.trim()

  return (
    <div className="w-full min-w-0 pr-2" title={label}>
      {/* The badge is `shrink-0` (Badge's own base class) so a long model name
          truncates instead of squeezing the chip away. */}
      <div className="flex min-w-0 items-center gap-1.5">
        <p className="min-w-0 truncate">{label}</p>
        {badge ? (
          <Badge variant="outline" className="px-1 text-3xs font-normal">
            {badge}
          </Badge>
        ) : null}
      </div>
      {normalizedDescription ? (
        <p className="text-muted-foreground mt-0.5 text-xs leading-snug whitespace-pre-wrap wrap-break-word">
          {normalizedDescription}
        </p>
      ) : null}
    </div>
  )
}
