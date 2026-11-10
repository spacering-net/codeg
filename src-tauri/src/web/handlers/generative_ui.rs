//! HTTP handlers for the generative-UI skill pack (`ui-render`) — the
//! web-mode mirror of the commands in `commands::generative_ui`, which they
//! call as is.

use axum::Json;
use serde::Deserialize;

use crate::app_error::AppCommandError;
use crate::commands::experts::{ExpertInstallStatus, LinkOp, LinkOpResult};
use crate::commands::generative_ui::{self as commands, GenerativeUiSkillInfo};

#[derive(Deserialize)]
pub struct ApplyLinksParams {
    pub ops: Vec<LinkOp>,
}

pub async fn generative_ui_skill_info() -> Result<Json<GenerativeUiSkillInfo>, AppCommandError> {
    Ok(Json(commands::generative_ui_skill_info().await?))
}

pub async fn generative_ui_list_all_install_statuses(
) -> Result<Json<Vec<ExpertInstallStatus>>, AppCommandError> {
    Ok(Json(
        commands::generative_ui_list_all_install_statuses().await?,
    ))
}

pub async fn generative_ui_apply_links(
    Json(params): Json<ApplyLinksParams>,
) -> Result<Json<Vec<LinkOpResult>>, AppCommandError> {
    Ok(Json(commands::generative_ui_apply_links(params.ops).await?))
}

pub async fn generative_ui_read_content() -> Result<Json<String>, AppCommandError> {
    Ok(Json(commands::generative_ui_read_content().await?))
}
