use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::OnceLock;

#[cfg(feature = "tauri-runtime")]
use tauri::State;

use crate::acp::connection::agent_delivers_wire_mcp;
use crate::acp::manager::ConnectionManager;
use crate::app_error::AppCommandError;
use crate::commands::acp::{build_session_runtime_env, verify_agent_installed};
use crate::commands::conversations::create_chat_conversation_core;
use crate::db::service::app_metadata_service::{get_value, upsert_value};
#[cfg(feature = "tauri-runtime")]
use crate::db::AppDatabase;
use crate::models::AgentType;
use crate::web::event_bridge::EventEmitter;

pub const ASSISTANT_OWNER_LABEL: &str = "assistant";

const KEY_AGENT_TYPE: &str = "assistant.agent_type";
const KEY_CONVERSATION_ID: &str = "assistant.conversation_id";
const KEY_ALLOW_SESSION_CONTROL: &str = "assistant.allow_session_control";
const KEY_ALLOW_PERMISSION_ANSWERS: &str = "assistant.allow_permission_answers";

pub const ASSISTANT_PRIMER: &str = "you are Codeg's workspace assistant; you are spoken to by voice; answer in 1-3 short spoken sentences without markdown or code; use the `codeg-mcp` tools `list_sessions`, `get_session_info`, `focus_session`, `send_to_session`, `cancel_session`, `answer_permission` and `start_session` to act on the user's other sessions; never claim an action happened unless the tool result says so.";

/// Serializes ensure/reset and remembers the live assistant connection as
/// `(conversation_id, connection_id)`. A fresh spawn is not linked to its
/// conversation until the first prompt, so it cannot be found by conversation.
static ENSURE_LOCK: OnceLock<tokio::sync::Mutex<Option<(i32, String)>>> = OnceLock::new();

fn ensure_lock() -> &'static tokio::sync::Mutex<Option<(i32, String)>> {
    ENSURE_LOCK.get_or_init(|| tokio::sync::Mutex::new(None))
}

async fn is_live_assistant(manager: &ConnectionManager, conn_id: &str) -> bool {
    manager.get_owner_window_label(conn_id).await.as_deref() == Some(ASSISTANT_OWNER_LABEL)
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssistantSettings {
    pub agent_type: Option<AgentType>,
    pub allow_session_control: bool,
    pub allow_permission_answers: bool,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssistantSession {
    pub connection_id: String,
    pub conversation_id: i32,
    pub folder_id: i32,
    pub agent_type: AgentType,
    pub primer: Option<String>,
}

pub async fn assistant_get_settings_core(
    db: &sea_orm::DatabaseConnection,
) -> Result<AssistantSettings, AppCommandError> {
    let agent_type_str = get_value(db, KEY_AGENT_TYPE)
        .await
        .map_err(AppCommandError::from)?;
    let agent_type =
        agent_type_str.and_then(|s| serde_json::from_str::<AgentType>(&format!("\"{s}\"")).ok());

    let allow_session_control = get_value(db, KEY_ALLOW_SESSION_CONTROL)
        .await
        .map_err(AppCommandError::from)?
        .as_deref()
        == Some("1");

    let allow_permission_answers = get_value(db, KEY_ALLOW_PERMISSION_ANSWERS)
        .await
        .map_err(AppCommandError::from)?
        .as_deref()
        == Some("1");

    Ok(AssistantSettings {
        agent_type,
        allow_session_control,
        allow_permission_answers,
    })
}

pub async fn assistant_set_settings_core(
    db: &sea_orm::DatabaseConnection,
    settings: AssistantSettings,
) -> Result<(), AppCommandError> {
    let current = assistant_get_settings_core(db).await?;

    if current.agent_type != settings.agent_type {
        upsert_value(db, KEY_CONVERSATION_ID, "")
            .await
            .map_err(AppCommandError::from)?;
    }

    let agent_str = settings
        .agent_type
        .map(|t| t.as_wire().to_string())
        .unwrap_or_default();
    upsert_value(db, KEY_AGENT_TYPE, &agent_str)
        .await
        .map_err(AppCommandError::from)?;

    upsert_value(
        db,
        KEY_ALLOW_SESSION_CONTROL,
        if settings.allow_session_control {
            "1"
        } else {
            "0"
        },
    )
    .await
    .map_err(AppCommandError::from)?;
    upsert_value(
        db,
        KEY_ALLOW_PERMISSION_ANSWERS,
        if settings.allow_permission_answers {
            "1"
        } else {
            "0"
        },
    )
    .await
    .map_err(AppCommandError::from)?;

    Ok(())
}

pub async fn assistant_reset_core(
    db: &sea_orm::DatabaseConnection,
    manager: &ConnectionManager,
) -> Result<(), AppCommandError> {
    let mut live = ensure_lock().lock().await;
    if let Some((_, conn_id)) = live.take() {
        if is_live_assistant(manager, &conn_id).await {
            let _ = manager.disconnect(&conn_id).await;
        }
    }
    let conv_id_str = get_value(db, KEY_CONVERSATION_ID)
        .await
        .map_err(AppCommandError::from)?;
    if let Some(conv_id) = conv_id_str.and_then(|s| s.parse::<i32>().ok()) {
        if let Some(conn_id) = manager.find_connection_by_conversation_id(conv_id).await {
            if is_live_assistant(manager, &conn_id).await {
                let _ = manager.disconnect(&conn_id).await;
            }
        }
    }
    upsert_value(db, KEY_CONVERSATION_ID, "")
        .await
        .map_err(AppCommandError::from)?;
    Ok(())
}

pub async fn assistant_ensure_core(
    db: &crate::db::AppDatabase,
    manager: &ConnectionManager,
    emitter: EventEmitter,
    data_dir: PathBuf,
) -> Result<AssistantSession, AppCommandError> {
    let mut live = ensure_lock().lock().await;

    let settings = assistant_get_settings_core(&db.conn).await?;
    let agent_type = settings
        .agent_type
        .ok_or_else(|| AppCommandError::invalid_input("assistant agent not configured"))?;

    if !agent_delivers_wire_mcp(agent_type) {
        return Err(AppCommandError::invalid_input(
            "agent does not support codeg-mcp companion",
        ));
    }

    let conv_id_str = get_value(&db.conn, KEY_CONVERSATION_ID)
        .await
        .map_err(AppCommandError::from)?;
    let mut conversation_id = conv_id_str.and_then(|s| s.parse::<i32>().ok());

    if let Some(id) = conversation_id {
        if crate::db::service::conversation_service::get_by_id(&db.conn, id)
            .await
            .is_err()
        {
            conversation_id = None;
        }
    }

    let mut primer = None;

    if conversation_id.is_none() {
        let title = "Codeg Assistant".to_string();
        let conv =
            create_chat_conversation_core(&db.conn, &data_dir, agent_type, Some(title), None)
                .await?;
        conversation_id = Some(conv.conversation_id);
        upsert_value(
            &db.conn,
            KEY_CONVERSATION_ID,
            &conv.conversation_id.to_string(),
        )
        .await
        .map_err(AppCommandError::from)?;
        primer = Some(ASSISTANT_PRIMER.to_string());
    }

    let conversation_id = conversation_id.unwrap();
    let conv = crate::db::service::conversation_service::get_by_id(&db.conn, conversation_id)
        .await
        .map_err(AppCommandError::from)?;

    let remembered = live
        .as_ref()
        .filter(|(conv, _)| *conv == conversation_id)
        .map(|(_, conn)| conn.clone());
    let linked = manager
        .find_connection_by_conversation_id(conversation_id)
        .await;
    for conn_id in remembered.into_iter().chain(linked) {
        if is_live_assistant(manager, &conn_id).await {
            *live = Some((conversation_id, conn_id.clone()));
            return Ok(AssistantSession {
                connection_id: conn_id,
                conversation_id,
                folder_id: conv.folder_id,
                agent_type,
                primer,
            });
        }
    }

    let resume_id = conv.external_id.clone();

    verify_agent_installed(agent_type)
        .await
        .map_err(|e| AppCommandError::task_execution_failed(e.to_string()))?;

    let env = build_session_runtime_env(db, agent_type, resume_id.as_deref(), &data_dir)
        .await
        .map_err(|e| AppCommandError::task_execution_failed(e.to_string()))?;

    let folder = crate::db::service::folder_service::get_folder_by_id(&db.conn, conv.folder_id)
        .await
        .map_err(AppCommandError::from)?
        .ok_or_else(|| AppCommandError::not_found("folder not found"))?;
    let folder_path = std::path::PathBuf::from(folder.path);

    let mut conn_id = None;
    let mut last_error = None;

    if let Some(ref rid) = resume_id {
        match manager
            .spawn_agent(
                agent_type,
                Some(folder_path.to_string_lossy().to_string()),
                Some(rid.clone()),
                env.clone(),
                ASSISTANT_OWNER_LABEL.to_string(),
                emitter.clone(),
                None,
                std::collections::BTreeMap::new(),
            )
            .await
        {
            Ok(info) => conn_id = Some(info),
            Err(e) => last_error = Some(e),
        }
    }

    if conn_id.is_none() {
        match manager
            .spawn_agent(
                agent_type,
                Some(folder_path.to_string_lossy().to_string()),
                None,
                env,
                ASSISTANT_OWNER_LABEL.to_string(),
                emitter,
                None,
                std::collections::BTreeMap::new(),
            )
            .await
        {
            Ok(info) => conn_id = Some(info),
            Err(e) => last_error = Some(e),
        }
    }

    if let Some(connection_id) = conn_id {
        *live = Some((conversation_id, connection_id.clone()));
        Ok(AssistantSession {
            connection_id,
            conversation_id,
            folder_id: conv.folder_id,
            agent_type,
            primer,
        })
    } else {
        Err(AppCommandError::task_execution_failed(
            last_error
                .map(|e| e.to_string())
                .unwrap_or_else(|| "failed to spawn assistant agent".to_string()),
        ))
    }
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn assistant_get_settings(
    db: State<'_, AppDatabase>,
) -> Result<AssistantSettings, AppCommandError> {
    assistant_get_settings_core(&db.conn).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn assistant_set_settings(
    db: State<'_, AppDatabase>,
    settings: AssistantSettings,
) -> Result<(), AppCommandError> {
    assistant_set_settings_core(&db.conn, settings).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn assistant_reset(
    db: State<'_, AppDatabase>,
    manager: State<'_, ConnectionManager>,
) -> Result<(), AppCommandError> {
    assistant_reset_core(&db.conn, &manager).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn assistant_ensure(
    app: tauri::AppHandle,
    db: State<'_, AppDatabase>,
    manager: State<'_, ConnectionManager>,
) -> Result<AssistantSession, AppCommandError> {
    let data_dir = crate::paths::codeg_home_dir();
    assistant_ensure_core(&db, &manager, EventEmitter::Tauri(app), data_dir).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::test_helpers::fresh_in_memory_db;

    #[tokio::test]
    async fn test_assistant_settings_roundtrip() {
        let db = fresh_in_memory_db().await;

        let defaults = assistant_get_settings_core(&db.conn).await.unwrap();
        assert_eq!(defaults.agent_type, None);
        assert!(!defaults.allow_session_control);
        assert!(!defaults.allow_permission_answers);

        let settings = AssistantSettings {
            agent_type: Some(AgentType::Codex),
            allow_session_control: true,
            allow_permission_answers: true,
        };
        assistant_set_settings_core(&db.conn, settings)
            .await
            .unwrap();

        let updated = assistant_get_settings_core(&db.conn).await.unwrap();
        assert_eq!(updated.agent_type, Some(AgentType::Codex));
        assert!(updated.allow_session_control);
        assert!(updated.allow_permission_answers);
    }

    #[tokio::test]
    async fn test_agent_change_clears_conversation_id() {
        let db = fresh_in_memory_db().await;

        assistant_set_settings_core(
            &db.conn,
            AssistantSettings {
                agent_type: Some(AgentType::Codex),
                allow_session_control: false,
                allow_permission_answers: false,
            },
        )
        .await
        .unwrap();

        upsert_value(&db.conn, KEY_CONVERSATION_ID, "42")
            .await
            .unwrap();

        assistant_set_settings_core(
            &db.conn,
            AssistantSettings {
                agent_type: Some(AgentType::ClaudeCode),
                allow_session_control: false,
                allow_permission_answers: false,
            },
        )
        .await
        .unwrap();

        let conv_id = get_value(&db.conn, KEY_CONVERSATION_ID)
            .await
            .unwrap()
            .unwrap_or_default();
        assert!(conv_id.is_empty(), "conversation id should be cleared");
    }

    #[tokio::test]
    async fn test_ensure_without_agent_errors() {
        let db = fresh_in_memory_db().await;
        let manager = ConnectionManager::new();
        let emitter = EventEmitter::Noop;

        let err = assistant_ensure_core(&db, &manager, emitter, PathBuf::from("/tmp"))
            .await
            .unwrap_err();
        assert_eq!(err.message, "assistant agent not configured");
    }

    #[tokio::test]
    async fn test_ensure_with_pi_errors() {
        let db = fresh_in_memory_db().await;
        assistant_set_settings_core(
            &db.conn,
            AssistantSettings {
                agent_type: Some(AgentType::Pi),
                allow_session_control: false,
                allow_permission_answers: false,
            },
        )
        .await
        .unwrap();

        let manager = ConnectionManager::new();
        let emitter = EventEmitter::Noop;

        let err = assistant_ensure_core(&db, &manager, emitter, PathBuf::from("/tmp"))
            .await
            .unwrap_err();
        assert_eq!(err.message, "agent does not support codeg-mcp companion");
    }
}
