//! The personal agent's codeg-mcp tools, answered in the app.
//!
//! Every call is checked here, not only in the companion: the socket is gated
//! by a per-launch token alone, and `--features` is a string in the agent's
//! MCP config, so any connection's companion could send one of these frames.
//! Only the personal agent's current connection gets an answer. Every tool
//! returns at once — none waits for a turn or a person — but
//! `dispatch_wait`, which waits a bounded while for news of the assistant's
//! own work, changing nothing (the listener drops it when its caller goes).
//!
//! A refusal is an answer (`ok: false`), not an error: the model reads why and
//! corrects the call.

use std::sync::Arc;

use serde::Serialize;
use serde_json::{json, Value};

use super::dispatch::{DispatchAuth, DispatchRequest, FollowupAuth};
use super::engine::{enum_str, PersonalAgentEngine};
use super::mentions::{self, Mention};
use super::messages::{MessageCall, Unnamed};
use super::reminders;
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

/// `suggest: true` (6.7): the call is only the assistant's idea — `Some`
/// with its `reason`, or the refusal when it gave none.
fn suggestion(args: &Value) -> Option<Result<String, ToolOutcome>> {
    if args.get("suggest").and_then(|v| v.as_bool()) != Some(true) {
        return None;
    }
    Some(
        args.get("reason")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(|s| s.chars().take(1_000).collect::<String>())
            .ok_or_else(|| {
                ToolOutcome::refused("a suggestion needs `reason`: why you think it fits the owner")
            }),
    )
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

/// A card's data as an assistant reads it: every field about an executor
/// config taken out, however deep — they are the owner's, and the
/// assistants know only who does the work.
pub(super) fn without_executors(mut data: Value) -> Value {
    fn strip(v: &mut Value) {
        match v {
            Value::Object(map) => {
                map.retain(|k, _| {
                    !k.starts_with("executor") && !k.starts_with("checker") && k != "by_executor"
                });
                map.values_mut().for_each(strip);
            }
            Value::Array(items) => items.iter_mut().for_each(strip),
            _ => {}
        }
    }
    strip(&mut data);
    data
}

/// Answer a call already known to come from the personal agent.
async fn answer(engine: &Arc<PersonalAgentEngine>, tool: &str, args: Value) -> ToolOutcome {
    let db = &engine.db;
    // Whose records the call reads and writes: the calling assistant's only.
    let bot = engine.bot().await;
    match tool {
        "project_list" => {
            let folders = crate::db::service::folder_service::list_all_folder_details(&db.conn)
                .await
                .unwrap_or_default();
            // Open in the workspace, and kept an eye on (`prefs.projects`).
            let open: std::collections::HashSet<i32> =
                super::projects::eligible_projects(db).await.iter().map(|f| f.id).collect();
            let scope = engine.prefs().await.projects;
            let rows: Vec<Value> = folders
                .iter()
                .filter(|f| f.kind == FolderKind::Regular && f.parent_id.is_none())
                .map(|f| {
                    let is_open = open.contains(&f.id);
                    json!({
                        "id": f.id,
                        "name": f.alias.clone().unwrap_or_else(|| f.name.clone()),
                        "path": f.path,
                        "open": is_open,
                        "watched": is_open && scope.covers(f.id),
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
                .map(|r| {
                    let mut marks: Vec<&str> = Vec::new();
                    marks.push(if r["open"] == true { "open" } else { "closed" });
                    if r["watched"] == true {
                        marks.push("watched");
                    }
                    format!(
                        "#{} {} — {} ({})",
                        r["id"],
                        r["name"].as_str().unwrap_or(""),
                        r["path"].as_str().unwrap_or(""),
                        marks.join(", ")
                    )
                })
                .collect::<Vec<_>>()
                .join("\n");
            ToolOutcome::ok(text, json!({ "projects": rows }))
        }
        "dispatch" => {
            if args.get("agent_type").is_some() || args.get("assistant_id").is_some() {
                return ToolOutcome::refused(
                    "dispatch starts work of your own: it runs on what your settings say. To \
                     have another assistant do it, hand it over with `bot_message`",
                );
            }
            let mode = match string(&args, "mode").as_deref() {
                Some("task") => DispatchMode::Task,
                Some("chat") => DispatchMode::Chat,
                Some("session") => DispatchMode::Session,
                _ => return ToolOutcome::refused("`mode` must be task, chat or session"),
            };
            let report = match string(&args, "deliverable").as_deref() {
                None | Some("change") => false,
                Some("report") => true,
                Some(_) => return ToolOutcome::refused("`deliverable` must be change or report"),
            };
            let req = DispatchRequest {
                mode,
                title: string(&args, "title").unwrap_or_default(),
                prompt: string(&args, "prompt").unwrap_or_default(),
                project_id: int(&args, "project_id").and_then(as_i32),
                report: report || (mode != DispatchMode::Task && args.get("deliverable").is_some()),
                on_done: string(&args, "on_done"),
                done_when: string(&args, "done_when"),
                replaces: int(&args, "replaces").and_then(as_i32),
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
            // Only the assistant's idea: a card, run if the owner accepts.
            if let Some(reason) = suggestion(&args) {
                return match reason {
                    Ok(reason) => match engine.suggestions_closed().await {
                        Some(no) => no,
                        None => engine.suggest_dispatch(valid, reason).await,
                    },
                    Err(no) => no,
                };
            }
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
                    if !made.earlier {
                        if let Some(n) = engine.open_failure_note(&made.dispatch).await {
                            out.text = format!("{}\n{n}", out.text);
                        }
                    }
                    // The third request like it in a month (6.7).
                    if !made.earlier {
                        if let Some(n) = engine.offer_routine_for_dispatch(&made.dispatch).await {
                            out.text = format!("{}\n{n}", out.text);
                        }
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
            if let Some(reason) = suggestion(&args) {
                return match reason {
                    Ok(reason) => match engine.suggestions_closed().await {
                        Some(no) => no,
                        None => {
                            engine
                                .suggest_followup(id, message, string(&args, "intent"), reason)
                                .await
                        }
                    },
                    Err(no) => no,
                };
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
        "dispatch_wait" => {
            let Some(id) = int(&args, "dispatch_id").and_then(as_i32) else {
                return ToolOutcome::refused("`dispatch_id` is required");
            };
            // Not told: as long as one call waits. 0: a look, no wait.
            let wait = int(&args, "wait_ms")
                .map(|ms| std::time::Duration::from_millis(ms.max(0) as u64));
            engine.dispatch_wait(id, wait).await
        }
        "acceptance_decide" => engine.acceptance_decide_call(&args).await,
        "prefs_update" => engine.prefs_update_call(&args).await,
        "bot_create" => engine.bot_create_call(&args).await,
        "bot_update" => engine.bot_update_call(&args).await,
        "bot_list" => engine.bot_list_call().await,
        // Boxed, as the plan tools are: a routine's run hands out work, and
        // the futures down that way are deep (a test's 2 MB stack).
        "routine_list" => Box::pin(engine.routine_list_call()).await,
        "routine_create" => Box::pin(engine.routine_create_call(&args)).await,
        "routine_update" => Box::pin(engine.routine_update_call(&args)).await,
        // Plans (7.6). Boxed: deep futures, and this match is every tool's.
        "plan_create" => Box::pin(engine.plan_create_call(&args)).await,
        "plan_update" => Box::pin(engine.plan_update_call(&args)).await,
        "plan_read" => Box::pin(engine.plan_read_call(&args)).await,
        // "That's it for today" (6.5).
        "wrap_up" => engine.wrap_up_call().await,
        "overview" => engine.overview_call().await,
        "board_status" => engine.board_status_call(&args).await,
        "session_list" => engine.session_list_call(&args).await,
        "automation_status" => engine.automation_status_call().await,
        "pr_status" => engine.pr_status_call(&args).await,
        "forge_comment" => {
            engine
                .forge_act_call(super::forge_acts::ForgeAction::Comment, &args)
                .await
        }
        "issue_close" => {
            engine
                .forge_act_call(super::forge_acts::ForgeAction::Close, &args)
                .await
        }
        "pr_merge" => {
            engine
                .forge_act_call(super::forge_acts::ForgeAction::Merge, &args)
                .await
        }
        // A watched pull request's comments, handed to its task (7.4).
        "pr_feedback_forward" => engine.pr_feedback_forward_call(&args).await,
        "usage_summary" => engine.usage_summary_call(&args).await,
        "activity_summary" => engine.activity_summary_call(&args).await,
        // The time machine (8.2).
        // Boxed: the search is a deep future, and this match is every
        // tool's.
        "history_search" => Box::pin(engine.history_search_call(&args)).await,
        "bot_message" => {
            let call = MessageCall {
                to: reference(&args, "to"),
                text: string(&args, "text").unwrap_or_default(),
                reply_to: reference(&args, "reply_to"),
                wants_reply: args.get("wants_reply").and_then(|v| v.as_bool()),
                for_input: reference(&args, "for"),
            };
            if let Some(reason) = suggestion(&args) {
                return match reason {
                    Ok(reason) => match engine.suggestions_closed().await {
                        Some(no) => no,
                        None => engine.suggest_message(call, reason).await,
                    },
                    Err(no) => no,
                };
            }
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
            let tz = engine.owner_tz().await;
            let now = super::clock::now();
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
                if let Some(t) = reminders::time_words(&i, tz, now) {
                    line.push_str(&format!(" · {t}"));
                }
                if let Some(m) = Mention::of(&i) {
                    line.push_str(&format!(" · {}", m.describe(now)));
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
                    "due_at": i.due_at,
                    "due_local": i.due_at.map(|t| super::due::describe(t, tz, now)),
                    "at_due": i.at_due,
                    "repeat": i.repeat.as_deref().and_then(|r| serde_json::from_str::<Value>(r).ok()),
                    "when_mentioned": Mention::of(&i),
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
            let tz = engine.owner_tz().await;
            let now = super::clock::now();
            if let Some(t) = reminders::time_words(&item, tz, now) {
                text.push_str(&format!(
                    "\n{t} ({})",
                    super::due::zone_label(tz, item.due_at.unwrap_or(now))
                ));
            }
            if let Some(m) = Mention::of(&item) {
                text.push_str(&format!("\ncomes up {}", m.describe(now)));
            }
            if let Some(spec) = super::due::ActSpec::parse(item.act_spec.as_deref()) {
                text.push_str(&format!("\nto do then: {}", spec.what));
                if let Some(d) = &spec.dispatch {
                    text.push_str(&format!("\ndispatch draft: {}", Value::Object(d.clone())));
                }
            }
            let dispatch_json = dispatch.as_ref().map(|d| {
                text.push_str(&format!(
                    "\ndispatch #{}: {} · {}",
                    d.id,
                    enum_str(&d.mode),
                    enum_str(&d.state),
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
                        "due_at": item.due_at,
                        "at_due": item.at_due,
                        "repeat": item.repeat.as_deref().and_then(|r| serde_json::from_str::<Value>(r).ok()),
                        "act_spec": item.act_spec.as_deref().and_then(|a| serde_json::from_str::<Value>(a).ok()),
                        "when_mentioned": Mention::of(&item),
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
            let (tz, mornings) = engine.owner_day().await;
            let now = super::clock::now();
            match int(&args, "item_id").and_then(as_i32) {
                Some(id) => {
                    let Ok(Some(item)) = svc::get_item_of(&db.conn, bot, id).await else {
                        return ToolOutcome::refused(format!("item #{id} does not exist"));
                    };
                    // A matter a mention brings up has no time; its words
                    // and how it comes up change here (6.8).
                    match (item.kind == ItemKind::WhenMentioned, given(&args, "when_mentioned")) {
                        (true, _) if has_time_args(&args) => {
                            return ToolOutcome::refused(
                                "a matter brought up by a mention has no time: change its `when_mentioned` instead",
                            )
                        }
                        // Written onto how it stands then: a time it came
                        // up meanwhile is kept.
                        (true, Some(v)) => {
                            if let Err(e) = mentions::change(&db.conn, &item, v, now).await {
                                return ToolOutcome::refused(e);
                            }
                        }
                        (false, Some(_)) => {
                            return ToolOutcome::refused(
                                "`when_mentioned` is for a matter that comes up when the owner mentions \
                                 something: make a new one with kind when_mentioned",
                            )
                        }
                        _ => {}
                    }
                    let mut time = match reminders::time_from_args(&args, Some(&item), tz, now, mornings) {
                        Ok(t) => t,
                        Err(e) => return ToolOutcome::refused(e),
                    };
                    let mut status = status;
                    let mut waits_for = waits_for;
                    let mut again = None;
                    // Done on a repeating matter: done for this time.
                    if status == Some(ItemStatus::Done) && time.is_none() {
                        if let Some(next) = reminders::after_done(&item, tz, now) {
                            again = next.due_at;
                            status = None;
                            time = Some(next);
                            waits_for.get_or_insert(WaitsFor::Time);
                        }
                    }
                    let new_due = time.as_ref().and_then(|t| t.due_at).filter(|d| Some(*d) != item.due_at);
                    if new_due.is_some() && waits_for.is_none() {
                        waits_for = Some(WaitsFor::Time);
                    }
                    // A reminder still open for a time gone by goes with it.
                    let card = match (status, &time) {
                        (Some(ItemStatus::Done), _) => Some(("done", None)),
                        (Some(ItemStatus::Dropped), _) => Some(("dropped", None)),
                        (_, Some(_)) if again.is_some() => Some(("done", None)),
                        (_, Some(t)) if t.due_at.is_none() => Some(("closed", None)),
                        (_, Some(t)) if new_due.is_some() => Some(("snoozed", t.due_at)),
                        _ => None,
                    };
                    let updated = engine
                        .write_item(
                            &item,
                            ItemWrite {
                                status,
                                waits_for: waits_for.map(Some),
                                summary,
                                on_done: on_done.map(Some),
                                time: time.clone(),
                                closing: match status {
                                    Some(ItemStatus::Done) => Some(svc::Closing::new(svc::Closer::Agent, "done")),
                                    Some(ItemStatus::Dropped) => Some(svc::Closing::new(svc::Closer::Agent, "dropped")),
                                    _ => None,
                                },
                                answer: None,
                            },
                            card,
                            None,
                        )
                        .await;
                    match updated {
                        Ok(i) => {
                            let mut text = format!("Updated #{}: {} · {}", i.id, i.summary, enum_str(&i.status));
                            if let Some(t) = again {
                                text.push_str(&format!(
                                    " — done for this time; it comes up again {}",
                                    super::due::describe(t, tz, now)
                                ));
                            }
                            text.push_str(&time_answer(&i, tz, now));
                            text.push_str(&mention_answer(&i, now));
                            ToolOutcome::ok(text, item_answer(&i, tz, now))
                        }
                        Err(e) => ToolOutcome::refused(e),
                    }
                }
                None => {
                    let mentioned = given(&args, "when_mentioned");
                    let kind = match string(&args, "kind").as_deref() {
                        Some("reminder") => ItemKind::Reminder,
                        Some("followup") => ItemKind::Followup,
                        Some("question") => ItemKind::Question,
                        Some("when_mentioned") => ItemKind::WhenMentioned,
                        None if mentioned.is_some() => ItemKind::WhenMentioned,
                        _ => {
                            return ToolOutcome::refused(
                                "a new item needs `kind` (reminder, followup, question or \
                                 when_mentioned); dispatches get theirs automatically",
                            )
                        }
                    };
                    let Some(summary) = summary else {
                        return ToolOutcome::refused("a new item needs `summary`");
                    };
                    // "Next time I mention X, remind me of Y" (6.8).
                    if kind == ItemKind::WhenMentioned {
                        if has_time_args(&args) {
                            return ToolOutcome::refused(
                                "a matter brought up by a mention has no time: give `when_mentioned` alone",
                            );
                        }
                        let Some(v) = mentioned else {
                            return ToolOutcome::refused(
                                "a when_mentioned matter needs `when_mentioned`: the keywords that bring it up",
                            );
                        };
                        let m = match mentions::from_args(v, None, now) {
                            Ok(m) => m,
                            Err(e) => return ToolOutcome::refused(e),
                        };
                        return match svc::create_mention_item(
                            &db.conn,
                            bot,
                            summary,
                            engine.turn_owner_row().await,
                            m.to_json(),
                        )
                        .await
                        {
                            Ok(i) => {
                                engine.emit(PersonalAgentChange::Item { id: i.id });
                                ToolOutcome::ok(
                                    format!(
                                        "Added #{}: {}{}",
                                        i.id,
                                        i.summary,
                                        mention_answer(&i, now)
                                    ),
                                    item_answer(&i, tz, now),
                                )
                            }
                            Err(e) => ToolOutcome::refused(e.to_string()),
                        };
                    }
                    if mentioned.is_some() {
                        return ToolOutcome::refused(
                            "`when_mentioned` makes a when_mentioned matter: leave `kind` out or set it so",
                        );
                    }
                    let time = match reminders::time_from_args(&args, None, tz, now, mornings) {
                        Ok(t) => t.filter(|t| t.due_at.is_some()).unwrap_or_default(),
                        Err(e) => return ToolOutcome::refused(e),
                    };
                    let waits_for = match (waits_for, time.due_at) {
                        (None, Some(_)) => Some(WaitsFor::Time),
                        (w, _) => w,
                    };
                    // A question comes from the reply that asks it; any other
                    // matter from what the owner wrote.
                    let origin = match kind {
                        ItemKind::Question => match engine.turn_reply_row().await {
                            Some(r) => Some(r),
                            None => engine.turn_owner_row().await,
                        },
                        _ => engine.turn_owner_row().await,
                    };
                    match svc::create_item_timed(
                        &db.conn,
                        bot,
                        kind,
                        None,
                        status.unwrap_or(ItemStatus::Open),
                        waits_for,
                        summary,
                        on_done,
                        origin,
                        time,
                    )
                    .await
                    {
                        Ok(i) => {
                            engine.emit(PersonalAgentChange::Item { id: i.id });
                            ToolOutcome::ok(
                                format!("Added #{}: {}{}", i.id, i.summary, time_answer(&i, tz, now)),
                                item_answer(&i, tz, now),
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
                // A card as its words, not its JSON lines (9.5).
                let body: String = super::spec_text::cards_as_text(&row.body)
                    .chars()
                    .take(2_000)
                    .collect();
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
                    "data": row.data.map(without_executors),
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

/// A matter's time, as `item_update` answers it: the time in the owner's
/// zone with its weekday — to tell the owner as it is — what happens then,
/// and its next times.
fn time_answer(
    item: &crate::db::entities::personal_agent_item::Model,
    tz: chrono_tz::Tz,
    now: chrono::DateTime<chrono::Utc>,
) -> String {
    let Some(words) = reminders::time_words(item, tz, now) else {
        return String::new();
    };
    let due_at = item.due_at.unwrap_or(now);
    let mut out = format!("\n{words} ({})", super::due::zone_label(tz, due_at));
    let times = reminders::next_times(&svc::ItemTime::of(item), tz, now);
    if times.len() > 1 {
        out.push_str(&format!("\nnext times: {}", times.join("; ")));
    }
    out.push_str("\nTell the owner this time and weekday as codeg gives them.");
    out
}

fn item_answer(
    item: &crate::db::entities::personal_agent_item::Model,
    tz: chrono_tz::Tz,
    now: chrono::DateTime<chrono::Utc>,
) -> Value {
    json!({
        "item_id": item.id,
        "status": item.status,
        "due_at": item.due_at,
        "due_local": item.due_at.map(|t| super::due::describe(t, tz, now)),
        "at_due": item.at_due,
        "repeat": item.repeat.as_deref().and_then(|r| serde_json::from_str::<Value>(r).ok()),
        "when_mentioned": Mention::of(item),
    })
}

/// How a matter brought up by a mention stands, for the assistant (6.8).
fn mention_answer(
    item: &crate::db::entities::personal_agent_item::Model,
    now: chrono::DateTime<chrono::Utc>,
) -> String {
    match Mention::of(item) {
        Some(m) if item.status == ItemStatus::Open || item.status == ItemStatus::Waiting => {
            format!(
                "\nIt comes up {}. Only the owner cancels it: drop it when they say so.",
                m.describe(now)
            )
        }
        _ => String::new(),
    }
}

/// The argument `key`, when given and not null.
fn given<'a>(args: &'a Value, key: &str) -> Option<&'a Value> {
    args.get(key).filter(|v| !v.is_null())
}

/// Whether the call gives a matter a time.
fn has_time_args(args: &Value) -> bool {
    ["due", "repeat", "at_due", "act_spec", "clear_due"]
        .iter()
        .any(|k| given(args, k).is_some())
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
            "Dispatched #{} \"{}\" as a {}: a work session of yours does it on its own; its \
             progress comes back to you as events, and the owner already sees a card for it.",
            d.id,
            d.title,
            enum_str(&d.mode),
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
