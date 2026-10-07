//! The computer-use settings: whether an agent may see the desktop at all,
//! how long a shared window stays shared unused, which applications can
//! never be shared, the shortcut that stops every agent at once, whether
//! the strip with Stop on it floats above every window while anything is
//! shared, and whether an agent may have a window brought to the front to
//! act on it — and, if so, whether that is how every action goes unless it
//! asks otherwise.
//!
//! Separate from `commands::computer`, which is the desktop feature itself and
//! exists only in the desktop build: these switches are read by the shared
//! codeg-mcp plumbing (injection, the service-status popover), so they compile
//! in server mode too — where computer use is simply never advertised.
//!
//! **Off by default.** It hands an agent a view of the user's screen.
//! Sharing an individual window is a second decision on top of it
//! (`crate::computer::agent`); this switch only decides whether the tools
//! exist. Switching it off ends every grant and stops the helper — that part
//! lives with the desktop's computer service, which watches the runtime
//! config.

use std::time::Duration;

use sea_orm::DatabaseConnection;
use serde::{Deserialize, Serialize};

use crate::acp::computer_tools::{ComputerToolsConfig, ComputerToolsRuntimeConfig};
use crate::app_error::AppCommandError;
use crate::computer::agent::{default_blocklist, is_default_key, DefaultBlockView};
use crate::computer::keys::Platform;
use crate::computer::stop_shortcut::StopShortcut;
use crate::computer::types::ActDelivery;
use crate::db::service::app_metadata_service;
use crate::web::event_bridge::{emit_event, EventEmitter, COMPUTER_TOOLS_SETTINGS_CHANGED_EVENT};

pub const KEY_COMPUTER_TOOLS_ENABLED: &str = "computer_tools.enabled";

/// Minutes a shared window may go unread before its sharing ends; `0` is
/// "until the user takes it back".
pub const KEY_COMPUTER_TOOLS_GRANT_TTL_MINUTES: &str = "computer_tools.grant_ttl_minutes";

/// Applications the user added to the default blocklist, as a JSON array of
/// bundle identifiers, paths or executable names.
pub const KEY_COMPUTER_TOOLS_BLOCKLIST: &str = "computer_tools.blocklist";

/// Default blocklist entries the user took off it, as a JSON array of their
/// keys (`computer::agent::DEFAULT_BLOCKLIST`). Only the removals are kept,
/// not the list they leave, so an entry a later release adds to the defaults
/// is on everyone's list.
pub const KEY_COMPUTER_TOOLS_BLOCKLIST_REMOVED: &str = "computer_tools.blocklist_removed";

/// The shortcut that stops every agent at once, spelled as
/// `computer::stop_shortcut` spells it; empty is "none". Absent is the
/// platform's default.
pub const KEY_COMPUTER_TOOLS_STOP_SHORTCUT: &str = "computer_tools.stop_shortcut";

/// Whether the strip above every window comes up while anything is shared,
/// `true` or `false`. Absent is `true`.
pub const KEY_COMPUTER_TOOLS_SHOW_INDICATOR: &str = "computer_tools.show_indicator";

/// Whether an agent may have a shared window brought to the front for an
/// action, `true` or `false`. Absent is `true`: some applications take keys
/// no other way, and the person can switch it off.
pub const KEY_COMPUTER_TOOLS_ALLOW_FOREGROUND: &str = "computer_tools.allow_foreground";

/// How an action reaches its window when the agent does not say,
/// `background` or `foreground` — the second in force only while the front
/// is allowed at all. Absent is `background`.
pub const KEY_COMPUTER_TOOLS_DEFAULT_DELIVERY: &str = "computer_tools.default_delivery";

/// Whether an agent may start applications and move or size a shared
/// window, `true` or `false`. Absent is `false`: it changes the person's
/// desktop beyond the windows they shared.
pub const KEY_COMPUTER_TOOLS_LAUNCH_ENABLED: &str = "computer_tools.launch_enabled";

/// Whether an agent may read back what it put on the clipboard and put text
/// there, `true` or `false`. Absent is `false`.
pub const KEY_COMPUTER_TOOLS_CLIPBOARD_ENABLED: &str = "computer_tools.clipboard_enabled";

/// Whether the entire screen is offered in the share picker, `true` or
/// `false`. Absent is `false`: sharing the screen shares every window there
/// is, the ones that come up later included.
pub const KEY_COMPUTER_TOOLS_SCREEN_ENABLED: &str = "computer_tools.screen_enabled";

/// The grant timeout when the user has chosen none.
pub const DEFAULT_GRANT_TTL_MINUTES: u32 = 30;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ComputerToolsSettings {
    pub enabled: bool,
    #[serde(default = "default_ttl")]
    pub grant_ttl_minutes: u32,
    #[serde(default)]
    pub blocklist: Vec<String>,
    /// Keys of the default entries taken off the list.
    #[serde(default)]
    pub blocklist_removed: Vec<String>,
    /// The default list as this platform names it — for the settings to
    /// show; read, never written.
    #[serde(default, skip_deserializing)]
    pub blocklist_defaults: Vec<DefaultBlockView>,
    /// The stop shortcut's spelling; empty when the person switched it off.
    #[serde(default = "default_stop_shortcut")]
    pub stop_shortcut: String,
    /// Whether the strip with Stop on it floats above every window while
    /// anything is shared.
    #[serde(default = "default_show_indicator")]
    pub show_indicator: bool,
    /// Whether an agent may have a window brought to the front for an action.
    #[serde(default = "default_allow_foreground")]
    pub allow_foreground: bool,
    /// What an action gets when the agent does not say; the front only while
    /// it is allowed, and kept as chosen while it is not.
    #[serde(default)]
    pub default_delivery: ActDelivery,
    /// Whether an agent may start applications and move or size a shared
    /// window.
    #[serde(default)]
    pub launch_enabled: bool,
    /// Whether an agent may read back what it put on the clipboard, and put
    /// text there.
    #[serde(default)]
    pub clipboard_enabled: bool,
    /// Whether the entire screen is offered in the share picker.
    #[serde(default)]
    pub screen_enabled: bool,
}

fn default_ttl() -> u32 {
    DEFAULT_GRANT_TTL_MINUTES
}

fn default_stop_shortcut() -> String {
    StopShortcut::default_for(Platform::current()).to_string()
}

fn default_show_indicator() -> bool {
    true
}

fn default_allow_foreground() -> bool {
    true
}

impl Default for ComputerToolsSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            grant_ttl_minutes: DEFAULT_GRANT_TTL_MINUTES,
            blocklist: Vec::new(),
            blocklist_removed: Vec::new(),
            blocklist_defaults: default_blocklist(Platform::current()),
            stop_shortcut: default_stop_shortcut(),
            show_indicator: default_show_indicator(),
            allow_foreground: default_allow_foreground(),
            default_delivery: ActDelivery::Background,
            launch_enabled: false,
            clipboard_enabled: false,
            screen_enabled: false,
        }
    }
}

impl ComputerToolsSettings {
    fn into_runtime_config(self) -> ComputerToolsConfig {
        ComputerToolsConfig {
            enabled: self.enabled,
            grant_ttl: (self.grant_ttl_minutes > 0)
                .then(|| Duration::from_secs(u64::from(self.grant_ttl_minutes) * 60)),
            blocklist: normalize_blocklist(self.blocklist),
            blocklist_removed: normalize_removed(self.blocklist_removed),
            stop_shortcut: StopShortcut::from_setting(&self.stop_shortcut, Platform::current()),
            show_indicator: self.show_indicator,
            allow_foreground: self.allow_foreground,
            default_delivery: self.default_delivery,
            launch_enabled: self.launch_enabled,
            clipboard_enabled: self.clipboard_enabled,
            screen_enabled: self.screen_enabled,
            // Kept by the runtime handle, not by the record.
            switched_off: 0,
        }
    }
}

/// A delivery as the record spells it; anything else reads as absent.
fn stored_delivery(stored: &str) -> Option<ActDelivery> {
    match stored {
        "background" => Some(ActDelivery::Background),
        "foreground" => Some(ActDelivery::Foreground),
        _ => None,
    }
}

/// A stop shortcut as the record keeps it: off (empty), or a shortcut this
/// platform accepts, written in the one order. Anything else is refused on
/// the way in; on the way out of the database it reads as whatever
/// [`StopShortcut::from_setting`] makes of it, so the record shows the
/// shortcut in force.
fn checked_stop_shortcut(spelling: &str) -> Result<String, AppCommandError> {
    if spelling.is_empty() {
        return Ok(String::new());
    }
    StopShortcut::parse(spelling, Platform::current())
        .map(|shortcut| shortcut.to_string())
        .map_err(|e| AppCommandError::configuration_invalid(format!("stop shortcut: {e}")))
}

fn stored_stop_shortcut(spelling: &str) -> String {
    StopShortcut::from_setting(spelling, Platform::current())
        .map(|shortcut| shortcut.to_string())
        .unwrap_or_default()
}

/// Trimmed, non-empty, de-duplicated entries in the order they were given.
fn normalize_blocklist(entries: Vec<String>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for entry in entries {
        let entry = entry.trim().to_string();
        if !entry.is_empty() && !out.iter().any(|e| e.eq_ignore_ascii_case(&entry)) {
            out.push(entry);
        }
    }
    out
}

/// The keys of default entries taken off the list, once each, in the order
/// given. A key no entry has is dropped: there is nothing it could take off.
fn normalize_removed(keys: Vec<String>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for key in keys {
        let key = key.trim().to_string();
        if is_default_key(&key) && !out.contains(&key) {
            out.push(key);
        }
    }
    out
}

/// Read the persisted keys, falling back to the defaults for a missing or
/// malformed value. Never errors hard.
pub async fn load_computer_tools_settings(conn: &DatabaseConnection) -> ComputerToolsSettings {
    let mut settings = ComputerToolsSettings::default();
    let get = |key: &'static str| async move {
        app_metadata_service::get_value(conn, key)
            .await
            .ok()
            .flatten()
    };
    if let Some(v) = get(KEY_COMPUTER_TOOLS_ENABLED)
        .await
        .and_then(|r| r.parse().ok())
    {
        settings.enabled = v;
    }
    if let Some(v) = get(KEY_COMPUTER_TOOLS_GRANT_TTL_MINUTES)
        .await
        .and_then(|r| r.parse().ok())
    {
        settings.grant_ttl_minutes = v;
    }
    if let Some(v) = get(KEY_COMPUTER_TOOLS_BLOCKLIST)
        .await
        .and_then(|r| serde_json::from_str::<Vec<String>>(&r).ok())
    {
        settings.blocklist = normalize_blocklist(v);
    }
    if let Some(v) = get(KEY_COMPUTER_TOOLS_BLOCKLIST_REMOVED)
        .await
        .and_then(|r| serde_json::from_str::<Vec<String>>(&r).ok())
    {
        settings.blocklist_removed = normalize_removed(v);
    }
    if let Some(v) = get(KEY_COMPUTER_TOOLS_STOP_SHORTCUT).await {
        settings.stop_shortcut = stored_stop_shortcut(&v);
    }
    if let Some(v) = get(KEY_COMPUTER_TOOLS_SHOW_INDICATOR)
        .await
        .and_then(|r| r.parse().ok())
    {
        settings.show_indicator = v;
    }
    if let Some(v) = get(KEY_COMPUTER_TOOLS_ALLOW_FOREGROUND)
        .await
        .and_then(|r| r.parse().ok())
    {
        settings.allow_foreground = v;
    }
    if let Some(v) = get(KEY_COMPUTER_TOOLS_DEFAULT_DELIVERY)
        .await
        .and_then(|r| stored_delivery(&r))
    {
        settings.default_delivery = v;
    }
    if let Some(v) = get(KEY_COMPUTER_TOOLS_LAUNCH_ENABLED)
        .await
        .and_then(|r| r.parse().ok())
    {
        settings.launch_enabled = v;
    }
    if let Some(v) = get(KEY_COMPUTER_TOOLS_CLIPBOARD_ENABLED)
        .await
        .and_then(|r| r.parse().ok())
    {
        settings.clipboard_enabled = v;
    }
    if let Some(v) = get(KEY_COMPUTER_TOOLS_SCREEN_ENABLED)
        .await
        .and_then(|r| r.parse().ok())
    {
        settings.screen_enabled = v;
    }
    settings
}

/// Pull settings from the DB onto the shared runtime handle. Idempotent — safe
/// on startup or after any save.
pub async fn apply_persisted_computer_tools_config(
    conn: &DatabaseConnection,
    config: &ComputerToolsRuntimeConfig,
) {
    let settings = load_computer_tools_settings(conn).await;
    config.set(settings.into_runtime_config()).await;
}

/// Serializes every write of this record — the whole-record writer and the
/// group switch — for the reason the browser's lock exists: the keys are
/// upserted separately, and the status popover and the settings form are two
/// writers one click apart.
static COMPUTER_TOOLS_WRITE_LOCK: std::sync::LazyLock<tokio::sync::Mutex<()>> =
    std::sync::LazyLock::new(|| tokio::sync::Mutex::new(()));

/// Move only the group switch, leaving the rest at whatever the database says
/// at the moment of the write. For the status popover.
pub async fn set_computer_tools_enabled_core(
    conn: &DatabaseConnection,
    config: &ComputerToolsRuntimeConfig,
    emitter: &EventEmitter,
    enabled: bool,
) -> Result<ComputerToolsSettings, AppCommandError> {
    let _guard = COMPUTER_TOOLS_WRITE_LOCK.lock().await;
    app_metadata_service::upsert_value(conn, KEY_COMPUTER_TOOLS_ENABLED, &enabled.to_string())
        .await
        .map_err(AppCommandError::from)?;
    let settings = load_computer_tools_settings(conn).await;
    config.set(settings.clone().into_runtime_config()).await;
    emit_event(emitter, COMPUTER_TOOLS_SETTINGS_CHANGED_EVENT, &settings);
    Ok(settings)
}

/// The preferences one write moves: each one given is written, each one
/// absent is left at whatever the database says.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComputerToolsPreferences {
    #[serde(default)]
    pub grant_ttl_minutes: Option<u32>,
    #[serde(default)]
    pub blocklist: Option<Vec<String>>,
    /// Keys of the default entries to leave off the list.
    #[serde(default)]
    pub blocklist_removed: Option<Vec<String>>,
    /// Empty switches the shortcut off.
    #[serde(default)]
    pub stop_shortcut: Option<String>,
    #[serde(default)]
    pub show_indicator: Option<bool>,
    #[serde(default)]
    pub allow_foreground: Option<bool>,
    #[serde(default)]
    pub default_delivery: Option<ActDelivery>,
    #[serde(default)]
    pub launch_enabled: Option<bool>,
    #[serde(default)]
    pub clipboard_enabled: Option<bool>,
    #[serde(default)]
    pub screen_enabled: Option<bool>,
}

/// Move the grant timeout, the user's blocklist (their additions and the
/// defaults they took off), the stop shortcut, the strip, whether a window
/// may be brought to the front and how an action goes by default — only the
/// ones given — leaving everything else at whatever the database says.
/// For the Computer use settings section, which edits these and not the
/// switch (that one lives with the other tool groups, and in the status
/// popover), and which sends only what the person changed: a form that
/// loaded before another window added a blocklist entry must not take it out
/// again by saving a new timeout.
pub async fn set_computer_tools_preferences_core(
    conn: &DatabaseConnection,
    config: &ComputerToolsRuntimeConfig,
    emitter: &EventEmitter,
    preferences: ComputerToolsPreferences,
) -> Result<ComputerToolsSettings, AppCommandError> {
    let ComputerToolsPreferences {
        grant_ttl_minutes,
        blocklist,
        blocklist_removed,
        stop_shortcut,
        show_indicator,
        allow_foreground,
        default_delivery,
        launch_enabled,
        clipboard_enabled,
        screen_enabled,
    } = preferences;
    let blocklist = blocklist
        .map(|list| serde_json::to_string(&normalize_blocklist(list)))
        .transpose()
        .map_err(|e| AppCommandError::configuration_invalid(e.to_string()))?;
    let blocklist_removed = blocklist_removed
        .map(|keys| serde_json::to_string(&normalize_removed(keys)))
        .transpose()
        .map_err(|e| AppCommandError::configuration_invalid(e.to_string()))?;
    let stop_shortcut = stop_shortcut
        .as_deref()
        .map(checked_stop_shortcut)
        .transpose()?;
    let writes: Vec<(&str, String)> = [
        grant_ttl_minutes.map(|m| (KEY_COMPUTER_TOOLS_GRANT_TTL_MINUTES, m.to_string())),
        blocklist.map(|list| (KEY_COMPUTER_TOOLS_BLOCKLIST, list)),
        blocklist_removed.map(|keys| (KEY_COMPUTER_TOOLS_BLOCKLIST_REMOVED, keys)),
        stop_shortcut.map(|s| (KEY_COMPUTER_TOOLS_STOP_SHORTCUT, s)),
        show_indicator.map(|on| (KEY_COMPUTER_TOOLS_SHOW_INDICATOR, on.to_string())),
        allow_foreground.map(|on| (KEY_COMPUTER_TOOLS_ALLOW_FOREGROUND, on.to_string())),
        default_delivery.map(|d| (KEY_COMPUTER_TOOLS_DEFAULT_DELIVERY, d.as_str().to_string())),
        launch_enabled.map(|on| (KEY_COMPUTER_TOOLS_LAUNCH_ENABLED, on.to_string())),
        clipboard_enabled.map(|on| (KEY_COMPUTER_TOOLS_CLIPBOARD_ENABLED, on.to_string())),
        screen_enabled.map(|on| (KEY_COMPUTER_TOOLS_SCREEN_ENABLED, on.to_string())),
    ]
    .into_iter()
    .flatten()
    .collect();
    let _guard = COMPUTER_TOOLS_WRITE_LOCK.lock().await;
    if writes.is_empty() {
        return Ok(load_computer_tools_settings(conn).await);
    }
    for (key, value) in writes {
        app_metadata_service::upsert_value(conn, key, &value)
            .await
            .map_err(AppCommandError::from)?;
    }
    let settings = load_computer_tools_settings(conn).await;
    config.set(settings.clone().into_runtime_config()).await;
    emit_event(emitter, COMPUTER_TOOLS_SETTINGS_CHANGED_EVENT, &settings);
    Ok(settings)
}

/// Persist + apply + broadcast the whole record. Shared by the Tauri command
/// and the HTTP handler.
pub async fn set_computer_tools_settings_core(
    conn: &DatabaseConnection,
    config: &ComputerToolsRuntimeConfig,
    emitter: &EventEmitter,
    desired: ComputerToolsSettings,
) -> Result<ComputerToolsSettings, AppCommandError> {
    let desired = ComputerToolsSettings {
        blocklist: normalize_blocklist(desired.blocklist),
        blocklist_removed: normalize_removed(desired.blocklist_removed),
        blocklist_defaults: default_blocklist(Platform::current()),
        stop_shortcut: checked_stop_shortcut(&desired.stop_shortcut)?,
        ..desired
    };
    let _guard = COMPUTER_TOOLS_WRITE_LOCK.lock().await;
    let blocklist = serde_json::to_string(&desired.blocklist)
        .map_err(|e| AppCommandError::configuration_invalid(e.to_string()))?;
    let blocklist_removed = serde_json::to_string(&desired.blocklist_removed)
        .map_err(|e| AppCommandError::configuration_invalid(e.to_string()))?;
    for (key, value) in [
        (KEY_COMPUTER_TOOLS_ENABLED, desired.enabled.to_string()),
        (
            KEY_COMPUTER_TOOLS_GRANT_TTL_MINUTES,
            desired.grant_ttl_minutes.to_string(),
        ),
        (KEY_COMPUTER_TOOLS_BLOCKLIST, blocklist),
        (KEY_COMPUTER_TOOLS_BLOCKLIST_REMOVED, blocklist_removed),
        (
            KEY_COMPUTER_TOOLS_STOP_SHORTCUT,
            desired.stop_shortcut.clone(),
        ),
        (
            KEY_COMPUTER_TOOLS_SHOW_INDICATOR,
            desired.show_indicator.to_string(),
        ),
        (
            KEY_COMPUTER_TOOLS_ALLOW_FOREGROUND,
            desired.allow_foreground.to_string(),
        ),
        (
            KEY_COMPUTER_TOOLS_DEFAULT_DELIVERY,
            desired.default_delivery.as_str().to_string(),
        ),
        (
            KEY_COMPUTER_TOOLS_LAUNCH_ENABLED,
            desired.launch_enabled.to_string(),
        ),
        (
            KEY_COMPUTER_TOOLS_CLIPBOARD_ENABLED,
            desired.clipboard_enabled.to_string(),
        ),
        (
            KEY_COMPUTER_TOOLS_SCREEN_ENABLED,
            desired.screen_enabled.to_string(),
        ),
    ] {
        app_metadata_service::upsert_value(conn, key, &value)
            .await
            .map_err(AppCommandError::from)?;
    }
    config.set(desired.clone().into_runtime_config()).await;
    emit_event(emitter, COMPUTER_TOOLS_SETTINGS_CHANGED_EVENT, &desired);
    Ok(desired)
}

// -------- Tauri commands -----------------------------------------------------

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn get_computer_tools_settings(
    #[cfg(feature = "tauri-runtime")] db: tauri::State<'_, crate::db::AppDatabase>,
) -> Result<ComputerToolsSettings, AppCommandError> {
    #[cfg(feature = "tauri-runtime")]
    {
        Ok(load_computer_tools_settings(&db.conn).await)
    }
    #[cfg(not(feature = "tauri-runtime"))]
    {
        Err(AppCommandError::configuration_invalid("tauri-only command"))
    }
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn set_computer_tools_settings(
    #[cfg(feature = "tauri-runtime")] app: tauri::AppHandle,
    #[cfg(feature = "tauri-runtime")] db: tauri::State<'_, crate::db::AppDatabase>,
    #[cfg(feature = "tauri-runtime")] config: tauri::State<'_, ComputerToolsRuntimeConfig>,
    settings: ComputerToolsSettings,
) -> Result<ComputerToolsSettings, AppCommandError> {
    #[cfg(feature = "tauri-runtime")]
    {
        let emitter = EventEmitter::Tauri(app);
        set_computer_tools_settings_core(&db.conn, &config, &emitter, settings).await
    }
    #[cfg(not(feature = "tauri-runtime"))]
    {
        let _ = settings;
        Err(AppCommandError::configuration_invalid("tauri-only command"))
    }
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn set_computer_tools_enabled(
    #[cfg(feature = "tauri-runtime")] app: tauri::AppHandle,
    #[cfg(feature = "tauri-runtime")] db: tauri::State<'_, crate::db::AppDatabase>,
    #[cfg(feature = "tauri-runtime")] config: tauri::State<'_, ComputerToolsRuntimeConfig>,
    enabled: bool,
) -> Result<ComputerToolsSettings, AppCommandError> {
    #[cfg(feature = "tauri-runtime")]
    {
        let emitter = EventEmitter::Tauri(app);
        set_computer_tools_enabled_core(&db.conn, &config, &emitter, enabled).await
    }
    #[cfg(not(feature = "tauri-runtime"))]
    {
        let _ = enabled;
        Err(AppCommandError::configuration_invalid("tauri-only command"))
    }
}

// One argument per preference, as the web handler takes them: the page sends
// the same flat object to both.
#[allow(clippy::too_many_arguments)]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn set_computer_tools_preferences(
    #[cfg(feature = "tauri-runtime")] app: tauri::AppHandle,
    #[cfg(feature = "tauri-runtime")] db: tauri::State<'_, crate::db::AppDatabase>,
    #[cfg(feature = "tauri-runtime")] config: tauri::State<'_, ComputerToolsRuntimeConfig>,
    grant_ttl_minutes: Option<u32>,
    blocklist: Option<Vec<String>>,
    blocklist_removed: Option<Vec<String>>,
    stop_shortcut: Option<String>,
    show_indicator: Option<bool>,
    allow_foreground: Option<bool>,
    default_delivery: Option<ActDelivery>,
    launch_enabled: Option<bool>,
    clipboard_enabled: Option<bool>,
    screen_enabled: Option<bool>,
) -> Result<ComputerToolsSettings, AppCommandError> {
    let preferences = ComputerToolsPreferences {
        grant_ttl_minutes,
        blocklist,
        blocklist_removed,
        stop_shortcut,
        show_indicator,
        allow_foreground,
        default_delivery,
        launch_enabled,
        clipboard_enabled,
        screen_enabled,
    };
    #[cfg(feature = "tauri-runtime")]
    {
        let emitter = EventEmitter::Tauri(app);
        set_computer_tools_preferences_core(&db.conn, &config, &emitter, preferences).await
    }
    #[cfg(not(feature = "tauri-runtime"))]
    {
        let _ = preferences;
        Err(AppCommandError::configuration_invalid("tauri-only command"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A user who never opens the switch has not handed anyone their screen.
    #[test]
    fn agents_cannot_see_the_desktop_until_someone_says_so() {
        let defaults = ComputerToolsSettings::default();
        assert!(!defaults.enabled);
        assert_eq!(defaults.grant_ttl_minutes, DEFAULT_GRANT_TTL_MINUTES);
        assert!(defaults.blocklist.is_empty());
        // Once it is on, an agent may bring a window to the front when it
        // asks; actions still go in the background unless it does.
        assert!(defaults.allow_foreground);
        assert_eq!(defaults.default_delivery, ActDelivery::Background);
        // Stop, though, is there from the start.
        assert_eq!(
            defaults.into_runtime_config().stop_shortcut,
            Some(StopShortcut::default_for(Platform::current()))
        );
    }

    /// Zero minutes is "no timeout", and blocklist entries are tidied without
    /// losing any.
    #[test]
    fn the_runtime_config_reads_the_record() {
        let cfg = ComputerToolsSettings {
            enabled: true,
            grant_ttl_minutes: 0,
            blocklist: vec![
                " com.example.Vault ".into(),
                String::new(),
                "COM.EXAMPLE.VAULT".into(),
                "keepass.exe".into(),
            ],
            blocklist_removed: vec![
                "1password".into(),
                "system-settings".into(),
                " 1password ".into(),
                "no-such-entry".into(),
            ],
            blocklist_defaults: Vec::new(),
            stop_shortcut: String::new(),
            show_indicator: false,
            allow_foreground: true,
            default_delivery: ActDelivery::Foreground,
            launch_enabled: true,
            clipboard_enabled: true,
            screen_enabled: true,
        }
        .into_runtime_config();
        assert!(cfg.launch_enabled);
        assert!(cfg.clipboard_enabled);
        assert!(cfg.screen_enabled);
        assert_eq!(cfg.grant_ttl, None);
        assert_eq!(cfg.blocklist, vec!["com.example.Vault", "keepass.exe"]);
        // Only a default is taken off, and once.
        assert_eq!(cfg.blocklist_removed, vec!["1password", "system-settings"]);
        assert_eq!(cfg.stop_shortcut, None);
        assert!(!cfg.show_indicator);
        assert!(cfg.allow_foreground);
        assert_eq!(cfg.default_delivery_in_force(), ActDelivery::Foreground);

        let cfg = ComputerToolsSettings::default().into_runtime_config();
        assert_eq!(cfg.grant_ttl, Some(Duration::from_secs(30 * 60)));
        assert!(cfg.show_indicator);
        assert!(cfg.allow_foreground);
        assert_eq!(cfg.default_delivery_in_force(), ActDelivery::Background);
    }

    /// Saving one preference leaves the other as another writer left it — a
    /// timeout saved from a form that loaded before a blocklist entry was
    /// added does not take the entry out again.
    #[tokio::test]
    async fn a_preference_write_touches_only_what_it_names() {
        let db = crate::db::test_helpers::fresh_in_memory_db().await;
        let config = ComputerToolsRuntimeConfig::new();
        let emitter = EventEmitter::Noop;
        let write = |preferences: ComputerToolsPreferences| {
            set_computer_tools_preferences_core(&db.conn, &config, &emitter, preferences)
        };
        write(ComputerToolsPreferences {
            blocklist: Some(vec!["com.example.Vault".into()]),
            blocklist_removed: Some(vec!["bitwarden".into()]),
            ..Default::default()
        })
        .await
        .unwrap();
        let saved = write(ComputerToolsPreferences {
            grant_ttl_minutes: Some(10),
            ..Default::default()
        })
        .await
        .unwrap();
        assert_eq!(saved.grant_ttl_minutes, 10);
        assert_eq!(saved.blocklist, vec!["com.example.Vault"]);
        assert_eq!(saved.blocklist_removed, vec!["bitwarden"]);
        assert!(saved.show_indicator);
        assert_eq!(config.snapshot().await.blocklist, vec!["com.example.Vault"]);
        assert_eq!(config.snapshot().await.blocklist_removed, vec!["bitwarden"]);
        let untouched = write(ComputerToolsPreferences::default()).await.unwrap();
        assert_eq!(untouched, saved);
        // The strip, alone.
        let hidden = write(ComputerToolsPreferences {
            show_indicator: Some(false),
            ..Default::default()
        })
        .await
        .unwrap();
        assert_eq!(
            hidden,
            ComputerToolsSettings {
                show_indicator: false,
                ..saved.clone()
            }
        );
        assert!(!config.snapshot().await.show_indicator);
        assert!(!load_computer_tools_settings(&db.conn).await.show_indicator);
        // The front, allowed unless switched off: a default chosen while it
        // is off is kept — and in force once it is back on.
        assert!(hidden.allow_foreground);
        let off = write(ComputerToolsPreferences {
            allow_foreground: Some(false),
            ..Default::default()
        })
        .await
        .unwrap();
        assert!(!off.allow_foreground);
        let stored = load_computer_tools_settings(&db.conn).await;
        assert!(!stored.allow_foreground);
        let chosen = write(ComputerToolsPreferences {
            default_delivery: Some(ActDelivery::Foreground),
            ..Default::default()
        })
        .await
        .unwrap();
        assert!(!chosen.allow_foreground);
        assert_eq!(chosen.default_delivery, ActDelivery::Foreground);
        assert_eq!(
            config.snapshot().await.default_delivery_in_force(),
            ActDelivery::Background
        );
        let allowed = write(ComputerToolsPreferences {
            allow_foreground: Some(true),
            ..Default::default()
        })
        .await
        .unwrap();
        assert_eq!(
            allowed,
            ComputerToolsSettings {
                allow_foreground: true,
                ..chosen.clone()
            }
        );
        assert_eq!(
            config.snapshot().await.default_delivery_in_force(),
            ActDelivery::Foreground
        );
        let reloaded = load_computer_tools_settings(&db.conn).await;
        assert!(reloaded.allow_foreground);
        assert_eq!(reloaded.default_delivery, ActDelivery::Foreground);
        // Back to the defaults: nothing added, nothing taken off.
        let restored = write(ComputerToolsPreferences {
            blocklist: Some(vec![]),
            blocklist_removed: Some(vec![]),
            ..Default::default()
        })
        .await
        .unwrap();
        assert!(restored.blocklist.is_empty() && restored.blocklist_removed.is_empty());
        assert!(!restored.blocklist_defaults.is_empty());
        assert!(!restored.show_indicator);
    }

    /// The stop shortcut is saved as the one spelling, switched off as empty,
    /// and a spelling that is no shortcut here is refused without touching
    /// what is stored.
    #[tokio::test]
    async fn the_stop_shortcut_is_checked_on_the_way_in() {
        let db = crate::db::test_helpers::fresh_in_memory_db().await;
        let config = ComputerToolsRuntimeConfig::new();
        let emitter = EventEmitter::Noop;
        let set = |spelling: &str| {
            set_computer_tools_preferences_core(
                &db.conn,
                &config,
                &emitter,
                ComputerToolsPreferences {
                    stop_shortcut: Some(spelling.to_string()),
                    ..Default::default()
                },
            )
        };
        let saved = set("Shift+Control+KeyK").await.unwrap();
        assert_eq!(saved.stop_shortcut, "Control+Shift+KeyK");
        assert_eq!(
            config.snapshot().await.stop_shortcut.map(|s| s.to_string()),
            Some("Control+Shift+KeyK".to_string())
        );
        for bad in [
            "Control+KeyK",
            "Control+Alt+MediaPlayPause",
            "Ctrl+Alt+KeyK",
        ] {
            assert!(set(bad).await.is_err(), "{bad} saved");
        }
        assert_eq!(
            load_computer_tools_settings(&db.conn).await.stop_shortcut,
            "Control+Shift+KeyK"
        );
        let off = set("").await.unwrap();
        assert_eq!(off.stop_shortcut, "");
        assert_eq!(config.snapshot().await.stop_shortcut, None);
    }

    /// A stored spelling this platform cannot register — a database carried
    /// over from another platform's codeg — reads as the default: the record
    /// shows the shortcut in force.
    #[tokio::test]
    async fn a_foreign_stored_shortcut_reads_as_the_default() {
        let db = crate::db::test_helpers::fresh_in_memory_db().await;
        app_metadata_service::upsert_value(
            &db.conn,
            KEY_COMPUTER_TOOLS_STOP_SHORTCUT,
            "Control+Alt+MediaPlayPause",
        )
        .await
        .unwrap();
        assert_eq!(
            load_computer_tools_settings(&db.conn).await.stop_shortcut,
            StopShortcut::default_for(Platform::current()).to_string()
        );
    }

    /// A record from before the timeout and blocklist existed still loads.
    #[test]
    fn an_older_record_takes_the_defaults() {
        let parsed: ComputerToolsSettings =
            serde_json::from_value(serde_json::json!({ "enabled": true })).unwrap();
        assert!(parsed.enabled);
        assert_eq!(parsed.grant_ttl_minutes, DEFAULT_GRANT_TTL_MINUTES);
        assert!(parsed.blocklist_removed.is_empty());
        assert_eq!(parsed.stop_shortcut, default_stop_shortcut());
        assert!(parsed.show_indicator);
        assert!(parsed.allow_foreground);
        assert_eq!(parsed.default_delivery, ActDelivery::Background);
    }

    /// A stored default delivery that is neither word reads as the
    /// background, like a missing one.
    #[tokio::test]
    async fn a_stored_delivery_that_is_no_delivery_reads_as_the_background() {
        let db = crate::db::test_helpers::fresh_in_memory_db().await;
        for (key, value) in [
            (KEY_COMPUTER_TOOLS_ALLOW_FOREGROUND, "true"),
            (KEY_COMPUTER_TOOLS_DEFAULT_DELIVERY, "Foreground"),
        ] {
            app_metadata_service::upsert_value(&db.conn, key, value)
                .await
                .unwrap();
        }
        let loaded = load_computer_tools_settings(&db.conn).await;
        assert!(loaded.allow_foreground);
        assert_eq!(loaded.default_delivery, ActDelivery::Background);
    }

    /// A stored removal of an entry no release knows reads as nothing taken
    /// off; every default one — System Settings included — is the person's
    /// to take off, and reads back once.
    #[tokio::test]
    async fn a_stored_removal_reads_back_the_defaults_it_names() {
        let db = crate::db::test_helpers::fresh_in_memory_db().await;
        app_metadata_service::upsert_value(
            &db.conn,
            KEY_COMPUTER_TOOLS_BLOCKLIST_REMOVED,
            r#"["system-settings","credential-prompts","gone","keepassxc","system-settings"]"#,
        )
        .await
        .unwrap();
        assert_eq!(
            load_computer_tools_settings(&db.conn)
                .await
                .blocklist_removed,
            vec!["system-settings", "credential-prompts", "keepassxc"]
        );
    }
}
