/**
 * Copy an inline base64 image to the system clipboard as a real image
 * (so Paste in another app inserts pixels, not a path).
 *
 * Chrome / Edge / Tauri webview accept `image/png` on `ClipboardItem`.
 * JPEG / webp / gif are rewritten to PNG via a canvas so the write is
 * not rejected. Environments without `clipboard.write` throw a typed
 * error the UI can surface — see {@link canCopyImageToClipboard}, which
 * callers use to leave the action out entirely rather than offer one
 * that can only fail.
 */

/**
 * Whether this environment can take an image on the clipboard at all.
 *
 * False in a non-secure context — the server build served over plain HTTP on
 * a LAN, where `navigator.clipboard` and `ClipboardItem` are both undefined
 * (`installClipboardFallback` in `@/lib/utils` only backfills `writeText`).
 * Loopback origins such as `localhost` are a secure-context exception, as is
 * the desktop app's custom protocol, so this is true there.
 */
export function canCopyImageToClipboard(): boolean {
  return (
    typeof ClipboardItem !== "undefined" &&
    typeof navigator !== "undefined" &&
    typeof navigator.clipboard?.write === "function"
  )
}

export class ClipboardImageUnsupportedError extends Error {
  constructor() {
    super("This environment cannot copy images to the clipboard")
    this.name = "ClipboardImageUnsupportedError"
  }
}

export async function copyImageToClipboard(opts: {
  data: string
  mime_type: string
}): Promise<void> {
  if (!canCopyImageToClipboard()) {
    throw new ClipboardImageUnsupportedError()
  }
  const bytes = base64ToUint8Array(opts.data)
  const sourceType = normalizeImageMime(opts.mime_type)

  // WebKit — the webview the desktop app runs on — only honours a clipboard
  // write issued inside the user gesture, and a rasterized JPEG takes an image
  // decode plus `canvas.toBlob` to produce. Awaiting that first spends the
  // transient activation and the write then fails with NotAllowedError, so
  // hand `ClipboardItem` the pending Blob instead and let the browser await
  // it: `write()` is called synchronously, still inside the gesture. It also
  // fixes the ordering — two copies in a row land in the order they were
  // asked for, not the order their rasters happened to finish in.
  const png =
    sourceType === "image/png"
      ? Promise.resolve(new Blob([bytes as BlobPart], { type: "image/png" }))
      : rasterToPngBlob(bytes, sourceType)

  // `write()` reports a rejected value as a generic error of its own, so keep
  // the real reason and rethrow that instead. Observing without rethrowing is
  // deliberate: it hands `png` a handler up front, so a `write()` that fails
  // first for an unrelated reason (a denied permission) can't leave the raster
  // rejection unhandled. Attached before the write so it runs first, and
  // `rasterError` is set by the time the write's own rejection surfaces.
  let rasterError: unknown = null
  png.catch((err: unknown) => {
    rasterError = err
  })

  try {
    await navigator.clipboard.write([new ClipboardItem({ "image/png": png })])
  } catch (err) {
    throw rasterError ?? err
  }
}

export function normalizeImageMime(mime: string): string {
  const trimmed = mime.trim().toLowerCase()
  if (trimmed === "image/jpg") return "image/jpeg"
  return trimmed || "image/png"
}

function base64ToUint8Array(b64: string): Uint8Array {
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

function rasterToPngBlob(bytes: Uint8Array, mime: string): Promise<Blob> {
  // Node / tests without a DOM: nothing can decode the image. Only PNG reaches
  // this function, and the caller already short-circuits it.
  if (typeof document === "undefined" || typeof Image === "undefined") {
    return Promise.reject(new ClipboardImageUnsupportedError())
  }
  return new Promise((resolve, reject) => {
    const blob = new Blob([bytes as BlobPart], { type: mime })
    const url = URL.createObjectURL(blob)
    // Every exit from here has to release the object URL, or a failed copy
    // pins the decoded image for the lifetime of the document.
    const fail = (err: unknown) => {
      URL.revokeObjectURL(url)
      reject(err)
    }
    const img = new Image()
    img.onload = () => {
      try {
        const canvas = document.createElement("canvas")
        canvas.width = img.naturalWidth || img.width
        canvas.height = img.naturalHeight || img.height
        const ctx = canvas.getContext("2d")
        if (!ctx) {
          fail(new ClipboardImageUnsupportedError())
          return
        }
        ctx.drawImage(img, 0, 0)
        canvas.toBlob((out) => {
          if (!out) {
            fail(new ClipboardImageUnsupportedError())
            return
          }
          URL.revokeObjectURL(url)
          resolve(out)
        }, "image/png")
      } catch (err) {
        fail(err)
      }
    }
    img.onerror = () => {
      fail(new ClipboardImageUnsupportedError())
    }
    img.src = url
  })
}
