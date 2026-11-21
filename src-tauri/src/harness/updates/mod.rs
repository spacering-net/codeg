//! The update check: whether what was installed from Harness has news — a
//! newer version, a version withdrawn, the item stopped by its author or
//! taken down by Harness (plan §7.7).
//!
//! It reads the two records of what was installed (H4's
//! `~/.codeg/harness/mcp.json`, H3's `~/.codeg/skills/.manifest.harness.json`),
//! asks `POST /resolve` about each installed `(item, revision)` — in batches
//! of at most [`MAX_RESOLVE_ITEMS`](super::MAX_RESOLVE_ITEMS), through the
//! one client and its rules —
//! and keeps the answers in `<data dir>/cache/harness/updates.json`
//! (`store.rs`). What the answers come to per item is `model::derive`.
//!
//! **It only tells.** Nothing here installs, updates, disables or removes
//! anything, or writes an agent's config or a skill: the records are read,
//! never written, and the one file written is the cache.
//!
//! # When it asks
//!
//! - **The scheduler** (one per process, started by the desktop app and by
//!   `codeg-server`; not at all under `CODEG_HARNESS=off`): first a minute
//!   after start, then whenever a check is due — a day after the last one
//!   that got an answer, at once for a revision installed since (nothing
//!   known of it yet), and after a failure at 5 min, 30 min, 2 h, then
//!   every 6 h (or later, if a 429 asked for longer). It looks at least
//!   hourly, and at once when an install, update or uninstall changed the
//!   records ([`records_changed`]).
//! - **A section opening** (`harness_check_updates` without `explicit`): runs
//!   only if no check was tried in the last hour.
//! - **The user asking** (`explicit: true`): runs now, whatever the time
//!   since the last; a check already running is waited for and counts as
//!   this one. SpaceRing's pause after a 429 still holds (the client's).
//!
//! A check that fails keeps the last answers it got, and says so (`error`,
//! with `checked_at` still the time of those answers). Only one check runs
//! at a time in a process; what two processes on one data directory found
//! is merged under a file lock, so an earlier check never overwrites a
//! later one and a failure never takes back another's answers
//! (`store::record`).
//!
//! # What it announces
//!
//! [`UPDATES_CHANGED_EVENT`] with `{ count, item_ids }` — the number of
//! items with an update and which items changed — after a check that
//! changed what the check says, and after the records changed it.

mod model;
mod store;

#[cfg(test)]
mod tests;

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use chrono::{DateTime, SubsecRound, Utc};
use tokio::sync::mpsc;

use crate::web::event_bridge::{emit_event, EventEmitter};

use super::Harness;

use model::{Answer, InstalledRevisions, Summary};
pub use model::{
    CheckError, HarnessUpdates, LatestRevision, UnknownReason, UpdateItem, UpdateState,
    UpdatesChanged, UPDATES_CHANGED_EVENT,
};
use store::{Kept, Outcome};

/// The scheduler's first look after the process starts.
const FIRST_WAIT: Duration = Duration::from_secs(60);
/// A check that got an answer is good for this long.
const DAILY: chrono::Duration = chrono::Duration::hours(24);
/// A check asked for without insisting (a section opening) runs only this
/// long after the last try.
pub const MIN_INTERVAL: chrono::Duration = chrono::Duration::hours(1);
/// The scheduler looks at least this often.
const MAX_SLEEP: chrono::Duration = chrono::Duration::hours(1);
/// After 1, 2, 3, 4+ failures in a row, the scheduler tries again after this
/// many minutes.
const BACKOFF_MINUTES: [i64; 4] = [5, 30, 120, 360];
/// A date this far ahead of the clock was not written by this clock.
const CLOCK_SLACK: chrono::Duration = chrono::Duration::minutes(1);

/// Where the check reads and writes.
#[derive(Debug, Clone)]
pub(crate) struct Paths {
    /// `updates.json`.
    pub cache: PathBuf,
    /// H4's record.
    pub mcp_record: PathBuf,
    /// The skill store, where H3's manifest is.
    pub skills_store: PathBuf,
}

impl Paths {
    /// This machine's records, and the cache under `data_dir`.
    fn here(data_dir: &Path) -> Self {
        Self {
            cache: store::path_in(data_dir),
            mcp_record: super::mcp::record::default_record_path(),
            skills_store: crate::commands::experts::central_experts_dir(),
        }
    }
}

/// The update check of one process: what it reads and writes, the catalog
/// it asks, and where it announces.
pub struct UpdateChecker {
    paths: Paths,
    harness: Box<dyn Fn() -> Harness + Send + Sync>,
    emitter: EventEmitter,
    /// One check at a time.
    gate: tokio::sync::Mutex<()>,
    checking: AtomicBool,
    /// Checks finished: a request that waited for one to finish takes its
    /// answer rather than asking again.
    finished: AtomicU64,
    /// What was last announced, or taken as the baseline.
    announced: Mutex<Option<Summary>>,
    kicks: Option<mpsc::UnboundedSender<()>>,
    receiver: Mutex<Option<mpsc::UnboundedReceiver<()>>>,
}

static CHECKER: OnceLock<Arc<UpdateChecker>> = OnceLock::new();

/// Builds this process's checker and publishes it; spawn [`run`] with it.
/// The desktop app and `codeg-server` each do this once. `None` under
/// `CODEG_HARNESS=off` (nothing is checked, ever) and on a second call.
pub fn build(data_dir: &Path, emitter: EventEmitter) -> Option<Arc<UpdateChecker>> {
    if !super::enabled() {
        tracing::info!("[harness] update check off ({}=off)", super::SWITCH_ENV);
        return None;
    }
    let (kicks, receiver) = mpsc::unbounded_channel();
    let data_dir = data_dir.to_path_buf();
    let checker = Arc::new(UpdateChecker {
        paths: Paths::here(&data_dir),
        harness: Box::new(move || Harness::from_env(&data_dir)),
        emitter,
        gate: tokio::sync::Mutex::new(()),
        checking: AtomicBool::new(false),
        finished: AtomicU64::new(0),
        announced: Mutex::new(None),
        kicks: Some(kicks),
        receiver: Mutex::new(Some(receiver)),
    });
    CHECKER.set(checker.clone()).ok()?;
    Some(checker)
}

/// The checker the commands use: the process's own when it was built for
/// `data_dir`; otherwise (switched off, or a process without one) one that
/// reads and checks on request only.
pub fn checker_for(data_dir: &Path, emitter: &EventEmitter) -> Arc<UpdateChecker> {
    let paths = Paths::here(data_dir);
    if let Some(checker) = CHECKER.get() {
        if checker.paths.cache == paths.cache {
            return checker.clone();
        }
    }
    let data_dir = data_dir.to_path_buf();
    Arc::new(UpdateChecker::unscheduled(
        paths,
        Box::new(move || Harness::from_env(&data_dir)),
        emitter.clone(),
    ))
}

/// An install, update or uninstall changed a record: the scheduler looks
/// now (announces what that changed, and asks about a new revision). A
/// process without a scheduler ignores it.
pub(crate) fn records_changed() {
    if let Some(checker) = CHECKER.get() {
        checker.kick();
    }
}

/// Now, to the millisecond (what the file and the wire carry).
fn now() -> DateTime<Utc> {
    Utc::now().trunc_subsecs(3)
}

/// A date ahead of the clock is not trusted to space anything out.
fn trusted(at: Option<DateTime<Utc>>, now: DateTime<Utc>) -> Option<DateTime<Utc>> {
    at.filter(|at| *at <= now + CLOCK_SLACK)
}

/// When the scheduler may try again after a failure: the backoff step, or
/// the pause a 429 asked for if that is later. `None` when the last try got
/// an answer.
fn retry_at(kept: &Kept, now: DateTime<Utc>) -> Option<DateTime<Utc>> {
    let error = kept.error.as_ref()?;
    let at = trusted(kept.attempted_at, now)?;
    let step = (kept.failures.max(1) as usize - 1).min(BACKOFF_MINUTES.len() - 1);
    let backoff = at + chrono::Duration::minutes(BACKOFF_MINUTES[step]);
    let asked = error
        .seconds
        .map(|seconds| at + chrono::Duration::seconds(seconds.min(i64::MAX as u64) as i64));
    Some(asked.map_or(backoff, |asked| asked.max(backoff)))
}

/// Whether the scheduler should ask now.
fn scheduled_due(installed: &InstalledRevisions, kept: &Kept, now: DateTime<Utc>) -> bool {
    if model::pairs(installed).is_empty() {
        return false;
    }
    if retry_at(kept, now).is_some_and(|at| at > now) {
        return false;
    }
    kept.error.is_some()
        || trusted(kept.checked_at, now).is_none_or(|at| now - at >= DAILY)
        || model::unanswered(installed, &kept.answers)
}

/// When the scheduler looks next.
fn next_look(kept: &Kept, now: DateTime<Utc>) -> DateTime<Utc> {
    [
        Some(now + MAX_SLEEP),
        trusted(kept.checked_at, now).map(|at| at + DAILY),
        retry_at(kept, now),
    ]
    .into_iter()
    .flatten()
    .filter(|at| *at > now)
    .min()
    .unwrap_or(now + MAX_SLEEP)
}

/// Whether a check someone asked for runs: an explicit one always, one that
/// does not insist only an hour after the last try.
fn asked_due(kept: &Kept, now: DateTime<Utc>, explicit: bool) -> bool {
    explicit || trusted(kept.attempted_at, now).is_none_or(|at| now - at >= MIN_INTERVAL)
}

/// The records as they are now. One that cannot be read adds nothing: its
/// part of `harness_installed` says why, and the check asks about the rest.
fn read_installed(paths: &Paths) -> InstalledRevisions {
    let mut installed = InstalledRevisions::new();
    match super::mcp::record::load(&paths.mcp_record) {
        Ok(record) => {
            for (id, item) in record.items {
                let revisions = installed.entry(id).or_default();
                revisions.extend(item.agents.values().map(|agent| agent.revision));
            }
        }
        Err(error) => tracing::debug!("[harness] update check: {}", error.detail()),
    }
    match super::skills::manifest::load(&paths.skills_store) {
        Ok(manifest) => {
            for entry in manifest.skills.into_values() {
                installed
                    .entry(entry.item_id)
                    .or_default()
                    .insert(entry.revision);
            }
        }
        Err(error) => tracing::debug!("[harness] update check: {}", error.detail()),
    }
    installed.retain(|_, revisions| !revisions.is_empty());
    installed
}

struct Read {
    installed: InstalledRevisions,
    kept: Kept,
}

impl UpdateChecker {
    /// A checker without a scheduler: reads, and checks when asked.
    pub(crate) fn unscheduled(
        paths: Paths,
        harness: Box<dyn Fn() -> Harness + Send + Sync>,
        emitter: EventEmitter,
    ) -> Self {
        Self {
            paths,
            harness,
            emitter,
            gate: tokio::sync::Mutex::new(()),
            checking: AtomicBool::new(false),
            finished: AtomicU64::new(0),
            announced: Mutex::new(None),
            kicks: None,
            receiver: Mutex::new(None),
        }
    }

    fn kick(&self) {
        if let Some(kicks) = &self.kicks {
            let _ = kicks.send(());
        }
    }

    async fn read(&self) -> Option<Read> {
        let paths = self.paths.clone();
        tokio::task::spawn_blocking(move || Read {
            installed: read_installed(&paths),
            kept: store::load(&paths.cache),
        })
        .await
        .ok()
    }

    fn view(&self, read: &Read) -> HarnessUpdates {
        let items = model::derive(&read.installed, &read.kept.answers);
        HarnessUpdates {
            enabled: true,
            checking: self.checking.load(Ordering::SeqCst),
            checked_at: read.kept.checked_at,
            attempted_at: read.kept.attempted_at,
            error: read.kept.error.clone(),
            count: model::count(&items),
            items,
        }
    }

    /// `harness_updates`: what the last check says of what is installed now.
    /// No request.
    pub async fn updates(&self) -> Option<HarnessUpdates> {
        if !(self.harness)().enabled() {
            return Some(HarnessUpdates::switched_off());
        }
        let read = self.read().await?;
        Some(self.view(&read))
    }

    /// `harness_check_updates`: check if it is due (see the module docs),
    /// then answer as [`Self::updates`].
    pub async fn check_now(&self, explicit: bool) -> Option<HarnessUpdates> {
        if !(self.harness)().enabled() {
            return Some(HarnessUpdates::switched_off());
        }
        let finished = self.finished.load(Ordering::SeqCst);
        let _gate = self.gate.lock().await;
        let read = self.read().await?;
        let now = now();
        // a check that was running when this was asked for answers it
        let answered_meanwhile = self.finished.load(Ordering::SeqCst) != finished;
        if answered_meanwhile || !asked_due(&read.kept, now, explicit) {
            return Some(self.view(&read));
        }
        let read = self.check(read, now).await?;
        Some(self.view(&read))
    }

    /// Asks about every installed pair, keeps what came of it, and announces
    /// what changed. With nothing installed, asks nothing.
    async fn check(&self, read: Read, now: DateTime<Utc>) -> Option<Read> {
        self.settle(&read);
        let asked = model::pairs(&read.installed);
        if asked.is_empty() {
            return Some(read);
        }
        let harness = (self.harness)();
        if !harness.enabled() {
            return Some(read);
        }
        self.checking.store(true, Ordering::SeqCst);
        let answer = harness.resolve(&asked).await;
        self.checking.store(false, Ordering::SeqCst);
        self.finished.fetch_add(1, Ordering::SeqCst);
        let outcome = match answer {
            Ok(resolved) => Outcome::Answered(
                asked
                    .iter()
                    .zip(resolved)
                    .map(|(asked, resolved)| Answer::of(asked, resolved))
                    .collect(),
            ),
            Err(error) => {
                tracing::info!("[harness] update check got no answer: {error}");
                Outcome::Failed(CheckError::from(&error))
            }
        };
        // Merged into the file as it is by now, under its lock: another
        // Codeg on this data directory may have checked meanwhile.
        let path = self.paths.cache.clone();
        let kept = tokio::task::spawn_blocking(move || store::record(&path, now, outcome))
            .await
            .ok()?;
        let read = Read {
            installed: read.installed,
            kept,
        };
        self.announce(&read);
        Some(read)
    }

    /// Takes what the files say now as the baseline, if there is none yet:
    /// the first announcement is measured against it.
    fn settle(&self, read: &Read) {
        let mut announced = self
            .announced
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if announced.is_none() {
            let items = model::derive(&read.installed, &read.kept.answers);
            *announced = Some(model::summary(&items));
        }
    }

    /// Announces the items whose state changed since the last announcement.
    fn announce(&self, read: &Read) {
        let items = model::derive(&read.installed, &read.kept.answers);
        let now = model::summary(&items);
        let before = self
            .announced
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .replace(now.clone())
            .unwrap_or_default();
        let item_ids = model::changed_ids(&before, &now);
        if !item_ids.is_empty() {
            emit_event(
                &self.emitter,
                UPDATES_CHANGED_EVENT,
                UpdatesChanged {
                    count: model::count(&items),
                    item_ids,
                },
            );
        }
    }

    /// One look of the scheduler at `now`: announce what the records changed,
    /// check if due, and say when to look next.
    async fn turn(&self, now: DateTime<Utc>) -> DateTime<Utc> {
        if !(self.harness)().enabled() {
            return now + MAX_SLEEP;
        }
        let _gate = self.gate.lock().await;
        let Some(read) = self.read().await else {
            return now + MAX_SLEEP;
        };
        self.settle(&read);
        self.announce(&read);
        if !scheduled_due(&read.installed, &read.kept, now) {
            return next_look(&read.kept, now);
        }
        match self.check(read, now).await {
            Some(read) => next_look(&read.kept, now),
            None => now + MAX_SLEEP,
        }
    }
}

/// The scheduler: a minute after start, then whenever [`UpdateChecker::turn`]
/// says, or at once when the records change.
pub async fn run(checker: Arc<UpdateChecker>) {
    let Some(mut receiver) = checker
        .receiver
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .take()
    else {
        return;
    };
    if let Some(read) = checker.read().await {
        checker.settle(&read);
    }
    let mut wake = tokio::time::Instant::now() + FIRST_WAIT;
    loop {
        tokio::select! {
            kick = receiver.recv() => if kick.is_none() { return },
            _ = tokio::time::sleep_until(wake) => {}
        }
        while receiver.try_recv().is_ok() {}
        let next = checker.turn(now()).await;
        let sleep = (next - Utc::now())
            .to_std()
            .unwrap_or(Duration::ZERO)
            .max(Duration::from_secs(1));
        wake = tokio::time::Instant::now() + sleep;
    }
}
