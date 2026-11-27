/** Display-only translation of public catalog prose, with bounded local cache. */
export const CATALOG_TRANSLATION_CACHE = "harness:catalog-translations:v1"
const MAX_CACHE_ENTRIES = 512
const MAX_CACHE_CHARS = 500_000
const CACHE_TTL = 7 * 24 * 60 * 60 * 1000
const MAX_TEXT = 1500
const CONCURRENCY = 4

export type CatalogTranslationRequest = (
  text: string,
  target: string,
  signal: AbortSignal
) => Promise<string>

/** This optional provider uses Google's web translation endpoint, not a keyed API. */
export const requestCatalogTranslation: CatalogTranslationRequest = async (
  text,
  target,
  signal
) => {
  const query = new URLSearchParams({
    client: "gtx",
    sl: "auto",
    tl: target,
    dt: "t",
    q: text,
  })
  const response = await fetch(
    `https://translate.googleapis.com/translate_a/single?${query}`,
    { signal, credentials: "omit" }
  )
  if (!response.ok) throw new Error("Catalog translation unavailable")
  const data: unknown = await response.json()
  const rows = Array.isArray(data) && Array.isArray(data[0]) ? data[0] : null
  if (
    !rows ||
    rows.some((row) => !Array.isArray(row) || typeof row[0] !== "string")
  ) {
    throw new Error("Invalid catalog translation")
  }
  const translated = rows.map((row) => row[0] as string).join("")
  if (!translated.trim() || translated.length > 12_000) {
    throw new Error("Invalid catalog translation")
  }
  return translated
}

interface CacheEntry {
  text: string
  expires: number
}

interface Job {
  key: string
  text: string
  target: string
  owners: number
  phase: "queued" | "active" | "failed" | "done"
  controller: AbortController
}

function cacheKey(text: string, target: string): string {
  return JSON.stringify([target, text])
}

/** Requests are owned by mounted views; leaving one aborts its unused work. */
export class CatalogTranslator {
  private cache = new Map<string, CacheEntry>()
  private jobs = new Map<string, Job>()
  private listeners = new Set<() => void>()
  private queue: Job[] = []
  private running = 0
  private revision = 0
  private pumpTimer: ReturnType<typeof setTimeout> | null = null
  private saveTimer: ReturnType<typeof setTimeout> | null = null
  private notifyTimer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private storage: Pick<Storage, "getItem" | "setItem"> | null = null,
    private request: CatalogTranslationRequest = requestCatalogTranslation
  ) {
    try {
      const entries: unknown = JSON.parse(
        storage?.getItem(CATALOG_TRANSLATION_CACHE) ?? "[]"
      )
      if (!Array.isArray(entries)) return
      for (const row of entries.slice(-MAX_CACHE_ENTRIES)) {
        if (!Array.isArray(row) || row.length !== 2) continue
        const [key, value] = row
        if (
          typeof key !== "string" ||
          key.length > 4000 ||
          !value ||
          typeof value !== "object"
        )
          continue
        const entry = value as Partial<CacheEntry>
        if (
          typeof entry.text === "string" &&
          entry.text.length <= 12_000 &&
          typeof entry.expires === "number" &&
          entry.expires > Date.now()
        ) {
          this.cache.set(key, { text: entry.text, expires: entry.expires })
        }
      }
    } catch {
      /* Storage can be unavailable or contain an older value. */
    }
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  snapshot = () => this.revision

  lookup(text: string, target: string): string | undefined {
    const entry = this.cache.get(cacheKey(text, target))
    return entry && entry.expires > Date.now() ? entry.text : undefined
  }

  get pending(): number {
    return [...this.jobs.values()].filter(
      (job) =>
        job.owners > 0 && (job.phase === "queued" || job.phase === "active")
    ).length
  }

  get failed(): number {
    return [...this.jobs.values()].filter(
      (job) => job.owners > 0 && job.phase === "failed"
    ).length
  }

  watch(texts: readonly string[], target: string): () => void {
    const owned: Job[] = []
    for (const text of new Set(texts)) {
      if (
        !text.trim() ||
        text.length > MAX_TEXT ||
        this.lookup(text, target) !== undefined
      )
        continue
      const key = cacheKey(text, target)
      let job = this.jobs.get(key)
      if (!job) {
        job = {
          key,
          text,
          target,
          owners: 0,
          phase: "queued",
          controller: new AbortController(),
        }
        this.jobs.set(key, job)
        this.queue.push(job)
      }
      job.owners += 1
      owned.push(job)
    }
    this.schedule()
    return () => {
      for (const job of owned) {
        job.owners -= 1
        if (job.owners !== 0 || this.jobs.get(job.key) !== job) continue
        job.controller.abort()
        this.jobs.delete(job.key)
      }
      this.queue = this.queue.filter(
        (job) => job.owners > 0 && this.jobs.get(job.key) === job
      )
      this.notify()
    }
  }

  retry(): void {
    for (const job of this.jobs.values()) {
      if (job.phase !== "failed" || job.owners === 0) continue
      job.phase = "queued"
      job.controller = new AbortController()
      this.queue.push(job)
    }
    this.schedule()
  }

  cancel(): void {
    for (const job of this.jobs.values()) job.controller.abort()
    this.jobs.clear()
    this.queue = []
    if (this.pumpTimer !== null) clearTimeout(this.pumpTimer)
    this.pumpTimer = null
    this.notify()
  }

  private schedule(): void {
    if (this.pumpTimer === null && this.queue.length) {
      this.pumpTimer = setTimeout(() => {
        this.pumpTimer = null
        this.pump()
      }, 0)
    }
  }

  private pump(): void {
    while (this.running < CONCURRENCY && this.queue.length) {
      const job = this.queue.shift()!
      if (job.owners === 0 || this.jobs.get(job.key) !== job) continue
      this.running += 1
      job.phase = "active"
      const timeout = setTimeout(() => job.controller.abort(), 12_000)
      void Promise.resolve()
        .then(() => this.request(job.text, job.target, job.controller.signal))
        .then((text) => {
          if (
            job.controller.signal.aborted ||
            job.owners === 0 ||
            this.jobs.get(job.key) !== job
          )
            return
          if (!text.trim() || text.length > 12_000)
            throw new Error("Invalid catalog translation")
          this.cache.delete(job.key)
          this.cache.set(job.key, { text, expires: Date.now() + CACHE_TTL })
          while (this.cache.size > MAX_CACHE_ENTRIES)
            this.cache.delete(this.cache.keys().next().value!)
          job.phase = "done"
          this.save()
        })
        .catch(() => {
          if (job.owners > 0 && this.jobs.get(job.key) === job)
            job.phase = "failed"
        })
        .finally(() => {
          clearTimeout(timeout)
          this.running -= 1
          this.notify()
          this.pump()
        })
    }
    this.notify()
  }

  private notify(): void {
    if (this.notifyTimer !== null) return
    this.notifyTimer = setTimeout(() => {
      this.notifyTimer = null
      this.revision += 1
      for (const listener of this.listeners) listener()
    }, 30)
  }

  private save(): void {
    if (this.saveTimer !== null || !this.storage) return
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      const entries = [...this.cache.entries()]
      let data = JSON.stringify(entries)
      while (data.length > MAX_CACHE_CHARS && entries.length) {
        entries.shift()
        data = JSON.stringify(entries)
      }
      try {
        this.storage?.setItem(CATALOG_TRANSLATION_CACHE, data)
      } catch {
        /* Keep the memory cache. */
      }
    }, 250)
  }
}

export interface CatalogTextPart {
  text: string
  protected: boolean
}

/** Keep code and link destinations out of requests, including unclosed code. */
export function catalogTextParts(text: string): CatalogTextPart[] {
  const protectedText = /(`+)[\s\S]*?(?:\1|$)|https?:\/\/[^\s<>]+/gi
  const parts: CatalogTextPart[] = []
  const prose = (value: string) => {
    while (value.length > MAX_TEXT) {
      const space = value.lastIndexOf(" ", MAX_TEXT)
      const split = space > MAX_TEXT / 2 ? space : MAX_TEXT
      parts.push({ text: value.slice(0, split), protected: false })
      value = value.slice(split)
    }
    if (value) parts.push({ text: value, protected: false })
  }
  let offset = 0
  for (const match of text.matchAll(protectedText)) {
    prose(text.slice(offset, match.index))
    parts.push({ text: match[0], protected: true })
    offset = match.index! + match[0].length
  }
  prose(text.slice(offset))
  return parts
}

/** Avoid requesting prose which is already Chinese in a Chinese interface. */
export function needsCatalogTranslation(text: string, target: string): boolean {
  if (!text.trim()) return false
  if (!target.toLowerCase().startsWith("zh")) return true
  const han = (text.match(/\p{Script=Han}/gu) ?? []).length
  const latin = (text.match(/[A-Za-z]/g) ?? []).length
  return han < Math.max(3, latin / 8) && latin > 1
}

export function catalogTextSources(text: string, target: string): string[] {
  return catalogTextParts(text).flatMap((part) =>
    !part.protected && needsCatalogTranslation(part.text, target)
      ? [part.text.trim()]
      : []
  )
}

export function translatedCatalogText(
  text: string,
  target: string,
  translator: Pick<CatalogTranslator, "lookup">
): string {
  return catalogTextParts(text)
    .map((part) => {
      if (part.protected) return part.text
      const value = translator.lookup(part.text.trim(), target)
      if (value === undefined) return part.text
      const whitespace = /^(\s*)[\s\S]*?(\s*)$/.exec(part.text)!
      return whitespace[1] + value + whitespace[2]
    })
    .join("")
}
