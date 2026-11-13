use std::sync::Arc;

use sea_orm::{Database, EntityTrait};
use serde_json::{json, Value};

use super::*;
use crate::commands::conversations::{
    list_opened_tabs_core, save_opened_tabs_core, save_opened_tabs_with_panes_core,
};
use crate::db::service::{conversation_service, folder_service};
use crate::db::test_helpers::{fresh_disk_db, fresh_in_memory_db, seed_conversation, seed_folder};
use crate::db::AppDatabase;
use crate::models::pane::{Pane, PaneLayoutNode, PaneSplitOrientation};
use crate::web::event_bridge::{EventEmitter, WebEventBroadcaster, TABS_CHANGED_EVENT};

fn tab(folder: i32, conversation: i32) -> OpenedTab {
    OpenedTab {
        id: 0,
        folder_id: folder,
        conversation_id: Some(conversation),
        agent_type: AgentType::Codex,
        position: 0,
        is_active: true,
        is_pinned: false,
    }
}

fn pane(id: &str, tabs: &[OpenedTab]) -> Pane {
    let ids: Vec<_> = tabs.iter().filter_map(pane_state::canonical_id).collect();
    Pane {
        id: id.into(),
        name: "Pane 1".into(),
        layout: PaneLayoutNode::Group {
            id: "g-main".into(),
        },
        assignments: ids.iter().map(|id| (id.clone(), "g-main".into())).collect(),
        selection: ids
            .first()
            .map(|id| ("g-main".into(), id.clone()))
            .into_iter()
            .collect(),
        tile_by_group: [("g-main".into(), false)].into(),
        active: ids.first().cloned(),
    }
}

fn state(tabs: &[OpenedTab]) -> PaneState {
    PaneState {
        schema_version: 1,
        active_pane_id: "pane-main".into(),
        next_ordinal: 2,
        panes: vec![pane("pane-main", tabs)],
    }
}

async fn fixture() -> (AppDatabase, Vec<OpenedTab>) {
    let db = fresh_in_memory_db().await;
    let folder = seed_folder(&db, "/tmp/codeg-pane-backend").await;
    let first = seed_conversation(&db, folder, AgentType::Codex).await;
    let second = seed_conversation(&db, folder, AgentType::Codex).await;
    (db, vec![tab(folder, first), tab(folder, second)])
}

fn wire_tabs(tabs: &[OpenedTab]) -> Value {
    serde_json::to_value(tabs).unwrap()
}

#[tokio::test]
async fn pane_roundtrip_survives_restart_with_cross_project_split_and_empty_pane() {
    let dir = tempfile::tempdir().unwrap();
    let db = fresh_disk_db(dir.path()).await;
    let folder = seed_folder(&db, "/tmp/codeg-pane-one").await;
    let other = seed_folder(&db, "/tmp/codeg-pane-two").await;
    let tabs = vec![
        tab(
            folder,
            seed_conversation(&db, folder, AgentType::Codex).await,
        ),
        tab(other, seed_conversation(&db, other, AgentType::Codex).await),
    ];
    let mut panes = state(&tabs);
    let second_id = pane_state::canonical_id(&tabs[1]).unwrap();
    panes.panes[0].layout = PaneLayoutNode::Split {
        id: "s-one".into(),
        orientation: PaneSplitOrientation::Horizontal,
        children: vec![
            PaneLayoutNode::Group {
                id: "g-main".into(),
            },
            PaneLayoutNode::Group {
                id: "g-other".into(),
            },
        ],
        ratios: vec![0.4, 0.6],
    };
    panes.panes[0]
        .assignments
        .insert(second_id.clone(), "g-other".into());
    panes.panes[0].selection.insert("g-other".into(), second_id);
    panes.panes.push(pane("pane-empty", &[]));
    panes.active_pane_id = "pane-empty".into();
    panes.next_ordinal = 3;
    let saved = save_all_tabs_cas_with_panes(&db.conn, tabs, 0, Some(panes.clone()))
        .await
        .unwrap();
    assert!(saved.accepted);
    db.conn.close().await.unwrap();
    let conn = Database::connect(format!(
        "sqlite:{}?mode=rw",
        dir.path().join("source.db").display()
    ))
    .await
    .unwrap();
    let snapshot = snapshot_tabs_with_panes(&conn).await.unwrap();
    assert_eq!(snapshot.version, saved.version);
    assert_eq!(wire_tabs(&snapshot.items), wire_tabs(&saved.tabs));
    assert_eq!(snapshot.pane_state, Some(panes));
    conn.close().await.unwrap();
}

#[tokio::test]
async fn pane_empty_workspace_and_null_legacy_state_roundtrip() {
    let db = fresh_in_memory_db().await;
    assert!(snapshot_tabs_with_panes(&db.conn)
        .await
        .unwrap()
        .pane_state
        .is_none());
    let legacy = save_all_tabs_cas(&db.conn, vec![], 0).await.unwrap();
    assert!(legacy.pane_state.is_none());
    let panes = state(&[]);
    let saved = save_all_tabs_cas_with_panes(&db.conn, vec![], 1, Some(panes.clone()))
        .await
        .unwrap();
    assert!(saved.accepted);
    assert!(saved.tabs.is_empty());
    assert_eq!(saved.pane_state, Some(panes));
}

#[tokio::test]
async fn pane_concurrent_saves_have_one_winner_and_consistent_snapshot() {
    let (db, tabs) = fixture().await;
    let first = state(&tabs);
    let mut second = first.clone();
    second.panes[0].name = "另一个客户端".into();
    let (left, right) = tokio::join!(
        save_all_tabs_cas_with_panes(&db.conn, tabs.clone(), 0, Some(first)),
        save_all_tabs_cas_with_panes(&db.conn, tabs.clone(), 0, Some(second)),
    );
    let left = left.unwrap();
    let right = right.unwrap();
    assert_ne!(left.accepted, right.accepted);
    assert_eq!(left.version, 1);
    assert_eq!(right.version, 1);
    assert_eq!(left.pane_state, right.pane_state);
    assert_eq!(wire_tabs(&left.tabs), wire_tabs(&right.tabs));
    let snapshot = snapshot_tabs_with_panes(&db.conn).await.unwrap();
    assert_eq!(snapshot.pane_state, left.pane_state);
    assert_eq!(wire_tabs(&snapshot.items), wire_tabs(&left.tabs));
}

#[tokio::test]
async fn pane_duplicate_ownership_and_invalid_layouts_leave_tabs_version_and_events_unchanged() {
    let (db, tabs) = fixture().await;
    let broadcaster = Arc::new(WebEventBroadcaster::new());
    let emitter = EventEmitter::test_web_only(broadcaster.clone());
    let mut events = broadcaster.subscribe();
    let valid = state(&tabs);
    save_opened_tabs_with_panes_core(
        &db.conn,
        &emitter,
        tabs.clone(),
        0,
        "desktop".into(),
        Some(valid.clone()),
    )
    .await
    .unwrap();
    let event = events.try_recv().unwrap();
    assert_eq!(event.channel, TABS_CHANGED_EVENT);
    assert_eq!(event.payload["origin"], "desktop");
    assert_eq!(event.payload["version"], 1);
    assert_eq!(
        event.payload["pane_state"],
        serde_json::to_value(&valid).unwrap()
    );
    let before = snapshot_tabs_with_panes(&db.conn).await.unwrap();
    let mut invalid_states = Vec::new();
    let mut duplicate = valid.clone();
    duplicate.panes.push(pane("pane-other", &tabs));
    invalid_states.push(duplicate);
    for patch in [
        json!({"schemaVersion": 2}),
        json!({"activePaneId": "missing"}),
        json!({"nextOrdinal": 0}),
        json!({"panes": []}),
    ] {
        let mut wire = serde_json::to_value(&valid).unwrap();
        for (key, value) in patch.as_object().unwrap() {
            wire[key] = value.clone();
        }
        invalid_states.push(serde_json::from_value(wire).unwrap());
    }
    for mutate in [
        "name",
        "pane-id",
        "group",
        "selection",
        "active",
        "tile",
        "draft",
    ] {
        let mut invalid = valid.clone();
        let pane = &mut invalid.panes[0];
        match mutate {
            "name" => pane.name = " ".into(),
            "pane-id" => pane.id = "x".repeat(257),
            "group" => {
                pane.assignments.insert(
                    pane_state::canonical_id(&tabs[0]).unwrap(),
                    "missing".into(),
                );
            }
            "selection" => {
                pane.selection
                    .insert("missing".into(), pane.active.clone().unwrap());
            }
            "active" => pane.active = Some("missing".into()),
            "tile" => {
                pane.tile_by_group.insert("missing".into(), true);
            }
            "draft" => {
                pane.assignments
                    .insert("new-local-draft".into(), "g-main".into());
            }
            _ => unreachable!(),
        }
        invalid_states.push(invalid);
    }
    for (children, ratios) in [
        (vec![], vec![]),
        (vec!["g-main"], vec![1.0]),
        (vec!["g-main", "g-other"], vec![0.0, 1.0]),
        (vec!["g-main", "g-other"], vec![-0.1, 1.1]),
        (vec!["g-main", "g-other"], vec![0.2, 0.2]),
        (vec!["g-main", "g-other"], vec![1.0]),
        (vec!["g-main", "g-main"], vec![0.5, 0.5]),
        (vec!["g-main", "g-other"], vec![f64::NAN, 0.5]),
        (vec!["g-main", "g-other"], vec![f64::INFINITY, 0.5]),
    ] {
        let mut invalid = valid.clone();
        invalid.panes[0].layout = PaneLayoutNode::Split {
            id: "s-bad".into(),
            orientation: PaneSplitOrientation::Vertical,
            children: children
                .into_iter()
                .map(|id| PaneLayoutNode::Group { id: id.into() })
                .collect(),
            ratios,
        };
        invalid_states.push(invalid);
    }
    let mut duplicate_pane = valid.clone();
    duplicate_pane.panes.push(pane("pane-main", &[]));
    invalid_states.push(duplicate_pane);
    let mut oversized_name = valid.clone();
    oversized_name.panes[0].name = "x".repeat(513);
    invalid_states.push(oversized_name);
    let mut oversized = valid.clone();
    oversized.panes = (0..65)
        .map(|index| pane(&format!("pane-{index}"), &[]))
        .collect();
    invalid_states.push(oversized);
    let mut too_deep = PaneLayoutNode::Group {
        id: "g-main".into(),
    };
    for index in 0..18 {
        too_deep = PaneLayoutNode::Split {
            id: format!("s-{index}"),
            orientation: PaneSplitOrientation::Horizontal,
            children: vec![
                too_deep,
                PaneLayoutNode::Group {
                    id: format!("g-{index}"),
                },
            ],
            ratios: vec![0.5, 0.5],
        };
    }
    let mut invalid_depth = valid.clone();
    invalid_depth.panes[0].layout = too_deep;
    invalid_states.push(invalid_depth);
    for invalid in invalid_states {
        let error = save_opened_tabs_with_panes_core(
            &db.conn,
            &emitter,
            tabs.clone(),
            1,
            "bad".into(),
            Some(invalid),
        )
        .await
        .unwrap_err();
        assert!(error.to_string().contains("pane_state"), "{error}");
        let after = snapshot_tabs_with_panes(&db.conn).await.unwrap();
        assert_eq!(after.version, before.version);
        assert_eq!(after.pane_state, before.pane_state);
        assert_eq!(wire_tabs(&after.items), wire_tabs(&before.items));
        assert!(events.try_recv().is_err());
    }
    let duplicate_tabs = vec![tabs[0].clone(), tabs[0].clone()];
    assert!(
        save_all_tabs_cas_with_panes(&db.conn, duplicate_tabs, 1, Some(valid))
            .await
            .is_err()
    );
    assert_eq!(get_tabs_version(&db.conn).await.unwrap(), 1);
}

#[tokio::test]
async fn pane_failed_tab_write_rolls_back_metadata_tabs_and_version() {
    let (db, tabs) = fixture().await;
    let original = state(&tabs);
    let saved = save_all_tabs_cas_with_panes(&db.conn, tabs.clone(), 0, Some(original.clone()))
        .await
        .unwrap();
    let bad = tab(tabs[0].folder_id, i32::MAX);
    let failed =
        save_all_tabs_cas_with_panes(&db.conn, vec![bad.clone()], 1, Some(state(&[bad]))).await;
    assert!(failed.is_err());
    let snapshot = snapshot_tabs_with_panes(&db.conn).await.unwrap();
    assert_eq!(snapshot.version, 1);
    assert_eq!(snapshot.pane_state, Some(original));
    assert_eq!(wire_tabs(&snapshot.items), wire_tabs(&saved.tabs));
}

#[tokio::test]
async fn pane_legacy_new_tab_uses_active_group_and_drafts_never_enter_assignments() {
    let (db, tabs) = fixture().await;
    let mut panes = state(&tabs[..1]);
    panes.panes[0].layout = PaneLayoutNode::Split {
        id: "s-main".into(),
        orientation: PaneSplitOrientation::Horizontal,
        children: vec![
            PaneLayoutNode::Group {
                id: "g-first".into(),
            },
            PaneLayoutNode::Group {
                id: "g-main".into(),
            },
        ],
        ratios: vec![0.5, 0.5],
    };
    save_all_tabs_cas_with_panes(&db.conn, tabs[..1].to_vec(), 0, Some(panes))
        .await
        .unwrap();
    let mut draft = tabs[0].clone();
    draft.conversation_id = None;
    let saved = save_all_tabs_cas(&db.conn, vec![tabs[0].clone(), tabs[1].clone(), draft], 1)
        .await
        .unwrap();
    assert_eq!(saved.tabs.len(), 2);
    let pane = &saved.pane_state.as_ref().unwrap().panes[0];
    assert_eq!(pane.assignments.len(), 2);
    assert_eq!(
        pane.assignments[&pane_state::canonical_id(&tabs[1]).unwrap()],
        "g-main"
    );
    assert_eq!(
        pane.active,
        Some(pane_state::canonical_id(&tabs[0]).unwrap())
    );
}

#[test]
fn pane_custom_agent_canonical_id_uses_wire_slug_with_hyphens() {
    let mut custom = tab(2, 9);
    custom.agent_type = AgentType::custom("pane-custom-agent").unwrap();
    let id = pane_state::canonical_id(&custom).unwrap();
    assert_eq!(id, "conv-2-custom:pane-custom-agent-9");
    let panes = state(&[custom.clone()]);
    pane_state::validate_stored(&panes).unwrap();
    custom.folder_id = 3;
    let normalized = pane_state::normalize(panes, &[custom]);
    assert!(normalized.panes[0]
        .assignments
        .contains_key("conv-3-custom:pane-custom-agent-9"));
}

#[tokio::test]
async fn pane_stale_cas_returns_authoritative_layout_without_broadcast_or_overwrite() {
    let (db, tabs) = fixture().await;
    let broadcaster = Arc::new(WebEventBroadcaster::new());
    let emitter = EventEmitter::test_web_only(broadcaster.clone());
    let mut events = broadcaster.subscribe();
    let original = state(&tabs);
    save_opened_tabs_with_panes_core(
        &db.conn,
        &emitter,
        tabs.clone(),
        0,
        "a".into(),
        Some(original.clone()),
    )
    .await
    .unwrap();
    let mut changed = original.clone();
    changed.panes[0].name = "更新后的布局".into();
    let winner = save_opened_tabs_with_panes_core(
        &db.conn,
        &emitter,
        tabs.clone(),
        1,
        "b".into(),
        Some(changed.clone()),
    )
    .await
    .unwrap();
    events.try_recv().unwrap();
    events.try_recv().unwrap();
    let stale =
        save_opened_tabs_with_panes_core(&db.conn, &emitter, vec![], 1, "a".into(), Some(original))
            .await
            .unwrap();
    assert!(!stale.accepted);
    assert_eq!(stale.version, winner.version);
    assert_eq!(stale.pane_state, Some(changed));
    assert_eq!(wire_tabs(&stale.tabs), wire_tabs(&winner.tabs));
    assert!(events.try_recv().is_err());
}

#[tokio::test]
async fn pane_legacy_save_preserves_layout_prunes_closed_tabs_and_adds_to_current_group() {
    let (db, tabs) = fixture().await;
    let mut panes = state(&tabs[..1]);
    panes.panes.push(pane("pane-other", &tabs[1..]));
    panes.active_pane_id = "pane-other".into();
    save_all_tabs_cas_with_panes(&db.conn, tabs.clone(), 0, Some(panes.clone()))
        .await
        .unwrap();
    let extra = tab(
        tabs[0].folder_id,
        seed_conversation(&db, tabs[0].folder_id, AgentType::Codex).await,
    );
    let updated = save_opened_tabs_core(
        &db.conn,
        &EventEmitter::Noop,
        vec![tabs[1].clone(), extra.clone()],
        1,
        "legacy".into(),
    )
    .await
    .unwrap();
    let normalized = updated.pane_state.unwrap();
    assert_eq!(normalized.active_pane_id, panes.active_pane_id);
    assert!(normalized.panes[0].assignments.is_empty());
    assert!(normalized.panes[0].selection.is_empty());
    assert!(normalized.panes[0].active.is_none());
    assert_eq!(normalized.panes[1].assignments.len(), 2);
    assert_eq!(
        normalized.panes[1].assignments[&pane_state::canonical_id(&extra).unwrap()],
        "g-main"
    );
    assert_eq!(normalized.panes[1].layout, panes.panes[1].layout);
}

#[tokio::test]
async fn pane_cascade_delete_and_folder_remove_normalize_snapshot_stale_cas_and_event() {
    let (db, tabs) = fixture().await;
    save_all_tabs_cas_with_panes(&db.conn, tabs.clone(), 0, Some(state(&tabs)))
        .await
        .unwrap();
    let broadcaster = Arc::new(WebEventBroadcaster::new());
    let emitter = EventEmitter::test_web_only(broadcaster.clone());
    let mut events = broadcaster.subscribe();
    let deleted = tabs[0].conversation_id.unwrap();
    crate::commands::conversations::delete_conversation_core(&db.conn, deleted)
        .await
        .unwrap();
    crate::commands::conversations::cleanup_tabs_for_deleted_conversation(
        &emitter, &db.conn, deleted,
    )
    .await;
    let event = events.try_recv().unwrap();
    assert_eq!(event.channel, TABS_CHANGED_EVENT);
    assert_eq!(event.payload["origin"], "server");
    assert_eq!(
        event.payload["pane_state"]["panes"][0]["assignments"]
            .as_object()
            .unwrap()
            .len(),
        1
    );
    let stale = save_all_tabs_cas_with_panes(&db.conn, tabs.clone(), 1, Some(state(&tabs)))
        .await
        .unwrap();
    assert!(!stale.accepted);
    assert_eq!(
        stale.pane_state.as_ref().unwrap().panes[0]
            .assignments
            .len(),
        1
    );
    crate::commands::folders::remove_folder_from_workspace_core(&emitter, &db, tabs[0].folder_id)
        .await
        .unwrap();
    let snapshot = list_opened_tabs_core(&db.conn).await.unwrap();
    assert!(snapshot.items.is_empty());
    let remaining = &snapshot.pane_state.unwrap().panes[0];
    assert!(remaining.assignments.is_empty());
    assert!(remaining.selection.is_empty());
    assert!(remaining.active.is_none());
    assert!(
        conversation_service::get_by_id(&db.conn, tabs[1].conversation_id.unwrap())
            .await
            .is_ok()
    );
}

#[tokio::test]
async fn pane_snapshot_and_stale_cas_normalize_existing_database_cascade_without_rewrite() {
    let (db, tabs) = fixture().await;
    save_all_tabs_cas_with_panes(&db.conn, tabs.clone(), 0, Some(state(&tabs)))
        .await
        .unwrap();
    crate::db::entities::conversation::Entity::delete_by_id(tabs[0].conversation_id.unwrap())
        .exec(&db.conn)
        .await
        .unwrap();
    let snapshot = snapshot_tabs_with_panes(&db.conn).await.unwrap();
    assert_eq!(snapshot.version, 1);
    assert_eq!(snapshot.items.len(), 1);
    let panes = snapshot.pane_state.unwrap();
    assert_eq!(panes.panes[0].assignments.len(), 1);
    assert!(panes.panes[0].selection.is_empty());
    let stale = save_all_tabs_cas_with_panes(&db.conn, tabs.clone(), 0, Some(state(&tabs)))
        .await
        .unwrap();
    assert!(!stale.accepted);
    assert_eq!(stale.pane_state, Some(panes));
    let barrier = delete_conversation_tabs_and_bump(&db.conn, tabs[0].conversation_id.unwrap())
        .await
        .unwrap();
    assert!(barrier.emit.is_none());
    assert_eq!(barrier.pane_state.unwrap().panes[0].assignments.len(), 1);
}

#[tokio::test]
async fn pane_folder_move_rekeys_ownership_selection_and_active_in_original_pane() {
    let (db, tabs) = fixture().await;
    let target = seed_folder(&db, "/tmp/codeg-pane-move-target").await;
    let mut panes = state(&tabs);
    panes.panes.push(pane("pane-empty", &[]));
    panes.active_pane_id = "pane-empty".into();
    save_all_tabs_cas_with_panes(&db.conn, tabs.clone(), 0, Some(panes))
        .await
        .unwrap();
    let id = tabs[0].conversation_id.unwrap();
    let broadcaster = Arc::new(WebEventBroadcaster::new());
    let emitter = EventEmitter::test_web_only(broadcaster.clone());
    let mut events = broadcaster.subscribe();
    crate::commands::conversations::move_conversations_core(
        &emitter,
        &db.conn,
        &crate::acp::manager::ConnectionManager::new(),
        vec![id],
        target,
    )
    .await
    .unwrap();
    let panes = snapshot_tabs_with_panes(&db.conn)
        .await
        .unwrap()
        .pane_state
        .unwrap();
    let new_id = format!("conv-{target}-codex-{id}");
    assert_eq!(panes.panes[0].assignments[&new_id], "g-main");
    assert!(!panes.panes[0]
        .assignments
        .contains_key(&pane_state::canonical_id(&tabs[0]).unwrap()));
    assert_eq!(panes.panes[0].selection["g-main"], new_id);
    assert_eq!(panes.panes[0].active.as_ref(), Some(&new_id));
    assert!(panes.panes[1].assignments.is_empty());
    assert_eq!(
        snapshot_tabs_with_panes(&db.conn).await.unwrap().pane_state,
        Some(panes)
    );
    let mut saw_tabs_event = false;
    while let Ok(event) = events.try_recv() {
        if event.channel == TABS_CHANGED_EVENT {
            assert_eq!(event.payload["pane_state"]["panes"][0]["active"], new_id);
            saw_tabs_event = true;
        }
    }
    assert!(saw_tabs_event);
    assert!(folder_service::get_folder_by_id(&db.conn, target)
        .await
        .unwrap()
        .is_some());
}

#[tokio::test]
async fn pane_web_handler_and_desktop_core_share_state_cas_events_and_invalid_input() {
    let (db, tabs) = fixture().await;
    let data = tempfile::tempdir().unwrap();
    let assets = tempfile::tempdir().unwrap();
    let app = Arc::new(crate::app_state::AppState::new_for_test(
        db,
        data.path().into(),
    ));
    let router = crate::web::router::build_router(
        app.clone(),
        "pane-test".into(),
        assets.path().into(),
        Arc::new(crate::web::shutdown::ShutdownSignal::new()),
    );
    let server = axum_test::TestServer::new(router).unwrap();
    let panes = state(&tabs);
    let response = server
        .post("/api/save_opened_tabs")
        .add_header("authorization", "Bearer pane-test")
        .json(&json!({"items": tabs, "expectedVersion": 0, "origin": "web", "paneState": panes}))
        .await;
    assert_eq!(response.status_code(), 200);
    let wire: Value = response.json();
    assert_eq!(wire["accepted"], true);
    assert_eq!(wire["pane_state"], serde_json::to_value(&panes).unwrap());
    let desktop = list_opened_tabs_core(&app.db.conn).await.unwrap();
    assert_eq!(wire["tabs"], wire_tabs(&desktop.items));
    assert_eq!(desktop.pane_state, Some(panes.clone()));
    let response = server
        .post("/api/save_opened_tabs")
        .add_header("authorization", "Bearer pane-test")
        .json(
            &json!({"items": [], "expectedVersion": 0, "origin": "stale", "paneState": state(&[])}),
        )
        .await;
    assert_eq!(response.status_code(), 200);
    assert_eq!(response.json::<Value>()["accepted"], false);
    let mut invalid = panes.clone();
    invalid.active_pane_id = "missing".into();
    let response = server
        .post("/api/save_opened_tabs")
        .add_header("authorization", "Bearer pane-test")
        .json(&json!({"items": tabs, "expectedVersion": 1, "origin": "bad", "paneState": invalid}))
        .await;
    assert_eq!(response.status_code(), 400);
    assert!(response.json::<Value>()["message"]
        .as_str()
        .unwrap()
        .contains("pane_state"));
    let response = server
        .post("/api/save_opened_tabs")
        .add_header("authorization", "Bearer pane-test")
        .json(&json!({"items": tabs, "expectedVersion": 1, "origin": "legacy", "paneState": null}))
        .await;
    assert_eq!(response.status_code(), 200);
    assert_eq!(
        response.json::<Value>()["pane_state"],
        serde_json::to_value(&panes).unwrap()
    );
    let response = server
        .post("/api/list_opened_tabs")
        .add_header("authorization", "Bearer pane-test")
        .json(&json!({}))
        .await;
    assert_eq!(response.status_code(), 200);
    let snapshot: Value = response.json();
    assert_eq!(snapshot["version"], 2);
    assert_eq!(
        snapshot["pane_state"],
        serde_json::to_value(&panes).unwrap()
    );
}

#[test]
fn pane_shared_request_and_response_wire_shapes_match_contract() {
    let panes = state(&[]);
    let request = json!({"items": [], "expectedVersion": 4, "origin": "web", "paneState": panes});
    let params: crate::web::handlers::conversations::SaveOpenedTabsParams =
        serde_json::from_value(request).unwrap();
    assert_eq!(params.pane_state, Some(panes.clone()));
    assert_eq!(params.expected_version, 4);
    for extra in [json!({}), json!({"paneState": null})] {
        let mut request = json!({"items": [], "expectedVersion": 4, "origin": "old"});
        request
            .as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        let params: crate::web::handlers::conversations::SaveOpenedTabsParams =
            serde_json::from_value(request).unwrap();
        assert!(params.pane_state.is_none());
    }
    let snapshot = serde_json::to_value(OpenedTabsSnapshot {
        items: vec![],
        version: 4,
        pane_state: Some(panes.clone()),
    })
    .unwrap();
    let outcome = serde_json::to_value(crate::models::SaveTabsOutcome {
        accepted: true,
        tabs: vec![],
        version: 4,
        pane_state: Some(panes.clone()),
    })
    .unwrap();
    let event = serde_json::to_value(crate::web::event_bridge::TabsChanged {
        tabs: vec![],
        version: 4,
        origin: "web".into(),
        pane_state: Some(panes.clone()),
    })
    .unwrap();
    for wire in [snapshot, outcome, event] {
        assert_eq!(wire["pane_state"], serde_json::to_value(&panes).unwrap());
        assert!(wire.get("paneState").is_none());
        assert_eq!(wire["pane_state"]["schemaVersion"], 1);
        assert_eq!(wire["pane_state"]["activePaneId"], "pane-main");
        assert_eq!(
            wire["pane_state"]["panes"][0]["tileByGroup"],
            json!({"g-main": false})
        );
    }
}
