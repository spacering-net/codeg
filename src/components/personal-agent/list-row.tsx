/**
 * A list's row, as the morning brief draws one — an assistant's list
 * (`PaItemCard`), last night's tidy-ups, the brief codeg writes itself:
 * whom or what it is about first (a face, an icon), then what it is — its
 * subject on a small quiet line over what about it — and what to do about
 * it at its end. No surface of its own: a hairline over and under each row,
 * one between two.
 */

import type { LucideIcon } from "lucide-react"

import { cn } from "@/lib/utils"

/** A row's own classes: on every row the line over it, on the last the one
 *  under it too — one row alone is set off above and below. */
export const LIST_ROW =
  "flex w-full min-w-0 items-start gap-3 border-t border-border/60 py-3 last:border-b"

/** The body and the actions of a row: the actions at its end, under the
 *  body when the row is too narrow for both. */
export const ROW_MAIN =
  "flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-2"
export const ROW_BODY =
  "flex min-h-8 min-w-0 flex-[1_1_12rem] flex-col justify-center gap-0.5 break-words"
/** Its buttons: as wide as their words, no wider than the row — under the
 *  body they wrap within it. */
export const ROW_ACTIONS =
  "flex max-w-full min-w-0 shrink-0 flex-wrap items-center gap-2"

/** A row's subject, over what about it: smaller and quieter. */
export const ROW_HEAD = "text-xs leading-4 text-muted-foreground"
export const ROW_TEXT = "text-sm leading-5"

/** The longest a line's subject runs before its colon (in characters) for
 *  it to be one. */
const HEAD_MAX = 60

/** What ends a sentence — a subject has none of it. */
const SENTENCE_END = /[。！？；\n]|[.!?;](?:\s|$)/u

/**
 * A row's line as its subject and what about it, when it is written so —
 * "任务 #1 · 改标题：失败，等了 8 天", "Dev: waiting 3 days for you" — split at
 * the first colon (a full-width one, or one a space follows); `null` for a
 * line that is not (no colon, a subject that is a sentence or runs long,
 * nothing on one side).
 */
export function splitLine(text: string): { head: string; text: string } | null {
  const m = /：|:\s/u.exec(text)
  if (!m) return null
  const head = text.slice(0, m.index).trim()
  const rest = text.slice(m.index + m[0].length).trim()
  if (!head || !rest) return null
  if ([...head].length > HEAD_MAX || SENTENCE_END.test(head)) return null
  return { head, text: rest }
}

/** A row's two lines: its subject, then what about it. */
export function RowLines({
  head,
  text,
}: {
  head?: React.ReactNode
  text: React.ReactNode
}) {
  return (
    <>
      {head != null && head !== "" ? <p className={ROW_HEAD}>{head}</p> : null}
      <p className={ROW_TEXT}>{text}</p>
    </>
  )
}

/** A row's lead when no face leads it: the icon of the kind of thing. */
export function RowIcon({
  icon: Icon,
  className,
}: {
  icon: LucideIcon
  className?: string
}) {
  return (
    <span
      className={cn(
        "flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground",
        className
      )}
    >
      <Icon className="size-4" aria-hidden />
    </span>
  )
}
