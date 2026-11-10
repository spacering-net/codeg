//! Page → host channel: the helper script (`src/browser-injected/helper.js`)
//! runs in an isolated world and posts JSON envelopes through a native
//! message handler; this module validates and routes them. The element picker
//! (`picker.js`), evaluated into the same world on demand, reports through the
//! same channel. Everything that arrives here is page-controlled input: sizes
//! are capped, unknown kinds are dropped, and gestures are forwarded to the
//! frontend flagged `untrusted`.

use std::sync::Arc;

use serde::Deserialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager, Url};

use crate::web::event_bridge::{emit_event, EventEmitter};

use super::agent;
use super::console;
use super::events;
use super::handoff;
use super::hooks;
use super::registry::BrowserRegistry;
use super::types::ChannelKind;

pub const HELPER_JS: &str = include_str!("../../../src/browser-injected/helper.js");

/// The page-world console shim (`src/browser-injected/console.js`), for the
/// engines that report a page's console to nobody. Injected into the PAGE
/// world — the one script here that is — at document start in every frame;
/// the file's header says why that is safe and what it makes the lines worth
/// (data the page chose to print, never more).
#[cfg(any(target_os = "macos", target_os = "linux"))]
pub const CONSOLE_JS: &str = include_str!("../../../src/browser-injected/console.js");

/// The helper for an engine that reports the console to the host itself
/// (WebView2, over CDP): told so before it runs, in its own world, so it does
/// not also relay the page's lines and listen for its errors — the same line
/// would otherwise arrive twice, once from the engine and once from here.
#[cfg(target_os = "windows")]
pub const HELPER_JS_ENGINE_CONSOLE: &str = concat!(
    "globalThis.__codegEngineConsole = true;\n",
    include_str!("../../../src/browser-injected/helper.js")
);
pub const MAX_MESSAGE_BYTES: usize = 64 * 1024;
pub const TELEMETRY_EVENT: &str = "browser://telemetry";

/// `(message, is_main_frame, source webview pointer)`. The pointer identifies
/// the webview the message came from: a popup created from an opener shares
/// the opener's user-content controller (and therefore its message handler),
/// so the handler cannot be bound to one tab.
pub type MessageSink = Arc<dyn Fn(String, bool, usize) + Send + Sync>;

/// Defines the send primitive the helper calls; injected before the helper,
/// in the same world, so the page never sees either. WebKit spells the message
/// handler the same way on both its ports, so macOS and Linux share this.
#[cfg(any(target_os = "macos", target_os = "linux"))]
pub const PREFIX_SCRIPT: &str = "globalThis.__codegSend = function (m) { window.webkit.messageHandlers.codegBrowser.postMessage(String(m)); };";

/// The same primitive for a SUBFRAME's copy of the helper, posting through a
/// handler the host treats as non-main-frame (Linux only — macOS learns the
/// frame from the engine and needs one handler).
///
/// Both scripts run in the top frame, so this one asks whether it IS the top
/// frame and leaves the privileged primitive alone there. Asking rather than
/// testing whether one is already set: which of the two runs first is the
/// engine's business, and a tab whose own page reported itself as a subframe
/// would lose its address bar and never say hello.
#[cfg(target_os = "linux")]
pub const FRAME_PREFIX_SCRIPT: &str = "if (window.top !== window) { globalThis.__codegSend = function (m) { window.webkit.messageHandlers.codegBrowserFrame.postMessage(String(m)); }; }";

#[derive(Debug, Deserialize)]
pub struct Envelope {
    pub kind: String,
    #[serde(default)]
    pub payload: Value,
    /// Set by the helper when it runs in the top-level browsing context.
    #[serde(default)]
    pub top: bool,
}

pub fn parse_envelope(raw: &str) -> Option<Envelope> {
    if raw.len() > MAX_MESSAGE_BYTES {
        return None;
    }
    serde_json::from_str::<Envelope>(raw).ok()
}

pub fn handle_message(app: &AppHandle, tab_id: &str, raw: String, main_frame: bool) {
    let Some(envelope) = parse_envelope(&raw) else {
        tracing::warn!(
            "[browser] tab {tab_id}: dropped malformed or oversized channel message ({} bytes)",
            raw.len()
        );
        return;
    };
    let Some(registry) = app.try_state::<BrowserRegistry>() else {
        return;
    };
    match envelope.kind.as_str() {
        "hello" => {
            if !(main_frame && envelope.top) {
                return;
            }
            let state = registry.update_state(tab_id, |state| {
                if state.channel != ChannelKind::Legacy {
                    state.channel = ChannelKind::Native;
                }
                // The helper is talking, so whatever the install reported is
                // no longer the tab's condition.
                state.channel_error = None;
            });
            if let Some(state) = state {
                events::emit_state(app, &state);
            }
        }
        "nav-state" => {
            if !(main_frame && envelope.top) {
                return;
            }
            let href = envelope
                .payload
                .get("href")
                .and_then(Value::as_str)
                .and_then(|h| Url::parse(h).ok());
            let title = envelope
                .payload
                .get("title")
                .and_then(Value::as_str)
                .map(str::to_string);
            let changed = registry.update(tab_id, |tab| {
                let mut changed = false;
                let mut lost = None;
                if let Some(url) = &href {
                    let text = url.to_string();
                    if tab.state.url != text {
                        tab.state.url = text;
                        tab.state.origin = hooks::origin_of(url);
                        // The document did not change, so the world kept its
                        // generation and every ref it handed out still names
                        // a live element — of the page the agent is no longer
                        // looking at. This is the transition the host exists
                        // to notice; see `agent::epoch` for how late it can
                        // be. The re-check cannot widen a grant, only end
                        // one, which is why it is safe to drive from a
                        // message the page could in principle influence.
                        tab.nav_epoch += 1;
                        lost = agent::revoke_if_departed(&mut tab.state);
                        changed = true;
                    }
                }
                if let Some(title) = title {
                    if tab.state.title != title {
                        tab.state.title = title;
                        changed = true;
                    }
                }
                changed.then(|| (tab.state.clone(), lost))
            });
            if let Some(Some((state, lost))) = changed {
                events::emit_state(app, &state);
                if let Some(lost) = lost {
                    events::emit_agent_grant(
                        app,
                        tab_id,
                        agent::GrantChange::Navigated,
                        agent::GrantLevel::None,
                        Some(&lost.origin),
                    );
                }
            }
        }
        // A browser shortcut the page had focus for. The set is closed here,
        // not in the page: whatever the helper claims, only a name from this
        // list reaches the frontend, and it carries nothing else.
        //
        // Deliberately NOT gated on the main frame, unlike `hello` and
        // `nav-state`: a keystroke is delivered only to the frame that holds
        // focus, so gating would make ⌘F dead whenever the caret is inside an
        // iframe. The tab id comes from the source webview, not from the
        // payload, so a subframe still cannot speak for another tab.
        "shortcut" => {
            let name = envelope.payload.get("name").and_then(Value::as_str);
            if name == Some("find") {
                events::emit_shortcut(app, tab_id, "find");
            }
        }
        "gesture" => {
            registry.push_gesture(tab_id, envelope.payload.clone());
            emit_event(
                &EventEmitter::Tauri(app.clone()),
                TELEMETRY_EVENT,
                json!({
                    "tabId": tab_id,
                    "kind": "gesture",
                    "untrusted": true,
                    "mainFrame": main_frame,
                    "top": envelope.top,
                    "payload": envelope.payload,
                }),
            );
        }
        // What the page printed: relayed by the helper on WebKit, translated
        // from the engine's own report on WebView2 (the shim builds the same
        // envelope). Taken from any frame — an iframe's errors are part of
        // the page — with the origin it came from derived here, from the
        // address the helper read in its own world, so that a read can hold
        // each line against the grant. `top` needs the engine's word AND the
        // helper's, like `nav-state`: a subframe cannot claim the top by
        // saying so.
        "console" => {
            let origin = envelope
                .payload
                .get("href")
                .and_then(Value::as_str)
                .and_then(|h| Url::parse(h).ok())
                .and_then(|u| hooks::origin_of(&u));
            let at = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis() as i64)
                .unwrap_or_default();
            match console::parse_reported(&envelope.payload, main_frame && envelope.top, at, origin.clone())
            {
                Some(line) => {
                    if registry.push_console(tab_id, line) {
                        // The first error of this document. Said once, so the
                        // control that offers to hand the console to a
                        // conversation can mark the tab without polling a page
                        // nobody is looking at. The matching `false` comes from
                        // `hooks::page_load`, where the ring is cleared.
                        events::emit_console_errors(app, tab_id, true);
                    }
                }
                // No line, only a count: the helper flushing what it dropped
                // after a burst that ended in silence.
                None => {
                    let count = console::reported_drop(&envelope.payload);
                    if count > 0 {
                        registry.note_console_dropped(tab_id, origin.as_deref(), count);
                    }
                }
            }
        }
        // The element a person pointed at, from the picker the host armed on
        // this tab (`handoff::install_and_pick`). Only the top frame's, and
        // only for the pick the tab is still waiting on: the picker is
        // evaluated into the main frame's isolated world, so a report from
        // anywhere else is not one of ours, and a token the tab no longer
        // expects belongs to a pick already abandoned.
        "pick" => {
            if !(main_frame && envelope.top) {
                return;
            }
            if let Some(report) = handoff::parse_pick(&envelope.payload) {
                registry.resolve_pick(tab_id, report);
            }
        }
        other => {
            tracing::debug!("[browser] tab {tab_id}: ignored channel message kind {other:?}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn envelope_parsing_is_strict_about_size_and_shape() {
        let ok = parse_envelope(r#"{"kind":"hello","payload":{"href":"x"},"top":true}"#).unwrap();
        assert_eq!(ok.kind, "hello");
        assert!(ok.top);
        let minimal = parse_envelope(r#"{"kind":"gesture"}"#).unwrap();
        assert!(!minimal.top);
        assert!(minimal.payload.is_null());
        assert!(parse_envelope("not json").is_none());
        assert!(parse_envelope(r#"{"payload":{}}"#).is_none());
        let huge = format!(r#"{{"kind":"x","payload":"{}"}}"#, "a".repeat(MAX_MESSAGE_BYTES));
        assert!(parse_envelope(&huge).is_none());
    }

    #[test]
    fn helper_is_bundled_and_self_contained() {
        assert!(HELPER_JS.contains("codegBrowserHelper"));
        assert!(!HELPER_JS.contains("import "));
        assert!(!HELPER_JS.contains("require("));
    }
}
