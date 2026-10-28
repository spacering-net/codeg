use super::*;
use crate::acp::delegation::broker::{ConversationDepthLookup, DelegationBroker, DelegationConfig};
use crate::acp::delegation::event_emitter::mock::MockEventEmitter;
use crate::acp::delegation::meta_writer::NoopMetaWriter;
use crate::acp::delegation::spawner::mock::MockSpawner;
use crate::acp::delegation::types::{DelegationError, DelegationRequest};
use crate::acp::manager::ConnectionManager;
use crate::acp::plan_revision::PlanRevisions;
use crate::acp::types::EventEnvelope;
use crate::db::{service::conversation_service, test_helpers, AppDatabase};
use agent_client_protocol::schema::v1::PromptResponse;
use serde_json::{json, Value};
use std::time::Duration;

struct FlatDepth;

#[derive(Clone, Copy)]
enum PromptFailure {
    None,
    Rejected,
    Reported,
}

#[async_trait::async_trait]
impl ConversationDepthLookup for FlatDepth {
    async fn parent_of(&self, _id: i32) -> Result<Option<i32>, DelegationError> {
        Ok(None)
    }
}

struct RevisionHarness {
    db: AppDatabase,
    manager: ConnectionManager,
    broker: Arc<DelegationBroker>,
    spawner: Arc<MockSpawner>,
    completed: Arc<MockEventEmitter>,
    task_id: String,
    conversation_id: i32,
    state: Arc<RwLock<SessionState>>,
    events: tokio::sync::broadcast::Receiver<Arc<EventEnvelope>>,
    seen: Vec<Arc<EventEnvelope>>,
    prompts: Arc<std::sync::Mutex<Vec<Value>>>,
    client: tokio::task::JoinHandle<()>,
    agent: tokio::task::JoinHandle<()>,
}

impl Drop for RevisionHarness {
    fn drop(&mut self) {
        self.client.abort();
        self.agent.abort();
    }
}

impl RevisionHarness {
    async fn start(
        agent_type: AgentType,
        legacy: bool,
        fail_second: PromptFailure,
        ordinary: bool,
    ) -> Self {
        let db = test_helpers::fresh_in_memory_db().await;
        let folder = test_helpers::seed_folder(&db, "/tmp/plan-revision").await;
        let conv = conversation_service::create(&db.conn, folder, agent_type, None, None)
            .await
            .unwrap();
        let spawner = Arc::new(MockSpawner::new());
        spawner.queue_spawn(Ok("revision-child".into())).await;
        spawner.queue_send(Ok(conv.id)).await;
        let completed = Arc::new(MockEventEmitter::new());
        let broker = Arc::new(DelegationBroker::with_writers(
            spawner.clone(),
            Arc::new(FlatDepth),
            Arc::new(NoopMetaWriter),
            completed.clone(),
        ));
        broker
            .set_config(DelegationConfig {
                enabled: true,
                ..Default::default()
            })
            .await;
        let report = broker
            .start_delegation(DelegationRequest {
                parent_connection_id: "parent".into(),
                parent_conversation_id: 1,
                parent_tool_use_id: "tool-parent".into(),
                agent_type,
                task: "plan the change".into(),
                working_dir: None,
                requested_working_dir: None,
                external_handle: None,
                assistant: None,
            })
            .await;
        let task_id = report.task_id.unwrap();
        let state = Arc::new(RwLock::new(SessionState::new(
            "revision-child".into(),
            agent_type,
            None,
            "test".into(),
            None,
        )));
        {
            let mut s = state.write().await;
            s.conversation_id = Some(conv.id);
            s.external_id = Some("session-plan".into());
            s.current_mode = Some("plan".into());
            s.turn_in_flight = true;
        }
        let events = state.read().await.event_stream().subscribe();
        let perms = PendingPermissions::default();
        let (cmd_tx, mut cmd_rx) = mpsc::channel(16);
        let manager = ConnectionManager::new();
        manager.connections.lock().await.insert(
            "revision-child".into(),
            AgentConnection {
                id: "revision-child".into(),
                agent_type,
                status: ConnectionStatus::Connected,
                owner_window_label: "test".into(),
                cmd_tx: cmd_tx.clone(),
                handshake: CancellationToken::new(),
                state: state.clone(),
                emitter: EventEmitter::Noop,
                prompt_lock: Arc::default(),
                config_fingerprint: String::new(),
                last_observed_fingerprint: String::new(),
                child_pid: Arc::default(),
            },
        );
        let prompts = Arc::new(std::sync::Mutex::new(Vec::<Value>::new()));
        let prompt_log = prompts.clone();
        let (client_end, agent_end) = agent_client_protocol::Channel::duplex();
        let agent = tokio::spawn(async move {
            let _ = Agent.builder().on_receive_request(
                async move |req: PromptRequest, responder: Responder<PromptResponse>, cx: ConnectionTo<Client>| {
                    let ordinal = {
                        let mut log = prompt_log.lock().unwrap();
                        log.push(serde_json::to_value(&req).unwrap());
                        log.len()
                    };
                    tokio::spawn(async move {
                        if ordinal == 2 {
                            match fail_second {
                                PromptFailure::Rejected => return responder.respond_with_error(agent_client_protocol::Error::invalid_params().data("feedback delivery failed")),
                                PromptFailure::Reported => {
                                    let meta = json!({"jetbrains": {"air": {
                                        "version": 1, "sessionFailure": {
                                            "id": "feedback:error", "revision": 1,
                                            "category": "connection", "severity": "error",
                                            "title": "Feedback prompt failed", "actions": ["new_session"]
                                        }
                                    }}}).as_object().unwrap().clone();
                                    return responder.respond(PromptResponse::new(StopReason::EndTurn).meta(meta));
                                }
                                PromptFailure::None => {}
                            }
                        }
                        let notification: SessionNotification = serde_json::from_value(json!({
                            "sessionId": "session-plan", "update": { "sessionUpdate": "agent_message_chunk",
                                "content": { "type": "text", "text": "A real plan" } }
                        })).unwrap();
                        cx.send_notification_to(Client, notification)?;
                        let mut value = json!({
                            "sessionId": "session-plan",
                            "toolCall": { "toolCallId": format!("plan-review:item-{ordinal}"),
                                "title": "Implement?", "kind": "switch_mode" },
                            "options": [
                                { "optionId": "implement_plan", "name": "Yes", "kind": "allow_once" },
                                { "optionId": "revise_plan", "name": "No", "kind": "reject_once" }
                            ]
                        });
                        if legacy {
                            value["toolCall"]["toolCallId"] = json!(format!("legacy-{ordinal}"));
                            value["_meta"] = json!({"codex": {"kind": "plan_review", "planItemId": "legacy"}});
                        }
                        if ordinary {
                            value["toolCall"]["toolCallId"] = json!("ordinary-shell");
                            value["toolCall"]["kind"] = json!("execute");
                        }
                        let permission: RequestPermissionRequest = serde_json::from_value(value).unwrap();
                        let answer = cx.send_request_to(Client, permission).block_task().await?;
                        assert!(matches!(answer.outcome, RequestPermissionOutcome::Selected(_)));
                        // No sleep: the physical end can beat the HTTP caller's receipt.
                        responder.respond(PromptResponse::new(StopReason::EndTurn))
                    });
                    Ok(())
                }, on_receive_request!(),
            ).connect_with(agent_end, async |_cx: ConnectionTo<Client>| {
                std::future::pending::<Result<(), agent_client_protocol::Error>>().await
            }).await;
        });
        let handler_state = state.clone();
        let loop_state = state.clone();
        let handler_perms = perms.clone();
        let client = tokio::spawn(async move {
            let _ = Client
                .builder()
                .on_receive_request(
                    async move |req: RequestPermissionRequest,
                                responder: Responder<RequestPermissionResponse>,
                                cx: ConnectionTo<Agent>| {
                        handle_permission_request(
                            &cx,
                            &handler_state,
                            &EventEmitter::Noop,
                            &handler_perms,
                            "/tmp",
                            agent_type,
                            req,
                            responder,
                        )
                        .await;
                        Ok(())
                    },
                    on_receive_request!(),
                )
                .connect_with(client_end, async move |cx: ConnectionTo<Agent>| {
                    let mut session = AgentSession::attach(
                        &cx,
                        NewSessionResponse::new(SessionId::new("session-plan")),
                    )?;
                    run_conversation_loop(
                        &mut session,
                        "revision-child",
                        &EventEmitter::Noop,
                        &loop_state,
                        agent_type,
                        &perms,
                        &mut cmd_rx,
                        Arc::new(TerminalRuntime::with_base_env(BTreeMap::new())),
                        "/tmp",
                        false,
                        &[],
                        &background_watch::PromptLedger::shared(),
                        None,
                        &Arc::new(StderrTail::new()),
                    )
                    .await?;
                    Ok(())
                })
                .await;
        });
        cmd_tx
            .send(ConnectionCommand::Prompt {
                blocks: vec![PromptInputBlock::Text {
                    text: "Make a plan".into(),
                }],
                user_message: None,
                internal_suffix: Vec::new(),
            })
            .await
            .unwrap();
        Self {
            db,
            manager,
            broker,
            spawner,
            completed,
            task_id,
            conversation_id: conv.id,
            state,
            events,
            seen: Vec::new(),
            prompts,
            client,
            agent,
        }
    }

    async fn next(&mut self) -> Arc<EventEnvelope> {
        let event = tokio::time::timeout(Duration::from_secs(10), self.events.recv())
            .await
            .unwrap()
            .unwrap();
        if matches!(event.payload, AcpEvent::TurnComplete { .. }) {
            crate::acp::lifecycle::handle_event(
                &self.db.conn,
                &self.manager,
                &event,
                Some(&self.broker),
            )
            .await
            .unwrap();
        }
        self.seen.push(event.clone());
        event
    }

    async fn review(&mut self) -> String {
        loop {
            let event = self.next().await;
            if let AcpEvent::PermissionRequest {
                request_id,
                tool_call,
                ..
            } = &event.payload
            {
                if self.state.read().await.agent_type == AgentType::Codex
                    && tool_call["kind"] == "switch_mode"
                {
                    assert_eq!(tool_call["_meta"]["codex"]["kind"], "plan_review");
                    assert_eq!(
                        self.state
                            .read()
                            .await
                            .to_snapshot()
                            .pending_permission
                            .as_ref()
                            .unwrap()
                            .tool_call["_meta"]["codex"]["kind"],
                        "plan_review"
                    );
                }
                return request_id.clone();
            }
        }
    }

    async fn change(
        &self,
        request: &str,
        feedback: &str,
    ) -> Result<PlanRevisionReceipt, AppCommandError> {
        self.manager
            .request_plan_changes("revision-child", request, feedback)
            .await
    }

    async fn answer(&self, request: &str, option: &str) {
        self.manager
            .respond_permission("revision-child", request, option)
            .await
            .unwrap();
    }

    async fn final_turn(&mut self) {
        loop {
            if matches!(self.next().await.payload, AcpEvent::TurnComplete { .. }) {
                break;
            }
        }
    }

    async fn assert_running(&self) {
        assert_eq!(
            self.broker
                .call_id_for_child_connection("revision-child")
                .await
                .as_deref(),
            Some(self.task_id.as_str())
        );
        assert_eq!(self.broker.pending_count().await, 1);
        assert!(self.completed.calls.lock().await.is_empty());
        assert!(self.spawner.disconnects.lock().await.is_empty());
        let s = self.state.read().await;
        assert_eq!(s.external_id.as_deref(), Some("session-plan"));
        assert_eq!(s.conversation_id, Some(self.conversation_id));
        assert_eq!(s.current_mode.as_deref(), Some("plan"));
        assert_eq!(
            conversation_service::get_by_id(&self.db.conn, self.conversation_id)
                .await
                .unwrap()
                .status,
            "in_progress"
        );
    }
}

#[tokio::test]
async fn codex_plan_revision_twice_keeps_session_task_and_completes_once() {
    let mut h = RevisionHarness::start(AgentType::Codex, false, PromptFailure::None, false).await;
    let first = h.review().await;
    let (first_reply, retry_reply) = tokio::join!(
        h.change(&first, "  Use streaming  "),
        h.change(&first, "Use streaming")
    );
    let receipt = first_reply.unwrap();
    assert_eq!(retry_reply.unwrap(), receipt);
    assert_eq!(receipt.status, "accepted");
    let second = h.review().await;
    h.assert_running().await;
    assert_eq!(h.change(&first, "Use streaming").await.unwrap(), receipt);
    assert_eq!(
        h.change(&first, "different").await.unwrap_err().message,
        "plan_review_already_decided"
    );
    h.change(&second, "Add tests").await.unwrap();
    let third = h.review().await;
    h.assert_running().await;
    h.answer(&third, "implement_plan").await;
    h.final_turn().await;
    assert_eq!(
        h.change(&third, "too late").await.unwrap_err().message,
        "plan_review_already_decided"
    );
    let log = h.prompts.lock().unwrap().clone();
    assert_eq!(log.len(), 3);
    assert!(log.iter().all(|p| p["sessionId"] == "session-plan"));
    assert_eq!(log[1]["prompt"][0]["text"], "Use streaming");
    assert_eq!(log[2]["prompt"][0]["text"], "Add tests");
    let decisions: Vec<_> = h
        .seen
        .iter()
        .filter_map(|e| match &e.payload {
            AcpEvent::PermissionResolved { option_id, .. } => option_id.as_deref(),
            _ => None,
        })
        .collect();
    assert_eq!(decisions, ["revise_plan", "revise_plan", "implement_plan"]);
    assert_eq!(
        h.seen
            .iter()
            .filter(|e| matches!(e.payload, AcpEvent::UserMessage { .. }))
            .count(),
        2
    );
    assert_eq!(h.completed.calls.lock().await.len(), 1);
    assert_eq!(
        h.spawner.disconnects.lock().await.as_slice(),
        &["revision-child"]
    );
    assert!(h.spawner.continue_spawn_args.lock().await.is_empty());
    assert_eq!(h.spawner.spawn_args.lock().await.len(), 1);
}

#[tokio::test]
async fn codex_plan_revision_fast_end_then_failed_prompt_is_explicit_and_terminal() {
    for failure in [PromptFailure::Rejected, PromptFailure::Reported] {
        let mut h = RevisionHarness::start(AgentType::Codex, true, failure, false).await;
        let first = h.review().await;
        h.change(&first, "Do not lose this").await.unwrap();
        h.final_turn().await; // Intermediate physical boundary, never complete_call.
        h.assert_running().await;
        h.final_turn().await; // The rejected feedback prompt must settle normally.
        let snapshot = h.state.read().await.to_snapshot();
        assert_eq!(snapshot.plan_revisions[0].feedback, "Do not lose this");
        assert_eq!(snapshot.plan_revisions[0].status, RevisionStatus::Failed);
        assert!(h.seen.iter().any(|e| matches!(&e.payload, AcpEvent::Error { code: Some(code), .. } if code == "plan_revision_send_failed")));
        assert_eq!(h.broker.pending_count().await, 0);
        assert_eq!(h.completed.calls.lock().await.len(), 1);
        assert_eq!(h.spawner.disconnects.lock().await.len(), 1);
        assert!(matches!(
            h.completed.calls.lock().await[0].result,
            crate::acp::types::DelegationResultSummary::Err { .. }
        ));
    }
}

#[tokio::test]
async fn codex_plan_revision_plain_no_and_unrelated_permissions_keep_original_behavior() {
    for (agent, ordinary) in [
        (AgentType::Codex, false),
        (AgentType::Codex, true),
        (AgentType::ClaudeCode, false),
    ] {
        let mut h = RevisionHarness::start(agent, false, PromptFailure::None, ordinary).await;
        let request = h.review().await;
        if ordinary || agent != AgentType::Codex {
            assert_eq!(
                h.change(&request, "do not apply here")
                    .await
                    .unwrap_err()
                    .message,
                "not_codex_plan_review"
            );
        }
        h.answer(&request, "revise_plan").await;
        h.final_turn().await;
        assert_eq!(h.prompts.lock().unwrap().len(), 1);
        assert!(h.state.read().await.to_snapshot().plan_revisions.is_empty());
        assert_eq!(h.completed.calls.lock().await.len(), 1);
        assert_eq!(h.spawner.disconnects.lock().await.len(), 1);
        assert!(h.spawner.cancels.lock().await.is_empty());
    }
}

#[test]
fn codex_plan_revision_feedback_validation_counts_unicode_without_truncation() {
    assert_eq!(
        PlanRevisions::normalize(" \n ").unwrap_err().message,
        "plan_feedback_empty"
    );
    let text = "\u{1f600}".repeat(crate::acp::plan_approval::MAX_FEEDBACK_CHARS);
    assert_eq!(PlanRevisions::normalize(&text).unwrap(), text);
    assert_eq!(
        PlanRevisions::normalize(&format!("{text}x"))
            .unwrap_err()
            .message,
        "plan_feedback_too_long"
    );
}

#[tokio::test]
async fn codex_plan_revision_manager_returns_structured_errors() {
    use crate::app_error::AppErrorCode;
    use axum::response::IntoResponse;
    let manager = ConnectionManager::new();
    for (feedback, message, status) in [
        (" ", "plan_feedback_empty", 400),
        ("valid", "connection_not_found", 404),
    ] {
        let error = manager
            .request_plan_changes("missing", "missing", feedback)
            .await
            .unwrap_err();
        assert_eq!(error.message, message);
        assert_eq!(error.into_response().status().as_u16(), status);
    }
    let mut h = RevisionHarness::start(AgentType::Codex, false, PromptFailure::None, false).await;
    let request = h.review().await;
    let error = h.change("unknown-request", "valid").await.unwrap_err();
    assert!(matches!(error.code, AppErrorCode::NotFound));
    assert_eq!(error.message, "plan_review_not_pending");
    assert_eq!(
        serde_json::to_value(PlanRevisions::receipt(&request)).unwrap(),
        json!({
            "requestId": request, "status": "accepted"
        })
    );
}
