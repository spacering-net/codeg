/**
 * Put files *themselves* on the OS clipboard, so a paste in Finder / Explorer
 * / Files writes a copy of the entry instead of its name.
 *
 * Desktop-only by construction: the clipboard belongs to the machine running
 * the UI, while a web or remote-desktop window's workspace lives on whatever
 * host serves it — copying there would fill the *server's* clipboard. There is
 * no HTTP route behind this, only the Tauri command, so callers must gate on
 * pure-desktop mode (`isDesktop() && !isRemoteDesktopMode()`) before calling.
 *
 * Resolving means the clipboard now advertises those files. On Linux that
 * advertisement lives only as long as the app does, which is how every GTK
 * app behaves. Rejects when a path is gone or the window system refuses the
 * clipboard — callers should surface that rather than claim a copy happened.
 */
export async function copyFilesToClipboard(paths: string[]): Promise<void> {
  const { invoke } = await import("@tauri-apps/api/core")
  await invoke("copy_files_to_clipboard", { paths })
}

/** One entry the OS clipboard holds as a file (`commands::clipboard`). */
export interface ClipboardFile {
  path: string
  /** The final path component, the name a webview gives the pasted `File`. */
  name: string
  /** Byte length of a regular file; null for anything else. */
  size: number | null
  isDir: boolean
}

/**
 * The files a copy in Finder / Explorer / a Linux file manager left on the OS
 * clipboard, empty when it holds none. A webview hands a paste of them to the
 * page as `File`s without their paths; this is where the paths come from.
 *
 * Same desktop-only contract as {@link copyFilesToClipboard}: only the Tauri
 * command exists, so callers gate on pure-desktop mode first.
 */
export async function readClipboardFiles(): Promise<ClipboardFile[]> {
  const { invoke } = await import("@tauri-apps/api/core")
  return invoke<ClipboardFile[]>("read_clipboard_files")
}
