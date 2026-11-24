use std::collections::HashSet;
use std::sync::Arc;
use std::time::Duration;

use sea_orm::{ColumnTrait, DatabaseConnection, DbErr, EntityTrait, QueryFilter};
use tokio::sync::oneshot;
use tokio::task::JoinSet;

use super::connection::{current_config_option_values, SteerOutcome};
use super::delegation::broker::DelegationBroker;
use super::error::AcpError;
use super::manager::ConnectionManager;
use super::types::{
    ConnectionStatus, PromptInputBlock, SessionConfigKindInfo, SessionConfigOptionInfo,
};
use crate::db::entities::folder::FolderKind;
use crate::db::entities::{conversation, session_message};
use crate::db::service::session_message_service as queue;
use crate::db::service::{conversation_service, folder_service};
use crate::db::AppDatabase;
use crate::web::event_bridge::EventEmitter;

pub(crate) const PROMPT_ID_PREFIX: &str = "session-message-";
type TurnResult = Result<Option<String>, String>;
pub(crate) type TurnSender = oneshot::Sender<TurnResult>;

#[derive(Debug)]
pub(crate) struct TurnWaiter {
    pub prompt_id: Option<String>,
    pub turn: Option<u64>,
    pub reply: Option<TurnSender>,
}

pub struct SessionCreator {
    pub db: DatabaseConnection,
    pub manager: Arc<ConnectionManager>,
    pub data_dir: std::path::PathBuf,
}

fn current_permission_mode(options: &[SessionConfigOptionInfo]) -> Option<&str> {
    options.iter().find_map(|option| match &option.kind {
        SessionConfigKindInfo::Select(select) if option.category.as_deref() == Some("mode") => {
            Some(select.current_value.as_str())
        }
        _ => None,
    })
}

impl SessionCreator {
    pub async fn create(
        &self,
        caller: &str,
        request: super::delegation::transport::BrokerCreateSessionRequest,
        agent_defaults: &std::collections::BTreeMap<
            crate::models::AgentType,
            super::delegation::types::AgentDelegationDefaults,
        >,
        broker: &DelegationBroker,
    ) -> Result<(i32, String), String> {
        if let Some(key) = request.config_values.keys().find(|key| {
            !matches!(
                key.as_str(),
                "model" | "reasoning_effort" | "effort" | "thought_level"
            )
        }) {
            return Err(format!("unsupported create_session config option: {key}"));
        }
        let Some((caller_state, emitter)) = self.manager.get_state_and_emitter(caller).await else {
            return Err("creator connection is unavailable".into());
        };
        let (sender, agent_type, mode) = {
            let caller = caller_state.read().await;
            let sender = caller
                .conversation_id
                .ok_or("creator has no active conversation")?;
            let agent_type = request.agent_type.unwrap_or(caller.agent_type);
            let mode = if agent_type == caller.agent_type {
                let current =
                    current_permission_mode(caller.config_options.as_deref().unwrap_or_default())
                        .or(caller.current_mode.as_deref());
                if request
                    .mode_id
                    .as_deref()
                    .is_some_and(|requested| Some(requested) != current)
                {
                    return Err("same-agent sessions inherit the current permission mode".into());
                }
                current.map(str::to_owned)
            } else {
                request.mode_id.clone()
            };
            (sender, agent_type, mode)
        };
        let mut defaults = agent_defaults.get(&agent_type).cloned().unwrap_or_default();
        if mode.is_some() {
            defaults.mode_id.clone_from(&mode);
            defaults.config_values.remove("mode");
        }
        defaults.config_values.extend(request.config_values.clone());
        let source = live_conversation(&self.db, sender)
            .await
            .map_err(|error| error.to_string())?
            .ok_or("creator conversation was deleted")?;
        let folder = if let Some(path) = request.folder_path.as_deref() {
            let path = path.trim();
            if !std::path::Path::new(path).is_absolute() {
                return Err("folder_path must be an absolute path".into());
            }
            folder_service::list_all_folder_details(&self.db)
                .await
                .map_err(|error| error.to_string())?
                .into_iter()
                .find(|folder| crate::parsers::path_eq_for_matching(&folder.path, path))
                .ok_or_else(|| format!("folder_path is not registered in Codeg: {path}"))?
        } else {
            folder_service::get_folder_by_id(&self.db, source.folder_id)
                .await
                .map_err(|error| error.to_string())?
                .ok_or("creator folder is unavailable")?
        };
        crate::commands::acp::verify_agent_installed(agent_type)
            .await
            .map_err(|error| error.to_string())?;
        let db = AppDatabase {
            conn: self.db.clone(),
        };
        let runtime_env =
            crate::commands::acp::build_session_runtime_env(&db, agent_type, None, &self.data_dir)
                .await
                .map_err(|error| error.to_string())?;
        let title = Some(request.title.clone());
        let conversation_id = if folder.kind == FolderKind::Chat {
            conversation_service::create_chat(&self.db, folder.id, agent_type, title, None)
                .await
                .map(|conversation| conversation.id)
                .map_err(|error| error.to_string())?
        } else {
            crate::commands::conversations::create_conversation_core(
                &self.db, folder.id, agent_type, title,
            )
            .await
            .map_err(|error| error.to_string())?
        };
        conversation_service::update_title(&self.db, conversation_id, request.title)
            .await
            .map_err(|error| error.to_string())?;
        crate::commands::conversations::emit_conversation_upsert(
            &emitter,
            &self.db,
            conversation_id,
        )
        .await;
        let started = async {
            let connection = crate::commands::acp::spawn_with_conversation_selection(
                &self.manager,
                &self.db,
                agent_type,
                Some(folder.path),
                None,
                runtime_env,
                "session-tools".into(),
                emitter.clone(),
                Some(conversation_id),
                defaults.mode_id,
                defaults.config_values,
            )
            .await
            .map_err(|error| error.to_string())?;
            // Creation accepts explicit settings for the first prompt. The shared
            // connect path can fall back on stale saved preferences, so use its
            // result here to reject an unavailable explicit pick before sending.
            let confirmed = async {
                let snapshot = self
                    .manager
                    .wait_for_session_options(&connection, Duration::from_secs(60))
                    .await
                    .map_err(|error| error.to_string())?;
                let current_mode =
                    current_permission_mode(&snapshot.config_options).or_else(|| {
                        snapshot
                            .modes
                            .as_ref()
                            .map(|modes| modes.current_mode_id.as_str())
                    });
                if let Some(mode) = mode.as_deref().filter(|mode| Some(*mode) != current_mode) {
                    return Err(format!(
                        "could not apply permission mode {mode:?} for {agent_type}"
                    ));
                }
                let current = current_config_option_values(&snapshot.config_options);
                if let Some((key, value)) = request
                    .config_values
                    .iter()
                    .find(|(key, value)| current.get(*key) != Some(*value))
                {
                    return Err(format!("could not apply {key}={value} for {agent_type}"));
                }
                Ok(())
            }
            .await;
            if let Err(error) = confirmed {
                let _ = self.manager.disconnect(&connection).await;
                return Err(error);
            }
            Ok(connection)
        }
        .await;
        let connection = match started {
            Ok(connection) => connection,
            Err(error) => {
                let _ = conversation_service::update_status(
                    &self.db,
                    conversation_id,
                    crate::db::entities::conversation::ConversationStatus::Cancelled,
                )
                .await;
                crate::commands::conversations::emit_conversation_upsert(
                    &emitter,
                    &self.db,
                    conversation_id,
                )
                .await;
                return Err(format!(
                    "conversation {conversation_id} was created but could not start: {error}"
                ));
            }
        };
        let message_id = queue::enqueue(
            &self.db,
            sender,
            conversation_id,
            request.message,
            "queue".into(),
            true,
        )
        .await
        .map_err(|error| error.to_string())?;
        let message = session_message::Entity::find()
            .filter(session_message::Column::MessageId.eq(message_id.clone()))
            .one(&self.db)
            .await
            .map_err(|error| error.to_string())?
            .ok_or("initial message was not saved")?;
        dispatch(
            &self.db,
            &self.manager,
            broker,
            vec![message],
            Some(connection),
            None,
        )
        .await
        .map_err(|error| error.to_string())?;
        Ok((conversation_id, message_id))
    }
}

pub async fn start(
    db: DatabaseConnection,
    manager: Arc<ConnectionManager>,
    broker: Arc<DelegationBroker>,
    data_dir: std::path::PathBuf,
    emitter: EventEmitter,
) {
    while let Err(error) = queue::interrupt_in_flight(&db).await {
        tracing::warn!(%error, "could not recover session messages");
        tokio::time::sleep(Duration::from_secs(1)).await;
    }

    let mut tick = tokio::time::interval(Duration::from_secs(1));
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut dispatches = JoinSet::new();
    let mut dispatching = std::collections::HashMap::new();
    loop {
        tokio::select! {
            Some(result) = dispatches.join_next_with_id() => {
                let id = match result {
                    Ok((id, ())) => id,
                    Err(error) => {
                        tracing::error!(%error, "session message dispatch failed");
                        error.id()
                    }
                };
                dispatching.remove(&id);
            }
            _ = tick.tick() => {
                if !broker.config_snapshot().await.session_messaging_enabled {
                    continue;
                }
                let rows = match queue::queued(&db).await {
                    Ok(rows) => rows,
                    Err(error) => {
                        tracing::warn!(%error, "could not read session messages");
                        continue;
                    }
                };
                let mut seen: HashSet<i32> = dispatching.values().copied().collect();
                let mut grouped = std::collections::BTreeMap::<i32, Vec<_>>::new();
                for row in rows {
                    grouped.entry(row.conversation_id).or_default().push(row);
                }
                for (recipient, rows) in grouped {
                    if seen.insert(recipient) {
                        let db = db.clone();
                        let manager = manager.clone();
                        let broker = broker.clone();
                        let data_dir = data_dir.clone();
                        let emitter = emitter.clone();
                        let task = dispatches.spawn(async move {
                            if let Err(error) = dispatch(
                                &db, &manager, &broker, rows, None, Some((&data_dir, &emitter)),
                            )
                            .await
                            {
                                tracing::warn!(recipient, %error, "could not dispatch session message");
                            }
                        });
                        dispatching.insert(task.id(), recipient);
                    }
                }
            }
        }
    }
}

async fn dispatch(
    db: &DatabaseConnection,
    manager: &ConnectionManager,
    broker: &DelegationBroker,
    rows: Vec<session_message::Model>,
    initial_connection: Option<String>,
    activation: Option<(&std::path::Path, &EventEmitter)>,
) -> Result<(), crate::db::error::DbError> {
    let recipient_id = rows[0].conversation_id;
    let Some(recipient) = live_conversation(db, recipient_id).await? else {
        for row in rows {
            fail_queued(db, &row, "recipient was deleted").await?;
        }
        return Ok(());
    };
    let mut valid = Vec::new();
    for row in rows {
        if live_conversation(db, row.sender_conversation_id)
            .await?
            .is_some()
        {
            valid.push(row);
        } else {
            fail_queued(db, &row, "sender was deleted").await?;
        }
    }

    if valid.is_empty() {
        return Ok(());
    }
    let is_initial = initial_connection.is_some();
    let connection = if is_initial {
        initial_connection
    } else {
        match crate::models::AgentType::from_wire(&recipient.agent_type) {
            Some(agent) => crate::commands::acp::acp_find_connection_for_conversation_core(
                manager,
                db,
                recipient.id,
                recipient.external_id.as_deref(),
                agent,
            )
            .await
            .ok()
            .flatten()
            .map(|info| info.connection_id),
            None => None,
        }
    };
    let connection = match (connection, activation) {
        (Some(connection), _) => connection,
        (None, Some((data_dir, emitter))) => {
            match activate_recipient(db, manager, &recipient, data_dir, emitter).await {
                Ok(connection) => connection,
                Err(error) => {
                    let reason = format!("could not activate recipient: {error}");
                    for row in valid {
                        fail_queued(db, &row, &reason).await?;
                    }
                    return Ok(());
                }
            }
        }
        (None, None) => return Ok(()),
    };
    let Some(state) = manager.get_state(&connection).await else {
        return Ok(());
    };
    let busy = {
        let state = state.read().await;
        if state
            .conversation_id
            .is_some_and(|bound| bound != recipient.id)
        {
            return Ok(());
        }
        match state.status {
            ConnectionStatus::Connected | ConnectionStatus::Prompting => {}
            // The connection loop processes queued prompts after its handshake.
            ConnectionStatus::Connecting if is_initial => {}
            _ => return Ok(()),
        }
        state.turn_in_flight || state.status == ConnectionStatus::Prompting
    };

    let Some(row) = valid.into_iter().find(|row| !busy || row.mode == "steer") else {
        return Ok(());
    };
    if !broker.config_snapshot().await.session_messaging_enabled || !queue::claim(db, &row).await? {
        return Ok(());
    }

    let text = format!(
        "[Codeg message from conversation {}; message {}]\n\n{}",
        row.sender_conversation_id, row.message_id, row.message
    );
    let (reply, mut result) = oneshot::channel();
    let prompt_id = format!("{PROMPT_ID_PREFIX}{}", row.message_id);
    let open_prompt = if busy {
        match manager
            .steer_session_message(&connection, text.clone(), reply)
            .await
        {
            Ok(SteerOutcome::Injected) => None,
            Ok(SteerOutcome::StartedNewTurn) => {
                let outcome = if row.reply_back {
                    Err("steering started a detached turn without a tracked result".into())
                } else {
                    Ok(None)
                };
                return finish(db, &row, outcome).await;
            }
            Ok(SteerOutcome::PromptRequired)
            | Err(AcpError::FeedbackDisabled | AcpError::NoActiveTurn) => {
                let (reply, fallback_result) = oneshot::channel();
                result = fallback_result;
                Some(reply)
            }
            Err(error) => return finish(db, &row, Err(error.to_string())).await,
        }
    } else {
        Some(reply)
    };

    let sent = if let Some(reply) = open_prompt {
        {
            let mut state = state.write().await;
            state
                .message_turns
                .retain(|waiter| waiter.reply.as_ref().is_some_and(|tx| !tx.is_closed()));
            state.message_turns.push(TurnWaiter {
                prompt_id: Some(prompt_id.clone()),
                turn: None,
                reply: Some(reply),
            });
        }
        manager
            .send_prompt_linked_with_message_id(
                &AppDatabase { conn: db.clone() },
                &connection,
                vec![PromptInputBlock::Text { text }],
                Some(recipient.folder_id),
                Some(recipient.id),
                None,
                Some(prompt_id),
            )
            .await
            .map(|_| ())
    } else {
        Ok(())
    };
    match sent {
        Ok(()) => {
            let db = db.clone();
            tokio::spawn(async move {
                let outcome = result
                    .await
                    .unwrap_or_else(|_| Err("recipient disconnected before its turn ended".into()));
                if let Err(error) = finish(&db, &row, outcome).await {
                    tracing::error!(message_id = %row.message_id, %error, "could not settle session message");
                }
            });
        }
        Err(AcpError::TurnInProgress) if busy => {
            queue::defer_as_queue(db, row.id).await?;
        }
        Err(AcpError::TurnInProgress) => {
            queue::transition(db, row.id, "in_flight", "queued", None).await?;
        }
        Err(error) => finish(db, &row, Err(error.to_string())).await?,
    }
    Ok(())
}

async fn activate_recipient(
    db: &DatabaseConnection,
    manager: &ConnectionManager,
    recipient: &conversation::Model,
    data_dir: &std::path::Path,
    emitter: &EventEmitter,
) -> Result<String, String> {
    let agent = crate::models::AgentType::from_wire(&recipient.agent_type)
        .ok_or("recipient agent is unavailable")?;
    if recipient.external_id.is_none() && recipient.message_count > 0 {
        return Err("the recipient has history but no agent session ID".into());
    }
    let folder = folder_service::get_folder_by_id(db, recipient.folder_id)
        .await
        .map_err(|error| error.to_string())?
        .ok_or("recipient folder is unavailable")?;
    crate::commands::acp::verify_agent_installed(agent)
        .await
        .map_err(|error| error.to_string())?;
    let env = crate::commands::acp::build_session_runtime_env(
        &AppDatabase { conn: db.clone() },
        agent,
        recipient.external_id.as_deref(),
        data_dir,
    )
    .await
    .map_err(|error| error.to_string())?;
    let preferences = recipient
        .model
        .clone()
        .map(|model| ("model".into(), model))
        .into_iter()
        .collect();
    let outcome = crate::commands::acp::spawn_and_bind_conversation_selection(
        manager,
        db,
        agent,
        Some(folder.path),
        recipient.external_id.clone(),
        env,
        "session-tools".into(),
        emitter.clone(),
        Some(recipient.id),
        None,
        preferences,
    )
    .await
    .map_err(|error| error.to_string())?;
    let connection = outcome.connection_id;
    let ready: Result<(), String> = async {
        outcome.bound.map_err(|error| error.to_string())?;
        manager
            .wait_for_session_options(&connection, Duration::from_secs(60))
            .await
            .map_err(|error| error.to_string())?;
        let state = manager
            .get_state(&connection)
            .await
            .ok_or("recipient disconnected")?;
        let state = state.read().await;
        if let Some(external_id) = recipient.external_id.as_deref() {
            if state.external_id.as_deref() != Some(external_id) {
                return Err("the agent did not resume the original session".into());
            }
        }
        Ok(())
    }
    .await;
    if let Err(error) = ready {
        if !outcome.reused {
            let _ = manager.disconnect(&connection).await;
        }
        return Err(error);
    }
    Ok(connection)
}

async fn live_conversation(
    db: &DatabaseConnection,
    id: i32,
) -> Result<Option<conversation::Model>, DbErr> {
    conversation::Entity::find_by_id(id)
        .filter(conversation::Column::DeletedAt.is_null())
        .one(db)
        .await
}

async fn fail_queued(
    db: &DatabaseConnection,
    row: &session_message::Model,
    reason: &str,
) -> Result<(), sea_orm::DbErr> {
    queue::transition(db, row.id, "queued", "failed", Some(reason.into())).await?;
    Ok(())
}

async fn finish(
    db: &DatabaseConnection,
    row: &session_message::Model,
    outcome: TurnResult,
) -> Result<(), crate::db::error::DbError> {
    let (result, error) = match outcome {
        Ok(result) => (result, None),
        Err(error) => (None, Some(error)),
    };
    loop {
        match queue::settle(db, row, error.is_none(), result.clone(), error.clone()).await {
            Ok(_) => return Ok(()),
            Err(error) => {
                tracing::warn!(message_id = %row.message_id, %error, "retrying session message settlement");
                tokio::time::sleep(Duration::from_secs(1)).await;
            }
        }
    }
}
