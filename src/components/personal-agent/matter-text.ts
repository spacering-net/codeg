/**
 * An assistant's matters in the owner's words (C1): who has it and how long
 * it has waited, what a button will do and what it did, and why codeg
 * refused — every line names who does what (you, the assistant, the one it
 * wrote to), never a ledger number or a kind's name.
 *
 * Times the backend hands over (a refusal's `when`) are RFC 3339; they are
 * written here, in the owner's zone and language, as the rows write theirs.
 */

import { useLocale, useTranslations } from "next-intl"

import { extractAppCommandError } from "@/lib/app-error"
import type { ItemInfo } from "@/lib/types"

import { useActivityTranslate } from "./activity-text"
import { dueWhen, dueWhenInSentence, humanDuration } from "./due-text"

/** How long since `iso`, in a few words: "just now", "3 min", "2 h". */
export function useWaited(): (iso: string, now: number) => string {
  const tw = useActivityTranslate()
  const t = useTranslations("PersonalAgent.matter.meta")
  return (iso, now) => {
    const secs = Math.max(0, (now - Date.parse(iso)) / 1000)
    if (!Number.isFinite(secs) || secs < 60) return t("justNow")
    return humanDuration(tw, secs)
  }
}

/** How long since `iso` as a length of time — "1 min" at the least, never
 *  "just now" — for a sentence that says it waited that long ("waiting
 *  {wait}", "已等 {wait}"). */
export function useWaitedFor(): (iso: string, now: number) => string {
  const tw = useActivityTranslate()
  return (iso, now) => {
    const secs = Math.max(0, (now - Date.parse(iso)) / 1000)
    return humanDuration(tw, Number.isFinite(secs) ? secs : 0)
  }
}

/** A time as a row says it, against now. */
export function useWhen(): (iso: string) => string {
  const tw = useActivityTranslate()
  const locale = useLocale()
  return (iso) => dueWhen(tw, iso, Date.now(), locale)
}

/** A due time as it reads inside a sentence ("reminds you at 15:00"). */
export function useWhenInSentence(): (iso: string) => string {
  const tw = useActivityTranslate()
  const locale = useLocale()
  return (iso) => dueWhenInSentence(tw, iso, Date.now(), locale)
}

/** The words of a key under `PersonalAgent` with the data the backend gave
 *  it: its times written as a row writes them, a name it did not have
 *  (an assistant with none) as the page names one. `null` when there are
 *  no such words. */
export function useWorded(): (
  key: string,
  params?: Record<string, string> | null
) => string | null {
  const t = useTranslations("PersonalAgent")
  const when = useWhen()
  return (key, params) => {
    const values: Record<string, string> = {}
    for (const [k, v] of Object.entries(params ?? {})) {
      values[k] = k === "when" ? when(v) || v : v
    }
    if ("bot" in values && !values.bot) values.bot = t("title")
    if ("peer" in values && !values.peer) values.peer = t("matter.meta.someone")
    try {
      const words = t(key as "title", values)
      return words && words !== key && words !== `PersonalAgent.${key}`
        ? words
        : null
    } catch {
      return null
    }
  }
}

/** What went wrong, in the owner's language when codeg said which words
 *  (its English otherwise). */
export function useMatterError(): (e: unknown) => string {
  const worded = useWorded()
  return (e) => {
    const err = extractAppCommandError(e)
    if (err?.i18n_key) {
      const words = worded(err.i18n_key, err.i18n_params)
      if (words) return words
    }
    if (err) return err.detail?.trim() || err.message
    return e instanceof Error ? e.message : String(e)
  }
}

/** What a message's matter says was written, as the backend reads it off
 *  the message's line (`written`), and whether it was written to this
 *  assistant (`in`) rather than by it; `null` when the read carries no
 *  line (shown as its summary). */
export function messageWords(m: {
  written?: string | null
  direction?: "in" | "out" | null
}): { text: string; toMe: boolean } | null {
  if (m.written == null) return null
  return { text: m.written, toMe: m.direction === "in" }
}

/** What a message's matter says was written: its words, or — no line in
 *  the read — its summary. */
export function messageText(item: ItemInfo): string {
  return messageWords(item)?.text ?? item.summary
}

/** Who a message's matter waits on (or came from): its peer's name. */
export function peerName(item: ItemInfo): string {
  return item.peer?.name?.trim() ?? ""
}
