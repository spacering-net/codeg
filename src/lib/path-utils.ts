/**
 * The separator `path` writes its own segments with. A path that already
 * contains a backslash is Windows-native; so is a bare drive designator
 * (`C:`), which a user can type into a directory field before any separator
 * exists. Everything else — POSIX paths, and Windows paths typed with forward
 * slashes — gets `/`, so appending to a path never mixes the two forms.
 */
export function fsSeparator(path: string): "\\" | "/" {
  if (path.includes("\\")) return "\\"
  if (path.includes("/")) return "/"
  return /^[A-Za-z]:$/.test(path) ? "\\" : "/"
}

export function joinFsPath(basePath: string, relPath: string): string {
  if (!relPath) return basePath
  const separator = fsSeparator(basePath)
  const normalizedRel = relPath.replace(/[\\/]/g, separator)
  if (basePath.endsWith("/") || basePath.endsWith("\\")) {
    return `${basePath}${normalizedRel}`
  }
  return `${basePath}${separator}${normalizedRel}`
}

/**
 * The final segment of an OS path, accepting either separator so a Windows
 * path (`C:\work\repo`) yields `repo` rather than the whole string — which is
 * what a `split("/")` would hand back. Trailing separators are ignored.
 * Returns an empty string when the path is a bare root (`/`, `C:\`) and so has
 * no name of its own, letting callers substitute their own fallback. A UNC
 * share (`\\server\share`) does name something, and yields `share`.
 */
export function fsBaseName(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "")
  if (!trimmed) return ""
  // `C:` after trimming — a drive designator, not a directory name.
  if (/^[A-Za-z]:$/.test(trimmed)) return ""
  const index = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"))
  return index >= 0 ? trimmed.slice(index + 1) : trimmed
}

/**
 * A path named `name` sitting next to `path`.
 *
 * At a root (`/`, `C:\`, `\\server\share`) there is no sibling to offer, so
 * the result lands INSIDE the root instead. Staying absolute matters more than
 * keeping the sibling shape: a bare relative name would make git resolve a new
 * worktree inside the repository and then hand that unresolved string back to
 * be registered as the folder's working directory.
 */
export function siblingFsPath(path: string, name: string): string {
  return joinFsPath(parentFsPath(path) ?? path, name)
}

/**
 * Return the parent directory of an OS path, using whichever separator the
 * path itself uses. Returns `null` when there is no meaningful parent —
 * i.e. the path is already a root (`/`, `C:\`, `\\server\share`) or empty.
 *
 * The server file browser navigates Windows and POSIX paths transparently
 * depending on which OS the remote codeg-server runs on, so a single
 * `split("/")` would silently break Windows roots like `C:\Users\foo`.
 *
 * UNC paths (`\\server\share\...`) are treated specially: the share root
 * itself has no navigable parent — `\\server` is not a real location on
 * Windows. A naïve pop would expose the host as if it were a directory,
 * letting the UI navigate into a path the OS can't open.
 */
export function parentFsPath(path: string): string | null {
  if (!path) return null
  const usesBackslash = path.includes("\\")
  const separator = usesBackslash ? "\\" : "/"
  // Detect a UNC prefix (`\\host\...` or `//host/...`). The third
  // character must be a non-separator so the regex doesn't match
  // pathological inputs like `\\\\`.
  const isUnc = /^[\\/][\\/][^\\/]/.test(path)
  // Strip trailing separators, but never collapse the leading separator(s)
  // of a POSIX root or a UNC prefix.
  const trimmed = path.replace(/[/\\]+$/, "")
  if (!trimmed) {
    // The path was nothing but separators: `/`, `\\`, ... — already root.
    return null
  }
  // Windows drive root: `C:` or `C:\`. After trimming trailing separators
  // we land on `C:` which has no parent.
  if (/^[A-Za-z]:$/.test(trimmed)) return null
  const parts = trimmed.split(/[\\/]/)

  if (isUnc) {
    // `\\server\share\folder` splits to ["", "", "server", "share",
    // "folder"]. The first two empties are the UNC prefix; "server"
    // and "share" are the host and share components — both mandatory.
    // Length ≤ 4 means we're at or above the share root, where the
    // only navigable parent doesn't exist on Windows.
    if (parts.length <= 4) return null
    parts.pop()
    return parts.join(separator)
  }

  if (parts.length <= 1) {
    // POSIX root degenerate case (`foo` with no leading slash) — no
    // meaningful parent we can navigate to.
    return null
  }
  parts.pop()
  const parent = parts.join(separator)
  if (!parent) {
    // Joined to empty means we were one segment below the root. Return
    // the explicit root so the UI navigates to `/` rather than `""`.
    return separator
  }
  // Windows drive root needs a trailing separator (`C:\`, not `C:`) for
  // path APIs and for visual clarity.
  if (/^[A-Za-z]:$/.test(parent)) return `${parent}${separator}`
  return parent
}
