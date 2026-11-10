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
    let seg = svc::create_segment(&engine.db.conn, engine.bot().await, "claude_code", config, SegmentReason::First)
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
    let seg = svc::create_segment(&engine.db.conn, engine.bot().await, "claude_code", config, SegmentReason::First)
        .await
        .unwrap();
    let owner = engine.send_owner_message("hello".into(), Vec::new(), None).await.unwrap();
    assert!(svc::insert_event(
        &engine.db.conn,
        engine.bot().await,
        "dispatch_status",
        "dispatch:1:0:review:task",
        Some("dispatch:1".into()),
        "Dispatch #1 is in review.".into(),
        None,
        true,
    )
    .await
    .unwrap());
    let batch = svc::create_batch(&engine.db.conn, engine.bot().await, seg.id, BatchKind::Delivery, None)
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
    let events = svc::pending_events(&engine.db.conn, engine.bot().await).await.unwrap();
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
    let pending = svc::pending_events(&engine.db.conn, engine.bot().await).await.unwrap();
    assert_eq!(pending.len(), 1, "put back once");
    assert_eq!(pending[0].requeues, 1);

    // The same event interrupted a second time is not put back again.
    let batch2 = svc::create_batch(&engine.db.conn, engine.bot().await, seg.id, BatchKind::Delivery, None)
        .await
        .unwrap();
    svc::mark_events_delivered(&engine.db.conn, &[pending[0].id], batch2.id)
        .await
        .unwrap();
    svc::requeue_batch_events(&engine.db.conn, batch2.id).await.unwrap();
    assert!(svc::pending_events(&engine.db.conn, engine.bot().await).await.unwrap().is_empty());
}

#[tokio::test]
async fn an_interrupted_compaction_leaves_the_messages_queued() {
    let (engine, _tmp) = configured().await;
    let config = serde_json::to_string(&brain(AgentType::ClaudeCode)).unwrap();
    let seg = svc::create_segment(&engine.db.conn, engine.bot().await, "claude_code", config, SegmentReason::First)
        .await
        .unwrap();
    let owner = engine.send_owner_message("hello".into(), Vec::new(), None).await.unwrap();
    svc::create_batch(&engine.db.conn, engine.bot().await, seg.id, BatchKind::Compaction, None)
        .await
        .unwrap();
    engine.boot_for_test().await;
    let row = svc::get_row(&engine.db.conn, owner.id).await.unwrap().unwrap();
    assert_eq!(row.status, Some(OwnerStatus::Queued));
    assert!(svc::running_batches(&engine.db.conn, engine.bot().await).await.unwrap().is_empty());
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
    let (rows, _) = svc::page(&engine.db.conn, engine.bot().await, None, 50).await.unwrap();
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
            bot_id: engine.bot().await,
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
    let events = svc::pending_events(&engine.db.conn, engine.bot().await).await.unwrap();
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
    let seg = svc::create_segment(&engine.db.conn, engine.bot().await, "claude_code", config, SegmentReason::First)
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
    let (rows, _) = svc::page(&engine.db.conn, engine.bot().await, None, 50).await.unwrap();
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
        svc::insert_row(&engine.db.conn, engine.bot().await, NewRow::new(TimelineKind::Reply, format!("r{i}")))
            .await
            .unwrap();
    }
    let (rows, has_older) = svc::page(&engine.db.conn, engine.bot().await, None, 3).await.unwrap();
    assert!(has_older);
    assert_eq!(
        rows.iter().map(|r| r.body.as_str()).collect::<Vec<_>>(),
        ["r2", "r3", "r4"]
    );
    let (older, has_older) = svc::page(&engine.db.conn, engine.bot().await, Some(rows[0].id), 3).await.unwrap();
    assert!(!has_older);
    assert_eq!(
        older.iter().map(|r| r.body.as_str()).collect::<Vec<_>>(),
        ["r0", "r1"]
    );
}

// ── review round 1 regressions ─────────────────────────────────────────────

async fn open_segment(engine: &PersonalAgentEngine) -> i32 {
    let config = serde_json::to_string(&brain(AgentType::ClaudeCode)).unwrap();
    svc::create_segment(&engine.db.conn, engine.bot().await, "claude_code", config, SegmentReason::First)
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
            bot_id: engine.bot().await,
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
    let (rows, _) = svc::page(&engine.db.conn, engine.bot().await, None, 200).await.unwrap();
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
        engine.bot().await,
        "dispatch_status",
        "dispatch:9:0:completed:turn",
        Some("dispatch:9".into()),
        "Dispatch #9 finished.".into(),
        None,
        true,
    )
    .await
    .unwrap());
    let batch = svc::create_batch(&engine.db.conn, engine.bot().await, seg, BatchKind::Delivery, None)
        .await
        .unwrap();
    let events = svc::pending_events(&engine.db.conn, engine.bot().await).await.unwrap();
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
            bot_id: engine.bot().await,
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

    let pending = svc::pending_events(&engine.db.conn, engine.bot().await).await.unwrap();
    assert_eq!(pending.len(), 1);
    assert_eq!(pending[0].requeued_from, Some(batch.id));
    let note = engine.interrupted_note(&pending, &[]).await.expect("a note");
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
    let events = svc::pending_events(&engine.db.conn, engine.bot().await).await.unwrap();
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
        engine.bot().await,
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
    assert_eq!(failures(&svc::pending_events(&engine.db.conn, engine.bot().await).await.unwrap()), 1);

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
    assert_eq!(failures(&svc::pending_events(&engine.db.conn, engine.bot().await).await.unwrap()), 2);
}

#[tokio::test]
async fn a_dispatch_interrupted_by_restarts_in_two_rounds_reports_both() {
    let (engine, _tmp) = configured().await;
    let id = session_dispatch(&engine, DispatchState::Running, "conn-r").await;
    engine.boot_for_test().await;
    assert_eq!(dispatch_state(&engine, id).await.state, DispatchState::Interrupted);
    // The card says what cut it off, for the page to word in its language.
    let (rows, _) = svc::page(&engine.db.conn, engine.bot().await, None, 100).await.unwrap();
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
    let interrupted = svc::pending_events(&engine.db.conn, engine.bot().await)
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
        let batch = svc::create_batch(&engine.db.conn, engine.bot().await, seg, BatchKind::Compaction, None)
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
    let batch = svc::create_batch(&engine.db.conn, engine.bot().await, seg, BatchKind::Compaction, None)
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
    let batch = svc::create_batch(&engine.db.conn, engine.bot().await, seg, BatchKind::Delivery, None)
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
    let batch = svc::create_batch(&engine.db.conn, engine.bot().await, seg, BatchKind::Delivery, None)
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
        engine.bot().await,
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
    let events = svc::pending_events(&engine.db.conn, engine.bot().await).await.unwrap();
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
    let events = svc::pending_events(&engine.db.conn, engine.bot().await).await.unwrap();
    assert_eq!(events.len(), 1);
    assert!(events[0].wake, "the agent is told the executor waits");
    let (rows, _) = svc::page(&engine.db.conn, engine.bot().await, None, 50).await.unwrap();
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
    let listed = crate::commands::personal_agent::personal_agent_files_core(&engine.db, tmp.path(), None)
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
    let batch = svc::running_batches(&engine.db.conn, engine.bot().await).await.unwrap();
    assert!(batch.is_empty());
    let rows = svc::page(&engine.db.conn, engine.bot().await, None, 50).await.unwrap().0;
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
    let rows = svc::page(&engine.db.conn, engine.bot().await, None, 50).await.unwrap().0;
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
    let rows = svc::page(&engine.db.conn, engine.bot().await, None, 50).await.unwrap().0;
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
    let rows = svc::page(&engine.db.conn, engine.bot().await, None, 50).await.unwrap().0;
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
        svc::insert_row(&engine.db.conn, engine.bot().await, r).await.unwrap()
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
    let rows = svc::page(&engine.db.conn, engine.bot().await, None, 50).await.unwrap().0;
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
    let batch = svc::create_batch(&engine.db.conn, engine.bot().await, seg, BatchKind::Delivery, None)
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
    let rows = svc::page(&engine.db.conn, engine.bot().await, None, 100).await.unwrap().0;
    let card = rows
        .iter()
        .find(|r| r.kind == TimelineKind::Result)
        .expect("the result card");
    assert_eq!(card.reply_to, Some(reply_id));
    assert!(card.read_at.is_none(), "unread until handed over");
    let event = svc::pending_events(&engine.db.conn, engine.bot().await).await.unwrap();
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
    let replies: Vec<_> = svc::page(&engine.db.conn, engine.bot().await, None, 100)
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
    let events = svc::pending_events(&engine.db.conn, engine.bot().await).await.unwrap();
    assert_eq!(events.len(), 2);
    // The second was put back once before.
    let earlier = svc::create_batch(&engine.db.conn, engine.bot().await, seg, BatchKind::Delivery, None)
        .await
        .unwrap();
    svc::mark_events_delivered(&engine.db.conn, &[events[1].id], earlier.id)
        .await
        .unwrap();
    svc::requeue_batch_events(&engine.db.conn, earlier.id).await.unwrap();

    let batch = svc::create_batch(&engine.db.conn, engine.bot().await, seg, BatchKind::Delivery, None)
        .await
        .unwrap();
    let ids: Vec<i32> = events.iter().map(|e| e.id).collect();
    let taken = svc::mark_events_delivered(&engine.db.conn, &ids, batch.id)
        .await
        .unwrap();
    assert_eq!(taken.len(), 2);
    svc::set_result_rows_read(&engine.db.conn, engine.bot().await, &taken, Some(chrono::Utc::now()))
        .await
        .unwrap();
    let mut r = NewRow::new(TimelineKind::Reply, "");
    r.batch_id = Some(batch.id);
    r.data = Some(serde_json::json!({
        "state": "running",
        "last_text": { "n": 2, "text": "Half an answ" },
        "step_count": 2,
    }));
    let reply = svc::insert_row(&engine.db.conn, engine.bot().await, r).await.unwrap();

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
    let batch = svc::create_batch(&engine.db.conn, engine.bot().await, seg, BatchKind::Delivery, None)
        .await
        .unwrap();
    let reply_id = engine
        .begin_delivery_for_test("pa-12", seg, batch.id, "tok-12", 0)
        .await;
    // Its conversation is gone: the follow-up cannot be sent.
    assert!(engine.followup(id, "dig deeper".into(), None).await.is_err());
    let rows = svc::page(&engine.db.conn, engine.bot().await, None, 100).await.unwrap().0;
    let card = rows
        .iter()
        .find(|r| r.kind == TimelineKind::Dispatch && data_of(r)["followup"] == true)
        .expect("the follow-up card");
    assert_eq!(card.batch_id, Some(batch.id));
    assert_eq!(data_of(card)["failed"], true);
    assert_eq!(dispatch_state(&engine, id).await.source_batch_id, Some(batch.id));
    let d = dispatch_state(&engine, id).await;
    engine.record_progress(&d, None, Some("x".into()), "followup").await;
    let rows = svc::page(&engine.db.conn, engine.bot().await, None, 100).await.unwrap().0;
    let result = rows.iter().find(|r| r.kind == TimelineKind::Result).unwrap();
    assert_eq!(result.reply_to, Some(reply_id));
}

/// A page never starts inside a turn: it is pulled back to the turn's first
/// row (its reply, or a phase-one turn's first card).
#[tokio::test]
async fn a_page_never_cuts_a_turn() {
    let (engine, _tmp) = configured().await;
    let seg = open_segment(&engine).await;
    let batch = svc::create_batch(&engine.db.conn, engine.bot().await, seg, BatchKind::Delivery, None)
        .await
        .unwrap();
    let bot = engine.bot().await;
    let insert = |kind: TimelineKind, batch: Option<i32>, body: &'static str| {
        let conn = engine.db.conn.clone();
        async move {
            let mut r = NewRow::new(kind, body);
            r.batch_id = batch;
            svc::insert_row(&conn, bot, r).await.unwrap().id
        }
    };
    insert(TimelineKind::Owner, None, "older").await;
    let reply = insert(TimelineKind::Reply, Some(batch.id), "answer").await;
    insert(TimelineKind::Dispatch, Some(batch.id), "task a").await;
    insert(TimelineKind::Dispatch, Some(batch.id), "task b").await;
    insert(TimelineKind::Owner, None, "next").await;
    let (rows, has_older) = svc::page(&engine.db.conn, engine.bot().await, None, 2).await.unwrap();
    assert_eq!(rows.first().map(|r| r.id), Some(reply), "pulled back to the reply");
    assert_eq!(rows.len(), 4);
    assert!(has_older);
    let (older, has_older) = svc::page(&engine.db.conn, engine.bot().await, Some(reply), 10).await.unwrap();
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
    let (rows, mut next) = svc::changed_since_limited(&engine.db.conn, engine.bot().await, Some(since), None, 0, 2)
        .await
        .unwrap();
    seen.extend(rows.into_iter().map(|r| r.id));
    while let Some(cursor) = next {
        let (rows, more) = svc::changed_since_limited(&engine.db.conn, engine.bot().await, None, Some(cursor), 0, 2)
            .await
            .unwrap();
        seen.extend(rows.into_iter().map(|r| r.id));
        next = more;
    }
    assert_eq!(seen, ids);
    let (from_third, _) = svc::changed_since(&engine.db.conn, engine.bot().await, Some(since), None, ids[2])
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
        svc::insert_row(&engine.db.conn, engine.bot().await, r).await.unwrap();
    }
    svc::insert_row(&engine.db.conn, engine.bot().await, NewRow::new(TimelineKind::Reply, "phase one"))
        .await
        .unwrap();
    let out = super::tools::timeline_read_for_test(&engine).await;
    assert_eq!(out.matches("you:").count(), 1, "{out}");
    let stats = crate::commands::personal_agent::personal_agent_stats_core(&engine.db, None, Some(1))
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
    let bot = engine.bot().await;
    let reply = |state: &str| {
        let mut r = NewRow::new(TimelineKind::Reply, "words");
        r.data = Some(serde_json::json!({ "state": state }));
        r
    };
    let owner = engine
        .send_owner_message("hi".into(), Vec::new(), None)
        .await
        .unwrap();
    let done = svc::insert_row(conn, bot, reply("done")).await.unwrap();
    let card = svc::insert_row(conn, bot, NewRow::new(TimelineKind::Result, "news"))
        .await
        .unwrap();
    let running = svc::insert_row(conn, bot, reply("running")).await.unwrap();
    svc::insert_row(conn, bot, reply("discarded")).await.unwrap();
    let after = svc::insert_row(conn, bot, reply("canceled")).await.unwrap();
    assert_eq!(svc::count_unseen(conn, bot).await.unwrap(), 3);
    assert_eq!(engine.snapshot().await.status.unseen, 3);

    let marked = svc::mark_seen(conn, bot, running.id).await.unwrap();
    assert_eq!(
        marked.iter().map(|m| m.id).collect::<Vec<_>>(),
        vec![done.id, card.id],
        "up to the row named, and not the running reply"
    );
    assert!(marked.iter().all(|m| m.seen_at.is_some()));
    assert_eq!(svc::count_unseen(conn, bot).await.unwrap(), 1, "the later reply");
    assert!(svc::mark_seen(conn, bot, running.id).await.unwrap().is_empty());
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
    assert_eq!(svc::count_unseen(conn, bot).await.unwrap(), 2, "settled: new");

    // A read-only page marks straight in the database.
    crate::commands::personal_agent::personal_agent_mark_seen_core(&engine.db, None, after.id)
        .await
        .unwrap();
    assert_eq!(svc::count_unseen(conn, bot).await.unwrap(), 0);
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

// ── proactive 1.1: every turn as its settings say; the ledger; the cards ──

use crate::acp::prompt_receipt::{PromptReceipt, ReceiptVia};
use crate::db::entities::personal_agent_action::{self as action_entity, ActionState};
use crate::db::entities::personal_agent_batch::BatchTrigger;
use crate::db::entities::personal_agent_notice::{NoticeKind, NoticeState};
use serde_json::json;

/// A delivery of the owner's on record on `conn`.
async fn owner_turn(engine: &PersonalAgentEngine, conn: &str) -> (i32, i32) {
    let seg = open_segment(engine).await;
    let batch = svc::create_batch(&engine.db.conn, engine.bot().await, seg, BatchKind::Delivery, None)
        .await
        .unwrap();
    engine
        .begin_turn_for_test(conn, seg, batch.id, BatchKind::Delivery, false, false)
        .await;
    (seg, batch.id)
}

/// A delivery with no message of the owner's (events only) on `conn`.
async fn event_turn(engine: &PersonalAgentEngine, conn: &str) -> (i32, i32) {
    let seg = open_segment(engine).await;
    let batch = svc::create_batch_with(
        &engine.db.conn,
        engine.bot().await,
        seg,
        BatchKind::Delivery,
        None,
        Some(BatchTrigger::Event),
    )
    .await
    .unwrap();
    engine
        .begin_turn_for_test(conn, seg, batch.id, BatchKind::Delivery, false, false)
        .await;
    (seg, batch.id)
}

async fn call(engine: &Arc<PersonalAgentEngine>, tool: &str, args: serde_json::Value) -> super::tools::ToolOutcome {
    super::tools::call_for_test(engine, tool, args).await
}

async fn notice_rows(engine: &PersonalAgentEngine) -> Vec<crate::db::entities::personal_agent_timeline::Model> {
    svc::page(&engine.db.conn, engine.bot().await, None, 200)
        .await
        .unwrap()
        .0
        .into_iter()
        .filter(|r| r.kind == TimelineKind::Notice)
        .collect()
}

fn notice_id_of(row: &crate::db::entities::personal_agent_timeline::Model) -> i32 {
    row.ref_id.as_deref().unwrap().parse().unwrap()
}

async fn all_dispatches(engine: &PersonalAgentEngine) -> Vec<crate::db::entities::personal_agent_dispatch::Model> {
    svc::list_dispatches(&engine.db.conn, engine.bot().await, &[], None, 100).await.unwrap()
}

/// A session dispatch in `state` whose project and conversation are real and
/// whose connection `conn` is live: what its follow-ups send can be read
/// back from the channel.
async fn live_session_dispatch(
    engine: &PersonalAgentEngine,
    tmp: &tempfile::TempDir,
    conn: &str,
    state: DispatchState,
) -> (i32, tokio::sync::mpsc::Receiver<ConnectionCommand>, State, i32) {
    let repo = tmp.path().join(format!("repo-{conn}"));
    std::fs::create_dir_all(&repo).unwrap();
    let folder = crate::db::test_helpers::seed_folder(&engine.db, &repo.to_string_lossy()).await;
    let conversation =
        crate::db::test_helpers::seed_conversation(&engine.db, folder, AgentType::ClaudeCode).await;
    let coder = role_assistant(engine, &format!("Coder on {conn}"), true).await;
    let d = svc::create_dispatch(
        &engine.db.conn,
        NewDispatch {
            bot_id: engine.bot().await,
            mode: DispatchMode::Session,
            executor_assistant_id: coder,
            executor_snapshot_json: "{}".into(),
            folder_id: Some(folder),
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
            conversation_id: Some(conversation),
            connection_id: Some(Some(conn.into())),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let (rx, st) = dispatch_connection(engine, conn, &repo, conversation).await;
    (d.id, rx, st, conversation)
}

/// A live connection of a dispatched conversation.
async fn dispatch_connection(
    engine: &PersonalAgentEngine,
    conn: &str,
    repo: &std::path::Path,
    conversation: i32,
) -> (tokio::sync::mpsc::Receiver<ConnectionCommand>, State) {
    let rx = engine
        .manager
        .insert_test_connection_live(conn, AgentType::ClaudeCode, Some(repo.to_path_buf()), EventEmitter::Noop)
        .await;
    let st = engine.manager.get_state(conn).await.unwrap();
    st.write().await.conversation_id = Some(conversation);
    (rx, st)
}

/// The follow-up the engine sent: its text, the internal suffix, its message
/// id and its receipt.
fn take_followup(
    rx: &mut tokio::sync::mpsc::Receiver<ConnectionCommand>,
) -> (String, String, Option<String>, PromptReceipt) {
    loop {
        match rx.try_recv() {
            Ok(ConnectionCommand::Prompt {
                blocks,
                user_message,
                internal_suffix,
                receipt,
                ..
            }) => {
                let join = |blocks: &[crate::acp::types::PromptInputBlock]| {
                    blocks
                        .iter()
                        .filter_map(|b| match b {
                            crate::acp::types::PromptInputBlock::Text { text } => Some(text.clone()),
                            _ => None,
                        })
                        .collect::<Vec<_>>()
                        .join("\n")
                };
                return (
                    join(&blocks),
                    join(&internal_suffix),
                    user_message.map(|(id, _)| id),
                    receipt.expect("a follow-up carries a receipt"),
                );
            }
            Ok(_) => continue,
            Err(_) => panic!("a follow-up was sent"),
        }
    }
}

fn no_prompt(rx: &mut tokio::sync::mpsc::Receiver<ConnectionCommand>) -> bool {
    loop {
        match rx.try_recv() {
            Ok(ConnectionCommand::Prompt { .. }) => return false,
            Ok(_) => continue,
            Err(_) => return true,
        }
    }
}

/// The operation that claimed the dispatch's current round.
async fn round_op(engine: &PersonalAgentEngine, dispatch_id: i32) -> action_entity::Model {
    let op_id = dispatch_state(engine, dispatch_id)
        .await
        .round_op_id
        .expect("the round is an operation's");
    svc::get_op(&engine.db.conn, &op_id).await.unwrap().unwrap()
}

async fn op(engine: &PersonalAgentEngine, op_id: &str) -> action_entity::Model {
    svc::get_op(&engine.db.conn, op_id).await.unwrap().unwrap()
}

/// What a restart sees: a fresh engine on the same database, booted.
async fn restarted(engine: &PersonalAgentEngine, tmp: &tempfile::TempDir) -> Arc<PersonalAgentEngine> {
    let again = PersonalAgentEngine::new_for_test(
        crate::db::AppDatabase {
            conn: engine.db.conn.clone(),
        },
        tmp.path().to_path_buf(),
    );
    again.boot_for_test().await;
    again
}

fn permission(request_id: &str) -> AcpEvent {
    AcpEvent::PermissionRequest {
        request_id: request_id.into(),
        tool_call: json!({ "kind": "execute", "title": "Bash", "rawInput": { "command": "rm -rf build" } }),
        options: vec![
            crate::acp::types::PermissionOptionInfo {
                option_id: "once".into(),
                name: "Allow".into(),
                kind: "allow_once".into(),
                meta: None,
            },
            crate::acp::types::PermissionOptionInfo {
                option_id: "no".into(),
                name: "Reject".into(),
                kind: "reject_once".into(),
                meta: None,
            },
        ],
        queued: 0,
    }
}

/// ① ② A turn no one typed changes nothing about the brain: its permission
/// request waits for the owner, no mode is switched, and a mode the owner
/// picks meanwhile goes through at once.
#[tokio::test]
async fn an_event_turn_answers_nothing_for_the_brain_and_switches_no_mode() {
    let (engine, _tmp) = configured().await;
    let seg = open_segment(&engine).await;
    let (mut rx, _state) = live_connection(&engine, seg, "pa-1").await;
    event_turn(&engine, "pa-1").await;
    let open = svc::open_segment(&engine.db.conn, engine.bot().await).await.unwrap().unwrap();
    engine.state.lock().await.connection_segment = Some(open.id);
    engine.feed_for_test("pa-1", 1, permission("p1")).await;
    assert!(
        rx.try_recv().is_err(),
        "codeg neither answers the request nor switches the mode"
    );
    let card = svc::row_by_ref(&engine.db.conn, engine.bot().await, TimelineKind::Permission, "p1")
        .await
        .unwrap()
        .expect("the request waits on the page for the owner");
    assert_eq!(card.kind, TimelineKind::Permission);
    // The owner switches the brain's mode while the event turn runs: it
    // goes through now, by either channel.
    let old = brain(AgentType::ClaudeCode);
    let mut new = old.clone();
    new.agent_options.mode_id = Some("bypassPermissions".into());
    new.agent_options
        .config_values
        .insert("mode".into(), "acceptEdits".into());
    engine.apply_brain_change_for_test(&old, &new).await;
    let mut set = Vec::new();
    while let Ok(cmd) = rx.try_recv() {
        match cmd {
            ConnectionCommand::SetMode { mode_id, .. } => set.push(("mode_id".to_string(), mode_id)),
            ConnectionCommand::SetConfigOption { config_id, value_id, .. } => set.push((config_id, value_id)),
            _ => {}
        }
    }
    assert_eq!(
        set,
        vec![
            ("mode_id".to_string(), "bypassPermissions".to_string()),
            ("mode".to_string(), "acceptEdits".to_string()),
        ]
    );
}

/// ④ The brain's agent type decides nothing: an OpenCode brain is woken by
/// an event like any other.
#[tokio::test]
async fn any_brain_is_woken_by_an_event() {
    let (engine, _tmp) = engine().await;
    engine
        .save(PersonalAgentDraft {
            agent_config: Some(brain(AgentType::OpenCode)),
            locale: Some("en".into()),
            ..Default::default()
        })
        .await
        .expect("save");
    let config = serde_json::to_string(&brain(AgentType::OpenCode)).unwrap();
    let seg = svc::create_segment(&engine.db.conn, engine.bot().await, "open_code", config, SegmentReason::First)
        .await
        .unwrap()
        .id;
    let (mut rx, _state) = live_connection(&engine, seg, "pa-oc").await;
    svc::insert_event(&engine.db.conn, engine.bot().await, "system", "k-w1", None, "news".into(), None, true)
        .await
        .unwrap();
    engine.pump().await;
    let (prompt, _) = take_prompt(&mut rx);
    assert!(prompt.contains("news"), "{prompt}");
    let batch = svc::running_batches(&engine.db.conn, engine.bot().await).await.unwrap().remove(0);
    assert_eq!(batch.trigger, Some(BatchTrigger::Event), "recorded, nothing more");
}

/// ⑤ In a turn no one typed, the agent's tools do what they do in the
/// owner's: a dispatch is made, any dispatch is followed up, any matter
/// changes.
#[tokio::test]
async fn an_event_turn_dispatches_and_follows_up_directly() {
    let (engine, tmp) = configured().await;
    let coder = role_assistant(&engine, "Coder", true).await;
    let (other, mut rx, _st, _) = live_session_dispatch(&engine, &tmp, "x-5", DispatchState::Completed).await;
    let item = svc::create_item(
        &engine.db.conn,
        engine.bot().await,
        ItemKind::Reminder,
        None,
        ItemStatus::Open,
        None,
        "Remember the release".into(),
        None,
        None,
    )
    .await
    .unwrap();
    event_turn(&engine, "pa-5").await;
    let made = call(
        &engine,
        "dispatch",
        json!({ "mode": "chat", "assistant_id": coder, "title": "Research X", "prompt": "Find out X." }),
    )
    .await;
    assert!(made.ok, "{}", made.text);
    assert_eq!(made.data["earlier"], json!(false));
    assert!(made.data.get("proposed").is_none());
    assert!(notice_rows(&engine).await.is_empty(), "no proposal card");
    let sent = call(
        &engine,
        "dispatch_followup",
        json!({ "dispatch_id": other, "message": "and check the tests" }),
    )
    .await;
    assert!(sent.ok, "{}", sent.text);
    let (text, _, _, _) = take_followup(&mut rx);
    assert_eq!(text, "and check the tests");
    let changed = super::tools::item_update_for_test(
        &engine,
        json!({ "item_id": item.id, "status": "done" }),
    )
    .await;
    assert!(changed.ok, "{}", changed.text);
}

/// ⑥ A setting the first build stored is read past.
#[test]
fn old_settings_with_an_unattended_mode_still_read() {
    let raw = r#"{"dispatch_concurrency":2,"unattended_mode":"default"}"#;
    let s: PersonalAgentSettings = serde_json::from_str(raw).unwrap();
    assert_eq!(s.dispatch_concurrency, 2);
    assert!(!serde_json::to_string(&s).unwrap().contains("unattended"));
}

/// The ledger hands a re-delivered batch its dispatch back; a delivery of
/// its own makes one of its own.
#[tokio::test]
async fn the_ledger_hands_a_redelivered_batch_its_dispatch_back() {
    let (engine, _tmp) = configured().await;
    let coder = role_assistant(&engine, "Coder", true).await;
    let (_, first_batch) = owner_turn(&engine, "pa-l1").await;
    let args = json!({ "mode": "chat", "assistant_id": coder, "title": "Fix the bug", "prompt": "Do it." });
    let a = call(&engine, "dispatch", args.clone()).await;
    assert!(a.ok, "{}", a.text);
    assert_eq!(a.data["earlier"], json!(false));
    // The same call again in the same batch, worded afresh: nothing new.
    let b = call(
        &engine,
        "dispatch",
        json!({ "mode": "chat", "assistant_id": coder, "title": "fix  the BUG", "prompt": "Worded afresh." }),
    )
    .await;
    assert_eq!(b.data["earlier"], json!(true), "{}", b.text);
    assert_eq!(b.data["dispatch_id"], a.data["dispatch_id"]);
    // A delivery that re-delivers the first one: the same.
    let (_, redelivery) = owner_turn(&engine, "pa-l1").await;
    engine
        .set_ledger_scope_for_test(vec![redelivery, first_batch])
        .await;
    let c = call(&engine, "dispatch", args.clone()).await;
    assert_eq!(c.data["earlier"], json!(true), "{}", c.text);
    assert_eq!(all_dispatches(&engine).await.len(), 1);
    // A delivery of its own: a dispatch of its own.
    owner_turn(&engine, "pa-l1").await;
    let d = call(&engine, "dispatch", args).await;
    assert_eq!(d.data["earlier"], json!(false), "{}", d.text);
    assert_eq!(all_dispatches(&engine).await.len(), 2);
}

#[tokio::test]
async fn a_message_resent_twice_still_finds_what_its_first_turn_dispatched() {
    let (engine, _tmp) = configured().await;
    let coder = role_assistant(&engine, "Coder", true).await;
    let seg = open_segment(&engine).await;
    let args = json!({ "mode": "chat", "assistant_id": coder, "title": "Fix it", "prompt": "Do it." });
    // A: dispatches, then is interrupted.
    let (_, a) = owner_turn(&engine, "pa-r").await;
    let first = call(&engine, "dispatch", args.clone()).await;
    assert_eq!(first.data["earlier"], json!(false), "{}", first.text);
    // B re-delivers A and finds the dispatch, making none of its own.
    let b = svc::create_batch(
        &engine.db.conn,
        engine.bot().await,
        seg,
        BatchKind::Delivery,
        Some(json!({ "ledger_from": engine.ledger_ancestry_for_test(&[a]).await })),
    )
    .await
    .unwrap()
    .id;
    // C re-delivers B only — and still inherits A.
    let scope_c = engine.ledger_ancestry_for_test(&[b]).await;
    assert_eq!(scope_c, {
        let mut v = vec![a, b];
        v.sort_unstable();
        v
    });
    let c = svc::create_batch(&engine.db.conn, engine.bot().await, seg, BatchKind::Delivery, None)
        .await
        .unwrap()
        .id;
    engine
        .begin_turn_for_test("pa-r", seg, c, BatchKind::Delivery, false, false)
        .await;
    let mut scope = vec![c];
    scope.extend(scope_c);
    engine.set_ledger_scope_for_test(scope).await;
    let again = call(&engine, "dispatch", args).await;
    assert_eq!(again.data["earlier"], json!(true), "{}", again.text);
    assert_eq!(again.data["dispatch_id"], first.data["dispatch_id"]);
    assert_eq!(all_dispatches(&engine).await.len(), 1);
}

/// A delivery records what started it, and that is all it does.
#[tokio::test]
async fn a_delivery_records_its_trigger() {
    let (engine, _tmp) = configured().await;
    let seg = open_segment(&engine).await;
    let id = session_dispatch(&engine, DispatchState::Running, "conn-s1").await;
    engine.open_round("conn-s1", id).await;
    engine.feed_for_test("conn-s1", 1, turn_complete("end_turn")).await;
    let (mut rx, _state) = live_connection(&engine, seg, "pa-s").await;
    engine.pump().await;
    let (prompt, _token) = take_prompt(&mut rx);
    assert!(!prompt.contains("unattended"), "{prompt}");
    let batch = svc::running_batches(&engine.db.conn, engine.bot().await).await.unwrap().remove(0);
    assert_eq!(batch.trigger, Some(BatchTrigger::Event));
}

/// A follow-up into a conversation goes out in three marks: claimed with
/// its operation, marked attempted right before the request is written,
/// committed by the executor's own answer — straight through the receipt,
/// not the bus (⑰). It carries its id as the message id and in an
/// operation frame.
#[tokio::test]
async fn a_follow_up_goes_out_in_three_marks() {
    let (engine, tmp) = configured().await;
    let (id, mut rx, _st, _) = live_session_dispatch(&engine, &tmp, "x-1", DispatchState::Completed).await;
    owner_turn(&engine, "pa-1").await;
    let out = call(&engine, "dispatch_followup", json!({ "dispatch_id": id, "message": "and the tests" })).await;
    assert!(out.ok, "{}", out.text);
    let d = dispatch_state(&engine, id).await;
    assert_eq!(d.state, DispatchState::Running);
    let entry = round_op(&engine, id).await;
    let op_id = entry.op_id.clone().unwrap();
    assert_eq!(entry.state, ActionState::Prepared);
    assert!(entry.attempted_at.is_none());
    let (text, suffix, message_id, receipt) = take_followup(&mut rx);
    assert_eq!(text, "and the tests");
    assert_eq!(message_id.as_deref(), Some(op_id.as_str()));
    assert_eq!(receipt.op_id, op_id);
    assert_eq!(crate::acp::agent_mentions::operation_ids_in(&suffix), vec![op_id.clone()]);
    assert_eq!(
        crate::acp::agent_mentions::strip_internal_frames(&suffix).trim(),
        "",
        "the frame is stripped from every display"
    );
    receipt.attempted().await.expect("written");
    assert!(op(&engine, &op_id).await.attempted_at.is_some());
    receipt.received(ReceiptVia::PromptResponse).await;
    let done = op(&engine, &op_id).await;
    assert_eq!(done.state, ActionState::Committed);
    assert!(done.observed.unwrap().contains("prompt_response"));
}

/// ⑧ Written prepared, cut off before the claim: after a restart the
/// re-delivered call sends it, once.
#[tokio::test]
async fn a_follow_up_cut_off_before_its_claim_is_sent_once_after_a_restart() {
    let (engine, tmp) = configured().await;
    let (id, _rx, _st, conversation) =
        live_session_dispatch(&engine, &tmp, "x-8", DispatchState::Completed).await;
    let (_, batch) = owner_turn(&engine, "pa-8").await;
    // Only the intent made it to disk.
    let key = super::ledger::followup_key(id, None);
    let op_id = super::ledger::fresh_op_id();
    svc::begin_op(
        &engine.db.conn,
        svc::NewOp {
            bot_id: engine.bot().await,
            slot: svc::LedgerSlot::in_batch(batch, key, op_id.clone()),
            kind: "followup",
            payload: json!({ "dispatch_id": id, "message": "go on" }),
            target: None,
            notice_id: None,
        },
    )
    .await
    .unwrap();
    let again = restarted(&engine, &tmp).await;
    assert_eq!(op(&again, &op_id).await.state, ActionState::NotExecuted);
    assert_eq!(dispatch_state(&again, id).await.state, DispatchState::Completed);
    // The interrupted batch is delivered again: the call sends it now.
    let repo = tmp.path().join("repo-x-8");
    // The dispatch still names its connection, live again in the new process.
    let (mut rx, _st) = dispatch_connection(&again, "x-8", &repo, conversation).await;
    let (_, redelivery) = owner_turn(&again, "pa-8").await;
    again.set_ledger_scope_for_test(vec![redelivery, batch]).await;
    let out = call(&again, "dispatch_followup", json!({ "dispatch_id": id, "message": "go on" })).await;
    assert!(out.ok, "{}", out.text);
    let (text, _, _, _) = take_followup(&mut rx);
    assert_eq!(text, "go on");
    assert!(no_prompt(&mut rx), "sent once");
}

/// ⑨ ⑫(acceptance) Claimed (running) but never attempted when codeg died:
/// not sent — the round is put back as it was, the message stays in the
/// ledger, the dispatch does not read as running or interrupted.
#[tokio::test]
async fn a_follow_up_claimed_but_never_attempted_puts_its_round_back() {
    let (engine, tmp) = configured().await;
    let (id, mut rx, _st, _) = live_session_dispatch(&engine, &tmp, "x-9", DispatchState::Completed).await;
    owner_turn(&engine, "pa-9").await;
    let out = call(&engine, "dispatch_followup", json!({ "dispatch_id": id, "message": "deeper" })).await;
    assert!(out.ok, "{}", out.text);
    let op_id = round_op(&engine, id).await.op_id.unwrap();
    let _ = take_followup(&mut rx); // queued to the connection, never attempted
    let again = restarted(&engine, &tmp).await;
    let entry = op(&again, &op_id).await;
    assert_eq!(entry.state, ActionState::NotExecuted);
    assert!(entry.payload.unwrap().contains("deeper"), "the message is kept");
    let d = dispatch_state(&again, id).await;
    assert_eq!(d.state, DispatchState::Completed, "back as it was");
    assert_eq!(d.round_op_id, None);
    assert_eq!(d.connection_id, None);
    // Not reported as an interrupted round either.
    let events = svc::pending_events(&again.db.conn, again.bot().await).await.unwrap();
    assert!(
        !events.iter().any(|e| e.summary.contains("interrupted")),
        "{:?}",
        events.iter().map(|e| &e.summary).collect::<Vec<_>>()
    );
}

/// ⑩ ⑪ ⑯ Attempted, never confirmed, no record of the agent's to ask:
/// unknown — never sent again on its own, never taken as sent; a card for
/// the owner, a word for the agent. A later claim of the round changes
/// nothing about it.
#[tokio::test]
async fn an_attempted_unconfirmed_follow_up_is_unknown_after_a_restart() {
    let (engine, tmp) = configured().await;
    let (id, mut rx, _st, _) = live_session_dispatch(&engine, &tmp, "x-10", DispatchState::Completed).await;
    let (_, batch) = owner_turn(&engine, "pa-10").await;
    let out = call(&engine, "dispatch_followup", json!({ "dispatch_id": id, "message": "deeper" })).await;
    assert!(out.ok, "{}", out.text);
    let op_id = round_op(&engine, id).await.op_id.unwrap();
    let (_, _, _, receipt) = take_followup(&mut rx);
    receipt.attempted().await.unwrap();
    // ⑯: a later round took the row meanwhile.
    svc::update_dispatch(
        &engine.db.conn,
        id,
        None,
        DispatchWrite {
            round_op_id: Some(Some("pa-later".into())),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let again = restarted(&engine, &tmp).await;
    let entry = op(&again, &op_id).await;
    assert_eq!(entry.state, ActionState::Unknown);
    let d = dispatch_state(&again, id).await;
    assert_eq!(d.round_op_id.as_deref(), Some("pa-later"), "the later round is left alone");
    let cards = notice_rows(&again).await;
    assert_eq!(cards.len(), 1);
    let card = svc::get_notice(&again.db.conn, notice_id_of(&cards[0])).await.unwrap().unwrap();
    assert_eq!(card.kind, NoticeKind::Uncertain);
    assert_eq!(card.state, NoticeState::Open);
    assert_eq!(entry.notice_id, Some(card.id));
    assert_eq!(data_of(&cards[0])["display"]["message"], "deeper");
    let told = svc::pending_events(&again.db.conn, again.bot().await).await.unwrap();
    assert!(told.iter().any(|e| e.kind == "ledger" && !e.wake && e.summary.contains("cannot tell")));
    // The re-delivered call does not send it again.
    let (_, redelivery) = owner_turn(&again, "pa-10").await;
    again.set_ledger_scope_for_test(vec![redelivery, batch]).await;
    let out = call(&again, "dispatch_followup", json!({ "dispatch_id": id, "message": "deeper" })).await;
    assert!(out.ok, "{}", out.text);
    assert!(out.text.contains("cannot tell"), "{}", out.text);
    // [Do it again] sends it — under the card's own operation.
    let repo = tmp.path().join("repo-x-10");
    let conversation = d.conversation_id.unwrap();
    svc::update_dispatch(
        &again.db.conn,
        id,
        None,
        DispatchWrite {
            state: Some(DispatchState::Interrupted),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let (mut rx2, _st2) = dispatch_connection(&again, "x-10b", &repo, conversation).await;
    let row = again.act_on_notice(card.id, "accept").await.unwrap();
    assert_eq!(row.data.as_ref().unwrap()["state"], "acting");
    let (text, _, _, receipt) = take_followup(&mut rx2);
    assert_eq!(text, "deeper");
    assert_eq!(receipt.op_id, super::ledger::card_op_id(card.id, 1));
    receipt.attempted().await.unwrap();
    receipt.received(ReceiptVia::PromptResponse).await;
    let card = svc::get_notice(&again.db.conn, card.id).await.unwrap().unwrap();
    assert_eq!(card.state, NoticeState::Acted);
}

/// ⑪ ⑫ The agent's OWN record names the operation: it arrived, though the
/// parsers strip the frame from every display. ⑬ codeg's own copy of a
/// prompt proves nothing.
#[tokio::test]
async fn the_agents_own_record_proves_a_send_and_codegs_own_copy_does_not() {
    let (engine, tmp) = configured().await;
    let (id, mut rx, _st, conversation) =
        live_session_dispatch(&engine, &tmp, "x-11", DispatchState::Completed).await;
    owner_turn(&engine, "pa-11").await;
    let out = call(&engine, "dispatch_followup", json!({ "dispatch_id": id, "message": "deeper" })).await;
    assert!(out.ok, "{}", out.text);
    let op_id = round_op(&engine, id).await.op_id.unwrap();
    let (_, suffix, _, receipt) = take_followup(&mut rx);
    receipt.attempted().await.unwrap();
    // Claude Code wrote the prompt, frame and all, into its own session
    // file (under a config dir of the test's own, never the real home).
    let claude = tmp.path().join("claude-home");
    let project = claude.join("projects").join("-repo");
    std::fs::create_dir_all(&project).unwrap();
    let session = "0b5e2f4a-1111-4222-8333-444455556666";
    let line = json!({
        "type": "user",
        "message": { "role": "user", "content": [{ "type": "text", "text": format!("deeper{suffix}") }] }
    });
    std::fs::write(project.join(format!("{session}.jsonl")), format!("{line}\n")).unwrap();
    crate::db::service::conversation_service::bind_external_id(&engine.db.conn, conversation, session, &[])
        .await
        .unwrap();
    crate::db::service::agent_setting_service::ensure_defaults(
        &engine.db.conn,
        &[crate::db::service::agent_setting_service::AgentDefaultInput {
            agent_type: AgentType::ClaudeCode,
            registry_id: "claude-code".into(),
            default_sort_order: 0,
        }],
    )
    .await
    .unwrap();
    crate::db::service::agent_setting_service::update(
        &engine.db.conn,
        AgentType::ClaudeCode,
        crate::db::service::agent_setting_service::AgentSettingsUpdate {
            enabled: true,
            env_json: Some(json!({ "CLAUDE_CONFIG_DIR": claude }).to_string()),
            model_provider_id: None,
        },
    )
    .await
    .unwrap();
    let again = restarted(&engine, &tmp).await;
    let entry = op(&again, &op_id).await;
    assert_eq!(entry.state, ActionState::Committed, "{:?}", entry.detail);
    assert!(entry.observed.unwrap().contains("own_record"));
    assert!(notice_rows(&again).await.is_empty(), "nothing to ask the owner");
    // codeg's own transcript of a custom agent answers nothing.
    let env = crate::db::service::agent_setting_service::load_agent_env(&again.db.conn, AgentType::ZCode).await;
    assert_eq!(
        crate::parsers::build_agent_parser(AgentType::ZCode, &env).own_record_contains(session, &op_id),
        None
    );
}

/// ⑭ The owner writes in the conversation while the agent's follow-up is on
/// its way: taking over wins. Not yet attempted: not sent at all — the
/// connection is refused it. Already going out: unknown, and the owner
/// hears; the executor's answer later settles it as sent.
#[tokio::test]
async fn the_owner_taking_over_wins_over_a_follow_up_on_its_way() {
    let (engine, tmp) = configured().await;
    let (id, mut rx, _st, conversation) =
        live_session_dispatch(&engine, &tmp, "x-14", DispatchState::Completed).await;
    owner_turn(&engine, "pa-14").await;
    call(&engine, "dispatch_followup", json!({ "dispatch_id": id, "message": "one" })).await;
    let op_id = round_op(&engine, id).await.op_id.unwrap();
    let (_, _, _, receipt) = take_followup(&mut rx);
    engine.handover("x-14", Some(conversation)).await;
    assert_eq!(op(&engine, &op_id).await.state, ActionState::NotExecuted);
    assert!(receipt.attempted().await.is_err(), "the request is never written");
    assert_eq!(dispatch_state(&engine, id).await.state, DispatchState::HandedOver);

    // Already going out.
    let (id2, mut rx2, _st2, conversation2) =
        live_session_dispatch(&engine, &tmp, "x-14b", DispatchState::Completed).await;
    call(&engine, "dispatch_followup", json!({ "dispatch_id": id2, "message": "two" })).await;
    let op2 = round_op(&engine, id2).await.op_id.unwrap();
    let (_, _, _, receipt2) = take_followup(&mut rx2);
    receipt2.attempted().await.unwrap();
    engine.handover("x-14b", Some(conversation2)).await;
    assert_eq!(op(&engine, &op2).await.state, ActionState::Unknown);
    let card = notice_rows(&engine).await.pop().expect("the owner hears");
    // The executor answers after all: sent, and the card asks nothing more.
    receipt2.received(ReceiptVia::PromptResponse).await;
    assert_eq!(op(&engine, &op2).await.state, ActionState::Committed);
    let notice = svc::get_notice(&engine.db.conn, notice_id_of(&card)).await.unwrap().unwrap();
    assert_eq!(notice.state, NoticeState::Expired);
}

/// ⑮ Output of the previous turn landing while this send waits proves
/// nothing: the connection goes away, the send is not taken as sent.
#[tokio::test]
async fn late_output_never_confirms_a_send() {
    let (engine, tmp) = configured().await;
    let (id, mut rx, st, _) = live_session_dispatch(&engine, &tmp, "x-15", DispatchState::Completed).await;
    owner_turn(&engine, "pa-15").await;
    call(&engine, "dispatch_followup", json!({ "dispatch_id": id, "message": "next" })).await;
    let op_id = round_op(&engine, id).await.op_id.unwrap();
    let (_, _, _, receipt) = take_followup(&mut rx);
    receipt.attempted().await.unwrap();
    // A straggler of the turn before, text and tool call alike.
    emit(&engine, &st, "x-15", text("late words"), true).await;
    emit(&engine, &st, "x-15", tool("late-call", "Read"), true).await;
    assert_eq!(op(&engine, &op_id).await.state, ActionState::Prepared);
    // Then the connection is gone.
    let _ = engine.manager.disconnect("x-15").await;
    engine.reconcile_dispatches().await;
    let entry = op(&engine, &op_id).await;
    assert_eq!(entry.state, ActionState::Unknown);
    assert_eq!(dispatch_state(&engine, id).await.state, DispatchState::Failed);
}

/// ⑳ A follow-up refused before anything went out is not executed: the same
/// call in the same batch sends it once things allow — one entry, rearmed.
#[tokio::test]
async fn a_follow_up_that_provably_did_nothing_can_be_made_again() {
    let (engine, tmp) = configured().await;
    let (id, mut rx, st, _) = live_session_dispatch(&engine, &tmp, "x-20", DispatchState::Completed).await;
    let (_, batch) = owner_turn(&engine, "pa-20").await;
    st.write().await.turn_in_flight = true;
    let busy = call(&engine, "dispatch_followup", json!({ "dispatch_id": id, "message": "again" })).await;
    assert!(!busy.ok, "{}", busy.text);
    let key = super::ledger::followup_key(id, None);
    let entries = svc::ledger_entries(&engine.db.conn, &[batch], &key).await.unwrap();
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].state, ActionState::NotExecuted);
    st.write().await.turn_in_flight = false;
    let sent = call(&engine, "dispatch_followup", json!({ "dispatch_id": id, "message": "again" })).await;
    assert!(sent.ok, "{}", sent.text);
    let (text, _, _, receipt) = take_followup(&mut rx);
    assert_eq!(text, "again");
    // The same entry runs again, under a new operation id: a send of the old
    // one still on its way would find nothing to mark.
    let now = svc::ledger_entries(&engine.db.conn, &[batch], &key).await.unwrap();
    assert_eq!(now.len(), 1);
    assert_eq!(now[0].id, entries[0].id);
    assert_eq!(now[0].op_id.as_deref(), Some(receipt.op_id.as_str()));
    let old = entries[0].op_id.clone().unwrap();
    assert_ne!(receipt.op_id, old);
    assert!(svc::get_op(&engine.db.conn, &old).await.unwrap().is_none());
    assert!(!svc::op_attempted(&engine.db.conn, &old).await.unwrap());
}

/// A follow-up waiting for a slot keeps its message in the ledger: claimed
/// off the queue and cut off before it went out, it goes back in the queue,
/// still its operation's.
#[tokio::test]
async fn a_queued_follow_up_is_never_lost_to_its_claim() {
    let (engine, tmp) = configured().await;
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
    let (id, mut rx, _st, _) = live_session_dispatch(&engine, &tmp, "x-q", DispatchState::Completed).await;
    let busy = session_dispatch(&engine, DispatchState::Running, "x-q-busy").await;
    owner_turn(&engine, "pa-q").await;
    let out = call(&engine, "dispatch_followup", json!({ "dispatch_id": id, "message": "queued words" })).await;
    assert!(out.text.contains("slots are busy"), "{}", out.text);
    let entry = round_op(&engine, id).await;
    let op_id = entry.op_id.clone().unwrap();
    assert_eq!(dispatch_state(&engine, id).await.state, DispatchState::Queued);
    // The slot frees: claimed off the queue and handed to the connection —
    // then codeg dies before it was attempted.
    svc::update_dispatch(
        &engine.db.conn,
        busy,
        None,
        DispatchWrite {
            state: Some(DispatchState::Completed),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    engine.start_queued().await;
    let (text, _, _, receipt) = take_followup(&mut rx);
    assert_eq!(text, "queued words");
    assert_eq!(receipt.op_id, op_id);
    let d = dispatch_state(&engine, id).await;
    assert_eq!(d.state, DispatchState::Running);
    assert_eq!(d.followup, None);
    let again = restarted(&engine, &tmp).await;
    let d = dispatch_state(&again, id).await;
    assert_eq!(d.state, DispatchState::Queued, "back in the queue");
    assert_eq!(d.followup.as_deref(), Some("queued words"));
    assert_eq!(d.round_op_id.as_deref(), Some(op_id.as_str()));
    assert_eq!(op(&again, &op_id).await.state, ActionState::Prepared);
}

/// ⑱ ⑲ A task follow-up is proven by the board's own claim record alone:
/// found, it took effect; not found, it did nothing — even when the task
/// moved, because someone else moved it.
#[tokio::test]
async fn a_task_follow_up_is_settled_by_the_claim_record() {
    use crate::db::entities::work_task::{self as work_task, WorkTaskStatus};
    use crate::db::service::work_task_service;
    use sea_orm::{ColumnTrait, EntityTrait, QueryFilter};
    let (engine, tmp) = configured().await;
    let coder = role_assistant(&engine, "Coder", true).await;
    let folder = crate::db::test_helpers::seed_folder(&engine.db, &tmp.path().join("board").to_string_lossy()).await;
    let task = work_task_service::create(
        &engine.db.conn,
        crate::models::WorkTaskDraft {
            folder_id: folder,
            title: "Fix".into(),
            config: json!({ "display_text": "fix", "prompt_blocks": [{ "type": "text", "text": "fix" }] }),
        },
    )
    .await
    .unwrap();
    let to_review = || async {
        work_task::Entity::update_many()
            .col_expr(work_task::Column::Status, sea_orm::sea_query::Expr::value("review"))
            .filter(work_task::Column::Id.eq(task.id))
            .exec(&engine.db.conn)
            .await
            .unwrap();
    };
    to_review().await;
    let d = svc::create_dispatch(
        &engine.db.conn,
        NewDispatch {
            bot_id: engine.bot().await,
            mode: DispatchMode::Task,
            executor_assistant_id: coder,
            executor_snapshot_json: "{}".into(),
            folder_id: Some(folder),
            deliverable: Some("change".into()),
            title: "Fix".into(),
            prompt: "fix".into(),
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
            work_task_id: Some(task.id),
            state: Some(DispatchState::Review),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let bot = engine.bot().await;
    let begin = |op_id: String| {
        let conn = engine.db.conn.clone();
        async move {
            svc::begin_op(
                &conn,
                svc::NewOp {
                    bot_id: bot,
                    slot: svc::LedgerSlot::outside(op_id),
                    kind: "followup",
                    payload: json!({ "dispatch_id": d.id, "message": "revise", "intent": "revise" }),
                    target: None,
                    notice_id: None,
                },
            )
            .await
            .unwrap();
        }
    };
    // ⑱ The agent's claim committed with its op in the user_action.
    let mine = super::ledger::fresh_op_id();
    begin(mine.clone()).await;
    work_task_service::claim_for_run_with_action(
        &engine.db.conn,
        task.id,
        WorkTaskStatus::Review,
        "user",
        Some(json!({ "action": "return", "intent": "revise", "feedback": "revise", "op_id": mine })),
        false,
    )
    .await
    .unwrap()
    .expect("claimed");
    let entry = op(&engine, &mine).await;
    assert_eq!(engine.resolve_op(&entry).await, super::ledger::OpOutcome::Committed);
    assert!(op(&engine, &mine).await.observed.unwrap().contains("user_action"));
    // ⑲ The owner returned it first, by hand: the agent's has no record.
    to_review().await;
    let theirs = super::ledger::fresh_op_id();
    begin(theirs.clone()).await;
    work_task_service::claim_for_run_with_action(
        &engine.db.conn,
        task.id,
        WorkTaskStatus::Review,
        "user",
        Some(json!({ "action": "return", "intent": "revise", "feedback": "mine, by hand" })),
        false,
    )
    .await
    .unwrap()
    .expect("the owner's claim");
    let entry = op(&engine, &theirs).await;
    assert!(matches!(
        engine.resolve_op(&entry).await,
        super::ledger::OpOutcome::NotExecuted(_)
    ));
    // ...and the claim itself loses for whoever comes second.
    let lost = work_task_service::claim_for_run_with_action(
        &engine.db.conn,
        task.id,
        WorkTaskStatus::Review,
        "user",
        None,
        false,
    )
    .await
    .unwrap();
    assert!(lost.is_none());
}

/// A proposal card runs exactly what it shows, in one transaction with the
/// card; [Not now] runs nothing; the first answer wins (㉒), and the agent
/// hears how it went.
#[tokio::test]
async fn a_proposal_card_runs_exactly_what_it_shows() {
    let (engine, _tmp) = configured().await;
    let coder = role_assistant(&engine, "Coder", true).await;
    let valid = engine
        .validate_dispatch(&DispatchRequest {
            mode: DispatchMode::Chat,
            assistant_id: coder,
            title: "Research X".into(),
            prompt: "Find out X.".into(),
            project_id: None,
            report: false,
            on_done: None,
        })
        .await
        .unwrap();
    let card = engine.propose_dispatch(&valid, None, None).await.unwrap();
    let rows = notice_rows(&engine).await;
    assert_eq!(data_of(&rows[0])["display"]["prompt"], "Find out X.");
    // ㉒ Two windows click at once: one runs it.
    let (a, b) = tokio::join!(engine.act_on_notice(card, "accept"), engine.act_on_notice(card, "accept"));
    assert!(a.is_ok() != b.is_ok(), "{a:?} {b:?}");
    let won = a.or(b).unwrap();
    assert_eq!(won.data.as_ref().unwrap()["state"], "acted");
    let made = all_dispatches(&engine).await;
    assert_eq!(made.len(), 1);
    assert_eq!(made[0].prompt, "Find out X.");
    assert_eq!(won.data.as_ref().unwrap()["result"]["dispatch_id"], json!(made[0].id));
    let entry = op(&engine, &super::ledger::card_op_id(card, 1)).await;
    assert_eq!(entry.state, ActionState::Committed);
    assert_eq!(entry.notice_id, Some(card));
    assert_eq!(
        svc::get_notice(&engine.db.conn, card).await.unwrap().unwrap().state,
        NoticeState::Acted
    );
    assert!(engine.act_on_notice(card, "dismiss").await.is_err());
    let told = svc::pending_events(&engine.db.conn, engine.bot().await).await.unwrap();
    assert!(told.iter().any(|e| e.kind == "proposal" && !e.wake && e.summary.contains("approved")));

    let other = engine.propose_dispatch(&valid, None, None).await.unwrap();
    let row = engine.act_on_notice(other, "dismiss").await.unwrap();
    assert_eq!(row.data.as_ref().unwrap()["state"], "dismissed");
    assert_eq!(all_dispatches(&engine).await.len(), 1);
    assert!(engine.act_on_notice(other, "accept").await.is_err());
}

/// ㉑ A card clicked and cut off before what it runs is done never reads
/// as done: a restart puts it back or settles it by its entry.
#[tokio::test]
async fn a_card_cut_off_mid_run_is_settled_by_its_entry_after_a_restart() {
    let (engine, tmp) = configured().await;
    // Taken (acting), nothing ran yet.
    let coder = role_assistant(&engine, "Coder", true).await;
    let valid = engine
        .validate_dispatch(&DispatchRequest {
            mode: DispatchMode::Chat,
            assistant_id: coder,
            title: "T".into(),
            prompt: "P".into(),
            project_id: None,
            report: false,
            on_done: None,
        })
        .await
        .unwrap();
    let taken = engine.propose_dispatch(&valid, None, None).await.unwrap();
    assert!(svc::move_notice(&engine.db.conn, taken, &[NoticeState::Open], NoticeState::Acting)
        .await
        .unwrap());
    // A follow-up card whose send was claimed, never attempted.
    let (id, mut rx, _st, _) = live_session_dispatch(&engine, &tmp, "x-21", DispatchState::Completed).await;
    let follow = engine
        .propose_followup(id, "look again".into(), None, None)
        .await
        .unwrap();
    let row = engine.act_on_notice(follow, "accept").await.unwrap();
    assert_eq!(row.data.as_ref().unwrap()["state"], "acting");
    let _ = take_followup(&mut rx);
    let again = restarted(&engine, &tmp).await;
    let taken = svc::get_notice(&again.db.conn, taken).await.unwrap().unwrap();
    assert_eq!(taken.state, NoticeState::Open, "nothing ran: it can be clicked again");
    assert!(all_dispatches(&again).await.iter().all(|d| d.id == id));
    let follow = svc::get_notice(&again.db.conn, follow).await.unwrap().unwrap();
    assert_eq!(follow.state, NoticeState::Open);
    let row = svc::get_row(&again.db.conn, follow.timeline_id.unwrap()).await.unwrap().unwrap();
    assert_eq!(data_of(&row)["state"], "open");
    assert_eq!(dispatch_state(&again, id).await.state, DispatchState::Completed);
}

/// Review: the owner takes over with a moment-old view of the dispatch. The
/// send withdrawn is the one holding the round once it is handed over — not
/// whatever the stale view named.
#[tokio::test]
async fn taking_over_withdraws_the_send_that_holds_the_round_now() {
    let (engine, tmp) = configured().await;
    let (id, mut rx, _st, _) = live_session_dispatch(&engine, &tmp, "x-h", DispatchState::Completed).await;
    // Read before the follow-up claims the round.
    let stale = dispatch_state(&engine, id).await;
    owner_turn(&engine, "pa-h").await;
    call(&engine, "dispatch_followup", json!({ "dispatch_id": id, "message": "B" })).await;
    let b = round_op(&engine, id).await.op_id.unwrap();
    let (_, _, _, receipt) = take_followup(&mut rx);
    engine.hand_over(&stale).await;
    assert_eq!(dispatch_state(&engine, id).await.state, DispatchState::HandedOver);
    assert_eq!(op(&engine, &b).await.state, ActionState::NotExecuted);
    assert!(receipt.attempted().await.is_err(), "B is never written");
}

/// Review: the same follow-up made again in the same batch, worded anew,
/// runs under its entry with the NEW words — so what a restart puts back in
/// the queue is the call that ran, not the one that did nothing.
#[tokio::test]
async fn a_rearmed_follow_up_keeps_the_call_it_runs_now() {
    let (engine, tmp) = configured().await;
    engine
        .save(PersonalAgentDraft {
            settings: Some(PersonalAgentSettings {
                dispatch_concurrency: 1,
                ..Default::default()
            }),
            ..Default::default()
        })
        .await
        .unwrap();
    let (id, mut rx, st, _) = live_session_dispatch(&engine, &tmp, "x-r", DispatchState::Completed).await;
    owner_turn(&engine, "pa-r2").await;
    // The first try finds the conversation busy: it did nothing.
    st.write().await.turn_in_flight = true;
    let first = call(&engine, "dispatch_followup", json!({ "dispatch_id": id, "message": "first words" })).await;
    assert!(!first.ok, "{}", first.text);
    st.write().await.turn_in_flight = false;
    // The slots fill up; the second try, worded anew, waits for one.
    let busy = session_dispatch(&engine, DispatchState::Running, "x-r-busy").await;
    let second = call(&engine, "dispatch_followup", json!({ "dispatch_id": id, "message": "second words" })).await;
    assert!(second.text.contains("slots are busy"), "{}", second.text);
    let entry = round_op(&engine, id).await;
    assert!(entry.payload.as_deref().unwrap().contains("second words"));
    // Claimed off the queue, then codeg dies before it went out.
    svc::update_dispatch(
        &engine.db.conn,
        busy,
        None,
        DispatchWrite {
            state: Some(DispatchState::Completed),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    engine.start_queued().await;
    let (text, _, _, _) = take_followup(&mut rx);
    assert_eq!(text, "second words");
    let again = restarted(&engine, &tmp).await;
    let d = dispatch_state(&again, id).await;
    assert_eq!(d.state, DispatchState::Queued);
    assert_eq!(d.followup.as_deref(), Some("second words"), "never the words that did nothing");
}

/// Review: a confirmation that lands while codeg settles a send as unknown
/// wins, whichever comes first — no card asks about a send that arrived.
#[tokio::test]
async fn a_late_confirmation_beats_an_unknown_verdict() {
    let (engine, tmp) = configured().await;
    let (id, mut rx, _st, _) = live_session_dispatch(&engine, &tmp, "x-l", DispatchState::Completed).await;
    owner_turn(&engine, "pa-l").await;
    call(&engine, "dispatch_followup", json!({ "dispatch_id": id, "message": "go" })).await;
    let op_id = round_op(&engine, id).await.op_id.unwrap();
    let (_, _, _, receipt) = take_followup(&mut rx);
    receipt.attempted().await.unwrap();
    receipt.received(ReceiptVia::PromptResponse).await;
    // The unknown verdict comes second: it finds the confirmation.
    assert_eq!(
        engine.settle_unknown_op(&op_id, "cut off").await,
        super::ledger::OpOutcome::Committed
    );
    // An unknown verdict taken a moment before the confirmation: the card it
    // raises sees the confirmation and closes at once, telling the agent
    // nothing.
    engine
        .after_op(&op_id, &super::ledger::OpOutcome::Unknown("cut off".into()))
        .await;
    let cards = notice_rows(&engine).await;
    assert!(cards.iter().all(|c| data_of(c)["state"] == "resolved"), "{cards:?}");
    let told = svc::pending_events(&engine.db.conn, engine.bot().await).await.unwrap();
    assert!(!told.iter().any(|e| e.summary.contains("cannot tell")));
    assert_eq!(op(&engine, &op_id).await.state, ActionState::Committed);
}

/// An uncertain card whose own send was cut off again: (engine, card id,
/// dispatch id, conversation, repo, the first engine's directory).
async fn an_uncertain_card_cut_off_twice(
    tmp: &tempfile::TempDir,
) -> (
    Arc<PersonalAgentEngine>,
    i32,
    i32,
    i32,
    std::path::PathBuf,
    tempfile::TempDir,
) {
    let (engine, engine_dir) = configured().await;
    let (id, mut rx, _st, conversation) =
        live_session_dispatch(&engine, tmp, "x-u", DispatchState::Completed).await;
    owner_turn(&engine, "pa-u").await;
    call(&engine, "dispatch_followup", json!({ "dispatch_id": id, "message": "deeper" })).await;
    let (_, _, _, receipt) = take_followup(&mut rx);
    receipt.attempted().await.unwrap();
    let again = restarted(&engine, tmp).await;
    let card = notice_id_of(&notice_rows(&again).await[0]);
    // [Send again]: it goes out, and its connection goes away unconfirmed.
    let repo = tmp.path().join("repo-x-u");
    let (mut rx2, _st2) = dispatch_connection(&again, "x-u", &repo, conversation).await;
    again.act_on_notice(card, "accept").await.unwrap();
    let (_, _, _, receipt2) = take_followup(&mut rx2);
    receipt2.attempted().await.unwrap();
    let _ = again.manager.disconnect("x-u").await;
    again.reconcile_dispatches().await;
    assert_eq!(
        svc::get_notice(&again.db.conn, card).await.unwrap().unwrap().state,
        NoticeState::Unknown
    );
    (again, card, id, conversation, repo, engine_dir)
}

/// Review: cut off a second time, the card can still be sent again…
#[tokio::test]
async fn an_uncertain_card_cut_off_again_can_be_sent_again() {
    let tmp = tempfile::tempdir().unwrap();
    let (engine, card, _id, conversation, repo, _dir) = an_uncertain_card_cut_off_twice(&tmp).await;
    let (mut rx, _st) = dispatch_connection(&engine, "x-u3", &repo, conversation).await;
    let row = engine.act_on_notice(card, "accept").await.unwrap();
    assert_eq!(row.data.as_ref().unwrap()["state"], "acting");
    let (text, _, _, receipt) = take_followup(&mut rx);
    assert_eq!(text, "deeper");
    assert_eq!(receipt.op_id, super::ledger::card_op_id(card, 2));
}

/// …or let be.
#[tokio::test]
async fn an_uncertain_card_cut_off_again_can_be_let_be() {
    let tmp = tempfile::tempdir().unwrap();
    let (engine, card, _id, _conversation, _repo, _dir) = an_uncertain_card_cut_off_twice(&tmp).await;
    let row = engine.act_on_notice(card, "dismiss").await.unwrap();
    assert_eq!(row.data.as_ref().unwrap()["state"], "dismissed");
}

// ── 1.2: more than one assistant ─────────────────────────────────────────────

use crate::db::entities::personal_agent::{self as bot_entity, BotKind};
use crate::db::entities::personal_agent_event as event_entity;

/// A worker assistant with an engine of its own on `engine`'s database.
async fn worker(
    engine: &PersonalAgentEngine,
    tmp: &tempfile::TempDir,
    name: &str,
) -> Arc<PersonalAgentEngine> {
    let brain = brain(AgentType::ClaudeCode);
    let row = svc::create_worker(
        &engine.db.conn,
        svc::NewWorker {
            name: name.into(),
            avatar_json: r#"{"kind":"emoji","emoji":"🔧","color":"blue"}"#.into(),
            agent_type: brain.agent_type.as_wire().into_owned(),
            agent_options_json: "{}".into(),
            label_snapshot_json: serde_json::to_string(&brain.label_snapshot).unwrap(),
            settings_json: "{}".into(),
            template: Some("dev".into()),
            executor_assistant_id: None,
        },
    )
    .await
    .unwrap();
    assert_eq!(row.kind, BotKind::Worker);
    let worker = PersonalAgentEngine::new_for_bot_test(
        crate::db::AppDatabase {
            conn: engine.db.conn.clone(),
        },
        tmp.path().to_path_buf(),
        Some(row.id),
    );
    // The first save sets its working directory up, as the primary's does.
    worker
        .save(PersonalAgentDraft {
            agent_config: Some(brain),
            ..Default::default()
        })
        .await
        .unwrap();
    worker
}

#[tokio::test]
async fn a_new_database_has_no_assistant_and_then_one_primary() {
    let (engine, _tmp) = engine().await;
    assert!(svc::primary_bot(&engine.db.conn).await.unwrap().is_none());
    assert!(svc::list_bots(&engine.db.conn).await.unwrap().is_empty());
    assert_eq!(engine.bot().await, 0, "nothing is filed before it is set up");
    engine
        .save(PersonalAgentDraft {
            agent_config: Some(brain(AgentType::ClaudeCode)),
            ..Default::default()
        })
        .await
        .unwrap();
    let bots = svc::list_bots(&engine.db.conn).await.unwrap();
    assert_eq!(bots.len(), 1);
    assert_eq!(bots[0].kind, BotKind::Primary);
    let uid = bots[0].uid.as_deref().expect("a uid");
    assert_eq!(uid.len(), 32);
    assert!(uid.chars().all(|c| c.is_ascii_hexdigit()));
    assert_eq!(engine.bot().await, bots[0].id);
    assert!(engine.serves(bots[0].id).await);
    assert!(!engine.serves(bots[0].id + 1).await);
}

#[tokio::test]
async fn a_second_primary_is_refused_by_the_database() {
    use sea_orm::{ActiveModelTrait, ActiveValue::NotSet, Set};
    let (engine, _tmp) = configured().await;
    let now = chrono::Utc::now();
    let again = bot_entity::ActiveModel {
        id: NotSet,
        name: Set("Two".into()),
        avatar: Set("{}".into()),
        agent_type: Set("claude_code".into()),
        agent_options: Set("{}".into()),
        label_snapshot: Set("{}".into()),
        settings: Set("{}".into()),
        workdir: Set(None),
        folder_id: Set(None),
        revision: Set(1),
        created_at: Set(now),
        updated_at: Set(now),
        kind: Set(BotKind::Primary),
        uid: Set(Some(svc::new_bot_uid())),
        template: Set(None),
        executor_assistant_id: Set(None),
        sort_order: Set(0),
        pinned_at: Set(None),
        section: Set(None),
        hidden: Set(false),
        muted: Set(false),
        unread_mark: Set(false),
        notify: Set(true),
        deleted_at: Set(None),
    }
    .insert(&engine.db.conn)
    .await;
    let err = again.expect_err("one undeleted primary only");
    assert!(
        matches!(err.sql_err(), Some(sea_orm::SqlErr::UniqueConstraintViolation(_))),
        "{err}"
    );
    // A deleted one does not count against it: the live primary stays.
    assert_eq!(svc::list_bots(&engine.db.conn).await.unwrap().len(), 1);
}

#[tokio::test]
async fn two_workers_keep_their_records_apart() {
    let (primary, tmp) = configured().await;
    let a = worker(&primary, &tmp, "Dev").await;
    let b = worker(&primary, &tmp, "Review").await;
    let (pa, ba) = (a.bot().await, b.bot().await);
    assert_ne!(pa, ba);
    assert_ne!(pa, primary.bot().await);
    assert_eq!(svc::list_bots(&primary.db.conn).await.unwrap().len(), 3);

    let ra = a.send_owner_message("a's job".into(), Vec::new(), None).await.unwrap();
    let rb = b.send_owner_message("b's job".into(), Vec::new(), None).await.unwrap();
    // The same news reaching both: each keeps its own event.
    for e in [&a, &b] {
        assert!(svc::insert_event(
            &e.db.conn,
            e.bot().await,
            "dispatch_status",
            "dispatch:7:1:completed:turn",
            None,
            "done".into(),
            None,
            true,
        )
        .await
        .unwrap());
        svc::create_item(
            &e.db.conn,
            e.bot().await,
            ItemKind::Reminder,
            None,
            ItemStatus::Open,
            None,
            "remember".into(),
            None,
            None,
        )
        .await
        .unwrap();
    }
    let coder = role_assistant(&primary, "Coder", true).await;
    svc::create_dispatch(
        &a.db.conn,
        NewDispatch {
            bot_id: pa,
            mode: DispatchMode::Chat,
            executor_assistant_id: coder,
            executor_snapshot_json: "{}".into(),
            folder_id: None,
            deliverable: None,
            title: "a's dispatch".into(),
            prompt: "do".into(),
            origin_batch_id: None,
            on_done: None,
        },
    )
    .await
    .unwrap();

    // Each reads only its own.
    let (rows_a, _) = svc::page(&a.db.conn, pa, None, 50).await.unwrap();
    let (rows_b, _) = svc::page(&b.db.conn, ba, None, 50).await.unwrap();
    assert_eq!(rows_a.iter().map(|r| r.id).collect::<Vec<_>>(), vec![ra.id]);
    assert_eq!(rows_b.iter().map(|r| r.id).collect::<Vec<_>>(), vec![rb.id]);
    assert!(svc::get_row_of(&a.db.conn, pa, rb.id).await.unwrap().is_none());
    assert!(svc::get_row_of(&a.db.conn, pa, ra.id).await.unwrap().is_some());
    assert_eq!(svc::pending_events(&a.db.conn, pa).await.unwrap().len(), 1);
    assert_eq!(svc::pending_events(&b.db.conn, ba).await.unwrap().len(), 1);
    assert_eq!(svc::list_items(&a.db.conn, pa, &[], 10).await.unwrap().len(), 1);
    assert_eq!(svc::list_dispatches(&a.db.conn, pa, &[], None, 10).await.unwrap().len(), 1);
    assert_eq!(svc::list_dispatches(&b.db.conn, ba, &[], None, 10).await.unwrap().len(), 0);
    assert_eq!(svc::queued_owner_rows(&a.db.conn, pa).await.unwrap().len(), 1);
    // Each one's status counts its own; the primary's counts none of theirs.
    assert_eq!(a.snapshot().await.status.queued_messages, 1);
    assert_eq!(b.snapshot().await.status.pending_events, 1);
    let p = primary.snapshot().await.status;
    assert_eq!((p.queued_messages, p.pending_events), (0, 0));
    let (rows_p, _) = svc::page(&primary.db.conn, primary.bot().await, None, 50).await.unwrap();
    assert!(rows_p.is_empty());
    // Nor does a worker steer the other's work.
    let foreign = svc::list_dispatches(&a.db.conn, pa, &[], None, 10).await.unwrap()[0].id;
    let err = b
        .followup_call(foreign, "go on".into(), None, super::dispatch::FollowupAuth::Direct)
        .await
        .expect_err("another assistant's dispatch");
    assert!(err.contains("does not exist"), "{err}");
}

#[tokio::test]
async fn a_workers_event_keys_carry_its_prefix() {
    let (primary, tmp) = configured().await;
    let w = worker(&primary, &tmp, "Dev").await;
    let wb = w.bot().await;
    let key = "dispatch:3:0:completed:turn";
    assert!(svc::insert_event(&primary.db.conn, primary.bot().await, "dispatch_status", key, None, "x".into(), None, true)
        .await
        .unwrap());
    assert!(svc::insert_event(&w.db.conn, wb, "dispatch_status", key, None, "x".into(), None, true)
        .await
        .unwrap());
    // The same key again on the worker is the same event.
    assert!(!svc::insert_event(&w.db.conn, wb, "dispatch_status", key, None, "x".into(), None, true)
        .await
        .unwrap());
    use sea_orm::EntityTrait;
    let mut keys: Vec<String> = event_entity::Entity::find()
        .all(&primary.db.conn)
        .await
        .unwrap()
        .into_iter()
        .map(|e| e.source_key)
        .collect();
    keys.sort();
    assert_eq!(keys, vec![format!("bot{wb}:{key}"), key.to_string()]);
}

#[tokio::test]
async fn workers_have_their_own_git_repositories_and_no_owner_file() {
    let (primary, tmp) = configured().await;
    let w = worker(&primary, &tmp, "Dev").await;
    let row = w.agent_row().await.unwrap();
    let dir = tmp
        .path()
        .join(workdir::BOTS_DIR)
        .join(row.uid.as_deref().unwrap());
    assert_eq!(w.workdir_of(&row), dir);
    assert!(workdir::is_workdir(&dir));
    assert!(dir.join(".git").is_dir(), "its own repository");
    assert!(dir.join(workdir::SOUL_FILE).is_file());
    assert!(!dir.join(workdir::USER_FILE).exists(), "the owner's facts are the primary's");
    let primary_dir = tmp.path().join("personal-agent");
    assert!(primary_dir.join(workdir::USER_FILE).is_file());
    assert!(!dir.starts_with(&primary_dir), "not inside the primary's history");
    assert_eq!(workdir::editable_files(true).len(), 3);
    assert!(!workdir::editable_files(true).contains(&workdir::USER_FILE));
    assert!(workdir::skill_md(true).contains("primary assistant"));
    assert!(!workdir::skill_md(false).contains("You have no `USER.md`"));
}

#[tokio::test]
async fn a_worker_is_given_the_primarys_owner_profile_and_cannot_write_it() {
    let (primary, tmp) = configured().await;
    let w = worker(&primary, &tmp, "Dev").await;
    primary
        .save_file(workdir::USER_FILE, "# The owner\n\nAda, Rust, UTC+8.\n")
        .await
        .unwrap();
    let prow = primary.agent_row().await.unwrap();
    let wrow = w.agent_row().await.unwrap();
    assert!(primary.owner_profile(&prow).await.is_none(), "the primary keeps its own");
    let given = w.owner_profile(&wrow).await.expect("a worker is given it");
    assert!(given.contains("Ada, Rust, UTC+8."));
    let err = w
        .save_file(workdir::USER_FILE, "mine")
        .await
        .expect_err("not a worker's to write");
    assert!(err.contains("primary"), "{err}");
    // How it reaches the brain.
    let update = super::cards::owner_update(&given);
    assert!(update.contains("<codeg-owner>") && update.contains("Ada, Rust, UTC+8."));
    let id = super::cards::Identity {
        name: "Dev",
        soul: "terse",
        rules: "careful",
        user: &given,
        memory: "",
        worker: true,
    };
    let state = super::cards::state_card(&id, &[]);
    assert!(state.contains("kept by the primary assistant"));
    assert!(state.contains("<codeg-owner>"));
}

#[tokio::test]
async fn page_calls_without_an_assistant_read_the_primary() {
    use crate::commands::personal_agent as page;
    let (primary, tmp) = configured().await;
    let w = worker(&primary, &tmp, "Dev").await;
    let pr = primary.send_owner_message("for the primary".into(), Vec::new(), None).await.unwrap();
    let wr = w.send_owner_message("for the worker".into(), Vec::new(), None).await.unwrap();
    let none = page::personal_agent_timeline_core(&primary.db, None, None, None, None).await.unwrap();
    assert_eq!(none.rows.iter().map(|r| r.id).collect::<Vec<_>>(), vec![pr.id]);
    let some = page::personal_agent_timeline_core(&primary.db, Some(w.bot().await), None, None, None)
        .await
        .unwrap();
    assert_eq!(some.rows.iter().map(|r| r.id).collect::<Vec<_>>(), vec![wr.id]);
    assert!(page::personal_agent_timeline_core(&primary.db, Some(9999), None, None, None)
        .await
        .is_err());
    let files = page::personal_agent_files_core(&primary.db, tmp.path(), Some(w.bot().await))
        .await
        .unwrap();
    assert!(files.iter().all(|f| f.name != workdir::USER_FILE));
    let files = page::personal_agent_files_core(&primary.db, tmp.path(), None).await.unwrap();
    assert!(files.iter().any(|f| f.name == workdir::USER_FILE));
}

#[tokio::test]
async fn the_owners_language_lives_on_the_primarys_row_only() {
    let (primary, tmp) = configured().await;
    let w = worker(&primary, &tmp, "Dev").await;
    w.save(PersonalAgentDraft {
        settings: Some(PersonalAgentSettings {
            auto_compact_percent: 70,
            ..Default::default()
        }),
        locale: Some("ja".into()),
        ..Default::default()
    })
    .await
    .unwrap();
    let wrow = w.agent_row().await.unwrap();
    let json: serde_json::Value = serde_json::from_str(&wrow.settings).unwrap();
    assert_eq!(json["auto_compact_percent"], 70);
    assert!(json.get("locale").is_none(), "{json}");
    let prow = primary.agent_row().await.unwrap();
    let json: serde_json::Value = serde_json::from_str(&prow.settings).unwrap();
    assert_eq!(json["locale"], "en", "the primary keeps the account's");
    // The primary's row keeps account keys another part of codeg writes.
    let merged = crate::models::personal_agent::merge_settings_json(
        r#"{"prefs":{"tone":"short"},"auto_compact_percent":10}"#,
        &PersonalAgentSettings::default(),
        true,
    );
    let v: serde_json::Value = serde_json::from_str(&merged).unwrap();
    assert_eq!(v["prefs"]["tone"], "short");
    assert_eq!(v["auto_compact_percent"], 50);
    let v: serde_json::Value = serde_json::from_str(&crate::models::personal_agent::merge_settings_json(
        r#"{"prefs":{"tone":"short"}}"#,
        &PersonalAgentSettings::default(),
        false,
    ))
    .unwrap();
    assert!(v.get("prefs").is_none(), "a worker's row carries no account keys");
}

/// The bots migration on a database as the ledger build left it: the one
/// personal agent becomes the primary, its records are filed under it.
#[tokio::test]
async fn upgrading_files_the_existing_records_under_the_primary() {
    use sea_orm::{ConnectionTrait, Database, DbBackend, Statement};
    use sea_orm_migration::MigratorTrait;
    let conn = Database::connect("sqlite::memory:").await.unwrap();
    let all = crate::db::migration::Migrator::migrations().len();
    crate::db::migration::Migrator::up(&conn, Some((all - 1) as u32)).await.unwrap();
    for sql in [
        "INSERT INTO personal_agent (name, avatar, agent_type, agent_options, label_snapshot, settings, revision, created_at, updated_at) \
         VALUES ('Nova', '{}', 'claude_code', '{}', '{}', '{}', 1, '2026-11-01T00:00:00Z', '2026-11-01T00:00:00Z')",
        "INSERT INTO personal_agent_segment (seq, agent_type, agent_options, start_reason, started_at, compactions_auto, compactions_manual, compactions_agent, auto_compact_paused, state) \
         VALUES (1, 'claude_code', '{}', 'first', '2026-11-01T00:00:00Z', 0, 0, 0, 0, '{}')",
        "INSERT INTO personal_agent_timeline (kind, body, created_at, updated_at) VALUES ('owner', 'hi', '2026-11-01T00:00:00Z', '2026-11-01T00:00:00Z')",
        "INSERT INTO personal_agent_event (kind, source_key, summary, wake, state, requeues, created_at, updated_at) \
         VALUES ('dispatch_status', 'dispatch:1:0:completed:turn', 'done', 1, 'pending', 0, '2026-11-01T00:00:00Z', '2026-11-01T00:00:00Z')",
    ] {
        conn.execute(Statement::from_string(DbBackend::Sqlite, sql.to_owned()))
            .await
            .unwrap_or_else(|e| panic!("{sql}: {e}"));
    }
    crate::db::migration::Migrator::up(&conn, None).await.unwrap();
    let db = crate::db::AppDatabase { conn };
    let primary = svc::primary_bot(&db.conn).await.unwrap().expect("the one row is the primary");
    assert_eq!(primary.name, "Nova");
    assert!(primary.uid.as_deref().is_some_and(|u| u.len() == 32));
    assert!(svc::open_segment(&db.conn, primary.id).await.unwrap().is_some());
    assert_eq!(svc::page(&db.conn, primary.id, None, 10).await.unwrap().0.len(), 1);
    assert_eq!(svc::pending_events(&db.conn, primary.id).await.unwrap().len(), 1);
    // Keys stay as they were: the primary's carry no prefix.
    assert_eq!(
        svc::scoped_source_key(&db.conn, primary.id, "k").await.unwrap(),
        "k"
    );
}

// ── 1.3: one engine per assistant ────────────────────────────────────────────

use crate::acp::connection::SteerOutcome;
use crate::db::entities::personal_agent_batch::BatchStatus;
use sea_orm::{ColumnTrait, EntityTrait, QueryFilter};
use super::host::EngineHost;

/// A worker's row on `engine`'s database (no engine of its own: the host
/// makes that).
async fn worker_row(engine: &PersonalAgentEngine, name: &str) -> i32 {
    let brain = brain(AgentType::ClaudeCode);
    svc::create_worker(
        &engine.db.conn,
        svc::NewWorker {
            name: name.into(),
            avatar_json: r#"{"kind":"emoji","emoji":"🔧","color":"blue"}"#.into(),
            agent_type: brain.agent_type.as_wire().into_owned(),
            agent_options_json: "{}".into(),
            label_snapshot_json: serde_json::to_string(&brain.label_snapshot).unwrap(),
            settings_json: "{}".into(),
            template: Some("dev".into()),
            executor_assistant_id: None,
        },
    )
    .await
    .unwrap()
    .id
}

/// A host whose primary is set up, with a worker on the roster.
async fn hosted() -> (Arc<EngineHost>, i32, tempfile::TempDir) {
    let db = crate::db::test_helpers::fresh_in_memory_db().await;
    let tmp = tempfile::tempdir().unwrap();
    let host = EngineHost::new_for_test(db, tmp.path().to_path_buf());
    host.primary()
        .save(PersonalAgentDraft {
            agent_config: Some(brain(AgentType::ClaudeCode)),
            locale: Some("en".into()),
            ..Default::default()
        })
        .await
        .unwrap();
    let w = worker_row(&host.primary(), "Dev").await;
    (host, w, tmp)
}

/// One pending event handed to a fresh delivery batch on `seg`: the batch
/// and the event.
async fn event_in_a_batch(engine: &PersonalAgentEngine, seg: i32, key: &str) -> (i32, i32) {
    assert!(svc::insert_event(
        &engine.db.conn,
        engine.bot().await,
        "dispatch_status",
        key,
        Some("dispatch:1".into()),
        "Dispatch #1 finished.".into(),
        None,
        true,
    )
    .await
    .unwrap());
    let batch = svc::create_batch(&engine.db.conn, engine.bot().await, seg, BatchKind::Delivery, None)
        .await
        .unwrap();
    let events = svc::pending_events(&engine.db.conn, engine.bot().await).await.unwrap();
    let id = events.iter().find(|e| e.source_key.ends_with(key)).unwrap().id;
    svc::mark_events_delivered(&engine.db.conn, &[id], batch.id).await.unwrap();
    (batch.id, id)
}

/// The reply row a delivery would have made for `batch`, still running.
async fn running_reply(engine: &PersonalAgentEngine, seg: i32, batch: i32) -> i32 {
    let mut row = NewRow::new(TimelineKind::Reply, "");
    row.segment_id = Some(seg);
    row.batch_id = Some(batch);
    row.data = Some(serde_json::json!({ "state": "running", "started_at": chrono::Utc::now() }));
    svc::insert_row(&engine.db.conn, engine.bot().await, row).await.unwrap().id
}

async fn markers_named(engine: &PersonalAgentEngine, name: &str) -> Vec<serde_json::Value> {
    let (rows, _) = svc::page(&engine.db.conn, engine.bot().await, None, 200).await.unwrap();
    rows.into_iter()
        .filter(|r| r.kind == TimelineKind::Marker)
        .map(|r| data_of(&r))
        .filter(|d| d.get("marker").and_then(|m| m.as_str()) == Some(name))
        .collect()
}

#[tokio::test]
async fn the_host_runs_one_engine_per_assistant() {
    let (host, w, _tmp) = hosted().await;
    let primary = host.primary();
    let p = primary.bot().await;
    assert!(Arc::ptr_eq(&host.engine_for(None).await.unwrap(), &primary));
    assert!(Arc::ptr_eq(&host.engine_for(Some(p)).await.unwrap(), &primary));
    let worker = host.engine_for(Some(w)).await.expect("made on first ask");
    assert!(!Arc::ptr_eq(&worker, &primary));
    assert_eq!(worker.bot().await, w);
    assert!(worker.serves(w).await && !primary.serves(w).await);
    assert!(
        Arc::ptr_eq(&host.engine_for(Some(w)).await.unwrap(), &worker),
        "the same engine every time"
    );
    assert!(host.engine_for(Some(9999)).await.is_none(), "nobody");
    assert_eq!(host.engines().await.len(), 2);
    // The worker's engine starts booted, as the host runs.
    assert!(!worker.turn_in_flight_for_test().await);
    // Also through the module-level lookup used by the page commands:
    // nothing runs in the test process (no published host).
    assert!(super::engine::engine_for(Some(w)).await.is_none());
}

#[tokio::test]
async fn events_go_to_the_assistant_whose_connection_they_are_about() {
    let (host, w, _tmp) = hosted().await;
    let primary = host.primary();
    let worker = host.engine_for(Some(w)).await.unwrap();
    let seg_p = open_segment(&primary).await;
    let seg_w = open_segment(&worker).await;
    let batch_p = svc::create_batch(&primary.db.conn, primary.bot().await, seg_p, BatchKind::Delivery, None)
        .await
        .unwrap()
        .id;
    let batch_w = svc::create_batch(&worker.db.conn, worker.bot().await, seg_w, BatchKind::Delivery, None)
        .await
        .unwrap()
        .id;
    primary.begin_turn_for_test("p-conn", seg_p, batch_p, BatchKind::Delivery, false, false).await;
    worker.begin_turn_for_test("w-conn", seg_w, batch_w, BatchKind::Delivery, false, false).await;
    // Two turns in flight at once, one per assistant.
    assert!(primary.turn_in_flight_for_test().await && worker.turn_in_flight_for_test().await);

    host.route(&crate::acp::types::EventEnvelope {
        seq: 1,
        connection_id: "w-conn".into(),
        payload: turn_complete("end_turn"),
    })
    .await;
    assert!(!worker.turn_in_flight_for_test().await, "the worker's turn ended");
    assert!(primary.turn_in_flight_for_test().await, "the primary's goes on");
    assert_eq!(
        svc::get_batch(&worker.db.conn, batch_w).await.unwrap().unwrap().status,
        BatchStatus::Completed
    );
    assert_eq!(
        svc::get_batch(&primary.db.conn, batch_p).await.unwrap().unwrap().status,
        BatchStatus::Running
    );
    // Nobody's connection: nothing happens anywhere.
    host.route(&crate::acp::types::EventEnvelope {
        seq: 2,
        connection_id: "x-conn".into(),
        payload: turn_complete("end_turn"),
    })
    .await;
    assert!(primary.turn_in_flight_for_test().await);
}

#[tokio::test]
async fn a_tool_call_is_answered_as_the_assistant_whose_session_it_comes_from() {
    let (host, w, _tmp) = hosted().await;
    let primary = host.primary();
    let worker = host.engine_for(Some(w)).await.unwrap();
    let seg_p = open_segment(&primary).await;
    let seg_w = open_segment(&worker).await;
    primary.begin_turn_for_test("p-conn", seg_p, 1, BatchKind::Delivery, false, false).await;
    worker.begin_turn_for_test("w-conn", seg_w, 2, BatchKind::Delivery, false, false).await;
    // A conversation the worker dispatched: its calls are the executor's.
    session_dispatch(&worker, DispatchState::Running, "d-conn").await;
    worker.track_conn("d-conn", 1).await;

    let by_w = host.engine_by_connection("w-conn").await.expect("the worker's session");
    assert_eq!(by_w.bot().await, w);
    let by_p = host.engine_by_connection("p-conn").await.expect("the primary's session");
    assert_eq!(by_p.bot().await, primary.bot().await);
    assert!(host.engine_by_connection("d-conn").await.is_none(), "a dispatched conversation");
    assert!(host.engine_by_connection("nobody").await.is_none());
    // And the call itself, as the worker: it reads the worker's records.
    let out = super::tools::call_for_test(&by_w, "item_list", serde_json::json!({})).await;
    assert!(out.ok, "{}", out.text);
}

#[tokio::test]
async fn a_retired_worker_has_no_engine() {
    let (host, w, _tmp) = hosted().await;
    let worker = host.engine_for(Some(w)).await.unwrap();
    let seg = open_segment(&worker).await;
    worker.begin_turn_for_test("w-conn", seg, 1, BatchKind::Delivery, false, false).await;
    assert!(svc::delete_worker(&worker.db.conn, w).await.unwrap());
    host.retire(w).await;
    assert!(host.engine_for(Some(w)).await.is_none(), "deleted: nobody");
    assert_eq!(host.engines().await.len(), 1);
}

#[tokio::test]
async fn the_owners_message_cuts_into_a_turn_that_carries_none_of_theirs() {
    let (engine, _tmp) = configured().await;
    let seg = open_segment(&engine).await;
    let (batch, event) = event_in_a_batch(&engine, seg, "dispatch:1:0:completed:turn").await;
    let reply = running_reply(&engine, seg, batch).await;
    engine.begin_turn_for_test("c", seg, batch, BatchKind::Delivery, false, false).await;
    // No connection "c" in the manager: the stop cannot be sent, the turn
    // is asked to give way all the same (the liveness check or the agent's
    // own completion settles it).
    let msg = engine.send_owner_message("now this".into(), Vec::new(), None).await.unwrap();
    assert!(engine.preempting_for_test().await, "told to give way");
    assert_eq!(msg.status, Some(OwnerStatus::Queued), "waits for the turn to stop");
    // Writing again while it stops asks nothing more.
    engine.send_owner_message("and this".into(), Vec::new(), None).await.unwrap();
    assert!(engine.preempting_for_test().await);

    engine.feed_for_test("c", 1, turn_complete("cancelled")).await;
    assert!(!engine.turn_in_flight_for_test().await);
    let b = svc::get_batch(&engine.db.conn, batch).await.unwrap().unwrap();
    assert_eq!(b.status, BatchStatus::Interrupted);
    assert_eq!(svc::batch_why(&b).as_deref(), Some("preempted"));
    // The event rides again, with no requeue counted.
    let pending = svc::pending_events(&engine.db.conn, engine.bot().await).await.unwrap();
    assert_eq!(pending.len(), 1);
    assert_eq!(pending[0].id, event);
    assert_eq!(pending[0].requeues, 0, "giving way is not a failure");
    assert_eq!(pending[0].requeued_from, Some(batch));
    assert!(engine.any_yielded(&pending).await);
    assert!(engine.interrupted_note(&pending, &[]).await.is_some(), "the next turn is told");
    // The reply is settled as having given way, not as an error.
    let r = svc::get_row(&engine.db.conn, reply).await.unwrap().unwrap();
    assert_eq!(data_of(&r)["state"], "interrupted");
    assert_eq!(data_of(&r)["why"], "preempted");
    let marks = markers_named(&engine, "turn_interrupted").await;
    assert_eq!(marks.len(), 1);
    assert_eq!(marks[0]["why"], "preempted");
    assert!(markers_named(&engine, "turn_failed").await.is_empty());
    // Both messages still wait: the next delivery carries them first and
    // the event after.
    let queued = svc::queued_owner_rows(&engine.db.conn, engine.bot().await).await.unwrap();
    assert_eq!(queued.len(), 2);
    // Had the same event then failed for real, the one requeue is still
    // there for it.
    let batch2 = svc::create_batch(&engine.db.conn, engine.bot().await, seg, BatchKind::Delivery, None)
        .await
        .unwrap();
    svc::mark_events_delivered(&engine.db.conn, &[event], batch2.id).await.unwrap();
    let back = svc::requeue_batch_events(&engine.db.conn, batch2.id).await.unwrap();
    assert_eq!(back, vec![event]);
    let again = svc::pending_events(&engine.db.conn, engine.bot().await).await.unwrap();
    assert_eq!(again[0].requeues, 1);
}

#[tokio::test]
async fn an_event_put_back_once_already_keeps_its_count_when_it_gives_way() {
    let (engine, _tmp) = configured().await;
    let seg = open_segment(&engine).await;
    let (batch, event) = event_in_a_batch(&engine, seg, "dispatch:2:0:completed:turn").await;
    event_entity::Entity::update_many()
        .col_expr(event_entity::Column::Requeues, sea_orm::sea_query::Expr::value(1))
        .filter(event_entity::Column::Id.eq(event))
        .exec(&engine.db.conn)
        .await
        .unwrap();
    engine.begin_turn_for_test("c", seg, batch, BatchKind::Delivery, false, false).await;
    engine.send_owner_message("now".into(), Vec::new(), None).await.unwrap();
    engine.feed_for_test("c", 1, turn_complete("cancelled")).await;
    let pending = svc::pending_events(&engine.db.conn, engine.bot().await).await.unwrap();
    assert_eq!(pending.len(), 1, "not settled as handled");
    assert_eq!(pending[0].requeues, 1, "unchanged");
    assert_eq!(pending[0].state, EventState::Pending);
}

#[tokio::test]
async fn a_turn_that_ended_on_its_own_before_the_stop_landed_finished_as_usual() {
    let (engine, _tmp) = configured().await;
    let seg = open_segment(&engine).await;
    let (batch, _event) = event_in_a_batch(&engine, seg, "dispatch:3:0:completed:turn").await;
    engine.begin_turn_for_test("c", seg, batch, BatchKind::Delivery, false, false).await;
    engine.send_owner_message("now".into(), Vec::new(), None).await.unwrap();
    assert!(engine.preempting_for_test().await);
    engine.feed_for_test("c", 1, turn_complete("end_turn")).await;
    let b = svc::get_batch(&engine.db.conn, batch).await.unwrap().unwrap();
    assert_eq!(b.status, BatchStatus::Completed);
    assert!(svc::pending_events(&engine.db.conn, engine.bot().await).await.unwrap().is_empty());
    assert!(markers_named(&engine, "turn_interrupted").await.is_empty());
}

#[tokio::test]
async fn a_compaction_is_never_cut_into() {
    let (engine, _tmp) = configured().await;
    let seg = open_segment(&engine).await;
    let batch = svc::create_batch(&engine.db.conn, engine.bot().await, seg, BatchKind::Compaction, None)
        .await
        .unwrap();
    engine.begin_turn_for_test("c", seg, batch.id, BatchKind::Compaction, false, false).await;
    let msg = engine.send_owner_message("now".into(), Vec::new(), None).await.unwrap();
    assert!(!engine.preempting_for_test().await);
    assert_eq!(msg.status, Some(OwnerStatus::Queued));
    assert!(engine.turn_in_flight_for_test().await);
}

#[tokio::test]
async fn the_owners_own_stop_is_still_a_stop() {
    let (engine, _tmp) = configured().await;
    let seg = open_segment(&engine).await;
    let (batch, _event) = event_in_a_batch(&engine, seg, "dispatch:4:0:completed:turn").await;
    engine.begin_turn_for_test("c", seg, batch, BatchKind::Delivery, false, false).await;
    // Nobody wrote: a cancelled completion is the owner's stop button.
    engine.feed_for_test("c", 1, turn_complete("cancelled")).await;
    let b = svc::get_batch(&engine.db.conn, batch).await.unwrap().unwrap();
    assert_eq!(b.status, BatchStatus::Canceled);
    assert!(svc::pending_events(&engine.db.conn, engine.bot().await).await.unwrap().is_empty());
}

/// A turn carrying the owner's earlier message takes the new one in while
/// it runs, when the agent folds steered input into the turn in flight.
#[tokio::test]
async fn a_message_folds_into_a_turn_carrying_an_earlier_one_when_the_agent_takes_it() {
    let (engine, _tmp) = configured().await;
    let seg = open_segment(&engine).await;
    let batch = svc::create_batch(&engine.db.conn, engine.bot().await, seg, BatchKind::Delivery, None)
        .await
        .unwrap()
        .id;
    let first = engine.send_owner_message("first".into(), Vec::new(), None).await.unwrap();
    svc::move_owner_rows(
        &engine.db.conn,
        &[first.id],
        &[OwnerStatus::Queued],
        OwnerStatus::Delivered,
        Some(batch),
        Some(seg),
        svc::ReadMark::Read,
    )
    .await
    .unwrap();
    let mut rx = engine
        .manager
        .insert_test_connection_live("c", AgentType::ClaudeCode, None, EventEmitter::Noop)
        .await;
    {
        let state = engine.manager.get_state("c").await.unwrap();
        let mut s = state.write().await;
        s.native_steering_available = true;
        s.turn_in_flight = true;
        s.agent_info = Some(("claude-agent-acp".into(), "0.101.0".into()));
    }
    engine.begin_turn_for_test("c", seg, batch, BatchKind::Delivery, false, false).await;
    engine.set_turn_owner_rows_for_test(vec![first.id]).await;
    // The connection loop's part: take the steer.
    let taken = tokio::spawn(async move {
        match rx.recv().await {
            Some(ConnectionCommand::Steer { blocks, reply }) => {
                let _ = reply.send(Ok(SteerOutcome::Injected));
                (blocks, rx)
            }
            _ => panic!("expected a steer"),
        }
    });
    let second = engine
        .send_owner_message("second".into(), Vec::new(), Some(first.id))
        .await
        .unwrap();
    let (blocks, mut rx) = taken.await.unwrap();
    let text = blocks
        .iter()
        .find_map(|b| match b {
            crate::acp::types::PromptInputBlock::Text { text } => Some(text.clone()),
            _ => None,
        })
        .unwrap();
    assert!(text.starts_with(&format!("[#{}, replying to #{}", second.id, first.id)), "{text}");
    assert!(text.ends_with("second"), "{text}");
    assert_eq!(second.status, Some(OwnerStatus::Delivered), "the turn's now");
    assert_eq!(second.batch_id, Some(batch));
    assert_eq!(second.data.as_ref().unwrap()["merged"], true);
    assert!(second.read_at.is_some());
    assert!(!engine.preempting_for_test().await, "nothing was stopped");
    // When that turn ends, both messages are answered.
    engine.feed_for_test("c", 1, turn_complete("end_turn")).await;
    let r2 = svc::get_row(&engine.db.conn, second.id).await.unwrap().unwrap();
    assert_eq!(r2.status, Some(OwnerStatus::Answered));

    // An adapter that never answers a folded prompt: the message waits.
    let batch2 = svc::create_batch(&engine.db.conn, engine.bot().await, seg, BatchKind::Delivery, None)
        .await
        .unwrap()
        .id;
    {
        let state = engine.manager.get_state("c").await.unwrap();
        let mut s = state.write().await;
        s.turn_in_flight = true;
        s.agent_info = Some(("claude-agent-acp".into(), "0.86.0".into()));
    }
    engine.begin_turn_for_test("c", seg, batch2, BatchKind::Delivery, false, false).await;
    engine.set_turn_owner_rows_for_test(vec![first.id]).await;
    let third = engine.send_owner_message("third".into(), Vec::new(), None).await.unwrap();
    assert_eq!(third.status, Some(OwnerStatus::Queued));
    assert!(rx.try_recv().is_err(), "no steer went out");
}

#[test]
fn only_adapters_that_answer_a_folded_prompt_take_one() {
    use super::engine::steering_answers_folded_input;
    let claude = |v: &str| Some(("claude-agent-acp".to_string(), v.to_string()));
    assert!(!steering_answers_folded_input(claude("0.86.0").as_ref()));
    assert!(!steering_answers_folded_input(claude("0.65.0").as_ref()));
    assert!(steering_answers_folded_input(claude("0.87.0").as_ref()));
    assert!(steering_answers_folded_input(claude("0.101.0").as_ref()));
    assert!(!steering_answers_folded_input(claude("not a version").as_ref()));
    let scoped = Some(("@agentclientprotocol/claude-agent-acp".to_string(), "0.80.0".to_string()));
    assert!(!steering_answers_folded_input(scoped.as_ref()));
    let codex = Some(("codex-acp".to_string(), "2.4.0".to_string()));
    assert!(steering_answers_folded_input(codex.as_ref()));
    assert!(steering_answers_folded_input(None));
}

/// With attachments, the blocks are the whole of what goes over the wire:
/// the message's text leads them.
#[tokio::test]
async fn a_folded_message_with_attachments_leads_with_its_text() {
    let (engine, _tmp) = configured().await;
    let seg = open_segment(&engine).await;
    let batch = svc::create_batch(&engine.db.conn, engine.bot().await, seg, BatchKind::Delivery, None)
        .await
        .unwrap()
        .id;
    let first = engine.send_owner_message("first".into(), Vec::new(), None).await.unwrap();
    let mut rx = engine
        .manager
        .insert_test_connection_live("c", AgentType::ClaudeCode, None, EventEmitter::Noop)
        .await;
    {
        let state = engine.manager.get_state("c").await.unwrap();
        let mut s = state.write().await;
        s.native_steering_available = true;
        s.turn_in_flight = true;
        s.agent_info = Some(("codex-acp".into(), "2.5.0".into()));
    }
    engine.begin_turn_for_test("c", seg, batch, BatchKind::Delivery, false, false).await;
    engine.set_turn_owner_rows_for_test(vec![first.id]).await;
    let taken = tokio::spawn(async move {
        match rx.recv().await {
            Some(ConnectionCommand::Steer { blocks, reply }) => {
                let _ = reply.send(Ok(SteerOutcome::Injected));
                blocks
            }
            _ => panic!("expected a steer"),
        }
    });
    let image = crate::acp::types::PromptInputBlock::Image {
        data: "aGk=".into(),
        mime_type: "image/png".into(),
        uri: None,
    };
    let second = engine
        .send_owner_message("use this screenshot".into(), vec![image], None)
        .await
        .unwrap();
    let blocks = taken.await.unwrap();
    assert_eq!(blocks.len(), 2, "{blocks:?}");
    match &blocks[0] {
        crate::acp::types::PromptInputBlock::Text { text } => {
            assert_eq!(text, &format!("[#{}] use this screenshot", second.id));
        }
        other => panic!("the text leads: {other:?}"),
    }
    assert!(matches!(&blocks[1], crate::acp::types::PromptInputBlock::Image { .. }));
    assert_eq!(second.data.as_ref().unwrap()["merged"], true);
}

/// The turn ends while a message is being handed to it. Claimed before the
/// hand-over, the message is settled with the turn when the agent took it,
/// and goes back to the queue — once, unread — when it did not.
#[tokio::test]
async fn a_message_claimed_by_a_turn_that_ends_during_the_hand_over_is_settled_once() {
    // (taken by the agent, how the turn ended)
    for (taken, stop) in [(true, "end_turn"), (false, "end_turn"), (false, "rejected")] {
        let (engine, _tmp) = configured().await;
        let seg = open_segment(&engine).await;
        let batch = svc::create_batch(&engine.db.conn, engine.bot().await, seg, BatchKind::Delivery, None)
            .await
            .unwrap()
            .id;
        let first = engine.send_owner_message("first".into(), Vec::new(), None).await.unwrap();
        svc::move_owner_rows(
            &engine.db.conn,
            &[first.id],
            &[OwnerStatus::Queued],
            OwnerStatus::Delivered,
            Some(batch),
            Some(seg),
            svc::ReadMark::Read,
        )
        .await
        .unwrap();
        let mut rx = engine
            .manager
            .insert_test_connection_live("c", AgentType::ClaudeCode, None, EventEmitter::Noop)
            .await;
        {
            let state = engine.manager.get_state("c").await.unwrap();
            let mut s = state.write().await;
            s.native_steering_available = true;
            s.turn_in_flight = true;
            s.agent_info = Some(("codex-acp".into(), "2.5.0".into()));
        }
        engine.begin_turn_for_test("c", seg, batch, BatchKind::Delivery, false, false).await;
        engine.set_turn_owner_rows_for_test(vec![first.id]).await;
        let e = engine.clone();
        let handler = tokio::spawn(async move {
            match rx.recv().await {
                Some(ConnectionCommand::Steer { reply, .. }) => {
                    // The turn ends before the steer is answered.
                    e.feed_for_test("c", 1, turn_complete(stop)).await;
                    let _ = reply.send(if taken {
                        Ok(SteerOutcome::Injected)
                    } else {
                        Err(crate::acp::error::AcpError::NoActiveTurn)
                    });
                }
                _ => panic!("expected a steer"),
            }
        });
        let second = engine.send_owner_message("second".into(), Vec::new(), None).await.unwrap();
        handler.await.unwrap();
        assert!(!engine.turn_in_flight_for_test().await);
        let r2 = svc::get_row(&engine.db.conn, second.id).await.unwrap().unwrap();
        let queued = svc::queued_owner_rows(&engine.db.conn, engine.bot().await).await.unwrap();
        if taken {
            assert_eq!(r2.status, Some(OwnerStatus::Answered), "settled with the turn");
            assert_eq!(data_of(&r2)["merged"], true);
            assert!(queued.is_empty(), "not sent a second time");
        } else if stop == "rejected" {
            // The turn was interrupted meanwhile: the claim went down with
            // the turn's own message, and is sent again from the page like
            // it — not queued here as well, or the owner's own resend would
            // make two.
            assert_eq!(r2.status, Some(OwnerStatus::Interrupted));
            assert_eq!(data_of(&r2).get("merged"), None);
            assert!(queued.is_empty());
            let r1 = svc::get_row(&engine.db.conn, first.id).await.unwrap().unwrap();
            assert_eq!(r1.status, Some(OwnerStatus::Interrupted), "the turn's own message too");
            let copy = engine.resend(second.id).await.unwrap();
            assert_eq!(copy.status, Some(OwnerStatus::Queued));
            assert_eq!(
                svc::queued_owner_rows(&engine.db.conn, engine.bot().await).await.unwrap().len(),
                1,
                "exactly one copy"
            );
        } else {
            // The turn finished meanwhile: nothing of this message reached
            // the agent, so it simply goes next.
            assert_eq!(r2.status, Some(OwnerStatus::Queued), "waits for the next delivery");
            assert!(r2.read_at.is_none());
            assert_eq!(queued.len(), 1);
            assert_eq!(data_of(&r2).get("merged"), None);
        }
        let b = svc::get_batch(&engine.db.conn, batch).await.unwrap().unwrap();
        if stop == "rejected" {
            assert_eq!(b.status, BatchStatus::Interrupted);
        } else {
            assert_eq!(b.status, BatchStatus::Completed);
        }
    }
}

/// Settling a turn is serialized with deliveries: while one is being
/// delivered, the end of a turn waits; and while a turn is being settled
/// (its events put back), no delivery starts.
#[tokio::test]
async fn settling_a_turn_waits_for_the_delivery_in_flight() {
    let (engine, _tmp) = configured().await;
    let seg = open_segment(&engine).await;
    let (batch, event) = event_in_a_batch(&engine, seg, "dispatch:5:0:completed:turn").await;
    engine.begin_turn_for_test("c", seg, batch, BatchKind::Delivery, false, false).await;
    engine.send_owner_message("now".into(), Vec::new(), None).await.unwrap();
    let guard = engine.hold_pump_for_test().await;
    let e = engine.clone();
    let settling = tokio::spawn(async move {
        e.feed_for_test("c", 1, turn_complete("cancelled")).await;
    });
    for _ in 0..20 {
        tokio::task::yield_now().await;
    }
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    assert!(engine.turn_in_flight_for_test().await, "waits for the delivery lock");
    assert!(
        svc::pending_events(&engine.db.conn, engine.bot().await).await.unwrap().is_empty(),
        "nothing put back yet"
    );
    drop(guard);
    settling.await.unwrap();
    assert!(!engine.turn_in_flight_for_test().await);
    let pending = svc::pending_events(&engine.db.conn, engine.bot().await).await.unwrap();
    assert_eq!(pending.iter().map(|e| e.id).collect::<Vec<_>>(), vec![event]);
}
