use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use sea_orm::DatabaseConnection;
use tokio::sync::{mpsc, Mutex};
use tokio::task::JoinHandle;

use super::command_handlers;
use super::i18n::{self, Lang};
use super::manager::ChatChannelManager;
use super::session_bridge::SessionBridge;
use super::session_commands;
use super::types::{ChannelMessageTarget, IncomingCommand, InteractiveMessage, RichMessage};
use crate::acp::manager::ConnectionManager;
use crate::db::service::{app_metadata_service, chat_channel_message_log_service};
use crate::web::event_bridge::EventEmitter;

const COMMAND_PREFIX_KEY: &str = "chat_command_prefix";
const DEFAULT_COMMAND_PREFIX: &str = "/";
const MESSAGE_LANGUAGE_KEY: &str = "chat_message_language";
/// How often to refresh cached config from DB.
const CONFIG_CACHE_TTL_SECS: u64 = 30;

struct CommandConfigCache {
    prefix: String,
    lang: Lang,
    /// `None` until the first refresh, which is what forces one.
    ///
    /// This used to be a plain `Instant` seeded with
    /// `Instant::now() - Duration::from_secs(TTL + 1)`, which is a panic, not a
    /// saturating subtraction: `Sub<Duration> for Instant` is a `checked_sub`
    /// plus `expect`. On Windows an `Instant` is the QPC reading, i.e. time
    /// since boot, so starting codeg inside the first 31 seconds of a boot
    /// aborted the process here. codeg ships an autostart plugin, so launching
    /// at login is an ordinary case, and this runs inside a long-lived spawned
    /// task with nobody at the keyboard.
    last_refresh: Option<Instant>,
}

impl CommandConfigCache {
    fn new() -> Self {
        Self {
            prefix: DEFAULT_COMMAND_PREFIX.to_string(),
            lang: Lang::default(),
            // Force refresh on first use
            last_refresh: None,
        }
    }

    async fn refresh_if_needed(&mut self, db: &DatabaseConnection) {
        if self
            .last_refresh
            .is_some_and(|at| at.elapsed() < Duration::from_secs(CONFIG_CACHE_TTL_SECS))
        {
            return;
        }

        if let Ok(Some(val)) = app_metadata_service::get_value(db, COMMAND_PREFIX_KEY).await {
            self.prefix = val;
        }
        if let Ok(Some(val)) = app_metadata_service::get_value(db, MESSAGE_LANGUAGE_KEY).await {
            self.lang = Lang::from_str_lossy(&val);
        }

        self.last_refresh = Some(Instant::now());
    }
}

pub fn spawn_command_dispatcher(
    mut command_rx: mpsc::Receiver<IncomingCommand>,
    manager: ChatChannelManager,
    db_conn: DatabaseConnection,
    data_dir: PathBuf,
    conn_mgr: ConnectionManager,
    emitter: EventEmitter,
    bridge: Arc<Mutex<SessionBridge>>,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        let mut config = CommandConfigCache::new();

        while let Some(cmd) = command_rx.recv().await {
            let text = cmd.command_text.trim();
            tracing::info!(
                "[ChatChannel] received command from channel={} sender={}: {:?}",
                cmd.channel_id,
                cmd.sender_id,
                text
            );

            // Log inbound command
            let _ = chat_channel_message_log_service::create_log(
                &db_conn,
                cmd.channel_id,
                "inbound",
                "command_query",
                text,
                "sent",
                None,
            )
            .await;

            config.refresh_if_needed(&db_conn).await;

            let response = dispatch_command(
                text,
                &config.prefix,
                &db_conn,
                &manager,
                &conn_mgr,
                &emitter,
                &bridge,
                &data_dir,
                cmd.channel_id,
                &cmd.sender_id,
                &cmd.target,
                cmd.callback_data.as_deref(),
                config.lang,
            )
            .await;

            if response.message.is_none()
                && response.extra_messages.is_empty()
                && response.post_action.is_none()
            {
                tracing::debug!("[ChatChannel] dispatch result: no response");
                continue;
            };

            let mut messages = Vec::new();
            if let Some(message) = response.message {
                messages.push((message, response.target));
            }
            messages.extend(response.extra_messages);

            for (message, target) in messages {
                send_dispatch_message(&db_conn, &manager, cmd.channel_id, text, message, target)
                    .await;
            }

            if let Some(action) = response.post_action {
                if let Some((message, target)) =
                    session_commands::handle_post_action(action, &db_conn, &conn_mgr, &bridge).await
                {
                    send_dispatch_message(
                        &db_conn,
                        &manager,
                        cmd.channel_id,
                        text,
                        DispatchMessage::Rich(message),
                        target,
                    )
                    .await;
                }
            }
        }
    })
}

async fn send_dispatch_message(
    db: &DatabaseConnection,
    manager: &ChatChannelManager,
    channel_id: i32,
    command_text: &str,
    message: DispatchMessage,
    target: ChannelMessageTarget,
) {
    tracing::info!(
        "[ChatChannel] dispatch result: title={:?}, body_len={}",
        message.title(),
        message.body_len()
    );

    let send_result = match &message {
        DispatchMessage::Rich(message) => manager.send_to_target(&target, message).await,
        DispatchMessage::Interactive(message) => {
            manager.send_interactive_to_target(&target, message).await
        }
    };
    let (status, error_detail) = match &send_result {
        Ok(_) => ("sent", None),
        Err(e) => {
            tracing::error!(
                "[ChatChannel] failed to send response for {:?} to channel {}: {e}",
                command_text,
                channel_id
            );
            ("failed", Some(e.to_string()))
        }
    };

    let _ = chat_channel_message_log_service::create_log(
        db,
        channel_id,
        "outbound",
        "command_response",
        &message.to_plain_text(),
        status,
        error_detail,
    )
    .await;
}

#[allow(clippy::too_many_arguments)]
async fn dispatch_command(
    text: &str,
    prefix: &str,
    db: &DatabaseConnection,
    manager: &ChatChannelManager,
    conn_mgr: &ConnectionManager,
    emitter: &EventEmitter,
    bridge: &Arc<Mutex<SessionBridge>>,
    data_dir: &Path,
    channel_id: i32,
    sender_id: &str,
    target: &ChannelMessageTarget,
    callback_data: Option<&str>,
    lang: Lang,
) -> DispatchResponse {
    if let Some(data) = callback_data {
        return DispatchResponse::current(
            session_commands::handle_callback(db, data, channel_id, sender_id, lang, prefix).await,
            target,
        );
    }

    // Strip prefix; if text doesn't start with it, try as follow-up
    let without_prefix = match text.strip_prefix(prefix) {
        Some(rest) => rest,
        None => {
            if target.is_telegram_general_topic() {
                return DispatchResponse::none(target);
            }

            if target.is_telegram_forum_topic() {
                return DispatchResponse::current(
                    session_commands::handle_followup(session_commands::FollowupRequest {
                        db,
                        text,
                        channel_id,
                        sender_id,
                        target,
                        conn_mgr,
                        emitter,
                        bridge,
                        data_dir,
                        lang,
                        prefix,
                    })
                    .await,
                    target,
                );
            }

            // Check if sender has an active session for follow-up
            let has_session = {
                let guard = bridge.lock().await;
                guard.find_by_sender(channel_id, sender_id).is_some()
            };
            if has_session {
                return DispatchResponse::current(
                    session_commands::handle_followup(session_commands::FollowupRequest {
                        db,
                        text,
                        channel_id,
                        sender_id,
                        target,
                        conn_mgr,
                        emitter,
                        bridge,
                        data_dir,
                        lang,
                        prefix,
                    })
                    .await,
                    target,
                );
            }
            return DispatchResponse::current(command_handlers::handle_help(prefix, lang), target);
        }
    };

    let parts: Vec<&str> = without_prefix.splitn(2, ' ').collect();
    let command = parts[0].to_lowercase();
    let args = parts.get(1).map(|s| s.trim()).unwrap_or("");

    match command.as_str() {
        // Existing commands
        "search" => {
            if args.is_empty() {
                DispatchResponse::current(
                    RichMessage::info(i18n::search_usage(lang, prefix))
                        .with_title(i18n::invalid_args_title(lang)),
                    target,
                )
            } else {
                DispatchResponse::current(
                    command_handlers::handle_search(db, args, lang).await,
                    target,
                )
            }
        }
        "today" => {
            DispatchResponse::current(command_handlers::handle_today(db, lang).await, target)
        }
        "status" => {
            DispatchResponse::current(command_handlers::handle_status(manager, lang).await, target)
        }
        "help" | "start" => {
            DispatchResponse::current(command_handlers::handle_help(prefix, lang), target)
        }

        // Session commands
        "folder" => {
            if args.is_empty() {
                DispatchResponse::from_session_message(
                    session_commands::handle_folder_picker(db, channel_id, sender_id, lang, prefix)
                        .await,
                    target,
                )
            } else {
                DispatchResponse::current(
                    session_commands::handle_folder(db, args, channel_id, sender_id, lang, prefix)
                        .await,
                    target,
                )
            }
        }
        "agent" => {
            if args.is_empty() {
                DispatchResponse::from_session_message(
                    session_commands::handle_agent_picker(db, channel_id, sender_id, lang, prefix)
                        .await,
                    target,
                )
            } else {
                DispatchResponse::current(
                    session_commands::handle_agent(db, args, channel_id, sender_id, lang, prefix)
                        .await,
                    target,
                )
            }
        }
        "task" | "do" => {
            let result = session_commands::handle_task(
                db, args, channel_id, sender_id, target, manager, conn_mgr, emitter, bridge, lang,
                prefix, data_dir,
            )
            .await;
            DispatchResponse {
                message: Some(DispatchMessage::Rich(result.message)),
                target: result.response_target,
                extra_messages: result
                    .extra_responses
                    .into_iter()
                    .map(|(message, target)| (DispatchMessage::Rich(message), target))
                    .collect(),
                post_action: result.post_action,
            }
        }
        "sessions" => DispatchResponse::current(
            session_commands::handle_sessions(db, channel_id, sender_id, target, lang, prefix)
                .await,
            target,
        ),
        "resume" => DispatchResponse::current(
            session_commands::handle_resume(
                db, args, channel_id, sender_id, target, manager, conn_mgr, emitter, bridge, lang,
                prefix, data_dir,
            )
            .await,
            target,
        ),
        "cancel" => DispatchResponse::current(
            session_commands::handle_cancel(
                db, channel_id, sender_id, target, conn_mgr, bridge, lang,
            )
            .await,
            target,
        ),
        "approve" => {
            let always = args.eq_ignore_ascii_case("always");
            DispatchResponse::current(
                session_commands::handle_permission_response(
                    true, always, db, channel_id, sender_id, target, conn_mgr, bridge, lang,
                )
                .await,
                target,
            )
        }
        "deny" => DispatchResponse::current(
            session_commands::handle_permission_response(
                false, false, db, channel_id, sender_id, target, conn_mgr, bridge, lang,
            )
            .await,
            target,
        ),

        _ => DispatchResponse::current(
            RichMessage::info(i18n::unknown_command(lang, prefix, &command))
                .with_title(i18n::unknown_command_title(lang)),
            target,
        ),
    }
}

struct DispatchResponse {
    message: Option<DispatchMessage>,
    target: ChannelMessageTarget,
    extra_messages: Vec<(DispatchMessage, ChannelMessageTarget)>,
    post_action: Option<session_commands::CommandPostAction>,
}

impl DispatchResponse {
    fn current(message: RichMessage, target: &ChannelMessageTarget) -> Self {
        Self {
            message: Some(DispatchMessage::Rich(message)),
            target: target.clone(),
            extra_messages: Vec::new(),
            post_action: None,
        }
    }

    fn from_session_message(
        message: session_commands::SessionCommandMessage,
        target: &ChannelMessageTarget,
    ) -> Self {
        Self {
            message: Some(match message {
                session_commands::SessionCommandMessage::Rich(message) => {
                    DispatchMessage::Rich(message)
                }
                session_commands::SessionCommandMessage::Interactive(message) => {
                    DispatchMessage::Interactive(message)
                }
            }),
            target: target.clone(),
            extra_messages: Vec::new(),
            post_action: None,
        }
    }

    fn none(target: &ChannelMessageTarget) -> Self {
        Self {
            message: None,
            target: target.clone(),
            extra_messages: Vec::new(),
            post_action: None,
        }
    }
}

enum DispatchMessage {
    Rich(RichMessage),
    Interactive(InteractiveMessage),
}

impl DispatchMessage {
    fn title(&self) -> Option<&String> {
        match self {
            Self::Rich(message) => message.title.as_ref(),
            Self::Interactive(message) => message.base.title.as_ref(),
        }
    }

    fn body_len(&self) -> usize {
        match self {
            Self::Rich(message) => message.body.len(),
            Self::Interactive(message) => message.base.body.len(),
        }
    }

    fn to_plain_text(&self) -> String {
        match self {
            Self::Rich(message) => message.to_plain_text(),
            Self::Interactive(message) => message.to_rich_fallback().to_plain_text(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::service::{chat_channel_service, sender_context_service};
    use crate::db::test_helpers::{fresh_in_memory_db, seed_folder};

    async fn seed_chat_channel(db: &crate::db::AppDatabase) -> i32 {
        chat_channel_service::create(
            &db.conn,
            "Telegram test".to_string(),
            "telegram".to_string(),
            serde_json::json!({ "chat_id": "-100123", "topic_mode": true }).to_string(),
            true,
            false,
            None,
        )
        .await
        .expect("seed chat channel")
        .id
    }

    #[tokio::test]
    async fn callback_data_dispatches_without_command_prefix() {
        let db = fresh_in_memory_db().await;
        let channel_id = seed_chat_channel(&db).await;
        let folder_id = seed_folder(&db, "/tmp/codeg-dispatch-callback").await;
        let target = ChannelMessageTarget::telegram_general(channel_id, "-100123");
        let bridge = Arc::new(Mutex::new(SessionBridge::new()));

        let response = dispatch_command(
            "cfg:folder:ignored-by-callback-data",
            "/",
            &db.conn,
            &ChatChannelManager::new(),
            &ConnectionManager::new(),
            &EventEmitter::Noop,
            &bridge,
            std::path::Path::new("/tmp/codeg-dispatch-data"),
            channel_id,
            "sender-1",
            &target,
            Some(&format!("cfg:folder:{folder_id}")),
            Lang::En,
        )
        .await;
        let ctx = sender_context_service::get_or_create(&db.conn, channel_id, "sender-1")
            .await
            .expect("context");

        assert!(matches!(response.message, Some(DispatchMessage::Rich(_))));
        assert_eq!(ctx.current_folder_id, Some(folder_id));
    }

    #[tokio::test]
    async fn general_topic_plain_text_returns_no_response() {
        let db = fresh_in_memory_db().await;
        let channel_id = seed_chat_channel(&db).await;
        let target = ChannelMessageTarget::telegram_general(channel_id, "-100123");
        let bridge = Arc::new(Mutex::new(SessionBridge::new()));

        let response = dispatch_command(
            "hello group",
            "/",
            &db.conn,
            &ChatChannelManager::new(),
            &ConnectionManager::new(),
            &EventEmitter::Noop,
            &bridge,
            std::path::Path::new("/tmp/codeg-dispatch-data"),
            channel_id,
            "sender-1",
            &target,
            None,
            Lang::En,
        )
        .await;

        assert!(response.message.is_none());
        assert_eq!(response.target, target);
    }
}
