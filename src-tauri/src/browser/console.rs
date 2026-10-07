//! What a page printed, kept for the agent that has been given the page.
//!
//! Every tab holds a small ring of the lines its current document wrote to
//! the console — `console.log` and friends, uncaught exceptions, unhandled
//! rejections, resource loads that failed — so that an agent asked "why is
//! this page broken" can be told what the page itself said, the way a person
//! would open the developer tools and look.
//!
//! Where the lines come from differs by engine, and the ring does not care:
//! on WebKit (macOS, Linux) a page-world shim relays `console.*` calls to the
//! isolated-world helper, which forwards them as `console` channel messages;
//! on WebView2 the engine reports them over CDP (`Runtime.consoleAPICalled`,
//! `Runtime.exceptionThrown`) and the shim translates those into the same
//! lines. Both arrive here as a [`ReportedLine`].
//!
//! Three properties the rest of the browser relies on:
//!
//! * **The ring is per document.** It is cleared when a new document commits
//!   in the tab, like a developer console without "preserve log": the agent
//!   reads the console of the page that is on screen, not a scrollback that
//!   spans sites. Clearing is the caller's job (`hooks::page_load`), because
//!   only it knows when that happens.
//! * **Every line remembers the origin that printed it,** and a read hands
//!   out only the lines whose origin the tab's grant covers. The clear above
//!   makes a cross-origin leak unlikely; this makes it impossible — a line
//!   from an embedded frame on another site, or one that slipped in around a
//!   navigation, is never given to an agent that was granted a different site.
//! * **Nothing here is trusted.** The text is what the page chose to print,
//!   and on WebKit the page can dispatch the relay event itself. The lines
//!   are data about the page, never instructions, and the tool that hands
//!   them out says so.
//!
//! Bounded on every axis a page controls: lines per ring, characters per
//! line, and (in the helper) lines per second. What the bounds discard is
//! counted, so an agent that sees `dropped: 340` knows the page was loud
//! rather than quiet.

use std::collections::VecDeque;

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Lines kept per tab. A page that has printed more than this since it
/// loaded has said its piece; what an agent needs is the most recent of it.
pub const CONSOLE_RING_CAPACITY: usize = 200;

/// Characters kept of one line. A dumped object or a stack trace is cut here;
/// the helper cuts at the same length before sending, so this is the floor
/// for a source that did not.
pub const CONSOLE_MAX_TEXT_CHARS: usize = 4096;

/// How many lines a read returns when the caller names no limit.
pub const DEFAULT_CONSOLE_LIMIT: usize = 100;

/// Lines the host accepts per tab per second, from all of the tab's frames
/// together. The helper budgets itself per frame; a page with many frames
/// could add those budgets up, so the ring keeps a budget of its own that no
/// number of frames can exceed. What it turns away is counted as dropped.
pub const CONSOLE_HOST_BUDGET_PER_SECOND: u32 = 300;

/// Characters kept of one piece of a CDP line — one argument's rendering,
/// one description — before the pieces are joined and the whole is capped
/// again. The engine can hand over a megabyte string; nothing here should
/// copy it whole.
pub const CDP_MAX_PIECE_CHARS: usize = 1024;

/// Arguments of one CDP console call that are rendered; the rest are
/// counted.
pub const CDP_MAX_ARGS: usize = 32;

/// Properties or entries of a CDP object preview that are rendered.
pub const CDP_MAX_PREVIEW_ITEMS: usize = 20;

/// The most one message may claim to have dropped. The count is the
/// sender's word; a frame that says it dropped a trillion lines is not
/// believed past this, so the number an agent sees stays a number.
pub const CONSOLE_MAX_REPORTED_DROP: u64 = 100_000;

/// A CDP console or exception event larger than this is not parsed at all.
/// Every field of it would be cut to a few kilobytes anyway; what an event
/// this size costs is the parse, on the main thread, and the engine will
/// send another one for the next line.
pub const CDP_MAX_EVENT_BYTES: usize = 256 * 1024;

/// Severity, in the order a `minLevel` filter compares it: everything from
/// `Debug` up.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ConsoleLevel {
    Debug,
    Log,
    Info,
    Warn,
    Error,
}

impl ConsoleLevel {
    pub fn parse(raw: &str) -> Option<Self> {
        match raw {
            "debug" => Some(Self::Debug),
            "log" => Some(Self::Log),
            "info" => Some(Self::Info),
            "warn" | "warning" => Some(Self::Warn),
            "error" => Some(Self::Error),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Debug => "debug",
            Self::Log => "log",
            Self::Info => "info",
            Self::Warn => "warn",
            Self::Error => "error",
        }
    }
}

/// Where a line came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ConsoleSource {
    /// A `console.*` call.
    Console,
    /// An exception nothing caught.
    Exception,
    /// A promise rejection nothing handled.
    Rejection,
    /// A resource (`<img>`, `<script>`, `<link>`) that failed to load.
    Resource,
}

impl ConsoleSource {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Console => "console",
            Self::Exception => "exception",
            Self::Rejection => "rejection",
            Self::Resource => "resource",
        }
    }

    fn parse(raw: &str) -> Option<Self> {
        match raw {
            "console" => Some(Self::Console),
            "exception" => Some(Self::Exception),
            "rejection" => Some(Self::Rejection),
            "resource" => Some(Self::Resource),
            _ => None,
        }
    }
}

/// One line as an agent reads it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsoleEntry {
    /// Position in this tab's stream, increasing across clears. A reader
    /// that remembers the last one it saw asks for `since` it.
    pub seq: u64,
    /// Unix milliseconds, host clock, when the line arrived.
    pub at: i64,
    pub level: ConsoleLevel,
    pub source: ConsoleSource,
    pub text: String,
    /// The script that printed or threw it, when known.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub line: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub column: Option<u32>,
    /// Printed by the top-level document rather than a frame in it.
    pub top: bool,
    /// The origin of the document that printed it — what a read is filtered
    /// by. Kept off the wire: the agent only ever sees lines from the origin
    /// it was granted, so it would say the same thing on every line.
    #[serde(skip)]
    pub origin: Option<String>,
}

/// A line as it arrives from an engine or the helper, before the ring has
/// given it a place in the stream.
#[derive(Debug, Clone, PartialEq)]
pub struct ReportedLine {
    pub at: i64,
    pub level: ConsoleLevel,
    pub source: ConsoleSource,
    pub text: String,
    pub url: Option<String>,
    pub line: Option<u32>,
    pub column: Option<u32>,
    pub top: bool,
    pub origin: Option<String>,
    /// Lines the sender discarded before this one (the helper's per-second
    /// budget). Added to the ring's count.
    pub dropped: u64,
}

/// What a read asks for.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsoleQuery {
    /// Only lines after this `seq`. `0` is everything the ring holds.
    #[serde(default)]
    pub since: u64,
    /// Only lines at this level or above. Absent is everything.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub min_level: Option<ConsoleLevel>,
    /// At most this many lines, oldest first. Absent is
    /// [`DEFAULT_CONSOLE_LIMIT`]; `0` is treated the same.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<usize>,
}

/// What a read answers.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsoleReadout {
    /// Where the tab was when the lines were read.
    pub url: String,
    /// Oldest first.
    pub entries: Vec<ConsoleEntry>,
    /// Lines this document printed that are not in the ring any more, or
    /// never reached it: evicted by newer ones, or over the sender's budget.
    pub dropped: u64,
    /// The `since` to pass next time to see only what came after this read.
    pub next_since: u64,
    /// Whether lines matching the query remain beyond `limit`.
    pub more: bool,
}

/// The ring itself. One per tab.
#[derive(Debug)]
pub struct ConsoleRing {
    entries: VecDeque<ConsoleEntry>,
    next_seq: u64,
    dropped: u64,
    /// The second the host budget is being counted in, and how many lines it
    /// has admitted in it.
    window_start: i64,
    window_count: u32,
    /// How many error lines this document has printed, counted whether or not
    /// the line itself survived the budget or the ring. It answers "did
    /// anything break on this page", which is a different question from
    /// "which lines can still be read" and must not quietly become false
    /// because a chatty page pushed the error out.
    errors: u64,
}

impl Default for ConsoleRing {
    fn default() -> Self {
        Self::new()
    }
}

impl ConsoleRing {
    pub fn new() -> Self {
        Self {
            entries: VecDeque::with_capacity(CONSOLE_RING_CAPACITY),
            // Seqs start at 1 so that `since: 0` means "everything" and never
            // names a real line.
            next_seq: 1,
            dropped: 0,
            window_start: i64::MIN,
            window_count: 0,
            errors: 0,
        }
    }

    /// Record a line and return its seq, or `None` when it is not kept.
    ///
    /// Every arriving line is charged against the host budget for this
    /// second first, admissible or not: the budget bounds what the tab's
    /// frames may make the host handle, and a frame on another origin is
    /// still one of the tab's frames. Only an admissible line is then
    /// stored, or counted as dropped when the budget is spent; a line that
    /// was never eligible is neither. The oldest line makes room when the
    /// ring is full, and is counted.
    pub fn push(&mut self, line: ReportedLine, admissible: bool) -> Option<u64> {
        if line.at < self.window_start || line.at.saturating_sub(self.window_start) >= 1000 {
            self.window_start = line.at;
            self.window_count = 0;
        }
        let over_budget = self.window_count >= CONSOLE_HOST_BUDGET_PER_SECOND;
        self.window_count = self.window_count.saturating_add(1);
        if !admissible {
            return None;
        }
        if line.level == ConsoleLevel::Error {
            self.errors = self.errors.saturating_add(1);
        }
        self.dropped = self.dropped.saturating_add(line.dropped);
        if over_budget {
            self.dropped = self.dropped.saturating_add(1);
            return None;
        }
        if self.entries.len() >= CONSOLE_RING_CAPACITY {
            self.entries.pop_front();
            self.dropped = self.dropped.saturating_add(1);
        }
        let seq = self.next_seq;
        self.next_seq += 1;
        self.entries.push_back(ConsoleEntry {
            seq,
            at: line.at,
            level: line.level,
            source: line.source,
            text: cap_text(line.text),
            url: line.url.map(|u| piece(&u, 1024)),
            line: line.line,
            column: line.column,
            top: line.top,
            origin: line.origin.map(|o| piece(&o, CONSOLE_MAX_ORIGIN_CHARS)),
        });
        Some(seq)
    }

    /// Lines a sender discarded before it could report them on a line of
    /// their own (the helper's budget, flushed after a burst that ended in
    /// silence).
    pub fn note_dropped(&mut self, count: u64) {
        self.dropped = self.dropped.saturating_add(count);
    }

    /// Forget every line: a new document is in the tab. The seq keeps
    /// counting, so a reader's `since` from before the clear still means
    /// "after what I saw" and never replays under new numbers.
    pub fn clear(&mut self) {
        self.entries.clear();
        self.dropped = 0;
        self.errors = 0;
    }

    /// How many error lines the current document has printed.
    pub fn errors(&self) -> u64 {
        self.errors
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// The lines matching `query` whose origin `covers` accepts, oldest first,
    /// at most the query's limit. `url` is the tab's address, reported back.
    pub fn read(
        &self,
        query: &ConsoleQuery,
        url: &str,
        covers: impl Fn(Option<&str>) -> bool,
    ) -> ConsoleReadout {
        let limit = match query.limit {
            Some(0) | None => DEFAULT_CONSOLE_LIMIT,
            Some(n) => n,
        };
        let min_level = query.min_level.unwrap_or(ConsoleLevel::Debug);
        let mut matching = self.entries.iter().filter(|e| {
            e.seq > query.since && e.level >= min_level && covers(e.origin.as_deref())
        });
        let entries: Vec<ConsoleEntry> = matching.by_ref().take(limit).cloned().collect();
        let more = matching.next().is_some();
        let next_since = entries.last().map_or(query.since, |e| e.seq);
        ConsoleReadout {
            url: url.to_string(),
            entries,
            dropped: self.dropped,
            next_since,
            more,
        }
    }
}

/// Whether a line from `line_origin` belongs in the ring of a tab now at
/// `tab_origin`. Only a line from the tab's own origin does: the read hands
/// out only lines the grant covers, and the grant covers only the tab's
/// origin, so a line from anywhere else could never be read — storing it
/// would only let a chatty frame on another site push the page's own lines
/// out. An opaque origin on either side is never a match.
pub fn admissible(tab_origin: Option<&str>, line_origin: Option<&str>) -> bool {
    matches!((tab_origin, line_origin), (Some(tab), Some(line)) if tab == line)
}

/// Cut a line to [`CONSOLE_MAX_TEXT_CHARS`], on a character boundary.
fn cap_text(text: String) -> String {
    if text.chars().count() <= CONSOLE_MAX_TEXT_CHARS {
        return text;
    }
    let mut out: String = text.chars().take(CONSOLE_MAX_TEXT_CHARS).collect();
    out.push('…');
    out
}

/// The first `limit` characters of a piece the engine handed over, with a
/// mark when it was cut.
fn piece(text: &str, limit: usize) -> String {
    let mut chars = text.chars();
    let mut out: String = chars.by_ref().take(limit).collect();
    if chars.next().is_some() {
        out.push('…');
    }
    out
}

fn string_field(payload: &Value, key: &str, max_chars: usize) -> Option<String> {
    let s = payload.get(key)?.as_str()?;
    Some(if s.chars().count() > max_chars {
        s.chars().take(max_chars).collect()
    } else {
        s.to_string()
    })
}

fn u32_field(payload: &Value, key: &str) -> Option<u32> {
    payload
        .get(key)
        .and_then(Value::as_u64)
        .and_then(|n| u32::try_from(n).ok())
}

/// A `console` channel message from the helper, checked field by field.
///
/// `top` is the engine's word on which frame spoke, never the payload's;
/// `origin` is derived by the caller from the `href` the helper read in its
/// own world (the caller has the URL parser; this module does not). `None`
/// for a payload that is not a line: no level, or one this module does not
/// know. Everything else has a default, because a line with a missing detail
/// is still a line.
pub fn parse_reported(payload: &Value, top: bool, at: i64, origin: Option<String>) -> Option<ReportedLine> {
    let level = ConsoleLevel::parse(payload.get("level")?.as_str()?)?;
    let source = payload
        .get("source")
        .and_then(Value::as_str)
        .and_then(ConsoleSource::parse)
        .unwrap_or(ConsoleSource::Console);
    Some(ReportedLine {
        at,
        level,
        source,
        text: string_field(payload, "text", CONSOLE_MAX_TEXT_CHARS).unwrap_or_default(),
        url: string_field(payload, "url", 1024),
        line: u32_field(payload, "line"),
        column: u32_field(payload, "column"),
        top,
        origin,
        dropped: reported_drop(payload),
    })
}

/// The `dropped` count a message claims, bounded.
pub fn reported_drop(payload: &Value) -> u64 {
    payload
        .get("dropped")
        .and_then(Value::as_u64)
        .unwrap_or(0)
        .min(CONSOLE_MAX_REPORTED_DROP)
}

// ---------------------------------------------------------------------------
// CDP (WebView2)
// ---------------------------------------------------------------------------

/// Lines of a stack or a description worth keeping: the first few frames are
/// what an agent can act on; the fortieth is a framework's business.
const STACK_LINES_KEPT: usize = 8;

fn first_lines(text: &str) -> String {
    let mut lines = text.lines();
    let kept: Vec<&str> = lines.by_ref().take(STACK_LINES_KEPT).collect();
    let mut out = kept.join("\n");
    if lines.next().is_some() {
        out.push_str("\n…");
    }
    out
}

/// The level a `Runtime.consoleAPICalled` `type` maps to, or `None` for the
/// calls that print nothing (`clear`, `startGroup`, `count`, `timeEnd`,
/// `profile`, …).
pub fn cdp_console_level(kind: &str) -> Option<ConsoleLevel> {
    match kind {
        "log" | "dir" | "dirxml" | "table" | "trace" => Some(ConsoleLevel::Log),
        "debug" => Some(ConsoleLevel::Debug),
        "info" => Some(ConsoleLevel::Info),
        "warning" => Some(ConsoleLevel::Warn),
        "error" | "assert" => Some(ConsoleLevel::Error),
        _ => None,
    }
}

/// A CDP `RemoteObject` as one piece of console text: the value for a
/// primitive, the engine's preview for an object, the description for the
/// rest.
pub fn cdp_remote_object_text(object: &Value) -> String {
    if let Some(unserializable) = object.get("unserializableValue").and_then(Value::as_str) {
        return piece(unserializable, CDP_MAX_PIECE_CHARS);
    }
    let kind = object.get("type").and_then(Value::as_str).unwrap_or("");
    let description = object
        .get("description")
        .and_then(Value::as_str)
        .map(|d| piece(d, CDP_MAX_PIECE_CHARS));
    let description = description.as_deref();
    match kind {
        "string" => object
            .get("value")
            .and_then(Value::as_str)
            .map(|s| piece(s, CDP_MAX_PIECE_CHARS))
            .or_else(|| description.map(str::to_string))
            .unwrap_or_default(),
        "undefined" => "undefined".to_string(),
        "number" | "boolean" | "bigint" => match object.get("value") {
            Some(Value::String(s)) => piece(s, CDP_MAX_PIECE_CHARS),
            Some(v) if !v.is_null() => piece(&v.to_string(), CDP_MAX_PIECE_CHARS),
            _ => description.unwrap_or("").to_string(),
        },
        "symbol" => description.unwrap_or("Symbol()").to_string(),
        "function" => {
            // The description is the source; its first line names it.
            let first = description.and_then(|d| d.lines().next()).unwrap_or("function");
            format!("[Function: {}]", first.trim_end_matches('{').trim())
        }
        _ => {
            let subtype = object.get("subtype").and_then(Value::as_str).unwrap_or("");
            match subtype {
                "null" => "null".to_string(),
                "error" => first_lines(description.unwrap_or("Error")),
                _ => match object.get("preview") {
                    Some(preview) if preview.is_object() => cdp_preview_text(preview),
                    _ => description.map(str::to_string).unwrap_or_else(|| {
                        piece(
                            object.get("className").and_then(Value::as_str).unwrap_or("Object"),
                            CDP_MAX_PIECE_CHARS,
                        )
                    }),
                },
            }
        }
    }
}

/// An `ObjectPreview` as `Description {name: value, …}` — what the engine
/// itself shows in a collapsed console line.
fn cdp_preview_text(preview: &Value) -> String {
    let description = preview
        .get("description")
        .and_then(Value::as_str)
        .map(|d| piece(d, CDP_MAX_PIECE_CHARS))
        .unwrap_or_else(|| "Object".to_string());
    let description = description.as_str();
    let subtype = preview.get("subtype").and_then(Value::as_str).unwrap_or("");
    let is_array = subtype == "array";
    let mut parts: Vec<String> = Vec::new();
    let mut cut = false;
    if let Some(properties) = preview.get("properties").and_then(Value::as_array) {
        for property in properties.iter().take(CDP_MAX_PREVIEW_ITEMS) {
            let name = piece(property.get("name").and_then(Value::as_str).unwrap_or(""), 256);
            let kind = property.get("type").and_then(Value::as_str).unwrap_or("");
            let value = piece(property.get("value").and_then(Value::as_str).unwrap_or(""), 256);
            let rendered = match kind {
                "string" => format!("{value:?}"),
                "object" if value.is_empty() => "{…}".to_string(),
                _ => value,
            };
            parts.push(if is_array {
                rendered
            } else {
                format!("{name}: {rendered}")
            });
        }
        cut |= properties.len() > CDP_MAX_PREVIEW_ITEMS;
    }
    if let Some(entries) = preview.get("entries").and_then(Value::as_array) {
        for entry in entries.iter().take(CDP_MAX_PREVIEW_ITEMS) {
            let value = piece(
                entry
                    .get("value")
                    .and_then(|v| v.get("description"))
                    .and_then(Value::as_str)
                    .unwrap_or("?"),
                256,
            );
            match entry.get("key").and_then(|k| k.get("description")).and_then(Value::as_str) {
                Some(key) => parts.push(format!("{} => {value}", piece(key, 256))),
                None => parts.push(value),
            }
        }
        cut |= entries.len() > CDP_MAX_PREVIEW_ITEMS;
    }
    if cut || preview.get("overflow").and_then(Value::as_bool) == Some(true) {
        parts.push("…".to_string());
    }
    let (open, close) = if is_array { ("[", "]") } else { ("{", "}") };
    if is_array && description.starts_with("Array") {
        format!("{open}{}{close}", parts.join(", "))
    } else if parts.is_empty() {
        description.to_string()
    } else {
        format!("{description} {open}{}{close}", parts.join(", "))
    }
}

/// `console.log("%s: %d", name, n)` as the page meant it. CDP hands the
/// arguments over unsubstituted; the developer tools do this on display, and
/// so does the page-world shim on WebKit, so the same line reads the same on
/// every platform.
fn substitute(args: &[String]) -> String {
    let Some(first) = args.first() else {
        return String::new();
    };
    if args.len() < 2 || !first.contains('%') {
        return args.join(" ");
    }
    let mut out = String::new();
    let mut used = 1;
    let mut chars = first.chars().peekable();
    while let Some(c) = chars.next() {
        if c != '%' {
            out.push(c);
            continue;
        }
        match chars.peek().copied() {
            Some('%') => {
                chars.next();
                out.push('%');
            }
            Some(spec @ ('s' | 'd' | 'i' | 'f' | 'o' | 'O' | 'j' | 'c')) if used < args.len() => {
                chars.next();
                let arg = &args[used];
                used += 1;
                match spec {
                    'c' => {}
                    'd' | 'i' => out.push_str(
                        &arg.trim()
                            .parse::<f64>()
                            .map(|n| (n.trunc() as i64).to_string())
                            .unwrap_or_else(|_| "NaN".to_string()),
                    ),
                    'f' => out.push_str(
                        &arg.trim()
                            .parse::<f64>()
                            .map(|n| n.to_string())
                            .unwrap_or_else(|_| "NaN".to_string()),
                    ),
                    _ => out.push_str(arg),
                }
            }
            _ => out.push('%'),
        }
    }
    for rest in &args[used..] {
        out.push(' ');
        out.push_str(rest);
    }
    out
}

/// A `Runtime.consoleAPICalled` event as a line, or `None` for a call that
/// prints nothing. `top` and `origin` come from the execution context the
/// event names, resolved by the caller.
pub fn cdp_console_line(params: &Value, at: i64, top: bool, origin: Option<String>) -> Option<ReportedLine> {
    let kind = params.get("type").and_then(Value::as_str).unwrap_or("log");
    let level = cdp_console_level(kind)?;
    let all_args = params.get("args").and_then(Value::as_array);
    let mut args: Vec<String> = all_args
        .map(|args| args.iter().take(CDP_MAX_ARGS).map(cdp_remote_object_text).collect())
        .unwrap_or_default();
    if let Some(extra) = all_args.map(Vec::len).filter(|n| *n > CDP_MAX_ARGS) {
        args.push(format!("…(+{} more)", extra - CDP_MAX_ARGS));
    }
    let mut text = substitute(&args);
    match kind {
        "assert" => {
            text = if text.is_empty() {
                "Assertion failed: console.assert".to_string()
            } else {
                format!("Assertion failed: {text}")
            }
        }
        "trace" => {
            text = if text.is_empty() {
                "Trace".to_string()
            } else {
                format!("Trace: {text}")
            }
        }
        _ => {}
    }
    let frame = params
        .get("stackTrace")
        .and_then(|s| s.get("callFrames"))
        .and_then(Value::as_array)
        .and_then(|frames| frames.first());
    Some(ReportedLine {
        at,
        level,
        source: ConsoleSource::Console,
        // Capped here as well as in the ring: thirty-two capped pieces can
        // still add up to more than the channel envelope allows, and a line
        // the channel rejects is a line the budget never saw.
        text: cap_text(text),
        url: frame
            .and_then(|f| f.get("url"))
            .and_then(Value::as_str)
            .filter(|u| !u.is_empty())
            .map(|u| piece(u, 1024)),
        // CDP counts from zero; `ErrorEvent` and every editor count from one.
        line: frame
            .and_then(|f| f.get("lineNumber"))
            .and_then(Value::as_u64)
            .and_then(|n| n.checked_add(1)).and_then(|n| u32::try_from(n).ok()),
        column: frame
            .and_then(|f| f.get("columnNumber"))
            .and_then(Value::as_u64)
            .and_then(|n| n.checked_add(1)).and_then(|n| u32::try_from(n).ok()),
        top,
        origin,
        dropped: 0,
    })
}

/// A `Runtime.exceptionThrown` event as a line.
pub fn cdp_exception_line(params: &Value, at: i64, top: bool, origin: Option<String>) -> Option<ReportedLine> {
    let details = params.get("exceptionDetails")?;
    let description = details
        .get("exception")
        .and_then(|e| e.get("description"))
        .and_then(Value::as_str)
        .map(|d| first_lines(&piece(d, CONSOLE_MAX_TEXT_CHARS)));
    let text = match description {
        Some(d) if !d.is_empty() => d,
        _ => {
            let text = piece(
                details.get("text").and_then(Value::as_str).unwrap_or("Uncaught exception"),
                CDP_MAX_PIECE_CHARS,
            );
            match details.get("exception").map(cdp_remote_object_text) {
                Some(value) if !value.is_empty() && value != "Object" => format!("{text} {value}"),
                _ => text,
            }
        }
    };
    Some(ReportedLine {
        at,
        level: ConsoleLevel::Error,
        source: ConsoleSource::Exception,
        // Capped at assembly like a console line: the fallback joins the
        // engine's text to an object preview, and the sum has to fit the
        // envelope before the ring ever sees it.
        text: cap_text(text),
        url: details
            .get("url")
            .and_then(Value::as_str)
            .filter(|u| !u.is_empty())
            .map(|u| piece(u, 1024)),
        line: details
            .get("lineNumber")
            .and_then(Value::as_u64)
            .and_then(|n| n.checked_add(1)).and_then(|n| u32::try_from(n).ok()),
        column: details
            .get("columnNumber")
            .and_then(Value::as_u64)
            .and_then(|n| n.checked_add(1)).and_then(|n| u32::try_from(n).ok()),
        top,
        origin,
        dropped: 0,
    })
}

/// Characters kept of an origin, wherever one is stored or sent. A real
/// origin is a scheme, a host and a port; anything past this is not one,
/// and would only be a way to carry a message past the channel's size cap.
pub const CONSOLE_MAX_ORIGIN_CHARS: usize = 2048;

/// The origin a CDP execution context reports, as this module stores one:
/// `None` for an opaque origin, which CDP spells `://`.
pub fn cdp_context_origin(raw: Option<&str>) -> Option<String> {
    let raw = raw?.trim();
    if raw.is_empty() || raw == "://" || raw == "null" {
        return None;
    }
    Some(piece(raw, CONSOLE_MAX_ORIGIN_CHARS))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn line(text: &str, level: ConsoleLevel, origin: &str) -> ReportedLine {
        ReportedLine {
            at: 1,
            level,
            source: ConsoleSource::Console,
            text: text.to_string(),
            url: None,
            line: None,
            column: None,
            top: true,
            origin: Some(origin.to_string()),
            dropped: 0,
        }
    }

    const SITE: &str = "http://localhost:3000";

    /// "Did anything break on this page" is not "which error lines can still
    /// be read": a page that logs a thousand lines after its one error pushes
    /// that error out of the ring and past the budget, and the answer must
    /// still be yes until the document is replaced.
    #[test]
    fn an_error_pushed_out_of_the_ring_is_still_an_error_the_page_printed() {
        let mut ring = ConsoleRing::new();
        assert_eq!(ring.errors(), 0);
        ring.push(line("boom", ConsoleLevel::Error, SITE), true);
        assert_eq!(ring.errors(), 1);
        for i in 0..CONSOLE_RING_CAPACITY {
            ring.push(line(&format!("l{i}"), ConsoleLevel::Log, SITE), true);
        }
        assert!(ring.read(&ConsoleQuery::default(), SITE, |_| true).entries.iter().all(|e| e.text != "boom"));
        assert_eq!(ring.errors(), 1);
        // A line from another origin is not this page's error.
        ring.push(line("elsewhere", ConsoleLevel::Error, "http://other"), false);
        assert_eq!(ring.errors(), 1);
        // A new document starts clean.
        ring.clear();
        assert_eq!(ring.errors(), 0);
    }

    /// The budget refuses a line before the ring ever sees it — and the very
    /// first error of a page in a logging loop is exactly the line that gets
    /// refused. Counting it is the difference between a red mark and a page
    /// that looks fine.
    #[test]
    fn an_error_the_budget_refuses_is_counted_all_the_same() {
        let mut ring = ConsoleRing::new();
        // Spend the whole second on lines that are not errors.
        for i in 0..CONSOLE_HOST_BUDGET_PER_SECOND {
            ring.push(line(&format!("l{i}"), ConsoleLevel::Log, SITE), true);
        }
        assert_eq!(ring.errors(), 0);
        // Now the page's first error, which is over budget and not kept.
        assert!(ring.push(line("boom", ConsoleLevel::Error, SITE), true).is_none());
        assert_eq!(ring.errors(), 1);
        assert!(ring.read(&ConsoleQuery::default(), SITE, |_| true).entries.iter().all(|e| e.text != "boom"));
    }

    /// Reads answer with the seq to continue from, and `since` excludes what
    /// was already seen — the two together are what makes polling the console
    /// cheap for an agent working through a page.
    #[test]
    fn a_read_can_be_continued_from_where_it_stopped() {
        let mut ring = ConsoleRing::new();
        for i in 0..5 {
            ring.push(line(&format!("l{i}"), ConsoleLevel::Log, SITE), true);
        }
        let first = ring.read(
            &ConsoleQuery {
                limit: Some(2),
                ..Default::default()
            },
            "u",
            |_| true,
        );
        assert_eq!(
            first.entries.iter().map(|e| e.text.as_str()).collect::<Vec<_>>(),
            ["l0", "l1"]
        );
        assert!(first.more);
        assert_eq!(first.next_since, 2);

        let rest = ring.read(
            &ConsoleQuery {
                since: first.next_since,
                ..Default::default()
            },
            "u",
            |_| true,
        );
        assert_eq!(
            rest.entries.iter().map(|e| e.text.as_str()).collect::<Vec<_>>(),
            ["l2", "l3", "l4"]
        );
        assert!(!rest.more);
        assert_eq!(rest.next_since, 5);

        // Nothing new: the cursor stands still rather than resetting.
        let quiet = ring.read(
            &ConsoleQuery {
                since: 5,
                ..Default::default()
            },
            "u",
            |_| true,
        );
        assert!(quiet.entries.is_empty());
        assert_eq!(quiet.next_since, 5);
    }

    /// A line from an origin the grant does not cover is never handed out,
    /// whichever way it got into the ring.
    #[test]
    fn a_read_gives_only_the_lines_of_the_granted_origin() {
        let mut ring = ConsoleRing::new();
        ring.push(line("mine", ConsoleLevel::Log, SITE), true);
        ring.push(line("theirs", ConsoleLevel::Error, "https://ads.example"), true);
        let mut opaque = line("blank", ConsoleLevel::Error, SITE);
        opaque.origin = None;
        ring.push(opaque, true);
        let out = ring.read(&ConsoleQuery::default(), "u", |o| o == Some(SITE));
        assert_eq!(out.entries.len(), 1);
        assert_eq!(out.entries[0].text, "mine");
        assert!(!out.more);
    }

    #[test]
    fn min_level_keeps_that_level_and_above() {
        let mut ring = ConsoleRing::new();
        ring.push(line("d", ConsoleLevel::Debug, SITE), true);
        ring.push(line("l", ConsoleLevel::Log, SITE), true);
        ring.push(line("i", ConsoleLevel::Info, SITE), true);
        ring.push(line("w", ConsoleLevel::Warn, SITE), true);
        ring.push(line("e", ConsoleLevel::Error, SITE), true);
        let out = ring.read(
            &ConsoleQuery {
                min_level: Some(ConsoleLevel::Warn),
                ..Default::default()
            },
            "u",
            |_| true,
        );
        assert_eq!(
            out.entries.iter().map(|e| e.text.as_str()).collect::<Vec<_>>(),
            ["w", "e"]
        );
    }

    /// The ring is bounded, what it evicts is counted, and the sender's own
    /// count rides along. A clear resets the count with the lines: it is a
    /// count about this document.
    #[test]
    fn the_ring_is_bounded_and_counts_what_it_lost() {
        let mut ring = ConsoleRing::new();
        for i in 0..(CONSOLE_RING_CAPACITY + 3) {
            ring.push(line(&i.to_string(), ConsoleLevel::Log, SITE), true);
        }
        assert_eq!(ring.len(), CONSOLE_RING_CAPACITY);
        let mut throttled = line("late", ConsoleLevel::Log, SITE);
        throttled.dropped = 40;
        ring.push(throttled, true);
        let out = ring.read(
            &ConsoleQuery {
                limit: Some(1),
                ..Default::default()
            },
            "u",
            |_| true,
        );
        assert_eq!(out.dropped, 3 + 1 + 40);
        // The oldest surviving line is the fourth one pushed (0..=3 evicted).
        assert_eq!(out.entries[0].text, "4");

        let last_seq = ring.next_seq - 1;
        ring.clear();
        assert!(ring.is_empty());
        assert_eq!(ring.read(&ConsoleQuery::default(), "u", |_| true).dropped, 0);
        // Seqs continue past the clear, so an old cursor does not replay.
        assert_eq!(ring.push(line("new", ConsoleLevel::Log, SITE), true), Some(last_seq + 1));
    }

    /// The host admits a bounded number of lines per second per tab however
    /// many frames send them, counts the rest, and starts afresh a second
    /// later. A default ring is a new ring.
    #[test]
    fn the_host_budget_bounds_a_tab_however_many_frames_it_has() {
        let mut ring = ConsoleRing::default();
        let mut l = line("x", ConsoleLevel::Log, SITE);
        l.at = 10_000;
        assert_eq!(ring.push(l.clone(), true), Some(1), "a default ring numbers from 1");
        let mut admitted = 1;
        for _ in 1..(CONSOLE_HOST_BUDGET_PER_SECOND + 50) {
            if ring.push(l.clone(), true).is_some() {
                admitted += 1;
            }
        }
        assert_eq!(admitted, CONSOLE_HOST_BUDGET_PER_SECOND);
        let out = ring.read(&ConsoleQuery::default(), "u", |_| true);
        // The oldest survivor is the first line the ring did not have to
        // evict to make room for the budget's worth.
        assert_eq!(
            out.entries.first().map(|e| e.seq),
            Some(u64::from(CONSOLE_HOST_BUDGET_PER_SECOND) - CONSOLE_RING_CAPACITY as u64 + 1)
        );
        // 50 turned away, plus the ring's own eviction of the overflow past 200.
        assert_eq!(
            out.dropped,
            50 + u64::from(CONSOLE_HOST_BUDGET_PER_SECOND) - CONSOLE_RING_CAPACITY as u64
        );
        l.at = 11_000;
        assert!(ring.push(l.clone(), true).is_some(), "a new second, a new budget");
        ring.note_dropped(7);
        assert_eq!(
            ring.read(&ConsoleQuery::default(), "u", |_| true).dropped,
            50 + u64::from(CONSOLE_HOST_BUDGET_PER_SECOND) - CONSOLE_RING_CAPACITY as u64 + 1 + 7
        );
    }

    /// A line that is not admissible still spends the tab's budget — a
    /// frame on another origin is one of the tab's frames — but is neither
    /// stored nor counted as dropped, and a long URL is cut like the text.
    #[test]
    fn an_inadmissible_line_spends_the_budget_without_being_kept_or_counted() {
        let mut ring = ConsoleRing::new();
        let mut l = line("x", ConsoleLevel::Log, "https://ads.example");
        l.at = 5_000;
        l.dropped = 9;
        for _ in 0..CONSOLE_HOST_BUDGET_PER_SECOND {
            assert_eq!(ring.push(l.clone(), false), None);
        }
        assert!(ring.is_empty());
        assert_eq!(ring.read(&ConsoleQuery::default(), "u", |_| true).dropped, 0);
        // The budget is spent: the page's own line is now turned away, and
        // that one is counted.
        let mut mine = line("mine", ConsoleLevel::Log, SITE);
        mine.at = 5_100;
        assert_eq!(ring.push(mine.clone(), true), None);
        assert_eq!(ring.read(&ConsoleQuery::default(), "u", |_| true).dropped, 1);
        mine.at = 6_100;
        mine.url = Some("u".repeat(5000));
        assert!(ring.push(mine, true).is_some());
        let stored = &ring.read(&ConsoleQuery::default(), "u", |_| true).entries[0];
        assert_eq!(stored.url.as_ref().map(|u| u.chars().count()), Some(1025));
    }

    /// Only a line from the tab's own origin is worth storing.
    #[test]
    fn a_line_is_admissible_only_from_the_tabs_own_origin() {
        assert!(admissible(Some(SITE), Some(SITE)));
        assert!(!admissible(Some(SITE), Some("https://ads.example")));
        assert!(!admissible(Some(SITE), None));
        assert!(!admissible(None, Some(SITE)));
        assert!(!admissible(None, None));
    }

    /// The engine can hand over a megabyte in one argument or a thousand
    /// arguments; neither is copied whole.
    #[test]
    fn cdp_pieces_are_capped_before_they_are_joined() {
        let huge = "x".repeat(200_000);
        let properties: Vec<Value> = (0..50)
            .map(|i| json!({ "name": format!("k{i}"), "type": "number", "value": i.to_string() }))
            .collect();
        let mut args = vec![
            json!({ "type": "string", "value": huge }),
            json!({ "type": "object", "description": "Object",
                    "preview": { "type": "object", "description": "Object", "properties": properties } }),
        ];
        args.extend((0..100).map(|i| json!({ "type": "number", "value": i })));
        let params = json!({ "type": "log", "args": args });
        let line = cdp_console_line(&params, 0, true, None).unwrap();
        assert!(line.text.chars().count() <= CONSOLE_MAX_TEXT_CHARS + 1);
        assert!(line.text.contains("…(+70 more)"), "{}", &line.text[line.text.len() - 40..]);
        assert!(line.text.contains("k19: 19, …}"));
        assert!(!line.text.contains("k20"));
        // A position at the top of the range does not wrap.
        let edge = json!({ "type": "log", "args": [], "stackTrace": { "callFrames": [ { "url": "u", "lineNumber": u64::MAX, "columnNumber": 1 } ] } });
        assert_eq!(cdp_console_line(&edge, 0, true, None).unwrap().line, None);
    }

    #[test]
    fn a_long_line_is_cut_on_a_character_boundary() {
        let mut ring = ConsoleRing::new();
        let long: String = "é".repeat(CONSOLE_MAX_TEXT_CHARS + 10);
        ring.push(line(&long, ConsoleLevel::Log, SITE), true);
        let text = &ring.read(&ConsoleQuery::default(), "u", |_| true).entries[0].text;
        assert_eq!(text.chars().count(), CONSOLE_MAX_TEXT_CHARS + 1);
        assert!(text.ends_with('…'));
    }

    /// The helper's payload is page-controlled: only a known level makes a
    /// line, the source falls back to `console`, numbers are bounded, and the
    /// engine's word on the frame wins over anything in the payload.
    #[test]
    fn a_reported_payload_is_checked_field_by_field() {
        let ok = parse_reported(
            &json!({
                "level": "warn",
                "source": "exception",
                "text": "boom",
                "url": "http://localhost:3000/app.js",
                "line": 12,
                "column": 3,
                "dropped": 7,
                "top": true,
            }),
            false,
            99,
            Some(SITE.to_string()),
        )
        .unwrap();
        assert_eq!(ok.level, ConsoleLevel::Warn);
        assert_eq!(ok.source, ConsoleSource::Exception);
        assert_eq!(ok.text, "boom");
        assert_eq!(ok.line, Some(12));
        assert_eq!(ok.column, Some(3));
        assert_eq!(ok.dropped, 7);
        assert_eq!(ok.at, 99);
        assert!(!ok.top, "the payload's `top` is not consulted");
        assert_eq!(ok.origin.as_deref(), Some(SITE));

        assert!(parse_reported(&json!({ "level": "verbose", "text": "x" }), true, 0, None).is_none());
        assert!(parse_reported(&json!({ "text": "no level" }), true, 0, None).is_none());
        let sparse = parse_reported(&json!({ "level": "log", "source": "made-up", "line": -4 }), true, 0, None)
            .unwrap();
        assert_eq!(sparse.source, ConsoleSource::Console);
        assert_eq!(sparse.text, "");
        assert_eq!(sparse.line, None);
        // A claimed drop count is bounded, on a line and on its own.
        let boastful = parse_reported(&json!({ "level": "log", "dropped": u64::MAX }), true, 0, None).unwrap();
        assert_eq!(boastful.dropped, CONSOLE_MAX_REPORTED_DROP);
        assert_eq!(reported_drop(&json!({ "dropped": 3 })), 3);
        assert_eq!(reported_drop(&json!({ "dropped": -3 })), 0);
    }

    /// Each kind of CDP value reads as the developer tools would show it,
    /// and `%` substitutions are applied as the page meant them.
    #[test]
    fn cdp_arguments_read_like_a_console_line() {
        let params = json!({
            "type": "log",
            "args": [
                { "type": "string", "value": "%s has %d items, %c styled %o" },
                { "type": "string", "value": "cart" },
                { "type": "number", "value": 3 },
                { "type": "string", "value": "color: red" },
                { "type": "object", "className": "Object", "description": "Object",
                  "preview": { "type": "object", "description": "Object", "overflow": true,
                               "properties": [
                                 { "name": "id", "type": "number", "value": "7" },
                                 { "name": "name", "type": "string", "value": "x" },
                                 { "name": "tags", "type": "object", "subtype": "array", "value": "Array(2)" }
                               ] } },
                { "type": "undefined" },
                { "type": "object", "subtype": "null", "value": null },
                { "type": "number", "unserializableValue": "NaN" },
                { "type": "object", "subtype": "array", "className": "Array", "description": "Array(2)",
                  "preview": { "type": "object", "subtype": "array", "description": "Array(2)",
                               "properties": [
                                 { "name": "0", "type": "number", "value": "1" },
                                 { "name": "1", "type": "string", "value": "two" }
                               ] } },
                { "type": "object", "subtype": "error", "className": "TypeError",
                  "description": "TypeError: bad\n    at f (app.js:1:2)\n    at g (app.js:3:4)" },
                { "type": "function", "description": "function save(x) {\n  return x\n}" }
            ],
            "stackTrace": { "callFrames": [ { "url": "http://localhost:3000/app.js", "lineNumber": 41, "columnNumber": 8 } ] }
        });
        let line = cdp_console_line(&params, 5, true, Some(SITE.to_string())).unwrap();
        assert_eq!(
            line.text,
            "cart has 3 items,  styled Object {id: 7, name: \"x\", tags: Array(2), …} undefined null NaN [1, \"two\"] TypeError: bad\n    at f (app.js:1:2)\n    at g (app.js:3:4) [Function: function save(x)]"
        );
        assert_eq!(line.level, ConsoleLevel::Log);
        assert_eq!(line.url.as_deref(), Some("http://localhost:3000/app.js"));
        assert_eq!((line.line, line.column), (Some(42), Some(9)));

        assert!(cdp_console_line(&json!({ "type": "clear", "args": [] }), 0, true, None).is_none());
        assert!(cdp_console_line(&json!({ "type": "startGroup", "args": [] }), 0, true, None).is_none());
        let assert_line = cdp_console_line(
            &json!({ "type": "assert", "args": [ { "type": "string", "value": "must hold" } ] }),
            0,
            true,
            None,
        )
        .unwrap();
        assert_eq!(assert_line.level, ConsoleLevel::Error);
        assert_eq!(assert_line.text, "Assertion failed: must hold");
        let warn = cdp_console_line(&json!({ "type": "warning", "args": [] }), 0, false, None).unwrap();
        assert_eq!(warn.level, ConsoleLevel::Warn);
        assert!(!warn.top);
    }

    #[test]
    fn a_cdp_exception_keeps_the_top_of_its_stack_and_one_based_positions() {
        let long_stack = (0..20)
            .map(|i| format!("    at f{i} (app.js:{i}:1)"))
            .collect::<Vec<_>>()
            .join("\n");
        let params = json!({
            "timestamp": 1.0,
            "exceptionDetails": {
                "text": "Uncaught",
                "lineNumber": 9,
                "columnNumber": 0,
                "url": "http://localhost:3000/app.js",
                "exception": { "type": "object", "subtype": "error", "className": "Error",
                               "description": format!("Error: nope\n{long_stack}") }
            }
        });
        let line = cdp_exception_line(&params, 3, true, Some(SITE.to_string())).unwrap();
        assert_eq!(line.source, ConsoleSource::Exception);
        assert_eq!(line.level, ConsoleLevel::Error);
        assert!(line.text.starts_with("Error: nope\n    at f0"));
        assert_eq!(line.text.lines().count(), STACK_LINES_KEPT + 1);
        assert!(line.text.ends_with('…'));
        assert_eq!((line.line, line.column), (Some(10), Some(1)));

        // A thrown primitive has no description; the engine's text plus the
        // value is what there is.
        let thrown = json!({ "exceptionDetails": { "text": "Uncaught", "exception": { "type": "string", "value": "plain" } } });
        assert_eq!(cdp_exception_line(&thrown, 0, true, None).unwrap().text, "Uncaught plain");
        // A thrown object with a wide preview is cut at the line cap at
        // assembly, not only in the ring.
        let properties: Vec<Value> = (0..CDP_MAX_PREVIEW_ITEMS)
            .map(|i| json!({ "name": format!("k{i}"), "type": "string", "value": "v".repeat(300) }))
            .collect();
        let wide = json!({ "exceptionDetails": { "text": "Uncaught", "exception": { "type": "object", "className": "Object", "description": "",
            "preview": { "type": "object", "description": "Object", "properties": properties,
                         "entries": (0..CDP_MAX_PREVIEW_ITEMS).map(|i| json!({ "key": { "description": format!("e{i}") }, "value": { "description": "w".repeat(300) } })).collect::<Vec<_>>() } } } });
        let line = cdp_exception_line(&wide, 0, true, None).unwrap();
        assert!(line.text.chars().count() <= CONSOLE_MAX_TEXT_CHARS + 1, "{}", line.text.chars().count());
    }

    /// Thirty-two capped pieces would still add up to more than the channel
    /// envelope; the assembled line is capped before it leaves the shim.
    #[test]
    fn a_cdp_line_of_many_large_pieces_is_capped_as_a_whole() {
        let args: Vec<Value> = (0..CDP_MAX_ARGS)
            .map(|_| json!({ "type": "string", "value": "y".repeat(CDP_MAX_PIECE_CHARS) }))
            .collect();
        let line = cdp_console_line(&json!({ "type": "log", "args": args }), 0, true, None).unwrap();
        assert_eq!(line.text.chars().count(), CONSOLE_MAX_TEXT_CHARS + 1);
        assert!(line.text.ends_with('…'));
    }

    #[test]
    fn a_cdp_context_origin_is_none_when_opaque() {
        assert_eq!(cdp_context_origin(Some("://")), None);
        assert_eq!(cdp_context_origin(Some("")), None);
        assert_eq!(cdp_context_origin(None), None);
        assert_eq!(
            cdp_context_origin(Some("http://localhost:3000")).as_deref(),
            Some("http://localhost:3000")
        );
        // An "origin" the length of a novel is cut, so it cannot carry an
        // envelope past the channel's cap.
        let long = "h".repeat(10_000);
        assert_eq!(
            cdp_context_origin(Some(&long)).map(|o| o.chars().count()),
            Some(CONSOLE_MAX_ORIGIN_CHARS + 1)
        );
    }

    #[test]
    fn the_wire_shape_is_camel_case_and_hides_the_origin() {
        let mut ring = ConsoleRing::new();
        ring.push(line("x", ConsoleLevel::Info, SITE), true);
        let out = serde_json::to_value(ring.read(&ConsoleQuery::default(), "http://x/", |_| true)).unwrap();
        assert_eq!(out["nextSince"], 1);
        assert_eq!(out["entries"][0]["level"], "info");
        assert_eq!(out["entries"][0]["source"], "console");
        assert!(out["entries"][0].get("origin").is_none());
        assert!(out["entries"][0].get("url").is_none());
        let q: ConsoleQuery = serde_json::from_value(json!({ "since": 3, "minLevel": "warn", "limit": 5 })).unwrap();
        assert_eq!(q.since, 3);
        assert_eq!(q.min_level, Some(ConsoleLevel::Warn));
        assert_eq!(q.limit, Some(5));
    }
}
