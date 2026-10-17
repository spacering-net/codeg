import { getServerBaseUrl, isRemoteDesktopMode } from "@/lib/transport"

/**
 * Folder commands written as `local: <command>` run on the desktop's own
 * machine instead of the folder's host — the way to reach local tools (e.g.
 * `local: zed "ssh://host$CODEG_FOLDER_PATH"`) from a remote project. Kept as
 * a prefix on the stored command so it needs nothing from the server.
 */
const LOCAL_COMMAND_PREFIX = /^\s*local:\s*/i

/** The command to run locally, or `null` when `command` isn't a local one. */
export function parseLocalCommand(command: string): string | null {
  const match = LOCAL_COMMAND_PREFIX.exec(command)
  if (!match) return null
  const rest = command.slice(match[0].length).trim()
  return rest || null
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
