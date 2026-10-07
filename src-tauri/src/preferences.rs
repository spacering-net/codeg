//! User-scoped preferences stored at `~/.codeg/preferences.json`.
//!
//! These are settings that must be readable **before** the Tauri builder and
//! tokio runtime start (e.g. the webview rendering flags applied via
//! `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` on Windows and `WEBKIT_DISABLE_*`
//! on Linux). All access is synchronous I/O so the data must stay tiny.

use std::fs;
use std::io;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

const PREFERENCES_FILE_NAME: &str = "preferences.json";
const CODEG_DIR_NAME: &str = ".codeg";

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct AppPreferences {
    pub disable_hardware_acceleration: bool,
}

pub fn preferences_file_path() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(CODEG_DIR_NAME).join(PREFERENCES_FILE_NAME))
}

/// Read preferences synchronously. Missing / unreadable / malformed file
/// returns `Default::default()`. Errors are intentionally swallowed because
/// this is called on the startup hot-path; callers log if needed.
pub fn load() -> AppPreferences {
    let Some(path) = preferences_file_path() else {
        return AppPreferences::default();
    };
    match fs::read_to_string(&path) {
        Ok(raw) => serde_json::from_str(&raw).unwrap_or_default(),
        Err(err) if err.kind() == io::ErrorKind::NotFound => AppPreferences::default(),
        Err(err) => {
            tracing::error!("[Preferences] failed to read {}: {err}", path.display());
            AppPreferences::default()
        }
    }
}

pub fn save(prefs: &AppPreferences) -> io::Result<()> {
    let path = preferences_file_path()
        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "home directory unavailable"))?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let serialized = serde_json::to_string_pretty(prefs)
        .map_err(|err| io::Error::new(io::ErrorKind::InvalidData, err.to_string()))?;
    fs::write(&path, serialized)
}
