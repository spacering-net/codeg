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
}: {
  source: string
  children: ReactNode
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
  const key = `${dark}\0${source}`
  const [loaded, setLoaded] = useState<{
    key: string
    doc: string | null
  } | null>(null)
  const [measured, setMeasured] = useState<{
    key: string
    height: number
  } | null>(null)

  // What is on screen stays in the cache.
  useEffect(() => {
    pins.set(key, (pins.get(key) ?? 0) + 1)
    return () => {
      const count = (pins.get(key) ?? 1) - 1
      if (count > 0) pins.set(key, count)
      else pins.delete(key)
    }
  }, [key])

  useEffect(() => {
    const theme = readHtmlPreviewTheme()
    if (frames.get(key)?.theme === theme) return
    let active = true
    buildChatHtmlDocument(source, { nonce: randomUUID(), dark, theme }).then(
      (doc) => {
        remember(frames, key, {
          doc,
          theme,
          height: frames.get(key)?.height,
        })
        if (active) setLoaded({ key, doc })
      },
      () => {
        remember(frames, key, { doc: null, theme })
        if (active) setLoaded({ key, doc: null })
      }
    )
    return () => {
      active = false
    }
  }, [source, dark, key])

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (!frameRef.current || event.source !== frameRef.current.contentWindow)
        return
      const data = event.data as { type?: unknown; height?: unknown } | null
      if (
        !data ||
        data.type !== HTML_PREVIEW_SIZE_MESSAGE_TYPE ||
        typeof data.height !== "number" ||
        !Number.isFinite(data.height)
      )
        return
      const height = Math.min(12000, Math.max(96, Math.ceil(data.height)))
      const entry = frames.get(key)
      if (entry) entry.height = height
      setMeasured((prev) =>
        prev?.key === key && prev.height === height ? prev : { key, height }
      )
    }
    window.addEventListener("message", onMessage)
    return () => window.removeEventListener("message", onMessage)
  }, [key])

  const cached = frames.get(key)
  const current = cached ?? (loaded?.key === key ? loaded : null)
  const height =
    measured?.key === key ? measured.height : (cached?.height ?? 160)
  const overflows = height > 640
  const framed = preview && Boolean(current?.doc)
  const waiting = preview && current === null

  return (
    <section
      className="not-prose group/html relative my-2 min-w-0"
      dir="ltr"
      data-chat-html
    >
      <div
        className={cn(
          "absolute top-1 z-10 flex items-center gap-1 rounded-lg border bg-background/90 px-1 py-0.5 opacity-0 shadow-sm backdrop-blur transition-opacity group-hover/html:opacity-100 group-focus-within/html:opacity-100 max-sm:opacity-100",
          // Over code, keep clear of the code block's own copy and download
          // buttons in the same corner.
          framed || waiting ? "end-1" : "end-18"
        )}
      >
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
      {framed && current?.doc ? (
        <iframe
          ref={frameRef}
          title={t("title")}
          className="block w-full border-0 bg-transparent transition-[height] duration-150"
          style={{ height: expanded || !overflows ? height : 640 }}
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
          srcDoc={current.doc}
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
