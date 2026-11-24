// Centralized build/parse for file-workspace tab ids.
//
// Plain file tabs (and the external-conflict diff surface, which is a view of
// one file) are identified by the file's ABSOLUTE normalized path — a file tab
// carries no folder identity, so the same physical file opened from any
// entrance is one tab. Git-scoped diff tabs (working/branch/commit/session)
// remain namespaced by the owning folder's numeric id: they are repository
// operations and need the repo root. All variable segments (paths, branches,
// commits, labels) are encodeURIComponent-encoded, which guarantees they
// contain no ":" — the segment separator — so parsing is a plain split with
// fixed segment counts. Never assemble or regex these ids inline; extend this
// module instead.
//
// Ids are session-only (never persisted), so the format can evolve freely.

export type FileTabIdParts =
  | { kind: "file"; path: string }
  | { kind: "diff-working-all"; folderId: number }
  | { kind: "diff-working"; folderId: number; path: string }
  | { kind: "diff-working-unified"; folderId: number; path: string }
  | { kind: "diff-working-overview"; folderId: number; path: string }
  | {
      kind: "diff-branch"
      folderId: number
      branch: string
      path: string | null
    }
  | {
      kind: "diff-branch-overview"
      folderId: number
      branch: string
      path: string | null
    }
  | {
      kind: "diff-commit"
      folderId: number
      commit: string
      path: string | null
    }
  | { kind: "diff-session"; folderId: number; groupLabel: string; path: string }
  | { kind: "diff-external-conflict"; path: string }
  // Built-in browser tab. `id` is the backend's tab id (a uuid, or
  // `<opener-uuid>-p<n>` for a popup adopted from another tab); it never
  // contains ":" so it needs no encoding, but goes through the encoder anyway.
  | { kind: "browser"; id: string }

export type FileTabIdKind = FileTabIdParts["kind"]

function encodeToken(token: string): string {
  return encodeURIComponent(token)
}

function decodeToken(token: string): string {
  try {
    return decodeURIComponent(token)
  } catch {
    return token
  }
}

// Nullable path segment: the empty string is the null sentinel. Safe because
// no real path encodes to "" (encodeURIComponent never produces an empty
// string from non-empty input, and empty paths are rejected upstream).
function encodeNullableToken(token: string | null): string {
  return token == null ? "" : encodeToken(token)
}

function decodeNullableToken(token: string): string | null {
  return token === "" ? null : decodeToken(token)
}

export function buildFileTabId(parts: FileTabIdParts): string {
  switch (parts.kind) {
    case "file":
      return `file:${encodeToken(parts.path)}`
    case "diff-working-all":
      return `diff:working-all:${parts.folderId}`
    case "diff-working":
      return `diff:working:${parts.folderId}:${encodeToken(parts.path)}`
    case "diff-working-unified":
      return `diff:working-unified:${parts.folderId}:${encodeToken(parts.path)}`
    case "diff-working-overview":
      return `diff:working-overview:${parts.folderId}:${encodeToken(parts.path)}`
    case "diff-branch":
      return `diff:branch:${parts.folderId}:${encodeToken(parts.branch)}:${encodeNullableToken(parts.path)}`
    case "diff-branch-overview":
      return `diff:branch-overview:${parts.folderId}:${encodeToken(parts.branch)}:${encodeNullableToken(parts.path)}`
    case "diff-commit":
      return `diff:commit:${parts.folderId}:${encodeToken(parts.commit)}:${encodeNullableToken(parts.path)}`
    case "diff-session":
      return `diff:session:${parts.folderId}:${encodeToken(parts.groupLabel)}:${encodeToken(parts.path)}`
    case "diff-external-conflict":
      return `diff:external-conflict:${encodeToken(parts.path)}`
    case "browser":
      return `browser:${encodeToken(parts.id)}`
  }
}

/** The backend tab id of a browser tab, or null for any other tab. */
export function browserTabBackendId(tabId: string): string | null {
  const parts = parseFileTabId(tabId)
  return parts?.kind === "browser" ? parts.id : null
}

// Strict numeric-only folder segment: rejects "", "1x", "-1" so a malformed
// or legacy id can never silently parse into the wrong folder.
function parseFolderIdSegment(segment: string | undefined): number | null {
  if (!segment || !/^\d+$/.test(segment)) return null
  return Number(segment)
}

export function parseFileTabId(id: string): FileTabIdParts | null {
  const segments = id.split(":")
  const head = segments[0]

  if (head === "file") {
    if (segments.length !== 2 || segments[1] === "") return null
    return { kind: "file", path: decodeToken(segments[1]) }
  }

  if (head === "browser") {
    if (segments.length !== 2 || segments[1] === "") return null
    return { kind: "browser", id: decodeToken(segments[1]) }
  }

  if (head !== "diff") return null
  const variant = segments[1]

  // external-conflict is file-identified (no folder segment) — branch before
  // the shared folder-segment parse below.
  if (variant === "external-conflict") {
    if (segments.length !== 3 || segments[2] === "") return null
    return { kind: "diff-external-conflict", path: decodeToken(segments[2]) }
  }

  const folderId = parseFolderIdSegment(segments[2])
  if (folderId == null) return null
  const tail = segments.slice(3)

  switch (variant) {
    case "working-all":
      return tail.length === 0 ? { kind: "diff-working-all", folderId } : null
    case "working":
      return tail.length === 1
        ? { kind: "diff-working", folderId, path: decodeToken(tail[0]) }
        : null
    case "working-unified":
      return tail.length === 1
        ? {
            kind: "diff-working-unified",
            folderId,
            path: decodeToken(tail[0]),
          }
        : null
    case "working-overview":
      return tail.length === 1
        ? {
            kind: "diff-working-overview",
            folderId,
            path: decodeToken(tail[0]),
          }
        : null
    case "branch":
      return tail.length === 2
        ? {
            kind: "diff-branch",
            folderId,
            branch: decodeToken(tail[0]),
            path: decodeNullableToken(tail[1]),
          }
        : null
    case "branch-overview":
      return tail.length === 2
        ? {
            kind: "diff-branch-overview",
            folderId,
            branch: decodeToken(tail[0]),
            path: decodeNullableToken(tail[1]),
          }
        : null
    case "commit":
      return tail.length === 2
        ? {
            kind: "diff-commit",
            folderId,
            commit: decodeToken(tail[0]),
            path: decodeNullableToken(tail[1]),
          }
        : null
    case "session":
      return tail.length === 2
        ? {
            kind: "diff-session",
            folderId,
            groupLabel: decodeToken(tail[0]),
            path: decodeToken(tail[1]),
          }
        : null
    default:
      return null
  }
}
