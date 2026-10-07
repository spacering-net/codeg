//! Conversation tags: defining them (global or per folder) and putting them on
//! conversations. See `db::service::conversation_tag_service` for the scope
//! rules.
//!
//! Two channels carry the results to every window and WebSocket client:
//! definition changes (and the branch tag setting) go out on
//! `conversation-tag://changed`, while a change to which tags a conversation
//! carries goes out as an ordinary `conversation://changed` upsert — the
//! summary's `tag_ids` is re-read by `get_by_id`, so it can never disagree with
//! the rest of the row.

use std::collections::BTreeMap;

#[cfg(feature = "tauri-runtime")]
use tauri::State;

use crate::app_error::AppCommandError;
use crate::db::service::conversation_service;
use crate::db::service::conversation_tag_service::{self, TagError};
use crate::db::AppDatabase;
use crate::models::{ConversationBranchTag, ConversationTagDetail, DbConversationSummary};
use crate::web::event_bridge::{
    emit_event, ConversationChange, ConversationTagChange, EventEmitter,
    CONVERSATION_CHANGED_EVENT, CONVERSATION_TAG_CHANGED_EVENT,
};

/// i18n keys the frontend resolves under its `ConversationTags` namespace, so a
/// refusal reads in the user's language instead of the English `message`.
const I18N_EMPTY_NAME: &str = "errors.emptyName";
const I18N_DUPLICATE_NAME: &str = "errors.duplicateName";
const I18N_INVALID_COLOR: &str = "errors.invalidColor";
const I18N_FOLDER_NOT_TAGGABLE: &str = "errors.folderNotTaggable";
const I18N_NOT_APPLICABLE: &str = "errors.notApplicable";
const I18N_TAG_NOT_FOUND: &str = "errors.tagNotFound";

fn no_params() -> BTreeMap<String, String> {
    BTreeMap::new()
}

impl From<TagError> for AppCommandError {
    fn from(err: TagError) -> Self {
        let message = err.to_string();
        match err {
            TagError::Db(db) => AppCommandError::from(db),
            TagError::EmptyName => {
                AppCommandError::invalid_input(message).with_i18n(I18N_EMPTY_NAME, no_params())
            }
            TagError::DuplicateName(name) => AppCommandError::already_exists(message)
                .with_i18n(I18N_DUPLICATE_NAME, BTreeMap::from([("name".to_string(), name)])),
            TagError::InvalidColor(_) => {
                AppCommandError::invalid_input(message).with_i18n(I18N_INVALID_COLOR, no_params())
            }
            TagError::FolderNotTaggable(_) => AppCommandError::invalid_input(message)
                .with_i18n(I18N_FOLDER_NOT_TAGGABLE, no_params()),
            TagError::NotApplicable { .. } => AppCommandError::invalid_input(message)
                .with_i18n(I18N_NOT_APPLICABLE, no_params()),
            TagError::TagNotFound(_) => {
                AppCommandError::not_found(message).with_i18n(I18N_TAG_NOT_FOUND, no_params())
            }
            TagError::FolderNotFound(_) | TagError::ConversationNotFound(_) => {
                AppCommandError::not_found(message)
            }
        }
    }
}

fn emit_tag_change(emitter: &EventEmitter, change: ConversationTagChange) {
    emit_event(emitter, CONVERSATION_TAG_CHANGED_EVENT, change);
}

pub async fn list_conversation_tags_core(
    db: &AppDatabase,
) -> Result<Vec<ConversationTagDetail>, AppCommandError> {
    conversation_tag_service::list_tags(&db.conn)
        .await
        .map_err(AppCommandError::from)
}

/// Create a tag. `folder_id = None` makes it global; otherwise it belongs to
/// that folder's family (a worktree child resolves to its root).
pub async fn create_conversation_tag_core(
    emitter: &EventEmitter,
    db: &AppDatabase,
    folder_id: Option<i32>,
    name: String,
    color: String,
) -> Result<ConversationTagDetail, AppCommandError> {
    let tag = conversation_tag_service::create_tag(&db.conn, folder_id, &name, &color).await?;
    emit_tag_change(emitter, ConversationTagChange::Upsert { tag: tag.clone() });
    Ok(tag)
}

pub async fn update_conversation_tag_core(
    emitter: &EventEmitter,
    db: &AppDatabase,
    tag_id: i32,
    name: Option<String>,
    color: Option<String>,
) -> Result<ConversationTagDetail, AppCommandError> {
    let tag = conversation_tag_service::update_tag(
        &db.conn,
        tag_id,
        name.as_deref(),
        color.as_deref(),
    )
    .await?;
    emit_tag_change(emitter, ConversationTagChange::Upsert { tag: tag.clone() });
    Ok(tag)
}

pub async fn delete_conversation_tag_core(
    emitter: &EventEmitter,
    db: &AppDatabase,
    tag_id: i32,
) -> Result<(), AppCommandError> {
    let removed = conversation_tag_service::delete_tag(&db.conn, tag_id).await?;
    if !removed {
        return Err(TagError::TagNotFound(tag_id).into());
    }
    emit_tag_change(emitter, ConversationTagChange::Deleted { id: tag_id });
    Ok(())
}

/// Persist one scope's order after a drag: `tag_ids` is that scope's complete
/// list, first to last.
pub async fn reorder_conversation_tags_core(
    emitter: &EventEmitter,
    db: &AppDatabase,
    tag_ids: Vec<i32>,
) -> Result<(), AppCommandError> {
    conversation_tag_service::reorder_tags(&db.conn, &tag_ids).await?;
    emit_tag_change(emitter, ConversationTagChange::Reordered);
    Ok(())
}

/// Put tags on / take tags off a conversation, then broadcast its fresh
/// summary to every client and return it to the caller.
pub async fn update_conversation_tags_core(
    emitter: &EventEmitter,
    db: &AppDatabase,
    conversation_id: i32,
    add: Vec<i32>,
    remove: Vec<i32>,
) -> Result<DbConversationSummary, AppCommandError> {
    conversation_tag_service::update_conversation_tags(&db.conn, conversation_id, &add, &remove)
        .await?;
    // The same fresh read every other upsert broadcasts (`get_by_id` fills
    // `tag_ids`), returned to the caller as well so it can settle its optimistic
    // patch without waiting for its own echo.
    let summary = conversation_service::get_by_id(&db.conn, conversation_id).await?;
    emit_event(
        emitter,
        CONVERSATION_CHANGED_EVENT,
        ConversationChange::Upsert {
            summary: Box::new(summary.clone()),
        },
    );
    Ok(summary)
}

/// Saves of the branch tag setting run one at a time, from the write through
/// its broadcast. Unserialized, two saves could land A-then-B in the database
/// but go out B-then-A — and since a client keeps the last broadcast it hears
/// (and skips its own reply once one has arrived), every client would settle
/// on A while B is stored, with nothing left to correct it.
static BRANCH_TAG_SAVE_LOCK: std::sync::LazyLock<tokio::sync::Mutex<()>> =
    std::sync::LazyLock::new(|| tokio::sync::Mutex::new(()));

pub async fn get_conversation_branch_tag_core(
    db: &AppDatabase,
) -> Result<ConversationBranchTag, AppCommandError> {
    conversation_tag_service::get_branch_tag(&db.conn)
        .await
        .map_err(AppCommandError::from)
}

/// Save the branch tag setting — whether every conversation's git branch is
/// drawn as a chip, and in which colour — and broadcast it as saved.
pub async fn update_conversation_branch_tag_core(
    emitter: &EventEmitter,
    db: &AppDatabase,
    enabled: bool,
    color: String,
) -> Result<ConversationBranchTag, AppCommandError> {
    let _one_at_a_time = BRANCH_TAG_SAVE_LOCK.lock().await;
    let setting = conversation_tag_service::set_branch_tag(&db.conn, enabled, &color).await?;
    emit_tag_change(
        emitter,
        ConversationTagChange::BranchTag {
            setting: setting.clone(),
        },
    );
    Ok(setting)
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn list_conversation_tags(
    db: State<'_, AppDatabase>,
) -> Result<Vec<ConversationTagDetail>, AppCommandError> {
    list_conversation_tags_core(&db).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn create_conversation_tag(
    app: tauri::AppHandle,
    db: State<'_, AppDatabase>,
    folder_id: Option<i32>,
    name: String,
    color: String,
) -> Result<ConversationTagDetail, AppCommandError> {
    create_conversation_tag_core(&EventEmitter::Tauri(app), &db, folder_id, name, color).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn update_conversation_tag(
    app: tauri::AppHandle,
    db: State<'_, AppDatabase>,
    tag_id: i32,
    name: Option<String>,
    color: Option<String>,
) -> Result<ConversationTagDetail, AppCommandError> {
    update_conversation_tag_core(&EventEmitter::Tauri(app), &db, tag_id, name, color).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn delete_conversation_tag(
    app: tauri::AppHandle,
    db: State<'_, AppDatabase>,
    tag_id: i32,
) -> Result<(), AppCommandError> {
    delete_conversation_tag_core(&EventEmitter::Tauri(app), &db, tag_id).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn reorder_conversation_tags(
    app: tauri::AppHandle,
    db: State<'_, AppDatabase>,
    tag_ids: Vec<i32>,
) -> Result<(), AppCommandError> {
    reorder_conversation_tags_core(&EventEmitter::Tauri(app), &db, tag_ids).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn update_conversation_tags(
    app: tauri::AppHandle,
    db: State<'_, AppDatabase>,
    conversation_id: i32,
    add: Vec<i32>,
    remove: Vec<i32>,
) -> Result<DbConversationSummary, AppCommandError> {
    update_conversation_tags_core(&EventEmitter::Tauri(app), &db, conversation_id, add, remove)
        .await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn get_conversation_branch_tag(
    db: State<'_, AppDatabase>,
) -> Result<ConversationBranchTag, AppCommandError> {
    get_conversation_branch_tag_core(&db).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn update_conversation_branch_tag(
    app: tauri::AppHandle,
    db: State<'_, AppDatabase>,
    enabled: bool,
    color: String,
) -> Result<ConversationBranchTag, AppCommandError> {
    update_conversation_branch_tag_core(&EventEmitter::Tauri(app), &db, enabled, color).await
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::time::Duration;

    use super::*;
    use crate::db::test_helpers::fresh_in_memory_db;
    use crate::web::event_bridge::WebEventBroadcaster;

    #[tokio::test]
    async fn a_branch_tag_save_waits_for_the_one_in_flight_to_broadcast() {
        let broadcaster = Arc::new(WebEventBroadcaster::new());
        let mut rx = broadcaster.subscribe();
        let emitter = EventEmitter::test_web_only(broadcaster.clone());
        let db = fresh_in_memory_db().await;

        // Another save is between its write and its broadcast.
        let in_flight = BRANCH_TAG_SAVE_LOCK.lock().await;
        let save = tokio::spawn(async move {
            let saved =
                update_conversation_branch_tag_core(&emitter, &db, true, "#0969da".to_string())
                    .await;
            (db, saved)
        });
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(
            !save.is_finished(),
            "the save went ahead of the one in flight"
        );
        assert!(rx.try_recv().is_err(), "nothing may go out meanwhile");

        drop(in_flight);
        let (db, saved) = save.await.expect("save task");
        let saved = saved.expect("save");
        assert_eq!(
            saved,
            ConversationBranchTag {
                enabled: true,
                color: "#0969da".to_string(),
            }
        );
        let evt = rx.try_recv().expect("broadcast once its turn came");
        assert_eq!(evt.channel, CONVERSATION_TAG_CHANGED_EVENT);
        let payload = &*evt.payload;
        assert_eq!(payload["kind"], "branch_tag");
        assert_eq!(payload["setting"]["color"], "#0969da");
        assert_eq!(
            get_conversation_branch_tag_core(&db)
                .await
                .expect("read back"),
            saved
        );
    }
}
