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
import { dueWhen, humanDuration } from "./due-text"

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

/** A time as a row says it, against now. */
export function useWhen(): (iso: string) => string {
  const tw = useActivityTranslate()
  const locale = useLocale()
  return (iso) => dueWhen(tw, iso, Date.now(), locale)
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

/** A message's matter, as codeg writes it: who it waits on, and what was
 *  written. */
const WAITING_ANSWER = /^Waiting for (.+?)'s answer: ([\s\S]*)$/

/** What a message's matter says was written: its summary without codeg's
 *  "waiting for …'s answer" (said on the row's line instead). */
export function messageText(item: ItemInfo): string {
  const m = WAITING_ANSWER.exec(item.summary)
  return m ? m[2]!.trim() : item.summary
}

/** Who a message's matter waits on: its peer's name, or the one codeg's
 *  words carry for an older matter. */
export function peerName(item: ItemInfo): string {
  const name = item.peer?.name?.trim()
  if (name) return name
  return WAITING_ANSWER.exec(item.summary)?.[1]?.trim() ?? ""
}
