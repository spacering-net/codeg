"use client"

import { useEffect, useState } from "react"
import { Streamdown } from "streamdown"
import { readFileBase64 } from "@/lib/api"
import { normalizeMathDelimiters } from "@/components/ai-elements/message"
import { mermaidComponents } from "@/components/ai-elements/mermaid-block"
import { useStreamdownPlugins } from "@/components/ai-elements/streamdown-plugins"
import { BrowserLink } from "@/components/ui/browser-link"
import {
  isPrimaryModifier,
  useOpenUrlTarget,
} from "@/hooks/use-open-url-target"
import { isUncPath, normalizeAbsPath } from "@/lib/file-open-target"
import { cn } from "@/lib/utils"

function resolveRelativePath(base: string, relative: string): string {
  // Strip URL fragment (e.g. #gh-light-mode-only) and query string
  const cleaned = relative.replace(/[#?].*$/, "")
  // Preserve leading "/" for absolute paths, filter empty segments
  const isAbsolute = base.startsWith("/")
  const parts = base.split("/").filter(Boolean)
  for (const seg of cleaned.split("/")) {
    if (seg === "..") {
      if (parts.length > 0) parts.pop()
    } else if (seg !== "." && seg !== "") {
      parts.push(seg)
    }
  }
  return (isAbsolute ? "/" : "") + parts.join("/")
}

/**
 * Pre-resolve local paths in markdown image/link syntax before Streamdown.
 *
 * rehype-harden resolves "../foo" via `new URL("../foo", "http://example.com")`
 * which loses directory context (e.g. "../images/a.png" from "docs/readme/"
 * becomes "/images/a.png" instead of "/docs/images/a.png").
 *
 * `fileDir` is the document's ABSOLUTE directory, so relative references
 * resolve to absolute filesystem paths. Author-written root-relative
 * references ("/assets/x.png") resolve against `previewRoot` (the owning
 * workspace folder, or the document directory for files outside every
 * folder) so they also come out absolute — downstream consumers (image
 * loader, link opener) treat every local target as an absolute path.
 * The "./" prefix survives rehype-harden, which re-roots it to "/…".
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
  const resolveAgainst = (base: string, pathPart: string): string => {
    const parts = base.split("/").filter(Boolean)
    for (const seg of pathPart.split("/")) {
      if (seg === "..") {
        if (parts.length > 0) parts.pop()
      } else if (seg !== "." && seg !== "") {
        parts.push(seg)
      }
    }
    return parts.join("/")
  }

  const resolveUrl = (url: string): string => {
    // Skip remote URLs, protocol-relative URLs, and anchors
    if (/^https?:\/\/|^data:|^blob:|^#|^\/\//.test(url)) return url
    // Separate fragment/query from path
    const fragIdx = url.search(/[#?]/)
    const pathPart = fragIdx >= 0 ? url.slice(0, fragIdx) : url
    const fragment = fragIdx >= 0 ? url.slice(fragIdx) : ""
    if (pathPart.startsWith("/")) {
      // Root-relative: the author means "from the project root".
      if (!previewRoot) return url
      return "./" + resolveAgainst(previewRoot, pathPart) + fragment
    }
    // Relative to the document's own (absolute) directory.
    return "./" + resolveAgainst(fileDir, pathPart) + fragment
  }

  // Pre-resolve image paths: ![alt](url) or ![alt](url "title")
  let result = content.replace(
    /!\[([^\]]*)\]\(([^)\s"']+)([^)]*)\)/g,
    (match, alt, url, rest) => {
      const resolved = resolveUrl(url)
      if (resolved === url) return match
      return `![${alt}](${resolved}${rest})`
    }
  )

  // Pre-resolve image-wrapped link paths: [![alt](img)](url)
  result = result.replace(
    /\[(!\[[^\]]*\]\([^)]*\))\]\(([^)\s"']+)([^)]*)\)/g,
    (match, imgPart, url, rest) => {
      const resolved = resolveUrl(url)
      if (resolved === url) return match
      return `[${imgPart}](${resolved}${rest})`
    }
  )

  // Pre-resolve link paths: [text](url) — negative lookbehind to skip images
  result = result.replace(
    /(?<!!)\[([^\]]*)\]\(([^)\s"']+)([^)]*)\)/g,
    (match, text, url, rest) => {
      const resolved = resolveUrl(url)
      if (resolved === url) return match
      return `[${text}](${resolved}${rest})`
    }
  )

  // Pre-resolve HTML <a href="..."> and <img src="..."> tags
  result = result.replace(
    /<(a\s[^>]*?href|img\s[^>]*?src)=(["'])([^"']+)\2/gi,
    (match, prefix, quote, url) => {
      const resolved = resolveUrl(url)
      if (resolved === url) return match
      return `<${prefix}=${quote}${resolved}${quote}`
    }
  )

  return result
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
}

function useLocalImageSrc(
  src: string | undefined,
  fileDir: string | null
): string | undefined {
  const [dataUrl, setDataUrl] = useState<string | undefined>(undefined)

  // Protocol-relative "//host/…" srcs are REMOTE (the browser resolves them
  // against the page protocol) — never route them into local file IO, where
  // "//Users/…" would otherwise read an unintended local path.
  const isLocal =
    src && fileDir && !/^https?:\/\/|^data:|^blob:|^\/\//.test(src)

  useEffect(() => {
    if (!isLocal || !src || !fileDir) return
    let cancelled = false
    // preprocessMarkdownPaths resolved every local reference against the
    // document's ABSOLUTE directory (or the preview root), and
    // rehype-harden re-roots "./x" to "/x" — so a "/"-prefixed src already
    // IS the absolute filesystem path. Anything else (raw HTML that
    // slipped past preprocessing) resolves against the document directory.
    const absPath = src.startsWith("/")
      ? normalizeAbsPath(src.replace(/[#?].*$/, ""))
      : resolveRelativePath(fileDir, src)
    const ext = absPath.split(".").pop()?.toLowerCase() ?? ""
    const mime = MIME_BY_EXT[ext] ?? "image/png"

    readFileBase64(absPath)
      .then((b64) => {
        if (!cancelled) {
          setDataUrl(`data:${mime};base64,${b64}`)
        }
      })
      .catch((err) => {
        console.error(
          `[PreviewImage] readFileBase64 failed for "${absPath}":`,
          typeof err === "object" ? JSON.stringify(err) : err
        )
      })
    return () => {
      cancelled = true
    }
  }, [isLocal, src, fileDir])

  if (!isLocal) return src
  return dataUrl
}

function PreviewImage({
  fileDir,
  ...props
}: React.ComponentProps<"img"> & {
  fileDir: string | null
}) {
  const src = typeof props.src === "string" ? props.src : undefined
  const resolvedSrc = useLocalImageSrc(src, fileDir)

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
  // Pre-resolve relative AND root-relative paths before Streamdown /
  // rehype-harden mangles them: relative ones against the document's own
  // directory, root-relative ones ("/assets/x.png") against the preview
  // root (owning folder when inside the workspace, else the directory).
  // Deliberately NOT `escapeWindowsPathSeparators` (see
  // ai-elements/windows-path-escape.ts): this renders a real Markdown
  // DOCUMENT, where `\.` → `.` is correct CommonMark and the author's escapes
  // are theirs to keep. That transform is for agent-authored chat text only.
  const preprocessed = normalizeMathDelimiters(
    localRefsEnabled
      ? preprocessMarkdownPaths(content, fileDir ?? "", previewRoot)
      : content
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
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          img: ({ node, ...imgProps }) => (
            <PreviewImage
              {...imgProps}
              fileDir={localRefsEnabled ? fileDir : null}
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
                    const target = href
                      .replace(/[#?].*$/, "")
                      .replace(/\/\/+/g, "/")
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
