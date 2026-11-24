//! What the ACP server tells the user when a turn dies, rebuilt from the
//! trajectory's record of it.
//!
//! When the agent executor fails (the model API answered 403, the quota ran
//! out, an MCP server would not start, …) `agy_acp_server` catches the SDK's
//! `AntigravityExecutionError`, sends ONE `agent_message_chunk` describing it
//! and ends the turn `end_turn` — there is no typed failure on the wire. The
//! harness has already stored the same failure as an `error_message` step
//! with `should_show_user` set, carrying the executor's raw error string
//! (`short_error`: "agent executor error: Error 403, Message: …, Status: …,
//! Details: [map[…]]: …"). Its `user_error_message` is only the generic
//! "Agent execution terminated due to error.".
//!
//! [`turn_failure_text`] turns that raw string into the words the server sent,
//! by the server's own rules (1.5.2 `server.py` `prompt`): the browser-MCP
//! wording, else `mcp_errors.mcp_load_failed_message`, else
//! `ccpa_connection.quota_errors.quota_exhausted_message`, else
//! `api_errors.format_execution_error`. The live failure line and the reopened
//! transcript's then say the same thing, and the live view can recognise the
//! chunk that told it.

use std::collections::HashMap;
use std::sync::OnceLock;

use regex::Regex;

/// `browser_subagent.SERVER_NAME`.
const BROWSER_SERVER_NAME: &str = "chrome_devtools";

/// The words the ACP server sends the user for a turn its executor ended with
/// `raw`.
pub(crate) fn turn_failure_text(raw: &str) -> String {
    browser_failure_message(raw)
        .or_else(|| mcp_load_failed_message(raw))
        .or_else(|| quota_exhausted_message(raw))
        .unwrap_or_else(|| format_execution_error(raw))
}

/// The AIR failure category (`access|limit|request|service|unknown`) the raw
/// executor error falls in, read off its Google API status.
pub(crate) fn failure_category(raw: &str) -> &'static str {
    if quota_reason(raw).as_deref() == Some(QUOTA_EXHAUSTED_REASON) {
        return "limit";
    }
    let Some(caps) = api_error_re().captures(raw) else {
        return "unknown";
    };
    match &caps["status"] {
        "UNAUTHENTICATED" | "PERMISSION_DENIED" => "access",
        "RESOURCE_EXHAUSTED" => "limit",
        "INVALID_ARGUMENT" | "FAILED_PRECONDITION" | "NOT_FOUND" | "OUT_OF_RANGE" => "request",
        "UNAVAILABLE" | "INTERNAL" | "DEADLINE_EXCEEDED" => "service",
        _ => "unknown",
    }
}

// ---------------------------------------------------------------------------
// browser_subagent.execution_error_message
// ---------------------------------------------------------------------------

fn browser_failure_message(raw: &str) -> Option<String> {
    raw.contains(&format!("MCP load failed for {BROWSER_SERVER_NAME}"))
        .then(|| {
            "Browser automation could not start (the chrome-devtools-mcp tool provider failed \
             to launch), so this request could not be completed. Retry after ensuring \
             Node.js/npx is installed and that `npx chrome-devtools-mcp@>=1` can be fetched \
             from your npm registry. Other functionality is unaffected."
                .to_string()
        })
}

// ---------------------------------------------------------------------------
// mcp_errors.mcp_load_failed_message
// ---------------------------------------------------------------------------

const MCP_REMEDY: &str = "Fix the MCP server, or remove it from your configuration and start a \
                          new session, to continue.";

fn mcp_load_failed_message(raw: &str) -> Option<String> {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| {
        Regex::new(r"(?s)MCP load failed for (?P<name>[a-zA-Z0-9_-]+): (?P<reason>.*)").unwrap()
    });
    let caps = re.captures(raw)?;
    let name = &caps["name"];
    let reason = tidy_mcp_reason(&caps["reason"]);
    if reason.is_empty() {
        return Some(format!(
            "The MCP server '{name}' failed to initialize. {MCP_REMEDY}"
        ));
    }
    let separator = if reason.ends_with('.') { "" } else { "." };
    Some(format!(
        "The MCP server '{name}' failed to initialize: {reason}{separator} {MCP_REMEDY}"
    ))
}

fn tidy_mcp_reason(reason: &str) -> String {
    static WHITESPACE: OnceLock<Regex> = OnceLock::new();
    static STRAY_COLON: OnceLock<Regex> = OnceLock::new();
    let collapsed = WHITESPACE
        .get_or_init(|| Regex::new(r"\s+").unwrap())
        .replace_all(reason, " ");
    let collapsed = STRAY_COLON
        .get_or_init(|| Regex::new(r"\s+:\s+").unwrap())
        .replace_all(collapsed.trim(), ": ");
    collapsed.trim().trim_start_matches(':').trim().to_string()
}

// ---------------------------------------------------------------------------
// ccpa_connection.quota_errors.quota_exhausted_message
// ---------------------------------------------------------------------------

const QUOTA_EXHAUSTED_REASON: &str = "QUOTA_EXHAUSTED";
const QUOTA_HEADER: &str = "Usage Limit Reached";
const QUOTA_BODY: &str = "You have reached your current quota for this period.";

/// The FIRST `reason:` in the raw error, as upstream's `re.search` reads it.
fn quota_reason(raw: &str) -> Option<String> {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"\breason:([A-Z_]+)").unwrap())
        .captures(raw)
        .map(|caps| caps[1].to_string())
}

fn quota_exhausted_message(raw: &str) -> Option<String> {
    if quota_reason(raw).as_deref() != Some(QUOTA_EXHAUSTED_REASON) {
        return None;
    }
    let reset = quota_reset_sentence(raw);
    Some(if reset.is_empty() {
        format!("{QUOTA_HEADER}\n\n{QUOTA_BODY}")
    } else {
        format!("{QUOTA_HEADER}\n\n{QUOTA_BODY} {reset}")
    })
}

fn quota_reset_sentence(raw: &str) -> String {
    static DELAY: OnceLock<Regex> = OnceLock::new();
    static STAMP: OnceLock<Regex> = OnceLock::new();
    let delay = DELAY
        .get_or_init(|| Regex::new(r"\bquotaResetDelay:([^\s\]]+)").unwrap())
        .captures(raw)
        .and_then(|caps| parse_go_duration(&caps[1]));
    // Python's `if delay:` — a zero delay falls through to the timestamp.
    if let Some(seconds) = delay.filter(|s| *s != 0.0) {
        return format!("Your limit will reset in {}.", format_duration(seconds));
    }
    STAMP
        .get_or_init(|| Regex::new(r"\bquotaResetTimeStamp:([^\s\]]+)").unwrap())
        .captures(raw)
        .and_then(|caps| format_timestamp(&caps[1]))
        .map(|moment| format!("Your limit will reset on {moment}."))
        .unwrap_or_default()
}

/// A Go duration literal ("119h36m35.41909833s") in seconds.
fn parse_go_duration(value: &str) -> Option<f64> {
    static WHOLE: OnceLock<Regex> = OnceLock::new();
    static PART: OnceLock<Regex> = OnceLock::new();
    let value = value.trim();
    let whole =
        WHOLE.get_or_init(|| Regex::new(r"^(?:\d+(?:\.\d+)?(?:ns|us|µs|μs|ms|h|m|s))+$").unwrap());
    if !whole.is_match(value) {
        return None;
    }
    let part = PART.get_or_init(|| Regex::new(r"(\d+(?:\.\d+)?)(ns|us|µs|μs|ms|h|m|s)").unwrap());
    let mut total = 0.0;
    for caps in part.captures_iter(value) {
        let amount: f64 = caps[1].parse().ok()?;
        let unit = match &caps[2] {
            "ns" => 1e-9,
            "us" | "µs" | "μs" => 1e-6,
            "ms" => 1e-3,
            "s" => 1.0,
            "m" => 60.0,
            "h" => 3600.0,
            _ => return None,
        };
        total += amount * unit;
    }
    Some(total)
}

/// A duration in words, to its two largest non-zero units ("4 days, 23
/// hours"); floored at one second.
fn format_duration(total_seconds: f64) -> String {
    const UNITS: [(&str, u64); 4] = [
        ("day", 86_400),
        ("hour", 3_600),
        ("minute", 60),
        ("second", 1),
    ];
    let mut remaining = (total_seconds as u64).max(1);
    let mut parts: Vec<String> = Vec::new();
    for (name, size) in UNITS {
        if parts.len() == 2 {
            break;
        }
        let amount = remaining / size;
        remaining %= size;
        if amount > 0 {
            parts.push(if amount == 1 {
                format!("{amount} {name}")
            } else {
                format!("{amount} {name}s")
            });
        }
    }
    parts.join(", ")
}

/// An RFC 3339 instant as "Nov 29, 2026 10:00 UTC"; a stamp with no offset
/// is taken as UTC, as upstream does.
fn format_timestamp(value: &str) -> Option<String> {
    use chrono::{DateTime, NaiveDateTime, Utc};
    let value = value.trim().replace('Z', "+00:00");
    let utc: DateTime<Utc> = DateTime::parse_from_rfc3339(&value)
        .map(|dt| dt.with_timezone(&Utc))
        .ok()
        .or_else(|| {
            [
                "%Y-%m-%dT%H:%M:%S%.f",
                "%Y-%m-%d %H:%M:%S%.f",
                "%Y-%m-%dT%H:%M",
            ]
            .iter()
            .find_map(|fmt| NaiveDateTime::parse_from_str(&value, fmt).ok())
            .map(|naive| naive.and_utc())
        })?;
    Some(format!(
        "{} {}, {} {} UTC",
        utc.format("%b"),
        utc.format("%-d"),
        utc.format("%Y"),
        utc.format("%H:%M")
    ))
}

// ---------------------------------------------------------------------------
// api_errors.format_execution_error
// ---------------------------------------------------------------------------

/// Go's Google API error: `Error <code>, Message: <msg>, Status: <STATUS>, …`.
fn api_error_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(
            r"(?s)Error (?P<code>\d+), Message: (?P<message>.+?), Status: (?P<status>[A-Z_]+)",
        )
        .unwrap()
    })
}

fn format_execution_error(raw: &str) -> String {
    if let Some(caps) = api_error_re().captures(raw) {
        let message = caps["message"].trim();
        if !message.is_empty() {
            return match action_link(raw) {
                Some(link) => format!("{message}\n\n{link}"),
                None => message.to_string(),
            };
        }
    }
    static DETAILS: OnceLock<Regex> = OnceLock::new();
    let sanitized = DETAILS
        .get_or_init(|| Regex::new(r"(?s),\s*Details:\s*\[.*\]").unwrap())
        .replace_all(raw, "");
    format!("Agent execution error: {}", sanitized.trim())
}

const ERROR_INFO_PREFIX: &str = "map[@type:type.googleapis.com/google.rpc.ErrorInfo";
const METADATA_PREFIX: &str = "metadata:map[";

struct ErrorInfo {
    reason: String,
    metadata: HashMap<String, String>,
}

/// A user action the backend can attach to an `ErrorInfo` (upstream mirrors
/// jetski's `buildErrorResp`).
struct ErrorAction {
    url_key: &'static str,
    link_text_key: &'static str,
    default_link_text: &'static str,
    reason: Option<&'static str>,
    requires_ui_message: bool,
}

const ERROR_ACTIONS: [ErrorAction; 2] = [
    ErrorAction {
        reason: Some("VALIDATION_REQUIRED"),
        url_key: "validation_url",
        link_text_key: "validation_url_link_text",
        default_link_text: "Verify your account",
        requires_ui_message: false,
    },
    ErrorAction {
        reason: None,
        url_key: "appeal_url",
        link_text_key: "appeal_url_link_text",
        default_link_text: "Submit Appeal",
        requires_ui_message: true,
    },
];

impl ErrorAction {
    fn link(&self, info: &ErrorInfo) -> Option<String> {
        if self.reason.is_some_and(|reason| info.reason != reason) {
            return None;
        }
        if self.requires_ui_message
            && info.metadata.get("uiMessage").map(String::as_str) != Some("true")
        {
            return None;
        }
        let url = info
            .metadata
            .get(self.url_key)
            .map(String::as_str)
            .unwrap_or("");
        if !is_google_https_url(url) {
            return None;
        }
        let text = info
            .metadata
            .get(self.link_text_key)
            .map(String::as_str)
            .filter(|text| !text.is_empty())
            .unwrap_or(self.default_link_text);
        Some(format!("{text}: {url}"))
    }
}

/// Only a Google-hosted https link is surfaced as clickable chat text.
fn is_google_https_url(url: &str) -> bool {
    let Ok(parsed) = url::Url::parse(url) else {
        return false;
    };
    let host = parsed.host_str().unwrap_or("");
    parsed.scheme() == "https" && (host == "google.com" || host.ends_with(".google.com"))
}

/// The text up to the `]` closing the `[` just before `start`.
fn bracket_body(text: &str, start: usize) -> Option<&str> {
    let mut depth = 1_u32;
    for (offset, byte) in text.as_bytes().get(start..)?.iter().enumerate() {
        match byte {
            b'[' => depth += 1,
            b']' => {
                depth -= 1;
                if depth == 0 {
                    return text.get(start..start + offset);
                }
            }
            _ => {}
        }
    }
    None
}

/// Go prints map entries as space-separated `key:value`; a value may hold
/// spaces, so an entry only starts at a space followed by `identifier:`.
fn parse_metadata(body: &str) -> HashMap<String, String> {
    static KEY_AHEAD: OnceLock<Regex> = OnceLock::new();
    let key_ahead = KEY_AHEAD.get_or_init(|| Regex::new(r"^[A-Za-z_]\w*:").unwrap());
    let mut entries = Vec::new();
    let mut start = 0;
    for (i, ch) in body.char_indices() {
        if ch == ' ' && key_ahead.is_match(&body[i + 1..]) {
            entries.push(&body[start..i]);
            start = i + 1;
        }
    }
    entries.push(&body[start..]);
    entries
        .into_iter()
        .filter_map(|entry| {
            let (key, value) = entry.split_once(':')?;
            Some((key.to_string(), value.to_string()))
        })
        .collect()
}

fn error_infos(raw: &str) -> Vec<ErrorInfo> {
    static REASON: OnceLock<Regex> = OnceLock::new();
    let reason_re = REASON.get_or_init(|| Regex::new(r"\breason:(?P<reason>\w+)").unwrap());
    let mut infos = Vec::new();
    let mut found = raw.find(ERROR_INFO_PREFIX);
    while let Some(start) = found {
        let Some(body) = bracket_body(raw, start + "map[".len()) else {
            break;
        };
        let mut body = body.to_string();
        let mut metadata = HashMap::new();
        if let Some(meta_start) = body.find(METADATA_PREFIX) {
            if let Some(meta_body) = bracket_body(&body, meta_start + METADATA_PREFIX.len()) {
                metadata = parse_metadata(meta_body);
                let whole = format!("{METADATA_PREFIX}{meta_body}]");
                body = body.replace(&whole, "");
            }
        }
        let reason = reason_re
            .captures(&body)
            .map(|caps| caps["reason"].to_string())
            .unwrap_or_default();
        infos.push(ErrorInfo { reason, metadata });
        let next_from = start + ERROR_INFO_PREFIX.len();
        found = raw[next_from..]
            .find(ERROR_INFO_PREFIX)
            .map(|i| next_from + i);
    }
    infos
}

/// The first user action link found in the error's details.
fn action_link(raw: &str) -> Option<String> {
    error_infos(raw)
        .iter()
        .find_map(|info| ERROR_ACTIONS.iter().find_map(|action| action.link(info)))
}

#[cfg(test)]
mod tests {
    use super::*;

    // Field captures from agy 1.5.2 against a gateway answering 403 / 429
    // (the `short_error` of the stored step); the expected strings are the
    // `agent_message_chunk` the server sent for the same turn.
    const RAW_403: &str = "agent executor error: Error 403, Message: Your current account is not eligible for Gemini Code Assist for individuals because it is not currently available in your location., Status: PERMISSION_DENIED, Details: [map[@type:type.googleapis.com/google.rpc.ErrorInfo domain:cloudaicompanion.googleapis.com metadata:map[error_number:1008 uiMessage:true] reason:UNSUPPORTED_LOCATION]]: Error 403, Message: Your current account is not eligible for Gemini Code Assist for individuals because it is not currently available in your location., Status: PERMISSION_DENIED, Details: [map[@type:type.googleapis.com/google.rpc.ErrorInfo domain:cloudaicompanion.googleapis.com metadata:map[error_number:1008 uiMessage:true] reason:UNSUPPORTED_LOCATION]]";
    const RAW_429: &str = "agent executor error: Error 429, Message: You have exhausted your capacity on this model. Your quota will reset after 119h36m35s., Status: RESOURCE_EXHAUSTED, Details: [map[@type:type.googleapis.com/google.rpc.ErrorInfo domain:cloudcode-pa.googleapis.com metadata:map[model:gemini-3.8-flash quotaResetDelay:119h36m35.41909833s quotaResetTimeStamp:2026-11-29T10:00:00Z] reason:QUOTA_EXHAUSTED]]";

    #[test]
    fn an_api_error_reads_as_its_public_message() {
        assert_eq!(
            turn_failure_text(RAW_403),
            "Your current account is not eligible for Gemini Code Assist for individuals \
             because it is not currently available in your location."
        );
        assert_eq!(failure_category(RAW_403), "access");
    }

    #[test]
    fn an_exhausted_quota_reads_as_the_usage_limit_notice() {
        assert_eq!(
            turn_failure_text(RAW_429),
            "Usage Limit Reached\n\nYou have reached your current quota for this period. \
             Your limit will reset in 4 days, 23 hours."
        );
        assert_eq!(failure_category(RAW_429), "limit");
    }

    #[test]
    fn a_quota_with_only_a_reset_stamp_names_the_moment() {
        let raw = "Error 429, Message: out, Status: RESOURCE_EXHAUSTED, Details: [map[@type:type.googleapis.com/google.rpc.ErrorInfo metadata:map[quotaResetTimeStamp:2026-11-29T10:05:00Z] reason:QUOTA_EXHAUSTED]]";
        assert_eq!(
            turn_failure_text(raw),
            "Usage Limit Reached\n\nYou have reached your current quota for this period. \
             Your limit will reset on Nov 29, 2026 10:05 UTC."
        );
        let bare = "Error 429, Message: out, Status: RESOURCE_EXHAUSTED, Details: [map[@type:type.googleapis.com/google.rpc.ErrorInfo reason:QUOTA_EXHAUSTED]]";
        assert_eq!(
            turn_failure_text(bare),
            "Usage Limit Reached\n\nYou have reached your current quota for this period."
        );
    }

    #[test]
    fn durations_keep_their_two_largest_units() {
        assert_eq!(parse_go_duration("1h30m"), Some(5400.0));
        assert_eq!(parse_go_duration("1x"), None);
        assert_eq!(format_duration(0.2), "1 second");
        assert_eq!(format_duration(86_400.0 + 300.0), "1 day, 5 minutes");
        assert_eq!(format_duration(7_322.0), "2 hours, 2 minutes");
    }

    #[test]
    fn a_google_action_link_follows_the_message() {
        let raw = "Error 403, Message: Verify first, Status: PERMISSION_DENIED, Details: [map[@type:type.googleapis.com/google.rpc.ErrorInfo domain:x metadata:map[validation_url:https://accounts.google.com/verify validation_url_link_text:Verify now please] reason:VALIDATION_REQUIRED]]";
        assert_eq!(
            turn_failure_text(raw),
            "Verify first\n\nVerify now please: https://accounts.google.com/verify"
        );
        // Appeals need `uiMessage:true`; a non-Google host is never linked.
        let appeal = "Error 403, Message: Banned, Status: PERMISSION_DENIED, Details: [map[@type:type.googleapis.com/google.rpc.ErrorInfo metadata:map[appeal_url:https://support.google.com/a uiMessage:true] reason:X]]";
        assert_eq!(
            turn_failure_text(appeal),
            "Banned\n\nSubmit Appeal: https://support.google.com/a"
        );
        let foreign = "Error 403, Message: Banned, Status: PERMISSION_DENIED, Details: [map[@type:type.googleapis.com/google.rpc.ErrorInfo metadata:map[appeal_url:https://evil.example/a uiMessage:true] reason:X]]";
        assert_eq!(turn_failure_text(foreign), "Banned");
    }

    #[test]
    fn anything_else_is_reported_without_its_details() {
        assert_eq!(
            turn_failure_text("boom, Details: [map[secret:1]]"),
            "Agent execution error: boom"
        );
        assert_eq!(failure_category("boom"), "unknown");
    }

    #[test]
    fn mcp_load_failures_name_the_server() {
        let raw =
            "MCP load failed for broken: broken_mcp: startup failure\n: connection closed: EOF";
        assert_eq!(
            turn_failure_text(raw),
            "The MCP server 'broken' failed to initialize: broken_mcp: startup failure: \
             connection closed: EOF. Fix the MCP server, or remove it from your configuration \
             and start a new session, to continue."
        );
        assert!(turn_failure_text("MCP load failed for chrome_devtools: x")
            .starts_with("Browser automation could not start"));
    }
}
