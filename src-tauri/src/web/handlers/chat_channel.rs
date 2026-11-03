use std::sync::Arc;

use axum::{extract::Extension, Json};
use serde::Deserialize;

use crate::app_error::AppCommandError;
use crate::app_state::AppState;
use crate::chat_channel::backends::weixin::{WeixinQrcodeInfo, WeixinQrcodeStatusPublic};
use crate::chat_channel::webhook::WebhookConfig;
use crate::commands::chat_channel as cc_commands;
use crate::models::chat_channel::{ChannelStatusInfo, ChatChannelInfo, ChatChannelMessageLogInfo};

// ---------------------------------------------------------------------------
// Param structs
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateChatChannelParams {
    pub name: String,
    pub channel_type: String,
    pub config_json: String,
    pub enabled: bool,
    pub daily_report_enabled: bool,
    pub daily_report_time: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateChatChannelParams {
    pub id: i32,
    pub name: Option<String>,
    pub enabled: Option<bool>,
    pub config_json: Option<String>,
    pub event_filter_json: Option<Option<String>>,
    pub daily_report_enabled: Option<bool>,
    pub daily_report_time: Option<Option<String>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChannelIdParams {
    pub id: i32,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveTokenParams {
    pub channel_id: i32,
    pub token: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChannelIdOnlyParams {
    pub channel_id: i32,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListMessagesParams {
    pub channel_id: i32,
    pub limit: Option<u64>,
    pub offset: Option<u64>,
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

pub async fn list_chat_channels(
    Extension(state): Extension<Arc<AppState>>,
) -> Result<Json<Vec<ChatChannelInfo>>, AppCommandError> {
    let result = cc_commands::list_chat_channels_core(&state.db).await?;
    Ok(Json(result))
}

pub async fn create_chat_channel(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<CreateChatChannelParams>,
) -> Result<Json<ChatChannelInfo>, AppCommandError> {
    let result = cc_commands::create_chat_channel_core(
        &state.db,
        params.name,
        params.channel_type,
        params.config_json,
        params.enabled,
        params.daily_report_enabled,
        params.daily_report_time,
    )
    .await?;
    Ok(Json(result))
}

pub async fn update_chat_channel(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<UpdateChatChannelParams>,
) -> Result<Json<ChatChannelInfo>, AppCommandError> {
    let result = cc_commands::update_chat_channel_core(
        &state.db,
        params.id,
        params.name,
        params.enabled,
        params.config_json,
        params.event_filter_json,
        params.daily_report_enabled,
        params.daily_report_time,
    )
    .await?;
    Ok(Json(result))
}

pub async fn delete_chat_channel(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<ChannelIdParams>,
) -> Result<Json<()>, AppCommandError> {
    cc_commands::delete_chat_channel_core(&state.db, &state.chat_channel_manager, params.id)
        .await?;
    Ok(Json(()))
}

pub async fn save_chat_channel_token(
    Json(params): Json<SaveTokenParams>,
) -> Result<Json<()>, AppCommandError> {
    cc_commands::save_chat_channel_token_core(params.channel_id, &params.token)?;
    Ok(Json(()))
}

pub async fn get_chat_channel_has_token(
    Json(params): Json<ChannelIdOnlyParams>,
) -> Result<Json<bool>, AppCommandError> {
    let has = cc_commands::get_chat_channel_has_token_core(params.channel_id)?;
    Ok(Json(has))
}

pub async fn delete_chat_channel_token(
    Json(params): Json<ChannelIdOnlyParams>,
) -> Result<Json<()>, AppCommandError> {
    cc_commands::delete_chat_channel_token_core(params.channel_id)?;
    Ok(Json(()))
}

pub async fn connect_chat_channel(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<ChannelIdParams>,
) -> Result<Json<()>, AppCommandError> {
    cc_commands::connect_chat_channel_core(&state.db, &state.chat_channel_manager, params.id)
        .await?;
    Ok(Json(()))
}

pub async fn disconnect_chat_channel(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<ChannelIdParams>,
) -> Result<Json<()>, AppCommandError> {
    cc_commands::disconnect_chat_channel_core(&state.chat_channel_manager, params.id).await?;
    Ok(Json(()))
}

pub async fn test_chat_channel(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<ChannelIdParams>,
) -> Result<Json<()>, AppCommandError> {
    cc_commands::test_chat_channel_core(&state.db, params.id).await?;
    Ok(Json(()))
}

pub async fn get_chat_channel_status(
    Extension(state): Extension<Arc<AppState>>,
) -> Result<Json<Vec<ChannelStatusInfo>>, AppCommandError> {
    let result = cc_commands::get_chat_channel_status_core(&state.chat_channel_manager).await?;
    Ok(Json(result))
}

pub async fn list_chat_channel_messages(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<ListMessagesParams>,
) -> Result<Json<Vec<ChatChannelMessageLogInfo>>, AppCommandError> {
    let result = cc_commands::list_chat_channel_messages_core(
        &state.db,
        params.channel_id,
        params.limit,
        params.offset,
    )
    .await?;
    Ok(Json(result))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetCommandPrefixParams {
    pub prefix: String,
}

pub async fn get_chat_command_prefix(
    Extension(state): Extension<Arc<AppState>>,
) -> Result<Json<String>, AppCommandError> {
    let result = cc_commands::get_chat_command_prefix_core(&state.db).await?;
    Ok(Json(result))
}

pub async fn set_chat_command_prefix(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<SetCommandPrefixParams>,
) -> Result<Json<()>, AppCommandError> {
    cc_commands::set_chat_command_prefix_core(&state.db, params.prefix).await?;
    Ok(Json(()))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetEventFilterParams {
    pub filter: Option<Vec<String>>,
}

pub async fn get_chat_event_filter(
    Extension(state): Extension<Arc<AppState>>,
) -> Result<Json<Option<Vec<String>>>, AppCommandError> {
    let result = cc_commands::get_chat_event_filter_core(&state.db).await?;
    Ok(Json(result))
}

pub async fn set_chat_event_filter(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<SetEventFilterParams>,
) -> Result<Json<()>, AppCommandError> {
    cc_commands::set_chat_event_filter_core(&state.db, params.filter).await?;
    Ok(Json(()))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetEventWebhooksParams {
    pub webhooks: Vec<WebhookConfig>,
}

pub async fn get_chat_event_webhooks(
    Extension(state): Extension<Arc<AppState>>,
) -> Result<Json<Vec<WebhookConfig>>, AppCommandError> {
    let result = cc_commands::get_chat_event_webhooks_core(&state.db).await?;
    Ok(Json(result))
}

pub async fn set_chat_event_webhooks(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<SetEventWebhooksParams>,
) -> Result<Json<()>, AppCommandError> {
    cc_commands::set_chat_event_webhooks_core(&state.db, params.webhooks).await?;
    Ok(Json(()))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetEventTopLevelOnlyParams {
    pub enabled: bool,
}

pub async fn get_chat_event_top_level_only(
    Extension(state): Extension<Arc<AppState>>,
) -> Result<Json<bool>, AppCommandError> {
    let result = cc_commands::get_chat_event_top_level_only_core(&state.db).await?;
    Ok(Json(result))
}

pub async fn set_chat_event_top_level_only(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<SetEventTopLevelOnlyParams>,
) -> Result<Json<()>, AppCommandError> {
    cc_commands::set_chat_event_top_level_only_core(&state.db, params.enabled).await?;
    Ok(Json(()))
}

pub async fn get_chat_message_language(
    Extension(state): Extension<Arc<AppState>>,
) -> Result<Json<String>, AppCommandError> {
    let result = cc_commands::get_chat_message_language_core(&state.db).await?;
    Ok(Json(result))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetMessageLanguageParams {
    pub language: String,
}

pub async fn set_chat_message_language(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<SetMessageLanguageParams>,
) -> Result<Json<()>, AppCommandError> {
    cc_commands::set_chat_message_language_core(&state.db, params.language).await?;
    Ok(Json(()))
}

// ---------------------------------------------------------------------------
// WeChat QR code auth
// ---------------------------------------------------------------------------

pub async fn weixin_get_qrcode() -> Result<Json<WeixinQrcodeInfo>, AppCommandError> {
    let result = cc_commands::weixin_get_qrcode_core().await?;
    Ok(Json(result))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WeixinCheckQrcodeParams {
    pub channel_id: i32,
    pub qrcode: String,
}

pub async fn weixin_check_qrcode(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<WeixinCheckQrcodeParams>,
) -> Result<Json<WeixinQrcodeStatusPublic>, AppCommandError> {
    let result =
        cc_commands::weixin_check_qrcode_core(&state.db, params.channel_id, &params.qrcode).await?;
    Ok(Json(result))
}
