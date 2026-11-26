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
    DispatchInfo, ItemActResult, ItemInfo, PersonalAgentDayStat, PersonalAgentDraft, PersonalAgentWorkStat,
    PersonalAgentFile, PersonalAgentInfo, PersonalAgentSnapshot, PersonalAgentStats,
    PersonalAgentUsagePoint, TimelineChanges, TimelineCursor, TimelinePage, TimelineRow,
};
use crate::personal_agent::engine::{self as pa_engine, PersonalAgentEngine};
use crate::personal_agent::read_check::OrFailed;
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

/// A refusal the page words in the owner's language when it can.
fn refusal(r: crate::personal_agent::refusal::Refusal) -> AppCommandError {
    let err = AppCommandError::invalid_input(r.message);
    match r.key {
        Some(key) => err.with_i18n(key, r.params),
        None => err,
    }
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
        out.push(item_info_now(db, i).await?);
    }
    Ok(out)
}

async fn item_peer(
    db: &AppDatabase,
    i: &crate::db::entities::personal_agent_item::Model,
) -> Option<serde_json::Value> {
    crate::personal_agent::today::item_peer(db, i).await
}

fn item_info(
    i: crate::db::entities::personal_agent_item::Model,
    dispatch_state: Option<DispatchState>,
    peer: Option<serde_json::Value>,
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
        due_at: i.due_at,
        repeat: i.repeat.as_deref().and_then(|r| serde_json::from_str(r).ok()),
        at_due: i.at_due,
        act_spec: i.act_spec.as_deref().and_then(|a| serde_json::from_str(a).ok()),
        fired_at: i.fired_at,
        mention: i.mention.as_deref().and_then(|m| serde_json::from_str(m).ok()),
        closed_at: i.closed_at,
        closed_by: i.closed_by,
        closed_how: i.closed_how,
        answer_row_id: i.answer_row_id,
        answer_state: i.answer_state,
        peer,
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
    dispatch_infos(db, rows).await
}

/// Dispatches as the page shows them: where each stands on the PR ladder,
/// its task, its folder, how often its assistant answered for the owner.
pub(crate) async fn dispatch_infos(
    db: &AppDatabase,
    rows: Vec<crate::db::entities::personal_agent_dispatch::Model>,
) -> Result<Vec<DispatchInfo>, AppCommandError> {
    let mut folder_names: HashMap<i32, Option<String>> = HashMap::new();
    let tasks = crate::personal_agent::ladder::tasks_of(db, &rows).await;
    // Their pull requests, as the watches read them (7.4).
    let prs = crate::personal_agent::watch::facts_of_tasks(
        db,
        &tasks.keys().copied().collect::<Vec<_>>(),
    )
    .await;
    let ids: Vec<i32> = rows.iter().map(|d| d.id).collect();
    let answering = crate::personal_agent::asks::answering_dispatches(db, &ids).await;
    let answered = crate::personal_agent::asks::answered_for_owner(db, &ids).await;
    // Acceptance (7.5): where each stands, its latest round, and the checks.
    let views = {
        let refs: Vec<&crate::db::entities::personal_agent_dispatch::Model> = rows.iter().collect();
        crate::personal_agent::acceptance::views_of(db, &refs, &tasks).await
    };
    let latest = crate::db::service::personal_agent_verification_service::latest_of(&db.conn, &ids)
        .await
        .or_failed();
    let checks = crate::db::service::personal_agent_verification_service::of_checks(&db.conn, &ids)
        .await
        .or_failed();
    // The routines whose runs handed them out (6.9).
    let routines =
        crate::db::service::personal_agent_routine_service::routines_of_dispatches(&db.conn, &ids)
            .await
            .or_failed();
    let mut out = Vec::with_capacity(rows.len());
    for d in rows {
        let task = d.work_task_id.and_then(|id| tasks.get(&id));
        let pr = d.work_task_id.and_then(|id| prs.get(&id)).cloned();
        let ladder = crate::personal_agent::acceptance::ladder_with(
            crate::personal_agent::watch::with_pr(
                crate::personal_agent::ladder::for_owner(
                    crate::personal_agent::ladder::ladder_of(&d, task),
                    answering.contains(&d.id),
                ),
                pr.as_ref(),
            ),
            views.get(&d.id).copied(),
        );
        let acceptance = latest
            .get(&d.id)
            .map(|r| crate::models::personal_agent::AcceptanceInfo {
                round_id: r.id,
                round: r.round,
                state: r.state,
                verdict: r.check_verdict,
                unchecked: r.unchecked,
                decided_by: r.decided_by,
                check_dispatch_id: r.check_dispatch_id,
                current: task.is_some_and(|t| t.run_seq == r.run_seq),
            });
        let check = checks.get(&d.id);
        let answered_for_you = answered.get(&d.id).copied().unwrap_or(0);
        // The board's next step for it, as "today" words it (A4).
        let next = match task {
            Some(t) if t.status == crate::db::entities::work_task::WorkTaskStatus::Review => {
                let gone = crate::personal_agent::today::worktree_gone(db, t).await;
                crate::personal_agent::today::task_reason(t, latest.get(&d.id), gone)
            }
            _ => None,
        };
        let task = task.map(|t| {
            let mut facts = crate::personal_agent::ladder::task_facts_with(t, pr);
            facts.next = next;
            facts
        });
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
            // One deleted has none.
            Some(cid) => crate::db::entities::conversation::Entity::find_by_id(cid)
                .filter(crate::db::entities::conversation::Column::DeletedAt.is_null())
                .one(&db.conn)
                .await
                .or_failed()
                .map(|c| c.folder_id),
            None => None,
        };
        out.push(DispatchInfo {
            id: d.id,
            mode: d.mode,
            work: crate::personal_agent::dispatch::work_of(&d),
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
            done_when: d.done_when,
            acceptance,
            check_for: check.map(|r| r.dispatch_id),
            check_round: check.map(|r| r.round),
            routine_id: routines.get(&d.id).copied(),
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
            off: false,
        });
    }
    // Then the entries the index lists, as `memory/<name>.md`.
    for (name, content) in workdir::list_entries(&dir) {
        out.push(PersonalAgentFile {
            name,
            content,
            exists: true,
            off: false,
        });
    }
    // Then its process skills, as `process-skills/<name>/SKILL.md` (7.8).
    let switches = crate::personal_agent::engine::skill_switches(&row);
    for (name, content) in workdir::list_skills(&dir) {
        // Off: not loaded now — turned off, or a version not approved.
        let turned_off =
            workdir::skill_name_of(&name).is_some_and(|n| !switches.loads(n, &content));
        out.push(PersonalAgentFile {
            name,
            content,
            exists: true,
            off: turned_off,
        });
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

/// The data tab: daily counts, the agents the work ran on, the context-usage
/// curve. Token
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
    let mut agents: BTreeMap<String, PersonalAgentWorkStat> = BTreeMap::new();
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
        let work = crate::personal_agent::dispatch::work_of(d);
        let e = agents
            .entry(work.agent_type.as_wire().into_owned())
            .or_insert_with(|| PersonalAgentWorkStat {
                agent_type: work.agent_type,
                name: crate::personal_agent::dispatch::agent_words(&work),
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
        agents: agents.into_values().collect(),
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
    data_dir: &Path,
) -> Result<Vec<crate::models::personal_agent_roster::RosterEntry>, AppCommandError> {
    use crate::personal_agent::{live, team};
    let host = crate::personal_agent::host::host();
    let mut out = Vec::new();
    for row in svc::list_bots(&db.conn).await? {
        let state = match &host {
            Some(h) => h.live_of(&row).await,
            None => live::live_from_db(db, &row).await,
        };
        // Its persona's head, as the team list has it.
        let soul = workdir::soul_text(data_dir, &row);
        out.push(crate::models::personal_agent_roster::RosterEntry {
            bot: bot_summary(&row),
            roster: live::roster_flags(&row),
            live: state,
            persona: team::persona_head(&soul, team::HEAD_CARD_CHARS),
            persona_unwritten: team::unwritten(row.kind, &soul),
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

/// The owner settles one of an assistant's open matters on the panel or a
/// card (`from`: `panel`, the default, or `card`): done, dropped, later (it
/// waits with no time), or snoozed `until` — `15m`, `1h`, `tomorrow`
/// (morning) or a time (6.1). Handed-out work ends with the work itself.
/// The panel's act comes with what takes it back (`undo`).
pub async fn personal_agent_item_act_core(
    db: &AppDatabase,
    bot_id: Option<i32>,
    item_id: i32,
    act: String,
    until: Option<String>,
    from: Option<String>,
) -> Result<ItemActResult, AppCommandError> {
    let engine = engine(bot_id).await?;
    let acted = engine
        .settle_item_from(
            item_id,
            &act,
            until.as_deref(),
            crate::personal_agent::reminders::OpSource::from_page(from.as_deref()),
        )
        .await
        .map_err(refusal)?;
    Ok(ItemActResult {
        item: item_info_now(db, acted.item).await?,
        undo: acted.undo,
        withdrawn: acted.withdrawn,
    })
}

/// The owner takes back what they just did to one of an assistant's
/// matters on the panel (`undo`, the token the act gave): within ten
/// minutes, and only while nothing changed since.
pub async fn personal_agent_item_undo_core(
    db: &AppDatabase,
    bot_id: Option<i32>,
    item_id: i32,
    undo: i32,
) -> Result<ItemInfo, AppCommandError> {
    let engine = engine(bot_id).await?;
    let item = engine.undo_item(item_id, undo).await.map_err(refusal)?;
    item_info_now(db, item).await
}

/// A matter as the page shows it, with its work's state as it is now.
async fn item_info_now(
    db: &AppDatabase,
    item: crate::db::entities::personal_agent_item::Model,
) -> Result<ItemInfo, AppCommandError> {
    let dispatch_state = match item.dispatch_id {
        Some(id) => svc::get_dispatch(&db.conn, id).await?.map(|d| d.state),
        None => None,
    };
    let peer = item_peer(db, &item).await;
    Ok(item_info(item, dispatch_state, peer))
}

/// One codeg window's beat (6.2, 1.12): whether it has the focus, and how
/// long since the last key or pointer input in it. Whether the owner is in
/// codeg after it. Every process takes it: it keeps its own windows, and
/// writes the minute to the record when the owner keeps one.
pub async fn personal_agent_presence_core(
    db: &AppDatabase,
    beat: crate::personal_agent::presence::Beat,
) -> crate::personal_agent::presence::Presence {
    crate::personal_agent::presence::beat(&db.conn, beat).await
}

/// "Today" (6.3, 1.14): what waits on the owner anywhere in codeg, what the
/// assistants keep an eye on, the rest of the day, and what was done today —
/// every assistant's, with the handed-out work the rows point at.
pub async fn personal_agent_today_core(
    db: &AppDatabase,
    manager: &crate::acp::manager::ConnectionManager,
) -> Result<crate::personal_agent::today::TodayView, AppCommandError> {
    let (mut view, rows) =
        crate::personal_agent::today::today(db, manager, crate::personal_agent::clock::now()).await;
    view.dispatches = dispatch_infos(db, rows).await?;
    Ok(view)
}

/// The activity tab's one list (C1): "today", the page assistant's open
/// matters and its routines, merged — read from one snapshot of the
/// database, and as a whole: a part that could not be read fails it all,
/// and the page keeps what it had, rather than showing that part empty.
pub async fn personal_agent_activity_core(
    db: &AppDatabase,
    manager: &crate::acp::manager::ConnectionManager,
    bot_id: Option<i32>,
) -> Result<crate::personal_agent::activity_view::ActivityView, AppCommandError> {
    use crate::personal_agent::read_check::{checked, Snapshot};
    let snap = Snapshot::of(db)
        .await
        .map_err(AppCommandError::task_execution_failed)?;
    let (out, failed) = checked(activity_in(snap.db(), manager, bot_id)).await;
    snap.finish().await;
    match failed {
        Some(e) => Err(AppCommandError::task_execution_failed(format!(
            "the activity could not be read whole: {e}"
        ))),
        None => out,
    }
}

async fn activity_in(
    db: &AppDatabase,
    manager: &crate::acp::manager::ConnectionManager,
    bot_id: Option<i32>,
) -> Result<crate::personal_agent::activity_view::ActivityView, AppCommandError> {
    use crate::db::entities::personal_agent_item::WaitsFor;
    use crate::db::entities::personal_agent_notice::NoticeState;
    use crate::personal_agent::activity_view::{merge, Inputs, ItemCard};
    let bot = resolve_bot(db, bot_id).await?;
    let primary = svc::get_bot(&db.conn, bot)
        .await?
        .is_some_and(|b| b.kind == crate::db::entities::personal_agent::BotKind::Primary);
    let now = crate::personal_agent::clock::now();
    let (mut today, mut rows) = crate::personal_agent::today::today_from(db, manager, now, None).await;
    // Its open matters, all of them, as they are now — none another's work
    // took over (B1); on the primary's page, every assistant's, as "today"
    // has.
    let page_bots: Vec<i32> = if primary {
        svc::list_bots(&db.conn).await?.into_iter().map(|b| b.id).collect()
    } else {
        vec![bot]
    };
    // And those settled today, with who did it and how (§3.7).
    today.done.extend(
        crate::personal_agent::today::closed_matters(db, &page_bots, today.day_start, now).await,
    );
    today.done.sort_by_key(|r| std::cmp::Reverse(r.at));
    let mut open = Vec::new();
    for &b in &page_bots {
        open.extend(
            svc::list_items(&db.conn, b, &[ItemStatus::Open, ItemStatus::Waiting], i64::MAX as u64)
                .await?,
        );
    }
    let mut items = Vec::new();
    let mut item_bots = HashMap::new();
    let mut item_tasks = HashMap::new();
    let mut item_cards = HashMap::new();
    for i in open {
        let dispatch = match i.dispatch_id {
            Some(id) => svc::get_dispatch(&db.conn, id).await?,
            None => None,
        };
        if let Some(d) = &dispatch {
            if crate::personal_agent::dispatch::superseded(db, d).await {
                continue;
            }
            if let Some(t) = d.work_task_id {
                item_tasks.insert(d.id, t);
            }
            if !rows.iter().any(|r| r.id == d.id) {
                rows.push(d.clone());
            }
        }
        // Fired and still on this firing: its card.
        let fired = i.due_at.is_some_and(|due| i.fired_at.is_some_and(|f| f >= due))
            && matches!(i.waits_for, Some(WaitsFor::Owner | WaitsFor::Agent));
        if fired {
            if let Some((notice, card)) = crate::personal_agent::today::reminder_card(db, &i).await {
                let state = card
                    .data
                    .as_deref()
                    .and_then(|d| serde_json::from_str::<serde_json::Value>(d).ok())
                    .and_then(|d| d["state"].as_str().map(str::to_string));
                item_cards.insert(
                    i.id,
                    ItemCard {
                        row_id: card.id,
                        notice_id: notice.id,
                        open: notice.state == NoticeState::Open && state.as_deref() == Some("open"),
                        handed: state.as_deref() == Some("handed"),
                    },
                );
            }
        }
        item_bots.insert(i.id, i.bot_id.unwrap_or(bot));
        let peer = item_peer(db, &i).await;
        items.push(item_info(i, dispatch.map(|d| d.state), peer));
    }
    let routines = crate::personal_agent::routines::routines_of(db, Some(bot))
        .await
        .map_err(AppCommandError::task_execution_failed)?;
    let mut view = merge(Inputs {
        bot,
        primary,
        today,
        items,
        item_bots,
        item_tasks,
        item_cards,
        routines,
        as_of: now,
    });
    view.dispatches = dispatch_infos(db, rows).await?;
    Ok(view)
}

/// codeg's general notification switch and "hide contents", from the page
/// (1.13): the desktop posts the assistants' notifications under them.
pub async fn notification_prefs_sync_core(
    db: &AppDatabase,
    enabled: bool,
    hide_body: bool,
) -> Result<(), AppCommandError> {
    crate::personal_agent::reach::set_gate(
        &db.conn,
        crate::personal_agent::reach::Gate { enabled, hide_body },
    )
    .await
    .map_err(AppCommandError::task_execution_failed)
}

/// An assistant's face, drawn by the page: `png` for the system
/// notifications the desktop posts under its name (1.13), `tray` the strip
/// of frames the menu bar shows (10.10). One not given is removed: the
/// avatar has no such picture now (an emoji has no notification icon).
/// Only where the assistants run.
pub async fn personal_agent_avatar_png_core(
    db: &AppDatabase,
    bot_id: i32,
    png: Option<String>,
    tray: Option<String>,
) -> Result<(), AppCommandError> {
    use base64::Engine as _;
    let Some(host) = crate::personal_agent::host::host() else {
        return Ok(());
    };
    let decode = |b64: Option<String>| -> Result<Option<Vec<u8>>, AppCommandError> {
        let Some(b64) = b64 else {
            return Ok(None);
        };
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(b64.trim().as_bytes())
            .map_err(|e| AppCommandError::invalid_input(format!("not base64: {e}")))?;
        if bytes.len() > crate::personal_agent::reach::AVATAR_MAX_BYTES
            || !bytes.starts_with(b"\x89PNG\r\n\x1a\n")
        {
            return Err(AppCommandError::invalid_input(
                "not a PNG of at most 256 KB",
            ));
        }
        Ok(Some(bytes))
    };
    let png = decode(png)?;
    let tray = decode(tray)?;
    if tray
        .as_deref()
        .is_some_and(|b| crate::personal_agent::menubar::frames_of(b).is_none())
    {
        return Err(AppCommandError::invalid_input(
            "the tray's picture is a strip of at most 8 square frames",
        ));
    }
    if svc::get_bot(&db.conn, bot_id)
        .await
        .ok()
        .flatten()
        .is_none()
    {
        return Err(AppCommandError::not_found("no such assistant"));
    }
    let tray_path = crate::personal_agent::menubar::tray_png(host.data_dir(), bot_id);
    for (path, bytes) in [(host.avatar_png(bot_id), png), (tray_path, tray)] {
        let write = || -> std::io::Result<()> {
            match &bytes {
                Some(bytes) => {
                    if let Some(dir) = path.parent() {
                        std::fs::create_dir_all(dir)?;
                    }
                    let tmp = path.with_extension("png.tmp");
                    std::fs::write(&tmp, bytes)?;
                    std::fs::rename(&tmp, &path)
                }
                None => match std::fs::remove_file(&path) {
                    Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e),
                    _ => Ok(()),
                },
            }
        };
        write().map_err(|e| AppCommandError::task_execution_failed(e.to_string()))?;
    }
    host.menubar_pictures();
    Ok(())
}

/// The "about you" page (13.5, 1.12): the owner's time zone, the record's
/// switch, whether they are in codeg, and the hours codeg sees.
pub async fn personal_agent_profile_core(
    db: &AppDatabase,
) -> crate::personal_agent::presence::ProfileView {
    crate::personal_agent::presence::profile(db).await
}

/// A change the owner makes on the "about you" page (5.3, 2.11).
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum ProfileOp {
    /// Their hours of a kind of day (`workday`, `restday`): `start` and
    /// `end` as `HH:MM`; neither, back to what codeg learns.
    Hours {
        day: String,
        #[serde(default)]
        start: Option<String>,
        #[serde(default)]
        end: Option<String>,
    },
    /// A project codeg is (not) to mind.
    Project { folder_id: i32, excluded: bool },
    /// Forget what codeg learned of them.
    Clear,
}

/// The owner changes their profile: their hours, a project not to mind,
/// or clearing what codeg learned. Returns the page anew.
pub async fn personal_agent_profile_update_core(
    db: &AppDatabase,
    op: ProfileOp,
) -> Result<crate::personal_agent::presence::ProfileView, AppCommandError> {
    use crate::personal_agent::profile;
    match op {
        ProfileOp::Hours { day, start, end } => {
            let span = match (start.as_deref(), end.as_deref()) {
                (Some(s), Some(e)) => {
                    Some(profile::span_of(s, e).map_err(AppCommandError::invalid_input)?)
                }
                (None, None) => None,
                _ => {
                    return Err(AppCommandError::invalid_input(
                        "give both the start and the end, or neither",
                    ))
                }
            };
            profile::set_hours(db, &day, span)
                .await
                .map_err(AppCommandError::invalid_input)?;
        }
        ProfileOp::Project {
            folder_id,
            excluded,
        } => {
            profile::set_excluded(db, folder_id, excluded)
                .await
                .map_err(AppCommandError::invalid_input)?;
        }
        ProfileOp::Clear => {
            profile::clear(db)
                .await
                .map_err(AppCommandError::invalid_input)?;
        }
    }
    Ok(personal_agent_profile_core(db).await)
}

/// Each assistant's grade (2.11): how its work went over the last 30 days
/// — and apart, by who handed it out, the agent it ran on and how (7.9).
#[derive(Debug, Clone, serde::Serialize)]
pub struct GradesView {
    pub bots: HashMap<i32, crate::personal_agent::profile::Grade>,
    pub cells: Vec<crate::personal_agent::profile::GradeCell>,
}

pub async fn personal_agent_grades_core(db: &AppDatabase) -> GradesView {
    use crate::personal_agent::profile;
    let work = profile::graded_recent(db, crate::personal_agent::clock::now()).await;
    GradesView {
        bots: profile::grades_of(&work),
        cells: profile::cells(&work),
    }
}

/// The page's search (8.2): what the time machine finds for `query`, as
/// `history_search` finds it. Where this process keeps the index the
/// sources are caught up first; elsewhere the index is read as it is.
pub async fn personal_agent_history_search_core(
    db: &AppDatabase,
    query: String,
    scope: Option<String>,
    since: Option<String>,
    project_id: Option<i32>,
    limit: Option<u32>,
) -> Result<crate::personal_agent::history::Results, AppCommandError> {
    use crate::personal_agent::history as h;
    let scope = match scope.as_deref() {
        None => h::Scope::All,
        Some(s) => h::Scope::parse(s).ok_or_else(|| {
            AppCommandError::invalid_input("scope is all, timeline, sessions, tasks or messages")
        })?,
    };
    let prefs = crate::personal_agent::history::prefs_of(db).await;
    let tz = crate::personal_agent::clock::zone_of(&prefs.time_zone);
    let since = h::since_of(
        since.as_deref().unwrap_or(""),
        tz,
        crate::personal_agent::clock::now(),
    )
    .map_err(AppCommandError::invalid_input)?;
    let q = h::Query {
        text: query,
        scope,
        since,
        project: project_id,
        limit: limit.unwrap_or(30) as usize,
        skip_rows: Vec::new(),
    };
    let host = crate::personal_agent::host::host();
    h::search(db, host.as_ref().map(|h| &h.history), &q)
        .await
        .map_err(AppCommandError::invalid_input)
}

/// How far the time machine's index is (About you).
pub async fn personal_agent_history_status_core(
    db: &AppDatabase,
) -> crate::personal_agent::history::HistoryStatus {
    let host = crate::personal_agent::host::host();
    crate::personal_agent::history::status(db, host.as_ref().map(|h| &h.history)).await
}

/// The owner's [Rebuild] (About you): the index from nothing, at once.
pub async fn personal_agent_history_rebuild_core(
    db: &AppDatabase,
) -> Result<crate::personal_agent::history::HistoryStatus, AppCommandError> {
    let host = crate::personal_agent::host::host()
        .ok_or_else(|| AppCommandError::invalid_input("the assistants run in another process"))?;
    host.history_rebuild();
    Ok(personal_agent_history_status_core(db).await)
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

/// The owner answers a question or plan approval of a piece of work on a card on
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
        hidden: b.hidden,
        has_brain: b.agent_type.is_some(),
        legacy_assistant_id: b.legacy_assistant_id,
        work_agent_type: crate::models::AgentType::from_wire(&b.work_agent_type),
        created_at: b.created_at,
    }
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
    // Set up just now: what to call each other comes first (5.4).
    if saved.kind == crate::db::entities::personal_agent::BotKind::Primary {
        engine.meet_after_save().await;
    }
    Ok(saved)
}

pub async fn personal_agent_send_core(
    bot_id: Option<i32>,
    text: String,
    blocks: Option<Vec<PromptInputBlock>>,
    reply_to: Option<i32>,
    card: Option<crate::personal_agent::card_acts::CardClick>,
    answers_item: Option<i32>,
) -> Result<TimelineRow, AppCommandError> {
    let engine = engine(bot_id).await?;
    // From a button on one of the assistant's cards (9.2): it quotes that
    // card, and the card keeps the press.
    if let Some(card) = card {
        if answers_item.is_some() {
            return Err(refused("a button's message answers no question".to_string()));
        }
        let Some(row_id) = reply_to else {
            return Err(refused("a button's message quotes its card".to_string()));
        };
        if blocks.is_some_and(|b| !b.is_empty()) {
            return Err(refused("a button's message carries no attachments".to_string()));
        }
        return engine
            .send_card_reply(text, row_id, card)
            .await
            .map_err(refused);
    }
    engine
        .send_from_page(text, blocks.unwrap_or_default(), reply_to, answers_item)
        .await
        .map_err(refusal)
}

/// The owner pressed a button on one of the assistant's cards that acts
/// without a message (9.2): the card keeps it.
pub async fn personal_agent_card_act_core(
    bot_id: Option<i32>,
    row_id: i32,
    element: String,
    action: String,
    label: Option<String>,
    op: Option<String>,
) -> Result<TimelineRow, AppCommandError> {
    engine(bot_id)
        .await?
        .card_act(
            row_id,
            crate::personal_agent::card_acts::CardAct {
                element,
                action,
                label,
                op,
            },
        )
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
    let mut dispatches = Vec::new();
    for d in svc::dispatches_of_thread(&db.conn, thread_id).await? {
        let conversation_folder_id = match d.conversation_id {
            Some(cid) => crate::db::service::conversation_service::get_by_id(&db.conn, cid)
                .await
                .ok()
                .map(|c| c.folder_id),
            None => None,
        };
        dispatches.push(crate::models::personal_agent::ThreadDispatch {
            id: d.id,
            bot_id: d.bot_id,
            agent_type: crate::personal_agent::dispatch::work_of(&d).agent_type,
            title: d.title,
            mode: d.mode,
            state: d.state,
            work_task_id: d.work_task_id,
            conversation_id: d.conversation_id,
            conversation_folder_id,
            created_at: d.created_at,
        });
    }
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

// ── routines (6.9) ──────────────────────────────────────────────────────────

/// An assistant's routines (the primary's when `bot_id` is left out), with
/// their latest runs — read from the record, wherever the assistants run.
pub async fn personal_agent_routines_core(
    db: &AppDatabase,
    bot_id: Option<i32>,
) -> Result<Vec<crate::personal_agent::routines::RoutineView>, AppCommandError> {
    let bot = resolve_bot(db, bot_id).await?;
    crate::personal_agent::routines::routines_of(db, Some(bot))
        .await
        .map_err(AppCommandError::task_execution_failed)
}

/// A routine's runs, newest first.
pub async fn personal_agent_routine_runs_core(
    db: &AppDatabase,
    routine_id: i32,
    limit: Option<u64>,
) -> Result<Vec<crate::personal_agent::routines::RunView>, AppCommandError> {
    crate::personal_agent::routines::runs_of(db, routine_id, limit.unwrap_or(30))
        .await
        .map_err(AppCommandError::task_execution_failed)
}

/// The owner saved a routine in the editor: made (and run once as a test)
/// or changed. `notice_id`: the card it came from, settled with it.
pub async fn personal_agent_routine_save_core(
    bot_id: Option<i32>,
    routine_id: Option<i32>,
    draft: crate::personal_agent::routines::Draft,
    notice_id: Option<i32>,
) -> Result<crate::personal_agent::routines::RoutineView, AppCommandError> {
    engine(bot_id)
        .await?
        .routine_save(routine_id, draft, notice_id)
        .await
        .map_err(refused)
}

/// The owner's buttons on a routine: `run_now`, `pause`, `resume`,
/// `delete`.
pub async fn personal_agent_routine_act_core(
    bot_id: Option<i32>,
    routine_id: i32,
    action: String,
) -> Result<crate::personal_agent::routines::RoutineView, AppCommandError> {
    engine(bot_id)
        .await?
        .routine_act(routine_id, &action)
        .await
        .map_err(refused)
}

/// codeg's proposal rules (6.7) as the preferences show them: muted from a
/// card, lowered after the owner kept dismissing their cards, and how their
/// cards fared in the last 30 days. Their switches and thresholds are
/// preferences.
pub async fn personal_agent_rules_core(
    db: &AppDatabase,
) -> Result<Vec<crate::personal_agent::rules::RuleView>, AppCommandError> {
    Ok(crate::personal_agent::rules::rule_views(db).await)
}

/// Put a rule codeg lowered back where it was (6.7, 5.2).
pub async fn personal_agent_rule_reset_core(
    db: &AppDatabase,
    rule: String,
) -> Result<Vec<crate::personal_agent::rules::RuleView>, AppCommandError> {
    crate::personal_agent::rules::reset_rule(db, &rule)
        .await
        .map_err(refused)?;
    Ok(crate::personal_agent::rules::rule_views(db).await)
}

/// The owner's answer on a native card (`accept` / `dismiss`).
pub async fn personal_agent_notice_act_core(
    bot_id: Option<i32>,
    notice_id: i32,
    action: String,
    text: Option<String>,
) -> Result<TimelineRow, AppCommandError> {
    engine(bot_id)
        .await?
        .act_on_notice_worded(notice_id, &action, text)
        .await
        .map_err(refusal)
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

/// Turn one of an assistant's process skills on or off (7.8).
pub async fn personal_agent_skill_switch_core(
    bot_id: Option<i32>,
    name: String,
    on: bool,
) -> Result<(), AppCommandError> {
    engine(bot_id)
        .await?
        .switch_skill(&name, on)
        .await
        .map_err(refused)
}

/// "Is this right?" (10.3): the owner has a message of an ordinary
/// conversation checked — its last check, or a new one through the primary.
pub async fn personal_agent_check_message_core(
    request: crate::models::personal_agent::MessageCheckRequest,
) -> Result<crate::models::personal_agent::MessageCheckView, AppCommandError> {
    engine(None)
        .await?
        .check_message(request)
        .await
        .map_err(refused)
}

/// The latest check of each message of a conversation (10.3). Read-only, so
/// a page anywhere reads it.
pub async fn personal_agent_checks_core(
    db: &AppDatabase,
    conversation_id: i32,
) -> Result<Vec<crate::models::personal_agent::MessageCheckView>, AppCommandError> {
    let checks = crate::db::service::personal_agent_check_service::latest_of_conversation(
        &db.conn,
        conversation_id,
    )
    .await?;
    Ok(crate::personal_agent::fact_check::check_views(db, checks).await)
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

/// A work assistant made from the page.
#[derive(Debug, Clone, serde::Serialize)]
pub struct BotMade {
    pub bot: Option<crate::models::personal_agent::BotSummary>,
    /// The agent's options could not be read (options left to codeg to
    /// fill in): the page opens the editor and makes it again with the
    /// selection.
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
            options_unavailable: None,
        }),
        Err(CreateError::OptionsUnavailable { agent_type, why }) => Ok(BotMade {
            bot: None,
            options_unavailable: Some(OptionsUnavailable { agent_type, why }),
        }),
        Err(CreateError::Refused(e)) => Err(refused(e)),
    }
}

/// [+] with a name (4.12): made at once, its work on a copy of its brain or
/// on the agent picked (D1).
pub async fn personal_agent_bot_create_core(
    draft: crate::models::personal_agent_bots::BotCreateDraft,
) -> Result<BotMade, AppCommandError> {
    use crate::models::personal_agent::WorkChoice;
    use crate::personal_agent::bots::{BotSpec, WorkSpec};
    let engine = engine(None).await?;
    let mut spec = BotSpec::named(draft.name);
    spec.uid = draft.uid;
    // What the owner wrote in the dialog is what it introduces itself on.
    spec.intro.words = draft.persona.clone();
    spec.persona = draft.persona;
    spec.avatar = draft.avatar;
    spec.locale = draft.locale;
    spec.work = match draft.work {
        Some(WorkChoice::Config { config }) => WorkSpec::Config(config),
        Some(WorkChoice::SameAsBrain) | None => WorkSpec::SameAsBrain,
    };
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

/// An answer on a choice card: one of its choices (`key`, with
/// `project_id` when it asks for one) or the owner's own words (`text`).
pub async fn personal_agent_choice_answer_core(
    bot_id: Option<i32>,
    notice_id: i32,
    key: Option<String>,
    text: Option<String>,
    project_id: Option<i32>,
    answers: Option<Vec<crate::personal_agent::meet::ChoicePick>>,
) -> Result<TimelineRow, AppCommandError> {
    engine(bot_id)
        .await?
        .answer_choice(
            notice_id,
            key.as_deref(),
            text.as_deref(),
            project_id,
            answers.as_deref(),
        )
        .await
        .map_err(refused)
}

/// The projects the assistants may keep an eye on (`prefs.projects`, 5.4):
/// each open project and its forge as this machine knows it — nothing
/// asked of a forge.
pub async fn personal_agent_meet_projects_core(
    db: &AppDatabase,
) -> Result<Vec<crate::personal_agent::projects::ProjectView>, AppCommandError> {
    Ok(crate::personal_agent::projects::project_views(db).await)
}

/// "One thing at once" (5.4): the owner said [Find one] — codeg looks in
/// the projects watched for a first thing to help with.
pub async fn personal_agent_starter_core(
    bot_id: Option<i32>,
    notice_id: i32,
) -> Result<TimelineRow, AppCommandError> {
    engine(bot_id)
        .await?
        .meet_go(notice_id)
        .await
        .map_err(refused)
}

// ── Tauri commands ──────────────────────────────────────────────────────────

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn personal_agent_bots(
    app: tauri::AppHandle,
    db: State<'_, AppDatabase>,
) -> Result<Vec<crate::models::personal_agent_roster::RosterEntry>, AppCommandError> {
    personal_agent_bots_core(&db, &data_dir_of(&app)?).await
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
    until: Option<String>,
    from: Option<String>,
) -> Result<ItemActResult, AppCommandError> {
    personal_agent_item_act_core(&db, bot_id, item_id, act, until, from).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn personal_agent_item_undo(
    db: State<'_, AppDatabase>,
    bot_id: Option<i32>,
    item_id: i32,
    undo: i32,
) -> Result<ItemInfo, AppCommandError> {
    personal_agent_item_undo_core(&db, bot_id, item_id, undo).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn personal_agent_presence(
    db: State<'_, AppDatabase>,
    window: String,
    focused: bool,
    idle_ms: Option<u64>,
    typed_ms: Option<u64>,
    viewing: Option<i32>,
    viewing_conversation: Option<i32>,
) -> Result<crate::personal_agent::presence::Presence, AppCommandError> {
    Ok(personal_agent_presence_core(
        &db,
        crate::personal_agent::presence::Beat {
            window,
            focused,
            idle_ms,
            typed_ms,
            viewing,
            viewing_conversation,
        },
    )
    .await)
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn personal_agent_profile(
    db: State<'_, AppDatabase>,
) -> Result<crate::personal_agent::presence::ProfileView, AppCommandError> {
    Ok(personal_agent_profile_core(&db).await)
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn personal_agent_profile_update(
    db: State<'_, AppDatabase>,
    op: ProfileOp,
) -> Result<crate::personal_agent::presence::ProfileView, AppCommandError> {
    personal_agent_profile_update_core(&db, op).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn personal_agent_grades(
    db: State<'_, AppDatabase>,
) -> Result<GradesView, AppCommandError> {
    Ok(personal_agent_grades_core(&db).await)
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn personal_agent_history_search(
    db: State<'_, AppDatabase>,
    query: String,
    scope: Option<String>,
    since: Option<String>,
    project_id: Option<i32>,
    limit: Option<u32>,
) -> Result<crate::personal_agent::history::Results, AppCommandError> {
    personal_agent_history_search_core(&db, query, scope, since, project_id, limit).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn personal_agent_history_status(
    db: State<'_, AppDatabase>,
) -> Result<crate::personal_agent::history::HistoryStatus, AppCommandError> {
    Ok(personal_agent_history_status_core(&db).await)
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn personal_agent_history_rebuild(
    db: State<'_, AppDatabase>,
) -> Result<crate::personal_agent::history::HistoryStatus, AppCommandError> {
    personal_agent_history_rebuild_core(&db).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn personal_agent_today(
    db: State<'_, AppDatabase>,
    manager: State<'_, crate::acp::manager::ConnectionManager>,
) -> Result<crate::personal_agent::today::TodayView, AppCommandError> {
    personal_agent_today_core(&db, &manager).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn personal_agent_activity(
    db: State<'_, AppDatabase>,
    manager: State<'_, crate::acp::manager::ConnectionManager>,
    bot_id: Option<i32>,
) -> Result<crate::personal_agent::activity_view::ActivityView, AppCommandError> {
    personal_agent_activity_core(&db, &manager, bot_id).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn notification_prefs_sync(
    db: State<'_, AppDatabase>,
    enabled: bool,
    hide_body: bool,
) -> Result<(), AppCommandError> {
    notification_prefs_sync_core(&db, enabled, hide_body).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn personal_agent_avatar_png(
    db: State<'_, AppDatabase>,
    bot_id: i32,
    png: Option<String>,
    tray: Option<String>,
) -> Result<(), AppCommandError> {
    personal_agent_avatar_png_core(&db, bot_id, png, tray).await
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
    card: Option<crate::personal_agent::card_acts::CardClick>,
    answers_item: Option<i32>,
) -> Result<TimelineRow, AppCommandError> {
    personal_agent_send_core(bot_id, text, blocks, reply_to, card, answers_item).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn personal_agent_card_act(
    bot_id: Option<i32>,
    row_id: i32,
    element: String,
    action: String,
    label: Option<String>,
    op: Option<String>,
) -> Result<TimelineRow, AppCommandError> {
    personal_agent_card_act_core(bot_id, row_id, element, action, label, op).await
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
pub async fn personal_agent_routines(
    db: State<'_, AppDatabase>,
    bot_id: Option<i32>,
) -> Result<Vec<crate::personal_agent::routines::RoutineView>, AppCommandError> {
    personal_agent_routines_core(&db, bot_id).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn personal_agent_routine_runs(
    db: State<'_, AppDatabase>,
    routine_id: i32,
    limit: Option<u64>,
) -> Result<Vec<crate::personal_agent::routines::RunView>, AppCommandError> {
    personal_agent_routine_runs_core(&db, routine_id, limit).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn personal_agent_routine_save(
    bot_id: Option<i32>,
    routine_id: Option<i32>,
    draft: crate::personal_agent::routines::Draft,
    notice_id: Option<i32>,
) -> Result<crate::personal_agent::routines::RoutineView, AppCommandError> {
    personal_agent_routine_save_core(bot_id, routine_id, draft, notice_id).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn personal_agent_rules(
    db: State<'_, AppDatabase>,
) -> Result<Vec<crate::personal_agent::rules::RuleView>, AppCommandError> {
    personal_agent_rules_core(&db).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn personal_agent_rule_reset(
    db: State<'_, AppDatabase>,
    rule: String,
) -> Result<Vec<crate::personal_agent::rules::RuleView>, AppCommandError> {
    personal_agent_rule_reset_core(&db, rule).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn personal_agent_routine_act(
    bot_id: Option<i32>,
    routine_id: i32,
    action: String,
) -> Result<crate::personal_agent::routines::RoutineView, AppCommandError> {
    personal_agent_routine_act_core(bot_id, routine_id, action).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn personal_agent_notice_act(
    bot_id: Option<i32>,
    notice_id: i32,
    action: String,
    text: Option<String>,
) -> Result<TimelineRow, AppCommandError> {
    personal_agent_notice_act_core(bot_id, notice_id, action, text).await
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
pub async fn personal_agent_skill_switch(
    bot_id: Option<i32>,
    name: String,
    on: bool,
) -> Result<(), AppCommandError> {
    personal_agent_skill_switch_core(bot_id, name, on).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn personal_agent_check_message(
    conversation_id: i32,
    message: String,
    asked: Option<String>,
    quote: Option<String>,
    again: Option<bool>,
) -> Result<crate::models::personal_agent::MessageCheckView, AppCommandError> {
    personal_agent_check_message_core(crate::models::personal_agent::MessageCheckRequest {
        conversation_id,
        message,
        asked,
        quote,
        again: again.unwrap_or(false),
    })
    .await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn personal_agent_checks(
    db: State<'_, AppDatabase>,
    conversation_id: i32,
) -> Result<Vec<crate::models::personal_agent::MessageCheckView>, AppCommandError> {
    personal_agent_checks_core(&db, conversation_id).await
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
pub async fn personal_agent_choice_answer(
    bot_id: Option<i32>,
    notice_id: i32,
    key: Option<String>,
    text: Option<String>,
    project_id: Option<i32>,
    answers: Option<Vec<crate::personal_agent::meet::ChoicePick>>,
) -> Result<TimelineRow, AppCommandError> {
    personal_agent_choice_answer_core(bot_id, notice_id, key, text, project_id, answers).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn personal_agent_meet_projects(
    db: State<'_, AppDatabase>,
) -> Result<Vec<crate::personal_agent::projects::ProjectView>, AppCommandError> {
    personal_agent_meet_projects_core(&db).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn personal_agent_starter(
    bot_id: Option<i32>,
    notice_id: i32,
) -> Result<TimelineRow, AppCommandError> {
    personal_agent_starter_core(bot_id, notice_id).await
}
