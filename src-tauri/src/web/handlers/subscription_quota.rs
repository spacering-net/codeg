use axum::Json;

use crate::app_error::AppCommandError;
use crate::commands::subscription_quota::{
    read_claude_subscription_quota_core, read_codex_subscription_quota_core,
    read_cursor_subscription_quota_core, read_grok_subscription_quota_core,
    read_opencode_subscription_quota_core, OfficialQuotaRead,
};

pub async fn subscription_quota_codex() -> Result<Json<OfficialQuotaRead>, AppCommandError> {
    Ok(Json(read_codex_subscription_quota_core().await))
}

pub async fn subscription_quota_claude() -> Result<Json<OfficialQuotaRead>, AppCommandError> {
    Ok(Json(read_claude_subscription_quota_core().await))
}

pub async fn subscription_quota_grok() -> Result<Json<OfficialQuotaRead>, AppCommandError> {
    Ok(Json(read_grok_subscription_quota_core().await))
}

pub async fn subscription_quota_cursor() -> Result<Json<OfficialQuotaRead>, AppCommandError> {
    Ok(Json(read_cursor_subscription_quota_core().await))
}

pub async fn subscription_quota_opencode() -> Result<Json<OfficialQuotaRead>, AppCommandError> {
    Ok(Json(read_opencode_subscription_quota_core().await))
}
