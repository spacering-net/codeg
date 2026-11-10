//! codeg's table of the windows it has named to an agent, with the grant on
//! each.
//!
//! A browser tab is an object codeg owns, so its grant can live on the tab. A
//! native window is not — it belongs to another process and codeg only ever
//! sees it through the helper — so this table is the object the grant lives
//! on: one entry per window codeg has handed out a `targetId` for, keyed by
//! the window's identity, with the grant, the grant epoch and the read counter
//! under the same lock. "Is this still the window that was shared" and "is it
//! still shared" are then one question asked in one place.
//!
//! **Identity is `(pid, process start time, window id)`.** A pid alone is
//! reused; an application relaunched is a new process whose windows were never
//! shared, even when they look the same. A window whose identity no longer
//! turns up in a listing is gone, and so is its grant. Where another process
//! draws what is inside a window — a packaged application inside the frame
//! Windows draws for it — that process's run is part of the identity too:
//! the frame is that run's window, and another run of it in the same frame is
//! another window.
//!
//! **An application can be shared as a whole** ([`AppIdentity`]): every window
//! of it then carries the application's grant ([`GrantScope::App`]) — the
//! ones it opens later too, as listings find them — and the application's
//! one clock, which any of them being used keeps running. Ending the
//! application's grant ends every window's share of it; a window's share
//! cannot be changed on its own while the application is shared.
//!
//! **So can the entire screen** ([`ScreenShare`]), the same way one level up:
//! every window the rules allow carries the screen's grant
//! ([`GrantScope::Screen`]) and its clock, and the screen itself is a target
//! of its own ([`SCREEN_TARGET_ID`]) — one picture of it, and pointer actions
//! at points on it. Sharing the screen takes over whatever was shared before
//! it; nothing else is shared or unshared while it is.

use std::collections::{BTreeSet, HashMap};
use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};

use super::agent::{
    generation, grantable, level_of, visible_title, Blocklist, ComputerGrant, ComputerGrantPayload,
    GrantChange, GrantLevel, GrantScope, NotGrantable, SelfIdentity,
};
use super::keys::{classify, classify_for_app, classify_for_screen, Chord, ChordClass, Platform};
use super::protocol::{
    DriverTarget, ElementRef, ProcessRun, RawAct, RawApp, RawWindow, ScreenGeometry, WindowAction,
    WindowPoint,
};
use super::types::{
    AgentAppRef, AgentTarget, AgentWindowSummary, ComputerActRequest, ElementTarget, PointTarget,
    Rect,
};

/// Which window, exactly. See the module note.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowIdentity {
    pub pid: u32,
    /// `None` when the platform would not say; such a window is still
    /// listed, and matched on the other two fields alone.
    pub started_at: Option<u64>,
    pub window_id: u64,
    /// The run of the process drawing inside the window, where that is not
    /// its owner (`RawWindow::content`). See the module note.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content: Option<ProcessRun>,
}

impl WindowIdentity {
    fn of(window: &RawWindow) -> Self {
        Self {
            pid: window.pid,
            started_at: window.app.started_at,
            window_id: window.window_id,
            content: window.content,
        }
    }
}

/// One window codeg has named.
#[derive(Debug, Clone, PartialEq)]
pub struct TargetEntry {
    pub target_id: String,
    pub identity: WindowIdentity,
    pub app: RawApp,
    /// The title as last seen. Handed to an agent only through
    /// [`visible_title`]; shown to the person in codeg's own UI.
    pub title: String,
    pub bounds: Rect,
    pub on_screen: bool,
    pub minimized: Option<bool>,
    /// macOS: its application is hidden (⌘H).
    pub hidden: Option<bool>,
    pub on_current_space: Option<bool>,
    pub grant: Option<ComputerGrant>,
    /// Moves on every transition into or out of a grant, so a generation
    /// minted under one grant never names a read made under another.
    pub epoch: u64,
    /// Reads completed under the current epoch.
    pub reads: u64,
    /// The latest snapshot read under the current grant: what a ref is
    /// resolved against.
    pub snapshot_mark: Option<SnapshotMark>,
    /// The latest screenshot read under the current grant: what a point is
    /// read in.
    pub capture_mark: Option<CaptureMark>,
    /// The window stopped turning up while it was shared. Kept, grant-less,
    /// so a later call on its id is told "not shared" — the same answer as a
    /// window nobody shared, as the browser answers for a tab that navigated
    /// away — rather than "no such window", which would make an id that was
    /// once valid look like one the agent invented.
    pub gone: bool,
}

impl TargetEntry {
    /// Whether this window belongs in a listing: on screen, minimized, hidden
    /// with its application, on another Space, or shared. What that leaves out is the invisible
    /// furniture every desktop is full of — an application's hidden helper
    /// windows, the Finder's off-screen desktop strips — which nobody means to
    /// share and a picker full of would hide the ones they do. A shared window
    /// stays listed whatever its visibility (its application may just be
    /// hidden), so that its sharing is never out of sight.
    pub fn worth_listing(&self) -> bool {
        self.on_screen
            || self.minimized == Some(true)
            || self.hidden == Some(true)
            || self.on_current_space == Some(false)
            || self.grant.is_some()
    }

    /// The window as an agent may see it.
    pub fn agent_summary(&self, me: &SelfIdentity, blocklist: &Blocklist) -> AgentWindowSummary {
        let level = level_of(self.grant.as_ref());
        AgentWindowSummary {
            target_id: self.target_id.clone(),
            app: AgentAppRef {
                key: self.app.key().unwrap_or_default().to_string(),
                name: self.app.name.clone(),
                pid: self.app.pid,
            },
            bounds: self.bounds,
            on_screen: self.on_screen,
            minimized: self.minimized,
            hidden: self.hidden,
            level,
            whole_app: self
                .grant
                .as_ref()
                .is_some_and(|g| g.scope == GrantScope::App),
            whole_screen: self
                .grant
                .as_ref()
                .is_some_and(|g| g.scope == GrantScope::Screen),
            title: visible_title(level, &self.title),
            note: grantable(&self.app, me, blocklist)
                .err()
                .map(|why| why.note().to_string()),
        }
    }
}

/// A shared window, for codeg's own UI.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SharedWindow {
    pub target_id: String,
    pub app_name: String,
    pub app_key: String,
    pub title: String,
    pub level: GrantLevel,
    pub granted_at: i64,
    pub last_used_at: i64,
    /// Shared with its whole application ([`SharedApp`]), not on its own.
    #[serde(default)]
    pub whole_app: bool,
    /// The share of that application, when it is.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub app_id: Option<String>,
    /// Shared with the entire screen ([`SharedScreen`]).
    #[serde(default)]
    pub whole_screen: bool,
}

/// Which application, exactly: the run of the process that owns its
/// windows, which application that is (a frame host is several), and the run
/// drawing inside its frames where another process does. An application
/// relaunched is another one, never shared.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct AppIdentity {
    pub pid: u32,
    pub started_at: u64,
    pub key: String,
    pub content: Option<ProcessRun>,
}

impl AppIdentity {
    /// The application `entry` is a window of; `None` for one that cannot be
    /// told (see [`NotGrantable::Unidentified`]).
    pub fn of(entry: &TargetEntry) -> Option<Self> {
        Some(Self {
            pid: entry.identity.pid,
            started_at: entry.identity.started_at?,
            key: entry.app.key()?.to_string(),
            content: entry.identity.content,
        })
    }

    /// Whether `app`, as a listing of applications names it, is this one.
    fn names(&self, app: &RawApp) -> bool {
        self.content.is_none()
            && app.pid == self.pid
            && app.started_at == Some(self.started_at)
            && app.key() == Some(self.key.as_str())
    }
}

/// An application shared as a whole.
#[derive(Debug, Clone, PartialEq)]
pub struct AppShare {
    /// codeg's own name for the share, for the panel to change or end it by.
    pub app_id: String,
    /// Its clock is the application's: any window of it being used moves it.
    pub grant: ComputerGrant,
    pub app: RawApp,
}

/// An application shared as a whole, for codeg's own UI.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SharedApp {
    pub app_id: String,
    pub app_name: String,
    pub app_key: String,
    pub level: GrantLevel,
    pub granted_at: i64,
    pub last_used_at: i64,
    /// How many of its windows are shared with it now.
    pub windows: u32,
}

/// The id the entire screen goes by among targets: what an agent reads and
/// points at while the person shares the screen as a whole.
pub const SCREEN_TARGET_ID: &str = "d1";

/// The entire screen, shared as a whole.
#[derive(Debug, Clone)]
pub struct ScreenShare {
    /// Its clock is the screen's: the screen, or any window shared with it,
    /// being used moves it.
    pub grant: ComputerGrant,
    /// See [`TargetEntry::epoch`]: a new one for every sharing of the
    /// screen, so a picture read under one never names a point under the
    /// next.
    pub epoch: u64,
    /// Pictures of the screen read under this sharing.
    pub reads: u64,
    /// The latest picture of the screen read under it: what a point on the
    /// screen is read in.
    pub capture_mark: Option<CaptureMark>,
    /// The rules as they stood when the sharing last followed them — shared,
    /// or swept: what a window a later listing finds is judged by before it
    /// takes the screen's grant.
    me: SelfIdentity,
    blocklist: Blocklist,
}

/// The entire screen shared, for codeg's own UI.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SharedScreen {
    pub level: GrantLevel,
    pub granted_at: i64,
    pub last_used_at: i64,
    /// How many windows are shared with it now.
    pub windows: u32,
}

/// Permission for one read of the entire screen, taken before the read and
/// checked again after.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ScreenReadTicket {
    pub epoch: u64,
}

/// Permission for one action on the entire screen, with the action as the
/// helper is to carry it out: every point resolved against the latest
/// picture of the screen, as the agent was given it.
#[derive(Debug, Clone, PartialEq)]
pub struct ScreenActTicket {
    /// The sharing the action was let through under.
    pub epoch: u64,
    pub action: WindowAction,
    /// The screen as the picture the points were read off was taken.
    pub geometry: ScreenGeometry,
}

/// The latest snapshot an agent read of a window: the generation that named
/// it, and which of its elements the agent may now act on.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SnapshotMark {
    pub generation: String,
    /// The driver's id for the snapshot; `None` when it kept none, and
    /// nothing in the tree can be acted on.
    pub snapshot_id: Option<String>,
    /// The refs whose lines the agent was given.
    pub shown: BTreeSet<u32>,
    /// The refs the tree had and the agent's copy was cut short of
    /// (`maxChars`): told apart from refs that never were, so the refusal can
    /// say which.
    pub cut: BTreeSet<u32>,
    /// The refs of secret fields.
    pub secret: BTreeSet<u32>,
}

/// The latest screenshot an agent read of a window: the generation that
/// named it, and the geometry a point read off it is mapped back through.
#[derive(Debug, Clone, PartialEq)]
pub struct CaptureMark {
    pub generation: String,
    /// The image as the agent got it.
    pub width: u32,
    pub height: u32,
    /// The window's own pixels, which the image was shrunk from.
    pub native_width: u32,
    pub native_height: u32,
    /// Whether the native size is known to be the window's full size (see
    /// `RawCapture::full_size`). Points need it.
    pub full_size: bool,
    pub window_bounds: Rect,
}

/// What a read leaves behind for later actions, before it has a generation.
#[derive(Debug, Clone, PartialEq)]
pub enum ReadMark {
    Snapshot {
        snapshot_id: Option<String>,
        shown: BTreeSet<u32>,
        cut: BTreeSet<u32>,
        secret: BTreeSet<u32>,
    },
    Capture {
        width: u32,
        height: u32,
        native_width: u32,
        native_height: u32,
        full_size: bool,
        window_bounds: Rect,
    },
}

/// Why a read may not go ahead.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReadRefusal {
    /// codeg never named a window by this id.
    NoSuchTarget,
    /// The window is not shared — never was, no longer is, or has gone.
    GrantRequired,
    /// The window can never be shared.
    NotGrantable(NotGrantable),
}

/// Permission for one read, taken before the read and checked again after.
#[derive(Debug, Clone, PartialEq)]
pub struct ReadTicket {
    pub target_id: String,
    pub identity: WindowIdentity,
    pub epoch: u64,
    pub app: RawApp,
    pub bounds: Rect,
    /// Shared on its own, or with its application — whose menus a read then
    /// takes in too.
    pub scope: GrantScope,
}

/// Why an action may not go ahead, before anything is sent.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ActDenied {
    /// codeg never named a window by this id.
    NoSuchTarget,
    /// Not shared — never was, no longer is, or gone.
    GrantRequired,
    /// Shared for reading only.
    ControlRequired,
    /// The window can never be shared.
    NotGrantable(NotGrantable),
    /// A ref or point that is not from the window's latest snapshot or
    /// screenshot, or not in it.
    Stale(Staleness),
    /// A point outside the image it was read off.
    OutOfImage,
    /// Text into a secret field.
    Secret,
    /// A key a window grant does not reach — it acts on the application or
    /// the desktop.
    ChordBeyond,
    /// A paste: the clipboard is the user's, and its source is not tracked.
    Paste,
    /// A character key with no element named to type it into.
    NeedsElement,
    /// The screenshot the point came from cannot be mapped back to the
    /// window's pixels.
    NoPointing,
    /// Keys held over a drag where the driver would drag without them.
    DragModifiers,
    /// Keys held over a double-click in a window, which the driver's
    /// double-click does not hold (macOS and Linux refuse them, Windows
    /// double-clicks without them).
    DoubleClickModifiers,
    /// A key that is the desktop's own, which not even a grant on the whole
    /// application reaches.
    DesktopChord,
    /// Something only an application shared as a whole allows — its menus.
    AppGrantRequired,
    /// A menu command on a system whose driver cannot choose one (Windows).
    MenusUnavailable,
    /// A frame no window can have: a side under the smallest, or a number
    /// out of range.
    BadFrame,
    /// A key that locks the screen or logs out, which no sharing reaches —
    /// not even the entire screen's.
    SessionChord,
    /// Asked of the entire screen, something other than a click, a drag or a
    /// scroll at a point of its picture: keys, typing and the rest go to a
    /// window.
    ScreenPointerOnly,
}

/// How a ref or point is out of date.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Staleness {
    /// No snapshot has been read under the current sharing.
    NoSnapshot,
    /// The generation is not the latest snapshot's.
    OldSnapshot,
    /// The driver kept no snapshot of the window: nothing in the tree can be
    /// acted on.
    NotActionable,
    /// The ref was in the tree, past where the agent's copy was cut.
    CutAway(u32),
    /// The latest snapshot has no such ref.
    NoSuchRef(u32),
    /// No screenshot has been read under the current sharing.
    NoCapture,
    /// The generation is not the latest screenshot's.
    OldCapture,
}

/// Permission for one action, with the action as the helper is to carry it
/// out: every ref and point resolved against what the agent last read.
#[derive(Debug, Clone, PartialEq)]
pub struct ActTicket {
    pub target_id: String,
    pub identity: WindowIdentity,
    /// The sharing the action was let through under (see
    /// [`TargetEntry::epoch`]): a key pressed again and again is held to the
    /// sharing its first press went out under.
    pub epoch: u64,
    pub app: RawApp,
    pub action: WindowAction,
    pub aim: Aim,
}

/// Where on the screen an action lands, as far as codeg can place it once
/// the helper says where it aimed. For the marker that shows the person
/// where an agent acted; nothing is decided by it.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Aim {
    /// Wherever the window's focus is: a key with no element, a scroll with
    /// no target.
    Focus,
    /// At the element, where its snapshot found it.
    Element,
    /// This far from the window's top-left corner, in desktop units.
    Offset { x: f64, y: f64 },
}

impl Aim {
    /// Where `action` lands, from what the agent last read of the window:
    /// for a point, the screenshot's pixels scaled to the window's units.
    fn of(entry: &TargetEntry, action: &WindowAction) -> Aim {
        if action.element().is_some() {
            return Aim::Element;
        }
        match (action.point(), entry.capture_mark.as_ref()) {
            (Some(point), Some(mark)) if mark.native_width > 0 && mark.native_height > 0 => {
                Aim::Offset {
                    x: point.x * point.window_width / f64::from(mark.native_width),
                    y: point.y * point.window_height / f64::from(mark.native_height),
                }
            }
            _ => Aim::Focus,
        }
    }

    /// The point on the screen, in desktop units, from what the helper
    /// reported of the action: the middle of the element's frame, or the
    /// offset from where the window was measured to be.
    pub fn landing(&self, act: &RawAct) -> Option<(f64, f64)> {
        let placed = |r: &Rect| !r.is_empty() && r.x.is_finite() && r.y.is_finite();
        match *self {
            Aim::Focus => None,
            Aim::Element => act
                .element_frame
                .filter(placed)
                .map(|f| (f.x + f.width / 2.0, f.y + f.height / 2.0)),
            Aim::Offset { x, y } => act.window_frame.filter(placed).map(|w| (w.x + x, w.y + y)),
        }
    }
}

/// Why a share did not happen.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ShareError {
    NoSuchTarget,
    Gone,
    NotGrantable(NotGrantable),
    /// The window is shared with its whole application: what it is shared
    /// for is the application's, and changes with it.
    AppShared,
    /// The entire screen is shared: what any window or application is shared
    /// for is the screen's, and changes with it.
    ScreenShared,
}

/// What sharing an application or the entire screen, or ending its share,
/// changed: the windows whose share moved with it, and whether a share beyond
/// the windows' own — an application's, or the screen's — did.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct AppChange {
    pub windows: Vec<ComputerGrantPayload>,
    pub app_changed: bool,
}

#[derive(Default)]
struct Inner {
    next_id: u64,
    entries: HashMap<String, TargetEntry>,
    by_identity: HashMap<WindowIdentity, String>,
    next_app_id: u64,
    apps: HashMap<AppIdentity, AppShare>,
    screen: Option<ScreenShare>,
    /// Sharings of the screen so far: each one's epoch.
    screen_epochs: u64,
}

/// See the module note.
#[derive(Default)]
pub struct TargetTable {
    inner: Mutex<Inner>,
}

impl TargetTable {
    pub fn new() -> Self {
        Self::default()
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        // A panic while holding this lock cannot leave a half-written entry
        // (every mutation is a field store), so a poisoned lock is still a
        // consistent table.
        self.inner.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// Take in a fresh listing: name every window in it, update what codeg
    /// knows about the ones it had named, and let go of the rest.
    ///
    /// `scope_pid` is the filter the listing was made with. Only windows in
    /// that scope can be judged missing from it — a listing of one
    /// application's windows says nothing about anyone else's.
    ///
    /// Returns the entries for the listed windows, in listing order, and the
    /// grants that changed: ended because their window is gone, or begun
    /// because the window's application is shared as a whole.
    pub fn observe(
        &self,
        windows: &[RawWindow],
        scope_pid: Option<u32>,
    ) -> (Vec<TargetEntry>, Vec<ComputerGrantPayload>) {
        let mut inner = self.lock();
        let mut seen: Vec<String> = Vec::with_capacity(windows.len());
        for window in windows {
            let identity = WindowIdentity::of(window);
            let target_id = match inner.by_identity.get(&identity) {
                Some(id) => id.clone(),
                None => {
                    inner.next_id += 1;
                    let id = format!("w{}", inner.next_id);
                    inner.by_identity.insert(identity, id.clone());
                    inner.entries.insert(
                        id.clone(),
                        TargetEntry {
                            target_id: id.clone(),
                            identity,
                            app: window.app.clone(),
                            title: String::new(),
                            bounds: Rect::default(),
                            on_screen: false,
                            minimized: None,
                            hidden: None,
                            on_current_space: None,
                            grant: None,
                            epoch: 0,
                            reads: 0,
                            snapshot_mark: None,
                            capture_mark: None,
                            gone: false,
                        },
                    );
                    id
                }
            };
            if let Some(entry) = inner.entries.get_mut(&target_id) {
                entry.app = window.app.clone();
                // An empty title is the platform withholding it (no Screen
                // Recording yet), not the window losing its name: keep the
                // last one the person could have seen.
                if !window.title.is_empty() {
                    entry.title = window.title.clone();
                }
                entry.bounds = window.bounds;
                entry.on_screen = window.on_screen;
                entry.minimized = window.minimized;
                entry.hidden = window.hidden;
                entry.on_current_space = window.on_current_space;
            }
            seen.push(target_id);
        }

        let in_scope = |entry: &TargetEntry| scope_pid.is_none_or(|pid| entry.identity.pid == pid);
        let missing: Vec<String> = inner
            .entries
            .values()
            .filter(|e| !e.gone && in_scope(e) && !seen.contains(&e.target_id))
            .map(|e| e.target_id.clone())
            .collect();
        let mut ended = Vec::new();
        for id in missing {
            if let Some(payload) = Self::retire(&mut inner, &id, GrantChange::TargetChanged) {
                ended.push(payload);
            }
        }
        // A window of an application shared as a whole is shared with it as
        // soon as a listing finds it a window a person could mean; with the
        // entire screen shared, so is any window the rules allow.
        {
            let Inner {
                entries,
                apps,
                screen,
                ..
            } = &mut *inner;
            for id in &seen {
                let Some(entry) = entries.get_mut(id) else {
                    continue;
                };
                if entry.grant.is_some() || entry.gone || !entry.worth_listing() {
                    continue;
                }
                if let Some(share) = AppIdentity::of(entry).and_then(|app| apps.get(&app)) {
                    ended.extend(Self::grant_with(entry, &share.grant));
                } else if let Some(share) = screen.as_ref() {
                    if grantable(&entry.app, &share.me, &share.blocklist).is_ok() {
                        ended.extend(Self::grant_with(entry, &share.grant));
                    }
                }
            }
        }

        let entries = seen
            .iter()
            .filter_map(|id| inner.entries.get(id).cloned())
            .collect();
        (entries, ended)
    }

    /// A window is gone. A shared one keeps a grant-less entry (see
    /// [`TargetEntry::gone`]); an unshared one is forgotten.
    ///
    /// Idempotent, and it touches only what is this entry's own: a late
    /// "window gone" for an id that has already been retired — an operation
    /// that started before a listing retired it — leaves the entry, and the
    /// identity now named by a newer id, alone.
    fn retire(
        inner: &mut Inner,
        target_id: &str,
        change: GrantChange,
    ) -> Option<ComputerGrantPayload> {
        let entry = inner.entries.get_mut(target_id)?;
        if entry.gone {
            return None;
        }
        let identity = entry.identity;
        if inner.by_identity.get(&identity).map(String::as_str) == Some(target_id) {
            inner.by_identity.remove(&identity);
        }
        let entry = inner.entries.get_mut(target_id)?;
        if entry.grant.is_some() {
            entry.grant = None;
            entry.gone = true;
            entry.epoch += 1;
            entry.snapshot_mark = None;
            entry.capture_mark = None;
            Some(ComputerGrantPayload {
                target_id: target_id.to_string(),
                change,
                level: GrantLevel::None,
            })
        } else {
            inner.entries.remove(target_id);
            None
        }
    }

    /// The window a target id names, if codeg named one.
    pub fn get(&self, target_id: &str) -> Option<TargetEntry> {
        self.lock().entries.get(target_id).cloned()
    }

    /// Share a window at `level`, or stop sharing it at [`GrantLevel::None`].
    ///
    /// `Ok(None)` when nothing changed — the window was already at that level
    /// — so the caller neither emits an event nor restarts the idle clock. A
    /// window shared with its whole application changes only with it
    /// ([`ShareError::AppShared`]); every window, while the entire screen is
    /// shared, only with the screen ([`ShareError::ScreenShared`]).
    pub fn share(
        &self,
        target_id: &str,
        level: GrantLevel,
        now: i64,
        me: &SelfIdentity,
        blocklist: &Blocklist,
    ) -> Result<Option<ComputerGrantPayload>, ShareError> {
        let mut inner = self.lock();
        let Inner {
            entries,
            apps,
            screen,
            ..
        } = &mut *inner;
        if screen.is_some() {
            return Err(ShareError::ScreenShared);
        }
        let entry = entries.get_mut(target_id).ok_or(ShareError::NoSuchTarget)?;
        let with_app = entry
            .grant
            .as_ref()
            .is_some_and(|g| g.scope == GrantScope::App)
            || (!entry.gone && AppIdentity::of(entry).is_some_and(|app| apps.contains_key(&app)));
        if with_app {
            return Err(ShareError::AppShared);
        }
        if level == GrantLevel::None {
            return Ok(Self::revoke_entry(entry, GrantChange::Revoked));
        }
        if entry.gone {
            return Err(ShareError::Gone);
        }
        grantable(&entry.app, me, blocklist).map_err(ShareError::NotGrantable)?;
        if level_of(entry.grant.as_ref()) == level {
            return Ok(None);
        }
        match entry.grant.as_mut() {
            // A change of level on a live grant is the same grant: the reads
            // already made under it stay valid, and the clock keeps running
            // from the last one.
            Some(grant) => grant.level = level,
            None => {
                entry.grant = Some(ComputerGrant::new(level, now));
                entry.epoch += 1;
                entry.reads = 0;
                entry.snapshot_mark = None;
                entry.capture_mark = None;
            }
        }
        Ok(Some(ComputerGrantPayload {
            target_id: target_id.to_string(),
            change: GrantChange::Granted,
            level,
        }))
    }

    /// Share an application as a whole at `level` — the one `target` names —
    /// or end its share at [`GrantLevel::None`]. Every window of it codeg has
    /// named and a person could mean takes the application's grant at its
    /// level, one shared on its own before included; the ones it opens later
    /// take it as listings find them. Ending it ends every window's share of
    /// it. Nothing changes while the entire screen is shared
    /// ([`ShareError::ScreenShared`]).
    pub fn share_app(
        &self,
        target: AppTarget<'_>,
        level: GrantLevel,
        now: i64,
        me: &SelfIdentity,
        blocklist: &Blocklist,
    ) -> Result<AppChange, ShareError> {
        let mut inner = self.lock();
        let Inner {
            entries,
            apps,
            next_app_id,
            screen,
            ..
        } = &mut *inner;
        if screen.is_some() {
            return Err(ShareError::ScreenShared);
        }
        let (identity, app) = match target {
            AppTarget::Window(target_id) => {
                let entry = entries.get(target_id).ok_or(ShareError::NoSuchTarget)?;
                if entry.gone {
                    return Err(ShareError::Gone);
                }
                let identity = AppIdentity::of(entry)
                    .ok_or(ShareError::NotGrantable(NotGrantable::Unidentified))?;
                (identity, entry.app.clone())
            }
            AppTarget::Share(app_id) => match apps.iter().find(|(_, s)| s.app_id == app_id) {
                Some((identity, share)) => (identity.clone(), share.app.clone()),
                None if level == GrantLevel::None => return Ok(AppChange::default()),
                None => return Err(ShareError::NoSuchTarget),
            },
        };
        if level == GrantLevel::None {
            return Ok(Self::end_app(
                entries,
                apps,
                &identity,
                GrantChange::Revoked,
            ));
        }
        grantable(&app, me, blocklist).map_err(ShareError::NotGrantable)?;
        let app_changed = match apps.get_mut(&identity) {
            Some(share) if share.grant.level == level => false,
            // The same share at another level: its clock keeps running.
            Some(share) => {
                share.grant.level = level;
                true
            }
            None => {
                *next_app_id += 1;
                apps.insert(
                    identity.clone(),
                    AppShare {
                        app_id: format!("a{next_app_id}"),
                        grant: ComputerGrant::of_app(level, now),
                        app,
                    },
                );
                true
            }
        };
        let Some(share) = apps.get(&identity) else {
            return Ok(AppChange::default());
        };
        let windows = entries
            .values_mut()
            .filter(|e| !e.gone && (e.grant.is_some() || e.worth_listing()))
            .filter(|e| AppIdentity::of(e).as_ref() == Some(&identity))
            .filter_map(|e| Self::grant_with(e, &share.grant))
            .collect();
        Ok(AppChange {
            windows,
            app_changed,
        })
    }

    /// Give `entry` its share of a grant on more than itself — its whole
    /// application's, or the entire screen's — at that grant's level, in its
    /// scope and on its clock. A window already shared keeps the reads made
    /// under its grant, as a change of level does.
    fn grant_with(entry: &mut TargetEntry, shared: &ComputerGrant) -> Option<ComputerGrantPayload> {
        let (level, scope) = (shared.level, shared.scope);
        match entry.grant.as_mut() {
            Some(grant) if grant.scope == scope && grant.level == level => return None,
            Some(grant) => {
                grant.level = level;
                grant.scope = scope;
            }
            None => {
                entry.grant = Some(shared.clone());
                entry.epoch += 1;
                entry.reads = 0;
                entry.snapshot_mark = None;
                entry.capture_mark = None;
            }
        }
        Some(ComputerGrantPayload {
            target_id: entry.target_id.clone(),
            change: GrantChange::Granted,
            level,
        })
    }

    /// End the share of application `identity`, and every window's share of
    /// it.
    fn end_app(
        entries: &mut HashMap<String, TargetEntry>,
        apps: &mut HashMap<AppIdentity, AppShare>,
        identity: &AppIdentity,
        change: GrantChange,
    ) -> AppChange {
        let app_changed = apps.remove(identity).is_some();
        let windows = entries
            .values_mut()
            .filter(|e| AppIdentity::of(e).as_ref() == Some(identity))
            .filter_map(|e| Self::revoke_entry(e, change))
            .collect();
        AppChange {
            windows,
            app_changed,
        }
    }

    /// Share the entire screen at `level`, or end its share at
    /// [`GrantLevel::None`]. Every window codeg has named that a person could
    /// mean and the rules allow takes the screen's grant at its level — one
    /// shared on its own, or with its application, included: the
    /// applications shared as a whole are shared with the screen from then
    /// on, and their own shares end. The windows that come up later take it
    /// as listings find them. Ending it ends every window's share of it.
    pub fn share_screen(
        &self,
        level: GrantLevel,
        now: i64,
        me: &SelfIdentity,
        blocklist: &Blocklist,
    ) -> AppChange {
        let mut inner = self.lock();
        let Inner {
            entries,
            apps,
            screen,
            screen_epochs,
            ..
        } = &mut *inner;
        if level == GrantLevel::None {
            return Self::end_screen(entries, screen, GrantChange::Revoked);
        }
        let mut out = AppChange::default();
        match screen.as_mut() {
            Some(share) => {
                // The same sharing at another level: its clock keeps running.
                if share.grant.level != level {
                    share.grant.level = level;
                    out.app_changed = true;
                }
                share.me = me.clone();
                share.blocklist = blocklist.clone();
            }
            None => {
                *screen_epochs += 1;
                *screen = Some(ScreenShare {
                    grant: ComputerGrant::of_screen(level, now),
                    epoch: *screen_epochs,
                    reads: 0,
                    capture_mark: None,
                    me: me.clone(),
                    blocklist: blocklist.clone(),
                });
                out.app_changed = true;
            }
        }
        if !apps.is_empty() {
            apps.clear();
            out.app_changed = true;
        }
        let Some(share) = screen.as_ref() else {
            return out;
        };
        for entry in entries.values_mut() {
            let shareable = !entry.gone
                && (entry.grant.is_some() || entry.worth_listing())
                && grantable(&entry.app, me, blocklist).is_ok();
            if shareable {
                out.windows.extend(Self::grant_with(entry, &share.grant));
            }
        }
        out
    }

    /// End the share of the entire screen, for `change` — the switch for it
    /// turned off — and every window's share of it.
    pub fn end_screen_share(&self, change: GrantChange) -> AppChange {
        let mut inner = self.lock();
        let Inner {
            entries, screen, ..
        } = &mut *inner;
        Self::end_screen(entries, screen, change)
    }

    /// End the share of the entire screen, and every window's share of it.
    fn end_screen(
        entries: &mut HashMap<String, TargetEntry>,
        screen: &mut Option<ScreenShare>,
        change: GrantChange,
    ) -> AppChange {
        let app_changed = screen.take().is_some();
        let windows = entries
            .values_mut()
            .filter(|e| {
                e.grant
                    .as_ref()
                    .is_some_and(|g| g.scope == GrantScope::Screen)
            })
            .filter_map(|e| Self::revoke_entry(e, change))
            .collect();
        AppChange {
            windows,
            app_changed,
        }
    }

    /// End the grant `target_id` holds: its own, or — for a window shared
    /// with its whole application — the application's, with every window's
    /// share of it. A window shared with the entire screen loses its share of
    /// it alone, unless the screen's own time is up (`Expired`), which ends
    /// the screen's share.
    fn end_grant(
        entries: &mut HashMap<String, TargetEntry>,
        apps: &mut HashMap<AppIdentity, AppShare>,
        screen: &mut Option<ScreenShare>,
        target_id: &str,
        change: GrantChange,
    ) -> Vec<ComputerGrantPayload> {
        let Some(entry) = entries.get_mut(target_id) else {
            return Vec::new();
        };
        match entry.grant.as_ref().map(|g| g.scope) {
            Some(GrantScope::App) => match AppIdentity::of(entry) {
                Some(app) => Self::end_app(entries, apps, &app, change).windows,
                None => Self::revoke_entry(entry, change).into_iter().collect(),
            },
            Some(GrantScope::Screen) if change == GrantChange::Expired => {
                Self::end_screen(entries, screen, change).windows
            }
            _ => Self::revoke_entry(entry, change).into_iter().collect(),
        }
    }

    fn revoke_entry(entry: &mut TargetEntry, change: GrantChange) -> Option<ComputerGrantPayload> {
        entry.grant.take()?;
        entry.epoch += 1;
        entry.snapshot_mark = None;
        entry.capture_mark = None;
        Some(ComputerGrantPayload {
            target_id: entry.target_id.clone(),
            change,
            level: GrantLevel::None,
        })
    }

    /// End every grant, for one reason — the applications shared as a whole
    /// and the entire screen with them. Used when the user switches computer
    /// use off, which is a statement about every window at once, and for
    /// Stop.
    pub fn revoke_all(&self, change: GrantChange) -> AppChange {
        let mut inner = self.lock();
        let app_changed = !inner.apps.is_empty() || inner.screen.is_some();
        inner.apps.clear();
        inner.screen = None;
        let windows = inner
            .entries
            .values_mut()
            .filter_map(|entry| Self::revoke_entry(entry, change))
            .collect();
        AppChange {
            windows,
            app_changed,
        }
    }

    /// The window is not the one that was shared any more (it closed, or its
    /// process is gone). Ends its grant, if it had one.
    pub fn target_changed(&self, target_id: &str) -> Option<ComputerGrantPayload> {
        let mut inner = self.lock();
        Self::retire(&mut inner, target_id, GrantChange::TargetChanged)
    }

    /// End every grant that no longer holds by the rules as they are now: gone
    /// unused for `ttl`, or on a window that can no longer be shared (its
    /// application joined the blocklist). Run before anything is listed, when
    /// the settings change and on a timer, so what an agent sees of a window
    /// never reflects a grant that has already ended. An application shared
    /// as a whole goes on its own clock, which its windows share; so does the
    /// entire screen, which follows the rules as they are now from here on.
    pub fn sweep(
        &self,
        now: i64,
        ttl: Option<Duration>,
        me: &SelfIdentity,
        blocklist: &Blocklist,
    ) -> AppChange {
        let mut inner = self.lock();
        let Inner {
            entries,
            apps,
            screen,
            ..
        } = &mut *inner;
        let ending: Vec<(AppIdentity, GrantChange)> = apps
            .iter()
            .filter_map(|(identity, share)| {
                if grantable(&share.app, me, blocklist).is_err() {
                    Some((identity.clone(), GrantChange::Revoked))
                } else if share.grant.lapsed(now, ttl) {
                    Some((identity.clone(), GrantChange::Expired))
                } else {
                    None
                }
            })
            .collect();
        let mut out = AppChange::default();
        for (identity, change) in ending {
            out.absorb(Self::end_app(entries, apps, &identity, change));
        }
        if screen.as_ref().is_some_and(|s| s.grant.lapsed(now, ttl)) {
            out.absorb(Self::end_screen(entries, screen, GrantChange::Expired));
        } else if let Some(share) = screen.as_mut() {
            share.me = me.clone();
            share.blocklist = blocklist.clone();
        }
        for entry in entries.values_mut() {
            let Some(grant) = entry.grant.as_ref() else {
                continue;
            };
            let change = if grantable(&entry.app, me, blocklist).is_err() {
                Some(GrantChange::Revoked)
            } else if grant.scope == GrantScope::App {
                // A share left of an application whose own has ended.
                let shared = AppIdentity::of(entry).is_some_and(|app| apps.contains_key(&app));
                (!shared).then_some(GrantChange::Revoked)
            } else if grant.scope == GrantScope::Screen {
                // A share left of a screen whose own has ended.
                screen.is_none().then_some(GrantChange::Revoked)
            } else if grant.lapsed(now, ttl) {
                Some(GrantChange::Expired)
            } else {
                None
            };
            if let Some(change) = change {
                out.windows.extend(Self::revoke_entry(entry, change));
            }
        }
        out
    }

    /// End the shares of applications that no longer run — `alive` says
    /// whether a process run still does. Their windows have gone with them;
    /// this is the application's own share, which would otherwise wait out
    /// its clock.
    pub fn prune_apps(&self, alive: impl Fn(u32, u64) -> bool) -> AppChange {
        let mut inner = self.lock();
        let Inner { entries, apps, .. } = &mut *inner;
        let quit: Vec<AppIdentity> = apps
            .keys()
            .filter(|app| {
                !alive(app.pid, app.started_at)
                    || app
                        .content
                        .is_some_and(|run| !alive(run.pid, run.started_at))
            })
            .cloned()
            .collect();
        let mut out = AppChange::default();
        for identity in quit {
            out.absorb(Self::end_app(
                entries,
                apps,
                &identity,
                GrantChange::TargetChanged,
            ));
        }
        out
    }

    /// Whether `entry`'s grant has lapsed: on its own clock, or — shared
    /// with its whole application, or the entire screen — on the
    /// application's or the screen's (a share whose own has ended has ended
    /// with it).
    fn lapsed(
        entry: &TargetEntry,
        apps: &HashMap<AppIdentity, AppShare>,
        screen: &Option<ScreenShare>,
        now: i64,
        ttl: Option<Duration>,
    ) -> bool {
        match entry.grant.as_ref() {
            None => false,
            Some(grant) if grant.scope == GrantScope::App => AppIdentity::of(entry)
                .and_then(|app| apps.get(&app))
                .is_none_or(|share| share.grant.lapsed(now, ttl)),
            Some(grant) if grant.scope == GrantScope::Screen => screen
                .as_ref()
                .is_none_or(|share| share.grant.lapsed(now, ttl)),
            Some(grant) => grant.lapsed(now, ttl),
        }
    }

    /// A read or an action used `entry`'s grant now: its clock, and its
    /// application's or the screen's when it is shared with it, start again.
    fn used(
        entry: &mut TargetEntry,
        apps: &mut HashMap<AppIdentity, AppShare>,
        screen: &mut Option<ScreenShare>,
        now: i64,
    ) {
        let Some(grant) = entry.grant.as_mut() else {
            return;
        };
        grant.last_used_at = now;
        match grant.scope {
            GrantScope::App => {
                if let Some(share) = AppIdentity::of(entry).and_then(|app| apps.get_mut(&app)) {
                    share.grant.last_used_at = now;
                }
            }
            GrantScope::Screen => {
                if let Some(share) = screen.as_mut() {
                    share.grant.last_used_at = now;
                }
            }
            GrantScope::Window => {}
        }
    }

    /// Check a read may start: the window is one codeg named, it is shared,
    /// and the grant has not lapsed. A lapsed grant is ended here and its
    /// payloads returned alongside the refusal, because the caller is the one
    /// holding an emitter.
    pub fn begin_read(
        &self,
        target_id: &str,
        now: i64,
        ttl: Option<Duration>,
        me: &SelfIdentity,
        blocklist: &Blocklist,
    ) -> Result<ReadTicket, (ReadRefusal, Vec<ComputerGrantPayload>)> {
        let mut inner = self.lock();
        let Inner {
            entries,
            apps,
            screen,
            ..
        } = &mut *inner;
        let Some(entry) = entries.get(target_id) else {
            return Err((ReadRefusal::NoSuchTarget, Vec::new()));
        };
        // Checked even for a window that holds a grant: the blocklist can grow
        // while a window is shared, and the list is what the user said last.
        if let Err(why) = grantable(&entry.app, me, blocklist) {
            let ended = Self::end_grant(entries, apps, screen, target_id, GrantChange::Revoked);
            return Err((ReadRefusal::NotGrantable(why), ended));
        }
        let Some(grant) = entry.grant.as_ref() else {
            return Err((ReadRefusal::GrantRequired, Vec::new()));
        };
        let (level, scope) = (grant.level, grant.scope);
        if Self::lapsed(entry, apps, screen, now, ttl) {
            let ended = Self::end_grant(entries, apps, screen, target_id, GrantChange::Expired);
            return Err((ReadRefusal::GrantRequired, ended));
        }
        if !level.allows(GrantLevel::Read) {
            return Err((ReadRefusal::GrantRequired, Vec::new()));
        }
        let Some(entry) = entries.get_mut(target_id) else {
            return Err((ReadRefusal::NoSuchTarget, Vec::new()));
        };
        Self::used(entry, apps, screen, now);
        Ok(ReadTicket {
            target_id: entry.target_id.clone(),
            identity: entry.identity,
            epoch: entry.epoch,
            app: entry.app.clone(),
            bounds: entry.bounds,
            scope,
        })
    }

    /// Check a read that has finished may be handed over: the same grant is
    /// still in force on the same window, and the window may still be shared
    /// by the rules as they are now. The person may have taken the grant back,
    /// or put the application on the blocklist, while the capture was in
    /// flight, and what the capture holds is exactly what they took back. A
    /// grant the blocklist now forbids is ended here, its payloads returned
    /// for the caller to announce.
    ///
    /// Returns the generation that names this read. `mark`, when the read
    /// leaves one, becomes the window's latest snapshot or screenshot under
    /// that generation — what later actions resolve refs and points against.
    pub fn finish_read(
        &self,
        ticket: &ReadTicket,
        me: &SelfIdentity,
        blocklist: &Blocklist,
        mark: Option<ReadMark>,
    ) -> Result<String, (ReadRefusal, Vec<ComputerGrantPayload>)> {
        let mut inner = self.lock();
        let Inner {
            entries,
            apps,
            screen,
            ..
        } = &mut *inner;
        let Some(entry) = entries.get(&ticket.target_id) else {
            return Err((ReadRefusal::GrantRequired, Vec::new()));
        };
        let still = entry.identity == ticket.identity
            && entry.epoch == ticket.epoch
            && level_of(entry.grant.as_ref()).allows(GrantLevel::Read);
        if !still {
            return Err((ReadRefusal::GrantRequired, Vec::new()));
        }
        if let Err(why) = grantable(&entry.app, me, blocklist) {
            let ended = Self::end_grant(
                entries,
                apps,
                screen,
                &ticket.target_id,
                GrantChange::Revoked,
            );
            return Err((ReadRefusal::NotGrantable(why), ended));
        }
        let Some(entry) = entries.get_mut(&ticket.target_id) else {
            return Err((ReadRefusal::GrantRequired, Vec::new()));
        };
        entry.reads += 1;
        let generation = generation(entry.epoch, entry.reads);
        match mark {
            Some(ReadMark::Snapshot {
                snapshot_id,
                shown,
                cut,
                secret,
            }) => {
                entry.snapshot_mark = Some(SnapshotMark {
                    generation: generation.clone(),
                    snapshot_id,
                    shown,
                    cut,
                    secret,
                })
            }
            Some(ReadMark::Capture {
                width,
                height,
                native_width,
                native_height,
                full_size,
                window_bounds,
            }) => {
                entry.capture_mark = Some(CaptureMark {
                    generation: generation.clone(),
                    width,
                    height,
                    native_width,
                    native_height,
                    full_size,
                    window_bounds,
                })
            }
            None => {}
        }
        Ok(generation)
    }

    /// Check an action may go ahead, and resolve it for the helper.
    ///
    /// In this order, each answered before the next is asked: the window is
    /// one codeg named; it may still be shared at all; it is shared; the grant
    /// has not lapsed; it is shared for control — and only then anything about
    /// the action itself: keys and menus the grant does not reach (a window's,
    /// or its whole application's), then every ref against the window's
    /// latest snapshot and every point against its latest screenshot, as the
    /// agent was given them. A refusal therefore never says more about a
    /// window than the agent was allowed to know.
    ///
    /// Counts as use of the grant, like a read.
    // One argument per thing the decision reads, as `begin_read` takes them,
    // and whether a paste may go (`resolve`).
    #[allow(clippy::too_many_arguments)]
    pub fn begin_act(
        &self,
        target_id: &str,
        now: i64,
        ttl: Option<Duration>,
        me: &SelfIdentity,
        blocklist: &Blocklist,
        request: &ComputerActRequest,
        paste_ok: bool,
    ) -> Result<ActTicket, (ActDenied, Vec<ComputerGrantPayload>)> {
        let mut inner = self.lock();
        let Inner {
            entries,
            apps,
            screen,
            ..
        } = &mut *inner;
        let Some(entry) = entries.get(target_id) else {
            return Err((ActDenied::NoSuchTarget, Vec::new()));
        };
        if let Err(why) = grantable(&entry.app, me, blocklist) {
            let ended = Self::end_grant(entries, apps, screen, target_id, GrantChange::Revoked);
            return Err((ActDenied::NotGrantable(why), ended));
        }
        let Some(grant) = entry.grant.as_ref() else {
            return Err((ActDenied::GrantRequired, Vec::new()));
        };
        let level = grant.level;
        if Self::lapsed(entry, apps, screen, now, ttl) {
            let ended = Self::end_grant(entries, apps, screen, target_id, GrantChange::Expired);
            return Err((ActDenied::GrantRequired, ended));
        }
        if !level.allows(GrantLevel::Read) {
            return Err((ActDenied::GrantRequired, Vec::new()));
        }
        if !level.allows(GrantLevel::Control) {
            return Err((ActDenied::ControlRequired, Vec::new()));
        }
        let action = resolve(entry, request, paste_ok).map_err(|why| (why, Vec::new()))?;
        let Some(entry) = entries.get_mut(target_id) else {
            return Err((ActDenied::NoSuchTarget, Vec::new()));
        };
        Self::used(entry, apps, screen, now);
        Ok(ActTicket {
            target_id: entry.target_id.clone(),
            identity: entry.identity,
            epoch: entry.epoch,
            app: entry.app.clone(),
            aim: Aim::of(entry, &action),
            action,
        })
    }

    /// Every window with a grant in force, oldest grant first.
    pub fn shared(&self) -> Vec<SharedWindow> {
        let inner = self.lock();
        let mut out: Vec<SharedWindow> = inner
            .entries
            .values()
            .filter_map(|e| {
                let grant = e.grant.as_ref()?;
                Some(SharedWindow {
                    target_id: e.target_id.clone(),
                    app_name: e.app.name.clone(),
                    app_key: e.app.key().unwrap_or_default().to_string(),
                    title: e.title.clone(),
                    level: grant.level,
                    granted_at: grant.granted_at,
                    last_used_at: grant.last_used_at,
                    whole_app: grant.scope == GrantScope::App,
                    app_id: (grant.scope == GrantScope::App)
                        .then(|| AppIdentity::of(e))
                        .flatten()
                        .and_then(|app| inner.apps.get(&app))
                        .map(|share| share.app_id.clone()),
                    whole_screen: grant.scope == GrantScope::Screen,
                })
            })
            .collect();
        out.sort_by(|a, b| {
            a.granted_at
                .cmp(&b.granted_at)
                .then(a.target_id.cmp(&b.target_id))
        });
        out
    }

    /// Every application shared as a whole, oldest share first.
    pub fn shared_apps(&self) -> Vec<SharedApp> {
        let inner = self.lock();
        let mut out: Vec<SharedApp> = inner
            .apps
            .iter()
            .map(|(identity, share)| SharedApp {
                app_id: share.app_id.clone(),
                app_name: share.app.name.clone(),
                app_key: identity.key.clone(),
                level: share.grant.level,
                granted_at: share.grant.granted_at,
                last_used_at: share.grant.last_used_at,
                windows: inner
                    .entries
                    .values()
                    .filter(|e| {
                        e.grant.as_ref().is_some_and(|g| g.scope == GrantScope::App)
                            && AppIdentity::of(e).as_ref() == Some(identity)
                    })
                    .count() as u32,
            })
            .collect();
        out.sort_by(|a, b| {
            a.granted_at
                .cmp(&b.granted_at)
                .then(a.app_id.cmp(&b.app_id))
        });
        out
    }

    /// The entire screen, when it is shared.
    pub fn shared_screen(&self) -> Option<SharedScreen> {
        let inner = self.lock();
        let share = inner.screen.as_ref()?;
        Some(SharedScreen {
            level: share.grant.level,
            granted_at: share.grant.granted_at,
            last_used_at: share.grant.last_used_at,
            windows: inner
                .entries
                .values()
                .filter(|e| {
                    e.grant
                        .as_ref()
                        .is_some_and(|g| g.scope == GrantScope::Screen)
                })
                .count() as u32,
        })
    }

    /// Check a read of the entire screen may start: it is shared, and its
    /// grant has not lapsed. A lapsed one is ended here, what that ended
    /// returned alongside the refusal. Counts as use of the grant.
    pub fn begin_screen_read(
        &self,
        now: i64,
        ttl: Option<Duration>,
    ) -> Result<ScreenReadTicket, (ReadRefusal, AppChange)> {
        let mut inner = self.lock();
        let Inner {
            entries, screen, ..
        } = &mut *inner;
        let Some(share) = screen.as_ref() else {
            return Err((ReadRefusal::GrantRequired, AppChange::default()));
        };
        if share.grant.lapsed(now, ttl) {
            let ended = Self::end_screen(entries, screen, GrantChange::Expired);
            return Err((ReadRefusal::GrantRequired, ended));
        }
        let Some(share) = screen.as_mut() else {
            return Err((ReadRefusal::GrantRequired, AppChange::default()));
        };
        if !share.grant.level.allows(GrantLevel::Read) {
            return Err((ReadRefusal::GrantRequired, AppChange::default()));
        }
        share.grant.last_used_at = now;
        Ok(ScreenReadTicket { epoch: share.epoch })
    }

    /// Check a read of the entire screen that has finished may be handed
    /// over: the same sharing of it is still in force. Returns the
    /// generation that names the read; `mark` becomes the screen's latest
    /// picture under it — what later points on the screen are read in.
    pub fn finish_screen_read(
        &self,
        ticket: &ScreenReadTicket,
        mark: ReadMark,
    ) -> Result<String, ReadRefusal> {
        let mut inner = self.lock();
        let Some(share) = inner
            .screen
            .as_mut()
            .filter(|s| s.epoch == ticket.epoch && s.grant.level.allows(GrantLevel::Read))
        else {
            return Err(ReadRefusal::GrantRequired);
        };
        share.reads += 1;
        let generation = generation(share.epoch, share.reads);
        if let ReadMark::Capture {
            width,
            height,
            native_width,
            native_height,
            full_size,
            window_bounds,
        } = mark
        {
            share.capture_mark = Some(CaptureMark {
                generation: generation.clone(),
                width,
                height,
                native_width,
                native_height,
                full_size,
                window_bounds,
            });
        }
        Ok(generation)
    }

    /// Check an action on the entire screen may go ahead, and resolve it for
    /// the helper: the screen is shared for control, its grant has not
    /// lapsed, and the action is a click, a drag or a scroll at points of its
    /// latest picture as the agent was given it. Counts as use of the grant.
    pub fn begin_screen_act(
        &self,
        now: i64,
        ttl: Option<Duration>,
        request: &ComputerActRequest,
    ) -> Result<ScreenActTicket, (ActDenied, AppChange)> {
        let mut inner = self.lock();
        let Inner {
            entries, screen, ..
        } = &mut *inner;
        let Some(share) = screen.as_ref() else {
            return Err((ActDenied::GrantRequired, AppChange::default()));
        };
        if share.grant.lapsed(now, ttl) {
            let ended = Self::end_screen(entries, screen, GrantChange::Expired);
            return Err((ActDenied::GrantRequired, ended));
        }
        let Some(share) = screen.as_mut() else {
            return Err((ActDenied::GrantRequired, AppChange::default()));
        };
        if !share.grant.level.allows(GrantLevel::Read) {
            return Err((ActDenied::GrantRequired, AppChange::default()));
        }
        if !share.grant.level.allows(GrantLevel::Control) {
            return Err((ActDenied::ControlRequired, AppChange::default()));
        }
        let mark = share.capture_mark.as_ref();
        let action = resolve_on_screen(mark, request).map_err(|why| (why, AppChange::default()))?;
        // A point resolved, so the picture it was read in is there.
        let geometry = mark
            .map(|m| ScreenGeometry {
                scale: f64::from(m.native_width) / m.window_bounds.width,
                width: m.window_bounds.width,
                height: m.window_bounds.height,
            })
            .filter(|g| g.scale.is_finite() && g.scale > 0.0)
            .ok_or((ActDenied::NoPointing, AppChange::default()))?;
        share.grant.last_used_at = now;
        Ok(ScreenActTicket {
            epoch: share.epoch,
            action,
            geometry,
        })
    }

    /// Whether the sharing of the entire screen an action was let through
    /// under (`epoch`) is still in force, for control.
    pub fn screen_controlled(&self, epoch: u64) -> bool {
        self.lock()
            .screen
            .as_ref()
            .is_some_and(|s| s.epoch == epoch && s.grant.level.allows(GrantLevel::Control))
    }

    /// What `app` — as a listing of applications names it — is shared for as
    /// a whole; [`GrantLevel::None`] when it is not.
    pub fn app_level(&self, app: &RawApp) -> GrantLevel {
        self.lock()
            .apps
            .iter()
            .find(|(identity, _)| identity.names(app))
            .map_or(GrantLevel::None, |(_, share)| share.grant.level)
    }

    /// The share of the application `target_id` is a window of, if it is
    /// shared as a whole.
    pub fn app_share_of(&self, target_id: &str) -> Option<AppShare> {
        let inner = self.lock();
        let entry = inner.entries.get(target_id)?;
        let identity = AppIdentity::of(entry)?;
        inner.apps.get(&identity).cloned()
    }
}

/// Which application [`TargetTable::share_app`] is to share: the one a window
/// is of, or one already shared, by its share's id.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AppTarget<'a> {
    Window(&'a str),
    Share(&'a str),
}

impl AppChange {
    pub fn absorb(&mut self, other: AppChange) {
        self.windows.extend(other.windows);
        self.app_changed |= other.app_changed;
    }
}

/// The action as the helper carries it out: keys judged for a window grant,
/// refs and points resolved against what the agent last read of the window.
/// `paste_ok`: the clipboard holds what an agent put there itself, which a
/// paste may then write into the window (see `commands::computer`).
fn resolve(
    entry: &TargetEntry,
    request: &ComputerActRequest,
    paste_ok: bool,
) -> Result<WindowAction, ActDenied> {
    let scope = entry
        .grant
        .as_ref()
        .map_or(GrantScope::Window, |grant| grant.scope);
    Ok(match request {
        ComputerActRequest::Click {
            target,
            button,
            count,
            modifiers,
        } => {
            check_pointer_modifiers(*modifiers, scope)?;
            if *count == 2 && !modifiers.is_empty() {
                return Err(ActDenied::DoubleClickModifiers);
            }
            WindowAction::Click {
                at: resolve_target(entry, target)?,
                button: *button,
                count: *count,
                modifiers: *modifiers,
            }
        }
        ComputerActRequest::Drag {
            from,
            to,
            button,
            modifiers,
            duration_ms,
        } => {
            check_pointer_modifiers(*modifiers, scope)?;
            if !super::keys::drag_carries_modifiers(*modifiers, Platform::current()) {
                return Err(ActDenied::DragModifiers);
            }
            WindowAction::Drag {
                from: resolve_point(entry, from)?,
                to: resolve_point(entry, to)?,
                button: *button,
                modifiers: *modifiers,
                duration_ms: duration_ms
                    .unwrap_or(DEFAULT_DRAG_MS)
                    .min(super::types::MAX_DRAG_MS),
            }
        }
        ComputerActRequest::Scroll {
            target,
            direction,
            amount,
            unit,
        } => WindowAction::Scroll {
            at: target
                .as_ref()
                .map(|t| resolve_target(entry, t))
                .transpose()?,
            direction: *direction,
            amount: *amount,
            unit: *unit,
        },
        ComputerActRequest::Type {
            target,
            text,
            submit,
        } => WindowAction::Type {
            element: resolve_element(entry, target, true)?,
            text: text.clone(),
            submit: *submit,
        },
        ComputerActRequest::Key { target, chord, .. } => {
            check_chord(chord, target.is_some(), scope, paste_ok)?;
            WindowAction::Key {
                element: target
                    .as_ref()
                    .map(|t| resolve_element(entry, t, chord.types_text()))
                    .transpose()?,
                chord: *chord,
            }
        }
        // A held key is the key pressed, again and again: each press is an
        // action of its own (see `commands::computer`).
        ComputerActRequest::HoldKey { target, chord, .. } => {
            check_chord(chord, target.is_some(), scope, paste_ok)?;
            WindowAction::Key {
                element: target
                    .as_ref()
                    .map(|t| resolve_element(entry, t, chord.types_text()))
                    .transpose()?,
                chord: *chord,
            }
        }
        ComputerActRequest::SetValue { target, value } => WindowAction::SetValue {
            element: resolve_element(entry, target, true)?,
            value: value.clone(),
        },
        ComputerActRequest::Restore => WindowAction::Restore,
        ComputerActRequest::InvokeMenu { path } => {
            if scope == GrantScope::Window {
                return Err(ActDenied::AppGrantRequired);
            }
            if Platform::current() == Platform::Windows {
                return Err(ActDenied::MenusUnavailable);
            }
            // A paste by its menu is a paste: it writes the person's
            // clipboard into the window ("Paste Special", "Unformatted Text"
            // included). The helper checks the command's own shortcut too.
            if !paste_ok && path.iter().any(|title| super::keys::names_paste(title)) {
                return Err(ActDenied::Paste);
            }
            WindowAction::InvokeMenu {
                path: path.iter().map(|title| title.trim().to_string()).collect(),
            }
        }
        ComputerActRequest::SetFrame {
            x,
            y,
            width,
            height,
        } => {
            check_frame(*x, *y, *width, *height)?;
            WindowAction::SetFrame {
                x: *x,
                y: *y,
                width: *width,
                height: *height,
            }
        }
    })
}

/// Whether what is given of a window's frame could be one: every number
/// finite, neither side under [`MIN_WINDOW_SIDE`], nothing beyond
/// [`MAX_WINDOW_EXTENT`]. What is left out the helper takes from the window as
/// it finds it just before, not from a listing that may be out of date.
fn check_frame(
    x: Option<f64>,
    y: Option<f64>,
    width: Option<f64>,
    height: Option<f64>,
) -> Result<(), ActDenied> {
    use super::types::{MAX_WINDOW_EXTENT, MIN_WINDOW_SIDE};
    let place = |n: f64| n.is_finite() && n.abs() <= MAX_WINDOW_EXTENT;
    let side = |n: f64| n.is_finite() && (MIN_WINDOW_SIDE..=MAX_WINDOW_EXTENT).contains(&n);
    let given = x.is_some() || y.is_some() || width.is_some() || height.is_some();
    let fits = x.is_none_or(place)
        && y.is_none_or(place)
        && width.is_none_or(side)
        && height.is_none_or(side);
    if given && fits {
        Ok(())
    } else {
        Err(ActDenied::BadFrame)
    }
}

/// How long a drag's path takes when the agent does not say: the driver's
/// own default.
const DEFAULT_DRAG_MS: u32 = 500;

/// An action on the entire screen as the helper carries it out: a click, a
/// drag or a scroll, every point resolved against the screen's latest
/// picture (`mark`) as the agent was given it. Anything else goes to a
/// window.
fn resolve_on_screen(
    mark: Option<&CaptureMark>,
    request: &ComputerActRequest,
) -> Result<WindowAction, ActDenied> {
    Ok(match request {
        ComputerActRequest::Click {
            target: AgentTarget::Point(point),
            button,
            count,
            modifiers,
        } => {
            check_pointer_modifiers(*modifiers, GrantScope::Screen)?;
            WindowAction::Click {
                at: DriverTarget::Point(point_in(mark, point)?),
                button: *button,
                count: *count,
                modifiers: *modifiers,
            }
        }
        ComputerActRequest::Drag {
            from,
            to,
            button,
            modifiers,
            duration_ms,
        } => {
            check_pointer_modifiers(*modifiers, GrantScope::Screen)?;
            if !super::keys::drag_carries_modifiers(*modifiers, Platform::current()) {
                return Err(ActDenied::DragModifiers);
            }
            WindowAction::Drag {
                from: point_in(mark, from)?,
                to: point_in(mark, to)?,
                button: *button,
                modifiers: *modifiers,
                duration_ms: duration_ms
                    .unwrap_or(DEFAULT_DRAG_MS)
                    .min(super::types::MAX_DRAG_MS),
            }
        }
        ComputerActRequest::Scroll {
            target: Some(AgentTarget::Point(point)),
            direction,
            amount,
            unit,
        } => WindowAction::Scroll {
            at: Some(DriverTarget::Point(point_in(mark, point)?)),
            direction: *direction,
            amount: *amount,
            unit: *unit,
        },
        _ => return Err(ActDenied::ScreenPointerOnly),
    })
}

/// Whether the grant reaches `modifiers` held over a click or a drag: a
/// window's (see `keys::pointer_modifiers_allowed`), a whole application's
/// (`keys::pointer_modifiers_allowed_for_app`), or the entire screen's —
/// which reaches every one.
fn check_pointer_modifiers(
    modifiers: super::keys::Modifiers,
    scope: GrantScope,
) -> Result<(), ActDenied> {
    let platform = Platform::current();
    let allowed = match scope {
        GrantScope::Window => super::keys::pointer_modifiers_allowed(modifiers, platform),
        GrantScope::App => super::keys::pointer_modifiers_allowed_for_app(modifiers, platform),
        GrantScope::Screen => true,
    };
    match (allowed, scope) {
        (true, _) => Ok(()),
        (false, GrantScope::Window) => Err(ActDenied::ChordBeyond),
        (false, _) => Err(ActDenied::DesktopChord),
    }
}

/// Whether the grant — a window's, a whole application's, or the entire
/// screen's — reaches `chord`, and, for a key that types a character, that
/// it is aimed at a named element.
fn check_chord(
    chord: &Chord,
    names_element: bool,
    scope: GrantScope,
    paste_ok: bool,
) -> Result<(), ActDenied> {
    let platform = Platform::current();
    let class = match scope {
        GrantScope::Window => classify(chord, platform),
        GrantScope::App => classify_for_app(chord, platform),
        GrantScope::Screen => classify_for_screen(chord, platform),
    };
    match class {
        ChordClass::Beyond if scope == GrantScope::Window => Err(ActDenied::ChordBeyond),
        ChordClass::Beyond if scope == GrantScope::App => Err(ActDenied::DesktopChord),
        ChordClass::Beyond => Err(ActDenied::SessionChord),
        ChordClass::Paste if paste_ok => Ok(()),
        ChordClass::Paste => Err(ActDenied::Paste),
        ChordClass::Window if chord.types_text() && !names_element => Err(ActDenied::NeedsElement),
        ChordClass::Window => Ok(()),
    }
}

fn resolve_target(entry: &TargetEntry, target: &AgentTarget) -> Result<DriverTarget, ActDenied> {
    Ok(match target {
        AgentTarget::Element(e) => DriverTarget::Element(resolve_element(entry, e, false)?),
        AgentTarget::Point(p) => DriverTarget::Point(resolve_point(entry, p)?),
    })
}

/// A ref, against the window's latest snapshot as the agent was given it.
/// `writes`: the action puts text into the element, which a secret field
/// never takes.
fn resolve_element(
    entry: &TargetEntry,
    target: &ElementTarget,
    writes: bool,
) -> Result<ElementRef, ActDenied> {
    let mark = entry
        .snapshot_mark
        .as_ref()
        .ok_or(ActDenied::Stale(Staleness::NoSnapshot))?;
    if mark.generation != target.generation {
        return Err(ActDenied::Stale(Staleness::OldSnapshot));
    }
    let snapshot_id = mark
        .snapshot_id
        .clone()
        .ok_or(ActDenied::Stale(Staleness::NotActionable))?;
    if !mark.shown.contains(&target.index) {
        return Err(ActDenied::Stale(if mark.cut.contains(&target.index) {
            Staleness::CutAway(target.index)
        } else {
            Staleness::NoSuchRef(target.index)
        }));
    }
    if writes && mark.secret.contains(&target.index) {
        return Err(ActDenied::Secret);
    }
    Ok(ElementRef {
        snapshot_id,
        index: target.index,
    })
}

/// A point, in the pixels of the window's latest screenshot, mapped back to
/// the window's own pixels.
fn resolve_point(entry: &TargetEntry, target: &PointTarget) -> Result<WindowPoint, ActDenied> {
    point_in(entry.capture_mark.as_ref(), target)
}

/// A point, in the pixels of the screenshot `mark` names, mapped back to the
/// pixels it was shrunk from.
fn point_in(mark: Option<&CaptureMark>, target: &PointTarget) -> Result<WindowPoint, ActDenied> {
    let mark = mark.ok_or(ActDenied::Stale(Staleness::NoCapture))?;
    if mark.generation != target.generation {
        return Err(ActDenied::Stale(Staleness::OldCapture));
    }
    if !mark.full_size || mark.width == 0 || mark.height == 0 || mark.window_bounds.is_empty() {
        return Err(ActDenied::NoPointing);
    }
    let (x, y) = (target.x, target.y);
    let inside = x.is_finite()
        && y.is_finite()
        && x >= 0.0
        && y >= 0.0
        && x < f64::from(mark.width)
        && y < f64::from(mark.height);
    if !inside {
        return Err(ActDenied::OutOfImage);
    }
    Ok(WindowPoint {
        x: x * f64::from(mark.native_width) / f64::from(mark.width),
        y: y * f64::from(mark.native_height) / f64::from(mark.height),
        window_width: mark.window_bounds.width,
        window_height: mark.window_bounds.height,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn raw_app(pid: u32, started_at: u64, bundle: &str) -> RawApp {
        RawApp {
            pid,
            name: bundle.rsplit('.').next().unwrap_or(bundle).to_string(),
            bundle_id: Some(bundle.to_string()),
            path: None,
            active: false,
            started_at: Some(started_at),
        }
    }

    fn window(pid: u32, started_at: u64, window_id: u64, title: &str) -> RawWindow {
        RawWindow {
            window_id,
            pid,
            title: title.to_string(),
            bounds: Rect {
                x: 0.0,
                y: 0.0,
                width: 800.0,
                height: 600.0,
            },
            on_screen: true,
            minimized: Some(false),
            hidden: None,
            on_current_space: Some(true),
            z_index: None,
            content: None,
            app: raw_app(pid, started_at, "com.apple.TextEdit"),
        }
    }

    fn me() -> SelfIdentity {
        SelfIdentity {
            pid: 1,
            exe: None,
            bundle: None,
        }
    }

    fn share(table: &TargetTable, id: &str, level: GrantLevel) -> Option<ComputerGrantPayload> {
        table
            .share(id, level, 1_000, &me(), &Blocklist::new(&[]))
            .expect("shareable")
    }

    fn read(table: &TargetTable, id: &str) -> Result<String, ReadRefusal> {
        let ticket = table
            .begin_read(id, 2_000, None, &me(), &Blocklist::new(&[]))
            .map_err(|(why, _)| why)?;
        finish(table, &ticket)
    }

    fn finish(table: &TargetTable, ticket: &ReadTicket) -> Result<String, ReadRefusal> {
        table
            .finish_read(ticket, &me(), &Blocklist::new(&[]), None)
            .map_err(|(why, _)| why)
    }

    /// The same window keeps its id across listings; the same window id under
    /// a relaunched process is a different window with a different id.
    #[test]
    fn a_window_keeps_its_id_until_its_process_changes() {
        let table = TargetTable::new();
        let (first, _) = table.observe(&[window(10, 111, 5, "a")], None);
        let (again, _) = table.observe(&[window(10, 111, 5, "a")], None);
        assert_eq!(first[0].target_id, again[0].target_id);

        let (relaunched, _) = table.observe(&[window(10, 222, 5, "a")], None);
        assert_ne!(relaunched[0].target_id, first[0].target_id);
        // And the old id no longer resolves: it was never shared, so it is
        // simply forgotten.
        assert!(table.get(&first[0].target_id).is_none());
    }

    /// A frame is the window of the run of the application drawing inside it:
    /// listed with that run again it is the same window, shared as it was;
    /// with another run inside, it is another window, and the grant ends.
    #[test]
    fn a_frame_is_the_window_of_the_run_inside_it() {
        let table = TargetTable::new();
        let framed = |pid: u32, started_at: u64| RawWindow {
            content: Some(ProcessRun { pid, started_at }),
            ..window(10, 111, 5, "Calculator")
        };
        let (first, _) = table.observe(&[framed(30, 333)], None);
        let id = first[0].target_id.clone();
        share(&table, &id, GrantLevel::Read);
        let (again, ended) = table.observe(&[framed(30, 333)], None);
        assert_eq!(again[0].target_id, id);
        assert!(ended.is_empty());
        assert!(read(&table, &id).is_ok());

        let (relaunched, ended) = table.observe(&[framed(31, 444)], None);
        assert_ne!(relaunched[0].target_id, id);
        assert_eq!(ended.len(), 1);
        assert_eq!(ended[0].change, GrantChange::TargetChanged);
        assert_eq!(read(&table, &id), Err(ReadRefusal::GrantRequired));
        assert_eq!(
            read(&table, &relaunched[0].target_id),
            Err(ReadRefusal::GrantRequired)
        );
    }

    /// A shared window that stops turning up takes its grant with it, and its
    /// id answers "not shared" from then on — never "no such target".
    #[test]
    fn a_shared_window_that_goes_away_ends_its_grant() {
        let table = TargetTable::new();
        let (listed, _) = table.observe(&[window(10, 111, 5, "Inbox")], None);
        let id = listed[0].target_id.clone();
        share(&table, &id, GrantLevel::Read);
        assert!(read(&table, &id).is_ok());

        let (_, ended) = table.observe(&[], None);
        assert_eq!(ended.len(), 1);
        assert_eq!(ended[0].change, GrantChange::TargetChanged);
        assert_eq!(read(&table, &id), Err(ReadRefusal::GrantRequired));
        assert!(table.shared().is_empty());
        // Re-sharing a gone window is refused rather than resurrecting it.
        assert_eq!(
            table.share(&id, GrantLevel::Read, 3_000, &me(), &Blocklist::new(&[])),
            Err(ShareError::Gone)
        );
    }

    /// A listing scoped to one process says nothing about another's windows.
    #[test]
    fn a_scoped_listing_only_judges_its_own_scope() {
        let table = TargetTable::new();
        let (listed, _) = table.observe(&[window(10, 111, 5, "a"), window(20, 222, 6, "b")], None);
        let other = listed[1].target_id.clone();
        share(&table, &other, GrantLevel::Read);
        let (_, ended) = table.observe(&[window(10, 111, 5, "a")], Some(10));
        assert!(ended.is_empty());
        assert!(read(&table, &other).is_ok());
    }

    /// Unshared ids are refused, unknown ids are told apart from them, and a
    /// read's generation moves with every read and every re-share.
    #[test]
    fn reads_need_a_grant_and_are_numbered() {
        let table = TargetTable::new();
        let (listed, _) = table.observe(&[window(10, 111, 5, "a")], None);
        let id = listed[0].target_id.clone();
        assert_eq!(read(&table, &id), Err(ReadRefusal::GrantRequired));
        assert_eq!(read(&table, "w999"), Err(ReadRefusal::NoSuchTarget));

        share(&table, &id, GrantLevel::Read);
        assert_eq!(read(&table, &id).as_deref(), Ok("1.1"));
        assert_eq!(read(&table, &id).as_deref(), Ok("1.2"));

        // Raising the level keeps the grant, and its numbering.
        assert!(share(&table, &id, GrantLevel::Control).is_some());
        assert_eq!(read(&table, &id).as_deref(), Ok("1.3"));
        // Sharing at the level it already has is not a change.
        assert!(share(&table, &id, GrantLevel::Control).is_none());

        share(&table, &id, GrantLevel::None);
        share(&table, &id, GrantLevel::Read);
        assert_eq!(read(&table, &id).as_deref(), Ok("3.1"));
    }

    /// The re-check after a read catches a revoke that landed during it — the
    /// case the second check exists for.
    #[test]
    fn a_revoke_during_a_read_voids_the_read() {
        let table = TargetTable::new();
        let (listed, _) = table.observe(&[window(10, 111, 5, "a")], None);
        let id = listed[0].target_id.clone();
        share(&table, &id, GrantLevel::Read);
        let ticket = table
            .begin_read(&id, 2_000, None, &me(), &Blocklist::new(&[]))
            .unwrap();
        share(&table, &id, GrantLevel::None);
        assert_eq!(finish(&table, &ticket), Err(ReadRefusal::GrantRequired));

        // Even when it was shared straight back: a different grant.
        let refused = table
            .begin_read(&id, 2_000, None, &me(), &Blocklist::new(&[]))
            .unwrap_err();
        assert_eq!(refused.0, ReadRefusal::GrantRequired);
        share(&table, &id, GrantLevel::Read);
        let ticket = table
            .begin_read(&id, 2_000, None, &me(), &Blocklist::new(&[]))
            .unwrap();
        share(&table, &id, GrantLevel::None);
        share(&table, &id, GrantLevel::Read);
        assert_eq!(finish(&table, &ticket), Err(ReadRefusal::GrantRequired));
    }

    /// An idle grant lapses at the next read, and the sweep ends it without
    /// one.
    #[test]
    fn idle_grants_lapse() {
        let ttl = Some(Duration::from_secs(1));
        let table = TargetTable::new();
        let (listed, _) = table.observe(&[window(10, 111, 5, "a")], None);
        let id = listed[0].target_id.clone();
        share(&table, &id, GrantLevel::Read);
        let refused = table
            .begin_read(&id, 1_000 + 1_000, ttl, &me(), &Blocklist::new(&[]))
            .unwrap_err();
        assert_eq!(refused.0, ReadRefusal::GrantRequired);
        assert_eq!(
            refused.1.iter().map(|p| p.change).collect::<Vec<_>>(),
            vec![GrantChange::Expired]
        );

        share(&table, &id, GrantLevel::Read);
        let swept = table.sweep(1_000 + 1_000, ttl, &me(), &Blocklist::new(&[]));
        assert_eq!(swept.windows.len(), 1);
        assert_eq!(swept.windows[0].change, GrantChange::Expired);
        assert!(table.shared().is_empty());
    }

    /// A blocklist entry added while a window is shared ends its grant at the
    /// next sweep — before the next listing could show its title — and at the
    /// end of a read that was already in flight, which is then not handed
    /// over.
    #[test]
    fn a_grant_the_blocklist_now_forbids_ends() {
        let table = TargetTable::new();
        let grown = Blocklist::new(&["com.apple.TextEdit".to_string()]);
        let (listed, _) = table.observe(&[window(10, 111, 5, "Draft")], None);
        let id = listed[0].target_id.clone();

        share(&table, &id, GrantLevel::Read);
        let swept = table.sweep(2_000, None, &me(), &grown);
        assert_eq!(swept.windows.len(), 1);
        assert_eq!(swept.windows[0].change, GrantChange::Revoked);
        let (listed, _) = table.observe(&[window(10, 111, 5, "Draft")], None);
        assert_eq!(listed[0].agent_summary(&me(), &grown).title, None);

        let (listed, _) = table.observe(&[window(10, 111, 5, "Draft")], None);
        let id = listed[0].target_id.clone();
        share(&table, &id, GrantLevel::Read);
        let ticket = table
            .begin_read(&id, 2_000, None, &me(), &Blocklist::new(&[]))
            .unwrap();
        let (why, ended) = table.finish_read(&ticket, &me(), &grown, None).unwrap_err();
        assert_eq!(why, ReadRefusal::NotGrantable(NotGrantable::Blocklisted));
        assert_eq!(
            ended.iter().map(|p| p.change).collect::<Vec<_>>(),
            vec![GrantChange::Revoked]
        );
        assert!(table.shared().is_empty());
    }

    /// A late "window gone" for an id a listing already retired touches
    /// neither its tombstone nor the newer id the same window was given when
    /// it came back — which keeps its id, and its grant, from then on.
    #[test]
    fn a_late_retirement_leaves_the_newer_id_alone() {
        let table = TargetTable::new();
        let (listed, _) = table.observe(&[window(10, 111, 5, "a")], None);
        let old = listed[0].target_id.clone();
        share(&table, &old, GrantLevel::Read);
        // A listing that misses the window retires it...
        let (_, ended) = table.observe(&[], None);
        assert_eq!(ended.len(), 1);
        // ...it comes back under a new id, which is shared again...
        let (listed, _) = table.observe(&[window(10, 111, 5, "a")], None);
        let new = listed[0].target_id.clone();
        assert_ne!(new, old);
        share(&table, &new, GrantLevel::Read);
        // ...and then an operation from before reports the old id gone.
        assert!(table.target_changed(&old).is_none());
        assert_eq!(read(&table, &old), Err(ReadRefusal::GrantRequired));
        for _ in 0..3 {
            let (listed, ended) = table.observe(&[window(10, 111, 5, "a")], None);
            assert_eq!(listed[0].target_id, new);
            assert!(ended.is_empty());
        }
        assert!(read(&table, &new).is_ok());
    }

    /// codeg's own windows and blocklisted applications are listed, carry a
    /// note, and can be neither shared nor read — even when a blocklist entry
    /// arrives after the window was shared.
    #[test]
    fn unshareable_windows_are_listed_with_the_reason_and_stay_unreadable() {
        let table = TargetTable::new();
        let mut vault = window(30, 333, 9, "Vault");
        vault.app = raw_app(30, 333, "com.1password.1password");
        let mut own = window(1, 444, 10, "codeg");
        own.app = raw_app(1, 444, "app.codeg");
        let (listed, _) = table.observe(&[vault, own, window(10, 111, 5, "a")], None);

        let blocklist = Blocklist::new(&[]);
        for entry in &listed[..2] {
            assert!(entry.agent_summary(&me(), &blocklist).note.is_some());
            assert!(matches!(
                table.share(&entry.target_id, GrantLevel::Read, 1, &me(), &blocklist),
                Err(ShareError::NotGrantable(_))
            ));
        }

        let editor = listed[2].target_id.clone();
        share(&table, &editor, GrantLevel::Read);
        let grown = Blocklist::new(&["com.apple.TextEdit".to_string()]);
        let refused = table
            .begin_read(&editor, 2_000, None, &me(), &grown)
            .unwrap_err();
        assert_eq!(
            refused.0,
            ReadRefusal::NotGrantable(NotGrantable::Blocklisted)
        );
        assert_eq!(
            refused.1.iter().map(|p| p.change).collect::<Vec<_>>(),
            vec![GrantChange::Revoked]
        );
    }

    /// The title a listing hands an agent follows the grant; the person's own
    /// view of a shared window keeps the last title the platform showed.
    #[test]
    fn titles_are_withheld_until_shared_and_kept_when_the_platform_blanks_them() {
        let table = TargetTable::new();
        let (listed, _) = table.observe(&[window(10, 111, 5, "Re: offer")], None);
        let id = listed[0].target_id.clone();
        let blocklist = Blocklist::new(&[]);
        assert_eq!(listed[0].agent_summary(&me(), &blocklist).title, None);

        share(&table, &id, GrantLevel::Read);
        let (listed, _) = table.observe(&[window(10, 111, 5, "")], None);
        assert_eq!(
            listed[0].agent_summary(&me(), &blocklist).title.as_deref(),
            Some("Re: offer")
        );
        assert_eq!(table.shared()[0].title, "Re: offer");
    }

    /// An invisible window is tracked but not listed — unless it is shared,
    /// which is exactly when a hidden application must not lose its window
    /// from sight or its grant.
    #[test]
    fn a_hidden_shared_window_stays_listed_and_shared() {
        let table = TargetTable::new();
        let mut hidden = window(10, 111, 5, "Draft");
        hidden.on_screen = false;
        let (listed, _) = table.observe(&[hidden.clone()], None);
        assert!(!listed[0].worth_listing());

        let (listed, _) = table.observe(&[window(10, 111, 5, "Draft")], None);
        let id = listed[0].target_id.clone();
        share(&table, &id, GrantLevel::Read);
        // The user hides the application: still the same window, still shared.
        let (listed, ended) = table.observe(&[hidden], None);
        assert!(ended.is_empty());
        assert!(listed[0].worth_listing());
        assert_eq!(read(&table, &id).as_deref(), Ok("1.1"));
    }

    /// A window whose application is hidden (⌘H) is listed, and says so to
    /// an agent — off the screen, and neither minimized nor furniture — so
    /// it can be shared and brought back.
    #[test]
    fn a_window_of_a_hidden_application_is_listed_as_hidden() {
        let table = TargetTable::new();
        let mut hidden = window(10, 111, 5, "Notes");
        hidden.on_screen = false;
        hidden.minimized = Some(false);
        hidden.hidden = Some(true);
        let (listed, _) = table.observe(&[hidden], None);
        assert!(listed[0].worth_listing());
        let summary = listed[0].agent_summary(&me(), &Blocklist::new(&[]));
        assert_eq!(summary.hidden, Some(true));
        assert!(!summary.on_screen);
        let wire = serde_json::to_value(&summary).unwrap();
        assert_eq!(wire["hidden"], true);

        // Shown again: no longer said to be hidden.
        let (listed, _) = table.observe(&[window(10, 111, 5, "Notes")], None);
        let summary = listed[0].agent_summary(&me(), &Blocklist::new(&[]));
        assert_eq!(summary.hidden, None);
        assert!(serde_json::to_value(&summary)
            .unwrap()
            .get("hidden")
            .is_none());
    }

    #[test]
    fn switching_the_group_off_ends_every_grant() {
        let table = TargetTable::new();
        let (listed, _) = table.observe(&[window(10, 111, 5, "a"), window(20, 222, 6, "b")], None);
        for entry in &listed {
            share(&table, &entry.target_id, GrantLevel::Read);
        }
        let ended = table.revoke_all(GrantChange::Disabled);
        assert_eq!(ended.windows.len(), 2);
        assert!(ended
            .windows
            .iter()
            .all(|p| p.change == GrantChange::Disabled));
        assert!(table.shared().is_empty());
    }

    /// A paste goes through when the clipboard holds what an agent put there
    /// itself (`paste_ok`) — by its key or by its menu — and is refused
    /// otherwise.
    #[test]
    fn a_paste_goes_only_with_the_agents_own_clipboard() {
        let table = TargetTable::new();
        let (id, _, _) = shared_and_read(&table, GrantLevel::Control);
        let platform = Platform::current();
        let paste = ComputerActRequest::Key {
            target: None,
            chord: Chord {
                key: Key::Char('v'),
                modifiers: if platform == Platform::Mac {
                    Modifiers {
                        meta: true,
                        ..Modifiers::default()
                    }
                } else {
                    Modifiers {
                        control: true,
                        ..Modifiers::default()
                    }
                },
            },
            repeat: 1,
        };
        let with = |paste_ok: bool, request: &ComputerActRequest| {
            table
                .begin_act(
                    &id,
                    3_000,
                    None,
                    &me(),
                    &Blocklist::new(&[]),
                    request,
                    paste_ok,
                )
                .map(|t| t.action)
                .map_err(|(why, _)| why)
        };
        assert_eq!(with(false, &paste), Err(ActDenied::Paste));
        assert!(with(true, &paste).is_ok());
        if platform != Platform::Windows {
            share_app(&table, AppTarget::Window(&id), GrantLevel::Control).unwrap();
            let menu = ComputerActRequest::InvokeMenu {
                path: vec!["Edit".into(), "Paste".into()],
            };
            assert_eq!(with(false, &menu), Err(ActDenied::Paste));
            assert!(with(true, &menu).is_ok());
        }
    }

    /// What is given of a frame goes to the helper as it is — the rest it
    /// takes from the window just before — and a frame no window can have is
    /// refused before anything is sent.
    #[test]
    fn a_window_frame_keeps_what_is_not_given() {
        let table = TargetTable::new();
        let (id, _, _) = shared_and_read(&table, GrantLevel::Control);
        let frame = |x, y, width, height| ComputerActRequest::SetFrame {
            x,
            y,
            width,
            height,
        };
        assert_eq!(
            act(&table, &id, &frame(Some(40.0), None, Some(1024.0), None)),
            Ok(WindowAction::SetFrame {
                x: Some(40.0),
                y: None,
                width: Some(1024.0),
                height: None,
            })
        );
        for bad in [
            frame(None, None, None, None),
            frame(None, None, Some(10.0), None),
            frame(Some(f64::NAN), None, None, None),
            frame(None, Some(-200_000.0), None, None),
            frame(None, None, None, Some(1e9)),
        ] {
            assert_eq!(act(&table, &id, &bad), Err(ActDenied::BadFrame), "{bad:?}");
        }
    }

    // ── applications shared as a whole ─────────────────────────────────────

    fn share_app(
        table: &TargetTable,
        target: AppTarget<'_>,
        level: GrantLevel,
    ) -> Result<AppChange, ShareError> {
        table.share_app(target, level, 1_000, &me(), &Blocklist::new(&[]))
    }

    /// Sharing an application shares every window of it a person could mean,
    /// a window shared on its own before included, and the ones a later
    /// listing finds; nothing of another application. Its windows change
    /// with it and only with it, and ending it ends them all.
    #[test]
    fn an_application_shared_as_a_whole_takes_every_window_of_it() {
        let table = TargetTable::new();
        let (listed, _) = table.observe(
            &[
                window(10, 111, 5, "One"),
                window(10, 111, 6, "Two"),
                window(20, 222, 7, "Other"),
            ],
            None,
        );
        let ids: Vec<String> = listed.iter().map(|e| e.target_id.clone()).collect();
        share(&table, &ids[1], GrantLevel::Read);
        let change = share_app(&table, AppTarget::Window(&ids[0]), GrantLevel::Control).unwrap();
        assert!(change.app_changed);
        assert_eq!(change.windows.len(), 2);
        let shared = table.shared();
        assert_eq!(shared.len(), 2);
        assert!(shared
            .iter()
            .all(|w| w.whole_app && w.level == GrantLevel::Control));
        let apps = table.shared_apps();
        assert_eq!(apps.len(), 1);
        assert_eq!(apps[0].windows, 2);
        assert_eq!(apps[0].level, GrantLevel::Control);
        assert_eq!(
            table.app_level(&raw_app(10, 111, "com.apple.TextEdit")),
            GrantLevel::Control
        );
        assert_eq!(
            table.app_level(&raw_app(20, 222, "com.apple.TextEdit")),
            GrantLevel::None
        );
        assert_eq!(
            table.share(
                &ids[0],
                GrantLevel::Read,
                1_000,
                &me(),
                &Blocklist::new(&[])
            ),
            Err(ShareError::AppShared)
        );

        // A window it opens later is shared with it once a listing finds it.
        let (listed, changed) = table.observe(
            &[
                window(10, 111, 5, "One"),
                window(10, 111, 6, "Two"),
                window(10, 111, 8, "Three"),
                window(20, 222, 7, "Other"),
            ],
            None,
        );
        assert_eq!(changed.len(), 1);
        assert_eq!(changed[0].change, GrantChange::Granted);
        assert!(
            listed[2]
                .agent_summary(&me(), &Blocklist::new(&[]))
                .whole_app
        );
        assert!(
            !listed[3]
                .agent_summary(&me(), &Blocklist::new(&[]))
                .whole_app
        );
        assert_eq!(table.shared_apps()[0].windows, 3);

        let app_id = table.shared_apps()[0].app_id.clone();
        let change = share_app(&table, AppTarget::Share(&app_id), GrantLevel::Read).unwrap();
        assert_eq!(change.windows.len(), 3);
        assert!(table.shared().iter().all(|w| w.level == GrantLevel::Read));
        let change = share_app(&table, AppTarget::Share(&app_id), GrantLevel::None).unwrap();
        assert!(change.app_changed);
        assert_eq!(change.windows.len(), 3);
        assert!(table.shared().is_empty());
        assert!(table.shared_apps().is_empty());
        // Ending what has already ended changes nothing.
        assert_eq!(
            share_app(&table, AppTarget::Share(&app_id), GrantLevel::None),
            Ok(AppChange::default())
        );
    }

    /// An application's windows go on its one clock: using any of them keeps
    /// all of them shared, and when it runs out they all end together.
    #[test]
    fn an_application_share_runs_on_one_clock() {
        let ttl = Some(Duration::from_secs(10));
        let table = TargetTable::new();
        let (listed, _) = table.observe(
            &[window(10, 111, 5, "One"), window(10, 111, 6, "Two")],
            None,
        );
        let (one, two) = (listed[0].target_id.clone(), listed[1].target_id.clone());
        share_app(&table, AppTarget::Window(&one), GrantLevel::Read).unwrap();
        table
            .begin_read(&one, 9_000, ttl, &me(), &Blocklist::new(&[]))
            .unwrap();
        // Two's own grant was last used at 1 000; the application's at 9 000.
        let ticket = table
            .begin_read(&two, 15_000, ttl, &me(), &Blocklist::new(&[]))
            .unwrap();
        assert_eq!(ticket.scope, GrantScope::App);
        let ended = table.sweep(26_000, ttl, &me(), &Blocklist::new(&[]));
        assert!(ended.app_changed);
        assert_eq!(ended.windows.len(), 2);
        assert!(ended
            .windows
            .iter()
            .all(|p| p.change == GrantChange::Expired));
        assert!(table.shared_apps().is_empty());
    }

    /// An application on the blocklist, one that quit and Stop each end its
    /// share as a whole.
    #[test]
    fn an_application_share_ends_with_the_blocklist_its_process_and_stop() {
        let table = TargetTable::new();
        let (listed, _) = table.observe(&[window(10, 111, 5, "One")], None);
        let id = listed[0].target_id.clone();

        share_app(&table, AppTarget::Window(&id), GrantLevel::Read).unwrap();
        let grown = Blocklist::new(&["com.apple.TextEdit".to_string()]);
        let ended = table.sweep(2_000, None, &me(), &grown);
        assert!(ended.app_changed);
        assert_eq!(ended.windows[0].change, GrantChange::Revoked);

        share_app(&table, AppTarget::Window(&id), GrantLevel::Read).unwrap();
        assert!(!table.prune_apps(|_, _| true).app_changed);
        let quit = table.prune_apps(|pid, started_at| (pid, started_at) != (10, 111));
        assert!(quit.app_changed);
        assert!(table.shared_apps().is_empty());

        share_app(&table, AppTarget::Window(&id), GrantLevel::Read).unwrap();
        let stopped = table.revoke_all(GrantChange::Stopped);
        assert!(stopped.app_changed);
        assert!(table.shared_apps().is_empty());
        assert!(table.shared().is_empty());
        // A window of it found after Stop is not shared again.
        let (_, changed) = table.observe(
            &[window(10, 111, 5, "One"), window(10, 111, 9, "New")],
            None,
        );
        assert!(changed.is_empty());
    }

    /// A double-click in a window holds no keys down: the driver's
    /// double-click does not hold them, on macOS and Linux refusing them and
    /// on Windows going without them. A single click holds them.
    #[test]
    fn a_double_click_in_a_window_holds_no_keys() {
        let table = TargetTable::new();
        let (id, _, capture) = shared_and_read(&table, GrantLevel::Control);
        let click = |count: u8, shift: bool| ComputerActRequest::Click {
            target: AgentTarget::Point(PointTarget {
                generation: capture.clone(),
                x: 1.0,
                y: 1.0,
            }),
            button: PointerButton::Left,
            count,
            modifiers: Modifiers {
                shift,
                ..Modifiers::default()
            },
        };
        assert_eq!(
            act(&table, &id, &click(2, true)),
            Err(ActDenied::DoubleClickModifiers)
        );
        assert!(act(&table, &id, &click(2, false)).is_ok());
        assert!(act(&table, &id, &click(1, true)).is_ok());
    }

    /// Menus, the application's own shortcuts and Option over the pointer
    /// need the application shared as a whole; the desktop's shortcuts and a
    /// paste stay out of reach even then.
    #[test]
    fn menus_and_application_shortcuts_need_the_whole_application() {
        let table = TargetTable::new();
        let (id, _, capture) = shared_and_read(&table, GrantLevel::Control);
        let platform = Platform::current();
        let primary = |key: char| ComputerActRequest::Key {
            target: None,
            chord: Chord {
                key: Key::Char(key),
                modifiers: if platform == Platform::Mac {
                    Modifiers {
                        meta: true,
                        ..Modifiers::default()
                    }
                } else {
                    Modifiers {
                        control: true,
                        ..Modifiers::default()
                    }
                },
            },
            repeat: 1,
        };
        let switch = ComputerActRequest::Key {
            target: None,
            chord: Chord {
                key: Key::Tab,
                modifiers: if platform == Platform::Mac {
                    Modifiers {
                        meta: true,
                        ..Modifiers::default()
                    }
                } else {
                    Modifiers {
                        alt: true,
                        ..Modifiers::default()
                    }
                },
            },
            repeat: 1,
        };
        let menu = ComputerActRequest::InvokeMenu {
            path: vec![" File ".into(), "Close".into()],
        };
        let option_click = ComputerActRequest::Click {
            target: AgentTarget::Point(PointTarget {
                generation: capture.clone(),
                x: 1.0,
                y: 1.0,
            }),
            button: PointerButton::Left,
            count: 1,
            modifiers: Modifiers {
                alt: true,
                ..Modifiers::default()
            },
        };

        assert_eq!(act(&table, &id, &menu), Err(ActDenied::AppGrantRequired));
        assert_eq!(act(&table, &id, &primary('q')), Err(ActDenied::ChordBeyond));
        assert_eq!(act(&table, &id, &switch), Err(ActDenied::ChordBeyond));
        if platform == Platform::Mac {
            assert_eq!(act(&table, &id, &option_click), Err(ActDenied::ChordBeyond));
        }

        share_app(&table, AppTarget::Window(&id), GrantLevel::Control).unwrap();
        match act(&table, &id, &menu) {
            Ok(WindowAction::InvokeMenu { path }) => {
                assert_ne!(platform, Platform::Windows);
                assert_eq!(path, vec!["File".to_string(), "Close".to_string()]);
            }
            Err(ActDenied::MenusUnavailable) => assert_eq!(platform, Platform::Windows),
            other => panic!("{other:?}"),
        }
        assert!(act(&table, &id, &primary('q')).is_ok());
        assert_eq!(act(&table, &id, &primary('v')), Err(ActDenied::Paste));
        // A paste by its menu is a paste, wherever on the way it is named.
        if platform != Platform::Windows {
            for path in [
                vec!["Edit".to_string(), "Paste".to_string()],
                vec![
                    "Edit".to_string(),
                    "Paste Special…".to_string(),
                    "Unformatted Text".to_string(),
                ],
            ] {
                assert_eq!(
                    act(&table, &id, &ComputerActRequest::InvokeMenu { path }),
                    Err(ActDenied::Paste)
                );
            }
        }
        assert_eq!(act(&table, &id, &switch), Err(ActDenied::DesktopChord));
        // The share of a window the application took on keeps what was read
        // under its own: the screenshot's points still resolve.
        assert!(act(&table, &id, &option_click).is_ok());
    }

    // ── acting ─────────────────────────────────────────────────────────────

    use crate::computer::keys::{Chord, Key, Modifiers};
    use crate::computer::types::{PointerButton, ScrollDirection, ScrollUnit};

    /// A shared window with one snapshot read (refs 1–4 given, 5 cut, 2
    /// secret) and one screenshot read (a 1000×500 image of a 2000×1000
    /// capture of a 1000×500-point window). Returns the id and the two
    /// generations.
    fn shared_and_read(table: &TargetTable, level: GrantLevel) -> (String, String, String) {
        let (listed, _) = table.observe(&[window(10, 111, 5, "Form")], None);
        let id = listed[0].target_id.clone();
        share(table, &id, level);
        let ticket = table
            .begin_read(&id, 2_000, None, &me(), &Blocklist::new(&[]))
            .unwrap();
        let snapshot = table
            .finish_read(
                &ticket,
                &me(),
                &Blocklist::new(&[]),
                Some(ReadMark::Snapshot {
                    snapshot_id: Some("s0000000a".into()),
                    shown: [1, 2, 3, 4].into_iter().collect(),
                    cut: [5].into_iter().collect(),
                    secret: [2].into_iter().collect(),
                }),
            )
            .unwrap();
        let capture = table
            .finish_read(
                &ticket,
                &me(),
                &Blocklist::new(&[]),
                Some(ReadMark::Capture {
                    width: 1000,
                    height: 500,
                    native_width: 2000,
                    native_height: 1000,
                    full_size: true,
                    window_bounds: Rect {
                        x: 0.0,
                        y: 0.0,
                        width: 1000.0,
                        height: 500.0,
                    },
                }),
            )
            .unwrap();
        (id, snapshot, capture)
    }

    fn act(
        table: &TargetTable,
        id: &str,
        request: &ComputerActRequest,
    ) -> Result<WindowAction, ActDenied> {
        table
            .begin_act(id, 3_000, None, &me(), &Blocklist::new(&[]), request, false)
            .map(|t| t.action)
            .map_err(|(why, _)| why)
    }

    fn click_ref(generation: &str, index: u32) -> ComputerActRequest {
        ComputerActRequest::Click {
            target: AgentTarget::Element(ElementTarget {
                generation: generation.into(),
                index,
            }),
            button: PointerButton::Left,
            count: 1,
            modifiers: Modifiers::default(),
        }
    }

    fn click_at(generation: &str, x: f64, y: f64) -> ComputerActRequest {
        ComputerActRequest::Click {
            target: AgentTarget::Point(PointTarget {
                generation: generation.into(),
                x,
                y,
            }),
            button: PointerButton::Left,
            count: 1,
            modifiers: Modifiers::default(),
        }
    }

    /// Acting needs a grant for control: an unknown id, an unshared window
    /// and a window shared for reading are each refused as such, before
    /// anything about the action is looked at.
    #[test]
    fn acting_needs_a_grant_for_control() {
        let table = TargetTable::new();
        let (id, snapshot, _) = shared_and_read(&table, GrantLevel::Read);
        assert_eq!(
            act(&table, "w999", &click_ref(&snapshot, 1)),
            Err(ActDenied::NoSuchTarget)
        );
        assert_eq!(
            act(&table, &id, &click_ref(&snapshot, 1)),
            Err(ActDenied::ControlRequired)
        );
        // Even a key no grant allows is answered as "read only" first.
        let quit = ComputerActRequest::Key {
            target: None,
            chord: Chord {
                key: Key::Char('q'),
                modifiers: Modifiers {
                    meta: true,
                    control: true,
                    ..Modifiers::default()
                },
            },
            repeat: 1,
        };
        assert_eq!(act(&table, &id, &quit), Err(ActDenied::ControlRequired));
        // Putting a minimized window back changes what is on the screen: an
        // action like any other.
        assert_eq!(
            act(&table, &id, &ComputerActRequest::Restore),
            Err(ActDenied::ControlRequired)
        );
        share(&table, &id, GrantLevel::Control);
        assert_eq!(
            act(&table, &id, &ComputerActRequest::Restore),
            Ok(WindowAction::Restore)
        );
        share(&table, &id, GrantLevel::None);
        assert_eq!(
            act(&table, &id, &click_ref(&snapshot, 1)),
            Err(ActDenied::GrantRequired)
        );
    }

    /// A ref resolves against the latest snapshot as the agent was given it:
    /// cut and missing refs are told apart, an older generation is stale, and
    /// a secret field takes a click but no text.
    #[test]
    fn refs_resolve_against_the_latest_snapshot_as_given() {
        let table = TargetTable::new();
        let (id, snapshot, capture) = shared_and_read(&table, GrantLevel::Control);
        assert_eq!(
            act(&table, &id, &click_ref(&snapshot, 3)),
            Ok(WindowAction::Click {
                at: DriverTarget::Element(ElementRef {
                    snapshot_id: "s0000000a".into(),
                    index: 3
                }),
                button: PointerButton::Left,
                count: 1,
                modifiers: Modifiers::default(),
            })
        );
        assert_eq!(
            act(&table, &id, &click_ref(&snapshot, 5)),
            Err(ActDenied::Stale(Staleness::CutAway(5)))
        );
        assert_eq!(
            act(&table, &id, &click_ref(&snapshot, 9)),
            Err(ActDenied::Stale(Staleness::NoSuchRef(9)))
        );
        // The screenshot's generation is not a snapshot's.
        assert_eq!(
            act(&table, &id, &click_ref(&capture, 3)),
            Err(ActDenied::Stale(Staleness::OldSnapshot))
        );
        // The secret field: clickable, and nothing typed or set into it.
        assert!(act(&table, &id, &click_ref(&snapshot, 2)).is_ok());
        let pw = ElementTarget {
            generation: snapshot.clone(),
            index: 2,
        };
        for writes in [
            ComputerActRequest::Type {
                target: pw.clone(),
                text: "hunter2".into(),
                submit: false,
            },
            ComputerActRequest::SetValue {
                target: pw.clone(),
                value: "hunter2".into(),
            },
            ComputerActRequest::Key {
                target: Some(pw.clone()),
                chord: Chord {
                    key: Key::Char('h'),
                    modifiers: Modifiers::default(),
                },
                repeat: 1,
            },
        ] {
            assert_eq!(act(&table, &id, &writes), Err(ActDenied::Secret), "{writes:?}");
        }
    }

    /// A drag's two points are read in the latest screenshot like a click's
    /// one, each refused as a click's would be; keys are held over it only on
    /// a Mac, and there not Option; a held key is judged as a pressed one.
    #[test]
    fn drags_and_held_keys_resolve_like_clicks_and_keys() {
        let table = TargetTable::new();
        let (id, snapshot, capture) = shared_and_read(&table, GrantLevel::Control);
        let point = |generation: &str, x: f64, y: f64| PointTarget {
            generation: generation.into(),
            x,
            y,
        };
        let drag =
            |from: PointTarget, to: PointTarget, modifiers: Modifiers| ComputerActRequest::Drag {
                from,
                to,
                button: PointerButton::Left,
                modifiers,
                duration_ms: Some(60_000),
            };
        let none = Modifiers::default();
        let shift = Modifiers {
            shift: true,
            ..Modifiers::default()
        };
        match act(
            &table,
            &id,
            &drag(
                point(&capture, 10.0, 20.0),
                point(&capture, 300.0, 400.0),
                none,
            ),
        ) {
            Ok(WindowAction::Drag {
                from,
                to,
                modifiers,
                duration_ms,
                ..
            }) => {
                // 1000×500 image of a 2000×1000 capture: twice the pixels.
                assert_eq!((from.x, from.y), (20.0, 40.0));
                assert_eq!((to.x, to.y), (600.0, 800.0));
                assert_eq!(modifiers, none);
                assert_eq!(duration_ms, crate::computer::types::MAX_DRAG_MS);
            }
            other => panic!("{other:?}"),
        }
        assert_eq!(
            act(
                &table,
                &id,
                &drag(
                    point(&capture, 10.0, 20.0),
                    point(&capture, 1500.0, 20.0),
                    none
                )
            ),
            Err(ActDenied::OutOfImage)
        );
        assert_eq!(
            act(
                &table,
                &id,
                &drag(
                    point(&snapshot, 10.0, 20.0),
                    point(&capture, 30.0, 20.0),
                    none
                )
            ),
            Err(ActDenied::Stale(Staleness::OldCapture))
        );
        let held = |modifiers: Modifiers| {
            act(
                &table,
                &id,
                &drag(
                    point(&capture, 1.0, 1.0),
                    point(&capture, 2.0, 2.0),
                    modifiers,
                ),
            )
        };
        let command = Modifiers {
            meta: true,
            ..Modifiers::default()
        };
        let option = Modifiers {
            alt: true,
            ..Modifiers::default()
        };
        if Platform::current() == Platform::Mac {
            for allowed in [shift, command] {
                match held(allowed) {
                    Ok(WindowAction::Drag { modifiers, .. }) => assert_eq!(modifiers, allowed),
                    other => panic!("{other:?}"),
                }
            }
            assert_eq!(held(option), Err(ActDenied::ChordBeyond));
        } else {
            // The desktop's key is refused as a key; the rest because the
            // driver would drag without them.
            assert_eq!(held(command), Err(ActDenied::ChordBeyond));
            for dropped in [shift, option] {
                assert_eq!(held(dropped), Err(ActDenied::DragModifiers));
            }
        }

        let hold = |chord: Chord, target: Option<ElementTarget>| ComputerActRequest::HoldKey {
            target,
            chord,
            duration_ms: 99_000,
        };
        let right = Chord {
            key: Key::Right,
            modifiers: Modifiers::default(),
        };
        assert_eq!(
            act(&table, &id, &hold(right, None)),
            Ok(WindowAction::Key {
                element: None,
                chord: right,
            })
        );
        let letter = Chord {
            key: Key::Char('w'),
            modifiers: Modifiers::default(),
        };
        assert_eq!(
            act(&table, &id, &hold(letter, None)),
            Err(ActDenied::NeedsElement)
        );
        let secret = ElementTarget {
            generation: snapshot.clone(),
            index: 2,
        };
        assert_eq!(
            act(&table, &id, &hold(letter, Some(secret))),
            Err(ActDenied::Secret)
        );
    }

    /// A point is read in the latest screenshot's pixels and mapped back to
    /// the window's own; one outside the image, or from another screenshot,
    /// is refused.
    #[test]
    fn points_resolve_against_the_latest_screenshot() {
        let table = TargetTable::new();
        let (id, _, capture) = shared_and_read(&table, GrantLevel::Control);
        assert_eq!(
            act(&table, &id, &click_at(&capture, 100.0, 50.5)),
            Ok(WindowAction::Click {
                at: DriverTarget::Point(WindowPoint {
                    x: 200.0,
                    y: 101.0,
                    window_width: 1000.0,
                    window_height: 500.0,
                }),
                button: PointerButton::Left,
                count: 1,
                modifiers: Modifiers::default(),
            })
        );
        for (x, y) in [(1000.0, 10.0), (10.0, 500.0), (-1.0, 3.0), (f64::NAN, 3.0)] {
            assert_eq!(
                act(&table, &id, &click_at(&capture, x, y)),
                Err(ActDenied::OutOfImage),
                "{x},{y}"
            );
        }
        assert_eq!(
            act(&table, &id, &click_at("1.1", 1.0, 1.0)),
            Err(ActDenied::Stale(Staleness::OldCapture))
        );
        // A screenshot codeg cannot map back to the window's pixels cannot
        // be pointed into.
        let ticket = table
            .begin_read(&id, 2_000, None, &me(), &Blocklist::new(&[]))
            .unwrap();
        let unmapped = table
            .finish_read(
                &ticket,
                &me(),
                &Blocklist::new(&[]),
                Some(ReadMark::Capture {
                    width: 1000,
                    height: 500,
                    native_width: 1000,
                    native_height: 500,
                    full_size: false,
                    window_bounds: Rect::default(),
                }),
            )
            .unwrap();
        assert_eq!(
            act(&table, &id, &click_at(&unmapped, 1.0, 1.0)),
            Err(ActDenied::NoPointing)
        );
    }

    /// An action is placed on the screen from where the helper says it
    /// aimed: an element at the middle of its frame, a point at its offset in
    /// the window's units from where the window was measured to be — and an
    /// action on the focus, or a report without the frame, nowhere.
    #[test]
    fn an_action_is_placed_where_it_landed() {
        use crate::computer::types::ActEffect;
        let table = TargetTable::new();
        let (id, snapshot, capture) = shared_and_read(&table, GrantLevel::Control);
        let aim = |request: &ComputerActRequest| {
            table
                .begin_act(
                    &id,
                    3_000,
                    None,
                    &me(),
                    &Blocklist::new(&[]),
                    request,
                    false,
                )
                .unwrap()
                .aim
        };
        let frame = |x, y, width, height| Rect {
            x,
            y,
            width,
            height,
        };
        let report = |element_frame, window_frame| RawAct {
            effect: ActEffect::Confirmed,
            route: None,
            submitted: None,
            submit_note: None,
            element_frame,
            window_frame,
            clipboard: None,
        };

        // The screenshot is 1000×500 of a 1000×500-unit window drawn at
        // 2000×1000 pixels: (100, 50.5) in it is (100, 50.5) units in.
        let point = aim(&click_at(&capture, 100.0, 50.5));
        assert_eq!(point, Aim::Offset { x: 100.0, y: 50.5 });
        let moved = report(None, Some(frame(300.0, 40.0, 1000.0, 500.0)));
        assert_eq!(point.landing(&moved), Some((400.0, 90.5)));
        assert_eq!(point.landing(&report(None, None)), None);

        let element = aim(&click_ref(&snapshot, 3));
        assert_eq!(element, Aim::Element);
        let placed = report(Some(frame(10.0, 20.0, 30.0, 40.0)), None);
        assert_eq!(element.landing(&placed), Some((25.0, 40.0)));
        assert_eq!(
            element.landing(&report(Some(frame(10.0, 20.0, 0.0, 40.0)), None)),
            None
        );

        let focus = aim(&ComputerActRequest::Key {
            target: None,
            chord: Chord {
                key: Key::Return,
                modifiers: Default::default(),
            },
            repeat: 1,
        });
        assert_eq!(focus, Aim::Focus);
        assert_eq!(focus.landing(&placed), None);
    }

    /// Taking the window back and sharing it again is a new grant: nothing
    /// read under the old one can be acted on.
    #[test]
    fn a_new_grant_forgets_what_was_read_under_the_old() {
        let table = TargetTable::new();
        let (id, snapshot, capture) = shared_and_read(&table, GrantLevel::Control);
        share(&table, &id, GrantLevel::None);
        share(&table, &id, GrantLevel::Control);
        assert_eq!(
            act(&table, &id, &click_ref(&snapshot, 3)),
            Err(ActDenied::Stale(Staleness::NoSnapshot))
        );
        assert_eq!(
            act(&table, &id, &click_at(&capture, 1.0, 1.0)),
            Err(ActDenied::Stale(Staleness::NoCapture))
        );
        // A change of level keeps the grant, and what was read under it.
        let table = TargetTable::new();
        let (id, snapshot, _) = shared_and_read(&table, GrantLevel::Read);
        share(&table, &id, GrantLevel::Control);
        assert!(act(&table, &id, &click_ref(&snapshot, 3)).is_ok());
    }

    /// Keys: the window's own chords go through; a paste, a chord that
    /// reaches the application or the desktop, and a character key with no
    /// element are refused, each as itself.
    #[test]
    fn keys_are_judged_for_a_window_grant() {
        let table = TargetTable::new();
        let (id, snapshot, _) = shared_and_read(&table, GrantLevel::Control);
        let primary = if cfg!(target_os = "macos") {
            Modifiers {
                meta: true,
                ..Modifiers::default()
            }
        } else {
            Modifiers {
                control: true,
                ..Modifiers::default()
            }
        };
        let key = |key: Key, modifiers: Modifiers, target: Option<ElementTarget>| {
            ComputerActRequest::Key {
                target,
                chord: Chord { key, modifiers },
                repeat: 1,
            }
        };
        assert!(act(&table, &id, &key(Key::Return, Modifiers::default(), None)).is_ok());
        assert!(act(&table, &id, &key(Key::Char('a'), primary, None)).is_ok());
        assert_eq!(
            act(&table, &id, &key(Key::Char('v'), primary, None)),
            Err(ActDenied::Paste)
        );
        assert_eq!(
            act(&table, &id, &key(Key::Char('q'), primary, None)),
            Err(ActDenied::ChordBeyond)
        );
        assert_eq!(
            act(&table, &id, &key(Key::Char('x'), Modifiers::default(), None)),
            Err(ActDenied::NeedsElement)
        );
        let field = ElementTarget {
            generation: snapshot,
            index: 3,
        };
        assert!(act(
            &table,
            &id,
            &key(Key::Char('x'), Modifiers::default(), Some(field))
        )
        .is_ok());
        let scroll = ComputerActRequest::Scroll {
            target: None,
            direction: ScrollDirection::Down,
            amount: 3,
            unit: ScrollUnit::Line,
        };
        assert!(act(&table, &id, &scroll).is_ok());
    }

    /// An action keeps the grant in use, like a read; a lapsed grant ends at
    /// the action, which is refused.
    #[test]
    fn an_action_uses_the_grant_and_a_lapsed_one_ends() {
        let ttl = Some(Duration::from_secs(10));
        let table = TargetTable::new();
        let (id, snapshot, _) = shared_and_read(&table, GrantLevel::Control);
        table
            .begin_act(
                &id,
                9_000,
                ttl,
                &me(),
                &Blocklist::new(&[]),
                &click_ref(&snapshot, 1),
                false,
            )
            .unwrap();
        assert_eq!(table.shared()[0].last_used_at, 9_000);
        let (why, ended) = table
            .begin_act(
                &id,
                30_000,
                ttl,
                &me(),
                &Blocklist::new(&[]),
                &click_ref(&snapshot, 1),
                false,
            )
            .unwrap_err();
        assert_eq!(why, ActDenied::GrantRequired);
        assert_eq!(
            ended.iter().map(|p| p.change).collect::<Vec<_>>(),
            vec![GrantChange::Expired]
        );
    }

    // ── the entire screen ──────────────────────────────────────────────────

    fn share_screen(table: &TargetTable, level: GrantLevel, now: i64) -> AppChange {
        table.share_screen(level, now, &me(), &Blocklist::new(&[]))
    }

    /// A 1000×500 picture of a 2000×1000-pixel capture of a screen 1000×500
    /// desktop units across, read under the screen's latest sharing.
    fn screen_read(table: &TargetTable, now: i64) -> Result<String, ReadRefusal> {
        let ticket = table.begin_screen_read(now, None).map_err(|(why, _)| why)?;
        table.finish_screen_read(
            &ticket,
            ReadMark::Capture {
                width: 1000,
                height: 500,
                native_width: 2000,
                native_height: 1000,
                full_size: true,
                window_bounds: Rect {
                    x: 0.0,
                    y: 0.0,
                    width: 1000.0,
                    height: 500.0,
                },
            },
        )
    }

    fn screen_act(
        table: &TargetTable,
        request: &ComputerActRequest,
    ) -> Result<ScreenActTicket, ActDenied> {
        table
            .begin_screen_act(3_000, None, request)
            .map_err(|(why, _)| why)
    }

    /// Sharing the entire screen shares every window the rules allow — one
    /// shared on its own, and an application shared as a whole, taken over —
    /// and the ones later listings find; never one the rules forbid. Nothing
    /// is shared or unshared on its own while it is, and ending it ends every
    /// window's share of it.
    #[test]
    fn the_entire_screen_takes_every_window_the_rules_allow() {
        let table = TargetTable::new();
        let mut vault = window(30, 333, 9, "Vault");
        vault.app = raw_app(30, 333, "com.1password.1password");
        let (listed, _) = table.observe(
            &[
                window(10, 111, 5, "One"),
                window(20, 222, 7, "Other"),
                vault.clone(),
            ],
            None,
        );
        let ids: Vec<String> = listed.iter().map(|e| e.target_id.clone()).collect();
        share(&table, &ids[0], GrantLevel::Control);
        share_app(&table, AppTarget::Window(&ids[1]), GrantLevel::Control).unwrap();

        let change = share_screen(&table, GrantLevel::Read, 1_000);
        assert!(change.app_changed);
        assert_eq!(change.windows.len(), 2);
        assert!(table.shared_apps().is_empty());
        let shared = table.shared();
        assert_eq!(shared.len(), 2);
        assert!(shared
            .iter()
            .all(|w| w.whole_screen && !w.whole_app && w.level == GrantLevel::Read));
        assert_eq!(
            table.shared_screen().map(|s| (s.level, s.windows)),
            Some((GrantLevel::Read, 2))
        );
        let summary = table
            .get(&ids[0])
            .unwrap()
            .agent_summary(&me(), &Blocklist::new(&[]));
        assert!(summary.whole_screen);
        // The vault stays out of it.
        assert_eq!(table.get(&ids[2]).unwrap().grant, None);

        // Nothing changes on its own while the screen is shared.
        assert_eq!(
            table.share(
                &ids[0],
                GrantLevel::None,
                1_000,
                &me(),
                &Blocklist::new(&[])
            ),
            Err(ShareError::ScreenShared)
        );
        assert_eq!(
            share_app(&table, AppTarget::Window(&ids[0]), GrantLevel::Read),
            Err(ShareError::ScreenShared)
        );

        // A window that comes up later is shared with it; one of the vault's
        // is not.
        let mut vault_two = vault.clone();
        vault_two.window_id = 10;
        let (listed, granted) = table.observe(
            &[
                window(10, 111, 5, "One"),
                window(20, 222, 7, "Other"),
                vault,
                vault_two,
                window(40, 444, 11, "New"),
            ],
            None,
        );
        assert_eq!(granted.len(), 1);
        assert_eq!(granted[0].target_id, listed[4].target_id);
        assert_eq!(table.shared().len(), 3);

        // The same sharing at another level keeps what its windows read.
        let epoch = table.get(&ids[0]).unwrap().epoch;
        let change = share_screen(&table, GrantLevel::Control, 2_000);
        assert!(change.app_changed);
        assert!(table
            .shared()
            .iter()
            .all(|w| w.level == GrantLevel::Control));
        assert_eq!(table.get(&ids[0]).unwrap().epoch, epoch);

        let ended = share_screen(&table, GrantLevel::None, 3_000);
        assert!(ended.app_changed);
        assert_eq!(ended.windows.len(), 3);
        assert!(ended
            .windows
            .iter()
            .all(|p| p.change == GrantChange::Revoked));
        assert!(table.shared().is_empty());
        assert_eq!(table.shared_screen(), None);
        // Each window may be shared on its own again.
        assert!(table
            .share(
                &ids[0],
                GrantLevel::Read,
                4_000,
                &me(),
                &Blocklist::new(&[])
            )
            .is_ok());
    }

    /// The screen runs on one clock, which any window shared with it keeps
    /// running; when it is up the screen's share ends, every window's with
    /// it. A window the blocklist now forbids loses its share of the screen
    /// alone, and later ones of its application are not shared.
    #[test]
    fn the_entire_screen_runs_on_one_clock_and_follows_the_rules() {
        let ttl = Some(Duration::from_secs(10));
        let table = TargetTable::new();
        let (listed, _) = table.observe(
            &[window(10, 111, 5, "One"), window(20, 222, 7, "Other")],
            None,
        );
        let ids: Vec<String> = listed.iter().map(|e| e.target_id.clone()).collect();
        share_screen(&table, GrantLevel::Read, 1_000);
        table
            .begin_read(&ids[0], 9_000, ttl, &me(), &Blocklist::new(&[]))
            .unwrap();
        assert_eq!(table.shared_screen().unwrap().last_used_at, 9_000);
        // Another window is still on the screen's clock, kept running.
        table
            .begin_read(&ids[1], 15_000, ttl, &me(), &Blocklist::new(&[]))
            .unwrap();

        // The blocklist grows: those windows' shares of the screen end, the
        // screen's does not.
        let grown = Blocklist::new(&["com.apple.TextEdit".to_string()]);
        let swept = table.sweep(16_000, ttl, &me(), &grown);
        assert_eq!(swept.windows.len(), 2);
        assert!(swept
            .windows
            .iter()
            .all(|p| p.change == GrantChange::Revoked));
        assert!(table.shared_screen().is_some());
        // And a later window of the forbidden application is not shared.
        let (_, granted) = table.observe(&[window(10, 111, 6, "Three")], Some(10));
        assert!(granted.is_empty());

        let swept = table.sweep(30_000, ttl, &me(), &Blocklist::new(&[]));
        assert!(swept.app_changed);
        assert_eq!(table.shared_screen(), None);
    }

    /// The screen is a target of its own: read for a picture under a
    /// generation of its sharing, and acted on by points of its latest
    /// picture — a click, a drag, a scroll, with any keys held — and nothing
    /// else. A new sharing is new generations.
    #[test]
    fn the_entire_screen_is_read_and_pointed_at() {
        let table = TargetTable::new();
        assert_eq!(screen_read(&table, 1_000), Err(ReadRefusal::GrantRequired));
        share_screen(&table, GrantLevel::Read, 1_000);
        let picture = screen_read(&table, 2_000).unwrap();
        assert_eq!(picture, "1.1");
        let click = |generation: &str, x: f64, y: f64| ComputerActRequest::Click {
            target: AgentTarget::Point(PointTarget {
                generation: generation.into(),
                x,
                y,
            }),
            button: PointerButton::Left,
            count: 1,
            modifiers: Modifiers {
                alt: true,
                meta: true,
                ..Modifiers::default()
            },
        };
        assert_eq!(
            screen_act(&table, &click(&picture, 10.0, 20.0)),
            Err(ActDenied::ControlRequired)
        );

        share_screen(&table, GrantLevel::Control, 2_000);
        let ticket = screen_act(&table, &click(&picture, 10.0, 20.0)).unwrap();
        assert_eq!(
            ticket.geometry,
            ScreenGeometry {
                scale: 2.0,
                width: 1000.0,
                height: 500.0,
            }
        );
        assert!(table.screen_controlled(ticket.epoch));
        match ticket.action {
            WindowAction::Click {
                at: DriverTarget::Point(p),
                ..
            } => assert_eq!((p.x, p.y), (20.0, 40.0)),
            other => panic!("{other:?}"),
        }
        assert_eq!(
            screen_act(&table, &click(&picture, 1000.0, 20.0)),
            Err(ActDenied::OutOfImage)
        );
        assert_eq!(
            screen_act(&table, &click("1.0", 10.0, 20.0)),
            Err(ActDenied::Stale(Staleness::OldCapture))
        );
        let key = ComputerActRequest::Key {
            target: None,
            chord: Chord {
                key: Key::Return,
                modifiers: Modifiers::default(),
            },
            repeat: 1,
        };
        assert_eq!(screen_act(&table, &key), Err(ActDenied::ScreenPointerOnly));
        let focus_scroll = ComputerActRequest::Scroll {
            target: None,
            direction: ScrollDirection::Down,
            amount: 3,
            unit: ScrollUnit::Line,
        };
        assert_eq!(
            screen_act(&table, &focus_scroll),
            Err(ActDenied::ScreenPointerOnly)
        );

        // Lowered to reading, the sharing no longer lets that action go.
        share_screen(&table, GrantLevel::Read, 3_000);
        assert!(!table.screen_controlled(ticket.epoch));
        // Shared anew: what was read under the last sharing names nothing.
        share_screen(&table, GrantLevel::None, 3_000);
        assert_eq!(
            screen_act(&table, &click(&picture, 10.0, 20.0)),
            Err(ActDenied::GrantRequired)
        );
        share_screen(&table, GrantLevel::Control, 3_000);
        assert_eq!(
            screen_act(&table, &click(&picture, 10.0, 20.0)),
            Err(ActDenied::Stale(Staleness::NoCapture))
        );
        assert_eq!(screen_read(&table, 4_000).unwrap(), "2.1");
        // Stop ends it with everything else.
        assert!(table.revoke_all(GrantChange::Stopped).app_changed);
        assert_eq!(table.shared_screen(), None);
    }

    /// A window shared with the screen takes the desktop's own keys, and its
    /// application's menus — but never the keys that lock the screen or log
    /// out.
    #[test]
    fn a_window_shared_with_the_screen_takes_the_desktops_keys() {
        let table = TargetTable::new();
        let (id, _, _) = shared_and_read(&table, GrantLevel::Read);
        share(&table, &id, GrantLevel::None);
        share_screen(&table, GrantLevel::Control, 2_000);
        let platform = Platform::current();
        let chord = |key: Key, modifiers: Modifiers| ComputerActRequest::Key {
            target: None,
            chord: Chord { key, modifiers },
            repeat: 1,
        };
        let (switch, lock) = match platform {
            Platform::Mac => (
                chord(
                    Key::Tab,
                    Modifiers {
                        meta: true,
                        ..Modifiers::default()
                    },
                ),
                chord(
                    Key::Char('q'),
                    Modifiers {
                        meta: true,
                        control: true,
                        ..Modifiers::default()
                    },
                ),
            ),
            _ => (
                chord(
                    Key::Tab,
                    Modifiers {
                        alt: true,
                        ..Modifiers::default()
                    },
                ),
                chord(
                    Key::Char('l'),
                    Modifiers {
                        meta: true,
                        ..Modifiers::default()
                    },
                ),
            ),
        };
        assert!(act(&table, &id, &switch).is_ok());
        assert_eq!(act(&table, &id, &lock), Err(ActDenied::SessionChord));
        let menu = ComputerActRequest::InvokeMenu {
            path: vec!["File".into(), "Close".into()],
        };
        match act(&table, &id, &menu) {
            Ok(WindowAction::InvokeMenu { .. }) => assert_ne!(platform, Platform::Windows),
            Err(ActDenied::MenusUnavailable) => assert_eq!(platform, Platform::Windows),
            other => panic!("{other:?}"),
        }
    }
}
