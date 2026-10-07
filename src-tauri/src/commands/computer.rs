//! Computer use on the desktop: the service that owns the helper and the
//! window table, the agent-facing reads behind the `computer_*` tools, and
//! the commands behind codeg's own Computer use panel.
//!
//! Every agent read goes through the same five steps, in this order, because
//! a read cannot be taken back:
//!
//! 1. **Switch.** The group is on (re-read now, not at injection).
//! 2. **Grant.** The window is one codeg named, it is shared, the grant has
//!    not lapsed, and its application is not (or no longer) blocklisted.
//! 3. **Identity.** The process that owned the window when it was shared is
//!    still the one running under that pid — a relaunched application is a
//!    different process whose windows nobody shared. Asked of the kernel by
//!    codeg itself (a process's start time is not TCC-governed), not of the
//!    helper.
//! 4. **Read, then check again.** The helper reads; then everything above is
//!    checked once more — no Stop since, the grant under the same epoch, the
//!    switch (not switched off, not even off and on again, while the read was
//!    in flight), the blocklist as it is now, and the identity — because the
//!    person may have taken the window back while the read was in flight, and
//!    the read holds exactly what they took back.
//! 5. **Audit.** Every attempt — done, refused or failed — leaves a line on
//!    the panel's activity list.
//!
//! An action goes through the same steps with one difference: it cannot be
//! withheld once done, so everything is checked before it goes out and
//! nothing after. The grant must be for control; the keys must stay inside
//! the window; every ref and point is resolved against what the agent last
//! read of the window (`targets::TargetTable::begin_act`); the helper checks
//! again at the moment of delivery what only it can see.
//!
//! **One driver call at a time, in codeg.** The driver answers one call at a
//! time anyway; the queue is kept here so that an action's checks run when its
//! turn has come, not before it waited behind a twenty-second snapshot —
//! time in which the person could have taken the window back.
//!
//! **Stop.** The person's Stop ends every grant and has the helper kill the
//! driver mid-action; every call already under way answers
//! `computer_stopped`, and no action let through before it goes out after it
//! (Stops are counted, and an action carries the count all the way to the
//! helper). It does not wait for the queue, and it leaves nothing behind:
//! what the person shares next is shared as usual.
//!
//! Sharing and unsharing are Tauri commands only. There is no HTTP face for
//! them: deciding what of this screen an agent may see is for the person at
//! this screen.

use std::collections::BTreeSet;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
#[cfg(feature = "tauri-runtime")]
use tauri::{AppHandle, Manager};

use crate::acp::computer_tools::{
    app_grant_required_note, background_next_step, blocked_note, chord_beyond_note,
    control_required_note, cut_away_note, grant_required_note, no_pointing_note, no_such_ref_note,
    no_such_target_note, not_actionable_note, permission_missing_note, reshared_note,
    stale_capture_note, stale_snapshot_note, ClipboardOp, ComputerActOutcome, ComputerAppsOutcome,
    ComputerCaptureOutcome, ComputerClipboardOutcome, ComputerLaunchOutcome,
    ComputerSnapshotOutcome, ComputerToolAccess, ComputerToolsConfig, ComputerToolsRuntimeConfig,
    ComputerVerifyOutcome, ComputerWindowsOutcome, InputPolicy, SnapshotRequest, BAD_FRAME_NOTE,
    CLIPBOARD_NOT_YOURS_NOTE, CLIPBOARD_OFF_NOTE, CLIPBOARD_WRITTEN_NOTE, DEFAULT_MAX_DIMENSION,
    DEFAULT_SNAPSHOT_MAX_CHARS, DESKTOP_CHORD_NOTE, DOUBLE_CLICK_MODIFIERS_NOTE,
    DRAG_MODIFIERS_NOTE, ERROR_ACTION_FAILED, ERROR_BACKGROUND_UNAVAILABLE, ERROR_BLOCKED,
    ERROR_CONTROL_REQUIRED, ERROR_FOREGROUND_NOT_ALLOWED, ERROR_GRANT_REQUIRED,
    ERROR_NO_SUCH_TARGET, ERROR_OCCLUDED, ERROR_OUT_OF_TARGET, ERROR_PAUSED,
    ERROR_PERMISSION_MISSING, ERROR_READ_FAILED, ERROR_STALE_REF, ERROR_STOPPED, ERROR_UNAVAILABLE,
    FOREGROUND_NOT_ALLOWED_NOTE, LAUNCHED_NOTE, LAUNCH_OFF_NOTE, MENUS_UNAVAILABLE_NOTE,
    MENU_NEEDS_FRONT_NOTE, NEEDS_ELEMENT_NOTE, NO_DESKTOP_NOTE, OUT_OF_IMAGE_NOTE, PASTE_NOTE,
    RESTORE_NEEDS_FRONT_NOTE, SCREEN_CONTROL_REQUIRED_NOTE, SCREEN_GRANT_REQUIRED_NOTE,
    SCREEN_NEEDS_FRONT_NOTE, SCREEN_NOT_BACKGROUND_NOTE, SCREEN_POINTER_ONLY_NOTE,
    SCREEN_RULES_CHANGED_NOTE, SCREEN_STALE_CAPTURE_NOTE, SECRET_FIELD_NOTE, SESSION_CHORD_NOTE,
    STOPPED_NOTE,
};
use crate::app_error::AppCommandError;
use crate::computer::agent::{
    grantable, visible_title, ActivityOutcome, Blocklist, ComputerAction, ComputerActivityPayload,
    ComputerGrantPayload, GrantChange, GrantLevel, GrantScope, NotGrantable, SelfIdentity,
};
use crate::computer::backend::{
    ActRefusal, BackendError, BackendStatus, ComputerBackend, SnapshotOptions,
};
use crate::computer::driver_admin::{DriverAdmin, DriverInfo, DriverTask};
use crate::computer::events::ComputerEvents;
#[cfg(feature = "tauri-runtime")]
use crate::computer::indicator::{Indicator, Strip};
use crate::computer::local::LocalBackend;
#[cfg(feature = "tauri-runtime")]
use crate::computer::marker::Marker;
use crate::computer::procinfo::process_start;
use crate::computer::protocol::{
    ClipboardUse, OsPermission, PermissionAsked, PermissionReport, RawAct, ScreenRules,
};
#[cfg(feature = "tauri-runtime")]
use crate::computer::stop_key::StopKey;
use crate::computer::stop_shortcut::StopKeyStatus;
use crate::computer::targets::{
    ActDenied, Aim, AppChange, AppTarget, ReadMark, ReadRefusal, ReadTicket, ShareError, SharedApp,
    SharedScreen, SharedWindow, Staleness, TargetTable, WindowIdentity, SCREEN_TARGET_ID,
};
use crate::computer::types::{
    ActDelivery, ActReport, AgentAppRef, AgentAppSummary, AgentScreen, ComputerActRequest, Rect,
    VerifyOutcome, VerifyRequest, WindowCapture, WindowSnapshot, MAX_HOLD_MS, MAX_KEY_REPEAT,
};
use crate::web::event_bridge::{EventEmitter, WebEventBroadcaster};

/// How often lapsed grants are swept, so the panel shows a window as no
/// longer shared when its time runs out rather than at the next read.
const EXPIRY_SWEEP: Duration = Duration::from_secs(30);

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
        .unwrap_or(0)
}

/// What codeg knows about its own TCC standing (macOS only). Shown to the
/// person, never acted on: a permission codeg itself holds is one every
/// agent's shell holds too, outside anything computer use decides — refusing
/// to run would not take it back.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodegTccStatus {
    pub accessibility: bool,
    pub screen_recording: bool,
    /// Whether codeg is its own responsible process. When it is not (a
    /// development build run from a terminal), the two flags above are the
    /// terminal's, which every process in that terminal already has.
    pub self_responsible: bool,
}

impl CodegTccStatus {
    /// codeg itself has been granted a permission that every agent's shell
    /// inherits.
    pub fn is_leaking(&self) -> bool {
        self.self_responsible && (self.accessibility || self.screen_recording)
    }
}

#[cfg(target_os = "macos")]
fn codeg_tcc() -> Option<CodegTccStatus> {
    use crate::computer::tcc;
    let me = std::process::id();
    Some(CodegTccStatus {
        accessibility: tcc::accessibility_granted(),
        screen_recording: tcc::screen_recording_granted(),
        self_responsible: tcc::responsible_pid(me) == Some(me),
    })
}

#[cfg(not(target_os = "macos"))]
fn codeg_tcc() -> Option<CodegTccStatus> {
    None
}

/// Cut `tree` to at most `max_chars` characters, on a line boundary. `0` is
/// no cap. Returns the tree and whether anything was cut.
fn cut_tree(tree: &str, max_chars: usize) -> (String, bool) {
    if max_chars == 0 || tree.chars().count() <= max_chars {
        return (tree.to_string(), false);
    }
    let mut out = String::new();
    let mut used = 0usize;
    for line in tree.split_inclusive('\n') {
        let len = line.chars().count();
        if used + len > max_chars {
            break;
        }
        out.push_str(line);
        used += len;
    }
    (out, true)
}

/// A refusal before or during a read, as the slug and the words.
struct Refusal {
    slug: &'static str,
    note: String,
    /// What the activity line records.
    outcome: ActivityOutcome,
    /// An action that failed after it was sent: it may have happened.
    maybe_done: bool,
}

impl Refusal {
    fn refused(slug: &'static str, note: String) -> Self {
        Self {
            slug,
            note,
            outcome: ActivityOutcome::Refused,
            maybe_done: false,
        }
    }

    fn failed(slug: &'static str, note: String) -> Self {
        Self {
            slug,
            note,
            outcome: ActivityOutcome::Failed,
            maybe_done: false,
        }
    }

    fn maybe_done(self) -> Self {
        Self {
            maybe_done: true,
            ..self
        }
    }
}

/// An action the helper refused, or that did not happen, in the helper's
/// words (which say what to do next).
fn refused_act(kind: ActRefusal, words: String) -> Refusal {
    match kind {
        ActRefusal::Paused => Refusal::refused(
            ERROR_PAUSED,
            format!("{words} Nothing reaches any window until then; try again later."),
        ),
        ActRefusal::Stopped => stopped(),
        ActRefusal::StaleRef => Refusal::failed(ERROR_STALE_REF, words),
        ActRefusal::OutOfTarget => Refusal::failed(ERROR_OUT_OF_TARGET, words),
        ActRefusal::Occluded => Refusal::failed(ERROR_OCCLUDED, words),
        ActRefusal::BackgroundUnavailable => Refusal::failed(ERROR_BACKGROUND_UNAVAILABLE, words),
        ActRefusal::SecretField => Refusal::refused(ERROR_BLOCKED, words),
        ActRefusal::Failed => Refusal::failed(ERROR_ACTION_FAILED, words),
        ActRefusal::Paste => Refusal::refused(ERROR_GRANT_REQUIRED, words),
        ActRefusal::Beyond => Refusal::refused(ERROR_CONTROL_REQUIRED, words),
        ActRefusal::Revoked => Refusal::refused(ERROR_GRANT_REQUIRED, words),
    }
}

/// A call the person's Stop cut off.
fn stopped() -> Refusal {
    Refusal::refused(ERROR_STOPPED, STOPPED_NOTE.to_string())
}

/// How an action is to reach its window: as the agent asked, or as the
/// person set it when it did not ask — the front only where they allow it,
/// and only for an action that can be delivered there at all (see
/// [`ComputerActRequest::can_come_forward`]).
fn delivery_for(
    request: &ComputerActRequest,
    requested: Option<ActDelivery>,
    config: &ComputerToolsConfig,
) -> Result<ActDelivery, Refusal> {
    delivery_on(
        request,
        requested,
        config,
        crate::computer::keys::Platform::current(),
    )
}

/// [`delivery_for`] on `platform`: an action that can be done there only at
/// the front (see [`ComputerActRequest::needs_front`]) goes there where the
/// person allows it, and not at all where they do not.
fn delivery_on(
    request: &ComputerActRequest,
    requested: Option<ActDelivery>,
    config: &ComputerToolsConfig,
    platform: crate::computer::keys::Platform,
) -> Result<ActDelivery, Refusal> {
    if request.needs_front(platform) {
        let note = match request {
            ComputerActRequest::InvokeMenu { .. } => MENU_NEEDS_FRONT_NOTE,
            _ => RESTORE_NEEDS_FRONT_NOTE,
        };
        return if config.allow_foreground {
            Ok(ActDelivery::Foreground)
        } else {
            Err(Refusal::refused(
                ERROR_FOREGROUND_NOT_ALLOWED,
                note.to_string(),
            ))
        };
    }
    if !request.can_come_forward() {
        return Ok(ActDelivery::Background);
    }
    match requested.unwrap_or_else(|| config.default_delivery_in_force()) {
        ActDelivery::Foreground if !config.allow_foreground => Err(Refusal::refused(
            ERROR_FOREGROUND_NOT_ALLOWED,
            FOREGROUND_NOT_ALLOWED_NOTE.to_string(),
        )),
        delivery => Ok(delivery),
    }
}

/// An action the application would not take in the background, ended with
/// what the person's settings leave the agent to try next: the front, or
/// asking them for it — for an action that can come to the front at all.
/// The helper's words say what happened; only codeg knows the settings.
fn with_next_step(
    refusal: Refusal,
    request: &ComputerActRequest,
    config: &ComputerToolsConfig,
) -> Refusal {
    if refusal.slug != ERROR_BACKGROUND_UNAVAILABLE || !request.can_come_forward() {
        return refusal;
    }
    Refusal {
        note: format!(
            "{} {}",
            refusal.note,
            background_next_step(config.allow_foreground)
        ),
        ..refusal
    }
}

/// An action refused before anything was sent, in words.
fn denied(target_id: &str, why: ActDenied) -> Refusal {
    match why {
        ActDenied::NoSuchTarget => {
            Refusal::refused(ERROR_NO_SUCH_TARGET, no_such_target_note(target_id))
        }
        ActDenied::GrantRequired => {
            Refusal::refused(ERROR_GRANT_REQUIRED, grant_required_note(target_id))
        }
        ActDenied::ControlRequired => {
            Refusal::refused(ERROR_CONTROL_REQUIRED, control_required_note(target_id))
        }
        ActDenied::NotGrantable(why) => {
            Refusal::refused(ERROR_BLOCKED, blocked_note(target_id, why.note()))
        }
        ActDenied::Stale(staleness) => Refusal::failed(
            ERROR_STALE_REF,
            match staleness {
                Staleness::NoSnapshot | Staleness::OldSnapshot => stale_snapshot_note(target_id),
                Staleness::NotActionable => not_actionable_note(target_id),
                Staleness::CutAway(index) => cut_away_note(index),
                Staleness::NoSuchRef(index) => no_such_ref_note(target_id, index),
                Staleness::NoCapture | Staleness::OldCapture => stale_capture_note(target_id),
            },
        ),
        ActDenied::OutOfImage => Refusal::failed(ERROR_OUT_OF_TARGET, OUT_OF_IMAGE_NOTE.into()),
        ActDenied::Secret => Refusal::refused(ERROR_BLOCKED, SECRET_FIELD_NOTE.into()),
        ActDenied::ChordBeyond => Refusal::refused(ERROR_CONTROL_REQUIRED, chord_beyond_note()),
        // The source of what is on the clipboard is what a paste would need
        // a grant for; codeg does not know it.
        ActDenied::Paste => Refusal::refused(ERROR_GRANT_REQUIRED, PASTE_NOTE.into()),
        ActDenied::NeedsElement => Refusal::failed(ERROR_ACTION_FAILED, NEEDS_ELEMENT_NOTE.into()),
        ActDenied::NoPointing => Refusal::failed(ERROR_ACTION_FAILED, no_pointing_note(target_id)),
        ActDenied::DragModifiers => {
            Refusal::failed(ERROR_ACTION_FAILED, DRAG_MODIFIERS_NOTE.into())
        }
        ActDenied::DoubleClickModifiers => {
            Refusal::failed(ERROR_ACTION_FAILED, DOUBLE_CLICK_MODIFIERS_NOTE.into())
        }
        ActDenied::DesktopChord => {
            Refusal::refused(ERROR_CONTROL_REQUIRED, DESKTOP_CHORD_NOTE.into())
        }
        ActDenied::AppGrantRequired => {
            Refusal::refused(ERROR_CONTROL_REQUIRED, app_grant_required_note(target_id))
        }
        ActDenied::MenusUnavailable => {
            Refusal::failed(ERROR_ACTION_FAILED, MENUS_UNAVAILABLE_NOTE.into())
        }
        ActDenied::BadFrame => Refusal::failed(ERROR_ACTION_FAILED, BAD_FRAME_NOTE.into()),
        ActDenied::SessionChord => {
            Refusal::refused(ERROR_CONTROL_REQUIRED, SESSION_CHORD_NOTE.into())
        }
        ActDenied::ScreenPointerOnly => {
            Refusal::failed(ERROR_ACTION_FAILED, SCREEN_POINTER_ONLY_NOTE.into())
        }
    }
}

/// An action on the entire screen refused before anything was sent, in
/// words about the screen.
fn screen_denied(why: ActDenied) -> Refusal {
    match why {
        ActDenied::GrantRequired | ActDenied::NoSuchTarget => {
            Refusal::refused(ERROR_GRANT_REQUIRED, SCREEN_GRANT_REQUIRED_NOTE.into())
        }
        ActDenied::ControlRequired => {
            Refusal::refused(ERROR_CONTROL_REQUIRED, SCREEN_CONTROL_REQUIRED_NOTE.into())
        }
        ActDenied::Stale(_) => Refusal::failed(ERROR_STALE_REF, SCREEN_STALE_CAPTURE_NOTE.into()),
        other => denied(SCREEN_TARGET_ID, other),
    }
}

fn permission_name(permission: OsPermission) -> &'static str {
    match permission {
        OsPermission::Accessibility => "Accessibility",
        OsPermission::ScreenRecording => "Screen Recording",
    }
}

/// A window or an application asked to change while the entire screen is
/// shared.
fn screen_shared_error() -> AppCommandError {
    AppCommandError::configuration_invalid(
        "the entire screen is shared, which every window is shared with; change the screen's \
         sharing instead",
    )
}

/// The blocklist the settings `config` make: the defaults less those taken
/// off, plus the user's own.
fn blocklist_of(config: &ComputerToolsConfig) -> Blocklist {
    Blocklist::configured(&config.blocklist, &config.blocklist_removed)
}

/// What a share is decided by: see `ComputerService::policy`.
struct SharingPolicy {
    enabled: bool,
    /// The entire screen may be shared.
    screen_enabled: bool,
    blocklist: Blocklist,
}

impl SharingPolicy {
    fn of(config: &ComputerToolsConfig) -> Self {
        Self {
            enabled: config.enabled,
            screen_enabled: config.screen_enabled,
            blocklist: blocklist_of(config),
        }
    }
}

/// A read that passed steps 1–3, and what step 4 checks it against.
struct Admitted {
    ticket: ReadTicket,
    /// The switch-off count when the read was admitted.
    switched_off: u64,
    /// The Stop count when the read was admitted.
    stop: u64,
}

/// The computer-use service: one per process — the desktop app's, managed as
/// Tauri state, or codeg-server's where it is let share the screen it runs
/// on (`CODEG_COMPUTER_USE`).
pub struct ComputerService {
    /// Where what changes is told (see `computer::events`).
    events: ComputerEvents,
    /// Where a settings change the service makes itself is told — removing
    /// the driver switches computer use off.
    settings_events: EventEmitter,
    /// What only the desktop app has; `None` in codeg-server.
    #[cfg(feature = "tauri-runtime")]
    desktop: Option<DesktopUi>,
    backend: Arc<LocalBackend>,
    targets: TargetTable,
    config: ComputerToolsRuntimeConfig,
    me: SelfIdentity,
    /// Held for every call that reaches the driver. See the module note.
    turn: tokio::sync::Mutex<()>,
    /// How many times the person has pressed Stop. Whatever began before
    /// the latest one — a share, a read, an action — is refused when it
    /// finds the count moved; whatever begins after it goes on as usual.
    stops: AtomicU64,
    /// Held across "has a Stop come since this share began?" and the share
    /// that follows, and across a Stop's count and the revocation that
    /// follows — so a share begun before a Stop cannot slip in between the
    /// two and outlive it. The same holds for a settings change and what it
    /// takes away: see `policy`.
    grant_gate: std::sync::Mutex<()>,
    /// The switch and the blocklist as the last settings change left them,
    /// written under `grant_gate` by the change hook, which revokes under it
    /// too. A share decides by these, under the same lock: it lands either
    /// before a switch-off (and is revoked with the rest) or after it (and is
    /// refused) — never after the revocation and still standing.
    policy: std::sync::Mutex<SharingPolicy>,
    /// Whether the person wants the strip at all (Settings), as the last
    /// settings change the service followed left it.
    strip_wanted: AtomicBool,
    /// Held across reading the state and telling everyone of it, so two
    /// changes told at once are told in the order they were read — the
    /// older never lands last.
    state_gate: std::sync::Mutex<()>,
    /// The driver as Settings manages it.
    drivers: Arc<DriverAdmin>,
    /// What an agent last put on the clipboard itself (see
    /// [`OwnedClipboard`]); cleared by Stop.
    clipboard: std::sync::Mutex<Option<OwnedClipboard>>,
}

/// What the desktop app adds to computer use: the stop shortcut, held with
/// the OS while computer use is on; the strip above every window while
/// anything is shared; and the mark an action leaves where it landed.
/// codeg-server has none of them — its Stop is in its web clients' panel.
#[cfg(feature = "tauri-runtime")]
struct DesktopUi {
    app: AppHandle,
    stop_key: StopKey,
    indicator: Indicator,
    marker: Marker,
}

/// Where a computer-use service runs.
pub enum ComputerHost {
    /// The desktop app: its own webviews are told, and it has the strip, the
    /// marker and the stop shortcut.
    #[cfg(feature = "tauri-runtime")]
    Desktop(AppHandle),
    /// codeg-server, let share the screen it runs on: its web clients are
    /// told, through `broadcaster`; `emitter` is where it tells of settings.
    Server {
        broadcaster: Arc<WebEventBroadcaster>,
        emitter: EventEmitter,
    },
}

/// Run `task` on the runtime codeg runs on: Tauri's in the desktop app,
/// which starts the service before any task of its own runs; the process's
/// own in codeg-server.
fn spawn_task(task: impl std::future::Future<Output = ()> + Send + 'static) {
    #[cfg(feature = "tauri-runtime")]
    tauri::async_runtime::spawn(task);
    #[cfg(not(feature = "tauri-runtime"))]
    tokio::spawn(task);
}

/// What an agent last put on the clipboard itself, as the clipboard was
/// stamped then: copied out of a window it may read (`source`, the window and
/// the sharing it was copied under), or written with computer_clipboard_write
/// (no source). It may be pasted, or read back, only while the clipboard is
/// still that — and, for a copy, while its window is still shared so.
#[derive(Debug, Clone, PartialEq, Eq)]
struct OwnedClipboard {
    stamp: u64,
    source: Option<(String, u64)>,
}

/// Whether an action could paste, and so needs the clipboard checked: a
/// paste key, a menu command, or a press of a named element — which may be
/// a control that pastes.
fn may_paste(request: &ComputerActRequest) -> bool {
    use crate::computer::keys::{classify, ChordClass, Platform};
    match request {
        ComputerActRequest::Key { chord, target, .. }
        | ComputerActRequest::HoldKey { chord, target, .. } => {
            target.is_some() || classify(chord, Platform::current()) == ChordClass::Paste
        }
        ComputerActRequest::InvokeMenu { .. } => true,
        ComputerActRequest::Click { target, .. } => {
            matches!(target, crate::computer::types::AgentTarget::Element(_))
        }
        _ => false,
    }
}

/// Applications that only show every window at once — never-shared ones
/// included, drawn by the system where codeg cannot paint them over — which
/// are never started for an agent: macOS's Mission Control.
const SHOWS_EVERY_WINDOW: &[&str] = &["com.apple.exposelauncher"];

/// The most text one `computer_clipboard_write` puts on the clipboard.
const MAX_CLIPBOARD_WRITE_CHARS: usize = 100_000;

/// Whether an action copies: a key that copies or cuts, or a menu command
/// named for it — whatever it puts on the clipboard comes from the window,
/// or the application shared as a whole, it was done in.
fn copies(request: &ComputerActRequest) -> bool {
    match request {
        ComputerActRequest::Key { chord, .. } | ComputerActRequest::HoldKey { chord, .. } => {
            crate::computer::keys::copies(chord, crate::computer::keys::Platform::current())
        }
        ComputerActRequest::InvokeMenu { path } => path
            .iter()
            .any(|title| crate::computer::keys::names_copy(title)),
        _ => false,
    }
}

impl ComputerService {
    /// Build the service and start its duties: following the settings
    /// (switching off ends every grant and stops the helper; a longer
    /// blocklist or a shorter timeout ends what they now forbid), and ending
    /// grants whose time runs out.
    pub fn start(host: ComputerHost, config: ComputerToolsRuntimeConfig) -> Arc<Self> {
        let (events, settings_events) = match &host {
            #[cfg(feature = "tauri-runtime")]
            ComputerHost::Desktop(app) => (
                ComputerEvents::Desktop(app.clone()),
                EventEmitter::Tauri(app.clone()),
            ),
            ComputerHost::Server {
                broadcaster,
                emitter,
            } => (ComputerEvents::Web(broadcaster.clone()), emitter.clone()),
        };
        let status_events = events.clone();
        let drivers = Arc::new(DriverAdmin::new(events.clone()));
        let status_drivers = drivers.clone();
        let backend = Arc::new(
            LocalBackend::new(move |status: &BackendStatus| {
                status_events.backend_status(status);
                status_drivers.backend_moved(status);
            })
            .with_switch(config.clone()),
        );
        #[cfg(feature = "tauri-runtime")]
        let desktop = match host {
            ComputerHost::Desktop(app) => Some(DesktopUi {
                stop_key: StopKey::new(),
                indicator: Indicator::start(app.clone()),
                marker: Marker::start(app.clone()),
                app,
            }),
            ComputerHost::Server { .. } => None,
        };
        let (policy, strip_wanted) = {
            let settings = config.subscribe();
            let settings = settings.borrow();
            (SharingPolicy::of(&settings), settings.show_indicator)
        };
        config.mark_served();
        let service = Arc::new(Self {
            events,
            settings_events,
            #[cfg(feature = "tauri-runtime")]
            desktop,
            backend,
            targets: TargetTable::new(),
            config: config.clone(),
            me: SelfIdentity::current(),
            turn: tokio::sync::Mutex::new(()),
            stops: AtomicU64::new(0),
            grant_gate: std::sync::Mutex::new(()),
            policy: std::sync::Mutex::new(policy),
            strip_wanted: AtomicBool::new(strip_wanted),
            state_gate: std::sync::Mutex::new(()),
            drivers,
            clipboard: std::sync::Mutex::new(None),
        });

        // What a change takes away is taken before the write that made it
        // returns (see `ComputerToolsRuntimeConfig::on_change`).
        let hook = Arc::downgrade(&service);
        config.on_change(move |before, after| {
            if let Some(service) = hook.upgrade() {
                service.policy_changed(before, after);
            }
        });

        let watcher = Arc::downgrade(&service);
        let mut changes = config.subscribe();
        spawn_task(async move {
            // The settings as they stand, then every change to them. A watch
            // channel keeps only the latest value, so an off-and-on-again is
            // told apart by the switch-off count, not by `enabled`.
            let mut seen = changes.borrow_and_update().clone();
            if let Some(service) = watcher.upgrade() {
                service.follow(&seen, false).await;
            }
            while changes.changed().await.is_ok() {
                let next = changes.borrow_and_update().clone();
                let Some(service) = watcher.upgrade() else {
                    break;
                };
                service
                    .follow(&next, next.switched_off != seen.switched_off)
                    .await;
                seen = next;
            }
        });

        let sweeper = Arc::downgrade(&service);
        spawn_task(async move {
            let mut tick = tokio::time::interval(EXPIRY_SWEEP);
            loop {
                tick.tick().await;
                let Some(service) = sweeper.upgrade() else {
                    break;
                };
                service.sweep().await;
            }
        });
        service
    }

    /// The settings just changed, from `before` to `after`: end the grants
    /// the change takes away. Runs inside the write, once per change, so an
    /// entry added to the blocklist and taken off again straight after still
    /// ended the grants it named, and no read admitted after the write can
    /// use a grant the write ended.
    fn policy_changed(&self, before: &ComputerToolsConfig, after: &ComputerToolsConfig) {
        let ended = {
            let _gate = self.grant_gate.lock().unwrap_or_else(|p| p.into_inner());
            *self.policy.lock().unwrap_or_else(|p| p.into_inner()) = SharingPolicy::of(after);
            if before.enabled && !after.enabled {
                self.targets.revoke_all(GrantChange::Disabled)
            } else {
                let mut ended =
                    self.targets
                        .sweep(now_ms(), after.grant_ttl, &self.me, &blocklist_of(after));
                // The entire screen is shared only while its switch is on.
                if !after.screen_enabled {
                    ended.absorb(self.targets.end_screen_share(GrantChange::Disabled));
                }
                ended
            }
        };
        self.announce_change(ended);
    }

    /// Bring the helper and the stop shortcut in line with `config`.
    /// `went_off`: the switch was off at some point since the last call, even
    /// if it is on again now — the helper (and the driver under it) stops,
    /// and is not started again while the switch is off.
    async fn follow(self: &Arc<Self>, config: &ComputerToolsConfig, went_off: bool) {
        self.follow_stop_key(config);
        self.follow_strip(config.show_indicator);
        if went_off || !config.enabled {
            self.backend.close().await;
        }
        if config.enabled {
            self.backend.open().await;
        }
    }

    /// Hold the chosen stop shortcut with the OS while computer use is on —
    /// off, there is nothing for it to stop, and it would only take the keys
    /// from every other application.
    fn follow_stop_key(self: &Arc<Self>, config: &ComputerToolsConfig) {
        #[cfg(feature = "tauri-runtime")]
        if let Some(desktop) = &self.desktop {
            let wanted = config
                .enabled
                .then_some(config.stop_shortcut.as_ref())
                .flatten();
            let service = Arc::downgrade(self);
            let on_press = move || {
                if let Some(service) = service.upgrade() {
                    spawn_task(async move { service.stop().await });
                }
            };
            if let Some(status) = desktop.stop_key.sync(&desktop.app, wanted, on_press) {
                self.events.stop_key(&status);
            }
        }
        #[cfg(not(feature = "tauri-runtime"))]
        let _ = config;
    }

    /// Put the strip up or down for the person's choice in Settings — the
    /// sharing it follows is unchanged.
    fn follow_strip(&self, wanted: bool) {
        let _told = self.state_gate.lock().unwrap_or_else(|p| p.into_inner());
        self.strip_wanted.store(wanted, Ordering::Release);
        #[cfg(feature = "tauri-runtime")]
        if let Some(desktop) = &self.desktop {
            let shared = !self.targets.shared().is_empty()
                || !self.targets.shared_apps().is_empty()
                || self.targets.shared_screen().is_some();
            desktop.indicator.set(Strip::of(shared, wanted));
        }
    }

    pub fn stop_key_status(&self) -> StopKeyStatus {
        #[cfg(feature = "tauri-runtime")]
        if let Some(desktop) = &self.desktop {
            return desktop.stop_key.status();
        }
        StopKeyStatus::default()
    }

    /// The stamp of what an agent last put on the clipboard itself, while
    /// that may still be pasted or read back: written by an agent, or copied
    /// out of a window still shared for reading under the sharing it was
    /// copied under. Whether the clipboard still holds it the helper checks.
    fn owned_clipboard(&self) -> Option<u64> {
        let owned = self
            .clipboard
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clone()?;
        if let Some((target_id, epoch)) = &owned.source {
            let entry = self.targets.get(target_id)?;
            let readable = entry
                .grant
                .as_ref()
                .is_some_and(|g| g.level.allows(GrantLevel::Read));
            if entry.epoch != *epoch || !readable {
                return None;
            }
        }
        Some(owned.stamp)
    }

    /// Hold `owned` as what an agent put on the clipboard — unless a Stop
    /// has come since `stop`: decided under the lock a Stop clears it under,
    /// so a reply that lands after a Stop never brings back what it cleared.
    fn own_clipboard(&self, owned: OwnedClipboard, stop: u64) -> bool {
        let _gate = self.grant_gate.lock().unwrap_or_else(|p| p.into_inner());
        if self.stopped_since(stop) {
            return false;
        }
        *self.clipboard.lock().unwrap_or_else(|p| p.into_inner()) = Some(owned);
        true
    }

    /// What is shared now: every window, the applications shared as a
    /// whole, and the entire screen when it is.
    fn shared_state(&self) -> SharedState {
        SharedState {
            shared: self.targets.shared(),
            apps: self.targets.shared_apps(),
            screen: self.targets.shared_screen(),
        }
    }

    /// The rules the helper judges every window on the screen by, as
    /// `config` makes them.
    fn screen_rules(&self, config: &ComputerToolsConfig) -> ScreenRules {
        ScreenRules {
            me: self.me.clone(),
            blocklist: blocklist_of(config).entries().to_vec(),
        }
    }

    /// End the grants the settings as they are now no longer allow: lapsed,
    /// or on an application that has joined the blocklist.
    async fn sweep(&self) {
        let config = self.config.snapshot().await;
        let ended =
            self.targets
                .sweep(now_ms(), config.grant_ttl, &self.me, &blocklist_of(&config));
        self.announce_change(ended);
        // An application that quit takes its share with it, though its
        // windows — gone with it — cannot say so.
        let quit = self
            .targets
            .prune_apps(|pid, started_at| process_start(pid) == Some(started_at));
        self.announce_change(quit);
    }

    /// Tell the panel about grant changes: each transition, then the state.
    fn announce(&self, changes: &[ComputerGrantPayload]) {
        if changes.is_empty() {
            return;
        }
        for change in changes {
            self.events.grant(change);
        }
        self.emit_state();
    }

    /// [`announce`](Self::announce), for a change that may have moved an
    /// application's share too — which is state even with no window in it.
    fn announce_change(&self, change: AppChange) {
        if change.app_changed && change.windows.is_empty() {
            self.emit_state();
        } else {
            self.announce(&change.windows);
        }
    }

    /// Tell the panels, and bring the strip and the marker in line: the
    /// strip is up while anything is shared (unless the person turned it
    /// off), the marker ready while anything is shared for control.
    fn emit_state(&self) {
        let _told = self.state_gate.lock().unwrap_or_else(|p| p.into_inner());
        let shared = self.targets.shared();
        let apps = self.targets.shared_apps();
        let screen = self.targets.shared_screen();
        self.events.state(&shared, &apps, screen.as_ref());
        #[cfg(feature = "tauri-runtime")]
        if let Some(desktop) = &self.desktop {
            desktop.indicator.set(Strip::of(
                !shared.is_empty() || !apps.is_empty() || screen.is_some(),
                self.strip_wanted.load(Ordering::Acquire),
            ));
            desktop.marker.arm(
                shared.iter().any(|w| w.level == GrantLevel::Control)
                    || apps.iter().any(|a| a.level == GrantLevel::Control)
                    || screen.is_some_and(|s| s.level == GrantLevel::Control),
            );
        }
    }

    /// The person pressed Stop: every grant ends, whatever is under way is
    /// cut off, and the helper kills the driver — mid-action if it is in
    /// one. The count moves with the revocation, before anything is waited
    /// on, so nothing let through before this Stop goes out after it; and
    /// nothing is held after it: sharing a window again is the next step.
    pub async fn stop(&self) {
        let (ended, stop) = {
            let _gate = self.grant_gate.lock().unwrap_or_else(|p| p.into_inner());
            let stop = self.stops.fetch_add(1, Ordering::AcqRel) + 1;
            // The backend holds actions to it from this moment, not from
            // when its `Halt` goes out below.
            self.backend.note_stop(stop);
            // Nothing an agent copied before a Stop is pasted after it.
            *self.clipboard.lock().unwrap_or_else(|p| p.into_inner()) = None;
            (self.targets.revoke_all(GrantChange::Stopped), stop)
        };
        for change in &ended.windows {
            self.events.grant(change);
        }
        self.emit_state();
        if let Err(e) = self.backend.halt(stop).await {
            tracing::warn!("[computer] the helper did not confirm the stop: {e}");
        }
    }

    /// How many times the person has pressed Stop, for whatever begins now
    /// to be held to.
    fn stop_count(&self) -> u64 {
        self.stops.load(Ordering::Acquire)
    }

    /// Whether a Stop has come since `stop` was counted.
    fn stopped_since(&self, stop: u64) -> bool {
        self.stop_count() != stop
    }

    /// Share a window, unless computer use is off or the person has pressed
    /// Stop since the share began (`since`) — decided under the same lock a
    /// Stop and a settings change take to revoke, so no share lands between
    /// either and its revocation.
    fn share_unless_stopped(
        &self,
        target_id: &str,
        level: GrantLevel,
        since: u64,
    ) -> Result<Option<ComputerGrantPayload>, AppCommandError> {
        let _gate = self.grant_gate.lock().unwrap_or_else(|p| p.into_inner());
        let policy = self.policy.lock().unwrap_or_else(|p| p.into_inner());
        if level != GrantLevel::None {
            if !policy.enabled {
                return Err(AppCommandError::configuration_invalid(
                    "computer use is switched off",
                ));
            }
            if self.stopped_since(since) {
                return Err(AppCommandError::configuration_invalid(
                    "Stop was pressed while this was being shared; share it again",
                ));
            }
        }
        match self
            .targets
            .share(target_id, level, now_ms(), &self.me, &policy.blocklist)
        {
            Ok(change) => Ok(change),
            Err(ShareError::NoSuchTarget) | Err(ShareError::Gone) => Err(
                AppCommandError::configuration_invalid("that window is gone; open the list again"),
            ),
            Err(ShareError::NotGrantable(why)) => {
                Err(AppCommandError::configuration_invalid(why.note()))
            }
            Err(ShareError::AppShared) => Err(AppCommandError::configuration_invalid(
                "that window is shared with its whole application; change the application's \
                 sharing instead",
            )),
            Err(ShareError::ScreenShared) => Err(screen_shared_error()),
        }
    }

    /// Share an application as a whole, or end its share — as
    /// [`share_unless_stopped`](Self::share_unless_stopped) shares a window,
    /// under the same lock and for the same reasons.
    fn share_app_unless_stopped(
        &self,
        target: AppTarget<'_>,
        level: GrantLevel,
        since: u64,
    ) -> Result<AppChange, AppCommandError> {
        let _gate = self.grant_gate.lock().unwrap_or_else(|p| p.into_inner());
        let policy = self.policy.lock().unwrap_or_else(|p| p.into_inner());
        if level != GrantLevel::None {
            if !policy.enabled {
                return Err(AppCommandError::configuration_invalid(
                    "computer use is switched off",
                ));
            }
            if self.stopped_since(since) {
                return Err(AppCommandError::configuration_invalid(
                    "Stop was pressed while this was being shared; share it again",
                ));
            }
        }
        self.targets
            .share_app(target, level, now_ms(), &self.me, &policy.blocklist)
            .map_err(|e| match e {
                ShareError::NoSuchTarget | ShareError::Gone | ShareError::AppShared => {
                    AppCommandError::configuration_invalid(
                        "that application is gone; open the list again",
                    )
                }
                ShareError::NotGrantable(why) => AppCommandError::configuration_invalid(why.note()),
                ShareError::ScreenShared => screen_shared_error(),
            })
    }

    /// Share the entire screen, or end its share — as
    /// [`share_unless_stopped`](Self::share_unless_stopped) shares a window,
    /// under the same lock and for the same reasons, and only where it is
    /// offered: macOS and Windows, with its switch on.
    fn share_screen_unless_stopped(
        &self,
        level: GrantLevel,
        since: u64,
    ) -> Result<AppChange, AppCommandError> {
        let _gate = self.grant_gate.lock().unwrap_or_else(|p| p.into_inner());
        let policy = self.policy.lock().unwrap_or_else(|p| p.into_inner());
        if level != GrantLevel::None {
            if !cfg!(any(target_os = "macos", windows)) {
                return Err(AppCommandError::configuration_invalid(
                    "the entire screen is not offered on Linux; share windows or applications \
                     instead",
                ));
            }
            if !policy.enabled {
                return Err(AppCommandError::configuration_invalid(
                    "computer use is switched off",
                ));
            }
            if !policy.screen_enabled {
                return Err(AppCommandError::configuration_invalid(
                    "sharing the entire screen is switched off in Computer use settings",
                ));
            }
            if self.stopped_since(since) {
                return Err(AppCommandError::configuration_invalid(
                    "Stop was pressed while this was being shared; share it again",
                ));
            }
        }
        Ok(self
            .targets
            .share_screen(level, now_ms(), &self.me, &policy.blocklist))
    }

    /// Whether a share begun at `since` may still land: computer use on,
    /// and no Stop since.
    fn sharing_open(&self, since: u64) -> bool {
        let _gate = self.grant_gate.lock().unwrap_or_else(|p| p.into_inner());
        self.policy
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .enabled
            && !self.stopped_since(since)
    }

    /// Remove cua-driver, as the person asked from Settings: switch computer
    /// use off — through the settings writer, so every panel hears of it —
    /// then kill the driver (mid-call if it is in one) and stop the helper
    /// now, rather than whenever the switch is followed, before the files go.
    /// No helper starts again meanwhile: the backend asks the switch itself
    /// before starting one. Then every cached release. Switching back on
    /// fetches the pinned release again.
    async fn uninstall_driver(
        &self,
        conn: &sea_orm::DatabaseConnection,
    ) -> Result<DriverInfo, AppCommandError> {
        self.drivers
            .begin(DriverTask::Uninstalling)
            .map_err(AppCommandError::configuration_invalid)?;
        let result = async {
            if self.config.snapshot().await.enabled {
                crate::commands::computer_tools::set_computer_tools_enabled_core(
                    conn,
                    &self.config,
                    &self.settings_events,
                    false,
                )
                .await
                .map_err(|e| e.to_string())?;
            }
            self.backend.close_now().await;
            crate::computer::driver::forget_cached_driver()
                .await
                .map_err(|e| e.to_string())?;
            Ok::<(), String>(())
        }
        .await;
        self.drivers.finish(result.as_ref().err().cloned());
        result
            .map(|()| self.drivers.info())
            .map_err(AppCommandError::configuration_invalid)
    }

    fn record(&self, target_id: &str, action: ComputerAction, outcome: ActivityOutcome) {
        self.events.activity(&ComputerActivityPayload {
            target_id: target_id.to_string(),
            action,
            outcome,
            at: now_ms(),
            app: None,
        });
    }

    /// What was done to an application rather than to a window of it.
    fn record_app(&self, app: &str, action: ComputerAction, outcome: ActivityOutcome) {
        self.events.activity(&ComputerActivityPayload {
            target_id: String::new(),
            action,
            outcome,
            at: now_ms(),
            app: Some(app.to_string()),
        });
    }

    /// Step 1: the switch, re-read now.
    async fn usable(&self) -> Result<ComputerToolsConfig, Refusal> {
        let config = self.config.snapshot().await;
        if !config.enabled {
            return Err(Refusal::refused(
                ERROR_UNAVAILABLE,
                NO_DESKTOP_NOTE.to_string(),
            ));
        }
        Ok(config)
    }

    fn backend_refusal(&self, target_id: Option<&str>, e: BackendError) -> Refusal {
        match e {
            BackendError::PermissionMissing(p) => Refusal::failed(
                ERROR_PERMISSION_MISSING,
                permission_missing_note(permission_name(p)),
            ),
            BackendError::NoSuchWindow => {
                if let Some(id) = target_id {
                    let ended: Vec<_> = self.targets.target_changed(id).into_iter().collect();
                    self.announce(&ended);
                    Refusal::failed(ERROR_GRANT_REQUIRED, grant_required_note(id))
                } else {
                    Refusal::failed(ERROR_READ_FAILED, "The window is gone.".to_string())
                }
            }
            BackendError::Unavailable(why) | BackendError::Rejected(why) => Refusal::failed(
                ERROR_UNAVAILABLE,
                format!(
                    "Computer use cannot run right now: {why}. It may be worth trying again later."
                ),
            ),
            BackendError::Failed(why) => Refusal::failed(
                ERROR_READ_FAILED,
                format!("The window could not be read: {why}. It may be worth trying again."),
            ),
            BackendError::Refused(kind, words) => refused_act(kind, words),
        }
    }

    /// A backend error on a read or a listing admitted at Stop count
    /// `stop`: one that met the person's Stop on its way — the driver it was
    /// using killed under it — is reported as the Stop.
    fn backend_read_refusal(&self, target_id: Option<&str>, e: BackendError, stop: u64) -> Refusal {
        if self.stopped_since(stop) {
            return stopped();
        }
        self.backend_refusal(target_id, e)
    }

    /// A backend error on an action let through at Stop count `stop`. What
    /// differs from a read: an action that failed or lost its helper on the
    /// way may have happened anyway, and the words say so; and a helper that
    /// went away because the person pressed Stop is reported as the Stop.
    fn backend_act_refusal(&self, target_id: &str, e: BackendError, stop: u64) -> Refusal {
        if self.stopped_since(stop) {
            return match e {
                // Refused before it went out, whatever for: not done.
                BackendError::Refused(kind, _) if kind != ActRefusal::Failed => stopped(),
                _ => Refusal::refused(
                    ERROR_STOPPED,
                    format!(
                        "The user pressed Stop while this action was on its way: it may or may \
                         not have happened. {STOPPED_NOTE}"
                    ),
                )
                .maybe_done(),
            };
        }
        match e {
            BackendError::Unavailable(why) => Refusal::failed(
                ERROR_UNAVAILABLE,
                format!(
                    "Computer use stopped working during the action ({why}); it may or may not \
                     have happened. Read the window again before going on."
                ),
            )
            .maybe_done(),
            BackendError::Failed(why) => Refusal::failed(
                ERROR_ACTION_FAILED,
                format!(
                    "The action did not complete ({why}); it may or may not have happened. Read \
                     the window again before going on."
                ),
            )
            .maybe_done(),
            other => self.backend_refusal(Some(target_id), other),
        }
    }

    /// Steps 1–3: everything that has to hold before the helper is asked.
    async fn begin(&self, target_id: &str) -> Result<Admitted, Refusal> {
        // Counted before the grant is looked at: a Stop after this revokes
        // the grant, or is caught by `finish`.
        let stop = self.stop_count();
        let config = self.usable().await?;
        let blocklist = blocklist_of(&config);
        let ticket = match self.targets.begin_read(
            target_id,
            now_ms(),
            config.grant_ttl,
            &self.me,
            &blocklist,
        ) {
            Ok(ticket) => ticket,
            Err((why, ended)) => {
                self.announce(&ended.into_iter().collect::<Vec<_>>());
                return Err(match why {
                    ReadRefusal::NoSuchTarget => {
                        Refusal::refused(ERROR_NO_SUCH_TARGET, no_such_target_note(target_id))
                    }
                    ReadRefusal::GrantRequired => {
                        Refusal::refused(ERROR_GRANT_REQUIRED, grant_required_note(target_id))
                    }
                    ReadRefusal::NotGrantable(why) => {
                        Refusal::refused(ERROR_BLOCKED, blocked_note(target_id, why.note()))
                    }
                });
            }
        };
        self.check_identity(&ticket.target_id, &ticket.identity)?;
        Ok(Admitted {
            ticket,
            switched_off: config.switched_off,
            stop,
        })
    }

    /// Step 3. A pid that no longer answers with the start time it had when
    /// the window was shared is a different process — the window's owner, or
    /// the process drawing inside a frame (`WindowIdentity::content`). A
    /// window without a start time cannot have been shared at all
    /// (`NotGrantable::Unidentified`). Returns the start time the grant is
    /// held against.
    fn check_identity(&self, target_id: &str, identity: &WindowIdentity) -> Result<u64, Refusal> {
        let Some(started_at) = identity.started_at else {
            return Err(Refusal::refused(
                ERROR_BLOCKED,
                blocked_note(target_id, NotGrantable::Unidentified.note()),
            ));
        };
        let content_changed = identity
            .content
            .is_some_and(|run| process_start(run.pid) != Some(run.started_at));
        if process_start(identity.pid) != Some(started_at) || content_changed {
            let ended: Vec<_> = self.targets.target_changed(target_id).into_iter().collect();
            self.announce(&ended);
            return Err(Refusal::failed(
                ERROR_GRANT_REQUIRED,
                grant_required_note(target_id),
            ));
        }
        Ok(started_at)
    }

    /// Step 4's second half: steps 1–3 again, against what the read began
    /// under. `mark` is what the read leaves for later actions.
    async fn finish(&self, admitted: &Admitted, mark: Option<ReadMark>) -> Result<String, Refusal> {
        let ticket = &admitted.ticket;
        let refused =
            || Refusal::refused(ERROR_GRANT_REQUIRED, grant_required_note(&ticket.target_id));
        if self.stopped_since(admitted.stop) {
            return Err(stopped());
        }
        let config = self.usable().await?;
        if config.switched_off != admitted.switched_off {
            return Err(refused());
        }
        // Whatever process holds the pid now is the one the helper just read:
        // if it is not the one the window was shared from, neither is what
        // was read.
        self.check_identity(&ticket.target_id, &ticket.identity)?;
        let blocklist = blocklist_of(&config);
        match self.targets.finish_read(ticket, &self.me, &blocklist, mark) {
            Ok(generation) => Ok(generation),
            Err((why, ended)) => {
                self.announce(&ended.into_iter().collect::<Vec<_>>());
                Err(match why {
                    ReadRefusal::NotGrantable(why) => Refusal::refused(
                        ERROR_BLOCKED,
                        blocked_note(&ticket.target_id, why.note()),
                    ),
                    ReadRefusal::NoSuchTarget | ReadRefusal::GrantRequired => refused(),
                })
            }
        }
    }

    /// The window's title as the agent may see it now.
    fn title_for(&self, target_id: &str, raw: Option<String>) -> Option<String> {
        let entry = self.targets.get(target_id)?;
        let level = entry.grant.as_ref().map_or(GrantLevel::None, |g| g.level);
        let title = raw.filter(|t| !t.is_empty()).unwrap_or(entry.title);
        visible_title(level, &title)
    }

    pub async fn agent_list_apps(&self) -> ComputerAppsOutcome {
        let _turn = self.turn.lock().await;
        let stop = self.stop_count();
        let config = match self.usable().await {
            Ok(config) => config,
            Err(r) => return ComputerAppsOutcome::refused(r.slug, r.note),
        };
        let blocklist = blocklist_of(&config);
        let listed = self.backend.list_apps().await;
        // A Stop that came while the helper was listing cuts this off too.
        if self.stopped_since(stop) {
            return ComputerAppsOutcome::refused(ERROR_STOPPED, STOPPED_NOTE);
        }
        match listed {
            Ok(apps) => ComputerAppsOutcome {
                apps: apps
                    .into_iter()
                    .map(|app| AgentAppSummary {
                        note: grantable(&app, &self.me, &blocklist)
                            .err()
                            .map(|why| why.note().to_string()),
                        app: AgentAppRef {
                            key: app.key().unwrap_or_default().to_string(),
                            name: app.name.clone(),
                            pid: app.pid,
                        },
                        active: app.active,
                        level: self.targets.app_level(&app),
                    })
                    .collect(),
                error: None,
                note: None,
            },
            Err(e) => {
                let r = self.backend_read_refusal(None, e, stop);
                ComputerAppsOutcome::refused(r.slug, r.note)
            }
        }
    }

    pub async fn agent_list_windows(&self, pid: Option<u32>) -> ComputerWindowsOutcome {
        let _turn = self.turn.lock().await;
        let stop = self.stop_count();
        let config = match self.usable().await {
            Ok(config) => config,
            Err(r) => return ComputerWindowsOutcome::refused(r.slug, r.note),
        };
        let blocklist = blocklist_of(&config);
        let listed = self.backend.list_windows(pid).await;
        // Grants that have already ended by the rules as they are now must
        // not show — neither as a level nor as a title.
        self.sweep().await;
        // A Stop that came while the helper was listing, or since, cuts this
        // off too; nothing below waits on anything.
        if self.stopped_since(stop) {
            return ComputerWindowsOutcome::refused(ERROR_STOPPED, STOPPED_NOTE);
        }
        match listed {
            Ok(windows) => {
                let (entries, ended) = self.targets.observe(&windows, pid);
                self.announce(&ended);
                ComputerWindowsOutcome {
                    windows: entries
                        .iter()
                        .filter(|e| e.worth_listing())
                        .map(|e| e.agent_summary(&self.me, &blocklist))
                        .collect(),
                    screen: self.targets.shared_screen().map(|screen| AgentScreen {
                        target_id: SCREEN_TARGET_ID.to_string(),
                        level: screen.level,
                    }),
                    input: Some(InputPolicy::of(&config)),
                    error: None,
                    note: None,
                }
            }
            Err(e) => {
                let r = self.backend_read_refusal(None, e, stop);
                ComputerWindowsOutcome::refused(r.slug, r.note)
            }
        }
    }

    async fn capture_inner(
        &self,
        target_id: &str,
        max_dimension: Option<u32>,
    ) -> Result<WindowCapture, Refusal> {
        if target_id == SCREEN_TARGET_ID {
            return self.capture_screen(max_dimension).await;
        }
        let _turn = self.turn.lock().await;
        let admitted = self.begin(target_id).await?;
        let ticket = &admitted.ticket;
        let max = max_dimension
            .unwrap_or(DEFAULT_MAX_DIMENSION)
            .clamp(1, DEFAULT_MAX_DIMENSION);
        let raw = self
            .backend
            .capture(ticket.identity.pid, ticket.identity.window_id, Some(max))
            .await
            .map_err(|e| self.backend_read_refusal(Some(target_id), e, admitted.stop))?;
        let window_bounds = if raw.window_bounds.is_empty() {
            ticket.bounds
        } else {
            raw.window_bounds
        };
        let mark = ReadMark::Capture {
            width: raw.width,
            height: raw.height,
            native_width: raw.native_width,
            native_height: raw.native_height,
            // Only the helper's own measure of the window says whether the
            // capture is its full size; bounds codeg fills in from the
            // listing are not that.
            full_size: raw.full_size && !raw.window_bounds.is_empty(),
            window_bounds: raw.window_bounds,
        };
        let generation = self.finish(&admitted, Some(mark)).await?;
        Ok(WindowCapture {
            target_id: target_id.to_string(),
            generation,
            mime: "image/png".to_string(),
            data: raw.png_base64,
            width: raw.width,
            height: raw.height,
            window_bounds,
            title: self.title_for(target_id, raw.title),
        })
    }

    /// A picture of the entire screen, for an agent — read as a window is,
    /// minus the window: the screen shared and its grant in force, then,
    /// once the helper has taken it, no Stop since, the switch not off since,
    /// the same sharing of the screen, and nothing added to the never-share
    /// list while it was taken (the helper painted over what the list said
    /// when it began).
    async fn capture_screen(&self, max_dimension: Option<u32>) -> Result<WindowCapture, Refusal> {
        let _turn = self.turn.lock().await;
        let stop = self.stop_count();
        let config = self.usable().await?;
        let refused =
            || Refusal::refused(ERROR_GRANT_REQUIRED, SCREEN_GRANT_REQUIRED_NOTE.to_string());
        let ticket = match self.targets.begin_screen_read(now_ms(), config.grant_ttl) {
            Ok(ticket) => ticket,
            Err((_, ended)) => {
                self.announce_change(ended);
                return Err(refused());
            }
        };
        let rules = self.screen_rules(&config);
        let max = max_dimension
            .unwrap_or(DEFAULT_MAX_DIMENSION)
            .clamp(1, DEFAULT_MAX_DIMENSION);
        let raw = self
            .backend
            .capture_screen(rules.clone(), Some(max))
            .await
            .map_err(|e| self.backend_read_refusal(None, e, stop))?;
        if self.stopped_since(stop) {
            return Err(stopped());
        }
        let now = self.usable().await?;
        if now.switched_off != config.switched_off {
            return Err(refused());
        }
        let grew = blocklist_of(&now)
            .entries()
            .iter()
            .any(|entry| !rules.blocklist.contains(entry));
        if grew {
            return Err(Refusal::failed(
                ERROR_READ_FAILED,
                SCREEN_RULES_CHANGED_NOTE.to_string(),
            ));
        }
        let mark = ReadMark::Capture {
            width: raw.width,
            height: raw.height,
            native_width: raw.native_width,
            native_height: raw.native_height,
            full_size: raw.full_size && !raw.window_bounds.is_empty(),
            window_bounds: raw.window_bounds,
        };
        let generation = self
            .targets
            .finish_screen_read(&ticket, mark)
            .map_err(|_| refused())?;
        Ok(WindowCapture {
            target_id: SCREEN_TARGET_ID.to_string(),
            generation,
            mime: "image/png".to_string(),
            data: raw.png_base64,
            width: raw.width,
            height: raw.height,
            window_bounds: raw.window_bounds,
            title: None,
        })
    }

    pub async fn agent_capture(
        &self,
        target_id: &str,
        max_dimension: Option<u32>,
    ) -> ComputerCaptureOutcome {
        match self.capture_inner(target_id, max_dimension).await {
            Ok(capture) => {
                self.record(target_id, ComputerAction::Capture, ActivityOutcome::Done);
                ComputerCaptureOutcome::image(target_id, capture)
            }
            Err(r) => {
                self.record(target_id, ComputerAction::Capture, r.outcome);
                ComputerCaptureOutcome::refused(target_id, r.slug, r.note)
            }
        }
    }

    async fn snapshot_inner(
        &self,
        target_id: &str,
        request: SnapshotRequest,
    ) -> Result<WindowSnapshot, Refusal> {
        if target_id == SCREEN_TARGET_ID {
            return Err(Refusal::failed(
                ERROR_ACTION_FAILED,
                SCREEN_POINTER_ONLY_NOTE.to_string(),
            ));
        }
        let _turn = self.turn.lock().await;
        let admitted = self.begin(target_id).await?;
        let ticket = &admitted.ticket;
        let raw = self
            .backend
            .snapshot(
                ticket.identity.pid,
                ticket.identity.window_id,
                SnapshotOptions {
                    max_depth: request.max_depth,
                    max_elements: request.max_elements,
                    query: request.query,
                    app_menus: ticket.scope != GrantScope::Window,
                },
            )
            .await
            .map_err(|e| self.backend_read_refusal(Some(target_id), e, admitted.stop))?;
        let (tree, cut) = cut_tree(
            &raw.tree,
            request.max_chars.unwrap_or(DEFAULT_SNAPSHOT_MAX_CHARS),
        );
        // A ref is usable when its line is in what the agent is given: the
        // tree is cut between lines, so a line that starts before the cut
        // is there.
        let kept = tree.len();
        let mut mark_shown = BTreeSet::new();
        let mut mark_cut = BTreeSet::new();
        let mut mark_secret = BTreeSet::new();
        for r in &raw.refs {
            if (r.offset as usize) < kept {
                mark_shown.insert(r.index);
            } else {
                mark_cut.insert(r.index);
            }
            if r.secret {
                mark_secret.insert(r.index);
            }
        }
        let mark = ReadMark::Snapshot {
            snapshot_id: raw.snapshot_id.clone(),
            shown: mark_shown,
            cut: mark_cut,
            secret: mark_secret,
        };
        let generation = self.finish(&admitted, Some(mark)).await?;
        Ok(WindowSnapshot {
            target_id: target_id.to_string(),
            generation,
            title: self.title_for(target_id, raw.title),
            window_bounds: raw.window_bounds.filter(|b: &Rect| !b.is_empty()),
            tree,
            element_count: raw.element_count,
            truncated: cut || raw.truncated,
            degraded: raw.degraded,
        })
    }

    pub async fn agent_snapshot(
        &self,
        target_id: &str,
        request: SnapshotRequest,
    ) -> ComputerSnapshotOutcome {
        match self.snapshot_inner(target_id, request).await {
            Ok(snapshot) => {
                self.record(target_id, ComputerAction::Snapshot, ActivityOutcome::Done);
                ComputerSnapshotOutcome::tree(target_id, snapshot)
            }
            Err(r) => {
                self.record(target_id, ComputerAction::Snapshot, r.outcome);
                ComputerSnapshotOutcome::refused(target_id, r.slug, r.note)
            }
        }
    }

    async fn verify_inner(
        &self,
        target_id: &str,
        request: VerifyRequest,
    ) -> Result<VerifyOutcome, Refusal> {
        if target_id == SCREEN_TARGET_ID {
            return Err(Refusal::failed(
                ERROR_ACTION_FAILED,
                SCREEN_POINTER_ONLY_NOTE.to_string(),
            ));
        }
        let _turn = self.turn.lock().await;
        let admitted = self.begin(target_id).await?;
        let ticket = &admitted.ticket;
        let raw = self
            .backend
            .verify(ticket.identity.pid, ticket.identity.window_id, request)
            .await
            .map_err(|e| self.backend_read_refusal(Some(target_id), e, admitted.stop))?;
        self.finish(&admitted, None).await?;
        Ok(VerifyOutcome {
            target_id: target_id.to_string(),
            status: raw.status,
            stable: raw.stable,
            samples: raw.samples,
            elapsed_ms: raw.elapsed_ms,
            predicates: raw.predicates,
        })
    }

    pub async fn agent_verify(
        &self,
        target_id: &str,
        request: VerifyRequest,
    ) -> ComputerVerifyOutcome {
        match self.verify_inner(target_id, request).await {
            Ok(verify) => {
                self.record(target_id, ComputerAction::Verify, ActivityOutcome::Done);
                ComputerVerifyOutcome::verdict(target_id, verify)
            }
            Err(r) => {
                self.record(target_id, ComputerAction::Verify, r.outcome);
                ComputerVerifyOutcome::refused(target_id, r.slug, r.note)
            }
        }
    }

    /// One action, checked from the top — its turn at the driver held by
    /// the caller (`_turn`) — the switch, the grant and the action against
    /// what the agent last read, the process, whether its window may come to
    /// the front if that is how it is to go (`requested`, or the person's
    /// default), no Stop since it began — and then the helper, which checks
    /// again what only it can see, the Stop count included. A press after the
    /// first of one key (`later`) is held to the Stop count and the sharing
    /// the first went out under.
    async fn act_once(
        &self,
        _turn: &tokio::sync::MutexGuard<'_, ()>,
        target_id: &str,
        request: &ComputerActRequest,
        requested: Option<ActDelivery>,
        later: Option<LaterPress>,
    ) -> Result<Press, Refusal> {
        // A Stop since the first press ends the presses, whatever has been
        // shared again since.
        let stop = match later {
            Some(first) if self.stopped_since(first.stop) => return Err(stopped()),
            Some(first) => first.stop,
            None => self.stop_count(),
        };
        let config = self.usable().await?;
        if request.needs_launch_switch() && !config.launch_enabled {
            return Err(Refusal::refused(
                ERROR_UNAVAILABLE,
                LAUNCH_OFF_NOTE.to_string(),
            ));
        }
        let blocklist = blocklist_of(&config);
        // What pastes may go only while the clipboard holds what an agent put
        // there itself; the helper checks it is still so as the action goes.
        let owned = self.owned_clipboard();
        let ticket = match self.targets.begin_act(
            target_id,
            now_ms(),
            config.grant_ttl,
            &self.me,
            &blocklist,
            request,
            owned.is_some(),
        ) {
            Ok(ticket) => ticket,
            Err((why, ended)) => {
                self.announce(&ended.into_iter().collect::<Vec<_>>());
                return Err(denied(target_id, why));
            }
        };
        let epoch = ticket.epoch;
        // So does the window taken back and shared again: a new sharing,
        // which the presses did not begin under.
        if later.is_some_and(|first| first.epoch != epoch) {
            return Err(Refusal::refused(
                ERROR_GRANT_REQUIRED,
                reshared_note(target_id),
            ));
        }
        let started_at = self.check_identity(target_id, &ticket.identity)?;
        let aim = ticket.aim;
        // Against the settings as they are now: the front turned off since
        // the last press stops the next.
        let delivery = delivery_for(request, requested, &config)?;
        // The grant was looked at after `stop` was counted, so a Stop in
        // between either revoked it above or shows here.
        if self.stopped_since(stop) {
            return Err(stopped());
        }
        let clipboard = ClipboardUse {
            track: copies(request),
            // Only for what could paste: the helper reads the clipboard's
            // stamp for it, which an ordinary action has no need of.
            paste: owned.filter(|_| may_paste(request)),
        };
        let sent_at = tokio::time::Instant::now();
        let press = self
            .backend
            .act(
                ticket.identity.pid,
                ticket.identity.window_id,
                started_at,
                ticket.identity.content,
                ticket.app.key().map(str::to_string),
                ticket.action,
                delivery,
                clipboard,
                stop,
            )
            .await
            .map(|raw| Press {
                raw,
                aim,
                delivery,
                sent_at,
                stop,
                epoch,
            });
        // What the action put on the clipboard is the agent's own, out of a
        // window it may read — for as long as that window is shared so.
        if let Ok(Press {
            raw: RawAct {
                clipboard: Some(stamp),
                ..
            },
            ..
        }) = &press
        {
            self.own_clipboard(
                OwnedClipboard {
                    stamp: *stamp,
                    source: Some((target_id.to_string(), epoch)),
                },
                stop,
            );
        }
        press.map_err(|e| {
            with_next_step(
                self.backend_act_refusal(target_id, e, stop),
                request,
                &config,
            )
        })
    }

    /// One action on the entire screen, for an agent: checked as one on a
    /// window is, minus the window — the screen shared for control and its
    /// grant in force, every point from its latest picture — and sent once,
    /// at the front as real input, only where the person allows the front.
    /// The helper refuses a point on what it painted over.
    async fn act_on_screen(
        &self,
        request: &ComputerActRequest,
        requested: Option<ActDelivery>,
    ) -> Result<ActReport, Refusal> {
        let _turn = self.turn.lock().await;
        let stop = self.stop_count();
        let config = self.usable().await?;
        let ticket = match self
            .targets
            .begin_screen_act(now_ms(), config.grant_ttl, request)
        {
            Ok(ticket) => ticket,
            Err((why, ended)) => {
                self.announce_change(ended);
                return Err(screen_denied(why));
            }
        };
        if requested == Some(ActDelivery::Background) {
            return Err(Refusal::failed(
                ERROR_BACKGROUND_UNAVAILABLE,
                SCREEN_NOT_BACKGROUND_NOTE.to_string(),
            ));
        }
        if !config.allow_foreground {
            return Err(Refusal::refused(
                ERROR_FOREGROUND_NOT_ALLOWED,
                SCREEN_NEEDS_FRONT_NOTE.to_string(),
            ));
        }
        // The grant was looked at after `stop` was counted, so a Stop in
        // between either ended it above or shows here.
        if self.stopped_since(stop) {
            return Err(stopped());
        }
        let rules = self.screen_rules(&config);
        // Asked again with the helper in hand, just before it goes: the
        // sharing it was let through under still in force for control, the
        // switches still on, and nothing added to the never-share list the
        // helper is to judge the screen by.
        let epoch = ticket.epoch;
        let judged_by = rules.blocklist.clone();
        let still = move || {
            let _gate = self.grant_gate.lock().unwrap_or_else(|p| p.into_inner());
            let policy = self.policy.lock().unwrap_or_else(|p| p.into_inner());
            policy.enabled
                && policy.screen_enabled
                && policy
                    .blocklist
                    .entries()
                    .iter()
                    .all(|entry| judged_by.contains(entry))
                && self.targets.screen_controlled(epoch)
        };
        let raw = self
            .backend
            .act_screen(rules, ticket.action, ticket.geometry, stop, &still)
            .await
            .map_err(|e| self.backend_act_refusal(SCREEN_TARGET_ID, e, stop))?;
        Ok(ActReport {
            target_id: SCREEN_TARGET_ID.to_string(),
            effect: raw.effect,
            route: raw.route,
            delivery: ActDelivery::Foreground,
            presses: None,
            submitted: None,
            submit_note: None,
        })
    }

    /// Start an installed application for an agent — the one listed under
    /// `key`, or else `name` — in the background, where the person allows
    /// it. Never codeg, nor an application on the blocklist. Its windows are
    /// not shared by it: the person shares them, as any other.
    pub async fn agent_launch_app(
        &self,
        name: Option<String>,
        key: Option<String>,
    ) -> ComputerLaunchOutcome {
        let _turn = self.turn.lock().await;
        let stop = self.stop_count();
        let config = match self.usable().await {
            Ok(config) => config,
            Err(r) => return ComputerLaunchOutcome::refused(r.slug, r.note),
        };
        if !config.launch_enabled {
            return ComputerLaunchOutcome::refused(ERROR_UNAVAILABLE, LAUNCH_OFF_NOTE);
        }
        let found = match self.backend.find_app(name, key).await {
            Ok(found) => found,
            Err(e) => {
                let r = self.backend_read_refusal(None, e, stop);
                return ComputerLaunchOutcome::refused(r.slug, r.note);
            }
        };
        // Judged by who the application is and by every word of the command
        // that starts it: a command carries arguments, or a wrapper.
        let blocklist = blocklist_of(&config);
        let command = found.launch_path.as_deref().unwrap_or_default();
        let blocked = if self.me.owns(&found.app) || self.me.owns_command(command) {
            Some(NotGrantable::Codeg)
        } else if blocklist.matches(&found.app) || blocklist.matches_command(command) {
            Some(NotGrantable::Blocklisted)
        } else {
            None
        };
        let name = found.app.name.clone();
        let overview = found
            .app
            .bundle_id
            .as_deref()
            .is_some_and(|id| SHOWS_EVERY_WINDOW.contains(&id));
        if overview {
            self.record_app(&name, ComputerAction::Launch, ActivityOutcome::Refused);
            return ComputerLaunchOutcome::refused(
                ERROR_BLOCKED,
                format!(
                    "{name} is not started for an agent: it shows every window at once, the ones \
                     that are never shared included. Retrying will not change it."
                ),
            );
        }
        if let Some(why) = blocked {
            self.record_app(&name, ComputerAction::Launch, ActivityOutcome::Refused);
            return ComputerLaunchOutcome::refused(
                ERROR_BLOCKED,
                format!(
                    "{name} is not started for an agent: {} Retrying will not change it.",
                    why.note()
                ),
            );
        }
        if self.stopped_since(stop) {
            return ComputerLaunchOutcome::refused(ERROR_STOPPED, STOPPED_NOTE);
        }
        let key = found
            .app
            .key()
            .or(found.launch_path.as_deref())
            .unwrap_or_default()
            .to_string();
        match self.backend.launch_app(found, stop).await {
            Ok(raw) => {
                self.record_app(&raw.name, ComputerAction::Launch, ActivityOutcome::Done);
                ComputerLaunchOutcome {
                    app: Some(AgentAppRef {
                        key,
                        name: raw.name,
                        pid: raw.pid.unwrap_or(0),
                    }),
                    error: None,
                    note: Some(LAUNCHED_NOTE.to_string()),
                }
            }
            Err(e) => {
                self.record_app(&name, ComputerAction::Launch, ActivityOutcome::Failed);
                let r = if self.stopped_since(stop) {
                    stopped()
                } else {
                    self.backend_refusal(None, e)
                };
                ComputerLaunchOutcome::refused(
                    r.slug,
                    format!("{} It may or may not have started.", r.note),
                )
            }
        }
    }

    /// The clipboard for an agent, where the person allows it: read back
    /// only what an agent put there itself, while the clipboard still holds
    /// it (see [`OwnedClipboard`]); or put text there, which an agent may
    /// then paste.
    pub async fn agent_clipboard(&self, op: ClipboardOp) -> ComputerClipboardOutcome {
        let _turn = self.turn.lock().await;
        let stop = self.stop_count();
        let config = match self.usable().await {
            Ok(config) => config,
            Err(r) => return ComputerClipboardOutcome::refused(r.slug, r.note),
        };
        if !config.clipboard_enabled {
            return ComputerClipboardOutcome::refused(ERROR_UNAVAILABLE, CLIPBOARD_OFF_NOTE);
        }
        match op {
            ClipboardOp::Read => {
                let action = ComputerAction::ClipboardRead;
                let Some(expect) = self.owned_clipboard() else {
                    self.record("", action, ActivityOutcome::Refused);
                    return ComputerClipboardOutcome::refused(
                        ERROR_GRANT_REQUIRED,
                        CLIPBOARD_NOT_YOURS_NOTE,
                    );
                };
                let read = self.backend.clipboard_read(expect).await;
                if self.stopped_since(stop) {
                    return ComputerClipboardOutcome::refused(ERROR_STOPPED, STOPPED_NOTE);
                }
                // The window it was copied from may have been taken back, or
                // shared again, while it was being read.
                if read.is_ok() && self.owned_clipboard() != Some(expect) {
                    self.record("", action, ActivityOutcome::Refused);
                    return ComputerClipboardOutcome::refused(
                        ERROR_GRANT_REQUIRED,
                        CLIPBOARD_NOT_YOURS_NOTE,
                    );
                }
                match read {
                    Ok(raw) => {
                        self.record("", action, ActivityOutcome::Done);
                        ComputerClipboardOutcome {
                            text: Some(raw.text.unwrap_or_default()),
                            ..ComputerClipboardOutcome::default()
                        }
                    }
                    Err(e) => {
                        let r = self.backend_refusal(None, e);
                        self.record("", action, r.outcome);
                        ComputerClipboardOutcome::refused(r.slug, r.note)
                    }
                }
            }
            ClipboardOp::Write { text } => {
                let action = ComputerAction::ClipboardWrite;
                if text.chars().count() > MAX_CLIPBOARD_WRITE_CHARS {
                    return ComputerClipboardOutcome::refused(
                        ERROR_ACTION_FAILED,
                        format!(
                            "That is more than the {MAX_CLIPBOARD_WRITE_CHARS} characters one \
                             write puts on the clipboard; nothing was written."
                        ),
                    );
                }
                if self.stopped_since(stop) {
                    return ComputerClipboardOutcome::refused(ERROR_STOPPED, STOPPED_NOTE);
                }
                match self.backend.clipboard_write(text, stop).await {
                    Ok(stamp) => {
                        if !self.own_clipboard(
                            OwnedClipboard {
                                stamp,
                                source: None,
                            },
                            stop,
                        ) {
                            return ComputerClipboardOutcome::refused(
                                ERROR_STOPPED,
                                format!(
                                    "The user pressed Stop as the text went on the clipboard: \
                                     nothing on it is held as yours. {STOPPED_NOTE}"
                                ),
                            );
                        }
                        self.record("", action, ActivityOutcome::Done);
                        ComputerClipboardOutcome {
                            written: true,
                            note: Some(CLIPBOARD_WRITTEN_NOTE.to_string()),
                            ..ComputerClipboardOutcome::default()
                        }
                    }
                    Err(e) => {
                        let r = if self.stopped_since(stop) {
                            stopped()
                        } else {
                            self.backend_refusal(None, e)
                        };
                        self.record("", action, ActivityOutcome::Failed);
                        ComputerClipboardOutcome::refused(r.slug, r.note)
                    }
                }
            }
        }
    }

    /// Act on a window shared for control, brought to the front for it or
    /// not as `delivery` asks — or as the person set it, when it does not. A
    /// key pressed more than once is that many actions, each checked on its
    /// own and each taking its own turn at the driver: taking the window
    /// back between two presses, the front, or Stop ends the rest. So is a
    /// held key: pressed at once, then — after the delay a held key waits
    /// before it repeats — at the rate it repeats, until its time is up
    /// ([`Presses`]), counted from the first press in real time.
    pub async fn agent_act(
        &self,
        target_id: &str,
        request: ComputerActRequest,
        delivery: Option<ActDelivery>,
    ) -> ComputerActOutcome {
        let action = ComputerAction::of(&request);
        if target_id == SCREEN_TARGET_ID {
            return match self.act_on_screen(&request, delivery).await {
                Ok(report) => {
                    self.record(target_id, action, ActivityOutcome::Done);
                    ComputerActOutcome::done(target_id, report)
                }
                Err(r) => {
                    self.record(target_id, action, r.outcome);
                    ComputerActOutcome::refused(target_id, r.slug, r.note)
                }
            };
        }
        let presses = Presses::of(&request);
        let mark = |press: &Press| {
            #[cfg(feature = "tauri-runtime")]
            if let (Some(desktop), Some(at)) = (&self.desktop, press.aim.landing(&press.raw)) {
                desktop.marker.mark(at, action);
            }
            // No marker in codeg-server: nothing on its screen of codeg's.
            #[cfg(not(feature = "tauri-runtime"))]
            let _ = (press.aim, action);
        };
        let first = {
            let turn = self.turn.lock().await;
            self.act_once(&turn, target_id, &request, delivery, None)
                .await
        };
        let first = match first {
            Ok(press) => press,
            Err(r) => {
                self.record(target_id, action, r.outcome);
                return ComputerActOutcome::refused(target_id, r.slug, r.note);
            }
        };
        mark(&first);
        let later = LaterPress {
            stop: first.stop,
            epoch: first.epoch,
            until: presses.length().map(|length| first.sent_at + length),
        };
        let time_up = |at: tokio::time::Instant| later.until.is_some_and(|until| at >= until);
        let mut next = first.sent_at;
        let mut pressed: u32 = 1;
        let mut done = first;
        loop {
            match presses {
                Presses::Count(count) if pressed >= count => break,
                Presses::Count(_) => {}
                Presses::Held(_) => {
                    next += if pressed == 1 {
                        HOLD_DELAY
                    } else {
                        HOLD_INTERVAL
                    };
                    // A press that took longer than the gap is not made up
                    // for: the next goes as soon as it can.
                    next = next.max(tokio::time::Instant::now());
                    if time_up(next) {
                        break;
                    }
                    tokio::time::sleep_until(next).await;
                }
            }
            let press = {
                let turn = self.turn.lock().await;
                // The turn may have been a while coming.
                if time_up(tokio::time::Instant::now()) {
                    break;
                }
                self.act_once(&turn, target_id, &request, delivery, Some(later))
                    .await
            };
            match press {
                Ok(press) => {
                    mark(&press);
                    pressed += 1;
                    done = press;
                }
                Err(r) => {
                    self.record(target_id, action, r.outcome);
                    let note = format!("{}{}", presses.cut_short(pressed, r.maybe_done), r.note);
                    return ComputerActOutcome::refused(target_id, r.slug, note);
                }
            }
        }
        self.record(target_id, action, ActivityOutcome::Done);
        ComputerActOutcome::done(
            target_id,
            ActReport {
                target_id: target_id.to_string(),
                effect: done.raw.effect,
                route: done.raw.route,
                delivery: done.delivery,
                presses: presses.reported(pressed),
                submitted: done.raw.submitted,
                submit_note: done.raw.submit_note,
            },
        )
    }
}

/// One press that went out.
struct Press {
    raw: RawAct,
    aim: Aim,
    delivery: ActDelivery,
    /// When it was sent: a held key's time runs from its first press.
    sent_at: tokio::time::Instant,
    /// The Stop count it was held to.
    stop: u64,
    /// The sharing it went out under (see `TargetEntry::epoch`).
    epoch: u64,
}

/// What a press after the first of one key is held to: the Stop count and
/// the sharing the first went out under, and for a held key when its time
/// is up.
#[derive(Debug, Clone, Copy)]
struct LaterPress {
    stop: u64,
    epoch: u64,
    until: Option<tokio::time::Instant>,
}

/// A held key goes in once, then again after the delay a held key waits
/// before it repeats, then at the rate it repeats — as fast as the
/// presses go through, and no faster.
const HOLD_DELAY: Duration = Duration::from_millis(500);
const HOLD_INTERVAL: Duration = Duration::from_millis(50);

/// How many times an action goes out: once; `repeat` times back to back for
/// a key; for a held key, as often as its time allows.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Presses {
    Count(u32),
    Held(Duration),
}

impl Presses {
    /// How long a held key is held; nothing for a count of presses.
    fn length(self) -> Option<Duration> {
        match self {
            Presses::Held(length) => Some(length),
            Presses::Count(_) => None,
        }
    }

    fn of(request: &ComputerActRequest) -> Self {
        match request {
            ComputerActRequest::Key { repeat, .. } => {
                Presses::Count((*repeat).clamp(1, MAX_KEY_REPEAT))
            }
            ComputerActRequest::HoldKey { duration_ms, .. } => Presses::Held(
                Duration::from_millis(u64::from((*duration_ms).min(MAX_HOLD_MS))),
            ),
            _ => Presses::Count(1),
        }
    }

    /// What the report says of the presses: how many went out, for a key
    /// pressed more than once or held.
    fn reported(self, pressed: u32) -> Option<u32> {
        match self {
            Presses::Count(count) => (count > 1).then_some(count),
            Presses::Held(_) => Some(pressed),
        }
    }

    /// How a refusal after `pressed` presses begins: what did go out, and
    /// whether the press that failed may have gone out too.
    fn cut_short(self, pressed: u32, maybe_done: bool) -> String {
        let after = if maybe_done {
            "; the press after that may or may not have gone out: "
        } else {
            ", then stopped: "
        };
        match self {
            Presses::Count(count) => {
                format!("The key was pressed {pressed} of {count} times{after}")
            }
            Presses::Held(_) => format!("The key was held for {pressed} presses{after}"),
        }
    }
}

/// The `computer_*` tools' access impl: the service, from the listener.
pub struct McpComputerTools {
    service: Arc<ComputerService>,
}

impl McpComputerTools {
    pub fn new(service: Arc<ComputerService>) -> Self {
        Self { service }
    }
}

#[async_trait::async_trait]
impl ComputerToolAccess for McpComputerTools {
    async fn list_apps(&self) -> ComputerAppsOutcome {
        self.service.agent_list_apps().await
    }

    async fn list_windows(&self, pid: Option<u32>) -> ComputerWindowsOutcome {
        self.service.agent_list_windows(pid).await
    }

    async fn capture(&self, target_id: &str, max_dimension: Option<u32>) -> ComputerCaptureOutcome {
        self.service.agent_capture(target_id, max_dimension).await
    }

    async fn snapshot(&self, target_id: &str, request: SnapshotRequest) -> ComputerSnapshotOutcome {
        self.service.agent_snapshot(target_id, request).await
    }

    async fn verify(&self, target_id: &str, request: VerifyRequest) -> ComputerVerifyOutcome {
        self.service.agent_verify(target_id, request).await
    }

    async fn launch_app(&self, name: Option<String>, key: Option<String>) -> ComputerLaunchOutcome {
        self.service.agent_launch_app(name, key).await
    }

    async fn clipboard(&self, op: ClipboardOp) -> ComputerClipboardOutcome {
        self.service.agent_clipboard(op).await
    }

    async fn act(
        &self,
        target_id: &str,
        request: ComputerActRequest,
        delivery: Option<ActDelivery>,
    ) -> ComputerActOutcome {
        self.service.agent_act(target_id, request, delivery).await
    }
}

// -------- The person's side: codeg's Computer use panel ----------------------

/// Everything the panel shows at a glance.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ComputerStatus {
    pub enabled: bool,
    /// `macos` / `windows` / `linux`.
    pub platform: &'static str,
    /// Whether this platform's driver has passed codeg's release matrix.
    /// `false` everywhere until it has; the panel says "preview".
    pub verified_platform: bool,
    pub backend: BackendStatus,
    /// The helper's own permissions, when the helper could be asked.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub permissions: Option<PermissionReport>,
    /// codeg's own TCC standing (macOS only).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub codeg: Option<CodegTccStatus>,
    pub shared: Vec<SharedWindow>,
    /// Whether the share picker offers the entire screen: macOS and
    /// Windows, with its switch on.
    pub screen_offered: bool,
}

/// One window, as the share picker shows it to the person — title and all:
/// it is their own screen.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PickerWindow {
    pub target_id: String,
    pub app_name: String,
    pub app_key: String,
    pub pid: u32,
    pub title: String,
    pub bounds: Rect,
    pub on_screen: bool,
    pub minimized: bool,
    /// Its application is hidden (macOS ⌘H).
    pub hidden: bool,
    pub level: GrantLevel,
    /// Shared with its whole application, not on its own.
    pub whole_app: bool,
    /// That application's share, when it is.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub app_id: Option<String>,
    /// Shared with the entire screen.
    pub whole_screen: bool,
    /// Why it can never be shared, when that is so.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub not_grantable: Option<NotGrantable>,
}

/// `macos` / `windows` / `linux`: the machine whose screen this is.
pub fn platform_name() -> &'static str {
    if cfg!(target_os = "macos") {
        "macos"
    } else if cfg!(windows) {
        "windows"
    } else {
        "linux"
    }
}

/// The computer service the desktop app manages, for its commands.
#[cfg(feature = "tauri-runtime")]
fn service(app: &AppHandle) -> Result<Arc<ComputerService>, AppCommandError> {
    app.try_state::<Arc<ComputerService>>()
        .map(|s| s.inner().clone())
        .ok_or_else(|| AppCommandError::configuration_invalid("computer use is not initialised"))
}

fn backend_error(e: BackendError) -> AppCommandError {
    AppCommandError::configuration_invalid(e.to_string())
}

// The panel's commands. Each is a `_core` function the desktop app's Tauri
// command and codeg-server's HTTP handler (`web::handlers::computer`) both
// call; what only one of them can do — open System Settings, show a file in
// the Finder, size the strip — is the command's own.

pub async fn computer_status_core(
    service: &ComputerService,
) -> Result<ComputerStatus, AppCommandError> {
    let config = service.config.snapshot().await;
    // Asking for the helper's permissions starts the helper, which fetches
    // the driver on first use; only worth doing once the person has switched
    // computer use on.
    let permissions = if config.enabled {
        service.backend.permissions().await.ok()
    } else {
        None
    };
    Ok(ComputerStatus {
        enabled: config.enabled,
        platform: platform_name(),
        verified_platform: false,
        backend: service.backend.status().await,
        permissions,
        codeg: codeg_tcc(),
        shared: service.targets.shared(),
        screen_offered: cfg!(any(target_os = "macos", windows)) && config.screen_enabled,
    })
}

#[cfg(feature = "tauri-runtime")]
#[tauri::command]
pub async fn computer_status(app: AppHandle) -> Result<ComputerStatus, AppCommandError> {
    computer_status_core(&*service(&app)?).await
}

/// What asking for a permission did.
#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionRequestResult {
    /// The helper's permissions once the system had been asked.
    pub report: PermissionReport,
    /// The system put up its own dialog for it, which has a button to the
    /// right pane of System Settings.
    pub prompted: bool,
}

/// Raise the system's request for one permission — that one alone — charged
/// to the helper, and say where that leaves things.
pub async fn computer_request_permission_core(
    service: &ComputerService,
    permission: OsPermission,
) -> Result<PermissionRequestResult, AppCommandError> {
    let PermissionAsked { prompted } = service
        .backend
        .request_permission(permission)
        .await
        .map_err(backend_error)?;
    let report = service.backend.permissions().await.map_err(backend_error)?;
    Ok(PermissionRequestResult { report, prompted })
}

#[cfg(feature = "tauri-runtime")]
#[tauri::command]
pub async fn computer_request_permission(
    app: AppHandle,
    permission: OsPermission,
) -> Result<PermissionRequestResult, AppCommandError> {
    computer_request_permission_core(&*service(&app)?, permission).await
}

/// The System Settings pane for one permission, as a URL; `None` off macOS,
/// where there is no such pane.
pub fn permission_settings_url(permission: OsPermission) -> Option<String> {
    if !cfg!(target_os = "macos") {
        return None;
    }
    let pane = match permission {
        OsPermission::Accessibility => "Privacy_Accessibility",
        OsPermission::ScreenRecording => "Privacy_ScreenCapture",
    };
    Some(format!(
        "x-apple.systempreferences:com.apple.preference.security?{pane}"
    ))
}

/// Open System Settings at the pane for one permission.
#[cfg(feature = "tauri-runtime")]
#[tauri::command]
pub async fn computer_open_permission_settings(
    app: AppHandle,
    permission: OsPermission,
) -> Result<(), AppCommandError> {
    let Some(url) = permission_settings_url(permission) else {
        return Ok(());
    };
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|e| AppCommandError::configuration_invalid(e.to_string()))
}

/// Show codeg-computer-helper in the Finder — for dragging it into System
/// Settings' list by hand, should it not be listed there after a request.
#[cfg(feature = "tauri-runtime")]
#[tauri::command]
pub async fn computer_reveal_helper(app: AppHandle) -> Result<(), AppCommandError> {
    let helper = crate::computer::local::helper_to_reveal()
        .await
        .map_err(backend_error)?;
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .reveal_item_in_dir(helper)
        .map_err(|e| AppCommandError::configuration_invalid(e.to_string()))
}

/// Every window, for the share picker.
pub async fn computer_list_shareable_windows_core(
    service: &ComputerService,
) -> Result<Vec<PickerWindow>, AppCommandError> {
    let config = service.config.snapshot().await;
    if !config.enabled {
        return Ok(Vec::new());
    }
    let blocklist = blocklist_of(&config);
    let _turn = service.turn.lock().await;
    let windows = service
        .backend
        .list_windows(None)
        .await
        .map_err(backend_error)?;
    service.sweep().await;
    let (entries, ended) = service.targets.observe(&windows, None);
    service.announce(&ended);
    Ok(entries
        .into_iter()
        .filter(|e| e.worth_listing())
        .map(|e| {
            let whole_app = e.grant.as_ref().is_some_and(|g| g.scope == GrantScope::App);
            (e, whole_app)
        })
        .map(|(e, whole_app)| PickerWindow {
            whole_screen: e
                .grant
                .as_ref()
                .is_some_and(|g| g.scope == GrantScope::Screen),
            not_grantable: grantable(&e.app, &service.me, &blocklist).err(),
            level: e.grant.as_ref().map_or(GrantLevel::None, |g| g.level),
            app_id: whole_app
                .then(|| service.targets.app_share_of(&e.target_id))
                .flatten()
                .map(|share| share.app_id),
            whole_app,
            app_name: e.app.name.clone(),
            app_key: e.app.key().unwrap_or_default().to_string(),
            pid: e.app.pid,
            title: e.title,
            bounds: e.bounds,
            on_screen: e.on_screen,
            minimized: e.minimized.unwrap_or(false),
            hidden: e.hidden.unwrap_or(false),
            target_id: e.target_id,
        })
        .collect())
}

#[cfg(feature = "tauri-runtime")]
#[tauri::command]
pub async fn computer_list_shareable_windows(
    app: AppHandle,
) -> Result<Vec<PickerWindow>, AppCommandError> {
    computer_list_shareable_windows_core(&*service(&app)?).await
}

/// A small picture of one window for the picker, as a `data:` URL. Never for
/// a window that can never be shared — there is no decision to make about it
/// — nor for a minimized one, or one whose application is hidden, which shows
/// nothing to capture (the helper refuses one it finds so since the list was
/// read).
pub async fn computer_window_thumbnail_core(
    service: &ComputerService,
    target_id: &str,
) -> Result<Option<String>, AppCommandError> {
    let config = service.config.snapshot().await;
    let Some(entry) = service.targets.get(target_id) else {
        return Ok(None);
    };
    if !config.enabled
        || entry.gone
        || entry.minimized == Some(true)
        || entry.hidden == Some(true)
        || grantable(&entry.app, &service.me, &blocklist_of(&config)).is_err()
    {
        return Ok(None);
    }
    let _turn = service.turn.lock().await;
    match service
        .backend
        .capture(entry.identity.pid, entry.identity.window_id, Some(480))
        .await
    {
        Ok(raw) => Ok(Some(format!("data:image/png;base64,{}", raw.png_base64))),
        Err(BackendError::PermissionMissing(_))
        | Err(BackendError::NoSuchWindow)
        | Err(BackendError::Refused(ActRefusal::Occluded, _)) => Ok(None),
        Err(e) => Err(backend_error(e)),
    }
}

#[cfg(feature = "tauri-runtime")]
#[tauri::command]
pub async fn computer_window_thumbnail(
    app: AppHandle,
    target_id: String,
) -> Result<Option<String>, AppCommandError> {
    computer_window_thumbnail_core(&*service(&app)?, &target_id).await
}

/// Share one window at `level`, or stop sharing it at `none`.
pub async fn computer_share_window_core(
    service: &ComputerService,
    target_id: &str,
    level: GrantLevel,
) -> Result<Vec<SharedWindow>, AppCommandError> {
    let since = service.stop_count();
    let change = service.share_unless_stopped(target_id, level, since)?;
    service.announce(&change.into_iter().collect::<Vec<_>>());
    Ok(service.targets.shared())
}

#[cfg(feature = "tauri-runtime")]
#[tauri::command]
pub async fn computer_share_window(
    app: AppHandle,
    target_id: String,
    level: GrantLevel,
) -> Result<Vec<SharedWindow>, AppCommandError> {
    computer_share_window_core(&*service(&app)?, &target_id, level).await
}

/// What sharing several windows at once did.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareManyResult {
    pub shared: Vec<SharedWindow>,
    /// How many of the windows named were not shared: closed since the list
    /// was read, or never shareable.
    pub skipped: u32,
}

/// Share every window named at one level — the picker's "all" — each exactly
/// as [`computer_share_window_core`] would share it, one after another,
/// skipping the ones that cannot be. A Stop or a switch-off that lands part
/// way through is decided window by window, under the lock it revokes under:
/// nothing is shared after it (the next share, begun after the Stop, is).
/// Refused outright when the first window already could not be shared for
/// that reason.
pub async fn computer_share_windows_core(
    service: &ComputerService,
    target_ids: &[String],
    level: GrantLevel,
) -> Result<ShareManyResult, AppCommandError> {
    let since = service.stop_count();
    let mut skipped = 0u32;
    for (i, target_id) in target_ids.iter().enumerate() {
        match service.share_unless_stopped(target_id, level, since) {
            // Told as it happens, so a Stop's revocations are never told
            // before a share they undid.
            Ok(change) => service.announce(&change.into_iter().collect::<Vec<_>>()),
            Err(e) if i == 0 && level != GrantLevel::None && !service.sharing_open(since) => {
                return Err(e)
            }
            Err(_) => skipped += 1,
        }
    }
    Ok(ShareManyResult {
        shared: service.targets.shared(),
        skipped,
    })
}

#[cfg(feature = "tauri-runtime")]
#[tauri::command]
pub async fn computer_share_windows(
    app: AppHandle,
    target_ids: Vec<String>,
    level: GrantLevel,
) -> Result<ShareManyResult, AppCommandError> {
    computer_share_windows_core(&*service(&app)?, &target_ids, level).await
}

/// The shared windows — codeg's own state, with no helper to start, for a
/// window that has just loaded.
pub fn computer_shared_state_core(service: &ComputerService) -> SharedState {
    service.shared_state()
}

#[cfg(feature = "tauri-runtime")]
#[tauri::command]
pub async fn computer_shared_state(app: AppHandle) -> Result<SharedState, AppCommandError> {
    Ok(computer_shared_state_core(&*service(&app)?))
}

/// What `computer_shared_state` answers: what `computer://state` carries.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SharedState {
    pub shared: Vec<SharedWindow>,
    /// The applications shared as a whole.
    pub apps: Vec<SharedApp>,
    /// The entire screen, when it is shared.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub screen: Option<SharedScreen>,
}

/// Share the entire screen at `level`, or end its share at `none`. Answers
/// with what is shared now.
pub async fn computer_share_screen_core(
    service: &ComputerService,
    level: GrantLevel,
) -> Result<SharedState, AppCommandError> {
    let since = service.stop_count();
    let change = service.share_screen_unless_stopped(level, since)?;
    service.announce_change(change);
    Ok(service.shared_state())
}

#[cfg(feature = "tauri-runtime")]
#[tauri::command]
pub async fn computer_share_screen(
    app: AppHandle,
    level: GrantLevel,
) -> Result<SharedState, AppCommandError> {
    computer_share_screen_core(&*service(&app)?, level).await
}

/// Share an application as a whole at `level`, or end its share at `none`:
/// the application `target_id` is a window of, or the one shared as
/// `app_id`. Answers with what is shared now.
pub async fn computer_share_app_core(
    service: &ComputerService,
    target_id: Option<&str>,
    app_id: Option<&str>,
    level: GrantLevel,
) -> Result<SharedState, AppCommandError> {
    let target = match (target_id, app_id) {
        (_, Some(app_id)) => AppTarget::Share(app_id),
        (Some(target_id), None) => AppTarget::Window(target_id),
        (None, None) => {
            return Err(AppCommandError::configuration_invalid(
                "name the application by one of its windows or by its share",
            ))
        }
    };
    let since = service.stop_count();
    let change = service.share_app_unless_stopped(target, level, since)?;
    service.announce_change(change);
    Ok(service.shared_state())
}

#[cfg(feature = "tauri-runtime")]
#[tauri::command]
pub async fn computer_share_app(
    app: AppHandle,
    target_id: Option<String>,
    app_id: Option<String>,
    level: GrantLevel,
) -> Result<SharedState, AppCommandError> {
    computer_share_app_core(
        &*service(&app)?,
        target_id.as_deref(),
        app_id.as_deref(),
        level,
    )
    .await
}

/// Stop sharing every window.
pub fn computer_revoke_all_core(service: &ComputerService) {
    let ended = service.targets.revoke_all(GrantChange::Revoked);
    service.announce_change(ended);
}

#[cfg(feature = "tauri-runtime")]
#[tauri::command]
pub async fn computer_revoke_all(app: AppHandle) -> Result<(), AppCommandError> {
    computer_revoke_all_core(&*service(&app)?);
    Ok(())
}

/// Stop: every grant ended, whatever is under way cut off, the driver killed
/// mid-action. Answers once all three are done. Nothing is held after it.
pub async fn computer_stop_core(service: &ComputerService) {
    service.stop().await;
}

#[cfg(feature = "tauri-runtime")]
#[tauri::command]
pub async fn computer_stop(app: AppHandle) -> Result<(), AppCommandError> {
    computer_stop_core(&*service(&app)?).await;
    Ok(())
}

/// Whether the stop shortcut is in force — the same status
/// `computer://stop-key` carries when it changes. Empty where there is none
/// (codeg-server).
pub fn computer_stop_key_status_core(service: &ComputerService) -> StopKeyStatus {
    service.stop_key_status()
}

#[cfg(feature = "tauri-runtime")]
#[tauri::command]
pub async fn computer_stop_key_status(app: AppHandle) -> Result<StopKeyStatus, AppCommandError> {
    Ok(computer_stop_key_status_core(&*service(&app)?))
}

/// cua-driver as Settings shows it: the release this codeg runs, what the
/// cache holds, and anything under way.
pub fn computer_driver_info_core(service: &ComputerService) -> DriverInfo {
    service.drivers.info()
}

#[cfg(feature = "tauri-runtime")]
#[tauri::command]
pub async fn computer_driver_info(app: AppHandle) -> Result<DriverInfo, AppCommandError> {
    Ok(computer_driver_info_core(&*service(&app)?))
}

/// Fetch the release this codeg runs, and clear older ones. Progress travels
/// on `computer://driver`.
pub async fn computer_driver_install_core(
    service: &ComputerService,
) -> Result<DriverInfo, AppCommandError> {
    service
        .drivers
        .install()
        .await
        .map_err(AppCommandError::configuration_invalid)
}

#[cfg(feature = "tauri-runtime")]
#[tauri::command]
pub async fn computer_driver_install(app: AppHandle) -> Result<DriverInfo, AppCommandError> {
    computer_driver_install_core(&*service(&app)?).await
}

/// Remove cua-driver: computer use goes off, the helper stops, every cached
/// release goes.
pub async fn computer_driver_uninstall_core(
    service: &ComputerService,
    conn: &sea_orm::DatabaseConnection,
) -> Result<DriverInfo, AppCommandError> {
    service.uninstall_driver(conn).await
}

#[cfg(feature = "tauri-runtime")]
#[tauri::command]
pub async fn computer_driver_uninstall(
    app: AppHandle,
    db: tauri::State<'_, crate::db::AppDatabase>,
) -> Result<DriverInfo, AppCommandError> {
    computer_driver_uninstall_core(&*service(&app)?, &db.conn).await
}

/// The strip's page, telling how large it drew itself (logical pixels).
#[cfg(feature = "tauri-runtime")]
#[tauri::command]
pub async fn computer_indicator_fit(app: AppHandle, width: f64, height: f64) {
    crate::computer::indicator::fit(&app, width, height);
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A tree is cut on a line boundary, never mid-line, and a cap of 0 or
    /// one the tree fits under leaves it whole.
    #[test]
    fn trees_are_cut_between_lines() {
        let tree = "- [0] AXWindow\n  - [1] AXButton \"Save\"\n  - [2] AXButton \"Cancel\"\n";
        assert_eq!(cut_tree(tree, 0), (tree.to_string(), false));
        assert_eq!(cut_tree(tree, 10_000), (tree.to_string(), false));
        let (cut, truncated) = cut_tree(tree, 40);
        assert!(truncated);
        assert_eq!(cut, "- [0] AXWindow\n  - [1] AXButton \"Save\"\n");
        // Characters, not bytes: a line of CJK is not cut short by its UTF-8
        // length.
        let wide = "- 保存\n- 取消\n";
        assert_eq!(cut_tree(wide, 5), ("- 保存\n".to_string(), true));
    }

    /// Only a codeg that is its own responsible process can leak a grant to
    /// its agents; a development build under a terminal reports the
    /// terminal's grants, which the agents already have.
    #[test]
    fn only_a_self_responsible_codeg_leaks() {
        let status = |a, s, own| CodegTccStatus {
            accessibility: a,
            screen_recording: s,
            self_responsible: own,
        };
        assert!(status(true, false, true).is_leaking());
        assert!(status(false, true, true).is_leaking());
        assert!(!status(false, false, true).is_leaking());
        assert!(!status(true, true, false).is_leaking());
    }

    fn delivery(
        request: &ComputerActRequest,
        requested: Option<ActDelivery>,
        config: &ComputerToolsConfig,
    ) -> Result<ActDelivery, &'static str> {
        delivery_on(
            request,
            requested,
            config,
            crate::computer::keys::Platform::Mac,
        )
        .map_err(|r| r.slug)
    }

    /// An action goes as the agent asked, or as the person set it — the
    /// front only while they allow it, and never for a value or a restore,
    /// which do not come forward at all.
    #[test]
    fn an_action_comes_forward_only_where_the_person_allows_it() {
        use crate::computer::keys::{Chord, Key, Modifiers};
        use crate::computer::types::ActDelivery::{Background, Foreground};
        let key = ComputerActRequest::Key {
            target: None,
            chord: Chord {
                key: Key::Tab,
                modifiers: Modifiers::default(),
            },
            repeat: 1,
        };
        let allowed = ComputerToolsConfig::default();
        assert!(allowed.allow_foreground);
        let off = ComputerToolsConfig {
            allow_foreground: false,
            ..Default::default()
        };
        let by_default = ComputerToolsConfig {
            default_delivery: Foreground,
            ..allowed.clone()
        };
        assert_eq!(delivery(&key, None, &off), Ok(Background));
        assert_eq!(
            delivery(&key, Some(Foreground), &off),
            Err(ERROR_FOREGROUND_NOT_ALLOWED)
        );
        assert_eq!(delivery(&key, Some(Foreground), &allowed), Ok(Foreground));
        assert_eq!(delivery(&key, None, &allowed), Ok(Background));
        assert_eq!(delivery(&key, None, &by_default), Ok(Foreground));
        assert_eq!(
            delivery(&key, Some(Background), &by_default),
            Ok(Background)
        );
        // A default of the front the person has since stopped allowing is
        // the background, not a refusal.
        let revoked = ComputerToolsConfig {
            allow_foreground: false,
            ..by_default.clone()
        };
        assert_eq!(delivery(&key, None, &revoked), Ok(Background));
        let set = ComputerActRequest::SetValue {
            target: crate::computer::types::ElementTarget {
                generation: "1.1".into(),
                index: 3,
            },
            value: "x".into(),
        };
        assert_eq!(delivery(&set, Some(Foreground), &off), Ok(Background));
        assert_eq!(
            delivery(&ComputerActRequest::Restore, None, &by_default),
            Ok(Background)
        );
    }

    /// On Linux a window comes back only by being brought to the front: a
    /// restore goes there where the person allows it, whatever was asked,
    /// and is refused where they do not. Nothing else changes there.
    #[test]
    fn a_restore_on_linux_goes_to_the_front_or_not_at_all() {
        use crate::computer::keys::Platform;
        use crate::computer::types::ActDelivery::{Background, Foreground};
        let on_linux = |request: &ComputerActRequest,
                        requested: Option<ActDelivery>,
                        config: &ComputerToolsConfig| {
            delivery_on(request, requested, config, Platform::Linux).map_err(|r| r.slug)
        };
        let allowed = ComputerToolsConfig::default();
        let off = ComputerToolsConfig {
            allow_foreground: false,
            ..Default::default()
        };
        let restore = ComputerActRequest::Restore;
        assert_eq!(on_linux(&restore, None, &allowed), Ok(Foreground));
        assert_eq!(
            on_linux(&restore, Some(Background), &allowed),
            Ok(Foreground)
        );
        assert_eq!(
            on_linux(&restore, None, &off),
            Err(ERROR_FOREGROUND_NOT_ALLOWED)
        );
        for platform in [Platform::Mac, Platform::Windows] {
            assert_eq!(
                delivery_on(&restore, None, &allowed, platform).map_err(|r| r.slug),
                Ok(Background)
            );
        }
        let set = ComputerActRequest::SetValue {
            target: crate::computer::types::ElementTarget {
                generation: "1.1".into(),
                index: 3,
            },
            value: "x".into(),
        };
        assert_eq!(on_linux(&set, Some(Foreground), &off), Ok(Background));
    }

    /// Only a refusal from the background is ended with what the settings
    /// leave to try — the front where it is allowed, asking where it is not —
    /// and only for an action that can come to the front.
    #[test]
    fn a_background_refusal_ends_with_what_the_settings_leave() {
        let words = "The application would not take it.";
        let refused = |slug| Refusal::failed(slug, words.to_string());
        let scroll = ComputerActRequest::Scroll {
            target: None,
            direction: crate::computer::types::ScrollDirection::Down,
            amount: 1,
            unit: Default::default(),
        };
        let allowed = ComputerToolsConfig {
            allow_foreground: true,
            ..Default::default()
        };
        let next = with_next_step(refused(ERROR_BACKGROUND_UNAVAILABLE), &scroll, &allowed).note;
        assert!(next.starts_with(words), "{next}");
        assert!(next.contains("delivery: \"foreground\""), "{next}");
        let off = ComputerToolsConfig {
            allow_foreground: false,
            ..Default::default()
        };
        let next = with_next_step(refused(ERROR_BACKGROUND_UNAVAILABLE), &scroll, &off).note;
        assert!(!next.contains("delivery: \"foreground\""), "{next}");
        assert!(next.contains("ask them"), "{next}");
        assert_eq!(
            with_next_step(refused(ERROR_OCCLUDED), &scroll, &allowed).note,
            words
        );
        let restore = ComputerActRequest::Restore;
        assert_eq!(
            with_next_step(refused(ERROR_BACKGROUND_UNAVAILABLE), &restore, &allowed).note,
            words
        );
    }
}
