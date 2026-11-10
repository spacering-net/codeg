//! The PR ladder (8.5): where a piece of handed-out work stands, read from
//! the dispatch and — for a task — the kanban task behind it, which is the
//! fresher of the two (the dispatch follows the board on a poll).

use std::collections::HashMap;

use sea_orm::{ColumnTrait, EntityTrait, QueryFilter};

use crate::db::entities::personal_agent_dispatch::{
    self as dispatch_entity, DispatchMode, DispatchState,
};
use crate::db::entities::work_task::{self, WorkTaskStatus};
use crate::db::AppDatabase;
use crate::models::personal_agent_overview::{Ladder, TaskFacts};

/// Where dispatch `d` stands; `task` is its kanban task when it has one.
pub fn ladder_of(d: &dispatch_entity::Model, task: Option<&work_task::Model>) -> Ladder {
    // What the owner did to the dispatch itself comes first: a stop or a
    // takeover stands whatever the board has not caught up with yet.
    match d.state {
        DispatchState::Canceled => return Ladder::Canceled,
        DispatchState::HandedOver => return Ladder::HandedOver,
        _ => {}
    }
    if let (DispatchMode::Task, Some(t)) = (d.mode, task) {
        return task_ladder(t);
    }
    match d.state {
        DispatchState::Queued | DispatchState::Running => Ladder::Working,
        DispatchState::WaitingInput => Ladder::WaitingYou,
        DispatchState::Review => Ladder::Mergeable,
        DispatchState::Completed => Ladder::Done,
        DispatchState::Failed | DispatchState::Interrupted => Ladder::Failed,
        DispatchState::Canceled => Ladder::Canceled,
        DispatchState::HandedOver => Ladder::HandedOver,
    }
}

/// Where a dispatch stands for the owner: one waiting on a question its
/// assistant is answering is still working, as far as they are concerned
/// (7.3.1).
pub fn for_owner(ladder: Ladder, answering: bool) -> Ladder {
    if answering && ladder == Ladder::WaitingYou {
        Ladder::Working
    } else {
        ladder
    }
}

/// Where a kanban task stands.
pub fn task_ladder(t: &work_task::Model) -> Ladder {
    let set_aside = t.deferred_at.is_some();
    match t.status {
        WorkTaskStatus::Todo
        | WorkTaskStatus::Queued
        | WorkTaskStatus::Preparing
        | WorkTaskStatus::Running => Ladder::Working,
        WorkTaskStatus::AwaitingInput if set_aside => Ladder::Paused,
        WorkTaskStatus::AwaitingInput => Ladder::WaitingYou,
        WorkTaskStatus::Review if set_aside => Ladder::Paused,
        WorkTaskStatus::Review => Ladder::Mergeable,
        WorkTaskStatus::Merging => Ladder::Merging,
        WorkTaskStatus::Done => match t.completion_kind.as_deref() {
            Some("delivered_pr") => Ladder::PrOpen,
            Some("accepted_without_merge") => Ladder::Done,
            Some(_) => Ladder::Merged,
            // A row from before the column: a merge left its commit.
            None if t.merge_commit.is_some() => Ladder::Merged,
            None => Ladder::Done,
        },
        WorkTaskStatus::Failed if set_aside => Ladder::Paused,
        WorkTaskStatus::Failed => Ladder::Failed,
        WorkTaskStatus::Canceled => Ladder::Canceled,
    }
}

/// The pull request a task's latest delivery reached: a task of codeg's own
/// records it in `delivery`, one from an issue or a PR in its source; a
/// task working on a PR is about that PR until it delivers elsewhere.
pub fn pr_of(t: &work_task::Model) -> (Option<String>, Option<i64>) {
    let read = |raw: &Option<String>| -> serde_json::Value {
        raw.as_deref()
            .and_then(|s| serde_json::from_str(s).ok())
            .unwrap_or(serde_json::Value::Null)
    };
    let text = |v: &serde_json::Value, key: &str| {
        v.get(key)
            .and_then(|x| x.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
    };
    let delivery = read(&t.delivery);
    if let Some(url) = text(&delivery, "pr_url") {
        return (
            Some(url),
            delivery.get("pr_number").and_then(|n| n.as_i64()),
        );
    }
    let meta = read(&t.source_meta);
    if let Some(url) = text(&meta, "result_pr") {
        return (
            Some(url),
            meta.get("result_pr_number").and_then(|n| n.as_i64()),
        );
    }
    if t.source_kind.as_deref() == Some("forge_pr") {
        if let Some(url) = text(&meta, "url") {
            return (Some(url), meta.get("number").and_then(|n| n.as_i64()));
        }
    }
    (None, None)
}

/// Where a task's pull request is, as the task recorded it: the repository
/// and account it delivered with, and the PR's number. `None` when the task
/// recorded no PR number, or an older row no coordinates.
pub fn pr_target(t: &work_task::Model) -> Option<(crate::forge::DeliveryTarget, i64)> {
    if let Some(d) = t
        .delivery
        .as_deref()
        .and_then(|raw| serde_json::from_str::<crate::forge::WorkTaskDelivery>(raw).ok())
    {
        return Some((d.target, d.pr_number));
    }
    let meta = t
        .source_meta
        .as_deref()
        .and_then(|raw| serde_json::from_str::<crate::forge::ForgeSourceMeta>(raw).ok())?;
    let number = match (meta.result_pr_number, t.source_kind.as_deref()) {
        (Some(n), _) => n,
        (None, Some("forge_pr")) if meta.result_pr.is_none() => meta.number,
        _ => return None,
    };
    Some((
        crate::forge::DeliveryTarget {
            provider: meta.provider,
            server_host: meta.server_host,
            account_id: meta.account_id,
            owner_repo: meta.owner_repo,
        },
        number,
    ))
}

/// A task as its card shows it.
pub fn task_facts(t: &work_task::Model) -> TaskFacts {
    let (pr_url, pr_number) = pr_of(t);
    let live = matches!(
        t.status,
        WorkTaskStatus::Preparing
            | WorkTaskStatus::Running
            | WorkTaskStatus::AwaitingInput
            | WorkTaskStatus::Merging
    );
    TaskFacts {
        task_id: t.id,
        status: t.status,
        folder_id: t.folder_id,
        branch: t.work_branch.clone(),
        base_branch: t.base_branch.clone(),
        files_changed: t.files_changed,
        additions: t.additions,
        deletions: t.deletions,
        pr_url,
        pr_number,
        completion_kind: t.completion_kind.clone(),
        conversation_id: t.conversation_id,
        // The connection outlives its round on the row; only a live round's
        // is one to follow.
        connection_id: if live { t.connection_id.clone() } else { None },
        started_at: t.started_at,
        finished_at: t.finished_at,
    }
}

/// The kanban tasks of `dispatches`, by task id (deleted ones are absent).
pub async fn tasks_of(
    db: &AppDatabase,
    dispatches: &[dispatch_entity::Model],
) -> HashMap<i32, work_task::Model> {
    let ids: Vec<i32> = dispatches
        .iter()
        .filter(|d| d.mode == DispatchMode::Task)
        .filter_map(|d| d.work_task_id)
        .collect();
    if ids.is_empty() {
        return HashMap::new();
    }
    work_task::Entity::find()
        .filter(work_task::Column::Id.is_in(ids))
        .filter(work_task::Column::DeletedAt.is_null())
        .all(&db.conn)
        .await
        .unwrap_or_default()
        .into_iter()
        .map(|t| (t.id, t))
        .collect()
}

/// A diff in a few words: "+214 −37 in 6 files".
pub fn diff_phrase(t: &work_task::Model) -> Option<String> {
    let (Some(a), Some(d)) = (t.additions, t.deletions) else {
        return None;
    };
    Some(match t.files_changed {
        Some(n) => format!("+{a} −{d} in {n} file{}", if n == 1 { "" } else { "s" }),
        None => format!("+{a} −{d}"),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn task(status: WorkTaskStatus) -> work_task::Model {
        let now = chrono::Utc::now();
        work_task::Model {
            id: 7,
            folder_id: 1,
            title: "t".into(),
            config: "{}".into(),
            status,
            failure_reason: None,
            last_error: None,
            run_seq: 1,
            sort_order: 0,
            worktree_folder_id: None,
            conversation_id: Some(3),
            connection_id: Some("c".into()),
            base_branch: Some("main".into()),
            base_sha: None,
            work_branch: Some("pa/fix".into()),
            merge_state: None,
            pending_merge: None,
            cleanup_state: None,
            verdict: None,
            result_summary: None,
            files_changed: Some(6),
            additions: Some(214),
            deletions: Some(37),
            merge_commit: None,
            completion_kind: None,
            preflight: None,
            archived_at: None,
            scheduled_at: None,
            deferred_at: None,
            source_kind: None,
            source_key: None,
            source_meta: None,
            delivery: None,
            personal_agent_dispatch_id: Some(1),
            created_at: now,
            updated_at: now,
            started_at: Some(now),
            settled_at: None,
            finished_at: None,
            deleted_at: None,
        }
    }

    #[test]
    fn a_task_is_finished_when_merged_and_ready_to_merge_in_review() {
        assert_eq!(task_ladder(&task(WorkTaskStatus::Running)), Ladder::Working);
        assert_eq!(
            task_ladder(&task(WorkTaskStatus::Review)),
            Ladder::Mergeable
        );
        let mut t = task(WorkTaskStatus::Review);
        t.deferred_at = Some(chrono::Utc::now());
        assert_eq!(task_ladder(&t), Ladder::Paused);
        let mut t = task(WorkTaskStatus::Done);
        t.completion_kind = Some("delivered_pr".into());
        assert_eq!(task_ladder(&t), Ladder::PrOpen);
        t.completion_kind = Some("merged".into());
        assert_eq!(task_ladder(&t), Ladder::Merged);
        t.completion_kind = Some("accepted_without_merge".into());
        assert_eq!(task_ladder(&t), Ladder::Done);
        assert_eq!(diff_phrase(&t).as_deref(), Some("+214 −37 in 6 files"));
    }

    #[test]
    fn the_pr_is_where_the_latest_delivery_went() {
        let mut t = task(WorkTaskStatus::Done);
        assert_eq!(pr_of(&t), (None, None));
        t.delivery = Some(
            r#"{"provider":"github","server_host":"github.com","account_id":"a","owner_repo":"o/r","pr_url":"https://github.com/o/r/pull/9","pr_number":9}"#
                .into(),
        );
        assert_eq!(
            pr_of(&t),
            (Some("https://github.com/o/r/pull/9".into()), Some(9))
        );
        t.delivery = None;
        t.source_kind = Some("forge_pr".into());
        t.source_meta = Some(r#"{"url":"https://github.com/o/r/pull/4","number":4}"#.into());
        assert_eq!(
            pr_of(&t),
            (Some("https://github.com/o/r/pull/4".into()), Some(4))
        );
        t.source_meta = Some(
            r#"{"url":"https://github.com/o/r/issues/4","number":4,"result_pr":"https://github.com/o/r/pull/5","result_pr_number":5}"#
                .into(),
        );
        assert_eq!(
            pr_of(&t),
            (Some("https://github.com/o/r/pull/5".into()), Some(5))
        );
        // The PR is read where the task recorded it, not at the project's
        // origin of the day.
        let mut d = task(WorkTaskStatus::Done);
        d.delivery = Some(
            r#"{"provider":"github","server_host":"github.com","account_id":"acc","owner_repo":"fork/r","pr_url":"https://github.com/fork/r/pull/9","pr_number":9}"#
                .into(),
        );
        let (target, n) = pr_target(&d).unwrap();
        assert_eq!(
            (target.owner_repo.as_str(), target.account_id.as_str(), n),
            ("fork/r", "acc", 9)
        );
        assert!(pr_target(&task(WorkTaskStatus::Done)).is_none());
        // A finished round's connection is not one to follow.
        assert_eq!(task_facts(&t).connection_id, None);
        assert_eq!(
            task_facts(&task(WorkTaskStatus::Running))
                .connection_id
                .as_deref(),
            Some("c")
        );
    }
}
