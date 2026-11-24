"use client"

/**
 * The one frame every status strip docked under the composer is drawn with:
 * the in-flight retry line, the AIR retry-incident strip and the muted
 * "recovered" line — the dock only ever shows progress (see
 * `ComposerStatusStrips`). Same height, icon slot, title rhythm, details
 * disclosure and close button, so they read as one family. Tone carries the
 * meaning:
 *
 * - `warning` (amber) — degraded but being handled: a retry in flight.
 * - `muted` — settled; a transient confirmation.
 */

import { useState, type ReactNode } from "react"
import { useTranslations } from "next-intl"
import { ChevronDown, ChevronRight, X, type LucideIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

export type DockStripTone = "warning" | "muted"

const TONE_CLASSES: Record<DockStripTone, string> = {
  warning:
    "border-amber-500/30 bg-amber-500/10 py-2 text-xs text-amber-700 dark:text-amber-300",
  muted: "border-border/50 bg-muted/30 py-1.5 text-2xs text-muted-foreground",
}

const DISMISS_CLASSES: Record<DockStripTone, string> = {
  warning:
    "h-6 w-6 text-amber-700/70 hover:bg-amber-500/20 hover:text-amber-800 dark:text-amber-300/70 dark:hover:text-amber-200",
  muted: "h-5 w-5 text-muted-foreground/70 hover:text-foreground",
}

interface ComposerDockStripProps {
  tone: DockStripTone
  icon: LucideIcon
  /** Extra icon classes — e.g. `animate-spin` for the retry spinner. */
  iconClassName?: string
  /** The strip's one line (medium weight except on the muted tone). */
  title: string
  /** Hover text for the line; defaults to the line itself. */
  hint?: string
  /** Small trailing note, e.g. "+2 more". */
  meta?: ReactNode
  /** Body of the expandable disclosure; no chevron when absent. */
  details?: string | null
  /** Close button; omitted when there is no handler. */
  onDismiss?: () => void
  /** `status` for progress; none for the muted line. */
  role?: "status"
}

export function ComposerDockStrip({
  tone,
  icon: Icon,
  iconClassName,
  title,
  hint,
  meta,
  details,
  onDismiss,
  role,
}: ComposerDockStripProps) {
  const t = useTranslations("Folder.chat.sessionFailure")
  const [expanded, setExpanded] = useState(false)
  const muted = tone === "muted"
  const DetailsChevron = expanded ? ChevronDown : ChevronRight
  return (
    <div role={role} className={cn("border-t px-4", TONE_CLASSES[tone])}>
      <div className="flex items-center gap-2">
        <Icon
          aria-hidden="true"
          className={cn(
            "shrink-0",
            muted ? "h-3 w-3" : "h-3.5 w-3.5",
            iconClassName
          )}
        />
        <span className="min-w-0 flex-1 truncate" title={hint ?? title}>
          <span className={muted ? undefined : "font-medium"}>{title}</span>
        </span>
        {meta}
        {details && (
          <button
            type="button"
            aria-label={t("toggleDetails")}
            aria-expanded={expanded}
            className="shrink-0 rounded p-0.5 opacity-70 hover:opacity-100"
            onClick={() => setExpanded((v) => !v)}
          >
            <DetailsChevron aria-hidden="true" className="h-3.5 w-3.5" />
          </button>
        )}
        {onDismiss && (
          <Button
            size="icon"
            variant="ghost"
            className={cn("shrink-0", DISMISS_CLASSES[tone])}
            onClick={onDismiss}
            aria-label={t("dismiss")}
          >
            <X
              aria-hidden="true"
              className={muted ? "h-3 w-3" : "h-3.5 w-3.5"}
            />
          </Button>
        )}
      </div>
      {expanded && details && (
        <p className="mt-1.5 ps-[1.375rem] text-2xs whitespace-pre-wrap break-words opacity-80">
          {details}
        </p>
      )}
    </div>
  )
}
