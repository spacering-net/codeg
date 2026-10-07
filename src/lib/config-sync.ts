/**
 * Frontend surface of configuration sync.
 *
 * Mirrors `src-tauri/src/commands/config_sync/`: a config-only snapshot
 * (providers, agent settings, custom agents, quick messages, task templates,
 * whitelisted preferences) that can be written to a single file or pushed to
 * the user's own WebDAV share.
 *
 * Kept out of `api.ts` on purpose — that module is already thousands of lines
 * and this feature has its own vocabulary.
 *
 * Works in both runtimes. Everything WebDAV is runtime-agnostic; the only
 * split is local file transfer, where a local desktop window uses native save
 * and open dialogs and everything else (a browser, or a desktop window pointed
 * at a remote server) moves the document's text through the same command. A
 * config snapshot is tens of KB, so that costs one string — which is why this
 * feature needs none of the upload-staging machinery `backup` uses.
 */

import { isLocalDesktop } from "./platform"
import { getTransport } from "./transport"

/** Stable domain ids, matching `domains::CONFIG_DOMAINS` in Rust. */
export const CONFIG_DOMAIN_IDS = [
  "modelProviders",
  "agentSettings",
  "customAgents",
  "quickMessages",
  "taskTemplates",
  "preferences",
] as const

export type ConfigDomainId = (typeof CONFIG_DOMAIN_IDS)[number]

/** Row counts per domain. A domain missing from an older snapshot is absent,
 *  not zero — the UI must treat `undefined` as "not present in this file". */
export type DomainCounts = Partial<Record<ConfigDomainId, number>> &
  Record<string, number>

export interface ConfigFileMeta {
  size: number
  sha256: string
}

export interface ConfigManifest {
  schemaVersion: number
  encryption: string
  createdAt: string
  appVersion: string
  /** Hostname of the machine that produced the snapshot, so "overwrite with
   *  the remote copy" can say whose copy it is. */
  sourceDevice: string
  config: ConfigFileMeta
  counts: DomainCounts
}

export interface ApplyReport {
  domains: DomainCounts
  total: number
}

export interface ConfigExportSummary {
  path: string
  counts: DomainCounts
}

/**
 * What `config_sync_peek_file` answers for a file the user picked.
 *
 * There is no "previewed but not importable" state: the peek runs the same
 * parser and schema check the import does, so an unreadable file — malformed
 * JSON, a newer schema — comes back as a rejected promise carrying a
 * `configSync.error.*` key, and the caller shows that instead of a dialog.
 * Reaching a preview at all means the file can be applied.
 */
export interface ConfigImportPreview {
  manifest: ConfigManifest
  /** Recomputed from the payload, NOT read back from `manifest.counts`: a
   *  hand-edited file can claim anything there, and the confirmation has to
   *  state what will actually be written. */
  counts: DomainCounts
}

export interface ConfigImportResult {
  applied: ApplyReport
  rollbackPath: string | null
}

export interface ConfigSyncSettingsView {
  enabled: boolean
  serverUrl: string
  username: string
  /** The password itself never crosses the bridge — it lives in the OS
   *  keyring, and this says only whether one is on file. */
  hasPassword: boolean
  /** Wrap the uploaded snapshot in a passphrase-derived AES-256-GCM envelope.
   *  The manifest stays plaintext either way. */
  encrypt: boolean
  hasPassphrase: boolean
  remoteDir: string
  profile: string
  autoSync: boolean
  intervalMinutes: number
}

export interface ConfigSyncSettingsInput {
  enabled: boolean
  serverUrl: string
  username: string
  /** `null` or `""` keeps the stored password. Never send a placeholder —
   *  the backend would store the placeholder verbatim. */
  password: string | null
  /** Same rule. Unlike the password it is not tied to the account, so editing
   *  the server URL does not orphan it. */
  passphrase: string | null
  encrypt: boolean
  remoteDir: string
  profile: string
  autoSync: boolean
  intervalMinutes: number
}

/** One pre-apply snapshot on this machine, as the settings panel lists it. */
export interface RollbackSnapshot {
  /** Opaque; the only value that may be sent back. */
  id: string
  /** `null` when the file name carries no parseable stamp. */
  createdAt: string | null
  size: number
  /** What applying it would write, recounted from the payload. */
  counts: DomainCounts
}

export interface ConfigSyncState {
  lastUploadedSha256: string | null
  /** Which remote the hash above went to. The pair is what suppresses a
   *  redundant upload; the hash alone would also suppress the FIRST upload to
   *  a newly configured server. */
  lastUploadedTarget: string | null
  lastSyncAt: string | null
  lastError: string | null
}

export interface ConfigSyncStatusEvent {
  lastSyncAt: string | null
  lastError: string | null
}

export interface UploadOutcome {
  /** False means the snapshot was identical to the last upload and nothing
   *  was sent — a success, not a failure. */
  uploaded: boolean
  sha256: string
  counts: DomainCounts
  syncedAt: string
}

export interface DownloadOutcome {
  manifest: ConfigManifest
  applied: ApplyReport
  rollbackPath: string | null
}

/** Emitted only by the background uploader; manual actions return their
 *  result directly, so the UI never has to guess what a status refers to. */
export const CONFIG_SYNC_STATUS_EVENT = "config-sync://status"

export const CONFIG_EXPORT_EXTENSION = "codegcfg.json"

/** `codeg-config-2026-05-04-11-32-07.codegcfg.json` — sortable, and obvious
 *  in a downloads folder six months later. */
export function defaultExportFileName(now: Date = new Date()): string {
  const stamp = now.toISOString().slice(0, 19).replace(/[:T]/g, "-")
  return `codeg-config-${stamp}.${CONFIG_EXPORT_EXTENSION}`
}

/** Where an import's bytes are coming from. A local desktop window names a
 *  path the backend reads itself; everything else carries the text. */
export type ConfigImportSource =
  | { kind: "path"; path: string; label: string }
  | { kind: "content"; content: string; label: string }

export interface PickedConfigImport {
  source: ConfigImportSource
  preview: ConfigImportPreview
}

/** The export as text, for the runtimes that save it client-side. */
interface ConfigExportContent {
  content: string
  counts: DomainCounts
}

/** `null` when the user dismissed the save dialog. */
export async function exportConfigToFile(): Promise<ConfigExportSummary | null> {
  const fileName = defaultExportFileName()

  if (!isLocalDesktop()) {
    const built = await getTransport().call<ConfigExportContent>(
      "config_sync_export_content",
      {}
    )
    downloadTextFile(fileName, built.content)
    // The browser owns the destination from here, so the "path" is the name
    // it was offered under — the summary is only ever shown as a toast.
    return { path: fileName, counts: built.counts }
  }

  const { save } = await import("@tauri-apps/plugin-dialog")
  const destPath = await save({
    defaultPath: fileName,
    filters: [{ name: "Codeg config", extensions: ["json"] }],
  })
  if (!destPath) return null
  return getTransport().call<ConfigExportSummary>("config_sync_export_file", {
    destPath,
  })
}

/** Opens a file picker and inspects the choice WITHOUT applying it. `null`
 *  when the dialog was dismissed. */
export async function pickConfigFileToImport(): Promise<PickedConfigImport | null> {
  if (!isLocalDesktop()) {
    const file = await pickLocalFile()
    if (!file) return null
    const content = await file.text()
    const preview = await getTransport().call<ConfigImportPreview>(
      "config_sync_peek_content",
      { content }
    )
    return { source: { kind: "content", content, label: file.name }, preview }
  }

  const { open } = await import("@tauri-apps/plugin-dialog")
  const picked = await open({
    multiple: false,
    directory: false,
    filters: [{ name: "Codeg config", extensions: ["json"] }],
  })
  const srcPath = typeof picked === "string" ? picked : null
  if (!srcPath) return null
  const preview = await getTransport().call<ConfigImportPreview>(
    "config_sync_peek_file",
    { srcPath }
  )
  return { source: { kind: "path", path: srcPath, label: srcPath }, preview }
}

export async function importPickedConfig(
  source: ConfigImportSource
): Promise<ConfigImportResult> {
  if (source.kind === "content") {
    return getTransport().call<ConfigImportResult>(
      "config_sync_import_content",
      { content: source.content }
    )
  }
  return getTransport().call<ConfigImportResult>("config_sync_import_file", {
    srcPath: source.path,
  })
}

/** Newest first. Empty when nothing has ever been imported or restored. */
export async function listConfigRollbacks(): Promise<RollbackSnapshot[]> {
  return getTransport().call<RollbackSnapshot[]>(
    "config_sync_list_rollbacks",
    {}
  )
}

/** Re-apply the configuration captured just before an import or a restore.
 *  Writes its own rollback point first, so the undo is itself undoable. */
export async function applyConfigRollback(
  id: string
): Promise<ConfigImportResult> {
  return getTransport().call<ConfigImportResult>("config_sync_apply_rollback", {
    id,
  })
}

function downloadTextFile(fileName: string, content: string): void {
  const url = URL.createObjectURL(
    new Blob([content], { type: "application/json" })
  )
  const anchor = document.createElement("a")
  anchor.href = url
  anchor.download = fileName
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  // Revoking synchronously can cancel the download in some browsers; one turn
  // of the event loop is enough for the click to have been taken.
  setTimeout(() => URL.revokeObjectURL(url), 0)
}

/** `null` when the picker was dismissed — on the engines that say so.
 *
 *  `cancel` covers current Chrome, Safari and Firefox and nothing else does:
 *  there is no other signal that distinguishes "dialog dismissed" from "dialog
 *  still open". A window-focus fallback is the usual trick and it is wrong
 *  here — a non-modal chooser, or an alt-tab back to the app while the dialog
 *  is open, would settle the promise under a user who then picks a file and
 *  watches nothing happen.
 *
 *  So on an older engine this promise may never settle, and CALLERS MUST NOT
 *  DISABLE ANYTHING WHILE IT IS PENDING. An abandoned promise costs a hidden
 *  input; an abandoned promise the UI is gated on costs the whole panel. */
function pickLocalFile(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input")
    input.type = "file"
    input.accept = ".json,application/json"
    input.style.display = "none"

    let settled = false
    const finish = (file: File | null) => {
      if (settled) return
      settled = true
      input.remove()
      resolve(file)
    }
    input.addEventListener("change", () => finish(input.files?.[0] ?? null))
    input.addEventListener("cancel", () => finish(null))
    document.body.appendChild(input)
    input.click()
  })
}

export async function getConfigSyncSettings(): Promise<ConfigSyncSettingsView> {
  return getTransport().call<ConfigSyncSettingsView>(
    "config_sync_get_settings",
    {}
  )
}

export async function updateConfigSyncSettings(
  settings: ConfigSyncSettingsInput
): Promise<ConfigSyncSettingsView> {
  return getTransport().call<ConfigSyncSettingsView>(
    "config_sync_update_settings",
    { settings }
  )
}

export async function getConfigSyncState(): Promise<ConfigSyncState> {
  return getTransport().call<ConfigSyncState>("config_sync_get_state", {})
}

/** Verifies the form's credentials without saving them. */
export async function testConfigSyncConnection(
  settings: ConfigSyncSettingsInput
): Promise<void> {
  await getTransport().call<null>("config_sync_test_connection", { settings })
}

/** Manual "sync now": uploads even when the hash is unchanged. */
export async function uploadConfigNow(): Promise<UploadOutcome> {
  return getTransport().call<UploadOutcome>("config_sync_upload_now", {})
}

/** `null` when the remote has no snapshot yet. */
export async function peekRemoteConfig(): Promise<ConfigManifest | null> {
  return getTransport().call<ConfigManifest | null>(
    "config_sync_peek_remote",
    {}
  )
}

/** Explicit, never automatic: overwrites local configuration with the remote
 *  snapshot after the user confirms. */
export async function downloadAndApplyConfig(): Promise<DownloadOutcome> {
  return getTransport().call<DownloadOutcome>("config_sync_download_apply", {})
}

export async function listenConfigSyncStatus(
  handler: (event: ConfigSyncStatusEvent) => void
): Promise<() => void> {
  return getTransport().subscribe<ConfigSyncStatusEvent>(
    CONFIG_SYNC_STATUS_EVENT,
    handler
  )
}

/** Domains with at least one row, in the fixed display order. Used by both
 *  the import preview and the post-apply summary so they read alike. */
export function summarizeCounts(counts: DomainCounts): {
  id: ConfigDomainId
  count: number
}[] {
  return CONFIG_DOMAIN_IDS.map((id) => ({ id, count: counts[id] ?? 0 })).filter(
    (entry) => entry.count > 0
  )
}
