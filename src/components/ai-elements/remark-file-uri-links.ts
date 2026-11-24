import { isFileName } from "./rehype-relative-file-links"

// Local-file markdown links are otherwise rendered as `… [blocked]`. Three
// distinct sanitize/harden rules cause this, all sidestepped here in the mdast
// layer (before remark-rehype) while keeping the link clickable through the
// existing link-safety + open-file-dialog flow:
//
//   1. `file://` hrefs — rehype-harden hard-codes `file:` in its blocked-
//      protocol list. Rewritten to a bare local path (POSIX `/…`, `/C:/…` for
//      Windows drives, or a `\\server\share` UNC form).
//   2. Bare Windows drive paths (`C:/…`, `C:\…`) — rehype-sanitize reads the
//      leading `C:` as a URL protocol and strips the href, after which harden
//      blocks the now-hrefless `<a>`. Rewritten to `/C:/…` so `C:` is no longer
//      in protocol position (see {@link windowsDrivePathToSafe}).
//   3. A file position at the folder root (`a.ts:12`) — the same misreading,
//      of `a.ts:` this time. Rewritten to `./a.ts:12` (see
//      {@link rootFilePositionToRelative}).
//
// Relative links (`./a.md`, `src/a.md`, `~/a.md`) survive sanitize but not
// harden, which flattens or blocks them; that is handled after sanitize, in
// ./rehype-relative-file-links, where raw HTML anchors are covered too.
//
// Image destinations are handled by remarkLocalImages, which preserves their
// original path until the workspace-confined image reader can resolve it.

type MdastNodeLike = {
  type: string
  url?: unknown
  identifier?: unknown
  children?: unknown
}

function fileUriToLocalPath(uri: string): string | null {
  if (!/^file:\/\//i.test(uri)) return null
  let parsed: URL
  try {
    parsed = new URL(uri)
  } catch {
    return null
  }
  // A non-empty host is a UNC authority: file://server/share/x parses as
  // host="server", pathname="/share/x". Emit the BACKSLASH UNC form
  // \\server\share\x — unambiguously LOCAL. A forward-slash //server/share
  // would be indistinguishable from a protocol-relative WEB url once the
  // file: scheme is gone, and downstream (classifyResourceKind /
  // link-safety) route bare // to the browser; backslashes never appear in
  // a web url, so they reliably tag the target as a local file. The click
  // path normalizes the separators back to // before opening.
  if (parsed.host) {
    const body = `${parsed.host}${parsed.pathname}`.replace(/\//g, "\\")
    return `\\\\${body}${parsed.search}${parsed.hash}`
  }
  // Keep the pathname verbatim, INCLUDING the leading slash before a Windows
  // drive letter (`/C:/…`). Stripping it to a bare `C:/…` makes the downstream
  // rehype-sanitize step read `C:` as a URL protocol and drop the href, after
  // which rehype-harden replaces the link with a `… [blocked]` span. The
  // leading slash is stripped back off before the file is opened
  // (link-safety's `stripLeadingSlashOnWindows`). POSIX paths already start
  // with a slash, so they are unaffected. URL-encoded form is preserved so
  // `%23` / `%3F` don't collide with fragment/query boundaries when the click
  // handler later splits on `#` / `?`.
  return `${parsed.pathname}${parsed.search}${parsed.hash}`
}

// A bare Windows drive-letter path (`C:/…` or `C:\…`, no `file://` scheme) hits
// the same wall as the rewritten `file://` drive path above: rehype-sanitize
// parses the leading `C:` as a URL protocol and strips the href → harden emits
// `… [blocked]`. Prefixing a single slash — `/C:/…` — pushes the colon past the
// first `/`, so sanitize sees a schemeless, path-absolute URL and keeps it.
// Downstream (`classifyResourceKind`, link-safety's `stripLeadingSlashOnWindows`,
// `normalizeAbsPath`) already strips that leading slash back off before opening,
// so the opener still receives `C:/…`. This adds no new allowed protocol.
const WINDOWS_DRIVE_PATH = /^[a-zA-Z]:[\\/]/

function windowsDrivePathToSafe(url: string): string | null {
  return WINDOWS_DRIVE_PATH.test(url) ? `/${url}` : null
}

// A file position at the folder root (`a.ts:12`, `.env:3`, `Makefile:40:2`)
// hits the same wall: with no directory in front, rehype-sanitize reads `a.ts:`
// as a URL protocol and strips the href. `./a.ts:12` puts the colon behind a
// slash, and link-safety splits the line back off before opening. A host with
// a port (`localhost:3000`, `example.com:8080`, `10.0.0.1:80`) has no file
// name in front of the colon and keeps its href.
const ROOT_FILE_POSITION = /^([^\s/\\?#:]+):\d+(?::\d+)?$/

function rootFilePositionToRelative(url: string): string | null {
  const name = ROOT_FILE_POSITION.exec(url)?.[1]
  return name !== undefined && isFileName(name) ? `./${url}` : null
}

/** Rewrite a local file url sanitize would misread to a sanitize-safe form. */
function rewriteLocalFileUrl(url: string): string | null {
  return (
    fileUriToLocalPath(url) ??
    windowsDrivePathToSafe(url) ??
    rootFilePositionToRelative(url)
  )
}

function walk(node: MdastNodeLike, fn: (n: MdastNodeLike) => void): void {
  fn(node)
  const { children } = node
  if (Array.isArray(children)) {
    for (const child of children) {
      walk(child as MdastNodeLike, fn)
    }
  }
}

export function remarkRewriteFileUriLinks() {
  return (tree: MdastNodeLike) => {
    // Definitions are shared between linkReference and imageReference. Skip
    // any definition whose identifier is consumed by an imageReference so
    // image blocking still wins for those cases.
    const imageRefIds = new Set<string>()
    walk(tree, (node) => {
      if (
        node.type === "imageReference" &&
        typeof node.identifier === "string"
      ) {
        imageRefIds.add(node.identifier.toLowerCase())
      }
    })

    walk(tree, (node) => {
      if (typeof node.url !== "string") return
      if (node.type === "link") {
        const rewritten = rewriteLocalFileUrl(node.url)
        if (rewritten != null) node.url = rewritten
        return
      }
      if (node.type === "definition") {
        const id =
          typeof node.identifier === "string"
            ? node.identifier.toLowerCase()
            : ""
        if (imageRefIds.has(id)) return
        const rewritten = rewriteLocalFileUrl(node.url)
        if (rewritten != null) node.url = rewritten
      }
    })
  }
}
