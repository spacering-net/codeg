use std::collections::BTreeMap;

use sea_orm::DatabaseConnection;

use crate::app_error::AppCommandError;
use crate::models::SystemProxySettings;

const PROXY_ENV_KEYS: [&str; 6] = [
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
];

/// Both spellings, and they are not interchangeable: reqwest reads `NO_PROXY`
/// first, while curl, Bun, Python and Node's env proxy all read `no_proxy`
/// first.
const NO_PROXY_ENV_KEYS: [&str; 2] = ["NO_PROXY", "no_proxy"];

/// Hosts that never go through the proxy, whatever the settings' list says.
///
/// Agents run services of their own on this machine and reach them over HTTP:
/// `opencode acp` drives its embedded server at `http://127.0.0.1:4096` with
/// Bun's `fetch`, and Antigravity's Python server dials its Go harness at
/// `ws://127.0.0.1:<port>` with `websockets`. Both hand those loopback requests
/// to `HTTP(S)_PROXY` unless `NO_PROXY` names the host. A proxy on this machine
/// happens to survive that — its loopback is ours — but a proxy on another host
/// dials ITS OWN loopback, and the agent dies in `session/new` ("OpenCode
/// service failure", "Failed to connect to WebSocket").
///
/// IPv6 needs both spellings: curl and reqwest match a bare `::1`, while Bun,
/// Node's env proxy and Python's `urllib` compare the URL's bracketed host and
/// only match `[::1]`.
const LOOPBACK_NO_PROXY: [&str; 4] = ["localhost", "127.0.0.1", "::1", "[::1]"];

/// Canonicalize a user-entered proxy address into a URL that carries an
/// explicit scheme.
///
/// `reqwest` accepts a scheme-less `host:port` because it silently retries the
/// parse as `http://{input}` — but it keeps that repair to itself, so a bare
/// `127.0.0.1:7890` used to survive validation and land verbatim in
/// `HTTP_PROXY`. Every in-process reqwest call then worked (it repairs the env
/// value the same way) while every spawned child died: npm parses the value
/// with WHATWG `new URL()`, where a scheme may not start with a digit, and
/// aborts with a bare `ERR_INVALID_URL` before touching the network. Doing the
/// repair here — once, at the boundary — keeps both sides reading the same
/// address.
///
/// A value that already names a scheme is returned untouched, so `socks5://`
/// and `https://` proxies are never rewritten to `http://`.
pub(crate) fn normalize_proxy_url(raw: &str) -> Result<String, AppCommandError> {
    let trimmed = raw.trim();
    let normalized = if needs_http_prefix(trimmed) {
        format!("http://{trimmed}")
    } else {
        trimmed.to_string()
    };

    let parsed = reqwest::Url::parse(&normalized).map_err(|e| {
        AppCommandError::configuration_invalid("Invalid proxy URL").with_detail(e.to_string())
    })?;
    if !names_a_host(&parsed) {
        return Err(AppCommandError::configuration_invalid("Invalid proxy URL")
            .with_detail("a proxy address must include a host, e.g. http://127.0.0.1:7890"));
    }
    reqwest::Proxy::all(&normalized).map_err(|e| {
        AppCommandError::configuration_invalid("Invalid proxy URL").with_detail(e.to_string())
    })?;

    Ok(normalized)
}

/// Whether the URL actually names a host. `has_host()` is not enough: for a
/// non-special scheme the `url` crate reports the empty authority in `socks5://`
/// as a host, so it answers `true` for an address that can never be dialled.
fn names_a_host(url: &reqwest::Url) -> bool {
    url.host_str().is_some_and(|host| !host.is_empty())
}

/// Whether `value` is an abbreviated `host:port` that needs `http://` to become
/// a usable proxy URL. The single source of truth for the repair decision, so
/// what [`normalize_proxy_url`] rewrites and what
/// [`proxy_env_vars_missing_scheme`] reports can never disagree.
///
/// Naming a host — not "did it parse" — is the discriminator: `localhost:7890`
/// and `proxy.corp.com:8080` parse just fine, as URLs whose *scheme* is
/// `localhost` / `proxy.corp.com` and whose path is the port. Only a real scheme
/// leaves a host behind.
fn needs_http_prefix(trimmed: &str) -> bool {
    // Something that already spells out a scheme separator is malformed rather
    // than abbreviated (`http://` with no host); prefixing it would launder
    // nonsense into a URL that parses (`http://http://`).
    if trimmed.contains("://") {
        return false;
    }
    !reqwest::Url::parse(trimmed).is_ok_and(|url| names_a_host(&url))
}

/// The value these settings should put in the proxy env vars: `None` when the
/// proxy is disabled (meaning "clear them"), else the normalized URL.
///
/// Split out from [`apply_system_proxy_settings`] so the decision can be tested
/// without mutating process env — an env write would race every other test in
/// the binary.
pub(crate) fn proxy_env_value(
    settings: &SystemProxySettings,
) -> Result<Option<String>, AppCommandError> {
    if !settings.enabled {
        return Ok(None);
    }

    let proxy_url = settings
        .proxy_url
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            AppCommandError::configuration_missing("Proxy URL is required when proxy is enabled")
        })?;

    normalize_proxy_url(proxy_url).map(Some)
}

/// The entries of a bypass list as people write one: commas, semicolons and
/// whitespace all separate (so a pasted one-per-line list works too), and so
/// do the ones a Chinese, Japanese or Arabic keyboard types (`，` `、` `；`
/// `،`) — a host never contains one, and `a，b` would otherwise stay a single
/// entry that matches nothing. Blanks drop out, and a repeat — hosts are
/// case-insensitive — keeps its first spelling.
///
/// Entries themselves are kept as written. `*.example.com` in particular is
/// not respelled `.example.com`, even though curl, Python, Bun and reqwest
/// skip the star form: they read the dot form as `example.com` itself too, so
/// the rewrite would send the one host the star form leaves out around the
/// proxy. The settings page documents the dot form instead.
fn no_proxy_entries(raw: &str) -> Vec<&str> {
    let mut entries: Vec<&str> = Vec::new();
    for entry in raw.split(is_no_proxy_separator) {
        if !entry.is_empty() && !entries.iter().any(|seen| seen.eq_ignore_ascii_case(entry)) {
            entries.push(entry);
        }
    }
    entries
}

fn is_no_proxy_separator(c: char) -> bool {
    matches!(c, ',' | ';' | '，' | '、' | '；' | '،') || c.is_whitespace()
}

/// The settings' bypass list in canonical form: its entries joined by `,` with
/// no spaces — the form `NO_PROXY` itself takes, and the one the settings page
/// shows back — or `None` when nothing is left. Never fails, so a list reads
/// the same whether or not the proxy is on.
pub(crate) fn canonical_no_proxy(raw: &str) -> Option<String> {
    let entries = no_proxy_entries(raw);
    (!entries.is_empty()).then(|| entries.join(","))
}

/// [`canonical_no_proxy`] for a list that is about to be exported. A control
/// character cannot be part of a host, and a NUL would make the env write
/// panic, so either rejects the list.
pub(crate) fn normalize_no_proxy(raw: &str) -> Result<Option<String>, AppCommandError> {
    if let Some(entry) = no_proxy_entries(raw)
        .into_iter()
        .find(|entry| entry.chars().any(char::is_control))
    {
        return Err(
            AppCommandError::configuration_invalid("Invalid no-proxy entry")
                .with_detail(format!("{entry:?} contains a control character")),
        );
    }
    Ok(canonical_no_proxy(raw))
}

/// The `NO_PROXY` value for an environment that carries a proxy: the loopback
/// hosts, then every entry of `lists` not already there.
///
/// A `*` entry anywhere makes the value `*` alone. It means "bypass
/// everything", but Python and curl only honour it as the whole value — inside
/// a list they skip it, so keeping it among other entries would quietly turn it
/// off.
pub(crate) fn no_proxy_value<'a>(lists: impl IntoIterator<Item = &'a str>) -> String {
    let mut entries: Vec<&str> = LOOPBACK_NO_PROXY.to_vec();
    for list in lists {
        for entry in no_proxy_entries(list) {
            if entry == "*" {
                return entry.to_string();
            }
            if !entries.iter().any(|seen| seen.eq_ignore_ascii_case(entry)) {
                entries.push(entry);
            }
        }
    }
    entries.join(",")
}

/// The `NO_PROXY` value these settings export next to the proxy: the loopback
/// hosts plus the settings' own list. Pure for the same reason as
/// [`proxy_env_value`].
pub(crate) fn no_proxy_env_value(
    settings: &SystemProxySettings,
) -> Result<String, AppCommandError> {
    let custom = normalize_no_proxy(settings.no_proxy.as_deref().unwrap_or_default())?;
    Ok(no_proxy_value(custom.as_deref()))
}

/// Every env write these settings amount to: `Some` sets the variable, `None`
/// removes it. Pure for the same reason as [`proxy_env_value`].
pub(crate) fn proxy_env_writes(
    settings: &SystemProxySettings,
) -> Result<Vec<(&'static str, Option<String>)>, AppCommandError> {
    let Some(proxy_url) = proxy_env_value(settings)? else {
        // The bypass list goes with the proxy it was written for.
        return Ok(PROXY_ENV_KEYS
            .into_iter()
            .chain(NO_PROXY_ENV_KEYS)
            .map(|key| (key, None))
            .collect());
    };
    let no_proxy = no_proxy_env_value(settings)?;
    Ok(PROXY_ENV_KEYS
        .into_iter()
        .map(|key| (key, Some(proxy_url.clone())))
        .chain(
            NO_PROXY_ENV_KEYS
                .into_iter()
                .map(|key| (key, Some(no_proxy.clone()))),
        )
        .collect())
}

pub fn apply_system_proxy_settings(settings: &SystemProxySettings) -> Result<(), AppCommandError> {
    // Normalize here as well as at the save path: this is the single choke
    // point for env writes, so no caller can leak an un-prefixed address into a
    // child process even if it bypassed `normalize_proxy_settings`. Every value
    // is settled before the first write, so a rejected setting cannot leave the
    // environment half switched over.
    for (key, value) in proxy_env_writes(settings)? {
        unsafe {
            match value {
                Some(value) => std::env::set_var(key, value),
                None => std::env::remove_var(key),
            }
        }
    }

    Ok(())
}

/// Give a launch environment that carries a proxy the `NO_PROXY` to go with
/// it, in both spellings: the loopback hosts, the list the child would inherit
/// from codeg (`inherited`), and whatever the launch itself already sets.
///
/// Merged rather than left to inheritance because a per-agent `NO_PROXY`
/// would replace only its own spelling: the child would still inherit codeg's
/// `no_proxy`, which curl, Bun, Python and Node read first, so the agent's own
/// entries would silently stop applying. And whichever way the proxy arrived —
/// the settings, or an exported `HTTP_PROXY` codeg passes through — no agent
/// gets one without the loopback exception.
pub(crate) fn add_no_proxy_to_launch_env(
    merged: &mut BTreeMap<String, String>,
    inherited: &[(String, String)],
) {
    let carries_proxy = PROXY_ENV_KEYS
        .iter()
        .any(|key| merged.get(*key).is_some_and(|value| !value.trim().is_empty()));
    if !carries_proxy {
        return;
    }
    let own: Vec<String> = NO_PROXY_ENV_KEYS
        .iter()
        .filter_map(|key| merged.get(*key).cloned())
        .collect();
    let no_proxy = no_proxy_value(
        inherited
            .iter()
            .map(|(_, value)| value.as_str())
            .chain(own.iter().map(String::as_str)),
    );
    for key in NO_PROXY_ENV_KEYS {
        merged.insert(key.to_string(), no_proxy.clone());
    }
}

/// Load persisted proxy settings from the DB and apply them to process env.
/// Must run before the first reqwest client is built — otherwise that client
/// caches the proxy-less config and ignores the user's choice for its lifetime.
/// Errors are logged and dropped: a misconfigured proxy must not block startup.
///
/// Only writes env vars when the DB explicitly stores `enabled=true`. A fresh
/// install or an explicit disable in the UI leaves externally-set HTTP_PROXY
/// alone, so docker `-e` and systemd `Environment=` keep working. Runtime
/// disable through `update_system_proxy_settings` still clears env — that path
/// is the user's explicit intent, not a default.
pub async fn init_proxy_from_db(conn: &DatabaseConnection) {
    match crate::commands::system_settings::load_system_proxy_settings(conn).await {
        Ok(settings) if settings.enabled => {
            if let Err(err) = apply_system_proxy_settings(&settings) {
                tracing::error!("[Settings] failed to apply system proxy settings: {err}");
            }
        }
        Ok(_) => {}
        Err(err) => {
            tracing::error!("[Settings] failed to load system proxy settings: {err}");
        }
    }
}

/// Names of the proxy env vars currently holding a scheme-less address, e.g.
/// `HTTPS_PROXY=127.0.0.1:7890`.
///
/// codeg's own settings can no longer produce one (they are normalized before
/// export), but the startup contract deliberately leaves externally-provided
/// values alone — a docker `-e` or a shell export can still carry a bare
/// `host:port`. Node-based tooling rejects those outright, so callers use this
/// to turn an opaque `Invalid URL` into an actionable message.
pub(crate) fn proxy_env_vars_missing_scheme() -> Vec<String> {
    current_proxy_env_vars()
        .into_iter()
        .filter(|(_, value)| needs_http_prefix(value))
        .map(|(key, _)| key)
        .collect()
}

/// The one proxy URL a consumer that can take only one should use: the
/// process environment as the app's own HTTP clients and agent processes see
/// it. `HTTPS_PROXY` wins (most page traffic is TLS), then `ALL_PROXY`, then
/// `HTTP_PROXY`; codeg's setting writes all of them with one value, so the
/// order only matters for externally exported variables. A scheme-less value
/// is repaired the way [`normalize_proxy_url`] does; an unparsable one is
/// ignored. (Only the built-in browser reads it, hence desktop-only.)
#[cfg(feature = "tauri-runtime")]
pub fn effective_proxy_url() -> Option<String> {
    const ORDER: [&str; 6] = [
        "HTTPS_PROXY",
        "https_proxy",
        "ALL_PROXY",
        "all_proxy",
        "HTTP_PROXY",
        "http_proxy",
    ];
    let vars = current_proxy_env_vars();
    ORDER
        .iter()
        .find_map(|key| vars.iter().find(|(k, _)| k == key).map(|(_, v)| v.clone()))
        .and_then(|raw| normalize_proxy_url(&raw).ok())
}

pub fn current_proxy_env_vars() -> Vec<(String, String)> {
    current_env_vars(&PROXY_ENV_KEYS)
}

/// The bypass list the process currently exports, both spellings.
pub fn current_no_proxy_env_vars() -> Vec<(String, String)> {
    current_env_vars(&NO_PROXY_ENV_KEYS)
}

fn current_env_vars(keys: &[&str]) -> Vec<(String, String)> {
    keys.iter()
        .filter_map(|key| {
            std::env::var(key).ok().and_then(|value| {
                let trimmed = value.trim();
                if trimmed.is_empty() {
                    None
                } else {
                    Some(((*key).to_string(), trimmed.to_string()))
                }
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use super::add_no_proxy_to_launch_env;

    const LOOPBACK: &str = "localhost,127.0.0.1,::1,[::1]";

    fn launch_env(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
        pairs
            .iter()
            .map(|(key, value)| (key.to_string(), value.to_string()))
            .collect()
    }

    fn inherited(value: &str) -> Vec<(String, String)> {
        vec![
            ("NO_PROXY".to_string(), value.to_string()),
            ("no_proxy".to_string(), value.to_string()),
        ]
    }

    fn no_proxy_pair(merged: &BTreeMap<String, String>) -> (Option<&str>, Option<&str>) {
        (
            merged.get("NO_PROXY").map(String::as_str),
            merged.get("no_proxy").map(String::as_str),
        )
    }

    /// Whatever the proxy's source, an agent handed one also gets the loopback
    /// exception — in both spellings.
    #[test]
    fn a_proxied_launch_always_carries_the_loopback_exception() {
        for proxy_key in ["HTTP_PROXY", "https_proxy", "ALL_PROXY"] {
            let mut merged = launch_env(&[(proxy_key, "http://10.0.0.2:3128")]);
            add_no_proxy_to_launch_env(&mut merged, &[]);
            assert_eq!(no_proxy_pair(&merged), (Some(LOOPBACK), Some(LOOPBACK)), "{proxy_key}");
        }
    }

    /// A per-agent `NO_PROXY` joins the list the child inherits instead of
    /// replacing one spelling of it — the lowercase one would otherwise keep
    /// codeg's list, and curl, Bun, Python and Node read that one first.
    #[test]
    fn a_per_agent_bypass_list_joins_the_inherited_one_in_both_spellings() {
        let mut merged = launch_env(&[
            ("HTTP_PROXY", "http://10.0.0.2:3128"),
            ("NO_PROXY", "llm.corp.example.com"),
        ]);
        add_no_proxy_to_launch_env(&mut merged, &inherited(&format!("{LOOPBACK},git.corp")));

        let expected = format!("{LOOPBACK},git.corp,llm.corp.example.com");
        assert_eq!(
            no_proxy_pair(&merged),
            (Some(expected.as_str()), Some(expected.as_str()))
        );
    }

    /// Both inherited spellings count, even when an external environment set
    /// them to different lists.
    #[test]
    fn both_inherited_spellings_are_kept() {
        let mut merged = launch_env(&[("HTTPS_PROXY", "http://10.0.0.2:3128")]);
        add_no_proxy_to_launch_env(
            &mut merged,
            &[
                ("NO_PROXY".to_string(), "upper.example".to_string()),
                ("no_proxy".to_string(), "lower.example".to_string()),
            ],
        );
        let expected = format!("{LOOPBACK},upper.example,lower.example");
        assert_eq!(
            no_proxy_pair(&merged),
            (Some(expected.as_str()), Some(expected.as_str()))
        );
    }

    /// No proxy in the launch, nothing to bypass: the per-agent row and the
    /// inherited list reach the child exactly as they did before.
    #[test]
    fn a_launch_without_a_proxy_is_left_alone() {
        for proxy in [None, Some(""), Some("   ")] {
            let mut merged = launch_env(&[("NO_PROXY", "llm.corp.example.com")]);
            if let Some(value) = proxy {
                // An empty value is the spawn layer's "remove this variable".
                merged.insert("HTTP_PROXY".to_string(), value.to_string());
            }
            add_no_proxy_to_launch_env(&mut merged, &inherited("git.corp"));
            assert_eq!(
                no_proxy_pair(&merged),
                (Some("llm.corp.example.com"), None),
                "{proxy:?}"
            );
        }
    }

    /// Per-agent and inherited lists are read by the same rules as the
    /// settings' own: a full-width or ideographic comma separates, and every
    /// entry — a `*.x` one included — reaches the agent as written.
    #[test]
    fn a_launch_list_is_read_by_the_settings_rules() {
        let mut merged = launch_env(&[
            ("HTTP_PROXY", "http://10.0.0.2:3128"),
            ("NO_PROXY", "*.llm.corp，git.corp"),
        ]);
        add_no_proxy_to_launch_env(&mut merged, &inherited("wiki.corp、.build.corp"));
        let expected = format!("{LOOPBACK},wiki.corp,.build.corp,*.llm.corp,git.corp");
        assert_eq!(
            no_proxy_pair(&merged),
            (Some(expected.as_str()), Some(expected.as_str()))
        );
    }

    /// `*` from any source wins alone: inside a list Python and curl skip it.
    #[test]
    fn a_wildcard_anywhere_bypasses_everything() {
        let mut merged = launch_env(&[("HTTP_PROXY", "http://10.0.0.2:3128"), ("no_proxy", "*")]);
        add_no_proxy_to_launch_env(&mut merged, &inherited(LOOPBACK));
        assert_eq!(no_proxy_pair(&merged), (Some("*"), Some("*")));
    }
}
