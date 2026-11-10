//! Assistants: create, edit, delete and order them. See
//! `db::service::assistant_service` for the row rules.
//!
//! Every write goes out to every window and WebSocket client on
//! `assistant://changed`, always carrying whole rows (never a partial update),
//! so a client that keeps the higher revision of each row converges no matter
//! which broadcasts it missed or in which order they arrived.

use std::collections::BTreeMap;

#[cfg(feature = "tauri-runtime")]
use tauri::State;

use crate::app_error::AppCommandError;
use crate::db::service::assistant_service::{self, AssistantError};
use crate::db::AppDatabase;
use crate::models::{AssistantDraft, AssistantInfo, AssistantPatch};
use crate::web::event_bridge::{
    emit_event, AssistantChange, EventEmitter, ASSISTANT_CHANGED_EVENT,
};

/// i18n keys the frontend resolves under its
/// `AcpAgentSettings.multiAgent.assistants` namespace, so a refusal reads in
/// the user's language instead of the English `message`.
const I18N_EMPTY_NAME: &str = "errors.emptyName";
const I18N_NAME_TOO_LONG: &str = "errors.nameTooLong";
const I18N_DUPLICATE_NAME: &str = "errors.duplicateName";
const I18N_DESCRIPTION_TOO_LONG: &str = "errors.descriptionTooLong";
const I18N_INSTRUCTIONS_TOO_LONG: &str = "errors.instructionsTooLong";
const I18N_INVALID_AVATAR: &str = "errors.invalidAvatar";
const I18N_AVATAR_TOO_LARGE: &str = "errors.avatarTooLarge";
const I18N_INVALID_AGENT_OPTIONS: &str = "errors.invalidAgentOptions";
const I18N_NOT_FOUND: &str = "errors.notFound";

fn no_params() -> BTreeMap<String, String> {
    BTreeMap::new()
}

impl From<AssistantError> for AppCommandError {
    fn from(err: AssistantError) -> Self {
        let message = err.to_string();
        match err {
            AssistantError::Db(db) => AppCommandError::from(db),
            AssistantError::EmptyName => {
                AppCommandError::invalid_input(message).with_i18n(I18N_EMPTY_NAME, no_params())
            }
            AssistantError::NameTooLong => AppCommandError::invalid_input(message).with_i18n(
                I18N_NAME_TOO_LONG,
                BTreeMap::from([(
                    "max".to_string(),
                    assistant_service::MAX_NAME_CHARS.to_string(),
                )]),
            ),
            AssistantError::DuplicateName(name) => AppCommandError::already_exists(message)
                .with_i18n(
                    I18N_DUPLICATE_NAME,
                    BTreeMap::from([("name".to_string(), name)]),
                ),
            AssistantError::DescriptionTooLong => AppCommandError::invalid_input(message)
                .with_i18n(
                    I18N_DESCRIPTION_TOO_LONG,
                    BTreeMap::from([(
                        "max".to_string(),
                        assistant_service::MAX_DESCRIPTION_CHARS.to_string(),
                    )]),
                ),
            AssistantError::InstructionsTooLong => AppCommandError::invalid_input(message)
                .with_i18n(
                    I18N_INSTRUCTIONS_TOO_LONG,
                    BTreeMap::from([(
                        "max".to_string(),
                        assistant_service::MAX_INSTRUCTIONS_CHARS.to_string(),
                    )]),
                ),
            AssistantError::InvalidAvatar(_) => {
                AppCommandError::invalid_input(message).with_i18n(I18N_INVALID_AVATAR, no_params())
            }
            AssistantError::AvatarTooLarge => AppCommandError::invalid_input(message)
                .with_i18n(I18N_AVATAR_TOO_LARGE, no_params()),
            AssistantError::InvalidAgentConfig(_) => AppCommandError::invalid_input(message)
                .with_i18n(I18N_INVALID_AGENT_OPTIONS, no_params()),
            AssistantError::NotFound(_) => {
                AppCommandError::not_found(message).with_i18n(I18N_NOT_FOUND, no_params())
            }
        }
    }
}

/// Writes run one at a time, from the database write through its broadcast,
/// so broadcasts go out in commit order. Clients already keep the higher
/// revision of each row whatever order they hear them in; this keeps the logs
/// and the tests easy to reason about.
static ASSISTANT_WRITE_LOCK: std::sync::LazyLock<tokio::sync::Mutex<()>> =
    std::sync::LazyLock::new(|| tokio::sync::Mutex::new(()));

fn emit_change(emitter: &EventEmitter, change: AssistantChange) {
    emit_event(emitter, ASSISTANT_CHANGED_EVENT, change);
}

/// Every assistant, tombstones included, in display order.
pub async fn assistant_list_core(db: &AppDatabase) -> Result<Vec<AssistantInfo>, AppCommandError> {
    assistant_service::list_all(&db.conn)
        .await
        .map_err(AppCommandError::from)
}

pub async fn assistant_create_core(
    emitter: &EventEmitter,
    db: &AppDatabase,
    draft: AssistantDraft,
) -> Result<AssistantInfo, AppCommandError> {
    let _one_at_a_time = ASSISTANT_WRITE_LOCK.lock().await;
    let assistant = assistant_service::create(&db.conn, &draft).await?;
    emit_change(
        emitter,
        AssistantChange::Upsert {
            assistant: Box::new(assistant.clone()),
        },
    );
    Ok(assistant)
}

pub async fn assistant_update_core(
    emitter: &EventEmitter,
    db: &AppDatabase,
    id: i32,
    patch: AssistantPatch,
) -> Result<AssistantInfo, AppCommandError> {
    let _one_at_a_time = ASSISTANT_WRITE_LOCK.lock().await;
    let assistant = assistant_service::update(&db.conn, id, &patch).await?;
    emit_change(
        emitter,
        AssistantChange::Upsert {
            assistant: Box::new(assistant.clone()),
        },
    );
    Ok(assistant)
}

/// Soft-delete, returning the tombstone — which also goes out as an upsert:
/// clients keep it so historical cards can still draw the assistant.
pub async fn assistant_delete_core(
    emitter: &EventEmitter,
    db: &AppDatabase,
    id: i32,
) -> Result<AssistantInfo, AppCommandError> {
    let _one_at_a_time = ASSISTANT_WRITE_LOCK.lock().await;
    let tombstone = assistant_service::soft_delete(&db.conn, id).await?;
    emit_change(
        emitter,
        AssistantChange::Upsert {
            assistant: Box::new(tombstone.clone()),
        },
    );
    Ok(tombstone)
}

/// Persist the order after a drag: `ids` is the complete list, first to last.
/// Returns, and broadcasts, the rows whose position changed; an order that
/// changes nothing writes and broadcasts nothing.
pub async fn assistant_reorder_core(
    emitter: &EventEmitter,
    db: &AppDatabase,
    ids: Vec<i32>,
) -> Result<Vec<AssistantInfo>, AppCommandError> {
    let _one_at_a_time = ASSISTANT_WRITE_LOCK.lock().await;
    let moved = assistant_service::reorder(&db.conn, &ids).await?;
    if !moved.is_empty() {
        emit_change(
            emitter,
            AssistantChange::Reordered {
                assistants: moved.clone(),
            },
        );
    }
    Ok(moved)
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn assistant_list(
    db: State<'_, AppDatabase>,
) -> Result<Vec<AssistantInfo>, AppCommandError> {
    assistant_list_core(&db).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn assistant_create(
    app: tauri::AppHandle,
    db: State<'_, AppDatabase>,
    draft: AssistantDraft,
) -> Result<AssistantInfo, AppCommandError> {
    assistant_create_core(&EventEmitter::Tauri(app), &db, draft).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn assistant_update(
    app: tauri::AppHandle,
    db: State<'_, AppDatabase>,
    id: i32,
    patch: AssistantPatch,
) -> Result<AssistantInfo, AppCommandError> {
    assistant_update_core(&EventEmitter::Tauri(app), &db, id, patch).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn assistant_delete(
    app: tauri::AppHandle,
    db: State<'_, AppDatabase>,
    id: i32,
) -> Result<AssistantInfo, AppCommandError> {
    assistant_delete_core(&EventEmitter::Tauri(app), &db, id).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn assistant_reorder(
    app: tauri::AppHandle,
    db: State<'_, AppDatabase>,
    ids: Vec<i32>,
) -> Result<Vec<AssistantInfo>, AppCommandError> {
    assistant_reorder_core(&EventEmitter::Tauri(app), &db, ids).await
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::time::Duration;

    use super::*;
    use crate::db::test_helpers::fresh_in_memory_db;
    use crate::models::assistant::selection;
    use crate::models::{
        AgentType, AssistantAgentConfig, AssistantAvatar, AssistantLabelSnapshot,
        AssistantOptionKind, AssistantOptionLabel,
    };
    use crate::web::event_bridge::WebEventBroadcaster;

    fn draft(name: &str) -> AssistantDraft {
        AssistantDraft {
            name: name.to_string(),
            description: String::new(),
            avatar: AssistantAvatar::Monogram {
                color: "teal".to_string(),
            },
            agent_config: AssistantAgentConfig {
                agent_type: AgentType::ClaudeCode,
                agent_options: selection(None, &[("model", "opus")]),
                label_snapshot: AssistantLabelSnapshot {
                    agent: "Claude Code".to_string(),
                    mode: None,
                    options: vec![AssistantOptionLabel {
                        id: "model".to_string(),
                        kind: AssistantOptionKind::Select,
                        name: "Model".to_string(),
                        value_label: "Opus".to_string(),
                    }],
                },
            },
            instructions: String::new(),
            enabled: true,
        }
    }

    fn setup() -> (
        EventEmitter,
        tokio::sync::broadcast::Receiver<crate::web::event_bridge::WebEvent>,
    ) {
        let broadcaster = Arc::new(WebEventBroadcaster::new());
        let rx = broadcaster.subscribe();
        (EventEmitter::test_web_only(broadcaster), rx)
    }

    #[tokio::test]
    async fn each_write_broadcasts_the_whole_row_exactly_once() {
        let (emitter, mut rx) = setup();
        let db = fresh_in_memory_db().await;

        let a = assistant_create_core(&emitter, &db, draft("Reviewer"))
            .await
            .expect("create");
        let evt = rx.try_recv().expect("create broadcasts");
        assert_eq!(evt.channel, ASSISTANT_CHANGED_EVENT);
        assert_eq!(evt.payload["kind"], "upsert");
        assert_eq!(evt.payload["assistant"]["id"], a.id);
        assert_eq!(evt.payload["assistant"]["revision"], 1);
        assert_eq!(evt.payload["assistant"]["agent_type"], "claude_code");
        assert!(rx.try_recv().is_err(), "exactly one broadcast per write");

        let b = assistant_create_core(&emitter, &db, draft("Writer"))
            .await
            .expect("create");
        rx.try_recv().expect("second create broadcasts");

        assistant_update_core(
            &emitter,
            &db,
            a.id,
            AssistantPatch {
                enabled: Some(false),
                ..Default::default()
            },
        )
        .await
        .expect("toggle");
        let evt = rx.try_recv().expect("update broadcasts");
        assert_eq!(evt.payload["kind"], "upsert");
        assert_eq!(evt.payload["assistant"]["enabled"], false);
        // The whole row, never just the field that changed.
        assert_eq!(evt.payload["assistant"]["name"], "Reviewer");
        assert_eq!(evt.payload["assistant"]["revision"], 2);
        assert!(rx.try_recv().is_err());

        let moved = assistant_reorder_core(&emitter, &db, vec![b.id, a.id])
            .await
            .expect("reorder");
        assert_eq!(moved.len(), 2);
        let evt = rx.try_recv().expect("reorder broadcasts");
        assert_eq!(evt.payload["kind"], "reordered");
        assert_eq!(evt.payload["assistants"].as_array().unwrap().len(), 2);
        assert_eq!(evt.payload["assistants"][0]["name"], "Writer");
        assert!(rx.try_recv().is_err());

        assistant_reorder_core(&emitter, &db, vec![b.id, a.id])
            .await
            .expect("same order");
        assert!(
            rx.try_recv().is_err(),
            "an order that changes nothing is silent"
        );

        let tomb = assistant_delete_core(&emitter, &db, a.id)
            .await
            .expect("delete");
        assert!(tomb.deleted_at.is_some());
        let evt = rx.try_recv().expect("delete broadcasts");
        assert_eq!(evt.payload["kind"], "upsert");
        assert!(evt.payload["assistant"]["deleted_at"].is_string());
        assert!(rx.try_recv().is_err());

        // A refused write broadcasts nothing.
        assistant_create_core(&emitter, &db, draft("writer"))
            .await
            .expect_err("duplicate name");
        assert!(rx.try_recv().is_err());
    }

    #[tokio::test]
    async fn a_write_waits_for_the_one_in_flight_to_broadcast() {
        let (emitter, mut rx) = setup();
        let db = fresh_in_memory_db().await;

        // Another write is between its database write and its broadcast.
        let in_flight = ASSISTANT_WRITE_LOCK.lock().await;
        let save = tokio::spawn(async move {
            let saved = assistant_create_core(&emitter, &db, draft("Reviewer")).await;
            (db, saved)
        });
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(
            !save.is_finished(),
            "the write went ahead of the one in flight"
        );
        assert!(rx.try_recv().is_err(), "nothing may go out meanwhile");

        drop(in_flight);
        let (db, saved) = save.await.expect("save task");
        let saved = saved.expect("save");
        let evt = rx.try_recv().expect("broadcast once its turn came");
        assert_eq!(evt.payload["assistant"]["id"], saved.id);
        assert_eq!(assistant_list_core(&db).await.expect("list"), vec![saved]);
    }

    #[test]
    fn refusals_carry_their_i18n_keys() {
        let err: AppCommandError = AssistantError::DuplicateName("Reviewer".to_string()).into();
        let json = serde_json::to_value(&err).unwrap();
        assert_eq!(json["i18n_key"], "errors.duplicateName");
        assert_eq!(json["i18n_params"]["name"], "Reviewer");

        let err: AppCommandError = AssistantError::NameTooLong.into();
        let json = serde_json::to_value(&err).unwrap();
        assert_eq!(json["i18n_key"], "errors.nameTooLong");
        assert_eq!(json["i18n_params"]["max"], "40");

        let err: AppCommandError = AssistantError::NotFound(3).into();
        assert_eq!(
            serde_json::to_value(&err).unwrap()["i18n_key"],
            "errors.notFound"
        );
    }
}
