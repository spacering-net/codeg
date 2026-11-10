import { getServerBaseUrl, isRemoteDesktopMode } from "@/lib/transport"
import type { FolderCommand } from "@/lib/types"

/**
 * Whether `command` runs on the desktop's own machine instead of in a terminal
 * on the folder's host — the way to reach local tools (e.g.
 * `zed "ssh://host$CODEG_FOLDER_PATH"`) from a remote project. Rows from a
 * server older than the flag don't carry it: those run in a terminal.
 */
export function isLocalCommand(command: FolderCommand): boolean {
  return command.run_local === true
}

/** Host name of the remote codeg-server this window is bound to, if any. */
export function getRemoteHostName(): string | null {
  if (!isRemoteDesktopMode()) return null
  try {
    return new URL(getServerBaseUrl()).hostname || null
  } catch {
    return null
  }
}
