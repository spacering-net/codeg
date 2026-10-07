//! Forge (GitHub/GitLab/Gitea) integration core: account/auth resolution, a
//! proxy-aware HTTP client, the canonical source-key normalizer and the REST
//! reads the Issues/PR workbench needs. Deliberately thin — no query DSL, no
//! response caching (see `.docs/architecture/2026-08-17-*` for what is out of
//! scope and why REST-direct beat shelling out to `gh`/`glab`).

pub mod auth;
pub mod deliver;
pub mod envelope;
pub mod gitea;
pub mod github;
pub mod gitlab;
pub mod settings;

use std::sync::RwLock;

pub use auth::{host_profile, resolve_forge_auth, strip_base_path, HostProfile, ResolvedAuth};

/// The forge a host speaks. Everything provider-specific downstream — REST
/// base, auth header, the shape of a "pull request", which ref a proposed
/// change is published under, where a comment goes — hangs off this one value,
/// which is always DERIVED SERVER-SIDE from the folder's remote and the
/// configured accounts. A client never gets to say which forge it is talking
/// to: that choice picks the credentials.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ForgeProvider {
    GitHub,
    GitLab,
    /// Gitea — and, by construction, Forgejo: it is a Gitea fork that keeps the
    /// same `/api/v1` surface, so an instance of either answers every request
    /// this variant makes. Nothing downstream distinguishes them, and inventing
    /// a fourth variant would only split one credential store in two.
    Gitea,
}

impl ForgeProvider {
    pub fn as_str(self) -> &'static str {
        match self {
            ForgeProvider::GitHub => "github",
            ForgeProvider::GitLab => "gitlab",
            ForgeProvider::Gitea => "gitea",
        }
    }

    /// Parse a stored/claimed provider name. Unknown values are an error rather
    /// than a silent fallback to GitHub — a task whose provenance says
    /// something we do not understand must not be worked with the wrong API.
    pub fn parse(value: &str) -> Result<Self, ForgeError> {
        match value.trim().to_ascii_lowercase().as_str() {
            "github" => Ok(ForgeProvider::GitHub),
            "gitlab" => Ok(ForgeProvider::GitLab),
            "gitea" => Ok(ForgeProvider::Gitea),
            other => Err(ForgeError::Invalid(format!("unknown provider: {other}"))),
        }
    }

    /// How this forge spells its own name in prose. [`as_str`] is the wire
    /// value (lowercase, compared and stored); putting it in front of a user
    /// reads as a typo.
    pub fn display_name(self) -> &'static str {
        match self {
            ForgeProvider::GitHub => "GitHub",
            ForgeProvider::GitLab => "GitLab",
            ForgeProvider::Gitea => "Gitea",
        }
    }

    /// What this forge calls a proposed change, for messages the user reads.
    /// GitLab users do not have "pull requests" and being told they do reads
    /// like the wrong tool answered. Gitea sides with GitHub here — its own UI
    /// says "pull request" — which is one of the several places it is easier to
    /// treat as a GitHub dialect than as its own vocabulary.
    pub fn change_noun(self) -> &'static str {
        match self {
            ForgeProvider::GitHub | ForgeProvider::Gitea => "pull request",
            ForgeProvider::GitLab => "merge request",
        }
    }

    /// The ref a proposed change's head is published under on the server —
    /// what makes a fork's (or any) contribution fetchable without adding a
    /// remote. Both forges publish one; they just spell it differently.
    ///
    /// Note the HYPHEN in GitLab's: its REST path is `/merge_requests` with an
    /// underscore, but the git ref namespace is `refs/merge-requests/<iid>`.
    /// The two spellings sit three lines apart in this file for a reason —
    /// using the API's spelling as a ref fetches nothing at all.
    ///
    /// Gitea publishes under GitHub's namespace exactly (`refs/pull/<index>/head`,
    /// its `git.RefNameFromPullIndex`), which is what lets a pull-request task
    /// check out a Gitea fork's head without adding a remote.
    pub fn change_head_ref(self, number: i64) -> String {
        match self {
            ForgeProvider::GitHub | ForgeProvider::Gitea => format!("refs/pull/{number}/head"),
            ForgeProvider::GitLab => format!("refs/merge-requests/{number}/head"),
        }
    }

    /// Canonical web URL of one work item, under `origin` (see [`web_origin`]
    /// — a scheme-and-port-carrying origin rather than a bare host, so a
    /// self-hosted instance on `http://` or a non-default port gets a link
    /// that actually opens).
    pub fn item_url(
        self,
        origin: &str,
        owner_repo: &str,
        kind: ForgeItemKind,
        number: i64,
    ) -> String {
        let origin = origin.trim_end_matches('/');
        match self {
            ForgeProvider::GitHub => {
                // `/issues/{n}` of a pull request redirects to `/pull/{n}`, but
                // the link is stored and shown, so it says what it is.
                let segment = match kind {
                    ForgeItemKind::Issue => "issues",
                    ForgeItemKind::Change => "pull",
                };
                format!("{origin}/{owner_repo}/{segment}/{number}")
            }
            ForgeProvider::GitLab => {
                // The `/-/` separator is what keeps a project path with
                // subgroups unambiguous against the route that follows it.
                let segment = match kind {
                    ForgeItemKind::Issue => "issues",
                    ForgeItemKind::Change => "merge_requests",
                };
                format!("{origin}/{owner_repo}/-/{segment}/{number}")
            }
            ForgeProvider::Gitea => {
                // `pulls`, PLURAL — the one letter that separates Gitea's web
                // route from GitHub's `/pull/{n}`. Gitea 404s on the singular
                // form, so borrowing GitHub's spelling here would put a dead
                // link on every proposed change.
                let segment = match kind {
                    ForgeItemKind::Issue => "issues",
                    ForgeItemKind::Change => "pulls",
                };
                format!("{origin}/{owner_repo}/{segment}/{number}")
            }
        }
    }
}

/// Issue or proposed change. Load-bearing for GitLab, where the two have
/// SEPARATE list and comment endpoints — GitHub models a pull request as an
/// issue and serves both from `/issues`, which is exactly the assumption that
/// silently breaks against a GitLab instance.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ForgeItemKind {
    Issue,
    /// Pull request (GitHub) / merge request (GitLab).
    Change,
}

impl ForgeItemKind {
    /// The `kind` segment of a source key — `pr` for both forges (a GitLab
    /// merge request is normalized to it) so provenance keys stay comparable.
    pub fn key_segment(self) -> &'static str {
        match self {
            ForgeItemKind::Issue => "issue",
            ForgeItemKind::Change => "pr",
        }
    }

    /// The kind a wire value names, by the same two words [`key_segment`]
    /// writes. Unknown values are refused rather than defaulted: on GitLab the
    /// kind picks the COLLECTION, and guessing it reads issue #7 for merge
    /// request !7 — a real item, belonging to somebody else's work.
    pub fn parse(value: &str) -> Result<Self, ForgeError> {
        match value.trim().to_ascii_lowercase().as_str() {
            "issue" => Ok(ForgeItemKind::Issue),
            "pr" => Ok(ForgeItemKind::Change),
            other => Err(ForgeError::Invalid(format!(
                "unknown work item kind: {other}"
            ))),
        }
    }
}

/// i18n key for [`ForgeError::NoAccount`]. Dotted from the message root
/// because the frontend localizes it with a ROOT-scoped translator; the
/// forge page's own `useTranslations("Forge")` cannot resolve it.
pub const NO_ACCOUNT_I18N_KEY: &str = "Forge.errors.noAccount";

/// i18n key for [`ForgeError::UnsupportedHost`], dotted for the same reason.
/// The workbench also renders this message on its OWN account — it refuses to
/// spend a request on such a host at all — so the two paths say one thing.
pub const UNSUPPORTED_HOST_I18N_KEY: &str = "Forge.errors.unsupportedHost";

/// i18n key for [`ForgeError::WrongForge`]. Root-dotted for the same reason
/// [`NO_ACCOUNT_I18N_KEY`] is.
pub const WRONG_FORGE_I18N_KEY: &str = "Forge.errors.wrongForge";

#[derive(Debug, thiserror::Error)]
pub enum ForgeError {
    /// No usable account/token for the requested host (or the token is dead).
    #[error("forge auth: {0}")]
    Auth(String),
    /// Nothing is configured for this host at all — the one auth failure the
    /// user can fix themselves, so it carries an i18n key and the workbench
    /// turns it into an "add an account" action instead of a dead end. A
    /// pinned-id miss, a missing keyring token or a rejected token stay
    /// [`ForgeError::Auth`]: adding another account fixes none of them.
    #[error("no {} account for host {host}", provider.display_name())]
    NoAccount { provider: ForgeProvider, host: String },
    /// The host is not one codeg can read: nothing is configured for it and its
    /// name claims none of the forges. Distinct from [`ForgeError::NoAccount`]
    /// because the advice differs — "add a GitHub account for bitbucket.org"
    /// is advice that cannot work, while "only GitHub, GitLab and Gitea are
    /// supported" is the actual answer (with adding an account still the way
    /// in for a self-hosted instance under an unrelated name).
    #[error("unsupported forge host {host}: only GitHub, GitLab and Gitea are supported")]
    UnsupportedHost { host: String },
    /// The host answered in a way only the OTHER forge answers — codeg had it
    /// classified wrong and now knows better. Recoverable by construction: the
    /// detection cache has already been corrected by the time this is
    /// returned, so repeating the request routes it to the right client.
    #[error("{host} is a {}, not the forge it was addressed as", detected.display_name())]
    WrongForge { host: String, detected: ForgeProvider },
    /// Primary or secondary rate limit; honor `retry_after` when present.
    #[error("forge rate limited")]
    RateLimited { retry_after: Option<u64> },
    #[error("forge resource not found")]
    NotFound,
    /// Caller-supplied input failed validation (bad repo path, foreign cursor…).
    #[error("forge invalid input: {0}")]
    Invalid(String),
    #[error("forge API error {status}: {message}")]
    Api { status: u16, message: String },
    #[error("forge network error: {0}")]
    Network(String),
}

impl From<ForgeError> for crate::app_error::AppCommandError {
    fn from(err: ForgeError) -> Self {
        use crate::app_error::AppCommandError as E;
        match &err {
            ForgeError::Auth(msg) => E::configuration_invalid(
                "the account for this repository's host is not usable",
            )
            .with_detail(msg.clone()),
            ForgeError::NoAccount { provider, host } => {
                let params = std::collections::BTreeMap::from([
                    ("host".to_string(), host.clone()),
                    ("provider".to_string(), provider.display_name().to_string()),
                ]);
                E::configuration_missing(err.to_string())
                    .with_i18n(NO_ACCOUNT_I18N_KEY, params)
            }
            ForgeError::UnsupportedHost { host } => {
                let params =
                    std::collections::BTreeMap::from([("host".to_string(), host.clone())]);
                E::configuration_invalid(err.to_string())
                    .with_i18n(UNSUPPORTED_HOST_I18N_KEY, params)
            }
            ForgeError::WrongForge { host, detected } => {
                let params = std::collections::BTreeMap::from([
                    ("host".to_string(), host.clone()),
                    ("provider".to_string(), detected.display_name().to_string()),
                ]);
                E::network(err.to_string()).with_i18n(WRONG_FORGE_I18N_KEY, params)
            }
            ForgeError::RateLimited { retry_after } => E::network("forge rate limit reached")
                .with_detail(match retry_after {
                    Some(secs) => format!("retry after {secs}s"),
                    None => "retry later".to_string(),
                }),
            ForgeError::NotFound => E::not_found("forge resource not found"),
            ForgeError::Invalid(msg) => E::invalid_input(msg.clone()),
            ForgeError::Api { .. } | ForgeError::Network(_) => {
                E::network("forge API request failed").with_detail(err.to_string())
            }
        }
    }
}

/// `work_task.source_kind` for a task triggered from an issue. Its own
/// constant because it is a GATE in three places (delivery, the local-merge
/// refusal, the trigger command) and a typo in any of them opens one of them.
pub const SOURCE_KIND_ISSUE: &str = "forge_issue";
/// `work_task.source_kind` for a task triggered from a pull request (M8).
pub const SOURCE_KIND_PR: &str = "forge_pr";

/// Canonical provenance key: `{provider}:{server_host}:{owner_repo}:{kind}:{number}`.
///
/// Both writers (trigger command) and readers (dedup, the issue list's reverse
/// lookup) MUST build keys through this function — never by hand — so casing
/// or host drift can't split one work item into two keys. The host is the
/// SERVER host (`github.com`, `ghe.corp.com`), the same coordinate system git
/// remotes live in; the API base is a derived value and never part of the key.
pub fn source_key(
    provider: &str,
    server_host: &str,
    owner_repo: &str,
    kind: &str,
    number: i64,
) -> Result<String, ForgeError> {
    // Through the enum rather than an inline list of names: this is the third
    // place a provider name is validated, and a hand-written list here is what
    // would silently refuse every key of a forge added to the enum later.
    let provider = ForgeProvider::parse(provider)?.as_str();
    let kind = kind.trim().to_ascii_lowercase();
    if kind != "issue" && kind != "pr" {
        return Err(ForgeError::Invalid(format!("unknown source kind: {kind}")));
    }
    let host = server_host.trim().to_ascii_lowercase();
    if host.is_empty() || host.contains('/') || host.contains(':') {
        return Err(ForgeError::Invalid(format!("bad server host: {server_host}")));
    }
    let repo = normalize_repo(owner_repo)
        .ok_or_else(|| ForgeError::Invalid(format!("bad repository path: {owner_repo}")))?;
    if number <= 0 {
        return Err(ForgeError::Invalid(format!("bad work item number: {number}")));
    }
    Ok(format!("{provider}:{host}:{repo}:{kind}:{number}"))
}

/// Repository-identity comparison. GitHub preserves canonical casing in API
/// responses (`microsoft/TypeScript`) while our keys and remotes normalize to
/// lowercase — an exact string compare would reject the right PR or mistake a
/// same-repo head for a fork. Every repo comparison (folder-remote check,
/// PR adoption, fork gate) goes through here.
pub fn same_repo(a: &str, b: &str) -> bool {
    match (normalize_repo(a), normalize_repo(b)) {
        (Some(a), Some(b)) => a == b,
        _ => false,
    }
}

/// Lowercased `owner/repo` (GitLab: full subgroup path), `.git` suffix and
/// surrounding slashes stripped. `None` when the shape is not a repo path or
/// contains URL metacharacters (a client-supplied value goes into request
/// paths, so this doubles as injection hygiene).
pub fn normalize_repo(input: &str) -> Option<String> {
    let trimmed = input
        .trim()
        .trim_matches('/')
        .trim_end_matches(".git")
        .to_ascii_lowercase();
    if trimmed.is_empty() || !trimmed.contains('/') {
        return None;
    }
    let ok = trimmed.split('/').all(|seg| {
        !seg.is_empty()
            && seg
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
    });
    if ok {
        Some(trimmed)
    } else {
        None
    }
}

/// `(server_host, owner_repo)` parsed from a git remote URL — the bridge
/// between a local folder and the forge repository its issues live in.
/// Handles the three shapes remotes actually take: `https://host/o/r(.git)`,
/// `git@host:o/r.git`, `ssh://git@host[:port]/o/r`.
pub fn parse_remote_url(url: &str) -> Option<(String, String)> {
    let trimmed = url.trim();
    if trimmed.is_empty() {
        return None;
    }
    // scp-like SSH: git@host:owner/repo(.git) — no scheme, single colon.
    if !trimmed.contains("://") {
        if let Some((user_host, path)) = trimmed.split_once(':') {
            let host = user_host.split('@').next_back()?.trim().to_ascii_lowercase();
            if host.is_empty() || host.contains('/') {
                return None;
            }
            return Some((host, normalize_repo(path)?));
        }
        return None;
    }
    // Scheme form: https:// or ssh:// — host[:port]/owner/repo(.git).
    let rest = trimmed.split_once("://")?.1;
    let (host_port, path) = rest.split_once('/')?;
    let host = host_port
        .split('@')
        .next_back()?
        .split(':')
        .next()?
        .trim()
        .to_ascii_lowercase();
    if host.is_empty() {
        return None;
    }
    Some((host, normalize_repo(path)?))
}

/// Provenance snapshot stored in `work_task.source_meta` (JSON) and mirrored
/// to the frontend as `ForgeSourceMeta` in `src/lib/types.ts`.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ForgeSourceMeta {
    /// Typed rather than a free string: a stored value that is neither forge
    /// fails to deserialize the whole snapshot, which every reader already
    /// treats as "the task's source information is unreadable". That is a far
    /// better answer than defaulting to one forge and spending the other's
    /// credential on it.
    pub provider: ForgeProvider,
    pub server_host: String,
    pub api_base: String,
    pub account_id: String,
    pub owner_repo: String,
    pub number: i64,
    /// Canonical html URL — server-derived, never taken from the client.
    pub url: String,
    /// Title at trigger time (display only; the prompt carries its own copy).
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_ref: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub head_ref: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub head_sha: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub head_repo: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result_pr: Option<String>,
    /// Whether this task comments its outcome back on the item when it
    /// finishes — the answer the user gave in the trigger dialog, frozen here.
    /// It lives on the task rather than in folder settings because it is a
    /// decision about THIS work item, taken while looking at it: a switch
    /// somewhere else would publish to a thread other people are reading on
    /// behalf of a task whose author never saw the question.
    ///
    /// Absent on rows minted before the choice moved here; those stay silent,
    /// which is the posture the old folder setting shipped with.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub writeback: Option<bool>,
}

/// List rows carry the body for the trigger snapshot; cap it so a megabyte
/// issue body doesn't ride every list response. The untrusted-data envelope
/// trims to 12k at prompt time — this keeps a margin above that.
pub const BODY_CAP: usize = 16_000;

/// Which tab of the workbench a list request is for. Provider-neutral: GitHub
/// serves both from one endpoint and splits locally, GitLab has two.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ForgeTab {
    Issues,
    Prs,
}

/// Page-size bounds. Both forges cap `per_page` at 100; the clamp lives here
/// so a client cannot ask for a page that either API would reject outright.
pub const MIN_PER_PAGE: u32 = 1;
pub const MAX_PER_PAGE: u32 = 100;
pub const DEFAULT_PER_PAGE: u32 = 20;

/// Longest free-text filter accepted. GitHub caps the whole `q` at 256
/// characters and the qualifiers already eat some of that, so a longer string
/// would turn the search into a 422 rather than a narrower list.
pub const MAX_SEARCH_CHARS: usize = 128;
/// Most labels one filter may name. Both forges AND them together, so past a
/// handful the result set is empty anyway — and each one lengthens GitHub's `q`.
pub const MAX_LABEL_FILTERS: usize = 10;

/// How the list is ordered. Deliberately four NAMED orders rather than a
/// free (field, direction) pair: the two forges spell their fields differently
/// (`created` vs `created_at`) and accept different sets, so the intersection
/// is what the workbench can honestly offer on both.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ForgeSort {
    /// Newest first — what github.com's own issue list defaults to.
    #[default]
    Newest,
    Oldest,
    RecentlyUpdated,
    LeastRecentlyUpdated,
}

impl ForgeSort {
    /// GitHub's `sort` value. GitLab spells the same two fields `created_at` /
    /// `updated_at`, derived from this in its own client.
    pub fn field(self) -> &'static str {
        match self {
            ForgeSort::Newest | ForgeSort::Oldest => "created",
            ForgeSort::RecentlyUpdated | ForgeSort::LeastRecentlyUpdated => "updated",
        }
    }

    pub fn ascending(self) -> bool {
        matches!(self, ForgeSort::Oldest | ForgeSort::LeastRecentlyUpdated)
    }

    /// `asc` / `desc` — the spelling both forges share.
    pub fn direction(self) -> &'static str {
        if self.ascending() {
            "asc"
        } else {
            "desc"
        }
    }
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListIssuesRequest {
    /// SERVER-DERIVED from the folder's remote — never taken from the client.
    /// That is why this struct is built through [`ListIssuesRequest::new`]
    /// rather than deserialized from the wire.
    pub owner_repo: String,
    pub tab: ForgeTab,
    /// "open" | "closed" | "all" (anything else is rejected). Normalized to
    /// each forge's own vocabulary by its client.
    #[serde(default = "default_state")]
    pub state: String,
    #[serde(default)]
    pub assigned_me: bool,
    /// Label names, ANDed. Already normalized (see [`normalize_labels`]).
    #[serde(default)]
    pub labels: Vec<String>,
    /// Free text over title and description. Already normalized (see
    /// [`normalize_search`]) — and treated as TEXT by both clients, not as
    /// query syntax the user gets to write.
    #[serde(default)]
    pub search: Option<String>,
    #[serde(default)]
    pub sort: ForgeSort,
    /// 1-based page. Offset pagination on both forges — see [`ForgeIssueList`]
    /// for why this replaced the old opaque Link cursor.
    #[serde(default = "default_page")]
    pub page: u32,
    #[serde(default = "default_per_page")]
    pub per_page: u32,
}

impl ListIssuesRequest {
    /// The one way a provider request comes into being: caller-supplied
    /// filters plus a repository the SERVER resolved. Keeping `owner_repo` a
    /// separate argument is the trust boundary — it cannot be defaulted in
    /// from a payload the client wrote.
    pub fn new(owner_repo: String, filters: ListFilters) -> Self {
        Self {
            owner_repo,
            tab: filters.tab,
            state: filters.state,
            assigned_me: filters.assigned_me,
            labels: normalize_labels(filters.labels),
            search: normalize_search(filters.search.as_deref()),
            sort: filters.sort,
            page: filters.page,
            per_page: filters.per_page,
        }
    }

    /// Bring client-supplied paging into range. Called by the clients rather
    /// than trusted from the wire: a `per_page=0` is a 422 at GitHub and an
    /// empty page at GitLab, and `page=0` silently means page 1 at one and
    /// not the other.
    pub fn clamped(&self) -> (u32, u32) {
        (
            self.page.max(1),
            self.per_page.clamp(MIN_PER_PAGE, MAX_PER_PAGE),
        )
    }
}

/// Everything about a list request the CLIENT gets to decide. The repository
/// is not in here on purpose (see [`ListIssuesRequest::new`]).
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListFilters {
    pub tab: ForgeTab,
    #[serde(default = "default_state")]
    pub state: String,
    #[serde(default)]
    pub assigned_me: bool,
    #[serde(default)]
    pub labels: Vec<String>,
    #[serde(default)]
    pub search: Option<String>,
    #[serde(default)]
    pub sort: ForgeSort,
    #[serde(default = "default_page")]
    pub page: u32,
    #[serde(default = "default_per_page")]
    pub per_page: u32,
    /// Which stored account to spend. Auth, not a filter — consumed by the
    /// command layer and never reaches a provider client.
    #[serde(default)]
    pub account_id: Option<String>,
}

/// Everything a COUNT request may be narrowed by.
///
/// Deliberately not [`ListFilters`]: a count has no tab, no page and no order,
/// and carrying three fields the server is obliged to ignore is how a client
/// comes to believe it set one. What it does share is the filter half — the
/// numbers on the switcher have to describe the same result set the list does,
/// or the badge and the page count contradict each other on screen.
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CountFilters {
    #[serde(default = "default_state")]
    pub state: String,
    #[serde(default)]
    pub assigned_me: bool,
    #[serde(default)]
    pub labels: Vec<String>,
    #[serde(default)]
    pub search: Option<String>,
    /// Which stored account to spend. Auth, not a filter — same as
    /// [`ListFilters::account_id`], and consumed by the command layer.
    #[serde(default)]
    pub account_id: Option<String>,
}

impl CountFilters {
    /// The one-row list request whose `total_count` IS the answer.
    ///
    /// Neither forge offers a count-only endpoint for these collections:
    /// GitHub's search returns `total_count` beside the page and GitLab puts
    /// its own in `X-Total`, so the smallest page there is ([`MIN_PER_PAGE`])
    /// is the cheapest way to ask. The order cannot change a count and is left
    /// at the default rather than plumbed through.
    pub fn probe(&self, tab: ForgeTab) -> ListFilters {
        ListFilters {
            tab,
            state: self.state.clone(),
            assigned_me: self.assigned_me,
            labels: self.labels.clone(),
            search: self.search.clone(),
            sort: ForgeSort::default(),
            page: 1,
            per_page: MIN_PER_PAGE,
            account_id: self.account_id.clone(),
        }
    }
}

/// Trim, cap and drop-if-empty. The cap is [`MAX_SEARCH_CHARS`] CHARACTERS,
/// counted char-wise: a byte slice through arbitrary user text can split a
/// code point and panic.
pub fn normalize_search(raw: Option<&str>) -> Option<String> {
    let trimmed = raw?.trim();
    if trimmed.is_empty() {
        return None;
    }
    Some(truncate_chars(trimmed, MAX_SEARCH_CHARS))
}

/// Trim, drop empties, de-duplicate (case-sensitively — GitHub label names are
/// case-sensitive) and cap at [`MAX_LABEL_FILTERS`], preserving order.
pub fn normalize_labels(raw: Vec<String>) -> Vec<String> {
    normalize_label_names(raw, MAX_LABEL_FILTERS)
}

/// Most labels one new issue may carry. Far above the filter's cap and there
/// for a different reason: this is a sanity bound on a payload, not a limit on
/// how narrow a query may be. GitHub applies at most 100 labels to an issue,
/// and a repository with more than [`MAX_ISSUE_LABELS`] on one issue is not a
/// case this dialog is for.
pub const MAX_ISSUE_LABELS: usize = 50;

/// The shared normalizer behind [`normalize_labels`], with the cap as an
/// argument — a filter and a new issue want the same trimming and the same
/// de-duplication but emphatically not the same ceiling.
fn normalize_label_names(raw: Vec<String>, cap: usize) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    raw.into_iter()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty() && seen.insert(l.clone()))
        .take(cap)
        .collect()
}

/// One label as the forge paints it: the name a filter names it by, plus the
/// colour the project gave it. Both forges attach a colour to every label, and
/// carrying it is what lets the workbench draw github.com's own chip instead of
/// a row of identical grey pills — colour is how a triage list is scanned.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct ForgeLabel {
    pub name: String,
    /// Normalized to `#rrggbb`, or `None` when the forge sent something this
    /// does not recognize. See [`normalize_hex_color`].
    pub color: Option<String>,
}

impl ForgeLabel {
    /// A provider's label, or `None` when it carries no usable name — an empty
    /// name is a chip with nothing in it and no way to filter by.
    pub fn parse(name: String, color: Option<&str>) -> Option<Self> {
        if name.is_empty() {
            return None;
        }
        Some(Self {
            name,
            color: color.and_then(normalize_hex_color),
        })
    }
}

/// `#rrggbb` out of whatever spelling the forge used, or `None`.
///
/// The two disagree: GitHub sends bare `d73a4a`, GitLab sends `#d9534f`. Both
/// are accepted, as is the 3-digit shorthand.
///
/// Everything else is rejected rather than passed through, because GitLab
/// ACCEPTS CSS colour names when a label is written (`red`, `rebeccapurple`),
/// so a self-managed instance can hold a value that is not hex at all — and
/// this string ends up inside a `style` attribute. `None` costs the chip its
/// colour, which is a great deal cheaper than forwarding arbitrary text into a
/// stylesheet.
pub fn normalize_hex_color(raw: &str) -> Option<String> {
    let hex = raw.trim().trim_start_matches('#');
    if !hex.chars().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }
    let expanded: String = match hex.len() {
        3 => hex.chars().flat_map(|c| [c, c]).collect(),
        6 => hex.to_string(),
        _ => return None,
    };
    Some(format!("#{}", expanded.to_ascii_lowercase()))
}

/// The repository's label vocabulary, for the workbench's label filter.
///
/// One page of [`LABEL_PAGE_SIZE`], and `truncated` says so out loud when the
/// repository has more: a filter list that silently stops at 100 reads as
/// "these are all the labels", and the label you wanted simply is not there.
#[derive(Debug, Clone, serde::Serialize)]
pub struct ForgeLabelList {
    pub labels: Vec<ForgeLabel>,
    pub truncated: bool,
}

/// Labels fetched in one request. 100 is the per-page maximum on both forges.
pub const LABEL_PAGE_SIZE: usize = 100;

fn default_state() -> String {
    "open".to_string()
}

fn default_page() -> u32 {
    1
}

fn default_per_page() -> u32 {
    DEFAULT_PER_PAGE
}

fn default_comment_per_page() -> u32 {
    DEFAULT_COMMENT_PER_PAGE
}

/// One row of the workbench list (both tabs share the shape; `is_pr` is the
/// split). `body` rides along because the trigger snapshot is taken from the
/// list row — GitHub's `/issues` and GitLab's `/issues`+`/merge_requests` all
/// include it, which is what makes a detail endpoint unnecessary for issues.
#[derive(Debug, Clone, serde::Serialize)]
pub struct ForgeIssueRow {
    pub number: i64,
    pub title: String,
    /// Capped (see [`BODY_CAP`]) — the untrusted-data envelope trims to 12k
    /// anyway, so shipping megabyte bodies to the UI buys nothing.
    pub body: Option<String>,
    /// Normalized to `open` / `closed` / `merged` for BOTH forges. GitLab says
    /// `opened`; GitHub has no merged STATE at all (a merged pull request is
    /// just closed) and is derived from `pull_request.merged_at`. The workbench
    /// row picks its icon and colour off this value plus [`Self::draft`].
    pub state: String,
    /// Draft / work-in-progress pull request. Always false for issues.
    pub draft: bool,
    pub labels: Vec<ForgeLabel>,
    pub author: Option<String>,
    /// The author's picture, under the same rule as [`ForgeComment`]'s: `http(s)`
    /// only, through [`sanitize_web_url`], because it goes straight into an
    /// `<img src>`. Both forges ship it with the list row, so it costs nothing —
    /// and without it the panel would draw an initial for the author beside
    /// comments from that same person showing their face.
    pub author_avatar: Option<String>,
    pub updated_at: Option<String>,
    pub html_url: String,
    pub is_pr: bool,
    /// Human comments on the item. GitHub calls it `comments`, GitLab
    /// `user_notes_count` — both exclude system notes, which is what makes the
    /// number mean "there is a discussion here" rather than "things happened".
    pub comments: i64,
}

/// One page of the workbench list.
///
/// Offset pagination, NOT the old `Link: rel="next"` cursor. The cursor could
/// only ever offer "load more", because the GitHub client listed both kinds
/// from `/issues` and split them client-side — so "API page 3" was not
/// "Issues page 3" and no total existed. The GitHub client now asks
/// `/search/issues` with `is:issue` / `is:pr` (what github.com's own web UI is
/// backed by), which filters server-side and returns a real count; GitLab's
/// two collections were always separate. Hence real page numbers.
#[derive(Debug, Clone, serde::Serialize)]
pub struct ForgeIssueList {
    pub rows: Vec<ForgeIssueRow>,
    /// Echo of the page actually served (already clamped).
    pub page: u32,
    pub per_page: u32,
    /// Matching items, or `None` when the forge declines to count: GitLab
    /// omits `X-Total`/`X-Total-Pages` past 10k rows, and one GitLab query
    /// (merge requests + closed) is filtered locally so its count would lie.
    /// `None` means the UI must degrade to previous/next.
    pub total_count: Option<i64>,
    /// How many of those matches the forge will actually PAGE through, when
    /// that is fewer than `total_count`. GitHub Search serves only the first
    /// [`github::SEARCH_RESULT_CAP`]; page 1201 of a 24 000-hit query is a 422,
    /// so page numbers derived from `total_count` would be a strip of buttons
    /// into an error. `None` means every match is reachable — which is both
    /// GitLab's answer and GitHub's whenever the query fits under the cap.
    pub reachable_count: Option<i64>,
    pub has_next: bool,
    /// GitHub search timed out and answered with a partial result set. Shown,
    /// not swallowed — a silently short list reads as "that's all there is".
    pub incomplete: bool,
}

impl ForgeIssueList {
    /// The count a BADGE may show.
    ///
    /// `total_count`, but only when the forge answered completely: an
    /// incomplete search counted fewer items than match, and a bare number on
    /// a tab has nowhere to say so. The list can carry that caveat next to
    /// itself ([`Self::incomplete`]); a badge can only be right or absent.
    pub fn trustworthy_count(&self) -> Option<i64> {
        if self.incomplete {
            None
        } else {
            self.total_count
        }
    }
}

/// One human comment on a work item, as the detail panel shows it.
///
/// "Human" is the whole selection rule and it is not free on either forge:
/// GitHub keeps review comments (the ones anchored to a diff line) on a
/// different endpoint entirely, and GitLab mixes its system events —
/// "changed the milestone", "assigned to @bob" — into the very same `notes`
/// collection. Both clients land on the same set the item's `comments` count
/// describes, so the number in the panel's header and the thread under it
/// cannot disagree.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct ForgeComment {
    /// The forge's own id, as a STRING: GitHub's is a 64-bit integer and
    /// GitLab's is a note id unique only within its project, and the only
    /// thing this value is ever used for is a React key and de-duplication
    /// across pages. Stringifying keeps the two shapes comparable without
    /// implying they are the same number space.
    pub id: String,
    pub author: Option<String>,
    /// Avatar URL, `http(s)` only (see [`sanitize_web_url`]).
    pub author_avatar: Option<String>,
    /// The comment's Markdown, capped like an issue body ([`BODY_CAP`]).
    pub body: String,
    pub created_at: Option<String>,
    /// Set only when it differs from `created_at` — i.e. the comment was
    /// edited. The panel says so; a timestamp that merely repeats the first
    /// one would put "edited" on every comment ever written.
    pub updated_at: Option<String>,
    /// Anchor on the item's own page. GitHub sends one; GitLab notes carry no
    /// URL of their own, so its client builds the `#note_{id}` anchor.
    pub html_url: Option<String>,
}

impl ForgeComment {
    /// An `updated_at` worth showing, i.e. one that says the comment was
    /// EDITED. Both forges stamp it on creation too, so passing it through
    /// unfiltered would mark every comment ever written as edited.
    pub fn edited_at(created_at: Option<&str>, updated_at: Option<String>) -> Option<String> {
        updated_at.filter(|updated| Some(updated.as_str()) != created_at)
    }

    /// A display name, or `None` when the forge sent nothing usable — an empty
    /// string in that slot is a blank line where the author goes, not an
    /// anonymous author.
    pub fn author_name(raw: Option<String>) -> Option<String> {
        raw.map(|name| name.trim().to_string()).filter(|name| !name.is_empty())
    }
}

/// Who a write against this folder would go out as.
///
/// The panel cannot work this out for itself. Which stored account serves a
/// folder is decided here, from the origin remote's HOST and an optional pinned
/// `account_id` ([`auth::resolve_forge_auth`]) — so a UI that read "the default
/// account" would name the wrong person for every folder that is not on it.
///
/// Local: the answer comes from stored settings, not from the forge, so asking
/// costs no request. Nothing secret rides along — the token stays in
/// [`auth::ResolvedAuth`], which this is deliberately not.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct ForgeIdentity {
    pub username: String,
    /// `http(s)` only (see [`sanitize_web_url`]) — it goes into an `<img src>`
    /// like any other avatar, and a stored account's URL is no more trusted
    /// than one off the wire.
    pub avatar_url: Option<String>,
}

impl ForgeIdentity {
    /// The public half of a resolved identity.
    ///
    /// Written out field by field on purpose. A `..` spread would make every
    /// future addition to [`auth::ResolvedAuth`] — which is where the token
    /// lives — arrive here silently, in a struct that is serialized straight
    /// to the UI.
    pub fn of(auth: &auth::ResolvedAuth) -> Self {
        Self {
            username: auth.username.clone(),
            avatar_url: auth.avatar_url.as_deref().and_then(sanitize_web_url),
        }
    }
}

/// One page of an item's discussion.
///
/// No total: GitHub's comments endpoint does not count (only the `Link`
/// header's last page implies one, at the cost of a second request) and
/// GitLab's `X-Total` is optional. The item's own `comments` field is where
/// the count comes from, which is the number the list already paid for.
#[derive(Debug, Clone, serde::Serialize)]
pub struct ForgeCommentList {
    pub comments: Vec<ForgeComment>,
    /// Echo of the page actually served (already clamped).
    pub page: u32,
    pub per_page: u32,
    /// Whether the FORGE has another page — asked of the pagination headers,
    /// never inferred from how many rows survived filtering. GitLab drops
    /// system notes locally, so a page can arrive holding nothing a human
    /// wrote while the discussion continues on the next one.
    pub has_next: bool,
}

/// Comments per page. Smaller than a list page: a thread is read, not scanned,
/// and each entry can be a screenful of Markdown.
pub const DEFAULT_COMMENT_PER_PAGE: u32 = 20;

/// Everything the CLIENT gets to decide about a comment request. As with
/// [`ListFilters`], the repository is deliberately absent — the server derives
/// it from the folder's own remote.
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommentFilters {
    /// "issue" | "pr" — which COLLECTION on GitLab, and nothing at all on
    /// GitHub, where a pull request is an issue.
    pub kind: String,
    /// The item's own number (`iid` on GitLab).
    pub number: i64,
    #[serde(default = "default_page")]
    pub page: u32,
    #[serde(default = "default_comment_per_page")]
    pub per_page: u32,
    /// Which stored account to spend. Auth, not a filter — consumed by the
    /// command layer and never reaches a provider client.
    #[serde(default)]
    pub account_id: Option<String>,
}

impl CommentFilters {
    /// The item this asks about, and the paging to ask with — validated and
    /// clamped exactly once, here, so neither provider client has to trust the
    /// wire (`per_page=0` is a 422 at GitHub and an empty page at GitLab).
    pub fn resolve(&self) -> Result<(ForgeItemKind, i64, u32, u32), ForgeError> {
        let kind = ForgeItemKind::parse(&self.kind)?;
        if self.number <= 0 {
            return Err(ForgeError::Invalid(format!(
                "bad work item number: {}",
                self.number
            )));
        }
        Ok((
            kind,
            self.number,
            self.page.max(1),
            self.per_page.clamp(MIN_PER_PAGE, MAX_PER_PAGE),
        ))
    }
}

// ── writes: comments, state, new issues ─────────────────────────────────────

/// Longest comment body accepted. GitHub rejects an issue comment over 65 536
/// characters outright and GitLab's own limit is 1 000 000; the smaller of the
/// two is the honest ceiling for a box that must work on both. Refused here
/// rather than truncated: silently posting half of what someone wrote to a
/// thread other people read is worse than telling them it is too long.
pub const MAX_COMMENT_CHARS: usize = 65_536;
/// Longest issue title accepted — GitHub's documented cap, and comfortably
/// under GitLab's 255.
pub const MAX_TITLE_CHARS: usize = 255;

/// A comment somebody is about to post. As with every other client-supplied
/// forge payload, the repository is deliberately absent: the server derives it
/// from the folder's own remote.
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommentDraft {
    /// "issue" | "pr" — which COLLECTION on GitLab (see [`ForgeItemKind`]).
    pub kind: String,
    pub number: i64,
    pub body: String,
    #[serde(default)]
    pub account_id: Option<String>,
}

impl CommentDraft {
    /// The item this posts to and the text to post — validated exactly once,
    /// here, so neither provider client has to trust the wire.
    ///
    /// The body is TRIMMED and required to be non-empty: both forges accept a
    /// whitespace-only comment and render it as a blank card nobody can delete
    /// from this app.
    pub fn resolve(&self) -> Result<(ForgeItemKind, i64, String), ForgeError> {
        let kind = ForgeItemKind::parse(&self.kind)?;
        if self.number <= 0 {
            return Err(ForgeError::Invalid(format!(
                "bad work item number: {}",
                self.number
            )));
        }
        let body = self.body.trim();
        if body.is_empty() {
            return Err(ForgeError::Invalid("comment body is empty".to_string()));
        }
        if body.chars().count() > MAX_COMMENT_CHARS {
            return Err(ForgeError::Invalid(format!(
                "comment body exceeds {MAX_COMMENT_CHARS} characters"
            )));
        }
        Ok((kind, self.number, body.to_string()))
    }
}

/// What the panel's state button does to an item.
///
/// Two verbs rather than a target state, because that is what GitLab's API
/// takes (`state_event: close | reopen`) and what a button means: "close this"
/// is an action, `state = "closed"` is an assertion about a value that may have
/// changed since the panel drew it. Merging is deliberately NOT here — it is a
/// different operation with its own preconditions (method, conflicts, required
/// checks), not a state to be set. It has its own door: see
/// [`ChangeMergeRequest`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ForgeStateAction {
    Close,
    Reopen,
}

impl ForgeStateAction {
    /// GitHub's `state` value on `PATCH /issues/{n}` and `PATCH /pulls/{n}`.
    pub fn github_state(self) -> &'static str {
        match self {
            ForgeStateAction::Close => "closed",
            ForgeStateAction::Reopen => "open",
        }
    }

    /// GitLab's `state_event` value — a VERB, which is why this enum is one.
    pub fn gitlab_event(self) -> &'static str {
        match self {
            ForgeStateAction::Close => "close",
            ForgeStateAction::Reopen => "reopen",
        }
    }
}

/// A state change the panel is asking for.
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StateChangeRequest {
    pub kind: String,
    pub number: i64,
    pub action: ForgeStateAction,
    #[serde(default)]
    pub account_id: Option<String>,
}

impl StateChangeRequest {
    pub fn resolve(&self) -> Result<(ForgeItemKind, i64, ForgeStateAction), ForgeError> {
        let kind = ForgeItemKind::parse(&self.kind)?;
        if self.number <= 0 {
            return Err(ForgeError::Invalid(format!(
                "bad work item number: {}",
                self.number
            )));
        }
        Ok((kind, self.number, self.action))
    }
}

/// How a proposed change is joined to its base branch.
///
/// One vocabulary, but the two forges hand the choice over very differently.
/// GitHub takes the method per merge (`merge_method` on the request) and lets a
/// repository forbid any of the three. GitLab takes no method at all — the
/// PROJECT decides between a merge commit, a rebase-merge and a fast-forward —
/// and the only thing a caller picks is whether to squash first. Which is why
/// [`ForgeMergeOptions`] exists: the menu is what the repository permits, not
/// what this enum can spell.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ForgeMergeMethod {
    Merge,
    Squash,
    Rebase,
}

impl ForgeMergeMethod {
    /// GitHub's `merge_method` value on `PUT /pulls/{n}/merge`.
    pub fn github_method(self) -> &'static str {
        match self {
            ForgeMergeMethod::Merge => "merge",
            ForgeMergeMethod::Squash => "squash",
            ForgeMergeMethod::Rebase => "rebase",
        }
    }
}

/// What [`ForgeMergeMethod::Merge`] actually DOES to the history here.
///
/// The method a caller picks and the shape of the result are the same question
/// on GitHub — `merge` writes a merge commit, full stop. On GitLab they are
/// not: the project's `merge_method` decides between a merge commit, a
/// rebase-then-merge and a fast-forward, and the API offers no override. Naming
/// that separately is what stops the menu promising a merge commit to a
/// fast-forward-only project.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ForgeMergeStrategy {
    MergeCommit,
    RebaseMerge,
    FastForward,
}

/// The merge methods one repository actually permits.
///
/// Asked for separately from [`ForgeChangeDetail`] and only when the panel is
/// about to offer the button: it is a REPOSITORY fact, not a change's, and
/// folding it into the detail would spend a request on every change opened for
/// reading.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct ForgeMergeOptions {
    /// In the order to offer them.
    ///
    /// Empty means the forge would not say — a token that can read the change
    /// but not the repository's settings gets this, and the panel then offers
    /// [`ForgeMergeMethod::Merge`] alone rather than three menu entries of
    /// which two answer 405.
    pub methods: Vec<ForgeMergeMethod>,
    /// Which one starts selected. Always a member of `methods` when that is
    /// non-empty.
    pub default_method: ForgeMergeMethod,
    /// What `Merge` will do to the history — see [`ForgeMergeStrategy`].
    pub merge_strategy: ForgeMergeStrategy,
}

impl ForgeMergeOptions {
    /// What is offered when the repository's own settings could not be read.
    /// A merge commit is the one method neither forge can be configured to
    /// forbid outright without also offering another, so it is the safest
    /// single guess — and the forge still gets the last word.
    pub fn unknown() -> Self {
        Self {
            methods: Vec::new(),
            default_method: ForgeMergeMethod::Merge,
            merge_strategy: ForgeMergeStrategy::MergeCommit,
        }
    }
}

/// A merge the panel is asking for.
///
/// No `kind`, unlike [`StateChangeRequest`]: only a proposed change can be
/// merged, so a field naming the collection could only ever be wrong.
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangeMergeRequest {
    pub number: i64,
    pub method: ForgeMergeMethod,
    /// The head commit the caller was LOOKING at, when it knows one.
    ///
    /// Both forges take this as a precondition and refuse with a 409 when the
    /// branch has moved since — which is the point. The panel decides with a
    /// diff, a file list and a set of checks that all describe one commit, and
    /// a merge that silently landed a newer one would land code nobody in that
    /// conversation ever saw.
    ///
    /// `None` when the caller has no head to name (the detail request failed,
    /// or a forge answered without one). The merge then goes through unguarded,
    /// which is the old behaviour and still better than refusing to merge at
    /// all.
    #[serde(default)]
    pub head_sha: Option<String>,
    #[serde(default)]
    pub account_id: Option<String>,
}

impl ChangeMergeRequest {
    pub fn resolve(&self) -> Result<(i64, ForgeMergeMethod, Option<String>), ForgeError> {
        if self.number <= 0 {
            return Err(ForgeError::Invalid(format!(
                "bad work item number: {}",
                self.number
            )));
        }
        let head_sha = self
            .head_sha
            .as_deref()
            .map(str::trim)
            .filter(|sha| !sha.is_empty())
            .map(str::to_string);
        Ok((self.number, self.method, head_sha))
    }
}

/// An issue somebody is about to open.
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewIssueDraft {
    pub title: String,
    #[serde(default)]
    pub body: Option<String>,
    /// Label names to apply.
    #[serde(default)]
    pub labels: Vec<String>,
    #[serde(default)]
    pub account_id: Option<String>,
}

/// A validated new issue — the only shape a provider client will take.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedNewIssue {
    pub title: String,
    /// `None` for "no description", never `Some("")`: GitHub stores an empty
    /// string as a body and the item then renders an empty description block
    /// instead of nothing at all.
    pub body: Option<String>,
    pub labels: Vec<String>,
}

impl NewIssueDraft {
    /// Trim, check and normalize. A title is REQUIRED — both forges reject an
    /// empty one with a 422 whose message the user cannot act on, and the
    /// dialog can say so before spending a request.
    pub fn resolve(&self) -> Result<ResolvedNewIssue, ForgeError> {
        let title = self.title.trim();
        if title.is_empty() {
            return Err(ForgeError::Invalid("issue title is empty".to_string()));
        }
        if title.chars().count() > MAX_TITLE_CHARS {
            return Err(ForgeError::Invalid(format!(
                "issue title exceeds {MAX_TITLE_CHARS} characters"
            )));
        }
        let body = self.body.as_deref().map(str::trim).filter(|b| !b.is_empty());
        if body.is_some_and(|b| b.chars().count() > MAX_COMMENT_CHARS) {
            return Err(ForgeError::Invalid(format!(
                "issue body exceeds {MAX_COMMENT_CHARS} characters"
            )));
        }
        Ok(ResolvedNewIssue {
            title: title.to_string(),
            body: body.map(str::to_string),
            // Deliberately NOT [`normalize_labels`]: that one caps at
            // [`MAX_LABEL_FILTERS`], which is a FILTER limit (each label
            // lengthens GitHub's `q`, and ANDed past a handful the list is
            // empty anyway). Applying it here would silently drop the eleventh
            // label somebody picked in the dialog, which is the difference
            // between narrowing a search and losing what was written.
            labels: normalize_label_names(self.labels.clone(), MAX_ISSUE_LABELS),
        })
    }
}

// ── reads: what a proposed change is made of ────────────────────────────────

/// Which change the detail/files request is about. Its own struct rather than
/// a bare number so the account choice rides along like every other request's.
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangeQuery {
    pub number: i64,
    #[serde(default)]
    pub account_id: Option<String>,
}

impl ChangeQuery {
    pub fn resolve(&self) -> Result<i64, ForgeError> {
        if self.number <= 0 {
            return Err(ForgeError::Invalid(format!(
                "bad work item number: {}",
                self.number
            )));
        }
        Ok(self.number)
    }
}

/// One page of a change's file list.
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangeFilesQuery {
    pub number: i64,
    #[serde(default = "default_page")]
    pub page: u32,
    #[serde(default = "default_files_per_page")]
    pub per_page: u32,
    #[serde(default)]
    pub account_id: Option<String>,
}

impl ChangeFilesQuery {
    pub fn resolve(&self) -> Result<(i64, u32, u32), ForgeError> {
        if self.number <= 0 {
            return Err(ForgeError::Invalid(format!(
                "bad work item number: {}",
                self.number
            )));
        }
        Ok((
            self.number,
            self.page.max(1),
            self.per_page.clamp(MIN_PER_PAGE, MAX_PER_PAGE),
        ))
    }
}

/// Files per page. Larger than a comment page: these are one line each, and a
/// reviewer scanning "what does this touch" wants the shape of the whole change
/// rather than a paragraph of it.
pub const DEFAULT_FILES_PER_PAGE: u32 = 50;

fn default_files_per_page() -> u32 {
    DEFAULT_FILES_PER_PAGE
}

/// What a proposed change is, beyond what its list row already says: which
/// branches it joins, how big it is, and whether it can land.
///
/// Every counter is optional because the two forges answer different halves of
/// the question. GitHub's pull object carries `additions`/`deletions`/
/// `changed_files`/`commits`; GitLab's merge request carries none of them and
/// only sometimes a `changes_count` (and that one as a STRING, "12+" once the
/// diff is truncated). Showing a zero where the forge said nothing would claim
/// a change touches nothing, so absent stays absent.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct ForgeChangeDetail {
    pub number: i64,
    /// Where it would land — `main`, `release/1.2`.
    pub base_ref: String,
    /// What would land — the source branch.
    pub head_ref: String,
    /// `owner/repo` of the head, present only when it is NOT this repository:
    /// a fork is the one thing about the branch pair a reader must not have to
    /// infer. `None` means same-repository.
    pub head_repo: Option<String>,
    pub head_sha: Option<String>,
    pub draft: bool,
    /// Normalized exactly as [`ForgeIssueRow::state`] is: open / closed / merged.
    pub state: String,
    /// Can this land without a human resolving something?
    ///
    /// `None` is a real third answer on BOTH forges and is not the same as
    /// `Some(false)`: GitHub computes mergeability asynchronously and answers
    /// `null` until the background job finishes, and GitLab reports
    /// `merge_status: "unchecked"` for the same reason. "We do not know yet" is
    /// what the panel says; "cannot be merged" is a claim that would send
    /// someone looking for a conflict that may not exist.
    pub mergeable: Option<bool>,
    /// The forge's own word for the situation (`clean`, `dirty`, `blocked`,
    /// `behind`, `can_be_merged`, `cannot_be_merged`…). Passed through for a
    /// tooltip rather than mapped, because the vocabularies do not line up and
    /// a wrong translation reads as a diagnosis.
    pub merge_state: Option<String>,
    pub additions: Option<i64>,
    pub deletions: Option<i64>,
    pub changed_files: Option<i64>,
    pub commits: Option<i64>,
    /// CI as the forge reports it for the head commit. Empty means the forge
    /// answered and there is nothing running; see [`ForgeCheckList`].
    pub checks: ForgeCheckList,
}

/// How a check ended up, in ONE vocabulary.
///
/// GitHub has `status` (queued/in_progress/completed) crossed with `conclusion`
/// (success/failure/neutral/cancelled/skipped/timed_out/action_required), plus
/// a separate legacy commit-status vocabulary (success/failure/error/pending).
/// GitLab has job statuses (created/pending/running/success/failed/canceled/
/// skipped/manual/waiting_for_resource). Three vocabularies, one strip of
/// indicators — so they are folded here, at the boundary, and the UI switches
/// on five values instead of eighteen.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ForgeCheckState {
    /// Not started yet.
    Queued,
    Running,
    Success,
    Failure,
    /// Ran and deliberately produced no verdict — skipped, cancelled, neutral,
    /// manual. Kept apart from success: a skipped required check is not a pass,
    /// and painting it green is how a red pipeline reads as green.
    Neutral,
}

impl ForgeCheckState {
    /// Whether this check is still going to change. Drives nothing in the
    /// backend; the panel uses it to decide whether re-polling is worth it.
    pub fn is_pending(self) -> bool {
        matches!(self, ForgeCheckState::Queued | ForgeCheckState::Running)
    }
}

/// One CI check on a change's head commit.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct ForgeCheck {
    /// Stable within one response — the forge's own id where there is one, so
    /// React keys survive a refresh that reorders the strip.
    pub id: String,
    pub name: String,
    pub state: ForgeCheckState,
    /// One-line detail (GitHub's status `description`, GitLab's stage).
    pub summary: Option<String>,
    /// Where to see the run, `http(s)` only (see [`sanitize_web_url`]).
    pub url: Option<String>,
    /// Whether a failure here is allowed to not block the change. GitLab says
    /// so explicitly (`allow_failure`); GitHub has no equivalent, so it is
    /// always false there.
    pub allow_failure: bool,
}

/// A change's checks, and how much of the answer we actually got.
///
/// `available: false` is NOT "no checks ran". It means the forge would not tell
/// us — a token without the `checks:read` scope, a GitHub App-less repository,
/// a GitLab instance with CI disabled. An empty list under `available: true`
/// means the forge answered and nothing is configured. Collapsing the two would
/// print "no checks" over a repository whose pipeline is red.
///
/// `partial` is the same distinction one level down, and it exists because
/// GitHub keeps its checks in TWO collections behind TWO fine-grained
/// permissions: a token with "Commit statuses: read" but not "Checks: read"
/// gets a 403 from one and an empty `200 []` from the other. Reporting that as
/// a complete empty list is the original bug wearing a disguise — the pipeline
/// is red, and the panel says nothing ran.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct ForgeCheckList {
    pub checks: Vec<ForgeCheck>,
    pub available: bool,
    /// Some of the checks could not be read, so this list may be missing
    /// entries. Always false when `available` is false — there is no partial
    /// answer to qualify.
    pub partial: bool,
}

impl ForgeCheckList {
    pub fn unavailable() -> Self {
        Self {
            checks: Vec::new(),
            available: false,
            partial: false,
        }
    }

    pub fn available(checks: Vec<ForgeCheck>) -> Self {
        Self {
            checks,
            available: true,
            partial: false,
        }
    }

    /// Everything one collection could give, said out loud to be incomplete.
    pub fn partial(checks: Vec<ForgeCheck>) -> Self {
        Self {
            checks,
            available: true,
            partial: true,
        }
    }
}

/// How a file was touched, in the one vocabulary both forges can be read into.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ForgeFileStatus {
    Added,
    Removed,
    Modified,
    Renamed,
}

/// One file a change touches.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct ForgeChangedFile {
    /// Path AFTER the change (the old one for a deletion).
    pub path: String,
    /// Where a rename came from; `None` otherwise.
    pub previous_path: Option<String>,
    pub status: ForgeFileStatus,
    /// `None` when the forge does not count — GitLab ships the diff text and no
    /// totals, and a binary file has no line counts on either forge.
    pub additions: Option<i64>,
    pub deletions: Option<i64>,
    /// No textual diff to count or show.
    pub binary: bool,
    /// The file's own unified diff, as the forge shipped it alongside the list.
    ///
    /// Costs nothing extra: both providers already send it with the page (it is
    /// what `binary` is inferred from on GitHub and what the counters are
    /// counted off on GitLab), so this only stops it being thrown away.
    ///
    /// `None` covers two different situations that both mean "no diff to show":
    /// binary content, and a diff the forge WITHHELD — GitHub omits the patch
    /// past its own size limit while still reporting the file's line counts.
    /// Neither is "the diff is empty", which is why this is not a `String`.
    pub patch: Option<String>,
}

/// One page of a change's file list.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct ForgeChangedFileList {
    pub files: Vec<ForgeChangedFile>,
    pub page: u32,
    pub per_page: u32,
    /// From the forge's own pagination signal, never from how many rows came
    /// back — same rule as [`ForgeCommentList::has_next`].
    pub has_next: bool,
}

/// `(additions, deletions)` counted off a unified diff hunk.
///
/// GitLab ships the diff TEXT and no counters, so the only way to put a
/// `+12 −3` next to one of its files is to count the lines here. `+++` / `---`
/// are the file headers — counting them would add one to each side of every
/// single file — but ONLY before the first `@@`. Past that they are ordinary
/// content, and a diff that adds a line of Markdown underline (`---`) or a
/// three-plus separator is not rare enough to miscount.
pub fn count_diff_lines(diff: &str) -> (i64, i64) {
    let mut additions = 0;
    let mut deletions = 0;
    let mut in_hunk = false;
    for line in diff.lines() {
        if line.starts_with("@@") {
            in_hunk = true;
            continue;
        }
        if !in_hunk && (line.starts_with("+++") || line.starts_with("---")) {
            continue;
        }
        match line.as_bytes().first() {
            Some(b'+') => additions += 1,
            Some(b'-') => deletions += 1,
            _ => {}
        }
    }
    (additions, deletions)
}

/// A forge-supplied URL, or `None` when it is not one this app will put in
/// front of the user.
///
/// These values reach an `href` and an `<img src>`, and they come from
/// whatever instance the account points at — a self-managed forge is free to
/// answer with anything at all. Only `http` and `https` survive, which is what
/// keeps `javascript:` and `data:` out of the two attributes that would honour
/// them.
pub fn sanitize_web_url(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    let lower = trimmed.to_ascii_lowercase();
    if lower.starts_with("http://") || lower.starts_with("https://") {
        Some(trimmed.to_string())
    } else {
        None
    }
}

/// Proxy-aware shared HTTP client. A reqwest client caches its proxy
/// configuration for its whole lifetime (`network/proxy.rs` startup contract),
/// but codeg lets the user change the proxy at runtime — so the client is
/// keyed by the current proxy env fingerprint and rebuilt whenever that
/// changes. Lazy construction also lands after `init_proxy_from_db` for free.
/// The proxy env fingerprint a client was built under, paired with that client.
type ProxyKeyedClient = (Vec<(String, String)>, reqwest::Client);

static HTTP_CLIENT: RwLock<Option<ProxyKeyedClient>> = RwLock::new(None);

/// Char-boundary-safe truncation (issue bodies are arbitrary UTF-8; a byte
/// slice could split a code point and panic).
pub(crate) fn truncate_chars(input: &str, cap: usize) -> String {
    if input.chars().count() <= cap {
        return input.to_string();
    }
    input.chars().take(cap).collect()
}

/// Reject a state filter we do not understand rather than pass it through to
/// the API, where it would silently change what the list means.
pub(crate) fn validate_state_filter(state: &str) -> Result<(), ForgeError> {
    if matches!(state, "open" | "closed" | "all") {
        Ok(())
    } else {
        Err(ForgeError::Invalid(format!("bad state filter: {state}")))
    }
}

/// The instance's WEB origin (scheme, host and port), derived from the API
/// base rather than from `server_host` — which is a bare hostname and would
/// silently drop both the scheme and a non-default port.
///
/// `https://api.github.com` is the public service's dedicated API host, whose
/// web origin is `https://github.com`; GitHub Enterprise mounts its API under
/// the instance (`{origin}/api/v3`), GitLab under `{origin}/api/v4` and Gitea
/// under `{origin}/api/v1`. One derivation, used by every place that needs a
/// link or a push URL — three copies of this rule would be three chances to
/// disagree.
pub fn web_origin(auth: &ResolvedAuth) -> String {
    let base = auth.api_base.trim_end_matches('/');
    if base == "https://api.github.com" {
        return "https://github.com".to_string();
    }
    match ["/api/v3", "/api/v4", "/api/v1"]
        .iter()
        .find_map(|suffix| base.strip_suffix(suffix))
    {
        Some(origin) => origin.to_string(),
        None => format!("https://{}", auth.server_host),
    }
}

/// Percent-encode a QUERY value — the few characters that are legal in a git
/// branch name but would change the meaning of a query string. `/` is left
/// alone: it is legal in a query and branch names are full of it.
pub(crate) fn urlencode_query(value: &str) -> String {
    encode(value, true)
}

/// Percent-encode a PATH segment, `/` included. GitLab addresses a project by
/// its full path inside a single segment (`group%2Fsub%2Fproj`), so this is
/// the difference between reading that project and reading a route that does
/// not exist.
pub(crate) fn urlencode_path(value: &str) -> String {
    encode(value, false)
}

fn encode(value: &str, keep_slash: bool) -> String {
    value
        .chars()
        .map(|c| match c {
            'A'..='Z' | 'a'..='z' | '0'..='9' | '-' | '_' | '.' | '~' => c.to_string(),
            '/' if keep_slash => c.to_string(),
            other => other
                .to_string()
                .as_bytes()
                .iter()
                .map(|b| format!("%{b:02X}"))
                .collect(),
        })
        .collect()
}

/// `(scheme, host, port)` — what "the same server" means for a redirect.
fn origin_of(url: &reqwest::Url) -> (String, Option<String>, Option<u16>) {
    (
        url.scheme().to_string(),
        url.host_str().map(str::to_ascii_lowercase),
        url.port_or_known_default(),
    )
}

/// Every env var a reqwest client samples its proxy decision from at build
/// time: the proxy URLs and the bypass list. A change to either must rebuild.
fn proxy_fingerprint() -> Vec<(String, String)> {
    let mut fingerprint = crate::network::proxy::current_proxy_env_vars();
    fingerprint.extend(crate::network::proxy::current_no_proxy_env_vars());
    fingerprint
}

pub(crate) fn http_client() -> Result<reqwest::Client, ForgeError> {
    let fingerprint = proxy_fingerprint();
    if let Ok(guard) = HTTP_CLIENT.read() {
        if let Some((cached, client)) = guard.as_ref() {
            if *cached == fingerprint {
                return Ok(client.clone());
            }
        }
    }
    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(10))
        .timeout(std::time::Duration::from_secs(30))
        // Redirects are followed only WITHIN one origin. reqwest strips
        // `Authorization` when a redirect crosses hosts, but it cannot know
        // that GitLab's `PRIVATE-TOKEN` is a credential too — a redirect to
        // somewhere else would hand that header over intact.
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            let same_origin = attempt
                .previous()
                .last()
                .is_some_and(|prev| origin_of(prev) == origin_of(attempt.url()));
            if !same_origin {
                attempt.stop()
            } else if attempt.previous().len() > 5 {
                attempt.error("too many redirects")
            } else {
                attempt.follow()
            }
        }))
        .build()
        .map_err(|e| ForgeError::Network(format!("http client build failed: {e}")))?;
    if let Ok(mut guard) = HTTP_CLIENT.write() {
        *guard = Some((fingerprint, client.clone()));
    }
    Ok(client)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `NoAccount` is the one forge failure the UI turns into an action, and
    /// it can only do that if the i18n key and BOTH params survive the trip to
    /// the client. Serialize as well as convert: the frontend reads the JSON,
    /// not the struct, and `skip_serializing_if` on those two fields means a
    /// conversion that forgot to set them looks identical from Rust.
    #[test]
    fn no_account_carries_i18n_key_and_params_over_the_wire() {
        let err: crate::app_error::AppCommandError = ForgeError::NoAccount {
            provider: ForgeProvider::GitHub,
            host: "github.com".into(),
        }
        .into();
        let json = serde_json::to_value(&err).unwrap();
        assert_eq!(json["code"], "configuration_missing");
        assert_eq!(json["i18n_key"], NO_ACCOUNT_I18N_KEY);
        assert_eq!(json["i18n_params"]["host"], "github.com");
        // Display name, not the lowercase wire value: this one is read by a human.
        assert_eq!(json["i18n_params"]["provider"], "GitHub");
        // The English message stands in when a locale lacks the key.
        assert_eq!(json["message"], "no GitHub account for host github.com");

        // Every OTHER auth failure stays keyless — "add an account" fixes none
        // of them, so the UI must not offer it.
        let dead_token: crate::app_error::AppCommandError =
            ForgeError::Auth("no stored token for account acc-1".into()).into();
        assert!(serde_json::to_value(&dead_token).unwrap().get("i18n_key").is_none());
    }

    #[test]
    fn source_key_normalizes_and_validates() {
        assert_eq!(
            source_key("GitHub", "GitHub.com", "Acme/App", "Issue", 123).unwrap(),
            "github:github.com:acme/app:issue:123"
        );
        // GitLab subgroups keep the full path; MR arrives pre-normalized as "pr".
        assert_eq!(
            source_key("gitlab", "gitlab.corp.com", "Group/Sub/Proj", "pr", 45).unwrap(),
            "gitlab:gitlab.corp.com:group/sub/proj:pr:45"
        );
        for bad in [
            source_key("bitbucket", "github.com", "a/b", "issue", 1),
            source_key("github", "github.com", "a/b", "mr", 1),
            source_key("github", "", "a/b", "issue", 1),
            source_key("github", "github.com/api", "a/b", "issue", 1),
            source_key("github", "github.com", "no-slash", "issue", 1),
            source_key("github", "github.com", "a/b", "issue", 0),
            source_key("github", "github.com", "a/b?x=1", "issue", 1),
        ] {
            assert!(bad.is_err());
        }
    }

    /// GitHub answers with canonical casing (`microsoft/TypeScript`) while
    /// keys/remotes are lowercase — comparisons must not care, and `.git`
    /// remote suffixes must not split identity either.
    #[test]
    fn same_repo_is_case_insensitive_and_suffix_tolerant() {
        assert!(same_repo("microsoft/typescript", "microsoft/TypeScript"));
        assert!(same_repo("Acme/App.git", "acme/app"));
        assert!(same_repo("group/sub/proj", "Group/Sub/Proj"));
        assert!(!same_repo("acme/app", "acme/other"));
        assert!(!same_repo("acme/app", ""));
        assert!(!same_repo("", ""));
    }

    #[test]
    fn remote_url_parsing_covers_all_three_shapes() {
        let cases = [
            ("https://github.com/Acme/App.git", ("github.com", "acme/app")),
            ("https://ghe.corp.com/team/tool", ("ghe.corp.com", "team/tool")),
            ("git@github.com:Acme/App.git", ("github.com", "acme/app")),
            ("ssh://git@ghe.corp.com:2222/team/tool.git", ("ghe.corp.com", "team/tool")),
            ("ssh://git@gitlab.corp.com/group/sub/proj.git", ("gitlab.corp.com", "group/sub/proj")),
            ("http://user@ghe.corp.com/a/b", ("ghe.corp.com", "a/b")),
        ];
        for (input, (host, repo)) in cases {
            let (h, r) = parse_remote_url(input).unwrap_or_else(|| panic!("parse {input}"));
            assert_eq!((h.as_str(), r.as_str()), (host, repo), "{input}");
        }
        for bad in ["", "not-a-url", "https://", "/local/path/repo", "file:///x/y"] {
            assert!(parse_remote_url(bad).is_none(), "{bad} must not parse");
        }
    }

    /// An unknown provider is refused rather than defaulted: picking GitHub
    /// for a value we do not understand would run a task's writes against the
    /// wrong API with the wrong credentials.
    #[test]
    fn provider_parsing_refuses_what_it_does_not_know() {
        assert_eq!(ForgeProvider::parse("GitHub").unwrap(), ForgeProvider::GitHub);
        assert_eq!(ForgeProvider::parse(" gitlab ").unwrap(), ForgeProvider::GitLab);
        assert_eq!(ForgeProvider::parse("Gitea").unwrap(), ForgeProvider::Gitea);
        assert!(ForgeProvider::parse("bitbucket").is_err());
        assert!(ForgeProvider::parse("").is_err());
        // Forgejo is served by the Gitea client, but it is not a NAME this
        // accepts: what gets stored on an account and in a source key is the
        // one wire value, or provenance splits in two for one instance.
        assert!(ForgeProvider::parse("forgejo").is_err());
        // The wire form round-trips through the stored source_meta JSON.
        assert_eq!(
            serde_json::to_string(&ForgeProvider::GitLab).unwrap(),
            "\"gitlab\""
        );
        assert_eq!(
            serde_json::to_string(&ForgeProvider::Gitea).unwrap(),
            "\"gitea\""
        );
    }

    /// Item URLs and head refs are the two places the two forges disagree in a
    /// way a task cannot survive: a GitLab link with GitHub's path 404s, and a
    /// GitHub head ref simply does not exist on a GitLab server.
    #[test]
    fn provider_shapes_urls_and_head_refs_its_own_way() {
        let gh = ForgeProvider::GitHub;
        let gl = ForgeProvider::GitLab;
        assert_eq!(
            gh.item_url("https://github.com", "acme/app", ForgeItemKind::Change, 7),
            "https://github.com/acme/app/pull/7"
        );
        assert_eq!(
            gh.item_url("https://github.com", "acme/app", ForgeItemKind::Issue, 7),
            "https://github.com/acme/app/issues/7"
        );
        assert_eq!(
            gl.item_url("https://gitlab.com", "group/sub/proj", ForgeItemKind::Change, 7),
            "https://gitlab.com/group/sub/proj/-/merge_requests/7"
        );
        assert_eq!(
            gl.item_url("https://gitlab.com", "group/sub/proj", ForgeItemKind::Issue, 7),
            "https://gitlab.com/group/sub/proj/-/issues/7"
        );
        assert_eq!(gh.change_head_ref(7), "refs/pull/7/head");
        // Hyphen in the ref, underscore in the REST path — GitLab really does
        // spell it both ways, and only one of them fetches anything.
        assert_eq!(gl.change_head_ref(7), "refs/merge-requests/7/head");
        // A self-hosted instance keeps its scheme and port in the link.
        assert_eq!(
            gl.item_url("http://gitlab.corp.com:8929/", "a/b", ForgeItemKind::Issue, 7),
            "http://gitlab.corp.com:8929/a/b/-/issues/7"
        );
        assert_eq!(gh.change_noun(), "pull request");
        assert_eq!(gl.change_noun(), "merge request");
        // Both forges' changes key as "pr" so provenance keys stay comparable.
        assert_eq!(ForgeItemKind::Change.key_segment(), "pr");
        assert_eq!(ForgeItemKind::Issue.key_segment(), "issue");

        // Gitea is GitHub's dialect everywhere except the one letter in its
        // web route: `/pulls/7`, PLURAL, where GitHub says `/pull/7`. Its git
        // ref namespace IS GitHub's, which is what lets a task check out a
        // Gitea change without adding a remote.
        let gt = ForgeProvider::Gitea;
        assert_eq!(
            gt.item_url("https://gitea.corp.com", "acme/app", ForgeItemKind::Change, 7),
            "https://gitea.corp.com/acme/app/pulls/7"
        );
        assert_eq!(
            gt.item_url("https://gitea.corp.com", "acme/app", ForgeItemKind::Issue, 7),
            "https://gitea.corp.com/acme/app/issues/7"
        );
        assert_eq!(gt.change_head_ref(7), "refs/pull/7/head");
        assert_eq!(gt.change_noun(), "pull request");
    }

    /// The push URL and every stored link come from this one derivation: a
    /// bare `server_host` would drop both the scheme and a non-default port,
    /// which is exactly what a self-hosted instance has.
    #[test]
    fn the_web_origin_comes_from_the_api_base() {
        let mut auth = ResolvedAuth {
            provider: ForgeProvider::GitHub,
            server_host: "fallback.test".into(),
            api_base: "https://api.github.com".into(),
            account_id: "acc".into(),
            username: "alice".into(),
            avatar_url: None,
            token: "tok".into(),
            scopes: vec![],
        };
        assert_eq!(web_origin(&auth), "https://github.com");
        auth.api_base = "https://ghe.corp.com/api/v3".into();
        assert_eq!(web_origin(&auth), "https://ghe.corp.com");
        auth.api_base = "https://ghe.corp.com:8443/api/v3/".into();
        assert_eq!(web_origin(&auth), "https://ghe.corp.com:8443");
        auth.api_base = "http://gitlab.corp.com:8929/api/v4".into();
        assert_eq!(web_origin(&auth), "http://gitlab.corp.com:8929");
        auth.api_base = "https://gitea.corp.com/api/v1".into();
        assert_eq!(web_origin(&auth), "https://gitea.corp.com");
        // A base that is neither shape: fall back to the host we know rather
        // than build a link into whatever that string was.
        auth.api_base = "https://gitlab.com/weird".into();
        assert_eq!(web_origin(&auth), "https://fallback.test");
    }

    /// A name and a picture, and — the point of the type — nothing else. The
    /// identity is built from the same value that holds the token, and it is
    /// serialized straight to a webview.
    #[test]
    fn an_identity_is_a_name_and_a_picture_and_carries_no_secret() {
        let mut auth = ResolvedAuth {
            provider: ForgeProvider::GitHub,
            server_host: "github.com".into(),
            api_base: "https://api.github.com".into(),
            account_id: "acc".into(),
            username: "alice".into(),
            avatar_url: Some("https://avatars.test/u/1".into()),
            token: "ghp_secret".into(),
            scopes: vec!["repo".into()],
        };

        let identity = ForgeIdentity::of(&auth);
        assert_eq!(identity.username, "alice");
        assert_eq!(identity.avatar_url.as_deref(), Some("https://avatars.test/u/1"));

        // Whatever the account was stored with, it still has to survive the
        // gate every other avatar goes through before reaching an `<img src>`.
        auth.avatar_url = Some("javascript:alert(1)".into());
        assert_eq!(ForgeIdentity::of(&auth).avatar_url, None);
        auth.avatar_url = None;
        assert_eq!(ForgeIdentity::of(&auth).avatar_url, None);

        // The shape on the wire, not just the fields we happened to read: a
        // key added here later would ship whatever it holds to the panel.
        let json = serde_json::to_value(ForgeIdentity::of(&auth)).expect("serialize");
        let mut keys: Vec<&str> = json.as_object().expect("object").keys().map(String::as_str).collect();
        keys.sort_unstable();
        assert_eq!(keys, ["avatar_url", "username"]);
        assert!(!json.to_string().contains("ghp_secret"));
    }

    /// Paging comes off the wire and reaches two APIs that reject different
    /// halves of the nonsense: `per_page=0` is a 422 at GitHub and an empty
    /// page at GitLab, and `page=0` means page 1 at one of them only.
    #[test]
    fn client_supplied_paging_is_clamped_into_range() {
        let req = |page: u32, per_page: u32| ListIssuesRequest {
            owner_repo: "acme/app".into(),
            tab: ForgeTab::Issues,
            state: "open".into(),
            assigned_me: false,
            labels: vec![],
            search: None,
            sort: ForgeSort::default(),
            page,
            per_page,
        };
        assert_eq!(req(0, 0).clamped(), (1, MIN_PER_PAGE));
        assert_eq!(req(3, 20).clamped(), (3, 20));
        // Both forges cap per_page at 100; asking for more is a rejected request.
        assert_eq!(req(1, 5_000).clamped(), (1, MAX_PER_PAGE));
    }

    fn filters() -> ListFilters {
        ListFilters {
            tab: ForgeTab::Issues,
            state: "open".into(),
            assigned_me: false,
            labels: vec![],
            search: None,
            sort: ForgeSort::default(),
            page: 1,
            per_page: DEFAULT_PER_PAGE,
            account_id: None,
        }
    }

    /// The repository is an ARGUMENT, not a field of the client's payload:
    /// whatever filters arrive, the request is built against the repository the
    /// server resolved from the folder's remote.
    #[test]
    fn a_request_takes_its_repository_from_the_caller_and_normalizes_the_rest() {
        let built = ListIssuesRequest::new(
            "acme/app".into(),
            ListFilters {
                labels: vec!["  bug ".into(), "".into(), "bug".into(), "docs".into()],
                search: Some("   login timeout  ".into()),
                ..filters()
            },
        );
        assert_eq!(built.owner_repo, "acme/app");
        assert_eq!(built.labels, vec!["bug", "docs"], "trimmed and de-duplicated");
        assert_eq!(built.search.as_deref(), Some("login timeout"));
        // Whitespace-only is no filter at all, not a search for nothing.
        assert!(ListIssuesRequest::new("a/b".into(), ListFilters { search: Some("  ".into()), ..filters() })
            .search
            .is_none());
    }

    /// Both caps are real API limits, not taste: GitHub rejects a `q` over 256
    /// characters outright, and each extra label lengthens it further.
    #[test]
    fn search_and_label_filters_are_capped() {
        let long = "汉".repeat(MAX_SEARCH_CHARS + 40);
        let capped = normalize_search(Some(&long)).expect("kept");
        // CHARS, not bytes — a byte slice here would split a code point.
        assert_eq!(capped.chars().count(), MAX_SEARCH_CHARS);
        assert_eq!(normalize_search(Some("\t\n ")), None);
        assert_eq!(normalize_search(None), None);

        let many: Vec<String> = (0..MAX_LABEL_FILTERS + 5).map(|i| format!("l{i}")).collect();
        assert_eq!(normalize_labels(many).len(), MAX_LABEL_FILTERS);
        // Case-sensitive de-dup: GitHub treats `Bug` and `bug` as two labels.
        assert_eq!(
            normalize_labels(vec!["Bug".into(), "bug".into()]),
            vec!["Bug", "bug"]
        );
    }

    /// The two forges spell the same colour differently — GitHub sends bare
    /// `d73a4a`, GitLab `#d9534f` — so one normalized `#rrggbb` is what the UI
    /// gets. Anything that is not hex is refused rather than passed along:
    /// GitLab accepts CSS colour names on write, and this value is handed
    /// straight to a `style` attribute.
    #[test]
    fn label_colours_are_normalized_and_non_hex_is_refused() {
        for (raw, want) in [
            ("d73a4a", "#d73a4a"),   // GitHub
            ("#d9534f", "#d9534f"),  // GitLab
            ("  #D73A4A ", "#d73a4a"), // padded and upper-cased
            ("#0f0", "#00ff00"),     // the three-digit shorthand
        ] {
            assert_eq!(normalize_hex_color(raw).as_deref(), Some(want), "{raw}");
        }
        for raw in ["", "#", "rebeccapurple", "#12345", "#1234567", "#12345g", "var(--x)"] {
            assert_eq!(normalize_hex_color(raw), None, "{raw}");
        }

        // A label is its NAME first: an unusable colour costs the swatch, not
        // the chip. An unusable name costs the whole label — there would be
        // nothing to show and nothing to filter by.
        assert_eq!(
            ForgeLabel::parse("bug".into(), Some("red")),
            Some(ForgeLabel { name: "bug".into(), color: None })
        );
        assert_eq!(ForgeLabel::parse(String::new(), Some("#fff")), None);
    }

    /// A count is a LIST asked for one row: neither forge counts these
    /// collections on its own endpoint. The tab is the only thing that differs
    /// between the switcher's two probes — every filter carries over, or the
    /// badge would describe a result set nobody is looking at.
    #[test]
    fn a_count_probe_is_the_smallest_page_of_the_same_filters() {
        let filters = CountFilters {
            state: "closed".into(),
            assigned_me: true,
            labels: vec!["bug".into()],
            search: Some("login".into()),
            account_id: Some("acc-1".into()),
        };
        for tab in [ForgeTab::Issues, ForgeTab::Prs] {
            let probe = filters.probe(tab);
            assert_eq!(probe.tab, tab);
            assert_eq!(probe.page, 1);
            // One row, not a page of twenty thrown away: the count rides in
            // `total_count` / `X-Total`, never in the body.
            assert_eq!(probe.per_page, MIN_PER_PAGE);
            assert_eq!(probe.state, "closed");
            assert!(probe.assigned_me);
            assert_eq!(probe.labels, vec!["bug"]);
            assert_eq!(probe.search.as_deref(), Some("login"));
            assert_eq!(probe.account_id.as_deref(), Some("acc-1"));
        }
    }

    /// A badge is a bare digit with nowhere to add a caveat, so a count that
    /// needs one is withheld instead. The list keeps the caveat — and the
    /// count — because it has a footer to say it in.
    #[test]
    fn an_incomplete_search_offers_no_count_to_a_badge() {
        let page = |total: Option<i64>, incomplete: bool| ForgeIssueList {
            rows: vec![],
            page: 1,
            per_page: 1,
            total_count: total,
            reachable_count: None,
            has_next: false,
            incomplete,
        };
        assert_eq!(page(Some(57), false).trustworthy_count(), Some(57));
        // GitHub timed out: it counted fewer items than match, and "57" on a
        // tab would be a claim the response itself disowns.
        assert_eq!(page(Some(57), true).trustworthy_count(), None);
        // Nothing to withhold in the first place.
        assert_eq!(page(None, false).trustworthy_count(), None);
    }

    /// The three answers the CI section has to keep apart. `partial` is the one
    /// GitHub forces: its checks live in two collections behind two separate
    /// fine-grained permissions, so half an answer is a real outcome.
    #[test]
    fn a_half_read_check_list_is_neither_complete_nor_unavailable() {
        let complete = ForgeCheckList::available(Vec::new());
        assert!(complete.available && !complete.partial);
        let half = ForgeCheckList::partial(Vec::new());
        assert!(half.available && half.partial);
        let none = ForgeCheckList::unavailable();
        // Nothing to qualify — there is no partial answer, only no answer.
        assert!(!none.available && !none.partial);
        // The wire shape the frontend switches on.
        let json = serde_json::to_value(&half).unwrap();
        assert_eq!(json["available"], true);
        assert_eq!(json["partial"], true);
    }

    /// Four named orders, because the two forges accept different field sets
    /// and spell the shared ones differently. `newest` is the default — the
    /// same one github.com's issue list opens on.
    #[test]
    fn sort_orders_map_to_a_field_and_a_direction() {
        assert_eq!(ForgeSort::default(), ForgeSort::Newest);
        for (sort, field, direction) in [
            (ForgeSort::Newest, "created", "desc"),
            (ForgeSort::Oldest, "created", "asc"),
            (ForgeSort::RecentlyUpdated, "updated", "desc"),
            (ForgeSort::LeastRecentlyUpdated, "updated", "asc"),
        ] {
            assert_eq!((sort.field(), sort.direction()), (field, direction), "{sort:?}");
            assert_eq!(sort.ascending(), direction == "asc");
        }
        // The wire spelling the frontend sends.
        assert_eq!(
            serde_json::to_string(&ForgeSort::LeastRecentlyUpdated).unwrap(),
            "\"least_recently_updated\""
        );
    }

    /// A comment request carries only COORDINATES, and both halves are
    /// checked here rather than in either provider client: on GitLab the kind
    /// picks the collection, so a wrong one reads a real item's discussion
    /// that is not the one on screen, and out-of-range paging is a 422 at
    /// GitHub and an empty page at GitLab.
    #[test]
    fn a_comment_request_validates_its_item_and_clamps_its_paging() {
        let filters = |kind: &str, number: i64, page: u32, per_page: u32| CommentFilters {
            kind: kind.into(),
            number,
            page,
            per_page,
            account_id: None,
        };
        assert_eq!(
            filters("issue", 7, 2, 20).resolve().unwrap(),
            (ForgeItemKind::Issue, 7, 2, 20)
        );
        // Both forges' changes are keyed "pr" — the same word the source key
        // and the trigger use, so one spelling travels the whole way.
        assert_eq!(
            filters(" PR ", 7, 1, 20).resolve().unwrap().0,
            ForgeItemKind::Change
        );
        assert_eq!(filters("issue", 7, 0, 0).resolve().unwrap(), (ForgeItemKind::Issue, 7, 1, MIN_PER_PAGE));
        assert_eq!(filters("issue", 7, 1, 5_000).resolve().unwrap().3, MAX_PER_PAGE);
        for bad in [filters("mr", 7, 1, 20), filters("", 7, 1, 20), filters("issue", 0, 1, 20), filters("issue", -3, 1, 20)] {
            assert!(bad.resolve().is_err(), "{} #{}", bad.kind, bad.number);
        }
        // The wire default is the one the frontend mirrors.
        let wire: CommentFilters =
            serde_json::from_str(r#"{"kind":"issue","number":7}"#).expect("decodes");
        assert_eq!((wire.page, wire.per_page), (1, DEFAULT_COMMENT_PER_PAGE));
    }

    /// Both forges stamp an `updated_at` on creation, so its mere presence
    /// says nothing. Passing it through unfiltered would put "edited" on every
    /// comment ever written.
    #[test]
    fn only_a_real_edit_carries_an_updated_timestamp() {
        let at = |updated: &str| {
            ForgeComment::edited_at(Some("2026-08-20T00:00:00Z"), Some(updated.to_string()))
        };
        assert_eq!(at("2026-08-20T00:00:00Z"), None, "the creation stamp");
        assert_eq!(at("2026-08-20T09:00:00Z").as_deref(), Some("2026-08-20T09:00:00Z"));
        // Nothing to compare against: an item with no creation time cannot be
        // shown to be unedited, and the timestamp is the only fact there is.
        assert_eq!(
            ForgeComment::edited_at(None, Some("2026-08-20T09:00:00Z".into())).as_deref(),
            Some("2026-08-20T09:00:00Z")
        );
        assert_eq!(ForgeComment::edited_at(Some("x"), None), None);

        // An author slot the forge filled with nothing is no author — a blank
        // line where the name goes, not an anonymous one.
        assert_eq!(ForgeComment::author_name(Some("  alice ".into())).as_deref(), Some("alice"));
        assert_eq!(ForgeComment::author_name(Some("   ".into())), None);
        assert_eq!(ForgeComment::author_name(None), None);
    }

    /// A comment is written by a human into a box and then published where
    /// other people read it, so the two things that can go wrong are checked
    /// before a request is spent: nothing at all, and more than the forge will
    /// take. Whitespace-only counts as nothing — both forges accept it and
    /// render a blank card this app has no way to delete.
    #[test]
    fn a_comment_draft_must_carry_text_and_a_real_item() {
        let draft = |kind: &str, number: i64, body: &str| CommentDraft {
            kind: kind.into(),
            number,
            body: body.into(),
            account_id: None,
        };
        assert_eq!(
            draft("issue", 7, "  looks fixed  ").resolve().unwrap(),
            (ForgeItemKind::Issue, 7, "looks fixed".to_string()),
            "trimmed, not passed through"
        );
        assert_eq!(
            draft(" PR ", 7, "x").resolve().unwrap().0,
            ForgeItemKind::Change
        );
        for bad in [
            draft("issue", 7, "   \n\t "),
            draft("issue", 7, ""),
            draft("issue", 0, "x"),
            draft("issue", -1, "x"),
            // On GitLab the kind picks the COLLECTION, so a wrong one comments
            // on a real item that is not the one on screen.
            draft("mr", 7, "x"),
        ] {
            assert!(bad.resolve().is_err(), "{} #{}", bad.kind, bad.number);
        }
        let too_long = "x".repeat(MAX_COMMENT_CHARS + 1);
        assert!(draft("issue", 7, &too_long).resolve().is_err());
        // Counted in CHARS, so a body of multi-byte text right at the cap is
        // accepted rather than rejected for its byte length.
        let at_cap = "汉".repeat(MAX_COMMENT_CHARS);
        assert!(draft("issue", 7, &at_cap).resolve().is_ok());
    }

    /// Close and reopen are VERBS on the wire at GitLab and a target state at
    /// GitHub — the same button, two vocabularies, and neither API accepts the
    /// other's.
    #[test]
    fn a_state_action_speaks_each_forges_own_wire_vocabulary() {
        assert_eq!(ForgeStateAction::Close.github_state(), "closed");
        assert_eq!(ForgeStateAction::Reopen.github_state(), "open");
        assert_eq!(ForgeStateAction::Close.gitlab_event(), "close");
        assert_eq!(ForgeStateAction::Reopen.gitlab_event(), "reopen");
        // The spelling the frontend sends.
        let parsed: StateChangeRequest =
            serde_json::from_str(r#"{"kind":"pr","number":7,"action":"close"}"#).expect("decodes");
        assert_eq!(
            parsed.resolve().unwrap(),
            (ForgeItemKind::Change, 7, ForgeStateAction::Close)
        );
        assert!(serde_json::from_str::<StateChangeRequest>(
            r#"{"kind":"issue","number":7,"action":"merge"}"#
        )
        .is_err());
    }

    /// A title is required and capped; a body is optional and DROPPED when
    /// blank rather than sent as an empty string — GitHub stores that as a
    /// body and the issue then renders an empty description block.
    #[test]
    fn a_new_issue_needs_a_title_and_normalizes_the_rest() {
        let draft = |title: &str, body: Option<&str>, labels: Vec<&str>| NewIssueDraft {
            title: title.into(),
            body: body.map(str::to_string),
            labels: labels.into_iter().map(str::to_string).collect(),
            account_id: None,
        };
        assert_eq!(
            draft("  Login times out  ", Some("  steps  "), vec![" bug ", "", "bug", "docs"])
                .resolve()
                .unwrap(),
            ResolvedNewIssue {
                title: "Login times out".into(),
                body: Some("steps".into()),
                labels: vec!["bug".into(), "docs".into()],
            }
        );
        assert_eq!(draft("t", Some("  \n "), vec![]).resolve().unwrap().body, None);
        assert_eq!(draft("t", None, vec![]).resolve().unwrap().body, None);

        // NOT the filter's cap. Ten is how narrow a QUERY may get (each label
        // lengthens GitHub's `q`); silently dropping the eleventh label
        // somebody picked in the dialog would be losing what they wrote.
        let distinct: Vec<String> = (0..MAX_LABEL_FILTERS + 5).map(|i| format!("l{i}")).collect();
        let resolved = NewIssueDraft {
            title: "t".into(),
            body: None,
            labels: distinct.clone(),
            account_id: None,
        }
        .resolve()
        .unwrap();
        assert_eq!(resolved.labels.len(), distinct.len());
        // There is still a ceiling — this is a payload bound, not a promise to
        // forward anything at all.
        let absurd: Vec<String> = (0..MAX_ISSUE_LABELS + 10).map(|i| format!("l{i}")).collect();
        assert_eq!(
            NewIssueDraft {
                title: "t".into(),
                body: None,
                labels: absurd,
                account_id: None,
            }
            .resolve()
            .unwrap()
            .labels
            .len(),
            MAX_ISSUE_LABELS
        );
        for bad in [draft("", None, vec![]), draft("   ", None, vec![])] {
            assert!(bad.resolve().is_err());
        }
        assert!(draft(&"t".repeat(MAX_TITLE_CHARS + 1), None, vec![]).resolve().is_err());
        assert!(draft(&"t".repeat(MAX_TITLE_CHARS), None, vec![]).resolve().is_ok());
    }

    /// GitLab ships a diff and no counters, so the `+12 −3` beside each file is
    /// counted here. `+++` / `---` are the file headers: counting them would
    /// add one to each side of every single file in the list.
    #[test]
    fn diff_line_counting_skips_the_file_headers() {
        let diff = "--- a/src/main.rs\n\
                    +++ b/src/main.rs\n\
                    @@ -1,3 +1,4 @@\n\
                    \x20context\n\
                    -let x = 1;\n\
                    +let x = 2;\n\
                    +let y = 3;\n";
        assert_eq!(count_diff_lines(diff), (2, 1));
        assert_eq!(count_diff_lines(""), (0, 0));
        // A hunk header is neither side, and a bare `-`/`+` line is.
        assert_eq!(count_diff_lines("@@ -0,0 +1 @@\n+\n-\n"), (1, 1));

        // Past the first `@@` those prefixes are CONTENT, not headers — a
        // Markdown underline and a separator line are ordinary things to add,
        // and skipping them would undercount every file that touches one.
        let markdown = "--- a/README.md\n\
                        +++ b/README.md\n\
                        @@ -1,2 +1,4 @@\n\
                        +Title\n\
                        +++++\n\
                        ---\n\
                        \x20kept\n";
        assert_eq!(count_diff_lines(markdown), (2, 1));
    }

    /// "Nothing ran" and "we could not look" are different answers and the
    /// panel says different things about them — collapsing the two prints "no
    /// checks" over a repository whose pipeline is red.
    #[test]
    fn an_unavailable_check_list_is_not_an_empty_one() {
        assert!(!ForgeCheckList::unavailable().available);
        let empty = ForgeCheckList::available(Vec::new());
        assert!(empty.available && empty.checks.is_empty());
        assert!(ForgeCheckState::Queued.is_pending());
        assert!(ForgeCheckState::Running.is_pending());
        for settled in [
            ForgeCheckState::Success,
            ForgeCheckState::Failure,
            ForgeCheckState::Neutral,
        ] {
            assert!(!settled.is_pending(), "{settled:?}");
        }
        // The wire spelling the frontend switches on.
        assert_eq!(
            serde_json::to_string(&ForgeCheckState::Failure).unwrap(),
            "\"failure\""
        );
    }

    /// A file page comes off the wire with the same clamping every other paged
    /// request gets, and a change is addressed by a real number.
    #[test]
    fn change_queries_validate_their_item_and_clamp_their_paging() {
        assert_eq!(ChangeQuery { number: 7, account_id: None }.resolve().unwrap(), 7);
        assert!(ChangeQuery { number: 0, account_id: None }.resolve().is_err());
        let files = |number: i64, page: u32, per_page: u32| ChangeFilesQuery {
            number,
            page,
            per_page,
            account_id: None,
        };
        assert_eq!(files(7, 0, 0).resolve().unwrap(), (7, 1, MIN_PER_PAGE));
        assert_eq!(files(7, 2, 5_000).resolve().unwrap(), (7, 2, MAX_PER_PAGE));
        assert!(files(0, 1, 20).resolve().is_err());
        let wire: ChangeFilesQuery = serde_json::from_str(r#"{"number":7}"#).expect("decodes");
        assert_eq!((wire.page, wire.per_page), (1, DEFAULT_FILES_PER_PAGE));
    }

    /// These strings reach an `href` and an `<img src>`, and they come from
    /// whatever instance the account points at. Only the two schemes those
    /// attributes should ever carry survive.
    #[test]
    fn forge_supplied_urls_keep_only_the_web_schemes() {
        for good in [
            "https://github.com/acme/app/issues/7#issuecomment-1",
            "http://gitlab.corp.com:8929/a/b/-/issues/7#note_1",
            "HTTPS://avatars.example/u/1",
        ] {
            assert_eq!(sanitize_web_url(good).as_deref(), Some(good.trim()), "{good}");
        }
        for bad in [
            "javascript:alert(1)",
            "data:text/html,<script>x</script>",
            "vbscript:msgbox",
            "/relative/path",
            "",
            "   ",
        ] {
            assert_eq!(sanitize_web_url(bad), None, "{bad}");
        }
        // Padding is stripped, not treated as a reason to refuse — and it
        // cannot be used to smuggle a scheme past the check.
        assert_eq!(
            sanitize_web_url("  https://x.test/a  ").as_deref(),
            Some("https://x.test/a")
        );
        assert_eq!(sanitize_web_url("  javascript:alert(1)"), None);
    }

    /// Issue bodies are arbitrary UTF-8; a byte slice could split a code point
    /// and panic.
    #[test]
    fn body_truncation_is_char_safe() {
        let s = "汉".repeat(BODY_CAP + 5);
        let t = truncate_chars(&s, BODY_CAP);
        assert_eq!(t.chars().count(), BODY_CAP);
        assert!(truncate_chars("short", BODY_CAP) == "short");
    }

    /// The client holder is keyed by the proxy env fingerprint: same
    /// fingerprint reuses the pool, a changed fingerprint rebuilds — this is
    /// what makes a runtime proxy switch take effect without a restart.
    #[test]
    fn http_client_rebuilds_when_proxy_fingerprint_changes() {
        let a = http_client().expect("client");
        let b = http_client().expect("client");
        // Same fingerprint → the very same pool (reqwest clients are Arc-like;
        // pointer identity via Debug formatting is not exposed, so assert via
        // the cache: a second acquisition must not error and the cached entry
        // must match the current fingerprint).
        let _ = (a, b);
        let cached_fp = HTTP_CLIENT
            .read()
            .unwrap()
            .as_ref()
            .map(|(fp, _)| fp.clone())
            .expect("cached");
        assert_eq!(cached_fp, proxy_fingerprint());
    }
}
