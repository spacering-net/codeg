use std::sync::Arc;

use axum::{extract::Extension, Json};
use serde::Deserialize;

use crate::app_error::AppCommandError;
use crate::app_state::AppState;
use crate::commands::model_catalog as catalog_commands;
use crate::model_catalog::{CatalogSettings, CatalogStatus, CatalogView};

// Wrapper structs to match Tauri's named parameter convention. In web mode the
// entire JSON body arrives as-is.

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GetModelCatalogParams {
    #[serde(default)]
    pub force: Option<bool>,
}

#[derive(Deserialize)]
pub struct UpdateModelCatalogSettingsParams {
    pub settings: CatalogSettings,
}

pub async fn get_model_catalog(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<GetModelCatalogParams>,
) -> Result<Json<CatalogView>, AppCommandError> {
    let view = catalog_commands::get_model_catalog_core(
        &state.data_dir,
        &state.db.conn,
        params.force.unwrap_or(false),
    )
    .await?;
    Ok(Json(view))
}

pub async fn refresh_model_catalog(
    Extension(state): Extension<Arc<AppState>>,
) -> Result<Json<CatalogStatus>, AppCommandError> {
    let status =
        catalog_commands::refresh_model_catalog_core(&state.data_dir, &state.db.conn).await?;
    Ok(Json(status))
}

pub async fn get_model_catalog_settings(
    Extension(state): Extension<Arc<AppState>>,
) -> Result<Json<CatalogSettings>, AppCommandError> {
    let settings = catalog_commands::load_model_catalog_settings_core(&state.db.conn).await?;
    Ok(Json(settings))
}

pub async fn update_model_catalog_settings(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<UpdateModelCatalogSettingsParams>,
) -> Result<Json<CatalogSettings>, AppCommandError> {
    let settings =
        catalog_commands::update_model_catalog_settings_core(&state.db.conn, params.settings)
            .await?;
    Ok(Json(settings))
}
