//! Axum handlers mirroring `commands::harness`: the Harness browse commands,
//! a package's file by its hash, and the SpaceRing image proxy, as a browser
//! or a remote workspace window reaches them. The requests to SpaceRing are
//! made by this server.

use std::sync::Arc;

use axum::{extract::Extension, Json};
use serde::Deserialize;
use serde_json::Value;

use crate::app_error::AppCommandError;
use crate::app_state::AppState;
use crate::commands::harness::{self as harness_commands, HarnessStatus};
use crate::harness::{Harness, ListQuery};
use crate::models::pet::PetSpriteAsset;

/// The catalog as this server is configured, with its cache in the server's
/// data directory.
fn harness(state: &AppState) -> Harness {
    Harness::from_env(&state.data_dir)
}

/// `{ itemRef }`, as the frontend names it.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemRefParams {
    pub item_ref: String,
}

/// `{ sha256 }`.
#[derive(Deserialize)]
pub struct BlobParams {
    pub sha256: String,
}

#[derive(Deserialize)]
pub struct AssetParams {
    pub path: String,
}

pub async fn harness_status(
    Extension(state): Extension<Arc<AppState>>,
) -> Result<Json<HarnessStatus>, AppCommandError> {
    Ok(Json(harness_commands::harness_status_core(&harness(
        &state,
    ))))
}

pub async fn harness_config(
    Extension(state): Extension<Arc<AppState>>,
) -> Result<Json<Value>, AppCommandError> {
    harness_commands::harness_config_core(&harness(&state))
        .await
        .map(Json)
}

pub async fn harness_list(
    Extension(state): Extension<Arc<AppState>>,
    Json(query): Json<ListQuery>,
) -> Result<Json<Value>, AppCommandError> {
    harness_commands::harness_list_core(&harness(&state), query)
        .await
        .map(Json)
}

pub async fn harness_item(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<ItemRefParams>,
) -> Result<Json<Value>, AppCommandError> {
    harness_commands::harness_item_core(&harness(&state), &params.item_ref)
        .await
        .map(Json)
}

pub async fn harness_versions(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<ItemRefParams>,
) -> Result<Json<Value>, AppCommandError> {
    harness_commands::harness_versions_core(&harness(&state), &params.item_ref)
        .await
        .map(Json)
}

pub async fn harness_readme(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<ItemRefParams>,
) -> Result<Json<Option<String>>, AppCommandError> {
    harness_commands::harness_readme_core(&harness(&state), &params.item_ref)
        .await
        .map(Json)
}

pub async fn harness_prompt(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<ItemRefParams>,
) -> Result<Json<String>, AppCommandError> {
    harness_commands::harness_prompt_core(&harness(&state), &params.item_ref)
        .await
        .map(Json)
}

pub async fn harness_blob(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<BlobParams>,
) -> Result<Json<String>, AppCommandError> {
    harness_commands::harness_blob_core(&harness(&state), &params.sha256)
        .await
        .map(Json)
}

pub async fn srn_asset(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<AssetParams>,
) -> Result<Json<PetSpriteAsset>, AppCommandError> {
    harness_commands::srn_asset_core(&harness(&state), &params.path)
        .await
        .map(Json)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// The frontend sends camelCase argument names, the ones the desktop
    /// commands take.
    #[test]
    fn arguments_are_read_as_the_frontend_names_them() {
        let params: ItemRefParams =
            serde_json::from_value(json!({ "itemRef": "anthropics/pdf" })).unwrap();
        assert_eq!(params.item_ref, "anthropics/pdf");
        assert!(
            serde_json::from_value::<ItemRefParams>(json!({ "item_ref": "anthropics/pdf" }))
                .is_err()
        );
        assert!(serde_json::from_value::<ItemRefParams>(json!({ "ref": "a/b" })).is_err());

        let params: AssetParams =
            serde_json::from_value(json!({ "path": "/api/avatars/u/a.png" })).unwrap();
        assert_eq!(params.path, "/api/avatars/u/a.png");

        let params: BlobParams =
            serde_json::from_value(json!({ "sha256": "9f2c0d1e".repeat(8) })).unwrap();
        assert_eq!(params.sha256, "9f2c0d1e".repeat(8));
    }
}
