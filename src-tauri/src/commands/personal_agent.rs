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
        out.push(item_info(i, dispatch_state));
    }
    Ok(out)
}

fn item_info(
    i: crate::db::entities::personal_agent_item::Model,
    dispatch_state: Option<DispatchState>,
) -> ItemInfo {
    ItemInfo {
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
    }
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
    let tasks = crate::personal_agent::ladder::tasks_of(db, &rows).await;
    let ids: Vec<i32> = rows.iter().map(|d| d.id).collect();
    let answering = crate::personal_agent::asks::answering_dispatches(db, &ids).await;
    let answered = crate::personal_agent::asks::answered_for_owner(db, &ids).await;
    let mut out = Vec::with_capacity(rows.len());
    for d in rows {
        let task = d.work_task_id.and_then(|id| tasks.get(&id));
        let ladder = crate::personal_agent::ladder::for_owner(
            crate::personal_agent::ladder::ladder_of(&d, task),
            answering.contains(&d.id),
        );
        let answered_for_you = answered.get(&d.id).copied().unwrap_or(0);
        let task = task.map(crate::personal_agent::ladder::task_facts);
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
            ladder,
            answered_for_you,
            task,
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

/// The documents an assistant wrote in its working directory, newest
/// first (the panel's "Output").
pub async fn personal_agent_outputs_core(
    db: &AppDatabase,
    data_dir: &Path,
    bot_id: Option<i32>,
) -> Result<Vec<workdir::OutputDoc>, AppCommandError> {
    let bot = resolve_bot(db, bot_id).await?;
    let Some(row) = svc::get_bot(&db.conn, bot).await? else {
        return Ok(Vec::new());
    };
    let dir = workdir::workdir_of_bot(data_dir, &row);
    Ok(tokio::task::spawn_blocking(move || workdir::list_outputs(&dir))
        .await
        .unwrap_or_default())
}

/// One of those documents, as text.
pub async fn personal_agent_output_read_core(
    db: &AppDatabase,
    data_dir: &Path,
    bot_id: Option<i32>,
    path: String,
) -> Result<String, AppCommandError> {
    let bot = resolve_bot(db, bot_id).await?;
    let row = svc::get_bot(&db.conn, bot)
        .await?
        .ok_or_else(|| refused("no such assistant".into()))?;
    let dir = workdir::workdir_of_bot(data_dir, &row);
    let shown = path.clone();
    tokio::task::spawn_blocking(move || workdir::read_output(&dir, &path))
        .await
        .ok()
        .flatten()
        .ok_or_else(|| refused(format!("{shown} is not a document of this assistant that can be shown")))
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

/// The roster: the owner's assistants, primary first, each with how the
/// owner arranged it and its live state (8.3) — what the roster, the
/// settings' list of work assistants and the division read. Read-only; the
/// live states change on `personal-agent://bots`.
pub async fn personal_agent_bots_core(
    db: &AppDatabase,
) -> Result<Vec<crate::models::personal_agent_roster::RosterEntry>, AppCommandError> {
    use crate::personal_agent::live;
    let host = crate::personal_agent::host::host();
    let mut out = Vec::new();
    for row in svc::list_bots(&db.conn).await? {
        let state = match &host {
            Some(h) => h.live_of(&row).await,
            None => live::live_from_db(db, &row).await,
        };
        out.push(crate::models::personal_agent_roster::RosterEntry {
            bot: bot_summary(&row),
            roster: live::roster_flags(&row),
            live: state,
        });
    }
    Ok(out)
}

/// The owner arranges an assistant on the roster (4.14): pin, group, hide,
/// mute, mark unread, order the pinned ones, notifications on or off.
pub async fn personal_agent_roster_act_core(
    bot_id: i32,
    act: crate::models::personal_agent_roster::RosterAct,
) -> Result<(), AppCommandError> {
    let host = crate::personal_agent::host::host().ok_or_else(elsewhere)?;
    host.roster_act(bot_id, act).await.map_err(refused)
}

/// The steps the brain's turn in flight went through, one short line each
/// (the status line's list, 10.7). None when no turn runs here.
pub async fn personal_agent_turn_steps_core(
    db: &AppDatabase,
    bot_id: Option<i32>,
) -> Result<Vec<crate::models::personal_agent_roster::StepLine>, AppCommandError> {
    if let Some(id) = bot_id {
        resolve_bot(db, Some(id)).await?;
    }
    Ok(crate::personal_agent::live::turn_steps(db, bot_id).await)
}

/// The owner settles one of an assistant's open matters on the panel:
/// done, dropped, or later (it waits on time). Handed-out work ends with the
/// work itself.
pub async fn personal_agent_item_act_core(
    db: &AppDatabase,
    bot_id: Option<i32>,
    item_id: i32,
    act: String,
) -> Result<ItemInfo, AppCommandError> {
    let engine = engine(bot_id).await?;
    let item = engine.settle_item(item_id, &act).await.map_err(refused)?;
    let dispatch_state = match item.dispatch_id {
        Some(id) => svc::get_dispatch(&db.conn, id).await?.map(|d| d.state),
        None => None,
    };
    Ok(item_info(item, dispatch_state))
}

/// The owner's [Stop] on a task card (8.5, 4.10): this one piece of work,
/// where it runs. False when it is past stopping (done, merging).
pub async fn personal_agent_dispatch_stop_core(
    bot_id: Option<i32>,
    dispatch_id: i32,
) -> Result<bool, AppCommandError> {
    let engine = engine(bot_id).await?;
    engine.stop_one(dispatch_id).await.map_err(refused)
}

/// What the owner's answer on a question card came to (7.3.1).
#[derive(Debug, Clone, serde::Serialize)]
pub struct AskAnswerOutcome {
    /// `answered`, `already_answered`, `withdrawn`, `submitted`.
    pub state: String,
    pub text: String,
}

/// The owner answers an executor's question or plan approval on a card on
/// the assistants page — the card of the assistant answering it, or its
/// mirror. Through the same settle point as every answer: the first wins,
/// and a late one is told whose did.
pub async fn personal_agent_ask_answer_core(
    db: &AppDatabase,
    ask_id: i32,
    answer: Option<crate::acp::question::QuestionAnswer>,
    decision: Option<String>,
    feedback: Option<String>,
) -> Result<AskAnswerOutcome, AppCommandError> {
    use crate::personal_agent::asks::{plan_decision, AskAnswer, Answerer};
    let notice = svc::get_notice(&db.conn, ask_id)
        .await
        .map_err(|e| AppCommandError::database_error(e.to_string()))?
        .filter(|n| n.kind == crate::db::entities::personal_agent_notice::NoticeKind::Ask)
        .ok_or_else(|| refused(format!("no question card {ask_id}")))?;
    let engine = engine(notice.bot_id).await?;
    let answer = match (answer, decision) {
        (Some(a), None) => AskAnswer::Question(a),
        (None, Some(word)) => AskAnswer::Plan {
            decision: plan_decision(&word).map_err(refused)?,
            feedback: feedback
                .map(|f| f.trim().to_string())
                .filter(|f| !f.is_empty()),
        },
        _ => return Err(refused("give either the answers or a decision".into())),
    };
    let reply = engine
        .answer_ask(ask_id, answer, Answerer::OwnerPage, None)
        .await
        .map_err(refused)?;
    Ok(AskAnswerOutcome {
        state: reply.state.to_string(),
        text: reply.text,
    })
}

/// Where a conversation opens (a session link in a reply): its project and
/// agent. Any conversation of codeg's but an assistant's own brain session.
pub async fn personal_agent_conversation_target_core(
    db: &AppDatabase,
    conversation_id: i32,
) -> Result<crate::models::personal_agent::ConversationTarget, AppCommandError> {
    use crate::db::entities::conversation;
    use sea_orm::EntityTrait;
    let row = conversation::Entity::find_by_id(conversation_id)
        .one(&db.conn)
        .await
        .map_err(|e| AppCommandError::database_error(e.to_string()))?
        .filter(|c| c.deleted_at.is_none() && c.kind != conversation::ConversationKind::Personal)
        .ok_or_else(|| refused(format!("no conversation #{conversation_id}")))?;
    Ok(crate::models::personal_agent::ConversationTarget {
        conversation_id: row.id,
        folder_id: row.folder_id,
        agent_type: row.agent_type,
        title: row.title,
    })
}

fn bot_summary(
    b: &crate::db::entities::personal_agent::Model,
) -> crate::models::personal_agent::BotSummary {
    crate::models::personal_agent::BotSummary {
        id: b.id,
        kind: b.kind,
        uid: b.uid.clone(),
        name: b.name.clone(),
        avatar: serde_json::from_str(&b.avatar).unwrap_or_else(|_| {
            serde_json::from_str(r#"{"kind":"emoji","emoji":"🧭","color":"violet"}"#)
                .expect("the default avatar")
        }),
        template: b.template.clone(),
        executor_assistant_id: b.executor_assistant_id,
        created_at: b.created_at,
    }
}

/// How many of the latest finished dispatches to an executor config have
/// to have failed for it to be marked (10.5, 补齐四).
const FAILING_RUN: usize = 3;

/// Every live executor config as the assistants use it: what it runs now,
/// whether its last dispatches all failed, its last two weeks, the work
/// assistants bound to it, the kinds of work that name it first, and how
/// the assistants may use it. Read-only, across every assistant.
pub async fn personal_agent_executors_core(
    db: &AppDatabase,
) -> Result<Vec<crate::models::personal_agent::ExecutorView>, AppCommandError> {
    use crate::models::personal_agent::{ExecutorFailing, ExecutorView, ExecutorWork};
    use crate::models::personal_agent_prefs::AccountView;
    let assistants = crate::db::service::assistant_service::list_all(&db.conn).await?;
    let account = match svc::primary_bot(&db.conn).await? {
        Some(p) => AccountView::from_settings(&p.settings),
        None => AccountView::from_settings("{}"),
    };
    let bots = svc::list_bots(&db.conn).await?;
    let recent = svc::dispatches_to_executors(&db.conn, 5_000).await?;
    let since = Utc::now() - Duration::days(14);
    let live = [
        DispatchState::Queued,
        DispatchState::Running,
        DispatchState::WaitingInput,
        DispatchState::Review,
    ];
    let mut out = Vec::new();
    for a in assistants.into_iter().filter(|a| a.is_live()) {
        let mine: Vec<_> = recent
            .iter()
            .filter(|d| d.executor_assistant_id == a.id)
            .collect();
        let running = mine
            .iter()
            .filter(|d| live.contains(&d.state))
            .map(|d| ExecutorWork {
                dispatch_id: d.id,
                bot_id: d.bot_id,
                title: d.title.clone(),
                mode: d.mode,
                state: d.state,
                work_task_id: d.work_task_id,
                conversation_id: d.conversation_id,
            })
            .collect();
        // The latest ones that ended, newest first: all failed?
        let ended: Vec<_> = mine
            .iter()
            .filter(|d| {
                matches!(
                    d.state,
                    DispatchState::Completed | DispatchState::Failed | DispatchState::Canceled
                )
            })
            .take(FAILING_RUN)
            .collect();
        let failing = (ended.len() == FAILING_RUN
            && ended.iter().all(|d| d.state == DispatchState::Failed))
        .then(|| ExecutorFailing {
            dispatch_id: ended[0].id,
            bot_id: ended[0].bot_id,
            title: ended[0].title.clone(),
            error: ended[0].error.clone(),
            count: FAILING_RUN as u32,
        });
        let fortnight: Vec<_> = mine.iter().filter(|d| d.created_at >= since).collect();
        let division = account
            .team
            .division
            .iter()
            .filter(|(_, pick)| pick.as_str() == format!("assistant:{}", a.uid))
            .map(|(kind, _)| kind.clone())
            .collect();
        out.push(ExecutorView {
            assistant_id: a.id,
            uid: a.uid.clone(),
            running,
            failing,
            dispatches_14d: fortnight.len() as u32,
            completed_14d: fortnight
                .iter()
                .filter(|d| d.state == DispatchState::Completed)
                .count() as u32,
            workers: bots
                .iter()
                .filter(|b| b.executor_assistant_id == Some(a.id))
                .map(bot_summary)
                .collect(),
            division,
            usage: account.team.usage_of(&a.uid),
        });
    }
    Ok(out)
}

// ── actions (engine only) ───────────────────────────────────────────────────

/// Change settings item by item (13.1): the account's preferences and team
/// onto the primary's row, the assistant's own onto its row, each as a
/// merge patch — two windows changing different items both keep theirs.
/// Returns what changed, item by item.
pub async fn personal_agent_settings_patch_core(
    bot_id: Option<i32>,
    changes: Vec<crate::personal_agent::prefs::SettingChange>,
) -> Result<Vec<crate::personal_agent::prefs::Applied>, AppCommandError> {
    engine(bot_id)
        .await?
        .apply_settings(&changes)
        .await
        .map_err(refused)
}

pub async fn personal_agent_save_core(
    bot_id: Option<i32>,
    draft: PersonalAgentDraft,
) -> Result<PersonalAgentInfo, AppCommandError> {
    let engine = engine(bot_id).await?;
    let saved = engine.save(draft).await.map_err(refused)?;
    // The primary set up: the executor configs there were become work
    // assistants, if they have not yet (4.15) — before the save answers, so
    // the page that set it up finds them.
    if saved.kind == crate::db::entities::personal_agent::BotKind::Primary {
        let n = engine.make_workers_from_executors().await;
        if n > 0 {
            tracing::info!("[personal-agent] made {n} work assistants from the executor configs");
        }
    }
    Ok(saved)
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

// ── work assistants (4.12–4.15) ─────────────────────────────────────────────

/// The templates, in the owner's language (`locale`, the page's).
pub async fn personal_agent_templates_core(
    locale: Option<String>,
) -> Result<Vec<crate::models::personal_agent_bots::TemplateView>, AppCommandError> {
    let locale = crate::personal_agent::templates::template_locale(locale.as_deref().unwrap_or("en"));
    Ok(crate::personal_agent::bot_templates::views(locale))
}

/// A work assistant made from the page.
#[derive(Debug, Clone, serde::Serialize)]
pub struct BotMade {
    pub bot: Option<crate::models::personal_agent::BotSummary>,
    pub executor_assistant_id: Option<i32>,
    pub template: String,
    /// The agent's options could not be read: the page opens the executor
    /// config editor, prefilled with the template, and makes it again with
    /// the selection.
    pub options_unavailable: Option<OptionsUnavailable>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct OptionsUnavailable {
    pub agent_type: crate::models::AgentType,
    pub why: String,
}

fn made_answer(
    r: Result<crate::personal_agent::bots::Made, crate::personal_agent::bots::CreateError>,
) -> Result<BotMade, AppCommandError> {
    use crate::personal_agent::bots::CreateError;
    match r {
        Ok(m) => Ok(BotMade {
            bot: Some(bot_summary(&m.bot)),
            executor_assistant_id: Some(m.executor.id),
            template: m.template.to_string(),
            options_unavailable: None,
        }),
        Err(CreateError::OptionsUnavailable {
            agent_type,
            why,
            template,
        }) => Ok(BotMade {
            bot: None,
            executor_assistant_id: None,
            template: template.to_string(),
            options_unavailable: Some(OptionsUnavailable { agent_type, why }),
        }),
        Err(CreateError::Refused(e)) => Err(refused(e)),
    }
}

/// [+] with a name (4.12): made at once, with its executor config.
pub async fn personal_agent_bot_create_core(
    draft: crate::models::personal_agent_bots::BotCreateDraft,
) -> Result<BotMade, AppCommandError> {
    use crate::personal_agent::bots::{BotSpec, ExecutorSpec};
    let engine = engine(None).await?;
    let mut spec = BotSpec::named(draft.name);
    spec.uid = draft.uid;
    spec.template = draft.template;
    spec.avatar = draft.avatar;
    spec.locale = draft.locale;
    if let Some(id) = draft.executor_assistant_id {
        spec.executor = if draft.executor_made_for_it {
            ExecutorSpec::Adopt(id)
        } else {
            ExecutorSpec::Existing(id)
        };
    } else if let Some(config) = draft.executor_config {
        spec.executor = ExecutorSpec::Config(config);
    }
    made_answer(engine.create_bot(spec).await)
}

/// Copy a work assistant (4.14).
pub async fn personal_agent_bot_copy_core(
    bot_id: i32,
    name: String,
    locale: Option<String>,
) -> Result<BotMade, AppCommandError> {
    let engine = engine(None).await?;
    made_answer(engine.copy_bot(bot_id, &name, locale.as_deref()).await)
}

/// What deleting a work assistant touches, for the confirmation.
pub async fn personal_agent_bot_impact_core(
    bot_id: i32,
) -> Result<crate::models::personal_agent_bots::BotImpact, AppCommandError> {
    engine(None).await?.bot_impact(bot_id).await.map_err(refused)
}

/// Delete a work assistant (4.14).
pub async fn personal_agent_bot_delete_core(
    bot_id: i32,
    options: crate::models::personal_agent_bots::BotDeleteOptions,
) -> Result<(), AppCommandError> {
    let primary = engine(None).await?;
    let worker = match crate::personal_agent::host::host() {
        Some(h) => h.existing_worker(bot_id).await,
        None => None,
    };
    primary
        .delete_bot(bot_id, &options, worker)
        .await
        .map_err(refused)
}

/// [Change role] on a new work assistant's opening card.
pub async fn personal_agent_bot_set_template_core(
    bot_id: i32,
    template: String,
) -> Result<TimelineRow, AppCommandError> {
    engine(Some(bot_id))
        .await?
        .set_bot_template(&template)
        .await
        .map_err(refused)
}

/// An answer on a choice card: one of its choices (`key`, with
/// `project_id` when it asks for one) or the owner's own words (`text`).
pub async fn personal_agent_choice_answer_core(
    bot_id: Option<i32>,
    notice_id: i32,
    key: Option<String>,
    text: Option<String>,
    project_id: Option<i32>,
) -> Result<TimelineRow, AppCommandError> {
    engine(bot_id)
        .await?
        .answer_choice(notice_id, key.as_deref(), text.as_deref(), project_id)
        .await
        .map_err(refused)
}

// ── Tauri commands ──────────────────────────────────────────────────────────

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn personal_agent_bots(
    db: State<'_, AppDatabase>,
) -> Result<Vec<crate::models::personal_agent_roster::RosterEntry>, AppCommandError> {
    personal_agent_bots_core(&db).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn personal_agent_outputs(
    app: tauri::AppHandle,
    db: State<'_, AppDatabase>,
    bot_id: Option<i32>,
) -> Result<Vec<workdir::OutputDoc>, AppCommandError> {
    personal_agent_outputs_core(&db, &data_dir_of(&app)?, bot_id).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn personal_agent_output_read(
    app: tauri::AppHandle,
    db: State<'_, AppDatabase>,
    bot_id: Option<i32>,
    path: String,
) -> Result<String, AppCommandError> {
    personal_agent_output_read_core(&db, &data_dir_of(&app)?, bot_id, path).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn personal_agent_roster_act(
    bot_id: i32,
    act: crate::models::personal_agent_roster::RosterAct,
) -> Result<(), AppCommandError> {
    personal_agent_roster_act_core(bot_id, act).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn personal_agent_turn_steps(
    db: State<'_, AppDatabase>,
    bot_id: Option<i32>,
) -> Result<Vec<crate::models::personal_agent_roster::StepLine>, AppCommandError> {
    personal_agent_turn_steps_core(&db, bot_id).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn personal_agent_item_act(
    db: State<'_, AppDatabase>,
    bot_id: Option<i32>,
    item_id: i32,
    act: String,
) -> Result<ItemInfo, AppCommandError> {
    personal_agent_item_act_core(&db, bot_id, item_id, act).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn personal_agent_dispatch_stop(
    bot_id: Option<i32>,
    dispatch_id: i32,
) -> Result<bool, AppCommandError> {
    personal_agent_dispatch_stop_core(bot_id, dispatch_id).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn personal_agent_ask_answer(
    db: State<'_, AppDatabase>,
    ask_id: i32,
    answer: Option<crate::acp::question::QuestionAnswer>,
    decision: Option<String>,
    feedback: Option<String>,
) -> Result<AskAnswerOutcome, AppCommandError> {
    personal_agent_ask_answer_core(&db, ask_id, answer, decision, feedback).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn personal_agent_conversation_target(
    db: State<'_, AppDatabase>,
    conversation_id: i32,
) -> Result<crate::models::personal_agent::ConversationTarget, AppCommandError> {
    personal_agent_conversation_target_core(&db, conversation_id).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn personal_agent_executors(
    db: State<'_, AppDatabase>,
) -> Result<Vec<crate::models::personal_agent::ExecutorView>, AppCommandError> {
    personal_agent_executors_core(&db).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn personal_agent_settings_patch(
    bot_id: Option<i32>,
    changes: Vec<crate::personal_agent::prefs::SettingChange>,
) -> Result<Vec<crate::personal_agent::prefs::Applied>, AppCommandError> {
    personal_agent_settings_patch_core(bot_id, changes).await
}

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

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn personal_agent_templates(
    locale: Option<String>,
) -> Result<Vec<crate::models::personal_agent_bots::TemplateView>, AppCommandError> {
    personal_agent_templates_core(locale).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn personal_agent_bot_create(
    draft: crate::models::personal_agent_bots::BotCreateDraft,
) -> Result<BotMade, AppCommandError> {
    personal_agent_bot_create_core(draft).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn personal_agent_bot_copy(
    bot_id: i32,
    name: String,
    locale: Option<String>,
) -> Result<BotMade, AppCommandError> {
    personal_agent_bot_copy_core(bot_id, name, locale).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn personal_agent_bot_impact(
    bot_id: i32,
) -> Result<crate::models::personal_agent_bots::BotImpact, AppCommandError> {
    personal_agent_bot_impact_core(bot_id).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn personal_agent_bot_delete(
    bot_id: i32,
    options: crate::models::personal_agent_bots::BotDeleteOptions,
) -> Result<(), AppCommandError> {
    personal_agent_bot_delete_core(bot_id, options).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn personal_agent_bot_set_template(
    bot_id: i32,
    template: String,
) -> Result<TimelineRow, AppCommandError> {
    personal_agent_bot_set_template_core(bot_id, template).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn personal_agent_choice_answer(
    bot_id: Option<i32>,
    notice_id: i32,
    key: Option<String>,
    text: Option<String>,
    project_id: Option<i32>,
) -> Result<TimelineRow, AppCommandError> {
    personal_agent_choice_answer_core(bot_id, notice_id, key, text, project_id).await
}
