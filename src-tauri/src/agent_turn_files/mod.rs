//! Per-turn record of the Office documents an agent wrote through its tools —
//! the only files the workspace may auto-open as a live preview.
//!
//! Every running turn (a connection in `Prompting`) owns one record:
//!
//! * `mentioned` — Office paths its tool calls named (see [`extract`]),
//! * `files` — the subset confirmed as written during the turn.
//!
//! A mentioned path is confirmed when the file exists as a regular file and its
//! modification or creation time is no earlier than the turn's start, less
//! [`FILE_CLOCK_SLACK`]. A
//! read-only mention (`officecli view a.pptx`) and metadata-only changes
//! (attributes, ACLs, xattrs) move neither time, so they never qualify. Paths
//! no tool call named never enter a record at all, whatever touches them —
//! sync clients, antivirus, a branch switch, another program.
//!
//! Confirmation runs whenever one of the turn's tool calls settles (completed
//! or failed) and once more when the turn ends normally. A newly confirmed path
//! is published on [`AGENT_TURN_FILES_EVENT`] once per turn; windows keep their
//! own "already opened / dismissed" memory, so there is no cross-turn dedup
//! here.
//!
//! A record is deleted the moment its turn ends — normal end, cancel, error or
//! the connection going away. Jobs carry the turn id they were scheduled for,
//! never the connection, so a later turn of the same connection is never
//! credited; publication happens under the registry lock, so it cannot
//! interleave with the turn's teardown.

pub(crate) mod extract;

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex, MutexGuard};
use std::time::{Duration, SystemTime};

use serde::Serialize;

use crate::web::event_bridge::{emit_event, EventEmitter};

/// Broadcast when a turn confirms Office files it wrote. Payload:
/// [`AgentTurnFilesEvent`].
pub const AGENT_TURN_FILES_EVENT: &str = "folder://agent-turn-files";

/// Bound on the paths one turn may name. Only guards against a pathological
/// turn (memory and stat cost); it is not a product-level batch limit.
const MAX_MENTIONS_PER_TURN: usize = 256;

/// How far a file time may sit before the turn's start and still count. The
/// start comes from the precise system clock, but Linux and Windows stamp files
/// from a coarser kernel clock that lags it by up to one tick (a jiffy, or the
/// ~15.6 ms Windows timer), so a file written right after the start can read
/// as slightly older. Far below any real gap between a turn starting and its
/// first tool call finishing.
const FILE_CLOCK_SLACK: Duration = Duration::from_millis(50);

/// The earliest file time credited to a turn that started at `started_at`.
fn earliest_credited(started_at: SystemTime) -> SystemTime {
    started_at
        .checked_sub(FILE_CLOCK_SLACK)
        .unwrap_or(started_at)
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct AgentTurnFilesEvent {
    /// Absolute paths, as the filesystem spells them.
    pub paths: Vec<String>,
}

struct TurnRecord {
    connection_id: String,
    started_at: SystemTime,
    mentioned: BTreeSet<PathBuf>,
    files: HashSet<PathBuf>,
}

#[derive(Default)]
struct Registry {
    next_turn_id: u64,
    turns: HashMap<u64, TurnRecord>,
    by_connection: HashMap<String, u64>,
}

static REGISTRY: LazyLock<Mutex<Registry>> = LazyLock::new(|| Mutex::new(Registry::default()));

fn registry() -> MutexGuard<'static, Registry> {
    REGISTRY
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Work scheduled from `SessionState::apply_event` (which runs under the
/// session lock and must not touch the filesystem) and run afterwards on a
/// blocking thread by [`run_job`].
#[derive(Debug, Clone, PartialEq)]
pub enum TurnFileJob {
    /// Check the live turn's unconfirmed mentions.
    Confirm { turn_id: u64 },
    /// The last check of a turn that ended normally. The record is already
    /// gone; only files written within `[started_at - FILE_CLOCK_SLACK,
    /// ended_at]` count, so a later turn's writes are never credited to this
    /// one.
    Final {
        paths: Vec<PathBuf>,
        started_at: SystemTime,
        ended_at: SystemTime,
    },
}

/// Start a turn for `connection_id`, replacing any record it still holds (a
/// missed end).
pub(crate) fn begin_turn(connection_id: &str, started_at: SystemTime) -> u64 {
    let mut reg = registry();
    if let Some(stale) = reg.by_connection.remove(connection_id) {
        reg.turns.remove(&stale);
    }
    reg.next_turn_id += 1;
    let turn_id = reg.next_turn_id;
    reg.turns.insert(
        turn_id,
        TurnRecord {
            connection_id: connection_id.to_string(),
            started_at,
            mentioned: BTreeSet::new(),
            files: HashSet::new(),
        },
    );
    reg.by_connection.insert(connection_id.to_string(), turn_id);
    turn_id
}

/// End `connection_id`'s turn and delete its record. For a normal end, the
/// unconfirmed mentions are handed back as a [`TurnFileJob::Final`].
pub(crate) fn end_turn(
    connection_id: &str,
    normal: bool,
    ended_at: SystemTime,
) -> Option<TurnFileJob> {
    let mut reg = registry();
    let turn_id = reg.by_connection.remove(connection_id)?;
    let record = reg.turns.remove(&turn_id)?;
    debug_assert_eq!(record.connection_id, connection_id);
    if !normal {
        return None;
    }
    let paths: Vec<PathBuf> = record
        .mentioned
        .into_iter()
        .filter(|path| !record.files.contains(path))
        .collect();
    (!paths.is_empty()).then_some(TurnFileJob::Final {
        paths,
        started_at: record.started_at,
        ended_at,
    })
}

/// Record paths `connection_id`'s running turn named. No-op without a turn.
pub(crate) fn mention(connection_id: &str, paths: BTreeSet<PathBuf>) {
    if paths.is_empty() {
        return;
    }
    let mut reg = registry();
    let Some(turn_id) = reg.by_connection.get(connection_id).copied() else {
        return;
    };
    let Some(record) = reg.turns.get_mut(&turn_id) else {
        return;
    };
    for path in paths {
        if record.mentioned.len() >= MAX_MENTIONS_PER_TURN {
            break;
        }
        record.mentioned.insert(path);
    }
}

/// A confirm job for `connection_id`'s running turn, if it has anything left
/// to confirm.
pub(crate) fn confirm_job(connection_id: &str) -> Option<TurnFileJob> {
    let reg = registry();
    let turn_id = *reg.by_connection.get(connection_id)?;
    let record = reg.turns.get(&turn_id)?;
    record
        .mentioned
        .iter()
        .any(|path| !record.files.contains(path))
        .then_some(TurnFileJob::Confirm { turn_id })
}

/// Run a job: stat off-lock, then publish through `emitter`.
pub fn run_job(job: TurnFileJob, emitter: &EventEmitter) {
    run_job_with(job, written_files, |paths| {
        emit_event(
            emitter,
            AGENT_TURN_FILES_EVENT,
            AgentTurnFilesEvent {
                paths: paths
                    .iter()
                    .map(|path| path.to_string_lossy().into_owned())
                    .collect(),
            },
        );
    });
}

/// One file found on disk for a mentioned path.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct FoundFile {
    /// The path as mentioned (the record's key).
    pub mentioned: PathBuf,
    /// The path as the filesystem spells it (what gets published).
    pub actual: PathBuf,
    /// `max(modified, created)`.
    pub written_at: SystemTime,
}

/// [`run_job`] with the filesystem probe and the publisher injected. `publish`
/// is called with the registry lock held for [`TurnFileJob::Confirm`].
pub(crate) fn run_job_with(
    job: TurnFileJob,
    stat: impl FnOnce(&[PathBuf]) -> Vec<FoundFile>,
    mut publish: impl FnMut(&[PathBuf]),
) {
    match job {
        TurnFileJob::Confirm { turn_id } => {
            let (started_at, pending) = {
                let reg = registry();
                let Some(record) = reg.turns.get(&turn_id) else {
                    return;
                };
                let pending: Vec<PathBuf> = record
                    .mentioned
                    .iter()
                    .filter(|path| !record.files.contains(*path))
                    .cloned()
                    .collect();
                (earliest_credited(record.started_at), pending)
            };
            if pending.is_empty() {
                return;
            }
            let found = stat(&pending);
            let mut reg = registry();
            // Ended (or replaced) while we were on the filesystem: nothing to
            // credit, nothing to publish.
            let Some(record) = reg.turns.get_mut(&turn_id) else {
                return;
            };
            let mut fresh = Vec::new();
            for file in found {
                if file.written_at >= started_at && record.files.insert(file.mentioned) {
                    fresh.push(file.actual);
                }
            }
            if !fresh.is_empty() {
                // Still under the registry lock: `end_turn` cannot run between
                // the liveness check above and this publication.
                publish(&fresh);
            }
        }
        TurnFileJob::Final {
            paths,
            started_at,
            ended_at,
        } => {
            let earliest = earliest_credited(started_at);
            let fresh: Vec<PathBuf> = stat(&paths)
                .into_iter()
                .filter(|file| file.written_at >= earliest && file.written_at <= ended_at)
                .map(|file| file.actual)
                .collect();
            if !fresh.is_empty() {
                publish(&fresh);
            }
        }
    }
}

/// Stat `paths` through their parents' directory listings. On Windows the
/// metadata comes from the FindNextFile data, so the documents themselves are
/// never opened (an Office file held open by its editor stays undisturbed).
/// Symlinks and directories are skipped; missing files are simply absent.
pub(crate) fn written_files(paths: &[PathBuf]) -> Vec<FoundFile> {
    let mut by_parent: BTreeMap<&Path, Vec<&PathBuf>> = BTreeMap::new();
    for path in paths {
        if let Some(parent) = path.parent() {
            by_parent.entry(parent).or_default().push(path);
        }
    }
    let mut found = Vec::new();
    for (parent, wanted) in by_parent {
        let Ok(entries) = std::fs::read_dir(parent) else {
            continue;
        };
        let entries: Vec<std::fs::DirEntry> = entries.flatten().collect();
        for path in wanted {
            let Some(name) = path.file_name() else {
                continue;
            };
            let entry = entries.iter().find(|e| e.file_name() == name).or_else(|| {
                // Case-insensitive filesystems: the agent may spell the name
                // differently from how it sits on disk.
                if cfg!(any(windows, target_os = "macos")) {
                    let name = name.to_string_lossy().to_lowercase();
                    entries
                        .iter()
                        .find(|e| e.file_name().to_string_lossy().to_lowercase() == name)
                } else {
                    None
                }
            });
            let Some(entry) = entry else {
                continue;
            };
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            if !file_type.is_file() {
                continue;
            }
            let Ok(meta) = entry.metadata() else {
                continue;
            };
            let written_at = [meta.modified().ok(), meta.created().ok()]
                .into_iter()
                .flatten()
                .max();
            if let Some(written_at) = written_at {
                found.push(FoundFile {
                    mentioned: path.clone(),
                    actual: entry.path(),
                    written_at,
                });
            }
        }
    }
    found
}

#[cfg(test)]
mod tests {
    use super::*;

    fn conn(name: &str) -> String {
        // The registry is process-global and tests run in parallel.
        format!("agent-turn-files-test-{name}-{}", uuid::Uuid::new_v4())
    }

    fn t(secs: u64) -> SystemTime {
        SystemTime::UNIX_EPOCH + Duration::from_secs(1_000_000 + secs)
    }

    fn p(name: &str) -> PathBuf {
        std::env::temp_dir()
            .join("agent-turn-files-test")
            .join(name)
    }

    fn found(path: &Path, at: SystemTime) -> FoundFile {
        FoundFile {
            mentioned: path.to_path_buf(),
            actual: path.to_path_buf(),
            written_at: at,
        }
    }

    fn set(paths: &[&PathBuf]) -> BTreeSet<PathBuf> {
        paths.iter().map(|p| (*p).clone()).collect()
    }

    /// Run a confirm job with a fake filesystem; returns what was published.
    fn confirm(c: &str, fs: &[(PathBuf, SystemTime)]) -> Vec<PathBuf> {
        let mut published = Vec::new();
        if let Some(job) = confirm_job(c) {
            run_job_with(
                job,
                |pending| {
                    fs.iter()
                        .filter(|(path, _)| pending.contains(path))
                        .map(|(path, at)| found(path, *at))
                        .collect()
                },
                |paths| published.extend_from_slice(paths),
            );
        }
        published
    }

    #[test]
    fn written_mentions_confirm_once_and_the_end_clears_everything() {
        let c = conn("basic");
        let a = p("a.pptx");
        begin_turn(&c, t(10));
        mention(&c, set(&[&a]));
        assert_eq!(confirm(&c, &[(a.clone(), t(12))]), vec![a.clone()]);
        // Written again later in the same turn: already confirmed, not re-sent.
        mention(&c, set(&[&a]));
        assert!(confirm(&c, &[(a.clone(), t(15))]).is_empty());
        assert!(confirm_job(&c).is_none());
        assert_eq!(end_turn(&c, true, t(20)), None);
        assert!(confirm_job(&c).is_none());
        assert!(!registry().by_connection.contains_key(&c));
    }

    #[test]
    fn read_only_mentions_and_previous_turn_writes_do_not_qualify() {
        let c = conn("readonly");
        let old = p("template.pptx");
        let last_turn = p("last.pptx");
        begin_turn(&c, t(10));
        mention(&c, set(&[&old, &last_turn]));
        // `old` untouched for ages; `last_turn` written 1 s before this turn.
        assert!(confirm(&c, &[(old.clone(), t(0)), (last_turn.clone(), t(9))]).is_empty());
        // Missing files are not confirmed either.
        assert!(confirm(&c, &[]).is_empty());
        end_turn(&c, false, t(11));
    }

    #[test]
    fn a_file_time_a_coarse_clock_tick_before_the_start_still_counts() {
        // Linux/Windows stamp files from a clock that lags the precise one.
        let c = conn("slack");
        let tick = p("tick.docx");
        let before = p("before.docx");
        begin_turn(&c, t(10));
        mention(&c, set(&[&tick, &before]));
        let fs = [
            (tick.clone(), t(10) - Duration::from_millis(10)),
            (
                before.clone(),
                t(10) - FILE_CLOCK_SLACK - Duration::from_millis(1),
            ),
        ];
        assert_eq!(confirm(&c, &fs), vec![tick.clone()]);
        end_turn(&c, false, t(11));

        // The final check uses the same lower bound.
        let mut published = Vec::new();
        run_job_with(
            TurnFileJob::Final {
                paths: vec![tick.clone(), before.clone()],
                started_at: t(10),
                ended_at: t(11),
            },
            |_| fs.iter().map(|(path, at)| found(path, *at)).collect(),
            |paths| published.extend_from_slice(paths),
        );
        assert_eq!(published, vec![tick]);
    }

    #[test]
    fn a_mention_confirmed_by_a_later_call_counts() {
        // Write `gen.py` naming out.docx (mention), run it in a later call.
        let c = conn("later");
        let out = p("out.docx");
        begin_turn(&c, t(10));
        mention(&c, set(&[&out]));
        assert!(confirm(&c, &[]).is_empty());
        assert_eq!(confirm(&c, &[(out.clone(), t(30))]), vec![out]);
        end_turn(&c, false, t(31));
    }

    #[test]
    fn concurrent_turns_each_publish_and_end_independently() {
        let a = conn("a");
        let b = conn("b");
        let f = p("shared.xlsx");
        begin_turn(&a, t(10));
        begin_turn(&b, t(11));
        mention(&a, set(&[&f]));
        mention(&b, set(&[&f]));
        assert_eq!(confirm(&a, &[(f.clone(), t(12))]), vec![f.clone()]);
        assert_eq!(confirm(&b, &[(f.clone(), t(13))]), vec![f.clone()]);
        end_turn(&a, false, t(14));
        // B's record is untouched by A's end.
        let reg = registry();
        let b_id = reg.by_connection[&b];
        assert!(reg.turns[&b_id].files.contains(&f));
        drop(reg);
        end_turn(&b, false, t(15));
    }

    #[test]
    fn a_missed_end_is_replaced_by_the_next_turn() {
        let c = conn("missed");
        let a = p("a.docx");
        let first = begin_turn(&c, t(10));
        mention(&c, set(&[&a]));
        let second = begin_turn(&c, t(20));
        assert_ne!(first, second);
        assert!(!registry().turns.contains_key(&first));
        assert!(
            confirm_job(&c).is_none(),
            "the new turn inherits no mentions"
        );
        end_turn(&c, false, t(21));
    }

    #[test]
    fn a_turn_ending_during_the_stat_publishes_nothing() {
        let c = conn("cancel-mid-stat");
        let a = p("a.pptx");
        begin_turn(&c, t(10));
        mention(&c, set(&[&a]));
        let job = confirm_job(&c).expect("pending mention");
        let mut published = Vec::new();
        run_job_with(
            job,
            |_| {
                // The user cancels while the probe is on the filesystem.
                assert_eq!(end_turn(&c, false, t(12)), None);
                vec![found(&a, t(11))]
            },
            |paths| published.extend_from_slice(paths),
        );
        assert!(published.is_empty());
    }

    #[test]
    fn a_stale_confirm_is_never_credited_to_the_next_turn() {
        let c = conn("stale");
        let a = p("a.pptx");
        begin_turn(&c, t(10));
        mention(&c, set(&[&a]));
        let job = confirm_job(&c).expect("pending mention");
        end_turn(&c, false, t(11));
        begin_turn(&c, t(12));
        mention(&c, set(&[&a]));
        let mut published = Vec::new();
        run_job_with(
            job,
            |_| vec![found(&a, t(13))],
            |paths| published.extend_from_slice(paths),
        );
        assert!(published.is_empty());
        // The new turn still confirms it itself.
        assert_eq!(confirm(&c, &[(a.clone(), t(13))]), vec![a]);
        end_turn(&c, false, t(14));
    }

    #[test]
    fn a_normal_end_runs_a_bounded_final_check_and_an_abort_does_not() {
        let c = conn("final");
        let a = p("a.pptx");
        let b = p("b.pptx");
        let done = p("done.pptx");
        begin_turn(&c, t(10));
        mention(&c, set(&[&a, &b, &done]));
        assert_eq!(confirm(&c, &[(done.clone(), t(11))]), vec![done.clone()]);
        let job = end_turn(&c, true, t(20)).expect("unconfirmed mentions remain");
        assert_eq!(
            job,
            TurnFileJob::Final {
                paths: vec![a.clone(), b.clone()],
                started_at: t(10),
                ended_at: t(20),
            }
        );
        // `b` was written after the turn ended (the next turn's write).
        let mut published = Vec::new();
        run_job_with(
            job,
            |_| vec![found(&a, t(19)), found(&b, t(25))],
            |paths| published.extend_from_slice(paths),
        );
        assert_eq!(published, vec![a.clone()]);

        let c2 = conn("abort");
        begin_turn(&c2, t(10));
        mention(&c2, set(&[&a]));
        assert_eq!(end_turn(&c2, false, t(20)), None);
    }

    #[test]
    fn mentions_without_a_turn_and_past_the_cap_are_dropped() {
        let c = conn("cap");
        mention(&c, set(&[&p("x.docx")]));
        assert!(confirm_job(&c).is_none());
        begin_turn(&c, t(10));
        let many: BTreeSet<PathBuf> = (0..MAX_MENTIONS_PER_TURN + 10)
            .map(|i| p(&format!("{i}.docx")))
            .collect();
        mention(&c, many);
        let reg = registry();
        let id = reg.by_connection[&c];
        assert_eq!(reg.turns[&id].mentioned.len(), MAX_MENTIONS_PER_TURN);
        drop(reg);
        end_turn(&c, false, t(11));
    }

    #[test]
    fn written_files_reads_real_times_and_skips_dirs_symlinks_and_missing() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("real.docx");
        std::fs::write(&file, b"x").unwrap();
        let folder = dir.path().join("folder.docx");
        std::fs::create_dir(&folder).unwrap();
        let missing = dir.path().join("missing.docx");
        #[cfg_attr(not(unix), allow(unused_mut))]
        let mut paths = vec![file.clone(), folder, missing];
        #[cfg(unix)]
        {
            let link = dir.path().join("link.docx");
            std::os::unix::fs::symlink(&file, &link).unwrap();
            paths.push(link);
        }
        let old = SystemTime::now() - Duration::from_secs(3600);
        std::fs::File::options()
            .write(true)
            .open(&file)
            .unwrap()
            .set_modified(old)
            .unwrap();

        let found = written_files(&paths);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].mentioned, file);
        // max(modified, created). Where creation time is kept separately
        // (Windows, Linux statx) it stays "just now" and wins over the
        // back-dated mtime; macOS pulls the birth time back along with an
        // earlier mtime, so there both read `old`.
        let meta = std::fs::metadata(&file).unwrap();
        let expected = [meta.modified().ok(), meta.created().ok()]
            .into_iter()
            .flatten()
            .max()
            .unwrap();
        assert_eq!(found[0].written_at, expected);
        assert!(found[0].written_at >= old);
    }

    // ─── Through `SessionState::apply_event`, real filesystem ──────────────

    use crate::acp::session_state::SessionState;
    use crate::acp::types::{AcpEvent, ConnectionStatus};
    use crate::models::agent::AgentType;

    fn tool_call(id: &str, status: &str, command: Option<&str>) -> AcpEvent {
        AcpEvent::ToolCall {
            tool_call_id: id.into(),
            title: "Bash".into(),
            kind: "execute".into(),
            status: status.into(),
            content: None,
            raw_input: command.map(|c| serde_json::json!({ "command": c }).to_string()),
            raw_output: None,
            locations: None,
            meta: None,
            images: None,
        }
    }

    fn settle(id: &str) -> AcpEvent {
        AcpEvent::ToolCallUpdate {
            tool_call_id: id.into(),
            title: None,
            status: Some("completed".into()),
            content: None,
            raw_input: None,
            raw_output: None,
            raw_output_append: None,
            locations: None,
            meta: None,
            images: None,
        }
    }

    fn turn_complete(stop_reason: &str) -> AcpEvent {
        AcpEvent::TurnComplete {
            session_id: "s".into(),
            stop_reason: stop_reason.into(),
            agent_type: "claude_code".into(),
        }
    }

    fn run_all(state: &mut SessionState) -> Vec<PathBuf> {
        let mut published = Vec::new();
        for job in std::mem::take(&mut state.turn_file_jobs) {
            run_job_with(job, written_files, |paths| {
                published.extend_from_slice(paths)
            });
        }
        published
    }

    #[test]
    fn session_events_drive_mentions_confirmation_and_the_final_check() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        std::fs::create_dir(root.join("out")).unwrap();
        // A template that predates the turn (by more than the clock slack);
        // the agent only reads it.
        std::fs::write(root.join("template.pptx"), b"t").unwrap();
        std::thread::sleep(FILE_CLOCK_SLACK * 4);

        let c = conn("session");
        let mut state = SessionState::new(
            c.clone(),
            AgentType::ClaudeCode,
            Some(root.clone()),
            "win".into(),
            None,
        );
        state.apply_event(&AcpEvent::StatusChanged {
            status: ConnectionStatus::Prompting,
        });

        // A pending call that names its output; nothing to do until it settles.
        state.apply_event(&tool_call(
            "t1",
            "pending",
            Some("cd out && officecli create a.pptx; officecli view ../template.pptx outline"),
        ));
        assert!(state.turn_file_jobs.is_empty());
        std::fs::write(root.join("out/a.pptx"), b"a").unwrap();
        state.apply_event(&settle("t1"));
        assert_eq!(run_all(&mut state), vec![root.join("out/a.pptx")]);

        // A call that never settles (some agents never report it): the normal
        // end's final check still picks its write up.
        state.apply_event(&tool_call(
            "t2",
            "in_progress",
            Some("officecli create b.docx"),
        ));
        std::fs::write(root.join("b.docx"), b"b").unwrap();
        state.apply_event(&turn_complete("end_turn"));
        assert_eq!(run_all(&mut state), vec![root.join("b.docx")]);
        assert!(!registry().by_connection.contains_key(&c));
    }

    #[test]
    fn an_extension_split_across_streamed_input_chunks_is_still_found() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        let c = conn("session-chunks");
        let mut state = SessionState::new(
            c.clone(),
            AgentType::ClaudeCode,
            Some(root.clone()),
            "win".into(),
            None,
        );
        state.apply_event(&AcpEvent::StatusChanged {
            status: ConnectionStatus::Prompting,
        });
        let mut first = tool_call("t1", "in_progress", None);
        if let AcpEvent::ToolCall { raw_input, .. } = &mut first {
            *raw_input = Some(r#"{"command":"officecli create report.do"#.into());
        }
        state.apply_event(&first);
        std::fs::write(root.join("report.docx"), b"r").unwrap();
        let mut last = settle("t1");
        if let AcpEvent::ToolCallUpdate { raw_input, .. } = &mut last {
            *raw_input = Some(r#"cx"}"#.into());
        }
        state.apply_event(&last);
        assert_eq!(run_all(&mut state), vec![root.join("report.docx")]);
        state.apply_event(&turn_complete("end_turn"));
    }

    #[test]
    fn a_title_mention_survives_a_later_title_change() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        let c = conn("session-title");
        let mut state = SessionState::new(
            c.clone(),
            AgentType::ClaudeCode,
            Some(root.clone()),
            "win".into(),
            None,
        );
        state.apply_event(&AcpEvent::StatusChanged {
            status: ConnectionStatus::Prompting,
        });
        // Input still streaming (does not parse yet); only the title names the file.
        let mut first = tool_call("t1", "in_progress", None);
        if let AcpEvent::ToolCall {
            raw_input, title, ..
        } = &mut first
        {
            *raw_input = Some(r#"{"command":"run"#.into());
            *title = "officecli create r.docx".into();
        }
        state.apply_event(&first);
        std::fs::write(root.join("r.docx"), b"r").unwrap();
        let mut last = settle("t1");
        if let AcpEvent::ToolCallUpdate {
            raw_input, title, ..
        } = &mut last
        {
            *raw_input = Some(r#""}"#.into());
            *title = Some("Done".into());
        }
        state.apply_event(&last);
        assert_eq!(run_all(&mut state), vec![root.join("r.docx")]);
        state.apply_event(&turn_complete("end_turn"));
    }

    #[test]
    fn a_cancelled_turn_publishes_nothing_more() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        let c = conn("session-cancel");
        let mut state = SessionState::new(
            c.clone(),
            AgentType::ClaudeCode,
            Some(root.clone()),
            "win".into(),
            None,
        );
        state.apply_event(&AcpEvent::StatusChanged {
            status: ConnectionStatus::Prompting,
        });
        state.apply_event(&tool_call(
            "t1",
            "in_progress",
            Some("officecli create a.pptx"),
        ));
        std::fs::write(root.join("a.pptx"), b"a").unwrap();
        state.apply_event(&turn_complete("cancelled"));
        assert!(state.turn_file_jobs.is_empty());
        assert!(!registry().by_connection.contains_key(&c));

        // Out-of-turn tool calls (the turn is over) record nothing.
        state.apply_event(&tool_call(
            "t2",
            "completed",
            Some("officecli create a.pptx"),
        ));
        assert!(state.turn_file_jobs.is_empty());
    }
}
