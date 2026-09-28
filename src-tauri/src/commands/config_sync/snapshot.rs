//! Snapshot assembly, validation, and application.
//!
//! A snapshot is two files that always travel together:
//!
//! * `config.json` — `{ schemaVersion, domains: { <domain id>: <payload> } }`,
//!   produced by iterating [`CONFIG_DOMAINS`].
//! * `manifest.json` — provenance (who wrote it, when, with which app
//!   version) plus the size and sha256 of `config.json`.
//!
//! The manifest is what makes a half-finished upload detectable: WebDAV has no
//! multi-file transaction, so a reader that finds a `config.json` whose bytes
//! do not match the manifest checksum refuses it instead of applying a
//! truncated configuration.
//!
//! Application is one transaction over all domains. A domain that fails to
//! decode aborts the whole apply — half-applied settings ("providers moved
//! over but the agents still point at the old ones") are worse than no apply.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use chrono::Utc;
use sea_orm::{DatabaseConnection, TransactionTrait};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

use super::domains::{count_entries, CONFIG_DOMAINS};
use crate::app_error::{
    AppCommandError, CONFIG_SYNC_I18N_KEY_BAD_DOMAIN, CONFIG_SYNC_I18N_KEY_CHECKSUM,
    CONFIG_SYNC_I18N_KEY_INVALID_SNAPSHOT, CONFIG_SYNC_I18N_KEY_NEWER_SCHEMA,
    CONFIG_SYNC_I18N_KEY_NO_ROLLBACK,
};

/// Bump only for a change older binaries cannot read. Adding a domain does not
/// qualify: unknown domains are ignored on read and missing domains decode as
/// empty, so both directions already degrade gracefully.
pub const SCHEMA_VERSION: u32 = 1;

/// The default. The security boundary is then the user's own
/// self-authenticated WebDAV endpoint, which is a real one for a self-hosted
/// share and a weaker one on a hosted drive — hence the opt-in below.
pub const ENCRYPTION_NONE: &str = "none";
/// Opt-in passphrase encryption ([`super::crypto`]). The manifest stays
/// plaintext either way, so "whose copy is on the remote, from when" is
/// readable without the passphrase; only `config.json` is wrapped.
pub const ENCRYPTION_AES_GCM: &str = "aes-256-gcm";

pub const CONFIG_FILE_NAME: &str = "config.json";
pub const MANIFEST_FILE_NAME: &str = "manifest.json";

/// How many pre-apply rollback snapshots to keep on disk. They are tens of KB
/// each; ten is roughly "the last few times I pulled config down".
const ROLLBACK_KEEP: usize = 10;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigSnapshot {
    pub schema_version: u32,
    /// Domain id → payload. A map, not a struct with one field per domain, so
    /// [`CONFIG_DOMAINS`] stays the only place a domain is declared.
    #[serde(default)]
    pub domains: BTreeMap<String, Value>,
}

impl ConfigSnapshot {
    /// Entry count per domain, for the manifest and for the import preview.
    pub fn counts(&self) -> BTreeMap<String, usize> {
        self.domains
            .iter()
            .map(|(id, value)| (id.clone(), count_entries(id, value)))
            .collect()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigFileMeta {
    pub size: u64,
    pub sha256: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigManifest {
    pub schema_version: u32,
    pub encryption: String,
    /// RFC 3339, UTC.
    pub created_at: String,
    pub app_version: String,
    /// Best-effort hostname, so a user staring at "last synced from" can tell
    /// which machine wrote the snapshot.
    pub source_device: String,
    pub config: ConfigFileMeta,
    #[serde(default)]
    pub counts: BTreeMap<String, usize>,
}

/// What an apply actually changed, per domain.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyReport {
    pub domains: BTreeMap<String, usize>,
    pub total: usize,
}

/// Read every domain out of the local database.
pub async fn collect_snapshot_core(
    conn: &DatabaseConnection,
) -> Result<ConfigSnapshot, AppCommandError> {
    let mut domains = BTreeMap::new();
    for domain in CONFIG_DOMAINS {
        let value = (domain.collect)(conn).await?;
        domains.insert(domain.id.to_string(), value);
    }
    Ok(ConfigSnapshot {
        schema_version: SCHEMA_VERSION,
        domains,
    })
}

/// Upsert every domain the snapshot carries, in [`CONFIG_DOMAINS`] order, in a
/// single transaction. Domains this binary does not know are ignored — a
/// snapshot from a newer build stays partially usable.
pub async fn apply_snapshot_core(
    conn: &DatabaseConnection,
    snapshot: &ConfigSnapshot,
) -> Result<ApplyReport, AppCommandError> {
    reject_newer_schema(snapshot.schema_version)?;

    for id in snapshot.domains.keys() {
        if !CONFIG_DOMAINS.iter().any(|d| d.id == id) {
            tracing::warn!("[CONFIG-SYNC] ignoring unknown snapshot domain '{id}'");
        }
    }

    let tx = conn.begin().await.map_err(|e| {
        AppCommandError::database_error("Begin config apply").with_detail(e.to_string())
    })?;

    let mut report = ApplyReport::default();
    for domain in CONFIG_DOMAINS {
        let Some(value) = snapshot.domains.get(domain.id) else {
            continue;
        };
        match (domain.apply)(&tx, value).await {
            Ok(applied) => {
                report.total += applied;
                report.domains.insert(domain.id.to_string(), applied);
            }
            Err(err) => {
                // Roll back explicitly so the failure surfaces as the domain's
                // error rather than as a dropped-transaction warning.
                let _ = tx.rollback().await;
                return Err(err);
            }
        }
    }

    tx.commit().await.map_err(|e| {
        AppCommandError::database_error("Commit config apply").with_detail(e.to_string())
    })?;
    Ok(report)
}

/// Pretty-printed on purpose: the file is the user's own configuration sitting
/// on their own storage, and a readable diff is worth the extra bytes. The
/// checksum is taken over exactly these bytes.
pub fn serialize_snapshot(snapshot: &ConfigSnapshot) -> Result<Vec<u8>, AppCommandError> {
    serde_json::to_vec_pretty(snapshot).map_err(|e| {
        AppCommandError::task_execution_failed("Serialize config snapshot")
            .with_detail(e.to_string())
    })
}

pub fn parse_snapshot(bytes: &[u8]) -> Result<ConfigSnapshot, AppCommandError> {
    let snapshot: ConfigSnapshot = serde_json::from_slice(bytes).map_err(|e| {
        AppCommandError::invalid_input("Not a codeg config snapshot")
            .with_detail(e.to_string())
            .with_i18n(CONFIG_SYNC_I18N_KEY_INVALID_SNAPSHOT, BTreeMap::new())
    })?;
    reject_newer_schema(snapshot.schema_version)?;
    validate_domains(&snapshot)?;
    Ok(snapshot)
}

/// Dry-decode every domain the snapshot carries, without a database.
///
/// Called from [`parse_snapshot`], which is the single door every snapshot
/// enters through — file import, WebDAV download, and rollback alike — so a
/// payload that would abort halfway through an apply is refused before the
/// preview is even drawn. Without it the envelope's JSON being well-formed was
/// the only thing checked, and a hand-edited file could confirm "3 providers,
/// 2 agents" and then fail on the agents with the providers already written.
///
/// Domains this binary does not know are skipped, matching
/// [`apply_snapshot_core`]: a snapshot from a newer build stays partially
/// usable, and refusing it here would be stricter than the apply it guards.
pub fn validate_domains(snapshot: &ConfigSnapshot) -> Result<(), AppCommandError> {
    for domain in CONFIG_DOMAINS {
        let Some(value) = snapshot.domains.get(domain.id) else {
            continue;
        };
        (domain.validate)(value).map_err(|err| {
            let mut params = BTreeMap::new();
            params.insert("domain".to_string(), domain.id.to_string());
            err.with_i18n(CONFIG_SYNC_I18N_KEY_BAD_DOMAIN, params)
        })?;
    }
    Ok(())
}

pub fn parse_manifest(bytes: &[u8]) -> Result<ConfigManifest, AppCommandError> {
    serde_json::from_slice(bytes).map_err(|e| {
        AppCommandError::invalid_input("Not a codeg config manifest")
            .with_detail(e.to_string())
            .with_i18n(CONFIG_SYNC_I18N_KEY_INVALID_SNAPSHOT, BTreeMap::new())
    })
}

/// `config_bytes` must be the bytes that are actually written out — the
/// ciphertext when `encryption` is not [`ENCRYPTION_NONE`]. The checksum's job
/// is detecting a truncated transfer, so it has to cover what was transferred.
pub fn build_manifest(
    config_bytes: &[u8],
    app_version: &str,
    counts: BTreeMap<String, usize>,
    encryption: &str,
) -> ConfigManifest {
    ConfigManifest {
        schema_version: SCHEMA_VERSION,
        encryption: encryption.to_string(),
        created_at: Utc::now().to_rfc3339(),
        app_version: app_version.to_string(),
        source_device: source_device(),
        config: ConfigFileMeta {
            size: config_bytes.len() as u64,
            sha256: sha256_hex(config_bytes),
        },
        counts,
    }
}

/// Everything that must hold before a downloaded `config.json` is parsed: the
/// format is one we can read, and the bytes are the ones the writer finished
/// writing.
pub fn validate_manifest(
    manifest: &ConfigManifest,
    config_bytes: &[u8],
) -> Result<(), AppCommandError> {
    reject_newer_schema(manifest.schema_version)?;

    if !matches!(
        manifest.encryption.as_str(),
        ENCRYPTION_NONE | ENCRYPTION_AES_GCM
    ) {
        return Err(AppCommandError::invalid_input(format!(
            "Unsupported snapshot encryption '{}'",
            manifest.encryption
        ))
        .with_i18n(CONFIG_SYNC_I18N_KEY_INVALID_SNAPSHOT, BTreeMap::new()));
    }

    if manifest.config.size != config_bytes.len() as u64 {
        return Err(checksum_error());
    }
    if !manifest
        .config
        .sha256
        .eq_ignore_ascii_case(&sha256_hex(config_bytes))
    {
        return Err(checksum_error());
    }
    Ok(())
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}

fn checksum_error() -> AppCommandError {
    AppCommandError::invalid_input("Config snapshot failed its checksum")
        .with_i18n(CONFIG_SYNC_I18N_KEY_CHECKSUM, BTreeMap::new())
}

fn reject_newer_schema(schema_version: u32) -> Result<(), AppCommandError> {
    if schema_version > SCHEMA_VERSION {
        let mut params = BTreeMap::new();
        params.insert("snapshotVersion".to_string(), schema_version.to_string());
        params.insert("appVersion".to_string(), SCHEMA_VERSION.to_string());
        return Err(AppCommandError::invalid_input(
            "Config snapshot was written by a newer version of codeg",
        )
        .with_i18n(CONFIG_SYNC_I18N_KEY_NEWER_SCHEMA, params));
    }
    Ok(())
}

/// Best-effort machine name, for the "restore the snapshot from {device}?"
/// confirmation.
///
/// `COMPUTERNAME` is genuinely set for every Windows process, but its unix
/// counterpart `HOSTNAME` is a shell variable that is never exported, so an
/// env-only lookup answers "unknown" on every macOS and Linux desktop — i.e.
/// exactly where the label is supposed to earn its keep. `gethostname(2)` is
/// one already-vendored `libc` call away (`libc` is a unix-only dependency of
/// this crate) and needs no new crate.
fn source_device() -> String {
    resolve_device_name(env_device_name(), host_name())
}

/// Pure, so the precedence and the fallback are testable without touching the
/// process environment (which other tests in this crate mutate).
fn resolve_device_name(from_env: Option<String>, from_host: Option<String>) -> String {
    from_env
        .or(from_host)
        .unwrap_or_else(|| "unknown".to_string())
}

#[cfg(unix)]
fn host_name() -> Option<String> {
    unix_hostname()
}

/// Windows has no `gethostname` in the crate's dependency set and does not
/// need one: `COMPUTERNAME` is set for every process there.
#[cfg(not(unix))]
fn host_name() -> Option<String> {
    None
}

fn env_device_name() -> Option<String> {
    for key in ["COMPUTERNAME", "HOSTNAME"] {
        if let Ok(value) = std::env::var(key) {
            let value = value.trim().to_string();
            if !value.is_empty() {
                return Some(value);
            }
        }
    }
    None
}

/// `gethostname` truncates silently and is not required to NUL-terminate when
/// it does, so the buffer is over-sized (POSIX caps `HOST_NAME_MAX` far below
/// this) and the result is read up to the first NUL rather than assuming one.
#[cfg(unix)]
fn unix_hostname() -> Option<String> {
    let mut buffer = vec![0u8; 256];
    // SAFETY: `gethostname` writes at most `len` bytes into `buffer`, which
    // owns that many.
    let rc = unsafe { libc::gethostname(buffer.as_mut_ptr() as *mut libc::c_char, buffer.len()) };
    if rc != 0 {
        return None;
    }
    let end = buffer.iter().position(|b| *b == 0).unwrap_or(buffer.len());
    let name = String::from_utf8_lossy(&buffer[..end]).trim().to_string();
    (!name.is_empty()).then_some(name)
}

/// Where pre-apply rollback snapshots live.
pub fn rollback_dir() -> PathBuf {
    crate::paths::codeg_home_dir().join("config-snapshots")
}

/// Write "what this machine looked like before the apply" next to the app's
/// own data, then prune to [`ROLLBACK_KEEP`]. Synchronous: the payload is tens
/// of KB, so the blocking write is shorter than the cost of a thread hop.
///
/// Failure is reported to the caller but must never be treated as fatal by it
/// — losing the safety net is worse than not having one, but not as bad as
/// refusing to apply a configuration the user explicitly asked for.
pub fn write_rollback_snapshot(
    dir: &Path,
    snapshot: &ConfigSnapshot,
) -> Result<PathBuf, AppCommandError> {
    std::fs::create_dir_all(dir).map_err(AppCommandError::io)?;
    let bytes = serialize_snapshot(snapshot)?;
    // Sortable, second-resolution + a millisecond suffix so two applies in the
    // same second do not collide.
    let name = format!("config-{}.json", Utc::now().format("%Y%m%dT%H%M%S%3f"));
    let path = dir.join(name);
    std::fs::write(&path, &bytes).map_err(AppCommandError::io)?;
    prune_rollback_snapshots(dir, ROLLBACK_KEEP);
    Ok(path)
}

/// Newest first.
pub fn list_rollback_snapshots(dir: &Path) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut files: Vec<PathBuf> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| {
            p.is_file()
                && p.file_name()
                    .and_then(|n| n.to_str())
                    .is_some_and(|n| n.starts_with("config-") && n.ends_with(".json"))
        })
        .collect();
    // Names are timestamp-ordered, so lexicographic order IS chronological
    // order — no filesystem mtime involved, which keeps this stable across
    // copies and restores.
    files.sort();
    files.reverse();
    files
}

fn prune_rollback_snapshots(dir: &Path, keep: usize) {
    for path in list_rollback_snapshots(dir).into_iter().skip(keep) {
        if let Err(err) = std::fs::remove_file(&path) {
            tracing::warn!("[CONFIG-SYNC] failed to prune rollback snapshot: {err}");
        }
    }
}

/// One rollback snapshot, as the settings panel lists it.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RollbackSnapshotInfo {
    /// The file stem (`config-20260917T101530123`). Opaque to the frontend and
    /// the only value it may hand back — [`resolve_rollback`] refuses anything
    /// that is not exactly this shape, so the id can never become a path.
    pub id: String,
    /// RFC 3339, recovered from the id. `None` for a file whose name does not
    /// carry a parseable stamp; the UI falls back to the id itself.
    pub created_at: Option<String>,
    pub size: u64,
    /// What applying it would write, recounted from the payload.
    pub counts: BTreeMap<String, usize>,
}

/// Newest first, skipping any file that no longer parses — a snapshot that
/// cannot be read cannot be applied either, and listing it would only offer the
/// user a button that fails.
pub fn list_rollback_infos(dir: &Path) -> Vec<RollbackSnapshotInfo> {
    let mut infos = Vec::new();
    for path in list_rollback_snapshots(dir) {
        let Some(id) = rollback_id(&path) else {
            continue;
        };
        let bytes = match std::fs::read(&path) {
            Ok(bytes) => bytes,
            Err(err) => {
                tracing::warn!("[CONFIG-SYNC] rollback snapshot unreadable: {err}");
                continue;
            }
        };
        let Ok(snapshot) = parse_snapshot(&bytes) else {
            tracing::warn!("[CONFIG-SYNC] rollback snapshot does not parse: {}", id);
            continue;
        };
        infos.push(RollbackSnapshotInfo {
            created_at: created_at_from_id(&id),
            size: bytes.len() as u64,
            counts: snapshot.counts(),
            id,
        });
    }
    infos
}

/// The one definition of what an id looks like, shared by the lister and the
/// resolver. Splitting it in two is how a list ends up offering a Restore
/// button that the resolver then refuses: a file-manager copy that renames
/// collisions produces `config-20260917T101530123 (1).json`, whose stem parses
/// fine but is not an id this code will ever join to a path.
fn is_rollback_id(id: &str) -> bool {
    id.strip_prefix("config-")
        .is_some_and(|stamp| !stamp.is_empty() && stamp.bytes().all(|b| b.is_ascii_alphanumeric()))
}

fn rollback_id(path: &Path) -> Option<String> {
    path.file_stem()
        .and_then(|stem| stem.to_str())
        .filter(|stem| is_rollback_id(stem))
        .map(|stem| stem.to_string())
}

/// The names [`write_rollback_snapshot`] produces are `config-` plus a UTC
/// `%Y%m%dT%H%M%S%3f` stamp, so the timestamp is recoverable without trusting
/// the filesystem's mtime (which a copy or a restore would rewrite).
fn created_at_from_id(id: &str) -> Option<String> {
    let stamp = id.strip_prefix("config-")?;
    chrono::NaiveDateTime::parse_from_str(stamp, "%Y%m%dT%H%M%S%3f")
        .ok()
        .map(|naive| naive.and_utc().to_rfc3339())
}

/// Map an id from [`list_rollback_infos`] back to its file.
///
/// The id arrives from the frontend, so it is validated rather than trusted:
/// only the exact alphabet [`write_rollback_snapshot`] emits is accepted, which
/// leaves no way to express a separator, a parent link, or an extension and so
/// no way for the join below to leave `dir`.
pub fn resolve_rollback(dir: &Path, id: &str) -> Result<PathBuf, AppCommandError> {
    if !is_rollback_id(id) {
        return Err(missing_rollback_error());
    }
    let path = dir.join(format!("{id}.json"));
    if !path.is_file() {
        return Err(missing_rollback_error());
    }
    Ok(path)
}

fn missing_rollback_error() -> AppCommandError {
    AppCommandError::not_found("That rollback snapshot is no longer on this machine")
        .with_i18n(CONFIG_SYNC_I18N_KEY_NO_ROLLBACK, BTreeMap::new())
}

pub fn read_rollback(path: &Path) -> Result<ConfigSnapshot, AppCommandError> {
    let bytes = std::fs::read(path).map_err(AppCommandError::io)?;
    parse_snapshot(&bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::entities::{agent_setting, custom_agent, model_provider, quick_message};
    use crate::db::service::app_metadata_service;
    use crate::db::test_helpers::fresh_in_memory_db;
    use sea_orm::{ActiveModelTrait, ActiveValue::NotSet, EntityTrait, Set};

    async fn seed_source(conn: &DatabaseConnection) {
        let now = Utc::now();
        let provider = model_provider::ActiveModel {
            id: NotSet,
            name: Set("DeepSeek".to_string()),
            api_url: Set("https://api.deepseek.com".to_string()),
            api_key: Set("sk-secret".to_string()),
            agent_types_json: Set("[\"deepseek\"]".to_string()),
            agent_type: Set("deepseek".to_string()),
            model: Set(Some("deepseek-chat".to_string())),
            created_at: Set(now),
            updated_at: Set(now),
        }
        .insert(conn)
        .await
        .expect("insert provider");

        agent_setting::ActiveModel {
            id: NotSet,
            agent_type: Set("deepseek".to_string()),
            registry_id: Set("deepseek".to_string()),
            enabled: Set(true),
            sort_order: Set(3),
            installed_version: Set(Some("1.2.3-local".to_string())),
            env_json: Set(Some("{\"FOO\":\"bar\"}".to_string())),
            model_provider_id: Set(Some(provider.id)),
            created_at: Set(now),
            updated_at: Set(now),
        }
        .insert(conn)
        .await
        .expect("insert agent setting");

        quick_message::ActiveModel {
            id: NotSet,
            title: Set("Review".to_string()),
            content: Set("Please review this diff".to_string()),
            sort_order: Set(1),
            created_at: Set(now),
            updated_at: Set(now),
        }
        .insert(conn)
        .await
        .expect("insert quick message");

        app_metadata_service::upsert_value(conn, "appearance_mode", "dark")
            .await
            .expect("portable pref");
        app_metadata_service::upsert_value(conn, "web_service_token", "device-local-token")
            .await
            .expect("device-local pref");
    }

    #[tokio::test]
    async fn snapshot_round_trips_into_a_second_database() {
        let source = fresh_in_memory_db().await;
        seed_source(&source.conn).await;

        let snapshot = collect_snapshot_core(&source.conn).await.expect("collect");
        let bytes = serialize_snapshot(&snapshot).expect("serialize");
        let parsed = parse_snapshot(&bytes).expect("parse");

        let target = fresh_in_memory_db().await;
        let report = apply_snapshot_core(&target.conn, &parsed)
            .await
            .expect("apply");
        assert!(report.total >= 4, "unexpected apply report: {report:?}");

        let providers = model_provider::Entity::find()
            .all(&target.conn)
            .await
            .expect("providers");
        assert_eq!(providers.len(), 1);
        assert_eq!(providers[0].api_key, "sk-secret");

        let settings = agent_setting::Entity::find()
            .all(&target.conn)
            .await
            .expect("settings");
        assert_eq!(settings.len(), 1);
        // The provider reference was remapped to the TARGET machine's row id.
        assert_eq!(settings[0].model_provider_id, Some(providers[0].id));
        // Device-local: the source machine's installed CLI version must not
        // travel, or the target would skip its own install/upgrade prompt.
        assert_eq!(settings[0].installed_version, None);

        let messages = quick_message::Entity::find()
            .all(&target.conn)
            .await
            .expect("quick messages");
        assert_eq!(messages.len(), 1);

        assert_eq!(
            app_metadata_service::get_value(&target.conn, "appearance_mode")
                .await
                .expect("pref"),
            Some("dark".to_string())
        );
    }

    #[tokio::test]
    async fn device_local_preferences_never_enter_a_snapshot() {
        let source = fresh_in_memory_db().await;
        seed_source(&source.conn).await;

        let snapshot = collect_snapshot_core(&source.conn).await.expect("collect");
        let prefs = snapshot.domains.get("preferences").expect("preferences");
        assert!(prefs.get("appearance_mode").is_some());
        assert!(
            prefs.get("web_service_token").is_none(),
            "device-local key leaked into the snapshot: {prefs}"
        );
    }

    /// A hand-edited or hostile snapshot must not be able to write a key the
    /// allowlist excludes — the collect-side filter is not the only guard.
    #[tokio::test]
    async fn applying_a_doctored_preference_key_is_ignored() {
        let target = fresh_in_memory_db().await;
        let snapshot = ConfigSnapshot {
            schema_version: SCHEMA_VERSION,
            domains: BTreeMap::from([(
                "preferences".to_string(),
                serde_json::json!({
                    "appearance_mode": "light",
                    "web_service_token": "stolen",
                    "config_sync_settings": "{}"
                }),
            )]),
        };

        apply_snapshot_core(&target.conn, &snapshot)
            .await
            .expect("apply");

        assert_eq!(
            app_metadata_service::get_value(&target.conn, "appearance_mode")
                .await
                .expect("pref"),
            Some("light".to_string())
        );
        for key in ["web_service_token", "config_sync_settings"] {
            assert_eq!(
                app_metadata_service::get_value(&target.conn, key)
                    .await
                    .expect("pref"),
                None,
                "{key} must not be writable from a snapshot"
            );
        }
    }

    /// Re-applying the same snapshot must converge, not duplicate: the whole
    /// point of natural-key upserts.
    #[tokio::test]
    async fn applying_twice_updates_instead_of_duplicating() {
        let source = fresh_in_memory_db().await;
        seed_source(&source.conn).await;
        let snapshot = collect_snapshot_core(&source.conn).await.expect("collect");

        let target = fresh_in_memory_db().await;
        apply_snapshot_core(&target.conn, &snapshot)
            .await
            .expect("first apply");
        apply_snapshot_core(&target.conn, &snapshot)
            .await
            .expect("second apply");

        assert_eq!(
            model_provider::Entity::find()
                .all(&target.conn)
                .await
                .expect("providers")
                .len(),
            1
        );
        assert_eq!(
            quick_message::Entity::find()
                .all(&target.conn)
                .await
                .expect("messages")
                .len(),
            1
        );
    }

    /// Rows the snapshot does not mention are the user's local work; an apply
    /// is an upsert, never a mirror.
    #[tokio::test]
    async fn local_only_rows_survive_an_apply() {
        let target = fresh_in_memory_db().await;
        let now = Utc::now();
        quick_message::ActiveModel {
            id: NotSet,
            title: Set("Local only".to_string()),
            content: Set("keep me".to_string()),
            sort_order: Set(9),
            created_at: Set(now),
            updated_at: Set(now),
        }
        .insert(&target.conn)
        .await
        .expect("seed local");

        let source = fresh_in_memory_db().await;
        seed_source(&source.conn).await;
        let snapshot = collect_snapshot_core(&source.conn).await.expect("collect");
        apply_snapshot_core(&target.conn, &snapshot)
            .await
            .expect("apply");

        let titles: Vec<String> = quick_message::Entity::find()
            .all(&target.conn)
            .await
            .expect("messages")
            .into_iter()
            .map(|m| m.title)
            .collect();
        assert!(titles.contains(&"Local only".to_string()));
        assert!(titles.contains(&"Review".to_string()));
    }

    /// `skills_dir` is an absolute path on the machine that owns it.
    #[tokio::test]
    async fn custom_agent_skills_dir_stays_local() {
        let target = fresh_in_memory_db().await;
        let now = Utc::now();
        custom_agent::ActiveModel {
            id: NotSet,
            registry_id: Set("acme".to_string()),
            name: Set("Acme".to_string()),
            description: Set(String::new()),
            version: Set("1.0.0".to_string()),
            distribution_kind: Set("npm".to_string()),
            spec_json: Set("{}".to_string()),
            icon_url: Set(None),
            skills_shared_store: Set(false),
            skills_dir: Set(Some("D:/local/skills".to_string())),
            source: Set("user".to_string()),
            version_probe: Set(None),
            supports_mcp: Set(false),
            created_at: Set(now),
            updated_at: Set(now),
        }
        .insert(&target.conn)
        .await
        .expect("seed agent");

        let snapshot = ConfigSnapshot {
            schema_version: SCHEMA_VERSION,
            domains: BTreeMap::from([(
                "customAgents".to_string(),
                serde_json::json!([{
                    "registryId": "acme",
                    "name": "Acme Renamed",
                    "version": "2.0.0",
                    "distributionKind": "npm",
                    "specJson": "{}",
                    "skillsDir": "/somewhere/else"
                }]),
            )]),
        };
        apply_snapshot_core(&target.conn, &snapshot)
            .await
            .expect("apply");

        let row = custom_agent::Entity::find()
            .all(&target.conn)
            .await
            .expect("agents")
            .remove(0);
        assert_eq!(row.name, "Acme Renamed");
        assert_eq!(row.skills_dir, Some("D:/local/skills".to_string()));
    }

    #[test]
    fn manifest_validates_matching_bytes_and_rejects_tampering() {
        let snapshot = ConfigSnapshot {
            schema_version: SCHEMA_VERSION,
            domains: BTreeMap::from([("preferences".to_string(), serde_json::json!({}))]),
        };
        let bytes = serialize_snapshot(&snapshot).expect("serialize");
        let manifest = build_manifest(&bytes, "1.0.0", snapshot.counts(), ENCRYPTION_NONE);

        validate_manifest(&manifest, &bytes).expect("matching bytes validate");

        let mut tampered = bytes.clone();
        tampered.extend_from_slice(b"\n");
        let err = validate_manifest(&manifest, &tampered).expect_err("must reject");
        assert_eq!(
            err.i18n_key.as_deref(),
            Some(CONFIG_SYNC_I18N_KEY_CHECKSUM)
        );
    }

    #[test]
    fn a_newer_schema_is_refused_rather_than_guessed_at() {
        let bytes = serde_json::to_vec(&serde_json::json!({
            "schemaVersion": SCHEMA_VERSION + 1,
            "domains": {}
        }))
        .expect("bytes");
        let err = parse_snapshot(&bytes).expect_err("must refuse");
        assert_eq!(
            err.i18n_key.as_deref(),
            Some(CONFIG_SYNC_I18N_KEY_NEWER_SCHEMA)
        );
    }

    #[test]
    fn the_source_device_label_is_never_empty_or_ragged() {
        let device = source_device();
        assert!(!device.is_empty());
        assert!(!device.contains('\0'), "raw buffer leaked: {device:?}");
        assert_eq!(device.trim(), device);
    }

    /// Regression: the label was read from `COMPUTERNAME`/`HOSTNAME` only.
    /// `HOSTNAME` is a shell variable that is never exported, so on every
    /// macOS and Linux desktop the lookup fell through and each snapshot was
    /// signed "unknown" — the one fact the restore confirmation exists to
    /// tell the user.
    #[test]
    fn the_host_name_is_used_when_the_environment_is_silent() {
        assert_eq!(
            resolve_device_name(None, Some("work-laptop".to_string())),
            "work-laptop"
        );
        // Env still wins where it is actually populated (Windows).
        assert_eq!(
            resolve_device_name(Some("DESKTOP-42".to_string()), Some("other".to_string())),
            "DESKTOP-42"
        );
        assert_eq!(resolve_device_name(None, None), "unknown");
    }

    /// The wiring half of the same regression: the pure resolver above proves
    /// the precedence, this proves `source_device` is actually plugged into a
    /// host-name source. No env is mutated — the assertion simply stands down
    /// on the (rare) shell that does export `HOSTNAME`, where the env branch
    /// is the one under test anyway.
    #[cfg(unix)]
    #[test]
    fn a_unix_desktop_is_not_signed_unknown() {
        if env_device_name().is_some() {
            return;
        }
        assert_ne!(source_device(), "unknown");
    }

    #[cfg(unix)]
    #[test]
    fn gethostname_answers_and_is_cut_at_the_nul() {
        let name = unix_hostname().expect("gethostname must answer on a unix host");
        assert!(!name.is_empty());
        assert!(
            !name.contains('\0'),
            "buffer was not cut at the NUL: {name:?}"
        );
    }

    /// Regression: the envelope parsing alone let a payload through that the
    /// applier would abort on, so the confirmation dialog promised rows it
    /// could not write. The refusal has to happen at parse time, which is the
    /// step both the file import and the WebDAV download go through.
    #[test]
    fn a_domain_that_would_abort_the_apply_is_refused_at_parse_time() {
        let bytes = serde_json::to_vec(&serde_json::json!({
            "schemaVersion": SCHEMA_VERSION,
            "domains": {
                "quickMessages": [{ "title": "fine", "content": "body" }],
                "modelProviders": "hand-edited into nonsense"
            }
        }))
        .expect("bytes");

        let err = parse_snapshot(&bytes).expect_err("must refuse");
        assert_eq!(err.i18n_key.as_deref(), Some(CONFIG_SYNC_I18N_KEY_BAD_DOMAIN));
        assert_eq!(
            err.i18n_params
                .as_ref()
                .and_then(|params| params.get("domain"))
                .map(String::as_str),
            Some("modelProviders")
        );
    }

    /// Forward compatibility is not sacrificed to the check above: a domain
    /// this binary has never heard of is ignored by the applier, so refusing it
    /// here would be stricter than the apply it guards.
    #[test]
    fn an_unknown_domain_is_not_what_the_dry_decode_is_for() {
        let bytes = serde_json::to_vec(&serde_json::json!({
            "schemaVersion": SCHEMA_VERSION,
            "domains": { "somethingFromANewerBuild": "whatever shape it likes" }
        }))
        .expect("bytes");
        parse_snapshot(&bytes).expect("an unknown domain must not block the import");
    }

    #[test]
    fn an_encrypted_manifest_is_a_known_format_now() {
        let snapshot = ConfigSnapshot {
            schema_version: SCHEMA_VERSION,
            domains: BTreeMap::new(),
        };
        let payload = b"ciphertext-stand-in";
        let manifest = build_manifest(payload, "1.0.0", snapshot.counts(), ENCRYPTION_AES_GCM);
        // The checksum covers what is transferred, i.e. the ciphertext.
        validate_manifest(&manifest, payload).expect("encrypted manifests validate");

        let unknown = ConfigManifest {
            encryption: "rot13".to_string(),
            ..manifest
        };
        let err = validate_manifest(&unknown, payload).expect_err("must refuse");
        assert_eq!(
            err.i18n_key.as_deref(),
            Some(CONFIG_SYNC_I18N_KEY_INVALID_SNAPSHOT)
        );
    }

    #[test]
    fn a_rollback_id_can_never_become_a_path() {
        let dir = tempfile::tempdir().expect("tempdir");
        let snapshot = ConfigSnapshot {
            schema_version: SCHEMA_VERSION,
            domains: BTreeMap::new(),
        };
        let written = write_rollback_snapshot(dir.path(), &snapshot).expect("write");
        let id = rollback_id(&written).expect("id");
        assert_eq!(resolve_rollback(dir.path(), &id).expect("resolve"), written);

        // Everything a traversal needs to express itself is outside the
        // accepted alphabet.
        for hostile in [
            "../../etc/passwd",
            "config-../../etc/passwd",
            "config-a/b",
            "config-a.b",
            "config-",
            "passwd",
            "",
        ] {
            let err = resolve_rollback(dir.path(), hostile).expect_err("must refuse");
            assert_eq!(
                err.i18n_key.as_deref(),
                Some(CONFIG_SYNC_I18N_KEY_NO_ROLLBACK)
            );
        }

        // A well-formed id for a file that was pruned is the same "gone".
        assert!(resolve_rollback(dir.path(), "config-19700101T000000000").is_err());
    }

    #[tokio::test]
    async fn the_rollback_list_describes_what_applying_one_would_write() {
        let source = fresh_in_memory_db().await;
        seed_source(&source.conn).await;
        let snapshot = collect_snapshot_core(&source.conn).await.expect("collect");

        let dir = tempfile::tempdir().expect("tempdir");
        write_rollback_snapshot(dir.path(), &snapshot).expect("write");
        // Unreadable junk alongside it must not take the list down with it.
        std::fs::write(dir.path().join("config-20240101T000000000.json"), b"{oops")
            .expect("write junk");

        // A file manager renaming a collision on copy. The stem parses, so the
        // lister used to publish it — and then Restore answered "no longer on
        // this machine" about a file sitting right there, because the resolver
        // holds ids to an alphabet with no room for a space or a bracket.
        std::fs::copy(
            dir.path().join(format!("{}.json", list_rollback_infos(dir.path())[0].id)),
            dir.path().join("config-20240101T000000001 (1).json"),
        )
        .expect("copy");

        let infos = list_rollback_infos(dir.path());
        assert_eq!(infos.len(), 1, "the unparseable file must be skipped");
        assert_eq!(infos[0].counts.get("quickMessages"), Some(&1));
        assert!(infos[0].size > 0);
        assert!(infos[0].created_at.is_some(), "the id carries its stamp");
        assert_eq!(
            read_rollback(&resolve_rollback(dir.path(), &infos[0].id).expect("resolve"))
                .expect("read")
                .counts(),
            snapshot.counts()
        );

        // The invariant behind both of those: the list is exactly the set of
        // ids the resolver will accept, so no row in it can fail on click.
        for info in &infos {
            resolve_rollback(dir.path(), &info.id)
                .unwrap_or_else(|_| panic!("listed id '{}' does not resolve", info.id));
        }
    }

    #[test]
    fn rollback_snapshots_are_pruned_newest_first() {
        let dir = tempfile::tempdir().expect("tempdir");
        let snapshot = ConfigSnapshot {
            schema_version: SCHEMA_VERSION,
            domains: BTreeMap::new(),
        };
        for index in 0..(ROLLBACK_KEEP + 3) {
            // Distinct, monotonically increasing names without waiting on the
            // wall clock.
            let path = dir
                .path()
                .join(format!("config-20240101T00000{index:03}.json"));
            std::fs::create_dir_all(dir.path()).expect("dir");
            std::fs::write(&path, serialize_snapshot(&snapshot).expect("bytes")).expect("write");
        }
        prune_rollback_snapshots(dir.path(), ROLLBACK_KEEP);
        let remaining = list_rollback_snapshots(dir.path());
        assert_eq!(remaining.len(), ROLLBACK_KEEP);
        // Newest first, and the pruned ones are the oldest.
        assert!(remaining[0] > remaining[remaining.len() - 1]);
    }
}
