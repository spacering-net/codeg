"use client"

import {
  useCallback,
  useEffect,
  useId,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type Ref,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react"
import {
  CaseSensitive,
  FileIcon,
  Folder,
  Loader2,
  Regex,
  Search,
  TextSearch,
  X,
  type LucideIcon,
} from "lucide-react"
import { useTranslations } from "next-intl"
import { detectPlatform } from "@/hooks/use-platform"
import { toFlatFileEntries, type FlatFileEntry } from "@/hooks/use-file-tree"
import {
  cancelWorkspaceSearch,
  listWorkspaceFiles,
  searchWorkspaceContent,
} from "@/lib/api"
import {
  toLocalizedErrorMessage,
  type AppErrorTranslator,
} from "@/lib/app-error"
import {
  fileMatchHighlights,
  rankFileMatches,
  sliceHighlightRanges,
  type HighlightRange,
} from "@/lib/file-search-match"
import type {
  WorkspaceContentSearchFile,
  WorkspaceContentSearchLine,
  WorkspaceContentSearchResult,
} from "@/lib/types"
import { cn } from "@/lib/utils"
import { ScrollArea } from "@/components/ui/scroll-area"

/** Name results shown; the rest is summarised as "showing the first N". */
export const NAME_RESULT_LIMIT = 200
/** Matching lines asked of the backend per content search. */
export const CONTENT_RESULT_LIMIT = 500
/** Name ranking runs in memory, so it only waits out a burst of typing. */
export const NAME_DEBOUNCE_MS = 120
/** Content search walks the disk; wait for a pause before starting one. */
export const CONTENT_DEBOUNCE_MS = 250

export type FileTreeSearchMode = "name" | "content"

// Search keys must be unique across every client of one backend (several
// browser tabs can share a codeg-server), and `useId` is only unique within a
// page, so it is prefixed with a per-page random part.
const PAGE_KEY_PREFIX = Math.random().toString(36).slice(2, 10)

export interface FileTreeSearchHandle {
  /** Focus the search box and select its text. */
  focus: () => void
}

interface FileTreeSearchProps {
  ref?: Ref<FileTreeSearchHandle>
  /** Absolute path of the folder the tab shows; every search is scoped to it. */
  rootPath: string
  /** Open a file (relative path), optionally at a 1-based line. */
  onOpenFile: (relPath: string, line?: number) => void
  /** Show a directory (relative path) in the tree. */
  onRevealDir: (relPath: string) => void
  /**
   * Called when the box gains or loses text. While it has text the results
   * show, and the caller hides the tree they replace.
   */
  onActiveChange?: (active: boolean) => void
}

/** Cmd+F on macOS, Ctrl+F elsewhere: "find in this panel". */
export function isFindShortcut(event: {
  key: string
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
}): boolean {
  if (event.key.toLowerCase() !== "f" || event.altKey || event.shiftKey) {
    return false
  }
  return detectPlatform() === "macos"
    ? event.metaKey && !event.ctrlKey
    : event.ctrlKey && !event.metaKey
}

interface FileIndexState {
  requestId: string
  root: string
  files: FlatFileEntry[]
  error: unknown
}

interface ContentState {
  requestId: string
  root: string
  result: WorkspaceContentSearchResult | null
  error: unknown
}

type SearchItem =
  | {
      kind: "entry"
      key: string
      entry: FlatFileEntry
      ranges: HighlightRange[]
    }
  | { kind: "file"; key: string; file: WorkspaceContentSearchFile }
  | {
      kind: "line"
      key: string
      file: WorkspaceContentSearchFile
      match: WorkspaceContentSearchLine
    }

function optionDomId(listId: string, index: number): string {
  return `${listId}-option-${index}`
}

function parentPath(path: string): string {
  const slash = path.lastIndexOf("/")
  return slash === -1 ? "" : path.slice(0, slash)
}

function Highlighted({
  text,
  ranges,
}: {
  text: string
  ranges: readonly HighlightRange[]
}) {
  if (ranges.length === 0) return <>{text}</>
  const parts: ReactNode[] = []
  let pos = 0
  ranges.forEach(([start, end], i) => {
    if (start > pos) parts.push(text.slice(pos, start))
    parts.push(
      <mark
        key={i}
        className="rounded-sm bg-yellow-400/30 text-foreground dark:bg-yellow-300/25"
      >
        {text.slice(start, end)}
      </mark>
    )
    pos = end
  })
  if (pos < text.length) parts.push(text.slice(pos))
  return <>{parts}</>
}

function ToggleButton({
  icon: Icon,
  label,
  pressed,
  onToggle,
}: {
  icon: LucideIcon
  label: string
  pressed: boolean
  onToggle: () => void
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={pressed}
      // Keep focus (and the caret) in the search box.
      onMouseDown={(event) => event.preventDefault()}
      onClick={onToggle}
      className={cn(
        "flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground",
        pressed && "bg-primary/15 text-foreground hover:bg-primary/20"
      )}
    >
      <Icon className="size-3.5" />
    </button>
  )
}

/**
 * Search box for the file tree tab, scoped to the tab's folder (including the
 * folders linked into it). Once it has text, a flat result list fills the
 * space below it and the caller hides the tree (see `onActiveChange`).
 *
 * - Name mode ranks the gitignore-aware `list_workspace_files` listing in
 *   memory (the ranking the search dialog uses), so typing never waits on the
 *   disk. The listing is fetched afresh each time a search starts.
 * - Content mode asks the backend (`search_workspace_content`), debounced; a
 *   newer query supersedes the running one on the backend (same search key)
 *   and any late response is discarded here.
 *
 * Keyboard: the caller routes Cmd/Ctrl+F to `focus()` (see `isFindShortcut`);
 * Up/Down move the active result, Enter opens it, Esc clears the search.
 */
export function FileTreeSearch({
  ref,
  rootPath,
  onOpenFile,
  onRevealDir,
  onActiveChange,
}: FileTreeSearchProps) {
  const t = useTranslations("Folder.fileTreeTab")
  const inputRef = useRef<HTMLInputElement>(null)
  const listId = useId()
  const baseKey = `${PAGE_KEY_PREFIX}${listId}`

  const [query, setQuery] = useState("")
  const [debouncedQuery, setDebouncedQuery] = useState("")
  const [mode, setMode] = useState<FileTreeSearchMode>("name")
  const [caseSensitive, setCaseSensitive] = useState(false)
  const [regex, setRegex] = useState(false)
  const [activeKey, setActiveKey] = useState<string | null>(null)
  // Bumped each time a search starts, so the listing is refetched once per
  // search rather than once per keystroke.
  const [indexGeneration, setIndexGeneration] = useState(0)
  const [fileIndex, setFileIndex] = useState<FileIndexState | null>(null)
  const [content, setContent] = useState<ContentState | null>(null)
  // The key of the content search still running on the backend (null when
  // none), and a counter folded into new keys after an explicit cancel, so a
  // cancel that arrives late can never hit a search started after it.
  const inFlightRef = useRef<{ key: string | null }>({ key: null })
  const keySessionRef = useRef(0)

  const searching = query.trim() !== ""
  const hasDebouncedQuery = debouncedQuery.trim() !== ""

  // ─── debounce ───
  useEffect(() => {
    if (!query.trim()) return
    const delay = mode === "content" ? CONTENT_DEBOUNCE_MS : NAME_DEBOUNCE_MS
    const timer = setTimeout(() => setDebouncedQuery(query), delay)
    return () => clearTimeout(timer)
  }, [query, mode])

  // ─── name mode: the listing ───
  const indexRequestId =
    searching && mode === "name" ? `${rootPath}\n${indexGeneration}` : null
  useEffect(() => {
    if (indexRequestId === null || fileIndex?.requestId === indexRequestId) {
      return
    }
    let stale = false
    listWorkspaceFiles(rootPath)
      .then((entries) => {
        if (stale) return
        setFileIndex({
          requestId: indexRequestId,
          root: rootPath,
          files: toFlatFileEntries(entries),
          error: null,
        })
      })
      .catch((error: unknown) => {
        if (stale) return
        setFileIndex({
          requestId: indexRequestId,
          root: rootPath,
          files: [],
          error,
        })
      })
    return () => {
      stale = true
    }
  }, [indexRequestId, rootPath, fileIndex?.requestId])

  // A refetch keeps showing the previous listing of the same folder; another
  // folder's listing is never shown.
  const indexFiles = fileIndex?.root === rootPath ? fileIndex.files : null
  const indexLoading =
    indexRequestId !== null && fileIndex?.requestId !== indexRequestId

  const nameResults = useMemo(() => {
    if (mode !== "name" || !hasDebouncedQuery || !indexFiles) return null
    const ranked = rankFileMatches(
      debouncedQuery,
      indexFiles,
      NAME_RESULT_LIMIT + 1
    )
    return {
      entries: ranked.slice(0, NAME_RESULT_LIMIT),
      truncated: ranked.length > NAME_RESULT_LIMIT,
    }
  }, [mode, hasDebouncedQuery, indexFiles, debouncedQuery])

  // ─── content mode ───
  const contentRequestId =
    mode === "content" && hasDebouncedQuery
      ? JSON.stringify([rootPath, debouncedQuery, caseSensitive, regex])
      : null
  useEffect(() => {
    if (contentRequestId === null) return
    let stale = false
    const inFlight = inFlightRef.current
    const searchKey = `${baseKey}:${keySessionRef.current}`
    inFlight.key = searchKey
    searchWorkspaceContent({
      rootPath,
      query: debouncedQuery,
      caseSensitive,
      regex,
      maxResults: CONTENT_RESULT_LIMIT,
      searchKey,
    })
      .then((result) => {
        if (stale) return
        inFlight.key = null
        setContent({
          requestId: contentRequestId,
          root: rootPath,
          result,
          error: null,
        })
      })
      .catch((error: unknown) => {
        if (stale) return
        inFlight.key = null
        setContent({
          requestId: contentRequestId,
          root: rootPath,
          result: null,
          error,
        })
      })
    // No explicit cancel here: the next search reuses the key, which stops
    // this one on the backend before it starts.
    return () => {
      stale = true
    }
  }, [
    contentRequestId,
    rootPath,
    debouncedQuery,
    caseSensitive,
    regex,
    baseKey,
  ])

  // Unmounting (the tab swaps in a loading state, the folder closes) stops a
  // search nobody will read, and tells the caller the results are gone so it
  // shows its tree again.
  const latest = useRef({ onActiveChange })
  useEffect(() => {
    latest.current.onActiveChange = onActiveChange
  }, [onActiveChange])
  useEffect(() => {
    const inFlight = inFlightRef.current
    const callbacks = latest.current
    return () => {
      if (inFlight.key) void cancelWorkspaceSearch(inFlight.key).catch(noop)
      callbacks.onActiveChange?.(false)
    }
  }, [])

  const contentLoading =
    contentRequestId !== null && content?.requestId !== contentRequestId
  // While a newer search runs, the previous results of the same folder stay up.
  const contentShown =
    mode === "content" && hasDebouncedQuery && content?.root === rootPath
      ? content
      : null

  // ─── items (flattened for keyboard navigation) ───
  const items = useMemo<SearchItem[]>(() => {
    if (mode === "name") {
      return (nameResults?.entries ?? []).map((entry) => ({
        kind: "entry",
        key: `entry:${entry.relativePath}`,
        entry,
        ranges: fileMatchHighlights(debouncedQuery, entry.relativePath),
      }))
    }
    const out: SearchItem[] = []
    for (const file of contentShown?.result?.files ?? []) {
      out.push({ kind: "file", key: `file:${file.path}`, file })
      for (const match of file.matches) {
        out.push({
          kind: "line",
          key: `line:${file.path}:${match.line}`,
          file,
          match,
        })
      }
    }
    return out
  }, [mode, nameResults, contentShown, debouncedQuery])

  const activeIndex = Math.max(
    0,
    items.findIndex((item) => item.key === activeKey)
  )
  const activeItem = items[activeIndex] ?? null

  // ─── actions ───
  const cancelInFlight = useCallback(() => {
    const inFlight = inFlightRef.current
    if (!inFlight.key) return
    void cancelWorkspaceSearch(inFlight.key).catch(noop)
    inFlight.key = null
    keySessionRef.current += 1
  }, [])

  const clearSearch = useCallback(() => {
    cancelInFlight()
    setQuery("")
    setDebouncedQuery("")
    setContent(null)
    setActiveKey(null)
    onActiveChange?.(false)
  }, [cancelInFlight, onActiveChange])

  const handleQueryChange = useCallback(
    (next: string) => {
      const active = next.trim() !== ""
      if (!active) {
        cancelInFlight()
        setDebouncedQuery("")
        setContent(null)
      } else if (!searching) {
        // A new search starts: refetch the listing so files created since
        // the last search show up.
        setIndexGeneration((n) => n + 1)
      }
      if (active !== searching) onActiveChange?.(active)
      setQuery(next)
      setActiveKey(null)
    },
    [cancelInFlight, searching, onActiveChange]
  )

  useImperativeHandle(
    ref,
    () => ({
      focus: () => {
        inputRef.current?.focus()
        inputRef.current?.select()
      },
    }),
    []
  )

  const openItem = useCallback(
    (item: SearchItem) => {
      switch (item.kind) {
        case "entry":
          if (item.entry.kind === "dir") {
            // A directory has nothing to open: leave the search and show it.
            clearSearch()
            onRevealDir(item.entry.relativePath)
          } else {
            onOpenFile(item.entry.relativePath)
          }
          break
        case "file":
          onOpenFile(item.file.path, item.file.matches[0]?.line)
          break
        case "line":
          onOpenFile(item.file.path, item.match.line)
          break
      }
    },
    [clearSearch, onOpenFile, onRevealDir]
  )

  const moveActive = useCallback(
    (delta: number) => {
      if (items.length === 0) return
      const next = Math.min(items.length - 1, Math.max(0, activeIndex + delta))
      setActiveKey(items[next].key)
      document
        .getElementById(optionDomId(listId, next))
        ?.scrollIntoView({ block: "nearest" })
    },
    [items, activeIndex, listId]
  )

  const handleInputKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLInputElement>) => {
      switch (event.key) {
        case "Escape":
          if (query) {
            event.preventDefault()
            // Handled: don't also close a surrounding drawer or dialog.
            event.stopPropagation()
            clearSearch()
          } else {
            inputRef.current?.blur()
          }
          break
        case "ArrowDown":
          event.preventDefault()
          moveActive(1)
          break
        case "ArrowUp":
          event.preventDefault()
          moveActive(-1)
          break
        case "Enter":
          if (event.nativeEvent.isComposing) return
          if (activeItem) {
            event.preventDefault()
            openItem(activeItem)
          }
          break
      }
    },
    [query, clearSearch, moveActive, activeItem, openItem]
  )

  // ─── status line ───
  // Backend errors carry an i18n key relative to this namespace.
  const translateError = t as unknown as AppErrorTranslator
  let status: ReactNode = null
  let statusTitle: string | undefined
  if (searching) {
    if (mode === "name") {
      if (fileIndex?.error && fileIndex.root === rootPath && !indexLoading) {
        status = (
          <span className="text-destructive">
            {toLocalizedErrorMessage(fileIndex.error, translateError)}
          </span>
        )
      } else if (!nameResults) {
        status = t("search.searching")
      } else if (nameResults.entries.length === 0) {
        status = indexLoading ? t("search.searching") : t("search.noResults")
      } else if (nameResults.truncated) {
        status = t("search.showingFirst", { count: NAME_RESULT_LIMIT })
      } else {
        status = t("search.nameSummary", {
          count: nameResults.entries.length,
        })
      }
    } else if (contentShown?.error) {
      status = (
        <span className="text-destructive">
          {toLocalizedErrorMessage(contentShown.error, translateError)}
        </span>
      )
    } else if (!contentShown?.result) {
      status = t("search.searching")
    } else {
      const result = contentShown.result
      if (result.result_count === 0) {
        status = contentLoading ? t("search.searching") : t("search.noResults")
      } else if (result.truncated) {
        status = t("search.showingFirst", { count: result.result_count })
      } else {
        status = t("search.contentSummary", {
          results: result.result_count,
          files: result.files.length,
        })
      }
      if (result.file_limit_reached) {
        status = (
          <>
            {status} ·{" "}
            {t("search.fileLimitReached", { count: result.files_searched })}
          </>
        )
      }
      if (result.files_skipped > 0) {
        statusTitle = t("search.skippedFiles", {
          count: result.files_skipped,
        })
      }
    }
  }
  const busy = searching && (mode === "name" ? indexLoading : contentLoading)

  return (
    <div
      className={cn("flex flex-col", searching ? "min-h-0 flex-1" : "shrink-0")}
    >
      <div className="shrink-0 px-2 pt-2 pb-1">
        <div className="flex h-7 items-center gap-1 rounded-md border border-input bg-background px-1.5 focus-within:ring-2 focus-within:ring-ring/50">
          <Search className="size-3.5 shrink-0 text-muted-foreground" />
          <input
            ref={inputRef}
            type="text"
            dir="auto"
            value={query}
            onChange={(event) => handleQueryChange(event.target.value)}
            onKeyDown={handleInputKeyDown}
            placeholder={
              mode === "content"
                ? t("search.placeholderContents")
                : t("search.placeholderNames")
            }
            aria-label={t("search.ariaLabel")}
            role="combobox"
            aria-expanded={searching}
            aria-controls={listId}
            aria-describedby={searching ? `${listId}-status` : undefined}
            aria-autocomplete="list"
            aria-activedescendant={
              searching && activeItem
                ? optionDomId(listId, activeIndex)
                : undefined
            }
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            className="h-full min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground"
          />
          {query && (
            <button
              type="button"
              title={t("search.clear")}
              aria-label={t("search.clear")}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                clearSearch()
                inputRef.current?.focus()
              }}
              className="flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <X className="size-3.5" />
            </button>
          )}
          {mode === "content" && (
            <>
              <ToggleButton
                icon={CaseSensitive}
                label={t("search.matchCase")}
                pressed={caseSensitive}
                onToggle={() => setCaseSensitive((v) => !v)}
              />
              <ToggleButton
                icon={Regex}
                label={t("search.useRegex")}
                pressed={regex}
                onToggle={() => setRegex((v) => !v)}
              />
            </>
          )}
          <ToggleButton
            icon={TextSearch}
            label={t("search.searchContents")}
            pressed={mode === "content"}
            onToggle={() => {
              if (mode === "content") cancelInFlight()
              setMode(mode === "content" ? "name" : "content")
              setActiveKey(null)
            }}
          />
        </div>
      </div>

      {searching && (
        <div className="flex min-h-0 flex-1 flex-col">
          <div
            id={`${listId}-status`}
            className="flex h-6 shrink-0 items-center gap-1.5 px-3 text-2xs text-muted-foreground"
            aria-live="polite"
            title={statusTitle}
          >
            {busy && <Loader2 className="size-3 shrink-0 animate-spin" />}
            {/* The tab content is laid out left-to-right in every locale;
                `auto` keeps a right-to-left sentence in its own order. */}
            <span dir="auto" className="min-w-0 truncate">
              {status}
            </span>
          </div>
          <ScrollArea className="min-h-0 flex-1 pb-1">
            <div
              id={listId}
              role="listbox"
              aria-label={t("search.resultsLabel")}
              className="px-1.5 font-mono text-sm"
            >
              {items.map((item, index) => (
                <SearchResultRow
                  key={item.key}
                  id={optionDomId(listId, index)}
                  item={item}
                  active={index === activeIndex}
                  onOpen={() => openItem(item)}
                  onHover={() => setActiveKey(item.key)}
                />
              ))}
            </div>
          </ScrollArea>
        </div>
      )}
    </div>
  )
}

function noop() {}

function SearchResultRow({
  id,
  item,
  active,
  onOpen,
  onHover,
}: {
  id: string
  item: SearchItem
  active: boolean
  onOpen: () => void
  onHover: () => void
}) {
  const rowClass = cn(
    "flex w-full cursor-pointer items-center gap-1.5 rounded py-1 pe-2",
    active ? "bg-muted-foreground/20" : "hover:bg-muted/50"
  )
  const common = {
    id,
    role: "option" as const,
    "aria-selected": active,
    // Keep focus in the search box so the keyboard keeps working.
    onMouseDown: (event: ReactMouseEvent) => event.preventDefault(),
    onClick: onOpen,
    onMouseMove: active ? undefined : onHover,
  }

  if (item.kind === "line") {
    const { match } = item
    return (
      <div
        {...common}
        className={cn(rowClass, "ps-7")}
        data-line={match.line}
        title={`${item.file.path}:${match.line}`}
      >
        <span className="w-8 shrink-0 text-end text-2xs text-muted-foreground tabular-nums">
          {match.line}
        </span>
        <span
          dir="ltr"
          className="min-w-0 overflow-hidden text-ellipsis whitespace-pre text-xs"
        >
          <Highlighted text={match.preview} ranges={match.ranges} />
        </span>
      </div>
    )
  }

  const isDir = item.kind === "entry" && item.entry.kind === "dir"
  const path = item.kind === "entry" ? item.entry.relativePath : item.file.path
  const nameStart = path.lastIndexOf("/") + 1
  const name = path.slice(nameStart)
  const dir = parentPath(path)
  const ranges = item.kind === "entry" ? item.ranges : []
  const Icon = isDir ? Folder : FileIcon

  return (
    <div {...common} className={cn(rowClass, "ps-2")} title={path}>
      <Icon className="size-4 shrink-0 text-muted-foreground" />
      <span dir="ltr" className="shrink-0 whitespace-nowrap">
        <Highlighted
          text={name}
          ranges={sliceHighlightRanges(ranges, nameStart, path.length)}
        />
      </span>
      {dir && (
        <span
          dir="ltr"
          className="min-w-0 truncate text-xs text-muted-foreground"
        >
          <Highlighted
            text={dir}
            ranges={sliceHighlightRanges(ranges, 0, dir.length)}
          />
        </span>
      )}
      {item.kind === "file" && (
        <span className="ms-auto shrink-0 rounded-full bg-muted px-1.5 text-2xs text-muted-foreground tabular-nums">
          {item.file.matches.length}
        </span>
      )}
    </div>
  )
}
