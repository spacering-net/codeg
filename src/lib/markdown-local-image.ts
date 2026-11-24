import { isAbsoluteFilePath } from "@/lib/file-path-display"
import { isPathUnderRoot, normalizeAbsPath } from "@/lib/file-open-target"

const IMAGE_MIMES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  svg: "image/svg+xml",
  avif: "image/avif",
  bmp: "image/bmp",
  ico: "image/x-icon",
}

export const LOCAL_IMAGE_MAX_BYTES = 8 * 1024 * 1024

/** The MIME type of an image file, by its extension; null for any other file. */
export function localImageMime(path: string): string | null {
  const extension = path.split(".").pop()?.toLowerCase() ?? ""
  return Object.prototype.hasOwnProperty.call(IMAGE_MIMES, extension)
    ? IMAGE_MIMES[extension]
    : null
}

/** Recognize file references before rehype-harden changes their destinations. */
export function localImagePath(source: string): string | null {
  let path = source.trim()
  if (!path || path.startsWith("//") || path.startsWith("#")) return null
  if (/^[\\/]{2}[?.][\\/]/.test(path)) return null
  if (/^file:/i.test(path)) {
    try {
      const url = new URL(path)
      path = url.host ? `//${url.host}${url.pathname}` : url.pathname
    } catch {
      return null
    }
  } else {
    // A drive letter is a path, not a URI scheme. Drive-relative C:foo is
    // deliberately excluded because it depends on process-global state.
    if (/^[a-z][a-z\d+.-]*:/i.test(path) && !/^[a-z]:[\\/]/i.test(path)) {
      return null
    }
    path = path.split(/[?#]/, 1)[0]
  }
  try {
    path = decodeURIComponent(path)
  } catch {
    return null
  }
  if (/[\u0000-\u001f\u007f]/.test(path)) return null
  path = path.replace(/\\/g, "/")
  // Reject device paths and NTFS alternate data streams as well as schemes
  // hidden behind percent encoding. Only the drive-designator colon is valid.
  if (/^\/\/[?.]\//.test(path) || /:/.test(path.replace(/^\/?[a-z]:\//i, ""))) {
    return null
  }
  return path
}

/**
 * The image file a Markdown destination names. `path` is relative to the root
 * for an image inside it, and absolute for one outside it: an agent's QR code
 * or screenshot is often in /tmp, not in the workspace. Without a root, only an
 * absolute path names a file.
 */
export function resolveLocalImage(source: string, rootPath: string | null) {
  const path = localImagePath(source)
  if (!path) return null
  const mime = localImageMime(path)
  if (!mime) return null
  if (rootPath === null) {
    if (!isAbsoluteFilePath(path)) return null
    const absolute = normalizeAbsPath(path)
    // A network share: see below.
    if (absolute.startsWith("//")) return null
    const name = absolute.slice(absolute.lastIndexOf("/") + 1)
    return { path: absolute, name, mime }
  }
  const root = normalizeAbsPath(rootPath)
  if (!isAbsoluteFilePath(root)) return null
  // Not `${root}/…`: under the POSIX root that reads `//…`, a network share.
  const prefix = root.endsWith("/") ? root : `${root}/`
  const absolute = normalizeAbsPath(
    isAbsoluteFilePath(path) ? path : `${prefix}${path}`
  )
  const inRoot = isPathUnderRoot(absolute, root)
  // A network share other than the one the workspace is on: opening it would
  // make this machine contact the host the reply names (on Windows, signing in
  // to it). The POSIX root `/` counts `//host/…` as inside it, so the share
  // test is on the root itself.
  if (absolute.startsWith("//") && !(inRoot && root.startsWith("//"))) {
    return null
  }
  const name = absolute.slice(absolute.lastIndexOf("/") + 1)
  // Both results take `mime` from the extension already checked above, not a
  // second derivation from `absolute` — those agree today, but only one of
  // them was validated.
  if (inRoot) {
    // A drive or share root matches case-insensitively, and lowercasing can
    // change a string's length (`İ` → `i̇`): cut only where the root really
    // ends, or the rest names another file.
    const head = absolute.slice(0, prefix.length)
    if (head.toLowerCase() !== prefix.toLowerCase()) return null
    return { path: absolute.slice(prefix.length), name, mime }
  }
  return { path: absolute, name, mime }
}

export type LocalImageReader = (
  root: string,
  relativePath: string,
  maxBytes: number
) => Promise<string>

export type AbsoluteFileReader = (
  path: string,
  maxBytes: number
) => Promise<string>

/** Per-transcript queue: bound IO and deduplicate in-flight reads, without
 * retaining historical image bytes or serving stale screenshots after edits.
 * A relative path is read inside the root, an absolute one where it is. */
export function createLocalImageLoader(
  root: string | null,
  read: LocalImageReader,
  readAbsolute: AbsoluteFileReader
) {
  const pending = new Map<string, Promise<string | null>>()
  const waiting: Array<() => void> = []
  let active = 0

  return (path: string): Promise<string | null> => {
    const existing = pending.get(path)
    if (existing) return existing
    const load = async () => {
      if (active >= 4)
        await new Promise<void>((resolve) => waiting.push(resolve))
      else active += 1
      try {
        // Inside the root, the backend canonicalizes the path and checks
        // symlink confinement. Without a root, a relative path names nothing.
        const data = isAbsoluteFilePath(path)
          ? await readAbsolute(path, LOCAL_IMAGE_MAX_BYTES)
          : root === null
            ? null
            : await read(root, path, LOCAL_IMAGE_MAX_BYTES)
        return data && data.length <= Math.ceil(LOCAL_IMAGE_MAX_BYTES / 3) * 4
          ? data
          : null
      } catch {
        return null
      } finally {
        pending.delete(path)
        const next = waiting.shift()
        if (next) next()
        else active -= 1
      }
    }
    const result = load()
    pending.set(path, result)
    return result
  }
}
