//! What an assistant is doing, and what it did, in a short line each (8.4):
//! a step of its brain's turn, or of a session it handed work to, read into
//! a kind, an object and a few numbers. The page puts them into words in
//! the owner's language; nothing here asks a model.
//!
//! - The kind comes from the agent's tool kind, refined by what the call was
//!   given: a command that runs tests is `test`, `git commit` is `commit`,
//!   codeg's own `dispatch` / `dispatch_followup` / `bot_message` (an MCP
//!   call, of no kind) are what they are.
//! - The object is the file's name, the query, the command, the executor
//!   config or the assistant asked, the commit's message.
//! - The numbers come from the call itself: an edit's lines added and
//!   removed (from its old and new text, or its patch), a test run's passed
//!   and failed (the summary lines of cargo, vitest, jest, pytest and go),
//!   a command's exit code, a search's hits — none when they cannot be read.

use std::collections::HashMap;
use std::sync::LazyLock;

use chrono::Utc;
use regex::Regex;
use serde_json::Value;

use crate::acp::reply_turn::StepRaw;
use crate::acp::session_state::{ToolCallState, ToolCallStatus, ToolKind};
use crate::models::personal_agent_roster::StepLine;

/// Longest object kept for a line.
const MAX_TARGET_CHARS: usize = 80;

/// Names the steps' objects may refer to by id.
#[derive(Debug, Default, Clone)]
pub struct Names {
    /// Executor configs by id.
    pub executors: HashMap<i32, String>,
    /// Assistants by id.
    pub bots: HashMap<i32, String>,
}

static OWN_TOOL: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)(?:^|[\s_.:/-])(dispatch_followup|dispatch|bot_message)(?:$|[\s(:)])")
        .expect("valid regex")
});
static TEST_COMMAND: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?i)(?:^|[\s;&|(])(?:cargo\s+(?:test|nextest)|pytest|py\.test|vitest|jest|go\s+test|(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test(?::\S*)?|npx\s+(?:vitest|jest)|mvn\s+test|gradle\w*\s+test|rspec|phpunit|ctest|dotnet\s+test|mix\s+test|tox|deno\s+test)(?:$|[\s;&|)])",
    )
    .expect("valid regex")
});
static GIT_COMMIT: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?:^|[\s;&|(])git\s+(?:-\S+\s+)*commit\b").expect("valid regex"));
static COMMIT_MESSAGE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"\s(?:-m|--message)(?:\s+|=)(?:"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+))"#)
        .expect("valid regex")
});
static CARGO_RESULT: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"test result: \w+\. (\d+) passed; (\d+) failed").expect("valid regex")
});
static PASSED: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)\b(\d+) passed\b").expect("valid regex"));
static FAILED: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)\b(\d+) failed\b").expect("valid regex"));
static GO_PASS: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?m)^\s*--- PASS").expect("valid regex"));
static GO_FAIL: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?m)^\s*--- FAIL").expect("valid regex"));
static EXIT_CODE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?i)(?:exit(?:ed with)?[ _]?code|"exit_?code")["]?\s*[:=]?\s*(-?\d+)"#)
        .expect("valid regex")
});
static HITS: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)\b(?:found\s+)?(\d+)\s+(?:matches|match|files?|results?|hits?|occurrences?)\b")
        .expect("valid regex")
});
static DISPATCH_REF: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"#(\d+)").expect("valid regex"));

/// The line for a step of a brain's turn.
pub fn line_of(raw: &StepRaw, names: &Names) -> StepLine {
    let mut line = StepLine {
        n: raw.n,
        kind: String::new(),
        target: None,
        status: raw.status.clone(),
        awaiting: raw.awaiting,
        started_at: raw.started_at,
        added: None,
        removed: None,
        passed: None,
        failed: None,
        exit_code: None,
        hits: None,
        dispatch_id: None,
    };
    read_call(
        &mut line,
        &raw.kind,
        &raw.title,
        raw.input.as_ref(),
        raw.path.as_deref(),
        raw.output.as_deref(),
        names,
    );
    line
}

/// The line for a call of a session the assistant handed work to, as the
/// connection holds it. `started_at` is when codeg first saw it.
pub fn line_of_call(
    call: &ToolCallState,
    started_at: chrono::DateTime<Utc>,
    names: &Names,
) -> StepLine {
    let kind = match call.kind {
        ToolKind::Read => "read",
        ToolKind::Edit | ToolKind::Delete | ToolKind::Move => "edit",
        ToolKind::Search => "search",
        ToolKind::Execute => "execute",
        ToolKind::Think => "think",
        ToolKind::Fetch => "fetch",
        ToolKind::Other => "other",
    };
    let status = match call.status {
        ToolCallStatus::Pending => "pending",
        ToolCallStatus::InProgress => "in_progress",
        ToolCallStatus::Completed => "completed",
        ToolCallStatus::Failed => "failed",
    };
    let path = call.locations.as_ref().and_then(|l| {
        l.as_array()?
            .iter()
            .find_map(|x| x.get("path").and_then(|p| p.as_str()))
            .map(str::to_string)
    });
    let output = call.content.as_deref().map(|c| {
        let n = c.chars().count();
        c.chars().skip(n.saturating_sub(4000)).collect::<String>()
    });
    let mut line = StepLine {
        n: 0,
        kind: String::new(),
        target: None,
        status: Some(status.to_string()),
        awaiting: false,
        started_at,
        added: None,
        removed: None,
        passed: None,
        failed: None,
        exit_code: None,
        hits: None,
        dispatch_id: None,
    };
    read_call(
        &mut line,
        kind,
        &call.label,
        call.input.as_ref(),
        path.as_deref(),
        output.as_deref(),
        names,
    );
    line
}

fn read_call(
    line: &mut StepLine,
    kind: &str,
    title: &str,
    input: Option<&Value>,
    path: Option<&str>,
    output: Option<&str>,
    names: &Names,
) {
    let done = matches!(line.status.as_deref(), Some("completed") | Some("failed"));
    match kind {
        "text" => line.kind = "reply".into(),
        "think" => line.kind = "think".into(),
        "compact" => line.kind = "compact".into(),
        "question" => {
            line.kind = "question".into();
            line.target = short(title);
        }
        "plan" => {
            line.kind = "plan".into();
            line.target = short(title);
        }
        _ => {
            // An MCP tool is a call of no particular kind: only then is a
            // title naming `dispatch` codeg's (a search for it is not).
            let own = (kind == "other")
                .then(|| OWN_TOOL.captures(title).and_then(|c| c.get(1)))
                .flatten();
            if let Some(own) = own {
                own_tool(
                    line,
                    &own.as_str().to_ascii_lowercase(),
                    input,
                    output,
                    names,
                );
                return;
            }
            match kind {
                "read" => {
                    line.kind = "read".into();
                    line.target = path_of(input, path)
                        .or_else(|| last_word(title))
                        .map(|p| file_name(&p));
                }
                "edit" | "delete" | "move" => {
                    line.kind = "edit".into();
                    line.target = path_of(input, path)
                        .or_else(|| last_word(title))
                        .map(|p| file_name(&p));
                    if let Some((added, removed)) = input.and_then(edit_counts) {
                        line.added = Some(added);
                        line.removed = Some(removed);
                    }
                }
                "search" => {
                    line.kind = "search".into();
                    line.target = query_of(input).or_else(|| short(title));
                    if done {
                        line.hits = output.and_then(|o| last_number(&HITS, o));
                    }
                }
                "fetch" => {
                    line.kind = "fetch".into();
                }
                "execute" => {
                    let command = command_of(input).unwrap_or_else(|| title.trim().to_string());
                    if GIT_COMMIT.is_match(&command) {
                        line.kind = "commit".into();
                        line.target = commit_message(&command).as_deref().and_then(short);
                    } else if TEST_COMMAND.is_match(&command) {
                        line.kind = "test".into();
                        line.target = short(&command);
                        if done {
                            if let Some(o) = output {
                                let (passed, failed) = test_counts(o);
                                line.passed = passed;
                                line.failed = failed;
                            }
                        }
                    } else {
                        line.kind = "execute".into();
                        line.target = short(&command);
                    }
                    if done {
                        line.exit_code = output.and_then(exit_code);
                    }
                }
                _ => {
                    line.kind = "other".into();
                    line.target = short(title);
                }
            }
        }
    }
}

/// codeg's own tools: who the work went to, which piece was followed up,
/// whom a message went to.
fn own_tool(
    line: &mut StepLine,
    tool: &str,
    input: Option<&Value>,
    output: Option<&str>,
    names: &Names,
) {
    match tool {
        "dispatch" => {
            line.kind = "dispatch".into();
            let id = input.and_then(|i| i.get("assistant_id")).and_then(as_i32);
            line.target = id.and_then(|id| names.executors.get(&id).cloned());
            line.dispatch_id = output
                .and_then(|o| last_number(&DISPATCH_REF, o))
                .map(|n| n as i32);
        }
        "dispatch_followup" => {
            line.kind = "followup".into();
            line.dispatch_id = input.and_then(|i| i.get("dispatch_id")).and_then(as_i32);
        }
        _ => {
            line.kind = "message".into();
            line.target = input.and_then(|i| i.get("to")).and_then(|to| match to {
                Value::String(s) => match s.trim().parse::<i32>() {
                    Ok(id) => names.bots.get(&id).cloned(),
                    Err(_) => short(s),
                },
                other => as_i32(other).and_then(|id| names.bots.get(&id).cloned()),
            });
        }
    }
}

fn as_i32(v: &Value) -> Option<i32> {
    v.as_i64()
        .or_else(|| {
            v.as_str()
                .and_then(|s| s.trim().trim_start_matches('#').parse().ok())
        })
        .and_then(|n| i32::try_from(n).ok())
}

fn str_field<'a>(input: &'a Value, keys: &[&str]) -> Option<&'a str> {
    keys.iter()
        .find_map(|k| input.get(*k).and_then(|v| v.as_str()))
        .filter(|s| !s.trim().is_empty())
}

fn path_of(input: Option<&Value>, path: Option<&str>) -> Option<String> {
    path.filter(|p| !p.is_empty())
        .map(str::to_string)
        .or_else(|| {
            input
                .and_then(|i| {
                    str_field(
                        i,
                        &[
                            "file_path",
                            "path",
                            "filePath",
                            "absolute_path",
                            "notebook_path",
                            "file",
                        ],
                    )
                })
                .map(str::to_string)
        })
        .or_else(|| {
            // A patch over several files: the first.
            input
                .and_then(|i| i.get("changes"))
                .and_then(|c| c.as_object())
                .and_then(|m| m.keys().next().cloned())
        })
}

fn query_of(input: Option<&Value>) -> Option<String> {
    input
        .and_then(|i| str_field(i, &["pattern", "query", "regex", "glob", "q", "search"]))
        .and_then(short)
}

fn command_of(input: Option<&Value>) -> Option<String> {
    let input = input?;
    match input.get("command").or_else(|| input.get("cmd")) {
        Some(Value::String(s)) if !s.trim().is_empty() => Some(s.trim().to_string()),
        Some(Value::Array(parts)) => {
            let words: Vec<&str> = parts.iter().filter_map(|p| p.as_str()).collect();
            // `["bash", "-lc", "cargo test"]`: the script.
            match words.as_slice() {
                [shell, flag, script] if shell.ends_with("sh") && flag.starts_with('-') => {
                    Some(script.to_string())
                }
                _ if !words.is_empty() => Some(words.join(" ")),
                _ => None,
            }
        }
        _ => None,
    }
}

/// The message of a `git commit`: `-m "…"` (the first, its first line), or
/// the first line of a heredoc it reads the message from.
fn commit_message(command: &str) -> Option<String> {
    if let Some(at) = command.find("<<") {
        let rest = &command[at..];
        if let Some(body) = rest.split_once('\n').map(|(_, b)| b) {
            if let Some(first) = body.lines().map(str::trim).find(|l| !l.is_empty()) {
                return Some(first.to_string());
            }
        }
    }
    let c = COMMIT_MESSAGE.captures(command)?;
    let msg = c.get(1).or_else(|| c.get(2)).or_else(|| c.get(3))?.as_str();
    let msg = msg.replace("\\\"", "\"").replace("\\n", "\n");
    msg.lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .map(str::to_string)
}

/// Lines added and removed by an edit, from what it was given.
fn edit_counts(input: &Value) -> Option<(u32, u32)> {
    let pair = |old: Option<&str>, new: Option<&str>| -> Option<(u32, u32)> {
        let new = new?;
        Some(match old {
            Some(old) => line_delta(old, new),
            None => (count_lines(new), 0),
        })
    };
    if let Some(edits) = input.get("edits").and_then(|e| e.as_array()) {
        let mut sum = (0, 0);
        let mut any = false;
        for e in edits {
            if let Some((a, r)) = pair(
                str_field(e, &["old_string", "oldText", "old_text"]).or(Some("")),
                str_field(e, &["new_string", "newText", "new_text"]),
            ) {
                sum = (sum.0 + a, sum.1 + r);
                any = true;
            }
        }
        if any {
            return Some(sum);
        }
    }
    if let Some(changes) = input.get("changes").and_then(|c| c.as_object()) {
        let mut sum = (0, 0);
        let mut any = false;
        for change in changes.values() {
            let counted = if let Some(patch) = str_field(change, &["diff", "unified_diff", "patch"])
            {
                Some(patch_counts(patch))
            } else {
                pair(
                    change.get("old_text").and_then(|v| v.as_str()),
                    change.get("new_text").and_then(|v| v.as_str()),
                )
            };
            if let Some((a, r)) = counted {
                sum = (sum.0 + a, sum.1 + r);
                any = true;
            }
        }
        if any {
            return Some(sum);
        }
    }
    if let Some(patch) =
        str_field(input, &["patch", "diff", "input"]).filter(|p| looks_like_patch(p))
    {
        return Some(patch_counts(patch));
    }
    if let Some(new) = str_field(input, &["new_string", "newText", "new_text"]) {
        let old = input
            .get("old_string")
            .or_else(|| input.get("oldText"))
            .or_else(|| input.get("old_text"))
            .and_then(|v| v.as_str())
            .unwrap_or("");
        return Some(line_delta(old, new));
    }
    if let Some(content) = input.get("content").and_then(|v| v.as_str()) {
        return Some((count_lines(content), 0));
    }
    None
}

fn looks_like_patch(s: &str) -> bool {
    s.contains("\n+")
        || s.contains("\n-")
        || s.starts_with("*** Begin Patch")
        || s.starts_with("--- ")
}

/// `+` and `-` lines of a unified diff or an `apply_patch` body, headers
/// left out.
fn patch_counts(patch: &str) -> (u32, u32) {
    let mut added = 0;
    let mut removed = 0;
    for l in patch.lines() {
        if l.starts_with("+++") || l.starts_with("---") || l.starts_with("***") {
            continue;
        }
        if l.starts_with('+') {
            added += 1;
        } else if l.starts_with('-') {
            removed += 1;
        }
    }
    (added, removed)
}

fn count_lines(s: &str) -> u32 {
    if s.is_empty() {
        0
    } else {
        s.lines().count() as u32
    }
}

/// Lines added and removed going from `old` to `new`: the lines of each not
/// matched by an equal line of the other (a line diff without the order —
/// the same counts for any edit that does not move lines around).
fn line_delta(old: &str, new: &str) -> (u32, u32) {
    let mut pool: HashMap<&str, i32> = HashMap::new();
    for l in old.lines() {
        *pool.entry(l).or_default() += 1;
    }
    let mut added = 0;
    for l in new.lines() {
        match pool.get_mut(l) {
            Some(n) if *n > 0 => *n -= 1,
            _ => added += 1,
        }
    }
    let removed: i32 = pool.values().filter(|n| **n > 0).sum();
    (added, removed as u32)
}

/// Passed and failed of a test run, from the summary lines its output ends
/// with: cargo's per binary summed, go's `--- PASS` lines counted, and the
/// others' last `N passed` / `N failed`.
fn test_counts(output: &str) -> (Option<u32>, Option<u32>) {
    let mut cargo = (0u32, 0u32, false);
    for c in CARGO_RESULT.captures_iter(output) {
        cargo.0 += c[1].parse::<u32>().unwrap_or(0);
        cargo.1 += c[2].parse::<u32>().unwrap_or(0);
        cargo.2 = true;
    }
    if cargo.2 {
        return (Some(cargo.0), Some(cargo.1));
    }
    let passed = last_number(&PASSED, output);
    let failed = last_number(&FAILED, output);
    if passed.is_some() || failed.is_some() {
        return (passed, failed);
    }
    let go_pass = GO_PASS.find_iter(output).count() as u32;
    let go_fail = GO_FAIL.find_iter(output).count() as u32;
    if go_pass + go_fail > 0 {
        return (Some(go_pass), Some(go_fail));
    }
    (None, None)
}

fn exit_code(output: &str) -> Option<i32> {
    EXIT_CODE
        .captures_iter(output)
        .last()
        .and_then(|c| c[1].parse().ok())
}

fn last_number(re: &Regex, s: &str) -> Option<u32> {
    re.captures_iter(s).last().and_then(|c| c[1].parse().ok())
}

/// A path's last part.
fn file_name(path: &str) -> String {
    let trimmed = path.trim().trim_end_matches(['/', '\\']);
    let name = trimmed.rsplit(['/', '\\']).next().unwrap_or(trimmed);
    clip(if name.is_empty() { trimmed } else { name })
}

fn last_word(title: &str) -> Option<String> {
    title
        .split_whitespace()
        .last()
        .map(|w| w.trim_matches(['`', '"', '\'']).to_string())
}

/// One line of `s`, clipped; `None` when blank.
fn short(s: &str) -> Option<String> {
    let line = s.split_whitespace().collect::<Vec<_>>().join(" ");
    if line.is_empty() {
        None
    } else {
        Some(clip(&line))
    }
}

fn clip(s: &str) -> String {
    if s.chars().count() <= MAX_TARGET_CHARS {
        s.to_string()
    } else {
        let mut cut: String = s.chars().take(MAX_TARGET_CHARS - 1).collect();
        cut.push('…');
        cut
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn raw(kind: &str, title: &str, input: Value, output: Option<&str>, status: &str) -> StepRaw {
        StepRaw {
            n: 1,
            kind: kind.into(),
            title: title.into(),
            status: Some(status.into()),
            awaiting: false,
            started_at: Utc::now(),
            input: Some(input),
            path: None,
            output: output.map(str::to_string),
        }
    }

    fn line(kind: &str, title: &str, input: Value, output: Option<&str>, status: &str) -> StepLine {
        line_of(&raw(kind, title, input, output, status), &Names::default())
    }

    #[test]
    fn an_edit_counts_its_lines_from_old_and_new_text() {
        let l = line(
            "edit",
            "Edit",
            json!({ "file_path": "/w/src/parser.rs", "old_string": "a\nb\nc", "new_string": "a\nB\nc\nd" }),
            None,
            "completed",
        );
        assert_eq!(l.kind, "edit");
        assert_eq!(l.target.as_deref(), Some("parser.rs"));
        assert_eq!((l.added, l.removed), (Some(2), Some(1)));
    }

    #[test]
    fn a_patch_and_a_new_file_count_too() {
        let patch = "*** Begin Patch\n*** Update File: a.rs\n@@\n-old\n+new\n+more\n*** End Patch";
        let l = line(
            "edit",
            "apply_patch",
            json!({ "patch": patch }),
            None,
            "completed",
        );
        assert_eq!((l.added, l.removed), (Some(2), Some(1)));
        let l = line(
            "edit",
            "Write",
            json!({ "file_path": "notes.md", "content": "one\ntwo\nthree" }),
            None,
            "completed",
        );
        assert_eq!((l.added, l.removed), (Some(3), Some(0)));
        let l = line(
            "edit",
            "Edit",
            json!({ "changes": { "/w/a.rs": { "diff": "--- a/a.rs\n+++ b/a.rs\n@@\n-x\n+y" } } }),
            None,
            "completed",
        );
        assert_eq!(l.target.as_deref(), Some("a.rs"));
        assert_eq!((l.added, l.removed), (Some(1), Some(1)));
    }

    #[test]
    fn a_test_run_is_told_from_a_command_and_counts_what_passed() {
        let l = line(
            "execute",
            "cargo test",
            json!({ "command": "cd src-tauri && cargo test --lib" }),
            Some("test result: ok. 200 passed; 0 failed; 1 ignored\ntest result: ok. 12 passed; 0 failed"),
            "completed",
        );
        assert_eq!(l.kind, "test");
        assert_eq!((l.passed, l.failed), (Some(212), Some(0)));
        let l = line(
            "execute",
            "pnpm vitest",
            json!({ "command": "pnpm vitest run" }),
            Some(" Test Files  3 passed (3)\n      Tests  2 failed | 40 passed (42)"),
            "failed",
        );
        assert_eq!((l.passed, l.failed), (Some(40), Some(2)));
        let l = line(
            "execute",
            "pytest",
            json!({ "command": "pytest -q" }),
            Some("===== 7 passed in 0.12s ====="),
            "completed",
        );
        assert_eq!(l.passed, Some(7));
        let l = line(
            "execute",
            "go test",
            json!({ "command": ["bash", "-lc", "go test -v ./..."] }),
            Some("--- PASS: TestA\n--- PASS: TestB\n--- FAIL: TestC"),
            "failed",
        );
        assert_eq!(l.kind, "test");
        assert_eq!((l.passed, l.failed), (Some(2), Some(1)));
    }

    #[test]
    fn a_command_says_its_exit_code_and_a_commit_its_message() {
        let l = line(
            "execute",
            "pnpm lint",
            json!({ "command": "pnpm lint" }),
            Some("…\nExit code: 1"),
            "failed",
        );
        assert_eq!((l.kind.as_str(), l.exit_code), ("execute", Some(1)));
        assert_eq!(l.target.as_deref(), Some("pnpm lint"));
        let l = line(
            "execute",
            "git commit",
            json!({ "command": "git add -A && git commit -m \"clamp NaN\n\nmore\"" }),
            None,
            "completed",
        );
        assert_eq!(
            (l.kind.as_str(), l.target.as_deref()),
            ("commit", Some("clamp NaN"))
        );
        let heredoc = "git commit -m \"$(cat <<'EOF'\nfix: parse dates\n\nbody\nEOF\n)\"";
        let l = line(
            "execute",
            "git commit",
            json!({ "command": heredoc }),
            None,
            "completed",
        );
        assert_eq!(l.target.as_deref(), Some("fix: parse dates"));
        // `test` alone in a word is no test run.
        let l = line(
            "execute",
            "x",
            json!({ "command": "ls testdata" }),
            None,
            "completed",
        );
        assert_eq!(l.kind, "execute");
    }

    #[test]
    fn a_search_says_its_query_and_hits() {
        let l = line(
            "search",
            "grep toFixed",
            json!({ "pattern": "toFixed" }),
            Some("Found 12 files\na.ts\nb.ts"),
            "completed",
        );
        assert_eq!((l.target.as_deref(), l.hits), (Some("toFixed"), Some(12)));
        let l = line(
            "search",
            "grep x",
            json!({ "pattern": "x" }),
            Some("a.ts"),
            "completed",
        );
        assert_eq!(l.hits, None);
    }

    #[test]
    fn codegs_own_tools_name_whom_the_work_went_to() {
        let mut names = Names::default();
        names.executors.insert(3, "Claude Code".into());
        names.bots.insert(9, "Reviewer".into());
        let l = line_of(
            &raw(
                "other",
                "mcp__codeg__dispatch",
                json!({ "assistant_id": 3, "prompt": "fix it" }),
                Some("Dispatched #234 to Claude Code"),
                "completed",
            ),
            &names,
        );
        assert_eq!(
            (l.kind.as_str(), l.target.as_deref(), l.dispatch_id),
            ("dispatch", Some("Claude Code"), Some(234))
        );
        let l = line_of(
            &raw(
                "other",
                "codeg.bot_message",
                json!({ "to": "9", "body": "hi" }),
                None,
                "in_progress",
            ),
            &names,
        );
        assert_eq!(
            (l.kind.as_str(), l.target.as_deref()),
            ("message", Some("Reviewer"))
        );
        let l = line_of(
            &raw(
                "other",
                "mcp__codeg__dispatch_followup",
                json!({ "dispatch_id": 7 }),
                None,
                "completed",
            ),
            &names,
        );
        assert_eq!((l.kind.as_str(), l.dispatch_id), ("followup", Some(7)));
    }

    #[test]
    fn the_steps_that_are_no_call_keep_their_kind() {
        let plain = |kind: &str| StepRaw {
            n: 1,
            kind: kind.into(),
            title: "Write the parser".into(),
            status: None,
            awaiting: false,
            started_at: Utc::now(),
            input: None,
            path: None,
            output: None,
        };
        assert_eq!(line_of(&plain("text"), &Names::default()).kind, "reply");
        assert_eq!(line_of(&plain("think"), &Names::default()).kind, "think");
        let p = line_of(&plain("plan"), &Names::default());
        assert_eq!(
            (p.kind.as_str(), p.target.as_deref()),
            ("plan", Some("Write the parser"))
        );
        // A read with only a title still names its file.
        let r = StepRaw {
            kind: "read".into(),
            title: "Read /w/AGENTS.md".into(),
            ..plain("read")
        };
        assert_eq!(
            line_of(&r, &Names::default()).target.as_deref(),
            Some("AGENTS.md")
        );
    }
}
