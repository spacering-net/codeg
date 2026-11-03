//! The personal agent's engine against a real (in-memory) database: its
//! configuration, the owner's queue, recovery after a restart, the dispatch
//! rules and the handover. No agent runs — the flows that need one are
//! covered end to end.

use std::collections::BTreeMap;

use crate::db::entities::personal_agent_batch::BatchKind;
use crate::db::entities::personal_agent_dispatch::{DispatchMode, DispatchState};
use crate::db::entities::personal_agent_event::EventState;
use crate::db::entities::personal_agent_item::{ItemKind, ItemStatus, WaitsFor};
use crate::db::entities::personal_agent_segment::SegmentReason;
use crate::db::entities::personal_agent_timeline::{OwnerStatus, TimelineKind};
use crate::db::service::personal_agent_service as svc;
use crate::db::service::personal_agent_service::{DispatchWrite, NewDispatch, NewRow};
use crate::models::personal_agent::{PersonalAgentDraft, PersonalAgentSettings};
use crate::models::{AgentType, AssistantAgentConfig, AssistantLabelSnapshot};

use crate::acp::types::AcpEvent;

use super::dispatch::DispatchRequest;
use super::engine::{PersonalAgentEngine, SegmentState};
use super::workdir;

fn brain(agent_type: AgentType) -> AssistantAgentConfig {
    AssistantAgentConfig {
        agent_type,
        agent_options: Default::default(),
        label_snapshot: AssistantLabelSnapshot {
            agent: format!("{agent_type:?}"),
            mode: None,
            options: Vec::new(),
        },
    }
}

async fn engine() -> (std::sync::Arc<PersonalAgentEngine>, tempfile::TempDir) {
    let db = crate::db::test_helpers::fresh_in_memory_db().await;
    let tmp = tempfile::tempdir().unwrap();
    (PersonalAgentEngine::new_for_test(db, tmp.path().to_path_buf()), tmp)
}

async fn configured() -> (std::sync::Arc<PersonalAgentEngine>, tempfile::TempDir) {
    let (engine, tmp) = engine().await;
    engine
        .save(PersonalAgentDraft {
            agent_config: Some(brain(AgentType::ClaudeCode)),
            locale: Some("en".into()),
            ..Default::default()
        })
        .await
        .expect("first save");
    (engine, tmp)
}

#[tokio::test]
async fn the_first_save_needs_an_agent_and_sets_up_the_workdir() {
    let (engine, tmp) = engine().await;
    let err = engine
        .save(PersonalAgentDraft::default())
        .await
        .expect_err("no agent yet");
    assert!(err.contains("agent"), "{err}");
    assert!(engine.send_owner_message("hi".into(), Vec::new()).await.is_err());

    let info = engine
        .save(PersonalAgentDraft {
            agent_config: Some(brain(AgentType::ClaudeCode)),
            ..Default::default()
        })
        .await
        .unwrap();
    let dir = tmp.path().join("personal-agent");
    assert_eq!(info.workdir, dir.to_string_lossy());
    assert!(workdir::is_workdir(&dir));
    assert!(dir.join(workdir::SOUL_FILE).is_file());
    assert_eq!(info.settings, PersonalAgentSettings::default());
}

#[tokio::test]
async fn a_message_is_queued_on_the_timeline() {
    let (engine, _tmp) = configured().await;
    let row = engine
        .send_owner_message("  fix the login bug  ".into(), Vec::new())
        .await
        .unwrap();
    assert_eq!(row.kind, TimelineKind::Owner);
    assert_eq!(row.status, Some(OwnerStatus::Queued));
    assert_eq!(row.body, "fix the login bug");
    assert!(engine.send_owner_message("   ".into(), Vec::new()).await.is_err());
    let snap = engine.snapshot().await;
    assert_eq!(snap.status.queued_messages, 1);
    assert!(snap.status.configured);
}

#[tokio::test]
async fn a_compact_command_is_cleared_when_the_agent_type_changes() {
    let (engine, _tmp) = configured().await;
    let settings = PersonalAgentSettings {
        compact_command: Some("/compact --hard".into()),
        ..Default::default()
    };
    let info = engine
        .save(PersonalAgentDraft {
            settings: Some(settings),
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(info.settings.compact_command.as_deref(), Some("/compact --hard"));
    assert_eq!(info.settings.compact_command_agent.as_deref(), Some("claude_code"));
    assert_eq!(
        info.settings.compact_command_for(AgentType::ClaudeCode),
        Some("/compact --hard")
    );
    assert_eq!(info.settings.compact_command_for(AgentType::Codex), None);

    let info = engine
        .save(PersonalAgentDraft {
            agent_config: Some(brain(AgentType::Codex)),
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(info.agent_type, AgentType::Codex);
    assert_eq!(info.settings.compact_command, None);
}

#[tokio::test]
async fn switching_the_brain_marks_the_open_segment_for_replacement() {
    let (engine, _tmp) = configured().await;
    let config = serde_json::to_string(&brain(AgentType::ClaudeCode)).unwrap();
    let seg = svc::create_segment(&engine.db.conn, "claude_code", config, SegmentReason::First)
        .await
        .unwrap();
    engine
        .save(PersonalAgentDraft {
            agent_config: Some(brain(AgentType::Codex)),
            ..Default::default()
        })
        .await
        .unwrap();
    let seg = svc::get_segment(&engine.db.conn, seg.id).await.unwrap().unwrap();
    assert_eq!(seg.pending_reason, Some(SegmentReason::Switch));
    assert!(seg.ended_at.is_none(), "only at the next delivery");
}

#[tokio::test]
async fn an_interrupted_delivery_offers_its_messages_again_and_puts_events_back_once() {
    let (engine, _tmp) = configured().await;
    let config = serde_json::to_string(&brain(AgentType::ClaudeCode)).unwrap();
    let seg = svc::create_segment(&engine.db.conn, "claude_code", config, SegmentReason::First)
        .await
        .unwrap();
    let owner = engine.send_owner_message("hello".into(), Vec::new()).await.unwrap();
    assert!(svc::insert_event(
        &engine.db.conn,
        "dispatch_status",
        "dispatch:1:0:review:task",
        Some("dispatch:1".into()),
        "Dispatch #1 is in review.".into(),
        None,
        true,
    )
    .await
    .unwrap());
    let batch = svc::create_batch(&engine.db.conn, seg.id, BatchKind::Delivery, None)
        .await
        .unwrap();
    svc::move_owner_rows(
        &engine.db.conn,
        &[owner.id],
        &[OwnerStatus::Queued],
        OwnerStatus::Delivered,
        Some(batch.id),
        Some(seg.id),
    )
    .await
    .unwrap();
    let events = svc::pending_events(&engine.db.conn).await.unwrap();
    svc::mark_events_delivered(
        &engine.db.conn,
        &events.iter().map(|e| e.id).collect::<Vec<_>>(),
        batch.id,
    )
    .await
    .unwrap();

    engine.boot_for_test().await;

    let row = svc::get_row(&engine.db.conn, owner.id).await.unwrap().unwrap();
    assert_eq!(row.status, Some(OwnerStatus::Interrupted));
    let pending = svc::pending_events(&engine.db.conn).await.unwrap();
    assert_eq!(pending.len(), 1, "put back once");
    assert_eq!(pending[0].requeues, 1);

    // The same event interrupted a second time is not put back again.
    let batch2 = svc::create_batch(&engine.db.conn, seg.id, BatchKind::Delivery, None)
        .await
        .unwrap();
    svc::mark_events_delivered(&engine.db.conn, &[pending[0].id], batch2.id)
        .await
        .unwrap();
    svc::requeue_batch_events(&engine.db.conn, batch2.id).await.unwrap();
    assert!(svc::pending_events(&engine.db.conn).await.unwrap().is_empty());
}

#[tokio::test]
async fn an_interrupted_compaction_leaves_the_messages_queued() {
    let (engine, _tmp) = configured().await;
    let config = serde_json::to_string(&brain(AgentType::ClaudeCode)).unwrap();
    let seg = svc::create_segment(&engine.db.conn, "claude_code", config, SegmentReason::First)
        .await
        .unwrap();
    let owner = engine.send_owner_message("hello".into(), Vec::new()).await.unwrap();
    svc::create_batch(&engine.db.conn, seg.id, BatchKind::Compaction, None)
        .await
        .unwrap();
    engine.boot_for_test().await;
    let row = svc::get_row(&engine.db.conn, owner.id).await.unwrap().unwrap();
    assert_eq!(row.status, Some(OwnerStatus::Queued));
    assert!(svc::running_batches(&engine.db.conn).await.unwrap().is_empty());
}

#[tokio::test]
async fn resending_an_interrupted_message_queues_a_copy() {
    let (engine, _tmp) = configured().await;
    let owner = engine.send_owner_message("again".into(), Vec::new()).await.unwrap();
    assert!(engine.resend(owner.id).await.is_err(), "only interrupted ones");
    svc::move_owner_rows(
        &engine.db.conn,
        &[owner.id],
        &[OwnerStatus::Queued],
        OwnerStatus::Interrupted,
        None,
        None,
    )
    .await
    .unwrap();
    let copy = engine.resend(owner.id).await.unwrap();
    assert_ne!(copy.id, owner.id);
    assert_eq!(copy.body, "again");
    assert_eq!(copy.status, Some(OwnerStatus::Queued));
    let old = svc::get_row(&engine.db.conn, owner.id).await.unwrap().unwrap();
    assert!(old.data.unwrap().contains(&format!("\"resent_as\":{}", copy.id)));
}

async fn role_assistant(engine: &PersonalAgentEngine, name: &str, enabled: bool) -> i32 {
    let info = crate::db::service::assistant_service::create(
        &engine.db.conn,
        &crate::models::AssistantDraft {
            name: name.into(),
            description: "code changes".into(),
            avatar: crate::models::AssistantAvatar::Monogram {
                color: "blue".into(),
            },
            agent_config: brain(AgentType::Codex),
            instructions: "Cite lines.".into(),
            enabled,
        },
    )
    .await
    .unwrap();
    info.id
}

fn request(mode: DispatchMode, assistant_id: i32, project_id: Option<i32>) -> DispatchRequest {
    DispatchRequest {
        mode,
        assistant_id,
        title: "Fix the login bug".into(),
        prompt: "The login form rejects valid passwords.".into(),
        project_id,
        report: false,
        on_done: Some("remind the owner".into()),
    }
}

#[tokio::test]
async fn dispatch_takes_only_enabled_role_assistants_and_real_projects() {
    let (engine, tmp) = configured().await;
    let coder = role_assistant(&engine, "Coder", true).await;
    let off = role_assistant(&engine, "Off", false).await;
    let project = crate::db::test_helpers::seed_folder(&engine.db, &tmp.path().join("repo").to_string_lossy()).await;

    let err = engine
        .dispatch(request(DispatchMode::Task, off, Some(project)))
        .await
        .unwrap_err();
    assert!(err.contains("not an enabled role assistant"), "{err}");
    let err = engine
        .dispatch(request(DispatchMode::Task, 999, Some(project)))
        .await
        .unwrap_err();
    assert!(err.contains("assistant_list"), "{err}");
    let err = engine
        .dispatch(request(DispatchMode::Session, coder, None))
        .await
        .unwrap_err();
    assert!(err.contains("project_id"), "{err}");
    let err = engine
        .dispatch(request(DispatchMode::Chat, coder, Some(project)))
        .await
        .unwrap_err();
    assert!(err.contains("no project_id"), "{err}");
    let mut report = request(DispatchMode::Chat, coder, None);
    report.report = true;
    assert!(engine.dispatch(report).await.is_err());

    // The personal agent's own working directory is never a target.
    let own = crate::db::service::folder_service::ensure_personal_folder(
        &engine.db.conn,
        &tmp.path().join("personal-agent").to_string_lossy(),
    )
    .await
    .unwrap();
    let err = engine
        .dispatch(request(DispatchMode::Session, coder, Some(own.id)))
        .await
        .unwrap_err();
    assert!(err.contains("not a project folder"), "{err}");
}

#[tokio::test]
async fn a_dispatch_is_recorded_with_its_card_and_ledger_entry() {
    let (engine, _tmp) = configured().await;
    let coder = role_assistant(&engine, "Coder", true).await;
    let d = engine
        .dispatch(request(DispatchMode::Chat, coder, None))
        .await
        .unwrap();
    assert_eq!(d.mode, DispatchMode::Chat);
    let snapshot = super::dispatch::executor_of(&d);
    assert_eq!(snapshot.name, "Coder");
    assert_eq!(snapshot.instructions, "Cite lines.");
    let item = svc::item_of_dispatch(&engine.db.conn, d.id).await.unwrap().unwrap();
    assert_eq!(item.on_done.as_deref(), Some("remind the owner"));
    let (rows, _) = svc::page(&engine.db.conn, None, 50).await.unwrap();
    assert!(rows
        .iter()
        .any(|r| r.kind == TimelineKind::Dispatch && r.dispatch_id == Some(d.id)));
}

#[tokio::test]
async fn the_owner_writing_in_a_dispatched_conversation_takes_it_over() {
    let (engine, _tmp) = configured().await;
    let coder = role_assistant(&engine, "Coder", true).await;
    let d = svc::create_dispatch(
        &engine.db.conn,
        NewDispatch {
            mode: DispatchMode::Session,
            executor_assistant_id: coder,
            executor_snapshot_json: "{}".into(),
            folder_id: None,
            deliverable: None,
            title: "Investigate".into(),
            prompt: "Look".into(),
            origin_batch_id: None,
            on_done: None,
        },
    )
    .await
    .unwrap();
    svc::update_dispatch(
        &engine.db.conn,
        d.id,
        None,
        DispatchWrite {
            state: Some(DispatchState::Completed),
            conversation_id: Some(42),
            connection_id: Some(Some("conn-1".into())),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    engine.handover("other-conn", Some(42)).await;
    let d = svc::get_dispatch(&engine.db.conn, d.id).await.unwrap().unwrap();
    assert_eq!(d.state, DispatchState::HandedOver);
    // A follow-up is refused from now on.
    let err = engine.followup(d.id, "more".into(), None).await.unwrap_err();
    assert!(err.contains("took this conversation over"), "{err}");
    // The handover rides along as information, without waking the agent.
    let events = svc::pending_events(&engine.db.conn).await.unwrap();
    assert_eq!(events.len(), 1);
    assert!(!events[0].wake);
    assert_eq!(events[0].state, EventState::Pending);
}

#[tokio::test]
async fn a_tool_call_from_another_connection_is_refused() {
    let out = super::tools::call("not-the-agent", "assistant_list", serde_json::json!({})).await;
    assert!(!out.ok);
}

#[tokio::test]
async fn an_option_change_within_the_agent_records_a_marker_and_no_switch() {
    let (engine, _tmp) = configured().await;
    let config = serde_json::to_string(&brain(AgentType::ClaudeCode)).unwrap();
    let seg = svc::create_segment(&engine.db.conn, "claude_code", config, SegmentReason::First)
        .await
        .unwrap();
    let mut next = brain(AgentType::ClaudeCode);
    next.agent_options.config_values = BTreeMap::from([("model".into(), "opus".into())]);
    next.label_snapshot.options = vec![crate::models::AssistantOptionLabel {
        id: "model".into(),
        kind: crate::models::AssistantOptionKind::Select,
        name: "Model".into(),
        value_label: "Opus".into(),
    }];
    engine
        .save(PersonalAgentDraft {
            agent_config: Some(next),
            ..Default::default()
        })
        .await
        .unwrap();
    let seg = svc::get_segment(&engine.db.conn, seg.id).await.unwrap().unwrap();
    assert_eq!(seg.pending_reason, None);
    let (rows, _) = svc::page(&engine.db.conn, None, 50).await.unwrap();
    let marker = rows
        .iter()
        .find(|r| r.kind == TimelineKind::Marker)
        .expect("a marker");
    assert!(marker.data.as_deref().unwrap().contains("options_changed"));
}

#[tokio::test]
async fn timeline_rows_page_newest_last() {
    let (engine, _tmp) = configured().await;
    for i in 0..5 {
        svc::insert_row(&engine.db.conn, NewRow::new(TimelineKind::Reply, format!("r{i}")))
            .await
            .unwrap();
    }
    let (rows, has_older) = svc::page(&engine.db.conn, None, 3).await.unwrap();
    assert!(has_older);
    assert_eq!(
        rows.iter().map(|r| r.body.as_str()).collect::<Vec<_>>(),
        ["r2", "r3", "r4"]
    );
    let (older, has_older) = svc::page(&engine.db.conn, Some(rows[0].id), 3).await.unwrap();
    assert!(!has_older);
    assert_eq!(
        older.iter().map(|r| r.body.as_str()).collect::<Vec<_>>(),
        ["r0", "r1"]
    );
}

// ── review round 1 regressions ─────────────────────────────────────────────

async fn open_segment(engine: &PersonalAgentEngine) -> i32 {
    let config = serde_json::to_string(&brain(AgentType::ClaudeCode)).unwrap();
    svc::create_segment(&engine.db.conn, "claude_code", config, SegmentReason::First)
        .await
        .unwrap()
        .id
}

fn turn_complete(stop_reason: &str) -> AcpEvent {
    AcpEvent::TurnComplete {
        session_id: "s".into(),
        stop_reason: stop_reason.into(),
        agent_type: "claude_code".into(),
    }
}

/// The agent's report of a compaction (`contextCompaction` on a tool call).
fn compaction_report(tool_call_id: &str, failed: bool) -> AcpEvent {
    AcpEvent::ToolCallUpdate {
        tool_call_id: tool_call_id.into(),
        title: None,
        status: Some(if failed { "failed" } else { "completed" }.into()),
        content: None,
        raw_input: None,
        raw_output: None,
        raw_output_append: None,
        locations: None,
        meta: Some(if failed {
            serde_json::json!({ "contextCompaction": { "version": 1, "error": "API error" } })
        } else {
            serde_json::json!({ "contextCompaction": { "version": 1, "preTokens": 150000 } })
        }),
        images: None,
    }
}

async fn session_dispatch(engine: &PersonalAgentEngine, state: DispatchState, conn: &str) -> i32 {
    let coder = role_assistant(engine, &format!("Coder on {conn}"), true).await;
    let d = svc::create_dispatch(
        &engine.db.conn,
        NewDispatch {
            mode: DispatchMode::Session,
            executor_assistant_id: coder,
            executor_snapshot_json: "{}".into(),
            folder_id: None,
            deliverable: None,
            title: "Investigate".into(),
            prompt: "Look".into(),
            origin_batch_id: None,
            on_done: None,
        },
    )
    .await
    .unwrap();
    svc::update_dispatch(
        &engine.db.conn,
        d.id,
        None,
        DispatchWrite {
            state: Some(state),
            conversation_id: Some(42),
            connection_id: Some(Some(conn.into())),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    d.id
}

async fn dispatch_state(engine: &PersonalAgentEngine, id: i32) -> crate::db::entities::personal_agent_dispatch::Model {
    svc::get_dispatch(&engine.db.conn, id).await.unwrap().unwrap()
}

async fn compaction_markers(engine: &PersonalAgentEngine) -> Vec<serde_json::Value> {
    let (rows, _) = svc::page(&engine.db.conn, None, 200).await.unwrap();
    rows.into_iter()
        .filter(|r| r.kind == TimelineKind::Marker)
        .filter_map(|r| r.data)
        .filter_map(|d| serde_json::from_str::<serde_json::Value>(&d).ok())
        .filter(|d| d.get("marker").and_then(|m| m.as_str()) == Some("compaction"))
        .collect()
}

#[tokio::test]
async fn a_put_back_event_lists_what_the_interrupted_turn_dispatched() {
    let (engine, _tmp) = configured().await;
    let seg = open_segment(&engine).await;
    assert!(svc::insert_event(
        &engine.db.conn,
        "dispatch_status",
        "dispatch:9:0:completed:turn",
        Some("dispatch:9".into()),
        "Dispatch #9 finished.".into(),
        None,
        true,
    )
    .await
    .unwrap());
    let batch = svc::create_batch(&engine.db.conn, seg, BatchKind::Delivery, None)
        .await
        .unwrap();
    let events = svc::pending_events(&engine.db.conn).await.unwrap();
    svc::mark_events_delivered(
        &engine.db.conn,
        &events.iter().map(|e| e.id).collect::<Vec<_>>(),
        batch.id,
    )
    .await
    .unwrap();
    // What that turn dispatched before the restart cut it off.
    let coder = role_assistant(&engine, "Coder", true).await;
    svc::create_dispatch(
        &engine.db.conn,
        NewDispatch {
            mode: DispatchMode::Chat,
            executor_assistant_id: coder,
            executor_snapshot_json: "{}".into(),
            folder_id: None,
            deliverable: None,
            title: "Fix the login".into(),
            prompt: "Fix it".into(),
            origin_batch_id: Some(batch.id),
            on_done: None,
        },
    )
    .await
    .unwrap();

    engine.boot_for_test().await;

    let pending = svc::pending_events(&engine.db.conn).await.unwrap();
    assert_eq!(pending.len(), 1);
    assert_eq!(pending[0].requeued_from, Some(batch.id));
    let note = engine.interrupted_note(&pending).await.expect("a note");
    assert!(note.contains("Fix the login"), "{note}");
    assert!(!note.contains("dispatched nothing"), "{note}");
}

#[tokio::test]
async fn a_late_completion_cannot_settle_the_next_round() {
    let (engine, _tmp) = configured().await;
    let id = session_dispatch(&engine, DispatchState::Running, "conn-1").await;
    // The round's prompt went out at the connection's current seq.
    engine.open_round("conn-1", id).await;
    engine.feed_for_test("conn-1", 0, turn_complete("end_turn")).await;
    assert_eq!(dispatch_state(&engine, id).await.state, DispatchState::Running, "not after the prompt");
    engine.feed_for_test("conn-1", 3, turn_complete("end_turn")).await;
    let d = dispatch_state(&engine, id).await;
    assert_eq!(d.state, DispatchState::Completed);
    assert_eq!(d.turns, 1);

    // A follow-up claims the dispatch; its prompt is not out yet. A repeat
    // of the settled round's completion arriving now settles nothing.
    svc::update_dispatch(
        &engine.db.conn,
        id,
        Some(&[DispatchState::Completed]),
        DispatchWrite {
            state: Some(DispatchState::Running),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    engine.feed_for_test("conn-1", 4, turn_complete("end_turn")).await;
    assert_eq!(dispatch_state(&engine, id).await.state, DispatchState::Running);

    // The backstop settles an open round; that round's own completion,
    // arriving late after the next one was claimed, is ignored too.
    engine.open_round("conn-1", id).await;
    assert!(engine.close_round("conn-1", None).await, "the backstop closes the open round");
    engine.feed_for_test("conn-1", 9, turn_complete("end_turn")).await;
    assert_eq!(dispatch_state(&engine, id).await.state, DispatchState::Running);
}

#[tokio::test]
async fn an_executor_turn_that_did_not_end_normally_fails_the_dispatch() {
    let (engine, _tmp) = configured().await;
    let id = session_dispatch(&engine, DispatchState::Running, "conn-2").await;
    engine.open_round("conn-2", id).await;
    engine.feed_for_test("conn-2", 1, turn_complete("auth_required")).await;
    let d = dispatch_state(&engine, id).await;
    assert_eq!(d.state, DispatchState::Failed);
    assert!(d.error.as_deref().unwrap_or("").contains("auth_required"), "{:?}", d.error);
    let events = svc::pending_events(&engine.db.conn).await.unwrap();
    assert!(events.iter().any(|e| e.summary.contains("failed") && e.summary.contains("auth_required")));
}

#[tokio::test]
async fn a_follow_up_waits_for_a_free_session_slot() {
    let (engine, _tmp) = configured().await;
    let settings = PersonalAgentSettings {
        dispatch_concurrency: 1,
        ..Default::default()
    };
    engine
        .save(PersonalAgentDraft {
            settings: Some(settings),
            ..Default::default()
        })
        .await
        .unwrap();
    let a = session_dispatch(&engine, DispatchState::Completed, "conn-a").await;
    let b = session_dispatch(&engine, DispatchState::Running, "conn-b").await;
    let item = svc::create_item(
        &engine.db.conn,
        ItemKind::Dispatch,
        Some(a),
        ItemStatus::Done,
        None,
        "Investigate".into(),
        None,
        None,
    )
    .await
    .unwrap();

    let msg = engine.followup(a, "and the tests".into(), None).await.unwrap();
    assert!(msg.contains("slots are busy"), "{msg}");
    let d = dispatch_state(&engine, a).await;
    assert_eq!(d.state, DispatchState::Queued);
    assert_eq!(d.followup.as_deref(), Some("and the tests"));
    let item = svc::get_item(&engine.db.conn, item.id).await.unwrap().unwrap();
    assert_eq!(item.status, ItemStatus::Open);
    assert_eq!(item.waits_for, Some(WaitsFor::External));
    let err = engine.followup(a, "more".into(), None).await.unwrap_err();
    assert!(err.contains("busy"), "{err}");

    // B is done: the waiting follow-up goes next. Its conversation does not
    // exist in this test, so it fails, and the agent is told.
    svc::update_dispatch(
        &engine.db.conn,
        b,
        None,
        DispatchWrite {
            state: Some(DispatchState::Completed),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    engine.start_queued().await;
    let d = dispatch_state(&engine, a).await;
    assert_eq!(d.state, DispatchState::Failed);
    assert!(d.followup.is_none());
    let failures = |events: &[crate::db::entities::personal_agent_event::Model]| {
        events
            .iter()
            .filter(|e| e.summary.contains(&format!("Dispatch #{a}")) && e.summary.contains("failed"))
            .count()
    };
    assert_eq!(failures(&svc::pending_events(&engine.db.conn).await.unwrap()), 1);

    // Another follow-up waits and fails the same way: it is news again, not a
    // duplicate of the first.
    svc::update_dispatch(
        &engine.db.conn,
        b,
        None,
        DispatchWrite {
            state: Some(DispatchState::Running),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let msg = engine.followup(a, "try once more".into(), None).await.unwrap();
    assert!(msg.contains("slots are busy"), "{msg}");
    svc::update_dispatch(
        &engine.db.conn,
        b,
        None,
        DispatchWrite {
            state: Some(DispatchState::Completed),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    engine.start_queued().await;
    assert_eq!(dispatch_state(&engine, a).await.state, DispatchState::Failed);
    assert_eq!(failures(&svc::pending_events(&engine.db.conn).await.unwrap()), 2);
}

#[tokio::test]
async fn a_dispatch_interrupted_by_restarts_in_two_rounds_reports_both() {
    let (engine, _tmp) = configured().await;
    let id = session_dispatch(&engine, DispatchState::Running, "conn-r").await;
    engine.boot_for_test().await;
    assert_eq!(dispatch_state(&engine, id).await.state, DispatchState::Interrupted);
    // Followed up, running again, and cut off by the next restart.
    svc::update_dispatch(
        &engine.db.conn,
        id,
        None,
        DispatchWrite {
            state: Some(DispatchState::Running),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    engine.boot_for_test().await;
    let interrupted = svc::pending_events(&engine.db.conn)
        .await
        .unwrap()
        .into_iter()
        .filter(|e| e.summary.contains(&format!("Dispatch #{id}")))
        .count();
    assert_eq!(interrupted, 2);
}

#[tokio::test]
async fn a_compaction_the_agent_reports_failed_counts_as_failed_and_two_pause() {
    let (engine, _tmp) = configured().await;
    let seg = open_segment(&engine).await;
    for round in 0..2u64 {
        let batch = svc::create_batch(&engine.db.conn, seg, BatchKind::Compaction, None)
            .await
            .unwrap();
        engine
            .begin_turn_for_test("pa-conn", seg, batch.id, BatchKind::Compaction, false, false)
            .await;
        engine
            .feed_for_test("pa-conn", round * 10 + 1, compaction_report(&format!("c{round}"), true))
            .await;
        engine
            .feed_for_test("pa-conn", round * 10 + 2, turn_complete("end_turn"))
            .await;
    }
    let markers = compaction_markers(&engine).await;
    assert_eq!(markers.len(), 2, "{markers:?}");
    assert!(markers.iter().all(|m| m["status"] == "failed"), "{markers:?}");
    let seg = svc::get_segment(&engine.db.conn, seg).await.unwrap().unwrap();
    assert_eq!(seg.compactions_auto, 0);
    assert!(seg.auto_compact_paused);
    assert!(!SegmentState::parse(&seg.state).needs_state_card);
}

#[tokio::test]
async fn a_forced_compaction_that_stops_abnormally_starts_a_new_segment_next() {
    let (engine, _tmp) = configured().await;
    let seg = open_segment(&engine).await;
    let batch = svc::create_batch(&engine.db.conn, seg, BatchKind::Compaction, None)
        .await
        .unwrap();
    engine
        .begin_turn_for_test("pa-conn", seg, batch.id, BatchKind::Compaction, false, true)
        .await;
    engine.feed_for_test("pa-conn", 1, turn_complete("max_tokens")).await;
    let markers = compaction_markers(&engine).await;
    assert_eq!(markers[0]["status"], "failed");
    assert!(markers[0]["error"].as_str().unwrap_or("").contains("max_tokens"), "{markers:?}");
    let seg = svc::get_segment(&engine.db.conn, seg).await.unwrap().unwrap();
    assert_eq!(seg.pending_reason, Some(SegmentReason::Overflow));
}

#[tokio::test]
async fn an_agent_compaction_during_a_delivery_keeps_the_state_card_owed() {
    let (engine, _tmp) = configured().await;
    let seg = open_segment(&engine).await;
    let owed = serde_json::to_string(&SegmentState {
        needs_state_card: true,
        ..Default::default()
    })
    .unwrap();
    svc::set_segment_state(&engine.db.conn, seg, owed).await.unwrap();

    // The delivery carries the state card, and the agent compacts mid-turn.
    let batch = svc::create_batch(&engine.db.conn, seg, BatchKind::Delivery, None)
        .await
        .unwrap();
    engine
        .begin_turn_for_test("pa-conn", seg, batch.id, BatchKind::Delivery, true, false)
        .await;
    engine.feed_for_test("pa-conn", 1, compaction_report("auto-1", false)).await;
    engine.feed_for_test("pa-conn", 2, turn_complete("end_turn")).await;
    let row = svc::get_segment(&engine.db.conn, seg).await.unwrap().unwrap();
    assert!(SegmentState::parse(&row.state).needs_state_card, "owed again");
    assert_eq!(row.compactions_agent, 1);

    // The next delivery carries it with no compaction: settled.
    let batch = svc::create_batch(&engine.db.conn, seg, BatchKind::Delivery, None)
        .await
        .unwrap();
    engine
        .begin_turn_for_test("pa-conn", seg, batch.id, BatchKind::Delivery, true, false)
        .await;
    engine.feed_for_test("pa-conn", 3, turn_complete("end_turn")).await;
    let row = svc::get_segment(&engine.db.conn, seg).await.unwrap().unwrap();
    assert!(!SegmentState::parse(&row.state).needs_state_card);
}

#[tokio::test]
async fn a_completion_event_carries_the_plan_as_it_stands_now() {
    let (engine, _tmp) = configured().await;
    let id = session_dispatch(&engine, DispatchState::Running, "conn-3").await;
    let item = svc::create_item(
        &engine.db.conn,
        ItemKind::Dispatch,
        Some(id),
        ItemStatus::Open,
        Some(WaitsFor::External),
        "Investigate".into(),
        Some("remind me to publish".into()),
        None,
    )
    .await
    .unwrap();
    engine.open_round("conn-3", id).await;
    engine.feed_for_test("conn-3", 1, turn_complete("end_turn")).await;
    // The agent changes its plan while the event waits.
    let out = super::tools::item_update_for_test(
        &engine,
        serde_json::json!({ "item_id": item.id, "on_done": "only summarize" }),
    )
    .await;
    assert!(out.ok, "{}", out.text);
    let events = svc::pending_events(&engine.db.conn).await.unwrap();
    let lines = engine.event_lines(&events).await;
    assert_eq!(lines.len(), 1);
    assert_eq!(lines[0].on_done.as_deref(), Some("only summarize"));
}

#[tokio::test]
async fn the_status_names_the_compact_command_without_a_live_session() {
    let (engine, _tmp) = configured().await;
    let snap = engine.snapshot().await;
    assert!(!snap.status.connected);
    assert_eq!(snap.status.compact_command.as_deref(), Some("/compact"));
    open_segment(&engine).await;
    let snap = engine.snapshot().await;
    assert_eq!(snap.status.compact_command.as_deref(), Some("/compact"));
}

#[tokio::test]
async fn a_dispatch_waiting_on_a_permission_says_so_and_runs_on_once_answered() {
    let (engine, _tmp) = configured().await;
    let id = session_dispatch(&engine, DispatchState::Running, "conn-w").await;
    engine.open_round("conn-w", id).await;
    engine
        .feed_for_test(
            "conn-w",
            1,
            AcpEvent::PermissionRequest {
                request_id: "p1".into(),
                tool_call: serde_json::json!({ "title": "Bash" }),
                options: Vec::new(),
                queued: 0,
            },
        )
        .await;
    assert_eq!(dispatch_state(&engine, id).await.state, DispatchState::WaitingInput);
    let events = svc::pending_events(&engine.db.conn).await.unwrap();
    assert_eq!(events.len(), 1);
    assert!(events[0].wake, "the agent is told the executor waits");
    let (rows, _) = svc::page(&engine.db.conn, None, 50).await.unwrap();
    assert!(rows
        .iter()
        .any(|r| r.kind == TimelineKind::Result && r.dispatch_id == Some(id)));

    engine
        .feed_for_test(
            "conn-w",
            2,
            AcpEvent::PermissionResolved {
                request_id: "p1".into(),
                option_id: None,
                origin: None,
            },
        )
        .await;
    assert_eq!(dispatch_state(&engine, id).await.state, DispatchState::Running);
    // Its round is still the open one: the completion settles it.
    engine.feed_for_test("conn-w", 3, turn_complete("end_turn")).await;
    assert_eq!(dispatch_state(&engine, id).await.state, DispatchState::Completed);
}

#[tokio::test]
async fn saving_the_persona_on_the_page_owes_the_agent_an_update() {
    let (engine, _tmp) = configured().await;
    let seg = open_segment(&engine).await;
    let owed = |engine: std::sync::Arc<PersonalAgentEngine>| async move {
        let row = svc::get_segment(&engine.db.conn, seg).await.unwrap().unwrap();
        SegmentState::parse(&row.state).persona_resend
    };
    engine.save_file(workdir::MEMORY_FILE, "- likes tea\n").await.unwrap();
    assert!(!owed(engine.clone()).await, "memory is the agent's to read");
    engine.save_file(workdir::SOUL_FILE, "# Persona\n\nTerse.\n").await.unwrap();
    assert!(owed(engine.clone()).await);
}

#[tokio::test]
async fn moving_the_workdir_starts_a_new_segment_and_leaves_the_old_one() {
    let (engine, tmp) = configured().await;
    let seg = open_segment(&engine).await;
    let old = tmp.path().join("personal-agent");
    let target = tmp.path().join("elsewhere");
    let info = engine
        .set_workdir(Some(target.to_string_lossy().to_string()))
        .await
        .unwrap();
    assert_eq!(info.workdir, target.to_string_lossy());
    assert!(workdir::is_workdir(&target));
    assert!(old.join(workdir::SOUL_FILE).is_file(), "the old directory is left as it is");
    let row = svc::get_segment(&engine.db.conn, seg).await.unwrap().unwrap();
    assert_eq!(row.pending_reason, Some(SegmentReason::Workdir));
}
