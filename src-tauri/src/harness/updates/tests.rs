//! The update check against a stand-in for SpaceRing's `/resolve` (an HTTP
//! server on loopback, started in each test) with records and a cache in a
//! temp directory. Nothing here reaches spacering.net or the real home.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use axum::extract::Request;
use axum::http::{header, StatusCode};
use axum::response::IntoResponse;
use chrono::{DateTime, Utc};
use serde_json::{json, Value};

use super::model::{self, Answer, LatestRevision, UnknownReason, UpdateState};
use super::store::{self, Kept};
use super::*;
use crate::harness::cache::Cache;
use crate::harness::client::{Backoff, Limits};
use crate::harness::types::{ItemStatus, VersionStatus};
use crate::harness::Origin;
use crate::web::event_bridge::{WebEvent, WebEventBroadcaster};

// ─── The stand-in ───────────────────────────────────────────────────────

/// How the stand-in answers one `(id, revision)`.
#[derive(Clone)]
enum Says {
    /// Out, with this latest revision; the asked revision has this status.
    Public {
        latest: u64,
        status: &'static str,
    },
    /// Out, but without the asked revision.
    NoSuchRevision {
        latest: u64,
    },
    Retired,
    Removed,
    Unavailable,
}

fn answer_for(id: &str, revision: u64, says: &Says) -> Value {
    let state = |status: &str| {
        json!({
            "revision": revision, "status": status, "risk": "low", "reviewed": true,
            "permissions": { "declared": {}, "detected": { "runsCode": [], "installs": [],
              "installScripts": [], "network": [], "secrets": [], "paths": [], "tools": [] } },
            "checks": { "findings": { "low": 0, "medium": 0, "high": 0 }, "secrets": 0, "review": "off" },
            "packages": [], "stateSha256": "0".repeat(64)
        })
    };
    let public = |latest: u64, installed: Value| {
        json!({
            "id": id, "status": "public", "ref": format!("acme/item-{}", &id[30..]),
            "kind": "skill",
            "latest": { "revision": latest, "version": format!("{latest}.0.0"), "publishedAt": "2026-11-01T00:00:00Z" },
            "advisories": [], "installed": installed
        })
    };
    match says {
        Says::Public { latest, status } => public(*latest, state(status)),
        Says::NoSuchRevision { latest } => public(*latest, Value::Null),
        Says::Retired => {
            json!({ "id": id, "status": "retired", "installed": { "revision": revision, "status": "ok" } })
        }
        Says::Removed => {
            json!({ "id": id, "status": "removed", "installed": { "revision": revision, "status": "ok" } })
        }
        Says::Unavailable => json!({ "id": id, "status": "unavailable" }),
    }
}

type Table = Arc<Mutex<HashMap<String, Says>>>;
/// The `installed` array of each request.
type Requests = Arc<Mutex<Vec<Vec<(String, u64)>>>>;

struct Site {
    origin: String,
    /// The `installed` array of each request, as sent.
    asked: Requests,
    /// What the stand-in answers instead of `/resolve`: `None` answers.
    failing: Arc<Mutex<Option<StatusCode>>>,
    table: Table,
    task: tokio::task::JoinHandle<()>,
}

impl Site {
    async fn start() -> Self {
        let asked: Requests = Arc::default();
        let failing: Arc<Mutex<Option<StatusCode>>> = Arc::default();
        let table: Table = Arc::default();
        let app = axum::Router::new().fallback({
            let (asked, failing, table) = (asked.clone(), failing.clone(), table.clone());
            move |request: Request| {
                let (asked, failing, table) = (asked.clone(), failing.clone(), table.clone());
                async move {
                    assert_eq!(request.uri().path(), "/api/harness/v1/resolve");
                    assert_eq!(request.method(), axum::http::Method::POST);
                    let body = axum::body::to_bytes(request.into_body(), usize::MAX)
                        .await
                        .unwrap();
                    let body: Value = serde_json::from_slice(&body).unwrap();
                    let pairs: Vec<(String, u64)> = body["installed"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .map(|pair| {
                            (
                                pair["id"].as_str().unwrap().to_string(),
                                pair["revision"].as_u64().unwrap(),
                            )
                        })
                        .collect();
                    asked.lock().unwrap().push(pairs.clone());
                    if let Some(status) = *failing.lock().unwrap() {
                        let mut response = (status, "no").into_response();
                        if status == StatusCode::TOO_MANY_REQUESTS {
                            response
                                .headers_mut()
                                .insert(header::RETRY_AFTER, "7200".parse().unwrap());
                        }
                        return response;
                    }
                    let table = table.lock().unwrap();
                    let items: Vec<Value> = pairs
                        .iter()
                        .map(|(id, revision)| {
                            let says = table.get(id).cloned().unwrap_or(Says::Unavailable);
                            answer_for(id, *revision, &says)
                        })
                        .collect();
                    (
                        [(header::CONTENT_TYPE, "application/json")],
                        json!({ "items": items }).to_string(),
                    )
                        .into_response()
                }
            }
        });
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let task = tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        Self {
            origin,
            asked,
            failing,
            table,
            task,
        }
    }

    fn says(&self, id: &str, says: Says) {
        self.table.lock().unwrap().insert(id.to_string(), says);
    }

    fn fail_with(&self, status: Option<StatusCode>) {
        *self.failing.lock().unwrap() = status;
    }

    fn requests(&self) -> Vec<Vec<(String, u64)>> {
        self.asked.lock().unwrap().clone()
    }
}

impl Drop for Site {
    fn drop(&mut self) {
        self.task.abort();
    }
}

// ─── A sandbox: records, a cache, a checker ─────────────────────────────

fn id(n: u64) -> String {
    format!("00000000-0000-4000-8000-{n:012x}")
}

struct Sandbox {
    _dir: tempfile::TempDir,
    data_dir: PathBuf,
    paths: Paths,
    events: Arc<WebEventBroadcaster>,
}

impl Sandbox {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let data_dir = dir.path().join("data");
        let paths = Paths {
            cache: store::path_in(&data_dir),
            mcp_record: dir.path().join("home/.codeg/harness/mcp.json"),
            skills_store: dir.path().join("home/.codeg/skills"),
        };
        Self {
            _dir: dir,
            data_dir,
            paths,
            events: Arc::new(WebEventBroadcaster::new()),
        }
    }

    /// The MCP record: item id → its agents' revisions.
    fn mcp(&self, items: &[(&str, &[u64])]) {
        let agents = ["claude_code", "codex", "gemini_cli"];
        let items: serde_json::Map<String, Value> = items
            .iter()
            .map(|(id, revisions)| {
                let agents: serde_json::Map<String, Value> = revisions
                    .iter()
                    .zip(agents)
                    .map(|(revision, agent)| {
                        (
                            agent.to_string(),
                            json!({
                                "revision": revision, "version": format!("{revision}.0.0"),
                                "option": "official:package:0:stdio", "transport": "stdio",
                                "packages": [], "definition_sha256": "d", "state_sha256": "s",
                                "installed_at": "2026-11-16T09:30:00.000Z"
                            }),
                        )
                    })
                    .collect();
                (
                    id.to_string(),
                    json!({ "ref": "acme/notes", "key": "notes", "agents": agents }),
                )
            })
            .collect();
        write(
            &self.paths.mcp_record,
            &json!({ "format": 1, "items": items }),
        );
    }

    /// The skills manifest: (install name, item id, revision).
    fn skills(&self, entries: &[(&str, &str, u64)]) {
        let skills: serde_json::Map<String, Value> = entries
            .iter()
            .map(|(name, id, revision)| {
                (
                    name.to_string(),
                    json!({ "item_id": id, "ref": format!("acme/{name}"), "revision": revision,
                            "state_sha256": "s", "installed_at": "2026-11-16T09:30:00.000Z" }),
                )
            })
            .collect();
        write(
            &self.paths.skills_store.join(".manifest.harness.json"),
            &json!({ "format": 1, "skills": skills }),
        );
    }

    fn checker(&self, site: &Site) -> UpdateChecker {
        self.checker_switched(site, true)
    }

    fn checker_switched(&self, site: &Site, enabled: bool) -> UpdateChecker {
        let origin = Origin::parse(&site.origin).expect("a loopback origin");
        let data_dir = self.data_dir.clone();
        // a pause of its own: a 429 in one test must not hold another
        let backoff: &'static Backoff = Box::leak(Box::new(Backoff::default()));
        UpdateChecker::unscheduled(
            self.paths.clone(),
            Box::new(move || Harness {
                enabled,
                origin: origin.clone(),
                cache: Cache::in_data_dir(&data_dir),
                limits: Limits::default(),
                backoff,
            }),
            EventEmitter::test_web_only(self.events.clone()),
        )
    }

    fn kept(&self) -> Kept {
        store::load(&self.paths.cache)
    }

    fn keep(&self, kept: Kept) {
        store::put(&self.paths.cache, &kept);
    }
}

fn write(path: &Path, value: &Value) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, serde_json::to_vec_pretty(value).unwrap()).unwrap();
}

fn drain(events: &mut tokio::sync::broadcast::Receiver<WebEvent>) -> Vec<Value> {
    let mut out = Vec::new();
    while let Ok(event) = events.try_recv() {
        if event.channel == UPDATES_CHANGED_EVENT {
            out.push(event.payload.as_ref().clone());
        }
    }
    out
}

fn state_of(updates: &HarnessUpdates, id: &str) -> (UpdateState, bool) {
    let item = updates
        .items
        .iter()
        .find(|item| item.id == id)
        .unwrap_or_else(|| panic!("{id} not listed"));
    (item.state, item.update_available)
}

// ─── The derivation ─────────────────────────────────────────────────────

fn answer(
    id: &str,
    revision: u64,
    status: ItemStatus,
    version: Option<VersionStatus>,
    latest: Option<u64>,
) -> Answer {
    Answer {
        id: id.to_string(),
        revision,
        status,
        version_status: version,
        latest: latest.map(|revision| LatestRevision {
            revision,
            version: Some(format!("{revision}.0.0")),
        }),
        item_ref: latest.map(|_| "acme/x".to_string()),
    }
}

fn installed(items: &[(&str, &[u64])]) -> model::InstalledRevisions {
    items
        .iter()
        .map(|(id, revisions)| (id.to_string(), revisions.iter().copied().collect()))
        .collect()
}

#[test]
fn each_answer_comes_to_one_state() {
    use ItemStatus::*;
    use VersionStatus::*;
    let ok = Some(Ok);
    let a = id(1);
    let a = a.as_str();
    let cases: Vec<(Answer, UpdateState, bool, Option<UnknownReason>)> = vec![
        (
            answer(a, 3, Public, ok, Some(3)),
            UpdateState::Latest,
            false,
            None,
        ),
        (
            answer(a, 3, Listed, ok, Some(5)),
            UpdateState::UpdateAvailable,
            true,
            None,
        ),
        (
            answer(a, 3, Public, Some(Yanked), Some(3)),
            UpdateState::Yanked,
            false,
            None,
        ),
        // withdrawn, with a newer revision to move to
        (
            answer(a, 3, Public, Some(Yanked), Some(4)),
            UpdateState::Yanked,
            true,
            None,
        ),
        // a revision taken down by Harness
        (
            answer(a, 3, Public, Some(Blocked), Some(4)),
            UpdateState::RemovedByHarness,
            true,
            None,
        ),
        (
            answer(a, 3, Retired, ok, None),
            UpdateState::DisabledByAuthor,
            false,
            None,
        ),
        (
            answer(a, 3, Removed, ok, None),
            UpdateState::RemovedByHarness,
            false,
            None,
        ),
        (
            answer(a, 3, Unavailable, None, None),
            UpdateState::Unknown,
            false,
            Some(UnknownReason::Unavailable),
        ),
        // the item has no such revision
        (
            answer(a, 3, Public, None, Some(3)),
            UpdateState::Unknown,
            false,
            Some(UnknownReason::Unavailable),
        ),
        // a status this Codeg does not know is never "latest"
        (
            answer(a, 3, Public, Some(VersionStatus::Unknown), Some(3)),
            UpdateState::Unknown,
            false,
            Some(UnknownReason::Unavailable),
        ),
        (
            answer(a, 3, ItemStatus::Unknown, None, None),
            UpdateState::Unknown,
            false,
            Some(UnknownReason::Unavailable),
        ),
    ];
    for (answer, state, update, unknown) in cases {
        let items = model::derive(&installed(&[(a, &[3])]), std::slice::from_ref(&answer));
        assert_eq!(items.len(), 1);
        let item = &items[0];
        assert_eq!(
            (item.state, item.update_available, item.unknown),
            (state, update, unknown),
            "{answer:?}"
        );
        assert_eq!(item.revision, 3);
        assert_eq!(model::count(&items), usize::from(update));
    }

    // never asked
    let items = model::derive(&installed(&[(a, &[3])]), &[]);
    assert_eq!(items[0].state, UpdateState::Unknown);
    assert_eq!(items[0].unknown, Some(UnknownReason::NotChecked));
    assert!(items[0].latest.is_none() && items[0].item_ref.is_none());
}

#[test]
fn an_item_at_several_revisions_shows_the_most_pressing_and_updates_from_the_lowest() {
    use ItemStatus::*;
    use VersionStatus::*;
    let m = id(1);
    let m = m.as_str();
    let answers = [
        answer(m, 3, Public, Some(Yanked), Some(5)),
        answer(m, 5, Public, Some(Ok), Some(5)),
    ];
    let items = model::derive(&installed(&[(m, &[3, 5])]), &answers);
    assert_eq!(items[0].state, UpdateState::Yanked);
    assert!(items[0].update_available);
    assert_eq!(items[0].revision, 3);
    assert_eq!(items[0].latest.as_ref().unwrap().revision, 5);

    let answers = [
        answer(m, 4, Public, Some(Ok), Some(5)),
        answer(m, 5, Public, Some(Ok), Some(5)),
    ];
    let items = model::derive(&installed(&[(m, &[4, 5])]), &answers);
    assert_eq!(
        (items[0].state, items[0].update_available),
        (UpdateState::UpdateAvailable, true)
    );
}

/// A revision recorded after the last answer (an update) is read off what
/// that answer said of the item until the next check asks about it.
#[test]
fn a_revision_installed_since_the_last_check_is_read_off_that_check() {
    use ItemStatus::*;
    use VersionStatus::*;
    let a = id(1);
    let a = a.as_str();
    let told = [answer(a, 3, Public, Some(Ok), Some(5))];
    let at = |revision: u64| model::derive(&installed(&[(a, &[revision])]), &told)[0].clone();
    // updated to the latest it was told
    assert_eq!(at(5).state, UpdateState::Latest);
    assert!(!at(5).update_available);
    // to one between
    assert_eq!(at(4).state, UpdateState::UpdateAvailable);
    // past what it was told: nothing known until asked
    assert_eq!(at(6).state, UpdateState::Unknown);
    assert_eq!(at(6).unknown, Some(UnknownReason::NotChecked));

    // a stopped or taken-down item is so at every revision
    let told = [answer(a, 3, Retired, Some(Ok), None)];
    let items = model::derive(&installed(&[(a, &[4])]), &told);
    assert_eq!(items[0].state, UpdateState::DisabledByAuthor);

    // and an item no longer installed is not listed
    let items = model::derive(&installed(&[]), &told);
    assert!(items.is_empty());
}

#[test]
fn only_what_the_api_takes_is_asked() {
    assert!(model::askable(&id(1), 1));
    assert!(!model::askable(&id(1), 0));
    assert!(!model::askable("not-an-id", 1));
    assert!(model::askable("abcdef00-0000-4000-8000-0000000000ff", 1));
    assert!(!model::askable("ABCDEF00-0000-4000-8000-0000000000FF", 1));
    assert!(!model::askable("abcdef00-0000-4000-8000-0000000000fg", 1));
    assert!(!model::askable("abcdef000000-4000-8000-0000000000ff-", 1));
    let pairs = model::pairs(&installed(&[(&id(1), &[2]), ("bad", &[1])]));
    assert_eq!(pairs.len(), 1);
    assert_eq!(
        (pairs[0].id.as_str(), pairs[0].revision),
        (id(1).as_str(), 2)
    );
    // the one not asked reads as not checked, not as anything the catalog said
    let items = model::derive(&installed(&[("bad", &[1])]), &[]);
    assert_eq!(items[0].unknown, Some(UnknownReason::NotChecked));
}

// ─── When the scheduler asks ────────────────────────────────────────────

fn hours(n: i64) -> chrono::Duration {
    chrono::Duration::hours(n)
}

fn minutes(n: i64) -> chrono::Duration {
    chrono::Duration::minutes(n)
}

fn base() -> DateTime<Utc> {
    super::now() - chrono::Duration::days(30)
}

fn kept_at(checked: Option<DateTime<Utc>>, attempted: Option<DateTime<Utc>>) -> Kept {
    Kept {
        checked_at: checked,
        attempted_at: attempted,
        answers: vec![answer(
            &id(1),
            1,
            ItemStatus::Public,
            Some(VersionStatus::Ok),
            Some(1),
        )],
        ..Kept::default()
    }
}

#[test]
fn the_scheduler_asks_daily_at_once_for_a_new_revision_and_backs_off_after_failures() {
    let t = base();
    let one = installed(&[(&id(1), &[1])]);

    // nothing installed: never
    assert!(!scheduled_due(&installed(&[]), &Kept::default(), t));
    // never checked: now
    assert!(scheduled_due(&one, &Kept::default(), t));
    // checked: not until a day has passed
    let kept = kept_at(Some(t), Some(t));
    assert!(!scheduled_due(&one, &kept, t + hours(23)));
    assert!(scheduled_due(&one, &kept, t + hours(24)));
    assert_eq!(next_look(&kept, t + hours(23) + minutes(30)), t + hours(24));
    assert_eq!(
        next_look(&kept, t),
        t + hours(1),
        "it looks at least hourly"
    );
    // a revision installed since: now
    let two = installed(&[(&id(1), &[1]), (&id(2), &[1])]);
    assert!(scheduled_due(&two, &kept, t + minutes(1)));
    // a check dated ahead of the clock does not hold the next one off
    assert!(scheduled_due(&one, &kept_at(Some(t + hours(5)), None), t));

    // failures: 5 min, 30 min, 2 h, then 6 h
    for (failures, wait) in [(1, 5), (2, 30), (3, 120), (4, 360), (9, 360)] {
        let kept = Kept {
            failures,
            error: Some(CheckError {
                code: "network".into(),
                seconds: None,
                status: None,
            }),
            ..kept_at(Some(t - hours(30)), Some(t))
        };
        assert!(!scheduled_due(&one, &kept, t + minutes(wait) - minutes(1)));
        assert!(scheduled_due(&one, &kept, t + minutes(wait)), "{failures}");
        assert_eq!(next_look(&kept, t), t + minutes(wait).min(hours(1)));
    }
    // a 429 that asked for longer is waited out
    let kept = Kept {
        failures: 1,
        error: Some(CheckError {
            code: "rate_limited".into(),
            seconds: Some(7200),
            status: None,
        }),
        ..kept_at(Some(t - hours(30)), Some(t))
    };
    assert!(!scheduled_due(&one, &kept, t + minutes(119)));
    assert!(scheduled_due(&one, &kept, t + hours(2)));
}

#[test]
fn a_check_someone_asks_for_runs_an_hour_after_the_last_try_unless_they_insist() {
    let t = base();
    assert!(asked_due(&Kept::default(), t, false));
    let kept = kept_at(Some(t - hours(5)), Some(t));
    assert!(!asked_due(&kept, t + minutes(59), false));
    assert!(asked_due(&kept, t + MIN_INTERVAL, false));
    assert!(asked_due(&kept, t + minutes(1), true));
    // a try dated ahead of the clock does not hold one off
    assert!(asked_due(&kept_at(None, Some(t + hours(3))), t, false));
}

// ─── Checks against the stand-in ────────────────────────────────────────

#[tokio::test]
async fn a_check_asks_about_each_installed_revision_and_tells_each_state() {
    let site = Site::start().await;
    let sandbox = Sandbox::new();
    let (latest, update, yanked, blocked, retired, removed, gone, norev) =
        (id(1), id(2), id(3), id(4), id(5), id(6), id(7), id(8));
    sandbox.mcp(&[(&latest, &[2, 2]), (&update, &[1, 3])]);
    sandbox.skills(&[
        ("yanked", &yanked, 1),
        ("blocked", &blocked, 1),
        ("retired", &retired, 2),
        ("removed", &removed, 2),
        ("gone", &gone, 1),
        ("norev", &norev, 9),
    ]);
    site.says(
        &latest,
        Says::Public {
            latest: 2,
            status: "ok",
        },
    );
    site.says(
        &update,
        Says::Public {
            latest: 3,
            status: "ok",
        },
    );
    site.says(
        &yanked,
        Says::Public {
            latest: 1,
            status: "yanked",
        },
    );
    site.says(
        &blocked,
        Says::Public {
            latest: 2,
            status: "blocked",
        },
    );
    site.says(&retired, Says::Retired);
    site.says(&removed, Says::Removed);
    site.says(&gone, Says::Unavailable);
    site.says(&norev, Says::NoSuchRevision { latest: 3 });

    let records = (
        std::fs::read(&sandbox.paths.mcp_record).unwrap(),
        std::fs::read(sandbox.paths.skills_store.join(".manifest.harness.json")).unwrap(),
    );
    let checker = sandbox.checker(&site);
    let before = checker.updates().await.unwrap();
    assert!(before.enabled && before.checked_at.is_none());
    assert_eq!(before.items.len(), 8);
    assert!(before
        .items
        .iter()
        .all(|item| item.state == UpdateState::Unknown
            && item.unknown == Some(UnknownReason::NotChecked)));
    assert!(site.requests().is_empty(), "reading asks nothing");

    let after = checker.check_now(false).await.unwrap();
    // one request, each distinct (item, revision) once
    let requests = site.requests();
    assert_eq!(requests.len(), 1);
    let asked: BTreeSet<(String, u64)> = requests[0].iter().cloned().collect();
    assert_eq!(asked.len(), requests[0].len());
    assert_eq!(asked.len(), 9);
    assert!(asked.contains(&(update.clone(), 1)) && asked.contains(&(update.clone(), 3)));

    assert!(after.checked_at.is_some() && after.error.is_none());
    assert_eq!(after.checked_at, after.attempted_at);
    assert_eq!(state_of(&after, &latest), (UpdateState::Latest, false));
    assert_eq!(
        state_of(&after, &update),
        (UpdateState::UpdateAvailable, true)
    );
    assert_eq!(state_of(&after, &yanked), (UpdateState::Yanked, false));
    assert_eq!(
        state_of(&after, &blocked),
        (UpdateState::RemovedByHarness, true)
    );
    assert_eq!(
        state_of(&after, &retired),
        (UpdateState::DisabledByAuthor, false)
    );
    assert_eq!(
        state_of(&after, &removed),
        (UpdateState::RemovedByHarness, false)
    );
    assert_eq!(state_of(&after, &gone), (UpdateState::Unknown, false));
    assert_eq!(state_of(&after, &norev), (UpdateState::Unknown, false));
    assert_eq!(after.count, 2);
    let item = after.items.iter().find(|item| item.id == update).unwrap();
    assert_eq!(item.revision, 1);
    assert_eq!(
        item.latest,
        Some(LatestRevision {
            revision: 3,
            version: Some("3.0.0".into())
        })
    );
    assert_eq!(
        item.item_ref.as_deref(),
        Some(&*format!("acme/item-{}", &update[30..]))
    );

    // what is kept: ids, revisions and states — no snapshot, no fingerprint
    let file: Value =
        serde_json::from_slice(&std::fs::read(&sandbox.paths.cache).unwrap()).unwrap();
    for answer in file["answers"].as_array().unwrap() {
        for key in answer.as_object().unwrap().keys() {
            assert!(
                [
                    "id",
                    "revision",
                    "status",
                    "version_status",
                    "latest",
                    "ref"
                ]
                .contains(&key.as_str()),
                "{key} kept"
            );
        }
    }
    assert!(
        !String::from_utf8(std::fs::read(&sandbox.paths.cache).unwrap())
            .unwrap()
            .contains("stateSha256")
    );
    // and the records are read, never written
    assert_eq!(
        records,
        (
            std::fs::read(&sandbox.paths.mcp_record).unwrap(),
            std::fs::read(sandbox.paths.skills_store.join(".manifest.harness.json")).unwrap(),
        )
    );
    let wire = serde_json::to_value(&after).unwrap();
    assert_eq!(wire["items"][0]["state"], json!("latest"));
}

#[tokio::test]
async fn more_than_a_hundred_installed_revisions_are_asked_in_batches() {
    let site = Site::start().await;
    let sandbox = Sandbox::new();
    let names: Vec<String> = (0..250).map(|n| format!("skill-{n}")).collect();
    let ids: Vec<String> = (0..250).map(|n| id(1000 + n)).collect();
    let entries: Vec<(&str, &str, u64)> = names
        .iter()
        .zip(&ids)
        .map(|(name, id)| (name.as_str(), id.as_str(), 1))
        .collect();
    sandbox.skills(&entries);
    for id in &ids {
        site.says(
            id,
            Says::Public {
                latest: 2,
                status: "ok",
            },
        );
    }
    let updates = sandbox.checker(&site).check_now(true).await.unwrap();
    let sizes: Vec<usize> = site.requests().iter().map(Vec::len).collect();
    assert_eq!(sizes, [100, 100, 50]);
    assert!(sizes
        .iter()
        .all(|size| *size <= crate::harness::MAX_RESOLVE_ITEMS));
    assert_eq!(updates.count, 250);
    assert!(updates.error.is_none());
}

/// QA finding: a site that does not serve `/resolve` answers it 404. That is
/// a check that failed — the installed items are not taken for removed.
#[tokio::test]
async fn a_resolve_the_site_does_not_serve_is_a_failed_check_not_items_removed() {
    let site = Site::start().await;
    let sandbox = Sandbox::new();
    let a = id(1);
    sandbox.skills(&[("a", &a, 1)]);
    site.says(
        &a,
        Says::Public {
            latest: 2,
            status: "ok",
        },
    );
    let checker = sandbox.checker(&site);
    let good = checker.check_now(true).await.unwrap();
    assert_eq!(good.count, 1);

    site.fail_with(Some(StatusCode::NOT_FOUND));
    let failed = checker.check_now(true).await.unwrap();
    assert_eq!(failed.items, good.items, "the last good answer stands");
    assert_eq!(failed.count, 1);
    assert_eq!(
        failed.error,
        Some(CheckError {
            code: "resolve_unavailable".into(),
            seconds: None,
            status: None
        })
    );
    assert_eq!(sandbox.kept().failures, 1);
}

#[tokio::test]
async fn a_failed_check_keeps_the_last_good_answer_and_says_when_it_was() {
    let site = Site::start().await;
    let sandbox = Sandbox::new();
    let (a, b) = (id(1), id(2));
    sandbox.skills(&[("a", &a, 1), ("b", &b, 1)]);
    site.says(
        &a,
        Says::Public {
            latest: 2,
            status: "ok",
        },
    );
    site.says(
        &b,
        Says::Public {
            latest: 1,
            status: "ok",
        },
    );
    let checker = sandbox.checker(&site);
    let good = checker.check_now(true).await.unwrap();
    assert_eq!(good.count, 1);

    site.fail_with(Some(StatusCode::SERVICE_UNAVAILABLE));
    let failed = checker.check_now(true).await.unwrap();
    assert_eq!(site.requests().len(), 2);
    assert_eq!(failed.items, good.items, "the last good answer stands");
    assert_eq!(failed.count, 1);
    assert_eq!(failed.checked_at, good.checked_at);
    assert!(failed.attempted_at >= good.attempted_at);
    assert_eq!(
        failed.error,
        Some(CheckError {
            code: "server".into(),
            seconds: None,
            status: Some(503)
        })
    );
    assert_eq!(sandbox.kept().failures, 1);

    // a 429: the pause it asked for is kept for the scheduler
    site.fail_with(Some(StatusCode::TOO_MANY_REQUESTS));
    let limited = checker.check_now(true).await.unwrap();
    assert_eq!(limited.items, good.items);
    let error = limited.error.unwrap();
    assert_eq!(
        (error.code.as_str(), error.seconds),
        ("rate_limited", Some(3600))
    );
    assert_eq!(sandbox.kept().failures, 2);
    // and while it lasts, even an explicit check sends nothing
    let held = checker.check_now(true).await.unwrap();
    assert_eq!(site.requests().len(), 3);
    assert_eq!(held.error.unwrap().code, "rate_limited");

    // the next answer clears the error
    let fresh = Sandbox::new();
    fresh.skills(&[("a", &a, 1)]);
    site.fail_with(None);
    let checker = fresh.checker(&site);
    assert!(checker.check_now(true).await.unwrap().error.is_none());
    site.fail_with(Some(StatusCode::BAD_GATEWAY));
    assert!(checker.check_now(true).await.unwrap().error.is_some());
    site.fail_with(None);
    let again = checker.check_now(true).await.unwrap();
    assert!(again.error.is_none());
    assert_eq!(fresh.kept().failures, 0);
}

#[tokio::test]
async fn switched_off_nothing_is_read_asked_or_kept() {
    let site = Site::start().await;
    let sandbox = Sandbox::new();
    sandbox.skills(&[("a", &id(1), 1)]);
    let checker = sandbox.checker_switched(&site, false);
    let mut events = sandbox.events.subscribe();

    let read = checker.updates().await.unwrap();
    assert_eq!(read, HarnessUpdates::switched_off());
    let checked = checker.check_now(true).await.unwrap();
    assert_eq!(checked, HarnessUpdates::switched_off());
    let next = checker.turn(base()).await;
    assert_eq!(next, base() + MAX_SLEEP);

    assert!(site.requests().is_empty());
    assert!(!sandbox.paths.cache.exists());
    assert!(drain(&mut events).is_empty());
    assert!(!serde_json::to_value(&read).unwrap()["enabled"]
        .as_bool()
        .unwrap());
}

#[tokio::test]
async fn a_check_that_does_not_insist_waits_an_hour_after_the_last_try() {
    let site = Site::start().await;
    let sandbox = Sandbox::new();
    let a = id(1);
    sandbox.skills(&[("a", &a, 1)]);
    site.says(
        &a,
        Says::Public {
            latest: 1,
            status: "ok",
        },
    );
    let checker = sandbox.checker(&site);

    // tried half an hour ago (and failed): a section opening asks nothing
    let now = super::now();
    sandbox.keep(Kept {
        attempted_at: Some(now - minutes(30)),
        failures: 1,
        error: Some(CheckError {
            code: "network".into(),
            seconds: None,
            status: None,
        }),
        ..Kept::default()
    });
    let held = checker.check_now(false).await.unwrap();
    assert!(site.requests().is_empty());
    assert_eq!(held.error.unwrap().code, "network");
    // the user insisting does ask
    let asked = checker.check_now(true).await.unwrap();
    assert_eq!(site.requests().len(), 1);
    assert_eq!(state_of(&asked, &a), (UpdateState::Latest, false));
    // and right after it, a section opening does not
    checker.check_now(false).await.unwrap();
    assert_eq!(site.requests().len(), 1);

    // an hour after the last try, it does
    let mut kept = sandbox.kept();
    kept.attempted_at = Some(now - minutes(61));
    kept.checked_at = kept.attempted_at;
    sandbox.keep(kept);
    checker.check_now(false).await.unwrap();
    assert_eq!(site.requests().len(), 2);

    // nothing installed: nothing to ask, however explicit
    let empty = Sandbox::new();
    let updates = empty.checker(&site).check_now(true).await.unwrap();
    assert_eq!(site.requests().len(), 2);
    assert!(updates.items.is_empty() && updates.attempted_at.is_none());
}

#[tokio::test]
async fn the_scheduler_asks_when_due_and_backs_off_after_a_failure() {
    let site = Site::start().await;
    let sandbox = Sandbox::new();
    let a = id(1);
    sandbox.skills(&[("a", &a, 1)]);
    site.says(
        &a,
        Says::Public {
            latest: 2,
            status: "ok",
        },
    );
    let checker = sandbox.checker(&site);
    let t = base();

    // never checked: asks, and looks again in an hour
    assert_eq!(checker.turn(t).await, t + hours(1));
    assert_eq!(site.requests().len(), 1);
    assert_eq!(sandbox.kept().checked_at, Some(t));
    // within the day: asks nothing
    assert_eq!(checker.turn(t + hours(23)).await, t + hours(24));
    assert_eq!(site.requests().len(), 1);
    // a day on: asks again
    site.fail_with(Some(StatusCode::INTERNAL_SERVER_ERROR));
    let next = checker.turn(t + hours(24)).await;
    assert_eq!(site.requests().len(), 2);
    // failed: back in five minutes, the answer of the day before kept
    assert_eq!(next, t + hours(24) + minutes(5));
    let kept = sandbox.kept();
    assert_eq!((kept.checked_at, kept.failures), (Some(t), 1));
    assert_eq!(kept.answers.len(), 1);
    assert!(checker.turn(t + hours(24) + minutes(4)).await > t + hours(24) + minutes(4));
    assert_eq!(site.requests().len(), 2);
    site.fail_with(None);
    checker.turn(t + hours(24) + minutes(5)).await;
    assert_eq!(site.requests().len(), 3);
    assert_eq!(sandbox.kept().failures, 0);
}

#[tokio::test]
async fn changes_are_announced_with_the_count_and_the_ids_only() {
    let site = Site::start().await;
    let sandbox = Sandbox::new();
    let (a, b, c) = (id(1), id(2), id(3));
    sandbox.mcp(&[(&a, &[1])]);
    sandbox.skills(&[("b", &b, 1), ("c", &c, 1)]);
    site.says(
        &a,
        Says::Public {
            latest: 2,
            status: "ok",
        },
    );
    site.says(
        &b,
        Says::Public {
            latest: 1,
            status: "ok",
        },
    );
    site.says(
        &c,
        Says::Public {
            latest: 3,
            status: "ok",
        },
    );
    let checker = sandbox.checker(&site);
    let mut events = sandbox.events.subscribe();
    let t = base();

    // the first check: every item went from not checked to a state
    checker.turn(t).await;
    let announced = drain(&mut events);
    assert_eq!(announced.len(), 1);
    assert_eq!(announced[0], json!({ "count": 2, "item_ids": [a, b, c] }));
    assert_eq!(
        announced[0].as_object().unwrap().keys().collect::<Vec<_>>(),
        ["count", "item_ids"]
    );

    // a check that changes nothing announces nothing
    checker.turn(t + hours(24)).await;
    assert_eq!(site.requests().len(), 2);
    assert!(drain(&mut events).is_empty());

    // a change on the site: only that item
    site.says(
        &b,
        Says::Public {
            latest: 1,
            status: "yanked",
        },
    );
    checker.turn(t + hours(48)).await;
    assert_eq!(drain(&mut events), [json!({ "count": 2, "item_ids": [b] })]);

    // the records change (c updated to its latest, a uninstalled): announced
    // without a request, read off the last answer
    sandbox.mcp(&[]);
    sandbox.skills(&[("b", &b, 1), ("c", &c, 3)]);
    let requests = site.requests().len();
    checker.turn(t + hours(48) + minutes(1)).await;
    let announced = drain(&mut events);
    assert_eq!(announced[0], json!({ "count": 0, "item_ids": [a, c] }));
    // and the new revision is then asked about at once
    assert_eq!(site.requests().len(), requests + 1);
    assert_eq!(
        site.requests().last().unwrap(),
        &vec![(b.clone(), 1), (c.clone(), 3)]
    );

    // a failure changes no state: nothing announced
    site.fail_with(Some(StatusCode::BAD_GATEWAY));
    checker.check_now(true).await.unwrap();
    assert!(drain(&mut events).is_empty());
}

#[tokio::test]
async fn a_change_to_the_records_wakes_the_scheduler() {
    let site = Site::start().await;
    let sandbox = Sandbox::new();
    let a = id(1);
    site.says(
        &a,
        Says::Public {
            latest: 1,
            status: "ok",
        },
    );
    let (kicks, receiver) = mpsc::unbounded_channel();
    let mut checker = sandbox.checker(&site);
    checker.kicks = Some(kicks);
    checker.receiver = Mutex::new(Some(receiver));
    let checker = Arc::new(checker);
    let mut events = sandbox.events.subscribe();
    let running = tokio::spawn(run(checker.clone()));

    // installed after start, well before the first look
    sandbox.skills(&[("a", &a, 1)]);
    checker.kick();
    let event = tokio::time::timeout(std::time::Duration::from_secs(20), async {
        loop {
            let event = events.recv().await.unwrap();
            if event.channel == UPDATES_CHANGED_EVENT
                && event.payload["count"] == json!(0)
                && checker.updates().await.unwrap().checked_at.is_some()
            {
                return event.payload.as_ref().clone();
            }
        }
    })
    .await
    .expect("the scheduler looked at once");
    assert_eq!(event["item_ids"], json!([a]));
    assert_eq!(site.requests(), [vec![(a.clone(), 1)]]);
    running.abort();
}

fn network() -> CheckError {
    CheckError {
        code: "network".into(),
        seconds: None,
        status: None,
    }
}

fn answered_at(t: DateTime<Utc>, latest: u64) -> Kept {
    Kept {
        format: 1,
        checked_at: Some(t),
        attempted_at: Some(t),
        answers: vec![answer(
            &id(1),
            1,
            ItemStatus::Public,
            Some(VersionStatus::Ok),
            Some(latest),
        )],
        ..Kept::default()
    }
}

/// Two Codegs on one data directory: whichever finishes last, the answers
/// of the later check and the details of the later try are what is kept.
#[test]
fn checks_that_overlap_never_take_back_a_later_answer() {
    let t = super::now() - hours(1);
    let ours = vec![answer(
        &id(1),
        1,
        ItemStatus::Public,
        Some(VersionStatus::Ok),
        Some(9),
    )];

    // a later check answered while ours ran: theirs stands whole
    let there = answered_at(t + minutes(2), 2);
    let merged = store::merge(there.clone(), t, store::Outcome::Answered(ours.clone()));
    assert_eq!(merged, there);

    // ours answered later than what is kept: ours
    let merged = store::merge(
        answered_at(t - minutes(2), 2),
        t,
        store::Outcome::Answered(ours.clone()),
    );
    assert_eq!(
        (merged.checked_at, merged.answers.clone()),
        (Some(t), ours.clone())
    );
    assert_eq!((merged.failures, merged.error.is_none()), (0, true));

    // ours failed after another's answer landed: the answer stays, the
    // failure is said
    let there = answered_at(t - minutes(2), 2);
    let merged = store::merge(there.clone(), t, store::Outcome::Failed(network()));
    assert_eq!(
        (merged.checked_at, &merged.answers),
        (there.checked_at, &there.answers)
    );
    assert_eq!((merged.attempted_at, merged.failures), (Some(t), 1));
    assert_eq!(merged.error, Some(network()));

    // ours answered, and a later try failed meanwhile: our answers, their
    // failure (the last try did fail)
    let there = Kept {
        attempted_at: Some(t + minutes(1)),
        failures: 1,
        error: Some(network()),
        ..answered_at(t - hours(5), 2)
    };
    let merged = store::merge(there, t, store::Outcome::Answered(ours.clone()));
    assert_eq!((merged.checked_at, merged.answers), (Some(t), ours));
    assert_eq!(
        (merged.attempted_at, merged.failures),
        (Some(t + minutes(1)), 1)
    );

    // a date ahead of the clock is no later check
    let there = answered_at(super::now() + hours(5), 2);
    let merged = store::merge(there, t, store::Outcome::Failed(network()));
    assert_eq!(merged.attempted_at, Some(t));
}

#[tokio::test]
async fn the_file_is_merged_under_a_lock_and_not_written_without_it() {
    let sandbox = Sandbox::new();
    let t = super::now() - hours(1);
    sandbox.keep(answered_at(t, 2));

    // recorded: merged into what is there
    let kept = store::record(
        &sandbox.paths.cache,
        t + minutes(1),
        store::Outcome::Failed(network()),
    );
    assert_eq!(sandbox.kept(), kept);
    assert_eq!((kept.checked_at, kept.failures), (Some(t), 1));

    // another Codeg holds the lock: nothing is written (an unlocked write
    // could take back its newer answer), the merge is still answered
    let lock = std::fs::OpenOptions::new()
        .write(true)
        .open(sandbox.paths.cache.with_file_name(store::LOCK_NAME))
        .unwrap();
    lock.lock().unwrap();
    let before = std::fs::read(&sandbox.paths.cache).unwrap();
    let kept = store::record(
        &sandbox.paths.cache,
        t + minutes(2),
        store::Outcome::Failed(network()),
    );
    assert_eq!(kept.failures, 2);
    assert_eq!(std::fs::read(&sandbox.paths.cache).unwrap(), before);
    lock.unlock().unwrap();

    // a damaged file reads as never checked
    std::fs::write(&sandbox.paths.cache, "{ not json").unwrap();
    assert_eq!(sandbox.kept(), Kept::default());
}

#[tokio::test]
async fn a_record_that_cannot_be_read_leaves_the_other_asked() {
    let site = Site::start().await;
    let sandbox = Sandbox::new();
    let b = id(2);
    std::fs::create_dir_all(sandbox.paths.mcp_record.parent().unwrap()).unwrap();
    std::fs::write(&sandbox.paths.mcp_record, "{ broken").unwrap();
    sandbox.skills(&[("b", &b, 1)]);
    site.says(
        &b,
        Says::Public {
            latest: 1,
            status: "ok",
        },
    );
    let updates = sandbox.checker(&site).check_now(true).await.unwrap();
    assert_eq!(site.requests(), [vec![(b.clone(), 1)]]);
    assert_eq!(updates.items.len(), 1);
    // and the record is left as it was
    assert_eq!(
        std::fs::read_to_string(&sandbox.paths.mcp_record).unwrap(),
        "{ broken"
    );
}

#[test]
fn the_result_is_kept_in_the_harness_cache_outside_the_backup() {
    let data_dir = Path::new("/data");
    let path = store::path_in(data_dir);
    assert_eq!(path, Path::new("/data/cache/harness/updates.json"));
    assert!(path.starts_with(crate::harness::cache_dir(data_dir)));
    // `cache.rs`' `the_cache_is_outside_the_backup` holds for all of
    // `cache/harness/`; the http cache's pruning stays within `http/`
    assert!(!path.starts_with(crate::harness::cache_dir(data_dir).join("http")));
}

/// The desktop app and the server each start the check, the same way.
#[test]
fn both_runtimes_start_the_check() {
    let desktop = include_str!("../../lib.rs");
    let server = include_str!("../../bin/codeg_server.rs");
    assert!(desktop.contains("crate::harness::updates::build("));
    assert!(desktop.contains("spawn(crate::harness::updates::run(checker))"));
    assert!(server.contains("codeg_lib::harness::updates::build("));
    assert!(server.contains("tokio::spawn(codeg_lib::harness::updates::run(checker))"));
    // and both answer the two commands
    let router = include_str!("../../web/router.rs");
    assert!(router.contains("handlers::harness_updates::harness_updates)"));
    assert!(router.contains("handlers::harness_updates::harness_check_updates)"));
    assert!(desktop.contains("crate::commands::harness_updates::harness_updates,"));
    assert!(desktop.contains("crate::commands::harness_updates::harness_check_updates,"));
}

#[test]
fn the_wire_names_are_snake_case() {
    let a = id(1);
    let updates = HarnessUpdates {
        enabled: true,
        checking: false,
        checked_at: None,
        attempted_at: None,
        error: None,
        items: model::derive(
            &installed(&[(&a, &[1])]),
            &[answer(
                &a,
                1,
                ItemStatus::Public,
                Some(VersionStatus::Ok),
                Some(2),
            )],
        ),
        count: 1,
    };
    let wire = serde_json::to_value(&updates).unwrap();
    assert_eq!(
        wire["items"][0],
        json!({
            "id": a, "revision": 1, "state": "update_available", "update_available": true,
            "latest": { "revision": 2, "version": "2.0.0" }, "ref": "acme/x"
        })
    );
    for (state, name) in [
        (UpdateState::Latest, "latest"),
        (UpdateState::Yanked, "yanked"),
        (UpdateState::DisabledByAuthor, "disabled_by_author"),
        (UpdateState::RemovedByHarness, "removed_by_harness"),
        (UpdateState::Unknown, "unknown"),
    ] {
        assert_eq!(serde_json::to_value(state).unwrap(), json!(name));
    }
    let _: BTreeMap<String, Value> = serde_json::from_value(wire).unwrap();
}
