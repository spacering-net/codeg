"use client"

/**
 * A message's actions — stop the reply being written, quote, copy — offered
 * in two places, the same ones with the same icons:
 * - a small bar the message's frame floats under its bubble: the time
 *   nearest the bubble's edge, a hairline, the buttons after it (mirrored on
 *   the owner's side). The time is the clock alone, the time lines in the
 *   list carrying the day; its tooltip has the date (and, for a reply, how
 *   long it took).
 * - the menu a right-click on the bubble opens (a long press, on touch):
 *   the actions by name, after "copy the selection" when some of the bubble
 *   is selected, and at its foot the date and time in full — the time for
 *   the messages that show no bar.
 */

import { useRef, useState } from "react"
import { useLocale, useTranslations } from "next-intl"
import { Check, Copy, Reply, Square, TextSelect } from "lucide-react"
import { toast } from "sonner"

import {
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
} from "@/components/ui/context-menu"
import { SyncedSpinner } from "@/components/ui/synced-spinner"
import { useCopiedFlag } from "@/hooks/use-copied-flag"
import { useElapsedLabel } from "@/hooks/use-elapsed-label"
import { personalAgentCancel } from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"
import { useBotId } from "@/contexts/personal-agent-context"
import { cn, copyTextFromMenu, copyTextToClipboard } from "@/lib/utils"

import { usePageScope } from "./shared"

/** What a message's actions act on. */
export interface MessageActionsSpec {
  rowId: number
  /** What copy copies; no copy without it. */
  text: string | null
  at: string
  durationMs?: number | null
  /** The reply the turn in flight writes: it can be stopped from here. */
  live?: boolean
}

/** `14:32`, `昨天 09:10`, `11月3日 18:05` — how the list writes a time, in
 *  the page's language (as every time on the page is). */
export function useMessageTime(): (iso: string) => string {
  const t = useTranslations("PersonalAgent.time")
  const locale = useLocale()
  return (iso) => {
    const at = new Date(iso)
    if (Number.isNaN(at.getTime())) return ""
    const now = new Date()
    const clock = clockOf(iso, locale)
    const startOfDay = (d: Date) =>
      new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
    const days = Math.round((startOfDay(now) - startOfDay(at)) / 86_400_000)
    if (days === 0) return clock
    if (days === 1) return t("yesterday", { time: clock })
    const date = at.toLocaleDateString(locale, {
      month: "short",
      day: "numeric",
      ...(at.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {}),
    })
    return `${date} ${clock}`
  }
}

/** `14:32` — a message's clock time. */
function clockOf(iso: string, locale: string): string {
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return ""
  return at.toLocaleTimeString(locale, {
    hour: "2-digit",
    minute: "2-digit",
  })
}

/** `2026年11月5日 14:32 · 用时 12秒` — when, in full, and how long a reply
 *  took. */
function useWhen(at: string, durationMs?: number | null): string {
  const t = useTranslations("PersonalAgent.actions")
  const locale = useLocale()
  const elapsed = useElapsedLabel()
  const date = new Date(at)
  if (Number.isNaN(date.getTime())) return ""
  const time = date.toLocaleString(locale, {
    dateStyle: "medium",
    timeStyle: "short",
  })
  const took = durationMs != null ? elapsed(durationMs) : null
  return took ? t("timeTook", { time, took }) : time
}

function stopReply(botId: number | null): Promise<void> {
  return personalAgentCancel(botId).catch((e) => {
    toast.error(toErrorMessage(e))
  })
}

/** Only the icon's colour answers a hover — no fill behind it. A 20px
 *  target inside the bar's 22px. */
const BUTTON =
  "inline-flex size-5 items-center justify-center rounded-full text-muted-foreground transition-colors hover:text-foreground focus-visible:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"

/** Stop the turn writing this reply (the status line has one too, for a
 *  turn that has not written yet). */
export function StopButton() {
  const t = useTranslations("PersonalAgent.actions")
  const botId = useBotId()
  const [busy, setBusy] = useState(false)
  return (
    <button
      type="button"
      className={BUTTON}
      disabled={busy}
      onClick={() => {
        setBusy(true)
        void stopReply(botId).finally(() => setBusy(false))
      }}
      title={t("stop")}
      aria-label={t("stop")}
    >
      {busy ? (
        <SyncedSpinner small className="size-3.5" />
      ) : (
        <Square className="size-3 fill-current" />
      )}
    </button>
  )
}

export function MessageActions({
  rowId,
  text,
  at,
  durationMs,
  live,
  side,
}: MessageActionsSpec & {
  /** The bubble's side of the column: the actions read away from it. */
  side: "start" | "end"
}) {
  const t = useTranslations("PersonalAgent.actions")
  const { onQuote, readOnly } = usePageScope()
  const locale = useLocale()
  const [copied, markCopied] = useCopiedFlag()
  const when = useWhen(at, durationMs)
  const clock = clockOf(at, locale)
  return (
    <div
      className={cn(
        // A small bar of its own over what is below: the popover surface,
        // a hairline and a soft shadow.
        "flex h-6 items-center gap-0.5 rounded-full border border-border/70 bg-popover px-1 text-[0.6875rem] whitespace-nowrap text-muted-foreground shadow-xs",
        side === "end" && "flex-row-reverse"
      )}
    >
      {clock ? (
        <>
          <span className="px-1 tabular-nums" title={when}>
            {clock}
          </span>
          <span aria-hidden className="mx-0.5 h-3 w-px bg-border" />
        </>
      ) : null}
      {live && !readOnly ? <StopButton /> : null}
      {readOnly ? null : (
        <button
          type="button"
          className={BUTTON}
          onClick={() => onQuote(rowId)}
          title={t("quote")}
          aria-label={t("quote")}
        >
          <Reply className="size-3.5 rtl:-scale-x-100" />
        </button>
      )}
      {text ? (
        <button
          type="button"
          className={BUTTON}
          onClick={() => {
            void copyTextToClipboard(text).then((ok) => {
              if (ok) markCopied()
            })
          }}
          title={copied ? t("copied") : t("copy")}
          aria-label={copied ? t("copied") : t("copy")}
        >
          {copied ? (
            <Check className="size-3.5" />
          ) : (
            <Copy className="size-3.5" />
          )}
        </button>
      ) : null}
    </div>
  )
}

/** What the menu shows, drawn only while it is open. */
function MenuItems({
  spec,
  selection,
  onQuoted,
}: {
  spec: MessageActionsSpec
  selection: string
  onQuoted: () => void
}) {
  const t = useTranslations("PersonalAgent.actions")
  const botId = useBotId()
  const { onQuote, readOnly } = usePageScope()
  const when = useWhen(spec.at, spec.durationMs)
  // The menu that confirmed it is gone by the time the copy lands.
  const copy = (text: string) => {
    void copyTextFromMenu(text).then((ok) => {
      if (ok) toast.success(t("copied"))
      else toast.error(t("copyFailed"))
    })
  }
  const stop = spec.live && !readOnly
  const any = Boolean(selection) || stop || !readOnly || Boolean(spec.text)
  return (
    <>
      {selection ? (
        <ContextMenuItem onSelect={() => copy(selection)}>
          <TextSelect />
          {t("copySelection")}
        </ContextMenuItem>
      ) : null}
      {stop ? (
        <ContextMenuItem onSelect={() => void stopReply(botId)}>
          {/* The bar's filled square, at its size against the 16px icons. */}
          <Square className="size-4 scale-75 fill-current" />
          {t("stop")}
        </ContextMenuItem>
      ) : null}
      {readOnly ? null : (
        <ContextMenuItem
          onSelect={() => {
            onQuoted()
            onQuote(spec.rowId)
          }}
        >
          <Reply className="rtl:-scale-x-100" />
          {t("quote")}
        </ContextMenuItem>
      )}
      {spec.text ? (
        <ContextMenuItem onSelect={() => copy(spec.text!)}>
          <Copy />
          {t("copy")}
        </ContextMenuItem>
      ) : null}
      {when ? (
        <>
          {any ? <ContextMenuSeparator /> : null}
          <p
            data-pa-menu-time
            className="cursor-default px-3 pt-1 pb-1.5 text-xs text-muted-foreground tabular-nums select-none"
          >
            {when}
          </p>
        </>
      ) : null}
    </>
  )
}

/**
 * The menu a right-click on a message's bubble opens: its actions, the same
 * as the bar's. `selection` is what of the bubble was selected when it
 * opened, offered to copy first.
 */
export function MessageMenu({
  spec,
  selection,
  onFocusInside,
}: {
  spec: MessageActionsSpec
  selection: string
  /** Focus came to the menu or one of its items. */
  onFocusInside?: () => void
}) {
  // Quoting puts the caret in the composer: closing leaves it there, rather
  // than handing focus back to what had it before the menu.
  const quoted = useRef(false)
  return (
    <ContextMenuContent
      className="min-w-44"
      onFocus={onFocusInside}
      onCloseAutoFocus={(event) => {
        if (quoted.current) event.preventDefault()
        quoted.current = false
      }}
    >
      <MenuItems
        spec={spec}
        selection={selection}
        onQuoted={() => {
          quoted.current = true
        }}
      />
    </ContextMenuContent>
  )
}
