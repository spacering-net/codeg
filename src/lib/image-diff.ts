import { gitShowFileBase64, readFileBase64 } from "@/lib/api"
import { extractAppCommandError, toErrorMessage } from "@/lib/app-error"
import { joinRootRel } from "@/lib/file-open-target"

// Mirrors `AppErrorCode::NotFound` in src-tauri/src/app_error.rs.
const NOT_FOUND_CODE = "not_found"

// Per-side ceiling on the bytes a diff will pull into memory. Well above any
// image a repository sensibly carries, and well under the generic 20 MB attach
// cap — diff tabs are exempt from the hidden-tab memory budget, so several open
// image diffs would otherwise be free to retain their full payloads forever.
const IMAGE_DIFF_MAX_BYTES = 8 * 1024 * 1024

/** The human sentence, not the machine hint `toErrorMessage` prefers: this
 *  lands in a diff pane, where "max_bytes=8388608" says nothing. */
function failureReason(error: unknown): string {
  return extractAppCommandError(error)?.message ?? toErrorMessage(error)
}

const IMAGE_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  svg: "image/svg+xml",
  webp: "image/webp",
  bmp: "image/bmp",
  ico: "image/x-icon",
}

export function imageMimeFromPath(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? ""
  return IMAGE_MIME[ext] ?? "image/png"
}

export function imageDataUrl(path: string, base64: string): string {
  return `data:${imageMimeFromPath(path)};base64,${base64}`
}

/** Decoded byte length of a base64 payload, without decoding it. */
export function base64ByteSize(base64: string): number {
  if (!base64) return 0
  const padding = (base64.match(/=+$/) ?? [""])[0].length
  return Math.max(0, Math.floor((base64.length * 3) / 4) - padding)
}

/**
 * One side of an image diff. `absent` is a normal outcome, not a failure: the
 * before side of an added file and the after side of a deleted one both have
 * no bytes to show. `unavailable` is the failure — kept distinct because the
 * two mean opposite things to the reader: "this file did not exist here" vs
 * "we could not find out". Collapsing them labels a modification as an
 * addition whenever a read happens to fail.
 */
export type ImageDiffSide =
  | { kind: "absent" }
  | { kind: "unavailable"; reason: string }
  | { kind: "tooLarge"; byteSize: number }
  | { kind: "image"; src: string; byteSize: number }

/** Where a side's bytes come from. */
export type ImageDiffSource =
  /** A committed blob: `HEAD`, a branch, `<sha>~1`, `<stash>^`, … */
  | {
      kind: "ref"
      ref: string
      /**
       * Whether a revision that does not resolve means "nothing existed here
       * yet" rather than a failure. True for the ones that legitimately may not
       * exist — `<sha>~1` of a root commit, `HEAD` on an unborn branch — and
       * false for a branch or commit the user is actively comparing against,
       * where a vanished ref must not be reported as an added file.
       */
      missingRefIsAbsent?: boolean
    }
  /** The file as it sits on disk right now. */
  | { kind: "worktree" }

export interface ImageDiffSides {
  original: ImageDiffSide
  modified: ImageDiffSide
}

async function loadSide(
  folderPath: string,
  file: string,
  source: ImageDiffSource
): Promise<ImageDiffSide> {
  if (source.kind === "worktree") {
    try {
      const base64 = await readFileBase64(
        joinRootRel(folderPath, file),
        IMAGE_DIFF_MAX_BYTES
      )
      return {
        kind: "image",
        src: imageDataUrl(file, base64),
        byteSize: base64ByteSize(base64),
      }
    } catch (error) {
      // A deleted file is the common reason this read fails, and it is a real
      // "absent", not a failure. Anything else (unreadable, over the attach
      // cap, transport down) must NOT masquerade as one, or a modification
      // gets labelled a deletion.
      return extractAppCommandError(error)?.code === NOT_FOUND_CODE
        ? { kind: "absent" }
        : { kind: "unavailable", reason: failureReason(error) }
    }
  }

  try {
    const blob = await gitShowFileBase64(
      folderPath,
      file,
      source.ref,
      IMAGE_DIFF_MAX_BYTES
    )
    if (!blob.exists) {
      if (blob.ref_missing && !source.missingRefIsAbsent) {
        return {
          kind: "unavailable",
          reason: `${source.ref}: no such revision`,
        }
      }
      return { kind: "absent" }
    }
    if (blob.too_large) return { kind: "tooLarge", byteSize: blob.byte_size }
    return {
      kind: "image",
      src: imageDataUrl(file, blob.data),
      byteSize: blob.byte_size,
    }
  } catch (error) {
    // "Not in the repo at this ref" already comes back as `exists: false`, so
    // a throw here is a genuine failure to look.
    return { kind: "unavailable", reason: failureReason(error) }
  }
}

/**
 * Read both sides of an image diff. Sides load in parallel and settle
 * independently — an added or deleted file resolves one side to `absent`
 * instead of failing the pair.
 */
export async function loadImageDiffSides(
  folderPath: string,
  file: string,
  original: ImageDiffSource,
  modified: ImageDiffSource
): Promise<ImageDiffSides> {
  const [originalSide, modifiedSide] = await Promise.all([
    loadSide(folderPath, file, original),
    loadSide(folderPath, file, modified),
  ])
  return { original: originalSide, modified: modifiedSide }
}
