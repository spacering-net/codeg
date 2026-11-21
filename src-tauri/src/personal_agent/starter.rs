//! "One thing at once" (5.4, 1.15): the first thing an assistant can take off
//! the owner's hands in the projects they just connected, found without
//! asking a model, in this order:
//!
//! 1. an open pull request whose checks failed (the owner's own first);
//! 2. a pull request waiting on the owner's review;
//! 3. an open issue assigned to the owner;
//! 4. a failed board task no assistant is behind;
//! 5. a worktree with changes no one has touched for a day.
//!
//! The forge is read through the workbench's own reads, with the account
//! that serves the project's remote — only for projects an account is
//! stored for, as this machine says ([`ForgeReads::served`]), the first
//! [`FORGE_PROJECTS`] of them; a project with no forge, or no account for
//! it, or a forge that cannot answer one of the questions, just has
//! nothing of that kind. The forge's questions (1–3) and the local ones
//! (4–5) are asked side by side, each with its own time: a slow forge
//! leaves the local answer standing. What was shown already is passed back
//! in, so [Another one] moves on.

use std::collections::HashSet;
use std::path::Path;
use std::time::Duration;

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use sea_orm::{ColumnTrait, EntityTrait, QueryFilter, QueryOrder};
use serde_json::{json, Value};

use super::overview::{board, Folders};
use crate::db::entities::folder;
use crate::db::entities::work_task::{self, WorkTaskStatus};
use crate::db::AppDatabase;
use crate::forge::{
    ChangeQuery, ForgeCheckList, ForgeCheckState, ForgeIssueRow, ForgeSort, ForgeTab, ListFilters,
};

/// Open pull requests read per project, and how many of them have their
/// checks read.
const PRS_READ: u32 = 10;
const CHECKS_READ: usize = 3;
/// Rows read for the review and assignment questions.
const ROWS_READ: u32 = 5;
/// Changes untouched this long make a worktree's changes forgotten.
const STALE_HOURS: i64 = 24;
/// Worktrees looked into, and files of each whose times are read.
const WORKTREES_READ: usize = 20;
const FILES_STATTED: usize = 2_000;
/// The longest the whole search may take: a forge that hangs is a forge
/// with nothing to say.
pub(super) const FIND_TIMEOUT: Duration = Duration::from_secs(90);
/// The forge's questions take this long at most, the local ones this long;
/// both within [`FIND_TIMEOUT`].
const FORGE_BUDGET: Duration = Duration::from_secs(60);
const LOCAL_BUDGET: Duration = Duration::from_secs(75);
/// The projects whose forge is asked, at most.
const FORGE_PROJECTS: usize = 8;
const GIT_TIMEOUT: Duration = Duration::from_secs(10);

/// One project to look in: its id and the name it goes by.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct Project {
    pub id: i32,
    pub name: String,
}

/// The forge questions the search asks, one project at a time — an error
/// (no remote, no account, a forge that cannot filter so) is "nothing".
#[async_trait]
pub(super) trait ForgeReads: Send + Sync {
    /// Open pull requests, most recently updated first.
    async fn open_prs(&self, project: i32) -> Result<Vec<ForgeIssueRow>, String>;
    async fn checks(&self, project: i32, number: i64) -> Result<ForgeCheckList, String>;
    /// Open pull requests whose review is requested of the owner.
    async fn review_requested(&self, project: i32) -> Result<Vec<ForgeIssueRow>, String>;
    /// Open issues assigned to the owner.
    async fn assigned(&self, project: i32) -> Result<Vec<ForgeIssueRow>, String>;
    /// The owner's login on the project's forge.
    async fn login(&self, project: i32) -> Option<String>;
    /// Whether an account stored on this machine serves the project's
    /// remote — read off git and the stored accounts, nothing asked of a
    /// forge.
    async fn served(&self, project: i32) -> super::projects::Served;
}

/// The workbench's reads.
pub(super) struct LiveForge<'a> {
    pub db: &'a AppDatabase,
}

fn filters(tab: ForgeTab, per_page: u32) -> ListFilters {
    ListFilters {
        tab,
        state: "open".into(),
        assigned_me: false,
        labels: Vec::new(),
        search: None,
        sort: ForgeSort::RecentlyUpdated,
        page: 1,
        per_page,
        account_id: None,
    }
}

#[async_trait]
impl ForgeReads for LiveForge<'_> {
    async fn open_prs(&self, project: i32) -> Result<Vec<ForgeIssueRow>, String> {
        crate::commands::forge::forge_list_issues_core(
            self.db,
            project,
            filters(ForgeTab::Prs, PRS_READ),
        )
        .await
        .map(|l| l.rows)
        .map_err(|e| e.to_string())
    }

    async fn checks(&self, project: i32, number: i64) -> Result<ForgeCheckList, String> {
        crate::commands::forge::forge_change_detail_core(
            self.db,
            project,
            ChangeQuery {
                number,
                account_id: None,
            },
        )
        .await
        .map(|d| d.checks)
        .map_err(|e| e.to_string())
    }

    async fn review_requested(&self, project: i32) -> Result<Vec<ForgeIssueRow>, String> {
        crate::commands::forge::forge_list_review_requested_core(
            self.db,
            project,
            filters(ForgeTab::Prs, ROWS_READ),
        )
        .await
        .map(|l| l.rows)
        .map_err(|e| e.to_string())
    }

    async fn assigned(&self, project: i32) -> Result<Vec<ForgeIssueRow>, String> {
        let mut f = filters(ForgeTab::Issues, ROWS_READ);
        f.assigned_me = true;
        crate::commands::forge::forge_list_issues_core(self.db, project, f)
            .await
            .map(|l| l.rows)
            .map_err(|e| e.to_string())
    }

    async fn login(&self, project: i32) -> Option<String> {
        crate::commands::forge::forge_identity_core(self.db, project, None)
            .await
            .ok()
            .map(|i| i.username)
    }

    async fn served(&self, project: i32) -> super::projects::Served {
        let Ok(Some(f)) = folder::Entity::find_by_id(project).one(&self.db.conn).await else {
            return super::projects::Served::No;
        };
        (&super::projects::forge_status(self.db, &f.path).await).into()
    }
}

/// The checks that failed and are not allowed to.
fn failed_checks(list: &ForgeCheckList) -> Vec<String> {
    list.checks
        .iter()
        .filter(|c| c.state == ForgeCheckState::Failure && !c.allow_failure)
        .map(|c| c.name.clone())
        .collect()
}

fn project_json(p: &Project) -> Value {
    json!({ "id": p.id, "name": p.name })
}

/// A forge item as a lead: what the card shows and what [Hand it to me]
/// says.
fn item_lead(kind: &str, key: String, p: &Project, row: &ForgeIssueRow) -> Value {
    json!({
        "key": key,
        "kind": kind,
        "project": project_json(p),
        "number": row.number,
        "title": row.title,
        "url": row.html_url,
    })
}

/// The first lead not in `seen`, or `None` when there is nothing to offer:
/// the forge's, when it has one in its time; else the local one.
pub(super) async fn find(
    db: &AppDatabase,
    forge: &dyn ForgeReads,
    projects: &[Project],
    seen: &HashSet<String>,
    now: DateTime<Utc>,
) -> Option<Value> {
    find_within(db, forge, projects, seen, now, FORGE_BUDGET, LOCAL_BUDGET).await
}

/// [`find`], the forge's questions given `forge_budget`, the local ones
/// `local_budget`.
pub(super) async fn find_within(
    db: &AppDatabase,
    forge: &dyn ForgeReads,
    projects: &[Project],
    seen: &HashSet<String>,
    now: DateTime<Utc>,
    forge_budget: Duration,
    local_budget: Duration,
) -> Option<Value> {
    let from_forge = tokio::time::timeout(forge_budget, async {
        let mut served: Vec<Project> = Vec::new();
        for p in projects {
            if served.len() >= FORGE_PROJECTS {
                break;
            }
            if forge.served(p.id).await == super::projects::Served::Yes {
                served.push(p.clone());
            }
        }
        forge_lead(forge, &served, seen).await
    });
    let from_here = tokio::time::timeout(local_budget, local_lead(db, projects, seen, now));
    let (forge, local) = tokio::join!(from_forge, from_here);
    forge.ok().flatten().or(local.ok().flatten())
}

/// Steps 1–3: what the forge has for the owner.
async fn forge_lead(
    forge: &dyn ForgeReads,
    projects: &[Project],
    seen: &HashSet<String>,
) -> Option<Value> {
    // 1. A pull request whose checks failed: the owner's own first.
    for p in projects {
        let Ok(prs) = forge.open_prs(p.id).await else {
            continue;
        };
        let login = forge.login(p.id).await;
        let mut prs: Vec<&ForgeIssueRow> = prs.iter().filter(|r| r.is_pr).collect();
        // Stable: the forge's own order (most recently updated) within each.
        prs.sort_by_key(|r| login.is_none() || r.author != login);
        for row in prs.into_iter().take(CHECKS_READ) {
            let key = format!("pr:{}:{}", p.id, row.number);
            if seen.contains(&key) {
                continue;
            }
            let Ok(checks) = forge.checks(p.id, row.number).await else {
                continue;
            };
            let failed = failed_checks(&checks);
            if failed.is_empty() {
                continue;
            }
            let mut lead = item_lead("pr_ci", key, p, row);
            lead["checks"] = json!(failed.into_iter().take(3).collect::<Vec<_>>());
            return Some(lead);
        }
    }
    // 2. A pull request waiting on the owner's review.
    for p in projects {
        let Ok(rows) = forge.review_requested(p.id).await else {
            continue;
        };
        if let Some(row) = rows
            .iter()
            .find(|r| !seen.contains(&format!("pr:{}:{}", p.id, r.number)))
        {
            return Some(item_lead(
                "review",
                format!("pr:{}:{}", p.id, row.number),
                p,
                row,
            ));
        }
    }
    // 3. An issue assigned to the owner.
    for p in projects {
        let Ok(rows) = forge.assigned(p.id).await else {
            continue;
        };
        if let Some(row) = rows
            .iter()
            .find(|r| !r.is_pr && !seen.contains(&format!("issue:{}:{}", p.id, r.number)))
        {
            return Some(item_lead(
                "issue",
                format!("issue:{}:{}", p.id, row.number),
                p,
                row,
            ));
        }
    }
    None
}

/// Steps 4–5: what is left at home.
async fn local_lead(
    db: &AppDatabase,
    projects: &[Project],
    seen: &HashSet<String>,
    now: DateTime<Utc>,
) -> Option<Value> {
    let ids: HashSet<i32> = projects.iter().map(|p| p.id).collect();
    // 4. A failed board task no assistant is behind.
    let folders = Folders::load(db).await;
    let mut failed: Vec<work_task::Model> = board(db, None)
        .await
        .into_iter()
        .filter(|t| {
            t.status == WorkTaskStatus::Failed
                && t.deferred_at.is_none()
                && t.personal_agent_dispatch_id.is_none()
                && folders
                    .project(t.folder_id)
                    .is_some_and(|(id, _)| ids.contains(&id))
        })
        .collect();
    failed.sort_by_key(|t| std::cmp::Reverse(t.updated_at));
    if let Some(t) = failed
        .iter()
        .find(|t| !seen.contains(&format!("task:{}", t.id)))
    {
        let p = projects.iter().find(|p| {
            folders
                .project(t.folder_id)
                .is_some_and(|(id, _)| id == p.id)
        });
        return Some(json!({
            "key": format!("task:{}", t.id),
            "kind": "task",
            "project": p.map(project_json),
            "task_id": t.id,
            "title": t.title,
        }));
    }
    // 5. A worktree whose changes no one has touched for a day.
    stale_worktree(db, projects, seen, now).await
}

/// The first worktree of these projects, not a board task's, with changes
/// whose newest is more than a day old.
async fn stale_worktree(
    db: &AppDatabase,
    projects: &[Project],
    seen: &HashSet<String>,
    now: DateTime<Utc>,
) -> Option<Value> {
    let ids: Vec<i32> = projects.iter().map(|p| p.id).collect();
    let trees = folder::Entity::find()
        .filter(folder::Column::ParentId.is_in(ids))
        .filter(folder::Column::DeletedAt.is_null())
        .order_by_desc(folder::Column::LastOpenedAt)
        .all(&db.conn)
        .await
        .ok()?;
    // A board task's worktree is the board's to look after.
    let tasks: HashSet<i32> = work_task::Entity::find()
        .filter(work_task::Column::DeletedAt.is_null())
        .filter(work_task::Column::WorktreeFolderId.is_not_null())
        .all(&db.conn)
        .await
        .unwrap_or_default()
        .into_iter()
        .filter_map(|t| t.worktree_folder_id)
        .collect();
    for tree in trees.into_iter().take(WORKTREES_READ) {
        let key = format!("worktree:{}", tree.id);
        if tasks.contains(&tree.id) || seen.contains(&key) {
            continue;
        }
        let Some((changed, newest)) = untouched_changes(Path::new(&tree.path)).await else {
            continue;
        };
        if changed == 0 || (now - newest).num_hours() < STALE_HOURS {
            continue;
        }
        let p = projects.iter().find(|p| Some(p.id) == tree.parent_id);
        return Some(json!({
            "key": key,
            "kind": "worktree",
            "project": p.map(project_json),
            "folder_id": tree.id,
            "title": tree.alias.clone().unwrap_or_else(|| tree.name.clone()),
            "path": tree.path,
            "branch": tree.git_branch,
            "changed": changed,
            "since": newest,
        }));
    }
    None
}

/// How many files a checkout has changes in, and when the newest of them
/// was last written — `None` when git cannot say.
pub(super) async fn untouched_changes(dir: &Path) -> Option<(usize, DateTime<Utc>)> {
    if !dir.is_dir() {
        return None;
    }
    let mut cmd = crate::process::tokio_command("git");
    cmd.arg("-C")
        .arg(dir)
        .args(["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
    let out = tokio::time::timeout(GIT_TIMEOUT, cmd.output())
        .await
        .ok()?
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let paths = porcelain_paths(&out.stdout);
    let mut newest: Option<DateTime<Utc>> = None;
    for p in paths.iter().take(FILES_STATTED) {
        // A deleted file has no time: the others say when.
        if let Ok(modified) = std::fs::metadata(dir.join(p)).and_then(|m| m.modified()) {
            let t: DateTime<Utc> = modified.into();
            newest = Some(newest.map_or(t, |n| n.max(t)));
        }
    }
    let newest = match newest {
        Some(t) => t,
        // Only deletions: when the checkout last changed.
        None if !paths.is_empty() => std::fs::metadata(dir)
            .and_then(|m| m.modified())
            .ok()?
            .into(),
        None => return Some((0, Utc::now())),
    };
    Some((paths.len(), newest))
}

/// The paths of `git status --porcelain=v1 -z`: each entry is `XY path`, and
/// a rename or copy carries its old path as the next entry.
fn porcelain_paths(out: &[u8]) -> Vec<String> {
    let mut paths = Vec::new();
    let mut entries = out.split(|b| *b == 0).filter(|e| !e.is_empty());
    while let Some(e) = entries.next() {
        if e.len() < 4 {
            continue;
        }
        let renamed = matches!(e[0], b'R' | b'C');
        paths.push(String::from_utf8_lossy(&e[3..]).into_owned());
        if renamed {
            entries.next();
        }
    }
    paths
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_status_lists_each_changed_path_once_and_a_rename_by_its_new_name() {
        let out = b" M src/a.rs\0?? notes.md\0R  new.rs\0old.rs\0 D gone.rs\0";
        assert_eq!(
            porcelain_paths(out),
            vec!["src/a.rs", "notes.md", "new.rs", "gone.rs"]
        );
        assert!(porcelain_paths(b"").is_empty());
    }

    #[test]
    fn only_a_failure_that_blocks_counts() {
        use crate::forge::ForgeCheck;
        let check = |name: &str, state, allow_failure| ForgeCheck {
            id: name.into(),
            name: name.into(),
            state,
            summary: None,
            url: None,
            allow_failure,
        };
        let list = ForgeCheckList::available(vec![
            check("lint", ForgeCheckState::Failure, false),
            check("flaky", ForgeCheckState::Failure, true),
            check("test", ForgeCheckState::Success, false),
        ]);
        assert_eq!(failed_checks(&list), vec!["lint"]);
    }
}
