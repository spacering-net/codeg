"use client"

import {
  useEffect,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
} from "react"
import {
  Check,
  Copy,
  ExternalLink,
  ImageOff,
  Loader2,
  MessageSquarePlus,
} from "lucide-react"
import { useTranslations } from "next-intl"

import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { useHarnessSlot, useHarnessView } from "@/contexts/harness-view-context"
import { useCopiedFlag } from "@/hooks/use-copied-flag"
import { quickMessagesCreate } from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"
import {
  DISCOVER_DETAIL,
  DISCOVER_QUICK_MESSAGE,
  retryDiscoverPart,
} from "@/lib/harness/discover-state"
import {
  formatDate,
  httpsUrl,
  itemTitle,
  modelName,
  pickLocalized,
} from "@/lib/harness/display"
import type { HarnessFailure } from "@/lib/harness/errors"
import {
  firstShowcase,
  languageName,
  promptLength,
  promptRights,
  promptTextOf,
  quickMessageDraft,
} from "@/lib/harness/prompt"
import type {
  HarnessItemDetail,
  HarnessItemSummary,
  HarnessShowcase,
} from "@/lib/harness/types"
import { useSrnAsset } from "@/lib/harness/use-srn-asset"
import { cn, copyTextToClipboard } from "@/lib/utils"
import { ActionAlert, refocus } from "./detail-actions"
import type {
  DiscoverDetailActionsProps,
  DiscoverDetailBodyProps,
  DiscoverDetailPartProps,
} from "./detail-kinds"
import {
  ChecksSection,
  Code,
  DetailSection,
  Fact,
  FACT_LINK_CLASS,
  FoldedBox,
  LicenseFact,
  LinesSkeleton,
  useExpanded,
  VersionsSection,
} from "./detail-sections"
import { DiscoverFailure } from "./discover-failure"
import { HarnessLink } from "./harness-link"
import { useDiscoverLabels } from "./use-discover-labels"

/**
 * A prompt's detail: its text, shown as it is to be used, the results made
 * with it, and what can be done with it here — copy it, or keep it as a quick
 * message. A prompt runs nothing and its package is one `PROMPT.md`, so it has
 * no permissions, files or server to show.
 *
 * Everything here is the catalog's text shown as text. The prompt itself is
 * never read as Markdown or markup: what is on screen is what gets copied.
 */

/** About twenty lines of the prompt's text (`text-sm`, `leading-relaxed`)
 *  before "Show all". */
const PROMPT_FOLD_REM = 28.5

/** How many results are shown before "Show all". */
const SHOWCASES_SHOWN = 12

/** Numbers each "Save as quick message", for `DiscoverQuickMessageState.op`.
 *  Outside the slots, so that no number is handed out twice. */
let lastQuickMessageOp = 0

interface PromptTextSource {
  /** The text, once there is one. */
  text: string | null
  /** Why it could not be had, when it could not. */
  error: HarnessFailure | null
  retry: () => void
}

/**
 * The prompt's text: the one the item carries, or — from a catalog that left
 * it out — the one asked for on its own (`DiscoverDetailState.prompt`).
 */
function usePromptText(item: HarnessItemDetail): PromptTextSource {
  const { slots } = useHarnessView()
  const [detail] = useHarnessSlot(DISCOVER_DETAIL)
  const carried = promptTextOf(item)
  const retry = () => retryDiscoverPart(slots, "prompt")
  if (carried !== null) return { text: carried, error: null, retry }
  const part = detail?.item?.ref === item.ref ? detail.prompt : null
  return {
    text: part?.phase === "ready" ? (part.value ?? "") : null,
    error: part?.phase === "error" ? part.error : null,
    retry,
  }
}

// ─── Body ─────────────────────────────────────────────────────────────

export function PromptBody({
  item,
  versions,
  onRetryPart,
}: DiscoverDetailBodyProps) {
  return (
    <>
      <PromptSection item={item} />
      <ShowcasesSection item={item} />
      <ChecksSection item={item} />
      <VersionsSection
        item={item}
        versions={versions}
        onRetry={() => onRetryPart("versions")}
      />
    </>
  )
}

function PromptSection({ item }: { item: HarnessItemDetail }) {
  const t = useTranslations("Harness.discover.prompt")
  const info = item.install.prompt
  const source = usePromptText(item)
  // A prompt that is listed only for being partial already says so among
  // the reasons, just above.
  const partial =
    info?.partial === true && !item.listedReasons.includes("prompt_partial")
  const hint = info?.argumentHint?.trim()

  let content: ReactNode
  if (source.error) {
    content = (
      <DiscoverFailure
        variant="inline"
        failure={source.error}
        onRetry={source.retry}
      />
    )
  } else if (source.text === null) {
    content = <LinesSkeleton lines={6} />
  } else if (!source.text.trim()) {
    content = <p className="text-sm text-muted-foreground">{t("empty")}</p>
  } else {
    content = (
      <FoldedBox
        part="prompt"
        foldRem={PROMPT_FOLD_REM}
        className="rounded-lg border bg-muted/40"
        contentClassName="px-3.5 py-3"
      >
        <p
          // The prompt's own language decides its direction, not the
          // interface's.
          dir="auto"
          // Its own line breaks, as written; a long line wraps rather than
          // pushing the page sideways.
          className="text-sm leading-relaxed [overflow-wrap:anywhere] whitespace-pre-wrap"
          data-testid="prompt-text"
        >
          {source.text}
        </p>
      </FoldedBox>
    )
  }

  return (
    <DetailSection title={t("title")}>
      <div className="space-y-2.5">
        {partial && (
          <p className="rounded-lg border border-tone-warning/30 bg-tone-warning/10 px-3 py-2 text-xs text-foreground">
            {t("partial")}
          </p>
        )}
        {hint && (
          <p className="text-xs text-muted-foreground">
            {t("argumentHint")}{" "}
            <bdi className="rounded bg-muted px-1 py-0.5 text-foreground [overflow-wrap:anywhere]">
              {hint}
            </bdi>
          </p>
        )}
        {content}
        <PromptCredit item={item} />
      </div>
    </DetailSection>
  )
}

/**
 * Whose the prompt is. One its sharers hold is credited to the first of them,
 * with a link to where they shared it; one under the item's license says
 * which license.
 */
function PromptCredit({ item }: { item: HarnessItemDetail }) {
  const t = useTranslations("Harness.discover.prompt")
  const info = item.install.prompt
  const rights = promptRights(info)
  if (rights === "license") {
    return (
      <p className="text-xs text-muted-foreground">
        {item.license
          ? t.rich("licensed", {
              license: item.license,
              code: (chunks) => <Code>{chunks}</Code>,
            })
          : t("licenseUnstated")}
      </p>
    )
  }
  if (rights !== "creators") return null
  const first = firstShowcase(info)
  const by = first?.by
  const link = first?.link
  return (
    <p className="text-xs text-muted-foreground">
      {by && (
        <>
          {t.rich("sharedFirst", {
            name: by.name,
            link: (chunks) => (
              <HarnessLink href={link}>
                <bdi>{chunks}</bdi>
              </HarnessLink>
            ),
          })}{" "}
        </>
      )}
      {t("creators")}
    </p>
  )
}

// ─── Results ──────────────────────────────────────────────────────────

function ShowcasesSection({ item }: { item: HarnessItemDetail }) {
  const t = useTranslations("Harness.discover")
  const { locale } = useDiscoverLabels()
  const [showAll, setShowAll] = useExpanded("showcases")
  const listRef = useRef<HTMLUListElement>(null)
  // Set by "Show all": the first result it brings takes the focus, since the
  // button it was on goes away.
  const focusFrom = useRef<number | null>(null)
  const showcases = item.install.prompt?.showcases ?? []

  useEffect(() => {
    const index = focusFrom.current
    if (index === null || !showAll) return
    focusFrom.current = null
    const entry = listRef.current?.children[index] as HTMLElement | undefined
    const link = entry?.querySelector<HTMLElement>("a[href]")
    if (link) link.focus()
    else entry?.focus()
  }, [showAll])

  if (showcases.length === 0) return null
  const visible = showAll ? showcases : showcases.slice(0, SHOWCASES_SHOWN)
  const single = showcases.length === 1

  return (
    <DetailSection
      title={t("prompt.showcases")}
      aside={t("prompt.showcaseCount", { count: showcases.length })}
    >
      <ul
        ref={listRef}
        className={cn(
          "grid gap-x-3 gap-y-4",
          // Two across on a phone, where one would be a screen's height each.
          single
            ? "grid-cols-1 @md/discover:max-w-sm"
            : "grid-cols-2 @md/discover:grid-cols-[repeat(auto-fill,minmax(12rem,1fr))]"
        )}
      >
        {visible.map((showcase, index) => (
          <ShowcaseCard key={index} showcase={showcase} locale={locale} />
        ))}
      </ul>
      {showcases.length > SHOWCASES_SHOWN && !showAll && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="mt-2 max-md:h-10"
          onClick={() => {
            focusFrom.current = SHOWCASES_SHOWN
            setShowAll(true)
          }}
        >
          {t("detail.showAll", { count: showcases.length })}
        </Button>
      )}
    </DetailSection>
  )
}

/**
 * One result: its picture, who shared it, what kind of thing it is and when,
 * linking to the original post in the system browser. The picture comes
 * through the backend (`useSrnAsset`) and nowhere else; its moving version is
 * not played. A result with no picture is its text alone.
 */
function ShowcaseCard({
  showcase,
  locale,
}: {
  showcase: HarnessShowcase
  locale: string
}) {
  const t = useTranslations("Harness.discover.prompt")
  const { lang } = useDiscoverLabels()
  const by = showcase.by ? `@${showcase.by.name}` : t("originalPost")
  const category =
    pickLocalized(showcase.categoryName, lang) ?? showcase.category
  const date = formatDate(showcase.at, locale)
  const link = httpsUrl(showcase.link)

  const body = (
    <>
      {showcase.cover && <ShowcaseCover path={showcase.cover} />}
      <span
        className={cn(
          "flex min-w-0 items-center gap-1 text-xs font-medium",
          showcase.cover && "mt-1.5"
        )}
      >
        <bdi className="min-w-0 truncate">{by}</bdi>
        {link && (
          <ExternalLink
            aria-hidden="true"
            className="size-3 shrink-0 text-muted-foreground"
          />
        )}
      </span>
      {(category || date) && (
        // Each isolated on its own: a date in an Arabic interface carries
        // marks of its own direction, which an English category beside it
        // would otherwise turn around.
        <span className="block text-2xs leading-4 break-words text-muted-foreground">
          {category && <bdi>{category}</bdi>}
          {category && date && " · "}
          {date && <bdi>{date}</bdi>}
        </span>
      )}
      {link && <span className="sr-only">{t("opensPost")}</span>}
    </>
  )

  return (
    // Focusable from code only, where there is no link to focus: what "Show
    // all" moves the focus to. A result with no picture keeps its words at
    // the foot of its cell, in line with its neighbours' words.
    <li
      tabIndex={link ? undefined : -1}
      className={cn(
        "flex min-w-0 flex-col outline-none",
        !showcase.cover && "justify-end"
      )}
    >
      {link ? (
        <HarnessLink
          href={link}
          className="group block text-foreground no-underline focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        >
          {body}
        </HarnessLink>
      ) : (
        <div>{body}</div>
      )}
    </li>
  )
}

function ShowcaseCover({ path }: { path: string }) {
  const { src, failed } = useSrnAsset(path)
  return (
    <span className="relative block aspect-video overflow-hidden rounded-md border bg-muted">
      {src ? (
        // A blob URL minted from proxied bytes: nothing for next/image to
        // optimise, and no network address at all.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={src}
          alt=""
          className="size-full object-cover transition-opacity group-hover:opacity-90"
        />
      ) : failed ? (
        <span className="flex size-full items-center justify-center text-muted-foreground/60">
          <ImageOff aria-hidden="true" className="size-5" />
        </span>
      ) : (
        <Skeleton className="size-full rounded-none" />
      )}
    </span>
  )
}

// ─── Particulars ──────────────────────────────────────────────────────

/** What a prompt is at a glance: the model it was written for, its language
 *  and length, how many results there are, and whose it is. */
export function PromptFacts({ item }: DiscoverDetailPartProps) {
  const t = useTranslations("Harness.discover.prompt.facts")
  const { locale } = useDiscoverLabels()
  const info = item.install.prompt
  const source = usePromptText(item)
  const model = modelName(info?.model)
  const length = source.text?.trim() ? promptLength(source.text) : null
  const results = info?.showcases.length ?? 0
  const rights = promptRights(info)
  const firstPost = firstShowcase(info)?.link

  return (
    <>
      {model && (
        <Fact label={t("model")}>
          <bdi>{model}</bdi>
        </Fact>
      )}
      {info?.lang && (
        <Fact label={t("lang")}>{languageName(info.lang, locale)}</Fact>
      )}
      {length && (
        // Each half on one line: where the two do not fit, the tokens go to
        // the next line together, not their last word alone.
        <Fact label={t("length")}>
          <span className="whitespace-nowrap">
            {t("chars", { chars: length.chars })}
          </span>
          {" · "}
          <span className="whitespace-nowrap">
            {t("tokens", { tokens: length.tokens })}
          </span>
        </Fact>
      )}
      {results > 0 && (
        <Fact label={t("results")}>
          {new Intl.NumberFormat(locale).format(results)}
        </Fact>
      )}
      {rights === "creators" ? (
        <Fact label={t("rights")}>
          <HarnessLink href={firstPost} className={FACT_LINK_CLASS}>
            {t("creators")}
          </HarnessLink>
        </Fact>
      ) : rights === "license" ? (
        <LicenseFact item={item} />
      ) : (
        <>
          <Fact label={t("rights")}>
            <span className="text-muted-foreground">{t("rightsUnknown")}</span>
          </Fact>
          <LicenseFact item={item} />
        </>
      )}
    </>
  )
}

/** How many rows `PromptFacts` will have, from what the list knew: the
 *  model and the results when its card names them; the language, the length
 *  and whose it is nearly always. */
export function promptFactsGuess(item: HarnessItemSummary): number {
  const card = item.prompt
  return (card?.model ? 1 : 0) + (card && card.results > 0 ? 1 : 0) + 3
}

// ─── Actions ──────────────────────────────────────────────────────────

/**
 * Copy the prompt, or keep it as a quick message — the composer's + menu
 * lists those, under the prompt's title.
 *
 * Both are offered once there is text to act on. A copy is confirmed on the
 * button and to a screen reader; a save says where to find what was saved,
 * and stays said (it is held in a slot, as is a save still on its way when
 * the page is left).
 */
export function PromptActions({ item }: DiscoverDetailActionsProps) {
  const t = useTranslations("Harness.discover.prompt")
  const { lang } = useDiscoverLabels()
  const { slots } = useHarnessView()
  const [saveState] = useHarnessSlot(DISCOVER_QUICK_MESSAGE)
  const source = usePromptText(item)
  const [copied, markCopied] = useCopiedFlag(2000)
  const [copyFailed, setCopyFailed] = useState(false)

  const text = source.text
  const ready = text !== null && text.trim() !== ""
  const save = saveState?.ref === item.ref ? saveState : null
  const busy = save?.phase === "saving" || save?.phase === "saved"

  const copy = (event: MouseEvent<HTMLButtonElement>) => {
    if (!ready) return
    const button = event.currentTarget
    setCopyFailed(false)
    void copyTextToClipboard(text).then((ok) => {
      refocus(button)
      if (ok) markCopied()
      else setCopyFailed(true)
    })
  }

  const saveQuickMessage = () => {
    if (!ready || busy) return
    const draft = quickMessageDraft(itemTitle(item, lang), text)
    const ref = item.ref
    const op = ++lastQuickMessageOp
    if (!draft.ok) {
      slots.set(DISCOVER_QUICK_MESSAGE, {
        ref,
        op,
        phase: "tooLong",
        detail: "",
      })
      return
    }
    slots.set(DISCOVER_QUICK_MESSAGE, { ref, op, phase: "saving", detail: "" })
    // Written only over this very save. Opening an item clears the record,
    // and the same prompt opened afresh can be saved again while this answer
    // is still on its way: it must not speak for that later save.
    const settle = (next: "saved" | "error", detail = "") =>
      slots.set(DISCOVER_QUICK_MESSAGE, (current) =>
        current?.op === op ? { ...current, phase: next, detail } : current
      )
    quickMessagesCreate({ title: draft.title, content: draft.content }).then(
      () => settle("saved"),
      (error: unknown) => settle("error", toErrorMessage(error))
    )
  }

  return (
    <>
      <Button
        type="button"
        size="sm"
        disabled={!ready}
        onClick={copy}
        className="max-md:h-10"
      >
        {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
        {copied ? t("copied") : t("copy")}
      </Button>
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={!ready}
        // Not `disabled` while busy: a button that disables itself under the
        // focus drops it on the page.
        aria-disabled={busy || undefined}
        onClick={saveQuickMessage}
        className="max-md:h-10"
      >
        {save?.phase === "saving" ? (
          <Loader2 aria-hidden="true" className="animate-spin" />
        ) : save?.phase === "saved" ? (
          <Check aria-hidden="true" />
        ) : (
          <MessageSquarePlus aria-hidden="true" />
        )}
        {save?.phase === "saving"
          ? t("saving")
          : save?.phase === "saved"
            ? t("saved")
            : t("save")}
      </Button>
      {save?.phase === "saved" && (
        <p className="basis-full text-xs text-muted-foreground">
          {t("savedNote")}
        </p>
      )}
      {(save?.phase === "error" || save?.phase === "tooLong") && (
        <ActionAlert>
          {save.phase === "tooLong" ? t("tooLong") : t("saveFailed")}
          {save.detail && (
            <bdi className="block break-words text-muted-foreground">
              {save.detail}
            </bdi>
          )}
        </ActionAlert>
      )}
      {copyFailed && <ActionAlert>{t("copyFailed")}</ActionAlert>}
      <span role="status" aria-live="polite" className="sr-only">
        {copied ? t("copiedAnnounce") : ""}
      </span>
      <span role="status" aria-live="polite" className="sr-only">
        {save?.phase === "saved" ? t("savedNote") : ""}
      </span>
    </>
  )
}
