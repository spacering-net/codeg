import { copyTextToClipboard } from "@/lib/utils"

/**
 * Put text that is still being fetched on the clipboard. Resolves to whether
 * it got there, and rejects with the fetch's own failure when the text could
 * not be had.
 *
 * WebKit — the desktop app's webview — takes a clipboard write only inside the
 * user gesture that asked for it, and a round trip to the backend outlasts the
 * gesture: written after it, the copy would fail. So where `ClipboardItem` is
 * available the write is issued at once with the text still pending, and the
 * browser waits for it — what `copyImageToClipboard` does for the same reason.
 * Where it is not (a page served over plain HTTP has no async clipboard), the
 * text is awaited and written the ordinary way, which those pages allow.
 */
export async function copyPendingText(text: Promise<string>): Promise<boolean> {
  if (
    typeof ClipboardItem !== "undefined" &&
    typeof navigator !== "undefined" &&
    typeof navigator.clipboard?.write === "function"
  ) {
    // The write reports a failed item as a generic error of its own; the
    // fetch's failure is kept to report instead. Observed before the write is
    // issued, so it is known by the time the write's rejection arrives.
    let failure: { error: unknown } | null = null
    text.catch((error: unknown) => {
      failure = { error }
    })
    const blob = text.then((value) => new Blob([value], { type: "text/plain" }))
    // Handled here so that a write that fails first, for its own reason,
    // cannot leave this one unhandled.
    blob.catch(() => {})
    try {
      await navigator.clipboard.write([
        new ClipboardItem({ "text/plain": blob }),
      ])
      return true
    } catch {
      const fetchFailure = failure as { error: unknown } | null
      if (fetchFailure) throw fetchFailure.error
      // The clipboard refused the item itself: try the ordinary way.
    }
  }
  return copyTextToClipboard(await text)
}
