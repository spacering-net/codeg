//! Verifies the m20260522 migration added `parent_tool_use_id` and
//! `delegation_call_id` columns on `conversation`, and they round-trip via the
//! SeaORM entity.

use codeg_lib::db::entities::conversation;
use codeg_lib::db::test_helpers::{fresh_in_memory_db, seed_folder};
use codeg_lib::models::agent::AgentType;
use sea_orm::{ActiveModelTrait, EntityTrait, NotSet, Set};

#[tokio::test]
async fn delegation_columns_round_trip() {
    let db = fresh_in_memory_db().await;
    let folder_id = seed_folder(&db, "/tmp/codeg-delegation-test").await;

    let agent_type_str = serde_json::to_value(AgentType::ClaudeCode)
        .unwrap()
        .as_str()
        .unwrap()
        .to_string();
    let now = chrono::Utc::now();
    let active = conversation::ActiveModel {
        id: NotSet,
        folder_id: Set(folder_id),
        title: Set(Some("delegation child".to_string())),
        title_locked: Set(false),
        agent_type: Set(agent_type_str),
        status: Set(conversation::ConversationStatus::InProgress),
        kind: Set(conversation::ConversationKind::Delegate),
        model: Set(None),
        git_branch: Set(None),
        external_id: Set(None),
        parent_id: Set(Some(42)),
        parent_tool_use_id: Set(Some("toolu_abc123".to_string())),
        delegation_call_id: Set(Some("00000000-0000-0000-0000-000000000001".to_string())),
        message_count: Set(0),
        created_at: Set(now),
        updated_at: Set(now),
        deleted_at: Set(None),
        pinned_at: Set(None),
        pin_order: Set(None),
        origin_cwd: Set(None),
    };
    let inserted = active.insert(&db.conn).await.expect("insert");
    let id = inserted.id;

    let fetched = conversation::Entity::find_by_id(id)
        .one(&db.conn)
        .await
        .expect("query ok")
        .expect("row exists");
    assert_eq!(fetched.parent_id, Some(42));
    assert_eq!(fetched.parent_tool_use_id.as_deref(), Some("toolu_abc123"));
    assert_eq!(
        fetched.delegation_call_id.as_deref(),
        Some("00000000-0000-0000-0000-000000000001")
    );
}

#[tokio::test]
async fn delegation_columns_default_to_null_on_existing_create() {
    let db = fresh_in_memory_db().await;
    let folder_id = seed_folder(&db, "/tmp/codeg-delegation-null").await;
    // The existing create helper does not set the new columns; verify they default to None.
    let conv_id =
        codeg_lib::db::test_helpers::seed_conversation(&db, folder_id, AgentType::ClaudeCode).await;
    let fetched = conversation::Entity::find_by_id(conv_id)
        .one(&db.conn)
        .await
        .expect("query ok")
        .expect("row exists");
    assert_eq!(fetched.parent_id, None);
    assert_eq!(fetched.parent_tool_use_id, None);
    assert_eq!(fetched.delegation_call_id, None);
}
