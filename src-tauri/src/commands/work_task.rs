//! Work-task CRUD + engine-dispatched commands. The `*_core` fns are
//! mode-agnostic and shared by the Tauri wrappers and the Axum handlers.
//! Anything that launches, cancels, merges, or touches a worktree routes
//! through the process-global task engine (per-folder git mutex + run_seq
//! generations live there); a process that does not hold the engine lock gets
//! a clean "engine not running" error.

use crate::app_error::AppCommandError;
use crate::commands::folders::get_folder_core;
use crate::db::entities::work_task::WorkTaskStatus;
use crate::db::error::DbError;
use crate::db::service::work_task_service;
use crate::db::AppDatabase;
use crate::models::{
    FollowUpIntent, WorkTaskChangedFile, WorkTaskDraft, WorkTaskEventInfo, WorkTaskFolderSettings,
    WorkTaskInfo, WorkTaskTemplateDraft, WorkTaskTemplateInfo,
};
use crate::web::event_bridge::{
    emit_event, EventEmitter, WorkTaskChange, WORK_TASK_CHANGED_EVENT,
};

fn engine() -> Result<std::sync::Arc<crate::work_task::TaskEngine>, DbError> {
    crate::work_task::engine()
        .ok_or_else(|| DbError::Validation("task engine not running".to_string()))
}

/// Best-effort pump nudge so an auto_process folder reacts to creates, edits,
/// requeues and settings changes without waiting for the reconcile tick. A
/// process not holding the engine lock skips it — the owning process's tick
/// picks the change up from the DB.
pub(crate) fn nudge_pump(folder_id: i32) {
    if let Some(engine) = crate::work_task::engine() {
        tokio::spawn(async move { engine.pump_folder(folder_id).await });
    }
}

/// Best-effort sweep of planned starts, for the one case the 15s tick handles
/// visibly late: a time that is already in the past when it is set.
fn nudge_schedule() {
    if let Some(engine) = crate::work_task::engine() {
        tokio::spawn(async move { engine.claim_due_scheduled().await });
    }
}

/// Best-effort merge-pump nudge after a settings change: switching auto-merge
/// on should drain the review backlog now, not at the next reconcile tick.
/// Scope 0 is the global row, which any folder without its own row follows —
/// that one pumps every folder holding reviewed tasks.
fn nudge_merge_pump(folder_id: i32) {
    if let Some(engine) = crate::work_task::engine() {
        let scope = (folder_id != 0).then_some(folder_id);
        tokio::spawn(async move { engine.sweep_merge_backlog(scope).await });
    }
}

// ── shared business logic (both modes) ──────────────────────────────────────

pub async fn work_task_list_core(
    db: &AppDatabase,
    folder_id: Option<i32>,
) -> Result<Vec<WorkTaskInfo>, DbError> {
    let mut infos = work_task_service::list(&db.conn, folder_id).await?;
    annotate_worktree_missing(db, &mut infos).await?;
    annotate_agent_type(db, &mut infos).await?;
    Ok(infos)
}

pub async fn work_task_get_core(db: &AppDatabase, id: i32) -> Result<WorkTaskInfo, DbError> {
    let mut infos = vec![work_task_service::get(&db.conn, id).await?];
    annotate_worktree_missing(db, &mut infos).await?;
    annotate_agent_type(db, &mut infos).await?;
    Ok(infos.pop().expect("annotated the one row"))
}

/// Stamp `worktree_missing` on every row whose recorded worktree can no longer
/// serve a merge: its folder row was removed, or its directory is gone from
/// disk. One batched folder query plus a stat per distinct worktree — cheap
/// enough for every list, and the board needs it live: a reviewed task whose
/// worktree vanished must offer "complete" instead of a merge that can only
/// fail.
async fn annotate_worktree_missing(
    db: &AppDatabase,
    infos: &mut [WorkTaskInfo],
) -> Result<(), DbError> {
    use sea_orm::{ColumnTrait, EntityTrait, QueryFilter};

    let ids: std::collections::BTreeSet<i32> =
        infos.iter().filter_map(|t| t.worktree_folder_id).collect();
    if ids.is_empty() {
        return Ok(());
    }
    let live_paths: std::collections::HashMap<i32, String> =
        crate::db::entities::folder::Entity::find()
            .filter(crate::db::entities::folder::Column::Id.is_in(ids.iter().copied()))
            .filter(crate::db::entities::folder::Column::DeletedAt.is_null())
            .all(&db.conn)
            .await?
            .into_iter()
            .map(|f| (f.id, f.path))
            .collect();
    let on_disk: std::collections::HashMap<i32, bool> = ids
        .iter()
        .map(|id| {
            let present = live_paths
                .get(id)
                .is_some_and(|path| std::path::Path::new(path).exists());
            (*id, present)
        })
        .collect();
    for info in infos.iter_mut() {
        if let Some(wt_id) = info.worktree_folder_id {
            info.worktree_missing = !on_disk.get(&wt_id).copied().unwrap_or(false);
        }
    }
    Ok(())
}

/// Stamp `agent_type` on every row: the agent that runs — or ran — this task,
/// which both task views draw beside the title. The client cannot resolve it
/// itself, because an inheriting task's agent lives in the folder's settings
/// rather than on the row, so the whole list is resolved here in three batched
/// queries instead of a lookup per card.
///
/// The engine's own layering (`effective_agent_config`) with the conversation
/// in front: a task that already ran is named by the agent that actually ran
/// it, then by its own override, then by the folder's task settings (its own
/// row wholesale, else the global one — `settings_get_effective`'s rule), then
/// by the folder's default agent. All four empty leaves `None`, which is
/// exactly the state the engine refuses to launch.
async fn annotate_agent_type(db: &AppDatabase, infos: &mut [WorkTaskInfo]) -> Result<(), DbError> {
    use crate::db::entities::{conversation, folder, work_task_settings};
    use sea_orm::{ColumnTrait, EntityTrait, QueryFilter};
    use std::collections::{BTreeSet, HashMap};
    use work_task_service::GLOBAL_SETTINGS_FOLDER_ID;

    if infos.is_empty() {
        return Ok(());
    }

    // Every source read here already stores a wire name ("claude_code",
    // "custom:<id>"), which is what the client keys its icon map on — so these
    // strings pass through verbatim.
    let conv_ids: BTreeSet<i32> = infos.iter().filter_map(|t| t.conversation_id).collect();
    let conv_agents: HashMap<i32, String> = if conv_ids.is_empty() {
        HashMap::new()
    } else {
        conversation::Entity::find()
            .filter(conversation::Column::Id.is_in(conv_ids.iter().copied()))
            .all(&db.conn)
            .await?
            .into_iter()
            .map(|c| (c.id, c.agent_type))
            .collect()
    };

    let folder_ids: BTreeSet<i32> = infos.iter().map(|t| t.folder_id).collect();
    let folder_defaults: HashMap<i32, String> = folder::Entity::find()
        .filter(folder::Column::Id.is_in(folder_ids.iter().copied()))
        .all(&db.conn)
        .await?
        .into_iter()
        .filter_map(|f| f.default_agent_type.map(|agent| (f.id, agent)))
        .collect();

    // Every settings row the list can consult, in one query: the folders it
    // spans plus the global row they fall back to. An unparseable row is
    // dropped rather than defaulted, so it falls through to the global one
    // exactly as `settings_get_effective` would.
    let settings_ids: BTreeSet<i32> = folder_ids
        .iter()
        .copied()
        .chain(std::iter::once(GLOBAL_SETTINGS_FOLDER_ID))
        .collect();
    let settings_agents: HashMap<i32, Option<String>> = work_task_settings::Entity::find()
        .filter(work_task_settings::Column::FolderId.is_in(settings_ids))
        .all(&db.conn)
        .await?
        .into_iter()
        .filter_map(|row| {
            serde_json::from_str::<WorkTaskFolderSettings>(&row.config)
                .ok()
                .map(|settings| (row.folder_id, settings.default_agent_type))
        })
        .collect();

    for info in infos.iter_mut() {
        let from_conversation = info
            .conversation_id
            .and_then(|id| conv_agents.get(&id))
            .cloned();
        let own_override = info
            .config
            .get("agent_type")
            .and_then(|v| v.as_str())
            .map(str::to_string);
        // A folder that saved settings of its own detaches from the global row
        // wholesale — including when its agent field is the empty one.
        let from_settings = settings_agents
            .get(&info.folder_id)
            .or_else(|| settings_agents.get(&GLOBAL_SETTINGS_FOLDER_ID))
            .cloned()
            .flatten();
        info.agent_type = from_conversation
            .or(own_override)
            .or(from_settings)
            .or_else(|| folder_defaults.get(&info.folder_id).cloned());
    }
    Ok(())
}

pub async fn work_task_events_core(
    db: &AppDatabase,
    task_id: i32,
    limit: u64,
) -> Result<Vec<WorkTaskEventInfo>, DbError> {
    work_task_service::list_events(&db.conn, task_id, limit).await
}

pub async fn work_task_attention_count_core(db: &AppDatabase) -> Result<u64, DbError> {
    work_task_service::attention_count(&db.conn).await
}

pub async fn work_task_create_core(
    emitter: &EventEmitter,
    db: &AppDatabase,
    draft: WorkTaskDraft,
) -> Result<WorkTaskInfo, DbError> {
    let info = work_task_service::create(&db.conn, draft).await?;
    emit_event(
        emitter,
        WORK_TASK_CHANGED_EVENT,
        WorkTaskChange::Upsert { id: info.id },
    );
    nudge_pump(info.folder_id);
    Ok(info)
}

pub async fn work_task_update_core(
    emitter: &EventEmitter,
    db: &AppDatabase,
    chat_channel_manager: &crate::chat_channel::manager::ChatChannelManager,
    id: i32,
    draft: WorkTaskDraft,
) -> Result<WorkTaskInfo, DbError> {
    // Read the pre-edit name first: a session this card already produced was
    // named after it (and locked), so a rename here should carry over — but only
    // while the two are still in sync, which only the OLD name can attest.
    let before = work_task_service::get_model(&db.conn, id).await.ok();

    let info = work_task_service::update(&db.conn, id, draft).await?;
    emit_event(
        emitter,
        WORK_TASK_CHANGED_EVENT,
        WorkTaskChange::Upsert { id },
    );
    if let Some(before) = before {
        rename_task_conversation(emitter, db, chat_channel_manager, &before, &info.title).await;
    }
    nudge_pump(info.folder_id);
    Ok(info)
}

/// Carry a card's rename over to the session it produced. Only reachable from
/// the editable statuses (`todo` / `failed` / `canceled`), so in practice this
/// fires for a task the user is re-shaping after a failed or canceled run.
///
/// Best-effort and deliberately narrow: `retitle_if_unchanged` writes only if
/// the conversation still carries the card's PREVIOUS name, so a session the
/// user renamed by hand keeps the name they chose. A skipped or failed write
/// costs a stale title, never the edit itself.
///
/// A written title is pushed on to the chat channels exactly as
/// `update_conversation_title` does. Engine-minted rows are not off-limits to
/// bindings: Telegram's `/resume <id>` takes ANY conversation id and binds it to
/// the forum topic it was typed in, so a task's session can own a topic whose
/// name would otherwise go stale forever — locked titles never pass through the
/// auto-title path that would re-sync it.
///
/// Known limitation (deliberate): the guard is a VALUE, not provenance, and the
/// card's own edit path is last-writer-wins with no CAS. Two clients editing the
/// same card at the same instant can therefore leave the session on the losing
/// name, and it will not re-sync — the next edit compares against a name the row
/// no longer carries. The cost is a stale display title on a failed/canceled
/// card; telling "the card named this" from "the user named this" apart for real
/// needs a provenance column on `conversation`, which is not worth it here.
async fn rename_task_conversation(
    emitter: &EventEmitter,
    db: &AppDatabase,
    chat_channel_manager: &crate::chat_channel::manager::ChatChannelManager,
    before: &crate::db::entities::work_task::Model,
    new_title: &str,
) {
    use crate::work_task::engine::conversation_title_for_task;

    let Some(conversation_id) = before.conversation_id else {
        return;
    };
    let (old, new) = (
        conversation_title_for_task(&before.title),
        conversation_title_for_task(new_title),
    );
    if old == new {
        return;
    }
    match crate::db::service::conversation_service::retitle_if_unchanged(
        &db.conn,
        conversation_id,
        &old,
        &new,
    )
    .await
    {
        Ok(true) => {
            crate::commands::conversations::emit_conversation_upsert(
                emitter,
                &db.conn,
                conversation_id,
            )
            .await;
            crate::commands::conversations::sync_conversation_title_to_channels_core(
                &db.conn,
                chat_channel_manager,
                conversation_id,
            )
            .await;
        }
        Ok(false) => {}
        Err(e) => tracing::warn!(
            "[work_task] task {}: could not retitle conversation {conversation_id}: {e}",
            before.id
        ),
    }
}

/// How many times a delete re-reads before giving up. A retry only happens when
/// something claimed the task mid-delete; more than a couple in a row means the
/// board is fighting the user, and an error is a better answer than a loop.
const DELETE_ATTEMPTS: usize = 4;

/// Delete a task. An active run is canceled first; `delete_worktree` also
/// removes its worktree (best-effort — a cleanup failure does not block the
/// delete, the worktree just stays on disk). Refused while merging.
///
/// The whole thing runs as converge-then-tombstone rather than
/// decide-once-then-write: three arms can claim a `todo` task out from under
/// this call (the user, the folder's auto-processor, a planned start coming
/// due), and a tombstone written over a generation that just started would
/// leave its freshly minted worktree — and possibly its agent process — behind,
/// with the row that knows about them gone. So the final `soft_delete` is
/// guarded on the status we validated, and losing that guard sends us round
/// again to cancel whatever claimed it.
pub async fn work_task_delete_core(
    emitter: &EventEmitter,
    db: &AppDatabase,
    id: i32,
    delete_worktree: bool,
) -> Result<(), DbError> {
    // Kept only to report the reason if we run out of attempts.
    let mut last_conflict: Option<String> = None;
    for _ in 0..DELETE_ATTEMPTS {
        let task = work_task_service::get_model(&db.conn, id).await?;
        if task.status == WorkTaskStatus::Merging {
            return Err(DbError::Validation(
                "task is merging — wait for it to finish".to_string(),
            ));
        }
        if matches!(
            task.status,
            WorkTaskStatus::Queued
                | WorkTaskStatus::Preparing
                | WorkTaskStatus::Running
                | WorkTaskStatus::AwaitingInput
        ) {
            // `cancel` waits on the engine's per-task lock, which a launch holds
            // across its whole setup — so when it returns, that generation has
            // stopped touching the worktree. A cancel that loses its own CAS
            // just means the task settled by itself; re-read and decide again
            // instead of failing the delete.
            if let Err(e) = engine()?.cancel(id, None).await {
                last_conflict = Some(e);
            }
            continue;
        }
        // Read from THIS pass, not from a stale first look: a run that started
        // and was cancelled above has a worktree the first snapshot never saw.
        if delete_worktree && task.worktree_folder_id.is_some() {
            if let Err(blocked) = engine()?.cleanup_task(id).await {
                if blocked.holds_work {
                    // STOP, rather than the `warn!` a mere failure gets. The
                    // tombstone below is what makes this different from every
                    // other swallowed cleanup: it takes the card, its
                    // `cleanup_state` and its retry entry in one write, so the
                    // worktree the user was told would be deleted would be left
                    // on disk with nothing anywhere left to say why. Refusing
                    // the delete keeps both the files and the way out.
                    return Err(DbError::Validation(crate::work_task::worktree_kept(
                        "Remove them, or clear \"also delete its worktree\" to delete just the \
                         task.",
                    )));
                }
                tracing::warn!(
                    "[work_task] cleanup during delete of task {id}: {}",
                    blocked.message
                );
            }
        }
        if work_task_service::soft_delete(&db.conn, id, task.status).await? {
            emit_event(
                emitter,
                WORK_TASK_CHANGED_EVENT,
                WorkTaskChange::Deleted { id },
            );
            return Ok(());
        }
        last_conflict = Some("task was claimed while being deleted".to_string());
    }
    Err(DbError::Validation(last_conflict.unwrap_or_else(|| {
        "task kept changing while being deleted — try again".to_string()
    })))
}

/// Persist the pending column's drag order. `sort_order` also drives the
/// engine's claim/launch order, so reordering queued tasks re-prioritizes them.
pub async fn work_task_reorder_core(
    emitter: &EventEmitter,
    db: &AppDatabase,
    folder_id: i32,
    ordered_ids: Vec<i32>,
) -> Result<(), DbError> {
    work_task_service::reorder(&db.conn, folder_id, &ordered_ids).await?;
    emit_event(emitter, WORK_TASK_CHANGED_EVENT, WorkTaskChange::Refresh);
    nudge_pump(folder_id);
    Ok(())
}

pub async fn work_task_start_core(id: i32) -> Result<(), DbError> {
    engine()?.start(id).await.map_err(DbError::Validation)
}

/// `folder_id: None` = the global sweep — every folder holding todos.
pub async fn work_task_start_all_core(folder_id: Option<i32>) -> Result<u32, DbError> {
    engine()?
        .start_all(folder_id)
        .await
        .map_err(DbError::Validation)
}

/// failed → queued, optionally with a note explaining what to do differently.
/// `blocks` carries whatever the note box attached out of band (images, pasted
/// bytes) as raw prompt blocks.
pub async fn work_task_retry_core(
    id: i32,
    note: Option<String>,
    blocks: Vec<serde_json::Value>,
    allow_duplicate_source: bool,
) -> Result<(), DbError> {
    engine()?
        .retry(id, note, blocks, allow_duplicate_source)
        .await
        .map_err(DbError::Validation)
}

/// canceled → todo. Pure DB (no engine needed) — the user starts it again
/// explicitly. A cancel usually had a reason; the optional note carries it into
/// the next run's prompt.
pub async fn work_task_requeue_core(
    emitter: &EventEmitter,
    db: &AppDatabase,
    id: i32,
    note: Option<String>,
    blocks: Vec<serde_json::Value>,
    allow_duplicate_source: bool,
) -> Result<(), DbError> {
    if !work_task_service::requeue_canceled(
        &db.conn,
        id,
        note.as_deref(),
        &blocks,
        allow_duplicate_source,
    )
    .await?
    {
        return Err(DbError::Validation("task is not canceled".to_string()));
    }
    emit_event(
        emitter,
        WORK_TASK_CHANGED_EVENT,
        WorkTaskChange::Upsert { id },
    );
    if let Ok(task) = work_task_service::get_model(&db.conn, id).await {
        nudge_pump(task.folder_id);
    }
    Ok(())
}

/// Plan when a to-do task starts. `scheduled_at` is an RFC 3339 instant (the
/// client sends the time the user picked, converted from its own zone);
/// `None` clears the plan. Pure DB — the engine's schedule tick claims the task
/// when its time comes, and the nudge below covers a time already in the past.
pub async fn work_task_schedule_core(
    emitter: &EventEmitter,
    db: &AppDatabase,
    id: i32,
    scheduled_at: Option<String>,
) -> Result<(), DbError> {
    let at = match scheduled_at.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(raw) => Some(
            chrono::DateTime::parse_from_rfc3339(raw)
                .map_err(|e| DbError::Validation(format!("invalid scheduled_at: {e}")))?
                .with_timezone(&chrono::Utc),
        ),
        None => None,
    };
    if !work_task_service::set_schedule(&db.conn, id, at).await? {
        return Err(DbError::Validation(
            "only to-do tasks can be scheduled".to_string(),
        ));
    }
    emit_event(
        emitter,
        WORK_TASK_CHANGED_EVENT,
        WorkTaskChange::Upsert { id },
    );
    if at.is_some() {
        nudge_schedule();
    }
    Ok(())
}

/// Follow up on a reviewed task. `intent` picks the wording the agent receives;
/// absent means `revise`, the historical "returned with feedback" behaviour.
pub async fn work_task_return_core(
    id: i32,
    feedback: String,
    intent: Option<String>,
    blocks: Vec<serde_json::Value>,
) -> Result<(), DbError> {
    let intent = FollowUpIntent::from_wire(intent.as_deref()).map_err(DbError::Validation)?;
    let feedback = feedback.trim().to_string();
    // A self-check is a complete instruction on its own, and so is an attached
    // screenshot; everything else is only as good as what the user typed.
    if feedback.is_empty() && blocks.is_empty() && !intent.allows_empty() {
        return Err(DbError::Validation("feedback is required".to_string()));
    }
    engine()?
        .return_task(id, intent, feedback, blocks)
        .await
        .map_err(DbError::Validation)
}

/// Stop a task. `reason` is the user's optional note about WHY — it lands on
/// the `canceled` entry of the progress timeline and nowhere else.
///
/// `delete_worktree` takes the checkout along, the same offer the acceptances
/// make — except here it also destroys the work branch (`cleanup_task` deletes
/// it outright), so a canceled task that was cleaned up has nothing left to
/// requeue INTO; the requeued run starts from a fresh worktree. The dialog
/// defaults the box to off for exactly that reason.
///
/// Cleanup runs AFTER the cancel returns, not inside it: the removal refuses
/// while the task still has a live agent connection, and shedding that
/// connection is the last thing [`Engine::cancel`] does. The gap that opens
/// between the two calls is `cleanup_task`'s own problem, not this one's — it
/// re-reads the row under the task lock precisely so a requeue landing in here
/// cannot have its fresh checkout deleted.
///
/// Best-effort, like the delete path — a git failure flags a retryable
/// `cleanup_state` on the card rather than turning a stop that already happened
/// into an error. Refusals are swallowed here too, and both of them leave the
/// worktree standing (fail-safe) with the reason visible on the board rather
/// than in this return value: either the task was re-claimed while we were
/// stopping it — the requeue that saved the checkout is itself on the board —
/// or it still holds uncommitted files, which `cleanup_task` flags as a
/// retryable `cleanup_state`. A stop interrupts a working agent, so the second
/// is the common one, and turning it into an error would report the stop that
/// already happened as failed.
pub async fn work_task_cancel_core(
    id: i32,
    reason: Option<String>,
    delete_worktree: bool,
) -> Result<(), DbError> {
    let engine = engine()?;
    engine.cancel(id, reason).await.map_err(DbError::Validation)?;
    if delete_worktree {
        if let Err(blocked) = engine.cleanup_task(id).await {
            tracing::warn!(
                "[work_task] cleanup during cancel of task {id}: {}",
                blocked.message
            );
        }
    }
    Ok(())
}

/// Dispatch the merge generation: the agent lands the task in its session and
/// the outcome rides the `task://changed` events (merging → done, or back to
/// review with a readable error). This awaits only the dispatch (validation +
/// agent spawn), so refused merges surface directly in the dialog.
/// `message: None` = the agent writes the commit message itself;
/// `instructions: None` = the user added nothing beyond the standing recipe.
///
/// Returns `true` when the merge was QUEUED instead of started — the folder was
/// already landing another task, and this one goes in as soon as that finishes.
pub async fn work_task_merge_core(
    id: i32,
    message: Option<String>,
    delete_worktree: bool,
    instructions: Option<String>,
) -> Result<bool, DbError> {
    engine()?
        .merge_task(id, message, delete_worktree, instructions, false)
        .await
        .map(|dispatch| dispatch.is_queued())
        .map_err(DbError::Validation)
}

/// Withdraw a merge that is waiting in the folder's queue (the task stays in
/// review, untouched). Pure DB — no engine needed: the pump only ever reads
/// intents that are still on the row.
pub async fn work_task_merge_unqueue_core(
    emitter: &EventEmitter,
    db: &AppDatabase,
    id: i32,
) -> Result<(), DbError> {
    if !work_task_service::unqueue_merge(&db.conn, id).await? {
        return Err(DbError::Validation(
            "this task is not waiting to merge".to_string(),
        ));
    }
    emit_event(
        emitter,
        WORK_TASK_CHANGED_EVENT,
        WorkTaskChange::Upsert { id },
    );
    Ok(())
}

/// Accept a reviewed forge-sourced task by pushing it back to the repository
/// it came from: an issue's task opens (or adopts) a pull request for its own
/// branch, a pull request's task pushes onto that pull request's branch.
/// Returns the pull request URL.
///
/// Unlike the merge dispatch this awaits the WHOLE operation — a push plus two
/// REST calls, no agent — so both success and failure land in the caller's
/// dialog. Every gate is inside the engine, where a direct API call cannot
/// route around it.
///
/// `delete_worktree` takes the checkout along once the delivery lands, the
/// same offer the merge and complete acceptances make. It never changes the
/// result: a removal that fails leaves a retryable `cleanup_state` on the card
/// and the delivered URL still comes back.
pub async fn work_task_deliver_pr_core(
    id: i32,
    pr_title: Option<String>,
    draft: bool,
    delete_worktree: bool,
) -> Result<String, DbError> {
    engine()?
        .deliver_pr(id, pr_title, draft, delete_worktree)
        .await
        .map_err(DbError::Validation)
}

/// Finish a reviewed task that has nothing to land (review → done, no merge),
/// optionally removing its worktree. Refused when the worktree turns out to
/// hold changes after all — that task belongs on the merge path.
pub async fn work_task_complete_core(id: i32, delete_worktree: bool) -> Result<(), DbError> {
    engine()?
        .complete_task(id, delete_worktree)
        .await
        .map_err(DbError::Validation)
}

/// Archive / unarchive a terminal task (pure DB; no engine needed). Archived
/// tasks leave the default board view and the attention badge.
pub async fn work_task_archive_core(
    emitter: &EventEmitter,
    db: &AppDatabase,
    id: i32,
    archived: bool,
) -> Result<(), DbError> {
    if !work_task_service::set_archived(&db.conn, id, archived).await? {
        return Err(DbError::Validation(if archived {
            "only finished tasks can be archived".to_string()
        } else {
            "task is not archived".to_string()
        }));
    }
    emit_event(
        emitter,
        WORK_TASK_CHANGED_EVENT,
        WorkTaskChange::Upsert { id },
    );
    Ok(())
}

/// Put a reviewed / failed task aside to handle later (`deferred = true`), or
/// bring it back to "needs you" (pure DB; no engine needed). A deferred task
/// waits under Done and leaves the attention badge, but stays resumable as it
/// was: its follow-up, retry or merge picks it back up and clears the mark.
pub async fn work_task_defer_core(
    emitter: &EventEmitter,
    db: &AppDatabase,
    id: i32,
    deferred: bool,
) -> Result<(), DbError> {
    if !work_task_service::set_deferred(&db.conn, id, deferred).await? {
        return Err(DbError::Validation(if deferred {
            "only a reviewed or failed task can be put aside — and not while it is archived or \
             waiting to merge"
                .to_string()
        } else {
            "task is not put aside".to_string()
        }));
    }
    emit_event(
        emitter,
        WORK_TASK_CHANGED_EVENT,
        WorkTaskChange::Upsert { id },
    );
    Ok(())
}

pub async fn work_task_cleanup_core(id: i32) -> Result<(), DbError> {
    engine()?
        .cleanup_task(id)
        .await
        .map_err(|blocked| DbError::Validation(blocked.message))
}

/// Diff of the task worktree vs. the base its branch sits on
/// ([`crate::work_task::engine::branch_base`]: the recorded `base_sha`, moved
/// forward only once the branch absorbed base content — so the view stays put
/// while the base branch advances, and base content the agent merged in is not
/// shown as the task's change). `file = None` → full patch.
///
/// Uncommitted work is part of it: nothing makes the agent commit before the
/// task reaches review (the merge generation commits the leftovers itself), so
/// a review that showed only committed work would be reviewing half the task.
/// New files therefore render as `new file mode` hunks rather than as an empty
/// diff — see [`crate::work_task::git::diff_patch_with_untracked`].
pub async fn work_task_diff_core(
    db: &AppDatabase,
    id: i32,
    file: Option<String>,
) -> Result<String, AppCommandError> {
    let task = work_task_service::get_model(&db.conn, id)
        .await
        .map_err(AppCommandError::from)?;
    let wt_id = task
        .worktree_folder_id
        .ok_or_else(|| AppCommandError::not_found("task has no worktree"))?;
    let wt = get_folder_core(db, wt_id)
        .await
        .map_err(AppCommandError::from)?;
    let base = crate::work_task::engine::branch_base(&wt.path, &task)
        .await
        .ok_or_else(|| AppCommandError::not_found("task has no recorded base"))?;
    crate::work_task::git::diff_patch_with_untracked(&wt.path, &base, file.as_deref()).await
}

/// The file list behind that diff — same base, same "uncommitted work counts"
/// rule, so the drawer's list and the row's counters cannot tell two different
/// stories about the same task.
pub async fn work_task_changed_files_core(
    db: &AppDatabase,
    id: i32,
) -> Result<Vec<WorkTaskChangedFile>, AppCommandError> {
    let task = work_task_service::get_model(&db.conn, id)
        .await
        .map_err(AppCommandError::from)?;
    let Some(wt_id) = task.worktree_folder_id else {
        return Ok(vec![]);
    };
    if task.base_sha.is_none() && task.base_branch.is_none() {
        return Ok(vec![]);
    }
    let wt = get_folder_core(db, wt_id)
        .await
        .map_err(AppCommandError::from)?;
    let Some(base) = crate::work_task::engine::branch_base(&wt.path, &task).await else {
        return Ok(vec![]);
    };
    crate::work_task::git::diff_numstat_with_untracked(&wt.path, &base).await
}

pub async fn work_task_settings_get_core(
    db: &AppDatabase,
    folder_id: i32,
) -> Result<WorkTaskFolderSettings, DbError> {
    work_task_service::settings_get(&db.conn, folder_id).await
}

/// Effective settings after the folder → global → built-in fallback — what
/// the engine will actually use for this folder (editor prefill, merge dialog
/// seeding).
pub async fn work_task_settings_effective_core(
    db: &AppDatabase,
    folder_id: i32,
) -> Result<WorkTaskFolderSettings, DbError> {
    work_task_service::settings_get_effective(&db.conn, folder_id).await
}

/// The folder's own settings row, or `None` when it follows the global
/// defaults — the settings dialog's source-of-truth probe.
pub async fn work_task_settings_get_own_core(
    db: &AppDatabase,
    folder_id: i32,
) -> Result<Option<WorkTaskFolderSettings>, DbError> {
    work_task_service::settings_get_own(&db.conn, folder_id).await
}

pub async fn work_task_settings_set_core(
    emitter: &EventEmitter,
    db: &AppDatabase,
    folder_id: i32,
    settings: WorkTaskFolderSettings,
) -> Result<(), DbError> {
    work_task_service::settings_set(&db.conn, folder_id, &settings).await?;
    emit_event(
        emitter,
        WORK_TASK_CHANGED_EVENT,
        WorkTaskChange::Settings { folder_id },
    );
    nudge_pump(folder_id);
    nudge_merge_pump(folder_id);
    Ok(())
}

/// Remove the folder's own settings row — it reverts to the global defaults.
/// Same nudges as a set: auto-process/concurrency may effectively change.
pub async fn work_task_settings_delete_core(
    emitter: &EventEmitter,
    db: &AppDatabase,
    folder_id: i32,
) -> Result<(), DbError> {
    work_task_service::settings_delete(&db.conn, folder_id).await?;
    emit_event(
        emitter,
        WORK_TASK_CHANGED_EVENT,
        WorkTaskChange::Settings { folder_id },
    );
    nudge_pump(folder_id);
    // Reverting to the global row can also switch auto-merge ON for this
    // folder (the global row may carry it) — same drain-now semantics.
    nudge_merge_pump(folder_id);
    Ok(())
}

pub async fn work_task_template_list_core(
    db: &AppDatabase,
) -> Result<Vec<WorkTaskTemplateInfo>, DbError> {
    work_task_service::template_list(&db.conn).await
}

pub async fn work_task_template_save_core(
    db: &AppDatabase,
    draft: WorkTaskTemplateDraft,
) -> Result<WorkTaskTemplateInfo, DbError> {
    work_task_service::template_save(&db.conn, &draft).await
}

pub async fn work_task_template_delete_core(db: &AppDatabase, id: i32) -> Result<(), DbError> {
    work_task_service::template_delete(&db.conn, id).await
}

// ── Tauri command wrappers (desktop only) ───────────────────────────────────

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn work_task_list(
    db: tauri::State<'_, AppDatabase>,
    folder_id: Option<i32>,
) -> Result<Vec<WorkTaskInfo>, DbError> {
    work_task_list_core(&db, folder_id).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn work_task_get(
    db: tauri::State<'_, AppDatabase>,
    id: i32,
) -> Result<WorkTaskInfo, DbError> {
    work_task_get_core(&db, id).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn work_task_events(
    db: tauri::State<'_, AppDatabase>,
    task_id: i32,
    limit: Option<u64>,
) -> Result<Vec<WorkTaskEventInfo>, DbError> {
    work_task_events_core(&db, task_id, limit.unwrap_or(500)).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn work_task_attention_count(
    db: tauri::State<'_, AppDatabase>,
) -> Result<u64, DbError> {
    work_task_attention_count_core(&db).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn work_task_create(
    app: tauri::AppHandle,
    db: tauri::State<'_, AppDatabase>,
    draft: WorkTaskDraft,
) -> Result<WorkTaskInfo, DbError> {
    work_task_create_core(&EventEmitter::Tauri(app), &db, draft).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn work_task_update(
    app: tauri::AppHandle,
    db: tauri::State<'_, AppDatabase>,
    chat_channel_manager: tauri::State<'_, crate::chat_channel::manager::ChatChannelManager>,
    id: i32,
    draft: WorkTaskDraft,
) -> Result<WorkTaskInfo, DbError> {
    work_task_update_core(
        &EventEmitter::Tauri(app),
        &db,
        &chat_channel_manager,
        id,
        draft,
    )
    .await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn work_task_reorder(
    app: tauri::AppHandle,
    db: tauri::State<'_, AppDatabase>,
    folder_id: i32,
    ordered_ids: Vec<i32>,
) -> Result<(), DbError> {
    work_task_reorder_core(&EventEmitter::Tauri(app), &db, folder_id, ordered_ids).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn work_task_delete(
    app: tauri::AppHandle,
    db: tauri::State<'_, AppDatabase>,
    id: i32,
    delete_worktree: Option<bool>,
) -> Result<(), DbError> {
    work_task_delete_core(
        &EventEmitter::Tauri(app),
        &db,
        id,
        delete_worktree.unwrap_or(false),
    )
    .await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn work_task_start(id: i32) -> Result<(), DbError> {
    work_task_start_core(id).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn work_task_start_all(folder_id: Option<i32>) -> Result<u32, DbError> {
    work_task_start_all_core(folder_id).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn work_task_retry(
    id: i32,
    note: Option<String>,
    blocks: Option<Vec<serde_json::Value>>,
    allow_duplicate_source: Option<bool>,
) -> Result<(), DbError> {
    work_task_retry_core(
        id,
        note,
        blocks.unwrap_or_default(),
        allow_duplicate_source.unwrap_or(false),
    )
    .await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn work_task_requeue(
    app: tauri::AppHandle,
    db: tauri::State<'_, AppDatabase>,
    id: i32,
    note: Option<String>,
    blocks: Option<Vec<serde_json::Value>>,
    allow_duplicate_source: Option<bool>,
) -> Result<(), DbError> {
    work_task_requeue_core(
        &EventEmitter::Tauri(app),
        &db,
        id,
        note,
        blocks.unwrap_or_default(),
        allow_duplicate_source.unwrap_or(false),
    )
    .await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn work_task_schedule(
    app: tauri::AppHandle,
    db: tauri::State<'_, AppDatabase>,
    id: i32,
    scheduled_at: Option<String>,
) -> Result<(), DbError> {
    work_task_schedule_core(&EventEmitter::Tauri(app), &db, id, scheduled_at).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn work_task_return(
    id: i32,
    feedback: String,
    intent: Option<String>,
    blocks: Option<Vec<serde_json::Value>>,
) -> Result<(), DbError> {
    work_task_return_core(id, feedback, intent, blocks.unwrap_or_default()).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn work_task_cancel(
    id: i32,
    reason: Option<String>,
    delete_worktree: Option<bool>,
) -> Result<(), DbError> {
    work_task_cancel_core(id, reason, delete_worktree.unwrap_or(false)).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn work_task_merge(
    id: i32,
    message: Option<String>,
    delete_worktree: bool,
    instructions: Option<String>,
) -> Result<bool, DbError> {
    work_task_merge_core(id, message, delete_worktree, instructions).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn work_task_merge_unqueue(
    app: tauri::AppHandle,
    db: tauri::State<'_, AppDatabase>,
    id: i32,
) -> Result<(), DbError> {
    work_task_merge_unqueue_core(&EventEmitter::Tauri(app), &db, id).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn work_task_deliver_pr(
    id: i32,
    pr_title: Option<String>,
    draft: bool,
    delete_worktree: bool,
) -> Result<String, DbError> {
    work_task_deliver_pr_core(id, pr_title, draft, delete_worktree).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn work_task_complete(id: i32, delete_worktree: bool) -> Result<(), DbError> {
    work_task_complete_core(id, delete_worktree).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn work_task_archive(
    app: tauri::AppHandle,
    db: tauri::State<'_, AppDatabase>,
    id: i32,
    archived: bool,
) -> Result<(), DbError> {
    work_task_archive_core(&EventEmitter::Tauri(app), &db, id, archived).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn work_task_defer(
    app: tauri::AppHandle,
    db: tauri::State<'_, AppDatabase>,
    id: i32,
    deferred: bool,
) -> Result<(), DbError> {
    work_task_defer_core(&EventEmitter::Tauri(app), &db, id, deferred).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn work_task_cleanup(id: i32) -> Result<(), DbError> {
    work_task_cleanup_core(id).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn work_task_diff(
    db: tauri::State<'_, AppDatabase>,
    id: i32,
    file: Option<String>,
) -> Result<String, AppCommandError> {
    work_task_diff_core(&db, id, file).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn work_task_changed_files(
    db: tauri::State<'_, AppDatabase>,
    id: i32,
) -> Result<Vec<WorkTaskChangedFile>, AppCommandError> {
    work_task_changed_files_core(&db, id).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn work_task_settings_get(
    db: tauri::State<'_, AppDatabase>,
    folder_id: i32,
) -> Result<WorkTaskFolderSettings, DbError> {
    work_task_settings_get_core(&db, folder_id).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn work_task_settings_effective(
    db: tauri::State<'_, AppDatabase>,
    folder_id: i32,
) -> Result<WorkTaskFolderSettings, DbError> {
    work_task_settings_effective_core(&db, folder_id).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn work_task_settings_get_own(
    db: tauri::State<'_, AppDatabase>,
    folder_id: i32,
) -> Result<Option<WorkTaskFolderSettings>, DbError> {
    work_task_settings_get_own_core(&db, folder_id).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn work_task_settings_set(
    app: tauri::AppHandle,
    db: tauri::State<'_, AppDatabase>,
    folder_id: i32,
    settings: WorkTaskFolderSettings,
) -> Result<(), DbError> {
    work_task_settings_set_core(&EventEmitter::Tauri(app), &db, folder_id, settings).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn work_task_settings_delete(
    app: tauri::AppHandle,
    db: tauri::State<'_, AppDatabase>,
    folder_id: i32,
) -> Result<(), DbError> {
    work_task_settings_delete_core(&EventEmitter::Tauri(app), &db, folder_id).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn work_task_template_list(
    db: tauri::State<'_, AppDatabase>,
) -> Result<Vec<WorkTaskTemplateInfo>, DbError> {
    work_task_template_list_core(&db).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn work_task_template_save(
    db: tauri::State<'_, AppDatabase>,
    draft: WorkTaskTemplateDraft,
) -> Result<WorkTaskTemplateInfo, DbError> {
    work_task_template_save_core(&db, draft).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn work_task_template_delete(
    db: tauri::State<'_, AppDatabase>,
    id: i32,
) -> Result<(), DbError> {
    work_task_template_delete_core(&db, id).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::service::folder_service;
    use crate::db::test_helpers::{fresh_in_memory_db, seed_conversation, seed_folder};
    use crate::models::agent::AgentType;

    fn draft(folder_id: i32, title: &str, agent: Option<&str>) -> WorkTaskDraft {
        WorkTaskDraft {
            folder_id,
            title: title.to_string(),
            config: serde_json::json!({
                "display_text": "do the thing",
                "prompt_blocks": [{ "type": "text", "text": "do the thing" }],
                "agent_type": agent,
            }),
        }
    }

    async fn agent_of(db: &AppDatabase, task_id: i32) -> Option<String> {
        work_task_get_core(db, task_id).await.unwrap().agent_type
    }

    /// The list must name each task's agent the way the ENGINE would pick it
    /// (`effective_agent_config`), or the views draw a mark for an agent that
    /// never runs. Walks the layering from the outside in.
    #[tokio::test]
    async fn agent_type_is_stamped_with_the_engines_own_layering() {
        let db = fresh_in_memory_db().await;
        let folder_id = seed_folder(&db, "/tmp/wt-agent").await;
        folder_service::update_folder_default_agent(
            &db.conn,
            folder_id,
            Some(AgentType::ClaudeCode),
        )
        .await
        .unwrap();

        let overridden = work_task_service::create(&db.conn, draft(folder_id, "a", Some("codex")))
            .await
            .unwrap();
        let inheriting = work_task_service::create(&db.conn, draft(folder_id, "b", None))
            .await
            .unwrap();

        // Nothing between the task and its folder yet.
        assert_eq!(agent_of(&db, overridden.id).await.as_deref(), Some("codex"));
        assert_eq!(
            agent_of(&db, inheriting.id).await.as_deref(),
            Some("claude_code")
        );

        // The folder's task settings sit between the two — and only the
        // inheriting task feels them.
        let settings = WorkTaskFolderSettings {
            default_agent_type: Some("grok".to_string()),
            ..Default::default()
        };
        work_task_service::settings_set(&db.conn, folder_id, &settings)
            .await
            .unwrap();
        assert_eq!(agent_of(&db, overridden.id).await.as_deref(), Some("codex"));
        assert_eq!(agent_of(&db, inheriting.id).await.as_deref(), Some("grok"));

        // Once the task has actually run, the agent that ran it wins over
        // every configured layer — including the task's own override.
        let conversation_id = seed_conversation(&db, folder_id, AgentType::Gemini).await;
        let run_seq =
            work_task_service::claim_for_run(&db.conn, overridden.id, WorkTaskStatus::Todo, "user")
                .await
                .unwrap()
                .unwrap();
        assert!(work_task_service::begin_setup(&db.conn, overridden.id, run_seq)
            .await
            .unwrap());
        assert!(
            work_task_service::mark_running(&db.conn, overridden.id, run_seq, conversation_id, "c1")
                .await
                .unwrap()
        );
        assert_eq!(agent_of(&db, overridden.id).await.as_deref(), Some("gemini"));

        // A list stamps every row the same way a get does.
        let listed = work_task_list_core(&db, Some(folder_id)).await.unwrap();
        let stamped: Vec<Option<String>> = listed.into_iter().map(|t| t.agent_type).collect();
        assert!(stamped.iter().all(|a| a.is_some()), "{stamped:?}");
    }

    /// A folder with no default and no settings anywhere leaves the field
    /// empty rather than guessing — the same state the engine refuses to
    /// launch, which both views draw as a placeholder.
    #[tokio::test]
    async fn agent_type_is_none_when_nothing_is_configured() {
        let db = fresh_in_memory_db().await;
        let folder_id = seed_folder(&db, "/tmp/wt-agent-none").await;
        let task = work_task_service::create(&db.conn, draft(folder_id, "a", None))
            .await
            .unwrap();
        assert_eq!(agent_of(&db, task.id).await, None);

        // The global settings row is what a folder without its own follows.
        let settings = WorkTaskFolderSettings {
            default_agent_type: Some("cursor".to_string()),
            ..Default::default()
        };
        work_task_service::settings_set(
            &db.conn,
            work_task_service::GLOBAL_SETTINGS_FOLDER_ID,
            &settings,
        )
        .await
        .unwrap();
        assert_eq!(agent_of(&db, task.id).await.as_deref(), Some("cursor"));
    }

    fn test_emitter() -> EventEmitter {
        EventEmitter::test_web_only(std::sync::Arc::new(
            crate::web::event_bridge::WebEventBroadcaster::new(),
        ))
    }

    /// No backend is registered on a bare manager, so a title sync reaches the
    /// binding lookup and then stops at `NotFound` — no network, no waiting.
    fn test_channels() -> crate::chat_channel::manager::ChatChannelManager {
        crate::chat_channel::manager::ChatChannelManager::new()
    }

    /// The state the engine leaves behind once a card has produced a session.
    async fn bind_conversation(db: &AppDatabase, task_id: i32, conversation_id: i32) {
        use sea_orm::{ActiveModelTrait, EntityTrait, IntoActiveModel, Set};
        let row = crate::db::entities::work_task::Entity::find_by_id(task_id)
            .one(&db.conn)
            .await
            .unwrap()
            .expect("task row");
        let mut active = row.into_active_model();
        active.conversation_id = Set(Some(conversation_id));
        active.update(&db.conn).await.unwrap();
    }

    async fn conversation_title(db: &AppDatabase, id: i32) -> Option<String> {
        crate::db::service::conversation_service::get_by_id(&db.conn, id)
            .await
            .unwrap()
            .title
    }

    /// Renaming a card renames the session it produced: the two must not drift
    /// apart, or the sidebar goes back to showing a name nothing on the board
    /// answers to (issue #495).
    #[tokio::test]
    async fn renaming_a_task_renames_the_session_it_produced() {
        let db = fresh_in_memory_db().await;
        let folder_id = seed_folder(&db, "/tmp/wt-retitle").await;
        let task = work_task_service::create(&db.conn, draft(folder_id, "Fix login", None))
            .await
            .unwrap();
        let conv = seed_conversation(&db, folder_id, AgentType::ClaudeCode).await;
        crate::db::service::conversation_service::update_title(
            &db.conn,
            conv,
            "Fix login".to_string(),
        )
        .await
        .unwrap();
        bind_conversation(&db, task.id, conv).await;

        work_task_update_core(
            &test_emitter(),
            &db,
            &test_channels(),
            task.id,
            draft(folder_id, "Fix logout too", None),
        )
        .await
        .unwrap();

        assert_eq!(
            conversation_title(&db, conv).await.as_deref(),
            Some("Fix logout too")
        );
    }

    /// …but a session the user named themselves keeps that name. Both titles
    /// are `title_locked`, so only the card's PREVIOUS name can tell "still in
    /// sync" from "the user picked this".
    #[tokio::test]
    async fn renaming_a_task_leaves_a_hand_named_session_alone() {
        let db = fresh_in_memory_db().await;
        let folder_id = seed_folder(&db, "/tmp/wt-retitle-manual").await;
        let task = work_task_service::create(&db.conn, draft(folder_id, "Fix login", None))
            .await
            .unwrap();
        let conv = seed_conversation(&db, folder_id, AgentType::ClaudeCode).await;
        crate::db::service::conversation_service::update_title(
            &db.conn,
            conv,
            "My own name".to_string(),
        )
        .await
        .unwrap();
        bind_conversation(&db, task.id, conv).await;

        work_task_update_core(
            &test_emitter(),
            &db,
            &test_channels(),
            task.id,
            draft(folder_id, "Fix logout too", None),
        )
        .await
        .unwrap();

        assert_eq!(
            conversation_title(&db, conv).await.as_deref(),
            Some("My own name"),
            "a hand-picked session name outranks the card it came from"
        );
    }

    /// A task's session CAN own a chat-channel thread: Telegram's `/resume <id>`
    /// takes any conversation id and binds it to the forum topic it was typed
    /// in (`chat_channel/session_commands.rs::handle_resume`). So the rename has
    /// to walk the same channel-sync path a manual rename does — a locked title
    /// never passes through the auto-title backfill that would otherwise
    /// re-sync the topic, so skipping it here would strand the topic name
    /// forever.
    ///
    /// The remote edit itself is not observable here (a bare manager has no
    /// backend registered, so the sync stops at `NotFound` without touching the
    /// network); what this pins is that the path is wired, reached with a real
    /// binding in place, and leaves the binding row intact.
    #[tokio::test]
    async fn renaming_a_task_syncs_a_bound_session_through_the_channel_path() {
        use crate::chat_channel::types::{ChannelMessageTarget, TELEGRAM_FORUM_THREAD_KIND};
        use crate::db::service::thread_binding_service;

        let db = fresh_in_memory_db().await;
        let folder_id = seed_folder(&db, "/tmp/wt-retitle-bound").await;
        let task = work_task_service::create(&db.conn, draft(folder_id, "Fix login", None))
            .await
            .unwrap();
        let conv = seed_conversation(&db, folder_id, AgentType::ClaudeCode).await;
        crate::db::service::conversation_service::update_title(
            &db.conn,
            conv,
            "Fix login".to_string(),
        )
        .await
        .unwrap();
        bind_conversation(&db, task.id, conv).await;

        // The binding is FK-constrained to a real channel row.
        let channel = {
            use sea_orm::{ActiveModelTrait, NotSet, Set};
            let now = chrono::Utc::now();
            crate::db::entities::chat_channel::ActiveModel {
                id: NotSet,
                name: Set("tg".to_string()),
                channel_type: Set("telegram".to_string()),
                enabled: Set(true),
                config_json: Set("{}".to_string()),
                event_filter_json: Set(None),
                daily_report_enabled: Set(false),
                daily_report_time: Set(None),
                created_at: Set(now),
                updated_at: Set(now),
            }
            .insert(&db.conn)
            .await
            .expect("seed channel")
            .id
        };
        let target = ChannelMessageTarget {
            channel_id: channel,
            chat_id: Some("-100123".to_string()),
            thread_key: Some("42".to_string()),
            thread_kind: Some(TELEGRAM_FORUM_THREAD_KIND.to_string()),
            provider_payload: None,
        };
        thread_binding_service::upsert_for_target(
            &db.conn,
            &target,
            "telegram",
            conv,
            None,
            "sender",
            Some("Fix login".to_string()),
        )
        .await
        .expect("bind topic");

        work_task_update_core(
            &test_emitter(),
            &db,
            &test_channels(),
            task.id,
            draft(folder_id, "Fix logout too", None),
        )
        .await
        .unwrap();

        assert_eq!(
            conversation_title(&db, conv).await.as_deref(),
            Some("Fix logout too")
        );
        let bindings = thread_binding_service::list_by_conversation(&db.conn, conv)
            .await
            .expect("bindings");
        assert_eq!(bindings.len(), 1, "the binding must survive the rename");
        assert!(
            bindings[0].title_sync_enabled,
            "the rename must not disable title sync on the topic"
        );
    }

    /// A card that never ran has no session to follow it — the edit must still
    /// succeed, untouched by the propagation path.
    #[tokio::test]
    async fn renaming_a_task_without_a_session_is_harmless() {
        let db = fresh_in_memory_db().await;
        let folder_id = seed_folder(&db, "/tmp/wt-retitle-none").await;
        let task = work_task_service::create(&db.conn, draft(folder_id, "Fix login", None))
            .await
            .unwrap();

        let info = work_task_update_core(
            &test_emitter(),
            &db,
            &test_channels(),
            task.id,
            draft(folder_id, "Renamed", None),
        )
        .await
        .unwrap();
        assert_eq!(info.title, "Renamed");
    }

    /// "Handle later" from the board: the row moves (the change broadcast
    /// is what re-files the card under Done on every open client), and a
    /// refusal says which way it was refused without broadcasting anything.
    #[tokio::test]
    async fn deferring_broadcasts_the_row_and_refusals_stay_quiet() {
        let db = fresh_in_memory_db().await;
        let folder_id = seed_folder(&db, "/tmp/wt-defer-core").await;
        let task = work_task_service::create(&db.conn, draft(folder_id, "Fix login", None))
            .await
            .unwrap();
        let broadcaster = std::sync::Arc::new(crate::web::event_bridge::WebEventBroadcaster::new());
        let mut rx = broadcaster.subscribe();
        let emitter = EventEmitter::test_web_only(broadcaster.clone());

        // A to-do task has nothing to put aside yet.
        let refused = work_task_defer_core(&emitter, &db, task.id, true)
            .await
            .unwrap_err()
            .to_string();
        assert!(refused.contains("reviewed or failed"), "{refused}");
        let not_deferred = work_task_defer_core(&emitter, &db, task.id, false)
            .await
            .unwrap_err()
            .to_string();
        assert!(not_deferred.contains("not put aside"), "{not_deferred}");
        assert!(rx.try_recv().is_err(), "a refusal must not broadcast");

        // Drive it to review, the way the engine does.
        let seq = work_task_service::claim_for_run(&db.conn, task.id, WorkTaskStatus::Todo, "user")
            .await
            .unwrap()
            .unwrap();
        assert!(work_task_service::begin_setup(&db.conn, task.id, seq)
            .await
            .unwrap());
        assert!(
            work_task_service::mark_running(&db.conn, task.id, seq, 1, "c")
                .await
                .unwrap()
        );
        assert!(
            work_task_service::settle_review(&db.conn, task.id, seq, None, None)
                .await
                .unwrap()
        );

        for deferred in [true, false] {
            work_task_defer_core(&emitter, &db, task.id, deferred)
                .await
                .unwrap();
            let event = rx.try_recv().expect("the moved row should broadcast");
            assert_eq!(event.channel, WORK_TASK_CHANGED_EVENT);
            assert_eq!(event.payload["kind"], "upsert");
            assert_eq!(event.payload["id"], task.id);
            assert_eq!(
                work_task_get_core(&db, task.id)
                    .await
                    .unwrap()
                    .deferred_at
                    .is_some(),
                deferred
            );
        }
        assert_eq!(work_task_attention_count_core(&db).await.unwrap(), 1);
    }
}
