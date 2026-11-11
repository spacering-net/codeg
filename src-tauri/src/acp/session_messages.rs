//! Persistent messages addressed to an existing conversation.

use std::{
    collections::HashMap,
    future::Future,
    pin::Pin,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
};

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use tokio::sync::{Mutex, Notify, RwLock};

use crate::db::{
    entities::session_message::Model, service::session_message_service as messages, AppDatabase,
};

type ActiveTurn = (
    String,
    Pin<Box<dyn Future<Output = Result<SessionTurnResult, String>> + Send>>,
);

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionDelivery {
    Immediate,
    #[default]
    Queue,
}

impl SessionDelivery {
    fn as_str(self) -> &'static str {
        match self {
            Self::Immediate => "immediate",
            Self::Queue => "queue",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionMessageAction {
    Send,
    List,
    Update,
    Cancel,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SessionMessageRequest {
    pub conversation_id: i32,
    pub action: SessionMessageAction,
    pub message: Option<String>,
    pub message_id: Option<String>,
    #[serde(default)]
    pub delivery: SessionDelivery,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionMessageOutcome {
    pub accepted: bool,
    pub messages: Vec<Model>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

impl SessionMessageOutcome {
    pub fn refused(code: &str, message: &str) -> Self {
        Self {
            accepted: false,
            messages: Vec::new(),
            error_code: Some(code.into()),
            message: Some(message.into()),
        }
    }

    fn accepted(messages: Vec<Model>) -> Self {
        Self {
            accepted: true,
            messages,
            error_code: None,
            message: None,
        }
    }
}

#[async_trait]
pub trait SessionMessageAccess: Send + Sync {
    async fn wake_pending(&self, _recipient: i32) {}

    async fn request(
        &self,
        sender_connection_id: &str,
        sender_conversation_id: i32,
        request: SessionMessageRequest,
    ) -> SessionMessageOutcome;
}

pub struct NoSessionMessages;

#[async_trait]
impl SessionMessageAccess for NoSessionMessages {
    async fn request(&self, _: &str, _: i32, _: SessionMessageRequest) -> SessionMessageOutcome {
        SessionMessageOutcome::refused("unavailable", "Session messages are unavailable")
    }
}

#[derive(Debug, Clone)]
pub struct SessionTurn {
    pub id: String,
}

#[derive(Debug, thiserror::Error)]
pub enum SessionStartError {
    #[error("turn already in progress")]
    Busy,
    #[error("{0}")]
    Failed(String),
}

impl From<String> for SessionStartError {
    fn from(error: String) -> Self {
        Self::Failed(error)
    }
}
impl From<&str> for SessionStartError {
    fn from(error: &str) -> Self {
        Self::Failed(error.into())
    }
}

#[derive(Debug, Clone)]
pub struct SessionTurnResult {
    pub status: String,
    pub text: Option<String>,
    pub error: Option<String>,
}

#[async_trait]
pub trait SessionRuntime: Send + Sync {
    fn message_from(&self, _sender: i32, _recipient: i32, message: String) -> String {
        message
    }

    async fn prepare(
        &self,
        sender_connection_id: &str,
        sender: i32,
        recipient: i32,
    ) -> Result<(), String>;
    async fn is_busy(&self, recipient: i32) -> Result<bool, String>;
    async fn wait_idle(&self, recipient: i32) -> Result<(), String>;
    async fn start(
        &self,
        sender_connection_id: &str,
        sender: i32,
        recipient: i32,
        message: String,
    ) -> Result<SessionTurn, SessionStartError>;
    async fn steer(&self, recipient: i32, message: String) -> Result<bool, String>;
    async fn interrupt(&self, recipient: i32) -> Result<(), String>;
    async fn wait(&self, turn: SessionTurn) -> Result<SessionTurnResult, String>;
}

struct Worker {
    wake: Arc<Notify>,
    sender_connection_id: Arc<RwLock<String>>,
    revision: Arc<AtomicU64>,
}

#[derive(Clone)]
pub struct SessionMessages {
    db: Arc<AppDatabase>,
    runtime: Arc<dyn SessionRuntime>,
    workers: Arc<Mutex<HashMap<i32, Worker>>>,
    pending_results: Arc<Mutex<HashMap<String, SessionTurnResult>>>,
}

impl SessionMessages {
    pub fn with_runtime(db: Arc<AppDatabase>, runtime: Arc<dyn SessionRuntime>) -> Self {
        Self {
            db,
            runtime,
            workers: Arc::new(Mutex::new(HashMap::new())),
            pending_results: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    async fn wake_worker(&self, owner: &str, sender: i32, recipient: i32) {
        let mut workers = self.workers.lock().await;
        if let Some(worker) = workers.get(&recipient) {
            *worker.sender_connection_id.write().await = owner.into();
            worker.revision.fetch_add(1, Ordering::AcqRel);
            worker.wake.notify_one();
            return;
        }
        let wake = Arc::new(Notify::new());
        let owner = Arc::new(RwLock::new(owner.to_string()));
        let revision = Arc::new(AtomicU64::new(0));
        workers.insert(
            recipient,
            Worker {
                wake: wake.clone(),
                sender_connection_id: owner.clone(),
                revision: revision.clone(),
            },
        );
        let service = self.clone();
        tokio::spawn(async move {
            loop {
                let observed = revision.load(Ordering::Acquire);
                match service.run(sender, recipient, &wake, &owner).await {
                    Ok(()) => return,
                    Err(error) => {
                        tracing::warn!(recipient, sender, %error, "session message dispatcher paused");
                        let mut workers = service.workers.lock().await;
                        // A sender that found this worker during error cleanup
                        // must get a fresh attempt, rather than a lost wakeup.
                        if revision.load(Ordering::Acquire) != observed {
                            continue;
                        }
                        workers.remove(&recipient);
                        return;
                    }
                }
            }
        });
    }

    async fn finish(
        &self,
        id: &str,
        result: Result<SessionTurnResult, String>,
    ) -> Result<(), String> {
        let result = result.unwrap_or_else(|error| SessionTurnResult {
            status: "failed".into(),
            text: None,
            error: Some(error),
        });
        // Keep a completed result if SQLite is temporarily unavailable. A
        // subsequent worker/request persists it without polling the turn again.
        self.pending_results
            .lock()
            .await
            .insert(id.into(), result.clone());
        self.persist_result(id, &result).await
    }

    async fn persist_result(&self, id: &str, result: &SessionTurnResult) -> Result<(), String> {
        let written = messages::finish(
            &self.db.conn,
            id,
            &result.status,
            result.text.as_deref(),
            result.error.as_deref(),
        )
        .await;
        match written {
            Ok(_) | Err(crate::db::error::DbError::NotFound(_)) => {
                self.pending_results.lock().await.remove(id);
            }
            Err(error) => return Err(error.to_string()),
        }
        Ok(())
    }

    async fn flush_results(&self) -> Result<(), String> {
        let pending: Vec<_> = self
            .pending_results
            .lock()
            .await
            .iter()
            .map(|(id, result)| (id.clone(), result.clone()))
            .collect();
        for (id, result) in pending {
            self.persist_result(&id, &result).await?;
        }
        Ok(())
    }

    async fn start(
        &self,
        owner: &str,
        sender: i32,
        recipient: i32,
        id: &str,
    ) -> Result<Option<ActiveTurn>, String> {
        if !messages::claim(&self.db.conn, id)
            .await
            .map_err(|e| e.to_string())?
        {
            return Ok(None);
        }
        // Read AFTER claiming: an edit that won the race before the claim must
        // be the text sent to ACP, rather than our earlier queue snapshot.
        let message = messages::get(&self.db.conn, sender, recipient, id)
            .await
            .map_err(|e| e.to_string())
            .and_then(|row| row.ok_or_else(|| "claimed message disappeared".to_string()));
        let message = match message {
            Ok(message) => message,
            Err(error) => {
                self.finish(id, Err(error.clone())).await?;
                return Err(error);
            }
        };
        match self
            .runtime
            .start(
                owner,
                sender,
                recipient,
                self.runtime
                    .message_from(sender, recipient, message.message),
            )
            .await
        {
            Ok(turn) => {
                let runtime = self.runtime.clone();
                Ok(Some((
                    id.into(),
                    Box::pin(async move { runtime.wait(turn).await }),
                )))
            }
            Err(SessionStartError::Busy) => {
                messages::release_claim(&self.db.conn, id)
                    .await
                    .map_err(|e| e.to_string())?;
                Ok(None)
            }
            Err(SessionStartError::Failed(error)) => {
                self.finish(id, Err(error)).await?;
                Ok(None)
            }
        }
    }

    async fn run(
        &self,
        sender: i32,
        recipient: i32,
        wake: &Notify,
        owner: &RwLock<String>,
    ) -> Result<(), String> {
        self.flush_results().await?;
        let mut active: Option<ActiveTurn> = None;
        let mut reserved: Option<String> = None;
        let mut failure = self
            .run_loop(sender, recipient, wake, owner, &mut active, &mut reserved)
            .await
            .err();
        if failure.is_some() {
            if let Some((id, completion)) = active.take() {
                if let Err(error) = self.finish(&id, completion.await).await {
                    failure = Some(error);
                }
            }
            if let Some(id) = reserved.take() {
                // Do not replace a delivered/completed result whose terminal
                // write is already waiting for SQLite to become available.
                let has_result = self.pending_results.lock().await.contains_key(&id);
                if !has_result {
                    if let Err(error) = self
                        .finish(&id, Err(failure.clone().unwrap_or_default()))
                        .await
                    {
                        failure = Some(error);
                    }
                }
            }
        }
        failure.map_or(Ok(()), Err)
    }

    async fn run_loop(
        &self,
        sender: i32,
        recipient: i32,
        wake: &Notify,
        owner: &RwLock<String>,
        active: &mut Option<ActiveTurn>,
        reserved: &mut Option<String>,
    ) -> Result<(), String> {
        loop {
            let notified = wake.notified();
            let next = messages::next_queued(&self.db.conn, recipient)
                .await
                .map_err(|e| e.to_string())?;
            if next.as_ref().is_none_or(|m| m.delivery != "immediate") {
                if let Some((id, result)) = active.as_mut() {
                    tokio::select! {
                        result = result.as_mut() => {
                            let id = id.clone();
                            *active = None;
                            self.finish(&id, result).await?;
                        }
                        _ = notified => {}
                    }
                    continue;
                }
            }
            if active.is_none() && next.is_none() {
                // Serialize exit with registration. An enqueue before this
                // recheck is observed here; one after it starts a new worker.
                let mut workers = self.workers.lock().await;
                if messages::next_queued(&self.db.conn, recipient)
                    .await
                    .map_err(|e| e.to_string())?
                    .is_none()
                {
                    workers.remove(&recipient);
                    return Ok(());
                }
                continue;
            }
            let sender = next
                .as_ref()
                .map(|m| m.sender_conversation_id)
                .unwrap_or(sender);
            let owner = owner.read().await.clone();
            if let Err(error) = self.runtime.prepare(&owner, sender, recipient).await {
                // Disabling new work or losing the sender must not abandon the
                // result of a turn we already started.
                if let Some((id, result)) = active.take() {
                    self.finish(&id, result.await).await?;
                }
                return Err(error);
            }
            let busy = self.runtime.is_busy(recipient).await?;
            if let Some(message) = next.as_ref().filter(|m| m.delivery == "immediate" && busy) {
                if !messages::claim_delivery(&self.db.conn, &message.message_id)
                    .await
                    .map_err(|e| e.to_string())?
                {
                    if messages::get(&self.db.conn, sender, recipient, &message.message_id)
                        .await
                        .map_err(|e| e.to_string())?
                        .is_some_and(|m| m.status == "queued")
                    {
                        return Err(
                            "recipient is already being dispatched by another runtime".into()
                        );
                    }
                    continue;
                }
                *reserved = Some(message.message_id.clone());
                let id = message.message_id.clone();
                let message = messages::get(&self.db.conn, sender, recipient, &id)
                    .await
                    .map_err(|e| e.to_string())
                    .and_then(|row| row.ok_or_else(|| "reserved message disappeared".to_string()));
                let message = match message {
                    Ok(message) => message,
                    Err(error) => {
                        self.finish(&id, Err(error.clone())).await?;
                        return Err(error);
                    }
                };
                match self
                    .runtime
                    .steer(
                        recipient,
                        self.runtime
                            .message_from(sender, recipient, message.message.clone()),
                    )
                    .await
                {
                    Ok(true) => {
                        // Delivered means injected into the current turn, not
                        // that the agent has finished following the instruction.
                        self.finish(
                            &message.message_id,
                            Ok(SessionTurnResult {
                                status: "delivered".into(),
                                text: None,
                                error: None,
                            }),
                        )
                        .await?;
                    }
                    Ok(false) => {
                        if let Err(error) = self.runtime.interrupt(recipient).await {
                            self.finish(&message.message_id, Err(error)).await?;
                            *reserved = None;
                            continue;
                        }
                        if let Some((id, result)) = active.take() {
                            self.finish(&id, result.await).await?;
                        }
                        *active = self
                            .start(&owner, sender, recipient, &message.message_id)
                            .await?;
                    }
                    Err(error) => self.finish(&message.message_id, Err(error)).await?,
                }
                *reserved = None;
                continue;
            }
            if let Some((id, result)) = active.as_mut() {
                tokio::select! {
                    result = result.as_mut() => {
                        let id = id.clone();
                        *active = None;
                        self.finish(&id, result).await?;
                    }
                    _ = notified => {}
                }
                continue;
            }
            if busy {
                tokio::select! {
                    result = self.runtime.wait_idle(recipient) => result?,
                    _ = notified => {}
                }
                continue;
            }
            if let Some(message) = next {
                *active = self
                    .start(&owner, sender, recipient, &message.message_id)
                    .await?;
                if active.is_none() {
                    // A different runtime may already own this recipient's running
                    // message. Leave queued work intact for that owner.
                    if messages::has_active(&self.db.conn, recipient)
                        .await
                        .map_err(|e| e.to_string())?
                    {
                        return Err(
                            "recipient is already being dispatched by another runtime".into()
                        );
                    }
                    tokio::time::sleep(std::time::Duration::from_millis(25)).await;
                }
            }
        }
    }
}

#[async_trait]
impl SessionMessageAccess for SessionMessages {
    async fn wake_pending(&self, recipient: i32) {
        if let Err(error) = messages::recover_interrupted(&self.db.conn, recipient).await {
            tracing::warn!(%error, recipient, "session queue recovery paused");
            return;
        }
        if let Ok(Some(row)) = messages::next_queued(&self.db.conn, recipient).await {
            self.wake_worker("", row.sender_conversation_id, recipient)
                .await;
        }
    }

    async fn request(
        &self,
        owner: &str,
        sender: i32,
        request: SessionMessageRequest,
    ) -> SessionMessageOutcome {
        let recipient = request.conversation_id;
        // The broker derives the sender from its authenticated connection.
        if recipient <= 0
            || messages::list(&self.db.conn, sender, recipient)
                .await
                .is_err()
        {
            return SessionMessageOutcome::refused("unavailable", "Session is unavailable");
        }
        if let Err(error) = self.flush_results().await {
            return SessionMessageOutcome::refused("storage_error", &error);
        }
        let operation = async {
            let message = request
                .message
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty());
            let id = request.message_id.as_deref().filter(|s| !s.is_empty());
            match request.action {
                SessionMessageAction::Send => {
                    let text = message
                        .ok_or_else(|| ("invalid_message", "Message is empty".to_string()))?;
                    // prepare also checks the live delegation gate and establishes
                    // ownership before the original one-shot broker can retire it.
                    self.runtime
                        .prepare(owner, sender, recipient)
                        .await
                        .map_err(|e| ("unavailable", e))?;
                    messages::recover_interrupted(&self.db.conn, recipient)
                        .await
                        .map_err(|e| ("storage_error", e.to_string()))?;
                    let row = messages::enqueue(
                        &self.db.conn,
                        sender,
                        recipient,
                        text,
                        request.delivery.as_str(),
                    )
                    .await
                    .map_err(|e| ("storage_error", e.to_string()))?;
                    self.wake_worker(owner, sender, recipient).await;
                    Ok(vec![row])
                }
                SessionMessageAction::List => {
                    messages::recover_interrupted(&self.db.conn, recipient)
                        .await
                        .map_err(|e| ("storage_error", e.to_string()))?;
                    let rows = messages::list(&self.db.conn, sender, recipient)
                        .await
                        .map_err(|e| ("storage_error", e.to_string()))?;
                    if rows.iter().any(|r| r.status == "queued") {
                        self.wake_worker(owner, sender, recipient).await;
                    }
                    Ok(rows)
                }
                SessionMessageAction::Update | SessionMessageAction::Cancel => {
                    let id = id.ok_or_else(|| {
                        ("invalid_message_id", "Message id is required".to_string())
                    })?;
                    let row = if request.action == SessionMessageAction::Update {
                        let text = message
                            .ok_or_else(|| ("invalid_message", "Message is empty".to_string()))?;
                        messages::update_queued(&self.db.conn, sender, recipient, id, text).await
                    } else {
                        messages::cancel_queued(&self.db.conn, sender, recipient, id).await
                    }
                    .map_err(|e| ("storage_error", e.to_string()))?;
                    let Some(row) = row else {
                        return Err((
                            "not_queued",
                            "Message is missing or has already started; refresh its status"
                                .to_string(),
                        ));
                    };
                    self.wake_worker(owner, sender, recipient).await;
                    Ok(vec![row])
                }
            }
        }
        .await;
        match operation {
            Ok(rows) => SessionMessageOutcome::accepted(rows),
            Err((code, message)) => SessionMessageOutcome::refused(code, &message),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        db::{
            entities::conversation,
            service::session_message_service as messages,
            test_helpers::{fresh_in_memory_db, seed_conversation, seed_folder},
        },
        models::AgentType,
    };
    use sea_orm::sea_query::Expr;
    use sea_orm::{ColumnTrait, EntityTrait, QueryFilter};
    use tokio::sync::oneshot;

    #[tokio::test]
    async fn opening_a_recipient_reawakens_persisted_messages_without_sender_polling() {
        let (service, runtime, sender, recipient) = setup(false, false).await;
        let row = messages::enqueue(&service.db.conn, sender, recipient, "persisted", "queue")
            .await
            .unwrap();
        assert!(runtime.sent.lock().await.is_empty());
        service.wake_pending(recipient).await;
        tokio::time::timeout(std::time::Duration::from_secs(3), async {
            while runtime.sent.lock().await.is_empty() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("persisted prompt was dispatched");
        runtime.complete("completed").await;
        wait_for_status(&service, sender, recipient, &row.message_id, "completed").await;
        assert_eq!(*runtime.sent.lock().await, ["persisted"]);
    }

    #[tokio::test]
    async fn ordinary_session_messages_share_target_queue_and_keep_sender_ownership() {
        let (service, runtime, sender, target) = setup(true, false).await;
        conversation::Entity::update_many()
            .col_expr(
                conversation::Column::ParentId,
                Expr::value(Option::<i32>::None),
            )
            .col_expr(conversation::Column::Kind, Expr::value("regular"))
            .filter(conversation::Column::Id.eq(target))
            .exec(&service.db.conn)
            .await
            .unwrap();
        let target_row = conversation::Entity::find_by_id(target)
            .one(&service.db.conn)
            .await
            .unwrap()
            .unwrap();
        let other = seed_conversation(&service.db, target_row.folder_id, AgentType::Codex).await;
        let make = |text: &str| {
            request(
                target,
                SessionMessageAction::Send,
                Some(text),
                None,
                SessionDelivery::Queue,
            )
        };
        let first = service.request("sender", sender, make("first")).await;
        let second = service.request("other", other, make("second")).await;
        assert!(first.accepted && second.accepted);
        let cancel = request(
            target,
            SessionMessageAction::Cancel,
            None,
            Some(&first.messages[0].message_id),
            SessionDelivery::Queue,
        );
        assert!(!service.request("other", other, cancel).await.accepted);
        runtime.complete("completed").await;
        tokio::time::timeout(std::time::Duration::from_secs(3), async {
            loop {
                if runtime.sent.lock().await.len() == 1 {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert_eq!(*runtime.sent.lock().await, ["first"]);
        runtime.complete("completed").await;
        tokio::time::timeout(std::time::Duration::from_secs(3), async {
            loop {
                if runtime.sent.lock().await.len() == 2 {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert_eq!(*runtime.sent.lock().await, ["first", "second"]);
        runtime.complete("completed").await;
    }

    #[derive(Default)]
    struct FakeRuntime {
        busy: Mutex<bool>,
        native: bool,
        sent: Mutex<Vec<String>>,
        steered: Mutex<Vec<String>>,
        turns: Mutex<HashMap<String, oneshot::Receiver<SessionTurnResult>>>,
        active: Mutex<Option<oneshot::Sender<SessionTurnResult>>>,
        changed: Notify,
        busy_error_once: std::sync::atomic::AtomicBool,
        busy_error_seen: Notify,
        prepare_calls: AtomicU64,
        prepare_gate: Mutex<Option<oneshot::Receiver<Result<(), String>>>>,
        prepare_block_at: AtomicU64,
        prepare_entered: Notify,
        start_busy_once: std::sync::atomic::AtomicBool,
    }

    impl FakeRuntime {
        async fn complete(&self, status: &str) {
            *self.busy.lock().await = false;
            if let Some(tx) = self.active.lock().await.take() {
                let _ = tx.send(SessionTurnResult {
                    status: status.into(),
                    text: Some("reply".into()),
                    error: None,
                });
            }
            self.changed.notify_waiters();
        }
    }

    #[async_trait]
    impl SessionRuntime for FakeRuntime {
        async fn prepare(&self, _: &str, _: i32, _: i32) -> Result<(), String> {
            let call = self.prepare_calls.fetch_add(1, Ordering::AcqRel) + 1;
            if call == self.prepare_block_at.load(Ordering::Acquire) {
                let gate = self.prepare_gate.lock().await.take();
                if let Some(gate) = gate {
                    self.prepare_entered.notify_one();
                    return gate.await.map_err(|_| "prepare gate closed".to_string())?;
                }
            }
            Ok(())
        }
        async fn is_busy(&self, _: i32) -> Result<bool, String> {
            if self.busy_error_once.swap(false, Ordering::AcqRel) {
                self.busy_error_seen.notify_one();
                return Err("temporary recipient lookup failure".into());
            }
            Ok(*self.busy.lock().await)
        }
        async fn wait_idle(&self, _: i32) -> Result<(), String> {
            loop {
                let changed = self.changed.notified();
                if !*self.busy.lock().await {
                    return Ok(());
                }
                changed.await;
            }
        }
        async fn start(
            &self,
            _: &str,
            _: i32,
            _: i32,
            message: String,
        ) -> Result<SessionTurn, SessionStartError> {
            if self.start_busy_once.swap(false, Ordering::AcqRel) {
                return Err(SessionStartError::Busy);
            }
            let mut busy = self.busy.lock().await;
            if *busy {
                return Err(SessionStartError::Busy);
            }
            *busy = true;
            let (tx, rx) = oneshot::channel();
            let id = uuid::Uuid::new_v4().to_string();
            self.turns.lock().await.insert(id.clone(), rx);
            *self.active.lock().await = Some(tx);
            self.sent.lock().await.push(message);
            Ok(SessionTurn { id })
        }
        async fn steer(&self, _: i32, message: String) -> Result<bool, String> {
            if self.native {
                self.steered.lock().await.push(message);
            }
            Ok(self.native)
        }
        async fn interrupt(&self, _: i32) -> Result<(), String> {
            self.complete("canceled").await;
            Ok(())
        }
        async fn wait(&self, turn: SessionTurn) -> Result<SessionTurnResult, String> {
            let rx = self.turns.lock().await.remove(&turn.id).unwrap();
            rx.await.map_err(|_| "closed".into())
        }
    }

    async fn setup(busy: bool, native: bool) -> (SessionMessages, Arc<FakeRuntime>, i32, i32) {
        let db = Arc::new(fresh_in_memory_db().await);
        let folder = seed_folder(&db, "D:/message-tests").await;
        let sender = seed_conversation(&db, folder, AgentType::Codex).await;
        let recipient = seed_conversation(&db, folder, AgentType::Codex).await;
        conversation::Entity::update_many()
            .col_expr(conversation::Column::ParentId, Expr::value(sender))
            .col_expr(conversation::Column::Kind, Expr::value("delegate"))
            .filter(conversation::Column::Id.eq(recipient))
            .exec(&db.conn)
            .await
            .unwrap();
        let runtime = Arc::new(FakeRuntime {
            busy: Mutex::new(busy),
            native,
            ..Default::default()
        });
        (
            SessionMessages::with_runtime(db, runtime.clone()),
            runtime,
            sender,
            recipient,
        )
    }

    fn request(
        recipient: i32,
        action: SessionMessageAction,
        text: Option<&str>,
        id: Option<&str>,
        delivery: SessionDelivery,
    ) -> SessionMessageRequest {
        SessionMessageRequest {
            conversation_id: recipient,
            action,
            message: text.map(str::to_owned),
            message_id: id.map(str::to_owned),
            delivery,
        }
    }

    async fn wait_for_status(
        service: &SessionMessages,
        sender: i32,
        recipient: i32,
        id: &str,
        status: &str,
    ) {
        tokio::time::timeout(std::time::Duration::from_secs(3), async {
            loop {
                if messages::get(&service.db.conn, sender, recipient, id)
                    .await
                    .unwrap()
                    .is_some_and(|r| r.status == status)
                {
                    return;
                }
                tokio::time::sleep(std::time::Duration::from_millis(5)).await;
            }
        })
        .await
        .expect("message reached expected status");
    }

    #[tokio::test]
    async fn a_competing_prompt_does_not_fail_an_unsent_message() {
        let (service, runtime, sender, recipient) = setup(false, false).await;
        runtime.start_busy_once.store(true, Ordering::Release);
        let outcome = service
            .request(
                "sender",
                sender,
                request(
                    recipient,
                    SessionMessageAction::Send,
                    Some("keep this prompt"),
                    None,
                    SessionDelivery::Queue,
                ),
            )
            .await;
        assert!(outcome.accepted);
        let id = &outcome.messages[0].message_id;
        tokio::time::timeout(std::time::Duration::from_secs(3), async {
            while runtime.sent.lock().await.is_empty() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert_eq!(*runtime.sent.lock().await, ["keep this prompt"]);
        runtime.complete("completed").await;
        wait_for_status(&service, sender, recipient, id, "completed").await;
    }

    #[tokio::test]
    async fn queued_messages_can_be_edited_or_canceled_until_the_child_is_idle() {
        let (service, runtime, sender, recipient) = setup(true, false).await;
        let first = service
            .request(
                "sender",
                sender,
                request(
                    recipient,
                    SessionMessageAction::Send,
                    Some("old"),
                    None,
                    SessionDelivery::Queue,
                ),
            )
            .await;
        assert!(first.accepted);
        let first_id = first.messages[0].message_id.clone();
        let second = service
            .request(
                "sender",
                sender,
                request(
                    recipient,
                    SessionMessageAction::Send,
                    Some("remove"),
                    None,
                    SessionDelivery::Queue,
                ),
            )
            .await;
        assert!(second.accepted);
        let second_id = second.messages[0].message_id.clone();
        assert!(
            service
                .request(
                    "sender",
                    sender,
                    request(
                        recipient,
                        SessionMessageAction::Update,
                        Some("revised"),
                        Some(&first_id),
                        SessionDelivery::Queue
                    )
                )
                .await
                .accepted
        );
        assert!(
            service
                .request(
                    "sender",
                    sender,
                    request(
                        recipient,
                        SessionMessageAction::Cancel,
                        None,
                        Some(&second_id),
                        SessionDelivery::Queue
                    )
                )
                .await
                .accepted
        );
        assert!(runtime.sent.lock().await.is_empty());
        runtime.complete("completed").await;
        wait_for_status(&service, sender, recipient, &first_id, "running").await;
        tokio::time::timeout(std::time::Duration::from_secs(3), async {
            while runtime.sent.lock().await.len() != 1 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert_eq!(*runtime.sent.lock().await, vec!["revised"]);
        runtime.complete("completed").await;
        wait_for_status(&service, sender, recipient, &first_id, "completed").await;
        assert_eq!(
            messages::get(&service.db.conn, sender, recipient, &first_id)
                .await
                .unwrap()
                .unwrap()
                .result
                .as_deref(),
            Some("reply")
        );
        assert_eq!(
            messages::get(&service.db.conn, sender, recipient, &second_id)
                .await
                .unwrap()
                .unwrap()
                .status,
            "canceled"
        );
    }

    #[tokio::test]
    async fn immediate_messages_steer_without_canceling_the_current_turn() {
        let (service, runtime, sender, recipient) = setup(true, true).await;
        let outcome = service
            .request(
                "sender",
                sender,
                request(
                    recipient,
                    SessionMessageAction::Send,
                    Some("redirect"),
                    None,
                    SessionDelivery::Immediate,
                ),
            )
            .await;
        assert!(outcome.accepted);
        wait_for_status(
            &service,
            sender,
            recipient,
            &outcome.messages[0].message_id,
            "delivered",
        )
        .await;
        assert!(*runtime.busy.lock().await);
        assert_eq!(*runtime.steered.lock().await, vec!["redirect"]);
        assert!(runtime.sent.lock().await.is_empty());
        runtime.complete("completed").await;
    }

    #[tokio::test]
    async fn immediate_without_steering_interrupts_then_reuses_the_same_child() {
        let (service, runtime, sender, recipient) = setup(false, false).await;
        let first = service
            .request(
                "sender",
                sender,
                request(
                    recipient,
                    SessionMessageAction::Send,
                    Some("first"),
                    None,
                    SessionDelivery::Queue,
                ),
            )
            .await;
        assert!(first.accepted);
        wait_for_status(
            &service,
            sender,
            recipient,
            &first.messages[0].message_id,
            "running",
        )
        .await;
        tokio::time::timeout(std::time::Duration::from_secs(3), async {
            while runtime.sent.lock().await.is_empty() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        let next = service
            .request(
                "sender",
                sender,
                request(
                    recipient,
                    SessionMessageAction::Send,
                    Some("change now"),
                    None,
                    SessionDelivery::Immediate,
                ),
            )
            .await;
        assert!(next.accepted);
        wait_for_status(
            &service,
            sender,
            recipient,
            &next.messages[0].message_id,
            "running",
        )
        .await;
        assert_eq!(
            messages::get(
                &service.db.conn,
                sender,
                recipient,
                &first.messages[0].message_id
            )
            .await
            .unwrap()
            .unwrap()
            .status,
            "canceled"
        );
        tokio::time::timeout(std::time::Duration::from_secs(3), async {
            while runtime.sent.lock().await.len() != 2 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert_eq!(*runtime.sent.lock().await, vec!["first", "change now"]);
        runtime.complete("completed").await;
        wait_for_status(
            &service,
            sender,
            recipient,
            &next.messages[0].message_id,
            "completed",
        )
        .await;
    }

    #[tokio::test]
    async fn a_dispatch_error_still_records_the_active_turn_result() {
        let (service, runtime, sender, recipient) = setup(false, false).await;
        let first = service
            .request(
                "sender",
                sender,
                request(
                    recipient,
                    SessionMessageAction::Send,
                    Some("first"),
                    None,
                    SessionDelivery::Queue,
                ),
            )
            .await;
        assert!(first.accepted);
        tokio::time::timeout(std::time::Duration::from_secs(3), async {
            while runtime.sent.lock().await.is_empty() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        runtime.busy_error_once.store(true, Ordering::Release);
        let next = service
            .request(
                "sender",
                sender,
                request(
                    recipient,
                    SessionMessageAction::Send,
                    Some("redirect"),
                    None,
                    SessionDelivery::Immediate,
                ),
            )
            .await;
        assert!(next.accepted);
        tokio::time::timeout(
            std::time::Duration::from_secs(3),
            runtime.busy_error_seen.notified(),
        )
        .await
        .unwrap();
        runtime.complete("completed").await;
        wait_for_status(
            &service,
            sender,
            recipient,
            &first.messages[0].message_id,
            "completed",
        )
        .await;
        wait_for_status(
            &service,
            sender,
            recipient,
            &next.messages[0].message_id,
            "running",
        )
        .await;
        tokio::time::timeout(std::time::Duration::from_secs(3), async {
            while runtime.sent.lock().await.len() != 2 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        runtime.complete("completed").await;
        wait_for_status(
            &service,
            sender,
            recipient,
            &next.messages[0].message_id,
            "completed",
        )
        .await;
    }

    #[tokio::test]
    async fn a_new_message_waking_a_failing_worker_gets_a_fresh_attempt() {
        let (service, runtime, sender, recipient) = setup(false, false).await;
        let (release, gate) = oneshot::channel();
        *runtime.prepare_gate.lock().await = Some(gate);
        runtime.prepare_block_at.store(2, Ordering::Release);
        let first = service
            .request(
                "sender",
                sender,
                request(
                    recipient,
                    SessionMessageAction::Send,
                    Some("first"),
                    None,
                    SessionDelivery::Queue,
                ),
            )
            .await;
        assert!(first.accepted);
        tokio::time::timeout(
            std::time::Duration::from_secs(3),
            runtime.prepare_entered.notified(),
        )
        .await
        .unwrap();
        let second = service
            .request(
                "sender",
                sender,
                request(
                    recipient,
                    SessionMessageAction::Send,
                    Some("second"),
                    None,
                    SessionDelivery::Queue,
                ),
            )
            .await;
        assert!(second.accepted);
        release
            .send(Err("temporary prepare failure".into()))
            .unwrap();
        wait_for_status(
            &service,
            sender,
            recipient,
            &first.messages[0].message_id,
            "running",
        )
        .await;
        tokio::time::timeout(std::time::Duration::from_secs(3), async {
            while runtime.sent.lock().await.is_empty() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        runtime.complete("completed").await;
        wait_for_status(
            &service,
            sender,
            recipient,
            &second.messages[0].message_id,
            "running",
        )
        .await;
        tokio::time::timeout(std::time::Duration::from_secs(3), async {
            while runtime.sent.lock().await.len() != 2 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert_eq!(*runtime.sent.lock().await, vec!["first", "second"]);
        runtime.complete("completed").await;
        wait_for_status(
            &service,
            sender,
            recipient,
            &second.messages[0].message_id,
            "completed",
        )
        .await;
    }

    #[tokio::test]
    async fn a_completed_result_survives_a_failed_database_write_without_reexecuting() {
        use sea_orm::ConnectionTrait;
        let (service, runtime, sender, recipient) = setup(false, false).await;
        let row = messages::enqueue(&service.db.conn, sender, recipient, "task", "queue")
            .await
            .unwrap();
        assert!(messages::claim(&service.db.conn, &row.message_id)
            .await
            .unwrap());
        service
            .db
            .conn
            .execute_unprepared("ALTER TABLE session_message RENAME TO unavailable_session_message")
            .await
            .unwrap();
        assert!(service
            .finish(
                &row.message_id,
                Ok(SessionTurnResult {
                    status: "completed".into(),
                    text: Some("completed before the outage".into()),
                    error: None,
                })
            )
            .await
            .is_err());
        service
            .db
            .conn
            .execute_unprepared("ALTER TABLE unavailable_session_message RENAME TO session_message")
            .await
            .unwrap();
        let outcome = service
            .request(
                "sender",
                sender,
                request(
                    recipient,
                    SessionMessageAction::List,
                    None,
                    None,
                    SessionDelivery::Queue,
                ),
            )
            .await;
        assert!(outcome.accepted);
        assert_eq!(outcome.messages[0].status, "completed");
        assert_eq!(
            outcome.messages[0].result.as_deref(),
            Some("completed before the outage")
        );
        assert!(runtime.sent.lock().await.is_empty());
    }
}
