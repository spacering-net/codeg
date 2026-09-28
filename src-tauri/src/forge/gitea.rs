//! Gitea (and Forgejo) REST v1 for the workbench and the delivery path.
//!
//! Gitea models a repository the way GitHub does — a pull request IS an issue,
//! both come out of `/issues`, one comment collection serves both — so this
//! client reads much closer to `github.rs` than to `gitlab.rs`. The places it
//! does NOT is where the interesting work is, and each one is a silent wrong
//! answer if you assume otherwise:
//!
//! 1. **The list takes no `sort`.** `/repos/{o}/{r}/issues` hard-codes
//!    newest-first in Gitea itself (`SortByCreatedDesc`), and there is no
//!    parameter to change it. Rather than reorder one page locally and call it
//!    a sorted list, the order is IGNORED here and the panel hides the control
//!    (see `forge-page.tsx`) — a sort that silently applies to twenty of four
//!    hundred rows is worse than no sort at all.
//! 2. **A new issue's labels are IDs, not names.** `CreateIssueOption.labels`
//!    is `[]int64`, so [`create_issue`] resolves the names against the
//!    repository's label vocabulary first.
//! 3. **The file list carries no patch.** `ChangedFile` has the counters and
//!    the status but no diff text, so [`list_change_files`] fetches the pull
//!    request's own unified diff and splits it per file — under a byte cap,
//!    because that endpoint answers with the WHOLE diff.
//! 4. **The comment collection is not paginated.** `/issues/{n}/comments`
//!    answers with every comment there is (Gitea passes no `ListOptions`), so
//!    the page is cut here.
//! 5. **`status`, not `state`, on a commit status**, and a deletion is
//!    `deleted`, not GitHub's `removed`. Two one-word differences that a
//!    copy of the GitHub mapper reads straight past.
//!
//! Pagination is offset-based (`page` + `limit` — NOT `per_page`), with
//! `X-Total-Count` for the total and a `Link: rel="next"` for the next page.
//! Note Gitea clamps `limit` to its own `MAX_RESPONSE_ITEMS` (50 by default);
//! every page size the workbench offers is at or under that, which is what
//! keeps the echoed `per_page` honest.

use std::collections::HashMap;
use std::sync::{LazyLock, RwLock};

use serde::Deserialize;

use super::auth::ResolvedAuth;
use super::deliver::{ForgePr, NewPullRequest};
use super::{
    sanitize_web_url, truncate_chars, urlencode_query, validate_state_filter, ForgeChangeDetail,
    ForgeChangedFile, ForgeChangedFileList, ForgeCheck, ForgeCheckList, ForgeCheckState,
    ForgeComment, ForgeCommentList, ForgeError, ForgeFileStatus, ForgeIssueList, ForgeIssueRow,
    ForgeItemKind, ForgeLabel, ForgeLabelList, ForgeMergeMethod, ForgeMergeOptions,
    ForgeMergeStrategy, ForgeStateAction, ForgeTab, ListIssuesRequest, ResolvedNewIssue, BODY_CAP,
    LABEL_PAGE_SIZE,
};

// ── reads ───────────────────────────────────────────────────────────────────

/// One page of the workbench list.
///
/// `type=issues|pulls` is what makes real page numbers possible: without it
/// `/issues` serves both kinds from one feed, which is the same trap GitHub's
/// `/issues` sets and the reason its client uses search instead. Gitea filters
/// server-side and counts in `X-Total-Count`, so no such detour is needed.
///
/// `req.sort` is deliberately unread — see this module's header.
pub async fn list_issues(
    auth: &ResolvedAuth,
    req: &ListIssuesRequest,
) -> Result<ForgeIssueList, ForgeError> {
    let repo = repo_ref(&req.owner_repo)?;
    validate_state_filter(&req.state)?;
    let (page, per_page) = req.clamped();

    let kind = match req.tab {
        ForgeTab::Issues => "issues",
        ForgeTab::Prs => "pulls",
    };
    // `state` takes our own three words unchanged — Gitea spells them the same.
    let mut url = format!(
        "{}/repos/{repo}/issues?state={}&type={kind}&page={page}&limit={per_page}",
        auth.api_base, req.state
    );
    if req.assigned_me {
        // A literal login; Gitea has no `@me` shorthand on this endpoint. (The
        // cross-repository `/repos/issues/search` does take an `assigned`
        // boolean, but it cannot be narrowed to one repository.)
        let login = current_login(auth).await?;
        url.push_str(&format!("&assigned_by={}", urlencode_query(&login)));
    }
    if !req.labels.is_empty() {
        // Comma-joined and ANDed — which is what this filter means everywhere
        // else here, and what Gitea actually does (its own swagger says "any of
        // these", but `ListIssues` fills `IncludedLabelIDs`, and that is an
        // intersection). A name the repository does not have is DISCARDED
        // rather than matching nothing, so a stale chip widens the list instead
        // of emptying it; the chips come from `list_labels` on this same
        // repository, so that is a narrow window.
        url.push_str(&format!("&labels={}", urlencode_query(&req.labels.join(","))));
    }
    if let Some(text) = req.search.as_deref() {
        // Plain text, not a query language: Gitea hands `q` to its issue
        // indexer, so there is no syntax to strip the way GitHub's `q` needs.
        url.push_str(&format!("&q={}", urlencode_query(text)));
    }

    let response = api_get(auth, &url).await?;
    let total_count = header_i64(response.headers(), "x-total-count");
    let has_next = has_next_link(response.headers());
    let raw: Vec<RawIssue> = response
        .json()
        .await
        .map_err(|e| ForgeError::Network(format!("bad list payload: {e}")))?;

    let is_pr = req.tab == ForgeTab::Prs;
    Ok(ForgeIssueList {
        rows: raw.into_iter().map(|item| item.into_row(is_pr)).collect(),
        page,
        per_page,
        total_count,
        // Gitea paginates the whole collection — no equivalent of GitHub
        // search's first-thousand ceiling, so every match is reachable.
        reachable_count: None,
        has_next,
        // No partial-result flag; only GitHub search has one.
        incomplete: false,
    })
}

/// The repository's labels, for the workbench's label filter.
///
/// `truncated` comes from `X-Total-Count` rather than from a full page, because
/// Gitea clamps `limit` to its own maximum (50 by default, well under
/// [`LABEL_PAGE_SIZE`]) — so "we asked for 100 and got 100" is a test that
/// never fires here, and a repository with 300 labels would silently look
/// complete.
pub async fn list_labels(
    auth: &ResolvedAuth,
    owner_repo: &str,
) -> Result<ForgeLabelList, ForgeError> {
    let repo = repo_ref(owner_repo)?;
    let (labels, truncated) = fetch_labels(auth, &repo).await?;
    Ok(ForgeLabelList {
        labels: labels
            .into_iter()
            .filter_map(|l| ForgeLabel::parse(l.name, l.color.as_deref()))
            .collect(),
        truncated,
    })
}

/// One page of the repository's labels, and whether there are more. Shared with
/// [`create_issue`], which needs the ids rather than the chips.
async fn fetch_labels(
    auth: &ResolvedAuth,
    repo: &str,
) -> Result<(Vec<RawLabel>, bool), ForgeError> {
    let url = format!("{}/repos/{repo}/labels?page=1&limit={LABEL_PAGE_SIZE}", auth.api_base);
    let response = api_get(auth, &url).await?;
    let total = header_i64(response.headers(), "x-total-count");
    let raw: Vec<RawLabel> = response
        .json()
        .await
        .map_err(|e| ForgeError::Network(format!("bad labels payload: {e}")))?;
    let truncated = match total {
        Some(total) => total > raw.len() as i64,
        None => raw.len() >= LABEL_PAGE_SIZE,
    };
    Ok((raw, truncated))
}

/// One page of an item's conversation.
///
/// `/repos/{o}/{r}/issues/{n}/comments` serves ISSUES AND PULL REQUESTS alike —
/// a pull request is an issue here, exactly as on GitHub — which is why this
/// takes no item kind. It also serves only real comments: Gitea files its
/// timeline events under a different comment TYPE and this endpoint asks for
/// `CommentTypeComment` alone, so the thread matches the `comments` count the
/// row shows without any local filtering.
///
/// The endpoint is UNPAGINATED (Gitea gives it no list options), so the page is
/// cut here. `has_next` is therefore honest by construction rather than read
/// off a header: this client is holding every comment there is.
pub async fn list_comments(
    auth: &ResolvedAuth,
    owner_repo: &str,
    number: i64,
    page: u32,
    per_page: u32,
) -> Result<ForgeCommentList, ForgeError> {
    let repo = repo_ref(owner_repo)?;
    require_number(number)?;
    let url = format!("{}/repos/{repo}/issues/{number}/comments", auth.api_base);
    let raw: Vec<RawComment> = api_get(auth, &url)
        .await?
        .json()
        .await
        .map_err(|e| ForgeError::Network(format!("bad comments payload: {e}")))?;

    // `saturating_mul` rather than a bare product: `page` is clamped to at
    // least 1 but has no ceiling, and a 32-bit overflow would wrap round to the
    // FIRST page of a thread the caller asked to be past the end of.
    let skip = (page as usize).saturating_sub(1).saturating_mul(per_page as usize);
    let total = raw.len();
    Ok(ForgeCommentList {
        comments: raw
            .into_iter()
            .skip(skip)
            .take(per_page as usize)
            .map(RawComment::into_comment)
            .collect(),
        page,
        per_page,
        has_next: total > skip.saturating_add(per_page as usize),
    })
}

// ── writes ──────────────────────────────────────────────────────────────────

/// `POST /repos/{o}/{r}/issues/{n}/comments` — the SAME collection
/// [`list_comments`] reads, which is what makes an optimistic append honest.
pub async fn create_comment(
    auth: &ResolvedAuth,
    owner_repo: &str,
    number: i64,
    body: &str,
) -> Result<ForgeComment, ForgeError> {
    let repo = repo_ref(owner_repo)?;
    require_number(number)?;
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
/// Two endpoints, picked by kind — the same split GitHub needs and for the same
/// reason: `PATCH /pulls/{n}` answers with a pull request, whose `merged` flag
/// is the only thing that tells a merged change from a closed one. An issue
/// payload has no such field, so patching a pull request through `/issues/{n}`
/// would paint every merged one "closed".
pub async fn set_item_state(
    auth: &ResolvedAuth,
    owner_repo: &str,
    kind: ForgeItemKind,
    number: i64,
    action: ForgeStateAction,
) -> Result<ForgeIssueRow, ForgeError> {
    let repo = repo_ref(owner_repo)?;
    require_number(number)?;
    let collection = match kind {
        ForgeItemKind::Issue => "issues",
        ForgeItemKind::Change => "pulls",
    };
    let url = format!("{}/repos/{repo}/{collection}/{number}", auth.api_base);
    // Gitea takes a target STATE here, like GitHub — not GitLab's verb.
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
/// Labels are resolved from NAMES to IDS first, because that is what Gitea's
/// `CreateIssueOption` takes (`[]int64`). Names the repository does not have
/// are dropped rather than refused — the same thing GitHub does with an unknown
/// label name, and the alternative is failing to file an issue somebody wrote
/// over a chip they picked from a stale list.
pub async fn create_issue(
    auth: &ResolvedAuth,
    owner_repo: &str,
    draft: &ResolvedNewIssue,
) -> Result<ForgeIssueRow, ForgeError> {
    let repo = repo_ref(owner_repo)?;
    let url = format!("{}/repos/{repo}/issues", auth.api_base);
    let mut payload = serde_json::json!({ "title": draft.title });
    if let Some(body) = draft.body.as_deref() {
        payload["body"] = serde_json::Value::String(body.to_string());
    }
    if !draft.labels.is_empty() {
        // Best-effort: a repository whose labels cannot be read still gets the
        // issue, without them. Losing the chips is a great deal better than
        // losing the text somebody typed.
        let known = fetch_labels(auth, &repo).await.map(|(labels, _)| labels);
        if let Ok(known) = known {
            let ids: Vec<i64> = draft
                .labels
                .iter()
                .filter_map(|wanted| resolve_label(&known, wanted))
                .collect();
            if !ids.is_empty() {
                payload["labels"] = serde_json::Value::from(ids);
            }
        }
    }
    let raw: RawIssue = api_post(auth, &url, &payload)
        .await?
        .json()
        .await
        .map_err(|e| ForgeError::Network(format!("bad issue payload: {e}")))?;
    Ok(raw.into_row(false))
}

/// The id of the label `wanted` names, exact match first.
///
/// Exact first is not pedantry: the dialog's chips come from [`list_labels`] on
/// this same repository, so a name that matches one exactly IS the one that was
/// picked — and a repository holding both `bug` and `BUG` would otherwise get
/// whichever the page happened to list first. The case-insensitive fallback is
/// for the other caller, the server binary's HTTP surface, where the name can
/// be hand-written.
fn resolve_label(known: &[RawLabel], wanted: &str) -> Option<i64> {
    known
        .iter()
        .find(|label| label.name == wanted)
        .or_else(|| known.iter().find(|label| label.name.eq_ignore_ascii_case(wanted)))
        .map(|label| label.id)
        .filter(|id| *id > 0)
}

// ── proposed changes ────────────────────────────────────────────────────────

/// One pull request's branches, size and CI.
///
/// Two requests, both cheap: the pull request itself (which, unlike its list
/// row, carries `additions`/`deletions`/`changed_files` — Gitea computes the
/// diff only for the single-item payload) and its head commit's statuses.
///
/// `mergeable` is passed through as Gitea reports it, with one caveat worth
/// stating: Gitea answers `false` both for a real conflict AND for the seconds
/// while it is still computing one, and exposes nothing that separates them.
/// `None` would be the honest third answer if there were a way to reach it —
/// there is not, and turning every `false` into "we do not know" would hide the
/// conflicts this field exists to report.
pub async fn change_detail(
    auth: &ResolvedAuth,
    owner_repo: &str,
    number: i64,
) -> Result<ForgeChangeDetail, ForgeError> {
    let repo = repo_ref(owner_repo)?;
    require_number(number)?;
    let url = format!("{}/repos/{repo}/pulls/{number}", auth.api_base);
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
    let checks = match head_sha.as_deref() {
        Some(sha) => head_checks(auth, &repo, sha).await,
        // No head commit to ask about: nothing was asked, so nothing is claimed.
        None => ForgeCheckList::unavailable(),
    };

    // Shown only when the head is somebody ELSE's repository — a fork is the
    // fact worth a line. `same_repo` rather than `==`: Gitea answers with the
    // repository's stored casing.
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
        state: pull_state(&raw.state, raw.merged),
        mergeable: Some(raw.mergeable),
        // Gitea has no equivalent of GitHub's `mergeable_state` /  GitLab's
        // `detailed_merge_status`: there is no word to pass through, and
        // inventing one would put a diagnosis in a tooltip that nothing backs.
        merge_state: None,
        additions: raw.additions,
        deletions: raw.deletions,
        changed_files: raw.changed_files,
        // Not in the payload at any depth. Absent rather than zero — see
        // `ForgeChangeDetail`.
        commits: None,
        checks,
    })
}

/// The head commit's checks.
///
/// ONE collection, unlike GitHub's two: Gitea has no check-runs API, and its
/// Actions write ordinary commit statuses, so `/commits/{sha}/status` is the
/// whole answer. It is the COMBINED status rather than `/statuses`, which is
/// the difference between "the latest verdict per context" and "every verdict
/// ever posted" — the second shows a context that went pending → success twice.
///
/// Failure is swallowed the same way the other clients swallow theirs: a token
/// that cannot read statuses still reads the pull request perfectly well, and
/// losing the panel over the CI strip would be the worse answer.
async fn head_checks(auth: &ResolvedAuth, repo: &str, sha: &str) -> ForgeCheckList {
    // The sha comes from Gitea's own response, but it lands in a URL path, so
    // it is checked like anything else that does.
    if sha.is_empty() || !sha.chars().all(|c| c.is_ascii_alphanumeric()) {
        return ForgeCheckList::unavailable();
    }
    let url = format!(
        "{}/repos/{repo}/commits/{sha}/status?page=1&limit={LABEL_PAGE_SIZE}",
        auth.api_base
    );
    let combined: Option<RawCombinedStatus> =
        async { api_get(auth, &url).await.ok()?.json().await.ok() }.await;
    match combined {
        Some(combined) => ForgeCheckList::available(
            combined
                .statuses
                .into_iter()
                .map(|status| ForgeCheck {
                    id: format!("status-{}", status.id),
                    state: commit_status_state(&status.status),
                    summary: status
                        .description
                        .filter(|description| !description.trim().is_empty()),
                    url: status.target_url.as_deref().and_then(sanitize_web_url),
                    name: status.context,
                    // Gitea has no per-status "allowed to fail" flag; whether a
                    // status blocks is a branch-protection property of the
                    // repository, not of the run.
                    allow_failure: false,
                })
                .collect(),
        ),
        None => ForgeCheckList::unavailable(),
    }
}

/// Gitea's five commit-status words in the ones the strip draws. `error` and
/// `failure` are the same outcome as far as an indicator is concerned;
/// `warning` ran and produced no verdict, which is emphatically not a pass.
fn commit_status_state(status: &str) -> ForgeCheckState {
    match status {
        "success" => ForgeCheckState::Success,
        "failure" | "error" => ForgeCheckState::Failure,
        "pending" => ForgeCheckState::Running,
        _ => ForgeCheckState::Neutral,
    }
}

/// How much of a pull request's own diff [`list_change_files`] will hold in
/// memory to slice patches out of. Past this the file list still arrives with
/// its counters — only the reveal is lost, which is exactly what GitHub does
/// when a patch is over its own limit.
const DIFF_BYTE_CAP: usize = 2 * 1024 * 1024;

/// One page of the files a pull request touches.
///
/// `/pulls/{n}/files` carries the status and the counters but NO patch text, so
/// the diff comes from `/pulls/{n}.diff` and is split per file here. That
/// endpoint answers with the whole diff (there is no per-file one), hence
/// [`DIFF_BYTE_CAP`] and hence the fetch being best-effort: a change too big to
/// inline still lists its files, exactly as it would on GitHub.
pub async fn list_change_files(
    auth: &ResolvedAuth,
    owner_repo: &str,
    number: i64,
    page: u32,
    per_page: u32,
) -> Result<ForgeChangedFileList, ForgeError> {
    let repo = repo_ref(owner_repo)?;
    require_number(number)?;
    let url = format!(
        "{}/repos/{repo}/pulls/{number}/files?page={page}&limit={per_page}",
        auth.api_base
    );
    let response = api_get(auth, &url).await?;
    let has_next = has_next_link(response.headers());
    let raw: Vec<RawChangedFile> = response
        .json()
        .await
        .map_err(|e| ForgeError::Network(format!("bad pull files payload: {e}")))?;

    let patches = change_diff(auth, &repo, number).await;
    Ok(ForgeChangedFileList {
        files: raw
            .into_iter()
            .map(|file| {
                let patch = patches
                    .get(file.filename.as_str())
                    .filter(|patch| !patch.is_empty())
                    .cloned();
                // Nothing counted on either side AND no hunk to show: binary
                // content arrives this way, and so does a diff that was never
                // fetched — which is why the counters are part of the test
                // rather than the patch alone.
                let binary = patch.is_none() && file.additions == 0 && file.deletions == 0;
                ForgeChangedFile {
                    status: file_status(&file.status),
                    previous_path: file
                        .previous_filename
                        .filter(|previous| !previous.is_empty()),
                    path: file.filename,
                    additions: (!binary).then_some(file.additions),
                    deletions: (!binary).then_some(file.deletions),
                    binary,
                    patch,
                }
            })
            .collect(),
        page,
        per_page,
        has_next,
    })
}

/// The pull request's unified diff, split by the path each hunk belongs to.
///
/// Best-effort throughout: every failure — no permission, a diff over
/// [`DIFF_BYTE_CAP`], a payload that does not parse — yields an empty map,
/// which costs the file rows their reveal and nothing else.
async fn change_diff(auth: &ResolvedAuth, repo: &str, number: i64) -> HashMap<String, String> {
    let url = format!("{}/repos/{repo}/pulls/{number}.diff", auth.api_base);
    let fetched: Option<String> = async {
        let mut response = api_get(auth, &url).await.ok()?;
        // Streamed against the cap, and the cap is a HARD STOP mid-transfer
        // rather than a check afterwards. `Content-Length` is no use here:
        // Gitea writes this endpoint straight to the socket, so exactly the
        // large diff the cap exists for is the one that arrives chunked with no
        // length to refuse it by — and `text()` would buffer the whole
        // monorepo first and discard it second.
        let mut body: Vec<u8> = Vec::new();
        loop {
            match response.chunk().await {
                Ok(Some(chunk)) => {
                    body.extend_from_slice(&chunk);
                    // Dropped WHOLE rather than split half-read: a truncated
                    // hunk renders as a diff missing lines nobody can see are
                    // missing, which is worse than the row having no reveal.
                    if body.len() > DIFF_BYTE_CAP {
                        return None;
                    }
                }
                Ok(None) => break,
                Err(_) => return None,
            }
        }
        // Lossy: a diff carries whatever bytes the files carry, and one
        // latin-1 line must not cost every OTHER file on the page its reveal.
        Some(String::from_utf8_lossy(&body).into_owned())
    }
    .await;
    fetched.map(|diff| split_diff_by_path(&diff)).unwrap_or_default()
}

/// A unified diff cut into `path -> hunks` at each `diff --git` boundary.
///
/// What comes out is the HUNKS alone, starting at the first `@@` — the same
/// shape GitHub puts in its `patch` field and GitLab in its `diff`, so all
/// three providers hand the panel one thing to render.
fn split_diff_by_path(diff: &str) -> HashMap<String, String> {
    let lines: Vec<&str> = diff.lines().collect();
    let mut out: HashMap<String, String> = HashMap::new();
    let mut start: Option<usize> = None;
    for (i, line) in lines.iter().enumerate() {
        if line.starts_with("diff --git ") {
            // The block that just ended belongs to the PREVIOUS header.
            if let Some(begin) = start.replace(i + 1) {
                absorb(&mut out, &lines[begin..i]);
            }
        }
    }
    if let Some(begin) = start {
        absorb(&mut out, &lines[begin..]);
    }
    out
}

/// One `diff --git` block: the path it belongs to, and the hunks under it.
///
/// The path is read off the `---` / `+++` header lines rather than out of the
/// `diff --git a/x b/y` line, because that line holds TWO paths with no
/// unambiguous separator once a filename contains a space.
///
/// `+++ b/<path>` wins, and the order matters: it names the file AFTER the
/// change, which is the path `/pulls/{n}/files` reports, while `--- a/<path>`
/// names the file before it — the two differ on every rename. Only a deletion,
/// whose `+++` is `/dev/null`, falls back to the old name.
///
/// git C-quotes a path containing a space-hostile character, a `"` or a control
/// byte (`+++ "b/a\tb"`). Those are left unmatched rather than unquoted here:
/// the cost is one file row without its reveal, and a half-right unquoter would
/// attach the WRONG diff to a neighbouring path.
fn absorb(out: &mut HashMap<String, String>, block: &[&str]) {
    let first_hunk = block
        .iter()
        .position(|line| line.starts_with("@@"))
        .unwrap_or(block.len());
    let header = &block[..first_hunk];
    let path = header
        .iter()
        .find_map(|line| header_path(line, "+++ ", "b/"))
        .or_else(|| header.iter().find_map(|line| header_path(line, "--- ", "a/")));
    let Some(path) = path else { return };
    // No hunk at all — a pure mode change, or the "Binary files … differ" line
    // git emits instead of content. Nothing to reveal, so nothing is recorded
    // and the row keeps its `binary`/no-patch shape.
    if first_hunk == block.len() {
        return;
    }
    let mut body = block[first_hunk..].join("\n");
    body.push('\n');
    out.insert(path, body);
}

/// The path a `--- a/x` / `+++ b/x` header names, or `None` when the line is
/// not that header, names `/dev/null`, or is C-quoted.
///
/// Only the CR is trimmed, and both halves of that matter. A diff with CRLF
/// endings splits on `\n` and leaves a `\r` on every path, which would match
/// nothing in the file list; trimming ALL trailing whitespace would fix that
/// and introduce a worse bug, because a filename may legitimately end in a
/// space (git quotes control characters, not spaces) and `foo ` would then be
/// keyed as `foo` — handing one file's diff to another.
fn header_path(line: &str, marker: &str, prefix: &str) -> Option<String> {
    let rest = line.strip_prefix(marker)?;
    if rest.starts_with('"') {
        return None;
    }
    let path = rest.strip_prefix(prefix)?.trim_end_matches('\r');
    (!path.is_empty()).then(|| path.to_string())
}

/// Gitea's six file statuses mapped onto the four a reader distinguishes.
///
/// `deleted`, NOT GitHub's `removed` — the one word a copied mapper reads
/// straight past, turning every deletion into a modification. `copied` reads as
/// an addition (the path is new); `changed` and `unchanged` are modifications
/// with and without content, and neither warrants its own glyph.
fn file_status(raw: &str) -> ForgeFileStatus {
    match raw {
        "added" | "copied" => ForgeFileStatus::Added,
        "deleted" => ForgeFileStatus::Removed,
        "renamed" => ForgeFileStatus::Renamed,
        _ => ForgeFileStatus::Modified,
    }
}

// ── merging ─────────────────────────────────────────────────────────────────

/// Which merge methods this repository permits.
///
/// `GET /repos/{o}/{r}` — one request, asked only when the panel is about to
/// offer the button. Gitea refuses a forbidden style at merge time, so a menu
/// built without this would offer entries that can only fail.
///
/// Gitea has FIVE styles where the shared vocabulary has three, and the mapping
/// is the whole subtlety here:
///
/// - `squash` and `rebase` (a rebase with no merge commit) are
///   [`ForgeMergeMethod::Squash`] and [`ForgeMergeMethod::Rebase`] exactly.
/// - `merge`, `rebase-merge` and `fast-forward-only` are all
///   [`ForgeMergeMethod::Merge`] — one word for "join it as it is, without
///   squashing it into one commit or rewriting it onto the base and stopping
///   there" — and WHICH of the three this repository does is reported as the
///   [`ForgeMergeStrategy`], the same shape the GitLab client uses (there the
///   project decides too, and the caller cannot override it).
///
/// Folding the last three together is what stops a repository configured for
/// only `rebase-merge` (or only `fast-forward-only`) from getting an EMPTY
/// method list: the panel's fallback would then offer plain "Merge", send
/// `do: merge`, and take a 405 every single time on a repository that merges
/// perfectly well. The strategy is what keeps that honest — the menu says
/// "Merge" and the panel says what it will do to the history.
pub async fn merge_options(
    auth: &ResolvedAuth,
    owner_repo: &str,
) -> Result<ForgeMergeOptions, ForgeError> {
    let repo = repo_ref(owner_repo)?;
    let raw = repo_settings(auth, &repo).await?;

    // Absent reads as PERMITTED for the two that predate the others: they
    // default to on for a new repository, and an instance old enough to omit
    // the key permits them. Dropping a style Gitea would have accepted is the
    // failure with no recovery in the UI.
    let strategy = merge_commit_strategy(&raw);
    let methods: Vec<ForgeMergeMethod> = [
        (ForgeMergeMethod::Merge, strategy.is_some()),
        (ForgeMergeMethod::Squash, raw.allow_squash_merge.unwrap_or(true)),
        (ForgeMergeMethod::Rebase, raw.allow_rebase.unwrap_or(true)),
    ]
    .into_iter()
    .filter(|(_, allowed)| *allowed)
    .map(|(method, _)| method)
    .collect();

    // The repository's own default, when it names one this menu can offer —
    // otherwise the first entry, which is the order they are listed in.
    let preferred = raw
        .default_merge_style
        .as_deref()
        .and_then(merge_method_of)
        .filter(|method| methods.contains(method));
    Ok(ForgeMergeOptions {
        default_method: preferred
            .or_else(|| methods.first().copied())
            .unwrap_or(ForgeMergeMethod::Merge),
        methods,
        // What "Merge" will actually do here. `None` means the repository
        // permits none of the three, in which case `Merge` is not offered at
        // all and this only describes the panel's own fallback.
        merge_strategy: strategy.unwrap_or(ForgeMergeStrategy::MergeCommit),
    })
}

/// `GET /repos/{o}/{r}` — the repository's merge settings.
async fn repo_settings(
    auth: &ResolvedAuth,
    repo: &str,
) -> Result<RawRepoSettings, ForgeError> {
    let url = format!("{}/repos/{repo}", auth.api_base);
    api_get(auth, &url)
        .await?
        .json()
        .await
        .map_err(|e| ForgeError::Network(format!("bad repository payload: {e}")))
}

/// Which of Gitea's three "join it as it is" styles this repository permits,
/// or `None` when it permits none of them.
///
/// The order is a preference, not a guess: a plain merge commit is what
/// [`ForgeMergeMethod::Merge`] means where it is available, and the other two
/// only describe what happens when it is not.
///
/// Note the asymmetry in the defaults. `allow_merge_commits` absent reads as
/// PERMITTED — the incumbent rule, which keeps a payload that merely surprised
/// us from answering "nothing is permitted". The other two absent read as
/// FORBIDDEN, and that is not a contradiction: Gitea declares all of these as
/// plain `bool` with no `omitempty`, so a version that HAS the setting always
/// sends it, true or false. A missing key therefore means the instance has no
/// such merge style at all — and the two move together, `fast-forward-only`
/// having arrived in the repository payload (1.22) in the same release that
/// added it to the merge endpoint's own enum. There is no version that would
/// accept a style it declines to report.
fn merge_commit_strategy(raw: &RawRepoSettings) -> Option<ForgeMergeStrategy> {
    if raw.allow_merge_commits.unwrap_or(true) {
        return Some(ForgeMergeStrategy::MergeCommit);
    }
    if raw.allow_rebase_explicit.unwrap_or(false) {
        return Some(ForgeMergeStrategy::RebaseMerge);
    }
    if raw.allow_fast_forward_only_merge.unwrap_or(false) {
        return Some(ForgeMergeStrategy::FastForward);
    }
    None
}

/// Gitea's merge-style name in the shared vocabulary. Three of its five map to
/// [`ForgeMergeMethod::Merge`] — see [`merge_options`] for why.
fn merge_method_of(style: &str) -> Option<ForgeMergeMethod> {
    match style {
        "merge" | "rebase-merge" | "fast-forward-only" => Some(ForgeMergeMethod::Merge),
        "squash" => Some(ForgeMergeMethod::Squash),
        "rebase" => Some(ForgeMergeMethod::Rebase),
        _ => None,
    }
}

/// The `do` value one merge sends.
///
/// Required by Gitea (the only field its `MergePullRequestOption` marks so),
/// and lowercase — the JSON key is `do`. Released Gitea carries no `json` tag
/// on that field at all, so the key it matches is the Go name `Do`; both
/// `encoding/json` and the jsoniter config Gitea binds with accept a
/// case-insensitive match, which is what makes the one spelling work on every
/// version.
///
/// [`ForgeMergeMethod::Merge`] costs one extra request, because it is one word
/// for three of Gitea's styles and only the REPOSITORY knows which one it
/// permits (see [`merge_commit_strategy`]). Spent only on a deliberate,
/// irreversible action the user just asked for, and only for that one method.
async fn merge_do(auth: &ResolvedAuth, repo: &str, method: ForgeMergeMethod) -> &'static str {
    match method {
        ForgeMergeMethod::Squash => "squash",
        ForgeMergeMethod::Rebase => "rebase",
        ForgeMergeMethod::Merge => {
            match repo_settings(auth, repo).await.as_ref().ok().and_then(merge_commit_strategy) {
                Some(ForgeMergeStrategy::RebaseMerge) => "rebase-merge",
                Some(ForgeMergeStrategy::FastForward) => "fast-forward-only",
                // Includes "the settings could not be read": a merge commit is
                // what was asked for, it is what all but a deliberately
                // restricted repository permits, and Gitea refuses it in as
                // many words if this one does not.
                _ => "merge",
            }
        }
    }
}

/// Merge one pull request, and hand back the row the forge now serves.
///
/// Two requests, and the second is why the return is an `Option`. `POST
/// /pulls/{n}/merge` answers 200 with an EMPTY body, so the row the panel and
/// the list adopt has to be re-read — through the pull payload, because its
/// `merged` flag is the only thing that tells a merged change from a closed one.
///
/// `Ok(None)` means IT MERGED AND THE RE-READ FAILED. That is not an error: the
/// merge is irreversible and already done, so reporting a network blip on the
/// second request as a failure would invite somebody to do it again.
///
/// `head_commit_id`, when given, is the commit the caller was looking at. Gitea
/// refuses the merge if the branch has moved since — which is the entire point
/// of passing it.
pub async fn merge_change(
    auth: &ResolvedAuth,
    owner_repo: &str,
    number: i64,
    method: ForgeMergeMethod,
    head_sha: Option<&str>,
) -> Result<Option<ForgeIssueRow>, ForgeError> {
    let repo = repo_ref(owner_repo)?;
    require_number(number)?;
    let url = format!("{}/repos/{repo}/pulls/{number}/merge", auth.api_base);
    let mut payload = serde_json::json!({ "do": merge_do(auth, &repo, method).await });
    if let Some(sha) = head_sha {
        payload["head_commit_id"] = serde_json::Value::String(sha.to_string());
    }
    // A 405 (not mergeable, or this style is forbidden here) and a 409 (the
    // branch moved) have already become `ForgeError::Api` with Gitea's own
    // sentence in them.
    api_post(auth, &url, &payload).await?;

    // Past this line the change HAS landed, so nothing below may return `Err`.
    let url = format!("{}/repos/{repo}/pulls/{number}", auth.api_base);
    let raw: Option<RawIssue> = async { api_get(auth, &url).await.ok()?.json().await.ok() }.await;
    Ok(raw.map(|raw| raw.into_row(true)))
}

// ── delivery ────────────────────────────────────────────────────────────────

/// How far back [`find_pulls`] will look for a pull request headed by one
/// branch. See that function for why there is a limit at all.
const PR_SCAN_PAGES: u32 = 5;
/// Rows asked for per scan page. Gitea clamps this to its own
/// `MAX_RESPONSE_ITEMS`, 50 by default — asking for more costs nothing and
/// helps on an instance configured higher.
const PR_SCAN_PAGE_SIZE: u32 = 50;

/// Pull requests whose head is `head_branch`, in ANY state — a merged or closed
/// one is exactly what recovery must be able to see.
///
/// Filtered LOCALLY, because Gitea's `/pulls` takes a `base_branch` filter and
/// no head one, and its `/pulls/{base}/{head}` lookup answers with a single
/// arbitrary row when a branch has both a closed pull request and a newer open
/// one — which is the case that decides whether a task settles or bounces.
///
/// So the scan is bounded: the [`PR_SCAN_PAGES`] most recent pages, newest
/// first, stopping as soon as the forge runs out. That covers what this is for
/// — a branch this delivery pushed, whose pull request is either brand new or
/// the one codeg opened for it last time — and it is the one place this client
/// can be incomplete. It fails SAFE: an unseen pull request reads as
/// [`super::deliver::PrAdoption::NoMatch`], and the create that follows is
/// refused by Gitea itself ("this pull request already exists") rather than
/// duplicating anything.
pub async fn find_pulls(
    auth: &ResolvedAuth,
    owner_repo: &str,
    head_branch: &str,
) -> Result<Vec<ForgePr>, ForgeError> {
    let repo = repo_ref(owner_repo)?;
    let mut found = Vec::new();
    for page in 1..=PR_SCAN_PAGES {
        let url = format!(
            "{}/repos/{repo}/pulls?state=all&page={page}&limit={PR_SCAN_PAGE_SIZE}",
            auth.api_base
        );
        let raw: Vec<RawPull> = api_get(auth, &url)
            .await?
            .json()
            .await
            .map_err(|e| ForgeError::Network(format!("bad pulls payload: {e}")))?;
        let exhausted = raw.is_empty();
        found.extend(
            raw.into_iter()
                .filter(|pull| {
                    pull.head.as_ref().is_some_and(|h| h.ref_name == head_branch)
                })
                .map(RawPull::into_pr),
        );
        if exhausted {
            break;
        }
    }
    Ok(found)
}

/// `GET /repos/{o}/{r}/pulls/{n}` — one pull request by number.
pub async fn get_pull(
    auth: &ResolvedAuth,
    owner_repo: &str,
    number: i64,
) -> Result<ForgePr, ForgeError> {
    let repo = repo_ref(owner_repo)?;
    require_number(number)?;
    let url = format!("{}/repos/{repo}/pulls/{number}", auth.api_base);
    let raw: RawPull = api_get(auth, &url)
        .await?
        .json()
        .await
        .map_err(|e| ForgeError::Network(format!("bad pull payload: {e}")))?;
    Ok(raw.into_pr())
}

/// `POST /repos/{o}/{r}/pulls`.
///
/// Gitea has no `draft` parameter: a draft IS a title carrying one of the
/// instance's work-in-progress prefixes, which is also how its UI toggles the
/// state. `WIP:` is the first of the two shipped defaults, so prefixing is the
/// supported way to open one — the same trick GitLab needs, with a different
/// word.
pub async fn create_pull(
    auth: &ResolvedAuth,
    owner_repo: &str,
    req: &NewPullRequest<'_>,
) -> Result<ForgePr, ForgeError> {
    let repo = repo_ref(owner_repo)?;
    let url = format!("{}/repos/{repo}/pulls", auth.api_base);
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
    Ok(raw.into_pr())
}

/// Whether a title already declares itself a draft, so it is not prefixed
/// twice. Both of Gitea's shipped defaults are recognised.
///
/// `get(..n)` rather than `[..n]`: a title is arbitrary user text, and slicing
/// bytes through the middle of a code point PANICS.
fn is_wip_title(title: &str) -> bool {
    let trimmed = title.trim_start();
    ["wip:", "[wip]"]
        .iter()
        .any(|prefix| trimmed.get(..prefix.len()).is_some_and(|got| got.eq_ignore_ascii_case(prefix)))
}

// ── plumbing ────────────────────────────────────────────────────────────────

/// `GET {api_base}/user` → login, cached per `(api_base, account)` — resolving
/// it on every "assigned to me" page would spend a request per click.
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

/// `owner/repo`, validated. Gitea addresses a repository with two path segments
/// like GitHub does — there are no subgroups to encode into one, which is what
/// makes this the GitHub spelling rather than GitLab's.
fn repo_ref(owner_repo: &str) -> Result<String, ForgeError> {
    super::normalize_repo(owner_repo)
        .ok_or_else(|| ForgeError::Invalid(format!("bad repository path: {owner_repo}")))
}

fn require_number(number: i64) -> Result<(), ForgeError> {
    if number <= 0 {
        return Err(ForgeError::Invalid(format!("bad work item number: {number}")));
    }
    Ok(())
}

fn header_i64(headers: &reqwest::header::HeaderMap, name: &str) -> Option<i64> {
    headers.get(name)?.to_str().ok()?.trim().parse().ok()
}

/// Whether Gitea's `Link` header offers a `rel="next"`.
///
/// The alternative — "the page came back full, so there is probably more" —
/// promises an empty next page whenever the total is an exact multiple of the
/// page size, and here it would be wrong more often still: Gitea clamps `limit`
/// to its own maximum, so a full page is not even evidence the page was full.
///
/// Gitea's own `Link` URLs are known to drop the query string (its issue
/// #7296); only the PRESENCE of the relation is read, never the URL.
fn has_next_link(headers: &reqwest::header::HeaderMap) -> bool {
    headers
        .get_all("link")
        .iter()
        .filter_map(|value| value.to_str().ok())
        .any(|header| {
            header.split(',').any(|part| {
                part.split(';')
                    .skip(1)
                    .any(|param| param.trim().eq_ignore_ascii_case("rel=\"next\""))
            })
        })
}

pub(crate) async fn api_get(
    auth: &ResolvedAuth,
    url: &str,
) -> Result<reqwest::Response, ForgeError> {
    let response = super::http_client()?
        .get(url)
        .header("Authorization", format!("token {}", auth.token))
        .header("User-Agent", "codeg")
        // Not `application/json`: one endpoint here (`/pulls/{n}.diff`) answers
        // with text, and Gitea serves what the route produces regardless — but
        // a header that contradicts the route is a needless thing to explain.
        .header("Accept", "*/*")
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

/// Authenticated PATCH — how Gitea spells "edit an existing thing", following
/// GitHub rather than GitLab's PUT.
pub(crate) async fn api_patch(
    auth: &ResolvedAuth,
    url: &str,
    body: &serde_json::Value,
) -> Result<reqwest::Response, ForgeError> {
    send(super::http_client()?.patch(url), auth, body).await
}

/// The headers and failure taxonomy every write shares. Writes are never
/// retried here: a retried create could open a duplicate pull request or post a
/// comment twice, so the caller decides.
async fn send(
    request: reqwest::RequestBuilder,
    auth: &ResolvedAuth,
    body: &serde_json::Value,
) -> Result<reqwest::Response, ForgeError> {
    let response = request
        .header("Authorization", format!("token {}", auth.token))
        .header("User-Agent", "codeg")
        .header("Accept", "application/json")
        .json(body)
        .send()
        .await
        .map_err(|e| ForgeError::Network(e.to_string()))?;
    finish(response).await
}

/// Success through, everything else classified.
///
/// Gitea ships no API rate limiter of its own — an instance that limits does it
/// in the reverse proxy in front, which answers the standard 429 with a
/// `Retry-After`. So, unlike GitHub, a 403 here really is about the credential.
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
        401 | 403 => ForgeError::Auth(format!("Gitea returned {status}")),
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

// ── wire shapes ─────────────────────────────────────────────────────────────

/// One issue, or one pull request, in the shape a workbench row needs.
///
/// Both payloads deserialize into this: an `Issue` carries the merge and draft
/// facts under `pull_request`, while the `PullRequest` that `PATCH /pulls/{n}`
/// answers with carries them at the TOP level and no `pull_request` key at all.
/// Reading both is what keeps a merged pull request from being painted
/// "closed" after a state change.
#[derive(Debug, Deserialize)]
struct RawIssue {
    #[serde(default)]
    number: i64,
    #[serde(default)]
    title: String,
    #[serde(default)]
    body: Option<String>,
    /// `open` | `closed`. Gitea has no merged STATE — a merged pull request
    /// reports `closed` — so `merged` below is what tells them apart.
    #[serde(default)]
    state: String,
    /// Pull payload only.
    #[serde(default)]
    merged: bool,
    /// Pull payload only.
    #[serde(default)]
    draft: bool,
    /// Issue payload only; its presence is also what marks the item a pull
    /// request in a mixed feed.
    #[serde(default)]
    pull_request: Option<RawPullMeta>,
    #[serde(default)]
    labels: Vec<RawLabel>,
    #[serde(default)]
    user: Option<RawUser>,
    #[serde(default)]
    updated_at: Option<String>,
    #[serde(default)]
    html_url: String,
    /// Human comments; Gitea's timeline events are a different comment type and
    /// are not counted here.
    #[serde(default)]
    comments: i64,
}

#[derive(Debug, Deserialize)]
struct RawPullMeta {
    #[serde(default)]
    merged: bool,
    #[serde(default)]
    draft: bool,
}

impl RawIssue {
    /// One issue or pull request, as the workbench row.
    ///
    /// `is_pr` is an ARGUMENT rather than `pull_request.is_some()`, because the
    /// two payloads that land here disagree about it: a pull request listed
    /// through `/issues?type=pulls` carries the key, and the pull object
    /// `PATCH /pulls/{n}` returns does not carry it at all. Deriving it would
    /// turn every state change on a pull request into a row that claims to be
    /// an issue — wrong glyph, wrong link, wrong comment collection.
    fn into_row(self, is_pr: bool) -> ForgeIssueRow {
        let meta = self.pull_request.as_ref();
        let merged = self.merged || meta.is_some_and(|m| m.merged);
        let draft = self.draft || meta.is_some_and(|m| m.draft);
        let (author, author_avatar) = match self.user {
            Some(user) => (
                ForgeComment::author_name(Some(user.login)),
                user.avatar_url.as_deref().and_then(sanitize_web_url),
            ),
            None => (None, None),
        };
        ForgeIssueRow {
            is_pr,
            number: self.number,
            title: self.title,
            body: self.body.map(|b| truncate_chars(&b, BODY_CAP)),
            state: pull_state(&self.state, merged),
            draft: is_pr && draft,
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

/// `open` / `closed` / `merged`, the three words the rest of codeg understands.
/// Gitea only has the first two; `merged` is derived, exactly as on GitHub.
fn pull_state(state: &str, merged: bool) -> String {
    if merged {
        "merged".to_string()
    } else {
        state.to_string()
    }
}

#[derive(Debug, Deserialize)]
struct RawUser {
    #[serde(default)]
    login: String,
    /// Gitea always answers with one — a generated identicon when the user
    /// never uploaded a picture — so a row without an avatar means the payload
    /// had no user at all.
    #[serde(default)]
    avatar_url: Option<String>,
}

#[derive(Debug, Deserialize)]
struct RawLabel {
    /// Load-bearing for [`create_issue`] alone: Gitea applies labels to a new
    /// issue by id, and this is where those ids come from.
    #[serde(default)]
    id: i64,
    #[serde(default)]
    name: String,
    /// Six hex digits with no leading `#`, like GitHub's — but older instances
    /// send it with one, which the shared normalizer accepts either way.
    #[serde(default)]
    color: Option<String>,
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
    user: Option<RawUser>,
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

/// What a pull request's head repository is called when Gitea does not name it
/// — a fork deleted since the change was opened.
///
/// Deliberately NOT a repository path, and the missing slash is the whole
/// point: `normalize_repo` refuses it, which is exactly the test
/// [`super::deliver::pull_is_workable`] uses to refuse a task whose commits
/// would have nowhere to be pushed. A well-formed placeholder would pass that
/// gate and fail hours later, at the push. It is also not `same_repo` to
/// anything, so every other gate reads it as "somewhere else".
const UNKNOWN_HEAD_REPO: &str = "unknown-head-repository";

#[derive(Debug, Deserialize)]
struct RawPull {
    #[serde(default)]
    number: i64,
    #[serde(default)]
    html_url: String,
    #[serde(default)]
    state: String,
    #[serde(default)]
    merged: bool,
    #[serde(default)]
    draft: bool,
    /// A plain boolean here, not GitHub's tri-state — see [`change_detail`].
    #[serde(default)]
    mergeable: bool,
    /// Present on the SINGLE pull request only; Gitea deliberately leaves these
    /// out of the list payload because computing a diff per row is slow.
    #[serde(default)]
    additions: Option<i64>,
    #[serde(default)]
    deletions: Option<i64>,
    #[serde(default)]
    changed_files: Option<i64>,
    #[serde(default)]
    head: Option<RawPullRef>,
    #[serde(default)]
    base: Option<RawPullRef>,
}

impl RawPull {
    /// The delivery view of a pull request.
    ///
    /// `head_repo` falls back to [`UNKNOWN_HEAD_REPO`] when Gitea does not name
    /// the head repository — which is what a fork deleted since the pull
    /// request was opened looks like.
    fn into_pr(self) -> ForgePr {
        let head = self.head.as_ref();
        ForgePr {
            number: self.number,
            html_url: self.html_url,
            state: pull_state(&self.state, self.merged),
            merged: self.merged,
            head_sha: head.and_then(|h| h.sha.clone()).unwrap_or_default(),
            head_ref: head.map(|h| h.ref_name.clone()).unwrap_or_default(),
            head_repo: head
                .and_then(|h| h.repo.as_ref())
                .and_then(|r| r.full_name.clone())
                .filter(|full| !full.is_empty())
                .unwrap_or_else(|| UNKNOWN_HEAD_REPO.to_string()),
            base_ref: self.base.map(|b| b.ref_name).unwrap_or_default(),
        }
    }
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

#[derive(Debug, Deserialize)]
struct RawCombinedStatus {
    #[serde(default)]
    statuses: Vec<RawCommitStatus>,
}

#[derive(Debug, Deserialize)]
struct RawCommitStatus {
    #[serde(default)]
    id: i64,
    /// The status' name — `context`, as on GitHub.
    #[serde(default)]
    context: String,
    /// `pending` | `success` | `error` | `failure` | `warning`. Note the FIELD
    /// is `status` here, where GitHub's is `state`.
    #[serde(default)]
    status: String,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    target_url: Option<String>,
}

#[derive(Debug, Deserialize)]
struct RawChangedFile {
    #[serde(default)]
    filename: String,
    #[serde(default)]
    previous_filename: Option<String>,
    /// added | deleted | modified | renamed | copied | changed | unchanged.
    #[serde(default)]
    status: String,
    #[serde(default)]
    additions: i64,
    #[serde(default)]
    deletions: i64,
}

/// A repository's merge settings — Gitea's five styles, each its own flag.
///
/// `Option` throughout rather than `#[serde(default)]` onto `false`: that would
/// answer "no style permitted" for any payload that surprised us, and the
/// difference between "Gitea did not say" and "Gitea said no" is what
/// [`merge_commit_strategy`] turns into a working menu on an old instance.
#[derive(Debug, Deserialize)]
struct RawRepoSettings {
    /// Join with a merge commit. Defaults to TRUE on a repository.
    #[serde(default)]
    allow_merge_commits: Option<bool>,
    #[serde(default)]
    allow_squash_merge: Option<bool>,
    /// A rebase with NO merge commit — [`ForgeMergeMethod::Rebase`] exactly.
    #[serde(default)]
    allow_rebase: Option<bool>,
    /// Rebase, THEN write a merge commit anyway. A different shape from
    /// `allow_rebase`, and a repository may permit either without the other.
    #[serde(default)]
    allow_rebase_explicit: Option<bool>,
    /// Fast-forward, refusing the merge when that is not possible.
    #[serde(default)]
    allow_fast_forward_only_merge: Option<bool>,
    /// `merge` | `rebase` | `rebase-merge` | `squash` | `fast-forward-only`.
    #[serde(default)]
    default_merge_style: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::forge::ForgeProvider;
    use axum::extract::Query;
    use axum::routing::{get, patch, post};
    use axum::Json;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};

    fn auth_for(api_base: String) -> ResolvedAuth {
        ResolvedAuth {
            provider: ForgeProvider::Gitea,
            server_host: "gitea.test".into(),
            api_base,
            account_id: "acc-test".into(),
            username: "alice".into(),
            avatar_url: Some("https://gitea.test/avatars/alice".into()),
            token: "tok-test".into(),
            // Gitea reports none, ever — see `validate_gitea_token`.
            scopes: vec![],
        }
    }

    /// One row of the issues feed. `pull_request` is what marks a hit a pull
    /// request AND where its merge/draft facts live on this payload.
    fn issue_json(number: i64, state: &str, pull: Option<(bool, bool)>) -> serde_json::Value {
        let mut v = serde_json::json!({
            "number": number,
            "title": format!("item {number}"),
            "body": format!("body {number}"),
            "state": state,
            "comments": number,
            "updated_at": "2026-09-01T00:00:00Z",
            "html_url": format!("https://gitea.test/acme/app/issues/{number}"),
            "user": { "login": "alice", "avatar_url": "https://gitea.test/avatars/alice" },
            // Bare six-digit hex, Gitea's own spelling — no leading `#`. The
            // nameless one is what an empty label would render as: a chip with
            // nothing in it and nothing to filter by.
            "labels": [{ "id": 3, "name": "bug", "color": "D73A4A" }, { "id": 4, "name": "" }],
        });
        if let Some((merged, draft)) = pull {
            v["pull_request"] = serde_json::json!({ "merged": merged, "draft": draft });
        }
        v
    }

    /// One pull request in the shape `/pulls/{n}` answers with — merge and
    /// draft facts at the TOP level, and no `pull_request` key at all.
    fn pull_json(number: i64, state: &str, merged: bool, head: &str) -> serde_json::Value {
        serde_json::json!({
            "number": number,
            "title": format!("change {number}"),
            "state": state,
            "merged": merged,
            "draft": false,
            "mergeable": true,
            "comments": 2,
            "additions": 12,
            "deletions": 3,
            "changed_files": 2,
            "html_url": format!("https://gitea.test/acme/app/pulls/{number}"),
            "user": { "login": "alice" },
            // Canonical casing, as Gitea stores it — `same_repo` has to be what
            // decides this is not a fork.
            "head": { "ref": head, "sha": "deadbee", "repo": { "full_name": "Acme/App" } },
            "base": { "ref": "main", "sha": "cafe", "repo": { "full_name": "acme/app" } },
        })
    }

    /// What the mock recorded, so a test can assert what was ASKED rather than
    /// infer it from what came back.
    #[derive(Default)]
    struct Seen {
        /// Query parameters of the last `/issues` list request.
        list_query: Mutex<HashMap<String, String>>,
        /// `(what, body)` for every write.
        wrote: Mutex<Vec<(String, serde_json::Value)>>,
        /// How many times `/user` was asked — the login cache's whole job.
        user_hits: AtomicUsize,
        /// Which `/pulls` list pages the bounded scan asked for.
        pull_pages: Mutex<Vec<u32>>,
        /// Flipped by the merge endpoint, so the re-read after it tells the
        /// truth instead of repeating the pre-merge row.
        merged: AtomicBool,
    }

    impl Seen {
        fn wrote(&self, what: &str) -> Vec<serde_json::Value> {
            self.wrote
                .lock()
                .unwrap()
                .iter()
                .filter(|(kind, _)| kind == what)
                .map(|(_, body)| body.clone())
                .collect()
        }
    }

    /// A mock Gitea mounted at `/api/v1`, holding one repository (`acme/app`).
    async fn mock_api() -> (String, Arc<Seen>) {
        let seen = Arc::new(Seen::default());
        let app = axum::Router::new()
            .route("/api/v1/repos/acme/app/issues", {
                let reader = seen.clone();
                let writer = seen.clone();
                get(move |Query(q): Query<HashMap<String, String>>| async move {
                    *reader.list_query.lock().unwrap() = q.clone();
                    let page: u32 = q.get("page").and_then(|p| p.parse().ok()).unwrap_or(1);
                    let mut headers = axum::http::HeaderMap::new();
                    headers.insert("x-total-count", "3".parse().unwrap());
                    if page < 2 {
                        headers.insert(
                            "link",
                            "</api/v1/repos/acme/app/issues?page=2>; rel=\"next\""
                                .parse()
                                .unwrap(),
                        );
                    }
                    let rows = if q.get("assigned_by").map(String::as_str) == Some("alice") {
                        vec![issue_json(9, "open", None)]
                    } else if page >= 2 {
                        vec![issue_json(3, "open", None)]
                    } else if q.get("type").map(String::as_str) == Some("pulls") {
                        vec![
                            // Merged reports `closed` — the derivation this
                            // covers — with a draft beside it.
                            issue_json(5, "closed", Some((true, false))),
                            issue_json(6, "open", Some((false, true))),
                        ]
                    } else {
                        vec![issue_json(1, "open", None)]
                    };
                    (headers, Json(serde_json::Value::Array(rows)))
                })
                .post(move |Json(body): Json<serde_json::Value>| {
                    writer.wrote.lock().unwrap().push(("issue".into(), body));
                    async { Json(issue_json(12, "open", None)) }
                })
            })
            .route(
                "/api/v1/repos/acme/app/labels",
                get(|| async {
                    let mut headers = axum::http::HeaderMap::new();
                    // More than came back: Gitea clamps `limit` to its own
                    // maximum, so only this header can say the list is partial.
                    headers.insert("x-total-count", "140".parse().unwrap());
                    (
                        headers,
                        Json(serde_json::json!([
                            { "id": 3, "name": "bug", "color": "d73a4a" },
                            { "id": 7, "name": "Help Wanted", "color": "#0e8a16" },
                            { "id": 8, "name": "", "color": "ffffff" },
                        ])),
                    )
                }),
            )
            .route("/api/v1/repos/acme/app/issues/7/comments", {
                let writer = seen.clone();
                get(|| async {
                    // UNPAGINATED, which is the whole point: Gitea answers with
                    // every comment there is and the page is cut client-side.
                    Json(serde_json::json!([
                        {
                            "id": 101,
                            "body": "cannot reproduce",
                            "created_at": "2026-09-01T00:00:00Z",
                            // Same stamp as `created_at`: never edited.
                            "updated_at": "2026-09-01T00:00:00Z",
                            "html_url": "https://gitea.test/acme/app/issues/7#issuecomment-101",
                            // A self-managed instance can answer with anything
                            // at all, and this lands in an <img src>.
                            "user": { "login": "alice", "avatar_url": "javascript:alert(1)" },
                        },
                        {
                            "id": 102,
                            "body": "reworded",
                            "created_at": "2026-09-01T00:00:00Z",
                            "updated_at": "2026-09-01T09:00:00Z",
                            "html_url": "https://gitea.test/acme/app/issues/7#issuecomment-102",
                            "user": { "login": "alice", "avatar_url": "https://gitea.test/avatars/alice" },
                        },
                        { "id": 103, "body": "third" },
                    ]))
                })
                .post(move |Json(body): Json<serde_json::Value>| {
                    writer.wrote.lock().unwrap().push(("comment".into(), body));
                    async {
                        Json(serde_json::json!({
                            "id": 200,
                            "body": "posted",
                            "created_at": "2026-09-02T00:00:00Z",
                            "updated_at": "2026-09-02T00:00:00Z",
                            "html_url": "https://gitea.test/acme/app/issues/7#issuecomment-200",
                            "user": { "login": "alice" },
                        }))
                    }
                })
            })
            .route("/api/v1/repos/acme/app/issues/7", {
                let writer = seen.clone();
                patch(move |Json(body): Json<serde_json::Value>| {
                    writer.wrote.lock().unwrap().push(("issue-state".into(), body));
                    async { Json(issue_json(7, "closed", None)) }
                })
            })
            .route("/api/v1/repos/acme/app/pulls/4", {
                let reader = seen.clone();
                let writer = seen.clone();
                get(move || async move {
                    let merged = reader.merged.load(Ordering::SeqCst);
                    Json(pull_json(
                        4,
                        if merged { "closed" } else { "open" },
                        merged,
                        "feature",
                    ))
                })
                .patch(move |Json(body): Json<serde_json::Value>| {
                    writer.wrote.lock().unwrap().push(("pull-state".into(), body));
                    // Merged in the browser while the panel was open: the one
                    // case a local `state` flip would get wrong.
                    async { Json(pull_json(4, "closed", true, "feature")) }
                })
            })
            .route("/api/v1/repos/acme/app/pulls/4/merge", {
                let writer = seen.clone();
                post(move |Json(body): Json<serde_json::Value>| {
                    writer.wrote.lock().unwrap().push(("merge".into(), body));
                    writer.merged.store(true, Ordering::SeqCst);
                    // Gitea answers 200 with an EMPTY body — which is why the
                    // row has to be re-read.
                    async { axum::http::StatusCode::OK }
                })
            })
            .route(
                "/api/v1/repos/acme/app/pulls/4/files",
                get(|| async {
                    Json(serde_json::json!([
                        { "filename": "src/lib.rs", "status": "changed", "additions": 3, "deletions": 1 },
                        // `deleted`, NOT GitHub's `removed`.
                        { "filename": "old.txt", "status": "deleted", "additions": 0, "deletions": 2 },
                        { "filename": "new name.rs", "previous_filename": "old/name.rs",
                          "status": "renamed", "additions": 1, "deletions": 0 },
                        { "filename": "logo.png", "status": "added", "additions": 0, "deletions": 0 },
                    ]))
                }),
            )
            .route(
                "/api/v1/repos/acme/app/pulls/4.diff",
                // The whole change in one payload — there is no per-file diff
                // endpoint, which is why this is fetched and split.
                get(|| async {
                    concat!(
                        "diff --git a/src/lib.rs b/src/lib.rs\n",
                        "index 111..222 100644\n",
                        "--- a/src/lib.rs\n",
                        "+++ b/src/lib.rs\n",
                        "@@ -1,2 +1,4 @@\n",
                        " keep\n",
                        "+one\n",
                        "-gone\n",
                        "diff --git a/old.txt b/old.txt\n",
                        "deleted file mode 100644\n",
                        "--- a/old.txt\n",
                        "+++ /dev/null\n",
                        "@@ -1,2 +0,0 @@\n",
                        "-a\n",
                        "-b\n",
                        // A path with a space in it — the reason the path is
                        // read off `+++` rather than out of the `diff --git`
                        // line, which holds two paths and no separator.
                        "diff --git a/old/name.rs b/new name.rs\n",
                        "similarity index 90%\n",
                        "--- a/old/name.rs\n",
                        "+++ b/new name.rs\n",
                        "@@ -1 +1,2 @@\n",
                        " same\n",
                        "+added\n",
                        "diff --git a/logo.png b/logo.png\n",
                        "Binary files a/logo.png and b/logo.png differ\n",
                    )
                }),
            )
            .route(
                "/api/v1/repos/acme/app/commits/deadbee/status",
                get(|| async {
                    Json(serde_json::json!({
                        "state": "failure",
                        "statuses": [
                            { "id": 1, "context": "build", "status": "success",
                              "description": "ok", "target_url": "https://ci.test/1" },
                            { "id": 2, "context": "lint", "status": "failure",
                              "target_url": "javascript:alert(1)" },
                            { "id": 3, "context": "deploy", "status": "pending" },
                            { "id": 4, "context": "flaky", "status": "warning" },
                        ],
                    }))
                }),
            )
            .route("/api/v1/repos/acme/app/pulls", {
                let reader = seen.clone();
                let writer = seen.clone();
                get(move |Query(q): Query<HashMap<String, String>>| async move {
                    let page: u32 = q.get("page").and_then(|p| p.parse().ok()).unwrap_or(1);
                    reader.pull_pages.lock().unwrap().push(page);
                    // Two pages of history, then nothing — which is what stops
                    // the scan before its own ceiling.
                    let rows = match page {
                        1 => vec![
                            pull_json(4, "open", false, "feature"),
                            pull_json(3, "open", false, "somebody-else"),
                        ],
                        2 => vec![pull_json(2, "closed", false, "feature")],
                        _ => vec![],
                    };
                    Json(serde_json::Value::Array(rows))
                })
                .post(move |Json(body): Json<serde_json::Value>| {
                    writer.wrote.lock().unwrap().push(("pull".into(), body));
                    async { Json(pull_json(8, "open", false, "codeg/task-1")) }
                })
            })
            .route(
                "/api/v1/repos/acme/app",
                get(|| async {
                    Json(serde_json::json!({
                        "allow_merge_commits": true,
                        "allow_squash_merge": true,
                        // Forbidden here — the menu must not offer it.
                        "allow_rebase": false,
                        "default_merge_style": "squash",
                    }))
                }),
            )
            .route("/api/v1/user", {
                let reader = seen.clone();
                get(move || async move {
                    reader.user_hits.fetch_add(1, Ordering::SeqCst);
                    Json(serde_json::json!({ "login": "alice" }))
                })
            });
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        (format!("http://{addr}/api/v1"), seen)
    }

    /// A mock holding ONE repository whose merge settings are `settings`, plus
    /// the two endpoints a merge touches. Separate from [`mock_api`] because
    /// these tests are about a repository configured differently, and threading
    /// a variant through the big mock would make every other test read as if it
    /// depended on the settings.
    async fn mock_repo_with(settings: serde_json::Value) -> (String, Arc<Seen>) {
        let seen = Arc::new(Seen::default());
        let app = axum::Router::new()
            .route(
                "/api/v1/repos/acme/app",
                get(move || {
                    let settings = settings.clone();
                    async move { Json(settings) }
                }),
            )
            .route("/api/v1/repos/acme/app/pulls/4/merge", {
                let writer = seen.clone();
                post(move |Json(body): Json<serde_json::Value>| {
                    writer.wrote.lock().unwrap().push(("merge".into(), body));
                    async { axum::http::StatusCode::OK }
                })
            })
            .route(
                "/api/v1/repos/acme/app/pulls/4",
                get(|| async { Json(pull_json(4, "closed", true, "feature")) }),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        (format!("http://{addr}/api/v1"), seen)
    }

    fn req(tab: ForgeTab, state: &str) -> ListIssuesRequest {
        ListIssuesRequest {
            owner_repo: "Acme/App".into(),
            tab,
            state: state.into(),
            assigned_me: false,
            labels: vec![],
            search: None,
            sort: super::super::ForgeSort::default(),
            page: 1,
            per_page: 20,
        }
    }

    /// The list, end to end: the `type=` split that makes real page numbers
    /// possible, `X-Total-Count` as the total, `Link: rel="next"` as the only
    /// thing that says another page exists, and the row mapping.
    #[tokio::test]
    async fn the_list_splits_by_type_and_pages_on_the_headers() {
        let (api_base, seen) = mock_api().await;
        let auth = auth_for(api_base);

        let list = list_issues(&auth, &req(ForgeTab::Issues, "open")).await.expect("list");
        {
            let q = seen.list_query.lock().unwrap();
            assert_eq!(q.get("type").map(String::as_str), Some("issues"));
            assert_eq!(q.get("state").map(String::as_str), Some("open"));
            // Gitea's page size parameter is `limit`; `per_page` is silently
            // ignored, which would serve a default-sized page forever.
            assert_eq!(q.get("limit").map(String::as_str), Some("20"));
            assert!(q.get("per_page").is_none());
            // The list endpoint takes no order at all (Gitea hard-codes
            // newest-first), so sending one would only look like it worked.
            assert!(q.get("sort").is_none());
        }

        let row = &list.rows[0];
        assert_eq!(row.number, 1);
        assert_eq!(row.body.as_deref(), Some("body 1"));
        assert!(!row.is_pr);
        assert_eq!(row.comments, 1);
        assert_eq!(row.author.as_deref(), Some("alice"));
        assert_eq!(
            row.author_avatar.as_deref(),
            Some("https://gitea.test/avatars/alice")
        );
        assert_eq!(
            row.labels,
            vec![ForgeLabel { name: "bug".into(), color: Some("#d73a4a".into()) }],
            "the nameless label is dropped, and the bare hex gains its hash"
        );
        assert_eq!((list.page, list.per_page), (1, 20));
        assert_eq!(list.total_count, Some(3));
        assert_eq!(list.reachable_count, None, "no search ceiling here");
        assert!(!list.incomplete);
        assert!(list.has_next);

        let page2 = list_issues(&auth, &ListIssuesRequest { page: 2, ..req(ForgeTab::Issues, "open") })
            .await
            .expect("page 2");
        assert_eq!(page2.rows[0].number, 3);
        assert!(!page2.has_next, "no Link header is the end of the list");
    }

    /// Gitea has no merged STATE — a merged pull request reports `closed`, and
    /// only `pull_request.merged` tells them apart. Painting one "closed" is
    /// the whole failure this covers; the draft beside it is the other fact
    /// that only exists under that key on this payload.
    #[tokio::test]
    async fn the_pr_tab_derives_merged_and_draft_from_the_pull_request_key() {
        let (api_base, seen) = mock_api().await;
        let auth = auth_for(api_base);
        let list = list_issues(&auth, &req(ForgeTab::Prs, "open")).await.expect("list");
        assert_eq!(
            seen.list_query.lock().unwrap().get("type").map(String::as_str),
            Some("pulls")
        );
        assert!(list.rows.iter().all(|r| r.is_pr));
        assert_eq!(list.rows[0].state, "merged", "closed + merged is not closed");
        assert!(!list.rows[0].draft);
        assert_eq!(list.rows[1].state, "open");
        assert!(list.rows[1].draft);
    }

    /// "Assigned to me" is a literal login (there is no `@me` here), resolved
    /// through `/user` and CACHED — otherwise every click on the pill spends a
    /// request to learn a name that cannot change.
    #[tokio::test]
    async fn assigned_to_me_resolves_the_login_once_and_filters_by_it() {
        let (api_base, seen) = mock_api().await;
        let auth = auth_for(api_base);
        let mine = ListIssuesRequest {
            assigned_me: true,
            labels: vec!["bug".into(), "help wanted".into()],
            search: Some("crash on save".into()),
            ..req(ForgeTab::Issues, "all")
        };
        let list = list_issues(&auth, &mine).await.expect("list");
        assert_eq!(list.rows[0].number, 9);
        {
            let q = seen.list_query.lock().unwrap();
            assert_eq!(q.get("assigned_by").map(String::as_str), Some("alice"));
            // Comma-joined and ANDed, and the free text goes over as TEXT —
            // Gitea's `q` is handed to its indexer, not parsed as a query
            // language, so there is no syntax to strip.
            assert_eq!(q.get("labels").map(String::as_str), Some("bug,help wanted"));
            assert_eq!(q.get("q").map(String::as_str), Some("crash on save"));
        }
        list_issues(&auth, &mine).await.expect("list again");
        assert_eq!(seen.user_hits.load(Ordering::SeqCst), 1, "the login is cached");
    }

    /// The label filter's vocabulary. `truncated` has to come from the count
    /// header: Gitea clamps `limit` to its own maximum (50 by default), so "we
    /// asked for 100 and got 100" is a test that never fires, and a repository
    /// with 140 labels would silently look complete.
    #[tokio::test]
    async fn labels_report_truncation_from_the_count_not_from_a_full_page() {
        let (api_base, _) = mock_api().await;
        let list = list_labels(&auth_for(api_base), "acme/app").await.expect("labels");
        assert_eq!(
            list.labels,
            vec![
                ForgeLabel { name: "bug".into(), color: Some("#d73a4a".into()) },
                ForgeLabel { name: "Help Wanted".into(), color: Some("#0e8a16".into()) },
            ],
            "both spellings of the colour are accepted; the nameless one is dropped"
        );
        assert!(list.truncated, "140 exist and three came back");
    }

    /// The comment collection is UNPAGINATED — Gitea hands over every comment
    /// there is — so the page is cut here, and `has_next` is a fact about the
    /// slice rather than a header to trust.
    #[tokio::test]
    async fn comments_are_paged_locally_because_gitea_sends_them_all() {
        let (api_base, _) = mock_api().await;
        let auth = auth_for(api_base);

        let first = list_comments(&auth, "acme/app", 7, 1, 2).await.expect("page 1");
        assert_eq!(
            first.comments.iter().map(|c| c.id.as_str()).collect::<Vec<_>>(),
            vec!["101", "102"]
        );
        assert!(first.has_next, "a third comment is behind this page");
        // Only a REAL edit carries an updated stamp; the first was never
        // touched and must not read as edited.
        assert_eq!(first.comments[0].updated_at, None);
        assert_eq!(
            first.comments[1].updated_at.as_deref(),
            Some("2026-09-01T09:00:00Z")
        );
        // A self-managed instance can answer with anything, and this lands in
        // an <img src>.
        assert_eq!(first.comments[0].author_avatar, None);
        assert_eq!(
            first.comments[1].author_avatar.as_deref(),
            Some("https://gitea.test/avatars/alice")
        );

        let second = list_comments(&auth, "acme/app", 7, 2, 2).await.expect("page 2");
        assert_eq!(second.comments.len(), 1);
        assert!(!second.has_next);
        // Past the end is empty, not a wrapped-around first page.
        let past = list_comments(&auth, "acme/app", 7, 9, 2).await.expect("page 9");
        assert!(past.comments.is_empty());
        assert!(!past.has_next);
    }

    /// The composer's own write, through the same mapper the reader uses: what
    /// the panel appends has to be one object with what the next page brings,
    /// or the optimistic append shows a second copy of what was just posted.
    #[tokio::test]
    async fn a_posted_comment_comes_back_as_the_forge_stored_it() {
        let (api_base, seen) = mock_api().await;
        let comment = create_comment(&auth_for(api_base), "acme/app", 7, "on it")
            .await
            .expect("post");
        assert_eq!(seen.wrote("comment"), vec![serde_json::json!({ "body": "on it" })]);
        assert_eq!(comment.id, "200");
        assert_eq!(comment.author.as_deref(), Some("alice"));
        assert_eq!(
            comment.html_url.as_deref(),
            Some("https://gitea.test/acme/app/issues/7#issuecomment-200")
        );
    }

    /// Two endpoints, picked by kind. `/pulls/{n}` is not interchangeable with
    /// `/issues/{n}` here: only its response carries `merged`, and a change
    /// somebody merged while the panel was open comes back merged rather than
    /// closed.
    #[tokio::test]
    async fn a_state_change_uses_the_right_collection_and_adopts_the_answer() {
        let (api_base, seen) = mock_api().await;
        let auth = auth_for(api_base);

        let issue = set_item_state(&auth, "acme/app", ForgeItemKind::Issue, 7, ForgeStateAction::Close)
            .await
            .expect("close");
        assert_eq!(seen.wrote("issue-state"), vec![serde_json::json!({ "state": "closed" })]);
        assert_eq!(issue.state, "closed");
        assert!(!issue.is_pr);

        let pull = set_item_state(&auth, "acme/app", ForgeItemKind::Change, 4, ForgeStateAction::Close)
            .await
            .expect("close");
        assert_eq!(seen.wrote("pull-state"), vec![serde_json::json!({ "state": "closed" })]);
        assert_eq!(pull.state, "merged", "the forge's answer wins over the ask");
        assert!(pull.is_pr);
    }

    /// Exact before loose. A repository holding two labels that differ only by
    /// case would otherwise get whichever one the page happened to list first —
    /// and the name being resolved came from a chip that showed exactly one of
    /// them.
    #[test]
    fn a_label_name_resolves_to_its_exact_match_before_a_loose_one() {
        let known = vec![
            RawLabel { id: 1, name: "BUG".into(), color: None },
            RawLabel { id: 2, name: "bug".into(), color: None },
            RawLabel { id: 3, name: "Help Wanted".into(), color: None },
        ];
        assert_eq!(resolve_label(&known, "bug"), Some(2));
        assert_eq!(resolve_label(&known, "BUG"), Some(1));
        // No exact match: the loose one is what a hand-written name gets.
        assert_eq!(resolve_label(&known, "help wanted"), Some(3));
        assert_eq!(resolve_label(&known, "nonexistent"), None);
    }

    /// Gitea applies labels to a new issue by ID, so the names the dialog
    /// collected have to be resolved first. A name the repository does not have
    /// is dropped rather than refused — the same thing GitHub does with one,
    /// and the alternative is losing the text somebody wrote over a stale chip.
    #[tokio::test]
    async fn a_new_issue_resolves_its_label_names_to_ids() {
        let (api_base, seen) = mock_api().await;
        let row = create_issue(
            &auth_for(api_base),
            "acme/app",
            &ResolvedNewIssue {
                title: "it crashes".into(),
                body: Some("steps".into()),
                labels: vec!["bug".into(), "help wanted".into(), "nonexistent".into()],
            },
        )
        .await
        .expect("create");
        assert_eq!(
            seen.wrote("issue"),
            vec![serde_json::json!({
                "title": "it crashes",
                "body": "steps",
                // `help wanted` matched `Help Wanted`, and the unknown name is
                // simply absent.
                "labels": [3, 7],
            })]
        );
        assert_eq!(row.number, 12);
        assert!(!row.is_pr);
    }

    /// The detail panel's own request: the counters Gitea computes only for a
    /// single pull request, plus the head commit's statuses folded into the one
    /// vocabulary the strip draws.
    #[tokio::test]
    async fn a_change_detail_carries_the_counters_and_the_checks() {
        let (api_base, _) = mock_api().await;
        let detail = change_detail(&auth_for(api_base), "acme/app", 4).await.expect("detail");
        assert_eq!(detail.number, 4);
        assert_eq!((detail.base_ref.as_str(), detail.head_ref.as_str()), ("main", "feature"));
        // Canonical casing on the head repository — `same_repo`, never `==`,
        // is what keeps this from reading as a fork.
        assert_eq!(detail.head_repo, None);
        assert_eq!(detail.head_sha.as_deref(), Some("deadbee"));
        assert_eq!(detail.state, "open");
        assert_eq!(detail.mergeable, Some(true));
        assert_eq!(detail.merge_state, None, "Gitea has no word to pass through");
        assert_eq!(
            (detail.additions, detail.deletions, detail.changed_files),
            (Some(12), Some(3), Some(2))
        );
        assert_eq!(detail.commits, None, "absent rather than a zero it never sent");

        assert!(detail.checks.available);
        assert!(!detail.checks.partial, "one collection, so never half an answer");
        let states: Vec<_> = detail.checks.checks.iter().map(|c| c.state).collect();
        assert_eq!(
            states,
            vec![
                ForgeCheckState::Success,
                ForgeCheckState::Failure,
                ForgeCheckState::Running,
                // Ran and produced no verdict. NOT a pass.
                ForgeCheckState::Neutral,
            ]
        );
        assert_eq!(detail.checks.checks[0].name, "build");
        assert_eq!(detail.checks.checks[0].summary.as_deref(), Some("ok"));
        assert_eq!(detail.checks.checks[0].url.as_deref(), Some("https://ci.test/1"));
        // Straight into an href — only the web schemes survive.
        assert_eq!(detail.checks.checks[1].url, None);
    }

    /// The file list, and the diff spliced onto it. `deleted` is the word that
    /// would otherwise read as a modification, and the renamed file's path has
    /// a space in it — which is why the patch is keyed off `+++` rather than
    /// off the two-path `diff --git` line.
    #[tokio::test]
    async fn changed_files_carry_gitea_statuses_and_a_spliced_patch() {
        let (api_base, _) = mock_api().await;
        let files = list_change_files(&auth_for(api_base), "acme/app", 4, 1, 50)
            .await
            .expect("files");
        let by_path: HashMap<&str, &ForgeChangedFile> =
            files.files.iter().map(|f| (f.path.as_str(), f)).collect();

        let modified = by_path["src/lib.rs"];
        assert_eq!(modified.status, ForgeFileStatus::Modified);
        assert_eq!((modified.additions, modified.deletions), (Some(3), Some(1)));
        assert!(modified.patch.as_deref().unwrap().contains("@@ -1,2 +1,4 @@"));

        let removed = by_path["old.txt"];
        assert_eq!(removed.status, ForgeFileStatus::Removed, "`deleted`, not `removed`");
        assert!(removed.patch.as_deref().unwrap().contains("-b"));

        let renamed = by_path["new name.rs"];
        assert_eq!(renamed.status, ForgeFileStatus::Renamed);
        assert_eq!(renamed.previous_path.as_deref(), Some("old/name.rs"));
        assert!(renamed.patch.as_deref().unwrap().contains("+added"));

        // Nothing counted and no hunk: binary content, and the row says so
        // rather than claiming a zero-line change.
        let binary = by_path["logo.png"];
        assert!(binary.binary);
        assert_eq!((binary.additions, binary.deletions), (None, None));
        assert_eq!(binary.patch, None);

        assert_eq!((files.page, files.per_page), (1, 50));
        assert!(!files.has_next, "no Link header on this one");
    }

    /// The cap is a hard stop MID-TRANSFER, not a size check afterwards.
    ///
    /// The regression this pins is the whole reason `Content-Length` is not
    /// consulted: Gitea writes this endpoint straight to the socket, so a large
    /// diff arrives chunked with NO length header — exactly the case the cap
    /// exists for, and exactly the one a `text()`-then-measure would buffer in
    /// full before discarding. The mock therefore streams without a length and
    /// counts what it was actually asked for; the assertion is that the client
    /// hung up long before the end.
    #[tokio::test]
    async fn an_oversized_diff_is_abandoned_mid_stream_rather_than_buffered() {
        // One megabyte per chunk, far more of them than the cap allows. The
        // stream is lazy, so a long one costs nothing that is never asked for.
        const CHUNK: usize = 1024 * 1024;
        const CHUNKS: usize = 128;
        // What the transport will take off the stream AFTER the client has
        // stopped reading: the kernel keeps accepting writes until the send and
        // receive buffers are full, and on Linux those auto-tune into the
        // megabytes on loopback (macOS parks at 128 KB, which is why this only
        // ever bit CI). Slack for that, not a second cap — the assertion below
        // is about the transfer being abandoned, and nothing here is under the
        // client's control once it has hung up.
        const BUFFER_SLACK: usize = 32 * 1024 * 1024;
        let served = Arc::new(AtomicUsize::new(0));
        let counter = served.clone();

        let app = axum::Router::new()
            .route(
                "/api/v1/repos/acme/app/pulls/4/files",
                get(|| async {
                    Json(serde_json::json!([
                        { "filename": "big.rs", "status": "changed",
                          "additions": 9, "deletions": 1 },
                    ]))
                }),
            )
            .route(
                "/api/v1/repos/acme/app/pulls/4.diff",
                get(move || {
                    let counter = counter.clone();
                    async move {
                        let stream = futures_util::stream::unfold(0usize, move |sent| {
                            let counter = counter.clone();
                            async move {
                                if sent >= CHUNKS {
                                    return None;
                                }
                                counter.fetch_add(1, Ordering::SeqCst);
                                let chunk: Result<Vec<u8>, std::io::Error> =
                                    Ok(vec![b'x'; CHUNK]);
                                Some((chunk, sent + 1))
                            }
                        });
                        // No `Content-Length` — this is what a real Gitea does
                        // for a diff it cannot size up front.
                        axum::body::Body::from_stream(stream)
                    }
                }),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let auth = auth_for(format!("http://{addr}/api/v1"));

        let files = list_change_files(&auth, "acme/app", 4, 1, 50)
            .await
            .expect("the file list survives a diff too big to inline");

        // The row still lists itself, with the counters Gitea reported — only
        // the reveal is lost, which is what GitHub does past its own limit.
        assert_eq!(files.files.len(), 1);
        assert_eq!(files.files[0].path, "big.rs");
        assert_eq!(files.files[0].patch, None);
        assert!(!files.files[0].binary, "counted lines are not binary content");
        assert_eq!(
            (files.files[0].additions, files.files[0].deletions),
            (Some(9), Some(1))
        );

        // The point: the transfer was abandoned, not consumed. Whatever the
        // sockets had already swallowed is served past the cap, so this is a
        // bound rather than an exact count — what it rules out is having read
        // all 128 MB, which is precisely what buffering the body would do.
        let served = served.load(Ordering::SeqCst);
        assert!(
            served * CHUNK <= DIFF_BYTE_CAP + BUFFER_SLACK,
            "read {served} chunks of {CHUNK} bytes; the cap is {DIFF_BYTE_CAP}"
        );
        assert!(served < CHUNKS, "the whole stream was consumed");
    }

    /// The splitter on its own: a rename (where `---` and `+++` disagree and
    /// only one of them is the path the file list reports), a deletion (which
    /// has no `+++ b/` to read at all), a C-quoted path (skipped rather than
    /// half-unquoted onto a neighbouring file) and a block with no hunk.
    #[test]
    fn the_diff_splitter_reads_the_path_off_the_header_lines() {
        let diff = concat!(
            "diff --git a/keep.rs b/keep.rs\n",
            "--- a/keep.rs\n",
            "+++ b/keep.rs\n",
            "@@ -1 +1 @@\n",
            "+x\n",
            "diff --git a/gone.rs b/gone.rs\n",
            "--- a/gone.rs\n",
            "+++ /dev/null\n",
            "@@ -1 +0,0 @@\n",
            "-x\n",
            // `---` comes FIRST in git's output, so taking the first header
            // line that parses would file this under `was.rs` — a path the
            // file list never mentions, leaving the row with no diff.
            "diff --git a/was.rs b/now.rs\n",
            "similarity index 90%\n",
            "--- a/was.rs\n",
            "+++ b/now.rs\n",
            "@@ -1 +1 @@\n",
            "+r\n",
            // A mode change: no hunk, so nothing to reveal and nothing filed.
            "diff --git a/exec.sh b/exec.sh\n",
            "old mode 100644\n",
            "new mode 100755\n",
            "diff --git \"a/od\\dd.rs\" \"b/od\\dd.rs\"\n",
            "--- \"a/od\\dd.rs\"\n",
            "+++ \"b/od\\dd.rs\"\n",
            "@@ -1 +1 @@\n",
            "+q\n",
        );
        let split = split_diff_by_path(diff);
        assert_eq!(split.len(), 3);
        assert!(split.contains_key("now.rs"), "the path AFTER the rename");
        assert!(!split.contains_key("was.rs"));
        assert!(!split.contains_key("exec.sh"), "a mode change has no diff");
        // Hunks alone, starting at the first `@@` — the same shape GitHub's
        // `patch` and GitLab's `diff` carry, so all three render identically.
        assert_eq!(split["keep.rs"], "@@ -1 +1 @@\n+x\n");
        assert_eq!(
            split["gone.rs"], "@@ -1 +0,0 @@\n-x\n",
            "a deletion has no `+++ b/` to read, so it falls back to the old name"
        );
        assert!(
            !split.values().any(|hunk| hunk.contains("+q")),
            "a quoted path is dropped, never attached to another file"
        );
    }

    /// The menu is what the repository permits.
    #[tokio::test]
    async fn merge_options_follow_the_repository_settings() {
        let (api_base, _) = mock_api().await;
        let options = merge_options(&auth_for(api_base), "acme/app").await.expect("options");
        assert_eq!(
            options.methods,
            vec![ForgeMergeMethod::Merge, ForgeMergeMethod::Squash],
            "rebase is forbidden on this repository"
        );
        assert_eq!(options.default_method, ForgeMergeMethod::Squash, "the repo's own default");
        assert_eq!(options.merge_strategy, ForgeMergeStrategy::MergeCommit);
        // Three of Gitea's five styles ARE `Merge` — see `merge_options`.
        assert_eq!(merge_method_of("merge"), Some(ForgeMergeMethod::Merge));
        assert_eq!(merge_method_of("rebase-merge"), Some(ForgeMergeMethod::Merge));
        assert_eq!(merge_method_of("fast-forward-only"), Some(ForgeMergeMethod::Merge));
        assert_eq!(merge_method_of("rebase"), Some(ForgeMergeMethod::Rebase));
        assert_eq!(merge_method_of("squash"), Some(ForgeMergeMethod::Squash));
        assert_eq!(merge_method_of("manually-merged"), None);
    }

    /// A repository that permits exactly ONE of Gitea's three "join it as it
    /// is" styles, and not the plain merge commit.
    ///
    /// The regression this pins: reading only `allow_merge_commits` leaves
    /// `methods` EMPTY here, the panel's fallback then offers plain "Merge",
    /// and every press sends `do: merge` to a repository that forbids it — a
    /// 405 forever, on a repository that merges perfectly well. `Merge` has to
    /// be offered, and the STRATEGY has to say what it will really do.
    #[tokio::test]
    async fn a_repository_with_only_one_join_style_still_gets_a_working_button() {
        for (flag, style, strategy, expected_do) in [
            (
                "allow_rebase_explicit",
                "rebase-merge",
                ForgeMergeStrategy::RebaseMerge,
                "rebase-merge",
            ),
            (
                "allow_fast_forward_only_merge",
                "fast-forward-only",
                ForgeMergeStrategy::FastForward,
                "fast-forward-only",
            ),
        ] {
            let (api_base, seen) = mock_repo_with(serde_json::json!({
                "allow_merge_commits": false,
                "allow_squash_merge": false,
                "allow_rebase": false,
                flag: true,
                "default_merge_style": style,
            }))
            .await;
            let auth = auth_for(api_base);

            let options = merge_options(&auth, "acme/app").await.expect("options");
            assert_eq!(
                options.methods,
                vec![ForgeMergeMethod::Merge],
                "{style}: the one style this repository has, offered under the one word for it"
            );
            assert_eq!(options.default_method, ForgeMergeMethod::Merge);
            assert_eq!(
                options.merge_strategy, strategy,
                "{style}: the panel has to say what `Merge` will do to the history"
            );

            // …and the merge that follows sends the style Gitea will accept,
            // not the word the menu entry is spelled with.
            merge_change(&auth, "acme/app", 4, ForgeMergeMethod::Merge, Some("deadbee"))
                .await
                .expect("merge");
            assert_eq!(
                seen.wrote("merge"),
                vec![serde_json::json!({ "do": expected_do, "head_commit_id": "deadbee" })],
                "{style}"
            );
        }
    }

    /// A repository that forbids all five: `Merge` is not offered, and the
    /// empty list is the honest answer (the panel falls back to one entry and
    /// lets Gitea refuse, which is what would happen anyway).
    #[tokio::test]
    async fn a_repository_that_permits_nothing_offers_nothing() {
        let (api_base, _) = mock_repo_with(serde_json::json!({
            "allow_merge_commits": false,
            "allow_squash_merge": false,
            "allow_rebase": false,
            "allow_rebase_explicit": false,
            "allow_fast_forward_only_merge": false,
        }))
        .await;
        let options = merge_options(&auth_for(api_base), "acme/app").await.expect("options");
        assert!(options.methods.is_empty());
    }

    /// An instance too old to report any of these flags keeps the menu it
    /// always had. `Option` is what carries "Gitea did not say" — defaulting
    /// the flags to `false` would answer "nothing is permitted" for a payload
    /// that merely surprised us.
    #[tokio::test]
    async fn an_instance_that_reports_no_flags_permits_everything() {
        let (api_base, _) = mock_repo_with(serde_json::json!({})).await;
        let options = merge_options(&auth_for(api_base), "acme/app").await.expect("options");
        assert_eq!(
            options.methods,
            vec![ForgeMergeMethod::Merge, ForgeMergeMethod::Squash, ForgeMergeMethod::Rebase]
        );
        assert_eq!(options.merge_strategy, ForgeMergeStrategy::MergeCommit);
    }

    /// The merge itself: `do` (lowercase, and required) plus the head the caller
    /// was looking at, and a re-read afterwards because Gitea answers with an
    /// empty body.
    #[tokio::test]
    async fn a_merge_sends_do_and_the_head_then_re_reads_the_row() {
        let (api_base, seen) = mock_api().await;
        let row = merge_change(
            &auth_for(api_base),
            "acme/app",
            4,
            ForgeMergeMethod::Squash,
            Some("deadbee"),
        )
        .await
        .expect("merge")
        .expect("the row was re-read");
        assert_eq!(
            seen.wrote("merge"),
            vec![serde_json::json!({ "do": "squash", "head_commit_id": "deadbee" })]
        );
        assert_eq!(row.state, "merged");
        assert!(row.is_pr);
    }

    /// Delivery's lookup. Gitea's `/pulls` has no head filter, so the match is
    /// local — over a bounded scan that stops as soon as the forge runs out
    /// rather than always paying for its own ceiling.
    #[tokio::test]
    async fn find_pulls_filters_by_head_locally_over_a_bounded_scan() {
        let (api_base, seen) = mock_api().await;
        let found = find_pulls(&auth_for(api_base), "acme/app", "feature")
            .await
            .expect("find");
        assert_eq!(
            found.iter().map(|p| p.number).collect::<Vec<_>>(),
            vec![4, 2],
            "both states, and not the pull request on another branch"
        );
        assert_eq!(found[0].head_ref, "feature");
        assert_eq!(found[0].base_ref, "main");
        assert_eq!(found[0].head_sha, "deadbee");
        // Canonical casing again: `adopt_pull_request` compares with
        // `same_repo`, so this only has to be the real name.
        assert_eq!(found[0].head_repo, "Acme/App");
        assert_eq!(
            *seen.pull_pages.lock().unwrap(),
            vec![1, 2, 3],
            "stopped on the first empty page, well short of the ceiling"
        );
    }

    /// Gitea has no `draft` parameter — a draft IS a title carrying one of the
    /// instance's work-in-progress prefixes, which is how its own UI toggles
    /// the state.
    #[tokio::test]
    async fn a_draft_pull_request_is_a_prefixed_title() {
        let (api_base, seen) = mock_api().await;
        let auth = auth_for(api_base);
        let mut req = NewPullRequest {
            title: "Fix the crash",
            head: "codeg/task-1",
            base: "main",
            body: "Closes #7",
            draft: true,
        };
        create_pull(&auth, "acme/app", &req).await.expect("create");
        req.title = "wip: already said so";
        create_pull(&auth, "acme/app", &req).await.expect("create");
        req.draft = false;
        req.title = "Fix the crash";
        create_pull(&auth, "acme/app", &req).await.expect("create");

        let titles: Vec<String> = seen
            .wrote("pull")
            .iter()
            .map(|body| body["title"].as_str().unwrap_or_default().to_string())
            .collect();
        assert_eq!(
            titles,
            vec!["WIP: Fix the crash", "wip: already said so", "Fix the crash"],
            "prefixed once, never twice, and never when it is not a draft"
        );
        assert_eq!(seen.wrote("pull")[0]["head"], "codeg/task-1");
        assert_eq!(seen.wrote("pull")[0]["base"], "main");
    }

    /// A pull request whose fork is gone. Gitea answers with no head repository
    /// at all, and the placeholder that stands in has to FAIL `normalize_repo`
    /// — that refusal is what stops a task being created for a change whose
    /// commits would have nowhere to be pushed, hours before the push proves it.
    #[test]
    fn a_nameless_head_repository_is_refused_rather_than_worked() {
        let raw: RawPull = serde_json::from_value(serde_json::json!({
            "number": 4,
            "state": "open",
            "html_url": "https://gitea.test/acme/app/pulls/4",
            // Present, but with no repository under it.
            "head": { "ref": "feature", "sha": "deadbee" },
            "base": { "ref": "main" },
        }))
        .unwrap();
        let pr = raw.into_pr();
        assert_eq!(pr.head_repo, UNKNOWN_HEAD_REPO);
        assert!(!crate::forge::same_repo(&pr.head_repo, "acme/app"));
        assert!(
            crate::forge::normalize_repo(&pr.head_repo).is_none(),
            "a well-formed placeholder would pass the fork gate and fail at the push"
        );
        assert!(crate::forge::deliver::pull_is_workable(
            ForgeProvider::Gitea,
            &pr,
            "acme/app"
        )
        .is_err());
    }

    /// A title is arbitrary user text, and the prefix test slices it. Bytes
    /// through the middle of a code point PANIC, which is a crash on a title
    /// nobody would think twice about.
    #[test]
    fn the_draft_prefix_test_is_char_safe() {
        assert!(!is_wip_title("修"));
        assert!(!is_wip_title(""));
        assert!(is_wip_title("  WIP: 修复崩溃"));
        assert!(is_wip_title("[wip] later"));
        assert!(!is_wip_title("wiper blades"));
    }

    /// Every request path a caller can influence goes through `normalize_repo`,
    /// and every item number is checked before it lands in one.
    #[tokio::test]
    async fn bad_coordinates_are_refused_before_a_request_is_spent() {
        let auth = auth_for("http://127.0.0.1:1/api/v1".into());
        assert!(matches!(
            list_labels(&auth, "not-a-repo").await,
            Err(ForgeError::Invalid(_))
        ));
        assert!(matches!(
            list_comments(&auth, "acme/app?ref=x", 1, 1, 20).await,
            Err(ForgeError::Invalid(_))
        ));
        assert!(matches!(
            change_detail(&auth, "acme/app", 0).await,
            Err(ForgeError::Invalid(_))
        ));
        assert!(matches!(
            create_comment(&auth, "acme/app", -3, "hi").await,
            Err(ForgeError::Invalid(_))
        ));
    }
}
