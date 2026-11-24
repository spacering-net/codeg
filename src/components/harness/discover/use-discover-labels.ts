"use client"

import { useMemo } from "react"
import { useLocale, useTranslations } from "next-intl"

import {
  harnessLang,
  knownKind,
  knownRisk,
  pickLocalized,
  RUNTIME_PROPER_NAMES,
  TRANSLATED_RUNTIMES,
  type HarnessLang,
} from "@/lib/harness/display"
import type { HarnessConfig } from "@/lib/harness/types"

export interface DiscoverLabels {
  /** The interface locale, for formatting numbers and dates. */
  locale: string
  /** The catalog language that locale reads. */
  lang: HarnessLang
  /** A kind's name; "Unknown kind" for one this build has not heard of. */
  kind: (kind: string) => string
  risk: (risk: string) => string
  /** A runtime's name; the catalog's own spelling for one with no name here. */
  runtime: (id: string) => string
  /** A tag's name from the catalog's configuration, else its id. */
  tag: (id: string, config: HarnessConfig | null) => string
}

/**
 * The words for the catalog's own vocabulary — kinds, risks, runtimes, tags —
 * in the interface language, with an answer for every value the catalog can
 * send, including ones added after this build.
 */
export function useDiscoverLabels(): DiscoverLabels {
  const t = useTranslations("Harness.discover")
  const locale = useLocale()
  return useMemo(() => {
    const lang = harnessLang(locale)
    return {
      locale,
      lang,
      kind: (kind) => t(`kind.${knownKind(kind) ?? "unknown"}`),
      risk: (risk) => t(`risk.${knownRisk(risk) ?? "unknown"}`),
      runtime: (id) => {
        const translated = TRANSLATED_RUNTIMES.find((known) => known === id)
        if (translated) return t(`runtimes.${translated}`)
        return RUNTIME_PROPER_NAMES.get(id) ?? id
      },
      tag: (id, config) =>
        pickLocalized(config?.tags.find((tag) => tag.id === id)?.name, lang) ??
        id,
    }
  }, [t, locale])
}
