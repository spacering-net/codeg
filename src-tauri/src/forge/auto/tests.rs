use std::path::Path;
use std::sync::Arc;

use chrono::{DateTime, Utc};

use super::*;
use crate::db::service::folder_service;
use crate::forge::settings::ForgePanelSettings;
use crate::forge::ForgeLabel;

fn at(rfc3339: &str) -> DateTime<Utc> {
    DateTime::parse_from_rfc3339(rfc3339)
        .expect("valid instant")
        .with_timezone(&Utc)
}

async fn processor() -> Arc<AutoProcessor> {
    let db = crate::db::test_helpers::fresh_in_memory_db().await;
    Arc::new(AutoProcessor {
        db,
        emitter: EventEmitter::Noop,
        folders: Mutex::new(HashMap::new()),
    })
}

/// A real git repository whose `origin` is `remote` — what
/// `folder_forge_remote_core` asks git for.
fn repo_with_origin(dir: &Path, remote: &str) {
    for args in [vec!["init", "-q"], vec!["remote", "add", "origin", remote]] {
        let status = std::process::Command::new("git")
            .arg("-C")
            .arg(dir)
            .args(&args)
            .status()
            .expect("git runs");
        assert!(status.success(), "git {args:?}");
    }
}

/// An open project folder on `remote`, registered the way opening one in the
/// workspace does.
async fn project_folder(p: &AutoProcessor, dir: &Path, remote: &str) -> i32 {
    repo_with_origin(dir, remote);
    folder_service::add_folder(&p.db.conn, &dir.to_string_lossy())
        .await
        .expect("folder")
        .id
}

async fn save_auto(p: &AutoProcessor, folder_id: Option<i32>, auto: ForgeAutoSettings) {
    settings::save(
        &p.db.conn,
        folder_id,
        Some(ForgePanelSettings {
            auto,
            ..Default::default()
        }),
    )
    .await
    .expect("settings saved");
}

fn webhook_on(secret: &str) -> ForgeAutoSettings {
    ForgeAutoSettings {
        webhook: true,
        webhook_secret: Some(secret.to_string()),
        ..Default::default()
    }
}

fn signed(body: &[u8], secret: &str, event: &str) -> http::HeaderMap {
    use hmac::{Hmac, Mac};
    let mut mac = Hmac::<sha2::Sha256>::new_from_slice(secret.as_bytes()).expect("key");
    mac.update(body);
    let digest: String = mac
        .finalize()
        .into_bytes()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    let mut headers = http::HeaderMap::new();
    headers.insert("x-github-event", event.parse().expect("event"));
    headers.insert(
        "x-hub-signature-256",
        format!("sha256={digest}").parse().expect("signature"),
    );
    headers
}

fn issue_payload(repo: &str, host: &str) -> Vec<u8> {
    serde_json::to_vec(&serde_json::json!({
        "action": "labeled",
        "issue": { "number": 7 },
        "repository": {
            "full_name": repo,
            "html_url": format!("https://{host}/{repo}"),
        },
    }))
    .expect("payload")
}

fn row(number: i64, is_pr: bool, updated_at: Option<&str>) -> ForgeIssueRow {
    ForgeIssueRow {
        number,
        title: format!("item {number}"),
        body: Some("body".into()),
        state: "open".into(),
        draft: false,
        labels: vec![ForgeLabel {
            name: "bug".into(),
            color: None,
        }],
        author: Some("alice".into()),
        author_avatar: None,
        updated_at: updated_at.map(str::to_string),
        html_url: String::new(),
        is_pr,
        comments: 0,
    }
}

// ── the window ──────────────────────────────────────────────────────────────

/// First scan under a set of rules: the rules' own window — from when
/// auto-processing was switched on, less a couple of minutes for a forge
/// whose clock runs behind this one, or every open item when the backlog was
/// asked for.
#[tokio::test]
async fn the_first_scan_reads_the_rules_own_window() {
    let p = processor().await;
    let on = ForgeAutoSettings {
        schedule: true,
        enabled_at: Some(at("2026-10-14T08:00:00Z")),
        ..Default::default()
    };
    let fp = rules_fingerprint(&on);
    assert_eq!(p.window_start(1, &on, fp), Some(at("2026-10-14T07:58:00Z")));

    let backlog = ForgeAutoSettings {
        include_existing: true,
        ..on
    };
    assert_eq!(
        p.window_start(1, &backlog, rules_fingerprint(&backlog)),
        None
    );
}

/// Later scans under the SAME rules read only what changed since the previous
/// complete scan began, reaching back by the overlap — but never before the
/// rules' own window.
#[tokio::test]
async fn an_incremental_scan_resumes_just_before_the_previous_one() {
    let p = processor().await;
    let on = ForgeAutoSettings {
        schedule: true,
        enabled_at: Some(at("2026-10-14T08:00:00Z")),
        ..Default::default()
    };
    let fp = rules_fingerprint(&on);
    p.with_state(1, |s| s.watermark = Some((at("2026-10-14T09:00:00Z"), fp)));
    assert_eq!(p.window_start(1, &on, fp), Some(at("2026-10-14T08:50:00Z")));

    // A previous scan that started inside the overlap of the switch-on moment
    // cannot pull the window back before it (skew allowance included).
    p.with_state(1, |s| s.watermark = Some((at("2026-10-14T08:05:00Z"), fp)));
    assert_eq!(p.window_start(1, &on, fp), Some(at("2026-10-14T07:58:00Z")));

    // With the backlog asked for, the floor is gone and the overlap decides.
    let backlog = ForgeAutoSettings {
        include_existing: true,
        ..on
    };
    let bfp = rules_fingerprint(&backlog);
    p.with_state(1, |s| s.watermark = Some((at("2026-10-14T09:00:00Z"), bfp)));
    assert_eq!(
        p.window_start(1, &backlog, bfp),
        Some(at("2026-10-14T08:50:00Z"))
    );
}

/// A rule edit starts the window over. An item a removed exclusion now lets
/// through was not touched since the last scan, and an incremental read would
/// never see it.
#[tokio::test]
async fn editing_a_rule_restarts_the_window() {
    let p = processor().await;
    let before = ForgeAutoSettings {
        schedule: true,
        exclude_labels: vec!["wontfix".into()],
        enabled_at: Some(at("2026-10-14T08:00:00Z")),
        ..Default::default()
    };
    p.with_state(1, |s| {
        s.watermark = Some((at("2026-10-14T09:00:00Z"), rules_fingerprint(&before)))
    });
    let after = ForgeAutoSettings {
        exclude_labels: vec![],
        ..before.clone()
    };
    assert_ne!(rules_fingerprint(&before), rules_fingerprint(&after));
    assert_eq!(
        p.window_start(1, &after, rules_fingerprint(&after)),
        Some(at("2026-10-14T07:58:00Z"))
    );
    // Each folder keeps its own window.
    assert_eq!(
        p.window_start(2, &before, rules_fingerprint(&before)),
        Some(at("2026-10-14T07:58:00Z"))
    );
}

#[test]
fn rows_outside_the_window_are_dropped_and_unreadable_times_kept() {
    let since = Some(at("2026-10-14T08:00:00Z"));
    assert!(within_window(
        &row(1, false, Some("2026-10-14T08:00:00Z")),
        since
    ));
    assert!(within_window(
        &row(1, false, Some("2026-10-14T09:30:00+01:00")),
        since
    ));
    assert!(!within_window(
        &row(1, false, Some("2026-10-14T07:59:59Z")),
        since
    ));
    // Not readable: the forge listed it for this window, so it stays.
    assert!(within_window(&row(1, false, None), since));
    assert!(within_window(&row(1, false, Some("yesterday")), since));
    // No window at all keeps everything.
    assert!(within_window(
        &row(1, false, Some("2001-01-01T00:00:00Z")),
        None
    ));
}

// ── the task an item gets ───────────────────────────────────────────────────

/// What the trigger dialog would send for the item, with auto-processing's
/// own choices in the dialog's seats: its scenario per kind (falling back to
/// the kind's default rather than failing), its write-back answer stated
/// outright, the default account, and no override of anything else.
#[test]
fn an_automatic_task_is_drafted_like_a_clicked_one() {
    let remote = ForgeRemote {
        server_host: "github.com".into(),
        owner_repo: "acme/app".into(),
        remote_url: "https://github.com/acme/app.git".into(),
        provider: ForgeProvider::GitHub,
        supported: true,
    };
    let panel = ForgePanelSettings {
        // The dialog's default is NOT what an automatic task uses.
        default_issue_scenario: Some("fix".into()),
        auto: ForgeAutoSettings {
            issue_scenario: Some("plan_first".into()),
            // Saved for the other kind: falls back, never fails.
            pr_scenario: Some("plan_first".into()),
            writeback: false,
            ..Default::default()
        },
        ..Default::default()
    };

    let issue = auto_task_draft(4, &remote, &panel, &row(12, false, None));
    assert_eq!(issue.folder_id, 4);
    assert_eq!(issue.source.kind, "issue");
    assert_eq!(issue.source.provider, "github");
    assert_eq!(issue.source.number, 12);
    assert_eq!(issue.source.account_id, None);
    assert_eq!(issue.scenario.as_deref(), Some("plan_first"));
    assert_eq!(
        issue.writeback,
        Some(false),
        "stated outright, never left absent"
    );
    assert_eq!(issue.snapshot.labels, vec!["bug".to_string()]);
    assert_eq!(issue.snapshot.author.as_deref(), Some("alice"));
    assert!(!issue.force && issue.instruction.is_none() && issue.agent_type.is_none());

    let pr = auto_task_draft(4, &remote, &panel, &row(13, true, None));
    assert_eq!(pr.source.kind, "pr");
    assert_eq!(pr.scenario.as_deref(), Some("review_fix"));
}

// ── refusals ────────────────────────────────────────────────────────────────

#[tokio::test]
async fn a_scan_is_refused_while_auto_processing_is_off() {
    let p = processor().await;
    assert_eq!(
        p.scan(1, Trigger::Manual).await.unwrap_err(),
        ScanRefused::Off
    );

    // On by schedule only: a webhook nudge is not its trigger.
    save_auto(
        &p,
        None,
        ForgeAutoSettings {
            schedule: true,
            ..Default::default()
        },
    )
    .await;
    assert_eq!(
        p.scan(1, Trigger::Webhook).await.unwrap_err(),
        ScanRefused::Off
    );

    let status = p.status(1).await.expect("status");
    assert!(status.available && !status.scanning);
    assert!(status.last_scan.is_none());
    // Never scanned yet: due now.
    assert!(status.next_scan_at.is_some());
}

/// A trigger that lands while a scan runs is not lost and not run alongside
/// it: the running scan runs once more. A manual request outranks the
/// automatic ones in the record.
#[tokio::test]
async fn a_trigger_during_a_scan_queues_one_rerun() {
    let p = processor().await;
    save_auto(
        &p,
        None,
        ForgeAutoSettings {
            schedule: true,
            webhook: true,
            ..Default::default()
        },
    )
    .await;
    p.with_state(1, |s| s.scanning = true);

    assert_eq!(
        p.scan(1, Trigger::Webhook).await.unwrap_err(),
        ScanRefused::Busy
    );
    assert_eq!(p.with_state(1, |s| s.rerun), Some(Trigger::Webhook));
    assert_eq!(
        p.scan(1, Trigger::Manual).await.unwrap_err(),
        ScanRefused::Busy
    );
    assert_eq!(
        p.scan(1, Trigger::Schedule).await.unwrap_err(),
        ScanRefused::Busy
    );
    assert_eq!(p.with_state(1, |s| s.rerun), Some(Trigger::Manual));
    assert!(p.status(1).await.expect("status").scanning);
}

// ── webhooks ────────────────────────────────────────────────────────────────

#[tokio::test]
async fn a_delivery_nobody_takes_is_404() {
    let p = processor().await;
    let body = issue_payload("acme/app", "github.com");
    let outcome = p
        .handle_webhook(&signed(&body, "s3cret", "issues"), &body)
        .await;
    assert_eq!(outcome.status, 404, "{outcome:?}");
}

/// The route is unauthenticated, so the signature is the gate — checked
/// before the body is read or a single git process is spawned.
#[tokio::test]
async fn a_delivery_that_does_not_verify_is_401_and_nudges_nothing() {
    let p = processor().await;
    let dir = tempfile::tempdir().expect("tempdir");
    let folder = project_folder(&p, dir.path(), "https://github.com/acme/app.git").await;
    save_auto(&p, None, webhook_on("s3cret")).await;

    let body = issue_payload("acme/app", "github.com");
    for headers in [
        signed(&body, "wrong secret", "issues"),
        http::HeaderMap::new(),
        signed(b"another body", "s3cret", "issues"),
    ] {
        let outcome = p.handle_webhook(&headers, &body).await;
        assert_eq!(outcome.status, 401, "{outcome:?}");
    }
    assert_eq!(p.with_state(folder, |s| s.last_delivery_at), None);
}

#[tokio::test]
async fn pings_and_unrelated_events_are_answered_without_a_scan() {
    let p = processor().await;
    let dir = tempfile::tempdir().expect("tempdir");
    let folder = project_folder(&p, dir.path(), "https://github.com/acme/app.git").await;
    save_auto(&p, None, webhook_on("s3cret")).await;

    let ping = br#"{"zen":"Keep it logically awesome."}"#;
    let outcome = p
        .handle_webhook(&signed(ping, "s3cret", "ping"), ping)
        .await;
    assert_eq!((outcome.status, outcome.message.as_str()), (200, "pong"));

    let body = issue_payload("acme/app", "github.com");
    let outcome = p
        .handle_webhook(&signed(&body, "s3cret", "push"), &body)
        .await;
    assert_eq!(outcome.status, 200);
    assert!(outcome.message.contains("ignored"), "{outcome:?}");
    assert_eq!(p.with_state(folder, |s| s.last_delivery_at), None);
}

/// A genuine delivery about a repository no folder here is: answered, and
/// nothing scanned. The delivery log says so in words.
#[tokio::test]
async fn a_verified_delivery_for_another_repository_is_ignored() {
    let p = processor().await;
    let dir = tempfile::tempdir().expect("tempdir");
    let folder = project_folder(&p, dir.path(), "https://github.com/acme/app.git").await;
    save_auto(&p, None, webhook_on("s3cret")).await;

    let body = issue_payload("acme/other", "github.com");
    let outcome = p
        .handle_webhook(&signed(&body, "s3cret", "issues"), &body)
        .await;
    assert_eq!(outcome.status, 200, "{outcome:?}");
    assert!(
        outcome.message.contains("github.com/acme/other"),
        "{outcome:?}"
    );
    assert_eq!(p.with_state(folder, |s| s.last_delivery_at), None);
}

/// Each folder answers to its OWN secret: a folder with settings of its own
/// does not accept deliveries signed with the global row's secret, and vice
/// versa.
#[tokio::test]
async fn each_folder_verifies_against_the_secret_it_runs_under() {
    let p = processor().await;
    let dir = tempfile::tempdir().expect("tempdir");
    let folder = project_folder(&p, dir.path(), "https://github.com/acme/app.git").await;
    save_auto(&p, None, webhook_on("global-secret")).await;
    save_auto(&p, Some(folder), webhook_on("folder-secret")).await;

    let body = issue_payload("acme/app", "github.com");
    let outcome = p
        .handle_webhook(&signed(&body, "global-secret", "issues"), &body)
        .await;
    assert_eq!(outcome.status, 401, "{outcome:?}");

    let outcome = p
        .handle_webhook(&signed(&body, "folder-secret", "issues"), &body)
        .await;
    assert_eq!(outcome.status, 202, "{outcome:?}");
}

/// The happy path up to the forge: a verified delivery for the folder's own
/// repository records the delivery and sets a scan off. With no account for
/// the host the scan stops at authentication — and SAYS so in the report,
/// which is what the settings dialog shows.
#[tokio::test]
async fn a_verified_delivery_for_the_folders_repository_starts_a_scan() {
    let p = processor().await;
    let dir = tempfile::tempdir().expect("tempdir");
    let folder = project_folder(&p, dir.path(), "git@github.com:Acme/App.git").await;
    save_auto(&p, None, webhook_on("s3cret")).await;

    let body = issue_payload("acme/app", "github.com");
    let outcome = p
        .handle_webhook(&signed(&body, "s3cret", "issues"), &body)
        .await;
    assert_eq!(outcome.status, 202, "{outcome:?}");
    assert!(p.with_state(folder, |s| s.last_delivery_at).is_some());

    let report = wait_for_report(&p, folder).await;
    assert_eq!(report.trigger, Trigger::Webhook);
    let error = report.error.expect("no account, so the scan stops");
    assert!(error.contains("account"), "{error}");
    assert!(report.created.is_empty());
}

async fn wait_for_report(p: &AutoProcessor, folder: i32) -> ScanReport {
    for _ in 0..200 {
        if let Some(report) = p.with_state(folder, |s| {
            (!s.scanning).then(|| s.last_report.clone()).flatten()
        }) {
            return report;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    panic!("no scan report for folder {folder}");
}

// ── the scan slot ───────────────────────────────────────────────────────────

/// A scan that ends abnormally (cancelled, or unwound by a panic) gives its
/// slot back; one that released it normally does not touch it again — by
/// then another trigger may hold it.
#[tokio::test]
async fn the_slot_guard_releases_only_on_an_abnormal_exit() {
    let p = processor().await;
    p.with_state(1, |s| {
        s.scanning = true;
        s.rerun = Some(Trigger::Webhook);
    });
    drop(ScanSlot {
        processor: &p,
        folder_id: 1,
        armed: true,
    });
    assert_eq!(p.with_state(1, |s| (s.scanning, s.rerun)), (false, None));

    // Disarmed: the slot now belongs to somebody else and stays theirs.
    p.with_state(1, |s| s.scanning = true);
    drop(ScanSlot {
        processor: &p,
        folder_id: 1,
        armed: false,
    });
    assert!(p.with_state(1, |s| s.scanning));
}

/// Which mint failures hold the window for a retry (see
/// `a_transient_failure_holds_the_window_for_a_retry`).
#[test]
fn only_failures_that_may_not_repeat_are_retried() {
    assert!(is_transient(&AppCommandError::network(
        "forge API request failed"
    )));
    assert!(is_transient(&AppCommandError::database_error("locked")));
    assert!(is_transient(&AppCommandError::io_error("git failed")));
    assert!(!is_transient(&AppCommandError::invalid_input(
        "already merged"
    )));
    assert!(!is_transient(&AppCommandError::not_found("gone")));
    assert!(!is_transient(&AppCommandError::configuration_missing(
        "no account"
    )));
}

// ── a whole scan, against a forge ───────────────────────────────────────────

/// Server mode only: the file-backed token store can be pointed at a temp
/// directory. The desktop build would write the real OS keyring.
#[cfg(not(feature = "tauri-runtime"))]
mod against_a_forge {
    use super::*;
    use crate::models::{GitHubAccount, GitHubAccountsSettings};
    use axum::extract::{Path as UrlPath, Query};
    use axum::response::IntoResponse;
    use axum::routing::get;
    use axum::Json;
    use std::collections::HashMap as Map;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Mutex as StdMutex;

    /// How the mock answers the pull request a task is hydrated from.
    #[derive(Clone, Copy)]
    enum Pulls {
        /// An open, same-repository pull request.
        Workable,
        /// A 500 on the first ask, then workable — a hiccup.
        FailFirst,
        /// Already merged — a refusal that will repeat every time.
        Merged,
    }

    fn issue(number: i64, labels: &[&str], author: &str) -> serde_json::Value {
        serde_json::json!({
            "number": number,
            "title": format!("item {number}"),
            "body": format!("body {number}"),
            "state": "open",
            "comments": 0,
            // Always "just now": the scan window is measured on the real
            // clock, and a fixed date would fall out of it on a later day.
            "updated_at": chrono::Utc::now().to_rfc3339(),
            "html_url": format!("http://forge.test/acme/app/issues/{number}"),
            "user": { "login": author },
            "labels": labels.iter().map(|l| serde_json::json!({ "name": l })).collect::<Vec<_>>(),
        })
    }

    fn pull(number: i64, labels: &[&str], author: &str, draft: bool) -> serde_json::Value {
        let mut item = issue(number, labels, author);
        item["pull_request"] = serde_json::json!({ "merged_at": null });
        item["draft"] = serde_json::json!(draft);
        item
    }

    /// A GitHub Enterprise at `/api/v3`: the issues feed (recording each
    /// query) and the one pull request a task is hydrated from.
    async fn serve(seen: Arc<StdMutex<Vec<Map<String, String>>>>, pulls: Pulls) -> String {
        let asked = Arc::new(AtomicUsize::new(0));
        let app = axum::Router::new()
            .route(
                "/api/v3/repos/acme/app/issues",
                get(move |Query(q): Query<Map<String, String>>| {
                    let seen = seen.clone();
                    async move {
                        seen.lock().unwrap().push(q);
                        Json(serde_json::json!([
                            issue(1, &["bug"], "alice"),
                            issue(2, &["bug", "wontfix"], "alice"),
                            issue(3, &[], "alice"),
                            pull(4, &["bug"], "alice", true),
                            pull(5, &["bug"], "dependabot[bot]", false),
                            pull(6, &["Bug"], "bob", false),
                        ]))
                    }
                }),
            )
            .route(
                "/api/v3/repos/acme/app/pulls/{number}",
                get(move |UrlPath(number): UrlPath<i64>| {
                    let asked = asked.clone();
                    async move {
                        let first = asked.fetch_add(1, Ordering::SeqCst) == 0;
                        if matches!(pulls, Pulls::FailFirst) && first {
                            return (
                                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                                Json(serde_json::json!({ "message": "try again" })),
                            )
                                .into_response();
                        }
                        let merged_at = match pulls {
                            Pulls::Merged => serde_json::json!("2026-10-01T00:00:00Z"),
                            _ => serde_json::Value::Null,
                        };
                        Json(serde_json::json!({
                            "number": number,
                            "html_url": format!("http://forge.test/acme/app/pull/{number}"),
                            "state": "open",
                            "merged_at": merged_at,
                            "head": { "sha": "abc123", "ref": "feature", "repo": { "full_name": "acme/app" } },
                            "base": { "sha": "def456", "ref": "main", "repo": { "full_name": "acme/app" } },
                        }))
                        .into_response()
                    }
                }),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        format!("http://{addr}")
    }

    /// The rules both scans below run under: issues and pull requests that
    /// carry `bug`, never `wontfix`, never a bot — which leaves #1 and #6 of
    /// the mock's six.
    fn bug_rules() -> ForgeAutoSettings {
        ForgeAutoSettings {
            schedule: true,
            issues: true,
            pull_requests: true,
            include_labels: vec!["bug".into()],
            exclude_labels: vec!["wontfix".into()],
            exclude_authors: vec!["*[bot]".into()],
            include_existing: true,
            // Nothing here runs the task engine; queueing is covered by the
            // engine's own Start.
            auto_start: false,
            ..Default::default()
        }
    }

    /// A processor over a folder on the mock forge, with an account for it.
    async fn on_forge(
        tmp: &Path,
        pulls: Pulls,
    ) -> (
        Arc<AutoProcessor>,
        i32,
        Arc<StdMutex<Vec<Map<String, String>>>>,
    ) {
        let seen = Arc::new(StdMutex::new(Vec::new()));
        let base = serve(seen.clone(), pulls).await;
        let p = processor().await;
        configure_account(&p, &base).await;
        let port = base.rsplit(':').next().unwrap().to_string();
        let repo_dir = tmp.join("repo");
        std::fs::create_dir_all(&repo_dir).unwrap();
        let folder = project_folder(
            &p,
            &repo_dir,
            &format!("http://127.0.0.1:{port}/acme/app.git"),
        )
        .await;
        (p, folder, seen)
    }

    async fn configure_account(p: &AutoProcessor, server_url: &str) {
        let settings = GitHubAccountsSettings {
            accounts: vec![GitHubAccount {
                id: "acc-auto".into(),
                server_url: server_url.into(),
                username: "codeg-bot".into(),
                scopes: vec![],
                avatar_url: None,
                is_default: true,
                created_at: "2026-10-14T00:00:00Z".into(),
                provider: Some("github".into()),
            }],
        };
        crate::db::service::app_metadata_service::upsert_value(
            &p.db.conn,
            "github_accounts",
            &serde_json::to_string(&settings).unwrap(),
        )
        .await
        .unwrap();
        crate::keyring_store::set_token("acc-auto", "tok-auto").unwrap();
    }

    /// The whole loop on one scan: rules decide, every match becomes exactly
    /// one task, the timeline says it was automatic — and the next scan, and
    /// the one after the user deleted a task, mint nothing more.
    #[tokio::test]
    async fn a_scan_mints_one_task_per_matching_item_and_never_another() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let data_dir = tmp.path().join("data");
        std::fs::create_dir_all(&data_dir).unwrap();
        let data_dir = data_dir.to_string_lossy().to_string();

        temp_env::async_with_vars([("CODEG_DATA_DIR", Some(data_dir.as_str()))], async move {
            let (p, folder, seen) = on_forge(tmp.path(), Pulls::Workable).await;
            save_auto(
                &p,
                Some(folder),
                ForgeAutoSettings {
                    writeback: true,
                    ..bug_rules()
                },
            )
            .await;

            let report = p.scan(folder, Trigger::Manual).await.expect("scan ran");
            assert_eq!(report.error, None, "{report:?}");
            assert_eq!(report.since, None, "the backlog was asked for");
            assert_eq!(report.examined, 6);
            assert_eq!(report.matched, 2);
            let made: Vec<(i64, bool)> =
                report.created.iter().map(|c| (c.number, c.is_pr)).collect();
            assert_eq!(made, vec![(1, false), (6, true)], "{report:?}");
            assert!(report.created.iter().all(|c| !c.started));
            assert_eq!(report.skipped.get(&rules::Skip::ExcludedLabel), Some(&1));
            assert_eq!(report.skipped.get(&rules::Skip::MissingLabel), Some(&1));
            assert_eq!(report.skipped.get(&rules::Skip::Draft), Some(&1));
            assert_eq!(report.skipped.get(&rules::Skip::ExcludedAuthor), Some(&1));
            assert!(report.failed.is_empty(), "{report:?}");

            // The tasks are the trigger dialog's tasks, said to be automatic.
            let issue_task = report.created[0].task_id;
            let task = work_task_service::get(&p.db.conn, issue_task)
                .await
                .unwrap();
            assert_eq!(task.title, "#1 · item 1");
            let meta = task.source_meta.expect("forge provenance");
            assert_eq!(meta["writeback"], serde_json::json!(true));
            let events = work_task_service::list_events(&p.db.conn, issue_task, 10)
                .await
                .unwrap();
            let created = events
                .iter()
                .find(|e| e.kind == "created")
                .expect("created");
            assert_eq!(created.actor, "auto");
            assert_eq!(
                created.payload,
                Some(serde_json::json!({ "auto": "manual" }))
            );
            let pr_task = work_task_service::get(&p.db.conn, report.created[1].task_id)
                .await
                .unwrap();
            assert_eq!(pr_task.source_kind.as_deref(), Some("forge_pr"));

            // Again: everything that matched already has its task.
            let again = p.scan(folder, Trigger::Manual).await.expect("scan ran");
            assert_eq!(again.error, None, "{again:?}");
            assert!(again.created.is_empty(), "{again:?}");
            assert_eq!(again.already_handled, 2);
            // …and this one read only from just before the previous scan.
            let window = again.since.expect("incremental");
            assert_eq!(
                window,
                (report.started_at - chrono::Duration::minutes(WATERMARK_OVERLAP_MINUTES))
                    .trunc_subsecs(0)
            );
            let last_query = seen.lock().unwrap().last().cloned().unwrap();
            assert_eq!(
                last_query.get("since"),
                Some(&forge_core::scan_timestamp(window))
            );
            assert_eq!(last_query.get("state").map(String::as_str), Some("open"));

            // A task the user threw away stays thrown away.
            assert!(work_task_service::soft_delete(
                &p.db.conn,
                issue_task,
                crate::models::WorkTaskStatus::Todo
            )
            .await
            .unwrap());
            let after_delete = p.scan(folder, Trigger::Manual).await.expect("scan ran");
            assert!(after_delete.created.is_empty(), "{after_delete:?}");
            assert_eq!(after_delete.already_handled, 2);

            let status = p.status(folder).await.expect("status");
            assert_eq!(
                status.last_scan.map(|r| r.started_at),
                Some(after_delete.started_at)
            );
        })
        .await;
    }

    /// A failure that may not repeat — the forge answered 500 — keeps the
    /// window where it was, so the item without a task is read again and
    /// minted on the retry. Moving past it would lose it for good: an
    /// incremental scan only sees items that change.
    #[tokio::test]
    async fn a_transient_failure_holds_the_window_for_a_retry() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let data_dir = tmp.path().join("data");
        std::fs::create_dir_all(&data_dir).unwrap();
        let data_dir = data_dir.to_string_lossy().to_string();

        temp_env::async_with_vars([("CODEG_DATA_DIR", Some(data_dir.as_str()))], async move {
            let (p, folder, _seen) = on_forge(tmp.path(), Pulls::FailFirst).await;
            save_auto(&p, Some(folder), bug_rules()).await;

            let first = p.scan(folder, Trigger::Manual).await.expect("scan ran");
            assert_eq!(first.error, None, "{first:?}");
            let made: Vec<i64> = first.created.iter().map(|c| c.number).collect();
            assert_eq!(made, vec![1]);
            assert_eq!(first.failed.len(), 1, "{first:?}");
            assert_eq!(first.failed[0].number, 6);

            let retry = p.scan(folder, Trigger::Manual).await.expect("scan ran");
            assert_eq!(retry.since, None, "the window moved past a failed item");
            let made: Vec<i64> = retry.created.iter().map(|c| c.number).collect();
            assert_eq!(made, vec![6], "{retry:?}");
            assert!(retry.failed.is_empty());

            // Nothing left owed: now the window moves on.
            let after = p.scan(folder, Trigger::Manual).await.expect("scan ran");
            assert!(after.since.is_some(), "{after:?}");
        })
        .await;
    }

    /// A refusal that will repeat — a merged pull request has nowhere to
    /// deliver — does not pin the window: re-reading it every scan would only
    /// re-report the same refusal.
    #[tokio::test]
    async fn a_permanent_refusal_lets_the_window_move_on() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let data_dir = tmp.path().join("data");
        std::fs::create_dir_all(&data_dir).unwrap();
        let data_dir = data_dir.to_string_lossy().to_string();

        temp_env::async_with_vars([("CODEG_DATA_DIR", Some(data_dir.as_str()))], async move {
            let (p, folder, _seen) = on_forge(tmp.path(), Pulls::Merged).await;
            save_auto(&p, Some(folder), bug_rules()).await;

            let first = p.scan(folder, Trigger::Manual).await.expect("scan ran");
            assert_eq!(first.failed.len(), 1, "{first:?}");
            assert!(
                first.failed[0].error.contains("already merged"),
                "{first:?}"
            );

            let next = p.scan(folder, Trigger::Manual).await.expect("scan ran");
            assert!(
                next.since.is_some(),
                "a permanent refusal pinned the window"
            );
        })
        .await;
    }

    /// A window whose listing outgrows a scan's page budget is worked through
    /// across scans: the next scan reads on from the page after the last one
    /// read, in the SAME window — not page one again, which would re-read the
    /// same items forever — and once the listing is read to its end, the
    /// window moves to where the FIRST scan of the sweep started.
    #[tokio::test]
    async fn a_listing_cut_short_is_read_on_across_scans() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let data_dir = tmp.path().join("data");
        std::fs::create_dir_all(&data_dir).unwrap();
        let data_dir = data_dir.to_string_lossy().to_string();

        temp_env::async_with_vars([("CODEG_DATA_DIR", Some(data_dir.as_str()))], async move {
            // One issue per page, a next page until page 150.
            let last_page = i64::from(forge_core::SCAN_MAX_PAGES) + 50;
            let pages: Arc<StdMutex<Vec<i64>>> = Arc::new(StdMutex::new(Vec::new()));
            let log = pages.clone();
            let app = axum::Router::new().route(
                "/api/v3/repos/acme/app/issues",
                get(move |Query(q): Query<Map<String, String>>| {
                    let log = log.clone();
                    async move {
                        let page: i64 = q.get("page").and_then(|p| p.parse().ok()).unwrap_or(1);
                        log.lock().unwrap().push(page);
                        let mut headers = axum::http::HeaderMap::new();
                        if page < last_page {
                            headers.insert(
                                "link",
                                format!("<http://x.test/?page={}>; rel=\"next\"", page + 1)
                                    .parse()
                                    .unwrap(),
                            );
                        }
                        (
                            headers,
                            Json(serde_json::json!([issue(page, &[], "alice")])),
                        )
                    }
                }),
            );
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let addr = listener.local_addr().unwrap();
            tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });

            let p = processor().await;
            configure_account(&p, &format!("http://{addr}")).await;
            let repo_dir = tmp.path().join("repo");
            std::fs::create_dir_all(&repo_dir).unwrap();
            let remote = format!("http://127.0.0.1:{}/acme/app.git", addr.port());
            let folder = project_folder(&p, &repo_dir, &remote).await;
            // Rules that take nothing here (no item carries `bug`), so the
            // scans are all listing.
            save_auto(&p, Some(folder), bug_rules()).await;

            let first = p.scan(folder, Trigger::Manual).await.expect("scan ran");
            assert!(first.truncated, "{first:?}");
            assert_eq!(first.since, None);
            assert_eq!(
                pages.lock().unwrap().len(),
                forge_core::SCAN_MAX_PAGES as usize
            );

            pages.lock().unwrap().clear();
            let second = p.scan(folder, Trigger::Manual).await.expect("scan ran");
            assert_eq!(second.since, None, "the sweep left its window");
            assert!(!second.truncated, "{second:?}");
            let read = pages.lock().unwrap().clone();
            assert_eq!(
                read.first().copied(),
                Some(
                    i64::from(forge_core::SCAN_MAX_PAGES) + 1
                        - i64::from(forge_core::SCAN_CONTINUATION_OVERLAP_PAGES)
                ),
                "the second scan started over instead of reading on"
            );
            assert_eq!(read.last().copied(), Some(last_page));

            // The window was read to its end: it moves to where the sweep
            // began, not to where its last scan did.
            let third = p.scan(folder, Trigger::Manual).await.expect("scan ran");
            assert_eq!(
                third.since,
                Some(
                    (first.started_at - chrono::Duration::minutes(WATERMARK_OVERLAP_MINUTES))
                        .trunc_subsecs(0)
                )
            );
        })
        .await;
    }
}
