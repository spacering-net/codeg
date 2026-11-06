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
    assert!(engine.send_owner_message("hi".into(), Vec::new(), None).await.is_err());

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
        .send_owner_message("  fix the login bug  ".into(), Vec::new(), None)
        .await
        .unwrap();
    assert_eq!(row.kind, TimelineKind::Owner);
    assert_eq!(row.status, Some(OwnerStatus::Queued));
    assert_eq!(row.body, "fix the login bug");
    assert!(engine.send_owner_message("   ".into(), Vec::new(), None).await.is_err());
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
    let owner = engine.send_owner_message("hello".into(), Vec::new(), None).await.unwrap();
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
        svc::ReadMark::Read,
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
    let owner = engine.send_owner_message("hello".into(), Vec::new(), None).await.unwrap();
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
    let owner = engine.send_owner_message("again".into(), Vec::new(), None).await.unwrap();
    assert!(engine.resend(owner.id).await.is_err(), "only interrupted ones");
    svc::move_owner_rows(
        &engine.db.conn,
        &[owner.id],
        &[OwnerStatus::Queued],
        OwnerStatus::Interrupted,
        None,
        None,
        svc::ReadMark::Keep,
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
    // The card says what cut it off, for the page to word in its language.
    let (rows, _) = svc::page(&engine.db.conn, None, 100).await.unwrap();
    let card = rows
        .iter()
        .find(|r| r.kind == TimelineKind::Result && r.dispatch_id == Some(id))
        .expect("the restart's card");
    assert_eq!(data_of(card)["cause"], "boot");
    assert_eq!(data_of(card)["note"], "codeg restarted");
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
    engine.save_file("memory/tea.md", "likes tea\n").await.unwrap();
    assert!(!owed(engine.clone()).await, "so is an entry");
    engine.save_file(workdir::SOUL_FILE, "# Persona\n\nTerse.\n").await.unwrap();
    assert!(owed(engine.clone()).await);
}

/// A new name reaches the agent like a persona edit: even one made during a
/// turn, whose end folds the files into the digest.
#[tokio::test]
async fn renaming_the_agent_owes_it_an_update() {
    let (engine, _tmp) = configured().await;
    let seg = open_segment(&engine).await;
    let owed = |engine: std::sync::Arc<PersonalAgentEngine>| async move {
        let row = svc::get_segment(&engine.db.conn, seg).await.unwrap().unwrap();
        SegmentState::parse(&row.state).persona_resend
    };
    let current = engine.agent_row().await.unwrap().name;
    // The same name again, or none given: nothing changed.
    engine
        .save(PersonalAgentDraft { name: Some(format!(" {current} ")), ..Default::default() })
        .await
        .unwrap();
    engine.save(PersonalAgentDraft::default()).await.unwrap();
    assert!(!owed(engine.clone()).await);
    engine
        .save(PersonalAgentDraft { name: Some("Nova".into()), ..Default::default() })
        .await
        .unwrap();
    assert!(owed(engine.clone()).await);
}

#[tokio::test]
async fn the_owner_deletes_an_entry_with_its_index_line() {
    let (engine, tmp) = configured().await;
    let dir = tmp.path().join("personal-agent");
    let lesson = "---\nname: answer-first\ntype: lesson\n---\nanswer first\n";
    engine.save_file("memory/answer-first.md", lesson).await.unwrap();
    engine
        .save_file(
            workdir::MEMORY_FILE,
            "# Memory\n\n- [Answer first](memory/answer-first.md) — the answer first\n",
        )
        .await
        .unwrap();
    let listed = crate::commands::personal_agent::personal_agent_files_core(&engine.db, tmp.path())
        .await
        .unwrap();
    // The fixed files, then the entries; no second index.
    let names: Vec<&str> = listed.iter().map(|f| f.name.as_str()).collect();
    assert_eq!(
        names,
        ["SOUL.md", "AGENTS.md", "USER.md", "MEMORY.md", "memory/answer-first.md"]
    );
    assert!(listed.iter().any(|f| f.name == "memory/answer-first.md" && f.content == lesson));
    engine.delete_file("memory/answer-first.md").await.unwrap();
    assert!(!dir.join("memory/answer-first.md").exists());
    assert_eq!(workdir::read_text(&dir, workdir::MEMORY_FILE), "# Memory\n\n");
    // The fixed files are not entries.
    assert!(engine.delete_file(workdir::SOUL_FILE).await.is_err());
    assert!(dir.join(workdir::SOUL_FILE).is_file());
}

#[tokio::test]
async fn moving_the_workdir_starts_a_new_segment_and_leaves_the_old_one() {
    let (engine, tmp) = configured().await;
    let seg = open_segment(&engine).await;
    let old = tmp.path().join("personal-agent");
    let target = tmp.path().join("elsewhere");
    let info = engine
        .set_workdir(Some(target.to_string_lossy().to_string()), None)
        .await
        .unwrap();
    assert_eq!(info.workdir, target.to_string_lossy());
    assert!(workdir::is_workdir(&target));
    assert!(old.join(workdir::SOUL_FILE).is_file(), "the old directory is left as it is");
    let row = svc::get_segment(&engine.db.conn, seg).await.unwrap().unwrap();
    assert_eq!(row.pending_reason, Some(SegmentReason::Workdir));
}

/// The template files come in the owner's language: the UI's when the
/// request carries it, else the one the settings remember from the last save.
#[tokio::test]
async fn the_templates_follow_the_owners_language() {
    use crate::models::system::AppLocale;
    use crate::personal_agent::templates::template_texts;
    let (engine, tmp) = engine().await;
    let info = engine
        .save(PersonalAgentDraft {
            agent_config: Some(brain(AgentType::ClaudeCode)),
            locale: Some("ja".into()),
            ..Default::default()
        })
        .await
        .unwrap();
    let first = tmp.path().join("personal-agent");
    assert_eq!(
        workdir::read_text(&first, workdir::SOUL_FILE),
        template_texts(AppLocale::Ja)[0]
    );
    assert_eq!(info.settings.locale, Some(AppLocale::Ja));
    // The dialog sends its settings without a language: the one it saves
    // from is remembered, and kept by a save that carries none.
    let info = engine
        .save(PersonalAgentDraft {
            settings: Some(PersonalAgentSettings::default()),
            locale: Some("zh-TW".into()),
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(info.settings.locale, Some(AppLocale::ZhTw));
    let info = engine
        .save(PersonalAgentDraft {
            settings: Some(PersonalAgentSettings::default()),
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(info.settings.locale, Some(AppLocale::ZhTw));
    // A directory made anew by a move: the UI's language, else the remembered.
    let french = tmp.path().join("fr");
    engine
        .set_workdir(Some(french.to_string_lossy().to_string()), Some("fr-FR"))
        .await
        .unwrap();
    assert_eq!(
        workdir::read_text(&french, workdir::RULES_FILE),
        template_texts(AppLocale::Fr)[1]
    );
    let plain = tmp.path().join("plain");
    engine
        .set_workdir(Some(plain.to_string_lossy().to_string()), None)
        .await
        .unwrap();
    assert_eq!(
        workdir::read_text(&plain, workdir::USER_FILE),
        template_texts(AppLocale::ZhTw)[2]
    );
    // The first directory is left as it was.
    assert_eq!(
        workdir::read_text(&first, workdir::SOUL_FILE),
        template_texts(AppLocale::Ja)[0]
    );
}

// ── phase two: the reply, read marks, quotes ───────────────────────────────

use std::sync::Arc;

use crate::acp::connection::ConnectionCommand;
use crate::acp::session_state::SessionState;
use crate::acp::types::ConnectionStatus;
use crate::web::event_bridge::EventEmitter;

type State = Arc<tokio::sync::RwLock<SessionState>>;

/// A live connection of the personal agent on `seg`, its command channel
/// kept open so a delivery can be sent and read back.
async fn live_connection(
    engine: &PersonalAgentEngine,
    seg: i32,
    conn: &str,
) -> (tokio::sync::mpsc::Receiver<ConnectionCommand>, State) {
    let rx = engine
        .manager
        .insert_test_connection_live(conn, AgentType::ClaudeCode, None, EventEmitter::Noop)
        .await;
    let state = engine.manager.get_state(conn).await.unwrap();
    state.write().await.personal_agent = true;
    let mut st = engine.state.lock().await;
    st.connection_id = Some(conn.into());
    st.connection_segment = Some(seg);
    drop(st);
    (rx, state)
}

/// Apply an event as the connection emits one; `feed` hands its envelope
/// to the engine too (otherwise the engine has not read it yet, or the bus
/// dropped it). Returns its seq.
async fn emit(
    engine: &Arc<PersonalAgentEngine>,
    state: &State,
    conn: &str,
    ev: AcpEvent,
    feed: bool,
) -> u64 {
    let seq = {
        let mut s = state.write().await;
        s.apply_event(&ev);
        s.event_seq += 1;
        s.event_seq
    };
    if feed {
        engine.feed_for_test(conn, seq, ev).await;
    }
    seq
}

/// The loop starting a prompt: its tag opens the reply in the same step.
async fn start_prompt(state: &State, token: Option<&str>) {
    let mut s = state.write().await;
    s.turn_in_flight = true;
    if let Some(t) = token {
        s.reply_turns.open(t.into());
    }
    s.apply_event(&AcpEvent::StatusChanged {
        status: ConnectionStatus::Prompting,
    });
    s.event_seq += 1;
}

/// A turn the agent starts on its own (Grok does).
async fn agent_turn(state: &State) {
    let mut s = state.write().await;
    s.begin_agent_initiated_turn();
}

fn text(t: &str) -> AcpEvent {
    AcpEvent::ContentDelta {
        text: t.into(),
        parent_tool_use_id: None,
    }
}

fn tool(id: &str, title: &str) -> AcpEvent {
    AcpEvent::ToolCall {
        tool_call_id: id.into(),
        title: title.into(),
        kind: "edit".into(),
        status: "in_progress".into(),
        content: None,
        raw_input: None,
        raw_output: None,
        locations: None,
        meta: None,
        images: None,
    }
}

/// Take the delivery the engine sent: its text and its tag.
fn take_prompt(rx: &mut tokio::sync::mpsc::Receiver<ConnectionCommand>) -> (String, String) {
    let Ok(ConnectionCommand::Prompt {
        blocks,
        reply_token,
        ..
    }) = rx.try_recv()
    else {
        panic!("a delivery was sent");
    };
    let text = blocks
        .iter()
        .filter_map(|b| match b {
            crate::acp::types::PromptInputBlock::Text { text } => Some(text.clone()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("\n");
    (text, reply_token.expect("a delivery is tagged"))
}

fn data_of(row: &crate::db::entities::personal_agent_timeline::Model) -> serde_json::Value {
    row.data
        .as_deref()
        .and_then(|d| serde_json::from_str(d).ok())
        .unwrap_or_default()
}

async fn reply_of(
    engine: &PersonalAgentEngine,
    batch_id: i32,
) -> crate::db::entities::personal_agent_timeline::Model {
    svc::reply_row_of_batch(&engine.db.conn, batch_id)
        .await
        .unwrap()
        .expect("the batch's reply row")
}

#[tokio::test]
async fn a_delivery_streams_into_its_reply_row_and_settles_it_with_the_last_text() {
    let (engine, _tmp) = configured().await;
    let seg = open_segment(&engine).await;
    let (mut rx, state) = live_connection(&engine, seg, "pa-1").await;
    let owner = engine
        .send_owner_message("what's new?".into(), Vec::new(), None)
        .await
        .unwrap();
    assert!(owner.read_at.is_none(), "unread until a delivery carries it");

    engine.pump().await;
    let (prompt, token) = take_prompt(&mut rx);
    assert!(prompt.contains(&format!("[#{}] what's new?", owner.id)), "{prompt}");
    let carried = svc::get_row(&engine.db.conn, owner.id).await.unwrap().unwrap();
    assert_eq!(carried.status, Some(OwnerStatus::Delivered));
    assert!(carried.read_at.is_some(), "read once the assistant starts on it");
    let batch = carried.batch_id.unwrap();
    let reply = reply_of(&engine, batch).await;
    assert_eq!(data_of(&reply)["state"], "running");
    assert!(reply.body.is_empty());

    start_prompt(&state, Some(&token)).await;
    emit(&engine, &state, "pa-1", text("Let me check."), true).await;
    emit(&engine, &state, "pa-1", tool("t1", "Read notes.md"), true).await;
    emit(&engine, &state, "pa-1", text("Nothing new since Monday."), true).await;
    // A tool after the answer: its step replaces the text, the body does not.
    emit(&engine, &state, "pa-1", tool("t2", "Edit MEMORY.md"), true).await;
    emit(&engine, &state, "pa-1", turn_complete("end_turn"), true).await;

    assert!(!engine.turn_in_flight_for_test().await);
    let reply = reply_of(&engine, batch).await;
    let data = data_of(&reply);
    assert_eq!(reply.body, "Nothing new since Monday.");
    assert_eq!(data["state"], "done");
    assert_eq!(data["last_text_n"], 3);
    assert_eq!(data["step_count"], 4);
    assert_eq!(data["stop_reason"], "end_turn");
    assert!(data.get("current").is_none(), "a settled reply keeps no step");
    let answered = svc::get_row(&engine.db.conn, owner.id).await.unwrap().unwrap();
    assert_eq!(answered.status, Some(OwnerStatus::Answered));
    assert!(answered.read_at.is_some());
    // Released: the connection keeps nothing of it.
    assert!(state.read().await.reply_turns.snapshot(&token).is_none());
}

/// A completion of another turn on the connection — a prompt sent from
/// elsewhere, or Grok's own turn closed just before this prompt started —
/// never settles the delivery: only the completion that sealed its tag does.
#[tokio::test]
async fn only_the_completion_of_its_own_prompt_settles_a_delivery() {
    let (engine, _tmp) = configured().await;
    let seg = open_segment(&engine).await;
    let (mut rx, state) = live_connection(&engine, seg, "pa-2").await;
    // Grok runs a turn of its own; the delivery is admitted meanwhile.
    agent_turn(&state).await;
    emit(&engine, &state, "pa-2", text("Grok's own words."), true).await;
    engine
        .send_owner_message("hello".into(), Vec::new(), None)
        .await
        .unwrap();
    engine.pump().await;
    let (_, token) = take_prompt(&mut rx);

    // Before this prompt starts, the loop closes Grok's turn for it.
    emit(&engine, &state, "pa-2", turn_complete("cancelled"), true).await;
    assert!(engine.turn_in_flight_for_test().await, "not this delivery's end");
    // A prompt from elsewhere would end the same way: no tag, no end.

    start_prompt(&state, Some(&token)).await;
    emit(&engine, &state, "pa-2", text("Hi there."), true).await;
    emit(&engine, &state, "pa-2", turn_complete("end_turn"), true).await;
    assert!(!engine.turn_in_flight_for_test().await);
    let batch = svc::running_batches(&engine.db.conn).await.unwrap();
    assert!(batch.is_empty());
    let rows = svc::page(&engine.db.conn, None, 50).await.unwrap().0;
    let reply = rows
        .iter()
        .find(|r| r.kind == TimelineKind::Reply)
        .expect("the reply");
    assert_eq!(reply.body, "Hi there.");
}

/// The end is decided by the completion that sealed the delivery's reply;
/// turns the agent starts afterwards — five of them, the bus dropping their
/// envelopes, before the engine reads the delivery's — never reach it.
#[tokio::test]
async fn turns_after_the_end_never_reach_the_settled_reply() {
    let (engine, _tmp) = configured().await;
    let seg = open_segment(&engine).await;
    let (mut rx, state) = live_connection(&engine, seg, "pa-3").await;
    engine
        .send_owner_message("status?".into(), Vec::new(), None)
        .await
        .unwrap();
    engine.pump().await;
    let (_, token) = take_prompt(&mut rx);
    start_prompt(&state, Some(&token)).await;
    emit(&engine, &state, "pa-3", text("All green."), false).await;
    let end = emit(&engine, &state, "pa-3", turn_complete("end_turn"), false).await;
    for i in 0..5 {
        agent_turn(&state).await;
        emit(&engine, &state, "pa-3", text(&format!("later {i}")), false).await;
        emit(&engine, &state, "pa-3", turn_complete("end_turn"), false).await;
    }
    engine
        .feed_for_test("pa-3", end, turn_complete("end_turn"))
        .await;
    let rows = svc::page(&engine.db.conn, None, 50).await.unwrap().0;
    let reply = rows.iter().find(|r| r.kind == TimelineKind::Reply).unwrap();
    assert_eq!(reply.body, "All green.");
}

/// Its completion lost on the bus, the delivery is settled by the liveness
/// check — from the reply the connection sealed, not from what came after.
#[tokio::test]
async fn the_liveness_check_settles_a_missed_end_from_the_sealed_reply() {
    let (engine, _tmp) = configured().await;
    let seg = open_segment(&engine).await;
    let (mut rx, state) = live_connection(&engine, seg, "pa-4").await;
    engine
        .send_owner_message("status?".into(), Vec::new(), None)
        .await
        .unwrap();
    engine.pump().await;
    let (_, token) = take_prompt(&mut rx);
    start_prompt(&state, Some(&token)).await;
    emit(&engine, &state, "pa-4", text("Done: all tests pass."), false).await;
    emit(&engine, &state, "pa-4", turn_complete("end_turn"), false).await;
    agent_turn(&state).await;
    emit(&engine, &state, "pa-4", text("unrelated"), false).await;
    emit(&engine, &state, "pa-4", turn_complete("end_turn"), false).await;
    engine.backdate_turn_for_test(10).await;
    engine.liveness_for_test().await;
    assert!(!engine.turn_in_flight_for_test().await);
    let rows = svc::page(&engine.db.conn, None, 50).await.unwrap().0;
    let reply = rows.iter().find(|r| r.kind == TimelineKind::Reply).unwrap();
    assert_eq!(reply.body, "Done: all tests pass.");
    assert_eq!(data_of(reply)["state"], "done");
}

/// A turn stopped mid-way keeps the text it wrote; one that wrote nothing
/// keeps nothing.
#[tokio::test]
async fn a_stopped_reply_keeps_what_it_wrote() {
    let (engine, _tmp) = configured().await;
    let seg = open_segment(&engine).await;
    let (mut rx, state) = live_connection(&engine, seg, "pa-5").await;
    engine
        .send_owner_message("write a lot".into(), Vec::new(), None)
        .await
        .unwrap();
    engine.pump().await;
    let (_, token) = take_prompt(&mut rx);
    start_prompt(&state, Some(&token)).await;
    emit(&engine, &state, "pa-5", text("First half of"), true).await;
    emit(&engine, &state, "pa-5", turn_complete("cancelled"), true).await;
    let rows = svc::page(&engine.db.conn, None, 50).await.unwrap().0;
    let reply = rows.iter().find(|r| r.kind == TimelineKind::Reply).unwrap();
    assert_eq!(reply.body, "First half of");
    assert_eq!(data_of(reply)["state"], "canceled");
}

#[tokio::test]
async fn a_reply_quotes_the_row_its_marker_names() {
    let (engine, _tmp) = configured().await;
    let seg = open_segment(&engine).await;
    let (mut rx, state) = live_connection(&engine, seg, "pa-6").await;
    let first = engine
        .send_owner_message("book the flight".into(), Vec::new(), None)
        .await
        .unwrap();
    let second = engine
        .send_owner_message("and the hotel".into(), Vec::new(), None)
        .await
        .unwrap();
    engine.pump().await;
    let (prompt, token) = take_prompt(&mut rx);
    assert!(prompt.contains("The owner sent 2 messages"), "{prompt}");
    start_prompt(&state, Some(&token)).await;
    // A marker naming a row that cannot be quoted (later than the reply) is
    // dropped; the first one that can wins.
    emit(&engine, &state, "pa-6", text("[[quote:#99999]]"), true).await;
    emit(
        &engine,
        &state,
        "pa-6",
        text(&format!("[[quote:#{}]] The flight is booked.", first.id)),
        true,
    )
    .await;
    emit(&engine, &state, "pa-6", turn_complete("end_turn"), true).await;
    let batch = svc::get_row(&engine.db.conn, second.id)
        .await
        .unwrap()
        .unwrap()
        .batch_id
        .unwrap();
    let reply = reply_of(&engine, batch).await;
    assert_eq!(reply.body, "The flight is booked.");
    assert_eq!(reply.reply_to, Some(first.id));
}

/// A message that quotes another carries it into the delivery; a reply
/// still being written cannot be quoted.
#[tokio::test]
async fn an_owner_quote_rides_in_the_delivery() {
    let (engine, _tmp) = configured().await;
    let seg = open_segment(&engine).await;
    let (mut rx, _state) = live_connection(&engine, seg, "pa-7").await;
    let earlier = engine
        .send_owner_message("the build is red".into(), Vec::new(), None)
        .await
        .unwrap();
    let running = {
        let mut r = NewRow::new(TimelineKind::Reply, "");
        r.data = Some(serde_json::json!({ "state": "running" }));
        svc::insert_row(&engine.db.conn, r).await.unwrap()
    };
    assert!(engine
        .send_owner_message("this?".into(), Vec::new(), Some(running.id))
        .await
        .is_err());
    // Settle the first one out of the way so this delivery carries one.
    svc::move_owner_rows(
        &engine.db.conn,
        &[earlier.id],
        &[OwnerStatus::Queued],
        OwnerStatus::Answered,
        None,
        None,
        svc::ReadMark::Read,
    )
    .await
    .unwrap();
    let why = engine
        .send_owner_message("why?".into(), Vec::new(), Some(earlier.id))
        .await
        .unwrap();
    assert_eq!(why.reply_to, Some(earlier.id));
    engine.pump().await;
    let (prompt, _) = take_prompt(&mut rx);
    assert!(
        prompt.contains(&format!(
            "[#{}, replying to #{} — \"the build is red\"] why?",
            why.id, earlier.id
        )),
        "{prompt}"
    );
}

/// Nothing reached the agent: the reply is void, the message back in the
/// queue and unread.
#[tokio::test]
async fn a_send_that_fails_voids_the_reply_and_leaves_the_message_unread() {
    let (engine, _tmp) = configured().await;
    let seg = open_segment(&engine).await;
    // A connection whose loop is gone: the send fails at the channel.
    engine
        .manager
        .insert_test_connection("pa-8", AgentType::ClaudeCode, None, EventEmitter::Noop)
        .await;
    {
        let mut st = engine.state.lock().await;
        st.connection_id = Some("pa-8".into());
        st.connection_segment = Some(seg);
    }
    let owner = engine
        .send_owner_message("hi".into(), Vec::new(), None)
        .await
        .unwrap();
    engine.pump().await;
    let row = svc::get_row(&engine.db.conn, owner.id).await.unwrap().unwrap();
    assert_eq!(row.status, Some(OwnerStatus::Queued));
    assert!(row.read_at.is_none());
    let rows = svc::page(&engine.db.conn, None, 50).await.unwrap().0;
    let reply = rows.iter().find(|r| r.kind == TimelineKind::Reply).unwrap();
    assert!(svc::is_discarded(reply));
}

/// A result card and its event go in together, numbered and quoting the
/// reply of the turn that dispatched the work; the delivery that carries the
/// event marks the card read, and its reply quotes the card.
#[tokio::test]
async fn a_result_card_is_quoted_numbered_and_read() {
    let (engine, _tmp) = configured().await;
    let seg = open_segment(&engine).await;
    let batch = svc::create_batch(&engine.db.conn, seg, BatchKind::Delivery, None)
        .await
        .unwrap();
    let reply_id = engine
        .begin_delivery_for_test("pa-9", seg, batch.id, "tok-9", 0)
        .await;
    let id = session_dispatch(&engine, DispatchState::Completed, "conn-9").await;
    svc::update_dispatch(
        &engine.db.conn,
        id,
        None,
        DispatchWrite {
            source_batch_id: Some(Some(batch.id)),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    // The delivery that dispatched it is over.
    engine.liveness_for_test().await;
    assert!(!engine.turn_in_flight_for_test().await);
    let d = dispatch_state(&engine, id).await;
    engine.record_progress(&d, Some("it works".into()), None, "turn").await;
    let rows = svc::page(&engine.db.conn, None, 100).await.unwrap().0;
    let card = rows
        .iter()
        .find(|r| r.kind == TimelineKind::Result)
        .expect("the result card");
    assert_eq!(card.reply_to, Some(reply_id));
    assert!(card.read_at.is_none(), "unread until handed over");
    let event = svc::pending_events(&engine.db.conn).await.unwrap();
    assert_eq!(card.event_id, Some(event[0].id));

    let (mut rx, state) = live_connection(&engine, seg, "pa-9b").await;
    engine.pump().await;
    let (prompt, token) = take_prompt(&mut rx);
    assert!(prompt.contains(&format!("- [#{}] Dispatch #{id}", card.id)), "{prompt}");
    let card_now = svc::get_row(&engine.db.conn, card.id).await.unwrap().unwrap();
    assert!(card_now.read_at.is_some());
    start_prompt(&state, Some(&token)).await;
    emit(&engine, &state, "pa-9b", text("The investigation is done."), true).await;
    emit(&engine, &state, "pa-9b", turn_complete("end_turn"), true).await;
    let event_batch = svc::get_row(&engine.db.conn, card.id).await.unwrap().unwrap();
    let _ = event_batch;
    let replies: Vec<_> = svc::page(&engine.db.conn, None, 100)
        .await
        .unwrap()
        .0
        .into_iter()
        .filter(|r| r.kind == TimelineKind::Reply && r.id != reply_id)
        .collect();
    assert_eq!(replies.len(), 1);
    assert_eq!(replies[0].reply_to, Some(card.id), "an event alone is answered");
}

/// Interrupted: a put-back event's card is unread again; one put back once
/// already is settled and stays read. The reply keeps its last checkpoint.
#[tokio::test]
async fn an_interrupted_delivery_unreads_exactly_what_it_puts_back() {
    let (engine, _tmp) = configured().await;
    let seg = open_segment(&engine).await;
    let fresh = session_dispatch(&engine, DispatchState::Completed, "conn-10").await;
    let again = session_dispatch(&engine, DispatchState::Failed, "conn-11").await;
    for id in [fresh, again] {
        let d = dispatch_state(&engine, id).await;
        engine.record_progress(&d, None, None, "turn").await;
    }
    let events = svc::pending_events(&engine.db.conn).await.unwrap();
    assert_eq!(events.len(), 2);
    // The second was put back once before.
    let earlier = svc::create_batch(&engine.db.conn, seg, BatchKind::Delivery, None)
        .await
        .unwrap();
    svc::mark_events_delivered(&engine.db.conn, &[events[1].id], earlier.id)
        .await
        .unwrap();
    svc::requeue_batch_events(&engine.db.conn, earlier.id).await.unwrap();

    let batch = svc::create_batch(&engine.db.conn, seg, BatchKind::Delivery, None)
        .await
        .unwrap();
    let ids: Vec<i32> = events.iter().map(|e| e.id).collect();
    let taken = svc::mark_events_delivered(&engine.db.conn, &ids, batch.id)
        .await
        .unwrap();
    assert_eq!(taken.len(), 2);
    svc::set_result_rows_read(&engine.db.conn, &taken, Some(chrono::Utc::now()))
        .await
        .unwrap();
    let mut r = NewRow::new(TimelineKind::Reply, "");
    r.batch_id = Some(batch.id);
    r.data = Some(serde_json::json!({
        "state": "running",
        "last_text": { "n": 2, "text": "Half an answ" },
        "step_count": 2,
    }));
    let reply = svc::insert_row(&engine.db.conn, r).await.unwrap();

    engine.boot_for_test().await;

    let cards = svc::result_rows_of_events(&engine.db.conn, &ids).await.unwrap();
    let card_of = |event: i32| cards.iter().find(|c| c.event_id == Some(event)).unwrap();
    assert!(card_of(events[0].id).read_at.is_none(), "put back: unread");
    assert!(card_of(events[1].id).read_at.is_some(), "settled: stays read");
    let reply = svc::get_row(&engine.db.conn, reply.id).await.unwrap().unwrap();
    assert_eq!(reply.body, "Half an answ");
    let data = data_of(&reply);
    assert_eq!(data["state"], "interrupted");
    assert_eq!(data["why"], "restart");
    assert_eq!(data["last_text_n"], 2);
}

/// A follow-up shows in the reply of the turn that asked for it, and what it
/// brings back quotes that reply — even when it could not be sent.
#[tokio::test]
async fn a_follow_up_belongs_to_the_turn_that_asked_for_it() {
    let (engine, _tmp) = configured().await;
    let seg = open_segment(&engine).await;
    let id = session_dispatch(&engine, DispatchState::Completed, "conn-12").await;
    let batch = svc::create_batch(&engine.db.conn, seg, BatchKind::Delivery, None)
        .await
        .unwrap();
    let reply_id = engine
        .begin_delivery_for_test("pa-12", seg, batch.id, "tok-12", 0)
        .await;
    // Its conversation is gone: the follow-up cannot be sent.
    assert!(engine.followup(id, "dig deeper".into(), None).await.is_err());
    let rows = svc::page(&engine.db.conn, None, 100).await.unwrap().0;
    let card = rows
        .iter()
        .find(|r| r.kind == TimelineKind::Dispatch && data_of(r)["followup"] == true)
        .expect("the follow-up card");
    assert_eq!(card.batch_id, Some(batch.id));
    assert_eq!(data_of(card)["failed"], true);
    assert_eq!(dispatch_state(&engine, id).await.source_batch_id, Some(batch.id));
    let d = dispatch_state(&engine, id).await;
    engine.record_progress(&d, None, Some("x".into()), "followup").await;
    let rows = svc::page(&engine.db.conn, None, 100).await.unwrap().0;
    let result = rows.iter().find(|r| r.kind == TimelineKind::Result).unwrap();
    assert_eq!(result.reply_to, Some(reply_id));
}

/// A page never starts inside a turn: it is pulled back to the turn's first
/// row (its reply, or a phase-one turn's first card).
#[tokio::test]
async fn a_page_never_cuts_a_turn() {
    let (engine, _tmp) = configured().await;
    let seg = open_segment(&engine).await;
    let batch = svc::create_batch(&engine.db.conn, seg, BatchKind::Delivery, None)
        .await
        .unwrap();
    let insert = |kind: TimelineKind, batch: Option<i32>, body: &'static str| {
        let conn = engine.db.conn.clone();
        async move {
            let mut r = NewRow::new(kind, body);
            r.batch_id = batch;
            svc::insert_row(&conn, r).await.unwrap().id
        }
    };
    insert(TimelineKind::Owner, None, "older").await;
    let reply = insert(TimelineKind::Reply, Some(batch.id), "answer").await;
    insert(TimelineKind::Dispatch, Some(batch.id), "task a").await;
    insert(TimelineKind::Dispatch, Some(batch.id), "task b").await;
    insert(TimelineKind::Owner, None, "next").await;
    let (rows, has_older) = svc::page(&engine.db.conn, None, 2).await.unwrap();
    assert_eq!(rows.first().map(|r| r.id), Some(reply), "pulled back to the reply");
    assert_eq!(rows.len(), 4);
    assert!(has_older);
    let (older, has_older) = svc::page(&engine.db.conn, Some(reply), 10).await.unwrap();
    assert_eq!(older.len(), 1);
    assert!(!has_older);
}

/// Changed rows are read in `(updated_at, id)` order, a read going on past
/// rows written in the same instant.
#[tokio::test]
async fn changed_rows_are_read_on_past_a_shared_instant() {
    let (engine, _tmp) = configured().await;
    let mut ids = Vec::new();
    for i in 0..5 {
        ids.push(
            engine
                .send_owner_message(format!("m{i}"), Vec::new(), None)
                .await
                .unwrap()
                .id,
        );
    }
    // One write gives them all the same moment.
    svc::move_owner_rows(
        &engine.db.conn,
        &ids,
        &[OwnerStatus::Queued],
        OwnerStatus::Interrupted,
        None,
        None,
        svc::ReadMark::Keep,
    )
    .await
    .unwrap();
    let since = chrono::Utc::now() - chrono::Duration::hours(1);
    let mut seen = Vec::new();
    let (rows, mut next) = svc::changed_since_limited(&engine.db.conn, Some(since), None, 0, 2)
        .await
        .unwrap();
    seen.extend(rows.into_iter().map(|r| r.id));
    while let Some(cursor) = next {
        let (rows, more) = svc::changed_since_limited(&engine.db.conn, None, Some(cursor), 0, 2)
            .await
            .unwrap();
        seen.extend(rows.into_iter().map(|r| r.id));
        next = more;
    }
    assert_eq!(seen, ids);
    let (from_third, _) = svc::changed_since(&engine.db.conn, Some(since), None, ids[2])
        .await
        .unwrap();
    assert_eq!(from_third.len(), 3);
}

/// What the agent and the stats read of the timeline leave out a reply
/// being written and one that never started.
#[tokio::test]
async fn unwritten_replies_are_left_out_of_what_is_read_back() {
    let (engine, _tmp) = configured().await;
    for state in ["running", "discarded"] {
        let mut r = NewRow::new(TimelineKind::Reply, "");
        r.data = Some(serde_json::json!({ "state": state }));
        svc::insert_row(&engine.db.conn, r).await.unwrap();
    }
    svc::insert_row(&engine.db.conn, NewRow::new(TimelineKind::Reply, "phase one"))
        .await
        .unwrap();
    let out = super::tools::timeline_read_for_test(&engine).await;
    assert_eq!(out.matches("you:").count(), 1, "{out}");
    let stats = crate::commands::personal_agent::personal_agent_stats_core(&engine.db, Some(1))
        .await
        .unwrap();
    assert_eq!(stats.days.iter().map(|d| d.replies).sum::<u32>(), 1);
}

/// What is new to the owner: a reply once it settled and a result card —
/// never a reply still running or one that never started, nor what the owner
/// wrote. Marking stops at the row it names, marks once, and a reply that
/// settles after it is new until the next mark.
#[tokio::test]
async fn the_owner_sees_settled_replies_and_cards_up_to_a_row() {
    let (engine, _tmp) = configured().await;
    let conn = &engine.db.conn;
    let reply = |state: &str| {
        let mut r = NewRow::new(TimelineKind::Reply, "words");
        r.data = Some(serde_json::json!({ "state": state }));
        r
    };
    let owner = engine
        .send_owner_message("hi".into(), Vec::new(), None)
        .await
        .unwrap();
    let done = svc::insert_row(conn, reply("done")).await.unwrap();
    let card = svc::insert_row(conn, NewRow::new(TimelineKind::Result, "news"))
        .await
        .unwrap();
    let running = svc::insert_row(conn, reply("running")).await.unwrap();
    svc::insert_row(conn, reply("discarded")).await.unwrap();
    let after = svc::insert_row(conn, reply("canceled")).await.unwrap();
    assert_eq!(svc::count_unseen(conn).await.unwrap(), 3);
    assert_eq!(engine.snapshot().await.status.unseen, 3);

    let marked = svc::mark_seen(conn, running.id).await.unwrap();
    assert_eq!(
        marked.iter().map(|m| m.id).collect::<Vec<_>>(),
        vec![done.id, card.id],
        "up to the row named, and not the running reply"
    );
    assert!(marked.iter().all(|m| m.seen_at.is_some()));
    assert_eq!(svc::count_unseen(conn).await.unwrap(), 1, "the later reply");
    assert!(svc::mark_seen(conn, running.id).await.unwrap().is_empty());
    let own = svc::get_row(conn, owner.id).await.unwrap().unwrap();
    assert!(own.seen_at.is_none(), "the owner's own message is not marked");

    svc::settle_reply_row(
        conn,
        running.id,
        "the end".into(),
        serde_json::json!({ "state": "done" }),
        None,
    )
    .await
    .unwrap();
    assert_eq!(svc::count_unseen(conn).await.unwrap(), 2, "settled: new");

    // A read-only page marks straight in the database.
    crate::commands::personal_agent::personal_agent_mark_seen_core(&engine.db, after.id)
        .await
        .unwrap();
    assert_eq!(svc::count_unseen(conn).await.unwrap(), 0);
    engine.mark_seen(after.id).await.unwrap();
    assert_eq!(engine.snapshot().await.status.unseen, 0);
}

/// A resent message keeps the row it quoted.
#[tokio::test]
async fn a_resent_message_keeps_its_quote() {
    let (engine, _tmp) = configured().await;
    let earlier = engine
        .send_owner_message("first".into(), Vec::new(), None)
        .await
        .unwrap();
    let owner = engine
        .send_owner_message("about that".into(), Vec::new(), Some(earlier.id))
        .await
        .unwrap();
    svc::move_owner_rows(
        &engine.db.conn,
        &[owner.id],
        &[OwnerStatus::Queued],
        OwnerStatus::Interrupted,
        None,
        None,
        svc::ReadMark::Read,
    )
    .await
    .unwrap();
    let copy = engine.resend(owner.id).await.unwrap();
    assert_eq!(copy.reply_to, Some(earlier.id));
    assert!(copy.read_at.is_none(), "the copy starts unread");
}

/// The completion that sealed the reply was dropped by the bus: the next
/// completion on the connection settles the delivery from the sealed copy,
/// with the sealed turn's own stop reason — and so does the liveness check.
#[tokio::test]
async fn a_dropped_sealing_completion_still_settles_with_its_stop_reason() {
    let (engine, _tmp) = configured().await;
    let seg = open_segment(&engine).await;
    let (mut rx, state) = live_connection(&engine, seg, "pa-13").await;
    let owner = engine
        .send_owner_message("stop it".into(), Vec::new(), None)
        .await
        .unwrap();
    engine.pump().await;
    let (_, token) = take_prompt(&mut rx);
    start_prompt(&state, Some(&token)).await;
    emit(&engine, &state, "pa-13", text("Half"), true).await;
    // Sealed by a stop the engine never reads.
    emit(&engine, &state, "pa-13", turn_complete("cancelled"), false).await;
    // Grok's own turn after it, whose completion the engine does read.
    agent_turn(&state).await;
    emit(&engine, &state, "pa-13", text("unrelated"), true).await;
    emit(&engine, &state, "pa-13", turn_complete("end_turn"), true).await;
    assert!(!engine.turn_in_flight_for_test().await);
    let batch = svc::get_row(&engine.db.conn, owner.id)
        .await
        .unwrap()
        .unwrap()
        .batch_id
        .unwrap();
    let reply = reply_of(&engine, batch).await;
    assert_eq!(reply.body, "Half");
    assert_eq!(data_of(&reply)["state"], "canceled");

    // The liveness check, with no completion read at all.
    let owner = engine
        .send_owner_message("again".into(), Vec::new(), None)
        .await
        .unwrap();
    engine.pump().await;
    let (_, token) = take_prompt(&mut rx);
    start_prompt(&state, Some(&token)).await;
    emit(&engine, &state, "pa-13", text("Partial"), false).await;
    emit(&engine, &state, "pa-13", turn_complete("cancelled"), false).await;
    engine.backdate_turn_for_test(10).await;
    engine.liveness_for_test().await;
    let batch = svc::get_row(&engine.db.conn, owner.id)
        .await
        .unwrap()
        .unwrap()
        .batch_id
        .unwrap();
    let reply = reply_of(&engine, batch).await;
    assert_eq!(reply.body, "Partial");
    assert_eq!(data_of(&reply)["state"], "canceled");
}
