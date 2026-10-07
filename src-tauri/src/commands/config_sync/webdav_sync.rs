//! Sync settings, remote layout, and the upload/download choreography.
//!
//! ## Remote layout
//!
//! `{remoteDir}/v{PROTOCOL_VERSION}/{profile}/{config.json,manifest.json}`
//!
//! The `v1` level means a future incompatible protocol can land beside this
//! one instead of on top of it, and `{profile}` lets one share hold several
//! independent configurations (work vs personal) without extra accounts.
//!
//! ## Upload order is load-bearing
//!
//! `config.json` first, `manifest.json` second. WebDAV has no multi-file
//! transaction, so an interrupted upload leaves the OLD manifest pointing at
//! the NEW config — and the downloader's checksum check rejects that pair
//! instead of applying a half-written configuration. Writing the manifest
//! first would invert this into "looks valid, is truncated".

use std::collections::BTreeMap;
use std::sync::OnceLock;

use sea_orm::DatabaseConnection;
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;

use super::credentials::{self, SNAPSHOT_PASSPHRASE, WEBDAV_PASSWORD};
use super::crypto;
use super::snapshot::{
    apply_snapshot_core, build_manifest, collect_snapshot_core, parse_manifest, parse_snapshot,
    serialize_snapshot, sha256_hex, validate_manifest, ApplyReport, ConfigManifest,
    CONFIG_FILE_NAME, ENCRYPTION_AES_GCM, ENCRYPTION_NONE, MANIFEST_FILE_NAME,
};
use crate::app_error::{AppCommandError, CONFIG_SYNC_I18N_KEY_NO_REMOTE};
use crate::db::service::app_metadata_service;
use crate::network::webdav::{sanitize_path_segment, WebdavClient};

/// Settings of this feature. NOT in `portable_keys`: if they travelled, one
/// machine's credentials would overwrite the other's and the two would sync
/// into each other in a loop.
///
/// The two secrets live in the keyring ([`super::credentials`]), not in this
/// row; what is left here is addresses and switches.
pub const CONFIG_SYNC_SETTINGS_KEY: &str = "config_sync_settings";
/// Last-uploaded hash and last result. Device-local by nature.
pub const CONFIG_SYNC_STATE_KEY: &str = "config_sync_state";

/// Remote layout version, independent of the snapshot's `schemaVersion`.
pub const PROTOCOL_VERSION: u32 = 1;

pub const DEFAULT_REMOTE_DIR: &str = "codeg";
pub const DEFAULT_PROFILE: &str = "default";
pub const DEFAULT_INTERVAL_MINUTES: u32 = 5;
/// A day. Not a real limit, just a guard against a value that would overflow
/// the backoff multiplier or park the timer past the heat death of the laptop.
const MAX_INTERVAL_MINUTES: u32 = 1440;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ConfigSyncSettings {
    pub enabled: bool,
    pub server_url: String,
    pub username: String,
    /// Never serialized into the settings row — it lives in the keyring, and
    /// [`load_settings`] puts it here. `default` is what lets an OLD row, which
    /// does still carry the password inline, deserialize so the value can be
    /// migrated out of it.
    #[serde(default, skip_serializing)]
    pub password: String,
    /// Same treatment, for the optional snapshot passphrase. There is no legacy
    /// form of this one: it never had a plaintext home.
    #[serde(default, skip_serializing)]
    pub passphrase: String,
    /// Wrap `config.json` in [`super::crypto`]'s envelope before uploading.
    /// Off by default — the plaintext boundary is the user's own authenticated
    /// endpoint, which is a real boundary for a self-hosted share.
    #[serde(default)]
    pub encrypt: bool,
    /// Opaque, non-secret, regenerated whenever the passphrase changes. It is
    /// part of [`ConfigSyncSettings::remote_target`] so that re-keying (or
    /// switching encryption on) makes the upload baseline stop matching and the
    /// next tick re-uploads. A hash of the passphrase would do the same job and
    /// would also park an offline-crackable digest of a user-chosen secret in
    /// the database; a random id leaks nothing.
    #[serde(default)]
    pub passphrase_id: String,
    pub remote_dir: String,
    pub profile: String,
    pub auto_sync: bool,
    pub interval_minutes: u32,
}

impl ConfigSyncSettings {
    /// Whether there is an endpoint to talk to at all. The `enabled` switch on
    /// its own is not enough: it is flipped on to REVEAL the form, so between
    /// that click and the first save there is a persisted `enabled: true` with
    /// no server URL, and a background tick that honoured only `enabled` would
    /// spend every interval failing on an empty URL and overwriting
    /// `last_error` with it.
    pub fn is_configured(&self) -> bool {
        !self.server_url.trim().is_empty()
    }

    /// How the payload is protected, as a value the upload baseline can be
    /// stamped with. Turning encryption on, or re-keying it, leaves the
    /// PLAINTEXT snapshot byte-identical — so without this the hash would still
    /// match, the tick would skip, and the remote would keep the copy written
    /// under the old protection. For a re-key that is not merely stale: the
    /// remote would be unreadable with the passphrase this machine now holds.
    fn protection(&self) -> &str {
        if self.encrypt {
            // Empty only in the transient state "encryption on, passphrase not
            // yet set", which `merge_settings` refuses to persist.
            &self.passphrase_id
        } else {
            "plain"
        }
    }

    /// The remote location this configuration points at, as a value that can
    /// be stored alongside the upload hash. Two settings that agree here write
    /// the same two files, readable the same way.
    ///
    /// A NUL separator rather than a slash: every part is user-typed, and a
    /// `/` would let `{dir: "a/b", profile: "c"}` and `{dir: "a", profile:
    /// "b/c"}` produce the same key. (`sanitize_path_segment` rejects both
    /// today; the separator is what keeps that from becoming load-bearing.)
    fn remote_target(&self) -> String {
        format!(
            "{}\u{0}{}\u{0}{}\u{0}{}",
            self.server_url,
            self.remote_dir,
            self.profile,
            self.protection()
        )
    }
}

impl Default for ConfigSyncSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            server_url: String::new(),
            username: String::new(),
            password: String::new(),
            passphrase: String::new(),
            encrypt: false,
            passphrase_id: String::new(),
            remote_dir: DEFAULT_REMOTE_DIR.to_string(),
            profile: DEFAULT_PROFILE.to_string(),
            auto_sync: true,
            interval_minutes: DEFAULT_INTERVAL_MINUTES,
        }
    }
}

/// What the frontend sees. The password is replaced by "is one stored", so a
/// compromised renderer cannot read it back and the settings form has nothing
/// to accidentally re-submit.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigSyncSettingsView {
    pub enabled: bool,
    pub server_url: String,
    pub username: String,
    pub has_password: bool,
    pub encrypt: bool,
    /// Same contract as `has_password`: the passphrase itself never crosses the
    /// bridge, only whether one is on file.
    pub has_passphrase: bool,
    pub remote_dir: String,
    pub profile: String,
    pub auto_sync: bool,
    pub interval_minutes: u32,
}

impl From<&ConfigSyncSettings> for ConfigSyncSettingsView {
    fn from(settings: &ConfigSyncSettings) -> Self {
        Self {
            enabled: settings.enabled,
            server_url: settings.server_url.clone(),
            username: settings.username.clone(),
            has_password: !settings.password.is_empty(),
            encrypt: settings.encrypt,
            has_passphrase: !settings.passphrase.is_empty(),
            remote_dir: settings.remote_dir.clone(),
            profile: settings.profile.clone(),
            auto_sync: settings.auto_sync,
            interval_minutes: settings.interval_minutes,
        }
    }
}

/// Save payload. `password: None` (or empty) means "keep what is stored" —
/// the ONLY password mechanism, deliberately.
///
/// The alternative, rendering a masked placeholder into the password field,
/// has a known failure mode: the form submits the mask verbatim and the mask
/// becomes the password, so the next sync fails to authenticate. There is also
/// no separate `passwordTouched` flag, because a flag plus a value is two
/// sources of truth that disagree exactly when the user clears the field.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigSyncSettingsInput {
    pub enabled: bool,
    pub server_url: String,
    pub username: String,
    #[serde(default)]
    pub password: Option<String>,
    /// Same "empty means keep what is stored" rule as the password. Unlike the
    /// password it is NOT scoped to the account: it protects the snapshot, not
    /// the connection, so moving the same configuration to a different host
    /// does not orphan it.
    #[serde(default)]
    pub passphrase: Option<String>,
    #[serde(default)]
    pub encrypt: bool,
    #[serde(default)]
    pub remote_dir: Option<String>,
    #[serde(default)]
    pub profile: Option<String>,
    pub auto_sync: bool,
    pub interval_minutes: u32,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ConfigSyncState {
    /// Hash of the last snapshot successfully uploaded. Persisted so a restart
    /// does not re-upload an unchanged configuration just to rebuild an
    /// in-memory baseline.
    pub last_uploaded_sha256: Option<String>,
    /// Which remote the hash above was uploaded TO
    /// ([`ConfigSyncSettings::remote_target`]). Without it the hash reads as
    /// "this configuration is already up there" and suppresses the first
    /// upload to a newly configured server, leaving it permanently empty.
    /// `None` on a row written before this field existed — which costs one
    /// redundant upload, the safe direction to be wrong in.
    pub last_uploaded_target: Option<String>,
    pub last_sync_at: Option<String>,
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadOutcome {
    /// `false` means the snapshot was byte-identical to the last upload and
    /// nothing was sent.
    pub uploaded: bool,
    pub sha256: String,
    pub counts: BTreeMap<String, usize>,
    pub synced_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadOutcome {
    pub manifest: ConfigManifest,
    pub applied: ApplyReport,
    pub rollback_path: Option<String>,
}

/// Every remote read/write funnels through here. An upload is two PUTs; two
/// concurrent uploads would interleave into a manifest from one snapshot and a
/// config from another.
fn remote_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

// ─── settings persistence ─────────────────────────────────────────────

/// Never fails: a row this build cannot parse degrades to defaults (sync off)
/// rather than breaking the settings page. The secrets are read from the
/// keyring and grafted on; the row itself holds none.
pub async fn load_settings(conn: &DatabaseConnection) -> ConfigSyncSettings {
    let raw = match app_metadata_service::get_value(conn, CONFIG_SYNC_SETTINGS_KEY).await {
        Ok(Some(raw)) => raw,
        Ok(None) => return ConfigSyncSettings::default(),
        Err(err) => {
            tracing::warn!("[CONFIG-SYNC] failed to read sync settings: {err}");
            return ConfigSyncSettings::default();
        }
    };
    let mut settings = match serde_json::from_str::<ConfigSyncSettings>(&raw) {
        Ok(settings) => settings,
        Err(err) => {
            tracing::warn!("[CONFIG-SYNC] failed to parse sync settings: {err}");
            ConfigSyncSettings::default()
        }
    };

    // Whatever the row still carries is a pre-keyring leftover.
    let legacy_password = std::mem::take(&mut settings.password);
    settings.password = credentials::load(WEBDAV_PASSWORD);
    settings.passphrase = credentials::load(SNAPSHOT_PASSPHRASE);

    // The trigger is "the ROW still holds a password", not "the keyring is
    // empty". Those look equivalent and are not: if a previous migration
    // stored the secret and then failed to rewrite the row, the keyring is
    // populated while the plaintext is still sitting in `app_metadata` — and a
    // keyring-empty test would skip the retry forever, leaving that copy in
    // the database (and in every backup archive) for good.
    if !legacy_password.is_empty() {
        // The keyring copy wins where both exist; it is the one every later
        // save writes to. The row copy is only a fallback for the very first
        // migration, before anything has been stored.
        if settings.password.is_empty() {
            settings.password = legacy_password;
        }
        migrate_legacy_password(conn, &settings.password).await;
    }
    settings
}

/// Move a password written by a build that kept it in the settings row into the
/// keyring, then strip the `password` key out of the row.
///
/// Best effort in both directions: a keyring that cannot be written leaves the
/// row as it was and sync keeps working from it, because refusing to load
/// settings would break the feature outright over a storage upgrade. Either
/// half failing is retried on the next load — see the caller.
async fn migrate_legacy_password(conn: &DatabaseConnection, password: &str) {
    if let Err(err) = credentials::store(WEBDAV_PASSWORD, password) {
        tracing::warn!(
            "[CONFIG-SYNC] keeping the password in the settings row: {}",
            err.message
        );
        return;
    }

    // Re-read and remove one key, rather than re-serializing the struct this
    // load parsed. Two reasons, and both are silent corruption otherwise:
    //
    //  - A concurrent save may have landed in between. Writing the parsed
    //    struct back would revert it — putting the OLD server URL beside the
    //    NEW password the keyring just took, which is exactly the pairing
    //    `merge_settings` refuses to create on purpose.
    //  - A row written by a NEWER build carries fields this one does not know.
    //    Serializing our struct over it drops them for good.
    //
    // Removing a single key from whatever the row holds *now* can only ever
    // take the plaintext out.
    let raw = match app_metadata_service::get_value(conn, CONFIG_SYNC_SETTINGS_KEY).await {
        Ok(Some(raw)) => raw,
        Ok(None) => return,
        Err(err) => {
            tracing::warn!("[CONFIG-SYNC] failed to re-read sync settings: {err}");
            return;
        }
    };
    let mut value = match serde_json::from_str::<serde_json::Value>(&raw) {
        Ok(value) => value,
        Err(err) => {
            tracing::warn!("[CONFIG-SYNC] failed to parse sync settings: {err}");
            return;
        }
    };
    let Some(object) = value.as_object_mut() else {
        return;
    };
    if object.remove("password").is_none() {
        // Someone else already erased it; nothing to write.
        return;
    }

    match serde_json::to_string(&value) {
        Ok(serialized) => {
            if let Err(err) =
                app_metadata_service::upsert_value(conn, CONFIG_SYNC_SETTINGS_KEY, &serialized).await
            {
                // The keyring copy is authoritative from here on, so the stale
                // plaintext is redundant rather than load-bearing — but it is
                // still plaintext, so say so.
                tracing::warn!("[CONFIG-SYNC] failed to erase the stored password: {err}");
            } else {
                tracing::info!("[CONFIG-SYNC] moved the WebDAV password to the keyring");
            }
        }
        Err(err) => tracing::warn!("[CONFIG-SYNC] failed to rewrite sync settings: {err}"),
    }
}

pub async fn save_settings_core(
    conn: &DatabaseConnection,
    input: ConfigSyncSettingsInput,
) -> Result<ConfigSyncSettingsView, AppCommandError> {
    let existing = load_settings(conn).await;

    // What this save DECIDES about the secrets, read off the input before it is
    // merged. Writing back whatever `load_settings` returned — which is what
    // this used to do — is a read-modify-write of the secret store, and an
    // unreadable store returns `""`, which means DELETE on the way back out. A
    // denied keychain prompt plus any unrelated save would have destroyed the
    // passphrase the copy already on the remote is encrypted under.
    //
    // Saying nothing about a secret must therefore touch nothing. That also
    // keeps the master switch and the interval working on a machine with no
    // usable keyring at all: a setting that needs no credential no longer
    // fails because a credential could not be reached.
    let new_password = input.password.clone().filter(|value| !value.is_empty());
    let new_passphrase = input
        .passphrase
        .clone()
        .filter(|value| !value.is_empty());
    let keeps_account = same_account(&existing, &input.server_url, &input.username);

    let merged = merge_settings(&existing, input)?;

    // Secrets first. If the keyring refuses them the save fails outright rather
    // than persisting a configuration whose credentials went nowhere — that
    // would surface minutes later as "the server rejected your password".
    if let Some(password) = &new_password {
        credentials::store(WEBDAV_PASSWORD, password)?;
    } else if !keeps_account {
        // The account moved, so the stored password does not belong to it any
        // more — `merge_settings` drops it for the same reason. Unconditional
        // rather than "only if one was read": deleting an absent entry is a
        // no-op, and a store we could not READ may still be holding the old
        // password for the old host.
        credentials::store(WEBDAV_PASSWORD, "")?;
    }
    if let Some(passphrase) = &new_passphrase {
        credentials::store(SNAPSHOT_PASSPHRASE, passphrase)?;
    }

    let serialized = serde_json::to_string(&merged).map_err(|e| {
        AppCommandError::invalid_input("Failed to serialize config sync settings")
            .with_detail(e.to_string())
    })?;
    debug_assert!(
        !serialized.contains(&merged.password) || merged.password.is_empty(),
        "the settings row must never carry the password"
    );
    app_metadata_service::upsert_value(conn, CONFIG_SYNC_SETTINGS_KEY, &serialized)
        .await
        .map_err(AppCommandError::db)?;

    // Note there is deliberately no "clear the upload baseline" step here.
    // Pointing at a different server, folder, or profile does invalidate the
    // baseline — but a second write that the save path has to remember to
    // make is a write that can fail silently, crash in between, or be undone
    // by an upload that was already in flight against the OLD target. The
    // baseline records its own target instead (see `upload_snapshot_core`),
    // so it simply stops matching; nothing has to be reset.
    Ok(ConfigSyncSettingsView::from(&merged))
}

/// Whether an incoming edit still names the account the stored password was
/// typed for.
///
/// The stored password belongs to that account. Carrying it over to a different
/// host or user would mean an edit to the URL field alone is enough to make the
/// next request hand that password to another server — by accident (repointing
/// Jianguoyun at Nextcloud) or on purpose. Changing the folder or profile is not
/// a change of credential, so those are deliberately not part of the comparison.
///
/// One definition, because two callers act on it: [`merge_settings`] decides
/// whether to keep the password, and [`save_settings_core`] decides whether to
/// erase it from the keyring. Those two answers must never differ.
fn same_account(existing: &ConfigSyncSettings, server_url: &str, username: &str) -> bool {
    server_url.trim() == existing.server_url && username.trim() == existing.username
}

/// Pure so the password-retention and path-validation rules are testable
/// without a database.
pub fn merge_settings(
    existing: &ConfigSyncSettings,
    input: ConfigSyncSettingsInput,
) -> Result<ConfigSyncSettings, AppCommandError> {
    let server_url = input.server_url.trim().to_string();
    let username = input.username.trim().to_string();
    let same_account = same_account(existing, &input.server_url, &input.username);
    let password = match input.password {
        Some(value) if !value.is_empty() => value,
        // Both `None` and `Some("")` keep the stored password. An empty field
        // means "I did not retype it", which is what an empty password field
        // means to every user who has ever seen one.
        _ if same_account => existing.password.clone(),
        _ => String::new(),
    };

    // The passphrase is deliberately NOT scoped the way the password is: it
    // protects the snapshot, not the connection, so repointing at another host
    // must not orphan it. It also survives `encrypt` being switched off, so a
    // user who turns encryption off can still pull down the encrypted copy
    // that is already on the remote.
    let passphrase = match input.passphrase {
        Some(value) if !value.is_empty() => value,
        _ => existing.passphrase.clone(),
    };
    if input.encrypt && passphrase.is_empty() {
        return Err(crypto::passphrase_required_error());
    }
    // Re-keying has to invalidate the upload baseline; see `protection`.
    let passphrase_id = if passphrase == existing.passphrase && !existing.passphrase_id.is_empty() {
        existing.passphrase_id.clone()
    } else {
        uuid::Uuid::new_v4().simple().to_string()
    };

    let remote_dir = normalize_segment(input.remote_dir, &existing.remote_dir, DEFAULT_REMOTE_DIR)?;
    let profile = normalize_segment(input.profile, &existing.profile, DEFAULT_PROFILE)?;

    Ok(ConfigSyncSettings {
        enabled: input.enabled,
        server_url,
        username,
        password,
        passphrase,
        encrypt: input.encrypt,
        passphrase_id,
        remote_dir,
        profile,
        auto_sync: input.auto_sync,
        interval_minutes: input
            .interval_minutes
            .clamp(1, MAX_INTERVAL_MINUTES),
    })
}

fn normalize_segment(
    incoming: Option<String>,
    existing: &str,
    fallback: &str,
) -> Result<String, AppCommandError> {
    let candidate = incoming.unwrap_or_else(|| existing.to_string());
    let candidate = if candidate.trim().is_empty() {
        fallback.to_string()
    } else {
        candidate
    };
    sanitize_path_segment(&candidate).ok_or_else(|| {
        AppCommandError::invalid_input(format!("Invalid remote path segment: {candidate}"))
            .with_i18n(
                crate::app_error::CONFIG_SYNC_I18N_KEY_REMOTE_PATH,
                BTreeMap::new(),
            )
    })
}

pub async fn load_state(conn: &DatabaseConnection) -> ConfigSyncState {
    match app_metadata_service::get_value(conn, CONFIG_SYNC_STATE_KEY).await {
        Ok(Some(raw)) => serde_json::from_str(&raw).unwrap_or_default(),
        _ => ConfigSyncState::default(),
    }
}

pub async fn save_state(conn: &DatabaseConnection, state: &ConfigSyncState) {
    let Ok(serialized) = serde_json::to_string(state) else {
        return;
    };
    if let Err(err) =
        app_metadata_service::upsert_value(conn, CONFIG_SYNC_STATE_KEY, &serialized).await
    {
        // Losing the hash baseline costs one redundant upload, not data.
        tracing::warn!("[CONFIG-SYNC] failed to persist sync state: {err}");
    }
}

// ─── remote paths ─────────────────────────────────────────────────────

/// `{remoteDir}/v1/{profile}` — the directory the two files live in.
pub fn remote_dir_path(settings: &ConfigSyncSettings) -> Result<String, AppCommandError> {
    let dir = normalize_segment(Some(settings.remote_dir.clone()), DEFAULT_REMOTE_DIR, DEFAULT_REMOTE_DIR)?;
    let profile = normalize_segment(Some(settings.profile.clone()), DEFAULT_PROFILE, DEFAULT_PROFILE)?;
    Ok(format!("{dir}/v{PROTOCOL_VERSION}/{profile}"))
}

fn client_for(settings: &ConfigSyncSettings) -> Result<WebdavClient, AppCommandError> {
    WebdavClient::new(&settings.server_url, &settings.username, &settings.password)
        .map_err(AppCommandError::from)
}

// ─── operations ───────────────────────────────────────────────────────

/// Credentials + reachability, without writing anything.
pub async fn test_connection_core(settings: &ConfigSyncSettings) -> Result<(), AppCommandError> {
    let client = client_for(settings)?;
    let dir = remote_dir_path(settings)?;
    let _guard = remote_lock().lock().await;
    client.probe(&dir).await.map_err(AppCommandError::from)
}

/// Collect → hash → skip-if-unchanged → upload.
///
/// `force` bypasses only the hash comparison (the manual "sync now" button);
/// it never bypasses validation.
pub async fn upload_snapshot_core(
    conn: &DatabaseConnection,
    app_version: &str,
    force: bool,
) -> Result<UploadOutcome, AppCommandError> {
    let settings = load_settings(conn).await;
    let snapshot = collect_snapshot_core(conn).await?;
    let bytes = serialize_snapshot(&snapshot)?;
    let hash = sha256_hex(&bytes);
    let counts = snapshot.counts();

    // The baseline suppresses an upload only when BOTH halves match: the same
    // bytes AND the same destination. A hash on its own would say "already
    // uploaded" about a server that has never been written to.
    let target = settings.remote_target();
    let mut state = load_state(conn).await;
    let already_there = state.last_uploaded_sha256.as_deref() == Some(hash.as_str())
        && state.last_uploaded_target.as_deref() == Some(target.as_str());
    if !force && already_there {
        // The common case on a timer: nothing changed, so nothing is sent and
        // no request is made at all.
        return Ok(UploadOutcome {
            uploaded: false,
            sha256: hash,
            counts,
            synced_at: state.last_sync_at.clone().unwrap_or_default(),
        });
    }

    let client = client_for(&settings)?;
    let dir = remote_dir_path(&settings)?;
    // What goes on the wire, which is also what the manifest's checksum has to
    // cover — its job is catching a truncated transfer.
    let (payload, encryption) = seal_for_upload(&settings, bytes).await?;
    let manifest = build_manifest(&payload, app_version, counts.clone(), encryption);
    let manifest_bytes = serde_json::to_vec_pretty(&manifest).map_err(|e| {
        AppCommandError::task_execution_failed("Serialize manifest").with_detail(e.to_string())
    })?;

    let result = async {
        let _guard = remote_lock().lock().await;
        client.ensure_dir(&dir).await?;
        client
            .put(&format!("{dir}/{CONFIG_FILE_NAME}"), payload)
            .await?;
        client
            .put(&format!("{dir}/{MANIFEST_FILE_NAME}"), manifest_bytes)
            .await?;
        Ok::<(), crate::network::webdav::WebdavError>(())
    }
    .await;

    let synced_at = chrono::Utc::now().to_rfc3339();
    match result {
        Ok(()) => {
            state.last_uploaded_sha256 = Some(hash.clone());
            state.last_uploaded_target = Some(target);
            state.last_sync_at = Some(synced_at.clone());
            state.last_error = None;
            save_state(conn, &state).await;
            Ok(UploadOutcome {
                uploaded: true,
                sha256: hash,
                counts,
                synced_at,
            })
        }
        Err(err) => {
            let app_error = AppCommandError::from(err);
            state.last_error = Some(app_error.message.clone());
            save_state(conn, &state).await;
            Err(app_error)
        }
    }
}

/// Wrap the snapshot when encryption is on. Argon2 is deliberately expensive,
/// so the derivation runs on a blocking thread rather than parking the runtime
/// for ~100 ms on every upload.
async fn seal_for_upload(
    settings: &ConfigSyncSettings,
    plain: Vec<u8>,
) -> Result<(Vec<u8>, &'static str), AppCommandError> {
    if !settings.encrypt {
        return Ok((plain, ENCRYPTION_NONE));
    }
    let passphrase = settings.passphrase.clone();
    let sealed = tokio::task::spawn_blocking(move || crypto::encrypt(&plain, &passphrase))
        .await
        .map_err(|e| {
            AppCommandError::task_execution_failed("Encrypt snapshot").with_detail(e.to_string())
        })??;
    Ok((sealed, ENCRYPTION_AES_GCM))
}

/// The inverse. `manifest` says whether the bytes are wrapped — but it is only
/// a second file on the same share, so whoever can replace the payload can
/// replace the manifest too, checksum and all. It is therefore trusted to say
/// "encrypted" and NOT trusted to say "plaintext": the local switch is the
/// authority for the downgrade direction.
async fn open_after_download(
    manifest: &ConfigManifest,
    settings: &ConfigSyncSettings,
    payload: Vec<u8>,
) -> Result<Vec<u8>, AppCommandError> {
    if manifest.encryption != ENCRYPTION_AES_GCM {
        // Without this, encryption protects nothing against the adversary it
        // was added for. The share operator swaps in a plaintext snapshot of
        // their choosing plus a manifest reading `encryption: "none"` with a
        // matching SHA-256; every check above passes, and provider endpoints
        // and API keys of their choosing land in the local database while the
        // user's switch says "encrypted".
        if settings.encrypt {
            return Err(AppCommandError::invalid_input(
                "The remote snapshot is not encrypted, but encryption is on for this machine",
            )
            .with_i18n(
                crate::app_error::CONFIG_SYNC_I18N_KEY_NOT_ENCRYPTED,
                BTreeMap::new(),
            ));
        }
        return Ok(payload);
    }
    let value: serde_json::Value = serde_json::from_slice(&payload).map_err(|e| {
        AppCommandError::invalid_input("Encrypted snapshot is not readable")
            .with_detail(e.to_string())
            .with_i18n(
                crate::app_error::CONFIG_SYNC_I18N_KEY_INVALID_SNAPSHOT,
                BTreeMap::new(),
            )
    })?;
    let envelope = crypto::parse_envelope(value)?;
    let passphrase = settings.passphrase.clone();
    tokio::task::spawn_blocking(move || crypto::decrypt(&envelope, &passphrase))
        .await
        .map_err(|e| {
            AppCommandError::task_execution_failed("Decrypt snapshot").with_detail(e.to_string())
        })?
}

/// Fetch the remote pair, verify it, and apply it locally.
///
/// Always explicit: nothing here runs on a timer. Automatic download would
/// mean a machine silently overwriting local configuration with whatever
/// another machine last pushed.
pub async fn download_and_apply_core(
    conn: &DatabaseConnection,
) -> Result<DownloadOutcome, AppCommandError> {
    let settings = load_settings(conn).await;
    let client = client_for(&settings)?;
    let dir = remote_dir_path(&settings)?;

    let (manifest_bytes, config_bytes) = {
        let _guard = remote_lock().lock().await;
        let manifest_bytes = client
            .get(&format!("{dir}/{MANIFEST_FILE_NAME}"))
            .await
            .map_err(AppCommandError::from)?;
        let config_bytes = client
            .get(&format!("{dir}/{CONFIG_FILE_NAME}"))
            .await
            .map_err(AppCommandError::from)?;
        (manifest_bytes, config_bytes)
    };

    let (Some(manifest_bytes), Some(config_bytes)) = (manifest_bytes, config_bytes) else {
        return Err(
            AppCommandError::invalid_input("No config snapshot on the remote yet")
                .with_i18n(CONFIG_SYNC_I18N_KEY_NO_REMOTE, BTreeMap::new()),
        );
    };

    let manifest = parse_manifest(&manifest_bytes)?;
    // Checksum first: an interrupted upload must never reach the database — and
    // it must not be handed to the decrypter either, where a truncated payload
    // would come back as "wrong passphrase".
    validate_manifest(&manifest, &config_bytes)?;
    let config_bytes = open_after_download(&manifest, &settings, config_bytes).await?;
    let snapshot = parse_snapshot(&config_bytes)?;

    // Hold the suppression guard across the apply. Applying rewrites local
    // configuration, and an auto-sync tick landing mid-apply would push a
    // half-merged state straight back to the remote.
    let _suppression = super::auto_sync::suppress_auto_sync();
    let rollback_path =
        super::local_io::save_rollback(conn, &super::snapshot::rollback_dir()).await;
    let applied = apply_snapshot_core(conn, &snapshot).await?;

    Ok(DownloadOutcome {
        manifest,
        applied,
        rollback_path,
    })
}

/// Read the remote manifest without applying anything — powers "the remote has
/// a snapshot from DESKTOP-42, 3 providers, 2 hours ago".
pub async fn peek_remote_core(
    conn: &DatabaseConnection,
) -> Result<Option<ConfigManifest>, AppCommandError> {
    let settings = load_settings(conn).await;
    let client = client_for(&settings)?;
    let dir = remote_dir_path(&settings)?;

    let bytes = {
        let _guard = remote_lock().lock().await;
        client
            .get(&format!("{dir}/{MANIFEST_FILE_NAME}"))
            .await
            .map_err(AppCommandError::from)?
    };
    match bytes {
        Some(bytes) => Ok(Some(parse_manifest(&bytes)?)),
        None => Ok(None),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::test_helpers::fresh_in_memory_db;

    fn input() -> ConfigSyncSettingsInput {
        ConfigSyncSettingsInput {
            enabled: true,
            server_url: " https://dav.example.com/dav ".to_string(),
            username: " alice ".to_string(),
            password: Some("app-password".to_string()),
            passphrase: None,
            encrypt: false,
            remote_dir: Some("codeg".to_string()),
            profile: Some("work".to_string()),
            auto_sync: true,
            interval_minutes: 5,
        }
    }

    /// Same account as `input()`, with a password already on file.
    fn stored() -> ConfigSyncSettings {
        ConfigSyncSettings {
            server_url: "https://dav.example.com/dav".to_string(),
            username: "alice".to_string(),
            password: "stored".to_string(),
            ..Default::default()
        }
    }

    #[test]
    fn an_empty_password_field_keeps_the_stored_one() {
        let existing = stored();

        for submitted in [None, Some(String::new())] {
            let merged = merge_settings(
                &existing,
                ConfigSyncSettingsInput {
                    password: submitted.clone(),
                    ..input()
                },
            )
            .expect("merge");
            assert_eq!(
                merged.password, "stored",
                "submitted {submitted:?} must not clear the password"
            );
        }

        let merged = merge_settings(&existing, input()).expect("merge");
        assert_eq!(merged.password, "app-password");

        // Moving the same account to another folder/profile is not a change
        // of credential.
        let merged = merge_settings(
            &existing,
            ConfigSyncSettingsInput {
                password: None,
                profile: Some("personal".to_string()),
                ..input()
            },
        )
        .expect("merge");
        assert_eq!(merged.password, "stored");
    }

    /// A password is bound to the account it was typed for. Repointing the URL
    /// (or the user) while leaving the field blank must NOT quietly hand the
    /// saved credential to the new server — that turns one edited text field
    /// into credential exfiltration, and gets the "I switched providers"
    /// mistake wrong the same way.
    #[test]
    fn a_stored_password_does_not_follow_a_changed_account() {
        for changed in [
            ConfigSyncSettingsInput {
                password: None,
                server_url: "https://dav.attacker.example/dav".to_string(),
                ..input()
            },
            ConfigSyncSettingsInput {
                password: None,
                username: "mallory".to_string(),
                ..input()
            },
        ] {
            let merged = merge_settings(&stored(), changed).expect("merge");
            assert_eq!(
                merged.password, "",
                "the saved password must not travel to another account"
            );
        }

        // Retyping it is all it takes to point the sync somewhere new.
        let merged = merge_settings(
            &stored(),
            ConfigSyncSettingsInput {
                password: Some("new-app-password".to_string()),
                server_url: "https://dav.other.example/dav".to_string(),
                ..input()
            },
        )
        .expect("merge");
        assert_eq!(merged.password, "new-app-password");
    }

    #[test]
    fn urls_and_usernames_are_trimmed_and_intervals_clamped() {
        let merged = merge_settings(
            &ConfigSyncSettings::default(),
            ConfigSyncSettingsInput {
                interval_minutes: 0,
                ..input()
            },
        )
        .expect("merge");
        assert_eq!(merged.server_url, "https://dav.example.com/dav");
        assert_eq!(merged.username, "alice");
        assert_eq!(merged.interval_minutes, 1);

        let merged = merge_settings(
            &ConfigSyncSettings::default(),
            ConfigSyncSettingsInput {
                interval_minutes: u32::MAX,
                ..input()
            },
        )
        .expect("merge");
        assert_eq!(merged.interval_minutes, MAX_INTERVAL_MINUTES);
    }

    #[test]
    fn traversal_in_a_path_segment_is_refused() {
        for bad in ["..", "a/b", "a\\b"] {
            let err = merge_settings(
                &ConfigSyncSettings::default(),
                ConfigSyncSettingsInput {
                    remote_dir: Some(bad.to_string()),
                    ..input()
                },
            )
            .expect_err("must reject");
            assert_eq!(
                err.i18n_key.as_deref(),
                Some(crate::app_error::CONFIG_SYNC_I18N_KEY_REMOTE_PATH)
            );
        }
    }

    #[test]
    fn blank_segments_fall_back_to_defaults() {
        let merged = merge_settings(
            &ConfigSyncSettings::default(),
            ConfigSyncSettingsInput {
                remote_dir: Some("  ".to_string()),
                profile: None,
                ..input()
            },
        )
        .expect("merge");
        assert_eq!(merged.remote_dir, DEFAULT_REMOTE_DIR);
        assert_eq!(merged.profile, DEFAULT_PROFILE);
    }

    #[test]
    fn remote_path_carries_the_protocol_version_and_profile() {
        let settings = ConfigSyncSettings {
            remote_dir: "backups".to_string(),
            profile: "work".to_string(),
            ..Default::default()
        };
        assert_eq!(remote_dir_path(&settings).expect("path"), "backups/v1/work");
    }

    #[tokio::test]
    async fn the_view_never_carries_the_password() {
        let _guard = credentials::test_guard().await;
        let db = fresh_in_memory_db().await;
        let view = save_settings_core(&db.conn, input()).await.expect("save");
        assert!(view.has_password);

        let serialized = serde_json::to_string(&view).expect("serialize");
        assert!(
            !serialized.contains("app-password"),
            "password leaked to the frontend: {serialized}"
        );

        // And it round-trips, untouched, from wherever it was put.
        let stored = load_settings(&db.conn).await;
        assert_eq!(stored.password, "app-password");
        assert_eq!(stored.profile, "work");
    }

    /// The settings row is plaintext in the SQLite file, and the SQLite file is
    /// inside every backup archive. The credential has no business being in
    /// either.
    #[tokio::test]
    async fn the_settings_row_holds_no_secret() {
        let _guard = credentials::test_guard().await;
        let db = fresh_in_memory_db().await;
        save_settings_core(
            &db.conn,
            ConfigSyncSettingsInput {
                passphrase: Some("snapshot-passphrase".to_string()),
                encrypt: true,
                ..input()
            },
        )
        .await
        .expect("save");

        let row = app_metadata_service::get_value(&db.conn, CONFIG_SYNC_SETTINGS_KEY)
            .await
            .expect("read row")
            .expect("row exists");
        assert!(!row.contains("app-password"), "{row}");
        assert!(!row.contains("snapshot-passphrase"), "{row}");
        // The non-secret half is still there, or the settings page would come
        // back blank.
        assert!(row.contains("dav.example.com"), "{row}");

        let loaded = load_settings(&db.conn).await;
        assert_eq!(loaded.password, "app-password");
        assert_eq!(loaded.passphrase, "snapshot-passphrase");
    }

    /// Upgrading must not log the user out of their own WebDAV share: a row
    /// written by the build that stored the password inline is read once, moved
    /// into the keyring, and erased.
    #[tokio::test]
    async fn a_password_written_by_an_older_build_is_migrated_out_of_the_row() {
        let _guard = credentials::test_guard().await;
        credentials::store(WEBDAV_PASSWORD, "").expect("start clean");
        let db = fresh_in_memory_db().await;
        app_metadata_service::upsert_value(
            &db.conn,
            CONFIG_SYNC_SETTINGS_KEY,
            r#"{"enabled":true,"serverUrl":"https://dav.example.com/dav","username":"alice","password":"legacy-secret","remoteDir":"codeg","profile":"work","autoSync":true,"intervalMinutes":5}"#,
        )
        .await
        .expect("seed legacy row");

        let loaded = load_settings(&db.conn).await;
        assert_eq!(loaded.password, "legacy-secret");
        assert_eq!(credentials::load(WEBDAV_PASSWORD), "legacy-secret");

        let row = app_metadata_service::get_value(&db.conn, CONFIG_SYNC_SETTINGS_KEY)
            .await
            .expect("read row")
            .expect("row exists");
        assert!(!row.contains("legacy-secret"), "still in the row: {row}");

        // Idempotent: a second load reads the keyring copy and changes nothing.
        assert_eq!(load_settings(&db.conn).await.password, "legacy-secret");
        credentials::store(WEBDAV_PASSWORD, "").expect("clean up");
    }

    /// The migration is two writes, and the second one can fail: the keyring
    /// takes the secret, then the row rewrite loses to a busy database. That
    /// leaves the state this test seeds — keyring populated, plaintext STILL in
    /// the row — and the next load has to finish the job.
    ///
    /// Keying the retry off "the keyring is empty" would skip it forever here,
    /// and the plaintext would stay in `app_metadata` (and in every backup
    /// archive taken from it) for the life of the install.
    #[tokio::test]
    async fn an_interrupted_migration_is_finished_by_the_next_load() {
        let _guard = credentials::test_guard().await;
        credentials::store(WEBDAV_PASSWORD, "legacy-secret").expect("keyring half succeeded");
        let db = fresh_in_memory_db().await;
        app_metadata_service::upsert_value(
            &db.conn,
            CONFIG_SYNC_SETTINGS_KEY,
            r#"{"enabled":true,"serverUrl":"https://dav.example.com/dav","username":"alice","password":"legacy-secret","remoteDir":"codeg","profile":"work","autoSync":true,"intervalMinutes":5}"#,
        )
        .await
        .expect("seed half-migrated row");

        assert_eq!(load_settings(&db.conn).await.password, "legacy-secret");

        let row = app_metadata_service::get_value(&db.conn, CONFIG_SYNC_SETTINGS_KEY)
            .await
            .expect("read row")
            .expect("row exists");
        assert!(
            !row.contains("legacy-secret"),
            "a half-finished migration was never retried: {row}"
        );
        credentials::store(WEBDAV_PASSWORD, "").expect("clean up");
    }

    /// The migration rewrites the row, and the row is shared: a save that lands
    /// between this load's read and its write must survive, and so must fields
    /// a NEWER build wrote that this one cannot parse. Both are the same
    /// property — the migration removes one key rather than serializing its own
    /// idea of the settings over the top — and the unknown field is the half
    /// that can be pinned down without racing anything.
    ///
    /// Serializing the parsed struct back would drop `futureField` here, and in
    /// the racing case would pair the OLD server URL with the NEW password the
    /// keyring just took: the exact combination `merge_settings` refuses to
    /// create, arrived at behind its back.
    #[tokio::test]
    async fn the_migration_removes_the_password_and_nothing_else() {
        let _guard = credentials::test_guard().await;
        credentials::store(WEBDAV_PASSWORD, "").expect("start clean");
        let db = fresh_in_memory_db().await;
        app_metadata_service::upsert_value(
            &db.conn,
            CONFIG_SYNC_SETTINGS_KEY,
            r#"{"enabled":true,"serverUrl":"https://dav.example.com/dav","username":"alice","password":"legacy-secret","remoteDir":"codeg","profile":"work","autoSync":true,"intervalMinutes":5,"futureField":"written by a newer build"}"#,
        )
        .await
        .expect("seed a row this build does not fully understand");

        assert_eq!(load_settings(&db.conn).await.password, "legacy-secret");

        let row = app_metadata_service::get_value(&db.conn, CONFIG_SYNC_SETTINGS_KEY)
            .await
            .expect("read row")
            .expect("row exists");
        assert!(!row.contains("legacy-secret"), "the password must be gone: {row}");
        assert!(
            row.contains("written by a newer build"),
            "the migration overwrote a field it does not own: {row}"
        );
        credentials::store(WEBDAV_PASSWORD, "").expect("clean up");
    }

    /// A keyring that will not open reads back as "no secret", and the save
    /// used to write whatever it had just read — so `""` went out as DELETE and
    /// a change to the sync interval destroyed the passphrase protecting the
    /// copy already on the remote. Nothing brings that back.
    ///
    /// The fix is that saying nothing about a secret touches nothing, which
    /// also means the save still SUCCEEDS: settings that need no credential
    /// must not fail because a credential could not be reached. A Linux desktop
    /// with no Secret Service running would otherwise be unable to turn config
    /// sync off, or change its interval, for as long as it stayed that way.
    #[tokio::test]
    async fn a_save_that_carries_no_secret_leaves_an_unreadable_store_alone() {
        let _guard = credentials::test_guard().await;
        let db = fresh_in_memory_db().await;
        credentials::store(WEBDAV_PASSWORD, "app-password").expect("seed");
        credentials::store(SNAPSHOT_PASSPHRASE, "hunter2").expect("seed");
        // Establish the account first, so the save below is not an account
        // change (which deliberately DOES erase the password).
        save_settings_core(&db.conn, input()).await.expect("seed settings");

        {
            let _unreadable = credentials::unreadable_store();
            save_settings_core(
                &db.conn,
                ConfigSyncSettingsInput {
                    interval_minutes: 30,
                    // "I did not retype them" — the state every save that is
                    // not about credentials is in.
                    password: None,
                    passphrase: None,
                    ..input()
                },
            )
            .await
            .expect("a setting that needs no credential must still save");
        }

        // Both secrets are untouched once the store opens again.
        assert_eq!(credentials::load(WEBDAV_PASSWORD), "app-password");
        assert_eq!(credentials::load(SNAPSHOT_PASSPHRASE), "hunter2");
        assert_eq!(load_settings(&db.conn).await.interval_minutes, 30);

        credentials::store(WEBDAV_PASSWORD, "").expect("clean up");
        credentials::store(SNAPSHOT_PASSPHRASE, "").expect("clean up");
    }

    /// The other half: a save that DOES carry a secret still writes it, and an
    /// account change still erases the password that no longer belongs to the
    /// account — unconditionally, because a store that could not be read may
    /// still be holding the old host's copy.
    #[tokio::test]
    async fn a_save_writes_the_secrets_it_was_given_and_erases_an_orphaned_one() {
        let _guard = credentials::test_guard().await;
        let db = fresh_in_memory_db().await;
        credentials::store(WEBDAV_PASSWORD, "").expect("start clean");
        credentials::store(SNAPSHOT_PASSPHRASE, "").expect("start clean");

        save_settings_core(
            &db.conn,
            ConfigSyncSettingsInput {
                password: Some("typed".into()),
                ..input()
            },
        )
        .await
        .expect("save");
        assert_eq!(credentials::load(WEBDAV_PASSWORD), "typed");

        // Same account, nothing typed: the stored password stays.
        save_settings_core(
            &db.conn,
            ConfigSyncSettingsInput {
                password: None,
                ..input()
            },
        )
        .await
        .expect("save");
        assert_eq!(credentials::load(WEBDAV_PASSWORD), "typed");

        // A different host is a different account, so the password does not
        // travel to it.
        save_settings_core(
            &db.conn,
            ConfigSyncSettingsInput {
                server_url: "https://other.example.com/dav".into(),
                password: None,
                ..input()
            },
        )
        .await
        .expect("save");
        assert_eq!(credentials::load(WEBDAV_PASSWORD), "");
    }

    /// And when the two copies disagree — the user re-saved a new password
    /// after a partial migration — the keyring is the one every save writes to,
    /// so it wins and the stale row copy is erased rather than resurrected.
    #[tokio::test]
    async fn the_keyring_copy_wins_over_a_stale_row_copy() {
        let _guard = credentials::test_guard().await;
        credentials::store(WEBDAV_PASSWORD, "current").expect("store");
        let db = fresh_in_memory_db().await;
        app_metadata_service::upsert_value(
            &db.conn,
            CONFIG_SYNC_SETTINGS_KEY,
            r#"{"enabled":true,"serverUrl":"https://dav.example.com/dav","username":"alice","password":"outdated","remoteDir":"codeg","profile":"work","autoSync":true,"intervalMinutes":5}"#,
        )
        .await
        .expect("seed row");

        assert_eq!(load_settings(&db.conn).await.password, "current");
        let row = app_metadata_service::get_value(&db.conn, CONFIG_SYNC_SETTINGS_KEY)
            .await
            .expect("read row")
            .expect("row exists");
        assert!(!row.contains("outdated"), "{row}");
        credentials::store(WEBDAV_PASSWORD, "").expect("clean up");
    }

    /// Switching encryption on leaves the PLAINTEXT snapshot byte-identical, so
    /// the hash alone would say "already uploaded" and the remote would keep
    /// its unencrypted copy — the user would have turned on a protection that
    /// never reached the server. Same shape as the retarget bug, same fix: the
    /// baseline records what it was uploaded under.
    #[test]
    fn turning_encryption_on_or_rekeying_invalidates_the_upload_baseline() {
        let plain = ConfigSyncSettings {
            server_url: "https://dav.example.com/dav".to_string(),
            ..Default::default()
        };
        let encrypted = merge_settings(
            &plain,
            ConfigSyncSettingsInput {
                encrypt: true,
                passphrase: Some("first".to_string()),
                ..input()
            },
        )
        .expect("merge");
        assert_ne!(plain.remote_target(), encrypted.remote_target());

        let rekeyed = merge_settings(
            &encrypted,
            ConfigSyncSettingsInput {
                encrypt: true,
                passphrase: Some("second".to_string()),
                ..input()
            },
        )
        .expect("merge");
        assert_ne!(
            encrypted.remote_target(),
            rekeyed.remote_target(),
            "a re-key leaves the remote unreadable; it must force a re-upload"
        );

        // Saving again without retyping the passphrase is not a re-key, and
        // must NOT cost an upload every time the settings page is saved.
        let resaved = merge_settings(
            &rekeyed,
            ConfigSyncSettingsInput {
                encrypt: true,
                passphrase: None,
                ..input()
            },
        )
        .expect("merge");
        assert_eq!(rekeyed.remote_target(), resaved.remote_target());
    }

    #[test]
    fn encryption_without_a_passphrase_is_refused_instead_of_failing_every_tick() {
        let err = merge_settings(
            &ConfigSyncSettings::default(),
            ConfigSyncSettingsInput {
                encrypt: true,
                passphrase: None,
                ..input()
            },
        )
        .expect_err("must refuse");
        assert_eq!(
            err.i18n_key.as_deref(),
            Some(crate::app_error::CONFIG_SYNC_I18N_KEY_PASSPHRASE_REQUIRED)
        );
    }

    /// The passphrase is not scoped to the account the way the password is, and
    /// it outlives the switch: an encrypted snapshot already on the remote has
    /// to stay readable after a user turns encryption off.
    #[test]
    fn the_passphrase_survives_a_host_change_and_the_switch_going_off() {
        let stored_with_passphrase = ConfigSyncSettings {
            passphrase: "kept".to_string(),
            encrypt: true,
            passphrase_id: "id".to_string(),
            ..stored()
        };

        let moved = merge_settings(
            &stored_with_passphrase,
            ConfigSyncSettingsInput {
                password: Some("new".to_string()),
                server_url: "https://dav.other.example/dav".to_string(),
                encrypt: true,
                passphrase: None,
                ..input()
            },
        )
        .expect("merge");
        assert_eq!(moved.passphrase, "kept");

        let switched_off = merge_settings(
            &stored_with_passphrase,
            ConfigSyncSettingsInput {
                encrypt: false,
                passphrase: None,
                ..input()
            },
        )
        .expect("merge");
        assert_eq!(switched_off.passphrase, "kept");
        assert!(!switched_off.encrypt);
    }

    /// The manifest is the authority on whether the payload is wrapped, and it
    /// stays plaintext so "whose copy, from when" is readable without the
    /// passphrase. The payload itself must not be.
    #[tokio::test]
    async fn an_encrypted_upload_is_unreadable_but_its_manifest_is_not() {
        let db = fresh_in_memory_db().await;
        let snapshot = collect_snapshot_core(&db.conn).await.expect("collect");
        let plain = serialize_snapshot(&snapshot).expect("bytes");

        let settings = ConfigSyncSettings {
            encrypt: true,
            passphrase: "hunter2".to_string(),
            ..Default::default()
        };
        let (payload, encryption) = seal_for_upload(&settings, plain.clone())
            .await
            .expect("seal");
        assert_eq!(encryption, ENCRYPTION_AES_GCM);
        assert_ne!(payload, plain);

        let manifest = build_manifest(&payload, "1.0.0", snapshot.counts(), encryption);
        // The checksum has to cover the transferred bytes, or a truncated
        // ciphertext would read as a wrong passphrase.
        validate_manifest(&manifest, &payload).expect("manifest matches the ciphertext");
        let manifest_json = serde_json::to_string(&manifest).expect("json");
        assert!(manifest_json.contains("aes-256-gcm"), "{manifest_json}");

        let opened = open_after_download(&manifest, &settings, payload.clone())
            .await
            .expect("open");
        assert_eq!(opened, plain);

        // A machine without the passphrase gets told so, rather than being
        // handed nonsense to parse.
        let bare = ConfigSyncSettings::default();
        let err = open_after_download(&manifest, &bare, payload)
            .await
            .expect_err("must refuse");
        assert_eq!(
            err.i18n_key.as_deref(),
            Some(crate::app_error::CONFIG_SYNC_I18N_KEY_PASSPHRASE_REQUIRED)
        );
    }

    /// The manifest is a second file on the same share, not a signature: the
    /// party this feature encrypts AGAINST can rewrite it. So it may be
    /// believed when it says "encrypted" and not when it says "plaintext" —
    /// otherwise a two-file swap (attacker's snapshot + `encryption: "none"` +
    /// the matching checksum) walks straight past every check and writes
    /// provider endpoints and API keys into the local database.
    #[tokio::test]
    async fn a_manifest_cannot_switch_encryption_off() {
        let db = fresh_in_memory_db().await;
        let snapshot = collect_snapshot_core(&db.conn).await.expect("collect");
        let forged = serialize_snapshot(&snapshot).expect("bytes");
        // Forged end to end: the checksum is over the attacker's own bytes, so
        // `validate_manifest` has nothing to object to.
        let manifest = build_manifest(&forged, "1.0.0", snapshot.counts(), ENCRYPTION_NONE);
        validate_manifest(&manifest, &forged).expect("a forgery is self-consistent");

        let protected = ConfigSyncSettings {
            encrypt: true,
            passphrase: "hunter2".to_string(),
            ..Default::default()
        };
        let err = open_after_download(&manifest, &protected, forged.clone())
            .await
            .expect_err("a downgrade must not be applied");
        assert_eq!(
            err.i18n_key.as_deref(),
            Some(crate::app_error::CONFIG_SYNC_I18N_KEY_NOT_ENCRYPTED)
        );

        // And the same pair is still accepted by a machine that never asked for
        // encryption — the refusal is the user's switch, not a format rule.
        let plain = ConfigSyncSettings::default();
        assert_eq!(
            open_after_download(&manifest, &plain, forged.clone())
                .await
                .expect("plaintext sync still works"),
            forged
        );
    }

    /// Seed "this exact configuration is already on the currently configured
    /// remote", which is the state the timer spends most of its life in.
    async fn seed_uploaded_baseline(db: &crate::db::AppDatabase) -> String {
        let snapshot = collect_snapshot_core(&db.conn).await.expect("collect");
        let hash = sha256_hex(&serialize_snapshot(&snapshot).expect("bytes"));
        save_state(
            &db.conn,
            &ConfigSyncState {
                last_uploaded_sha256: Some(hash.clone()),
                last_uploaded_target: Some(load_settings(&db.conn).await.remote_target()),
                last_sync_at: Some("2026-01-01T00:00:00Z".to_string()),
                last_error: None,
            },
        )
        .await;
        hash
    }

    #[tokio::test]
    async fn sync_state_survives_a_reload() {
        let db = fresh_in_memory_db().await;
        let state = ConfigSyncState {
            last_uploaded_sha256: Some("abc".to_string()),
            last_uploaded_target: Some("https://dav.example.com/dav\u{0}codeg\u{0}work".to_string()),
            last_sync_at: Some("2026-01-01T00:00:00Z".to_string()),
            last_error: None,
        };
        save_state(&db.conn, &state).await;
        let loaded = load_state(&db.conn).await;
        assert_eq!(loaded.last_uploaded_sha256.as_deref(), Some("abc"));
        assert_eq!(
            loaded.last_uploaded_target.as_deref(),
            state.last_uploaded_target.as_deref()
        );
    }

    /// A row written before the target was recorded must not read as "already
    /// uploaded" — being wrong in the other direction costs one extra upload,
    /// being wrong this way costs an empty remote forever.
    #[tokio::test]
    async fn a_baseline_from_an_older_build_does_not_suppress_anything() {
        let db = fresh_in_memory_db().await;
        let snapshot = collect_snapshot_core(&db.conn).await.expect("collect");
        let hash = sha256_hex(&serialize_snapshot(&snapshot).expect("bytes"));
        app_metadata_service::upsert_value(
            &db.conn,
            CONFIG_SYNC_STATE_KEY,
            &format!(r#"{{"lastUploadedSha256":"{hash}"}}"#),
        )
        .await
        .expect("seed legacy row");

        let state = load_state(&db.conn).await;
        assert_eq!(state.last_uploaded_sha256.as_deref(), Some(hash.as_str()));
        assert_eq!(state.last_uploaded_target, None);
        upload_snapshot_core(&db.conn, "1.0.0", false)
            .await
            .expect_err("an unstamped baseline must not skip the upload");
    }

    /// An unchanged configuration must not touch the network — this is what
    /// makes a 5-minute timer acceptable.
    #[tokio::test]
    async fn an_unchanged_snapshot_skips_the_upload_entirely() {
        let db = fresh_in_memory_db().await;
        let hash = seed_uploaded_baseline(&db).await;

        // No server is configured, so reaching the transport at all would
        // surface as an error rather than a skip.
        let outcome = upload_snapshot_core(&db.conn, "1.0.0", false)
            .await
            .expect("skip without network");
        assert!(!outcome.uploaded);
        assert_eq!(outcome.sha256, hash);
    }

    /// Retargeting the sync must not leave the new location empty. The hash
    /// alone says "this configuration was uploaded", not "uploaded HERE", so
    /// the baseline records its destination and simply stops matching.
    ///
    /// Recorded rather than reset on save, because a reset is a second write:
    /// it can fail silently, be interrupted, or be overwritten by an upload
    /// that was already in flight against the old target. A self-describing
    /// baseline has no such window.
    #[tokio::test]
    async fn a_baseline_does_not_carry_over_to_a_new_remote() {
        let _guard = credentials::test_guard().await;
        let db = fresh_in_memory_db().await;
        save_settings_core(&db.conn, input()).await.expect("save");
        let hash = seed_uploaded_baseline(&db).await;

        // Same target, unrelated field: still suppressed, no network.
        save_settings_core(
            &db.conn,
            ConfigSyncSettingsInput {
                interval_minutes: 30,
                ..input()
            },
        )
        .await
        .expect("save");
        let outcome = upload_snapshot_core(&db.conn, "1.0.0", false)
            .await
            .expect("same target, same bytes: skip");
        assert!(!outcome.uploaded);
        assert_eq!(outcome.sha256, hash);

        // New profile, byte-identical configuration: the suppression must not
        // apply. The configured URL is unreachable, so an attempt surfaces as
        // an error — which is the proof that an attempt was made at all.
        for retarget in [
            ConfigSyncSettingsInput {
                profile: Some("personal".to_string()),
                ..input()
            },
            ConfigSyncSettingsInput {
                remote_dir: Some("elsewhere".to_string()),
                ..input()
            },
            ConfigSyncSettingsInput {
                server_url: "  ".to_string(),
                ..input()
            },
        ] {
            let db = fresh_in_memory_db().await;
            save_settings_core(&db.conn, input()).await.expect("save");
            seed_uploaded_baseline(&db).await;
            save_settings_core(&db.conn, retarget).await.expect("save");
            upload_snapshot_core(&db.conn, "1.0.0", false)
                .await
                .expect_err("a new target must be uploaded to, not skipped");
        }
    }
}
