#[cfg(feature = "tauri-runtime")]
use crate::db::AppDatabase;
#[cfg(feature = "tauri-runtime")]
use crate::db::error::DbError;
#[cfg(feature = "tauri-runtime")]
use crate::db::service::message_queue_service::{self, QueueItemInput};
#[cfg(feature = "tauri-runtime")]
use crate::models::MessageQueueItem;
#[cfg(feature = "tauri-runtime")]
use crate::web::event_bridge::{emit_event, EventEmitter, MessageQueueChange, MESSAGE_QUEUE_CHANGED_EVENT};

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn message_queue_list(
    db: tauri::State<'_, AppDatabase>,
    owner_id: String,
) -> Result<Vec<MessageQueueItem>, DbError> {
    message_queue_service::list(&db.conn, &owner_id).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn message_queue_save(
    db: tauri::State<'_, AppDatabase>,
    app: tauri::AppHandle,
    owner_id: String,
    items: Vec<QueueItemInput>,
    origin: String,
) -> Result<(), DbError> {
    let saved = message_queue_service::save(&db.conn, &owner_id, items).await?;
    let emitter = EventEmitter::Tauri(app);
    emit_event(
        &emitter,
        MESSAGE_QUEUE_CHANGED_EVENT,
        MessageQueueChange {
            owner_id,
            origin,
            items: saved,
        },
    );
    Ok(())
}
