//! GitLab REST v4 for the workbench and the delivery path.
//!
//! GitLab is not "GitHub with different words" in the four places that matter
//! here, and each of them is a silent-wrong-answer if you assume otherwise:
//!
//! 1. **Issues and merge requests are separate collections.** GitHub serves
//!    both from `/issues` and splits on a `pull_request` key; here each tab is
//!    its own endpoint, and so is each comment target (`/issues/{iid}/notes`
//!    vs `/merge_requests/{iid}/notes`).
//! 2. **The project is a path, not `{owner}/{repo}`.** Subgroups nest
//!    arbitrarily deep, and the whole path goes into ONE percent-encoded path
//!    segment (`group%2Fsub%2Fproj`).
//! 3. **`merged` is a state, not a flag.** `state=closed` excludes merged
//!    merge requests, so the workbench's "closed" tab asks for everything and
//!    filters locally — otherwise a merged merge request would simply vanish
//!    from a list where GitHub shows it.
//! 4. **Numbers are `iid`, not `id`.** `id` is globally unique and appears in
//!    no URL a human ever sees; addressing by it silently reads another
//!    project's work item.
//!
//! Pagination is offset-based (`page` + `per_page`), and the totals are the
//! one place it differs from the GitHub client: `X-Total` / `X-Total-Pages`
//! are OPTIONAL — GitLab omits them past 10,000 rows on purpose — so
//! `X-Next-Page` is the only signal always present. Rate-limit classification
//! is shared with the GitHub client.

use std::collections::HashMap;
use std::sync::{LazyLock, RwLock};

use serde::Deserialize;

use super::auth::ResolvedAuth;
use super::deliver::{ForgePr, NewPullRequest};
use super::{
    count_diff_lines, sanitize_web_url, truncate_chars, urlencode_path, urlencode_query,
    validate_state_filter, web_origin, ForgeChangeDetail, ForgeChangedFile, ForgeChangedFileList,
    ForgeCheck, ForgeCheckList, ForgeCheckState, ForgeComment, ForgeCommentList, ForgeError,
    ForgeFileStatus, ForgeIssueList, ForgeIssueRow, ForgeItemKind, ForgeLabel, ForgeLabelList,
    ForgeMergeMethod, ForgeMergeOptions, ForgeMergeStrategy, ForgeSort, ForgeStateAction,
    ListIssuesRequest, ResolvedNewIssue, BODY_CAP, LABEL_PAGE_SIZE,
};

// ── reads ───────────────────────────────────────────────────────────────────

pub async fn list_issues(
    auth: &ResolvedAuth,
    req: &ListIssuesRequest,
) -> Result<ForgeIssueList, ForgeError> {
    let project = project_ref(&req.owner_repo)?;
    validate_state_filter(&req.state)?;

    let (page, per_page) = req.clamped();

    let collection = match req.tab {
        super::ForgeTab::Issues => "issues",
        super::ForgeTab::Prs => "merge_requests",
    };
    // `with_labels_details=true` turns each entry of `labels` from a bare name
    // into an object carrying the label's colour — the chip the workbench draws
    // is the project's own, as it is on GitHub. Instances that predate the
    // parameter ignore it and keep sending strings, which `RawItemLabel` reads
    // just as happily.
    let mut url = format!(
        "{}/projects/{project}/{collection}?state={}&order_by={}&sort={}\
         &with_labels_details=true&page={page}&per_page={per_page}",
        auth.api_base,
        wire_state(req.tab, &req.state),
        order_by(req.sort),
        req.sort.direction()
    );
    if req.assigned_me {
        // `assignee_username` takes the literal login; there is no `@me`
        // shorthand on the collection endpoints.
        let login = current_login(auth).await?;
        url.push_str(&format!("&assignee_username={}", urlencode_query(&login)));
    }
    if !req.labels.is_empty() {
        // Comma-joined, which is lossless here: GitLab forbids commas in label
        // titles, so no name can be split by this.
        url.push_str(&format!("&labels={}", urlencode_query(&req.labels.join(","))));
    }
    if let Some(text) = req.search.as_deref() {
        // `search` is plain text on both collections, so unlike GitHub's `q`
        // there is no query syntax to strip. `in` is title+description by
        // default and is stated anyway: the box promises that scope, and a
        // promise resting on somebody else's default is one release away from
        // being wrong.
        url.push_str(&format!("&search={}&in=title,description", urlencode_query(text)));
    }

    let response = api_get(auth, &url).await?;
    let total_count = header_i64(response.headers(), "x-total");
    // Empty means "no page after this one" — the one pagination signal GitLab
    // always sends, even where it declines to count.
    let has_next = header_str(response.headers(), "x-next-page")
        .is_some_and(|v| !v.trim().is_empty());
    let raw: Vec<RawItem> = response
        .json()
        .await
        .map_err(|e| ForgeError::Network(format!("bad list payload: {e}")))?;

    let is_pr = req.tab == super::ForgeTab::Prs;
    // Whether this query is narrowed AFTER it arrives — structural, not
    // data-dependent: a page that happens to hold no open rows is still part
    // of a result set whose count includes them elsewhere.
    let filters_locally = wire_state(req.tab, &req.state) == "all" && req.state != "all";
    let rows = raw
        .into_iter()
        .filter(|item| keeps(&req.state, &item.state))
        .map(|item| item.into_row(is_pr))
        .collect();

    Ok(ForgeIssueList {
        rows,
        page,
        per_page,
        // Withheld rather than wrong. Two ways the count stops being true:
        // GitLab omits `X-Total` past 10k rows (documented, for performance),
        // and the closed-merge-request query above asks for `state=all` and
        // filters here — so its total counts open rows the user cannot see.
        // `None` is the signal the UI degrades to previous/next on.
        total_count: total_count.filter(|_| !filters_locally),
        // GitLab paginates the whole collection — no equivalent of GitHub
        // search's first-thousand ceiling, so every match is reachable.
        reachable_count: None,
        has_next,
        // GitLab has no partial-result flag; only GitHub search does.
        incomplete: false,
    })
}

/// GitLab's spelling of the sort field. It is the SAME two fields GitHub
/// offers, suffixed — and the only two both collections (issues and merge
/// requests) accept, which is what makes the workbench's four orders portable.
fn order_by(sort: ForgeSort) -> &'static str {
    match sort.field() {
        "updated" => "updated_at",
        _ => "created_at",
    }
}

/// The project's labels, for the workbench's label filter.
///
/// `with_counts=false` on purpose: the counts are an extra aggregation per
/// label on the server and nothing here shows them.
pub async fn list_labels(
    auth: &ResolvedAuth,
    owner_repo: &str,
) -> Result<ForgeLabelList, ForgeError> {
    let project = project_ref(owner_repo)?;
    let url = format!(
        "{}/projects/{project}/labels?per_page={LABEL_PAGE_SIZE}&with_counts=false",
        auth.api_base
    );
    #[derive(Deserialize)]
    struct RawProjectLabel {
        #[serde(default)]
        name: String,
        /// `#rrggbb` here, unlike GitHub's bare digits.
        #[serde(default)]
        color: Option<String>,
    }
    let raw: Vec<RawProjectLabel> = api_get(auth, &url)
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

fn header_str<'h>(headers: &'h reqwest::header::HeaderMap, name: &str) -> Option<&'h str> {
    headers.get(name)?.to_str().ok()
}

fn header_i64(headers: &reqwest::header::HeaderMap, name: &str) -> Option<i64> {
    header_str(headers, name)?.trim().parse().ok()
}

/// One page of an item's discussion, system events removed.
///
/// Two GitLab facts shape everything here:
///
/// 1. **The collection is part of the path.** `/issues/{iid}/notes` and
///    `/merge_requests/{iid}/notes` are different endpoints over different
///    numbering, so asking the wrong one either 404s or — worse — answers with
///    the discussion of a real item that is not the one on screen.
/// 2. **`notes` is not "comments".** It also carries the system events
///    ("changed the milestone", "assigned to @bob"), which is exactly the
///    difference between `notes` and the `user_notes_count` the row shows. They
///    are dropped HERE so the thread matches the count above it.
///
/// Dropping them locally is why `has_next` comes from `X-Next-Page` rather
/// than from how many rows survived: a page of nothing but system events is
/// empty of comments and still has a discussion behind it.
pub async fn list_notes(
    auth: &ResolvedAuth,
    owner_repo: &str,
    kind: ForgeItemKind,
    iid: i64,
    page: u32,
    per_page: u32,
) -> Result<ForgeCommentList, ForgeError> {
    let repo = super::normalize_repo(owner_repo)
        .ok_or_else(|| ForgeError::Invalid(format!("bad repository path: {owner_repo}")))?;
    let project = project_ref(owner_repo)?;
    if iid <= 0 {
        return Err(ForgeError::Invalid(format!("bad work item number: {iid}")));
    }
    let collection = collection_of(kind);
    // Ascending, said out loud: GitLab's own default for notes is DESCENDING,
    // so without this the thread would read backwards and "load more" would
    // append older comments under newer ones.
    let url = format!(
        "{}/projects/{project}/{collection}/{iid}/notes\
         ?order_by=created_at&sort=asc&page={page}&per_page={per_page}",
        auth.api_base
    );
    let response = api_get(auth, &url).await?;
    let has_next = header_str(response.headers(), "x-next-page")
        .is_some_and(|v| !v.trim().is_empty());
    let raw: Vec<RawNote> = response
        .json()
        .await
        .map_err(|e| ForgeError::Network(format!("bad notes payload: {e}")))?;

    let anchor = NoteAnchor {
        origin: web_origin(auth),
        repo,
        collection,
        iid,
    };
    let comments = raw
        .into_iter()
        .filter(|note| !note.system)
        .map(|note| note.into_comment(&anchor))
        .collect();

    Ok(ForgeCommentList {
        comments,
        page,
        per_page,
        has_next,
    })
}

/// One merge request by `iid` — what turns "!12" into something checkoutable.
///
/// A merge request opened from a fork reports only the numeric id of its
/// source project, so the fork's path is resolved here (one extra request, and
/// only for forks) — that name goes straight into the refusal the user reads,
/// and "project 4711" would be a worse answer than the truth.
pub async fn get_merge_request(
    auth: &ResolvedAuth,
    owner_repo: &str,
    iid: i64,
) -> Result<ForgePr, ForgeError> {
    let project = project_ref(owner_repo)?;
    if iid <= 0 {
        return Err(ForgeError::Invalid(format!("bad work item number: {iid}")));
    }
    let url = format!("{}/projects/{project}/merge_requests/{iid}", auth.api_base);
    let raw: RawMergeRequest = api_get(auth, &url)
        .await?
        .json()
        .await
        .map_err(|e| ForgeError::Network(format!("bad merge request payload: {e}")))?;
    let foreign_project = raw.source_project_id.filter(|src| Some(*src) != raw.target_project_id);
    let mut pr = map_merge_request(raw, owner_repo);
    if let Some(id) = foreign_project {
        if let Some(path) = project_path(auth, id).await {
            pr.head_repo = path;
        }
    }
    Ok(pr)
}

/// Merge requests whose source branch is `source_branch`, in ANY state — a
/// merged or closed one is exactly what recovery must be able to see.
///
/// Fork sources keep their placeholder head repository here: this list only
/// ever feeds the four-way match, which refuses anything that is not the
/// source project anyway, so resolving each fork's real path would be a
/// request per row spent on rows that cannot be adopted.
pub async fn find_merge_requests(
    auth: &ResolvedAuth,
    owner_repo: &str,
    source_branch: &str,
) -> Result<Vec<ForgePr>, ForgeError> {
    let project = project_ref(owner_repo)?;
    let url = format!(
        "{}/projects/{project}/merge_requests?source_branch={}&state=all&per_page=100",
        auth.api_base,
        urlencode_query(source_branch)
    );
    let raw: Vec<RawMergeRequest> = api_get(auth, &url)
        .await?
        .json()
        .await
        .map_err(|e| ForgeError::Network(format!("bad merge requests payload: {e}")))?;
    Ok(raw
        .into_iter()
        .map(|m| map_merge_request(m, owner_repo))
        .collect())
}

// ── writes ──────────────────────────────────────────────────────────────────

/// `POST /projects/{p}/merge_requests`.
///
/// GitLab has no `draft` parameter: a draft IS a title starting with `Draft:`,
/// which is also how its UI toggles the state. Prefixing is therefore the
/// supported way to open one, not a workaround.
pub async fn create_merge_request(
    auth: &ResolvedAuth,
    owner_repo: &str,
    req: &NewPullRequest<'_>,
) -> Result<ForgePr, ForgeError> {
    // Where the request is ADDRESSED. GitLab resolves `source_branch` in the
    // project the request is sent to, so a merge request from a fork is created
    // ON the fork, with the project it is aimed at named in the body. Addressing
    // the target and naming the fork in `source_project_id` instead is answered
    // with `source_branch does not exist` — measured against gitlab.com, not
    // guessed.
    let project = match req.source_project_id {
        Some(fork) => fork.to_string(),
        None => project_ref(owner_repo)?,
    };
    let url = format!("{}/projects/{project}/merge_requests", auth.api_base);
    let title = if req.draft && !is_draft_title(req.title) {
        format!("Draft: {}", req.title)
    } else {
        req.title.to_string()
    };
    let mut body = serde_json::json!({
        "source_branch": req.head,
        "target_branch": req.base,
        "title": title,
        "description": req.body,
    });
    // The other half of a cross-project merge request. Omitting it does not
    // fall back to the fork's upstream — it makes the fork its own target.
    if let Some(id) = req.target_project_id {
        body["target_project_id"] = serde_json::json!(id);
    }
    let raw: RawMergeRequest = api_post(auth, &url, &body)
        .await?
        .json()
        .await
        .map_err(|e| ForgeError::Network(format!("bad merge request payload: {e}")))?;
    Ok(map_merge_request(raw, owner_repo))
}

/// `POST /projects/{p}/{issues|merge_requests}/{iid}/notes`.
///
/// The collection is part of the path here — unlike GitHub, where a pull
/// request is an issue and one endpoint serves both. Posting an issue note to
/// the merge-request collection (or the reverse) is a 404 against a number
/// that may well exist in the other collection.
pub async fn create_note(
    auth: &ResolvedAuth,
    owner_repo: &str,
    kind: ForgeItemKind,
    iid: i64,
    body: &str,
) -> Result<ForgeComment, ForgeError> {
    let repo = super::normalize_repo(owner_repo)
        .ok_or_else(|| ForgeError::Invalid(format!("bad repository path: {owner_repo}")))?;
    let project = project_ref(owner_repo)?;
    if iid <= 0 {
        return Err(ForgeError::Invalid(format!("bad work item number: {iid}")));
    }
    let collection = collection_of(kind);
    let url = format!("{}/projects/{project}/{collection}/{iid}/notes", auth.api_base);
    let created: RawNote = api_post(auth, &url, &serde_json::json!({ "body": body }))
        .await?
        .json()
        .await
        .map_err(|e| ForgeError::Network(format!("bad note payload: {e}")))?;
    // Through the same mapper the READER uses, anchor included: a comment that
    // came back from the composer and the same comment on the next page of the
    // thread have to be one object, or the optimistic append shows a second
    // copy of what was just posted.
    Ok(created.into_comment(&NoteAnchor {
        origin: web_origin(auth),
        repo,
        collection,
        iid,
    }))
}

/// Close or reopen one item, and hand back the row as the project now sees it.
///
/// `PUT /projects/{p}/{issues|merge_requests}/{iid}` with a `state_event` — a
/// VERB, not a target state. Note the returned row's labels arrive as bare
/// NAMES: `with_labels_details` is a list-endpoint parameter, so a single item
/// never carries its labels' colours. The panel keeps the ones it already had
/// (see `mergeForgeRowUpdate` in the frontend) rather than dropping every chip
/// to grey on a close.
pub async fn set_item_state(
    auth: &ResolvedAuth,
    owner_repo: &str,
    kind: ForgeItemKind,
    iid: i64,
    action: ForgeStateAction,
) -> Result<ForgeIssueRow, ForgeError> {
    let project = project_ref(owner_repo)?;
    if iid <= 0 {
        return Err(ForgeError::Invalid(format!("bad work item number: {iid}")));
    }
    let collection = collection_of(kind);
    let url = format!("{}/projects/{project}/{collection}/{iid}", auth.api_base);
    let raw: RawItem = api_put(
        auth,
        &url,
        &serde_json::json!({ "state_event": action.gitlab_event() }),
    )
    .await?
    .json()
    .await
    .map_err(|e| ForgeError::Network(format!("bad item payload: {e}")))?;
    Ok(raw.into_row(kind == ForgeItemKind::Change))
}

/// `POST /projects/{p}/issues` — open an issue, and hand back its row.
///
/// Labels are COMMA-JOINED, which is lossless: GitLab forbids commas in label
/// titles, so no name can be split by this (the same property the list filter
/// leans on).
pub async fn create_issue(
    auth: &ResolvedAuth,
    owner_repo: &str,
    draft: &ResolvedNewIssue,
) -> Result<ForgeIssueRow, ForgeError> {
    let project = project_ref(owner_repo)?;
    let url = format!("{}/projects/{project}/issues", auth.api_base);
    let mut payload = serde_json::json!({ "title": draft.title });
    if let Some(body) = draft.body.as_deref() {
        payload["description"] = serde_json::Value::String(body.to_string());
    }
    if !draft.labels.is_empty() {
        payload["labels"] = serde_json::Value::String(draft.labels.join(","));
    }
    let raw: RawItem = api_post(auth, &url, &payload)
        .await?
        .json()
        .await
        .map_err(|e| ForgeError::Network(format!("bad issue payload: {e}")))?;
    Ok(raw.into_row(false))
}

// ── proposed changes ────────────────────────────────────────────────────────

/// One merge request's branches, size and CI.
///
/// Two requests: the merge request itself, then its head pipeline's jobs.
/// Almost every counter GitHub's pull object carries is simply absent here —
/// GitLab reports neither additions/deletions nor a commit count on a merge
/// request — so those stay `None` rather than being invented from a diff this
/// call deliberately does not fetch.
pub async fn change_detail(
    auth: &ResolvedAuth,
    owner_repo: &str,
    iid: i64,
) -> Result<ForgeChangeDetail, ForgeError> {
    let project = project_ref(owner_repo)?;
    if iid <= 0 {
        return Err(ForgeError::Invalid(format!("bad work item number: {iid}")));
    }
    let url = format!("{}/projects/{project}/merge_requests/{iid}", auth.api_base);
    let raw: RawMergeRequestDetail = api_get(auth, &url)
        .await?
        .json()
        .await
        .map_err(|e| ForgeError::Network(format!("bad merge request payload: {e}")))?;

    let checks = match raw.head_pipeline.as_ref().map(|p| p.id) {
        Some(pipeline) => pipeline_jobs(auth, &project, pipeline).await,
        // GitLab answered and named no pipeline: there is nothing to run, which
        // is a fact — not the same as a request that could not be made.
        None => ForgeCheckList::available(Vec::new()),
    };

    // A fork's real path costs one extra request and is only spent when the
    // source project genuinely differs — the same rule `get_merge_request`
    // follows, and for the same reason: "project 4711" is a worse answer than
    // the truth in the one place a reader needs it.
    let head_repo = match (raw.source_project_id, raw.target_project_id) {
        (Some(source), Some(target)) if source != target => project_path(auth, source).await,
        _ => None,
    };

    Ok(ForgeChangeDetail {
        number: if raw.iid > 0 { raw.iid } else { iid },
        base_ref: raw.target_branch,
        head_ref: raw.source_branch,
        head_repo,
        head_sha: raw
            .diff_refs
            .and_then(|d| d.head_sha)
            .or(raw.sha)
            .filter(|sha| !sha.is_empty()),
        draft: raw.draft || raw.work_in_progress,
        state: display_state(&raw.state),
        mergeable: mergeable(raw.merge_status.as_deref(), raw.has_conflicts),
        // The detailed status where the instance has one (GitLab 15.6+, and it
        // says WHY — `not_approved`, `conflict`, `ci_still_running`), the older
        // three-value one otherwise.
        merge_state: raw
            .detailed_merge_status
            .or(raw.merge_status)
            .filter(|s| !s.is_empty()),
        additions: None,
        deletions: None,
        changed_files: raw.changes_count.as_deref().and_then(exact_changes_count),
        commits: None,
        checks,
    })
}

/// GitLab's merge status, as a tri-state.
///
/// `unchecked` / `checking` / `cannot_be_merged_recheck` all mean the server
/// has not finished working it out — the same "ask again shortly" GitHub
/// answers with a null `mergeable`, and emphatically not "cannot be merged".
fn mergeable(merge_status: Option<&str>, has_conflicts: bool) -> Option<bool> {
    if has_conflicts {
        return Some(false);
    }
    match merge_status? {
        "can_be_merged" => Some(true),
        "cannot_be_merged" => Some(false),
        _ => None,
    }
}

/// `changes_count` as a number, but only when it IS one.
///
/// GitLab sends this as a string and suffixes it with `+` once the diff hits
/// its own limit ("1000+"). Parsing the digits off that would print "1000
/// files" for a change that touches more, so a truncated count is reported as
/// no count at all.
fn exact_changes_count(raw: &str) -> Option<i64> {
    raw.trim().parse::<i64>().ok().filter(|n| *n >= 0)
}

/// The head pipeline's jobs, as checks.
///
/// One request, and its failure is swallowed the same way GitHub's is: a token
/// that cannot read pipelines still reads the merge request perfectly well, and
/// losing the panel over the CI section would be the worse answer.
async fn pipeline_jobs(auth: &ResolvedAuth, project: &str, pipeline: i64) -> ForgeCheckList {
    if pipeline <= 0 {
        return ForgeCheckList::unavailable();
    }
    let url = format!(
        "{}/projects/{project}/pipelines/{pipeline}/jobs?per_page={LABEL_PAGE_SIZE}",
        auth.api_base
    );
    let raw: Option<Vec<RawJob>> = async { api_get(auth, &url).await.ok()?.json().await.ok() }.await;
    match raw {
        Some(jobs) => ForgeCheckList::available(
            jobs.into_iter()
                .map(|job| ForgeCheck {
                    id: format!("job-{}", job.id),
                    state: job_state(&job.status),
                    // The stage, which is what turns a column of job names into
                    // a pipeline you can read ("test", "build", "deploy").
                    summary: job.stage.filter(|stage| !stage.trim().is_empty()),
                    url: job.web_url.as_deref().and_then(sanitize_web_url),
                    name: job.name,
                    allow_failure: job.allow_failure,
                })
                .collect(),
        ),
        None => ForgeCheckList::unavailable(),
    }
}

/// GitLab's eleven job statuses in the five the strip draws.
fn job_state(status: &str) -> ForgeCheckState {
    match status {
        "success" => ForgeCheckState::Success,
        "failed" => ForgeCheckState::Failure,
        "running" | "preparing" => ForgeCheckState::Running,
        "created" | "pending" | "scheduled" | "waiting_for_resource" => ForgeCheckState::Queued,
        // canceled, skipped, manual — ran (or deliberately did not) and
        // produced no verdict.
        _ => ForgeCheckState::Neutral,
    }
}

/// One page of the files a merge request touches.
///
/// `/diffs` is the paginated endpoint (GitLab 15.7+); older instances answer
/// 404 and are served from `/changes`, which returns the WHOLE diff in one
/// payload and is sliced locally so the panel's footer behaves the same either
/// way. GitLab counts nothing per file, so the `+`/`−` beside each path is
/// counted off the diff hunk it ships (see [`count_diff_lines`]).
pub async fn list_change_files(
    auth: &ResolvedAuth,
    owner_repo: &str,
    iid: i64,
    page: u32,
    per_page: u32,
) -> Result<ForgeChangedFileList, ForgeError> {
    let project = project_ref(owner_repo)?;
    if iid <= 0 {
        return Err(ForgeError::Invalid(format!("bad work item number: {iid}")));
    }
    let url = format!(
        "{}/projects/{project}/merge_requests/{iid}/diffs?page={page}&per_page={per_page}",
        auth.api_base
    );
    match api_get(auth, &url).await {
        Ok(response) => {
            let has_next = header_str(response.headers(), "x-next-page")
                .is_some_and(|v| !v.trim().is_empty());
            let raw: Vec<RawDiff> = response
                .json()
                .await
                .map_err(|e| ForgeError::Network(format!("bad diffs payload: {e}")))?;
            Ok(ForgeChangedFileList {
                files: raw.into_iter().map(RawDiff::into_file).collect(),
                page,
                per_page,
                has_next,
            })
        }
        Err(ForgeError::NotFound) => {
            legacy_change_files(auth, &project, iid, page, per_page).await
        }
        Err(other) => Err(other),
    }
}

/// The pre-15.7 spelling: one unpaginated payload, paged here.
async fn legacy_change_files(
    auth: &ResolvedAuth,
    project: &str,
    iid: i64,
    page: u32,
    per_page: u32,
) -> Result<ForgeChangedFileList, ForgeError> {
    #[derive(Deserialize)]
    struct RawChanges {
        #[serde(default)]
        changes: Vec<RawDiff>,
    }
    let url = format!(
        "{}/projects/{project}/merge_requests/{iid}/changes",
        auth.api_base
    );
    let raw: RawChanges = api_get(auth, &url)
        .await?
        .json()
        .await
        .map_err(|e| ForgeError::Network(format!("bad changes payload: {e}")))?;
    let total = raw.changes.len();
    // `saturating_mul` rather than a bare product: `page` is clamped to at
    // least 1 but has no ceiling, and a 32-bit overflow here would wrap round
    // to the FIRST page of a list the caller asked to be past the end of.
    let skip = (page as usize).saturating_sub(1).saturating_mul(per_page as usize);
    Ok(ForgeChangedFileList {
        files: raw
            .changes
            .into_iter()
            .skip(skip)
            .take(per_page as usize)
            .map(RawDiff::into_file)
            .collect(),
        page,
        per_page,
        has_next: total > skip.saturating_add(per_page as usize),
    })
}

// ── merging ─────────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
struct RawProjectMergeSettings {
    /// `merge` | `rebase_merge` | `ff`.
    #[serde(default)]
    merge_method: Option<String>,
    /// `never` | `always` | `default_on` | `default_off`.
    #[serde(default)]
    squash_option: Option<String>,
}

/// GitLab's three project-level merge methods, as the shared strategy.
///
/// This is NOT a choice the caller gets — the API takes no method — so it only
/// ever describes what will happen. Describing it is the point: a project set
/// to `ff` that was offered "Create a merge commit" would be told its history
/// gets a merge commit it will never have.
fn merge_strategy(merge_method: Option<&str>) -> ForgeMergeStrategy {
    match merge_method {
        Some("ff") => ForgeMergeStrategy::FastForward,
        Some("rebase_merge") => ForgeMergeStrategy::RebaseMerge,
        _ => ForgeMergeStrategy::MergeCommit,
    }
}

/// Which merge methods this project permits.
///
/// GitLab's merge endpoint takes NO method: the project's own `merge_method`
/// setting decides between a merge commit, a rebase-merge and a fast-forward,
/// and the caller cannot override it. So the only real choice here is whether
/// to squash first, and the menu is at most two entries deep.
///
/// [`ForgeMergeMethod::Rebase`] is never offered. GitLab does rebase a merge
/// request, but through `PUT /merge_requests/{iid}/rebase` — a different
/// operation, asynchronous, that this module does not call. An entry for it
/// would be an offer to make a request that is never made.
pub async fn merge_options(
    auth: &ResolvedAuth,
    owner_repo: &str,
) -> Result<ForgeMergeOptions, ForgeError> {
    let project = project_ref(owner_repo)?;
    let url = format!("{}/projects/{project}", auth.api_base);
    let raw: RawProjectMergeSettings = api_get(auth, &url)
        .await?
        .json()
        .await
        .map_err(|e| ForgeError::Network(format!("bad project payload: {e}")))?;

    // The presence of EITHER key is what says this payload really is a
    // project's settings — an instance old enough to omit both tells us
    // nothing, and inventing "squash is available" from that would put an entry
    // in the menu that 422s.
    let squash = match (raw.merge_method.as_deref(), raw.squash_option.as_deref()) {
        (None, None) => return Ok(ForgeMergeOptions::unknown()),
        (_, option) => option.unwrap_or("default_off"),
    };
    let strategy = merge_strategy(raw.merge_method.as_deref());
    Ok(match squash {
        // The project REQUIRES squashing: offering "Merge" as well would offer
        // a request GitLab rewrites into the other one.
        "always" => ForgeMergeOptions {
            methods: vec![ForgeMergeMethod::Squash],
            default_method: ForgeMergeMethod::Squash,
            merge_strategy: strategy,
        },
        "never" => ForgeMergeOptions {
            methods: vec![ForgeMergeMethod::Merge],
            default_method: ForgeMergeMethod::Merge,
            merge_strategy: strategy,
        },
        // Both offered; the project says which one the box opens on.
        other => ForgeMergeOptions {
            methods: vec![ForgeMergeMethod::Merge, ForgeMergeMethod::Squash],
            default_method: if other == "default_on" {
                ForgeMergeMethod::Squash
            } else {
                ForgeMergeMethod::Merge
            },
            merge_strategy: strategy,
        },
    })
}

/// Merge one merge request, and hand back the row the project now serves.
///
/// ONE request, unlike GitHub's two: `PUT /merge_requests/{iid}/merge` answers
/// with the merge request itself, so the row the panel adopts comes straight
/// out of the write through the same [`RawItem`] mapper the list uses.
/// `Ok(None)` is therefore only ever "it merged and the answer did not parse",
/// which is not an error — the change has landed, and reporting a failure would
/// invite somebody to try an irreversible operation a second time.
///
/// [`ForgeMergeMethod::Rebase`] is REFUSED rather than quietly treated as a
/// plain merge. GitLab rebases through `PUT /merge_requests/{iid}/rebase`, an
/// asynchronous operation this module does not call, and a caller that asked
/// for one and got a merge commit was told the wrong thing about its own
/// history. The panel never offers it (see [`merge_options`]); this is the
/// guard for every other caller, the server binary's HTTP surface included.
///
/// `head_sha`, when given, is the commit the caller was looking at. GitLab
/// refuses with a 409 if the source branch has moved since — which is the whole
/// point of passing it.
///
/// A refusal keeps GitLab's own words — 405 for a merge request that cannot be
/// merged (closed, draft, pipeline still running under "merge when pipeline
/// succeeds"), 406 for one that conflicts — because `finish` files anything
/// that is not a rate limit or an auth failure as [`ForgeError::Api`] with the
/// body attached.
pub async fn merge_change(
    auth: &ResolvedAuth,
    owner_repo: &str,
    iid: i64,
    method: ForgeMergeMethod,
    head_sha: Option<&str>,
) -> Result<Option<ForgeIssueRow>, ForgeError> {
    let project = project_ref(owner_repo)?;
    if iid <= 0 {
        return Err(ForgeError::Invalid(format!("bad work item number: {iid}")));
    }
    if method == ForgeMergeMethod::Rebase {
        return Err(ForgeError::Invalid(
            "GitLab rebases through its own endpoint; it cannot be a merge method".to_string(),
        ));
    }
    let url = format!(
        "{}/projects/{project}/merge_requests/{iid}/merge",
        auth.api_base
    );
    // `squash` is sent EXPLICITLY either way rather than only when squashing.
    // The project's `squash_option` can default it to on, and omitting the
    // field on a "Merge" would then squash a change whose author asked for the
    // commits to be kept.
    let mut payload = serde_json::json!({ "squash": method == ForgeMergeMethod::Squash });
    if let Some(sha) = head_sha {
        payload["sha"] = serde_json::Value::String(sha.to_string());
    }
    let response = api_put(auth, &url, &payload).await?;

    // Past this line the change HAS landed, so nothing below may return `Err`.
    let raw: Option<RawItem> = response.json().await.ok();
    Ok(raw.map(|raw| raw.into_row(true)))
}

// ── plumbing ────────────────────────────────────────────────────────────────

/// `GET {api_base}/user` → username, cached per `(api_base, account)`.
static LOGIN_CACHE: LazyLock<RwLock<HashMap<String, String>>> =
    LazyLock::new(|| RwLock::new(HashMap::new()));

async fn current_login(auth: &ResolvedAuth) -> Result<String, ForgeError> {
    let cache_key = format!("{}\n{}", auth.api_base, auth.account_id);
    if let Some(hit) = LOGIN_CACHE.read().ok().and_then(|c| c.get(&cache_key).cloned()) {
        return Ok(hit);
    }
    #[derive(Deserialize)]
    struct User {
        username: String,
    }
    let user: User = api_get(auth, &format!("{}/user", auth.api_base))
        .await?
        .json()
        .await
        .map_err(|e| ForgeError::Network(format!("bad /user payload: {e}")))?;
    if let Ok(mut cache) = LOGIN_CACHE.write() {
        cache.insert(cache_key, user.username.clone());
    }
    Ok(user.username)
}

/// `path_with_namespace` of a project id. Best-effort: it only ever improves
/// the wording of a refusal that has already been decided.
async fn project_path(auth: &ResolvedAuth, project_id: i64) -> Option<String> {
    #[derive(Deserialize)]
    struct RawProject {
        #[serde(default)]
        path_with_namespace: String,
    }
    let url = format!("{}/projects/{project_id}", auth.api_base);
    let project: RawProject = api_get(auth, &url).await.ok()?.json().await.ok()?;
    Some(project.path_with_namespace).filter(|p| !p.is_empty())
}

/// `path_with_namespace` → project id — the inverse of [`project_path`], and
/// the one coordinate a cross-project merge request cannot be opened without.
///
/// GitLab takes the SOURCE project of a merge request by id, while everything
/// codeg holds (a remote URL, a folder, a task's recorded fork) is a path. The
/// id is resolved once, at trigger time, and recorded on the task: the list
/// payload the retry path reads names a foreign source project by number alone
/// (see `map_merge_request`), so the delivery needs this same id to turn that
/// placeholder back into a repository.
pub async fn resolve_project_id(
    auth: &ResolvedAuth,
    owner_repo: &str,
) -> Result<i64, ForgeError> {
    #[derive(Deserialize)]
    struct RawProject {
        id: i64,
    }
    let project = project_ref(owner_repo)?;
    let url = format!("{}/projects/{project}", auth.api_base);
    let raw: RawProject = api_get(auth, &url)
        .await?
        .json()
        .await
        .map_err(|e| ForgeError::Network(format!("bad project payload: {e}")))?;
    Ok(raw.id)
}

pub(crate) async fn api_get(
    auth: &ResolvedAuth,
    url: &str,
) -> Result<reqwest::Response, ForgeError> {
    let response = super::http_client()?
        .get(url)
        .header("PRIVATE-TOKEN", &auth.token)
        .header("User-Agent", "codeg")
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|e| ForgeError::Network(e.to_string()))?;
    finish(response).await
}

pub(crate) async fn api_post(
    auth: &ResolvedAuth,
    url: &str,
    body: &serde_json::Value,
) -> Result<reqwest::Response, ForgeError> {
    send(super::http_client()?.post(url), auth, body).await
}

/// Authenticated PUT — how GitLab spells "edit an existing thing" (GitHub uses
/// PATCH for the same operation; neither accepts the other's method).
pub(crate) async fn api_put(
    auth: &ResolvedAuth,
    url: &str,
    body: &serde_json::Value,
) -> Result<reqwest::Response, ForgeError> {
    send(super::http_client()?.put(url), auth, body).await
}

async fn send(
    request: reqwest::RequestBuilder,
    auth: &ResolvedAuth,
    body: &serde_json::Value,
) -> Result<reqwest::Response, ForgeError> {
    let response = request
        .header("PRIVATE-TOKEN", &auth.token)
        .header("User-Agent", "codeg")
        .header("Accept", "application/json")
        .json(body)
        .send()
        .await
        .map_err(|e| ForgeError::Network(e.to_string()))?;
    finish(response).await
}

/// Success through, everything else classified. GitLab signals its rate limit
/// with 429 (and `Retry-After`), never with the 403-plus-quota-header shape
/// GitHub uses — so a 403 here really is about the credential.
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
    Err(match status {
        429 => ForgeError::RateLimited { retry_after },
        401 | 403 => ForgeError::Auth(format!("GitLab returned {status}")),
        404 => ForgeError::NotFound,
        _ => {
            let message = response
                .text()
                .await
                .unwrap_or_default()
                .chars()
                .take(300)
                .collect();
            ForgeError::Api { status, message }
        }
    })
}

/// The project as ONE percent-encoded path segment. `normalize_repo` runs
/// first, so what gets encoded has already been checked for URL
/// metacharacters — the encoding is for the slashes of a subgroup path, not a
/// substitute for validation.
fn project_ref(owner_repo: &str) -> Result<String, ForgeError> {
    let repo = super::normalize_repo(owner_repo)
        .ok_or_else(|| ForgeError::Invalid(format!("bad repository path: {owner_repo}")))?;
    Ok(urlencode_path(&repo))
}

fn collection_of(kind: ForgeItemKind) -> &'static str {
    match kind {
        ForgeItemKind::Issue => "issues",
        ForgeItemKind::Change => "merge_requests",
    }
}

/// Our state filter in GitLab's vocabulary. "closed" asks for everything on
/// the merge-request collection because GitLab's own `closed` excludes merged
/// ones — see [`keeps`] for the other half.
fn wire_state(tab: super::ForgeTab, state: &str) -> &'static str {
    match (tab, state) {
        (_, "open") => "opened",
        (super::ForgeTab::Prs, "closed") => "all",
        (_, "closed") => "closed",
        _ => "all",
    }
}

/// Whether a row survives the filter the API could not fully express. Mirrors
/// [`display_state`]: `locked` DISPLAYS as open, so the closed tab must drop it
/// too — otherwise the merged-inclusive query leaks a row the icon then draws
/// as open into a list of closed ones.
fn keeps(requested: &str, actual: &str) -> bool {
    match requested {
        "closed" => !matches!(actual, "opened" | "locked"),
        _ => true,
    }
}

/// GitLab's `opened`/`locked`/`merged`/`closed` in the three words the rest of
/// codeg (and the workbench row's icon) understands. `merged` survives as
/// itself: it is a real state here, unlike GitHub where it has to be inferred.
fn display_state(state: &str) -> String {
    match state {
        "opened" | "locked" => "open".to_string(),
        "merged" => "merged".to_string(),
        _ => "closed".to_string(),
    }
}

/// Whether a title already declares itself a draft, so it is not prefixed
/// twice. `get(..6)` rather than `[..6]`: a title is arbitrary user text, and
/// slicing bytes through the middle of a code point PANICS — six bytes lands
/// mid-character on plenty of real titles.
fn is_draft_title(title: &str) -> bool {
    title
        .trim_start()
        .get(..6)
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case("draft:"))
}

fn map_merge_request(raw: RawMergeRequest, owner_repo: &str) -> ForgePr {
    let same_project = match (raw.source_project_id, raw.target_project_id) {
        (Some(src), Some(dst)) => src == dst,
        // A payload that does not say cannot be shown to be the source
        // project, and "unknown" must not read as "ours".
        _ => false,
    };
    ForgePr {
        number: raw.iid,
        html_url: raw.web_url,
        state: display_state(&raw.state),
        merged: raw.state == "merged",
        // `diff_refs` is the precise head of the diff under review and is
        // present on the single-merge-request payload; the list payload only
        // carries `sha`, which is the same commit.
        head_sha: raw
            .diff_refs
            .and_then(|d| d.head_sha)
            .filter(|s| !s.is_empty())
            .or(raw.sha)
            .unwrap_or_default(),
        head_ref: raw.source_branch,
        head_repo: if same_project {
            owner_repo.to_string()
        } else {
            // Deliberately not a repository path: `same_repo` rejects it, so
            // every gate reads this as "somewhere else" without having to
            // spend a request to learn the fork's name.
            format!("project-{}", raw.source_project_id.unwrap_or_default())
        },
        base_ref: raw.target_branch,
    }
}

#[derive(Debug, Deserialize)]
struct RawItem {
    iid: i64,
    #[serde(default)]
    title: String,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    state: String,
    /// Merge requests only. GitLab renamed `work_in_progress` to `draft`; old
    /// self-managed instances still send only the former, so both are read.
    #[serde(default)]
    draft: bool,
    #[serde(default)]
    work_in_progress: bool,
    #[serde(default)]
    labels: Vec<RawItemLabel>,
    #[serde(default)]
    author: Option<RawUser>,
    #[serde(default)]
    updated_at: Option<String>,
    #[serde(default)]
    web_url: String,
    /// Human comments. GitLab's own name for it: `notes` also covers the
    /// system events ("changed the milestone"), which nobody wants counted.
    #[serde(default)]
    user_notes_count: i64,
}

impl RawItem {
    /// One issue or merge request, as the workbench row.
    ///
    /// `is_pr` is an argument because the collection the payload came from is
    /// the only thing that says so — an item carries no field distinguishing
    /// the two, and the draft flag only means anything for a merge request.
    fn into_row(self, is_pr: bool) -> ForgeIssueRow {
        ForgeIssueRow {
            is_pr,
            number: self.iid,
            title: self.title,
            body: self.description.map(|b| truncate_chars(&b, BODY_CAP)),
            state: display_state(&self.state),
            draft: is_pr && (self.draft || self.work_in_progress),
            labels: self
                .labels
                .into_iter()
                .filter_map(RawItemLabel::into_label)
                .collect(),
            author_avatar: self
                .author
                .as_ref()
                .and_then(|a| a.avatar_url.as_deref())
                .and_then(sanitize_web_url),
            author: self.author.map(|a| a.username),
            updated_at: self.updated_at,
            html_url: self.web_url,
            comments: self.user_notes_count,
        }
    }
}

/// A label on a collection item, in either shape GitLab may send it.
///
/// With `with_labels_details=true` (which the list URL asks for) each entry is
/// an object carrying the colour; without it — and on any instance old enough
/// to ignore the parameter — it is the bare name. Reading both is what keeps a
/// self-managed GitLab listing at all: a hard-coded object shape would turn
/// every row on such an instance into a deserialization failure.
#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum RawItemLabel {
    Name(String),
    Detail {
        #[serde(default)]
        name: String,
        #[serde(default)]
        color: Option<String>,
    },
}

impl RawItemLabel {
    fn into_label(self) -> Option<ForgeLabel> {
        match self {
            Self::Name(name) => ForgeLabel::parse(name, None),
            Self::Detail { name, color } => ForgeLabel::parse(name, color.as_deref()),
        }
    }
}

#[derive(Debug, Deserialize)]
struct RawUser {
    #[serde(default)]
    username: String,
    /// GitLab hands back a gravatar.com URL for accounts that never uploaded
    /// one, so this can point somewhere outside the instance entirely — the
    /// avatar falls back to initials when it does not load.
    #[serde(default)]
    avatar_url: Option<String>,
}

/// One entry of a `notes` collection.
///
/// `system` is the load-bearing field: GitLab files "changed the milestone"
/// and "assigned to @bob" as notes too, and they are what `user_notes_count`
/// (the number the row shows) leaves out.
#[derive(Debug, Deserialize)]
struct RawNote {
    #[serde(default)]
    id: i64,
    #[serde(default)]
    body: Option<String>,
    /// Defaults to FALSE, which is the safe direction to be wrong in: a
    /// payload missing the field keeps a real comment rather than hiding one.
    #[serde(default)]
    system: bool,
    #[serde(default)]
    author: Option<RawUser>,
    #[serde(default)]
    created_at: Option<String>,
    #[serde(default)]
    updated_at: Option<String>,
}

/// Everything needed to build a note's permalink. GitLab notes carry no web
/// URL of their own, so the anchor on the item's own page is the only link a
/// human can follow — and it is assembled from four values that all four
/// callers (reader and composer, issue and merge request) must agree on.
struct NoteAnchor {
    origin: String,
    /// Lowercased `owner/repo`, as it appears in a web path.
    repo: String,
    /// `issues` | `merge_requests` — the item's WEB segment, which is the same
    /// word as its API collection.
    collection: &'static str,
    iid: i64,
}

impl RawNote {
    fn into_comment(self, anchor: &NoteAnchor) -> ForgeComment {
        ForgeComment {
            author: ForgeComment::author_name(self.author.as_ref().map(|a| a.username.clone())),
            author_avatar: self
                .author
                .as_ref()
                .and_then(|a| a.avatar_url.as_deref())
                .and_then(sanitize_web_url),
            body: truncate_chars(self.body.as_deref().unwrap_or_default(), BODY_CAP),
            updated_at: ForgeComment::edited_at(self.created_at.as_deref(), self.updated_at),
            created_at: self.created_at,
            html_url: Some(format!(
                "{}/{}/-/{}/{}#note_{}",
                anchor.origin, anchor.repo, anchor.collection, anchor.iid, self.id
            )),
            id: self.id.to_string(),
        }
    }
}

/// The SINGLE merge request payload, which carries a good deal the list one
/// does not: the merge status, a head pipeline, and a `changes_count`.
#[derive(Debug, Deserialize)]
struct RawMergeRequestDetail {
    #[serde(default)]
    iid: i64,
    #[serde(default)]
    state: String,
    #[serde(default)]
    draft: bool,
    #[serde(default)]
    work_in_progress: bool,
    #[serde(default)]
    source_branch: String,
    #[serde(default)]
    target_branch: String,
    #[serde(default)]
    sha: Option<String>,
    #[serde(default)]
    diff_refs: Option<RawDiffRefs>,
    #[serde(default)]
    source_project_id: Option<i64>,
    #[serde(default)]
    target_project_id: Option<i64>,
    /// `can_be_merged` | `cannot_be_merged` | `unchecked` | `checking` |
    /// `cannot_be_merged_recheck`.
    #[serde(default)]
    merge_status: Option<String>,
    /// GitLab 15.6+, and it says WHY (`not_approved`, `conflict`,
    /// `ci_still_running`) — absent on older instances.
    #[serde(default)]
    detailed_merge_status: Option<String>,
    #[serde(default)]
    has_conflicts: bool,
    /// A STRING, and suffixed with `+` once the diff hits GitLab's own limit.
    #[serde(default)]
    changes_count: Option<String>,
    #[serde(default)]
    head_pipeline: Option<RawPipeline>,
}

#[derive(Debug, Deserialize)]
struct RawPipeline {
    #[serde(default)]
    id: i64,
}

#[derive(Debug, Deserialize)]
struct RawJob {
    #[serde(default)]
    id: i64,
    #[serde(default)]
    name: String,
    #[serde(default)]
    stage: Option<String>,
    #[serde(default)]
    status: String,
    #[serde(default)]
    web_url: Option<String>,
    /// A job the pipeline is allowed to fail on. Worth carrying: a red
    /// indicator that cannot block anything is a different fact from one that
    /// can, and treating them alike sends people to look at the wrong job.
    #[serde(default)]
    allow_failure: bool,
}

/// One file's entry in `/diffs` (and, identically, in the legacy `/changes`).
#[derive(Debug, Deserialize)]
struct RawDiff {
    #[serde(default)]
    old_path: String,
    #[serde(default)]
    new_path: String,
    #[serde(default)]
    new_file: bool,
    #[serde(default)]
    renamed_file: bool,
    #[serde(default)]
    deleted_file: bool,
    /// The unified diff, as text. GitLab counts nothing per file, so this is
    /// where the `+`/`−` numbers come from — and an EMPTY one is how binary
    /// content arrives (there is nothing textual to send).
    #[serde(default)]
    diff: String,
}

impl RawDiff {
    fn into_file(self) -> ForgeChangedFile {
        let status = if self.new_file {
            ForgeFileStatus::Added
        } else if self.deleted_file {
            ForgeFileStatus::Removed
        } else if self.renamed_file {
            ForgeFileStatus::Renamed
        } else {
            ForgeFileStatus::Modified
        };
        // No hunk to count. Binary content arrives this way — and so does an
        // empty file, which from here is indistinguishable and equally has no
        // line counts to show.
        let binary = self.diff.trim().is_empty();
        let (additions, deletions) = count_diff_lines(&self.diff);
        ForgeChangedFile {
            // The path AFTER the change; GitLab repeats it in `old_path` for a
            // deletion, so this is right for every status.
            path: if self.new_path.is_empty() {
                self.old_path.clone()
            } else {
                self.new_path
            },
            previous_path: (status == ForgeFileStatus::Renamed && !self.old_path.is_empty())
                .then_some(self.old_path),
            status,
            additions: (!binary).then_some(additions),
            deletions: (!binary).then_some(deletions),
            binary,
            // The same text the counters above were counted off. Blank is
            // already what `binary` keys off here, so the two agree by
            // construction: a row with no counts also has nothing to open.
            patch: (!binary).then_some(self.diff),
        }
    }
}

#[derive(Debug, Deserialize)]
struct RawMergeRequest {
    iid: i64,
    #[serde(default)]
    web_url: String,
    /// `opened` | `locked` | `merged` | `closed`.
    #[serde(default)]
    state: String,
    #[serde(default)]
    sha: Option<String>,
    #[serde(default)]
    diff_refs: Option<RawDiffRefs>,
    #[serde(default)]
    source_branch: String,
    #[serde(default)]
    target_branch: String,
    #[serde(default)]
    source_project_id: Option<i64>,
    #[serde(default)]
    target_project_id: Option<i64>,
}

#[derive(Debug, Deserialize)]
struct RawDiffRefs {
    #[serde(default)]
    head_sha: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::forge::ForgeProvider;
    use axum::extract::Query;
    use axum::routing::{get, post};
    use axum::Json;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    fn auth_for(api_base: String) -> ResolvedAuth {
        ResolvedAuth {
            provider: ForgeProvider::GitLab,
            server_host: "gitlab.test".into(),
            api_base,
            account_id: "acc-test".into(),
            username: "alice".into(),
            avatar_url: Some("https://gitlab.test/uploads/alice.png".into()),
            token: "tok-test".into(),
            scopes: vec!["api".into()],
        }
    }

    /// One entry of a `notes` collection. `system` is what separates a comment
    /// somebody wrote from an event GitLab logged; `updated_at` matches
    /// `created_at`, which is how a note that was never edited arrives.
    fn note_json(id: i64, body: &str, system: bool) -> serde_json::Value {
        serde_json::json!({
            "id": id,
            "body": body,
            "system": system,
            "created_at": "2026-08-20T00:00:00Z",
            "updated_at": "2026-08-20T00:00:00Z",
            "author": {
                "username": "alice",
                // GitLab hands out third-party gravatar URLs for accounts with
                // no picture — an `http(s)` one still rides along.
                "avatar_url": "https://gitlab.test/uploads/alice.png",
            },
        })
    }

    fn item_json(iid: i64, state: &str) -> serde_json::Value {
        serde_json::json!({
            "iid": iid,
            "title": format!("item {iid}"),
            "description": format!("body {iid}"),
            "state": state,
            // What `with_labels_details=true` returns — plus one bare name, the
            // shape an instance that ignores the parameter still sends.
            "labels": [{ "name": "bug", "color": "#D9534F" }, "legacy", { "name": "" }],
            "author": {
                "username": "alice",
                "avatar_url": "https://gitlab.test/uploads/alice.png",
            },
            "updated_at": "2026-08-18T00:00:00Z",
            "web_url": format!("https://gitlab.test/group/sub/proj/-/issues/{iid}"),
            "user_notes_count": iid,
        })
    }

    fn mr_json(iid: i64, state: &str, source_project: i64) -> serde_json::Value {
        serde_json::json!({
            "iid": iid,
            "web_url": format!("https://gitlab.test/group/sub/proj/-/merge_requests/{iid}"),
            "state": state,
            "sha": "abc123",
            "source_branch": "feature",
            "target_branch": "main",
            "source_project_id": source_project,
            "target_project_id": 1,
        })
    }

    /// `(api_base, MR-create bodies, note bodies, /user hits, last list query)`.
    /// The last element is what the collection endpoint was actually asked for,
    /// so a test can assert the URL rather than infer it.
    #[allow(clippy::type_complexity)]
    async fn mock_api() -> (
        String,
        Arc<std::sync::Mutex<Vec<serde_json::Value>>>,
        Arc<std::sync::Mutex<Vec<(String, serde_json::Value)>>>,
        Arc<AtomicUsize>,
        Arc<RwLock<HashMap<String, String>>>,
    ) {
        let creates: Arc<std::sync::Mutex<Vec<serde_json::Value>>> = Default::default();
        let notes: Arc<std::sync::Mutex<Vec<(String, serde_json::Value)>>> = Default::default();
        let user_hits = Arc::new(AtomicUsize::new(0));
        let last_query: Arc<RwLock<HashMap<String, String>>> = Default::default();
        let seen = creates.clone();
        // The fork's own create records into the same list from a second
        // closure, so it needs its own handle.
        let fork_seen = creates.clone();
        let issue_notes = notes.clone();
        let mr_notes = notes.clone();
        let hits = user_hits.clone();
        let issue_query = last_query.clone();
        let mr_query = last_query.clone();
        let issue_notes_query = last_query.clone();
        // The project path arrives percent-encoded, so it is ONE segment.
        let app = axum::Router::new()
            .route(
                "/projects/group%2Fsub%2Fproj/issues",
                get(move |Query(q): Query<HashMap<String, String>>| async move {
                    if let Ok(mut slot) = issue_query.write() {
                        *slot = q.clone();
                    }
                    let page: u32 =
                        q.get("page").and_then(|p| p.parse().ok()).unwrap_or(1);
                    let mut headers = axum::http::HeaderMap::new();
                    // 3 matches over 2 pages — the shape GitLab sends when it
                    // is willing to count.
                    headers.insert("x-total", "3".parse().unwrap());
                    headers.insert("x-total-pages", "2".parse().unwrap());
                    headers.insert(
                        "x-next-page",
                        if page < 2 { "2" } else { "" }.parse().unwrap(),
                    );
                    let rows = if q.get("assignee_username").map(String::as_str) == Some("alice") {
                        vec![item_json(9, "opened")]
                    } else if page >= 2 {
                        vec![item_json(3, "opened")]
                    } else {
                        vec![item_json(1, "opened")]
                    };
                    (headers, Json(serde_json::Value::Array(rows)))
                }),
            )
            // The project itself — what `resolve_project_id` reads, and the id
            // a cross-project merge request is opened with.
            .route(
                "/projects/group%2Fsub%2Fproj",
                get(|| async { Json(serde_json::json!({ "id": 4711 })) }),
            )
            .route(
                "/projects/group%2Fsub%2Fproj/merge_requests",
                get(move |Query(q): Query<HashMap<String, String>>| async move {
                    if let Ok(mut slot) = mr_query.write() {
                        *slot = q.clone();
                    }
                    let mut headers = axum::http::HeaderMap::new();
                    // A count IS sent — the client must still refuse to trust
                    // it for the locally-filtered "closed" query.
                    headers.insert("x-total", "3".parse().unwrap());
                    headers.insert("x-next-page", "".parse().unwrap());
                    let rows = match q.get("source_branch").map(String::as_str) {
                        Some("feature") => vec![mr_json(4, "opened", 1)],
                        Some(_) => vec![],
                        // The tab listing: `state=all` is what the "closed"
                        // filter asks for, and it comes back merged + open.
                        // A draft rides along so the row mapping is covered.
                        None => {
                            let mut draft = mr_json(6, "opened", 1);
                            draft["draft"] = serde_json::json!(true);
                            vec![
                                mr_json(5, "merged", 1),
                                draft,
                                mr_json(7, "closed", 1),
                                mr_json(11, "locked", 1),
                            ]
                        }
                    };
                    (headers, Json(serde_json::Value::Array(rows)))
                })
                .post(move |Json(body): Json<serde_json::Value>| {
                    seen.lock().unwrap().push(body);
                    async { Json(mr_json(8, "opened", 1)) }
                }),
            )
            // A merge request created ON a fork: the project in the path owns
            // the branch, the target is named in the body. The payload that
            // comes back names the fork by number alone, which is what the
            // claim path has to turn back into a repository.
            .route(
                "/projects/4712/merge_requests",
                post(move |Json(body): Json<serde_json::Value>| {
                    fork_seen.lock().unwrap().push(body);
                    async {
                        let mut mr = mr_json(9, "opened", 4712);
                        mr["target_project_id"] = serde_json::json!(4711);
                        Json(mr)
                    }
                }),
            )
            .route(
                "/projects/group%2Fsub%2Fproj/merge_requests/4",
                get(|| async {
                    let mut mr = mr_json(4, "opened", 1);
                    mr["diff_refs"] = serde_json::json!({ "head_sha": "deadbee" });
                    Json(mr)
                }),
            )
            .route(
                "/projects/group%2Fsub%2Fproj/merge_requests/9",
                get(|| async { Json(mr_json(9, "opened", 42)) }),
            )
            .route(
                "/projects/42",
                get(|| async {
                    Json(serde_json::json!({ "path_with_namespace": "contributor/proj" }))
                }),
            )
            .route(
                "/projects/group%2Fsub%2Fproj/issues/7/notes",
                post(move |Json(body): Json<serde_json::Value>| {
                    issue_notes.lock().unwrap().push(("issues".to_string(), body));
                    async { Json(serde_json::json!({ "id": 55 })) }
                })
                // The read side. Both pages mix system events into the same
                // collection, which is exactly what `user_notes_count` leaves
                // out — and page 2 holds NOTHING else, the case that proves
                // `has_next` cannot be inferred from how many rows survived.
                .get(move |Query(q): Query<HashMap<String, String>>| async move {
                    if let Ok(mut slot) = issue_notes_query.write() {
                        *slot = q.clone();
                    }
                    let page: u32 = q.get("page").and_then(|p| p.parse().ok()).unwrap_or(1);
                    let mut headers = axum::http::HeaderMap::new();
                    headers.insert(
                        "x-next-page",
                        if page < 3 { "2" } else { "" }.parse().unwrap(),
                    );
                    let rows = if page >= 2 {
                        vec![note_json(103, "changed the milestone", true)]
                    } else {
                        let mut edited = note_json(102, "reworded", false);
                        edited["updated_at"] = serde_json::json!("2026-08-20T09:00:00Z");
                        // An account that is gone: GitLab sends no author at all.
                        let mut orphan = note_json(104, "from a deleted user", false);
                        orphan["author"] = serde_json::Value::Null;
                        vec![
                            note_json(100, "assigned to @bob", true),
                            note_json(101, "cannot reproduce", false),
                            edited,
                            orphan,
                        ]
                    };
                    (headers, Json(serde_json::Value::Array(rows)))
                }),
            )
            .route(
                "/projects/group%2Fsub%2Fproj/merge_requests/7/notes",
                post(move |Json(body): Json<serde_json::Value>| {
                    mr_notes.lock().unwrap().push(("merge_requests".to_string(), body));
                    async { Json(serde_json::json!({ "id": 66 })) }
                })
                .get(|| async {
                    let mut headers = axum::http::HeaderMap::new();
                    headers.insert("x-next-page", "".parse().unwrap());
                    (
                        headers,
                        Json(serde_json::json!([note_json(201, "looks good", false)])),
                    )
                }),
            )
            .route(
                "/user",
                get(move || {
                    hits.fetch_add(1, Ordering::SeqCst);
                    async { Json(serde_json::json!({ "username": "alice" })) }
                }),
            )
            .route(
                "/projects/group%2Fsub%2Fproj/labels",
                get(|Query(q): Query<HashMap<String, String>>| async move {
                    // Counts are an extra per-label aggregation server-side and
                    // nothing here shows them.
                    assert_eq!(q.get("with_counts").map(String::as_str), Some("false"));
                    Json(serde_json::json!([
                        { "name": "bug", "color": "#D9534F" },
                        // GitLab accepts CSS colour names when a label is
                        // written, so a stored colour need not be hex at all.
                        { "name": "help wanted", "color": "rebeccapurple" },
                        { "name": "" },
                    ]))
                }),
            )
            .route(
                "/limited/projects/group%2Fsub%2Fproj/issues",
                get(|| async {
                    let mut headers = axum::http::HeaderMap::new();
                    headers.insert("retry-after", "17".parse().unwrap());
                    (
                        axum::http::StatusCode::TOO_MANY_REQUESTS,
                        headers,
                        Json(serde_json::json!({ "message": "slow down" })),
                    )
                }),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        (format!("http://{addr}"), creates, notes, user_hits, last_query)
    }

    fn req(tab: super::super::ForgeTab, state: &str) -> ListIssuesRequest {
        ListIssuesRequest {
            owner_repo: "Group/Sub/Proj".into(),
            tab,
            state: state.into(),
            assigned_me: false,
            labels: vec![],
            search: None,
            sort: ForgeSort::default(),
            page: 1,
            per_page: 20,
        }
    }

    /// A subgroup path is ONE percent-encoded segment; anything else addresses
    /// a route that does not exist. The row shape (iid, description, GitLab's
    /// `opened`) is normalized to what the workbench renders.
    #[tokio::test]
    async fn issues_come_from_the_encoded_project_path() {
        let (api_base, _, _, _, _) = mock_api().await;
        let auth = auth_for(api_base.clone());
        let list = list_issues(&auth, &req(super::super::ForgeTab::Issues, "open"))
            .await
            .expect("list");
        assert_eq!(list.rows.len(), 1);
        let row = &list.rows[0];
        assert_eq!((row.number, row.state.as_str()), (1, "open"));
        assert_eq!(row.body.as_deref(), Some("body 1"));
        // The empty label is dropped; a detailed one keeps its colour and a
        // bare one still lists, just without a swatch.
        assert_eq!(
            row.labels,
            vec![
                ForgeLabel { name: "bug".into(), color: Some("#d9534f".into()) },
                ForgeLabel { name: "legacy".into(), color: None },
            ]
        );
        assert_eq!(row.author.as_deref(), Some("alice"));
        // Rides along with the list row — the panel's author avatar costs no
        // request of its own.
        assert_eq!(
            row.author_avatar.as_deref(),
            Some("https://gitlab.test/uploads/alice.png")
        );
        assert!(!row.is_pr);

        // Offset pagination: `X-Total` is the count and `X-Next-Page` is what
        // says whether another page exists.
        assert_eq!((list.page, list.per_page), (1, 20));
        assert_eq!(list.total_count, Some(3));
        assert!(list.has_next);

        let page2 = list_issues(
            &auth,
            &ListIssuesRequest { page: 2, ..req(super::super::ForgeTab::Issues, "open") },
        )
        .await
        .expect("page 2");
        assert_eq!(page2.rows[0].number, 3);
        // Empty `X-Next-Page` is GitLab's end-of-list, not a missing header.
        assert!(!page2.has_next);
    }

    /// GitLab's `state=closed` excludes merged merge requests. The workbench's
    /// closed tab has to show them (GitHub's does), so the query asks for
    /// everything and the open ones are dropped here.
    ///
    /// That local narrowing is exactly why this query must report NO total: the
    /// `X-Total` the server sends counts the open rows the user cannot see, so
    /// page numbers built from it would be wrong. `locked` displays as open, so
    /// it is dropped alongside `opened` — otherwise the closed tab would show a
    /// row the icon then draws green.
    #[tokio::test]
    async fn the_closed_tab_shows_merged_and_withholds_the_untrustworthy_total() {
        let (api_base, _, _, _, _) = mock_api().await;
        let auth = auth_for(api_base);
        let list = list_issues(&auth, &req(super::super::ForgeTab::Prs, "closed"))
            .await
            .expect("list");
        assert_eq!(
            list.rows.iter().map(|r| r.number).collect::<Vec<_>>(),
            vec![5, 7],
            "merged and closed, but neither the open nor the locked one"
        );
        assert!(list.rows.iter().all(|r| r.is_pr));
        // `merged` survives as itself now — the icon draws it differently.
        assert_eq!(list.rows[0].state, "merged");
        assert_eq!(list.rows[1].state, "closed");
        assert_eq!(
            list.total_count, None,
            "a count that includes rows we filtered out must not be shown"
        );
        assert_eq!(wire_state(super::super::ForgeTab::Prs, "closed"), "all");
        // Issues have no merged state, so theirs stays a plain closed query —
        // nothing is filtered locally, so its count IS trustworthy.
        assert_eq!(wire_state(super::super::ForgeTab::Issues, "closed"), "closed");
        let issues = list_issues(&auth, &req(super::super::ForgeTab::Issues, "closed"))
            .await
            .expect("list");
        assert_eq!(issues.total_count, Some(3));
    }

    /// The open tab is a plain `state=opened` query, so its count is honest —
    /// and a draft merge request has to arrive marked as one.
    #[tokio::test]
    async fn the_open_tab_counts_and_carries_the_draft_flag() {
        let (api_base, _, _, _, _) = mock_api().await;
        let auth = auth_for(api_base);
        let list = list_issues(&auth, &req(super::super::ForgeTab::Prs, "open"))
            .await
            .expect("list");
        assert_eq!(list.total_count, Some(3), "no local filtering on this one");
        // GitLab paginates the whole collection: nothing is out of reach, so
        // the footer's page numbers come straight from the total. Only GitHub
        // search has a ceiling to declare.
        assert_eq!(list.reachable_count, None);
        assert_eq!(list.trustworthy_count(), Some(3));
        let draft = list.rows.iter().find(|r| r.number == 6).expect("draft row");
        assert!(draft.draft && draft.state == "open");
        assert!(
            list.rows.iter().filter(|r| r.number != 6).all(|r| !r.draft),
            "draft must not spill onto the other rows"
        );
    }

    /// Search text, labels and the sort order all reach the collection URL.
    /// Unlike GitHub there is no query syntax to strip — `search` is plain text
    /// over title and description — but the params still have to be there.
    #[tokio::test]
    async fn text_label_and_sort_filters_reach_the_url() {
        let (api_base, _, _, _, last) = mock_api().await;
        let auth = auth_for(api_base);
        list_issues(
            &auth,
            &ListIssuesRequest {
                labels: vec!["bug".into(), "help wanted".into()],
                search: Some("login timeout".into()),
                sort: ForgeSort::LeastRecentlyUpdated,
                ..req(super::super::ForgeTab::Issues, "open")
            },
        )
        .await
        .expect("list");
        let sent = last.read().unwrap().clone();
        // Comma-joined: GitLab forbids commas in label titles, so nothing splits.
        assert_eq!(sent.get("labels").map(String::as_str), Some("bug,help wanted"));
        assert_eq!(sent.get("search").map(String::as_str), Some("login timeout"));
        // The scope the box promises, stated rather than inherited: it happens
        // to be GitLab's default too, and a promise resting on somebody else's
        // default is one release away from being wrong.
        assert_eq!(sent.get("in").map(String::as_str), Some("title,description"));
        assert_eq!(sent.get("order_by").map(String::as_str), Some("updated_at"));
        assert_eq!(sent.get("sort").map(String::as_str), Some("asc"));
        // Without this the rows come back with bare label NAMES and every chip
        // in the workbench is grey.
        assert_eq!(sent.get("with_labels_details").map(String::as_str), Some("true"));

        // The default order, and GitLab's spelling of GitHub's `created`.
        list_issues(&auth, &req(super::super::ForgeTab::Issues, "open"))
            .await
            .expect("list");
        let plain = last.read().unwrap().clone();
        assert_eq!(plain.get("order_by").map(String::as_str), Some("created_at"));
        assert_eq!(plain.get("sort").map(String::as_str), Some("desc"));
        // Absent filters are absent params, not empty ones — `labels=` matches
        // items with no labels at all on some GitLab versions. `in` belongs to
        // the text and goes with it.
        assert!(
            !plain.contains_key("labels")
                && !plain.contains_key("search")
                && !plain.contains_key("in")
        );
    }

    /// `user_notes_count`, not `notes`: the latter counts the system events
    /// ("changed the milestone"), which is not what a discussion badge means.
    #[tokio::test]
    async fn rows_carry_the_human_comment_count() {
        let (api_base, _, _, _, _) = mock_api().await;
        let auth = auth_for(api_base);
        let list = list_issues(&auth, &req(super::super::ForgeTab::Issues, "open"))
            .await
            .expect("list");
        assert_eq!(list.rows[0].comments, 1);
    }

    /// The label vocabulary for the filter, from the project's own labels.
    #[tokio::test]
    async fn project_labels_are_listed() {
        let (api_base, _, _, _, _) = mock_api().await;
        let auth = auth_for(api_base);
        let list = list_labels(&auth, "Group/Sub/Proj").await.expect("labels");
        assert_eq!(
            list.labels,
            vec![
                ForgeLabel { name: "bug".into(), color: Some("#d9534f".into()) },
                // Unrecognized colour → no colour, not a dropped label.
                ForgeLabel { name: "help wanted".into(), color: None },
            ],
            "empty name dropped"
        );
        assert!(!list.truncated, "three of a hundred is not a full page");
        assert!(list_labels(&auth, "no-slash").await.is_err());
    }

    /// `notes` is not "comments": GitLab files its own events there too, and
    /// they are exactly what `user_notes_count` — the number the row shows —
    /// leaves out. Dropping them here is what keeps the thread and the count
    /// above it describing the same thing.
    ///
    /// The order has to be ASKED for: GitLab's own default for notes is
    /// descending, which would read the conversation backwards and make "load
    /// more" append older comments under newer ones.
    #[tokio::test]
    async fn notes_drop_the_system_events_and_read_oldest_first() {
        let (api_base, _, _, _, last_query) = mock_api().await;
        let auth = auth_for(api_base);

        let page = list_notes(&auth, "Group/Sub/Proj", ForgeItemKind::Issue, 7, 1, 20)
            .await
            .expect("notes");
        let ids: Vec<&str> = page.comments.iter().map(|c| c.id.as_str()).collect();
        assert_eq!(ids, vec!["101", "102", "104"], "the system events are gone");
        assert_eq!((page.page, page.per_page), (1, 20));

        {
            let sent = last_query.read().unwrap();
            assert_eq!(sent.get("order_by").map(String::as_str), Some("created_at"));
            assert_eq!(sent.get("sort").map(String::as_str), Some("asc"));
            assert_eq!(sent.get("page").map(String::as_str), Some("1"));
            assert_eq!(sent.get("per_page").map(String::as_str), Some("20"));
        }

        let first = &page.comments[0];
        assert_eq!(first.author.as_deref(), Some("alice"));
        assert_eq!(first.body, "cannot reproduce");
        assert_eq!(
            first.author_avatar.as_deref(),
            Some("https://gitlab.test/uploads/alice.png")
        );
        // Notes carry no web URL of their own — the same anchor `create_note`
        // hands back, built from the WEB origin rather than the API base.
        assert_eq!(
            first.html_url.as_deref(),
            Some("https://gitlab.test/group/sub/proj/-/issues/7#note_101")
        );
        // Stamped on creation, so not an edit; the reworded one keeps its mark.
        assert_eq!(first.updated_at, None);
        assert_eq!(
            page.comments[1].updated_at.as_deref(),
            Some("2026-08-20T09:00:00Z")
        );
        // A note whose author is gone leaves no name rather than an empty one.
        assert_eq!(page.comments[2].author, None);
        assert_eq!(page.comments[2].author_avatar, None);
    }

    /// The row's avatar goes through the same gate a note's does — it lands in
    /// the same `<img src>`, so a `javascript:` URL is dropped rather than
    /// forwarded, and an author GitLab no longer has leaves no picture at all.
    #[test]
    fn a_rows_avatar_is_sanitized_like_a_notes() {
        let row_for = |author: serde_json::Value| {
            let mut raw = item_json(1, "opened");
            raw["author"] = author;
            serde_json::from_value::<RawItem>(raw).expect("item").into_row(false)
        };

        let ok = row_for(serde_json::json!({ "username": "alice", "avatar_url": "https://a.test/1" }));
        assert_eq!(ok.author.as_deref(), Some("alice"));
        assert_eq!(ok.author_avatar.as_deref(), Some("https://a.test/1"));

        let hostile = row_for(
            serde_json::json!({ "username": "alice", "avatar_url": "javascript:alert(1)" }),
        );
        assert_eq!(hostile.author.as_deref(), Some("alice"), "the name still stands");
        assert_eq!(hostile.author_avatar, None);

        // A picture GitLab did not send, and an account it no longer has.
        assert_eq!(row_for(serde_json::json!({ "username": "alice" })).author_avatar, None);
        let gone = row_for(serde_json::Value::Null);
        assert_eq!((gone.author, gone.author_avatar), (None, None));
    }

    /// `has_next` is the FORGE's answer, not "did anything survive filtering".
    /// A page of nothing but system events is empty of comments and still has
    /// the rest of the discussion behind it — inferring from the row count
    /// would end the thread there.
    #[tokio::test]
    async fn a_page_of_only_system_events_still_reports_more() {
        let (api_base, _, _, _, _) = mock_api().await;
        let auth = auth_for(api_base);

        let second = list_notes(&auth, "group/sub/proj", ForgeItemKind::Issue, 7, 2, 20)
            .await
            .expect("notes");
        assert!(second.comments.is_empty(), "the page held only system events");
        assert!(second.has_next, "…and the discussion continues");

        let last = list_notes(&auth, "group/sub/proj", ForgeItemKind::Issue, 7, 3, 20)
            .await
            .expect("notes");
        assert!(!last.has_next, "empty x-next-page ends the thread");
    }

    /// Issue notes and merge-request notes are DIFFERENT collections over
    /// DIFFERENT numbering — the same rule the write side follows. Reading the
    /// wrong one does not fail loudly; it answers with a real item's
    /// discussion that is not the one on screen.
    #[tokio::test]
    async fn notes_are_read_from_the_collection_the_item_belongs_to() {
        let (api_base, _, _, _, _) = mock_api().await;
        let auth = auth_for(api_base);

        let mr = list_notes(&auth, "group/sub/proj", ForgeItemKind::Change, 7, 1, 20)
            .await
            .expect("mr notes");
        assert_eq!(mr.comments.len(), 1);
        assert_eq!(mr.comments[0].body, "looks good");
        assert_eq!(
            mr.comments[0].html_url.as_deref(),
            Some("https://gitlab.test/group/sub/proj/-/merge_requests/7#note_201")
        );

        // Coordinates a client made up must not reach the API at all.
        assert!(list_notes(&auth, "no-slash", ForgeItemKind::Issue, 7, 1, 20)
            .await
            .is_err());
        assert!(list_notes(&auth, "group/sub/proj", ForgeItemKind::Issue, 0, 1, 20)
            .await
            .is_err());
    }

    #[tokio::test]
    async fn assigned_me_resolves_the_login_once() {
        let (api_base, _, _, user_hits, _) = mock_api().await;
        let auth = auth_for(api_base);
        let request = ListIssuesRequest {
            assigned_me: true,
            ..req(super::super::ForgeTab::Issues, "open")
        };
        assert_eq!(
            list_issues(&auth, &request).await.unwrap().rows[0].number,
            9
        );
        assert_eq!(list_issues(&auth, &request).await.unwrap().rows.len(), 1);
        assert_eq!(user_hits.load(Ordering::SeqCst), 1, "login cached");
    }

    /// The single-merge-request payload is what a task is checked out from:
    /// `diff_refs.head_sha` wins over `sha`, and a fork's real path is
    /// resolved so the refusal can name it.
    #[tokio::test]
    async fn a_merge_request_is_looked_up_by_iid() {
        let (api_base, _, _, _, _) = mock_api().await;
        let auth = auth_for(api_base);
        let mr = get_merge_request(&auth, "Group/Sub/Proj", 4).await.expect("mr");
        assert_eq!((mr.number, mr.head_ref.as_str(), mr.base_ref.as_str()), (4, "feature", "main"));
        assert_eq!(mr.head_sha, "deadbee", "diff_refs wins over sha");
        assert_eq!(mr.state, "open");
        assert!(!mr.merged);
        // Same project: the head repository IS this repository, which is what
        // every same_repo gate downstream asks.
        assert!(super::super::same_repo(&mr.head_repo, "group/sub/proj"));

        let fork = get_merge_request(&auth, "group/sub/proj", 9).await.expect("mr");
        assert_eq!(fork.head_repo, "contributor/proj", "fork path resolved for the message");
        assert!(!super::super::same_repo(&fork.head_repo, "group/sub/proj"));

        assert!(get_merge_request(&auth, "group/sub/proj", 0).await.is_err());
        assert!(get_merge_request(&auth, "not-a-path", 4).await.is_err());
    }

    /// The path → id lookup a trigger performs, and the cross-project body it
    /// The shape of a cross-project merge request, which the live API settled:
    /// the request is ADDRESSED to the fork — GitLab resolves `source_branch`
    /// in the project in the path, so addressing the target while naming the
    /// fork answers `source_branch does not exist` — and the target is named in
    /// the body. Omitting that does not fall back to the fork's upstream: it
    /// makes the fork its own target.
    #[tokio::test]
    async fn a_cross_project_merge_request_is_created_on_the_fork() {
        let (api_base, creates, _, _, _) = mock_api().await;
        let auth = auth_for(api_base);

        assert_eq!(
            resolve_project_id(&auth, "Group/Sub/Proj").await.expect("id"),
            4711,
            "the path is asked for exactly as the API spells it"
        );
        // A path this token cannot see (or that is not a path at all) is an
        // error, never a silent 0 — the trigger refuses the task on it.
        assert!(resolve_project_id(&auth, "not-a-path").await.is_err());

        let made = create_merge_request(
            &auth,
            "group/sub/proj",
            &NewPullRequest {
                source_project_id: Some(4712),
                target_project_id: Some(4711),
                title: "From the fork",
                head: "task/7",
                base: "main",
                body: "",
                draft: false,
            },
        )
        .await
        .expect("create");
        assert_eq!(made.number, 9);
        let sent = creates.lock().unwrap().first().cloned().unwrap();
        assert_eq!(sent["target_project_id"], 4711);
        assert_eq!(sent["source_branch"], "task/7", "the branch stays bare");
        assert!(sent.get("source_project_id").is_none(), "{sent}");
        // And what the target's own list will say about it: a number where a
        // repository name belongs, which only the recorded fork id can turn
        // back into one.
        assert_eq!(made.head_repo, "project-4712");
        assert_eq!(
            made.clone().with_resolved_head(Some(4712), "me/fork").head_repo,
            "me/fork"
        );
        assert_eq!(
            made.with_resolved_head(Some(999), "someone/else").head_repo,
            "project-4712",
            "another fork's merge request is not this task's"
        );
    }

    /// The delivery's lookup: by source branch, in any state, mapped into the
    /// same shape the four-way match already knows.
    #[tokio::test]
    async fn merge_requests_are_found_by_source_branch() {
        let (api_base, _, _, _, _) = mock_api().await;
        let auth = auth_for(api_base);
        let found = find_merge_requests(&auth, "group/sub/proj", "feature")
            .await
            .expect("find");
        assert_eq!(found.len(), 1);
        assert_eq!((found[0].number, found[0].head_sha.as_str()), (4, "abc123"));
        assert!(find_merge_requests(&auth, "group/sub/proj", "other")
            .await
            .unwrap()
            .is_empty());
    }

    /// GitLab has no `draft` parameter — the title carries it, which is also
    /// how its own UI models a draft.
    #[tokio::test]
    async fn a_draft_merge_request_is_a_prefixed_title() {
        let (api_base, creates, _, _, _) = mock_api().await;
        let auth = auth_for(api_base);
        let made = create_merge_request(
            &auth,
            "group/sub/proj",
            &NewPullRequest {
                source_project_id: None,
                target_project_id: None,
                title: "Fix #7",
                head: "task/7",
                base: "main",
                body: "Closes #7",
                draft: true,
            },
        )
        .await
        .expect("create");
        assert_eq!(made.number, 8);
        let sent = creates.lock().unwrap().first().cloned().unwrap();
        assert_eq!(sent["source_branch"], "task/7");
        assert_eq!(sent["target_branch"], "main");
        assert_eq!(sent["title"], "Draft: Fix #7");
        assert_eq!(sent["description"], "Closes #7");
        // A SAME-project merge request must not name a source project: GitLab
        // reads that field as "the branch lives over there".
        assert!(sent.get("source_project_id").is_none(), "{sent}");

        // Not a draft, and an already-prefixed title is not prefixed twice.
        create_merge_request(
            &auth,
            "group/sub/proj",
            &NewPullRequest {
                source_project_id: None,
                target_project_id: None,
                title: "Draft: Fix #7",
                head: "task/7",
                base: "main",
                body: "",
                draft: true,
            },
        )
        .await
        .unwrap();
        assert_eq!(creates.lock().unwrap()[1]["title"], "Draft: Fix #7");
        assert!(is_draft_title("  draft: x") && !is_draft_title("drafts"));
        // Titles are arbitrary user text. Byte six lands in the middle of a
        // character here, which a byte slice would panic on.
        assert!(!is_draft_title("修a复登录"));
        assert!(!is_draft_title("修"));
        assert!(!is_draft_title(""));
    }

    /// Issue notes and merge-request notes are DIFFERENT endpoints; sending
    /// one to the other is a 404 against a number that exists in the other
    /// collection.
    #[tokio::test]
    async fn notes_go_to_the_collection_the_item_belongs_to() {
        let (api_base, _, notes, _, _) = mock_api().await;
        let auth = auth_for(api_base);
        let issue_note = create_note(&auth, "Group/Sub/Proj", ForgeItemKind::Issue, 7, "done")
            .await
            .expect("issue note");
        let mr_note = create_note(&auth, "group/sub/proj", ForgeItemKind::Change, 7, "done")
            .await
            .expect("mr note");
        let sent = notes.lock().unwrap().clone();
        assert_eq!(sent[0].0, "issues");
        assert_eq!(sent[0].1["body"], "done");
        assert_eq!(sent[1].0, "merge_requests");
        // A note has no URL of its own; the anchor on the item's page does.
        let issue_url = issue_note.html_url.clone().expect("issue anchor");
        let mr_url = mr_note.html_url.clone().expect("mr anchor");
        assert!(issue_url.ends_with("/group/sub/proj/-/issues/7#note_55"), "{issue_url}");
        assert!(mr_url.ends_with("/group/sub/proj/-/merge_requests/7#note_66"), "{mr_url}");
        // The composer gets the whole comment back, not just a link — it is
        // appended to the thread on screen without re-fetching the page, so it
        // has to be the SAME shape the reader produces.
        assert_eq!(issue_note.id, "55");
        assert_eq!(mr_note.id, "66");

        assert!(create_note(&auth, "not-a-path", ForgeItemKind::Issue, 7, "x").await.is_err());
        assert!(create_note(&auth, "group/sub/proj", ForgeItemKind::Issue, 0, "x").await.is_err());
    }

    #[tokio::test]
    async fn rate_limits_are_told_apart_from_auth_failures() {
        let (api_base, _, _, _, _) = mock_api().await;
        let auth = auth_for(format!("{api_base}/limited"));
        match list_issues(&auth, &req(super::super::ForgeTab::Issues, "open")).await {
            Err(ForgeError::RateLimited { retry_after }) => assert_eq!(retry_after, Some(17)),
            other => panic!("expected RateLimited, got {other:?}"),
        }
    }

    /// Every request URL is now built here from the resolved api_base, so the
    /// only thing the client still supplies is coordinates — and a project path
    /// it made up must be refused rather than turned into a URL.
    #[tokio::test]
    async fn a_crafted_project_path_is_rejected() {
        let (api_base, _, _, _, _) = mock_api().await;
        let auth = auth_for(api_base);
        for bad in ["no-slash", "acme/app?x=1", "http://169.254.169.254/latest"] {
            let hostile = ListIssuesRequest {
                owner_repo: bad.into(),
                ..req(super::super::ForgeTab::Issues, "open")
            };
            assert!(
                matches!(list_issues(&auth, &hostile).await, Err(ForgeError::Invalid(_))),
                "{bad} should be refused"
            );
        }
    }

    #[test]
    fn project_paths_become_one_encoded_segment() {
        assert_eq!(project_ref("Group/Sub/Proj").unwrap(), "group%2Fsub%2Fproj");
        assert_eq!(project_ref("acme/app.git").unwrap(), "acme%2Fapp");
        assert!(project_ref("no-slash").is_err());
        assert!(project_ref("acme/app?x=1").is_err());
    }

    /// A payload that does not say which project the source lives in cannot be
    /// shown to be ours — "unknown" must not read as "same repository".
    #[test]
    fn an_unstated_source_project_is_not_this_repository() {
        let raw: RawMergeRequest =
            serde_json::from_value(mr_json(3, "opened", 1)).expect("parse");
        assert!(super::super::same_repo(
            &map_merge_request(raw, "group/proj").head_repo,
            "group/proj"
        ));
        let mut bare = mr_json(3, "opened", 1);
        bare["source_project_id"] = serde_json::Value::Null;
        let raw: RawMergeRequest = serde_json::from_value(bare).expect("parse");
        let mapped = map_merge_request(raw, "group/proj");
        assert!(!super::super::same_repo(&mapped.head_repo, "group/proj"));
    }

    // ── writes and change detail ────────────────────────────────────────────

    /// `(method, path, body)` per write. The METHOD is asserted because GitLab
    /// edits with PUT where GitHub uses PATCH, and neither accepts the other's.
    type Writes = Arc<std::sync::Mutex<Vec<(String, String, serde_json::Value)>>>;

    /// A second mock, covering the write and merge-request-detail surface.
    async fn mock_write_api() -> (String, Writes) {
        use axum::extract::Path;
        use axum::routing::put;
        let writes: Writes = Arc::new(std::sync::Mutex::new(Vec::new()));

        let w = writes.clone();
        let edit_issue = put(
            move |Path(iid): Path<i64>, Json(body): Json<serde_json::Value>| {
                let w = w.clone();
                async move {
                    w.lock().unwrap().push((
                        "PUT".into(),
                        format!("issues/{iid}"),
                        body.clone(),
                    ));
                    let mut item = item_json(iid, "closed");
                    // A single item's labels arrive as bare NAMES — the colours
                    // only ever come with `with_labels_details`, which is a
                    // list-endpoint parameter.
                    item["labels"] = serde_json::json!(["bug", "docs"]);
                    Json(item)
                }
            },
        );

        let w = writes.clone();
        let edit_mr = put(
            move |Path(iid): Path<i64>, Json(body): Json<serde_json::Value>| {
                let w = w.clone();
                async move {
                    w.lock().unwrap().push((
                        "PUT".into(),
                        format!("merge_requests/{iid}"),
                        body.clone(),
                    ));
                    let mut item = item_json(iid, "closed");
                    item["draft"] = serde_json::json!(true);
                    Json(item)
                }
            },
        );

        let w = writes.clone();
        let new_issue = post(move |Json(body): Json<serde_json::Value>| {
            let w = w.clone();
            async move {
                w.lock()
                    .unwrap()
                    .push(("POST".into(), "issues".into(), body.clone()));
                let mut item = item_json(123, "opened");
                item["title"] = body["title"].clone();
                Json(item)
            }
        });

        let w = writes.clone();
        let merge_mr = put(
            move |Path(iid): Path<i64>, Json(body): Json<serde_json::Value>| {
                let w = w.clone();
                async move {
                    w.lock().unwrap().push((
                        "PUT".into(),
                        format!("merge_requests/{iid}/merge"),
                        body.clone(),
                    ));
                    // GitLab answers with the merge request ITSELF, which is
                    // why this needs no second request the way GitHub's does.
                    Json(item_json(iid, "merged"))
                }
            },
        );

        let project_settings = |merge_method: &'static str, squash: &'static str| {
            get(move || async move {
                Json(serde_json::json!({
                    "merge_method": merge_method,
                    "squash_option": squash,
                }))
            })
        };

        let app = axum::Router::new()
            .route("/projects/group%2Fsub%2Fproj/issues/{iid}", edit_issue)
            .route("/projects/group%2Fsub%2Fproj/merge_requests/{iid}", edit_mr)
            .route(
                "/projects/group%2Fsub%2Fproj/merge_requests/{iid}/merge",
                merge_mr,
            )
            .route("/projects/group%2Fsub%2Fproj/issues", new_issue)
            .route(
                "/projects/group%2Fsub%2Fproj",
                project_settings("merge", "default_on"),
            )
            .route("/projects/acme%2Falways", project_settings("ff", "always"))
            .route("/projects/acme%2Fnever", project_settings("merge", "never"))
            // An instance too old to report either key. Nothing is known, so
            // nothing is claimed — see `ForgeMergeOptions::unknown`.
            .route("/projects/acme%2Flegacy", get(|| async { Json(serde_json::json!({})) }))
            .route(
                "/detail/projects/group%2Fsub%2Fproj/merge_requests/4",
                get(|| async {
                    Json(serde_json::json!({
                        "iid": 4,
                        "state": "opened",
                        "work_in_progress": true,
                        "source_branch": "fix/timeout",
                        "target_branch": "main",
                        "sha": "cafe123",
                        "diff_refs": { "head_sha": "deadbee" },
                        "source_project_id": 42,
                        "target_project_id": 1,
                        "merge_status": "can_be_merged",
                        "detailed_merge_status": "mergeable",
                        "has_conflicts": false,
                        "changes_count": "3",
                        "head_pipeline": { "id": 77, "status": "running" },
                    }))
                }),
            )
            .route(
                "/detail/projects/42",
                get(|| async {
                    Json(serde_json::json!({ "path_with_namespace": "contributor/proj" }))
                }),
            )
            .route(
                "/detail/projects/group%2Fsub%2Fproj/pipelines/77/jobs",
                get(|| async {
                    Json(serde_json::json!([
                        { "id": 1, "name": "rspec", "stage": "test", "status": "success",
                          "web_url": "https://gitlab.test/-/jobs/1", "allow_failure": false },
                        { "id": 2, "name": "lint", "stage": "test", "status": "failed",
                          "allow_failure": true },
                        { "id": 3, "name": "deploy", "stage": "deploy", "status": "manual",
                          "web_url": "data:text/html,x" },
                        { "id": 4, "name": "build", "stage": "build", "status": "running" },
                    ]))
                }),
            )
            .route(
                "/detail/projects/group%2Fsub%2Fproj/merge_requests/4/diffs",
                get(|Query(q): Query<HashMap<String, String>>| async move {
                    let mut headers = axum::http::HeaderMap::new();
                    let page: u32 = q.get("page").and_then(|p| p.parse().ok()).unwrap_or(1);
                    headers.insert(
                        "x-next-page",
                        if page < 2 { "2" } else { "" }.parse().unwrap(),
                    );
                    (headers, Json(serde_json::json!([
                        { "old_path": "src/a.rs", "new_path": "src/a.rs",
                          "diff": "--- a/src/a.rs\n+++ b/src/a.rs\n@@ -1,2 +1,3 @@\n ctx\n-old\n+new\n+more\n" },
                        { "old_path": "src/old.rs", "new_path": "src/new.rs",
                          "renamed_file": true, "diff": "@@ -1 +1 @@\n-a\n+b\n" },
                        // Binary: GitLab has nothing textual to send.
                        { "old_path": "logo.png", "new_path": "logo.png",
                          "new_file": true, "diff": "" },
                    ])))
                }),
            )
            // An instance older than 15.7: `/diffs` does not exist there.
            .route(
                "/legacy/projects/group%2Fsub%2Fproj/merge_requests/4/diffs",
                get(|| async { axum::http::StatusCode::NOT_FOUND }),
            )
            .route(
                "/legacy/projects/group%2Fsub%2Fproj/merge_requests/4/changes",
                get(|| async {
                    let changes: Vec<serde_json::Value> = (0..5)
                        .map(|i| {
                            serde_json::json!({
                                "old_path": format!("f{i}.rs"),
                                "new_path": format!("f{i}.rs"),
                                "diff": "@@ -1 +1 @@\n-a\n+b\n",
                            })
                        })
                        .collect();
                    Json(serde_json::json!({ "changes": changes }))
                }),
            )
            // CI the token cannot read: the merge request still loads.
            .route(
                "/blind/projects/group%2Fsub%2Fproj/merge_requests/4",
                get(|| async {
                    Json(serde_json::json!({
                        "iid": 4, "state": "opened",
                        "source_branch": "x", "target_branch": "main",
                        "source_project_id": 1, "target_project_id": 1,
                        "merge_status": "unchecked",
                        "changes_count": "1000+",
                        "head_pipeline": { "id": 77 },
                    }))
                }),
            )
            .route(
                "/blind/projects/group%2Fsub%2Fproj/pipelines/77/jobs",
                get(|| async { axum::http::StatusCode::FORBIDDEN }),
            )
            // No pipeline at all: the forge ANSWERED, and the answer is that
            // nothing runs here.
            .route(
                "/nopipe/projects/group%2Fsub%2Fproj/merge_requests/4",
                get(|| async {
                    Json(serde_json::json!({
                        "iid": 4, "state": "merged",
                        "source_branch": "x", "target_branch": "main",
                        "has_conflicts": true,
                    }))
                }),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        (format!("http://{addr}"), writes)
    }

    /// Issues and merge requests are separate collections here, and the change
    /// is a VERB (`state_event`) rather than a target state — sending GitHub's
    /// `{"state": "closed"}` would be silently ignored.
    #[tokio::test]
    async fn a_state_change_puts_a_verb_on_the_right_collection() {
        let (api_base, writes) = mock_write_api().await;
        let auth = auth_for(api_base);

        let issue = set_item_state(
            &auth,
            "Group/Sub/Proj",
            ForgeItemKind::Issue,
            7,
            ForgeStateAction::Close,
        )
        .await
        .expect("close issue");
        assert!(!issue.is_pr && issue.state == "closed");
        // Bare names still make chips; they just arrive without colours.
        assert_eq!(
            issue.labels.iter().map(|l| l.name.as_str()).collect::<Vec<_>>(),
            vec!["bug", "docs"]
        );
        assert!(issue.labels.iter().all(|l| l.color.is_none()));

        let mr = set_item_state(
            &auth,
            "group/sub/proj",
            ForgeItemKind::Change,
            9,
            ForgeStateAction::Reopen,
        )
        .await
        .expect("reopen mr");
        assert!(mr.is_pr && mr.draft, "the draft flag only means anything here");

        let sent = writes.lock().unwrap().clone();
        assert_eq!(sent[0].0, "PUT", "GitLab edits with PUT, not PATCH");
        assert_eq!(sent[0].1, "issues/7");
        assert_eq!(sent[0].2["state_event"], "close");
        assert_eq!(sent[1].1, "merge_requests/9");
        assert_eq!(sent[1].2["state_event"], "reopen");

        assert!(set_item_state(&auth, "no-slash", ForgeItemKind::Issue, 7, ForgeStateAction::Close)
            .await
            .is_err());
        assert!(set_item_state(&auth, "group/sub/proj", ForgeItemKind::Issue, 0, ForgeStateAction::Close)
            .await
            .is_err());
    }

    /// GitLab's merge endpoint takes NO method — the project picks between a
    /// merge commit, a rebase-merge and a fast-forward — so the only choice
    /// offered is whether to squash, and `squash_option` decides even that.
    #[tokio::test]
    async fn merge_options_offer_only_the_squash_choice_the_project_allows() {
        let (api_base, _writes) = mock_write_api().await;
        let auth = auth_for(api_base);

        let both = merge_options(&auth, "Group/Sub/Proj").await.expect("both");
        assert_eq!(
            both.methods,
            vec![ForgeMergeMethod::Merge, ForgeMergeMethod::Squash]
        );
        // `default_on` — the project's own preference decides which entry the
        // box opens on, not the order they happen to be listed in.
        assert_eq!(both.default_method, ForgeMergeMethod::Squash);

        // Squashing is COMPULSORY here: offering "Merge" as well would offer a
        // request GitLab rewrites into the other one.
        let always = merge_options(&auth, "acme/always").await.expect("always");
        assert_eq!(always.methods, vec![ForgeMergeMethod::Squash]);
        assert_eq!(always.default_method, ForgeMergeMethod::Squash);

        // What `Merge` will actually DO, which on GitLab is the project's
        // choice and not the caller's. `acme/always` is a fast-forward project:
        // labelling its entry "create a merge commit" would promise a commit
        // its history will never contain.
        assert_eq!(both.merge_strategy, ForgeMergeStrategy::MergeCommit);
        assert_eq!(always.merge_strategy, ForgeMergeStrategy::FastForward);

        let never = merge_options(&auth, "acme/never").await.expect("never");
        assert_eq!(never.methods, vec![ForgeMergeMethod::Merge]);

        // Neither key present: nothing is known, so nothing is offered — the
        // panel falls back to one safe entry and lets GitLab have the last
        // word. Inventing "squash is available" here would 422 at merge time.
        let legacy = merge_options(&auth, "acme/legacy").await.expect("legacy");
        assert!(legacy.methods.is_empty());
        assert_eq!(legacy.default_method, ForgeMergeMethod::Merge);

        // Rebase is never on the menu: GitLab rebases through a different
        // endpoint, which this module does not call.
        assert!(!both.methods.contains(&ForgeMergeMethod::Rebase));

        assert!(merge_options(&auth, "no-slash").await.is_err());
    }

    /// One request, unlike GitHub's two: the merge answers with the merge
    /// request itself, so the row comes straight out of the write.
    #[tokio::test]
    async fn a_merge_sends_squash_explicitly_and_reads_the_row_from_the_answer() {
        let (api_base, writes) = mock_write_api().await;
        let auth = auth_for(api_base);

        let row = merge_change(
            &auth,
            "Group/Sub/Proj",
            9,
            ForgeMergeMethod::Squash,
            Some("cafe123"),
        )
        .await
        .expect("merge")
        .expect("the answer IS the row here");
        assert!(row.is_pr);
        assert_eq!(row.state, "merged");
        assert_eq!(row.number, 9);

        merge_change(&auth, "group/sub/proj", 9, ForgeMergeMethod::Merge, None)
            .await
            .expect("merge without squashing");

        let sent = writes.lock().unwrap().clone();
        assert_eq!(sent[0].0, "PUT");
        assert_eq!(sent[0].1, "merge_requests/9/merge");
        assert_eq!(sent[0].2["squash"], true);
        // The commit the caller was reading. GitLab refuses with a 409 if the
        // source branch moved since, which is the point of sending it.
        assert_eq!(sent[0].2["sha"], "cafe123");
        // Sent EXPLICITLY as false rather than omitted: the project's
        // `squash_option` can default it on, and a missing field would then
        // squash a change whose author asked for the commits to be kept.
        assert_eq!(sent[1].2["squash"], false);
        assert!(sent[1].2.get("sha").is_none(), "absent, not null");

        // REFUSED, not quietly downgraded. GitLab rebases through its own
        // endpoint, and a caller told "rebased" that got a merge commit was
        // told the wrong thing about its own history. The panel never offers
        // this; the server binary's HTTP surface can still ask for it.
        let refused = merge_change(&auth, "group/sub/proj", 9, ForgeMergeMethod::Rebase, None)
            .await
            .expect_err("rebase is not a merge method here");
        assert!(matches!(refused, ForgeError::Invalid(_)));
        assert_eq!(
            writes.lock().unwrap().len(),
            2,
            "and nothing was sent for it"
        );

        assert!(
            merge_change(&auth, "group/sub/proj", 0, ForgeMergeMethod::Merge, None)
                .await
                .is_err()
        );
        assert!(
            merge_change(&auth, "no-slash", 9, ForgeMergeMethod::Merge, None)
                .await
                .is_err()
        );
    }

    /// Labels go out COMMA-JOINED here, not as a JSON array — GitHub's shape
    /// would apply no labels at all, silently.
    #[tokio::test]
    async fn a_new_issue_comma_joins_its_labels() {
        let (api_base, writes) = mock_write_api().await;
        let auth = auth_for(api_base);
        let row = create_issue(
            &auth,
            "Group/Sub/Proj",
            &ResolvedNewIssue {
                title: "Login times out".into(),
                body: Some("steps".into()),
                labels: vec!["bug".into(), "help wanted".into()],
            },
        )
        .await
        .expect("issue");
        assert_eq!((row.number, row.is_pr), (123, false));
        assert_eq!(row.title, "Login times out");
        let sent = writes.lock().unwrap().clone();
        assert_eq!(sent[0].2["labels"], "bug,help wanted");
        // GitLab calls the body a DESCRIPTION; `body` would be dropped.
        assert_eq!(sent[0].2["description"], "steps");
        assert!(sent[0].2.get("body").is_none());
    }

    /// Branches, the fork's real name, a tri-state merge status and the head
    /// pipeline's jobs — everything the panel shows that the list row does not.
    #[tokio::test]
    async fn a_merge_request_detail_carries_its_branches_and_pipeline() {
        let (api_base, _) = mock_write_api().await;
        let auth = auth_for(format!("{api_base}/detail"));
        let detail = change_detail(&auth, "Group/Sub/Proj", 4).await.expect("detail");

        assert_eq!((detail.base_ref.as_str(), detail.head_ref.as_str()), ("main", "fix/timeout"));
        // The fork's PATH, resolved with the one extra request a fork costs —
        // "project 42" would be a worse answer in the one place it is read.
        assert_eq!(detail.head_repo.as_deref(), Some("contributor/proj"));
        // `diff_refs.head_sha` is the precise head of the diff under review and
        // outranks the merge request's own `sha`.
        assert_eq!(detail.head_sha.as_deref(), Some("deadbee"));
        assert!(detail.draft, "old instances only send `work_in_progress`");
        assert_eq!(detail.mergeable, Some(true));
        assert_eq!(detail.merge_state.as_deref(), Some("mergeable"));
        assert_eq!(detail.changed_files, Some(3));
        // GitLab reports neither, and a zero would claim the change is empty.
        assert_eq!((detail.additions, detail.deletions, detail.commits), (None, None, None));

        assert!(detail.checks.available);
        let state_of = |name: &str| {
            detail.checks.checks.iter().find(|c| c.name == name).expect(name).state
        };
        assert_eq!(state_of("rspec"), ForgeCheckState::Success);
        assert_eq!(state_of("lint"), ForgeCheckState::Failure);
        assert_eq!(state_of("deploy"), ForgeCheckState::Neutral, "manual has no verdict");
        assert_eq!(state_of("build"), ForgeCheckState::Running);
        // A red job the pipeline is allowed to fail on is a different fact
        // from one that blocks the change.
        assert!(detail.checks.checks.iter().find(|c| c.name == "lint").unwrap().allow_failure);
        // The stage is the summary — it is what turns a column of job names
        // into a pipeline that can be read.
        assert_eq!(
            detail.checks.checks.iter().find(|c| c.name == "rspec").unwrap().summary.as_deref(),
            Some("test")
        );
        // A `data:` URL the instance made up never reaches an `href`.
        assert_eq!(
            detail.checks.checks.iter().find(|c| c.name == "deploy").unwrap().url,
            None
        );

        assert!(change_detail(&auth, "no-slash", 4).await.is_err());
        assert!(change_detail(&auth, "group/sub/proj", 0).await.is_err());
    }

    /// Three ways the CI section can be right, and they are all different.
    #[tokio::test]
    async fn a_pipeline_it_cannot_read_is_unavailable_and_no_pipeline_is_empty() {
        let (api_base, _) = mock_write_api().await;

        let blind = change_detail(&auth_for(format!("{api_base}/blind")), "group/sub/proj", 4)
            .await
            .expect("detail");
        assert!(!blind.checks.available, "the jobs request was refused");
        // `unchecked` is "ask again shortly", NOT "cannot be merged".
        assert_eq!(blind.mergeable, None);
        // "1000+" is a truncation marker; parsing 1000 off it would print a
        // count for a change that touches more.
        assert_eq!(blind.changed_files, None);

        let quiet = change_detail(&auth_for(format!("{api_base}/nopipe")), "group/sub/proj", 4)
            .await
            .expect("detail");
        assert!(quiet.checks.available && quiet.checks.checks.is_empty(),
                "the forge answered: nothing runs here");
        // A conflict is a definite no, whatever `merge_status` says.
        assert_eq!(quiet.mergeable, Some(false));
        assert_eq!(quiet.state, "merged");
    }

    /// GitLab counts nothing per file, so the `+`/`−` come off the diff hunk it
    /// ships — and an empty one is binary content, which has no counts at all.
    #[tokio::test]
    async fn changed_files_are_counted_off_the_diff_hunk() {
        let (api_base, _) = mock_write_api().await;
        let auth = auth_for(format!("{api_base}/detail"));
        let page = list_change_files(&auth, "Group/Sub/Proj", 4, 1, 50)
            .await
            .expect("files");
        assert_eq!(page.files.len(), 3);
        // `+++`/`---` are the file headers; counting them would add one to
        // each side of every file in the list.
        assert_eq!((page.files[0].additions, page.files[0].deletions), (Some(2), Some(1)));
        assert_eq!(page.files[0].status, ForgeFileStatus::Modified);
        // The very text those counters were counted off, kept rather than
        // discarded — a file row opens onto it.
        assert_eq!(
            page.files[0].patch.as_deref(),
            Some("--- a/src/a.rs\n+++ b/src/a.rs\n@@ -1,2 +1,3 @@\n ctx\n-old\n+new\n+more\n")
        );
        assert_eq!(page.files[1].status, ForgeFileStatus::Renamed);
        assert_eq!(page.files[1].previous_path.as_deref(), Some("src/old.rs"));
        assert!(page.files[2].binary);
        assert_eq!((page.files[2].additions, page.files[2].deletions), (None, None));
        // Binary and "no diff" are one and the same answer here, unlike on
        // GitHub: a blank `diff` is the only way GitLab says either.
        assert!(page.files[2].patch.is_none());
        assert!(page.has_next, "from `x-next-page`, never from the row count");
    }

    /// An instance older than 15.7 has no `/diffs`. The unpaginated `/changes`
    /// answers instead and is sliced here, so the panel's footer behaves the
    /// same either way.
    #[tokio::test]
    async fn a_missing_diffs_endpoint_falls_back_to_changes() {
        let (api_base, _) = mock_write_api().await;
        let auth = auth_for(format!("{api_base}/legacy"));
        let first = list_change_files(&auth, "group/sub/proj", 4, 1, 2)
            .await
            .expect("page 1");
        assert_eq!(
            first.files.iter().map(|f| f.path.as_str()).collect::<Vec<_>>(),
            vec!["f0.rs", "f1.rs"]
        );
        assert!(first.has_next);

        let last = list_change_files(&auth, "group/sub/proj", 4, 3, 2)
            .await
            .expect("page 3");
        assert_eq!(
            last.files.iter().map(|f| f.path.as_str()).collect::<Vec<_>>(),
            vec!["f4.rs"]
        );
        assert!(!last.has_next);

        // Past the end: an empty page, not a wrap round to the first one.
        let beyond = list_change_files(&auth, "group/sub/proj", 4, 90_000, 100)
            .await
            .expect("page 90000");
        assert!(beyond.files.is_empty() && !beyond.has_next);
    }

    /// GitLab's eleven job statuses over the five the strip draws, and the
    /// tri-state merge status that is the whole reason `mergeable` is optional.
    #[test]
    fn job_statuses_and_merge_statuses_fold_into_the_shared_vocabulary() {
        assert_eq!(job_state("success"), ForgeCheckState::Success);
        assert_eq!(job_state("failed"), ForgeCheckState::Failure);
        for running in ["running", "preparing"] {
            assert_eq!(job_state(running), ForgeCheckState::Running, "{running}");
        }
        for queued in ["created", "pending", "scheduled", "waiting_for_resource"] {
            assert_eq!(job_state(queued), ForgeCheckState::Queued, "{queued}");
        }
        for neutral in ["canceled", "skipped", "manual"] {
            assert_eq!(job_state(neutral), ForgeCheckState::Neutral, "{neutral}");
        }

        assert_eq!(mergeable(Some("can_be_merged"), false), Some(true));
        assert_eq!(mergeable(Some("cannot_be_merged"), false), Some(false));
        // Three ways of saying "the server has not worked it out yet".
        for unknown in ["unchecked", "checking", "cannot_be_merged_recheck"] {
            assert_eq!(mergeable(Some(unknown), false), None, "{unknown}");
        }
        assert_eq!(mergeable(None, false), None);
        // A conflict outranks whatever the status says.
        assert_eq!(mergeable(Some("can_be_merged"), true), Some(false));
        assert_eq!(mergeable(None, true), Some(false));

        assert_eq!(exact_changes_count("12"), Some(12));
        assert_eq!(exact_changes_count(" 0 "), Some(0));
        // Truncated: no count at all beats a count that is wrong.
        assert_eq!(exact_changes_count("1000+"), None);
        assert_eq!(exact_changes_count(""), None);
        assert_eq!(exact_changes_count("many"), None);
    }
}
