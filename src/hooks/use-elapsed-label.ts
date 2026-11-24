"use client"

import { useCallback } from "react"
import { useTranslations } from "next-intl"

import { formatElapsedLabel } from "@/lib/format-elapsed"

/**
 * How long something took, written the way a reply's header and the live turn
 * timer write it (`1m 34s`, `1 分钟 34 秒`), so every duration in a reply reads
 * alike and in the reader's language. Null under a second, which would read
 * as a meaningless `0s`.
 */
export function useElapsedLabel(): (
  ms: number | null | undefined
) => string | null {
  const t = useTranslations("Folder.chat.liveTurnStats")
  return useCallback(
    (ms: number | null | undefined) =>
      ms != null && ms >= 1000 ? formatElapsedLabel(ms, t) : null,
    [t]
  )
}
