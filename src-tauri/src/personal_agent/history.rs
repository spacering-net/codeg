//! The time machine (8.2): everything said and done before, searchable —
//! each assistant's timeline (the owner's messages, the replies with their
//! cards as words, results, questions with their answers, codeg's cards),
//! the messages between assistants, every conversation in codeg (the owner's
//! inputs and each turn's last answer; the assistants' own sessions are
//! their timelines) and the board's tasks.
//!
//! The timeline, the messages and the tasks are read from where they were
//! last read, before each search and every minute. The conversations are
//! read as the usage sync parses them (one pass for both), and the rest —
//! the first time, everything — while the owner is away (five minutes
//! without input) and no assistant is in a turn, a minute at a time; a
//! rebuild the owner asks for goes at once. The owner chooses whether all
//! conversations and the tasks are searched (About you); off, they leave
//! the index.
//!
//! Three characters or more are looked up in the index (FTS5 trigrams:
//! Chinese and Japanese are found by any three characters); a search of one
//! or two characters looks through the last 90 days. No model is asked:
//! `history_search` and the page's search share [`search`].

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration as StdDuration;

use chrono::{DateTime, Duration, NaiveDate, TimeZone, Utc};
use futures::stream::{self, StreamExt};
use sea_orm::{ColumnTrait, Condition, EntityTrait, QueryFilter, QueryOrder, QuerySelect};
use serde::Serialize;
use serde_json::{json, Value};

use super::clock;
use super::tools::ToolOutcome;
use super::PersonalAgentEngine;
use crate::db::entities::conversation::ConversationKind;
use crate::db::entities::personal_agent_dispatch as dispatch;
use crate::db::entities::personal_agent_message as message;
use crate::db::entities::personal_agent_timeline::{self as timeline, TimelineKind};
use crate::db::entities::{automation_run, work_task};
use crate::db::service::personal_agent_history_service::{
    self as store, Filter, Found, NewDoc, MESSAGE, SESSION, TASK, TIMELINE,
};
use crate::db::service::personal_agent_service as svc;
use crate::db::AppDatabase;
use crate::models::message::{ContentBlock, MessageTurn, TurnRole};
use crate::models::personal_agent_prefs::{AccountView, Prefs};
use crate::models::DbConversationDetail;

/// A document holds this many characters at most; a longer text is cut
/// into pieces that overlap by [`OVERLAP`], so a phrase across a cut is
/// still found.
const PIECE: usize = 4_000;
const OVERLAP: usize = 200;
/// The pieces of one text at most (256k characters): a pasted log longer
/// than that is not read on.
const PIECES_MAX: usize = 64;
/// The timeline, messages, tasks read at a time.
const ROWS_CHUNK: u64 = 500;
/// Conversations parsed at once, as the usage sync does.
const PARSE_CONCURRENCY: usize = 4;
/// How long one pass over the conversations runs while the owner is away.
const SESSIONS_PASS: StdDuration = StdDuration::from_secs(60);
/// How often the sources are read.
const HISTORY_EVERY: StdDuration = StdDuration::from_secs(60);
const HISTORY_FIRST: StdDuration = StdDuration::from_secs(120);
/// The owner is away after this long without input.
const AWAY_AFTER_MINUTES: i64 = 5;
/// A search of one or two characters looks this far back.
pub const SHORT_DAYS: i64 = 90;
/// Documents a search ranks before grouping them.
const FOUND_MAX: u64 = 500;
/// Hits a search gives by default, and at most.
pub const HITS_DEFAULT: usize = 10;
pub const HITS_MAX: usize = 50;
/// A search's characters, at most.
const QUERY_MAX: usize = 200;

pub const MARK_OPEN: char = '\u{2}';
pub const MARK_CLOSE: char = '\u{3}';

// ── the index's state, per host ─────────────────────────────────────────────

/// One reader of each kind at a time. Taken in this order: `rows`,
/// `sessions`, `write`.
#[derive(Default)]
pub struct HistoryIndex {
    /// The timeline, messages and tasks are read, or what is gone is
    /// forgotten.
    rows: tokio::sync::Mutex<()>,
    /// A pass over the conversations.
    sessions: tokio::sync::Mutex<()>,
    /// Each conversation written, and conversations forgotten: a write
    /// checks under it that they are still searched, so one parsed before
    /// the owner turned them off cannot come back after they were cleared.
    write: tokio::sync::Mutex<()>,
    /// A pass over the conversations is going.
    reading: AtomicBool,
}

// ── what a document says ────────────────────────────────────────────────────

/// `text` trimmed, in pieces of [`PIECE`] characters that overlap; none
/// when it is empty.
fn pieces(text: &str) -> Vec<String> {
    let text = text.trim();
    if text.is_empty() {
        return Vec::new();
    }
    let at: Vec<usize> = text.char_indices().map(|(i, _)| i).collect();
    let n = at.len();
    if n <= PIECE {
        return vec![text.to_string()];
    }
    let mut out = Vec::new();
    let mut start = 0;
    while out.len() < PIECES_MAX {
        let end = (start + PIECE).min(n);
        let to = if end == n { text.len() } else { at[end] };
        out.push(text[at[start]..to].to_string());
        if end == n {
            break;
        }
        start = end - OVERLAP;
    }
    out
}

/// `doc`, its body in pieces: the first keeps its part, the others add
/// `#1`, `#2`…
fn split(doc: NewDoc) -> Vec<NewDoc> {
    pieces(&doc.body)
        .into_iter()
        .enumerate()
        .map(|(k, body)| NewDoc {
            part: if k == 0 {
                doc.part.clone()
            } else {
                format!("{}#{k}", doc.part)
            },
            body,
            ..doc.clone()
        })
        .collect()
}

fn data_of(row: &timeline::Model) -> Value {
    row.data
        .as_deref()
        .and_then(|d| serde_json::from_str(d).ok())
        .unwrap_or(Value::Null)
}

/// What the owner chose for a question: the labels of their answers.
fn answer_words(answer: &Value) -> Vec<String> {
    answer
        .get("answers")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .flat_map(|i| {
                    i.get("labels")
                        .and_then(Value::as_array)
                        .into_iter()
                        .flatten()
                        .filter_map(Value::as_str)
                        .map(str::to_string)
                })
                .collect()
        })
        .unwrap_or_default()
}

/// A timeline row as it is searched; nothing when there is nothing in it to
/// find: a marker, a permission, a line for a message (the message is its
/// own document), a reply not written yet or never sent, a copy of another
/// assistant's question.
pub(super) fn timeline_doc(row: &timeline::Model, folder: Option<i32>) -> Vec<NewDoc> {
    let data = data_of(row);
    if data.get("mirror_of").is_some_and(|m| !m.is_null()) {
        return Vec::new();
    }
    let (role, body) = match row.kind {
        TimelineKind::Owner => ("owner", row.body.clone()),
        TimelineKind::Reply => {
            if svc::is_discarded(row)
                || data.get("state").and_then(Value::as_str) == Some("running")
            {
                return Vec::new();
            }
            (
                "assistant",
                super::spec_text::cards_as_text(&row.body).into_owned(),
            )
        }
        TimelineKind::Question => {
            let mut body = row.body.clone();
            let chose = data.get("answer").map(answer_words).unwrap_or_default();
            if !chose.is_empty() {
                body.push_str("\n→ ");
                body.push_str(&chose.join("; "));
            }
            ("assistant", body)
        }
        TimelineKind::Dispatch => ("assistant", row.body.clone()),
        TimelineKind::Result | TimelineKind::Notice => (
            "codeg",
            super::spec_text::cards_as_text(&row.body).into_owned(),
        ),
        TimelineKind::Marker | TimelineKind::Permission | TimelineKind::Exchange => {
            return Vec::new()
        }
    };
    split(NewDoc {
        source: TIMELINE,
        ref_id: row.id,
        part: String::new(),
        role,
        bot_id: row.bot_id,
        peer_bot_id: None,
        folder_id: folder,
        agent_type: None,
        title: None,
        body,
        weight: 3,
        at: row.created_at,
        row_id: Some(row.id),
        conversation_id: None,
    })
}

/// A message between assistants, opening at its sender's line.
fn message_doc(m: &message::Model, row: Option<i32>) -> Vec<NewDoc> {
    split(NewDoc {
        source: MESSAGE,
        ref_id: m.id,
        part: String::new(),
        role: "message",
        bot_id: Some(m.from_bot_id),
        peer_bot_id: Some(m.to_bot_id),
        folder_id: None,
        agent_type: None,
        title: None,
        body: m.body.clone(),
        weight: 2,
        at: m.created_at,
        row_id: row,
        conversation_id: None,
    })
}

/// A board task: its title, what it was asked and what came of it.
fn task_doc(t: &work_task::Model, bot: Option<i32>) -> Vec<NewDoc> {
    if t.deleted_at.is_some() {
        return Vec::new();
    }
    let config: Value = serde_json::from_str(&t.config).unwrap_or(Value::Null);
    let asked = config
        .get("display_text")
        .and_then(Value::as_str)
        .unwrap_or("");
    let mut body = t.title.trim().to_string();
    for part in [asked, t.result_summary.as_deref().unwrap_or("")] {
        let part = part.trim();
        if !part.is_empty() && part != body {
            body.push_str("\n\n");
            body.push_str(part);
        }
    }
    split(NewDoc {
        source: TASK,
        ref_id: t.id,
        part: String::new(),
        role: "task",
        bot_id: bot,
        peer_bot_id: None,
        folder_id: Some(t.folder_id),
        agent_type: config
            .get("agent_type")
            .and_then(Value::as_str)
            .map(str::to_string),
        title: Some(t.title.clone()),
        body,
        weight: 2,
        at: t.created_at,
        row_id: None,
        conversation_id: t.conversation_id,
    })
}

/// The words of a turn's text blocks.
fn texts(blocks: &[ContentBlock]) -> String {
    blocks
        .iter()
        .filter_map(|b| match b {
            ContentBlock::Text { text } => Some(text.trim()),
            _ => None,
        })
        .filter(|t| !t.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

/// What an agent's turn came to: its text after its last tool call (the
/// text before, when it ended on one).
pub(crate) fn last_answer(turn: &MessageTurn) -> String {
    let mut run: Vec<&str> = Vec::new();
    let mut before: Vec<&str> = Vec::new();
    for b in &turn.blocks {
        match b {
            ContentBlock::Text { text } => {
                if !text.trim().is_empty() {
                    run.push(text.trim());
                }
            }
            ContentBlock::Thinking { .. } => {}
            _ => {
                if !run.is_empty() {
                    before = std::mem::take(&mut run);
                }
            }
        }
    }
    if run.is_empty() {
        run = before;
    }
    run.join("\n")
}

/// Who made a conversation, as far as the search ranks it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Made {
    /// An automation's, the board's, a dispatch's, a delegation's.
    pub by_codeg: bool,
    /// The assistant that handed it out.
    pub bot: Option<i32>,
}

/// Which conversations codeg made, read once a pass.
#[derive(Default)]
pub(crate) struct Makers {
    automations: HashSet<i32>,
    tasks: HashMap<i32, Option<i32>>,
    dispatched: HashMap<i32, i32>,
}

impl Makers {
    pub(crate) async fn load(db: &AppDatabase) -> Self {
        let conn = &db.conn;
        let automations = automation_run::Entity::find()
            .select_only()
            .column(automation_run::Column::ConversationId)
            .filter(automation_run::Column::ConversationId.is_not_null())
            .into_tuple::<Option<i32>>()
            .all(conn)
            .await
            .unwrap_or_default()
            .into_iter()
            .flatten()
            .collect();
        let dispatches: Vec<(Option<i32>, Option<i32>, i32)> = dispatch::Entity::find()
            .select_only()
            .column(dispatch::Column::ConversationId)
            .column(dispatch::Column::BotId)
            .column(dispatch::Column::Id)
            .into_tuple()
            .all(conn)
            .await
            .unwrap_or_default();
        let mut dispatched = HashMap::new();
        let mut by_dispatch = HashMap::new();
        for (conv, bot, id) in &dispatches {
            if let (Some(c), Some(b)) = (conv, bot) {
                dispatched.insert(*c, *b);
            }
            by_dispatch.insert(*id, *bot);
        }
        let tasks = work_task::Entity::find()
            .select_only()
            .column(work_task::Column::ConversationId)
            .column(work_task::Column::PersonalAgentDispatchId)
            .filter(work_task::Column::ConversationId.is_not_null())
            .into_tuple::<(Option<i32>, Option<i32>)>()
            .all(conn)
            .await
            .unwrap_or_default()
            .into_iter()
            .filter_map(|(c, d)| Some((c?, d.and_then(|d| by_dispatch.get(&d).copied().flatten()))))
            .collect();
        Self {
            automations,
            tasks,
            dispatched,
        }
    }

    pub(crate) fn of(&self, id: i32, kind: &ConversationKind) -> Made {
        let task = self.tasks.get(&id);
        let bot = self
            .dispatched
            .get(&id)
            .copied()
            .or(task.copied().flatten());
        Made {
            by_codeg: matches!(kind, ConversationKind::Delegate | ConversationKind::Loop)
                || self.automations.contains(&id)
                || task.is_some()
                || self.dispatched.contains_key(&id),
            bot,
        }
    }
}

/// A conversation as it is searched: its title, each input and each turn's
/// last answer. What codeg made counts less, and its inputs are prompts,
/// not the owner's.
pub(crate) fn session_docs(detail: &DbConversationDetail, made: Made) -> Vec<NewDoc> {
    let s = &detail.summary;
    let agent = serde_json::to_value(s.agent_type)
        .ok()
        .and_then(|v| v.as_str().map(str::to_string));
    let title = s.title.as_deref().map(str::trim).filter(|t| !t.is_empty());
    let weight = if made.by_codeg { 1 } else { 2 };
    let doc = |part: String, role: &'static str, body: String, at: DateTime<Utc>| NewDoc {
        source: SESSION,
        ref_id: s.id,
        part,
        role,
        bot_id: made.bot,
        peer_bot_id: None,
        folder_id: Some(s.folder_id),
        agent_type: agent.clone(),
        title: title.map(str::to_string),
        body,
        weight,
        at,
        row_id: None,
        conversation_id: Some(s.id),
    };
    let mut out = Vec::new();
    if let Some(t) = title {
        out.extend(split(doc(
            "title".into(),
            "title",
            t.to_string(),
            s.created_at,
        )));
    }
    for (i, turn) in detail.turns.iter().enumerate() {
        let (role, body) = match turn.role {
            TurnRole::User => (
                if made.by_codeg { "prompt" } else { "owner" },
                texts(&turn.blocks),
            ),
            TurnRole::Assistant => ("agent", last_answer(turn)),
            TurnRole::System => continue,
        };
        // Positional, and unique even where a parser repeats an id.
        out.extend(split(doc(
            format!("{i}:{}", turn.id),
            role,
            body,
            turn.timestamp,
        )));
    }
    out
}

// ── reading the sources ─────────────────────────────────────────────────────

/// The account's preferences, from the primary's row.
pub async fn prefs_of(db: &AppDatabase) -> Prefs {
    match svc::primary_bot(&db.conn).await.ok().flatten() {
        Some(p) => AccountView::from_settings(&p.settings).prefs,
        None => Prefs::default(),
    }
}

/// The rows of `T` changed after `(at, id)`, oldest change first.
macro_rules! changed_after {
    ($entity:ident, $conn:expr, $after:expr) => {{
        let mut q = $entity::Entity::find();
        if let Some((at, id)) = $after {
            q = q.filter(
                Condition::any().add($entity::Column::UpdatedAt.gt(at)).add(
                    Condition::all()
                        .add($entity::Column::UpdatedAt.eq(at))
                        .add($entity::Column::Id.gt(id)),
                ),
            );
        }
        q.order_by_asc($entity::Column::UpdatedAt)
            .order_by_asc($entity::Column::Id)
            .limit(ROWS_CHUNK)
            .all($conn)
            .await
    }};
}

/// Forget what is gone (rows, messages, tasks, conversations, a deleted
/// assistant's) and what the owner no longer has searched.
pub(crate) async fn tidy(db: &AppDatabase, index: &HistoryIndex) {
    let _one = index.rows.lock().await;
    // No conversation is written while they are cleared.
    let _write = index.write.lock().await;
    let conn = &db.conn;
    let prefs = prefs_of(db).await;
    if let Err(e) = store::prune(conn).await {
        tracing::debug!("[personal_agent] history prune: {e}");
    }
    for (source, on) in [
        (SESSION, prefs.searches_sessions()),
        (TASK, prefs.searches_tasks()),
    ] {
        if !on && store::has_source(conn, source).await.unwrap_or(false) {
            let _ = store::clear_source(conn, source).await;
        }
    }
}

/// The assistants deleted: their rows and the messages they sent are not
/// searched.
async fn deleted_bots(db: &AppDatabase) -> HashSet<i32> {
    use crate::db::entities::personal_agent as agent;
    agent::Entity::find()
        .select_only()
        .column(agent::Column::Id)
        .filter(agent::Column::DeletedAt.is_not_null())
        .into_tuple::<i32>()
        .all(&db.conn)
        .await
        .unwrap_or_default()
        .into_iter()
        .collect()
}

/// Read the timeline, the messages and the tasks (when searched) from where
/// they were last read.
pub(crate) async fn read_rows(db: &AppDatabase, index: &HistoryIndex) {
    let _one = index.rows.lock().await;
    let conn = &db.conn;
    let prefs = prefs_of(db).await;
    let deleted = deleted_bots(db).await;
    // The timeline.
    loop {
        let after = store::cursor_of(conn, TIMELINE).await.ok().flatten();
        let Ok(rows) = changed_after!(timeline, conn, after) else {
            break;
        };
        let Some(last) = rows.last().map(|r| (r.updated_at, r.id)) else {
            break;
        };
        let ids: Vec<i32> = rows.iter().filter_map(|r| r.dispatch_id).collect();
        let folders: HashMap<i32, Option<i32>> = if ids.is_empty() {
            HashMap::new()
        } else {
            dispatch::Entity::find()
                .select_only()
                .column(dispatch::Column::Id)
                .column(dispatch::Column::FolderId)
                .filter(dispatch::Column::Id.is_in(ids))
                .into_tuple()
                .all(conn)
                .await
                .unwrap_or_default()
                .into_iter()
                .collect()
        };
        for r in &rows {
            let folder = r
                .dispatch_id
                .and_then(|d| folders.get(&d).copied().flatten());
            let docs = match r.bot_id {
                Some(b) if deleted.contains(&b) => Vec::new(),
                _ => timeline_doc(r, folder),
            };
            if store::replace(conn, TIMELINE, r.id, docs).await.is_err() {
                return;
            }
        }
        if store::set_cursor(conn, TIMELINE, last.0, last.1)
            .await
            .is_err()
            || (rows.len() as u64) < ROWS_CHUNK
        {
            break;
        }
    }
    // The messages, each opening at its sender's line.
    loop {
        let after = store::cursor_of(conn, MESSAGE).await.ok().flatten();
        let Ok(rows) = changed_after!(message, conn, after) else {
            break;
        };
        let Some(last) = rows.last().map(|r| (r.updated_at, r.id)) else {
            break;
        };
        let refs: Vec<String> = rows.iter().map(|m| format!("m{}", m.id)).collect();
        let lines: HashMap<(String, Option<i32>), i32> = timeline::Entity::find()
            .select_only()
            .column(timeline::Column::RefId)
            .column(timeline::Column::BotId)
            .column(timeline::Column::Id)
            .filter(timeline::Column::Kind.eq(TimelineKind::Exchange))
            .filter(timeline::Column::RefId.is_in(refs))
            .into_tuple::<(Option<String>, Option<i32>, i32)>()
            .all(conn)
            .await
            .unwrap_or_default()
            .into_iter()
            .filter_map(|(r, b, id)| Some(((r?, b), id)))
            .collect();
        for m in &rows {
            let line = lines
                .get(&(format!("m{}", m.id), Some(m.from_bot_id)))
                .copied();
            let docs = if deleted.contains(&m.from_bot_id) {
                Vec::new()
            } else {
                message_doc(m, line)
            };
            if store::replace(conn, MESSAGE, m.id, docs).await.is_err() {
                return;
            }
        }
        if store::set_cursor(conn, MESSAGE, last.0, last.1)
            .await
            .is_err()
            || (rows.len() as u64) < ROWS_CHUNK
        {
            break;
        }
    }
    // The board's tasks.
    if !prefs.searches_tasks() {
        return;
    }
    let mut by_dispatch: Option<HashMap<i32, Option<i32>>> = None;
    loop {
        let after = store::cursor_of(conn, TASK).await.ok().flatten();
        let Ok(rows) = changed_after!(work_task, conn, after) else {
            break;
        };
        let Some(last) = rows.last().map(|r| (r.updated_at, r.id)) else {
            break;
        };
        if by_dispatch.is_none() && rows.iter().any(|t| t.personal_agent_dispatch_id.is_some()) {
            by_dispatch = Some(
                dispatch::Entity::find()
                    .select_only()
                    .column(dispatch::Column::Id)
                    .column(dispatch::Column::BotId)
                    .into_tuple()
                    .all(conn)
                    .await
                    .unwrap_or_default()
                    .into_iter()
                    .collect(),
            );
        }
        for t in &rows {
            let bot = t
                .personal_agent_dispatch_id
                .and_then(|d| by_dispatch.as_ref()?.get(&d).copied().flatten());
            let docs = task_doc(t, bot);
            if store::replace(conn, TASK, t.id, docs).await.is_err() {
                return;
            }
        }
        if store::set_cursor(conn, TASK, last.0, last.1).await.is_err()
            || (rows.len() as u64) < ROWS_CHUNK
        {
            break;
        }
    }
}

/// Index one conversation as parsed — while the owner has conversations
/// searched. A transcript that came back with no turns at all (gone,
/// unreadable) keeps what was found in it before.
pub(crate) async fn index_session(
    db: &AppDatabase,
    index: &HistoryIndex,
    makers: &Makers,
    id: i32,
    updated_at: DateTime<Utc>,
    detail: &DbConversationDetail,
) {
    let conn = &db.conn;
    if detail.summary.kind == ConversationKind::Personal {
        return;
    }
    let _write = index.write.lock().await;
    if !prefs_of(db).await.searches_sessions() {
        return;
    }
    let res =
        if detail.turns.is_empty() && store::has_docs(conn, SESSION, id).await.unwrap_or(false) {
            store::stamp_session(conn, id, updated_at).await
        } else {
            let docs = session_docs(detail, makers.of(id, &detail.summary.kind));
            store::replace_session(conn, id, updated_at, docs).await
        };
    if let Err(e) = res {
        tracing::debug!("[personal_agent] history: conversation {id} not indexed: {e}");
    }
}

/// Read the conversations changed since they were read, newest first, for
/// up to `budget` (none: all of them). Whether some are left.
pub(crate) async fn read_sessions(
    db: &AppDatabase,
    index: &HistoryIndex,
    budget: Option<StdDuration>,
) -> bool {
    let Ok(_one) = index.sessions.try_lock() else {
        return true;
    };
    if !prefs_of(db).await.searches_sessions() {
        return false;
    }
    let Ok(stale) = store::stale_sessions(&db.conn).await else {
        return true;
    };
    if stale.is_empty() {
        return false;
    }
    index.reading.store(true, Ordering::Relaxed);
    struct Reading<'a>(&'a AtomicBool);
    impl Drop for Reading<'_> {
        fn drop(&mut self) {
            self.0.store(false, Ordering::Relaxed);
        }
    }
    let _reading = Reading(&index.reading);
    let makers = Makers::load(db).await;
    let deadline = budget.map(|b| std::time::Instant::now() + b);
    let total = stale.len();
    let conn = &db.conn;
    let mut parsed = stream::iter(stale.into_iter().map(|(id, at)| async move {
        let detail = crate::commands::conversations::get_folder_conversation_core(conn, id).await;
        (id, at, detail)
    }))
    .buffered(PARSE_CONCURRENCY);
    let mut done = 0;
    while let Some((id, at, detail)) = parsed.next().await {
        done += 1;
        match detail {
            Ok((detail, _)) => index_session(db, index, &makers, id, at, &detail).await,
            // Read again once it changes; until then what was found stays.
            Err(e) => {
                tracing::debug!("[personal_agent] history: conversation {id} unreadable: {e}");
                let _write = index.write.lock().await;
                if prefs_of(db).await.searches_sessions() {
                    let _ = store::stamp_session(conn, id, at).await;
                }
            }
        }
        if deadline.is_some_and(|d| std::time::Instant::now() >= d) {
            return done < total;
        }
    }
    false
}

/// The usage sync's pass indexes the conversations it parses.
pub(crate) struct IndexAsParsed<'a> {
    pub db: &'a AppDatabase,
    pub index: &'a HistoryIndex,
    pub makers: Makers,
}

#[async_trait::async_trait]
impl crate::commands::token_usage::ParsedConversation for IndexAsParsed<'_> {
    async fn parsed(&self, id: i32, updated_at: DateTime<Utc>, detail: &DbConversationDetail) {
        index_session(self.db, self.index, &self.makers, id, updated_at, detail).await;
    }
}

/// Whether the owner has been away long enough to read the conversations.
fn owner_away() -> bool {
    let p = super::presence::now_state();
    !p.present
        && p.last_active
            .is_none_or(|t| clock::now() - t >= Duration::minutes(AWAY_AFTER_MINUTES))
}

impl super::host::EngineHost {
    /// Every minute: the timeline, messages and tasks; and while the owner
    /// is away and no assistant is in a turn, the conversations.
    pub(super) async fn history_loop(self: Arc<Self>) {
        tokio::time::sleep(HISTORY_FIRST).await;
        let mut every = tokio::time::interval(HISTORY_EVERY);
        loop {
            every.tick().await;
            tidy(&self.db, &self.history).await;
            read_rows(&self.db, &self.history).await;
            if !owner_away() {
                continue;
            }
            let mut busy = false;
            for e in self.engines().await {
                if e.busy().await {
                    busy = true;
                    break;
                }
            }
            if !busy {
                read_sessions(&self.db, &self.history, Some(SESSIONS_PASS)).await;
            }
        }
    }

    /// A preference changed: what is no longer searched leaves at once.
    pub fn history_poke(self: &Arc<Self>) {
        let me = self.clone();
        tokio::spawn(async move {
            tidy(&me.db, &me.history).await;
            read_rows(&me.db, &me.history).await;
        });
    }

    /// The owner asked to build the index again: from nothing, at once.
    pub fn history_rebuild(self: &Arc<Self>) {
        let me = self.clone();
        tokio::spawn(async move {
            {
                // Not while a pass writes.
                let _rows = me.history.rows.lock().await;
                let _sessions = me.history.sessions.lock().await;
                let _write = me.history.write.lock().await;
                if let Err(e) = store::clear_all(&me.db.conn).await {
                    tracing::warn!("[personal_agent] history rebuild: {e}");
                    return;
                }
            }
            read_rows(&me.db, &me.history).await;
            read_sessions(&me.db, &me.history, None).await;
        });
    }
}

// ── how far it is ───────────────────────────────────────────────────────────

/// What the About-you page shows of the index.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct HistoryStatus {
    pub documents: u64,
    /// Conversations read as they are now, of those searched.
    pub sessions_done: u32,
    pub sessions_total: u32,
    pub sessions_on: bool,
    pub tasks_on: bool,
    /// A pass over the conversations is going.
    pub reading: bool,
}

pub async fn status(db: &AppDatabase, index: Option<&HistoryIndex>) -> HistoryStatus {
    let prefs = prefs_of(db).await;
    let (done, total) = store::session_counts(&db.conn).await.unwrap_or((0, 0));
    HistoryStatus {
        documents: store::doc_count(&db.conn).await.unwrap_or(0),
        sessions_done: done,
        sessions_total: total,
        sessions_on: prefs.searches_sessions(),
        tasks_on: prefs.searches_tasks(),
        reading: index.is_some_and(|i| i.reading.load(Ordering::Relaxed)),
    }
}

// ── the search ──────────────────────────────────────────────────────────────

/// Where a search looks.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Scope {
    #[default]
    All,
    Timeline,
    Sessions,
    Tasks,
    Messages,
}

impl Scope {
    pub fn parse(s: &str) -> Option<Self> {
        Some(match s.trim() {
            "" | "all" => Self::All,
            "timeline" => Self::Timeline,
            "sessions" => Self::Sessions,
            "tasks" => Self::Tasks,
            "messages" => Self::Messages,
            _ => return None,
        })
    }
}

#[derive(Debug, Clone, Default)]
pub struct Query {
    pub text: String,
    pub scope: Scope,
    pub since: Option<DateTime<Utc>>,
    pub project: Option<i32>,
    pub limit: usize,
    /// Timeline rows left out: the owner's messages the asking turn
    /// answers (what it asks would come back first).
    pub skip_rows: Vec<i32>,
}

/// One thing found: a timeline row, a message, a conversation (its best
/// matching part), a task.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Hit {
    pub source: String,
    pub ref_id: i32,
    /// Who said it: `owner`, `assistant`, `agent`, `codeg`, `message`,
    /// `task`, `title`, `prompt`.
    pub role: String,
    pub title: Option<String>,
    /// The words around the match, each match between `\u{2}` and `\u{3}`.
    pub excerpt: String,
    pub at: DateTime<Utc>,
    pub project_id: Option<i32>,
    pub project: Option<String>,
    pub agent_type: Option<String>,
    pub bot_id: Option<i32>,
    pub bot_name: Option<String>,
    pub peer_bot_id: Option<i32>,
    pub peer_name: Option<String>,
    pub row_id: Option<i32>,
    pub conversation_id: Option<i32>,
    /// How many of its parts matched (a conversation's turns).
    pub matches: u32,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Results {
    pub hits: Vec<Hit>,
    /// One or two characters: the last [`SHORT_DAYS`] days looked through.
    pub short: bool,
    pub status: HistoryStatus,
}

/// The words of a search: those of three characters or more go to the
/// index, the shorter ones are looked for in the text.
fn terms_of(text: &str) -> (Vec<String>, Vec<String>) {
    let mut long = Vec::new();
    let mut short = Vec::new();
    for w in text.split_whitespace() {
        let w: String = w.chars().take(QUERY_MAX).collect();
        if long.contains(&w) || short.contains(&w) {
            continue;
        }
        if w.chars().count() >= 3 {
            long.push(w);
        } else {
            short.push(w);
        }
    }
    (long, short)
}

/// Where `needle` is in `hay`, ignoring ASCII case: its byte range.
fn find_ci(hay: &str, needle: &str) -> Option<(usize, usize)> {
    if needle.is_empty() {
        return None;
    }
    let lower = hay.to_ascii_lowercase();
    let n = needle.to_ascii_lowercase();
    lower.find(&n).map(|i| (i, i + n.len()))
}

/// The words around the first of `terms` in `body`, every term marked.
fn excerpt_of(body: &str, terms: &[String]) -> String {
    const BEFORE: usize = 30;
    const AFTER: usize = 60;
    let first = terms
        .iter()
        .filter_map(|t| find_ci(body, t))
        .min_by_key(|(s, _)| *s);
    let (start, cut_head) = match first {
        Some((s, _)) => {
            let head: Vec<(usize, char)> = body[..s].char_indices().collect();
            if head.len() > BEFORE {
                (head[head.len() - BEFORE].0, true)
            } else {
                (0, false)
            }
        }
        None => (0, false),
    };
    let rest = &body[start..];
    let span = BEFORE + AFTER;
    let (window, cut_tail) = match rest.char_indices().nth(span) {
        Some((e, _)) => (&rest[..e], true),
        None => (rest, false),
    };
    let mut marked = String::new();
    let mut i = 0;
    while i < window.len() {
        let next = terms
            .iter()
            .filter_map(|t| find_ci(&window[i..], t).map(|(s, e)| (i + s, i + e)))
            .min_by_key(|(s, _)| *s);
        match next {
            Some((s, e)) => {
                marked.push_str(&window[i..s]);
                marked.push(MARK_OPEN);
                marked.push_str(&window[s..e]);
                marked.push(MARK_CLOSE);
                i = e;
            }
            None => {
                marked.push_str(&window[i..]);
                break;
            }
        }
    }
    let marked = marked.split_whitespace().collect::<Vec<_>>().join(" ");
    format!(
        "{}{marked}{}",
        if cut_head { "…" } else { "" },
        if cut_tail { "…" } else { "" }
    )
}

/// How much a document counts: how well it matched, whose it is, how long
/// ago it was.
fn score(f: &Found, now: DateTime<Utc>) -> f64 {
    let base = if f.rank < 0.0 { -f.rank } else { 1.0 };
    let weight = match f.weight {
        3.. => 1.5,
        2 => 1.0,
        _ => 0.5,
    };
    let days = (now - f.at).num_hours().max(0) as f64 / 24.0;
    base * weight / (1.0 + days / 30.0)
}

/// The search the tool and the page share: the sources caught up first
/// (where this process keeps the index), then what was found, best first, a
/// conversation once with its best part.
pub async fn search(
    db: &AppDatabase,
    index: Option<&HistoryIndex>,
    q: &Query,
) -> Result<Results, String> {
    let text: String = q.text.trim().chars().take(QUERY_MAX).collect();
    let (long, short) = terms_of(&text);
    if long.is_empty() && short.is_empty() {
        return Err("say what to look for".into());
    }
    if let Some(index) = index {
        read_rows(db, index).await;
    }
    let prefs = prefs_of(db).await;
    let now = clock::now();
    let mut sources: Vec<&'static str> = match q.scope {
        Scope::All => store::SOURCES.to_vec(),
        Scope::Timeline => vec![TIMELINE],
        Scope::Sessions => vec![SESSION],
        Scope::Tasks => vec![TASK],
        Scope::Messages => vec![MESSAGE],
    };
    sources.retain(|s| match *s {
        SESSION => prefs.searches_sessions(),
        TASK => prefs.searches_tasks(),
        _ => true,
    });
    let status = status(db, index).await;
    if sources.is_empty() {
        return Ok(Results {
            hits: Vec::new(),
            short: long.is_empty(),
            status,
        });
    }
    let folders = super::overview::Folders::load(db).await;
    let folder_ids = q.project.map(|p| folders.of_project(p));
    let short_only = long.is_empty();
    let since = if short_only {
        let floor = now - Duration::days(SHORT_DAYS);
        Some(q.since.map_or(floor, |s| s.max(floor)))
    } else {
        q.since
    };
    let filter = Filter {
        sources,
        since,
        folders: folder_ids,
    };
    let found = if short_only {
        store::search_scan(&db.conn, &short, &filter, FOUND_MAX).await
    } else {
        store::search_index(&db.conn, &long, &short, &filter, FOUND_MAX).await
    }
    .map_err(|e| format!("could not search: {e}"))?;
    let all_terms: Vec<String> = long.iter().chain(short.iter()).cloned().collect();
    // A conversation is one hit: its best part, and how many matched.
    let mut groups: Vec<(f64, Found, u32)> = Vec::new();
    let mut at: HashMap<(String, i32), usize> = HashMap::new();
    // The assistants there are: what one deleted said, or sent, does not
    // come up (it opens nowhere).
    let bots: HashMap<i32, String> = svc::list_bots(&db.conn)
        .await
        .unwrap_or_default()
        .into_iter()
        .map(|b| (b.id, super::messages::display_name(&b)))
        .collect();
    for f in found {
        if f.source == TIMELINE && q.skip_rows.contains(&f.ref_id) {
            continue;
        }
        if (f.source == TIMELINE || f.source == MESSAGE)
            && !f.bot_id.is_some_and(|b| bots.contains_key(&b))
        {
            continue;
        }
        let s = score(&f, now);
        let key = (f.source.clone(), f.ref_id);
        match at.get(&key) {
            Some(&i) => {
                let g = &mut groups[i];
                g.2 += 1;
                if s > g.0 {
                    g.0 = s;
                    g.1 = f;
                }
            }
            None => {
                at.insert(key, groups.len());
                groups.push((s, f, 1));
            }
        }
    }
    groups.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
    let limit = if q.limit == 0 {
        HITS_DEFAULT
    } else {
        q.limit.min(HITS_MAX)
    };
    groups.truncate(limit);
    let hits = groups
        .into_iter()
        .map(|(_, f, matches)| {
            let project = f.folder_id.and_then(|id| folders.project(id));
            let excerpt = match f.excerpt.as_deref() {
                Some(e) if !e.is_empty() => e.split_whitespace().collect::<Vec<_>>().join(" "),
                _ => excerpt_of(&f.body, &all_terms),
            };
            Hit {
                source: f.source,
                ref_id: f.ref_id,
                role: f.role,
                title: f.title,
                excerpt,
                at: f.at,
                project_id: project.as_ref().map(|(id, _)| *id),
                project: project.map(|(_, n)| n),
                agent_type: f.agent_type,
                bot_id: f.bot_id,
                bot_name: f.bot_id.and_then(|b| bots.get(&b).cloned()),
                peer_bot_id: f.peer_bot_id,
                peer_name: f.peer_bot_id.and_then(|b| bots.get(&b).cloned()),
                row_id: f.row_id,
                conversation_id: f.conversation_id,
                matches,
            }
        })
        .collect();
    Ok(Results {
        hits,
        short: short_only,
        status,
    })
}

/// `since` as the tool and the page take it: a date in the owner's zone
/// (from its start), or `Nd`, the last N days.
pub fn since_of(
    s: &str,
    tz: chrono_tz::Tz,
    now: DateTime<Utc>,
) -> Result<Option<DateTime<Utc>>, String> {
    let s = s.trim();
    if s.is_empty() {
        return Ok(None);
    }
    if let Some(n) = s
        .strip_suffix('d')
        .and_then(|n| n.trim().parse::<i64>().ok())
    {
        if n <= 0 || n > 3_650 {
            return Err("`since` as days is 1d to 3650d".into());
        }
        return Ok(Some(now - Duration::days(n)));
    }
    let day = NaiveDate::parse_from_str(s, "%Y-%m-%d")
        .map_err(|_| "`since` is a date as YYYY-MM-DD or a number of days as 7d".to_string())?;
    let start = day.and_hms_opt(0, 0, 0).expect("midnight");
    Ok(tz
        .from_local_datetime(&start)
        .earliest()
        .map(|t| t.with_timezone(&Utc)))
}

// ── the tool ────────────────────────────────────────────────────────────────

fn marked_as_text(e: &str) -> String {
    e.replace(MARK_OPEN, "«").replace(MARK_CLOSE, "»")
}

pub(super) fn link_text(title: &str) -> String {
    title
        .chars()
        .map(|c| match c {
            '[' | ']' | '\n' | '\r' => ' ',
            c => c,
        })
        .collect::<String>()
        .trim()
        .to_string()
}

fn who(role: &str) -> &'static str {
    match role {
        "owner" => "the owner",
        "assistant" => "the assistant",
        "agent" => "the agent",
        "prompt" => "the prompt",
        "codeg" => "codeg",
        "title" => "the title",
        _ => "",
    }
}

pub(super) fn agent_label(wire: &str) -> String {
    crate::models::AgentType::from_wire(wire)
        .map(|a| a.to_string())
        .unwrap_or_else(|| wire.to_string())
}

/// The tool's answer for what was found.
pub(super) fn answer(query: &str, found: &Results, tz: chrono_tz::Tz) -> ToolOutcome {
    let when = |t: DateTime<Utc>| t.with_timezone(&tz).format("%Y-%m-%d %H:%M").to_string();
    let mut lines = Vec::new();
    for (i, h) in found.hits.iter().enumerate() {
        let mut facts: Vec<String> = Vec::new();
        if let Some(p) = &h.project {
            facts.push(format!("project {p}"));
        }
        if let Some(a) = &h.agent_type {
            facts.push(agent_label(a));
        }
        facts.push(when(h.at));
        let head = match h.source.as_str() {
            SESSION => {
                let title = h.title.as_deref().map(link_text).filter(|t| !t.is_empty());
                let title = title.unwrap_or_else(|| format!("conversation {}", h.ref_id));
                let mut head = format!("conversation [{title}](codeg://session/{})", h.ref_id);
                if let Some(b) = &h.bot_name {
                    facts.push(format!("handed out by {b}"));
                }
                if h.matches > 1 {
                    facts.push(format!("{} parts match", h.matches));
                }
                head.push_str(&format!(" — {}", facts.join(", ")));
                head
            }
            TASK => {
                let mut head = format!(
                    "task #{} \"{}\" — {}",
                    h.ref_id,
                    h.title.as_deref().unwrap_or_default().trim(),
                    facts.join(", ")
                );
                if let Some(c) = h.conversation_id {
                    head.push_str(&format!(
                        "; its session [task #{}](codeg://session/{c})",
                        h.ref_id
                    ));
                }
                head
            }
            MESSAGE => format!(
                "message from {} to {} — {}",
                h.bot_name.as_deref().unwrap_or("an assistant"),
                h.peer_name.as_deref().unwrap_or("an assistant"),
                facts.join(", ")
            ),
            _ => format!(
                "in {}'s conversation (row #{}) — {}",
                h.bot_name.as_deref().unwrap_or("an assistant"),
                h.ref_id,
                facts.join(", ")
            ),
        };
        let by = who(&h.role);
        let excerpt = marked_as_text(&h.excerpt);
        lines.push(if by.is_empty() {
            format!("{}. {head}\n   {excerpt}", i + 1)
        } else {
            format!("{}. {head}\n   {by}: {excerpt}", i + 1)
        });
    }
    let mut text = if lines.is_empty() {
        format!("Nothing found for \"{query}\".")
    } else {
        format!(
            "Found {} for \"{query}\", best first:\n{}\nRead a conversation with get_session_info when you need more, and give the owner its link.",
            found.hits.len(),
            lines.join("\n")
        )
    };
    let st = &found.status;
    if found.short {
        text.push_str(&format!(
            "\nA search of one or two characters looks through the last {SHORT_DAYS} days only."
        ));
    }
    if !st.sessions_on {
        text.push_str("\nThe owner has all conversations left out of searches (About you).");
    } else if st.sessions_done < st.sessions_total {
        text.push_str(&format!(
            "\nThe conversations are still being read: {} of {} so far, older ones may not be found yet.",
            st.sessions_done, st.sessions_total
        ));
    }
    if !st.tasks_on {
        text.push_str("\nThe owner has the board's tasks left out of searches (About you).");
    }
    ToolOutcome::ok(
        text,
        json!({ "hits": found.hits, "short": found.short, "status": st }),
    )
}

impl PersonalAgentEngine {
    /// `history_search`: what was said and done before.
    pub(super) async fn history_search_call(&self, args: &Value) -> ToolOutcome {
        let text = args
            .get("query")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_string();
        if text.is_empty() {
            return ToolOutcome::refused("`query` is required: the words to look for");
        }
        let scope = match args.get("scope").and_then(Value::as_str) {
            None => Scope::All,
            Some(s) => match Scope::parse(s) {
                Some(s) => s,
                None => {
                    return ToolOutcome::refused(
                        "`scope` is all, timeline, sessions, tasks or messages",
                    )
                }
            },
        };
        let tz = self.owner_tz().await;
        let now = clock::now();
        let since = match args.get("since").and_then(Value::as_str) {
            Some(s) => match since_of(s, tz, now) {
                Ok(s) => s,
                Err(e) => return ToolOutcome::refused(e),
            },
            None => None,
        };
        let project = args.get("project_id").and_then(|v| {
            v.as_i64()
                .or_else(|| v.as_str()?.trim().trim_start_matches('#').parse().ok())
                .and_then(|p| i32::try_from(p).ok())
        });
        let q = Query {
            text: text.clone(),
            scope,
            since,
            project,
            limit: HITS_DEFAULT,
            skip_rows: self.turn_owner_rows().await,
        };
        let host = self.host_ref();
        match search(&self.db, host.as_ref().map(|h| &h.history), &q).await {
            Ok(found) => answer(&text, &found, tz),
            Err(e) => ToolOutcome::refused(e),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(kind: TimelineKind, body: &str, data: Option<Value>) -> timeline::Model {
        let now = Utc::now();
        timeline::Model {
            id: 5,
            segment_id: None,
            batch_id: None,
            kind,
            status: None,
            body: body.into(),
            data: data.map(|d| d.to_string()),
            dispatch_id: None,
            ref_id: None,
            reply_to: None,
            read_at: None,
            event_id: None,
            seen_at: None,
            created_at: now,
            updated_at: now,
            bot_id: Some(2),
        }
    }

    fn one(docs: Vec<NewDoc>) -> NewDoc {
        assert_eq!(docs.len(), 1, "{docs:?}");
        docs.into_iter().next().unwrap()
    }

    #[test]
    fn a_timeline_row_is_found_by_its_words_and_cards_as_words() {
        let owner = one(timeline_doc(
            &row(TimelineKind::Owner, "  why PowerShell?  ", None),
            Some(4),
        ));
        assert_eq!(
            (
                owner.role,
                owner.body.as_str(),
                owner.weight,
                owner.part.as_str()
            ),
            ("owner", "why PowerShell?", 3, "")
        );
        assert_eq!(
            (owner.row_id, owner.folder_id, owner.bot_id),
            (Some(5), Some(4), Some(2))
        );
        let reply = one(timeline_doc(
            &row(
                TimelineKind::Reply,
                "done",
                Some(json!({ "state": "done" })),
            ),
            None,
        ));
        assert_eq!(reply.role, "assistant");
        for (kind, data) in [
            (TimelineKind::Reply, json!({ "state": "running" })),
            (TimelineKind::Reply, json!({ "state": "discarded" })),
            (TimelineKind::Reply, json!({ "state": "silent" })),
            (TimelineKind::Marker, json!({})),
            (TimelineKind::Exchange, json!({})),
            (
                TimelineKind::Question,
                json!({ "mirror_of": { "bot_id": 1, "row_id": 2 } }),
            ),
        ] {
            assert!(
                timeline_doc(&row(kind, "words", Some(data.clone())), None).is_empty(),
                "{kind:?} {data}"
            );
        }
        let asked = one(timeline_doc(
            &row(
                TimelineKind::Question,
                "Which shell?",
                Some(
                    json!({ "state": "answered", "answer": { "answers": [{ "question_id": "q", "labels": ["PowerShell"] }] } }),
                ),
            ),
            None,
        ));
        assert_eq!(asked.body, "Which shell?\n→ PowerShell");
        assert!(timeline_doc(&row(TimelineKind::Owner, "   ", None), None).is_empty());
    }

    #[test]
    fn a_long_text_is_kept_whole_in_pieces_that_overlap() {
        // A decision written after the first piece, and one across a cut.
        let mut long = "字".repeat(PIECE - 3);
        long.push_str("改成PowerShell");
        long.push_str(&"文".repeat(PIECE));
        long.push_str("最后的决定");
        let docs = timeline_doc(&row(TimelineKind::Owner, &long, None), None);
        assert_eq!(docs.len(), 3);
        assert_eq!(
            docs.iter().map(|d| d.part.as_str()).collect::<Vec<_>>(),
            ["", "#1", "#2"]
        );
        assert!(docs.iter().all(|d| d.body.chars().count() <= PIECE));
        assert!(
            docs.iter().any(|d| d.body.contains("改成PowerShell")),
            "across a cut"
        );
        assert!(docs.last().unwrap().body.ends_with("最后的决定"));
        let whole: usize = long.chars().count();
        let kept: usize =
            docs.iter().map(|d| d.body.chars().count()).sum::<usize>() - OVERLAP * (docs.len() - 1);
        assert_eq!(kept, whole, "nothing left out");
        // A pasted log past the last piece is not read on.
        let huge = "x".repeat(PIECE * (PIECES_MAX + 5));
        assert_eq!(pieces(&huge).len(), PIECES_MAX);
        assert!(pieces(" \n ").is_empty());
    }

    fn turn(role: TurnRole, blocks: Vec<ContentBlock>) -> MessageTurn {
        serde_json::from_value(json!({
            "id": "turn-0",
            "role": role,
            "blocks": blocks,
            "timestamp": Utc::now(),
        }))
        .unwrap()
    }

    fn text(t: &str) -> ContentBlock {
        ContentBlock::Text { text: t.into() }
    }

    fn tool() -> ContentBlock {
        serde_json::from_value(json!({ "type": "tool_use", "tool_name": "Bash", "tool_use_id": null, "input_preview": null }))
            .unwrap()
    }

    #[test]
    fn a_turn_comes_to_its_text_after_its_last_tool_call() {
        let t = turn(
            TurnRole::Assistant,
            vec![
                text("Looking."),
                tool(),
                text("Fixed: "),
                text("it was the path."),
            ],
        );
        assert_eq!(last_answer(&t), "Fixed:\nit was the path.");
        let t = turn(
            TurnRole::Assistant,
            vec![text("Running the tests."), tool()],
        );
        assert_eq!(last_answer(&t), "Running the tests.");
        let t = turn(TurnRole::Assistant, vec![tool()]);
        assert_eq!(last_answer(&t), "");
    }

    #[test]
    fn a_search_splits_into_indexed_and_scanned_words() {
        assert_eq!(
            terms_of("  打包 PowerShell 改成 x PowerShell "),
            (
                vec!["PowerShell".to_string()],
                vec!["打包".to_string(), "改成".into(), "x".into()]
            )
        );
    }

    #[test]
    fn an_excerpt_is_the_words_around_the_match_every_match_marked() {
        let body = format!(
            "{} the Windows build broke; windows again {}",
            "a ".repeat(40),
            "b ".repeat(60)
        );
        let e = excerpt_of(&body, &["windows".into()]);
        assert!(e.starts_with('…') && e.ends_with('…'), "{e}");
        assert!(
            e.contains("\u{2}Windows\u{3} build broke; \u{2}windows\u{3} again"),
            "{e}"
        );
        assert_eq!(
            excerpt_of("改了颜色", &["颜色".into()]),
            "改了\u{2}颜色\u{3}"
        );
    }

    #[test]
    fn the_newer_and_the_owners_own_count_more() {
        let now = Utc::now();
        let found = |weight: i32, days: i64, rank: f64| Found {
            id: 1,
            source: "session".into(),
            ref_id: 1,
            part: String::new(),
            role: "owner".into(),
            bot_id: None,
            peer_bot_id: None,
            folder_id: None,
            agent_type: None,
            title: None,
            body: String::new(),
            weight,
            at: now - Duration::days(days),
            row_id: None,
            conversation_id: None,
            excerpt: None,
            rank,
        };
        assert!(score(&found(2, 1, -2.0), now) > score(&found(2, 60, -2.0), now));
        assert!(score(&found(3, 1, -2.0), now) > score(&found(2, 1, -2.0), now));
        assert!(score(&found(2, 1, -2.0), now) > score(&found(1, 1, -2.0), now));
        assert!(score(&found(2, 1, -4.0), now) > score(&found(2, 1, -2.0), now));
    }

    #[test]
    fn since_is_a_date_in_the_owners_zone_or_a_number_of_days() {
        let tz: chrono_tz::Tz = "Asia/Shanghai".parse().unwrap();
        let now = Utc.with_ymd_and_hms(2026, 11, 13, 4, 0, 0).unwrap();
        assert_eq!(
            since_of("2026-11-06", tz, now).unwrap(),
            Some(Utc.with_ymd_and_hms(2026, 11, 5, 16, 0, 0).unwrap())
        );
        assert_eq!(
            since_of("7d", tz, now).unwrap(),
            Some(now - Duration::days(7))
        );
        assert_eq!(since_of(" ", tz, now).unwrap(), None);
        assert!(since_of("last week", tz, now).is_err());
        assert!(since_of("0d", tz, now).is_err());
    }
}
