//! End-to-end Phase 6 integration: drive real UDS round-trips from a
//! companion-style client through the listener → broker → mock spawner →
//! `complete_call`. Under the async protocol `delegate_to_agent` returns a
//! Running ack and the terminal result is collected by a follow-up
//! `get_delegation_status` round-trip — both asserted over the wire.
//!
//! Skipped on non-unix targets (named-pipe windows path tested separately).

#![cfg(unix)]

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use codeg_lib::acp::delegation::broker::{
    ConversationDepthLookup, DelegationBroker, DelegationConfig,
};
use codeg_lib::acp::delegation::listener::{
    DelegationListener, ParentSessionLookup, TokenEntry, TokenRegistry,
};
use codeg_lib::acp::delegation::spawner::{mock::MockSpawner, ConnectionSpawner};
use codeg_lib::acp::delegation::transport::{
    client_ask_round_trip, client_round_trip, client_status_round_trip, BrokerAskRequest,
    BrokerRequest, BrokerStatusRequest,
};
use codeg_lib::acp::delegation::types::{DelegationError, DelegationOutcome, DelegationSuccess};
use codeg_lib::acp::question::{
    QuestionAnsweredItem, QuestionOption, QuestionOutcome, QuestionSpec, RegisteredQuestion,
    SessionQuestionAccess,
};
use codeg_lib::models::AgentType;
use serde_json::json;
use tokio::sync::oneshot;

/// A temp directory short enough to bind a socket inside, whatever the ambient
/// `$TMPDIR` happens to be.
///
/// `tempfile::tempdir()` honours `$TMPDIR`, and these tests then add
/// `/.tmpXXXXXX/codeg-e2e-*.sock` on top. That is fine against the ~20-byte
/// default and fatal against codeg's own per-session `TMPDIR`, which is 72
/// bytes: `codeg-e2e-batch.sock` composed to exactly 104 there, and `sun_path`
/// caps at 104 on macOS. Three of these tests went red inside a codeg session
/// and green outside it, for reasons having nothing to do with the code under
/// test.
///
/// Rooting in `/tmp` keeps the result near 40 bytes whatever the environment
/// says. Still unique per test: `tempdir_in` mints a fresh name.
fn socket_dir() -> tempfile::TempDir {
    tempfile::tempdir_in("/tmp").unwrap()
}

struct AlwaysRoot;
#[async_trait]
impl ConversationDepthLookup for AlwaysRoot {
    async fn parent_of(&self, _id: i32) -> Result<Option<i32>, DelegationError> {
        Ok(None)
    }
}

struct FixedParent(i32);
#[async_trait]
impl ParentSessionLookup for FixedParent {
    async fn current_conversation_id(&self, _: &str) -> Option<i32> {
        Some(self.0)
    }
}

/// No-op feedback access — this e2e suite exercises delegation, not feedback.
struct NoFeedback;
#[async_trait]
impl codeg_lib::acp::feedback::SessionFeedbackAccess for NoFeedback {
    async fn read_pending_feedback(
        &self,
        _parent_connection_id: &str,
    ) -> Vec<codeg_lib::acp::feedback::PendingFeedback> {
        Vec::new()
    }
    async fn commit_feedback_delivered(&self, _parent_connection_id: &str, _ids: Vec<String>) {}
}

/// No-op session-info access — this e2e suite never drives `get_session_info`.
struct NoSessionInfo;
#[async_trait]
impl codeg_lib::acp::session_info::SessionInfoAccess for NoSessionInfo {
    async fn resolve(
        &self,
        session_id: i32,
        _max_messages: u32,
    ) -> codeg_lib::acp::session_info::SessionInfo {
        codeg_lib::acp::session_info::SessionInfo::not_found(session_id)
    }
}

/// Task-tool stub: the e2e delegation tests never exercise the task arms.
struct NoTaskTools;
#[async_trait::async_trait]
impl codeg_lib::acp::work_task_tools::WorkTaskToolAccess for NoTaskTools {
    async fn report_progress(
        &self,
        _parent: &str,
        _message: &str,
    ) -> codeg_lib::acp::work_task_tools::TaskReportAck {
        codeg_lib::acp::work_task_tools::TaskReportAck::rejected("no engine")
    }
    async fn complete(
        &self,
        _parent: &str,
        _verdict: &str,
        _summary: Option<&str>,
    ) -> codeg_lib::acp::work_task_tools::TaskReportAck {
        codeg_lib::acp::work_task_tools::TaskReportAck::rejected("no engine")
    }
}

/// Chat-authoring stub: the e2e delegation tests never exercise the authoring
/// arms.
struct NoAuthoring;
#[async_trait::async_trait]
impl codeg_lib::acp::chat_authoring::ChatAuthoringAccess for NoAuthoring {
    async fn create_automation(
        &self,
        _ctx: codeg_lib::acp::chat_authoring::AuthoringContext,
        _spec: codeg_lib::acp::chat_authoring::NewAutomationSpec,
    ) -> codeg_lib::acp::chat_authoring::AuthoringOutcome {
        codeg_lib::acp::chat_authoring::AuthoringOutcome::rejected("automation", "no authoring")
    }
    async fn create_work_task(
        &self,
        _ctx: codeg_lib::acp::chat_authoring::AuthoringContext,
        _spec: codeg_lib::acp::chat_authoring::NewWorkTaskSpec,
    ) -> codeg_lib::acp::chat_authoring::AuthoringOutcome {
        codeg_lib::acp::chat_authoring::AuthoringOutcome::rejected("work_task", "no authoring")
    }
}

/// Controllable question access for the ask round-trip test: `register_question`
/// parks a sender keyed by a freshly-minted id; the test pops it via
/// `take_pending` and resolves it, exactly as a user answering the card would.
/// The delegation tests pass it as the 5th `DelegationListener::new` arg but
/// never trigger the ask path.
#[derive(Default)]
struct StubQuestions {
    pending: tokio::sync::Mutex<HashMap<String, (String, oneshot::Sender<QuestionOutcome>)>>,
    counter: AtomicUsize,
}

impl StubQuestions {
    /// Pop one registered-but-unanswered question's answer sender. `None` until
    /// the listener has registered the ask.
    async fn take_pending(&self) -> Option<oneshot::Sender<QuestionOutcome>> {
        let mut pending = self.pending.lock().await;
        let key = pending.keys().next().cloned()?;
        let (_id, (_parent, tx)) = pending.remove_entry(&key).unwrap();
        Some(tx)
    }
}

#[async_trait]
impl SessionQuestionAccess for StubQuestions {
    async fn register_question(
        &self,
        parent_connection_id: &str,
        _questions: Vec<QuestionSpec>,
    ) -> Option<RegisteredQuestion> {
        let question_id = format!("q{}", self.counter.fetch_add(1, Ordering::SeqCst) + 1);
        let (tx, rx) = oneshot::channel();
        self.pending
            .lock()
            .await
            .insert(question_id.clone(), (parent_connection_id.to_string(), tx));
        Some(RegisteredQuestion {
            question_id,
            answer_rx: rx,
        })
    }
    async fn cancel_question(&self, _parent_connection_id: &str, question_id: &str) {
        self.pending.lock().await.remove(question_id);
    }
    async fn cancel_questions_by_parent(&self, parent_connection_id: &str) {
        self.pending
            .lock()
            .await
            .retain(|_, (parent, _)| parent != parent_connection_id);
    }
}

#[tokio::test]
async fn end_to_end_uds_happy_path() {
    let mock = Arc::new(MockSpawner::new());
    mock.queue_spawn(Ok("child-conn-1".into())).await;
    mock.queue_send(Ok(77)).await;

    let broker = Arc::new(DelegationBroker::new(
        mock.clone() as Arc<dyn ConnectionSpawner>,
        Arc::new(AlwaysRoot) as Arc<dyn ConversationDepthLookup>,
    ));
    broker
        .set_config(DelegationConfig {
            enabled: true,
            depth_limit: 8,
            ..DelegationConfig::default()
        })
        .await;

    let tokens = Arc::new(TokenRegistry::default());
    tokens
        .register(
            "tok".into(),
            TokenEntry {
                parent_connection_id: "p1".into(),
                working_dir: PathBuf::from("/tmp"),
            },
        )
        .await;

    let listener = DelegationListener::new(
        broker.clone(),
        tokens,
        Arc::new(FixedParent(1)) as Arc<dyn ParentSessionLookup>,
        Arc::new(NoFeedback) as Arc<dyn codeg_lib::acp::feedback::SessionFeedbackAccess>,
        Arc::new(StubQuestions::default()) as Arc<dyn SessionQuestionAccess>,
        Arc::new(NoSessionInfo) as Arc<dyn codeg_lib::acp::session_info::SessionInfoAccess>,
        Arc::new(NoTaskTools) as Arc<dyn codeg_lib::acp::work_task_tools::WorkTaskToolAccess>,
        Arc::new(NoAuthoring) as Arc<dyn codeg_lib::acp::chat_authoring::ChatAuthoringAccess>,
        Arc::new(codeg_lib::acp::browser_tools::NoBrowserTabs)
            as Arc<dyn codeg_lib::acp::browser_tools::BrowserToolAccess>,
    );

    // Freshly-named directory per test — no clashes across test bins.
    let dir = socket_dir();
    let socket = dir.path().join("codeg-e2e.sock");
    let socket_for_listener = socket.clone();
    let listener_task = tokio::spawn(async move {
        let _ = listener.run(socket_for_listener).await;
    });

    // Spin until the socket is bound and ready to accept.
    for _ in 0..50 {
        if socket.exists() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert!(socket.exists(), "listener never bound the socket");

    // 1. delegate_to_agent → Running ack carrying the child conversation id and
    //    a task_id to follow up on. Under the async protocol the call returns
    //    immediately instead of blocking for the result.
    let req = BrokerRequest {
        token: "tok".into(),
        parent_connection_id: "p1".into(),
        parent_tool_use_id: "pt-1".into(),
        external_handle: None,
        input: json!({"agent_type": "codex", "task": "do x"}),
    };
    let ack = client_round_trip(&socket.to_string_lossy(), &req)
        .await
        .expect("client round-trip");
    assert_eq!(ack.outcome["status"], "running");
    assert_eq!(ack.outcome["child_conversation_id"], 77);
    let task_id = ack.outcome["task_id"]
        .as_str()
        .expect("running ack carries a task_id")
        .to_string();

    // 2. The lifecycle resolves the child on TurnComplete. The ack already
    //    returned, so the task is registered and `complete_call` migrates it to
    //    completed deterministically — no race against registration.
    broker
        .complete_call(
            &task_id,
            DelegationOutcome::Ok(DelegationSuccess {
                text: "uds-result".into(),
                child_conversation_id: 77,
                child_agent_type: AgentType::Codex,
                turn_count: 1,
                duration_ms: 12,
                token_usage: None,
            }),
        )
        .await;

    // 3. get_delegation_status → Completed with the result text, over the wire.
    //    The Status arm returns a `{ tasks: [..] }` envelope; one id → one entry.
    let status_req = BrokerStatusRequest {
        token: "tok".into(),
        task_ids: vec![task_id],
        wait_ms: Some(1_000),
    };
    let resp = client_status_round_trip(&socket.to_string_lossy(), &status_req)
        .await
        .expect("status round-trip");
    listener_task.abort();

    assert_eq!(resp.outcome["tasks"][0]["status"], "completed");
    assert_eq!(resp.outcome["tasks"][0]["text"], "uds-result");
    assert_eq!(resp.outcome["tasks"][0]["child_conversation_id"], 77);
}

/// Batch `get_delegation_status` over the wire: two delegations are started,
/// one completes, and a single status round-trip with `task_ids: [t1, t2]`
/// returns both reports in request order — `t1` completed, `t2` still running.
#[tokio::test]
async fn end_to_end_uds_batch_status() {
    let mock = Arc::new(MockSpawner::new());
    // Two children: first resolves to conv 77, second to conv 88.
    mock.queue_spawn(Ok("child-conn-1".into())).await;
    mock.queue_send(Ok(77)).await;
    mock.queue_spawn(Ok("child-conn-2".into())).await;
    mock.queue_send(Ok(88)).await;

    let broker = Arc::new(DelegationBroker::new(
        mock.clone() as Arc<dyn ConnectionSpawner>,
        Arc::new(AlwaysRoot) as Arc<dyn ConversationDepthLookup>,
    ));
    broker
        .set_config(DelegationConfig {
            enabled: true,
            depth_limit: 8,
            ..DelegationConfig::default()
        })
        .await;

    let tokens = Arc::new(TokenRegistry::default());
    tokens
        .register(
            "tok".into(),
            TokenEntry {
                parent_connection_id: "p1".into(),
                working_dir: PathBuf::from("/tmp"),
            },
        )
        .await;

    let listener = DelegationListener::new(
        broker.clone(),
        tokens,
        Arc::new(FixedParent(1)) as Arc<dyn ParentSessionLookup>,
        Arc::new(NoFeedback) as Arc<dyn codeg_lib::acp::feedback::SessionFeedbackAccess>,
        Arc::new(StubQuestions::default()) as Arc<dyn SessionQuestionAccess>,
        Arc::new(NoSessionInfo) as Arc<dyn codeg_lib::acp::session_info::SessionInfoAccess>,
        Arc::new(NoTaskTools) as Arc<dyn codeg_lib::acp::work_task_tools::WorkTaskToolAccess>,
        Arc::new(NoAuthoring) as Arc<dyn codeg_lib::acp::chat_authoring::ChatAuthoringAccess>,
        Arc::new(codeg_lib::acp::browser_tools::NoBrowserTabs)
            as Arc<dyn codeg_lib::acp::browser_tools::BrowserToolAccess>,
    );

    let dir = socket_dir();
    let socket = dir.path().join("codeg-e2e-batch.sock");
    let socket_for_listener = socket.clone();
    let listener_task = tokio::spawn(async move {
        let _ = listener.run(socket_for_listener).await;
    });
    for _ in 0..50 {
        if socket.exists() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert!(socket.exists(), "listener never bound the socket");

    // Start two delegations; capture each task_id from its Running ack.
    let mut task_ids = Vec::new();
    for task in ["do x", "do y"] {
        let req = BrokerRequest {
            token: "tok".into(),
            parent_connection_id: "p1".into(),
            parent_tool_use_id: format!("pt-{task}"),
            external_handle: None,
            input: json!({ "agent_type": "codex", "task": task }),
        };
        let ack = client_round_trip(&socket.to_string_lossy(), &req)
            .await
            .expect("client round-trip");
        assert_eq!(ack.outcome["status"], "running");
        task_ids.push(ack.outcome["task_id"].as_str().unwrap().to_string());
    }

    // Resolve only the FIRST task.
    broker
        .complete_call(
            &task_ids[0],
            DelegationOutcome::Ok(DelegationSuccess {
                text: "first-result".into(),
                child_conversation_id: 77,
                child_agent_type: AgentType::Codex,
                turn_count: 1,
                duration_ms: 9,
                token_usage: None,
            }),
        )
        .await;

    // Immediate batch poll → both reports, in request order.
    let status_req = BrokerStatusRequest {
        token: "tok".into(),
        task_ids: task_ids.clone(),
        wait_ms: None,
    };
    let resp = client_status_round_trip(&socket.to_string_lossy(), &status_req)
        .await
        .expect("batch status round-trip");
    listener_task.abort();

    let tasks = resp.outcome["tasks"]
        .as_array()
        .expect("batch status returns a tasks array");
    assert_eq!(tasks.len(), 2);
    assert_eq!(tasks[0]["status"], "completed");
    assert_eq!(tasks[0]["text"], "first-result");
    assert_eq!(tasks[0]["task_id"], task_ids[0].as_str());
    assert_eq!(tasks[1]["status"], "running");
    assert_eq!(tasks[1]["task_id"], task_ids[1].as_str());
}

#[tokio::test]
async fn end_to_end_uds_invalid_token_rejected() {
    let mock = Arc::new(MockSpawner::new());
    // No queued spawn — listener should reject before reaching broker.
    let broker = Arc::new(DelegationBroker::new(
        mock as Arc<dyn ConnectionSpawner>,
        Arc::new(AlwaysRoot) as Arc<dyn ConversationDepthLookup>,
    ));
    let tokens = Arc::new(TokenRegistry::default());
    let listener = DelegationListener::new(
        broker,
        tokens,
        Arc::new(FixedParent(1)) as Arc<dyn ParentSessionLookup>,
        Arc::new(NoFeedback) as Arc<dyn codeg_lib::acp::feedback::SessionFeedbackAccess>,
        Arc::new(StubQuestions::default()) as Arc<dyn SessionQuestionAccess>,
        Arc::new(NoSessionInfo) as Arc<dyn codeg_lib::acp::session_info::SessionInfoAccess>,
        Arc::new(NoTaskTools) as Arc<dyn codeg_lib::acp::work_task_tools::WorkTaskToolAccess>,
        Arc::new(NoAuthoring) as Arc<dyn codeg_lib::acp::chat_authoring::ChatAuthoringAccess>,
        Arc::new(codeg_lib::acp::browser_tools::NoBrowserTabs)
            as Arc<dyn codeg_lib::acp::browser_tools::BrowserToolAccess>,
    );

    let dir = socket_dir();
    let socket = dir.path().join("codeg-e2e-reject.sock");
    let socket_for_listener = socket.clone();
    let listener_task = tokio::spawn(async move {
        let _ = listener.run(socket_for_listener).await;
    });

    for _ in 0..50 {
        if socket.exists() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }

    let req = BrokerRequest {
        token: "wrong-token".into(),
        parent_connection_id: "p1".into(),
        parent_tool_use_id: "pt-1".into(),
        external_handle: None,
        input: json!({"agent_type": "codex", "task": "x"}),
    };
    let resp = client_round_trip(&socket.to_string_lossy(), &req)
        .await
        .expect("client round-trip");
    listener_task.abort();

    assert_eq!(resp.outcome["status"], "canceled");
    assert_eq!(resp.outcome["error_code"], "canceled");
}

/// End-to-end ask: a companion-style client sends an `ask_user_question` frame
/// over the real UDS socket; the listener resolves the token to its parent,
/// registers the question through `SessionQuestionAccess`, and parks. The test
/// answers via the parked sender (as a user submitting the card would), and the
/// blocked client round-trip returns the self-describing outcome over the wire.
#[tokio::test]
async fn end_to_end_uds_ask_question_round_trip() {
    let mock = Arc::new(MockSpawner::new());
    let broker = Arc::new(DelegationBroker::new(
        mock as Arc<dyn ConnectionSpawner>,
        Arc::new(AlwaysRoot) as Arc<dyn ConversationDepthLookup>,
    ));
    // The Ask arm doesn't gate on delegation config, so no set_config is needed.

    let tokens = Arc::new(TokenRegistry::default());
    tokens
        .register(
            "tok".into(),
            TokenEntry {
                parent_connection_id: "p1".into(),
                working_dir: PathBuf::from("/tmp"),
            },
        )
        .await;

    let questions = Arc::new(StubQuestions::default());
    let listener = DelegationListener::new(
        broker.clone(),
        tokens,
        Arc::new(FixedParent(1)) as Arc<dyn ParentSessionLookup>,
        Arc::new(NoFeedback) as Arc<dyn codeg_lib::acp::feedback::SessionFeedbackAccess>,
        questions.clone() as Arc<dyn SessionQuestionAccess>,
        Arc::new(NoSessionInfo) as Arc<dyn codeg_lib::acp::session_info::SessionInfoAccess>,
        Arc::new(NoTaskTools) as Arc<dyn codeg_lib::acp::work_task_tools::WorkTaskToolAccess>,
        Arc::new(NoAuthoring) as Arc<dyn codeg_lib::acp::chat_authoring::ChatAuthoringAccess>,
        Arc::new(codeg_lib::acp::browser_tools::NoBrowserTabs)
            as Arc<dyn codeg_lib::acp::browser_tools::BrowserToolAccess>,
    );

    let dir = socket_dir();
    let socket = dir.path().join("codeg-e2e-ask.sock");
    let socket_for_listener = socket.clone();
    let listener_task = tokio::spawn(async move {
        let _ = listener.run(socket_for_listener).await;
    });
    for _ in 0..50 {
        if socket.exists() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert!(socket.exists(), "listener never bound the socket");

    // Companion side: blocks on the ask round-trip until the user answers.
    let socket_str = socket.to_string_lossy().to_string();
    let ask_task = tokio::spawn(async move {
        let req = BrokerAskRequest {
            token: "tok".into(),
            questions: vec![QuestionSpec {
                id: "qa".into(),
                question: "Which approach?".into(),
                header: "Approach".into(),
                multi_select: false,
                options: vec![
                    QuestionOption {
                        label: "A".into(),
                        description: String::new(),
                    },
                    QuestionOption {
                        label: "B".into(),
                        description: String::new(),
                    },
                ],
                is_secret: false,
            }],
        };
        client_ask_round_trip(&socket_str, &req).await
    });

    // User side: wait (bounded) for the listener to register, then answer "A".
    let mut sender = None;
    for _ in 0..200 {
        if let Some(tx) = questions.take_pending().await {
            sender = Some(tx);
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let sender = sender.expect("listener registered the question");
    sender
        .send(QuestionOutcome {
            answers: vec![QuestionAnsweredItem {
                question: "Which approach?".into(),
                header: "Approach".into(),
                multi_select: false,
                selected: vec!["A".into()],
            }],
            declined: false,
        })
        .expect("listener still parked on the answer");

    let resp = ask_task
        .await
        .expect("ask task joined")
        .expect("ask round-trip");
    listener_task.abort();

    assert_eq!(resp.outcome["declined"], false);
    assert_eq!(resp.outcome["answers"][0]["question"], "Which approach?");
    assert_eq!(resp.outcome["answers"][0]["selected"][0], "A");
}

/// Teardown race: an Ask passes token lookup, then the parent is revoked + swept
/// before the question parks. The listener's post-register token re-check must
/// catch the now-revoked token and decline rather than leave the ask lingering.
/// The stub revokes the token AT register time, forcing the race deterministically
/// (no sleeps): `ask_target` sees a valid token, `register_question` revokes it,
/// the re-check finds it gone → declined.
#[tokio::test]
async fn end_to_end_uds_ask_revoked_after_register_declines() {
    struct RevokingQuestions {
        inner: StubQuestions,
        tokens: Arc<TokenRegistry>,
        token: String,
    }
    #[async_trait]
    impl SessionQuestionAccess for RevokingQuestions {
        async fn register_question(
            &self,
            parent_connection_id: &str,
            questions: Vec<QuestionSpec>,
        ) -> Option<RegisteredQuestion> {
            // Simulate the teardown sweep racing in between ask_target and parking.
            self.tokens.revoke(&self.token).await;
            self.inner
                .register_question(parent_connection_id, questions)
                .await
        }
        async fn cancel_question(&self, parent_connection_id: &str, question_id: &str) {
            self.inner
                .cancel_question(parent_connection_id, question_id)
                .await
        }
        async fn cancel_questions_by_parent(&self, parent_connection_id: &str) {
            self.inner.cancel_questions_by_parent(parent_connection_id).await
        }
    }

    let mock = Arc::new(MockSpawner::new());
    let broker = Arc::new(DelegationBroker::new(
        mock as Arc<dyn ConnectionSpawner>,
        Arc::new(AlwaysRoot) as Arc<dyn ConversationDepthLookup>,
    ));
    let tokens = Arc::new(TokenRegistry::default());
    tokens
        .register(
            "tok".into(),
            TokenEntry {
                parent_connection_id: "p1".into(),
                working_dir: PathBuf::from("/tmp"),
            },
        )
        .await;

    let questions = Arc::new(RevokingQuestions {
        inner: StubQuestions::default(),
        tokens: tokens.clone(),
        token: "tok".into(),
    });
    let listener = DelegationListener::new(
        broker.clone(),
        tokens.clone(),
        Arc::new(FixedParent(1)) as Arc<dyn ParentSessionLookup>,
        Arc::new(NoFeedback) as Arc<dyn codeg_lib::acp::feedback::SessionFeedbackAccess>,
        questions as Arc<dyn SessionQuestionAccess>,
        Arc::new(NoSessionInfo) as Arc<dyn codeg_lib::acp::session_info::SessionInfoAccess>,
        Arc::new(NoTaskTools) as Arc<dyn codeg_lib::acp::work_task_tools::WorkTaskToolAccess>,
        Arc::new(NoAuthoring) as Arc<dyn codeg_lib::acp::chat_authoring::ChatAuthoringAccess>,
        Arc::new(codeg_lib::acp::browser_tools::NoBrowserTabs)
            as Arc<dyn codeg_lib::acp::browser_tools::BrowserToolAccess>,
    );

    let dir = socket_dir();
    let socket = dir.path().join("codeg-e2e-ask-revoked.sock");
    let socket_for_listener = socket.clone();
    let listener_task = tokio::spawn(async move {
        let _ = listener.run(socket_for_listener).await;
    });
    for _ in 0..50 {
        if socket.exists() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert!(socket.exists(), "listener never bound the socket");

    let req = BrokerAskRequest {
        token: "tok".into(),
        questions: vec![QuestionSpec {
            id: "qa".into(),
            question: "Which approach?".into(),
            header: "Approach".into(),
            multi_select: false,
            options: vec![
                QuestionOption {
                    label: "A".into(),
                    description: String::new(),
                },
                QuestionOption {
                    label: "B".into(),
                    description: String::new(),
                },
            ],
            is_secret: false,
        }],
    };
    let resp = client_ask_round_trip(&socket.to_string_lossy(), &req)
        .await
        .expect("ask round-trip");
    listener_task.abort();

    // The re-check found the revoked token → declined, not a parked/hung ask.
    assert_eq!(resp.outcome["declined"], true);
}
