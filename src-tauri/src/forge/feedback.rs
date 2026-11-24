//! Review feedback on a proposed change, read for the personal agent's PR
//! watch (7.4, phase 3): what reviews said (their verdicts and summaries),
//! comments on lines of the diff, and the conversation's comments — in one
//! vocabulary — and whether an author can write to the repository.
//!
//! - **GitHub**: `pulls/{n}/reviews`, `pulls/{n}/comments` (line comments)
//!   and `issues/{n}/comments`; whether someone can write is
//!   `collaborators/{login}/permission`.
//! - **GitLab**: the merge request's approvals (who approved) and its notes,
//!   a diff note being a line comment; GitLab's approvals carry no "changes
//!   requested", so that verdict is not read there. Whether someone can
//!   write is their membership's access level (Developer and up).
//! - **Gitea**: `pulls/{n}/reviews`, each new review's line comments, and
//!   `issues/{n}/comments`; `collaborators/{login}/permission`.
//! - **CNB**: nothing is read.
//!
//! A few pages of each collection, newest where the forge can sort: a
//! watcher reads this whenever the change was touched, and what it has seen
//! it remembers by id, so older pages add nothing.

use serde::Deserialize;

use super::auth::ResolvedAuth;
use super::{truncate_chars, urlencode_path, ForgeError, ForgeProvider};

/// Pages of one collection read at most.
const PAGES: u32 = 3;
/// Rows per page (Gitea serves at most 50).
const PER_PAGE: u32 = 100;
const GITEA_PER_PAGE: u32 = 50;
/// Line comments of this many new reviews read at most (Gitea).
const GITEA_REVIEWS_READ: usize = 10;
/// The longest text kept of one piece of feedback.
pub const FEEDBACK_BODY_CAP: usize = 8_000;

/// What a review concluded, in one vocabulary.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReviewVerdict {
    Approved,
    ChangesRequested,
    Commented,
    Dismissed,
}

/// Which kind of feedback it is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FeedbackKind {
    /// A review: its verdict, and what it said as a whole.
    Review,
    /// A comment on a line of the diff.
    Line,
    /// A comment in the conversation.
    Comment,
}

/// One piece of feedback on a change.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct FeedbackItem {
    /// `review:<id>`, `line:<id>`, `comment:<id>`, `approval:<user>` —
    /// unique within the change.
    pub id: String,
    pub kind: FeedbackKind,
    #[serde(default)]
    pub author: Option<String>,
    /// The forge's own number for the author, where looking up what they
    /// may do needs it (GitLab).
    #[serde(default)]
    pub author_id: Option<i64>,
    /// An app or a bot account, as the forge says.
    #[serde(default)]
    pub bot: bool,
    /// GitHub's `author_association` (OWNER, MEMBER, COLLABORATOR,
    /// CONTRIBUTOR, NONE…): what is known of the author when their
    /// permission cannot be read.
    #[serde(default)]
    pub association: Option<String>,
    #[serde(default)]
    pub verdict: Option<ReviewVerdict>,
    #[serde(default)]
    pub body: String,
    #[serde(default)]
    pub path: Option<String>,
    #[serde(default)]
    pub line: Option<i64>,
    /// When it was written (a review: submitted), as the forge spells it.
    #[serde(default)]
    pub at: Option<String>,
    #[serde(default)]
    pub url: Option<String>,
}

/// The feedback read on a change.
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize)]
pub struct Feedback {
    pub items: Vec<FeedbackItem>,
    /// Something could not be read (a collection refused): what is here is
    /// not all there is.
    pub partial: bool,
}

/// Whether feedback is read on `provider` at all.
pub fn reads_feedback(provider: ForgeProvider) -> bool {
    provider != ForgeProvider::Cnb
}

/// The feedback on change `number` of `owner_repo`; with `since`, the
/// collections that can be asked for "since" are (the rest are read whole,
/// a few pages of them).
pub async fn change_feedback(
    auth: &ResolvedAuth,
    owner_repo: &str,
    number: i64,
    since: Option<&str>,
) -> Result<Feedback, ForgeError> {
    let repo = super::normalize_repo(owner_repo)
        .ok_or_else(|| ForgeError::Invalid(format!("bad repository path: {owner_repo}")))?;
    if number <= 0 {
        return Err(ForgeError::Invalid(format!(
            "bad work item number: {number}"
        )));
    }
    match auth.provider {
        ForgeProvider::GitHub => github(auth, &repo, number, since).await,
        ForgeProvider::GitLab => gitlab(auth, &repo, number, since).await,
        ForgeProvider::Gitea => gitea(auth, &repo, number, since).await,
        ForgeProvider::Cnb => Ok(Feedback::default()),
    }
}

/// Whether the author of `item` can write to `owner_repo`: `None` when the
/// forge would not say.
pub async fn author_writes(
    auth: &ResolvedAuth,
    owner_repo: &str,
    item: &FeedbackItem,
) -> Result<Option<bool>, ForgeError> {
    let repo = super::normalize_repo(owner_repo)
        .ok_or_else(|| ForgeError::Invalid(format!("bad repository path: {owner_repo}")))?;
    let Some(login) = item.author.as_deref().filter(|a| !a.trim().is_empty()) else {
        return Ok(None);
    };
    match auth.provider {
        ForgeProvider::GitHub => {
            #[derive(Deserialize)]
            struct Permission {
                #[serde(default)]
                permission: String,
                #[serde(default)]
                role_name: String,
            }
            let url = format!(
                "{}/repos/{repo}/collaborators/{}/permission",
                auth.api_base,
                urlencode_path(login)
            );
            match super::github::api_get(auth, &url).await {
                Ok(resp) => {
                    let p: Permission = resp
                        .json()
                        .await
                        .map_err(|e| ForgeError::Network(format!("bad permission payload: {e}")))?;
                    Ok(Some(
                        matches!(p.permission.as_str(), "admin" | "write" | "maintain")
                            || matches!(p.role_name.as_str(), "admin" | "write" | "maintain"),
                    ))
                }
                // Not a collaborator at all.
                Err(ForgeError::NotFound) => Ok(Some(false)),
                // The token may not list collaborators: not known. What
                // the forge says of the author on the item (MEMBER,
                // COLLABORATOR) does not tell write access from read.
                Err(ForgeError::Auth(_)) => Ok(None),
                Err(e) => Err(e),
            }
        }
        ForgeProvider::GitLab => {
            let Some(user) = item.author_id else {
                return Ok(None);
            };
            #[derive(Deserialize)]
            struct Member {
                #[serde(default)]
                access_level: i64,
            }
            let url = format!(
                "{}/projects/{}/members/all/{user}",
                auth.api_base,
                urlencode_path(&repo)
            );
            match super::gitlab::api_get(auth, &url).await {
                Ok(resp) => {
                    let m: Member = resp
                        .json()
                        .await
                        .map_err(|e| ForgeError::Network(format!("bad member payload: {e}")))?;
                    // Developer (30) and up can push.
                    Ok(Some(m.access_level >= 30))
                }
                Err(ForgeError::NotFound) => Ok(Some(false)),
                Err(ForgeError::Auth(_)) => Ok(None),
                Err(e) => Err(e),
            }
        }
        ForgeProvider::Gitea => {
            #[derive(Deserialize)]
            struct Permission {
                #[serde(default)]
                permission: String,
            }
            let url = format!(
                "{}/repos/{repo}/collaborators/{}/permission",
                auth.api_base,
                urlencode_path(login)
            );
            match super::gitea::api_get(auth, &url).await {
                Ok(resp) => {
                    let p: Permission = resp
                        .json()
                        .await
                        .map_err(|e| ForgeError::Network(format!("bad permission payload: {e}")))?;
                    Ok(Some(matches!(
                        p.permission.as_str(),
                        "admin" | "owner" | "write"
                    )))
                }
                Err(ForgeError::NotFound) => Ok(Some(false)),
                Err(ForgeError::Auth(_)) => Ok(None),
                Err(e) => Err(e),
            }
        }
        ForgeProvider::Cnb => Ok(None),
    }
}

fn body_of(raw: Option<String>) -> String {
    truncate_chars(raw.as_deref().unwrap_or_default().trim(), FEEDBACK_BODY_CAP)
}

fn since_query(since: Option<&str>) -> String {
    since
        .map(|s| format!("&since={}", super::urlencode_query(s)))
        .unwrap_or_default()
}

/// Whether a failed read leaves the rest worth reading: a refusal of one
/// collection (a token without that permission, an endpoint the instance
/// lacks) does; a rate limit or the forge being down does not.
fn soft(e: &ForgeError) -> bool {
    matches!(
        e,
        ForgeError::Auth(_)
            | ForgeError::NotFound
            | ForgeError::Api {
                status: 400..=499,
                ..
            }
    )
}

// ── GitHub ──────────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
struct GhUser {
    #[serde(default)]
    login: String,
    #[serde(default, rename = "type")]
    kind: Option<String>,
}

impl GhUser {
    fn is_bot(&self) -> bool {
        self.kind.as_deref() == Some("Bot") || self.login.ends_with("[bot]")
    }
}

#[derive(Debug, Deserialize)]
struct GhReview {
    #[serde(default)]
    id: i64,
    #[serde(default)]
    user: Option<GhUser>,
    #[serde(default)]
    body: Option<String>,
    #[serde(default)]
    state: String,
    #[serde(default)]
    submitted_at: Option<String>,
    #[serde(default)]
    html_url: Option<String>,
    #[serde(default)]
    author_association: Option<String>,
}

#[derive(Debug, Deserialize)]
struct GhComment {
    #[serde(default)]
    id: i64,
    #[serde(default)]
    user: Option<GhUser>,
    #[serde(default)]
    body: Option<String>,
    #[serde(default)]
    path: Option<String>,
    #[serde(default)]
    line: Option<i64>,
    #[serde(default)]
    original_line: Option<i64>,
    #[serde(default)]
    created_at: Option<String>,
    #[serde(default)]
    html_url: Option<String>,
    #[serde(default)]
    author_association: Option<String>,
}

async fn gh_pages<T: serde::de::DeserializeOwned>(
    auth: &ResolvedAuth,
    base: &str,
    partial: &mut bool,
) -> Result<Vec<T>, ForgeError> {
    let mut out = Vec::new();
    for page in 1..=PAGES {
        let url = format!("{base}&per_page={PER_PAGE}&page={page}");
        let rows: Vec<T> = match super::github::api_get(auth, &url).await {
            Ok(resp) => resp
                .json()
                .await
                .map_err(|e| ForgeError::Network(format!("bad feedback payload: {e}")))?,
            Err(e) if soft(&e) => {
                *partial = true;
                break;
            }
            Err(e) => return Err(e),
        };
        let full = rows.len() as u32 >= PER_PAGE;
        out.extend(rows);
        if !full {
            break;
        }
        if page == PAGES {
            *partial = true;
        }
    }
    Ok(out)
}

async fn github(
    auth: &ResolvedAuth,
    repo: &str,
    number: i64,
    since: Option<&str>,
) -> Result<Feedback, ForgeError> {
    let mut partial = false;
    let api = &auth.api_base;
    let reviews: Vec<GhReview> = gh_pages(
        auth,
        &format!("{api}/repos/{repo}/pulls/{number}/reviews?"),
        &mut partial,
    )
    .await?;
    let lines: Vec<GhComment> = gh_pages(
        auth,
        &format!(
            "{api}/repos/{repo}/pulls/{number}/comments?sort=created&direction=desc{}",
            since_query(since)
        ),
        &mut partial,
    )
    .await?;
    let comments: Vec<GhComment> = gh_pages(
        auth,
        &format!(
            "{api}/repos/{repo}/issues/{number}/comments?{}",
            since_query(since).trim_start_matches('&')
        ),
        &mut partial,
    )
    .await?;
    let mut items = Vec::new();
    for r in reviews {
        let verdict = match r.state.as_str() {
            "APPROVED" => ReviewVerdict::Approved,
            "CHANGES_REQUESTED" => ReviewVerdict::ChangesRequested,
            "COMMENTED" => ReviewVerdict::Commented,
            "DISMISSED" => ReviewVerdict::Dismissed,
            // A pending review is its author's draft: nobody else sees it.
            _ => continue,
        };
        items.push(FeedbackItem {
            id: format!("review:{}", r.id),
            kind: FeedbackKind::Review,
            bot: r.user.as_ref().is_some_and(GhUser::is_bot),
            author: r.user.map(|u| u.login).filter(|l| !l.is_empty()),
            author_id: None,
            association: r.author_association,
            verdict: Some(verdict),
            body: body_of(r.body),
            path: None,
            line: None,
            at: r.submitted_at,
            url: r.html_url,
        });
    }
    for (kind, list) in [
        (FeedbackKind::Line, lines),
        (FeedbackKind::Comment, comments),
    ] {
        for c in list {
            items.push(FeedbackItem {
                id: format!(
                    "{}:{}",
                    if kind == FeedbackKind::Line {
                        "line"
                    } else {
                        "comment"
                    },
                    c.id
                ),
                kind,
                bot: c.user.as_ref().is_some_and(GhUser::is_bot),
                author: c.user.map(|u| u.login).filter(|l| !l.is_empty()),
                author_id: None,
                association: c.author_association,
                verdict: None,
                body: body_of(c.body),
                path: c.path,
                line: c.line.or(c.original_line),
                at: c.created_at,
                url: c.html_url,
            });
        }
    }
    Ok(Feedback { items, partial })
}

// ── GitLab ──────────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
struct GlUser {
    #[serde(default)]
    id: Option<i64>,
    #[serde(default)]
    username: String,
    #[serde(default)]
    bot: bool,
}

#[derive(Debug, Deserialize)]
struct GlPosition {
    #[serde(default)]
    new_path: Option<String>,
    #[serde(default)]
    new_line: Option<i64>,
    #[serde(default)]
    old_path: Option<String>,
    #[serde(default)]
    old_line: Option<i64>,
}

#[derive(Debug, Deserialize)]
struct GlNote {
    #[serde(default)]
    id: i64,
    #[serde(default)]
    body: Option<String>,
    #[serde(default)]
    system: bool,
    #[serde(default)]
    author: Option<GlUser>,
    #[serde(default)]
    created_at: Option<String>,
    #[serde(default)]
    updated_at: Option<String>,
    #[serde(default, rename = "type")]
    kind: Option<String>,
    #[serde(default)]
    position: Option<GlPosition>,
}

#[derive(Debug, Deserialize)]
struct GlApprovals {
    #[serde(default)]
    approved_by: Vec<GlApprover>,
}

#[derive(Debug, Deserialize)]
struct GlApprover {
    #[serde(default)]
    user: Option<GlUser>,
}

/// Whether `a` (an RFC 3339 time) is before `b`; `false` when either does
/// not read.
fn before(a: Option<&str>, b: &str) -> bool {
    let parse = |s: &str| chrono::DateTime::parse_from_rfc3339(s).ok();
    match (a.and_then(parse), parse(b)) {
        (Some(a), Some(b)) => a < b,
        _ => false,
    }
}

async fn gitlab(
    auth: &ResolvedAuth,
    repo: &str,
    iid: i64,
    since: Option<&str>,
) -> Result<Feedback, ForgeError> {
    let mut partial = false;
    let project = urlencode_path(repo);
    let api = &auth.api_base;
    let origin = super::web_origin(auth);
    let mut items = Vec::new();
    match super::gitlab::api_get(
        auth,
        &format!("{api}/projects/{project}/merge_requests/{iid}/approvals"),
    )
    .await
    {
        Ok(resp) => {
            let a: GlApprovals = resp
                .json()
                .await
                .map_err(|e| ForgeError::Network(format!("bad approvals payload: {e}")))?;
            for who in a.approved_by.into_iter().filter_map(|a| a.user) {
                items.push(FeedbackItem {
                    id: format!("approval:{}", who.id.unwrap_or_default()),
                    kind: FeedbackKind::Review,
                    bot: who.bot,
                    author: Some(who.username).filter(|u| !u.is_empty()),
                    author_id: who.id,
                    association: None,
                    verdict: Some(ReviewVerdict::Approved),
                    body: String::new(),
                    path: None,
                    line: None,
                    at: None,
                    url: None,
                });
            }
        }
        Err(e) if soft(&e) => partial = true,
        Err(e) => return Err(e),
    }
    // Newest first, so a page all older than `since` ends the read.
    for page in 1..=PAGES {
        let url = format!(
            "{api}/projects/{project}/merge_requests/{iid}/notes\
             ?order_by=updated_at&sort=desc&per_page={PER_PAGE}&page={page}"
        );
        let notes: Vec<GlNote> = match super::gitlab::api_get(auth, &url).await {
            Ok(resp) => resp
                .json()
                .await
                .map_err(|e| ForgeError::Network(format!("bad notes payload: {e}")))?,
            Err(e) if soft(&e) => {
                partial = true;
                break;
            }
            Err(e) => return Err(e),
        };
        let full = notes.len() as u32 >= PER_PAGE;
        let mut older = false;
        for n in notes {
            if since.is_some_and(|s| before(n.updated_at.as_deref(), s)) {
                older = true;
                continue;
            }
            if n.system {
                continue;
            }
            let line = n.kind.as_deref() == Some("DiffNote");
            let (path, at_line) = match n.position.as_ref() {
                Some(p) if line => (
                    p.new_path.clone().or_else(|| p.old_path.clone()),
                    p.new_line.or(p.old_line),
                ),
                _ => (None, None),
            };
            items.push(FeedbackItem {
                id: format!("{}:{}", if line { "line" } else { "comment" }, n.id),
                kind: if line {
                    FeedbackKind::Line
                } else {
                    FeedbackKind::Comment
                },
                bot: n.author.as_ref().is_some_and(|a| a.bot),
                author_id: n.author.as_ref().and_then(|a| a.id),
                author: n.author.map(|a| a.username).filter(|u| !u.is_empty()),
                association: None,
                verdict: None,
                body: body_of(n.body),
                path,
                line: at_line,
                at: n.created_at,
                url: Some(format!(
                    "{origin}/{repo}/-/merge_requests/{iid}#note_{}",
                    n.id
                )),
            });
        }
        if !full || older {
            break;
        }
        if page == PAGES {
            partial = true;
        }
    }
    Ok(Feedback { items, partial })
}

// ── Gitea ───────────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
struct GtUser {
    #[serde(default)]
    login: String,
}

#[derive(Debug, Deserialize)]
struct GtReview {
    #[serde(default)]
    id: i64,
    #[serde(default)]
    user: Option<GtUser>,
    #[serde(default)]
    body: Option<String>,
    #[serde(default)]
    state: String,
    #[serde(default)]
    dismissed: bool,
    #[serde(default)]
    submitted_at: Option<String>,
    #[serde(default)]
    html_url: Option<String>,
    #[serde(default)]
    comments_count: i64,
}

#[derive(Debug, Deserialize)]
struct GtComment {
    #[serde(default)]
    id: i64,
    #[serde(default)]
    user: Option<GtUser>,
    #[serde(default)]
    body: Option<String>,
    #[serde(default)]
    path: Option<String>,
    #[serde(default)]
    position: Option<i64>,
    #[serde(default)]
    original_position: Option<i64>,
    #[serde(default)]
    created_at: Option<String>,
    #[serde(default)]
    html_url: Option<String>,
}

async fn gitea(
    auth: &ResolvedAuth,
    repo: &str,
    number: i64,
    since: Option<&str>,
) -> Result<Feedback, ForgeError> {
    let mut partial = false;
    let api = &auth.api_base;
    let mut reviews: Vec<GtReview> = Vec::new();
    for page in 1..=PAGES {
        let url =
            format!("{api}/repos/{repo}/pulls/{number}/reviews?limit={GITEA_PER_PAGE}&page={page}");
        let rows: Vec<GtReview> = match super::gitea::api_get(auth, &url).await {
            Ok(resp) => resp
                .json()
                .await
                .map_err(|e| ForgeError::Network(format!("bad reviews payload: {e}")))?,
            Err(e) if soft(&e) => {
                partial = true;
                break;
            }
            Err(e) => return Err(e),
        };
        let full = rows.len() as u32 >= GITEA_PER_PAGE;
        reviews.extend(rows);
        if !full {
            break;
        }
        if page == PAGES {
            partial = true;
        }
    }
    let mut items = Vec::new();
    let mut lines_read = 0usize;
    for r in reviews {
        let verdict = if r.dismissed {
            ReviewVerdict::Dismissed
        } else {
            match r.state.as_str() {
                "APPROVED" => ReviewVerdict::Approved,
                "REQUEST_CHANGES" => ReviewVerdict::ChangesRequested,
                "COMMENT" => ReviewVerdict::Commented,
                // PENDING is a draft; REQUEST_REVIEW is asking for one.
                _ => continue,
            }
        };
        let new = since.is_none_or(|s| !before(r.submitted_at.as_deref(), s));
        if new && r.comments_count > 0 && lines_read < GITEA_REVIEWS_READ {
            lines_read += 1;
            let url = format!(
                "{api}/repos/{repo}/pulls/{number}/reviews/{}/comments",
                r.id
            );
            match super::gitea::api_get(auth, &url).await {
                Ok(resp) => {
                    let list: Vec<GtComment> = resp.json().await.map_err(|e| {
                        ForgeError::Network(format!("bad review comments payload: {e}"))
                    })?;
                    for c in list {
                        items.push(FeedbackItem {
                            id: format!("line:{}", c.id),
                            kind: FeedbackKind::Line,
                            bot: false,
                            author: c.user.map(|u| u.login).filter(|l| !l.is_empty()),
                            author_id: None,
                            association: None,
                            verdict: None,
                            body: body_of(c.body),
                            path: c.path,
                            line: c.position.or(c.original_position),
                            at: c.created_at,
                            url: c.html_url,
                        });
                    }
                }
                Err(e) if soft(&e) => partial = true,
                Err(e) => return Err(e),
            }
        } else if new && r.comments_count > 0 {
            partial = true;
        }
        items.push(FeedbackItem {
            id: format!("review:{}", r.id),
            kind: FeedbackKind::Review,
            bot: false,
            author: r.user.map(|u| u.login).filter(|l| !l.is_empty()),
            author_id: None,
            association: None,
            verdict: Some(verdict),
            body: body_of(r.body),
            path: None,
            line: None,
            at: r.submitted_at,
            url: r.html_url,
        });
    }
    let url = format!(
        "{api}/repos/{repo}/issues/{number}/comments?{}",
        since_query(since).trim_start_matches('&')
    );
    match super::gitea::api_get(auth, &url).await {
        Ok(resp) => {
            let list: Vec<GtComment> = resp
                .json()
                .await
                .map_err(|e| ForgeError::Network(format!("bad comments payload: {e}")))?;
            for c in list {
                items.push(FeedbackItem {
                    id: format!("comment:{}", c.id),
                    kind: FeedbackKind::Comment,
                    bot: false,
                    author: c.user.map(|u| u.login).filter(|l| !l.is_empty()),
                    author_id: None,
                    association: None,
                    verdict: None,
                    body: body_of(c.body),
                    path: None,
                    line: None,
                    at: c.created_at,
                    url: c.html_url,
                });
            }
        }
        Err(e) if soft(&e) => partial = true,
        Err(e) => return Err(e),
    }
    Ok(Feedback { items, partial })
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::extract::{Path, Query};
    use axum::routing::get;
    use axum::Json;
    use std::collections::HashMap;

    fn auth(provider: ForgeProvider, api_base: String) -> ResolvedAuth {
        ResolvedAuth {
            provider,
            server_host: "forge.test".into(),
            api_base,
            account_id: "acc".into(),
            username: "codeg-bot".into(),
            avatar_url: None,
            token: "tok".into(),
            scopes: vec![],
        }
    }

    async fn serve(app: axum::Router) -> String {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        format!("http://{addr}")
    }

    #[tokio::test]
    async fn github_feedback_reads_reviews_line_comments_and_the_conversation() {
        let app = axum::Router::new()
            .route(
                "/repos/acme/app/pulls/7/reviews",
                get(|| async {
                    Json(serde_json::json!([
                        { "id": 1, "user": { "login": "maintainer", "type": "User" },
                          "body": "Please split this.", "state": "CHANGES_REQUESTED",
                          "submitted_at": "2026-11-14T10:00:00Z", "author_association": "MEMBER" },
                        { "id": 2, "user": { "login": "drafty" }, "body": "", "state": "PENDING" },
                        { "id": 3, "user": { "login": "ci[bot]", "type": "Bot" }, "body": "ok",
                          "state": "APPROVED", "submitted_at": "2026-11-14T10:05:00Z" }
                    ]))
                }),
            )
            .route(
                "/repos/acme/app/pulls/7/comments",
                get(|Query(q): Query<HashMap<String, String>>| async move {
                    assert_eq!(
                        q.get("since").map(String::as_str),
                        Some("2026-11-14T09:00:00Z")
                    );
                    Json(serde_json::json!([
                        { "id": 11, "user": { "login": "maintainer" }, "body": "Off by one.",
                          "path": "src/a.rs", "line": 12, "created_at": "2026-11-14T10:01:00Z",
                          "html_url": "https://forge.test/acme/app/pull/7#discussion_r11",
                          "author_association": "MEMBER" }
                    ]))
                }),
            )
            .route(
                "/repos/acme/app/issues/7/comments",
                get(|| async {
                    Json(serde_json::json!([
                        { "id": 21, "user": { "login": "passerby" }, "body": "+1",
                          "created_at": "2026-11-14T10:02:00Z", "author_association": "NONE" }
                    ]))
                }),
            )
            .route(
                "/repos/acme/app/collaborators/{login}/permission",
                get(|Path(login): Path<String>| async move {
                    match login.as_str() {
                        "maintainer" => Ok(Json(serde_json::json!({ "permission": "write" }))),
                        "triager" => Ok(Json(
                            serde_json::json!({ "permission": "read", "role_name": "triage" }),
                        )),
                        "member" => Err(axum::http::StatusCode::FORBIDDEN),
                        _ => Err(axum::http::StatusCode::NOT_FOUND),
                    }
                }),
            );
        let base = serve(app).await;
        let a = auth(ForgeProvider::GitHub, base);
        let f = change_feedback(&a, "acme/app", 7, Some("2026-11-14T09:00:00Z"))
            .await
            .unwrap();
        assert!(!f.partial);
        let ids: Vec<&str> = f.items.iter().map(|i| i.id.as_str()).collect();
        assert_eq!(ids, ["review:1", "review:3", "line:11", "comment:21"]);
        let review = &f.items[0];
        assert_eq!(review.verdict, Some(ReviewVerdict::ChangesRequested));
        assert_eq!(review.body, "Please split this.");
        assert!(f.items[1].bot);
        let line = &f.items[2];
        assert_eq!(line.kind, FeedbackKind::Line);
        assert_eq!(
            (line.path.as_deref(), line.line),
            (Some("src/a.rs"), Some(12))
        );
        assert_eq!(
            author_writes(&a, "acme/app", review).await.unwrap(),
            Some(true)
        );
        let mut other = f.items[3].clone();
        assert_eq!(
            author_writes(&a, "acme/app", &other).await.unwrap(),
            Some(false)
        );
        other.author = Some("triager".into());
        assert_eq!(
            author_writes(&a, "acme/app", &other).await.unwrap(),
            Some(false)
        );
        // The permission not readable: not known — an org member may only
        // read, so being one says nothing of writing.
        other.author = Some("member".into());
        other.association = Some("MEMBER".into());
        assert_eq!(author_writes(&a, "acme/app", &other).await.unwrap(), None);
    }

    #[tokio::test]
    async fn gitlab_feedback_reads_approvals_and_notes_newest_first_down_to_since() {
        let app = axum::Router::new()
            .route(
                "/projects/acme%2Fapp/merge_requests/7/approvals",
                get(|| async {
                    Json(serde_json::json!({
                        "approved_by": [ { "user": { "id": 5, "username": "lead" } } ]
                    }))
                }),
            )
            .route(
                "/projects/acme%2Fapp/merge_requests/7/notes",
                get(|| async {
                    Json(serde_json::json!([
                        { "id": 31, "body": "Rename this.", "system": false, "type": "DiffNote",
                          "author": { "id": 5, "username": "lead" },
                          "created_at": "2026-11-14T10:00:00Z", "updated_at": "2026-11-14T10:00:00Z",
                          "position": { "new_path": "src/b.rs", "new_line": 4 } },
                        { "id": 32, "body": "added 1 commit", "system": true,
                          "created_at": "2026-11-14T09:30:00Z", "updated_at": "2026-11-14T09:30:00Z" },
                        { "id": 30, "body": "old", "system": false,
                          "author": { "id": 9, "username": "old" },
                          "created_at": "2026-11-13T10:00:00Z", "updated_at": "2026-11-13T10:00:00Z" }
                    ]))
                }),
            )
            .route(
                "/projects/acme%2Fapp/members/all/{id}",
                get(|Path(id): Path<i64>| async move {
                    if id == 5 {
                        Ok(Json(serde_json::json!({ "access_level": 40 })))
                    } else {
                        Err(axum::http::StatusCode::NOT_FOUND)
                    }
                }),
            );
        let base = serve(app).await;
        let a = auth(ForgeProvider::GitLab, base);
        let f = change_feedback(&a, "acme/app", 7, Some("2026-11-14T00:00:00Z"))
            .await
            .unwrap();
        let ids: Vec<&str> = f.items.iter().map(|i| i.id.as_str()).collect();
        assert_eq!(ids, ["approval:5", "line:31"]);
        assert_eq!(f.items[1].path.as_deref(), Some("src/b.rs"));
        assert_eq!(
            author_writes(&a, "acme/app", &f.items[1]).await.unwrap(),
            Some(true)
        );
        let mut stranger = f.items[1].clone();
        stranger.author_id = Some(9);
        assert_eq!(
            author_writes(&a, "acme/app", &stranger).await.unwrap(),
            Some(false)
        );
    }

    #[tokio::test]
    async fn gitea_feedback_reads_reviews_their_line_comments_and_comments() {
        let app = axum::Router::new()
            .route(
                "/repos/acme/app/pulls/7/reviews",
                get(|| async {
                    Json(serde_json::json!([
                        { "id": 41, "user": { "login": "lead" }, "body": "Needs tests.",
                          "state": "REQUEST_CHANGES", "submitted_at": "2026-11-14T10:00:00+08:00",
                          "comments_count": 1 },
                        { "id": 42, "user": { "login": "lead" }, "state": "PENDING" }
                    ]))
                }),
            )
            .route(
                "/repos/acme/app/pulls/7/reviews/41/comments",
                get(|| async {
                    Json(serde_json::json!([
                        { "id": 51, "user": { "login": "lead" }, "body": "here",
                          "path": "x.go", "position": 3, "created_at": "2026-11-14T10:00:00+08:00" }
                    ]))
                }),
            )
            .route(
                "/repos/acme/app/issues/7/comments",
                get(|| async { Json(serde_json::json!([])) }),
            )
            .route(
                "/repos/acme/app/collaborators/{login}/permission",
                get(|| async { Json(serde_json::json!({ "permission": "write" })) }),
            );
        let base = serve(app).await;
        let a = auth(ForgeProvider::Gitea, base);
        let f = change_feedback(&a, "acme/app", 7, None).await.unwrap();
        let ids: Vec<&str> = f.items.iter().map(|i| i.id.as_str()).collect();
        assert_eq!(ids, ["line:51", "review:41"]);
        assert_eq!(f.items[1].verdict, Some(ReviewVerdict::ChangesRequested));
        assert_eq!(
            author_writes(&a, "acme/app", &f.items[1]).await.unwrap(),
            Some(true)
        );
    }

    #[tokio::test]
    async fn cnb_reads_nothing() {
        let a = auth(ForgeProvider::Cnb, "http://127.0.0.1:9".into());
        assert!(!reads_feedback(ForgeProvider::Cnb));
        let f = change_feedback(&a, "acme/app", 7, None).await.unwrap();
        assert!(f.items.is_empty());
    }
}
