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

export function resolveLocalImage(source: string, rootPath: string) {
  const path = localImagePath(source)
  const root = normalizeAbsPath(rootPath)
  if (!path || !isAbsoluteFilePath(root)) return null
  const extension = path.split(".").pop()?.toLowerCase() ?? ""
  if (!Object.prototype.hasOwnProperty.call(IMAGE_MIMES, extension)) return null
  const absolute = normalizeAbsPath(
    isAbsoluteFilePath(path) ? path : `${root}/${path}`
  )
  if (!isPathUnderRoot(absolute, root)) return null
  const prefix = root.endsWith("/") ? root : `${root}/`
  return {
    path: absolute.slice(prefix.length),
    name: absolute.slice(absolute.lastIndexOf("/") + 1),
    // The extension already checked above, not a second derivation from
    // `absolute` — those agree today, but only one of them was validated.
    mime: IMAGE_MIMES[extension],
  }
}

export type LocalImageReader = (
  root: string,
  relativePath: string,
  maxBytes: number
) => Promise<string>

/** Per-transcript queue: bound IO and deduplicate in-flight reads, without
 * retaining historical image bytes or serving stale screenshots after edits. */
export function createLocalImageLoader(root: string, read: LocalImageReader) {
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
        // The backend canonicalizes the path and checks symlink confinement.
        const data = await read(root, path, LOCAL_IMAGE_MAX_BYTES)
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
