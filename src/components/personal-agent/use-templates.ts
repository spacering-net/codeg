"use client"

import { useEffect, useState } from "react"
import { useLocale } from "next-intl"

import { personalAgentTemplates } from "@/lib/api"
import type { BotTemplate } from "@/lib/types"

/** The templates in each language asked for, read once a session. */
const cache = new Map<string, Promise<BotTemplate[]>>()

/** The templates in `locale`, read once (and shared with the hook). */
export function loadBotTemplates(locale: string): Promise<BotTemplate[]> {
  let p = cache.get(locale)
  if (!p) {
    p = personalAgentTemplates(locale).catch((e) => {
      cache.delete(locale)
      throw e
    })
    cache.set(locale, p)
  }
  return p
}

/** The work assistants' templates (4.13), in the UI's language; `null`
 *  until read. */
export function useBotTemplates(): BotTemplate[] | null {
  const locale = useLocale()
  const [list, setList] = useState<{
    locale: string
    templates: BotTemplate[]
  } | null>(null)
  useEffect(() => {
    let live = true
    loadBotTemplates(locale)
      .then((templates) => {
        if (live) setList({ locale, templates })
      })
      .catch(() => {})
    return () => {
      live = false
    }
  }, [locale])
  return list?.locale === locale ? list.templates : null
}

export function __resetTemplatesForTests(): void {
  cache.clear()
}
