//! Codex's file citations, read back into the Markdown links codex-acp makes
//! of them.
//!
//! A Codex model may cite a file with a directive the Codex TUI renders as a
//! link:
//!
//! ```text
//! :codex-file-citation{path="docs/policy.txt" purpose="source"}
//! ```
//!
//! Nothing turns it off: neither codex's instructions nor its feature flags
//! mention it. codex-acp 2.4.0 (#698) rewrites every citation in an agent
//! message as a Markdown link, `[docs/policy.txt](/workspace/docs/policy.txt)`,
//! with a relative path resolved against the session cwd, live and on
//! `session/load` replay. The rollout keeps the directive, so without this a
//! reloaded transcript showed it raw where the live turn showed a link.
//!
//! [`render_file_citations`] repeats the rewrite, ported from the adapter's
//! `CodexFileCitations.ts` (itself a port of codex's
//! `codex-rs/tui/src/assistant_directives.rs`): the same directive syntax, the
//! same 4096-unit cap counted in UTF-16 code units as JavaScript counts, the
//! same escaping, and Node's `path.isAbsolute` / `path.join` for the host's
//! platform (`path.posix`, or `path.win32` on Windows, as of Node 24.18). The
//! tests hold it to the adapter's output on the same inputs, under either set
//! of path rules, produced by running the adapter's function and Node's `path`
//! under Node 24.
//!
//! One input it does not follow: an escaped quote (`\"`) whose backslash sits
//! on the last unit before the cap. The adapter's loop steps past the cap
//! there and reads on (to a `RangeError` when no quote follows); this port
//! stops at the cap, so such a directive stays text.

use std::borrow::Cow;

const CITATION_NAME: &str = "codex-file-citation";

/// A longer directive is not a citation, which bounds both the scan and, in
/// the adapter's stream, the held-back text.
const MAX_CITATION_LENGTH: usize = 4096;

const ASCII_PUNCTUATION: &str = "!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~";

const BACKTICK: u16 = b'`' as u16;
const COLON: u16 = b':' as u16;
const BACKSLASH: u16 = b'\\' as u16;
const SLASH: u16 = b'/' as u16;
const DOT: u16 = b'.' as u16;
const OPEN_BRACE_NAME: &str = "codex-file-citation{";
const CLOSE_BRACE: u16 = b'}' as u16;
const EQUALS: u16 = b'=' as u16;
const DOUBLE_QUOTE: u16 = b'"' as u16;
const SINGLE_QUOTE: u16 = b'\'' as u16;
const SPACE: u16 = b' ' as u16;
const TAB: u16 = b'\t' as u16;
const LF: u16 = b'\n' as u16;
const CR: u16 = b'\r' as u16;
const PATH_KEY: &[u16] = &[b'p' as u16, b'a' as u16, b't' as u16, b'h' as u16];

/// `text` with every file citation outside code replaced by a Markdown link,
/// relative paths resolved against `cwd` — the adapter's
/// `renderFileCitations`. Borrowed back unchanged when the text names no
/// citation at all, which is nearly always.
pub(crate) fn render_file_citations<'a>(text: &'a str, cwd: &str) -> Cow<'a, str> {
    render_with(text, cwd, PathRules::host())
}

/// Which of Node's `path` flavors resolves a citation: the adapter runs on
/// the same host as codeg, so the host's.
#[derive(Clone, Copy)]
enum PathRules {
    Posix,
    Win32,
}

impl PathRules {
    fn host() -> Self {
        if cfg!(windows) {
            Self::Win32
        } else {
            Self::Posix
        }
    }

    /// Node's `path.isAbsolute`.
    fn is_absolute(self, path: &[u16]) -> bool {
        match self {
            Self::Posix => posix::is_absolute(path),
            Self::Win32 => win32::is_absolute(path),
        }
    }

    /// Node's `path.join(cwd, path)`.
    fn join(self, cwd: &[u16], path: &[u16]) -> Vec<u16> {
        match self {
            Self::Posix => posix::join(&[cwd, path]),
            Self::Win32 => win32::join(&[cwd, path]),
        }
    }
}

fn render_with<'a>(text: &'a str, cwd: &str, rules: PathRules) -> Cow<'a, str> {
    if !text.contains(CITATION_NAME) {
        return Cow::Borrowed(text);
    }
    let text_units: Vec<u16> = text.encode_utf16().collect();
    let cwd_units: Vec<u16> = cwd.encode_utf16().collect();
    let mut output: Vec<u16> = Vec::with_capacity(text_units.len());
    // Length of the backtick run that opened the current code span or fence;
    // 0 outside code.
    let mut code_run = 0usize;
    let mut index = 0usize;
    while index < text_units.len() {
        let unit = text_units[index];
        // A backtick run opens or closes a code span or fence; citations in
        // code stay as written.
        if unit == BACKTICK {
            let mut end = index;
            while end < text_units.len() && text_units[end] == BACKTICK {
                end += 1;
            }
            // A run that ends the text is held back by the adapter's stream
            // and flushed as written.
            if end == text_units.len() {
                break;
            }
            let run = end - index;
            if code_run == 0 {
                code_run = run;
            } else if code_run == run {
                code_run = 0;
            }
            output.extend_from_slice(&text_units[index..end]);
            index = end;
            continue;
        }
        // A citation starts at the first `:` of a run, outside code; `\:`
        // escapes it.
        let before = index.checked_sub(1).map(|at| text_units[at]);
        let citation =
            if unit == COLON && code_run == 0 && before != Some(COLON) && before != Some(BACKSLASH)
            {
                parse_citation(&text_units, index)
            } else {
                Parse::NotCitation
            };
        match citation {
            // Unfinished at the end of the text: the stream would wait for
            // more, and its flush sends the rest as written.
            Parse::Partial => break,
            Parse::Citation { path, end } => {
                output.extend(markdown_file_link(&path, &cwd_units, rules));
                index = end;
                continue;
            }
            Parse::NotCitation => {}
        }
        output.push(unit);
        index += 1;
    }
    output.extend_from_slice(&text_units[index..]);
    Cow::Owned(String::from_utf16_lossy(&output))
}

enum Parse {
    Citation {
        path: Vec<u16>,
        end: usize,
    },
    /// The text ends before the directive does.
    Partial,
    NotCitation,
}

/// A citation that starts at `start`. Paths keep backslashes literally, so
/// Windows paths work; `\"` reads as a quote only if that is the only way to
/// parse the directive.
fn parse_citation(text: &[u16], start: usize) -> Parse {
    match parse_citation_with(text, start, false) {
        Parse::NotCitation => parse_citation_with(text, start, true),
        parsed => parsed,
    }
}

/// One to three colons, the name, and `key=value` attributes in braces. A
/// value is quoted with `"` or `'`, or unquoted up to whitespace or `}`.
fn parse_citation_with(text: &[u16], start: usize, backslash_escapes_quote: bool) -> Parse {
    let limit = text.len().min(start + MAX_CITATION_LENGTH);
    // Reaching the end of the text, not the cap, means the directive may
    // continue in a later delta.
    let ended = || {
        if limit == text.len() {
            Parse::Partial
        } else {
            Parse::NotCitation
        }
    };
    let mut index = start;

    while index < limit && text[index] == COLON {
        index += 1;
    }
    if index == limit {
        return ended();
    }
    if index - start > 3 {
        return Parse::NotCitation;
    }

    for expected in OPEN_BRACE_NAME.encode_utf16() {
        if index == limit {
            return ended();
        }
        if text[index] != expected {
            return Parse::NotCitation;
        }
        index += 1;
    }

    let mut keys: Vec<&[u16]> = Vec::new();
    let mut cited_path: Vec<u16> = Vec::new();
    loop {
        index = skip_spaces(text, index, limit);
        if index == limit {
            return ended();
        }
        if text[index] == CLOSE_BRACE {
            break;
        }

        // The key, then `=` with optional spaces around it.
        let key_start = index;
        while index < limit && is_name_unit(text[index]) {
            index += 1;
        }
        if index == limit {
            return ended();
        }
        let key = &text[key_start..index];
        if key.is_empty() || keys.contains(&key) {
            return Parse::NotCitation;
        }
        keys.push(key);

        index = skip_spaces(text, index, limit);
        if index == limit {
            return ended();
        }
        if text[index] != EQUALS {
            return Parse::NotCitation;
        }
        index = skip_spaces(text, index + 1, limit);
        if index == limit {
            return ended();
        }

        let mut value: Vec<u16> = Vec::new();
        let quote = text[index];
        if quote == DOUBLE_QUOTE || quote == SINGLE_QUOTE {
            // A quoted value ends at the matching quote and may hold spaces
            // and braces, but no line break.
            index += 1;
            loop {
                // `>=` where the adapter has `===`: an escaped quote right at
                // the cap steps past it (see the module docs).
                if index >= limit {
                    return ended();
                }
                let unit = text[index];
                if unit == quote {
                    break;
                }
                if unit == LF || unit == CR {
                    return Parse::NotCitation;
                }
                if backslash_escapes_quote
                    && unit == BACKSLASH
                    && text.get(index + 1) == Some(&quote)
                {
                    index += 1;
                }
                value.push(text[index]);
                index += 1;
            }
            index += 1;
        } else {
            let value_start = index;
            while index < limit && !matches!(text[index], SPACE | TAB | CLOSE_BRACE | LF | CR) {
                index += 1;
            }
            if index == limit {
                return ended();
            }
            if index == value_start {
                return Parse::NotCitation;
            }
            value.extend_from_slice(&text[value_start..index]);
        }
        if key == PATH_KEY {
            cited_path = value;
        }
    }

    // Only a citation with a path can become a link.
    if cited_path.is_empty() {
        Parse::NotCitation
    } else {
        Parse::Citation {
            path: cited_path,
            end: index + 1,
        }
    }
}

fn skip_spaces(text: &[u16], mut index: usize, limit: usize) -> usize {
    while index < limit && (text[index] == SPACE || text[index] == TAB) {
        index += 1;
    }
    index
}

fn is_name_unit(unit: u16) -> bool {
    matches!(unit, 0x61..=0x7A | 0x41..=0x5A | 0x30..=0x39)
        || unit == b'_' as u16
        || unit == b'-' as u16
}

fn is_ascii_alpha(unit: u16) -> bool {
    matches!(unit, 0x61..=0x7A | 0x41..=0x5A)
}

fn contains_unit(set: &str, unit: u16) -> bool {
    set.encode_utf16().any(|candidate| candidate == unit)
}

fn markdown_file_link(cited_path: &[u16], cwd: &[u16], rules: PathRules) -> Vec<u16> {
    // Absolute paths, Windows drive paths, and URLs such as `file://` are kept
    // as cited.
    let destination = if rules.is_absolute(cited_path) || is_drive_path_or_url(cited_path) {
        cited_path.to_vec()
    } else {
        rules.join(cwd, cited_path)
    };
    let mut link: Vec<u16> = Vec::new();
    link.push(b'[' as u16);
    link.extend(escape_markdown(cited_path, "[]"));
    link.extend("](".encode_utf16());
    if destination
        .iter()
        .any(|unit| contains_unit(" \t\n\r()<>", *unit))
    {
        link.push(b'<' as u16);
        link.extend(escape_markdown(&destination, "<>"));
        link.push(b'>' as u16);
    } else {
        link.extend(escape_markdown(&destination, ""));
    }
    link.push(b')' as u16);
    link
}

/// `/^(?:[A-Za-z]:[\\/]|[A-Za-z][\w+.-]*:\/\/)/`
fn is_drive_path_or_url(path: &[u16]) -> bool {
    if path.len() >= 3
        && is_ascii_alpha(path[0])
        && path[1] == COLON
        && (path[2] == BACKSLASH || path[2] == SLASH)
    {
        return true;
    }
    if !path.first().is_some_and(|unit| is_ascii_alpha(*unit)) {
        return false;
    }
    // `[\w+.-]` is the name set (`\w` and `-`) plus `+` and `.`.
    let mut index = 1;
    while index < path.len()
        && (is_name_unit(path[index]) || path[index] == b'+' as u16 || path[index] == DOT)
    {
        index += 1;
    }
    path[index..].starts_with(&[COLON, SLASH, SLASH])
}

/// Escapes the `special` characters, and a backslash that CommonMark would
/// read as an escape.
fn escape_markdown(text: &[u16], special: &str) -> Vec<u16> {
    let mut escaped = Vec::with_capacity(text.len());
    for (index, &unit) in text.iter().enumerate() {
        let next = text.get(index + 1);
        if contains_unit(special, unit)
            || (unit == BACKSLASH
                && next.is_some_and(|next| contains_unit(ASCII_PUNCTUATION, *next)))
        {
            escaped.push(BACKSLASH);
        }
        escaped.push(unit);
    }
    escaped
}

/// Node's internal `normalizeString`: resolves `.` and `..` segments.
fn normalize_string(
    path: &[u16],
    allow_above_root: bool,
    separator: u16,
    is_separator: fn(u16) -> bool,
) -> Vec<u16> {
    let mut res: Vec<u16> = Vec::new();
    let mut last_segment_length = 0usize;
    let mut last_slash: isize = -1;
    let mut dots: i32 = 0;
    let mut code: u16 = 0;
    let len = path.len();
    let mut i = 0usize;
    while i <= len {
        if i < len {
            code = path[i];
        } else if is_separator(code) {
            break;
        } else {
            code = SLASH;
        }

        if is_separator(code) {
            if last_slash == i as isize - 1 || dots == 1 {
                // NOOP
            } else if dots == 2 {
                let ends_in_dot_dot = res.len() >= 2
                    && last_segment_length == 2
                    && res[res.len() - 1] == DOT
                    && res[res.len() - 2] == DOT;
                if !ends_in_dot_dot {
                    if res.len() > 2 {
                        let last_slash_index =
                            res.len() as isize - last_segment_length as isize - 1;
                        if last_slash_index == -1 {
                            res.clear();
                            last_segment_length = 0;
                        } else {
                            res.truncate(last_slash_index.max(0) as usize);
                            last_segment_length = match res.iter().rposition(|u| *u == separator) {
                                Some(at) => res.len() - 1 - at,
                                // `lastIndexOf` is -1: `res.length - 1 - (-1)`.
                                None => res.len(),
                            };
                        }
                        last_slash = i as isize;
                        dots = 0;
                        i += 1;
                        continue;
                    } else if !res.is_empty() {
                        res.clear();
                        last_segment_length = 0;
                        last_slash = i as isize;
                        dots = 0;
                        i += 1;
                        continue;
                    }
                }
                if allow_above_root {
                    if !res.is_empty() {
                        res.push(separator);
                    }
                    res.extend_from_slice(&[DOT, DOT]);
                    last_segment_length = 2;
                }
            } else {
                let segment_start = (last_slash + 1) as usize;
                if !res.is_empty() {
                    res.push(separator);
                }
                res.extend_from_slice(&path[segment_start..i]);
                last_segment_length = i - segment_start;
            }
            last_slash = i as isize;
            dots = 0;
        } else if code == DOT && dots != -1 {
            // Saturating: only 1 and 2 dots mean anything, and a run of 2^31
            // must not overflow.
            dots = dots.saturating_add(1);
        } else {
            dots = -1;
        }
        i += 1;
    }
    res
}

mod posix {
    use super::{normalize_string, DOT, SLASH};

    fn is_separator(unit: u16) -> bool {
        unit == SLASH
    }

    pub(super) fn is_absolute(path: &[u16]) -> bool {
        path.first() == Some(&SLASH)
    }

    pub(super) fn join(parts: &[&[u16]]) -> Vec<u16> {
        let mut joined: Vec<u16> = Vec::new();
        for part in parts.iter().filter(|part| !part.is_empty()) {
            if !joined.is_empty() {
                joined.push(SLASH);
            }
            joined.extend_from_slice(part);
        }
        if joined.is_empty() {
            return vec![DOT];
        }
        normalize(&joined)
    }

    pub(super) fn normalize(path: &[u16]) -> Vec<u16> {
        if path.is_empty() {
            return vec![DOT];
        }
        let absolute = path[0] == SLASH;
        let trailing_separator = path[path.len() - 1] == SLASH;
        let mut normalized = normalize_string(path, !absolute, SLASH, is_separator);
        if normalized.is_empty() {
            if absolute {
                return vec![SLASH];
            }
            return if trailing_separator {
                vec![DOT, SLASH]
            } else {
                vec![DOT]
            };
        }
        if trailing_separator {
            normalized.push(SLASH);
        }
        if absolute {
            normalized.insert(0, SLASH);
        }
        normalized
    }
}

mod win32 {
    use super::{is_ascii_alpha, normalize_string, BACKSLASH, COLON, DOT, SLASH};

    const RESERVED_NAMES: &[&str] = &[
        "CON",
        "PRN",
        "AUX",
        "NUL",
        "COM1",
        "COM2",
        "COM3",
        "COM4",
        "COM5",
        "COM6",
        "COM7",
        "COM8",
        "COM9",
        "LPT1",
        "LPT2",
        "LPT3",
        "LPT4",
        "LPT5",
        "LPT6",
        "LPT7",
        "LPT8",
        "LPT9",
        "COM\u{b9}",
        "COM\u{b2}",
        "COM\u{b3}",
        "LPT\u{b9}",
        "LPT\u{b2}",
        "LPT\u{b3}",
    ];

    fn is_separator(unit: u16) -> bool {
        unit == SLASH || unit == BACKSLASH
    }

    /// JavaScript's `slice(0, end)`: a negative end counts from the back.
    fn js_slice_to(path: &[u16], end: isize) -> &[u16] {
        let len = path.len() as isize;
        let end = if end < 0 {
            (len + end).max(0)
        } else {
            end.min(len)
        };
        &path[..end as usize]
    }

    /// Node's `isWindowsReservedName(path, colonIndex)`, `-1` included.
    fn is_reserved_name(path: &[u16], colon_index: isize) -> bool {
        let device = String::from_utf16_lossy(js_slice_to(path, colon_index)).to_uppercase();
        RESERVED_NAMES.contains(&device.as_str())
    }

    fn index_of(path: &[u16], unit: u16, from: usize) -> isize {
        path.iter()
            .skip(from)
            .position(|candidate| *candidate == unit)
            .map_or(-1, |at| (at + from) as isize)
    }

    fn units(text: &str) -> Vec<u16> {
        text.encode_utf16().collect()
    }

    pub(super) fn is_absolute(path: &[u16]) -> bool {
        let Some(&code) = path.first() else {
            return false;
        };
        is_separator(code)
            || (path.len() > 2 && is_ascii_alpha(code) && path[1] == COLON && is_separator(path[2]))
    }

    pub(super) fn join(parts: &[&[u16]]) -> Vec<u16> {
        let parts: Vec<&[u16]> = parts
            .iter()
            .copied()
            .filter(|part| !part.is_empty())
            .collect();
        let Some(first_part) = parts.first().copied() else {
            return vec![DOT];
        };
        let mut joined: Vec<u16> = Vec::new();
        for (index, part) in parts.iter().enumerate() {
            if index > 0 {
                joined.push(BACKSLASH);
            }
            joined.extend_from_slice(part);
        }

        // A joined path must not start with two separators unless the first
        // part is clearly a UNC path (exactly two, then a non-separator).
        let mut needs_replace = true;
        let mut slash_count = 0usize;
        if is_separator(first_part[0]) {
            slash_count += 1;
            if first_part.len() > 1 && is_separator(first_part[1]) {
                slash_count += 1;
                if first_part.len() > 2 {
                    if is_separator(first_part[2]) {
                        slash_count += 1;
                    } else {
                        needs_replace = false;
                    }
                }
            }
        }
        if needs_replace {
            while slash_count < joined.len() && is_separator(joined[slash_count]) {
                slash_count += 1;
            }
            if slash_count >= 2 {
                let mut replaced = vec![BACKSLASH];
                replaced.extend_from_slice(&joined[slash_count..]);
                joined = replaced;
            }
        }

        // Node skips normalization when a segment names a reserved device.
        let segments: Vec<&[u16]> = joined
            .split(|unit| *unit == BACKSLASH)
            .filter(|segment| !segment.is_empty())
            .collect();
        if segments.iter().any(|segment| {
            let colon_index = index_of(segment, COLON, 0);
            colon_index != -1 && is_reserved_name(segment, colon_index)
        }) {
            return joined
                .iter()
                .map(|unit| if *unit == SLASH { BACKSLASH } else { *unit })
                .collect();
        }

        normalize(&joined)
    }

    pub(super) fn normalize(path: &[u16]) -> Vec<u16> {
        let len = path.len();
        if len == 0 {
            return vec![DOT];
        }
        let mut root_end = 0usize;
        let mut device: Option<Vec<u16>> = None;
        let mut absolute = false;
        let code = path[0];

        if len == 1 {
            return if code == SLASH {
                vec![BACKSLASH]
            } else {
                path.to_vec()
            };
        }
        if is_separator(code) {
            // Possibly a UNC root; absolute of some kind either way.
            absolute = true;
            if is_separator(path[1]) {
                let mut j = 2;
                let mut last = j;
                while j < len && !is_separator(path[j]) {
                    j += 1;
                }
                if j < len && j != last {
                    let first_part = &path[last..j];
                    last = j;
                    while j < len && is_separator(path[j]) {
                        j += 1;
                    }
                    if j < len && j != last {
                        last = j;
                        while j < len && !is_separator(path[j]) {
                            j += 1;
                        }
                        if j == len || j != last {
                            if first_part == [DOT].as_slice()
                                || first_part == [b'?' as u16].as_slice()
                            {
                                // A device root (`\\.\PHYSICALDRIVE0`).
                                let mut root = units("\\\\");
                                root.extend_from_slice(first_part);
                                device = Some(root);
                                root_end = 4;
                                let colon_index = index_of(path, COLON, 0);
                                let end = ((colon_index + 1) as usize).clamp(0, len);
                                let possible_device: &[u16] =
                                    if end > 4 { &path[4..end] } else { &[] };
                                if is_reserved_name(
                                    possible_device,
                                    possible_device.len() as isize - 1,
                                ) {
                                    let mut root = units("\\\\?\\");
                                    root.extend_from_slice(possible_device);
                                    device = Some(root);
                                    root_end = 4 + possible_device.len();
                                }
                            } else if j == len {
                                // A UNC root and nothing else.
                                let mut root = units("\\\\");
                                root.extend_from_slice(first_part);
                                root.push(BACKSLASH);
                                root.extend_from_slice(&path[last..]);
                                root.push(BACKSLASH);
                                return root;
                            } else {
                                let mut root = units("\\\\");
                                root.extend_from_slice(first_part);
                                root.push(BACKSLASH);
                                root.extend_from_slice(&path[last..j]);
                                device = Some(root);
                                root_end = j;
                            }
                        }
                    }
                }
            } else {
                root_end = 1;
            }
        } else {
            let colon_index = index_of(path, COLON, 0);
            if colon_index > 0 {
                if is_ascii_alpha(code) && colon_index == 1 {
                    device = Some(path[..2].to_vec());
                    root_end = 2;
                    if len > 2 && is_separator(path[2]) {
                        absolute = true;
                        root_end = 3;
                    }
                } else if is_reserved_name(path, colon_index) {
                    device = Some(path[..(colon_index as usize + 1)].to_vec());
                    root_end = colon_index as usize + 1;
                }
            }
        }

        let mut tail = if root_end < len {
            normalize_string(&path[root_end..], !absolute, BACKSLASH, is_separator)
        } else {
            Vec::new()
        };
        if tail.is_empty() && !absolute {
            tail = vec![DOT];
        }
        if !tail.is_empty() && is_separator(path[len - 1]) {
            tail.push(BACKSLASH);
        }
        let dot_prefixed = |tail: &[u16]| {
            let mut out = vec![DOT, BACKSLASH];
            out.extend_from_slice(tail);
            out
        };
        if !absolute && device.is_none() && path.contains(&COLON) {
            // Keep a relative tail from reading as a drive (CVE-2024-36139).
            if tail.len() >= 2 && is_ascii_alpha(tail[0]) && tail[1] == COLON {
                return dot_prefixed(&tail);
            }
            let mut index = index_of(path, COLON, 0);
            while index != -1 {
                let at = index as usize;
                if at == len - 1 || is_separator(path[at + 1]) {
                    return dot_prefixed(&tail);
                }
                index = index_of(path, COLON, at + 1);
            }
        }
        let colon_index = index_of(path, COLON, 0);
        if is_reserved_name(path, colon_index) {
            let mut out = vec![DOT, BACKSLASH];
            if let Some(device) = &device {
                out.extend_from_slice(device);
            }
            out.extend_from_slice(&tail);
            return out;
        }
        match device {
            None if absolute => {
                let mut out = vec![BACKSLASH];
                out.extend_from_slice(&tail);
                out
            }
            None => tail,
            Some(mut device) if absolute => {
                device.push(BACKSLASH);
                device.extend_from_slice(&tail);
                device
            }
            Some(mut device) => {
                device.extend_from_slice(&tail);
                device
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn units(text: &str) -> Vec<u16> {
        text.encode_utf16().collect()
    }

    fn text(units: &[u16]) -> String {
        String::from_utf16(units).expect("valid UTF-16")
    }

    /// Inputs run through codex-acp 2.4.0's own `renderFileCitations` under
    /// Node 24.18.0 on macOS (`path.posix`): the adapter's cases, then codeg's
    /// edges, each with what it returned.
    const ADAPTER_RENDERS: &[(&str, &str, &str)] = &[
        (":codex-file-citation{path=\"src/app.ts\" purpose=\"source\"}\n:codex-file-citation{path=/abs/a.txt purpose=output}\n:codex-file-citation{path=\"C:\\repo\\report.xlsx\"}\n:codex-file-citation{path=\"docs/my notes (v2).md:12\"}\n:codex-file-citation{path=\"a[1].md\"}\n:codex-file-citation{path=\"C:\\repo\\_build\\a.md\"}\n:codex-file-citation{path=\"C:\\My Docs\\(1)\\a.md\"}", "/repo", "[src/app.ts](/repo/src/app.ts)\n[/abs/a.txt](/abs/a.txt)\n[C:\\repo\\report.xlsx](C:\\repo\\report.xlsx)\n[docs/my notes (v2).md:12](</repo/docs/my notes (v2).md:12>)\n[a\\[1\\].md](/repo/a[1].md)\n[C:\\repo\\\\_build\\a.md](C:\\repo\\\\_build\\a.md)\n[C:\\My Docs\\\\(1)\\a.md](<C:\\My Docs\\\\(1)\\a.md>)"),
        ("`:codex-file-citation{path=\"a.txt\"}`", "/repo", "`:codex-file-citation{path=\"a.txt\"}`"),
        ("```text\n:codex-file-citation{path=\"a.txt\"}\n```\n", "/repo", "```text\n:codex-file-citation{path=\"a.txt\"}\n```\n"),
        ("\\:codex-file-citation{path=\"a.txt\"}", "/repo", "\\:codex-file-citation{path=\"a.txt\"}"),
        ("::::codex-file-citation{path=\"a.txt\"}", "/repo", "::::codex-file-citation{path=\"a.txt\"}"),
        (":codex-file-citation{path=\"a.txt\" path=\"b.txt\"}", "/repo", ":codex-file-citation{path=\"a.txt\" path=\"b.txt\"}"),
        (":codex-file-citation{path=\"a\n.txt\"}", "/repo", ":codex-file-citation{path=\"a\n.txt\"}"),
        (":codex-file-citation{purpose=\"source\"}", "/repo", ":codex-file-citation{purpose=\"source\"}"),
        (":codex-file-citation{path=\"\"}", "/repo", ":codex-file-citation{path=\"\"}"),
        (":codex-file-citation{path=\"a.txt\" broken}", "/repo", ":codex-file-citation{path=\"a.txt\" broken}"),
        ("Ratio 3:4 and :codex-file without a body", "/repo", "Ratio 3:4 and :codex-file without a body"),
        (":codex-file-citation{path='a.txt'}\n:codex-file-citation{ path = \"b.txt\" }\n::codex-file-citation{path=\"c.txt\"}\n:codex-file-citation{purpose=\"source\"path=\"d.txt\"}\n:codex-file-citation{path=\"e\\\"f.txt\"}", "/repo", "[a.txt](/repo/a.txt)\n[b.txt](/repo/b.txt)\n[c.txt](/repo/c.txt)\n[d.txt](/repo/d.txt)\n[e\"f.txt](/repo/e\"f.txt)"),
        ("`x` :codex-file-citation{path=\"a.txt\"}", "/repo", "`x` [a.txt](/repo/a.txt)"),
        ("See :codex-file-citation{path=\"a.txt\" purpose=\"source\"} and ``:codex-file-citation{path=\"b\"}``.", "/repo", "See [a.txt](/repo/a.txt) and ``:codex-file-citation{path=\"b\"}``."),
        ("Read the policy :codex-file-citation{path=\"docs/policy.txt\" purpose=\"source\"} and ::codex-file-citation{path='/abs/dir/a b.txt'}. Code `:codex-file-citation{path=\"in-code.txt\"}` stays, so does \\:codex-file-citation{path=\"escaped.txt\"} here. End with a tick `x`", "/repo", "Read the policy [docs/policy.txt](/repo/docs/policy.txt) and [/abs/dir/a b.txt](</abs/dir/a b.txt>). Code `:codex-file-citation{path=\"in-code.txt\"}` stays, so does \\:codex-file-citation{path=\"escaped.txt\"} here. End with a tick `x`"),
        (":codex-file-citation{path=\"./docs/../src/./lib.rs\"}", "/repo", "[./docs/../src/./lib.rs](/repo/src/lib.rs)"),
        (":codex-file-citation{path=\"./docs/../src/./lib.rs\"}", "/Users/x/My Project", "[./docs/../src/./lib.rs](</Users/x/My Project/src/lib.rs>)"),
        (":codex-file-citation{path=\"./docs/../src/./lib.rs\"}", "/w/a(b)", "[./docs/../src/./lib.rs](</w/a(b)/src/lib.rs>)"),
        (":codex-file-citation{path=\"./docs/../src/./lib.rs\"}", "/", "[./docs/../src/./lib.rs](/src/lib.rs)"),
        (":codex-file-citation{path=\"./docs/../src/./lib.rs\"}", "", "[./docs/../src/./lib.rs](src/lib.rs)"),
        (":codex-file-citation{path=\"../outside.txt\"}", "/repo", "[../outside.txt](/outside.txt)"),
        (":codex-file-citation{path=\"../outside.txt\"}", "/Users/x/My Project", "[../outside.txt](/Users/x/outside.txt)"),
        (":codex-file-citation{path=\"../outside.txt\"}", "/w/a(b)", "[../outside.txt](/w/outside.txt)"),
        (":codex-file-citation{path=\"../outside.txt\"}", "/", "[../outside.txt](/outside.txt)"),
        (":codex-file-citation{path=\"../outside.txt\"}", "", "[../outside.txt](../outside.txt)"),
        (":codex-file-citation{path=\"../../../../../../x\"}", "/repo", "[../../../../../../x](/x)"),
        (":codex-file-citation{path=\"../../../../../../x\"}", "/Users/x/My Project", "[../../../../../../x](/x)"),
        (":codex-file-citation{path=\"../../../../../../x\"}", "/w/a(b)", "[../../../../../../x](/x)"),
        (":codex-file-citation{path=\"../../../../../../x\"}", "/", "[../../../../../../x](/x)"),
        (":codex-file-citation{path=\"../../../../../../x\"}", "", "[../../../../../../x](../../../../../../x)"),
        (":codex-file-citation{path=\"dir/\"}", "/repo", "[dir/](/repo/dir/)"),
        (":codex-file-citation{path=\"dir/\"}", "/Users/x/My Project", "[dir/](</Users/x/My Project/dir/>)"),
        (":codex-file-citation{path=\"dir/\"}", "/w/a(b)", "[dir/](</w/a(b)/dir/>)"),
        (":codex-file-citation{path=\"dir/\"}", "/", "[dir/](/dir/)"),
        (":codex-file-citation{path=\"dir/\"}", "", "[dir/](dir/)"),
        (":codex-file-citation{path=\".\"}", "/repo", "[.](/repo)"),
        (":codex-file-citation{path=\".\"}", "/Users/x/My Project", "[.](</Users/x/My Project>)"),
        (":codex-file-citation{path=\".\"}", "/w/a(b)", "[.](</w/a(b)>)"),
        (":codex-file-citation{path=\".\"}", "/", "[.](/)"),
        (":codex-file-citation{path=\".\"}", "", "[.](.)"),
        (":codex-file-citation{path=\"..\"}", "/repo", "[..](/)"),
        (":codex-file-citation{path=\"..\"}", "/Users/x/My Project", "[..](/Users/x)"),
        (":codex-file-citation{path=\"..\"}", "/w/a(b)", "[..](/w)"),
        (":codex-file-citation{path=\"..\"}", "/", "[..](/)"),
        (":codex-file-citation{path=\"..\"}", "", "[..](..)"),
        (":codex-file-citation{path=\"a//b///c\"}", "/repo", "[a//b///c](/repo/a/b/c)"),
        (":codex-file-citation{path=\"file:///tmp/x.txt\"}", "/repo", "[file:///tmp/x.txt](file:///tmp/x.txt)"),
        (":codex-file-citation{path=\"https://example.com/a(b).html\"}", "/repo", "[https://example.com/a(b).html](<https://example.com/a(b).html>)"),
        (":codex-file-citation{path=\"git+ssh://h/x\"}", "/repo", "[git+ssh://h/x](git+ssh://h/x)"),
        (":codex-file-citation{path=\"1abc://x\"}", "/repo", "[1abc://x](/repo/1abc:/x)"),
        (":codex-file-citation{path=\"c:/x/y\"}", "/repo", "[c:/x/y](c:/x/y)"),
        (":codex-file-citation{path=\"c:x\"}", "/repo", "[c:x](/repo/c:x)"),
        (":codex-file-citation{path=\"数据/报告 2026.md\"}", "/repo", "[数据/报告 2026.md](</repo/数据/报告 2026.md>)"),
        (":codex-file-citation{path=\"数据/报告 2026.md\"}", "/Users/x/My Project", "[数据/报告 2026.md](</Users/x/My Project/数据/报告 2026.md>)"),
        (":codex-file-citation{path=\"数据/报告 2026.md\"}", "/w/a(b)", "[数据/报告 2026.md](</w/a(b)/数据/报告 2026.md>)"),
        (":codex-file-citation{path=\"数据/报告 2026.md\"}", "/", "[数据/报告 2026.md](</数据/报告 2026.md>)"),
        (":codex-file-citation{path=\"数据/报告 2026.md\"}", "", "[数据/报告 2026.md](<数据/报告 2026.md>)"),
        (":codex-file-citation{path=\"emoji/😀file.txt\"}", "/repo", "[emoji/😀file.txt](/repo/emoji/😀file.txt)"),
        ("pre 😀 :codex-file-citation{path=\"a😀b\"} post", "/repo", "pre 😀 [a😀b](/repo/a😀b) post"),
        (":codex-file-citation{path=\"<weird>.txt\"}", "/repo", "[<weird>.txt](</repo/\\<weird\\>.txt>)"),
        (":codex-file-citation{path=\"tab\there\"}", "/repo", "[tab\there](</repo/tab\there>)"),
        (":codex-file-citation{path=\"back\\\\slash\\[x]\"}", "/repo", "[back\\\\\\slash\\\\\\[x\\]](/repo/back\\\\\\slash\\\\[x])"),
        (":codex-file-citation{path=\"a\\*b\"}", "/repo", "[a\\\\*b](/repo/a\\\\*b)"),
        (":codex-file-citation{path=\"end\\\"}", "/repo", "[end\\](/repo/end\\)"),
        (":codex-file-citation{Path=\"a.txt\"}", "/repo", ":codex-file-citation{Path=\"a.txt\"}"),
        (":codex-file-citation{path_x=\"a.txt\"}", "/repo", ":codex-file-citation{path_x=\"a.txt\"}"),
        (":codex-file-citation{path=\"a.txt\" purpose=}", "/repo", ":codex-file-citation{path=\"a.txt\" purpose=}"),
        (":codex-file-citation{path=a.txt}", "/repo", "[a.txt](/repo/a.txt)"),
        (":codex-file-citation{path=a.txt\n}", "/repo", ":codex-file-citation{path=a.txt\n}"),
        (":codex-file-citation{path=\"a.txt\"} :codex-file-citation{path=\"b.txt\"}", "/repo", "[a.txt](/repo/a.txt) [b.txt](/repo/b.txt)"),
        (":codex-file-citation {path=\"a.txt\"}", "/repo", ":codex-file-citation {path=\"a.txt\"}"),
        (":codex-file-citation{path=\"a.txt\"", "/repo", ":codex-file-citation{path=\"a.txt\""),
        (":codex-file-citation{path=\"a.txt\" ", "/repo", ":codex-file-citation{path=\"a.txt\" "),
        ("x:codex-file-citation{path=\"a.txt\"}", "/repo", "x[a.txt](/repo/a.txt)"),
        ("a::codex-file-citation{path=\"a.txt\"}", "/repo", "a[a.txt](/repo/a.txt)"),
        ("``` code `:codex-file-citation{path=\"a\"}` ```\n:codex-file-citation{path=\"b\"}", "/repo", "``` code `:codex-file-citation{path=\"a\"}` ```\n[b](/repo/b)"),
        ("`` ` `` :codex-file-citation{path=\"c\"}", "/repo", "`` ` `` [c](/repo/c)"),
        ("`unclosed :codex-file-citation{path=\"d\"}", "/repo", "`unclosed :codex-file-citation{path=\"d\"}"),
        ("trailing ``", "/repo", "trailing ``"),
        ("trailing ` :codex-file-citation{path=\"e\"}", "/repo", "trailing ` :codex-file-citation{path=\"e\"}"),
        (":codex-file-citation{path=\"q\\'s\"}", "/repo", "[q\\\\'s](/repo/q\\\\'s)"),
        (":codex-file-citation{path='it\\'s'}", "/repo", "[it's](/repo/it's)"),
        (":codex-file-citation{path=\"dq\\\"inner\\\"x\"}", "/repo", "[dq\"inner\"x](/repo/dq\"inner\"x)"),
        (":codex-file-citation{path=\"noesc\\\"}", "/repo", "[noesc\\](/repo/noesc\\)"),
        (":codex-file-citation{path=\"a\" purpose=\"b\\\"c\"}", "/repo", "[a](/repo/a)"),
        (":codex-file-citation{path=\"\\\\server\\share\\x\"}", "/repo", "[\\\\\\server\\share\\x](/repo/\\\\\\server\\share\\x)"),
        (":codex-file-citation{path=\"/\"}", "/repo", "[/](/)"),
        (":codex-file-citation{path=\"~/x\"}", "/repo", "[~/x](/repo/~/x)"),
        (":codex-file-citation{path=\" lead space\"}", "/repo", "[ lead space](</repo/ lead space>)"),
        (":codex-file-citation{path=\"a.txt\"}\n:codex-file-citation{path=\"b.txt\"}", "/repo", "[a.txt](/repo/a.txt)\n[b.txt](/repo/b.txt)"),
    ];

    /// The same inputs through the adapter's function with Node's `path`
    /// swapped for `path.win32`, as the adapter runs on Windows: every input
    /// whose answer differs from the posix one, under a posix-shaped, a drive
    /// and a UNC cwd, and a few that read the same.
    const ADAPTER_RENDERS_ON_WINDOWS: &[(&str, &str, &str)] = &[
        (":codex-file-citation{path=\"src/app.ts\" purpose=\"source\"}\n:codex-file-citation{path=/abs/a.txt purpose=output}\n:codex-file-citation{path=\"C:\\repo\\report.xlsx\"}\n:codex-file-citation{path=\"docs/my notes (v2).md:12\"}\n:codex-file-citation{path=\"a[1].md\"}\n:codex-file-citation{path=\"C:\\repo\\_build\\a.md\"}\n:codex-file-citation{path=\"C:\\My Docs\\(1)\\a.md\"}", "/repo", "[src/app.ts](\\repo\\src\\app.ts)\n[/abs/a.txt](/abs/a.txt)\n[C:\\repo\\report.xlsx](C:\\repo\\report.xlsx)\n[docs/my notes (v2).md:12](<\\repo\\docs\\my notes (v2).md:12>)\n[a\\[1\\].md](\\repo\\a[1].md)\n[C:\\repo\\\\_build\\a.md](C:\\repo\\\\_build\\a.md)\n[C:\\My Docs\\\\(1)\\a.md](<C:\\My Docs\\\\(1)\\a.md>)"),
        (":codex-file-citation{path=\"src/app.ts\" purpose=\"source\"}\n:codex-file-citation{path=/abs/a.txt purpose=output}\n:codex-file-citation{path=\"C:\\repo\\report.xlsx\"}\n:codex-file-citation{path=\"docs/my notes (v2).md:12\"}\n:codex-file-citation{path=\"a[1].md\"}\n:codex-file-citation{path=\"C:\\repo\\_build\\a.md\"}\n:codex-file-citation{path=\"C:\\My Docs\\(1)\\a.md\"}", "C:\\repo", "[src/app.ts](C:\\repo\\src\\app.ts)\n[/abs/a.txt](/abs/a.txt)\n[C:\\repo\\report.xlsx](C:\\repo\\report.xlsx)\n[docs/my notes (v2).md:12](<C:\\repo\\docs\\my notes (v2).md:12>)\n[a\\[1\\].md](C:\\repo\\a[1].md)\n[C:\\repo\\\\_build\\a.md](C:\\repo\\\\_build\\a.md)\n[C:\\My Docs\\\\(1)\\a.md](<C:\\My Docs\\\\(1)\\a.md>)"),
        (":codex-file-citation{path=\"src/app.ts\" purpose=\"source\"}\n:codex-file-citation{path=/abs/a.txt purpose=output}\n:codex-file-citation{path=\"C:\\repo\\report.xlsx\"}\n:codex-file-citation{path=\"docs/my notes (v2).md:12\"}\n:codex-file-citation{path=\"a[1].md\"}\n:codex-file-citation{path=\"C:\\repo\\_build\\a.md\"}\n:codex-file-citation{path=\"C:\\My Docs\\(1)\\a.md\"}", "\\\\server\\share\\w", "[src/app.ts](\\\\\\server\\share\\w\\src\\app.ts)\n[/abs/a.txt](/abs/a.txt)\n[C:\\repo\\report.xlsx](C:\\repo\\report.xlsx)\n[docs/my notes (v2).md:12](<\\\\\\server\\share\\w\\docs\\my notes (v2).md:12>)\n[a\\[1\\].md](\\\\\\server\\share\\w\\a[1].md)\n[C:\\repo\\\\_build\\a.md](C:\\repo\\\\_build\\a.md)\n[C:\\My Docs\\\\(1)\\a.md](<C:\\My Docs\\\\(1)\\a.md>)"),
        (":codex-file-citation{path='a.txt'}\n:codex-file-citation{ path = \"b.txt\" }\n::codex-file-citation{path=\"c.txt\"}\n:codex-file-citation{purpose=\"source\"path=\"d.txt\"}\n:codex-file-citation{path=\"e\\\"f.txt\"}", "/repo", "[a.txt](\\repo\\a.txt)\n[b.txt](\\repo\\b.txt)\n[c.txt](\\repo\\c.txt)\n[d.txt](\\repo\\d.txt)\n[e\"f.txt](\\repo\\e\"f.txt)"),
        (":codex-file-citation{path='a.txt'}\n:codex-file-citation{ path = \"b.txt\" }\n::codex-file-citation{path=\"c.txt\"}\n:codex-file-citation{purpose=\"source\"path=\"d.txt\"}\n:codex-file-citation{path=\"e\\\"f.txt\"}", "C:\\repo", "[a.txt](C:\\repo\\a.txt)\n[b.txt](C:\\repo\\b.txt)\n[c.txt](C:\\repo\\c.txt)\n[d.txt](C:\\repo\\d.txt)\n[e\"f.txt](C:\\repo\\e\"f.txt)"),
        (":codex-file-citation{path='a.txt'}\n:codex-file-citation{ path = \"b.txt\" }\n::codex-file-citation{path=\"c.txt\"}\n:codex-file-citation{purpose=\"source\"path=\"d.txt\"}\n:codex-file-citation{path=\"e\\\"f.txt\"}", "\\\\server\\share\\w", "[a.txt](\\\\\\server\\share\\w\\a.txt)\n[b.txt](\\\\\\server\\share\\w\\b.txt)\n[c.txt](\\\\\\server\\share\\w\\c.txt)\n[d.txt](\\\\\\server\\share\\w\\d.txt)\n[e\"f.txt](\\\\\\server\\share\\w\\e\"f.txt)"),
        ("`x` :codex-file-citation{path=\"a.txt\"}", "/repo", "`x` [a.txt](\\repo\\a.txt)"),
        ("`x` :codex-file-citation{path=\"a.txt\"}", "C:\\repo", "`x` [a.txt](C:\\repo\\a.txt)"),
        ("`x` :codex-file-citation{path=\"a.txt\"}", "\\\\server\\share\\w", "`x` [a.txt](\\\\\\server\\share\\w\\a.txt)"),
        ("See :codex-file-citation{path=\"a.txt\" purpose=\"source\"} and ``:codex-file-citation{path=\"b\"}``.", "/repo", "See [a.txt](\\repo\\a.txt) and ``:codex-file-citation{path=\"b\"}``."),
        ("See :codex-file-citation{path=\"a.txt\" purpose=\"source\"} and ``:codex-file-citation{path=\"b\"}``.", "C:\\repo", "See [a.txt](C:\\repo\\a.txt) and ``:codex-file-citation{path=\"b\"}``."),
        ("See :codex-file-citation{path=\"a.txt\" purpose=\"source\"} and ``:codex-file-citation{path=\"b\"}``.", "\\\\server\\share\\w", "See [a.txt](\\\\\\server\\share\\w\\a.txt) and ``:codex-file-citation{path=\"b\"}``."),
        ("Read the policy :codex-file-citation{path=\"docs/policy.txt\" purpose=\"source\"} and ::codex-file-citation{path='/abs/dir/a b.txt'}. Code `:codex-file-citation{path=\"in-code.txt\"}` stays, so does \\:codex-file-citation{path=\"escaped.txt\"} here. End with a tick `x`", "/repo", "Read the policy [docs/policy.txt](\\repo\\docs\\policy.txt) and [/abs/dir/a b.txt](</abs/dir/a b.txt>). Code `:codex-file-citation{path=\"in-code.txt\"}` stays, so does \\:codex-file-citation{path=\"escaped.txt\"} here. End with a tick `x`"),
        ("Read the policy :codex-file-citation{path=\"docs/policy.txt\" purpose=\"source\"} and ::codex-file-citation{path='/abs/dir/a b.txt'}. Code `:codex-file-citation{path=\"in-code.txt\"}` stays, so does \\:codex-file-citation{path=\"escaped.txt\"} here. End with a tick `x`", "C:\\repo", "Read the policy [docs/policy.txt](C:\\repo\\docs\\policy.txt) and [/abs/dir/a b.txt](</abs/dir/a b.txt>). Code `:codex-file-citation{path=\"in-code.txt\"}` stays, so does \\:codex-file-citation{path=\"escaped.txt\"} here. End with a tick `x`"),
        ("Read the policy :codex-file-citation{path=\"docs/policy.txt\" purpose=\"source\"} and ::codex-file-citation{path='/abs/dir/a b.txt'}. Code `:codex-file-citation{path=\"in-code.txt\"}` stays, so does \\:codex-file-citation{path=\"escaped.txt\"} here. End with a tick `x`", "\\\\server\\share\\w", "Read the policy [docs/policy.txt](\\\\\\server\\share\\w\\docs\\policy.txt) and [/abs/dir/a b.txt](</abs/dir/a b.txt>). Code `:codex-file-citation{path=\"in-code.txt\"}` stays, so does \\:codex-file-citation{path=\"escaped.txt\"} here. End with a tick `x`"),
        (":codex-file-citation{path=\"./docs/../src/./lib.rs\"}", "/repo", "[./docs/../src/./lib.rs](\\repo\\src\\lib.rs)"),
        (":codex-file-citation{path=\"./docs/../src/./lib.rs\"}", "C:\\repo", "[./docs/../src/./lib.rs](C:\\repo\\src\\lib.rs)"),
        (":codex-file-citation{path=\"./docs/../src/./lib.rs\"}", "\\\\server\\share\\w", "[./docs/../src/./lib.rs](\\\\\\server\\share\\w\\src\\lib.rs)"),
        (":codex-file-citation{path=\"../outside.txt\"}", "/repo", "[../outside.txt](\\outside.txt)"),
        (":codex-file-citation{path=\"../outside.txt\"}", "C:\\repo", "[../outside.txt](C:\\outside.txt)"),
        (":codex-file-citation{path=\"../outside.txt\"}", "\\\\server\\share\\w", "[../outside.txt](\\\\\\server\\share\\outside.txt)"),
        (":codex-file-citation{path=\"../../../../../../x\"}", "/repo", "[../../../../../../x](\\x)"),
        (":codex-file-citation{path=\"../../../../../../x\"}", "C:\\repo", "[../../../../../../x](C:\\x)"),
        (":codex-file-citation{path=\"../../../../../../x\"}", "\\\\server\\share\\w", "[../../../../../../x](\\\\\\server\\share\\x)"),
        (":codex-file-citation{path=\"dir/\"}", "/repo", "[dir/](\\repo\\dir\\)"),
        (":codex-file-citation{path=\"dir/\"}", "C:\\repo", "[dir/](C:\\repo\\dir\\)"),
        (":codex-file-citation{path=\"dir/\"}", "\\\\server\\share\\w", "[dir/](\\\\\\server\\share\\w\\dir\\)"),
        (":codex-file-citation{path=\".\"}", "/repo", "[.](\\repo)"),
        (":codex-file-citation{path=\".\"}", "C:\\repo", "[.](C:\\repo)"),
        (":codex-file-citation{path=\".\"}", "\\\\server\\share\\w", "[.](\\\\\\server\\share\\w)"),
        (":codex-file-citation{path=\"..\"}", "/repo", "[..](\\)"),
        (":codex-file-citation{path=\"..\"}", "C:\\repo", "[..](C:\\)"),
        (":codex-file-citation{path=\"..\"}", "\\\\server\\share\\w", "[..](\\\\\\server\\share\\)"),
        (":codex-file-citation{path=\"a//b///c\"}", "/repo", "[a//b///c](\\repo\\a\\b\\c)"),
        (":codex-file-citation{path=\"a//b///c\"}", "C:\\repo", "[a//b///c](C:\\repo\\a\\b\\c)"),
        (":codex-file-citation{path=\"a//b///c\"}", "\\\\server\\share\\w", "[a//b///c](\\\\\\server\\share\\w\\a\\b\\c)"),
        (":codex-file-citation{path=\"1abc://x\"}", "/repo", "[1abc://x](\\repo\\1abc:\\x)"),
        (":codex-file-citation{path=\"1abc://x\"}", "C:\\repo", "[1abc://x](C:\\repo\\1abc:\\x)"),
        (":codex-file-citation{path=\"1abc://x\"}", "\\\\server\\share\\w", "[1abc://x](\\\\\\server\\share\\w\\1abc:\\x)"),
        (":codex-file-citation{path=\"c:x\"}", "/repo", "[c:x](\\repo\\c:x)"),
        (":codex-file-citation{path=\"c:x\"}", "C:\\repo", "[c:x](C:\\repo\\c:x)"),
        (":codex-file-citation{path=\"c:x\"}", "\\\\server\\share\\w", "[c:x](\\\\\\server\\share\\w\\c:x)"),
        (":codex-file-citation{path=\"数据/报告 2026.md\"}", "/repo", "[数据/报告 2026.md](<\\repo\\数据\\报告 2026.md>)"),
        (":codex-file-citation{path=\"数据/报告 2026.md\"}", "C:\\repo", "[数据/报告 2026.md](<C:\\repo\\数据\\报告 2026.md>)"),
        (":codex-file-citation{path=\"数据/报告 2026.md\"}", "\\\\server\\share\\w", "[数据/报告 2026.md](<\\\\\\server\\share\\w\\数据\\报告 2026.md>)"),
        (":codex-file-citation{path=\"emoji/😀file.txt\"}", "/repo", "[emoji/😀file.txt](\\repo\\emoji\\😀file.txt)"),
        (":codex-file-citation{path=\"emoji/😀file.txt\"}", "C:\\repo", "[emoji/😀file.txt](C:\\repo\\emoji\\😀file.txt)"),
        (":codex-file-citation{path=\"emoji/😀file.txt\"}", "\\\\server\\share\\w", "[emoji/😀file.txt](\\\\\\server\\share\\w\\emoji\\😀file.txt)"),
        ("pre 😀 :codex-file-citation{path=\"a😀b\"} post", "/repo", "pre 😀 [a😀b](\\repo\\a😀b) post"),
        ("pre 😀 :codex-file-citation{path=\"a😀b\"} post", "C:\\repo", "pre 😀 [a😀b](C:\\repo\\a😀b) post"),
        ("pre 😀 :codex-file-citation{path=\"a😀b\"} post", "\\\\server\\share\\w", "pre 😀 [a😀b](\\\\\\server\\share\\w\\a😀b) post"),
        (":codex-file-citation{path=\"<weird>.txt\"}", "/repo", "[<weird>.txt](<\\repo\\\\\\<weird\\>.txt>)"),
        (":codex-file-citation{path=\"<weird>.txt\"}", "C:\\repo", "[<weird>.txt](<C:\\repo\\\\\\<weird\\>.txt>)"),
        (":codex-file-citation{path=\"<weird>.txt\"}", "\\\\server\\share\\w", "[<weird>.txt](<\\\\\\server\\share\\w\\\\\\<weird\\>.txt>)"),
        (":codex-file-citation{path=\"tab\there\"}", "/repo", "[tab\there](<\\repo\\tab\there>)"),
        (":codex-file-citation{path=\"tab\there\"}", "C:\\repo", "[tab\there](<C:\\repo\\tab\there>)"),
        (":codex-file-citation{path=\"tab\there\"}", "\\\\server\\share\\w", "[tab\there](<\\\\\\server\\share\\w\\tab\there>)"),
        (":codex-file-citation{path=\"back\\\\slash\\[x]\"}", "/repo", "[back\\\\\\slash\\\\\\[x\\]](\\repo\\back\\slash\\\\[x])"),
        (":codex-file-citation{path=\"back\\\\slash\\[x]\"}", "C:\\repo", "[back\\\\\\slash\\\\\\[x\\]](C:\\repo\\back\\slash\\\\[x])"),
        (":codex-file-citation{path=\"back\\\\slash\\[x]\"}", "\\\\server\\share\\w", "[back\\\\\\slash\\\\\\[x\\]](\\\\\\server\\share\\w\\back\\slash\\\\[x])"),
        (":codex-file-citation{path=\"a\\*b\"}", "/repo", "[a\\\\*b](\\repo\\a\\\\*b)"),
        (":codex-file-citation{path=\"a\\*b\"}", "C:\\repo", "[a\\\\*b](C:\\repo\\a\\\\*b)"),
        (":codex-file-citation{path=\"a\\*b\"}", "\\\\server\\share\\w", "[a\\\\*b](\\\\\\server\\share\\w\\a\\\\*b)"),
        (":codex-file-citation{path=\"end\\\"}", "/repo", "[end\\](\\repo\\end\\)"),
        (":codex-file-citation{path=\"end\\\"}", "C:\\repo", "[end\\](C:\\repo\\end\\)"),
        (":codex-file-citation{path=\"end\\\"}", "\\\\server\\share\\w", "[end\\](\\\\\\server\\share\\w\\end\\)"),
        (":codex-file-citation{path=a.txt}", "/repo", "[a.txt](\\repo\\a.txt)"),
        (":codex-file-citation{path=a.txt}", "C:\\repo", "[a.txt](C:\\repo\\a.txt)"),
        (":codex-file-citation{path=a.txt}", "\\\\server\\share\\w", "[a.txt](\\\\\\server\\share\\w\\a.txt)"),
        (":codex-file-citation{path=\"a.txt\"} :codex-file-citation{path=\"b.txt\"}", "/repo", "[a.txt](\\repo\\a.txt) [b.txt](\\repo\\b.txt)"),
        (":codex-file-citation{path=\"a.txt\"} :codex-file-citation{path=\"b.txt\"}", "C:\\repo", "[a.txt](C:\\repo\\a.txt) [b.txt](C:\\repo\\b.txt)"),
        (":codex-file-citation{path=\"a.txt\"} :codex-file-citation{path=\"b.txt\"}", "\\\\server\\share\\w", "[a.txt](\\\\\\server\\share\\w\\a.txt) [b.txt](\\\\\\server\\share\\w\\b.txt)"),
        ("x:codex-file-citation{path=\"a.txt\"}", "/repo", "x[a.txt](\\repo\\a.txt)"),
        ("x:codex-file-citation{path=\"a.txt\"}", "C:\\repo", "x[a.txt](C:\\repo\\a.txt)"),
        ("x:codex-file-citation{path=\"a.txt\"}", "\\\\server\\share\\w", "x[a.txt](\\\\\\server\\share\\w\\a.txt)"),
        ("a::codex-file-citation{path=\"a.txt\"}", "/repo", "a[a.txt](\\repo\\a.txt)"),
        ("a::codex-file-citation{path=\"a.txt\"}", "C:\\repo", "a[a.txt](C:\\repo\\a.txt)"),
        ("a::codex-file-citation{path=\"a.txt\"}", "\\\\server\\share\\w", "a[a.txt](\\\\\\server\\share\\w\\a.txt)"),
        ("``` code `:codex-file-citation{path=\"a\"}` ```\n:codex-file-citation{path=\"b\"}", "/repo", "``` code `:codex-file-citation{path=\"a\"}` ```\n[b](\\repo\\b)"),
        ("``` code `:codex-file-citation{path=\"a\"}` ```\n:codex-file-citation{path=\"b\"}", "C:\\repo", "``` code `:codex-file-citation{path=\"a\"}` ```\n[b](C:\\repo\\b)"),
        ("``` code `:codex-file-citation{path=\"a\"}` ```\n:codex-file-citation{path=\"b\"}", "\\\\server\\share\\w", "``` code `:codex-file-citation{path=\"a\"}` ```\n[b](\\\\\\server\\share\\w\\b)"),
        ("`` ` `` :codex-file-citation{path=\"c\"}", "/repo", "`` ` `` [c](\\repo\\c)"),
        ("`` ` `` :codex-file-citation{path=\"c\"}", "C:\\repo", "`` ` `` [c](C:\\repo\\c)"),
        ("`` ` `` :codex-file-citation{path=\"c\"}", "\\\\server\\share\\w", "`` ` `` [c](\\\\\\server\\share\\w\\c)"),
        (":codex-file-citation{path=\"q\\'s\"}", "/repo", "[q\\\\'s](\\repo\\q\\\\'s)"),
        (":codex-file-citation{path=\"q\\'s\"}", "C:\\repo", "[q\\\\'s](C:\\repo\\q\\\\'s)"),
        (":codex-file-citation{path=\"q\\'s\"}", "\\\\server\\share\\w", "[q\\\\'s](\\\\\\server\\share\\w\\q\\\\'s)"),
        (":codex-file-citation{path='it\\'s'}", "/repo", "[it's](\\repo\\it's)"),
        (":codex-file-citation{path='it\\'s'}", "C:\\repo", "[it's](C:\\repo\\it's)"),
        (":codex-file-citation{path='it\\'s'}", "\\\\server\\share\\w", "[it's](\\\\\\server\\share\\w\\it's)"),
        (":codex-file-citation{path=\"dq\\\"inner\\\"x\"}", "/repo", "[dq\"inner\"x](\\repo\\dq\"inner\"x)"),
        (":codex-file-citation{path=\"dq\\\"inner\\\"x\"}", "C:\\repo", "[dq\"inner\"x](C:\\repo\\dq\"inner\"x)"),
        (":codex-file-citation{path=\"dq\\\"inner\\\"x\"}", "\\\\server\\share\\w", "[dq\"inner\"x](\\\\\\server\\share\\w\\dq\"inner\"x)"),
        (":codex-file-citation{path=\"noesc\\\"}", "/repo", "[noesc\\](\\repo\\noesc\\)"),
        (":codex-file-citation{path=\"noesc\\\"}", "C:\\repo", "[noesc\\](C:\\repo\\noesc\\)"),
        (":codex-file-citation{path=\"noesc\\\"}", "\\\\server\\share\\w", "[noesc\\](\\\\\\server\\share\\w\\noesc\\)"),
        (":codex-file-citation{path=\"a\" purpose=\"b\\\"c\"}", "/repo", "[a](\\repo\\a)"),
        (":codex-file-citation{path=\"a\" purpose=\"b\\\"c\"}", "C:\\repo", "[a](C:\\repo\\a)"),
        (":codex-file-citation{path=\"a\" purpose=\"b\\\"c\"}", "\\\\server\\share\\w", "[a](\\\\\\server\\share\\w\\a)"),
        (":codex-file-citation{path=\"\\\\server\\share\\x\"}", "/repo", "[\\\\\\server\\share\\x](\\\\\\server\\share\\x)"),
        (":codex-file-citation{path=\"\\\\server\\share\\x\"}", "C:\\repo", "[\\\\\\server\\share\\x](\\\\\\server\\share\\x)"),
        (":codex-file-citation{path=\"\\\\server\\share\\x\"}", "\\\\server\\share\\w", "[\\\\\\server\\share\\x](\\\\\\server\\share\\x)"),
        (":codex-file-citation{path=\"~/x\"}", "/repo", "[~/x](\\repo\\\\~\\x)"),
        (":codex-file-citation{path=\"~/x\"}", "C:\\repo", "[~/x](C:\\repo\\\\~\\x)"),
        (":codex-file-citation{path=\"~/x\"}", "\\\\server\\share\\w", "[~/x](\\\\\\server\\share\\w\\\\~\\x)"),
        (":codex-file-citation{path=\" lead space\"}", "/repo", "[ lead space](<\\repo\\ lead space>)"),
        (":codex-file-citation{path=\" lead space\"}", "C:\\repo", "[ lead space](<C:\\repo\\ lead space>)"),
        (":codex-file-citation{path=\" lead space\"}", "\\\\server\\share\\w", "[ lead space](<\\\\\\server\\share\\w\\ lead space>)"),
        (":codex-file-citation{path=\"a.txt\"}\n:codex-file-citation{path=\"b.txt\"}", "/repo", "[a.txt](\\repo\\a.txt)\n[b.txt](\\repo\\b.txt)"),
        (":codex-file-citation{path=\"a.txt\"}\n:codex-file-citation{path=\"b.txt\"}", "C:\\repo", "[a.txt](C:\\repo\\a.txt)\n[b.txt](C:\\repo\\b.txt)"),
        (":codex-file-citation{path=\"a.txt\"}\n:codex-file-citation{path=\"b.txt\"}", "\\\\server\\share\\w", "[a.txt](\\\\\\server\\share\\w\\a.txt)\n[b.txt](\\\\\\server\\share\\w\\b.txt)"),
        (":codex-file-citation{path=\"src/app.ts\" purpose=\"source\"}\n:codex-file-citation{path=/abs/a.txt purpose=output}\n:codex-file-citation{path=\"C:\\repo\\report.xlsx\"}\n:codex-file-citation{path=\"docs/my notes (v2).md:12\"}\n:codex-file-citation{path=\"a[1].md\"}\n:codex-file-citation{path=\"C:\\repo\\_build\\a.md\"}\n:codex-file-citation{path=\"C:\\My Docs\\(1)\\a.md\"}", "C:\\Users\\x\\My Project", "[src/app.ts](<C:\\Users\\x\\My Project\\src\\app.ts>)\n[/abs/a.txt](/abs/a.txt)\n[C:\\repo\\report.xlsx](C:\\repo\\report.xlsx)\n[docs/my notes (v2).md:12](<C:\\Users\\x\\My Project\\docs\\my notes (v2).md:12>)\n[a\\[1\\].md](<C:\\Users\\x\\My Project\\a[1].md>)\n[C:\\repo\\\\_build\\a.md](C:\\repo\\\\_build\\a.md)\n[C:\\My Docs\\\\(1)\\a.md](<C:\\My Docs\\\\(1)\\a.md>)"),
        ("`:codex-file-citation{path=\"a.txt\"}`", "C:\\Users\\x\\My Project", "`:codex-file-citation{path=\"a.txt\"}`"),
        ("```text\n:codex-file-citation{path=\"a.txt\"}\n```\n", "C:\\Users\\x\\My Project", "```text\n:codex-file-citation{path=\"a.txt\"}\n```\n"),
    ];

    /// Node's `path.posix.join(a, b)` on the same runtime.
    const POSIX_JOINS: &[(&str, &str, &str)] = &[
        ("/repo", "a.txt", "/repo/a.txt"),
        ("/repo", "docs/../x", "/repo/x"),
        ("/repo", "../x", "/x"),
        ("/repo", "../../../../x", "/x"),
        ("/repo", "a//b", "/repo/a/b"),
        ("/repo", "dir/", "/repo/dir/"),
        ("/repo", ".", "/repo"),
        ("/repo", "..", "/"),
        ("/repo", "", "/repo"),
        ("/repo", "C:x", "/repo/C:x"),
        ("/repo", "COM1:", "/repo/COM1:"),
        ("/repo", "aux:x", "/repo/aux:x"),
        ("/repo", "a:b/c", "/repo/a:b/c"),
        ("/repo", "数据/a", "/repo/数据/a"),
        ("/repo", "\\x", "/repo/\\x"),
        ("/repo", "/x", "/repo/x"),
        ("/repo", "a/./b/.", "/repo/a/b"),
        ("/", "a.txt", "/a.txt"),
        ("/", "docs/../x", "/x"),
        ("/", "../x", "/x"),
        ("/", "../../../../x", "/x"),
        ("/", "a//b", "/a/b"),
        ("/", "dir/", "/dir/"),
        ("/", ".", "/"),
        ("/", "..", "/"),
        ("/", "", "/"),
        ("/", "C:x", "/C:x"),
        ("/", "COM1:", "/COM1:"),
        ("/", "aux:x", "/aux:x"),
        ("/", "a:b/c", "/a:b/c"),
        ("/", "数据/a", "/数据/a"),
        ("/", "\\x", "/\\x"),
        ("/", "/x", "/x"),
        ("/", "a/./b/.", "/a/b"),
        ("/a/./b/../c", "a.txt", "/a/c/a.txt"),
        ("/a/./b/../c", "docs/../x", "/a/c/x"),
        ("/a/./b/../c", "../x", "/a/x"),
        ("/a/./b/../c", "../../../../x", "/x"),
        ("/a/./b/../c", "a//b", "/a/c/a/b"),
        ("/a/./b/../c", "dir/", "/a/c/dir/"),
        ("/a/./b/../c", ".", "/a/c"),
        ("/a/./b/../c", "..", "/a"),
        ("/a/./b/../c", "", "/a/c"),
        ("/a/./b/../c", "C:x", "/a/c/C:x"),
        ("/a/./b/../c", "COM1:", "/a/c/COM1:"),
        ("/a/./b/../c", "aux:x", "/a/c/aux:x"),
        ("/a/./b/../c", "a:b/c", "/a/c/a:b/c"),
        ("/a/./b/../c", "数据/a", "/a/c/数据/a"),
        ("/a/./b/../c", "\\x", "/a/c/\\x"),
        ("/a/./b/../c", "/x", "/a/c/x"),
        ("/a/./b/../c", "a/./b/.", "/a/c/a/b"),
        ("rel/dir", "a.txt", "rel/dir/a.txt"),
        ("rel/dir", "docs/../x", "rel/dir/x"),
        ("rel/dir", "../x", "rel/x"),
        ("rel/dir", "../../../../x", "../../x"),
        ("rel/dir", "a//b", "rel/dir/a/b"),
        ("rel/dir", "dir/", "rel/dir/dir/"),
        ("rel/dir", ".", "rel/dir"),
        ("rel/dir", "..", "rel"),
        ("rel/dir", "", "rel/dir"),
        ("rel/dir", "C:x", "rel/dir/C:x"),
        ("rel/dir", "COM1:", "rel/dir/COM1:"),
        ("rel/dir", "aux:x", "rel/dir/aux:x"),
        ("rel/dir", "a:b/c", "rel/dir/a:b/c"),
        ("rel/dir", "数据/a", "rel/dir/数据/a"),
        ("rel/dir", "\\x", "rel/dir/\\x"),
        ("rel/dir", "/x", "rel/dir/x"),
        ("rel/dir", "a/./b/.", "rel/dir/a/b"),
        ("", "a.txt", "a.txt"),
        ("", "docs/../x", "x"),
        ("", "../x", "../x"),
        ("", "../../../../x", "../../../../x"),
        ("", "a//b", "a/b"),
        ("", "dir/", "dir/"),
        ("", ".", "."),
        ("", "..", ".."),
        ("", "", "."),
        ("", "C:x", "C:x"),
        ("", "COM1:", "COM1:"),
        ("", "aux:x", "aux:x"),
        ("", "a:b/c", "a:b/c"),
        ("", "数据/a", "数据/a"),
        ("", "\\x", "\\x"),
        ("", "/x", "/x"),
        ("", "a/./b/.", "a/b"),
    ];

    /// Node's `path.win32.join(a, b)` on the same runtime, reserved device
    /// names and the CVE-2024-36139 guard included.
    const WIN32_JOINS: &[(&str, &str, &str)] = &[
        ("C:\\work", "a.txt", "C:\\work\\a.txt"),
        ("C:\\work", "docs/../x", "C:\\work\\x"),
        ("C:\\work", "../x", "C:\\x"),
        ("C:\\work", "../../../../x", "C:\\x"),
        ("C:\\work", "a//b", "C:\\work\\a\\b"),
        ("C:\\work", "dir/", "C:\\work\\dir\\"),
        ("C:\\work", ".", "C:\\work"),
        ("C:\\work", "..", "C:\\"),
        ("C:\\work", "", "C:\\work"),
        ("C:\\work", "C:x", "C:\\work\\C:x"),
        ("C:\\work", "COM1:", "C:\\work\\COM1:"),
        ("C:\\work", "aux:x", "C:\\work\\aux:x"),
        ("C:\\work", "a:b/c", "C:\\work\\a:b\\c"),
        ("C:\\work", "数据/a", "C:\\work\\数据\\a"),
        ("C:\\work", "\\x", "C:\\work\\x"),
        ("C:\\work", "/x", "C:\\work\\x"),
        ("C:\\work", "a/./b/.", "C:\\work\\a\\b"),
        ("c:", "a.txt", "c:\\a.txt"),
        ("c:", "docs/../x", "c:\\x"),
        ("c:", "../x", "c:\\x"),
        ("c:", "../../../../x", "c:\\x"),
        ("c:", "a//b", "c:\\a\\b"),
        ("c:", "dir/", "c:\\dir\\"),
        ("c:", ".", "c:\\"),
        ("c:", "..", "c:\\"),
        ("c:", "", "c:."),
        ("c:", "C:x", "c:\\C:x"),
        ("c:", "COM1:", "c:\\COM1:"),
        ("c:", "aux:x", "c:\\aux:x"),
        ("c:", "a:b/c", "c:\\a:b\\c"),
        ("c:", "数据/a", "c:\\数据\\a"),
        ("c:", "\\x", "c:\\x"),
        ("c:", "/x", "c:\\x"),
        ("c:", "a/./b/.", "c:\\a\\b"),
        ("\\\\server\\share", "a.txt", "\\\\server\\share\\a.txt"),
        ("\\\\server\\share", "docs/../x", "\\\\server\\share\\x"),
        ("\\\\server\\share", "../x", "\\\\server\\share\\x"),
        ("\\\\server\\share", "../../../../x", "\\\\server\\share\\x"),
        ("\\\\server\\share", "a//b", "\\\\server\\share\\a\\b"),
        ("\\\\server\\share", "dir/", "\\\\server\\share\\dir\\"),
        ("\\\\server\\share", ".", "\\\\server\\share\\"),
        ("\\\\server\\share", "..", "\\\\server\\share\\"),
        ("\\\\server\\share", "", "\\\\server\\share\\"),
        ("\\\\server\\share", "C:x", "\\\\server\\share\\C:x"),
        ("\\\\server\\share", "COM1:", "\\\\server\\share\\COM1:"),
        ("\\\\server\\share", "aux:x", "\\\\server\\share\\aux:x"),
        ("\\\\server\\share", "a:b/c", "\\\\server\\share\\a:b\\c"),
        ("\\\\server\\share", "数据/a", "\\\\server\\share\\数据\\a"),
        ("\\\\server\\share", "\\x", "\\\\server\\share\\x"),
        ("\\\\server\\share", "/x", "\\\\server\\share\\x"),
        ("\\\\server\\share", "a/./b/.", "\\\\server\\share\\a\\b"),
        ("//server/share", "a.txt", "\\\\server\\share\\a.txt"),
        ("//server/share", "docs/../x", "\\\\server\\share\\x"),
        ("//server/share", "../x", "\\\\server\\share\\x"),
        ("//server/share", "../../../../x", "\\\\server\\share\\x"),
        ("//server/share", "a//b", "\\\\server\\share\\a\\b"),
        ("//server/share", "dir/", "\\\\server\\share\\dir\\"),
        ("//server/share", ".", "\\\\server\\share\\"),
        ("//server/share", "..", "\\\\server\\share\\"),
        ("//server/share", "", "\\\\server\\share\\"),
        ("//server/share", "C:x", "\\\\server\\share\\C:x"),
        ("//server/share", "COM1:", "\\\\server\\share\\COM1:"),
        ("//server/share", "aux:x", "\\\\server\\share\\aux:x"),
        ("//server/share", "a:b/c", "\\\\server\\share\\a:b\\c"),
        ("//server/share", "数据/a", "\\\\server\\share\\数据\\a"),
        ("//server/share", "\\x", "\\\\server\\share\\x"),
        ("//server/share", "/x", "\\\\server\\share\\x"),
        ("//server/share", "a/./b/.", "\\\\server\\share\\a\\b"),
        ("\\\\?\\C:\\x", "a.txt", "\\\\?\\C:\\x\\a.txt"),
        ("\\\\?\\C:\\x", "docs/../x", "\\\\?\\C:\\x\\x"),
        ("\\\\?\\C:\\x", "../x", "\\\\?\\C:\\x"),
        ("\\\\?\\C:\\x", "../../../../x", "\\\\?\\x"),
        ("\\\\?\\C:\\x", "a//b", "\\\\?\\C:\\x\\a\\b"),
        ("\\\\?\\C:\\x", "dir/", "\\\\?\\C:\\x\\dir\\"),
        ("\\\\?\\C:\\x", ".", "\\\\?\\C:\\x"),
        ("\\\\?\\C:\\x", "..", "\\\\?\\C:"),
        ("\\\\?\\C:\\x", "", "\\\\?\\C:\\x"),
        ("\\\\?\\C:\\x", "C:x", "\\\\?\\C:\\x\\C:x"),
        ("\\\\?\\C:\\x", "COM1:", "\\\\?\\C:\\x\\COM1:"),
        ("\\\\?\\C:\\x", "aux:x", "\\\\?\\C:\\x\\aux:x"),
        ("\\\\?\\C:\\x", "a:b/c", "\\\\?\\C:\\x\\a:b\\c"),
        ("\\\\?\\C:\\x", "数据/a", "\\\\?\\C:\\x\\数据\\a"),
        ("\\\\?\\C:\\x", "\\x", "\\\\?\\C:\\x\\x"),
        ("\\\\?\\C:\\x", "/x", "\\\\?\\C:\\x\\x"),
        ("\\\\?\\C:\\x", "a/./b/.", "\\\\?\\C:\\x\\a\\b"),
        ("CON:", "a.txt", "CON:\\a.txt"),
        ("CON:", "docs/../x", "CON:\\docs\\..\\x"),
        ("CON:", "../x", "CON:\\..\\x"),
        ("CON:", "../../../../x", "CON:\\..\\..\\..\\..\\x"),
        ("CON:", "a//b", "CON:\\a\\\\b"),
        ("CON:", "dir/", "CON:\\dir\\"),
        ("CON:", ".", "CON:\\."),
        ("CON:", "..", "CON:\\.."),
        ("CON:", "", "CON:"),
        ("CON:", "C:x", "CON:\\C:x"),
        ("CON:", "COM1:", "CON:\\COM1:"),
        ("CON:", "aux:x", "CON:\\aux:x"),
        ("CON:", "a:b/c", "CON:\\a:b\\c"),
        ("CON:", "数据/a", "CON:\\数据\\a"),
        ("CON:", "\\x", "CON:\\\\x"),
        ("CON:", "/x", "CON:\\\\x"),
        ("CON:", "a/./b/.", "CON:\\a\\.\\b\\."),
        ("D:\\a\\..\\..\\b", "a.txt", "D:\\b\\a.txt"),
        ("D:\\a\\..\\..\\b", "docs/../x", "D:\\b\\x"),
        ("D:\\a\\..\\..\\b", "../x", "D:\\x"),
        ("D:\\a\\..\\..\\b", "../../../../x", "D:\\x"),
        ("D:\\a\\..\\..\\b", "a//b", "D:\\b\\a\\b"),
        ("D:\\a\\..\\..\\b", "dir/", "D:\\b\\dir\\"),
        ("D:\\a\\..\\..\\b", ".", "D:\\b"),
        ("D:\\a\\..\\..\\b", "..", "D:\\"),
        ("D:\\a\\..\\..\\b", "", "D:\\b"),
        ("D:\\a\\..\\..\\b", "C:x", "D:\\b\\C:x"),
        ("D:\\a\\..\\..\\b", "COM1:", "D:\\a\\..\\..\\b\\COM1:"),
        ("D:\\a\\..\\..\\b", "aux:x", "D:\\a\\..\\..\\b\\aux:x"),
        ("D:\\a\\..\\..\\b", "a:b/c", "D:\\b\\a:b\\c"),
        ("D:\\a\\..\\..\\b", "数据/a", "D:\\b\\数据\\a"),
        ("D:\\a\\..\\..\\b", "\\x", "D:\\b\\x"),
        ("D:\\a\\..\\..\\b", "/x", "D:\\b\\x"),
        ("D:\\a\\..\\..\\b", "a/./b/.", "D:\\b\\a\\b"),
        ("\\\\server", "a.txt", "\\\\server\\a.txt\\"),
        ("\\\\server", "docs/../x", "\\\\server\\docs\\x"),
        ("\\\\server", "../x", "\\\\server\\..\\x"),
        ("\\\\server", "../../../../x", "\\\\server\\..\\x"),
        ("\\\\server", "a//b", "\\\\server\\a\\b"),
        ("\\\\server", "dir/", "\\\\server\\dir\\"),
        ("\\\\server", ".", "\\\\server\\.\\"),
        ("\\\\server", "..", "\\\\server\\..\\"),
        ("\\\\server", "", "\\server"),
        ("\\\\server", "C:x", "\\\\server\\C:x\\"),
        ("\\\\server", "COM1:", "\\\\server\\COM1:"),
        ("\\\\server", "aux:x", "\\\\server\\aux:x"),
        ("\\\\server", "a:b/c", "\\\\server\\a:b\\c"),
        ("\\\\server", "数据/a", "\\\\server\\数据\\a"),
        ("\\\\server", "\\x", "\\\\server\\x\\"),
        ("\\\\server", "/x", "\\\\server\\x\\"),
        ("\\\\server", "a/./b/.", "\\\\server\\a\\b"),
    ];

    const POSIX_ABSOLUTE: &[(&str, bool)] = &[
        ("/", true),
        ("/x", true),
        ("\\x", false),
        ("C:\\x", false),
        ("C:/x", false),
        ("C:", false),
        ("c:x", false),
        ("\\\\s\\h", false),
        ("x", false),
        ("", false),
        ("C", false),
        ("://", false),
        ("z:\\", false),
        ("1:\\x", false),
    ];

    const WIN32_ABSOLUTE: &[(&str, bool)] = &[
        ("/", true),
        ("/x", true),
        ("\\x", true),
        ("C:\\x", true),
        ("C:/x", true),
        ("C:", false),
        ("c:x", false),
        ("\\\\s\\h", true),
        ("x", false),
        ("", false),
        ("C", false),
        ("://", false),
        ("z:\\", true),
        ("1:\\x", false),
    ];

    #[test]
    fn renders_exactly_what_the_adapter_renders() {
        for (input, cwd, want) in ADAPTER_RENDERS {
            assert_eq!(
                render_with(input, cwd, PathRules::Posix),
                *want,
                "cwd {cwd:?}, input {input:?}"
            );
        }
    }

    #[test]
    fn renders_what_the_adapter_renders_on_windows() {
        for (input, cwd, want) in ADAPTER_RENDERS_ON_WINDOWS {
            assert_eq!(
                render_with(input, cwd, PathRules::Win32),
                *want,
                "cwd {cwd:?}, input {input:?}"
            );
        }
    }

    #[test]
    fn a_text_without_the_name_is_borrowed_back() {
        assert!(matches!(
            render_file_citations("plain answer", "/w"),
            Cow::Borrowed("plain answer")
        ));
    }

    /// The adapter's own linear-time inputs: none is a citation, and none
    /// may take long.
    #[test]
    fn malformed_input_stays_text_in_linear_time() {
        for input in [
            format!(":codex-file-citation{{path={}\"}}", "!a=".repeat(5000)),
            format!(":codex-file-citation{{path=a{}!}}", " ".repeat(5000)),
            ":codex-file-citation{path=\"x ".repeat(5000),
            format!(":codex-file-citation{{path=\"{}", "a".repeat(5000)),
        ] {
            let started = std::time::Instant::now();
            assert_eq!(render_file_citations(&input, "/repo"), input);
            assert!(started.elapsed() < std::time::Duration::from_secs(1));
        }
    }

    /// The cap counts UTF-16 code units, as JavaScript's `length` does: a
    /// directive of exactly 4096 units is a citation and one more is not, and
    /// an astral character counts twice (2,040 emoji make 4,080 units, past
    /// the cap with the syntax around them, though only 2,069 characters).
    #[test]
    fn the_cap_counts_utf16_code_units() {
        let directive = |path: &str| format!(":codex-file-citation{{path=\"{path}\"}}");
        let render = |text: &str| render_with(text, "/repo", PathRules::Posix).into_owned();
        let at_cap = directive(&"z".repeat(4067));
        assert_eq!(at_cap.encode_utf16().count(), 4096);
        assert_eq!(
            render(&at_cap),
            format!("[{0}](/repo/{0})", "z".repeat(4067))
        );
        let past_cap = directive(&"z".repeat(4068));
        assert_eq!(render(&past_cap), past_cap);

        let emoji = directive(&"\u{1F600}".repeat(2030));
        assert_eq!(
            render(&emoji),
            format!("[{0}](/repo/{0})", "\u{1F600}".repeat(2030))
        );
        let too_many = format!("{} tail", directive(&"\u{1F600}".repeat(2040)));
        assert!(too_many.chars().count() < MAX_CITATION_LENGTH);
        assert_eq!(render(&too_many), too_many);
    }

    /// The one input the port declines to follow: an escaped quote whose
    /// backslash is the last unit before the cap. The adapter reads on past
    /// the cap (and throws a `RangeError` when no quote follows); here the
    /// directive stays text, at once.
    #[test]
    fn an_escaped_quote_at_the_cap_stays_text() {
        let prefix = ":codex-file-citation{path=\"";
        let input = format!("{prefix}{}\\\"bbbb", "a".repeat(4095 - prefix.len()));
        assert_eq!(input.encode_utf16().nth(4095), Some(BACKSLASH));
        assert_eq!(render_file_citations(&input, "/repo"), input);
    }

    #[test]
    fn joins_and_absolutes_match_node_path() {
        for (a, b, want) in POSIX_JOINS {
            assert_eq!(
                text(&posix::join(&[&units(a), &units(b)])),
                *want,
                "posix {a:?} + {b:?}"
            );
        }
        for (a, b, want) in WIN32_JOINS {
            assert_eq!(
                text(&win32::join(&[&units(a), &units(b)])),
                *want,
                "win32 {a:?} + {b:?}"
            );
        }
        for (path, want) in POSIX_ABSOLUTE {
            assert_eq!(posix::is_absolute(&units(path)), *want, "posix {path:?}");
        }
        for (path, want) in WIN32_ABSOLUTE {
            assert_eq!(win32::is_absolute(&units(path)), *want, "win32 {path:?}");
        }
    }

    /// On Windows the adapter resolves with `path.win32`, so a relative
    /// citation in a `C:\\` session lands where Node puts it.
    #[test]
    fn a_link_resolves_with_the_host_platforms_path_rules() {
        let rendered = render_file_citations(
            ":codex-file-citation{path=\"docs/../a.txt\"}",
            if cfg!(windows) { "C:\\work" } else { "/work" },
        );
        let want = if cfg!(windows) {
            "[docs/../a.txt](C:\\work\\a.txt)"
        } else {
            "[docs/../a.txt](/work/a.txt)"
        };
        assert_eq!(rendered, want);
    }
}
