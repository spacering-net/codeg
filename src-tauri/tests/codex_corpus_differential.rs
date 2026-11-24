//! Differential harness for the Codex rollout parser.
//!
//! The `response_item.message` promotion added for issue #452 is gated on a
//! per-turn canonical-channel check whose whole safety argument is "it never
//! fires on a rollout the event channel already covers". Unit tests can pin the
//! shapes we thought of; only a sweep of a real corpus can show that nothing
//! ELSE moved.
//!
//! This test is `#[ignore]`d and additionally self-skips without an explicit
//! corpus path, so it never runs in CI. To use it:
//!
//! ```sh
//! CODEG_CODEX_CORPUS_DIR=~/.codex/sessions \
//! CODEG_CODEX_CORPUS_OUT=/tmp/codex-digest-branch.txt \
//!   cargo test --features test-utils --test codex_corpus_differential -- --ignored --nocapture
//! # then repeat on the base revision and `diff` the two digests
//! ```
//!
//! The digest is the fully serialized `ConversationSummary` + `ConversationDetail`
//! per session, NOT a shape tuple — a turn-count/lengths comparison would sail
//! straight past a changed title, a moved usage figure, a reordered block or a
//! same-length text substitution.

use std::collections::BTreeMap;
use std::io::Write as _;
use std::path::{Path, PathBuf};

use codeg_lib::models::AgentType;
use codeg_lib::parsers::codex::CodexParser;
use codeg_lib::parsers::AgentParser;

fn rollouts_in(root: &Path) -> Vec<PathBuf> {
    let mut found = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
                continue;
            }
            let name = path.file_name().unwrap_or_default().to_string_lossy();
            if name.starts_with("rollout-") && name.ends_with(".jsonl") {
                found.push(path);
            }
        }
    }
    found.sort();
    found
}

#[test]
#[ignore = "requires a local Codex rollout corpus; see module docs"]
fn codex_corpus_digest() {
    let Ok(root) = std::env::var("CODEG_CODEX_CORPUS_DIR") else {
        eprintln!("CODEG_CODEX_CORPUS_DIR unset — skipping");
        return;
    };
    let root = PathBuf::from(shellexpand_home(&root));
    let out = std::env::var("CODEG_CODEX_CORPUS_OUT")
        .unwrap_or_else(|_| "/tmp/codex-corpus-digest.txt".to_string());

    let files = rollouts_in(&root);
    assert!(!files.is_empty(), "no rollouts under {}", root.display());

    // Keyed by session id so the digest is order-independent: the two runs must
    // agree on content, not on directory-walk order.
    let mut digest: BTreeMap<String, String> = BTreeMap::new();
    let mut day_dirs: Vec<PathBuf> = files
        .iter()
        .filter_map(|path| path.parent().map(Path::to_path_buf))
        .collect();
    day_dirs.sort();
    day_dirs.dedup();

    // Parse per day-directory rather than per file: `get_conversation` walks its
    // whole base dir looking for a filename match, so rooting it at the corpus
    // root would make the sweep quadratic.
    for dir in &day_dirs {
        let parser = CodexParser::with_base_dir(dir.clone());
        let Ok(summaries) = parser.list_conversations() else {
            continue;
        };
        for summary in summaries {
            assert_eq!(summary.agent_type, AgentType::Codex);
            let id = summary.id.clone();
            let detail = parser.get_conversation(&id).ok();
            let record = serde_json::json!({
                "summary": summary,
                "detail": detail,
            });
            digest.insert(
                id,
                serde_json::to_string(&record).expect("serialize digest record"),
            );
        }
    }

    let mut file = std::fs::File::create(&out).expect("create digest file");
    for (id, record) in &digest {
        writeln!(file, "{id}\t{record}").expect("write digest line");
    }
    eprintln!(
        "wrote {} session digests from {} rollouts to {out}",
        digest.len(),
        files.len()
    );
}

fn shellexpand_home(raw: &str) -> String {
    match raw.strip_prefix("~/") {
        Some(rest) => dirs::home_dir()
            .unwrap_or_default()
            .join(rest)
            .to_string_lossy()
            .to_string(),
        None => raw.to_string(),
    }
}
