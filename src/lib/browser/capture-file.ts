import type { CaptureOutcome } from "./types"

/** A `File` for the composer's ordinary image path, from a picture the
 *  backend base64'd. `atob` throws on malformed input, and an unusable
 *  picture must not take the block that goes with it down too — so this
 *  answers `undefined` rather than throwing. */
export function captureFile(
  capture: CaptureOutcome,
  name: string
): File | undefined {
  try {
    const bytes = Uint8Array.from(atob(capture.data), (c) => c.charCodeAt(0))
    const extension = capture.mime === "image/jpeg" ? "jpg" : "png"
    return new File([bytes], `${name}.${extension}`, { type: capture.mime })
  } catch {
    return undefined
  }
}
