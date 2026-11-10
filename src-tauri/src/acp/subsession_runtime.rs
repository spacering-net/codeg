//! ACP adapter for messages delivered into existing direct child conversations.
use crate::acp::{
    delegation::broker::DelegationBroker,
    manager::{ConnectionManager, ConnectionManagerSpawner},
    subsession_messages::{SubsessionRuntime, SubsessionTurn, SubsessionTurnResult},
    types::{AcpEvent, ConnectionStatus, EventEnvelope, PromptInputBlock},
};
use crate::db::{
    entities::{conversation, folder, subsession_message},
    AppDatabase,
};
use crate::models::{agent::AgentType, assistant::AssistantRunSnapshot};
use async_trait::async_trait;
use sea_orm::{ColumnTrait, EntityTrait, QueryFilter};
use std::{collections::HashMap, path::PathBuf, sync::Arc};
use tokio::sync::{broadcast, Mutex};

type PendingTurn = (String, broadcast::Receiver<Arc<EventEnvelope>>);

pub struct AcpSubsessionRuntime {
    manager: Arc<ConnectionManager>,
    broker: Arc<DelegationBroker>,
    db: Arc<AppDatabase>,
    data_dir: Arc<PathBuf>,
    preparation_locks: Mutex<HashMap<i32, Arc<Mutex<()>>>>,
    prepared_connections: Mutex<HashMap<i32, String>>,
    turns: Mutex<HashMap<String, PendingTurn>>,
}

impl AcpSubsessionRuntime {
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

    async fn child(&self, parent: i32, child: i32) -> Result<conversation::Model, String> {
        let parent = conversation::Entity::find_by_id(parent)
            .one(&self.db.conn)
            .await
            .map_err(|e| e.to_string())?
            .filter(|r| r.deleted_at.is_none())
            .ok_or("parent conversation is unavailable")?;
        let row = conversation::Entity::find_by_id(child)
            .one(&self.db.conn)
            .await
            .map_err(|e| e.to_string())?
            .filter(|r| {
                r.deleted_at.is_none()
                    && r.parent_id == Some(parent.id)
                    && r.kind == conversation::ConversationKind::Delegate
            })
            .ok_or("conversation is not a direct child of this parent")?;
        Ok(row)
    }

    async fn recovered_dead_owner(&self, row: &conversation::Model) -> Result<bool, String> {
        use subsession_message::{Column, Entity};
        let claims = Entity::find()
            .filter(Column::ParentConversationId.eq(row.parent_id))
            .filter(Column::ChildConversationId.eq(row.id))
            .filter(Column::Status.is_in(["running", "dispatching", "interrupted"]))
            .all(&self.db.conn)
            .await
            .map_err(|e| e.to_string())?;
        let mut recovered = false;
        for claim in claims {
            let Some(pid) = claim.owner_pid.and_then(|pid| u32::try_from(pid).ok()) else {
                continue;
            };
            let dead = crate::cli_run::discovery::pid_is_dead(pid);
            if claim.status != "interrupted" && pid != std::process::id() && !dead {
                return Ok(false);
            }
            if claim.status == "interrupted" && dead && claim.updated_at >= row.updated_at {
                recovered = true;
            }
        }
        Ok(recovered)
    }

    async fn connection(&self, child: i32) -> Result<String, String> {
        if let Some(conn) = self.manager.find_connection_by_conversation_id(child).await {
            return Ok(conn);
        }
        let prepared = self.prepared_connections.lock().await.get(&child).cloned();
        if let Some(conn) = prepared {
            if self.manager.get_state(&conn).await.is_some() {
                return Ok(conn);
            }
        }
        Err("child session is unavailable on this runtime".into())
    }

    async fn owner(&self, requested: &str, parent: i32) -> Result<String, String> {
        if let Some(state) = self.manager.get_state(requested).await {
            if state.read().await.conversation_id == Some(parent) {
                return Ok(requested.into());
            }
        }
        self.manager
            .find_connection_by_conversation_id(parent)
            .await
            .ok_or_else(|| "parent has no available runtime owner; continuation paused".into())
    }
}

#[async_trait]
impl SubsessionRuntime for AcpSubsessionRuntime {
    async fn prepare(
        &self,
        parent_connection_id: &str,
        parent: i32,
        child: i32,
    ) -> Result<(), String> {
        let preparation = self
            .preparation_locks
            .lock()
            .await
            .entry(child)
            .or_default()
            .clone();
        let _preparation = preparation.lock().await;
        if !self.broker.config_snapshot().await.enabled {
            return Err("delegation is disabled; child message delivery paused".into());
        }
        let row = self.child(parent, child).await?;
        let original_turn = if let Ok(conn) = self.connection(child).await {
            if let Some(state) = self.manager.get_state(&conn).await {
                let state = state.read().await;
                state.turn_in_flight.then_some(state.turns_completed)
            } else {
                None
            }
        } else {
            None
        };
        self.broker
            .retain_child_for_messaging(child, original_turn)
            .await;
        if self.connection(child).await.is_ok() {
            return Ok(());
        }
        if row.status == conversation::ConversationStatus::InProgress
            && !self.recovered_dead_owner(&row).await?
        {
            return Err("child is marked running but has no local connection; its runtime ownership is unknown, continuation paused".into());
        }
        let owner = self.owner(parent_connection_id, parent).await?;
        let external = row
            .external_id
            .as_deref()
            .filter(|s| !s.is_empty())
            .ok_or("child has no recorded agent session to resume")?;
        let agent =
            AgentType::from_wire(&row.agent_type).ok_or("child agent type is unavailable")?;
        let folder = folder::Entity::find_by_id(row.folder_id)
            .one(&self.db.conn)
            .await
            .map_err(|e| e.to_string())?
            .ok_or("child project folder no longer exists")?;
        let working_dir = row.origin_cwd.clone().unwrap_or(folder.path);
        let defaults = if row.assistant_id.is_some() {
            let snapshot: AssistantRunSnapshot = serde_json::from_str(
                row.assistant_snapshot
                    .as_deref()
                    .ok_or("child assistant settings are missing")?,
            )
            .map_err(|e| format!("child assistant settings cannot be restored: {e}"))?;
            snapshot.agent_options
        } else {
            self.broker
                .config_snapshot()
                .await
                .agent_defaults
                .get(&agent)
                .cloned()
                .unwrap_or_default()
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
            .insert(child, spawned.connection_id);
        Ok(())
    }

    async fn is_busy(&self, child: i32) -> Result<bool, String> {
        let conn = self.connection(child).await?;
        let state = self
            .manager
            .get_state(&conn)
            .await
            .ok_or("child connection disappeared")?;
        let state = state.read().await;
        Ok(state.turn_in_flight || state.status == ConnectionStatus::Prompting)
    }

    async fn wait_idle(&self, child: i32) -> Result<(), String> {
        let conn = self.connection(child).await?;
        let state = self
            .manager
            .get_state(&conn)
            .await
            .ok_or("child connection disappeared")?;
        let mut events = state.read().await.event_stream().subscribe();
        while self.is_busy(child).await? {
            events
                .recv()
                .await
                .map_err(|e| format!("child event stream unavailable: {e}"))?;
        }
        self.manager.wait_prompt_quiescence(&conn).await?;
        self.manager.wait_turn_lifecycle(&conn).await
    }

    async fn start(
        &self,
        parent_connection_id: &str,
        parent: i32,
        child: i32,
        message: String,
    ) -> Result<SubsessionTurn, String> {
        self.prepare(parent_connection_id, parent, child).await?;
        let row = self.child(parent, child).await?;
        let conn = self.connection(child).await?;
        if self.is_busy(child).await? {
            return Err("child still has an active turn".into());
        }
        self.manager.wait_prompt_quiescence(&conn).await?;
        self.manager.wait_turn_lifecycle(&conn).await?;
        let state = self
            .manager
            .get_state(&conn)
            .await
            .ok_or("child connection disappeared")?;
        let events = state.read().await.event_stream().subscribe();
        let id = uuid::Uuid::new_v4().to_string();
        self.manager
            .send_prompt_linked_with_message_id(
                &self.db,
                &conn,
                vec![PromptInputBlock::Text { text: message }],
                Some(row.folder_id),
                Some(child),
                None,
                Some(id.clone()),
            )
            .await
            .map_err(|e| e.to_string())?;
        self.turns.lock().await.insert(id.clone(), (conn, events));
        Ok(SubsessionTurn { id })
    }

    async fn steer(&self, child: i32, message: String) -> Result<bool, String> {
        let conn = self.connection(child).await?;
        let state = self
            .manager
            .get_state(&conn)
            .await
            .ok_or("child connection disappeared")?;
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

    async fn interrupt(&self, child: i32) -> Result<(), String> {
        let conn = self.connection(child).await?;
        self.manager.cancel_and_wait(&self.db.conn, &conn).await?;
        self.manager.wait_turn_lifecycle(&conn).await
    }

    async fn wait(&self, turn: SubsessionTurn) -> Result<SubsessionTurnResult, String> {
        let (conn, mut events) = self
            .turns
            .lock()
            .await
            .remove(&turn.id)
            .ok_or("unknown or already consumed child turn")?;
        let result = collect_turn(&turn.id, &mut events).await?;
        self.manager.wait_turn_lifecycle(&conn).await?;
        Ok(result)
    }
}

async fn collect_turn(
    turn_id: &str,
    events: &mut broadcast::Receiver<Arc<EventEnvelope>>,
) -> Result<SubsessionTurnResult, String> {
    let mut started = false;
    let mut text = String::new();
    let mut error = None;
    loop {
        let envelope = events
            .recv()
            .await
            .map_err(|e| format!("child turn event stream unavailable: {e}"))?;
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
                return Ok(SubsessionTurnResult {
                    status: status.into(),
                    text: (!text.is_empty()).then_some(text),
                    error,
                });
            }
            AcpEvent::StatusChanged {
                status: ConnectionStatus::Disconnected | ConnectionStatus::Error,
            } => {
                return Ok(SubsessionTurnResult {
                    status: "failed".into(),
                    text: (!text.is_empty()).then_some(text),
                    error: error.or_else(|| {
                        Some("child connection ended before its turn completed".into())
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

    async fn fixture() -> (AcpSubsessionRuntime, i32, i32) {
        use crate::db::test_helpers::{fresh_in_memory_db, seed_conversation, seed_folder};
        use sea_orm::sea_query::Expr;
        let db = fresh_in_memory_db().await;
        let folder = seed_folder(&db, "D:/runtime-tests").await;
        let parent = seed_conversation(&db, folder, AgentType::Codex).await;
        let child = seed_conversation(&db, folder, AgentType::Codex).await;
        conversation::Entity::update_many()
            .col_expr(conversation::Column::ParentId, Expr::value(parent))
            .col_expr(conversation::Column::Kind, Expr::value("delegate"))
            .filter(conversation::Column::Id.eq(child))
            .exec(&db.conn)
            .await
            .unwrap();
        let manager = Arc::new(ConnectionManager::new());
        manager
            .insert_test_connection(
                "child",
                AgentType::Codex,
                None,
                crate::web::event_bridge::EventEmitter::Noop,
            )
            .await;
        manager
            .get_state("child")
            .await
            .unwrap()
            .write()
            .await
            .conversation_id = Some(child);
        let spawner = Arc::new(crate::acp::delegation::spawner::mock::MockSpawner::new());
        let broker = Arc::new(DelegationBroker::new(spawner, Arc::new(NoDepth)));
        (
            AcpSubsessionRuntime::new(manager, broker, Arc::new(db), Arc::new(PathBuf::new())),
            parent,
            child,
        )
    }

    #[tokio::test]
    async fn restart_resume_requires_recovered_dead_owner_not_just_missing_connection() {
        use crate::db::service::subsession_message_service;
        use sea_orm::sea_query::Expr;
        let (runtime, parent, child) = fixture().await;
        let row = runtime.child(parent, child).await.unwrap();
        assert!(!runtime.recovered_dead_owner(&row).await.unwrap());
        let message =
            subsession_message_service::enqueue(&runtime.db.conn, parent, child, "old", "queue")
                .await
                .unwrap();
        subsession_message::Entity::update_many()
            .col_expr(
                subsession_message::Column::Status,
                Expr::value("interrupted"),
            )
            .col_expr(
                subsession_message::Column::OwnerPid,
                Expr::value(i64::from(u32::MAX)),
            )
            .filter(subsession_message::Column::Id.eq(message.id))
            .exec(&runtime.db.conn)
            .await
            .unwrap();
        assert!(runtime.recovered_dead_owner(&row).await.unwrap());
        subsession_message::Entity::update_many()
            .col_expr(
                subsession_message::Column::OwnerPid,
                Expr::value(i64::from(std::process::id())),
            )
            .filter(subsession_message::Column::Id.eq(message.id))
            .exec(&runtime.db.conn)
            .await
            .unwrap();
        assert!(!runtime.recovered_dead_owner(&row).await.unwrap());
    }

    #[tokio::test]
    async fn prepare_rechecks_disabled_config_even_for_live_child() {
        let (runtime, parent, child) = fixture().await;
        assert!(runtime
            .prepare("parent", parent, child)
            .await
            .unwrap_err()
            .contains("disabled"));
        let mut config = runtime.broker.config_snapshot().await;
        config.enabled = true;
        runtime.broker.set_config(config.clone()).await;
        runtime.prepare("parent", parent, child).await.unwrap();
        config.enabled = false;
        runtime.broker.set_config(config).await;
        assert!(runtime
            .prepare("parent", parent, child)
            .await
            .unwrap_err()
            .contains("disabled"));
    }

    #[tokio::test]
    async fn runtime_rejects_deleted_parent_and_non_delegate_child() {
        use sea_orm::sea_query::Expr;
        let (runtime, parent, child) = fixture().await;
        assert!(runtime.child(parent, child).await.is_ok());
        conversation::Entity::update_many()
            .col_expr(conversation::Column::Kind, Expr::value("regular"))
            .filter(conversation::Column::Id.eq(child))
            .exec(&runtime.db.conn)
            .await
            .unwrap();
        assert!(runtime.child(parent, child).await.is_err());
        conversation::Entity::update_many()
            .col_expr(conversation::Column::Kind, Expr::value("delegate"))
            .filter(conversation::Column::Id.eq(child))
            .exec(&runtime.db.conn)
            .await
            .unwrap();
        conversation::Entity::update_many()
            .col_expr(
                conversation::Column::DeletedAt,
                Expr::value(chrono::Utc::now()),
            )
            .filter(conversation::Column::Id.eq(parent))
            .exec(&runtime.db.conn)
            .await
            .unwrap();
        assert!(runtime.child(parent, child).await.is_err());
    }

    #[tokio::test]
    async fn result_ignores_old_completion_and_other_turn_text() {
        let (tx, mut rx) = broadcast::channel(16);
        let send = |payload| {
            tx.send(Arc::new(EventEnvelope {
                seq: 0,
                connection_id: "child".into(),
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
                connection_id: "child".into(),
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
