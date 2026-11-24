use std::sync::Arc;

use axum::{extract::Extension, Json};
use serde::Deserialize;

use crate::app_error::AppCommandError;
use crate::app_state::AppState;
use crate::commands::conversation_tags as tag_commands;
use crate::models::{ConversationBranchTag, ConversationTagDetail, DbConversationSummary};

pub async fn list_conversation_tags(
    Extension(state): Extension<Arc<AppState>>,
) -> Result<Json<Vec<ConversationTagDetail>>, AppCommandError> {
    Ok(Json(
        tag_commands::list_conversation_tags_core(&state.db).await?,
    ))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateConversationTagParams {
    /// Absent or null = a global tag.
    #[serde(default)]
    pub folder_id: Option<i32>,
    pub name: String,
    pub color: String,
}

pub async fn create_conversation_tag(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<CreateConversationTagParams>,
) -> Result<Json<ConversationTagDetail>, AppCommandError> {
    Ok(Json(
        tag_commands::create_conversation_tag_core(
            &state.emitter,
            &state.db,
            params.folder_id,
            params.name,
            params.color,
        )
        .await?,
    ))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateConversationTagParams {
    pub tag_id: i32,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub color: Option<String>,
}

pub async fn update_conversation_tag(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<UpdateConversationTagParams>,
) -> Result<Json<ConversationTagDetail>, AppCommandError> {
    Ok(Json(
        tag_commands::update_conversation_tag_core(
            &state.emitter,
            &state.db,
            params.tag_id,
            params.name,
            params.color,
        )
        .await?,
    ))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationTagIdParams {
    pub tag_id: i32,
}

pub async fn delete_conversation_tag(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<ConversationTagIdParams>,
) -> Result<Json<()>, AppCommandError> {
    tag_commands::delete_conversation_tag_core(&state.emitter, &state.db, params.tag_id).await?;
    Ok(Json(()))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReorderConversationTagsParams {
    pub tag_ids: Vec<i32>,
}

pub async fn reorder_conversation_tags(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<ReorderConversationTagsParams>,
) -> Result<Json<()>, AppCommandError> {
    tag_commands::reorder_conversation_tags_core(&state.emitter, &state.db, params.tag_ids)
        .await?;
    Ok(Json(()))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateConversationTagsParams {
    pub conversation_id: i32,
    #[serde(default)]
    pub add: Vec<i32>,
    #[serde(default)]
    pub remove: Vec<i32>,
}

pub async fn update_conversation_tags(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<UpdateConversationTagsParams>,
) -> Result<Json<DbConversationSummary>, AppCommandError> {
    Ok(Json(
        tag_commands::update_conversation_tags_core(
            &state.emitter,
            &state.db,
            params.conversation_id,
            params.add,
            params.remove,
        )
        .await?,
    ))
}

pub async fn get_conversation_branch_tag(
    Extension(state): Extension<Arc<AppState>>,
) -> Result<Json<ConversationBranchTag>, AppCommandError> {
    Ok(Json(
        tag_commands::get_conversation_branch_tag_core(&state.db).await?,
    ))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateConversationBranchTagParams {
    pub enabled: bool,
    pub color: String,
}

pub async fn update_conversation_branch_tag(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<UpdateConversationBranchTagParams>,
) -> Result<Json<ConversationBranchTag>, AppCommandError> {
    Ok(Json(
        tag_commands::update_conversation_branch_tag_core(
            &state.emitter,
            &state.db,
            params.enabled,
            params.color,
        )
        .await?,
    ))
}
