/**
 * Appearance settings as part of configuration sync.
 *
 * Theme colour, fonts, zoom, background display and custom styles live in this
 * webview's localStorage — the pre-paint script needs them before React exists.
 * The backend cannot read localStorage, so two things bridge it to a config
 * snapshot (see `src-tauri/src/commands/config_sync/appearance.rs`):
 *
 * - **Mirror**: whenever a synced key changes, the whole synced set is sent to
 *   the backend, which keeps it in one database row the `appearance` domain
 *   carries. A local desktop window also mirrors on launch (its localStorage is
 *   THE appearance of that machine); a browser does not, because in server mode
 *   every browser has its own appearance and merely opening one must not
 *   replace what the others set.
 * - **Adopt**: a restore / import / rollback returns the applied values to the
 *   client that ran it, which writes them into localStorage and announces each
 *   one as a `storage` event — the path every provider already follows when
 *   another window changes a setting, so this window updates live and other
 *   windows of the same origin follow on their own.
 */

import { sanitizeCustomCss, sanitizeCustomTheme } from "./custom-style"
import { isLocalDesktop } from "./platform"
import { getTransport } from "./transport"

/**
 * Must match `APPEARANCE_STORAGE_KEYS` in
 * `src-tauri/src/commands/config_sync/appearance.rs` (a test holds the two
 * together). Deliberately absent: the background image's version stamp and
 * market source page (meaningless without the image file, which stays on its
 * machine) and the custom-style escape hatch (a per-machine safety switch).
 */
export const SYNCED_APPEARANCE_KEYS = [
  "theme",
  "codeg-theme-color",
  "codeg-zoom-level",
  "codeg-welcome-quick-actions",
  "codeg-chat-animations",
  "codeg-chat-content-width",
  "codeg-ui-font",
  "codeg-ui-font-custom",
  "codeg-ui-font-stack",
  "codeg-editor-font",
  "codeg-editor-font-custom",
  "codeg-editor-font-size",
  "codeg-editor-ligatures",
  "codeg-editor-word-wrap",
  "codeg-terminal-font",
  "codeg-terminal-font-custom",
  "codeg-terminal-font-size",
  "codeg-terminal-ligatures",
  "codeg-workspace-bg-enabled",
  "codeg-workspace-bg-mask",
  "codeg-workspace-bg-blur",
  "codeg-workspace-bg-fill",
  "codeg-workspace-bg-panel-opacity",
  "codeg-custom-theme",
  "codeg-custom-theme-enabled",
  "codeg-custom-css",
  "codeg-custom-css-enabled",
] as const

const SYNCED = new Set<string>(SYNCED_APPEARANCE_KEYS)

export function isSyncedAppearanceKey(key: string): boolean {
  return SYNCED.has(key)
}

export type AppearanceValues = Record<string, string>

/** The synced subset of this window's localStorage. */
export function readSyncedAppearance(): AppearanceValues {
  const values: AppearanceValues = {}
  if (typeof window === "undefined") return values
  try {
    for (const key of SYNCED_APPEARANCE_KEYS) {
      const value = window.localStorage.getItem(key)
      if (value !== null) values[key] = value
    }
  } catch {
    // Storage disabled: nothing to mirror.
  }
  return values
}

export async function mirrorAppearanceNow(): Promise<void> {
  if (typeof window === "undefined") return
  try {
    await getTransport().call<null>("config_sync_mirror_appearance", {
      values: readSyncedAppearance(),
    })
  } catch (err) {
    // A mirror that failed only means the next snapshot carries the previous
    // appearance; the next change retries.
    console.error("[appearance-sync] mirror failed", err)
  }
}

const MIRROR_DELAY_MS = 1000
let mirrorTimer: ReturnType<typeof setTimeout> | null = null

/** Debounced: a slider drag or a colour picker writes many times a second. */
export function scheduleAppearanceMirror(delayMs = MIRROR_DELAY_MS): void {
  if (typeof window === "undefined") return
  if (mirrorTimer !== null) clearTimeout(mirrorTimer)
  mirrorTimer = setTimeout(() => {
    mirrorTimer = null
    void mirrorAppearanceNow()
  }, delayMs)
}

/** Launch-time mirror: local desktop windows only (see the module comment). */
export function mirrorAppearanceOnLaunch(): void {
  if (isLocalDesktop()) scheduleAppearanceMirror()
}

/**
 * Re-run the checks a value went through when it was saved on the machine it
 * came from. The snapshot is a file anyone can edit and a share the user may
 * not fully control, so what it says is not trusted to have been checked.
 * `null` = drop the key.
 */
function clean(key: string, value: string): string | null {
  if (key === "codeg-custom-css") {
    if (value === "") return value
    return sanitizeCustomCss(value).css
  }
  if (key === "codeg-custom-theme") {
    try {
      return JSON.stringify(sanitizeCustomTheme(JSON.parse(value)))
    } catch {
      return null
    }
  }
  return value
}

/**
 * Write synced appearance values into this window's localStorage and announce
 * them. Returns how many keys changed.
 *
 * Everything else — whitelisting colours, zooms and font ids, clamping
 * opacities — happens where it always does: in the providers' `storage`
 * handlers and the pre-paint script, which treat these values exactly like
 * ones written by another window.
 */
export function adoptSyncedAppearance(
  values: AppearanceValues | undefined | null
): number {
  if (!values || typeof window === "undefined") return 0
  let changed = 0
  for (const [key, raw] of Object.entries(values)) {
    if (!isSyncedAppearanceKey(key) || typeof raw !== "string") continue
    const value = clean(key, raw)
    if (value === null) continue
    let oldValue: string | null
    try {
      oldValue = window.localStorage.getItem(key)
      if (oldValue === value) continue
      window.localStorage.setItem(key, value)
    } catch {
      continue
    }
    changed += 1
    // Other windows of this origin get a real `storage` event from the write
    // above; this one never does, so it is told the same way.
    window.dispatchEvent(
      new StorageEvent("storage", {
        key,
        oldValue,
        newValue: value,
        storageArea: window.localStorage,
        url: window.location.href,
      })
    )
  }
  if (changed > 0) scheduleAppearanceMirror()
  return changed
}
