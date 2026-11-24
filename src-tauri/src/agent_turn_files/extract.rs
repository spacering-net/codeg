//! Pull the Office document paths an agent's tool call names out of its input.
//!
//! Pure string and path arithmetic — nothing here touches the filesystem. The
//! registry decides later, by file times, which of the named paths the turn
//! actually wrote (`super::confirm`).
//!
//! Office documents are almost never written through a structured edit tool:
//! agents run shell commands (`officecli create "$FILE"`, a python-pptx
//! script). Those commands state the path literally — each shell call is a
//! fresh process, so an agent re-states `FILE="outputs/deck.pptx"` every time —
//! which is what makes extraction from the tool input sufficient.
//!
//! Relative paths are resolved against the directory the command is in at
//! that point. Only plain top-level `cd <literal>` steps are followed; anything
//! that makes the directory uncertain (a subshell, a conditional `cd`, a
//! variable argument) drops every later relative path. A missed preview is
//! the safe failure here — guessing could open a different, unrelated file.

use std::collections::BTreeSet;
use std::path::{Component, Path, PathBuf};
use std::sync::LazyLock;

use regex::Regex;

/// File extensions the auto-preview cares about (matched case-insensitively).
const OFFICE_EXTENSIONS: [&str; 3] = ["docx", "xlsx", "pptx"];

/// Input keys whose string value is a shell command (or an argv array).
const COMMAND_KEYS: [&str; 3] = ["command", "cmd", "script"];

/// Input keys naming the directory a command runs in.
const CWD_KEYS: [&str; 6] = [
    "cwd",
    "workdir",
    "working_directory",
    "workingDirectory",
    "directory",
    "dir",
];

/// Cheap pre-check: does `text` mention an Office extension at all? Lets the
/// caller skip parsing and walking inputs that cannot yield anything.
pub(crate) fn mentions_office_extension(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    OFFICE_EXTENSIONS
        .iter()
        .any(|ext| lower.contains(&format!(".{ext}")))
}

fn has_office_extension(path: &str) -> bool {
    let Some((_, ext)) = path.rsplit_once('.') else {
        return false;
    };
    OFFICE_EXTENSIONS
        .iter()
        .any(|candidate| ext.eq_ignore_ascii_case(candidate))
}

/// The Office paths one tool call names, as normalized absolute paths.
///
/// `input` is the parsed `raw_input` (or a bare string when it did not parse
/// as JSON); `title` is consulted only when there is no input at all.
/// `session_dir` is the connection's working directory, the fallback start
/// directory for relative paths.
pub(crate) fn extract_tool_call_paths(
    input: Option<&serde_json::Value>,
    title: Option<&str>,
    locations: Option<&serde_json::Value>,
    session_dir: Option<&Path>,
    home: Option<&Path>,
) -> BTreeSet<PathBuf> {
    let mut out = BTreeSet::new();
    let start_dir = input
        .and_then(|value| input_cwd(value, session_dir))
        .or_else(|| session_dir.map(Path::to_path_buf));
    let start_dir = start_dir.as_deref();

    match input {
        Some(serde_json::Value::String(text)) => {
            // Unparsed input: no key tells a command from prose, so scan it as
            // a command — the stricter reading of `cd`.
            scan_command(text, start_dir, home, &mut out);
        }
        Some(value) => walk_input(value, None, start_dir, home, &mut out),
        None => {
            if let Some(title) = title {
                scan_plain(title, start_dir, home, &mut out);
            }
        }
    }

    if let Some(serde_json::Value::Array(items)) = locations {
        for item in items {
            if let Some(path) = item.get("path").and_then(|p| p.as_str()) {
                push_candidate(path, start_dir, home, &mut out);
            }
        }
    }
    out
}

/// The directory the tool input says its command runs in, if any.
fn input_cwd(value: &serde_json::Value, session_dir: Option<&Path>) -> Option<PathBuf> {
    let object = value.as_object()?;
    for key in CWD_KEYS {
        let Some(dir) = object.get(key).and_then(|v| v.as_str()) else {
            continue;
        };
        if dir.trim().is_empty() {
            continue;
        }
        let dir = Path::new(dir);
        if dir.is_absolute() {
            return Some(normalize_lexically(dir));
        }
        if let Some(base) = session_dir {
            return Some(normalize_lexically(&base.join(dir)));
        }
    }
    None
}

fn walk_input(
    value: &serde_json::Value,
    key: Option<&str>,
    start_dir: Option<&Path>,
    home: Option<&Path>,
    out: &mut BTreeSet<PathBuf>,
) {
    let is_command_key = key.is_some_and(|k| COMMAND_KEYS.contains(&k));
    match value {
        serde_json::Value::String(text) => {
            if !mentions_office_extension(text) {
                return;
            }
            if is_command_key {
                scan_command(text, start_dir, home, out);
            } else {
                scan_plain(text, start_dir, home, out);
            }
        }
        serde_json::Value::Array(items) if is_command_key => {
            scan_argv(items, start_dir, home, out);
        }
        serde_json::Value::Array(items) => {
            for item in items {
                walk_input(item, None, start_dir, home, out);
            }
        }
        serde_json::Value::Object(map) => {
            for (child_key, child) in map {
                walk_input(child, Some(child_key), start_dir, home, out);
            }
        }
        _ => {}
    }
}

/// An argv-style command (`["bash", "-lc", "<script>"]`, Codex's exec shape).
/// When a shell's `-c`-like flag is present the script is the last element;
/// otherwise each element is one literal word.
fn scan_argv(
    items: &[serde_json::Value],
    start_dir: Option<&Path>,
    home: Option<&Path>,
    out: &mut BTreeSet<PathBuf>,
) {
    let words: Vec<&str> = items.iter().filter_map(|v| v.as_str()).collect();
    let has_script_flag = words.iter().take(words.len().saturating_sub(1)).any(|w| {
        let lower = w.to_ascii_lowercase();
        matches!(
            lower.as_str(),
            "-c" | "-lc" | "-ic" | "-lic" | "/c" | "-command" | "-encodedcommand"
        ) || (lower.starts_with('-') && lower.len() <= 4 && lower.ends_with('c'))
    });
    if has_script_flag {
        if let Some(script) = words.last() {
            scan_command(script, start_dir, home, out);
        }
        return;
    }
    for word in words {
        push_word(word, false, start_dir, home, out);
    }
}

// ─── Plain text ─────────────────────────────────────────────────────────

/// A quoted Office path: may contain spaces, never quotes, newlines,
/// expansions, globs or `{…}` interpolation (Python f-strings).
static QUOTED_DOUBLE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#""([^"\r\n$`*?{}]+?\.(?i:docx|xlsx|pptx))""#).expect("valid regex")
});
static QUOTED_SINGLE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"'([^'\r\n$`*?{}]+?\.(?i:docx|xlsx|pptx))'"#).expect("valid regex")
});
/// An unquoted Office path token. Shell metacharacters, brackets and `=`
/// delimit it, so `FILE=out/a.pptx` and `save(out/a.pptx)` both yield the path.
static UNQUOTED: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"[^\s'"<>|;&(){}\[\],=`*?$]+\.(?i:docx|xlsx|pptx)"#).expect("valid regex")
});

fn is_path_char(c: char) -> bool {
    c.is_alphanumeric() || matches!(c, '_' | '-' | '.' | '/' | '\\')
}

/// Office paths anywhere in free text (a Write tool's `content`, a heredoc
/// body, a title), resolved against `dir`.
fn scan_plain(text: &str, dir: Option<&Path>, home: Option<&Path>, out: &mut BTreeSet<PathBuf>) {
    if !mentions_office_extension(text) {
        return;
    }
    for re in [&*QUOTED_DOUBLE, &*QUOTED_SINGLE] {
        for caps in re.captures_iter(text) {
            if let Some(m) = caps.get(1) {
                push_candidate(m.as_str(), dir, home, out);
            }
        }
    }
    for m in UNQUOTED.find_iter(text) {
        // `a.docx.bak` / `a.docxfoo` are not Office paths.
        if text[m.end()..].chars().next().is_some_and(is_path_char) {
            continue;
        }
        // The tail of `$OUT/r.docx`, `${D}/r.docx`, `*/r.docx`: the real path
        // starts with something only the shell knows.
        if text[..m.start()]
            .chars()
            .next_back()
            .is_some_and(|c| matches!(c, '$' | '}' | '*' | '?' | ']' | '`'))
        {
            continue;
        }
        push_candidate(m.as_str(), dir, home, out);
    }
}

// ─── Shell commands ─────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq)]
enum Token {
    /// One shell word, quotes removed. `expands` is true when an unquoted or
    /// double-quoted `$`/backtick or an unquoted glob character appeared — its
    /// literal text is then not what the shell sees.
    Word {
        text: String,
        expands: bool,
        quoted: bool,
    },
    /// `;`, a newline, or a background `&`.
    Sequence,
    And,
    Or,
    Pipe,
    /// `(`, `$(`, an opening backtick, or a `{` word.
    Open,
    /// `)`, a closing backtick, or a `}` word.
    Close,
    /// A heredoc body, emitted right after the newline that ends its line.
    HeredocBody(String),
}

/// Split a shell command into tokens. Deliberately small: it only needs to
/// find words, the operators that decide whether a `cd` certainly ran, and
/// heredoc bodies (which are data, not commands).
// The word-state resets inside `flush_word!` are dead on its last use.
#[allow(unused_assignments)]
fn tokenize(src: &str) -> Vec<Token> {
    let chars: Vec<char> = src.chars().collect();
    let mut tokens = Vec::new();
    let mut i = 0;
    let mut word = String::new();
    let mut in_word = false;
    let mut expands = false;
    let mut quoted = false;
    let mut backtick_open = false;
    let mut pending_heredocs: Vec<(String, bool)> = Vec::new();

    macro_rules! flush_word {
        () => {
            if in_word {
                let text = std::mem::take(&mut word);
                if text == "{" && !quoted {
                    tokens.push(Token::Open);
                } else if text == "}" && !quoted {
                    tokens.push(Token::Close);
                } else {
                    tokens.push(Token::Word {
                        text,
                        expands,
                        quoted,
                    });
                }
                in_word = false;
                expands = false;
                quoted = false;
            }
        };
    }

    while i < chars.len() {
        let c = chars[i];
        match c {
            ' ' | '\t' | '\r' => {
                flush_word!();
                i += 1;
            }
            '\n' => {
                flush_word!();
                tokens.push(Token::Sequence);
                i += 1;
                // Bodies of heredocs opened on the line just ended.
                for (delimiter, strip_tabs) in std::mem::take(&mut pending_heredocs) {
                    let mut body = String::new();
                    while i < chars.len() {
                        let line_end = chars[i..]
                            .iter()
                            .position(|&ch| ch == '\n')
                            .map(|p| i + p)
                            .unwrap_or(chars.len());
                        let line: String = chars[i..line_end].iter().collect();
                        i = (line_end + 1).min(chars.len());
                        let candidate = if strip_tabs {
                            line.trim_start_matches('\t')
                        } else {
                            line.as_str()
                        };
                        if candidate.trim_end_matches('\r') == delimiter {
                            break;
                        }
                        body.push_str(&line);
                        body.push('\n');
                    }
                    tokens.push(Token::HeredocBody(body));
                }
            }
            '#' if !in_word => {
                // Comment to end of line.
                while i < chars.len() && chars[i] != '\n' {
                    i += 1;
                }
            }
            '\\' => {
                in_word = true;
                // Only an escape before a character the shell treats specially;
                // otherwise a literal backslash, so a Windows path such as
                // `C:\out\a.docx` (PowerShell has no backslash escapes) survives.
                match chars.get(i + 1) {
                    Some('\n') => i += 2,
                    Some(&next) if is_shell_special(next) => {
                        word.push(next);
                        i += 2;
                    }
                    _ => {
                        word.push('\\');
                        i += 1;
                    }
                }
            }
            '\'' => {
                in_word = true;
                quoted = true;
                i += 1;
                while i < chars.len() && chars[i] != '\'' {
                    word.push(chars[i]);
                    i += 1;
                }
                i += 1;
            }
            '"' => {
                in_word = true;
                quoted = true;
                i += 1;
                while i < chars.len() && chars[i] != '"' {
                    match chars[i] {
                        '\\' if matches!(chars.get(i + 1), Some('"' | '\\' | '$' | '`')) => {
                            word.push(chars[i + 1]);
                            i += 2;
                            continue;
                        }
                        '$' | '`' => expands = true,
                        _ => {}
                    }
                    word.push(chars[i]);
                    i += 1;
                }
                i += 1;
            }
            '$' if chars.get(i + 1) == Some(&'(') => {
                flush_word!();
                tokens.push(Token::Open);
                i += 2;
            }
            '$' => {
                in_word = true;
                expands = true;
                word.push(c);
                i += 1;
            }
            '`' => {
                flush_word!();
                tokens.push(if backtick_open {
                    Token::Close
                } else {
                    Token::Open
                });
                backtick_open = !backtick_open;
                i += 1;
            }
            '(' => {
                flush_word!();
                tokens.push(Token::Open);
                i += 1;
            }
            ')' => {
                flush_word!();
                tokens.push(Token::Close);
                i += 1;
            }
            ';' => {
                flush_word!();
                tokens.push(Token::Sequence);
                i += 1;
            }
            '&' if chars.get(i + 1) == Some(&'&') => {
                flush_word!();
                tokens.push(Token::And);
                i += 2;
            }
            '&' => {
                flush_word!();
                // `2>&1` / `>&2` are redirections, not a background `&`.
                if !(i > 0 && chars[i - 1] == '>') {
                    tokens.push(Token::Sequence);
                }
                i += 1;
            }
            '|' if chars.get(i + 1) == Some(&'|') => {
                flush_word!();
                tokens.push(Token::Or);
                i += 2;
            }
            '|' => {
                flush_word!();
                tokens.push(Token::Pipe);
                i += 1;
            }
            '<' if chars.get(i + 1) == Some(&'<') && chars.get(i + 2) != Some(&'<') => {
                flush_word!();
                i += 2;
                let strip_tabs = chars.get(i) == Some(&'-');
                if strip_tabs {
                    i += 1;
                }
                while i < chars.len() && matches!(chars[i], ' ' | '\t') {
                    i += 1;
                }
                let mut delimiter = String::new();
                while i < chars.len()
                    && !matches!(
                        chars[i],
                        ' ' | '\t' | '\n' | ';' | '|' | '&' | '<' | '>' | ')'
                    )
                {
                    if !matches!(chars[i], '\'' | '"' | '\\') {
                        delimiter.push(chars[i]);
                    }
                    i += 1;
                }
                if !delimiter.is_empty() {
                    pending_heredocs.push((delimiter, strip_tabs));
                }
            }
            '<' | '>' => {
                flush_word!();
                i += 1;
            }
            '*' | '?' | '[' if !quoted => {
                in_word = true;
                expands = true;
                word.push(c);
                i += 1;
            }
            _ => {
                in_word = true;
                word.push(c);
                i += 1;
            }
        }
    }
    flush_word!();
    tokens
}

fn is_shell_special(c: char) -> bool {
    matches!(
        c,
        ' ' | '\t'
            | '\''
            | '"'
            | '\\'
            | '$'
            | '`'
            | ';'
            | '&'
            | '|'
            | '('
            | ')'
            | '<'
            | '>'
            | '*'
            | '?'
            | '['
            | ']'
            | '#'
            | '~'
            | '{'
            | '}'
    )
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum Separator {
    Start,
    Sequence,
    And,
    Or,
    Pipe,
    Open,
}

/// Scan one shell command, tracking the effective directory through plain
/// `cd` steps, and collect the Office paths its words and heredocs name.
fn scan_command(
    src: &str,
    start_dir: Option<&Path>,
    home: Option<&Path>,
    out: &mut BTreeSet<PathBuf>,
) {
    if !mentions_office_extension(src) {
        return;
    }
    // `None` = the directory is unknown from here on.
    let mut dir: Option<PathBuf> = start_dir.map(Path::to_path_buf);
    let mut depth: usize = 0;
    let mut prev_sep = Separator::Start;
    // Words seen in the current simple command (assignments excluded).
    let mut word_index: usize = 0;
    // The current simple command is a `cd`, waiting for its argument.
    let mut cd_pending = false;
    // A `cd` applied after `&&` in this and-chain: once the chain ends, the
    // commands after it may run without the `cd` having happened.
    let mut conditional_cd = false;
    // A `cd` ran somewhere in the current and/or chain.
    let mut chain_has_cd = false;
    // Inside `if`/`while`/`until`/`for`/`case`/`select`: a `cd` there may or
    // may not run.
    let mut compound_depth: usize = 0;

    for token in tokenize(src) {
        match token {
            Token::Word {
                text,
                expands,
                quoted,
            } => {
                if cd_pending {
                    // Flags of `cd`: skip them and keep waiting for the target.
                    if !quoted
                        && matches!(
                            text.as_str(),
                            "-L" | "-P" | "-e" | "-@" | "--" | "/d" | "/D"
                        )
                    {
                        continue;
                    }
                    cd_pending = false;
                    word_index += 1;
                    chain_has_cd = true;
                    let certain = depth == 0
                        && compound_depth == 0
                        && matches!(
                            prev_sep,
                            Separator::Start | Separator::Sequence | Separator::And
                        );
                    if prev_sep == Separator::And {
                        conditional_cd = true;
                    }
                    dir = if certain && !expands {
                        dir.as_deref()
                            .and_then(|current| resolve_cd(&text, current, home))
                    } else {
                        None
                    };
                    continue;
                }
                if word_index == 0 && !quoted && is_assignment(&text) {
                    // `FILE=out/a.pptx officecli …`: the value is a word of its
                    // own, the command word is still to come.
                    push_word(&text, expands, dir.as_deref(), home, out);
                    continue;
                }
                if word_index == 0 && !quoted {
                    let lower = text.to_ascii_lowercase();
                    match lower.as_str() {
                        "if" | "while" | "until" | "for" | "case" | "select" => {
                            compound_depth += 1;
                            continue;
                        }
                        // The next word is in command position again.
                        "then" | "do" | "else" | "elif" | "!" | "time" => continue,
                        "fi" | "done" | "esac" => {
                            compound_depth = compound_depth.saturating_sub(1);
                            word_index += 1;
                            continue;
                        }
                        "cd" | "chdir" | "set-location" | "sl" => {
                            cd_pending = true;
                            continue;
                        }
                        "pushd" | "popd" => {
                            // A directory stack is more than this scanner follows.
                            dir = None;
                            chain_has_cd = true;
                            word_index += 1;
                            continue;
                        }
                        _ => {}
                    }
                }
                word_index += 1;
                push_word(&text, expands, dir.as_deref(), home, out);
            }
            Token::HeredocBody(body) => {
                scan_plain(&body, dir.as_deref(), home, out);
            }
            Token::Sequence | Token::And | Token::Or | Token::Pipe => {
                if cd_pending {
                    // A bare `cd` goes home; not followed — unknown from here.
                    cd_pending = false;
                    dir = None;
                    chain_has_cd = true;
                }
                match token {
                    Token::Sequence => {
                        if depth == 0 && conditional_cd {
                            dir = None;
                        }
                        conditional_cd = false;
                        chain_has_cd = false;
                        prev_sep = Separator::Sequence;
                    }
                    Token::And => prev_sep = Separator::And,
                    Token::Or => {
                        if chain_has_cd {
                            dir = None;
                        }
                        prev_sep = Separator::Or;
                    }
                    Token::Pipe => {
                        // Pipeline members run in subshells: a `cd` there does
                        // not carry over.
                        if chain_has_cd {
                            dir = None;
                        }
                        prev_sep = Separator::Pipe;
                    }
                    _ => unreachable!(),
                }
                word_index = 0;
            }
            Token::Open => {
                if cd_pending {
                    cd_pending = false;
                    dir = None;
                }
                depth += 1;
                prev_sep = Separator::Open;
                word_index = 0;
            }
            Token::Close => {
                if cd_pending {
                    cd_pending = false;
                    dir = None;
                }
                depth = depth.saturating_sub(1);
                // Whatever follows `)` is a continuation of the outer command.
                word_index = 1;
            }
        }
    }
}

/// `NAME=value` with a shell identifier for `NAME`.
fn is_assignment(text: &str) -> bool {
    let Some((name, _)) = text.split_once('=') else {
        return false;
    };
    let mut chars = name.chars();
    chars
        .next()
        .is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// The target of `cd <arg>` from `current`, or `None` when it cannot be
/// followed (`cd -`, `~user`).
fn resolve_cd(arg: &str, current: &Path, home: Option<&Path>) -> Option<PathBuf> {
    if arg.is_empty() || arg == "-" {
        return None;
    }
    let target = expand_home(arg, home)?;
    let next = normalize_lexically(&current.join(target));
    // Real working directories are nowhere near this deep; a pathological
    // `cd a; cd a; …` chain stops being followed instead of growing.
    (next.components().count() <= MAX_TRACKED_DIR_DEPTH).then_some(next)
}

const MAX_TRACKED_DIR_DEPTH: usize = 64;

/// One shell word that may be (or carry, after `=`) an Office path.
fn push_word(
    text: &str,
    expands: bool,
    dir: Option<&Path>,
    home: Option<&Path>,
    out: &mut BTreeSet<PathBuf>,
) {
    // `FILE=out/a.pptx`, `--output=out/a.pptx`.
    let value = match text.split_once('=') {
        Some((prefix, value)) if is_assignment(text) || prefix.starts_with('-') => value,
        _ => text,
    };
    if !expands && has_office_extension(value) {
        push_candidate(value, dir, home, out);
        return;
    }
    // A word that is not itself a path but carries one — a quoted program
    // (`python3 -c "…d.save('report.docx')"`, a PowerShell here-string piped
    // to python): read it as text in the current directory. Pieces glued to
    // an expansion are rejected there (`scan_plain`).
    if mentions_office_extension(text) {
        scan_plain(text, dir, home, out);
    }
}

/// Resolve one raw path fragment and add it when it names a candidate file.
fn push_candidate(raw: &str, dir: Option<&Path>, home: Option<&Path>, out: &mut BTreeSet<PathBuf>) {
    let raw = raw.trim();
    if raw.is_empty() || !has_office_extension(raw) {
        return;
    }
    let basename = raw.rsplit(['/', '\\']).next().unwrap_or(raw);
    // Office/WPS owner files and dot-files are machine byproducts.
    if basename.starts_with("~$") || basename.starts_with('.') {
        return;
    }
    let Some(expanded) = expand_home(raw, home) else {
        return;
    };
    let resolved = if expanded.is_absolute() {
        expanded
    } else if let Some(dir) = dir {
        dir.join(expanded)
    } else {
        return;
    };
    out.insert(normalize_lexically(&resolved));
}

/// `~` / `~/x` against `home`; other `~user` forms are not followed.
fn expand_home(raw: &str, home: Option<&Path>) -> Option<PathBuf> {
    if raw == "~" {
        return home.map(Path::to_path_buf);
    }
    if let Some(rest) = raw.strip_prefix("~/").or_else(|| raw.strip_prefix("~\\")) {
        return home.map(|h| h.join(rest));
    }
    if raw.starts_with('~') {
        return None;
    }
    Some(PathBuf::from(raw))
}

/// Resolve `.` and `..` without touching the filesystem.
pub(crate) fn normalize_lexically(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                if !out.pop() {
                    out.push(component);
                }
            }
            other => out.push(other),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn root() -> PathBuf {
        if cfg!(windows) {
            PathBuf::from("C:\\p")
        } else {
            PathBuf::from("/p")
        }
    }

    fn home() -> PathBuf {
        if cfg!(windows) {
            PathBuf::from("C:\\home")
        } else {
            PathBuf::from("/home/u")
        }
    }

    fn at(rel: &str) -> PathBuf {
        normalize_lexically(&root().join(rel))
    }

    fn cmd(command: &str) -> Vec<PathBuf> {
        let input = json!({ "command": command });
        extract_tool_call_paths(Some(&input), None, None, Some(&root()), Some(&home()))
            .into_iter()
            .collect()
    }

    #[test]
    fn real_officecli_command_yields_the_literal_path() {
        let script = "mkdir -p outputs\nFILE=\"outputs/current-project-introduction.pptx\"\nofficecli create \"$FILE\"\nofficecli open \"$FILE\"\ncat <<'EOF' | officecli batch \"$FILE\"\n[\n  {\"command\":\"add\",\"parent\":\"/\",\"type\":\"slide\"}\n]\nEOF\nofficecli close \"$FILE\"";
        assert_eq!(
            cmd(script),
            vec![at("outputs/current-project-introduction.pptx")]
        );
    }

    #[test]
    fn codex_argv_with_script_flag_scans_the_script() {
        let input =
            json!({ "command": ["bash", "-lc", "officecli create out/a.pptx"], "cwd": root() });
        let got: Vec<_> = extract_tool_call_paths(Some(&input), None, None, None, Some(&home()))
            .into_iter()
            .collect();
        assert_eq!(got, vec![at("out/a.pptx")]);
    }

    #[test]
    fn input_cwd_overrides_the_session_dir() {
        let input = json!({ "cmd": "officecli create a.docx", "workdir": "sub" });
        let got: Vec<_> = extract_tool_call_paths(Some(&input), None, None, Some(&root()), None)
            .into_iter()
            .collect();
        assert_eq!(got, vec![at("sub/a.docx")]);
    }

    #[test]
    fn quoted_paths_with_spaces_and_unicode() {
        assert_eq!(
            cmd("officecli create \"my docs/报告 1.docx\""),
            vec![at("my docs/报告 1.docx")]
        );
        assert_eq!(
            cmd("officecli create '季度 汇总.xlsx'"),
            vec![at("季度 汇总.xlsx")]
        );
    }

    #[test]
    fn assignment_and_option_values() {
        assert_eq!(cmd("FILE=outputs/x.pptx"), vec![at("outputs/x.pptx")]);
        assert_eq!(cmd("tool --output=out/r.docx"), vec![at("out/r.docx")]);
    }

    #[test]
    fn absolute_and_home_paths() {
        let abs = root().join("abs").join("a.xlsx");
        assert_eq!(
            cmd(&format!("officecli create \"{}\"", abs.display())),
            vec![abs]
        );
        assert_eq!(
            cmd("officecli create ~/Desktop/a.pptx"),
            vec![home().join("Desktop/a.pptx")]
        );
        assert!(cmd("officecli create ~other/a.pptx").is_empty());
    }

    #[test]
    fn expansions_globs_owner_and_hidden_files_are_skipped() {
        assert!(cmd("officecli create \"$FILE\"").is_empty());
        assert!(cmd("for f in *.pptx; do officecli view \"$f\"; done").is_empty());
        assert!(cmd("officecli view ~$a.docx").is_empty());
        assert!(cmd("officecli view '~$a.docx' .b.docx").is_empty());
        assert!(cmd("officecli view out/${NAME}.pptx").is_empty());
    }

    #[test]
    fn plain_cd_steps_are_followed() {
        assert_eq!(
            cmd("cd outputs && officecli create report.pptx --force"),
            vec![at("outputs/report.pptx")]
        );
        assert_eq!(
            cmd("cd outputs; officecli create r.pptx"),
            vec![at("outputs/r.pptx")]
        );
        assert_eq!(
            cmd("cd a\ncd ../b\nofficecli create r.pptx"),
            vec![at("b/r.pptx")]
        );
        assert_eq!(
            cmd("cd -- out && officecli create r.pptx"),
            vec![at("out/r.pptx")]
        );
        // A same-named file in the start dir must not win: resolution never
        // consults the filesystem.
        assert_eq!(
            cmd("cd sub && officecli create a.pptx"),
            vec![at("sub/a.pptx")]
        );
    }

    #[test]
    fn uncertain_directory_drops_later_relative_paths() {
        assert!(cmd("(cd templates && true); officecli view report.pptx outline").is_empty());
        assert!(cmd("test -d m && cd t; officecli view r.pptx").is_empty());
        assert!(cmd("a || cd t; officecli view r.pptx").is_empty());
        assert!(cmd("echo $(cd t; pwd); officecli view r.pptx").is_empty());
        assert!(cmd("cd \"$DIR\" && officecli create r.pptx").is_empty());
        assert!(cmd("cd - && officecli create r.pptx").is_empty());
        assert!(cmd("pushd out && officecli create r.pptx").is_empty());
        assert!(cmd("cd t | cat; officecli create r.pptx").is_empty());
        assert!(cmd("cd && officecli create r.pptx").is_empty());
        // Absolute paths stay usable after the directory is lost.
        let abs = root().join("x.docx");
        assert_eq!(
            cmd(&format!("cd \"$D\"; officecli create {}", abs.display())),
            vec![abs]
        );
    }

    #[test]
    fn paths_before_an_uncertain_cd_are_kept() {
        assert_eq!(
            cmd("officecli create a.pptx; (cd t && true); officecli view b.pptx"),
            vec![at("a.pptx")]
        );
    }

    #[test]
    fn heredoc_bodies_are_data_not_commands() {
        let script = "cd out\npython3 - <<'PY'\nimport os\n# cd elsewhere\ncd nowhere\nprs.save(\"d.pptx\")\nPY\nofficecli view e.pptx";
        assert_eq!(cmd(script), vec![at("out/d.pptx"), at("out/e.pptx")]);
    }

    #[test]
    fn write_content_is_scanned_as_plain_text_against_the_start_dir() {
        let input = json!({ "file_path": "gen.py", "content": "doc.save('out/report.docx')\n" });
        let got: Vec<_> = extract_tool_call_paths(Some(&input), None, None, Some(&root()), None)
            .into_iter()
            .collect();
        assert_eq!(got, vec![at("out/report.docx")]);
    }

    #[test]
    fn unparsed_input_and_title_fallback() {
        let raw = serde_json::Value::String("officecli create a.pptx".into());
        let got: Vec<_> = extract_tool_call_paths(Some(&raw), None, None, Some(&root()), None)
            .into_iter()
            .collect();
        assert_eq!(got, vec![at("a.pptx")]);
        let got: Vec<_> = extract_tool_call_paths(
            None,
            Some("Run officecli create b.docx"),
            None,
            Some(&root()),
            None,
        )
        .into_iter()
        .collect();
        assert_eq!(got, vec![at("b.docx")]);
        // With an input present the title is not consulted.
        let input = json!({ "command": "ls" });
        assert!(
            extract_tool_call_paths(Some(&input), Some("c.docx"), None, Some(&root()), None)
                .is_empty()
        );
    }

    #[test]
    fn locations_are_collected() {
        let abs = root().join("loc.xlsx");
        let locations =
            json!([{ "path": abs.to_string_lossy() }, { "path": "rel.docx" }, { "line": 3 }]);
        let got: Vec<_> =
            extract_tool_call_paths(None, None, Some(&locations), Some(&root()), None)
                .into_iter()
                .collect();
        assert_eq!(got, vec![abs, at("rel.docx")]);
    }

    #[test]
    fn non_office_suffixes_are_not_matched() {
        assert!(cmd("cp a.docx.bak b.pptxx; cat c.docxfoo").is_empty());
        assert!(!mentions_office_extension("notes.txt"));
        assert!(mentions_office_extension("A.DOCX"));
        assert_eq!(cmd("officecli create A.PPTX"), vec![at("A.PPTX")]);
    }

    #[test]
    fn unquoted_windows_paths_keep_their_backslashes() {
        // Absolute on Windows; on Unix the same text is one relative name.
        let expected = if cfg!(windows) {
            PathBuf::from("C:\\out\\a.docx")
        } else {
            at("C:\\out\\a.docx")
        };
        assert_eq!(cmd("officecli create C:\\out\\a.docx"), vec![expected]);
        assert_eq!(
            cmd("officecli create my\\ deck.pptx"),
            vec![at("my deck.pptx")]
        );
    }

    #[test]
    fn redirections_do_not_hide_paths() {
        assert_eq!(cmd("python gen.py > out.docx 2>&1"), vec![at("out.docx")]);
        assert_eq!(
            cmd("python gen.py >>log.txt 2>out/err.xlsx"),
            vec![at("out/err.xlsx")]
        );
    }

    #[test]
    fn quoted_programs_are_read_as_text() {
        assert_eq!(
            cmd("python3 -c \"from docx import Document; d=Document(); d.save('report.docx')\""),
            vec![at("report.docx")]
        );
        // PowerShell here-string piped to python.
        assert_eq!(
            cmd("@'\nfrom pptx import Presentation\nPresentation().save(\"out/report.pptx\")\n'@ | python -"),
            vec![at("out/report.pptx")]
        );
        assert_eq!(
            cmd("cd out && python3 -c \"import x; x.save('d.xlsx')\""),
            vec![at("out/d.xlsx")]
        );
    }

    #[test]
    fn pieces_glued_to_an_expansion_are_not_paths() {
        assert!(cmd("python3 -c \"x.save('$OUT/r.docx')\"").is_empty());
        assert!(cmd("python3 -c \"x.save(f'{d}/r.docx')\"").is_empty());
        assert!(cmd("cp out/*/a.docx .").is_empty());
    }

    #[test]
    fn a_cd_inside_a_compound_command_is_uncertain() {
        assert!(
            cmd("if [ -d outputs ]; then cd outputs; fi; officecli create report.pptx").is_empty()
        );
        assert!(cmd("for d in a b; do cd $d; done\nofficecli create r.pptx").is_empty());
        assert!(cmd("while true; do\n  cd x\n  break\ndone\nofficecli create r.pptx").is_empty());
        // Compound commands without a `cd` leave the directory known.
        assert_eq!(
            cmd("if [ -f a ]; then echo hi; fi\nofficecli create r.pptx"),
            vec![at("r.pptx")]
        );
    }

    #[test]
    fn a_runaway_cd_chain_stops_being_followed() {
        let deep = "cd a; ".repeat(MAX_TRACKED_DIR_DEPTH + 5) + "officecli create r.pptx";
        assert!(cmd(&deep).is_empty());
    }
}
