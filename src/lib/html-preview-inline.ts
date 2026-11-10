// HTML preview resource inlining + sandbox CSP.
//
// Turns an HTML document into a self-contained string that can be rendered in a
// sandboxed `<iframe srcDoc>`. Relative, in-workspace sub-resources (images,
// stylesheets, scripts, fonts, media) are read through the injected
// `readFileBase64` reader and rewritten to `data:` URIs, mirroring how the
// markdown preview inlines relative images. External references
// (http/https/data/blob/...) are left untouched, and any reference that
// resolves OUTSIDE the workspace root is skipped. The reader the preview injects
// is the workspace-confined `read_workspace_file_base64` backend command, which
// canonicalizes each path (resolving symlinks) and refuses to read outside the
// root — that server-side check is the authoritative boundary; the lexical
// check here is a fast pre-filter and defense-in-depth.
//
// Parsing is done with a `<template>` element on purpose: a DOMParser-created
// document "can download resources specified in <iframe> and <img> elements"
// (per MDN) during parsing — before our CSP/sandbox exists and from the app's
// privileged origin. `<template>` content is owned by an inert document with no
// browsing context, so nothing is fetched while we rewrite it (the same
// technique DOMPurify uses).
//
// Security model: the returned HTML carries no privileges of its own. It is
// meant to be rendered with an opaque-origin sandbox (NO `allow-same-origin`)
// plus the CSP from `withSandboxCsp`. In the default (untrusted) mode the
// iframe is rendered WITHOUT `allow-scripts`, so no JavaScript runs at all.
// Enabling scripts is an explicit, per-file user opt-in (see HtmlPreview).

export type Base64Reader = (absPath: string) => Promise<string>

export interface InlineOptions {
  /** 聊天静态片段：移除作者脚本、事件、嵌入和跳转入口，不影响文件预览默认行为。 */
  stripActiveContent?: boolean
  /** Absolute directory of the HTML file (resolves "./" and "../" refs). */
  fileDir: string
  /** Absolute workspace root — refs resolving outside it are skipped. */
  folderPath: string
  /** Reads a file at an absolute path and returns its base64 contents. */
  readFileBase64: Base64Reader
  /**
   * Aggregate budget (in base64 chars) for inlined resources. A DoS guard
   * against hostile documents that reference huge or heavily-repeated assets —
   * once exceeded, further resources are left as-is rather than embedded. Not
   * an operational throughput limit; callers may raise or lower it.
   */
  maxInlineBytes?: number
  /** Max concurrent resource reads. Defaults to scale with CPU cores. */
  concurrency?: number
}

const DEFAULT_MAX_INLINE_BYTES = 64 * 1024 * 1024

function defaultConcurrency(): number {
  const cores =
    typeof navigator !== "undefined" ? navigator.hardwareConcurrency : 0
  return Math.max(4, cores || 8)
}

const BINARY_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  svg: "image/svg+xml",
  webp: "image/webp",
  avif: "image/avif",
  bmp: "image/bmp",
  ico: "image/x-icon",
  woff2: "font/woff2",
  woff: "font/woff",
  ttf: "font/ttf",
  otf: "font/otf",
  eot: "application/vnd.ms-fontobject",
  mp4: "video/mp4",
  webm: "video/webm",
  ogv: "video/ogg",
  mp3: "audio/mpeg",
  oga: "audio/ogg",
  ogg: "audio/ogg",
  wav: "audio/wav",
  m4a: "audio/mp4",
}

function normSlashes(s: string): string {
  return s.replace(/\\/g, "/")
}

// Elements the HTML parser keeps in <head> (metadata content). Used to split a
// flattened document back into head/body at the first non-metadata node.
const METADATA_TAGS = new Set([
  "BASE",
  "BASEFONT",
  "BGSOUND",
  "LINK",
  "META",
  "NOSCRIPT",
  "SCRIPT",
  "STYLE",
  "TEMPLATE",
  "TITLE",
])

// Elements whose content is raw text / RCDATA: a "<tag>" inside them is text,
// not markup, so the scanner skips their content when looking for real tags.
const TEXT_CONTENT_TAGS = new Set([
  "script",
  "style",
  "title",
  "textarea",
  "xmp",
  "iframe",
  "noembed",
  "noframes",
])

// Walk the *real* HTML start tags of `src`, invoking `visit(name, attrs,
// gtIndex, ltIndex)` for each. Skips comments, doctype/PIs, closing tags, and
// the raw text of RCDATA/RAWTEXT elements (script/style/title/textarea/…), and
// honors quoted attribute values — so a "<tag …>" inside a comment, a
// script/title string, or another tag's quoted attribute is never mistaken for
// a real tag. `visit` may return true to stop.
function scanStartTags(
  src: string,
  visit: (
    name: string,
    attrs: string,
    gtIndex: number,
    ltIndex: number
  ) => boolean | void
): void {
  const n = src.length
  let i = 0
  // Suppress wrapper detection inside <template> subtrees: their content is a
  // separate fragment, so an <html>/<head>/<body> there is not a document
  // wrapper. Tracked as depth in the main (token-aware) loop so comments,
  // quoted attrs, and raw text inside the template can't end it early.
  let templateDepth = 0
  while (i < n) {
    const lt = src.indexOf("<", i)
    if (lt === -1) break
    if (src.startsWith("<!--", lt)) {
      const end = src.indexOf("-->", lt + 4)
      i = end === -1 ? n : end + 3
      continue
    }
    const next = src[lt + 1]
    if (next === "!" || next === "?") {
      const end = src.indexOf(">", lt + 1)
      i = end === -1 ? n : end + 1
      continue
    }
    if (next === "/") {
      // Closing tag — track </template> nesting; otherwise just skip it.
      const cm = /^\/([a-zA-Z][a-zA-Z0-9:-]*)/.exec(src.slice(lt + 1))
      if (cm && cm[1].toLowerCase() === "template" && templateDepth > 0) {
        templateDepth--
      }
      const end = src.indexOf(">", lt + 1)
      i = end === -1 ? n : end + 1
      continue
    }
    const nameMatch = /^[a-zA-Z][a-zA-Z0-9:-]*/.exec(src.slice(lt + 1))
    if (!nameMatch) {
      i = lt + 1
      continue
    }
    const name = nameMatch[0].toLowerCase()
    const attrsStart = lt + 1 + nameMatch[0].length
    // Walk to the tag's closing ">", skipping ">" inside quoted attr values.
    let j = attrsStart
    let quote = ""
    while (j < n) {
      const c = src[j]
      if (quote) {
        if (c === quote) quote = ""
      } else if (c === '"' || c === "'") {
        quote = c
      } else if (c === ">") {
        break
      }
      j++
    }
    if (templateDepth === 0 && visit(name, src.slice(attrsStart, j), j, lt)) {
      return
    }
    if (name === "template") {
      templateDepth++
      i = j + 1
      continue
    }
    if (TEXT_CONTENT_TAGS.has(name)) {
      // Skip element raw text up to a *valid* end tag: "</name" must be followed
      // by whitespace, "/", or ">" ("</scriptx>" is not one) so markup-looking
      // text inside script/title/textarea/… isn't seen as real tags.
      const close = new RegExp(`</${name}(?=[\\s/>])`, "i").exec(src.slice(j))
      i = close ? j + close.index : n
      continue
    }
    i = j + 1
  }
}

// Attribute text of the first *real* <html>/<head>/<body> start tag.
// `<template>` parsing flattens these wrappers and loses their attributes
// (class/lang/dir/style/data-*), which we re-apply on the rewrapped output so
// CSS like `body.preview { … }` keeps matching.
function extractWrapperAttrs(src: string): Record<string, string> {
  const result: Record<string, string> = { html: "", head: "", body: "" }
  const seen: Record<string, boolean> = {}
  scanStartTags(src, (name, attrs) => {
    if (
      (name === "html" || name === "head" || name === "body") &&
      !seen[name]
    ) {
      seen[name] = true
      result[name] = attrs.replace(/\/\s*$/, "").trimEnd()
    }
    return Boolean(seen.body)
  })
  return result
}

// The first *real* `<want …>` start tag: its "<" index and the index just past
// its ">". Quote/comment/raw-text aware (via scanStartTags), so a "<want" inside
// an attribute value, comment, or RCDATA text is never mistaken for it.
function findRealStartTag(
  src: string,
  want: string
): { lt: number; gtEnd: number } | null {
  let found: { lt: number; gtEnd: number } | null = null
  scanStartTags(src, (name, _attrs, gtIndex, ltIndex) => {
    if (name === want && gtIndex < src.length) {
      found = { lt: ltIndex, gtEnd: gtIndex + 1 }
      return true
    }
    return false
  })
  return found
}

function realStartTagEnd(src: string, want: string): number | null {
  return findRealStartTag(src, want)?.gtEnd ?? null
}

// Decode HTML character references in a short text run (e.g. a <title>). Uses a
// detached <textarea>, whose content model is escapable raw text: it decodes
// entities without creating child elements or fetching any resource.
function decodeHtmlEntities(text: string): string {
  if (!text.includes("&") || typeof document === "undefined") return text
  const el = document.createElement("textarea")
  el.innerHTML = text
  return el.value
}

/**
 * The document's `<title>` text, or "" if absent. Located with the same
 * quote/comment/raw-text-aware scanner as the wrappers, so a "<title>" inside a
 * comment, script string, or `<template>` is ignored; the title's RCDATA
 * content is read verbatim up to its `</title>` and its entities decoded, with
 * whitespace collapsed the way a browser renders a title. Safe on untrusted
 * HTML — it neither parses with DOMParser nor loads any resource.
 */
export function extractHtmlTitle(html: string): string {
  let title = ""
  scanStartTags(html, (name, _attrs, gtIndex) => {
    if (name !== "title") return false
    const rest = html.slice(gtIndex + 1)
    const close = /<\/title(?=[\s/>])/i.exec(rest)
    const raw = close ? rest.slice(0, close.index) : rest
    title = decodeHtmlEntities(raw).replace(/\s+/g, " ").trim()
    return true
  })
  return title
}

function extOf(path: string): string {
  const clean = path.split(/[?#]/)[0]
  const dot = clean.lastIndexOf(".")
  return dot === -1 ? "" : clean.slice(dot + 1).toLowerCase()
}

function dirOf(absPath: string): string {
  const i = absPath.lastIndexOf("/")
  return i === -1 ? absPath : absPath.slice(0, i)
}

// A reference we must not rewrite: anything carrying a URI scheme (http:,
// https:, data:, blob:, mailto:, tel:, ...), protocol-relative ("//host"), or
// a bare fragment ("#id").
function isExternalRef(url: string): boolean {
  return (
    /^[a-z][a-z0-9+.-]*:/i.test(url) ||
    url.startsWith("//") ||
    url.startsWith("#")
  )
}

// Resolve `relative` against `base`, honoring "." and "..". Backslashes are
// normalized to "/" first so Windows-style "..\\..\\x" traversal cannot slip
// through as a single opaque segment. Mirrors resolveRelativePath in
// file-workspace-panel.tsx.
//
// Known limitation (shared with the markdown preview pipeline): a UNC base
// ("//server/share/…") collapses to a single-slash form here, so sub-
// resources of UNC-hosted documents fail to inline — a clean, root-confined
// load failure, never a read of a different file.
export function resolveAbsPath(base: string, relative: string): string {
  const cleaned = normSlashes(relative).replace(/[#?].*$/, "")
  const normBase = normSlashes(base)
  const isAbsolute = normBase.startsWith("/")
  const parts = normBase.split("/").filter(Boolean)
  for (const seg of cleaned.split("/")) {
    if (seg === "..") {
      if (parts.length > 0) parts.pop()
    } else if (seg !== "." && seg !== "") {
      parts.push(seg)
    }
  }
  return (isAbsolute ? "/" : "") + parts.join("/")
}

function isWithinRoot(absPath: string, root: string): boolean {
  if (!root) return false
  const a = normSlashes(absPath)
  const r0 = normSlashes(root)
  const r = r0.endsWith("/") ? r0.slice(0, -1) : r0
  return a === r || a.startsWith(r + "/")
}

// Resolve a *local* reference to an absolute path, but only if it stays inside
// the workspace root. Returns null for external refs and for anything that
// escapes the root (via "..", an absolute path, a "\" segment, etc.).
function resolveWithinRoot(
  url: string,
  baseDir: string,
  folderPath: string
): string | null {
  const u = normSlashes(url)
  if (isExternalRef(u)) return null
  const abs = u.startsWith("/")
    ? resolveAbsPath(folderPath, u)
    : resolveAbsPath(baseDir, u)
  return isWithinRoot(abs, folderPath) ? abs : null
}

function base64ToText(b64: string): string {
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
  return new TextDecoder("utf-8").decode(bytes)
}

interface InlineContext {
  read: Base64Reader
  folderPath: string
  budget: number
  // base64 chars actually embedded into the output (bounds document size)
  embedded: number
  // base64 chars read from distinct resources (bounds total backend I/O)
  bytesRead: number
  // paths already charged to bytesRead, so cached re-reads aren't double-counted
  readSeen: Set<string>
  // bounds concurrent backend reads across BOTH top-level jobs and nested
  // fan-out (srcset / CSS url()/@import) so the read budget is actually honored
  gate: ReadGate
}

// Bounds how many resource reads run concurrently. Shared by every read path so
// nested Promise.all fan-out cannot stampede past the read budget.
class ReadGate {
  private active = 0
  private waiters: Array<() => void> = []
  constructor(private readonly max: number) {}
  async run<T>(task: () => Promise<T>): Promise<T> {
    while (this.active >= this.max) {
      await new Promise<void>((resolve) => this.waiters.push(resolve))
    }
    this.active++
    try {
      return await task()
    } finally {
      this.active--
      this.waiters.shift()?.()
    }
  }
}

// Read a resource (base64), bounding total *distinct* read volume by the budget
// so a hostile file referencing many oversized resources cannot drive unbounded
// backend reads. The budget check runs INSIDE the shared gate, so concurrent
// fan-out cannot all clear the check before any read charges `bytesRead`.
// Returns null once the read budget is spent or on failure; cached re-reads
// (same path) are charged only once.
async function acquireBase64(
  ctx: InlineContext,
  absPath: string
): Promise<string | null> {
  return ctx.gate.run(async () => {
    if (ctx.bytesRead >= ctx.budget) return null
    let b64: string
    try {
      b64 = await ctx.read(absPath)
    } catch {
      return null
    }
    if (!ctx.readSeen.has(absPath)) {
      ctx.readSeen.add(absPath)
      ctx.bytesRead += b64.length
    }
    return b64
  })
}

// Read a resource as a `data:` URI. Embeds it only if it fits the remaining
// output budget, so total embedded bytes never exceed the budget even when a
// single resource is referenced many times.
async function readDataUri(
  ctx: InlineContext,
  absPath: string
): Promise<string | null> {
  const b64 = await acquireBase64(ctx, absPath)
  if (b64 == null || ctx.embedded + b64.length > ctx.budget) return null
  ctx.embedded += b64.length
  const mime = BINARY_MIME[extOf(absPath)] ?? "application/octet-stream"
  return `data:${mime};base64,${b64}`
}

// Read a resource as decoded text (for CSS/JS), under the same budgets.
async function readResourceText(
  ctx: InlineContext,
  absPath: string
): Promise<string | null> {
  const b64 = await acquireBase64(ctx, absPath)
  if (b64 == null || ctx.embedded + b64.length > ctx.budget) return null
  ctx.embedded += b64.length
  return base64ToText(b64)
}

// Dedups reads by absolute path: a logo referenced 100 times is read once.
function memoizeReader(read: Base64Reader): Base64Reader {
  const cache = new Map<string, Promise<string>>()
  return (absPath) => {
    let pending = cache.get(absPath)
    if (!pending) {
      pending = read(absPath)
      cache.set(absPath, pending)
    }
    return pending
  }
}

async function replaceAsync(
  input: string,
  regex: RegExp,
  replacer: (match: RegExpMatchArray) => Promise<string>
): Promise<string> {
  const matches = [...input.matchAll(regex)]
  if (matches.length === 0) return input
  const parts = await Promise.all(matches.map((m) => replacer(m)))
  let result = ""
  let last = 0
  matches.forEach((m, i) => {
    const idx = m.index ?? 0
    result += input.slice(last, idx) + parts[i]
    last = idx + m[0].length
  })
  return result + input.slice(last)
}

// Inline relative `url(...)` and `@import` references inside a CSS string.
// `seen` guards against @import cycles (terminates on any revisited file).
async function inlineCss(
  css: string,
  cssDir: string,
  ctx: InlineContext,
  seen: Set<string>
): Promise<string> {
  // 1) @import — pull the referenced stylesheet inline, recursively.
  let out = await replaceAsync(css, /@import\s+([^;]+);/gi, async (m) => {
    const ref = m[1].match(/url\(\s*["']?([^"')]+)["']?\s*\)|["']([^"']+)["']/i)
    const url = ref ? (ref[1] ?? ref[2]) : undefined
    if (!url) return m[0]
    const abs = resolveWithinRoot(url, cssDir, ctx.folderPath)
    if (!abs || seen.has(abs)) return abs ? "" : m[0]
    seen.add(abs)
    const text = await readResourceText(ctx, abs)
    if (text == null) return ""
    return inlineCss(text, dirOf(abs), ctx, seen)
  })

  // 2) url(...) — fonts, background images, etc.
  out = await replaceAsync(
    out,
    /url\(\s*["']?([^"')]+)["']?\s*\)/gi,
    async (m) => {
      const abs = resolveWithinRoot(m[1], cssDir, ctx.folderPath)
      if (!abs) return m[0]
      const dataUri = await readDataUri(ctx, abs)
      return dataUri ? `url("${dataUri}")` : m[0]
    }
  )

  return out
}

// Parse a `srcset` attribute into (url, descriptor) candidates. A URL is a run
// of non-whitespace characters, so commas inside `data:` URLs do not split
// candidates (unlike a naive `split(",")`). Loosely follows the WHATWG
// "parse a srcset attribute" algorithm.
function parseSrcset(input: string): { url: string; descriptor: string }[] {
  const out: { url: string; descriptor: string }[] = []
  const n = input.length
  const isWs = (c: string) => /\s/.test(c)
  let i = 0
  while (i < n) {
    while (i < n && (isWs(input[i]) || input[i] === ",")) i++
    if (i >= n) break
    let url = ""
    while (i < n && !isWs(input[i])) {
      url += input[i]
      i++
    }
    let descriptor = ""
    const trailing = url.match(/,+$/)
    if (trailing) {
      url = url.slice(0, -trailing[0].length)
    } else {
      while (i < n && isWs(input[i])) i++
      let depth = 0
      while (i < n) {
        const c = input[i]
        if (c === "(") depth++
        else if (c === ")") depth = Math.max(0, depth - 1)
        else if (c === "," && depth === 0) break
        descriptor += c
        i++
      }
    }
    if (url) out.push({ url, descriptor: descriptor.trim() })
  }
  return out
}

async function inlineSrcset(
  value: string,
  fileDir: string,
  ctx: InlineContext
): Promise<string> {
  const candidates = parseSrcset(value)
  const rendered = await Promise.all(
    candidates.map(async ({ url, descriptor }) => {
      const abs = resolveWithinRoot(url, fileDir, ctx.folderPath)
      let finalUrl = url
      if (abs) {
        const dataUri = await readDataUri(ctx, abs)
        if (dataUri) finalUrl = dataUri
      }
      return descriptor ? `${finalUrl} ${descriptor}` : finalUrl
    })
  )
  return rendered.join(", ")
}

/**
 * Read an HTML document and inline all *relative, in-workspace* sub-resources
 * as `data:` URIs, returning a self-contained HTML string. The result has no
 * Content-Security-Policy of its own — apply {@link withSandboxCsp} before
 * handing it to a sandboxed iframe.
 */
export async function inlineHtmlResources(
  html: string,
  {
    fileDir,
    folderPath,
    readFileBase64,
    maxInlineBytes = DEFAULT_MAX_INLINE_BYTES,
    concurrency = defaultConcurrency(),
    stripActiveContent = false,
  }: InlineOptions
): Promise<string> {
  const ctx: InlineContext = {
    read: memoizeReader(readFileBase64),
    folderPath,
    budget: maxInlineBytes,
    embedded: 0,
    bytesRead: 0,
    readSeen: new Set(),
    gate: new ReadGate(Math.max(1, concurrency)),
  }

  const jobs: (() => Promise<void>)[] = []

  // Inert parse: <template> content is owned by a browsing-context-less
  // document, so no <img>/<iframe>/etc. resources are fetched while we rewrite.
  const parseInert = (src: string): HTMLTemplateElement => {
    const t = document.createElement("template")
    t.innerHTML = src
    return t
  }

  // A link target under any name — `href`, SVG's `xlink:href` — counts: a
  // click on it would navigate the frame itself to another page, which CSP
  // does not govern. One into the document itself (`#id`: an SVG `<use>`, a
  // gradient, an in-page anchor) stays; the frame's `about:srcdoc` base keeps
  // it there.
  const isLinkTarget = (name: string) => /(?:^|:)href$/i.test(name)
  const isOwnFragment = (url: string) => url.trimStart().startsWith("#")
  const stripActiveAttributes = (el: Element) => {
    for (const attr of Array.from(el.attributes)) {
      if (
        /^on/i.test(attr.name) ||
        (isLinkTarget(attr.name) && !isOwnFragment(attr.value)) ||
        ["action", "formaction", "nonce", "srcdoc"].includes(
          attr.name.toLowerCase()
        )
      ) {
        el.removeAttributeNode(attr)
      }
    }
  }

  // Queue every resource-rewriting job for one parsed fragment (shared ctx, so
  // the read budget/gate span all fragments).
  const queueRewrites = (root: DocumentFragment) => {
    const ownerDoc = root.ownerDocument ?? document

    if (stripActiveContent) {
      root
        .querySelectorAll("script, iframe, object, embed, link, template")
        .forEach((el) => el.remove())
      // SVG animation can set a link target the attribute pass never sees.
      root.querySelectorAll("set, animate").forEach((el) => {
        if (isLinkTarget(el.getAttribute("attributeName") ?? "")) el.remove()
      })
      root.querySelectorAll("*").forEach(stripActiveAttributes)
    }

    // Drop author policy/redirect elements: a CSP <meta> could relax the policy
    // we inject; a meta-refresh or <base> could redirect to an external origin.
    root.querySelectorAll("meta[http-equiv]").forEach((el) => {
      const kind = (el.getAttribute("http-equiv") ?? "").trim().toLowerCase()
      if (kind === "content-security-policy" || kind === "refresh") el.remove()
    })
    root.querySelectorAll("base").forEach((el) => el.remove())

    const queueAttr = (el: Element, attr: string) => {
      jobs.push(async () => {
        const url = el.getAttribute(attr)
        if (!url) return
        const abs = resolveWithinRoot(url, fileDir, folderPath)
        if (!abs) return
        const dataUri = await readDataUri(ctx, abs)
        if (dataUri) el.setAttribute(attr, dataUri)
      })
    }

    root.querySelectorAll("img[src]").forEach((el) => queueAttr(el, "src"))
    root
      .querySelectorAll("source[src], video[src], audio[src], track[src]")
      .forEach((el) => queueAttr(el, "src"))
    root
      .querySelectorAll("video[poster]")
      .forEach((el) => queueAttr(el, "poster"))

    root.querySelectorAll("img[srcset], source[srcset]").forEach((el) => {
      jobs.push(async () => {
        const value = el.getAttribute("srcset")
        if (!value) return
        el.setAttribute("srcset", await inlineSrcset(value, fileDir, ctx))
      })
    })

    // <link rel="stylesheet"> -> inlined <style>
    root.querySelectorAll('link[rel~="stylesheet"][href]').forEach((link) => {
      jobs.push(async () => {
        const href = link.getAttribute("href")
        if (!href) return
        const abs = resolveWithinRoot(href, fileDir, folderPath)
        if (!abs) return
        const css = await readResourceText(ctx, abs)
        if (css == null) return
        const inlined = await inlineCss(css, dirOf(abs), ctx, new Set([abs]))
        const style = ownerDoc.createElement("style")
        style.textContent = inlined
        const media = link.getAttribute("media")
        if (media) style.setAttribute("media", media)
        link.replaceWith(style)
      })
    })

    // Pre-existing <style> blocks may also reference relative urls.
    root.querySelectorAll("style").forEach((style) => {
      jobs.push(async () => {
        const css = style.textContent ?? ""
        if (!css.trim()) return
        style.textContent = await inlineCss(css, fileDir, ctx, new Set())
      })
    })

    // <script src> -> inline script text
    root.querySelectorAll("script[src]").forEach((script) => {
      jobs.push(async () => {
        const src = script.getAttribute("src")
        if (!src) return
        const abs = resolveWithinRoot(src, fileDir, folderPath)
        if (!abs) return
        const js = await readResourceText(ctx, abs)
        if (js == null) return
        script.removeAttribute("src")
        // Guard against a stray "</script>" terminating the tag once serialized.
        script.textContent = js.replace(/<\/script/gi, "<\\/script")
      })
    })
  }

  // Split into <head>/<body> from the SOURCE's real <body> boundary so the
  // author's split is preserved: browsers keep body-leading <script>/<style>/
  // <meta> in <body> rather than re-homing them to <head>.
  const bodyTag = findRealStartTag(html, "body")
  let headTpl: HTMLTemplateElement
  let bodyTpl: HTMLTemplateElement
  if (bodyTag) {
    headTpl = parseInert(html.slice(0, bodyTag.lt))
    bodyTpl = parseInert(html.slice(bodyTag.gtEnd))
    queueRewrites(headTpl.content)
    queueRewrites(bodyTpl.content)
    // Reads are bounded by the shared ReadGate; the jobs themselves all start.
    await Promise.all(jobs.map((job) => job()))
  } else {
    // No explicit <body>: parse the whole document, then split the flattened
    // nodes by the metadata-content rule (mirrors the implicit head/body split)
    // so e.g. <meta name="viewport"> still lands in <head>.
    const full = parseInert(html)
    queueRewrites(full.content)
    await Promise.all(jobs.map((job) => job()))
    const ownerDoc = full.content.ownerDocument ?? document
    headTpl = ownerDoc.createElement("template")
    bodyTpl = ownerDoc.createElement("template")
    let inBody = false
    for (const node of Array.from(full.content.childNodes)) {
      if (!inBody) {
        const el =
          node.nodeType === Node.ELEMENT_NODE ? (node as Element) : null
        const isMetadata = el != null && METADATA_TAGS.has(el.tagName)
        const isComment = node.nodeType === Node.COMMENT_NODE
        const isBlankText =
          node.nodeType === Node.TEXT_NODE && !(node.textContent ?? "").trim()
        if (!isMetadata && !isComment && !isBlankText) inBody = true
      }
      ;(inBody ? bodyTpl : headTpl).content.appendChild(node)
    }
  }

  // Re-apply wrapper attributes so document-level CSS still matches; inline
  // event-handler attributes (e.g. body onload) stay inert in the default
  // no-scripts sandbox.
  const wrap = extractWrapperAttrs(html)
  if (stripActiveContent) {
    for (const name of ["html", "head", "body"]) {
      const el = parseInert(`<div${wrap[name]}></div>`).content
        .firstElementChild
      if (!el) {
        wrap[name] = ""
        continue
      }
      stripActiveAttributes(el)
      wrap[name] = Array.from(
        el.attributes,
        (attr) =>
          ` ${attr.name}="${attr.value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}"`
      ).join("")
    }
  }
  return `<!DOCTYPE html>\n<html${wrap.html}>\n<head${wrap.head}>${headTpl.innerHTML}</head>\n<body${wrap.body}>${bodyTpl.innerHTML}</body>\n</html>`
}

// Default (untrusted) policy. Paired with a sandbox that omits `allow-scripts`,
// so script execution is blocked outright; `default-src 'none'` with no
// `connect-src` additionally blocks any network fetch, and `frame-src` /
// `form-action` are locked down. `base-uri about:` permits only the injected
// `about:srcdoc` base (so in-page "#fragment" links resolve same-document
// instead of navigating the frame to the host app) while still refusing any
// external-origin base.
const CSP_STRICT = [
  "default-src 'none'",
  "img-src data: blob:",
  "media-src data: blob:",
  "style-src 'unsafe-inline' data:",
  "font-src data:",
  "script-src 'none'",
  "form-action 'none'",
  "base-uri about:",
  "frame-src 'none'",
].join("; ")

// Trusted policy (explicit per-file opt-in). Allows the file's own scripts and
// network access. The iframe is still opaque-origin, so the host app's origin
// stays protected.
const CSP_TRUSTED = [
  "default-src 'none'",
  "img-src data: blob: https: http:",
  "media-src data: blob: https: http:",
  "style-src 'unsafe-inline' data: https: http:",
  "font-src data: https: http:",
  "script-src 'unsafe-inline' 'unsafe-eval' data: blob: https: http:",
  "connect-src https: http:",
  "form-action https: http:",
  "base-uri about:",
  "frame-src 'none'",
].join("; ")

// Pins the sandboxed document's base URL to its own `about:srcdoc` URL, so
// in-page "#fragment" links (and same-document SVG `<use href="#id">` refs)
// resolve against the document itself and scroll, rather than navigating the
// frame. An iframe `srcdoc` document with no `<base>` element falls back to the
// PARENT document's base URL, so a bare "#foo" would resolve to "{app-url}#foo"
// and load the host app INSIDE the opaque-origin sandbox — which cannot boot
// (no `allow-same-origin`, no scripts) and surfaces as a frame stuck on the
// app's loading screen. The inliner has already stripped every author `<base>`,
// and this one is injected first, so it is the single authoritative base (the
// first base element wins). Honored only because the CSP allows `base-uri
// about:`; that scheme can never point at an external origin.
const SANDBOX_BASE = `<base href="about:srcdoc">`

/**
 * Inject the sandbox Content-Security-Policy plus a base-URL pin as the first
 * elements of `<head>` (so the CSP applies before any script runs, and the
 * `<base>` — see {@link SANDBOX_BASE} — governs every in-page link). Cheap
 * string operation — safe to re-run when toggling trust. The real `<head>` is
 * located with the quote/comment/raw-text-aware scanner, so a "<head" inside an
 * attribute value or comment cannot misplace the injection.
 */
export function withSandboxCsp(
  html: string,
  options?: { trusted?: boolean; reporterNonce?: string }
): string {
  const nonce = options?.reporterNonce
  const csp = options?.trusted
    ? CSP_TRUSTED
    : nonce && /^[a-zA-Z0-9_-]+$/.test(nonce)
      ? CSP_STRICT.replace("script-src 'none'", `script-src 'nonce-${nonce}'`)
      : CSP_STRICT
  // CSP meta FIRST so the policy is active when the browser parses the <base>
  // and enforces its `base-uri` check against it.
  const head = `<meta http-equiv="Content-Security-Policy" content="${csp}">${SANDBOX_BASE}`
  return withHtmlPreviewHead(html, head)
}

/** 在真正的 head 开头插入受信内容，不匹配注释、属性或样式中的伪标签。 */
export function withHtmlPreviewHead(html: string, head: string): string {
  const headEnd = realStartTagEnd(html, "head")
  if (headEnd != null) {
    return html.slice(0, headEnd) + head + html.slice(headEnd)
  }
  const htmlEnd = realStartTagEnd(html, "html")
  if (htmlEnd != null) {
    return html.slice(0, htmlEnd) + `<head>${head}</head>` + html.slice(htmlEnd)
  }
  return `<head>${head}</head>${html}`
}
