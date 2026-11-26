//! Proposal rules (6.7): codeg looks — without a model — for what is worth
//! the owner's time, and puts it on a card with the next step.
//!
//! - **The rules**: work failed with nobody on it (`failed`); a board task
//!   waiting long for review with no round of acceptance (`review`); a
//!   session waiting on the owner while they are not in it (`session`); a
//!   pull request waiting for their review (`pr_review`); changes left
//!   uncommitted (`uncommitted`); a matter gone quiet (`idle`); a
//!   dispatched task's branch behind its target with conflicts (`behind`). Each is on or off and has
//!   its threshold in the preferences; the disturbance levels set them
//!   (13.4). The repeat offer (`repeat`, 6.9) and the assistants' own
//!   suggestions (`suggest`) are rules too, raised where they happen.
//! - **Where**: a card about a piece of dispatched work goes to the
//!   assistant that dispatched it, a matter's to its assistant; the rest to
//!   the primary.
//! - **Once**: one card per topic (rule + object) at a time; a card the
//!   owner dismissed keeps its topic quiet [`COOLDOWN_DAYS`] days; one
//!   occurrence (`episode`) gets one card at most. A card whose thing is
//!   gone (the session answered, the task merged) expires.
//! - **Converging**: [`QUIET_AFTER`] of a rule's cards dismissed in a row
//!   lower it one level (urgent → normal → low: no notification) until the
//!   owner puts it back, or acts on one of its cards. "Don't suggest these"
//!   on a card turns its rule off; the preferences turn it on again. With
//!   the owner's record of their answers off (`reactions`), nothing is
//!   lowered (5.2).
//! - **The weekly review's questions** (6.6) are rules too, raised with the
//!   review: the changes the owner keeps undoing (`undo` — show such
//!   changes first?) and a work assistant nobody woke for two weeks
//!   (`idle_bot` — hide it or delete it?).
//!
//! The scan runs on the host's clock every [`SCAN_EVERY_SECS`] seconds, off
//! its loop; the rules that read git or a forge look every
//! [`SLOW_EVERY_MINUTES`] minutes.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration as StdDuration;

use chrono::{DateTime, Duration, Utc};
use sea_orm::{ColumnTrait, EntityTrait, QueryFilter};
use serde::Serialize;
use serde_json::{json, Value};

use super::clock;
use super::dispatch::FollowupAuth;
use super::engine::PersonalAgentEngine;
use super::host::EngineHost;
use super::reach::{glimpse, News, NotifyLink, What};
use super::tools::ToolOutcome;
use crate::db::entities::folder::{self, FolderKind};
use crate::db::entities::personal_agent_dispatch::{self as dispatch_entity, DispatchMode, DispatchState};
use crate::db::entities::personal_agent_item::{self as item_entity, ItemKind, ItemStatus};
use crate::db::entities::personal_agent_notice::{
    self as notice_entity, NoticeKind, NoticeLevel, NoticeState,
};
use crate::db::entities::personal_agent_timeline::TimelineKind;
use crate::db::entities::personal_agent_verification::VerificationState;
use crate::db::entities::work_task::WorkTaskStatus;
use crate::db::service::personal_agent_rule_service as rsvc;
use crate::db::service::personal_agent_service as svc;
use crate::db::service::personal_agent_service::{NewNotice, NewRow};
use crate::db::service::personal_agent_verification_service as vsvc;
use crate::db::AppDatabase;
use crate::models::personal_agent::{PersonalAgentChange, TimelineRow};
use crate::models::personal_agent_prefs::{
    AccountView, Level, Prefs,
};

/// The rules codeg scans for.
pub const SCANNED: &[&str] = &[
    "failed",
    "review",
    "session",
    "pr_review",
    "uncommitted",
    "idle",
    "behind",
];
/// Every rule: the scanned ones, the repeat offer and the assistants' own
/// suggestions.
pub const ALL: &[&str] = &[
    "failed",
    "review",
    "session",
    "pr_review",
    "uncommitted",
    "idle",
    "behind",
    "repeat",
    "suggest",
    "undo",
    "idle_bot",
];
/// The rules that read git or a forge, or a month of work: looked at less
/// often.
const SLOW: &[&str] = &["pr_review", "uncommitted", "behind"];
/// A topic the owner dismissed stays quiet this long.
pub const COOLDOWN_DAYS: i64 = 7;
/// This many of a rule's cards dismissed in a row lower it one level.
pub const QUIET_AFTER: usize = 3;
/// How often the rules look.
pub const SCAN_EVERY_SECS: i64 = 60;
/// How often the rules that read git or a forge look.
pub const SLOW_EVERY_MINUTES: i64 = 30;
/// What had failed this long before the rule first looked is old news; what
/// fails after, however long it stays failed, is not.
const FAILED_FRESH_DAYS: i64 = 3;
/// The folders one look reads with git, at most.
const FOLDERS_READ: usize = 60;
const GIT_TIMEOUT: StdDuration = StdDuration::from_secs(10);
const FORGE_TIMEOUT: StdDuration = StdDuration::from_secs(25);
/// One look at the pull requests waiting for the owner's review takes this
/// long at most: the projects it does not reach are read first next time.
const PR_SCAN_BUDGET: StdDuration = StdDuration::from_secs(60);
/// Where the rule's own record keeps the last time the owner put it back.
const RESET_KEY: &str = "reset_at";

/// What an executor is told when the owner has codeg retry its failed work.
pub const RETRY_FAILED_MESSAGE: &str = "Your last attempt at this failed. Look at what went wrong \
and try again.";

/// The words a branch behind its target is sent back with.
fn rebase_message(base: &str) -> String {
    format!(
        "The target branch `{base}` moved on since this branch was made, and the two now \
         conflict. Rebase this branch onto the latest `{base}`, resolve the conflicts keeping \
         what this work set out to do, and check it still works."
    )
}

/// The kind of news a rule's card is told as; a lowered rule's is one level
/// down (urgent → normal → low).
pub fn news_kind(rule: &str, lowered: bool) -> &'static str {
    match (rule, lowered) {
        ("session", false) => "waiting",
        ("session", true) => "proposal",
        ("failed" | "review" | "pr_review", false) => "proposal",
        _ => "proposal_low",
    }
}

/// A card's topic: the rule and what it is about.
pub fn subject(rule: &str, object: &str) -> String {
    format!("rule:{rule}:{object}")
}

/// The topic prefix of a rule's cards.
pub fn subject_prefix(rule: &str) -> String {
    match rule {
        "repeat" => "repeat:".into(),
        "suggest" => "suggest:".into(),
        r => format!("rule:{r}:"),
    }
}

fn notice_level(l: Level) -> NoticeLevel {
    match l {
        Level::Urgent => NoticeLevel::Urgent,
        Level::Normal => NoticeLevel::Normal,
        Level::Low => NoticeLevel::Low,
    }
}

/// Whether a card for this occurrence may be raised, given the cards of its
/// topic so far (any order): none open, none for this very occurrence, none
/// dismissed within [`COOLDOWN_DAYS`].
pub fn may_raise(earlier: &[notice_entity::Model], episode: &str, now: DateTime<Utc>) -> bool {
    for n in earlier {
        if matches!(n.state, NoticeState::Open | NoticeState::Acting) {
            return false;
        }
        let p: Value = serde_json::from_str(&n.payload).unwrap_or(Value::Null);
        if p["episode"].as_str() == Some(episode) {
            return false;
        }
        if matches!(n.state, NoticeState::Dismissed | NoticeState::Muted) {
            let at = n.acted_at.unwrap_or(n.updated_at);
            if now - at < Duration::days(COOLDOWN_DAYS) {
                return false;
            }
        }
    }
    true
}

/// Whether the owner's latest answers (the latest first) say to lower the
/// rule: the last [`QUIET_AFTER`] were all "not now".
pub fn goes_quiet(answers: &[NoticeState]) -> bool {
    answers.len() >= QUIET_AFTER
        && answers[..QUIET_AFTER]
            .iter()
            .all(|s| matches!(s, NoticeState::Dismissed | NoticeState::Muted))
}

/// The rule's own record, as data.
async fn rule_record(db: &AppDatabase, rule: &str) -> Value {
    rsvc::get(&db.conn, rule, rsvc::RULE_ITSELF)
        .await
        .ok()
        .flatten()
        .and_then(|r| r.data)
        .and_then(|d| serde_json::from_str(&d).ok())
        .unwrap_or_else(|| json!({}))
}

async fn write_record(db: &AppDatabase, rule: &str, record: &Value) {
    if let Err(e) = rsvc::set_data(&db.conn, rule, rsvc::RULE_ITSELF, record, clock::now()).await
    {
        tracing::warn!("[personal-agent] rule {rule}: its record was not written: {e}");
    }
}

fn time_of(v: &Value) -> Option<DateTime<Utc>> {
    v.as_str()
        .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
        .map(|t| t.with_timezone(&Utc))
}

// The rule's own times are wall-clock, as the cards' answers are
// (`acted_at`): a reset is compared with them.

/// Whether codeg lowered rule `rule` (6.7, 5.2): since when.
pub async fn quiet_since(db: &AppDatabase, rule: &str) -> Option<DateTime<Utc>> {
    time_of(&rule_record(db, rule).await["quiet_since"])
}

/// The owner answered one of rule `rule`'s cards: `acted` on it, or not.
/// Acting on one puts a lowered rule back; the last [`QUIET_AFTER`]
/// dismissed in a row lower it (the scanned rules only: the others are low
/// already). Returns whether it was lowered now.
pub async fn after_answer(db: &AppDatabase, rule: &str, acted: bool) -> bool {
    if !SCANNED.contains(&rule) {
        return false;
    }
    // The owner keeps no record of their answers: nothing is lowered.
    if !acted && !records_reactions(db).await {
        return false;
    }
    let mut record = rule_record(db, rule).await;
    if acted {
        if record.get("quiet_since").is_some_and(|v| !v.is_null()) {
            record["quiet_since"] = Value::Null;
            record[RESET_KEY] = json!(Utc::now().to_rfc3339());
            write_record(db, rule, &record).await;
        }
        return false;
    }
    if record.get("quiet_since").is_some_and(|v| !v.is_null()) {
        return false;
    }
    let after = time_of(&record[RESET_KEY]);
    let answers: Vec<NoticeState> =
        rsvc::answered_with_prefix(&db.conn, &subject_prefix(rule), after, QUIET_AFTER as u64)
            .await
            .unwrap_or_default()
            .into_iter()
            .map(|n| n.state)
            .collect();
    if !goes_quiet(&answers) {
        return false;
    }
    record["quiet_since"] = json!(Utc::now().to_rfc3339());
    write_record(db, rule, &record).await;
    true
}

/// Whether the owner has codeg learn from how they answer its cards (5.2).
async fn records_reactions(db: &AppDatabase) -> bool {
    match svc::primary_bot(&db.conn).await.ok().flatten() {
        Some(p) => AccountView::from_settings(&p.settings)
            .prefs
            .records_reactions(),
        None => true,
    }
}

/// The owner put a lowered rule back (the preferences' [Put back]).
pub async fn reset_rule(db: &AppDatabase, rule: &str) -> Result<(), String> {
    if !ALL.contains(&rule) {
        return Err(format!("no rule `{rule}`"));
    }
    let mut record = rule_record(db, rule).await;
    record["quiet_since"] = Value::Null;
    record[RESET_KEY] = json!(Utc::now().to_rfc3339());
    write_record(db, rule, &record).await;
    Ok(())
}

/// One rule as the preferences show it.
#[derive(Debug, Clone, Serialize)]
pub struct RuleView {
    pub rule: &'static str,
    /// When the owner muted it from a card (it is off since).
    pub muted_at: Option<DateTime<Utc>>,
    /// When codeg lowered it, the owner having dismissed its cards.
    pub quiet_since: Option<DateTime<Utc>>,
    /// Its cards in the last 30 days: raised, acted on, dismissed.
    pub raised: u32,
    pub acted: u32,
    pub dismissed: u32,
}

/// Every rule's record, for the preferences.
pub async fn rule_views(db: &AppDatabase) -> Vec<RuleView> {
    let since = clock::now() - Duration::days(30);
    let mut out = Vec::new();
    for rule in ALL {
        let record = rule_record(db, rule).await;
        let (raised, acted, dismissed) = rsvc::counts_since(&db.conn, &subject_prefix(rule), since)
            .await
            .unwrap_or_default();
        out.push(RuleView {
            rule,
            muted_at: time_of(&record["muted_at"]),
            quiet_since: time_of(&record["quiet_since"]),
            raised,
            acted,
            dismissed,
        });
    }
    out
}

/// The rule a card stands for, and whether "don't suggest these" applies
/// to it: a rule's card, the repeat offer, an assistant's suggestion. A
/// card the owner's own settings raised (`confirm`) has no rule.
pub fn rule_of_card(n: &notice_entity::Model, data: &Value) -> Option<&'static str> {
    let payload: Value = serde_json::from_str(&n.payload).unwrap_or(Value::Null);
    let subject = n.subject_key.as_deref().unwrap_or("");
    if subject.starts_with("confirm:") {
        return None;
    }
    match n.kind {
        NoticeKind::Rule => {
            let r = payload["rule"].as_str()?;
            ALL.iter().copied().find(|x| *x == r)
        }
        NoticeKind::Routine => match payload["what"].as_str() {
            Some("repeat") => Some("repeat"),
            // One shown first because the owner asked so is no suggestion.
            Some("proposal") if payload["why"].as_str() != Some("confirm") => Some("suggest"),
            _ => None,
        },
        NoticeKind::Proposal => (data["why"].as_str() == Some("proposal")).then_some("suggest"),
        NoticeKind::Changed => (payload["why"].as_str() == Some("suggest")
            || data["why"].as_str() == Some("suggest"))
        .then_some("suggest"),
        NoticeKind::Forge => (payload["call"]["why"].as_str() == Some("suggest"))
            .then_some("suggest"),
        _ => None,
    }
}

// ── what a rule found ───────────────────────────────────────────────────────

/// One thing a rule found.
#[derive(Debug, Clone)]
pub struct Found {
    pub rule: &'static str,
    /// What it is about (`dispatch:45`, `task:12`, `folder:3`).
    pub object: String,
    /// This occurrence of it: one card at most.
    pub episode: String,
    /// The assistant whose card it is.
    pub bot: i32,
    /// Since when it is so: the threshold counts from here.
    pub since: DateTime<Utc>,
    /// Found, but not to be raised now (the owner is in that session).
    pub held: bool,
    /// What the card shows (and the page words): ids, titles, links.
    pub facts: Value,
    /// A line for the timeline and the notification: what it is about.
    pub text: String,
}

/// The rules' clock on the host.
#[derive(Default)]
pub struct RuleClock {
    busy: AtomicBool,
    last: Mutex<Option<DateTime<Utc>>>,
    slow: Mutex<HashMap<&'static str, DateTime<Utc>>>,
    /// Where the next look at the pull requests waiting for review starts
    /// among the projects watched: after the last one this one reached.
    /// In memory: a restart starts from the first.
    pr_cursor: AtomicUsize,
}

impl RuleClock {
    /// Whether a look is due at `now` (taking it).
    fn due(&self, now: DateTime<Utc>) -> bool {
        let mut last = self.last.lock().unwrap_or_else(|e| e.into_inner());
        if last.is_some_and(|t| now - t < Duration::seconds(SCAN_EVERY_SECS) && now >= t) {
            return false;
        }
        *last = Some(now);
        true
    }

    /// Whether a slow rule is due a look at `now` (taking it).
    fn slow_due(&self, rule: &'static str, now: DateTime<Utc>) -> bool {
        let mut slow = self.slow.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(t) = slow.get(rule) {
            if now - *t < Duration::minutes(SLOW_EVERY_MINUTES) && now >= *t {
                return false;
            }
        }
        slow.insert(rule, now);
        true
    }
}

/// Lets the rules' look go when it ends, however it ends.
struct Release(Arc<EngineHost>);

impl Drop for Release {
    fn drop(&mut self) {
        self.0.rules.busy.store(false, Ordering::SeqCst);
    }
}

/// What one look goes by.
pub(super) struct Look {
    pub now: DateTime<Utc>,
    pub prefs: Prefs,
    pub primary: i32,
}

/// The project a `pr_review` record or card is about (`pr:{project}:…`).
fn pr_project(object: &str) -> Option<i32> {
    let mut parts = object.split(':');
    (parts.next() == Some("pr"))
        .then(|| parts.next()?.parse().ok())
        .flatten()
}

/// Which pull request a review request is, as its forge names it: from its
/// page's address — the instance, the repository and the number in one,
/// whatever this checkout's remote or the account used says. `None` for a
/// row without one.
pub(super) fn pr_ident(html_url: &str) -> Option<String> {
    use sha1::{Digest, Sha1};
    let url = html_url.trim();
    let url = url.split(['?', '#']).next().unwrap_or("").trim_end_matches('/');
    if url.is_empty() {
        return None;
    }
    // The host is a name, whatever its case; the path is the forge's.
    let normalized = match url.split_once("://") {
        Some((scheme, rest)) => {
            let (authority, path) = rest.split_at(rest.find('/').unwrap_or(rest.len()));
            format!(
                "{}://{}{path}",
                scheme.to_ascii_lowercase(),
                authority.to_ascii_lowercase()
            )
        }
        None => url.to_string(),
    };
    let digest = Sha1::digest(normalized.as_bytes());
    Some(digest.iter().take(6).map(|b| format!("{b:02x}")).collect())
}

/// What is watched now, read in `conn` (inside a transaction, the same
/// moment as its writes).
async fn watched_in<C: sea_orm::ConnectionTrait>(
    conn: &C,
    primary: i32,
) -> Result<HashSet<i32>, sea_orm::DbErr> {
    let Some(row) = crate::db::entities::personal_agent::Entity::find_by_id(primary)
        .one(conn)
        .await?
    else {
        return Ok(HashSet::new());
    };
    let scope = AccountView::from_settings(&row.settings).prefs.projects;
    Ok(super::projects::eligible_in(conn)
        .await?
        .into_iter()
        .map(|f| f.id)
        .filter(|id| scope.covers(*id))
        .collect())
}

/// The review requests about to be raised, claimed in one transaction that
/// holds the write lock from its start: each one's project is read again
/// against what is watched now — one no longer watched is taken out, its
/// project returned to let go of; the others' records lose `out`, and the
/// count of times they left (`resets`) makes their episode, with when they
/// were first seen.
async fn claim_pr_reviews(
    db: &AppDatabase,
    primary: i32,
    found: Vec<Found>,
) -> Result<(Vec<Found>, Vec<i32>), sea_orm::DbErr> {
    use crate::db::entities::personal_agent_rule_state as state;
    use sea_orm::{ActiveModelTrait, ActiveValue::Set, TransactionTrait};
    let txn = db.conn.begin().await?;
    svc::claim_row(&txn, primary)
        .await
        .map_err(|e| sea_orm::DbErr::Custom(e.to_string()))?;
    let watched = watched_in(&txn, primary).await?;
    let mut kept = Vec::with_capacity(found.len());
    let mut left: Vec<i32> = Vec::new();
    for mut f in found {
        let Some(p) = pr_project(&f.object) else {
            continue;
        };
        if !watched.contains(&p) {
            if !left.contains(&p) {
                left.push(p);
            }
            continue;
        }
        if !f.held {
            let rec = state::Entity::find()
                .filter(state::Column::Rule.eq("pr_review"))
                .filter(state::Column::Object.eq(f.object.as_str()))
                .one(&txn)
                .await?;
            let resets = match rec {
                Some(rec) => {
                    let mut data = data_of_row(rec.data.as_deref());
                    let resets = data["resets"].as_u64().unwrap_or(0);
                    if data["out"].as_bool() == Some(true) {
                        data["out"] = json!(false);
                        let mut a: state::ActiveModel = rec.into();
                        a.data = Set(Some(data.to_string()));
                        a.updated_at = Set(Utc::now());
                        a.update(&txn).await?;
                    }
                    resets
                }
                None => 0,
            };
            f.episode = format!("{}:{resets}", f.since.timestamp_millis());
        }
        kept.push(f);
    }
    txn.commit().await?;
    Ok((kept, left))
}

fn project_name(f: &folder::Model) -> String {
    f.alias.clone().filter(|a| !a.trim().is_empty()).unwrap_or_else(|| f.name.clone())
}

/// Run `fut`, or give up after `limit`.
async fn bounded<T>(limit: StdDuration, fut: impl std::future::Future<Output = T>) -> Option<T> {
    tokio::time::timeout(limit, fut).await.ok()
}

impl EngineHost {
    /// The host's clock: a look at the rules, when one is due and none runs.
    pub(super) fn spawn_rules_tick(self: &Arc<Self>) {
        let now = clock::now();
        if !self.rules.due(now) {
            return;
        }
        if self.rules.busy.swap(true, Ordering::SeqCst) {
            return;
        }
        let me = self.clone();
        tokio::spawn(async move {
            let _release = Release(me.clone());
            me.rules_tick_at(now).await;
        });
    }

    /// One look at every rule that is on.
    pub(super) async fn rules_tick_at(&self, now: DateTime<Utc>) {
        let Ok(Some(primary)) = svc::primary_bot(&self.db.conn).await else {
            return;
        };
        // Whatever is switched off: what is no longer watched lets go.
        self.reconcile_scope(primary.id).await;
        let account = AccountView::from_settings(&primary.settings);
        let prefs = account.prefs;
        if !prefs.proactive() {
            return;
        }
        let look = Look {
            now,
            prefs,
            primary: primary.id,
        };
        for rule in SCANNED {
            if !look.prefs.rule_on(rule) {
                continue;
            }
            if SLOW.contains(rule) && !self.rules.slow_due(rule, now) {
                continue;
            }
            let found = match *rule {
                "failed" => self.scan_failed(&look).await,
                "review" => self.scan_review(&look).await,
                "session" => self.scan_sessions(&look).await,
                "pr_review" => self.scan_pr_review(&look).await,
                "uncommitted" => self.scan_uncommitted(&look).await,
                "idle" => self.scan_idle(&look).await,
                "behind" => self.scan_behind(&look).await,
                _ => None,
            };
            if let Some(found) = found {
                self.settle_rule(rule, &look, found).await;
            }
        }
    }

    /// What is no longer watched lets go of what it had: a project taken off
    /// the list or closed — its pull requests' cards expire and their
    /// records start a new episode when it is back ([`out_of_scope`]); one
    /// deleted, its records are forgotten too. And the cards of a rule this
    /// build no longer has expire. Local reads only, every look — the
    /// switches of what codeg does unasked do not keep stale cards up.
    ///
    /// [`out_of_scope`]: PersonalAgentEngine::out_of_scope
    pub(super) async fn reconcile_scope(&self, primary: i32) {
        let watched = match watched_in(&self.db.conn, primary).await {
            Ok(w) => w,
            Err(e) => {
                tracing::warn!("[personal-agent] what is watched could not be read: {e}");
                return;
            }
        };
        let mut left: Vec<i32> = Vec::new();
        let mut leave = |p: i32| {
            if !watched.contains(&p) && !left.contains(&p) {
                left.push(p);
            }
        };
        for n in rsvc::open_of_kind(&self.db.conn, NoticeKind::Rule)
            .await
            .unwrap_or_default()
        {
            let payload: Value = serde_json::from_str(&n.payload).unwrap_or(Value::Null);
            let rule = payload["rule"].as_str().unwrap_or_default();
            if !ALL.contains(&rule) {
                let engine = self.engine_for(n.bot_id).await.unwrap_or_else(|| self.primary.clone());
                engine.expire_rule_card(&n).await;
                continue;
            }
            if rule == "pr_review" {
                if let Some(p) = pr_project(payload["object"].as_str().unwrap_or_default()) {
                    leave(p);
                }
            }
        }
        let records = rsvc::of_rule(&self.db.conn, "pr_review").await.unwrap_or_default();
        for rec in &records {
            let Some(p) = pr_project(&rec.object) else {
                continue;
            };
            if data_of_row(rec.data.as_deref())["out"].as_bool() != Some(true) {
                leave(p);
            }
        }
        if !left.is_empty() {
            if let Err(e) = self.primary.out_of_scope(&left).await {
                tracing::warn!("[personal-agent] the projects no longer watched kept their cards: {e}");
            }
        }
        // A project deleted: nothing of it to keep.
        let projects: HashSet<i32> = records.iter().filter_map(|r| pr_project(&r.object)).collect();
        for p in projects {
            let alive = folder::Entity::find_by_id(p)
                .one(&self.db.conn)
                .await
                .map(|f| f.is_some_and(|f| f.deleted_at.is_none()));
            if alive == Ok(false) {
                let _ = rsvc::forget_prefix(&self.db.conn, "pr_review", &format!("pr:{p}:")).await;
            }
        }
    }

    /// Expire the cards whose thing is gone, and raise the ones due.
    pub(super) async fn settle_rule(&self, rule: &'static str, look: &Look, found: Vec<Found>) {
        let objects: HashSet<&str> = found.iter().map(|f| f.object.as_str()).collect();
        for n in rsvc::open_of_kind(&self.db.conn, NoticeKind::Rule)
            .await
            .unwrap_or_default()
        {
            let p: Value = serde_json::from_str(&n.payload).unwrap_or(Value::Null);
            if p["rule"].as_str() != Some(rule) {
                continue;
            }
            if objects.contains(p["object"].as_str().unwrap_or("")) {
                continue;
            }
            if let Some(engine) = self.engine_for(n.bot_id).await {
                engine.expire_rule_card(&n).await;
            }
        }
        let after = look.prefs.rule_after(rule);
        let lowered = quiet_since(&self.db, rule).await.is_some();
        for f in found {
            if f.held {
                continue;
            }
            if after.is_some_and(|a| look.now - f.since < a) {
                continue;
            }
            let earlier = rsvc::notices_of_subject(&self.db.conn, &subject(rule, &f.object))
                .await
                .unwrap_or_default();
            if !may_raise(&earlier, &f.episode, look.now) {
                continue;
            }
            let engine = match self.engine_for(Some(f.bot)).await {
                Some(e) => e,
                None => self.primary.clone(),
            };
            if let Err(e) = engine.raise_rule_card(&f, &look.prefs, lowered).await {
                tracing::warn!("[personal-agent] rule {rule}: no card for {}: {e}", f.object);
            }
        }
    }

    /// The bot whose card a dispatched task's thing is: its dispatcher's
    /// (still on the roster), else the primary.
    async fn owner_of_dispatch(&self, dispatch_id: Option<i32>, primary: i32) -> (i32, Option<dispatch_entity::Model>) {
        let Some(id) = dispatch_id else {
            return (primary, None);
        };
        match svc::get_dispatch(&self.db.conn, id).await.ok().flatten() {
            Some(d) => {
                let alive = match d.bot_id {
                    Some(b) => svc::get_bot(&self.db.conn, b).await.ok().flatten().is_some(),
                    None => false,
                };
                (
                    if alive { d.bot_id.unwrap_or(primary) } else { primary },
                    Some(d),
                )
            }
            None => (primary, None),
        }
    }

    // ── failed with nobody on it ────────────────────────────────────────────

    async fn scan_failed(&self, look: &Look) -> Option<Vec<Found>> {
        let mut out = Vec::new();
        // Failed and not taken up stays so until someone acts — a weekend
        // away included; only what had failed well before codeg first
        // looked (an upgrade) is left alone.
        let mut record = rule_record(&self.db, "failed").await;
        let first = match time_of(&record["first_look"]) {
            Some(t) => t,
            None => {
                record["first_look"] = json!(Utc::now().to_rfc3339());
                write_record(&self.db, "failed", &record).await;
                Utc::now()
            }
        };
        let fresh = first - Duration::days(FAILED_FRESH_DAYS);
        for bot in svc::list_bots(&self.db.conn).await.ok()? {
            let engine = self.engine_for(Some(bot.id)).await;
            for d in svc::list_dispatches(
                &self.db.conn,
                bot.id,
                &[DispatchState::Failed, DispatchState::Interrupted],
                None,
                50,
            )
            .await
            .ok()?
            {
                // The board's task stands for task work; work another took
                // over (B1) is somebody's.
                if d.mode == DispatchMode::Task
                    || d.updated_at < fresh
                    || super::dispatch::superseded(&self.db, &d).await
                {
                    continue;
                }
                // One codeg retries or asks about is not nobody's.
                if d.state == DispatchState::Interrupted {
                    if let Some(e) = &engine {
                        if matches!(
                            e.retry_plan(&d).await,
                            super::retry::RetryPlan::Auto { .. } | super::retry::RetryPlan::Ask
                        ) {
                            continue;
                        }
                    }
                }
                out.push(Found {
                    rule: "failed",
                    object: format!("dispatch:{}", d.id),
                    episode: d.updated_at.timestamp_millis().to_string(),
                    bot: bot.id,
                    since: d.updated_at,
                    held: false,
                    facts: json!({
                        "dispatch_id": d.id,
                        "title": d.title,
                        "mode": d.mode,
                        "state": d.state,
                        "error": d.error.as_deref().map(glimpse),
                        "conversation_id": d.conversation_id,
                        "folder_id": d.folder_id,
                    }),
                    text: glimpse(&d.title),
                });
            }
        }
        for t in super::overview::board(&self.db, None).await {
            if t.status != WorkTaskStatus::Failed || t.deferred_at.is_some() {
                continue;
            }
            let since = t.settled_at.unwrap_or(t.updated_at);
            if since < fresh {
                continue;
            }
            let (bot, d) = self
                .owner_of_dispatch(t.personal_agent_dispatch_id, look.primary)
                .await;
            // Its run taken over by other work (B1).
            if let Some(d) = d.as_ref() {
                if super::dispatch::superseded(&self.db, d).await {
                    continue;
                }
            }
            out.push(Found {
                rule: "failed",
                object: format!("task:{}", t.id),
                episode: t.run_seq.to_string(),
                bot,
                since,
                held: false,
                facts: json!({
                    "task_id": t.id,
                    "title": t.title,
                    "dispatch_id": d.as_ref().map(|d| d.id),
                    "error": t.last_error.as_deref().map(glimpse),
                    "conversation_id": t.conversation_id,
                    "folder_id": t.folder_id,
                }),
                text: glimpse(&t.title),
            });
        }
        Some(out)
    }

    // ── waiting long for review ─────────────────────────────────────────────

    async fn scan_review(&self, look: &Look) -> Option<Vec<Found>> {
        let mut out = Vec::new();
        for t in super::overview::board(&self.db, None).await {
            if t.status != WorkTaskStatus::Review || t.deferred_at.is_some() {
                continue;
            }
            let (bot, d) = self
                .owner_of_dispatch(t.personal_agent_dispatch_id, look.primary)
                .await;
            // This generation has a round of acceptance: it is being seen to.
            if let Some(d) = &d {
                if vsvc::rounds_of(&self.db.conn, d.id)
                    .await
                    .unwrap_or_default()
                    .iter()
                    .any(|r| r.run_seq == t.run_seq && r.state != VerificationState::Stale)
                {
                    continue;
                }
            }
            out.push(Found {
                rule: "review",
                object: format!("task:{}", t.id),
                episode: t.run_seq.to_string(),
                bot,
                since: t.settled_at.unwrap_or(t.updated_at),
                held: false,
                facts: json!({
                    "task_id": t.id,
                    "title": t.title,
                    "dispatch_id": d.as_ref().map(|d| d.id),
                    "conversation_id": t.conversation_id,
                    "folder_id": t.folder_id,
                    "files_changed": t.files_changed,
                }),
                text: glimpse(&t.title),
            });
        }
        Some(out)
    }

    // ── a session waiting on the owner ──────────────────────────────────────

    async fn scan_sessions(&self, look: &Look) -> Option<Vec<Found>> {
        let att = self.reach.attending_now();
        let mut out = Vec::new();
        for g in self.manager.session_glances().await {
            let (Some(wait), Some(cid)) = (g.wait.as_ref(), g.conversation_id) else {
                continue;
            };
            if g.personal_agent {
                continue;
            }
            // Work an assistant dispatched is that assistant's to see to.
            if self.live.task_conn_owner(&g.connection_id).is_some()
                || self.connection_engine(&g.connection_id).await
                || self.task_dispatch_of(&g.connection_id).await.is_some()
            {
                continue;
            }
            let c = crate::db::service::conversation_service::get_by_id(&self.db.conn, cid)
                .await
                .ok();
            let title = c
                .as_ref()
                .and_then(|c| c.title.clone())
                .map(|t| glimpse(&t))
                .filter(|t| !t.is_empty())
                .unwrap_or_else(|| glimpse(&wait.text));
            out.push(Found {
                rule: "session",
                object: format!("session:{cid}"),
                episode: wait.since.timestamp_millis().to_string(),
                bot: look.primary,
                since: wait.since,
                // The owner is in it: they see it.
                held: att.present && att.viewing_conversations.contains(&cid),
                facts: json!({
                    "conversation_id": cid,
                    "folder_id": g.folder_id,
                    "agent_type": g.agent_type,
                    "title": title,
                    "wait": wait.kind,
                    "text": glimpse(&wait.text),
                }),
                text: title,
            });
        }
        Some(out)
    }

    // ── a pull request waiting for the owner's review ───────────────────────

    async fn scan_pr_review(&self, look: &Look) -> Option<Vec<Found>> {
        let forge = super::starter::LiveForge { db: &self.db };
        self.scan_pr_review_with(look, &forge, PR_SCAN_BUDGET).await
    }

    /// The review requests of the projects watched, read through `forge`
    /// within `budget`, starting where the last look stopped. Per project:
    /// one read has its requests no longer there forgotten; one not read
    /// (git or the accounts could not say, the forge failed, the budget ran
    /// out) keeps its records and cards (`held`); one no account serves, or
    /// without a forge remote, is let go of as a project no longer watched.
    pub(super) async fn scan_pr_review_with(
        &self,
        look: &Look,
        forge: &dyn super::starter::ForgeReads,
        budget: StdDuration,
    ) -> Option<Vec<Found>> {
        use super::projects::Served;
        // What is watched as the look starts — not what the tick read.
        let prefs = match svc::primary_bot(&self.db.conn).await.ok().flatten() {
            Some(p) => AccountView::from_settings(&p.settings).prefs,
            None => return None,
        };
        // Not read: nothing is known to have left, so nothing is settled.
        let watched = match super::projects::eligible_in(&self.db.conn).await {
            Ok(eligible) => super::projects::watched_of(eligible, &prefs.projects),
            Err(e) => {
                tracing::warn!("[personal-agent] rule pr_review: the projects were not read: {e}");
                return None;
            }
        };
        let ids: HashSet<i32> = watched.iter().map(|f| f.id).collect();
        let n = watched.len();
        let start = if n == 0 {
            0
        } else {
            self.rules.pr_cursor.load(Ordering::SeqCst) % n
        };
        let began = tokio::time::Instant::now();
        let mut out = Vec::new();
        let mut seen_now: HashSet<String> = HashSet::new();
        let mut read: HashSet<i32> = HashSet::new();
        // Rows read without the address that names them: their records stay.
        let mut unnamed: Vec<String> = Vec::new();
        let mut unserved: Vec<i32> = Vec::new();
        // The projects this look is done with, in order: one the budget cut
        // short is not, and the next look starts with it.
        let mut reached = 0;
        for f in watched.iter().cycle().skip(start).take(n) {
            if budget.saturating_sub(began.elapsed()).is_zero() {
                break;
            }
            match forge.served(f.id).await {
                Served::Yes => {}
                Served::No => {
                    reached += 1;
                    unserved.push(f.id);
                    continue;
                }
                Served::Unknown => {
                    reached += 1;
                    continue;
                }
            }
            // What is left once this machine has said, not before.
            let left = budget.saturating_sub(began.elapsed());
            if left.is_zero() {
                break;
            }
            let cut = left < FORGE_TIMEOUT;
            let rows = match bounded(FORGE_TIMEOUT.min(left), forge.review_requested(f.id)).await {
                Some(Ok(rows)) => rows,
                // Out of the look's time, not its own: next time first.
                None if cut => break,
                _ => {
                    reached += 1;
                    continue;
                }
            };
            reached += 1;
            read.insert(f.id);
            for pr in rows.into_iter().filter(|r| r.is_pr && r.state == "open") {
                let Some(ident) = pr_ident(&pr.html_url) else {
                    unnamed.push(format!("pr:{}:{}:", f.id, pr.number));
                    continue;
                };
                let object = format!("pr:{}:{}:{ident}", f.id, pr.number);
                let rec = rsvc::seen(
                    &self.db.conn,
                    "pr_review",
                    &object,
                    Some(look.primary),
                    None,
                    look.now,
                )
                .await
                .ok()?;
                seen_now.insert(object.clone());
                out.push(Found {
                    rule: "pr_review",
                    // Claimed below, as it is raised.
                    episode: String::new(),
                    object,
                    bot: look.primary,
                    since: rec.first_seen_at,
                    held: false,
                    facts: json!({
                        "folder_id": f.id,
                        "project": project_name(f),
                        "number": pr.number,
                        "title": pr.title,
                        "url": pr.html_url,
                        "author": pr.author,
                    }),
                    text: format!("{} #{}", project_name(f), pr.number),
                });
            }
        }
        if n > 0 {
            self.rules
                .pr_cursor
                .store((start + reached) % n, Ordering::SeqCst);
        }
        // Each project's records as it went: a request no longer there in a
        // project read is forgotten; one not read keeps its record and card.
        // Those not watched (anymore: closed since the tick's reconciling),
        // or not served, are let go of below — never left to the generic
        // expiry, which would keep their episode and hold back their card
        // when they are back.
        let mut gone: Vec<i32> = unserved.clone();
        let mut leave = |p: i32| {
            if !gone.contains(&p) {
                gone.push(p);
            }
        };
        for n in rsvc::open_of_kind(&self.db.conn, NoticeKind::Rule)
            .await
            .unwrap_or_default()
        {
            let payload: Value = serde_json::from_str(&n.payload).unwrap_or(Value::Null);
            if payload["rule"].as_str() == Some("pr_review") {
                if let Some(p) = pr_project(payload["object"].as_str().unwrap_or_default()) {
                    if !ids.contains(&p) {
                        leave(p);
                    }
                }
            }
        }
        for rec in rsvc::of_rule(&self.db.conn, "pr_review").await.unwrap_or_default() {
            if seen_now.contains(&rec.object) {
                continue;
            }
            let Some(p) = pr_project(&rec.object) else {
                continue;
            };
            if !ids.contains(&p) {
                if data_of_row(rec.data.as_deref())["out"].as_bool() != Some(true) {
                    leave(p);
                }
                continue;
            }
            if unserved.contains(&p) {
                continue;
            }
            let row_unread = unnamed.iter().any(|u| rec.object.starts_with(u.as_str()));
            if read.contains(&p) && !row_unread {
                let _ = rsvc::forget(&self.db.conn, "pr_review", &rec.object).await;
            } else {
                out.push(Found {
                    rule: "pr_review",
                    object: rec.object.clone(),
                    episode: String::new(),
                    bot: look.primary,
                    since: rec.first_seen_at,
                    held: true,
                    facts: Value::Null,
                    text: String::new(),
                });
            }
        }
        // The last look at what is watched, as the cards are about to be
        // raised: what left meanwhile is taken out and let go of.
        let (out, mut left) = match claim_pr_reviews(&self.db, look.primary, out).await {
            Ok(claimed) => claimed,
            Err(e) => {
                tracing::warn!("[personal-agent] rule pr_review: the requests were not claimed: {e}");
                return None;
            }
        };
        for p in gone {
            if !left.contains(&p) {
                left.push(p);
            }
        }
        if !left.is_empty() {
            // Not let go of: nothing is settled this time — the generic
            // expiry would keep their episodes. The next look tries again.
            if let Err(e) = self.primary.out_of_scope(&left).await {
                tracing::warn!("[personal-agent] rule pr_review: the projects let go of kept their cards: {e}");
                return None;
            }
        }
        Some(out)
    }

    // ── changes left uncommitted ────────────────────────────────────────────

    async fn scan_uncommitted(&self, look: &Look) -> Option<Vec<Found>> {
        let mut folders = folder::Entity::find()
            .filter(folder::Column::DeletedAt.is_null())
            .filter(folder::Column::Kind.eq(FolderKind::Regular))
            .all(&self.db.conn)
            .await
            .ok()?;
        // The ones the owner opened last are looked at first.
        folders.sort_by_key(|f| std::cmp::Reverse(f.last_opened_at));
        let names: HashMap<i32, String> = folders.iter().map(|f| (f.id, project_name(f))).collect();
        // A worktree a task is at work in is the board's.
        let busy: HashSet<i32> = super::overview::board(&self.db, None)
            .await
            .into_iter()
            .filter(|t| {
                !matches!(
                    t.status,
                    WorkTaskStatus::Done | WorkTaskStatus::Failed | WorkTaskStatus::Canceled
                )
            })
            .filter_map(|t| t.worktree_folder_id)
            .collect();
        let mut out = Vec::new();
        let mut looked: HashSet<String> = HashSet::new();
        for f in folders
            .iter()
            .filter(|f| !busy.contains(&f.id))
            .take(FOLDERS_READ)
        {
            if !std::path::Path::new(&f.path).is_dir() {
                continue;
            }
            let object = format!("folder:{}", f.id);
            let changed = match bounded(GIT_TIMEOUT, crate::work_task::git::has_changes(&f.path)).await {
                Some(Ok(c)) => c,
                // Not a repository, or git could not say: nothing known.
                _ => continue,
            };
            looked.insert(object.clone());
            if !changed {
                let _ = rsvc::forget(&self.db.conn, "uncommitted", &object).await;
                continue;
            }
            let rec = rsvc::seen(
                &self.db.conn,
                "uncommitted",
                &object,
                Some(look.primary),
                None,
                look.now,
            )
            .await
            .ok()?;
            let project = f.parent_id.and_then(|p| names.get(&p).cloned());
            out.push(Found {
                rule: "uncommitted",
                episode: rec.first_seen_at.timestamp_millis().to_string(),
                object,
                bot: look.primary,
                since: rec.first_seen_at,
                held: false,
                facts: json!({
                    "folder_id": f.id,
                    "name": project_name(f),
                    "path": f.path,
                    "project": project,
                    "worktree": f.parent_id.is_some(),
                    "branch": f.git_branch,
                }),
                text: project_name(f),
            });
        }
        // What was not looked at this time is kept, its cards too.
        for rec in rsvc::of_rule(&self.db.conn, "uncommitted").await.unwrap_or_default() {
            if rec.object.is_empty() || looked.contains(&rec.object) {
                continue;
            }
            let id = rec.object.strip_prefix("folder:").and_then(|i| i.parse::<i32>().ok());
            match id.and_then(|i| folders.iter().find(|f| f.id == i)) {
                // Not looked at this time (past the limit, or git could not
                // say): it stands as it was.
                Some(f) if !busy.contains(&f.id) && std::path::Path::new(&f.path).is_dir() => {
                    out.push(Found {
                        rule: "uncommitted",
                        object: rec.object.clone(),
                        episode: rec.first_seen_at.timestamp_millis().to_string(),
                        bot: look.primary,
                        since: rec.first_seen_at,
                        held: true,
                        facts: Value::Null,
                        text: String::new(),
                    });
                }
                // The folder is gone, or a task works in it now.
                _ => {
                    let _ = rsvc::forget(&self.db.conn, "uncommitted", &rec.object).await;
                }
            }
        }
        Some(out)
    }

    // ── a matter gone quiet ─────────────────────────────────────────────────

    async fn scan_idle(&self, look: &Look) -> Option<Vec<Found>> {
        let after = look.prefs.rule_after("idle")?;
        let items = item_entity::Entity::find()
            .filter(item_entity::Column::Status.is_in([ItemStatus::Open, ItemStatus::Waiting]))
            .filter(item_entity::Column::DueAt.is_null())
            .filter(item_entity::Column::Kind.is_in([
                ItemKind::Reminder,
                ItemKind::Followup,
                ItemKind::Question,
            ]))
            .all(&self.db.conn)
            .await
            .ok()?;
        let bots: HashSet<i32> = svc::list_bots(&self.db.conn)
            .await
            .ok()?
            .into_iter()
            .map(|b| b.id)
            .collect();
        let mut out = Vec::new();
        for i in items {
            let Some(bot) = i.bot_id.filter(|b| bots.contains(b)) else {
                continue;
            };
            // Only the quiet ones are found: one changed since is not.
            if look.now - i.updated_at < after {
                continue;
            }
            out.push(Found {
                rule: "idle",
                object: format!("item:{}", i.id),
                episode: i.updated_at.timestamp_millis().to_string(),
                bot,
                since: i.updated_at,
                held: false,
                facts: json!({
                    "item_id": i.id,
                    "summary": glimpse(&i.summary),
                    "kind": i.kind,
                    "status": i.status,
                }),
                text: glimpse(&i.summary),
            });
        }
        Some(out)
    }

    // ── a branch behind its target, with conflicts ──────────────────────────

    async fn scan_behind(&self, look: &Look) -> Option<Vec<Found>> {
        let mut out = Vec::new();
        for t in super::overview::board(&self.db, None).await {
            if t.status != WorkTaskStatus::Review || t.deferred_at.is_some() {
                continue;
            }
            let Some(dispatch_id) = t.personal_agent_dispatch_id else {
                continue;
            };
            let (Some(base), Some(branch)) = (t.base_branch.clone(), t.work_branch.clone()) else {
                continue;
            };
            let Some(f) = folder::Entity::find_by_id(t.folder_id)
                .one(&self.db.conn)
                .await
                .ok()
                .flatten()
            else {
                continue;
            };
            let behind = bounded(GIT_TIMEOUT, async {
                let tip = crate::work_task::git::rev_parse(&f.path, &base).await.ok()?;
                if crate::work_task::git::is_ancestor(&f.path, &tip, &branch)
                    .await
                    .ok()?
                {
                    return Some((tip, false));
                }
                let conflicts = crate::work_task::git::merge_conflicts(&f.path, &base, &branch)
                    .await
                    .ok()
                    .flatten()?;
                Some((tip, conflicts))
            })
            .await
            .flatten();
            let (bot, d) = self.owner_of_dispatch(Some(dispatch_id), look.primary).await;
            match behind {
                Some((tip, true)) => out.push(Found {
                    rule: "behind",
                    object: format!("task:{}", t.id),
                    episode: format!("{}:{tip}", t.run_seq),
                    bot,
                    since: look.now,
                    held: false,
                    facts: json!({
                        "task_id": t.id,
                        "title": t.title,
                        "dispatch_id": d.as_ref().map(|d| d.id),
                        "base": base,
                        "branch": branch,
                        "folder_id": t.folder_id,
                    }),
                    text: glimpse(&t.title),
                }),
                Some((_, false)) => {}
                // git could not say: what was found stands.
                None => out.push(Found {
                    rule: "behind",
                    object: format!("task:{}", t.id),
                    episode: String::new(),
                    bot,
                    since: look.now,
                    held: true,
                    facts: Value::Null,
                    text: String::new(),
                }),
            }
        }
        Some(out)
    }

}

// ── the cards ───────────────────────────────────────────────────────────────

/// Read a card row's data.
fn data_of_row(raw: Option<&str>) -> Value {
    raw.and_then(|d| serde_json::from_str::<Value>(d).ok())
        .unwrap_or_else(|| json!({}))
}

impl PersonalAgentEngine {
    /// Put what a rule found in front of the owner: the card, its news,
    /// and a line for the assistant.
    pub(super) async fn raise_rule_card(
        &self,
        f: &Found,
        prefs: &Prefs,
        lowered: bool,
    ) -> Result<i32, String> {
        let bot = self.bot().await;
        let kind = news_kind(f.rule, lowered);
        let level = prefs.level_of(kind);
        let mut row = NewRow::new(TimelineKind::Notice, format!("{}: {}", f.rule, f.text));
        row.segment_id = self.state.lock().await.connection_segment;
        row.data = Some(json!({
            "notice": "rule",
            "rule": f.rule,
            "state": "open",
            "object": f.object,
            "since": f.since,
            "lowered": lowered,
            "facts": f.facts,
        }));
        let (notice, card) = svc::create_notice_with_row(
            &self.db.conn,
            bot,
            NewNotice {
                kind: NoticeKind::Rule,
                subject_key: Some(subject(f.rule, &f.object)),
                level: notice_level(level),
                batch_id: None,
                payload: json!({
                    "rule": f.rule,
                    "object": f.object,
                    "episode": f.episode,
                    "facts": f.facts,
                }),
            },
            row,
        )
        .await
        .map_err(|e| e.to_string())?;
        let row = svc::to_row(card);
        self.emit_rows(vec![row.clone()]);
        self.emit(PersonalAgentChange::Status);
        if let Some(host) = self.host_ref() {
            let (what, link) = match f.rule {
                "session" => (
                    What::Session {
                        text: f.text.clone(),
                        minutes: (clock::now() - f.since).num_minutes().max(0),
                    },
                    f.facts["conversation_id"]
                        .as_i64()
                        .and_then(|c| i32::try_from(c).ok())
                        .map(|conversation_id| NotifyLink::Conversation {
                            conversation_id,
                            folder_id: f.facts["folder_id"]
                                .as_i64()
                                .and_then(|i| i32::try_from(i).ok()),
                        }),
                ),
                rule => (
                    What::Rule {
                        rule: rule.to_string(),
                        text: f.text.clone(),
                    },
                    Some(NotifyLink::Bot {
                        bot_id: bot,
                        row_id: Some(row.id),
                    }),
                ),
            };
            host.tell(News {
                key: format!("rule:{}", notice.id),
                bot_id: bot,
                kind,
                what,
                link,
                need: None,
            })
            .await;
        }
        // The assistant hears of it with its next delivery (no turn of its
        // own): the owner may bring it up. A session of the owner's own
        // waiting is theirs alone.
        if f.rule == "session" {
            return Ok(notice.id);
        }
        let _ = svc::insert_event(
            &self.db.conn,
            bot,
            "proposal",
            &format!("rule:{}", notice.id),
            None,
            format!(
                "codeg's rule `{}` put card #{} in front of the owner: {}. Nothing for you to do \
                 unless they ask; codeg does what they pick on it.",
                f.rule, notice.id, f.text
            ),
            Some(json!({ "notice_id": notice.id, "rule": f.rule })),
            false,
        )
        .await;
        Ok(notice.id)
    }

    /// Projects no longer watched — taken off the list, closed, with no
    /// account or forge remote to read them through: their pull requests'
    /// cards expire, and their records are marked left (`out`) with one
    /// more `resets` (once per leaving), so that a request still waiting
    /// when the project is back has a new episode — its card is not held
    /// back by the one that expired — and keeps when it was first seen.
    /// One transaction.
    pub(super) async fn out_of_scope(&self, projects: &[i32]) -> Result<(), String> {
        if projects.is_empty() {
            return Ok(());
        }
        let primary = svc::primary_bot(&self.db.conn)
            .await
            .map_err(|e| e.to_string())?
            .ok_or("there is no primary assistant")?;
        let expired = rsvc::pr_review_out(&self.db.conn, primary.id, projects)
            .await
            .map_err(|e| e.to_string())?;
        for n in expired {
            let (Some(row_id), Some(bot)) = (n.timeline_id, n.bot_id) else {
                continue;
            };
            if let Ok(Some(row)) = svc::get_row(&self.db.conn, row_id).await {
                self.emit_for(
                    bot,
                    PersonalAgentChange::Timeline {
                        rows: vec![svc::to_row(row)],
                    },
                );
                self.emit_for(bot, PersonalAgentChange::Status);
            }
        }
        Ok(())
    }

    /// A card whose thing is gone: it says so, and waits on nobody.
    pub(super) async fn expire_rule_card(&self, notice: &notice_entity::Model) {
        if svc::move_notice(
            &self.db.conn,
            notice.id,
            &[NoticeState::Open],
            NoticeState::Expired,
        )
        .await
        .unwrap_or(false)
        {
            let _ = self.rule_card_row(notice, "expired", json!({})).await;
        }
    }

    /// Write a rule card's state (and what more it says) on its row.
    async fn rule_card_row(
        &self,
        notice: &notice_entity::Model,
        state: &str,
        more: Value,
    ) -> Result<TimelineRow, String> {
        let id = notice.timeline_id.ok_or("the card's row is missing")?;
        let row = svc::get_row(&self.db.conn, id)
            .await
            .map_err(|e| e.to_string())?
            .ok_or("the card's row is missing")?;
        let mut data = data_of_row(row.data.as_deref());
        if let Some(map) = data.as_object_mut() {
            map.insert("state".into(), state.into());
            if let Value::Object(more) = more {
                for (k, v) in more {
                    map.insert(k, v);
                }
            }
        }
        svc::update_row_data(&self.db.conn, id, None, Some(data))
            .await
            .map_err(|e| e.to_string())?;
        let updated = svc::get_row(&self.db.conn, id)
            .await
            .map_err(|e| e.to_string())?
            .ok_or("the card's row is missing")?;
        let row = svc::to_row(updated);
        self.emit_rows(vec![row.clone()]);
        self.emit(PersonalAgentChange::Status);
        Ok(row)
    }

    /// A note for the assistant on what the owner had done from a card.
    async fn note_rule_act(&self, notice: &notice_entity::Model, text: String) {
        let _ = svc::insert_event(
            &self.db.conn,
            self.bot().await,
            "proposal",
            &format!("rule:{}:acted", notice.id),
            None,
            text,
            Some(json!({ "notice_id": notice.id })),
            false,
        )
        .await;
    }

    /// The owner's answer on a rule card: its next step, `dismiss`, or
    /// (handled before this) `mute`. `text`: the owner's words a hand-over
    /// carries, as the page wrote them in their language.
    pub(super) async fn act_on_rule(
        self: &Arc<Self>,
        notice: &notice_entity::Model,
        action: &str,
        text: Option<String>,
    ) -> Result<TimelineRow, String> {
        let payload: Value = serde_json::from_str(&notice.payload).unwrap_or(Value::Null);
        let rule = payload["rule"].as_str().unwrap_or("").to_string();
        let facts = payload["facts"].clone();
        if action == "dismiss" {
            if !svc::move_notice(
                &self.db.conn,
                notice.id,
                &[NoticeState::Open],
                NoticeState::Dismissed,
            )
            .await
            .map_err(|e| e.to_string())?
            {
                return Err("this card was answered already".into());
            }
            let lowered = after_answer(&self.db, &rule, false).await;
            return self
                .rule_card_row(notice, "dismissed", json!({ "lowered_now": lowered }))
                .await;
        }
        let allowed: &[&str] = match rule.as_str() {
            "failed" => &["retry", "hand"],
            "review" => &["check", "remind"],
            "session" => &["open"],
            "pr_review" => &["summary"],
            "uncommitted" => &["open", "hand"],
            "idle" => &["hand", "close"],
            "behind" => &["rebase"],
            "undo" => &["ask_first"],
            "idle_bot" => &["hide", "delete"],
            _ => &[],
        };
        if !allowed.contains(&action) {
            return Err(format!("`{action}` does not apply to this card"));
        }
        // An assistant that is gone already: the question is moot.
        if rule == "idle_bot" && action == "hide" {
            let id = facts["bot_id"].as_i64().and_then(|v| i32::try_from(v).ok());
            let alive = match id {
                Some(id) => svc::get_bot(&self.db.conn, id)
                    .await
                    .ok()
                    .flatten()
                    .is_some(),
                None => false,
            };
            if !alive {
                self.expire_rule_card(notice).await;
                return Err("that assistant is gone".into());
            }
        }
        // Taken first: a second answer is told it was answered.
        if !svc::move_notice(
            &self.db.conn,
            notice.id,
            &[NoticeState::Open],
            NoticeState::Acting,
        )
        .await
        .map_err(|e| e.to_string())?
        {
            return Err("this card was answered already".into());
        }
        let id_of = |k: &str| facts[k].as_i64().and_then(|v| i32::try_from(v).ok());
        let words = text
            .map(|t| t.trim().chars().take(2_000).collect::<String>())
            .filter(|t| !t.is_empty());
        let ran: Result<(String, Value), String> = match (rule.as_str(), action) {
            ("failed", "retry") => self.retry_failed(&facts, notice.id).await,
            ("review", "check") => match self.check_review(&facts).await {
                Ok(Some(r)) => Ok(r),
                // Not one codeg can check: the assistant sees to it.
                Ok(None) => {
                    self.hand_from_card(notice, words.clone(), &rule, &facts)
                        .await
                }
                Err(e) => Err(e),
            },
            ("review", "remind") => self.remind_review(&facts, words.clone()).await,
            ("session", "open") | ("uncommitted", "open") => Ok(("opened".into(), json!({}))),
            ("idle", "close") => {
                let item = id_of("item_id").ok_or("the card names no matter")?;
                self.settle_item_from(item, "drop", None, super::reminders::OpSource::RuleCard)
                    .await
                    .map(|_| ("closed".into(), json!({ "item_id": item })))
                    .map_err(String::from)
            }
            ("behind", "rebase") => self.rebase_behind(&facts).await,
            ("undo", "ask_first") => self
                .apply_settings(&[super::prefs::SettingChange {
                    key: "prefs.chat_changes".into(),
                    value: json!("show"),
                }])
                .await
                .map(|_| ("asking_first".into(), json!({}))),
            ("idle_bot", "hide") => {
                let id = id_of("bot_id").ok_or("the card names no assistant")?;
                match self.host_ref() {
                    Some(h) => h
                        .roster_act(id, crate::models::personal_agent_roster::RosterAct::Hide)
                        .await
                        .map(|_| ("hidden".into(), json!({ "bot_id": id }))),
                    None => Err("the assistants run in another codeg".into()),
                }
            }
            // The page deleted it, with the owner's choices on what goes
            // with it: the card only says so.
            ("idle_bot", "delete") => {
                let id = id_of("bot_id").ok_or("the card names no assistant")?;
                if svc::get_bot(&self.db.conn, id)
                    .await
                    .ok()
                    .flatten()
                    .is_some()
                {
                    Err("the assistant is still there".into())
                } else {
                    Ok(("deleted".into(), json!({ "bot_id": id })))
                }
            }
            // `hand`, `summary`: the assistant's to judge, as the owner's
            // message.
            _ => {
                self.hand_from_card(notice, words.clone(), &rule, &facts)
                    .await
            }
        };
        match ran {
            Ok((state, more)) => {
                let _ = svc::move_notice(
                    &self.db.conn,
                    notice.id,
                    &[NoticeState::Acting],
                    NoticeState::Acted,
                )
                .await;
                after_answer(&self.db, &rule, true).await;
                if !matches!(state.as_str(), "handed" | "opened") {
                    self.note_rule_act(
                        notice,
                        format!(
                            "From codeg's card #{} (rule `{rule}`) the owner had codeg do it: \
                             {state}.",
                            notice.id
                        ),
                    )
                    .await;
                }
                let mut more = more;
                more["error"] = Value::Null;
                // A hand-over wrote the card with the message already.
                if state == "handed" {
                    if let Some(id) = notice.timeline_id {
                        if let Ok(Some(row)) = svc::get_row(&self.db.conn, id).await {
                            return Ok(svc::to_row(row));
                        }
                    }
                }
                self.rule_card_row(notice, &state, more).await
            }
            Err(e) => {
                let e = self.for_the_owner(e);
                let _ = svc::move_notice(
                    &self.db.conn,
                    notice.id,
                    &[NoticeState::Acting],
                    NoticeState::Open,
                )
                .await;
                let _ = self
                    .rule_card_row(notice, "open", json!({ "error": e.clone() }))
                    .await;
                Err(e)
            }
        }
    }

    /// The thing, handed to the assistant as the owner's message (the
    /// card's words for it, or the page's in their language).
    async fn hand_from_card(
        &self,
        notice: &notice_entity::Model,
        words: Option<String>,
        rule: &str,
        facts: &Value,
    ) -> Result<(String, Value), String> {
        let row_id = notice.timeline_id.ok_or("the card's row is missing")?;
        let text = words.unwrap_or_else(|| hand_text(rule, facts));
        let row = svc::get_row(&self.db.conn, row_id)
            .await
            .map_err(|e| e.to_string())?
            .ok_or("the card's row is missing")?;
        let mut handed = data_of_row(row.data.as_deref());
        handed["state"] = "handed".into();
        handed["error"] = Value::Null;
        self.queue_owner_message(text, Vec::new(), Some(row_id), super::engine::Origin::Written, None, Some(handed))
            .await?;
        Ok(("handed".into(), json!({})))
    }

    /// [Retry]: the failed dispatch, or the board's failed task, again.
    async fn retry_failed(
        self: &Arc<Self>,
        facts: &Value,
        notice_id: i32,
    ) -> Result<(String, Value), String> {
        let id_of = |k: &str| facts[k].as_i64().and_then(|v| i32::try_from(v).ok());
        if let Some(id) = id_of("dispatch_id") {
            let mine = svc::get_dispatch_of(&self.db.conn, self.bot().await, id)
                .await
                .map_err(|e| e.to_string())?;
            if let Some(d) = mine {
                // Work that never got a session (it failed starting — an
                // agent not installed, say) has nothing to go on with: it
                // starts again as it was asked.
                if d.mode != DispatchMode::Task && !self.resumable(&d).await {
                    let made = self.dispatch_again(&d, notice_id).await?;
                    return Ok((
                        "retried".into(),
                        json!({ "dispatch_id": made, "retry_of": d.id }),
                    ));
                }
                // Its own: retried as a follow-up of it, under codeg's op.
                self.followup_call(
                    id,
                    RETRY_FAILED_MESSAGE.to_string(),
                    None,
                    FollowupAuth::Op {
                        op_id: format!("pa-rule-retry-{id}-{}", Utc::now().timestamp_millis()),
                    },
                )
                .await?;
                return Ok(("retried".into(), json!({ "dispatch_id": id })));
            }
        }
        let task = id_of("task_id").ok_or("the card names nothing to retry")?;
        crate::commands::work_task::work_task_retry_core(task, None, Vec::new(), false)
            .await
            .map_err(|e| e.to_string())?;
        Ok(("retried".into(), json!({ "task_id": task })))
    }

    /// Whether a conversation's dispatch has a session to go on in: a live
    /// connection, or one its conversation can resume.
    async fn resumable(&self, d: &dispatch_entity::Model) -> bool {
        let Some(conversation) = d.conversation_id else {
            return false;
        };
        // A connection only counts while it is there: one that went away
        // when the start failed may still be on record.
        if let Some(c) = d.connection_id.as_deref() {
            if self.manager.get_state(c).await.is_some() {
                return true;
            }
        }
        if self
            .manager
            .find_connection_by_conversation_id(conversation)
            .await
            .is_some()
        {
            return true;
        }
        crate::db::service::conversation_service::get_by_id(&self.db.conn, conversation)
            .await
            .ok()
            .and_then(|c| c.external_id)
            .is_some()
    }

    /// The same work handed out again, as it was first asked for: a new
    /// dispatch on the same line, taking the failed one over (B1). Its id.
    /// As card `notice_id`'s own run, settled with the dispatch it makes:
    /// the card run again (a second click) finds the dispatch it made, and a
    /// restart midway finds the card settled by its entry, not reopened.
    async fn dispatch_again(
        self: &Arc<Self>,
        d: &dispatch_entity::Model,
        notice_id: i32,
    ) -> Result<i32, String> {
        // On what its assistant's work runs on now, not what the first ran on.
        let request = super::dispatch::DispatchRequest {
            mode: d.mode,
            title: d.title.clone(),
            prompt: d.prompt.clone(),
            project_id: d.folder_id,
            report: d.deliverable.as_deref() == Some("report"),
            on_done: d.on_done.clone(),
            done_when: d.done_when.clone(),
            replaces: Some(d.id),
        };
        let mut v = self.validate_dispatch(&request).await?;
        v.lineage = svc::Lineage {
            origin_bot_id: d.origin_bot_id,
            origin_row_id: d.origin_row_id,
            thread_id: d.thread_id,
            for_input: d.for_input.clone(),
        };
        let made = self
            .record_dispatch(v, super::dispatch::DispatchAuth::Card { notice_id })
            .await?;
        Ok(made.dispatch.id)
    }

    /// [Have it accepted first]: a round of acceptance for work this
    /// assistant dispatched (7.5). `None`: not work codeg checks (the
    /// owner's own task, a report, no changes) — the assistant is asked.
    async fn check_review(
        self: &Arc<Self>,
        facts: &Value,
    ) -> Result<Option<(String, Value)>, String> {
        let id_of = |k: &str| facts[k].as_i64().and_then(|v| i32::try_from(v).ok());
        let (Some(d), Some(t)) = (id_of("dispatch_id"), id_of("task_id")) else {
            return Ok(None);
        };
        let Some(d) = svc::get_dispatch_of(&self.db.conn, self.bot().await, d)
            .await
            .map_err(|e| e.to_string())?
        else {
            return Ok(None);
        };
        let task = crate::db::service::work_task_service::get_model(&self.db.conn, t)
            .await
            .map_err(|e| e.to_string())?;
        if task.status != WorkTaskStatus::Review {
            return Err("the task is not waiting for review any more".into());
        }
        let checkable = d.mode == DispatchMode::Task
            && d.deliverable.as_deref() != Some("report")
            && d.state != DispatchState::HandedOver
            && task.personal_agent_dispatch_id == Some(d.id)
            && task.source_kind.is_none()
            && task.files_changed != Some(0);
        if !checkable {
            return Ok(None);
        }
        if self.accept_on_request(&d, &task).await {
            Ok(Some(("checking".into(), json!({ "dispatch_id": d.id }))))
        } else {
            Err("its check could not start yet (the worktree or the task's preflight is not \
                 ready); try again in a minute"
                .into())
        }
    }

    /// [Remind me]: a reminder for tomorrow morning, the owner's.
    async fn remind_review(
        &self,
        facts: &Value,
        words: Option<String>,
    ) -> Result<(String, Value), String> {
        let (tz, mornings) = self.owner_day().await;
        let due = super::due::parse_when("tomorrow", tz, clock::now(), mornings)?;
        let title = facts["title"].as_str().unwrap_or("the task");
        let summary = words.unwrap_or_else(|| format!("Review the board task \"{title}\""));
        let item = svc::create_item_timed(
            &self.db.conn,
            self.bot().await,
            ItemKind::Reminder,
            None,
            ItemStatus::Open,
            None,
            summary,
            None,
            None,
            svc::ItemTime {
                due_at: Some(due),
                fresh: true,
                ..Default::default()
            },
        )
        .await
        .map_err(|e| e.to_string())?;
        self.emit(PersonalAgentChange::Status);
        Ok((
            "reminding".into(),
            json!({ "item_id": item.id, "due_at": due }),
        ))
    }

    /// [Have it rebased]: the task sent back to be rebased onto its target.
    async fn rebase_behind(self: &Arc<Self>, facts: &Value) -> Result<(String, Value), String> {
        let d = facts["dispatch_id"]
            .as_i64()
            .and_then(|v| i32::try_from(v).ok())
            .ok_or("the card names no dispatch")?;
        let base = facts["base"].as_str().unwrap_or("the target branch");
        self.followup_call(
            d,
            rebase_message(base),
            Some("revise".into()),
            FollowupAuth::Op {
                op_id: format!("pa-rule-rebase-{d}-{}", Utc::now().timestamp_millis()),
            },
        )
        .await?;
        Ok(("rebasing".into(), json!({ "dispatch_id": d })))
    }

    /// "Don't suggest these" on a card: the card is dismissed as its kind
    /// dismisses, and its whole rule turned off — the preferences turn it
    /// on again.
    pub(super) async fn mute_from_card(
        self: &Arc<Self>,
        notice: &notice_entity::Model,
    ) -> Result<TimelineRow, String> {
        let row_data = match notice.timeline_id {
            Some(id) => svc::get_row(&self.db.conn, id)
                .await
                .ok()
                .flatten()
                .map(|r| data_of_row(r.data.as_deref()))
                .unwrap_or_else(|| json!({})),
            None => json!({}),
        };
        let rule = rule_of_card(notice, &row_data)
            .ok_or("this card has no kind to stop suggesting")?;
        if notice.state != NoticeState::Open {
            return Err("this card was answered already".into());
        }
        // Dismissed as its own kind dismisses it (what the assistant hears
        // included).
        Box::pin(self.act_on_notice(notice.id, "dismiss")).await?;
        let _ = svc::move_notice(
            &self.db.conn,
            notice.id,
            &[NoticeState::Dismissed],
            NoticeState::Muted,
        )
        .await;
        self.apply_settings(&[super::prefs::SettingChange {
            key: format!("prefs.rule_{rule}"),
            value: json!("off"),
        }])
        .await?;
        let mut record = rule_record(&self.db, rule).await;
        record["muted_at"] = json!(Utc::now().to_rfc3339());
        write_record(&self.db, rule, &record).await;
        let id = notice.timeline_id.ok_or("the card's row is missing")?;
        let row = svc::get_row(&self.db.conn, id)
            .await
            .map_err(|e| e.to_string())?
            .ok_or("the card's row is missing")?;
        let mut data = data_of_row(row.data.as_deref());
        data["muted"] = json!(rule);
        svc::update_row_data(&self.db.conn, id, None, Some(data))
            .await
            .map_err(|e| e.to_string())?;
        let updated = svc::get_row(&self.db.conn, id)
            .await
            .map_err(|e| e.to_string())?
            .ok_or("the card's row is missing")?;
        let row = svc::to_row(updated);
        self.emit_rows(vec![row.clone()]);
        self.emit(PersonalAgentChange::Status);
        Ok(row)
    }

    /// The owner does not take the assistants' suggestions now (they turned
    /// them off, or muted them from a card): what a `suggest` call answers.
    pub(super) async fn suggestions_closed(&self) -> Option<ToolOutcome> {
        // What a wrap-up offers for tonight is the owner's "tonight I can
        // do", not the assistants' suggestions (6.5).
        if self.prefs().await.rule_on("suggest") || self.tonight_offer().await.is_some() {
            return None;
        }
        Some(ToolOutcome::refused(
            "The owner does not take suggestions now: they turned the assistants' suggestions \
             off (or said \"don't suggest these\" on one). Nothing was put to them. Do not \
             suggest it again; if it matters, say it in your reply, or do it when they ask.",
        ))
    }

    /// A suggestion like this one the owner declined lately: what the
    /// call answers instead of a new card.
    pub(super) async fn declined_lately(&self, subject: &str) -> Option<ToolOutcome> {
        let now = clock::now();
        let earlier = rsvc::notices_of_subject(&self.db.conn, subject)
            .await
            .unwrap_or_default();
        let open = earlier
            .iter()
            .find(|n| matches!(n.state, NoticeState::Open | NoticeState::Acting));
        if let Some(n) = open {
            return Some(ToolOutcome::ok(
                format!(
                    "Already with the owner: the same suggestion is on card #{}; nothing new was \
                     raised.",
                    n.id
                ),
                json!({ "notice_id": n.id, "state": "awaiting_owner", "earlier": true }),
            ));
        }
        if earlier.iter().any(|n| {
            matches!(n.state, NoticeState::Dismissed | NoticeState::Muted)
                && now - n.acted_at.unwrap_or(n.updated_at) < Duration::days(COOLDOWN_DAYS)
        }) {
            return Some(ToolOutcome::refused(format!(
                "The owner declined this same suggestion within the last {COOLDOWN_DAYS} days; \
                 it was not put to them again."
            )));
        }
        None
    }
}

/// What a hand-over says when the page sent no words of its own.
fn hand_text(rule: &str, facts: &Value) -> String {
    let s = |k: &str| facts[k].as_str().unwrap_or("").to_string();
    let n = |k: &str| facts[k].as_i64().map(|v| v.to_string()).unwrap_or_default();
    match rule {
        "failed" => match facts["dispatch_id"].as_i64() {
            Some(d) => format!(
                "Dispatch #{d} \"{}\" failed and nobody has picked it up. Look into what went \
                 wrong and tell me what you suggest.",
                s("title")
            ),
            None => format!(
                "The board task #{} \"{}\" failed and nobody has picked it up. Look into what \
                 went wrong and tell me what you suggest.",
                n("task_id"),
                s("title")
            ),
        },
        "review" => format!(
            "The board task #{} \"{}\" has waited long for review. Check it for me first — have \
             someone look at the changes — and tell me what you conclude.",
            n("task_id"),
            s("title")
        ),
        "pr_review" => format!(
            "Pull request #{} in {} has waited for my review for a while ({}). Give me a review \
             summary first.",
            n("number"),
            s("project"),
            s("url")
        ),
        "uncommitted" => format!(
            "{} ({}) has had uncommitted changes for a while. Look at them and get them \
             committed sensibly.",
            s("name"),
            s("path")
        ),
        "idle" => format!(
            "The matter #{} \"{}\" has not moved in a while. Pick it up again.",
            n("item_id"),
            s("summary")
        ),
        _ => format!("Have a look at this for me: {facts}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn card(state: NoticeState, episode: &str, days_ago: i64) -> notice_entity::Model {
        let at = Utc::now() - Duration::days(days_ago);
        notice_entity::Model {
            id: 1,
            kind: NoticeKind::Rule,
            subject_key: Some("rule:failed:dispatch:1".into()),
            level: NoticeLevel::Normal,
            state,
            timeline_id: None,
            batch_id: None,
            payload: json!({ "rule": "failed", "episode": episode }).to_string(),
            notified_at: None,
            acted_at: Some(at),
            expires_at: None,
            created_at: at,
            updated_at: at,
            bot_id: Some(1),
        }
    }

    #[test]
    fn one_card_per_topic_once_per_occurrence_and_quiet_a_week_after_not_now() {
        let now = Utc::now();
        assert!(may_raise(&[], "a", now));
        // One open: not another.
        assert!(!may_raise(&[card(NoticeState::Open, "a", 0)], "b", now));
        // This very occurrence had its card.
        assert!(!may_raise(&[card(NoticeState::Acted, "a", 30)], "a", now));
        assert!(!may_raise(&[card(NoticeState::Expired, "a", 30)], "a", now));
        // A new one after acting: yes.
        assert!(may_raise(&[card(NoticeState::Acted, "a", 1)], "b", now));
        // Dismissed: the topic is quiet a week, then may come again.
        assert!(!may_raise(&[card(NoticeState::Dismissed, "a", 2)], "b", now));
        assert!(!may_raise(&[card(NoticeState::Muted, "a", 6)], "b", now));
        assert!(may_raise(&[card(NoticeState::Dismissed, "a", 8)], "b", now));
    }

    #[test]
    fn three_not_nows_in_a_row_lower_a_rule() {
        use NoticeState::*;
        assert!(!goes_quiet(&[Dismissed, Dismissed]));
        assert!(goes_quiet(&[Dismissed, Dismissed, Dismissed]));
        assert!(goes_quiet(&[Dismissed, Muted, Dismissed, Acted]));
        assert!(!goes_quiet(&[Dismissed, Acted, Dismissed, Dismissed]));
    }

    #[test]
    fn a_lowered_rule_is_told_one_level_down() {
        assert_eq!(news_kind("session", false), "waiting");
        assert_eq!(news_kind("session", true), "proposal");
        assert_eq!(news_kind("failed", false), "proposal");
        assert_eq!(news_kind("failed", true), "proposal_low");
        assert_eq!(news_kind("uncommitted", false), "proposal_low");
        assert_eq!(subject_prefix("review"), "rule:review:");
        assert_eq!(subject("review", "task:3"), "rule:review:task:3");
    }

    #[test]
    fn a_review_request_is_named_by_its_page_address_as_its_forge_spells_it() {
        let id = |u: &str| pr_ident(u).unwrap();
        let a = id("https://git.example:8443/team/app/-/merge_requests/7");
        assert_eq!(a.len(), 12);
        assert_eq!(id("https://Git.EXAMPLE:8443/team/app/-/merge_requests/7/"), a);
        assert_eq!(id(" https://git.example:8443/team/app/-/merge_requests/7?tab=diffs#note_1 "), a);
        assert_ne!(id("https://git.example/team/app/-/merge_requests/7"), a, "another port, another instance");
        assert_ne!(id("https://git.example:8443/team/App/-/merge_requests/7"), a, "the path is the forge's");
        assert_ne!(id("https://git.example:8443/team/app/-/merge_requests/8"), a);
        assert_eq!(pr_ident(""), None);
        assert_eq!(pr_ident("  /?x"), None);
        assert_eq!(pr_project("pr:12:7:abc"), Some(12));
        assert_eq!(pr_project("pr:12:7"), Some(12));
        assert_eq!(pr_project("project:12"), None);
    }

    #[test]
    fn a_hand_over_names_the_thing() {
        let t = hand_text(
            "failed",
            &json!({ "dispatch_id": 45, "title": "Fix the login page" }),
        );
        assert!(t.contains("#45") && t.contains("Fix the login page"));
        let t = hand_text("pr_review", &json!({ "number": 7, "project": "codeg", "url": "u" }));
        assert!(t.contains("#7") && t.contains("codeg"));
    }
}
