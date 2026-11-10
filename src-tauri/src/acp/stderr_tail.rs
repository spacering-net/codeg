//! Per-connection agent stderr ring buffer + diagnostic redaction.
//!
//! When an agent reports `EndTurn` without producing any output, codeg
//! synthesizes an `"empty"` stop reason (see [`crate::acp::connection`]). The
//! ACP wire carries no error in that case — the agent said "success" — so the
//! only evidence available is out-of-band: what the agent printed to stderr,
//! and what codeg failed to parse. This module owns the collection of that
//! evidence.
//!
//! stderr is already tee'd to `tracing::debug!` at the three `with_debug`
//! branches in `connection.rs`, but the default log level is `Info`
//! (`crate::logging::LogLevel::default`), so those lines are dropped by the
//! `EnvFilter` before anyone can read them. Raising the level is not an option
//! (a debug-log storm once produced a 217 GB file), so the buffer lives in
//! memory and is independent of the subscriber.
//!
//! # Security model
//!
//! Everything collected here can end up rendered in the UI and, in server
//! mode, pushed over the WebSocket to attached clients. So **redaction happens
//! on write**: neither [`StderrTail`] nor the caller's turn probe ever holds
//! plaintext, and every read path is therefore safe by construction.
//!
//! Two redaction layers, because the two sources have different threat models:
//!
//! - [`sanitize_diagnostic`] — a denylist for agent stderr. Agent log lines are
//!   mostly free-form prose, and the realistic leak is a credential echoed into
//!   an error message (`invalid api_key=sk-…`). A denylist fits.
//! - [`summarize_parser_error`] — a **default-deny structural allowlist** for
//!   deserialization errors. Those inline the offending *value*, and that value
//!   comes off the `session/update` channel, which carries user prompt text,
//!   file contents, and tool arguments. A denylist cannot be sound there: the
//!   delimiter varies (`"…"`, `` `…` ``), escapes defeat naive matching, and a
//!   hand-written `Deserialize` can interpolate a value with no delimiter at
//!   all. So instead of scrubbing the text we rebuild it from templates, and
//!   anything unrecognized is discarded whole.

use std::collections::VecDeque;
use std::sync::{Mutex, OnceLock};

use regex::Regex;

/// Max lines retained. Bounds memory for a chatty agent; the tail is all
/// anyone reads.
const MAX_LINES: usize = 200;
/// Max total bytes retained across all lines.
const MAX_BYTES: usize = 32 * 1024;
/// Max bytes retained for a single line. Agents occasionally dump a whole JSON
/// blob on one line; keep the head, which is where the message lives.
const MAX_LINE_BYTES: usize = 512;
/// Upper bound on how much of an input line is scanned for redaction. Beyond
/// this the tail is discarded outright (never retained), so it bounds the
/// regex cost without opening a truncation-boundary leak.
const MAX_SCAN_BYTES: usize = 16 * 1024;
/// Max bytes for a summarized parser error.
const MAX_DROP_ERROR_BYTES: usize = 200;

/// Where a [`tail_since`](StderrTail::tail_since) slice came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TailScope {
    /// Lines emitted after the mark — i.e. during the turn being diagnosed.
    ThisTurn,
    /// The mark matched nothing, so this is the most recent output from
    /// *before* the turn (typically a connect-time failure). Rendered with a
    /// different label so the reader isn't told stale lines are fresh.
    Recent,
}

/// Result of [`StderrTail::tail_since`].
#[derive(Debug, Clone)]
pub struct TailSlice {
    pub lines: Vec<String>,
    pub scope: TailScope,
}

impl TailSlice {
    pub fn is_empty(&self) -> bool {
        self.lines.is_empty()
    }
}

/// Bounded ring buffer of an agent process's stderr, redacted on write.
///
/// Written from the `with_debug` callback, whose signature is a synchronous
/// `Fn(&str, LineDirection) + Send + Sync` (see `acp::agent_process`), so the
/// lock is a `std::sync::Mutex` — there is no `.await` inside and a tokio mutex
/// would not compile there.
#[derive(Debug, Default)]
pub struct StderrTail {
    inner: Mutex<TailInner>,
}

#[derive(Debug, Default)]
struct TailInner {
    lines: VecDeque<(u64, String)>,
    next_seq: u64,
    bytes: usize,
}

impl StderrTail {
    pub fn new() -> Self {
        Self::default()
    }

    /// Record one stderr line. ANSI-stripped, trimmed, redacted, and truncated
    /// before it lands — the buffer never holds plaintext.
    ///
    /// A poisoned lock is recovered rather than propagated: this is a
    /// diagnostic side channel and must never be able to take down a live
    /// agent connection.
    pub fn push(&self, raw: &str) {
        let line = strip_ansi(raw);
        let line = line.trim_end();
        if line.is_empty() {
            return;
        }
        // Bound the regex scan for a pathological multi-MB line. Whatever is
        // dropped here is dropped entirely — never retained unredacted — and
        // the surviving prefix is orders of magnitude shorter than this cap.
        let scanned = truncate_bytes(line, MAX_SCAN_BYTES);
        // Redact BEFORE truncating to the retained length. The other order
        // lets a credential straddling the cut survive as an unrecognized
        // fragment: `sk-…` needs 12 trailing chars to match, so a token sliced
        // at byte 512 would sail straight through the denylist.
        let line = sanitize_diagnostic(&scanned);
        let line = truncate_bytes(&line, MAX_LINE_BYTES);
        if line.is_empty() {
            return;
        }

        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let seq = inner.next_seq;
        inner.next_seq += 1;
        inner.bytes += line.len();
        inner.lines.push_back((seq, line));
        while inner.lines.len() > MAX_LINES || (inner.bytes > MAX_BYTES && inner.lines.len() > 1) {
            match inner.lines.pop_front() {
                Some((_, dropped)) => inner.bytes = inner.bytes.saturating_sub(dropped.len()),
                None => break,
            }
        }
    }

    /// Snapshot the current write position. Taken before a turn's prompt
    /// request is dispatched, so "this turn" has a defined lower bound.
    pub fn mark(&self) -> u64 {
        let inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        inner.next_seq
    }

    /// Lines recorded at or after `mark`, newest-last, capped.
    ///
    /// Falls back to the most recent lines overall when the turn itself
    /// produced no stderr — a connect-time failure is still the best evidence
    /// available — and says so via [`TailScope`].
    pub fn tail_since(&self, mark: u64, max_lines: usize, max_bytes: usize) -> TailSlice {
        let inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let this_turn: Vec<&String> = inner
            .lines
            .iter()
            .filter(|(seq, _)| *seq >= mark)
            .map(|(_, line)| line)
            .collect();
        let (source, scope) = if this_turn.is_empty() {
            (
                inner.lines.iter().map(|(_, line)| line).collect::<Vec<_>>(),
                TailScope::Recent,
            )
        } else {
            (this_turn, TailScope::ThisTurn)
        };

        // Take from the tail: the last lines before the turn ended are the
        // ones that explain why.
        let mut picked: Vec<String> = Vec::new();
        let mut used = 0usize;
        for line in source.iter().rev() {
            if picked.len() >= max_lines || used + line.len() > max_bytes {
                break;
            }
            used += line.len();
            picked.push((*line).clone());
        }
        picked.reverse();
        TailSlice {
            lines: picked,
            scope,
        }
    }
}

/// Strip ANSI escape sequences (CSI and OSC) that agents use for colored logs.
fn strip_ansi(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c != '\u{1b}' {
            out.push(c);
            continue;
        }
        match chars.peek() {
            // CSI: ESC [ ... final-byte in @-~
            Some('[') => {
                chars.next();
                for c in chars.by_ref() {
                    if ('\u{40}'..='\u{7e}').contains(&c) {
                        break;
                    }
                }
            }
            // OSC: ESC ] ... BEL or ESC \
            Some(']') => {
                chars.next();
                while let Some(c) = chars.next() {
                    if c == '\u{7}' {
                        break;
                    }
                    if c == '\u{1b}' && chars.peek() == Some(&'\\') {
                        chars.next();
                        break;
                    }
                }
            }
            // Two-character escape (ESC c, ESC =, …): drop the pair.
            Some(_) => {
                chars.next();
            }
            None => {}
        }
    }
    out
}

/// Truncate to at most `max` bytes without splitting a UTF-8 char.
fn truncate_bytes(s: &str, max: usize) -> String {
    if s.len() <= max {
        return s.to_string();
    }
    let end = s
        .char_indices()
        .take_while(|(i, c)| i + c.len_utf8() <= max)
        .last()
        .map(|(i, c)| i + c.len_utf8())
        .unwrap_or(0);
    let mut out = s[..end].to_string();
    out.push('…');
    out
}

/// Collapse runs of whitespace into single spaces.
fn collapse_whitespace(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

type Rules = Vec<(Regex, &'static str)>;

/// Credential-shaped patterns replaced in free-form diagnostic text.
///
/// Conservative by design — over-redacting a log line costs nothing, and this
/// is the only thing standing between an agent's error output and the UI.
fn denylist() -> &'static Rules {
    static RULES: OnceLock<Rules> = OnceLock::new();
    RULES.get_or_init(|| {
        let rules: Vec<(&str, &str)> = vec![
            // Header forms first: they subsume any scheme (Bearer/Basic/Digest/custom).
            // These consume to end of line, not `\S+`: a header value is
            // whitespace-separated from its scheme (`Authorization: Bearer <tok>`),
            // so stopping at the first space would leave the token behind.
            // Over-eating trailing context is the safe direction here.
            (r"(?i)\bauthorization\s*[:=]\s*.*", "Authorization: ***"),
            (r"(?i)\b(set-)?cookie\s*[:=]\s*.*", "${1}cookie: ***"),
            // Bare `Bearer <token>` with no header prefix.
            (r"(?i)\bbearer\s+[A-Za-z0-9._\-]{12,}", "Bearer ***"),
            // Named secrets in `k=v` / `k: v` form.
            (
                r"(?i)\b(api[_\-]?key|access[_\-]?token|auth[_\-]?token|refresh[_\-]?token|id[_\-]?token|client[_\-]?secret|secret|passwd|password|private[_\-]?key)\b\s*[:=]\s*\S+",
                "$1=***",
            ),
            // Credentials embedded in a URI authority.
            (
                r"([a-zA-Z][a-zA-Z0-9+.\-]*://)[^/\s:@]+:[^/\s@]+@",
                "${1}***:***@",
            ),
            // Same, but without the terminating `@`. The rule above needs that
            // terminator, so a very long password whose `@` falls past the scan
            // bound would go unmatched and its head would survive the retained
            // 512 bytes. Requiring 16+ non-`/` characters after the colon keeps
            // this off ordinary `host:port` URLs (a port is at most 5 digits and
            // is followed by `/` or end).
            (
                r"([a-zA-Z][a-zA-Z0-9+.\-]*://)[^/\s:@]+:[^/\s@]{16,}",
                "${1}***:***",
            ),
            // Well-known token shapes.
            (r"sk-[A-Za-z0-9_\-]{12,}", "sk-***"),
            (r"\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}", "${1}_***"),
            (r"\bxox[abprs]-[A-Za-z0-9\-]{10,}", "xox*-***"),
            (r"\bAKIA[0-9A-Z]{16}\b", "AKIA***"),
            (
                r"\beyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]+",
                "<jwt ***>",
            ),
            (
                r"-----BEGIN [A-Z ]*PRIVATE KEY-----",
                "-----BEGIN PRIVATE KEY (redacted)-----",
            ),
        ];
        rules
            .into_iter()
            .filter_map(|(pattern, replacement)| {
                // A malformed pattern must not take the process down; drop it
                // (the remaining rules still apply) and say so loudly.
                match Regex::new(pattern) {
                    Ok(re) => Some((re, replacement)),
                    Err(e) => {
                        tracing::error!("[stderr_tail] invalid redaction pattern {pattern:?}: {e}");
                        None
                    }
                }
            })
            .collect()
    })
}

/// Redact credential-shaped substrings from free-form diagnostic text.
///
/// Used for agent stderr, and as a final backstop after
/// [`summarize_parser_error`] has already rebuilt its input from templates.
pub fn sanitize_diagnostic(s: &str) -> String {
    let mut out = s.to_string();
    for (re, replacement) in denylist() {
        out = re.replace_all(&out, *replacement).into_owned();
    }
    out
}

/// serde's own `expecting` phrasings. Anything outside this set is treated as
/// potentially attacker-controlled — a hand-written `Deserialize::expecting`
/// (or the `&dyn Expected` argument of `invalid_value`) can be built at
/// runtime and interpolate the very payload we are trying to keep out.
const SAFE_EXPECT_PHRASES: &[&str] = &[
    "u8",
    "u16",
    "u32",
    "u64",
    "u128",
    "usize",
    "i8",
    "i16",
    "i32",
    "i64",
    "i128",
    "isize",
    "f32",
    "f64",
    "bool",
    "char",
    "string",
    "str",
    "unit",
    "option",
    "seq",
    "map",
    "integer",
    "boolean",
    "null",
    "byte array",
    "floating point number",
    "a string",
    "an integer",
    "a sequence",
    "a map",
    "a boolean",
    "a borrowed string",
    "a byte array",
    "a character",
    "unit struct",
    "newtype struct",
];

/// Identifiers from codeg's own ACP schema that are safe to echo back.
///
/// Drift (a new schema field not yet listed) degrades to `(redacted)` — a
/// failure on the safe side.
const SAFE_SCHEMA_IDENTS: &[&str] = &[
    "sessionId",
    "sessionUpdate",
    "update",
    "content",
    "role",
    "toolCallId",
    "toolCall",
    "status",
    "kind",
    "title",
    "rawInput",
    "rawOutput",
    "entries",
    "used",
    "size",
    "stopReason",
    "meta",
    "agent_message_chunk",
    "agent_thought_chunk",
    "user_message_chunk",
    "tool_call",
    "tool_call_update",
    "plan",
    "usage_update",
    "current_mode_update",
    "available_commands_update",
    "session_info_update",
    "config_option_update",
    "SessionNotification",
    "SessionUpdate",
    "ContentBlock",
    "ToolCall",
    "ToolCallUpdate",
];

fn is_safe_ident(s: &str) -> bool {
    SAFE_SCHEMA_IDENTS.contains(&s)
}

/// Whether an `expected …` clause may be echoed verbatim.
///
/// Accepts serde's static phrasings, `struct/enum/variant <Ident>` where the
/// identifier is one of ours, and `one of \`a\`, \`b\`` where **every** item is
/// one of ours. Everything else is rejected.
fn safe_expectation(exp: &str) -> bool {
    let exp = exp.trim().trim_end_matches(['.', ',']);
    if SAFE_EXPECT_PHRASES.contains(&exp) {
        return true;
    }
    for prefix in ["struct ", "enum ", "unit variant ", "struct variant "] {
        if let Some(ident) = exp.strip_prefix(prefix) {
            return is_safe_ident(ident.trim());
        }
    }
    if let Some(list) = exp.strip_prefix("one of ") {
        let mut any = false;
        for item in list.split(',') {
            let item = item.trim();
            let Some(ident) = item.strip_prefix('`').and_then(|i| i.strip_suffix('`')) else {
                return false;
            };
            if !is_safe_ident(ident) {
                return false;
            }
            any = true;
        }
        return any;
    }
    false
}

/// A recognized error shape: the regex (capturing only the `expected` clause),
/// the category to report, and whether the *subject* of the error is itself
/// payload. `unknown variant`/`unknown field` name a value that came off the
/// wire, so their subject is always dropped; `invalid type`/`invalid value`
/// name a type, which we drop anyway by not capturing it.
type ShapeRule = (Regex, &'static str, bool);

fn shape_rules() -> &'static Vec<ShapeRule> {
    static RULES: OnceLock<Vec<ShapeRule>> = OnceLock::new();
    RULES.get_or_init(|| {
        let specs: Vec<(&str, &str, bool)> = vec![
            (
                r"^invalid type:.*?,\s*expected\s+(?P<exp>.+)$",
                "invalid type",
                false,
            ),
            (
                r"^invalid value:.*?,\s*expected\s+(?P<exp>.+)$",
                "invalid value",
                false,
            ),
            (
                r"^invalid length.*?,\s*expected\s+(?P<exp>.+)$",
                "invalid length",
                false,
            ),
            (
                r"^unknown variant\s+`[^`]*`,\s*expected\s+(?P<exp>.+)$",
                "unknown variant",
                true,
            ),
            (
                r"^unknown field\s+`[^`]*`,\s*expected\s+(?P<exp>.+)$",
                "unknown field",
                true,
            ),
        ];
        specs
            .into_iter()
            .filter_map(
                |(pattern, category, subject_is_payload)| match Regex::new(pattern) {
                    Ok(re) => Some((re, category, subject_is_payload)),
                    Err(e) => {
                        tracing::error!("[stderr_tail] invalid shape pattern {pattern:?}: {e}");
                        None
                    }
                },
            )
            .collect()
    })
}

fn missing_field_rule() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^missing field\s+`(?P<field>[^`]*)`").unwrap())
}

fn position_rule() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"\bat line \d+ column \d+").unwrap())
}

/// serde_json syntax-error phrases that describe the *shape* of the input
/// without echoing any of it.
///
/// A match emits the phrase **and nothing else**. Matching a prefix says
/// nothing about the suffix: serde_json appends input-derived context to some
/// of these, and a custom error is free to start with one of these phrases and
/// continue with arbitrary payload. Forwarding the remainder would be a hole
/// straight through the default-deny design.
const SAFE_SYNTAX_PREFIXES: &[&str] = &[
    "EOF while parsing",
    "trailing characters",
    "expected value",
    "key must be a string",
    "control character",
    "invalid unicode code point",
    "number out of range",
    "recursion limit exceeded",
];

/// Reduce a deserialization error to a bounded, payload-free summary.
///
/// **Default deny.** The input is never scrubbed and forwarded; it is matched
/// against a closed set of shapes and *rebuilt* from templates, with every
/// retained fragment checked against a finite allowlist. An error that matches
/// nothing collapses to `unrecognized parse error (redacted)`.
///
/// This costs readability for custom `Deserialize` impls, deliberately: the
/// dropped-update *counts* already carry the "protocol mismatch" conclusion,
/// and the raw text is still in the log file. What it buys is the certainty
/// that arbitrary `session/update` payload can never reach the UI or the
/// WebSocket.
pub fn summarize_parser_error(e: &str) -> String {
    let first = e.lines().next().unwrap_or("").trim();
    let first = collapse_whitespace(first);
    let position = position_rule()
        .find(&first)
        .map(|m| m.as_str().to_string())
        .unwrap_or_default();

    let body = summarize_body(&first);
    let mut out = body;
    if !position.is_empty() {
        out.push(' ');
        out.push_str(&position);
    }
    // Backstop. By construction there should be nothing left to redact.
    let out = sanitize_diagnostic(&out);
    truncate_bytes(&out, MAX_DROP_ERROR_BYTES)
}

fn summarize_body(first: &str) -> String {
    if let Some(caps) = missing_field_rule().captures(first) {
        let field = caps.name("field").map(|m| m.as_str()).unwrap_or("");
        return if is_safe_ident(field) {
            format!("missing field `{field}`")
        } else {
            "missing field (redacted)".to_string()
        };
    }

    for (re, category, subject_is_payload) in shape_rules() {
        let Some(caps) = re.captures(first) else {
            continue;
        };
        let exp = caps
            .name("exp")
            .map(|m| m.as_str())
            .unwrap_or("")
            // The position suffix is appended separately; don't fold it into
            // the expectation (it would never match the allowlist).
            .trim();
        let exp = position_rule().replace(exp, "").trim().to_string();
        let exp = exp.trim_end_matches(',').trim().to_string();
        if !safe_expectation(&exp) {
            // Nothing survives: neither the subject (never captured) nor the
            // expectation. Report the category alone.
            return format!("{category} (redacted)");
        }
        let head = if *subject_is_payload {
            format!("{category} (redacted)")
        } else {
            (*category).to_string()
        };
        return format!("{head}, expected {exp}");
    }

    // Anchored at the start, and the phrase is all that survives. `contains`
    // would let a custom error smuggle itself in by merely mentioning one of
    // these; forwarding the suffix would let it smuggle payload in after one.
    // Position info is re-appended by the caller.
    if let Some(phrase) = SAFE_SYNTAX_PREFIXES.iter().find(|p| first.starts_with(**p)) {
        return (*phrase).to_string();
    }

    "unrecognized parse error (redacted)".to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    // ---- StderrTail ----

    #[test]
    fn push_strips_ansi_and_drops_blank_lines() {
        let tail = StderrTail::new();
        tail.push("\u{1b}[31mboom\u{1b}[0m");
        tail.push("   ");
        tail.push("");
        tail.push("\u{1b}]0;title\u{7}second");
        let slice = tail.tail_since(0, 10, 4096);
        assert_eq!(slice.lines, vec!["boom", "second"]);
    }

    #[test]
    fn push_truncates_long_line_on_char_boundary() {
        let tail = StderrTail::new();
        tail.push(&"中".repeat(400)); // 1200 bytes
        let slice = tail.tail_since(0, 10, 8192);
        assert_eq!(slice.lines.len(), 1);
        let line = &slice.lines[0];
        assert!(line.len() <= MAX_LINE_BYTES + '…'.len_utf8());
        assert!(line.ends_with('…'));
        // Round-trips as valid UTF-8 with no replacement chars.
        assert!(!line.contains('\u{fffd}'));
    }

    #[test]
    fn evicts_oldest_beyond_line_cap() {
        let tail = StderrTail::new();
        for i in 0..(MAX_LINES + 50) {
            tail.push(&format!("line-{i}"));
        }
        let slice = tail.tail_since(0, MAX_LINES + 100, 1024 * 1024);
        assert_eq!(slice.lines.len(), MAX_LINES);
        assert_eq!(slice.lines[0], format!("line-{}", 50));
        assert_eq!(
            slice.lines[MAX_LINES - 1],
            format!("line-{}", MAX_LINES + 49)
        );
    }

    #[test]
    fn evicts_beyond_byte_cap() {
        let tail = StderrTail::new();
        // 100 lines x ~500 bytes = ~50 KB > MAX_BYTES (32 KB).
        for i in 0..100 {
            tail.push(&format!("{i:04}{}", "x".repeat(496)));
        }
        let inner = tail.inner.lock().unwrap();
        assert!(inner.bytes <= MAX_BYTES, "bytes={} ", inner.bytes);
        assert!(inner.lines.len() < 100);
    }

    #[test]
    fn tail_since_scopes_to_this_turn() {
        let tail = StderrTail::new();
        tail.push("before-1");
        tail.push("before-2");
        let mark = tail.mark();
        tail.push("during-1");
        let slice = tail.tail_since(mark, 10, 4096);
        assert_eq!(slice.scope, TailScope::ThisTurn);
        assert_eq!(slice.lines, vec!["during-1"]);
    }

    #[test]
    fn tail_since_falls_back_to_recent_when_turn_silent() {
        let tail = StderrTail::new();
        tail.push("before-1");
        let mark = tail.mark();
        let slice = tail.tail_since(mark, 10, 4096);
        assert_eq!(slice.scope, TailScope::Recent);
        assert_eq!(slice.lines, vec!["before-1"]);
    }

    #[test]
    fn tail_since_is_empty_when_nothing_recorded() {
        let tail = StderrTail::new();
        let slice = tail.tail_since(tail.mark(), 10, 4096);
        assert!(slice.is_empty());
    }

    #[test]
    fn tail_since_takes_from_the_end() {
        let tail = StderrTail::new();
        for i in 0..10 {
            tail.push(&format!("l{i}"));
        }
        let slice = tail.tail_since(0, 3, 4096);
        assert_eq!(slice.lines, vec!["l7", "l8", "l9"]);
    }

    #[test]
    fn concurrent_push_does_not_panic() {
        use std::sync::Arc;
        let tail = Arc::new(StderrTail::new());
        let handles: Vec<_> = (0..8)
            .map(|t| {
                let tail = Arc::clone(&tail);
                std::thread::spawn(move || {
                    for i in 0..200 {
                        tail.push(&format!("thread-{t}-{i}"));
                    }
                })
            })
            .collect();
        for h in handles {
            h.join().unwrap();
        }
        let slice = tail.tail_since(0, MAX_LINES, MAX_BYTES);
        assert_eq!(slice.lines.len(), MAX_LINES);
    }

    #[test]
    fn poisoned_lock_still_serves_reads() {
        use std::sync::Arc;
        let tail = Arc::new(StderrTail::new());
        tail.push("survivor");
        let poisoner = Arc::clone(&tail);
        let _ = std::thread::spawn(move || {
            let _guard = poisoner.inner.lock().unwrap();
            panic!("poison the mutex");
        })
        .join();
        assert!(tail.inner.is_poisoned());
        tail.push("after-poison");
        let slice = tail.tail_since(0, 10, 4096);
        assert_eq!(slice.lines, vec!["survivor", "after-poison"]);
    }

    // ---- sanitize_diagnostic ----

    #[test]
    fn redacts_known_token_shapes() {
        let cases = [
            ("key sk-live-abcdefghijklmno here", "sk-live-abcdefghijklmno"),
            (
                "token ghp_abcdefghijklmnopqrstuvwxyz01",
                "ghp_abcdefghijklmnopqrstuvwxyz01",
            ),
            ("slack xoxb-1234567890-abcdef", "xoxb-1234567890-abcdef"),
            ("aws AKIAIOSFODNN7EXAMPLE", "AKIAIOSFODNN7EXAMPLE"),
        ];
        for (input, secret) in cases {
            let out = sanitize_diagnostic(input);
            assert!(!out.contains(secret), "leaked {secret:?} in {out:?}");
        }
    }

    #[test]
    fn redacts_header_and_uri_credential_forms() {
        let cases = [
            ("Authorization: Basic dXNlcjpwYXNzd29yZA==", "dXNlcjpwYXNz"),
            ("authorization=Bearer abcdefghijklmnop", "abcdefghijklmnop"),
            ("Cookie: session=deadbeefdeadbeef", "deadbeefdeadbeef"),
            ("Set-Cookie: sid=abcdef123456", "abcdef123456"),
            ("connect https://user:hunter2@example.com/x", "hunter2"),
            ("Bearer abcdefghijklmnopqrst failed", "abcdefghijklmnopqrst"),
        ];
        for (input, secret) in cases {
            let out = sanitize_diagnostic(input);
            assert!(!out.contains(secret), "leaked {secret:?} in {out:?}");
        }
    }

    #[test]
    fn redacts_named_secret_assignments_and_keys() {
        let cases = [
            ("invalid api_key=sk_test_abcdef", "sk_test_abcdef"),
            ("apiKey: zzzzzzzzzzzz", "zzzzzzzzzzzz"),
            ("access_token = qqqqqqqqqqqq", "qqqqqqqqqqqq"),
            ("password: hunter2hunter2", "hunter2hunter2"),
            (
                "jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.abc",
                "eyJzdWIiOiIxMjM0NSJ9",
            ),
        ];
        for (input, secret) in cases {
            let out = sanitize_diagnostic(input);
            assert!(!out.contains(secret), "leaked {secret:?} in {out:?}");
        }
        assert!(sanitize_diagnostic("-----BEGIN RSA PRIVATE KEY-----").contains("(redacted)"));
    }

    #[test]
    fn leaves_benign_text_alone() {
        for benign in [
            "skipped 3 files",
            "token_count=12",
            "Authorization header missing",
            "reading package.json",
        ] {
            assert_eq!(sanitize_diagnostic(benign), benign, "mangled {benign:?}");
        }
    }

    // ---- summarize_parser_error ----

    #[test]
    fn summarizes_invalid_type_and_keeps_position() {
        let out = summarize_parser_error(
            r#"invalid type: string "sk-live-abcdefghijkl", expected u64 at line 1 column 40"#,
        );
        assert_eq!(out, "invalid type, expected u64 at line 1 column 40");
        assert!(!out.contains("sk-live"));
    }

    #[test]
    fn redacts_backticked_variant_payload() {
        let out = summarize_parser_error(
            "unknown variant `sk-live-abcdefghijkl`, expected one of `plan`, `usage_update`",
        );
        assert_eq!(
            out,
            "unknown variant (redacted), expected one of `plan`, `usage_update`"
        );
        assert!(!out.contains("sk-live"));
    }

    #[test]
    fn redacts_unknown_field_payload() {
        let out = summarize_parser_error(
            "unknown field `sk-live-abcdefghijkl`, expected `sessionUpdate`",
        );
        assert!(out.starts_with("unknown field (redacted)"));
        assert!(!out.contains("sk-live"));
    }

    #[test]
    fn keeps_schema_derived_missing_field() {
        assert_eq!(
            summarize_parser_error("missing field `sessionUpdate` at line 1 column 2"),
            "missing field `sessionUpdate` at line 1 column 2"
        );
    }

    #[test]
    fn redacts_missing_field_outside_allowlist() {
        let out = summarize_parser_error("missing field `sk_live_abcdefghijkl`");
        assert_eq!(out, "missing field (redacted)");
        assert!(!out.contains("sk_live"));
    }

    #[test]
    fn rejects_expectation_outside_finite_allowlist() {
        // A hand-written `expecting()` can interpolate payload using only
        // "legal" characters — the charset alone proves nothing.
        let out = summarize_parser_error(
            "invalid type: map, expected sk-live-abcdefghijkl at line 1 column 40",
        );
        assert_eq!(out, "invalid type (redacted) at line 1 column 40");
        assert!(!out.contains("sk-live"));
    }

    #[test]
    fn rejects_variant_list_with_one_unknown_item() {
        let out = summarize_parser_error(
            "unknown variant `x`, expected one of `plan`, `sk_live_abcdefghijkl`",
        );
        assert_eq!(out, "unknown variant (redacted)");
        assert!(!out.contains("sk_live"));
    }

    #[test]
    fn unquoted_interpolation_falls_through_to_default_deny() {
        let out = summarize_parser_error("custom deserializer failed on sk-live-abcdefghijkl");
        assert_eq!(out, "unrecognized parse error (redacted)");
    }

    #[test]
    fn escaped_quotes_do_not_leak() {
        let out = summarize_parser_error(
            r#"invalid value: string "a\"sk-live-abcdefghijkl", expected a string"#,
        );
        assert!(!out.contains("sk-live"), "leaked in {out:?}");
        assert_eq!(out, "invalid value, expected a string");
    }

    #[test]
    fn keeps_only_the_first_line() {
        let out = summarize_parser_error(
            "invalid type: string, expected u64\n  at Foo::deserialize (sk-live-abcdefghijkl)",
        );
        assert!(!out.contains("sk-live"));
        assert_eq!(out, "invalid type, expected u64");
    }

    #[test]
    fn keeps_payload_free_syntax_errors() {
        assert_eq!(
            summarize_parser_error("EOF while parsing a value at line 1 column 3"),
            "EOF while parsing at line 1 column 3"
        );
        assert_eq!(
            summarize_parser_error("trailing characters at line 2 column 1"),
            "trailing characters at line 2 column 1"
        );
    }

    /// Matching a safe phrase says nothing about what follows it: serde_json
    /// appends input-derived context to some of these, and a custom error can
    /// open with the phrase and continue with anything at all.
    #[test]
    fn syntax_prefix_match_drops_the_suffix() {
        let out =
            summarize_parser_error("EOF while parsing customer prompt: sk-live-abcdefghijklmnop");
        assert_eq!(out, "EOF while parsing");

        let out = summarize_parser_error("expected value, got confidential user text here");
        assert_eq!(out, "expected value");
    }

    /// Truncating before redacting would slice a token below the length its
    /// pattern requires, letting the fragment through unrecognized.
    #[test]
    fn redacts_before_truncating_so_a_split_secret_cannot_survive() {
        const SECRET: &str = "sk-live-abcdefghijklmnopqrstuvwxyz";
        let tail = StderrTail::new();
        // Place the secret so it straddles MAX_LINE_BYTES.
        let prefix = "x".repeat(MAX_LINE_BYTES - 10);
        tail.push(&format!("{prefix}{SECRET} trailing"));

        let slice = tail.tail_since(0, 10, 8192);
        let line = &slice.lines[0];
        assert!(!line.contains("sk-live"), "leaked fragment in {line:?}");
        assert!(line.contains("sk-***"), "expected redaction marker in {line:?}");
    }

    #[test]
    fn redacts_a_uri_credential_straddling_the_retained_length() {
        let tail = StderrTail::new();
        let prefix = "y".repeat(MAX_LINE_BYTES - 20);
        tail.push(&format!("{prefix}https://user:hunter2secret@example.com/x"));

        let slice = tail.tail_since(0, 10, 8192);
        let line = &slice.lines[0];
        assert!(!line.contains("hunter2secret"), "leaked in {line:?}");
    }

    /// A password long enough to push its terminating `@` past the scan bound
    /// defeats the `@`-anchored rule; the head of the password would otherwise
    /// survive into the retained prefix.
    #[test]
    fn redacts_a_uri_credential_whose_terminator_is_past_the_scan_bound() {
        let tail = StderrTail::new();
        let prefix = "z".repeat(MAX_LINE_BYTES - 30);
        let password = "P".repeat(MAX_SCAN_BYTES);
        tail.push(&format!("{prefix}https://user:{password}@example.com/x"));

        let slice = tail.tail_since(0, 10, 8192);
        let line = &slice.lines[0];
        assert!(!line.contains("PPPP"), "leaked password head in {line:?}");
        assert!(line.contains("***:***"), "expected redaction in {line:?}");
    }

    #[test]
    fn does_not_mangle_an_ordinary_host_port_url() {
        for benign in [
            "fetching https://example.com:8080/v1/models",
            "listening on http://127.0.0.1:3000",
        ] {
            assert_eq!(sanitize_diagnostic(benign), benign, "mangled {benign:?}");
        }
    }

    #[test]
    fn truncates_to_bound_without_splitting_utf8() {
        let long = format!("custom failure {}", "中".repeat(400));
        let out = summarize_parser_error(&long);
        assert!(out.len() <= MAX_DROP_ERROR_BYTES + '…'.len_utf8());
        assert!(!out.contains('\u{fffd}'));
    }

    /// The load-bearing invariant: whatever path a parser error takes, the
    /// original secret must not survive into the output.
    #[test]
    fn never_echoes_the_original_secret() {
        const SECRET: &str = "sk-live-abcdefghijklmnop";
        let inputs = [
            format!(r#"invalid type: string "{SECRET}", expected u64"#),
            format!("unknown variant `{SECRET}`, expected one of `plan`"),
            format!("unknown field `{SECRET}`, expected `sessionUpdate`"),
            format!("missing field `{SECRET}`"),
            format!("invalid value: string, expected {SECRET}"),
            format!("weird custom error mentioning {SECRET} inline"),
            format!("invalid length 3, expected {SECRET} at line 9 column 9"),
            format!("EOF while parsing {SECRET}"),
        ];
        for input in inputs {
            let out = summarize_parser_error(&input);
            assert!(!out.contains(SECRET), "leaked from {input:?} -> {out:?}");
        }
    }
}
