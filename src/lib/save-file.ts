import { isDesktop } from "@/lib/platform"

/**
 * Outcome of a save operation.
 *
 * - `"saved"`: the file was actually written (desktop) or the browser
 *   download was kicked off (web — best effort, the browser owns the
 *   download manager from there).
 * - `"cancelled"`: the user dismissed the desktop save dialog. Only
 *   reachable on desktop; web mode never returns this.
 *
 * Real I/O failures (e.g. macOS TCC denying disk write after the user
 * picked a path) are surfaced as thrown exceptions so callers can
 * disambiguate from cancellation and render a real error toast instead
 * of a misleading success.
 */
export type SaveFileResult = "saved" | "cancelled"

/**
 * Save a UTF-8 text payload to disk.
 *
 * Desktop (Tauri): pops the system "Save As" dialog and writes via the
 * `save_text_file` Rust command — write failures (e.g. macOS TCC denial
 * after the dialog cached an earlier "Don't Allow") propagate as
 * exceptions, so the caller can show a real error toast instead of a
 * misleading success.
 *
 * Web (browser): falls back to the legacy `<a download>` Blob link;
 * the browser owns the download manager and we have no per-call status
 * channel, so this path is always reported as `"saved"`.
 */
export async function saveTextFile(opts: {
  content: string
  suggestedName: string
  mimeType: string
  filterName: string
  ext: string
}): Promise<SaveFileResult> {
  const { content, suggestedName, mimeType, filterName, ext } = opts

  if (isDesktop()) {
    const { save } = await import("@tauri-apps/plugin-dialog")
    const path = await save({
      defaultPath: suggestedName,
      filters: [{ name: filterName, extensions: [ext] }],
    })
    if (!path) return "cancelled"
    const { invoke } = await import("@tauri-apps/api/core")
    await invoke("save_text_file", { path, contents: content })
    return "saved"
  }

  const blob = new Blob([content], { type: mimeType })
  const url = URL.createObjectURL(blob)
  const link = document.createElement("a")
  link.href = url
  link.download = suggestedName
  document.body.append(link)
  link.click()
  link.remove()
  URL.revokeObjectURL(url)
  return "saved"
}
