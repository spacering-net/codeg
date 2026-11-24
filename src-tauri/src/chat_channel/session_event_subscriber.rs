use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::{Duration, Instant};

use sea_orm::DatabaseConnection;
use tokio::sync::Mutex;
use tokio::task::JoinHandle;

use super::i18n::Lang;
use super::session_bridge::{PendingPermission, SessionBridge};
use super::tool_detail::{format_tool_call_detail, truncate_str};
use super::types::{ChannelMessageTarget, MessageLevel, RichMessage};
use crate::acp::internal_bus::InternalEventBus;
use crate::acp::manager::ConnectionManager;
use crate::acp::types::{
    AcpEvent, ConnectionStatus, DelegationResultSummary, EventEnvelope, PermissionAnswerOrigin,
    PermissionOptionInfo, PromptInputBlock,
};

use crate::db::service::{
    app_metadata_service, conversation_service, sender_context_service, thread_binding_service,
};
use crate::logging::throttle::{LagLogThrottle, LAG_LOG_WINDOW};
use crate::web::event_bridge::EventEmitter;

use super::manager::ChatChannelManager;

const FLUSH_INTERVAL_SECS: u64 = 10;
const BUFFER_FLUSH_THRESHOLD: usize = 500;
const MAX_MESSAGE_LEN: usize = 2000;
const MESSAGE_LANGUAGE_KEY: &str = "chat_message_language";
const COMMAND_PREFIX_KEY: &str = "chat_command_prefix";
const DEFAULT_COMMAND_PREFIX: &str = "/";

/// `emitter` must be the process-wide, long-lived emitter — NOT one looked up
/// per connection. This subscriber consumes `SessionStarted` asynchronously off
/// the broadcast bus, and connection cleanup removes the manager entry right
/// after queuing its terminal events, so a per-`connection_id` lookup can
/// legitimately come back empty by the time an event is handled. That would
/// leave a preserved conversation row created but never broadcast — invisible
/// to the user, which is the very failure being fixed (see
/// `emit_preserved_conversation`).
pub fn spawn_session_event_subscriber(
    bus: Arc<InternalEventBus>,
    bridge: Arc<Mutex<SessionBridge>>,
    manager: ChatChannelManager,
    conn_mgr: ConnectionManager,
    db_conn: DatabaseConnection,
    emitter: EventEmitter,
) -> JoinHandle<()> {
    let mut rx = bus.subscribe();
    let metrics = Arc::clone(bus.metrics());

    tokio::spawn(async move {
        let mut last_heartbeat = Instant::now();
        let mut lag_throttle = LagLogThrottle::new(LAG_LOG_WINDOW);

        loop {
            tokio::select! {
                result = rx.recv() => {
                    let envelope_arc = match result {
                        Ok(e) => e,
                        Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                            metrics.lagged_count.fetch_add(n, Ordering::Relaxed);
                            if let Some(s) = lag_throttle.record(n) {
                                tracing::warn!(
                                    "[SessionEventSub] lagged: dropped {} events across \
                                     {} occurrence(s) in the last {}s",
                                    s.dropped,
                                    s.occurrences,
                                    LAG_LOG_WINDOW.as_secs()
                                );
                            }
                            continue;
                        }
                        Err(_) => break,
                    };

                    handle_acp_envelope(
                        envelope_arc.as_ref(),
                        &bridge,
                        &manager,
                        &conn_mgr,
                        &db_conn,
                        &emitter,
                    )
                    .await;
                }
                _ = tokio::time::sleep(Duration::from_secs(FLUSH_INTERVAL_SECS)) => {
                    if last_heartbeat.elapsed() >= Duration::from_secs(FLUSH_INTERVAL_SECS) {
                        flush_progress(&bridge, &manager, &db_conn).await;
                        last_heartbeat = Instant::now();
                    }
                }
            }
        }
    })
}

async fn get_lang(db: &DatabaseConnection) -> Lang {
    app_metadata_service::get_value(db, MESSAGE_LANGUAGE_KEY)
        .await
        .ok()
        .flatten()
        .map(|v| Lang::from_str_lossy(&v))
        .unwrap_or_default()
}

async fn get_prefix(db: &DatabaseConnection) -> String {
    app_metadata_service::get_value(db, COMMAND_PREFIX_KEY)
        .await
        .ok()
        .flatten()
        .unwrap_or_else(|| DEFAULT_COMMAND_PREFIX.to_string())
}

/// Phase 5: typed-envelope dispatcher. Replaces the prior JSON
/// `payload.get("type").as_str()` switch — every accessor we used to need
/// (type / connection_id / event-specific fields) is now a structural
/// match on `AcpEvent`, with no `unwrap_or("")` defensive fallbacks.
async fn handle_acp_envelope(
    envelope: &EventEnvelope,
    bridge: &Arc<Mutex<SessionBridge>>,
    manager: &ChatChannelManager,
    conn_mgr: &ConnectionManager,
    db: &DatabaseConnection,
    emitter: &EventEmitter,
) {
    let connection_id = envelope.connection_id.as_str();

    match &envelope.payload {
        AcpEvent::SessionStarted { session_id } => {
            let mut guard = bridge.lock().await;
            if let Some(session) = guard.get_mut(connection_id) {
                // Guarded bind — the bridge registers `conversation_id` up
                // front, so this writes onto an ALREADY-bound row and would
                // otherwise overwrite the id its history hangs off if the
                // session was re-minted (codeg#500). Whichever of this
                // subscriber and the lifecycle one wins the race, the loser
                // gets `None` and the row is preserved exactly once.
                let continues =
                    crate::acp::continued_session_ids(session.agent_type, session_id);
                match conversation_service::bind_external_id(
                    db,
                    session.conversation_id,
                    session_id,
                    &continues,
                )
                .await
                {
                    Ok(preserved) => {
                        crate::commands::conversations::emit_preserved_conversation(
                            emitter, db, preserved,
                        )
                        .await;
                    }
                    // A CONFLICT is permanent and disqualifying: the session
                    // belongs to a different conversation row, so this route
                    // will never be able to hold it. Dispatching the kickoff
                    // would file the task's opening turn into the HOLDER row's
                    // transcript while every event named this one.
                    //
                    // The ROUTE is torn down, not just this one prompt.
                    // Withholding the kickoff alone would be illusory in two
                    // ways: `pending_prompt` is picked up again by the
                    // `TurnComplete` arm below, which re-sends a deferred
                    // kickoff WITHOUT re-checking ownership; and the bridge
                    // entry would survive, so the remote user's NEXT message
                    // finds it and dispatches through `send_prompt` just the
                    // same. Either way the turn lands in the holder row's
                    // transcript.
                    //
                    // So this takes the file's established terminal path,
                    // identical to a terminal `AcpEvent::Error`: drop the
                    // bridge entry, tell the requester, mark the conversation
                    // `Cancelled`, and clear the persisted channel→session
                    // route. The connection itself is deliberately NOT
                    // cancelled — the terminal-error path does not either, and
                    // another surface may legitimately own it.
                    //
                    // Every OTHER error keeps the previous behaviour and falls
                    // through to the send. Those are dominated by transient
                    // SQLite contention, and `pending_prompt` is consumed by
                    // `.take()` below — tearing the route down for one would
                    // kill a session that was about to work.
                    //
                    // GATED ON THE EVENT STILL BEING CURRENT. A `Conflict`
                    // proves the session in THIS envelope belongs elsewhere; it
                    // does NOT prove the route is bad, because the envelope may
                    // be stale. This subscriber and the lifecycle one drain the
                    // bus independently, so after a fork advances the row from
                    // S1 to S2 (leaving a sibling holding S1) a backed-up
                    // `SessionStarted{S1}` still arrives here and conflicts
                    // against that sibling — while the route itself is happily
                    // on S2. Tearing down on that would destroy a healthy
                    // session, which is strictly worse than the misfiling this
                    // arm exists to prevent. Only act when the connection's
                    // live session is still the one that just failed to bind;
                    // anything else (including a connection that has already
                    // gone away, where we cannot tell) falls back to the old
                    // log-and-continue.
                    Err(crate::db::error::DbError::Conflict(detail)) => {
                        let channel_id = session.channel_id;
                        let sender_id = session.sender_id.clone();
                        let target = session.target.clone();
                        let conv_id = session.conversation_id;

                        let is_current = match conn_mgr.get_state(connection_id).await {
                            Some(state) => {
                                state.read().await.external_id.as_deref() == Some(session_id.as_str())
                            }
                            None => false,
                        };
                        if !is_current {
                            tracing::warn!(
                                conversation_id = conv_id,
                                detail,
                                stale_session = %session_id,
                                "[SessionEventSub] stale SessionStarted conflicts; leaving the \
                                 route alone because the connection has moved on"
                            );
                            return;
                        }

                        tracing::warn!(
                            conversation_id = conv_id,
                            detail,
                            "[SessionEventSub] session belongs to another conversation; \
                             tearing down the chat route rather than misfiling into it"
                        );
                        guard.remove(connection_id);
                        drop(guard);

                        // Persisted route cleared BEFORE the notification await.
                        // `clear_session_route` deletes by (channel, sender,
                        // target) with no compare-and-swap, so any await ahead
                        // of it widens a window in which a REPLACEMENT route for
                        // the same chat thread gets created and then wiped by
                        // this handler. Nothing here needs the send to have
                        // happened first.
                        let _ = conversation_service::update_status(
                            db,
                            conv_id,
                            crate::db::entities::conversation::ConversationStatus::Cancelled,
                        )
                        .await;
                        clear_session_route(db, channel_id, &sender_id, &target).await;

                        let lang = get_lang(db).await;
                        let _ = manager
                            .send_to_target(
                                &target,
                                &RichMessage::error(match lang {
                                    Lang::ZhCn | Lang::ZhTw => {
                                        "无法启动任务：该智能体会话已归属于另一个对话。"
                                            .to_string()
                                    }
                                    _ => "Could not start the task: this agent session \
                                          already belongs to another conversation."
                                        .to_string(),
                                }),
                            )
                            .await;
                        return;
                    }
                    Err(e) => tracing::warn!(
                        conversation_id = session.conversation_id,
                        error = %e,
                        "[SessionEventSub] failed to bind the session id"
                    ),
                }

                if let Some(prompt_text) = session.pending_prompt.take() {
                    // Clone so the prompt can be RESTORED (not dropped) if a turn
                    // is already in flight — see the TurnInProgress arm below.
                    let blocks = vec![PromptInputBlock::Text {
                        text: prompt_text.clone(),
                    }];
                    if let Err(e) = conn_mgr.send_prompt(connection_id, blocks).await {
                        // A turn is already in flight on this shared connection
                        // (another client raced this kickoff between
                        // SessionStarted and here). Transient, not a failure —
                        // RESTORE the pending prompt so the TurnComplete handler
                        // retries the kickoff once the in-flight turn finishes,
                        // instead of silently dropping the task's initial prompt.
                        if matches!(e, crate::acp::error::AcpError::TurnInProgress) {
                            session.pending_prompt = Some(prompt_text);
                            tracing::warn!(
                                "[SessionEventSub] kickoff deferred; a turn is already in \
                                 progress, will retry on TurnComplete"
                            );
                            let target = session.target.clone();
                            let lang = get_lang(db).await;
                            let msg = RichMessage::info(
                                super::i18n::task_deferred_busy(lang).to_string(),
                            );
                            let _ = manager.send_to_target(&target, &msg).await;
                        } else {
                            tracing::error!("[SessionEventSub] failed to send pending prompt: {e}");
                            let target = session.target.clone();
                            let msg = RichMessage::error(format!("Failed to send task: {e}"));
                            let _ = manager.send_to_target(&target, &msg).await;
                        }
                    }
                }
            }
        }

        AcpEvent::ContentDelta {
            text,
            parent_tool_use_id,
        } => {
            // Chat channels mirror the MAIN thread only: a Claude subagent's
            // parented transcript chunks belong to the Agent capsule, not the
            // channel message stream.
            if parent_tool_use_id.is_some() {
                return;
            }
            // Collect flush info under the lock, then release before any IO.
            let flush_info: Option<(ChannelMessageTarget, String, Option<String>)> = {
                let mut guard = bridge.lock().await;
                match guard.get_mut(connection_id) {
                    Some(session) => {
                        session.content_buffer.push_str(text);
                        if session.content_buffer.len() >= BUFFER_FLUSH_THRESHOLD
                            && session.last_flushed.elapsed() >= Duration::from_secs(2)
                        {
                            session.last_flushed = Instant::now();
                            Some((
                                session.target.clone(),
                                session.agent_type.to_string(),
                                session.tool_calls.last().cloned(),
                            ))
                        } else {
                            None
                        }
                    }
                    None => None,
                }
            };

            if let Some((target, agent_label, last_tool)) = flush_info {
                let lang = get_lang(db).await;
                let mut status = super::i18n::agent_responding(lang, &agent_label);
                if let Some(tool) = last_tool {
                    status.push_str(&format!(" | {tool}"));
                }
                let msg = RichMessage::info(status);
                let _ = manager.send_to_target(&target, &msg).await;
            }
        }

        AcpEvent::ToolCall {
            tool_call_id,
            title,
            raw_input,
            ..
        } => {
            // Emit a "delegation started" placeholder to the channel so
            // remote users see something happen as soon as the parent agent
            // fires `delegate_to_agent`, not only when the child wraps up.
            let delegation_announce = if is_delegation_title(title) {
                raw_input
                    .as_deref()
                    .and_then(extract_agent_type)
                    .map(|agent| format!("🤖 Delegating to {agent}…"))
            } else {
                None
            };

            let mut guard = bridge.lock().await;
            if let Some(session) = guard.get_mut(connection_id) {
                // Store title for progress indicator; store raw_input for later
                session.tool_calls.push(title.clone());
                if let Some(input) = raw_input.as_deref() {
                    session
                        .tool_call_inputs
                        .insert(tool_call_id.clone(), input.to_string());
                }
                if let Some(text) = delegation_announce {
                    let target = session.target.clone();
                    drop(guard);
                    let msg = RichMessage::info(text);
                    let _ = manager.send_to_target(&target, &msg).await;
                }
            }
        }

        AcpEvent::ToolCallUpdate {
            tool_call_id,
            title,
            status,
            raw_input,
            raw_output,
            ..
        } => {
            let mut guard = bridge.lock().await;
            if let Some(session) = guard.get_mut(connection_id) {
                // Accumulate raw_input if newly available
                if let Some(input) = raw_input.as_deref() {
                    session
                        .tool_call_inputs
                        .insert(tool_call_id.clone(), input.to_string());
                }

                if status.as_deref() == Some("completed") {
                    let effective_title = title.as_deref().unwrap_or("tool");
                    let is_delegation = is_delegation_title(effective_title)
                        || session
                            .tool_call_inputs
                            .get(tool_call_id)
                            .map(|s| names_delegation_target(s))
                            .unwrap_or(false)
                        || raw_input
                            .as_deref()
                            .map(names_delegation_target)
                            .unwrap_or(false);
                    let target = session.target.clone();
                    if is_delegation {
                        let already_rendered = session.delegation_rendered.contains(tool_call_id);
                        let report = parse_delegation_report(raw_output.as_deref());
                        if report.as_ref().is_some_and(|r| r.is_terminal()) {
                            // Terminal tool output (a fast-complete result, or a
                            // setup failure). Render it EXACTLY ONCE, gated on the
                            // `delegation_rendered` marker (NOT the input map,
                            // which `raw_input` updates re-populate). This is the
                            // only surface for setup failures and synthetic-id
                            // fast-completes (neither emits `DelegationCompleted`),
                            // and it no-ops when the completion event already
                            // rendered first.
                            if !already_rendered {
                                let agent = delegation_target_label(
                                    session
                                        .tool_call_inputs
                                        .get(tool_call_id)
                                        .map(String::as_str)
                                        .or(raw_input.as_deref()),
                                    report.as_ref().and_then(|r| r.assistant_name.as_deref()),
                                )
                                .unwrap_or_else(|| "agent".to_string());
                                let body =
                                    format_delegation_terminal(&agent, report.as_ref().unwrap());
                                session.delegation_rendered.insert(tool_call_id.clone());
                                session.tool_call_inputs.remove(tool_call_id);
                                drop(guard);
                                let msg = RichMessage::info(body);
                                let _ = manager.send_to_target(&target, &msg).await;
                            }
                        } else if !already_rendered {
                            // Running ack (or unparseable output): announce the
                            // background task. KEEP the stored input — the eventual
                            // `DelegationCompleted` render needs the agent_type.
                            // Suppressed once the result has rendered, so a late
                            // re-emitted ack can't appear after the result.
                            let agent = delegation_target_label(
                                session
                                    .tool_call_inputs
                                    .get(tool_call_id)
                                    .map(String::as_str)
                                    .or(raw_input.as_deref()),
                                report.as_ref().and_then(|r| r.assistant_name.as_deref()),
                            )
                            .unwrap_or_else(|| "agent".to_string());
                            drop(guard);
                            let msg = RichMessage::info(format_delegation_ack(&agent));
                            let _ = manager.send_to_target(&target, &msg).await;
                        }
                    } else {
                        let stored_input = session.tool_call_inputs.remove(tool_call_id);
                        let input_ref = stored_input.as_deref().or(raw_input.as_deref());
                        let body =
                            format!(">> {}", format_tool_call_detail(effective_title, input_ref));
                        drop(guard);
                        let msg = RichMessage::info(body);
                        let _ = manager.send_to_target(&target, &msg).await;
                    }
                }
            }
        }

        // The async delegation result for the normal (slow) case: the tool
        // output was a running ack (handled above), and the child's final
        // outcome surfaces here. Rendered EXACTLY ONCE via the same stored-input
        // dedup token — if a terminal `ToolCallUpdate` already rendered (and
        // removed it), skip. (A synthetic `parent_tool_use_id` never reaches a
        // bridged session's stored input, so this arm no-ops for synthetic ids,
        // which is correct — the terminal `ToolCallUpdate` is their surface.)
        AcpEvent::DelegationCompleted {
            parent_tool_use_id,
            result,
            assistant_name,
            ..
        } => {
            let mut guard = bridge.lock().await;
            if let Some(session) = guard.get_mut(connection_id) {
                // Render EXACTLY ONCE, gated on the `delegation_rendered` marker:
                // if a terminal `ToolCallUpdate` already rendered this task's
                // result, skip. (A synthetic `parent_tool_use_id` is never emitted
                // here at all, so this arm naturally no-ops for synthetic ids —
                // the terminal `ToolCallUpdate` is their surface.)
                if !session.delegation_rendered.contains(parent_tool_use_id) {
                    let stored_input = session.tool_call_inputs.remove(parent_tool_use_id);
                    let agent =
                        delegation_target_label(stored_input.as_deref(), assistant_name.as_deref())
                            .unwrap_or_else(|| "sub-agent".to_string());
                    session
                        .delegation_rendered
                        .insert(parent_tool_use_id.clone());
                    let target = session.target.clone();
                    drop(guard);
                    let msg = RichMessage::info(format_delegation_result(&agent, result));
                    let _ = manager.send_to_target(&target, &msg).await;
                }
            }
        }

        AcpEvent::PermissionRequest {
            request_id,
            tool_call,
            options,
            // The chat-channel bridge renders one card per event, so the
            // queued-behind count is not part of its message shape.
            queued: _,
        } => {
            let mut guard = bridge.lock().await;
            if let Some(session) = guard.get_mut(connection_id) {
                let channel_id = session.channel_id;
                let sender_id = session.sender_id.clone();
                let target = session.target.clone();

                let auto_approve =
                    sender_context_service::get_or_create(db, channel_id, &sender_id)
                        .await
                        .map(|ctx| ctx.auto_approve)
                        .unwrap_or(false);

                // Auto-approve answers one call at a time, with the allow-once
                // option (see `allow_once_in`). A request without one goes to
                // the chat like any other, for the sender to answer.
                let auto_option = if auto_approve {
                    PermissionOptionInfo::allow_once_in(options).map(|o| o.option_id.clone())
                } else {
                    None
                };
                if let Some(oid) = auto_option {
                    drop(guard);
                    let _ = conn_mgr
                        .respond_permission_from(
                            connection_id,
                            request_id,
                            &oid,
                            PermissionAnswerOrigin::ChatChannel,
                        )
                        .await;
                    return;
                }

                let tool_title = tool_call
                    .get("title")
                    .and_then(|v| v.as_str())
                    .or_else(|| tool_call.get("tool_name").and_then(|v| v.as_str()))
                    .unwrap_or("Unknown tool");

                // Extract detail from rawInput / raw_input in the tool_call object
                let raw_input_str = tool_call
                    .get("rawInput")
                    .or_else(|| tool_call.get("raw_input"))
                    .and_then(|v| match v {
                        serde_json::Value::String(s) => Some(s.clone()),
                        serde_json::Value::Null => None,
                        other => Some(other.to_string()),
                    });
                let tool_desc = format_tool_call_detail(tool_title, raw_input_str.as_deref());

                session.permission_pending = Some(PendingPermission {
                    request_id: request_id.clone(),
                    tool_description: tool_desc.clone(),
                    options: options.clone(),
                    sent_message_id: None,
                });

                drop(guard);

                let lang = get_lang(db).await;
                let prefix = get_prefix(db).await;
                let mut body = match lang {
                    Lang::ZhCn | Lang::ZhTw => {
                        format!("Agent 请求权限: {tool_desc}\n\n{prefix}approve 批准 | {prefix}deny 拒绝 | {prefix}approve always 自动批准")
                    }
                    _ => {
                        format!("Agent requests permission: {tool_desc}\n\n{prefix}approve | {prefix}deny | {prefix}approve always")
                    }
                };
                // Auto-approve is on, yet this request reached the chat.
                if auto_approve {
                    body.push_str(match lang {
                        Lang::ZhCn | Lang::ZhTw => {
                            "\n\n自动批准跳过了这个请求：它没有「只允许这一次」的选项。"
                        }
                        _ => "\n\nAuto-approve skipped this request: it has no allow-once option.",
                    });
                }

                let msg = RichMessage {
                    title: Some(match lang {
                        Lang::ZhCn | Lang::ZhTw => "权限请求".to_string(),
                        _ => "Permission Request".to_string(),
                    }),
                    body,
                    fields: Vec::new(),
                    level: MessageLevel::Warning,
                };
                let _ = manager.send_to_target(&target, &msg).await;
            }
        }

        AcpEvent::TurnComplete {
            stop_reason,
            agent_type,
            ..
        } => {
            let mut guard = bridge.lock().await;
            if let Some(session) = guard.get_mut(connection_id) {
                let target = session.target.clone();
                let conv_id = session.conversation_id;
                let content = std::mem::take(&mut session.content_buffer);
                let tool_count = session.tool_calls.len();
                session.tool_calls.clear();
                session.last_flushed = Instant::now();
                // A kickoff prompt deferred by `SessionStarted` (the connection
                // was already mid-turn for another client) waits here. Take it
                // BEFORE dropping the guard so a second TurnComplete can't
                // double-send it; retry below once the lock is released.
                let deferred_kickoff = session.pending_prompt.take();
                drop(guard);

                let lang = get_lang(db).await;
                let body = format_completion(&content, tool_count, lang);

                let msg = RichMessage::info(body)
                    .with_title(match lang {
                        Lang::ZhCn | Lang::ZhTw => "任务完成",
                        _ => "Turn Complete",
                    })
                    .with_field("Agent", agent_type)
                    .with_field(
                        match lang {
                            Lang::ZhCn | Lang::ZhTw => "结束原因",
                            _ => "Stop Reason",
                        },
                        localize_stop_reason(stop_reason, lang),
                    );

                let _ = manager.send_to_target(&target, &msg).await;

                if stop_reason == "end_turn" {
                    let _ = conversation_service::update_status(
                        db,
                        conv_id,
                        crate::db::entities::conversation::ConversationStatus::Completed,
                    )
                    .await;
                }

                // Retry the deferred kickoff now the turn that blocked it ended.
                // If yet ANOTHER turn slipped in (another client raced this
                // TurnComplete), restore the prompt for the next TurnComplete —
                // never drop it.
                if let Some(prompt_text) = deferred_kickoff {
                    let blocks = vec![PromptInputBlock::Text {
                        text: prompt_text.clone(),
                    }];
                    if let Err(e) = conn_mgr.send_prompt(connection_id, blocks).await {
                        if matches!(e, crate::acp::error::AcpError::TurnInProgress) {
                            let mut g = bridge.lock().await;
                            if let Some(s) = g.get_mut(connection_id) {
                                s.pending_prompt = Some(prompt_text);
                            }
                            tracing::warn!(
                                "[SessionEventSub] deferred kickoff still blocked; will retry on \
                                 next TurnComplete"
                            );
                        } else {
                            tracing::error!("[SessionEventSub] failed to send deferred kickoff: {e}");
                            let msg = RichMessage::error(format!("Failed to send task: {e}"));
                            let _ = manager.send_to_target(&target, &msg).await;
                        }
                    }
                }
            }
        }

        AcpEvent::Error {
            message,
            agent_type,
            terminal,
            ..
        } => {
            // Non-terminal Errors (`turn_failure_error_event`,
            // `session/load` fallback, empty-prompt rejection, SetMode /
            // SetConfigOption failures) leave the ACP connection alive —
            // the next prompt on the same session will still work. Posting
            // the error to the channel is useful, but tearing down the
            // bridge session and flipping the conversation row to
            // Cancelled would break remote chat-channel users (their next
            // message would spawn a brand-new session, losing context).
            // The lifecycle worker mirrors this gating; see F2 in the
            // v0.14.3 sub-agent delegation post-mortem.
            let lang = get_lang(db).await;
            let msg = RichMessage {
                title: Some(match lang {
                    Lang::ZhCn | Lang::ZhTw => "Agent 错误".to_string(),
                    _ => "Agent Error".to_string(),
                }),
                body: format!("[{agent_type}] {message}"),
                fields: Vec::new(),
                level: MessageLevel::Error,
            };

            if !*terminal {
                let target = {
                    let guard = bridge.lock().await;
                    guard.get(connection_id).map(|s| s.target.clone())
                };
                if let Some(target) = target {
                    let _ = manager.send_to_target(&target, &msg).await;
                }
                return;
            }

            let mut guard = bridge.lock().await;
            if let Some(session) = guard.remove(connection_id) {
                let channel_id = session.channel_id;
                let sender_id = session.sender_id.clone();
                let target = session.target.clone();
                let conv_id = session.conversation_id;
                drop(guard);

                let _ = manager.send_to_target(&target, &msg).await;

                let _ = conversation_service::update_status(
                    db,
                    conv_id,
                    crate::db::entities::conversation::ConversationStatus::Cancelled,
                )
                .await;
                clear_session_route(db, channel_id, &sender_id, &target).await;
            }
        }

        AcpEvent::StatusChanged { status } => {
            if matches!(
                status,
                ConnectionStatus::Disconnected | ConnectionStatus::Error
            ) {
                let mut guard = bridge.lock().await;
                if let Some(session) = guard.remove(connection_id) {
                    let channel_id = session.channel_id;
                    let sender_id = session.sender_id.clone();
                    let target = session.target.clone();
                    drop(guard);

                    clear_session_route(db, channel_id, &sender_id, &target).await;
                }
            }
        }

        _ => {}
    }
}

async fn flush_progress(
    bridge: &Arc<Mutex<SessionBridge>>,
    manager: &ChatChannelManager,
    db: &DatabaseConnection,
) {
    let lang = get_lang(db).await;
    let updates: Vec<(ChannelMessageTarget, String)> = {
        let mut guard = bridge.lock().await;
        let mut out = Vec::new();
        for session in guard.all_sessions_mut() {
            if !session.content_buffer.is_empty()
                && session.last_flushed.elapsed() >= Duration::from_secs(FLUSH_INTERVAL_SECS)
            {
                session.last_flushed = Instant::now();
                let last_tool = session.tool_calls.last().cloned();
                let agent_label = session.agent_type.to_string();
                let mut status = super::i18n::agent_responding(lang, &agent_label);
                if let Some(tool) = last_tool {
                    status.push_str(&format!(" | {tool}"));
                }
                out.push((session.target.clone(), status));
            }
        }
        out
    };

    for (target, text) in updates {
        let msg = RichMessage::info(text);
        let _ = manager.send_to_target(&target, &msg).await;
    }
}

async fn clear_session_route(
    db: &DatabaseConnection,
    channel_id: i32,
    sender_id: &str,
    target: &ChannelMessageTarget,
) {
    if target.is_telegram_forum_topic() {
        if let Ok(Some(binding)) = thread_binding_service::get_by_target(db, target).await {
            let _ = thread_binding_service::clear_connection(db, binding.id).await;
        }
    } else {
        let _ = sender_context_service::clear_session(db, channel_id, sender_id).await;
    }
}

fn format_completion(content: &str, tool_count: usize, lang: Lang) -> String {
    if content.is_empty() {
        return match lang {
            Lang::ZhCn | Lang::ZhTw => format!("(无文本输出, {tool_count} 次工具调用)"),
            _ => format!("(No text output, {tool_count} tool calls)"),
        };
    }

    if content.len() <= MAX_MESSAGE_LEN {
        let mut body = content.to_string();
        if tool_count > 0 {
            body.push_str(&format!(
                "\n\n[{} {}]",
                tool_count,
                match lang {
                    Lang::ZhCn | Lang::ZhTw => "次工具调用",
                    _ => "tool calls",
                }
            ));
        }
        return body;
    }

    // Truncate long content (use char boundaries to avoid panic on multi-byte)
    let head_end = content
        .char_indices()
        .nth(500)
        .map(|(i, _)| i)
        .unwrap_or(content.len());
    let head = &content[..head_end];
    let tail_start = content
        .char_indices()
        .rev()
        .nth(499)
        .map(|(i, _)| i)
        .unwrap_or(0);
    let tail = &content[tail_start..];

    match lang {
        Lang::ZhCn | Lang::ZhTw => {
            format!(
                "{head}\n\n...\n\n{tail}\n\n[完整回复: {} 字符, {tool_count} 次工具调用]",
                content.len()
            )
        }
        _ => {
            format!(
                "{head}\n\n...\n\n{tail}\n\n[Full response: {} chars, {tool_count} tool calls]",
                content.len()
            )
        }
    }
}

fn localize_stop_reason(reason: &str, lang: Lang) -> String {
    match lang {
        Lang::ZhCn => match reason {
            "end_turn" => "正常结束",
            "cancelled" => "已取消",
            "max_tokens" => "达到最大长度",
            "stop_sequence" => "遇到停止序列",
            "error" => "错误",
            "timeout" => "超时",
            other => other,
        },
        Lang::ZhTw => match reason {
            "end_turn" => "正常結束",
            "cancelled" => "已取消",
            "max_tokens" => "達到最大長度",
            "stop_sequence" => "遇到停止序列",
            "error" => "錯誤",
            "timeout" => "逾時",
            other => other,
        },
        Lang::Ja => match reason {
            "end_turn" => "正常終了",
            "cancelled" => "キャンセル",
            "max_tokens" => "最大トークン数到達",
            "stop_sequence" => "停止シーケンス",
            "error" => "エラー",
            "timeout" => "タイムアウト",
            other => other,
        },
        Lang::Ko => match reason {
            "end_turn" => "정상 종료",
            "cancelled" => "취소됨",
            "max_tokens" => "최대 길이 도달",
            "stop_sequence" => "정지 시퀀스",
            "error" => "오류",
            "timeout" => "시간 초과",
            other => other,
        },
        Lang::Es => match reason {
            "end_turn" => "Finalizado",
            "cancelled" => "Cancelado",
            "max_tokens" => "Longitud máxima alcanzada",
            "error" => "Error",
            "timeout" => "Tiempo agotado",
            other => other,
        },
        Lang::De => match reason {
            "end_turn" => "Abgeschlossen",
            "cancelled" => "Abgebrochen",
            "max_tokens" => "Maximale Länge erreicht",
            "error" => "Fehler",
            "timeout" => "Zeitüberschreitung",
            other => other,
        },
        Lang::Fr => match reason {
            "end_turn" => "Terminé",
            "cancelled" => "Annulé",
            "max_tokens" => "Longueur maximale atteinte",
            "error" => "Erreur",
            "timeout" => "Délai dépassé",
            other => other,
        },
        Lang::Pt => match reason {
            "end_turn" => "Concluído",
            "cancelled" => "Cancelado",
            "max_tokens" => "Comprimento máximo atingido",
            "error" => "Erro",
            "timeout" => "Tempo esgotado",
            other => other,
        },
        Lang::Ar => match reason {
            "end_turn" => "اكتمل",
            "cancelled" => "ملغى",
            "max_tokens" => "تم بلوغ الحد الأقصى",
            "error" => "خطأ",
            "timeout" => "انتهت المهلة",
            other => other,
        },
        Lang::En => match reason {
            "end_turn" => "Completed",
            "cancelled" => "Cancelled",
            "max_tokens" => "Max length reached",
            "stop_sequence" => "Stop sequence",
            "error" => "Error",
            "timeout" => "Timeout",
            other => other,
        },
    }
    .to_string()
}

/// Title-side match for `delegate_to_agent`. Title is free-form text the
/// host agent composes; some hosts copy the bare MCP method, some prefix
/// it with `mcp__<server>__`, some rephrase it. Match by substring so any
/// of those forms get the delegation-announcement path. The completion-
/// side callsite already pairs this with a raw_input shape check, so a
/// rare false-positive here just sends one announce message that gets
/// overwritten by the completion's actual outcome.
fn is_delegation_title(title: &str) -> bool {
    let normalized = title.to_lowercase().replace([' ', '-'], "_");
    normalized.contains("delegate_to_agent")
}

/// Pull `agent_type` out of the raw_input JSON (e.g. `{"agent_type":"codex",
/// "task":"..."}`). Returns the canonical string the agent supplied so the
/// announce message matches what the user wrote, not a re-mapped label.
fn extract_agent_type(raw_input: &str) -> Option<String> {
    let parsed: serde_json::Value = serde_json::from_str(raw_input).ok()?;
    parsed
        .get("agent_type")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
}

/// The `assistant_id` a `delegate_to_agent` raw_input names, by the same
/// parser the listener dispatches with.
fn extract_assistant_id(raw_input: &str) -> Option<i32> {
    let parsed: serde_json::Value = serde_json::from_str(raw_input).ok()?;
    match crate::acp::delegation::types::delegation_target_from_args(&parsed) {
        Ok(crate::acp::delegation::types::DelegationTarget::Assistant(id)) => Some(id),
        _ => None,
    }
}

/// Whether a raw_input looks like `delegate_to_agent` arguments: an agent
/// slug, or a task for an assistant.
fn names_delegation_target(raw_input: &str) -> bool {
    extract_agent_type(raw_input).is_some()
        || (extract_assistant_id(raw_input).is_some()
            && serde_json::from_str::<serde_json::Value>(raw_input)
                .ok()
                .is_some_and(|v| v.get("task").is_some()))
}

/// Who a delegation went to, for the relay's lines: the assistant's name when
/// the report or event carried it, `assistant #<id>` when only the arguments
/// named one, otherwise the agent slug the caller supplied.
fn delegation_target_label(raw_input: Option<&str>, assistant_name: Option<&str>) -> Option<String> {
    if let Some(name) = assistant_name.map(str::trim).filter(|n| !n.is_empty()) {
        return Some(name.to_string());
    }
    let raw_input = raw_input?;
    if let Some(id) = extract_assistant_id(raw_input) {
        return Some(format!("assistant #{id}"));
    }
    extract_agent_type(raw_input)
}

/// Ack line for a `delegate_to_agent` call: under async delegation the tool
/// output is just a task id, so the channel shows that the sub-agent started
/// and is running in the background. The result lands later via
/// [`format_delegation_result`] on `DelegationCompleted`.
fn format_delegation_ack(agent: &str) -> String {
    format!("🚀 Delegated to {agent}; running in background")
}

/// A `delegate_to_agent` tool output parsed into the fields the chat relay
/// needs to classify it (running ack vs terminal) and render the terminal line.
struct DelegationReportView {
    status: Option<String>,
    error_code: Option<String>,
    message: Option<String>,
    text: Option<String>,
    /// The assistant the task ran as, when it ran as one.
    assistant_name: Option<String>,
}

impl DelegationReportView {
    fn is_terminal(&self) -> bool {
        matches!(
            self.status.as_deref(),
            Some("completed") | Some("failed") | Some("canceled")
        )
    }
}

/// Parse a `delegate_to_agent` tool output into a [`DelegationReportView`],
/// unwrapping the MCP `CallToolResult` envelope's `structuredContent` and
/// tolerating host wrappers — notably Codex, which serializes MCP output as
/// `"Wall time: N seconds\nOutput:\n<json>"` (sometimes with a trailing cursor
/// char). Mirrors the frontend's lenient extraction so terminal detection works
/// across hosts. Returns `None` when no JSON object can be recovered.
fn parse_delegation_report(raw_output: Option<&str>) -> Option<DelegationReportView> {
    let value = parse_json_lenient(raw_output?)?;
    let report = value.get("structuredContent").unwrap_or(&value);
    Some(DelegationReportView {
        status: report
            .get("status")
            .and_then(|v| v.as_str())
            .map(str::to_string),
        error_code: report
            .get("error_code")
            .and_then(|v| v.as_str())
            .map(str::to_string),
        message: report
            .get("message")
            .and_then(|v| v.as_str())
            .map(str::to_string),
        text: report
            .get("text")
            .and_then(|v| v.as_str())
            .map(str::to_string),
        assistant_name: report
            .get("assistant_name")
            .and_then(|v| v.as_str())
            .map(str::to_string),
    })
}

/// Parse JSON tolerant of a textual prefix/suffix around the object (Codex
/// wrapping): try a direct parse, then scan back from the last `}` to the first
/// `{` until a balanced span parses. Bounded by the count of `}` characters.
fn parse_json_lenient(s: &str) -> Option<serde_json::Value> {
    if let Ok(v) = serde_json::from_str::<serde_json::Value>(s.trim()) {
        return Some(v);
    }
    let start = s.find('{')?;
    let mut end = s.rfind('}')?;
    while end > start {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&s[start..=end]) {
            return Some(v);
        }
        match s[start..end].rfind('}') {
            Some(rel) => end = start + rel,
            None => break,
        }
    }
    None
}

/// Render a TERMINAL delegation tool output (a fast-complete result, or a setup
/// failure: delegation disabled / depth rejected / spawn failed). Used when the
/// terminal line surfaces via the tool output rather than `DelegationCompleted`
/// (setup failures and synthetic-id fast-completes emit no `DelegationCompleted`).
fn format_delegation_terminal(agent: &str, view: &DelegationReportView) -> String {
    if view.status.as_deref() == Some("completed") {
        let body = view
            .text
            .as_deref()
            .or(view.message.as_deref())
            .unwrap_or("")
            .trim();
        return if body.is_empty() {
            format!("✅ {agent} done")
        } else {
            format!("✅ {agent}: {}", truncate_str(body, 200))
        };
    }
    match view
        .message
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        Some(message) => format!("❌ {agent} failed: {}", truncate_str(message, 200)),
        None => format!(
            "❌ {agent} failed ({})",
            view.error_code.as_deref().unwrap_or("error")
        ),
    }
}

/// Result line for a finished delegation, from the `DelegationCompleted`
/// summary: a compact ✅/❌ with the bounded preview the broker attached.
fn format_delegation_result(agent: &str, result: &DelegationResultSummary) -> String {
    match result {
        DelegationResultSummary::Ok { text_preview, .. } => {
            match text_preview
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
            {
                Some(preview) => format!("✅ {agent}: {}", truncate_str(preview, 200)),
                None => format!("✅ {agent} done"),
            }
        }
        DelegationResultSummary::Err { error_code } => {
            format!("❌ {agent} failed ({error_code})")
        }
    }
}

#[cfg(test)]
mod delegation_relay_tests {
    use super::*;

    #[test]
    fn is_delegation_title_matches_variants() {
        assert!(is_delegation_title("delegate_to_agent"));
        assert!(is_delegation_title("Delegate To Agent"));
        assert!(is_delegation_title("delegate-to-agent"));
        assert!(is_delegation_title(
            "mcp__codeg-mcp__delegate_to_agent"
        ));
        assert!(is_delegation_title("Run mcp__codeg__delegate_to_agent"));
        assert!(!is_delegation_title("agent"));
        assert!(!is_delegation_title("write"));
    }

    #[test]
    fn extract_agent_type_pulls_canonical_string() {
        assert_eq!(
            extract_agent_type(r#"{"agent_type":"codex","task":"x"}"#),
            Some("codex".into())
        );
        assert_eq!(extract_agent_type(r#"{"task":"x"}"#), None);
        assert_eq!(extract_agent_type("not json"), None);
    }

    #[test]
    fn an_assistant_delegation_is_labeled_by_the_assistant() {
        // The report's name wins; the arguments alone give `assistant #<id>`.
        assert_eq!(
            delegation_target_label(Some(r#"{"assistant_id":3,"task":"x"}"#), Some("Reviewer")),
            Some("Reviewer".into())
        );
        assert_eq!(
            delegation_target_label(
                Some(r#"{"assistant_id":"3","agent_type":"codex","task":"x"}"#),
                None
            ),
            Some("assistant #3".into())
        );
        assert_eq!(
            delegation_target_label(Some(r#"{"agent_type":"codex","task":"x"}"#), None),
            Some("codex".into())
        );
        assert_eq!(delegation_target_label(None, Some("  ")), None);
        assert!(names_delegation_target(r#"{"assistant_id":3,"task":"x"}"#));
        assert!(!names_delegation_target(r#"{"assistant_id":3}"#));
        let report = parse_delegation_report(Some(
            r#"{"structuredContent":{"status":"running","assistant_name":"Reviewer"}}"#,
        ))
        .unwrap();
        assert_eq!(report.assistant_name.as_deref(), Some("Reviewer"));
    }

    #[test]
    fn format_delegation_ack_announces_background() {
        assert_eq!(
            format_delegation_ack("codex"),
            "🚀 Delegated to codex; running in background"
        );
    }

    #[test]
    fn parse_delegation_report_classifies_running_vs_terminal() {
        // Running ack (envelope) → not terminal.
        let running = parse_delegation_report(Some(
            r#"{"structuredContent":{"status":"running","child_conversation_id":7}}"#,
        ))
        .unwrap();
        assert!(!running.is_terminal());
        // Fast-complete (envelope) → terminal.
        let done = parse_delegation_report(Some(
            r#"{"structuredContent":{"status":"completed","child_conversation_id":7,"text":"ok"}}"#,
        ))
        .unwrap();
        assert!(done.is_terminal());
        // Setup failure (top-level report) → terminal.
        let failed = parse_delegation_report(Some(
            r#"{"status":"failed","error_code":"spawn_failed","message":"spawn failed: x"}"#,
        ))
        .unwrap();
        assert!(failed.is_terminal());
        // Unparseable / absent → None (treated as a running ack by the caller).
        assert!(parse_delegation_report(Some("plain text")).is_none());
        assert!(parse_delegation_report(None).is_none());
    }

    #[test]
    fn parse_delegation_report_unwraps_codex_text_wrapping() {
        // Codex serializes MCP output as "Wall time: N seconds\nOutput:\n<json>"
        // (with a possible trailing cursor char). Terminal detection must see
        // through the textual wrapper.
        for status in ["completed", "failed", "canceled"] {
            let wrapped = format!(
                "Wall time: 2 seconds\nOutput:\n{{\"content\":[{{\"type\":\"text\",\"text\":\"x\"}}],\"isError\":false,\"structuredContent\":{{\"status\":\"{status}\",\"child_conversation_id\":9}}}}_"
            );
            let view = parse_delegation_report(Some(&wrapped))
                .unwrap_or_else(|| panic!("should parse wrapped {status}"));
            assert!(view.is_terminal(), "{status} should be terminal");
        }
    }

    #[test]
    fn format_delegation_setup_terminal_renders_failure_line() {
        // A setup failure (no child, no DelegationCompleted) must surface a
        // failure line rather than being dropped.
        let view = parse_delegation_report(Some(
            r#"{"status":"canceled","error_code":"canceled","message":"delegation disabled"}"#,
        ))
        .unwrap();
        assert_eq!(
            format_delegation_terminal("codex", &view),
            "❌ codex failed: delegation disabled"
        );
        // Falls back to the code when there's no message.
        let view2 =
            parse_delegation_report(Some(r#"{"status":"failed","error_code":"depth_limit"}"#))
                .unwrap();
        assert_eq!(
            format_delegation_terminal("gemini", &view2),
            "❌ gemini failed (depth_limit)"
        );
    }

    #[test]
    fn format_delegation_result_ok_with_preview() {
        let r = DelegationResultSummary::Ok {
            duration_ms: 5,
            text_preview: Some("  hello world  ".into()),
        };
        assert_eq!(
            format_delegation_result("codex", &r),
            "✅ codex: hello world"
        );
    }

    #[test]
    fn format_delegation_result_ok_no_preview_marks_done() {
        let r = DelegationResultSummary::Ok {
            duration_ms: 5,
            text_preview: None,
        };
        assert_eq!(format_delegation_result("gemini", &r), "✅ gemini done");
    }

    #[test]
    fn format_delegation_result_err_with_code() {
        let r = DelegationResultSummary::Err {
            error_code: "timeout".into(),
        };
        assert_eq!(
            format_delegation_result("gemini", &r),
            "❌ gemini failed (timeout)"
        );
    }

    #[test]
    fn format_delegation_result_truncates_long_preview() {
        let long = "x".repeat(400);
        let r = DelegationResultSummary::Ok {
            duration_ms: 5,
            text_preview: Some(long),
        };
        let body = format_delegation_result("codex", &r);
        // 200-char cap + "..."
        assert!(body.len() < 300);
        assert!(body.starts_with("✅ codex: "));
        assert!(body.ends_with("..."));
    }
}

/// End-to-end dedup coverage through the real `handle_acp_envelope`, driving a
/// recording channel backend so the exact channel messages are observable. The
/// terminal delegation line must render EXACTLY ONCE across the terminal
/// `ToolCallUpdate` and `DelegationCompleted` arms — including the synthetic-id
/// fast-complete (no `DelegationCompleted`), the setup failure (no child), the
/// duplicate-after-`raw_input`-re-emit ordering, and a stale running-ack after
/// the result. The `delegation_rendered` marker (not the re-populatable input
/// map) is the dedup signal.
#[cfg(test)]
mod async_relay_dedup_tests {
    use super::*;
    use crate::acp::manager::ConnectionManager;
    use crate::chat_channel::error::ChatChannelError;
    use crate::chat_channel::manager::ChatChannelManager;
    use crate::chat_channel::session_bridge::{ActiveSession, SessionBridge};
    use crate::chat_channel::traits::ChatChannelBackend;
    use crate::chat_channel::types::{
        ChannelConnectionStatus, ChannelType, IncomingCommand, RichMessage, SentMessageId,
    };
    use crate::db::test_helpers;
    use crate::models::agent::AgentType;
    use async_trait::async_trait;
    use std::collections::{HashMap, HashSet};
    use std::sync::Arc;
    use std::time::Instant;
    use tokio::sync::{mpsc, Mutex};

    /// Channel backend that records every message body sent to it, so tests can
    /// assert the EXACT number/content of channel lines (token consumption alone
    /// can't catch a duplicate that re-creates the token).
    #[derive(Clone, Default)]
    struct Recorder {
        msgs: Arc<Mutex<Vec<String>>>,
    }
    struct RecordingBackend {
        rec: Recorder,
    }

    #[async_trait]
    impl ChatChannelBackend for RecordingBackend {
        fn channel_type(&self) -> ChannelType {
            ChannelType::Telegram
        }
        async fn start(
            &self,
            _command_tx: mpsc::Sender<IncomingCommand>,
        ) -> Result<(), ChatChannelError> {
            Ok(())
        }
        async fn stop(&self) -> Result<(), ChatChannelError> {
            Ok(())
        }
        async fn status(&self) -> ChannelConnectionStatus {
            ChannelConnectionStatus::Connected
        }
        async fn send_message(&self, text: &str) -> Result<SentMessageId, ChatChannelError> {
            self.rec.msgs.lock().await.push(text.to_string());
            Ok(SentMessageId("1".into()))
        }
        async fn send_rich_message(
            &self,
            message: &RichMessage,
        ) -> Result<SentMessageId, ChatChannelError> {
            self.rec.msgs.lock().await.push(message.body.clone());
            Ok(SentMessageId("1".into()))
        }
        async fn test_connection(&self) -> Result<(), ChatChannelError> {
            Ok(())
        }
    }

    /// Build a bridge seeded with one delegate session + a manager wired to a
    /// recording backend on channel 7. Returns the message recorder.
    async fn harness() -> (Arc<Mutex<SessionBridge>>, ChatChannelManager, Recorder) {
        let bridge = Arc::new(Mutex::new(SessionBridge::new()));
        let mut inputs = HashMap::new();
        inputs.insert(
            "tc-1".to_string(),
            r#"{"agent_type":"codex","task":"x"}"#.to_string(),
        );
        bridge.lock().await.register(
            "conn".into(),
            ActiveSession {
                channel_id: 7,
                sender_id: "u".into(),
                target: crate::chat_channel::types::ChannelMessageTarget::channel(7),
                conversation_id: 1,
                connection_id: "conn".into(),
                agent_type: AgentType::ClaudeCode,
                content_buffer: String::new(),
                tool_calls: Vec::new(),
                tool_call_inputs: inputs,
                delegation_rendered: HashSet::new(),
                last_flushed: Instant::now(),
                pending_prompt: None,
                permission_pending: None,
            },
        );
        let chat = ChatChannelManager::new();
        let rec = Recorder::default();
        chat.add_channel(
            7,
            "test".into(),
            ChannelType::Telegram,
            Box::new(RecordingBackend { rec: rec.clone() }),
        )
        .await
        .unwrap();
        (bridge, chat, rec)
    }

    /// A `ToolCallUpdate(completed)` for the delegate tool, optionally carrying
    /// `raw_input` (to exercise the input-re-population path).
    fn completed_update(raw_output: &str, with_input: bool) -> EventEnvelope {
        EventEnvelope {
            seq: 1,
            connection_id: "conn".into(),
            payload: AcpEvent::ToolCallUpdate {
                tool_call_id: "tc-1".into(),
                title: Some("delegate_to_agent".into()),
                status: Some("completed".into()),
                content: None,
                raw_input: with_input.then(|| r#"{"agent_type":"codex","task":"x"}"#.to_string()),
                raw_output: Some(raw_output.into()),
                raw_output_append: None,
                locations: None,
                meta: None,
                images: None,
            },
        }
    }

    fn delegation_completed_ok() -> EventEnvelope {
        EventEnvelope {
            seq: 1,
            connection_id: "conn".into(),
            payload: AcpEvent::DelegationCompleted {
                parent_connection_id: "conn".into(),
                parent_tool_use_id: "tc-1".into(),
                child_connection_id: "child".into(),
                child_conversation_id: 5,
                agent_type: AgentType::Codex,
                result: DelegationResultSummary::Ok {
                    duration_ms: 3,
                    text_preview: Some("done".into()),
                },
                assistant_id: None,
                assistant_name: None,
            },
        }
    }

    async fn sent(rec: &Recorder) -> Vec<String> {
        rec.msgs.lock().await.clone()
    }

    const ACK: &str =
        r#"{"structuredContent":{"task_id":"x","status":"running","child_conversation_id":5}}"#;
    const FAST_COMPLETE: &str = r#"{"content":[{"type":"text","text":"done"}],"isError":false,"structuredContent":{"task_id":"x","status":"completed","child_conversation_id":5,"text":"done"}}"#;

    /// Synthetic-id fast-complete: terminal tool output, NO DelegationCompleted.
    /// Exactly one ✅ result line, from the terminal ToolCallUpdate.
    #[tokio::test]
    async fn synthetic_fast_complete_renders_one_result() {
        let (bridge, chat, rec) = harness().await;
        let conn = ConnectionManager::new();
        let db = test_helpers::fresh_in_memory_db().await;
        handle_acp_envelope(
            &completed_update(FAST_COMPLETE, true),
            &bridge,
            &chat,
            &conn,
            &db.conn,
            &EventEmitter::Noop,
        )
        .await;
        let msgs = sent(&rec).await;
        assert_eq!(msgs.len(), 1, "exactly one line, got {msgs:?}");
        assert!(msgs[0].starts_with("✅ codex"), "got {:?}", msgs[0]);
    }

    /// Non-synthetic fast-complete in the `DelegationCompleted → ToolCallUpdate
    /// (WITH raw_input)` order: the completion renders, the later update
    /// re-populates the input map but must NOT produce a second result line.
    #[tokio::test]
    async fn dedup_survives_raw_input_repopulation() {
        let (bridge, chat, rec) = harness().await;
        let conn = ConnectionManager::new();
        let db = test_helpers::fresh_in_memory_db().await;
        handle_acp_envelope(&delegation_completed_ok(), &bridge, &chat, &conn, &db.conn, &EventEmitter::Noop).await;
        // The later terminal update carries raw_input (re-creating the old
        // input-map token) AND terminal output.
        handle_acp_envelope(
            &completed_update(FAST_COMPLETE, true),
            &bridge,
            &chat,
            &conn,
            &db.conn,
            &EventEmitter::Noop,
        )
        .await;
        let msgs = sent(&rec).await;
        assert_eq!(
            msgs.len(),
            1,
            "must render exactly one result line, got {msgs:?}"
        );
        assert!(msgs[0].starts_with("✅ codex"), "got {:?}", msgs[0]);
    }

    /// Slow async: running ack first, then DelegationCompleted. Exactly two
    /// lines — the ack and the result.
    #[tokio::test]
    async fn slow_async_emits_ack_then_result() {
        let (bridge, chat, rec) = harness().await;
        let conn = ConnectionManager::new();
        let db = test_helpers::fresh_in_memory_db().await;
        handle_acp_envelope(
            &completed_update(ACK, false),
            &bridge,
            &chat,
            &conn,
            &db.conn,
            &EventEmitter::Noop,
        )
        .await;
        handle_acp_envelope(&delegation_completed_ok(), &bridge, &chat, &conn, &db.conn, &EventEmitter::Noop).await;
        let msgs = sent(&rec).await;
        assert_eq!(msgs.len(), 2, "ack + result, got {msgs:?}");
        assert!(msgs[0].contains("running in background"));
        assert!(msgs[1].starts_with("✅ codex"));
    }

    /// A late running-ack `ToolCallUpdate` (with raw_input) arriving AFTER the
    /// result must NOT emit a stale "running in background" line.
    #[tokio::test]
    async fn stale_ack_after_result_is_suppressed() {
        let (bridge, chat, rec) = harness().await;
        let conn = ConnectionManager::new();
        let db = test_helpers::fresh_in_memory_db().await;
        handle_acp_envelope(&delegation_completed_ok(), &bridge, &chat, &conn, &db.conn, &EventEmitter::Noop).await;
        // Host re-emits the running ack after completion, with raw_input.
        handle_acp_envelope(
            &completed_update(ACK, true),
            &bridge,
            &chat,
            &conn,
            &db.conn,
            &EventEmitter::Noop,
        )
        .await;
        let msgs = sent(&rec).await;
        assert_eq!(msgs.len(), 1, "no stale ack after the result, got {msgs:?}");
        assert!(msgs[0].starts_with("✅ codex"));
    }

    /// Setup failure (terminal report, NO child, NO DelegationCompleted): one
    /// ❌ failure line from the terminal ToolCallUpdate.
    #[tokio::test]
    async fn setup_failure_renders_one_failure_line() {
        let (bridge, chat, rec) = harness().await;
        let conn = ConnectionManager::new();
        let db = test_helpers::fresh_in_memory_db().await;
        let out = r#"{"structuredContent":{"status":"failed","error_code":"spawn_failed","message":"spawn failed: x"}}"#;
        handle_acp_envelope(
            &completed_update(out, true),
            &bridge,
            &chat,
            &conn,
            &db.conn,
            &EventEmitter::Noop,
        )
        .await;
        let msgs = sent(&rec).await;
        assert_eq!(msgs.len(), 1, "one failure line, got {msgs:?}");
        assert!(msgs[0].starts_with("❌ codex failed"), "got {:?}", msgs[0]);
    }

    /// Chat kickoff DEFERS (does not drop) when a turn is already in flight on a
    /// shared connection: SessionStarted bounces with `TurnInProgress` → the
    /// pending prompt is RESTORED and an info line is posted; `TurnComplete`
    /// then retries it successfully. Regression for the silent kickoff-drop.
    #[tokio::test]
    async fn kickoff_defers_on_turn_in_progress_then_retries_on_turn_complete() {
        use crate::acp::connection::ConnectionCommand;
        use crate::web::event_bridge::EventEmitter;

        let (bridge, chat, rec) = harness().await;
        let db = test_helpers::fresh_in_memory_db().await;

        // A LIVE connection (receiver kept) so `send_prompt` reaches the gate —
        // a dropped receiver would fail `reserve()` with ProcessExited before it.
        let conn = ConnectionManager::new();
        let mut cmd_rx = conn
            .insert_test_connection_live("conn", AgentType::ClaudeCode, None, EventEmitter::Noop)
            .await;
        // Seed the kickoff prompt + simulate another client's turn in flight.
        bridge.lock().await.get_mut("conn").unwrap().pending_prompt = Some("do the task".into());
        conn.get_state("conn")
            .await
            .unwrap()
            .write()
            .await
            .turn_in_flight = true;

        // SessionStarted → kickoff bounces (turn in flight) and is DEFERRED.
        let started = EventEnvelope {
            seq: 1,
            connection_id: "conn".into(),
            payload: AcpEvent::SessionStarted {
                session_id: "S1".into(),
            },
        };
        handle_acp_envelope(&started, &bridge, &chat, &conn, &db.conn, &EventEmitter::Noop).await;

        assert_eq!(
            bridge
                .lock()
                .await
                .get("conn")
                .unwrap()
                .pending_prompt
                .as_deref(),
            Some("do the task"),
            "a deferred kickoff must be RESTORED, not dropped"
        );
        assert!(
            cmd_rx.try_recv().is_err(),
            "no Prompt should be enqueued while the turn is in flight"
        );
        assert!(
            sent(&rec)
                .await
                .iter()
                .any(|m| m.contains("start automatically")),
            "the user should be told the task is deferred"
        );

        // Turn ends → kickoff retried and now succeeds.
        conn.get_state("conn")
            .await
            .unwrap()
            .write()
            .await
            .turn_in_flight = false;
        let complete = EventEnvelope {
            seq: 2,
            connection_id: "conn".into(),
            payload: AcpEvent::TurnComplete {
                session_id: "S1".into(),
                stop_reason: "end_turn".into(),
                agent_type: "claude".into(),
            },
        };
        handle_acp_envelope(&complete, &bridge, &chat, &conn, &db.conn, &EventEmitter::Noop).await;

        assert!(
            bridge
                .lock()
                .await
                .get("conn")
                .unwrap()
                .pending_prompt
                .is_none(),
            "a retried kickoff must clear the pending prompt"
        );
        // The retried prompt landed on the connection's command channel.
        let mut got_prompt = None;
        while let Ok(cmd) = cmd_rx.try_recv() {
            if let ConnectionCommand::Prompt { blocks, .. } = cmd {
                got_prompt = Some(blocks);
            }
        }
        let blocks = got_prompt.expect("a Prompt command must be enqueued by the retry");
        assert!(
            matches!(blocks.as_slice(), [PromptInputBlock::Text { text }] if text == "do the task"),
            "the retried prompt must carry the deferred text, got {blocks:?}"
        );
    }
}

#[cfg(test)]
mod error_terminal_gate_tests {
    //! Regression coverage for the F2-aligned `AcpEvent::Error` gating —
    //! non-terminal Errors must leave the chat-channel session and the
    //! conversation row untouched, so a recoverable failure (turn refusal,
    //! `session/load` fallback, idle SetMode failure) doesn't kill the
    //! remote user's bridge session. Terminal Errors continue to tear the
    //! session down as before. (P2 follow-up to the v0.14.3 sub-agent
    //! delegation post-mortem.)
    use super::*;
    use crate::acp::manager::ConnectionManager;
    use crate::acp::types::{AcpEvent, EventEnvelope};
    use crate::chat_channel::manager::ChatChannelManager;
    use crate::chat_channel::session_bridge::{ActiveSession, SessionBridge};
    use crate::db::entities::conversation::ConversationStatus;
    use crate::db::test_helpers;
    use crate::models::agent::AgentType;
    use std::sync::Arc;
    use std::time::Instant;
    use tokio::sync::Mutex;

    async fn read_row_status(db: &crate::db::AppDatabase, id: i32) -> ConversationStatus {
        use crate::db::entities::conversation;
        use sea_orm::EntityTrait;
        conversation::Entity::find_by_id(id)
            .one(&db.conn)
            .await
            .unwrap()
            .expect("conversation row exists")
            .status
    }

    async fn seed_session(
        db: &crate::db::AppDatabase,
        connection_id: &str,
    ) -> (Arc<Mutex<SessionBridge>>, i32) {
        let folder_id = test_helpers::seed_folder(db, "/tmp/chat-error-gate").await;
        let conv_id = test_helpers::seed_conversation(db, folder_id, AgentType::ClaudeCode).await;
        let bridge = Arc::new(Mutex::new(SessionBridge::new()));
        bridge.lock().await.register(
            connection_id.to_string(),
            ActiveSession {
                channel_id: 7,
                sender_id: "u1".into(),
                target: crate::chat_channel::types::ChannelMessageTarget::channel(7),
                conversation_id: conv_id,
                connection_id: connection_id.to_string(),
                agent_type: AgentType::ClaudeCode,
                content_buffer: String::new(),
                tool_calls: Vec::new(),
                tool_call_inputs: std::collections::HashMap::new(),
                delegation_rendered: std::collections::HashSet::new(),
                last_flushed: Instant::now(),
                pending_prompt: None,
                permission_pending: None,
            },
        );
        (bridge, conv_id)
    }

    #[tokio::test]
    async fn session_started_preserves_history_and_broadcasts_it_without_a_manager_entry() {
        // Two things at once, because they are the same bug seen from two
        // angles (codeg#500).
        //
        // 1. This subscriber writes onto an ALREADY-bound `conversation_id`
        //    (the bridge registers it up front), so a re-minted session would
        //    silently overwrite the id the row's history hangs off. The guarded
        //    bind must split that history onto its own row instead.
        //
        // 2. Creating that row is only half the fix: the sidebar inserts a
        //    conversation it has never seen ONLY on a `conversation://changed`
        //    upsert. A preserved row that is never broadcast still looks, to
        //    the user, exactly like the conversation vanishing.
        //
        // The manager entry is deliberately ABSENT here. That is a REACHABLE
        // state, not a contrivance: this subscriber consumes `SessionStarted`
        // asynchronously off the broadcast bus, while connection cleanup
        // removes the entry right after queuing its terminal events. So an
        // emitter resolved per-`connection_id` would come back empty exactly
        // here and drop the broadcast — which is why the emitter is injected
        // for the subscriber's whole lifetime instead. Reverting to a lookup
        // must fail this test.
        use crate::acp::internal_bus::InternalEventBus;
        use crate::db::entities::conversation;
        use crate::web::event_bridge::{WebEventBroadcaster, CONVERSATION_CHANGED_EVENT};
        use sea_orm::{ColumnTrait, EntityTrait, QueryFilter};

        let db = test_helpers::fresh_in_memory_db().await;
        let (bridge, conv_id) = seed_session(&db, "c-reminted").await;
        conversation_service::bind_external_id(&db.conn, conv_id, "S1", &[])
            .await
            .expect("seed the original session");

        let broadcaster = Arc::new(WebEventBroadcaster::new());
        let mut rx = broadcaster.subscribe();
        let emitter = EventEmitter::web_only(
            broadcaster,
            Arc::new(InternalEventBus::new(Default::default())),
        );

        let chat_mgr = ChatChannelManager::new();
        // Empty on purpose — see above.
        let conn_mgr = ConnectionManager::new();
        let envelope = EventEnvelope {
            seq: 1,
            connection_id: "c-reminted".to_string(),
            payload: AcpEvent::SessionStarted {
                session_id: "S2".to_string(),
            },
        };
        handle_acp_envelope(&envelope, &bridge, &chat_mgr, &conn_mgr, &db.conn, &emitter).await;

        // The bound row advanced; the old session kept a row of its own.
        let rows = conversation::Entity::find()
            .filter(conversation::Column::DeletedAt.is_null())
            .all(&db.conn)
            .await
            .expect("list rows");
        assert_eq!(rows.len(), 2, "the old session must keep a row, got {rows:?}");
        let preserved = rows
            .iter()
            .find(|r| r.external_id.as_deref() == Some("S1"))
            .expect("S1 must still be indexed");
        assert_ne!(preserved.id, conv_id);
        assert_eq!(
            rows.iter()
                .find(|r| r.id == conv_id)
                .and_then(|r| r.external_id.as_deref()),
            Some("S2")
        );

        // ...and the sidebar was actually told about it.
        let mut saw_preserved = false;
        while let Ok(event) = rx.try_recv() {
            let payload = serde_json::to_string(&event).unwrap_or_default();
            if payload.contains(CONVERSATION_CHANGED_EVENT)
                && payload.contains(&format!("\"id\":{}", preserved.id))
            {
                saw_preserved = true;
            }
        }
        assert!(
            saw_preserved,
            "the preserved conversation must be broadcast — a row the sidebar \
             never hears about is indistinguishable from the bug being fixed"
        );
    }

    #[tokio::test]
    async fn session_started_tears_down_the_route_when_the_session_belongs_elsewhere() {
        // A `Conflict` means the session is owned by a DIFFERENT conversation
        // row, permanently — no retry changes that. Anything dispatched through
        // this route lands in the HOLDER row's transcript while every event
        // names this session's row.
        //
        // The teardown is asserted as hard as the not-sending, because two
        // weaker remedies both fail. Leaving `pending_prompt` in place: the
        // `TurnComplete` arm re-sends a deferred kickoff with no ownership
        // re-check. Clearing the prompt but keeping the bridge entry: the
        // remote user's next message finds the route and dispatches through it
        // anyway. The second half of this test drives the first of those.
        //
        // The bail-out is narrowed to `Conflict` on purpose — every other bind
        // error is dominated by transient SQLite contention, where tearing the
        // route down would kill a session that was about to work.
        use crate::acp::connection::ConnectionCommand;

        let db = test_helpers::fresh_in_memory_db().await;
        let (bridge, conv_id) = seed_session(&db, "conn-owned-elsewhere").await;

        // Another row already owns the session this connection is about to
        // announce. Same agent_type as the seeded session — that is what the
        // unique index, and the guard, key on.
        let other_folder = test_helpers::seed_folder(&db, "/tmp/chat-conflict-holder").await;
        let holder = conversation_service::create(
            &db.conn,
            other_folder,
            AgentType::ClaudeCode,
            Some("owns S_SHARED".into()),
            None,
        )
        .await
        .expect("holder");
        conversation_service::bind_external_id(&db.conn, holder.id, "S_SHARED", &[])
            .await
            .expect("seed holder");

        let conn_mgr = ConnectionManager::new();
        // LIVE (receiver kept) so a send would actually reach the gate — a
        // dropped receiver would fail earlier for the wrong reason and the test
        // would pass without proving anything.
        let mut cmd_rx = conn_mgr
            .insert_test_connection_live(
                "conn-owned-elsewhere",
                AgentType::ClaudeCode,
                None,
                EventEmitter::Noop,
            )
            .await;
        // The connection's LIVE session is the one that is about to fail to
        // bind — i.e. this envelope is current, not a straggler. The teardown is
        // gated on exactly this.
        conn_mgr
            .get_state("conn-owned-elsewhere")
            .await
            .unwrap()
            .write()
            .await
            .external_id = Some("S_SHARED".into());
        bridge
            .lock()
            .await
            .get_mut("conn-owned-elsewhere")
            .unwrap()
            .pending_prompt = Some("do the task".into());

        let envelope = EventEnvelope {
            seq: 1,
            connection_id: "conn-owned-elsewhere".to_string(),
            payload: AcpEvent::SessionStarted {
                session_id: "S_SHARED".to_string(),
            },
        };
        handle_acp_envelope(
            &envelope,
            &bridge,
            &ChatChannelManager::new(),
            &conn_mgr,
            &db.conn,
            &EventEmitter::Noop,
        )
        .await;

        assert!(
            !matches!(cmd_rx.try_recv(), Ok(ConnectionCommand::Prompt { .. })),
            "a kickoff must not be dispatched into a session this row does not own"
        );
        assert!(
            bridge.lock().await.get("conn-owned-elsewhere").is_none(),
            "the bridge route must be GONE — a surviving entry is what the \
             remote user's next message would dispatch through"
        );
        assert_eq!(
            read_row_status(&db, conv_id).await,
            ConversationStatus::Cancelled,
            "the conversation the route pointed at must settle, not sit InProgress"
        );

        // The follow-up that makes the teardown load-bearing: a TurnComplete
        // for another client's turn on the same connection picks up any
        // deferred kickoff and sends it blind, and flips the row to Completed.
        // With the route gone it must find nothing at all.
        handle_acp_envelope(
            &EventEnvelope {
                seq: 2,
                connection_id: "conn-owned-elsewhere".to_string(),
                payload: AcpEvent::TurnComplete {
                    session_id: "S_SHARED".to_string(),
                    stop_reason: "end_turn".to_string(),
                    agent_type: "claude_code".to_string(),
                },
            },
            &bridge,
            &ChatChannelManager::new(),
            &conn_mgr,
            &db.conn,
            &EventEmitter::Noop,
        )
        .await;
        assert!(
            !matches!(cmd_rx.try_recv(), Ok(ConnectionCommand::Prompt { .. })),
            "TurnComplete must have no abandoned kickoff left to dispatch"
        );
        assert_eq!(
            read_row_status(&db, conv_id).await,
            ConversationStatus::Cancelled,
            "a foreign TurnComplete must not mutate a row whose route is gone"
        );

        // Neither row moved.
        assert_eq!(
            conversation_service::get_by_id(&db.conn, conv_id)
                .await
                .expect("session row")
                .external_id,
            None
        );
        assert_eq!(
            conversation_service::get_by_id(&db.conn, holder.id)
                .await
                .expect("holder")
                .external_id
                .as_deref(),
            Some("S_SHARED")
        );
    }

    #[tokio::test]
    async fn a_stale_conflicting_session_started_leaves_a_healthy_route_alone() {
        // The counterweight to the teardown above, and the reason it is gated.
        //
        // A `Conflict` proves the session in THIS envelope belongs to another
        // row. It does NOT prove the route is bad. This subscriber and the
        // lifecycle one drain the bus independently, so a fork that advanced
        // the connection S1 → S2 (leaving a sibling row holding S1) can be
        // followed by a backed-up `SessionStarted{S1}` landing here. That binds
        // S1 onto a row that has moved on, hits the sibling, and returns
        // Conflict — while the route is perfectly healthy on S2.
        //
        // Tearing down there would kill a working session to prevent a
        // misfiling that cannot happen, which is a worse outcome than the bug.
        let db = test_helpers::fresh_in_memory_db().await;
        let (bridge, conv_id) = seed_session(&db, "conn-moved-on").await;

        // The sibling left behind by the fork, holding the OLD session.
        let sibling_folder = test_helpers::seed_folder(&db, "/tmp/chat-stale-sibling").await;
        let sibling = conversation_service::create(
            &db.conn,
            sibling_folder,
            AgentType::ClaudeCode,
            Some("preserved S1".into()),
            None,
        )
        .await
        .expect("sibling");
        conversation_service::bind_external_id(&db.conn, sibling.id, "S1", &[])
            .await
            .expect("seed sibling");
        // The route's own row already advanced to S2.
        conversation_service::bind_external_id(&db.conn, conv_id, "S2", &[])
            .await
            .expect("advance to S2");

        let conn_mgr = ConnectionManager::new();
        let _cmd_rx = conn_mgr
            .insert_test_connection_live("conn-moved-on", AgentType::ClaudeCode, None, EventEmitter::Noop)
            .await;
        // The LIVE session is S2 — S1 is a straggler.
        conn_mgr
            .get_state("conn-moved-on")
            .await
            .unwrap()
            .write()
            .await
            .external_id = Some("S2".into());

        handle_acp_envelope(
            &EventEnvelope {
                seq: 1,
                connection_id: "conn-moved-on".to_string(),
                payload: AcpEvent::SessionStarted {
                    session_id: "S1".to_string(),
                },
            },
            &bridge,
            &ChatChannelManager::new(),
            &conn_mgr,
            &db.conn,
            &EventEmitter::Noop,
        )
        .await;

        assert!(
            bridge.lock().await.get("conn-moved-on").is_some(),
            "a stale conflicting event must NOT tear down a healthy route"
        );
        assert_ne!(
            read_row_status(&db, conv_id).await,
            ConversationStatus::Cancelled,
            "a stale conflicting event must not cancel a live conversation"
        );
        assert_eq!(
            conversation_service::get_by_id(&db.conn, conv_id)
                .await
                .expect("route row")
                .external_id
                .as_deref(),
            Some("S2"),
            "the route's row keeps the session it actually moved to"
        );
    }

    #[tokio::test]
    async fn non_terminal_error_keeps_session_and_conversation_intact() {
        let db = test_helpers::fresh_in_memory_db().await;
        let (bridge, conv_id) = seed_session(&db, "c-nonterm").await;
        let chat_mgr = ChatChannelManager::new();
        let conn_mgr = ConnectionManager::new();

        let envelope = EventEnvelope {
            seq: 1,
            connection_id: "c-nonterm".to_string(),
            payload: AcpEvent::Error {
                message: "Failed to set mode: bad id".into(),
                agent_type: "claude_code".into(),
                code: None,
                details: None,
                terminal: false,
            },
        };
        handle_acp_envelope(&envelope, &bridge, &chat_mgr, &conn_mgr, &db.conn, &EventEmitter::Noop).await;

        // Session bridge entry is preserved — the next user message on the
        // same connection can still flow through it.
        assert!(
            bridge.lock().await.get("c-nonterm").is_some(),
            "non-terminal Error must leave the bridge session in place"
        );
        assert_eq!(
            read_row_status(&db, conv_id).await,
            ConversationStatus::InProgress,
            "non-terminal Error must not flip the conversation to Cancelled"
        );
    }

    #[tokio::test]
    async fn terminal_error_tears_down_session_and_writes_cancelled() {
        let db = test_helpers::fresh_in_memory_db().await;
        let (bridge, conv_id) = seed_session(&db, "c-term").await;
        let chat_mgr = ChatChannelManager::new();
        let conn_mgr = ConnectionManager::new();

        let envelope = EventEnvelope {
            seq: 1,
            connection_id: "c-term".to_string(),
            payload: AcpEvent::Error {
                message: "transport closed".into(),
                agent_type: "claude_code".into(),
                code: None,
                details: None,
                terminal: true,
            },
        };
        handle_acp_envelope(&envelope, &bridge, &chat_mgr, &conn_mgr, &db.conn, &EventEmitter::Noop).await;

        assert!(
            bridge.lock().await.get("c-term").is_none(),
            "terminal Error must remove the bridge session so the next message starts fresh"
        );
        assert_eq!(
            read_row_status(&db, conv_id).await,
            ConversationStatus::Cancelled
        );
    }
}

#[cfg(test)]
mod auto_approve_tests {
    //! A sender who turned on auto-approve (`/approve always`) has codeg answer
    //! each permission request for them. The answer is the allow-once option,
    //! found by its kind — never the first option, which an adapter may well
    //! have made the rejection, and never one that leaves a rule behind in the
    //! agent's settings.
    use super::*;
    use crate::acp::connection::ConnectionCommand;
    use crate::chat_channel::session_bridge::ActiveSession;
    use crate::db::service::chat_channel_service;
    use crate::db::test_helpers;
    use crate::models::agent::AgentType;

    fn permission_option(option_id: &str, name: &str, kind: &str) -> PermissionOptionInfo {
        PermissionOptionInfo {
            option_id: option_id.into(),
            name: name.into(),
            kind: kind.into(),
            meta: None,
        }
    }

    /// A sender with auto-approve on and a live session. Returns the receiving
    /// end of the session's commands.
    async fn auto_approving_session(
        db: &crate::db::AppDatabase,
    ) -> (
        Arc<Mutex<SessionBridge>>,
        ConnectionManager,
        tokio::sync::mpsc::Receiver<ConnectionCommand>,
    ) {
        let channel_id = chat_channel_service::create(
            &db.conn,
            "Telegram test".to_string(),
            "telegram".to_string(),
            serde_json::json!({ "chat_id": "-100123" }).to_string(),
            true,
            false,
            None,
        )
        .await
        .expect("seed chat channel")
        .id;
        sender_context_service::update_auto_approve(&db.conn, channel_id, "u1", true)
            .await
            .expect("auto-approve on");
        let folder_id = test_helpers::seed_folder(db, "/tmp/chat-auto-approve").await;
        let conv_id = test_helpers::seed_conversation(db, folder_id, AgentType::ClaudeCode).await;
        let conn_mgr = ConnectionManager::new();
        let rx = conn_mgr
            .insert_test_connection_live(
                "conn-auto",
                AgentType::ClaudeCode,
                None,
                EventEmitter::Noop,
            )
            .await;
        let bridge = Arc::new(Mutex::new(SessionBridge::new()));
        bridge.lock().await.register(
            "conn-auto".to_string(),
            ActiveSession {
                channel_id,
                sender_id: "u1".into(),
                target: ChannelMessageTarget::channel(channel_id),
                conversation_id: conv_id,
                connection_id: "conn-auto".to_string(),
                agent_type: AgentType::ClaudeCode,
                content_buffer: String::new(),
                tool_calls: Vec::new(),
                tool_call_inputs: std::collections::HashMap::new(),
                delegation_rendered: std::collections::HashSet::new(),
                last_flushed: Instant::now(),
                pending_prompt: None,
                permission_pending: None,
            },
        );
        (bridge, conn_mgr, rx)
    }

    async fn request_permission(
        db: &crate::db::AppDatabase,
        bridge: &Arc<Mutex<SessionBridge>>,
        conn_mgr: &ConnectionManager,
        options: Vec<PermissionOptionInfo>,
    ) {
        let envelope = EventEnvelope {
            seq: 1,
            connection_id: "conn-auto".to_string(),
            payload: AcpEvent::PermissionRequest {
                request_id: "req-1".to_string(),
                tool_call: serde_json::json!({ "title": "Bash" }),
                options,
                queued: 0,
            },
        };
        handle_acp_envelope(
            &envelope,
            bridge,
            &ChatChannelManager::new(),
            conn_mgr,
            &db.conn,
            &EventEmitter::Noop,
        )
        .await;
    }

    fn answered_option(rx: &mut tokio::sync::mpsc::Receiver<ConnectionCommand>) -> Option<String> {
        match rx.try_recv() {
            Ok(ConnectionCommand::RespondPermission {
                request_id,
                option_id,
                origin,
            }) => {
                assert_eq!(origin, PermissionAnswerOrigin::ChatChannel);
                assert_eq!(request_id, "req-1");
                Some(option_id)
            }
            Ok(_) => panic!("expected a permission response"),
            Err(_) => None,
        }
    }

    async fn pending_request_id(bridge: &Arc<Mutex<SessionBridge>>) -> Option<String> {
        bridge
            .lock()
            .await
            .get("conn-auto")
            .and_then(|s| s.permission_pending.as_ref())
            .map(|p| p.request_id.clone())
    }

    #[tokio::test]
    async fn auto_approve_allows_once_when_the_rejection_leads() {
        // claude-agent-acp 0.91.0 leads with the rejection for a call the
        // Claude CLI marks `defaultToNo`; picked by position, auto-approve
        // turned down exactly the calls it was there to let through.
        let db = test_helpers::fresh_in_memory_db().await;
        let (bridge, conn_mgr, mut rx) = auto_approving_session(&db).await;

        request_permission(
            &db,
            &bridge,
            &conn_mgr,
            vec![
                permission_option("reject", "No", "reject_once"),
                permission_option("allow-once", "Yes", "allow_once"),
                permission_option(
                    "allow-with-updates",
                    "Yes, and don't ask again",
                    "allow_always",
                ),
            ],
        )
        .await;

        assert_eq!(answered_option(&mut rx).as_deref(), Some("allow-once"));
        assert_eq!(pending_request_id(&bridge).await, None);
    }

    #[tokio::test]
    async fn auto_approve_leaves_a_request_without_an_allow_once_option_to_the_sender() {
        // Auto-approve answers for the sender one call at a time; a standing
        // allow in the agent's own settings is not its to grant. The request
        // goes to the chat like any other, for the sender to answer.
        let db = test_helpers::fresh_in_memory_db().await;
        let (bridge, conn_mgr, mut rx) = auto_approving_session(&db).await;

        request_permission(
            &db,
            &bridge,
            &conn_mgr,
            vec![
                permission_option(
                    "allow-with-updates",
                    "Yes, and don't ask again",
                    "allow_always",
                ),
                permission_option("reject", "No", "reject_once"),
            ],
        )
        .await;

        assert_eq!(answered_option(&mut rx), None);
        assert_eq!(pending_request_id(&bridge).await.as_deref(), Some("req-1"));
    }
}
