//! Automation CRUD commands. The `*_core` fns are mode-agnostic (plain
//! references, no `tauri::State`) and emit [`AUTOMATION_CHANGED_EVENT`] so both
//! the Tauri command wrappers and the Axum handlers share one code path. The
//! `#[tauri::command]` wrappers are desktop-only and build an
//! `EventEmitter::Tauri` from the `AppHandle`.

use chrono::{DateTime, Utc};

use crate::db::error::DbError;
use crate::db::service::automation_service;
use crate::db::AppDatabase;
use crate::models::{AutomationDraft, AutomationInfo, AutomationRunInfo};
use crate::web::event_bridge::{
    emit_event, AutomationChange, EventEmitter, AUTOMATION_CHANGED_EVENT,
};

// ── shared business logic (both modes) ──────────────────────────────────────

pub async fn automation_list_core(db: &AppDatabase) -> Result<Vec<AutomationInfo>, DbError> {
    automation_service::list(&db.conn).await
}

pub async fn automation_get_core(db: &AppDatabase, id: i32) -> Result<AutomationInfo, DbError> {
    automation_service::get(&db.conn, id).await
}

pub async fn automation_runs_core(
    db: &AppDatabase,
    automation_id: i32,
    limit: u64,
) -> Result<Vec<AutomationRunInfo>, DbError> {
    automation_service::list_runs(&db.conn, automation_id, limit).await
}

pub async fn automation_create_core(
    emitter: &EventEmitter,
    db: &AppDatabase,
    draft: AutomationDraft,
) -> Result<AutomationInfo, DbError> {
    let info = automation_service::create(&db.conn, draft).await?;
    emit_event(
        emitter,
        AUTOMATION_CHANGED_EVENT,
        AutomationChange::Upsert { id: info.id },
    );
    Ok(info)
}

pub async fn automation_update_core(
    emitter: &EventEmitter,
    db: &AppDatabase,
    id: i32,
    draft: AutomationDraft,
) -> Result<AutomationInfo, DbError> {
    let info = automation_service::update(&db.conn, id, draft).await?;
    emit_event(
        emitter,
        AUTOMATION_CHANGED_EVENT,
        AutomationChange::Upsert { id: info.id },
    );
    Ok(info)
}

pub async fn automation_set_enabled_core(
    emitter: &EventEmitter,
    db: &AppDatabase,
    id: i32,
    enabled: bool,
) -> Result<AutomationInfo, DbError> {
    let info = automation_service::set_enabled(&db.conn, id, enabled).await?;
    emit_event(
        emitter,
        AUTOMATION_CHANGED_EVENT,
        AutomationChange::Upsert { id: info.id },
    );
    Ok(info)
}

pub async fn automation_delete_core(
    emitter: &EventEmitter,
    db: &AppDatabase,
    id: i32,
) -> Result<(), DbError> {
    automation_service::delete(&db.conn, id).await?;
    emit_event(
        emitter,
        AUTOMATION_CHANGED_EVENT,
        AutomationChange::Deleted { id },
    );
    Ok(())
}

pub async fn automation_mark_seen_core(db: &AppDatabase) -> Result<(), DbError> {
    automation_service::mark_all_seen(&db.conn).await
}

/// Editor "next run" preview. Authoritative — shares the exact cron evaluator the
/// scheduler uses, so the previewed time can never diverge from the actual fire.
pub fn automation_compute_next_run_core(
    cron: &str,
    timezone: &str,
) -> Result<Option<DateTime<Utc>>, DbError> {
    automation_service::compute_next_run(cron, timezone, Utc::now())
}

// ── Tauri command wrappers (desktop only) ───────────────────────────────────

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn automation_list(
    db: tauri::State<'_, AppDatabase>,
) -> Result<Vec<AutomationInfo>, DbError> {
    automation_list_core(&db).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn automation_get(
    db: tauri::State<'_, AppDatabase>,
    id: i32,
) -> Result<AutomationInfo, DbError> {
    automation_get_core(&db, id).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn automation_runs(
    db: tauri::State<'_, AppDatabase>,
    automation_id: i32,
    limit: u64,
) -> Result<Vec<AutomationRunInfo>, DbError> {
    automation_runs_core(&db, automation_id, limit).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn automation_create(
    app: tauri::AppHandle,
    db: tauri::State<'_, AppDatabase>,
    draft: AutomationDraft,
) -> Result<AutomationInfo, DbError> {
    automation_create_core(&EventEmitter::from_app(&app), &db, draft).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn automation_update(
    app: tauri::AppHandle,
    db: tauri::State<'_, AppDatabase>,
    id: i32,
    draft: AutomationDraft,
) -> Result<AutomationInfo, DbError> {
    automation_update_core(&EventEmitter::from_app(&app), &db, id, draft).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn automation_set_enabled(
    app: tauri::AppHandle,
    db: tauri::State<'_, AppDatabase>,
    id: i32,
    enabled: bool,
) -> Result<AutomationInfo, DbError> {
    automation_set_enabled_core(&EventEmitter::from_app(&app), &db, id, enabled).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn automation_delete(
    app: tauri::AppHandle,
    db: tauri::State<'_, AppDatabase>,
    id: i32,
) -> Result<(), DbError> {
    automation_delete_core(&EventEmitter::from_app(&app), &db, id).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn automation_mark_seen(
    db: tauri::State<'_, AppDatabase>,
) -> Result<(), DbError> {
    automation_mark_seen_core(&db).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn automation_compute_next_run(
    cron: String,
    timezone: String,
) -> Result<Option<DateTime<Utc>>, DbError> {
    automation_compute_next_run_core(&cron, &timezone)
}

// ── engine-dispatched ops (manual run / cancel) ─────────────────────────────

/// Manual "Run now" — fire immediately, bypassing the schedule. Returns the new
/// run id. Routes through the process-global engine (spawned in both modes).
pub async fn automation_run_now_core(automation_id: i32) -> Result<i32, DbError> {
    let engine = crate::automation::engine()
        .ok_or_else(|| DbError::Validation("automation engine not running".to_string()))?;
    engine
        .run_automation(automation_id, "manual", None)
        .await
        .map_err(DbError::Validation)
}

/// Cancel an in-flight (or clear a wedged) run.
pub async fn automation_cancel_run_core(run_id: i32) -> Result<(), DbError> {
    let engine = crate::automation::engine()
        .ok_or_else(|| DbError::Validation("automation engine not running".to_string()))?;
    engine.cancel_run(run_id).await.map_err(DbError::Validation)
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn automation_run_now(automation_id: i32) -> Result<i32, DbError> {
    automation_run_now_core(automation_id).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn automation_cancel_run(run_id: i32) -> Result<(), DbError> {
    automation_cancel_run_core(run_id).await
}
