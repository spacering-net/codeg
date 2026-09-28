"use client"

import { useCallback } from "react"
import { useTranslations } from "next-intl"

import type { PageHandoffBlock } from "./page-handoff-block"

/**
 * The name the composer gave something the built-in browser handed over —
 * the same `Browser.handoff.chip*` string its badge carried when it was sent
 * (`BrowserSendToChatControl`, `BrowserScreenshotMarkupHost`), for a message
 * read back from an agent's record, where only the block survives.
 */
export function usePageHandoffName(): (handoff: PageHandoffBlock) => string {
  const t = useTranslations("Browser.handoff")
  return useCallback(
    (handoff: PageHandoffBlock) => {
      switch (handoff.kind) {
        case "element":
          return handoff.label || t("chipElement")
        case "screenshot":
          return t(handoff.marked ? "chipMarkedScreenshot" : "chipScreenshot")
        case "console":
          return t("chipConsole", { count: handoff.count })
      }
    },
    [t]
  )
}
