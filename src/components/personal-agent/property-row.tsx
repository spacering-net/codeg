"use client"

import type { ReactNode } from "react"
import { Check, Copy } from "lucide-react"

import { useCopiedFlag } from "@/hooks/use-copied-flag"
import { copyTextToClipboard } from "@/lib/utils"

/** One label–value row of the personal agent panel's status: a two-column
 *  grid (`grid-cols-[auto_minmax(0,1fr)]`) of label and value, one row per
 *  property, a hairline between rows. */
export function PropertyRow({
  label,
  children,
}: {
  label: string
  children: ReactNode
}) {
  return (
    <div className="group/prop col-span-2 grid grid-cols-subgrid items-center border-b border-border/50 py-1 last:border-b-0">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="flex h-6 min-w-0 items-center gap-1.5 text-foreground">
        {children}
      </dd>
    </div>
  )
}

/** A copy button at the end of a `PropertyRow`: it shows while the row is
 *  hovered or holds focus. */
export function CopyPropertyButton({
  text,
  copyLabel,
  copiedLabel,
}: {
  text: string
  copyLabel: string
  copiedLabel: string
}) {
  const [copied, markCopied] = useCopiedFlag()
  const handleCopy = () => {
    void copyTextToClipboard(text).then((ok) => {
      if (ok) markCopied()
    })
  }
  return (
    <button
      type="button"
      onClick={handleCopy}
      aria-label={copied ? copiedLabel : copyLabel}
      title={copied ? copiedLabel : copyLabel}
      className="-me-1 ms-auto inline-flex size-6 shrink-0 items-center justify-center rounded-full text-muted-foreground opacity-0 transition-opacity hover:bg-muted hover:text-foreground focus-visible:opacity-100 group-hover/prop:opacity-100 group-focus-within/prop:opacity-100"
    >
      {copied ? (
        <Check className="size-3 text-green-500" />
      ) : (
        <Copy className="size-3" />
      )}
    </button>
  )
}
