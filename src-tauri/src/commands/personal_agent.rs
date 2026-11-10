//! The personal agent's page: its configuration, timeline, composer actions,
//! ledger, dispatches, files and data.
//!
//! Reads work in every process from the database. Everything that acts goes
//! through the engine, which runs only in the process holding the work-task
//! engine; anywhere else the page is read-only and these return an error
//! saying so.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::Path;
#[cfg(feature = "tauri-runtime")]
use std::path::PathBuf;
use std::sync::Arc;

use chrono::{Duration, Local, Utc};
use sea_orm::{ColumnTrait, EntityTrait, QueryFilter};
#[cfg(feature = "tauri-runtime")]
use tauri::State;

use crate::acp::types::PromptInputBlock;
use crate::app_error::AppCommandError;
use crate::db::entities::personal_agent_batch::BatchKind;
use crate::db::entities::personal_agent_dispatch::{DispatchMode, DispatchState};
use crate::db::entities::personal_agent_item::ItemStatus;
use crate::db::entities::personal_agent_timeline::TimelineKind;
use crate::db::service::personal_agent_service as svc;
use crate::db::AppDatabase;
use crate::models::personal_agent::{
    DispatchInfo, ItemInfo, PersonalAgentDayStat, PersonalAgentDraft, PersonalAgentExecutorStat,
    PersonalAgentFile, PersonalAgentInfo, PersonalAgentSnapshot, PersonalAgentStats,
    PersonalAgentUsagePoint, TimelineChanges, TimelineCursor, TimelinePage, TimelineRow,
};
use crate::personal_agent::engine::{self as pa_engine, PersonalAgentEngine};
use crate::personal_agent::workdir;

/// What an action answers in a process that does not run the engine.
fn elsewhere() -> AppCommandError {
    AppCommandError::invalid_input(
        "The personal agent runs in another codeg process on this data directory; this page is \
         read-only here.",
    )
    .with_i18n("errors.engineElsewhere", BTreeMap::new())
}

/// The engine running assistant `bot_id` (`None`: the primary).
async fn engine(bot_id: Option<i32>) -> Result<Arc<PersonalAgentEngine>, AppCommandError> {
    if let Some(e) = pa_engine::engine_for(bot_id).await {
        return Ok(e);
    }
    if pa_engine::engine().is_none() {
        return Err(elsewhere());
    }
    Err(refused(
        "this assistant has no engine running yet in this codeg process".into(),
    ))
}

fn refused(message: String) -> AppCommandError {
    AppCommandError::invalid_input(message)
}

/// The assistant a page call is about: `bot_id`, which must exist, or — when
/// left out — the primary. 0 when the primary is not set up yet (nothing is
/// filed under 0, so a read finds nothing).
async fn resolve_bot(db: &AppDatabase, bot_id: Option<i32>) -> Result<i32, AppCommandError> {
    match bot_id {
        Some(id) => match svc::get_bot(&db.conn, id).await? {
            Some(b) => Ok(b.id),
            None => Err(refused(format!("no assistant #{id}"))),
        },
        None => Ok(svc::primary_bot(&db.conn).await?.map(|b| b.id).unwrap_or(0)),
    }
}

// ── reads ───────────────────────────────────────────────────────────────────

pub async fn personal_agent_get_core(
    db: &AppDatabase,
    data_dir: &Path,
    bot_id: Option<i32>,
) -> Result<PersonalAgentSnapshot, AppCommandError> {
    if let Some(id) = bot_id {
        resolve_bot(db, Some(id)).await?;
    }
    Ok(pa_engine::snapshot_any(db, data_dir, bot_id).await)
}

/// A page of the timeline (`before_id`, `limit`), or — with `since_id` — every
/// row from `since_id` up to `before_id`, which a jump to an older message
/// loads at once (none, `too_far`, when that is more than a range read
/// takes).
pub async fn personal_agent_timeline_core(
    db: &AppDatabase,
    bot_id: Option<i32>,
    before_id: Option<i32>,
    limit: Option<u32>,
    since_id: Option<i32>,
) -> Result<TimelinePage, AppCommandError> {
    let bot = resolve_bot(db, bot_id).await?;
    if let Some(since) = since_id {
        let (rows, too_far) = svc::range(&db.conn, bot, since, before_id).await?;
        let has_older = match rows.first() {
            Some(first) => svc::has_rows_before(&db.conn, bot, first.id).await?,
            None => true,
        };
        return Ok(TimelinePage {
            rows: rows.into_iter().map(svc::to_row).collect(),
            has_older,
            too_far,
        });
    }
    let limit = limit.unwrap_or(60).clamp(1, 500) as u64;
    let (rows, has_older) = svc::page(&db.conn, bot, before_id, limit).await?;
    Ok(TimelinePage {
        rows: rows.into_iter().map(svc::to_row).collect(),
        has_older,
        too_far: false,
    })
}

/// Rows by id (at most 100): a quote's preview, a jump too far to load.
pub async fn personal_agent_timeline_rows_core(
    db: &AppDatabase,
    bot_id: Option<i32>,
    ids: Vec<i32>,
) -> Result<Vec<TimelineRow>, AppCommandError> {
    let bot = resolve_bot(db, bot_id).await?;
    Ok(svc::rows_by_ids(&db.conn, bot, &ids)
        .await?
        .into_iter()
        .map(svc::to_row)
        .collect())
}

/// Rows changed since `since` (or past `after`, continuing a read), from
/// `min_id` up: how a page that cannot hear the engine follows the rows it
/// holds.
pub async fn personal_agent_timeline_updated_since_core(
    db: &AppDatabase,
    bot_id: Option<i32>,
    since: Option<chrono::DateTime<Utc>>,
    after: Option<TimelineCursor>,
    min_id: Option<i32>,
) -> Result<TimelineChanges, AppCommandError> {
    let bot = resolve_bot(db, bot_id).await?;
    let (rows, next) = svc::changed_since(&db.conn, bot, since, after, min_id.unwrap_or(0)).await?;
    Ok(TimelineChanges {
        rows: rows.into_iter().map(svc::to_row).collect(),
        next,
    })
}

pub async fn personal_agent_items_core(
    db: &AppDatabase,
    bot_id: Option<i32>,
    status: Option<String>,
) -> Result<Vec<ItemInfo>, AppCommandError> {
    let bot = resolve_bot(db, bot_id).await?;
    let statuses = match status.as_deref() {
        None | Some("active") => vec![ItemStatus::Open, ItemStatus::Waiting],
        Some("all") => Vec::new(),
        Some("done") => vec![ItemStatus::Done, ItemStatus::Dropped],
        Some(other) => return Err(refused(format!("unknown item filter: {other}"))),
    };
    let items = svc::list_items(&db.conn, bot, &statuses, 500).await?;
    let mut out = Vec::with_capacity(items.len());
    for i in items {
        let dispatch_state = match i.dispatch_id {
            Some(id) => svc::get_dispatch(&db.conn, id).await?.map(|d| d.state),
            None => None,
        };
        out.push(ItemInfo {
            id: i.id,
            kind: i.kind,
            dispatch_id: i.dispatch_id,
            status: i.status,
            waits_for: i.waits_for,
            summary: i.summary,
            on_done: i.on_done,
            origin_timeline_id: i.origin_timeline_id,
            created_at: i.created_at,
            updated_at: i.updated_at,
            dispatch_state,
        });
    }
    Ok(out)
}

/// Dispatches, newest first: by `ids` when given (the cards a page shows),
/// else the latest `limit` of `mode`.
pub async fn personal_agent_dispatches_core(
    db: &AppDatabase,
    bot_id: Option<i32>,
    mode: Option<DispatchMode>,
    limit: Option<u32>,
    ids: Option<Vec<i32>>,
) -> Result<Vec<DispatchInfo>, AppCommandError> {
    let bot = resolve_bot(db, bot_id).await?;
    let rows = match ids {
        Some(ids) => svc::dispatches_by_ids(&db.conn, bot, &ids).await?,
        None => {
            svc::list_dispatches(&db.conn, bot, &[], mode, limit.unwrap_or(100).clamp(1, 500) as u64)
                .await?
        }
    };
    let mut folder_names: HashMap<i32, Option<String>> = HashMap::new();
    let mut out = Vec::with_capacity(rows.len());
    for d in rows {
        let folder_name = match d.folder_id {
            Some(fid) => {
                if let std::collections::hash_map::Entry::Vacant(slot) = folder_names.entry(fid) {
                    let name = crate::db::service::folder_service::get_folder_by_id(&db.conn, fid)
                        .await?
                        .map(|f| f.alias.unwrap_or(f.name));
                    slot.insert(name);
                }
                folder_names.get(&fid).cloned().flatten()
            }
            None => None,
        };
        let conversation_folder_id = match d.conversation_id {
            Some(cid) => crate::db::service::conversation_service::get_by_id(&db.conn, cid)
                .await
                .ok()
                .map(|c| c.folder_id),
            None => None,
        };
        out.push(DispatchInfo {
            id: d.id,
            mode: d.mode,
            executor: crate::personal_agent::dispatch::executor_of(&d),
            folder_id: d.folder_id,
            folder_name,
            deliverable: d.deliverable,
            title: d.title,
            prompt: d.prompt,
            work_task_id: d.work_task_id,
            conversation_id: d.conversation_id,
            conversation_folder_id,
            connection_id: d.connection_id,
            state: d.state,
            result_excerpt: d.result_excerpt,
            error: d.error,
            on_done: d.on_done,
            turns: d.turns,
            created_at: d.created_at,
            updated_at: d.updated_at,
            finished_at: d.finished_at,
        });
    }
    Ok(out)
}

pub async fn personal_agent_files_core(
    db: &AppDatabase,
    data_dir: &Path,
    bot_id: Option<i32>,
) -> Result<Vec<PersonalAgentFile>, AppCommandError> {
    let bot = resolve_bot(db, bot_id).await?;
    let Some(row) = svc::get_bot(&db.conn, bot).await? else {
        return Ok(Vec::new());
    };
    let dir = workdir::workdir_of_bot(data_dir, &row);
    let worker = row.kind == crate::db::entities::personal_agent::BotKind::Worker;
    let mut out = Vec::new();
    for name in workdir::editable_files(worker) {
        let content = workdir::read_file(&dir, name).map_err(AppCommandError::io)?;
        out.push(PersonalAgentFile {
            name: name.to_string(),
            exists: content.is_some(),
            content: content.unwrap_or_default(),
        });
    }
    // Then the entries the index lists, as `memory/<name>.md`.
    for (name, content) in workdir::list_entries(&dir) {
        out.push(PersonalAgentFile { name, content, exists: true });
    }
    Ok(out)
}

/// The data tab: daily counts, executors, the context-usage curve. Token
/// figures come from the usage dashboard's synced table, so they are as fresh
/// as its last sync.
pub async fn personal_agent_stats_core(
    db: &AppDatabase,
    bot_id: Option<i32>,
    days: Option<u32>,
) -> Result<PersonalAgentStats, AppCommandError> {
    let bot = resolve_bot(db, bot_id).await?;
    let days = days.unwrap_or(14).clamp(1, 90) as i64;
    let today = Local::now().date_naive();
    let first = today - Duration::days(days - 1);
    let since = first
        .and_hms_opt(0, 0, 0)
        .and_then(|t| t.and_local_timezone(Local).single())
        .map(|t| t.with_timezone(&Utc))
        .unwrap_or_else(|| Utc::now() - Duration::days(days));
    let key = |t: chrono::DateTime<Utc>| t.with_timezone(&Local).date_naive().format("%Y-%m-%d").to_string();
    let mut by_day: BTreeMap<String, PersonalAgentDayStat> = BTreeMap::new();
    for i in 0..days {
        let d = (first + Duration::days(i)).format("%Y-%m-%d").to_string();
        by_day.insert(
            d.clone(),
            PersonalAgentDayStat {
                date: d,
                ..Default::default()
            },
        );
    }
    for r in svc::rows_since(&db.conn, bot, since).await? {
        if let Some(day) = by_day.get_mut(&key(r.created_at)) {
            match r.kind {
                TimelineKind::Owner => day.owner_messages += 1,
                // A reply counts once it is settled (a phase-one row has no
                // state and always was).
                TimelineKind::Reply
                    if !matches!(svc::reply_state(&r), Some("running" | "discarded")) =>
                {
                    day.replies += 1
                }
                _ => {}
            }
        }
    }
    let dispatches = svc::dispatches_since(&db.conn, bot, since).await?;
    let mut executors: BTreeMap<i32, PersonalAgentExecutorStat> = BTreeMap::new();
    let mut dispatch_conversations: HashSet<i32> = HashSet::new();
    for d in &dispatches {
        if let Some(day) = by_day.get_mut(&key(d.created_at)) {
            match d.mode {
                DispatchMode::Task => day.dispatches_task += 1,
                DispatchMode::Chat => day.dispatches_chat += 1,
                DispatchMode::Session => day.dispatches_session += 1,
            }
        }
        if let Some(finished) = d.finished_at {
            if let Some(day) = by_day.get_mut(&key(finished)) {
                match d.state {
                    DispatchState::Completed => day.dispatches_completed += 1,
                    DispatchState::Failed | DispatchState::Interrupted => day.dispatches_failed += 1,
                    _ => {}
                }
            }
        }
        let executor = crate::personal_agent::dispatch::executor_of(d);
        let e = executors
            .entry(executor.assistant_id)
            .or_insert_with(|| PersonalAgentExecutorStat {
                assistant_id: executor.assistant_id,
                name: executor.name.clone(),
                dispatches: 0,
                completed: 0,
            });
        e.dispatches += 1;
        if d.state == DispatchState::Completed {
            e.completed += 1;
        }
        if let Some(cid) = d.conversation_id {
            dispatch_conversations.insert(cid);
        }
        if let Some(tid) = d.work_task_id {
            if let Ok(task) = crate::db::service::work_task_service::get_model(&db.conn, tid).await {
                if let Some(cid) = task.conversation_id {
                    dispatch_conversations.insert(cid);
                }
            }
        }
    }
    let segments = svc::list_segments(&db.conn, bot).await?;
    let own_conversations: HashSet<i32> = segments.iter().filter_map(|s| s.conversation_id).collect();
    let watched: Vec<i32> = own_conversations
        .iter()
        .chain(dispatch_conversations.iter())
        .copied()
        .collect();
    if !watched.is_empty() {
        use crate::db::entities::token_usage_turn;
        let turns = token_usage_turn::Entity::find()
            .filter(token_usage_turn::Column::ConversationId.is_in(watched.clone()))
            .filter(token_usage_turn::Column::OccurredAt.gte(since))
            .all(&db.conn)
            .await
            .map_err(|e| AppCommandError::database_error(e.to_string()))?;
        for t in turns {
            if let Some(day) = by_day.get_mut(&key(t.occurred_at)) {
                if own_conversations.contains(&t.conversation_id) {
                    day.agent_tokens += t.total_tokens;
                } else {
                    day.dispatch_tokens += t.total_tokens;
                }
            }
        }
    }
    let tokens_synced_at = if watched.is_empty() {
        None
    } else {
        use crate::db::entities::token_usage_sync;
        token_usage_sync::Entity::find()
            .filter(token_usage_sync::Column::ConversationId.is_in(watched))
            .all(&db.conn)
            .await
            .map_err(|e| AppCommandError::database_error(e.to_string()))?
            .into_iter()
            .map(|s| s.synced_at)
            .max()
    };
    // The usage curve: the reading before each delivery and the two ends of
    // each compaction, by segment.
    let seq_of: HashMap<i32, i32> = segments.iter().map(|s| (s.id, s.seq)).collect();
    let mut usage = Vec::new();
    for s in segments.iter().filter(|s| s.started_at >= since) {
        usage.push(PersonalAgentUsagePoint {
            at: s.started_at,
            percent: 0.0,
            kind: "segment_start".into(),
            segment_seq: s.seq,
        });
    }
    for b in svc::batches_since(&db.conn, bot, since).await? {
        let detail = b
            .detail
            .as_deref()
            .and_then(|d| serde_json::from_str::<serde_json::Value>(d).ok())
            .unwrap_or_default();
        let seq = seq_of.get(&b.segment_id).copied().unwrap_or(0);
        match b.kind {
            BatchKind::Delivery => {
                if let Some(p) = detail.get("usage_before").and_then(|v| v.as_f64()) {
                    usage.push(PersonalAgentUsagePoint {
                        at: b.started_at,
                        percent: p,
                        kind: "delivery".into(),
                        segment_seq: seq,
                    });
                }
            }
            BatchKind::Compaction => {
                if let Some(p) = detail.get("before").and_then(|v| v.as_f64().or_else(|| v.get("percent")?.as_f64())) {
                    usage.push(PersonalAgentUsagePoint {
                        at: b.started_at,
                        percent: p,
                        kind: "compaction_before".into(),
                        segment_seq: seq,
                    });
                }
                if let (Some(p), Some(at)) = (detail.get("after").and_then(|v| v.as_f64()), b.ended_at) {
                    usage.push(PersonalAgentUsagePoint {
                        at,
                        percent: p,
                        kind: "compaction_after".into(),
                        segment_seq: seq,
                    });
                }
            }
        }
    }
    usage.sort_by_key(|p| p.at);
    Ok(PersonalAgentStats {
        days: by_day.into_values().collect(),
        executors: executors.into_values().collect(),
        usage,
        tokens_synced_at,
    })
}

// ── actions (engine only) ───────────────────────────────────────────────────

pub async fn personal_agent_save_core(
    bot_id: Option<i32>,
    draft: PersonalAgentDraft,
) -> Result<PersonalAgentInfo, AppCommandError> {
    engine(bot_id).await?.save(draft).await.map_err(refused)
}

pub async fn personal_agent_send_core(
    bot_id: Option<i32>,
    text: String,
    blocks: Option<Vec<PromptInputBlock>>,
    reply_to: Option<i32>,
) -> Result<TimelineRow, AppCommandError> {
    engine(bot_id)
        .await?
        .send_owner_message(text, blocks.unwrap_or_default(), reply_to)
        .await
        .map_err(refused)
}

/// The conversation's [Stop]: the turn, and what it set going that nobody
/// started on yet (4.10).
pub async fn personal_agent_cancel_core(bot_id: Option<i32>) -> Result<(), AppCommandError> {
    engine(bot_id).await?.stop().await.map_err(refused)
}

/// "Stop everything": all the assistant has going.
pub async fn personal_agent_stop_all_core(bot_id: Option<i32>) -> Result<(), AppCommandError> {
    engine(bot_id).await?.stop_all().await.map_err(refused)
}

/// A thread between assistants, as one of them sees it: refused for a
/// thread the assistant is not on. Read-only, so a page anywhere reads it.
pub async fn personal_agent_thread_core(
    db: &AppDatabase,
    bot_id: Option<i32>,
    thread_id: i32,
) -> Result<crate::models::personal_agent::ThreadView, AppCommandError> {
    use crate::db::service::personal_agent_message_service as msvc;
    let bot = resolve_bot(db, bot_id).await?;
    let thread = msvc::get_thread(&db.conn, thread_id)
        .await?
        .ok_or_else(|| refused(format!("no thread t{thread_id}")))?;
    let messages = msvc::messages_of_thread(&db.conn, thread_id).await?;
    if !messages.iter().any(|m| m.from_bot_id == bot || m.to_bot_id == bot) {
        return Err(refused(format!("t{thread_id} is not this assistant's")));
    }
    let mut ids: Vec<i32> = messages
        .iter()
        .flat_map(|m| [m.from_bot_id, m.to_bot_id])
        .collect();
    ids.sort_unstable();
    ids.dedup();
    let mut bots = Vec::with_capacity(ids.len());
    for id in ids {
        if let Some(b) = svc::get_bot_any(&db.conn, id).await? {
            bots.push(crate::personal_agent::messages::bot_face(&b));
        }
    }
    let dispatches = svc::dispatches_of_thread(&db.conn, thread_id)
        .await?
        .into_iter()
        .map(|d| crate::models::personal_agent::ThreadDispatch {
            id: d.id,
            bot_id: d.bot_id,
            title: d.title,
            mode: d.mode,
            state: d.state,
            work_task_id: d.work_task_id,
            conversation_id: d.conversation_id,
            created_at: d.created_at,
        })
        .collect();
    Ok(crate::models::personal_agent::ThreadView {
        id: thread.id,
        state: thread.state,
        messages: messages
            .into_iter()
            .map(|m| crate::models::personal_agent::ThreadMessage {
                id: m.id,
                from_bot_id: m.from_bot_id,
                to_bot_id: m.to_bot_id,
                body: m.body,
                reply_to: m.reply_to,
                wants_reply: m.wants_reply,
                state: m.state,
                created_at: m.created_at,
            })
            .collect(),
        bots,
        dispatches,
    })
}

pub async fn personal_agent_compact_core(bot_id: Option<i32>) -> Result<(), AppCommandError> {
    engine(bot_id).await?.compact_now().await.map_err(refused)
}

pub async fn personal_agent_new_session_core(bot_id: Option<i32>) -> Result<(), AppCommandError> {
    engine(bot_id).await?.new_session().await.map_err(refused)
}

pub async fn personal_agent_resume_auto_compact_core(bot_id: Option<i32>) -> Result<(), AppCommandError> {
    engine(bot_id).await?.resume_auto_compact().await.map_err(refused)
}

pub async fn personal_agent_keepalive_core(bot_id: Option<i32>) -> Result<(), AppCommandError> {
    if let Some(e) = pa_engine::engine_for(bot_id).await {
        e.keepalive().await;
    }
    Ok(())
}

pub async fn personal_agent_resend_core(
    bot_id: Option<i32>,
    row_id: i32,
) -> Result<TimelineRow, AppCommandError> {
    engine(bot_id).await?.resend(row_id).await.map_err(refused)
}

/// The owner has seen the page up to row `up_to`. Not an act of the agent's,
/// so a read-only page marks too: straight in the database, where the
/// running process reads it at its next snapshot.
pub async fn personal_agent_mark_seen_core(
    db: &AppDatabase,
    bot_id: Option<i32>,
    up_to: i32,
) -> Result<(), AppCommandError> {
    match pa_engine::engine_for(bot_id).await {
        Some(e) => e.mark_seen(up_to).await.map_err(refused),
        None => {
            let bot = resolve_bot(db, bot_id).await?;
            svc::mark_seen(&db.conn, bot, up_to).await?;
            Ok(())
        }
    }
}

/// The owner's answer on a native card (`accept` / `dismiss`).
pub async fn personal_agent_notice_act_core(
    bot_id: Option<i32>,
    notice_id: i32,
    action: String,
) -> Result<TimelineRow, AppCommandError> {
    engine(bot_id)
        .await?
        .act_on_notice(notice_id, &action)
        .await
        .map_err(refused)
}

pub async fn personal_agent_answer_question_core(
    bot_id: Option<i32>,
    question_id: String,
    answer: crate::acp::question::QuestionAnswer,
) -> Result<(), AppCommandError> {
    engine(bot_id)
        .await?
        .answer_question(&question_id, answer)
        .await
        .map_err(refused)
}

pub async fn personal_agent_answer_plan_core(
    bot_id: Option<i32>,
    approval_id: String,
    answer: crate::acp::plan_approval::PlanApprovalAnswer,
) -> Result<(), AppCommandError> {
    engine(bot_id)
        .await?
        .answer_plan_approval(&approval_id, answer)
        .await
        .map_err(refused)
}

pub async fn personal_agent_respond_permission_core(
    bot_id: Option<i32>,
    request_id: String,
    option_id: String,
) -> Result<(), AppCommandError> {
    engine(bot_id)
        .await?
        .respond_permission(&request_id, &option_id)
        .await
        .map_err(refused)
}

pub async fn personal_agent_file_save_core(
    bot_id: Option<i32>,
    name: String,
    content: String,
) -> Result<(), AppCommandError> {
    engine(bot_id).await?.save_file(&name, &content).await.map_err(refused)
}

pub async fn personal_agent_file_delete_core(
    bot_id: Option<i32>,
    name: String,
) -> Result<(), AppCommandError> {
    engine(bot_id).await?.delete_file(&name).await.map_err(refused)
}

pub async fn personal_agent_set_workdir_core(
    bot_id: Option<i32>,
    path: Option<String>,
    locale: Option<String>,
) -> Result<PersonalAgentInfo, AppCommandError> {
    engine(bot_id)
        .await?
        .set_workdir(path, locale.as_deref())
        .await
        .map_err(refused)
}

// ── Tauri commands ──────────────────────────────────────────────────────────

#[cfg(feature = "tauri-runtime")]
fn data_dir_of(app: &tauri::AppHandle) -> Result<PathBuf, AppCommandError> {
    use tauri::Manager;
    app.path()
        .app_data_dir()
        .map(|p| crate::paths::resolve_effective_data_dir(&p))
        .map_err(|e| AppCommandError::io_error(e.to_string()))
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn personal_agent_get(
    app: tauri::AppHandle,
    db: State<'_, AppDatabase>,
    bot_id: Option<i32>,
) -> Result<PersonalAgentSnapshot, AppCommandError> {
    personal_agent_get_core(&db, &data_dir_of(&app)?, bot_id).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn personal_agent_timeline(
    db: State<'_, AppDatabase>,
    bot_id: Option<i32>,
    before_id: Option<i32>,
    limit: Option<u32>,
    since_id: Option<i32>,
) -> Result<TimelinePage, AppCommandError> {
    personal_agent_timeline_core(&db, bot_id, before_id, limit, since_id).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn personal_agent_timeline_rows(
    db: State<'_, AppDatabase>,
    bot_id: Option<i32>,
    ids: Vec<i32>,
) -> Result<Vec<TimelineRow>, AppCommandError> {
    personal_agent_timeline_rows_core(&db, bot_id, ids).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn personal_agent_timeline_updated_since(
    db: State<'_, AppDatabase>,
    bot_id: Option<i32>,
    since: Option<chrono::DateTime<Utc>>,
    after: Option<TimelineCursor>,
    min_id: Option<i32>,
) -> Result<TimelineChanges, AppCommandError> {
    personal_agent_timeline_updated_since_core(&db, bot_id, since, after, min_id).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn personal_agent_items(
    db: State<'_, AppDatabase>,
    bot_id: Option<i32>,
    status: Option<String>,
) -> Result<Vec<ItemInfo>, AppCommandError> {
    personal_agent_items_core(&db, bot_id, status).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn personal_agent_dispatches(
    db: State<'_, AppDatabase>,
    bot_id: Option<i32>,
    mode: Option<DispatchMode>,
    limit: Option<u32>,
    ids: Option<Vec<i32>>,
) -> Result<Vec<DispatchInfo>, AppCommandError> {
    personal_agent_dispatches_core(&db, bot_id, mode, limit, ids).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn personal_agent_files(
    app: tauri::AppHandle,
    db: State<'_, AppDatabase>,
    bot_id: Option<i32>,
) -> Result<Vec<PersonalAgentFile>, AppCommandError> {
    personal_agent_files_core(&db, &data_dir_of(&app)?, bot_id).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn personal_agent_stats(
    db: State<'_, AppDatabase>,
    bot_id: Option<i32>,
    days: Option<u32>,
) -> Result<PersonalAgentStats, AppCommandError> {
    personal_agent_stats_core(&db, bot_id, days).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn personal_agent_save(
    bot_id: Option<i32>,
    draft: PersonalAgentDraft,
) -> Result<PersonalAgentInfo, AppCommandError> {
    personal_agent_save_core(bot_id, draft).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn personal_agent_send(
    bot_id: Option<i32>,
    text: String,
    blocks: Option<Vec<PromptInputBlock>>,
    reply_to: Option<i32>,
) -> Result<TimelineRow, AppCommandError> {
    personal_agent_send_core(bot_id, text, blocks, reply_to).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn personal_agent_cancel(
    bot_id: Option<i32>,
) -> Result<(), AppCommandError> {
    personal_agent_cancel_core(bot_id).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn personal_agent_stop_all(
    bot_id: Option<i32>,
) -> Result<(), AppCommandError> {
    personal_agent_stop_all_core(bot_id).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn personal_agent_thread(
    db: State<'_, AppDatabase>,
    bot_id: Option<i32>,
    thread_id: i32,
) -> Result<crate::models::personal_agent::ThreadView, AppCommandError> {
    personal_agent_thread_core(&db, bot_id, thread_id).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn personal_agent_compact(
    bot_id: Option<i32>,
) -> Result<(), AppCommandError> {
    personal_agent_compact_core(bot_id).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn personal_agent_new_session(
    bot_id: Option<i32>,
) -> Result<(), AppCommandError> {
    personal_agent_new_session_core(bot_id).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn personal_agent_resume_auto_compact(
    bot_id: Option<i32>,
) -> Result<(), AppCommandError> {
    personal_agent_resume_auto_compact_core(bot_id).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn personal_agent_keepalive(
    bot_id: Option<i32>,
) -> Result<(), AppCommandError> {
    personal_agent_keepalive_core(bot_id).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn personal_agent_resend(
    bot_id: Option<i32>,
    row_id: i32,
) -> Result<TimelineRow, AppCommandError> {
    personal_agent_resend_core(bot_id, row_id).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn personal_agent_mark_seen(
    db: State<'_, AppDatabase>,
    bot_id: Option<i32>,
    up_to: i32,
) -> Result<(), AppCommandError> {
    personal_agent_mark_seen_core(&db, bot_id, up_to).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn personal_agent_notice_act(
    bot_id: Option<i32>,
    notice_id: i32,
    action: String,
) -> Result<TimelineRow, AppCommandError> {
    personal_agent_notice_act_core(bot_id, notice_id, action).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn personal_agent_answer_question(
    bot_id: Option<i32>,
    question_id: String,
    answer: crate::acp::question::QuestionAnswer,
) -> Result<(), AppCommandError> {
    personal_agent_answer_question_core(bot_id, question_id, answer).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn personal_agent_answer_plan(
    bot_id: Option<i32>,
    approval_id: String,
    answer: crate::acp::plan_approval::PlanApprovalAnswer,
) -> Result<(), AppCommandError> {
    personal_agent_answer_plan_core(bot_id, approval_id, answer).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn personal_agent_respond_permission(
    bot_id: Option<i32>,
    request_id: String,
    option_id: String,
) -> Result<(), AppCommandError> {
    personal_agent_respond_permission_core(bot_id, request_id, option_id).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn personal_agent_file_save(
    bot_id: Option<i32>,
    name: String,
    content: String,
) -> Result<(), AppCommandError> {
    personal_agent_file_save_core(bot_id, name, content).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn personal_agent_file_delete(
    bot_id: Option<i32>,
    name: String,
) -> Result<(), AppCommandError> {
    personal_agent_file_delete_core(bot_id, name).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn personal_agent_set_workdir(
    bot_id: Option<i32>,
    path: Option<String>,
    locale: Option<String>,
) -> Result<PersonalAgentInfo, AppCommandError> {
    personal_agent_set_workdir_core(bot_id, path, locale).await
}
