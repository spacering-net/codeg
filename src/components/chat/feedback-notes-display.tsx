"use client"

/**
 * Live-feedback notes for the current turn, shown above the composer (styled
 * like the message queue). Notes are sent from the composer "+" menu dialog or,
 * on a pull-channel session, from the composer's mid-turn send.
 *
 * Two readings, keyed on `expired`:
 *
 * * Mid-turn (read-only): each note flips from "waiting" (Clock) to "received"
 *   (Check) once the agent reads it via `check_user_feedback`.
 * * Past the turn: the list holds only the notes the agent never read, says so,
 *   and offers to resend each as an ordinary message or drop it. Without this
 *   the unread ones would simply disappear when the turn ended — the pull
 *   channel is cooperative, so "never read" is an ordinary outcome, not an
 *   error, and it is the user's text that would go with it.
 *
 * Notes are not editable here in either reading.
 */

import { useMemo } from "react"
import { useTranslations } from "next-intl"
import { Check, CircleAlert, Clock, X } from "lucide-react"
import { cn } from "@/lib/utils"
import type { FeedbackItem } from "@/lib/types"

interface FeedbackNotesDisplayProps {
  notes: FeedbackItem[]
  /** Render the expired form: the turn ended with these notes still unread.
   *  Requires `onResend`/`onDismiss` to be actionable. */
  expired?: boolean
  /** Send an expired note's text as an ordinary message and retire its row. */
  onResend?: (id: string) => void
  /** Retire an expired note's row without sending it. */
  onDismiss?: (id: string) => void
}

export function FeedbackNotesDisplay({
  notes,
  expired = false,
  onResend,
  onDismiss,
}: FeedbackNotesDisplayProps) {
  const t = useTranslations("LiveFeedback")

  // Stable chronological order regardless of snapshot/live arrival order
  // (`created_at` is ISO 8601, so a string compare sorts by time).
  const ordered = useMemo(
    () => [...notes].sort((a, b) => a.created_at.localeCompare(b.created_at)),
    [notes]
  )

  if (ordered.length === 0) return null

  return (
    <div className="max-h-28 overflow-y-auto pb-1">
      {expired && (
        <div className="px-1.5 pb-1 text-3xs leading-none text-muted-foreground">
          {t("turnEndedUnread")}
        </div>
      )}
      <div className="flex flex-col gap-0.5">
        {ordered.map((note) => {
          const delivered = note.status === "delivered"
          return (
            <div
              key={note.id}
              className={cn(
                "flex items-center gap-1 rounded-md border px-1.5 py-1 text-3xs leading-none select-none [text-box-trim:both] [text-box-edge:cap_alphabetic]",
                expired
                  ? "border-amber-500/40 bg-amber-500/5"
                  : "bg-muted/40 border-border/70"
              )}
              title={note.text}
            >
              {expired ? (
                <CircleAlert className="h-3 w-3 shrink-0 text-amber-500" />
              ) : delivered ? (
                <Check
                  className="h-3 w-3 shrink-0 text-emerald-500"
                  aria-hidden
                />
              ) : (
                <Clock
                  className="h-3 w-3 shrink-0 text-muted-foreground/70"
                  aria-hidden
                />
              )}
              <span className="min-w-0 flex-1 truncate text-3xs text-foreground/80">
                {note.text}
              </span>
              {expired ? (
                <>
                  <button
                    type="button"
                    onClick={() => onResend?.(note.id)}
                    className="shrink-0 rounded-sm px-1 py-0.5 text-3xs font-medium text-foreground/80 hover:bg-muted-foreground/15"
                  >
                    {t("sendAsMessage")}
                  </button>
                  <button
                    type="button"
                    onClick={() => onDismiss?.(note.id)}
                    className="shrink-0 rounded-sm p-0.5 text-muted-foreground hover:bg-muted-foreground/15"
                    title={t("dismiss")}
                  >
                    <X className="h-2.5 w-2.5" />
                  </button>
                </>
              ) : (
                <span className="shrink-0 text-muted-foreground">
                  {delivered ? t("delivered") : t("pending")}
                </span>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
