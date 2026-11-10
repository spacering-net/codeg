//! Listener-facing access for the built-in browser's agent tools
//! (`browser_list_tabs` / `browser_snapshot` / `browser_console_messages` /
//! `browser_screenshot`, and the five action tools `browser_click` /
//! `browser_hover` / `browser_type` / `browser_press_key` /
//! `browser_select_option`) carried by codeg-mcp.
//!
//! Nothing here decides whether a page may be read or acted on. That decision
//! is `crate::browser::agent`'s, and it is enforced inside
//! `commands::browser::agent_snapshot_core` / `agent_act_core`, which the
//! production impl calls — so an MCP read passes the same grant check, and
//! leaves the same line on the tab's activity strip, as any other read. A tool
//! surface that reimplemented the check would be a second place to get it
//! wrong, and the first place someone forgot to emit the audit line from.
//!
//! Two things this module does own:
//!
//! * **The shape of the answer.** A refusal is a value, not a transport error:
//!   `browser_grant_required` is something the agent can act on (ask the user
//!   to share the tab), so it comes back as an outcome the companion renders
//!   into readable text rather than as a failed tool call that aborts a turn.
//! * **Where there are no tabs at all.** A browser tab is a native webview
//!   this process owns. In server mode there is no such thing — what the user
//!   sees in a "browser tab" is an iframe their own browser renders, which
//!   this process cannot reach — so [`NoBrowserTabs`] answers there, and the
//!   group is not advertised in the first place.

use std::sync::Arc;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use tokio::sync::RwLock;

use crate::browser::agent::{ActionOutcome, ActionRequest, AgentTabSummary, PageSnapshot};
use crate::browser::capture::{CaptureOutcome, CaptureRequest};
use crate::browser::console::{ConsoleQuery, ConsoleReadout};
use crate::browser::eval::{EvalOutcome, EvalRequest};

/// The tab exists, and this agent may not read it: nobody shared it, or the
/// page left the origin it was shared for.
///
/// The two are one slug on purpose — the distinction is about a page the agent
/// is not allowed to know anything about, and the instruction is the same
/// either way: ask the user to share this tab.
pub const ERROR_GRANT_REQUIRED: &str = "browser_grant_required";

/// No tab by that id. Also the answer to a caller whose token does not check
/// out, so an unauthenticated round trip learns nothing about which tabs
/// exist.
pub const ERROR_NO_SUCH_TAB: &str = "browser_no_such_tab";

/// The grant was in force and the read still did not produce a tree — the page
/// never answered, or answered with something unreadable.
pub const ERROR_READ_FAILED: &str = "browser_read_failed";

/// This build has no built-in browser to read (server mode), or the user has
/// switched the browser tool group off since this agent was launched.
pub const ERROR_UNAVAILABLE: &str = "browser_unavailable";

/// The tab is shared for reading and the agent asked to act on it. Its own
/// slug because the person has a different thing to do than for
/// [`ERROR_GRANT_REQUIRED`]: not share the tab, but allow actions on a tab
/// they already shared.
pub const ERROR_CONTROL_REQUIRED: &str = "browser_control_required";

/// The ref the action named is from a snapshot the page has moved past — or
/// the element has left the page. Not a permission matter: take a new
/// snapshot and use a ref from it.
pub const ERROR_STALE_REF: &str = "browser_stale_ref";

/// The action was allowed and could not be done: the element is covered by
/// another, takes no text, has no such option. The note says which.
pub const ERROR_ACTION_FAILED: &str = "browser_action_failed";

/// The browser tools are on and `browser_eval` in particular is not. Its own
/// slug, and its own sentence: the user has a different switch to find than
/// the one that turns the group on, and the agent should say which.
pub const ERROR_EVAL_DISABLED: &str = "browser_eval_disabled";

/// The person was asked about this snippet and said no — or said nothing, and
/// the question lapsed. Not a permission level the agent can get raised: the
/// question is per snippet, and the answer to this one has been given.
pub const ERROR_EVAL_DECLINED: &str = "browser_eval_declined";

/// Another snippet is already in front of the person, or this tab is in the
/// quiet period a refusal buys. Worth retrying later, unlike the two above.
pub const ERROR_EVAL_BUSY: &str = "browser_eval_busy";

/// Not an address a browser tab can hold: a malformed URL, or a scheme this
/// browser does not load. The agent's own mistake to fix, which is why it is
/// not one of the permission slugs.
pub const ERROR_BAD_ADDRESS: &str = "browser_bad_address";

/// A site rule the user wrote, or an administrator's policy, refuses this
/// host. Not a sharing matter and not retryable: the same address will be
/// refused next time.
pub const ERROR_BLOCKED: &str = "browser_blocked";

/// The workspace was asked for a tab and none arrived — no window open to put
/// one in, or the tab went away before it loaded.
pub const ERROR_OPEN_FAILED: &str = "browser_open_failed";

/// What a `browser_snapshot` asks for when the caller names no cap.
///
/// Not a ceiling: `max_chars` is honoured as given, however large, and the
/// tool says so. It is the default because the caller who names nothing is an
/// LLM with a context window, and a page tree that silently fills it is worse
/// than one that comes back `truncated` with an invitation to ask for more.
pub const DEFAULT_SNAPSHOT_MAX_CHARS: usize = 40_000;

/// What `browser_list_tabs` answers.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct BrowserTabsOutcome {
    pub tabs: Vec<AgentTabSummary>,
    /// Why the list is empty, when it is empty for a reason other than "the
    /// user has no browser tabs open". Without it an agent cannot tell "you
    /// have nothing open" from "this build has no built-in browser".
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

impl BrowserTabsOutcome {
    /// No listing to give, and the reason.
    pub fn unavailable(note: &str) -> Self {
        Self {
            tabs: Vec::new(),
            note: Some(note.to_string()),
        }
    }
}

/// What `browser_snapshot` answers: the page, or why not.
///
/// camelCase on the wire like everything else the browser sends an agent —
/// [`AgentTabSummary`] included, so `tabId` means `tabId` on both sides of a
/// refusal.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserSnapshotOutcome {
    /// Echoed back so a refusal names the tab it is about — the agent quotes
    /// it to the user when asking them to share it.
    pub tab_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub snapshot: Option<PageSnapshot>,
    /// One of the `browser_*` slugs above. `None` exactly when `snapshot` is
    /// `Some`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// The refusal in words, for the agent to relay.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

impl BrowserSnapshotOutcome {
    pub fn page(tab_id: &str, snapshot: PageSnapshot) -> Self {
        Self {
            tab_id: tab_id.to_string(),
            snapshot: Some(snapshot),
            error: None,
            note: None,
        }
    }

    pub fn refused(tab_id: &str, error: &str, note: impl Into<String>) -> Self {
        Self {
            tab_id: tab_id.to_string(),
            snapshot: None,
            error: Some(error.to_string()),
            note: Some(note.into()),
        }
    }

    /// The refusal the whole grant model exists to produce, in the words the
    /// agent should pass on: name the button, not the mechanism.
    pub fn grant_required(tab_id: &str) -> Self {
        Self::refused(
            tab_id,
            ERROR_GRANT_REQUIRED,
            format!(
                "Browser tab {tab_id} is not shared with agents. Ask the user to open that tab \
                 and press \"Share with agents\" in its toolbar; then try again. Sharing is \
                 theirs to give — there is no way to take it, and no point retrying until they \
                 have."
            ),
        )
    }
}

/// What an action tool answers: that it was done and how it reached the
/// page, or why it did not happen.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserActOutcome {
    pub tab_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub action: Option<ActionOutcome>,
    /// One of the `browser_*` slugs above. `None` exactly when `action` is
    /// `Some`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

impl BrowserActOutcome {
    pub fn done(tab_id: &str, outcome: ActionOutcome) -> Self {
        Self {
            tab_id: tab_id.to_string(),
            action: Some(outcome),
            error: None,
            note: None,
        }
    }

    pub fn refused(tab_id: &str, error: &str, note: impl Into<String>) -> Self {
        Self {
            tab_id: tab_id.to_string(),
            action: None,
            error: Some(error.to_string()),
            note: Some(note.into()),
        }
    }

    /// The tab is not shared at all — the same words the read gives, because
    /// the agent should not learn that it was the level rather than the share
    /// that stopped it.
    pub fn grant_required(tab_id: &str) -> Self {
        let read = BrowserSnapshotOutcome::grant_required(tab_id);
        Self::refused(tab_id, ERROR_GRANT_REQUIRED, read.note.unwrap_or_default())
    }

    pub fn control_required(tab_id: &str) -> Self {
        Self::refused(
            tab_id,
            ERROR_CONTROL_REQUIRED,
            format!(
                "Browser tab {tab_id} is shared with you for reading only. Ask the user to allow \
                 actions on it: in that tab's toolbar they open the \"Shared\" menu and choose \
                 \"Allow actions\". Only they can; retrying will not change it. You can still \
                 read the page with browser_snapshot."
            ),
        )
    }

    pub fn stale_ref(tab_id: &str, detail: &str) -> Self {
        // The world's details are sentences and some of them end like one.
        // Another sentence is added after them here, and without this the two
        // full stops meet in the middle of the answer.
        //
        // Exactly one, not every trailing dot: a detail can end by quoting a
        // name off the page, and `Load more...` must keep its ellipsis rather
        // than come back as `Load more`.
        let detail = detail.trim_end();
        let detail = detail.strip_suffix('.').unwrap_or(detail);
        Self::refused(
            tab_id,
            ERROR_STALE_REF,
            format!(
                "{detail}. Call browser_snapshot on tab {tab_id} again and use a ref from the new \
                 snapshot."
            ),
        )
    }
}

/// What `browser_console_messages` answers: the lines, or why not.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserConsoleOutcome {
    pub tab_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub console: Option<ConsoleReadout>,
    /// One of the `browser_*` slugs above. `None` exactly when `console` is
    /// `Some`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

impl BrowserConsoleOutcome {
    pub fn lines(tab_id: &str, readout: ConsoleReadout) -> Self {
        Self {
            tab_id: tab_id.to_string(),
            console: Some(readout),
            error: None,
            note: None,
        }
    }

    pub fn refused(tab_id: &str, error: &str, note: impl Into<String>) -> Self {
        Self {
            tab_id: tab_id.to_string(),
            console: None,
            error: Some(error.to_string()),
            note: Some(note.into()),
        }
    }

    /// The same words as a refused snapshot: the console is part of the page.
    pub fn grant_required(tab_id: &str) -> Self {
        let read = BrowserSnapshotOutcome::grant_required(tab_id);
        Self::refused(tab_id, ERROR_GRANT_REQUIRED, read.note.unwrap_or_default())
    }
}

/// What `browser_screenshot` answers: the image, or why not.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserCaptureOutcome {
    pub tab_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub capture: Option<CaptureOutcome>,
    /// One of the `browser_*` slugs above. `None` exactly when `capture` is
    /// `Some`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

impl BrowserCaptureOutcome {
    pub fn image(tab_id: &str, capture: CaptureOutcome) -> Self {
        Self {
            tab_id: tab_id.to_string(),
            capture: Some(capture),
            error: None,
            note: None,
        }
    }

    pub fn refused(tab_id: &str, error: &str, note: impl Into<String>) -> Self {
        Self {
            tab_id: tab_id.to_string(),
            capture: None,
            error: Some(error.to_string()),
            note: Some(note.into()),
        }
    }

    /// The same words as a refused snapshot: pixels are the page too.
    pub fn grant_required(tab_id: &str) -> Self {
        let read = BrowserSnapshotOutcome::grant_required(tab_id);
        Self::refused(tab_id, ERROR_GRANT_REQUIRED, read.note.unwrap_or_default())
    }

    /// The element named for the crop is from a snapshot the page has moved
    /// past — the same instruction an action gives.
    pub fn stale_ref(tab_id: &str, detail: &str) -> Self {
        let act = BrowserActOutcome::stale_ref(tab_id, detail);
        Self::refused(tab_id, ERROR_STALE_REF, act.note.unwrap_or_default())
    }
}

/// What `browser_eval` answers: what the snippet produced, or why it did not
/// run.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserEvalOutcome {
    pub tab_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<EvalOutcome>,
    /// One of the `browser_*` slugs above. `None` exactly when `result` is
    /// `Some`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

impl BrowserEvalOutcome {
    pub fn ran(tab_id: &str, result: EvalOutcome) -> Self {
        Self {
            tab_id: tab_id.to_string(),
            result: Some(result),
            error: None,
            note: None,
        }
    }

    pub fn refused(tab_id: &str, error: &str, note: impl Into<String>) -> Self {
        Self {
            tab_id: tab_id.to_string(),
            result: None,
            error: Some(error.to_string()),
            note: Some(note.into()),
        }
    }

    /// Nobody shared the tab — the same words a read gets, so the agent does
    /// not learn from the refusal which of the gates it fell at.
    pub fn grant_required(tab_id: &str) -> Self {
        let read = BrowserSnapshotOutcome::grant_required(tab_id);
        Self::refused(tab_id, ERROR_GRANT_REQUIRED, read.note.unwrap_or_default())
    }

    /// Shared for reading only. Running code is at least an action, so it
    /// needs at least what an action needs.
    pub fn control_required(tab_id: &str) -> Self {
        let act = BrowserActOutcome::control_required(tab_id);
        Self::refused(tab_id, ERROR_CONTROL_REQUIRED, act.note.unwrap_or_default())
    }

    /// The person said no, or said nothing. Says plainly that retrying is not
    /// the move: a model that reads "declined" as "ask again" turns a refusal
    /// into a queue of dialogs, which is how someone ends up approving one by
    /// accident.
    pub fn declined(tab_id: &str) -> Self {
        Self::refused(
            tab_id,
            ERROR_EVAL_DECLINED,
            format!(
                "That code was not approved to run on browser tab {tab_id}: the user said no, \
                 or nobody was there to answer. Do not send the same snippet again — neither \
                 answer changes for being asked twice. Say what you wanted to find out, and \
                 use browser_snapshot, browser_console_messages or the action tools if they \
                 can answer it."
            ),
        )
    }
}

/// What `browser_open_tab` / `browser_navigate` / `browser_close_tab` answer:
/// the tab as it stands afterwards, or why nothing happened.
///
/// One type for the three because the useful answer to all three is the same
/// one `browser_list_tabs` gives about a tab — the id to name it by, where it
/// is, and whether the agent may read it. A close has no tab left to describe,
/// so it answers with the id and nothing else.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserTabOutcome {
    /// The tab this is about. Absent only when an open was refused before any
    /// tab existed.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tab_id: Option<String>,
    /// The tab as it stands now. Absent for a close, and for every refusal.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tab: Option<AgentTabSummary>,
    /// The tab is showing an error page instead of the address it was sent to,
    /// and which kind (`dns`, `tls`, `blocked`, `failed`).
    ///
    /// Not a refusal — the tab opened, and it is the agent's to retry or close
    /// — but without it the answer is "this tab has no address and is not
    /// shared with you", which reads like a permission problem and sends the
    /// agent to ask the user for something that would not help. A dev server
    /// that is not up yet is the ordinary shape of this.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub load_error: Option<String>,
    /// One of the `browser_*` slugs above. `None` exactly when the call did
    /// what it was asked to.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

impl BrowserTabOutcome {
    /// A tab that is open and settled, after an open or a navigation.
    pub fn tab(summary: AgentTabSummary, load_error: Option<String>) -> Self {
        Self {
            tab_id: Some(summary.tab_id.clone()),
            tab: Some(summary),
            load_error,
            error: None,
            note: None,
        }
    }

    /// The tab is gone.
    pub fn closed(tab_id: &str) -> Self {
        Self {
            tab_id: Some(tab_id.to_string()),
            tab: None,
            load_error: None,
            error: None,
            note: Some(format!("Browser tab {tab_id} is closed.")),
        }
    }

    pub fn refused(tab_id: Option<&str>, error: &str, note: impl Into<String>) -> Self {
        Self {
            tab_id: tab_id.map(str::to_string),
            tab: None,
            load_error: None,
            error: Some(error.to_string()),
            note: Some(note.into()),
        }
    }

    /// Nobody shared the tab — the same words every other tool gives, so the
    /// refusal does not disclose which gate it fell at.
    pub fn grant_required(tab_id: &str) -> Self {
        let read = BrowserSnapshotOutcome::grant_required(tab_id);
        Self::refused(Some(tab_id), ERROR_GRANT_REQUIRED, read.note.unwrap_or_default())
    }

    /// Shared for reading. Pointing a tab somewhere else, or closing it, is at
    /// least as much as clicking a link on it.
    pub fn control_required(tab_id: &str) -> Self {
        let act = BrowserActOutcome::control_required(tab_id);
        Self::refused(Some(tab_id), ERROR_CONTROL_REQUIRED, act.note.unwrap_or_default())
    }
}

/// Which of the three tab tools is being asked for.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum BrowserTabOp {
    /// Open a new tab on this address, in the foreground.
    Open { url: String },
    /// Point an existing tab at this address.
    Navigate { tab_id: String, url: String },
    /// Close an existing tab.
    Close { tab_id: String },
}

impl BrowserTabOp {
    /// The tab the op names, for a refusal that has to name one before the
    /// access impl is reached.
    pub fn tab_id(&self) -> Option<&str> {
        match self {
            Self::Open { .. } => None,
            Self::Navigate { tab_id, .. } | Self::Close { tab_id } => Some(tab_id),
        }
    }
}

/// Listener-facing access to the built-in browser's agent surface. The
/// production impl (`crate::commands::browser::McpBrowserTools`) exists only in
/// the desktop build; server mode and tests use [`NoBrowserTabs`]. Mirrors
/// [`crate::acp::session_info::SessionInfoAccess`].
#[async_trait]
pub trait BrowserToolAccess: Send + Sync {
    /// Every tab this agent may be told about. Never an error: "no tabs" and
    /// "no browser" are both listings, distinguished by `note`.
    async fn list_tabs(&self) -> BrowserTabsOutcome;

    /// Read one shared page. `max_chars` is the caller's own cap; `None` means
    /// [`DEFAULT_SNAPSHOT_MAX_CHARS`].
    async fn snapshot(&self, tab_id: &str, max_chars: Option<usize>) -> BrowserSnapshotOutcome;

    /// Act on one shared page, by a ref from a snapshot of it. Needs the tab
    /// shared at `control`.
    async fn act(&self, tab_id: &str, request: ActionRequest) -> BrowserActOutcome;

    /// What one shared page printed to its console. A read, like a snapshot.
    async fn console(&self, tab_id: &str, query: ConsoleQuery) -> BrowserConsoleOutcome;

    /// A screenshot of one shared page, or of one element of it. A read,
    /// like a snapshot.
    async fn capture(&self, tab_id: &str, request: CaptureRequest) -> BrowserCaptureOutcome;

    /// Run the caller's own code on one shared page. Needs the tab shared at
    /// `control`, the `browser_eval` switch on, AND the person to approve this
    /// particular snippet — so this call blocks on a human and can take as
    /// long as one takes to read it.
    async fn eval(&self, tab_id: &str, request: EvalRequest) -> BrowserEvalOutcome;

    /// Open a tab, point one somewhere else, or close one.
    ///
    /// Waits for the page to settle, so it can be in flight for as long as a
    /// page takes to load. Opening needs nothing but the group switch — there
    /// is no tab yet to have a grant; the other two need the tab shared at
    /// `control`, unless it has no document in it to protect.
    async fn tab_op(&self, op: BrowserTabOp) -> BrowserTabOutcome;
}

/// The answer where there is no built-in browser: server mode, and the stub in
/// every test that does not care about one.
pub struct NoBrowserTabs;

/// Said to an agent in a runtime that has no native tabs, and to one whose
/// user has switched the group off. Both are "not here", and neither is worth
/// retrying.
pub const NO_BROWSER_NOTE: &str =
    "The built-in browser is not available in this session, so there are no tabs to read.";

#[async_trait]
impl BrowserToolAccess for NoBrowserTabs {
    async fn list_tabs(&self) -> BrowserTabsOutcome {
        BrowserTabsOutcome::unavailable(NO_BROWSER_NOTE)
    }

    async fn snapshot(&self, tab_id: &str, _max_chars: Option<usize>) -> BrowserSnapshotOutcome {
        BrowserSnapshotOutcome::refused(tab_id, ERROR_UNAVAILABLE, NO_BROWSER_NOTE)
    }

    async fn act(&self, tab_id: &str, _request: ActionRequest) -> BrowserActOutcome {
        BrowserActOutcome::refused(tab_id, ERROR_UNAVAILABLE, NO_BROWSER_NOTE)
    }

    async fn console(&self, tab_id: &str, _query: ConsoleQuery) -> BrowserConsoleOutcome {
        BrowserConsoleOutcome::refused(tab_id, ERROR_UNAVAILABLE, NO_BROWSER_NOTE)
    }

    async fn capture(&self, tab_id: &str, _request: CaptureRequest) -> BrowserCaptureOutcome {
        BrowserCaptureOutcome::refused(tab_id, ERROR_UNAVAILABLE, NO_BROWSER_NOTE)
    }

    async fn eval(&self, tab_id: &str, _request: EvalRequest) -> BrowserEvalOutcome {
        BrowserEvalOutcome::refused(tab_id, ERROR_UNAVAILABLE, NO_BROWSER_NOTE)
    }

    async fn tab_op(&self, op: BrowserTabOp) -> BrowserTabOutcome {
        BrowserTabOutcome::refused(op.tab_id(), ERROR_UNAVAILABLE, NO_BROWSER_NOTE)
    }
}

/// The hot-swappable feature config read at MCP injection time, and again at
/// call time.
///
/// Re-read at call time — unlike the other read-only groups, like the
/// chat-authoring writers — because this one is a window onto pages the user is
/// looking at. Switching it off should stop the agent that is already running,
/// not only the next one launched; a user reaching for that switch is reaching
/// for it *now*.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct BrowserToolsConfig {
    pub enabled: bool,
    /// `browser_eval`, which is off unless someone turned it on *and* left the
    /// group on. Never true with `enabled` false — see
    /// `commands::browser_tools`, which is the only writer.
    pub eval: bool,
}

/// Shared, hot-swappable handle to [`BrowserToolsConfig`]. Cloned into
/// `DelegationInjection` (read at injection), into the access impl (read at
/// call time), and into `AppState` (updated on save).
#[derive(Clone, Default)]
pub struct BrowserToolsRuntimeConfig {
    inner: Arc<RwLock<BrowserToolsConfig>>,
}

impl BrowserToolsRuntimeConfig {
    pub fn new() -> Self {
        Self::default()
    }

    pub async fn snapshot(&self) -> BrowserToolsConfig {
        self.inner.read().await.clone()
    }

    pub async fn set(&self, cfg: BrowserToolsConfig) {
        *self.inner.write().await = cfg;
    }

    pub async fn is_enabled(&self) -> bool {
        self.inner.read().await.enabled
    }

    /// Whether `browser_eval` exists right now. Read at call time as well as
    /// at injection, for the same reason as the group: someone reaching for
    /// this switch means the session in front of them.
    pub async fn is_eval_enabled(&self) -> bool {
        let cfg = self.inner.read().await;
        cfg.enabled && cfg.eval
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A refusal has to name the tab and carry a slug the agent can branch on
    /// — the prose is for the user, the slug is for the model.
    #[test]
    fn a_refusal_names_the_tab_and_the_button_that_lifts_it() {
        let out = BrowserSnapshotOutcome::grant_required("t7");
        assert_eq!(out.tab_id, "t7");
        assert_eq!(out.error.as_deref(), Some(ERROR_GRANT_REQUIRED));
        let note = out.note.expect("a refusal explains itself");
        assert!(note.contains("t7"));
        assert!(note.contains("Share with agents"));
        assert!(out.snapshot.is_none());
    }

    /// `snapshot` and `error` are exclusive, and the absent one is absent from
    /// the wire rather than present-and-null: the companion branches on which
    /// key is there.
    #[test]
    fn the_wire_carries_exactly_one_of_the_page_and_the_refusal() {
        let refused = serde_json::to_value(BrowserSnapshotOutcome::grant_required("t1"))
            .expect("serialises");
        assert_eq!(refused["error"], ERROR_GRANT_REQUIRED);
        // camelCase, the same spelling the listing uses.
        assert_eq!(refused["tabId"], "t1");
        assert!(refused.get("tab_id").is_none());
        assert!(refused.get("snapshot").is_none());

        let page = serde_json::to_value(BrowserSnapshotOutcome::page(
            "t1",
            PageSnapshot {
                generation: "3.0".into(),
                url: "https://example.com/".into(),
                title: "Example".into(),
                viewport: crate::browser::agent::SnapshotViewport {
                    width: 1280.0,
                    height: 800.0,
                    dpr: 2.0,
                },
                tree: "- heading \"Example\"".into(),
                refs_count: 1,
                truncated: false,
            },
        ))
        .expect("serialises");
        assert_eq!(page["snapshot"]["title"], "Example");
        assert!(page.get("error").is_none());
        assert!(page.get("note").is_none());
    }

    /// An empty listing is not an error, and the two kinds of empty are told
    /// apart by the note.
    #[tokio::test]
    async fn a_runtime_without_tabs_says_so_rather_than_looking_idle() {
        let out = NoBrowserTabs.list_tabs().await;
        assert!(out.tabs.is_empty());
        assert_eq!(out.note.as_deref(), Some(NO_BROWSER_NOTE));

        let quiet = BrowserTabsOutcome::default();
        assert!(quiet.tabs.is_empty());
        assert_eq!(quiet.note, None);

        let refused = NoBrowserTabs.snapshot("t1", None).await;
        assert_eq!(refused.error.as_deref(), Some(ERROR_UNAVAILABLE));
    }

    /// The refusals an action tool can give each name the tab and the thing
    /// the agent (or the user) does next; `action` and `error` are exclusive.
    #[test]
    fn an_action_refusal_says_what_to_do_next() {
        let control = BrowserActOutcome::control_required("t3");
        assert_eq!(control.error.as_deref(), Some(ERROR_CONTROL_REQUIRED));
        let note = control.note.clone().unwrap();
        assert!(note.contains("t3"));
        assert!(note.contains("Allow actions"));
        assert!(control.action.is_none());

        let stale = BrowserActOutcome::stale_ref("t3", "e9 is gone");
        assert_eq!(stale.error.as_deref(), Some(ERROR_STALE_REF));
        assert!(stale.note.unwrap().contains("browser_snapshot"));

        // The world's longer details are written as sentences and end as
        // sentences; the instruction added after them brings its own full
        // stop. The first of these is the world's own words for the one detail
        // that does end in a stop (`browser-agent/src/index.ts`, the
        // `maxChars` explanation) — the others are the shapes every remaining
        // producer has.
        for detail in [
            "e18 was named by an earlier snapshot of this page, and the snapshot you took after \
             it did not name it. The page itself has not changed. Take a snapshot large enough \
             to include what you want and use a ref from that one.",
            "e18 does not name an element on the page as it is now; take a new snapshot",
            "the page has navigated since that snapshot; take a new one",
        ] {
            let note = BrowserActOutcome::stale_ref("t3", detail).note.unwrap();
            assert!(!note.contains(".."), "{note}");
            assert!(note.contains(". Call browser_snapshot on tab t3 again"), "{note}");
            // And it takes a stop off, never a word.
            assert!(note.starts_with(detail.trim_end_matches('.')), "{note}");
        }
        // Exactly one stop, though. A detail that ends by quoting a name off
        // the page keeps the name: `Load more...` must not come back as
        // `Load more`, which is a different button.
        let quoted =
            BrowserActOutcome::stale_ref("t3", "e4 does not name the button Load more...")
                .note
                .unwrap();
        assert!(
            quoted.starts_with("e4 does not name the button Load more... Call browser_snapshot"),
            "{quoted}"
        );

        // Unshared: the same words as a read, so the level is not disclosed.
        let none = BrowserActOutcome::grant_required("t3");
        assert_eq!(none.note, BrowserSnapshotOutcome::grant_required("t3").note);

        let done = serde_json::to_value(BrowserActOutcome::done(
            "t3",
            ActionOutcome {
                fidelity: crate::browser::agent::Fidelity::Synthetic,
                url: "https://example.com/".into(),
                scrolled: None,
            },
        ))
        .unwrap();
        assert_eq!(done["action"]["fidelity"], "synthetic");
        assert_eq!(done["tabId"], "t3");
        assert!(done.get("error").is_none());
    }

    /// The console and screenshot refusals borrow the read's words — the
    /// console and the pixels are the page — and each carries exactly one of
    /// its payload and its error.
    #[tokio::test]
    async fn console_and_capture_refusals_read_like_a_refused_read() {
        let console = BrowserConsoleOutcome::grant_required("t4");
        assert_eq!(console.error.as_deref(), Some(ERROR_GRANT_REQUIRED));
        assert_eq!(console.note, BrowserSnapshotOutcome::grant_required("t4").note);
        assert!(console.console.is_none());

        let capture = BrowserCaptureOutcome::stale_ref("t4", "e2 is gone");
        assert_eq!(capture.error.as_deref(), Some(ERROR_STALE_REF));
        assert!(capture.note.as_deref().unwrap().contains("browser_snapshot"));
        let wire = serde_json::to_value(&capture).unwrap();
        assert_eq!(wire["tabId"], "t4");
        assert!(wire.get("capture").is_none());

        let none = NoBrowserTabs;
        assert_eq!(
            none.console("t1", ConsoleQuery::default()).await.error.as_deref(),
            Some(ERROR_UNAVAILABLE)
        );
        assert_eq!(
            none.capture("t1", CaptureRequest::default()).await.error.as_deref(),
            Some(ERROR_UNAVAILABLE)
        );
    }

    /// The three tab tools share one answer shape: an open and a navigation
    /// describe the tab the way the listing does, a close has no tab left to
    /// describe, and a refusal carries the slug and no tab at all.
    #[tokio::test]
    async fn a_tab_op_answers_with_the_tab_or_with_why_not() {
        let opened = BrowserTabOutcome::tab(
            AgentTabSummary {
                tab_id: "t7".into(),
                origin: Some("http://localhost:3000".into()),
                level: crate::browser::agent::GrantLevel::Control,
                title: Some("dev".into()),
            },
            None,
        );
        let wire = serde_json::to_value(&opened).unwrap();
        assert_eq!(wire["tabId"], "t7");
        assert_eq!(wire["tab"]["origin"], "http://localhost:3000");
        assert!(wire.get("error").is_none());
        assert!(wire.get("loadError").is_none());

        // A page that did not load says so as a fact about the page, not as a
        // refusal: `error` stays empty and the tab is still the agent's to
        // retry.
        let failed = serde_json::to_value(BrowserTabOutcome::tab(
            AgentTabSummary {
                tab_id: "t8".into(),
                origin: None,
                level: crate::browser::agent::GrantLevel::None,
                title: None,
            },
            Some("failed".into()),
        ))
        .unwrap();
        assert_eq!(failed["loadError"], "failed");
        assert!(failed.get("error").is_none());

        let closed = serde_json::to_value(BrowserTabOutcome::closed("t7")).unwrap();
        assert_eq!(closed["tabId"], "t7");
        assert!(closed.get("tab").is_none());
        assert!(closed.get("error").is_none());

        // Read-only and unshared say what the other tools say, so driving a
        // tab cannot become a way to probe its level.
        assert_eq!(
            BrowserTabOutcome::control_required("t7").note,
            BrowserActOutcome::control_required("t7").note
        );
        assert_eq!(
            BrowserTabOutcome::grant_required("t7").note,
            BrowserSnapshotOutcome::grant_required("t7").note
        );

        // An open that never got a tab has no id to give, and says so by
        // leaving the key off rather than sending an empty string.
        let no_tab = serde_json::to_value(BrowserTabOutcome::refused(
            None,
            ERROR_BLOCKED,
            "a site rule refuses that address",
        ))
        .unwrap();
        assert!(no_tab.get("tabId").is_none());
        assert_eq!(no_tab["error"], ERROR_BLOCKED);

        let unavailable = NoBrowserTabs
            .tab_op(BrowserTabOp::Close { tab_id: "t7".into() })
            .await;
        assert_eq!(unavailable.error.as_deref(), Some(ERROR_UNAVAILABLE));
        assert_eq!(unavailable.tab_id.as_deref(), Some("t7"));
        // An open has no tab to name even here.
        let unavailable = NoBrowserTabs
            .tab_op(BrowserTabOp::Open {
                url: "https://example.com/".into(),
            })
            .await;
        assert_eq!(unavailable.tab_id, None);
    }

    #[tokio::test]
    async fn runtime_config_round_trips() {
        let cfg = BrowserToolsRuntimeConfig::new();
        assert!(!cfg.is_enabled().await);
        assert!(!cfg.is_eval_enabled().await);
        let on = BrowserToolsConfig {
            enabled: true,
            eval: false,
        };
        cfg.set(on.clone()).await;
        assert!(cfg.is_enabled().await);
        // The group being on says nothing about eval.
        assert!(!cfg.is_eval_enabled().await);
        assert_eq!(cfg.snapshot().await, on);

        cfg.set(BrowserToolsConfig {
            enabled: true,
            eval: true,
        })
        .await;
        assert!(cfg.is_eval_enabled().await);

        // Belt and braces against a caller that sets the pair by hand: eval
        // without the group is not a state the runtime will report.
        cfg.set(BrowserToolsConfig {
            enabled: false,
            eval: true,
        })
        .await;
        assert!(!cfg.is_eval_enabled().await);
    }

    /// The refusals `browser_eval` can give are distinguishable, and the one
    /// the person caused says not to try again.
    #[tokio::test]
    async fn an_eval_refusal_says_whether_asking_again_is_worth_anything() {
        let declined = BrowserEvalOutcome::declined("t9");
        assert_eq!(declined.error.as_deref(), Some(ERROR_EVAL_DECLINED));
        let note = declined.note.clone().unwrap();
        assert!(note.contains("t9"));
        assert!(note.contains("Do not send the same snippet again"));
        assert!(declined.result.is_none());

        // Unshared and read-only are the same words the other tools use, so
        // the eval path cannot become a way to probe a tab's level.
        assert_eq!(
            BrowserEvalOutcome::grant_required("t9").note,
            BrowserSnapshotOutcome::grant_required("t9").note
        );
        assert_eq!(
            BrowserEvalOutcome::control_required("t9").note,
            BrowserActOutcome::control_required("t9").note
        );

        let unavailable = NoBrowserTabs.eval("t9", EvalRequest::default()).await;
        assert_eq!(unavailable.error.as_deref(), Some(ERROR_UNAVAILABLE));

        let wire = serde_json::to_value(BrowserEvalOutcome::ran(
            "t9",
            EvalOutcome {
                kind: "string".into(),
                value: "hello".into(),
                truncated: false,
                url: "https://example.com/".into(),
            },
        ))
        .unwrap();
        assert_eq!(wire["tabId"], "t9");
        assert_eq!(wire["result"]["value"], "hello");
        assert!(wire.get("error").is_none());
        // `truncated: false` is absent rather than present-and-false, like
        // every other optional on this wire.
        assert!(wire["result"].get("truncated").is_none());
    }
}
