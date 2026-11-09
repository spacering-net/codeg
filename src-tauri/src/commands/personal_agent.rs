//! The personal agent's page: its configuration, timeline, composer actions,
//! ledger, dispatches, files and data.
//!
//! Reads work in every process from the database. Everything that acts goes
//! through the engine, which runs only in the process holding the work-task
//! engine; anywhere else the page is read-only and these return an error
//! saying so.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};
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

fn engine() -> Result<Arc<PersonalAgentEngine>, AppCommandError> {
    pa_engine::engine().ok_or_else(elsewhere)
}

fn refused(message: String) -> AppCommandError {
    AppCommandError::invalid_input(message)
}

fn workdir_for(row: &crate::db::entities::personal_agent::Model, data_dir: &Path) -> PathBuf {
    match row.workdir.as_deref() {
        Some(p) if !p.trim().is_empty() => PathBuf::from(p),
        _ => workdir::default_workdir(data_dir),
    }
}

// ── reads ───────────────────────────────────────────────────────────────────

pub async fn personal_agent_get_core(
    db: &AppDatabase,
    data_dir: &Path,
) -> Result<PersonalAgentSnapshot, AppCommandError> {
    Ok(pa_engine::snapshot_any(db, data_dir).await)
}

/// A page of the timeline (`before_id`, `limit`), or — with `since_id` — every
/// row from `since_id` up to `before_id`, which a jump to an older message
/// loads at once (none, `too_far`, when that is more than a range read
/// takes).
pub async fn personal_agent_timeline_core(
    db: &AppDatabase,
    before_id: Option<i32>,
    limit: Option<u32>,
    since_id: Option<i32>,
) -> Result<TimelinePage, AppCommandError> {
    if let Some(since) = since_id {
        let (rows, too_far) = svc::range(&db.conn, since, before_id).await?;
        let has_older = match rows.first() {
            Some(first) => svc::has_rows_before(&db.conn, first.id).await?,
            None => true,
        };
        return Ok(TimelinePage {
            rows: rows.into_iter().map(svc::to_row).collect(),
            has_older,
            too_far,
        });
    }
    let limit = limit.unwrap_or(60).clamp(1, 500) as u64;
    let (rows, has_older) = svc::page(&db.conn, before_id, limit).await?;
    Ok(TimelinePage {
        rows: rows.into_iter().map(svc::to_row).collect(),
        has_older,
        too_far: false,
    })
}

/// Rows by id (at most 100): a quote's preview, a jump too far to load.
pub async fn personal_agent_timeline_rows_core(
    db: &AppDatabase,
    ids: Vec<i32>,
) -> Result<Vec<TimelineRow>, AppCommandError> {
    Ok(svc::rows_by_ids(&db.conn, &ids)
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
    since: Option<chrono::DateTime<Utc>>,
    after: Option<TimelineCursor>,
    min_id: Option<i32>,
) -> Result<TimelineChanges, AppCommandError> {
    let (rows, next) = svc::changed_since(&db.conn, since, after, min_id.unwrap_or(0)).await?;
    Ok(TimelineChanges {
        rows: rows.into_iter().map(svc::to_row).collect(),
        next,
    })
}

pub async fn personal_agent_items_core(
    db: &AppDatabase,
    status: Option<String>,
) -> Result<Vec<ItemInfo>, AppCommandError> {
    let statuses = match status.as_deref() {
        None | Some("active") => vec![ItemStatus::Open, ItemStatus::Waiting],
        Some("all") => Vec::new(),
        Some("done") => vec![ItemStatus::Done, ItemStatus::Dropped],
        Some(other) => return Err(refused(format!("unknown item filter: {other}"))),
    };
    let items = svc::list_items(&db.conn, &statuses, 500).await?;
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
    mode: Option<DispatchMode>,
    limit: Option<u32>,
    ids: Option<Vec<i32>>,
) -> Result<Vec<DispatchInfo>, AppCommandError> {
    let rows = match ids {
        Some(ids) => svc::dispatches_by_ids(&db.conn, &ids).await?,
        None => {
            svc::list_dispatches(&db.conn, &[], mode, limit.unwrap_or(100).clamp(1, 500) as u64)
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
) -> Result<Vec<PersonalAgentFile>, AppCommandError> {
    let Some(row) = svc::get_agent(&db.conn).await? else {
        return Ok(Vec::new());
    };
    let dir = workdir_for(&row, data_dir);
    let mut out = Vec::new();
    for name in workdir::EDITABLE_FILES {
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
    days: Option<u32>,
) -> Result<PersonalAgentStats, AppCommandError> {
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
    for r in svc::rows_since(&db.conn, since).await? {
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
    let dispatches = svc::dispatches_since(&db.conn, since).await?;
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
    let segments = svc::list_segments(&db.conn).await?;
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
    for b in svc::batches_since(&db.conn, since).await? {
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
    draft: PersonalAgentDraft,
) -> Result<PersonalAgentInfo, AppCommandError> {
    engine()?.save(draft).await.map_err(refused)
}

pub async fn personal_agent_send_core(
    text: String,
    blocks: Option<Vec<PromptInputBlock>>,
    reply_to: Option<i32>,
) -> Result<TimelineRow, AppCommandError> {
    engine()?
        .send_owner_message(text, blocks.unwrap_or_default(), reply_to)
        .await
        .map_err(refused)
}

pub async fn personal_agent_cancel_core() -> Result<(), AppCommandError> {
    engine()?.cancel_turn().await.map_err(refused)
}

pub async fn personal_agent_compact_core() -> Result<(), AppCommandError> {
    engine()?.compact_now().await.map_err(refused)
}

pub async fn personal_agent_new_session_core() -> Result<(), AppCommandError> {
    engine()?.new_session().await.map_err(refused)
}

pub async fn personal_agent_resume_auto_compact_core() -> Result<(), AppCommandError> {
    engine()?.resume_auto_compact().await.map_err(refused)
}

pub async fn personal_agent_keepalive_core() -> Result<(), AppCommandError> {
    if let Some(e) = pa_engine::engine() {
        e.keepalive().await;
    }
    Ok(())
}

pub async fn personal_agent_resend_core(row_id: i32) -> Result<TimelineRow, AppCommandError> {
    engine()?.resend(row_id).await.map_err(refused)
}

/// The owner has seen the page up to row `up_to`. Not an act of the agent's,
/// so a read-only page marks too: straight in the database, where the
/// running process reads it at its next snapshot.
pub async fn personal_agent_mark_seen_core(
    db: &AppDatabase,
    up_to: i32,
) -> Result<(), AppCommandError> {
    match pa_engine::engine() {
        Some(e) => e.mark_seen(up_to).await.map_err(refused),
        None => {
            svc::mark_seen(&db.conn, up_to).await?;
            Ok(())
        }
    }
}

/// The owner's answer on a native card (`accept` / `dismiss`).
pub async fn personal_agent_notice_act_core(
    notice_id: i32,
    action: String,
) -> Result<TimelineRow, AppCommandError> {
    engine()?
        .act_on_notice(notice_id, &action)
        .await
        .map_err(refused)
}

pub async fn personal_agent_answer_question_core(
    question_id: String,
    answer: crate::acp::question::QuestionAnswer,
) -> Result<(), AppCommandError> {
    engine()?
        .answer_question(&question_id, answer)
        .await
        .map_err(refused)
}

pub async fn personal_agent_answer_plan_core(
    approval_id: String,
    answer: crate::acp::plan_approval::PlanApprovalAnswer,
) -> Result<(), AppCommandError> {
    engine()?
        .answer_plan_approval(&approval_id, answer)
        .await
        .map_err(refused)
}

pub async fn personal_agent_respond_permission_core(
    request_id: String,
    option_id: String,
) -> Result<(), AppCommandError> {
    engine()?
        .respond_permission(&request_id, &option_id)
        .await
        .map_err(refused)
}

pub async fn personal_agent_file_save_core(name: String, content: String) -> Result<(), AppCommandError> {
    engine()?.save_file(&name, &content).await.map_err(refused)
}

pub async fn personal_agent_file_delete_core(name: String) -> Result<(), AppCommandError> {
    engine()?.delete_file(&name).await.map_err(refused)
}

pub async fn personal_agent_set_workdir_core(
    path: Option<String>,
    locale: Option<String>,
) -> Result<PersonalAgentInfo, AppCommandError> {
    engine()?
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
) -> Result<PersonalAgentSnapshot, AppCommandError> {
    personal_agent_get_core(&db, &data_dir_of(&app)?).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn personal_agent_timeline(
    db: State<'_, AppDatabase>,
    before_id: Option<i32>,
    limit: Option<u32>,
    since_id: Option<i32>,
) -> Result<TimelinePage, AppCommandError> {
    personal_agent_timeline_core(&db, before_id, limit, since_id).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn personal_agent_timeline_rows(
    db: State<'_, AppDatabase>,
    ids: Vec<i32>,
) -> Result<Vec<TimelineRow>, AppCommandError> {
    personal_agent_timeline_rows_core(&db, ids).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn personal_agent_timeline_updated_since(
    db: State<'_, AppDatabase>,
    since: Option<chrono::DateTime<Utc>>,
    after: Option<TimelineCursor>,
    min_id: Option<i32>,
) -> Result<TimelineChanges, AppCommandError> {
    personal_agent_timeline_updated_since_core(&db, since, after, min_id).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn personal_agent_items(
    db: State<'_, AppDatabase>,
    status: Option<String>,
) -> Result<Vec<ItemInfo>, AppCommandError> {
    personal_agent_items_core(&db, status).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn personal_agent_dispatches(
    db: State<'_, AppDatabase>,
    mode: Option<DispatchMode>,
    limit: Option<u32>,
    ids: Option<Vec<i32>>,
) -> Result<Vec<DispatchInfo>, AppCommandError> {
    personal_agent_dispatches_core(&db, mode, limit, ids).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn personal_agent_files(
    app: tauri::AppHandle,
    db: State<'_, AppDatabase>,
) -> Result<Vec<PersonalAgentFile>, AppCommandError> {
    personal_agent_files_core(&db, &data_dir_of(&app)?).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn personal_agent_stats(
    db: State<'_, AppDatabase>,
    days: Option<u32>,
) -> Result<PersonalAgentStats, AppCommandError> {
    personal_agent_stats_core(&db, days).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn personal_agent_save(draft: PersonalAgentDraft) -> Result<PersonalAgentInfo, AppCommandError> {
    personal_agent_save_core(draft).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn personal_agent_send(
    text: String,
    blocks: Option<Vec<PromptInputBlock>>,
    reply_to: Option<i32>,
) -> Result<TimelineRow, AppCommandError> {
    personal_agent_send_core(text, blocks, reply_to).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn personal_agent_cancel() -> Result<(), AppCommandError> {
    personal_agent_cancel_core().await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn personal_agent_compact() -> Result<(), AppCommandError> {
    personal_agent_compact_core().await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn personal_agent_new_session() -> Result<(), AppCommandError> {
    personal_agent_new_session_core().await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn personal_agent_resume_auto_compact() -> Result<(), AppCommandError> {
    personal_agent_resume_auto_compact_core().await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn personal_agent_keepalive() -> Result<(), AppCommandError> {
    personal_agent_keepalive_core().await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn personal_agent_resend(row_id: i32) -> Result<TimelineRow, AppCommandError> {
    personal_agent_resend_core(row_id).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn personal_agent_mark_seen(
    db: State<'_, AppDatabase>,
    up_to: i32,
) -> Result<(), AppCommandError> {
    personal_agent_mark_seen_core(&db, up_to).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn personal_agent_notice_act(
    notice_id: i32,
    action: String,
) -> Result<TimelineRow, AppCommandError> {
    personal_agent_notice_act_core(notice_id, action).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn personal_agent_answer_question(
    question_id: String,
    answer: crate::acp::question::QuestionAnswer,
) -> Result<(), AppCommandError> {
    personal_agent_answer_question_core(question_id, answer).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn personal_agent_answer_plan(
    approval_id: String,
    answer: crate::acp::plan_approval::PlanApprovalAnswer,
) -> Result<(), AppCommandError> {
    personal_agent_answer_plan_core(approval_id, answer).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn personal_agent_respond_permission(
    request_id: String,
    option_id: String,
) -> Result<(), AppCommandError> {
    personal_agent_respond_permission_core(request_id, option_id).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn personal_agent_file_save(name: String, content: String) -> Result<(), AppCommandError> {
    personal_agent_file_save_core(name, content).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn personal_agent_file_delete(name: String) -> Result<(), AppCommandError> {
    personal_agent_file_delete_core(name).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn personal_agent_set_workdir(
    path: Option<String>,
    locale: Option<String>,
) -> Result<PersonalAgentInfo, AppCommandError> {
    personal_agent_set_workdir_core(path, locale).await
}
