// Pure link-target classification shared by every place a clicked address
// has to be routed: the transcript link-safety flow, the built-in browser's
// link decision function (`resolve-link-action.ts`) and the terminal's link
// handler. It answers ONE question — "what is this string?" — and never touches
// React, the transport layer or the DOM, so it is unit-testable in isolation
// and the classification cannot drift between entrances.
//
// The parsing helpers below were lifted verbatim from
// `components/ai-elements/link-safety.tsx`; `resource-kind.ts` mirrors the
// same regexes for the presentational type icon. Keep the three in step.

export interface LocalFileTarget {
  path: string
  line: number | null
}

const WINDOWS_ABSOLUTE_PATH = /^[a-zA-Z]:[\\/]/
const URL_SCHEME = /^[a-zA-Z][a-zA-Z\d+\-.]*:/
export const ALLOWED_EXTERNAL_PROTOCOLS = new Set([
  "http:",
  "https:",
  "mailto:",
  "tel:",
])
// Protocols handled by the OS (mail client, dialer) rather than a browser
// page load. They must NOT be opened via `window.open(_, "_blank")` — most
// browsers leave behind an empty `about:blank` tab once the OS handler fires.
export const OS_HANDLER_PROTOCOLS = new Set(["mailto:", "tel:"])

export function normalizeSlashPath(path: string): string {
  return path.replace(/\\/g, "/")
}

/** Strip leading slash before Windows drive letter: /C:/foo → C:/foo */
function stripLeadingSlashOnWindows(p: string): string {
  if (p.startsWith("/") && WINDOWS_ABSOLUTE_PATH.test(p.slice(1))) {
    return p.slice(1)
  }
  return p
}

function decodeUriSafely(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function parseLineValue(raw: string | undefined): number | null {
  if (!raw) return null
  const line = Number.parseInt(raw, 10)
  if (!Number.isFinite(line) || line <= 0) return null
  return line
}

function parseHashLine(hash: string): number | null {
  const normalized = hash.startsWith("#") ? hash.slice(1) : hash
  if (!normalized) return null
  // `L<start>` / `L<start>-<end>` / `L<start>-L<end>` (GitHub-style) — a range
  // (e.g. the editor's "add selection" badge `#L10-25`) jumps to its start line.
  return (
    parseLineValue(normalized.match(/^L(\d+)(?:-L?\d+)?$/i)?.[1]) ??
    parseLineValue(normalized.match(/^line=(\d+)$/i)?.[1]) ??
    parseLineValue(normalized.match(/^(\d+)$/)?.[1])
  )
}

function splitPathAndLine(rawPath: string): LocalFileTarget {
  const trimmed = rawPath.trim()
  const match = trimmed.match(/^(.*):(\d+)(?::\d+)?$/)
  if (!match) {
    return { path: trimmed, line: null }
  }

  const maybePath = match[1]
  if (!maybePath || maybePath.endsWith("://")) {
    return { path: trimmed, line: null }
  }

  const line = parseLineValue(match[2])
  if (!line) {
    return { path: trimmed, line: null }
  }

  return { path: maybePath, line }
}

function isLocalPathLike(path: string): boolean {
  // "//host/…" (forward slashes) is protocol-relative — a WEB url, not a
  // local path. It must fall through to the external-URL route, never into
  // local file IO. A "\\server\share" (backslashes) IS a local UNC path
  // (a web url never uses backslashes) — the form remark-file-uri-links
  // emits for file://server/share URIs.
  return (
    (path.startsWith("/") && !path.startsWith("//")) ||
    path.startsWith("\\\\") ||
    path.startsWith("./") ||
    path.startsWith("../") ||
    path.startsWith("~/") ||
    WINDOWS_ABSOLUTE_PATH.test(path)
  )
}

/**
 * Parse a link target into a local file path + optional line, or null when it
 * isn't a local file (a web url, an unsupported scheme, a bare-relative path).
 * Exported so the transcript's file-badge action menu (message/
 * file-reference-actions.tsx) resolves a badge's path exactly the way a click
 * on that badge resolves it.
 */
export function parseLocalFileTarget(rawUrl: string): LocalFileTarget | null {
  const trimmed = rawUrl.trim()
  if (!trimmed) return null

  if (trimmed.toLowerCase().startsWith("file://")) {
    try {
      const parsed = new URL(trimmed)
      const rawPathname = decodeUriSafely(parsed.pathname)
      // A non-empty host is a UNC authority (file://server/share/x) —
      // preserve it as //server/share/x rather than dropping to /share/x.
      const normalizedPathname = parsed.host
        ? `//${parsed.host}${rawPathname}`
        : stripLeadingSlashOnWindows(rawPathname)
      const pathAndLine = splitPathAndLine(normalizedPathname)
      if (!pathAndLine.path) return null
      return {
        path: normalizeSlashPath(pathAndLine.path),
        line: parseHashLine(parsed.hash) ?? pathAndLine.line,
      }
    } catch {
      return null
    }
  }

  if (URL_SCHEME.test(trimmed) && !WINDOWS_ABSOLUTE_PATH.test(trimmed)) {
    return null
  }

  // Split on raw # / ? before decoding so encoded `%23` / `%3F` inside the
  // path don't get promoted to fragment/query separators (which would point
  // the file opener at the wrong file).
  const hashIndex = trimmed.indexOf("#")
  const rawHash = hashIndex >= 0 ? trimmed.slice(hashIndex) : ""
  const beforeHash = hashIndex >= 0 ? trimmed.slice(0, hashIndex) : trimmed
  const queryIndex = beforeHash.indexOf("?")
  const rawPathPart =
    queryIndex >= 0 ? beforeHash.slice(0, queryIndex) : beforeHash
  const decodedPath = decodeUriSafely(rawPathPart)
  const pathAndLine = splitPathAndLine(decodedPath)
  const normalizedPath = stripLeadingSlashOnWindows(pathAndLine.path)
  if (!isLocalPathLike(normalizedPath)) return null

  return {
    path: normalizeSlashPath(normalizedPath),
    line: parseHashLine(rawHash) ?? pathAndLine.line,
  }
}

export function parseExternalUrl(rawUrl: string): URL | null {
  const trimmed = rawUrl.trim()
  if (!trimmed) return null

  if (trimmed.startsWith("//")) {
    // Protocol-relative: pin to https rather than the page protocol — a
    // Tauri webview's own scheme (tauri://localhost) would otherwise
    // classify these as an unsupported protocol, and the desktop opener
    // capability only allows concrete http(s) URLs.
    try {
      return new URL(`https:${trimmed}`)
    } catch {
      return null
    }
  }

  if (!URL_SCHEME.test(trimmed) || WINDOWS_ABSOLUTE_PATH.test(trimmed)) {
    return null
  }

  try {
    return new URL(trimmed)
  } catch {
    return null
  }
}

export function getAllowedExternalProtocol(rawUrl: string): string | null {
  const parsed = parseExternalUrl(rawUrl)
  if (!parsed) return null
  const protocol = parsed.protocol.toLowerCase()
  return ALLOWED_EXTERNAL_PROTOCOLS.has(protocol) ? protocol : null
}

/**
 * The single classification every link entrance runs first. Order matters and
 * mirrors what `useOpenLinkOrFile` has always done: a local path wins over any
 * scheme parse (a Windows `C:\\…` would otherwise read as a URL scheme), then
 * the protocol allow-list decides between the OS handler route, the http(s)
 * route and "unsupported" — which stays a rejection: `vscode:`, `javascript:`,
 * `data:`, `ftp:` and friends are never handed to the OS.
 *
 * `url` on the `os-handler` / `http` arms is the CANONICAL string to open: a
 * protocol-relative `//host/path` becomes a concrete `https://host/path` (the
 * desktop opener capability only allows http(s), and a raw `//…` would resolve
 * against the webview's own scheme).
 */
export type LinkClassification =
  | { kind: "empty" }
  | { kind: "file"; target: LocalFileTarget }
  | { kind: "os-handler"; protocol: string; url: string }
  | { kind: "http"; url: string; parsed: URL }
  | { kind: "unsupported" }

export function classifyLinkTarget(rawUrl: string): LinkClassification {
  const trimmed = rawUrl.trim()
  if (!trimmed) return { kind: "empty" }

  const local = parseLocalFileTarget(trimmed)
  if (local) return { kind: "file", target: local }

  const parsed = parseExternalUrl(trimmed)
  if (!parsed) return { kind: "unsupported" }
  const protocol = parsed.protocol.toLowerCase()
  if (!ALLOWED_EXTERNAL_PROTOCOLS.has(protocol)) return { kind: "unsupported" }

  const url = trimmed.startsWith("//") ? `https:${trimmed}` : trimmed
  if (OS_HANDLER_PROTOCOLS.has(protocol)) {
    return { kind: "os-handler", protocol, url }
  }
  return { kind: "http", url, parsed }
}
