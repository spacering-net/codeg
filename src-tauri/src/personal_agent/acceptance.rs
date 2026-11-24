//! Acceptance (7.5): the assistant that dispatched code work accepts it,
//! after a hands-on check of it.
//!
//! - A task the assistant dispatched that changed code enters review: codeg
//!   (not the brain) sends a read-only check of its worktree in a work
//!   session of its own, on what the work's assistant's work runs on now
//!   (D1: whose work, theirs to check) — once the task's preflight has run. Each round is bound to the
//!   task's run generation and the worktree's fingerprint at the start.
//! - The check comes back: codeg reads its verdict. The task moved on → the
//!   round is stale; the worktree changed meanwhile → the round is void and
//!   the owner is told; otherwise the brain is woken with the materials and
//!   decides with `acceptance_decide`: accept, send it back (the board's
//!   "revise" follow-up), or ask the owner.
//! - No conclusion from the brain (the turn ended without one, failed, or
//!   no brain could start): codeg goes by the check's verdict.
//! - Every conclusion — the brain's, codeg's, the owner's click — is checked
//!   against the version first: the worktree's fingerprint is read again,
//!   and the round's state and the task's generation are compared in one
//!   conditional update. A conclusion for a version that is not there any
//!   more is refused.
//! - The board's auto-merge waits for the round to pass and, under the
//!   folder's git lock, merges only the version accepted; a delivery to a
//!   pull request pushes only that version and records the head it pushed.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use chrono::Utc;
use sea_orm::{ColumnTrait, EntityTrait, QueryFilter};
use serde_json::{json, Value};

use super::dispatch::{cut, mode_label, work_of};
use super::engine::PersonalAgentEngine;
use super::read_check::OrFailed;
use super::tools::ToolOutcome;
use crate::db::entities::personal_agent_dispatch::{
    self as dispatch_entity, DispatchMode, DispatchState,
};
use crate::db::entities::personal_agent_notice::{NoticeKind, NoticeLevel, NoticeState};
use crate::db::entities::personal_agent_timeline::TimelineKind;
use crate::db::entities::personal_agent_verification::{
    self as round_entity, AcceptDecision, CheckVerdict, DecidedBy, VerificationState,
};
use crate::db::entities::work_task::{self as work_task, WorkTaskStatus};
use crate::db::service::personal_agent_service as svc;
use crate::db::service::personal_agent_service::{NewDispatch, NewEvent, NewNotice, NewRow};
use crate::db::service::personal_agent_verification_service as vsvc;
use crate::db::service::personal_agent_verification_service::{NewRound, RoundWrite, TaskAt};
use crate::db::AppDatabase;
use crate::models::personal_agent::{DispatchWorkSnapshot, PersonalAgentChange};
use crate::models::personal_agent_overview::Ladder;
use crate::models::personal_agent_prefs::{AccountView, AskFirst, Prefs};
use crate::models::WorkTaskPreflight;

/// The event that wakes an assistant to conclude a round.
pub const ACCEPT_EVENT: &str = "acceptance";
/// The event that tells it a round was concluded for it (by codeg or the
/// owner) and someone waits for its answer.
pub const SETTLED_EVENT: &str = "acceptance_settled";

/// What the board's merge pump is told when a task waits for its
/// acceptance: a pause, not a failure — it writes no banner.
pub const MERGE_HOLD: &str = "waits for its acceptance to pass";

/// Longest check evidence kept.
const EVIDENCE_CHARS: usize = 4_000;
/// Longest reason, question or message an assistant gives.
const WORDS_CHARS: usize = 4_000;
/// A preflight light that was never written this long after review began
/// will not be: the check goes ahead without it.
const PREFLIGHT_GRACE_SECS: i64 = 120;

// ── pure parts ──────────────────────────────────────────────────────────────

/// A check's report, as codeg reads it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CheckReport {
    pub verdict: CheckVerdict,
    pub evidence: String,
}

/// Read a check's last message: its last `VERDICT:` line decides (an
/// earlier one may only quote the format); what follows it is the evidence.
/// No verdict line is `UNVERIFIED`.
pub fn parse_verdict(text: &str) -> CheckReport {
    let lines: Vec<&str> = text.lines().collect();
    let mut found: Option<(usize, CheckVerdict)> = None;
    for (i, line) in lines.iter().enumerate() {
        if let Some(v) = verdict_of_line(line) {
            found = Some((i, v));
        }
    }
    match found {
        Some((i, verdict)) => {
            let after = lines[i + 1..].join("\n");
            let evidence = if after.trim().is_empty() {
                lines[..i].join("\n")
            } else {
                after
            };
            CheckReport {
                verdict,
                evidence: tail(evidence.trim(), EVIDENCE_CHARS),
            }
        }
        None => CheckReport {
            verdict: CheckVerdict::Unverified,
            evidence: tail(text.trim(), EVIDENCE_CHARS),
        },
    }
}

/// `VERDICT: PASS` (any case, markdown around it, a full-width colon) →
/// its verdict.
fn verdict_of_line(line: &str) -> Option<CheckVerdict> {
    let cleaned: String = line
        .chars()
        .filter(|c| !matches!(c, '*' | '_' | '`' | '#' | '>'))
        .collect();
    let t = cleaned.trim().trim_start_matches(['-', '•']).trim();
    let upper = t.to_uppercase();
    let rest = upper.strip_prefix("VERDICT")?;
    let rest = rest.trim_start().strip_prefix([':', '：'])?.trim();
    // "PASS | FAIL | UNVERIFIED" is the format, not a verdict.
    if rest.contains('|') {
        return None;
    }
    let word: String = rest
        .chars()
        .take_while(|c| c.is_ascii_alphabetic())
        .collect();
    match word.as_str() {
        "PASS" | "PASSED" => Some(CheckVerdict::Pass),
        "FAIL" | "FAILED" => Some(CheckVerdict::Fail),
        "UNVERIFIED" => Some(CheckVerdict::Unverified),
        _ => None,
    }
}

/// The end of `text`, at most `max` characters: a report's conclusions are
/// at its end.
fn tail(text: &str, max: usize) -> String {
    let n = text.chars().count();
    if n <= max {
        return text.to_string();
    }
    let mut s = String::from("…");
    s.extend(text.chars().skip(n - max));
    s
}

pub fn verdict_word(v: CheckVerdict) -> &'static str {
    match v {
        CheckVerdict::Pass => "PASS",
        CheckVerdict::Fail => "FAIL",
        CheckVerdict::Unverified => "UNVERIFIED",
    }
}

/// Whether a dispatch's work is accepted by its assistant: code work it
/// dispatched to the board, ready for review with changes to look at, the
/// owner's setting on. A report, a conversation's work, a forge item's task
/// are not.
pub fn wants_acceptance(
    d: &dispatch_entity::Model,
    task: &work_task::Model,
    prefs: &Prefs,
) -> bool {
    prefs.accepts()
        && d.mode == DispatchMode::Task
        && d.deliverable.as_deref() != Some("report")
        && d.state != DispatchState::HandedOver
        && task.personal_agent_dispatch_id == Some(d.id)
        // A forge task carries text strangers wrote; a round codeg itself
        // started on a watched pull request is the assistant's own work
        // (7.4), checked like any.
        && (task.source_kind.is_none() || d.pr_fix.is_some())
        && task.files_changed != Some(0)
}

/// Where a round stands, for the PR ladder (8.5) and the cards.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AcceptView {
    /// Being checked, or waiting on its assistant's conclusion.
    Checking,
    /// The owner's call.
    Asked,
    /// Accepted for the version there now.
    Accepted,
    /// Wanted, not open: the worktree changed after its check or its
    /// acceptance, and nobody checks it again on their own.
    Changed,
}

/// The ladder, with acceptance in it: a task in review that waits on its
/// acceptance is being checked, not ready to merge.
pub fn ladder_with(ladder: Ladder, view: Option<AcceptView>) -> Ladder {
    match (ladder, view) {
        (Ladder::Mergeable, Some(AcceptView::Checking | AcceptView::Changed)) => Ladder::Checking,
        (Ladder::Mergeable, Some(AcceptView::Asked)) => Ladder::WaitingYou,
        (l, _) => l,
    }
}

/// How the dispatches `ids` stand on their acceptance — only those whose
/// task is in review and wants one.
pub async fn views_of(
    db: &AppDatabase,
    dispatches: &[&dispatch_entity::Model],
    tasks: &HashMap<i32, work_task::Model>,
) -> HashMap<i32, AcceptView> {
    let prefs = account_of(db).await.prefs;
    let wanted: Vec<&dispatch_entity::Model> = dispatches
        .iter()
        .copied()
        .filter(|d| {
            d.work_task_id.and_then(|t| tasks.get(&t)).is_some_and(|t| {
                t.status == WorkTaskStatus::Review && wants_acceptance(d, t, &prefs)
            })
        })
        .collect();
    if wanted.is_empty() {
        return HashMap::new();
    }
    let ids: Vec<i32> = wanted.iter().map(|d| d.id).collect();
    let latest = vsvc::latest_of(&db.conn, &ids).await.or_failed();
    let mut out = HashMap::new();
    for d in wanted {
        let Some(task) = d.work_task_id.and_then(|t| tasks.get(&t)) else {
            continue;
        };
        out.insert(d.id, view_of(latest.get(&d.id), task));
    }
    out
}

/// One dispatch's view, from its latest round.
pub fn view_of(latest: Option<&round_entity::Model>, task: &work_task::Model) -> AcceptView {
    match latest {
        Some(r) if r.state == VerificationState::Accepted && r.run_seq == task.run_seq => {
            AcceptView::Accepted
        }
        Some(r) if r.state == VerificationState::Asked && r.run_seq == task.run_seq => {
            AcceptView::Asked
        }
        Some(r)
            if matches!(
                r.state,
                VerificationState::Void | VerificationState::Changed
            ) && r.run_seq == task.run_seq =>
        {
            AcceptView::Changed
        }
        _ => AcceptView::Checking,
    }
}

/// The account's settings, read without an engine (the board asks).
async fn account_of(db: &AppDatabase) -> AccountView {
    match svc::primary_bot(&db.conn).await.or_failed() {
        Some(p) => AccountView::from_settings(&p.settings),
        None => AccountView::default(),
    }
}

// ── the board's side ────────────────────────────────────────────────────────

/// Of `tasks` (in review), those the board's auto-merge must leave alone
/// for now: their assistant accepts them, and the version there has not
/// passed (7.5).
pub async fn merge_holds(db: &AppDatabase, tasks: &[work_task::Model]) -> HashSet<i32> {
    let mut out = HashSet::new();
    let ours: Vec<&work_task::Model> = tasks
        .iter()
        .filter(|t| t.personal_agent_dispatch_id.is_some())
        .collect();
    if ours.is_empty() {
        return out;
    }
    let prefs = account_of(db).await.prefs;
    for t in ours {
        let Some(id) = t.personal_agent_dispatch_id else {
            continue;
        };
        let Ok(Some(d)) = svc::get_dispatch(&db.conn, id).await else {
            continue;
        };
        if !wants_acceptance(&d, t, &prefs) {
            continue;
        }
        let latest = vsvc::latest_of(&db.conn, &[d.id]).await.unwrap_or_default();
        if view_of(latest.get(&d.id), t) != AcceptView::Accepted {
            out.insert(t.id);
        }
    }
    out
}

/// Of `tasks`, those in review whose assistant is accepting them and has
/// not accepted them yet: theirs to settle — or the owner's through its
/// acceptance card — not the board's review waiting on the owner. With how
/// each stands.
pub async fn being_accepted(
    db: &AppDatabase,
    tasks: &[work_task::Model],
) -> HashMap<i32, AcceptView> {
    let mut out = HashMap::new();
    let ours: Vec<&work_task::Model> = tasks
        .iter()
        .filter(|t| t.status == WorkTaskStatus::Review && t.personal_agent_dispatch_id.is_some())
        .collect();
    if ours.is_empty() {
        return out;
    }
    let prefs = account_of(db).await.prefs;
    let ids: Vec<i32> = ours
        .iter()
        .filter_map(|t| t.personal_agent_dispatch_id)
        .collect();
    let latest = vsvc::latest_of(&db.conn, &ids).await.or_failed();
    for t in ours {
        let Some(id) = t.personal_agent_dispatch_id else {
            continue;
        };
        let Some(d) = svc::get_dispatch(&db.conn, id).await.or_failed() else {
            continue;
        };
        if !wants_acceptance(&d, t, &prefs) {
            continue;
        }
        let view = view_of(latest.get(&id), t);
        if view != AcceptView::Accepted {
            out.insert(t.id, view);
        }
    }
    out
}

/// The board's auto-merge is about to land `task` (under the folder's git
/// lock): only the version accepted lands. `Ok` lets it go on; the hold
/// reads as a pause to the pump (it contains [`MERGE_HOLD`]), not a failure.
/// A worktree that changed after its acceptance marks the round so — its
/// card offers to check it again.
pub async fn merge_gate(
    db: &AppDatabase,
    task: &work_task::Model,
    wt_path: &str,
) -> Result<(), String> {
    let Some(id) = task.personal_agent_dispatch_id else {
        return Ok(());
    };
    let Ok(Some(d)) = svc::get_dispatch(&db.conn, id).await else {
        return Ok(());
    };
    if !wants_acceptance(&d, task, &account_of(db).await.prefs) {
        return Ok(());
    }
    let latest = vsvc::latest_of(&db.conn, &[d.id]).await.unwrap_or_default();
    let Some(round) = latest
        .get(&d.id)
        .filter(|r| r.state == VerificationState::Accepted && r.run_seq == task.run_seq)
    else {
        return Err(format!("this task {MERGE_HOLD}"));
    };
    let now = crate::work_task::git::worktree_fingerprint(wt_path)
        .await
        .map_err(|e| format!("this task {MERGE_HOLD}: its worktree could not be read ({e})"))?;
    if now != round.fingerprint {
        changed_after(db, round).await;
        return Err(format!(
            "this task {MERGE_HOLD}: its worktree changed after it was accepted"
        ));
    }
    let _ = vsvc::write_round(
        &db.conn,
        round.id,
        RoundWrite {
            version_guaranteed: Some(Some(true)),
            ..Default::default()
        },
    )
    .await;
    Ok(())
}

/// A delivery to a pull request is about to push `task`: when its version
/// was accepted, only that version goes — and the round it passed in is
/// returned, for the head the push records. Without an accepted round, the
/// owner's delivery is theirs.
pub async fn delivery_gate(
    db: &AppDatabase,
    task: &work_task::Model,
    wt_path: &str,
) -> Result<Option<i32>, String> {
    let Some(id) = task.personal_agent_dispatch_id else {
        return Ok(None);
    };
    let latest = vsvc::latest_of(&db.conn, &[id]).await.unwrap_or_default();
    let Some(round) = latest
        .get(&id)
        .filter(|r| r.state == VerificationState::Accepted && r.run_seq == task.run_seq)
    else {
        return Ok(None);
    };
    let now = crate::work_task::git::worktree_fingerprint(wt_path)
        .await
        .map_err(|e| {
            format!("could not read the task worktree to compare it with what was accepted: {e}")
        })?;
    if now != round.fingerprint {
        changed_after(db, round).await;
        return Err(
            "the task worktree changed after its acceptance — have it checked again (its \
             acceptance card), then deliver"
                .to_string(),
        );
    }
    Ok(Some(round.id))
}

/// The accepted version was pushed: `head` is what the pull request carries.
pub async fn delivered(db: &AppDatabase, round_id: i32, head: &str) {
    let _ = vsvc::write_round(
        &db.conn,
        round_id,
        RoundWrite {
            delivered_head: Some(Some(head.to_string())),
            ..Default::default()
        },
    )
    .await;
    if let Some(host) = super::host::host() {
        if let Ok(Some(r)) = vsvc::get(&db.conn, round_id).await {
            if let Some(engine) = engine_of(&host, r.bot_id).await {
                engine.refresh_acceptance_card(&r).await;
            }
        }
    }
}

/// What was accepted is not what is there: the round says so, and its card
/// offers to check it again.
async fn changed_after(db: &AppDatabase, round: &round_entity::Model) {
    let moved = vsvc::move_round(
        &db.conn,
        round.id,
        &[VerificationState::Accepted],
        VerificationState::Changed,
        None,
        RoundWrite::default(),
    )
    .await
    .ok()
    .flatten();
    if let (Some(r), Some(host)) = (moved, super::host::host()) {
        if let Some(engine) = engine_of(&host, r.bot_id).await {
            engine.round_changed(&r).await;
        }
    }
}

async fn engine_of(
    host: &Arc<super::host::EngineHost>,
    bot: Option<i32>,
) -> Option<Arc<PersonalAgentEngine>> {
    let bot = bot?;
    if host.primary().serves(bot).await {
        Some(host.primary())
    } else {
        host.existing_worker(bot).await
    }
}

// ── the assistant's side ────────────────────────────────────────────────────

/// A conclusion, from whoever reached it.
#[derive(Debug, Clone)]
pub struct Conclusion {
    pub decision: AcceptDecision,
    pub reason: Option<String>,
    /// Revise: what to change. Ask: what sending it back would say.
    pub message: Option<String>,
    pub question: Option<String>,
    pub by: DecidedBy,
}

/// What concluding a round came to, for whoever asked.
#[derive(Debug, Clone)]
pub struct Concluded {
    pub state: VerificationState,
    pub text: String,
}

impl PersonalAgentEngine {
    /// Rounds to open and rounds gone stale — the liveness tick's part.
    pub(super) async fn acceptance_tick(self: &Arc<Self>) {
        let bot = self.bot().await;
        if bot == 0 {
            return;
        }
        // Rounds the assistant was handed and left undecided.
        self.settle_undecided().await;
        let prefs = self.prefs().await;
        let reviews = svc::list_dispatches(
            &self.db.conn,
            bot,
            &[DispatchState::Review],
            Some(DispatchMode::Task),
            200,
        )
        .await
        .unwrap_or_default();
        for d in reviews {
            let Some(tid) = d.work_task_id else {
                continue;
            };
            let Ok(task) =
                crate::db::service::work_task_service::get_model(&self.db.conn, tid).await
            else {
                continue;
            };
            if task.status != WorkTaskStatus::Review
                || task.deferred_at.is_some()
                || !wants_acceptance(&d, &task, &prefs)
            {
                continue;
            }
            self.ensure_round(&d, &task).await;
        }
        // A round on a watched pull request accepted and not pushed (7.4).
        self.settle_pr_rounds().await;
        // A round whose task moved on before its conclusion was carried out.
        for r in vsvc::open_rounds(&self.db.conn, Some(bot))
            .await
            .unwrap_or_default()
        {
            if !self.round_still_current(&r).await {
                self.go_stale(&r).await;
            }
        }
    }

    /// Whether round `r`'s task is still in review at its generation.
    async fn round_still_current(&self, r: &round_entity::Model) -> bool {
        let Ok(Some(d)) = svc::get_dispatch(&self.db.conn, r.dispatch_id).await else {
            return false;
        };
        let Some(tid) = d.work_task_id else {
            return false;
        };
        match crate::db::service::work_task_service::get_model(&self.db.conn, tid).await {
            Ok(t) => t.status == WorkTaskStatus::Review && t.run_seq == r.run_seq,
            Err(_) => false,
        }
    }

    /// The task moved on: an open round no longer counts, and its card says
    /// nothing was carried out.
    async fn go_stale(&self, r: &round_entity::Model) {
        let moved = vsvc::move_round(
            &self.db.conn,
            r.id,
            &[
                VerificationState::Checking,
                VerificationState::Deciding,
                VerificationState::Asked,
            ],
            VerificationState::Stale,
            None,
            RoundWrite::default(),
        )
        .await
        .ok()
        .flatten();
        if let Some(r) = moved {
            self.refresh_acceptance_card(&r).await;
            self.emit(PersonalAgentChange::Dispatch { id: r.dispatch_id });
            self.emit(PersonalAgentChange::Status);
        }
    }

    /// Open this review's round, unless it has one: after the preflight,
    /// bound to the worktree as it is now. The same version as the one
    /// accepted last keeps that acceptance.
    async fn ensure_round(self: &Arc<Self>, d: &dispatch_entity::Model, task: &work_task::Model) {
        let _one = self.accept_lock.lock().await;
        let rounds = vsvc::rounds_of(&self.db.conn, d.id)
            .await
            .unwrap_or_default();
        // This generation has its round (an interrupted check's stale one
        // is opened again).
        if rounds
            .iter()
            .any(|r| r.run_seq == task.run_seq && r.state != VerificationState::Stale)
        {
            return;
        }
        if !self.preflight_settled(task).await {
            return;
        }
        let Some(wt) = self.worktree_of(task).await else {
            return;
        };
        let fp = match crate::work_task::git::worktree_fingerprint(&wt.path).await {
            Ok(fp) => fp,
            Err(e) => {
                tracing::warn!(
                    "[personal_agent] task #{}: fingerprint not read: {e}",
                    task.id
                );
                return;
            }
        };
        // The very version accepted last: its acceptance stands.
        if let Some(last) = rounds.last() {
            if last.state == VerificationState::Accepted && last.fingerprint == fp {
                let _ = vsvc::write_round(
                    &self.db.conn,
                    last.id,
                    RoundWrite {
                        run_seq: Some(task.run_seq),
                        ..Default::default()
                    },
                )
                .await;
                self.emit(PersonalAgentChange::Dispatch { id: d.id });
                return;
            }
        }
        self.open_acceptance_round(d, task, &wt, fp, &rounds).await;
    }

    /// The owner asked on a card for this review to be accepted (6.7): its
    /// round opens now, whatever the "auto acceptance" setting says.
    /// Whether a round stands for this generation of the task afterwards.
    pub(super) async fn accept_on_request(
        self: &Arc<Self>,
        d: &dispatch_entity::Model,
        task: &work_task::Model,
    ) -> bool {
        self.ensure_round(d, task).await;
        vsvc::rounds_of(&self.db.conn, d.id)
            .await
            .unwrap_or_default()
            .iter()
            .any(|r| r.run_seq == task.run_seq && r.state != VerificationState::Stale)
    }

    /// Whether the task's preflight has run (or will not): the check waits
    /// for its light.
    async fn preflight_settled(&self, task: &work_task::Model) -> bool {
        let settings = crate::db::service::work_task_service::settings_get_effective(
            &self.db.conn,
            task.folder_id,
        )
        .await
        .unwrap_or_default();
        if !crate::work_task::engine::preflight_configured(&settings) {
            return true;
        }
        match task
            .preflight
            .as_deref()
            .and_then(|s| serde_json::from_str::<WorkTaskPreflight>(s).ok())
        {
            Some(p) => p.status != "running",
            // Never written: a light that will not come once its run would
            // have begun.
            None => task
                .settled_at
                .is_some_and(|at| (Utc::now() - at).num_seconds() > PREFLIGHT_GRACE_SECS),
        }
    }

    async fn worktree_of(&self, task: &work_task::Model) -> Option<crate::models::FolderDetail> {
        let id = task.worktree_folder_id?;
        let wt = crate::commands::folders::get_folder_core(&self.db, id)
            .await
            .ok()?;
        std::path::Path::new(&wt.path).exists().then_some(wt)
    }

    /// Open a round and send its check out — or, with nobody to check it,
    /// put it to the assistant at once.
    async fn open_acceptance_round(
        self: &Arc<Self>,
        d: &dispatch_entity::Model,
        task: &work_task::Model,
        wt: &crate::models::FolderDetail,
        fingerprint: String,
        rounds: &[round_entity::Model],
    ) {
        let n = rounds.iter().filter(|r| r.state.counts()).count() as i32 + 1;
        let checker = self.pick_checker(d, task).await;
        let made = vsvc::create(
            &self.db.conn,
            NewRound {
                bot_id: d.bot_id,
                dispatch_id: d.id,
                round: n,
                run_seq: task.run_seq,
                fingerprint,
                state: if checker.is_some() {
                    VerificationState::Checking
                } else {
                    VerificationState::Deciding
                },
                unchecked: checker.is_none(),
            },
        )
        .await;
        let round = match made {
            Ok(r) => r,
            Err(e) => {
                tracing::warn!("[personal_agent] dispatch #{}: round not opened: {e}", d.id);
                return;
            }
        };
        self.emit(PersonalAgentChange::Dispatch { id: d.id });
        match checker {
            Some(checker) => match self.dispatch_check(d, task, wt, &round, checker).await {
                Ok(check_id) => {
                    let _ = vsvc::write_round(
                        &self.db.conn,
                        round.id,
                        RoundWrite {
                            check_dispatch_id: Some(Some(check_id)),
                            ..Default::default()
                        },
                    )
                    .await;
                }
                Err(e) => {
                    // No check went out: the assistant decides on what
                    // there is, and the card says it was not checked.
                    if let Ok(Some(r)) = vsvc::move_round(
                        &self.db.conn,
                        round.id,
                        &[VerificationState::Checking],
                        VerificationState::Deciding,
                        None,
                        RoundWrite {
                            check_verdict: Some(Some(CheckVerdict::Unverified)),
                            check_evidence: Some(Some(format!("the check could not be sent: {e}"))),
                            ..Default::default()
                        },
                    )
                    .await
                    {
                        self.put_to_assistant(&r, None).await;
                    }
                }
            },
            None => self.put_to_assistant(&round, None).await,
        }
    }

    /// Who checks this work (7.5, D1): what the assistant the work is now
    /// with runs its work on — the one that dispatched it, or the primary
    /// it was handed to — with its standing instructions for its work.
    /// `None`: that agent cannot run now.
    pub(super) async fn pick_checker(
        &self,
        d: &dispatch_entity::Model,
        _task: &work_task::Model,
    ) -> Option<DispatchWorkSnapshot> {
        let owner = svc::get_bot(&self.db.conn, d.bot_id?).await.ok().flatten()?;
        let work = super::dispatch::usable_work(&self.db, &owner).await?;
        Some(DispatchWorkSnapshot {
            name: super::messages::display_name(&owner),
            bot_uid: owner.uid.clone(),
            agent_type: work.agent_type,
            agent_options: work.agent_options,
            label_snapshot: Some(work.label_snapshot),
            instructions: owner.work_instructions.clone().unwrap_or_default(),
            dispatcher: None,
        })
    }

    /// Send the check out: a work session in the task's worktree, as the
    /// assistant that dispatched the work — a plain dispatch card on its
    /// timeline, no matter of its own.
    async fn dispatch_check(
        self: &Arc<Self>,
        d: &dispatch_entity::Model,
        task: &work_task::Model,
        wt: &crate::models::FolderDetail,
        round: &round_entity::Model,
        checker: DispatchWorkSnapshot,
    ) -> Result<i32, String> {
        let prompt = self.check_prompt(d, task, wt, round).await;
        let snapshot = DispatchWorkSnapshot {
            dispatcher: Some(self.dispatcher_brief().await),
            ..checker
        };
        let row = svc::create_dispatch(
            &self.db.conn,
            NewDispatch {
                bot_id: self.bot().await,
                mode: DispatchMode::Session,
                work_snapshot_json: serde_json::to_string(&snapshot)
                    .map_err(|e| e.to_string())?,
                folder_id: Some(wt.id),
                deliverable: None,
                title: cut(&d.title, super::dispatch::MAX_TITLE_CHARS),
                prompt,
                origin_batch_id: None,
                on_done: None,
                lineage: svc::Lineage {
                    origin_bot_id: d.origin_bot_id,
                    origin_row_id: d.origin_row_id,
                    thread_id: d.thread_id,
                    for_input: d.for_input.clone(),
                },
                done_when: None,
                pr_fix: None,
                is_check: true,
            },
        )
        .await
        .map_err(|e| e.to_string())?;
        let mut card = NewRow::new(TimelineKind::Dispatch, d.title.clone());
        card.dispatch_id = Some(row.id);
        card.segment_id = self.state.lock().await.connection_segment;
        card.data = Some(json!({
            "mode": row.mode,
            "agent_type": snapshot.agent_type,
            "folder_id": d.folder_id,
            "deliverable": Value::Null,
            "state": row.state,
            // What it checks, and which round (7.5).
            "check_for": d.id,
            "check_round": round.round,
            "work_task_id": task.id,
        }));
        self.push_row(card).await;
        self.emit(PersonalAgentChange::Dispatch { id: row.id });
        self.kick_queue();
        Ok(row.id)
    }

    /// What the checker is asked: read only, criterion by criterion, a
    /// verdict last.
    async fn check_prompt(
        &self,
        d: &dispatch_entity::Model,
        task: &work_task::Model,
        wt: &crate::models::FolderDetail,
        round: &round_entity::Model,
    ) -> String {
        let mut parts = vec![
            "You are checking a piece of work before it is accepted. This is a READ-ONLY \
             review: do not change, create, delete, stage or commit any file in this worktree, and \
             do not run anything that writes to it (formatters, code generators, `git add`, \
             `git commit`, `git checkout`, `git stash`…). Running the project's tests and builds is \
             fine when they only write output git ignores. Any change to the worktree voids this \
             check."
                .to_string(),
        ];
        parts.push(format!(
            "What the work was asked to do:\n{}",
            cut(&d.prompt, 6_000)
        ));
        parts.push(
            match d
                .done_when
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
            {
                Some(w) => format!("Done when:\n{w}"),
                None => {
                    "No acceptance criteria were written: judge it against what it was asked to do."
                        .to_string()
                }
            },
        );
        // A later round: what the last one sent back, to look at first.
        if round.round > 1 {
            let sent_back = vsvc::rounds_of(&self.db.conn, d.id)
                .await
                .unwrap_or_default()
                .into_iter()
                .rev()
                .find(|x| x.id != round.id && x.state == VerificationState::Revised)
                .and_then(|x| x.message);
            parts.push(match sent_back {
                Some(m) => format!(
                    "This is check {} of this work. After the last one it was sent back with:\n{}\n\
                     See that this was done, and check every criterion again.",
                    round.round,
                    cut(&m, 3_000)
                ),
                None => format!("This is check {} of this work.", round.round),
            });
        }
        parts.push(self.changes_text(task, wt).await);
        if let Some(p) = preflight_text(task) {
            parts.push(p);
        }
        parts.push(
            "The project's own instructions (AGENTS.md, CLAUDE.md, the README, its CI config) say \
             how it is built and tested. `git status` shows the files never added."
                .to_string(),
        );
        parts.push(
            "Go through every criterion; read the changes and run the tests that apply. End your \
             reply with exactly:\n\nVERDICT: PASS | FAIL | UNVERIFIED\n- evidence: file:line, a \
             command and its exit code, or a failing test's name — one per line\n\nPASS only when \
             every criterion holds and you saw it hold; FAIL when one does not; UNVERIFIED when you \
             could not tell (the tests would not run, say). Write the evidence in the language the \
             criteria are written in."
                .to_string(),
        );
        parts.join("\n\n")
    }

    /// The task's changes, from where it branched: a summary and the files.
    async fn changes_text(
        &self,
        task: &work_task::Model,
        wt: &crate::models::FolderDetail,
    ) -> String {
        // Where it branched; a task that does not know reads what is not
        // committed yet.
        let anchor = crate::work_task::engine::branch_base(&wt.path, task)
            .await
            .or_else(|| Some("HEAD".to_string()));
        let files = match anchor.as_deref() {
            Some(a) => crate::work_task::git::diff_numstat_with_untracked(&wt.path, a)
                .await
                .unwrap_or_default(),
            None => Vec::new(),
        };
        if files.is_empty() {
            return format!(
                "What changed: {} file(s), +{} −{} (the worktree is {}).",
                task.files_changed.unwrap_or(0),
                task.additions.unwrap_or(0),
                task.deletions.unwrap_or(0),
                wt.path
            );
        }
        let adds: i32 = files.iter().map(|f| f.additions).sum();
        let dels: i32 = files.iter().map(|f| f.deletions).sum();
        let mut lines = vec![format!(
            "What changed since `{}`: {} file(s), +{adds} −{dels}:",
            anchor
                .as_deref()
                .map(|a| &a[..a.len().min(12)])
                .unwrap_or("its base"),
            files.len()
        )];
        for f in files.iter().take(200) {
            lines.push(format!("  {} (+{} −{})", f.file, f.additions, f.deletions));
        }
        if files.len() > 200 {
            lines.push(format!("  … and {} more", files.len() - 200));
        }
        lines.join("\n")
    }

    /// Whether dispatch `id` is a check codeg sent out.
    pub(super) async fn check_round_of(&self, id: i32) -> Option<round_entity::Model> {
        vsvc::of_check(&self.db.conn, id).await.ok().flatten()
    }

    /// A check's news. While it runs: nothing to tell. When it ended: its
    /// card, and the round goes on (`check_settled`). A check waiting on a
    /// permission is the owner's as any session is (the caller handles it).
    pub(super) async fn check_progress(
        &self,
        d: &dispatch_entity::Model,
        round: round_entity::Model,
        note: Option<String>,
        cause: &str,
    ) {
        match d.state {
            DispatchState::Queued | DispatchState::Running | DispatchState::WaitingInput => {
                self.emit(PersonalAgentChange::Dispatch { id: d.id });
            }
            _ => self.check_settled(d, round, note, cause).await,
        }
    }

    /// A check ended: read its verdict and take the round on — stale when
    /// the task moved on, void when the worktree changed while it ran,
    /// otherwise the assistant's to conclude.
    async fn check_settled(
        &self,
        check: &dispatch_entity::Model,
        round: round_entity::Model,
        note: Option<String>,
        cause: &str,
    ) {
        let text = self.state.lock().await.check_texts.remove(&check.id);
        let report = match check.state {
            DispatchState::Completed => parse_verdict(
                text.as_deref()
                    .or(check.result_excerpt.as_deref())
                    .unwrap_or_default(),
            ),
            DispatchState::Interrupted => {
                // A restart cut it off: it is checked again.
                self.post_check_card(check, &round, None, cause).await;
                self.go_stale(&round).await;
                return;
            }
            _ => CheckReport {
                verdict: CheckVerdict::Unverified,
                evidence: format!(
                    "the check did not finish: {}",
                    note.or_else(|| check.error.clone())
                        .unwrap_or_else(|| super::engine::enum_str(&check.state))
                ),
            },
        };
        let _one = self.accept_lock.lock().await;
        let Ok(Some(round)) = vsvc::get(&self.db.conn, round.id).await else {
            return;
        };
        if round.state != VerificationState::Checking {
            self.post_check_card(check, &round, Some(&report), cause)
                .await;
            return;
        }
        if !self.round_still_current(&round).await {
            self.post_check_card(check, &round, Some(&report), cause)
                .await;
            self.go_stale(&round).await;
            return;
        }
        let Some((d, task)) = self.round_task(&round).await else {
            return;
        };
        let now = match self.worktree_of(&task).await {
            Some(wt) => crate::work_task::git::worktree_fingerprint(&wt.path)
                .await
                .ok(),
            None => None,
        };
        if now.as_deref() != Some(round.fingerprint.as_str()) {
            // It read a version that is not there any more.
            let moved = vsvc::move_round(
                &self.db.conn,
                round.id,
                &[VerificationState::Checking],
                VerificationState::Void,
                None,
                RoundWrite {
                    check_verdict: Some(Some(report.verdict)),
                    check_evidence: Some(Some(report.evidence.clone())),
                    ..Default::default()
                },
            )
            .await
            .ok()
            .flatten();
            self.post_check_card(check, &round, Some(&report), cause)
                .await;
            if let Some(r) = moved {
                self.raise_acceptance_card(&r, &d, NoticeState::Open).await;
                self.tell_acceptance(&d, &r, AcceptNews::Voided).await;
            }
            return;
        }
        let moved = vsvc::move_round(
            &self.db.conn,
            round.id,
            &[VerificationState::Checking],
            VerificationState::Deciding,
            Some(TaskAt {
                task_id: task.id,
                run_seq: round.run_seq,
            }),
            RoundWrite {
                check_verdict: Some(Some(report.verdict)),
                check_evidence: Some(Some(report.evidence.clone())),
                ..Default::default()
            },
        )
        .await
        .ok()
        .flatten();
        match moved {
            Some(r) => {
                let card = self.check_card(check, &r, Some(&report), cause).await;
                self.put_to_assistant(&r, Some(card)).await;
            }
            None => {
                self.post_check_card(check, &round, Some(&report), cause)
                    .await;
                self.go_stale(&round).await;
            }
        }
    }

    /// The work a round is about, and its task.
    async fn round_task(
        &self,
        r: &round_entity::Model,
    ) -> Option<(dispatch_entity::Model, work_task::Model)> {
        let d = svc::get_dispatch(&self.db.conn, r.dispatch_id)
            .await
            .ok()
            .flatten()?;
        let task = crate::db::service::work_task_service::get_model(&self.db.conn, d.work_task_id?)
            .await
            .ok()?;
        Some((d, task))
    }

    /// The check's result card.
    async fn check_card(
        &self,
        check: &dispatch_entity::Model,
        round: &round_entity::Model,
        report: Option<&CheckReport>,
        cause: &str,
    ) -> NewRow {
        let work = work_of(check);
        let body = match report {
            Some(r) => format!(
                "Check of dispatch #{} (round {}): {}",
                round.dispatch_id,
                round.round,
                verdict_word(r.verdict)
            ),
            None => format!(
                "Check of dispatch #{} (round {}) was interrupted; it is checked again.",
                round.dispatch_id, round.round
            ),
        };
        let mut card = NewRow::new(TimelineKind::Result, body);
        card.dispatch_id = Some(check.id);
        card.data = Some(json!({
            "mode": check.mode,
            "state": check.state,
            "ladder": Ladder::Done,
            "title": check.title,
            "agent_type": work.agent_type,
            "excerpt": check.result_excerpt,
            "gist": check.result_excerpt.as_deref().and_then(super::gist::plain_gist),
            "note": check.error,
            "cause": cause,
            "conversation_id": check.conversation_id,
            "folder_id": check.folder_id,
            "check_for": round.dispatch_id,
            "check_round": round.round,
            "verdict": report.map(|r| r.verdict),
            "evidence": report.map(|r| r.evidence.clone()),
        }));
        card
    }

    async fn post_check_card(
        &self,
        check: &dispatch_entity::Model,
        round: &round_entity::Model,
        report: Option<&CheckReport>,
        cause: &str,
    ) {
        let mut card = self.check_card(check, round, report, cause).await;
        card.segment_id = self.state.lock().await.connection_segment;
        match svc::insert_row(&self.db.conn, self.bot().await, card).await {
            Ok(c) => self.emit_rows(vec![svc::to_row(c)]),
            Err(e) => tracing::warn!("[personal_agent] check card not recorded: {e}"),
        }
        self.emit(PersonalAgentChange::Dispatch { id: check.id });
    }

    /// The round is the assistant's to conclude: wake it with an
    /// acceptance event (and the check's card, when there was a check).
    async fn put_to_assistant(&self, r: &round_entity::Model, card: Option<NewRow>) {
        let Ok(Some(d)) = svc::get_dispatch(&self.db.conn, r.dispatch_id).await else {
            return;
        };
        let verdict = match (r.unchecked, r.check_verdict) {
            (true, _) => "nobody else could check it".to_string(),
            (_, Some(v)) => format!("the check says {}", verdict_word(v)),
            (_, None) => "the check gave no verdict".to_string(),
        };
        let event = NewEvent {
            kind: ACCEPT_EVENT.into(),
            source_key: format!("acceptance:{}", r.id),
            coalesce_key: None,
            summary: format!(
                "Dispatch #{} \"{}\" is ready for your acceptance (round {}): {verdict}. Conclude \
                 it with acceptance_decide.",
                d.id, d.title, r.round
            ),
            payload: Some(json!({ "round_id": r.id, "dispatch_id": d.id })),
            wake: true,
            lineage: svc::Lineage {
                origin_bot_id: d.origin_bot_id,
                origin_row_id: d.origin_row_id,
                thread_id: d.thread_id,
                for_input: d.for_input.clone(),
            },
        };
        let bot = self.bot().await;
        match card {
            Some(mut card) => {
                card.segment_id = self.state.lock().await.connection_segment;
                match svc::insert_event_with_row(&self.db.conn, bot, event, card).await {
                    Ok(Some((_, c))) => self.emit_rows(vec![svc::to_row(c)]),
                    Ok(None) => {}
                    Err(e) => tracing::warn!("[personal_agent] acceptance not queued: {e}"),
                }
            }
            None => {
                if let Err(e) = svc::insert_new_event(&self.db.conn, bot, event).await {
                    tracing::warn!("[personal_agent] acceptance not queued: {e}");
                }
            }
        }
        self.emit(PersonalAgentChange::Dispatch { id: d.id });
        self.emit(PersonalAgentChange::Status);
        self.nudge();
    }

    /// The `<codeg-acceptance>` block of a delivery: everything the
    /// assistant concludes on, in a data tag (7.2).
    #[cfg(test)]
    pub(super) async fn acceptance_block(
        &self,
        e: &crate::db::entities::personal_agent_event::Model,
    ) -> String {
        self.acceptance_block_with(e).await.0
    }

    /// The block, and the check's result card it numbers (A1): a reply
    /// that reports the check names it.
    pub(super) async fn acceptance_block_with(
        &self,
        e: &crate::db::entities::personal_agent_event::Model,
    ) -> (String, Option<i32>) {
        let round_id = e
            .payload
            .as_deref()
            .and_then(|p| serde_json::from_str::<Value>(p).ok())
            .and_then(|p| p.get("round_id").and_then(Value::as_i64))
            .and_then(|v| i32::try_from(v).ok());
        let Some(r) = (match round_id {
            Some(id) => vsvc::get(&self.db.conn, id).await.ok().flatten(),
            None => None,
        }) else {
            return (format!("- {}", e.summary), None);
        };
        let Some((d, task)) = self.round_task(&r).await else {
            return (format!("- {}", e.summary), None);
        };
        if r.state != VerificationState::Deciding {
            let now = match r.state {
                VerificationState::Accepted => "it was accepted".to_string(),
                VerificationState::Revised => "it was sent back to be changed".to_string(),
                VerificationState::Asked => "it went to the owner".to_string(),
                _ => "the task moved on, so this round no longer applies".to_string(),
            };
            return (
                format!(
                    "- Acceptance of dispatch #{} \"{}\" (round {}): {now}. Nothing for you to decide.",
                    d.id, d.title, r.round
                ),
                None,
            );
        }
        // The check's result card, numbered for the reply to name.
        let check_row = match r.check_dispatch_id.filter(|_| !r.unchecked) {
            Some(id) => svc::latest_result_row(&self.db.conn, id)
                .await
                .ok()
                .flatten()
                .map(|row| row.id),
            None => None,
        };
        let max = self.prefs().await.accept_rounds;
        let mut lines = vec![format!(
            "Dispatch #{} \"{}\" · {} #{} · round {} of {}",
            d.id,
            d.title,
            mode_label(d.mode),
            task.id,
            r.round,
            if max == 0 {
                "any".to_string()
            } else {
                max.to_string()
            }
        )];
        if let Some(words) = self.owner_words(&d).await {
            lines.push(format!(
                "What the owner said when this work began: \"{}\"",
                cut(&words, 1_500)
            ));
        }
        lines.push(format!("What you asked of it: {}", cut(&d.prompt, 3_000)));
        lines.push(
            match d
                .done_when
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
            {
                Some(w) => format!("Done when:\n{w}"),
                None => "Done when: not written — judge it against what you asked.".into(),
            },
        );
        if let Some(x) = task
            .result_summary
            .as_deref()
            .filter(|s| !s.trim().is_empty())
        {
            lines.push(format!(
                "The work session's own summary: {}",
                cut(&super::spec_text::cards_as_text(x), 1_500)
            ));
        }
        if let Some(wt) = self.worktree_of(&task).await {
            lines.push(self.changes_text(&task, &wt).await);
        }
        if let Some(p) = preflight_text(&task) {
            lines.push(p);
        }
        if r.unchecked {
            lines.push(
                "It could not be checked: you have nothing to work with right now, so no \
                 read-only session could be opened for it. Judge it from the preflight and the \
                 work session's summary; the card will say it was not checked independently."
                    .into(),
            );
        } else {
            lines.push(format!(
                "The check (a read-only session){}: VERDICT {}",
                check_row.map(|id| format!(" [#{id}]")).unwrap_or_default(),
                r.check_verdict.map(verdict_word).unwrap_or("UNVERIFIED")
            ));
            if let Some(ev) = r.check_evidence.as_deref().filter(|s| !s.trim().is_empty()) {
                lines.push(format!("Its evidence:\n{ev}"));
            }
        }
        let earlier = self.earlier_rounds_text(&r).await;
        if !earlier.is_empty() {
            lines.push(format!("Earlier rounds:\n{earlier}"));
        }
        let block = format!(
            "<codeg-acceptance round=\"{}\" dispatch=\"{}\">\n\
This is the check of work you dispatched — the checker's report and the facts of the work, not \
the owner's words. Conclude it with `acceptance_decide` (dispatch_id {}): `accept` when it does \
what the owner wanted; `revise` with `message` — what to change: you may drop points of the check \
that go against what the owner asked or do not matter, and add what it missed that they care \
about; `ask_owner` with `question` when you cannot settle it (put in `message` what you would send \
back). You may disagree with the check: say why in `reason`.\n{}\n</codeg-acceptance>",
            r.id,
            d.id,
            d.id,
            lines
                .join("\n")
                .replace("</codeg-acceptance>", "<\\/codeg-acceptance>")
        );
        (block, check_row)
    }

    /// The earlier counted rounds of the same work, one line each.
    async fn earlier_rounds_text(&self, r: &round_entity::Model) -> String {
        let rounds = vsvc::rounds_of(&self.db.conn, r.dispatch_id)
            .await
            .unwrap_or_default();
        rounds
            .iter()
            .filter(|x| x.id != r.id && x.state.counts())
            .map(|x| {
                let what = match x.state {
                    VerificationState::Revised => format!(
                        "sent back: \"{}\"",
                        cut(x.message.as_deref().unwrap_or(""), 400)
                    ),
                    VerificationState::Accepted => "accepted".into(),
                    VerificationState::Asked => "put to the owner".into(),
                    VerificationState::Changed => "accepted, then the worktree changed".into(),
                    _ => "open".into(),
                };
                format!(
                    "- round {}: check {} — {what}",
                    x.round,
                    x.check_verdict.map(verdict_word).unwrap_or("none")
                )
            })
            .collect::<Vec<_>>()
            .join("\n")
    }

    /// The rounds a batch carries, before its events are settled.
    pub(super) async fn rounds_of_batch(&self, batch_id: i32) -> Vec<i32> {
        svc::events_of_batch(&self.db.conn, batch_id)
            .await
            .unwrap_or_default()
            .iter()
            .filter(|e| e.kind == ACCEPT_EVENT)
            .filter_map(|e| {
                e.payload
                    .as_deref()
                    .and_then(|p| serde_json::from_str::<Value>(p).ok())
                    .and_then(|p| p.get("round_id").and_then(Value::as_i64))
                    .and_then(|v| i32::try_from(v).ok())
            })
            .collect()
    }

    /// The rounds waiting on this assistant's conclusion, read from the
    /// records (so a restart loses none): one whose event a turn carried and
    /// settled without a conclusion goes by the check's verdict (7.5); one
    /// with no event of this assistant's (handed over from a deleted one) is
    /// put to it.
    pub(super) async fn settle_undecided(self: &Arc<Self>) {
        let bot = self.bot().await;
        for r in vsvc::open_rounds(&self.db.conn, Some(bot))
            .await
            .unwrap_or_default()
        {
            if r.state != VerificationState::Deciding {
                continue;
            }
            let Ok(key) =
                svc::scoped_source_key(&self.db.conn, bot, &format!("acceptance:{}", r.id)).await
            else {
                continue;
            };
            let event = crate::db::entities::personal_agent_event::Entity::find()
                .filter(crate::db::entities::personal_agent_event::Column::SourceKey.eq(key))
                .one(&self.db.conn)
                .await
                .ok()
                .flatten();
            match event {
                None => self.put_to_assistant(&r, None).await,
                Some(e)
                    if e.state == crate::db::entities::personal_agent_event::EventState::Done =>
                {
                    self.conclude_by_verdict(&r).await
                }
                Some(_) => {}
            }
        }
    }

    /// No turn could be started to conclude them: every round waiting on
    /// this assistant goes by its check's verdict.
    pub(super) async fn conclude_all_undecided(self: &Arc<Self>) {
        let bot = self.bot().await;
        for r in vsvc::open_rounds(&self.db.conn, Some(bot))
            .await
            .unwrap_or_default()
        {
            if r.state == VerificationState::Deciding {
                self.conclude_by_verdict(&r).await;
            }
        }
    }

    /// codeg's own conclusion, from the check: PASS accepts, FAIL sends it
    /// back with the check's words (as the owner's setting says), anything
    /// else is the owner's call.
    async fn conclude_by_verdict(self: &Arc<Self>, r: &round_entity::Model) {
        let evidence = r.check_evidence.clone().filter(|s| !s.trim().is_empty());
        let conclusion =
            match (r.unchecked, r.check_verdict) {
                (false, Some(CheckVerdict::Pass)) => Conclusion {
                    decision: AcceptDecision::Accept,
                    reason: None,
                    message: None,
                    question: None,
                    by: DecidedBy::Fallback,
                },
                (false, Some(CheckVerdict::Fail)) => Conclusion {
                    decision: AcceptDecision::Revise,
                    reason: None,
                    message: Some(evidence.clone().unwrap_or_else(|| {
                        "The check found it does not meet its criteria.".into()
                    })),
                    question: None,
                    by: DecidedBy::Fallback,
                },
                _ => Conclusion {
                    decision: AcceptDecision::AskOwner,
                    reason: None,
                    message: evidence.clone(),
                    question: None,
                    by: DecidedBy::Fallback,
                },
            };
        if let Err(e) = self.conclude(r.id, conclusion).await {
            tracing::info!(
                "[personal_agent] round {} not concluded by its verdict: {e}",
                r.id
            );
        }
    }

    /// Carry a conclusion out, after checking it is still about the version
    /// there (7.5). Returns what happened, in a sentence for the brain.
    pub(super) async fn conclude(
        self: &Arc<Self>,
        round_id: i32,
        c: Conclusion,
    ) -> Result<Concluded, String> {
        let _one = self.accept_lock.lock().await;
        let r = vsvc::get(&self.db.conn, round_id)
            .await
            .map_err(|e| e.to_string())?
            .ok_or("no such round of acceptance")?;
        let from: &[VerificationState] = match c.by {
            // The owner's card, or the assistant again once it was asked.
            DecidedBy::Owner | DecidedBy::Assistant => {
                &[VerificationState::Deciding, VerificationState::Asked]
            }
            DecidedBy::Fallback => &[VerificationState::Deciding],
        };
        if !from.contains(&r.state) {
            return Err(stale_words(&r));
        }
        let (d, task) = self.round_task(&r).await.ok_or("the task is gone")?;
        if task.status != WorkTaskStatus::Review || task.run_seq != r.run_seq {
            self.go_stale(&r).await;
            return Err(
                "this round no longer applies: the task moved on (sent back, retried or merged) \
                 since it was checked — nothing was done"
                    .into(),
            );
        }
        let now = match self.worktree_of(&task).await {
            Some(wt) => crate::work_task::git::worktree_fingerprint(&wt.path)
                .await
                .ok(),
            None => None,
        };
        if now.as_deref() != Some(r.fingerprint.as_str()) {
            if let Ok(Some(moved)) = vsvc::move_round(
                &self.db.conn,
                r.id,
                from,
                VerificationState::Changed,
                None,
                RoundWrite::default(),
            )
            .await
            {
                self.round_changed(&moved).await;
            }
            return Err(
                "this round no longer applies: the worktree changed after it was checked — \
                 nothing was done; its card offers to check it again"
                    .into(),
            );
        }
        let at = TaskAt {
            task_id: task.id,
            run_seq: r.run_seq,
        };
        let prefs = self.prefs().await;
        let counted = vsvc::rounds_of(&self.db.conn, d.id)
            .await
            .unwrap_or_default()
            .iter()
            .filter(|x| x.state.counts())
            .count() as u32;
        // Sent back once more than allowed: the owner's call, urgently.
        let used_up = c.decision == AcceptDecision::Revise
            && c.by != DecidedBy::Owner
            && (prefs.accept_rounds == 0 || counted >= prefs.accept_rounds);
        let ask_first = c.decision == AcceptDecision::Revise
            && c.by != DecidedBy::Owner
            && prefs.accept_revise == AskFirst::Ask;
        let base = RoundWrite {
            decision: Some(Some(c.decision)),
            reason: Some(c.reason.clone()),
            message: Some(c.message.clone()),
            question: Some(c.question.clone()),
            decided_by: Some(Some(c.by)),
            decided: true,
            ..Default::default()
        };
        match c.decision {
            AcceptDecision::Accept => {
                let moved = vsvc::move_round(
                    &self.db.conn,
                    r.id,
                    from,
                    VerificationState::Accepted,
                    Some(at),
                    base,
                )
                .await
                .map_err(|e| e.to_string())?
                .ok_or_else(|| stale_words(&r))?;
                self.raise_acceptance_card(&moved, &d, NoticeState::Acted)
                    .await;
                // A round codeg runs on a watched pull request is pushed
                // there now (7.4): the pull request's card tells the rest.
                let pr_round = super::pr_auto::pr_fix_of(&d).is_some_and(|f| !f.delivered);
                if pr_round {
                    // Off the acceptance lock: a push takes its time.
                    if let Some(me) = self.arc() {
                        let (d, task) = (d.clone(), task.clone());
                        tokio::spawn(async move { me.deliver_round(&d, &task).await });
                    }
                } else {
                    self.tell_acceptance(&d, &moved, AcceptNews::Accepted).await;
                }
                // The board lands it now, if its settings say so.
                if let Some(engine) = crate::work_task::engine() {
                    engine.sweep_merge_backlog(Some(task.folder_id)).await;
                }
                self.after_conclusion(&d, &moved).await;
                Ok(Concluded {
                    state: VerificationState::Accepted,
                    text: format!(
                        "Accepted (round {}). The owner is told it can be merged{}.",
                        moved.round,
                        if moved.unchecked {
                            "; the card says it was not checked independently"
                        } else {
                            ""
                        }
                    ),
                })
            }
            AcceptDecision::Revise if !used_up && !ask_first => {
                let message = c
                    .message
                    .clone()
                    .filter(|m| !m.trim().is_empty())
                    .ok_or("`revise` needs `message`: what to change")?;
                let moved = vsvc::move_round(
                    &self.db.conn,
                    r.id,
                    from,
                    VerificationState::Revised,
                    Some(at),
                    base,
                )
                .await
                .map_err(|e| e.to_string())?
                .ok_or_else(|| stale_words(&r))?;
                let sent = self
                    .followup_call(
                        d.id,
                        message,
                        Some("revise".into()),
                        super::dispatch::FollowupAuth::Op {
                            op_id: format!("pa-accept-{}", moved.id),
                        },
                    )
                    .await;
                match sent {
                    Ok(_) => {
                        self.raise_acceptance_card(&moved, &d, NoticeState::Acted)
                            .await;
                        self.after_conclusion(&d, &moved).await;
                        Ok(Concluded {
                            state: VerificationState::Revised,
                            text: format!(
                                "Sent back to be changed (round {}); it is checked again when it \
                                 is ready for review.",
                                moved.round
                            ),
                        })
                    }
                    Err(e) => {
                        // Not sent back: the owner's call, with what it would
                        // have said — one click sends it.
                        if let Ok(Some(asked)) = vsvc::move_round(
                            &self.db.conn,
                            moved.id,
                            &[VerificationState::Revised],
                            VerificationState::Asked,
                            None,
                            RoundWrite {
                                decision: Some(Some(AcceptDecision::AskOwner)),
                                ..Default::default()
                            },
                        )
                        .await
                        {
                            self.raise_acceptance_card(&asked, &d, NoticeState::Open)
                                .await;
                            self.tell_acceptance(&d, &asked, AcceptNews::Asked).await;
                            self.after_conclusion(&d, &asked).await;
                        }
                        Err(format!(
                            "sending it back failed ({e}); it is the owner's call now, on its \
                             acceptance card, with your message"
                        ))
                    }
                }
            }
            AcceptDecision::Revise | AcceptDecision::AskOwner => {
                // The owner's call: on the card, with what sending it back
                // would say.
                let mut write = base;
                if c.decision == AcceptDecision::Revise {
                    write.decision = Some(Some(AcceptDecision::AskOwner));
                    write.reason = Some(c.reason.clone());
                }
                let moved = vsvc::move_round(
                    &self.db.conn,
                    r.id,
                    from,
                    VerificationState::Asked,
                    Some(at),
                    write,
                )
                .await
                .map_err(|e| e.to_string())?
                .ok_or_else(|| stale_words(&r))?;
                self.raise_acceptance_card(&moved, &d, NoticeState::Open)
                    .await;
                self.tell_acceptance(
                    &d,
                    &moved,
                    if used_up {
                        AcceptNews::UsedUp
                    } else {
                        AcceptNews::Asked
                    },
                )
                .await;
                self.after_conclusion(&d, &moved).await;
                Ok(Concluded {
                    state: VerificationState::Asked,
                    text: if used_up {
                        format!(
                            "Not sent back: it has had {counted} round(s) of checks, as many as \
                             the owner allows. It is the owner's call now, on the acceptance card \
                             (with what you would send back)."
                        )
                    } else if ask_first {
                        "Not sent back: the owner sees such changes first. It is on the \
                         acceptance card, with what you would send back."
                            .into()
                    } else {
                        "Put to the owner on the acceptance card.".into()
                    },
                })
            }
        }
    }

    /// Bookkeeping after any conclusion: the pages hear of it; work that
    /// came from another assistant's message, accepted by codeg or the
    /// owner, wakes its assistant to write back (4.8) — one that concluded
    /// it itself is told so by the tool.
    async fn after_conclusion(&self, d: &dispatch_entity::Model, r: &round_entity::Model) {
        if let Some(t) = d.thread_id {
            self.thread_progress(t).await;
        }
        if r.state == VerificationState::Accepted && r.decided_by != Some(DecidedBy::Assistant) {
            if let Some(id) = d
                .for_input
                .as_deref()
                .and_then(|i| i.strip_prefix("message:"))
            {
                let by = match r.decided_by {
                    Some(DecidedBy::Owner) => "the owner accepted it on its card",
                    _ => "codeg accepted it, as its check passed",
                };
                let _ = svc::insert_new_event(
                    &self.db.conn,
                    self.bot().await,
                    NewEvent {
                        kind: SETTLED_EVENT.into(),
                        source_key: format!("acceptance-settled:{}", r.id),
                        coalesce_key: None,
                        summary: format!(
                            "Dispatch #{} \"{}\" is accepted ({by}). The work came from another \
                             assistant's message m{id}: write back to it with bot_message \
                             (reply_to m{id}) with the conclusion.",
                            d.id, d.title
                        ),
                        payload: Some(json!({ "dispatch_id": d.id, "round_id": r.id })),
                        wake: true,
                        lineage: svc::Lineage {
                            origin_bot_id: d.origin_bot_id,
                            origin_row_id: d.origin_row_id,
                            thread_id: d.thread_id,
                            for_input: d.for_input.clone(),
                        },
                    },
                )
                .await;
                self.nudge();
            }
        }
        self.emit(PersonalAgentChange::Dispatch { id: d.id });
        self.emit(PersonalAgentChange::Status);
    }

    /// `acceptance_decide`: conclude a round of acceptance (7.5). Through the
    /// ledger, keyed by the round: a repeated turn gets the first answer.
    pub(super) async fn acceptance_decide_call(self: &Arc<Self>, args: &Value) -> ToolOutcome {
        let Some(dispatch_id) = args
            .get("dispatch_id")
            .and_then(|v| {
                v.as_i64()
                    .or_else(|| v.as_str()?.trim().trim_start_matches('#').parse().ok())
            })
            .and_then(|v| i32::try_from(v).ok())
        else {
            return ToolOutcome::refused("`dispatch_id` is required");
        };
        let decision = match args.get("decision").and_then(Value::as_str).map(str::trim) {
            Some("accept") => AcceptDecision::Accept,
            Some("revise") => AcceptDecision::Revise,
            Some("ask_owner") => AcceptDecision::AskOwner,
            _ => return ToolOutcome::refused("`decision` must be accept, revise or ask_owner"),
        };
        let words = |k: &str| {
            args.get(k)
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(|s| cut(s, WORDS_CHARS))
        };
        let (reason, message, question) = (words("reason"), words("message"), words("question"));
        if decision == AcceptDecision::Revise && message.is_none() {
            return ToolOutcome::refused("`revise` needs `message`: what to change");
        }
        if decision == AcceptDecision::AskOwner && question.is_none() {
            return ToolOutcome::refused(
                "`ask_owner` needs `question`: what the owner is to decide",
            );
        }
        // Only the assistant that dispatched it accepts it.
        let Ok(Some(d)) = svc::get_dispatch(&self.db.conn, dispatch_id).await else {
            return ToolOutcome::refused(format!("dispatch #{dispatch_id} does not exist"));
        };
        if d.bot_id != Some(self.bot().await) {
            return ToolOutcome::refused(
                "this work is another assistant's to accept: the one that dispatched it",
            );
        }
        let Some(round) = self.round_for_call(dispatch_id).await else {
            return ToolOutcome::refused(format!(
                "dispatch #{dispatch_id} has no round of acceptance waiting on you"
            ));
        };
        // Disagreeing with the check takes a reason.
        let disagrees = matches!(
            (decision, round.check_verdict),
            (AcceptDecision::Accept, Some(CheckVerdict::Fail))
                | (AcceptDecision::Revise, Some(CheckVerdict::Pass))
        );
        if disagrees && reason.is_none() {
            return ToolOutcome::refused("you go against the check's verdict: say why in `reason`");
        }
        let key = format!("acceptance:{}", round.id);
        let batch = self.ledger_batch().await;
        if let Some((_, scope)) = batch.as_ref() {
            if let Some(earlier) = svc::ledger_entries(&self.db.conn, scope, &key)
                .await
                .unwrap_or_default()
                .into_iter()
                .last()
            {
                return ToolOutcome::ok(
                    format!(
                        "Done in the turn this delivery repeats: {}",
                        earlier.detail.unwrap_or_default()
                    ),
                    json!({ "dispatch_id": dispatch_id, "round_id": round.id }),
                );
            }
        }
        let outcome = self
            .conclude(
                round.id,
                Conclusion {
                    decision,
                    reason,
                    message,
                    question,
                    by: DecidedBy::Assistant,
                },
            )
            .await;
        let (text, state) = match outcome {
            Ok(c) => (c.text, json!(c.state)),
            Err(e) => {
                return ToolOutcome::refused(e);
            }
        };
        let mut text = text;
        if let Some(note) = self.reply_note(&d).await {
            text.push(' ');
            text.push_str(&note);
        }
        if let Some((batch_id, _)) = batch {
            let _ = svc::record_done_op(
                &self.db.conn,
                self.bot().await,
                &svc::LedgerSlot::in_batch(batch_id, key, super::ledger::fresh_op_id()),
                "acceptance",
                args.clone(),
                &text,
                json!({ "state": state }),
            )
            .await;
        }
        ToolOutcome::ok(
            text,
            json!({ "dispatch_id": dispatch_id, "round_id": round.id, "state": state }),
        )
    }

    /// The round a call concludes: the one this delivery carried for the
    /// dispatch; else its latest round still open — one opened before this
    /// turn began, so a call never lands on a round it has not seen.
    async fn round_for_call(&self, dispatch_id: i32) -> Option<round_entity::Model> {
        if let Some(batch) = self.current_batch().await {
            for id in self.rounds_of_batch(batch).await {
                if let Ok(Some(r)) = vsvc::get(&self.db.conn, id).await {
                    if r.dispatch_id == dispatch_id {
                        return Some(r);
                    }
                }
            }
        }
        let since = self.turn_started_at().await;
        let rounds = vsvc::rounds_of(&self.db.conn, dispatch_id).await.ok()?;
        rounds
            .into_iter()
            .rev()
            .find(|r| {
                matches!(
                    r.state,
                    VerificationState::Deciding | VerificationState::Asked
                )
            })
            .filter(|r| since.is_none_or(|s| r.updated_at <= s))
    }

    /// Work that came from another assistant's message is answered to it
    /// once accepted (4.8): the brain writes back.
    async fn reply_note(&self, d: &dispatch_entity::Model) -> Option<String> {
        let input = d.for_input.as_deref()?;
        let id = input.strip_prefix("message:")?;
        Some(format!(
            "This work came from another assistant's message m{id}: once it is settled, write \
             back to it with bot_message (reply_to m{id}) with the conclusion."
        ))
    }

    /// The owner's answer on an acceptance card: `revise` sends it back with
    /// the card's words, `accept` accepts it, `recheck` checks the worktree
    /// as it is now.
    pub(super) async fn act_on_acceptance(
        self: &Arc<Self>,
        notice: &crate::db::entities::personal_agent_notice::Model,
        action: &str,
    ) -> Result<crate::models::personal_agent::TimelineRow, String> {
        let payload: Value = serde_json::from_str(&notice.payload).unwrap_or_default();
        let round_id = payload
            .get("round_id")
            .and_then(Value::as_i64)
            .and_then(|v| i32::try_from(v).ok())
            .ok_or("the card names no round")?;
        let r = vsvc::get(&self.db.conn, round_id)
            .await
            .map_err(|e| e.to_string())?
            .ok_or("no such round of acceptance")?;
        let outcome = match action {
            "revise" => {
                let message = r
                    .message
                    .clone()
                    .filter(|m| !m.trim().is_empty())
                    .ok_or("the card has nothing to send back")?;
                self.conclude(
                    r.id,
                    Conclusion {
                        decision: AcceptDecision::Revise,
                        reason: r.reason.clone(),
                        message: Some(message),
                        question: r.question.clone(),
                        by: DecidedBy::Owner,
                    },
                )
                .await
                .map(|_| ())
            }
            "accept" => self
                .conclude(
                    r.id,
                    Conclusion {
                        decision: AcceptDecision::Accept,
                        reason: r.reason.clone(),
                        message: r.message.clone(),
                        question: r.question.clone(),
                        by: DecidedBy::Owner,
                    },
                )
                .await
                .map(|_| ()),
            "recheck" => self.recheck(&r).await,
            _ => Err(format!(
                "an acceptance card takes revise, accept or recheck, not `{action}`"
            )),
        };
        // A refusal still leaves the card showing why.
        let fresh = vsvc::get(&self.db.conn, r.id)
            .await
            .ok()
            .flatten()
            .unwrap_or(r);
        self.refresh_acceptance_card(&fresh).await;
        outcome?;
        let row_id = svc::get_notice(&self.db.conn, notice.id)
            .await
            .map_err(|e| e.to_string())?
            .and_then(|n| n.timeline_id)
            .ok_or("the card's row is missing")?;
        svc::get_row(&self.db.conn, row_id)
            .await
            .map_err(|e| e.to_string())?
            .map(svc::to_row)
            .ok_or_else(|| "the card's row is missing".to_string())
    }

    /// Check the work again as it is now — the owner asked, on a card whose
    /// round no longer matches the worktree.
    async fn recheck(self: &Arc<Self>, r: &round_entity::Model) -> Result<(), String> {
        let (d, task) = self.round_task(r).await.ok_or("the task is gone")?;
        if task.status != WorkTaskStatus::Review {
            return Err("the task is not in review any more".into());
        }
        let _one = self.accept_lock.lock().await;
        let rounds = vsvc::rounds_of(&self.db.conn, d.id)
            .await
            .unwrap_or_default();
        if rounds.iter().any(|x| x.state.is_open()) {
            return Err("it is being checked already".into());
        }
        let wt = self
            .worktree_of(&task)
            .await
            .ok_or("the task's worktree is gone")?;
        let fp = crate::work_task::git::worktree_fingerprint(&wt.path)
            .await
            .map_err(|e| e.to_string())?;
        // The card's own round is done with: it was of another version.
        if let Some(n) = r.notice_id {
            let _ =
                svc::move_notice(&self.db.conn, n, &[NoticeState::Open], NoticeState::Acted).await;
        }
        self.open_acceptance_round(&d, &task, &wt, fp, &rounds)
            .await;
        Ok(())
    }

    /// Work handed over from a deleted assistant (4.14): the latest round of
    /// each piece gets its card here, where the owner can still answer it;
    /// a round still waiting on a conclusion is put to this assistant by the
    /// next tick (`settle_undecided`).
    pub(super) async fn adopt_acceptances(&self, dispatch_ids: &[i32]) {
        let me = self.bot().await;
        for id in dispatch_ids {
            let rounds = vsvc::rounds_of(&self.db.conn, *id)
                .await
                .unwrap_or_default();
            let Some(last) = rounds.last() else {
                continue;
            };
            let Some(old) = last.notice_id else {
                continue;
            };
            let theirs = svc::get_notice(&self.db.conn, old)
                .await
                .ok()
                .flatten()
                .is_some_and(|n| n.bot_id != Some(me));
            if !theirs {
                continue;
            }
            let _ = svc::move_notice(
                &self.db.conn,
                old,
                &[NoticeState::Open],
                NoticeState::Expired,
            )
            .await;
            let Ok(Some(r)) = vsvc::write_round(
                &self.db.conn,
                last.id,
                RoundWrite {
                    notice_id: Some(None),
                    ..Default::default()
                },
            )
            .await
            else {
                continue;
            };
            let Ok(Some(d)) = svc::get_dispatch(&self.db.conn, *id).await else {
                continue;
            };
            let state = match r.state {
                VerificationState::Asked | VerificationState::Void | VerificationState::Changed => {
                    NoticeState::Open
                }
                _ => NoticeState::Acted,
            };
            self.raise_acceptance_card(&r, &d, state).await;
        }
    }

    /// The worktree changed after the round was checked or accepted.
    pub(super) async fn round_changed(&self, r: &round_entity::Model) {
        let Ok(Some(d)) = svc::get_dispatch(&self.db.conn, r.dispatch_id).await else {
            return;
        };
        if r.notice_id.is_some() {
            if let Some(n) = r.notice_id {
                let _ = svc::move_notice(
                    &self.db.conn,
                    n,
                    &[NoticeState::Acted, NoticeState::Open],
                    NoticeState::Open,
                )
                .await;
            }
            self.refresh_acceptance_card(r).await;
        } else {
            self.raise_acceptance_card(r, &d, NoticeState::Open).await;
        }
        self.tell_acceptance(&d, r, AcceptNews::Changed).await;
        self.emit(PersonalAgentChange::Dispatch { id: d.id });
        self.emit(PersonalAgentChange::Status);
    }

    /// A task this assistant accepted reached done: the merge commit goes on
    /// the round it passed in, and the owner hears it was merged.
    pub(super) async fn acceptance_landed(
        &self,
        d: &dispatch_entity::Model,
        task: &work_task::Model,
    ) -> bool {
        let Some(commit) = task.merge_commit.clone() else {
            return false;
        };
        let rounds = vsvc::rounds_of(&self.db.conn, d.id)
            .await
            .unwrap_or_default();
        let Some(r) = rounds
            .iter()
            .rev()
            .find(|r| r.state == VerificationState::Accepted && r.merge_commit.is_none())
        else {
            return false;
        };
        let Ok(Some(r)) = vsvc::write_round(
            &self.db.conn,
            r.id,
            RoundWrite {
                merge_commit: Some(Some(commit)),
                ..Default::default()
            },
        )
        .await
        else {
            return false;
        };
        self.refresh_acceptance_card(&r).await;
        self.tell_acceptance(d, &r, AcceptNews::Merged).await;
        true
    }

    // ── the card ────────────────────────────────────────────────────────────

    /// The card of round `r`: everything on it, as the page draws it.
    async fn acceptance_payload(
        &self,
        r: &round_entity::Model,
        d: &dispatch_entity::Model,
    ) -> Value {
        let work = work_of(d);
        let check = match r.check_dispatch_id {
            Some(id) => svc::get_dispatch(&self.db.conn, id).await.ok().flatten(),
            None => None,
        };
        let task = match d.work_task_id {
            Some(t) => crate::db::service::work_task_service::get_model(&self.db.conn, t)
                .await
                .ok(),
            None => None,
        };
        let rounds = vsvc::rounds_of(&self.db.conn, d.id).await.unwrap_or_default();
        // A round a later one replaced (checked again) asks nothing more.
        let superseded = rounds.last().is_some_and(|last| last.id != r.id);
        let state = match r.state {
            _ if superseded => "acted",
            VerificationState::Asked => "open",
            VerificationState::Void | VerificationState::Changed => "changed",
            VerificationState::Stale => "stale",
            _ => "acted",
        };
        let history: Vec<Value> = rounds
            .iter()
            .filter(|x| x.id != r.id && x.state.counts())
            .map(|x| {
                json!({
                    "round": x.round,
                    "state": x.state,
                    "verdict": x.check_verdict,
                    "message": x.message,
                })
            })
            .collect();
        let max = self.prefs().await.accept_rounds;
        json!({
            "notice": "acceptance",
            "state": state,
            "superseded": superseded,
            "round_id": r.id,
            "round": r.round,
            "max_rounds": max,
            "phase": r.state,
            "dispatch_id": d.id,
            "title": d.title,
            "work_task_id": d.work_task_id,
            "folder_id": d.folder_id,
            "work_agent": work.agent_type,
            "checker_agent": check.as_ref().map(|c| work_of(c).agent_type),
            "check_dispatch_id": r.check_dispatch_id,
            "verdict": r.check_verdict,
            "evidence": r.check_evidence,
            "unchecked": r.unchecked,
            "decision": r.decision,
            "decided_by": r.decided_by,
            "reason": r.reason,
            "message": r.message,
            "question": r.question,
            "history": history,
            "delivered_head": r.delivered_head,
            "merge_commit": r.merge_commit,
            "version_guaranteed": r.version_guaranteed,
            "pr_url": task.as_ref().and_then(|t| super::ladder::pr_of(t).0),
        })
    }

    /// Raise round `r`'s card (once: a round has one card; later changes
    /// rewrite it).
    async fn raise_acceptance_card(
        &self,
        r: &round_entity::Model,
        d: &dispatch_entity::Model,
        state: NoticeState,
    ) {
        if r.notice_id.is_some() {
            if let Some(n) = r.notice_id {
                let _ = svc::move_notice(
                    &self.db.conn,
                    n,
                    &[NoticeState::Open, NoticeState::Acted],
                    state,
                )
                .await;
            }
            self.refresh_acceptance_card(r).await;
            return;
        }
        let payload = self.acceptance_payload(r, d).await;
        let mut row = NewRow::new(TimelineKind::Notice, card_body(r, d));
        row.dispatch_id = Some(d.id);
        row.segment_id = self.state.lock().await.connection_segment;
        row.data = Some(payload.clone());
        let level = match r.state {
            VerificationState::Asked => NoticeLevel::Normal,
            _ => NoticeLevel::Low,
        };
        let made = svc::create_notice_with_row(
            &self.db.conn,
            self.bot().await,
            NewNotice {
                kind: NoticeKind::Acceptance,
                subject_key: Some(format!("acceptance:{}", r.id)),
                level,
                batch_id: None,
                payload,
            },
            row,
        )
        .await;
        let (notice, card) = match made {
            Ok(x) => x,
            Err(e) => {
                tracing::warn!("[personal_agent] acceptance card not recorded: {e}");
                return;
            }
        };
        if state != NoticeState::Open {
            let _ = svc::move_notice(&self.db.conn, notice.id, &[NoticeState::Open], state).await;
        }
        let _ = vsvc::write_round(
            &self.db.conn,
            r.id,
            RoundWrite {
                notice_id: Some(Some(notice.id)),
                ..Default::default()
            },
        )
        .await;
        self.emit_rows(vec![svc::to_row(card)]);
        self.emit(PersonalAgentChange::Status);
    }

    /// Rewrite round `r`'s card from the round as it is.
    pub(super) async fn refresh_acceptance_card(&self, r: &round_entity::Model) {
        let Some(notice_id) = r.notice_id else {
            return;
        };
        let Ok(Some(d)) = svc::get_dispatch(&self.db.conn, r.dispatch_id).await else {
            return;
        };
        let payload = self.acceptance_payload(r, &d).await;
        let _ = svc::set_notice_payload(&self.db.conn, notice_id, &payload).await;
        // An open question that no longer applies is closed.
        if matches!(r.state, VerificationState::Stale) {
            let _ = svc::move_notice(
                &self.db.conn,
                notice_id,
                &[NoticeState::Open],
                NoticeState::Expired,
            )
            .await;
        }
        if let Ok(Some(n)) = svc::get_notice(&self.db.conn, notice_id).await {
            if let Some(row_id) = n.timeline_id {
                let _ = svc::update_row_data(
                    &self.db.conn,
                    row_id,
                    Some(card_body(r, &d)),
                    Some(payload),
                )
                .await;
                if let Ok(Some(row)) = svc::get_row(&self.db.conn, row_id).await {
                    self.emit_rows(vec![svc::to_row(row)]);
                }
            }
        }
        self.emit(PersonalAgentChange::Status);
    }

    /// The owner hears of a round: ready to merge, merged, their call, out
    /// of rounds, void, changed.
    async fn tell_acceptance(
        &self,
        d: &dispatch_entity::Model,
        r: &round_entity::Model,
        news: AcceptNews,
    ) {
        let Some(host) = self.host_ref() else {
            return;
        };
        let text = super::reach::glimpse(&d.title);
        let (kind, what) = match news {
            // The board lands it at once: the owner hears when it merged.
            AcceptNews::Accepted if self.lands_on_its_own(d).await => return,
            AcceptNews::Accepted => {
                let pr = d.work_task_id.is_some()
                    && match d.work_task_id {
                        Some(t) => {
                            crate::db::service::work_task_service::get_model(&self.db.conn, t)
                                .await
                                .ok()
                                .is_some_and(|t| t.delivery.is_some())
                        }
                        None => false,
                    };
                (
                    "acceptance",
                    if pr {
                        super::reach::What::AcceptedPr { text }
                    } else {
                        super::reach::What::Accepted { text }
                    },
                )
            }
            AcceptNews::Merged => ("acceptance", super::reach::What::Merged { text }),
            AcceptNews::Asked => ("acceptance", super::reach::What::AcceptAsk { text }),
            AcceptNews::UsedUp => ("used_up", super::reach::What::UsedUp { text }),
            AcceptNews::Voided | AcceptNews::Changed => {
                ("acceptance", super::reach::What::AcceptVoid { text })
            }
        };
        let bot = self.bot().await;
        let row_id = match r.notice_id {
            Some(n) => svc::get_notice(&self.db.conn, n)
                .await
                .ok()
                .flatten()
                .and_then(|n| n.timeline_id),
            None => None,
        };
        host.tell(super::reach::News {
            key: format!("acceptance:{bot}:{}:{}", r.id, news.word()),
            bot_id: bot,
            kind,
            what,
            link: Some(super::reach::NotifyLink::Bot {
                bot_id: bot,
                row_id,
            }),
            need: None,
        })
        .await;
    }
}

impl PersonalAgentEngine {
    /// Whether the board merges this work on its own once accepted: its
    /// project has auto-merge on and it was not delivered to a pull request.
    async fn lands_on_its_own(&self, d: &dispatch_entity::Model) -> bool {
        let Some(t) = d.work_task_id else {
            return false;
        };
        let Ok(task) = crate::db::service::work_task_service::get_model(&self.db.conn, t).await
        else {
            return false;
        };
        if task.delivery.is_some() {
            return false;
        }
        crate::db::service::work_task_service::settings_get_effective(&self.db.conn, task.folder_id)
            .await
            .is_ok_and(|s| s.auto_merge)
    }
}

/// What the owner is told of a round.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AcceptNews {
    Accepted,
    Merged,
    Asked,
    UsedUp,
    Voided,
    Changed,
}

impl AcceptNews {
    fn word(self) -> &'static str {
        match self {
            AcceptNews::Accepted => "accepted",
            AcceptNews::Merged => "merged",
            AcceptNews::Asked => "asked",
            AcceptNews::UsedUp => "used_up",
            AcceptNews::Voided => "voided",
            AcceptNews::Changed => "changed",
        }
    }
}

/// Why a conclusion was refused, by where its round stands.
fn stale_words(r: &round_entity::Model) -> String {
    match r.state {
        VerificationState::Accepted => "this round was accepted already".into(),
        VerificationState::Revised => "this round was sent back already".into(),
        VerificationState::Asked => "this round is the owner's call now".into(),
        VerificationState::Checking => "this round is still being checked".into(),
        _ => "this round no longer applies — nothing was done".into(),
    }
}

/// The task's preflight light, as the check and the assistant read it.
fn preflight_text(task: &work_task::Model) -> Option<String> {
    let p: WorkTaskPreflight = serde_json::from_str(task.preflight.as_deref()?).ok()?;
    Some(match p.status.as_str() {
        "passed" => format!("Preflight `{}`: passed.", p.command),
        "failed" => format!(
            "Preflight `{}`: FAILED{}{}",
            p.command,
            p.exit_code
                .map(|c| format!(" (exit {c})"))
                .unwrap_or_default(),
            p.output_tail
                .as_deref()
                .map(|t| format!(":\n{}", tail(t, 2_000)))
                .unwrap_or_default()
        ),
        other => format!("Preflight `{}`: {other}.", p.command),
    })
}

/// The card's text, for the timeline and `timeline_read`.
fn card_body(r: &round_entity::Model, d: &dispatch_entity::Model) -> String {
    let verdict = if r.unchecked {
        "not checked independently".to_string()
    } else {
        format!(
            "check {}",
            r.check_verdict.map(verdict_word).unwrap_or("UNVERIFIED")
        )
    };
    let what = match r.state {
        VerificationState::Accepted => "accepted",
        VerificationState::Revised => "sent back to be changed",
        VerificationState::Asked => "the owner's call",
        VerificationState::Void => "void: the worktree changed while it was checked",
        VerificationState::Changed => "no longer valid: the worktree changed after its check",
        VerificationState::Stale => "no longer applies",
        _ => "open",
    };
    format!(
        "{}\nAcceptance (round {}): {verdict} — {what}.",
        d.title, r.round
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_last_verdict_line_decides_and_what_follows_is_the_evidence() {
        let text = "I read the diff.\n\nFormat: VERDICT: PASS | FAIL | UNVERIFIED\n\n**VERDICT: FAIL**\n- evidence: src/a.rs:12 still panics\n- `cargo test` exit 101";
        let r = parse_verdict(text);
        assert_eq!(r.verdict, CheckVerdict::Fail);
        assert!(r.evidence.contains("src/a.rs:12"));
        assert!(!r.evidence.contains("I read the diff"));
        assert_eq!(
            parse_verdict("VERDICT：pass\n- 证据：全部通过").verdict,
            CheckVerdict::Pass
        );
        assert_eq!(
            parse_verdict("- VERDICT: UNVERIFIED").verdict,
            CheckVerdict::Unverified
        );
        // No verdict at all is unverified, the text its evidence.
        let none = parse_verdict("Looks fine to me.");
        assert_eq!(none.verdict, CheckVerdict::Unverified);
        assert_eq!(none.evidence, "Looks fine to me.");
        // The format line alone is no verdict.
        assert_eq!(
            parse_verdict("End with VERDICT: PASS | FAIL | UNVERIFIED").verdict,
            CheckVerdict::Unverified
        );
        // A verdict last, its reasons above it.
        let last = parse_verdict("- tests pass\n- no API change\nVERDICT: PASS");
        assert_eq!(last.verdict, CheckVerdict::Pass);
        assert!(last.evidence.contains("no API change"));
    }

    #[test]
    fn a_task_waiting_on_its_acceptance_is_being_checked_not_mergeable() {
        assert_eq!(
            ladder_with(Ladder::Mergeable, Some(AcceptView::Checking)),
            Ladder::Checking
        );
        assert_eq!(
            ladder_with(Ladder::Mergeable, Some(AcceptView::Changed)),
            Ladder::Checking
        );
        assert_eq!(
            ladder_with(Ladder::Mergeable, Some(AcceptView::Asked)),
            Ladder::WaitingYou
        );
        assert_eq!(
            ladder_with(Ladder::Mergeable, Some(AcceptView::Accepted)),
            Ladder::Mergeable
        );
        assert_eq!(ladder_with(Ladder::Mergeable, None), Ladder::Mergeable);
        assert_eq!(
            ladder_with(Ladder::Merged, Some(AcceptView::Checking)),
            Ladder::Merged
        );
    }
}
