//! Seeing all of codeg (plan 8.1): the read-only tools every assistant has —
//! `overview`, `board_status`, `session_list`, `automation_status`,
//! `pr_status`, `usage_summary`, `activity_summary` — and the idle-time
//! usage sync behind `usage_summary`.
//!
//! Everything here is read from codeg's own records and live state, never
//! from a model, and every tool answers at once (`pr_status` reads the forge,
//! with a bound). The text is for the model: facts with their numbers and
//! ids as the pages show them, and links to the conversations.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use chrono::{DateTime, Duration, Local, NaiveDate, Utc};
use sea_orm::{ColumnTrait, EntityTrait, QueryFilter, QueryOrder, QuerySelect};
use serde_json::{json, Value};

use super::engine::{enum_str, PersonalAgentEngine};
use super::ladder;
use super::live::live_from_db_with_needs;
use super::messages::display_name;
use super::tools::ToolOutcome;
use crate::acp::manager::SessionGlance;
use crate::db::entities::conversation::{self, ConversationKind};
use crate::db::entities::folder::{self, FolderKind};
use crate::db::entities::personal_agent as agent_entity;
use crate::db::entities::personal_agent_dispatch::{
    self as dispatch_entity, DispatchMode, DispatchState,
};
use crate::db::entities::work_task::{self, WorkTaskStatus};
use crate::db::service::personal_agent_service as svc;
use crate::db::AppDatabase;
use crate::models::personal_agent_overview::Ladder;
use crate::models::personal_agent_roster::{Activity, BotLive, NeedsYou, StepLine, WorkState};

/// How many rows a list in a tool's text shows; the data has them all.
const SHOWN: usize = 12;
/// The longest a step's object is named in a line.
const STEP_TARGET_MAX: usize = 80;
/// A failed dispatch older than this no longer waits on anyone.
const FAILED_FRESH_DAYS: i64 = 3;
/// The longest a forge read for `pr_status` may take.
const PR_READ_SECS: u64 = 25;
/// How often the usage figures are caught up while nothing runs, and the
/// first time after start (plan 8.1).
pub(super) const USAGE_SYNC_EVERY: std::time::Duration = std::time::Duration::from_secs(15 * 60);
pub(super) const USAGE_SYNC_FIRST: std::time::Duration = std::time::Duration::from_secs(120);

// ── words ───────────────────────────────────────────────────────────────────

/// How long ago, in a word or two: "4 min", "2 h", "3 d".
fn ago(t: DateTime<Utc>, now: DateTime<Utc>) -> String {
    let secs = (now - t).num_seconds().max(0);
    if secs < 60 {
        "under a minute".into()
    } else if secs < 3600 {
        format!("{} min", secs / 60)
    } else if secs < 86_400 {
        let h = secs / 3600;
        let m = (secs % 3600) / 60;
        if m == 0 || h >= 10 {
            format!("{h} h")
        } else {
            format!("{h} h {m} min")
        }
    } else {
        format!("{} d", secs / 86_400)
    }
}

/// A moment on the local clock: "14:05", or "Nov 9 14:05" on another day.
fn clock(t: DateTime<Utc>) -> String {
    let local = t.with_timezone(&Local);
    if local.date_naive() == Local::now().date_naive() {
        local.format("%H:%M").to_string()
    } else {
        local.format("%b %-d %H:%M").to_string()
    }
}

/// Text safe inside a markdown link's brackets.
fn link_text(s: &str) -> String {
    let t: String = s
        .chars()
        .map(|c| match c {
            '[' | ']' => ' ',
            '\n' | '\r' => ' ',
            c => c,
        })
        .take(80)
        .collect();
    let t = t.trim();
    if t.is_empty() {
        "session".into()
    } else {
        t.to_string()
    }
}

/// A conversation's link, which opens it from the assistants page.
fn session_link(id: i32, title: &str) -> String {
    format!("[{}](codeg://session/{id})", link_text(title))
}

fn quoted(s: &str) -> String {
    let one: String = s.split_whitespace().collect::<Vec<_>>().join(" ");
    let cut: String = one.chars().take(120).collect();
    if one.chars().count() > 120 {
        format!("\"{cut}…\"")
    } else {
        format!("\"{cut}\"")
    }
}

/// A step in a few words, for a model.
pub(super) fn step_phrase(step: &StepLine) -> String {
    if step.awaiting {
        return match step.kind.as_str() {
            "question" => "waiting for the owner's answer".into(),
            _ => "waiting for the owner's approval".into(),
        };
    }
    let target = step
        .target
        .as_deref()
        .map(|t| t.chars().take(STEP_TARGET_MAX).collect::<String>());
    let with = |verb: &str| match &target {
        Some(t) => format!("{verb} {t}"),
        None => verb.to_string(),
    };
    match step.kind.as_str() {
        "think" => "thinking".into(),
        "reply" => "writing a reply".into(),
        "plan" => "planning".into(),
        "compact" => "compacting its context".into(),
        "question" => "asking a question".into(),
        "read" => with("reading"),
        "edit" => with("editing"),
        "search" => with("searching for"),
        "fetch" => with("fetching"),
        "execute" => with("running"),
        "test" => "running the tests".into(),
        "commit" => with("committing"),
        "dispatch" => with("handing work to"),
        "followup" => match step.dispatch_id {
            Some(id) => format!("following up #{id}"),
            None => "following up handed-out work".into(),
        },
        "message" => with("writing to"),
        // A tool of codeg's or another MCP server's, by its own name.
        _ => match target {
            Some(t) => {
                let tool = t.rsplit("__").next().unwrap_or(&t).trim();
                if t.starts_with("mcp__") && !tool.is_empty() {
                    format!("using {tool}")
                } else {
                    t
                }
            }
            None => "working".into(),
        },
    }
}

fn activity_phrase(a: &Activity) -> String {
    let step = step_phrase(&a.step);
    match &a.work {
        Some(w) => format!("#{} {}: {step}", w.dispatch_id, w.title),
        None => step,
    }
}

/// What waits on the owner, in words.
fn need_phrase(n: &NeedsYou) -> String {
    let text = n.text.trim();
    match n.kind.as_str() {
        "question" => format!("asks the owner: {}", quoted(text)),
        "permission" => format!("asks for approval: {}", quoted(text)),
        "plan" => "asks the owner to approve a plan".into(),
        "confirm" => format!("waits for the owner to confirm: {}", quoted(text)),
        "uncertain" => format!("does not know whether it worked: {}", quoted(text)),
        "loop" => format!("stopped a back-and-forth for the owner: {}", quoted(text)),
        "choice" => format!("asks the owner to choose: {}", quoted(text)),
        "changed" => format!("shows a change for the owner to confirm: {}", quoted(text)),
        "input" => format!("handed-out work waits for the owner's input: {text}"),
        _ => format!("waits on the owner: {}", quoted(text)),
    }
}

fn wait_phrase(kind: &str, text: &str) -> String {
    match kind {
        "permission" => format!("waits for approval: {}", quoted(text)),
        "question" => format!("asks: {}", quoted(text)),
        _ => "waits for a plan approval".into(),
    }
}

// ── what codeg has ──────────────────────────────────────────────────────────

/// Projects by folder id: a worktree is named for its project.
struct Folders {
    rows: HashMap<i32, folder::Model>,
}

impl Folders {
    async fn load(db: &AppDatabase) -> Self {
        let rows = folder::Entity::find()
            .all(&db.conn)
            .await
            .unwrap_or_default()
            .into_iter()
            .map(|f| (f.id, f))
            .collect();
        Self { rows }
    }

    /// The project a folder is (or is a worktree of); `None` outside any.
    fn project(&self, id: i32) -> Option<(i32, String)> {
        let f = self.rows.get(&id)?;
        let f = match f.parent_id {
            Some(p) => self.rows.get(&p).unwrap_or(f),
            None => f,
        };
        (f.kind == FolderKind::Regular)
            .then(|| (f.id, f.alias.clone().unwrap_or_else(|| f.name.clone())))
    }

    fn project_name(&self, id: i32) -> Option<String> {
        self.project(id).map(|(_, n)| n)
    }
}

/// Every assistant (not deleted), with its live state and all that waits on
/// the owner from it.
async fn assistants(
    engine: &PersonalAgentEngine,
) -> Vec<(agent_entity::Model, BotLive, Vec<NeedsYou>)> {
    let rows = svc::list_bots(&engine.db.conn).await.unwrap_or_default();
    let host = engine.host_ref();
    let mut out = Vec::with_capacity(rows.len());
    for row in rows {
        let (live, needs) = match &host {
            Some(h) => h.live_with_needs(&row).await,
            None => live_from_db_with_needs(&engine.db, &row).await,
        };
        out.push((row, live, needs));
    }
    out
}

/// Tasks of the board, live folders only, archived ones left out.
async fn board(db: &AppDatabase, project: Option<i32>) -> Vec<work_task::Model> {
    let mut q = work_task::Entity::find()
        .filter(work_task::Column::DeletedAt.is_null())
        .filter(work_task::Column::ArchivedAt.is_null())
        .inner_join(folder::Entity)
        .filter(folder::Column::DeletedAt.is_null());
    if let Some(p) = project {
        q = q.filter(work_task::Column::FolderId.eq(p));
    }
    q.order_by_asc(work_task::Column::SortOrder)
        .order_by_asc(work_task::Column::Id)
        .all(&db.conn)
        .await
        .unwrap_or_default()
}

/// A task waits on the owner as the sidebar badge counts it: awaiting
/// input, in review or failed, and not set aside for later.
fn task_needs_owner(t: &work_task::Model) -> bool {
    t.deferred_at.is_none()
        && matches!(
            t.status,
            WorkTaskStatus::AwaitingInput | WorkTaskStatus::Review | WorkTaskStatus::Failed
        )
}

fn task_running(t: &work_task::Model) -> bool {
    matches!(
        t.status,
        WorkTaskStatus::Preparing | WorkTaskStatus::Running | WorkTaskStatus::Merging
    )
}

/// The dispatches behind tasks and conversations, and whose they are.
struct Provenance {
    by_id: HashMap<i32, dispatch_entity::Model>,
    by_conversation: HashMap<i32, i32>,
    names: HashMap<i32, String>,
}

impl Provenance {
    async fn load(db: &AppDatabase, dispatch_ids: &[i32], conversation_ids: &[i32]) -> Self {
        let mut by_id: HashMap<i32, dispatch_entity::Model> = HashMap::new();
        if !dispatch_ids.is_empty() {
            for d in dispatch_entity::Entity::find()
                .filter(dispatch_entity::Column::Id.is_in(dispatch_ids.to_vec()))
                .all(&db.conn)
                .await
                .unwrap_or_default()
            {
                by_id.insert(d.id, d);
            }
        }
        let mut by_conversation = HashMap::new();
        if !conversation_ids.is_empty() {
            for d in dispatch_entity::Entity::find()
                .filter(dispatch_entity::Column::ConversationId.is_in(conversation_ids.to_vec()))
                .all(&db.conn)
                .await
                .unwrap_or_default()
            {
                if let Some(c) = d.conversation_id {
                    by_conversation.insert(c, d.id);
                }
                by_id.insert(d.id, d);
            }
        }
        let names = svc::list_bots(&db.conn)
            .await
            .unwrap_or_default()
            .iter()
            .map(|b| (b.id, display_name(b)))
            .collect();
        Self {
            by_id,
            by_conversation,
            names,
        }
    }

    /// "handed out by Ada as #234".
    fn by(&self, dispatch_id: Option<i32>) -> Option<String> {
        let d = self.by_id.get(&dispatch_id?)?;
        let who = d
            .bot_id
            .and_then(|b| self.names.get(&b).cloned())
            .unwrap_or_else(|| "an assistant".into());
        Some(format!("handed out by {who} as #{}", d.id))
    }

    fn of_conversation(&self, conversation_id: Option<i32>) -> Option<String> {
        self.by(conversation_id.and_then(|c| self.by_conversation.get(&c).copied()))
    }

    fn bot_of(&self, dispatch_id: Option<i32>) -> Option<i32> {
        self.by_id.get(&dispatch_id?)?.bot_id
    }
}

/// The conversations behind sessions, by id.
async fn conversations(db: &AppDatabase, ids: &[i32]) -> HashMap<i32, conversation::Model> {
    if ids.is_empty() {
        return HashMap::new();
    }
    conversation::Entity::find()
        .filter(conversation::Column::Id.is_in(ids.to_vec()))
        .all(&db.conn)
        .await
        .unwrap_or_default()
        .into_iter()
        .map(|c| (c.id, c))
        .collect()
}

/// A live session the owner might care about: not an assistant's own
/// brain, bound to a conversation that still exists.
fn owners_session(g: &SessionGlance, convs: &HashMap<i32, conversation::Model>) -> bool {
    !g.personal_agent
        && g.conversation_id
            .and_then(|c| convs.get(&c))
            .is_some_and(|c| c.deleted_at.is_none() && c.kind != ConversationKind::Personal)
}

fn task_line(
    t: &work_task::Model,
    folders: &Folders,
    prov: &Provenance,
    now: DateTime<Utc>,
) -> String {
    let mut parts = vec![format!("board task #{} {}", t.id, quoted(&t.title))];
    if let Some(p) = folders.project_name(t.folder_id) {
        parts.push(format!("in {p}"));
    }
    let rung = ladder::task_ladder(t);
    let state = match t.status {
        WorkTaskStatus::AwaitingInput if rung == Ladder::WaitingYou => {
            "waits for the owner's input".to_string()
        }
        WorkTaskStatus::Running | WorkTaskStatus::Preparing => match t.started_at {
            Some(s) => format!("running for {}", ago(s, now)),
            None => "running".into(),
        },
        WorkTaskStatus::Failed => match t.last_error.as_deref().filter(|e| !e.trim().is_empty()) {
            Some(e) => format!("failed: {}", quoted(e)),
            None => "failed".into(),
        },
        _ => rung.phrase().to_string(),
    };
    parts.push(state);
    if let Some(b) = &t.work_branch {
        parts.push(format!("branch {b}"));
    }
    if let Some(d) = ladder::diff_phrase(t) {
        parts.push(d);
    }
    if let (Some(url), _) = ladder::pr_of(t) {
        parts.push(format!("PR {url}"));
    }
    if let Some(by) = prov.by(t.personal_agent_dispatch_id) {
        parts.push(by);
    }
    parts.join(" · ")
}

fn task_json(t: &work_task::Model, folders: &Folders, prov: &Provenance) -> Value {
    let (pr_url, pr_number) = ladder::pr_of(t);
    json!({
        "id": t.id,
        "title": t.title,
        "status": t.status,
        "ladder": ladder::task_ladder(t),
        "project_id": folders.project(t.folder_id).map(|(id, _)| id),
        "project": folders.project_name(t.folder_id),
        "branch": t.work_branch,
        "additions": t.additions,
        "deletions": t.deletions,
        "files_changed": t.files_changed,
        "pr_url": pr_url,
        "pr_number": pr_number,
        "started_at": t.started_at,
        "finished_at": t.finished_at,
        "conversation_id": t.conversation_id,
        "dispatch_id": t.personal_agent_dispatch_id,
        "assistant_id": prov.bot_of(t.personal_agent_dispatch_id),
        "error": t.last_error,
    })
}

fn session_state(g: &SessionGlance, now: DateTime<Utc>) -> String {
    if let Some(w) = &g.wait {
        return format!(
            "{} (for {})",
            wait_phrase(w.kind, &w.text),
            ago(w.since, now)
        );
    }
    if g.running {
        return match g.turn_started_at {
            Some(t) => format!("running for {}", ago(t, now)),
            None => "running".into(),
        };
    }
    format!("idle, last active {} ago", ago(g.last_activity_at, now))
}

fn session_line(
    g: &SessionGlance,
    c: &conversation::Model,
    folders: &Folders,
    prov: &Provenance,
    now: DateTime<Utc>,
) -> String {
    let title = c
        .title
        .clone()
        .unwrap_or_else(|| format!("Conversation {}", c.id));
    let mut parts = vec![session_link(c.id, &title)];
    let mut where_ = vec![c.agent_type.clone()];
    if let Some(p) = folders.project_name(c.folder_id) {
        where_.push(p);
    } else if c.kind == ConversationKind::Chat {
        where_.push("chat".into());
    }
    parts.push(format!("({})", where_.join(" · ")));
    parts.push(session_state(g, now));
    if let Some(by) = prov.of_conversation(Some(c.id)) {
        parts.push(by);
    }
    parts.join(" ")
}

fn session_json(
    g: &SessionGlance,
    c: &conversation::Model,
    folders: &Folders,
    prov: &Provenance,
) -> Value {
    json!({
        "conversation_id": c.id,
        "title": c.title,
        "agent_type": c.agent_type,
        "kind": c.kind,
        "project": folders.project_name(c.folder_id),
        "link": format!("codeg://session/{}", c.id),
        "waiting": g.wait.as_ref().map(|w| json!({ "kind": w.kind, "text": w.text, "since": w.since })),
        "running": g.running,
        "turn_started_at": g.turn_started_at,
        "last_activity_at": g.last_activity_at,
        "dispatch_id": prov.by_conversation.get(&c.id),
        "updated_at": c.updated_at,
    })
}

fn lines(title: &str, rows: &[String], empty: Option<&str>) -> Option<String> {
    if rows.is_empty() {
        return empty.map(|e| format!("{title}: {e}"));
    }
    let mut out = format!("{title} ({}):", rows.len());
    for r in rows.iter().take(SHOWN) {
        out.push_str(&format!("\n- {r}"));
    }
    if rows.len() > SHOWN {
        out.push_str(&format!("\n- … and {} more", rows.len() - SHOWN));
    }
    Some(out)
}

fn int_arg(args: &Value, key: &str) -> Option<i64> {
    args.get(key).and_then(|v| {
        v.as_i64()
            .or_else(|| v.as_str()?.trim().trim_start_matches('#').parse().ok())
    })
}

fn str_arg<'a>(args: &'a Value, key: &str) -> Option<&'a str> {
    args.get(key)
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
}

// ── the tools ───────────────────────────────────────────────────────────────

impl PersonalAgentEngine {
    /// One line per assistant: its job, how it is, what it is on.
    async fn assistant_lines(
        &self,
        all: &[(agent_entity::Model, BotLive, Vec<NeedsYou>)],
    ) -> (Vec<String>, Vec<Value>) {
        let me = self.bot().await;
        let mut text = Vec::new();
        let mut data = Vec::new();
        for (row, live, needs) in all {
            let role = self.role_line(row);
            let you = if row.id == me { " (you)" } else { "" };
            let hidden = if row.hidden { " (hidden)" } else { "" };
            let mut parts = vec![format!(
                "#{} {}{you}{hidden}{}",
                row.id,
                display_name(row),
                if role.is_empty() {
                    String::new()
                } else {
                    format!(" — {role}")
                }
            )];
            let busy = live.work == WorkState::Busy;
            let state = match (&live.activity, busy) {
                (Some(a), true) => format!("working: {}", activity_phrase(a)),
                (None, true) => "working".into(),
                (_, false) if live.work == WorkState::Idle => "idle, with open matters".into(),
                _ => "nothing open".into(),
            };
            parts.push(state);
            if let Some(n) = needs.first() {
                let more = if needs.len() > 1 {
                    format!(" (+{} more)", needs.len() - 1)
                } else {
                    String::new()
                };
                parts.push(format!("{}{more}", need_phrase(n)));
            }
            if !live.work_on_hand.is_empty() {
                let hand: Vec<String> = live
                    .work_on_hand
                    .iter()
                    .map(|w| {
                        format!(
                            "#{} {} ({})",
                            w.dispatch_id,
                            quoted(&w.title),
                            w.ladder.phrase()
                        )
                    })
                    .collect();
                parts.push(format!("on hand: {}", hand.join(", ")));
            }
            if !live.awaiting.is_empty() {
                let who: Vec<String> = live.awaiting.iter().map(|a| a.to_name.clone()).collect();
                parts.push(format!("awaits a reply from {}", who.join(", ")));
            }
            if live.unread > 0 {
                parts.push(format!("{} unread for the owner", live.unread));
            }
            text.push(parts.join(" · "));
            data.push(json!({
                "id": row.id,
                "name": row.name,
                "kind": row.kind,
                "role": role,
                "hidden": row.hidden,
                "you": row.id == me,
                "work": live.work,
                "activity": live.activity.as_ref().map(activity_phrase),
                "needs": needs.iter().map(|n| json!({
                    "kind": n.kind, "text": n.text, "since": n.since, "row_id": n.row_id,
                })).collect::<Vec<_>>(),
                "work_on_hand": live.work_on_hand.iter().map(|w| json!({
                    "dispatch_id": w.dispatch_id, "title": w.title, "mode": w.mode,
                    "state": w.state, "ladder": w.ladder,
                })).collect::<Vec<_>>(),
                "awaiting": live.awaiting.iter().map(|a| json!({
                    "message_id": a.message_id, "to": a.to_name,
                })).collect::<Vec<_>>(),
                "unread": live.unread,
                "activity_known": live.activity_known,
            }));
        }
        (text, data)
    }

    /// `bot_list`: the owner's assistants, how each is and what it is on.
    pub(super) async fn bot_list_call(&self) -> ToolOutcome {
        let all = assistants(self).await;
        let (text, data) = self.assistant_lines(&all).await;
        ToolOutcome::ok(text.join("\n"), json!({ "assistants": data }))
    }

    /// `overview`: how everything stands, in one call — the assistants,
    /// what waits on the owner anywhere in codeg, and what runs.
    pub(super) async fn overview_call(&self) -> ToolOutcome {
        let now = Utc::now();
        let db = &self.db;
        let all = assistants(self).await;
        let (bot_text, bot_data) = self.assistant_lines(&all).await;
        let folders = Folders::load(db).await;
        let tasks = board(db, None).await;
        let glances = self.manager.session_glances().await;
        let conv_ids: Vec<i32> = glances.iter().filter_map(|g| g.conversation_id).collect();
        let convs = conversations(db, &conv_ids).await;
        let task_dispatches: Vec<i32> = tasks
            .iter()
            .filter_map(|t| t.personal_agent_dispatch_id)
            .collect();
        let prov = Provenance::load(db, &task_dispatches, &conv_ids).await;
        let task_conversations: HashSet<i32> =
            tasks.iter().filter_map(|t| t.conversation_id).collect();

        // What waits on the owner: each assistant's cards and asks, the
        // board's tasks, every other session — each once.
        let mut needs_text = Vec::new();
        let mut needs_data = Vec::new();
        // The handed-out work whose ask is on its assistant's line: its
        // session and its board task are not listed again.
        let asking: HashSet<i32> = all
            .iter()
            .flat_map(|(_, _, needs)| needs.iter().filter_map(|n| n.dispatch_id))
            .collect();
        for (row, _, needs) in &all {
            // A request shown where it began is the asker's: listed there.
            for n in needs.iter().filter(|n| !n.mirror) {
                needs_text.push(format!(
                    "{}: {} (for {})",
                    display_name(row),
                    need_phrase(n),
                    ago(n.since, now)
                ));
                needs_data.push(json!({
                    "source": "assistant", "assistant_id": row.id, "kind": n.kind,
                    "text": n.text, "since": n.since, "row_id": n.row_id,
                }));
            }
            // Work of its that failed lately, outside the board.
            let failed = svc::list_dispatches(
                &db.conn,
                row.id,
                &[DispatchState::Failed, DispatchState::Interrupted],
                None,
                20,
            )
            .await
            .unwrap_or_default();
            for d in failed.iter().filter(|d| {
                d.mode != DispatchMode::Task
                    && d.updated_at > now - Duration::days(FAILED_FRESH_DAYS)
            }) {
                needs_text.push(format!(
                    "{}: dispatch #{} {} failed {} ago",
                    display_name(row),
                    d.id,
                    quoted(&d.title),
                    ago(d.updated_at, now)
                ));
                needs_data.push(json!({
                    "source": "dispatch", "assistant_id": row.id, "dispatch_id": d.id,
                    "kind": "failed", "text": d.title, "since": d.updated_at,
                }));
            }
        }
        // A task asking for input asks through its session: its line stands
        // for both.
        let mut listed_conversations: HashSet<i32> = HashSet::new();
        for t in tasks.iter().filter(|t| task_needs_owner(t)) {
            // A dispatched task asking for input is its assistant's ask above.
            if t.status == WorkTaskStatus::AwaitingInput
                && t.personal_agent_dispatch_id
                    .is_some_and(|d| asking.contains(&d))
            {
                if let Some(c) = t.conversation_id {
                    listed_conversations.insert(c);
                }
                continue;
            }
            if t.status == WorkTaskStatus::AwaitingInput {
                if let Some(c) = t.conversation_id {
                    listed_conversations.insert(c);
                }
            }
            needs_text.push(task_line(t, &folders, &prov, now));
            needs_data.push(json!({ "source": "board", "task": task_json(t, &folders, &prov) }));
        }
        for g in glances
            .iter()
            .filter(|g| g.wait.is_some() && owners_session(g, &convs))
        {
            let Some(c) = g.conversation_id.and_then(|c| convs.get(&c)) else {
                continue;
            };
            // A session whose ask is listed above — its work's, its task's —
            // once; one the owner took over, or whose work moved on, is the
            // owner's session like any other.
            let dispatch_asks = prov
                .by_conversation
                .get(&c.id)
                .is_some_and(|d| asking.contains(d));
            if dispatch_asks || listed_conversations.contains(&c.id) {
                continue;
            }
            needs_text.push(format!(
                "session {}",
                session_line(g, c, &folders, &prov, now)
            ));
            needs_data.push(
                json!({ "source": "session", "session": session_json(g, c, &folders, &prov) }),
            );
        }

        // What runs.
        let running_tasks: Vec<&work_task::Model> =
            tasks.iter().filter(|t| task_running(t)).collect();
        let queued_tasks = tasks
            .iter()
            .filter(|t| matches!(t.status, WorkTaskStatus::Queued))
            .count();
        let running_sessions: Vec<(&SessionGlance, &conversation::Model)> = glances
            .iter()
            .filter(|g| g.running && g.wait.is_none() && owners_session(g, &convs))
            .filter_map(|g| {
                g.conversation_id
                    .and_then(|c| convs.get(&c))
                    .map(|c| (g, c))
            })
            .filter(|(_, c)| !task_conversations.contains(&c.id))
            .collect();
        let runs = crate::db::service::automation_service::list_active_runs(&db.conn)
            .await
            .unwrap_or_default();
        let automations: HashMap<i32, String> = if runs.is_empty() {
            HashMap::new()
        } else {
            crate::db::service::automation_service::list(&db.conn)
                .await
                .unwrap_or_default()
                .into_iter()
                .map(|a| (a.id, a.name))
                .collect()
        };
        let mut running_text = Vec::new();
        for t in &running_tasks {
            running_text.push(task_line(t, &folders, &prov, now));
        }
        for (g, c) in &running_sessions {
            running_text.push(format!(
                "session {}",
                session_line(g, c, &folders, &prov, now)
            ));
        }
        for r in &runs {
            let name = automations
                .get(&r.automation_id)
                .cloned()
                .unwrap_or_else(|| format!("automation #{}", r.automation_id));
            running_text.push(format!(
                "automation {} running{}",
                quoted(&name),
                r.started_at
                    .map(|s| format!(" for {}", ago(s, now)))
                    .unwrap_or_default()
            ));
        }

        let mut text = String::new();
        text.push_str(&format!("Assistants ({}):\n", bot_text.len()));
        for l in &bot_text {
            text.push_str(&format!("- {l}\n"));
        }
        if let Some(s) = lines("\nWaiting on the owner", &needs_text, Some("nothing")) {
            text.push_str(&s);
            text.push('\n');
        }
        if let Some(s) = lines("\nRunning", &running_text, Some("nothing")) {
            text.push_str(&s);
        }
        if queued_tasks > 0 {
            text.push_str(&format!("\n{queued_tasks} board task(s) queued."));
        }
        ToolOutcome::ok(
            text.trim().to_string(),
            json!({
                "assistants": bot_data,
                "waiting_on_owner": needs_data,
                "running": {
                    "tasks": running_tasks.iter().map(|t| task_json(t, &folders, &prov)).collect::<Vec<_>>(),
                    "sessions": running_sessions.iter().map(|(g, c)| session_json(g, c, &folders, &prov)).collect::<Vec<_>>(),
                    "automation_runs": runs.iter().map(|r| json!({
                        "automation_id": r.automation_id,
                        "name": automations.get(&r.automation_id),
                        "started_at": r.started_at,
                        "conversation_id": r.conversation_id,
                    })).collect::<Vec<_>>(),
                    "queued_tasks": queued_tasks,
                },
                "at": now,
            }),
        )
    }

    /// `board_status`: the kanban board by project and state.
    pub(super) async fn board_status_call(&self, args: &Value) -> ToolOutcome {
        let now = Utc::now();
        let db = &self.db;
        let project = int_arg(args, "project_id").and_then(|p| i32::try_from(p).ok());
        let folders = Folders::load(db).await;
        if let Some(p) = project {
            if folders.project(p).map(|(id, _)| id) != Some(p) {
                return ToolOutcome::refused(format!(
                    "#{p} is not a project; project_list gives the ids"
                ));
            }
        }
        let tasks = board(db, project).await;
        let dispatch_ids: Vec<i32> = tasks
            .iter()
            .filter_map(|t| t.personal_agent_dispatch_id)
            .collect();
        let prov = Provenance::load(db, &dispatch_ids, &[]).await;

        let mut per_project: std::collections::BTreeMap<String, HashMap<String, u32>> =
            Default::default();
        for t in &tasks {
            let p = folders
                .project_name(t.folder_id)
                .unwrap_or_else(|| "?".into());
            *per_project
                .entry(p)
                .or_default()
                .entry(enum_str(&t.status))
                .or_insert(0) += 1;
        }
        let needs: Vec<&work_task::Model> = tasks.iter().filter(|t| task_needs_owner(t)).collect();
        let running: Vec<&work_task::Model> = tasks.iter().filter(|t| task_running(t)).collect();
        let waiting_start: Vec<&work_task::Model> = tasks
            .iter()
            .filter(|t| matches!(t.status, WorkTaskStatus::Todo | WorkTaskStatus::Queued))
            .collect();
        let set_aside: Vec<&work_task::Model> = tasks
            .iter()
            .filter(|t| {
                t.deferred_at.is_some()
                    && !matches!(t.status, WorkTaskStatus::Done | WorkTaskStatus::Canceled)
            })
            .collect();
        let mut finished: Vec<&work_task::Model> = tasks
            .iter()
            .filter(|t| t.status == WorkTaskStatus::Done)
            .filter(|t| t.finished_at.is_some_and(|f| f > now - Duration::days(1)))
            .collect();
        finished.sort_by_key(|t| std::cmp::Reverse(t.finished_at));

        let mut text = String::new();
        if per_project.is_empty() {
            text.push_str("The board is empty (archived tasks aside).");
        } else {
            text.push_str("By project:");
            for (p, counts) in &per_project {
                let mut c: Vec<(&String, &u32)> = counts.iter().collect();
                c.sort();
                let c: Vec<String> = c.iter().map(|(s, n)| format!("{n} {s}")).collect();
                text.push_str(&format!("\n- {p}: {}", c.join(", ")));
            }
        }
        let render = |v: &[&work_task::Model]| -> Vec<String> {
            v.iter()
                .map(|t| task_line(t, &folders, &prov, now))
                .collect()
        };
        for (title, rows) in [
            ("Waiting on the owner", render(&needs)),
            ("Running", render(&running)),
            ("Finished in the last 24 h", render(&finished)),
            ("Set aside for later", render(&set_aside)),
        ] {
            if let Some(s) = lines(&format!("\n\n{title}"), &rows, None) {
                text.push_str(&s);
            }
        }
        if !waiting_start.is_empty() {
            text.push_str(&format!("\n\n{} to do or queued.", waiting_start.len()));
        }
        let js = |v: &[&work_task::Model]| -> Vec<Value> {
            v.iter().map(|t| task_json(t, &folders, &prov)).collect()
        };
        ToolOutcome::ok(
            text,
            json!({
                "by_project": per_project,
                "waiting_on_owner": js(&needs),
                "running": js(&running),
                "finished_24h": js(&finished),
                "set_aside": js(&set_aside),
                "to_do": js(&waiting_start),
            }),
        )
    }

    /// `session_list`: codeg's sessions — the owner's own included, the
    /// assistants' brains left out — that wait, run, or are open.
    pub(super) async fn session_list_call(&self, args: &Value) -> ToolOutcome {
        let now = Utc::now();
        let db = &self.db;
        let which = str_arg(args, "state").unwrap_or("live");
        if !matches!(which, "waiting" | "running" | "live" | "recent") {
            return ToolOutcome::refused("`state` must be waiting, running, live or recent");
        }
        let limit = int_arg(args, "limit").unwrap_or(30).clamp(1, 100) as usize;
        let folders = Folders::load(db).await;
        let glances = self.manager.session_glances().await;
        let by_conv: HashMap<i32, &SessionGlance> = glances
            .iter()
            .filter_map(|g| g.conversation_id.map(|c| (c, g)))
            .collect();

        if which == "recent" {
            let since = now - Duration::hours(24);
            let rows = conversation::Entity::find()
                .filter(conversation::Column::DeletedAt.is_null())
                .filter(conversation::Column::Kind.ne(ConversationKind::Personal))
                .filter(conversation::Column::ParentId.is_null())
                .filter(conversation::Column::UpdatedAt.gte(since))
                .order_by_desc(conversation::Column::UpdatedAt)
                .limit(limit as u64)
                .all(&db.conn)
                .await
                .unwrap_or_default();
            let ids: Vec<i32> = rows.iter().map(|c| c.id).collect();
            let prov = Provenance::load(db, &[], &ids).await;
            let mut text_rows = Vec::new();
            let mut data = Vec::new();
            for c in &rows {
                let title = c
                    .title
                    .clone()
                    .unwrap_or_else(|| format!("Conversation {}", c.id));
                let state = match by_conv.get(&c.id) {
                    Some(g) => session_state(g, now),
                    None => format!("not open, last updated {} ago", ago(c.updated_at, now)),
                };
                let mut line = format!(
                    "{} ({}{}) {state}",
                    session_link(c.id, &title),
                    c.agent_type,
                    folders
                        .project_name(c.folder_id)
                        .map(|p| format!(" · {p}"))
                        .unwrap_or_default()
                );
                if let Some(by) = prov.of_conversation(Some(c.id)) {
                    line.push_str(&format!(" {by}"));
                }
                text_rows.push(line);
                data.push(json!({
                    "conversation_id": c.id, "title": c.title, "agent_type": c.agent_type,
                    "kind": c.kind, "project": folders.project_name(c.folder_id),
                    "link": format!("codeg://session/{}", c.id), "open": by_conv.contains_key(&c.id),
                    "updated_at": c.updated_at, "dispatch_id": prov.by_conversation.get(&c.id),
                }));
            }
            let text = lines(
                "Conversations active in the last 24 h",
                &text_rows,
                Some("none"),
            )
            .unwrap_or_default();
            return ToolOutcome::ok(text, json!({ "sessions": data }));
        }

        let conv_ids: Vec<i32> = glances.iter().filter_map(|g| g.conversation_id).collect();
        let convs = conversations(db, &conv_ids).await;
        let prov = Provenance::load(db, &[], &conv_ids).await;
        let mut picked: Vec<(&SessionGlance, &conversation::Model)> = glances
            .iter()
            .filter(|g| owners_session(g, &convs))
            .filter(|g| match which {
                "waiting" => g.wait.is_some(),
                "running" => g.running && g.wait.is_none(),
                _ => true,
            })
            .filter_map(|g| {
                g.conversation_id
                    .and_then(|c| convs.get(&c))
                    .map(|c| (g, c))
            })
            .collect();
        // Waiting first (longest first), then running, then the rest.
        picked.sort_by_key(|(g, _)| {
            let rank = if g.wait.is_some() {
                0
            } else if g.running {
                1
            } else {
                2
            };
            (
                rank,
                g.wait
                    .as_ref()
                    .map(|w| w.since)
                    .unwrap_or(g.last_activity_at),
            )
        });
        picked.truncate(limit);
        let rows: Vec<String> = picked
            .iter()
            .map(|(g, c)| session_line(g, c, &folders, &prov, now))
            .collect();
        let title = match which {
            "waiting" => "Sessions waiting on the owner",
            "running" => "Sessions running",
            _ => "Open sessions",
        };
        ToolOutcome::ok(
            lines(title, &rows, Some("none")).unwrap_or_default(),
            json!({
                "sessions": picked.iter().map(|(g, c)| session_json(g, c, &folders, &prov)).collect::<Vec<_>>(),
            }),
        )
    }

    /// `automation_status`: every automation, what runs, how the last run went.
    pub(super) async fn automation_status_call(&self) -> ToolOutcome {
        let now = Utc::now();
        let db = &self.db;
        let all = crate::db::service::automation_service::list(&db.conn)
            .await
            .unwrap_or_default();
        let runs = crate::db::service::automation_service::list_active_runs(&db.conn)
            .await
            .unwrap_or_default();
        let folders = Folders::load(db).await;
        if all.is_empty() {
            return ToolOutcome::ok("No automations are set up.", json!({ "automations": [] }));
        }
        let mut rows = Vec::new();
        let mut data = Vec::new();
        for a in &all {
            let mut parts = vec![format!("#{} {}", a.id, quoted(&a.name))];
            parts.push(if a.enabled { "on".into() } else { "off".into() });
            match (&a.trigger_kind, &a.cron) {
                (crate::db::entities::automation::TriggerKind::Schedule, Some(c)) => {
                    parts.push(format!("schedule `{c}` ({})", a.timezone))
                }
                _ => parts.push("run by hand".into()),
            }
            if let Some(p) = a.root_folder_id.and_then(|f| folders.project_name(f)) {
                parts.push(format!("in {p}"));
            }
            let mine: Vec<_> = runs.iter().filter(|r| r.automation_id == a.id).collect();
            for r in &mine {
                let mut s = format!(
                    "running now{}",
                    r.started_at
                        .map(|t| format!(" for {}", ago(t, now)))
                        .unwrap_or_default()
                );
                if let Some(c) = r.conversation_id {
                    s.push_str(&format!(" {}", session_link(c, &a.name)));
                }
                parts.push(s);
            }
            if a.enabled {
                if let Some(n) = a.next_run_at {
                    parts.push(format!("next run {}", clock(n)));
                }
            }
            if let Some(l) = a.last_run_at {
                parts.push(format!(
                    "last run {} ({})",
                    clock(l),
                    a.last_run_status.as_deref().unwrap_or("unknown")
                ));
            }
            if a.unseen_failures > 0 {
                parts.push(format!(
                    "{} failure(s) the owner has not seen",
                    a.unseen_failures
                ));
            }
            rows.push(parts.join(" · "));
            data.push(json!({
                "id": a.id,
                "name": a.name,
                "enabled": a.enabled,
                "trigger": a.trigger_kind,
                "cron": a.cron,
                "timezone": a.timezone,
                "next_run_at": a.next_run_at,
                "last_run_at": a.last_run_at,
                "last_run_status": a.last_run_status,
                "last_run_conversation_id": a.last_run_conversation_id,
                "unseen_failures": a.unseen_failures,
                "running": mine.iter().map(|r| json!({
                    "run_id": r.id, "started_at": r.started_at, "conversation_id": r.conversation_id,
                })).collect::<Vec<_>>(),
            }));
        }
        let running = runs.len();
        let mut text = lines("Automations", &rows, None).unwrap_or_default();
        text.push_str(&format!("\n\n{running} run(s) in progress."));
        ToolOutcome::ok(text, json!({ "automations": data }))
    }

    /// `pr_status`: a pull request's state and checks, read from its forge
    /// now (phase 1 follows no PR on its own).
    pub(super) async fn pr_status_call(&self, args: &Value) -> ToolOutcome {
        let db = &self.db;
        let task = if let Some(id) = int_arg(args, "dispatch_id") {
            let Ok(d) = i32::try_from(id) else {
                return ToolOutcome::refused("no such dispatch");
            };
            let d = match svc::get_dispatch(&db.conn, d).await.ok().flatten() {
                Some(d) => d,
                None => return ToolOutcome::refused(format!("no dispatch #{id}")),
            };
            match d.work_task_id {
                Some(t) => crate::db::service::work_task_service::get_model(&db.conn, t)
                    .await
                    .ok(),
                None => {
                    return ToolOutcome::refused(format!(
                        "dispatch #{id} is not a board task: it has no PR"
                    ))
                }
            }
        } else if let Some(id) = int_arg(args, "task_id") {
            match i32::try_from(id) {
                Ok(t) => crate::db::service::work_task_service::get_model(&db.conn, t)
                    .await
                    .ok(),
                Err(_) => None,
            }
        } else {
            None
        };
        // A task's PR is read where the task delivered it; a project and a
        // number, in the project's own repository.
        let (number, url, read) = if let Some(t) = &task {
            let (url, recorded) = ladder::pr_of(t);
            match (ladder::pr_target(t), recorded) {
                (Some((target, number)), _) => (
                    number,
                    url,
                    tokio::time::timeout(
                        std::time::Duration::from_secs(PR_READ_SECS),
                        crate::commands::forge::forge_change_detail_at_core(db, &target, number),
                    )
                    .await,
                ),
                (None, Some(number)) => (
                    number,
                    url,
                    tokio::time::timeout(
                        std::time::Duration::from_secs(PR_READ_SECS),
                        crate::commands::forge::forge_change_detail_core(
                            db,
                            t.folder_id,
                            crate::forge::ChangeQuery {
                                number,
                                account_id: None,
                            },
                        ),
                    )
                    .await,
                ),
                (None, None) => {
                    return ToolOutcome::refused(format!(
                        "board task #{} has no pull request{}",
                        t.id,
                        if url.is_some() {
                            " number on record"
                        } else {
                            ""
                        }
                    ))
                }
            }
        } else if let (Some(p), Some(n)) = (int_arg(args, "project_id"), int_arg(args, "number")) {
            let Ok(p) = i32::try_from(p) else {
                return ToolOutcome::refused("no such project");
            };
            (
                n,
                None,
                tokio::time::timeout(
                    std::time::Duration::from_secs(PR_READ_SECS),
                    crate::commands::forge::forge_change_detail_core(
                        db,
                        p,
                        crate::forge::ChangeQuery {
                            number: n,
                            account_id: None,
                        },
                    ),
                )
                .await,
            )
        } else if int_arg(args, "dispatch_id").is_some() || int_arg(args, "task_id").is_some() {
            return ToolOutcome::refused("no such board task");
        } else {
            return ToolOutcome::refused(
                "name the pull request: `dispatch_id` or `task_id` of the work that made it, or `project_id` and `number`",
            );
        };
        let detail = match read {
            Err(_) => {
                return ToolOutcome::refused(format!(
                    "the forge did not answer within {PR_READ_SECS} s"
                ))
            }
            Ok(Err(e)) => return ToolOutcome::refused(format!("could not read PR #{number}: {e}")),
            Ok(Ok(d)) => d,
        };
        use crate::forge::ForgeCheckState as S;
        let count = |s: S| detail.checks.checks.iter().filter(|c| c.state == s).count();
        let failing: Vec<String> = detail
            .checks
            .checks
            .iter()
            .filter(|c| c.state == S::Failure && !c.allow_failure)
            .map(|c| c.name.clone())
            .collect();
        let mut parts = vec![format!("PR #{} is {}", detail.number, detail.state)];
        if detail.draft {
            parts.push("a draft".into());
        }
        match detail.mergeable {
            Some(true) => parts.push("mergeable".into()),
            Some(false) => parts.push(format!(
                "not mergeable{}",
                detail
                    .merge_state
                    .as_deref()
                    .map(|m| format!(" ({m})"))
                    .unwrap_or_default()
            )),
            None => {}
        }
        parts.push(format!("{} ← {}", detail.base_ref, detail.head_ref));
        if let Some(sha) = &detail.head_sha {
            parts.push(format!("head {}", sha.chars().take(9).collect::<String>()));
        }
        if !detail.checks.available {
            parts.push("checks not available".into());
        } else if detail.checks.checks.is_empty() {
            parts.push("no checks".into());
        } else {
            let pending = count(S::Queued) + count(S::Running);
            parts.push(format!(
                "checks: {} passed, {} failed, {} pending{}",
                count(S::Success),
                count(S::Failure),
                pending,
                if failing.is_empty() {
                    String::new()
                } else {
                    format!(" (failing: {})", failing.join(", "))
                }
            ));
        }
        if let (Some(a), Some(d)) = (detail.additions, detail.deletions) {
            parts.push(format!(
                "+{a} −{d}{}",
                detail
                    .changed_files
                    .map(|f| format!(" in {f} files"))
                    .unwrap_or_default()
            ));
        }
        if let Some(u) = &url {
            parts.push(u.clone());
        }
        let mut text = parts.join(" · ");
        if args.get("full").and_then(|v| v.as_bool()) == Some(true) {
            text.push_str("\n\nComments and logs in full are not available yet; the checks above are what codeg reads now.");
        }
        ToolOutcome::ok(
            text,
            json!({
                "number": detail.number,
                "url": url,
                "state": detail.state,
                "draft": detail.draft,
                "mergeable": detail.mergeable,
                "merge_state": detail.merge_state,
                "base": detail.base_ref,
                "head": detail.head_ref,
                "head_sha": detail.head_sha,
                "additions": detail.additions,
                "deletions": detail.deletions,
                "changed_files": detail.changed_files,
                "checks": detail.checks.checks.iter().map(|c| json!({
                    "name": c.name, "state": c.state, "summary": c.summary, "url": c.url,
                    "allow_failure": c.allow_failure,
                })).collect::<Vec<_>>(),
            }),
        )
    }

    /// `usage_summary`: tokens over the last days, by day, agent, project
    /// and assistant, and how fresh the figures are. Tokens only: prices are
    /// the usage page's.
    pub(super) async fn usage_summary_call(&self, args: &Value) -> ToolOutcome {
        let db = &self.db;
        let days = int_arg(args, "days").unwrap_or(7).clamp(1, 90);
        let today = Local::now().date_naive();
        let first = today - Duration::days(days - 1);
        let (since, _) = crate::db::service::day_activity_service::local_day_bounds(first);
        let now = Utc::now();
        let offset = Local::now().offset().local_minus_utc() / 60;
        let filter = crate::models::token_usage::TokenUsageFilter {
            start: Some(since),
            end: Some(now),
            bucket: crate::models::token_usage::TokenUsageBucket::Day,
            tz_offset_minutes: offset,
            ..Default::default()
        };
        let report =
            match crate::commands::token_usage::token_usage_report_core(&db.conn, filter).await {
                Ok(r) => r,
                Err(e) => {
                    return ToolOutcome::refused(format!("could not read the usage figures: {e}"))
                }
            };
        let status = crate::commands::token_usage::token_usage_status_core(&db.conn)
            .await
            .ok();

        // By assistant: its own sessions, and the work it handed out.
        let mut own_of: HashMap<i32, i32> = HashMap::new();
        let mut handed_of: HashMap<i32, i32> = HashMap::new();
        let bots = svc::list_bots(&db.conn).await.unwrap_or_default();
        for b in &bots {
            for s in svc::list_segments(&db.conn, b.id).await.unwrap_or_default() {
                if let Some(c) = s.conversation_id {
                    own_of.insert(c, b.id);
                }
            }
        }
        let dispatches = dispatch_entity::Entity::find()
            .filter(dispatch_entity::Column::UpdatedAt.gte(since))
            .all(&db.conn)
            .await
            .unwrap_or_default();
        let tasks = ladder::tasks_of(db, &dispatches).await;
        for d in &dispatches {
            let Some(bot) = d.bot_id else { continue };
            if let Some(c) = d.conversation_id {
                handed_of.insert(c, bot);
            }
            if let Some(c) = d
                .work_task_id
                .and_then(|t| tasks.get(&t))
                .and_then(|t| t.conversation_id)
            {
                handed_of.insert(c, bot);
            }
        }
        // Work runs on in sessions of its own (a delegation's children):
        // those are the assistant's too, however deep.
        let mut frontier: Vec<i32> = own_of.keys().chain(handed_of.keys()).copied().collect();
        let mut seen: HashSet<i32> = frontier.iter().copied().collect();
        while !frontier.is_empty() {
            let mut next = Vec::new();
            for chunk in frontier.chunks(500) {
                let children = conversation::Entity::find()
                    .filter(conversation::Column::ParentId.is_in(chunk.to_vec()))
                    .all(&db.conn)
                    .await
                    .unwrap_or_default();
                for c in children {
                    let Some(parent) = c.parent_id else { continue };
                    if !seen.insert(c.id) {
                        continue;
                    }
                    if let Some(b) = own_of.get(&parent).copied() {
                        own_of.insert(c.id, b);
                    } else if let Some(b) = handed_of.get(&parent).copied() {
                        handed_of.insert(c.id, b);
                    }
                    next.push(c.id);
                }
            }
            frontier = next;
        }
        // Counted as the headline is: live conversations, inside the window.
        let mut watched: Vec<i32> = Vec::new();
        let ids: Vec<i32> = seen.into_iter().collect();
        for chunk in ids.chunks(500) {
            watched.extend(
                conversation::Entity::find()
                    .filter(conversation::Column::Id.is_in(chunk.to_vec()))
                    .filter(conversation::Column::DeletedAt.is_null())
                    .all(&db.conn)
                    .await
                    .unwrap_or_default()
                    .into_iter()
                    .map(|c| c.id),
            );
        }
        let mut own_tokens: HashMap<i32, u64> = HashMap::new();
        let mut handed_tokens: HashMap<i32, u64> = HashMap::new();
        if !watched.is_empty() {
            use crate::db::entities::token_usage_turn;
            for chunk in watched.chunks(500) {
                let turns = token_usage_turn::Entity::find()
                    .filter(token_usage_turn::Column::ConversationId.is_in(chunk.to_vec()))
                    .filter(token_usage_turn::Column::OccurredAt.gte(since))
                    .filter(token_usage_turn::Column::OccurredAt.lt(now))
                    .all(&db.conn)
                    .await
                    .unwrap_or_default();
                for t in turns {
                    let tokens = u64::try_from(t.total_tokens).unwrap_or(0);
                    if let Some(b) = own_of.get(&t.conversation_id) {
                        *own_tokens.entry(*b).or_insert(0) += tokens;
                    } else if let Some(b) = handed_of.get(&t.conversation_id) {
                        *handed_tokens.entry(*b).or_insert(0) += tokens;
                    }
                }
            }
        }
        let n = |v: u64| -> String {
            let f = v as f64;
            if f >= 1e9 {
                format!("{:.2}B", f / 1e9)
            } else if f >= 1e6 {
                format!("{:.2}M", f / 1e6)
            } else if f >= 1e3 {
                format!("{:.1}K", f / 1e3)
            } else {
                v.to_string()
            }
        };
        let t = &report.totals;
        let mut text = format!(
            "Tokens from {} to now ({} day{}, local time): {} in total — input {}, output {}, cache write {}, cache read {}; {} turns in {} conversations.",
            first.format("%Y-%m-%d"),
            days,
            if days == 1 { "" } else { "s" },
            n(t.total_tokens),
            n(t.input_tokens),
            n(t.output_tokens),
            n(t.cache_creation_tokens),
            n(t.cache_read_tokens),
            t.turn_count,
            t.conversation_count,
        );
        if days > 1 {
            let by_day: Vec<String> = report
                .series
                .iter()
                .map(|p| format!("{} {}", p.bucket_key, n(p.total_tokens)))
                .collect();
            text.push_str(&format!("\nBy day: {}.", by_day.join(", ")));
        }
        let top = |v: &[crate::models::token_usage::TokenUsageBreakdownItem]| -> String {
            v.iter()
                .take(8)
                .map(|i| format!("{} {}", i.label, n(i.total_tokens)))
                .collect::<Vec<_>>()
                .join(", ")
        };
        if !report.by_agent.is_empty() {
            text.push_str(&format!("\nBy agent: {}.", top(&report.by_agent)));
        }
        if !report.by_folder.is_empty() {
            text.push_str(&format!("\nBy project: {}.", top(&report.by_folder)));
        }
        let mut assistants_total = 0u64;
        let mut by_bot = Vec::new();
        let mut by_bot_data = Vec::new();
        for b in &bots {
            let own = own_tokens.get(&b.id).copied().unwrap_or(0);
            let handed = handed_tokens.get(&b.id).copied().unwrap_or(0);
            assistants_total += own + handed;
            by_bot.push(format!(
                "{} {} (its own sessions {}, work it handed out {})",
                display_name(b),
                n(own + handed),
                n(own),
                n(handed)
            ));
            by_bot_data.push(json!({
                "assistant_id": b.id, "name": b.name, "own_tokens": own, "handed_out_tokens": handed,
            }));
        }
        let owners = t.total_tokens.saturating_sub(assistants_total);
        text.push_str(&format!(
            "\nBy assistant: {}; the rest — the owner's own sessions, automations and the board's own tasks — {}.",
            by_bot.join("; "),
            n(owners)
        ));
        let mut synced_note = String::new();
        if let Some(s) = &status {
            match s.last_synced_at {
                Some(at) => {
                    synced_note.push_str(&format!("\nThe figures are synced up to {}", clock(at)))
                }
                None => synced_note.push_str("\nThe figures have never been synced"),
            }
            if s.stale_conversations > 0 {
                synced_note.push_str(&format!(
                    "; {} conversation(s) changed since and are not counted yet",
                    s.stale_conversations
                ));
                if s.running {
                    synced_note.push_str(" (a sync is running)");
                } else if let Some(host) = self.host_ref() {
                    host.sync_usage_soon();
                    synced_note.push_str(" (a sync has started: ask again in a minute or two)");
                }
            }
            synced_note.push('.');
        }
        text.push_str(&synced_note);
        if report.truncated {
            text.push_str(
                " The range holds more turns than one reading takes: these are the first of them.",
            );
        }
        ToolOutcome::ok(
            text,
            json!({
                "since": since,
                "until": now,
                "days": days,
                "totals": report.totals,
                "by_day": report.series,
                "by_agent": report.by_agent,
                "by_project": report.by_folder,
                "by_assistant": by_bot_data,
                "rest_tokens": owners,
                "synced_at": status.as_ref().and_then(|s| s.last_synced_at),
                "stale_conversations": status.as_ref().map(|s| s.stale_conversations),
                "sync_running": status.as_ref().map(|s| s.running),
            }),
        )
    }

    /// `activity_summary`: what the owner did in codeg on a local day.
    pub(super) async fn activity_summary_call(&self, args: &Value) -> ToolOutcome {
        let today = crate::db::service::day_activity_service::local_today();
        let day = match str_arg(args, "day").unwrap_or("today") {
            "today" => today,
            "yesterday" => today - Duration::days(1),
            s => match NaiveDate::parse_from_str(s, "%Y-%m-%d") {
                Ok(d) if d <= today => d,
                Ok(_) => return ToolOutcome::refused("that day has not come yet"),
                Err(_) => {
                    return ToolOutcome::refused(
                        "`day` is today, yesterday or a date as YYYY-MM-DD",
                    )
                }
            },
        };
        let a = match crate::db::service::day_activity_service::day_activity(&self.db.conn, day, 10)
            .await
        {
            Ok(a) => a,
            Err(e) => return ToolOutcome::refused(format!("could not read the day: {e}")),
        };
        let pairs = |v: &[(String, u32)]| {
            v.iter()
                .map(|(k, n)| format!("{k} {n}"))
                .collect::<Vec<_>>()
                .join(", ")
        };
        let mut text = format!(
            "{} (local): {} conversation{} opened.",
            a.date.format("%Y-%m-%d (%A)"),
            a.total,
            if a.total == 1 { "" } else { "s" }
        );
        if a.total > 0 {
            text.push_str(&format!("\nBy agent: {}.", pairs(&a.by_agent)));
            if !a.by_project.is_empty() {
                text.push_str(&format!("\nBy project: {}.", pairs(&a.by_project)));
            }
            if a.outside_projects > 0 {
                text.push_str(&format!("\nOutside any project: {}.", a.outside_projects));
            }
            if !a.titles.is_empty() {
                text.push_str("\nLatest:");
                for t in &a.titles {
                    text.push_str(&format!("\n- {t}"));
                }
            }
        }
        ToolOutcome::ok(
            text,
            json!({
                "date": a.date.format("%Y-%m-%d").to_string(),
                "start": a.start,
                "end": a.end,
                "total": a.total,
                "by_agent": a.by_agent,
                "by_project": a.by_project,
                "outside_projects": a.outside_projects,
                "titles": a.titles,
            }),
        )
    }
}

// ── the idle-time usage sync ────────────────────────────────────────────────

impl super::host::EngineHost {
    /// Catch the usage figures up now, unless a sync runs already.
    pub fn sync_usage_soon(self: &Arc<Self>) {
        let me = self.clone();
        tokio::spawn(async move { me.sync_usage().await });
    }

    /// One incremental pass of the usage dashboard's sync, quietly: a pass
    /// already running (the usage page's) is left to finish.
    pub(super) async fn sync_usage(&self) {
        match crate::commands::token_usage::token_usage_sync_core(
            &self.db.conn,
            &self.emitter,
            crate::commands::token_usage::TokenUsageSyncMode::Incremental,
        )
        .await
        {
            Ok(r) => tracing::debug!(
                "[personal_agent] usage synced: {} conversation(s)",
                r.synced
            ),
            Err(e) => tracing::debug!("[personal_agent] usage sync skipped: {e}"),
        }
    }

    /// Every [`USAGE_SYNC_EVERY`] while no assistant is in a turn, catch the
    /// usage figures up (plan 8.1): the page syncs only when opened, and
    /// `usage_summary` should not read last week's numbers.
    pub(super) async fn usage_sync_loop(self: Arc<Self>) {
        tokio::time::sleep(USAGE_SYNC_FIRST).await;
        let mut every = tokio::time::interval(USAGE_SYNC_EVERY);
        loop {
            every.tick().await;
            let mut busy = false;
            for e in self.engines().await {
                if e.busy().await {
                    busy = true;
                    break;
                }
            }
            if !busy {
                self.sync_usage().await;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn step(kind: &str, target: Option<&str>) -> StepLine {
        StepLine {
            n: 0,
            kind: kind.into(),
            target: target.map(str::to_string),
            status: Some("in_progress".into()),
            awaiting: false,
            started_at: Utc::now(),
            added: None,
            removed: None,
            passed: None,
            failed: None,
            exit_code: None,
            hits: None,
            dispatch_id: None,
        }
    }

    #[test]
    fn a_step_reads_as_a_few_words() {
        assert_eq!(
            step_phrase(&step("edit", Some("startup.rs"))),
            "editing startup.rs"
        );
        assert_eq!(step_phrase(&step("test", None)), "running the tests");
        assert_eq!(
            step_phrase(&step("other", Some("mcp__codeg-mcp__overview"))),
            "using overview"
        );
        let mut asks = step("execute", Some("rm -rf"));
        asks.awaiting = true;
        assert_eq!(step_phrase(&asks), "waiting for the owner's approval");
        let now = Utc::now();
        assert_eq!(ago(now - Duration::minutes(14), now), "14 min");
        assert_eq!(ago(now - Duration::minutes(130), now), "2 h 10 min");
        assert_eq!(
            session_link(8, "Fix [auth]\nnow"),
            "[Fix  auth  now](codeg://session/8)"
        );
    }
}
