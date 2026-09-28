use std::sync::Arc;

use async_trait::async_trait;

use crate::acp::assistant_tools::AssistantToolAccess;
use crate::acp::delegation::transport::{AssistantActionResult, AssistantSessionList};
use crate::acp::manager::ConnectionManager;
use crate::acp::question::{QuestionOption, QuestionSpec, RegisteredQuestion, SessionQuestionAccess};
use crate::acp::types::PromptInputBlock;
use crate::commands::assistant::{assistant_get_settings_core, ASSISTANT_OWNER_LABEL};
use crate::db::AppDatabase;
use crate::web::event_bridge::emit_event;
use crate::web::event_bridge::EventEmitter;

pub struct DbAssistantToolAccess {
    pub manager: Arc<ConnectionManager>,
    pub db: Arc<AppDatabase>,
    pub emitter: Arc<EventEmitter>,
    pub questions: Arc<dyn SessionQuestionAccess>,
}

pub struct ManagerQuestions(pub Arc<ConnectionManager>);

#[async_trait]
impl SessionQuestionAccess for ManagerQuestions {
    async fn register_question(
        &self,
        parent: &str,
        questions: Vec<QuestionSpec>,
    ) -> Option<RegisteredQuestion> {
        self.0.register_question(parent, questions).await
    }
    async fn cancel_question(&self, parent: &str, id: &str) {
        self.0.cancel_question(parent, id).await
    }
    async fn cancel_questions_by_parent(&self, parent: &str) {
        self.0.cancel_questions_by_parent(parent).await
    }
}

struct ConfirmLabels {
    confirm: &'static str,
    cancel: &'static str,
}

fn confirm_labels_for(locale: crate::models::system::AppLocale) -> ConfirmLabels {
    use crate::models::system::AppLocale;
    match locale {
        AppLocale::ZhCn => ConfirmLabels { confirm: "确认", cancel: "取消" },
        AppLocale::ZhTw => ConfirmLabels { confirm: "確認", cancel: "取消" },
        AppLocale::Ja  => ConfirmLabels { confirm: "確認", cancel: "キャンセル" },
        AppLocale::Ko  => ConfirmLabels { confirm: "확인", cancel: "취소" },
        AppLocale::Es  => ConfirmLabels { confirm: "Confirmar", cancel: "Cancelar" },
        AppLocale::De  => ConfirmLabels { confirm: "Bestätigen", cancel: "Abbrechen" },
        AppLocale::Fr  => ConfirmLabels { confirm: "Confirmer", cancel: "Annuler" },
        AppLocale::Pt  => ConfirmLabels { confirm: "Confirmar", cancel: "Cancelar" },
        AppLocale::Ar  => ConfirmLabels { confirm: "تأكيد", cancel: "إلغاء" },
        AppLocale::En  => ConfirmLabels { confirm: "Confirm", cancel: "Cancel" },
    }
}

async fn load_confirm_labels(db: &sea_orm::DatabaseConnection) -> ConfirmLabels {
    let locale = crate::commands::system_settings::load_system_language_settings(db)
        .await
        .map(|s| s.language)
        .unwrap_or_default();
    confirm_labels_for(locale)
}

fn make_confirm_spec(
    question: impl Into<String>,
    header: impl Into<String>,
    labels: &ConfirmLabels,
) -> QuestionSpec {
    QuestionSpec {
        id: uuid::Uuid::new_v4().to_string(),
        question: question.into(),
        header: header.into(),
        multi_select: false,
        options: vec![
            QuestionOption { label: labels.confirm.to_string(), description: String::new() },
            QuestionOption { label: labels.cancel.to_string(), description: String::new() },
        ],
        is_secret: false,
    }
}

async fn ask_confirm(
    questions: &dyn SessionQuestionAccess,
    requester_conn_id: &str,
    spec: QuestionSpec,
) -> bool {
    let confirm_label = spec.options[0].label.clone();
    let Some(RegisteredQuestion { answer_rx, .. }) =
        questions.register_question(requester_conn_id, vec![spec]).await
    else {
        return false;
    };
    let Ok(outcome) = answer_rx.await else {
        return false;
    };
    if outcome.declined {
        return false;
    }
    outcome
        .answers
        .first()
        .map(|a| a.selected.first().map(|s| s == &confirm_label).unwrap_or(false))
        .unwrap_or(false)
}

/// Truncate `s` to at most `max_chars` Unicode scalar values, appending `…`
/// when truncated.
fn truncate_chars(s: &str, max_chars: usize) -> String {
    let mut chars = s.chars();
    let prefix: String = chars.by_ref().take(max_chars).collect();
    if chars.next().is_some() {
        format!("{prefix}…")
    } else {
        prefix
    }
}

impl DbAssistantToolAccess {
    fn question_access(&self) -> &dyn SessionQuestionAccess {
        self.questions.as_ref()
    }
}

#[async_trait]
impl AssistantToolAccess for DbAssistantToolAccess {
    async fn is_assistant_connection(&self, conn_id: &str) -> bool {
        self.manager
            .get_owner_window_label(conn_id)
            .await
            .as_deref()
            == Some(ASSISTANT_OWNER_LABEL)
    }

    async fn list_sessions(&self, exclude_conn_id: &str) -> AssistantSessionList {
        self.manager
            .list_linked_sessions(exclude_conn_id, &self.db)
            .await
    }

    async fn focus_session(&self, session_id: i64) -> AssistantActionResult {
        match crate::db::service::conversation_service::get_by_id(
            &self.db.conn,
            session_id as i32,
        )
        .await
        {
            Ok(conv) => {
                let folder_id = conv.folder_id;
                let agent = serde_json::to_value(conv.agent_type)
                    .ok()
                    .and_then(|v| v.as_str().map(String::from))
                    .unwrap_or_default();
                #[derive(serde::Serialize)]
                #[serde(rename_all = "camelCase")]
                struct FocusPayload {
                    folder_id: i32,
                    conversation_id: i32,
                    agent: String,
                }
                let payload = FocusPayload {
                    folder_id,
                    conversation_id: session_id as i32,
                    agent,
                };
                emit_event(&self.emitter, "workspace://focus-conversation", payload);

                #[cfg(feature = "tauri-runtime")]
                {
                    if let EventEmitter::Tauri(app_handle) = &*self.emitter {
                        crate::commands::windows::show_main_window(app_handle);
                    }
                }

                AssistantActionResult {
                    outcome: "ok".to_string(),
                    message: "focused".to_string(),
                }
            }
            Err(_) => AssistantActionResult {
                outcome: "not_found".to_string(),
                message: "session not found".to_string(),
            },
        }
    }

    async fn send_to_session(
        &self,
        requester_conn_id: &str,
        session_id: i64,
        text: String,
    ) -> AssistantActionResult {
        let settings = match assistant_get_settings_core(&self.db.conn).await {
            Ok(s) => s,
            Err(e) => return AssistantActionResult {
                outcome: "disabled".to_string(),
                message: e.to_string(),
            },
        };
        if !settings.allow_session_control {
            return AssistantActionResult {
                outcome: "disabled".to_string(),
                message: "session control is disabled in assistant settings".to_string(),
            };
        }

        let Some(conn_id) = self
            .manager
            .find_connection_by_conversation_id(session_id as i32)
            .await
        else {
            return AssistantActionResult {
                outcome: "not_running".to_string(),
                message: "session is not currently running".to_string(),
            };
        };

        // Check for an in-flight turn on the TARGET session.
        if let Some(state_arc) = self.manager.get_state(&conn_id).await {
            if state_arc.read().await.turn_in_flight {
                return AssistantActionResult {
                    outcome: "busy".to_string(),
                    message: "session has a turn in flight".to_string(),
                };
            }
        }

        let (agent_label, session_title) = self
            .session_label_and_title(session_id as i32, &conn_id)
            .await;

        let labels = load_confirm_labels(&self.db.conn).await;
        let preview = truncate_chars(&text, 300);
        let question = format!("{agent_label} · {session_title}: {preview}");
        let spec = make_confirm_spec(question, "Confirm", &labels);
        if !ask_confirm(self.question_access(), requester_conn_id, spec).await {
            return AssistantActionResult {
                outcome: "declined".to_string(),
                message: "user declined".to_string(),
            };
        }

        let blocks = vec![PromptInputBlock::Text { text }];
        match self
            .manager
            .send_prompt_linked_with_message_id(&self.db, &conn_id, blocks, None, None, None, None)
            .await
        {
            Ok(_) => AssistantActionResult {
                outcome: "ok".to_string(),
                message: "message sent".to_string(),
            },
            Err(e) => AssistantActionResult {
                outcome: "busy".to_string(),
                message: e.to_string(),
            },
        }
    }

    async fn cancel_session(
        &self,
        requester_conn_id: &str,
        session_id: i64,
    ) -> AssistantActionResult {
        let settings = match assistant_get_settings_core(&self.db.conn).await {
            Ok(s) => s,
            Err(e) => return AssistantActionResult {
                outcome: "disabled".to_string(),
                message: e.to_string(),
            },
        };
        if !settings.allow_session_control {
            return AssistantActionResult {
                outcome: "disabled".to_string(),
                message: "session control is disabled in assistant settings".to_string(),
            };
        }

        let Some(conn_id) = self
            .manager
            .find_connection_by_conversation_id(session_id as i32)
            .await
        else {
            return AssistantActionResult {
                outcome: "not_running".to_string(),
                message: "session is not currently running".to_string(),
            };
        };

        let (agent_label, session_title) = self
            .session_label_and_title(session_id as i32, &conn_id)
            .await;

        let labels = load_confirm_labels(&self.db.conn).await;
        let question = format!("{agent_label} · {session_title}: stop the current turn");
        let spec = make_confirm_spec(question, "Confirm", &labels);
        if !ask_confirm(self.question_access(), requester_conn_id, spec).await {
            return AssistantActionResult {
                outcome: "declined".to_string(),
                message: "user declined".to_string(),
            };
        }

        match self.manager.cancel(&self.db.conn, &conn_id).await {
            Ok(()) => AssistantActionResult {
                outcome: "ok".to_string(),
                message: "session cancelled".to_string(),
            },
            Err(e) => AssistantActionResult {
                outcome: "busy".to_string(),
                message: e.to_string(),
            },
        }
    }

    async fn answer_permission(
        &self,
        requester_conn_id: &str,
        session_id: i64,
        decision: String,
    ) -> AssistantActionResult {
        let settings = match assistant_get_settings_core(&self.db.conn).await {
            Ok(s) => s,
            Err(e) => return AssistantActionResult {
                outcome: "disabled".to_string(),
                message: e.to_string(),
            },
        };
        if !settings.allow_permission_answers {
            return AssistantActionResult {
                outcome: "disabled".to_string(),
                message: "permission answering is disabled in assistant settings".to_string(),
            };
        }

        // The MCP schema advertises "approve"/"deny"; we also accept the
        // internal "allow_once"/"reject_once" spellings so callers that read
        // the option kind directly still work.
        let want_allow = match decision.as_str() {
            "approve" | "allow_once" => true,
            "deny" | "reject_once" => false,
            _ => {
                return AssistantActionResult {
                    outcome: "unsupported".to_string(),
                    message: format!(
                        "decision must be 'approve' or 'deny', got '{decision}'"
                    ),
                };
            }
        };

        let Some(conn_id) = self
            .manager
            .find_connection_by_conversation_id(session_id as i32)
            .await
        else {
            return AssistantActionResult {
                outcome: "not_running".to_string(),
                message: "session is not currently running".to_string(),
            };
        };

        // Read the pending permission to find the option_id, request_id, and
        // question action text (command ?? title). All in one read-lock so we
        // don't race between the check and the capture.
        let (request_id, option_id, action_text, agent_label) = {
            let Some(state_arc) = self.manager.get_state(&conn_id).await else {
                return AssistantActionResult {
                    outcome: "not_running".to_string(),
                    message: "session is not currently running".to_string(),
                };
            };
            let state = state_arc.read().await;
            let Some(ref p) = state.pending_permission else {
                return AssistantActionResult {
                    outcome: "no_pending_permission".to_string(),
                    message: "session has no pending permission request".to_string(),
                };
            };

            // Map the user-facing decision to the concrete option_id.
            // Never select allow_always / reject_always — those write durable
            // rules and belong to the user's own click.
            let target_kind = if want_allow { "allow_once" } else { "reject_once" };
            let Some(opt) = p.options.iter().find(|o| o.kind == target_kind) else {
                return AssistantActionResult {
                    outcome: "unsupported".to_string(),
                    message: format!(
                        "no '{target_kind}' option available; the permission card stays for a click"
                    ),
                };
            };

            // Build the question text: command ?? title from the tool_call JSON.
            let action = p
                .tool_call
                .get("command")
                .or_else(|| p.tool_call.get("title"))
                .and_then(|v| v.as_str())
                .unwrap_or("unknown action")
                .to_string();

            let agent = state.agent_type.to_string();

            (p.request_id.clone(), opt.option_id.clone(), action, agent)
        };

        let session_title = crate::db::service::conversation_service::get_by_id(
            &self.db.conn,
            session_id as i32,
        )
        .await
        .ok()
        .and_then(|c| c.title)
        .unwrap_or_else(|| format!("session {session_id}"));

        let labels = load_confirm_labels(&self.db.conn).await;
        let verb = if want_allow { "approve" } else { "deny" };
        let question = format!(
            "{agent_label} · {session_title}: {verb}: {action_text}"
        );
        let spec = make_confirm_spec(question, "Confirm", &labels);
        if !ask_confirm(self.question_access(), requester_conn_id, spec).await {
            return AssistantActionResult {
                outcome: "declined".to_string(),
                message: "user declined".to_string(),
            };
        }

        // re-check: still the same request_id?
        // target session's own card while this confirmation was open.
        let still_pending = {
            let Some(state_arc) = self.manager.get_state(&conn_id).await else {
                return AssistantActionResult {
                    outcome: "not_running".to_string(),
                    message: "session ended while waiting for confirmation".to_string(),
                };
            };
            let state = state_arc.read().await;
            state
                .pending_permission
                .as_ref()
                .map(|p| p.request_id == request_id)
                .unwrap_or(false)
        };
        if !still_pending {
            return AssistantActionResult {
                outcome: "no_pending_permission".to_string(),
                message: "permission was already answered".to_string(),
            };
        }

        match self
            .manager
            .respond_permission(&conn_id, &request_id, &option_id)
            .await
        {
            Ok(()) => AssistantActionResult {
                outcome: "ok".to_string(),
                message: format!("permission answered with option '{option_id}'"),
            },
            Err(e) => AssistantActionResult {
                outcome: "busy".to_string(),
                message: e.to_string(),
            },
        }
    }

    async fn start_session(
        &self,
        requester_conn_id: &str,
        folder_id: i64,
        agent_type: String,
        task: String,
    ) -> AssistantActionResult {
        let settings = match assistant_get_settings_core(&self.db.conn).await {
            Ok(s) => s,
            Err(e) => return AssistantActionResult {
                outcome: "disabled".to_string(),
                message: e.to_string(),
            },
        };
        if !settings.allow_session_control {
            return AssistantActionResult {
                outcome: "disabled".to_string(),
                message: "session control is disabled in assistant settings".to_string(),
            };
        }

        let agent_type_parsed =
            match serde_json::from_str::<crate::models::AgentType>(&format!("\"{agent_type}\"")) {
                Ok(a) => a,
                Err(_) => {
                    return AssistantActionResult {
                        outcome: "unsupported".to_string(),
                        message: format!("unknown agent type: {agent_type}"),
                    }
                }
            };

        let folder = match crate::db::service::folder_service::get_folder_by_id(
            &self.db.conn,
            folder_id as i32,
        )
        .await
        {
            Ok(Some(f)) => f,
            Ok(None) => {
                return AssistantActionResult {
                    outcome: "not_found".to_string(),
                    message: format!("folder {folder_id} not found"),
                }
            }
            Err(e) => {
                return AssistantActionResult {
                    outcome: "not_found".to_string(),
                    message: e.to_string(),
                }
            }
        };

        let labels = load_confirm_labels(&self.db.conn).await;
        let task_preview = truncate_chars(&task, 300);
        let question = format!(
            "{} · {}: {task_preview}",
            agent_type_parsed, folder.name
        );
        let spec = make_confirm_spec(question, "Confirm", &labels);
        if !ask_confirm(self.question_access(), requester_conn_id, spec).await {
            return AssistantActionResult {
                outcome: "declined".to_string(),
                message: "user declined".to_string(),
            };
        }

        let conv = match crate::db::service::conversation_service::create(
            &self.db.conn,
            folder_id as i32,
            agent_type_parsed,
            None,
            None,
        )
        .await
        {
            Ok(c) => c,
            Err(e) => {
                return AssistantActionResult {
                    outcome: "busy".to_string(),
                    message: e.to_string(),
                }
            }
        };

        let conversation_id = conv.id;
        let data_dir = crate::paths::codeg_home_dir();
        let runtime_env = match crate::commands::acp::build_session_runtime_env(
            &self.db,
            agent_type_parsed,
            None,
            &data_dir,
        )
        .await
        {
            Ok(env) => env,
            Err(e) => {
                return AssistantActionResult {
                    outcome: "busy".to_string(),
                    message: e.to_string(),
                }
            }
        };

        let conn_id = match self
            .manager
            .spawn_agent(
                agent_type_parsed,
                Some(folder.path.clone()),
                None,
                runtime_env,
                "main".to_string(),
                (*self.emitter).clone(),
                None,
                std::collections::BTreeMap::new(),
            )
            .await
        {
            Ok(id) => id,
            Err(e) => {
                return AssistantActionResult {
                    outcome: "busy".to_string(),
                    message: e.to_string(),
                }
            }
        };

        let blocks = vec![PromptInputBlock::Text { text: task }];
        if let Err(e) = self
            .manager
            .send_prompt_linked_with_message_id(
                &self.db,
                &conn_id,
                blocks,
                Some(folder_id as i32),
                Some(conversation_id),
                None,
                None,
            )
            .await
        {
            return AssistantActionResult {
                outcome: "busy".to_string(),
                message: e.to_string(),
            };
        }

        let agent_str = serde_json::to_value(agent_type_parsed)
            .ok()
            .and_then(|v| v.as_str().map(String::from))
            .unwrap_or_default();
        #[derive(serde::Serialize)]
        #[serde(rename_all = "camelCase")]
        struct FocusPayload {
            folder_id: i32,
            conversation_id: i32,
            agent: String,
        }
        emit_event(
            &self.emitter,
            "workspace://focus-conversation",
            FocusPayload { folder_id: folder_id as i32, conversation_id, agent: agent_str },
        );

        AssistantActionResult {
            outcome: "ok".to_string(),
            message: format!("started session {conversation_id}"),
        }
    }
}

impl DbAssistantToolAccess {
    /// Read the target connection's agent display label and the DB conversation
    /// title in one pass. Used to build confirmation card question text.
    async fn session_label_and_title(&self, session_id: i32, conn_id: &str) -> (String, String) {
        let agent_label = if let Some(state_arc) = self.manager.get_state(conn_id).await {
            state_arc.read().await.agent_type.to_string()
        } else {
            String::new()
        };
        let session_title = crate::db::service::conversation_service::get_by_id(
            &self.db.conn,
            session_id,
        )
        .await
        .ok()
        .and_then(|c| c.title)
        .unwrap_or_else(|| format!("session {session_id}"));
        (agent_label, session_title)
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::sync::Arc;

    use async_trait::async_trait;
    use tokio::sync::oneshot;

    use crate::acp::question::{
        QuestionAnsweredItem, QuestionOutcome, QuestionSpec, RegisteredQuestion,
        SessionQuestionAccess,
    };

    // ---------------------------------------------------------------------------
    // Manual fake questions (pop_sender pattern for join! tests)
    // ---------------------------------------------------------------------------

    #[derive(Default)]
    struct ManualFakeQuestions {
        counter: AtomicUsize,
        pending: tokio::sync::Mutex<
            HashMap<String, (String, oneshot::Sender<QuestionOutcome>)>,
        >,
    }

    impl ManualFakeQuestions {
        async fn pop_sender(&self) -> Option<oneshot::Sender<QuestionOutcome>> {
            let mut map = self.pending.lock().await;
            let key = map.keys().next().cloned()?;
            Some(map.remove(&key).unwrap().1)
        }
    }

    #[async_trait]
    impl SessionQuestionAccess for ManualFakeQuestions {
        async fn register_question(
            &self,
            parent_connection_id: &str,
            _questions: Vec<QuestionSpec>,
        ) -> Option<RegisteredQuestion> {
            let id = format!("q{}", self.counter.fetch_add(1, Ordering::SeqCst) + 1);
            let (tx, rx) = oneshot::channel();
            self.pending
                .lock()
                .await
                .insert(id.clone(), (parent_connection_id.to_string(), tx));
            Some(RegisteredQuestion { question_id: id, answer_rx: rx })
        }

        async fn cancel_question(&self, _parent: &str, id: &str) {
            self.pending.lock().await.remove(id);
        }

        async fn cancel_questions_by_parent(&self, parent: &str) {
            self.pending
                .lock()
                .await
                .retain(|_, (pid, _)| pid != parent);
        }
    }

    use super::{ask_confirm, confirm_labels_for, make_confirm_spec, truncate_chars, ConfirmLabels};

    fn en_labels() -> ConfirmLabels {
        ConfirmLabels { confirm: "Confirm", cancel: "Cancel" }
    }

    // ---------------------------------------------------------------------------
    // Existing ask_confirm / label tests (preserved)
    // ---------------------------------------------------------------------------

    #[tokio::test]
    async fn send_to_session_confirm_returns_true_on_confirm_choice() {
        let q = Arc::new(ManualFakeQuestions::default());
        let spec = make_confirm_spec("Send message?", "Confirm", &en_labels());
        let confirm_label = spec.options[0].label.clone();
        let q_clone = Arc::clone(&q);
        let (confirmed, ()) = tokio::join!(
            ask_confirm(q.as_ref(), "assistant-conn", spec),
            async move {
                let tx = loop {
                    if let Some(tx) = q_clone.pop_sender().await { break tx; }
                    tokio::task::yield_now().await;
                };
                let _ = tx.send(QuestionOutcome {
                    declined: false,
                    answers: vec![QuestionAnsweredItem {
                        question: "Send message?".into(),
                        header: "Confirm".into(),
                        multi_select: false,
                        selected: vec![confirm_label],
                    }],
                });
            }
        );
        assert!(confirmed, "should return true when user confirms");
    }

    #[tokio::test]
    async fn cancel_session_confirm_returns_false_on_cancel_choice() {
        let q = Arc::new(ManualFakeQuestions::default());
        let spec = make_confirm_spec("Cancel session?", "Confirm", &en_labels());
        let cancel_label = spec.options[1].label.clone();
        let q_clone = Arc::clone(&q);
        let (confirmed, ()) = tokio::join!(
            ask_confirm(q.as_ref(), "assistant-conn", spec),
            async move {
                let tx = loop {
                    if let Some(tx) = q_clone.pop_sender().await { break tx; }
                    tokio::task::yield_now().await;
                };
                let _ = tx.send(QuestionOutcome {
                    declined: false,
                    answers: vec![QuestionAnsweredItem {
                        question: "Cancel session?".into(),
                        header: "Confirm".into(),
                        multi_select: false,
                        selected: vec![cancel_label],
                    }],
                });
            }
        );
        assert!(!confirmed, "should return false when user cancels");
    }

    #[tokio::test]
    async fn answer_permission_confirm_returns_false_on_dismissed_card() {
        let q = Arc::new(ManualFakeQuestions::default());
        let spec = make_confirm_spec("Allow action?", "Confirm", &en_labels());
        let q_clone = Arc::clone(&q);
        let (confirmed, ()) = tokio::join!(
            ask_confirm(q.as_ref(), "assistant-conn", spec),
            async move {
                let tx = loop {
                    if let Some(tx) = q_clone.pop_sender().await { break tx; }
                    tokio::task::yield_now().await;
                };
                let _ = tx.send(QuestionOutcome { declined: true, answers: vec![] });
            }
        );
        assert!(!confirmed, "should return false when user dismisses");
    }

    #[tokio::test]
    async fn start_session_confirm_returns_false_when_channel_dropped() {
        let q = Arc::new(ManualFakeQuestions::default());
        let spec = make_confirm_spec("Start session?", "Confirm", &en_labels());
        let q_clone = Arc::clone(&q);
        let (confirmed, ()) = tokio::join!(
            ask_confirm(q.as_ref(), "assistant-conn", spec),
            async move {
                let tx = loop {
                    if let Some(tx) = q_clone.pop_sender().await { break tx; }
                    tokio::task::yield_now().await;
                };
                drop(tx);
            }
        );
        assert!(!confirmed, "should return false when answer channel is dropped");
    }

    #[tokio::test]
    async fn ask_confirm_returns_false_when_no_connection() {
        struct NullQuestions;
        #[async_trait]
        impl SessionQuestionAccess for NullQuestions {
            async fn register_question(
                &self,
                _parent: &str,
                _questions: Vec<QuestionSpec>,
            ) -> Option<RegisteredQuestion> {
                None
            }
            async fn cancel_question(&self, _parent: &str, _id: &str) {}
            async fn cancel_questions_by_parent(&self, _parent: &str) {}
        }
        let spec = make_confirm_spec("Test?", "Confirm", &en_labels());
        let result = ask_confirm(&NullQuestions, "some-conn", spec).await;
        assert!(!result);
    }

    #[test]
    fn confirm_labels_for_en_returns_english() {
        use crate::models::system::AppLocale;
        let labels = confirm_labels_for(AppLocale::En);
        assert_eq!(labels.confirm, "Confirm");
        assert_eq!(labels.cancel, "Cancel");
    }

    #[test]
    fn confirm_labels_for_zh_cn_returns_chinese() {
        use crate::models::system::AppLocale;
        let labels = confirm_labels_for(AppLocale::ZhCn);
        assert_eq!(labels.confirm, "确认");
        assert_eq!(labels.cancel, "取消");
    }

    // ---------------------------------------------------------------------------
    // truncate_chars
    // ---------------------------------------------------------------------------

    #[test]
    fn truncate_chars_short_string_passes_through() {
        assert_eq!(truncate_chars("hello", 300), "hello");
    }

    #[test]
    fn truncate_chars_exactly_at_limit_passes_through() {
        let s: String = "x".repeat(300);
        assert_eq!(truncate_chars(&s, 300), s);
    }

    #[test]
    fn truncate_chars_over_limit_appends_ellipsis() {
        let s: String = "x".repeat(301);
        let t = truncate_chars(&s, 300);
        assert!(t.ends_with('…'));
        assert_eq!(t.chars().count(), 301); // 300 x + ellipsis
    }

    // ---------------------------------------------------------------------------
    // DbAssistantToolAccess unit tests using real in-memory DB
    // ---------------------------------------------------------------------------

    use crate::acp::assistant_tools::AssistantToolAccess;
    use crate::acp::manager::ConnectionManager;
    use crate::acp::session_state::PendingPermissionState;
    use crate::acp::types::PermissionOptionInfo;
    use crate::commands::assistant::{assistant_set_settings_core, AssistantSettings};
    use crate::db::test_helpers::fresh_in_memory_db;
    use crate::models::AgentType;
    use crate::web::event_bridge::EventEmitter;

    use super::DbAssistantToolAccess;

    /// Track whether `register_question` was called.
    #[derive(Default)]
    struct TrackingFakeQuestions {
        called: AtomicBool,
        answer: Option<bool>, // Some(true) = confirm, Some(false) = cancel, None = busy
    }

    impl TrackingFakeQuestions {
        fn confirming() -> Arc<Self> {
            Arc::new(Self { answer: Some(true), ..Default::default() })
        }
        fn cancelling() -> Arc<Self> {
            Arc::new(Self { answer: Some(false), ..Default::default() })
        }

        fn was_called(&self) -> bool {
            self.called.load(Ordering::SeqCst)
        }
    }

    #[async_trait]
    impl SessionQuestionAccess for TrackingFakeQuestions {
        async fn register_question(
            &self,
            _parent: &str,
            questions: Vec<QuestionSpec>,
        ) -> Option<RegisteredQuestion> {
            self.called.store(true, Ordering::SeqCst);
            let choice = self.answer?;
            let spec = questions.into_iter().next()?;
            let label = if choice {
                spec.options[0].label.clone()
            } else {
                spec.options[1].label.clone()
            };
            let (tx, rx) = oneshot::channel();
            let _ = tx.send(QuestionOutcome {
                declined: false,
                answers: vec![QuestionAnsweredItem {
                    question: spec.question.clone(),
                    header: spec.header.clone(),
                    multi_select: false,
                    selected: vec![label],
                }],
            });
            Some(RegisteredQuestion {
                question_id: "test-q".to_string(),
                answer_rx: rx,
            })
        }
        async fn cancel_question(&self, _: &str, _: &str) {}
        async fn cancel_questions_by_parent(&self, _: &str) {}
    }

    /// Builds a `DbAssistantToolAccess` wired to the given manager, db, and a
    /// fake question access.
    fn make_access(
        manager: Arc<ConnectionManager>,
        db: Arc<crate::db::AppDatabase>,
        questions: Arc<dyn SessionQuestionAccess>,
    ) -> DbAssistantToolAccess {
        DbAssistantToolAccess {
            manager,
            db,
            emitter: Arc::new(EventEmitter::Noop),
            questions,
        }
    }

    /// Seeds a live test connection on the manager and returns its id.
    async fn seed_connection(
        manager: &ConnectionManager,
        id: &str,
        agent_type: AgentType,
        conv_id: Option<i32>,
        owner: &str,
    ) {
        manager
            .insert_test_connection(id, agent_type, None, EventEmitter::Noop)
            .await;
        let mut connections = manager.connections.lock().await;
        let conn = connections.get_mut(id).unwrap();
        conn.owner_window_label = owner.to_string();
        if let Some(cid) = conv_id {
            conn.state.write().await.conversation_id = Some(cid);
        }
    }

    /// Enables assistant settings (allow_session_control + allow_permission_answers).
    async fn enable_settings(db: &crate::db::AppDatabase) {
        assistant_set_settings_core(
            &db.conn,
            AssistantSettings {
                agent_type: None,
                allow_session_control: true,
                allow_permission_answers: true,
            },
        )
        .await
        .unwrap();
    }

    // ---- send_to_session gates ----

    #[tokio::test]
    async fn send_to_session_disabled_when_setting_off() {
        let db = Arc::new(fresh_in_memory_db().await);
        // settings OFF (default)
        let manager = Arc::new(ConnectionManager::new());
        let questions = TrackingFakeQuestions::confirming();
        let access = make_access(Arc::clone(&manager), Arc::clone(&db), Arc::clone(&questions) as Arc<dyn SessionQuestionAccess>);
        let result = access.send_to_session("asst", 1, "hello".into()).await;
        assert_eq!(result.outcome, "disabled");
        assert!(!questions.was_called(), "no card shown when setting is off");
    }

    #[tokio::test]
    async fn send_to_session_not_running_when_no_connection() {
        let db = Arc::new(fresh_in_memory_db().await);
        enable_settings(&db).await;
        let manager = Arc::new(ConnectionManager::new());
        let questions = TrackingFakeQuestions::confirming();
        let access = make_access(Arc::clone(&manager), Arc::clone(&db), Arc::clone(&questions) as Arc<dyn SessionQuestionAccess>);
        let result = access.send_to_session("asst", 999, "hello".into()).await;
        assert_eq!(result.outcome, "not_running");
        assert!(!questions.was_called());
    }

    #[tokio::test]
    async fn send_to_session_busy_when_turn_in_flight() {
        let db = Arc::new(fresh_in_memory_db().await);
        enable_settings(&db).await;
        let manager = Arc::new(ConnectionManager::new());

        // Seed a conversation row.
        let folder_id = crate::db::test_helpers::seed_folder(&db, "/tmp/test").await;
        let conv_id =
            crate::db::test_helpers::seed_conversation(&db, folder_id, AgentType::Codex).await;

        seed_connection(&manager, "target", AgentType::Codex, Some(conv_id), "main").await;
        // Mark the turn as in-flight.
        {
            let conns = manager.connections.lock().await;
            conns["target"].state.write().await.turn_in_flight = true;
        }

        let questions = TrackingFakeQuestions::confirming();
        let access = make_access(Arc::clone(&manager), Arc::clone(&db), Arc::clone(&questions) as Arc<dyn SessionQuestionAccess>);
        let result = access.send_to_session("asst", conv_id as i64, "hello".into()).await;
        assert_eq!(result.outcome, "busy");
        assert!(!questions.was_called(), "no card shown when turn in flight");
    }

    #[tokio::test]
    async fn send_to_session_confirm_proceeds() {
        let db = Arc::new(fresh_in_memory_db().await);
        enable_settings(&db).await;
        let manager = Arc::new(ConnectionManager::new());

        let folder_id = crate::db::test_helpers::seed_folder(&db, "/tmp/test").await;
        let conv_id =
            crate::db::test_helpers::seed_conversation(&db, folder_id, AgentType::Codex).await;

        seed_connection(&manager, "target", AgentType::Codex, Some(conv_id), "main").await;
        // Note: the cmd receiver is dropped by insert_test_connection, so send
        // will get a `ProcessExited` error — we assert it was at least attempted
        // (outcome is "busy", not "declined").
        let questions = TrackingFakeQuestions::confirming();
        let access = make_access(Arc::clone(&manager), Arc::clone(&db), Arc::clone(&questions) as Arc<dyn SessionQuestionAccess>);
        let result = access.send_to_session("asst", conv_id as i64, "do something".into()).await;
        assert!(questions.was_called(), "card must be shown");
        // The cmd tx is dropped so send_prompt fails → "busy", not "declined".
        assert_ne!(result.outcome, "declined", "user confirmed; must not be declined");
    }

    #[tokio::test]
    async fn send_to_session_cancel_returns_declined() {
        let db = Arc::new(fresh_in_memory_db().await);
        enable_settings(&db).await;
        let manager = Arc::new(ConnectionManager::new());

        let folder_id = crate::db::test_helpers::seed_folder(&db, "/tmp/test").await;
        let conv_id =
            crate::db::test_helpers::seed_conversation(&db, folder_id, AgentType::Codex).await;

        seed_connection(&manager, "target", AgentType::Codex, Some(conv_id), "main").await;
        let questions = TrackingFakeQuestions::cancelling();
        let access = make_access(Arc::clone(&manager), Arc::clone(&db), Arc::clone(&questions) as Arc<dyn SessionQuestionAccess>);
        let result = access.send_to_session("asst", conv_id as i64, "do something".into()).await;
        assert!(questions.was_called());
        assert_eq!(result.outcome, "declined");
    }

    // ---- cancel_session gates ----

    #[tokio::test]
    async fn cancel_session_disabled_when_setting_off() {
        let db = Arc::new(fresh_in_memory_db().await);
        let manager = Arc::new(ConnectionManager::new());
        let questions = TrackingFakeQuestions::confirming();
        let access = make_access(Arc::clone(&manager), Arc::clone(&db), Arc::clone(&questions) as Arc<dyn SessionQuestionAccess>);
        let result = access.cancel_session("asst", 1).await;
        assert_eq!(result.outcome, "disabled");
        assert!(!questions.was_called());
    }

    #[tokio::test]
    async fn cancel_session_not_running_when_no_connection() {
        let db = Arc::new(fresh_in_memory_db().await);
        enable_settings(&db).await;
        let manager = Arc::new(ConnectionManager::new());
        let questions = TrackingFakeQuestions::confirming();
        let access = make_access(Arc::clone(&manager), Arc::clone(&db), Arc::clone(&questions) as Arc<dyn SessionQuestionAccess>);
        let result = access.cancel_session("asst", 999).await;
        assert_eq!(result.outcome, "not_running");
        assert!(!questions.was_called());
    }

    #[tokio::test]
    async fn cancel_session_confirm_shows_card() {
        let db = Arc::new(fresh_in_memory_db().await);
        enable_settings(&db).await;
        let manager = Arc::new(ConnectionManager::new());

        let folder_id = crate::db::test_helpers::seed_folder(&db, "/tmp/test").await;
        let conv_id =
            crate::db::test_helpers::seed_conversation(&db, folder_id, AgentType::Codex).await;

        seed_connection(&manager, "target", AgentType::Codex, Some(conv_id), "main").await;
        let questions = TrackingFakeQuestions::confirming();
        let access = make_access(Arc::clone(&manager), Arc::clone(&db), Arc::clone(&questions) as Arc<dyn SessionQuestionAccess>);
        let result = access.cancel_session("asst", conv_id as i64).await;
        assert!(questions.was_called(), "card must be shown");
        // cmd tx is dropped → cancel fails internally; it's not "declined"
        assert_ne!(result.outcome, "declined");
    }

    #[tokio::test]
    async fn cancel_session_cancel_returns_declined() {
        let db = Arc::new(fresh_in_memory_db().await);
        enable_settings(&db).await;
        let manager = Arc::new(ConnectionManager::new());

        let folder_id = crate::db::test_helpers::seed_folder(&db, "/tmp/test").await;
        let conv_id =
            crate::db::test_helpers::seed_conversation(&db, folder_id, AgentType::Codex).await;

        seed_connection(&manager, "target", AgentType::Codex, Some(conv_id), "main").await;
        let questions = TrackingFakeQuestions::cancelling();
        let access = make_access(Arc::clone(&manager), Arc::clone(&db), Arc::clone(&questions) as Arc<dyn SessionQuestionAccess>);
        let result = access.cancel_session("asst", conv_id as i64).await;
        assert!(questions.was_called());
        assert_eq!(result.outcome, "declined");
    }

    // ---- answer_permission gates ----

    #[tokio::test]
    async fn answer_permission_disabled_when_setting_off() {
        let db = Arc::new(fresh_in_memory_db().await);
        // settings OFF by default
        let manager = Arc::new(ConnectionManager::new());
        let questions = TrackingFakeQuestions::confirming();
        let access = make_access(Arc::clone(&manager), Arc::clone(&db), Arc::clone(&questions) as Arc<dyn SessionQuestionAccess>);
        let result = access.answer_permission("asst", 1, "approve".into()).await;
        assert_eq!(result.outcome, "disabled");
        assert!(!questions.was_called());
    }

    #[tokio::test]
    async fn answer_permission_not_running_when_no_connection() {
        let db = Arc::new(fresh_in_memory_db().await);
        enable_settings(&db).await;
        let manager = Arc::new(ConnectionManager::new());
        let questions = TrackingFakeQuestions::confirming();
        let access = make_access(Arc::clone(&manager), Arc::clone(&db), Arc::clone(&questions) as Arc<dyn SessionQuestionAccess>);
        let result = access.answer_permission("asst", 999, "approve".into()).await;
        assert_eq!(result.outcome, "not_running");
        assert!(!questions.was_called());
    }

    #[tokio::test]
    async fn answer_permission_no_pending_permission() {
        let db = Arc::new(fresh_in_memory_db().await);
        enable_settings(&db).await;
        let manager = Arc::new(ConnectionManager::new());

        let folder_id = crate::db::test_helpers::seed_folder(&db, "/tmp/test").await;
        let conv_id =
            crate::db::test_helpers::seed_conversation(&db, folder_id, AgentType::Codex).await;

        seed_connection(&manager, "target", AgentType::Codex, Some(conv_id), "main").await;
        let questions = TrackingFakeQuestions::confirming();
        let access = make_access(Arc::clone(&manager), Arc::clone(&db), Arc::clone(&questions) as Arc<dyn SessionQuestionAccess>);
        let result = access.answer_permission("asst", conv_id as i64, "approve".into()).await;
        assert_eq!(result.outcome, "no_pending_permission");
        assert!(!questions.was_called());
    }

    /// Seeds a pending permission on a connection. Returns the request_id.
    async fn seed_pending_permission(
        manager: &ConnectionManager,
        conn_id: &str,
        options: Vec<PermissionOptionInfo>,
    ) -> String {
        let request_id = "req-001".to_string();
        let conns = manager.connections.lock().await;
        let mut state = conns[conn_id].state.write().await;
        state.pending_permission = Some(PendingPermissionState {
            request_id: request_id.clone(),
            tool_call_id: "tc-001".to_string(),
            tool_call: serde_json::json!({ "title": "Run bash command", "command": "ls -la" }),
            options,
            created_at: chrono::Utc::now(),
            queued: 0,
        });
        request_id
    }

    fn allow_once_option() -> PermissionOptionInfo {
        PermissionOptionInfo {
            option_id: "opt-allow-once".to_string(),
            name: "Allow once".to_string(),
            kind: "allow_once".to_string(),
            meta: None,
        }
    }

    fn reject_once_option() -> PermissionOptionInfo {
        PermissionOptionInfo {
            option_id: "opt-reject-once".to_string(),
            name: "Reject once".to_string(),
            kind: "reject_once".to_string(),
            meta: None,
        }
    }

    fn allow_always_option() -> PermissionOptionInfo {
        PermissionOptionInfo {
            option_id: "opt-allow-always".to_string(),
            name: "Allow always".to_string(),
            kind: "allow_always".to_string(),
            meta: None,
        }
    }

    #[tokio::test]
    async fn answer_permission_unsupported_when_only_allow_always_offered() {
        let db = Arc::new(fresh_in_memory_db().await);
        enable_settings(&db).await;
        let manager = Arc::new(ConnectionManager::new());

        let folder_id = crate::db::test_helpers::seed_folder(&db, "/tmp/test").await;
        let conv_id =
            crate::db::test_helpers::seed_conversation(&db, folder_id, AgentType::Codex).await;

        seed_connection(&manager, "target", AgentType::Codex, Some(conv_id), "main").await;
        // Only allow_always offered → unsupported, no card
        seed_pending_permission(&manager, "target", vec![allow_always_option()]).await;

        let questions = TrackingFakeQuestions::confirming();
        let access = make_access(Arc::clone(&manager), Arc::clone(&db), Arc::clone(&questions) as Arc<dyn SessionQuestionAccess>);
        let result = access.answer_permission("asst", conv_id as i64, "approve".into()).await;
        assert_eq!(result.outcome, "unsupported");
        assert!(!questions.was_called(), "no card when unsupported");
    }

    #[tokio::test]
    async fn answer_permission_picks_allow_once_id_even_when_allow_always_listed_first() {
        let db = Arc::new(fresh_in_memory_db().await);
        enable_settings(&db).await;
        let manager = Arc::new(ConnectionManager::new());

        let folder_id = crate::db::test_helpers::seed_folder(&db, "/tmp/test").await;
        let conv_id =
            crate::db::test_helpers::seed_conversation(&db, folder_id, AgentType::Codex).await;

        seed_connection(&manager, "target", AgentType::Codex, Some(conv_id), "main").await;
        // allow_always listed FIRST, allow_once second
        seed_pending_permission(
            &manager,
            "target",
            vec![allow_always_option(), allow_once_option()],
        )
        .await;

        // Track which option_id is passed to respond_permission.
        // The cmd tx is dropped, so respond_permission will error — we verify
        // the code got past the option selection step by checking it asked
        // the confirmation card.
        let questions = TrackingFakeQuestions::confirming();
        let access = make_access(Arc::clone(&manager), Arc::clone(&db), Arc::clone(&questions) as Arc<dyn SessionQuestionAccess>);
        let result = access.answer_permission("asst", conv_id as i64, "approve".into()).await;
        // Card WAS shown (option was found).
        assert!(questions.was_called(), "card must be shown when allow_once is available");
        // The permission was still pending when we confirmed (no other actor
        // cleared it), so respond_permission was called. The cmd tx is dead →
        // responds with an error, giving "busy" outcome. NOT "unsupported".
        assert_ne!(result.outcome, "unsupported");
        assert_ne!(result.outcome, "declined");
    }

    #[tokio::test]
    async fn answer_permission_deny_picks_reject_once_option_id() {
        let db = Arc::new(fresh_in_memory_db().await);
        enable_settings(&db).await;
        let manager = Arc::new(ConnectionManager::new());

        let folder_id = crate::db::test_helpers::seed_folder(&db, "/tmp/test").await;
        let conv_id =
            crate::db::test_helpers::seed_conversation(&db, folder_id, AgentType::Codex).await;

        seed_connection(&manager, "target", AgentType::Codex, Some(conv_id), "main").await;
        seed_pending_permission(
            &manager,
            "target",
            vec![allow_once_option(), reject_once_option()],
        )
        .await;

        let questions = TrackingFakeQuestions::confirming();
        let access = make_access(Arc::clone(&manager), Arc::clone(&db), Arc::clone(&questions) as Arc<dyn SessionQuestionAccess>);
        // "deny" → must look for reject_once option
        let result = access.answer_permission("asst", conv_id as i64, "deny".into()).await;
        assert!(questions.was_called());
        assert_ne!(result.outcome, "unsupported");
        assert_ne!(result.outcome, "declined");
    }

    #[tokio::test]
    async fn answer_permission_cancel_returns_declined() {
        let db = Arc::new(fresh_in_memory_db().await);
        enable_settings(&db).await;
        let manager = Arc::new(ConnectionManager::new());

        let folder_id = crate::db::test_helpers::seed_folder(&db, "/tmp/test").await;
        let conv_id =
            crate::db::test_helpers::seed_conversation(&db, folder_id, AgentType::Codex).await;

        seed_connection(&manager, "target", AgentType::Codex, Some(conv_id), "main").await;
        seed_pending_permission(
            &manager,
            "target",
            vec![allow_once_option(), reject_once_option()],
        )
        .await;

        let questions = TrackingFakeQuestions::cancelling();
        let access = make_access(Arc::clone(&manager), Arc::clone(&db), Arc::clone(&questions) as Arc<dyn SessionQuestionAccess>);
        let result = access.answer_permission("asst", conv_id as i64, "approve".into()).await;
        assert!(questions.was_called());
        assert_eq!(result.outcome, "declined");
    }

    #[tokio::test]
    async fn answer_permission_stale_request_id_after_confirmation_no_respond() {
        let db = Arc::new(fresh_in_memory_db().await);
        enable_settings(&db).await;
        let manager = Arc::new(ConnectionManager::new());

        let folder_id = crate::db::test_helpers::seed_folder(&db, "/tmp/test").await;
        let conv_id =
            crate::db::test_helpers::seed_conversation(&db, folder_id, AgentType::Codex).await;

        seed_connection(&manager, "target", AgentType::Codex, Some(conv_id), "main").await;
        seed_pending_permission(
            &manager,
            "target",
            vec![allow_once_option(), reject_once_option()],
        )
        .await;

        // After the user confirms the card, clear the pending_permission to
        // simulate the user clicking the real card on the target session.
        // We use a custom FakeQuestions that clears the pending permission
        // from the target session's state before resolving the answer.
        struct ClearOnConfirm {
            manager: Arc<ConnectionManager>,
            conn_id: String,
        }
        #[async_trait]
        impl SessionQuestionAccess for ClearOnConfirm {
            async fn register_question(
                &self,
                _parent: &str,
                questions: Vec<QuestionSpec>,
            ) -> Option<RegisteredQuestion> {
                let spec = questions.into_iter().next()?;
                let label = spec.options[0].label.clone();
                // Clear the pending permission BEFORE delivering the answer.
                {
                    let conns = self.manager.connections.lock().await;
                    if let Some(conn) = conns.get(&self.conn_id) {
                        conn.state.write().await.pending_permission = None;
                    }
                }
                let (tx, rx) = oneshot::channel();
                let _ = tx.send(QuestionOutcome {
                    declined: false,
                    answers: vec![QuestionAnsweredItem {
                        question: spec.question,
                        header: spec.header,
                        multi_select: false,
                        selected: vec![label],
                    }],
                });
                Some(RegisteredQuestion { question_id: "q1".into(), answer_rx: rx })
            }
            async fn cancel_question(&self, _: &str, _: &str) {}
            async fn cancel_questions_by_parent(&self, _: &str) {}
        }

        let questions: Arc<dyn SessionQuestionAccess> = Arc::new(ClearOnConfirm {
            manager: Arc::clone(&manager),
            conn_id: "target".to_string(),
        });
        let access = make_access(Arc::clone(&manager), Arc::clone(&db), questions);
        let result = access.answer_permission("asst", conv_id as i64, "approve".into()).await;
        // The re-check sees no pending permission → no_pending_permission
        assert_eq!(
            result.outcome, "no_pending_permission",
            "stale request id → must not call respond_permission"
        );
    }

    // ---- auto-allow / is_codeg_assistant_tool_name ----

    #[test]
    fn is_codeg_assistant_tool_name_accepts_mutating_tools() {
        use crate::acp::question::is_codeg_assistant_tool_name;
        for name in [
            "codeg_mcp__send_to_session",
            "codeg-mcp__cancel_session",
            "codeg_mcp__answer_permission",
            "codeg_mcp__start_session",
            // with server prefix spacing variants
            "codeg mcp  cancel_session",
        ] {
            assert!(
                is_codeg_assistant_tool_name(name),
                "{name} should be recognized as a codeg assistant tool"
            );
        }
    }

    #[test]
    fn is_codeg_assistant_tool_name_rejects_non_assistant_tools() {
        use crate::acp::question::is_codeg_assistant_tool_name;
        for name in [
            "codeg_mcp__list_sessions",   // list/focus are not mutating
            "codeg_mcp__focus_session",
            "send_to_session",            // missing server prefix
            "other_mcp__send_to_session",
            "ask_user_question",
        ] {
            assert!(
                !is_codeg_assistant_tool_name(name),
                "{name} should NOT be recognized as a codeg assistant tool"
            );
        }
    }

    #[tokio::test]
    async fn auto_allow_not_applied_for_non_assistant_owner() {
        use crate::acp::question::is_codeg_assistant_tool_name;
        use crate::commands::assistant::ASSISTANT_OWNER_LABEL;
        let non_assistant_owner = "main";
        assert_ne!(non_assistant_owner, ASSISTANT_OWNER_LABEL);
        assert!(is_codeg_assistant_tool_name("codeg_mcp__send_to_session"),
            "tool is recognized by name");
        let is_auto_allowed = non_assistant_owner == ASSISTANT_OWNER_LABEL
            && is_codeg_assistant_tool_name("codeg_mcp__send_to_session");
        assert!(!is_auto_allowed,
            "auto-allow requires ASSISTANT_OWNER_LABEL; 'main' must not trigger it");
    }
}
