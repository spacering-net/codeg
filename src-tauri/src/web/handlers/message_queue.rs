use std::sync::Arc;

use axum::{extract::Extension, Json};
use serde::Deserialize;

use crate::app_error::AppCommandError;
use crate::app_state::AppState;
use crate::db::service::message_queue_service::{self, QueueItemInput};
use crate::models::MessageQueueItem;
use crate::web::event_bridge::{emit_event, MessageQueueChange, MESSAGE_QUEUE_CHANGED_EVENT};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListMessageQueueParams {
    pub owner_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveMessageQueueParams {
    pub owner_id: String,
    pub items: Vec<QueueItemInput>,
    pub origin: String,
}

pub async fn message_queue_list(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<ListMessageQueueParams>,
) -> Result<Json<Vec<MessageQueueItem>>, AppCommandError> {
    let result = message_queue_service::list(&state.db.conn, &params.owner_id)
        .await
        .map_err(AppCommandError::from)?;
    Ok(Json(result))
}

pub async fn message_queue_save(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<SaveMessageQueueParams>,
) -> Result<Json<()>, AppCommandError> {
    let saved = message_queue_service::save(&state.db.conn, &params.owner_id, params.items)
        .await
        .map_err(AppCommandError::from)?;
    emit_event(
        &state.emitter,
        MESSAGE_QUEUE_CHANGED_EVENT,
        MessageQueueChange {
            owner_id: params.owner_id,
            origin: params.origin,
            items: saved,
        },
    );
    Ok(Json(()))
}
