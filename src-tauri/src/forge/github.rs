//! GitHub REST reads for the workbench. Four hard-won rules are load-bearing
//! here (see `.docs/architecture/2026-08-17-Orca-GitHub-GitLab集成分析.md`):
//!
//! 1. The list comes from `/search/issues`, NOT `/repos/{o}/{r}/issues`. This
//!    is what github.com's own issue list is backed by, and the reason is
//!    pagination: `/issues` serves issues and pull requests from one feed with
//!    no way to ask for one kind, so splitting them client-side made every
//!    page sparse ("API page 3" was not "Issues page 3") and no total existed.
//!    `is:issue` / `is:pr` filters server-side and `total_count` comes back,
//!    which is what makes real page numbers possible.
//! 2. `/pulls` is still never an option for the PR tab: it silently ignores
//!    `assignee`/`labels` filters (HTTP 200, unfiltered rows).
//! 3. Search costs more than it looks: a SEPARATE 30-requests-per-minute quota
//!    (core is 5000/hour), and only the first [`SEARCH_RESULT_CAP`] results are
//!    reachable — the same ceiling github.com shows. `incomplete_results` means
//!    the query timed out and the page is partial; it is surfaced, not hidden.
//! 4. `assignee=@me` is a 422 on `/issues`; the literal login is resolved via
//!    `GET /user` (cached per api_base+account) and reused for the `assignee:`
//!    qualifier here.
//!
//! One limit is deliberately NOT worked around: `q` may not exceed 256
//! characters. Ten long label names plus a full-length text filter can pass it,
//! and GitHub answers 422 with a message that says exactly that — which is
//! surfaced. Silently dropping the last few qualifiers would instead show a
//! list that quietly ignores part of what the user asked for.

use std::collections::HashMap;
use std::sync::{LazyLock, RwLock};

use serde::Deserialize;

use super::auth::ResolvedAuth;
use super::{
    sanitize_web_url, scan_timestamp, truncate_chars, urlencode_query, validate_state_filter,
    ForgeChangeDetail, ForgeChangedFile, ForgeChangedFileList, ForgeCheck, ForgeCheckList,
    ForgeCheckState, ForgeComment, ForgeCommentList, ForgeError, ForgeFileStatus, ForgeIssueList,
    ForgeIssueRow, ForgeItemKind, ForgeLabel, ForgeLabelList, ForgeMergeMethod, ForgeMergeOptions,
    ForgeMergeStrategy, ForgeProvider, ForgeStateAction, ForgeTab, ListIssuesRequest,
    OpenItemsScan, ResolvedNewIssue, ScanCursor, BODY_CAP, LABEL_PAGE_SIZE, SCAN_MAX_PAGES,
    SCAN_PAGE_SIZE,
};

/// How deep search pagination goes, per GitHub's documented limit. Beyond this
/// the API errors instead of paging, so `has_next` has to stop here — the same
/// ceiling the github.com issue list has.
pub(crate) const SEARCH_RESULT_CAP: i64 = 1000;

#[derive(Debug, Deserialize)]
struct SearchPage {
    #[serde(default)]
    total_count: i64,
    #[serde(default)]
    incomplete_results: bool,
    #[serde(default)]
    items: Vec<RawIssue>,
}

#[derive(Debug, Deserialize)]
struct RawIssue {
    number: i64,
    #[serde(default)]
    title: String,
    #[serde(default)]
    body: Option<String>,
    #[serde(default)]
    state: String,
    #[serde(default)]
    draft: bool,
    /// Human comments; excludes the timeline's system events.
    #[serde(default)]
    comments: i64,
    #[serde(default)]
    updated_at: Option<String>,
    #[serde(default)]
    html_url: String,
    #[serde(default)]
    user: Option<RawUser>,
    #[serde(default)]
    labels: Vec<RawLabel>,
    /// Presence of this key is what makes a search hit a pull request.
    #[serde(default)]
    pull_request: Option<RawPullRequestRef>,
    /// Set only on a PULL object — `PATCH /pulls/{n}` answers with one, where
    /// the merge stamp sits at the top level instead of under `pull_request`.
    /// An issue never carries it.
    #[serde(default)]
    merged_at: Option<String>,
}

impl RawIssue {
    /// One issue or pull, as the workbench row.
    ///
    /// `is_pr` is an ARGUMENT rather than `pull_request.is_some()`, because the
    /// two endpoints that answer with this shape disagree about it: a search
    /// hit for a pull request carries the `pull_request` key, and the pull
    /// object `PATCH /pulls/{n}` returns does not carry it at all. Deriving it
    /// would turn every state change on a pull request into a row that claims
    /// to be an issue — wrong glyph, wrong link, wrong comment collection.
    fn into_row(self, is_pr: bool) -> ForgeIssueRow {
        let merged = self.merged_at.is_some()
            || self
                .pull_request
                .as_ref()
                .is_some_and(|p| p.merged_at.is_some());
        let (author, author_avatar) = match self.user {
            Some(user) => (
                Some(user.login),
                user.avatar_url.as_deref().and_then(sanitize_web_url),
            ),
            None => (None, None),
        };
        ForgeIssueRow {
            is_pr,
            number: self.number,
            title: self.title,
            body: self.body.map(|b| truncate_chars(&b, BODY_CAP)),
            state: if merged {
                "merged".to_string()
            } else {
                self.state
            },
            draft: is_pr && self.draft,
            labels: self
                .labels
                .into_iter()
                .filter_map(|l| ForgeLabel::parse(l.name, l.color.as_deref()))
                .collect(),
            author,
            author_avatar,
            updated_at: self.updated_at,
            html_url: self.html_url,
            comments: self.comments,
        }
    }
}

#[derive(Debug, Deserialize)]
struct RawPullRequestRef {
    /// Set only once the pull request is merged. GitHub has no `merged` STATE
    /// — a merged pull request reports `state: "closed"` like any other — so
    /// this timestamp is the only thing that tells the two apart.
    #[serde(default)]
    merged_at: Option<String>,
}

#[derive(Debug, Deserialize)]
struct RawUser {
    login: String,
    /// Shipped with every list row, so the panel's author avatar costs no
    /// request of its own. Sanitized on the way out, never here.
    #[serde(default)]
    avatar_url: Option<String>,
}

#[derive(Debug, Deserialize)]
struct RawLabel {
    #[serde(default)]
    name: String,
    /// Six hex digits with NO leading `#` — GitHub's own spelling, which is
    /// why the normalizer accepts the hash rather than requiring it.
    #[serde(default)]
    color: Option<String>,
}

/// A label name as a quoted `label:` qualifier. Always quoted (names carry
/// spaces — `help wanted` — and an unquoted one would split into two terms),
/// with the two characters that end a quoted string escaped.
fn label_qualifier(name: &str) -> String {
    let escaped = name.replace('\\', "\\\\").replace('"', "\\\"");
    format!("label:\"{escaped}\"")
}

/// The user's free text, stripped of query SYNTAX.
///
/// The box is labelled "search title and description", so that is what it has
/// to do: typing `is:closed` must search for those words, not silently widen
/// the list to closed items. `:` and `"` are what form a qualifier and a
/// phrase, and a leading `-` is search's negation — all three go, and runs of
/// whitespace collapse so the result is a clean list of terms (ANDed, which is
/// what a filter box is expected to do).
fn search_terms(raw: &str) -> String {
    raw.split_whitespace()
        .map(|word| {
            word.trim_start_matches(['-', '+'])
                .replace([':', '"'], "")
        })
        .filter(|word| !word.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

/// The `q` value for one tab+filter combination.
///
/// Exactly ONE `repo:` qualifier, which is what keeps this immune to the
/// advanced-search change of 2025-09-04 (a space between MULTIPLE `repo:` /
/// `org:` / `user:` qualifiers flipped from OR to AND).
fn search_query(
    repo: &str,
    tab: ForgeTab,
    state: &str,
    assignee: Option<&str>,
    labels: &[String],
    search: Option<&str>,
) -> String {
    let mut q = format!(
        "repo:{repo} is:{}",
        match tab {
            ForgeTab::Issues => "issue",
            ForgeTab::Prs => "pr",
        }
    );
    // "all" is the absence of a state qualifier, not a value search understands.
    if state == "open" || state == "closed" {
        q.push_str(&format!(" state:{state}"));
    }
    if let Some(login) = assignee {
        q.push_str(&format!(" assignee:{login}"));
    }
    for label in labels {
        q.push(' ');
        q.push_str(&label_qualifier(label));
    }
    if let Some(raw) = search {
        let terms = search_terms(raw);
        if !terms.is_empty() {
            // Scope said out loud. Search's DEFAULT for free text is title,
            // body AND comments, while the box promises "title and
            // description" — without this qualifier a hit whose only match
            // lives in a comment appears with nothing in it to see, and
            // inflates the count and the page numbers with it. GitLab's
            // `search` already defaults to title+description; this is what
            // makes GitHub agree with it.
            q.push_str(" in:title,body ");
            q.push_str(&terms);
        }
    }
    q
}

pub async fn list_issues(
    conn_auth: &ResolvedAuth,
    req: &ListIssuesRequest,
) -> Result<ForgeIssueList, ForgeError> {
    let repo = super::normalize_repo(&req.owner_repo)
        .ok_or_else(|| ForgeError::Invalid(format!("bad repository path: {}", req.owner_repo)))?;
    validate_state_filter(&req.state)?;
    let (page, per_page) = req.clamped();

    let assignee = if req.assigned_me {
        Some(current_login(conn_auth).await?)
    } else {
        None
    };
    let q = search_query(
        &repo,
        req.tab,
        &req.state,
        assignee.as_deref(),
        &req.labels,
        req.search.as_deref(),
    );
    let url = format!(
        "{}/search/issues?q={}&advanced_search=true&sort={}&order={}&page={page}&per_page={per_page}",
        conn_auth.api_base,
        urlencode_query(&q),
        req.sort.field(),
        req.sort.direction(),
    );

    let page_data: SearchPage = api_get(conn_auth, &url)
        .await?
        .json()
        .await
        .map_err(|e| ForgeError::Network(format!("bad search payload: {e}")))?;

    let is_pr = req.tab == ForgeTab::Prs;
    let rows = page_data
        .items
        .into_iter()
        .map(|r| r.into_row(is_pr))
        .collect();

    // Reachable rows, not matching rows: paging past the cap is an error at the
    // API, so a "next" that leads there would be a button into a failure — and
    // so would the numbered page that `total_count` alone implies, which is why
    // the ceiling travels with the page instead of staying local to `has_next`.
    let reachable = page_data.total_count.min(SEARCH_RESULT_CAP);
    Ok(ForgeIssueList {
        rows,
        page,
        per_page,
        total_count: Some(page_data.total_count),
        reachable_count: (page_data.total_count > SEARCH_RESULT_CAP).then_some(SEARCH_RESULT_CAP),
        has_next: i64::from(page) * i64::from(per_page) < reachable,
        incomplete: page_data.incomplete_results,
    })
}

/// Every OPEN item of the wanted kinds updated at or after `since` (every open
/// item when `None`) — what an auto-processing scan reads — starting from
/// where `from` says (a fresh cursor for a new window; the previous scan's
/// [`OpenItemsScan::resume`] to carry on with one cut short).
///
/// `/repos/{o}/{r}/issues`, NOT the search endpoint the workbench list uses,
/// and on purpose — rule 1 above is about PAGE NUMBERS for a person, which a
/// scan has no use for. What it needs is the opposite trade: the plain feed is
/// served from the primary store, so a scan a webhook set off seconds after an
/// issue was filed does find it (search's index trails writes); it filters by
/// `since` server-side; and it spends the core quota instead of search's
/// thirty a minute, which the user's own browsing needs. The feed mixes both
/// kinds — exactly what a scan of both wants — and the `pull_request` key,
/// reliable on this endpoint, splits them.
///
/// Newest-updated first: an item updated while the window is being read moves
/// to the front, so the rows behind it shift down and are read twice rather
/// than skipped (see [`ScanCursor`]).
pub async fn list_open_items(
    auth: &ResolvedAuth,
    owner_repo: &str,
    issues: bool,
    pulls: bool,
    since: Option<chrono::DateTime<chrono::Utc>>,
    from: &ScanCursor,
) -> Result<OpenItemsScan, ForgeError> {
    let repo = super::normalize_repo(owner_repo)
        .ok_or_else(|| ForgeError::Invalid(format!("bad repository path: {owner_repo}")))?;
    let mut rows = Vec::new();
    let mut cursor = ScanCursor::default();
    if issues || pulls {
        super::scan_collection("feed", from, &mut cursor, &mut rows, SCAN_MAX_PAGES, |page| {
            let mut url = format!(
                "{}/repos/{repo}/issues?state=open&sort=updated&direction=desc\
                 &per_page={SCAN_PAGE_SIZE}&page={page}",
                auth.api_base
            );
            if let Some(since) = since {
                url.push_str(&format!("&since={}", urlencode_query(&scan_timestamp(since))));
            }
            async move {
                let response = api_get(auth, &url).await?;
                let has_next = has_next_link(response.headers());
                let raw: Vec<RawIssue> = response
                    .json()
                    .await
                    .map_err(|e| ForgeError::Network(format!("bad issues payload: {e}")))?;
                let kept = raw
                    .into_iter()
                    .filter_map(|item| {
                        let is_pr = item.pull_request.is_some();
                        ((is_pr && pulls) || (!is_pr && issues)).then(|| item.into_row(is_pr))
                    })
                    .collect();
                Ok((kept, has_next))
            }
        })
        .await?;
    }
    Ok(OpenItemsScan {
        rows,
        resume: cursor.has_more().then_some(cursor),
    })
}

/// The repository's labels, for the workbench's label filter.
///
/// `/repos/{o}/{r}/labels`, NOT a search endpoint: this runs on the core quota
/// (5000/hour), so opening the filter costs nothing against the 30-per-minute
/// budget the list itself lives on.
pub async fn list_labels(
    auth: &ResolvedAuth,
    owner_repo: &str,
) -> Result<ForgeLabelList, ForgeError> {
    let repo = super::normalize_repo(owner_repo)
        .ok_or_else(|| ForgeError::Invalid(format!("bad repository path: {owner_repo}")))?;
    let url = format!("{}/repos/{repo}/labels?per_page={LABEL_PAGE_SIZE}", auth.api_base);
    let raw: Vec<RawLabel> = api_get(auth, &url)
        .await?
        .json()
        .await
        .map_err(|e| ForgeError::Network(format!("bad labels payload: {e}")))?;
    // A full page means there may be more. Said out loud rather than silently
    // truncated: a filter list that stops at 100 otherwise reads as complete.
    let truncated = raw.len() >= LABEL_PAGE_SIZE;
    Ok(ForgeLabelList {
        labels: raw
            .into_iter()
            .filter_map(|l| ForgeLabel::parse(l.name, l.color.as_deref()))
            .collect(),
        truncated,
    })
}

/// One page of an item's conversation.
///
/// `/repos/{o}/{r}/issues/{n}/comments` serves ISSUES AND PULL REQUESTS alike
/// — a pull request is an issue here — which is why this takes no item kind at
/// all, and why it is also the endpoint the write-back posts to
/// (`deliver::create_issue_comment`). `/pulls/{n}/comments` is a different
/// collection: review comments anchored to a diff line, which are not what the
/// item's `comments` count counts and not what a reader of the thread expects
/// to find in it.
///
/// On the CORE quota (5000/hour), not search's 30-per-minute one — which is
/// what makes opening the detail panel cheap even though the list it sits over
/// is paid for out of the smaller budget.
pub async fn list_comments(
    auth: &ResolvedAuth,
    owner_repo: &str,
    number: i64,
    page: u32,
    per_page: u32,
) -> Result<ForgeCommentList, ForgeError> {
    let repo = super::normalize_repo(owner_repo)
        .ok_or_else(|| ForgeError::Invalid(format!("bad repository path: {owner_repo}")))?;
    if number <= 0 {
        return Err(ForgeError::Invalid(format!("bad work item number: {number}")));
    }
    // Oldest first, which is this endpoint's own default and the only order a
    // conversation reads in. It takes no `sort` parameter, so there is nothing
    // to state — the ascending order is why "load more" appends.
    let url = format!(
        "{}/repos/{repo}/issues/{number}/comments?page={page}&per_page={per_page}",
        auth.api_base
    );
    let response = api_get(auth, &url).await?;
    // The pagination header, never the row count: a full page is not proof of
    // a next one, and GitHub says so explicitly.
    let has_next = has_next_link(response.headers());
    let raw: Vec<RawComment> = response
        .json()
        .await
        .map_err(|e| ForgeError::Network(format!("bad comments payload: {e}")))?;
    Ok(ForgeCommentList {
        comments: raw.into_iter().map(RawComment::into_comment).collect(),
        page,
        per_page,
        has_next,
    })
}

#[derive(Debug, Deserialize)]
struct RawComment {
    #[serde(default)]
    id: i64,
    #[serde(default)]
    body: Option<String>,
    #[serde(default)]
    created_at: Option<String>,
    #[serde(default)]
    updated_at: Option<String>,
    #[serde(default)]
    html_url: Option<String>,
    #[serde(default)]
    user: Option<RawCommentUser>,
}

#[derive(Debug, Deserialize)]
struct RawCommentUser {
    #[serde(default)]
    login: String,
    #[serde(default)]
    avatar_url: Option<String>,
}

impl RawComment {
    fn into_comment(self) -> ForgeComment {
        let (author, author_avatar) = match self.user {
            Some(user) => (
                ForgeComment::author_name(Some(user.login)),
                user.avatar_url.as_deref().and_then(sanitize_web_url),
            ),
            None => (None, None),
        };
        ForgeComment {
            id: self.id.to_string(),
            author,
            author_avatar,
            body: truncate_chars(self.body.as_deref().unwrap_or_default(), BODY_CAP),
            updated_at: ForgeComment::edited_at(self.created_at.as_deref(), self.updated_at),
            created_at: self.created_at,
            html_url: self.html_url.as_deref().and_then(sanitize_web_url),
        }
    }
}

// ── writes ──────────────────────────────────────────────────────────────────

/// `POST /repos/{o}/{r}/issues/{n}/comments` — the SAME collection
/// [`list_comments`] reads, which is what makes an optimistic append honest: a
/// comment posted here is one the next page of the thread will contain.
///
/// A pull request is an issue at GitHub, so this takes no kind. Note it is not
/// `/pulls/{n}/comments`, which is the review-comment collection anchored to a
/// diff line and is neither what the item's `comments` count counts nor what a
/// reader of the thread expects to find in it.
pub async fn create_comment(
    auth: &ResolvedAuth,
    owner_repo: &str,
    number: i64,
    body: &str,
) -> Result<ForgeComment, ForgeError> {
    let repo = super::normalize_repo(owner_repo)
        .ok_or_else(|| ForgeError::Invalid(format!("bad repository path: {owner_repo}")))?;
    if number <= 0 {
        return Err(ForgeError::Invalid(format!("bad work item number: {number}")));
    }
    let url = format!("{}/repos/{repo}/issues/{number}/comments", auth.api_base);
    let raw: RawComment = api_post(auth, &url, &serde_json::json!({ "body": body }))
        .await?
        .json()
        .await
        .map_err(|e| ForgeError::Network(format!("bad comment payload: {e}")))?;
    Ok(raw.into_comment())
}

/// Close or reopen one item, and hand back the row as the forge now sees it.
///
/// Two endpoints, picked by kind. `/issues/{n}` would very likely serve both —
/// a pull request is an issue here — but `/pulls/{n}` is the documented way to
/// change a pull request's state and its response carries `merged_at` at the
/// top level, which is the one field that tells a merged change from a closed
/// one. Guessing wrong on a merged pull request would paint it "closed".
///
/// The returned row is what the panel and the list both adopt, rather than a
/// local flip of `state`: reopening an issue somebody else closed can fail, be
/// silently refused by a lock, or land alongside edits made in the browser —
/// and the row the forge answers with is the only one of those that is true.
pub async fn set_item_state(
    auth: &ResolvedAuth,
    owner_repo: &str,
    kind: ForgeItemKind,
    number: i64,
    action: ForgeStateAction,
) -> Result<ForgeIssueRow, ForgeError> {
    let repo = super::normalize_repo(owner_repo)
        .ok_or_else(|| ForgeError::Invalid(format!("bad repository path: {owner_repo}")))?;
    if number <= 0 {
        return Err(ForgeError::Invalid(format!("bad work item number: {number}")));
    }
    let collection = match kind {
        ForgeItemKind::Issue => "issues",
        ForgeItemKind::Change => "pulls",
    };
    let url = format!("{}/repos/{repo}/{collection}/{number}", auth.api_base);
    let raw: RawIssue = api_patch(
        auth,
        &url,
        &serde_json::json!({ "state": action.github_state() }),
    )
    .await?
    .json()
    .await
    .map_err(|e| ForgeError::Network(format!("bad item payload: {e}")))?;
    Ok(raw.into_row(kind == ForgeItemKind::Change))
}

/// `POST /repos/{o}/{r}/issues` — open an issue, and hand back the row for it.
///
/// The row is what lets the list show the new issue without a refetch, and it
/// is the forge's copy rather than the draft echoed back: labels the repository
/// does not have are dropped by GitHub, not applied, and the number and URL
/// only exist once it has been written.
pub async fn create_issue(
    auth: &ResolvedAuth,
    owner_repo: &str,
    draft: &ResolvedNewIssue,
) -> Result<ForgeIssueRow, ForgeError> {
    let repo = super::normalize_repo(owner_repo)
        .ok_or_else(|| ForgeError::Invalid(format!("bad repository path: {owner_repo}")))?;
    let url = format!("{}/repos/{repo}/issues", auth.api_base);
    let mut payload = serde_json::json!({ "title": draft.title });
    if let Some(body) = draft.body.as_deref() {
        payload["body"] = serde_json::Value::String(body.to_string());
    }
    if !draft.labels.is_empty() {
        payload["labels"] = serde_json::Value::from(draft.labels.clone());
    }
    let raw: RawIssue = api_post(auth, &url, &payload)
        .await?
        .json()
        .await
        .map_err(|e| ForgeError::Network(format!("bad issue payload: {e}")))?;
    Ok(raw.into_row(false))
}

// ── proposed changes ────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
struct RawPull {
    #[serde(default)]
    number: i64,
    #[serde(default)]
    state: String,
    #[serde(default)]
    draft: bool,
    #[serde(default)]
    merged: bool,
    /// Tri-state on purpose — see [`ForgeChangeDetail::mergeable`].
    #[serde(default)]
    mergeable: Option<bool>,
    #[serde(default)]
    mergeable_state: Option<String>,
    #[serde(default)]
    additions: Option<i64>,
    #[serde(default)]
    deletions: Option<i64>,
    #[serde(default)]
    changed_files: Option<i64>,
    #[serde(default)]
    commits: Option<i64>,
    #[serde(default)]
    head: Option<RawPullRef>,
    #[serde(default)]
    base: Option<RawPullRef>,
}

#[derive(Debug, Deserialize)]
struct RawPullRef {
    #[serde(default, rename = "ref")]
    ref_name: String,
    #[serde(default)]
    sha: Option<String>,
    #[serde(default)]
    repo: Option<RawPullRepo>,
}

#[derive(Debug, Deserialize)]
struct RawPullRepo {
    #[serde(default)]
    full_name: Option<String>,
}

/// One pull request's branches, size and CI — everything the panel shows that
/// a list row does not carry.
///
/// Three requests, all on the CORE quota (5000/hour) rather than search's
/// thirty-a-minute one: the pull itself, then its head commit's check runs and
/// its legacy commit statuses. Both check collections are asked for because
/// repositories genuinely use one or the other — GitHub Actions writes check
/// runs, while external CI (and anything still on the older integration API)
/// writes commit statuses, and a panel that read only one would show "no
/// checks" over a red build.
pub async fn change_detail(
    auth: &ResolvedAuth,
    owner_repo: &str,
    number: i64,
) -> Result<ForgeChangeDetail, ForgeError> {
    let repo = super::normalize_repo(owner_repo)
        .ok_or_else(|| ForgeError::Invalid(format!("bad repository path: {owner_repo}")))?;
    if number <= 0 {
        return Err(ForgeError::Invalid(format!("bad work item number: {number}")));
    }
    let url = format!("{}/repos/{repo}/pulls/{number}", auth.api_base);
    let raw: RawPull = api_get(auth, &url)
        .await?
        .json()
        .await
        .map_err(|e| ForgeError::Network(format!("bad pull payload: {e}")))?;

    let head_sha = raw.head.as_ref().and_then(|h| h.sha.clone());
    let checks = match head_sha.as_deref() {
        Some(sha) => head_checks(auth, &repo, sha).await,
        // No head commit to ask about (a pull whose branch was deleted after a
        // merge can answer this way): nothing was asked, so nothing is claimed.
        None => ForgeCheckList::unavailable(),
    };

    // The head repository is shown only when it is somebody ELSE's — a fork is
    // the fact worth a line; "acme/app → acme/app" is noise on every other
    // change. `same_repo` rather than `==`: GitHub answers in canonical casing.
    let head_repo = raw
        .head
        .as_ref()
        .and_then(|h| h.repo.as_ref())
        .and_then(|r| r.full_name.clone())
        .filter(|full| !super::same_repo(full, &repo));

    Ok(ForgeChangeDetail {
        number: if raw.number > 0 { raw.number } else { number },
        base_ref: raw.base.as_ref().map(|b| b.ref_name.clone()).unwrap_or_default(),
        head_ref: raw.head.as_ref().map(|h| h.ref_name.clone()).unwrap_or_default(),
        head_repo,
        head_sha,
        draft: raw.draft,
        // Same normalization the row gets: GitHub has no `merged` state, so a
        // merged pull reports `closed` and only `merged` tells them apart.
        state: if raw.merged {
            "merged".to_string()
        } else {
            raw.state
        },
        mergeable: raw.mergeable,
        merge_state: raw.mergeable_state.filter(|s| !s.is_empty()),
        additions: raw.additions,
        deletions: raw.deletions,
        changed_files: raw.changed_files,
        commits: raw.commits,
        checks,
    })
}

#[derive(Debug, Deserialize)]
struct RawCheckRunPage {
    #[serde(default)]
    check_runs: Vec<RawCheckRun>,
}

#[derive(Debug, Deserialize)]
struct RawCheckRun {
    #[serde(default)]
    id: i64,
    #[serde(default)]
    name: String,
    /// queued | in_progress | completed | waiting | requested | pending
    #[serde(default)]
    status: String,
    /// Only once `status` is `completed`.
    #[serde(default)]
    conclusion: Option<String>,
    #[serde(default)]
    html_url: Option<String>,
    #[serde(default)]
    output: Option<RawCheckOutput>,
}

#[derive(Debug, Deserialize)]
struct RawCheckOutput {
    #[serde(default)]
    title: Option<String>,
}

#[derive(Debug, Deserialize)]
struct RawCombinedStatus {
    #[serde(default)]
    statuses: Vec<RawCommitStatus>,
}

#[derive(Debug, Deserialize)]
struct RawCommitStatus {
    #[serde(default)]
    id: i64,
    /// The status' name — `context`, not `name`.
    #[serde(default)]
    context: String,
    /// success | failure | error | pending
    #[serde(default)]
    state: String,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    target_url: Option<String>,
}

/// The head commit's checks, from BOTH of GitHub's collections.
///
/// Failure is not propagated: a token without `checks:read` still lists the
/// pull request perfectly well, and losing the panel over a section of it would
/// be a worse answer than the section saying it could not look. Which is
/// exactly what [`ForgeCheckList::unavailable`] means — and why it is not the
/// same value as "there are no checks".
///
/// The two collections sit behind two SEPARATE fine-grained permissions
/// ("Checks" and "Commit statuses"), so half an answer is a real outcome: a
/// token granted only the latter is refused by `/check-runs` and handed an
/// empty `200 []` by `/status`. Reporting that as a complete empty list is the
/// original bug in disguise — GitHub Actions is red and the panel says nothing
/// ran — so a half answer comes back as [`ForgeCheckList::partial`].
async fn head_checks(auth: &ResolvedAuth, repo: &str, sha: &str) -> ForgeCheckList {
    // The sha comes from GitHub's own response, but it lands in a URL path, so
    // it is checked like anything else that does.
    if sha.is_empty() || !sha.chars().all(|c| c.is_ascii_alphanumeric()) {
        return ForgeCheckList::unavailable();
    }
    let runs: Option<Vec<ForgeCheck>> = async {
        let url = format!(
            "{}/repos/{repo}/commits/{sha}/check-runs?per_page={LABEL_PAGE_SIZE}",
            auth.api_base
        );
        let page: RawCheckRunPage = api_get(auth, &url).await.ok()?.json().await.ok()?;
        Some(
            page.check_runs
                .into_iter()
                .map(|run| ForgeCheck {
                    id: format!("run-{}", run.id),
                    state: check_run_state(&run.status, run.conclusion.as_deref()),
                    summary: run
                        .output
                        .and_then(|o| o.title)
                        .filter(|title| !title.trim().is_empty()),
                    url: run.html_url.as_deref().and_then(sanitize_web_url),
                    name: run.name,
                    // GitHub has no per-check "allowed to fail" flag; that is a
                    // branch-protection property of the repository, not of the run.
                    allow_failure: false,
                })
                .collect(),
        )
    }
    .await;

    let statuses: Option<Vec<ForgeCheck>> = async {
        let url = format!(
            "{}/repos/{repo}/commits/{sha}/status?per_page={LABEL_PAGE_SIZE}",
            auth.api_base
        );
        let combined: RawCombinedStatus = api_get(auth, &url).await.ok()?.json().await.ok()?;
        Some(
            combined
                .statuses
                .into_iter()
                .map(|status| ForgeCheck {
                    id: format!("status-{}", status.id),
                    state: commit_status_state(&status.state),
                    summary: status
                        .description
                        .filter(|description| !description.trim().is_empty()),
                    url: status.target_url.as_deref().and_then(sanitize_web_url),
                    name: status.context,
                    allow_failure: false,
                })
                .collect(),
        )
    }
    .await;

    if runs.is_none() && statuses.is_none() {
        return ForgeCheckList::unavailable();
    }
    let partial = runs.is_none() || statuses.is_none();
    let mut checks = runs.unwrap_or_default();
    // A repository can have both, and an integration that writes each way
    // writes the same NAME to both — showing it twice reads as two checks that
    // could disagree.
    for status in statuses.unwrap_or_default() {
        if !checks.iter().any(|check| check.name == status.name) {
            checks.push(status);
        }
    }
    if partial {
        ForgeCheckList::partial(checks)
    } else {
        ForgeCheckList::available(checks)
    }
}

/// A check run's `status` × `conclusion`, folded into the one vocabulary.
fn check_run_state(status: &str, conclusion: Option<&str>) -> ForgeCheckState {
    // `conclusion` is only meaningful once the run has completed; a queued run
    // carries `null` there and reading it as "no verdict" would grey out every
    // check that has not started.
    if status != "completed" {
        return match status {
            "in_progress" => ForgeCheckState::Running,
            _ => ForgeCheckState::Queued,
        };
    }
    match conclusion.unwrap_or_default() {
        "success" => ForgeCheckState::Success,
        // `action_required` is a failure that names its own remedy: the change
        // does not go in until somebody does something.
        "failure" | "timed_out" | "startup_failure" | "action_required" => ForgeCheckState::Failure,
        // Neutral, skipped, cancelled, stale — ran (or deliberately did not)
        // and produced no verdict. NOT success: a skipped required check is
        // not a pass.
        _ => ForgeCheckState::Neutral,
    }
}

/// The legacy commit-status vocabulary. `error` and `failure` are different
/// words for the same outcome as far as a strip of indicators is concerned.
fn commit_status_state(state: &str) -> ForgeCheckState {
    match state {
        "success" => ForgeCheckState::Success,
        "failure" | "error" => ForgeCheckState::Failure,
        "pending" => ForgeCheckState::Running,
        _ => ForgeCheckState::Neutral,
    }
}

#[derive(Debug, Deserialize)]
struct RawPullFile {
    #[serde(default)]
    filename: String,
    #[serde(default)]
    previous_filename: Option<String>,
    /// added | removed | modified | renamed | copied | changed | unchanged
    #[serde(default)]
    status: String,
    #[serde(default)]
    additions: i64,
    #[serde(default)]
    deletions: i64,
    /// Absent for a binary file — and also for a diff GitHub considers too
    /// large to inline, which is why its absence alone does not mean binary.
    #[serde(default)]
    patch: Option<String>,
}

/// One page of the files a pull request touches.
///
/// `/pulls/{n}/files`, on the core quota. GitHub serves at most 3000 files
/// across all pages, and stops offering a `rel="next"` there — so the footer
/// simply runs out, which is the same thing github.com's own "Files changed"
/// tab does.
pub async fn list_change_files(
    auth: &ResolvedAuth,
    owner_repo: &str,
    number: i64,
    page: u32,
    per_page: u32,
) -> Result<ForgeChangedFileList, ForgeError> {
    let repo = super::normalize_repo(owner_repo)
        .ok_or_else(|| ForgeError::Invalid(format!("bad repository path: {owner_repo}")))?;
    if number <= 0 {
        return Err(ForgeError::Invalid(format!("bad work item number: {number}")));
    }
    let url = format!(
        "{}/repos/{repo}/pulls/{number}/files?page={page}&per_page={per_page}",
        auth.api_base
    );
    let response = api_get(auth, &url).await?;
    let has_next = has_next_link(response.headers());
    let raw: Vec<RawPullFile> = response
        .json()
        .await
        .map_err(|e| ForgeError::Network(format!("bad pull files payload: {e}")))?;
    Ok(ForgeChangedFileList {
        files: raw
            .into_iter()
            .map(|file| {
                // No patch AND nothing counted on either side: a text file with
                // a diff too large to inline still reports its line counts, so
                // this is the pair that says "there is nothing textual here".
                let binary = file.patch.is_none() && file.additions == 0 && file.deletions == 0;
                ForgeChangedFile {
                    status: file_status(&file.status),
                    previous_path: file
                        .previous_filename
                        .filter(|previous| !previous.is_empty()),
                    path: file.filename,
                    additions: (!binary).then_some(file.additions),
                    deletions: (!binary).then_some(file.deletions),
                    binary,
                    // An empty patch is dropped rather than passed on: a file
                    // GitHub sent `""` for has nothing to open onto, and a row
                    // that offered the reveal anyway would open onto nothing.
                    patch: file.patch.filter(|patch| !patch.is_empty()),
                }
            })
            .collect(),
        page,
        per_page,
        has_next,
    })
}

/// GitHub's seven file statuses, mapped onto the four a reader distinguishes.
/// `copied` reads as an addition (the path is new); `changed` and `unchanged`
/// are modifications with and without content, and neither warrants its own
/// glyph.
fn file_status(raw: &str) -> ForgeFileStatus {
    match raw {
        "added" | "copied" => ForgeFileStatus::Added,
        "removed" => ForgeFileStatus::Removed,
        "renamed" => ForgeFileStatus::Renamed,
        _ => ForgeFileStatus::Modified,
    }
}

// ── merging ─────────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
struct RawRepoSettings {
    /// All three default to TRUE on a repository, and `#[serde(default)]` would
    /// default them to false — which would answer "no methods permitted" for
    /// any payload that surprised us. `Option` keeps "GitHub did not say"
    /// distinguishable from "GitHub said no".
    #[serde(default)]
    allow_merge_commit: Option<bool>,
    #[serde(default)]
    allow_squash_merge: Option<bool>,
    #[serde(default)]
    allow_rebase_merge: Option<bool>,
}

/// Which merge methods this repository permits.
///
/// `GET /repos/{o}/{r}` — one core-quota request, asked only when the panel is
/// about to offer the button. A repository can forbid any of the three, and
/// GitHub answers a forbidden one with `405 Method Not Allowed` at merge time;
/// a menu built without this would offer entries that can only fail.
///
/// A token that reads the pull request but not the repository's settings is not
/// an error here — [`ForgeMergeOptions::unknown`] is a menu with one safe entry,
/// which is a better answer than no button at all.
pub async fn merge_options(
    auth: &ResolvedAuth,
    owner_repo: &str,
) -> Result<ForgeMergeOptions, ForgeError> {
    let repo = super::normalize_repo(owner_repo)
        .ok_or_else(|| ForgeError::Invalid(format!("bad repository path: {owner_repo}")))?;
    let url = format!("{}/repos/{repo}", auth.api_base);
    let raw: RawRepoSettings = api_get(auth, &url)
        .await?
        .json()
        .await
        .map_err(|e| ForgeError::Network(format!("bad repository payload: {e}")))?;

    // Absent reads as PERMITTED: every one of these defaults to true on a new
    // repository, and an old GitHub Enterprise that omits the key entirely
    // permits all three. Dropping a method GitHub would have accepted is the
    // failure that has no recovery in the UI.
    let allowed = |flag: Option<bool>| flag.unwrap_or(true);
    let methods: Vec<ForgeMergeMethod> = [
        (ForgeMergeMethod::Merge, raw.allow_merge_commit),
        (ForgeMergeMethod::Squash, raw.allow_squash_merge),
        (ForgeMergeMethod::Rebase, raw.allow_rebase_merge),
    ]
    .into_iter()
    .filter(|(_, flag)| allowed(*flag))
    .map(|(method, _)| method)
    .collect();

    Ok(ForgeMergeOptions {
        // A repository CAN have all three turned off (it is then merged only
        // through a merge queue or the command line), and an empty list is the
        // honest answer — the panel reads it as "offer the safe default and let
        // GitHub refuse", which is what would happen anyway.
        default_method: methods.first().copied().unwrap_or(ForgeMergeMethod::Merge),
        methods,
        // Not a question here: GitHub's `merge` writes a merge commit, and the
        // other two shapes are their own methods rather than a repository
        // setting that reinterprets this one (which is GitLab's model).
        merge_strategy: ForgeMergeStrategy::MergeCommit,
    })
}

/// Merge one pull request, and hand back the row the forge now serves.
///
/// Two requests, and the second is why the return is an `Option`. `PUT
/// /pulls/{n}/merge` answers with `{sha, merged, message}` — not with the pull
/// request — so the row the panel and the list adopt has to be re-read. The
/// re-read goes through `RawIssue` exactly as [`set_item_state`] does, because
/// the pull object carries `merged_at` at the TOP level and that timestamp is
/// the only thing that tells a merged pull request from a closed one (GitHub
/// has no merged state; see [`RawIssue::into_row`]).
///
/// `Ok(None)` means IT MERGED AND THE RE-READ FAILED. That is not an error, and
/// making it one was a real bug: the merge is irreversible and already done, so
/// a network blip on the second request would have reported a completed merge
/// as a failure and invited the user to do it again.
///
/// `head_sha`, when given, is the commit the caller was looking at. GitHub
/// refuses with a 409 ("Head branch was modified. Review and try the merge
/// again.") if the branch has moved since — which is the entire point, and a
/// sentence good enough to show as-is.
pub async fn merge_change(
    auth: &ResolvedAuth,
    owner_repo: &str,
    number: i64,
    method: ForgeMergeMethod,
    head_sha: Option<&str>,
) -> Result<Option<ForgeIssueRow>, ForgeError> {
    let repo = super::normalize_repo(owner_repo)
        .ok_or_else(|| ForgeError::Invalid(format!("bad repository path: {owner_repo}")))?;
    if number <= 0 {
        return Err(ForgeError::Invalid(format!("bad work item number: {number}")));
    }
    let url = format!("{}/repos/{repo}/pulls/{number}/merge", auth.api_base);
    let mut payload = serde_json::json!({ "merge_method": method.github_method() });
    if let Some(sha) = head_sha {
        payload["sha"] = serde_json::Value::String(sha.to_string());
    }
    // The response body is read and dropped on purpose: `merged` in it is
    // always true for a 2xx, and everything the panel shows comes from the row
    // below. A 405 (not mergeable, or this method is forbidden here) and a 409
    // (the branch moved) have already become `ForgeError::Api` with GitHub's
    // own sentence in them.
    api_put(auth, &url, &payload).await?;

    // Past this line the change HAS landed, so nothing below may return `Err`.
    let url = format!("{}/repos/{repo}/pulls/{number}", auth.api_base);
    let raw: Option<RawIssue> = async { api_get(auth, &url).await.ok()?.json().await.ok() }.await;
    Ok(raw.map(|raw| raw.into_row(true)))
}

/// Whether GitHub's `Link` header offers a `rel="next"`.
///
/// The alternative — "the page came back full, so there is probably more" —
/// promises a next page that is empty whenever the total is an exact multiple
/// of the page size, which for a page size of 20 is every twentieth thread.
fn has_next_link(headers: &reqwest::header::HeaderMap) -> bool {
    headers
        .get_all("link")
        .iter()
        .filter_map(|value| value.to_str().ok())
        .any(|header| {
            header.split(',').any(|part| {
                // `<url>; rel="next"` — the quotes are what keep this from
                // matching `rel="next-something"` if one ever appeared.
                part.split(';')
                    .skip(1)
                    .any(|param| param.trim().eq_ignore_ascii_case("rel=\"next\""))
            })
        })
}

/// `GET {api_base}/user` → login, cached per `(api_base, account)` — resolving
/// it on every "assigned to me" page would waste a rate-limit point per click.
static LOGIN_CACHE: LazyLock<RwLock<HashMap<String, String>>> =
    LazyLock::new(|| RwLock::new(HashMap::new()));

async fn current_login(auth: &ResolvedAuth) -> Result<String, ForgeError> {
    let cache_key = format!("{}\n{}", auth.api_base, auth.account_id);
    if let Some(hit) = LOGIN_CACHE.read().ok().and_then(|c| c.get(&cache_key).cloned()) {
        return Ok(hit);
    }
    #[derive(Deserialize)]
    struct User {
        login: String,
    }
    let user: User = api_get(auth, &format!("{}/user", auth.api_base))
        .await?
        .json()
        .await
        .map_err(|e| ForgeError::Network(format!("bad /user payload: {e}")))?;
    if let Ok(mut cache) = LOGIN_CACHE.write() {
        cache.insert(cache_key, user.login.clone());
    }
    Ok(user.login)
}

/// Authenticated GET with the standard GitHub headers; non-2xx classified into
/// `ForgeError` (rate limits distinguished from plain auth failures).
pub(crate) async fn api_get(
    auth: &ResolvedAuth,
    url: &str,
) -> Result<reqwest::Response, ForgeError> {
    let response = super::http_client()?
        .get(url)
        .header("Authorization", format!("Bearer {}", auth.token))
        .header("User-Agent", "codeg")
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .send()
        .await
        .map_err(|e| ForgeError::Network(e.to_string()))?;
    let status = response.status();
    if status.is_success() {
        return Ok(response);
    }
    Err(classify_failure(status.as_u16(), response).await)
}

/// Authenticated POST with the same headers and the same failure taxonomy as
/// [`api_get`]. Writes are never retried here: a retried create could open a
/// duplicate pull request, so the caller decides.
pub(crate) async fn api_post(
    auth: &ResolvedAuth,
    url: &str,
    body: &serde_json::Value,
) -> Result<reqwest::Response, ForgeError> {
    send(super::http_client()?.post(url), auth, body).await
}

/// Authenticated PATCH — how GitHub spells "edit an existing thing", and the
/// only method that changes an item's state.
pub(crate) async fn api_patch(
    auth: &ResolvedAuth,
    url: &str,
    body: &serde_json::Value,
) -> Result<reqwest::Response, ForgeError> {
    send(super::http_client()?.patch(url), auth, body).await
}

/// Authenticated PUT. GitHub reserves this for the handful of endpoints that
/// REPLACE rather than edit — merging a pull request is one — and answers PATCH
/// on them with a 404, so it is not interchangeable with [`api_patch`].
pub(crate) async fn api_put(
    auth: &ResolvedAuth,
    url: &str,
    body: &serde_json::Value,
) -> Result<reqwest::Response, ForgeError> {
    send(super::http_client()?.put(url), auth, body).await
}

/// The headers and failure taxonomy every write shares. Writes are never
/// retried here: a retried create could open a duplicate pull request or post
/// a comment twice, so the caller decides.
async fn send(
    request: reqwest::RequestBuilder,
    auth: &ResolvedAuth,
    body: &serde_json::Value,
) -> Result<reqwest::Response, ForgeError> {
    let response = request
        .header("Authorization", format!("Bearer {}", auth.token))
        .header("User-Agent", "codeg")
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .json(body)
        .send()
        .await
        .map_err(|e| ForgeError::Network(e.to_string()))?;
    let status = response.status();
    if status.is_success() {
        return Ok(response);
    }
    Err(classify_failure(status.as_u16(), response).await)
}

async fn classify_failure(status: u16, response: reqwest::Response) -> ForgeError {
    let retry_after = response
        .headers()
        .get("retry-after")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<u64>().ok());
    let primary_exhausted = response
        .headers()
        .get("x-ratelimit-remaining")
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.trim() == "0");
    match status {
        429 => ForgeError::RateLimited { retry_after },
        403 if retry_after.is_some() || primary_exhausted => {
            ForgeError::RateLimited { retry_after }
        }
        401 | 403 => ForgeError::Auth(format!("GitHub returned {status}")),
        404 => ForgeError::NotFound,
        _ => {
            let host = response
                .url()
                .host_str()
                .unwrap_or_default()
                .to_ascii_lowercase();
            let message: String = response
                .text()
                .await
                .unwrap_or_default()
                .chars()
                .take(300)
                .collect();
            // A GitLab asked for GitHub Enterprise's `/api/v3` says so in
            // as many words. That is not an API error to report — it is the
            // instance identifying itself, and the only sane response is to
            // believe it and stop calling this host a GitHub.
            if status == 410 && message.contains("API V3 is no longer supported") {
                super::auth::remember_forge(&host, ForgeProvider::GitLab);
                return ForgeError::WrongForge {
                    host,
                    detected: ForgeProvider::GitLab,
                };
            }
            ForgeError::Api { status, message }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::extract::Query;
    use axum::http::HeaderMap;
    use axum::routing::get;
    use axum::Json;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    fn auth_for(api_base: String) -> ResolvedAuth {
        ResolvedAuth {
            provider: super::super::ForgeProvider::GitHub,
            server_host: "github.test".into(),
            api_base,
            account_id: "acc-test".into(),
            username: "alice".into(),
            avatar_url: Some("https://avatars.github.test/u/1".into()),
            token: "tok-test".into(),
            scopes: vec!["repo".into()],
        }
    }

    /// A search hit. `merged_at` only ever appears inside `pull_request`, which
    /// is also the key that marks the hit as a pull request at all.
    fn hit(number: i64, kind: Kind) -> serde_json::Value {
        let mut v = serde_json::json!({
            "number": number,
            "title": format!("item {number}"),
            "body": format!("body {number}"),
            "state": "open",
            "comments": number,
            "updated_at": "2026-08-17T00:00:00Z",
            "html_url": format!("https://github.test/acme/app/issues/{number}"),
            "user": { "login": "alice", "avatar_url": "https://avatars.github.test/u/1" },
            // Bare six-digit hex, GitHub's own spelling — no leading `#`.
            "labels": [ { "name": "bug", "color": "D73A4A" }, { "name": "" } ],
        });
        match kind {
            Kind::Issue => {}
            Kind::OpenPr => v["pull_request"] = serde_json::json!({ "merged_at": null }),
            Kind::DraftPr => {
                v["draft"] = serde_json::json!(true);
                v["pull_request"] = serde_json::json!({ "merged_at": null });
            }
            Kind::MergedPr => {
                v["state"] = serde_json::json!("closed");
                v["pull_request"] =
                    serde_json::json!({ "merged_at": "2026-08-16T00:00:00Z" });
            }
            Kind::ClosedPr => {
                v["state"] = serde_json::json!("closed");
                v["pull_request"] = serde_json::json!({ "merged_at": null });
            }
        }
        v
    }

    #[derive(Clone, Copy)]
    enum Kind {
        Issue,
        OpenPr,
        DraftPr,
        MergedPr,
        ClosedPr,
    }

    /// The last `q` / `page` / `per_page` the mock was asked for, so a test can
    /// assert what actually went over the wire rather than infer it.
    #[derive(Default)]
    struct LastQuery {
        q: String,
        page: String,
        per_page: String,
        advanced_search: String,
        sort: String,
        order: String,
    }

    /// One mock GitHub search API on an OS-assigned port. Returns the api_base,
    /// the `/user` hit counter and the recorded query params.
    async fn mock_api() -> (String, Arc<AtomicUsize>, Arc<RwLock<LastQuery>>) {
        let user_hits = Arc::new(AtomicUsize::new(0));
        let hits = user_hits.clone();
        let seen = Arc::new(RwLock::new(LastQuery::default()));
        let recorder = seen.clone();
        let app = axum::Router::new()
            .route(
                "/search/issues",
                get(move |Query(params): Query<HashMap<String, String>>| {
                    let recorder = recorder.clone();
                    async move {
                        let q = params.get("q").cloned().unwrap_or_default();
                        if let Ok(mut slot) = recorder.write() {
                            *slot = LastQuery {
                                q: q.clone(),
                                page: params.get("page").cloned().unwrap_or_default(),
                                per_page: params.get("per_page").cloned().unwrap_or_default(),
                                advanced_search: params
                                    .get("advanced_search")
                                    .cloned()
                                    .unwrap_or_default(),
                                sort: params.get("sort").cloned().unwrap_or_default(),
                                order: params.get("order").cloned().unwrap_or_default(),
                            };
                        }
                        // The mock answers the QUERY, the way search does — no
                        // client-side splitting is involved any more.
                        let items = if q.contains("assignee:alice") {
                            vec![hit(9, Kind::Issue)]
                        } else if q.contains("is:pr") {
                            vec![
                                hit(2, Kind::OpenPr),
                                hit(4, Kind::DraftPr),
                                hit(6, Kind::MergedPr),
                                hit(8, Kind::ClosedPr),
                            ]
                        } else {
                            vec![hit(1, Kind::Issue), hit(3, Kind::Issue)]
                        };
                        Json(serde_json::json!({
                            "total_count": 57,
                            "incomplete_results": false,
                            "items": items,
                        }))
                    }
                }),
            )
            .route(
                "/user",
                get(move || {
                    hits.fetch_add(1, Ordering::SeqCst);
                    async { Json(serde_json::json!({ "login": "alice" })) }
                }),
            )
            .route(
                // The repository path goes into the PATH here, lowercased by
                // `normalize_repo` — an `Acme/App` request must land on this.
                "/repos/acme/app/labels",
                get(|| async {
                    Json(serde_json::json!([
                        { "name": "bug", "color": "d73a4a" },
                        // No colour GitHub could have sent — a label written
                        // through some other tool. The name still filters.
                        { "name": "help wanted", "color": "rebeccapurple" },
                        { "name": "" },
                    ]))
                }),
            )
            .route(
                // Comments for BOTH kinds — a pull request is an issue here.
                // Page 1 offers a `Link: rel="next"`, page 2 does not, which is
                // the only signal the client is allowed to page on.
                "/repos/acme/app/issues/42/comments",
                get(|Query(params): Query<HashMap<String, String>>| async move {
                    let page = params.get("page").cloned().unwrap_or_default();
                    let body = if page == "2" {
                        serde_json::json!([{
                            "id": 3,
                            "body": "second page",
                            "created_at": "2026-08-21T00:00:00Z",
                            "updated_at": "2026-08-21T00:00:00Z",
                            "html_url": "https://github.test/acme/app/issues/42#issuecomment-3",
                            "user": { "login": "hubot", "avatar_url": "javascript:alert(1)" },
                        }])
                    } else {
                        serde_json::json!([
                            {
                                "id": 1,
                                "body": "cannot reproduce",
                                "created_at": "2026-08-20T00:00:00Z",
                                // Stamped on creation — NOT an edit.
                                "updated_at": "2026-08-20T00:00:00Z",
                                "html_url": "https://github.test/acme/app/issues/42#issuecomment-1",
                                "user": {
                                    "login": "alice",
                                    "avatar_url": "https://avatars.github.test/u/1",
                                },
                            },
                            {
                                "id": 2,
                                "body": "reworded",
                                "created_at": "2026-08-20T00:00:00Z",
                                "updated_at": "2026-08-20T09:00:00Z",
                                "html_url": "https://github.test/acme/app/issues/42#issuecomment-2",
                                // A comment whose author is gone (deleted
                                // account) — GitHub sends `user: null`.
                                "user": null,
                            },
                        ])
                    };
                    let mut headers = HeaderMap::new();
                    if page != "2" {
                        headers.insert(
                            "link",
                            "<http://x/repos/acme/app/issues/42/comments?page=2>; rel=\"next\", \
                             <http://x/repos/acme/app/issues/42/comments?page=9>; rel=\"last\""
                                .parse()
                                .unwrap(),
                        );
                    }
                    (headers, Json(body))
                }),
            )
            .route(
                "/huge/repos/acme/app/labels",
                get(|| async {
                    let full: Vec<serde_json::Value> = (0..LABEL_PAGE_SIZE)
                        .map(|i| serde_json::json!({ "name": format!("label-{i}") }))
                        .collect();
                    Json(serde_json::Value::Array(full))
                }),
            )
            .route(
                // A repository with more matches than search will paginate.
                "/huge/search/issues",
                get(|| async {
                    Json(serde_json::json!({
                        "total_count": 24_000,
                        "incomplete_results": true,
                        "items": [],
                    }))
                }),
            )
            .route(
                "/limited/search/issues",
                get(|| async {
                    let mut headers = HeaderMap::new();
                    headers.insert("x-ratelimit-remaining", "0".parse().unwrap());
                    headers.insert("retry-after", "31".parse().unwrap());
                    (
                        axum::http::StatusCode::FORBIDDEN,
                        headers,
                        Json(serde_json::json!({ "message": "rate limited" })),
                    )
                }),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        (format!("http://{addr}"), user_hits, seen)
    }

    fn req(tab: ForgeTab) -> ListIssuesRequest {
        ListIssuesRequest {
            owner_repo: "Acme/App".into(),
            tab,
            state: "open".into(),
            assigned_me: false,
            labels: vec![],
            search: None,
            sort: super::super::ForgeSort::default(),
            page: 1,
            per_page: 20,
        }
    }

    /// The query string IS the feature: `is:issue` / `is:pr` is what moved the
    /// tab split from the client to the server, and one `repo:` qualifier is
    /// what keeps advanced-search's OR→AND change irrelevant here.
    #[test]
    fn query_names_one_repo_and_the_kind() {
        assert_eq!(
            search_query("acme/app", ForgeTab::Issues, "open", None, &[], None),
            "repo:acme/app is:issue state:open"
        );
        assert_eq!(
            search_query("acme/app", ForgeTab::Prs, "closed", Some("alice"), &[], None),
            "repo:acme/app is:pr state:closed assignee:alice"
        );
        // "all" is the ABSENCE of a state qualifier — `state:all` matches
        // nothing, so passing it through would empty the list.
        assert_eq!(
            search_query("acme/app", ForgeTab::Prs, "all", None, &[], None),
            "repo:acme/app is:pr"
        );
        assert_eq!(
            search_query("acme/app", ForgeTab::Issues, "open", None, &[], None)
                .matches("repo:")
                .count(),
            1
        );
    }

    /// Labels are ANDed as quoted qualifiers — unquoted, `help wanted` would
    /// split into a label named "help" plus a stray search term.
    #[test]
    fn label_filters_are_quoted_qualifiers() {
        assert_eq!(
            search_query(
                "acme/app",
                ForgeTab::Issues,
                "open",
                None,
                &["bug".to_string(), "help wanted".to_string()],
                None
            ),
            "repo:acme/app is:issue state:open label:\"bug\" label:\"help wanted\""
        );
        // A name carrying the two characters that END a quoted string.
        assert_eq!(label_qualifier(r#"say "hi"\ok"#), r#"label:"say \"hi\"\\ok""#);
    }

    /// The box says "search title and description", so it must not double as a
    /// query box: typing `is:closed` searches for those words and does NOT
    /// widen the list, and a leading `-` does not negate a term.
    #[test]
    fn free_text_is_stripped_of_query_syntax() {
        assert_eq!(search_terms("  login   timeout "), "login timeout");
        assert_eq!(search_terms("is:closed -bug \"exact\""), "isclosed bug exact");
        // Nothing but syntax is nothing at all — an empty tail must not leave a
        // trailing space on `q`.
        assert_eq!(search_terms(" : \" "), "");
        assert_eq!(
            search_query("acme/app", ForgeTab::Issues, "open", None, &[], Some(" : ")),
            "repo:acme/app is:issue state:open"
        );
        assert_eq!(
            search_query(
                "acme/app",
                ForgeTab::Issues,
                "open",
                None,
                &[],
                Some("login timeout")
            ),
            "repo:acme/app is:issue state:open in:title,body login timeout"
        );
    }

    /// …and the scope has to be SAID. GitHub's default for free text is title,
    /// body AND comments, so without `in:` a match living only in a comment
    /// joins the list, the count and the page numbers — under a box that
    /// promises "title and description". GitLab's `search` already means
    /// title+description, so this is what makes the two forges agree.
    #[test]
    fn free_text_searches_only_the_title_and_the_body() {
        let q = search_query("acme/app", ForgeTab::Issues, "open", None, &[], Some("boom"));
        assert!(q.contains("in:title,body"), "{q}");
        // The qualifier belongs to the TEXT: with nothing to search it would be
        // a lone qualifier narrowing a query that has no keywords to narrow.
        assert!(
            !search_query("acme/app", ForgeTab::Issues, "open", None, &[], None)
                .contains("in:"),
            "no text, no scope qualifier"
        );
        assert!(
            !search_query("acme/app", ForgeTab::Issues, "open", None, &[], Some(" : "))
                .contains("in:"),
            "text that was all syntax leaves no text either"
        );
    }

    /// Server-side filtering plus a real total: the page number and size go out
    /// verbatim and `total_count` comes back, which is what page numbers need.
    #[tokio::test]
    async fn list_paginates_by_page_number_with_a_total() {
        let (api_base, _, seen) = mock_api().await;
        let auth = auth_for(api_base);

        let issues = list_issues(
            &auth,
            &ListIssuesRequest { page: 2, per_page: 20, ..req(ForgeTab::Issues) },
        )
        .await
        .unwrap();
        assert_eq!(issues.rows.iter().map(|r| r.number).collect::<Vec<_>>(), vec![1, 3]);
        assert!(issues.rows.iter().all(|r| !r.is_pr));
        // Empty label dropped; the colour rides along, hashed and lowercased.
        assert_eq!(
            issues.rows[0].labels,
            vec![ForgeLabel { name: "bug".into(), color: Some("#d73a4a".into()) }]
        );
        assert_eq!(issues.rows[0].author.as_deref(), Some("alice"));
        // Rides along with the list row — the panel's author avatar costs no
        // request of its own.
        assert_eq!(
            issues.rows[0].author_avatar.as_deref(),
            Some("https://avatars.github.test/u/1")
        );
        assert_eq!((issues.page, issues.per_page), (2, 20));
        assert_eq!(issues.total_count, Some(57));
        // Well under the cap, so nothing is out of reach and the footer builds
        // its page numbers from the total itself.
        assert_eq!(issues.reachable_count, None);
        assert!(issues.has_next, "40 of 57 shown");
        assert!(!issues.incomplete);
        assert_eq!(issues.trustworthy_count(), Some(57), "a badge may show this");

        {
            let sent = seen.read().unwrap();
            assert_eq!(sent.q, "repo:acme/app is:issue state:open");
            assert_eq!((sent.page.as_str(), sent.per_page.as_str()), ("2", "20"));
            assert_eq!(sent.advanced_search, "true");
            // The default order, and the one github.com's own list opens on.
            assert_eq!((sent.sort.as_str(), sent.order.as_str()), ("created", "desc"));
        }
        // The comment count rides along on the same payload.
        assert_eq!(issues.rows[0].comments, 1);

        // Last page: 57 matches, 20 per page → page 3 ends the list.
        let last = list_issues(
            &auth,
            &ListIssuesRequest { page: 3, per_page: 20, ..req(ForgeTab::Issues) },
        )
        .await
        .unwrap();
        assert!(!last.has_next);
    }

    /// Out-of-range paging never reaches the API: `per_page=0` is a 422 there
    /// and `page=0` means different things at the two forges.
    #[tokio::test]
    async fn paging_is_clamped_before_it_is_sent() {
        let (api_base, _, seen) = mock_api().await;
        let auth = auth_for(api_base);

        let list = list_issues(
            &auth,
            &ListIssuesRequest { page: 0, per_page: 9_999, ..req(ForgeTab::Issues) },
        )
        .await
        .unwrap();
        assert_eq!((list.page, list.per_page), (1, 100));
        let sent = seen.read().unwrap();
        assert_eq!((sent.page.as_str(), sent.per_page.as_str()), ("1", "100"));
    }

    /// A pull request's four display states all come off ONE payload: `draft`
    /// on the hit, and `merged_at` inside `pull_request` — GitHub reports a
    /// merged pull request as plain `closed`, so without that timestamp the
    /// merged and the abandoned ones would look identical.
    #[tokio::test]
    async fn pull_request_rows_carry_draft_and_merged() {
        let (api_base, _, _) = mock_api().await;
        let auth = auth_for(api_base);

        let prs = list_issues(&auth, &req(ForgeTab::Prs)).await.unwrap();
        let by_number = |n: i64| prs.rows.iter().find(|r| r.number == n).expect("row");
        assert!(prs.rows.iter().all(|r| r.is_pr));
        assert_eq!((by_number(2).state.as_str(), by_number(2).draft), ("open", false));
        assert_eq!((by_number(4).state.as_str(), by_number(4).draft), ("open", true));
        assert_eq!((by_number(6).state.as_str(), by_number(6).draft), ("merged", false));
        assert_eq!((by_number(8).state.as_str(), by_number(8).draft), ("closed", false));

        // `draft` on an ISSUE hit is meaningless; it must never leak through.
        let issues = list_issues(&auth, &req(ForgeTab::Issues)).await.unwrap();
        assert!(issues.rows.iter().all(|r| !r.draft));
    }

    /// Search only paginates the first [`SEARCH_RESULT_CAP`] results — past
    /// that the API errors, so "next" must stop rather than offer a button
    /// into a failure. A timed-out query is reported, not hidden.
    #[tokio::test]
    async fn paging_stops_at_the_search_cap_and_reports_partial_results() {
        let (api_base, _, _) = mock_api().await;
        let auth = auth_for(format!("{api_base}/huge"));

        let mid = list_issues(
            &auth,
            &ListIssuesRequest { page: 9, per_page: 100, ..req(ForgeTab::Issues) },
        )
        .await
        .unwrap();
        assert_eq!(mid.total_count, Some(24_000), "the true count is still told");
        // …and the ceiling is told SEPARATELY, because page numbers are built
        // from it. Without this the footer would offer page 1200 of a
        // 20-per-page list, and clicking it is a 422.
        assert_eq!(mid.reachable_count, Some(SEARCH_RESULT_CAP));
        assert!(mid.has_next, "900 of a reachable 1000");
        assert!(mid.incomplete);
        // An incomplete search counted FEWER items than match, so the number is
        // not one a bare badge may show.
        assert_eq!(mid.trustworthy_count(), None);

        // Page 10 × 100 lands exactly on the cap: there is no reachable page 11.
        let at_cap = list_issues(
            &auth,
            &ListIssuesRequest { page: 10, per_page: 100, ..req(ForgeTab::Issues) },
        )
        .await
        .unwrap();
        assert!(!at_cap.has_next);
    }

    /// `assignee=@me` would be a 422 — the login is resolved through `/user`
    /// exactly once and reused from the cache afterwards.
    #[tokio::test]
    async fn assigned_me_resolves_login_once() {
        let (api_base, user_hits, seen) = mock_api().await;
        let auth = auth_for(api_base);
        let request = ListIssuesRequest { assigned_me: true, ..req(ForgeTab::Issues) };

        let first = list_issues(&auth, &request).await.unwrap();
        assert_eq!(first.rows.iter().map(|r| r.number).collect::<Vec<_>>(), vec![9]);
        assert!(seen.read().unwrap().q.contains("assignee:alice"));
        let second = list_issues(&auth, &request).await.unwrap();
        assert_eq!(second.rows.len(), 1);
        assert_eq!(user_hits.load(Ordering::SeqCst), 1, "login cached after first use");
    }

    /// 403 + exhausted quota is a rate limit (with its retry hint), NOT an
    /// auth failure — the UI shows a cooldown, not "re-enter your token".
    /// Search has its own, much smaller quota, so this path matters more now.
    #[tokio::test]
    async fn exhausted_quota_classifies_as_rate_limit() {
        let (api_base, _, _) = mock_api().await;
        let auth = auth_for(format!("{api_base}/limited"));
        match list_issues(&auth, &req(ForgeTab::Issues)).await {
            Err(ForgeError::RateLimited { retry_after }) => assert_eq!(retry_after, Some(31)),
            other => panic!("expected RateLimited, got {other:?}"),
        }
    }

    /// Each named order reaches the API as its own `sort`+`order` pair. Without
    /// both halves "oldest" and "newest" would be the same request.
    #[tokio::test]
    async fn every_sort_order_reaches_the_api() {
        use super::super::ForgeSort;
        let (api_base, _, seen) = mock_api().await;
        let auth = auth_for(api_base);
        for (sort, field, direction) in [
            (ForgeSort::Newest, "created", "desc"),
            (ForgeSort::Oldest, "created", "asc"),
            (ForgeSort::RecentlyUpdated, "updated", "desc"),
            (ForgeSort::LeastRecentlyUpdated, "updated", "asc"),
        ] {
            list_issues(&auth, &ListIssuesRequest { sort, ..req(ForgeTab::Issues) })
                .await
                .unwrap();
            let sent = seen.read().unwrap();
            assert_eq!(
                (sent.sort.as_str(), sent.order.as_str()),
                (field, direction),
                "{sort:?}"
            );
        }
    }

    /// Labels and free text both go out on `q`, together with everything else —
    /// the filters compose rather than replacing each other.
    #[tokio::test]
    async fn label_and_text_filters_go_out_together() {
        let (api_base, _, seen) = mock_api().await;
        let auth = auth_for(api_base);
        list_issues(
            &auth,
            &ListIssuesRequest {
                labels: vec!["bug".into(), "help wanted".into()],
                search: Some("login is:open".into()),
                ..req(ForgeTab::Issues)
            },
        )
        .await
        .unwrap();
        assert_eq!(
            seen.read().unwrap().q,
            "repo:acme/app is:issue state:open label:\"bug\" label:\"help wanted\" \
             in:title,body login isopen"
        );
    }

    /// The label vocabulary comes from the repository, on the CORE quota — and
    /// a full page is reported as such, because a filter list that silently
    /// stops at 100 reads as "these are all the labels this repo has".
    #[tokio::test]
    async fn labels_come_from_the_repository_and_admit_truncation() {
        let (api_base, _, _) = mock_api().await;
        let auth = auth_for(api_base.clone());
        let list = list_labels(&auth, "Acme/App").await.expect("labels");
        assert_eq!(
            list.labels,
            vec![
                ForgeLabel { name: "bug".into(), color: Some("#d73a4a".into()) },
                // Unrecognized colour → no colour, NOT a dropped label: the
                // name is what the filter needs, the swatch is decoration.
                ForgeLabel { name: "help wanted".into(), color: None },
            ],
            "empty name dropped"
        );
        assert!(!list.truncated);

        let huge = auth_for(format!("{api_base}/huge"));
        let full = list_labels(&huge, "acme/app").await.expect("labels");
        assert_eq!(full.labels.len(), LABEL_PAGE_SIZE);
        assert!(full.truncated);

        assert!(list_labels(&auth, "no-slash").await.is_err());
    }

    /// The thread comes from the ISSUE comments endpoint — the one that serves
    /// pull requests too — and each entry is normalized on the way out: the
    /// `updated_at` that merely repeats `created_at` is dropped (both are
    /// stamped on creation, so passing it through would mark every comment as
    /// edited) and a non-`http` avatar never reaches an `<img src>`.
    #[tokio::test]
    async fn comments_come_from_the_issue_thread_and_are_normalized() {
        let (api_base, _, _) = mock_api().await;
        let auth = auth_for(api_base);

        let page = list_comments(&auth, "Acme/App", 42, 1, 20).await.expect("comments");
        assert_eq!((page.page, page.per_page), (1, 20));
        let ids: Vec<&str> = page.comments.iter().map(|c| c.id.as_str()).collect();
        assert_eq!(ids, vec!["1", "2"]);

        let first = &page.comments[0];
        assert_eq!(first.author.as_deref(), Some("alice"));
        assert_eq!(first.body, "cannot reproduce");
        assert_eq!(
            first.author_avatar.as_deref(),
            Some("https://avatars.github.test/u/1")
        );
        assert_eq!(
            first.html_url.as_deref(),
            Some("https://github.test/acme/app/issues/42#issuecomment-1")
        );
        // Created and "updated" at the same instant: not an edit.
        assert_eq!(first.updated_at, None);

        // A real edit keeps its timestamp…
        assert_eq!(
            page.comments[1].updated_at.as_deref(),
            Some("2026-08-20T09:00:00Z")
        );
        // …and a deleted account leaves no author rather than an empty name.
        assert_eq!(page.comments[1].author, None);
    }

    /// The row's avatar goes through the same gate a comment's does — it lands
    /// in the same `<img src>`, so a `javascript:` URL is dropped rather than
    /// forwarded, and an author GitHub no longer has leaves no picture at all.
    #[test]
    fn a_rows_avatar_is_sanitized_like_a_comments() {
        let row_for = |user: serde_json::Value| {
            let mut raw = hit(1, Kind::Issue);
            raw["user"] = user;
            serde_json::from_value::<RawIssue>(raw).expect("issue").into_row(false)
        };

        let ok = row_for(serde_json::json!({ "login": "alice", "avatar_url": "https://a.test/1" }));
        assert_eq!(ok.author.as_deref(), Some("alice"));
        assert_eq!(ok.author_avatar.as_deref(), Some("https://a.test/1"));

        let hostile =
            row_for(serde_json::json!({ "login": "alice", "avatar_url": "javascript:alert(1)" }));
        assert_eq!(hostile.author.as_deref(), Some("alice"), "the name still stands");
        assert_eq!(hostile.author_avatar, None);

        // A picture GitHub did not send, and an account it no longer has.
        assert_eq!(row_for(serde_json::json!({ "login": "alice" })).author_avatar, None);
        let gone = row_for(serde_json::Value::Null);
        assert_eq!((gone.author, gone.author_avatar), (None, None));
    }

    /// Paging follows the `Link` header, never "the page came back full" —
    /// which would promise an empty next page on every thread whose length is
    /// an exact multiple of the page size.
    #[tokio::test]
    async fn comment_paging_follows_the_link_header() {
        let (api_base, _, _) = mock_api().await;
        let auth = auth_for(api_base);

        let first = list_comments(&auth, "acme/app", 42, 1, 20).await.expect("page 1");
        assert!(first.has_next);

        let second = list_comments(&auth, "acme/app", 42, 2, 20).await.expect("page 2");
        assert!(!second.has_next, "no rel=next on the last page");
        assert_eq!(second.comments.len(), 1);
        // The `javascript:` avatar is refused rather than forwarded into the
        // attribute that would honour it.
        assert_eq!(second.comments[0].author_avatar, None);

        // The header parser reads the RELATION, not the substring: `rel="next"`
        // and nothing else opens the next page.
        let link = |value: &str| {
            let mut headers = reqwest::header::HeaderMap::new();
            headers.insert("link", value.parse().unwrap());
            has_next_link(&headers)
        };
        assert!(link("<http://x?page=2>; rel=\"next\""));
        assert!(link("<http://x?page=9>; rel=\"last\", <http://x?page=2>; rel=\"next\""));
        assert!(!link("<http://x?page=1>; rel=\"prev\", <http://x?page=1>; rel=\"first\""));
        // A URL that merely CONTAINS the word must not count as the relation.
        assert!(!link("<http://x?q=rel=\"next\">; rel=\"last\""));
        assert!(!has_next_link(&reqwest::header::HeaderMap::new()));
    }

    /// Coordinates a client made up must not read someone else's thread.
    #[tokio::test]
    async fn a_bad_comment_target_is_rejected() {
        let (api_base, _, _) = mock_api().await;
        let auth = auth_for(api_base);
        assert!(matches!(
            list_comments(&auth, "no-slash", 42, 1, 20).await,
            Err(ForgeError::Invalid(_))
        ));
        assert!(matches!(
            list_comments(&auth, "acme/app", 0, 1, 20).await,
            Err(ForgeError::Invalid(_))
        ));
    }

    /// A repository path the client made up must not become a search that
    /// silently reads a DIFFERENT repository.
    #[tokio::test]
    async fn a_bad_repository_path_is_rejected() {
        let (api_base, _, _) = mock_api().await;
        let auth = auth_for(api_base);
        let hostile = ListIssuesRequest {
            owner_repo: "no-slash".into(),
            ..req(ForgeTab::Issues)
        };
        assert!(matches!(
            list_issues(&auth, &hostile).await,
            Err(ForgeError::Invalid(_))
        ));
    }

    // ── writes and change detail ────────────────────────────────────────────

    /// What the mock recorded: `(method, path, body)` per write, so a test can
    /// assert WHICH endpoint was spoken to rather than infer it from a payload
    /// both would have answered with.
    type Writes = Arc<std::sync::Mutex<Vec<(String, String, serde_json::Value)>>>;

    /// A second mock, covering the write and pull-detail surface. Its own
    /// server rather than more routes on `mock_api`: these tests care about
    /// method and path, which that one records nothing about.
    async fn mock_write_api() -> (String, Writes) {
        use axum::extract::Path;
        use axum::routing::{patch, post, put};
        let writes: Writes = Arc::new(std::sync::Mutex::new(Vec::new()));

        let record = |writes: Writes, method: &'static str, path: String, body: serde_json::Value| {
            writes.lock().unwrap().push((method.to_string(), path, body));
        };

        let w = writes.clone();
        let comments = post(
            move |Path(number): Path<i64>, Json(body): Json<serde_json::Value>| {
                let w = w.clone();
                async move {
                    record(w, "POST", format!("issues/{number}/comments"), body.clone());
                    Json(serde_json::json!({
                        "id": 991,
                        "body": body["body"],
                        "created_at": "2026-08-27T10:00:00Z",
                        "updated_at": "2026-08-27T10:00:00Z",
                        "html_url": "https://github.test/acme/app/issues/42#issuecomment-991",
                        "user": { "login": "alice", "avatar_url": "https://avatars.test/u/1" },
                    }))
                }
            },
        );

        let w = writes.clone();
        let patch_issue = patch(
            move |Path(number): Path<i64>, Json(body): Json<serde_json::Value>| {
                let w = w.clone();
                async move {
                    record(w, "PATCH", format!("issues/{number}"), body.clone());
                    Json(serde_json::json!({
                        "number": number,
                        "title": "Login times out",
                        "state": body["state"],
                        "comments": 2,
                        "html_url": "https://github.test/acme/app/issues/42",
                        "user": { "login": "alice" },
                        "labels": [{ "name": "bug", "color": "d73a4a" }],
                    }))
                }
            },
        );

        let w = writes.clone();
        let patch_pull = patch(
            move |Path(number): Path<i64>, Json(body): Json<serde_json::Value>| {
                let w = w.clone();
                async move {
                    record(w, "PATCH", format!("pulls/{number}"), body.clone());
                    // A pull that got MERGED between the panel drawing and the
                    // button being pressed: GitHub reports `state: "closed"`
                    // and the merge stamp at the TOP level, not under
                    // `pull_request` the way a search hit carries it.
                    Json(serde_json::json!({
                        "number": number,
                        "title": "Fix the timeout",
                        "state": "closed",
                        "merged_at": "2026-08-27T09:00:00Z",
                        "draft": false,
                        "comments": 4,
                        "html_url": "https://github.test/acme/app/pull/7",
                        "user": { "login": "bob" },
                        "labels": [],
                    }))
                }
            },
        );

        let w = writes.clone();
        let new_issue = post(move |Json(body): Json<serde_json::Value>| {
            let w = w.clone();
            async move {
                record(w, "POST", "issues".to_string(), body.clone());
                Json(serde_json::json!({
                    "number": 123,
                    "title": body["title"],
                    "body": body["body"],
                    "state": "open",
                    "comments": 0,
                    "html_url": "https://github.test/acme/app/issues/123",
                    "user": { "login": "alice" },
                    "labels": [{ "name": "bug", "color": "d73a4a" }],
                }))
            }
        });

        let w = writes.clone();
        let merge_pull = put(
            move |Path(number): Path<i64>, Json(body): Json<serde_json::Value>| {
                let w = w.clone();
                async move {
                    record(w, "PUT", format!("pulls/{number}/merge"), body.clone());
                    // What GitHub actually answers with — NOT the pull request,
                    // which is why the row has to be re-read afterwards.
                    Json(serde_json::json!({
                        "sha": "9f1c0de",
                        "merged": true,
                        "message": "Pull Request successfully merged",
                    }))
                }
            },
        );

        // The re-read `merge_change` does. Same path as the PATCH above, which
        // is the point: `RawIssue` reads a pull payload either way.
        let pull_item = patch_pull.get(|Path(number): Path<i64>| async move {
            Json(serde_json::json!({
                "number": number,
                "title": "Fix the timeout",
                "state": "closed",
                "merged_at": "2026-08-27T09:30:00Z",
                "draft": false,
                "comments": 4,
                "html_url": "https://github.test/acme/app/pull/7",
                "user": { "login": "bob" },
                "labels": [],
            }))
        });

        let app = axum::Router::new()
            .route("/repos/acme/app/issues/{number}/comments", comments)
            .route("/repos/acme/app/issues/{number}", patch_issue)
            .route("/repos/acme/app/pulls/{number}", pull_item)
            .route("/repos/acme/app/pulls/{number}/merge", merge_pull)
            .route("/repos/acme/app/issues", new_issue)
            .route(
                "/repos/acme/app",
                get(|| async {
                    Json(serde_json::json!({
                        "allow_merge_commit": true,
                        "allow_squash_merge": false,
                        "allow_rebase_merge": true,
                    }))
                }),
            )
            // An instance old enough to omit the keys entirely. Every one of
            // them defaults to ON, so silence must not read as "forbidden".
            .route("/repos/acme/legacy", get(|| async { Json(serde_json::json!({})) }))
            .route(
                "/repos/acme/blocked/pulls/{number}/merge",
                put(|| async {
                    (
                        axum::http::StatusCode::METHOD_NOT_ALLOWED,
                        "{\"message\":\"Merge commits are not allowed on this repository.\"}",
                    )
                }),
            )
            // Merges fine, then refuses the re-read.
            .route("/repos/acme/halfblind/pulls/{number}/merge", {
                let w = writes.clone();
                put(
                    move |Path(number): Path<i64>, Json(body): Json<serde_json::Value>| {
                        let w = w.clone();
                        async move {
                            record(w, "PUT", format!("pulls/{number}/merge"), body.clone());
                            Json(serde_json::json!({ "sha": "9f1c0de", "merged": true }))
                        }
                    },
                )
            })
            .route(
                "/repos/acme/halfblind/pulls/{number}",
                get(|| async { axum::http::StatusCode::INTERNAL_SERVER_ERROR }),
            )
            .route(
                "/detail/repos/acme/app/pulls/7",
                get(|| async {
                    Json(serde_json::json!({
                        "number": 7,
                        "state": "open",
                        "draft": true,
                        "merged": false,
                        "mergeable": serde_json::Value::Null,
                        "mergeable_state": "unknown",
                        "additions": 120,
                        "deletions": 8,
                        "changed_files": 3,
                        "commits": 2,
                        "head": {
                            "ref": "fix/timeout",
                            "sha": "abc123",
                            // A FORK — canonical casing, which `same_repo` has
                            // to see through before deciding it is foreign.
                            "repo": { "full_name": "contributor/App" },
                        },
                        "base": { "ref": "main", "sha": "def456",
                                  "repo": { "full_name": "Acme/App" } },
                    }))
                }),
            )
            .route(
                "/detail/repos/acme/app/commits/abc123/check-runs",
                get(|| async {
                    Json(serde_json::json!({ "check_runs": [
                        { "id": 1, "name": "build", "status": "completed",
                          "conclusion": "success", "html_url": "https://ci.test/1",
                          "output": { "title": "12 tests passed" } },
                        // Not started: `conclusion` is null and must NOT read
                        // as "no verdict" — that would grey out every queued run.
                        { "id": 2, "name": "e2e", "status": "queued",
                          "conclusion": serde_json::Value::Null,
                          "html_url": "javascript:alert(1)" },
                        // Skipped is not a pass.
                        { "id": 3, "name": "deploy", "status": "completed",
                          "conclusion": "skipped" },
                        { "id": 4, "name": "lint", "status": "completed",
                          "conclusion": "action_required" },
                    ] }))
                }),
            )
            .route(
                "/detail/repos/acme/app/commits/abc123/status",
                get(|| async {
                    Json(serde_json::json!({ "statuses": [
                        { "id": 9, "context": "codecov", "state": "error",
                          "description": "coverage fell", "target_url": "https://cov.test/9" },
                        // The SAME name an Action already reported under: one
                        // check, not two that could disagree.
                        { "id": 10, "context": "build", "state": "success" },
                    ] }))
                }),
            )
            .route(
                "/detail/repos/acme/app/pulls/7/files",
                get(|| async {
                    Json(serde_json::json!([
                        { "filename": "src/a.rs", "status": "modified",
                          "additions": 10, "deletions": 2, "patch": "@@ -1 +1 @@" },
                        { "filename": "src/new.rs", "previous_filename": "src/old.rs",
                          "status": "renamed", "additions": 0, "deletions": 0,
                          "patch": "@@ -1 +1 @@" },
                        // No patch and nothing counted on either side: binary.
                        { "filename": "logo.png", "status": "added",
                          "additions": 0, "deletions": 0 },
                        { "filename": "gone.rs", "status": "removed",
                          "additions": 0, "deletions": 40, "patch": "@@ -1,40 +0,0 @@" },
                        // Counted on both sides but no patch: a TEXT file whose
                        // diff GitHub withheld for its size. Not binary, and
                        // nothing to open onto either.
                        { "filename": "pnpm-lock.yaml", "status": "modified",
                          "additions": 4000, "deletions": 3000 },
                    ]))
                }),
            )
            // "Commit statuses: read" WITHOUT "Checks: read" — two separate
            // fine-grained permissions, so half the answer arrives and the
            // other half is a 403. The empty status list must not be served as
            // a complete "nothing ran".
            .route(
                "/half/repos/acme/app/pulls/7",
                get(|| async {
                    Json(serde_json::json!({
                        "number": 7, "state": "open",
                        "head": { "ref": "x", "sha": "abc123" },
                        "base": { "ref": "main" },
                    }))
                }),
            )
            .route(
                "/half/repos/acme/app/commits/abc123/check-runs",
                get(|| async { axum::http::StatusCode::FORBIDDEN }),
            )
            .route(
                "/half/repos/acme/app/commits/abc123/status",
                get(|| async { Json(serde_json::json!({ "statuses": [] })) }),
            )
            // A token without `checks:read`: the pull still lists, the CI
            // section must say it could not look rather than "no checks".
            .route(
                "/blind/repos/acme/app/pulls/7",
                get(|| async {
                    Json(serde_json::json!({
                        "number": 7, "state": "open",
                        "head": { "ref": "x", "sha": "abc123" },
                        "base": { "ref": "main" },
                    }))
                }),
            )
            .route(
                "/blind/repos/acme/app/commits/abc123/check-runs",
                get(|| async { axum::http::StatusCode::FORBIDDEN }),
            )
            .route(
                "/blind/repos/acme/app/commits/abc123/status",
                get(|| async { axum::http::StatusCode::FORBIDDEN }),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        (format!("http://{addr}"), writes)
    }

    /// The reported bug, from the client's side: a self-hosted GitLab that
    /// codeg had classified as a GitHub Enterprise gets asked for `/api/v3`,
    /// and GitLab replies 410 saying exactly what it is.
    ///
    /// That must not surface as "forge API error 410: {...}" — the raw dump the
    /// issue reporter saw. It is an identification, so it becomes
    /// [`ForgeError::WrongForge`] AND is written to the detection cache, which
    /// is what makes the caller's retry go to the GitLab client instead.
    #[tokio::test]
    async fn a_gitlab_answering_a_v3_request_identifies_itself() {
        use axum::routing::get;
        // `/search/issues` is where this client's list comes from — see the
        // module header. The path only has to be the one actually requested;
        // what is under test is how the ANSWER is classified.
        let app = axum::Router::new().route(
            "/search/issues",
            get(|| async {
                (
                    axum::http::StatusCode::GONE,
                    "{\"error\":\"API V3 is no longer supported. Use API V4 instead.\"}",
                )
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });

        let auth = auth_for(format!("http://{addr}"));
        let err = list_issues(&auth, &req(ForgeTab::Issues))
            .await
            .expect_err("410 must not be a success");
        match err {
            ForgeError::WrongForge { detected, host } => {
                assert_eq!(detected, ForgeProvider::GitLab);
                assert_eq!(host, "127.0.0.1");
            }
            other => panic!("expected WrongForge, got {other:?}"),
        }
        // Corrected BEFORE the error was returned, so the caller's retry cannot
        // land on the same wrong client.
        assert_eq!(
            super::super::auth::recall_forge("127.0.0.1"),
            Some(ForgeProvider::GitLab)
        );
        super::super::auth::forget_forge("127.0.0.1");
    }

    /// A 410 that is NOT GitLab identifying itself stays an ordinary API error.
    /// The body is the whole discriminator, so a bare status must not be enough
    /// to re-classify a host.
    ///
    /// Addressed as `localhost` rather than `127.0.0.1` on purpose: the
    /// detection cache is keyed by host and process-wide, so sharing a key with
    /// the test above would make the two race.
    #[tokio::test]
    async fn an_unrelated_410_is_still_an_api_error() {
        use axum::routing::get;
        let app = axum::Router::new().route(
            "/search/issues",
            get(|| async { (axum::http::StatusCode::GONE, "{\"message\":\"Issues are disabled\"}") }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });

        let auth = auth_for(format!("http://localhost:{port}"));
        let err = list_issues(&auth, &req(ForgeTab::Issues)).await.expect_err("410");
        assert!(matches!(err, ForgeError::Api { status: 410, .. }), "got {err:?}");
        assert_eq!(super::super::auth::recall_forge("localhost"), None);
    }

    /// The composer gets the STORED comment back — id, author and permalink —
    /// not the text it sent. Those are what the thread keys, de-duplicates and
    /// links by, and an echo of the draft has none of them.
    #[tokio::test]
    async fn a_posted_comment_comes_back_as_the_forge_stored_it() {
        let (api_base, writes) = mock_write_api().await;
        let auth = auth_for(api_base);
        let comment = create_comment(&auth, "Acme/App", 42, "looks fixed")
            .await
            .expect("comment");
        assert_eq!(comment.id, "991");
        assert_eq!(comment.author.as_deref(), Some("alice"));
        assert_eq!(comment.body, "looks fixed");
        // Stamped on creation, so NOT an edit — the same rule the reader
        // applies, which is what keeps "edited" off a comment just written.
        assert_eq!(comment.updated_at, None);
        assert!(comment.html_url.is_some());
        let sent = writes.lock().unwrap().clone();
        // The ISSUE comments collection for both kinds — `/pulls/{n}/comments`
        // is review comments on a diff line and would 422 without a position.
        assert_eq!(sent[0].1, "issues/42/comments");

        assert!(create_comment(&auth, "not-a-repo", 42, "x").await.is_err());
        assert!(create_comment(&auth, "acme/app", 0, "x").await.is_err());
    }

    /// An issue and a pull request are edited through DIFFERENT endpoints, and
    /// the pull one is what carries the top-level `merged_at` — the only field
    /// that tells a merged change from a closed one.
    #[tokio::test]
    async fn a_state_change_uses_the_collection_the_item_belongs_to() {
        let (api_base, writes) = mock_write_api().await;
        let auth = auth_for(api_base);

        let issue = set_item_state(
            &auth,
            "Acme/App",
            ForgeItemKind::Issue,
            42,
            ForgeStateAction::Close,
        )
        .await
        .expect("close issue");
        assert!(!issue.is_pr);
        assert_eq!(issue.state, "closed");
        assert_eq!(issue.labels.first().map(|l| l.name.as_str()), Some("bug"));

        let pull = set_item_state(
            &auth,
            "Acme/App",
            ForgeItemKind::Change,
            7,
            ForgeStateAction::Close,
        )
        .await
        .expect("close pull");
        assert!(pull.is_pr, "the KIND decides this, not a payload key");
        // It was merged in the browser a moment ago. Adopting a local "closed"
        // would have painted a merged pull request with the closed glyph.
        assert_eq!(pull.state, "merged");

        let sent = writes.lock().unwrap().clone();
        assert_eq!(sent[0].1, "issues/42");
        assert_eq!(sent[0].2["state"], "closed");
        assert_eq!(sent[1].1, "pulls/7");
        assert_eq!(sent[1].0, "PATCH", "GitHub edits with PATCH, not PUT");

        assert!(set_item_state(&auth, "acme/app", ForgeItemKind::Issue, 0, ForgeStateAction::Reopen)
            .await
            .is_err());
    }

    /// The menu is what the REPOSITORY permits. A method it has turned off
    /// answers 405 at merge time, so offering it would be offering a button
    /// that can only fail.
    #[tokio::test]
    async fn merge_options_drop_what_the_repository_forbids() {
        let (api_base, _writes) = mock_write_api().await;
        let auth = auth_for(api_base);

        let options = merge_options(&auth, "Acme/App").await.expect("options");
        assert_eq!(
            options.methods,
            vec![ForgeMergeMethod::Merge, ForgeMergeMethod::Rebase],
            "squash is off on this repository"
        );
        // The first one still permitted, not a hard-coded Merge.
        assert_eq!(options.default_method, ForgeMergeMethod::Merge);
        // Not a question on GitHub: `merge` writes a merge commit, always.
        assert_eq!(options.merge_strategy, ForgeMergeStrategy::MergeCommit);

        // Silence is PERMISSION here: all three default to on, and an instance
        // that omits the keys permits them all. Reading absent as "forbidden"
        // would leave an empty menu on a repository that merges fine.
        let legacy = merge_options(&auth, "acme/legacy").await.expect("legacy");
        assert_eq!(
            legacy.methods,
            vec![
                ForgeMergeMethod::Merge,
                ForgeMergeMethod::Squash,
                ForgeMergeMethod::Rebase
            ]
        );

        assert!(merge_options(&auth, "not-a-repo").await.is_err());
    }

    /// Merging sends the method the caller picked, and the row comes from a
    /// RE-READ: GitHub's merge response carries `{sha, merged, message}` and no
    /// pull request at all, so there is nothing in it to build a row from.
    #[tokio::test]
    async fn a_merge_sends_the_method_and_re_reads_the_row() {
        let (api_base, writes) = mock_write_api().await;
        let auth = auth_for(api_base);

        let row = merge_change(&auth, "Acme/App", 7, ForgeMergeMethod::Squash, Some("abc123"))
            .await
            .expect("merge")
            .expect("a row came back");
        assert!(row.is_pr);
        // The whole reason for the second request: GitHub has no merged STATE,
        // and the re-read's top-level `merged_at` is what turns `closed` into
        // `merged`. A local guess would paint this one abandoned.
        assert_eq!(row.state, "merged");
        assert_eq!(row.number, 7);

        let sent = writes.lock().unwrap().clone();
        assert_eq!(sent.len(), 1, "only the merge is a write");
        assert_eq!(sent[0].0, "PUT", "GitHub merges with PUT, not PATCH");
        assert_eq!(sent[0].1, "pulls/7/merge");
        assert_eq!(sent[0].2["merge_method"], "squash");
        // The commit the caller was LOOKING at. Without it GitHub merges
        // whatever the branch points at now, which after a push is code the
        // reviewer never saw.
        assert_eq!(sent[0].2["sha"], "abc123");

        // No head to name: the guard is dropped rather than sent as a null,
        // which GitHub would reject outright.
        merge_change(&auth, "acme/app", 7, ForgeMergeMethod::Merge, None)
            .await
            .expect("merge without a head");
        let sent = writes.lock().unwrap().clone();
        assert!(sent[1].2.get("sha").is_none(), "absent, not null");

        assert!(
            merge_change(&auth, "acme/app", 0, ForgeMergeMethod::Merge, None)
                .await
                .is_err()
        );
        assert!(
            merge_change(&auth, "not-a-repo", 7, ForgeMergeMethod::Merge, None)
                .await
                .is_err()
        );
    }

    /// The merge landed and the row could not be read back. That is NOT a
    /// failure: the change is on the base branch, and reporting an error would
    /// invite somebody to run an irreversible operation a second time.
    #[tokio::test]
    async fn a_merge_whose_re_read_fails_is_still_a_merge() {
        let (api_base, writes) = mock_write_api().await;
        let auth = auth_for(api_base);
        // `acme/halfblind` serves the merge and then 500s the re-read.
        let row = merge_change(&auth, "acme/halfblind", 7, ForgeMergeMethod::Merge, None)
            .await
            .expect("the merge itself succeeded");
        assert!(row.is_none(), "no row, but no error either");

        let sent = writes.lock().unwrap().clone();
        assert_eq!(sent.len(), 1, "the merge was still sent exactly once");
    }

    /// A refusal keeps GitHub's own sentence. "Merge commits are not allowed on
    /// this repository" is a fact only the forge knows, and a generic "merge
    /// failed" would send someone looking for a conflict instead of a setting.
    #[tokio::test]
    async fn a_refused_merge_carries_the_forges_reason() {
        let (api_base, _writes) = mock_write_api().await;
        let auth = auth_for(api_base);
        let error = merge_change(&auth, "acme/blocked", 7, ForgeMergeMethod::Merge, None)
            .await
            .expect_err("405");
        match error {
            ForgeError::Api { status, message } => {
                assert_eq!(status, 405);
                assert!(
                    message.contains("Merge commits are not allowed"),
                    "the forge's own words survive: {message}"
                );
            }
            other => panic!("expected an API refusal, got {other:?}"),
        }
    }

    /// A new issue is created from the forge's ANSWER, not from the draft: the
    /// number, the URL and the labels that actually stuck only exist once it
    /// has been written.
    #[tokio::test]
    async fn a_new_issue_is_posted_and_comes_back_as_a_row() {
        let (api_base, writes) = mock_write_api().await;
        let auth = auth_for(api_base);
        let row = create_issue(
            &auth,
            "Acme/App",
            &ResolvedNewIssue {
                title: "Login times out".into(),
                body: Some("steps".into()),
                labels: vec!["bug".into()],
            },
        )
        .await
        .expect("issue");
        assert_eq!((row.number, row.is_pr, row.state.as_str()), (123, false, "open"));
        assert_eq!(row.title, "Login times out");
        let sent = writes.lock().unwrap().clone();
        assert_eq!(sent[0].2["title"], "Login times out");
        assert_eq!(sent[0].2["body"], "steps");
        // A JSON ARRAY on GitHub — GitLab wants a comma-joined string, and
        // sending one to the other applies no labels at all.
        assert_eq!(sent[0].2["labels"], serde_json::json!(["bug"]));

        // Omitted rather than sent empty: GitHub stores `""` as a body and the
        // issue then renders an empty description block.
        let (api_base, writes) = mock_write_api().await;
        let auth = auth_for(api_base);
        create_issue(
            &auth,
            "acme/app",
            &ResolvedNewIssue { title: "t".into(), body: None, labels: vec![] },
        )
        .await
        .expect("issue");
        let sent = writes.lock().unwrap().clone();
        assert!(sent[0].2.get("body").is_none());
        assert!(sent[0].2.get("labels").is_none());
    }

    /// Branches, size and CI in one call — and the two check collections
    /// merged, because a repository genuinely uses one or the other and reading
    /// only `check-runs` shows "no checks" over a red external build.
    #[tokio::test]
    async fn a_pull_detail_carries_its_branches_and_both_check_collections() {
        let (api_base, _) = mock_write_api().await;
        let auth = auth_for(format!("{api_base}/detail"));
        let detail = change_detail(&auth, "Acme/App", 7).await.expect("detail");

        assert_eq!((detail.base_ref.as_str(), detail.head_ref.as_str()), ("main", "fix/timeout"));
        // The fork is named; a same-repository head would be `None` and draw
        // no second coordinate at all.
        assert_eq!(detail.head_repo.as_deref(), Some("contributor/App"));
        assert_eq!(detail.head_sha.as_deref(), Some("abc123"));
        assert!(detail.draft);
        assert_eq!(
            (detail.additions, detail.deletions, detail.changed_files, detail.commits),
            (Some(120), Some(8), Some(3), Some(2))
        );
        // Null, not false: GitHub computes this asynchronously, and "cannot be
        // merged" would send someone hunting a conflict that may not exist.
        assert_eq!(detail.mergeable, None);

        assert!(detail.checks.available);
        let by_name = |name: &str| {
            detail
                .checks
                .checks
                .iter()
                .find(|c| c.name == name)
                .unwrap_or_else(|| panic!("check {name}"))
                .state
        };
        assert_eq!(by_name("build"), ForgeCheckState::Success);
        assert_eq!(by_name("e2e"), ForgeCheckState::Queued);
        assert_eq!(by_name("deploy"), ForgeCheckState::Neutral, "skipped is not a pass");
        assert_eq!(by_name("lint"), ForgeCheckState::Failure);
        assert_eq!(by_name("codecov"), ForgeCheckState::Failure, "`error` is a failure");
        // One `build`, not two: the Action and the commit status report the
        // same name and would otherwise appear as checks that can disagree.
        assert_eq!(detail.checks.checks.iter().filter(|c| c.name == "build").count(), 1);
        // A URL the instance made up does not reach an `href`.
        assert_eq!(
            detail.checks.checks.iter().find(|c| c.name == "e2e").unwrap().url,
            None
        );
    }

    /// A token that cannot read checks still reads the pull request. The
    /// section says it could not look — which is not the same claim as "there
    /// are no checks", and is why the panel can tell them apart.
    #[tokio::test]
    async fn checks_it_cannot_read_are_unavailable_rather_than_empty() {
        let (api_base, _) = mock_write_api().await;
        let auth = auth_for(format!("{api_base}/blind"));
        let detail = change_detail(&auth, "acme/app", 7).await.expect("detail");
        assert!(!detail.checks.available);
        assert!(detail.checks.checks.is_empty());
        // Nothing to qualify: there is no partial answer, only no answer.
        assert!(!detail.checks.partial);
        // The rest of the panel is unharmed.
        assert_eq!(detail.base_ref, "main");
    }

    /// Half an answer is its own outcome. GitHub gates check runs and commit
    /// statuses behind two DIFFERENT fine-grained permissions, so a token with
    /// only one of them gets a 403 from one endpoint and an honest empty list
    /// from the other — and "no checks ran" over a red Actions run is exactly
    /// the claim `available` exists to prevent.
    #[tokio::test]
    async fn one_readable_check_collection_is_a_partial_answer() {
        let (api_base, _) = mock_write_api().await;
        let auth = auth_for(format!("{api_base}/half"));
        let detail = change_detail(&auth, "acme/app", 7).await.expect("detail");
        assert!(detail.checks.available, "one collection did answer");
        assert!(
            detail.checks.partial,
            "the other was refused — this list may be missing checks"
        );
        assert!(detail.checks.checks.is_empty());
    }

    /// Both collections readable: a complete answer, whether or not it is empty.
    #[tokio::test]
    async fn two_readable_check_collections_are_a_complete_answer() {
        let (api_base, _) = mock_write_api().await;
        let auth = auth_for(format!("{api_base}/detail"));
        let detail = change_detail(&auth, "acme/app", 7).await.expect("detail");
        assert!(detail.checks.available && !detail.checks.partial);
    }

    /// The file list is what "what does this touch" is read off, so a rename
    /// keeps both paths and a binary reports no line counts rather than zeroes
    /// that read as "changed nothing".
    #[tokio::test]
    async fn changed_files_carry_their_status_and_flag_binaries() {
        let (api_base, _) = mock_write_api().await;
        let auth = auth_for(format!("{api_base}/detail"));
        let page = list_change_files(&auth, "Acme/App", 7, 1, 50)
            .await
            .expect("files");
        assert_eq!(page.files.len(), 5);
        assert_eq!(page.files[0].status, ForgeFileStatus::Modified);
        assert_eq!((page.files[0].additions, page.files[0].deletions), (Some(10), Some(2)));
        // The diff rides along with the page and is kept, which is what a file
        // row opens onto.
        assert_eq!(page.files[0].patch.as_deref(), Some("@@ -1 +1 @@"));
        assert_eq!(page.files[1].status, ForgeFileStatus::Renamed);
        assert_eq!(page.files[1].previous_path.as_deref(), Some("src/old.rs"));
        // A rename with no content change still counted zero on both sides —
        // it has a patch, so it is not binary.
        assert!(!page.files[1].binary);
        assert!(page.files[2].binary);
        assert_eq!((page.files[2].additions, page.files[2].deletions), (None, None));
        assert!(page.files[2].patch.is_none(), "binary: nothing to open onto");
        assert_eq!(page.files[3].status, ForgeFileStatus::Removed);
        // Counted on both sides, so NOT binary — and still no diff, because
        // GitHub withheld it. The two must stay tellable apart: one is a file
        // with no text, the other a file whose text was too big to send.
        assert!(!page.files[4].binary);
        assert_eq!(
            (page.files[4].additions, page.files[4].deletions),
            (Some(4000), Some(3000))
        );
        assert!(page.files[4].patch.is_none(), "withheld, not empty");
        // The mock sends no `Link`, so there is no next page to offer.
        assert!(!page.has_next);

        assert!(list_change_files(&auth, "not-a-repo", 7, 1, 50).await.is_err());
        assert!(list_change_files(&auth, "acme/app", 0, 1, 50).await.is_err());
    }

    /// The four vocabularies folded into one. `conclusion` is meaningless
    /// until the run completes, and a `null` there on a queued run must not
    /// read as "no verdict".
    #[test]
    fn check_vocabularies_fold_into_five_states() {
        assert_eq!(check_run_state("queued", None), ForgeCheckState::Queued);
        assert_eq!(check_run_state("waiting", None), ForgeCheckState::Queued);
        assert_eq!(check_run_state("in_progress", None), ForgeCheckState::Running);
        assert_eq!(
            check_run_state("completed", Some("success")),
            ForgeCheckState::Success
        );
        for failing in ["failure", "timed_out", "startup_failure", "action_required"] {
            assert_eq!(
                check_run_state("completed", Some(failing)),
                ForgeCheckState::Failure,
                "{failing}"
            );
        }
        for neutral in ["neutral", "skipped", "cancelled", "stale"] {
            assert_eq!(
                check_run_state("completed", Some(neutral)),
                ForgeCheckState::Neutral,
                "{neutral}"
            );
        }
        assert_eq!(commit_status_state("success"), ForgeCheckState::Success);
        assert_eq!(commit_status_state("error"), ForgeCheckState::Failure);
        assert_eq!(commit_status_state("failure"), ForgeCheckState::Failure);
        assert_eq!(commit_status_state("pending"), ForgeCheckState::Running);

        // GitHub's seven file statuses over the four a reader distinguishes.
        assert_eq!(file_status("added"), ForgeFileStatus::Added);
        assert_eq!(file_status("copied"), ForgeFileStatus::Added);
        assert_eq!(file_status("removed"), ForgeFileStatus::Removed);
        assert_eq!(file_status("renamed"), ForgeFileStatus::Renamed);
        assert_eq!(file_status("changed"), ForgeFileStatus::Modified);
        assert_eq!(file_status("unchanged"), ForgeFileStatus::Modified);
    }
}

/// `list_open_items` — the auto-processing scan's read — kept apart from the
/// workbench list's tests above, because it reads a different endpoint for a
/// different reason (see its doc).
#[cfg(test)]
mod open_items_tests {
    use super::*;
    use axum::extract::Query;
    use axum::http::HeaderMap;
    use axum::routing::get;
    use axum::Json;
    use std::collections::HashMap;
    use std::sync::{Arc, Mutex};

    fn auth_for(api_base: String) -> ResolvedAuth {
        ResolvedAuth {
            provider: ForgeProvider::GitHub,
            server_host: "github.test".into(),
            api_base,
            account_id: "acc-test".into(),
            username: "alice".into(),
            avatar_url: None,
            token: "tok-test".into(),
            scopes: vec![],
        }
    }

    fn item(number: i64, pr: bool) -> serde_json::Value {
        let mut v = serde_json::json!({
            "number": number,
            "title": format!("item {number}"),
            "state": "open",
            "updated_at": "2026-10-14T09:00:00Z",
            "html_url": format!("https://github.test/acme/app/issues/{number}"),
            "user": { "login": "alice" },
            "labels": [{ "name": "bug", "color": "d73a4a" }],
        });
        if pr {
            v["pull_request"] = serde_json::json!({ "merged_at": null });
            v["draft"] = serde_json::json!(true);
        }
        v
    }

    /// Two pages of the mixed feed — a `Link: rel="next"` on the first — or,
    /// with `endless`, a `next` on every page.
    async fn serve(endless: bool) -> (String, Arc<Mutex<Vec<HashMap<String, String>>>>) {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let log = seen.clone();
        let app = axum::Router::new().route(
            "/repos/acme/app/issues",
            get(move |Query(q): Query<HashMap<String, String>>| {
                let log = log.clone();
                async move {
                    let page: u32 = q.get("page").and_then(|p| p.parse().ok()).unwrap_or(1);
                    log.lock().unwrap().push(q);
                    let mut headers = HeaderMap::new();
                    if endless || page == 1 {
                        headers.insert(
                            "link",
                            format!("<https://api.test/x?page={}>; rel=\"next\"", page + 1)
                                .parse()
                                .unwrap(),
                        );
                    }
                    let rows = if page == 1 {
                        vec![item(1, false), item(2, true)]
                    } else {
                        vec![item(3, false)]
                    };
                    (headers, Json(serde_json::Value::Array(rows)))
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        (format!("http://{addr}"), seen)
    }

    /// The plain feed, open only, freshest first, cut at `since` server-side,
    /// every page read — and the kinds split off the `pull_request` key.
    #[tokio::test]
    async fn the_scan_reads_every_page_of_the_open_feed_since_the_window() {
        let (base, seen) = serve(false).await;
        let auth = auth_for(base);
        let since = chrono::DateTime::parse_from_rfc3339("2026-10-14T08:00:00.750Z")
            .unwrap()
            .with_timezone(&chrono::Utc);

        let fresh = ScanCursor::default();
        let scan = list_open_items(&auth, "Acme/App", true, false, Some(since), &fresh)
            .await
            .expect("listed");
        assert_eq!(scan.resume, None, "a listing read to its end leaves nothing to carry on");
        let numbers: Vec<i64> = scan.rows.iter().map(|r| r.number).collect();
        assert_eq!(numbers, vec![1, 3], "issues only");
        assert!(scan.rows.iter().all(|r| !r.is_pr));

        let queries = seen.lock().unwrap().clone();
        assert_eq!(queries.len(), 2, "both pages");
        let first = &queries[0];
        assert_eq!(first.get("state").map(String::as_str), Some("open"));
        assert_eq!(first.get("sort").map(String::as_str), Some("updated"));
        // Newest-updated first: an item updated mid-read moves to the front
        // and shifts the rest DOWN — read twice, never skipped.
        assert_eq!(first.get("direction").map(String::as_str), Some("desc"));
        assert_eq!(first.get("per_page").map(String::as_str), Some("100"));
        assert_eq!(
            first.get("since").map(String::as_str),
            Some("2026-10-14T08:00:00Z"),
            "whole seconds, rounded down"
        );
        assert_eq!(queries[1].get("page").map(String::as_str), Some("2"));

        let prs = list_open_items(&auth, "acme/app", false, true, None, &ScanCursor::default())
            .await
            .expect("listed");
        assert_eq!(prs.rows.len(), 1);
        assert!(prs.rows[0].is_pr && prs.rows[0].draft);
        // No window, no parameter.
        assert!(!seen.lock().unwrap().last().unwrap().contains_key("since"));
    }

    /// A server that never stops offering a next page is read up to the
    /// budget and handed on with a cursor — never looped on forever, never
    /// passed off as the whole listing — and the next call carries on from the
    /// page after the last one read.
    #[tokio::test]
    async fn an_endless_feed_stops_at_the_budget_and_carries_on_from_there() {
        let (base, seen) = serve(true).await;
        let auth = auth_for(base);
        let fresh = ScanCursor::default();
        let scan = list_open_items(&auth, "acme/app", true, true, None, &fresh)
            .await
            .expect("listed");
        assert_eq!(seen.lock().unwrap().len(), SCAN_MAX_PAGES as usize);
        let cursor = scan.resume.expect("cut short");
        assert_eq!(cursor.first_page("feed"), Some(SCAN_MAX_PAGES + 1));

        seen.lock().unwrap().clear();
        let more = list_open_items(&auth, "acme/app", true, true, None, &cursor)
            .await
            .expect("listed");
        // Carrying on re-reads the overlap first, then moves on.
        let first_asked = seen.lock().unwrap()[0].get("page").cloned();
        let restart = SCAN_MAX_PAGES + 1 - crate::forge::SCAN_CONTINUATION_OVERLAP_PAGES;
        assert_eq!(first_asked, Some(restart.to_string()));
        assert_eq!(
            more.resume.and_then(|c| c.first_page("feed")),
            Some(restart + SCAN_MAX_PAGES)
        );
    }

    #[tokio::test]
    async fn asking_for_no_kind_asks_nothing() {
        let (base, seen) = serve(false).await;
        let fresh = ScanCursor::default();
        let scan = list_open_items(&auth_for(base), "acme/app", false, false, None, &fresh)
            .await
            .expect("listed");
        assert!(scan.resume.is_none() && scan.rows.is_empty());
        assert!(seen.lock().unwrap().is_empty());
    }
}
