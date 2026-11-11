//! ACP adapter for messages delivered into existing conversations.
use crate::acp::{
    delegation::broker::DelegationBroker,
    manager::{ConnectionManager, ConnectionManagerSpawner},
    session_messages::{SessionRuntime, SessionStartError, SessionTurn, SessionTurnResult},
    types::{AcpEvent, ConnectionStatus, EventEnvelope, PromptInputBlock},
};
use crate::db::{
    entities::{conversation, folder},
    AppDatabase,
};
use crate::models::{agent::AgentType, assistant::AssistantRunSnapshot};
use async_trait::async_trait;
use sea_orm::{ColumnTrait, EntityTrait, QueryFilter};
use std::{collections::HashMap, path::PathBuf, sync::Arc};
use tokio::sync::{broadcast, Mutex};

type PendingTurn = (String, broadcast::Receiver<Arc<EventEnvelope>>);

pub struct AcpSessionRuntime {
    manager: Arc<ConnectionManager>,
    broker: Arc<DelegationBroker>,
    db: Arc<AppDatabase>,
    data_dir: Arc<PathBuf>,
    preparation_locks: Mutex<HashMap<i32, Arc<Mutex<()>>>>,
    prepared_connections: Mutex<HashMap<i32, String>>,
    turns: Mutex<HashMap<String, PendingTurn>>,
}

impl AcpSessionRuntime {
    pub fn new(
        manager: Arc<ConnectionManager>,
        broker: Arc<DelegationBroker>,
        db: Arc<AppDatabase>,
        data_dir: Arc<PathBuf>,
    ) -> Self {
        Self {
            manager,
            broker,
            db,
            data_dir,
            preparation_locks: Mutex::new(HashMap::new()),
            prepared_connections: Mutex::new(HashMap::new()),
            turns: Mutex::new(HashMap::new()),
        }
    }

    async fn session_target(
        &self,
        sender: i32,
        recipient: i32,
    ) -> Result<conversation::Model, String> {
        conversation::Entity::find_by_id(sender)
            .filter(conversation::Column::DeletedAt.is_null())
            .one(&self.db.conn)
            .await
            .map_err(|e| e.to_string())?
            .ok_or("sender session is unavailable")?;
        conversation::Entity::find_by_id(recipient)
            .filter(conversation::Column::DeletedAt.is_null())
            .one(&self.db.conn)
            .await
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "target session is unavailable".into())
    }

    async fn connection(&self, recipient: i32) -> Result<String, String> {
        if let Some(conn) = self
            .manager
            .find_connection_by_conversation_id(recipient)
            .await
        {
            if let Some(state) = self.manager.get_state(&conn).await {
                if !matches!(
                    state.read().await.status,
                    ConnectionStatus::Disconnected | ConnectionStatus::Error
                ) {
                    return Ok(conn);
                }
            }
        }
        let prepared = self
            .prepared_connections
            .lock()
            .await
            .get(&recipient)
            .cloned();
        if let Some(conn) = prepared {
            if let Some(state) = self.manager.get_state(&conn).await {
                if !matches!(
                    state.read().await.status,
                    ConnectionStatus::Disconnected | ConnectionStatus::Error
                ) {
                    return Ok(conn);
                }
            }
        }
        Err("recipient session is unavailable on this runtime".into())
    }

    async fn owner(&self, requested: &str, sender: i32) -> Result<String, String> {
        if let Some(state) = self.manager.get_state(requested).await {
            if state.read().await.conversation_id == Some(sender) {
                return Ok(requested.into());
            }
        }
        self.manager
            .find_connection_by_conversation_id(sender)
            .await
            .ok_or_else(|| "sender has no available runtime owner; continuation paused".into())
    }
}

#[async_trait]
impl SessionRuntime for AcpSessionRuntime {
    fn message_from(&self, sender: i32, recipient: i32, message: String) -> String {
        format!("[Codeg session message]\nFrom conversation {sender} to conversation {recipient}. This is a message from another session. Reply with send_to_session using conversation_id={sender} when needed; avoid acknowledgment loops.\n\n{message}")
    }

    async fn prepare(
        &self,
        sender_connection_id: &str,
        sender: i32,
        recipient: i32,
    ) -> Result<(), String> {
        let preparation = self
            .preparation_locks
            .lock()
            .await
            .entry(recipient)
            .or_default()
            .clone();
        let _preparation = preparation.lock().await;
        if !self.broker.config_snapshot().await.enabled {
            return Err("delegation is disabled; recipient message delivery paused".into());
        }
        let row = self.session_target(sender, recipient).await?;
        let original_turn = if let Ok(conn) = self.connection(recipient).await {
            if let Some(state) = self.manager.get_state(&conn).await {
                let state = state.read().await;
                state.turn_in_flight.then_some(state.turns_completed)
            } else {
                None
            }
        } else {
            None
        };
        if row.kind == conversation::ConversationKind::Delegate {
            self.broker
                .retain_child_for_messaging(recipient, original_turn)
                .await;
        }
        if self.connection(recipient).await.is_ok() {
            return Ok(());
        }
        if row.status == conversation::ConversationStatus::InProgress {
            return Err("recipient is marked running but has no local connection; its runtime ownership is unknown, continuation paused".into());
        }
        let owner = self.owner(sender_connection_id, sender).await?;
        let external = row
            .external_id
            .as_deref()
            .filter(|s| !s.is_empty())
            .ok_or("recipient has no recorded agent session to resume")?;
        let agent =
            AgentType::from_wire(&row.agent_type).ok_or("recipient agent type is unavailable")?;
        let folder = folder::Entity::find_by_id(row.folder_id)
            .one(&self.db.conn)
            .await
            .map_err(|e| e.to_string())?
            .ok_or("recipient project folder no longer exists")?;
        let working_dir = row.origin_cwd.clone().unwrap_or(folder.path);
        let defaults = if row.assistant_id.is_some() {
            let snapshot: AssistantRunSnapshot = serde_json::from_str(
                row.assistant_snapshot
                    .as_deref()
                    .ok_or("recipient assistant settings are missing")?,
            )
            .map_err(|e| format!("recipient assistant settings cannot be restored: {e}"))?;
            snapshot.agent_options
        } else {
            crate::acp::delegation::types::AgentDelegationDefaults::default()
        };
        let spawner = ConnectionManagerSpawner {
            manager: self.manager.clone(),
            db: self.db.clone(),
            data_dir: self.data_dir.clone(),
        };
        let spawned = spawner
            .spawn_for_resume_strict(
                &owner,
                agent,
                Some(working_dir),
                external,
                defaults.mode_id,
                defaults.config_values,
            )
            .await
            .map_err(|e| e.to_string())?;
        // Keep the launch ticket locally; send_prompt_linked adopts the persisted
        // conversation and emits its normal lifecycle events when dispatching.
        self.prepared_connections
            .lock()
            .await
            .insert(recipient, spawned.connection_id);
        Ok(())
    }

    async fn is_busy(&self, recipient: i32) -> Result<bool, String> {
        let conn = self.connection(recipient).await?;
        let state = self
            .manager
            .get_state(&conn)
            .await
            .ok_or("recipient connection disappeared")?;
        let state = state.read().await;
        Ok(state.turn_in_flight || state.status == ConnectionStatus::Prompting)
    }

    async fn wait_idle(&self, recipient: i32) -> Result<(), String> {
        let conn = self.connection(recipient).await?;
        let state = self
            .manager
            .get_state(&conn)
            .await
            .ok_or("recipient connection disappeared")?;
        let mut events = state.read().await.event_stream().subscribe();
        while self.is_busy(recipient).await? {
            events
                .recv()
                .await
                .map_err(|e| format!("recipient event stream unavailable: {e}"))?;
        }
        self.manager.wait_prompt_quiescence(&conn).await?;
        self.manager.wait_turn_lifecycle(&conn).await
    }

    async fn start(
        &self,
        sender_connection_id: &str,
        sender: i32,
        recipient: i32,
        message: String,
    ) -> Result<SessionTurn, SessionStartError> {
        self.prepare(sender_connection_id, sender, recipient)
            .await?;
        let row = self.session_target(sender, recipient).await?;
        let conn = self.connection(recipient).await?;
        if self.is_busy(recipient).await? {
            return Err(SessionStartError::Busy);
        }
        if let Err(error) = self.manager.wait_prompt_quiescence(&conn).await {
            return Err(if self.is_busy(recipient).await.unwrap_or(false) {
                SessionStartError::Busy
            } else {
                SessionStartError::Failed(error)
            });
        }
        self.manager.wait_turn_lifecycle(&conn).await?;
        let state = self
            .manager
            .get_state(&conn)
            .await
            .ok_or("recipient connection disappeared")?;
        let events = state.read().await.event_stream().subscribe();
        let id = uuid::Uuid::new_v4().to_string();
        self.manager
            .send_prompt_linked_with_message_id(
                &self.db,
                &conn,
                vec![PromptInputBlock::Text { text: message }],
                Some(row.folder_id),
                Some(recipient),
                None,
                Some(id.clone()),
            )
            .await
            .map_err(|e| match e {
                crate::acp::error::AcpError::TurnInProgress => SessionStartError::Busy,
                e => SessionStartError::Failed(e.to_string()),
            })?;
        self.turns.lock().await.insert(id.clone(), (conn, events));
        Ok(SessionTurn { id })
    }

    async fn steer(&self, recipient: i32, message: String) -> Result<bool, String> {
        let conn = self.connection(recipient).await?;
        let state = self
            .manager
            .get_state(&conn)
            .await
            .ok_or("recipient connection disappeared")?;
        if !state.read().await.native_steering_available {
            return Ok(false);
        }
        match self
            .manager
            .submit_feedback_native_only(&conn, message)
            .await
        {
            Ok(_) => Ok(true),
            Err(
                crate::acp::error::AcpError::FeedbackDisabled
                | crate::acp::error::AcpError::NoActiveTurn,
            ) => Ok(false),
            Err(e) => Err(e.to_string()),
        }
    }

    async fn interrupt(&self, recipient: i32) -> Result<(), String> {
        let conn = self.connection(recipient).await?;
        self.manager.cancel_and_wait(&self.db.conn, &conn).await?;
        self.manager.wait_turn_lifecycle(&conn).await
    }

    async fn wait(&self, turn: SessionTurn) -> Result<SessionTurnResult, String> {
        let (conn, mut events) = self
            .turns
            .lock()
            .await
            .remove(&turn.id)
            .ok_or("unknown or already consumed recipient turn")?;
        let result = collect_turn(&turn.id, &mut events).await?;
        self.manager.wait_turn_lifecycle(&conn).await?;
        Ok(result)
    }
}

async fn collect_turn(
    turn_id: &str,
    events: &mut broadcast::Receiver<Arc<EventEnvelope>>,
) -> Result<SessionTurnResult, String> {
    let mut started = false;
    let mut text = String::new();
    let mut error = None;
    loop {
        let envelope = events
            .recv()
            .await
            .map_err(|e| format!("recipient turn event stream unavailable: {e}"))?;
        match &envelope.payload {
            AcpEvent::UserMessage { message_id, .. } if message_id == turn_id => started = true,
            AcpEvent::ContentDelta {
                text: delta,
                parent_tool_use_id: None,
            } if started => text.push_str(delta),
            AcpEvent::Error { message, .. } if started => error = Some(message.clone()),
            AcpEvent::TurnComplete { stop_reason, .. } if started => {
                let status = if stop_reason == "cancelled" {
                    "canceled"
                } else if error.is_some() || stop_reason != "end_turn" {
                    "failed"
                } else {
                    "completed"
                };
                return Ok(SessionTurnResult {
                    status: status.into(),
                    text: (!text.is_empty()).then_some(text),
                    error,
                });
            }
            AcpEvent::StatusChanged {
                status: ConnectionStatus::Disconnected | ConnectionStatus::Error,
            } => {
                return Ok(SessionTurnResult {
                    status: "failed".into(),
                    text: (!text.is_empty()).then_some(text),
                    error: error.or_else(|| {
                        Some("recipient connection ended before its turn completed".into())
                    }),
                });
            }
            _ => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct NoDepth;
    #[async_trait]
    impl crate::acp::delegation::broker::ConversationDepthLookup for NoDepth {
        async fn parent_of(
            &self,
            _: i32,
        ) -> Result<Option<i32>, crate::acp::delegation::types::DelegationError> {
            Ok(None)
        }
    }

    async fn fixture() -> (AcpSessionRuntime, i32, i32) {
        use crate::db::test_helpers::{fresh_in_memory_db, seed_conversation, seed_folder};
        use sea_orm::sea_query::Expr;
        let db = fresh_in_memory_db().await;
        let folder = seed_folder(&db, "D:/runtime-tests").await;
        let sender = seed_conversation(&db, folder, AgentType::Codex).await;
        let recipient = seed_conversation(&db, folder, AgentType::Codex).await;
        conversation::Entity::update_many()
            .col_expr(conversation::Column::ParentId, Expr::value(sender))
            .col_expr(conversation::Column::Kind, Expr::value("delegate"))
            .filter(conversation::Column::Id.eq(recipient))
            .exec(&db.conn)
            .await
            .unwrap();
        let manager = Arc::new(ConnectionManager::new());
        manager
            .insert_test_connection(
                "recipient",
                AgentType::Codex,
                None,
                crate::web::event_bridge::EventEmitter::Noop,
            )
            .await;
        manager
            .get_state("recipient")
            .await
            .unwrap()
            .write()
            .await
            .conversation_id = Some(recipient);
        let spawner = Arc::new(crate::acp::delegation::spawner::mock::MockSpawner::new());
        let broker = Arc::new(DelegationBroker::new(spawner, Arc::new(NoDepth)));
        (
            AcpSessionRuntime::new(manager, broker, Arc::new(db), Arc::new(PathBuf::new())),
            sender,
            recipient,
        )
    }

    #[tokio::test]
    async fn prepare_rechecks_disabled_config_even_for_live_child() {
        let (runtime, sender, recipient) = fixture().await;
        assert!(runtime
            .prepare("sender", sender, recipient)
            .await
            .unwrap_err()
            .contains("disabled"));
        let mut config = runtime.broker.config_snapshot().await;
        config.enabled = true;
        runtime.broker.set_config(config.clone()).await;
        runtime.prepare("sender", sender, recipient).await.unwrap();
        config.enabled = false;
        runtime.broker.set_config(config).await;
        assert!(runtime
            .prepare("sender", sender, recipient)
            .await
            .unwrap_err()
            .contains("disabled"));
    }

    #[tokio::test]
    async fn runtime_accepts_regular_sessions_and_rejects_deleted_senders() {
        use sea_orm::sea_query::Expr;
        let (runtime, sender, recipient) = fixture().await;
        assert!(runtime.session_target(sender, recipient).await.is_ok());
        conversation::Entity::update_many()
            .col_expr(conversation::Column::Kind, Expr::value("regular"))
            .filter(conversation::Column::Id.eq(recipient))
            .exec(&runtime.db.conn)
            .await
            .unwrap();
        assert!(runtime.session_target(sender, recipient).await.is_ok());
        conversation::Entity::update_many()
            .col_expr(conversation::Column::Kind, Expr::value("delegate"))
            .filter(conversation::Column::Id.eq(recipient))
            .exec(&runtime.db.conn)
            .await
            .unwrap();
        conversation::Entity::update_many()
            .col_expr(
                conversation::Column::DeletedAt,
                Expr::value(chrono::Utc::now()),
            )
            .filter(conversation::Column::Id.eq(sender))
            .exec(&runtime.db.conn)
            .await
            .unwrap();
        assert!(runtime.session_target(sender, recipient).await.is_err());
    }

    #[tokio::test]
    async fn result_ignores_old_completion_and_other_turn_text() {
        let (tx, mut rx) = broadcast::channel(16);
        let send = |payload| {
            tx.send(Arc::new(EventEnvelope {
                seq: 0,
                connection_id: "recipient".into(),
                payload,
            }))
            .unwrap()
        };
        send(AcpEvent::ContentDelta {
            text: "old output".into(),
            parent_tool_use_id: None,
        });
        send(AcpEvent::TurnComplete {
            session_id: "original".into(),
            stop_reason: "cancelled".into(),
            agent_type: "codex".into(),
        });
        send(AcpEvent::UserMessage {
            message_id: "ticket".into(),
            blocks: vec![],
        });
        send(AcpEvent::ContentDelta {
            text: "new output".into(),
            parent_tool_use_id: None,
        });
        send(AcpEvent::ContentDelta {
            text: "nested output".into(),
            parent_tool_use_id: Some("tool".into()),
        });
        send(AcpEvent::TurnComplete {
            session_id: "original".into(),
            stop_reason: "end_turn".into(),
            agent_type: "codex".into(),
        });
        let result = collect_turn("ticket", &mut rx).await.unwrap();
        assert_eq!(result.status, "completed");
        assert_eq!(result.text.as_deref(), Some("new output"));
    }

    #[tokio::test]
    async fn cancellation_settles_the_ticket_as_canceled() {
        let (tx, mut rx) = broadcast::channel(4);
        for payload in [
            AcpEvent::UserMessage {
                message_id: "ticket".into(),
                blocks: vec![],
            },
            AcpEvent::TurnComplete {
                session_id: "original".into(),
                stop_reason: "cancelled".into(),
                agent_type: "codex".into(),
            },
        ] {
            tx.send(Arc::new(EventEnvelope {
                seq: 0,
                connection_id: "recipient".into(),
                payload,
            }))
            .unwrap();
        }
        assert_eq!(
            collect_turn("ticket", &mut rx).await.unwrap().status,
            "canceled"
        );
    }
}
