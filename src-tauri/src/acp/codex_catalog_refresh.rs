//! Keeping the codex catalog codeg published current without the user.
//!
//! Besides a save, three things refresh it: the scheduler (one per process),
//! the check before each Codex session starts, and the refresh after codeg
//! installs or upgrades codex-acp. All three work from what is already
//! published (see [`crate::acp::codex_catalog_commit`]) and never change the
//! intent, the binding or the key.
//!
//! A session never waits on the network. The pre-launch check only re-checks,
//! offline, a catalog the codex about to run has not loaded yet; fetching is
//! the scheduler's, and a fetch that fails keeps what is published.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use chrono::{DateTime, Utc};
use serde::Serialize;
use tokio::sync::mpsc;

use crate::acp::codex_catalog_commit::{
    self as commit, AuthInput, Binding, CatalogError, CommitError, CurrentIntent, FetchPolicy,
    Origin, PrepareInput, Published, ReleaseModel, TomlInput,
};
use crate::acp::codex_endpoint_catalog::{self as endpoint, EndpointCache};
use crate::acp::codex_model_catalog as catalog;
use crate::acp::codex_runtime::{self, CodexRuntime};
use crate::acp::provider_models::clock;
use crate::web::event_bridge::{emit_event, EventEmitter};

/// Emitted after a refresh nobody asked for changed what is published, so an
/// open settings page reloads its status.
pub const CODEX_CATALOG_REFRESHED_EVENT: &str = "app://codex-catalog-refreshed";

/// How long a provider list counts as current, in hours. 0 turns this one
/// trigger off; the others (a codex upgrade, a stand-in in use, a request
/// changed outside codeg) still apply.
pub const REFRESH_HOURS_ENV: &str = "CODEG_CODEX_CATALOG_REFRESH_HOURS";
const DEFAULT_REFRESH_HOURS: f64 = 24.0;
const FIRST_WAKE: Duration = Duration::from_secs(60);
/// The scheduler wakes at least this often, so a codex upgraded outside
/// codeg is noticed within the hour.
const MAX_SLEEP: chrono::Duration = chrono::Duration::hours(1);
/// After 1, 2, 3, 4+ automatic failures in a row, the next try waits this
/// many minutes.
const BACKOFF_MINUTES: [i64; 4] = [5, 30, 120, 360];
/// The longest a Codex launch waits for its pre-launch check.
pub const PRELAUNCH_WAIT: Duration = Duration::from_secs(5);

pub fn refresh_ttl() -> Option<chrono::Duration> {
    parse_ttl(std::env::var(REFRESH_HOURS_ENV).ok().as_deref())
}

fn parse_ttl(raw: Option<&str>) -> Option<chrono::Duration> {
    let hours = match raw.map(str::trim).filter(|s| !s.is_empty()) {
        None => DEFAULT_REFRESH_HOURS,
        Some(text) => match text.parse::<f64>() {
            Ok(h) if h.is_finite() => h,
            _ => {
                tracing::warn!("[codex-catalog] ignoring {REFRESH_HOURS_ENV}={text}: not a number");
                DEFAULT_REFRESH_HOURS
            }
        },
    };
    let minutes = (hours * 60.0).round();
    (minutes >= 1.0)
        .then(|| chrono::Duration::minutes(minutes.min(10.0 * 365.0 * 24.0 * 60.0) as i64))
}

// ─── What is due ────────────────────────────────────────────────────────

/// Work the published catalog needs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Action {
    /// Make sure, offline, that the codex about to run loads it; rebuild it
    /// from what is published when not.
    Recheck,
    /// Ask the provider again.
    Fetch,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Assessment {
    pub action: Option<Action>,
    /// When the provider list stops counting as current.
    pub expires_at: Option<DateTime<Utc>>,
    /// Why nothing runs on its own.
    pub paused: Option<&'static str>,
    /// The published intent takes its list from a provider.
    pub provider_source: bool,
}

/// What is due for what is published, judged against the codex that would
/// run now.
pub fn assess(
    published: &Published,
    runtime: &CodexRuntime,
    now: DateTime<Utc>,
    ttl: Option<chrono::Duration>,
) -> Assessment {
    let Some(raw) = published.sidecar.as_deref() else {
        return Assessment::default();
    };
    let intent = catalog::parse_model_config(Some(raw));
    let provider_source = intent.catalog.is_some();
    let referenced = published.references_codeg_catalog();
    if !provider_source && !referenced {
        return Assessment::default();
    }
    let paused = |why| Assessment {
        paused: Some(why),
        provider_source,
        ..Assessment::default()
    };
    if provider_source && commit::codeg_provider_parts(published.config_text()).is_none() {
        return paused("provider_not_codeg");
    }
    let meta = published.meta.as_ref();
    if meta.is_some_and(|m| !m.conflict.is_empty()) {
        return paused("conflict");
    }
    let runtime_moved = runtime.confirmed
        && meta.is_none_or(|m| !m.is_validated_by(runtime) || !m.built_for(runtime));
    let file_missing = referenced && published.catalog.is_none();
    if !provider_source {
        return Assessment {
            action: (runtime_moved || file_missing).then_some(Action::Recheck),
            ..Assessment::default()
        };
    }
    let Ok(Some(request)) =
        commit::request_for(&intent, published.config_text(), published.auth_text())
    else {
        return paused("missing_api_key");
    };
    let Some(meta) = meta else {
        return Assessment {
            action: Some(Action::Fetch),
            provider_source,
            ..Assessment::default()
        };
    };
    let expires_at = ttl.and_then(|ttl| meta.checked_at.map(|t| t + ttl));
    let due = runtime_moved
        || file_missing
        || meta.checked_at.is_none()
        || expires_at.is_some_and(|t| now >= t)
        || meta.stale
        || meta.degraded.is_some()
        || (runtime.confirmed && meta.client_version.as_deref() != Some(runtime.version.as_str()))
        || meta.url.as_deref() != Some(request.url())
        || meta.request_fingerprint.as_deref() != Some(request.fingerprint().as_str());
    Assessment {
        action: due.then_some(Action::Fetch),
        expires_at,
        paused: None,
        provider_source,
    }
}

// ─── One refresh ────────────────────────────────────────────────────────

/// What a refresh nobody asked for did.
#[derive(Debug, Clone, PartialEq)]
pub enum RefreshOutcome {
    /// Nothing of codeg's is published, or nothing it may refresh.
    Skipped(&'static str),
    /// Already current; nothing written.
    Unchanged,
    /// Written: the files that changed.
    Published(Vec<String>),
    /// What it was built on changed while it ran; dropped, the next run
    /// starts over.
    Dropped(&'static str),
}

#[derive(Debug, Clone)]
pub struct RefreshReport {
    pub outcome: RefreshOutcome,
    /// The fetch failed: what is published was kept, or a stand-in built.
    pub fetch_error: Option<CatalogError>,
}

fn published_binding(p: &Published) -> Binding {
    p.meta
        .as_ref()
        .map(|m| m.binding())
        .unwrap_or(Binding::Unknown)
}

/// Bring what is published in line with the current codex and, as `fetch`
/// allows, the provider — from the published state alone.
pub async fn refresh_published(
    home: &Path,
    origin: Origin,
    fetch: FetchPolicy,
    cache: &EndpointCache,
) -> Result<RefreshReport, CatalogError> {
    let skipped = |why| RefreshReport {
        outcome: RefreshOutcome::Skipped(why),
        fetch_error: None,
    };
    let published = Published::read(home)?;
    let Some(raw) = published.sidecar.clone() else {
        return Ok(skipped("no_intent"));
    };
    let intent = catalog::parse_model_config(Some(&raw));
    if intent.catalog.is_none() && !published.references_codeg_catalog() {
        return Ok(skipped("not_published"));
    }
    // A provider list needs codeg's provider; a user's save drops the source
    // when it is gone, a refresh never changes the intent.
    if intent.catalog.is_some() && commit::codeg_provider_parts(published.config_text()).is_none() {
        return Ok(skipped("provider_not_codeg"));
    }
    let prepared = commit::prepare(PrepareInput {
        origin,
        binding: published_binding(&published),
        intent_raw: Some(raw),
        toml_text: published.config_text(),
        auth_text: published.auth_text(),
        published: &published,
        fetch,
        cache,
    })
    .await?;
    let fetch_error = prepared.fetch_error.clone();
    if prepared.is_noop() {
        return Ok(RefreshReport {
            outcome: RefreshOutcome::Unchanged,
            fetch_error,
        });
    }
    let locked = commit::lock_home(home).await?;
    let current = CurrentIntent {
        binding: published_binding(locked.published()),
        intent_raw: locked.published().sidecar.clone(),
    };
    let outcome = match locked
        .commit(
            &prepared,
            &current,
            &TomlInput::disk(),
            &AuthInput::Keep,
            &ReleaseModel::Keep,
        )
        .await
    {
        Ok(done) if done.changed.is_empty() => RefreshOutcome::Unchanged,
        Ok(done) => RefreshOutcome::Published(done.changed),
        Err(CommitError::Stale(why)) => RefreshOutcome::Dropped(why),
        Err(CommitError::Superseded) => RefreshOutcome::Dropped("superseded"),
        Err(CommitError::Failed(e)) => return Err(e),
    };
    Ok(RefreshReport {
        outcome,
        fetch_error,
    })
}

// ─── Before a launch ────────────────────────────────────────────────────

/// Whether the codex about to run has yet to load what codeg published (or
/// the file it references is gone). An unconfirmed runtime cannot be asked.
fn needs_recheck(published: &Published, runtime: &CodexRuntime) -> bool {
    if !runtime.confirmed || published.sidecar.is_none() || !published.references_codeg_catalog() {
        return false;
    }
    published.catalog.is_none()
        || published
            .meta
            .as_ref()
            .is_none_or(|m| !m.is_validated_by(runtime))
}

fn launch_gate(home: &Path) -> Arc<tokio::sync::Mutex<()>> {
    static GATES: OnceLock<Mutex<HashMap<PathBuf, Arc<tokio::sync::Mutex<()>>>>> = OnceLock::new();
    let mut gates = GATES
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    gates
        .entry(commit::lock::normalize_home(home))
        .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
        .clone()
}

#[derive(Debug, Clone, PartialEq)]
pub enum PrelaunchOutcome {
    /// Nothing to check.
    Fine,
    /// Checked again (and rebuilt when needed).
    Rechecked(RefreshOutcome),
}

/// Make sure the codex about to run loads what is published, offline. Only
/// a launch after a codex change does any work; launches that arrive
/// together check once (the gate) and the rest find it done.
pub async fn prelaunch_check(
    home: &Path,
    cache: &EndpointCache,
) -> Result<PrelaunchOutcome, CatalogError> {
    // Most launches: codeg publishes nothing here, and nothing was cut short.
    if !home.join(catalog::SOURCE_REL).exists() && !commit::interrupted(home) {
        return Ok(PrelaunchOutcome::Fine);
    }
    let runtime = codex_runtime::current().await;
    let published = Published::read(home)?;
    if !commit::interrupted(home) && !needs_recheck(&published, &runtime) {
        if assess(&published, &runtime, clock::now(), refresh_ttl())
            .action
            .is_some()
        {
            kick(Kick::Due);
        }
        return Ok(PrelaunchOutcome::Fine);
    }
    let gate = launch_gate(home);
    let _gate = gate.lock().await;
    if commit::interrupted(home) {
        // Taking the lock finishes or undoes it.
        drop(commit::lock_home(home).await?);
    }
    let runtime = codex_runtime::current().await;
    if !needs_recheck(&Published::read(home)?, &runtime) {
        return Ok(PrelaunchOutcome::Fine);
    }
    let report = refresh_published(home, Origin::Prelaunch, FetchPolicy::Never, cache).await?;
    if let RefreshOutcome::Published(changed) = &report.outcome {
        emit_refreshed("prelaunch", changed);
    }
    // The provider may answer this codex version with another list.
    kick(Kick::Due);
    Ok(PrelaunchOutcome::Rechecked(report.outcome))
}

/// The pre-launch check for codeg's `CODEX_HOME`, waited on for at most
/// [`PRELAUNCH_WAIT`].
pub async fn before_launch() {
    before_launch_at(
        crate::commands::acp::codex_home_dir(),
        EndpointCache::default(),
        PRELAUNCH_WAIT,
    )
    .await;
}

/// [`before_launch`] for `home`, waiting at most `wait`. The check runs as a
/// task of its own: a launch that stops waiting leaves it running, so a
/// commit it began is never cut short.
async fn before_launch_at(home: PathBuf, cache: EndpointCache, wait: Duration) {
    let task = tokio::spawn(async move {
        match prelaunch_check(&home, &cache).await {
            Ok(PrelaunchOutcome::Fine) => {}
            Ok(PrelaunchOutcome::Rechecked(outcome)) => {
                tracing::info!("[codex-catalog] pre-launch check: {outcome:?}")
            }
            Err(e) => tracing::warn!("[codex-catalog] pre-launch check failed: {e}"),
        }
    });
    if tokio::time::timeout(wait, task).await.is_err() {
        tracing::info!("[codex-catalog] pre-launch check still running; launching without it");
    }
}

// ─── After an install ───────────────────────────────────────────────────

/// After codeg installed or upgraded codex-acp: re-read the codex it now
/// drives, bring what is published in line with it, and ask the provider
/// again. Never fails the install; the caller logs the result.
pub async fn after_install() -> Result<RefreshReport, CatalogError> {
    codex_runtime::invalidate();
    if crate::acp::codex_catalog_source::refresh_live_catalog()
        .await
        .is_none()
    {
        tracing::warn!("[codex-catalog] codex installed, but its model catalog could not be read");
    }
    refresh_after_install(
        &crate::commands::acp::codex_home_dir(),
        &EndpointCache::default(),
    )
    .await
}

/// [`after_install`]'s refresh of `home`, once the codex it drives is known.
async fn refresh_after_install(
    home: &Path,
    cache: &EndpointCache,
) -> Result<RefreshReport, CatalogError> {
    let report = refresh_published(home, Origin::Install, FetchPolicy::Force, cache).await;
    if let Ok(RefreshReport {
        outcome: RefreshOutcome::Published(changed),
        ..
    }) = &report
    {
        emit_refreshed("install", changed);
    }
    kick(Kick::Published);
    report
}

// ─── The scheduler ──────────────────────────────────────────────────────

/// Why the scheduler should look again before its next wake.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kick {
    /// Something may be due.
    Due,
    /// codex-acp changed outside codeg: ask the provider again, whatever the
    /// list's age.
    AdapterChanged,
    /// A user's save or refresh published: earlier failures no longer count.
    Published,
}

/// The scheduler's view, for the status line. In memory only: a restart
/// starts with a clean slate, at the cost of one more request.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RefreshStatus {
    pub in_progress: bool,
    pub last_attempt_at: Option<DateTime<Utc>>,
    pub last_error: Option<CatalogError>,
    pub last_error_at: Option<DateTime<Utc>>,
    pub consecutive_failures: u32,
    /// When the next automatic fetch is expected.
    pub next_refresh_at: Option<DateTime<Utc>>,
    pub paused: Option<&'static str>,
    /// Whether this process runs a scheduler at all.
    pub scheduled: bool,
}

/// The status, one per process; one per thread under test, where tests run
/// side by side.
fn with_status<R>(f: impl FnOnce(&mut Option<RefreshStatus>) -> R) -> R {
    #[cfg(not(test))]
    {
        static STATUS: Mutex<Option<RefreshStatus>> = Mutex::new(None);
        f(&mut STATUS.lock().unwrap_or_else(|e| e.into_inner()))
    }
    #[cfg(test)]
    {
        thread_local! {
            static STATUS: std::cell::RefCell<Option<RefreshStatus>> =
                const { std::cell::RefCell::new(None) };
        }
        STATUS.with(|s| f(&mut s.borrow_mut()))
    }
}

fn update_status(f: impl FnOnce(&mut RefreshStatus)) {
    with_status(|status| f(status.get_or_insert_with(RefreshStatus::default)));
}

/// A user's save or "Refresh now" just asked the provider: the status line
/// shows how that went, as it does for the scheduler's own tries.
pub fn note_user_fetch(error: Option<&CatalogError>) {
    let now = clock::now();
    update_status(|s| {
        s.last_attempt_at = Some(now);
        s.last_error = error.cloned();
        s.last_error_at = error.map(|_| now);
    });
}

pub fn status() -> RefreshStatus {
    let mut out = with_status(|status| status.clone()).unwrap_or_default();
    out.scheduled = SCHEDULER.get().is_some();
    out
}

#[derive(Debug, Clone, Copy, Default)]
struct Backoff {
    failures: u32,
    last_failure: Option<DateTime<Utc>>,
}

impl Backoff {
    fn fail(&mut self, at: DateTime<Utc>) {
        self.failures += 1;
        self.last_failure = Some(at);
    }

    fn reset(&mut self) {
        *self = Self::default();
    }

    /// The earliest the next automatic try may run.
    fn gate(&self) -> Option<DateTime<Utc>> {
        let at = self.last_failure?;
        let step = (self.failures.max(1) as usize - 1).min(BACKOFF_MINUTES.len() - 1);
        Some(at + chrono::Duration::minutes(BACKOFF_MINUTES[step]))
    }
}

pub struct Scheduler {
    kicks: mpsc::UnboundedSender<Kick>,
    receiver: Mutex<Option<mpsc::UnboundedReceiver<Kick>>>,
    emitter: EventEmitter,
}

static SCHEDULER: OnceLock<Arc<Scheduler>> = OnceLock::new();

/// Build this process's scheduler and publish it, then spawn [`run`] with it.
/// Desktop setup and codeg-server each do this once; a second call returns
/// `None`.
pub fn build(emitter: EventEmitter) -> Option<Arc<Scheduler>> {
    let (kicks, receiver) = mpsc::unbounded_channel();
    let scheduler = Arc::new(Scheduler {
        kicks,
        receiver: Mutex::new(Some(receiver)),
        emitter,
    });
    SCHEDULER.set(scheduler.clone()).ok()?;
    Some(scheduler)
}

/// Ask the scheduler to look now. A process without one (tests, the
/// companion binaries) ignores it.
pub fn kick(kick: Kick) {
    if let Some(s) = SCHEDULER.get() {
        let _ = s.kicks.send(kick);
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RefreshedPayload<'a> {
    origin: &'static str,
    changed: &'a [String],
}

fn emit_refreshed(origin: &'static str, changed: &[String]) {
    if let Some(s) = SCHEDULER.get() {
        emit_event(
            &s.emitter,
            CODEX_CATALOG_REFRESHED_EVENT,
            RefreshedPayload { origin, changed },
        );
    }
}

/// Files a release left for later, and caches nobody reads any more.
async fn startup_cleanup(home: &Path) {
    if let Err(e) = commit::cleanup_released(home).await {
        tracing::warn!("[codex-catalog] startup cleanup failed: {e}");
    }
    let _ = tokio::task::spawn_blocking(|| {
        codex_runtime::sweep_oracle_dir();
        endpoint::sweep_cache();
    })
    .await;
}

/// The scheduler's loop: sleep until something is due (or for an hour at
/// most), or until kicked; then look at what is published and do what is
/// due. Kicks that arrive during a run are taken by the next turn, so one
/// process refreshes one `CODEX_HOME` once at a time.
pub async fn run(scheduler: Arc<Scheduler>) {
    let Some(mut receiver) = scheduler
        .receiver
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .take()
    else {
        return;
    };
    let home = crate::commands::acp::codex_home_dir();
    let cache = EndpointCache::default();
    let mut wake = tokio::time::Instant::now() + FIRST_WAKE;
    let mut cleaned = false;
    let mut backoff = Backoff::default();
    loop {
        let mut force = false;
        tokio::select! {
            kick = receiver.recv() => match kick {
                Some(kick) => take_kick(kick, &mut force, &mut backoff),
                None => return,
            },
            _ = tokio::time::sleep_until(wake) => {}
        }
        while let Ok(kick) = receiver.try_recv() {
            take_kick(kick, &mut force, &mut backoff);
        }
        if !cleaned {
            startup_cleanup(&home).await;
            cleaned = true;
        }
        let next = run_due(&home, &cache, force, &mut backoff).await;
        let sleep = (next - clock::now())
            .to_std()
            .unwrap_or(Duration::ZERO)
            .max(Duration::from_secs(1));
        wake = tokio::time::Instant::now() + sleep;
    }
}

fn take_kick(kick: Kick, force: &mut bool, backoff: &mut Backoff) {
    match kick {
        Kick::Due => {}
        Kick::AdapterChanged => {
            *force = true;
            backoff.reset();
        }
        Kick::Published => backoff.reset(),
    }
}

/// One turn: do what is due, return when to look next.
async fn run_due(
    home: &Path,
    cache: &EndpointCache,
    force: bool,
    backoff: &mut Backoff,
) -> DateTime<Utc> {
    let now = clock::now();
    let ttl = refresh_ttl();
    let runtime = codex_runtime::current().await;
    let published = match Published::read(home) {
        Ok(p) => p,
        Err(e) => {
            backoff.fail(now);
            update_status(|s| {
                s.last_error = Some(e);
                s.last_error_at = Some(now);
                s.consecutive_failures = backoff.failures;
            });
            return next_wake(now, None, backoff);
        }
    };
    let assessment = assess(&published, &runtime, now, ttl);
    let action = if force && assessment.provider_source && assessment.paused.is_none() {
        Some(Action::Fetch)
    } else {
        assessment.action
    };
    let gated = backoff.gate().filter(|gate| *gate > now && !force);
    let Some(action) = action.filter(|_| gated.is_none()) else {
        let next_fetch = match (assessment.action, gated) {
            (Some(_), Some(gate)) => Some(gate),
            _ if assessment.provider_source && assessment.paused.is_none() => assessment.expires_at,
            _ => None,
        };
        update_status(|s| {
            s.next_refresh_at = next_fetch;
            s.paused = assessment.paused;
        });
        return next_wake(now, assessment.expires_at, backoff);
    };

    update_status(|s| {
        s.in_progress = true;
        s.last_attempt_at = Some(now);
    });
    let policy = match action {
        Action::Recheck => FetchPolicy::Never,
        Action::Fetch => FetchPolicy::Force,
    };
    let result = refresh_published(home, Origin::Background, policy, cache).await;
    let finished = clock::now();
    let error = match &result {
        Ok(report) => report.fetch_error.clone(),
        Err(e) => Some(e.clone()),
    };
    match &result {
        Ok(report) => {
            if let RefreshOutcome::Published(changed) = &report.outcome {
                emit_refreshed("background", changed);
            }
            tracing::info!("[codex-catalog] background refresh: {:?}", report.outcome);
        }
        Err(e) => tracing::warn!("[codex-catalog] background refresh failed: {e}"),
    }
    // Still due after a run that reported no error (a list codex refused,
    // a stand-in in use): back off all the same, or it would run every turn.
    let after = Published::read(home)
        .map(|p| assess(&p, &runtime, finished, ttl))
        .unwrap_or_default();
    if error.is_some() || after.action.is_some() {
        backoff.fail(finished);
    } else {
        backoff.reset();
    }
    let next_fetch = if after.provider_source && after.paused.is_none() {
        match after.action {
            Some(_) => backoff.gate(),
            None => after.expires_at,
        }
    } else {
        None
    };
    update_status(|s| {
        s.in_progress = false;
        if let Some(e) = error {
            s.last_error = Some(e);
            s.last_error_at = Some(finished);
        } else if after.action.is_none() {
            s.last_error = None;
            s.last_error_at = None;
        }
        s.consecutive_failures = backoff.failures;
        s.next_refresh_at = next_fetch;
        s.paused = after.paused;
    });
    next_wake(finished, after.expires_at, backoff)
}

fn next_wake(
    now: DateTime<Utc>,
    expires_at: Option<DateTime<Utc>>,
    backoff: &Backoff,
) -> DateTime<Utc> {
    [Some(now + MAX_SLEEP), expires_at, backoff.gate()]
        .into_iter()
        .flatten()
        .filter(|t| *t > now)
        .min()
        .unwrap_or(now + MAX_SLEEP)
}

#[cfg(test)]
mod tests;
