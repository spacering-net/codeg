//! Forge workbench commands: list a folder's issues/PRs, trigger a work task
//! from one, reverse-lookup task chips for visible rows, and map a folder to
//! its forge repository. `_core` fns are mode-agnostic (Tauri + Axum).
//!
//! Trust boundary (the load-bearing part): the client only supplies
//! COORDINATES (host, repo, number) and a display snapshot. Everything a task
//! will trust — canonical URL, api base, account identity, the source key,
//! the prompt with its untrusted-data envelope — is derived server-side, and
//! the folder's actual `origin` remote must match the claimed repository
//! before a card is minted. UI gating is presentation; the gates live here.

use serde::{Deserialize, Serialize};

use crate::app_error::AppCommandError;
use crate::commands::folders::get_folder_core;
use crate::db::service::work_task_service::{self, ForgeCreateOutcome};
use crate::db::AppDatabase;
use crate::forge::envelope::{forge_untrusted_envelope, ForgeSnapshot};
use crate::forge::{
    self, CountFilters, ForgeError, ForgeIssueList, ForgeItemKind, ForgeProvider, ForgeSourceMeta,
    ForgeTab, ListFilters, ListIssuesRequest,
};
use crate::models::{WorkTaskConfig, WorkTaskDraft, WorkTaskInfo, WorkTaskSource};
use crate::web::event_bridge::{emit_event, EventEmitter, WorkTaskChange, WORK_TASK_CHANGED_EVENT};

/// Hard cap for one reverse-lookup batch (a screen shows ~30 rows).
const LOOKUP_KEYS_CAP: usize = 100;
/// Task card titles inherit the automation convention: 80 chars.
const TITLE_CAP: usize = 80;

#[derive(Debug, Clone, Serialize)]
pub struct ForgeRemote {
    pub server_host: String,
    pub owner_repo: String,
    pub remote_url: String,
    /// Which forge this host is, decided HERE (see `forge::provider_for_host`)
    /// and handed to the client for display and for building the reverse-lookup
    /// keys. The client never picks it: that choice selects a credential.
    pub provider: ForgeProvider,
    /// Whether `provider` is known rather than assumed — see
    /// `HostProfile::recognized`. `false` says the remote parsed fine but names
    /// a host codeg has no reason to think is GitHub or GitLab, so the panel
    /// says so up front instead of spending a request that comes back as a raw
    /// API failure.
    pub supported: bool,
}

/// Client-supplied coordinates of the work item being triggered.
#[derive(Debug, Clone, Deserialize)]
pub struct ForgeTaskSourceInput {
    /// "issue" | "pr".
    pub kind: String,
    /// What the client believes this host is. Checked against the server's own
    /// derivation and otherwise unused — a disagreement means the workbench is
    /// looking at stale account settings, which is worth saying out loud
    /// rather than silently minting provenance the client cannot match.
    pub provider: String,
    pub server_host: String,
    #[serde(default)]
    pub account_id: Option<String>,
    pub owner_repo: String,
    pub number: i64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ForgeTaskDraft {
    pub folder_id: i32,
    pub source: ForgeTaskSourceInput,
    pub snapshot: ForgeSnapshot,
    /// How to handle the item — a template NAME, never template text (see the
    /// trust boundary above). `None` falls back to the kind's default so
    /// older clients keep triggering the way they always did.
    ///
    /// A raw string rather than the enum: a name this build no longer offers
    /// has to be ANSWERED (see [`ForgeScenario::resolve`]) rather than rejected
    /// by the deserializer, and "unknown variant `investigate`" is not an
    /// answer a browser tab opened before the update can act on.
    #[serde(default)]
    pub scenario: Option<String>,
    /// Extra instruction the user typed in the trigger dialog.
    #[serde(default)]
    pub instruction: Option<String>,
    /// Comment the outcome back on this item once the task finishes — the
    /// trigger dialog's own box. See [`resolve_writeback`] for what an absent
    /// answer means (it is NOT the dialog's default).
    #[serde(default)]
    pub writeback: Option<bool>,
    /// Per-task agent override; `None` inherits folder settings.
    #[serde(default)]
    pub agent_type: Option<String>,
    /// Deliberately create a second live task for the same work item.
    #[serde(default)]
    pub force: bool,
}

/// What the user wants done with the work item. Each variant selects a
/// server-side instruction template and decides whether the task delivers a
/// report or code changes; the client only ever names one of these.
///
/// Every issue template opens the same way — establish that the reported
/// problem is actually there before acting on it — because the alternative is
/// a task that confidently fixes, or plans around, something that was never
/// broken. That check is a STEP of the work, not a mode to pick: an
/// "investigate only" choice next to these made the verification look optional
/// in the two flows that need it most.
///
/// The "report" scenarios close their loop the same way: the prompt tells the
/// agent the user may RETURN the task for the follow-up work (implement the
/// reviewed plan, apply review findings), which is exactly the engine's
/// existing review → follow-up cycle in the same worktree — including, for a
/// PR task, the push-back-to-branch delivery.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ForgeScenario {
    /// Issue: confirm the problem, then implement or fix it (the issue
    /// default).
    Fix,
    /// Issue: confirm the problem, then write an implementation plan and stop;
    /// the user reviews the plan, then returns the task for implementation.
    PlanFirst,
    /// PR/MR: review the change and fix on top (the PR default).
    ReviewFix,
    /// PR/MR: review only — the reply is the deliverable.
    ReviewOnly,
}

/// Wire names this build no longer offers, each with what to tell a client
/// still showing it.
///
/// Retired names are REFUSED, never remapped onto a survivor: "investigate
/// only" promised the agent would not touch the code, and both flows that
/// absorbed its verification step may commit. Silently upgrading a read-only
/// request into a change-producing one is the same mistake as answering a
/// write-back question nobody was asked (see [`resolve_writeback`]).
const RETIRED_SCENARIOS: &[(&str, &str)] = &[(
    "investigate",
    "\"investigate only\" is no longer a separate choice — fixing and planning both verify the \
     issue first now",
)];

impl ForgeScenario {
    /// The scenario a wire name selects, or `None` for a name this build does
    /// not offer (retired, from a newer build, or simply wrong).
    fn parse(name: &str) -> Option<Self> {
        Some(match name {
            "fix" => Self::Fix,
            "plan_first" => Self::PlanFirst,
            "review_fix" => Self::ReviewFix,
            "review_only" => Self::ReviewOnly,
            _ => return None,
        })
    }

    /// Resolve the selection against the item kind: default when absent,
    /// reject a name this build does not offer, and reject a scenario that
    /// belongs to the other kind (a stale or crafted client — same reason the
    /// provider claim is checked, worth saying out loud rather than minting a
    /// task whose prompt contradicts its item).
    fn resolve(selected: Option<&str>, is_pr: bool) -> Result<Self, AppCommandError> {
        let Some(name) = selected.map(str::trim).filter(|name| !name.is_empty()) else {
            return Ok(if is_pr { Self::ReviewFix } else { Self::Fix });
        };
        let scenario = Self::parse(name).ok_or_else(|| {
            let reason = RETIRED_SCENARIOS
                .iter()
                .find(|(retired, _)| *retired == name)
                .map(|(_, why)| (*why).to_string())
                .unwrap_or_else(|| format!("unknown way to handle this item: \"{name}\""));
            AppCommandError::invalid_input(format!(
                "{reason} — refresh the workbench and try again"
            ))
        })?;
        let fits = match scenario {
            Self::Fix | Self::PlanFirst => !is_pr,
            Self::ReviewFix | Self::ReviewOnly => is_pr,
        };
        if !fits {
            return Err(AppCommandError::invalid_input(format!(
                "scenario \"{}\" does not apply to {} — refresh the workbench and try again",
                scenario.as_str(),
                if is_pr { "a proposed change" } else { "an issue" }
            )));
        }
        Ok(scenario)
    }

    /// Report scenarios put the deliverable in the reply, not in commits —
    /// recorded on the task config so the engine's worktree guard grants a
    /// matching licence instead of "commit as you like".
    fn is_report(self) -> bool {
        matches!(self, Self::PlanFirst | Self::ReviewOnly)
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::Fix => "fix",
            Self::PlanFirst => "plan_first",
            Self::ReviewFix => "review_fix",
            Self::ReviewOnly => "review_only",
        }
    }
}

/// The instruction block for one scenario. Pure and composed HERE — clients
/// never hand us prompt text (the dialog's extra instruction is appended as
/// plain user input by the caller, at the same trust level as any chat).
///
/// Wording discipline: milestone/completion reporting is NOT mentioned — the
/// engine appends its "Work task context" block to every launch, and that
/// block already asks for `task_progress`/`task_complete` (conditionally,
/// which is more accurate: not every agent gets those tools). Each template
/// instead states the goal, the deliverable, and how its loop closes, and the
/// "report" templates keep any commit allowance explicit so the engine's
/// report licence ("commit only what the task's instructions explicitly
/// allow") has a defined answer to point at.
///
/// Layout discipline: paragraphs are separated by a BLANK line, never a bare
/// one. This text is read twice — by the agent, and by the user in the
/// transcript, where a work task's prompt renders verbatim with the sender's
/// own line breaks. A single newline between two paragraphs makes the whole
/// order read as one wall of prose there.
///
/// Shape of the issue templates: anchor, then verify, then the branch where
/// verification FAILS, then the work, then what the reply must contain. The
/// failure branch comes before the work on purpose — an agent that reads
/// "confirm it, then fix it" as one instruction treats confirmation as a
/// formality on the way to the fix, and the whole point of the step is that
/// it has an outcome which ends the task.
///
/// That branch also has to say it is a SUCCESS, and this part is load-bearing
/// rather than encouragement. An agent holding the companion's task tools is
/// told to report `blocked` when it "could not complete the task", the engine
/// turns that verdict into a failed task, and `complete_task` only accepts a
/// task in review — so an agent that files the honest "it does not reproduce"
/// answer as a blocker leaves the user with a red card and no way to accept
/// the very outcome this template asked for. Naming the outcome here keeps the
/// classification with the instruction that produces it, and keeps the real
/// blockers (a project that will not build, a missing credential) pointed at
/// the failure path where they belong.
fn forge_instruction(
    scenario: ForgeScenario,
    provider: ForgeProvider,
    number: i64,
    url: &str,
) -> String {
    let noun = provider.change_noun();
    match scenario {
        ForgeScenario::Fix => format!(
            "Handle issue #{number} ({url}): confirm it is real, then fix it.\n\nStart by \
             establishing that the problem is actually there — this step is required, not a \
             formality. Read the fenced external content below, then check it against the \
             code in this worktree: reproduce the reported behaviour (a failing command, test \
             or minimal case), or otherwise show from the code where and why it goes wrong, \
             and identify the cause with file and line references. For a feature request, \
             confirm the behaviour is genuinely missing rather than already available under \
             another name or setting.\n\nIf you cannot confirm it, do NOT change any code: a \
             fix invented for a problem that is not there is worse than no fix at all, and it \
             costs the reviewer more to discover. Report what you ran, what you saw instead, \
             the most likely explanation (already fixed, works as designed, wrong version, \
             missing information), and what you would need to take it further — then leave \
             the worktree clean and stop. The user can send this task back with more detail. \
             Ending there is a SUCCESSFUL outcome for this task, not a blocked one: \"it does \
             not reproduce, and here is everything I checked\" is the work product. Report \
             this task as blocked only if something stopped you from checking at all — the \
             project would not build, a service or credential you needed was \
             missing.\n\nOnce it is confirmed, fix the cause you identified rather than the \
             symptom, and keep the change as small as the problem needs. Then verify it: show \
             that what you reproduced no longer happens, and run whatever this project would \
             (build, tests, lint — whatever applies).\n\nSay in your reply what you confirmed \
             and how, what you changed and why, and how you verified it."
        ),
        ForgeScenario::PlanFirst => format!(
            "Plan issue #{number} ({url}): confirm it is real, then plan the change. This \
             turn delivers a plan, not an implementation.\n\nStart by establishing that the \
             problem is actually there — this step is required, not a formality. Read the \
             fenced external content below, then check it against the code in this worktree: \
             reproduce the reported behaviour or show from the code where and why it goes \
             wrong, and identify the cause with file and line references. For a feature \
             request, confirm the behaviour is genuinely missing rather than already \
             available under another name or setting. Run whatever you need to prove it, but \
             change no files — the evidence goes in the report, not into commits (this task \
             delivers nothing to merge, and a committed \"proof\" would read as work to \
             land).\n\nIf you cannot confirm it, do NOT write a plan for it: a plan for a \
             problem that is not there sends someone off to build the wrong thing. Report \
             what you ran, what you saw instead, the most likely explanation, and what you \
             would need to take it further, and stop there. Ending there is a SUCCESSFUL \
             outcome for this task, not a blocked one: \"there is nothing to plan yet, and \
             here is why\" is the work product. Report this task as blocked only if something \
             stopped you from checking at all — the project would not build, a service or \
             credential you needed was missing.\n\nOnce it is confirmed, write \
             the implementation plan: the approach and why, the files and surfaces to touch, \
             the risks and open questions, and how the change will be verified. Do NOT start \
             implementing, and change no files.\n\nPut the evidence and the full plan in your \
             reply. The user reviews it and then sends this task back for you to implement it \
             in this same worktree — write the plan you would want to execute from."
        ),
        ForgeScenario::ReviewFix => format!(
            "Review {noun} #{number} ({url}) and fix what needs fixing.\n\nThis worktree is \
             already checked out at the {noun}'s head commit, so its changes are here and \
             your commits go on top of them — they are pushed back to the same {noun} branch \
             when the task is accepted. Read the fenced external content below to understand \
             what the {noun} claims to do, then review its changes against the base branch: \
             correctness, tests, security, and whether they deliver what is \
             promised.\n\nJudge the approach, not just the diff. Is the change warranted at \
             all; is this the best way to solve it given the rest of this codebase; and is it \
             production-ready as it stands? A diff can be flawless line by line and still be \
             the wrong design. If the design itself is what is wrong, say so and propose the \
             better one — do not rewrite the {noun} into it, because a rewrite its author \
             never asked for is not a review.\n\nFix the problems that are worth fixing in \
             place, and say in your reply what you found, what you fixed, what you left for \
             the author, and your verdict on whether this is ready for production."
        ),
        ForgeScenario::ReviewOnly => format!(
            "Review {noun} #{number} ({url}) — review only: report findings, do not change \
             the code.\n\nThis worktree is already checked out at the {noun}'s head commit, \
             so its changes are here to read, build and test. Read the fenced external \
             content below to understand what the {noun} claims to do, then review its \
             changes: correctness, tests, security, and whether they deliver what is \
             promised. Commit nothing.\n\nJudge the approach, not just the diff. Is the \
             change warranted at all; is this the best way to solve it given the rest of this \
             codebase; and is it production-ready as it stands? A diff can be flawless line \
             by line and still be the wrong design, and saying so is the most useful thing a \
             review can do.\n\nDeliver the review in your reply: each finding with its \
             location, severity and a suggested fix, a verdict on whether this is ready for \
             production, and — if the approach itself should change — what you would do \
             instead. If the user wants findings fixed, they can send this task back — \
             commits made then are pushed back to the {noun} branch once accepted."
        ),
    }
}

/// Section header for the user's own note, in the same `—— … ——` style the
/// engine's appended blocks use (`—— Work task context ——`). It earns its
/// keep twice: it tells the agent where the template stops and the user's own
/// words start, and it keeps that note from reading as the tail of the
/// paragraph above it in the transcript.
const USER_NOTE_HEADER: &str = "—— Additional instruction from the user ——";

/// Section header for the workbench's standing instructions (forge settings).
/// Separate from [`USER_NOTE_HEADER`] on purpose: one is policy that applies
/// to every task of this scenario, the other is what the user wants for THIS
/// item, and an agent reading a single merged section cannot tell which of the
/// two it is being asked to weigh more.
const STANDING_HEADER: &str = "—— Standing instructions ——";

/// The whole instruction block: the scenario's template, then the workbench's
/// standing instructions, then whatever the user typed in the trigger dialog —
/// general to specific, so the last word belongs to the box that was filled in
/// while looking at this item. Blank (or absent) sections leave the template
/// alone, unchanged.
fn instruction_block(
    scenario: ForgeScenario,
    provider: ForgeProvider,
    number: i64,
    url: &str,
    standing: Option<&str>,
    note: Option<&str>,
) -> String {
    let mut text = forge_instruction(scenario, provider, number, url);
    push_section(&mut text, STANDING_HEADER, standing);
    push_section(&mut text, USER_NOTE_HEADER, note);
    text
}

/// Append `—— header ——` and its body as a new section, or nothing at all if
/// the body is blank. The blank line is what keeps the section from reading as
/// the tail of the paragraph above it (see the layout note on
/// [`forge_instruction`]).
fn push_section(text: &mut String, header: &str, body: Option<&str>) {
    let Some(body) = body.map(str::trim).filter(|s| !s.is_empty()) else {
        return;
    };
    text.push_str("\n\n");
    text.push_str(header);
    text.push('\n');
    text.push_str(body);
}

/// The trigger dialog's write-back answer, resolved for storage.
///
/// The dialog's box ships CHECKED, and it always sends its state explicitly —
/// so an absent field does not mean "the default", it means the request came
/// from a client that never showed the question (a browser tab loaded before
/// this shipped, or a script). Posting into a thread other people are reading
/// on behalf of someone who was never asked is the one mistake worth being
/// asymmetric about, so silence is the answer to a missing one.
fn resolve_writeback(asked: Option<bool>) -> bool {
    asked.unwrap_or(false)
}

/// Discriminated result: a dedup hit and a folder/repo mismatch are answers
/// the dialog acts on, not errors.
#[derive(Debug, Serialize)]
#[serde(tag = "outcome", rename_all = "snake_case")]
pub enum ForgeCreateResult {
    Created { task: WorkTaskInfo },
    Duplicate { existing: WorkTaskInfo },
    FolderMismatch { folder_remote: Option<ForgeRemote> },
}

/// One reverse-lookup row: the latest task (any state) for a source key.
#[derive(Debug, Serialize)]
pub struct ForgeTaskLink {
    pub source_key: String,
    pub task_id: i32,
    pub status: crate::models::WorkTaskStatus,
    pub verdict: Option<String>,
    pub updated_at: chrono::DateTime<chrono::Utc>,
}

// ── shared business logic (both modes) ──────────────────────────────────────

/// The folder's `origin` remote, parsed into forge coordinates. `None` when
/// there is no origin or its URL is not a recognizable forge repo.
pub async fn folder_forge_remote_core(
    db: &AppDatabase,
    folder_id: i32,
) -> Result<Option<ForgeRemote>, AppCommandError> {
    let folder = get_folder_core(db, folder_id).await?;
    let output = crate::process::tokio_command("git")
        .args(["-C", &folder.path, "remote", "get-url", "origin"])
        .output()
        .await
        .map_err(|e| AppCommandError::io_error("failed to run git").with_detail(e.to_string()))?;
    if !output.status.success() {
        return Ok(None);
    }
    let url = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let Some((server_host, owner_repo)) = forge::parse_remote_url(&url) else {
        return Ok(None);
    };
    let profile = forge::host_profile(&db.conn, &server_host).await;
    Ok(Some(ForgeRemote {
        server_host,
        // A GitLab mounted under a relative URL root puts that mount path in
        // front of every repository path a git remote carries, while no API
        // path has it. Dropping it here is what keeps ONE spelling of the
        // repository in the source key, the API calls, the links and the push.
        owner_repo: forge::strip_base_path(&owner_repo, &profile.base_path),
        // Redacted, not raw: a remote URL can carry `user:token@` from
        // whatever configured it, and this value crosses to the client.
        remote_url: redact_userinfo(&url),
        provider: profile.provider,
        supported: profile.recognized,
    }))
}

/// Strip any `user:password@` from a URL before it leaves the backend. Git
/// remotes configured elsewhere (or by an older codeg) can embed a token, and
/// this string is shown and logged.
fn redact_userinfo(url: &str) -> String {
    let Some((scheme, rest)) = url.split_once("://") else {
        return url.to_string();
    };
    match rest.split_once('@') {
        // Only the authority may contain userinfo; an `@` after the first `/`
        // is part of the path and stays.
        Some((userinfo, after)) if !userinfo.contains('/') => {
            format!("{scheme}://{after}")
        }
        _ => url.to_string(),
    }
}

/// Resolve the folder's repository AND the credential to read it with — the
/// two things every workbench read needs and neither of which the client may
/// supply.
async fn resolve_folder_repo(
    db: &AppDatabase,
    folder_id: i32,
    account_id: Option<&str>,
) -> Result<(ForgeRemote, forge::ResolvedAuth), AppCommandError> {
    let remote = folder_forge_remote_core(db, folder_id)
        .await?
        .ok_or_else(|| {
            AppCommandError::configuration_missing(
                "this folder has no recognizable forge remote (origin)",
            )
        })?;
    let auth =
        forge::resolve_forge_auth(&db.conn, remote.provider, &remote.server_host, account_id)
            .await?;
    Ok((remote, auth))
}

pub async fn forge_list_issues_core(
    db: &AppDatabase,
    folder_id: i32,
    filters: ListFilters,
) -> Result<ForgeIssueList, AppCommandError> {
    let (remote, auth) =
        resolve_folder_repo(db, folder_id, filters.account_id.as_deref()).await?;
    // The repository is an ARGUMENT here, never a field of `filters`: it is
    // derived from the folder's own remote, so there is nothing for a client to
    // claim. Paging is clamped inside each client (`ListIssuesRequest::clamped`)
    // and the text/label filters are normalized by `new`.
    let request = ListIssuesRequest::new(remote.owner_repo, filters);
    Ok(match remote.provider {
        ForgeProvider::GitHub => forge::github::list_issues(&auth, &request).await?,
        ForgeProvider::GitLab => forge::gitlab::list_issues(&auth, &request).await?,
        ForgeProvider::Gitea => forge::gitea::list_issues(&auth, &request).await?,
    })
}

/// One tab's item count under a set of filters — a badge on the workbench's
/// Issues/PR switcher.
///
/// **One tab, and specifically the tab the user is NOT looking at.** The active
/// tab's count arrives inside the list response the page already paid for, so
/// asking for it again would make every filter change cost three search calls
/// against a quota of thirty a MINUTE — decoration competing for quota with the
/// content it decorates. Paired with a frontend that remembers both numbers per
/// filter set, this makes switching tabs and turning pages cost nothing at all.
///
/// Its own command rather than a probe fired from the frontend: every list call
/// re-derives the folder's remote (which spawns `git`) and re-resolves the
/// account, so the sequencing has to happen behind one resolution.
///
/// `None` — never an error — for a forge that declines to count, a probe that
/// failed, or a search GitHub itself calls incomplete. A badge is decoration:
/// losing one costs that badge and nothing else, not the other badge and
/// certainly not the list, which reports its own failures with its own error.
pub async fn forge_tab_count_core(
    db: &AppDatabase,
    folder_id: i32,
    tab: ForgeTab,
    filters: CountFilters,
) -> Result<Option<i64>, AppCommandError> {
    let (remote, auth) = resolve_folder_repo(db, folder_id, filters.account_id.as_deref()).await?;
    let request = ListIssuesRequest::new(remote.owner_repo.clone(), filters.probe(tab));
    let listed = match remote.provider {
        ForgeProvider::GitHub => forge::github::list_issues(&auth, &request).await,
        ForgeProvider::GitLab => forge::gitlab::list_issues(&auth, &request).await,
        ForgeProvider::Gitea => forge::gitea::list_issues(&auth, &request).await,
    };
    Ok(listed.ok().and_then(|page| page.trustworthy_count()))
}

/// One page of an item's discussion, for the detail panel.
///
/// Its own command rather than a field on the list row, and this is a real
/// trade rather than tidiness: a thread is one request PER ITEM, so folding it
/// into the list would spend thirty of them to draw a page whose reader opens
/// at most one. Asking only when the panel opens keeps the cost proportional
/// to what is actually read — and on GitHub it lands on the core quota
/// (5000/hour) instead of the 30-per-minute one the list itself lives on, so
/// opening item after item cannot starve the list behind it.
///
/// The item's COORDINATES come from the client (kind and number, the same two
/// values the trigger takes) and everything else is derived here — repository
/// from the folder's own remote, credentials from the resolved account. Both
/// are validated before they reach a provider client: on GitLab the kind picks
/// the collection, so a wrong one reads a real item that is not this one.
pub async fn forge_list_comments_core(
    db: &AppDatabase,
    folder_id: i32,
    filters: forge::CommentFilters,
) -> Result<forge::ForgeCommentList, AppCommandError> {
    let (kind, number, page, per_page) = filters.resolve().map_err(AppCommandError::from)?;
    let (remote, auth) = resolve_folder_repo(db, folder_id, filters.account_id.as_deref()).await?;
    Ok(match remote.provider {
        // No kind: a pull request IS an issue at GitHub, and both are served
        // from `/issues/{n}/comments` (see `github::list_comments`).
        ForgeProvider::GitHub => {
            forge::github::list_comments(&auth, &remote.owner_repo, number, page, per_page).await?
        }
        ForgeProvider::GitLab => {
            forge::gitlab::list_notes(&auth, &remote.owner_repo, kind, number, page, per_page)
                .await?
        }
        // Nor here, and for the same reason — Gitea models a pull request as an
        // issue exactly as GitHub does.
        ForgeProvider::Gitea => {
            forge::gitea::list_comments(&auth, &remote.owner_repo, number, page, per_page).await?
        }
    })
}

/// Post one comment on an item, and hand back the comment as the forge stored
/// it.
///
/// The RESULT is what the panel appends to the thread it is already showing —
/// not the text that was typed. They differ in every field that matters: the
/// id (which is the React key and the de-duplication handle when the next page
/// arrives), the author as the forge resolved it from the token, the timestamp,
/// and the permalink. Echoing the draft back would show a comment that has no
/// anchor and duplicates itself on the next refresh.
///
/// Not retried anywhere on the way down: a retried POST posts twice, and a
/// thread other people are reading is the wrong place to be approximately
/// once.
pub async fn forge_create_comment_core(
    db: &AppDatabase,
    folder_id: i32,
    draft: forge::CommentDraft,
) -> Result<forge::ForgeComment, AppCommandError> {
    let (kind, number, body) = draft.resolve().map_err(AppCommandError::from)?;
    let (remote, auth) = resolve_folder_repo(db, folder_id, draft.account_id.as_deref()).await?;
    Ok(match remote.provider {
        // No kind: a pull request IS an issue at GitHub, and one endpoint
        // serves both (`/pulls/{n}/comments` is the review-comment collection,
        // which is a different thing entirely).
        ForgeProvider::GitHub => {
            forge::github::create_comment(&auth, &remote.owner_repo, number, &body).await?
        }
        ForgeProvider::GitLab => {
            forge::gitlab::create_note(&auth, &remote.owner_repo, kind, number, &body).await?
        }
        ForgeProvider::Gitea => {
            forge::gitea::create_comment(&auth, &remote.owner_repo, number, &body).await?
        }
    })
}

/// Close or reopen one item, and hand back the row the forge now serves.
///
/// The returned row is the point. A local flip of `state` would be a guess:
/// the item may have been closed in the browser a moment ago, a lock may have
/// refused the write, and on GitHub a pull request that got merged in between
/// comes back `merged` rather than `closed`. What the panel adopts is the
/// forge's answer, which is the only version of the row that is true.
pub async fn forge_set_item_state_core(
    db: &AppDatabase,
    folder_id: i32,
    request: forge::StateChangeRequest,
) -> Result<forge::ForgeIssueRow, AppCommandError> {
    let (kind, number, action) = request.resolve().map_err(AppCommandError::from)?;
    let (remote, auth) = resolve_folder_repo(db, folder_id, request.account_id.as_deref()).await?;
    Ok(match remote.provider {
        ForgeProvider::GitHub => {
            forge::github::set_item_state(&auth, &remote.owner_repo, kind, number, action).await?
        }
        ForgeProvider::GitLab => {
            forge::gitlab::set_item_state(&auth, &remote.owner_repo, kind, number, action).await?
        }
        ForgeProvider::Gitea => {
            forge::gitea::set_item_state(&auth, &remote.owner_repo, kind, number, action).await?
        }
    })
}

/// Open a new issue on the folder's repository.
///
/// The repository is derived from the folder's own remote like every other
/// forge write — there is no repository field on the draft, so a client cannot
/// file an issue against somewhere else with this account's token.
pub async fn forge_create_issue_core(
    db: &AppDatabase,
    folder_id: i32,
    draft: forge::NewIssueDraft,
) -> Result<forge::ForgeIssueRow, AppCommandError> {
    let resolved = draft.resolve().map_err(AppCommandError::from)?;
    let (remote, auth) = resolve_folder_repo(db, folder_id, draft.account_id.as_deref()).await?;
    Ok(match remote.provider {
        ForgeProvider::GitHub => {
            forge::github::create_issue(&auth, &remote.owner_repo, &resolved).await?
        }
        ForgeProvider::GitLab => {
            forge::gitlab::create_issue(&auth, &remote.owner_repo, &resolved).await?
        }
        ForgeProvider::Gitea => {
            forge::gitea::create_issue(&auth, &remote.owner_repo, &resolved).await?
        }
    })
}

/// One proposed change's branches, size, mergeability and CI.
///
/// Asked only when the panel opens on a PULL REQUEST, and for the same reason
/// the comment thread is its own call: a list page holds thirty rows whose
/// reader opens at most one, and folding two or three extra requests into every
/// row would spend them on rows nobody looks at. Everything it costs is on the
/// core quota, not GitHub search's thirty-a-minute one.
pub async fn forge_change_detail_core(
    db: &AppDatabase,
    folder_id: i32,
    query: forge::ChangeQuery,
) -> Result<forge::ForgeChangeDetail, AppCommandError> {
    let number = query.resolve().map_err(AppCommandError::from)?;
    let (remote, auth) = resolve_folder_repo(db, folder_id, query.account_id.as_deref()).await?;
    Ok(match remote.provider {
        ForgeProvider::GitHub => {
            forge::github::change_detail(&auth, &remote.owner_repo, number).await?
        }
        ForgeProvider::GitLab => {
            forge::gitlab::change_detail(&auth, &remote.owner_repo, number).await?
        }
        ForgeProvider::Gitea => {
            forge::gitea::change_detail(&auth, &remote.owner_repo, number).await?
        }
    })
}

/// One page of the files a proposed change touches.
///
/// Paged rather than whole: a large change lists thousands of files, and the
/// panel shows a scannable "what does this touch" rather than a diff. The
/// contents are deliberately NOT carried — reviewing a diff is what the task
/// worktree and the app's own diff view are for.
pub async fn forge_change_files_core(
    db: &AppDatabase,
    folder_id: i32,
    query: forge::ChangeFilesQuery,
) -> Result<forge::ForgeChangedFileList, AppCommandError> {
    let (number, page, per_page) = query.resolve().map_err(AppCommandError::from)?;
    let (remote, auth) = resolve_folder_repo(db, folder_id, query.account_id.as_deref()).await?;
    Ok(match remote.provider {
        ForgeProvider::GitHub => {
            forge::github::list_change_files(&auth, &remote.owner_repo, number, page, per_page)
                .await?
        }
        ForgeProvider::GitLab => {
            forge::gitlab::list_change_files(&auth, &remote.owner_repo, number, page, per_page)
                .await?
        }
        ForgeProvider::Gitea => {
            forge::gitea::list_change_files(&auth, &remote.owner_repo, number, page, per_page)
                .await?
        }
    })
}

/// Who a comment on this folder's repository would be posted as.
///
/// The same resolution every write here goes through, answered instead of
/// spent — so the face the composer shows is by construction the account
/// [`forge_create_comment_core`] would use, pinned `account_id` and all. A UI
/// that picked the default account from the settings list would name the wrong
/// person on any folder that is not on it.
///
/// Local and cheap: no request leaves the machine. The token is resolved along
/// the way (its absence is a real failure — that comment could not be posted
/// either) and then dropped: [`forge::ForgeIdentity`] carries a name and a
/// picture, nothing more.
pub async fn forge_identity_core(
    db: &AppDatabase,
    folder_id: i32,
    account_id: Option<String>,
) -> Result<forge::ForgeIdentity, AppCommandError> {
    let (_, auth) = resolve_folder_repo(db, folder_id, account_id.as_deref()).await?;
    Ok(forge::ForgeIdentity::of(&auth))
}

/// Which merge methods the folder's repository permits.
///
/// A repository fact, not a change's, which is why it is not a field on
/// [`forge_change_detail_core`]: folding it in would spend a request on every
/// change opened merely to read it. The panel asks once, and only when it is
/// about to draw the merge button.
pub async fn forge_merge_options_core(
    db: &AppDatabase,
    folder_id: i32,
    account_id: Option<String>,
) -> Result<forge::ForgeMergeOptions, AppCommandError> {
    let (remote, auth) = resolve_folder_repo(db, folder_id, account_id.as_deref()).await?;
    Ok(match remote.provider {
        ForgeProvider::GitHub => forge::github::merge_options(&auth, &remote.owner_repo).await?,
        ForgeProvider::GitLab => forge::gitlab::merge_options(&auth, &remote.owner_repo).await?,
        ForgeProvider::Gitea => forge::gitea::merge_options(&auth, &remote.owner_repo).await?,
    })
}

/// Land one proposed change, and hand back the row the forge now serves.
///
/// The returned row is the point, exactly as it is for
/// [`forge_set_item_state_core`]: the panel adopts the forge's copy rather than
/// flipping `state` locally. A merge is the one write where that matters most —
/// GitHub has no merged STATE (a merged pull request reports `closed`, and only
/// `merged_at` tells them apart), so a local guess would paint a change that
/// just landed as one somebody abandoned.
///
/// `Ok(None)` means the merge SUCCEEDED and the row could not be read back.
/// Distinguishing that from an error is the difference between "it landed, the
/// list will catch up" and inviting somebody to merge the same change twice.
pub async fn forge_merge_change_core(
    db: &AppDatabase,
    folder_id: i32,
    request: forge::ChangeMergeRequest,
) -> Result<Option<forge::ForgeIssueRow>, AppCommandError> {
    let (number, method, head_sha) = request.resolve().map_err(AppCommandError::from)?;
    let (remote, auth) = resolve_folder_repo(db, folder_id, request.account_id.as_deref()).await?;
    let head_sha = head_sha.as_deref();
    Ok(match remote.provider {
        ForgeProvider::GitHub => {
            forge::github::merge_change(&auth, &remote.owner_repo, number, method, head_sha).await?
        }
        ForgeProvider::GitLab => {
            forge::gitlab::merge_change(&auth, &remote.owner_repo, number, method, head_sha).await?
        }
        ForgeProvider::Gitea => {
            forge::gitea::merge_change(&auth, &remote.owner_repo, number, method, head_sha).await?
        }
    })
}

/// The repository's label vocabulary, for the workbench's label filter. Its
/// own command rather than a field on the list response: the labels change far
/// more slowly than the list, so the frontend fetches them once per repository
/// instead of on every page turn.
pub async fn forge_list_labels_core(
    db: &AppDatabase,
    folder_id: i32,
    account_id: Option<String>,
) -> Result<forge::ForgeLabelList, AppCommandError> {
    let (remote, auth) = resolve_folder_repo(db, folder_id, account_id.as_deref()).await?;
    Ok(match remote.provider {
        ForgeProvider::GitHub => forge::github::list_labels(&auth, &remote.owner_repo).await?,
        ForgeProvider::GitLab => forge::gitlab::list_labels(&auth, &remote.owner_repo).await?,
        ForgeProvider::Gitea => forge::gitea::list_labels(&auth, &remote.owner_repo).await?,
    })
}

pub async fn work_task_create_from_forge_core(
    emitter: &EventEmitter,
    db: &AppDatabase,
    draft: ForgeTaskDraft,
) -> Result<ForgeCreateResult, AppCommandError> {
    let source = &draft.source;
    let item_kind = ForgeItemKind::parse(&source.kind).map_err(AppCommandError::from)?;
    let is_pr = item_kind == ForgeItemKind::Change;
    let claimed_provider =
        ForgeProvider::parse(&source.provider).map_err(AppCommandError::from)?;

    let server_host = source.server_host.trim().to_ascii_lowercase();
    let owner_repo = forge::normalize_repo(&source.owner_repo).ok_or_else(|| {
        AppCommandError::invalid_input(format!("bad repository path: {}", source.owner_repo))
    })?;

    // The folder's actual origin must BE the claimed repository — a task's
    // whole execution (worktree, diff, later delivery) happens against this
    // folder, so a mismatch here would run the issue against a stranger repo.
    let remote = match folder_forge_remote_core(db, draft.folder_id).await? {
        Some(remote)
            if remote.server_host == server_host
                && forge::same_repo(&remote.owner_repo, &owner_repo) =>
        {
            remote
        }
        folder_remote => return Ok(ForgeCreateResult::FolderMismatch { folder_remote }),
    };
    // Derived, not taken: which forge this is decides which token gets spent
    // and which endpoints a whole task's worth of writes will go to. The
    // client's claim only has to agree.
    let provider = remote.provider;
    if claimed_provider != provider {
        return Err(AppCommandError::invalid_input(format!(
            "this folder's remote is a {} host, not {} — refresh the workbench and try again",
            provider.as_str(),
            claimed_provider.as_str()
        )));
    }

    // Account resolution pins the identity the task will keep using (writeback
    // and delivery read it from source_meta — never "the current default").
    let auth =
        forge::resolve_forge_auth(&db.conn, provider, &server_host, source.account_id.as_deref())
            .await?;

    // A proposed change has to be hydrated before a card can exist: the list
    // rows carry no refs at all, and without head/base there is nothing to
    // check out and nothing to push back to.
    let pull = if is_pr {
        let pull = match provider {
            ForgeProvider::GitHub => {
                forge::deliver::get_pull(&auth, &owner_repo, source.number).await?
            }
            ForgeProvider::GitLab => {
                forge::gitlab::get_merge_request(&auth, &owner_repo, source.number).await?
            }
            ForgeProvider::Gitea => {
                forge::gitea::get_pull(&auth, &owner_repo, source.number).await?
            }
        };
        // Refused here, at the only moment the user can still choose something
        // else, rather than at the end of a task whose work has nowhere to go.
        forge::deliver::pull_is_workable(provider, &pull, &owner_repo)
            .map_err(AppCommandError::invalid_input)?;
        Some(pull)
    } else {
        None
    };

    let key = forge::source_key(
        provider.as_str(),
        &server_host,
        &owner_repo,
        item_kind.key_segment(),
        source.number,
    )
    .map_err(AppCommandError::from)?;
    // The link is stored on the card, shown to the user and put in the agent's
    // prompt. It comes from the resolved API base, not from the bare host: a
    // self-hosted instance on `http://` or a non-default port would otherwise
    // get a link that does not open.
    let url = provider.item_url(
        &forge::web_origin(&auth),
        &owner_repo,
        item_kind,
        source.number,
    );
    let meta = ForgeSourceMeta {
        provider,
        server_host: server_host.clone(),
        api_base: auth.api_base.clone(),
        account_id: auth.account_id.clone(),
        owner_repo: owner_repo.clone(),
        number: source.number,
        url: url.clone(),
        title: truncate_chars(snapshot_title(&draft.snapshot), 400),
        base_ref: pull.as_ref().map(|p| p.base_ref.clone()),
        head_ref: pull.as_ref().map(|p| p.head_ref.clone()),
        // The OID the user was looking at. The checkout pins to it rather than
        // to whatever the branch points at by then, so a push that lands while
        // the task is queued cannot silently change what gets worked on.
        head_sha: pull.as_ref().map(|p| p.head_sha.clone()),
        head_repo: pull.as_ref().map(|p| p.head_repo.clone()),
        result_pr: None,
        // Always stamped explicitly, both answers: the engine reads it as the
        // user's decision, and an absent field there means "an older row that
        // never had the choice" — a meaning a fresh task must not borrow.
        writeback: Some(resolve_writeback(draft.writeback)),
    };

    // Prompt composed HERE, server-side: instruction block + envelope block.
    // The client names a scenario; the template text is ours (the dialog's
    // extra instruction is plain user input in its own paragraph, same trust
    // level as any chat).
    let scenario = ForgeScenario::resolve(draft.scenario.as_deref(), is_pr)?;
    // The panel's standing instructions ride in from settings rather than from
    // the request, for the same reason the templates do: prompt text is not
    // something a client hands us. Resolved for THIS folder — its own row if it
    // has one, else the global one. A failed read is not a failed trigger: an
    // unreadable preferences blob composes the prompt it always did.
    let standing = forge::settings::load_effective(&db.conn, draft.folder_id)
        .await
        .unwrap_or_default()
        .standing_prompt(scenario.as_str());
    let instruction = instruction_block(
        scenario,
        provider,
        source.number,
        &url,
        standing.as_deref(),
        draft.instruction.as_deref(),
    );
    let envelope = forge_untrusted_envelope(provider.as_str(), &draft.snapshot);
    let blocks = vec![
        serde_json::to_value(crate::acp::types::PromptInputBlock::Text {
            text: instruction.clone(),
        })
        .map_err(|e| AppCommandError::invalid_input(e.to_string()))?,
        serde_json::to_value(crate::acp::types::PromptInputBlock::Text { text: envelope })
            .map_err(|e| AppCommandError::invalid_input(e.to_string()))?,
    ];
    let config = WorkTaskConfig {
        prompt_blocks: blocks,
        display_text: instruction,
        agent_type: draft
            .agent_type
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string),
        mode_id: None,
        config_values: Default::default(),
        label_snapshot: None,
        deliverable: scenario
            .is_report()
            .then(|| crate::models::DELIVERABLE_REPORT.to_string()),
        // A forge task's base is not the user's to pick here: a pull request
        // brings its own (the review's base ref), and an issue starts from the
        // project folder's checkout.
        base_branch: None,
    };
    let task_draft = WorkTaskDraft {
        folder_id: draft.folder_id,
        title: truncate_chars(
            &format!("#{} · {}", source.number, snapshot_title(&draft.snapshot)),
            TITLE_CAP,
        ),
        config: serde_json::to_value(&config)
            .map_err(|e| AppCommandError::invalid_input(e.to_string()))?,
    };
    let source_row = WorkTaskSource {
        kind: if is_pr {
            forge::SOURCE_KIND_PR
        } else {
            forge::SOURCE_KIND_ISSUE
        }
        .to_string(),
        key,
        meta: serde_json::to_value(&meta)
            .map_err(|e| AppCommandError::invalid_input(e.to_string()))?,
    };

    match work_task_service::create_from_forge(&db.conn, task_draft, source_row, draft.force)
        .await?
    {
        ForgeCreateOutcome::Created(task) => {
            emit_event(
                emitter,
                WORK_TASK_CHANGED_EVENT,
                WorkTaskChange::Upsert { id: task.id },
            );
            crate::commands::work_task::nudge_pump(task.folder_id);
            Ok(ForgeCreateResult::Created { task })
        }
        ForgeCreateOutcome::Duplicate(existing) => {
            Ok(ForgeCreateResult::Duplicate { existing })
        }
    }
}

/// The panel's preferences, every scope at once. Its own call rather than a
/// field on the list response: the page reads them once on mount and again
/// after the settings dialog saves, while lists are re-fetched on every filter
/// change. All scopes rather than the folder's, because the dialog shows one
/// folder while saying whether that folder is following the global row — which
/// takes both.
pub async fn forge_settings_get_core(
    db: &AppDatabase,
) -> Result<forge::settings::ForgeSettingsStore, AppCommandError> {
    Ok(forge::settings::load(&db.conn).await?)
}

/// Save ONE scope and hand back every scope as stored — trimmed, blanks
/// dropped — so the dialog shows the stored truth instead of the draft it sent.
///
/// `folder_id = None` is the global row; `settings = None` drops a folder's own
/// row so it follows the global one again.
pub async fn forge_settings_set_core(
    db: &AppDatabase,
    folder_id: Option<i32>,
    settings: Option<forge::settings::ForgePanelSettings>,
) -> Result<forge::settings::ForgeSettingsStore, AppCommandError> {
    Ok(forge::settings::save(&db.conn, folder_id, settings).await?)
}

pub async fn work_task_lookup_by_source_core(
    db: &AppDatabase,
    mut source_keys: Vec<String>,
) -> Result<Vec<ForgeTaskLink>, AppCommandError> {
    source_keys.truncate(LOOKUP_KEYS_CAP);
    let rows = work_task_service::lookup_latest_by_source_keys(&db.conn, &source_keys).await?;
    Ok(rows
        .into_iter()
        .map(|(source_key, m)| ForgeTaskLink {
            source_key,
            task_id: m.id,
            status: m.status,
            verdict: m.verdict,
            updated_at: m.updated_at,
        })
        .collect())
}

fn snapshot_title(snapshot: &ForgeSnapshot) -> &str {
    let trimmed = snapshot.title.trim();
    if trimmed.is_empty() {
        "(untitled)"
    } else {
        trimmed
    }
}

fn truncate_chars(input: &str, cap: usize) -> String {
    if input.chars().count() <= cap {
        return input.to_string();
    }
    input.chars().take(cap).collect()
}

// ── Tauri wrappers (desktop mode) ───────────────────────────────────────────

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn folder_forge_remote(
    db: tauri::State<'_, AppDatabase>,
    folder_id: i32,
) -> Result<Option<ForgeRemote>, AppCommandError> {
    folder_forge_remote_core(&db, folder_id).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn forge_list_issues(
    db: tauri::State<'_, AppDatabase>,
    folder_id: i32,
    query: ListFilters,
) -> Result<ForgeIssueList, AppCommandError> {
    forge_list_issues_core(&db, folder_id, query).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn forge_tab_count(
    db: tauri::State<'_, AppDatabase>,
    folder_id: i32,
    tab: ForgeTab,
    filters: CountFilters,
) -> Result<Option<i64>, AppCommandError> {
    forge_tab_count_core(&db, folder_id, tab, filters).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn forge_list_labels(
    db: tauri::State<'_, AppDatabase>,
    folder_id: i32,
    account_id: Option<String>,
) -> Result<forge::ForgeLabelList, AppCommandError> {
    forge_list_labels_core(&db, folder_id, account_id).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn forge_list_comments(
    db: tauri::State<'_, AppDatabase>,
    folder_id: i32,
    filters: forge::CommentFilters,
) -> Result<forge::ForgeCommentList, AppCommandError> {
    forge_list_comments_core(&db, folder_id, filters).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn forge_create_comment(
    db: tauri::State<'_, AppDatabase>,
    folder_id: i32,
    draft: forge::CommentDraft,
) -> Result<forge::ForgeComment, AppCommandError> {
    forge_create_comment_core(&db, folder_id, draft).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn forge_set_item_state(
    db: tauri::State<'_, AppDatabase>,
    folder_id: i32,
    request: forge::StateChangeRequest,
) -> Result<forge::ForgeIssueRow, AppCommandError> {
    forge_set_item_state_core(&db, folder_id, request).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn forge_create_issue(
    db: tauri::State<'_, AppDatabase>,
    folder_id: i32,
    draft: forge::NewIssueDraft,
) -> Result<forge::ForgeIssueRow, AppCommandError> {
    forge_create_issue_core(&db, folder_id, draft).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn forge_change_detail(
    db: tauri::State<'_, AppDatabase>,
    folder_id: i32,
    query: forge::ChangeQuery,
) -> Result<forge::ForgeChangeDetail, AppCommandError> {
    forge_change_detail_core(&db, folder_id, query).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn forge_change_files(
    db: tauri::State<'_, AppDatabase>,
    folder_id: i32,
    query: forge::ChangeFilesQuery,
) -> Result<forge::ForgeChangedFileList, AppCommandError> {
    forge_change_files_core(&db, folder_id, query).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn forge_identity(
    db: tauri::State<'_, AppDatabase>,
    folder_id: i32,
    account_id: Option<String>,
) -> Result<forge::ForgeIdentity, AppCommandError> {
    forge_identity_core(&db, folder_id, account_id).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn forge_merge_options(
    db: tauri::State<'_, AppDatabase>,
    folder_id: i32,
    account_id: Option<String>,
) -> Result<forge::ForgeMergeOptions, AppCommandError> {
    forge_merge_options_core(&db, folder_id, account_id).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn forge_merge_change(
    db: tauri::State<'_, AppDatabase>,
    folder_id: i32,
    request: forge::ChangeMergeRequest,
) -> Result<Option<forge::ForgeIssueRow>, AppCommandError> {
    forge_merge_change_core(&db, folder_id, request).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn work_task_create_from_forge(
    app: tauri::AppHandle,
    db: tauri::State<'_, AppDatabase>,
    draft: ForgeTaskDraft,
) -> Result<ForgeCreateResult, AppCommandError> {
    work_task_create_from_forge_core(&EventEmitter::Tauri(app), &db, draft).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn work_task_lookup_by_source(
    db: tauri::State<'_, AppDatabase>,
    source_keys: Vec<String>,
) -> Result<Vec<ForgeTaskLink>, AppCommandError> {
    work_task_lookup_by_source_core(&db, source_keys).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn forge_settings_get(
    db: tauri::State<'_, AppDatabase>,
) -> Result<forge::settings::ForgeSettingsStore, AppCommandError> {
    forge_settings_get_core(&db).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn forge_settings_set(
    db: tauri::State<'_, AppDatabase>,
    folder_id: Option<i32>,
    settings: Option<forge::settings::ForgePanelSettings>,
) -> Result<forge::settings::ForgeSettingsStore, AppCommandError> {
    forge_settings_set_core(&db, folder_id, settings).await
}

// AppCommandError ← ForgeError conversion lives in `forge::mod` (used above
// via `?` and the explicit map for `source_key`).
#[allow(unused)]
fn _assert_forge_error_converts(err: ForgeError) -> AppCommandError {
    err.into()
}

#[cfg(test)]
mod tests {
    use super::*;

    const URL: &str = "https://github.com/acme/app/issues/7";

    fn all_scenarios() -> [ForgeScenario; 4] {
        [
            ForgeScenario::Fix,
            ForgeScenario::PlanFirst,
            ForgeScenario::ReviewFix,
            ForgeScenario::ReviewOnly,
        ]
    }

    /// Absent scenario = the kind's historical default, so pre-scenario
    /// clients (and the plain "Start" path) keep minting the same tasks.
    #[test]
    fn scenario_defaults_per_kind_and_rejects_the_other_kinds() {
        assert_eq!(
            ForgeScenario::resolve(None, false).unwrap(),
            ForgeScenario::Fix
        );
        assert_eq!(
            ForgeScenario::resolve(None, true).unwrap(),
            ForgeScenario::ReviewFix
        );
        // A field that arrived as an empty string is the same "nothing was
        // picked" the absent one is, not a name to look up.
        assert_eq!(
            ForgeScenario::resolve(Some("  "), false).unwrap(),
            ForgeScenario::Fix
        );
        for s in all_scenarios() {
            let issue_side = matches!(s, ForgeScenario::Fix | ForgeScenario::PlanFirst);
            assert!(ForgeScenario::resolve(Some(s.as_str()), !issue_side).is_ok());
            let err = ForgeScenario::resolve(Some(s.as_str()), issue_side).unwrap_err();
            assert!(
                err.to_string().contains("does not apply"),
                "cross-kind {s:?} must be refused: {err}"
            );
        }
    }

    /// Wire names are snake_case — what the dialog sends — and every one of
    /// them survives the round trip through `as_str`.
    #[test]
    fn scenario_parses_from_wire_names() {
        for s in all_scenarios() {
            assert_eq!(ForgeScenario::parse(s.as_str()), Some(s));
        }
        assert_eq!(ForgeScenario::parse("rewrite"), None);
    }

    /// A retired name is REFUSED with something the user can act on, and
    /// never remapped: "investigate only" asked for a turn that touches no
    /// code, and both surviving issue flows may commit. A stale tab must not
    /// have its read-only request quietly upgraded into a change-producing
    /// task.
    #[test]
    fn a_retired_scenario_is_refused_by_name_not_remapped() {
        let err = ForgeScenario::resolve(Some("investigate"), false).unwrap_err();
        let text = err.to_string();
        assert!(text.contains("investigate only"), "{text}");
        assert!(text.contains("verify the issue first"), "{text}");
        assert!(text.contains("refresh the workbench"), "{text}");

        // An unrecognized name gets the generic version of the same answer.
        let unknown = ForgeScenario::resolve(Some("rewrite"), false).unwrap_err();
        assert!(unknown.to_string().contains("\"rewrite\""), "{unknown}");
        assert!(
            unknown.to_string().contains("refresh the workbench"),
            "{unknown}"
        );

        // Every retired name still has to be one this build cannot resolve —
        // an entry left behind after a name was brought back would produce an
        // error message for a scenario that works.
        for (name, _) in RETIRED_SCENARIOS {
            assert_eq!(ForgeScenario::parse(name), None, "{name} is live again");
        }
    }

    /// Milestone/completion reporting belongs to the engine's "Work task
    /// context" block, which every launch gets appended — a second, blunter
    /// copy here would just contradict its "if available" phrasing on agents
    /// that never get those tools.
    #[test]
    fn no_template_mentions_the_reporting_tools() {
        for s in all_scenarios() {
            for provider in [ForgeProvider::GitHub, ForgeProvider::GitLab] {
                let text = forge_instruction(s, provider, 7, URL);
                assert!(
                    !text.contains("task_progress") && !text.contains("task_complete"),
                    "{s:?} duplicates the engine's reporting instructions"
                );
                assert!(text.contains("#7") && text.contains(URL), "{s:?} lost its anchor");
                assert!(
                    text.contains("fenced external content"),
                    "{s:?} must point at the envelope"
                );
            }
        }
    }

    /// Every issue template makes verification a STEP with an outcome, not a
    /// preamble: it says the check is required, and it gives the failure
    /// branch its own paragraph BEFORE the work, ending in "stop". Without
    /// that branch an agent reads "confirm it, then fix it" as one instruction
    /// and produces a fix for a problem it never found — which is exactly what
    /// removing the separate "investigate only" choice has to keep out.
    #[test]
    fn the_issue_templates_require_confirmation_before_acting() {
        for s in [ForgeScenario::Fix, ForgeScenario::PlanFirst] {
            for provider in [ForgeProvider::GitHub, ForgeProvider::GitLab] {
                let text = forge_instruction(s, provider, 7, URL);
                assert!(text.contains("confirm it is real"), "{s:?} buries the check");
                assert!(
                    text.contains("required, not a formality"),
                    "{s:?} leaves the check optional"
                );
                assert!(
                    text.contains("reproduce the reported behaviour"),
                    "{s:?} does not say what confirming means"
                );
                assert!(
                    text.contains("file and line references"),
                    "{s:?} accepts a hunch as confirmation"
                );
                // A feature request has nothing to reproduce; without this the
                // "required" step reads as impossible and gets skipped whole.
                assert!(
                    text.contains("For a feature request"),
                    "{s:?} has no answer for a request that is not a defect"
                );

                let branch = text
                    .find("If you cannot confirm it")
                    .unwrap_or_else(|| panic!("{s:?} has no failure branch"));
                assert!(
                    text[branch..].starts_with("If you cannot confirm it, do NOT"),
                    "{s:?} does not say what must not happen"
                );
                assert!(text[branch..].contains("stop"), "{s:?} never ends the task");
                // Before the work, not after it: an instruction that arrives
                // once the fix is written is a retraction, not a gate.
                let work = text.find("Once it is confirmed").expect("the work paragraph");
                assert!(branch < work, "{s:?} states the gate after the work");

                // …and that ending is a SUCCESS. An agent that files it as a
                // blocker fails the task instead (engine `verdict_blocked`),
                // and a failed task cannot be accepted — `complete_task` takes
                // review tasks only. Real blockers keep the failure path.
                let outcome = &text[branch..work];
                assert!(
                    outcome.contains("SUCCESSFUL outcome for this task, not a blocked one"),
                    "{s:?} leaves the honest \"it does not reproduce\" answer looking like a \
                     failure"
                );
                assert!(
                    outcome.contains("blocked only if something stopped you from checking at all"),
                    "{s:?} gives real blockers nowhere to go"
                );
            }
        }
    }

    /// Each scenario states its own goal, and the report ones close their
    /// loop: the reply carries the deliverable, and the user can return the
    /// task for the follow-up work.
    #[test]
    fn templates_carry_their_scenario_contract() {
        let gh = ForgeProvider::GitHub;

        let fix = forge_instruction(ForgeScenario::Fix, gh, 7, URL);
        assert!(fix.starts_with("Handle issue #7"));
        assert!(fix.contains("fix the cause you identified rather than the symptom"));
        assert!(fix.contains("run whatever this project would"));

        let plan = forge_instruction(ForgeScenario::PlanFirst, gh, 7, URL);
        assert!(plan.contains("a plan, not an implementation"));
        assert!(plan.contains("Do NOT start implementing"));
        assert!(plan.contains("sends this task back"));
        // Proof goes INTO the report — a committed "proof" would be a landable
        // diff on a task whose acceptance path must stay "complete", and the
        // engine refuses completion while landable changes exist.
        assert!(plan.contains("change no files"));
        assert!(plan.contains("nothing to merge"));
        assert!(!plan.contains("may commit"));

        let review_fix = forge_instruction(ForgeScenario::ReviewFix, gh, 7, URL);
        assert!(review_fix.starts_with("Review pull request #7"));
        assert!(review_fix.contains("pushed back to the same pull request branch"));
        assert!(review_fix.contains("against the base branch"));
        assert!(review_fix.contains("security"));
        assert!(review_fix.contains("what you left for the author"));

        let review_only = forge_instruction(ForgeScenario::ReviewOnly, gh, 7, URL);
        assert!(review_only.contains("review only"));
        assert!(review_only.contains("Commit nothing"));
        assert!(review_only.contains("send this task back"));
        assert!(!review_only.contains("Fix the problems"));
        // GitLab wording follows the provider's own noun.
        let review_gl = forge_instruction(ForgeScenario::ReviewOnly, ForgeProvider::GitLab, 7, URL);
        assert!(review_gl.contains("merge request"));
        assert!(!review_gl.contains("pull request"));
    }

    /// Both review scenarios weigh the DESIGN, not only the diff — a change
    /// can be correct line by line and still be unnecessary, built the wrong
    /// way, or not ready to run in production, and those are the findings a
    /// reviewer is actually wanted for.
    ///
    /// The two differ in what they may then do about it: "review & fix" is
    /// explicitly fenced off from rewriting the change into its own preferred
    /// design (its commits are pushed back to the author's branch), and
    /// "review only" touches nothing at all.
    #[test]
    fn the_review_templates_judge_the_approach_and_production_readiness() {
        for provider in [ForgeProvider::GitHub, ForgeProvider::GitLab] {
            for s in [ForgeScenario::ReviewFix, ForgeScenario::ReviewOnly] {
                let text = forge_instruction(s, provider, 7, URL);
                assert!(text.contains("Judge the approach, not just the diff"), "{s:?}");
                assert!(text.contains("warranted at all"), "{s:?}");
                assert!(text.contains("best way to solve it"), "{s:?}");
                assert!(text.contains("production-ready as it stands"), "{s:?}");
                assert!(text.contains("ready for production"), "{s:?}");
            }
        }
        // The guard rail belongs to the scenario that CAN commit: without it
        // "the design is wrong" plus a write licence reads as permission to
        // replace someone else's branch with your own version of it.
        let fix = forge_instruction(ForgeScenario::ReviewFix, ForgeProvider::GitHub, 7, URL);
        assert!(fix.contains("do not rewrite the pull request into it"));
        assert!(fix.contains("a rewrite its author never asked for is not a review"));
        // Review-only has nothing to fence off — it commits nothing at all —
        // so it must not carry a sentence about what its commits may do.
        let only = forge_instruction(ForgeScenario::ReviewOnly, ForgeProvider::GitHub, 7, URL);
        assert!(!only.contains("do not rewrite"));
    }

    /// A work task's prompt renders verbatim in the transcript, with the
    /// sender's own line breaks and no Markdown — so a bare newline between
    /// two paragraphs shows up as one unbroken wall of prose.
    #[test]
    fn templates_separate_their_paragraphs_with_a_blank_line() {
        for s in all_scenarios() {
            for provider in [ForgeProvider::GitHub, ForgeProvider::GitLab] {
                let text = forge_instruction(s, provider, 7, URL);
                assert!(text.contains("\n\n"), "{s:?} runs together as one paragraph");
                assert!(
                    !text.replace("\n\n", "").contains('\n'),
                    "{s:?} still breaks a paragraph with a bare newline"
                );
                assert_eq!(text.trim(), text, "{s:?} has stray edge whitespace");
            }
        }
    }

    /// The dialog's note is the user's own words, so it gets its own section
    /// rather than being glued onto the template's last sentence — and onto
    /// the envelope block that follows it.
    #[test]
    fn the_users_note_becomes_a_section_of_its_own() {
        let gh = ForgeProvider::GitHub;
        let plain = instruction_block(ForgeScenario::Fix, gh, 7, URL, None, None);
        assert_eq!(plain, forge_instruction(ForgeScenario::Fix, gh, 7, URL));

        // Nothing typed — including a box holding only whitespace — leaves the
        // template exactly as it was: no empty header hanging off the end.
        assert_eq!(
            instruction_block(ForgeScenario::Fix, gh, 7, URL, Some(" "), Some("  \n ")),
            plain
        );

        let noted = instruction_block(
            ForgeScenario::Fix,
            gh,
            7,
            URL,
            None,
            Some("  also update the docs  "),
        );
        assert_eq!(noted, format!("{plain}\n\n{USER_NOTE_HEADER}\nalso update the docs"));
        // A blank line before the header, and the note on its own line under
        // it — the two breaks the old wording was missing.
        assert!(noted.contains(&format!("\n\n{USER_NOTE_HEADER}\n")));
    }

    /// The workbench's standing text and this trigger's note are two sections,
    /// in that order: policy, then the ask made while looking at this item. A
    /// merged section would leave the agent unable to tell which is which.
    #[test]
    fn standing_instructions_precede_the_note_as_their_own_section() {
        let gh = ForgeProvider::GitHub;
        let plain = instruction_block(ForgeScenario::ReviewFix, gh, 7, URL, None, None);

        let standing =
            instruction_block(ForgeScenario::ReviewFix, gh, 7, URL, Some("  Reply in zh.  "), None);
        assert_eq!(standing, format!("{plain}\n\n{STANDING_HEADER}\nReply in zh."));

        let both = instruction_block(
            ForgeScenario::ReviewFix,
            gh,
            7,
            URL,
            Some("Reply in zh."),
            Some("focus on the migration"),
        );
        assert_eq!(
            both,
            format!(
                "{plain}\n\n{STANDING_HEADER}\nReply in zh.\n\n{USER_NOTE_HEADER}\nfocus on the \
                 migration"
            )
        );
        let standing_at = both.find(STANDING_HEADER).expect("standing section");
        let note_at = both.find(USER_NOTE_HEADER).expect("note section");
        assert!(standing_at < note_at, "the per-item note must have the last word");
    }

    /// The envelope is a separate prompt block appended right after the
    /// instruction, and blocks arrive back to back — so the seam between the
    /// two must survive without any separator being added between them.
    #[test]
    fn the_envelope_block_starts_a_line_of_its_own_after_the_note() {
        let instruction = instruction_block(
            ForgeScenario::Fix,
            ForgeProvider::GitHub,
            7,
            URL,
            None,
            Some("do X"),
        );
        let envelope = forge_untrusted_envelope(
            "github",
            &ForgeSnapshot {
                title: "Login broken".into(),
                body: None,
                labels: vec![],
                author: None,
            },
        );
        let glued = format!("{instruction}{envelope}");
        let note_line = glued.lines().find(|l| l.contains("do X")).expect("the note's line");
        assert_eq!(note_line.trim(), "do X", "the envelope ran onto the user's note");
    }

    /// The settings blob keys its standing instructions by SCENARIO WIRE NAME
    /// and the trigger looks them up with `ForgeScenario::as_str` — two files
    /// agreeing on a string. A rename on either side would not fail to
    /// compile; it would quietly stop every configured instruction from
    /// applying, which is the kind of silence a user reads as "it ignored me".
    #[test]
    fn every_scenario_can_be_addressed_from_the_panel_settings() {
        use crate::forge::settings::{ForgePanelSettings, SCENARIO_PROMPT_ALL};
        for s in all_scenarios() {
            let settings = ForgePanelSettings {
                scenario_prompts: [
                    (SCENARIO_PROMPT_ALL.to_string(), "always".to_string()),
                    (s.as_str().to_string(), "here".to_string()),
                ]
                .into_iter()
                .collect(),
                ..Default::default()
            };
            assert_eq!(
                settings.standing_prompt(s.as_str()).as_deref(),
                Some("always\n\nhere"),
                "{s:?} cannot be configured"
            );
        }
    }

    fn draft_json(extra: serde_json::Value) -> ForgeTaskDraft {
        let mut wire = serde_json::json!({
            "folder_id": 1,
            "source": {
                "kind": "issue",
                "provider": "github",
                "server_host": "github.com",
                "owner_repo": "acme/app",
                "number": 7,
            },
            "snapshot": { "title": "Login times out" },
        });
        for (key, value) in extra.as_object().expect("object").clone() {
            wire[key] = value;
        }
        serde_json::from_value(wire).expect("draft decodes")
    }

    /// The whole chain for the one thing a task does where other people are
    /// watching: what the client sent → what gets stored → what the engine's
    /// gate (`meta.writeback.unwrap_or(false)`) then reads.
    ///
    /// The asymmetry is the point. A checked box sends `true` and comments; an
    /// unchecked one sends `false`; a client that never showed the question
    /// sends nothing and gets silence — NOT the dialog's default, because a
    /// default the user never saw is not consent.
    #[test]
    fn the_write_back_answer_survives_the_wire_and_defaults_to_silence() {
        for (sent, expected) in [
            (serde_json::json!({ "writeback": true }), true),
            (serde_json::json!({ "writeback": false }), false),
            (serde_json::json!({}), false),
        ] {
            let draft = draft_json(sent.clone());
            let stored = Some(resolve_writeback(draft.writeback));
            assert_eq!(stored, Some(expected), "resolved wrong for {sent}");

            // Through the stored blob and back, exactly as the engine reads it.
            let meta = ForgeSourceMeta {
                provider: ForgeProvider::GitHub,
                server_host: "github.com".into(),
                api_base: "https://api.github.com".into(),
                account_id: "acc-1".into(),
                owner_repo: "acme/app".into(),
                number: 7,
                url: URL.into(),
                title: "Login times out".into(),
                base_ref: None,
                head_ref: None,
                head_sha: None,
                head_repo: None,
                result_pr: None,
                writeback: stored,
            };
            let round: ForgeSourceMeta =
                serde_json::from_str(&serde_json::to_string(&meta).expect("encode"))
                    .expect("decode");
            assert_eq!(round.writeback.unwrap_or(false), expected, "gate flipped for {sent}");
        }
    }

    /// A row minted before the choice lived on the task carries no field at
    /// all, and that absence has to keep meaning "silent" — it is what every
    /// pre-existing forge task in a user's database looks like.
    #[test]
    fn source_metadata_without_the_field_reads_as_silent() {
        let legacy = r#"{
            "provider": "github",
            "server_host": "github.com",
            "api_base": "https://api.github.com",
            "account_id": "acc-1",
            "owner_repo": "acme/app",
            "number": 7,
            "url": "https://github.com/acme/app/issues/7",
            "title": "Login times out"
        }"#;
        let meta: ForgeSourceMeta = serde_json::from_str(legacy).expect("legacy meta decodes");
        assert_eq!(meta.writeback, None);
        assert!(!meta.writeback.unwrap_or(false));
    }

    /// The deliverable flag is what makes the engine swap the commit licence —
    /// exactly the reply-deliverable scenarios, never the change ones.
    #[test]
    fn report_scenarios_and_only_those_mark_the_report_deliverable() {
        for s in all_scenarios() {
            let expect = matches!(s, ForgeScenario::PlanFirst | ForgeScenario::ReviewOnly);
            assert_eq!(s.is_report(), expect, "{s:?}");
        }
    }
}
