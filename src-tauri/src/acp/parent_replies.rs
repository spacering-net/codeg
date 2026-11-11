//! A child's explicit report wakes its parent after the parent's current turn.
use crate::{
    acp::subsession_messages::{SubsessionTurn, SubsessionTurnResult},
    db::{entities::parent_reply::Model, service::parent_reply_service as inbox, AppDatabase},
};
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
    time::Duration,
};
use tokio::sync::Mutex;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ParentReplyOutcome {
    pub accepted: bool,
    pub message: Option<Model>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl ParentReplyOutcome {
    pub fn refused(error: impl Into<String>) -> Self {
        Self {
            accepted: false,
            message: None,
            error: Some(error.into()),
        }
    }
}

#[async_trait]
pub trait ParentReplyRuntime: Send + Sync {
    /// Wait for an available parent, including its prompt/lifecycle barriers.
    async fn wait_ready(&self, message: &Model) -> Result<(), String>;
    /// None means a user's prompt won the race: keep the report queued.
    async fn start(&self, message: &Model) -> Result<Option<SubsessionTurn>, String>;
    async fn wait(&self, turn: SubsessionTurn) -> Result<SubsessionTurnResult, String>;
    async fn enabled(&self) -> bool;
}

#[derive(Clone)]
pub struct ParentReplies {
    db: Arc<AppDatabase>,
    runtime: Arc<dyn ParentReplyRuntime>,
    workers: Arc<Mutex<HashMap<i32, Arc<AtomicU64>>>>,
}

impl ParentReplies {
    pub fn new(db: Arc<AppDatabase>, runtime: Arc<dyn ParentReplyRuntime>) -> Self {
        Self {
            db,
            runtime,
            workers: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub fn recover_pending(&self) {
        let service = self.clone();
        let recovery = async move {
            match inbox::recover(&service.db.conn).await {
                Ok(parents) => {
                    for parent in parents {
                        service.wake(parent).await;
                    }
                }
                Err(e) => tracing::warn!(%e, "parent reply recovery failed"),
            }
        };
        // Desktop setup is synchronous and runs outside a Tokio context.
        #[cfg(feature = "tauri-runtime")]
        tauri::async_runtime::spawn(recovery);
        #[cfg(not(feature = "tauri-runtime"))]
        tokio::spawn(recovery);
    }

    pub async fn send(&self, child: i32, message: String) -> ParentReplyOutcome {
        if !self.runtime.enabled().await {
            return ParentReplyOutcome::refused("Delegation is disabled");
        }
        match inbox::enqueue(&self.db.conn, child, message.trim()).await {
            Ok(row) => {
                self.wake(row.parent_conversation_id).await;
                ParentReplyOutcome {
                    accepted: true,
                    message: Some(row),
                    error: None,
                }
            }
            Err(e) => ParentReplyOutcome::refused(e.to_string()),
        }
    }

    async fn wake(&self, parent: i32) {
        let mut workers = self.workers.lock().await;
        if let Some(revision) = workers.get(&parent) {
            revision.fetch_add(1, Ordering::AcqRel);
            return;
        }
        let revision = Arc::new(AtomicU64::new(0));
        workers.insert(parent, revision.clone());
        drop(workers);
        let service = self.clone();
        tokio::spawn(async move {
            loop {
                let observed = revision.load(Ordering::Acquire);
                match service.run(parent).await {
                    Ok(()) => return,
                    Err(e) => {
                        tracing::warn!(parent, %e, "parent reply dispatcher paused");
                        let mut workers = service.workers.lock().await;
                        if revision.load(Ordering::Acquire) != observed {
                            continue;
                        }
                        workers.remove(&parent);
                        return;
                    }
                }
            }
        });
    }

    async fn run(&self, parent: i32) -> Result<(), String> {
        loop {
            let Some(row) = inbox::next(&self.db.conn, parent)
                .await
                .map_err(|e| e.to_string())?
            else {
                let mut workers = self.workers.lock().await;
                if inbox::next(&self.db.conn, parent)
                    .await
                    .map_err(|e| e.to_string())?
                    .is_none()
                {
                    workers.remove(&parent);
                    return Ok(());
                }
                continue;
            };
            if let Err(e) = self.runtime.wait_ready(&row).await {
                inbox::fail_queued(&self.db.conn, &row.message_id, &e)
                    .await
                    .map_err(|e| e.to_string())?;
                continue;
            }
            let claimed = match inbox::claim(&self.db.conn, &row).await {
                Ok(claimed) => claimed,
                Err(e) => {
                    inbox::fail_queued(&self.db.conn, &row.message_id, &e.to_string())
                        .await
                        .map_err(|e| e.to_string())?;
                    continue;
                }
            };
            if !claimed {
                // A different runtime may own a report from another child.
                inbox::recover(&self.db.conn)
                    .await
                    .map_err(|e| e.to_string())?;
                tokio::time::sleep(Duration::from_millis(250)).await;
                continue;
            }
            let result = match self.runtime.start(&row).await {
                Ok(None) => {
                    inbox::finish(&self.db.conn, &row.message_id, "queued", None, None)
                        .await
                        .map_err(|e| e.to_string())?;
                    continue;
                }
                Ok(Some(turn)) => self.runtime.wait(turn).await,
                Err(e) => Err(e),
            }
            .unwrap_or_else(|e| SubsessionTurnResult {
                status: "failed".into(),
                text: None,
                error: Some(e),
            });
            // Once the prompt ran, retry only persistence, never execution.
            loop {
                match inbox::finish(
                    &self.db.conn,
                    &row.message_id,
                    &result.status,
                    result.text.as_deref(),
                    result.error.as_deref(),
                )
                .await
                {
                    Ok(()) => break,
                    Err(e) => {
                        tracing::warn!(%e, message_id = %row.message_id, "parent reply result persistence delayed");
                        tokio::time::sleep(Duration::from_secs(1)).await;
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        db::{
            entities::conversation,
            test_helpers::{fresh_in_memory_db, seed_conversation, seed_folder},
        },
        models::AgentType,
    };
    use sea_orm::sea_query::Expr;
    use sea_orm::{ColumnTrait, EntityTrait, QueryFilter};
    use std::sync::atomic::{AtomicBool, Ordering};
    use tokio::sync::Notify;

    struct Runtime {
        busy: AtomicBool,
        race_once: AtomicBool,
        changed: Notify,
        sent: Mutex<Vec<String>>,
    }
    #[async_trait]
    impl ParentReplyRuntime for Runtime {
        async fn wait_ready(&self, _: &Model) -> Result<(), String> {
            loop {
                let wait = self.changed.notified();
                if !self.busy.load(Ordering::Acquire) {
                    return Ok(());
                }
                wait.await;
            }
        }
        async fn start(&self, row: &Model) -> Result<Option<SubsessionTurn>, String> {
            if self.race_once.swap(false, Ordering::AcqRel) {
                return Ok(None);
            }
            self.sent.lock().await.push(row.message.clone());
            Ok(Some(SubsessionTurn {
                id: row.message_id.clone(),
            }))
        }
        async fn wait(&self, _: SubsessionTurn) -> Result<SubsessionTurnResult, String> {
            Ok(SubsessionTurnResult {
                status: "completed".into(),
                text: Some("parent handled report".into()),
                error: None,
            })
        }
        async fn enabled(&self) -> bool {
            true
        }
    }

    #[tokio::test]
    async fn child_reports_queue_while_parent_busy_then_wake_in_order_and_survive_send_race() {
        let db = Arc::new(fresh_in_memory_db().await);
        let folder = seed_folder(&db, "D:/parent-reply").await;
        let parent = seed_conversation(&db, folder, AgentType::Codex).await;
        let child = seed_conversation(&db, folder, AgentType::Codex).await;
        let sibling = seed_conversation(&db, folder, AgentType::Codex).await;
        conversation::Entity::update_many()
            .col_expr(conversation::Column::ParentId, Expr::value(parent))
            .col_expr(conversation::Column::Kind, Expr::value("delegate"))
            .filter(conversation::Column::Id.is_in([child, sibling]))
            .exec(&db.conn)
            .await
            .unwrap();
        let runtime = Arc::new(Runtime {
            busy: AtomicBool::new(true),
            race_once: AtomicBool::new(true),
            changed: Notify::new(),
            sent: Mutex::new(Vec::new()),
        });
        let service = ParentReplies::new(db.clone(), runtime.clone());
        assert!(!service.send(parent, "not a child".into()).await.accepted);
        let a = service
            .send(child, "first report".into())
            .await
            .message
            .unwrap();
        let b = service
            .send(sibling, "second report".into())
            .await
            .message
            .unwrap();
        tokio::task::yield_now().await;
        assert_eq!(
            inbox::get(&db.conn, &a.message_id)
                .await
                .unwrap()
                .unwrap()
                .status,
            "queued"
        );
        assert!(runtime.sent.lock().await.is_empty());
        runtime.busy.store(false, Ordering::Release);
        runtime.changed.notify_one();
        tokio::time::timeout(Duration::from_secs(3), async {
            loop {
                if inbox::get(&db.conn, &b.message_id)
                    .await
                    .unwrap()
                    .unwrap()
                    .status
                    == "completed"
                {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert_eq!(
            *runtime.sent.lock().await,
            ["first report", "second report"]
        );
        assert_eq!(
            inbox::get(&db.conn, &a.message_id)
                .await
                .unwrap()
                .unwrap()
                .result
                .as_deref(),
            Some("parent handled report")
        );
    }
}
