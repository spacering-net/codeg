//! Finding the address of a local server in terminal output.
//!
//! A dev server announces itself by printing a line — `Local: http://localhost:5173/`,
//! `Uvicorn running on http://127.0.0.1:8000`, `Now listening on: http://localhost:5000`.
//! That line is the only thing codeg has that says "something is serving now",
//! so it is what the auto-open feature watches. This is the `output` half of
//! what VS Code calls `remote.autoForwardPortsSource`; the `process` half
//! (enumerating listening sockets) is not built — see `services.rs` for why
//! a TCP probe stands in for it.
//!
//! Everything here is pure text work with no I/O, so the whole table of real
//! framework banners is a unit test. The rules:
//!
//! * **Loopback only.** `localhost`, `*.localhost`, `127/8`, `::1`, and the
//!   unspecified addresses `0.0.0.0` / `::` (rewritten to `localhost`, which
//!   is what a browser has to connect to). A LAN address — the `Network:` line
//!   every dev server also prints — belongs to a machine, not to a socket this
//!   host can vouch for, and a public address printed by any command at all
//!   would be an open invitation to make the host load it.
//! * **Whole lines only.** The tail of a chunk is carried to the next feed
//!   rather than scanned: half of `http://localhost:5173` is
//!   `http://localhost:51`, a perfectly parseable address for a port nobody
//!   asked about.
//! * **The query survives.** Jupyter prints `http://localhost:8888/?token=…`
//!   and the page is useless without it. Only the fragment is dropped.

use std::collections::VecDeque;
use std::net::IpAddr;
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use regex::Regex;
use url::Url;

/// Unterminated output held for the next chunk. Past this a line is scanned
/// as it stands: a process that prints a megabyte without a newline is not
/// announcing a server, and the buffer must not grow with it.
const CARRY_MAX: usize = 4 * 1024;

/// How many recently offered origins one terminal remembers. Bounds both the
/// memory and the rate limit below; a terminal serving 32 different ports in
/// one window is not the case this is sized for.
const RECENT_MAX: usize = 32;

/// How long the same origin is skipped after being offered.
///
/// Not "once and never again": the offer is only a candidate, and the caller
/// may well have found nothing listening (a `cat` of a README that mentions
/// `http://localhost:3000`). Ten seconds later the server may genuinely have
/// come up, and the next banner should get its chance.
const RECENT_TTL: Duration = Duration::from_secs(10);

/// An address worth probing: normalized, loopback, fragment dropped.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ServiceCandidate {
    /// The full address to open, e.g. `http://localhost:8888/?token=abc`.
    pub url: String,
    /// `scheme://host[:port]` — the identity the rest of the feature dedupes
    /// and lists by.
    pub origin: String,
    /// `host:port` as a socket address to connect to (never a name with no
    /// port: the scheme's default fills in).
    pub authority: String,
}

/// Anything that starts like a URL. Deliberately greedy and deliberately
/// dumb — `Url::parse` is the real filter; this only has to find where a
/// candidate starts and ends. Stops at whitespace, at the quoting characters
/// a shell or a log format would wrap an address in, and at ESC (a chunk that
/// was not fully stripped).
fn url_pattern() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r#"(?i)https?://[^\s<>"'`\x1b|\\]+"#).expect("static pattern"))
}

/// Strip ANSI escape sequences (CSI and OSC) so a coloured banner reads as
/// text. Same shape as `acp::stderr_tail`'s; OSC 8 hyperlinks lose their URI
/// payload along with the rest of the sequence, which costs nothing — the
/// visible text of a terminal hyperlink to a dev server *is* the address.
pub fn strip_ansi(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c != '\u{1b}' {
            out.push(c);
            continue;
        }
        match chars.peek() {
            // CSI: ESC [ ... final byte in @-~
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

/// Drop the punctuation a sentence leaves stuck to the end of an address:
/// `…at http://localhost:8000/.` and `(http://localhost:3000)` are both a
/// person's prose around a URL, not a path that ends in `.` or `)`.
///
/// Brackets only when unbalanced, so `http://localhost:3000/a(b)` keeps its
/// own.
fn trim_trailing_punctuation(raw: &str) -> &str {
    let mut end = raw.len();
    loop {
        let slice = &raw[..end];
        let Some(last) = slice.chars().next_back() else {
            return slice;
        };
        let drop = match last {
            '.' | ',' | ';' | ':' | '!' | '?' | '\'' | '"' => true,
            ')' => slice.matches(')').count() > slice.matches('(').count(),
            ']' => slice.matches(']').count() > slice.matches('[').count(),
            '}' => slice.matches('}').count() > slice.matches('{').count(),
            _ => false,
        };
        if !drop {
            return slice;
        }
        end -= last.len_utf8();
    }
}

/// Parse one candidate string into a loopback service address, or `None` when
/// it is not one.
///
/// The loopback rules are `browser::listener::loopback_port`'s, plus the
/// unspecified addresses: a grant is bound to the string a person shared and
/// `0.0.0.0` is not that string, but a *banner* saying `0.0.0.0:3000` is
/// exactly how a server says "every interface, including yours".
pub fn local_service_url(raw: &str) -> Option<ServiceCandidate> {
    let trimmed = trim_trailing_punctuation(raw.trim());
    let mut url = Url::parse(trimmed).ok()?;
    if url.scheme() != "http" && url.scheme() != "https" {
        return None;
    }
    let host = url.host_str()?;
    let literal = host
        .strip_prefix('[')
        .and_then(|h| h.strip_suffix(']'))
        .unwrap_or(host);
    match literal.parse::<IpAddr>() {
        Ok(addr) if addr.is_loopback() => {}
        // `0.0.0.0` / `::` reach a wildcard listener, but no browser and no
        // probe should be pointed at them: connect to `localhost` instead,
        // which is the address the same socket answers on.
        Ok(addr) if addr.is_unspecified() => {
            url.set_host(Some("localhost")).ok()?;
        }
        Ok(_) => return None,
        Err(_) => {
            // RFC 6761 §6.3 reserves `localhost` and everything under it for
            // the loopback interface.
            let name = literal.to_ascii_lowercase();
            if name != "localhost" && !name.ends_with(".localhost") {
                return None;
            }
        }
    }
    url.set_fragment(None);
    // An address without an explicit port is still served on one; the probe
    // needs the number either way.
    let port = url.port_or_known_default()?;
    let host = url.host_str()?.to_string();
    let origin = url.origin().ascii_serialization();
    if origin == "null" {
        return None;
    }
    Some(ServiceCandidate {
        url: url.to_string(),
        origin,
        authority: format!("{host}:{port}"),
    })
}

/// Every loopback address in one piece of already-stripped text, in order.
fn candidates_in(text: &str) -> Vec<ServiceCandidate> {
    url_pattern()
        .find_iter(text)
        .filter_map(|m| local_service_url(m.as_str()))
        .collect()
}

/// One terminal's share of the watch: the carry buffer for split lines and
/// the rate limit that keeps a banner in a loop from being offered on every
/// repetition. Thread-confined — one lives in each PTY reader thread — so it
/// needs no lock of its own.
#[derive(Debug, Default)]
pub struct ServiceScanner {
    carry: String,
    recent: VecDeque<(String, Instant)>,
}

impl ServiceScanner {
    pub fn new() -> Self {
        Self::default()
    }

    /// Feed one chunk of raw terminal output; returns the addresses worth
    /// probing. `now` is a parameter so the rate limit is testable without
    /// sleeping.
    ///
    /// The chunk boundaries are wherever an 8 KiB read landed, so nothing may
    /// be decided from a chunk alone: only the part up to the last line break
    /// is scanned, and the rest waits for the read that finishes it.
    pub fn feed(&mut self, chunk: &str, now: Instant) -> Vec<ServiceCandidate> {
        match chunk.rfind(['\n', '\r']).map(|idx| idx + 1) {
            Some(at) => {
                let (finished, tail) = chunk.split_at(at);
                let found = if self.carry.is_empty() {
                    // Nothing held over: scan straight out of the chunk.
                    self.scan(finished, now)
                } else {
                    self.carry.push_str(finished);
                    let held = std::mem::take(&mut self.carry);
                    self.scan(&held, now)
                };
                self.carry.push_str(tail);
                self.trim_carry();
                found
            }
            // No line ended anywhere in this chunk. Hold it for the next one,
            // unless the buffer has outgrown what a banner could be — then
            // scan it as it stands and drop it rather than grow without bound.
            None => {
                self.carry.push_str(chunk);
                if self.carry.len() <= CARRY_MAX {
                    return Vec::new();
                }
                let held = std::mem::take(&mut self.carry);
                self.scan(&held, now)
            }
        }
    }

    /// Addresses in a run of finished lines, minus the ones offered recently.
    fn scan(&mut self, text: &str, now: Instant) -> Vec<ServiceCandidate> {
        // The gate before any real work: the overwhelming majority of terminal
        // output has no address in it, and this runs on the PTY reader thread
        // for every chunk of every terminal.
        if !text.contains("://") {
            return Vec::new();
        }
        let mut out = Vec::new();
        for candidate in candidates_in(&strip_ansi(text)) {
            if self.offered_recently(&candidate.origin, now) {
                continue;
            }
            self.remember(candidate.origin.clone(), now);
            out.push(candidate);
        }
        out
    }

    /// Keep the END of an over-long carry: an address that is still arriving
    /// is at the end of the buffer, never at the start.
    fn trim_carry(&mut self) {
        if self.carry.len() <= CARRY_MAX {
            return;
        }
        let want = self.carry.len() - CARRY_MAX;
        let cut = (want..=self.carry.len())
            .find(|i| self.carry.is_char_boundary(*i))
            .unwrap_or(self.carry.len());
        self.carry.drain(..cut);
    }

    fn offered_recently(&self, origin: &str, now: Instant) -> bool {
        self.recent
            .iter()
            .any(|(seen, at)| seen == origin && now.duration_since(*at) < RECENT_TTL)
    }

    fn remember(&mut self, origin: String, now: Instant) {
        self.recent.retain(|(seen, _)| seen != &origin);
        self.recent.push_back((origin, now));
        while self.recent.len() > RECENT_MAX {
            self.recent.pop_front();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn urls(text: &str) -> Vec<String> {
        let mut scanner = ServiceScanner::new();
        scanner
            .feed(text, Instant::now())
            .into_iter()
            .map(|c| c.url)
            .collect()
    }

    /// The banners this feature exists for, verbatim from the tools that
    /// print them. A change that stops recognising one of these lines is the
    /// whole feature silently not working for that framework.
    #[test]
    fn real_dev_server_banners_are_recognised() {
        let cases: &[(&str, &str)] = &[
            (
                "  ➜  Local:   http://localhost:5173/\n",
                "http://localhost:5173/",
            ),
            (
                "   - Local:        http://localhost:3000\n",
                "http://localhost:3000/",
            ),
            (
                "Starting development server at http://127.0.0.1:8000/\n",
                "http://127.0.0.1:8000/",
            ),
            (
                "* Listening on http://127.0.0.1:3000\n",
                "http://127.0.0.1:3000/",
            ),
            (
                " * Running on http://127.0.0.1:5000\n",
                "http://127.0.0.1:5000/",
            ),
            (
                "INFO:     Uvicorn running on http://127.0.0.1:8000 (Press CTRL+C to quit)\n",
                "http://127.0.0.1:8000/",
            ),
            (
                "Now listening on: http://localhost:5000\n",
                "http://localhost:5000/",
            ),
            (
                "Project is running at: http://localhost:8080/\n",
                "http://localhost:8080/",
            ),
            (
                "Available on:\n  http://127.0.0.1:8080\n",
                "http://127.0.0.1:8080/",
            ),
            (
                "Server address: http://127.0.0.1:4000/\n",
                "http://127.0.0.1:4000/",
            ),
            (
                "    Local:            http://localhost:6006/\n",
                "http://localhost:6006/",
            ),
        ];
        for (line, expected) in cases {
            assert_eq!(urls(line), vec![expected.to_string()], "banner: {line:?}");
        }
    }

    /// The token IS the credential; an address without it opens a login page
    /// nobody can get past.
    #[test]
    fn a_query_string_survives_but_a_fragment_does_not() {
        assert_eq!(
            urls("    http://localhost:8888/lab?token=abc123\n"),
            vec!["http://localhost:8888/lab?token=abc123".to_string()]
        );
        assert_eq!(
            urls("see http://localhost:3000/docs#install\n"),
            vec!["http://localhost:3000/docs".to_string()]
        );
    }

    #[test]
    fn colour_codes_do_not_hide_the_address() {
        assert_eq!(
            urls("  \u{1b}[32m➜\u{1b}[0m  \u{1b}[1mLocal\u{1b}[0m:   \u{1b}[36mhttp://localhost:5173/\u{1b}[0m\n"),
            vec!["http://localhost:5173/".to_string()]
        );
    }

    /// A terminal hyperlink puts the address in an OSC 8 sequence AND in the
    /// visible text; stripping the sequence leaves the one we can trust.
    #[test]
    fn an_osc8_hyperlink_is_read_from_its_visible_text() {
        assert_eq!(
            urls("\u{1b}]8;;http://localhost:4321/\u{1b}\\http://localhost:4321/\u{1b}]8;;\u{1b}\\\n"),
            vec!["http://localhost:4321/".to_string()]
        );
    }

    /// 8 KiB reads cut wherever they cut. Half an address must not be probed
    /// as a whole one — `http://localhost:51` is a valid address for a port
    /// nobody started.
    #[test]
    fn an_address_split_across_chunks_is_found_once_and_whole() {
        let mut scanner = ServiceScanner::new();
        let now = Instant::now();
        assert!(scanner.feed("  Local:   http://localhos", now).is_empty());
        let found = scanner.feed("t:5173/\n", now);
        assert_eq!(
            found.iter().map(|c| c.url.as_str()).collect::<Vec<_>>(),
            vec!["http://localhost:5173/"]
        );

        // And when the cut falls inside the SCHEME, so the first half carries
        // no `://` to notice it by. Anything dropped here is dropped silently.
        let mut split_scheme = ServiceScanner::new();
        assert!(split_scheme.feed("  Local:   htt", now).is_empty());
        let found = split_scheme.feed("p://localhost:5173/\n", now);
        assert_eq!(
            found.iter().map(|c| c.url.as_str()).collect::<Vec<_>>(),
            vec!["http://localhost:5173/"]
        );
    }

    /// The line the server prints right after the local one. It names another
    /// machine's view of this host, and nothing here can vouch for it.
    #[test]
    fn the_network_line_and_public_addresses_are_refused() {
        assert!(urls("  ➜  Network: http://192.168.1.5:5173/\n").is_empty());
        assert!(urls("  ➜  Network: http://10.0.0.7:5173/\n").is_empty());
        assert!(urls("fetching https://example.com/api\n").is_empty());
        assert!(urls("see http://my-box.local:8080/\n").is_empty());
        assert!(urls("ftp://localhost:2121/pub\n").is_empty());
    }

    #[test]
    fn the_unspecified_addresses_become_localhost() {
        assert_eq!(
            urls("Serving on http://0.0.0.0:8000/\n"),
            vec!["http://localhost:8000/".to_string()]
        );
        assert_eq!(
            urls("Serving on http://[::]:8000/\n"),
            vec!["http://localhost:8000/".to_string()]
        );
    }

    #[test]
    fn ipv6_loopback_and_https_are_accepted() {
        assert_eq!(
            urls("Listening on http://[::1]:7000/\n"),
            vec!["http://[::1]:7000/".to_string()]
        );
        assert_eq!(
            urls("  ➜  Local:   https://localhost:5173/\n"),
            vec!["https://localhost:5173/".to_string()]
        );
        assert_eq!(
            urls("  ➜  Local:   http://app.localhost:5173/\n"),
            vec!["http://app.localhost:5173/".to_string()]
        );
    }

    #[test]
    fn prose_punctuation_is_not_part_of_the_address() {
        assert_eq!(
            urls("open it at http://localhost:3000/.\n"),
            vec!["http://localhost:3000/".to_string()]
        );
        assert_eq!(
            urls("(http://localhost:3000/admin), then log in\n"),
            vec!["http://localhost:3000/admin".to_string()]
        );
        assert_eq!(
            urls("go to \"http://localhost:3000/a(b)\"\n"),
            vec!["http://localhost:3000/a(b)".to_string()]
        );
    }

    /// The scheme's default port is the socket the probe has to reach.
    #[test]
    fn an_address_without_a_port_still_names_one() {
        let found = local_service_url("http://localhost/").expect("loopback");
        assert_eq!(found.authority, "localhost:80");
        assert_eq!(found.origin, "http://localhost");
        let secure = local_service_url("https://localhost/").expect("loopback");
        assert_eq!(secure.authority, "localhost:443");
    }

    /// A watcher that reprints its banner on every rebuild must not turn into
    /// a stream of offers — but ten seconds later the same address is worth
    /// another look, because the previous offer may have found nothing
    /// listening and been dropped.
    #[test]
    fn the_same_origin_is_rate_limited_not_silenced_forever() {
        let mut scanner = ServiceScanner::new();
        let start = Instant::now();
        assert_eq!(scanner.feed("Local: http://localhost:5173/\n", start).len(), 1);
        assert!(scanner
            .feed("Local: http://localhost:5173/\n", start + Duration::from_secs(3))
            .is_empty());
        assert_eq!(
            scanner
                .feed(
                    "Local: http://localhost:5173/\n",
                    start + RECENT_TTL + Duration::from_secs(1)
                )
                .len(),
            1
        );
    }

    /// Two different ports in one banner are two services.
    #[test]
    fn a_banner_with_two_addresses_offers_both() {
        assert_eq!(
            urls("api http://localhost:4000/ and web http://localhost:3000/\n"),
            vec![
                "http://localhost:4000/".to_string(),
                "http://localhost:3000/".to_string()
            ]
        );
    }

    /// A process that never prints a newline must not grow the buffer without
    /// bound; past the cap the text is scanned as it stands.
    #[test]
    fn an_unterminated_flood_is_bounded_and_still_scanned() {
        let mut scanner = ServiceScanner::new();
        let now = Instant::now();
        assert!(scanner.feed("x://", now).is_empty());
        let filler = "y".repeat(CARRY_MAX);
        let found = scanner.feed(&format!("{filler} http://localhost:9100/"), now);
        assert_eq!(
            found.iter().map(|c| c.url.as_str()).collect::<Vec<_>>(),
            vec!["http://localhost:9100/"]
        );
        assert!(scanner.carry.len() <= CARRY_MAX);
    }

    /// The rate-limit table is bounded, and evicting an entry only costs a
    /// repeat offer.
    #[test]
    fn the_recent_table_is_capped() {
        let mut scanner = ServiceScanner::new();
        let now = Instant::now();
        for port in 3000..3000 + RECENT_MAX + 5 {
            scanner.feed(&format!("http://localhost:{port}/\n"), now);
        }
        assert_eq!(scanner.recent.len(), RECENT_MAX);
    }

    /// Output with no address at all is the common case and must not allocate
    /// a carry buffer it will never use.
    #[test]
    fn ordinary_output_is_ignored_without_buffering() {
        let mut scanner = ServiceScanner::new();
        assert!(scanner
            .feed("$ ls -la\ntotal 24\ndrwxr-xr-x\n", Instant::now())
            .is_empty());
        assert!(scanner.carry.is_empty());
    }
}
