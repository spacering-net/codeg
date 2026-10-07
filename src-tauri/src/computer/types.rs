//! Wire types for computer use: what an agent is told about the desktop, and
//! what it gets back from a read.
//!
//! camelCase on the wire, like everything the browser tools send, so `targetId`
//! means the same thing in a listing, in a refusal and in the frontend's
//! mirror of these types (`src/lib/computer/types.ts`).
//!
//! Compiled in both runtimes: the codeg-mcp plumbing that carries these is
//! shared code, and server mode has to be able to say "no desktop here" in the
//! same shapes.

use serde::{Deserialize, Serialize};

pub use crate::browser::agent::GrantLevel;

fn not_shared(level: &GrantLevel) -> bool {
    *level == GrantLevel::None
}

/// A rectangle in the platform's desktop coordinate space: points on macOS,
/// physical pixels on Windows, X11 pixels on Linux — whatever the platform
/// reports window bounds in. Never mixed with screenshot pixels: a capture
/// carries its own `width` / `height` and the window bounds it was taken of,
/// so the two spaces stay separate values rather than one number read two
/// ways.
#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl Rect {
    /// Whether this rectangle has an area. A window the platform reports at
    /// zero size is not one a person could have meant to share, and has
    /// nothing a capture could show.
    pub fn is_empty(&self) -> bool {
        !(self.width > 0.0 && self.height > 0.0)
    }
}

/// The application a window belongs to, as an agent may name it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentAppRef {
    /// The stable name of the application: its bundle identifier on macOS,
    /// its executable path elsewhere. What a blocklist entry matches.
    pub key: String,
    /// What the application calls itself, for a person to recognise.
    pub name: String,
    pub pid: u32,
}

/// One running application, as `computer_list_apps` reports it.
///
/// Not behind a grant: which applications are running is what is on the
/// desktop, not what any of them shows. The group switch is what decides
/// whether an agent may ask at all.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentAppSummary {
    #[serde(flatten)]
    pub app: AgentAppRef,
    /// Whether it is the frontmost application.
    pub active: bool,
    /// What it is shared for as a whole application — every window of it,
    /// its menus and its own shortcuts — when the user shared it so.
    #[serde(default, skip_serializing_if = "not_shared")]
    pub level: GrantLevel,
    /// Why none of its windows can be shared, when that is so — codeg itself,
    /// or an application on the blocklist.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

/// One native window, as `computer_list_windows` reports it.
///
/// A listing exists so an agent can *name* a window — to read it, or to ask
/// the user to share it — which is why it is not itself behind a grant. What
/// it carries is bounded by that purpose.
///
/// The title is the exception, for the same reason the browser withholds a
/// tab's: it is chosen by the application and is the first line of its
/// content. A mail client's window called "Re: termination letter" hands over
/// exactly what the grant exists to withhold. So it appears only once the
/// window is readable, when the agent could have read the whole window anyway
/// and is merely saved a round trip.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentWindowSummary {
    /// codeg's own name for this window. Stable for as long as the window and
    /// the process that owns it are the same ones; a new process — even the
    /// same application relaunched — gets a new id.
    pub target_id: String,
    pub app: AgentAppRef,
    pub bounds: Rect,
    pub on_screen: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub minimized: Option<bool>,
    /// Its application is hidden (macOS ⌘H): off the screen as a whole,
    /// with nothing of the window's own changed.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hidden: Option<bool>,
    pub level: GrantLevel,
    /// Shared with its whole application: its menus and its own shortcuts
    /// are in reach too.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub whole_app: bool,
    /// Shared with the entire screen: its application's menus, and the
    /// desktop's own shortcuts but locking and logging out, are in reach too.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub whole_screen: bool,
    /// Present only from [`GrantLevel::Read`] upwards.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    /// Why this window cannot be shared, when that is so.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

/// The entire screen in a listing, while the user shares it as a whole: a
/// target of its own (`targets::SCREEN_TARGET_ID`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentScreen {
    pub target_id: String,
    pub level: GrantLevel,
}

/// A screenshot of one shared window.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowCapture {
    pub target_id: String,
    /// Names this capture: `<grant epoch>.<read number>`. Coordinates read
    /// off this image mean something only in this image's pixel space, and
    /// the actions that arrive later will carry the generation of the image
    /// their coordinates came from.
    pub generation: String,
    /// `image/png`.
    pub mime: String,
    /// The image, base64.
    pub data: String,
    /// The image's size in pixels — the space coordinates read off it are in.
    pub width: u32,
    pub height: u32,
    /// Where the window was when it was captured, in desktop coordinates.
    pub window_bounds: Rect,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
}

/// An accessibility snapshot of one shared window.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowSnapshot {
    pub target_id: String,
    /// See [`WindowCapture::generation`].
    pub generation: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub window_bounds: Option<Rect>,
    /// The tree, as indented text, one element per line.
    pub tree: String,
    /// How many actionable elements the driver found, before any cut.
    pub element_count: u64,
    /// The tree was cut short, by `maxChars` or by the driver's own bounds.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub truncated: bool,
    /// Why the tree is empty or partial when the window is not (a canvas, a
    /// window whose accessibility surface the driver could not resolve), in
    /// the driver's words.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub degraded: Option<String>,
}

/// One predicate `computer_verify` checks against a shared window. The
/// driver ANDs them.
///
/// A closed set: every field the agent may send is named here, and the
/// request is rebuilt from these types before it reaches the driver, so
/// nothing the agent writes is forwarded as-is.
///
/// There is deliberately no "value equals" predicate yet. A yes / no answer
/// about a field's value is a way to read that value one guess at a time, and
/// the fields worth guessing at are the secure ones the snapshot refuses to
/// show; the check that makes it safe (refusing selectors that can match a
/// secure field) comes with the action tools.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VerifyPredicate {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub window: Option<WindowPredicate>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub element: Option<ElementPredicate>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WindowPredicate {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exists: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bounds: Option<BoundsPredicate>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BoundsPredicate {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tolerance_px: Option<f64>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ElementPredicate {
    pub selector: ElementSelector,
    /// Only `true`: absence cannot be proven on every platform, and the
    /// driver refuses `false` rather than answer "unknown" forever.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exists: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub selected: Option<bool>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ElementSelector {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label_contains: Option<String>,
}

/// The largest number of predicates one `computer_verify` may carry — the
/// driver's own bound, checked here so the agent is told in our words.
pub const MAX_VERIFY_PREDICATES: usize = 8;

/// What `computer_verify` asks for.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VerifyRequest {
    pub expect: Vec<VerifyPredicate>,
    /// How long to keep sampling, in milliseconds. Zero samples once.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeout_ms: Option<u32>,
    /// How many consecutive satisfied samples count as success.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stable_samples: Option<u32>,
}

/// A predicate's answer, or the whole check's.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum VerifyStatus {
    Satisfied,
    Unsatisfied,
    /// Could not be decided. Never a success: an agent that reads "unknown"
    /// as "probably fine" is exactly the failure this tool exists to prevent.
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PredicateResult {
    pub index: u32,
    pub status: VerifyStatus,
    /// Why a predicate is `unknown`, in the driver's vocabulary
    /// (`target_missing`, `stability_unproven`, …).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unknown_reason: Option<String>,
}

/// What `computer_verify` answers.
///
/// Carries no observed values, only verdicts: the point of the tool is to
/// answer "is it so yet" without handing back what is on the screen.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VerifyOutcome {
    pub target_id: String,
    pub status: VerifyStatus,
    pub stable: bool,
    pub samples: u64,
    pub elapsed_ms: u64,
    pub predicates: Vec<PredicateResult>,
}

// -------- Acting on a window ----------------------------------------------

/// An element of the window's latest snapshot: the `generation` that snapshot
/// handed out, and the element's ref — the number in `[N]` at the start of
/// its line.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ElementTarget {
    pub generation: String,
    #[serde(rename = "ref")]
    pub index: u32,
}

/// A point in the window's latest screenshot, in that image's pixels, with
/// the `generation` it handed out. Only that image's pixel space is meant:
/// the same numbers read off another capture are another point.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PointTarget {
    pub generation: String,
    pub x: f64,
    pub y: f64,
}

/// Where a pointer action lands.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "at", rename_all = "camelCase")]
pub enum AgentTarget {
    Element(ElementTarget),
    Point(PointTarget),
}

impl AgentTarget {
    pub fn generation(&self) -> &str {
        match self {
            AgentTarget::Element(e) => &e.generation,
            AgentTarget::Point(p) => &p.generation,
        }
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PointerButton {
    #[default]
    Left,
    Right,
    Middle,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ScrollDirection {
    Up,
    Down,
    Left,
    Right,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ScrollUnit {
    #[default]
    Line,
    Page,
}

/// The most text one `computer_type` or `computer_set_value` carries.
pub const MAX_ACTION_TEXT_CHARS: usize = 10_000;

/// The most times one `computer_press_key` presses its key.
pub const MAX_KEY_REPEAT: u32 = 20;

/// The most wheel notches (or keystrokes) one `computer_scroll` sends.
pub const MAX_SCROLL_AMOUNT: u32 = 25;

/// The longest a drag's path may take, the driver's own bound.
pub const MAX_DRAG_MS: u32 = 10_000;

/// The longest one `computer_hold_key` holds its key. Each press takes its
/// own turn at the driver, so other calls go in between; the bound is on how
/// long one call keeps pressing.
pub const MAX_HOLD_MS: u32 = 10_000;

fn no_modifiers(modifiers: &crate::computer::keys::Modifiers) -> bool {
    modifiers.is_empty()
}

/// What an agent asks to do to one shared window. A closed set, rebuilt field
/// by field on its way to the driver, like the verify predicates.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ComputerActRequest {
    /// Click an element, or a point. `count` is 1 or 2 (a double click, left
    /// button only). `modifiers` are held down for the click.
    #[serde(rename_all = "camelCase")]
    Click {
        target: AgentTarget,
        #[serde(default)]
        button: PointerButton,
        count: u8,
        #[serde(default, skip_serializing_if = "no_modifiers")]
        modifiers: crate::computer::keys::Modifiers,
    },
    /// Press at one point of the window's latest screenshot, move to another
    /// and let go — with `modifiers` held for the whole of it. `duration_ms`
    /// is how long the path takes.
    #[serde(rename_all = "camelCase")]
    Drag {
        from: PointTarget,
        to: PointTarget,
        #[serde(default)]
        button: PointerButton,
        #[serde(default, skip_serializing_if = "no_modifiers")]
        modifiers: crate::computer::keys::Modifiers,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        duration_ms: Option<u32>,
    },
    /// Scroll at an element or a point — or, with no target, whatever has
    /// focus in the window.
    #[serde(rename_all = "camelCase")]
    Scroll {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        target: Option<AgentTarget>,
        direction: ScrollDirection,
        amount: u32,
        #[serde(default)]
        unit: ScrollUnit,
    },
    /// Type text into an element; `submit` presses return after it.
    #[serde(rename_all = "camelCase")]
    Type {
        target: ElementTarget,
        text: String,
        #[serde(default)]
        submit: bool,
    },
    /// Press a key, `repeat` times, on an element or on whatever has focus.
    #[serde(rename_all = "camelCase")]
    Key {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        target: Option<ElementTarget>,
        chord: crate::computer::keys::Chord,
        repeat: u32,
    },
    /// Hold a key down for `duration_ms`, as a held key repeats: pressed,
    /// then — after the system's usual delay — again and again until the
    /// time is up. On an element or on whatever has focus.
    #[serde(rename_all = "camelCase")]
    HoldKey {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        target: Option<ElementTarget>,
        chord: crate::computer::keys::Chord,
        duration_ms: u32,
    },
    /// Set an element's value outright — a text field's text, a slider's
    /// position, a pop-up menu's choice.
    #[serde(rename_all = "camelCase")]
    SetValue { target: ElementTarget, value: String },
    /// Put a window back on the screen — out of the Dock or the taskbar if it
    /// is minimized, its application shown again if it is hidden: typing,
    /// keys, scrolling, a point and a screenshot all need it there.
    Restore,
    /// Choose a command from the application's menus, by the titles on the
    /// way to it: `["File", "Export", "PDF…"]`. The application's own, so
    /// only for an application shared as a whole.
    #[serde(rename_all = "camelCase")]
    InvokeMenu { path: Vec<String> },
    /// Move and size the window, in desktop units as listings give a
    /// window's bounds; what is left out stays as it is.
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

/// The smallest a window may be made, either way, in desktop units.
pub const MIN_WINDOW_SIDE: f64 = 50.0;

/// The largest a window may be made, either way, and the furthest from the
/// desktop's origin it may be put.
pub const MAX_WINDOW_EXTENT: f64 = 100_000.0;

impl ComputerActRequest {
    /// Whether the action is one the person allows only with "Let agents
    /// open applications and move their windows" on: it changes where the
    /// person's own windows are.
    pub fn needs_launch_switch(&self) -> bool {
        matches!(self, Self::SetFrame { .. })
    }

    /// Whether the window can be brought to the front for this action
    /// ([`ActDelivery::Foreground`]). A value is set through the
    /// application's accessibility interface, which no window has to be in
    /// front for, and a restore is codeg's own call: those two only ever go
    /// in the background.
    pub fn can_come_forward(&self) -> bool {
        matches!(
            self,
            Self::Click { .. }
                | Self::Drag { .. }
                | Self::Scroll { .. }
                | Self::Type { .. }
                | Self::Key { .. }
                | Self::HoldKey { .. }
        )
    }

    /// Whether the action can be done at all only by bringing the window to
    /// the front on `platform`: restoring a window on Linux, where the only
    /// way back is the window manager's activation; and a menu command,
    /// which the drivers choose with the application active.
    pub fn needs_front(&self, platform: crate::computer::keys::Platform) -> bool {
        match self {
            Self::Restore => platform == crate::computer::keys::Platform::Linux,
            Self::InvokeMenu { .. } => true,
            _ => false,
        }
    }
}

/// How far the driver can vouch for an action it carried out.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ActEffect {
    /// Read back from the window: the value changed, the selection moved.
    Confirmed,
    /// Only part of it happened (some of the text was typed).
    Partial,
    /// Delivered, and nothing could be read back to prove it landed. Not a
    /// failure and not a success: look at the window to know.
    Unverifiable,
    /// Delivered, and by every sign it did nothing.
    SuspectedNoop,
}

/// How an action reached the application — not the same click by every
/// route: a semantic accessibility action does not move the pointer or fire
/// hover, a synthesized event does.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ActRoute {
    Accessibility,
    SyntheticEvents,
    GlobalInput,
    SystemApi,
    Dom,
    TrustedInput,
    /// A route this codeg does not know by name.
    #[serde(other)]
    Other,
}

/// How the input reaches the window.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ActDelivery {
    /// The window is not brought to the front, and the person's own pointer
    /// and keyboard focus stay where they are.
    #[default]
    Background,
    /// The window is brought to the front for the one action, which then
    /// goes in as real input, and the window the person was in is brought
    /// back after it. Some applications take keys and typing no other way —
    /// on Windows, every one built on Chromium. Only where the person has
    /// allowed it in the settings.
    Foreground,
}

impl ActDelivery {
    /// The driver's word for it (`delivery_mode`).
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Background => "background",
            Self::Foreground => "foreground",
        }
    }
}

/// What one action on a shared window did.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActReport {
    pub target_id: String,
    pub effect: ActEffect,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub route: Option<ActRoute>,
    pub delivery: ActDelivery,
    /// For a key pressed more than once: how many presses went out.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub presses: Option<u32>,
    /// For typing with `submit`: whether return was pressed after it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub submitted: Option<bool>,
    /// For typing with `submit` whose return was not pressed: why.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub submit_note: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    /// An action request is a closed shape too: a target that is neither an
    /// element nor a point, or a field nobody named, does not parse.
    #[test]
    fn an_action_request_is_a_closed_shape() {
        let click: ComputerActRequest = serde_json::from_value(serde_json::json!({
            "kind": "click",
            "target": { "kind": "point", "at": { "generation": "2.4", "x": 10.5, "y": 20 } },
            "count": 1
        }))
        .unwrap();
        assert_eq!(
            click,
            ComputerActRequest::Click {
                target: AgentTarget::Point(PointTarget {
                    generation: "2.4".into(),
                    x: 10.5,
                    y: 20.0
                }),
                button: PointerButton::Left,
                count: 1,
                modifiers: Default::default(),
            }
        );
        let typed: ComputerActRequest = serde_json::from_value(serde_json::json!({
            "kind": "type",
            "target": { "generation": "2.5", "ref": 7 },
            "text": "hello"
        }))
        .unwrap();
        assert!(matches!(typed, ComputerActRequest::Type { submit: false, .. }));
        let restore: ComputerActRequest =
            serde_json::from_value(serde_json::json!({ "kind": "restore" })).unwrap();
        assert_eq!(restore, ComputerActRequest::Restore);
        let drag: ComputerActRequest = serde_json::from_value(serde_json::json!({
            "kind": "drag",
            "from": { "generation": "2.4", "x": 1, "y": 2 },
            "to": { "generation": "2.4", "x": 30, "y": 40 },
            "modifiers": { "shift": true }
        }))
        .unwrap();
        assert!(matches!(
            drag,
            ComputerActRequest::Drag { modifiers, duration_ms: None, .. } if modifiers.shift
        ));
        let hold: ComputerActRequest = serde_json::from_value(serde_json::json!({
            "kind": "holdKey",
            "chord": { "key": "right" },
            "durationMs": 1500
        }))
        .unwrap();
        assert!(matches!(
            hold,
            ComputerActRequest::HoldKey {
                target: None,
                duration_ms: 1500,
                ..
            }
        ));
        for bad in [
            serde_json::json!({ "kind": "click", "target": { "kind": "desktop" }, "count": 1 }),
            serde_json::json!({ "kind": "click", "count": 1, "target": { "kind": "element",
                                "at": { "generation": "1.1", "ref": 1, "x": 3 } } }),
            serde_json::json!({ "kind": "type", "target": { "generation": "1.1", "ref": 1,
                                "selector": "#pw" }, "text": "x" }),
            serde_json::json!({ "kind": "launch", "app": "Terminal" }),
        ] {
            assert!(
                serde_json::from_value::<ComputerActRequest>(bad.clone()).is_err(),
                "{bad}"
            );
        }
    }

    /// The predicate types are the whitelist: a field the agent invents is a
    /// parse error, not something that rides along to the driver.
    #[test]
    fn a_predicate_with_a_field_nobody_named_does_not_parse() {
        let known: VerifyPredicate = serde_json::from_value(serde_json::json!({
            "element": { "selector": { "role": "AXButton", "labelContains": "Save" },
                         "exists": true }
        }))
        .expect("a named shape parses");
        assert_eq!(
            known.element.unwrap().selector.label_contains.as_deref(),
            Some("Save")
        );

        for invented in [
            serde_json::json!({ "element": { "selector": {}, "valueEquals": "hunter2" } }),
            serde_json::json!({ "desktop": { "exists": true } }),
            serde_json::json!({ "element": { "selector": { "xpath": "//*" } } }),
        ] {
            assert!(
                serde_json::from_value::<VerifyPredicate>(invented.clone()).is_err(),
                "{invented}"
            );
        }
    }

    #[test]
    fn a_zero_sized_rectangle_is_empty() {
        assert!(Rect::default().is_empty());
        assert!(Rect {
            x: 10.0,
            y: 10.0,
            width: 0.0,
            height: 30.0
        }
        .is_empty());
        assert!(!Rect {
            x: -5.0,
            y: 0.0,
            width: 1.0,
            height: 1.0
        }
        .is_empty());
    }
}
