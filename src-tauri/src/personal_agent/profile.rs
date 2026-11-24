//! The owner's profile (5.1–5.3, 2.11): what codeg sees of them, how they
//! answer its cards, and what they corrected — computed from codeg's own
//! records, with no model and no conversation's words.
//!
//! - **Seen** ([`observe`]): the projects they worked in over the last 7 and
//!   30 days and the agents they used — by the conversations in codeg (the
//!   assistants' own left out, a worktree counted for its project); their
//!   usual hours are [`super::presence`]'s.
//! - **Their answers** ([`reactions`]): for each kind of card, how many were
//!   raised, acted on, dismissed, muted, undone or let expire, and how soon
//!   they acted. With the `reactions` preference on, a proposal rule whose
//!   cards they keep dismissing is lowered (6.7); off, nothing is lowered
//!   and what was lowered is back.
//! - **Grades** ([`grades`]): each assistant's handed-out work over
//!   [`GRADE_DAYS`] days — how much passed the first time (one round,
//!   nothing sent back) and how long it took; and apart by who handed it
//!   out, the agent it ran on and how ([`cells`], 7.9).
//! - **Their corrections**: their hours (they win over what is learned,
//!   even with the record off), the projects codeg is not to mind. Kept
//!   until they change them; "clear" forgets what codeg learned, not them.
//!
//! The store holds only what codeg cannot read again from its records: the
//! corrections, when they cleared it, the weekly review's bookkeeping and
//! the notifications held back each day.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::LazyLock;

use chrono::{DateTime, Duration, NaiveDate, Utc};
use sea_orm::{ColumnTrait, EntityTrait, QueryFilter};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::clock;
use super::read_check::OrFailed;
use super::overview::Folders;
use super::presence::{DayHours, Hours, DAY_BREAK_HOUR};
use crate::db::entities::conversation::{self, ConversationKind};
use crate::db::entities::personal_agent_dispatch::{
    self as dispatch_entity, DispatchMode, DispatchState,
};
use crate::db::entities::personal_agent_notice::{self as notice_entity, NoticeKind, NoticeState};
use crate::db::entities::personal_agent_verification::{self as round_entity, VerificationState};
use crate::db::entities::work_task;
use crate::db::service::personal_agent_activity_service as activity;
use crate::db::service::personal_agent_profile_service as psvc;
use crate::db::AppDatabase;

/// The owner's corrections of their hours.
pub const HOURS_KEY: &str = "hours";
/// The projects codeg is not to mind.
pub const PROJECTS_KEY: &str = "projects";
/// When the owner last cleared what codeg learned.
pub const CLEARED_KEY: &str = "cleared";
/// The weekly review's bookkeeping.
pub const WEEKLY_KEY: &str = "weekly";
/// The notifications held back on one of the owner's days: `reach:<date>`.
pub const REACH_PREFIX: &str = "reach:";
/// What is seen of the owner reaches back this far.
pub const OBSERVE_DAYS: i64 = 30;
/// "Lately": the projects of the last week.
pub const RECENT_DAYS: i64 = 7;
/// Grades look back this far.
pub const GRADE_DAYS: i64 = 30;
/// The days of held-back counts kept.
pub const REACH_KEEP_DAYS: i64 = 60;
/// Projects listed, at most.
const PROJECTS_MAX: usize = 12;

fn now() -> DateTime<Utc> {
    clock::now()
}

async fn read(db: &AppDatabase, key: &str) -> Value {
    psvc::get(&db.conn, key)
        .await
        .or_failed()
        .unwrap_or(Value::Null)
}

async fn write(db: &AppDatabase, key: &str, value: &Value) -> Result<(), String> {
    psvc::set(&db.conn, key, value, now())
        .await
        .map_err(|e| e.to_string())
}

// ── the owner's hours, as they set them ─────────────────────────────────────

/// One kind of day's hours as the owner set them: minutes after the day's
/// midnight, `end` past 24:00 for a day that runs past midnight.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Span {
    pub start: u32,
    pub end: u32,
}

/// What the owner set of their hours; `None`: as learned.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct HoursSet {
    #[serde(default)]
    pub workday: Option<Span>,
    #[serde(default)]
    pub restday: Option<Span>,
}

/// `HH:MM` as minutes.
fn minutes_of(s: &str) -> Result<u32, String> {
    let t = crate::models::personal_agent_prefs::clock_of(s)
        .ok_or_else(|| format!("`{s}` is not a time (HH:MM)"))?;
    use chrono::Timelike;
    Ok(t.hour() * 60 + t.minute())
}

/// The hours `start`–`end` (`HH:MM` each) as a span of the owner's day: it
/// starts at 04:00 at the earliest (the day's break), an end at or before
/// the start is the next morning's (until 04:00), and it lasts an hour at
/// least.
pub fn span_of(start: &str, end: &str) -> Result<Span, String> {
    let s = minutes_of(start)?;
    let mut e = minutes_of(end)?;
    let day_break = DAY_BREAK_HOUR * 60;
    if s < day_break {
        return Err(format!(
            "the day starts at {DAY_BREAK_HOUR:02}:00: a start before it is the night before's"
        ));
    }
    if e <= s {
        e += 24 * 60;
    }
    if e > 24 * 60 + day_break {
        return Err(format!(
            "the day ends at {DAY_BREAK_HOUR:02}:00 the next morning at the latest"
        ));
    }
    if e - s < 60 {
        return Err("the hours last an hour at least".into());
    }
    Ok(Span { start: s, end: e })
}

pub async fn hours_set(db: &AppDatabase) -> HoursSet {
    serde_json::from_value(read(db, HOURS_KEY).await).unwrap_or_default()
}

/// Set (or, `None`, let go of) the owner's hours of `day` (`workday` or
/// `restday`).
pub async fn set_hours(
    db: &AppDatabase,
    day: &str,
    span: Option<Span>,
) -> Result<HoursSet, String> {
    let mut set = hours_set(db).await;
    match day {
        "workday" => set.workday = span,
        "restday" => set.restday = span,
        _ => return Err(format!("`{day}` is neither `workday` nor `restday`")),
    }
    write(
        db,
        HOURS_KEY,
        &serde_json::to_value(set).map_err(|e| e.to_string())?,
    )
    .await?;
    Ok(set)
}

/// The hours with the owner's corrections over what was learned.
pub fn apply(learned: Hours, set: &HoursSet) -> Hours {
    let one = |d: DayHours, s: Option<Span>| match s {
        Some(s) => DayHours {
            start: s.start,
            end: s.end,
            learned: true,
            days: d.days,
            set: true,
        },
        None => d,
    };
    Hours {
        workday: one(learned.workday, set.workday),
        restday: one(learned.restday, set.restday),
    }
}

// ── the projects codeg is not to mind ───────────────────────────────────────

pub async fn excluded(db: &AppDatabase) -> Vec<i32> {
    read(db, PROJECTS_KEY).await["excluded"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_i64().and_then(|i| i32::try_from(i).ok()))
                .collect()
        })
        .unwrap_or_default()
}

pub async fn set_excluded(db: &AppDatabase, folder_id: i32, out: bool) -> Result<Vec<i32>, String> {
    let mut list = excluded(db).await;
    list.retain(|f| *f != folder_id);
    if out {
        list.push(folder_id);
    }
    list.sort_unstable();
    write(db, PROJECTS_KEY, &json!({ "excluded": list })).await?;
    Ok(list)
}

// ── clearing ────────────────────────────────────────────────────────────────

pub async fn cleared_at(db: &AppDatabase) -> Option<DateTime<Utc>> {
    read(db, CLEARED_KEY).await["at"]
        .as_str()
        .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
        .map(|t| t.with_timezone(&Utc))
}

/// Forget what codeg learned of the owner (5.3): the minutes it noted them
/// in codeg, the rules it lowered; what it sees of projects, agents and
/// cards counts from now. Their own corrections stay.
pub async fn clear(db: &AppDatabase) -> Result<(), String> {
    activity::clear(&db.conn).await.map_err(|e| e.to_string())?;
    put_back_lowered(db).await;
    write(db, CLEARED_KEY, &json!({ "at": now().to_rfc3339() })).await
}

/// The owner's answers so far count no more (they turned the record of them
/// off or on, or cleared it): every rule codeg lowered goes back, and every
/// rule counts its dismissed cards from now (6.7).
pub async fn put_back_lowered(db: &AppDatabase) {
    for rule in super::rules::ALL {
        let _ = super::rules::reset_rule(db, rule).await;
    }
}

/// Where what is seen of the owner starts: [`OBSERVE_DAYS`] back, or when
/// they cleared it.
pub async fn seen_from(db: &AppDatabase, now: DateTime<Utc>) -> DateTime<Utc> {
    let floor = now - Duration::days(OBSERVE_DAYS);
    match cleared_at(db).await {
        Some(t) if t > floor => t,
        _ => floor,
    }
}

// ── what codeg sees ─────────────────────────────────────────────────────────

/// A project the owner worked in.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ProjectSeen {
    pub folder_id: i32,
    pub name: String,
    /// Conversations in it with activity in the last 7 / 30 days.
    pub recent: u32,
    pub sessions: u32,
    pub last_at: DateTime<Utc>,
    /// The owner asked codeg not to mind it.
    pub excluded: bool,
}

/// An agent and its share of the conversations.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct AgentShare {
    pub agent_type: String,
    pub sessions: u32,
    pub percent: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Observed {
    pub since: DateTime<Utc>,
    /// Most active first; the ones not minded among them, marked.
    pub projects: Vec<ProjectSeen>,
    pub agents: Vec<AgentShare>,
}

/// The projects and agents of the conversations with activity since
/// [`seen_from`].
pub async fn observe(db: &AppDatabase, now: DateTime<Utc>) -> Observed {
    let since = seen_from(db, now).await;
    let recent_from = (now - Duration::days(RECENT_DAYS)).max(since);
    let rows = conversation::Entity::find()
        .filter(conversation::Column::DeletedAt.is_null())
        .filter(conversation::Column::Kind.ne(ConversationKind::Personal))
        .filter(conversation::Column::UpdatedAt.gte(since))
        .all(&db.conn)
        .await
        .unwrap_or_default();
    let folders = Folders::load(db).await;
    let out: HashSet<i32> = excluded(db).await.into_iter().collect();
    let mut projects: HashMap<i32, ProjectSeen> = HashMap::new();
    let mut agents: BTreeMap<String, u32> = BTreeMap::new();
    for c in &rows {
        *agents.entry(c.agent_type.clone()).or_insert(0) += 1;
        let Some((id, name)) = folders.project(c.folder_id) else {
            continue;
        };
        let p = projects.entry(id).or_insert_with(|| ProjectSeen {
            folder_id: id,
            name,
            recent: 0,
            sessions: 0,
            last_at: c.updated_at,
            excluded: out.contains(&id),
        });
        p.sessions += 1;
        if c.updated_at >= recent_from {
            p.recent += 1;
        }
        p.last_at = p.last_at.max(c.updated_at);
    }
    let mut projects: Vec<ProjectSeen> = projects.into_values().collect();
    projects.sort_by(|a, b| {
        (b.recent, b.sessions, b.last_at)
            .cmp(&(a.recent, a.sessions, a.last_at))
            .then_with(|| a.name.cmp(&b.name))
    });
    projects.truncate(PROJECTS_MAX);
    let total: u32 = agents.values().sum();
    let mut agents: Vec<AgentShare> = agents
        .into_iter()
        .map(|(agent_type, sessions)| AgentShare {
            percent: (sessions * 100 + total / 2).checked_div(total).unwrap_or(0),
            agent_type,
            sessions,
        })
        .collect();
    agents.sort_by(|a, b| {
        b.sessions
            .cmp(&a.sessions)
            .then_with(|| a.agent_type.cmp(&b.agent_type))
    });
    Observed {
        since,
        projects,
        agents,
    }
}

/// The projects the owner worked in lately, most active first — the ones
/// they asked codeg not to mind left out.
pub async fn active_projects(db: &AppDatabase, now: DateTime<Utc>) -> Vec<ProjectSeen> {
    observe(db, now)
        .await
        .projects
        .into_iter()
        .filter(|p| !p.excluded && p.recent > 0)
        .collect()
}

/// The projects the owner worked in over the last [`RECENT_DAYS`] days
/// (since they cleared it, if later), the ones they asked codeg not to
/// mind left out: what "needs you" puts first (5.2).
pub(super) async fn recent_projects(
    db: &AppDatabase,
    folders: &Folders,
    now: DateTime<Utc>,
) -> HashSet<i32> {
    let since = seen_from(db, now)
        .await
        .max(now - Duration::days(RECENT_DAYS));
    let out: HashSet<i32> = excluded(db).await.into_iter().collect();
    conversation::Entity::find()
        .filter(conversation::Column::DeletedAt.is_null())
        .filter(conversation::Column::Kind.ne(ConversationKind::Personal))
        .filter(conversation::Column::UpdatedAt.gte(since))
        .all(&db.conn)
        .await
        .or_failed()
        .iter()
        .filter_map(|c| folders.project(c.folder_id).map(|(id, _)| id))
        .filter(|id| !out.contains(id))
        .collect()
}

/// A line on the owner for the brain (5.2): the projects of the last week
/// and the agents they use; `None` with nothing seen.
pub fn owner_line(o: &Observed) -> Option<String> {
    let projects: Vec<String> = o
        .projects
        .iter()
        .filter(|p| !p.excluded && p.recent > 0)
        .take(5)
        .map(|p| format!("{} ({} conversations)", p.name, p.recent))
        .collect();
    let agents: Vec<String> = o
        .agents
        .iter()
        .take(4)
        .map(|a| {
            format!(
                "{} {}%",
                super::history::agent_label(&a.agent_type),
                a.percent
            )
        })
        .collect();
    if projects.is_empty() && agents.is_empty() {
        return None;
    }
    let mut parts = Vec::new();
    if !projects.is_empty() {
        parts.push(format!("projects this week: {}", projects.join(", ")));
    }
    if !agents.is_empty() {
        parts.push(format!("agents (30 days): {}", agents.join(", ")));
    }
    Some(parts.join(" · "))
}

// ── how the owner answers cards ─────────────────────────────────────────────

/// One kind of card, and how the owner answered it.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct CardReaction {
    pub kind: String,
    pub raised: u32,
    pub acted: u32,
    pub dismissed: u32,
    pub muted: u32,
    pub undone: u32,
    pub expired: u32,
    /// Still waiting.
    pub open: u32,
    /// How soon they acted, the median.
    pub act_minutes: Option<u32>,
}

/// The kinds of card the owner answers; the ones codeg settles itself (a
/// question an assistant answers, a brief codeg wrote) are not theirs.
const ANSWERED_KINDS: &[NoticeKind] = &[
    NoticeKind::Proposal,
    NoticeKind::Uncertain,
    NoticeKind::Loop,
    NoticeKind::Changed,
    NoticeKind::Choice,
    NoticeKind::Reminder,
    NoticeKind::Acceptance,
    NoticeKind::Forge,
    NoticeKind::Pr,
    NoticeKind::Routine,
    NoticeKind::Rule,
    NoticeKind::Memory,
    NoticeKind::Tidy,
    NoticeKind::Skill,
];

pub fn notice_kind_name(k: NoticeKind) -> &'static str {
    match k {
        NoticeKind::Proposal => "proposal",
        NoticeKind::Uncertain => "uncertain",
        NoticeKind::Stopped => "stopped",
        NoticeKind::Loop => "loop",
        NoticeKind::Changed => "changed",
        NoticeKind::Choice => "choice",
        NoticeKind::Ask => "ask",
        NoticeKind::Reminder => "reminder",
        NoticeKind::Onboarding => "onboarding",
        NoticeKind::Starter => "starter",
        NoticeKind::Acceptance => "acceptance",
        NoticeKind::Forge => "forge",
        NoticeKind::Pr => "pr",
        NoticeKind::Routine => "routine",
        NoticeKind::Rule => "rule",
        NoticeKind::Brief => "brief",
        NoticeKind::Memory => "memory",
        NoticeKind::Plan => "plan",
        NoticeKind::Tidy => "tidy",
        NoticeKind::Skill => "skill",
        NoticeKind::Check => "check",
    }
}

fn median(mut v: Vec<i64>) -> Option<u32> {
    if v.is_empty() {
        return None;
    }
    v.sort_unstable();
    u32::try_from(v[(v.len() - 1) / 2].max(0)).ok()
}

/// How the owner answered each kind of card raised in `[from, to)`.
pub fn tally(cards: &[notice_entity::Model]) -> Vec<CardReaction> {
    let mut by: BTreeMap<&'static str, (CardReaction, Vec<i64>)> = BTreeMap::new();
    for n in cards.iter().filter(|n| ANSWERED_KINDS.contains(&n.kind)) {
        let name = notice_kind_name(n.kind);
        let (r, waits) = by.entry(name).or_insert_with(|| {
            (
                CardReaction {
                    kind: name.into(),
                    ..Default::default()
                },
                Vec::new(),
            )
        });
        r.raised += 1;
        match n.state {
            NoticeState::Open => r.open += 1,
            NoticeState::Acting | NoticeState::Acted | NoticeState::Unknown => {
                r.acted += 1;
                if let Some(at) = n.acted_at {
                    waits.push((at - n.created_at).num_minutes());
                }
            }
            NoticeState::Dismissed => r.dismissed += 1,
            NoticeState::Muted => r.muted += 1,
            NoticeState::Undone => r.undone += 1,
            NoticeState::Expired => r.expired += 1,
        }
    }
    let mut out: Vec<CardReaction> = by
        .into_values()
        .map(|(mut r, waits)| {
            r.act_minutes = median(waits);
            r
        })
        .collect();
    out.sort_by(|a, b| b.raised.cmp(&a.raised).then_with(|| a.kind.cmp(&b.kind)));
    out
}

/// The cards raised in `[from, to)`.
pub async fn cards_between(
    db: &AppDatabase,
    from: DateTime<Utc>,
    to: DateTime<Utc>,
) -> Vec<notice_entity::Model> {
    notice_entity::Entity::find()
        .filter(notice_entity::Column::CreatedAt.gte(from))
        .filter(notice_entity::Column::CreatedAt.lt(to))
        .all(&db.conn)
        .await
        .unwrap_or_default()
}

/// How the owner answered each kind of card since [`seen_from`].
pub async fn reactions(db: &AppDatabase, now: DateTime<Utc>) -> Vec<CardReaction> {
    let since = seen_from(db, now).await;
    tally(&cards_between(db, since, now + Duration::seconds(1)).await)
}

// ── grades ──────────────────────────────────────────────────────────────────

/// How one assistant's handed-out work went.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct Grade {
    /// Handed out in the window (the checks of finished work left out).
    pub dispatches: u32,
    /// Came to an end one can judge: done, waiting for review, failed.
    pub settled: u32,
    /// Of those, done the first time: one round, nothing sent back by its
    /// acceptance, not failed.
    pub first_pass: u32,
    /// `first_pass / settled`, in percent.
    pub first_pass_rate: Option<u32>,
    /// From being handed out to done, on average.
    pub avg_minutes: Option<u32>,
}

/// One piece of handed-out work, as a grade counts it.
#[derive(Debug, Clone)]
pub struct Graded {
    pub bot_id: Option<i32>,
    /// The agent it ran on.
    pub agent_type: crate::models::AgentType,
    /// That agent's name, as its work snapshot has it.
    pub agent: String,
    pub mode: DispatchMode,
    pub state: DispatchState,
    pub rounds: i32,
    /// Its acceptance sent it back once at least.
    pub revised: bool,
    /// Its acceptance is still under way.
    pub checking: bool,
    pub minutes: Option<i64>,
}

impl Graded {
    fn settled(&self) -> bool {
        !self.checking
            && matches!(
                self.state,
                DispatchState::Completed | DispatchState::Review | DispatchState::Failed
            )
    }

    pub fn first_pass(&self) -> bool {
        self.settled() && self.state != DispatchState::Failed && self.rounds <= 1 && !self.revised
    }
}

pub fn grade_of<'a>(work: impl Iterator<Item = &'a Graded>) -> Grade {
    let mut g = Grade::default();
    let mut minutes = Vec::new();
    for w in work {
        g.dispatches += 1;
        if w.settled() {
            g.settled += 1;
            if w.first_pass() {
                g.first_pass += 1;
            }
        }
        if w.state == DispatchState::Completed {
            if let Some(m) = w.minutes {
                minutes.push(m.max(0));
            }
        }
    }
    g.first_pass_rate = (g.first_pass * 100 + g.settled / 2).checked_div(g.settled);
    if !minutes.is_empty() {
        let n = minutes.len() as i64;
        g.avg_minutes = u32::try_from((minutes.iter().sum::<i64>() + n / 2) / n).ok();
    }
    g
}

/// The work handed out in `[from, to)`, the checks of finished work left
/// out, each with its rounds and whether its acceptance sent it back.
pub async fn graded_between(
    db: &AppDatabase,
    from: DateTime<Utc>,
    to: DateTime<Utc>,
) -> Vec<Graded> {
    let dispatches = dispatch_entity::Entity::find()
        .filter(dispatch_entity::Column::CreatedAt.gte(from))
        .filter(dispatch_entity::Column::CreatedAt.lt(to))
        .all(&db.conn)
        .await
        .unwrap_or_default();
    if dispatches.is_empty() {
        return Vec::new();
    }
    let ids: Vec<i32> = dispatches.iter().map(|d| d.id).collect();
    let mut rounds_of: HashMap<i32, Vec<round_entity::Model>> = HashMap::new();
    let mut checks: HashSet<i32> = HashSet::new();
    for chunk in ids.chunks(500) {
        for r in round_entity::Entity::find()
            .filter(
                round_entity::Column::DispatchId
                    .is_in(chunk.to_vec())
                    .or(round_entity::Column::CheckDispatchId.is_in(chunk.to_vec())),
            )
            .all(&db.conn)
            .await
            .unwrap_or_default()
        {
            if let Some(c) = r.check_dispatch_id {
                checks.insert(c);
            }
            rounds_of.entry(r.dispatch_id).or_default().push(r);
        }
    }
    let task_ids: Vec<i32> = dispatches.iter().filter_map(|d| d.work_task_id).collect();
    let mut runs: HashMap<i32, i32> = HashMap::new();
    for chunk in task_ids.chunks(500) {
        for t in work_task::Entity::find()
            .filter(work_task::Column::Id.is_in(chunk.to_vec()))
            .all(&db.conn)
            .await
            .unwrap_or_default()
        {
            runs.insert(t.id, t.run_seq);
        }
    }
    dispatches
        .into_iter()
        .filter(|d| !checks.contains(&d.id))
        .map(|d| {
            let mut rounds: Vec<&round_entity::Model> = rounds_of
                .get(&d.id)
                .map(|v| v.iter().filter(|r| r.state.counts()).collect())
                .unwrap_or_default();
            rounds.sort_by_key(|r| r.id);
            let revised = rounds.iter().any(|r| r.state == VerificationState::Revised);
            let checking = rounds.last().is_some_and(|r| r.state.is_open());
            let n = match (d.mode, d.work_task_id.and_then(|t| runs.get(&t))) {
                (DispatchMode::Task, Some(run)) => *run,
                _ => d.turns,
            };
            let work = super::dispatch::work_of(&d);
            Graded {
                bot_id: d.bot_id,
                agent: super::dispatch::agent_words(&work),
                agent_type: work.agent_type,
                mode: d.mode,
                state: d.state,
                rounds: n,
                revised,
                checking,
                minutes: d.finished_at.map(|f| (f - d.created_at).num_minutes()),
            }
        })
        .collect()
}

/// The work the grades judge: handed out in the last [`GRADE_DAYS`] days.
pub async fn graded_recent(db: &AppDatabase, now: DateTime<Utc>) -> Vec<Graded> {
    graded_between(
        db,
        now - Duration::days(GRADE_DAYS),
        now + Duration::seconds(1),
    )
    .await
}

/// The grades over the last [`GRADE_DAYS`] days, by assistant.
pub async fn grades(db: &AppDatabase, now: DateTime<Utc>) -> HashMap<i32, Grade> {
    grades_of(&graded_recent(db, now).await)
}

/// `work`'s grades by assistant.
pub fn grades_of(work: &[Graded]) -> HashMap<i32, Grade> {
    let bots: HashSet<i32> = work.iter().filter_map(|w| w.bot_id).collect();
    bots.into_iter()
        .map(|b| (b, grade_of(work.iter().filter(|w| w.bot_id == Some(b)))))
        .collect()
}

/// One cell of the grades (7.9): the work one assistant handed out on one
/// agent one way.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct GradeCell {
    /// Who handed it out (none: from before there were several).
    pub bot_id: Option<i32>,
    pub agent_type: crate::models::AgentType,
    /// The agent's name, the latest one it went by.
    pub agent: String,
    pub mode: DispatchMode,
    pub grade: Grade,
}

/// `work` apart by assistant × agent × mode, the most work first.
pub fn cells(work: &[Graded]) -> Vec<GradeCell> {
    let mut keys: Vec<(Option<i32>, crate::models::AgentType, DispatchMode)> = Vec::new();
    for w in work {
        let k = (w.bot_id, w.agent_type, w.mode);
        if !keys.contains(&k) {
            keys.push(k);
        }
    }
    let mut out: Vec<GradeCell> = keys
        .into_iter()
        .map(|(bot_id, agent_type, mode)| {
            let mine: Vec<&Graded> = work
                .iter()
                .filter(|w| w.bot_id == bot_id && w.agent_type == agent_type && w.mode == mode)
                .collect();
            GradeCell {
                bot_id,
                agent_type,
                agent: mine.last().map(|w| w.agent.clone()).unwrap_or_default(),
                mode,
                grade: grade_of(mine.into_iter()),
            }
        })
        .collect();
    out.sort_by(|a, b| {
        b.grade
            .dispatches
            .cmp(&a.grade.dispatches)
            .then(a.bot_id.cmp(&b.bot_id))
            .then(a.agent.cmp(&b.agent))
    });
    out
}

/// A grade for the brain, in a few words; `None` with nothing to judge.
pub fn grade_words(g: &Grade) -> Option<String> {
    let rate = g.first_pass_rate?;
    let mut s = format!(
        "{rate}% passed the first time ({} of {} in {GRADE_DAYS} days)",
        g.first_pass, g.settled
    );
    if let Some(m) = g.avg_minutes {
        s.push_str(&format!(
            ", {} on average",
            super::due::span(Duration::minutes(m as i64))
        ));
    }
    Some(s)
}

// ── notifications held back ─────────────────────────────────────────────────

/// What became of news that did not go out at once (3.1 "interruptions
/// spared"): merged into a digest, held until the owner was back or done
/// typing, kept to the day's list.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Held {
    #[serde(default)]
    pub merged: u32,
    #[serde(default)]
    pub deferred: u32,
    #[serde(default)]
    pub kept: u32,
}

static HELD_LOCK: LazyLock<tokio::sync::Mutex<()>> = LazyLock::new(|| tokio::sync::Mutex::new(()));

/// Count one piece of news held back on the owner's day `day`: `merged`,
/// `deferred` or `kept`.
pub async fn count_held(db: &AppDatabase, day: NaiveDate, what: &str) {
    let _one = HELD_LOCK.lock().await;
    let key = format!("{REACH_PREFIX}{}", day.format("%Y-%m-%d"));
    let before = read(db, &key).await;
    // A new day: the days too old to count go.
    if before.is_null() {
        let floor = day - Duration::days(REACH_KEEP_DAYS);
        let _ = psvc::remove_with_prefix_before(
            &db.conn,
            REACH_PREFIX,
            &format!("{REACH_PREFIX}{}", floor.format("%Y-%m-%d")),
        )
        .await;
    }
    let mut h: Held = serde_json::from_value(before).unwrap_or_default();
    match what {
        "merged" => h.merged += 1,
        "deferred" => h.deferred += 1,
        _ => h.kept += 1,
    }
    if let Ok(v) = serde_json::to_value(h) {
        let _ = write(db, &key, &v).await;
    }
}

/// The news held back on the owner's days `[from, to)`.
pub async fn held_between(db: &AppDatabase, from: NaiveDate, to: NaiveDate) -> Held {
    let lo = format!("{REACH_PREFIX}{}", from.format("%Y-%m-%d"));
    let hi = format!("{REACH_PREFIX}{}", to.format("%Y-%m-%d"));
    let mut sum = Held::default();
    for (k, v) in psvc::with_prefix(&db.conn, REACH_PREFIX)
        .await
        .unwrap_or_default()
    {
        if k < lo || k >= hi {
            continue;
        }
        let h: Held = serde_json::from_value(v).unwrap_or_default();
        sum.merged += h.merged;
        sum.deferred += h.deferred;
        sum.kept += h.kept;
    }
    sum
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn at(h: u32, m: u32) -> DateTime<Utc> {
        Utc.with_ymd_and_hms(2026, 11, 10, h, m, 0).unwrap()
    }

    fn card(
        kind: NoticeKind,
        state: NoticeState,
        made: DateTime<Utc>,
        acted: Option<DateTime<Utc>>,
    ) -> notice_entity::Model {
        notice_entity::Model {
            id: 0,
            kind,
            subject_key: None,
            level: crate::db::entities::personal_agent_notice::NoticeLevel::Normal,
            state,
            timeline_id: None,
            batch_id: None,
            payload: "{}".into(),
            notified_at: None,
            acted_at: acted,
            expires_at: None,
            created_at: made,
            updated_at: made,
            bot_id: None,
        }
    }

    #[test]
    fn hours_start_at_the_day_break_may_run_past_midnight_and_last_an_hour() {
        assert_eq!(
            span_of("10:00", "20:00"),
            Ok(Span {
                start: 600,
                end: 1200
            })
        );
        // An end at or before the start is the next morning's.
        assert_eq!(
            span_of("14:00", "02:00"),
            Ok(Span {
                start: 840,
                end: 1560
            })
        );
        assert!(span_of("03:00", "12:00").is_err(), "before the day breaks");
        assert!(
            span_of("20:00", "05:00").is_err(),
            "past the next day's break"
        );
        assert!(span_of("10:00", "10:30").is_err(), "shorter than an hour");
        assert!(span_of("10:00", "noon").is_err());
    }

    #[test]
    fn the_owners_hours_win_over_what_is_learned() {
        let learned = Hours::default();
        let set = HoursSet {
            workday: Some(Span {
                start: 600,
                end: 1200,
            }),
            restday: None,
        };
        let h = apply(learned, &set);
        assert_eq!((h.workday.start, h.workday.end), (600, 1200));
        assert!(h.workday.learned && h.workday.set);
        assert_eq!(h.restday, learned.restday);
        assert!(!h.restday.set);
    }

    #[test]
    fn answers_are_tallied_by_kind_with_the_median_wait() {
        let t = at(9, 0);
        let cards = vec![
            card(NoticeKind::Rule, NoticeState::Acted, t, Some(at(9, 10))),
            card(NoticeKind::Rule, NoticeState::Acted, t, Some(at(9, 30))),
            card(NoticeKind::Rule, NoticeState::Dismissed, t, Some(at(9, 1))),
            card(NoticeKind::Rule, NoticeState::Muted, t, Some(at(9, 1))),
            card(NoticeKind::Changed, NoticeState::Undone, t, Some(at(9, 2))),
            card(NoticeKind::Changed, NoticeState::Acted, t, Some(t)),
            card(NoticeKind::Proposal, NoticeState::Open, t, None),
            // An assistant answered it: not the owner's.
            card(NoticeKind::Ask, NoticeState::Acted, t, Some(t)),
        ];
        let r = tally(&cards);
        assert_eq!(r.len(), 3);
        assert_eq!(r[0].kind, "rule");
        assert_eq!(
            (r[0].raised, r[0].acted, r[0].dismissed, r[0].muted),
            (4, 2, 1, 1)
        );
        assert_eq!(r[0].act_minutes, Some(10));
        let changed = r.iter().find(|c| c.kind == "changed").unwrap();
        assert_eq!((changed.undone, changed.acted), (1, 1));
        let proposal = r.iter().find(|c| c.kind == "proposal").unwrap();
        assert_eq!((proposal.open, proposal.act_minutes), (1, None));
    }

    fn work(state: DispatchState, rounds: i32, revised: bool, minutes: Option<i64>) -> Graded {
        Graded {
            bot_id: Some(1),
            agent_type: crate::models::AgentType::Codex,
            agent: "Codex".into(),
            mode: DispatchMode::Session,
            state,
            rounds,
            revised,
            checking: false,
            minutes,
        }
    }

    #[test]
    fn a_first_pass_is_one_round_nothing_sent_back_not_failed() {
        let mut checking = work(DispatchState::Review, 1, false, None);
        checking.checking = true;
        let all = [
            work(DispatchState::Completed, 1, false, Some(10)),
            work(DispatchState::Completed, 2, false, Some(50)),
            work(DispatchState::Review, 1, true, None),
            work(DispatchState::Failed, 1, false, Some(5)),
            work(DispatchState::Running, 1, false, None),
            checking,
        ];
        let g = grade_of(all.iter());
        assert_eq!(g.dispatches, 6);
        assert_eq!(
            g.settled, 4,
            "running and still checking are not judged yet"
        );
        assert_eq!(g.first_pass, 1);
        assert_eq!(g.first_pass_rate, Some(25));
        assert_eq!(g.avg_minutes, Some(30), "the completed ones only");
        assert_eq!(grade_words(&Grade::default()), None);
        assert!(grade_words(&g)
            .unwrap()
            .starts_with("25% passed the first time (1 of 4"));
    }

    #[test]
    fn the_grades_come_apart_by_who_handed_out_what_ran_and_how() {
        use crate::models::AgentType;
        let at = |bot: i32, agent_type: AgentType, mode: DispatchMode, ok: bool| {
            let mut w = work(
                if ok {
                    DispatchState::Completed
                } else {
                    DispatchState::Failed
                },
                1,
                false,
                Some(10),
            );
            w.bot_id = Some(bot);
            w.agent_type = agent_type;
            w.agent = format!("{agent_type:?}");
            w.mode = mode;
            w
        };
        let all = vec![
            at(1, AgentType::Codex, DispatchMode::Task, true),
            at(1, AgentType::Codex, DispatchMode::Task, false),
            at(1, AgentType::Codex, DispatchMode::Chat, true),
            at(2, AgentType::Codex, DispatchMode::Task, true),
            at(1, AgentType::ClaudeCode, DispatchMode::Chat, true),
        ];
        let c = cells(&all);
        assert_eq!(c.len(), 4, "one cell per assistant × agent × mode");
        assert_eq!(
            (c[0].bot_id, c[0].agent_type, c[0].mode),
            (Some(1), AgentType::Codex, DispatchMode::Task),
            "the most work first"
        );
        assert_eq!((c[0].grade.settled, c[0].grade.first_pass), (2, 1));
        assert_eq!(c[0].agent, "Codex");
    }
}
