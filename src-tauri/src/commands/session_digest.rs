use crate::{
    app_error::AppCommandError, db::service::session_digest_service as digest,
    web::event_bridge::EventEmitter,
};
use sea_orm::DatabaseConnection;
use serde::Deserialize;
use serde_json::Value;

#[derive(Debug, Deserialize)]
#[serde(
    tag = "operation",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum DigestAction {
    Read,
    Dismiss {
        revision: u64,
        title: String,
    },
    Reserve {
        revision: u64,
        question_id: String,
        option: String,
    },
    Release {
        token: String,
    },
}
pub async fn session_digest_action_core(
    db: &DatabaseConnection,
    emitter: &EventEmitter,
    id: i32,
    action: DigestAction,
) -> Result<Value, AppCommandError> {
    if !crate::commands::delegation::load_delegation_settings(db)
        .await
        .session_messaging_enabled
    {
        return if matches!(action, DigestAction::Read) {
            Ok(Value::Null)
        } else {
            Err(AppCommandError::configuration_invalid(
                "Session messaging is disabled",
            ))
        };
    }
    let changed = !matches!(action, DigestAction::Read);
    let value = match action {
        DigestAction::Read => serde_json::to_value(digest::read(db, id).await?)
            .map_err(|e| AppCommandError::configuration_invalid(e.to_string()))?,
        DigestAction::Dismiss { revision, title } => {
            serde_json::to_value(digest::dismiss(db, id, revision, &title).await?)
                .map_err(|e| AppCommandError::configuration_invalid(e.to_string()))?
        }
        DigestAction::Reserve {
            revision,
            question_id,
            option,
        } => serde_json::to_value(digest::reserve(db, id, revision, &question_id, &option).await?)
            .map_err(|e| AppCommandError::configuration_invalid(e.to_string()))?,
        DigestAction::Release { token } => {
            digest::release(db, id, &token).await?;
            Value::Null
        }
    };
    if changed {
        digest::broadcast(db, emitter, id).await;
    }
    Ok(value)
}
pub async fn session_brief_read_core(
    db: &DatabaseConnection,
    id: i32,
) -> Result<Value, AppCommandError> {
    if !crate::commands::delegation::load_delegation_settings(db)
        .await
        .session_messaging_enabled
    {
        return Ok(Value::Null);
    }
    let brief = crate::db::service::conversation_context_service::read_brief(db, id).await?;
    serde_json::to_value(brief).map_err(|e| AppCommandError::configuration_invalid(e.to_string()))
}
#[cfg(feature = "tauri-runtime")]
#[tauri::command]
pub async fn session_brief_read(
    db: tauri::State<'_, crate::db::AppDatabase>,
    conversation_id: i32,
) -> Result<Value, AppCommandError> {
    session_brief_read_core(&db.conn, conversation_id).await
}
#[cfg(feature = "tauri-runtime")]
#[tauri::command]
pub async fn session_digest_action(
    app: tauri::AppHandle,
    db: tauri::State<'_, crate::db::AppDatabase>,
    conversation_id: i32,
    action: DigestAction,
) -> Result<Value, AppCommandError> {
    session_digest_action_core(
        &db.conn,
        &EventEmitter::from_app(&app),
        conversation_id,
        action,
    )
    .await
}
