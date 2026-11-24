//! Track the native task and its subsequent planner run in the same SQLite
//! trajectory. A task is updated in place, including while the WAL is open.
//! The stdout log can be silent for hours and is not a liveness signal.

use super::*;
use crate::acp::session_state::{background_keepalive_max_age, SessionState};
use crate::acp::types::{
    AcpEvent, BackgroundOutstandingTask, BackgroundSettledInfo, BackgroundTaskKind,
    BACKGROUND_TASK_DESCRIPTION_MAX_CHARS,
};
use crate::web::event_bridge::{emit_with_state, EventEmitter};
use rusqlite::OptionalExtension;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::sync::RwLock;

struct Row {
    status: i32,
    task: Option<BackgroundOutstandingTask>,
    failed: bool,
    message: Option<TaskMessage>,
    arrived_while_idle: bool,
    user: bool,
    planner: bool,
    final_answer: bool,
    error: bool,
}

impl Row {
    fn read(step: &Step, session: &str, foreground: bool) -> Self {
        let task = step.task.as_ref().and_then(|task| {
            let moved = task.moved_to_background_at.as_ref()?.to_utc()?;
            if task.id.split_once('/')?.0 != session {
                return None;
            }
            let call = correlating_call(step);
            Some(BackgroundOutstandingTask {
                task_id: task.id.clone(),
                kind: if call.is_some_and(|c| c.name == "invoke_subagent") {
                    BackgroundTaskKind::Agent
                } else {
                    BackgroundTaskKind::Shell
                },
                tool_use_id: call.map(|call| call.id.clone()).filter(|id| !id.is_empty()),
                description: Some(truncate_str(
                    &task.title,
                    BACKGROUND_TASK_DESCRIPTION_MAX_CHARS,
                )),
                started_at_ms: moved.timestamp_millis(),
            })
        });
        Self {
            status: step.status,
            task,
            failed: step.exit_code().is_some_and(|code| code != 0),
            message: step
                .task_message()
                .filter(|m| m.recipient == session)
                .cloned(),
            arrived_while_idle: !foreground,
            user: step.user_input.is_some(),
            planner: step.planner_response.is_some(),
            final_answer: step.final_answer(),
            error: step
                .error_message
                .as_ref()
                .is_some_and(|e| e.should_show_user)
                || (step.planner_response.is_some() && matches!(step.status, 4..=7 | 12)),
        }
    }
}

/// Lightweight interpreted rows. Completed output bytes are read only when
/// projecting a new reply. Rows that are still running must be read again:
/// agy can add task_details and later publish the exit status at the same idx.
struct Reader {
    directory: PathBuf,
    fallback: Option<PathBuf>,
    session: String,
    epoch: DateTime<Utc>,
    conn: Option<Connection>,
    version: Option<i64>,
    next: i64,
    revisit: Vec<i64>,
    rows: BTreeMap<i64, Row>,
    yielded_before_window: bool,
    settled: HashSet<String>,
    delivered_through: i64,
    terminal_seen: HashMap<String, Instant>,
    last_tasks: Vec<BackgroundOutstandingTask>,
    last_emit: Instant,
    last_step_change_at: Instant,
}

impl Reader {
    fn new(directory: PathBuf, fallback: Option<PathBuf>, session: String) -> Self {
        let path = session_db_path(&directory, fallback.as_deref(), &session);
        let epoch = Utc::now();
        let conn = Self::open(&path);
        // A restored session has a new process. Its predecessor's unfinished
        // rows must not be reacquired or its old results announced again.
        let next = conn
            .as_ref()
            .and_then(|c| {
                c.query_row("SELECT coalesce(max(idx) + 1, 0) FROM steps", [], |r| {
                    r.get(0)
                })
                .ok()
            })
            .unwrap_or(0);
        Self {
            directory,
            fallback,
            session,
            epoch,
            conn,
            next,
            revisit: Vec::new(),
            rows: BTreeMap::new(),
            version: None,
            yielded_before_window: false,
            settled: HashSet::new(),
            delivered_through: -1,
            terminal_seen: HashMap::new(),
            last_tasks: Vec::new(),
            last_emit: Instant::now(),
            last_step_change_at: Instant::now(),
        }
    }

    fn open(path: &Path) -> Option<Connection> {
        let db = open_trajectory(path)?;
        // The history reader may need a writable file descriptor for SQLite's
        // WAL index recovery. All SQL issued by this watcher is read-only.
        db.pragma_update(None, "query_only", true).ok()?;
        Some(db)
    }

    fn refresh(&mut self, foreground: bool) -> rusqlite::Result<Option<AcpEvent>> {
        if self.conn.is_none() {
            let path = session_db_path(&self.directory, self.fallback.as_deref(), &self.session);
            self.conn = Self::open(&path);
        }
        let Some(conn) = &self.conn else {
            return Err(rusqlite::Error::InvalidQuery);
        };
        // data_version must be read on the SAME connection and before the
        // snapshot: a commit during our read then dirties the next tick.
        let version: i64 = conn.query_row("PRAGMA data_version", [], |r| r.get(0))?;
        if self.version != Some(version) {
            let tx = conn.unchecked_transaction()?;
            let end: i64 =
                tx.query_row("SELECT coalesce(max(idx) + 1, 0) FROM steps", [], |r| {
                    r.get(0)
                })?;
            let next = self.next.min(end);
            let mut updates = Vec::new();
            let mut stage = |idx: i64, bytes: Option<Vec<u8>>| {
                let step = bytes.and_then(|b| Step::decode(b.as_slice()).ok());
                // A temporarily missing file at connection start must not
                // make a restored session's old task rows live again.
                let parsed = step
                    .filter(|step| {
                        step.metadata
                            .as_ref()
                            .and_then(|m| m.created_at.as_ref())
                            .and_then(Timestamp::to_utc)
                            .is_none_or(|at| at >= self.epoch)
                    })
                    .map(|step| (step.terminal(), Row::read(&step, &self.session, foreground)));
                updates.push((idx, parsed));
            };
            {
                let mut existing =
                    tx.prepare_cached("SELECT step_payload FROM steps WHERE idx = ?1")?;
                for &idx in self.revisit.iter().filter(|&&idx| idx < next) {
                    stage(idx, existing.query_row([idx], |r| r.get(0)).optional()?);
                }
                let mut tail = tx.prepare_cached(
                    "SELECT idx, step_payload FROM steps WHERE idx >= ?1 ORDER BY idx",
                )?;
                for row in tail.query_map([next], |r| Ok((r.get(0)?, r.get(1)?)))? {
                    let (idx, bytes) = row?;
                    stage(idx, Some(bytes));
                }
            }
            tx.commit()?;
            if !updates.is_empty() || end != self.next {
                self.last_step_change_at = Instant::now();
            }
            self.revisit.clear();
            if end < self.next {
                self.rows.retain(|idx, _| *idx < end);
                self.delivered_through = self.delivered_through.min(end - 1);
            }
            self.next = end;
            for (idx, parsed) in updates {
                let Some((terminal, mut row)) = parsed else {
                    self.rows.remove(&idx);
                    continue;
                };
                if !terminal {
                    self.revisit.push(idx);
                }
                if self
                    .rows
                    .get(&idx)
                    .is_some_and(|prev| prev.arrived_while_idle)
                {
                    row.arrived_while_idle = true;
                }
                if row.task.is_some()
                    || row.message.is_some()
                    || row.planner
                    || row.user
                    || row.error
                {
                    self.rows.insert(idx, row);
                }
            }
            self.version = Some(version);
        }
        self.report(foreground, Instant::now())
    }

    fn report(&mut self, foreground: bool, now: Instant) -> rusqlite::Result<Option<AcpEvent>> {
        self.report_at(foreground, now, Utc::now())
    }

    fn report_at(
        &mut self,
        foreground: bool,
        now: Instant,
        wall_now: DateTime<Utc>,
    ) -> rusqlite::Result<Option<AcpEvent>> {
        let mut notified = HashSet::new();
        // Keep the connection after the shell exits, while the planner reads
        // its native notification and possibly runs more tools.
        let mut reading = HashMap::new();
        let mut episode = None;
        let mut replies = Vec::new();
        let mut yielded = self.yielded_before_window;
        for (&idx, row) in &self.rows {
            if row.user {
                reading.clear();
                episode = None;
                yielded = false;
            }
            if let Some(msg) = &row.message {
                notified.insert(msg.sender.as_str());
                if msg.priority == 3 {
                    reading.insert(msg.sender.as_str(), idx);
                    if yielded && !msg.id.is_empty() {
                        episode = Some((idx, msg.id.as_str(), row.arrived_while_idle));
                        yielded = false;
                    }
                }
            }
            if row.planner {
                yielded = row.final_answer;
            }
            if row.final_answer || row.error {
                reading.clear();
                if let Some((start, id, idle)) = episode.take() {
                    if idx > self.delivered_through {
                        replies.push((start, idx, id.to_owned(), idle));
                    }
                }
            }
        }

        let mut tasks = Vec::new();
        let mut settled = Vec::new();
        let max_age = background_keepalive_max_age();
        let lease = max_age.to_std().unwrap_or_default();
        let mut new_settlements = Vec::new();
        for row in self.rows.values() {
            let Some(task) = &row.task else { continue };
            let status = match row.status {
                STEP_STATUS_DONE if !row.failed => "completed",
                STEP_STATUS_DONE | STEP_STATUS_ERROR => "failed",
                4..=6 | 12 => "cancelled",
                _ => {
                    // Same bound as the Claude watcher: a command that never
                    // ends (a dev server, a watch mode) stops counting once it
                    // is older than the keep-alive, or the heartbeat below
                    // would pin the connection and any held run forever.
                    let age_ms = wall_now.timestamp_millis() - task.started_at_ms;
                    if lease.is_zero() || age_ms < max_age.num_milliseconds() {
                        tasks.push(task.clone());
                    }
                    continue;
                }
            };
            if !self.settled.contains(&task.task_id) {
                new_settlements.push(task.task_id.clone());
                settled.push(BackgroundSettledInfo {
                    task_id: task.task_id.clone(),
                    status: status.into(),
                    summary: task.description.clone(),
                    tool_use_id: task.tool_use_id.clone(),
                    result: None,
                    interim: false,
                });
            }
            let seen = *self
                .terminal_seen
                .entry(task.task_id.clone())
                .or_insert(now);
            let id = task.task_id.as_str();
            let processing = reading.get(id).is_some_and(|notice_idx| {
                now.duration_since(self.last_step_change_at) < lease
                    || self.revisit.iter().any(|idx| idx > notice_idx)
            });
            // Bounded like a running task: a follow-up that starts a command of
            // its own leaves a non-terminal row behind the notice, which must
            // not keep this finished task counted past the keep-alive.
            if status != "cancelled"
                && now.duration_since(seen) < lease
                && (processing || !notified.contains(id))
            {
                tasks.push(task.clone());
            }
        }
        let mut turns = Vec::new();
        let mut watermark = 0;
        for (start, end, id, idle) in &replies {
            if !foreground || *idle {
                let mut stmt = self.conn.as_ref().unwrap().prepare_cached(
                    "SELECT step_payload FROM steps WHERE idx > ?1 AND idx <= ?2 ORDER BY idx",
                )?;
                let mut steps = Vec::new();
                for item in stmt.query_map([start, end], |r| r.get::<_, Vec<u8>>(0))? {
                    if let Ok(step) = Step::decode(item?.as_slice()) {
                        steps.push(step);
                    }
                }
                if let Some(mut turn) = project_steps(&steps).turns.pop() {
                    turn.id = format!("agy-bg-{id}");
                    turns.push(turn);
                    watermark = (*end + 1) as u64;
                }
            }
        }
        if let Some((_, end, _, _)) = replies.last() {
            self.delivered_through = *end;
        }
        self.settled.extend(new_settlements);
        // An unchanged, healthy DB still confirms a silent task on this live
        // connection. Refresh the bounded sweep lease without sending a UI
        // event on every poll.
        let heartbeat = (lease / 2).min(Duration::from_secs(30));
        let emit = self.last_tasks != tasks
            || !settled.is_empty()
            || !turns.is_empty()
            || (!tasks.is_empty()
                && !lease.is_zero()
                && now.duration_since(self.last_emit) >= heartbeat);
        if tasks.is_empty() && self.revisit.is_empty() {
            self.rows.clear();
            self.terminal_seen.clear();
            self.settled.clear();
            self.yielded_before_window = yielded;
        }
        if !emit {
            return Ok(None);
        }
        self.last_emit = now;
        self.last_tasks.clone_from(&tasks);
        Ok(Some(AcpEvent::BackgroundActivity {
            session_id: self.session.clone(),
            outstanding: tasks.len() as u32,
            outstanding_tasks: tasks,
            settled,
            turns,
            watermark,
        }))
    }
}

pub(crate) struct Watch {
    reader: Arc<Mutex<Reader>>,
}

impl Watch {
    pub(crate) async fn start(dir: PathBuf, session: String) -> Option<Self> {
        if !crate::parsers::is_safe_subagent_id(&session) {
            return None;
        }
        let reader = tokio::task::spawn_blocking(move || {
            Reader::new(dir, default_trajectory_dir(), session)
        })
        .await
        .ok()?;
        Some(Self {
            reader: Arc::new(Mutex::new(reader)),
        })
    }

    pub(crate) async fn refresh(
        &self,
        state: &Arc<RwLock<SessionState>>,
        emitter: &EventEmitter,
        foreground: bool,
    ) -> bool {
        let reader = Arc::clone(&self.reader);
        // No connection/state lock across disk I/O. A failed read never
        // publishes an empty set or advances the last confirmed cursor.
        let Ok(Ok(event)) = tokio::task::spawn_blocking(move || {
            reader
                .lock()
                .expect("antigravity trajectory reader")
                .refresh(foreground)
        })
        .await
        else {
            return false;
        };
        if let Some(event) = event {
            emit_with_state(state, emitter, event).await;
        }
        if state.read().await.antigravity_reconcile_at.is_some() {
            state.write().await.antigravity_reconcile_at = None;
        }
        true
    }

    pub(crate) async fn before_turn_complete(
        &self,
        state: &Arc<RwLock<SessionState>>,
        emitter: &EventEmitter,
    ) {
        if self.refresh(state, emitter, true).await {
            return;
        }
        let mut state = state.write().await;
        if state.background_outstanding > 0 || !state.active_tool_calls.is_empty() {
            // An unreadable task store can hide a launch or a completion.
            // A text-only turn without outstanding tasks has no handoff.
            state.antigravity_reconcile_at.get_or_insert_with(Utc::now);
            tracing::warn!("[ACP][Antigravity] trajectory unavailable at turn end; keeping the connection for reconciliation");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn put(conn: &Connection, idx: i64, step: Step) {
        conn.execute(
            "INSERT OR REPLACE INTO steps VALUES (?1, ?2)",
            rusqlite::params![idx, step.encode_to_vec()],
        )
        .unwrap();
    }

    fn task(id: &str, status: i32) -> Step {
        Step {
            status,
            task: Some(NativeTask {
                id: format!("session/{id}"),
                title: id.into(),
                moved_to_background_at: Some(Timestamp {
                    seconds: Utc::now().timestamp(),
                    nanos: 0,
                }),
            }),
            ..Step::default()
        }
    }

    fn notification(id: &str) -> Step {
        Step {
            status: STEP_STATUS_DONE,
            system_message: Some(SystemMessage {
                kind: "task_notification".into(),
                message: Some(TaskMessage {
                    id: format!("note-{id}"),
                    recipient: "session".into(),
                    sender: format!("session/{id}"),
                    priority: 3,
                }),
            }),
            ..Step::default()
        }
    }

    fn answer(text: &str) -> Step {
        Step {
            status: STEP_STATUS_DONE,
            planner_response: Some(PlannerResponse {
                response: text.into(),
                ..Default::default()
            }),
            ..Step::default()
        }
    }

    fn db(path: &Path) -> Connection {
        let db = Connection::open(path).unwrap();
        db.execute_batch("PRAGMA journal_mode=WAL; CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_payload BLOB)").unwrap();
        db
    }

    #[test]
    fn live_wal_task_survives_turn_and_native_result_processing_then_matches_history() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("session.db");
        let writer = db(&path);
        put(&writer, 0, task("old-process", 2));
        let mut reader = Reader::new(tmp.path().into(), None, "session".into());
        put(
            &writer,
            1,
            Step {
                status: 2,
                ..Step::default()
            },
        );
        assert!(reader.refresh(true).unwrap().is_none());
        put(&writer, 1, task("test", 2)); // The launch is an in-place update.
        put(&writer, 2, answer("waiting"));
        assert!(matches!(
            reader.refresh(true).unwrap(),
            Some(AcpEvent::BackgroundActivity { outstanding: 1, .. })
        ));
        assert!(reader.refresh(false).unwrap().is_none());
        reader.last_emit -= Duration::from_secs(3601);
        assert!(matches!(
            reader.refresh(false).unwrap(),
            Some(AcpEvent::BackgroundActivity { outstanding: 1, .. })
        ));

        put(&writer, 1, task("test", STEP_STATUS_DONE));
        let Some(AcpEvent::BackgroundActivity {
            outstanding: 1,
            settled,
            ..
        }) = reader.refresh(false).unwrap()
        else {
            panic!("dropped the handoff")
        };
        assert_eq!(settled[0].status, "completed");
        put(&writer, 3, notification("test"));
        put(
            &writer,
            4,
            Step {
                status: 2,
                planner_response: Some(PlannerResponse::default()),
                ..Default::default()
            },
        );
        assert!(reader.refresh(false).unwrap().is_none());
        put(&writer, 4, answer("verified the result"));
        let Some(AcpEvent::BackgroundActivity {
            outstanding: 0,
            turns,
            settled,
            watermark,
            ..
        }) = reader.refresh(false).unwrap()
        else {
            panic!("missing autonomous reply")
        };
        assert!(settled.is_empty());
        assert_eq!(turns.len(), 1);
        let detail = AntigravityParser::with_base_dir(tmp.path().into())
            .get_conversation("session")
            .unwrap();
        assert_eq!(detail.transcript_watermark, Some(watermark));
        assert_eq!(turns[0].id, detail.turns.last().unwrap().id);
        assert!(
            matches!(&turns[0].blocks[..], [ContentBlock::Text {text}] if text == "verified the result")
        );
        assert!(reader.refresh(false).unwrap().is_none());
    }

    #[tokio::test]
    async fn an_unreadable_store_preserves_pending_work_and_releases_a_text_only_turn() {
        let tmp = tempfile::tempdir().unwrap();
        let watch = Watch {
            reader: Arc::new(Mutex::new(Reader::new(
                tmp.path().into(),
                None,
                "session".into(),
            ))),
        };
        let state = Arc::new(RwLock::new(SessionState::new(
            "connection".into(),
            AgentType::Antigravity,
            None,
            "main".into(),
            None,
        )));
        watch
            .before_turn_complete(&state, &EventEmitter::Noop)
            .await;
        assert!(state.read().await.antigravity_reconcile_at.is_none());
        state.write().await.background_outstanding = 1;
        watch
            .before_turn_complete(&state, &EventEmitter::Noop)
            .await;
        assert!(state.read().await.antigravity_reconcile_at.is_some());
    }

    #[test]
    fn late_created_native_db_in_the_default_home_is_seen_by_watch_and_history() {
        let tmp = tempfile::tempdir().unwrap();
        let configured = tmp.path().join("configured");
        let default = tmp.path().join("default");
        std::fs::create_dir(&default).unwrap();
        let mut reader = Reader::new(configured.clone(), Some(default.clone()), "session".into());
        assert!(reader.refresh(true).is_err());
        let writer = db(&default.join("session.db"));
        put(&writer, 0, task("check", 2));
        put(&writer, 1, answer("waiting"));
        assert!(matches!(
            reader.refresh(true).unwrap(),
            Some(AcpEvent::BackgroundActivity { outstanding: 1, .. })
        ));
        let parser = AntigravityParser {
            base_dir: configured.clone(),
            fallback: Some(default),
        };
        assert!(parser.get_conversation("session").is_ok());
        assert!(parser.list_conversations().unwrap().is_empty());
        std::fs::create_dir(&configured).unwrap();
        assert!(parser.list_conversations().unwrap().is_empty());
        assert!(parser.get_conversation("session").is_ok());
    }

    #[test]
    fn a_notification_without_a_follow_up_expires_and_a_running_step_holds_it_within_the_lease() {
        let tmp = tempfile::tempdir().unwrap();
        let writer = db(&tmp.path().join("session.db"));
        let mut reader = Reader::new(tmp.path().into(), None, "session".into());
        put(&writer, 0, task("check", STEP_STATUS_DONE));
        put(&writer, 1, answer("waiting"));
        put(&writer, 2, notification("check"));
        put(
            &writer,
            3,
            Step {
                status: 2,
                ..Default::default()
            },
        );
        assert!(matches!(
            reader.refresh(false).unwrap(),
            Some(AcpEvent::BackgroundActivity { outstanding: 1, .. })
        ));
        let lease = background_keepalive_max_age().to_std().unwrap();
        // The store has been quiet for longer than the lease, but the step
        // after the notice is still running: the task still counts.
        reader.last_step_change_at -= lease + Duration::from_secs(1);
        let _ = reader.report(false, Instant::now()).unwrap();
        assert_eq!(reader.last_tasks.len(), 1);
        // Not past the keep-alive, though: a row that never finishes (a
        // command the follow-up started) must not pin the finished task.
        let after_lease = Instant::now() + lease + Duration::from_secs(1);
        let _ = reader.report(false, after_lease).unwrap();
        assert!(reader.last_tasks.is_empty());
        put(
            &writer,
            3,
            Step {
                status: STEP_STATUS_DONE,
                ..Default::default()
            },
        );
        // Move the fake report clock back before doing another real read.
        reader.last_emit = Instant::now();
        reader.refresh(false).unwrap();
        assert!(matches!(
            reader
                .report(false, Instant::now() + lease + Duration::from_secs(1))
                .unwrap(),
            Some(AcpEvent::BackgroundActivity { outstanding: 0, .. })
        ));
    }

    #[test]
    fn a_command_that_never_ends_stops_counting_past_the_keepalive() {
        let tmp = tempfile::tempdir().unwrap();
        let writer = db(&tmp.path().join("session.db"));
        let mut reader = Reader::new(tmp.path().into(), None, "session".into());
        put(&writer, 0, task("dev-server", 2));
        put(&writer, 1, answer("server is up"));
        assert!(matches!(
            reader.refresh(false).unwrap(),
            Some(AcpEvent::BackgroundActivity { outstanding: 1, .. })
        ));
        let lease = background_keepalive_max_age();
        let later = Utc::now() + lease + chrono::Duration::seconds(1);
        // Still running in the store, but older than the keep-alive: dropped
        // once (no settlement — it never ended), and no heartbeat after that.
        let Some(AcpEvent::BackgroundActivity {
            outstanding: 0,
            settled,
            ..
        }) = reader.report_at(false, Instant::now(), later).unwrap()
        else {
            panic!("an expired task kept the connection")
        };
        assert!(settled.is_empty());
        reader.last_emit -= Duration::from_secs(3601);
        assert!(reader
            .report_at(false, Instant::now(), later)
            .unwrap()
            .is_none());
    }

    #[test]
    fn concurrent_failure_cancel_and_user_prompt_do_not_create_synthetic_replies() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("session.db");
        let writer = db(&path);
        let mut reader = Reader::new(tmp.path().into(), None, "session".into());
        put(&writer, 0, task("first", 2));
        put(&writer, 1, task("second", 2));
        put(&writer, 2, answer("waiting"));
        assert!(matches!(
            reader.refresh(true).unwrap(),
            Some(AcpEvent::BackgroundActivity { outstanding: 2, .. })
        ));
        put(&writer, 0, task("first", 6));
        let mut failed = task("second", STEP_STATUS_DONE);
        failed.generic_tool = Some(GenericTool {
            result: Some(GenericResult {
                render: Some(GenericRender {
                    details: Some(GenericRenderDetails {
                        command: Some(CommandResult {
                            exit_code: Some(7),
                            output: "failed".into(),
                        }),
                    }),
                }),
                ..Default::default()
            }),
        });
        put(&writer, 1, failed);
        put(&writer, 3, notification("second"));
        let Some(AcpEvent::BackgroundActivity {
            outstanding: 1,
            settled,
            ..
        }) = reader.refresh(false).unwrap()
        else {
            panic!("missing failure and cancellation")
        };
        assert_eq!(
            settled
                .iter()
                .map(|s| s.status.as_str())
                .collect::<Vec<_>>(),
            ["cancelled", "failed"]
        );
        put(
            &writer,
            4,
            Step {
                status: STEP_STATUS_DONE,
                user_input: Some(UserInput {
                    query: "new request".into(),
                    ..Default::default()
                }),
                ..Default::default()
            },
        );
        put(&writer, 5, answer("foreground reply"));
        let Some(AcpEvent::BackgroundActivity {
            outstanding: 0,
            turns,
            ..
        }) = reader.refresh(true).unwrap()
        else {
            panic!("did not release the completed tasks")
        };
        assert!(turns.is_empty());
        assert!(reader.refresh(false).unwrap().is_none());
    }
}
