"use client"

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react"
import { Languages, Loader2, RotateCw } from "lucide-react"
import { useLocale, useTranslations } from "next-intl"

import { Button } from "@/components/ui/button"
import {
  CatalogTranslator,
  catalogTextSources,
  translatedCatalogText,
} from "@/lib/harness/catalog-translation"
import {
  harnessLang,
  itemSummary,
  itemTitle,
  pickLocalized,
} from "@/lib/harness/display"
import type { HarnessItemSummary, HarnessLocalized } from "@/lib/harness/types"
import { ReadmeContent, readmeProse } from "./readme-content"

const ENABLED_KEY = "harness:catalog-translation-enabled"
const CHANGED = "harness:catalog-translation-changed"
const emptyTranslator = new CatalogTranslator()
let temporaryPreference: boolean | undefined

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage
  } catch {
    return null
  }
}

function enabledSnapshot(): boolean {
  if (temporaryPreference !== undefined) return temporaryPreference
  try {
    return storage()?.getItem(ENABLED_KEY) === "1"
  } catch {
    return false
  }
}

function subscribeEnabled(listener: () => void): () => void {
  window.addEventListener("storage", listener)
  window.addEventListener(CHANGED, listener)
  return () => {
    window.removeEventListener("storage", listener)
    window.removeEventListener(CHANGED, listener)
  }
}

interface TranslationContextValue {
  enabled: boolean
  target: string
  translator: CatalogTranslator
  setEnabled: (value: boolean) => void
}

const TranslationContext = createContext<TranslationContextValue>({
  enabled: false,
  target: "en",
  translator: emptyTranslator,
  setEnabled: () => {},
})

export function CatalogTranslationProvider({
  children,
}: {
  children: ReactNode
}) {
  const locale = useLocale()
  const [translator] = useState(() => new CatalogTranslator(storage()))
  const enabled = useSyncExternalStore(
    subscribeEnabled,
    enabledSnapshot,
    () => false
  )
  useEffect(() => () => translator.cancel(), [translator])
  const value = useMemo(
    () => ({
      enabled,
      target: locale,
      translator,
      setEnabled: (next: boolean) => {
        try {
          const persistent = storage()
          if (persistent) {
            persistent.setItem(ENABLED_KEY, next ? "1" : "0")
            temporaryPreference = undefined
          } else temporaryPreference = next
        } catch {
          temporaryPreference = next
        }
        window.dispatchEvent(new Event(CHANGED))
        if (!next) translator.cancel()
      },
    }),
    [enabled, locale, translator]
  )
  return <TranslationContext value={value}>{children}</TranslationContext>
}

export function CatalogTranslationControls() {
  const t = useTranslations("Harness.discover.translation")
  const { enabled, setEnabled, translator } = useContext(TranslationContext)
  useSyncExternalStore(translator.subscribe, translator.snapshot, () => 0)
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2 text-xs text-muted-foreground">
      <Button
        type="button"
        size="xs"
        variant={enabled ? "secondary" : "outline"}
        aria-pressed={enabled}
        title={t("providerHint")}
        onClick={() => setEnabled(!enabled)}
      >
        <Languages aria-hidden="true" />
        {enabled ? t("showOriginal") : t("translate")}
      </Button>
      {enabled && (
        <span role="status" className="inline-flex items-center gap-1.5">
          {translator.pending > 0 && (
            <Loader2 aria-hidden="true" className="size-3 animate-spin" />
          )}
          {translator.pending > 0 ? t("loading") : t("translated")}
        </span>
      )}
      {enabled && translator.failed > 0 && (
        <Button
          type="button"
          variant="ghost"
          size="xs"
          onClick={() => translator.retry()}
        >
          <RotateCw aria-hidden="true" />
          {t("retry")}
        </Button>
      )}
    </div>
  )
}

export function isPublicCatalogItem(
  item: Pick<HarnessItemSummary, "status"> | null | undefined
): boolean {
  return item?.status === "public" || item?.status === "listed"
}

function hasCatalogLocale(
  text: HarnessLocalized | null | undefined,
  locale: string
): boolean {
  if (locale.toLowerCase().startsWith("zh")) return Boolean(text?.zh?.trim())
  return locale.toLowerCase().startsWith("en") && Boolean(text?.en?.trim())
}

function useCatalogText(
  source: string | undefined,
  allowed: boolean,
  native: boolean
): string | undefined {
  const { enabled, target, translator } = useContext(TranslationContext)
  useSyncExternalStore(translator.subscribe, translator.snapshot, () => 0)
  const wanted = enabled && allowed && !native && source !== undefined
  const texts = useMemo(
    () => (wanted ? catalogTextSources(source!, target) : []),
    [wanted, source, target]
  )
  useEffect(
    () => (texts.length ? translator.watch(texts, target) : undefined),
    [translator, texts, target]
  )
  return wanted ? translatedCatalogText(source!, target, translator) : source
}

/** The original API object is also what install/copy actions keep receiving. */
export function useCatalogItemText(
  item: HarnessItemSummary | null,
  promptSummaryOnly = false
) {
  const locale = useLocale()
  const lang = harnessLang(locale)
  const allowed = isPublicCatalogItem(item)
  const originalTitle = item ? itemTitle(item, lang) : undefined
  const originalSummary = item
    ? promptSummaryOnly
      ? pickLocalized(item.summary, lang)
      : itemSummary(item, lang)
    : undefined
  const title = useCatalogText(
    originalTitle,
    allowed && Boolean(item?.title.en?.trim() || item?.title.zh?.trim()),
    hasCatalogLocale(item?.title, locale)
  )
  const summary = useCatalogText(
    originalSummary,
    allowed,
    hasCatalogLocale(item?.summary, locale)
  )
  return { title, summary, originalTitle, originalSummary }
}

export function TranslatedCatalogReadme({
  fragment,
  omitHeading,
  item,
}: {
  fragment: string
  omitHeading?: readonly string[]
  item: HarnessItemSummary
}) {
  const { enabled, target, translator } = useContext(TranslationContext)
  useSyncExternalStore(translator.subscribe, translator.snapshot, () => 0)
  const wanted = enabled && isPublicCatalogItem(item)
  const prose = useMemo(
    () => (wanted ? readmeProse(fragment, omitHeading) : []),
    [wanted, fragment, omitHeading]
  )
  const texts = useMemo(
    () =>
      wanted ? prose.flatMap((text) => catalogTextSources(text, target)) : [],
    [wanted, prose, target]
  )
  useEffect(
    () => (texts.length ? translator.watch(texts, target) : undefined),
    [translator, texts, target]
  )
  const translations = wanted
    ? new Map(
        prose.map((text) => [
          text,
          translatedCatalogText(text, target, translator),
        ])
      )
    : undefined
  return (
    <ReadmeContent
      fragment={fragment}
      omitHeading={omitHeading}
      translations={translations}
    />
  )
}
