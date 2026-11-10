"use client"

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
} from "react"
import { useLocale, useTranslations } from "next-intl"
import { AlertTriangle, ChevronRight, Info, RefreshCw } from "lucide-react"
import { RadioGroup as RadioGroupPrimitive } from "radix-ui"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  ModelPickerDialog,
  type ModelPickerItem,
} from "@/components/settings/provider-models"
import {
  codexCatalogPlanPreview,
  codexEndpointCatalogCached,
  codexEndpointCatalogPublished,
  codexEndpointCatalogStatus,
  codexFetchEndpointCatalog,
  codexRefreshEndpointCatalog,
} from "@/lib/api"
import {
  codexCatalogErrorText,
  parseCodexCatalogError,
  type CodexCatalogTranslator,
} from "@/lib/codex-catalog-error"
import { subscribe } from "@/lib/platform"
import type {
  CodexCatalogError,
  CodexCatalogFormat,
  CodexCatalogRequest,
  CodexCatalogSource,
  CodexCatalogStatus,
  CodexEndpointCatalogView,
  CodexKeySource,
  CodexOpenAiIdView,
} from "@/lib/types"
import { cn } from "@/lib/utils"

/** Mirrors `CODEX_CATALOG_REFRESHED_EVENT` in codex_catalog_refresh.rs. */
const CODEX_CATALOG_REFRESHED_EVENT = "app://codex-catalog-refreshed"

/** What the editor needs to take the model list from a provider. */
export interface CodexCatalogEndpoint {
  /** The provider's base URL as the form has it. */
  baseUrl: string
  /** How the fetch authenticates; `null` while no key is known. */
  keySource: CodexKeySource | null
  /** Show what is published and offer "Refresh now" (a saved panel, a bound
   *  provider). */
  showStatus?: boolean
  /** Show it only while it was published for this binding
   *  (`provider:<id>`): a provider's dialog, while Codex is bound to it. */
  statusBinding?: string
  /** The bound provider's name: the source is shown, not edited. */
  managedBy?: string | null
  /** "Refresh now" / "Apply" published something. */
  onPublished?: () => void
}

/** `base_url + "/models"`, joined on the path the way the backend derives
 *  it (query kept, fragment dropped). `null` for anything but http(s). */
export function deriveCatalogUrl(baseUrl: string): string | null {
  try {
    const url = new URL(baseUrl.trim())
    if (url.protocol !== "http:" && url.protocol !== "https:") return null
    url.hash = ""
    url.pathname = `${url.pathname.replace(/\/+$/, "")}/models`
    return url.toString()
  } catch {
    return null
  }
}

function hostOf(raw: string): string | null {
  try {
    return new URL(raw.trim()).host || null
  } catch {
    return null
  }
}

type ListOrigin = "fetched" | "published" | "cached"

/** The provider's list for the editor's rows: this session's fetch first,
 *  then the published list, then the cache — each only when it answers the
 *  form's own request (URL, key, list URL) and, once one was applied, the
 *  recorded shape. A fetch in the other shape is set aside for re-picking,
 *  never used as rows. */
export function useCodexProviderList(
  endpoint: CodexCatalogEndpoint | null | undefined,
  source: CodexCatalogSource | undefined
) {
  const request = useMemo<CodexCatalogRequest | null>(() => {
    if (!endpoint || !source || !endpoint.keySource) return null
    if (!deriveCatalogUrl(endpoint.baseUrl)) return null
    return {
      baseUrl: endpoint.baseUrl.trim(),
      catalogUrl: source.url?.trim() || null,
      keySource: endpoint.keySource,
    }
  }, [endpoint, source])
  const key = request ? JSON.stringify(request) : ""
  const format = source?.format ?? null

  const [fetched, setFetched] = useState<{
    key: string
    view: CodexEndpointCatalogView
  } | null>(null)
  const [fallback, setFallback] = useState<{
    key: string
    format: CodexCatalogFormat | null
    view: CodexEndpointCatalogView
    origin: ListOrigin
  } | null>(null)
  const [failure, setFailure] = useState<{
    key: string
    error: CodexCatalogError
  } | null>(null)
  const [fetching, setFetching] = useState(false)
  const [reloads, setReloads] = useState(0)
  const seq = useRef(0)

  useEffect(() => {
    // A request that changed drops the answer to the old one, late or not.
    seq.current += 1
    setFetching(false)
  }, [key])
  useEffect(
    () => () => {
      // Unmounted (the source or the auth mode changed under it): an answer
      // still on its way must not write into the form any more.
      seq.current += 1
    },
    []
  )

  useEffect(() => {
    if (!request) return
    let alive = true
    const params = { ...request, format }
    void (async () => {
      try {
        const published = await codexEndpointCatalogPublished(params)
        if (!alive) return
        if (published.catalog) {
          setFallback({
            key,
            format,
            view: published.catalog,
            origin: "published",
          })
          return
        }
        const cached = await codexEndpointCatalogCached(params)
        if (!alive) return
        setFallback(
          cached.catalog
            ? { key, format, view: cached.catalog, origin: "cached" }
            : null
        )
      } catch {
        if (alive) setFallback(null)
      }
    })()
    return () => {
      alive = false
    }
    // `key` stands for `request`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, format, reloads])

  const fetchNow =
    useCallback(async (): Promise<CodexEndpointCatalogView | null> => {
      if (!request) return null
      const mine = ++seq.current
      setFetching(true)
      setFailure(null)
      try {
        const view = await codexFetchEndpointCatalog(request)
        if (mine !== seq.current) return null
        setFetched({ key, view })
        return view
      } catch (e) {
        if (mine !== seq.current) return null
        const parsed = parseCodexCatalogError(e)
        setFailure({
          key,
          error: parsed.catalog ?? { code: "unknown", message: parsed.message },
        })
        return null
      } finally {
        if (mine === seq.current) setFetching(false)
      }
    }, [request, key])

  const current = fetched?.key === key && key ? fetched.view : null
  const formatChanged =
    current && format && current.format !== format ? current : null
  const known =
    fallback && fallback.key === key && fallback.format === format
      ? fallback
      : null
  const rows =
    (current && !formatChanged ? current : null) ?? known?.view ?? null
  const origin: ListOrigin | null =
    current && !formatChanged ? "fetched" : (known?.origin ?? null)
  return {
    request,
    rows,
    origin,
    formatChanged,
    fetching,
    error: failure?.key === key ? failure.error : null,
    fetchNow,
    reload: useCallback(() => setReloads((n) => n + 1), []),
  }
}

export type CodexProviderList = ReturnType<typeof useCodexProviderList>

function formatTime(iso: string | null | undefined, locale: string): string {
  if (!iso) return ""
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ""
  return date.toLocaleString(locale, {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  })
}

function formatBytes(n: number | undefined): string {
  if (!n) return ""
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

/** "Codex built-in | From the provider": where the model list comes from,
 *  as two segments of one control. */
export function CodexSourceSwitch({
  value,
  disabled,
  onChange,
}: {
  value: "builtin" | "provider"
  disabled: boolean
  onChange: (next: "builtin" | "provider") => void
}) {
  const t = useTranslations("CodexModelEditor.catalogSource")
  return (
    <RadioGroupPrimitive.Root
      value={value}
      onValueChange={(next) => onChange(next as "builtin" | "provider")}
      disabled={disabled}
      aria-label={t("title")}
      className="inline-flex shrink-0 items-center gap-0.5 rounded-full bg-muted p-0.5"
    >
      {(["builtin", "provider"] as const).map((option) => (
        <RadioGroupPrimitive.Item
          key={option}
          value={option}
          className="h-7 rounded-full px-3 text-xs text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:hover:text-muted-foreground data-[state=checked]:bg-background data-[state=checked]:text-foreground data-[state=checked]:shadow-sm"
        >
          {t(option)}
        </RadioGroupPrimitive.Item>
      ))}
    </RadioGroupPrimitive.Root>
  )
}

/** The list URL, folded away until it is wanted: `base_url + /models` serves
 *  most providers, so the field opens on its own only when one is set. */
export function CodexListUrlField({
  endpoint,
  source,
  onSourceChange,
}: {
  endpoint: CodexCatalogEndpoint
  source: CodexCatalogSource
  onSourceChange: (next: CodexCatalogSource) => void
}) {
  const t = useTranslations("CodexModelEditor.catalogSource")
  const derived = deriveCatalogUrl(endpoint.baseUrl)
  const baseHost = hostOf(endpoint.baseUrl)
  const listHost = source.url?.trim() ? hostOf(source.url) : null
  const [open, setOpen] = useState(() => !!source.url?.trim())
  const shown = open || !!source.url?.trim()
  return (
    <div className="space-y-1.5">
      <button
        type="button"
        className="flex items-center gap-1 rounded-sm text-2xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        aria-expanded={shown}
        onClick={() => setOpen(!shown)}
      >
        <ChevronRight
          className={cn(
            "size-3 transition-transform rtl:-scale-x-100",
            shown && "rotate-90"
          )}
        />
        {t("listUrl")}
      </button>
      {shown && (
        <div className="space-y-1">
          <Input
            value={source.url ?? ""}
            placeholder={derived ?? t("listUrlPlaceholder")}
            aria-label={t("listUrl")}
            onChange={(e) =>
              onSourceChange({
                ...source,
                url: e.target.value || undefined,
              })
            }
            className="h-8 font-mono text-2xs"
          />
          {listHost && baseHost && listHost !== baseHost && (
            <p className="flex items-start gap-1 text-2xs text-amber-600 dark:text-amber-400">
              <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
              {t("keySentTo", { host: listHost })}
            </p>
          )}
        </div>
      )}
    </div>
  )
}

/** What the provider's list needs saying above its rows: a list in another
 *  shape than the one in use (with "Pick again"), or one with no usable
 *  model. */
export function CodexListNotices({
  list,
  editable,
  onRepick,
}: {
  list: CodexProviderList
  editable: boolean
  onRepick: () => void
}) {
  const t = useTranslations("CodexModelEditor.catalogSource")
  return (
    <>
      {list.rows?.warnings.includes("no_usable_models") && (
        <p className="flex items-start gap-1.5 text-2xs text-amber-600 dark:text-amber-400">
          <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
          {t("codexCatalog.no_usable_models")}
        </p>
      )}
      {list.formatChanged && editable && (
        <div className="flex flex-wrap items-center gap-2 rounded-xl border border-amber-500/30 bg-amber-500/5 px-3 py-1.5 text-2xs text-amber-600 dark:text-amber-400">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
          <span className="flex-1">
            {t("formatChanged", {
              format: t(
                list.formatChanged.format === "native"
                  ? "formatNative"
                  : "formatOpenai"
              ),
            })}
          </span>
          <Button type="button" variant="outline" size="xs" onClick={onRepick}>
            {t("repick")}
          </Button>
        </div>
      )}
    </>
  )
}

/** What the rows of a list are, for the line above them: ids picked from an
 *  OpenAI list (`picked` of the `offered` ids it returns now), or a
 *  catalog's models (`shown`, the `removed` ones taken out apart). */
export type CodexListTally =
  | { kind: "picked"; picked: number; offered: number }
  | { kind: "models"; shown: number; removed: number }

/** The line atop the provider's rows: how many models it offers and from
 *  where — or that the list is on its way, what the form still needs before
 *  it can ask, or why the last fetch failed. */
export function CodexProviderListSummary({
  endpoint,
  list,
  tally,
}: {
  endpoint: CodexCatalogEndpoint
  list: CodexProviderList
  tally: CodexListTally
}) {
  const t = useTranslations("CodexModelEditor.catalogSource")
  const tp = useTranslations("ProviderModels")
  const tt = t as unknown as CodexCatalogTranslator
  // The refresh beside it turns meanwhile.
  if (list.fetching) {
    return (
      <span className="min-w-0 truncate text-muted-foreground" role="status">
        {tp("fetching")}
      </span>
    )
  }
  if (list.error) {
    return (
      <span className="min-w-0 break-words text-destructive" role="alert">
        {codexCatalogErrorText(list.error, tt)}
      </span>
    )
  }
  const rows = list.rows
  if (!rows) {
    const missing = !endpoint.keySource
      ? t("needKey")
      : !deriveCatalogUrl(endpoint.baseUrl)
        ? t("needBaseUrl")
        : null
    return missing ? (
      <span className="min-w-0 text-muted-foreground">{missing}</span>
    ) : null
  }
  // With its port, as the other agents' lists name their host.
  const host = hostOf(rows.url) ?? rows.host
  const parts = [
    tally.kind === "picked"
      ? t("summaryPicked", {
          picked: tally.picked,
          total: tally.offered,
          host,
        })
      : t("summaryModels", { count: tally.shown, host }),
  ]
  if (tally.kind === "models" && tally.removed > 0)
    parts.push(t("summaryRemoved", { count: tally.removed }))
  if (list.origin === "published") parts.push(t("fromPublished"))
  if (list.origin === "cached") parts.push(t("fromCache"))
  return (
    <span
      className="min-w-0 truncate text-muted-foreground"
      // The shape of the list, and how much of it Codex can use.
      title={[
        t(rows.format === "native" ? "formatNative" : "formatOpenai"),
        t("countsShort", {
          usable: rows.counts.usable,
          total: rows.counts.total,
        }),
      ].join(" · ")}
    >
      {parts.join(" · ")}
    </span>
  )
}

/** What is published under codeg's CODEX_HOME, how its refreshes go, and
 *  "Refresh now". Reloads on its own when a background refresh publishes. */
export function CodexCatalogStatusLine({
  onPublished,
  binding,
}: {
  onPublished?: () => void
  /** Show the status only while what is published was published for this
   *  binding (`provider:<id>`): a provider's dialog says nothing about
   *  another provider's list. */
  binding?: string
}) {
  const t = useTranslations("CodexModelEditor.catalogSource")
  const tt = t as unknown as CodexCatalogTranslator
  const locale = useLocale()
  const [status, setStatus] = useState<CodexCatalogStatus | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [refreshError, setRefreshError] = useState<CodexCatalogError | null>(
    null
  )

  // The latest callback, without re-subscribing whenever the parent renders.
  const onPublishedRef = useRef(onPublished)
  useEffect(() => {
    onPublishedRef.current = onPublished
  }, [onPublished])

  // Only the latest read lands: an earlier one answering late must not
  // overwrite a newer status (after "Refresh now", say).
  const loads = useRef(0)
  const load = useCallback(() => {
    const mine = ++loads.current
    void codexEndpointCatalogStatus()
      .then((next) => {
        if (mine === loads.current) setStatus(next)
      })
      .catch(() => {})
  }, [])

  useEffect(() => {
    load()
    let disposed = false
    let unsubscribe: (() => void) | undefined
    void subscribe<unknown>(CODEX_CATALOG_REFRESHED_EVENT, () => {
      load()
      onPublishedRef.current?.()
    })
      .then((fn) => {
        if (disposed) fn()
        else unsubscribe = fn
      })
      .catch(() => {})
    return () => {
      disposed = true
      unsubscribe?.()
    }
  }, [load])

  const refresh = useCallback(async () => {
    setRefreshing(true)
    setRefreshError(null)
    try {
      const next = await codexRefreshEndpointCatalog()
      loads.current += 1
      setStatus(next)
      setRefreshError(next.fetchError)
      onPublishedRef.current?.()
    } catch (e) {
      const parsed = parseCodexCatalogError(e)
      setRefreshError(
        parsed.catalog ?? { code: "unknown", message: parsed.message }
      )
    } finally {
      setRefreshing(false)
    }
  }, [])

  const meta = status?.meta ?? null
  if (!status || (!meta && !status.source)) return null
  if (binding && meta?.binding !== binding) return null
  const lastError = refreshError ?? status.refresh.lastError
  const conflict = meta?.conflict ?? []
  const lines: { tone: "muted" | "warn" | "error"; text: string }[] = []
  if (meta?.format && meta.counts.total > 0) {
    const parts = [
      t(meta.format === "native" ? "formatNative" : "formatOpenai"),
      t("countsShort", {
        usable: meta.counts.usable,
        total: meta.counts.total,
      }),
    ]
    if (meta.bytes) parts.push(formatBytes(meta.bytes))
    if (meta.checkedAt)
      parts.push(t("checkedAt", { time: formatTime(meta.checkedAt, locale) }))
    if (status.refresh.nextRefreshAt)
      parts.push(
        t("nextRefresh", {
          time: formatTime(status.refresh.nextRefreshAt, locale),
        })
      )
    lines.push({ tone: "muted", text: parts.join(" · ") })
  }
  const added = meta?.diff.added.length ?? 0
  const removed = meta?.diff.removed.length ?? 0
  if (meta?.format === "native" && (added || removed))
    lines.push({ tone: "muted", text: t("diff", { added, removed }) })
  if (status.newIds.length)
    lines.push({
      tone: "muted",
      text: t("newIds", { count: status.newIds.length }),
    })
  if (status.missingSelected.length)
    lines.push({
      tone: "warn",
      text: t("missingSelected", { count: status.missingSelected.length }),
    })
  if (meta?.stale) lines.push({ tone: "warn", text: t("stale") })
  if (meta?.degraded)
    lines.push({
      tone: "warn",
      text: t("degraded", {
        reason: tt.has(`degradedReason.${meta.degraded}`)
          ? tt(`degradedReason.${meta.degraded}`)
          : meta.degraded,
      }),
    })
  if (meta?.pendingFormat)
    lines.push({
      tone: "warn",
      text: t("formatChanged", {
        format: t(
          meta.pendingFormat === "native" ? "formatNative" : "formatOpenai"
        ),
      }),
    })
  if (conflict.length)
    lines.push({
      tone: "warn",
      text: t("conflict", {
        versions: [
          ...(meta?.validatedBy.map((v) => v.version) ?? []),
          ...conflict.map((v) => v.version),
        ].join(", "),
      }),
    })
  if (lastError) {
    const when = refreshError ? null : status.refresh.lastErrorAt
    const reason = codexCatalogErrorText(lastError, tt)
    lines.push({
      tone: "error",
      text: when
        ? t("refreshFailedAt", { reason, time: formatTime(when, locale) })
        : t("refreshFailed", { reason }),
    })
    if (meta?.checkedAt)
      lines.push({
        tone: "muted",
        text: t("stillUsing", { time: formatTime(meta.checkedAt, locale) }),
      })
  }
  if (status.catalogUrlHint)
    lines.push({ tone: "muted", text: t("catalogUrlHint") })

  return (
    <div className="overflow-hidden rounded-xl border">
      <div className="flex min-h-9 items-center justify-between gap-2 border-b bg-muted/30 ps-3 pe-1.5 py-1">
        <p className="text-2xs font-medium text-muted-foreground">
          {t("publishedTitle")}
        </p>
        <div className="flex items-center gap-1">
          {status.pendingLocalChanges && (
            <Button
              type="button"
              variant="outline"
              size="xs"
              disabled={refreshing}
              onClick={refresh}
            >
              {t("apply")}
            </Button>
          )}
          {status.source && (
            <Button
              type="button"
              variant="ghost"
              size="xs"
              disabled={refreshing || status.refresh.inProgress}
              onClick={refresh}
            >
              <RefreshCw
                className={cn(
                  (refreshing || status.refresh.inProgress) && "animate-spin"
                )}
              />
              {t("refreshNow")}
            </Button>
          )}
        </div>
      </div>
      <div className="space-y-1 px-3 py-2">
        {status.pendingLocalChanges && (
          <p className="flex items-start gap-1 text-2xs text-amber-600 dark:text-amber-400">
            <Info className="mt-0.5 h-3 w-3 shrink-0" />
            {t("pendingLocalChanges")}
          </p>
        )}
        {lines.map((line, i) => (
          <p
            key={i}
            className={cn(
              "text-2xs",
              line.tone === "muted" && "text-muted-foreground",
              line.tone === "warn" && "text-amber-600 dark:text-amber-400",
              line.tone === "error" && "text-destructive"
            )}
          >
            {line.text}
          </p>
        ))}
      </div>
    </div>
  )
}

/** What saving the draft would set codeg's managed keys to — root `model`
 *  and `model_catalog_json` — asked of the backend a moment after the draft
 *  stops changing. The raw editor still shows the draft as typed: codeg
 *  writes these two itself, and refuses a hand edit of them. */
export function CodexSavePreview({
  configToml,
  authJson,
  modelList,
}: {
  configToml: string
  authJson: string
  modelList: string
}) {
  const t = useTranslations("CodexModelEditor.catalogSource")
  const tt = t as unknown as CodexCatalogTranslator
  const [preview, setPreview] = useState<{
    managesCatalog: boolean
    defaultModel: string | null
  } | null>(null)
  const [error, setError] = useState<CodexCatalogError | null>(null)

  useEffect(() => {
    let alive = true
    const timer = setTimeout(() => {
      void codexCatalogPlanPreview({ configToml, authJson, modelList })
        .then((next) => {
          if (!alive) return
          setPreview(next)
          setError(null)
        })
        .catch((e) => {
          if (!alive) return
          const parsed = parseCodexCatalogError(e)
          setPreview(null)
          setError(parsed.catalog)
        })
    }, PREVIEW_DELAY_MS)
    return () => {
      alive = false
      clearTimeout(timer)
    }
  }, [configToml, authJson, modelList])

  if (error) {
    return (
      <p className="text-2xs text-destructive">
        {t("savePreviewError", { message: codexCatalogErrorText(error, tt) })}
      </p>
    )
  }
  if (!preview?.managesCatalog) return null
  return (
    <p className="text-2xs text-muted-foreground">
      {preview.defaultModel
        ? t("savePreviewManaged", { model: preview.defaultModel })
        : t("savePreviewManagedNoModel")}
    </p>
  )
}

const PREVIEW_DELAY_MS = 400

/** One row of the picker. */
export type CodexPickerItem = ModelPickerItem

/** Pick ids from a provider's list (an OpenAI list's allowlist, or the
 *  visible part of a native catalog when its shape changed). Ids that were
 *  chosen and are about to go are listed apart, each with "add as a custom
 *  model" instead. */
export function CodexCatalogPickerDialog(
  props: Omit<ComponentProps<typeof ModelPickerDialog>, "keepLabel">
) {
  const t = useTranslations("CodexModelEditor.catalogSource")
  return <ModelPickerDialog {...props} keepLabel={t("keepAsCustom")} />
}

/** The line under an OpenAI-list id: which metadata it is built from. */
export function templateHint(
  view: CodexOpenAiIdView | undefined,
  t: CodexCatalogTranslator
): string | undefined {
  const template = view?.template
  if (!template) return undefined
  if (template.kind === "official") return t("templateOfficial")
  if (template.kind === "prefix")
    return t("templatePrefix", { slug: template.slug })
  return t("templateCompat")
}
