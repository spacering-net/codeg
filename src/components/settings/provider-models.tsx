"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import {
  AlertCircle,
  Check,
  ChevronsUpDown,
  ListChecks,
  Loader2,
  Plus,
  RefreshCw,
  Search,
  X,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import {
  useProviderModels,
  type ProviderModelsError,
  type ProviderModelsInput,
  type ProviderModelsState,
} from "@/hooks/use-provider-models"
import { getModelCatalog } from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"
import {
  normalizeModelIds,
  type ModelCatalogEntry,
  type ModelCatalogStatus,
  type ModelCatalogView,
} from "@/lib/types"
import { cn } from "@/lib/utils"

/** A translator scoped to `ProviderModels`, as next-intl hands it out. */
interface ProviderModelsTranslator {
  (key: string, values?: Record<string, string | number>): string
  has: (key: string) => boolean
}

/** The localized text of a failed fetch, the English message for a code
 *  without a translation. */
export function providerModelsErrorText(
  error: ProviderModelsError,
  t: ProviderModelsTranslator
): string {
  const key = `errors.${error.code}`
  if (!t.has(key)) return error.message
  return t(key, { ...error.params, message: error.message })
}

/** [`providerModelsErrorText`] in the page's language. */
export function useProviderModelsErrorText() {
  const t = useTranslations("ProviderModels") as ProviderModelsTranslator
  return useCallback(
    (error: ProviderModelsError) => providerModelsErrorText(error, t),
    [t]
  )
}

function formatContext(tokens: number | undefined): string {
  if (!tokens) return ""
  if (tokens >= 1_000_000) {
    return `${Number((tokens / 1_000_000).toFixed(1))}M`
  }
  return `${Math.round(tokens / 1000)}K`
}

function hostOf(url: string | undefined): string {
  if (!url) return ""
  try {
    return new URL(url).host
  } catch {
    return ""
  }
}

/** Whether a form can list models here at all: it can ask now, or says what
 *  it still needs to. `null` (no endpoint to ask) offers nothing. */
function canList(
  state: ProviderModelsState | null
): state is ProviderModelsState {
  return !!state && (state.request != null || state.missing != null)
}

/** Ask the provider unless its list is in hand or on its way: what opening a
 *  list of its models does. */
function fetchUnlessListed(state: ProviderModelsState) {
  if (!state.list && !state.fetching && state.request) void state.fetchNow()
}

/** "12 models · relay.example.com", or the reason there is no list. */
function useListedText() {
  const t = useTranslations("ProviderModels") as ProviderModelsTranslator
  return useCallback(
    (state: ProviderModelsState): string => {
      if (!state.list) return ""
      const host = hostOf(state.list.url) || hostOf(state.request?.baseUrl)
      return t("fromHost", { count: state.list.models.length, host })
    },
    [t]
  )
}

/**
 * What stands in for the provider's models while there are none to show:
 * the fetch on its way, what the form still needs before it can ask, a
 * failure with a way to try again, or a list that came back empty.
 */
function ProviderModelsPlaceholder({
  state,
  className,
}: {
  state: ProviderModelsState
  className?: string
}) {
  const t = useTranslations("ProviderModels") as ProviderModelsTranslator
  const box = cn(
    "flex flex-col items-center justify-center gap-3 px-4 py-6 text-center text-xs",
    className
  )
  if (state.missing) {
    return (
      <p className={cn(box, "text-muted-foreground")}>
        {state.missing === "apiKey" ? t("needKey") : t("needBaseUrl")}
      </p>
    )
  }
  if (state.fetching || (!state.list && !state.error)) {
    return (
      <p className={cn(box, "flex-row text-muted-foreground")} role="status">
        <Loader2 className="size-3.5 animate-spin" />
        {t("fetching")}
      </p>
    )
  }
  const retry = (
    <Button
      type="button"
      variant="outline"
      size="xs"
      onClick={() => void state.fetchNow()}
    >
      <RefreshCw />
      {t("retry")}
    </Button>
  )
  if (state.error) {
    return (
      <div className={box} role="alert">
        <p className="break-words text-destructive">
          {providerModelsErrorText(state.error, t)}
        </p>
        {retry}
      </div>
    )
  }
  return (
    <div className={cn(box, "text-muted-foreground")}>
      <p>{t("listed", { count: 0 })}</p>
      {retry}
    </div>
  )
}

/** Fetch the list again: the same control wherever a list of the provider's
 *  models is shown. */
export function ProviderModelsRefreshButton({
  fetching,
  onRefresh,
  disabled = false,
  label,
  className,
}: {
  fetching: boolean
  onRefresh: () => void
  disabled?: boolean
  /** Its name; "Fetch models" unless the list is someone else's. */
  label?: string
  className?: string
}) {
  const t = useTranslations("ProviderModels")
  const name = label ?? t("fetch")
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-xs"
      className={cn("text-muted-foreground", className)}
      onClick={onRefresh}
      disabled={disabled || fetching}
      title={name}
      aria-label={name}
    >
      <RefreshCw className={cn(fetching && "animate-spin")} />
    </Button>
  )
}

/** The provider's models as a searchable list to pick one from, with where
 *  they came from and a way to fetch them again under it. */
function ProviderModelsMenu({
  state,
  current,
  onSelect,
}: {
  state: ProviderModelsState
  current: string
  onSelect: (id: string) => void
}) {
  const t = useTranslations("ProviderModels") as ProviderModelsTranslator
  const listedText = useListedText()
  const models = state.list?.models ?? []
  const known = models.some((model) => model.id === current)
  if (models.length === 0) return <ProviderModelsPlaceholder state={state} />
  return (
    <Command
      // The model in the field is the one the list opens on.
      defaultValue={known ? current : undefined}
      className="rounded-none bg-transparent"
    >
      <CommandInput placeholder={t("search")} className="h-9 text-xs" />
      <CommandList className="max-h-64 p-1">
        <CommandEmpty className="py-6 text-center text-xs text-muted-foreground">
          {t("noMatch")}
        </CommandEmpty>
        {models.map((model) => (
          <CommandItem
            key={model.id}
            value={model.id}
            keywords={model.displayName ? [model.displayName] : undefined}
            onSelect={() => onSelect(model.id)}
            className="gap-2 rounded-lg px-2 py-1.5 text-xs"
          >
            <Check
              className={cn(
                "size-3.5 text-primary",
                model.id === current ? "opacity-100" : "opacity-0"
              )}
            />
            <span className="min-w-0 flex-1 truncate font-mono">
              {model.id}
            </span>
            {model.displayName && model.displayName !== model.id ? (
              <span className="max-w-[45%] shrink-0 truncate text-2xs text-muted-foreground">
                {model.displayName}
              </span>
            ) : null}
            {model.contextWindow ? (
              <span className="shrink-0 text-3xs tabular-nums text-muted-foreground">
                {formatContext(model.contextWindow)}
              </span>
            ) : null}
          </CommandItem>
        ))}
      </CommandList>
      <div className="flex items-center gap-2 border-t ps-3 pe-1.5 py-1">
        <span
          className={cn(
            "min-w-0 flex-1 truncate text-2xs",
            state.error ? "text-destructive" : "text-muted-foreground"
          )}
          role="status"
          title={
            state.error ? providerModelsErrorText(state.error, t) : undefined
          }
        >
          {state.error
            ? providerModelsErrorText(state.error, t)
            : listedText(state)}
        </span>
        <ProviderModelsRefreshButton
          fetching={state.fetching}
          onRefresh={() => void state.fetchNow()}
        />
      </div>
    </Command>
  )
}

/** The model catalog as the fields see it: entries to suggest, where they came
 *  from, and a way to download them again. */
export interface ModelCatalogState {
  entries: ModelCatalogEntry[]
  status: ModelCatalogStatus | null
  loading: boolean
  error: string | null
  refresh: () => void
}

/** Shared process-wide: the first field that opens the catalog downloads it,
 *  every other field reuses that copy until someone refreshes. */
let catalogCache: ModelCatalogView | null = null

/** Test seam: the module-level cache otherwise survives across tests in a
 *  file, so a test that mocks a different catalog must clear it first. */
export function resetModelCatalogCacheForTests(): void {
  catalogCache = null
}

export function useModelCatalog(): ModelCatalogState {
  const [view, setView] = useState<ModelCatalogView | null>(catalogCache)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async (force: boolean) => {
    setLoading(true)
    setError(null)
    try {
      const next = await getModelCatalog(force)
      catalogCache = next
      setView(next)
      setError(next.status.error)
    } catch (err) {
      setError(toErrorMessage(err))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!catalogCache) void load(false)
  }, [load])

  const refresh = useCallback(() => {
    void load(true)
  }, [load])

  return {
    entries: view?.entries ?? catalogCache?.entries ?? [],
    status: view?.status ?? catalogCache?.status ?? null,
    loading,
    error,
    refresh,
  }
}

/** How many rows a catalog menu renders: litellm lists thousands of chat
 *  models, and typing narrows them well before this cap. */
const CATALOG_ROW_LIMIT = 50

export function catalogMatches(
  entries: ModelCatalogEntry[],
  query: string
): ModelCatalogEntry[] {
  const q = query.trim().toLowerCase()
  // Below two characters the field is still an id being typed, not a search:
  // only the chevron's full list browses from here.
  if (q.length < 2) return entries.slice(0, CATALOG_ROW_LIMIT)
  return entries
    .filter(
      (entry) =>
        entry.model.toLowerCase().includes(q) ||
        entry.id.toLowerCase().includes(q)
    )
    .slice(0, CATALOG_ROW_LIMIT)
}

/** litellm keys are ids, not labels, so the catalog carries no display name.
 *  Derive one from the model id: split on `-` (also treating `_` and a remaining
 *  `/` as separators), capitalize each part's first letter, join with spaces —
 *  `gpt-5` → `Gpt 5`, `claude-sonnet-4-5` → `Claude Sonnet 4 5`. Used by every
 *  form with a name / label field next to a model id. */
export function catalogDisplayName(entry: ModelCatalogEntry): string {
  const parts = entry.model.split(/[-_/]+/).filter(Boolean)
  if (parts.length === 0) return entry.model
  return parts
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ")
}

/** A description built from what the catalog actually declares: its key,
 *  capacities and capability flags. Forms use it where a picked model needs a
 *  short human-readable note and the catalog has no description of its own. */
export function catalogDescription(entry: ModelCatalogEntry): string {
  const bits: string[] = [entry.id]
  const capacity = [
    entry.maxInputTokens ? `${formatContext(entry.maxInputTokens)} input` : "",
    entry.maxOutputTokens
      ? `${formatContext(entry.maxOutputTokens)} output`
      : "",
  ].filter(Boolean)
  if (capacity.length) bits.push(capacity.join(" / "))
  const flags = [
    entry.supportsReasoning ? "reasoning" : "",
    entry.supportsVision ? "vision" : "",
    entry.supportsFunctionCalling ? "tools" : "",
  ].filter(Boolean)
  if (flags.length) bits.push(flags.join(", "))
  return bits.join(" · ")
}

export function ModelCatalogMenu({
  catalog,
  query,
  current,
  onSelect,
}: {
  catalog: ModelCatalogState
  query: string
  /** The id in the field: only the row it matches is marked as picked. */
  current: string
  onSelect: (entry: ModelCatalogEntry) => void
}) {
  const t = useTranslations("ModelCatalog")
  const matches = useMemo(
    () => catalogMatches(catalog.entries, query),
    [catalog.entries, query]
  )
  const summary = catalog.status
    ? t("summary", {
        count: catalog.status.entryCount,
        time: catalog.status.updatedAt
          ? new Intl.DateTimeFormat(undefined, {
              dateStyle: "medium",
              timeStyle: "short",
            }).format(new Date(catalog.status.updatedAt * 1000))
          : t("neverUpdated"),
      })
    : t("loading")
  return (
    <Command className="rounded-none bg-transparent">
      <CommandList className="max-h-64 p-1">
        <CommandEmpty className="py-6 text-center text-xs text-muted-foreground">
          {catalog.error ? catalog.error : t("noMatch")}
        </CommandEmpty>
        {matches.map((entry) => {
          // A check on every row reads as "already selected". Only the model
          // actually in the field carries one; the rest keep a blank spacer so
          // the columns stay aligned.
          const picked =
            current.length > 0 &&
            (entry.model === current || entry.id === current)
          return (
            <CommandItem
              key={entry.id}
              value={entry.id}
              onSelect={() => onSelect(entry)}
              className="gap-2 rounded-lg px-2 py-1.5 text-xs"
            >
              {picked ? (
                <Check className="size-3.5 shrink-0 text-primary" />
              ) : (
                <span className="size-3.5 shrink-0" />
              )}
              <span className="min-w-0 flex-1 truncate font-mono">
                {entry.model}
              </span>
              <span className="max-w-[35%] shrink-0 truncate text-2xs text-muted-foreground">
                {entry.provider}
              </span>
              {entry.maxInputTokens ? (
                <span className="shrink-0 text-3xs tabular-nums text-muted-foreground">
                  {formatContext(entry.maxInputTokens)}
                </span>
              ) : null}
            </CommandItem>
          )
        })}
      </CommandList>
      <div className="flex items-center gap-2 border-t ps-3 pe-1.5 py-1">
        <span
          className={cn(
            "min-w-0 flex-1 truncate text-2xs",
            catalog.error ? "text-destructive" : "text-muted-foreground"
          )}
          role="status"
          title={catalog.error ?? summary}
        >
          {catalog.error ?? summary}
        </span>
        <ProviderModelsRefreshButton
          fetching={catalog.loading}
          onRefresh={catalog.refresh}
          label={t("refresh")}
        />
      </div>
    </Command>
  )
}

/**
 * A model id field: typed freely, or chosen from the provider's models from
 * the chevron at its end. The first time the list opens it asks the provider;
 * until it can (no key or URL yet) the list says what it still needs, and a
 * failed fetch says why, with a retry, so a field never needs a fetch button
 * of its own. Without an endpoint to ask (`state` null, or a field that is
 * read-only or disabled) it is a plain input.
 */
export function ModelIdInputWithFetch({
  id,
  value,
  onChange,
  state,
  catalog = null,
  onCatalogPick,
  placeholder,
  disabled = false,
  readOnly = false,
  className,
  inputClassName,
  "aria-label": ariaLabel,
  "aria-invalid": ariaInvalid,
}: {
  id?: string
  value: string
  onChange: (value: string) => void
  /** The provider's models; `null` where they cannot be fetched. */
  state: ProviderModelsState | null
  /** The model catalog to suggest from as the id is typed. */
  catalog?: ModelCatalogState | null
  /** Called with the catalog entry a pick filled the field from, after the
   *  id is written. Its patch is applied last, so the form can overwrite the
   *  row's capability fields with the picked model's values. */
  onCatalogPick?: (entry: ModelCatalogEntry) => void
  placeholder?: string
  disabled?: boolean
  readOnly?: boolean
  className?: string
  inputClassName?: string
  "aria-label"?: string
  "aria-invalid"?: boolean
}) {
  const t = useTranslations("ProviderModels") as ProviderModelsTranslator
  const [open, setOpen] = useState(false)
  // `null` = the provider's list (or nothing); a string = the catalog shown
  // with that query, where "" browses the whole catalog.
  const [catalogQuery, setCatalogQuery] = useState<string | null>(null)
  // Opening the list from typing must not move focus out of the field: Radix
  // focuses PopoverContent on mount, which would swallow the rest of an id
  // being typed after the second character.
  const openedByTyping = useRef(false)
  // Only an actual pick is marked with a check — never an id that merely
  // happens to match a catalog row while it is being typed.
  const [pickedId, setPickedId] = useState<string | null>(null)

  // The provider's list it offers, when it offers one.
  const menu = !disabled && !readOnly && canList(state) ? state : null
  const catalogMenu = !disabled && !readOnly ? catalog : null
  const offer = menu != null || catalogMenu != null

  const closeMenu = () => {
    setOpen(false)
    setCatalogQuery(null)
    openedByTyping.current = false
  }
  const openFromChevron = () => {
    openedByTyping.current = false
    // The chevron browses: the provider's own list when it has one, else the
    // entire catalog. It never inherits the filter from typing.
    setCatalogQuery(menu ? null : "")
    setOpen(true)
    if (menu) fetchUnlessListed(menu)
  }
  const openFromTyping = (query: string) => {
    openedByTyping.current = true
    setCatalogQuery(query)
    setOpen(true)
  }
  const setMenuOpen = (next: boolean) => {
    if (next) openFromChevron()
    else closeMenu()
  }

  const input = (
    <Input
      id={id}
      value={value}
      onChange={(event) => {
        const next = event.target.value
        onChange(next)
        setPickedId(null)
        // Only open while there is something to suggest: a catalog still
        // loading (or empty) must not put a popover over a field being typed.
        if (
          catalogMenu &&
          catalogMenu.entries.length > 0 &&
          next.trim().length >= 2
        )
          openFromTyping(next)
      }}
      onKeyDown={(event) => {
        // The list opens from the field too, as a combobox's does.
        if (
          offer &&
          event.key === "ArrowDown" &&
          !event.nativeEvent.isComposing &&
          !open
        ) {
          event.preventDefault()
          openFromChevron()
        }
      }}
      placeholder={placeholder}
      disabled={disabled}
      readOnly={readOnly}
      autoComplete="off"
      spellCheck={false}
      aria-label={ariaLabel}
      aria-invalid={ariaInvalid}
      className={cn(offer && "pe-9", inputClassName)}
    />
  )
  if (!menu && !catalogMenu) return <div className={className}>{input}</div>

  // A failed fetch shows on the chevron too, once the list is closed: the
  // field says it has a list it could not get, and why.
  const failed =
    (!!menu?.error && !menu.list && !menu.fetching) ||
    (menu == null && !!catalogMenu?.error)
  const busy = menu?.fetching || catalogMenu?.loading
  const errorText = menu?.error
    ? providerModelsErrorText(menu.error, t)
    : (catalogMenu?.error ?? null)
  return (
    <Popover open={open} onOpenChange={setMenuOpen}>
      <PopoverAnchor asChild>
        <div className={cn("relative", className)}>
          {input}
          <PopoverTrigger asChild>
            <button
              type="button"
              onClick={(event) => {
                // The chevron always opens the browse list, even when typing
                // already opened the catalog below. Radix's trigger would only
                // toggle (closing that menu), so handle the click ourselves
                // and stop its composed toggle with preventDefault.
                event.preventDefault()
                openFromChevron()
              }}
              className={cn(
                "absolute inset-y-0 end-0 flex w-9 items-center justify-center rounded-e-4xl outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
                failed
                  ? "text-destructive"
                  : "text-muted-foreground hover:text-foreground"
              )}
              aria-label={t("choose")}
              title={failed && errorText ? errorText : t("choose")}
            >
              {busy ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : failed ? (
                <AlertCircle className="size-3.5" />
              ) : (
                <ChevronsUpDown className="size-3.5" />
              )}
            </button>
          </PopoverTrigger>
        </div>
      </PopoverAnchor>
      <PopoverContent
        align="start"
        sideOffset={6}
        onOpenAutoFocus={(event) => {
          if (openedByTyping.current) event.preventDefault()
        }}
        className="w-(--radix-popover-trigger-width) min-w-72 max-w-[min(36rem,var(--radix-popover-content-available-width))] gap-0 overflow-hidden p-0"
      >
        {catalogMenu && catalogQuery !== null ? (
          <ModelCatalogMenu
            catalog={catalogMenu}
            query={catalogQuery}
            current={pickedId ?? ""}
            onSelect={(entry) => {
              // The id patch runs first; the form's capability patch runs
              // last so it wins over the id-only patch (both are computed
              // from the same render's state).
              onChange(entry.model)
              onCatalogPick?.(entry)
              setPickedId(entry.id)
              closeMenu()
            }}
          />
        ) : menu ? (
          <ProviderModelsMenu
            state={menu}
            current={value.trim()}
            onSelect={(next) => {
              onChange(next)
              closeMenu()
            }}
          />
        ) : null}
      </PopoverContent>
    </Popover>
  )
}

/**
 * A model id field backed only by the model catalog: the same combobox, for a
 * form with no provider endpoint to list from (the DeepSeek catalog editor).
 */
export function ModelIdInputWithCatalog({
  id,
  value,
  onChange,
  onPick,
  placeholder,
  disabled = false,
  readOnly = false,
  className,
  inputClassName,
  "aria-label": ariaLabel,
  "aria-invalid": ariaInvalid,
}: {
  id?: string
  value: string
  onChange: (value: string) => void
  onPick?: (entry: ModelCatalogEntry) => void
  placeholder?: string
  disabled?: boolean
  readOnly?: boolean
  className?: string
  inputClassName?: string
  "aria-label"?: string
  "aria-invalid"?: boolean
}) {
  const catalog = useModelCatalog()
  return (
    <ModelIdInputWithFetch
      id={id}
      value={value}
      onChange={onChange}
      state={null}
      catalog={catalog}
      onCatalogPick={onPick}
      placeholder={placeholder}
      disabled={disabled}
      readOnly={readOnly}
      className={className}
      inputClassName={inputClassName}
      aria-label={ariaLabel}
      aria-invalid={ariaInvalid}
    />
  )
}

/**
 * Model ids one per line (OpenCode's custom provider editor). Two or more
 * characters on the line the caret is on offers matching catalog models for
 * THAT line; picking one replaces only that line, leaving the other lines —
 * and the caret inside the textarea — alone.
 */
export function ModelIdLinesTextarea({
  value,
  onChange,
  placeholder,
  className,
  disabled = false,
  "aria-label": ariaLabel,
}: {
  value: string
  onChange: (value: string) => void
  placeholder?: string
  className?: string
  disabled?: boolean
  "aria-label"?: string
}) {
  const catalog = useModelCatalog()
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const [open, setOpen] = useState(false)
  // The caret's line: its text used as the search query, and its offsets in
  // `value` so a pick replaces exactly that line.
  const [line, setLine] = useState<{
    query: string
    start: number
    end: number
  } | null>(null)

  const syncFromCaret = (el: HTMLTextAreaElement, text: string) => {
    if (disabled || el.selectionStart == null) return
    const caret = el.selectionStart
    const start = text.slice(0, caret).lastIndexOf("\n") + 1
    const breakAt = text.indexOf("\n", caret)
    const end = breakAt === -1 ? text.length : breakAt
    const query = text.slice(start, end).trim()
    if (query.length >= 2) {
      setLine({ query, start, end })
      setOpen(true)
    } else {
      setOpen(false)
    }
  }

  const pick = (entry: ModelCatalogEntry) => {
    if (!line) return
    const next =
      value.slice(0, line.start) + entry.model + value.slice(line.end)
    onChange(next)
    setOpen(false)
    // The menu never took focus, so put the caret just after the inserted id.
    const caret = line.start + entry.model.length
    requestAnimationFrame(() => {
      const el = textareaRef.current
      if (el) {
        el.focus()
        el.setSelectionRange(caret, caret)
      }
    })
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverAnchor asChild>
        <Textarea
          ref={textareaRef}
          value={value}
          onChange={(event) => {
            onChange(event.target.value)
            syncFromCaret(event.target, event.target.value)
          }}
          onClick={(event) =>
            syncFromCaret(event.currentTarget, event.currentTarget.value)
          }
          onKeyUp={(event) => {
            // Escape closes the menu; don't immediately reopen it for the
            // same line on that key's keyup.
            if (event.key === "Escape") return
            syncFromCaret(event.currentTarget, event.currentTarget.value)
          }}
          placeholder={placeholder}
          className={className}
          disabled={disabled}
          aria-label={ariaLabel}
          autoComplete="off"
          spellCheck={false}
        />
      </PopoverAnchor>
      <PopoverContent
        align="start"
        sideOffset={6}
        // Typing must continue in the textarea while the suggestions are up.
        onOpenAutoFocus={(event) => event.preventDefault()}
        onCloseAutoFocus={(event) => event.preventDefault()}
        className="w-80 max-w-[min(36rem,var(--radix-popover-content-available-width))] gap-0 overflow-hidden p-0"
      >
        {line && (
          <ModelCatalogMenu
            catalog={catalog}
            query={line.query}
            current=""
            onSelect={pick}
          />
        )}
      </PopoverContent>
    </Popover>
  )
}

/** One row of [`ModelPickerDialog`]. */
export interface ModelPickerItem {
  id: string
  /** A second line about it. */
  hint?: string
  /** `new`: listed for the first time; `gone`: the provider stopped listing
   *  it; `unlisted`: configured, but not among the provider's models. */
  badge?: "new" | "gone" | "unlisted"
}

/** Pick ids from a provider's list. Rows the provider does not (or no
 *  longer) list come first, so a configured one is not missed; `removals` are
 *  picks about to go, each with an opt-in to keep it (`keepLabel`). With a
 *  `source`, the dialog is the provider's list itself: it shows the fetch on
 *  its way, what is missing or why it failed, and fetches again on request. */
export function ModelPickerDialog({
  open,
  onOpenChange,
  title,
  description,
  items,
  initial,
  removals = [],
  keepLabel,
  source,
  onConfirm,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description?: string
  items: ModelPickerItem[]
  initial: string[]
  removals?: string[]
  keepLabel?: string
  /** The provider's list the rows come from, when the dialog fetches it. */
  source?: ProviderModelsState
  onConfirm: (picked: string[], keep: string[]) => void
}) {
  const t = useTranslations("ProviderModels.picker")
  const tp = useTranslations("ProviderModels") as ProviderModelsTranslator
  const listedText = useListedText()
  const [picked, setPicked] = useState<Set<string>>(() => new Set(initial))
  const [keep, setKeep] = useState<Set<string>>(() => new Set())
  const [filter, setFilter] = useState("")

  useEffect(() => {
    if (!open) return
    setPicked(new Set(initial))
    setKeep(new Set())
    setFilter("")
    // Reset only when the dialog opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase()
    const list = q
      ? items.filter(
          (item) =>
            item.id.toLowerCase().includes(q) ||
            !!item.hint?.toLowerCase().includes(q)
        )
      : items
    const apart = (item: ModelPickerItem) =>
      item.badge === "gone" || item.badge === "unlisted"
    return [...list.filter(apart), ...list.filter((item) => !apart(item))]
  }, [items, filter])

  const toggle = (set: Set<string>, id: string, on: boolean) => {
    const next = new Set(set)
    if (on) next.add(id)
    else next.delete(id)
    return next
  }

  // Waiting for the list, or a list with nothing in it: the dialog says
  // why. Ids configured already stay pickable meanwhile.
  const waiting = !!source && (!source.list || source.list.models.length === 0)
  const listed = source?.list ? listedText(source) : ""
  // A refresh that failed leaves the list it had; the footer says why.
  const refreshFailed =
    source?.list && source.error && !source.fetching
      ? providerModelsErrorText(source.error, tp)
      : ""

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-4 sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        <div className="space-y-2">
          <div className="flex items-center gap-1">
            <div className="relative min-w-0 flex-1">
              <Search className="pointer-events-none absolute start-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder={t("filter")}
                aria-label={t("filter")}
                className="h-8 ps-8 text-xs"
              />
            </div>
            <Button
              type="button"
              variant="ghost"
              size="xs"
              onClick={() =>
                setPicked(new Set([...picked, ...shown.map((i) => i.id)]))
              }
            >
              {t("all")}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="xs"
              onClick={() => {
                const hidden = new Set(shown.map((i) => i.id))
                setPicked(new Set([...picked].filter((id) => !hidden.has(id))))
              }}
            >
              {t("none")}
            </Button>
          </div>
          <div className="max-h-80 overflow-y-auto rounded-xl border">
            {shown.map((item) => (
              <label
                key={item.id}
                className="flex cursor-pointer items-center gap-2.5 px-3 py-2 text-xs transition-colors hover:bg-muted/50 [&+label]:border-t"
              >
                <Checkbox
                  checked={picked.has(item.id)}
                  onCheckedChange={(v) =>
                    setPicked(toggle(picked, item.id, v === true))
                  }
                />
                <span className="min-w-0 flex-1 truncate font-mono">
                  {item.id}
                </span>
                {item.hint && (
                  <span className="max-w-[45%] shrink-0 truncate text-2xs text-muted-foreground">
                    {item.hint}
                  </span>
                )}
                {item.badge === "new" && (
                  <span className="shrink-0 rounded-full bg-primary/10 px-1.5 text-2xs text-primary">
                    {t("badgeNew")}
                  </span>
                )}
                {item.badge === "gone" && (
                  <span className="shrink-0 rounded-full bg-amber-500/10 px-1.5 text-2xs text-amber-600 dark:text-amber-400">
                    {t("badgeGone")}
                  </span>
                )}
                {item.badge === "unlisted" && (
                  <span className="shrink-0 rounded-full bg-amber-500/10 px-1.5 text-2xs text-amber-600 dark:text-amber-400">
                    {t("badgeUnlisted")}
                  </span>
                )}
              </label>
            ))}
            {waiting ? (
              <ProviderModelsPlaceholder
                state={source}
                className={shown.length > 0 ? "border-t" : undefined}
              />
            ) : shown.length === 0 ? (
              <p className="py-6 text-center text-2xs text-muted-foreground">
                {t("empty")}
              </p>
            ) : null}
          </div>
          {removals.length > 0 && (
            <div className="space-y-1 rounded-xl border border-amber-500/30 bg-amber-500/5 p-2.5">
              <p className="text-2xs text-amber-600 dark:text-amber-400">
                {t("removalsTitle", { count: removals.length })}
              </p>
              {removals.map((id) => (
                <label key={id} className="flex items-center gap-2 text-2xs">
                  <Checkbox
                    checked={keep.has(id)}
                    onCheckedChange={(v) =>
                      setKeep(toggle(keep, id, v === true))
                    }
                  />
                  <span className="min-w-0 flex-1 truncate font-mono">
                    {id}
                  </span>
                  <span className="text-muted-foreground">
                    {keepLabel ?? t("keep")}
                  </span>
                </label>
              ))}
            </div>
          )}
        </div>
        <DialogFooter className="items-center sm:justify-between">
          <div className="flex min-w-0 items-center gap-1 self-start text-2xs text-muted-foreground sm:self-center">
            <span
              className={cn("truncate", refreshFailed && "text-destructive")}
              role="status"
              title={refreshFailed || undefined}
            >
              {refreshFailed ||
                [t("selected", { count: picked.size }), listed]
                  .filter(Boolean)
                  .join(" · ")}
            </span>
            {source?.list ? (
              <ProviderModelsRefreshButton
                fetching={source.fetching}
                onRefresh={() => void source.fetchNow()}
              />
            ) : null}
          </div>
          <div className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              {t("cancel")}
            </Button>
            <Button
              type="button"
              onClick={() => {
                // In the list's order.
                onConfirm(
                  items.map((i) => i.id).filter((id) => picked.has(id)),
                  [...keep]
                )
                onOpenChange(false)
              }}
            >
              {t("confirm", { count: picked.size })}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** "Choose models…": opens the provider's list to pick the ids to keep from,
 *  asking the provider when there is no list yet. Configured ids the provider
 *  does not list stay in the dialog, picked, so confirming never drops one
 *  unseen. */
export function FetchedModelPicker({
  state,
  configured,
  onConfirm,
  title,
  description,
  disabled = false,
  className,
}: {
  state: ProviderModelsState
  /** The ids the form has now, in its order. */
  configured: string[]
  /** The configured ids still picked, in their order, then the new picks in
   *  the provider's. */
  onConfirm: (ids: string[]) => void
  title?: string
  description?: string
  disabled?: boolean
  className?: string
}) {
  const t = useTranslations("ProviderModels")
  const [open, setOpen] = useState(false)
  // A dialog is not opened only to say what is missing: until the form can
  // ask, the button waits, and says why on hover.
  const waitingFor = state.missing
    ? state.missing === "apiKey"
      ? t("needKey")
      : t("needBaseUrl")
    : undefined

  const items = useMemo<ModelPickerItem[]>(() => {
    const listed = state.list?.models ?? []
    const known = new Set(listed.map((m) => m.id))
    const unlisted = configured
      .filter((id) => id.trim() && !known.has(id))
      // Before the list is in, a configured id is just configured.
      .map((id) => ({
        id,
        badge: state.list ? ("unlisted" as const) : undefined,
      }))
    return [
      ...unlisted,
      ...listed.map((m) => ({
        id: m.id,
        hint: [
          m.displayName && m.displayName !== m.id ? m.displayName : "",
          formatContext(m.contextWindow),
        ]
          .filter(Boolean)
          .join(" · "),
      })),
    ]
  }, [state.list, configured])

  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="xs"
        onClick={() => {
          setOpen(true)
          fetchUnlessListed(state)
        }}
        disabled={disabled || !state.request}
        title={waitingFor}
        className={cn("h-7", className)}
      >
        <ListChecks />
        {t("pick")}
      </Button>
      <ModelPickerDialog
        open={open}
        onOpenChange={setOpen}
        title={title ?? t("picker.title")}
        description={description}
        items={items}
        initial={configured}
        source={state}
        onConfirm={(picked) => {
          const chosen = new Set(picked)
          const kept = configured.filter((id) => chosen.has(id))
          const had = new Set(kept)
          onConfirm([...kept, ...picked.filter((id) => !had.has(id))])
        }}
      />
    </>
  )
}

/** A list of model ids an agent offers: each removable, more added from the
 *  provider's models (`state`) or typed in — several at once, split on
 *  spaces and commas. */
export function ModelIdListField({
  ids,
  onChange,
  onPick,
  state,
  readOnly = false,
  title,
  hint,
}: {
  ids: string[]
  onChange: (ids: string[]) => void
  /** A catalog pick in the add field: lets the form adopt the model's declared
   *  capabilities, not just its id. */
  onPick?: (entry: ModelCatalogEntry) => void
  /** The provider's models; `null` where they cannot be fetched. */
  state: ProviderModelsState | null
  readOnly?: boolean
  title: string
  hint?: string
}) {
  const t = useTranslations("ProviderModels.list")
  const [typed, setTyped] = useState("")
  const add = () => {
    const next = normalizeModelIds([...ids, ...typed.split(/[\s,]+/)])
    if (next.length !== ids.length) onChange(next)
    setTyped("")
  }
  return (
    <div className="space-y-1.5">
      <div className="flex min-h-7 items-center justify-between gap-2">
        <span className="text-2xs text-muted-foreground">{title}</span>
        {!readOnly && canList(state) && (
          <FetchedModelPicker
            state={state}
            configured={ids}
            onConfirm={(picked) => onChange(normalizeModelIds(picked))}
          />
        )}
      </div>
      {ids.length > 0 ? (
        <div className="flex flex-wrap gap-1">
          {ids.map((id) => (
            <span
              key={id}
              className="inline-flex h-6 max-w-full items-center gap-1 rounded-full border bg-muted/40 ps-2.5 pe-1.5 font-mono text-2xs"
            >
              <span className="truncate">{id}</span>
              {!readOnly && (
                <button
                  type="button"
                  className="rounded-full text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                  aria-label={t("remove", { id })}
                  onClick={() => onChange(ids.filter((other) => other !== id))}
                >
                  <X className="size-3" />
                </button>
              )}
            </span>
          ))}
        </div>
      ) : (
        <p className="text-2xs text-muted-foreground">{t("empty")}</p>
      )}
      {!readOnly && (
        <div
          className="flex items-center gap-1"
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.nativeEvent.isComposing) {
              event.preventDefault()
              add()
            }
          }}
        >
          <ModelIdInputWithCatalog
            value={typed}
            onChange={setTyped}
            onPick={onPick}
            placeholder={t("addPlaceholder")}
            aria-label={t("addPlaceholder")}
            className="h-7 flex-1 text-xs"
          />
          <Button
            type="button"
            variant="outline"
            size="xs"
            className="h-7"
            onClick={add}
            disabled={!typed.trim()}
          >
            <Plus />
            {t("add")}
          </Button>
        </div>
      )}
      {hint && <p className="text-2xs text-muted-foreground">{hint}</p>}
    </div>
  )
}

/** [`FetchedModelPicker`] with a fetch of its own, for a form that shows one
 *  per provider. */
export function ProviderModelsPicker({
  input,
  configured,
  onConfirm,
  disabled = false,
}: {
  input: ProviderModelsInput
  configured: string[]
  onConfirm: (ids: string[]) => void
  disabled?: boolean
}) {
  const state = useProviderModels(input)
  return (
    <FetchedModelPicker
      state={state}
      configured={configured}
      onConfirm={onConfirm}
      disabled={disabled}
    />
  )
}
