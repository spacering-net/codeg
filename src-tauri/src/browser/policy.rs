//! Policy decisions for browser tabs: the scheme allow-lists, the per-site
//! rule table, and the administrator's policy file. Everything that decides
//! is a function of its arguments so the tables in the unit tests are the
//! specification; `BrowserPolicy` only holds the two rule lists.

use std::path::{Path, PathBuf};
use std::sync::RwLock;

use serde::{Deserialize, Serialize};
use tauri::Url;

/// Top-level navigation allow-list. Only real web pages may load in a tab:
/// `http(s)`, the `about:blank` bootstrap page every tab starts from, and
/// `blob:` URLs minted by an http(s) page (Turnstile and friends). Everything
/// else — `file:`, `tauri:`, `javascript:`, `data:` documents, custom schemes —
/// is refused: a tab must never be able to reach the app's own origin or the
/// local filesystem.
/// How far back a page-initiated new-window request may look for a user
/// gesture before it counts as an unsolicited popup. Both surfaces ask it:
/// the embedded one on macOS and Windows, the owned window on Linux.
pub const POPUP_GESTURE_WINDOW: std::time::Duration = std::time::Duration::from_secs(1);

pub fn navigation_allowed(url: &Url) -> bool {
    match url.scheme() {
        "http" | "https" => true,
        "about" => url.as_str() == "about:blank",
        "blob" => {
            let inner = url.path();
            inner.starts_with("http://") || inner.starts_with("https://")
        }
        _ => false,
    }
}

/// What a page may load into one of ITS OWN frames. Wider than the top-level
/// list: `about:srcdoc`, `data:` and `blob:` frames are opaque-origin content
/// a page composes itself (markdown previews, sandboxes, embeds) and reach
/// nothing the page could not reach already, while `file:` and the app's own
/// schemes stay out. The engine only asks about frame navigations, never
/// about images or fetches.
pub fn subframe_navigation_allowed(url: &Url) -> bool {
    match url.scheme() {
        "http" | "https" | "data" | "blob" => true,
        "about" => matches!(url.as_str(), "about:blank" | "about:srcdoc"),
        _ => false,
    }
}

/// The initial URL handed to `browser_open_tab` must already be a web page;
/// `about:blank` is accepted so an empty tab can be opened explicitly.
pub fn open_url_allowed(url: &Url) -> bool {
    matches!(url.scheme(), "http" | "https") || url.as_str() == "about:blank"
}

// ---------------------------------------------------------------------------
// Site rules
// ---------------------------------------------------------------------------

/// What a matching site rule asks for. `Builtin` / `System` are routing
/// preferences the frontend's link decision applies; `Block` is enforced here
/// as well, on every navigation a tab attempts.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum HostRuleAction {
    Builtin,
    System,
    Block,
}

/// One row of the site-rule table. Same shape as `HostRule` in
/// `src/lib/browser/host-rules.ts`, which mirrors the matching below.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HostRule {
    /// A hostname, `*.suffix`, or `*`, optionally followed by `:port`.
    pub pattern: String,
    pub action: HostRuleAction,
}

/// Longest a hostname can be (RFC 1035); anything longer is not a pattern.
const MAX_PATTERN_LEN: usize = 253 + 6;

#[derive(Debug, Clone, PartialEq, Eq)]
enum HostMatcher {
    Any,
    /// `*.example.com` — stored as `.example.com`.
    Suffix(String),
    Exact(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ParsedPattern {
    host: HostMatcher,
    port: Option<u16>,
}

/// Parse a pattern the way the frontend does (`parseHostRulePattern`); `None`
/// for anything that is not a pattern, which then never matches.
fn parse_pattern(pattern: &str) -> Option<ParsedPattern> {
    // ASCII whitespace only, like the frontend: `str::trim` would also eat
    // U+0085 and friends, and a pattern the two sides parse differently is
    // a rule one of them silently ignores.
    let trimmed = pattern
        .trim_matches(|c: char| c.is_ascii_whitespace())
        .to_ascii_lowercase();
    if trimmed.is_empty() || trimmed.len() > MAX_PATTERN_LEN {
        return None;
    }
    let (host, port, bracketed) = if let Some(rest) = trimmed.strip_prefix('[') {
        // `[::1]:3000` — an IPv6 literal keeps its brackets; the port follows.
        let close = rest.find(']')?;
        let host = &rest[..close];
        let tail = &rest[close + 1..];
        let port = match tail.strip_prefix(':') {
            Some(digits) => Some(digits),
            None if tail.is_empty() => None,
            None => return None,
        };
        (host.to_string(), port.map(str::to_string), true)
    } else {
        match trimmed.rsplit_once(':') {
            Some((host, digits)) if !digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit()) => {
                (host.to_string(), Some(digits.to_string()), false)
            }
            Some(_) => return None,
            None => (trimmed.clone(), None, false),
        }
    };
    let port = match port {
        Some(digits) => Some(digits.parse::<u16>().ok().filter(|p| *p > 0)?),
        None => None,
    };
    let host = if bracketed {
        // Brackets mean an IPv6 literal and nothing else — not a wildcard,
        // not a name. Stored as typed, matched in the form URLs carry
        // (`::1`, never `0:0:0:0:0:0:0:1`), or a rule would look right and
        // never apply.
        HostMatcher::Exact(canonical_ipv6(&host)?)
    } else if host == "*" {
        HostMatcher::Any
    } else if let Some(suffix) = host.strip_prefix("*.") {
        if !valid_hostname(suffix) {
            return None;
        }
        HostMatcher::Suffix(format!(".{suffix}"))
    } else if valid_hostname(&host) {
        HostMatcher::Exact(host)
    } else {
        return None;
    };
    Some(ParsedPattern { host, port })
}

/// An IPv6 literal (without brackets) in the canonical form the URL parser
/// produces; `None` for anything that is not one.
fn canonical_ipv6(host: &str) -> Option<String> {
    host.contains(':')
        .then(|| host.parse::<std::net::Ipv6Addr>().ok())
        .flatten()
        .map(|address| address.to_string())
}

/// The URL's host as a rule sees it: lower-case, without IPv6 brackets, and
/// without a trailing dot — `example.com.` names the same server as
/// `example.com`, and a block on one must hold for the other.
fn rule_hostname(url: &Url) -> Option<String> {
    let host = url.host_str()?.trim_matches(|c| c == '[' || c == ']');
    let host = host.trim_end_matches('.');
    (!host.is_empty()).then(|| host.to_ascii_lowercase())
}

fn valid_hostname(host: &str) -> bool {
    !host.is_empty()
        && !host.starts_with('.')
        && !host.ends_with('.')
        && !host.contains("..")
        && host
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'.' || b == b'_')
}

/// Whether `pattern` is one the table accepts (the settings UI validates
/// with the same rule on its side).
pub fn valid_pattern(pattern: &str) -> bool {
    parse_pattern(pattern).is_some()
}

fn effective_port(url: &Url) -> Option<u16> {
    url.port_or_known_default()
}

impl ParsedPattern {
    fn matches(&self, hostname: &str, port: Option<u16>) -> bool {
        let host_ok = match &self.host {
            HostMatcher::Any => true,
            HostMatcher::Suffix(suffix) => hostname.ends_with(suffix.as_str()) && hostname.len() > suffix.len(),
            HostMatcher::Exact(exact) => hostname == exact,
        };
        host_ok && self.port.is_none_or(|wanted| port == Some(wanted))
    }

    /// Higher wins: an exact host over a wildcard, a longer wildcard suffix
    /// over a shorter one, `*` last; a pinned port breaks a tie.
    fn specificity(&self) -> (u8, usize, u8) {
        let (kind, len) = match &self.host {
            HostMatcher::Exact(host) => (2, host.len()),
            HostMatcher::Suffix(suffix) => (1, suffix.len()),
            HostMatcher::Any => (0, 0),
        };
        (kind, len, u8::from(self.port.is_some()))
    }
}

impl HostRuleAction {
    /// Among equally specific rules the more restrictive one wins — two
    /// spellings of one host (`[::1]` and `[0:0:0:0:0:0:0:1]`) may both be
    /// in the table, and a block must not depend on which was listed first.
    fn restrictiveness(self) -> u8 {
        match self {
            HostRuleAction::Block => 2,
            HostRuleAction::System => 1,
            HostRuleAction::Builtin => 0,
        }
    }
}

/// How well a rule fits a URL: specificity (kind, suffix length, pinned
/// port), then the action's restrictiveness. Higher wins; ties go to the
/// rule listed first.
type RuleScore = (u8, usize, u8, u8);

/// The rule that applies to `url`: the most specific matching pattern; among
/// equally specific ones the most restrictive action, and among those the
/// first listed. Unparsable patterns never match. Same algorithm as
/// `matchHostRule` on the frontend.
pub fn match_host_rule<'a>(rules: &'a [HostRule], url: &Url) -> Option<&'a HostRule> {
    let hostname = rule_hostname(url)?;
    let port = effective_port(url);
    let mut best: Option<(&HostRule, RuleScore)> = None;
    for rule in rules {
        let Some(parsed) = parse_pattern(&rule.pattern) else {
            continue;
        };
        if !parsed.matches(&hostname, port) {
            continue;
        }
        let (kind, len, pinned) = parsed.specificity();
        let score: RuleScore = (kind, len, pinned, rule.action.restrictiveness());
        if best.as_ref().is_none_or(|(_, current)| score > *current) {
            best = Some((rule, score));
        }
    }
    best.map(|(rule, _)| rule)
}

// ---------------------------------------------------------------------------
// The administrator's policy file
// ---------------------------------------------------------------------------

/// Settings an administrator fixes for every user of the machine. Read once
/// at startup from `managed_policy_path()`; anything set here is shown in the
/// settings section as read-only and consulted before the user's own rules.
#[derive(Debug, Clone, PartialEq)]
pub struct ManagedPolicy {
    /// `false` turns the built-in browser off: every link goes to the system
    /// browser and `browser_open_tab` refuses.
    pub browser_enabled: bool,
    pub host_rules: Vec<HostRule>,
    /// Where the policy came from, for the settings section.
    pub source: Option<PathBuf>,
}

impl Default for ManagedPolicy {
    fn default() -> Self {
        Self {
            browser_enabled: true,
            host_rules: Vec::new(),
            source: None,
        }
    }
}

/// On-disk shape: `{ "browser": { "enabled": bool, "hostRules": [...] } }`.
/// Every key is optional and unknown keys are ignored, so the file can grow
/// other sections later without breaking older builds.
#[derive(Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct ManagedPolicyFile {
    browser: ManagedBrowserSection,
}

#[derive(Debug, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct ManagedBrowserSection {
    enabled: bool,
    host_rules: Vec<serde_json::Value>,
}

impl Default for ManagedBrowserSection {
    fn default() -> Self {
        Self {
            enabled: true,
            host_rules: Vec::new(),
        }
    }
}

/// `CODEG_POLICY_FILE` when set (tests, unusual deployments), else the
/// machine-wide location for the platform. The file is optional.
pub fn managed_policy_path() -> PathBuf {
    if let Some(explicit) = std::env::var_os("CODEG_POLICY_FILE") {
        return PathBuf::from(explicit);
    }
    if cfg!(target_os = "macos") {
        PathBuf::from("/Library/Application Support/codeg/policy.json")
    } else if cfg!(target_os = "windows") {
        let base = std::env::var_os("PROGRAMDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(r"C:\ProgramData"));
        base.join("codeg").join("policy.json")
    } else {
        PathBuf::from("/etc/codeg/policy.json")
    }
}

/// Parse a policy file's contents. Malformed rules are dropped one by one
/// (and logged) rather than failing the whole file, so a typo in one line
/// does not silently lift every other restriction.
pub fn parse_managed_policy(raw: &str) -> Result<ManagedPolicy, String> {
    let file: ManagedPolicyFile = serde_json::from_str(raw).map_err(|e| e.to_string())?;
    let mut host_rules = Vec::new();
    for value in file.browser.host_rules {
        match serde_json::from_value::<HostRule>(value.clone()) {
            Ok(rule) if valid_pattern(&rule.pattern) => host_rules.push(rule),
            Ok(rule) => tracing::warn!("[browser] policy: ignoring rule with invalid pattern {:?}", rule.pattern),
            Err(err) => tracing::warn!("[browser] policy: ignoring malformed rule {value}: {err}"),
        }
    }
    Ok(ManagedPolicy {
        browser_enabled: file.browser.enabled,
        host_rules,
        source: None,
    })
}

/// Read the policy at `path`; `None` when there is no file. An unreadable or
/// malformed file is reported and treated as absent — a broken policy must
/// not lock everyone out, and must not be mistaken for a permissive one
/// either, which is why it is logged at error level.
pub fn read_managed_policy(path: &Path) -> Option<ManagedPolicy> {
    let raw = match std::fs::read_to_string(path) {
        Ok(raw) => raw,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return None,
        Err(err) => {
            tracing::error!("[browser] policy file {} is unreadable: {err}", path.display());
            return None;
        }
    };
    match parse_managed_policy(&raw) {
        Ok(mut policy) => {
            policy.source = Some(path.to_path_buf());
            tracing::info!(
                "[browser] policy loaded from {} (enabled: {}, {} rule(s))",
                path.display(),
                policy.browser_enabled,
                policy.host_rules.len()
            );
            Some(policy)
        }
        Err(err) => {
            tracing::error!("[browser] policy file {} is malformed: {err}", path.display());
            None
        }
    }
}

/// What the settings section shows about the policy in force.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserPolicyStatus {
    pub enabled: bool,
    pub managed_rules: Vec<HostRule>,
    pub managed_source: Option<String>,
}

/// The rules in force: the administrator's (fixed for the process) and the
/// user's (pushed by the frontend whenever the preference changes). Managed
/// state; cheap to read from any hook.
pub struct BrowserPolicy {
    managed: ManagedPolicy,
    user_rules: RwLock<Vec<HostRule>>,
}

impl Default for BrowserPolicy {
    fn default() -> Self {
        Self::with_managed(ManagedPolicy::default())
    }
}

impl BrowserPolicy {
    /// Read the administrator's policy file (if any) and start with no user
    /// rules; the frontend pushes those once it is up.
    pub fn load() -> Self {
        let managed = read_managed_policy(&managed_policy_path()).unwrap_or_default();
        Self::with_managed(managed)
    }

    pub fn with_managed(managed: ManagedPolicy) -> Self {
        Self {
            managed,
            user_rules: RwLock::new(Vec::new()),
        }
    }

    pub fn enabled(&self) -> bool {
        self.managed.browser_enabled
    }

    /// Replace the user's rules. Invalid patterns are dropped here too, so a
    /// hand-edited preference cannot make a rule that never matches look
    /// like protection.
    pub fn set_user_rules(&self, rules: Vec<HostRule>) {
        let rules: Vec<HostRule> = rules
            .into_iter()
            .filter(|rule| valid_pattern(&rule.pattern))
            .collect();
        *self.user_rules.write().unwrap_or_else(|p| p.into_inner()) = rules;
    }

    pub fn user_rules(&self) -> Vec<HostRule> {
        self.user_rules.read().unwrap_or_else(|p| p.into_inner()).clone()
    }

    /// The rule for `url`: the administrator's table first (it wins whatever
    /// the user wrote), then the user's.
    pub fn rule_for(&self, url: &Url) -> Option<HostRule> {
        if let Some(rule) = match_host_rule(&self.managed.host_rules, url) {
            return Some(rule.clone());
        }
        let user = self.user_rules.read().unwrap_or_else(|p| p.into_inner());
        match_host_rule(&user, url).cloned()
    }

    /// A `block` rule applies to `url`.
    pub fn blocked(&self, url: &Url) -> bool {
        self.rule_for(url)
            .is_some_and(|rule| rule.action == HostRuleAction::Block)
    }

    pub fn status(&self) -> BrowserPolicyStatus {
        BrowserPolicyStatus {
            enabled: self.managed.browser_enabled,
            managed_rules: self.managed.host_rules.clone(),
            managed_source: self
                .managed
                .source
                .as_ref()
                .map(|p| p.display().to_string()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn u(s: &str) -> Url {
        Url::parse(s).unwrap()
    }

    fn rule(pattern: &str, action: HostRuleAction) -> HostRule {
        HostRule {
            pattern: pattern.to_string(),
            action,
        }
    }

    #[test]
    fn navigation_allow_list() {
        for ok in [
            "http://localhost:3000/",
            "https://example.com/a?b#c",
            "about:blank",
            "blob:https://example.com/0c8f-4a",
            "blob:http://localhost:3000/x",
        ] {
            assert!(navigation_allowed(&u(ok)), "{ok}");
        }
        for bad in [
            "file:///etc/passwd",
            "tauri://localhost/",
            "javascript:alert(1)",
            "data:text/html,<b>x</b>",
            "about:config",
            "about:srcdoc",
            "blob:null/abc",
            "blob:file:///x",
            "codeg-doc://grant/index.html",
            "ftp://example.com/",
            "vscode://file/x",
        ] {
            assert!(!navigation_allowed(&u(bad)), "{bad}");
        }
    }

    /// A page's own frames may hold the opaque-origin content pages compose
    /// (srcdoc previews, data: sandboxes); the filesystem and app schemes
    /// stay out of frames too.
    #[test]
    fn subframes_may_hold_opaque_content_but_not_local_schemes() {
        for ok in [
            "about:srcdoc",
            "about:blank",
            "data:text/html,<b>x</b>",
            "blob:https://example.com/x",
            "https://embed.example/",
        ] {
            assert!(subframe_navigation_allowed(&u(ok)), "{ok}");
        }
        for bad in ["file:///etc/passwd", "tauri://localhost/", "codeg-doc://g/x", "about:config"] {
            assert!(!subframe_navigation_allowed(&u(bad)), "{bad}");
        }
    }

    #[test]
    fn open_url_is_stricter_than_navigation() {
        assert!(open_url_allowed(&u("https://example.com")));
        assert!(open_url_allowed(&u("about:blank")));
        assert!(!open_url_allowed(&u("blob:https://example.com/x")));
        assert!(!open_url_allowed(&u("file:///x")));
    }

    // -- site rules ---------------------------------------------------------

    #[test]
    fn pattern_grammar() {
        for ok in [
            "example.com",
            "EXAMPLE.com",
            " example.com ",
            "*.example.com",
            "*",
            "localhost:3000",
            "*.corp.example:8443",
            "[::1]:3000",
            "[::1]",
            "[0:0:0:0:0:0:0:1]",
            "127.0.0.1",
            "10.0.0.1:8080",
            "*:443",
        ] {
            assert!(valid_pattern(ok), "{ok:?} should parse");
        }
        for bad in [
            "",
            "   ",
            "https://example.com",
            "example.com/path",
            "example.com:",
            "example.com:0",
            "example.com:70000",
            "example.com:80a",
            "*.",
            "*example.com",
            "a b.com",
            ".example.com",
            "example..com",
            "[::1",
            "[::1]x",
            "[1::2::3]",
            "[not-an-address]",
            "[fe80::1%25en0]",
            "[*]",
            "[*.example.com]",
            "[*]:443",
            "*.*",
            "\u{85}blocked.example",
            "blocked.example\u{a0}",
        ] {
            assert!(!valid_pattern(bad), "{bad:?} should not parse");
        }
    }

    /// The same server under a different spelling of its name must not slip
    /// past a rule: a trailing dot, a long-form IPv6 literal, upper case.
    #[test]
    fn host_spellings_that_name_the_same_server_match() {
        let block = [rule("example.com", HostRuleAction::Block)];
        assert!(match_host_rule(&block, &u("http://example.com./")).is_some());
        assert!(match_host_rule(&block, &u("http://EXAMPLE.COM/")).is_some());
        assert!(match_host_rule(&block, &u("http://user:pw@example.com:8080/")).is_some());
        let long = [rule("[0:0:0:0:0:0:0:1]:3000", HostRuleAction::Block)];
        assert!(match_host_rule(&long, &u("http://[::1]:3000/")).is_some());
        let short = [rule("[::1]", HostRuleAction::Block)];
        assert!(match_host_rule(&short, &u("http://[0:0:0:0:0:0:0:1]/")).is_some());
        // No host at all: nothing to match, not even `*`.
        let any = [rule("*", HostRuleAction::Block)];
        assert!(match_host_rule(&any, &u("about:blank")).is_none());
    }

    /// Mirror of the frontend's `matchHostRule` table.
    #[test]
    fn wildcard_semantics() {
        let block = [rule("*.example.com", HostRuleAction::Block)];
        assert!(match_host_rule(&block, &u("https://a.example.com/")).is_some());
        assert!(match_host_rule(&block, &u("https://a.b.example.com/")).is_some());
        assert!(match_host_rule(&block, &u("https://example.com/")).is_none());
        assert!(match_host_rule(&block, &u("https://notexample.com/")).is_none());

        let any = [rule("*", HostRuleAction::System)];
        assert!(match_host_rule(&any, &u("http://x/")).is_some());

        let v6 = [rule("[::1]:3000", HostRuleAction::Builtin)];
        assert!(match_host_rule(&v6, &u("http://[::1]:3000/")).is_some());
        assert!(match_host_rule(&v6, &u("http://[::1]:3001/")).is_none());

        // Ports pin a rule and compare against the scheme's default.
        let https_default = [rule("example.com:443", HostRuleAction::Builtin)];
        assert!(match_host_rule(&https_default, &u("https://EXAMPLE.com/")).is_some());
        let http_only = [rule("example.com:80", HostRuleAction::Builtin)];
        assert!(match_host_rule(&http_only, &u("https://example.com/")).is_none());
        assert!(match_host_rule(&http_only, &u("http://example.com/")).is_some());

        // An unparsable pattern never matches, and never panics.
        let junk = [rule("https://example.com", HostRuleAction::Block)];
        assert!(match_host_rule(&junk, &u("https://example.com/")).is_none());
    }

    #[test]
    fn most_specific_rule_wins_regardless_of_order() {
        let rules = [
            rule("*", HostRuleAction::System),
            rule("*.corp.example", HostRuleAction::Builtin),
            rule("*.corp.example:8443", HostRuleAction::System),
            rule("sso.corp.example", HostRuleAction::Block),
            rule("*.sso.corp.example", HostRuleAction::Builtin),
        ];
        let action = |url: &str| match_host_rule(&rules, &u(url)).map(|r| r.action);
        assert_eq!(action("https://sso.corp.example/"), Some(HostRuleAction::Block));
        assert_eq!(action("https://sso.corp.example:8443/"), Some(HostRuleAction::Block));
        assert_eq!(action("https://wiki.corp.example:8443/"), Some(HostRuleAction::System));
        assert_eq!(action("https://wiki.corp.example/"), Some(HostRuleAction::Builtin));
        assert_eq!(action("https://a.sso.corp.example/"), Some(HostRuleAction::Builtin));
        assert_eq!(action("https://elsewhere.example/"), Some(HostRuleAction::System));
        // Equal specificity: the more restrictive action, whatever the order
        // — including two spellings of one host.
        let tie = [
            rule("dup.example", HostRuleAction::Builtin),
            rule("dup.example", HostRuleAction::Block),
        ];
        assert_eq!(
            match_host_rule(&tie, &u("https://dup.example/")).map(|r| r.action),
            Some(HostRuleAction::Block)
        );
        let aliases = [
            rule("[0:0:0:0:0:0:0:1]", HostRuleAction::System),
            rule("[::1]", HostRuleAction::Block),
        ];
        assert_eq!(
            match_host_rule(&aliases, &u("http://[::1]/")).map(|r| r.action),
            Some(HostRuleAction::Block)
        );
        // Equal in every respect: the first listed.
        let same = [
            rule("dup.example", HostRuleAction::System),
            rule("dup.example", HostRuleAction::System),
        ];
        assert!(std::ptr::eq(
            match_host_rule(&same, &u("https://dup.example/")).unwrap(),
            &same[0]
        ));
    }

    #[test]
    fn managed_rules_beat_user_rules_and_invalid_user_rules_are_dropped() {
        let policy = BrowserPolicy::with_managed(ManagedPolicy {
            browser_enabled: true,
            host_rules: vec![rule("*.internal.example", HostRuleAction::Block)],
            source: None,
        });
        policy.set_user_rules(vec![
            rule("wiki.internal.example", HostRuleAction::Builtin), // more specific, still loses
            rule("blocked.example", HostRuleAction::Block),
            rule("not a pattern", HostRuleAction::Block),
        ]);
        assert!(policy.blocked(&u("https://wiki.internal.example/")));
        assert!(policy.blocked(&u("https://blocked.example/x")));
        assert!(!policy.blocked(&u("https://example.com/")));
        assert_eq!(policy.user_rules().len(), 2);
        assert!(policy.enabled());
        let status = policy.status();
        assert_eq!(status.managed_rules.len(), 1);
        assert!(status.managed_source.is_none());
    }

    #[test]
    fn policy_file_is_tolerant_but_never_permissive_by_accident() {
        let parsed = parse_managed_policy(
            r#"{
                "browser": {
                    "enabled": false,
                    "hostRules": [
                        { "pattern": "*.corp.example", "action": "block" },
                        { "pattern": "not a pattern", "action": "block" },
                        { "pattern": "x.example", "action": "explode" },
                        "junk"
                    ]
                },
                "other": { "future": true }
            }"#,
        )
        .unwrap();
        assert!(!parsed.browser_enabled);
        assert_eq!(parsed.host_rules, vec![rule("*.corp.example", HostRuleAction::Block)]);

        // Missing keys mean "no restriction", not "off".
        let empty = parse_managed_policy("{}").unwrap();
        assert!(empty.browser_enabled);
        assert!(empty.host_rules.is_empty());

        // Not JSON at all: an error, which `read_managed_policy` logs and
        // treats as no file.
        assert!(parse_managed_policy("{ nope").is_err());
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("policy.json");
        assert!(read_managed_policy(&path).is_none());
        std::fs::write(&path, "{ nope").unwrap();
        assert!(read_managed_policy(&path).is_none());
        std::fs::write(&path, r#"{"browser":{"hostRules":[{"pattern":"a.example","action":"system"}]}}"#).unwrap();
        let loaded = read_managed_policy(&path).unwrap();
        assert_eq!(loaded.source.as_deref(), Some(path.as_path()));
        assert_eq!(loaded.host_rules.len(), 1);
    }

    #[test]
    fn wire_names() {
        let json = serde_json::to_value(BrowserPolicyStatus {
            enabled: true,
            managed_rules: vec![rule("a.example", HostRuleAction::Block)],
            managed_source: Some("/etc/codeg/policy.json".into()),
        })
        .unwrap();
        assert_eq!(json["managedRules"][0]["action"], "block");
        assert_eq!(json["managedSource"], "/etc/codeg/policy.json");
        let rule: HostRule = serde_json::from_str(r#"{"pattern":"*","action":"builtin"}"#).unwrap();
        assert_eq!(rule.action, HostRuleAction::Builtin);
    }
}
