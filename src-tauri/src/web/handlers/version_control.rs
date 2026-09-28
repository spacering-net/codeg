use std::sync::Arc;

use axum::{extract::Extension, Json};
use serde::Deserialize;

use crate::app_error::AppCommandError;
use crate::app_state::AppState;
use crate::commands::version_control as vc_commands;
use crate::db::service::app_metadata_service;
use crate::models::*;

const GIT_SETTINGS_KEY: &str = "git_settings";
const GITHUB_ACCOUNTS_KEY: &str = "github_accounts";

// ---------------------------------------------------------------------------
// Param structs
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TestGitPathParams {
    pub path: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ValidateGitHubTokenParams {
    pub server_url: String,
    pub token: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountIdParams {
    pub account_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveAccountTokenParams {
    pub account_id: String,
    pub token: String,
}

#[derive(Deserialize)]
pub struct UpdateGitSettingsParams {
    pub settings: GitSettings,
}

#[derive(Deserialize)]
pub struct UpdateGitHubAccountsParams {
    pub settings: GitHubAccountsSettings,
}

// ---------------------------------------------------------------------------
// Git detection
// ---------------------------------------------------------------------------

pub async fn detect_git(
    Extension(state): Extension<Arc<AppState>>,
) -> Result<Json<GitDetectResult>, AppCommandError> {
    let db = &state.db;
    let result = vc_commands::detect_git_core(&db.conn).await?;
    Ok(Json(result))
}

pub async fn test_git_path(
    Json(params): Json<TestGitPathParams>,
) -> Result<Json<GitDetectResult>, AppCommandError> {
    let result = vc_commands::test_git_path(params.path).await?;
    Ok(Json(result))
}

// ---------------------------------------------------------------------------
// Git settings
// ---------------------------------------------------------------------------

pub async fn get_git_settings(
    Extension(state): Extension<Arc<AppState>>,
) -> Result<Json<GitSettings>, AppCommandError> {
    let db = &state.db;
    let raw = app_metadata_service::get_value(&db.conn, GIT_SETTINGS_KEY)
        .await
        .map_err(AppCommandError::from)?;

    let settings = match raw {
        Some(raw) => serde_json::from_str::<GitSettings>(&raw).map_err(|e| {
            AppCommandError::configuration_invalid("Failed to parse stored git settings")
                .with_detail(e.to_string())
        })?,
        None => GitSettings::default(),
    };
    Ok(Json(settings))
}

pub async fn update_git_settings(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<UpdateGitSettingsParams>,
) -> Result<Json<GitSettings>, AppCommandError> {
    let settings = params.settings;
    let db = &state.db;
    let serialized = serde_json::to_string(&settings).map_err(|e| {
        AppCommandError::invalid_input("Failed to serialize git settings")
            .with_detail(e.to_string())
    })?;

    app_metadata_service::upsert_value(&db.conn, GIT_SETTINGS_KEY, &serialized)
        .await
        .map_err(AppCommandError::from)?;

    Ok(Json(settings))
}

// ---------------------------------------------------------------------------
// GitHub accounts
// ---------------------------------------------------------------------------

pub async fn get_github_accounts(
    Extension(state): Extension<Arc<AppState>>,
) -> Result<Json<GitHubAccountsSettings>, AppCommandError> {
    let db = &state.db;
    let raw = app_metadata_service::get_value(&db.conn, GITHUB_ACCOUNTS_KEY)
        .await
        .map_err(AppCommandError::from)?;

    let settings = match raw {
        Some(raw) => serde_json::from_str::<GitHubAccountsSettings>(&raw).map_err(|e| {
            AppCommandError::configuration_invalid("Failed to parse stored GitHub accounts")
                .with_detail(e.to_string())
        })?,
        None => GitHubAccountsSettings::default(),
    };
    Ok(Json(settings))
}

pub async fn update_github_accounts(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<UpdateGitHubAccountsParams>,
) -> Result<Json<GitHubAccountsSettings>, AppCommandError> {
    let settings = params.settings;
    let db = &state.db;
    let serialized = serde_json::to_string(&settings).map_err(|e| {
        AppCommandError::invalid_input("Failed to serialize GitHub accounts")
            .with_detail(e.to_string())
    })?;

    app_metadata_service::upsert_value(&db.conn, GITHUB_ACCOUNTS_KEY, &serialized)
        .await
        .map_err(AppCommandError::from)?;

    Ok(Json(settings))
}

// ---------------------------------------------------------------------------
// GitHub token validation
// ---------------------------------------------------------------------------

pub async fn validate_github_token(
    Json(params): Json<ValidateGitHubTokenParams>,
) -> Result<Json<GitHubTokenValidation>, AppCommandError> {
    let result = vc_commands::validate_github_token(params.server_url, params.token).await?;
    Ok(Json(result))
}

/// Same request shape, different forge: GitLab takes a personal access token
/// (there is no `gh auth token` to lift one from) and reports its scopes on a
/// separate endpoint.
pub async fn validate_gitlab_token(
    Json(params): Json<ValidateGitHubTokenParams>,
) -> Result<Json<GitHubTokenValidation>, AppCommandError> {
    let result = vc_commands::validate_gitlab_token(params.server_url, params.token).await?;
    Ok(Json(result))
}

/// Same again for Gitea/Forgejo, which answers GitHub's `/user` shape behind a
/// `token` authorization header and reports no scopes at all.
pub async fn validate_gitea_token(
    Json(params): Json<ValidateGitHubTokenParams>,
) -> Result<Json<GitHubTokenValidation>, AppCommandError> {
    let result = vc_commands::validate_gitea_token(params.server_url, params.token).await?;
    Ok(Json(result))
}

// ---------------------------------------------------------------------------
// Keyring token management
// ---------------------------------------------------------------------------

pub async fn save_account_token(
    Json(params): Json<SaveAccountTokenParams>,
) -> Result<Json<()>, AppCommandError> {
    vc_commands::save_account_token(params.account_id, params.token).await?;
    Ok(Json(()))
}

pub async fn get_account_token(
    Json(params): Json<AccountIdParams>,
) -> Result<Json<Option<String>>, AppCommandError> {
    let result = vc_commands::get_account_token(params.account_id).await?;
    Ok(Json(result))
}

pub async fn delete_account_token(
    Json(params): Json<AccountIdParams>,
) -> Result<Json<()>, AppCommandError> {
    vc_commands::delete_account_token(params.account_id).await?;
    Ok(Json(()))
}
