//! Delivering a reviewed task back to the forge it came from: push the work
//! branch, then adopt or open the pull request that carries it.
//!
//! This is the engine's THIRD settlement path (after "landed on the base
//! branch" and "accepted with nothing to land"), and the only one the engine
//! executes deterministically end to end — a local merge needs an agent because
//! it may have to resolve conflicts, while a push plus two REST calls has
//! nothing to decide.
//!
//! Two rules shape everything below:
//!
//! - **The identity is pinned to the account that triggered the task.** Not
//!   "the default account for this host" — a later `is_default` flip must not
//!   silently change who a branch is pushed as.
//! - **A pull request is adopted only on a four-way match** (head OID, head
//!   ref, base ref, head repo). One commit can legitimately have several pull
//!   requests open against different bases, so an OID alone would settle the
//!   task against the wrong one. Nothing short of all four is ever adopted —
//!   the task bounces back to review for a human instead of guessing. Whether
//!   a non-match licenses CREATING one is a separate question, and the reason
//!   `PrAdoption` distinguishes "the head/base pair is free" from "it is taken
//!   by another commit".

use std::path::Path;

use async_trait::async_trait;
use sea_orm::DatabaseConnection;
use serde::Deserialize;

use super::auth::ResolvedAuth;
use super::{
    gitea, github, gitlab, urlencode_query, web_origin, ForgeError, ForgeItemKind, ForgeProvider,
};
use crate::app_error::AppCommandError;

/// Flatten a classified git failure into one line, git's own words included.
///
/// `AppCommandError`'s `Display` is `{message}` alone, and
/// `classify_remote_git_error` puts everything specific — the whole of git's
/// stderr — in `detail`. A plain `to_string()` here therefore hands the caller
/// nothing but "git push failed", and the delivery path has no second channel
/// to the failure: that one string is what a human reads. Losing the detail
/// there once cost a reader a long detour, because the caller filled the
/// silence with a guess about repository permissions when git had actually
/// said the branch was out of date.
///
/// The detail is bounded. It is arbitrary output from another program, and
/// this string does not just get read once — it is persisted on the task row
/// and rendered in the UI, so a server-side hook that answers a push with a
/// screenful of banner would otherwise all end up in the database. Git leads
/// with the part that identifies the failure and follows with hints, so a
/// prefix is the right thing to keep.
const MAX_GIT_DETAIL_CHARS: usize = 800;

fn git_failure_message(err: AppCommandError) -> String {
    match err
        .detail
        .as_deref()
        .map(str::trim)
        .filter(|d| !d.is_empty())
    {
        Some(detail) => format!("{}: {}", err.message, truncate_chars(&redact_userinfo(detail))),
        None => err.message,
    }
}

/// Blank out `scheme://user:secret@host` in text about to be shown and stored.
///
/// The account's token never travels in a URL — it reaches git through
/// `GIT_ASKPASS` — so this is not about that. It is about the URL git echoes
/// back in its errors: `web_origin` returns a self-hosted `server_url` verbatim,
/// so a user who typed credentials into their own forge address would have them
/// come back out here, in a string that is persisted and rendered. Cheap to
/// scrub, and this is a failure path where nothing is worth that risk.
fn redact_userinfo(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(scheme_end) = rest.find("://") {
        let authority_start = scheme_end + "://".len();
        // The authority runs to the first character that can only follow it.
        // Quotes count: git wraps the URL in them ('https://…/repo.git/').
        let authority_end = rest[authority_start..]
            .find(|c: char| matches!(c, '/' | '?' | '#' | '\'' | '"') || c.is_whitespace())
            .map(|i| authority_start + i)
            .unwrap_or(rest.len());
        let authority = &rest[authority_start..authority_end];
        match authority.rfind('@') {
            Some(at) => {
                out.push_str(&rest[..authority_start]);
                out.push_str("***@");
                out.push_str(&authority[at + 1..]);
            }
            None => out.push_str(&rest[..authority_end]),
        }
        rest = &rest[authority_end..];
    }
    out.push_str(rest);
    out
}

/// Cut on a character boundary, never a byte one — git happily reports branch
/// names and hook banners in any encoding, and slicing those mid-codepoint
/// would panic on the failure path.
fn truncate_chars(text: &str) -> String {
    match text.char_indices().nth(MAX_GIT_DETAIL_CHARS) {
        Some((cut, _)) => format!("{}…", &text[..cut]),
        None => text.to_string(),
    }
}

/// A pull request as far as delivery cares. Deliberately not the full API
/// object: everything here is either an adoption criterion or shown to the user.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct ForgePr {
    pub number: i64,
    pub html_url: String,
    /// "open" | "closed" (GitHub has no separate "merged" state).
    pub state: String,
    pub merged: bool,
    pub head_sha: String,
    pub head_ref: String,
    /// `owner/repo` of the head — compared with `same_repo`, never `==`.
    pub head_repo: String,
    pub base_ref: String,
}

/// What to open, once we know nothing suitable exists yet.
#[derive(Debug, Clone)]
pub struct NewPullRequest<'a> {
    pub title: &'a str,
    pub head: &'a str,
    pub base: &'a str,
    pub body: &'a str,
    pub draft: bool,
}

/// Verdict of the four-way match. Only the first two settle a task.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PrAdoption {
    /// Someone already merged it while the task sat in review — that IS the
    /// delivery, so the task settles rather than opening a duplicate.
    Merged(ForgePr),
    /// The pull request this delivery is about; settle and link to it.
    Open(ForgePr),
    /// Matches, but was closed without merging — a human decision the engine
    /// must not overrule by reopening or duplicating.
    ClosedUnmerged(ForgePr),
    /// A pull request for exactly this branch AND base exists, but its head is
    /// a different commit than the one we pushed — someone else moved the
    /// branch. Not adoptable (the anchor is the whole point), and not
    /// creatable either: GitHub refuses a second pull request for the same
    /// head/base pair. Its own verdict so the task bounces with that
    /// explanation instead of a 422.
    StaleHead(ForgePr),
    /// No pull request exists for this branch/base pair at all. The ONLY
    /// verdict that licenses creating one.
    NoMatch,
}

/// Pick the pull request this delivery may settle against.
///
/// All four criteria must hold. `head_sha` is the anchor (the OID we pushed),
/// but on its own it is not enough: the same commit can head several pull
/// requests aimed at different bases, and a fork's branch can carry the same
/// name. Ordering among matches is merged → open → closed, so a merged
/// outcome is never masked by a stale closed duplicate.
pub fn adopt_pull_request(
    prs: Vec<ForgePr>,
    expected_head: &str,
    remote_branch: &str,
    base_branch: &str,
    owner_repo: &str,
) -> PrAdoption {
    let matches: Vec<&ForgePr> = prs
        .iter()
        .filter(|pr| {
            // Git object ids are lowercase hex on both sides; compare
            // case-insensitively anyway rather than depend on that.
            pr.head_sha.eq_ignore_ascii_case(expected_head)
                && pr.head_ref == remote_branch
                && pr.base_ref == base_branch
                && super::same_repo(&pr.head_repo, owner_repo)
        })
        .collect();
    if let Some(pr) = matches.iter().find(|pr| pr.merged) {
        return PrAdoption::Merged((*pr).clone());
    }
    if let Some(pr) = matches.iter().find(|pr| pr.state == "open") {
        return PrAdoption::Open((*pr).clone());
    }
    if let Some(pr) = matches.into_iter().next() {
        return PrAdoption::ClosedUnmerged(pr.clone());
    }
    // Nothing matched all four. Before reporting "none", separate the two very
    // different reasons: a pull request already OPEN for this exact branch and
    // base but headed by another commit cannot be duplicated (GitHub answers
    // 422), while a pull request from this branch to a DIFFERENT base is no
    // obstacle at all — one branch may legitimately have several open pull
    // requests as long as each targets its own base.
    let stale_head = prs.into_iter().find(|pr| {
        pr.state == "open"
            && pr.head_ref == remote_branch
            && pr.base_ref == base_branch
            && super::same_repo(&pr.head_repo, owner_repo)
    });
    match stale_head {
        Some(pr) => PrAdoption::StaleHead(pr),
        None => PrAdoption::NoMatch,
    }
}

/// Everything a delivery step needs that is NOT operation-specific. All of it
/// is server-derived: the caller passes coordinates, never URLs or tokens.
pub struct DeliveryCtx<'a> {
    pub conn: &'a DatabaseConnection,
    /// codeg data dir — where the GIT_ASKPASS helper script lives.
    pub data_dir: &'a Path,
    /// The forge this task came from, read back from its own provenance —
    /// never "whatever this host looks like now". Every method below routes on
    /// it, and it is also what picks which credential may be spent.
    pub provider: ForgeProvider,
    pub server_host: &'a str,
    /// The account pinned at trigger time. A missing/foreign id is an error,
    /// never a fallback to some other identity.
    pub account_id: &'a str,
    pub owner_repo: &'a str,
}

/// The three forge operations a delivery performs.
///
/// A trait rather than free functions because the engine tests must exercise
/// the whole delivery state machine — every failure point, both recovery
/// branches, the reconcile race — without a network or a credential store. The
/// production implementation resolves auth from the OS keyring, which a unit
/// test must never touch. The wire shapes themselves are covered separately,
/// against a real HTTP server (see this module's tests).
#[async_trait]
pub trait ForgeDeliveryApi: Send + Sync {
    /// Publish `work_branch` as `remote_branch` on `repo` — the repository the
    /// push lands in: the source repository for an issue task's own branch,
    /// the recorded HEAD repository for a pull-request push-back (the same
    /// repository except when the pull request comes from a fork).
    /// Fast-forward only — a rejected push means that branch has another owner
    /// and the task must go back to a human.
    async fn push_branch(
        &self,
        ctx: &DeliveryCtx<'_>,
        worktree_path: &str,
        repo: &str,
        work_branch: &str,
        remote_branch: &str,
    ) -> Result<(), String>;

    /// Pull requests whose head is `head_branch` in the source repository, in
    /// ANY state — a merged or closed one is exactly what recovery must see.
    async fn find_pulls(
        &self,
        ctx: &DeliveryCtx<'_>,
        head_branch: &str,
    ) -> Result<Vec<ForgePr>, String>;

    async fn create_pull(
        &self,
        ctx: &DeliveryCtx<'_>,
        req: &NewPullRequest<'_>,
    ) -> Result<ForgePr, String>;

    /// One pull request by number — how a task that IS a pull request checks
    /// what it is delivering into. Its number is part of the task's source
    /// key, so this is a lookup, not a search.
    async fn get_pull(&self, ctx: &DeliveryCtx<'_>, number: i64) -> Result<ForgePr, String>;

    /// Fetch `remote_ref` from the source repository into `local_ref` inside
    /// `repo_path`, and return the OID it landed on.
    ///
    /// This exists because a task triggered from a pull/merge request is the
    /// only setup path in the engine that needs the NETWORK, and it needs it
    /// with the account the task was triggered by. Reaching for the folder's
    /// `origin` instead would work for public repositories and fail for
    /// private ones — the folder's remote may be SSH, or HTTPS with no cached
    /// credential — which is the one case a work tool has to get right.
    async fn fetch_ref(
        &self,
        ctx: &DeliveryCtx<'_>,
        repo_path: &str,
        remote_ref: &str,
        local_ref: &str,
    ) -> Result<String, String>;

    /// Current tip of `base_branch` on the SOURCE repository, fetched into the
    /// local object store so the caller can run ancestry checks against it.
    ///
    /// `None` when it cannot be read at all (offline, no read access). The
    /// caller treats that as "cannot prove anything" and carries on — the push
    /// that follows uses the same URL and the same credentials, so it will
    /// report the real problem with a far better message than a guess here.
    async fn remote_base_tip(
        &self,
        ctx: &DeliveryCtx<'_>,
        worktree_path: &str,
        base_branch: &str,
    ) -> Option<String>;

    /// Comment on the item the task came from. Returns the comment's URL.
    /// Runs off the settlement path: a task is finished whether or not this
    /// succeeds.
    ///
    /// `kind` is not decoration — GitHub serves issue and pull-request
    /// comments from one endpoint, GitLab from two, and posting to the wrong
    /// one lands on a different item or 404s.
    async fn comment_issue(
        &self,
        ctx: &DeliveryCtx<'_>,
        kind: ForgeItemKind,
        number: i64,
        body: &str,
    ) -> Result<String, String>;
}

/// Production implementation: real keyring, real git, real forge. Each method
/// routes on `ctx.provider`; the engine holds exactly one of these, so a task
/// is never asked which API it wants — its provenance already said.
pub struct ForgeDelivery;

#[async_trait]
impl ForgeDeliveryApi for ForgeDelivery {
    async fn push_branch(
        &self,
        ctx: &DeliveryCtx<'_>,
        worktree_path: &str,
        repo: &str,
        work_branch: &str,
        remote_branch: &str,
    ) -> Result<(), String> {
        // Git is git: the same explicit-URL push with the same pinned
        // credentials works against both forges.
        let auth = resolve(ctx).await?;
        push_work_branch(ctx, &auth, worktree_path, repo, work_branch, remote_branch).await
    }

    async fn find_pulls(
        &self,
        ctx: &DeliveryCtx<'_>,
        head_branch: &str,
    ) -> Result<Vec<ForgePr>, String> {
        let auth = resolve(ctx).await?;
        match ctx.provider {
            ForgeProvider::GitHub => find_pulls(&auth, ctx.owner_repo, head_branch).await,
            ForgeProvider::GitLab => {
                gitlab::find_merge_requests(&auth, ctx.owner_repo, head_branch).await
            }
            ForgeProvider::Gitea => {
                gitea::find_pulls(&auth, ctx.owner_repo, head_branch).await
            }
        }
        .map_err(|e| e.to_string())
    }

    async fn create_pull(
        &self,
        ctx: &DeliveryCtx<'_>,
        req: &NewPullRequest<'_>,
    ) -> Result<ForgePr, String> {
        let auth = resolve(ctx).await?;
        match ctx.provider {
            ForgeProvider::GitHub => create_pull(&auth, ctx.owner_repo, req).await,
            ForgeProvider::GitLab => {
                gitlab::create_merge_request(&auth, ctx.owner_repo, req).await
            }
            ForgeProvider::Gitea => gitea::create_pull(&auth, ctx.owner_repo, req).await,
        }
        .map_err(|e| e.to_string())
    }

    async fn get_pull(&self, ctx: &DeliveryCtx<'_>, number: i64) -> Result<ForgePr, String> {
        let auth = resolve(ctx).await?;
        match ctx.provider {
            ForgeProvider::GitHub => get_pull(&auth, ctx.owner_repo, number).await,
            ForgeProvider::GitLab => {
                gitlab::get_merge_request(&auth, ctx.owner_repo, number).await
            }
            ForgeProvider::Gitea => gitea::get_pull(&auth, ctx.owner_repo, number).await,
        }
        .map_err(|e| e.to_string())
    }

    async fn fetch_ref(
        &self,
        ctx: &DeliveryCtx<'_>,
        repo_path: &str,
        remote_ref: &str,
        local_ref: &str,
    ) -> Result<String, String> {
        let auth = resolve(ctx).await?;
        fetch_into_ref(ctx, &auth, repo_path, remote_ref, local_ref).await
    }

    async fn remote_base_tip(
        &self,
        ctx: &DeliveryCtx<'_>,
        worktree_path: &str,
        base_branch: &str,
    ) -> Option<String> {
        let auth = resolve(ctx).await.ok()?;
        fetch_base_tip(ctx, &auth, worktree_path, base_branch).await
    }

    async fn comment_issue(
        &self,
        ctx: &DeliveryCtx<'_>,
        kind: ForgeItemKind,
        number: i64,
        body: &str,
    ) -> Result<String, String> {
        let auth = resolve(ctx).await?;
        match ctx.provider {
            ForgeProvider::GitHub => create_issue_comment(&auth, ctx.owner_repo, number, body).await,
            ForgeProvider::GitLab => gitlab::create_note(&auth, ctx.owner_repo, kind, number, body)
                .await
                // The write-back wants the LINK; the composer wants the whole
                // comment. Same one request either way — and an anchor that did
                // not survive sanitizing must not fail a comment that was
                // posted (see `create_issue_comment`).
                .map(|comment| comment.html_url.unwrap_or_default()),
            // No kind here either: a pull request is an issue at Gitea, exactly
            // as at GitHub, and one collection serves both.
            ForgeProvider::Gitea => gitea::create_comment(&auth, ctx.owner_repo, number, body)
                .await
                .map(|comment| comment.html_url.unwrap_or_default()),
        }
        .map_err(|e| e.to_string())
    }
}

async fn resolve(ctx: &DeliveryCtx<'_>) -> Result<ResolvedAuth, String> {
    super::resolve_forge_auth(ctx.conn, ctx.provider, ctx.server_host, Some(ctx.account_id))
        .await
        .map_err(|e| e.to_string())
}

/// `GET /repos/{o}/{r}/pulls?head={owner}:{branch}&state=all`.
///
/// Unlike `assignee`/`labels` (silently ignored by this endpoint — see
/// `github.rs`), the `head` filter IS applied; verified against the live API
/// before this was written. The four-way match still runs locally afterwards:
/// the filter is a pre-select, never the decision.
pub async fn find_pulls(
    auth: &ResolvedAuth,
    owner_repo: &str,
    head_branch: &str,
) -> Result<Vec<ForgePr>, ForgeError> {
    let repo = super::normalize_repo(owner_repo)
        .ok_or_else(|| ForgeError::Invalid(format!("bad repository path: {owner_repo}")))?;
    let owner = repo
        .split('/')
        .next()
        .ok_or_else(|| ForgeError::Invalid(format!("bad repository path: {owner_repo}")))?;
    let url = format!(
        "{}/repos/{}/pulls?head={}:{}&state=all&per_page=100",
        auth.api_base,
        repo,
        owner,
        urlencode_query(head_branch)
    );
    let raw: Vec<RawPull> = github::api_get(auth, &url)
        .await?
        .json()
        .await
        .map_err(|e| ForgeError::Network(format!("bad pulls payload: {e}")))?;
    Ok(raw.into_iter().map(ForgePr::from).collect())
}

/// `GET /repos/{o}/{r}/pulls/{n}` — one pull request by number.
///
/// The list rows the workbench shows carry no refs at all (they come from
/// `/issues`), so this is what turns "PR #12" into something checkoutable: the
/// head ref, the head OID, the repository the head lives in (fork or not) and
/// the base ref.
pub async fn get_pull(
    auth: &ResolvedAuth,
    owner_repo: &str,
    number: i64,
) -> Result<ForgePr, ForgeError> {
    let repo = super::normalize_repo(owner_repo)
        .ok_or_else(|| ForgeError::Invalid(format!("bad repository path: {owner_repo}")))?;
    if number <= 0 {
        return Err(ForgeError::Invalid(format!("bad work item number: {number}")));
    }
    let url = format!("{}/repos/{repo}/pulls/{number}", auth.api_base);
    let raw: RawPull = github::api_get(auth, &url)
        .await?
        .json()
        .await
        .map_err(|e| ForgeError::Network(format!("bad pull payload: {e}")))?;
    Ok(ForgePr::from(raw))
}

/// Whether a task may be created for this pull request — and if not, why not,
/// in the words the user gets.
///
/// Every refusal here answers ONE question: when the agent is finished, is
/// there somewhere for its commits to go? A task that cannot be delivered also
/// cannot be merged locally (that would take the pull request's changes in
/// behind its author's back, so the engine refuses it), which would leave it
/// stuck in review with no acceptance at all. Refusing at the only moment the
/// user can still choose something else is the whole point.
///
/// A change from a FORK has such a place: its own branch in the fork — the
/// checkout never needed it (both forges publish the head under a server-side
/// ref on this repository), and the delivery pushes to the fork with the same
/// pinned credentials, which the forge grants when the author allowed
/// maintainer edits. That grant cannot be read reliably up front, so it is not
/// gated here: a refused push bounces the task back to review with the reason,
/// and a review turn that added no commits settles without pushing at all.
/// What IS refused is a fork codeg cannot even name — a deleted or invisible
/// head repository — because a push there can never work for anyone.
pub fn pull_is_workable(
    provider: ForgeProvider,
    pull: &ForgePr,
    owner_repo: &str,
) -> Result<(), String> {
    let noun = provider.change_noun();
    if !super::same_repo(&pull.head_repo, owner_repo)
        && super::normalize_repo(&pull.head_repo).is_none()
    {
        return Err(format!(
            "{noun} #{} comes from a fork whose repository codeg cannot see (it may be private \
             or deleted), so there would be no way to push work back to it",
            pull.number
        ));
    }
    // A closed-but-unmerged pull request is fine: it can be reopened, and the
    // delivery says so. A MERGED one cannot be reopened by anyone.
    if pull.merged {
        return Err(format!(
            "{noun} #{} is already merged — a merged {noun} cannot be reopened, so there would \
             be nowhere to deliver the work",
            pull.number
        ));
    }
    if pull.head_ref.trim().is_empty() || pull.head_sha.trim().is_empty() {
        return Err(format!(
            "{noun} #{} does not report a head branch to work on",
            pull.number
        ));
    }
    Ok(())
}

pub async fn create_pull(
    auth: &ResolvedAuth,
    owner_repo: &str,
    req: &NewPullRequest<'_>,
) -> Result<ForgePr, ForgeError> {
    let repo = super::normalize_repo(owner_repo)
        .ok_or_else(|| ForgeError::Invalid(format!("bad repository path: {owner_repo}")))?;
    let url = format!("{}/repos/{}/pulls", auth.api_base, repo);
    let body = serde_json::json!({
        "title": req.title,
        "head": req.head,
        "base": req.base,
        "body": req.body,
        "draft": req.draft,
    });
    let raw: RawPull = github::api_post(auth, &url, &body)
        .await?
        .json()
        .await
        .map_err(|e| ForgeError::Network(format!("bad pull payload: {e}")))?;
    Ok(ForgePr::from(raw))
}

/// `POST /repos/{o}/{r}/issues/{n}/comments` — the issue-comments endpoint,
/// which is also the one that comments on a pull request (GitHub models a PR
/// as an issue; `/pulls/{n}/comments` is for review comments on a diff line,
/// which is not what this is).
pub async fn create_issue_comment(
    auth: &ResolvedAuth,
    owner_repo: &str,
    number: i64,
    body: &str,
) -> Result<String, ForgeError> {
    // One spelling of the endpoint, shared with the panel's own composer — two
    // copies of a write path are two chances for one of them to drift onto the
    // review-comment collection. The write-back only wants the link, and takes
    // an empty one over a failure: the comment IS posted at this point, and
    // failing the delivery over a URL that did not survive sanitizing would
    // report a write-back that did happen as one that did not.
    let comment = github::create_comment(auth, owner_repo, number, body).await?;
    Ok(comment.html_url.unwrap_or_default())
}

/// Push over an explicit HTTPS URL rather than the folder's configured remote:
/// the repository may well use an SSH remote (which would bypass credential
/// injection entirely), and the identity here must be the pinned account, not
/// whatever git's helper chain answers with.
///
/// `repo` — not `ctx.owner_repo` — is where the push lands: a pull request
/// from a fork pushes back to the fork, while every context-level operation
/// (comments, pull-request lookups) stays on the source repository.
async fn push_work_branch(
    ctx: &DeliveryCtx<'_>,
    auth: &ResolvedAuth,
    worktree_path: &str,
    repo: &str,
    work_branch: &str,
    remote_branch: &str,
) -> Result<(), String> {
    // Everything here is interpolated into a URL or a refspec. Validate
    // BEFORE building either.
    let repo = super::normalize_repo(repo)
        .ok_or_else(|| format!("bad repository path: {repo}"))?;
    ensure_pushable_branch(work_branch)?;
    ensure_pushable_branch(remote_branch)?;
    let url = format!("{}/{}.git", web_origin(auth), repo);
    // Fully qualified on both sides: a short name goes through git's revision
    // resolution, where a same-named tag makes it ambiguous (the project's
    // existing push path documents the same trap).
    let refspec = format!("refs/heads/{work_branch}:refs/heads/{remote_branch}");

    let mut cmd = crate::process::tokio_command("git");
    cmd.args(["push", &url, &refspec])
        .current_dir(worktree_path)
        .stdin(std::process::Stdio::null());
    with_credentials(&mut cmd, ctx, auth);

    let output = cmd
        .output()
        .await
        .map_err(|e| format!("could not run git push: {e}"))?;
    if !output.status.success() {
        return Err(git_failure_message(
            crate::commands::folders::classify_remote_git_error("push", &output.stderr),
        ));
    }
    Ok(())
}

/// `git fetch <url> +<remote_ref>:<local_ref>` with the pinned account's
/// credentials, then the OID that ref now points at.
///
/// A NAMED destination ref rather than `FETCH_HEAD`: `FETCH_HEAD` belongs to
/// whichever worktree wrote it last, and these fetches run in the shared
/// project folder where two task setups can be in flight at once.
async fn fetch_into_ref(
    ctx: &DeliveryCtx<'_>,
    auth: &ResolvedAuth,
    repo_path: &str,
    remote_ref: &str,
    local_ref: &str,
) -> Result<String, String> {
    let url = format!("{}/{}.git", web_origin(auth), ctx.owner_repo);
    let refspec = format!("+{remote_ref}:{local_ref}");
    let mut cmd = crate::process::tokio_command("git");
    cmd.args(["fetch", "--quiet", &url, &refspec])
        .current_dir(repo_path)
        .stdin(std::process::Stdio::null());
    with_credentials(&mut cmd, ctx, auth);
    let out = cmd
        .output()
        .await
        .map_err(|e| format!("could not run git fetch: {e}"))?;
    if !out.status.success() {
        return Err(git_failure_message(
            crate::commands::folders::classify_remote_git_error("fetch", &out.stderr),
        ));
    }
    crate::work_task::git::rev_parse(repo_path, local_ref)
        .await
        .map_err(|e| e.to_string())
}

/// `git fetch <push-url> refs/heads/<base>` + `rev-parse FETCH_HEAD`, run in
/// the task worktree so the fetched commit lands in the repository's shared
/// object store — an ancestry test needs the object, not just its id.
async fn fetch_base_tip(
    ctx: &DeliveryCtx<'_>,
    auth: &ResolvedAuth,
    worktree_path: &str,
    base_branch: &str,
) -> Option<String> {
    ensure_pushable_branch(base_branch).ok()?;
    let url = format!("{}/{}.git", web_origin(auth), ctx.owner_repo);
    let mut cmd = crate::process::tokio_command("git");
    cmd.args(["fetch", "--quiet", &url, &format!("refs/heads/{base_branch}")])
        .current_dir(worktree_path)
        .stdin(std::process::Stdio::null());
    with_credentials(&mut cmd, ctx, auth);
    let fetched = cmd.output().await.ok()?;
    if !fetched.status.success() {
        tracing::info!(
            "[forge] could not read the remote base branch: {}",
            String::from_utf8_lossy(&fetched.stderr).trim()
        );
        return None;
    }
    crate::work_task::git::rev_parse(worktree_path, "FETCH_HEAD")
        .await
        .ok()
}

/// GIT_ASKPASS + an emptied helper chain, carrying the PINNED account's
/// token. Injection is best-effort by design: a public repository can be read
/// and (with the right remote) written without credentials, and the git
/// command itself reports the real failure when they were needed.
fn with_credentials(cmd: &mut tokio::process::Command, ctx: &DeliveryCtx<'_>, auth: &ResolvedAuth) {
    // Never let git fall back to asking a human: these commands run on the
    // engine's own task, with no terminal attached to answer on, so a prompt
    // is not a question — it is a hang that holds the delivery's in-flight
    // claim until the process dies.
    cmd.env("GIT_TERMINAL_PROMPT", "0");
    match crate::git_credential::ensure_askpass_script(ctx.data_dir) {
        Ok(askpass) => {
            let username = if auth.username.trim().is_empty() {
                // No forge checks the username when the password is a token
                // (Gitea looks the token up and authenticates by it, ignoring
                // whatever name came with it), but git insists on having one;
                // these are each ecosystem's conventional placeholder — Gitea's
                // is GitHub's, which is what its own Actions runner sends.
                match ctx.provider {
                    ForgeProvider::GitHub | ForgeProvider::Gitea => "x-access-token",
                    ForgeProvider::GitLab => "oauth2",
                }
            } else {
                auth.username.trim()
            };
            crate::git_credential::inject_credentials(cmd, username, &auth.token, &askpass);
        }
        Err(e) => {
            tracing::warn!("[forge] no askpass helper for the delivery: {e}");
            cmd.env("GIT_TERMINAL_PROMPT", "0");
        }
    }
}

fn ensure_pushable_branch(branch: &str) -> Result<(), String> {
    crate::commands::folders::ensure_pushable_branch_name(branch).map_err(|e| e.to_string())
}

/// How a codeg task id is written into text that lands on a forge.
///
/// The number is codeg-local: it names a row in this workspace's task list,
/// not anything in the repository the text is posted to. Both halves of the
/// form below carry weight — neither is decoration:
///
/// - Dropping the `#` is what stops the ISSUE reference. `#27` is a reference
///   on both GitHub and GitLab; left bare it autolinks to whatever their own
///   issue, pull request or merge request 27 happens to be, pointing readers
///   of the thread at an unrelated page that looks authoritative.
/// - The code span is what stops the COMMIT reference. Every decimal digit is
///   also a hex digit, so a long enough id is a valid abbreviated sha:
///   GitHub linkifies a bare `5899977` when some commit in that repository
///   starts with it. Reference scanners skip code spans, which is what keeps
///   this safe once ids grow past six digits.
fn task_ref(task_id: i32) -> String {
    format!("`{task_id}`")
}

/// Body of the pull request codeg opens. `Closes #N` is what links it to the
/// issue: GitHub's native closing keyword beats an API `close` call — it fires
/// only if the pull request actually merges, and only into the right branch.
/// That reference is the intended one; the task id beside it is not, hence
/// [`task_ref`].
pub fn pull_request_body(issue_url: &str, issue_number: i64, task_id: i32) -> String {
    let task = task_ref(task_id);
    format!(
        "Closes #{issue_number}\n\n\
         Prepared by [codeg](https://github.com/xggz/codeg) work task {task} \
         from {issue_url}.\n\n\
         Review the diff before merging — the task ran against issue text \
         written by an external author."
    )
}

/// How a task finished, in the only two shapes worth telling the issue about.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TaskOutcome<'a> {
    /// Landed on the base branch of the local checkout.
    Merged { commit: &'a str, base_branch: &'a str },
    /// Published as a pull request.
    Delivered { pr_url: &'a str },
    /// The third settlement: accepted without merging. `nothing_to_land` tells
    /// the two ways that happens apart — an empty diff, versus a worktree that
    /// was already gone (whose branch may still hold real commits). Saying
    /// "nothing to land" about the second would contradict the counters printed
    /// beside it.
    Accepted { nothing_to_land: bool },
}

/// The comment codeg posts when a task finishes.
///
/// Deliberately built from nothing but the task id, the outcome and the diff
/// counters: NO agent-written text (result summary, commit message, verdict
/// note) may reach a thread other people are reading. That is a rule about the
/// signature, not about the formatting — there is no parameter here that could
/// carry it, which is what makes the rule hold as this evolves.
pub fn writeback_comment_body(
    task_id: i32,
    outcome: &TaskOutcome<'_>,
    stats: Option<(i32, i32, i32)>,
) -> String {
    let numbers = match stats {
        Some((files, additions, deletions)) => format!(
            " ({files} file{}, +{additions}/-{deletions})",
            if files == 1 { "" } else { "s" }
        ),
        None => String::new(),
    };
    let task = task_ref(task_id);
    match outcome {
        TaskOutcome::Merged { commit, base_branch } => {
            let short: String = commit.chars().take(7).collect();
            // "merged locally", not "merged": this landed in the triggering
            // user's own checkout and was never pushed, so to everyone else
            // reading the thread the branch is untouched and the sha resolves
            // to nothing. Saying it plainly is the difference between a status
            // note and a false claim that the work has shipped.
            format!(
                "codeg work task {task} is done — merged locally into `{base_branch}` as \
                 `{short}`{numbers}."
            )
        }
        TaskOutcome::Delivered { pr_url } => {
            format!("codeg work task {task} is done — {pr_url}{numbers}.")
        }
        TaskOutcome::Accepted { nothing_to_land: true } => {
            format!("codeg work task {task} is done — accepted with nothing to land.")
        }
        TaskOutcome::Accepted { nothing_to_land: false } => {
            format!("codeg work task {task} is done — accepted without merging{numbers}.")
        }
    }
}

#[derive(Debug, Deserialize)]
struct RawPull {
    number: i64,
    #[serde(default)]
    html_url: String,
    #[serde(default)]
    state: String,
    /// The LIST endpoint has no `merged` boolean — only `merged_at`. Reading
    /// `merged` here would silently make every listed pull request look
    /// unmerged, and recovery would then bounce a delivery that actually
    /// landed.
    #[serde(default)]
    merged_at: Option<String>,
    #[serde(default)]
    head: RawRef,
    #[serde(default)]
    base: RawRef,
}

#[derive(Debug, Default, Deserialize)]
struct RawRef {
    #[serde(default)]
    sha: String,
    #[serde(default, rename = "ref")]
    ref_name: String,
    #[serde(default)]
    repo: Option<RawRepo>,
}

#[derive(Debug, Deserialize)]
struct RawRepo {
    #[serde(default)]
    full_name: String,
}

impl From<RawPull> for ForgePr {
    fn from(raw: RawPull) -> Self {
        ForgePr {
            number: raw.number,
            html_url: raw.html_url,
            state: raw.state,
            merged: raw.merged_at.is_some(),
            head_sha: raw.head.sha,
            head_ref: raw.head.ref_name,
            head_repo: raw.head.repo.map(|r| r.full_name).unwrap_or_default(),
            base_ref: raw.base.ref_name,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::extract::Query;
    use axum::routing::{get, post};
    use axum::Json;
    use std::collections::HashMap;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    /// The delivery error string is the only thing a human sees when a push
    /// fails, and `classify_remote_git_error` files everything specific under
    /// `detail`. `Display` prints `message` alone, so flattening has to reach
    /// for the detail explicitly or the reader is left with "git push failed".
    #[test]
    fn a_flattened_git_failure_keeps_what_git_said() {
        let stderr = b"! [rejected]        task/57 -> feat/x (fetch first)\n\
                       error: failed to push some refs";
        let flattened = git_failure_message(crate::commands::folders::classify_remote_git_error(
            "push", stderr,
        ));
        assert!(flattened.starts_with("git push failed"), "{flattened}");
        assert!(flattened.contains("(fetch first)"), "{flattened}");
    }

    #[test]
    fn a_flattened_failure_without_detail_stays_one_clause() {
        let bare = AppCommandError::network("git push: network error");
        assert_eq!(git_failure_message(bare), "git push: network error");
        let blank = AppCommandError::network("git push: network error").with_detail("   ");
        assert_eq!(git_failure_message(blank), "git push: network error");
    }

    /// Git echoes the remote URL in its errors, and `web_origin` hands back a
    /// self-hosted `server_url` verbatim — so credentials a user typed into
    /// their own forge address would otherwise come back out in a string that
    /// is persisted and rendered.
    #[test]
    fn a_flattened_failure_blanks_credentials_git_echoed_back() {
        let echoed = "fatal: unable to access \
             'https://me:s3cret@git.example.com/team/app.git/': The requested URL returned \
             error: 403";
        let flattened = git_failure_message(
            AppCommandError::network("git push failed").with_detail(echoed),
        );
        assert!(!flattened.contains("s3cret"), "{flattened}");
        assert!(flattened.contains("https://***@git.example.com/team/app.git/"), "{flattened}");
        // The rest of git's sentence has to survive the scrub intact.
        assert!(flattened.contains("returned error: 403"), "{flattened}");
    }

    #[test]
    fn a_flattened_failure_leaves_a_credential_free_url_alone() {
        let plain = "! [rejected] a -> b (fetch first)\nerror: failed to push some refs to \
             'https://github.com/owner/repo.git'";
        let flattened =
            git_failure_message(AppCommandError::network("git push failed").with_detail(plain));
        assert!(
            flattened.contains("'https://github.com/owner/repo.git'"),
            "{flattened}"
        );
        assert!(!flattened.contains("***"), "{flattened}");
    }

    /// This string is persisted and rendered, and the detail is another
    /// program's output — a hook that answers a push with a banner must not
    /// land in the database whole. Multi-byte input is the case that would
    /// panic if the cut were taken on bytes.
    #[test]
    fn a_flattened_failure_bounds_a_runaway_detail() {
        let banner = "の".repeat(MAX_GIT_DETAIL_CHARS * 2);
        let flattened =
            git_failure_message(AppCommandError::network("git push failed").with_detail(&banner));
        assert!(flattened.starts_with("git push failed: の"), "{flattened}");
        assert!(flattened.ends_with('…'), "expected an elision marker");
        assert_eq!(
            flattened.chars().count(),
            "git push failed: ".chars().count() + MAX_GIT_DETAIL_CHARS + 1
        );
        // Exactly at the limit is kept whole, with no marker implying loss.
        let exact = "x".repeat(MAX_GIT_DETAIL_CHARS);
        let kept =
            git_failure_message(AppCommandError::network("git push failed").with_detail(&exact));
        assert!(kept.ends_with('x'), "{kept}");
    }

    fn pr(number: i64, head_sha: &str, head_ref: &str, base: &str, repo: &str) -> ForgePr {
        ForgePr {
            number,
            html_url: format!("https://github.test/acme/app/pull/{number}"),
            state: "open".into(),
            merged: false,
            head_sha: head_sha.into(),
            head_ref: head_ref.into(),
            head_repo: repo.into(),
            base_ref: base.into(),
        }
    }

    /// The whole point of the four-way match: one commit, two pull requests
    /// aimed at different bases. Settling on the OID alone would link the task
    /// to whichever came back first.
    #[test]
    fn same_head_against_another_base_is_not_adopted() {
        let wrong_base = pr(1, "abc123", "task/7", "release/1.x", "acme/app");
        assert_eq!(
            adopt_pull_request(
                vec![wrong_base],
                "abc123",
                "task/7",
                "main",
                "acme/app"
            ),
            PrAdoption::NoMatch
        );
    }

    /// GitHub answers with canonical casing, our keys are lowercase — an exact
    /// repo compare here would reject the task's own pull request as a fork's.
    #[test]
    fn canonical_casing_still_matches_the_same_repo() {
        let canonical = pr(2, "ABC123", "task/7", "main", "Acme/App");
        assert!(matches!(
            adopt_pull_request(vec![canonical], "abc123", "task/7", "main", "acme/app"),
            PrAdoption::Open(_)
        ));
    }

    /// None of these may be ADOPTED — but they split two ways for what happens
    /// next. A pull request already open on this exact branch AND base blocks
    /// creation (GitHub allows one per head/base pair), so it has to be told
    /// apart from a candidate that leaves the pair free.
    #[test]
    fn near_misses_are_never_adopted_and_a_blocked_pair_is_named() {
        let expected = ("abc123", "task/7", "main", "acme/app");
        let cases = vec![
            ("another branch", pr(4, "abc123", "task/8", "main", "acme/app"), false),
            ("a fork's branch", pr(5, "abc123", "task/7", "main", "someone/app"), false),
            ("head repo missing", pr(6, "abc123", "task/7", "main", ""), false),
            ("another base", pr(7, "abc123", "task/7", "release/1.x", "acme/app"), false),
            // Same branch, same base, different commit: the head/base pair is
            // taken, so creating would earn a 422 rather than a pull request.
            ("head OID moved", pr(3, "def456", "task/7", "main", "acme/app"), true),
        ];
        for (label, candidate, blocked) in cases {
            let verdict = adopt_pull_request(
                vec![candidate],
                expected.0,
                expected.1,
                expected.2,
                expected.3,
            );
            match (&verdict, blocked) {
                (PrAdoption::NoMatch, false) => {}
                (PrAdoption::StaleHead(_), true) => {}
                _ => panic!("{label}: unexpected verdict {verdict:?}"),
            }
        }
        // A CLOSED pull request does not hold the pair — the branch can be
        // proposed again, so this is a plain "nothing here" rather than a block.
        let mut closed = pr(8, "def456", "task/7", "main", "acme/app");
        closed.state = "closed".into();
        assert_eq!(
            adopt_pull_request(vec![closed], "abc123", "task/7", "main", "acme/app"),
            PrAdoption::NoMatch
        );
    }

    /// A merged match outranks anything else — if the pull request already
    /// landed, the delivery succeeded and must not open a duplicate.
    #[test]
    fn merged_outranks_open_and_closed() {
        let mut merged = pr(7, "abc123", "task/7", "main", "acme/app");
        merged.state = "closed".into();
        merged.merged = true;
        let mut closed = pr(8, "abc123", "task/7", "main", "acme/app");
        closed.state = "closed".into();
        let open = pr(9, "abc123", "task/7", "main", "acme/app");

        match adopt_pull_request(
            vec![closed.clone(), open, merged],
            "abc123",
            "task/7",
            "main",
            "acme/app",
        ) {
            PrAdoption::Merged(found) => assert_eq!(found.number, 7),
            other => panic!("expected the merged one, got {other:?}"),
        }
        // Closed-without-merge alone is reported as such, not as "nothing" —
        // the user gets told a human closed it.
        match adopt_pull_request(vec![closed], "abc123", "task/7", "main", "acme/app") {
            PrAdoption::ClosedUnmerged(found) => assert_eq!(found.number, 8),
            other => panic!("expected ClosedUnmerged, got {other:?}"),
        }
    }

    #[test]
    fn branch_names_that_could_forge_a_refspec_are_rejected() {
        for bad in ["--force", "a:b", "with space", "-x", ""] {
            assert!(ensure_pushable_branch(bad).is_err(), "{bad} must be rejected");
        }
        assert!(ensure_pushable_branch("task/12").is_ok());
    }

    fn auth_for(api_base: String) -> ResolvedAuth {
        ResolvedAuth {
            provider: ForgeProvider::GitHub,
            server_host: "github.test".into(),
            api_base,
            account_id: "acc-test".into(),
            username: "alice".into(),
            avatar_url: None,
            token: "tok-test".into(),
            scopes: vec!["repo".into()],
        }
    }

    fn pull_json(number: i64, merged_at: Option<&str>) -> serde_json::Value {
        serde_json::json!({
            "number": number,
            "html_url": format!("https://github.test/acme/app/pull/{number}"),
            "state": if merged_at.is_some() { "closed" } else { "open" },
            "merged_at": merged_at,
            "head": { "sha": "abc123", "ref": "task/7", "repo": { "full_name": "Acme/App" } },
            "base": { "ref": "main" },
        })
    }

    /// `(api_base, pull-create count, pull-create bodies, comment bodies)`.
    #[allow(clippy::type_complexity)]
    async fn mock_api() -> (
        String,
        Arc<AtomicUsize>,
        Arc<std::sync::Mutex<Vec<serde_json::Value>>>,
        Arc<std::sync::Mutex<Vec<serde_json::Value>>>,
    ) {
        let creates = Arc::new(AtomicUsize::new(0));
        let bodies: Arc<std::sync::Mutex<Vec<serde_json::Value>>> = Default::default();
        let comments: Arc<std::sync::Mutex<Vec<serde_json::Value>>> = Default::default();
        let create_hits = creates.clone();
        let seen = bodies.clone();
        let comment_bodies = comments.clone();
        let app = axum::Router::new()
            .route(
                "/repos/acme/app/pulls",
                get(|Query(q): Query<HashMap<String, String>>| async move {
                    // The mock honors `head` the way the real endpoint does —
                    // verified against the live API before this was written.
                    let rows = match q.get("head").map(String::as_str) {
                        Some("acme:task/7") => vec![pull_json(4, None)],
                        Some("acme:merged") => vec![pull_json(5, Some("2026-08-18T00:00:00Z"))],
                        _ => vec![],
                    };
                    Json(serde_json::Value::Array(rows))
                })
                .post(move |Json(body): Json<serde_json::Value>| {
                    create_hits.fetch_add(1, Ordering::SeqCst);
                    seen.lock().unwrap().push(body);
                    async { Json(pull_json(6, None)) }
                }),
            )
            .route(
                "/conflict/repos/acme/app/pulls",
                post(|| async {
                    (
                        axum::http::StatusCode::UNPROCESSABLE_ENTITY,
                        Json(serde_json::json!({ "message": "No commits between main and task/7" })),
                    )
                }),
            )
            .route(
                "/repos/acme/app/pulls/7",
                get(|| async { Json(pull_json(7, None)) }),
            )
            .route(
                "/repos/acme/app/issues/7/comments",
                post(move |Json(body): Json<serde_json::Value>| {
                    comment_bodies.lock().unwrap().push(body);
                    async {
                        Json(serde_json::json!({
                            "html_url": "https://github.test/acme/app/issues/7#issuecomment-1"
                        }))
                    }
                }),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        (format!("http://{addr}"), creates, bodies, comments)
    }

    /// `merged` is derived from `merged_at`, because the LIST endpoint does not
    /// send a `merged` boolean at all. Getting this wrong would make recovery
    /// bounce deliveries whose pull request had already landed.
    #[tokio::test]
    async fn listed_pulls_report_merged_from_merged_at() {
        let (api_base, _, _, _) = mock_api().await;
        let auth = auth_for(api_base);

        let open = find_pulls(&auth, "Acme/App", "task/7").await.unwrap();
        assert_eq!(open.len(), 1);
        assert!(!open[0].merged && open[0].state == "open");
        assert_eq!(open[0].head_repo, "Acme/App"); // canonical casing preserved

        let merged = find_pulls(&auth, "acme/app", "merged").await.unwrap();
        assert!(merged[0].merged, "merged_at must set the merged flag");

        assert!(find_pulls(&auth, "acme/app", "nothing").await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn create_sends_the_documented_shape() {
        let (api_base, hits, bodies, _) = mock_api().await;
        let auth = auth_for(api_base);
        let created = create_pull(
            &auth,
            "acme/app",
            &NewPullRequest {
                title: "Fix #7",
                head: "task/7",
                base: "main",
                body: "Closes #7",
                draft: true,
            },
        )
        .await
        .unwrap();
        assert_eq!(created.number, 6);
        assert_eq!(hits.load(Ordering::SeqCst), 1);
        let sent = bodies.lock().unwrap().first().cloned().unwrap();
        assert_eq!(sent["head"], "task/7");
        assert_eq!(sent["base"], "main");
        assert_eq!(sent["draft"], true);
    }

    /// "No commits between…" is the 422 an empty delivery earns. It has to
    /// surface as a readable API error, not a panic or a generic network error.
    #[tokio::test]
    async fn empty_delivery_surfaces_the_422() {
        let (api_base, _, _, _) = mock_api().await;
        let auth = auth_for(format!("{api_base}/conflict"));
        match create_pull(
            &auth,
            "acme/app",
            &NewPullRequest {
                title: "t",
                head: "task/7",
                base: "main",
                body: "",
                draft: false,
            },
        )
        .await
        {
            Err(ForgeError::Api { status, message }) => {
                assert_eq!(status, 422);
                assert!(message.contains("No commits between"), "{message}");
            }
            other => panic!("expected a 422 API error, got {other:?}"),
        }
    }

    #[test]
    fn branch_names_are_url_encoded_into_the_head_filter() {
        // A query value keeps its slashes (legal there, and branch names are
        // full of them); a path segment does not — that difference is what
        // makes GitLab's `group%2Fsub%2Fproj` address the right project.
        assert_eq!(urlencode_query("task/7"), "task/7");
        assert_eq!(urlencode_query("feat/a b"), "feat/a%20b");
        assert_eq!(urlencode_query("fix#1"), "fix%231");
        assert_eq!(super::super::urlencode_path("group/sub"), "group%2Fsub");
    }

    #[test]
    fn body_carries_the_closing_keyword() {
        let body = pull_request_body("https://github.com/acme/app/issues/7", 7, 12);
        assert!(body.starts_with("Closes #7\n"));
        // The one reference the body is allowed to make is that closing
        // keyword. The task id sits in a code span so the forge does not
        // autolink it to its own issue 12.
        assert!(body.contains("work task `12`"), "{body}");
        assert!(!body.contains("#12"), "autolinkable task id: {body}");
    }

    /// The trigger gate answers one question: when the agent finishes, is
    /// there anywhere for its commits to go? A task that cannot be delivered
    /// cannot be merged locally either, so it would strand in review.
    #[test]
    fn only_pull_requests_with_somewhere_to_deliver_can_be_worked_on() {
        let gh = ForgeProvider::GitHub;
        let open = pr(7, "abc", "feature", "main", "Acme/App");
        assert!(pull_is_workable(gh, &open, "acme/app").is_ok());

        // Closed but not merged: reopening is a real path, and the delivery
        // says so — that one is NOT refused here.
        let mut closed = open.clone();
        closed.state = "closed".into();
        assert!(pull_is_workable(gh, &closed, "acme/app").is_ok());

        // Merged: nobody can reopen it, so the work would have no destination.
        let mut merged = closed.clone();
        merged.merged = true;
        let err = pull_is_workable(gh, &merged, "acme/app").expect_err("merged");
        assert!(err.contains("already merged"), "{err}");

        // A fork's branch lives in someone else's repository — a real place
        // the delivery can push to, so it is workable.
        let fork = pr(7, "abc", "feature", "main", "contributor/app");
        assert!(pull_is_workable(gh, &fork, "acme/app").is_ok());

        // ...unless that repository cannot even be named: GitHub reports a
        // deleted fork as no repository at all, and GitLab keeps a
        // `project-{id}` placeholder when the fork project is not visible to
        // this account. No name, no push URL, ever.
        let deleted_fork = pr(7, "abc", "feature", "main", "");
        let err = pull_is_workable(gh, &deleted_fork, "acme/app").expect_err("deleted fork");
        assert!(err.contains("fork") && err.contains("cannot see"), "{err}");
        let invisible_fork = pr(7, "abc", "feature", "main", "project-4711");
        let err = pull_is_workable(gh, &invisible_fork, "acme/app").expect_err("placeholder");
        assert!(err.contains("fork"), "{err}");

        // Nothing to check out or push back to.
        let mut headless = open.clone();
        headless.head_ref = " ".into();
        assert!(pull_is_workable(gh, &headless, "acme/app").is_err());
        let mut shaless = open;
        shaless.head_sha = String::new();
        assert!(pull_is_workable(gh, &shaless, "acme/app").is_err());

        // A GitLab user is told about a MERGE request — being told they have a
        // pull request reads like the wrong tool answered.
        let err = pull_is_workable(ForgeProvider::GitLab, &merged, "acme/app")
            .expect_err("merged");
        assert!(err.contains("merge request #7") && !err.contains("pull"), "{err}");
    }

    /// A pull request by number is what turns "PR #7" into something
    /// checkoutable — the list rows the workbench shows carry no refs at all.
    #[tokio::test]
    async fn a_pull_request_is_looked_up_by_number() {
        let (api_base, _, _, _) = mock_api().await;
        let auth = auth_for(api_base);
        let pr = get_pull(&auth, "Acme/App", 7).await.expect("pull");
        assert_eq!((pr.number, pr.head_ref.as_str(), pr.base_ref.as_str()), (7, "task/7", "main"));
        assert_eq!(pr.head_repo, "Acme/App");
        assert!(!pr.merged && pr.state == "open");

        assert!(get_pull(&auth, "acme/app", 0).await.is_err());
        assert!(get_pull(&auth, "not-a-repo", 7).await.is_err());
    }

    /// The write-back goes to `/issues/{n}/comments` — the endpoint that
    /// comments on issues AND pull requests. `/pulls/{n}/comments` would be a
    /// review comment on a diff line and would 422 without a position.
    #[tokio::test]
    async fn a_write_back_posts_to_the_issue_comments_endpoint() {
        let (api_base, _, _, comments) = mock_api().await;
        let auth = auth_for(api_base);
        let url = create_issue_comment(&auth, "Acme/App", 7, "done")
            .await
            .expect("comment");
        assert_eq!(url, "https://github.test/acme/app/issues/7#issuecomment-1");
        let sent = comments.lock().unwrap().first().cloned().unwrap();
        assert_eq!(sent["body"], "done");

        // A path that cannot be a repository never reaches the network.
        assert!(create_issue_comment(&auth, "not-a-repo", 7, "x").await.is_err());
        assert!(create_issue_comment(&auth, "acme/app", 0, "x").await.is_err());
    }

    /// The comment says what happened, in numbers and links. Nothing an agent
    /// wrote can appear in a thread other people are reading.
    #[test]
    fn the_write_back_body_is_numbers_and_links_only() {
        let merged = writeback_comment_body(
            12,
            &TaskOutcome::Merged {
                commit: "abc1234def5678",
                base_branch: "main",
            },
            Some((3, 42, 7)),
        );
        // A code-spanned id, never `#12`: the number is codeg's, and both
        // forges would turn the bare form into a link to their own issue 12.
        assert!(merged.contains("work task `12`"), "{merged}");
        assert!(!merged.contains("#12"), "autolinkable task id: {merged}");
        assert!(merged.contains("`abc1234`"), "short sha: {merged}");
        assert!(!merged.contains("def5678"), "full sha leaked: {merged}");
        assert!(merged.contains("`main`") && merged.contains("(3 files, +42/-7)"), "{merged}");
        // A local merge must not read as "this shipped" to the thread.
        assert!(merged.contains("merged locally into"), "{merged}");

        let delivered = writeback_comment_body(
            12,
            &TaskOutcome::Delivered {
                pr_url: "https://github.com/acme/app/pull/42",
            },
            Some((1, 1, 0)),
        );
        assert!(delivered.contains("https://github.com/acme/app/pull/42"), "{delivered}");
        assert!(delivered.contains("(1 file, +1/-0)"), "singular: {delivered}");

        // No recorded diff → the sentence still stands on its own.
        let bare = writeback_comment_body(12, &TaskOutcome::Delivered { pr_url: "u" }, None);
        assert!(!bare.contains('('), "{bare}");

        // The third settlement says so rather than staying silent — the
        // setting promises a comment whenever a forge task finishes.
        let empty = writeback_comment_body(12, &TaskOutcome::Accepted { nothing_to_land: true }, None);
        assert!(empty.contains("work task `12`") && empty.contains("nothing to land"));
        // …and an acceptance whose worktree was gone must NOT claim there was
        // nothing to land while printing the counters that say otherwise.
        let gone = writeback_comment_body(
            12,
            &TaskOutcome::Accepted { nothing_to_land: false },
            Some((3, 42, 7)),
        );
        assert!(gone.contains("without merging (3 files, +42/-7)"), "{gone}");
        assert!(!gone.contains("nothing to land"), "{gone}");
    }
}
