//! Auto-processing for the repository panel: a repository is scanned on a
//! schedule, or as soon as its forge sends a webhook, and every open item the
//! folder's rules match — and that has never had a task — becomes one.
//!
//! What it is configured by lives in `settings::ForgeAutoSettings` (scoped like
//! the rest of the panel's settings); which items match is `rules`; what a
//! webhook delivery is and whether it is genuine is `webhook`. This module is
//! the moving part: when to scan, what a scan reads, and what it mints.
//!
//! Three properties carry it:
//!
//! - **One process.** The processor exists only next to the task engine — the
//!   process that holds the data directory's task lock — so a desktop app and a
//!   server sharing one database never both scan and both mint.
//! - **One scan per folder at a time.** A webhook landing mid-scan is not
//!   dropped and not run concurrently: the running scan runs once more when it
//!   finishes, and that pass sees whatever the delivery was about.
//! - **Every item at most once.** The pick-up check is "has this item EVER had
//!   a task" (`source_keys_ever_tasked`), and the create path's own dedup still
//!   stands behind it — so a duplicated delivery, an overlapping window or two
//!   folders cloned from one repository all end in one task.
//!
//! Tasks are minted through the same entry point the trigger dialog uses
//! (`commands::forge::create_forge_task`), so an automatic task passes every
//! gate a clicked one does and gets the same prompt, envelope and standing
//! instructions — only its timeline says `auto`.

pub mod rules;
pub mod webhook;

use std::collections::{BTreeMap, HashMap};
use std::hash::{Hash, Hasher};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use chrono::{DateTime, SubsecRound, Utc};
use serde::Serialize;
use tokio::time::MissedTickBehavior;

use crate::app_error::AppCommandError;
use crate::commands::forge::{
    auto_scenario, create_forge_task, folder_forge_remote_core, ForgeCreateResult, ForgeRemote,
    ForgeTaskDraft, ForgeTaskOrigin, ForgeTaskSourceInput,
};
use crate::db::service::{folder_service, work_task_service};
use crate::db::AppDatabase;
use crate::forge::envelope::ForgeSnapshot;
use crate::forge::settings::{self, ForgeAutoSettings, ForgePanelSettings};
use crate::forge::{self as forge_core, ForgeIssueRow, ForgeProvider, OpenItemsScan};
use crate::web::event_bridge::EventEmitter;

/// How often the schedule is checked. Scan intervals are whole minutes, so
/// half a minute catches each one close to when it falls due.
const TICK_SECS: u64 = 30;
/// Grace after boot before the first pass: the engines' own boot recovery
/// runs first, and a scan that mints tasks into a board still reconciling its
/// interrupted rows helps nobody.
const FIRST_TICK_DELAY_SECS: u64 = 20;
/// How far each incremental scan reaches back past the previous one's start.
/// Covers clock skew between this machine and the forge (the window is cut on
/// the forge's `updated_at` but measured on this clock) and a write the forge
/// committed just before the previous listing but published just after. The
/// overlap costs a few items read twice, which the pick-up check absorbs.
const WATERMARK_OVERLAP_MINUTES: i64 = 10;
/// How far the switch-on floor (`enabled_at`, this machine's clock) reaches
/// back to absorb a forge whose clock runs behind it — otherwise an item
/// updated right after switch-on could carry an earlier forge timestamp and
/// fall outside the window. Small on purpose: anything it lets in was touched
/// minutes before the switch, which is not the backlog it exists to keep out.
const CLOCK_SKEW_ALLOWANCE_MINUTES: i64 = 2;

static PROCESSOR: OnceLock<Arc<AutoProcessor>> = OnceLock::new();

/// The process-global processor, or `None` in a process that does not run
/// auto-processing (it does not own the task engine).
pub fn processor() -> Option<Arc<AutoProcessor>> {
    PROCESSOR.get().cloned()
}

/// Build the processor and publish it. Call ONLY where the task engine was
/// just built — owning that engine is what makes this the one process allowed
/// to mint tasks unattended — then spawn [`run`] with the handle.
pub fn build(db: AppDatabase, emitter: EventEmitter) -> Option<Arc<AutoProcessor>> {
    let processor = Arc::new(AutoProcessor {
        db,
        emitter,
        folders: Mutex::new(HashMap::new()),
    });
    PROCESSOR.set(processor.clone()).ok()?;
    Some(processor)
}

/// The scheduler: every tick, start the scans that have fallen due. Spawn once
/// per process, next to the task engine's driver.
pub async fn run(processor: Arc<AutoProcessor>) {
    let first = tokio::time::Instant::now() + Duration::from_secs(FIRST_TICK_DELAY_SECS);
    let mut tick = tokio::time::interval_at(first, Duration::from_secs(TICK_SECS));
    tick.set_missed_tick_behavior(MissedTickBehavior::Delay);
    loop {
        tick.tick().await;
        processor.start_due_scans().await;
    }
}

/// What set a scan off.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Trigger {
    /// The folder's scan interval came round.
    Schedule,
    /// The forge delivered a webhook for the folder's repository.
    Webhook,
    /// Someone pressed "Scan now" in the panel settings.
    Manual,
}

impl Trigger {
    /// Wire name — also what the task timeline records.
    pub fn as_str(self) -> &'static str {
        match self {
            Trigger::Schedule => "schedule",
            Trigger::Webhook => "webhook",
            Trigger::Manual => "manual",
        }
    }
}

/// One task a scan minted.
#[derive(Debug, Clone, Serialize)]
pub struct CreatedItem {
    pub number: i64,
    pub is_pr: bool,
    pub title: String,
    pub task_id: i32,
    /// Queued straight away (`auto_start`), as opposed to left in To-do.
    pub started: bool,
    /// Why queueing it failed, when `auto_start` asked for it and it did. The
    /// task itself exists either way and waits in To-do.
    pub start_error: Option<String>,
}

/// One matching item a scan could not mint a task for.
#[derive(Debug, Clone, Serialize)]
pub struct FailedItem {
    pub number: i64,
    pub is_pr: bool,
    pub error: String,
}

/// What one scan did — shown in the panel settings, so a rule that never
/// matches, a token that stopped working or a webhook that fires into nothing
/// is visible rather than silent.
#[derive(Debug, Clone, Serialize)]
pub struct ScanReport {
    pub trigger: Trigger,
    pub started_at: DateTime<Utc>,
    pub finished_at: DateTime<Utc>,
    /// Why the scan stopped before it could look at anything. Everything
    /// below describes as much as it got through.
    pub error: Option<String>,
    /// The window's start: items updated before it were not read. `None` =
    /// every open item.
    pub since: Option<DateTime<Utc>>,
    /// Open items the forge listed inside the window.
    pub examined: usize,
    /// Of those, the ones the rules pick up.
    pub matched: usize,
    /// Of those, the ones that already have — or once had — a task.
    pub already_handled: usize,
    pub created: Vec<CreatedItem>,
    pub failed: Vec<FailedItem>,
    /// Items passed over, by the first rule that ruled each one out.
    pub skipped: BTreeMap<rules::Skip, usize>,
    /// The listing was cut short by its page budget: the next scan carries on
    /// from where this one stopped, in the same window, until it is read to
    /// the end.
    pub truncated: bool,
}

impl ScanReport {
    fn new(trigger: Trigger, started_at: DateTime<Utc>) -> Self {
        Self {
            trigger,
            started_at,
            finished_at: started_at,
            error: None,
            since: None,
            examined: 0,
            matched: 0,
            already_handled: 0,
            created: Vec::new(),
            failed: Vec::new(),
            skipped: BTreeMap::new(),
            truncated: false,
        }
    }
}

/// Where auto-processing stands for one folder.
#[derive(Debug, Clone, Serialize)]
pub struct ForgeAutoStatus {
    /// Whether this process runs auto-processing at all. `false` in a codeg
    /// that shares its data directory with another one holding the task
    /// engine — that one scans, this one can only show the settings.
    pub available: bool,
    /// A scan of this folder is running right now.
    pub scanning: bool,
    pub last_scan: Option<ScanReport>,
    /// When the schedule next looks, if a schedule is on. In the past means
    /// "at the next tick".
    pub next_scan_at: Option<DateTime<Utc>>,
    /// When the forge last delivered a webhook that verified for this folder.
    pub last_delivery_at: Option<DateTime<Utc>>,
}

impl ForgeAutoStatus {
    pub fn unavailable() -> Self {
        Self {
            available: false,
            scanning: false,
            last_scan: None,
            next_scan_at: None,
            last_delivery_at: None,
        }
    }
}

/// Why a scan was not started.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ScanRefused {
    /// Neither trigger is on (or the one asking is off) for this folder.
    Off,
    /// A scan of this folder is already running; it will run once more when
    /// it ends, which covers whatever this request was about.
    Busy,
    /// The settings could not be read.
    Settings(String),
}

impl From<ScanRefused> for AppCommandError {
    fn from(refused: ScanRefused) -> Self {
        match refused {
            ScanRefused::Off => {
                AppCommandError::invalid_input("auto-processing is off for this folder")
            }
            ScanRefused::Busy => AppCommandError::invalid_input(
                "this folder is already being scanned — its results will appear shortly",
            ),
            ScanRefused::Settings(e) => {
                AppCommandError::database_error("the panel settings could not be read")
                    .with_detail(e)
            }
        }
    }
}

/// A webhook delivery's answer: HTTP status and a line for the forge's
/// delivery log — the one place a user debugging their webhook looks.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WebhookOutcome {
    pub status: u16,
    pub message: String,
}

impl WebhookOutcome {
    fn new(status: u16, message: impl Into<String>) -> Self {
        Self {
            status,
            message: message.into(),
        }
    }
}

#[derive(Debug, Default)]
struct FolderState {
    scanning: bool,
    /// Another trigger arrived while a scan ran: run once more after it.
    rerun: Option<Trigger>,
    /// When the latest scan STARTED — what the schedule counts from.
    last_started: Option<DateTime<Utc>>,
    /// The incremental window: when the last COMPLETE scan started, and the
    /// fingerprint of the rules it ran under. A different fingerprint means
    /// the rules changed, and the next scan starts over from the rules' own
    /// window — an item a removed exclusion now lets through was not updated
    /// since, and an incremental scan would never see it.
    watermark: Option<(DateTime<Utc>, u64)>,
    /// A window the page budget split across scans, being worked through.
    sweep: Option<Sweep>,
    last_report: Option<ScanReport>,
    last_delivery_at: Option<DateTime<Utc>>,
}

/// One window being read across several scans because its listing outgrew a
/// scan's page budget. Each scan reads on from `cursor` within the SAME
/// window; once the last collection is read to its end, the window moves to
/// `started_at` — the start of the sweep's FIRST scan, since everything
/// updated after that moved to the front of the listing, behind where the
/// sweep was reading, and is the next window's to read.
#[derive(Debug, Clone)]
struct Sweep {
    fingerprint: u64,
    since: Option<DateTime<Utc>>,
    started_at: DateTime<Utc>,
    cursor: forge_core::ScanCursor,
}

pub struct AutoProcessor {
    db: AppDatabase,
    emitter: EventEmitter,
    /// Never held across an `.await` — every access is a short read or write.
    folders: Mutex<HashMap<i32, FolderState>>,
}

impl AutoProcessor {
    fn with_state<T>(&self, folder_id: i32, f: impl FnOnce(&mut FolderState) -> T) -> T {
        let mut folders = self
            .folders
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        f(folders.entry(folder_id).or_default())
    }

    /// One pass of the schedule: every open project folder whose scan
    /// interval has elapsed gets a scan.
    async fn start_due_scans(self: &Arc<Self>) {
        let store = match settings::load(&self.db.conn).await {
            Ok(store) => store,
            Err(e) => {
                tracing::warn!("[forge-auto] settings unreadable: {e}");
                return;
            }
        };
        let folders = match project_folder_ids(&self.db).await {
            Ok(ids) => ids,
            Err(e) => {
                tracing::warn!("[forge-auto] folder list unreadable: {e}");
                return;
            }
        };
        let now = Utc::now();
        for folder_id in folders {
            let auto = &store.effective(folder_id).auto;
            if !(auto.schedule && auto.is_active()) {
                continue;
            }
            let interval = chrono::Duration::minutes(i64::from(auto.interval_minutes));
            let due = self.with_state(folder_id, |state| {
                !state.scanning
                    && state
                        .last_started
                        .is_none_or(|started| now - started >= interval)
            });
            if due {
                self.spawn_scan(folder_id, Trigger::Schedule);
            }
        }
    }

    /// Start a scan without waiting for it. A refusal is not an error here:
    /// "busy" already queued the rerun, and "off" means the settings changed
    /// under the trigger.
    pub fn spawn_scan(self: &Arc<Self>, folder_id: i32, trigger: Trigger) {
        let processor = self.clone();
        tokio::spawn(async move {
            if let Err(refused) = processor.scan(folder_id, trigger).await {
                tracing::debug!(
                    "[forge-auto] {} scan of folder {folder_id} not started: {refused:?}",
                    trigger.as_str()
                );
            }
        });
    }

    /// Scan one folder now and return what the scan did — or, if the scan had
    /// to run again because another trigger arrived while it was running, what
    /// the LAST pass did.
    pub async fn scan(
        self: &Arc<Self>,
        folder_id: i32,
        trigger: Trigger,
    ) -> Result<ScanReport, ScanRefused> {
        let store = settings::load(&self.db.conn)
            .await
            .map_err(|e| ScanRefused::Settings(e.to_string()))?;
        let auto = &store.effective(folder_id).auto;
        let allowed = auto.is_active()
            && match trigger {
                Trigger::Schedule => auto.schedule,
                Trigger::Webhook => auto.webhook,
                Trigger::Manual => true,
            };
        if !allowed {
            return Err(ScanRefused::Off);
        }

        let claimed = self.with_state(folder_id, |state| {
            if state.scanning {
                // The running scan picks this up when it ends. Keep the most
                // explicit reason for the record.
                state.rerun = Some(match (state.rerun, trigger) {
                    (Some(Trigger::Manual), _) => Trigger::Manual,
                    _ => trigger,
                });
                return false;
            }
            state.scanning = true;
            state.last_started = Some(Utc::now());
            true
        });
        if !claimed {
            return Err(ScanRefused::Busy);
        }
        // Gives the slot back if this future ends ABNORMALLY — cancelled, or
        // unwound by a panic. Without it, one panicking scan would leave the
        // folder "scanning" for the life of the process, and every later
        // trigger would queue a rerun nothing is left to run. The normal
        // release below happens under the same lock as the rerun check (so a
        // trigger landing in between is never lost) and disarms this.
        let mut slot = ScanSlot {
            processor: self,
            folder_id,
            armed: true,
        };

        let mut trigger = trigger;
        loop {
            let report = self.scan_once(folder_id, trigger).await;
            if let Some(error) = &report.error {
                tracing::info!(
                    "[forge-auto] {} scan of folder {folder_id} stopped: {error}",
                    trigger.as_str()
                );
            } else if !report.created.is_empty() {
                tracing::info!(
                    "[forge-auto] {} scan of folder {folder_id} created {} task(s)",
                    trigger.as_str(),
                    report.created.len()
                );
            }
            let next = self.with_state(folder_id, |state| {
                state.last_report = Some(report.clone());
                match state.rerun.take() {
                    Some(next) => {
                        state.last_started = Some(Utc::now());
                        Some(next)
                    }
                    None => {
                        state.scanning = false;
                        None
                    }
                }
            });
            match next {
                Some(next) => trigger = next,
                None => {
                    slot.armed = false;
                    return Ok(report);
                }
            }
        }
    }

    async fn scan_once(&self, folder_id: i32, trigger: Trigger) -> ScanReport {
        let started_at = Utc::now();
        let mut report = ScanReport::new(trigger, started_at);
        if let Err(error) = self
            .scan_into(folder_id, trigger, started_at, &mut report)
            .await
        {
            report.error = Some(error);
        }
        report.finished_at = Utc::now();
        report
    }

    async fn scan_into(
        &self,
        folder_id: i32,
        trigger: Trigger,
        started_at: DateTime<Utc>,
        report: &mut ScanReport,
    ) -> Result<(), String> {
        // Re-read: the settings may have changed since the trigger fired, and
        // the rules this pass applies are the ones in force when it runs.
        let store = settings::load(&self.db.conn)
            .await
            .map_err(|e| format!("the panel settings could not be read: {e}"))?;
        let panel = store.effective(folder_id).clone();
        let auto = &panel.auto;
        if !auto.is_active() {
            return Err("auto-processing was switched off".to_string());
        }

        let remote = folder_forge_remote_core(&self.db, folder_id)
            .await
            .map_err(error_text)?
            .ok_or("this folder has no recognizable forge remote (origin)")?;
        if !remote.supported {
            return Err(format!(
                "{} is not a host codeg can read — only GitHub, GitLab and Gitea are supported",
                remote.server_host
            ));
        }
        let auth = forge_core::resolve_forge_auth(
            &self.db.conn,
            remote.provider,
            &remote.server_host,
            None,
        )
        .await
        .map_err(|e| error_text(e.into()))?;

        let fingerprint = rules_fingerprint(auto);
        // A sweep under these same rules carries on where it stopped, in its
        // own window; otherwise this scan opens a window of its own. Whole
        // seconds — the precision every forge's "updated since" parameter
        // takes — so the server's cut and the local check below draw the same
        // line.
        let carried = self
            .with_state(folder_id, |state| state.sweep.clone())
            .filter(|sweep| sweep.fingerprint == fingerprint);
        let (since, window_opened_at, from) = match carried {
            Some(sweep) => (sweep.since, sweep.started_at, sweep.cursor),
            None => (
                self.window_start(folder_id, auto, fingerprint)
                    .map(|at| at.trunc_subsecs(0)),
                started_at,
                forge_core::ScanCursor::default(),
            ),
        };
        report.since = since;

        let listing = list_open_items(
            &auth,
            remote.provider,
            &remote.owner_repo,
            auto.issues,
            auto.pull_requests,
            since,
            &from,
        )
        .await
        .map_err(|e| error_text(e.into()))?;
        report.truncated = listing.resume.is_some();
        // The window is asked for server-side, and checked again here: a forge
        // that quietly ignores its "updated since" parameter (an old self-hosted
        // instance) would otherwise hand back every open item, and the window
        // is the one thing standing between switching this on and a board full
        // of the backlog.
        let rows: Vec<ForgeIssueRow> = listing
            .rows
            .into_iter()
            .filter(|row| within_window(row, since))
            .collect();
        report.examined = rows.len();

        let mut matched = Vec::new();
        for row in rows {
            match rules::evaluate(auto, &row) {
                Ok(()) => matched.push(row),
                Err(skip) => *report.skipped.entry(skip).or_default() += 1,
            }
        }
        report.matched = matched.len();

        let mut keyed: Vec<(String, ForgeIssueRow)> = Vec::with_capacity(matched.len());
        for row in matched {
            match source_key_of(&remote, &row) {
                Some(key) => keyed.push((key, row)),
                // Not a key this forge's coordinates can make — nothing could
                // ever be minted for it, so it is a failure, not "handled".
                None => report.failed.push(FailedItem {
                    number: row.number,
                    is_pr: row.is_pr,
                    error: "the item's coordinates do not form a valid source key".to_string(),
                }),
            }
        }
        let keys: Vec<String> = keyed.iter().map(|(key, _)| key.clone()).collect();
        let handled = work_task_service::source_keys_ever_tasked(&self.db.conn, &keys)
            .await
            .map_err(|e| format!("the task board could not be read: {e}"))?;
        let mut fresh: Vec<ForgeIssueRow> = keyed
            .into_iter()
            .filter(|(key, _)| !handled.contains(key))
            .map(|(_, row)| row)
            .collect();
        report.already_handled = keys.len() - fresh.len();
        // Oldest first, issues before changes: the board's order — and with it
        // the launch queue — follows the order the items were filed in.
        fresh.sort_by_key(|row| (row.is_pr, row.number));

        // A failure that could go the other way next time (the network, the
        // database) must not let the window move past its item: the item has
        // no task, and an incremental scan would never read it again unless
        // it happened to be updated. A refusal that will repeat (a fork whose
        // repository cannot be seen) moves on — re-reading it every scan would
        // only re-report it.
        let mut retry_later = false;
        for row in fresh {
            let draft = auto_task_draft(folder_id, &remote, &panel, &row);
            match create_forge_task(
                &self.emitter,
                &self.db,
                draft,
                ForgeTaskOrigin::Auto(trigger),
            )
            .await
            {
                Ok(ForgeCreateResult::Created { task }) => {
                    let (started, start_error) = if auto.auto_start {
                        match start_task(&self.db, task.id).await {
                            Ok(()) => (true, None),
                            Err(e) => (false, Some(e)),
                        }
                    } else {
                        (false, None)
                    };
                    report.created.push(CreatedItem {
                        number: row.number,
                        is_pr: row.is_pr,
                        title: row.title.clone(),
                        task_id: task.id,
                        started,
                        start_error,
                    });
                }
                // Someone — or another folder on the same repository — got
                // there between the check above and here.
                Ok(ForgeCreateResult::Duplicate { .. }) => report.already_handled += 1,
                Ok(ForgeCreateResult::FolderMismatch { .. }) => {
                    return Err("the folder's remote changed during the scan".to_string());
                }
                Err(e) => {
                    retry_later |= is_transient(&e);
                    report.failed.push(FailedItem {
                        number: row.number,
                        is_pr: row.is_pr,
                        error: error_text(e),
                    });
                }
            }
        }

        // Where the next scan reads from. An item that failed for a reason
        // that may not repeat holds everything where it was: the next scan
        // reads these same pages again. A listing cut short by the page budget
        // carries on from its cursor, in the same window. A window read to its
        // end moves on to where this window was opened.
        if !retry_later {
            self.with_state(folder_id, |state| match listing.resume {
                Some(cursor) => {
                    state.sweep = Some(Sweep {
                        fingerprint,
                        since,
                        started_at: window_opened_at,
                        cursor,
                    });
                }
                None => {
                    state.sweep = None;
                    state.watermark = Some((window_opened_at, fingerprint));
                }
            });
        }
        Ok(())
    }

    /// Where this folder's next scan starts reading: the rules' own window,
    /// narrowed to just before the previous complete scan when that scan ran
    /// under these same rules.
    fn window_start(
        &self,
        folder_id: i32,
        auto: &ForgeAutoSettings,
        fingerprint: u64,
    ) -> Option<DateTime<Utc>> {
        let floor = auto
            .picks_up_since()
            .map(|at| at - chrono::Duration::minutes(CLOCK_SKEW_ALLOWANCE_MINUTES));
        let previous = self.with_state(folder_id, |state| state.watermark);
        match previous {
            Some((started, ran_under)) if ran_under == fingerprint => {
                let resume = started - chrono::Duration::minutes(WATERMARK_OVERLAP_MINUTES);
                Some(floor.map_or(resume, |floor| floor.max(resume)))
            }
            _ => floor,
        }
    }

    /// Where auto-processing stands for one folder.
    pub async fn status(&self, folder_id: i32) -> Result<ForgeAutoStatus, String> {
        let store = settings::load(&self.db.conn)
            .await
            .map_err(|e| e.to_string())?;
        let auto = &store.effective(folder_id).auto;
        Ok(self.with_state(folder_id, |state| ForgeAutoStatus {
            available: true,
            scanning: state.scanning,
            last_scan: state.last_report.clone(),
            next_scan_at: (auto.schedule && auto.is_active()).then(|| {
                state.last_started.map_or_else(Utc::now, |started| {
                    started + chrono::Duration::minutes(i64::from(auto.interval_minutes))
                })
            }),
            last_delivery_at: state.last_delivery_at,
        }))
    }

    /// Answer one webhook delivery.
    ///
    /// The order is the security of the route, which no token protects: the
    /// signature is checked against the secrets of the folders that take
    /// deliveries BEFORE anything else happens — before the body is parsed,
    /// and before any git process is spawned to learn a folder's remote — so
    /// an unsigned request costs this machine a few HMACs and nothing more.
    pub async fn handle_webhook(
        self: &Arc<Self>,
        headers: &http::HeaderMap,
        body: &[u8],
    ) -> WebhookOutcome {
        let store = match settings::load(&self.db.conn).await {
            Ok(store) => store,
            Err(e) => {
                tracing::warn!("[forge-auto] webhook: settings unreadable: {e}");
                return WebhookOutcome::new(500, "codeg could not read its settings");
            }
        };
        let folders = match project_folder_ids(&self.db).await {
            Ok(ids) => ids,
            Err(e) => {
                tracing::warn!("[forge-auto] webhook: folder list unreadable: {e}");
                return WebhookOutcome::new(500, "codeg could not read its folders");
            }
        };

        let receivers: Vec<(i32, String)> = folders
            .into_iter()
            .filter_map(|id| {
                let secret = store.effective(id).auto.active_secret()?.to_string();
                Some((id, secret))
            })
            .collect();
        if receivers.is_empty() {
            return WebhookOutcome::new(
                404,
                "no folder in this codeg has webhook auto-processing switched on",
            );
        }
        // One HMAC per distinct secret, however many folders share it.
        let mut verdicts: HashMap<&str, bool> = HashMap::new();
        let accepted: Vec<i32> = receivers
            .iter()
            .filter(|(_, secret)| {
                *verdicts
                    .entry(secret.as_str())
                    .or_insert_with(|| webhook::verify(headers, body, secret))
            })
            .map(|(id, _)| *id)
            .collect();
        if accepted.is_empty() {
            return WebhookOutcome::new(
                401,
                "the signature does not match the secret configured in codeg",
            );
        }

        let (event, kind) = webhook::classify(headers);
        match kind {
            webhook::EventKind::Ping => return WebhookOutcome::new(200, "pong"),
            webhook::EventKind::Other => {
                return WebhookOutcome::new(
                    200,
                    format!("ignored: auto-processing only acts on issue and pull request events, not \"{event}\""),
                )
            }
            webhook::EventKind::WorkItem => {}
        }

        let Ok(payload) = serde_json::from_slice::<serde_json::Value>(body) else {
            return WebhookOutcome::new(400, "the payload is not JSON");
        };
        let Some((host, repo)) = webhook::repository_of(&payload) else {
            return WebhookOutcome::new(400, "the payload names no repository");
        };

        let mut targets = Vec::new();
        for folder_id in accepted {
            let Ok(Some(remote)) = folder_forge_remote_core(&self.db, folder_id).await else {
                continue;
            };
            if remote.server_host == host && forge_core::same_repo(&remote.owner_repo, &repo) {
                targets.push(folder_id);
            }
        }
        if targets.is_empty() {
            return WebhookOutcome::new(
                200,
                format!("ignored: no folder with webhook auto-processing is {host}/{repo}"),
            );
        }

        let now = Utc::now();
        for &folder_id in &targets {
            self.with_state(folder_id, |state| state.last_delivery_at = Some(now));
            self.spawn_scan(folder_id, Trigger::Webhook);
        }
        WebhookOutcome::new(
            202,
            format!("scanning {host}/{repo} in {} folder(s)", targets.len()),
        )
    }
}

/// Open project folders: what the panel's folder picker offers. A folder the
/// user closed stops being processed; a worktree is never its own project.
async fn project_folder_ids(db: &AppDatabase) -> Result<Vec<i32>, String> {
    Ok(folder_service::list_open_folder_details(&db.conn)
        .await
        .map_err(|e| e.to_string())?
        .into_iter()
        .filter(|folder| folder.parent_id.is_none())
        .map(|folder| folder.id)
        .collect())
}

async fn list_open_items(
    auth: &forge_core::ResolvedAuth,
    provider: ForgeProvider,
    owner_repo: &str,
    issues: bool,
    pulls: bool,
    since: Option<DateTime<Utc>>,
    from: &forge_core::ScanCursor,
) -> Result<OpenItemsScan, forge_core::ForgeError> {
    match provider {
        ForgeProvider::GitHub => {
            forge_core::github::list_open_items(auth, owner_repo, issues, pulls, since, from).await
        }
        ForgeProvider::GitLab => {
            forge_core::gitlab::list_open_items(auth, owner_repo, issues, pulls, since, from).await
        }
        ForgeProvider::Gitea => {
            forge_core::gitea::list_open_items(auth, owner_repo, issues, pulls, since, from).await
        }
    }
}

/// The task an item gets — exactly what the trigger dialog would send for it,
/// with the auto-processing choices in the dialog's seats.
fn auto_task_draft(
    folder_id: i32,
    remote: &ForgeRemote,
    panel: &ForgePanelSettings,
    row: &ForgeIssueRow,
) -> ForgeTaskDraft {
    let auto = &panel.auto;
    let configured = if row.is_pr {
        auto.pr_scenario.as_deref()
    } else {
        auto.issue_scenario.as_deref()
    };
    ForgeTaskDraft {
        folder_id,
        source: ForgeTaskSourceInput {
            kind: if row.is_pr { "pr" } else { "issue" }.to_string(),
            provider: remote.provider.as_str().to_string(),
            server_host: remote.server_host.clone(),
            // The folder's default account for the host — the one the scan
            // itself just read with.
            account_id: None,
            owner_repo: remote.owner_repo.clone(),
            number: row.number,
        },
        snapshot: ForgeSnapshot {
            title: row.title.clone(),
            body: row.body.clone(),
            labels: row.labels.iter().map(|label| label.name.clone()).collect(),
            author: row.author.clone(),
        },
        scenario: Some(auto_scenario(configured, row.is_pr).to_string()),
        instruction: None,
        // Always explicit: a stored `None` would read as "an older row that
        // never had the choice", and this one had it — in the settings.
        writeback: Some(auto.writeback),
        agent_type: None,
        force: false,
    }
}

/// Whether a listed row falls inside the scan window. A row whose `updated_at`
/// is missing or unreadable is kept — the forge listed it for this window, and
/// dropping it would lose an item over a timestamp format.
fn within_window(row: &ForgeIssueRow, since: Option<DateTime<Utc>>) -> bool {
    let Some(since) = since else {
        return true;
    };
    row.updated_at
        .as_deref()
        .and_then(|at| DateTime::parse_from_rfc3339(at).ok())
        .is_none_or(|updated| updated.with_timezone(&Utc) >= since)
}

fn source_key_of(remote: &ForgeRemote, row: &ForgeIssueRow) -> Option<String> {
    forge_core::source_key(
        remote.provider.as_str(),
        &remote.server_host,
        &remote.owner_repo,
        if row.is_pr { "pr" } else { "issue" },
        row.number,
    )
    .ok()
}

/// Queue a freshly minted task — the same claim the board's Start makes, so
/// the folder's concurrency limit decides when it actually launches.
///
/// A task the board's own auto-processing claimed first (the create path
/// nudges its pump) is already on its way, and that is a success: the claim
/// lost the race, the task did not.
async fn start_task(db: &AppDatabase, task_id: i32) -> Result<(), String> {
    let engine = crate::work_task::engine().ok_or("the task engine is not running")?;
    match engine.start(task_id).await {
        Ok(()) => Ok(()),
        Err(error) => match work_task_service::get_model(&db.conn, task_id).await {
            Ok(task) if task.status != crate::models::WorkTaskStatus::Todo => Ok(()),
            _ => Err(error),
        },
    }
}

/// Whether a failed mint could succeed on a later try — a network or
/// database hiccup — as opposed to a refusal that will repeat.
fn is_transient(error: &AppCommandError) -> bool {
    use crate::app_error::AppErrorCode as C;
    !matches!(
        error.code,
        C::InvalidInput
            | C::NotFound
            | C::AlreadyExists
            | C::ConfigurationMissing
            | C::ConfigurationInvalid
            | C::PermissionDenied
            | C::NotAGitRepository
    )
}

/// One folder's scan slot, released on drop while still `armed` — the
/// abnormal-exit path of `AutoProcessor::scan`. Disarmed by the normal
/// release, which must not be undone: by the time this drops, another trigger
/// may already hold the slot again.
struct ScanSlot<'a> {
    processor: &'a AutoProcessor,
    folder_id: i32,
    armed: bool,
}

impl Drop for ScanSlot<'_> {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }
        self.processor.with_state(self.folder_id, |state| {
            state.scanning = false;
            state.rerun = None;
        });
    }
}

/// A fingerprint of the rules a scan ran under. Any edit to the auto block
/// changes it — including switching it off and on, which re-stamps
/// `enabled_at` — and a changed fingerprint restarts the window (see
/// `FolderState::watermark`).
fn rules_fingerprint(auto: &ForgeAutoSettings) -> u64 {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    serde_json::to_string(auto)
        .unwrap_or_default()
        .hash(&mut hasher);
    hasher.finish()
}

fn error_text(error: AppCommandError) -> String {
    match error.detail.as_deref() {
        Some(detail) if !detail.is_empty() => format!("{} ({detail})", error.message),
        _ => error.message,
    }
}

#[cfg(test)]
mod tests;
