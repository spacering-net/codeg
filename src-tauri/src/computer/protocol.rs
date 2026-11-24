//! Frames between codeg and `codeg-computer-helper`.
//!
//! One private channel per helper: the socketpair codeg created and handed to
//! the helper as its stdin/stdout on macOS, plain pipes elsewhere. Frames are
//! the broker's length-prefixed JSON ([`write_frame`] / [`read_frame`]), with
//! the broker's 16 MiB cap — which is also the most the broker can hand an
//! agent in one answer, so a capture too large for this channel could not
//! have been delivered anyway.
//!
//! **The helper speaks first**, with [`HelperMessage::Ready`]. That ordering is
//! load-bearing on macOS: codeg created both ends of the socketpair, so until
//! the helper has written to its end the kernel still reports codeg itself as
//! the peer, and a signature check of "the peer" would check codeg. codeg
//! verifies the helper only after the first frame arrives.
//!
//! The ops are a closed list. The driver behind the helper advertises dozens
//! of tools — launching and killing applications, rewriting its own
//! configuration, replaying recorded input — and none of them is reachable
//! from here: the helper translates each op below into fixed driver calls,
//! and there is no op that carries a tool name. The one op that changes a
//! window, [`HelperOp::Act`], carries a closed [`WindowAction`] whose every
//! field the helper rebuilds into the driver's arguments itself — save
//! [`WindowAction::Restore`], which on macOS and Windows the helper carries
//! out itself, on that one window, since the driver has no call that leaves
//! it in the background.

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub use crate::acp::delegation::transport::{read_frame, write_frame, MAX_FRAME_BYTES};

fn no_modifiers(modifiers: &Modifiers) -> bool {
    modifiers.is_empty()
}

use super::keys::{Chord, Modifiers};
use super::types::{
    ActDelivery, ActEffect, ActRoute, PointerButton, PredicateResult, Rect, ScrollDirection,
    ScrollUnit, VerifyRequest, VerifyStatus,
};

/// Bumped whenever a frame changes shape. The helper ships in the same bundle
/// as codeg, so a mismatch means a broken install (a helper left behind by a
/// partial update), and codeg refuses to talk to it rather than guess.
pub const PROTOCOL_VERSION: u32 = 14;

/// A fingerprint of the sources the helper is built from, the same in codeg
/// and the helper when both are built from one tree (see `build.rs`). The
/// helper says it in [`HelperReady::source`]; a development codeg checks it.
pub const SOURCE_FINGERPRINT: &str = env!("CODEG_COMPUTER_SOURCE");

/// codeg → helper.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HelperRequest {
    pub id: u64,
    pub op: HelperOp,
    /// How many of the person's Stops codeg had counted when it let this
    /// request through. The helper serves nothing of a request from before
    /// a Stop it has heard of ([`HelperOp::Halt`]) — whichever of the two
    /// frames reached it first — and holds nothing against one from after.
    pub stop: u64,
}

/// The `stop` of a [`HelperOp::Halt`] that ends everything: codeg is closing
/// the helper, and nothing it was asked before is served.
pub const STOP_ALL: u64 = u64::MAX;

/// What codeg may ask the helper for.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum HelperOp {
    /// Where the driver is, and which release it should be. Nothing that
    /// needs the driver is served before this; the helper checks the file
    /// against the pins compiled into it, not against anything said here.
    #[serde(rename_all = "camelCase")]
    Configure {
        driver_path: String,
        driver_version: String,
    },
    /// The helper's own OS permissions. Read-only: never raises a dialog.
    /// (Asking for one is not an op: codeg starts a helper of its own for
    /// that — see [`REQUEST_PERMISSION_ARG`].)
    Permissions,
    ListApps,
    /// The installed application listed under `key` — its bundle identifier
    /// or path, as `list_apps` gives them — or else `name`, any case: the one
    /// application, running or not, that goes by it.
    #[serde(rename_all = "camelCase")]
    FindApp {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        name: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        key: Option<String>,
    },
    /// Start an application [`HelperOp::FindApp`] found, in the background,
    /// by what the driver listed it under — never by anything an agent
    /// wrote.
    #[serde(rename_all = "camelCase")]
    LaunchApp {
        app: InstalledApp,
    },
    /// Every normal window, or only `pid`'s.
    #[serde(rename_all = "camelCase")]
    ListWindows {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pid: Option<u32>,
    },
    /// When `pid` started, if it is running — the other half of a process's
    /// identity, since pids are reused.
    #[serde(rename_all = "camelCase")]
    ProcessStart {
        pid: u32,
    },
    #[serde(rename_all = "camelCase")]
    Capture {
        pid: u32,
        window_id: u64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        max_dimension: Option<u32>,
    },
    #[serde(rename_all = "camelCase")]
    Snapshot {
        pid: u32,
        window_id: u64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        max_depth: Option<u32>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        max_elements: Option<u32>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        query: Option<String>,
        /// macOS: keep the application's menu bars in the tree, and their
        /// elements actionable — for an application shared as a whole. A
        /// window shared on its own is read without them: they act on the
        /// whole application.
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        app_menus: bool,
    },
    #[serde(rename_all = "camelCase")]
    Verify {
        pid: u32,
        window_id: u64,
        request: VerifyRequest,
    },
    /// Act on one window. codeg has checked the grant, the addressing, the
    /// keys and — for the front — that the person allows it; the helper
    /// checks again what only it can see at the moment of delivery — that
    /// the pid is still the process the window was shared from, and the
    /// process drawing inside it still the run it was shared with, that the
    /// session is not locked, that no Stop has come since the action was let
    /// through — and refuses secret fields itself.
    #[serde(rename_all = "camelCase")]
    Act {
        pid: u32,
        window_id: u64,
        /// The process start time the grant is held against.
        started_at: u64,
        /// The run of the process drawing inside the window, where that is
        /// not its owner (`RawWindow::content`): part of what was shared.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        content: Option<ProcessRun>,
        /// The application's key (bundle identifier or path), for the driver
        /// paths that differ by application.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        app_key: Option<String>,
        action: WindowAction,
        /// In the background, or with the window brought to the front for
        /// it.
        #[serde(default)]
        delivery: ActDelivery,
        /// What the action has to do with the clipboard.
        #[serde(default)]
        clipboard: ClipboardUse,
    },
    /// The entire screen, as one picture: every window whose application
    /// may not be shared by `rules` painted over, whatever layer it is on.
    #[serde(rename_all = "camelCase")]
    CaptureScreen {
        rules: ScreenRules,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        max_dimension: Option<u32>,
    },
    /// Have the driver running, starting it if it is not: what an action
    /// on the entire screen waits for before it is asked about a last time
    /// and sent ([`HelperOp::ActScreen`] starts none).
    DriverReady,
    /// A pointer action on the entire screen — a click, a drag, a scroll —
    /// at points in its picture's own pixels, sent as real input at the
    /// front. No point may be on what the picture paints over by `rules`,
    /// and the screen must still be as the picture was taken (`geometry`).
    /// Only on a driver already running ([`HelperOp::DriverReady`]): one
    /// started now would take seconds no one is asked about again.
    #[serde(rename_all = "camelCase")]
    ActScreen {
        rules: ScreenRules,
        action: WindowAction,
        geometry: ScreenGeometry,
    },
    /// Read the clipboard — only while it is still as `expect` names it:
    /// what an agent put there itself. Never a clipboard an application
    /// marked concealed.
    #[serde(rename_all = "camelCase")]
    ClipboardRead {
        expect: u64,
    },
    /// Put text on the clipboard; answers with the clipboard's stamp after.
    #[serde(rename_all = "camelCase")]
    ClipboardWrite {
        text: String,
    },
    /// The person pressed Stop — codeg's `stop`-th — or codeg is closing the
    /// helper ([`STOP_ALL`]): kill the driver started for a request from
    /// before it, now, whatever it is in the middle of, and serve nothing
    /// more of any request from before it. A `Halt` older than one already
    /// heard changes nothing, and what comes after it runs as usual, on a
    /// fresh driver: a Stop ends what is under way, not computer use.
    #[serde(rename_all = "camelCase")]
    Halt {
        stop: u64,
    },
}

/// The argument that starts the helper for one permission request instead
/// of serving codeg: `codeg-computer-helper --request-permission
/// accessibility`. codeg starts it as it starts the helper — its own TCC
/// principal — so the request names the helper; and a fresh process each
/// time, because macOS takes a request from each process once. It asks for
/// that permission alone, then prints a [`PermissionAsked`] line and exits.
pub const REQUEST_PERMISSION_ARG: &str = "--request-permission";

/// What a `--request-permission` helper prints.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionAsked {
    /// The system put up its own request, which has a button to the right
    /// pane of System Settings. It does not once the person has turned the
    /// switch off there — and never for a permission already granted.
    pub prompted: bool,
}

/// An element of a snapshot the helper took, by the driver's snapshot id and
/// the element's index in it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ElementRef {
    pub snapshot_id: String,
    pub index: u32,
}

/// A point in the window, in its own pixels — the space of a full-size
/// capture of it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowPoint {
    pub x: f64,
    pub y: f64,
    /// The window's size (its bounds, in the platform's units) when the point
    /// was read off it. The window at another size is laid out otherwise, and
    /// the helper refuses rather than click where the point used to be.
    pub window_width: f64,
    pub window_height: f64,
}

/// Where a pointer action lands, as the helper is told it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "at", rename_all = "camelCase")]
pub enum DriverTarget {
    Element(ElementRef),
    Point(WindowPoint),
}

/// One action on one window: the closed list the helper translates into
/// driver calls. Delivered as its [`HelperOp::Act`] says — in the background
/// unless the person allows the front and it was asked for.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum WindowAction {
    #[serde(rename_all = "camelCase")]
    Click {
        at: DriverTarget,
        button: PointerButton,
        count: u8,
        /// Held down for the click.
        #[serde(default, skip_serializing_if = "no_modifiers")]
        modifiers: Modifiers,
    },
    /// Press at `from`, move to `to` over `duration_ms`, let go — with
    /// `modifiers` held for the whole of it.
    #[serde(rename_all = "camelCase")]
    Drag {
        from: WindowPoint,
        to: WindowPoint,
        button: PointerButton,
        #[serde(default, skip_serializing_if = "no_modifiers")]
        modifiers: Modifiers,
        duration_ms: u32,
    },
    #[serde(rename_all = "camelCase")]
    Scroll {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        at: Option<DriverTarget>,
        direction: ScrollDirection,
        amount: u32,
        unit: ScrollUnit,
    },
    #[serde(rename_all = "camelCase")]
    Type {
        element: ElementRef,
        text: String,
        submit: bool,
    },
    #[serde(rename_all = "camelCase")]
    Key {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        element: Option<ElementRef>,
        chord: Chord,
    },
    #[serde(rename_all = "camelCase")]
    SetValue { element: ElementRef, value: String },
    /// Put the window back on the screen: out of the Dock or the taskbar if
    /// it is minimized, and on macOS its application shown again if it is
    /// hidden. The helper's own on macOS (Accessibility) and Windows; on
    /// Linux the driver's, which can only do it by bringing the window to
    /// the front — so there it goes only with [`ActDelivery::Foreground`].
    Restore,
    /// Choose a command from the application's menus, by the titles on the
    /// way to it. The driver's, with the application brought to the front
    /// for it (macOS and Linux).
    #[serde(rename_all = "camelCase")]
    InvokeMenu { path: Vec<String> },
    /// Move and size the window, in desktop units: what is given put in
    /// place of the window's frame as the helper finds it just before.
    #[serde(rename_all = "camelCase")]
    SetFrame {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        x: Option<f64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        y: Option<f64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        width: Option<f64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        height: Option<f64>,
    },
}

impl WindowAction {
    /// The element the action names, if it names one.
    pub fn element(&self) -> Option<&ElementRef> {
        match self {
            WindowAction::Click {
                at: DriverTarget::Element(e),
                ..
            }
            | WindowAction::Scroll {
                at: Some(DriverTarget::Element(e)),
                ..
            } => Some(e),
            WindowAction::Type { element, .. } | WindowAction::SetValue { element, .. } => {
                Some(element)
            }
            WindowAction::Key { element, .. } => element.as_ref(),
            _ => None,
        }
    }

    /// Where the action lands, if at a point: the one it names — for a
    /// drag, where it lets go.
    pub fn point(&self) -> Option<&WindowPoint> {
        match self {
            WindowAction::Click {
                at: DriverTarget::Point(p),
                ..
            }
            | WindowAction::Scroll {
                at: Some(DriverTarget::Point(p)),
                ..
            }
            | WindowAction::Drag { to: p, .. } => Some(p),
            _ => None,
        }
    }

    /// Every point the action names: a drag's two, another's one.
    pub fn points(&self) -> Vec<&WindowPoint> {
        match self {
            WindowAction::Drag { from, to, .. } => vec![from, to],
            _ => self.point().into_iter().collect(),
        }
    }

    /// Whether the action puts text into its element: typing, setting a
    /// value, or a character key. Such an action never goes to a secret
    /// field.
    pub fn writes_text(&self) -> bool {
        match self {
            WindowAction::Type { .. } | WindowAction::SetValue { .. } => true,
            WindowAction::Key { chord, .. } => chord.types_text(),
            _ => false,
        }
    }
}

/// What the helper reports of an action that went out.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RawAct {
    pub effect: ActEffect,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub route: Option<ActRoute>,
    /// For typing with `submit`: whether return was pressed after the text.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub submitted: Option<bool>,
    /// For typing with `submit` whose return did not go out: why, in words
    /// for the agent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub submit_note: Option<String>,
    /// Where the action was aimed, as the helper knew it when it went out:
    /// the element's frame in the snapshot it was addressed by, and — for a
    /// point — the window's frame, measured just before. In the platform's
    /// desktop units. For showing the person where an agent acted; nothing
    /// is decided by them.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub element_frame: Option<Rect>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub window_frame: Option<Rect>,
    /// For an action that copies ([`ClipboardUse::track`]): the clipboard's
    /// stamp once the action changed it — what the agent itself put there.
    /// `None` when it did not change in time, or holds what an application
    /// marked concealed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub clipboard: Option<u64>,
}

/// Who may never be seen or touched over the entire screen: codeg itself,
/// and the applications on the blocklist — which the helper judges on its
/// own there, window by window, as codeg judges a window it shares.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScreenRules {
    pub me: super::agent::SelfIdentity,
    pub blocklist: Vec<String>,
}

/// The screen as a picture of it was taken: what a point read off the
/// picture means.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScreenGeometry {
    /// The picture's own pixels to a desktop unit.
    pub scale: f64,
    /// The screen's size, in desktop units.
    pub width: f64,
    pub height: f64,
}

/// What an action has to do with the clipboard.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipboardUse {
    /// The action copies or cuts, or may (a menu command): watch whether it
    /// changes the clipboard, and say what to.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub track: bool,
    /// The clipboard as the agent last put it there itself, when codeg holds
    /// that it still may be pasted: an action that pastes — a paste key, a
    /// menu command or a control that pastes — goes only while the clipboard
    /// is still this. Without it, nothing that pastes goes at all.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub paste: Option<u64>,
}

/// What the clipboard holds, read for an agent.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RawClipboard {
    /// Its text, when it has any.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
}

/// helper → codeg.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum HelperMessage {
    /// The helper's first frame. See the module note for why it goes first.
    Ready(HelperReady),
    Reply(HelperReply),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HelperReady {
    pub protocol: u32,
    /// The helper's own crate version, which is codeg's.
    pub version: String,
    /// What the helper knows about who it is talking to.
    pub peer: PeerCheck,
    /// [`SOURCE_FINGERPRINT`] as the helper was built. Absent from a helper
    /// older than the field, which a development codeg takes for a stale one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
}

/// Whether the helper checked codeg's code signature before serving it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PeerCheck {
    /// It did, and codeg passed (macOS release builds).
    Verified,
    /// A development build: no requirement was compiled in to check against.
    /// Said out loud so codeg can show it.
    Development,
    /// No code signature to check on this platform.
    NotApplicable,
}

/// The answer to one [`HelperRequest`]: exactly one of `ok` / `error`.
///
/// `ok` travels as a plain JSON value because codeg knows which op it asked
/// and decodes it into that op's type ([`HelperReply::decode`]); a tagged
/// union here would only repeat the op kind the id already names.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HelperReply {
    pub id: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ok: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<HelperError>,
}

impl HelperReply {
    pub fn ok(id: u64, value: impl Serialize) -> Self {
        match serde_json::to_value(value) {
            Ok(value) => Self {
                id,
                ok: Some(value),
                error: None,
            },
            Err(e) => Self::error(id, HelperError::failed(format!("encode: {e}"))),
        }
    }

    pub fn error(id: u64, error: HelperError) -> Self {
        Self {
            id,
            ok: None,
            error: Some(error),
        }
    }

    /// The answer as the type the op promises, or the helper's error.
    pub fn decode<T: DeserializeOwned>(self) -> Result<T, HelperError> {
        if let Some(error) = self.error {
            return Err(error);
        }
        let value = self.ok.unwrap_or(Value::Null);
        serde_json::from_value(value).map_err(|e| {
            HelperError::failed(format!("the helper answered in an unexpected shape: {e}"))
        })
    }
}

/// A permission the helper may need from the OS.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum OsPermission {
    /// macOS Accessibility: reading the element tree.
    Accessibility,
    /// macOS Screen Recording: screenshots, and other applications' window
    /// titles.
    ScreenRecording,
}

impl OsPermission {
    /// How [`REQUEST_PERMISSION_ARG`] names it.
    pub fn arg(self) -> &'static str {
        match self {
            OsPermission::Accessibility => "accessibility",
            OsPermission::ScreenRecording => "screen-recording",
        }
    }

    pub fn from_arg(arg: &str) -> Option<Self> {
        [OsPermission::Accessibility, OsPermission::ScreenRecording]
            .into_iter()
            .find(|p| p.arg() == arg)
    }
}

/// The helper's OS permissions, as the helper itself sees them.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionReport {
    /// Whether this platform has per-application permissions at all. `false`
    /// on Windows and X11, where both flags below are reported `true`.
    pub required: bool,
    pub accessibility: bool,
    pub screen_recording: bool,
}

impl PermissionReport {
    /// Whether `permission` is granted.
    pub fn has(&self, permission: OsPermission) -> bool {
        match permission {
            OsPermission::Accessibility => self.accessibility,
            OsPermission::ScreenRecording => self.screen_recording,
        }
    }
}

/// One running application, as the driver reports it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RawApp {
    pub pid: u32,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bundle_id: Option<String>,
    /// The application's path on disk (its `.app` bundle on macOS, its
    /// executable elsewhere), when the platform says.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    pub active: bool,
    /// An opaque, platform-specific stamp of when the process started. Only
    /// ever compared for equality.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub started_at: Option<u64>,
}

impl RawApp {
    /// The stable name of the application: its bundle identifier where it has
    /// one, its path otherwise. `None` for a process the platform describes
    /// by neither, which can be listed but never matched by a blocklist.
    pub fn key(&self) -> Option<&str> {
        self.bundle_id
            .as_deref()
            .filter(|s| !s.is_empty())
            .or(self.path.as_deref().filter(|s| !s.is_empty()))
    }
}

/// An installed application as the driver lists it: who it is — its bundle
/// identifier, or its executable — for codeg to judge by, and the command
/// that starts it, which is not who it is: a launch command carries
/// arguments, and on Linux may be a wrapper (`flatpak run …`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledApp {
    pub app: RawApp,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub launch_path: Option<String>,
}

/// An application started for an agent.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RawLaunch {
    /// The process, when the driver said.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pid: Option<u32>,
    pub name: String,
}

/// One run of a process: its pid, and the start stamp that tells it from a
/// later process under the same pid (`procinfo::process_start`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessRun {
    pub pid: u32,
    pub started_at: u64,
}

/// One normal window, as the driver reports it, joined with its application.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RawWindow {
    pub window_id: u64,
    pub pid: u32,
    /// Empty when the platform withholds it — on macOS, whenever the helper
    /// lacks Screen Recording.
    #[serde(default)]
    pub title: String,
    pub bounds: Rect,
    pub on_screen: bool,
    /// `None` when the platform cannot say. On macOS the driver never does;
    /// the helper asks Accessibility about the windows that could be, and on
    /// X11 the window manager (`helper::ops::mark_out_of_sight`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub minimized: Option<bool>,
    /// macOS: its application is hidden (⌘H), so the window is off the screen
    /// with nothing of its own having changed. `None` when that is not so or
    /// cannot be told.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hidden: Option<bool>,
    /// `false` for a window on another Space (desktop); `None` when the
    /// platform cannot say.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub on_current_space: Option<bool>,
    /// Higher is closer to the front; `None` when the platform cannot say.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub z_index: Option<i64>,
    /// Windows: the process drawing what is inside the window, where that is
    /// not the process owning it — a packaged application, inside the frame
    /// `ApplicationFrameHost` draws for it (see `appident`). `app` is then
    /// that process's application, and the window is that application's only
    /// as long as this same run of it is inside.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content: Option<ProcessRun>,
    pub app: RawApp,
}

/// A window screenshot.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RawCapture {
    /// PNG, base64.
    pub png_base64: String,
    /// The image's size, after the helper shrank it to the size asked for.
    pub width: u32,
    pub height: u32,
    /// The capture's size before it was shrunk: the window's own pixels. A
    /// point read off the image is scaled by `native / delivered` to reach
    /// the pixel the driver will act on.
    pub native_width: u32,
    pub native_height: u32,
    /// Whether `native_*` are known to be the window's pixels at full size —
    /// the driver runs with no ceiling on a capture, and the capture is the
    /// size of the window. Pointing by coordinates needs it.
    #[serde(default)]
    pub full_size: bool,
    pub window_bounds: Rect,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
}

/// A window's accessibility tree.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RawSnapshot {
    pub tree: String,
    pub element_count: u64,
    #[serde(default)]
    pub truncated: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub degraded: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub window_bounds: Option<Rect>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    /// The driver's id for this snapshot, which its elements are addressed
    /// by. `None` when the driver kept none (it could not match the window's
    /// accessibility surface): nothing in this tree can be acted on.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub snapshot_id: Option<String>,
    /// Every element that can be acted on, in tree order.
    #[serde(default)]
    pub refs: Vec<SnapshotRef>,
}

/// One element of a snapshot that can be acted on: the `[N]` in its line.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotRef {
    pub index: u32,
    /// Where the element's line starts in `tree`, in bytes — so whoever cuts
    /// the tree short knows which refs the reader was shown.
    pub offset: u32,
    /// A password or other secret field: its value was taken out of the
    /// tree, and nothing is typed into it.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub secret: bool,
}

/// The driver's verdict on a set of predicates.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RawVerify {
    pub status: VerifyStatus,
    pub stable: bool,
    pub samples: u64,
    pub elapsed_ms: u64,
    pub predicates: Vec<PredicateResult>,
}

/// Why the helper could not do what it was asked.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HelperError {
    pub code: HelperErrorCode,
    pub message: String,
    /// Which permission is missing, for [`HelperErrorCode::PermissionMissing`].
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub permission: Option<OsPermission>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HelperErrorCode {
    /// The helper lacks an OS permission this op needs.
    PermissionMissing,
    /// No such window, or it no longer belongs to the process named.
    NoSuchWindow,
    /// The driver is not there, would not start, or died.
    DriverUnavailable,
    /// The driver file is not the pinned release: its signature, cdhash,
    /// runtime flag, entitlements or digest did not match. Not retried — the
    /// same file will fail the same way.
    DriverRejected,
    /// An op that needs the driver arrived before `Configure`.
    NotConfigured,
    /// The op itself was malformed.
    BadRequest,
    /// Anything else, in words.
    Failed,
    /// No input goes anywhere right now: the session is locked, or another
    /// user's is active.
    Paused,
    /// The person pressed Stop after this was sent, or before it was let
    /// through: it was cut off.
    Stopped,
    /// The element or point is from a snapshot or capture the window has
    /// moved past — a newer snapshot replaced it, the window changed size.
    StaleRef,
    /// The element or point is not in the window.
    OutOfTarget,
    /// The window cannot take input in the background right now: minimized,
    /// hidden, on another desktop, or its application has another window the
    /// keys could reach instead.
    Occluded,
    /// The application offers no route for this action in the background.
    BackgroundUnavailable,
    /// The element is a password or other secret field.
    SecretField,
    /// The action was allowed and did not happen: a disabled control, no such
    /// option, more text than one call can type.
    ActionFailed,
    /// A paste by another route — a menu command or a control named for
    /// pasting: it would write the person's clipboard into the window.
    PasteRefused,
    /// A menu that reaches past the application shared: the Apple menu and
    /// the application menu.
    BeyondApp,
}

impl HelperError {
    pub fn new(code: HelperErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            permission: None,
        }
    }

    pub fn failed(message: impl Into<String>) -> Self {
        Self::new(HelperErrorCode::Failed, message)
    }

    pub fn permission_missing(permission: OsPermission) -> Self {
        let what = match permission {
            OsPermission::Accessibility => "Accessibility",
            OsPermission::ScreenRecording => "Screen Recording",
        };
        Self {
            code: HelperErrorCode::PermissionMissing,
            message: format!("codeg-computer-helper has not been granted {what}"),
            permission: Some(permission),
        }
    }
}

impl std::fmt::Display for HelperError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for HelperError {}

#[cfg(test)]
mod tests {
    use super::*;

    /// Ops are tagged by `kind` in camelCase — the one spelling both ends
    /// agree on — and an op the helper does not know is a parse error rather
    /// than something it could be tricked into forwarding.
    #[test]
    fn ops_round_trip_and_unknown_ops_do_not_parse() {
        let op = HelperOp::Capture {
            pid: 42,
            window_id: 7,
            max_dimension: Some(800),
        };
        let wire = serde_json::to_value(&op).unwrap();
        assert_eq!(wire["kind"], "capture");
        assert_eq!(wire["windowId"], 7);
        assert_eq!(serde_json::from_value::<HelperOp>(wire).unwrap(), op);

        // An action with nothing to say beyond its kind.
        let restore = HelperOp::Act {
            pid: 42,
            window_id: 7,
            started_at: 1,
            content: None,
            app_key: None,
            action: WindowAction::Restore,
            delivery: ActDelivery::Background,
            clipboard: Default::default(),
        };
        let wire = serde_json::to_value(&restore).unwrap();
        assert_eq!(wire["action"], serde_json::json!({ "kind": "restore" }));
        assert_eq!(wire["delivery"], "background");
        assert!(wire.get("content").is_none());
        assert_eq!(serde_json::from_value::<HelperOp>(wire).unwrap(), restore);

        // The front, said as the driver says it; and an act that does not
        // say goes in the background. A frame's window carries the run of
        // the application drawing inside it.
        let front = HelperOp::Act {
            pid: 42,
            window_id: 7,
            started_at: 1,
            content: Some(ProcessRun {
                pid: 43,
                started_at: 2,
            }),
            app_key: None,
            action: WindowAction::Restore,
            delivery: ActDelivery::Foreground,
            clipboard: Default::default(),
        };
        let wire = serde_json::to_value(&front).unwrap();
        assert_eq!(wire["delivery"], "foreground");
        assert_eq!(
            wire["content"],
            serde_json::json!({ "pid": 43, "startedAt": 2 })
        );
        assert_eq!(serde_json::from_value::<HelperOp>(wire).unwrap(), front);
        let mut unsaid = serde_json::to_value(&restore).unwrap();
        unsaid.as_object_mut().unwrap().remove("delivery");
        assert_eq!(serde_json::from_value::<HelperOp>(unsaid).unwrap(), restore);

        assert!(serde_json::from_value::<HelperOp>(serde_json::json!({
            "kind": "callTool",
            "name": "launch_app",
        }))
        .is_err());
    }

    /// A reply carries exactly one of its two halves, and decoding it into
    /// the wrong shape is an error rather than a default.
    #[test]
    fn a_reply_decodes_into_the_op_type_or_says_why_not() {
        let report = PermissionReport {
            required: true,
            accessibility: true,
            screen_recording: false,
        };
        let reply = HelperReply::ok(3, report);
        let wire = serde_json::to_value(&reply).unwrap();
        assert!(wire.get("error").is_none());
        let back: HelperReply = serde_json::from_value(wire).unwrap();
        assert_eq!(back.clone().decode::<PermissionReport>().unwrap(), report);
        assert!(back.decode::<RawCapture>().is_err());

        let refused = HelperReply::error(
            4,
            HelperError::permission_missing(OsPermission::ScreenRecording),
        );
        let err = refused.decode::<RawCapture>().unwrap_err();
        assert_eq!(err.code, HelperErrorCode::PermissionMissing);
        assert_eq!(err.permission, Some(OsPermission::ScreenRecording));
    }

    /// Every request carries codeg's count of Stops, and so does a Stop: they
    /// are held one against the other by it, not by the order they arrive in.
    #[test]
    fn requests_and_stops_carry_the_stop_count() {
        let halt = serde_json::to_value(HelperOp::Halt { stop: 3 }).unwrap();
        assert_eq!(halt, serde_json::json!({"kind": "halt", "stop": 3}));
        let request = HelperRequest {
            id: 7,
            op: HelperOp::ListApps,
            stop: 5,
        };
        let wire = serde_json::to_value(&request).unwrap();
        assert_eq!(wire["stop"], 5);
        assert_eq!(
            serde_json::from_value::<HelperRequest>(wire).unwrap(),
            request
        );
        // A request without one is not a request from this codeg.
        assert!(serde_json::from_value::<HelperRequest>(serde_json::json!({
            "id": 1, "op": {"kind": "listApps"}
        }))
        .is_err());
    }

    /// The request helper is told the permission by name, and says whether
    /// the system asked.
    #[test]
    fn a_permission_request_is_named_and_answered() {
        for permission in [OsPermission::Accessibility, OsPermission::ScreenRecording] {
            assert_eq!(OsPermission::from_arg(permission.arg()), Some(permission));
        }
        assert_eq!(OsPermission::from_arg("screenRecording"), None);
        let asked: PermissionAsked = serde_json::from_str(r#"{"prompted":true}"#).unwrap();
        assert!(asked.prompted);
    }

    #[test]
    fn the_ready_frame_is_tagged() {
        let ready = HelperMessage::Ready(HelperReady {
            protocol: PROTOCOL_VERSION,
            version: "0.0.0".into(),
            peer: PeerCheck::Development,
            source: Some(SOURCE_FINGERPRINT.into()),
        });
        let wire = serde_json::to_value(&ready).unwrap();
        assert_eq!(wire["kind"], "ready");
        assert_eq!(wire["peer"], "development");
        assert_eq!(wire["source"], SOURCE_FINGERPRINT);
        assert_eq!(
            serde_json::from_value::<HelperMessage>(wire).unwrap(),
            ready
        );
        // A helper from before the field still introduces itself.
        let older: HelperMessage = serde_json::from_value(serde_json::json!({
            "kind": "ready", "protocol": PROTOCOL_VERSION, "version": "0.0.0", "peer": "development"
        }))
        .unwrap();
        assert!(matches!(
            older,
            HelperMessage::Ready(HelperReady { source: None, .. })
        ));
    }

    #[test]
    fn an_application_is_keyed_by_bundle_then_path() {
        let mut app = RawApp {
            pid: 1,
            name: "Mail".into(),
            bundle_id: Some("com.apple.mail".into()),
            path: Some("/System/Applications/Mail.app".into()),
            active: false,
            started_at: None,
        };
        assert_eq!(app.key(), Some("com.apple.mail"));
        app.bundle_id = Some(String::new());
        assert_eq!(app.key(), Some("/System/Applications/Mail.app"));
        app.path = None;
        assert_eq!(app.key(), None);
    }
}
