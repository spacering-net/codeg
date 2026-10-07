import { extractAppCommandError, toErrorMessage } from "./app-error"
import { getTransport, isDesktop, isRemoteDesktopMode } from "./transport"
import type { AppCommandError } from "./types"

// Drive the LOCAL Tauri app updater only for a genuine local desktop window.
// A remote-desktop window IS a Tauri app (`isDesktop()` is true) but its
// backend is a remote codeg-server, so update checks/actions must target that
// server through the transport — otherwise the operator would check and update
// their own local app instead of the server they are managing.
export function usesTauriUpdater(): boolean {
  return isDesktop() && !isRemoteDesktopMode()
}

// All updater imports are dynamic to avoid crashing in non-Tauri browsers.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Update = any

export type ServerUpdateCapability = "supervised" | "reexec"

/** The three release fields the UI actually renders. Deliberately plain data:
 * the download is driven by the BACKEND (`perform_app_update` re-checks on its
 * own — see `src-tauri/src/commands/app_update.rs`), so no caller needs to hold
 * on to Tauri's `Update` resource handle. */
export interface AppUpdateInfo {
  version: string
  body: string
  date?: string | null
}

export interface AppUpdateCheckResult {
  currentVersion: string
  /** The newer release, or null when already up to date. */
  update: AppUpdateInfo | null
  // Server-mode only (absent in desktop). Whether THIS server process can
  // apply the update in place, how it would restart, the deployment kind,
  // the restart delay to drive the frontend countdown, and whether a
  // previous version is staged for rollback.
  selfUpdateSupported?: boolean
  capability?: ServerUpdateCapability
  runtime?: string
  restartDelayMs?: number
  rollbackAvailable?: boolean
  // Whether the server speaks the detached `app_update_state` protocol
  // (background download + progress events). Absent on servers older than this
  // feature — a newer client must NOT drive the new in-place flow against them
  // (their `perform_app_update` blocks and returns the legacy shape), and falls
  // back to the "view release" affordance instead.
  liveProgress?: boolean
}

// Local-only server self-update status, separate from {@link checkAppUpdate}
// (which contacts the release source). Mirrors the backend `app_update_status`
// handler.
export interface ServerUpdateStatus {
  currentVersion: string
  selfUpdateSupported: boolean
  capability: ServerUpdateCapability
  runtime: string
  restartDelayMs: number
  rollbackAvailable: boolean
  liveProgress?: boolean
  /** Why an in-place update can't run on this server although the platform
   * supports one — the error the update itself would fail with, e.g. an
   * install directory this process can't write (a `permission_denied` one
   * rules out a rollback too). Render it with {@link describeAppUpdateError}.
   * Only reported here, never by the check, so there is one source to trust.
   * Absent when nothing is in the way, and on servers that predate it. */
  selfUpdateBlocker?: AppCommandError | null
}

// ─── Unified, backend-owned update lifecycle ───────────────────────────────
//
// The backend (desktop tauri-plugin-updater OR server in-place swap) is the
// single source of truth for an in-flight/completed update. The UI subscribes
// to `app_update_state` and re-syncs from a snapshot on mount, so progress
// survives navigating between settings pages, closing the page, or a reload.
// Mirrors `src-tauri/src/update/state.rs` (camelCase over the wire).

export type AppUpdateLifecycle =
  | "idle"
  | "downloading"
  | "installing"
  | "ready_to_restart"
  | "restarting"
  | "error"

export interface AppUpdateState {
  /** Monotonic; keep only the highest-seq snapshot/event seen. */
  seq: number
  status: AppUpdateLifecycle
  /** Bytes downloaded so far (downloading only). */
  downloaded?: number
  /** Total bytes from Content-Length, if known. */
  total?: number | null
  /** Target version, once known. */
  version?: string
  /** Server-only: relaunch delay for the restart countdown. */
  restartDelayMs?: number
  /** Server-only: supervisor probation window. */
  trialSeconds?: number
  /** Server-only: how the restart is carried out. */
  capability?: ServerUpdateCapability
  /** Raw error message (error only); classify via {@link normalizeAppUpdateError}. */
  error?: string
  /** The structured error behind `error`, when the backend had one — code,
   * OS detail, and for a failure it can explain an i18n key with params.
   * {@link describeAppUpdateError} prefers it over classifying `error`. */
  errorInfo?: AppCommandError
}

/** Snapshot of the current update state. Works in every mode: desktop reads a
 * Tauri command, server/remote reads the HTTP handler. Call on mount to
 * recover an in-flight download the UI would otherwise have lost. */
export function getAppUpdateState(): Promise<AppUpdateState> {
  return getTransport().call<AppUpdateState>("app_update_state")
}

/** Subscribe to live update-state transitions (download progress, ready,
 * error, restarting). Arm this BEFORE the snapshot fetch so no event is
 * missed. */
export function subscribeAppUpdateState(
  handler: (state: AppUpdateState) => void
): Promise<() => void> {
  return getTransport().subscribe<AppUpdateState>("app_update_state", handler)
}

/** Begin (or attach to) the download+install. Returns immediately with the
 * current snapshot; progress arrives via {@link subscribeAppUpdateState}. The
 * download runs detached in the backend, so it is not bound to this call's
 * lifetime. */
export function startAppUpdate(): Promise<AppUpdateState> {
  return getTransport().call<AppUpdateState>("perform_app_update")
}

/** Relaunch into the freshly-installed bytes. Desktop relaunches the app;
 * server triggers the supervised/re-exec restart (the caller then drives the
 * countdown + health poll using the `ReadyToRestart` snapshot's metadata). */
export function restartApp(): Promise<void> {
  return getTransport().call("restart_app")
}

export interface ServerUpdateActionResult {
  version?: string
  needRestart: boolean
  restartDelayMs: number
  // Supervisor probation window (seconds): a freshly-upgraded worker that
  // crashes within it is auto-rolled-back. 0 in re-exec mode (no supervisor),
  // so the frontend need not wait it out before declaring success.
  trialSeconds: number
  capability: ServerUpdateCapability
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

export type AppUpdateErrorKind =
  | "source_unreachable"
  | "network"
  | "download_failed"
  | "permission_denied"
  | "install_failed"
  | "unknown"

export interface AppUpdateErrorInfo {
  kind: AppUpdateErrorKind
  rawMessage: string
}

/**
 * Message key (under the `SystemSettings` namespace) that explains an update
 * failure to the user. Shared by every surface that reports one — the settings
 * page's inline banner and the provider's toast — so a given failure reads the
 * same wherever it shows up. An unclassifiable failure during an install is
 * still an install failure; during a check it's genuinely unknown.
 */
export type AppUpdateErrorMessageKey =
  | "updateErrors.sourceUnavailable"
  | "updateErrors.network"
  | "updateErrors.downloadFailed"
  | "updateErrors.permissionDenied"
  | "updateErrors.targetWriteFailed"
  | "updateErrors.installFailed"
  | "updateErrors.unknown"

export function appUpdateErrorMessageKey(
  kind: AppUpdateErrorKind,
  action: "check" | "install"
): AppUpdateErrorMessageKey {
  switch (kind) {
    case "source_unreachable":
      return "updateErrors.sourceUnavailable"
    case "network":
      return "updateErrors.network"
    case "download_failed":
      return "updateErrors.downloadFailed"
    case "permission_denied":
      return "updateErrors.permissionDenied"
    case "install_failed":
      return "updateErrors.installFailed"
    case "unknown":
    default:
      return action === "install"
        ? "updateErrors.installFailed"
        : "updateErrors.unknown"
  }
}

/** A {@link AppUpdateErrorMessageKey} with the ICU values its message needs. */
export interface AppUpdateErrorMessage {
  key: AppUpdateErrorMessageKey
  values: Record<string, string>
}

/**
 * Explanations the server attaches to update failures it can pin down,
 * keyed by the i18n key it sends (`UPDATE_I18N_KEY_*` in
 * src-tauri/src/update/install.rs), with the params each message interpolates.
 * A Map, not an object literal: the key comes off the wire, and a plain lookup
 * would resolve `"constructor"` to a prototype member.
 */
const SERVER_UPDATE_ERROR_MESSAGES = new Map<
  string,
  { key: AppUpdateErrorMessageKey; params: readonly string[] }
>([
  [
    "SystemSettings.updateErrors.permissionDenied",
    { key: "updateErrors.permissionDenied", params: ["path"] },
  ],
  [
    "SystemSettings.updateErrors.targetWriteFailed",
    { key: "updateErrors.targetWriteFailed", params: ["path", "reason"] },
  ],
])

/**
 * What to tell the user about an update failure. `info` — the structured error
 * behind a lifecycle `error`, or a {@link ServerUpdateStatus.selfUpdateBlocker}
 * — wins when the server explained the failure: it says precisely what went
 * wrong, down to the directory. Everything else is classified from `error` as
 * before: older servers, the desktop updater (whose plugin errors are opaque
 * strings), and failures the server left unexplained.
 */
export function describeAppUpdateError(
  error: unknown,
  action: "check" | "install",
  info?: AppCommandError | null
): AppUpdateErrorMessage {
  const structured = extractAppCommandError(info)
  const explained = structured?.i18n_key
    ? SERVER_UPDATE_ERROR_MESSAGES.get(structured.i18n_key)
    : undefined
  if (explained) {
    const params = structured?.i18n_params ?? {}
    const values: Record<string, string> = {}
    for (const name of explained.params) {
      if (typeof params[name] === "string") values[name] = params[name]
    }
    // A message missing one of its values would render as a formatting error,
    // so an incomplete explanation falls back to the classification below.
    if (Object.keys(values).length === explained.params.length) {
      return { key: explained.key, values }
    }
  }

  const { kind, rawMessage } = normalizeAppUpdateError(error)
  return {
    key: appUpdateErrorMessageKey(kind, action),
    values:
      kind === "permission_denied"
        ? { path: unwritableTargetPath(rawMessage) }
        : {},
  }
}

export async function getCurrentAppVersion(): Promise<string> {
  if (!usesTauriUpdater()) {
    // Read the running version from a LOCAL source, never the
    // manifest-dependent update check: the settings page loads this alongside
    // unrelated local state (proxy settings). This must fail OPEN — neither a
    // release-source outage nor an older server missing /app_update_status
    // (a newer desktop talking to an older remote server) may fail the load.
    try {
      const status = await getServerUpdateStatus()
      if (status?.currentVersion) return status.currentVersion
    } catch {
      // Older server without the status route, or a transient failure — fall
      // through to /health (present on every server build), never to the
      // manifest check.
    }
    return (await getRunningServerVersion()) ?? "unknown"
  }
  try {
    const { getVersion } = await import("@tauri-apps/api/app")
    return await getVersion()
  } catch {
    return "unknown"
  }
}

/**
 * Bound on the manifest fetch. `tauri-plugin-updater` defaults to NO timeout,
 * so a black-holed network (dropped packets, captive portal, no RST) would
 * leave `check()` pending forever — and with it the caller's in-flight guard,
 * killing update checks for the rest of the session. Matches the standalone
 * server's own manifest budget (8s connect + 15s total in
 * `src-tauri/src/update/version.rs`), so every runtime fails in about the same
 * time. The server and remote-desktop paths are already bounded by their
 * transports (60s / 30s).
 */
const MANIFEST_TIMEOUT_MS = 15_000

/**
 * Ask the release source whether a newer version exists, normalized to plain
 * data across both runtimes.
 *
 * Desktop goes through `tauri-plugin-updater`, whose `check()` resolves to a
 * resource-backed `Update` handle. We copy the three fields we render and
 * release the handle immediately — nothing downstream needs it (the actual
 * download runs in Rust via `perform_app_update`, which re-checks itself), so
 * holding it would only leak an entry in Tauri's resource table on every
 * periodic check.
 *
 * Server/remote hits `check_app_update`, which already answers in this shape.
 */
export async function checkAppUpdateInfo(): Promise<AppUpdateCheckResult> {
  if (!usesTauriUpdater()) {
    return getTransport().call<AppUpdateCheckResult>("check_app_update")
  }
  const { getVersion } = await import("@tauri-apps/api/app")
  const { check } = await import("@tauri-apps/plugin-updater")
  const [currentVersion, update] = await Promise.all([
    getVersion(),
    check({ timeout: MANIFEST_TIMEOUT_MS }),
  ])
  if (!update) return { currentVersion, update: null }
  try {
    return {
      currentVersion,
      update: {
        version: update.version,
        body: update.body ?? "",
        date: update.date ?? null,
      },
    }
  } finally {
    // Best-effort: a failed close costs one resource-table slot, never the
    // check result the caller is waiting on.
    try {
      await closeUpdateHandle(update)
    } catch (err) {
      console.error("[Update] release updater resource failed:", err)
    }
  }
}

async function closeUpdateHandle(update: NonNullable<Update>): Promise<void> {
  if (typeof update?.close !== "function") return
  await update.close()
}

/**
 * Local-only self-update status (capability + rollback availability) that does
 * NOT contact the release source. Drives the manual rollback affordance so it
 * stays reachable when the update manifest is unreachable (proxy/outage/air-gap)
 * — `rollback_app` is entirely local. Returns null for a genuine local desktop
 * window (no server to query; it updates via the Tauri plugin).
 */
export async function getServerUpdateStatus(): Promise<ServerUpdateStatus | null> {
  if (usesTauriUpdater()) return null
  return getTransport().call<ServerUpdateStatus>("app_update_status")
}

export async function relaunchApp(): Promise<void> {
  const { relaunch } = await import("@tauri-apps/plugin-process")
  await relaunch()
}

// ─── Server / Docker in-place self-update ──────────────────────────────────

/** Revert to the previously-installed bundle (kept as `.bak`). */
export async function rollbackServer(): Promise<ServerUpdateActionResult> {
  return getTransport().call<ServerUpdateActionResult>("rollback_app")
}

/**
 * Poll `/health` until the restarted server answers or the deadline passes.
 * The WebSocket drops during restart and HTTP calls fail in the meantime —
 * both are swallowed as "not up yet".
 */
export async function waitForServerHealthy(opts: {
  timeoutMs: number
  intervalMs?: number
  initialDelayMs?: number
}): Promise<boolean> {
  const interval = opts.intervalMs ?? 1500
  if (opts.initialDelayMs) await sleep(opts.initialDelayMs)
  const deadline = Date.now() + opts.timeoutMs
  while (Date.now() < deadline) {
    try {
      await getTransport().call("health", {}, { timeoutMs: 4000 })
      return true
    } catch {
      // Server still restarting — keep polling.
    }
    await sleep(interval)
  }
  return false
}

/**
 * Read the running server's version from `/health`. Local-only — no remote
 * manifest fetch — so it can confirm (even when the update source is
 * unreachable) that a restart actually landed on the new version rather than
 * an auto-rolled-back previous one. Returns null if `/health` reports no
 * version (older server) or the call fails.
 */
export async function getRunningServerVersion(): Promise<string | null> {
  try {
    return await readServerVersionStrict()
  } catch {
    return null
  }
}

/**
 * Like {@link getRunningServerVersion} but distinguishes "server reachable but
 * reports no version" (resolves null — an older build) from "server
 * unreachable" (rejects). Use where a silent fallback to stale UI state could
 * mask a later rollback, e.g. establishing the pre-upgrade baseline: a failed
 * `/health` call must not be mistaken for a definitive "no version" answer.
 */
export async function readServerVersionStrict(): Promise<string | null> {
  const res = await getTransport().call<{ version?: string }>(
    "health",
    {},
    { timeoutMs: 4000 }
  )
  return res?.version ?? null
}

export type RollbackOutcome = "rolled-back" | "unchanged" | "unreachable"

/**
 * After a rollback restart (the server is already answering `/health`), confirm
 * it came back on a *different* (previous) version than the one we rolled back
 * from. The rollback target can be an older build whose `/health` omits the
 * version — that still counts as rolled back: the server is up and the backend
 * has restored the previous bundle, so a missing version (strict-read resolves
 * null) must NOT be mistaken for a failed restart. Only a version that stays
 * equal to `fromVersion` is `"unchanged"` (rollback didn't take); only a server
 * we can never read across all attempts is `"unreachable"`. Polls to ride out
 * the relaunch.
 */
export async function confirmRollbackVersion(
  fromVersion: string | null,
  opts?: { attempts?: number; intervalMs?: number }
): Promise<RollbackOutcome> {
  const attempts = opts?.attempts ?? 5
  const interval = opts?.intervalMs ?? 1500
  let everRead = false
  for (let i = 0; i < attempts; i++) {
    try {
      const landed = await readServerVersionStrict()
      everRead = true
      // null = healthy but versionless (older target); any value !== the
      // pre-rollback version = moved off it. Both mean the rollback landed.
      if (landed === null || landed !== fromVersion) return "rolled-back"
      // landed === fromVersion: not yet (or rollback didn't take) — retry.
    } catch {
      // Briefly unreachable during the relaunch — retry.
    }
    if (i < attempts - 1) await sleep(interval)
  }
  return everRead ? "unchanged" : "unreachable"
}

const UNWRITABLE_TARGET_PREFIX = "update target is not writable:"

/** The directory named by an unwritable-target message (see
 * {@link UNWRITABLE_TARGET_PREFIX}). Only the separator space after the colon
 * is dropped, never the path's own characters. */
function unwritableTargetPath(rawMessage: string): string {
  const rest = rawMessage.slice(UNWRITABLE_TARGET_PREFIX.length)
  return rest.startsWith(" ") ? rest.slice(1) : rest
}

export function normalizeAppUpdateError(error: unknown): AppUpdateErrorInfo {
  const rawMessage = toErrorMessage(error)
  const normalized = rawMessage.toLowerCase()

  // The server's pre-download writability probe (`check_writable` in
  // src-tauri/src/update/install.rs, whose test pins this prefix) — how a
  // server that predates `errorInfo` reports it. Checked first: the message
  // ends in an arbitrary path, which may contain any of the substrings below.
  // A bare "permission denied" stays an install failure — only the probe
  // proves the unwritable part is the install location itself.
  if (normalized.startsWith(UNWRITABLE_TARGET_PREFIX)) {
    return { kind: "permission_denied", rawMessage }
  }

  if (
    normalized.includes("latest.json") ||
    normalized.includes("/releases/latest/download/")
  ) {
    return { kind: "source_unreachable", rawMessage }
  }

  if (
    normalized.includes("error sending request for url") ||
    normalized.includes("failed to send request") ||
    normalized.includes("network") ||
    normalized.includes("timed out") ||
    normalized.includes("dns") ||
    normalized.includes("connection refused")
  ) {
    return { kind: "network", rawMessage }
  }

  if (
    normalized.includes("download") ||
    normalized.includes("checksum") ||
    normalized.includes("content-length")
  ) {
    return { kind: "download_failed", rawMessage }
  }

  if (
    normalized.includes("install") ||
    normalized.includes("installer") ||
    normalized.includes("permission denied")
  ) {
    return { kind: "install_failed", rawMessage }
  }

  return { kind: "unknown", rawMessage }
}
