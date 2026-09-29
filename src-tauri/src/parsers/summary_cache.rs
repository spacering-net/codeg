//! Process-global cache for per-file conversation summaries.
//!
//! `list_conversations` (and, through it, `list_folders`, `get_stats`, and
//! `get_sidebar_data`) rebuilds the whole history list on every request by
//! walking each agent's session tree and parsing every file to EOF — the
//! per-file summary parse can't early-exit because it needs the *last*
//! timestamp and the total message count. With four hot endpoints and a history
//! that only grows, that re-parse cost is unbounded.
//!
//! This module memoizes a `ConversationSummary` per `(AgentType, path)`,
//! invalidated by a cheap `(mtime, size)` fingerprint: a cache hit `stat`s the
//! file (microseconds) instead of reading and JSON-parsing it (milliseconds-to-
//! seconds for a long session). The one actively-streaming file re-parses on
//! each list — every other (dormant) conversation is served from cache.
//!
//! ## What may route through here
//!
//! Only parsers whose cached summary is a *pure function of one file's bytes*:
//! Claude, Codex, CodeBuddy, and Pi each derive the summary they hand to the
//! cache from the single file being parsed (`folder_path` comes from an in-file
//! `cwd`). Claude additionally fills a *missing* `folder_path` from the file's
//! parent-directory name, but that fallback runs in the list loop AFTER the
//! cache returns, on the returned clone — it's deterministic given the file's
//! location and never mutates the cached entry, so it doesn't affect validity.
//!
//! A summary that is a pure function of a FIXED set of sibling files may route
//! through [`get_or_parse_with_companions`], which folds every file's token
//! into the fingerprint: Kiro's `<id>.jsonl` event log plus its `<id>.json`
//! metadata, which are written at different moments of a turn.
//!
//! The key is namespaced by `AgentType`, not path alone: the cache is shared by
//! every parser, and a value depends on WHICH parser produced it. If two agents'
//! roots are configured to overlap (distinct env overrides normally keep them
//! apart, but nothing enforces it), a bare-path key would let one parser serve
//! another parser's summary for the same file — wrong `agent_type` and fields.
//!
//! Deliberately NOT cached:
//! - **Gemini** — its `folder_path` is resolved from external `.project_root` /
//!   `projects.json` files, so the summary is *not* a pure function of the chat
//!   file; an (mtime, size) key on the chat file alone could serve a stale
//!   folder after that external metadata changes.
//! - **Cline / OpenClaw / Kimi** — a conversation spans multiple files, or one
//!   file yields many summaries plus external index state; a single path
//!   fingerprint is insufficient.
//! - **OpenCode / Hermes** — SQLite-backed; already query an indexed store.
//!
//! ## Invalidation token
//!
//! `(mtime, size)`. Size alone catches every append (the jsonl session logs only
//! ever grow); mtime additionally catches a same-size in-place rewrite whenever
//! the clock advanced. The residual blind spot — a same-size rewrite that also
//! preserves mtime (`cp -p`, a timestamp-preserving restore, or coarse
//! filesystem mtime granularity within the same tick) — is accepted: these are
//! append-only agent logs, not hand-edited files, and the app's import/restore
//! path writes the SQLite DB rather than rewriting these logs in place with
//! preserved timestamps. As an extra guard, an entry is only cached when the
//! file's fingerprint is unchanged across the parse (see `get_or_parse`), so a
//! write that races the read — including the actively-streaming file — is not
//! memoized under a stale summary.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::SystemTime;

use super::ParseError;
use crate::models::{AgentType, ConversationSummary};

/// One file's content token: `(mtime, size)`. `mtime` is `Option` because a
/// platform may not report it; a `None`/`None` comparison then falls back to
/// size-only.
type FileToken = (Option<SystemTime>, u64);

/// The keyed file's token plus one per companion file (`None` = the companion
/// does not exist, which is itself a state a later write can change).
#[derive(Debug, Clone, PartialEq, Eq)]
struct Fingerprint {
    primary: FileToken,
    companions: Vec<Option<FileToken>>,
}

struct CacheEntry {
    fingerprint: Fingerprint,
    /// Only positive summaries are stored — see `get_or_parse`.
    summary: ConversationSummary,
}

/// Nested `AgentType → (path → entry)` so a lookup borrows `&Path` (no
/// per-lookup `PathBuf` allocation on the hot hit path) while still namespacing
/// by parser identity.
type Cache = HashMap<AgentType, HashMap<PathBuf, CacheEntry>>;

fn cache() -> &'static Mutex<Cache> {
    static CACHE: OnceLock<Mutex<Cache>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn file_token(path: &Path) -> Option<FileToken> {
    let meta = std::fs::metadata(path).ok()?;
    Some((meta.modified().ok(), meta.len()))
}

/// Stat the keyed file (and its companions) for the fingerprint. Returns `None`
/// (⇒ bypass the cache) when the KEYED file can't be stat'd; a missing
/// companion is recorded, not fatal.
fn fingerprint(path: &Path, companions: &[&Path]) -> Option<Fingerprint> {
    Some(Fingerprint {
        primary: file_token(path)?,
        companions: companions.iter().map(|c| file_token(c)).collect(),
    })
}

/// Return the cached summary for `(agent_type, path)` if the file is unchanged
/// since it was last parsed; otherwise run `parse`, cache a positive result, and
/// return it.
///
/// `parse` is invoked at most once per call and runs OUTSIDE the cache lock — it
/// reads and parses the whole file, which is the expensive work being cached, so
/// holding the map lock across it would serialize every concurrent list request.
/// A concurrent miss on the same key may therefore parse twice; that's harmless
/// (the parse is idempotent) and rare.
///
/// `agent_type` namespaces the key: the cache is shared by all parsers and the
/// summary depends on which parser produced it, so two parsers scanning the same
/// path (overlapping roots) must not share an entry.
///
/// Caching rules, chosen so a cache entry can never *hide* a real conversation:
/// - Only `Ok(Some(_))` is stored. `Ok(None)` (an empty / not-a-conversation
///   file — for some parsers also a transient `File::open` failure that
///   degrades to `None`) and `Err` are returned but never cached, so they
///   re-parse next time and self-heal. Re-parsing a `None` file is cheap: it has
///   no content to read.
/// - A positive result is stored only if the file's fingerprint is unchanged
///   across the parse. If the file was written while we read it (a torn read, or
///   the actively-streaming session file), we return the parse but don't cache
///   it, so the next list re-parses the settled bytes.
pub(crate) fn get_or_parse<F>(
    agent_type: AgentType,
    path: &Path,
    parse: F,
) -> Result<Option<ConversationSummary>, ParseError>
where
    F: FnOnce() -> Result<Option<ConversationSummary>, ParseError>,
{
    get_or_parse_with_companions(agent_type, path, &[], parse)
}

/// [`get_or_parse`] for a summary that is a pure function of a FIXED SET of
/// files rather than one: the entry is keyed by `path` and invalidated when
/// `path` or any of `companions` changes (or appears, or disappears).
///
/// For agents that split one session across sibling files — Kiro writes the
/// event log to `<id>.jsonl` as a turn streams and rewrites the metadata in
/// `<id>.json` (title, working directory, model) when it ends — so neither file
/// alone decides the summary.
pub(crate) fn get_or_parse_with_companions<F>(
    agent_type: AgentType,
    path: &Path,
    companions: &[&Path],
    parse: F,
) -> Result<Option<ConversationSummary>, ParseError>
where
    F: FnOnce() -> Result<Option<ConversationSummary>, ParseError>,
{
    // Can't fingerprint (file vanished, permission error, …) ⇒ bypass the cache:
    // parse fresh and store nothing, since there's no token to validate against.
    let Some(fp_before) = fingerprint(path, companions) else {
        return parse();
    };

    // Fast path: a live fingerprint match returns the cached summary without
    // reading or parsing the file.
    if let Ok(map) = cache().lock() {
        if let Some(entry) = map.get(&agent_type).and_then(|m| m.get(path)) {
            if entry.fingerprint == fp_before {
                return Ok(Some(entry.summary.clone()));
            }
        }
    }

    // Miss or stale: parse with the lock released.
    let parsed = parse()?;

    // Cache only a positive result, and only if the file didn't change while we
    // read it (`fingerprint(path) == fp_before`). A changed fingerprint means a
    // concurrent write raced the read (or this is the streaming file); leave it
    // uncached so the next list re-parses the settled content.
    if let Some(summary) = &parsed {
        if fingerprint(path, companions).as_ref() == Some(&fp_before) {
            if let Ok(mut map) = cache().lock() {
                map.entry(agent_type).or_default().insert(
                    path.to_path_buf(),
                    CacheEntry {
                        fingerprint: fp_before,
                        summary: summary.clone(),
                    },
                );
            }
        }
    }
    Ok(parsed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Utc;
    use std::cell::Cell;
    use std::io::Write;

    // NOTE: these tests share the process-global cache and run in parallel, so
    // they must NEVER mutate shared state (no `clear()`): each test uses a unique
    // `tempfile::tempdir()` path, so its `(AgentType, path)` keys can't collide
    // with another test's, and no test can wipe another's entry mid-assertion.
    fn dummy_agent(agent_type: AgentType, id: &str) -> ConversationSummary {
        ConversationSummary {
            id: id.to_string(),
            agent_type,
            folder_path: None,
            folder_name: None,
            title: None,
            started_at: Utc::now(),
            ended_at: None,
            message_count: 0,
            model: None,
            git_branch: None,
            parent_id: None,
            parent_tool_use_id: None,
            delegation_call_id: None,
        }
    }

    fn dummy(id: &str) -> ConversationSummary {
        dummy_agent(AgentType::ClaudeCode, id)
    }

    fn write(path: &Path, bytes: &[u8]) {
        let mut f = std::fs::File::create(path).unwrap();
        f.write_all(bytes).unwrap();
        f.flush().unwrap();
    }

    fn append(path: &Path, bytes: &[u8]) {
        let mut f = std::fs::OpenOptions::new().append(true).open(path).unwrap();
        f.write_all(bytes).unwrap();
        f.flush().unwrap();
    }

    #[test]
    fn caches_a_hit_and_reparses_when_the_file_grows() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("session.jsonl");
        write(&path, b"one line\n");

        let calls = Cell::new(0);
        let run = || {
            get_or_parse(AgentType::ClaudeCode, &path, || {
                calls.set(calls.get() + 1);
                Ok(Some(dummy("a")))
            })
            .unwrap()
        };

        // Miss → parse runs once.
        assert_eq!(run().unwrap().id, "a");
        assert_eq!(calls.get(), 1);

        // Unchanged file → hit, parse does NOT run again.
        assert_eq!(run().unwrap().id, "a");
        assert_eq!(calls.get(), 1);

        // Append grows the size → stale → parse runs again.
        append(&path, b"two line\n");
        assert!(run().is_some());
        assert_eq!(calls.get(), 2);
    }

    #[test]
    fn does_not_cache_a_none_result() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("not-a-convo.jsonl");
        write(&path, b"junk\n");

        let calls = Cell::new(0);
        let run = || {
            get_or_parse(AgentType::ClaudeCode, &path, || {
                calls.set(calls.get() + 1);
                Ok(None)
            })
        };

        assert!(run().unwrap().is_none());
        assert!(run().unwrap().is_none());
        // `None` may be a transient open failure (for the Option-returning
        // parsers), so it must NOT stick — the second call re-parses.
        assert_eq!(calls.get(), 2);
    }

    #[test]
    fn does_not_cache_an_error() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("session.jsonl");
        write(&path, b"line\n");

        let calls = Cell::new(0);
        let run = || {
            get_or_parse(AgentType::ClaudeCode, &path, || {
                calls.set(calls.get() + 1);
                Err(ParseError::InvalidData("boom".to_string()))
            })
        };

        assert!(run().is_err());
        assert!(run().is_err());
        // A transient error must not stick — the second call re-parses.
        assert_eq!(calls.get(), 2);
    }

    #[test]
    fn does_not_cache_when_the_file_changes_during_parse() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("streaming.jsonl");
        write(&path, b"line\n");

        // The closure mutates the file mid-parse (simulating a write that races
        // the read, e.g. the actively-streaming session file). The post-parse
        // fingerprint then differs from the pre-parse one, so nothing is cached.
        let calls = Cell::new(0);
        let run = || {
            get_or_parse(AgentType::ClaudeCode, &path, || {
                calls.set(calls.get() + 1);
                append(&path, b"more\n");
                Ok(Some(dummy("s")))
            })
        };

        assert!(run().unwrap().is_some());
        assert!(run().unwrap().is_some());
        // Fingerprint changed across every parse ⇒ never memoized ⇒ re-parsed.
        assert_eq!(calls.get(), 2);
    }

    #[test]
    fn bypasses_the_cache_for_a_missing_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("gone.jsonl"); // never created

        let calls = Cell::new(0);
        let run = || {
            get_or_parse(AgentType::ClaudeCode, &path, || {
                calls.set(calls.get() + 1);
                Ok(Some(dummy("x")))
            })
        };

        // No fingerprint ⇒ parse every time, nothing cached.
        assert!(run().unwrap().is_some());
        assert!(run().unwrap().is_some());
        assert_eq!(calls.get(), 2);
    }

    #[test]
    fn keys_are_per_path() {
        let dir = tempfile::tempdir().unwrap();
        let a = dir.path().join("a.jsonl");
        let b = dir.path().join("b.jsonl");
        write(&a, b"a\n");
        write(&b, b"b\n");

        assert_eq!(
            get_or_parse(AgentType::ClaudeCode, &a, || Ok(Some(dummy("a"))))
                .unwrap()
                .unwrap()
                .id,
            "a"
        );
        // Distinct path ⇒ distinct entry; `a`'s cached value must not leak here.
        assert_eq!(
            get_or_parse(AgentType::ClaudeCode, &b, || Ok(Some(dummy("b"))))
                .unwrap()
                .unwrap()
                .id,
            "b"
        );
    }

    #[test]
    fn namespaces_by_agent_type_on_the_same_path() {
        let dir = tempfile::tempdir().unwrap();
        // Overlapping roots: two parsers scan the SAME file (same fingerprint).
        let path = dir.path().join("session.jsonl");
        write(&path, b"shared\n");

        // CodeBuddy parses and caches its summary for this path.
        let cb = get_or_parse(AgentType::CodeBuddy, &path, || {
            Ok(Some(dummy_agent(AgentType::CodeBuddy, "cb")))
        })
        .unwrap()
        .unwrap();
        assert_eq!(cb.agent_type, AgentType::CodeBuddy);

        // Pi scanning the same path must NOT hit CodeBuddy's entry: its closure
        // runs and it gets a Pi summary, not a stale CodeBuddy one.
        let pi_calls = Cell::new(0);
        let pi = get_or_parse(AgentType::Pi, &path, || {
            pi_calls.set(pi_calls.get() + 1);
            Ok(Some(dummy_agent(AgentType::Pi, "pi")))
        })
        .unwrap()
        .unwrap();
        assert_eq!(pi.agent_type, AgentType::Pi);
        assert_eq!(pi.id, "pi");
        assert_eq!(pi_calls.get(), 1);

        // And CodeBuddy still hits its own cached entry (no cross-eviction).
        let cb_calls = Cell::new(0);
        let cb2 = get_or_parse(AgentType::CodeBuddy, &path, || {
            cb_calls.set(cb_calls.get() + 1);
            Ok(Some(dummy_agent(AgentType::CodeBuddy, "cb2")))
        })
        .unwrap()
        .unwrap();
        assert_eq!(cb2.id, "cb"); // served from cache, closure not run
        assert_eq!(cb_calls.get(), 0);
    }

    // A companion is part of the key: rewriting it (Kiro's metadata file at
    // the end of a turn), creating it, or deleting it must each invalidate the
    // entry even though the keyed file never changed.
    #[test]
    fn a_companion_change_invalidates_the_entry() {
        let dir = tempfile::tempdir().unwrap();
        let log = dir.path().join("s.jsonl");
        let meta = dir.path().join("s.json");
        write(&log, b"event\n");

        let calls = Cell::new(0);
        let run = || {
            get_or_parse_with_companions(AgentType::Kiro, &log, &[&meta], || {
                calls.set(calls.get() + 1);
                Ok(Some(dummy_agent(AgentType::Kiro, "k")))
            })
            .unwrap()
        };

        assert!(run().is_some());
        assert!(run().is_some());
        assert_eq!(calls.get(), 1, "unchanged pair is a hit");

        // Companion appears.
        write(&meta, b"{}");
        assert!(run().is_some());
        assert_eq!(calls.get(), 2);
        assert!(run().is_some());
        assert_eq!(calls.get(), 2);

        // Companion rewritten with a different size.
        write(&meta, b"{\"title\":\"renamed\"}");
        assert!(run().is_some());
        assert_eq!(calls.get(), 3);

        // Companion removed.
        std::fs::remove_file(&meta).unwrap();
        assert!(run().is_some());
        assert_eq!(calls.get(), 4);
    }
}
