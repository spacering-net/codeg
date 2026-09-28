//! Windows counterpart to `delegation_e2e_uds.rs`: drive a real named-pipe
//! round-trip through the listener → broker → mock spawner → `complete_call`
//! chain. Guards against regressions like generating a temp-file path
//! instead of a `\\.\pipe\...` address, or dropping the server instance
//! between accepts.

#![cfg(windows)]

use std::path::PathBuf;
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
    client_round_trip, client_status_round_trip, BrokerRequest, BrokerResponse, BrokerStatusRequest,
};
use codeg_lib::acp::delegation::types::{DelegationError, DelegationOutcome, DelegationSuccess};
use codeg_lib::acp::question::{QuestionSpec, RegisteredQuestion, SessionQuestionAccess};
use codeg_lib::models::AgentType;
use serde_json::json;

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

/// No-op question access — this e2e suite exercises delegation, not asks.
struct NoQuestions;
#[async_trait]
impl SessionQuestionAccess for NoQuestions {
    async fn register_question(
        &self,
        _parent_connection_id: &str,
        _questions: Vec<QuestionSpec>,
    ) -> Option<RegisteredQuestion> {
        None
    }
    async fn cancel_question(&self, _parent_connection_id: &str, _question_id: &str) {}
    async fn cancel_questions_by_parent(&self, _parent_connection_id: &str) {}
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
#[async_trait]
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
#[async_trait]
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

fn unique_pipe(tag: &str) -> String {
    format!(
        r"\\.\pipe\codeg-e2e-{}-{}-{}",
        tag,
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or_default()
    )
}

/// Named pipes aren't file paths, so we can't `Path::exists` them. Retry the
/// round-trip a few times to ride out the brief window before the listener
/// task creates its first server instance.
async fn client_round_trip_with_retry(
    pipe: &str,
    req: &BrokerRequest,
) -> std::io::Result<BrokerResponse> {
    let mut last_err = None;
    for _ in 0..50 {
        match client_round_trip(pipe, req).await {
            Ok(resp) => return Ok(resp),
            Err(e) => {
                last_err = Some(e);
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        }
    }
    Err(last_err.unwrap_or_else(|| std::io::Error::other("client_round_trip retries exhausted")))
}

/// `client_round_trip_with_retry` for the `get_delegation_status` follow-up
/// (collects the terminal result under the async protocol).
async fn client_status_round_trip_with_retry(
    pipe: &str,
    req: &BrokerStatusRequest,
) -> std::io::Result<BrokerResponse> {
    let mut last_err = None;
    for _ in 0..50 {
        match client_status_round_trip(pipe, req).await {
            Ok(resp) => return Ok(resp),
            Err(e) => {
                last_err = Some(e);
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        }
    }
    Err(last_err
        .unwrap_or_else(|| std::io::Error::other("client_status_round_trip retries exhausted")))
}

#[tokio::test]
async fn end_to_end_named_pipe_happy_path() {
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
                working_dir: PathBuf::from(r"C:\Windows\Temp"),
            },
        )
        .await;

    let listener = DelegationListener::new(
        broker.clone(),
        tokens,
        Arc::new(FixedParent(1)) as Arc<dyn ParentSessionLookup>,
        Arc::new(NoFeedback) as Arc<dyn codeg_lib::acp::feedback::SessionFeedbackAccess>,
        Arc::new(NoQuestions) as Arc<dyn SessionQuestionAccess>,
        Arc::new(NoSessionInfo) as Arc<dyn codeg_lib::acp::session_info::SessionInfoAccess>,
        Arc::new(NoTaskTools) as Arc<dyn codeg_lib::acp::work_task_tools::WorkTaskToolAccess>,
        Arc::new(NoAuthoring) as Arc<dyn codeg_lib::acp::chat_authoring::ChatAuthoringAccess>,
        Arc::new(codeg_lib::acp::browser_tools::NoBrowserTabs)
            as Arc<dyn codeg_lib::acp::browser_tools::BrowserToolAccess>,
    );

    let pipe = unique_pipe("happy");
    let pipe_for_listener = PathBuf::from(&pipe);
    let listener_task = tokio::spawn(async move {
        let _ = listener.run(pipe_for_listener).await;
    });

    // 1. delegate_to_agent → Running ack carrying the child conversation id and
    //    a task_id to follow up on.
    let req = BrokerRequest {
        token: "tok".into(),
        parent_connection_id: "p1".into(),
        parent_tool_use_id: "pt-1".into(),
        external_handle: None,
        input: json!({"agent_type": "codex", "task": "do x"}),
    };
    let ack = client_round_trip_with_retry(&pipe, &req)
        .await
        .expect("client round-trip");
    assert_eq!(ack.outcome["status"], "running");
    assert_eq!(ack.outcome["child_conversation_id"], 77);
    let task_id = ack.outcome["task_id"]
        .as_str()
        .expect("running ack carries a task_id")
        .to_string();

    // 2. The lifecycle resolves the child on TurnComplete; the task is already
    //    registered, so complete_call migrates it to completed deterministically.
    broker
        .complete_call(
            &task_id,
            DelegationOutcome::Ok(DelegationSuccess {
                text: "pipe-result".into(),
                child_conversation_id: 77,
                child_agent_type: AgentType::Codex,
                turn_count: 1,
                duration_ms: 12,
                token_usage: None,
            }),
        )
        .await;

    // 3. get_delegation_status → Completed with the result text, over the pipe.
    //    The Status arm returns a `{ tasks: [..] }` envelope; one id → one entry.
    let status_req = BrokerStatusRequest {
        token: "tok".into(),
        task_ids: vec![task_id],
        wait_ms: Some(1_000),
    };
    let resp = client_status_round_trip_with_retry(&pipe, &status_req)
        .await
        .expect("status round-trip");
    listener_task.abort();

    assert_eq!(resp.outcome["tasks"][0]["status"], "completed");
    assert_eq!(resp.outcome["tasks"][0]["text"], "pipe-result");
    assert_eq!(resp.outcome["tasks"][0]["child_conversation_id"], 77);
}

#[tokio::test]
async fn end_to_end_named_pipe_back_to_back_requests() {
    // Two sequential round-trips against the same listener. If the Windows
    // accept loop ever regresses to "create server only after handling a
    // connection", the second call will race against a missing pipe and the
    // client will see "system cannot find the file specified".
    let mock = Arc::new(MockSpawner::new());
    mock.queue_spawn(Ok("child-1".into())).await;
    mock.queue_send(Ok(1)).await;
    mock.queue_spawn(Ok("child-2".into())).await;
    mock.queue_send(Ok(2)).await;

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
                working_dir: PathBuf::from(r"C:\Windows\Temp"),
            },
        )
        .await;
    let listener = DelegationListener::new(
        broker.clone(),
        tokens,
        Arc::new(FixedParent(1)) as Arc<dyn ParentSessionLookup>,
        Arc::new(NoFeedback) as Arc<dyn codeg_lib::acp::feedback::SessionFeedbackAccess>,
        Arc::new(NoQuestions) as Arc<dyn SessionQuestionAccess>,
        Arc::new(NoSessionInfo) as Arc<dyn codeg_lib::acp::session_info::SessionInfoAccess>,
        Arc::new(NoTaskTools) as Arc<dyn codeg_lib::acp::work_task_tools::WorkTaskToolAccess>,
        Arc::new(NoAuthoring) as Arc<dyn codeg_lib::acp::chat_authoring::ChatAuthoringAccess>,
        Arc::new(codeg_lib::acp::browser_tools::NoBrowserTabs)
            as Arc<dyn codeg_lib::acp::browser_tools::BrowserToolAccess>,
    );

    let pipe = unique_pipe("repeat");
    let pipe_for_listener = PathBuf::from(&pipe);
    let listener_task = tokio::spawn(async move {
        let _ = listener.run(pipe_for_listener).await;
    });

    // A completer that resolves each call as it's registered.
    let broker_for_completion = broker.clone();
    let completer = tokio::spawn(async move {
        let mut completed = 0;
        while completed < 2 {
            if let Some(call_id) = broker_for_completion.peek_first_pending_call_id().await {
                broker_for_completion
                    .complete_call(
                        &call_id,
                        DelegationOutcome::Ok(DelegationSuccess {
                            text: format!("done-{completed}"),
                            child_conversation_id: completed + 1,
                            child_agent_type: AgentType::Codex,
                            turn_count: 1,
                            duration_ms: 5,
                            token_usage: None,
                        }),
                    )
                    .await;
                completed += 1;
            } else {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        }
    });

    for i in 0..2 {
        let req = BrokerRequest {
            token: "tok".into(),
            parent_connection_id: "p1".into(),
            parent_tool_use_id: format!("pt-{i}"),
            external_handle: None,
            input: json!({"agent_type": "codex", "task": "x"}),
        };
        let resp = client_round_trip_with_retry(&pipe, &req)
            .await
            .unwrap_or_else(|e| panic!("round-trip {i} failed: {e}"));
        // Async protocol: each call returns a Running ack (the completer
        // resolves the task afterward). The point of this test is the pipe
        // re-accepting a second connection, not the terminal shape.
        assert_eq!(resp.outcome["status"], "running", "round-trip {i}");
    }

    completer.await.unwrap();
    listener_task.abort();
}
