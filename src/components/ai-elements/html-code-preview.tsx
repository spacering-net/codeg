"use client"

import { useEffect, useRef, useState, type ReactNode } from "react"
import { useTranslations } from "next-intl"
import { useTheme } from "next-themes"
import { Button } from "@/components/ui/button"
import { buildChatHtmlDocument } from "@/lib/chat-html-document"
import {
  HTML_PREVIEW_SIZE_MESSAGE_TYPE,
  readHtmlPreviewTheme,
} from "@/lib/html-preview-frame"
import { cn, randomUUID } from "@/lib/utils"

interface FrameEntry {
  /** `null` when the build failed: the fence stays code. */
  doc: string | null
  /** The theme tokens it was built with; other tokens rebuild it. */
  theme: string
  /** What the frame last reported, while it reported anything. */
  height?: number
}

interface View {
  preview: boolean
  expanded: boolean
}

const DEFAULT_VIEW: View = { preview: true, expanded: false }
const THROTTLE_MS = 250

/**
 * The documents previews built, by theme and source, the height each
 * measured, and the view the reader picked, by source. Streamdown draws a
 * finished reply as a new tree, so every preview in a reply mounts again the
 * moment it stops streaming; these bring it back as it was, instead of
 * "Generating", then growing from the default height, back in its first view.
 */
const frames = new Map<string, FrameEntry>()
const views = new Map<string, View>()
/** Previews on screen, by `frames` key: their entries are never evicted. */
const pins = new Map<string, number>()
const CACHE_LIMIT = 32

function remember<T>(cache: Map<string, T>, key: string, value: T) {
  cache.delete(key)
  cache.set(key, value)
  for (const oldest of cache.keys()) {
    if (cache.size <= CACHE_LIMIT) break
    if (cache !== frames || !pins.has(oldest)) cache.delete(oldest)
  }
}

/** Tests only. */
export function resetHtmlPreviewCachesForTests(): void {
  frames.clear()
  views.clear()
}

export function HtmlCodePending() {
  const t = useTranslations("HtmlCodePreview")
  return (
    <div
      role="status"
      className="my-2 rounded-lg border border-dashed px-4 py-3 text-xs text-muted-foreground"
    >
      {t("generating")}
    </div>
  )
}

export function HtmlCodePreview({
  source,
  children,
  pending = false,
}: {
  source: string
  children: ReactNode
  pending?: boolean
}) {
  const t = useTranslations("HtmlCodePreview")
  const { resolvedTheme } = useTheme()
  const dark = resolvedTheme === "dark"
  const [view, setView] = useState(() => views.get(source) ?? DEFAULT_VIEW)
  const { preview, expanded } = view
  const changeView = (change: Partial<View>) => {
    const next = { ...view, ...change }
    remember(views, source, next)
    setView(next)
  }
  const frameRef = useRef<HTMLIFrameElement>(null)
  const frameLoadedRef = useRef(false)
  const pendingUpdateRef = useRef<string | null>(null)

  // Throttling for high-frequency streamed tokens (200~300ms)
  const [displaySource, setDisplaySource] = useState(source)
  const lastUpdateRef = useRef(0)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingSourceRef = useRef(source)

  useEffect(() => {
    pendingSourceRef.current = source
  }, [source])

  useEffect(() => {
    remember(views, source, view)
  }, [source, view])

  useEffect(() => {
    if (!pending) {
      if (timerRef.current) {
        clearTimeout(timerRef.current)
        timerRef.current = null
      }
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setDisplaySource(source)
      lastUpdateRef.current = Date.now()
      return
    }

    const now = Date.now()
    const elapsed = now - lastUpdateRef.current

    if (elapsed >= THROTTLE_MS) {
      if (timerRef.current) {
        clearTimeout(timerRef.current)
        timerRef.current = null
      }
      setDisplaySource(source)
      lastUpdateRef.current = now
    } else if (!timerRef.current) {
      timerRef.current = setTimeout(() => {
        timerRef.current = null
        setDisplaySource(pendingSourceRef.current)
        lastUpdateRef.current = Date.now()
      }, THROTTLE_MS - elapsed)
    }
  }, [source, pending])

  useEffect(() => {
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current)
        timerRef.current = null
      }
    }
  }, [])

  const key = `${dark}\0${displaySource}`
  const [frameDoc, setFrameDoc] = useState<string | null>(
    () => frames.get(key)?.doc ?? null
  )
  const [measured, setMeasured] = useState<{
    key: string
    height: number
  } | null>(null)

  // What is on screen stays in the cache once finished.
  useEffect(() => {
    if (pending) return
    pins.set(key, (pins.get(key) ?? 0) + 1)
    return () => {
      const count = (pins.get(key) ?? 1) - 1
      if (count > 0) pins.set(key, count)
      else pins.delete(key)
    }
  }, [key, pending])

  useEffect(() => {
    if (!displaySource.trim()) return
    const theme = readHtmlPreviewTheme()
    if (!pending && frames.get(key)?.theme === theme) return
    let active = true
    buildChatHtmlDocument(displaySource, {
      nonce: randomUUID(),
      dark,
      theme,
      pending,
    }).then(
      (doc) => {
        if (!active) return
        if (!pending) {
          remember(frames, key, {
            doc,
            theme,
            height: frames.get(key)?.height ?? measured?.height,
          })
          setFrameDoc(doc)
        } else {
          // Streaming: mount the shell once with the first valid doc.
          // All subsequent streaming deltas update via postMessage to prevent white flash / iframe teardown.
          if (frameDoc === null) {
            setFrameDoc(doc)
          } else if (
            frameLoadedRef.current &&
            frameRef.current?.contentWindow
          ) {
            frameRef.current.contentWindow.postMessage(
              { type: "codeg-html:update", html: doc },
              "*"
            )
          } else {
            pendingUpdateRef.current = doc
          }
        }
      },
      () => {
        if (!active) return
        if (!pending) {
          remember(frames, key, { doc: null, theme })
          setFrameDoc(null)
        }
      }
    )
    return () => {
      active = false
    }
  }, [displaySource, dark, key, pending, frameDoc, measured?.height])

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (!frameRef.current || event.source !== frameRef.current.contentWindow)
        return
      const data = event.data as { type?: unknown; height?: unknown } | null
      if (!data) return

      if (data.type === "codeg-html:ready") {
        frameLoadedRef.current = true
        if (pendingUpdateRef.current && frameRef.current.contentWindow) {
          frameRef.current.contentWindow.postMessage(
            { type: "codeg-html:update", html: pendingUpdateRef.current },
            "*"
          )
          pendingUpdateRef.current = null
        }
        return
      }

      if (
        data.type === HTML_PREVIEW_SIZE_MESSAGE_TYPE &&
        typeof data.height === "number" &&
        Number.isFinite(data.height)
      ) {
        const reported = Math.min(12000, Math.max(96, Math.ceil(data.height)))
        const entry = frames.get(key)
        if (entry) entry.height = reported
        setMeasured((prev) => {
          const nextHeight =
            pending && prev?.height ? Math.max(prev.height, reported) : reported
          return prev?.height === nextHeight
            ? prev
            : { key, height: nextHeight }
        })
      }
    }
    window.addEventListener("message", onMessage)
    return () => window.removeEventListener("message", onMessage)
  }, [key, pending])

  const cached = frames.get(key)
  const currentDoc = frameDoc ?? cached?.doc ?? null
  const height = measured?.height ?? cached?.height ?? 160
  // During streaming, allow frame height to expand smoothly to content height without forcing a scrollbar
  const overflows = !pending && height > 640
  const framed = preview && Boolean(currentDoc)
  const waiting = preview && !framed

  return (
    <section
      className="not-prose group/html relative my-2 min-w-0"
      dir="ltr"
      data-chat-html={preview ? "preview" : "code"}
    >
      <div
        className={cn(
          "absolute top-1 z-10 flex items-center gap-1 rounded-lg border bg-background/90 px-1 py-0.5 shadow-sm backdrop-blur transition-opacity",
          pending
            ? "opacity-100"
            : "opacity-0 group-hover/html:opacity-100 group-focus-within/html:opacity-100 max-sm:opacity-100",
          framed || waiting ? "end-1" : "end-18"
        )}
      >
        {pending && !waiting && (
          <span
            role="status"
            className="flex items-center gap-1.5 px-1.5 text-xs text-muted-foreground"
          >
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-500 opacity-75" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
            </span>
            <span className="text-[11px] font-medium max-xs:hidden">
              {t("generating")}
            </span>
          </span>
        )}
        <Button
          size="sm"
          variant={preview ? "ghost" : "secondary"}
          aria-pressed={!preview}
          onClick={() => changeView({ preview: false })}
        >
          {t("code")}
        </Button>
        <Button
          size="sm"
          variant={preview ? "secondary" : "ghost"}
          aria-pressed={preview}
          onClick={() => changeView({ preview: true })}
        >
          {t("preview")}
        </Button>
      </div>
      {framed && currentDoc ? (
        <iframe
          ref={frameRef}
          title={t("title")}
          className={cn(
            "block w-full border-0 bg-transparent transition-[height] duration-150",
            (!overflows || expanded) && "overflow-hidden"
          )}
          style={{ height: expanded || !overflows ? height : 640 }}
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
          srcDoc={currentDoc}
          onLoad={() => {
            frameLoadedRef.current = true
            if (pendingUpdateRef.current && frameRef.current?.contentWindow) {
              frameRef.current.contentWindow.postMessage(
                { type: "codeg-html:update", html: pendingUpdateRef.current },
                "*"
              )
              pendingUpdateRef.current = null
            }
          }}
        />
      ) : waiting ? (
        <HtmlCodePending />
      ) : (
        children
      )}
      {framed && overflows ? (
        <button
          type="button"
          className="w-full py-1 text-xs text-muted-foreground hover:text-foreground"
          onClick={() => changeView({ expanded: !expanded })}
        >
          {expanded ? t("collapse") : t("expand")}
        </button>
      ) : null}
    </section>
  )
}
