//! Reopening the workspace windows that were open when codeg last quit.
//!
//! A workspace window is the local `main` window or a remote workspace window
//! (`remote-workspace-{id}`, at most one per saved remote connection). The
//! window-state plugin puts each of them back where it was, but only once
//! something builds it again — and at launch the only thing that did was the
//! setup hook building `main`. Every launch therefore came back to the local
//! workspace alone, however many remote workspaces had been open.
//!
//! So this module keeps the list of open workspace windows, least recently
//! focused first, writes it to `app_metadata` whenever a window joins or leaves
//! it and once more at quit, and replays it at the next launch:
//!
//!   * `main` is always built — the tray, the dock, deep links and the close
//!     prompt all hang off it — but it starts hidden when it had been closed
//!     (hidden to the tray) at quit and something else is coming back instead.
//!   * The remote windows reopen in the background, behind the same health
//!     check a manual open runs, and in the remembered order, so the window
//!     that was in front at quit is in front again.
//!   * A remote workspace that cannot be reopened brings `main` up with a toast
//!     saying why ([`take_workspace_restore_failures`]), rather than leaving a
//!     window silently missing — or no window at all.
//!
//! "Open" means "not closed by the user": a minimized window is open, and so
//! is every window of an app hidden with ⌘H, while `main` hidden to the tray is
//! closed. `is_visible()` cannot tell those apart (it is false for all three),
//! which is why the list is kept from the hide / show / focus / destroy events
//! as they happen instead of being read back from the windows at quit.

use std::collections::HashMap;
use std::sync::{Mutex, MutexGuard};

use sea_orm::DatabaseConnection;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

use crate::app_error::AppCommandError;
use crate::db::service::{app_metadata_service, remote_workspace_connection_service};
use crate::db::AppDatabase;
use crate::models::RemoteWorkspaceConnectionInfo;

/// Where the list is kept in `app_metadata`.
const SESSION_KEY: &str = "workspace_windows_session";

/// Format of the stored list. Nothing reads it yet: it is there for a later
/// format to recognise this one by.
const SESSION_VERSION: u32 = 1;

/// Label of the local workspace window.
pub const LOCAL_WORKSPACE_LABEL: &str = "main";

/// Label prefix of the remote workspace windows; the connection id follows.
pub const REMOTE_WORKSPACE_LABEL_PREFIX: &str = "remote-workspace-";

/// Sent to `main` once a remote workspace that could not be reopened has been
/// parked for it. Carries nothing: the failures are taken with
/// [`take_workspace_restore_failures`], so one sent before the webview was
/// listening loses nothing. Mirrored by `WORKSPACE_RESTORE_FAILED_EVENT` in
/// `src/lib/workspace-restore.ts`.
pub const RESTORE_FAILED_EVENT: &str = "workspace://restore-failed";

/// A workspace window, as the stored list names it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum WorkspaceWindow {
    /// `main`.
    Local,
    /// The window of one saved remote connection.
    Remote { connection_id: i32 },
}

impl WorkspaceWindow {
    /// The workspace window `label` names, if it names one.
    pub fn from_label(label: &str) -> Option<Self> {
        if label == LOCAL_WORKSPACE_LABEL {
            return Some(Self::Local);
        }
        let id = label.strip_prefix(REMOTE_WORKSPACE_LABEL_PREFIX)?;
        let connection_id: i32 = id.parse().ok()?;
        // Only the spelling `label()` produces: `+3` and `03` parse, but no
        // window of this app is called that.
        (connection_id.to_string() == id).then_some(Self::Remote { connection_id })
    }

    pub fn label(self) -> String {
        match self {
            Self::Local => LOCAL_WORKSPACE_LABEL.to_string(),
            Self::Remote { connection_id } => {
                format!("{REMOTE_WORKSPACE_LABEL_PREFIX}{connection_id}")
            }
        }
    }
}

/// A remote workspace that was open at the last quit and did not come back.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceRestoreFailure {
    pub connection_id: i32,
    pub name: String,
    pub error: AppCommandError,
}

#[derive(Serialize)]
struct StoredSession<'a> {
    version: u32,
    windows: &'a [WorkspaceWindow],
}

fn encode_session(windows: &[WorkspaceWindow]) -> Option<String> {
    serde_json::to_string(&StoredSession {
        version: SESSION_VERSION,
        windows,
    })
    .ok()
}

/// The stored list, least recently focused first. Entries this build does not
/// recognise are skipped one by one rather than costing the whole list, and a
/// window listed twice keeps its later place.
fn decode_session(raw: &str) -> Vec<WorkspaceWindow> {
    #[derive(Deserialize)]
    struct Stored {
        #[serde(default)]
        windows: Vec<serde_json::Value>,
    }

    let stored: Stored = match serde_json::from_str(raw) {
        Ok(stored) => stored,
        Err(err) => {
            tracing::warn!("[workspace-windows] ignoring unreadable window list: {err}");
            return Vec::new();
        }
    };
    let mut windows: Vec<WorkspaceWindow> = Vec::new();
    for value in stored.windows {
        if let Ok(window) = serde_json::from_value::<WorkspaceWindow>(value) {
            windows.retain(|w| *w != window);
            windows.push(window);
        }
    }
    windows
}

/// What a launch reopens.
#[derive(Debug, Clone, PartialEq, Eq)]
struct RestorePlan {
    /// Whether `main` is shown. It is built either way.
    show_local: bool,
    /// Remote connections to reopen, least recently focused first.
    remotes: Vec<i32>,
    /// The window to leave in front once everything is back.
    front: WorkspaceWindow,
}

/// `remembered` is the stored list; `connection_exists` weeds out the remote
/// connections deleted since. `local_requested` is a launch that asked for the
/// local workspace itself (a `codeg://` link on the command line), and
/// `local_can_hide` whether `main` can be hidden at all this launch — where it
/// cannot, a hidden `main` would have nothing to bring it back.
fn plan_restore(
    remembered: &[WorkspaceWindow],
    connection_exists: impl Fn(i32) -> bool,
    local_requested: bool,
    local_can_hide: bool,
) -> RestorePlan {
    let restorable: Vec<WorkspaceWindow> = remembered
        .iter()
        .copied()
        .filter(|window| match window {
            WorkspaceWindow::Local => true,
            WorkspaceWindow::Remote { connection_id } => connection_exists(*connection_id),
        })
        .collect();
    let remotes: Vec<i32> = restorable
        .iter()
        .filter_map(|window| match window {
            WorkspaceWindow::Remote { connection_id } => Some(*connection_id),
            WorkspaceWindow::Local => None,
        })
        .collect();
    let show_local = local_requested
        || !local_can_hide
        || remotes.is_empty()
        || restorable.contains(&WorkspaceWindow::Local);
    let front = if local_requested {
        WorkspaceWindow::Local
    } else {
        restorable.last().copied().unwrap_or(WorkspaceWindow::Local)
    };
    RestorePlan {
        show_local,
        remotes,
        front,
    }
}

/// How a recorded event changed the list.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Change {
    None,
    /// Same windows, another one in front. Kept in memory until the next
    /// write: focus moves far more often than windows open and close.
    Order,
    /// A window joined or left the list, which is written right away.
    Membership,
}

#[derive(Debug, Default)]
struct SessionState {
    /// Open workspace windows, least recently focused first.
    open: Vec<WorkspaceWindow>,
    /// Remembered windows this launch is still reopening. Listed ahead of the
    /// open ones, so a quit that lands before they settle keeps them.
    pending: Vec<WorkspaceWindow>,
    /// The launch is still reopening windows. The list is only kept in memory
    /// meanwhile, so a crash halfway through cannot replace the remembered
    /// list with the part of it that had come back.
    restoring: bool,
    /// Quitting has begun: the windows going away now are not being closed by
    /// the user, and the list written at quit is final.
    frozen: bool,
    /// What the stored list holds, as far as this process knows.
    last_written: Option<String>,
    /// Reopening failures waiting for `main` to take them.
    failures: Vec<WorkspaceRestoreFailure>,
}

impl SessionState {
    /// `window` is open and the most recently focused.
    fn mark_open(&mut self, window: WorkspaceWindow) -> Change {
        self.pending.retain(|w| *w != window);
        match self.open.iter().position(|w| *w == window) {
            Some(index) if index + 1 == self.open.len() => Change::None,
            Some(index) => {
                self.open.remove(index);
                self.open.push(window);
                Change::Order
            }
            None => {
                self.open.push(window);
                Change::Membership
            }
        }
    }

    fn mark_closed(&mut self, window: WorkspaceWindow) -> Change {
        let before = self.open.len() + self.pending.len();
        self.open.retain(|w| *w != window);
        self.pending.retain(|w| *w != window);
        if self.open.len() + self.pending.len() == before {
            Change::None
        } else {
            Change::Membership
        }
    }

    /// A remembered window this launch could not reopen. Only its pending
    /// entry goes: if the user opened it by hand meanwhile, that window is open
    /// and stays in the list.
    fn forget_pending(&mut self, window: WorkspaceWindow) -> Change {
        let before = self.pending.len();
        self.pending.retain(|w| *w != window);
        if self.pending.len() == before {
            Change::None
        } else {
            Change::Membership
        }
    }

    /// The list to store, least recently focused first.
    fn snapshot(&self) -> Vec<WorkspaceWindow> {
        self.pending.iter().chain(&self.open).copied().collect()
    }
}

/// The open workspace windows of this run. Managed state of the desktop app.
pub struct WorkspaceWindowSession {
    state: Mutex<SessionState>,
    /// Held across a whole write, so that an older list can never land after
    /// a newer one.
    write: tokio::sync::Mutex<()>,
}

impl Default for WorkspaceWindowSession {
    fn default() -> Self {
        Self::new()
    }
}

impl WorkspaceWindowSession {
    pub fn new() -> Self {
        Self {
            state: Mutex::new(SessionState::default()),
            write: tokio::sync::Mutex::new(()),
        }
    }

    fn lock(&self) -> MutexGuard<'_, SessionState> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Apply one event. `true` when the stored list should be rewritten.
    fn apply(&self, event: impl FnOnce(&mut SessionState) -> Change) -> bool {
        let mut state = self.lock();
        if state.frozen {
            return false;
        }
        event(&mut state) == Change::Membership && !state.restoring
    }

    /// Stop recording, for the quit. `false` if a quit already did.
    fn freeze(&self) -> bool {
        let mut state = self.lock();
        !std::mem::replace(&mut state.frozen, true)
    }

    fn is_frozen(&self) -> bool {
        self.lock().frozen
    }

    /// Store the list as it is now, unless that is what is stored already.
    async fn write_latest(&self, conn: &DatabaseConnection) {
        let _serial = self.write.lock().await;
        let value = {
            let state = self.lock();
            match encode_session(&state.snapshot()) {
                Some(value) if state.last_written.as_deref() != Some(value.as_str()) => value,
                _ => return,
            }
        };
        match app_metadata_service::upsert_value(conn, SESSION_KEY, &value).await {
            Ok(()) => self.lock().last_written = Some(value),
            Err(err) => {
                tracing::warn!("[workspace-windows] failed to remember the open windows: {err}")
            }
        }
    }
}

fn record(app: &AppHandle, event: impl FnOnce(&mut SessionState) -> Change) {
    let Some(session) = app.try_state::<WorkspaceWindowSession>() else {
        return;
    };
    if session.apply(event) {
        schedule_write(app);
    }
}

fn schedule_write(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let (Some(session), Some(db)) = (
            app.try_state::<WorkspaceWindowSession>(),
            app.try_state::<AppDatabase>(),
        ) else {
            return;
        };
        session.write_latest(&db.conn).await;
    });
}

/// A workspace window was opened, or brought forward: it is open, and the
/// most recently focused.
pub fn note_opened(app: &AppHandle, window: WorkspaceWindow) {
    record(app, |state| state.mark_open(window));
}

/// `label` was shown (and focused). No-op unless it is a workspace window.
pub fn note_shown(app: &AppHandle, label: &str) {
    if let Some(window) = WorkspaceWindow::from_label(label) {
        note_opened(app, window);
    }
}

/// `label` was hidden — the close button sending `main` to the tray — which
/// closes it as far as the next launch is concerned.
pub fn note_hidden(app: &AppHandle, label: &str) {
    if let Some(window) = WorkspaceWindow::from_label(label) {
        record(app, |state| state.mark_closed(window));
    }
}

/// Keep the list in step with the window events: focus orders it, and a
/// destroyed window leaves it.
pub fn on_window_event(window: &tauri::Window, event: &tauri::WindowEvent) {
    let Some(workspace) = WorkspaceWindow::from_label(window.label()) else {
        return;
    };
    match event {
        tauri::WindowEvent::Focused(true) => {
            // Focus means the window is open — unless it was hidden again
            // before the event got here, which is how a `main` that the
            // window-state plugin showed while it was built, and the launch
            // then hid, reports in.
            if window.is_visible().unwrap_or(false) {
                note_opened(window.app_handle(), workspace);
            }
        }
        tauri::WindowEvent::Destroyed => {
            record(window.app_handle(), |state| state.mark_closed(workspace));
        }
        _ => {}
    }
}

/// Write the final list, and stop recording: the windows about to go away are
/// torn down by the quit, not closed by the user.
///
/// The first thing a quit does (`shut_down` in `lib.rs`), whichever way it
/// arrives, while every window is still standing. Calling it again does
/// nothing.
pub fn remember_on_quit(app: &AppHandle) {
    let Some(session) = app.try_state::<WorkspaceWindowSession>() else {
        return;
    };
    if !session.freeze() {
        return;
    }
    let Some(db) = app.try_state::<AppDatabase>() else {
        return;
    };
    tauri::async_runtime::block_on(session.write_latest(&db.conn));
}

/// What this launch reopens, as read from the database.
pub struct Restore {
    plan: RestorePlan,
    /// The remote connections to reopen, in `plan.remotes` order.
    connections: Vec<RemoteWorkspaceConnectionInfo>,
}

impl Restore {
    /// Whether `main` is shown at launch.
    pub fn show_local(&self) -> bool {
        self.plan.show_local
    }
}

/// Read the remembered list and work out what this launch reopens. See
/// [`plan_restore`] for `local_requested` and `local_can_hide`.
pub async fn load_restore(
    conn: &DatabaseConnection,
    local_requested: bool,
    local_can_hide: bool,
) -> Restore {
    let remembered = match app_metadata_service::get_value(conn, SESSION_KEY).await {
        Ok(Some(raw)) => decode_session(&raw),
        Ok(None) => Vec::new(),
        Err(err) => {
            tracing::warn!("[workspace-windows] failed to read the remembered windows: {err}");
            Vec::new()
        }
    };
    let mut connections: HashMap<i32, RemoteWorkspaceConnectionInfo> = HashMap::new();
    if remembered
        .iter()
        .any(|window| matches!(window, WorkspaceWindow::Remote { .. }))
    {
        match remote_workspace_connection_service::list(conn).await {
            Ok(list) => {
                connections = list.into_iter().map(|c| (c.id, c)).collect();
            }
            Err(err) => {
                tracing::warn!("[workspace-windows] failed to load remote connections: {err}")
            }
        }
    }
    let plan = plan_restore(
        &remembered,
        |id| connections.contains_key(&id),
        local_requested,
        local_can_hide,
    );
    let connections = plan
        .remotes
        .iter()
        .filter_map(|id| connections.remove(id))
        .collect();
    Restore { plan, connections }
}

/// Start reopening what `restore` lists. Called by the setup hook once `main`
/// is built — shown or not, as [`Restore::show_local`] said.
pub fn begin_restore(app: &AppHandle, restore: Restore) {
    let Some(session) = app.try_state::<WorkspaceWindowSession>() else {
        return;
    };
    let Restore { plan, connections } = restore;
    {
        let mut state = session.lock();
        if plan.show_local {
            state.mark_open(WorkspaceWindow::Local);
        }
        state.pending = connections
            .iter()
            .map(|connection| WorkspaceWindow::Remote {
                connection_id: connection.id,
            })
            .collect();
        state.restoring = !connections.is_empty();
    }
    if connections.is_empty() {
        schedule_write(app);
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        reopen_remote_windows(&app, connections, plan.front).await;
    });
}

async fn reopen_remote_windows(
    app: &AppHandle,
    connections: Vec<RemoteWorkspaceConnectionInfo>,
    front: WorkspaceWindow,
) {
    // Every health check starts now, but the windows open in the remembered
    // order, so the one that was in front at quit is also the last to open. A
    // slow host holds back the windows after it, and nothing else.
    let checks: Vec<_> = connections
        .into_iter()
        .map(|connection| {
            let base_url = connection.base_url.clone();
            let token = connection.token.clone();
            let headers = connection.headers.clone();
            let check = tauri::async_runtime::spawn(async move {
                crate::commands::remote_workspace::validate_remote_health(
                    &base_url, &token, &headers,
                )
                .await
            });
            (connection, check)
        })
        .collect();

    let mut failures = Vec::new();
    for (connection, check) in checks {
        let checked = match check.await {
            Ok(result) => result,
            Err(err) => Err(
                AppCommandError::network("Remote Workspace health check failed")
                    .with_detail(err.to_string()),
            ),
        };
        let opened = checked.and_then(|()| reopen_remote_window(app, &connection));
        if let Err(error) = opened {
            let window = WorkspaceWindow::Remote {
                connection_id: connection.id,
            };
            // The checks all started together, so this result can be older than
            // a manual open that has since succeeded. That window stands, and
            // there is nothing to report.
            if app.get_webview_window(&window.label()).is_some() {
                continue;
            }
            tracing::warn!(
                "[workspace-windows] could not reopen remote workspace {}: {} {}",
                connection.id,
                error.message,
                error.detail.as_deref().unwrap_or_default()
            );
            record(app, |state| state.forget_pending(window));
            failures.push(WorkspaceRestoreFailure {
                connection_id: connection.id,
                name: connection.name,
                error,
            });
        }
    }
    finish_restore(app, front, failures);
}

fn reopen_remote_window(
    app: &AppHandle,
    connection: &RemoteWorkspaceConnectionInfo,
) -> Result<(), AppCommandError> {
    let window = WorkspaceWindow::Remote {
        connection_id: connection.id,
    };
    if let Some(session) = app.try_state::<WorkspaceWindowSession>() {
        // Quitting: a window built now would only be torn down again.
        if session.is_frozen() {
            return Ok(());
        }
    }
    // Opened by hand while its health check was still running. Building it
    // recorded it, and the user may have moved on to another window since, so
    // it is not brought forward in the list again here.
    if app.get_webview_window(&window.label()).is_some() {
        return Ok(());
    }
    crate::commands::remote_workspace::build_remote_workspace_window(app, connection)
}

fn finish_restore(app: &AppHandle, front: WorkspaceWindow, failures: Vec<WorkspaceRestoreFailure>) {
    let Some(session) = app.try_state::<WorkspaceWindowSession>() else {
        return;
    };
    let nothing_open = {
        let state = session.lock();
        if state.frozen {
            return;
        }
        state.open.is_empty()
    };
    if !failures.is_empty() || nothing_open {
        // The toast saying why a window did not come back is shown in `main`;
        // and with nothing reopened, `main` is all there is.
        crate::commands::windows::show_main_window(app);
    } else if let Some(window) = app.get_webview_window(&front.label()) {
        let _ = window.set_focus();
        note_opened(app, front);
    }
    if !failures.is_empty() {
        session.lock().failures.extend(failures);
        if let Err(err) = app.emit_to(LOCAL_WORKSPACE_LABEL, RESTORE_FAILED_EVENT, ()) {
            tracing::warn!("[workspace-windows] failed to signal the local workspace: {err}");
        }
    }
    session.lock().restoring = false;
    schedule_write(app);
}

/// Take the remote workspaces this launch could not reopen, for the local
/// workspace to report. Each is handed out once.
#[tauri::command]
pub fn take_workspace_restore_failures(
    session: tauri::State<'_, WorkspaceWindowSession>,
) -> Vec<WorkspaceRestoreFailure> {
    std::mem::take(&mut session.lock().failures)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::test_helpers::fresh_in_memory_db;

    const LOCAL: WorkspaceWindow = WorkspaceWindow::Local;

    fn remote(connection_id: i32) -> WorkspaceWindow {
        WorkspaceWindow::Remote { connection_id }
    }

    #[test]
    fn labels_name_the_workspace_windows() {
        assert_eq!(WorkspaceWindow::from_label("main"), Some(LOCAL));
        assert_eq!(
            WorkspaceWindow::from_label("remote-workspace-3"),
            Some(remote(3))
        );
        assert_eq!(LOCAL.label(), "main");
        assert_eq!(remote(12).label(), "remote-workspace-12");
        assert_eq!(
            WorkspaceWindow::from_label(&remote(12).label()),
            Some(remote(12))
        );

        for other in [
            "settings",
            "remote-settings-3",
            "remote-workspace-",
            "remote-workspace-x",
            "remote-workspace-+3",
            "remote-workspace-03",
            "commit-1",
            "pet",
        ] {
            assert_eq!(WorkspaceWindow::from_label(other), None, "{other}");
        }
    }

    #[test]
    fn stored_list_round_trips() {
        let windows = [remote(4), LOCAL, remote(2)];
        let raw = encode_session(&windows).unwrap();
        assert_eq!(
            raw,
            r#"{"version":1,"windows":[{"kind":"remote","connection_id":4},{"kind":"local"},{"kind":"remote","connection_id":2}]}"#
        );
        assert_eq!(decode_session(&raw), windows);
    }

    #[test]
    fn stored_list_skips_what_it_cannot_read() {
        assert!(decode_session("not json").is_empty());
        assert!(decode_session("{}").is_empty());
        let raw = r#"{"version":7,"windows":[
            {"kind":"remote","connection_id":1},
            {"kind":"hologram","id":9},
            {"kind":"remote"},
            "main",
            {"kind":"local"},
            {"kind":"remote","connection_id":1}
        ]}"#;
        // A window listed twice keeps its later place.
        assert_eq!(decode_session(raw), vec![LOCAL, remote(1)]);
    }

    #[test]
    fn nothing_remembered_opens_the_local_workspace() {
        let plan = plan_restore(&[], |_| true, false, true);
        assert_eq!(
            plan,
            RestorePlan {
                show_local: true,
                remotes: vec![],
                front: LOCAL,
            }
        );
    }

    #[test]
    fn remote_windows_come_back_with_the_local_one() {
        let plan = plan_restore(&[LOCAL, remote(1), remote(2)], |_| true, false, true);
        assert_eq!(
            plan,
            RestorePlan {
                show_local: true,
                remotes: vec![1, 2],
                front: remote(2),
            }
        );

        let plan = plan_restore(&[remote(1), remote(2), LOCAL], |_| true, false, true);
        assert_eq!(plan.remotes, vec![1, 2]);
        assert_eq!(plan.front, LOCAL);
    }

    #[test]
    fn a_local_workspace_closed_at_quit_stays_closed() {
        let plan = plan_restore(&[remote(1), remote(2)], |_| true, false, true);
        assert_eq!(
            plan,
            RestorePlan {
                show_local: false,
                remotes: vec![1, 2],
                front: remote(2),
            }
        );
    }

    #[test]
    fn deleted_connections_are_not_reopened() {
        let plan = plan_restore(&[remote(1), remote(2)], |id| id == 1, false, true);
        assert_eq!(plan.remotes, vec![1]);
        assert_eq!(plan.front, remote(1));

        // With nothing left to reopen, the local workspace opens after all.
        let plan = plan_restore(&[remote(1)], |_| false, false, true);
        assert_eq!(
            plan,
            RestorePlan {
                show_local: true,
                remotes: vec![],
                front: LOCAL,
            }
        );
    }

    #[test]
    fn a_link_on_the_command_line_opens_the_local_workspace_in_front() {
        let plan = plan_restore(&[remote(1)], |_| true, true, true);
        assert_eq!(
            plan,
            RestorePlan {
                show_local: true,
                remotes: vec![1],
                front: LOCAL,
            }
        );
    }

    #[test]
    fn the_local_workspace_opens_where_it_could_not_be_brought_back() {
        let plan = plan_restore(&[remote(1)], |_| true, false, false);
        assert_eq!(
            plan,
            RestorePlan {
                show_local: true,
                remotes: vec![1],
                front: remote(1),
            }
        );
    }

    #[test]
    fn the_list_follows_focus_and_membership() {
        let mut state = SessionState::default();
        assert_eq!(state.mark_open(LOCAL), Change::Membership);
        assert_eq!(state.mark_open(remote(1)), Change::Membership);
        assert_eq!(state.mark_open(remote(1)), Change::None);
        assert_eq!(state.mark_open(LOCAL), Change::Order);
        assert_eq!(state.snapshot(), vec![remote(1), LOCAL]);
        assert_eq!(state.mark_closed(remote(1)), Change::Membership);
        assert_eq!(state.mark_closed(remote(1)), Change::None);
        assert_eq!(state.snapshot(), vec![LOCAL]);
    }

    #[test]
    fn windows_still_being_reopened_are_kept() {
        let mut state = SessionState {
            pending: vec![remote(1), remote(2)],
            ..SessionState::default()
        };
        state.mark_open(LOCAL);
        assert_eq!(state.snapshot(), vec![remote(1), remote(2), LOCAL]);

        state.mark_open(remote(1));
        assert_eq!(state.snapshot(), vec![remote(2), LOCAL, remote(1)]);

        // A reopen that failed leaves the list.
        assert_eq!(state.mark_closed(remote(2)), Change::Membership);
        assert_eq!(state.snapshot(), vec![LOCAL, remote(1)]);
    }

    #[test]
    fn a_failed_reopen_leaves_a_window_opened_by_hand() {
        let mut state = SessionState {
            pending: vec![remote(1), remote(2)],
            ..SessionState::default()
        };
        // Remote 2 is opened by hand before its (failed) check is processed.
        state.mark_open(remote(2));
        assert_eq!(state.forget_pending(remote(2)), Change::None);
        assert_eq!(state.snapshot(), vec![remote(1), remote(2)]);

        // A failure with no window behind it does leave the list.
        assert_eq!(state.forget_pending(remote(1)), Change::Membership);
        assert_eq!(state.snapshot(), vec![remote(2)]);
    }

    #[test]
    fn only_membership_changes_outside_a_restore_are_written() {
        let session = WorkspaceWindowSession::new();
        assert!(session.apply(|state| state.mark_open(LOCAL)));
        assert!(!session.apply(|state| state.mark_open(LOCAL)));
        assert!(session.apply(|state| state.mark_open(remote(1))));
        // Focus alone waits for the next write.
        assert!(!session.apply(|state| state.mark_open(LOCAL)));

        session.lock().restoring = true;
        assert!(!session.apply(|state| state.mark_open(remote(2))));
        assert_eq!(session.lock().snapshot(), vec![remote(1), LOCAL, remote(2)]);
    }

    #[test]
    fn nothing_is_recorded_once_quitting() {
        let session = WorkspaceWindowSession::new();
        session.apply(|state| state.mark_open(LOCAL));
        session.apply(|state| state.mark_open(remote(1)));

        assert!(session.freeze());
        assert!(!session.freeze(), "the first quit event writes, not both");
        assert!(!session.apply(|state| state.mark_closed(remote(1))));
        assert!(!session.apply(|state| state.mark_closed(LOCAL)));
        assert_eq!(session.lock().snapshot(), vec![LOCAL, remote(1)]);
    }

    #[tokio::test]
    async fn the_list_written_is_the_list_read_back() {
        let db = fresh_in_memory_db().await;
        let one = remote_workspace_connection_service::create(
            &db.conn,
            "one",
            "http://one.example:3080",
            "t1",
            &[],
        )
        .await
        .unwrap();
        let two = remote_workspace_connection_service::create(
            &db.conn,
            "two",
            "http://two.example:3080",
            "t2",
            &[],
        )
        .await
        .unwrap();

        let session = WorkspaceWindowSession::new();
        session.apply(|state| state.mark_open(remote(two.id)));
        session.apply(|state| state.mark_open(remote(one.id)));
        session.write_latest(&db.conn).await;

        let restore = load_restore(&db.conn, false, true).await;
        assert!(!restore.show_local());
        assert_eq!(restore.plan.remotes, vec![two.id, one.id]);
        assert_eq!(restore.plan.front, remote(one.id));
        let names: Vec<&str> = restore
            .connections
            .iter()
            .map(|c| c.name.as_str())
            .collect();
        assert_eq!(names, vec!["two", "one"]);

        // A connection deleted before the next launch is not reopened.
        remote_workspace_connection_service::delete(&db.conn, one.id)
            .await
            .unwrap();
        let restore = load_restore(&db.conn, false, true).await;
        assert_eq!(restore.plan.remotes, vec![two.id]);
        assert_eq!(restore.plan.front, remote(two.id));
    }

    /// Remote A's check is slow and remote B's fails at once; B's host then
    /// recovers and the user opens B by hand before the restore gets to B's
    /// failure. B is open, so the quit keeps it and the next launch reopens it.
    #[tokio::test]
    async fn a_window_opened_by_hand_during_the_restore_is_remembered() {
        let db = fresh_in_memory_db().await;
        let a = remote_workspace_connection_service::create(
            &db.conn,
            "a",
            "http://a.example:3080",
            "ta",
            &[],
        )
        .await
        .unwrap();
        let b = remote_workspace_connection_service::create(
            &db.conn,
            "b",
            "http://b.example:3080",
            "tb",
            &[],
        )
        .await
        .unwrap();

        let session = WorkspaceWindowSession::new();
        {
            let mut state = session.lock();
            state.pending = vec![remote(a.id), remote(b.id)];
            state.restoring = true;
        }
        // B, opened by hand; then A, reopened; then B's stale failure.
        session.apply(|state| state.mark_open(remote(b.id)));
        session.apply(|state| state.mark_open(remote(a.id)));
        session.apply(|state| state.forget_pending(remote(b.id)));

        assert!(session.freeze());
        session.write_latest(&db.conn).await;

        let restore = load_restore(&db.conn, false, true).await;
        assert_eq!(restore.plan.remotes, vec![b.id, a.id]);
        assert_eq!(restore.plan.front, remote(a.id));
    }

    #[tokio::test]
    async fn an_unchanged_list_is_not_written_again() {
        let db = fresh_in_memory_db().await;
        let session = WorkspaceWindowSession::new();
        session.apply(|state| state.mark_open(LOCAL));
        session.write_latest(&db.conn).await;
        let written = session.lock().last_written.clone();
        assert!(written.is_some());

        // Overwrite behind the session's back: a write of the same list
        // would put it back, so finding it untouched proves none happened.
        app_metadata_service::upsert_value(&db.conn, SESSION_KEY, "sentinel")
            .await
            .unwrap();
        session.write_latest(&db.conn).await;
        assert_eq!(
            app_metadata_service::get_value(&db.conn, SESSION_KEY)
                .await
                .unwrap()
                .as_deref(),
            Some("sentinel")
        );

        session.apply(|state| state.mark_open(remote(5)));
        session.write_latest(&db.conn).await;
        let stored = app_metadata_service::get_value(&db.conn, SESSION_KEY)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(decode_session(&stored), vec![LOCAL, remote(5)]);
    }

    #[tokio::test]
    async fn a_first_launch_opens_the_local_workspace() {
        let db = fresh_in_memory_db().await;
        let restore = load_restore(&db.conn, false, true).await;
        assert!(restore.show_local());
        assert!(restore.connections.is_empty());
    }
}
