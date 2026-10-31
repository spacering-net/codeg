//! Rendered-page tool ("show a page, optionally wait for an answer on it").
//!
//! Mid-turn an agent can draw a finished, self-contained HTML page inline in
//! the chat — the `render_page` MCP tool exposed by `codeg-mcp` (a port of
//! openchamber's `openchamber_render`, whose plain-HTML-plus-ready-classes
//! design deliberately avoids a generative-UI component library). Without
//! `awaitAnswer` the tool is fire-and-forget: the page is a card the chat
//! renders straight from the tool call's own input (live AND on transcript
//! replay), and the call returns a `shown` note immediately. With
//! `awaitAnswer` the call additionally BLOCKS until the user submits an answer
//! on the page — the same park-the-tool-call shape as
//! [`crate::acp::question`]'s `ask_user_question`, one slot per connection,
//! peer-close teardown, snapshot recovery — except the answer is arbitrary JSON
//! the page itself composes, not per-question labels.
//!
//! This module holds the pieces shared across layers (mirroring
//! `question.rs`):
//!   * [`RenderPageSpec`] — one validated call's worth of page.
//!   * [`PendingRenderPageState`] — the awaiting-answer page stored on the
//!     session and carried on the snapshot.
//!   * [`RenderPageAnswer`] (frontend → backend) / [`RenderPageOutcome`]
//!     (back to the blocked tool).
//!   * [`SessionRenderPageAccess`] — the listener-facing trait the production
//!     `ConnectionManager` implements.
//!   * [`RenderPageRuntimeConfig`] — the hot-swappable "is the feature on?"
//!     flag, read at MCP injection time.

use std::sync::Arc;

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::{oneshot, RwLock};

/// Max characters of the page's `html`. Mirrors openchamber's
/// `RENDER_PAGE_MAX_HTML_LENGTH`: the page rides inside the tool-call input
/// that the agent's transcript stores and every client receives, so the bound
/// caps one card's payload, not a library of them.
pub const MAX_HTML_CHARS: usize = 200_000;
/// Max characters of the page title (agent-given or extracted from the page).
pub const MAX_TITLE_CHARS: usize = 120;
/// Max characters of the answer summary the page submits — a few words of the
/// user's own language, never a document.
pub const MAX_SUMMARY_CHARS: usize = 500;
/// Max serialized-JSON length of the answer `data`. An answer is a choice plus
/// a few values; the agent builds the rest itself.
pub const MAX_ANSWER_DATA_CHARS: usize = 16_000;
/// What an untitled page is called when the page itself carries no usable
/// heading either.
pub const FALLBACK_TITLE: &str = "Page";

/// The agent-facing notes the tool result carries (the LLM reads these, so
/// they stay in English — same audience convention as the ask tool's notes).
pub const SHOWN_NOTE: &str = "Shown to the user in the chat above your reply. \
    Don't announce, describe or restate the page; reply with only what it \
    doesn't already say.";
pub const ANSWERED_NOTE: &str = "The user answered on the page. summary is \
    their choice in words, data is what the page sent. Continue the task from \
    it; the chat already shows the summary under the page, so don't repeat it \
    back.";
pub const DECLINED_NOTE: &str = "The user did not answer on the page (they \
    dismissed it, wrote in the chat instead, or the turn ended); proceed using \
    your best judgment and reasonable defaults.";

/// One validated `render_page` call. `title` is always present: the caller's
/// title, else the page's own `<title>` / first h1-h3, else
/// [`FALLBACK_TITLE`] (openchamber learned that a required title makes weaker
/// models split the call in two and lose the page; the extraction is the fix).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RenderPageSpec {
    pub title: String,
    pub html: String,
    pub await_answer: bool,
}

/// The pending (awaiting-answer) page stored on
/// `SessionState.pending_render_page` and carried on `to_snapshot()` so a
/// client attaching mid-turn re-arms the submit bridge on the card even though
/// the one-shot `RenderPageRequest` event won't replay for it. The card itself
/// renders from the tool call's input; this state is what the frontend matches
/// its in-place card against (by `html` — the page's own content is its
/// identity) to know WHICH rendered card is the live, answerable one.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PendingRenderPageState {
    pub page_id: String,
    pub title: String,
    pub html: String,
    pub created_at: DateTime<Utc>,
}

/// The user's submission for a pending page (frontend → backend). `summary` is
/// the choice in a few words (rendered under the card); `data` is the JSON the
/// page's script sends to `codeg.render.submit`. `declined` is set when the
/// user dismissed the card instead of answering — the agent then proceeds with
/// its own judgment. camelCase on the wire — constructed by the frontend.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderPageAnswer {
    #[serde(default)]
    pub summary: Option<String>,
    #[serde(default)]
    pub data: Option<Value>,
    #[serde(default)]
    pub declined: bool,
}

/// The resolved outcome delivered over the broker socket to the blocked tool.
/// Self-describing (the companion renders it without holding the page).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RenderPageOutcome {
    pub answered: bool,
    #[serde(default)]
    pub summary: String,
    #[serde(default)]
    pub data: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

/// What [`SessionRenderPageAccess::register_render_page`] hands back to the
/// listener: the new page id plus the receiver to await the user's answer on.
pub struct RegisteredRenderPage {
    pub page_id: String,
    pub answer_rx: oneshot::Receiver<RenderPageOutcome>,
}

/// Listener-facing access to register / cancel a pending rendered page on a
/// parent connection. The production impl (`ConnectionManagerRenderPageLookup`)
/// wraps the `ConnectionManager`; tests use an in-memory stub. Mirrors
/// [`crate::acp::question::SessionQuestionAccess`].
#[async_trait]
pub trait SessionRenderPageAccess: Send + Sync {
    /// Register a waiting page on the parent connection (resolved from the
    /// per-launch token), broadcast it to every attached client, and return a
    /// receiver that resolves when the user answers (or the page is canceled).
    /// `None` when the connection is gone — nothing to show — or when it
    /// already has a waiting page (one card per turn; the refused second call
    /// resolves as an unanswered outcome so the agent proceeds).
    async fn register_render_page(
        &self,
        parent_connection_id: &str,
        title: String,
        html: String,
    ) -> Option<RegisteredRenderPage>;

    /// Cancel a waiting page — the companion's tool call was canceled
    /// (peer-close) or the connection is tearing down. Removes it and clears
    /// the answerable state on every client's card. No-op if it was already
    /// answered / gone.
    async fn cancel_render_page(&self, parent_connection_id: &str, page_id: &str);

    /// Cancel every waiting page parked on a connection that is tearing down.
    /// Called from the `run_connection` cleanup guard and the turn-exit
    /// sweeps, mirroring `cancel_questions_by_parent`.
    async fn cancel_render_pages_by_parent(&self, parent_connection_id: &str);
}

/// Validate + parse the MCP `render_page` arguments into a [`RenderPageSpec`].
/// A malformed call is rejected synchronously with a message the LLM can fix,
/// rather than round-tripping bad data. `awaitAnswer` must be a real boolean
/// (a stringified `"true"` is the model's mistake, not ours to guess — same
/// strictness openchamber applies so the retry lands corrected); a missing one
/// means show-only. A missing / blank title is extracted from the page itself
/// ([`render_page_title_from_html`]), else [`FALLBACK_TITLE`].
pub fn parse_render_page_arguments(arguments: &Value) -> Result<RenderPageSpec, String> {
    let html = arguments
        .get("html")
        .and_then(|v| v.as_str())
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(
            || "render_page requires a non-empty `html` string: one complete, self-contained HTML document. Send html and title together in one call".to_string(),
        )?;
    if html.chars().count() > MAX_HTML_CHARS {
        return Err(format!(
            "render_page `html` is {chars} characters; the limit is {MAX_HTML_CHARS}. Make the page smaller, for example by drawing data with a script instead of writing out every element",
            chars = html.chars().count()
        ));
    }
    let given_title = arguments
        .get("title")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty());
    if let Some(t) = given_title {
        if t.chars().count() > MAX_TITLE_CHARS {
            return Err(format!(
                "render_page `title` is {} characters; the limit is {MAX_TITLE_CHARS}",
                t.chars().count()
            ));
        }
    }
    let await_answer = match arguments.get("awaitAnswer") {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(other) => {
            return Err(format!(
                "render_page `awaitAnswer` must be a boolean, got {other}"
            ));
        }
    };
    let title = given_title
        .map(str::to_string)
        .or_else(|| render_page_title_from_html(html))
        .unwrap_or_else(|| FALLBACK_TITLE.to_string());
    Ok(RenderPageSpec {
        title,
        html: html.to_string(),
        await_answer,
    })
}

/// Re-assert the size bounds on a page arriving over the broker socket. The
/// companion validated before sending, but the socket is only token-gated, so
/// a hand-rolled client must not push an oversized `html` straight into the
/// broadcast `RenderPageRequest` event and the `pending_render_page` snapshot
/// (bounds mirror [`parse_render_page_arguments`]).
pub fn validate_page(title: &str, html: &str) -> Result<(), String> {
    if title.trim().is_empty() {
        return Err("rendered page requires a non-empty title".to_string());
    }
    if title.chars().count() > MAX_TITLE_CHARS {
        return Err(format!(
            "rendered page title exceeds {MAX_TITLE_CHARS} characters"
        ));
    }
    if html.trim().is_empty() {
        return Err("rendered page requires a non-empty html document".to_string());
    }
    if html.chars().count() > MAX_HTML_CHARS {
        return Err(format!(
            "rendered page html exceeds {MAX_HTML_CHARS} characters"
        ));
    }
    Ok(())
}

/// Normalize + validate the user's submission into the self-describing
/// [`RenderPageOutcome`] the blocked tool receives. `acp_answer_render_page` is
/// a plain API a stale or hand-rolled client can hit directly, so the
/// authoritative size rules live here: a blank summary degrades to the page
/// title, an over-long one is truncated (never rejected — the user already
/// answered), and oversized `data` is dropped with a note so the agent learns
/// the answer arrived but not through a silent truncation of JSON.
pub fn build_render_outcome(title: &str, answer: &RenderPageAnswer) -> RenderPageOutcome {
    if answer.declined {
        return RenderPageOutcome {
            answered: false,
            summary: String::new(),
            data: Value::Null,
            note: Some(DECLINED_NOTE.to_string()),
        };
    }
    let summary = answer
        .summary
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.chars().take(MAX_SUMMARY_CHARS).collect())
        .unwrap_or_else(|| title.to_string());
    let data = answer.data.clone().unwrap_or(Value::Null);
    let serialized = data.to_string();
    if serialized.chars().count() > MAX_ANSWER_DATA_CHARS {
        return RenderPageOutcome {
            answered: true,
            summary,
            data: Value::Null,
            note: Some(format!(
                "The page's answer data was {len} characters as JSON, over the {MAX_ANSWER_DATA_CHARS}-character limit, so it was dropped; only the summary arrived.",
                len = serialized.chars().count()
            )),
        };
    }
    RenderPageOutcome {
        answered: true,
        summary,
        data,
        note: Some(ANSWERED_NOTE.to_string()),
    }
}

/// Name an untitled page after its own content: the `<title>` element, else
/// the first h1-h3 heading, else nothing. Port of openchamber's
/// `renderPageTitleFromHtml`. The result is already bounded to
/// [`MAX_TITLE_CHARS`] (an extraction truncates; only an agent-PROVIDED
/// over-long title is an error — openchamber's split, learned from weaker
/// models splitting title and html into two calls).
pub fn render_page_title_from_html(html: &str) -> Option<String> {
    let text = element_text(html, "title")
        .or_else(|| element_text(html, "h1"))
        .or_else(|| element_text(html, "h2"))
        .or_else(|| element_text(html, "h3"))?;
    let trimmed = text.chars().take(MAX_TITLE_CHARS).collect::<String>();
    let trimmed = trimmed.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

/// Extract the visible text of the first `<tag …>…</tag>` element, with inline
/// markup stripped, the six title entities decoded, and whitespace collapsed.
/// Manual scanning rather than a regex dependency: the shape is three
/// well-known tags, and a case-insensitive ASCII pre-pass makes the whole walk
/// one `to_ascii_lowercase` over the document.
fn element_text(html: &str, tag: &str) -> Option<String> {
    let lower = html.to_ascii_lowercase();
    let open = format!("<{tag}");
    let close = format!("</{tag}");
    let open_bytes = open.as_bytes();
    let close_bytes = close.as_bytes();
    let hay = lower.as_bytes();
    let mut from = 0usize;
    while let Some(rel) = lower[from..].find(&open) {
        let start = from + rel;
        from = start + open_bytes.len();
        // The tag name must END at a boundary: `<time>` must not match `<title`
        // scans nor `<h1` admit `<hr`.
        match hay.get(from) {
            Some(b'>') | Some(b' ') | Some(b'\t') | Some(b'\n') | Some(b'\r') | Some(b'/') => {}
            _ => continue,
        }
        // Skip the open tag's attributes; bail on a tag that never closes.
        // A `>` inside a quoted attribute value is part of the value, not the
        // tag end, so the skip tracks quotes (`<h1 id="x>y">` opens at `>` #2).
        let Some(content_start) = open_tag_end(&lower, from) else {
            continue;
        };
        let Some(cl_rel) = lower[content_start..].find(&close) else {
            continue;
        };
        let content = &html[content_start..content_start + cl_rel];
        return Some(clean_title_text(content));
    }
    let _ = open_bytes;
    let _ = close_bytes;
    None
}

/// The byte just past the `>` ending an open tag whose name ended at `from`
/// (into the lowercased document), skipping quoted attribute values.
fn open_tag_end(lower: &str, from: usize) -> Option<usize> {
    let bytes = lower.as_bytes();
    let mut quote: Option<u8> = None;
    let mut i = from;
    while i < bytes.len() {
        match bytes[i] {
            b'"' | b'\'' if quote.is_none() => quote = Some(bytes[i]),
            c if quote == Some(c) => quote = None,
            b'>' if quote.is_none() => return Some(i + 1),
            _ => {}
        }
        i += 1;
    }
    None
}

/// Strip child markup, decode the six title entities, and collapse whitespace.
/// Quote-aware like [`open_tag_end`]: an attribute's `>` (`<code class="x>y">`)
/// must not end the tag, or the rest of the value leaks into the title.
fn clean_title_text(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut inside_tag = false;
    let mut quote: Option<char> = None;
    for ch in raw.chars() {
        if inside_tag {
            match quote {
                Some(q) => {
                    if ch == q {
                        quote = None;
                    }
                }
                None => {
                    if ch == '"' || ch == '\'' {
                        quote = Some(ch);
                    } else if ch == '>' {
                        inside_tag = false;
                        out.push(' ');
                    }
                }
            }
        } else if ch == '<' {
            inside_tag = true;
        } else {
            out.push(ch);
        }
    }
    let out = decode_title_entities(&out);
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// The named entities openchamber's map covers (`&amp;` `&lt;` `&gt;` `&quot;`
/// `&#39;` `&apos;` `&nbsp;`). Numeric entities are rare in a title and stay
/// verbatim rather than mis-decoding. One pass, left to right: a chained
/// `replace` would decode `&amp;lt;` twice (to `<` where the page wrote the
/// literal entity `&lt;`).
fn decode_title_entities(text: &str) -> String {
    if !text.contains('&') {
        return text.to_string();
    }
    const NAMED: [(&str, &str); 7] = [
        ("&amp;", "&"),
        ("&lt;", "<"),
        ("&gt;", ">"),
        ("&quot;", "\""),
        ("&#39;", "'"),
        ("&apos;", "'"),
        ("&nbsp;", " "),
    ];
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(pos) = rest.find('&') {
        out.push_str(&rest[..pos]);
        let window = &rest[pos..];
        match NAMED.iter().find(|(entity, _)| window.starts_with(entity)) {
            Some((entity, decoded)) => {
                out.push_str(decoded);
                rest = &window[entity.len()..];
            }
            None => {
                out.push('&');
                rest = &window[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

/// True when a host's name for a tool is codeg's OWN `render_page` companion
/// tool, in whatever spelling the host composed it. Both halves required, and
/// the match is anchored at the END — same rules and same reasoning as
/// [`crate::acp::question::is_codeg_ask_tool_name`]. Auto-approving codeg's own
/// render tool is not a permission being skipped: its entire effect is to put a
/// page on the chat, and for a waiting page the user's answer IS the next
/// dialog.
pub fn is_codeg_render_tool_name(name: &str) -> bool {
    let normalized = name
        .trim()
        .to_ascii_lowercase()
        .replace(['-', ' ', '.', '/', ':'], "_");
    normalized.ends_with("render_page") && normalized.contains("codeg_mcp")
}

/// The persisted `render_page` settings.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RenderPageConfig {
    pub enabled: bool,
}

/// Shared, hot-swappable handle to [`RenderPageConfig`]. Cloned into
/// `DelegationInjection` (read at injection) and `AppState` (updated on save).
/// Mirrors [`crate::acp::question::QuestionRuntimeConfig`].
#[derive(Clone, Default)]
pub struct RenderPageRuntimeConfig {
    inner: Arc<RwLock<RenderPageConfig>>,
}

impl RenderPageRuntimeConfig {
    pub fn new() -> Self {
        Self::default()
    }

    pub async fn snapshot(&self) -> RenderPageConfig {
        self.inner.read().await.clone()
    }

    pub async fn set(&self, cfg: RenderPageConfig) {
        *self.inner.write().await = cfg;
    }

    /// Convenience read used at MCP injection time.
    pub async fn is_enabled(&self) -> bool {
        self.inner.read().await.enabled
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parse_happy_path_keeps_given_title() {
        let spec = parse_render_page_arguments(&json!({
            "html": "<html><body><h1>Hi</h1></body></html>",
            "title": "Cost breakdown",
            "awaitAnswer": true,
        }))
        .unwrap();
        assert_eq!(spec.title, "Cost breakdown");
        assert!(spec.await_answer);
        assert!(spec.html.contains("<h1>"));
    }

    #[test]
    fn parse_requires_html() {
        assert!(parse_render_page_arguments(&json!({ "title": "x" })).is_err());
        assert!(parse_render_page_arguments(&json!({ "html": "   " })).is_err());
    }

    #[test]
    fn parse_rejects_oversized_html_by_char_count_not_bytes() {
        let html = "é".repeat(MAX_HTML_CHARS + 1); // 2 bytes per char
        let err = parse_render_page_arguments(&json!({ "html": html })).unwrap_err();
        assert!(err.contains("the limit is 200000"), "{err}");
    }

    #[test]
    fn parse_rejects_stringified_await_answer() {
        let err =
            parse_render_page_arguments(&json!({ "html": "<b>x</b>", "awaitAnswer": "true" }))
                .unwrap_err();
        assert!(err.contains("must be a boolean"), "{err}");
    }

    #[test]
    fn parse_rejects_over_long_given_title() {
        let err = parse_render_page_arguments(&json!({
            "html": "<b>x</b>",
            "title": "t".repeat(MAX_TITLE_CHARS + 1),
        }))
        .unwrap_err();
        assert!(err.contains("120"), "{err}");
    }

    #[test]
    fn extracts_title_in_preference_order() {
        let with_both = "<html><head><title> Real Title </title></head><body><h1>Heading</h1>";
        assert_eq!(render_page_title_from_html(with_both).as_deref(), Some("Real Title"));
        let only_h2 = "<body><p>intro</p><h2 class='x'>Second <b>Level</b> &amp; more</h2></body>";
        assert_eq!(
            render_page_title_from_html(only_h2).as_deref(),
            Some("Second Level & more")
        );
        assert_eq!(render_page_title_from_html("<body><p>nothing</p></body>"), None);
        // An explicit title therefore wins over both; absent ones fall back.
        let spec = parse_render_page_arguments(&json!({ "html": with_both })).unwrap();
        assert_eq!(spec.title, "Real Title");
        let spec = parse_render_page_arguments(&json!({ "html": "<body>no headings</body>" }))
            .unwrap();
        assert_eq!(spec.title, FALLBACK_TITLE);
    }

    #[test]
    fn title_extraction_respects_tag_boundaries() {
        // `<time>` must not match a `<title` scan; `<hr>` must not match `<h1`.
        assert_eq!(render_page_title_from_html("<time>2:00</time>"), None);
        assert_eq!(render_page_title_from_html("<hr/>"), None);
        // Attribute-bearing open tags still match.
        assert_eq!(
            render_page_title_from_html(r#"<h1 id="x" class='y'>Heading</h1>"#).as_deref(),
            Some("Heading")
        );
        // Nested inline markup collapses; entities decode.
        assert_eq!(
            render_page_title_from_html("<title>a &lt;b&gt; &nbsp;c</title>").as_deref(),
            Some("a <b> c")
        );
    }

    #[test]
    fn a_gt_inside_an_attribute_is_not_the_tag_end() {
        // Agents write exactly this shape (`<code class="x>y">`); a scan that
        // ends the tag at the value's `>` leaks `y">` into the title.
        assert_eq!(
            render_page_title_from_html(r#"<title>Q&A <code class="x>y">a&gt;b</code> end</title>"#)
                .as_deref(),
            Some("Q&A a>b end")
        );
        assert_eq!(
            render_page_title_from_html(r#"<h1 id="x>y">Heading</h1>"#).as_deref(),
            Some("Heading")
        );
    }

    #[test]
    fn entities_decode_exactly_once() {
        // The page wrote the literal entity `&lt;` (escaped as `&amp;lt;`);
        // a chained replace would decode it twice and show a bare `<`.
        assert_eq!(
            render_page_title_from_html("<title>&amp;lt;b&amp;gt; & &amp;amp;</title>")
                .as_deref(),
            Some("&lt;b&gt; & &amp;")
        );
    }

    #[test]
    fn extraction_truncates_but_a_given_title_errors() {
        let long_title = "字".repeat(MAX_TITLE_CHARS + 50);
        assert_eq!(
            render_page_title_from_html(&format!("<title>{long_title}</title>"))
                .map(|t| t.chars().count()),
            Some(MAX_TITLE_CHARS)
        );
    }

    #[test]
    fn validate_page_bounds_the_socket_path() {
        assert!(validate_page("t", "<b>x</b>").is_ok());
        assert!(validate_page("", "x").is_err());
        assert!(validate_page("t", "  ").is_err());
        assert!(validate_page(&"t".repeat(MAX_TITLE_CHARS + 1), "x").is_err());
        assert!(validate_page("t", &"x".repeat(MAX_HTML_CHARS + 1)).is_err());
    }

    #[test]
    fn outcome_decline_carries_no_answer() {
        let o = build_render_outcome("T", &RenderPageAnswer {
            declined: true,
            ..Default::default()
        });
        assert!(!o.answered);
        assert_eq!(o.note.as_deref(), Some(DECLINED_NOTE));
    }

    #[test]
    fn outcome_truncates_summary_and_drops_oversized_data() {
        let o = build_render_outcome(
            "T",
            &RenderPageAnswer {
                summary: Some("s".repeat(MAX_SUMMARY_CHARS + 10)),
                data: Some(json!({ "ok": true })),
                declined: false,
            },
        );
        assert!(o.answered);
        assert_eq!(o.summary.chars().count(), MAX_SUMMARY_CHARS);
        assert_eq!(o.data, json!({ "ok": true }));

        let big = "d".repeat(MAX_ANSWER_DATA_CHARS + 1);
        let o = build_render_outcome(
            "T",
            &RenderPageAnswer {
                summary: None,
                data: Some(Value::String(big)),
                declined: false,
            },
        );
        assert!(o.answered);
        // A blank summary falls back to the page title, never to empty.
        assert_eq!(o.summary, "T");
        assert_eq!(o.data, Value::Null);
        assert!(o.note.unwrap().contains("dropped"));
    }

    #[test]
    fn is_codeg_render_tool_name_accepts_host_spellings() {
        for spelling in [
            "mcp__codeg-mcp__render_page",
            "codeg-mcp/render_page",
            "codeg-mcp: render_page",
            "MCP__Codeg-MCP__Render_Page",
        ] {
            assert!(is_codeg_render_tool_name(spelling), "{spelling}");
        }
        for other in [
            "mcp__other-server__render_page",
            "render_page",
            "mcp__codeg-mcp__ask_user_question",
            "mcp__codeg-mcp__render_page_again",
            "",
        ] {
            assert!(!is_codeg_render_tool_name(other), "{other}");
        }
    }
}
