//! Listener-facing access for computer use (`computer_list_apps`,
//! `computer_list_windows`, `computer_screenshot`, `computer_snapshot`,
//! `computer_verify`, and the actions `computer_click`, `computer_drag`,
//! `computer_scroll`, `computer_type`, `computer_press_key`,
//! `computer_hold_key`, `computer_set_value`, `computer_restore`,
//! `computer_invoke_menu`) carried by codeg-mcp.
//!
//! The same split as the browser tools: nothing here decides whether a window
//! may be read. That is `crate::computer::agent` and the target table, and it
//! is enforced inside `commands::computer`, which the production impl calls —
//! so an MCP read passes the same grant check, and leaves the same line on the
//! panel's activity list, as any other.
//!
//! What this module owns is the shape of the answer — a refusal is a value,
//! not a transport error, so the agent can relay "ask the user to share that
//! window" instead of losing its turn — the words of each refusal, each of
//! which says whether trying again can help (a model takes that sentence
//! literally), and the answer where there is no
//! desktop at all ([`NoComputerDesktop`]): server mode, where the group is not
//! advertised in the first place.

use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use tokio::sync::RwLock;

use crate::computer::types::{
    ActDelivery, ActReport, AgentAppSummary, AgentScreen, AgentWindowSummary, ComputerActRequest,
    VerifyOutcome, VerifyRequest, WindowCapture, WindowSnapshot,
};

/// This build has no desktop to show (server mode), the user has switched
/// computer use off, or it cannot run here right now (the note says which).
pub const ERROR_UNAVAILABLE: &str = "computer_unavailable";

/// The window exists and this agent may not read it: nobody shared it, the
/// sharing ended, or the window went away. One slug for all of them — the
/// instruction is the same, and telling them apart would describe a window
/// the agent has no right to know anything about.
pub const ERROR_GRANT_REQUIRED: &str = "computer_grant_required";

/// No window by that id. Also the answer to a caller whose token does not
/// check out, so an unauthenticated round trip learns nothing about what is
/// on the screen.
pub const ERROR_NO_SUCH_TARGET: &str = "computer_no_such_target";

/// The window can never be shared: codeg's own, or an application on the
/// blocklist. Permanent — asking again changes nothing.
pub const ERROR_BLOCKED: &str = "computer_blocked";

/// The OS has not given codeg's helper a permission the read needs. The user
/// can fix it in System Settings; the agent cannot.
pub const ERROR_PERMISSION_MISSING: &str = "computer_permission_missing";

/// The window was shared and the read still did not produce anything — the
/// driver failed, or the window closed mid-read.
pub const ERROR_READ_FAILED: &str = "computer_read_failed";

/// The window is shared for reading and the agent asked to act on it — or
/// asked for a key a window grant does not reach (one that acts on the whole
/// application or the desktop). Its own slug, like the browser's: the person
/// has a different thing to do than share the window.
pub const ERROR_CONTROL_REQUIRED: &str = "computer_control_required";

/// The ref or point is not from the window's latest snapshot or screenshot as
/// the agent was given it, or the window has changed under it. Not a
/// permission matter: read the window again and use what the new read says.
pub const ERROR_STALE_REF: &str = "computer_stale_ref";

/// The point is outside the image it was read off, or the element is not
/// part of the shared window.
pub const ERROR_OUT_OF_TARGET: &str = "computer_out_of_target";

/// The window cannot take input in the background right now — minimized,
/// hidden, on another desktop, or its application has another window the keys
/// could reach instead.
pub const ERROR_OCCLUDED: &str = "computer_occluded";

/// The application offers no background route for this action. Whether it
/// may go again with the window brought to the front is the person's to
/// allow; the note says which it is.
pub const ERROR_BACKGROUND_UNAVAILABLE: &str = "computer_background_unavailable";

/// The agent asked for the window to be brought to the front for an action
/// (`delivery: "foreground"`), and the person has not allowed that. Theirs to
/// change, in codeg's settings; asking again changes nothing.
pub const ERROR_FOREGROUND_NOT_ALLOWED: &str = "computer_foreground_not_allowed";

/// The action was allowed and did not happen: a disabled control, no such
/// option, more text than one call can type. The note says which.
pub const ERROR_ACTION_FAILED: &str = "computer_action_failed";

/// The screen is locked, or another user's session is active. Nothing
/// reaches any window until it is unlocked.
pub const ERROR_PAUSED: &str = "computer_paused";

/// The person pressed Stop: every window stopped being shared, and whatever
/// was under way was cut off. Nothing is shared again until they share it.
pub const ERROR_STOPPED: &str = "computer_stopped";

/// What a `computer_snapshot` asks for when the caller names no cap — the
/// same default as `browser_snapshot`, for the same reason: the caller who
/// names nothing is a model with a context window.
pub const DEFAULT_SNAPSHOT_MAX_CHARS: usize = 40_000;

/// The long edge of a screenshot when the caller names none: the driver's own
/// default, and the size every current model accepts without resizing.
pub const DEFAULT_MAX_DIMENSION: u32 = 1568;

/// Said to an agent in a runtime with no desktop, and to one whose user has
/// switched the group off.
pub const NO_DESKTOP_NOTE: &str =
    "Computer use is not available in this session: there are no windows to read.";

/// How to share a window, for every refusal that ends in "ask the user".
const SHARE_HOW: &str = "Ask the user to share it: in codeg's status bar they open Computer use \
                         and press \"Share a window…\". Sharing is theirs to give — there is no \
                         way to take it, and no point retrying until they have.";

/// What `computer_list_apps` answers.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComputerAppsOutcome {
    pub apps: Vec<AgentAppSummary>,
    /// One of the slugs above when the list is empty for a reason.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

impl ComputerAppsOutcome {
    pub fn refused(error: &str, note: impl Into<String>) -> Self {
        Self {
            apps: Vec::new(),
            error: Some(error.to_string()),
            note: Some(note.into()),
        }
    }
}

/// What `computer_launch_app` answers: the application started, or why not.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComputerLaunchOutcome {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub app: Option<crate::computer::types::AgentAppRef>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

impl ComputerLaunchOutcome {
    pub fn refused(error: &str, note: impl Into<String>) -> Self {
        Self {
            app: None,
            error: Some(error.to_string()),
            note: Some(note.into()),
        }
    }
}

/// What `computer_clipboard_read` / `computer_clipboard_write` ask.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ClipboardOp {
    Read,
    Write { text: String },
}

/// What `computer_clipboard_read` / `computer_clipboard_write` answer.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComputerClipboardOutcome {
    /// What was read.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    /// The text was put on the clipboard.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub written: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

impl ComputerClipboardOutcome {
    pub fn refused(error: &str, note: impl Into<String>) -> Self {
        Self {
            error: Some(error.to_string()),
            note: Some(note.into()),
            ..Self::default()
        }
    }
}

/// What `computer_list_windows` answers.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComputerWindowsOutcome {
    pub windows: Vec<AgentWindowSummary>,
    /// The entire screen, while the user shares it as a whole.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub screen: Option<AgentScreen>,
    /// How actions reach the windows, as the person has it set now.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub input: Option<InputPolicy>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

impl ComputerWindowsOutcome {
    pub fn refused(error: &str, note: impl Into<String>) -> Self {
        Self {
            windows: Vec::new(),
            screen: None,
            input: None,
            error: Some(error.to_string()),
            note: Some(note.into()),
        }
    }
}

/// How an action reaches a window, as the person has it set: said with every
/// listing, so an agent knows before it acts whether a window may be brought
/// to the front for it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InputPolicy {
    /// What an action gets when the agent does not ask (`delivery`).
    pub default: ActDelivery,
    /// Whether an agent may ask for the front.
    pub foreground_allowed: bool,
}

impl InputPolicy {
    pub fn of(config: &ComputerToolsConfig) -> Self {
        Self {
            default: config.default_delivery_in_force(),
            foreground_allowed: config.allow_foreground,
        }
    }
}

/// A refusal about one window, shared by the three per-window reads.
///
/// The words are the same whichever read was refused, so a refusal cannot be
/// used to learn which gate a window stops at.
pub fn grant_required_note(target_id: &str) -> String {
    format!(
        "Window {target_id} is not shared with agents, or no longer is (sharing ends when the \
         window closes, when its application quits, after a while unused, or when the user takes \
         it back). {SHARE_HOW} If the window may have closed, call computer_list_windows first."
    )
}

pub fn no_such_target_note(target_id: &str) -> String {
    format!(
        "There is no window {target_id}. Call computer_list_windows for the windows that exist \
         now, and use a targetId from it."
    )
}

pub fn blocked_note(target_id: &str, why: &str) -> String {
    format!("Window {target_id} is {why} Do not ask the user to share it; it cannot be done.")
}

pub fn permission_missing_note(permission: &str) -> String {
    format!(
        "codeg-computer-helper has not been granted {permission} by macOS. Ask the user to grant \
         it: in codeg's status bar they open Computer use and follow the permission guide \
         (System Settings → Privacy & Security → {permission}). Only they can, and retrying will \
         not help until they have."
    )
}

pub fn control_required_note(target_id: &str) -> String {
    format!(
        "Window {target_id} is shared with you for reading only. Ask the user to let you act on \
         it: in codeg's status bar they open Computer use and set that window to \"Read and \
         act\". Only they can; retrying will not change it. You can still read the window."
    )
}

/// A key that reaches past the window — the application's or the desktop's.
pub fn chord_beyond_note() -> String {
    format!(
        "That key acts on the whole application or on the desktop, which a shared window does \
         not reach, so it was not pressed; retrying will not change it. {} For anything else, \
         act on an element: computer_click by ref, or computer_set_value. An application the \
         user shares as a whole takes its own shortcuts too, and its menus \
         (computer_invoke_menu) — that is theirs to choose.",
        crate::computer::keys::window_chords_note(crate::computer::keys::Platform::current())
    )
}

/// Said when keys are to be held over a double-click in a window: the
/// driver's double-click does not hold them.
pub const DOUBLE_CLICK_MODIFIERS_NOTE: &str = "Holding keys down over a double-click is not \
     available in a window, so nothing was sent. Double-click without `modifiers`, or reach the \
     same end another way.";

/// Said when keys are to be held over a drag on a system whose driver would
/// drag without them.
pub const DRAG_MODIFIERS_NOTE: &str = "Holding keys down over a drag is not available on this \
     system: the drag would go without them, so nothing was sent. Drag without `modifiers`, or \
     reach the same end another way.";

/// Said when the window was taken back between two presses of one key and
/// shared again before the next: the presses end with the sharing they began
/// under.
pub fn reshared_note(target_id: &str) -> String {
    format!(
        "Window {target_id} was taken back from you while the key was being pressed, which \
         ended the presses; the user has shared it again since. Look at the window again before \
         going on."
    )
}

/// Said when a key is the desktop's own, under a grant on the whole
/// application.
pub const DESKTOP_CHORD_NOTE: &str = "That key is the desktop's own — it switches applications, \
     opens the launcher, takes a screenshot, locks the screen or the like — which not even an \
     application shared as a whole reaches, so it was not pressed; retrying will not change it.";

/// Said when a key locks the screen, logs out, or shows every window at
/// once.
pub const SESSION_CHORD_NOTE: &str = "That key locks the screen, logs out, or shows every window \
     at once (Mission Control, Task View) — which no sharing reaches, not even the entire \
     screen's — so it was not pressed; retrying will not change it.";

/// Said when the entire screen is asked for and it is not shared, or no
/// longer is.
pub const SCREEN_GRANT_REQUIRED_NOTE: &str =
    "The entire screen (d1) is not shared with agents, or \
     no longer is (that sharing ends after a while unused, or when the user takes it back or \
     switches it off). Ask the user to share it: in codeg's status bar they open Computer use, \
     press \"Share a window…\" and choose the entire screen — only they can, and it is offered \
     only where they have switched it on in codeg's Computer use settings. Meanwhile, read the \
     windows shared with you one by one.";

/// Said when the entire screen is shared for reading and an action is asked.
pub const SCREEN_CONTROL_REQUIRED_NOTE: &str = "The entire screen (d1) is shared with you for \
     reading only. Ask the user to let you act on it: in codeg's Computer use panel they set the \
     entire screen to \"Read and act\". Only they can; retrying will not change it.";

/// Said when a point on the entire screen is not from its latest picture.
pub const SCREEN_STALE_CAPTURE_NOTE: &str = "Those coordinates are not from the latest \
     computer_screenshot of the entire screen (d1): a point means something only in the picture \
     it was read off. Take a new computer_screenshot of d1 and use a point from it.";

/// Said when the entire screen is asked for something other than its
/// picture and points on it.
pub const SCREEN_POINTER_ONLY_NOTE: &str = "The entire screen (d1) takes computer_screenshot, and \
     computer_click, computer_drag and computer_scroll at points of its picture. For anything \
     else — keys, typing, a value, a menu, the controls' tree — act on a window: every window the \
     user can share is shared with you along with the screen (see computer_list_windows).";

/// Said when an action on the entire screen is asked for and the person
/// does not allow the front.
pub const SCREEN_NEEDS_FRONT_NOTE: &str = "An action on the entire screen moves the user's own \
     pointer and goes to whatever is in front at that point, and the user has switched off \
     bringing windows to the front in codeg's Computer use settings (\"Let agents bring windows \
     to the front\"), so nothing was sent. Act on a window in the background instead, or ask the \
     user whether to switch it back on — only they can.";

/// Said when an action on the entire screen is asked to go in the
/// background.
pub const SCREEN_NOT_BACKGROUND_NOTE: &str = "An action on the entire screen goes to the front, \
     as the user's own pointer would — never in the background — so nothing was sent. Leave \
     `delivery` out, or act on a window in the background instead.";

/// Said when the never-share list grew while the entire screen was being
/// captured.
pub const SCREEN_RULES_CHANGED_NOTE: &str = "The user's never-share list changed while the entire \
     screen was being captured, so the picture was not handed over. Take a new computer_screenshot \
     of d1.";

/// Said when something only an application shared as a whole allows is
/// asked of a window shared on its own.
pub fn app_grant_required_note(target_id: &str) -> String {
    format!(
        "Menus act on the whole application, and window {target_id} is shared on its own. Ask \
         the user to share its application as a whole, for \"Read and act\", in codeg's Computer \
         use panel — only they can."
    )
}

/// Said for a menu command on Windows, whose driver cannot choose one.
pub const MENUS_UNAVAILABLE_NOTE: &str = "Menus cannot be chosen by title on Windows, so nothing \
     was sent. Take a computer_snapshot and click the menu, then its item, by ref.";

/// Said when a menu command is asked for and the person does not allow
/// bringing windows to the front.
pub const MENU_NEEDS_FRONT_NOTE: &str = "A menu command is chosen with its application brought to \
     the front, and the user has switched that off in codeg's Computer use settings (\"Let agents \
     bring windows to the front\"), so nothing was sent. Ask the user whether to switch it back \
     on — only they can.";

/// Said when starting an application, or moving a window, is asked for and
/// the person has not switched it on.
pub const LAUNCH_OFF_NOTE: &str = "Starting applications and moving or sizing windows is \
     switched off in codeg's Computer use settings (\"Let agents open applications and move \
     windows\"), so nothing was done. Ask the user whether to switch it on — only they can.";

/// Said when the clipboard tools are asked for and the person has not
/// switched them on.
pub const CLIPBOARD_OFF_NOTE: &str = "Reading and writing the clipboard is switched off in \
     codeg's Computer use settings (\"Let agents use the clipboard\"), so nothing was done. Ask \
     the user whether to switch it on — only they can.";

/// Said when the clipboard does not hold what an agent put there.
pub const CLIPBOARD_NOT_YOURS_NOTE: &str = "The clipboard holds what the user put there, not what \
     you copied from a window you may read or wrote with computer_clipboard_write, so it is not \
     read for you; retrying will not change it. Copy from a shared window first.";

/// Said with text put on the clipboard for an agent.
pub const CLIPBOARD_WRITTEN_NOTE: &str =
    "The text is on the clipboard: a paste into a window shared \
     with you for control now writes it there, until something else is copied.";

/// Said with an application started for an agent.
pub const LAUNCHED_NOTE: &str = "It was started in the background. Its windows are not shared \
     with you by this: find them with computer_list_windows, and ask the user to share the one \
     you need — only they can.";

/// Said for a frame no window can have.
pub const BAD_FRAME_NOTE: &str = "That frame cannot be given to a window: every number must be a \
     plain number, the width and the height at least 50, and nothing beyond 100000. Use \
     desktop units, as computer_list_windows gives a window's bounds.";

pub const PASTE_NOTE: &str = "That pastes, and the clipboard holds what the user put there — not \
     what you copied from a window you may read, or wrote with computer_clipboard_write — so it \
     was not pressed. Type the text with computer_type instead, or copy it from a shared window \
     first.";

pub const NEEDS_ELEMENT_NOTE: &str = "A key that types a character goes only into an element you \
     name: pass its ref from computer_snapshot, or type the text with computer_type.";

pub const SECRET_FIELD_NOTE: &str = "That is a password or other secret field: typing into it, or \
     setting it, is left to the user. Ask them to fill it in themselves; retrying will not change \
     it.";

pub fn stale_snapshot_note(target_id: &str) -> String {
    format!(
        "That ref is not from the latest computer_snapshot of window {target_id} — every new \
         snapshot replaces the refs of the one before. Take a new computer_snapshot and use a ref \
         from it."
    )
}

pub fn not_actionable_note(target_id: &str) -> String {
    format!(
        "Nothing in that snapshot of window {target_id} can be acted on: its accessibility tree \
         could not be matched to the window. Take a new computer_snapshot; if it says the same, \
         use a point from computer_screenshot instead."
    )
}

pub fn cut_away_note(index: u32) -> String {
    format!(
        "Ref {index} was past where the snapshot you were given was cut (maxChars). Take a new \
         computer_snapshot with a larger maxChars, or a query that keeps its line, and use the \
         ref from that."
    )
}

pub fn no_such_ref_note(target_id: &str, index: u32) -> String {
    format!(
        "The latest snapshot of window {target_id} has no ref {index}. Use a ref that is in it."
    )
}

pub fn stale_capture_note(target_id: &str) -> String {
    format!(
        "Those coordinates are not from the latest computer_screenshot of window {target_id}: a \
         point means something only in the image it was read off. Take a new computer_screenshot \
         and use a point from it."
    )
}

pub const OUT_OF_IMAGE_NOTE: &str = "That point is outside the screenshot it names. Use a point \
     inside the image, measured in its pixels from its top-left corner.";

pub fn no_pointing_note(target_id: &str) -> String {
    format!(
        "Points cannot be used on that screenshot of window {target_id}. Use a ref from \
         computer_snapshot instead."
    )
}

pub const STOPPED_NOTE: &str = "The user pressed Stop in codeg's Computer use panel: every \
     window stopped being shared, and whatever was under way was cut off. Do not retry on your \
     own — tell the user, and go on only once they share a window with you again.";

pub const FOREGROUND_NOT_ALLOWED_NOTE: &str = "Bringing a window to the front for an action is \
     not allowed: the user has switched it off in codeg's Computer use settings (\"Let agents \
     bring windows to the front\"), so nothing was sent. Leave `delivery` out to act in the \
     background; if only the front will do, ask the user whether to switch it back on — only \
     they can.";

/// Said when a window is to be restored on Linux — which takes bringing it
/// to the front — and the person does not allow that.
pub const RESTORE_NEEDS_FRONT_NOTE: &str = "On Linux a minimized window comes back on the screen \
     only by being brought to the front, and the user has switched that off in codeg's Computer \
     use settings (\"Let agents bring windows to the front\"), so nothing was sent. Ask the user \
     to restore the window, or whether to switch that back on — only they can.";

/// What an action the application would not take in the background can try
/// next, as the person has the front set: the words that end every
/// `computer_background_unavailable` note.
pub fn background_next_step(allow_foreground: bool) -> &'static str {
    if allow_foreground {
        "The user allows bringing a window to the front: call again with `delivery: \
         \"foreground\"`, and codeg brings this window forward for that one action, then switches \
         back to the window the user was in (on Linux it stays in front). They will see it \
         happen, and a click may move their pointer."
    } else {
        "The user has switched off bringing windows to the front in codeg's Computer use \
         settings; if nothing else will do, ask them whether to switch it back on."
    }
}

/// What an action tool answers: what the action did, or why it did not
/// happen.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComputerActOutcome {
    pub target_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub action: Option<ActReport>,
    /// One of the slugs above. `None` exactly when `action` is `Some`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

impl ComputerActOutcome {
    pub fn done(target_id: &str, report: ActReport) -> Self {
        Self {
            target_id: target_id.to_string(),
            action: Some(report),
            error: None,
            note: None,
        }
    }

    pub fn refused(target_id: &str, error: &str, note: impl Into<String>) -> Self {
        Self {
            target_id: target_id.to_string(),
            action: None,
            error: Some(error.to_string()),
            note: Some(note.into()),
        }
    }
}

/// What `computer_screenshot` answers.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComputerCaptureOutcome {
    pub target_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub capture: Option<WindowCapture>,
    /// `None` exactly when `capture` is `Some`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

impl ComputerCaptureOutcome {
    pub fn image(target_id: &str, capture: WindowCapture) -> Self {
        Self {
            target_id: target_id.to_string(),
            capture: Some(capture),
            error: None,
            note: None,
        }
    }

    pub fn refused(target_id: &str, error: &str, note: impl Into<String>) -> Self {
        Self {
            target_id: target_id.to_string(),
            capture: None,
            error: Some(error.to_string()),
            note: Some(note.into()),
        }
    }
}

/// What `computer_snapshot` asks for.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotRequest {
    /// Cap on the returned tree in characters. `None` →
    /// [`DEFAULT_SNAPSHOT_MAX_CHARS`]; `Some(0)` → no cap.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_chars: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_depth: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_elements: Option<u32>,
    /// Keep only the lines mentioning this (and their ancestors).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub query: Option<String>,
}

/// What `computer_snapshot` answers.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComputerSnapshotOutcome {
    pub target_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub snapshot: Option<WindowSnapshot>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

impl ComputerSnapshotOutcome {
    pub fn tree(target_id: &str, snapshot: WindowSnapshot) -> Self {
        Self {
            target_id: target_id.to_string(),
            snapshot: Some(snapshot),
            error: None,
            note: None,
        }
    }

    pub fn refused(target_id: &str, error: &str, note: impl Into<String>) -> Self {
        Self {
            target_id: target_id.to_string(),
            snapshot: None,
            error: Some(error.to_string()),
            note: Some(note.into()),
        }
    }
}

/// What `computer_verify` answers.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComputerVerifyOutcome {
    pub target_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub verify: Option<VerifyOutcome>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

impl ComputerVerifyOutcome {
    pub fn verdict(target_id: &str, verify: VerifyOutcome) -> Self {
        Self {
            target_id: target_id.to_string(),
            verify: Some(verify),
            error: None,
            note: None,
        }
    }

    pub fn refused(target_id: &str, error: &str, note: impl Into<String>) -> Self {
        Self {
            target_id: target_id.to_string(),
            verify: None,
            error: Some(error.to_string()),
            note: Some(note.into()),
        }
    }
}

/// Listener-facing access to computer use. The production impl
/// (`crate::commands::computer::McpComputerTools`) exists only in the desktop
/// build; server mode and tests use [`NoComputerDesktop`].
#[async_trait]
pub trait ComputerToolAccess: Send + Sync {
    /// The running applications.
    async fn list_apps(&self) -> ComputerAppsOutcome;

    /// Every normal window, or `pid`'s only.
    async fn list_windows(&self, pid: Option<u32>) -> ComputerWindowsOutcome;

    /// A screenshot of one shared window.
    async fn capture(&self, target_id: &str, max_dimension: Option<u32>) -> ComputerCaptureOutcome;

    /// The accessibility tree of one shared window.
    async fn snapshot(&self, target_id: &str, request: SnapshotRequest) -> ComputerSnapshotOutcome;

    /// Check predicates against one shared window.
    async fn verify(&self, target_id: &str, request: VerifyRequest) -> ComputerVerifyOutcome;

    /// Act on one window shared for control — brought to the front for it
    /// or not as `delivery` asks, or as the person set it when it does not.
    async fn act(
        &self,
        target_id: &str,
        request: ComputerActRequest,
        delivery: Option<ActDelivery>,
    ) -> ComputerActOutcome;

    /// Start an installed application — by its key, or by its name — in the
    /// background. Its windows are not shared by it.
    async fn launch_app(&self, name: Option<String>, key: Option<String>) -> ComputerLaunchOutcome;

    /// Read back what the agent put on the clipboard, or put text there.
    async fn clipboard(&self, op: ClipboardOp) -> ComputerClipboardOutcome;
}

/// The answer where there is no desktop: server mode, and the stub in every
/// test that does not care about one.
pub struct NoComputerDesktop;

#[async_trait]
impl ComputerToolAccess for NoComputerDesktop {
    async fn list_apps(&self) -> ComputerAppsOutcome {
        ComputerAppsOutcome::refused(ERROR_UNAVAILABLE, NO_DESKTOP_NOTE)
    }

    async fn list_windows(&self, _pid: Option<u32>) -> ComputerWindowsOutcome {
        ComputerWindowsOutcome::refused(ERROR_UNAVAILABLE, NO_DESKTOP_NOTE)
    }

    async fn capture(&self, target_id: &str, _max: Option<u32>) -> ComputerCaptureOutcome {
        ComputerCaptureOutcome::refused(target_id, ERROR_UNAVAILABLE, NO_DESKTOP_NOTE)
    }

    async fn snapshot(
        &self,
        target_id: &str,
        _request: SnapshotRequest,
    ) -> ComputerSnapshotOutcome {
        ComputerSnapshotOutcome::refused(target_id, ERROR_UNAVAILABLE, NO_DESKTOP_NOTE)
    }

    async fn verify(&self, target_id: &str, _request: VerifyRequest) -> ComputerVerifyOutcome {
        ComputerVerifyOutcome::refused(target_id, ERROR_UNAVAILABLE, NO_DESKTOP_NOTE)
    }

    async fn act(
        &self,
        target_id: &str,
        _request: ComputerActRequest,
        _delivery: Option<ActDelivery>,
    ) -> ComputerActOutcome {
        ComputerActOutcome::refused(target_id, ERROR_UNAVAILABLE, NO_DESKTOP_NOTE)
    }

    async fn launch_app(
        &self,
        _name: Option<String>,
        _key: Option<String>,
    ) -> ComputerLaunchOutcome {
        ComputerLaunchOutcome::refused(ERROR_UNAVAILABLE, NO_DESKTOP_NOTE)
    }

    async fn clipboard(&self, _op: ClipboardOp) -> ComputerClipboardOutcome {
        ComputerClipboardOutcome::refused(ERROR_UNAVAILABLE, NO_DESKTOP_NOTE)
    }
}

/// The computer-use settings as the tool surface reads them, at injection and
/// again at call time — like the browser group, because switching it off
/// should stop the agent that is already running, not only the next one.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ComputerToolsConfig {
    pub enabled: bool,
    /// How long a shared window may go unread before its sharing ends. `None`
    /// is "until the user takes it back".
    pub grant_ttl: Option<Duration>,
    /// Applications the user added to the default blocklist.
    pub blocklist: Vec<String>,
    /// Keys of the default blocklist entries the user took off it
    /// (`computer::agent::DEFAULT_BLOCKLIST`).
    pub blocklist_removed: Vec<String>,
    /// The shortcut that stops every agent at once, from anywhere; `None`
    /// when the person switched it off.
    pub stop_shortcut: Option<crate::computer::stop_shortcut::StopShortcut>,
    /// Whether the strip above every window comes up while anything is
    /// shared. On unless the person turned it off: Stop is on it.
    pub show_indicator: bool,
    /// Whether an action may bring its window to the front
    /// ([`ActDelivery::Foreground`]). On unless the person turned it off.
    pub allow_foreground: bool,
    /// What an action gets when the agent does not ask, as the person chose
    /// it — in force only while they allow the front at all (see
    /// [`Self::default_delivery_in_force`]).
    pub default_delivery: ActDelivery,
    /// Whether an agent may start applications and move or size a shared
    /// window. Off unless the person turned it on.
    pub launch_enabled: bool,
    /// Whether an agent may read back what it put on the clipboard, and put
    /// text there. Off unless the person turned it on. (Pasting what it
    /// copied needs no switch: see `commands::computer`.)
    pub clipboard_enabled: bool,
    /// Whether the person may share the entire screen at once. Off unless
    /// they turned it on; turning it off ends the screen's share.
    pub screen_enabled: bool,
    /// How many times the group has been switched off since codeg started.
    /// Kept by [`ComputerToolsRuntimeConfig::set`], never persisted: it is
    /// what lets a watcher that only sees the latest value — a quick off and
    /// on again arrives as one change — still see that there was an off, and
    /// a read in flight see that one happened while it was.
    pub switched_off: u64,
}

impl Default for ComputerToolsConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            grant_ttl: None,
            blocklist: Vec::new(),
            blocklist_removed: Vec::new(),
            stop_shortcut: None,
            show_indicator: true,
            allow_foreground: true,
            default_delivery: ActDelivery::Background,
            launch_enabled: false,
            clipboard_enabled: false,
            screen_enabled: false,
            switched_off: 0,
        }
    }
}

impl ComputerToolsConfig {
    /// What an action gets when the agent does not ask: the person's choice
    /// while they allow the front at all, the background otherwise.
    pub fn default_delivery_in_force(&self) -> ActDelivery {
        if self.allow_foreground {
            self.default_delivery
        } else {
            ActDelivery::Background
        }
    }
}

/// Shared, hot-swappable handle to [`ComputerToolsConfig`]. Cloned into
/// `DelegationInjection` (read at injection), into the access impl (read at
/// call time) and into `AppState` (updated on save).
///
/// Unlike the browser's handle it can also be watched: switching computer use
/// off ends every grant and stops the helper, and whoever owns those — the
/// desktop's computer service — learns of the switch here, whichever of the
/// three writers (settings form, status popover, web settings) moved it.
///
/// Two ways to learn of it, for two kinds of consequence. What a change takes
/// away — grants — goes through [`on_change`](Self::on_change): run inside
/// [`set`](Self::set), once per change, with the settings before and after,
/// so it is done before the write returns and no change is ever merged into
/// the next. What can wait for a task to be scheduled — stopping and starting
/// the helper — goes through [`subscribe`](Self::subscribe), which sees only
/// the latest value (hence `switched_off`).
#[derive(Clone)]
pub struct ComputerToolsRuntimeConfig {
    inner: Arc<RwLock<ComputerToolsConfig>>,
    changes: Arc<tokio::sync::watch::Sender<ComputerToolsConfig>>,
    hook: Arc<std::sync::RwLock<Option<ChangeHook>>>,
    /// Whether this process serves computer use at all (see
    /// [`mark_served`](Self::mark_served)).
    served: Arc<std::sync::atomic::AtomicBool>,
}

/// See [`ComputerToolsRuntimeConfig::on_change`].
type ChangeHook = Box<dyn Fn(&ComputerToolsConfig, &ComputerToolsConfig) + Send + Sync>;

impl Default for ComputerToolsRuntimeConfig {
    fn default() -> Self {
        Self {
            inner: Arc::new(RwLock::new(ComputerToolsConfig::default())),
            changes: Arc::new(tokio::sync::watch::channel(ComputerToolsConfig::default()).0),
            hook: Arc::new(std::sync::RwLock::new(None)),
            served: Arc::new(std::sync::atomic::AtomicBool::new(false)),
        }
    }
}

impl ComputerToolsRuntimeConfig {
    pub fn new() -> Self {
        Self::default()
    }

    pub async fn snapshot(&self) -> ComputerToolsConfig {
        self.inner.read().await.clone()
    }

    pub async fn set(&self, mut cfg: ComputerToolsConfig) {
        let mut inner = self.inner.write().await;
        cfg.switched_off = inner.switched_off + u64::from(inner.enabled && !cfg.enabled);
        let before = std::mem::replace(&mut *inner, cfg.clone());
        // Under the write lock: no reader sees the new settings before the
        // hook has acted on them.
        if let Some(hook) = self.hook.read().unwrap_or_else(|p| p.into_inner()).as_ref() {
            hook(&before, &cfg);
        }
        // Published under the write lock, so watchers see changes in the order
        // they were made.
        self.changes.send_replace(cfg);
    }

    /// Run `hook` on every change, inside [`set`](Self::set) and before it
    /// returns, with the settings before and after. For what a change takes
    /// away, which must not wait for a watcher to be scheduled — nor be merged
    /// away when a second change follows before it is. It runs under the
    /// settings' write lock: it must not read them back through this handle.
    /// One hook; a second replaces the first.
    pub fn on_change(
        &self,
        hook: impl Fn(&ComputerToolsConfig, &ComputerToolsConfig) + Send + Sync + 'static,
    ) {
        *self.hook.write().unwrap_or_else(|p| p.into_inner()) = Some(Box::new(hook));
    }

    pub async fn is_enabled(&self) -> bool {
        self.inner.read().await.enabled
    }

    /// Note that this process serves computer use — a computer service has
    /// started: always in the desktop app, and in codeg-server where the
    /// person who runs it lets it share the screen it runs on. Until then
    /// the tools are offered to no agent, whatever the switch says.
    pub fn mark_served(&self) {
        self.served
            .store(true, std::sync::atomic::Ordering::Release);
    }

    /// See [`mark_served`](Self::mark_served).
    pub fn is_served(&self) -> bool {
        self.served.load(std::sync::atomic::Ordering::Acquire)
    }

    /// Whether starting applications and moving windows is offered: computer
    /// use on, and the person's own switch for it on.
    pub async fn is_launch_enabled(&self) -> bool {
        let config = self.inner.read().await;
        config.enabled && config.launch_enabled
    }

    /// Whether the clipboard tools are offered: computer use on, and the
    /// person's own switch for them on.
    pub async fn is_clipboard_enabled(&self) -> bool {
        let config = self.inner.read().await;
        config.enabled && config.clipboard_enabled
    }

    /// Every change from here on.
    pub fn subscribe(&self) -> tokio::sync::watch::Receiver<ComputerToolsConfig> {
        self.changes.subscribe()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::computer::types::GrantLevel;

    /// Every per-window refusal names the window, carries a slug the model
    /// can branch on, and says whether trying again is worth anything.
    #[test]
    fn refusals_name_the_window_and_the_next_step() {
        let note = grant_required_note("w7");
        assert!(note.contains("w7"));
        assert!(note.contains("Share a window"));
        assert!(note.contains("no point retrying"));

        let note = no_such_target_note("w9");
        assert!(note.contains("computer_list_windows"));

        let note = blocked_note("w3", "codeg's own window: it can never be shared.");
        assert!(note.contains("cannot be done"));

        let note = permission_missing_note("Screen Recording");
        assert!(note.contains("Privacy & Security → Screen Recording"));
        assert!(note.contains("retrying will not help"));
    }

    /// The payload and the refusal are exclusive on the wire, and the absent
    /// one is absent rather than null: the companion branches on which key
    /// is there.
    #[test]
    fn the_wire_carries_one_of_the_answer_and_the_refusal() {
        let refused = serde_json::to_value(ComputerCaptureOutcome::refused(
            "w1",
            ERROR_GRANT_REQUIRED,
            grant_required_note("w1"),
        ))
        .unwrap();
        assert_eq!(refused["targetId"], "w1");
        assert_eq!(refused["error"], ERROR_GRANT_REQUIRED);
        assert!(refused.get("capture").is_none());

        let listed = serde_json::to_value(ComputerWindowsOutcome {
            windows: vec![AgentWindowSummary {
                target_id: "w2".into(),
                app: crate::computer::types::AgentAppRef {
                    key: "com.apple.TextEdit".into(),
                    name: "TextEdit".into(),
                    pid: 42,
                },
                bounds: Default::default(),
                on_screen: true,
                minimized: None,
                hidden: None,
                whole_app: false,
                whole_screen: false,
                level: GrantLevel::None,
                title: None,
                note: None,
            }],
            screen: None,
            input: Some(InputPolicy::of(&ComputerToolsConfig::default())),
            error: None,
            note: None,
        })
        .unwrap();
        assert_eq!(listed["windows"][0]["targetId"], "w2");
        assert_eq!(listed["windows"][0]["level"], "none");
        assert!(listed["windows"][0].get("title").is_none());
        assert!(listed.get("error").is_none());
        // Out of the box: the background, with the front to be had for the
        // asking.
        assert_eq!(
            listed["input"],
            serde_json::json!({"default": "background", "foregroundAllowed": true})
        );
    }

    /// The front is the default only while the person allows it at all; the
    /// choice is kept for when they allow it again. The words that end a
    /// background refusal say which way it is.
    #[test]
    fn the_front_is_the_default_only_while_it_is_allowed() {
        let chosen = ComputerToolsConfig {
            allow_foreground: false,
            default_delivery: ActDelivery::Foreground,
            ..Default::default()
        };
        assert_eq!(chosen.default_delivery_in_force(), ActDelivery::Background);
        let allowed = ComputerToolsConfig {
            allow_foreground: true,
            ..chosen.clone()
        };
        assert_eq!(allowed.default_delivery_in_force(), ActDelivery::Foreground);
        assert_eq!(
            InputPolicy::of(&allowed),
            InputPolicy {
                default: ActDelivery::Foreground,
                foreground_allowed: true,
            }
        );
        assert!(background_next_step(true).contains("delivery: \"foreground\""));
        assert!(!background_next_step(false).contains("delivery: \"foreground\""));
        assert!(background_next_step(false).contains("ask them"));
    }

    #[tokio::test]
    async fn no_desktop_answers_unavailable_everywhere() {
        let none = NoComputerDesktop;
        assert_eq!(
            none.list_apps().await.error.as_deref(),
            Some(ERROR_UNAVAILABLE)
        );
        assert_eq!(
            none.list_windows(None).await.error.as_deref(),
            Some(ERROR_UNAVAILABLE)
        );
        assert_eq!(
            none.capture("w1", None).await.error.as_deref(),
            Some(ERROR_UNAVAILABLE)
        );
        assert_eq!(
            none.snapshot("w1", SnapshotRequest::default())
                .await
                .error
                .as_deref(),
            Some(ERROR_UNAVAILABLE)
        );
        assert_eq!(
            none.verify("w1", VerifyRequest::default())
                .await
                .error
                .as_deref(),
            Some(ERROR_UNAVAILABLE)
        );
    }

    #[tokio::test]
    async fn runtime_config_round_trips_and_announces_changes() {
        let cfg = ComputerToolsRuntimeConfig::new();
        let mut watcher = cfg.subscribe();
        assert!(!cfg.is_enabled().await);
        let on = ComputerToolsConfig {
            enabled: true,
            grant_ttl: Some(Duration::from_secs(1800)),
            blocklist: vec!["com.example.vault".into()],
            blocklist_removed: vec!["1password".into()],
            stop_shortcut: None,
            show_indicator: false,
            allow_foreground: true,
            default_delivery: ActDelivery::Foreground,
            launch_enabled: true,
            clipboard_enabled: true,
            screen_enabled: true,
            switched_off: 0,
        };
        cfg.set(on.clone()).await;
        assert!(cfg.is_launch_enabled().await);
        assert!(cfg.is_clipboard_enabled().await);
        assert!(cfg.is_enabled().await);
        assert_eq!(cfg.snapshot().await, on);
        watcher.changed().await.unwrap();
        assert_eq!(*watcher.borrow_and_update(), on);
    }

    /// Off and straight back on reaches a watcher as one change — and the off
    /// in it is still visible, because the count moved.
    #[tokio::test]
    async fn a_quick_off_and_on_still_counts_as_an_off() {
        let cfg = ComputerToolsRuntimeConfig::new();
        let on = ComputerToolsConfig {
            enabled: true,
            ..Default::default()
        };
        cfg.set(on.clone()).await;
        let mut watcher = cfg.subscribe();
        let before = watcher.borrow_and_update().switched_off;
        cfg.set(ComputerToolsConfig::default()).await;
        cfg.set(on.clone()).await;
        watcher.changed().await.unwrap();
        let seen = watcher.borrow_and_update().clone();
        assert!(seen.enabled);
        assert_eq!(seen.switched_off, before + 1);
        // Setting it off again while off is not another off.
        cfg.set(ComputerToolsConfig::default()).await;
        cfg.set(ComputerToolsConfig::default()).await;
        assert_eq!(cfg.snapshot().await.switched_off, before + 2);
    }

    /// The hook sees every change, one at a time and before `set` returns —
    /// including an add-then-remove that a watcher would only see the end of.
    #[tokio::test]
    async fn the_change_hook_sees_every_change_before_set_returns() {
        let cfg = ComputerToolsRuntimeConfig::new();
        let seen = Arc::new(std::sync::Mutex::new(Vec::new()));
        let log = seen.clone();
        cfg.on_change(move |before, after| {
            log.lock()
                .unwrap()
                .push((before.blocklist.clone(), after.blocklist.clone()));
        });
        let with = |blocklist: Vec<String>| ComputerToolsConfig {
            enabled: true,
            blocklist,
            ..Default::default()
        };
        cfg.set(with(vec!["com.example.vault".into()])).await;
        assert_eq!(seen.lock().unwrap().len(), 1);
        cfg.set(with(vec![])).await;
        assert_eq!(
            *seen.lock().unwrap(),
            vec![
                (vec![], vec!["com.example.vault".to_string()]),
                (vec!["com.example.vault".to_string()], vec![]),
            ]
        );
    }
}
