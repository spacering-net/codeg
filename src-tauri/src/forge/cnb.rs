//! CNB (cnb.cool) OpenAPI client for the workbench and the delivery path.
//!
//! CNB is Tencent's code hosting platform. Its API is NOT a GitHub or Gitea
//! dialect, and the differences are the kind that produce a silently wrong
//! answer rather than a 404:
//!
//! 1. **The REST base is a different host.** `https://cnb.cool` is the web UI;
//!    `https://api.cnb.cool` is the API. Deriving the API from the instance
//!    origin the way GitHub Enterprise / GitLab / Gitea do sends every request
//!    to an HTML page that answers `200`.
//! 2. **Authentication is `Authorization: Bearer <token>`.** No `token` or
//!    `PRIVATE-TOKEN` spelling works.
//! 3. **Every id is a STRING on the wire**, including an issue's `number`, and
//!    every date is RFC 3339 with a `Z`.
//! 4. **Issues and merge requests are separate collections** (`/-/issues` and
//!    `/-/pulls`), like GitLab, and the list payload for an ISSUE carries no
//!    body — only the detail endpoint does. Rows therefore arrive with
//!    `body: None`.
//! 5. **A state change needs two fields together.** `PATCH /issues/{n}` takes
//!    `state` AND `state_reason`; sending only `state` is a parameter error.
//! 6. **Pagination is `page` + `page_size`** and neither collection reports a
//!    total, so [`ForgeIssueList::total_count`] stays `None` and the UI falls
//!    back to previous/next.
//! 7. **A merged merge request is `state: "closed"` with `is_merged: true`** —
//!    the flag, not the state, is what tells "landed" from "abandoned".
//! 8. **`403` means a missing token SCOPE**, and `errmsg` names it. Each
//!    endpoint documents its own (`repo-issue:r`, `repo-pr:rw`,
//!    `repo-notes:r`, `account-profile:r` for `/user`).
//!
//! Errors use CNB's own envelope (`{"errcode":…,"errmsg":…}`), which is worth
//! surfacing: the message is the only thing that says which permission a
//! token is missing.

use std::collections::HashMap;
use std::sync::{LazyLock, RwLock};

use serde::Deserialize;

use super::auth::ResolvedAuth;
use super::deliver::{ForgePr, NewPullRequest};
use super::{
    normalize_repo, sanitize_web_url, truncate_chars, urlencode_query, validate_state_filter,
    web_origin, ForgeChangeDetail, ForgeChangedFile, ForgeChangedFileList, ForgeCheckList,
    ForgeComment, ForgeCommentList, ForgeError, ForgeFileStatus, ForgeIssueList, ForgeIssueRow,
    ForgeItemKind, ForgeLabel, ForgeLabelList, ForgeMergeMethod, ForgeMergeOptions, ForgeSort,
    ForgeStateAction, ForgeTab, ListIssuesRequest, OpenItemsScan, ResolvedNewIssue, ScanCursor,
    BODY_CAP, LABEL_PAGE_SIZE, SCAN_MAX_PAGES,
};

// ── reads ───────────────────────────────────────────────────────────────────

/// One page of the workbench list.
///
/// Both tabs are served by their own collection, so real page numbers are
/// possible without a client-side split. Ordering is CNB's `order_by`, whose
/// vocabulary has no ASCENDING updated order — so the panel offers three of the
/// four orders for CNB (see `sortOptionsFor` in `forge-page.tsx`).
pub async fn list_issues(
    auth: &ResolvedAuth,
    req: &ListIssuesRequest,
) -> Result<ForgeIssueList, ForgeError> {
    let repo = repo_ref(&req.owner_repo)?;
    validate_state_filter(&req.state)?;
    let (page, per_page) = req.clamped();

    let collection = collection_of(req.tab);
    let mut url = format!(
        "{}/{repo}/-/{collection}?page={page}&page_size={per_page}&order_by={}",
        auth.api_base,
        order_by(req.sort)
    );
    if let Some(state) = state_filter(req.tab, &req.state) {
        url.push_str("&state=");
        url.push_str(state);
    }
    if req.assigned_me {
        let login = current_login(auth).await?;
        url.push_str(&format!("&assignees={}", urlencode_query(&login)));
    }
    if !req.labels.is_empty() {
        // ANDed, matching every other filter in this app. CNB's default is
        // `contains_any`, so the operator has to be explicit.
        url.push_str(&format!(
            "&labels={}&labels_operator=contains_all",
            urlencode_query(&req.labels.join(","))
        ));
    }
    if let Some(text) = req.search.as_deref() {
        // Issues take a keyword filter; pulls have no equivalent (the
        // parameter is ignored there, verified against the live API), so the
        // panel hides the box on that tab rather than show one that does
        // nothing — see `supportsSearch` in `forge-page.tsx`.
        if req.tab == ForgeTab::Issues {
            url.push_str(&format!("&keyword={}", urlencode_query(text)));
        }
    }

    let raw: Vec<RawItem> = api_get(auth, &url)
        .await?
        .json()
        .await
        .map_err(|e| ForgeError::Network(format!("bad list payload: {e}")))?;

    let is_pr = req.tab == ForgeTab::Prs;
    // No total on this API. `has_next` from a full page is the honest signal
    // available; an exact multiple costs one empty page, which the UI already
    // renders as "no rows here".
    let has_next = raw.len() as u32 >= per_page;
    Ok(ForgeIssueList {
        rows: raw
            .into_iter()
            .map(|item| item.into_row(auth, &repo, is_pr))
            .collect(),
        page,
        per_page,
        total_count: None,
        reachable_count: None,
        has_next,
        incomplete: false,
    })
}

/// One issue, read in full.
///
/// CNB's issue LIST omits `body` outright (its pull list carries one), so a
/// panel holding a row from the list has no description to draw. This is the
/// one request that fills it, paid only when the panel opens — the same trade
/// the comment thread makes. A pull never takes this path: its body rides on
/// the row.
pub async fn issue_detail(
    auth: &ResolvedAuth,
    owner_repo: &str,
    number: i64,
) -> Result<ForgeIssueRow, ForgeError> {
    let repo = repo_ref(owner_repo)?;
    let url = format!("{}/{repo}/-/issues/{number}", auth.api_base);
    let raw: RawItem = api_get(auth, &url)
        .await?
        .json()
        .await
        .map_err(|e| ForgeError::Network(format!("bad issue payload: {e}")))?;
    Ok(raw.into_row(auth, &repo, false))
}

/// Rows per scan page. CNB clamps `page_size` to 100.
const SCAN_PAGE_LIMIT: u32 = 100;

/// Every OPEN item of the wanted kinds updated at or after `since` — what an
/// auto-processing scan reads — starting from where `from` says.
///
/// CNB's `updated_time_begin` is a DATE (`2022-01-31`), not a timestamp, so
/// the window is widened to the containing day. Re-reading up to 24 hours of
/// items is safe: the trigger path deduplicates on the source key, while
/// narrowing the window would silently miss items.
pub async fn list_open_items(
    auth: &ResolvedAuth,
    owner_repo: &str,
    issues: bool,
    pulls: bool,
    since: Option<chrono::DateTime<chrono::Utc>>,
    from: &ScanCursor,
) -> Result<OpenItemsScan, ForgeError> {
    let repo = repo_ref(owner_repo)?;
    let mut rows = Vec::new();
    let mut cursor = ScanCursor::default();
    let since_day = since.map(|s| s.date_naive().to_string());

    for (wanted, collection, is_pr) in [(issues, "issues", false), (pulls, "pulls", true)] {
        if !wanted {
            continue;
        }
        let repo = &repo;
        let since_day = since_day.clone();
        super::scan_collection(
            collection,
            from,
            &mut cursor,
            &mut rows,
            SCAN_MAX_PAGES,
            |page| {
                let mut url = format!(
                    "{}/{repo}/-/{collection}?state=open&page={page}&page_size={SCAN_PAGE_LIMIT}",
                    auth.api_base
                );
                if let Some(day) = since_day.as_deref() {
                    url.push_str(&format!("&updated_time_begin={}", urlencode_query(day)));
                }
                async move {
                    let raw: Vec<RawItem> = api_get(auth, &url)
                        .await?
                        .json()
                        .await
                        .map_err(|e| ForgeError::Network(format!("bad list payload: {e}")))?;
                    let has_next = raw.len() as u32 >= SCAN_PAGE_LIMIT;
                    Ok((
                        raw.into_iter()
                            .map(|item| item.into_row(auth, repo, is_pr))
                            .collect(),
                        has_next,
                    ))
                }
            },
        )
        .await?;
    }
    Ok(OpenItemsScan {
        rows,
        resume: cursor.has_more().then_some(cursor),
    })
}

/// The repository's labels, for the workbench's label filter.
pub async fn list_labels(
    auth: &ResolvedAuth,
    owner_repo: &str,
) -> Result<ForgeLabelList, ForgeError> {
    let repo = repo_ref(owner_repo)?;
    let url = format!(
        "{}/{repo}/-/labels?page=1&page_size={LABEL_PAGE_SIZE}",
        auth.api_base
    );
    let raw: Vec<RawLabel> = api_get(auth, &url)
        .await?
        .json()
        .await
        .map_err(|e| ForgeError::Network(format!("bad labels payload: {e}")))?;
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
/// Issues and merge requests have their own comment collections, so unlike
/// GitHub/Gitea this one needs the item's kind. `has_next` comes from a full
/// page: CNB reports no total, and this is the only signal the API gives.
pub async fn list_comments(
    auth: &ResolvedAuth,
    owner_repo: &str,
    kind: ForgeItemKind,
    number: i64,
    page: u32,
    per_page: u32,
) -> Result<ForgeCommentList, ForgeError> {
    let repo = repo_ref(owner_repo)?;
    require_number(number)?;
    let collection = collection_of_kind(kind);
    let url = format!(
        "{}/{repo}/-/{collection}/{number}/comments?page={page}&page_size={per_page}",
        auth.api_base
    );
    let raw: Vec<RawComment> = api_get(auth, &url)
        .await?
        .json()
        .await
        .map_err(|e| ForgeError::Network(format!("bad comments payload: {e}")))?;
    let has_next = raw.len() as u32 >= per_page;
    Ok(ForgeCommentList {
        comments: raw.into_iter().map(RawComment::into_comment).collect(),
        page,
        per_page,
        has_next,
    })
}

// ── writes ──────────────────────────────────────────────────────────────────

/// Post one comment on an issue or merge request.
pub async fn create_comment(
    auth: &ResolvedAuth,
    owner_repo: &str,
    kind: ForgeItemKind,
    number: i64,
    body: &str,
) -> Result<ForgeComment, ForgeError> {
    let repo = repo_ref(owner_repo)?;
    require_number(number)?;
    let collection = collection_of_kind(kind);
    let url = format!("{}/{repo}/-/{collection}/{number}/comments", auth.api_base);
    let raw: RawComment = api_post(auth, &url, &serde_json::json!({ "body": body }))
        .await?
        .json()
        .await
        .map_err(|e| ForgeError::Network(format!("bad comment payload: {e}")))?;
    Ok(raw.into_comment())
}

/// Close or reopen one item.
///
/// Issues take `state` + `state_reason` together (the API rejects one without
/// the other); pulls take `state` alone.
pub async fn set_item_state(
    auth: &ResolvedAuth,
    owner_repo: &str,
    kind: ForgeItemKind,
    number: i64,
    action: ForgeStateAction,
) -> Result<ForgeIssueRow, ForgeError> {
    let repo = repo_ref(owner_repo)?;
    require_number(number)?;
    let collection = collection_of_kind(kind);
    let url = format!("{}/{repo}/-/{collection}/{number}", auth.api_base);
    let payload = match kind {
        ForgeItemKind::Issue => serde_json::json!({
            "state": action.github_state(),
            "state_reason": match action {
                ForgeStateAction::Close => "completed",
                ForgeStateAction::Reopen => "reopened",
            },
        }),
        ForgeItemKind::Change => serde_json::json!({ "state": action.github_state() }),
    };
    let raw: RawItem = api_patch(auth, &url, &payload)
        .await?
        .json()
        .await
        .map_err(|e| ForgeError::Network(format!("bad item payload: {e}")))?;
    Ok(raw.into_row(auth, &repo, kind == ForgeItemKind::Change))
}

/// `POST /{repo}/-/issues` — open an issue.
///
/// CNB takes label NAMES on creation (unlike Gitea's ids), so the chips the
/// dialog sends are passed straight through.
pub async fn create_issue(
    auth: &ResolvedAuth,
    owner_repo: &str,
    draft: &ResolvedNewIssue,
) -> Result<ForgeIssueRow, ForgeError> {
    let repo = repo_ref(owner_repo)?;
    let url = format!("{}/{repo}/-/issues", auth.api_base);
    let mut payload = serde_json::json!({ "title": draft.title });
    if let Some(body) = draft.body.as_deref() {
        payload["body"] = serde_json::Value::String(body.to_string());
    }
    if !draft.labels.is_empty() {
        payload["labels"] = serde_json::Value::from(draft.labels.clone());
    }
    let raw: RawItem = api_post(auth, &url, &payload)
        .await?
        .json()
        .await
        .map_err(|e| ForgeError::Network(format!("bad issue payload: {e}")))?;
    Ok(raw.into_row(auth, &repo, false))
}

// ── proposed changes ────────────────────────────────────────────────────────

/// One merge request's branches, state and mergeability.
///
/// CNB's `Pull` carries no diff counters and no commit count, so those stay
/// `None` rather than zero — see [`ForgeChangeDetail`]. Its `mergeable_state`
/// is a WORD (`checking`, `mergeable`, `merging`, `merged`, `conflict`,
/// `no-merge-base`), and `checking` is a real third answer: the platform is
/// still computing it, so "we do not know yet" is what the panel should say.
pub async fn change_detail(
    auth: &ResolvedAuth,
    owner_repo: &str,
    number: i64,
) -> Result<ForgeChangeDetail, ForgeError> {
    let repo = repo_ref(owner_repo)?;
    require_number(number)?;
    let url = format!("{}/{repo}/-/pulls/{number}", auth.api_base);
    let raw: RawPull = api_get(auth, &url)
        .await?
        .json()
        .await
        .map_err(|e| ForgeError::Network(format!("bad pull payload: {e}")))?;

    let head_sha = raw
        .head
        .as_ref()
        .and_then(|h| h.sha.clone())
        .filter(|sha| !sha.is_empty());
    // Shown only when the head is somebody ELSE's repository — a fork is the
    // fact worth a line.
    let head_repo = raw
        .head
        .as_ref()
        .and_then(|h| h.repo.as_ref())
        .and_then(|r| r.path.clone().or_else(|| r.name.clone()))
        .filter(|path| !super::same_repo(path, &repo));

    Ok(ForgeChangeDetail {
        number: raw.number(),
        base_ref: raw.base.as_ref().map(|b| b.branch()).unwrap_or_default(),
        head_ref: raw.head.as_ref().map(|h| h.branch()).unwrap_or_default(),
        head_repo,
        head_sha,
        draft: raw.is_wip,
        state: pull_state(&raw.state, raw.is_merged),
        mergeable: mergeable(&raw.mergeable_state),
        merge_state: raw.mergeable_state.clone(),
        additions: None,
        deletions: None,
        changed_files: None,
        commits: None,
        // CNB groups checks under a `statuses` map whose shape is not the
        // commit-status list the other clients fold into `ForgeCheck`; saying
        // "unavailable" is honest, and the panel draws no strip.
        checks: ForgeCheckList::unavailable(),
    })
}

/// One page of a merge request's files, cut locally: CNB's file endpoint takes
/// no page parameters and answers with the whole list.
pub async fn list_change_files(
    auth: &ResolvedAuth,
    owner_repo: &str,
    number: i64,
    page: u32,
    per_page: u32,
) -> Result<ForgeChangedFileList, ForgeError> {
    let repo = repo_ref(owner_repo)?;
    require_number(number)?;
    let url = format!("{}/{repo}/-/pulls/{number}/files", auth.api_base);
    let raw: Vec<RawFile> = api_get(auth, &url)
        .await?
        .json()
        .await
        .map_err(|e| ForgeError::Network(format!("bad files payload: {e}")))?;

    let skip = (page as usize)
        .saturating_sub(1)
        .saturating_mul(per_page as usize);
    let total = raw.len();
    Ok(ForgeChangedFileList {
        files: raw
            .into_iter()
            .skip(skip)
            .take(per_page as usize)
            .map(RawFile::into_file)
            .collect(),
        page,
        per_page,
        has_next: total > skip.saturating_add(per_page as usize),
    })
}

/// CNB publishes no repository-settings endpoint for merge styles, so the menu
/// is the conservative one: a merge commit. The platform still has the last
/// word and refuses what the repository forbids.
pub async fn merge_options(
    _auth: &ResolvedAuth,
    _owner_repo: &str,
) -> Result<ForgeMergeOptions, ForgeError> {
    Ok(ForgeMergeOptions::unknown())
}

/// Land one merge request, and hand back the row as CNB now sees it.
///
/// The head commit is checked first when the caller named one: CNB's merge
/// endpoint takes no head SHA, so an unguarded merge could land a commit the
/// reviewer never saw. Past the merge nothing may return `Err` — the change
/// HAS landed, and `Ok(None)` is the honest answer when the read-back fails.
pub async fn merge_change(
    auth: &ResolvedAuth,
    owner_repo: &str,
    number: i64,
    method: ForgeMergeMethod,
    head_sha: Option<&str>,
) -> Result<Option<ForgeIssueRow>, ForgeError> {
    let repo = repo_ref(owner_repo)?;
    require_number(number)?;

    if let Some(expected) = head_sha {
        let url = format!("{}/{repo}/-/pulls/{number}", auth.api_base);
        let current: RawPull = api_get(auth, &url)
            .await?
            .json()
            .await
            .map_err(|e| ForgeError::Network(format!("bad pull payload: {e}")))?;
        let actual = current
            .head
            .as_ref()
            .and_then(|h| h.sha.as_deref())
            .unwrap_or_default();
        if !actual.eq_ignore_ascii_case(expected) {
            return Err(ForgeError::Api {
                status: 409,
                message: format!(
                    "the merge request moved: expected head {expected}, found {actual}"
                ),
            });
        }
    }

    let url = format!("{}/{repo}/-/pulls/{number}/merge", auth.api_base);
    let payload = serde_json::json!({ "merge_style": merge_style(method) });
    api_put(auth, &url, &payload).await?;

    // Past this line the change HAS landed, so nothing below may return `Err`.
    // The merge endpoint answers with `{merged, message, sha}` — not a row —
    // and re-reading the pull would still not produce one (CNB's pull payload
    // has no labels/author in the shape a row needs). `Ok(None)` is the honest
    // answer: the merge succeeded, the list will catch up.
    Ok(None)
}

/// CNB's `merge_style` values. `fast_forward` has no counterpart in
/// [`ForgeMergeMethod`], which is fine: the panel never offers it here.
fn merge_style(method: ForgeMergeMethod) -> &'static str {
    match method {
        ForgeMergeMethod::Merge => "merge",
        ForgeMergeMethod::Squash => "squash",
        ForgeMergeMethod::Rebase => "rebase",
    }
}

// ── delivery ────────────────────────────────────────────────────────────────

/// How far back [`find_pulls`] looks for a merge request headed by one branch.
/// Bounded for the same reason the other clients bound it: this is recovery
/// for a branch this delivery just pushed, which is at the front of the list.
const PR_SCAN_PAGES: u32 = 5;
/// Rows per scan page. CNB clamps to 100.
const PR_SCAN_PAGE_SIZE: u32 = 50;

/// Merge requests whose head is `head_branch`, in ANY state — a merged or
/// closed one is exactly what recovery must be able to see.
///
/// CNB's `/pulls` takes no head-branch filter, so the scan is local, newest
/// first. It fails SAFE: an unseen merge request reads as "no match", and the
/// create that follows is refused by CNB rather than duplicating anything.
pub async fn find_pulls(
    auth: &ResolvedAuth,
    owner_repo: &str,
    head_branch: &str,
) -> Result<Vec<ForgePr>, ForgeError> {
    let repo = repo_ref(owner_repo)?;
    let mut found = Vec::new();
    for page in 1..=PR_SCAN_PAGES {
        let url = format!(
            "{}/{repo}/-/pulls?state=all&page={page}&page_size={PR_SCAN_PAGE_SIZE}",
            auth.api_base
        );
        let raw: Vec<RawPull> = api_get(auth, &url)
            .await?
            .json()
            .await
            .map_err(|e| ForgeError::Network(format!("bad pulls payload: {e}")))?;
        let full = raw.len() as u32 >= PR_SCAN_PAGE_SIZE;
        found.extend(
            raw.into_iter()
                .filter(|pull| {
                    pull.head
                        .as_ref()
                        .is_some_and(|h| h.branch() == head_branch)
                })
                .map(|pull| pull.into_pr(&repo, &web_origin(auth))),
        );
        if !full {
            break;
        }
    }
    Ok(found)
}

/// `GET /{repo}/-/pulls/{n}` — one merge request by number.
pub async fn get_pull(
    auth: &ResolvedAuth,
    owner_repo: &str,
    number: i64,
) -> Result<ForgePr, ForgeError> {
    let repo = repo_ref(owner_repo)?;
    require_number(number)?;
    let url = format!("{}/{repo}/-/pulls/{number}", auth.api_base);
    let raw: RawPull = api_get(auth, &url)
        .await?
        .json()
        .await
        .map_err(|e| ForgeError::Network(format!("bad pull payload: {e}")))?;
    Ok(raw.into_pr(&repo, &web_origin(auth)))
}

/// `POST /{repo}/-/pulls`.
///
/// CNB has no `draft` parameter; a draft is a title carrying a work-in-progress
/// prefix. `WIP:` is the conventional spelling, and what CNB's own UI shows, so
/// a draft is opened by prefixing — the same trick Gitea and GitLab need.
pub async fn create_pull(
    auth: &ResolvedAuth,
    owner_repo: &str,
    req: &NewPullRequest<'_>,
) -> Result<ForgePr, ForgeError> {
    let repo = repo_ref(owner_repo)?;
    let url = format!("{}/{repo}/-/pulls", auth.api_base);
    let title = if req.draft && !is_wip_title(req.title) {
        format!("WIP: {}", req.title)
    } else {
        req.title.to_string()
    };
    let body = serde_json::json!({
        "head": req.head,
        "base": req.base,
        "title": title,
        "body": req.body,
    });
    let raw: RawPull = api_post(auth, &url, &body)
        .await?
        .json()
        .await
        .map_err(|e| ForgeError::Network(format!("bad pull payload: {e}")))?;
    Ok(raw.into_pr(&repo, &web_origin(auth)))
}

/// Whether a title already declares itself a draft, so it is not prefixed
/// twice. `get(..n)` rather than a byte slice: a title is arbitrary UTF-8.
fn is_wip_title(title: &str) -> bool {
    let trimmed = title.trim_start();
    ["wip:", "[wip]"].iter().any(|prefix| {
        trimmed
            .get(..prefix.len())
            .is_some_and(|got| got.eq_ignore_ascii_case(prefix))
    })
}

// ── plumbing ────────────────────────────────────────────────────────────────

/// `GET {api_base}/user` → username, cached per `(api_base, account)`.
/// Resolving it on every "assigned to me" page would spend a request per click.
static LOGIN_CACHE: LazyLock<RwLock<HashMap<String, String>>> =
    LazyLock::new(|| RwLock::new(HashMap::new()));

async fn current_login(auth: &ResolvedAuth) -> Result<String, ForgeError> {
    let key = format!("{}|{}", auth.api_base, auth.account_id);
    if let Ok(guard) = LOGIN_CACHE.read() {
        if let Some(login) = guard.get(&key) {
            return Ok(login.clone());
        }
    }
    let url = format!("{}/user", auth.api_base);
    let raw: RawUser = api_get(auth, &url)
        .await?
        .json()
        .await
        .map_err(|e| ForgeError::Network(format!("bad user payload: {e}")))?;
    let login = raw
        .username
        .clone()
        .filter(|name| !name.trim().is_empty())
        .or_else(|| raw.nickname.clone().filter(|name| !name.trim().is_empty()))
        .ok_or_else(|| ForgeError::Auth("CNB answered without a username".to_string()))?;
    if let Ok(mut guard) = LOGIN_CACHE.write() {
        guard.insert(key, login.clone());
    }
    Ok(login)
}

/// `owner/repo`, validated. CNB addresses a repository with two path segments,
/// like GitHub — the slash is part of the route, so it is NOT percent-encoded.
fn repo_ref(owner_repo: &str) -> Result<String, ForgeError> {
    normalize_repo(owner_repo)
        .ok_or_else(|| ForgeError::Invalid(format!("bad repository path: {owner_repo}")))
}

fn require_number(number: i64) -> Result<(), ForgeError> {
    if number <= 0 {
        return Err(ForgeError::Invalid(format!(
            "bad work item number: {number}"
        )));
    }
    Ok(())
}

/// The workbench's order as CNB's `order_by`.
///
/// CNB accepts `created_at`, `-created_at`, `-updated_at` (and, on issues only,
/// `-last_acted_at`) — there is NO ascending updated order, so
/// [`ForgeSort::LeastRecentlyUpdated`] has no honest spelling. The panel does
/// not offer that order for CNB; should it ever arrive anyway, the default
/// newest-first is used rather than an order the server would reject.
fn order_by(sort: ForgeSort) -> &'static str {
    match sort {
        ForgeSort::Oldest => "created_at",
        ForgeSort::RecentlyUpdated => "-updated_at",
        ForgeSort::Newest | ForgeSort::LeastRecentlyUpdated => "-created_at",
    }
}

/// How a collection spells "every state".
///
/// The two collections do NOT agree, which is a trap worth stating plainly:
/// the issue list documents only `open`/`closed` — leaving the filter out is
/// what returns everything — while the pull list takes an explicit `all` and
/// treats an omitted filter as open-only. Sending the issue spelling to pulls
/// made the panel's "全部" show nothing on a repository whose merge requests
/// had all landed.
fn state_filter(tab: ForgeTab, state: &str) -> Option<&'static str> {
    match state {
        "all" if tab == ForgeTab::Prs => Some("all"),
        "all" => None,
        "open" => Some("open"),
        "closed" => Some("closed"),
        // `validate_state_filter` rejects anything else before this point.
        _ => None,
    }
}

fn collection_of(tab: ForgeTab) -> &'static str {
    match tab {
        ForgeTab::Issues => "issues",
        ForgeTab::Prs => "pulls",
    }
}

fn collection_of_kind(kind: ForgeItemKind) -> &'static str {
    match kind {
        ForgeItemKind::Issue => "issues",
        ForgeItemKind::Change => "pulls",
    }
}

/// Normalize CNB's pull state to the workbench's three words.
///
/// The flag is checked FIRST, not last: a merged merge request arrives as
/// `state: "closed"` with `is_merged: true` (verified against the live API), so
/// a match on `state` alone reports every landed change as merely closed.
fn pull_state(state: &str, merged: bool) -> String {
    if merged {
        return "merged".to_string();
    }
    match state.trim().to_ascii_lowercase().as_str() {
        "merged" => "merged".to_string(),
        "closed" => "closed".to_string(),
        _ => "open".to_string(),
    }
}

/// CNB's `mergeable_state` as the panel's tri-state.
fn mergeable(raw: &Option<String>) -> Option<bool> {
    match raw.as_deref().map(str::trim).unwrap_or("") {
        "mergeable" | "merged" => Some(true),
        "conflict" | "no-merge-base" => Some(false),
        // `checking` and `merging` are both "not answerable yet" — the first
        // is a computation in flight, the second a merge already landing.
        _ => None,
    }
}

pub(crate) async fn api_get(
    auth: &ResolvedAuth,
    url: &str,
) -> Result<reqwest::Response, ForgeError> {
    send(super::http_client()?.get(url), auth).await
}

async fn api_post(
    auth: &ResolvedAuth,
    url: &str,
    body: &serde_json::Value,
) -> Result<reqwest::Response, ForgeError> {
    send(super::http_client()?.post(url).json(body), auth).await
}

async fn api_patch(
    auth: &ResolvedAuth,
    url: &str,
    body: &serde_json::Value,
) -> Result<reqwest::Response, ForgeError> {
    send(super::http_client()?.patch(url).json(body), auth).await
}

async fn api_put(
    auth: &ResolvedAuth,
    url: &str,
    body: &serde_json::Value,
) -> Result<reqwest::Response, ForgeError> {
    send(super::http_client()?.put(url).json(body), auth).await
}

/// The headers every CNB request shares. `Bearer`, not `token`.
async fn send(
    request: reqwest::RequestBuilder,
    auth: &ResolvedAuth,
) -> Result<reqwest::Response, ForgeError> {
    let response = request
        .header("Authorization", format!("Bearer {}", auth.token))
        .header("User-Agent", "codeg")
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|e| ForgeError::Network(e.to_string()))?;
    finish(response).await
}

/// Success through, everything else classified.
///
/// CNB's error body is `{"errcode":N,"errmsg":"…"}`; the message is the only
/// place it says which permission a token is missing, so it is carried into
/// [`ForgeError::Api`] instead of being replaced by the status.
async fn finish(response: reqwest::Response) -> Result<reqwest::Response, ForgeError> {
    if response.status().is_success() {
        return Ok(response);
    }
    let status = response.status().as_u16();
    let retry_after = response
        .headers()
        .get("retry-after")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<u64>().ok());
    match status {
        429 => Err(ForgeError::RateLimited { retry_after }),
        // 403 is usually a SCOPE problem, not a bad token: CNB's `errmsg` says
        // exactly which permission is missing, and that is the one sentence
        // that lets the user fix it, so it travels with the error.
        401 | 403 => {
            let text = response.text().await.unwrap_or_default();
            let detail = serde_json::from_str::<RawError>(&text)
                .ok()
                .and_then(|e| e.errmsg)
                .filter(|msg| !msg.trim().is_empty());
            Err(ForgeError::Auth(match detail {
                Some(msg) => format!("CNB returned {status}: {msg}"),
                None => format!("CNB returned {status}"),
            }))
        }
        404 => Err(ForgeError::NotFound),
        _ => {
            let text = response.text().await.unwrap_or_default();
            let message = serde_json::from_str::<RawError>(&text)
                .ok()
                .and_then(|e| e.errmsg)
                .filter(|msg| !msg.trim().is_empty())
                .unwrap_or_else(|| truncate_chars(&text, 300));
            Err(ForgeError::Api { status, message })
        }
    }
}

// ── wire shapes ─────────────────────────────────────────────────────────────

/// One issue or merge request in the list. Both shapes deserialize into this:
/// the fields they share are the row, and `body`/`is_wip` are simply absent on
/// an issue (CNB's issue list omits the body entirely).
#[derive(Debug, Deserialize)]
struct RawItem {
    /// A STRING on the wire for both collections.
    #[serde(default)]
    number: String,
    #[serde(default)]
    title: String,
    #[serde(default)]
    body: Option<String>,
    #[serde(default)]
    state: String,
    #[serde(default)]
    is_wip: bool,
    #[serde(default)]
    is_merged: bool,
    #[serde(default)]
    labels: Vec<RawLabel>,
    #[serde(default)]
    author: Option<RawUser>,
    #[serde(default)]
    updated_at: Option<String>,
    #[serde(default)]
    last_acted_at: Option<String>,
    #[serde(default)]
    comment_count: i64,
}

impl RawItem {
    fn number(&self) -> i64 {
        self.number.trim().parse().unwrap_or(0)
    }

    fn into_row(self, auth: &ResolvedAuth, repo: &str, is_pr: bool) -> ForgeIssueRow {
        let number = self.number();
        let (author, author_avatar) = self
            .author
            .map(|u| {
                (
                    ForgeComment::author_name(u.display_name()),
                    u.avatar.as_deref().and_then(sanitize_web_url),
                )
            })
            .unwrap_or((None, None));
        let collection = if is_pr { "pulls" } else { "issues" };
        ForgeIssueRow {
            number,
            title: self.title,
            body: self
                .body
                .as_deref()
                .map(|b| truncate_chars(b, BODY_CAP))
                .filter(|b| !b.trim().is_empty()),
            state: pull_state(&self.state, self.is_merged),
            draft: self.is_wip,
            labels: self
                .labels
                .into_iter()
                .filter_map(|l| ForgeLabel::parse(l.name, l.color.as_deref()))
                .collect(),
            author,
            author_avatar,
            updated_at: self.last_acted_at.or(self.updated_at),
            html_url: format!("{}/{repo}/-/{collection}/{number}", web_origin(auth)),
            is_pr,
            comments: self.comment_count,
        }
    }
}

/// A merge request's detail payload. Shared with the list for the fields the
/// list also carries; `head`/`base`/`mergeable_state` are detail-only.
#[derive(Debug, Deserialize)]
struct RawPull {
    #[serde(default)]
    number: String,
    #[serde(default)]
    state: String,
    #[serde(default)]
    is_wip: bool,
    #[serde(default)]
    is_merged: bool,
    #[serde(default)]
    mergeable_state: Option<String>,
    #[serde(default)]
    head: Option<RawPullRef>,
    #[serde(default)]
    base: Option<RawPullRef>,
}

impl RawPull {
    fn number(&self) -> i64 {
        self.number.trim().parse().unwrap_or(0)
    }

    fn into_pr(self, repo: &str, origin: &str) -> ForgePr {
        let head = self.head.as_ref();
        ForgePr {
            number: self.number(),
            // The web URL is built from the repository rather than read off
            // the payload: CNB's Pull carries no `html_url`.
            html_url: format!(
                "{}/{repo}/-/pulls/{}",
                origin.trim_end_matches('/'),
                self.number()
            ),
            state: pull_state(&self.state, self.is_merged),
            merged: self.is_merged || self.state.eq_ignore_ascii_case("merged"),
            head_sha: head.and_then(|h| h.sha.clone()).unwrap_or_default(),
            head_ref: head.map(|h| h.branch()).unwrap_or_default(),
            head_repo: head
                .and_then(|h| h.repo.as_ref())
                .and_then(|r| r.path.clone().or_else(|| r.name.clone()))
                .unwrap_or_else(|| repo.to_string()),
            base_ref: self.base.map(|b| b.branch()).unwrap_or_default(),
        }
    }
}

#[derive(Debug, Deserialize)]
struct RawPullRef {
    /// `refs/heads/main`, per CNB's schema — [`Self::branch`] strips the
    /// namespace, because every consumer wants the branch NAME.
    #[serde(default, rename = "ref")]
    ref_name: String,
    #[serde(default)]
    sha: Option<String>,
    #[serde(default)]
    repo: Option<RawRepo>,
}

impl RawPullRef {
    fn branch(&self) -> String {
        self.ref_name
            .strip_prefix("refs/heads/")
            .unwrap_or(&self.ref_name)
            .to_string()
    }
}

#[derive(Debug, Deserialize)]
struct RawRepo {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    path: Option<String>,
}

#[derive(Debug, Deserialize)]
struct RawUser {
    #[serde(default)]
    username: Option<String>,
    #[serde(default)]
    nickname: Option<String>,
    #[serde(default)]
    avatar: Option<String>,
}

impl RawUser {
    fn display_name(&self) -> Option<String> {
        self.username
            .clone()
            .filter(|n| !n.trim().is_empty())
            .or_else(|| self.nickname.clone().filter(|n| !n.trim().is_empty()))
    }
}

#[derive(Debug, Deserialize)]
struct RawLabel {
    #[serde(default)]
    name: String,
    #[serde(default)]
    color: Option<String>,
}

#[derive(Debug, Deserialize)]
struct RawComment {
    #[serde(default)]
    id: String,
    #[serde(default)]
    body: Option<String>,
    #[serde(default)]
    created_at: Option<String>,
    #[serde(default)]
    updated_at: Option<String>,
    #[serde(default)]
    author: Option<RawUser>,
}

impl RawComment {
    fn into_comment(self) -> ForgeComment {
        let (author, author_avatar) = self
            .author
            .map(|u| {
                (
                    ForgeComment::author_name(u.display_name()),
                    u.avatar.as_deref().and_then(sanitize_web_url),
                )
            })
            .unwrap_or((None, None));
        ForgeComment {
            id: self.id,
            author,
            author_avatar,
            body: truncate_chars(self.body.as_deref().unwrap_or_default(), BODY_CAP),
            updated_at: ForgeComment::edited_at(self.created_at.as_deref(), self.updated_at),
            created_at: self.created_at,
            // CNB sends no per-comment URL and no anchor is guaranteed to
            // survive its SPA routing; no link beats a link that 404s.
            html_url: None,
        }
    }
}

#[derive(Debug, Deserialize)]
struct RawFile {
    /// The BASE NAME only (`3-experience-report.yml`) — CNB does not send the
    /// repository path here. [`Self::path`] recovers it from the URLs.
    #[serde(default)]
    filename: String,
    #[serde(default)]
    blob_url: Option<String>,
    #[serde(default)]
    raw_url: Option<String>,
    #[serde(default)]
    status: String,
    #[serde(default)]
    additions: i64,
    #[serde(default)]
    deletions: i64,
    #[serde(default)]
    patch: Option<String>,
}

impl RawFile {
    /// The file's path inside the repository.
    ///
    /// `filename` is only the base name (verified against the live API: a file
    /// at `.cnb/ISSUE_TEMPLATE/3-experience-report.yml` arrives as
    /// `3-experience-report.yml`), and a diff list of bare names cannot tell
    /// two same-named files apart. The path is present in `blob_url` /
    /// `raw_url` after the commit SHA, so it is read from there; the bare name
    /// stays as the fallback for a payload that carries neither.
    fn path(&self) -> String {
        const ANCHORS: [&str; 2] = ["/blob/", "/git/raw/"];
        for url in [self.blob_url.as_deref(), self.raw_url.as_deref()]
            .into_iter()
            .flatten()
        {
            for anchor in ANCHORS {
                let Some((_, rest)) = url.split_once(anchor) else {
                    continue;
                };
                // `rest` is `<sha>/<path>`; the first segment is the commit.
                let Some((_sha, path)) = rest.split_once('/') else {
                    continue;
                };
                if !path.is_empty() {
                    return path.to_string();
                }
            }
        }
        self.filename.clone()
    }

    fn into_file(self) -> ForgeChangedFile {
        let status = match self.status.trim().to_ascii_lowercase().as_str() {
            "add" | "added" => ForgeFileStatus::Added,
            "delete" | "deleted" | "remove" | "removed" => ForgeFileStatus::Removed,
            "rename" | "renamed" => ForgeFileStatus::Renamed,
            // `copy` has no variant of its own; it is a file that exists at a
            // path it did not before, which is what `Added` means here.
            "copy" | "copied" => ForgeFileStatus::Added,
            _ => ForgeFileStatus::Modified,
        };
        let binary = self.patch.as_deref().is_none_or(str::is_empty);
        let path = self.path();
        ForgeChangedFile {
            path,
            previous_path: None,
            status,
            // CNB reports counters per file, so absence really is zero here.
            additions: Some(self.additions),
            deletions: Some(self.deletions),
            binary,
            patch: self.patch.filter(|p| !p.is_empty()),
        }
    }
}

#[derive(Debug, Deserialize)]
struct RawError {
    #[serde(default)]
    errmsg: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A real issue row, copied from `GET /cnb/feedback/-/issues`. The fields
    /// worth pinning are the STRING number and the absent body.
    #[test]
    fn issue_row_deserializes_without_a_body() {
        let raw: RawItem = serde_json::from_value(serde_json::json!({
            "number": "5330",
            "state": "open",
            "state_reason": "open",
            "title": "申请为组织开通模型",
            "invisible": false,
            "author": { "username": "cnb.abc", "nickname": "竹影清风" },
            "assignees": [],
            "labels": [],
            "comment_count": 7,
            "created_at": "2026-10-29T05:53:03Z",
            "updated_at": "2026-10-29T12:06:18Z",
            "closed_at": ""
        }))
        .expect("issue row");
        assert_eq!(raw.number(), 5330);
        assert_eq!(raw.body, None);
        assert_eq!(raw.comment_count, 7);
        assert_eq!(raw.state, "open");
    }

    /// A real pull row: the refs carry the `refs/heads/` namespace and the
    /// state is `merged` outright.
    #[test]
    fn pull_row_strips_ref_namespace_and_reads_merged_state() {
        let raw: RawPull = serde_json::from_value(serde_json::json!({
            "number": "5255",
            "state": "closed",
            "mergeable_state": "merged",
            "is_wip": false,
            "is_merged": true,
            "head": {
                "ref": "refs/heads/auto/fix",
                "sha": "abc123",
                "repo": { "name": "feedback", "path": "cnb/feedback" }
            },
            "base": {
                "ref": "refs/heads/main",
                "sha": "def456",
                "repo": { "name": "feedback", "path": "cnb/feedback" }
            }
        }))
        .expect("pull row");
        let pr = raw.into_pr("cnb/feedback", "https://cnb.cool");
        assert_eq!(pr.number, 5255);
        assert_eq!(pr.head_ref, "auto/fix");
        assert_eq!(pr.base_ref, "main");
        assert_eq!(pr.head_sha, "abc123");
        assert_eq!(pr.state, "merged");
        assert!(pr.merged);
        assert_eq!(pr.html_url, "https://cnb.cool/cnb/feedback/-/pulls/5255");
    }

    #[test]
    fn order_by_uses_only_the_spellings_cnb_accepts() {
        assert_eq!(order_by(ForgeSort::Newest), "-created_at");
        assert_eq!(order_by(ForgeSort::Oldest), "created_at");
        assert_eq!(order_by(ForgeSort::RecentlyUpdated), "-updated_at");
        // No ascending-updated order exists; the panel does not offer this one
        // for CNB, and the default is the safe landing if it ever arrives.
        assert_eq!(order_by(ForgeSort::LeastRecentlyUpdated), "-created_at");
    }

    #[test]
    fn all_is_spelled_per_collection() {
        // Issues: omitting the filter is the only way to ask for everything.
        assert_eq!(state_filter(ForgeTab::Issues, "all"), None);
        // Pulls: an explicit `all`; omitting it means open-only.
        assert_eq!(state_filter(ForgeTab::Prs, "all"), Some("all"));
        assert_eq!(state_filter(ForgeTab::Issues, "open"), Some("open"));
        assert_eq!(state_filter(ForgeTab::Prs, "closed"), Some("closed"));
    }

    /// A merged merge request comes back CLOSED with the flag set, not with a
    /// `merged` state — the flag has to win, or every landed change reads as
    /// merely closed.
    #[test]
    fn merged_flag_beats_the_closed_state() {
        assert_eq!(pull_state("closed", true), "merged");
        assert_eq!(pull_state("closed", false), "closed");
        assert_eq!(pull_state("open", false), "open");
        assert_eq!(pull_state("merged", false), "merged");
    }

    #[test]
    fn mergeable_state_maps_the_whole_vocabulary() {
        assert_eq!(mergeable(&Some("mergeable".into())), Some(true));
        assert_eq!(mergeable(&Some("merged".into())), Some(true));
        assert_eq!(mergeable(&Some("conflict".into())), Some(false));
        assert_eq!(mergeable(&Some("no-merge-base".into())), Some(false));
        // Still being computed, or already landing: no answer yet.
        assert_eq!(mergeable(&Some("checking".into())), None);
        assert_eq!(mergeable(&Some("merging".into())), None);
        assert_eq!(mergeable(&None), None);
    }

    /// `filename` is a BASE NAME on CNB; the path is recovered from the URLs.
    #[test]
    fn file_path_comes_from_the_url_not_the_bare_name() {
        let file: RawFile = serde_json::from_value(serde_json::json!({
            "filename": "3-experience-report.yml",
            "status": "modify",
            "additions": 5,
            "deletions": 0,
            "blob_url": "https://cnb.cool/cnb/feedback/-/blob/539e255/.cnb/ISSUE_TEMPLATE/3-experience-report.yml",
            "raw_url": "https://cnb.cool/cnb/feedback/-/git/raw/539e255/.cnb/ISSUE_TEMPLATE/3-experience-report.yml",
            "patch": "@@ -1 +1 @@"
        }))
        .expect("file row");
        assert_eq!(file.path(), ".cnb/ISSUE_TEMPLATE/3-experience-report.yml");

        let bare: RawFile = serde_json::from_value(serde_json::json!({
            "filename": "README.md",
            "status": "add"
        }))
        .expect("bare file row");
        assert_eq!(bare.path(), "README.md");
    }

    /// Live smoke test against the real CNB API — the only way to catch a
    /// wire-shape drift the fixture rows above cannot predict. Ignored so CI
    /// never touches the network; run it by hand:
    ///
    /// ```text
    /// CNB_TEST_TOKEN=… CNB_TEST_REPO=cnb/feedback \
    ///   cargo test --features test-utils forge::cnb::tests::live -- --ignored
    /// ```
    #[tokio::test]
    #[ignore = "network: needs CNB_TEST_TOKEN (and optionally CNB_TEST_REPO)"]
    async fn live_smoke() {
        let token = std::env::var("CNB_TEST_TOKEN").expect("CNB_TEST_TOKEN");
        let repo = std::env::var("CNB_TEST_REPO").unwrap_or_else(|_| "cnb/feedback".into());
        let auth = ResolvedAuth {
            provider: super::super::ForgeProvider::Cnb,
            server_host: "cnb.cool".into(),
            api_base: "https://api.cnb.cool".into(),
            account_id: "cnb-live".into(),
            username: "live".into(),
            avatar_url: None,
            token,
            scopes: vec![],
        };

        let list = list_issues(
            &auth,
            &issue_request(&repo, ForgeTab::Issues, ForgeSort::Newest),
        )
        .await
        .expect("issue list");
        assert!(!list.rows.is_empty(), "repo has no issues to read");
        assert!(list.rows.iter().all(|r| r.number > 0 && !r.is_pr));

        let number = list.rows[0].number;
        list_comments(&auth, &repo, ForgeItemKind::Issue, number, 1, 10)
            .await
            .expect("issue comments");
        list_labels(&auth, &repo).await.expect("labels");
        list_issues(
            &auth,
            &issue_request(&repo, ForgeTab::Issues, ForgeSort::Oldest),
        )
        .await
        .expect("oldest order");

        let pulls = list_issues(
            &auth,
            &issue_request(&repo, ForgeTab::Prs, ForgeSort::Newest),
        )
        .await
        .expect("pull list");
        if let Some(pr) = pulls.rows.first() {
            let detail = change_detail(&auth, &repo, pr.number)
                .await
                .expect("pull detail");
            assert_eq!(detail.number, pr.number);
            list_change_files(&auth, &repo, pr.number, 1, 10)
                .await
                .expect("pull files");
        }
    }

    fn issue_request(repo: &str, tab: ForgeTab, sort: ForgeSort) -> ListIssuesRequest {
        ListIssuesRequest::new(
            repo.to_string(),
            super::super::ListFilters {
                tab,
                state: "all".into(),
                assigned_me: false,
                labels: vec![],
                search: None,
                sort,
                page: 1,
                per_page: 10,
                account_id: None,
            },
        )
    }

    #[test]
    fn file_status_vocabulary_maps_to_the_panel() {
        let status = |s: &str| {
            let file: RawFile = serde_json::from_value(serde_json::json!({
                "filename": "f",
                "status": s
            }))
            .expect("file row");
            file.into_file().status
        };
        assert_eq!(status("add"), ForgeFileStatus::Added);
        assert_eq!(status("delete"), ForgeFileStatus::Removed);
        assert_eq!(status("rename"), ForgeFileStatus::Renamed);
        assert_eq!(status("modify"), ForgeFileStatus::Modified);
    }
}
