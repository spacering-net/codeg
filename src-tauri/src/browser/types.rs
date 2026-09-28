//! Wire types for the built-in browser. `src/lib/browser/types.ts` mirrors
//! these one to one; both sides use camelCase field names and kebab-case enum
//! values.

use serde::{Deserialize, Serialize};

/// Which concrete surface renders a tab.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SurfaceKind {
    /// wry child webview embedded in the owner window (macOS / Windows).
    Child,
    /// Owned top-level window (`WebviewWindowBuilder::parent`).
    Window,
}

/// What a tab shows: a web page, or a local HTML document served through the
/// `codeg-doc:` guest (see `doc_guest`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "kebab-case")]
pub enum TabKind {
    #[default]
    Page,
    Document,
}

/// How the page ↔ host channel was installed for a tab.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ChannelKind {
    /// Isolated-world helper + native message handler.
    Native,
    /// Installation failed; only navigation interception is available.
    Degraded,
    /// Platform too old for isolated worlds (macOS < 11); page-world helper.
    Legacy,
}

/// Placement of the surface inside the owner window, in logical pixels — the
/// same unit `getBoundingClientRect()` reports (the workspace content area is
/// the whole window and the app's zoom changes the root font size, not the
/// webview scale).
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Bounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum BrowserErrorKind {
    Dns,
    Tls,
    Blocked,
    Failed,
    PopupDenied,
    /// A remote tab's page (`browser::remote`): nothing listens on that port
    /// on the remote host.
    RemoteRefused,
    /// A remote tab's page: the remote host cannot reach that address (no
    /// route to it, or no such name there).
    RemoteUnreachable,
    /// A remote tab's page: the remote server's policy keeps its tunnel off
    /// that address (`CODEG_BROWSER_TUNNEL=private`).
    RemoteNotAllowed,
    /// A remote tab's page: the remote host did not get through in time.
    RemoteTimeout,
    /// A remote tab's page: the tunnel to the remote host is down.
    TunnelDown,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserErrorInfo {
    pub kind: BrowserErrorKind,
    pub message: String,
    pub url: Option<String>,
}

/// Everything the toolbar / status layer renders for one tab. Emitted in full
/// on every change (`browser://state`); the frontend keeps it in a store keyed
/// by `tab_id` rather than inside the workspace tab record.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserTabState {
    pub tab_id: String,
    /// Label of the window the tab belongs to (`main`, `remote-workspace-*`).
    pub owner_window: String,
    pub kind: TabKind,
    pub surface: SurfaceKind,
    pub channel: ChannelKind,
    /// Why the page channel could not be installed, in the engine's own words.
    /// `None` while the channel is fine — and also while it is merely still
    /// coming up, which is what `channel: degraded` means until the helper's
    /// `hello` arrives. A tab with this set stays degraded for good.
    pub channel_error: Option<String>,
    /// Last committed URL.
    pub url: String,
    /// URL the last navigation was asked for (differs from `url` while loading
    /// or after a redirect).
    pub requested_url: String,
    pub title: String,
    pub favicon: Option<String>,
    pub loading: bool,
    pub can_go_back: bool,
    pub can_go_forward: bool,
    pub origin: Option<String>,
    pub zoom: f64,
    pub error: Option<BrowserErrorInfo>,
    /// Set when the tab's traffic egresses through a remote workspace host.
    pub remote_host: Option<String>,
    /// For a tab adopted from a page-initiated new-window request: the tab
    /// whose page opened it (that page keeps a live `window.opener`).
    pub opener_tab_id: Option<String>,
    /// The browser profile (cookie jar, storage) the tab lives in; a popup
    /// shares its opener's. `None` for a document guest, whose store dies
    /// with it.
    pub profile: Option<String>,
    /// What an agent may do with this tab, if a person has shared it. `None`
    /// is the default and the resting state — see `agent`. It rides on the
    /// tab's state rather than in a store of its own so that the code which
    /// notices a tab changed origin is the code that revokes.
    pub agent_grant: Option<crate::browser::agent::AgentGrant>,
}

/// Answer to `browser_capabilities`: what this build on this machine can do.
///
/// Desktop-only, unlike the rest of this file: it quotes the proxy and policy
/// status types, which are themselves about a webview this process owns. The
/// question it answers — "what can the built-in browser do here?" — has no
/// meaning in a runtime that has no built-in browser.
#[cfg(feature = "tauri-runtime")]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserCapabilities {
    pub available: bool,
    pub surface: Option<SurfaceKind>,
    pub platform: String,
    pub channel: ChannelKind,
    /// Human-readable reasons behind a degraded answer (for diagnostics UI).
    pub reasons: Vec<String>,
    /// Browsing data lives apart from the app's own web storage.
    pub isolated_storage: bool,
    pub proxy: crate::browser::profile::BrowserProxyStatus,
    /// Where a page's downloads land, for the settings section.
    pub downloads_dir: String,
    /// The administrator's policy in force (rules shown read-only, and
    /// whether the browser is enabled at all).
    pub policy: crate::browser::policy::BrowserPolicyStatus,
    /// Local HTML files can be shown through the `codeg-doc:` document guest
    /// (an embedded surface with a handler for that scheme).
    pub doc_guest: bool,
    /// More than the default browser profile can exist (macOS 14+, Windows,
    /// Linux); the settings offer to create, clear and delete them.
    pub profiles: bool,
    /// Tabs present the sign-in user agent to Google's sign-in hosts when the
    /// preference is on (needs a navigation hook: the embedded tabs' delegate,
    /// or the owned window's navigation decision on Linux).
    pub sign_in_user_agent: bool,
    /// A tab shown in an owned window still answers find, history, stop and
    /// snapshots, and its page still talks to the host. True where the owned
    /// window is the surface the platform shim is written for (Linux); false
    /// where it is the fallback and the host does not hold its webview.
    pub owned_window_controls: bool,
    /// A remote-workspace window's tabs can reach the remote host through
    /// its codeg-server (`browser::remote`): a profile of their own to proxy
    /// (macOS 14+), and on macOS the embedded surface. Whether a given remote
    /// server carries the traffic is only known when a tab asks.
    pub remote_egress: bool,
}

/// The last frame of a page, handed back by `browser_set_visible` when the
/// frontend hides a surface under an overlay: the placeholder paints it so
/// the page does not vanish while a dialog or menu is open over it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FrozenFrame {
    /// `image/jpeg`.
    pub mime: String,
    /// Base64 of the encoded image.
    pub data: String,
    pub width: u32,
    pub height: u32,
}

/// Caller's surface preference for `browser_open_tab`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "kebab-case")]
pub enum SurfaceChoice {
    #[default]
    Auto,
    Child,
    Window,
}

/// How every block the built-in browser hands a conversation opens (the
/// renderers in `handoff` start with it). In the shared module because blocks
/// are recognized by it in both runtimes: a remote workspace's server projects
/// the prompts a desktop's browser sent (`acp::types::project_user_prompt_block`),
/// and the transcript names a badge from it (`src/lib/browser/page-handoff-block.ts`).
pub const HANDOFF_BLOCK_HEADER: &str = "Captured from a web page in the built-in browser";

pub const STATE_EVENT: &str = "browser://state";
pub const CLOSED_EVENT: &str = "browser://closed";
pub const POPUP_EVENT: &str = "browser://popup";
/// Backend → frontend: please open this URL in a browser tab (agent tools,
/// deep links, the dev puppet). The frontend owns tab records, so a backend
/// side cannot create one directly.
pub const OPEN_REQUEST_EVENT: &str = "browser://open-request";
/// A browser shortcut the PAGE swallowed first (the page has keyboard focus,
/// so the app's own DOM never sees the keystroke). Only the fixed set below
/// is forwarded; the payload carries no page data.
pub const SHORTCUT_EVENT: &str = "browser://shortcut";
/// A top-level navigation a tab attempted was refused by policy: the address
/// type is not allowed in a tab, or a site rule blocks the host. The status
/// layer tells the user; nothing else happens.
pub const NAVIGATION_BLOCKED_EVENT: &str = "browser://navigation-blocked";
/// The mode and status of a document guest changed (`DocGuestState`): the
/// user switched it, or the guest fell back to safe mode on its own.
pub const DOC_STATE_EVENT: &str = "browser://doc-state";
/// Whether the document in a tab has printed an error. At most two per
/// document: `false` when a new one commits and the tab's console ring is
/// cleared, `true` on the first error after that — within one document the
/// answer only goes from no to yes, so a page in a logging loop cannot turn
/// this into a stream. Both edges come from the ring itself, so the mark on
/// the "send to chat" control cannot drift from what the tab actually holds.
pub const CONSOLE_ERRORS_EVENT: &str = "browser://console-errors";

/// Where a remote connection's egress stands (`browser::egress`), on every
/// change: the tabs of its profile say whether they still reach the remote
/// host. App-wide, like every `browser://` event; a window keeps the
/// connection it is bound to.
pub const EGRESS_EVENT: &str = "browser://egress";

#[cfg(feature = "tauri-runtime")]
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserEgressPayload {
    pub connection_id: i32,
    pub status: crate::browser::egress::EgressStatus,
}

/// A tab's web inspector is gone; put the page back where the host wants it.
///
/// Raised for the kind that can be asked about (macOS, embedded surface).
/// Normally there is nothing to put back — the inspector opens in its own
/// window and the page never moves — but WebKit will dock one into the host
/// window for whoever has asked it to, and a docked inspector resizes the page
/// to fill that window and leaves it there when it closes. WebKit announces
/// none of this: the host polls while an inspector is open and says so here
/// once.
pub const DEVTOOLS_CLOSED_EVENT: &str = "browser://devtools-closed";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserDevtoolsClosedPayload {
    pub tab_id: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum NavigationBlockReason {
    HostRule,
    Scheme,
    /// A document guest pointed at a web address: not loaded in the guest,
    /// but the user may open it in a browser tab.
    External,
    /// A document guest tried to download a file; documents do not download.
    Download,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserNavigationBlockedPayload {
    pub tab_id: String,
    pub url: String,
    pub reason: NavigationBlockReason,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserShortcutPayload {
    pub tab_id: String,
    /// One of a closed set the host recognises (`find` today).
    pub shortcut: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserConsoleErrorsPayload {
    pub tab_id: String,
    pub errors: bool,
}

/// A local server codeg started has just announced its address; the workspace
/// decides what to do about it (`browser:service-auto-open`).
///
/// Broadcast to every window like the rest of these; only the one named by
/// `owner_window` acts. Nothing has been opened at this point — the backend
/// has only established that the address is a loopback one and that something
/// is listening on it.
pub const SERVICE_DETECTED_EVENT: &str = "browser://service-detected";

/// Where a detected address was printed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ServiceSource {
    /// A codeg terminal: the terminal panel, or a canvas terminal card.
    Terminal,
    /// A terminal an agent asked codeg to run (ACP `terminal/create`).
    Agent,
}

/// A loopback address something printed, and that answered a connection.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectedService {
    /// The full address, fragment dropped and query kept.
    pub url: String,
    /// `scheme://host[:port]` — what the list and the announce dedupe by.
    pub origin: String,
    /// `host:port`, the socket the liveness probe connects to.
    pub authority: String,
    /// Window whose workspace this belongs to; `web` in server mode.
    pub owner_window: String,
    pub source: ServiceSource,
    /// The terminal that printed it — a codeg terminal id, or an ACP one.
    ///
    /// Not a title: the backend's terminal title is a placeholder, and the
    /// name a person sees on a terminal tab only exists in the frontend. The
    /// id is what lets that side put a name to this.
    pub terminal_id: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserOpenRequestPayload {
    pub url: String,
    /// Who asked: `agent`, `deeplink`, `smoke`, …
    pub source: String,
    pub activate: bool,
    /// Window whose workspace should open it (`main` when absent).
    pub owner_window: Option<String>,
    /// Tab the request originated in (a modifier-click inside it). The
    /// frontend inserts the new tab right after it, like a browser does.
    pub opener_tab_id: Option<String>,
    /// The profile the new tab belongs in: the opener's for a modifier-click
    /// (the same signed-in session), else the frontend's choice.
    pub profile: Option<String>,
    /// Names this request, for a caller that needs to be told which tab the
    /// workspace opened. Absent for the fire-and-forget askers (a deep link, a
    /// modifier-click) — nobody is waiting for those, and a frontend that
    /// answered them would only be talking to itself.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PopupPresentation {
    /// The engine-created webview was adopted as a new tab next to its opener.
    Adopted,
    /// The request was refused (`reason` says why).
    Denied,
}

/// `browser://popup`: outcome of a page-initiated new-window request.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserPopupPayload {
    pub presentation: PopupPresentation,
    pub opener_tab_id: String,
    pub tab_id: Option<String>,
    pub url: String,
    /// `window.open` size features, when the page asked for any.
    pub requested_size: Option<[f64; 2]>,
    pub reason: Option<String>,
    /// The profile an adopted popup lives in — its opener's, whatever the
    /// frontend knows about the opener by the time the event arrives.
    pub profile: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserClosedPayload {
    pub tab_id: String,
    pub owner_window: String,
    /// Echoes the `request_id` the caller of `browser_close` passed, so that
    /// caller can tell this event from one it did not ask for.
    ///
    /// A tab is closed by four different things — the workspace, an agent's
    /// `browser_close_tab`, a profile being deleted, and the user closing an
    /// owned window — and all four arrive at the frontend as this one event.
    /// The workspace releases a surface without ending the tab when it
    /// SUSPENDS one, and has to ignore its own close without ignoring a real
    /// one for the same tab that overtook it. Which close this is cannot be
    /// inferred from the tab id: exactly one event is emitted per tab
    /// (whoever wins the registry removal emits it), so "the next one" may
    /// well belong to somebody else. Absent for all three of the others.
    pub request_id: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wire_names_are_camel_and_kebab() {
        let state = BrowserTabState {
            tab_id: "t1".into(),
            owner_window: "main".into(),
            kind: TabKind::Page,
            surface: SurfaceKind::Child,
            channel: ChannelKind::Native,
            channel_error: Some("Runtime.addBinding failed".into()),
            url: "about:blank".into(),
            requested_url: "https://example.com/".into(),
            title: String::new(),
            favicon: None,
            loading: true,
            can_go_back: false,
            can_go_forward: false,
            origin: None,
            zoom: 1.0,
            error: None,
            remote_host: None,
            opener_tab_id: None,
            profile: Some("default".into()),
            agent_grant: Some(crate::browser::agent::AgentGrant {
                level: crate::browser::agent::GrantLevel::Read,
                origin: "https://example.com".into(),
                granted_at: 1_700_000_000_000,
                listener: None,
            }),
        };
        let json = serde_json::to_value(&state).unwrap();
        assert_eq!(json["tabId"], "t1");
        assert_eq!(json["agentGrant"]["level"], "read");
        assert_eq!(json["agentGrant"]["grantedAt"], 1_700_000_000_000i64);
        // A grant on a real site has no listener to pin, and says so by
        // leaving the key out rather than by sending a null the frontend
        // would have to tell apart from "pinned to nothing".
        assert!(json["agentGrant"].get("listener").is_none());
        assert_eq!(json["profile"], "default");
        assert_eq!(json["ownerWindow"], "main");
        assert_eq!(json["kind"], "page");
        assert_eq!(json["surface"], "child");
        assert_eq!(json["channel"], "native");
        assert_eq!(json["channelError"], "Runtime.addBinding failed");
        assert_eq!(json["requestedUrl"], "https://example.com/");
        assert_eq!(json["canGoBack"], false);

        let bounds: Bounds =
            serde_json::from_str(r#"{"x":1,"y":2.5,"width":300,"height":200}"#).unwrap();
        assert_eq!(bounds.y, 2.5);
        let choice: SurfaceChoice = serde_json::from_str(r#""window""#).unwrap();
        assert_eq!(choice, SurfaceChoice::Window);

        let popup = serde_json::to_value(BrowserPopupPayload {
            presentation: PopupPresentation::Adopted,
            opener_tab_id: "t1".into(),
            tab_id: Some("t1-p1".into()),
            url: "https://example.com/popup".into(),
            requested_size: None,
            reason: None,
            profile: Some("p-work".into()),
        })
        .unwrap();
        assert_eq!(popup["profile"], "p-work");
        let request = serde_json::to_value(BrowserOpenRequestPayload {
            url: "https://example.com/".into(),
            source: "modifier-click".into(),
            activate: false,
            owner_window: Some("main".into()),
            opener_tab_id: Some("t1".into()),
            profile: Some("p-work".into()),
            request_id: None,
        })
        .unwrap();
        assert_eq!(request["profile"], "p-work");
        assert_eq!(request["openerTabId"], "t1");
        // An asker nobody is waiting on carries no id at all, rather than a
        // null the frontend would have to test for before answering.
        assert!(request.get("requestId").is_none());
        let blocked = serde_json::to_value(BrowserNavigationBlockedPayload {
            tab_id: "t1".into(),
            url: "https://blocked.example/".into(),
            reason: NavigationBlockReason::HostRule,
        })
        .unwrap();
        assert_eq!(blocked["reason"], "host-rule");
        let frame = serde_json::to_value(FrozenFrame {
            mime: "image/jpeg".into(),
            data: "AAAA".into(),
            width: 10,
            height: 4,
        })
        .unwrap();
        assert_eq!(frame["mime"], "image/jpeg");
    }
}
