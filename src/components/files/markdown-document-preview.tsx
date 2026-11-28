"use client"

import { useEffect, useMemo, useState } from "react"
import type { Nodes } from "mdast"
import remarkGfm from "remark-gfm"
import remarkParse from "remark-parse"
import { unified } from "unified"
import { Streamdown } from "streamdown"
import { readFileBase64 } from "@/lib/api"
import { normalizeMathDelimiters } from "@/components/ai-elements/message"
import { scrollportComponents } from "@/components/ai-elements/markdown-scrollport"
import { mermaidComponents } from "@/components/ai-elements/mermaid-block"
import { useStreamdownPlugins } from "@/components/ai-elements/streamdown-plugins"
import { BrowserLink } from "@/components/ui/browser-link"
import {
  isPrimaryModifier,
  useOpenUrlTarget,
} from "@/hooks/use-open-url-target"
import { isUncPath, normalizeAbsPath } from "@/lib/file-open-target"
import { cn } from "@/lib/utils"

/**
 * rehype-harden percent-encodes non-ASCII characters in URLs (a document in
 * `docs/04-方案设计/` references `架构图.svg`, but the rendered `src` is
 * `04-%E6%96%B9%E6%A1%88%E8%AE%BE%E8%AE%A1/.../%E6%9E%B6%E6%9E%84%E5%9B%BE.svg`).
 * The backend wants a real filesystem path, not a URL, so decode it — one
 * segment at a time. A segment that would decode into a separator (`%2F`,
 * `%5C`) stays encoded: decoding must never add path structure, or
 * "/%2Fhost/share/x.png" would turn into the network path "//host/share/x.png"
 * after the remote-URL guard has already passed it as local. A segment with a
 * malformed `%` sequence is left untouched rather than throwing.
 */
function decodeLocalPath(path: string): string {
  return path
    .split("/")
    .map((segment) => {
      try {
        const decoded = decodeURIComponent(segment)
        return /[/\\]/.test(decoded) ? segment : decoded
      } catch {
        return segment
      }
    })
    .join("/")
}

/**
 * One segment of a filesystem path, escaped for insertion into a Markdown /
 * HTML URL. Everything URL-significant is encoded — `%` (a directory literally
 * named "Design%20Notes" must not decode into "Design Notes"), spaces and
 * parentheses (they end a Markdown destination), quotes (they end a raw HTML
 * attribute), `#`/`?` (they start a fragment/query) — and `decodeLocalPath`
 * reverses it exactly.
 */
function encodePathSegment(segment: string): string {
  return encodeURIComponent(segment).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`
  )
}

/**
 * `relative` (already decoded, so a `#` or `?` in it is part of a file name)
 * under the absolute directory `base`. Not `${base}/…`: under the POSIX root
 * that reads `//…`, a network share.
 */
function joinUnder(base: string, relative: string): string {
  const prefix = base.endsWith("/") ? base : `${base}/`
  return normalizeAbsPath(prefix + relative.replace(/^\/+/, ""))
}

/**
 * Take the document's code — fenced and indented code blocks, inline code — out
 * of the path rewrites below, returning the masked text and the inverse. The
 * spans come from a real CommonMark parse (the parser family Streamdown renders
 * with), not a line scanner: only a parser knows where a fence inside a list
 * item or blockquote ends, that a `~~~` mentioned in prose or inside an HTML
 * comment opens nothing, and that a ```` fence wrapping a ``` example is one
 * block (same reasoning as `unescapeComposerText` in lib/composer-copy-text.ts).
 * GFM is on because Streamdown renders with it: without it an indented second
 * paragraph of a footnote reads as an indented code block.
 * On a parse failure nothing is masked — the pre-masking behavior.
 */
const documentParser = unified().use(remarkParse).use(remarkGfm)

function maskDocumentCode(content: string): {
  masked: string
  restore: (rewritten: string) => string
} {
  const ranges: Array<[number, number]> = []
  // The parser drops a leading byte-order mark before counting offsets.
  const shift = content.startsWith("\uFEFF") ? 1 : 0
  const walk = (node: Nodes) => {
    if (node.type === "code" || node.type === "inlineCode") {
      const start = node.position?.start.offset
      const end = node.position?.end.offset
      if (start !== undefined && end !== undefined) {
        ranges.push([start + shift, end + shift])
      }
      return
    }
    if ("children" in node) for (const child of node.children) walk(child)
  }
  try {
    walk(documentParser.parse(content))
  } catch {
    return { masked: content, restore: (rewritten) => rewritten }
  }
  ranges.sort((x, y) => x[0] - y[0])

  // NUL-delimited, so no rewrite below can produce or match a placeholder.
  const saved: string[] = []
  let masked = ""
  let cursor = 0
  for (const [start, end] of ranges) {
    if (start < cursor) continue
    masked += content.slice(cursor, start) + `\0MDCODE${saved.length}\0`
    saved.push(content.slice(start, end))
    cursor = end
  }
  masked += content.slice(cursor)
  return {
    masked,
    restore: (rewritten) =>
      rewritten.replace(
        /\0MDCODE(\d+)\0/g,
        (_m, i: string) => saved[Number(i)]
      ),
  }
}

/**
 * Pre-resolve local paths in markdown image/link syntax before Streamdown.
 *
 * rehype-harden resolves "../foo" via `new URL("../foo", "http://example.com")`
 * which loses directory context (e.g. "../images/a.png" from "docs/readme/"
 * becomes "/images/a.png" instead of "/docs/images/a.png").
 *
 * `fileDir` is the document's ABSOLUTE directory, so relative references
 * resolve to absolute filesystem paths. Author-written root-relative LINK
 * references ("/assets/x.png") resolve against `previewRoot` (the owning
 * workspace folder, or the document directory for files outside every
 * folder) so they also come out absolute — downstream consumers (image
 * loader, link opener) treat every local target as an absolute path.
 * The "./" prefix survives rehype-harden, which re-roots it to "/…".
 *
 * Image destinations with a leading "/" are deliberately left alone: in a
 * local document that is far more often a real absolute filesystem path
 * (a screenshot in /tmp, an asset in another workspace) than a project-root
 * ref. Re-rooting it against `previewRoot` silently produced a nonexistent
 * path such as "/repo/data/workspace/d.png" and a broken image. The image
 * loader tries the literal path first and falls back to the preview root.
 *
 * Fenced code blocks and inline code are masked first: their bytes are what
 * the author means to show (and what Copy Code hands out), not references.
 * The rewrites themselves are a source-level pass, not a Markdown parser:
 * code inside raw HTML (`<pre><code>`) and multi-line reference definitions
 * are not recognized, so those keep the pre-existing behavior (rewritten, or
 * for a protocol-relative destination, host-stripped by rehype-harden).
 *
 * Known limitation: documents living under a Windows UNC root
 * ("//server/share/…") lose the double-slash prefix in this pipeline (the
 * "./…" → rehype-harden → "/…" round trip cannot carry an authority), so
 * their relative sub-resources fail to load — a clean broken-image /
 * failed-open, never a read of a different local file. Editing, saving,
 * and watching UNC files are unaffected.
 */
function preprocessMarkdownPaths(
  content: string,
  fileDir: string,
  previewRoot: string | null
): string {
  // `base` is a filesystem path and `pathPart` is the author's URL text:
  // escape the former so the consumer's single decode restores both exactly.
  const resolveAgainst = (base: string, pathPart: string): string => {
    const parts = base.split("/").filter(Boolean).map(encodePathSegment)
    for (const seg of pathPart.split("/")) {
      if (seg === "..") {
        if (parts.length > 0) parts.pop()
      } else if (seg !== "." && seg !== "") {
        parts.push(seg)
      }
    }
    return parts.join("/")
  }

  const resolveUrl = (url: string, kind: "image" | "link"): string => {
    // Protocol-relative "//host/…" is a WEB address. Pin it to https here:
    // rehype-harden would otherwise strip the host and hand the renderer a
    // bare "/…", which the image loader and link opener take for a local path.
    if (url.startsWith("//")) return `https:${url}`
    // Skip remote URLs and anchors
    if (/^https?:\/\/|^data:|^blob:|^#/.test(url)) return url
    // Separate fragment/query from path
    const fragIdx = url.search(/[#?]/)
    const pathPart = fragIdx >= 0 ? url.slice(0, fragIdx) : url
    const fragment = fragIdx >= 0 ? url.slice(fragIdx) : ""
    if (pathPart.startsWith("/")) {
      // A leading slash is ambiguous in a local document: it can be a real
      // absolute filesystem path or a project-root-relative ref. Keep images
      // as-is (the loader tries the literal path, then the preview root); only
      // links keep the historical project-root interpretation.
      if (kind === "image") return url
      if (!previewRoot) return url
      return "./" + resolveAgainst(previewRoot, pathPart) + fragment
    }
    // Relative to the document's own (absolute) directory.
    return "./" + resolveAgainst(fileDir, pathPart) + fragment
  }

  const { masked, restore } = maskDocumentCode(content)

  // Pre-resolve image paths: ![alt](url) or ![alt](url "title")
  let result = masked.replace(
    /!\[([^\]]*)\]\(([^)\s"']+)([^)]*)\)/g,
    (match, alt, url, rest) => {
      const resolved = resolveUrl(url, "image")
      if (resolved === url) return match
      return `![${alt}](${resolved}${rest})`
    }
  )

  // Pre-resolve image-wrapped link paths: [![alt](img)](url)
  result = result.replace(
    /\[(!\[[^\]]*\]\([^)]*\))\]\(([^)\s"']+)([^)]*)\)/g,
    (match, imgPart, url, rest) => {
      const resolved = resolveUrl(url, "link")
      if (resolved === url) return match
      return `[${imgPart}](${resolved}${rest})`
    }
  )

  // Pre-resolve link paths: [text](url) — negative lookbehind to skip images
  result = result.replace(
    /(?<!!)\[([^\]]*)\]\(([^)\s"']+)([^)]*)\)/g,
    (match, text, url, rest) => {
      const resolved = resolveUrl(url, "link")
      if (resolved === url) return match
      return `[${text}](${resolved}${rest})`
    }
  )

  // Reference definitions: [id]: url — used by images and links alike, so
  // only the kind-independent rewrite applies (protocol-relative → https).
  result = result.replace(
    /^( {0,3}\[[^\]]+\]:[ \t]*<?)(\/\/[^\s>]+)/gm,
    (_match, head, url) => `${head}https:${url}`
  )

  // Pre-resolve HTML <a href="..."> and <img src="..."> tags. The attribute
  // name must start after whitespace, so `data-src` / `data-href` are skipped.
  result = result.replace(
    /<(a\s(?:[^>]*?\s)?href|img\s(?:[^>]*?\s)?src)(\s*=\s*)(["'])([^"']+)\3/gi,
    (match, prefix, eq, quote, url) => {
      const resolved = resolveUrl(url, /^img/i.test(prefix) ? "image" : "link")
      if (resolved === url) return match
      return `<${prefix}${eq}${quote}${resolved}${quote}`
    }
  )

  return restore(result)
}

const MIME_BY_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  svg: "image/svg+xml",
  webp: "image/webp",
  bmp: "image/bmp",
  ico: "image/x-icon",
  avif: "image/avif",
}

function useLocalImageSrc(
  src: string | undefined,
  baseDir: string | null,
  previewRoot: string | null,
  enabled: boolean
): string | undefined {
  const [dataUrl, setDataUrl] = useState<string | undefined>(undefined)

  // Protocol-relative "//host/…" srcs are REMOTE (the browser resolves them
  // against the page protocol) — never route them into local file IO, where
  // "//Users/…" would otherwise read an unintended local path.
  const isLocal =
    enabled && src && !/^https?:\/\/|^data:|^blob:|^\/\//.test(src)

  useEffect(() => {
    if (!isLocal || !src) return
    let cancelled = false
    const cleaned = decodeLocalPath(src.replace(/[#?].*$/, ""))

    // preprocessMarkdownPaths resolves relative references against `baseDir`
    // and rehype-harden re-roots "./x" to "/x", so a "/"-prefixed src is
    // normally already the absolute filesystem path. It can ALSO be a
    // project-root-relative ref ("/assets/x.png"): try the literal path
    // first, then the owning folder root as a fallback.
    const candidates: string[] = []
    if (cleaned.startsWith("/")) {
      const absolute = normalizeAbsPath(cleaned)
      candidates.push(absolute)
      // A drive-letter path is already fully qualified; only a "/"-rooted one
      // can also mean "from the project root".
      if (previewRoot && !/^[a-zA-Z]:\//.test(absolute)) {
        const prefix = previewRoot.endsWith("/")
          ? previewRoot
          : `${previewRoot}/`
        if (!absolute.startsWith(prefix)) {
          candidates.push(joinUnder(previewRoot, absolute))
        }
      }
    } else if (baseDir) {
      candidates.push(joinUnder(baseDir, cleaned))
    }

    const ext = (candidates[0] ?? cleaned).split(".").pop()?.toLowerCase() ?? ""
    const mime = MIME_BY_EXT[ext] ?? "image/png"

    void (async () => {
      let lastError: unknown = null
      for (const candidate of candidates) {
        // Unmounted or src changed: don't keep issuing reads for a stale ref.
        if (cancelled) return
        try {
          const b64 = await readFileBase64(candidate)
          if (!cancelled) setDataUrl(`data:${mime};base64,${b64}`)
          return
        } catch (err) {
          // Try the next interpretation of this destination.
          lastError = err
        }
      }
      if (!cancelled) {
        console.error(
          `[PreviewImage] readFileBase64 failed for "${cleaned}" (tried ${candidates.join(", ") || "nothing"}):`,
          typeof lastError === "object" ? JSON.stringify(lastError) : lastError
        )
      }
    })()
    return () => {
      cancelled = true
    }
  }, [isLocal, src, baseDir, previewRoot])

  if (!isLocal) return src
  return dataUrl
}

function PreviewImage({
  baseDir,
  previewRoot,
  enabled,
  ...props
}: React.ComponentProps<"img"> & {
  baseDir: string | null
  previewRoot: string | null
  enabled: boolean
}) {
  const src = typeof props.src === "string" ? props.src : undefined
  const resolvedSrc = useLocalImageSrc(src, baseDir, previewRoot, enabled)

  // eslint-disable-next-line @next/next/no-img-element, jsx-a11y/alt-text
  return <img {...props} src={resolvedSrc} />
}

/**
 * Markdown document preview — the rendered view of a `.md` file on disk.
 *
 * Lives in its own module (rather than inside `file-workspace-panel.tsx`,
 * where it started) because there are now TWO surfaces that render a markdown
 * document: the workspace file column and the transcript's file viewer drawer
 * (`file-viewer-drawer.tsx`, used when the file column is covered by a
 * full-page route). Both must resolve local images and links identically, so
 * the whole pipeline — UNC gating, path pre-resolution, math delimiters — is
 * folded IN here and driven by the document's own location. Callers hand over
 * the raw file content and where it lives, nothing more.
 *
 * Extracting it also keeps the heavy Streamdown plugins (shiki / katex /
 * mermaid) lazy: `useStreamdownPlugins` is called here, so the engines load
 * only when a document is actually being previewed.
 */
export function MarkdownDocumentPreview({
  content,
  /** The document's own ABSOLUTE directory, or null when unknown. */
  fileDir,
  /** Root for author-written root-relative refs ("/assets/x.png") — the
   *  owning workspace folder, else the document's directory. */
  previewRoot,
  openFilePreview,
  className,
}: {
  content: string
  fileDir: string | null
  previewRoot: string | null
  openFilePreview: (path: string) => void
  className?: string
}) {
  // A UNC-hosted document (//server/share/…) cannot have its local
  // sub-resources resolved: the "./x" → rehype-harden → "/x" round trip
  // drops the //server/share authority, and a collapsed single-slash
  // path like "/Windows/win.ini" would read a DIFFERENT local file. So
  // for UNC docs we disable local resolution entirely — relative refs
  // stay relative (harden externalizes them harmlessly) and the image
  // loader / link opener treat nothing as a local path.
  const localRefsEnabled = !fileDir || !isUncPath(fileDir)
  // A document whose own directory is unknown still has a preview root (the
  // owning registered folder). Resolve against that instead of handing the
  // browser a raw relative <img src>: the server has no media route, so such
  // a request falls through to the SPA and returns HTML, not the image.
  const baseDir = localRefsEnabled ? (fileDir ?? previewRoot) : null
  const effectivePreviewRoot = localRefsEnabled ? previewRoot : null
  // Pre-resolve relative AND root-relative paths before Streamdown /
  // rehype-harden mangles them: relative ones against the document's own
  // directory, root-relative LINK ones ("/assets/x.png") against the preview
  // root (owning folder when inside the workspace, else the directory).
  // Deliberately NOT `escapeWindowsPathSeparators` (see
  // ai-elements/windows-path-escape.ts): this renders a real Markdown
  // DOCUMENT, where `\.` → `.` is correct CommonMark and the author's escapes
  // are theirs to keep. That transform is for agent-authored chat text only.
  // Memoized: the pass parses the document once to find its code spans.
  const preprocessed = useMemo(
    () =>
      normalizeMathDelimiters(
        localRefsEnabled
          ? preprocessMarkdownPaths(content, baseDir ?? "", previewRoot)
          : content
      ),
    [content, baseDir, previewRoot, localRefsEnabled]
  )
  const plugins = useStreamdownPlugins(preprocessed)
  // Web links go through the app's link decision like every other click on
  // an address (the built-in browser, the system browser, or — in a browser
  // — a dev server on the codeg host through the port bridge), under the
  // editor's preference.
  const openUrlTarget = useOpenUrlTarget()

  return (
    <div
      className={cn(
        "h-full overflow-auto p-6 [&_a_img]:inline [&_ol]:list-decimal [&_ul]:list-disc [&_ol]:pl-6 [&_ul]:pl-6",
        className
      )}
    >
      <Streamdown
        plugins={plugins}
        mode="static"
        parseIncompleteMarkdown={false}
        components={{
          ...mermaidComponents,
          ...scrollportComponents,
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          img: ({ node, ...imgProps }) => (
            <PreviewImage
              {...imgProps}
              enabled={localRefsEnabled}
              baseDir={baseDir}
              previewRoot={effectivePreviewRoot}
            />
          ),
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          a: ({ node, href, children, ...aProps }) => {
            // Protocol-relative "//host/…" is a WEB url — exclude it
            // from the local branch (^\/\/) so it opens externally
            // instead of being collapsed into a local file path.
            // localRefsEnabled is false for UNC docs: never route a
            // (possibly wrongly-collapsed) local target to the opener.
            const isRelative =
              href && !/^[a-z][a-z0-9+.-]*:|^#|^\/\//i.test(href)
            if (isRelative && href && localRefsEnabled) {
              return (
                <a
                  {...aProps}
                  href="#"
                  onClick={(e) => {
                    e.preventDefault()
                    // After preprocessing (absolute document dir) +
                    // rehype-harden, local hrefs ARE absolute
                    // filesystem paths like "/repo/docs/foo.md" —
                    // open directly; no folder involved.
                    const target = decodeLocalPath(
                      href.replace(/[#?].*$/, "")
                    ).replace(/\/\/+/g, "/")
                    void openFilePreview(target)
                  }}
                >
                  {children}
                </a>
              )
            }
            // Pin protocol-relative urls to https: the webview's own
            // scheme (tauri://) would otherwise hijack them.
            const external = href?.startsWith("//") ? `https:${href}` : href
            return external ? (
              <BrowserLink
                {...aProps}
                href={external}
                onClick={(e) => {
                  e.preventDefault()
                  openUrlTarget(external, {
                    source: "editor",
                    modifier: isPrimaryModifier(e),
                  })
                }}
                // A middle click would otherwise take the native path (a
                // background tab on the raw address, past the site rules);
                // it opens "the other way", like a modified click.
                onAuxClick={(e) => {
                  if (e.button !== 1) return
                  e.preventDefault()
                  openUrlTarget(external, { source: "editor", modifier: true })
                }}
              >
                {children}
              </BrowserLink>
            ) : (
              // `[text]()` — nothing to open, so keep the text and drop
              // the link rather than render a dead one.
              <a {...aProps}>{children}</a>
            )
          },
        }}
      >
        {preprocessed}
      </Streamdown>
    </div>
  )
}
