//! The window appearance mode (dark / light / system): the `app_metadata` row
//! behind it and the cached copy the desktop window builders read.
//!
//! Not desktop-only. The `invoke` command and the server's web route record the
//! same preference — a host app that embeds Codeg pushes its appearance through
//! whichever one it can reach — so this lives beside `commands::windows`
//! instead of inside it. `windows` needs the tauri stack and is gated behind
//! `tauri-runtime`; the row and its cache are not.

use std::sync::atomic::{AtomicU8, Ordering};

#[cfg(feature = "tauri-runtime")]
use sea_orm::DatabaseConnection;

use crate::app_error::AppCommandError;
use crate::db::service::app_metadata_service;

const APPEARANCE_MODE_DB_KEY: &str = "appearance_mode";

/// Encoded appearance mode: 0 = system (default), 1 = dark, 2 = light.
static CACHED_APPEARANCE_MODE: AtomicU8 = AtomicU8::new(0);

pub(crate) const MODE_SYSTEM: u8 = 0;
pub(crate) const MODE_DARK: u8 = 1;
pub(crate) const MODE_LIGHT: u8 = 2;

fn mode_from_str(s: &str) -> u8 {
    match s {
        "dark" => MODE_DARK,
        "light" => MODE_LIGHT,
        _ => MODE_SYSTEM,
    }
}

/// The mode as last recorded, for the desktop window builders: a window created
/// after the preference changed has to open on the new background, not the one
/// read at launch.
#[cfg(feature = "tauri-runtime")]
pub(crate) fn cached_mode() -> u8 {
    CACHED_APPEARANCE_MODE.load(Ordering::Relaxed)
}

/// Load the saved appearance mode from DB. Called once at startup, before any
/// window is created.
#[cfg(feature = "tauri-runtime")]
pub(crate) async fn load_saved(conn: &DatabaseConnection) {
    if let Ok(Some(raw)) = app_metadata_service::get_value(conn, APPEARANCE_MODE_DB_KEY).await {
        CACHED_APPEARANCE_MODE.store(mode_from_str(&raw), Ordering::Relaxed);
    }
}

/// Persist a mode and move the cached copy the window builders read, in one
/// place: the `invoke` command and the web route both go through here, so a
/// client that is not this desktop window can record the same preference.
pub(crate) async fn set_mode<C: sea_orm::ConnectionTrait>(
    conn: &C,
    mode: &str,
) -> Result<(), AppCommandError> {
    CACHED_APPEARANCE_MODE.store(mode_from_str(mode), Ordering::Relaxed);
    app_metadata_service::upsert_value(conn, APPEARANCE_MODE_DB_KEY, mode)
        .await
        .map_err(AppCommandError::from)
}
