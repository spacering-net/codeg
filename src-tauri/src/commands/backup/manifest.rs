//! Backup archive manifest + progress/preview wire types.
//!
//! The manifest describes the *logical* contents of a backup archive: the
//! versions it was taken at, which optional sections it includes, and a
//! per-entry integrity record (size + sha256 of the plaintext bytes). It is
//! written as a single `manifest.json` entry inside the ZIP payload.
//!
//! Encryption metadata is deliberately NOT carried here — it is purely an
//! outer-envelope concern fully described by [`crate::commands::backup::crypto::EnvelopeHeader`].
//! Keeping the manifest crypto-agnostic means the same archive bytes are
//! self-describing whether or not they end up wrapped in the `.codegbak`
//! envelope.

use serde::{Deserialize, Serialize};

/// Bumped only on an incompatible change to the archive layout / manifest
/// shape. Restores reject any archive whose `format_version` exceeds this.
///
/// **2** — the archive gained the codeg-owned sections beyond `uploads`
/// (`acp-transcripts/`, `pets/`, `skills/`, …) and one self-contained file per
/// third-party SQLite store. Structurally a v1 reader could parse it: the new
/// manifest fields are additive and serde ignores what it does not know. But
/// it would restore the database, silently drop every section it has no live
/// path for, delete staging, and report success — handing back conversations
/// whose messages are gone, which is precisely the loss this format exists to
/// fix. Bumping turns that into an up-front "this backup is newer than this
/// version of codeg" refusal. Reading OLDER archives is unaffected; the gate
/// is `manifest.format_version > BACKUP_FORMAT_VERSION`.
pub const BACKUP_FORMAT_VERSION: u32 = 2;

/// Magic discriminator stored in every manifest so a stray ZIP can't be
/// mistaken for a codeg backup.
pub const BACKUP_KIND: &str = "codeg-backup";

/// Fixed entry name of the manifest inside the archive.
pub const MANIFEST_ENTRY_NAME: &str = "manifest.json";

/// Progress channel both runtimes emit on (Tauri webview + WS broadcaster).
pub const BACKUP_PROGRESS_EVENT: &str = "backup://progress";

/// Per-file integrity record. `sha256` is the lowercase-hex digest of the
/// plaintext file bytes (before compression / encryption).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ManifestEntry {
    pub path: String,
    pub size: u64,
    pub sha256: String,
}

/// Logical description of a backup archive's contents. Serialized camelCase to
/// match the rest of the wire format (and the in-archive `manifest.json`).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupManifest {
    /// Archive layout version — see [`BACKUP_FORMAT_VERSION`].
    pub format_version: u32,
    /// Always [`BACKUP_KIND`]; a cheap "is this ours" check on read.
    pub kind: String,
    /// RFC3339 timestamp the backup was created at.
    pub created_at: String,
    /// `CARGO_PKG_VERSION` of the binary that produced the backup.
    pub app_version: String,
    /// Name of the newest applied DB migration at backup time. Used as the
    /// schema-compatibility contract on restore (more robust than semver).
    pub latest_migration: String,
    /// `"desktop"` | `"server"` — informational.
    pub runtime: String,
    /// Whether `external/<agent>/` transcript trees are present.
    pub includes_external_transcripts: bool,
    /// Whether the archive contains plaintext secrets (API keys / tokens).
    /// Always true today; drives the UI "contains secrets" warning when the
    /// backup is unencrypted.
    pub includes_secrets: bool,
    /// Which codeg-owned sections (see
    /// [`crate::commands::backup::sections::MANAGED_SECTIONS`]) this archive
    /// claims to manage — i.e. which live trees a restore is allowed to
    /// replace wholesale. `None` on archives written before the field existed;
    /// those are normalized to
    /// [`crate::commands::backup::sections::LEGACY_SECTION_IDS`] so restoring
    /// one can never clear a section its format never knew about.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub managed_sections: Option<Vec<String>>,
    /// Agents whose third-party SQLite session store could not be snapshotted
    /// through the normal read-only page copy. Surfaced in the UI so a degraded
    /// backup is never reported as a clean one.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub degraded_sqlite: Vec<DegradedSqlite>,
    /// Per-entry size + checksum, excluding the manifest itself.
    pub entries: Vec<ManifestEntry>,
}

/// How badly one third-party SQLite store degraded during backup.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SqliteDegradation {
    /// The store could not be opened read-only, so it was recovered on a
    /// private copy first. The archived snapshot is still complete.
    RecoveredOnCopy,
    /// Recovery on the private copy failed; only the bare main DB file was
    /// archived, so frames that lived solely in the WAL are missing.
    BareFileOnly,
    /// The store kept changing under us (or could not be copied at all), so
    /// nothing was archived for it rather than archiving a torn copy.
    NotArchived,
}

/// One degraded third-party SQLite store, reported per agent + store path.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DegradedSqlite {
    /// `ExternalSource::agent` — the archive/UI-facing agent name.
    pub agent: String,
    /// Archive-relative path of the store (`external/<agent>/…`), so the UI can
    /// tell apart the hundreds of per-session stores Cursor keeps.
    pub archive_path: String,
    pub level: SqliteDegradation,
}

impl BackupManifest {
    /// Total uncompressed byte size of all recorded entries.
    pub fn total_bytes(&self) -> u64 {
        self.entries.iter().map(|e| e.size).sum()
    }
}

/// Coarse phase of a backup or restore operation, surfaced to the UI.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum BackupPhase {
    Snapshotting,
    Archiving,
    Encrypting,
    Decrypting,
    Extracting,
    Verifying,
    Swapping,
    Done,
    Cancelled,
    Error,
}

/// Progress event payload, emitted on [`BACKUP_PROGRESS_EVENT`].
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupProgress {
    pub op_id: String,
    pub phase: BackupPhase,
    pub processed_bytes: u64,
    pub total_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl BackupProgress {
    pub fn phase(op_id: &str, phase: BackupPhase) -> Self {
        Self {
            op_id: op_id.to_string(),
            phase,
            processed_bytes: 0,
            total_bytes: None,
            current_path: None,
            error: None,
        }
    }
}

/// Result of validating a candidate backup before applying it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupPreview {
    /// The archive is wrapped in the encrypted `.codegbak` envelope.
    pub encrypted: bool,
    /// Encrypted, but no (or no usable) passphrase was supplied, so the
    /// manifest could not be read yet. The UI should prompt for a passphrase.
    pub needs_passphrase: bool,
    /// Present once the manifest could be read (plaintext archive, or
    /// encrypted archive with a correct passphrase).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub manifest: Option<BackupManifest>,
    /// Whether this backup can be restored by the current binary.
    pub compatible: bool,
    /// i18n key explaining why `compatible == false` (e.g. a newer-version or
    /// unknown-format backup). `None` when compatible or still locked.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reject_reason: Option<String>,
}
