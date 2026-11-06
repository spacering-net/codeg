/**
 * Shared gate for the ACP connection teardowns that fire on their own — no
 * user asked for them — so they can't drift apart:
 *
 *   * the tab-unmount cleanup (`shouldDisconnectOnUnmount`)
 *   * the preview-tab release (`disconnectIfIdle`), fired when the next
 *     single-click in the sidebar takes the preview slot
 *   * the provider's own unmount cleanup
 *   * the frontend idle sweep, alongside guards this predicate can't express
 *     (`connecting`, viewers, delegation children, the idle timer)
 *
 * The reconnect popover reads it too, to warn before a reconnect destroys the
 * same work.
 */

import { extractAppCommandError, toErrorMessage } from "@/lib/app-error"
import { isAsyncTaskTerminal } from "@/lib/async-tasks"
import type { AsyncTaskRecord, RemoteControlInfo } from "@/lib/types"

/**
 * Everything the gate weighs. Every field is required on purpose: a caller
 * that builds this from a subset of the connection fails to compile instead
 * of quietly skipping a kind of work — which is how the AIR half once went
 * missing here while the idle sweep already checked it.
 */
export interface ConnectionWork {
  status: string | null
  backgroundOutstanding: number
  asyncTasks: readonly AsyncTaskRecord[]
  remoteControl: RemoteControlInfo | null
  /** Child connection ids of the codeg delegations still running. */
  delegatedChildren: readonly string[]
}

/**
 * Work that an `acpDisconnect` would DESTROY rather than merely detach from.
 * The backend tears a connection down unconditionally, so the agent CLI dies
 * with everything running inside it:
 *
 *   * an in-flight turn, which agents record in their own transcript as an
 *     interrupted request;
 *   * launched-but-unresolved background work (async sub-agent / background
 *     shell), as the transcript watcher counts it (`backgroundOutstanding`).
 *     The watcher settles or expires the count and reports 0;
 *   * the same kind of work as the AIR async-task channel reports it. The
 *     watcher only sees work that leaves a Claude transcript trace: a codex
 *     background terminal, a Claude Monitor or workflow task, or a Grok
 *     workflow is announced here and nowhere else. ORed with the count, never
 *     summed, like the backend's `has_active_background_work`;
 *   * Claude Code's Remote Control, which runs in the agent CLI: the user
 *     handed the session to claude.ai/code or a phone. It stays until they
 *     turn it off (the backend sweep spares it too);
 *   * a codeg delegation (`delegate_to_agent`) still running. It outlives the
 *     turn that started it, and the backend cancels every sub-agent a parent
 *     has in flight when the parent goes (the backend sweep spares it too,
 *     while the child is alive).
 *
 * Only OWNERS need this gate: a viewer's teardown detaches and never kills
 * anything, and the sweeps skip viewers, so one left attached leaks its
 * subscription. An explicit `disconnect` ignores it by design — that path
 * carries user intent (agent switch, restart-to-apply, an explicit close).
 */
export function isConnectionBusy(conn: ConnectionWork): boolean {
  return (
    conn.status === "prompting" ||
    conn.backgroundOutstanding > 0 ||
    conn.asyncTasks.some((task) => !isAsyncTaskTerminal(task)) ||
    conn.remoteControl != null ||
    conn.delegatedChildren.length > 0
  )
}

// Must mirror `AcpError::ConnectionNotFound`'s code in
// src-tauri/src/acp/error.rs. If the backend enum ever renames, both sides
// must change together.
export const CONNECTION_NOT_FOUND_CODE = "connection_not_found"

/**
 * A teardown that failed because the connection was ALREADY gone — another
 * window reaped it, the agent process died, or the backend restarted. For
 * every purpose that counts as a successful teardown: the backend is holding
 * nothing, and the local entry is simply stale.
 *
 * Worth telling apart because every OTHER failure (a transport blip, a backend
 * that never processed the request) may leave the agent process ALIVE, and a
 * caller that reports "restarted, config applied" on one of those is lying —
 * the next connect can re-attach to the very process it believed it replaced.
 *
 * The message fallback mirrors the variant's `#[error("connection not found:
 * {0}")]` text: a synchronous Tauri command rejection flattens to a bare
 * message string and does not expose the error `code` (the same reason
 * `connect()` matches on the literal "is not installed").
 */
export function isConnectionGoneError(error: unknown): boolean {
  const appError = extractAppCommandError(error)
  if (appError?.code === CONNECTION_NOT_FOUND_CODE) return true
  return toErrorMessage(error).toLowerCase().includes("connection not found")
}
