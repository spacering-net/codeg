//! `codeg-cli automations`: the saved automations, listed and run now.
//!
//! A run goes through the automation engine, which only one runtime of a data
//! directory drives (the first to start); listing reads the database and
//! works on any. `run` answers once the run is under way — its prompt queued,
//! or, for an automation that queues a work task, the task queued, which is
//! where such a run ends.

use std::time::Duration;

use crate::db::service::automation_service;
use crate::db::AppDatabase;
use crate::models::automation::{AutomationConfig, AutomationRunInfo};

use super::service::CliError;
use super::wire::{
    self, AutomationEntry, AutomationRunGetRequest, AutomationRunState, EVENT_VERSION,
};

/// Longest a `cli_automation_run_get` waits, and how often it looks.
const MAX_WAIT: Duration = Duration::from_secs(25);
const LOOK_EVERY: Duration = Duration::from_millis(500);

pub async fn list(db: &AppDatabase) -> Result<Vec<AutomationEntry>, CliError> {
    let automations = crate::commands::automation::automation_list_core(db)
        .await
        .map_err(|e| CliError::execution("automations_unavailable", e.to_string()))?;
    Ok(automations
        .into_iter()
        .map(|a| {
            let action = serde_json::from_value::<AutomationConfig>(a.config.clone())
                .map(|c| c.action)
                .unwrap_or_default();
            AutomationEntry {
                id: a.id,
                name: a.name,
                enabled: a.enabled,
                trigger: name_of(&a.trigger_kind),
                cron: a.cron,
                agent: a.agent_type,
                action: name_of(&action),
                last_run_status: a.last_run_status,
                last_run_at: a.last_run_at.map(|t| t.to_rfc3339()),
                next_run_at: a.next_run_at.map(|t| t.to_rfc3339()),
            }
        })
        .collect())
}

/// Run automation `id` now, as its "Run now" button does.
pub async fn run(db: &AppDatabase, id: i32) -> Result<AutomationRunState, CliError> {
    // Told apart before the engine is asked: its errors all read alike.
    crate::commands::automation::automation_get_core(db, id)
        .await
        .map_err(|_| {
            CliError::usage("unknown_automation", format!("no automation {id}"))
                .with_next_steps(["codeg-cli automations".to_string()])
        })?;
    if crate::automation::engine().is_none() {
        return Err(CliError::incompatible(
            "automations_elsewhere",
            "this codeg does not run automations: another codeg using the same data directory \
             does (the first of them to start)",
        )
        .with_next_steps([
            "--runtime desktop".to_string(),
            "--runtime server".to_string(),
        ]));
    }
    let active = automation_service::has_active_run(&db.conn, id)
        .await
        .unwrap_or(false);
    if active {
        return Err(CliError::execution(
            "automation_busy",
            format!("automation {id} is running already; a run starts once the last one ended"),
        ));
    }
    // On its own task: a client that goes away drops this handler, and with
    // it an awaited launch half-way — its prompt never sent, its run row
    // left running, the automation busy until the next reconcile.
    let launched =
        tokio::spawn(async move { crate::commands::automation::automation_run_now_core(id).await });
    let run_id = launched
        .await
        .map_err(|e| CliError::execution("automation_failed", e.to_string()))?
        .map_err(|e| CliError::execution("automation_failed", e.to_string()))?;
    get(db, run_id).await
}

/// Automation run `run_id`, waited for (up to `waitMs`) to end.
pub async fn get_waiting(
    db: &AppDatabase,
    req: &AutomationRunGetRequest,
) -> Result<AutomationRunState, CliError> {
    let wait = Duration::from_millis(req.wait_ms.unwrap_or(0)).min(MAX_WAIT);
    let deadline = tokio::time::Instant::now() + wait;
    loop {
        let state = get(db, req.run_id).await?;
        let now = tokio::time::Instant::now();
        if state.is_over() || now >= deadline {
            return Ok(state);
        }
        tokio::time::sleep(LOOK_EVERY.min(deadline - now)).await;
    }
}

async fn get(db: &AppDatabase, run_id: i32) -> Result<AutomationRunState, CliError> {
    let run = automation_service::get_run(&db.conn, run_id)
        .await
        .map_err(|e| CliError::execution("automations_unavailable", e.to_string()))?
        .ok_or_else(|| {
            CliError::unavailable(
                "run_not_found",
                format!("this codeg has no automation run {run_id}"),
            )
        })?;
    Ok(state_of(run))
}

fn state_of(run: AutomationRunInfo) -> AutomationRunState {
    // Only a run that queued a task ends without a conversation of its own:
    // an agent's reply that happens to read like that summary is no task.
    let queued_a_task = run.conversation_id.is_none()
        && run.status == crate::models::automation::AutomationRunStatus::Succeeded;
    let task_id = run
        .summary
        .as_deref()
        .filter(|_| queued_a_task)
        .and_then(crate::automation::engine::queued_task_id);
    AutomationRunState {
        v: EVENT_VERSION,
        kind: "automation_run".into(),
        automation_id: run.automation_id,
        run_id: run.id,
        status: name_of(&run.status),
        conversation_id: run.conversation_id,
        link: run.conversation_id.map(wire::session_link),
        task_id,
        summary: run.summary,
        error: run.error,
    }
}

/// How `value` reads on the wire: `succeeded`, `enqueue_task`, …
fn name_of(value: &impl serde::Serialize) -> String {
    serde_json::to_value(value)
        .ok()
        .and_then(|v| v.as_str().map(str::to_owned))
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::test_helpers;
    use crate::models::automation::AutomationRunStatus;

    fn run_info(status: AutomationRunStatus, summary: Option<&str>) -> AutomationRunInfo {
        AutomationRunInfo {
            id: 41,
            automation_id: 3,
            status,
            trigger: "manual".into(),
            scheduled_for: None,
            started_at: None,
            ended_at: None,
            conversation_id: Some(214),
            worktree_folder_id: None,
            stop_reason: None,
            error: None,
            summary: summary.map(str::to_owned),
            created_at: chrono::Utc::now(),
        }
    }

    #[test]
    fn a_run_reads_as_the_cli_prints_it() {
        let state = state_of(run_info(AutomationRunStatus::Succeeded, Some("all good")));
        assert_eq!(state.status, "succeeded");
        assert!(state.is_over());
        assert_eq!(state.link.as_deref(), Some("codeg://session/214"));
        assert_eq!(state.task_id, None);
        let json = serde_json::to_value(&state).unwrap();
        assert_eq!(json["type"], "automation_run");
        assert_eq!(json["v"], 1);
        assert!(!state_of(run_info(AutomationRunStatus::Running, None)).is_over());
    }

    /// An automation that queues a work task ends with the task queued; the
    /// task's id is what the CLI hands on.
    #[test]
    fn a_queued_tasks_id_is_read_back_from_its_run() {
        let summary = crate::automation::engine::queued_task_summary(17, "Nightly triage");
        let mut queued = run_info(AutomationRunStatus::Succeeded, Some(&summary));
        queued.conversation_id = None;
        let state = state_of(queued);
        assert_eq!(state.task_id, Some(17));
        assert_eq!(state.summary.as_deref(), Some(summary.as_str()));
        // A session whose reply merely reads like it queued no task.
        let session = state_of(run_info(AutomationRunStatus::Succeeded, Some(&summary)));
        assert_eq!(session.task_id, None);
    }

    #[tokio::test]
    async fn an_automation_that_does_not_exist_is_a_usage_error() {
        let db = test_helpers::fresh_in_memory_db().await;
        let err = run(&db, 999).await.unwrap_err();
        assert_eq!(err.body.error.code, "unknown_automation");
        assert_eq!(err.status, 400);
        let err = get_waiting(
            &db,
            &AutomationRunGetRequest {
                run_id: 5,
                wait_ms: None,
            },
        )
        .await
        .unwrap_err();
        assert_eq!(err.body.error.code, "run_not_found");
        assert!(list(&db).await.unwrap().is_empty());
    }
}
