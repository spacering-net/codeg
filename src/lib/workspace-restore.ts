import {
  getShellTransport,
  isDesktop,
  isRemoteDesktopMode,
} from "@/lib/transport"

/**
 * Sent to the local workspace window when a remote workspace that was open at
 * the last quit could not be reopened. Carries nothing: the failures are taken
 * with {@link takeWorkspaceRestoreFailures}. Mirrors `RESTORE_FAILED_EVENT` in
 * `src-tauri/src/commands/workspace_windows.rs`.
 */
export const WORKSPACE_RESTORE_FAILED_EVENT = "workspace://restore-failed"

/** A remote workspace the desktop app could not reopen at launch. */
export interface WorkspaceRestoreFailure {
  connectionId: number
  name: string
  /** The `AppCommandError` the reopen failed with. */
  error: unknown
}

/**
 * Take the remote workspaces this launch could not reopen. Each is handed out
 * once, so a nudge that arrived before the window was listening loses nothing.
 *
 * Only the local workspace window asks: a remote workspace window's transport
 * targets a `codeg-server`, which reopens no windows, and the web build has
 * none. Returns `[]` for everything else, including failures.
 */
export async function takeWorkspaceRestoreFailures(): Promise<
  WorkspaceRestoreFailure[]
> {
  if (!isDesktop() || isRemoteDesktopMode()) return []
  try {
    const failures = await getShellTransport().call<
      WorkspaceRestoreFailure[] | null
    >("take_workspace_restore_failures")
    return Array.isArray(failures) ? failures : []
  } catch (err) {
    console.warn(
      "[workspace-restore] take_workspace_restore_failures failed:",
      err
    )
    return []
  }
}
