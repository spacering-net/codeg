//! The personal agent's codeg-mcp tools, answered in the app.
//!
//! Every call is checked here, not only in the companion: the socket is gated
//! by a per-launch token alone, and `--features` is a string in the agent's
//! MCP config, so any connection's companion could send one of these frames.
//! Only the personal agent's current connection gets an answer. Every tool
//! returns at once — none waits for a turn or a person.
//!
//! A refusal is an answer (`ok: false`), not an error: the model reads why and
//! corrects the call.

use std::sync::Arc;

use serde::Serialize;
use serde_json::{json, Value};

use super::dispatch::{executor_of, DispatchAuth, DispatchRequest, FollowupAuth};
use super::engine::{enum_str, PersonalAgentEngine};
use super::messages::{MessageCall, Unnamed};
use crate::db::entities::folder::FolderKind;
use crate::db::entities::personal_agent_dispatch::DispatchMode;
use crate::db::entities::personal_agent_item::{ItemKind, ItemStatus, WaitsFor};
use crate::db::service::personal_agent_service as svc;
use crate::db::service::personal_agent_service::ItemWrite;
use crate::models::personal_agent::PersonalAgentChange;

/// The answer to one tool call: `text` for hosts that show only text,
/// `data` for those that read the structure.
#[derive(Debug, Clone, Serialize)]
pub struct ToolOutcome {
    pub ok: bool,
    pub text: String,
    #[serde(skip_serializing_if = "Value::is_null")]
    pub data: Value,
}

impl ToolOutcome {
    pub fn ok(text: impl Into<String>, data: Value) -> Self {
        Self {
            ok: true,
            text: text.into(),
            data,
        }
    }

    pub fn refused(text: impl Into<String>) -> Self {
        Self {
            ok: false,
            text: text.into(),
            data: Value::Null,
        }
    }
}

fn int(args: &Value, key: &str) -> Option<i64> {
    args.get(key).and_then(|v| v.as_i64().or_else(|| v.as_str()?.trim().parse().ok()))
}

fn string(args: &Value, key: &str) -> Option<String> {
    args.get(key)
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

/// An input or message reference, written as text (`"#58"`, `"m12"`) or as
/// a bare number.
fn reference(args: &Value, key: &str) -> Option<String> {
    match args.get(key)? {
        Value::Number(n) => Some(n.to_string()),
        Value::String(s) if !s.trim().is_empty() => Some(s.trim().to_string()),
        _ => None,
    }
}

fn as_i32(v: i64) -> Option<i32> {
    i32::try_from(v).ok()
}

/// Answer one tool call from `parent_connection_id`, as the assistant whose
/// current session that connection is. A call from any other connection —
/// a dispatched conversation's, a window's, a retired session's — is
/// refused: nobody's.
pub async fn call(parent_connection_id: &str, tool: &str, args: Value) -> ToolOutcome {
    let Some(host) = super::host::host() else {
        return ToolOutcome::refused("the personal agent is not running in this codeg process");
    };
    let Some(engine) = host.engine_by_connection(parent_connection_id).await else {
        return ToolOutcome::refused(
            "these tools belong to an assistant's current session only",
        );
    };
    answer(&engine, tool, args).await
}

/// Answer a call already known to come from the personal agent.
async fn answer(engine: &Arc<PersonalAgentEngine>, tool: &str, args: Value) -> ToolOutcome {
    let db = &engine.db;
    // Whose records the call reads and writes: the calling assistant's only.
    let bot = engine.bot().await;
    match tool {
        "assistant_list" => {
            let assistants = crate::db::service::assistant_service::list_live_enabled(&db.conn)
                .await
                .unwrap_or_default();
            if assistants.is_empty() {
                return ToolOutcome::ok(
                    "No executor configs are set up. Tell the owner to add one on the assistants \
                     page, under Settings → Team → Executor configs.",
                    json!({ "assistants": [] }),
                );
            }
            let team = engine.account().await.team;
            // Whose each one is: the work assistants bound to it (4.4).
            let me = engine.bot().await;
            let bots = svc::list_bots(&db.conn).await.unwrap_or_default();
            let mut rows: Vec<Value> = Vec::new();
            let mut open_lines = Vec::new();
            let mut closed_lines = Vec::new();
            for a in &assistants {
                let owners: Vec<&crate::db::entities::personal_agent::Model> = bots
                    .iter()
                    .filter(|b| b.executor_assistant_id == Some(a.id))
                    .collect();
                let whose = if owners.iter().any(|b| b.id == me) {
                    " [yours: your dispatches run here when you leave assistant_id out]".to_string()
                } else if owners.is_empty() {
                    String::new()
                } else {
                    format!(
                        " [{}'s: message it to get work done here]",
                        owners
                            .iter()
                            .map(|b| super::messages::display_name(b))
                            .collect::<Vec<_>>()
                            .join(", ")
                    )
                };
                let model = a
                    .label_snapshot
                    .options
                    .iter()
                    .find(|o| o.id == "model")
                    .map(|o| o.value_label.clone());
                let usage = team.usage_of(&a.uid);
                let note = engine.usage_note(&usage).await;
                rows.push(json!({
                    "id": a.id,
                    "name": a.name,
                    "when_to_use": a.description,
                    "agent": a.label_snapshot.agent,
                    "agent_type": a.agent_type,
                    "model": model,
                    "dispatch": usage.dispatch,
                    "modes": usage.modes,
                    "projects": usage.projects,
                    "bound_to": owners.iter().map(|b| b.id).collect::<Vec<_>>(),
                }));
                let what = if a.description.trim().is_empty() {
                    String::new()
                } else {
                    format!(" — {}", a.description.trim())
                };
                let line = format!(
                    "#{} {} ({}){what}{}{whose}",
                    a.id,
                    a.name,
                    a.label_snapshot.agent,
                    note.as_deref()
                        .filter(|_| usage.dispatch)
                        .map(|n| format!(" [{n}]"))
                        .unwrap_or_default()
                );
                if usage.dispatch {
                    open_lines.push(line);
                } else {
                    closed_lines.push(line);
                }
            }
            let mut text = if open_lines.is_empty() {
                "None of the executor configs is open to your dispatches.".to_string()
            } else {
                open_lines.join("\n")
            };
            if !closed_lines.is_empty() {
                text.push_str(&format!(
                    "\n\nNot for your dispatches (the owner keeps these for @ in conversations):\n{}",
                    closed_lines.join("\n")
                ));
            }
            let division = engine.division_text().await;
            if let Some(d) = &division {
                text.push_str(&format!("\n\n{d}"));
            }
            ToolOutcome::ok(
                text,
                json!({ "assistants": rows, "division": team.division }),
            )
        }
        "project_list" => {
            let folders = crate::db::service::folder_service::list_all_folder_details(&db.conn)
                .await
                .unwrap_or_default();
            let rows: Vec<Value> = folders
                .iter()
                .filter(|f| f.kind == FolderKind::Regular && f.parent_id.is_none())
                .map(|f| {
                    json!({
                        "id": f.id,
                        "name": f.alias.clone().unwrap_or_else(|| f.name.clone()),
                        "path": f.path,
                    })
                })
                .collect();
            if rows.is_empty() {
                return ToolOutcome::ok(
                    "No project folders are open in codeg. A chat dispatch needs none.",
                    json!({ "projects": [] }),
                );
            }
            let text = rows
                .iter()
                .map(|r| format!("#{} {} — {}", r["id"], r["name"].as_str().unwrap_or(""), r["path"].as_str().unwrap_or("")))
                .collect::<Vec<_>>()
                .join("\n");
            ToolOutcome::ok(text, json!({ "projects": rows }))
        }
        "dispatch" => {
            if args.get("agent_type").is_some() {
                return ToolOutcome::refused(
                    "dispatch takes a role assistant (`assistant_id`, from assistant_list), never \
                     an agent type",
                );
            }
            let mode = match string(&args, "mode").as_deref() {
                Some("task") => DispatchMode::Task,
                Some("chat") => DispatchMode::Chat,
                Some("session") => DispatchMode::Session,
                _ => return ToolOutcome::refused("`mode` must be task, chat or session"),
            };
            // A work assistant's own executor config when it names none (4.4).
            let assistant_id = match int(&args, "assistant_id").and_then(as_i32) {
                Some(id) => id,
                None => match engine.default_executor().await {
                    Ok(id) => id,
                    Err(e) => return ToolOutcome::refused(e),
                },
            };
            let report = match string(&args, "deliverable").as_deref() {
                None | Some("change") => false,
                Some("report") => true,
                Some(_) => return ToolOutcome::refused("`deliverable` must be change or report"),
            };
            let req = DispatchRequest {
                mode,
                assistant_id,
                title: string(&args, "title").unwrap_or_default(),
                prompt: string(&args, "prompt").unwrap_or_default(),
                project_id: int(&args, "project_id").and_then(as_i32),
                report: report || (mode != DispatchMode::Task && args.get("deliverable").is_some()),
                on_done: string(&args, "on_done"),
            };
            let mut valid = match engine.validate_dispatch(&req).await {
                Ok(v) => v,
                Err(e) => return ToolOutcome::refused(e),
            };
            // Which input it is for: what it inherits (4.11).
            let input = match engine
                .input_for(reference(&args, "for").as_deref(), Unnamed::Refuse)
                .await
            {
                Ok(i) => i,
                Err(e) => return ToolOutcome::refused(e),
            };
            valid.lineage = engine.lineage_of(input.as_ref()).await;
            // In a delivery the ledger keeps a re-delivered turn from making
            // the same dispatch twice; it decides nothing else.
            let auth = match engine.ledger_batch().await {
                Some((batch_id, scope)) => DispatchAuth::Ledgered { batch_id, scope },
                None => DispatchAuth::Direct,
            };
            // Work already going on the same line: a reminder, not a refusal.
            let note = engine.same_line_note(valid.mode, valid.folder_id).await;
            // The owner may have asked to confirm such dispatches first.
            match engine.dispatch_or_confirm(valid, auth).await {
                Ok(Ok(made)) => {
                    let mut out = dispatched(&made.dispatch, made.earlier);
                    if let (false, Some(n)) = (made.earlier, note) {
                        out.text = format!("{}\n{n}", out.text);
                    }
                    out
                }
                Ok(Err(card)) => card.outcome("dispatch"),
                Err(e) => ToolOutcome::refused(e),
            }
        }
        "dispatch_followup" => {
            let Some(id) = int(&args, "dispatch_id").and_then(as_i32) else {
                return ToolOutcome::refused("`dispatch_id` is required");
            };
            let message = string(&args, "message").unwrap_or_default();
            // A follow-up stays with the dispatch's own chain; a `for` it
            // names must still be one of this assistant's inputs.
            if let Some(named) = reference(&args, "for") {
                if let Err(e) = engine.input_for(Some(&named), Unnamed::Refuse).await {
                    return ToolOutcome::refused(e);
                }
            }
            let auth = match engine.ledger_batch().await {
                Some((batch_id, scope)) => FollowupAuth::Ledgered { batch_id, scope },
                None => FollowupAuth::Direct,
            };
            match engine
                .followup_or_confirm(id, message, string(&args, "intent"), auth)
                .await
            {
                Ok(Ok(text)) => ToolOutcome::ok(text, json!({ "dispatch_id": id })),
                Ok(Err(card)) => card.outcome("follow-up"),
                Err(e) => ToolOutcome::refused(e),
            }
        }
        "dispatch_answer" => engine.dispatch_answer_call(&args).await,
        "prefs_update" => engine.prefs_update_call(&args).await,
        "bot_create" => engine.bot_create_call(&args).await,
        "bot_list" => engine.bot_list_call().await,
        "overview" => engine.overview_call().await,
        "board_status" => engine.board_status_call(&args).await,
        "session_list" => engine.session_list_call(&args).await,
        "automation_status" => engine.automation_status_call().await,
        "pr_status" => engine.pr_status_call(&args).await,
        "usage_summary" => engine.usage_summary_call(&args).await,
        "activity_summary" => engine.activity_summary_call(&args).await,
        "bot_message" => {
            let call = MessageCall {
                to: reference(&args, "to"),
                text: string(&args, "text").unwrap_or_default(),
                reply_to: reference(&args, "reply_to"),
                wants_reply: args.get("wants_reply").and_then(|v| v.as_bool()),
                for_input: reference(&args, "for"),
            };
            match engine.message_or_confirm(call).await {
                Ok(Err(card)) => card.outcome("message"),
                Err(e) => ToolOutcome::refused(e),
                Ok(Ok(sent)) => {
                    let m = &sent.message;
                    let thread = m.thread_id.map(|t| format!(" on thread t{t}")).unwrap_or_default();
                    let text = if sent.earlier {
                        format!(
                            "Already sent: the turn this delivery repeats sent this same message, \
                             m{} to {}{thread}; nothing new was sent.",
                            m.id, sent.to_name
                        )
                    } else if m.wants_reply {
                        format!(
                            "Sent m{} to {}{thread}. It is theirs to see through now; their \
                             answer reaches you as a <codeg-message>. You can end your turn.",
                            m.id, sent.to_name
                        )
                    } else {
                        format!("Sent m{} to {}{thread}.", m.id, sent.to_name)
                    };
                    ToolOutcome::ok(
                        text,
                        json!({
                            "message_id": m.id,
                            "thread_id": m.thread_id,
                            "state": m.state,
                            "earlier": sent.earlier,
                        }),
                    )
                }
            }
        }
        "item_list" => {
            let statuses: Vec<ItemStatus> = match string(&args, "status").as_deref() {
                None | Some("active") => vec![ItemStatus::Open, ItemStatus::Waiting],
                Some("open") => vec![ItemStatus::Open],
                Some("waiting") => vec![ItemStatus::Waiting],
                Some("done") => vec![ItemStatus::Done],
                Some("dropped") => vec![ItemStatus::Dropped],
                Some("all") => Vec::new(),
                Some(_) => {
                    return ToolOutcome::refused(
                        "`status` must be active, open, waiting, done, dropped or all",
                    )
                }
            };
            let items = svc::list_items(&db.conn, bot, &statuses, 100).await.unwrap_or_default();
            let mut rows = Vec::new();
            let mut lines = Vec::new();
            for i in items {
                let dispatch = match i.dispatch_id {
                    Some(id) => svc::get_dispatch(&db.conn, id).await.ok().flatten(),
                    None => None,
                };
                let mut line = format!(
                    "#{} [{}] {} · {}",
                    i.id,
                    enum_str(&i.kind),
                    i.summary,
                    enum_str(&i.status)
                );
                if let Some(w) = &i.waits_for {
                    line.push_str(&format!(" · waits for {}", enum_str(w)));
                }
                if let Some(d) = &dispatch {
                    line.push_str(&format!(
                        " · dispatch #{} {} ({})",
                        d.id,
                        enum_str(&d.state),
                        enum_str(&d.mode)
                    ));
                }
                lines.push(line);
                rows.push(json!({
                    "id": i.id,
                    "kind": i.kind,
                    "status": i.status,
                    "waits_for": i.waits_for,
                    "summary": i.summary,
                    "on_done": i.on_done,
                    "dispatch_id": i.dispatch_id,
                    "dispatch_state": dispatch.as_ref().map(|d| d.state),
                }));
            }
            let text = if lines.is_empty() {
                "No matters match.".to_string()
            } else {
                lines.join("\n")
            };
            ToolOutcome::ok(text, json!({ "items": rows }))
        }
        "item_read" => {
            let Some(id) = int(&args, "item_id").and_then(as_i32) else {
                return ToolOutcome::refused("`item_id` is required");
            };
            let Ok(Some(item)) = svc::get_item_of(&db.conn, bot, id).await else {
                return ToolOutcome::refused(format!("item #{id} does not exist"));
            };
            let dispatch = match item.dispatch_id {
                Some(did) => svc::get_dispatch(&db.conn, did).await.ok().flatten(),
                None => None,
            };
            let mut text = format!(
                "#{} [{}] {}\nstatus: {}",
                item.id,
                enum_str(&item.kind),
                item.summary,
                enum_str(&item.status)
            );
            if let Some(w) = &item.waits_for {
                text.push_str(&format!(" · waits for {}", enum_str(w)));
            }
            if let Some(on_done) = &item.on_done {
                text.push_str(&format!("\nwhen done: {on_done}"));
            }
            let dispatch_json = dispatch.as_ref().map(|d| {
                let executor = executor_of(d);
                text.push_str(&format!(
                    "\ndispatch #{}: {} · {} · executor {}",
                    d.id,
                    enum_str(&d.mode),
                    enum_str(&d.state),
                    executor.name
                ));
                if let Some(e) = &d.result_excerpt {
                    text.push_str(&format!("\nresult: {e}"));
                }
                if let Some(e) = &d.error {
                    text.push_str(&format!("\nerror: {e}"));
                }
                json!({
                    "id": d.id,
                    "mode": d.mode,
                    "state": d.state,
                    "title": d.title,
                    "executor": executor.name,
                    "work_task_id": d.work_task_id,
                    "conversation_id": d.conversation_id,
                    "result_excerpt": d.result_excerpt,
                    "error": d.error,
                })
            });
            ToolOutcome::ok(
                text,
                json!({
                    "item": {
                        "id": item.id,
                        "kind": item.kind,
                        "status": item.status,
                        "waits_for": item.waits_for,
                        "summary": item.summary,
                        "on_done": item.on_done,
                    },
                    "dispatch": dispatch_json,
                }),
            )
        }
        "item_update" => {
            let status = match string(&args, "status").as_deref() {
                None => None,
                Some("open") => Some(ItemStatus::Open),
                Some("waiting") => Some(ItemStatus::Waiting),
                Some("done") => Some(ItemStatus::Done),
                Some("dropped") => Some(ItemStatus::Dropped),
                Some(_) => return ToolOutcome::refused("`status` must be open, waiting, done or dropped"),
            };
            let waits_for = match string(&args, "waits_for").as_deref() {
                None => None,
                Some("owner") => Some(WaitsFor::Owner),
                Some("agent") => Some(WaitsFor::Agent),
                Some("time") => Some(WaitsFor::Time),
                Some("external") => Some(WaitsFor::External),
                Some(_) => {
                    return ToolOutcome::refused("`waits_for` must be owner, agent, time or external")
                }
            };
            let summary = string(&args, "summary").map(|s| s.chars().take(500).collect::<String>());
            let on_done = string(&args, "on_done").map(|s| s.chars().take(2_000).collect::<String>());
            match int(&args, "item_id").and_then(as_i32) {
                Some(id) => {
                    let Ok(Some(_)) = svc::get_item_of(&db.conn, bot, id).await else {
                        return ToolOutcome::refused(format!("item #{id} does not exist"));
                    };
                    let updated = svc::update_item(
                        &db.conn,
                        id,
                        ItemWrite {
                            status,
                            waits_for: waits_for.map(Some),
                            summary,
                            on_done: on_done.map(Some),
                        },
                    )
                    .await;
                    engine.emit(PersonalAgentChange::Item { id });
                    match updated {
                        Ok(Some(i)) => ToolOutcome::ok(
                            format!("Updated #{}: {} · {}", i.id, i.summary, enum_str(&i.status)),
                            json!({ "item_id": i.id, "status": i.status }),
                        ),
                        _ => ToolOutcome::refused("the update did not apply"),
                    }
                }
                None => {
                    let kind = match string(&args, "kind").as_deref() {
                        Some("reminder") => ItemKind::Reminder,
                        Some("followup") => ItemKind::Followup,
                        Some("question") => ItemKind::Question,
                        _ => {
                            return ToolOutcome::refused(
                                "a new item needs `kind` (reminder, followup or question); \
                                 dispatches get theirs automatically",
                            )
                        }
                    };
                    let Some(summary) = summary else {
                        return ToolOutcome::refused("a new item needs `summary`");
                    };
                    match svc::create_item(
                        &db.conn,
                        bot,
                        kind,
                        None,
                        status.unwrap_or(ItemStatus::Open),
                        waits_for,
                        summary,
                        on_done,
                        None,
                    )
                    .await
                    {
                        Ok(i) => {
                            engine.emit(PersonalAgentChange::Item { id: i.id });
                            ToolOutcome::ok(
                                format!("Added #{}: {}", i.id, i.summary),
                                json!({ "item_id": i.id }),
                            )
                        }
                        Err(e) => ToolOutcome::refused(e.to_string()),
                    }
                }
            }
        }
        "timeline_read" => {
            let limit = int(&args, "limit").unwrap_or(20).clamp(1, 100) as u64;
            let before = int(&args, "before_id").and_then(as_i32);
            let (rows, has_older) = svc::page(&db.conn, bot, before, limit).await.unwrap_or_default();
            let mut lines = Vec::new();
            let mut out = Vec::new();
            for r in rows.into_iter().rev() {
                // A reply still being written (this one), or one that never
                // started.
                if svc::is_unwritten_reply(&r) {
                    continue;
                }
                let row = svc::to_row(r);
                let who = match row.kind {
                    crate::db::entities::personal_agent_timeline::TimelineKind::Owner => "owner",
                    crate::db::entities::personal_agent_timeline::TimelineKind::Reply => "you",
                    _ => "codeg",
                };
                let body: String = row.body.chars().take(2_000).collect();
                lines.push(format!(
                    "#{} {} [{}] {}: {}",
                    row.id,
                    row.created_at.format("%Y-%m-%d %H:%M"),
                    enum_str(&row.kind),
                    who,
                    body
                ));
                out.push(json!({
                    "id": row.id,
                    "kind": row.kind,
                    "at": row.created_at,
                    "text": body,
                    "data": row.data,
                }));
            }
            let mut text = if lines.is_empty() {
                "Nothing older.".to_string()
            } else {
                lines.join("\n")
            };
            if has_older {
                text.push_str("\n(more before; pass the smallest id as before_id)");
            }
            ToolOutcome::ok(text, json!({ "rows": out, "has_older": has_older }))
        }
        other => ToolOutcome::refused(format!("unknown personal-agent tool: {other}")),
    }
}

/// What a dispatch call answers: the new dispatch, or — the call repeating
/// one a re-delivered turn already made — the dispatch it made then.
fn dispatched(d: &crate::db::entities::personal_agent_dispatch::Model, earlier: bool) -> ToolOutcome {
    let text = if earlier {
        format!(
            "Already dispatched: the turn this delivery repeats made this same dispatch, #{} \
             \"{}\" ({}, {}); nothing new was started.",
            d.id,
            d.title,
            enum_str(&d.mode),
            enum_str(&d.state)
        )
    } else {
        format!(
            "Dispatched #{} \"{}\" as a {} to {}. It runs on its own; its progress comes back to \
             you as events, and the owner already sees a card for it.",
            d.id,
            d.title,
            enum_str(&d.mode),
            executor_of(d).name
        )
    };
    ToolOutcome::ok(text, json!({ "dispatch_id": d.id, "state": d.state, "earlier": earlier }))
}

/// Tests: `timeline_read` as the agent would call it.
#[cfg(test)]
pub(crate) async fn timeline_read_for_test(engine: &Arc<PersonalAgentEngine>) -> String {
    answer(engine, "timeline_read", json!({ "limit": 50 })).await.text
}

/// Tests: `item_update` as the agent would call it.
#[cfg(test)]
pub(crate) async fn item_update_for_test(engine: &Arc<PersonalAgentEngine>, args: Value) -> ToolOutcome {
    answer(engine, "item_update", args).await
}

/// Tests: any tool as the agent would call it.
#[cfg(test)]
pub(crate) async fn call_for_test(engine: &Arc<PersonalAgentEngine>, tool: &str, args: Value) -> ToolOutcome {
    answer(engine, tool, args).await
}
