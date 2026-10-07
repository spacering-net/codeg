import {
  getActiveRemoteConnectionId,
  isDesktop,
  getTransport,
} from "./transport"
import type { EventStream, UnsubscribeFn } from "./transport/types"

/**
 * Platform-aware API wrappers for features that differ between
 * Tauri desktop and web browser environments.
 */

export { isDesktop }

/**
 * True only for a LOCAL desktop app — a Tauri window not viewing a remote
 * workspace. This is the exact condition under which `openPath` /
 * `revealItemInDir` actually do something (they no-op otherwise), so gate any
 * "reveal in file manager" affordance on it to avoid rendering a dead button
 * for remote-desktop connections.
 */
export function isLocalDesktop(): boolean {
  return isDesktop() && getActiveRemoteConnectionId() === null
}

/**
 * True for a Tauri window pointed at a REMOTE workspace — the one case where
 * we know for certain the host that owns the workspace paths is not the machine
 * the user is looking at.
 *
 * Gate on this for actions the backend performs by opening a window on the
 * workspace host (launching an external editor, say): they'd succeed on the
 * far end and appear to do nothing here. Plain web mode is deliberately NOT
 * covered — a browser pointed at a `codeg-server` running on the user's own
 * machine is a first-class setup, and the loopback hostname can't tell that
 * apart from a port-forwarded remote.
 */
export function isRemoteDesktopWindow(): boolean {
  return isDesktop() && getActiveRemoteConnectionId() !== null
}

/**
 * Subscribe to backend events.
 * Uses Tauri listen() in desktop mode, WebSocket in web mode.
 */
export async function subscribe<T>(
  event: string,
  handler: (payload: T) => void
): Promise<UnsubscribeFn> {
  return getTransport().subscribe(event, handler)
}

/**
 * Register a callback to fire after a WebSocket transport reconnects.
 * Returns an unsubscribe function. Returns `null` on IPC-only transports
 * (desktop Tauri) where there's no disconnect window to recover from —
 * callers that re-fetch state on reconnect can safely no-op in that case.
 *
 * Use this alongside `subscribe()` for state that must be re-synced after
 * a network blip: the broadcaster drops events while `receiver_count == 0`,
 * so anything fired during the disconnect window is lost.
 */
export function onTransportReconnect(
  callback: () => void
): UnsubscribeFn | null {
  return getTransport().onReconnect?.(callback) ?? null
}

/**
 * Per-connection Subscribe-with-Snapshot stream. Returns `null` only on
 * the desktop Tauri transport (which uses local IPC and is race-free, so
 * the legacy `subscribe()` flow stays as the fallback). Web and remote-
 * desktop transports always return an EventStream.
 *
 * The returned EventStream instance is owned by the transport: it survives
 * across calls and re-attaches its subscriptions on reconnect. Don't
 * cache it across remote-workspace swaps — call this each time you need
 * to attach so you bind to the currently-active transport.
 */
export function getEventStream(): EventStream | null {
  const transport = getTransport()
  const factory = transport.eventStream
  if (!factory) return null
  return factory.call(transport)
}

/**
 * Open a URL in the default browser (desktop) or a new tab (web).
 *
 * The remote-workspace guard its neighbours carry is deliberately ABSENT here.
 * `openPath` / `revealItemInDir` take filesystem paths, which belong to
 * whichever host the workspace lives on; a URL belongs to no host. And a
 * remote-desktop window is still a Tauri webview, where `window.open` opens
 * NOTHING (the app registers no new-window handler, so wry answers the request
 * with nil on macOS and `SetHandled(true)` on Windows) — gating this on
 * `isLocalDesktop()` left every external link silently dead in those windows.
 * The `remote-*` windows carry `opener:default` in `capabilities/default.json`,
 * so the plugin call is permitted there.
 *
 * `noreferrer` (which implies `noopener`) is not decoration: without it the
 * opened page gets a `window.opener` handle back into the app and can navigate
 * this tab, and the Referer leaks. It also makes `window.open` return null even
 * on success (HTML window-open steps 12 and 17), so the return value carries no
 * signal — don't test it for a "popup blocked" check.
 */
export async function openUrl(url: string): Promise<void> {
  if (isDesktop()) {
    const { openUrl: tauriOpenUrl } = await import("@tauri-apps/plugin-opener")
    await tauriOpenUrl(url)
  } else {
    window.open(url, "_blank", "noreferrer")
  }
}

/**
 * Open a path in the system file manager (desktop only).
 * No-op in web mode.
 */
export async function openPath(path: string): Promise<void> {
  if (isDesktop() && getActiveRemoteConnectionId() === null) {
    const { openPath: tauriOpenPath } =
      await import("@tauri-apps/plugin-opener")
    await tauriOpenPath(path)
  }
}

/** The directory a native path lives in, or null when what is left is a root
 *  rather than a folder — `\`, `\\server` with no share, `C:`.
 *
 *  A backslash ends a component only in a path that announces itself as a
 *  Windows one (a drive or a UNC share): these paths come from whichever host
 *  owns the workspace, so a Windows path has to be understood on macOS — but
 *  a POSIX file may legitimately be named `report\2026.pdf`, and cutting
 *  there would name a folder the file is not in. Windows takes either
 *  separator, so an absolute Windows path is cut at whichever comes last. */
function containingDirectory(path: string): string | null {
  const windows = /^([A-Za-z]:|\\\\)/.test(path)
  const cut = windows
    ? Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"))
    : path.lastIndexOf("/")
  if (cut < 0) return null
  const dir = path.slice(0, cut)
  return /^([\\/]{0,2}|[\\/]{2}[^\\/]+|[A-Za-z]:)$/.test(dir) ? null : dir
}

/**
 * Reveal a file/directory in the system file manager (desktop only).
 * No-op in web mode.
 *
 * Falls back to opening the containing folder: the plugin resolves the path
 * before handing it to the shell, which on Windows turns a network location
 * into the extended `\\?\UNC\…` form that `ILCreateFromPath` refuses — so
 * "show in folder" is otherwise dead for anyone whose downloads land on a
 * share or a redirected folder. The fallback loses the selection, not the
 * errand.
 */
export async function revealItemInDir(path: string): Promise<void> {
  if (!isDesktop() || getActiveRemoteConnectionId() !== null) return
  const opener = await import("@tauri-apps/plugin-opener")
  try {
    await opener.revealItemInDir(path)
  } catch (error) {
    const dir = containingDirectory(path)
    if (!dir) throw error
    await opener.openPath(dir)
  }
}

/**
 * Open a native file/directory dialog (desktop) or fallback (web).
 */
export async function openFileDialog(options?: {
  directory?: boolean
  multiple?: boolean
  title?: string
  defaultPath?: string
}): Promise<string | string[] | null> {
  if (isDesktop() && getActiveRemoteConnectionId() === null) {
    const { open } = await import("@tauri-apps/plugin-dialog")
    return open(options ?? {})
  }
  // Web fallback: for directory selection, prompt for server-side path.
  // For file selection, use a hidden file input.
  if (options?.directory) {
    const path = window.prompt(
      options?.title ?? "输入服务端目录路径 (Enter server directory path)"
    )
    return path || null
  }
  return new Promise((resolve) => {
    const input = document.createElement("input")
    input.type = "file"
    if (options?.multiple) input.multiple = true
    input.onchange = () => {
      if (!input.files?.length) {
        resolve(null)
        return
      }
      const paths = Array.from(input.files).map((f) => f.name)
      resolve(options?.multiple ? paths : paths[0])
    }
    input.click()
  })
}

/**
 * Get the current Tauri window (desktop only).
 * Returns null in web mode.
 */
export async function getCurrentWindow() {
  if (isDesktop()) {
    const { getCurrentWindow: tauriGetCurrentWindow } =
      await import("@tauri-apps/api/window")
    return tauriGetCurrentWindow()
  }
  return null
}

/**
 * Close the current window.
 * Desktop: closes Tauri window. Web: navigates back or closes tab.
 */
export async function closeCurrentWindow(): Promise<void> {
  if (isDesktop()) {
    const win = await getCurrentWindow()
    await win?.close()
  } else {
    window.history.back()
  }
}
