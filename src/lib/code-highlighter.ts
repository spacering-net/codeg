import type {
  BundledLanguage,
  BundledTheme,
  Highlighter,
  ThemeRegistrationAny,
  TokensResult,
} from "shiki"
import type {
  CodeHighlighterPlugin,
  HighlightOptions,
  ThemeInput,
} from "streamdown"

type HighlightRequest = Omit<HighlightOptions, "language"> & {
  language: string
  signal?: AbortSignal
}
type Callback = (result: TokensResult) => void

export const HIGHLIGHT_LIMITS = {
  cacheBytes: 16 * 1024 * 1024,
  cacheEntries: 128,
  inFlight: 16,
  // Legacy callers without a lifecycle cannot wait indefinitely in bulk.
  detachedWaiters: 128,
  // Same ceilings as the file source view (`SOURCE_VIEW_MAX_BYTES`/`_LINES`),
  // so every file it agrees to show is still highlighted.
  codeLength: 512 * 1024,
  lines: 5_000,
} as const

export const DEFAULT_CODE_THEMES: [ThemeInput, ThemeInput] = [
  "github-light",
  "github-dark",
]

const cache = new Map<string, { result: TokensResult; bytes: number }>()
const pending = new Map<
  string,
  { callbacks: Set<Callback>; cacheResult: boolean; prefetch: boolean }
>()
const loading = new Map<string, Promise<void>>()
// Only mounted subscribers wait here, without token trees or duplicate cache
// keys. Their cleanup removes them when a view unmounts or streaming advances.
const waiting = new Set<() => void>()
let detachedWaiters = 0
let retryScheduled = false
let cacheBytes = 0
let shikiPromise: Promise<typeof import("shiki")> | undefined
let highlighterPromise: Promise<Highlighter> | undefined

function loadShiki() {
  shikiPromise ??= import("shiki").catch((error) => {
    shikiPromise = undefined
    throw error
  })
  return shikiPromise
}

function getHighlighter() {
  // One engine and one copy of each theme, shared by Markdown and tool/file
  // code views. Importing this module does not eagerly load Shiki.
  highlighterPromise ??= loadShiki()
    .then(({ createHighlighter }) =>
      createHighlighter({ langs: [], themes: [] })
    )
    .catch((error) => {
      highlighterPromise = undefined
      throw error
    })
  return highlighterPromise
}

function once(key: string, load: () => Promise<void>) {
  const existing = loading.get(key)
  if (existing) return existing
  const task = load().finally(() => loading.delete(key))
  loading.set(key, task)
  return task
}

function cacheKey({ code, language, themes }: HighlightRequest) {
  // Full content prevents two snippets with equal lengths and ends from
  // incorrectly sharing tokens. The key's storage counts against the budget.
  return JSON.stringify([language, themes, code])
}

function read(key: string) {
  const entry = cache.get(key)
  if (!entry) return null
  cache.delete(key)
  cache.set(key, entry)
  return entry.result
}

function remember(key: string, result: TokensResult) {
  let bytes = key.length * 2 + 128
  for (const line of result.tokens) {
    bytes += 24
    for (const token of line) {
      bytes += 192 + token.content.length * 2
      for (const [name, value] of Object.entries(token.htmlStyle ?? {})) {
        bytes += 48 + (name.length + String(value).length) * 2
      }
    }
  }
  // A single large result must not evict the entire cache and then exceed it.
  if (bytes > HIGHLIGHT_LIMITS.cacheBytes) return
  const previous = cache.get(key)
  if (previous) {
    cacheBytes -= previous.bytes
    cache.delete(key)
  }
  while (
    cache.size >= HIGHLIGHT_LIMITS.cacheEntries ||
    cacheBytes + bytes > HIGHLIGHT_LIMITS.cacheBytes
  ) {
    const oldest = cache.entries().next().value
    if (!oldest) break
    cache.delete(oldest[0])
    cacheBytes -= oldest[1].bytes
  }
  cache.set(key, { result, bytes })
  cacheBytes += bytes
}

export function rawCodeTokens(code: string): TokensResult {
  return {
    fg: "inherit",
    bg: "transparent",
    tokens: code
      .split("\n")
      .map((content) =>
        content ? [{ content, color: "inherit", offset: 0 }] : []
      ),
  }
}

function canHighlight(code: string) {
  if (code.length > HIGHLIGHT_LIMITS.codeLength) return false
  let lines = 1
  for (let i = 0; i < code.length; i++) {
    if (code.charCodeAt(i) === 10 && ++lines > HIGHLIGHT_LIMITS.lines) {
      return false
    }
  }
  return true
}

export function getCachedHighlightedCode(options: HighlightRequest) {
  return canHighlight(options.code) ? read(cacheKey(options)) : null
}

function requestHighlight(
  options: HighlightRequest,
  callback?: Callback
): TokensResult | null | "busy" {
  if (!canHighlight(options.code)) return rawCodeTokens(options.code)
  const key = cacheKey(options)
  const cached = read(key)
  if (cached) return cached
  const existing = pending.get(key)
  if (existing) {
    if (callback) existing.callbacks.add(callback)
    else existing.prefetch = true
    existing.cacheResult ||= !options.isIncomplete
    return null
  }
  // Bound requests waiting for a cold grammar/engine too, not just results.
  if (pending.size >= HIGHLIGHT_LIMITS.inFlight) {
    return "busy"
  }
  const request = {
    callbacks: new Set(callback ? [callback] : []),
    cacheResult: !options.isIncomplete,
    prefetch: !callback,
  }
  pending.set(key, request)
  void (async () => {
    let result: TokensResult
    try {
      const [shiki, highlighter] = await Promise.all([
        loadShiki(),
        getHighlighter(),
      ])
      const name = options.language.trim().toLowerCase()
      const info = shiki.bundledLanguagesInfo.find(
        (entry) => entry.id === name || entry.aliases?.includes(name)
      )
      const language = info ? (info.id as BundledLanguage) : "text"
      // Streamdown deliberately declares permissive structural theme types;
      // its custom-theme objects are passed through to Shiki at this boundary.
      const themes = options.themes as [
        BundledTheme | ThemeRegistrationAny,
        BundledTheme | ThemeRegistrationAny,
      ]
      await Promise.all([
        ...(language !== "text" &&
        !highlighter.getLoadedLanguages().includes(language)
          ? [
              once(`language:${language}`, () =>
                highlighter.loadLanguage(language)
              ),
            ]
          : []),
        ...themes.map((theme) => {
          if (
            typeof theme === "string" &&
            highlighter.getLoadedThemes().includes(theme)
          ) {
            return undefined
          }
          return once(`theme:${JSON.stringify(theme)}`, () =>
            highlighter.loadTheme(theme)
          )
        }),
      ])
      // A streaming update or unmount can dispose the last subscriber while
      // the engine/grammar is loading. Do not tokenize that obsolete prefix.
      if (!request.prefetch && request.callbacks.size === 0) return
      result = highlighter.codeToTokens(options.code, {
        lang: language,
        themes: { light: themes[0], dark: themes[1] },
      })
      // Incomplete blocks are superseded on the next streaming batch. Keeping
      // every prefix turns one growing block into quadratic retained tokens.
      if (request.cacheResult) remember(key, result)
    } catch (error) {
      console.error("Failed to highlight code:", error)
      result = rawCodeTokens(options.code)
    } finally {
      pending.delete(key)
      scheduleRetries()
    }
    for (const listener of request.callbacks) {
      try {
        listener(result)
      } catch (error) {
        console.error("Failed to deliver highlighted code:", error)
      }
    }
    request.callbacks.clear()
  })()
  return null
}

function scheduleRetries() {
  if (retryScheduled || waiting.size === 0) return
  retryScheduled = true
  queueMicrotask(() => {
    retryScheduled = false
    let remaining = HIGHLIGHT_LIMITS.inFlight
    while (
      remaining-- > 0 &&
      pending.size < HIGHLIGHT_LIMITS.inFlight &&
      waiting.size > 0
    ) {
      const retry = waiting.values().next().value!
      waiting.delete(retry)
      try {
        retry()
      } catch (error) {
        console.error("Failed to deliver highlighted code:", error)
      }
    }
    if (pending.size < HIGHLIGHT_LIMITS.inFlight) scheduleRetries()
  })
}

export function highlightCode(
  options: HighlightRequest,
  callback?: Callback
): TokensResult | null {
  return startHighlight(options, callback).result
}

function startHighlight(options: HighlightRequest, callback?: Callback) {
  const signal = options.signal
  if (signal?.aborted) {
    return { result: rawCodeTokens(options.code), cancel: () => {} }
  }
  let active = true
  let detached = false
  const cancel = () => {
    active = false
    waiting.delete(retry)
    if (detached) {
      detachedWaiters--
      detached = false
    }
    signal?.removeEventListener("abort", cancel)
    for (const request of pending.values()) request.callbacks.delete(deliver)
  }
  const deliver: Callback = (result) => {
    if (!active) return
    cancel()
    callback?.(result)
  }
  const retry = () => {
    if (!active) return
    const result = requestHighlight(options, deliver)
    if (result === "busy") {
      waiting.add(retry)
    } else if (result) {
      deliver(result)
    }
  }
  const result = requestHighlight(options, callback ? deliver : undefined)
  if (result === "busy" && callback) {
    // Markdown and code views supply an AbortSignal: one waiter belongs to
    // one live view, removed on streaming replacement/unmount, and no token
    // tree or duplicate key is queued. There is no historical-prefix backlog.
    // Keep callback-only callers bounded too; app views use the lifecycle path.
    if (signal || detachedWaiters < HIGHLIGHT_LIMITS.detachedWaiters) {
      if (!signal) {
        detached = true
        detachedWaiters++
      }
      waiting.add(retry)
    } else {
      cancel()
    }
  }
  if (result !== null && result !== "busy") cancel()
  if (active && callback)
    signal?.addEventListener("abort", cancel, { once: true })
  return {
    result: result === "busy" ? rawCodeTokens(options.code) : result,
    cancel,
  }
}

export function subscribeHighlightedCode(
  options: HighlightRequest,
  callback: Callback
) {
  const abort = new AbortController()
  const onAbort = () => abort.abort()
  options.signal?.addEventListener("abort", onAbort, { once: true })
  if (options.signal?.aborted) abort.abort()
  const subscription = startHighlight(
    { ...options, signal: abort.signal },
    callback
  )
  if (subscription.result && !abort.signal.aborted)
    callback(subscription.result)
  return () => {
    options.signal?.removeEventListener("abort", onAbort)
    abort.abort()
    subscription.cancel()
  }
}

export function getCodeHighlightStats() {
  return {
    entries: cache.size,
    estimatedBytes: cacheBytes,
    inFlight: pending.size,
    waiting: waiting.size,
  }
}

export async function createCodePlugin(): Promise<CodeHighlighterPlugin> {
  const { bundledLanguagesInfo } = await loadShiki()
  const languages = new Set(
    bundledLanguagesInfo.flatMap(({ id, aliases }) => [id, ...(aliases ?? [])])
  )
  return {
    name: "shiki",
    type: "code-highlighter",
    highlight: highlightCode,
    supportsLanguage: (language) =>
      languages.has(language.trim().toLowerCase()),
    getSupportedLanguages: () => bundledLanguagesInfo.map(({ id }) => id),
    getThemes: () => DEFAULT_CODE_THEMES,
  }
}
