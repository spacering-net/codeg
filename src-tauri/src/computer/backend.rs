//! What the tool surface calls to reach a desktop.
//!
//! One implementation today, [`super::local`]: the helper on this machine. The
//! trait is the seam for the others the design leaves room for — a desktop in
//! a container, a remote one — which would answer the same questions about a
//! desktop that is not this one. Nothing above this trait decides anything
//! about *which* desktop; nothing below it decides anything about *who may*.

use async_trait::async_trait;
use serde::{Deserialize, Serialize};

use super::protocol::{
    ClipboardUse, HelperError, HelperErrorCode, InstalledApp, OsPermission, PeerCheck,
    PermissionAsked, PermissionReport, ProcessRun, RawAct, RawApp, RawCapture, RawClipboard,
    RawLaunch, RawSnapshot, RawVerify, RawWindow, ScreenGeometry, ScreenRules, WindowAction,
};
use super::types::{ActDelivery, VerifyRequest};

/// Why an action was refused, or did not happen, at the helper or the driver.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ActRefusal {
    /// The session is locked, or another user's is active.
    Paused,
    /// The person pressed Stop before this went out, or while it did.
    Stopped,
    /// The element or point is from a snapshot or capture the window has
    /// moved past.
    StaleRef,
    /// The element or point is not in the window.
    OutOfTarget,
    /// The window cannot take input in the background right now.
    Occluded,
    /// The application offers no background route for this action.
    BackgroundUnavailable,
    /// A password or other secret field.
    SecretField,
    /// Allowed, and it did not happen.
    Failed,
    /// A paste by another route than a key (`HelperErrorCode::PasteRefused`).
    Paste,
    /// Past the application shared (`HelperErrorCode::BeyondApp`).
    Beyond,
    /// What it was let through under ended before it went out: the sharing
    /// was taken back or lowered, or the rules it was judged by changed.
    Revoked,
}

/// Why a backend call did not produce an answer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BackendError {
    /// There is no working backend right now: the helper is not installed,
    /// would not start, or the driver could not be fetched. The words say
    /// which.
    Unavailable(String),
    /// The helper lacks an OS permission the call needs.
    PermissionMissing(OsPermission),
    /// No such window, or it has changed hands.
    NoSuchWindow,
    /// The driver file is not the pinned release.
    Rejected(String),
    Failed(String),
    /// An action did not go out, or did not happen; the words are the
    /// helper's, written for the agent.
    Refused(ActRefusal, String),
}

impl std::fmt::Display for BackendError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            BackendError::Unavailable(why) => write!(f, "computer use is unavailable: {why}"),
            BackendError::PermissionMissing(OsPermission::Accessibility) => {
                f.write_str("codeg-computer-helper has not been granted Accessibility")
            }
            BackendError::PermissionMissing(OsPermission::ScreenRecording) => {
                f.write_str("codeg-computer-helper has not been granted Screen Recording")
            }
            BackendError::NoSuchWindow => f.write_str("the window is gone"),
            BackendError::Rejected(why) => write!(f, "the driver was rejected: {why}"),
            BackendError::Failed(why) | BackendError::Refused(_, why) => f.write_str(why),
        }
    }
}

impl std::error::Error for BackendError {}

impl From<HelperError> for BackendError {
    fn from(e: HelperError) -> Self {
        match e.code {
            HelperErrorCode::PermissionMissing => match e.permission {
                Some(p) => BackendError::PermissionMissing(p),
                None => BackendError::Failed(e.message),
            },
            HelperErrorCode::NoSuchWindow => BackendError::NoSuchWindow,
            HelperErrorCode::DriverRejected => BackendError::Rejected(e.message),
            HelperErrorCode::DriverUnavailable | HelperErrorCode::NotConfigured => {
                BackendError::Unavailable(e.message)
            }
            HelperErrorCode::BadRequest | HelperErrorCode::Failed => {
                BackendError::Failed(e.message)
            }
            HelperErrorCode::Paused => BackendError::Refused(ActRefusal::Paused, e.message),
            HelperErrorCode::Stopped => BackendError::Refused(ActRefusal::Stopped, e.message),
            HelperErrorCode::StaleRef => BackendError::Refused(ActRefusal::StaleRef, e.message),
            HelperErrorCode::OutOfTarget => {
                BackendError::Refused(ActRefusal::OutOfTarget, e.message)
            }
            HelperErrorCode::Occluded => BackendError::Refused(ActRefusal::Occluded, e.message),
            HelperErrorCode::BackgroundUnavailable => {
                BackendError::Refused(ActRefusal::BackgroundUnavailable, e.message)
            }
            HelperErrorCode::SecretField => {
                BackendError::Refused(ActRefusal::SecretField, e.message)
            }
            HelperErrorCode::ActionFailed => BackendError::Refused(ActRefusal::Failed, e.message),
            HelperErrorCode::PasteRefused => BackendError::Refused(ActRefusal::Paste, e.message),
            HelperErrorCode::BeyondApp => BackendError::Refused(ActRefusal::Beyond, e.message),
        }
    }
}

/// Where the backend is in its life, for the person looking at codeg's panel.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum BackendState {
    /// Nothing has asked for it yet.
    Idle,
    /// Fetching the driver.
    Downloading,
    /// Launching and verifying the helper.
    Starting,
    Ready,
    /// The last attempt failed; the next call tries again.
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackendStatus {
    pub state: BackendState,
    /// What went wrong, or what is in progress, in words.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    /// The pinned driver release.
    pub driver_version: String,
    /// Whether the running helper checked codeg's signature; `None` while no
    /// helper is running.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub peer: Option<PeerCheck>,
}

/// Bounds on an accessibility snapshot. Passed through to the driver, which
/// bounds its own walk with them.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SnapshotOptions {
    pub max_depth: Option<u32>,
    pub max_elements: Option<u32>,
    pub query: Option<String>,
    /// Read the application's menu bars too (macOS): for a window shared
    /// with its whole application.
    pub app_menus: bool,
}

#[async_trait]
pub trait ComputerBackend: Send + Sync {
    async fn status(&self) -> BackendStatus;

    /// The executor's own OS permissions — never codeg's.
    async fn permissions(&self) -> Result<PermissionReport, BackendError>;

    /// Raise the system's request for one permission — that one alone —
    /// charged to the executor, and say whether the system put up its own
    /// dialog for it. A person pressed a button for this; nothing else calls
    /// it.
    async fn request_permission(
        &self,
        permission: OsPermission,
    ) -> Result<PermissionAsked, BackendError>;

    async fn list_apps(&self) -> Result<Vec<RawApp>, BackendError>;

    /// The installed application listed under `key`, or else `name`.
    async fn find_app(
        &self,
        name: Option<String>,
        key: Option<String>,
    ) -> Result<InstalledApp, BackendError>;

    /// Start `app`, as [`find_app`](Self::find_app) found it, in the
    /// background — sent once, as an action is, and held to the Stop count
    /// `stop`: a start cannot be recalled, and is never sent twice.
    async fn launch_app(&self, app: InstalledApp, stop: u64) -> Result<RawLaunch, BackendError>;

    async fn list_windows(&self, pid: Option<u32>) -> Result<Vec<RawWindow>, BackendError>;

    /// When `pid` started, or `None` if it is not running.
    async fn process_start(&self, pid: u32) -> Result<Option<u64>, BackendError>;

    async fn capture(
        &self,
        pid: u32,
        window_id: u64,
        max_dimension: Option<u32>,
    ) -> Result<RawCapture, BackendError>;

    async fn snapshot(
        &self,
        pid: u32,
        window_id: u64,
        options: SnapshotOptions,
    ) -> Result<RawSnapshot, BackendError>;

    async fn verify(
        &self,
        pid: u32,
        window_id: u64,
        request: VerifyRequest,
    ) -> Result<RawVerify, BackendError>;

    /// Act on one window, delivered as `delivery` says: in the background,
    /// or with the window brought to the front for it. The caller has
    /// checked the grant — and that the person allows the front, if that is
    /// the delivery — having counted `stop` Stops before it did; the backend
    /// checks, at the moment of delivery, what it can see — that `pid` is
    /// still the process that started at `started_at` and, where another
    /// process draws inside the window, that `content` is still its run;
    /// that the session is not locked; that no later Stop has been
    /// [`halt`](Self::halt)ed.
    #[allow(clippy::too_many_arguments)]
    async fn act(
        &self,
        pid: u32,
        window_id: u64,
        started_at: u64,
        content: Option<ProcessRun>,
        app_key: Option<String>,
        action: WindowAction,
        delivery: ActDelivery,
        clipboard: ClipboardUse,
        stop: u64,
    ) -> Result<RawAct, BackendError>;

    /// The entire screen, every window `rules` do not allow painted over.
    async fn capture_screen(
        &self,
        rules: ScreenRules,
        max_dimension: Option<u32>,
    ) -> Result<RawCapture, BackendError>;

    /// A pointer action on the entire screen, at points in the pixels of
    /// the picture `geometry` describes — sent once, as an action, held to
    /// the Stop count `stop`, and only while `still` says what it was let
    /// through under still holds, asked once the helper is in hand.
    async fn act_screen(
        &self,
        rules: ScreenRules,
        action: WindowAction,
        geometry: ScreenGeometry,
        stop: u64,
        still: &(dyn Fn() -> bool + Send + Sync),
    ) -> Result<RawAct, BackendError>;

    /// The clipboard's text, while it is still as `expect` names it.
    async fn clipboard_read(&self, expect: u64) -> Result<RawClipboard, BackendError>;

    /// Put `text` on the clipboard — sent once, as an action, held to the
    /// Stop count `stop` — and answer with the clipboard's stamp after.
    async fn clipboard_write(&self, text: String, stop: u64) -> Result<u64, BackendError>;

    /// The person's `stop`-th Stop: whatever the executor is doing is
    /// abandoned, and no action let through before it goes out. What comes
    /// after it runs as usual.
    async fn halt(&self, stop: u64) -> Result<(), BackendError>;
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The helper's error codes map onto the backend's without losing the
    /// permission a refusal was about.
    #[test]
    fn helper_errors_keep_their_meaning() {
        assert_eq!(
            BackendError::from(HelperError::permission_missing(OsPermission::Accessibility)),
            BackendError::PermissionMissing(OsPermission::Accessibility)
        );
        assert_eq!(
            BackendError::from(HelperError::new(HelperErrorCode::NoSuchWindow, "gone")),
            BackendError::NoSuchWindow
        );
        assert!(matches!(
            BackendError::from(HelperError::new(HelperErrorCode::DriverRejected, "cdhash")),
            BackendError::Rejected(_)
        ));
        assert!(matches!(
            BackendError::from(HelperError::new(HelperErrorCode::NotConfigured, "x")),
            BackendError::Unavailable(_)
        ));
        // A Stop and a locked screen are told apart all the way up.
        assert!(matches!(
            BackendError::from(HelperError::new(HelperErrorCode::Stopped, "x")),
            BackendError::Refused(ActRefusal::Stopped, _)
        ));
        assert!(matches!(
            BackendError::from(HelperError::new(HelperErrorCode::Paused, "x")),
            BackendError::Refused(ActRefusal::Paused, _)
        ));
    }
}
