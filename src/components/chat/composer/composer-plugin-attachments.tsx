"use client"

import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react"
import { Loader2, Puzzle, Search, X } from "lucide-react"
import { useLocale, useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  hostPluginSessionScopeKey,
  isCurrentReadyHostTransport,
  parsePluginAttachmentSearchOutput,
  selectPluginAttachmentSources,
  useHostPlugins,
  usePluginHostScope,
  type HostPluginSessionContext,
  type PluginAttachmentSourceItem,
  type ResolvedPluginAttachmentSource,
} from "@/lib/host-plugins"
import type { Transport } from "@/lib/transport"

const SEARCH_DEBOUNCE_MS = 180
const useIsomorphicLayoutEffect =
  typeof window !== "undefined" ? useLayoutEffect : useEffect

export interface AttachedPluginItem {
  key: string
  pluginId: string
  pluginName: string
  sourceId: string
  sourceKey: string
  sourceTitle: string
  item: PluginAttachmentSourceItem
}

export function formatAttachedPluginItemLabel(
  item: Pick<PluginAttachmentSourceItem, "identifier" | "title">
): string {
  return item.identifier ? `${item.identifier} · ${item.title}` : item.title
}

interface OpenedSourceState {
  sourceKey: string
  scopeKey: string
  transport: Transport | null
}

interface SearchState {
  items: PluginAttachmentSourceItem[]
  loading: boolean
  error: string | null
}

const EMPTY_SEARCH_STATE: SearchState = {
  items: [],
  loading: false,
  error: null,
}

export interface ComposerPluginAttachmentController {
  sources: ResolvedPluginAttachmentSource[]
  activeSource: ResolvedPluginAttachmentSource | null
  query: string
  setQuery: (nextQuery: string) => void
  items: PluginAttachmentSourceItem[]
  loading: boolean
  error: string | null
  openSource: (source: ResolvedPluginAttachmentSource) => void
  closePicker: () => void
  retrySearch: () => void
  attachedItems: AttachedPluginItem[]
  attachItem: (item: PluginAttachmentSourceItem) => void
  removeAttachedItem: (key: string) => void
  clearAttachedItems: () => void
}

export function useComposerPluginAttachmentSources({
  sessionContext,
  enabled = true,
}: {
  sessionContext: HostPluginSessionContext | null
  enabled?: boolean
}): ComposerPluginAttachmentController {
  const locale = useLocale()
  const activeEnabled = enabled && Boolean(sessionContext)
  const hostScope = usePluginHostScope()
  const { data: plugins, transport } = useHostPlugins(activeEnabled)

  const sources = useMemo(
    () =>
      activeEnabled && hostScope.transportReady
        ? selectPluginAttachmentSources(plugins, locale)
        : [],
    [activeEnabled, hostScope.transportReady, locale, plugins]
  )

  const draftScopeKey = useMemo(
    () =>
      sessionContext
        ? `${hostScope.scopeKey}:${hostPluginSessionScopeKey(sessionContext)}`
        : null,
    [hostScope.scopeKey, sessionContext]
  )

  const [opened, setOpened] = useState<OpenedSourceState | null>(null)
  const [query, setQueryState] = useState("")
  const [searchState, setSearchState] =
    useState<SearchState>(EMPTY_SEARCH_STATE)
  const [attachedByScope, setAttachedByScope] = useState<
    Record<string, AttachedPluginItem[]>
  >({})

  const activeSource = useMemo(() => {
    if (
      !activeEnabled ||
      !hostScope.transportReady ||
      !opened ||
      !draftScopeKey ||
      !transport ||
      opened.scopeKey !== draftScopeKey ||
      opened.transport !== transport
    ) {
      return null
    }
    return sources.find((source) => source.key === opened.sourceKey) ?? null
  }, [
    activeEnabled,
    draftScopeKey,
    hostScope.transportReady,
    opened,
    sources,
    transport,
  ])

  // Permanently close the picker when the source is withdrawn (plugin disabled
  // or updated away, session/workspace switched, or host Transport replaced)
  // so it never resurrects later with stale context.
  if (opened !== null && !activeSource) {
    setOpened(null)
  }

  const liveSourceKeys = useMemo(
    () => new Set(sources.map((source) => source.key)),
    [sources]
  )

  const requestSeqRef = useRef(0)
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const liveRef = useRef({
    activeEnabled,
    transportReady: hostScope.transportReady,
    draftScopeKey,
    transport,
    activeSource,
    liveSourceKeys,
    sessionContext,
    locale,
    query,
  })

  useIsomorphicLayoutEffect(() => {
    liveRef.current = {
      activeEnabled,
      transportReady: hostScope.transportReady,
      draftScopeKey,
      transport,
      activeSource,
      liveSourceKeys,
      sessionContext,
      locale,
      query,
    }
  }, [
    activeEnabled,
    hostScope.transportReady,
    draftScopeKey,
    transport,
    activeSource,
    liveSourceKeys,
    sessionContext,
    locale,
    query,
  ])

  const clearPendingTimer = useCallback(() => {
    if (debounceTimerRef.current !== null) {
      clearTimeout(debounceTimerRef.current)
      debounceTimerRef.current = null
    }
  }, [])

  const runSearch = useCallback(
    (
      source: ResolvedPluginAttachmentSource,
      searchQuery: string,
      capturedTransport: Transport | null,
      capturedScopeKey: string | null,
      capturedSession: HostPluginSessionContext | null,
      capturedLocale: string
    ) => {
      clearPendingTimer()
      const requestSeq = ++requestSeqRef.current
      if (
        !capturedTransport ||
        !capturedScopeKey ||
        !capturedSession ||
        !isCurrentReadyHostTransport(capturedTransport) ||
        typeof capturedTransport.call !== "function"
      ) {
        setSearchState(EMPTY_SEARCH_STATE)
        return
      }
      setSearchState((previous) => ({
        items: previous.items,
        loading: true,
        error: null,
      }))

      void Promise.resolve()
        .then(() =>
          capturedTransport.call<unknown>("host_plugins_call", {
            pluginId: source.pluginId,
            method: source.method,
            input: {
              query: searchQuery,
              folderId: capturedSession.folderId,
              conversationId: capturedSession.conversationId,
              locale: capturedLocale,
            },
          })
        )
        .then((raw) => {
          const live = liveRef.current
          if (
            requestSeq !== requestSeqRef.current ||
            !live.activeEnabled ||
            !live.transportReady ||
            live.draftScopeKey !== capturedScopeKey ||
            live.transport !== capturedTransport ||
            !isCurrentReadyHostTransport(capturedTransport) ||
            live.activeSource?.key !== source.key ||
            !live.liveSourceKeys.has(source.key)
          ) {
            return
          }
          const parsed = parsePluginAttachmentSearchOutput(raw)
          setSearchState({
            items: parsed,
            loading: false,
            error: null,
          })
        })
        .catch((error: unknown) => {
          const live = liveRef.current
          if (
            requestSeq !== requestSeqRef.current ||
            !live.activeEnabled ||
            !live.transportReady ||
            live.draftScopeKey !== capturedScopeKey ||
            live.transport !== capturedTransport ||
            !isCurrentReadyHostTransport(capturedTransport) ||
            live.activeSource?.key !== source.key ||
            !live.liveSourceKeys.has(source.key)
          ) {
            return
          }
          const message =
            error instanceof Error && error.message.trim()
              ? error.message.trim()
              : "Search failed"
          setSearchState((previous) => ({
            items: previous.items,
            loading: false,
            error: message,
          }))
        })
    },
    [clearPendingTimer]
  )

  // Invalidate any pending timer / in-flight search whenever the active picker
  // closes, switches scope, loses its source, or changes host transport.
  useEffect(() => {
    if (!activeSource) {
      clearPendingTimer()
      requestSeqRef.current += 1
    }
  }, [activeSource, clearPendingTimer])

  useEffect(() => {
    return () => {
      clearPendingTimer()
      requestSeqRef.current += 1
    }
  }, [clearPendingTimer])

  const openSource = useCallback(
    (source: ResolvedPluginAttachmentSource) => {
      const live = liveRef.current
      if (
        !live.activeEnabled ||
        !live.transportReady ||
        !live.draftScopeKey ||
        !live.transport ||
        !live.sessionContext ||
        !isCurrentReadyHostTransport(live.transport) ||
        !live.liveSourceKeys.has(source.key)
      ) {
        return
      }
      clearPendingTimer()
      setOpened({
        sourceKey: source.key,
        scopeKey: live.draftScopeKey,
        transport: live.transport,
      })
      setQueryState("")
      setSearchState({ items: [], loading: true, error: null })
      runSearch(
        source,
        "",
        live.transport,
        live.draftScopeKey,
        live.sessionContext,
        live.locale
      )
    },
    [clearPendingTimer, runSearch]
  )

  const closePicker = useCallback(() => {
    clearPendingTimer()
    requestSeqRef.current += 1
    setOpened(null)
    setQueryState("")
    setSearchState(EMPTY_SEARCH_STATE)
  }, [clearPendingTimer])

  const setQuery = useCallback(
    (nextQuery: string) => {
      setQueryState(nextQuery)
      clearPendingTimer()
      const live = liveRef.current
      const source = live.activeSource
      if (
        !source ||
        !live.transport ||
        !live.draftScopeKey ||
        !live.sessionContext
      ) {
        return
      }
      const capturedTransport = live.transport
      const capturedScopeKey = live.draftScopeKey
      const capturedSession = live.sessionContext
      const capturedLocale = live.locale
      debounceTimerRef.current = setTimeout(() => {
        debounceTimerRef.current = null
        const current = liveRef.current
        if (
          current.activeSource?.key !== source.key ||
          current.draftScopeKey !== capturedScopeKey ||
          current.transport !== capturedTransport
        ) {
          return
        }
        runSearch(
          source,
          nextQuery,
          capturedTransport,
          capturedScopeKey,
          capturedSession,
          capturedLocale
        )
      }, SEARCH_DEBOUNCE_MS)
    },
    [clearPendingTimer, runSearch]
  )

  const retrySearch = useCallback(() => {
    const live = liveRef.current
    if (
      !live.activeSource ||
      !live.transport ||
      !live.draftScopeKey ||
      !live.sessionContext
    ) {
      return
    }
    runSearch(
      live.activeSource,
      live.query,
      live.transport,
      live.draftScopeKey,
      live.sessionContext,
      live.locale
    )
  }, [runSearch])

  const attachItem = useCallback(
    (item: PluginAttachmentSourceItem) => {
      const live = liveRef.current
      const source = live.activeSource
      const scopeKey = live.draftScopeKey
      if (
        !source ||
        !scopeKey ||
        !live.activeEnabled ||
        !live.transportReady ||
        !live.transport ||
        !isCurrentReadyHostTransport(live.transport) ||
        !live.liveSourceKeys.has(source.key)
      ) {
        return
      }
      const key = `${source.key}:${item.id}`
      const nextEntry: AttachedPluginItem = {
        key,
        pluginId: source.pluginId,
        pluginName: source.pluginName,
        sourceId: source.id,
        sourceKey: source.key,
        sourceTitle: source.title,
        item,
      }
      setAttachedByScope((previous) => {
        const currentList = previous[scopeKey] ?? []
        const existingIndex = currentList.findIndex(
          (entry) => entry.key === key
        )
        const nextList =
          existingIndex >= 0
            ? currentList.map((entry, idx) =>
                idx === existingIndex ? nextEntry : entry
              )
            : [...currentList, nextEntry]
        return { ...previous, [scopeKey]: nextList }
      })
      closePicker()
    },
    [closePicker]
  )

  const removeAttachedItem = useCallback((key: string) => {
    const scopeKey = liveRef.current.draftScopeKey
    if (!scopeKey) return
    setAttachedByScope((previous) => {
      const currentList = previous[scopeKey]
      if (!currentList?.length) return previous
      const nextList = currentList.filter((entry) => entry.key !== key)
      if (nextList.length === currentList.length) return previous
      if (nextList.length === 0) {
        const rest = { ...previous }
        delete rest[scopeKey]
        return rest
      }
      return { ...previous, [scopeKey]: nextList }
    })
  }, [])

  const clearAttachedItems = useCallback(() => {
    const scopeKey = liveRef.current.draftScopeKey
    if (!scopeKey) return
    setAttachedByScope((previous) => {
      if (!(scopeKey in previous)) return previous
      const rest = { ...previous }
      delete rest[scopeKey]
      return rest
    })
  }, [])

  const attachedItems = useMemo(
    () => (draftScopeKey ? (attachedByScope[draftScopeKey] ?? []) : []),
    [attachedByScope, draftScopeKey]
  )

  return {
    sources,
    activeSource,
    query,
    setQuery,
    items: activeSource ? searchState.items : [],
    loading: activeSource ? searchState.loading : false,
    error: activeSource ? searchState.error : null,
    openSource,
    closePicker,
    retrySearch,
    attachedItems,
    attachItem,
    removeAttachedItem,
    clearAttachedItems,
  }
}

export const ComposerPluginAttachmentPicker = memo(
  function ComposerPluginAttachmentPicker({
    controller,
  }: {
    controller: Pick<
      ComposerPluginAttachmentController,
      | "activeSource"
      | "query"
      | "setQuery"
      | "items"
      | "loading"
      | "error"
      | "closePicker"
      | "retrySearch"
      | "attachItem"
    >
  }) {
    const t = useTranslations("HostPlugins")
    const {
      activeSource,
      query,
      setQuery,
      items,
      loading,
      error,
      closePicker,
      retrySearch,
      attachItem,
    } = controller

    const handleOpenChange = useCallback(
      (nextOpen: boolean) => {
        if (!nextOpen) closePicker()
      },
      [closePicker]
    )

    if (!activeSource) return null

    const dialogTitle = activeSource.pickerTitle ?? activeSource.title
    const placeholder =
      activeSource.searchPlaceholder ?? t("attachmentSearchPlaceholder")

    return (
      <Dialog open onOpenChange={handleOpenChange}>
        <DialogContent
          data-slot="composer-plugin-attachment-picker"
          className="w-[calc(100vw-2rem)] max-w-lg gap-3 p-4 sm:p-5"
        >
          <DialogHeader className="min-w-0 pr-6 text-left">
            <DialogTitle className="truncate text-sm font-semibold">
              {dialogTitle}
            </DialogTitle>
            <DialogDescription className="truncate text-xs text-muted-foreground">
              {activeSource.pluginName}
            </DialogDescription>
          </DialogHeader>

          <div className="flex items-center gap-2 rounded-md border border-input bg-background px-2.5 py-1.5 focus-within:ring-2 focus-within:ring-ring/40">
            <Search
              className="size-4 shrink-0 text-muted-foreground"
              aria-hidden
            />
            <input
              type="search"
              role="searchbox"
              autoFocus
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={placeholder}
              aria-label={placeholder}
              className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
              autoComplete="off"
              spellCheck={false}
            />
            {loading && (
              <Loader2
                className="size-3.5 shrink-0 animate-spin text-muted-foreground"
                aria-hidden
              />
            )}
          </div>

          <div className="max-h-72 min-h-24 overflow-y-auto">
            {error ? (
              <div className="flex flex-col items-center justify-center gap-2 px-3 py-6 text-center">
                <p className="text-xs text-destructive">
                  {t("attachmentSearchFailed")}
                </p>
                <p className="max-w-full break-words text-xs text-muted-foreground">
                  {error}
                </p>
                <Button
                  type="button"
                  size="xs"
                  variant="outline"
                  onClick={retrySearch}
                >
                  {t("retry")}
                </Button>
              </div>
            ) : loading && items.length === 0 ? (
              <div className="flex items-center justify-center gap-2 px-3 py-8 text-xs text-muted-foreground">
                <Loader2 className="size-4 animate-spin" aria-hidden />
                <span>{t("loading")}</span>
              </div>
            ) : items.length === 0 ? (
              <div className="px-3 py-8 text-center text-xs text-muted-foreground">
                {t("attachmentSearchEmpty")}
              </div>
            ) : (
              <ul role="listbox" aria-label={dialogTitle} className="space-y-1">
                {items.map((item) => (
                  <li key={item.id}>
                    <button
                      type="button"
                      onClick={() => attachItem(item)}
                      className="flex w-full flex-col gap-0.5 rounded-md px-2.5 py-2 text-left transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:outline-none"
                    >
                      <div className="flex min-w-0 items-center gap-2">
                        {item.identifier && (
                          <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] font-medium text-muted-foreground">
                            {item.identifier}
                          </span>
                        )}
                        <span className="min-w-0 flex-1 truncate text-sm font-medium">
                          {item.title}
                        </span>
                        {item.resourceType && (
                          <span className="shrink-0 rounded border border-border/70 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                            {item.resourceType}
                          </span>
                        )}
                      </div>
                      {item.subtitle && (
                        <span className="truncate text-xs text-muted-foreground">
                          {item.subtitle}
                        </span>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </DialogContent>
      </Dialog>
    )
  }
)

ComposerPluginAttachmentPicker.displayName = "ComposerPluginAttachmentPicker"

export const ComposerPluginAttachmentPills = memo(
  function ComposerPluginAttachmentPills({
    items,
    onRemove,
  }: {
    items: readonly AttachedPluginItem[]
    onRemove: (key: string) => void
  }) {
    const t = useTranslations("HostPlugins")
    if (items.length === 0) return null

    return (
      <>
        {items.map((attached) => {
          const fullLabel = formatAttachedPluginItemLabel(attached.item)
          return (
            <div
              key={attached.key}
              data-slot="composer-plugin-attachment-pill"
              className="inline-flex max-w-60 shrink-0 items-center gap-1.5 rounded-md border border-border/80 bg-muted/60 px-2 py-1 text-xs text-foreground"
              title={
                attached.item.subtitle
                  ? `${fullLabel} — ${attached.item.subtitle}`
                  : fullLabel
              }
            >
              <Puzzle
                className="size-3 shrink-0 text-muted-foreground"
                aria-hidden
              />
              {attached.item.identifier && (
                <span className="shrink-0 font-mono text-[11px] font-medium text-muted-foreground">
                  {attached.item.identifier}
                </span>
              )}
              <span className="min-w-0 truncate font-medium">
                {attached.item.title}
              </span>
              <button
                type="button"
                aria-label={t("removeAttachment", { name: fullLabel })}
                onClick={(event) => {
                  event.stopPropagation()
                  onRemove(attached.key)
                }}
                className="ml-0.5 inline-flex size-4 shrink-0 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                <X className="size-3" aria-hidden />
              </button>
            </div>
          )
        })}
      </>
    )
  }
)

ComposerPluginAttachmentPills.displayName = "ComposerPluginAttachmentPills"
