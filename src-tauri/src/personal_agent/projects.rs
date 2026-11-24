//! The projects the assistants keep an eye on (`prefs.projects`): every
//! project open in codeg — new ones too — or only those the owner picked.
//!
//! A project that may be kept an eye on is a top-level folder of the
//! owner's that is open in the workspace ([`eligible_projects`]): closing
//! one takes it off the workspace, and so off what is watched, until it is
//! opened again. A list keeps the ids of projects closed or deleted; they
//! count again when the project is back.
//!
//! Which forge a project is on, and whether an account serves it, is read
//! off this machine alone ([`origin_host`], the stored accounts): listing
//! the projects, or deciding whether to ask a forge about one, never waits
//! on the network.

use std::time::Duration;

use futures::StreamExt;
use sea_orm::{ColumnTrait, ConnectionTrait, EntityTrait, QueryFilter, QueryOrder};
use serde::Serialize;

use crate::db::entities::folder::{self, FolderKind};
use crate::db::AppDatabase;
use crate::forge::ForgeProvider;
use crate::models::personal_agent_prefs::{Prefs, ProjectScope};
use crate::models::system::GitHubAccount;

/// The longest `git remote get-url` may take for one project.
const REMOTE_TIMEOUT: Duration = Duration::from_secs(3);
/// Projects whose remote is read at once.
const REMOTES_AT_ONCE: usize = 8;

/// The projects that may be kept an eye on, the one opened last first.
pub async fn eligible_in<C: ConnectionTrait>(
    conn: &C,
) -> Result<Vec<folder::Model>, sea_orm::DbErr> {
    folder::Entity::find()
        .filter(folder::Column::DeletedAt.is_null())
        .filter(folder::Column::IsOpen.eq(true))
        .filter(folder::Column::ParentId.is_null())
        .filter(folder::Column::Kind.eq(FolderKind::Regular))
        .order_by_desc(folder::Column::LastOpenedAt)
        .all(conn)
        .await
}

/// [`eligible_in`] on the database; none when it cannot be read.
pub async fn eligible_projects(db: &AppDatabase) -> Vec<folder::Model> {
    eligible_in(&db.conn).await.unwrap_or_default()
}

/// Of `eligible`, the ones `scope` keeps an eye on, in the same order.
pub fn watched_of(eligible: Vec<folder::Model>, scope: &ProjectScope) -> Vec<folder::Model> {
    eligible
        .into_iter()
        .filter(|f| scope.covers(f.id))
        .collect()
}

/// The projects kept an eye on now.
pub async fn watched_projects(db: &AppDatabase, prefs: &Prefs) -> Vec<folder::Model> {
    watched_of(eligible_projects(db).await, &prefs.projects)
}

pub fn project_name(f: &folder::Model) -> String {
    f.alias
        .clone()
        .filter(|a| !a.trim().is_empty())
        .unwrap_or_else(|| f.name.clone())
}

/// A project's `origin`, as far as this machine says.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Origin {
    /// The host it is on.
    Host(String),
    /// No `origin`, or one that names no forge repository.
    Missing,
    /// git could not say (failed, too slow).
    Failed,
}

/// Whether `dir` is a folder there is for sure no checkout in: it reads as
/// a folder, and `.git` is not found in it — an error reading either (no
/// permission, a disk going away) is not knowing.
fn no_checkout(dir: &std::path::Path) -> bool {
    let is_dir = std::fs::metadata(dir).is_ok_and(|m| m.is_dir());
    is_dir
        && matches!(
            std::fs::symlink_metadata(dir.join(".git")),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound
        )
}

/// The host of the checkout's `origin`, from git alone.
pub async fn origin_host(path: &str) -> Origin {
    let mut cmd = crate::process::tokio_command("git");
    cmd.args(["-C", path, "remote", "get-url", "origin"]);
    cmd.kill_on_drop(true);
    let out = match tokio::time::timeout(REMOTE_TIMEOUT, cmd.output()).await {
        Ok(Ok(out)) => out,
        _ => return Origin::Failed,
    };
    if !out.status.success() {
        // No `origin` (git's exit 2), or a folder that is no checkout: no
        // forge, for sure. Anything else — the folder not there (a disk not
        // mounted), a broken checkout — says nothing this time.
        return if out.status.code() == Some(2) || no_checkout(std::path::Path::new(path)) {
            Origin::Missing
        } else {
            Origin::Failed
        };
    }
    let url = String::from_utf8_lossy(&out.stdout).trim().to_string();
    match crate::forge::parse_remote_url(&url) {
        Some((host, _)) => Origin::Host(host),
        None => Origin::Missing,
    }
}

/// The public forges codeg speaks, by their host: an account for them is
/// one the owner can just connect.
pub fn public_forge(host: &str) -> Option<ForgeProvider> {
    match host.trim().to_ascii_lowercase().as_str() {
        "github.com" => Some(ForgeProvider::GitHub),
        "gitlab.com" => Some(ForgeProvider::GitLab),
        "cnb.cool" => Some(ForgeProvider::Cnb),
        _ => None,
    }
}

/// What codeg can tell of a project's forge without the network.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ForgeStatus {
    /// An account serves its host.
    Account {
        provider: ForgeProvider,
        host: String,
    },
    /// On a public forge codeg speaks, no account for it yet.
    NoAccount {
        provider: ForgeProvider,
        host: String,
    },
    /// On another host: self-hosted, or a forge codeg does not speak.
    Other { host: String },
    /// No forge remote.
    None,
    /// Not known (git or the accounts could not be read).
    Unknown,
}

pub fn status_of(origin: &Origin, accounts: Result<&[GitHubAccount], ()>) -> ForgeStatus {
    let host = match origin {
        Origin::Host(h) => h.clone(),
        Origin::Missing => return ForgeStatus::None,
        Origin::Failed => return ForgeStatus::Unknown,
    };
    let Ok(accounts) = accounts else {
        return ForgeStatus::Unknown;
    };
    if let Some(provider) = crate::forge::auth::local_account_in(&host, accounts) {
        return ForgeStatus::Account { provider, host };
    }
    match public_forge(&host) {
        Some(provider) => ForgeStatus::NoAccount { provider, host },
        None => ForgeStatus::Other { host },
    }
}

/// Whether codeg may spend a request on a project's forge.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Served {
    /// An account serves its remote.
    Yes,
    /// Known not to be: no forge remote, or no account for it.
    No,
    /// Not known this time.
    Unknown,
}

impl From<&ForgeStatus> for Served {
    fn from(s: &ForgeStatus) -> Self {
        match s {
            ForgeStatus::Account { .. } => Served::Yes,
            ForgeStatus::NoAccount { .. } | ForgeStatus::Other { .. } | ForgeStatus::None => {
                Served::No
            }
            ForgeStatus::Unknown => Served::Unknown,
        }
    }
}

/// [`status_of`] for one checkout, reading the accounts.
pub async fn forge_status(db: &AppDatabase, path: &str) -> ForgeStatus {
    let origin = origin_host(path).await;
    if !matches!(origin, Origin::Host(_)) {
        return status_of(&origin, Err(()));
    }
    let accounts = crate::forge::auth::local_accounts(&db.conn).await;
    status_of(&origin, accounts.as_deref().map_err(|_| ()))
}

/// One project as the settings and the first cards list it.
#[derive(Debug, Clone, Serialize)]
pub struct ProjectView {
    pub id: i32,
    pub name: String,
    pub path: String,
    pub forge: ForgeStatus,
}

/// Every project that may be kept an eye on, with its forge as this
/// machine knows it — git read a few at a time, nothing asked of a forge.
pub async fn project_views(db: &AppDatabase) -> Vec<ProjectView> {
    let projects = eligible_projects(db).await;
    let accounts = crate::forge::auth::local_accounts(&db.conn).await;
    let paths: Vec<String> = projects.iter().map(|f| f.path.clone()).collect();
    let origins: Vec<Origin> = futures::stream::iter(paths)
        .map(|path| async move { origin_host(&path).await })
        .buffered(REMOTES_AT_ONCE)
        .collect()
        .await;
    projects
        .iter()
        .zip(origins)
        .map(|(f, origin)| ProjectView {
            id: f.id,
            name: project_name(f),
            path: f.path.clone(),
            forge: status_of(&origin, accounts.as_deref().map_err(|_| ())),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn no_remote_is_known_a_folder_not_there_is_not() {
        let tmp = tempfile::tempdir().unwrap();
        let git = |dir: &std::path::Path, args: &[&str]| {
            let out = std::process::Command::new("git")
                .arg("-C")
                .arg(dir)
                .args(args)
                .output()
                .unwrap();
            assert!(out.status.success(), "git {args:?}");
        };
        let at = |p: &std::path::Path| p.to_string_lossy().into_owned();
        let repo = tmp.path().join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        git(&repo, &["init", "-q"]);
        assert_eq!(origin_host(&at(&repo)).await, Origin::Missing, "no origin");
        git(
            &repo,
            &["remote", "add", "origin", "git@GitHub.com:a/b.git"],
        );
        assert_eq!(
            origin_host(&at(&repo)).await,
            Origin::Host("github.com".into())
        );
        let plain = tmp.path().join("plain");
        std::fs::create_dir_all(&plain).unwrap();
        assert_eq!(
            origin_host(&at(&plain)).await,
            Origin::Missing,
            "no checkout"
        );
        // A folder that cannot be looked into: not known.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let shut = tmp.path().join("shut");
            std::fs::create_dir_all(shut.join(".git")).unwrap();
            std::fs::set_permissions(&shut, std::fs::Permissions::from_mode(0o000)).unwrap();
            let readable = std::fs::symlink_metadata(shut.join(".git")).is_ok();
            if !readable {
                assert!(!no_checkout(&shut), "unreadable is not missing");
            }
            std::fs::set_permissions(&shut, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let away = tmp.path().join("unmounted");
        assert_eq!(
            origin_host(&at(&away)).await,
            Origin::Failed,
            "not there this time"
        );
    }

    fn account(server_url: &str, provider: Option<&str>) -> GitHubAccount {
        serde_json::from_value(serde_json::json!({
            "id": "a",
            "server_url": server_url,
            "username": "me",
            "scopes": [],
            "avatar_url": null,
            "provider": provider,
            "is_default": true,
            "created_at": "2026-01-01T00:00:00Z",
        }))
        .unwrap()
    }

    #[test]
    fn a_forge_reads_off_the_remote_and_the_accounts_only() {
        let host = |h: &str| Origin::Host(h.into());
        let none: &[GitHubAccount] = &[];
        assert_eq!(
            status_of(&host("github.com"), Ok(none)),
            ForgeStatus::NoAccount {
                provider: ForgeProvider::GitHub,
                host: "github.com".into()
            }
        );
        assert_eq!(
            status_of(&host("cnb.cool"), Ok(none)),
            ForgeStatus::NoAccount {
                provider: ForgeProvider::Cnb,
                host: "cnb.cool".into()
            }
        );
        // Gitee, or a host of the owner's: nothing to connect from here.
        assert_eq!(
            status_of(&host("gitee.com"), Ok(none)),
            ForgeStatus::Other {
                host: "gitee.com".into()
            }
        );
        assert_eq!(
            status_of(&host("git.corp"), Ok(none)),
            ForgeStatus::Other {
                host: "git.corp".into()
            }
        );
        let gl = [account("https://git.corp:8443", Some("gitlab"))];
        assert_eq!(
            status_of(&host("git.corp"), Ok(&gl)),
            ForgeStatus::Account {
                provider: ForgeProvider::GitLab,
                host: "git.corp".into()
            }
        );
        let gh = [account("", None)];
        assert_eq!(
            status_of(&host("github.com"), Ok(&gh)),
            ForgeStatus::Account {
                provider: ForgeProvider::GitHub,
                host: "github.com".into()
            }
        );
        assert_eq!(
            status_of(&host("github.com"), Err(())),
            ForgeStatus::Unknown
        );
        assert_eq!(status_of(&Origin::Missing, Ok(none)), ForgeStatus::None);
        assert_eq!(status_of(&Origin::Failed, Ok(none)), ForgeStatus::Unknown);
        assert_eq!(
            Served::from(&ForgeStatus::Other { host: "x".into() }),
            Served::No
        );
        assert_eq!(Served::from(&ForgeStatus::Unknown), Served::Unknown);
    }
}
