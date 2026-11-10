import type { ComponentProps } from "react"
import type { Streamdown } from "streamdown"
import { visit } from "unist-util-visit"

type RehypePlugins = NonNullable<
  ComponentProps<typeof Streamdown>["rehypePlugins"]
>
type RehypePlugin = RehypePlugins[number]

type HastElementLike = {
  type: string
  tagName?: string
  properties?: Record<string, unknown>
  children?: unknown
}

// A scheme-less web address starts with its host: `www.…`, `localhost`, an
// IPv4 address, or a name ending in a common web suffix (`example.com`,
// `github.com/a/b`). `index.html` and `example.com` have the same shape and
// only the suffix tells them apart, so the list holds suffixes that are rarely
// a file extension. `sh` is left out on purpose: in a coding transcript
// `deploy.sh` is a script far more often than a `*.sh` host linked without its
// scheme — and so are `md`, `py` and `rs`, which are hosts too.
const WEB_SUFFIXES = new Set([
  "com",
  "net",
  "org",
  "io",
  "dev",
  "ai",
  "app",
  "co",
  "cn",
  "me",
  "xyz",
  "info",
  "edu",
  "gov",
  "uk",
  "de",
  "jp",
  "kr",
  "tw",
  "hk",
])

function isWebHost(segment: string): boolean {
  const host = segment.toLowerCase()
  if (host === "localhost" || host.startsWith("www.")) return true
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) return true
  // A host never starts with a dot, so `.env.local` stays a dotfile.
  const suffix = /^[^.].*\.([a-z\d]+)$/.exec(host)?.[1]
  return suffix !== undefined && WEB_SUFFIXES.has(suffix)
}

/**
 * Whether a directory-less name reads as a file rather than a word or a host:
 * it has an extension with a letter in it (`index.html`, `deploy.sh` — not
 * `v1.2.3`), it is a dotfile (`.gitignore`), or it is one of the
 * extension-less names projects keep at their root: a build file
 * (`Dockerfile`, `Makefile`, `Justfile`) or an all-caps document (`README`,
 * `LICENSE`, `CHANGELOG`).
 */
export function isFileName(name: string): boolean {
  if (!name || isWebHost(name)) return false
  return (
    /\.[A-Za-z\d]*[A-Za-z][A-Za-z\d]*$/.test(name) ||
    /^\.[^./\\]/.test(name) ||
    /^[A-Za-z]+file$/i.test(name) ||
    /^[A-Z][A-Z\d]{3,}(?:[-_][A-Z\d]+)*$/.test(name)
  )
}

// Not a bare relative path: a scheme, a root or UNC start (`/`, `\`, or the
// `%5C` a markdown destination's backslash is encoded to), a fragment or query
// of the current page, or a `~` that isn't `~/`. A UNC share is left to harden,
// which blocks it, on purpose: opening one would have the backend reach out to
// whatever host the message names.
const NOT_BARE = /^(?:[A-Za-z][A-Za-z\d+\-.]*:|[/\\#?~]|%5C)/i

/**
 * The href a relative local link keeps past rehype-harden, or `null` when
 * `href` is not one. `./…`, `../…` and `~/…` are kept (a Windows `.\…` gets
 * its first separator turned, which is the form the opener reads). A bare path
 * gets a `./` in front so the opener treats it as local: `src/main.rs` when its
 * first segment is not a host, `index.html` when the name is a file (see
 * {@link isFileName}).
 */
export function relativeFileHref(href: string): string | null {
  const explicit = /^(\.\.?)(?:\/|\\|%5C)/i.exec(href)
  if (explicit) return `${explicit[1]}/${href.slice(explicit[0].length)}`
  if (href.startsWith("~/")) return href
  if (NOT_BARE.test(href)) return null
  const path = href.split(/[?#]/, 1)[0]
  const slash = path.indexOf("/")
  if (slash === -1) return isFileName(path) ? `./${href}` : null
  return slash > 0 && !isWebHost(path.slice(0, slash)) ? `./${href}` : null
}

// Each relative link's href, keyed by its element. Only the record step writes
// here, so nothing in the message — raw HTML included — can choose what a link
// is restored to. Entries go with the tree they were made for.
const recorded = new WeakMap<object, string>()

/**
 * Runs right before rehype-harden: note each relative local link's href, as
 * {@link relativeFileHref} makes it, and hand harden a form it lets through.
 *
 * harden resolves a path-relative href against a placeholder origin and keeps
 * only the pathname, so `./index.html` would leave as `/index.html` — a path at
 * the filesystem ROOT — and it cannot parse a bare `index.html` or a `~/` path
 * at all, so it swaps those links for `… [blocked]`.
 */
export function rehypeRecordRelativeFileLinks() {
  return (tree: HastElementLike) => {
    visit(tree as never, "element", (node: HastElementLike) => {
      const href = node.properties?.href
      if (node.tagName !== "a" || typeof href !== "string") return
      const relative = relativeFileHref(href)
      if (relative === null) return
      recorded.set(node, relative)
      // harden parses `./` and `../` paths without an origin; what it makes of
      // this one is replaced by the restore step.
      node.properties!.href = relative.startsWith("~/")
        ? `./${relative}`
        : relative
    })
  }
}

/** Runs right after rehype-harden: give each noted link its href back. */
export function rehypeRestoreRelativeFileLinks() {
  return (tree: HastElementLike) => {
    visit(tree as never, "element", (node: HastElementLike) => {
      const relative = recorded.get(node)
      if (relative === undefined) return
      recorded.delete(node)
      if (node.properties) node.properties.href = relative
    })
  }
}

/**
 * Wire relative local links through a Streamdown rehype pipeline: the record
 * step goes right before `harden` and the restore right after it, so what is
 * recorded is the href sanitize already let through, and harden is the only
 * step in between. Every existing plugin keeps its key, its place and its
 * options — sanitize's schema is not widened. Without a `harden` entry both go
 * last, which still makes bare paths explicit.
 */
export function withRelativeFileLinks(
  plugins: Record<string, RehypePlugin>
): Record<string, RehypePlugin> {
  const record = rehypeRecordRelativeFileLinks as RehypePlugin
  const restore = rehypeRestoreRelativeFileLinks as RehypePlugin
  const next: Record<string, RehypePlugin> = {}
  for (const [key, plugin] of Object.entries(plugins)) {
    if (key === "harden") next.recordRelativeFileLinks = record
    next[key] = plugin
    if (key === "harden") next.restoreRelativeFileLinks = restore
  }
  next.recordRelativeFileLinks ??= record
  next.restoreRelativeFileLinks ??= restore
  return next
}
