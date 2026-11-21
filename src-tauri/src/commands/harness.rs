//! The Harness browse commands (the Discover section), a package's file by
//! its hash, and the SpaceRing image proxy.
//!
//! Each command is a `_core` function over a [`Harness`] — what both runtimes
//! and the tests call — and a thin Tauri command; the Web handlers are in
//! `web/handlers/harness.rs`. Names, arguments and answers are a contract with
//! the frontend (`src/lib/harness/api.ts`): JSON from the catalog goes through
//! unchanged, and every failure is a `Harness.errors.*` key
//! (`harness/error.rs`).
//!
//! With `CODEG_HARNESS=off`, `harness_status` says so and every other command
//! here fails with `Harness.errors.disabled` without making a request.

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use serde::Serialize;
use serde_json::Value;

use crate::app_error::AppCommandError;
use crate::harness::{Harness, ListQuery};
use crate::models::pet::PetSpriteAsset;

/// What `harness_status` answers.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HarnessStatus {
    /// `false` when the operator set `CODEG_HARNESS=off`.
    pub enabled: bool,
    /// The SpaceRing origin this backend talks to, without a trailing slash:
    /// what "view on the website" links are built on.
    pub origin: String,
}

/// Never fails, and never for being switched off: it is how the frontend
/// learns that it is.
pub fn harness_status_core(harness: &Harness) -> HarnessStatus {
    HarnessStatus {
        enabled: harness.enabled(),
        origin: harness.origin().as_str().to_string(),
    }
}

pub async fn harness_config_core(harness: &Harness) -> Result<Value, AppCommandError> {
    Ok(harness.config().await?)
}

pub async fn harness_list_core(
    harness: &Harness,
    query: ListQuery,
) -> Result<Value, AppCommandError> {
    Ok(harness.list(&query).await?)
}

pub async fn harness_item_core(
    harness: &Harness,
    item_ref: &str,
) -> Result<Value, AppCommandError> {
    Ok(harness.item(item_ref).await?)
}

/// The `versions` array, newest first.
pub async fn harness_versions_core(
    harness: &Harness,
    item_ref: &str,
) -> Result<Value, AppCommandError> {
    Ok(harness.versions(item_ref).await?)
}

/// The sanitized HTML fragment as text; `None` when the item has none.
pub async fn harness_readme_core(
    harness: &Harness,
    item_ref: &str,
) -> Result<Option<String>, AppCommandError> {
    Ok(harness.readme(item_ref).await?)
}

pub async fn harness_prompt_core(
    harness: &Harness,
    item_ref: &str,
) -> Result<String, AppCommandError> {
    Ok(harness.prompt(item_ref).await?)
}

/// One file of a package, by its SHA-256 (64 lowercase hex digits), as UTF-8
/// text of at most 256 KiB: an assistant's definition, a prompt's file.
pub async fn harness_blob_core(harness: &Harness, sha256: &str) -> Result<String, AppCommandError> {
    Ok(harness.blob(sha256).await?)
}

/// A picture kept on SpaceRing, in the shape the pet marketplace's image
/// proxy answers (`pet_marketplace_asset`): `{ mime, dataBase64 }`, which the
/// frontend turns into a blob URL.
pub async fn srn_asset_core(
    harness: &Harness,
    path: &str,
) -> Result<PetSpriteAsset, AppCommandError> {
    let asset = harness.asset(path).await?;
    Ok(PetSpriteAsset {
        mime: asset.mime,
        data_base64: BASE64.encode(&asset.bytes),
    })
}

#[cfg(feature = "tauri-runtime")]
mod tauri_commands {
    use super::*;

    /// The catalog as the desktop app is configured, with its cache in the
    /// data directory every other part of the app uses.
    fn harness(app: &tauri::AppHandle) -> Harness {
        use tauri::Manager;
        let data_dir = crate::paths::resolve_effective_data_dir(
            &app.path().app_data_dir().unwrap_or_default(),
        );
        Harness::from_env(&data_dir)
    }

    #[tauri::command]
    pub async fn harness_status(app: tauri::AppHandle) -> Result<HarnessStatus, AppCommandError> {
        Ok(harness_status_core(&harness(&app)))
    }

    #[tauri::command]
    pub async fn harness_config(app: tauri::AppHandle) -> Result<Value, AppCommandError> {
        harness_config_core(&harness(&app)).await
    }

    // The frontend sends the query's values as flat arguments, and only the
    // ones that are set.
    #[tauri::command]
    pub async fn harness_list(
        app: tauri::AppHandle,
        q: Option<String>,
        kind: Option<String>,
        tag: Option<String>,
        runtime: Option<String>,
        sort: Option<String>,
        cursor: Option<String>,
    ) -> Result<Value, AppCommandError> {
        let query = ListQuery {
            q,
            kind,
            tag,
            runtime,
            sort,
            cursor,
        };
        harness_list_core(&harness(&app), query).await
    }

    // `item_ref` is `itemRef` on the wire (`ref` is a Rust keyword).
    #[tauri::command]
    pub async fn harness_item(
        app: tauri::AppHandle,
        item_ref: String,
    ) -> Result<Value, AppCommandError> {
        harness_item_core(&harness(&app), &item_ref).await
    }

    #[tauri::command]
    pub async fn harness_versions(
        app: tauri::AppHandle,
        item_ref: String,
    ) -> Result<Value, AppCommandError> {
        harness_versions_core(&harness(&app), &item_ref).await
    }

    #[tauri::command]
    pub async fn harness_readme(
        app: tauri::AppHandle,
        item_ref: String,
    ) -> Result<Option<String>, AppCommandError> {
        harness_readme_core(&harness(&app), &item_ref).await
    }

    #[tauri::command]
    pub async fn harness_prompt(
        app: tauri::AppHandle,
        item_ref: String,
    ) -> Result<String, AppCommandError> {
        harness_prompt_core(&harness(&app), &item_ref).await
    }

    #[tauri::command]
    pub async fn harness_blob(
        app: tauri::AppHandle,
        sha256: String,
    ) -> Result<String, AppCommandError> {
        harness_blob_core(&harness(&app), &sha256).await
    }

    #[tauri::command]
    pub async fn srn_asset(
        app: tauri::AppHandle,
        path: String,
    ) -> Result<PetSpriteAsset, AppCommandError> {
        srn_asset_core(&harness(&app), &path).await
    }
}

#[cfg(feature = "tauri-runtime")]
pub use tauri_commands::*;
