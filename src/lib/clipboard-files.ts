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
