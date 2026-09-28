//! Account/token resolution for forge calls.
//!
//! Reads the same `github_accounts` app-metadata blob the settings UI writes
//! (`commands/version_control.rs`) — that reader is desktop-gated, this one is
//! mode-agnostic because the forge paths run in both binaries. Tokens come
//! from `keyring_store` (OS keyring on desktop, hardened `tokens.json` on the
//! server). Every downstream call derives its identity scope from the
//! resolved `(server_host, api_base, account_id)` triple — never from "the
//! current default account" at call time, so a later `is_default` flip cannot
//! silently change which identity a task writes with.

use std::collections::HashMap;
use std::sync::{LazyLock, RwLock};

use sea_orm::DatabaseConnection;

use super::{ForgeError, ForgeProvider};
use crate::db::service::app_metadata_service;
use crate::models::{GitHubAccount, GitHubAccountsSettings};

/// Same key as `commands/version_control.rs` — duplicated because that module
/// gates the constant behind the desktop feature. GitLab accounts live in the
/// SAME store: an account has always been "a credential for this host", and a
/// host is one forge or the other, so splitting the store would only create
/// two places to look for the same answer.
const GITHUB_ACCOUNTS_KEY: &str = "github_accounts";

pub struct ResolvedAuth {
    /// Which forge this identity talks to — picks the REST dialect, the auth
    /// header and the endpoint shapes downstream.
    pub provider: ForgeProvider,
    /// Server host (`github.com`, `ghe.corp.com`) — the coordinate system
    /// source keys and git remotes share.
    pub server_host: String,
    /// Derived REST base: `https://api.github.com`, `{server_url}/api/v3`
    /// (GitHub Enterprise) or `{server_url}/api/v4` (GitLab).
    pub api_base: String,
    pub account_id: String,
    /// Login of the pinned account — the username half of the git credential
    /// when this identity pushes. Resolving it here (rather than letting git
    /// pick an account by host) is what makes "the branch is pushed by the
    /// account that triggered the task" true.
    pub username: String,
    /// The account's picture, as the forge reported it when the token was
    /// validated. Display only, and never a reason to fail: an account stored
    /// before avatars were recorded simply has none.
    pub avatar_url: Option<String>,
    pub token: String,
    /// Token scopes as recorded when the account was added, for display only.
    /// Deliberately NOT used as a gate: GitHub's fine-grained tokens report no
    /// scopes at all, so refusing on an empty list would lock out perfectly
    /// good credentials. A token that cannot do the job says so at the API,
    /// and the delivery path turns that into a readable failure.
    pub scopes: Vec<String>,
}

// Hand-written so a stray `{auth:?}` in a log line can never print the token.
impl std::fmt::Debug for ResolvedAuth {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ResolvedAuth")
            .field("provider", &self.provider)
            .field("server_host", &self.server_host)
            .field("api_base", &self.api_base)
            .field("account_id", &self.account_id)
            .field("username", &self.username)
            .field("token", &"<redacted>")
            .finish()
    }
}

/// Resolve the account (and token) to use against `server_host`.
///
/// `account_id: Some` must exist AND live on that host — a mismatched id is an
/// error, not a fallback, because silently substituting another identity is
/// exactly the drift the plan forbids. `None` prefers the host's `is_default`
/// account, then the first host match.
///
/// Accounts are additionally filtered by forge: one that DECLARES a provider
/// only serves that provider, while an undeclared one (everything stored
/// before GitLab support) serves whatever its host turns out to be. Handing a
/// GitLab token to the GitHub client would spend a real credential on a 401
/// and read as "your token expired".
pub async fn resolve_forge_auth(
    conn: &DatabaseConnection,
    provider: ForgeProvider,
    server_host: &str,
    account_id: Option<&str>,
) -> Result<ResolvedAuth, ForgeError> {
    let host = server_host.trim().to_ascii_lowercase();
    if host.is_empty() {
        return Err(ForgeError::Invalid("server host is empty".into()));
    }
    let settings = load_accounts(conn).await?;
    let on_host: Vec<&GitHubAccount> = settings
        .accounts
        .iter()
        .filter(|a| host_of_server_url(&a.server_url) == host && serves(a, provider))
        .collect();

    let account = match account_id {
        Some(id) => on_host
            .iter()
            .find(|a| a.id == id)
            .copied()
            .ok_or_else(|| {
                ForgeError::Auth(format!("account {id} not found on host {host}"))
            })?,
        // Nothing configured for this host is the ONE auth miss the user can
        // act on, so it gets its own variant (and with it an i18n key + an
        // "add an account" affordance in the workbench).
        None => on_host
            .iter()
            .find(|a| a.is_default)
            .or_else(|| on_host.first())
            .copied()
            .ok_or_else(|| {
                // …unless there is no reason to believe this host is a forge we
                // speak at all: nothing configured for it, nothing detected on
                // it, AND a name that does not claim to be GitHub or GitLab.
                // Telling a Bitbucket or Gitee user their "GitHub account" is
                // missing sends them to add a credential that would not help.
                // Note the test is for accounts on the HOST, not for the ones
                // that serve `provider` — the same deliberate optimism as
                // `HostProfile::recognized`, and for the same reason: a
                // configured host keeps the behaviour it has, whichever forge a
                // caller thinks it is.
                let configured = settings
                    .accounts
                    .iter()
                    .any(|a| host_of_server_url(&a.server_url) == host);
                // The probe's verdict vouches for a host exactly as an account
                // or a forge-claiming name does, and it has to be consulted
                // HERE or the two halves of this file contradict each other:
                // `host_profile` marks a detected GitLab `recognized`, which is
                // what lets the panel spend a request on it, and this function
                // would then answer that request with "not a forge we speak" —
                // about an instance codeg positively identified. What such a
                // user is missing is an ACCOUNT, and that is what to say.
                //
                // Only a POSITIVE verdict counts. `Some(None)` is "asked, and
                // it is not a GitLab", which is the Bitbucket/Gitee case the
                // name rule already owns and must keep owning.
                let detected = recall_verdict(&host).flatten().is_some();
                if !configured && !detected && provider_from_host_name(&host).is_none() {
                    ForgeError::UnsupportedHost { host: host.clone() }
                } else {
                    ForgeError::NoAccount {
                        provider,
                        host: host.clone(),
                    }
                }
            })?,
    };

    let token = crate::keyring_store::get_token(&account.id)
        .ok_or_else(|| ForgeError::Auth(format!("no stored token for account {}", account.id)))?;

    Ok(ResolvedAuth {
        api_base: api_base_for(provider, &host, &account.server_url),
        provider,
        server_host: host,
        account_id: account.id.clone(),
        username: account.username.clone(),
        avatar_url: account.avatar_url.clone(),
        token,
        scopes: account.scopes.clone(),
    })
}

/// Whether a stored account may be used against `provider`. An account with no
/// declared provider matches anything (legacy rows, and the "generic git
/// account" the settings page has always allowed).
fn serves(account: &GitHubAccount, provider: ForgeProvider) -> bool {
    match account.provider.as_deref().map(str::trim) {
        None | Some("") => true,
        Some(declared) => declared.eq_ignore_ascii_case(provider.as_str()),
    }
}

/// What codeg knows about a host, from the accounts configured for it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostProfile {
    pub provider: ForgeProvider,
    /// The path the instance is mounted under, without surrounding slashes —
    /// empty for the usual root install. GitLab supports a "relative URL
    /// root" (`https://host/gitlab`), and where one is in use EVERY repository
    /// path in a git remote carries that prefix while no API path does.
    pub base_path: String,
    /// Whether `provider` is something codeg actually KNOWS about this host —
    /// an account configured for it, or a hostname that names one of the
    /// supported forges — as opposed to the last-resort GitHub guess.
    ///
    /// Load-bearing for what a user is TOLD, not for what is called: a repo on
    /// Bitbucket or Gitee resolves to a perfectly well-formed
    /// `(github, host, owner/repo)` triple that no GitHub API can answer, and
    /// the panel used to report that as an account or API failure. Whoever is
    /// about to spend a request on a host checks this first and says "only
    /// GitHub, GitLab and Gitea are supported" instead.
    ///
    /// Deliberately OPTIMISTIC about a configured host, and the reason is that
    /// a provider-less account is ambiguous by construction. Two flows write
    /// one: the forge dialog, which validates a token against a real API and
    /// records which forge it was — and `AddGitAccountDialog`, a plain
    /// user/password git credential for pushing over HTTPS to ANY host, which
    /// validates nothing and declares nothing. A record from the second is
    /// byte-identical to a legacy pre-GitLab account from the first, so there
    /// is no field that separates "my Gitee push credential" from "my GitHub
    /// Enterprise account, stored before we asked which forge it was".
    /// Refusing both would take a working panel away from the second group to
    /// give the first a better message, so the tie goes to the incumbent: a
    /// configured host is still attempted, and a plain-git credential for a
    /// non-forge host still ends in that host's API failure rather than in
    /// this explanation. Declaring the account's forge is what resolves it.
    pub recognized: bool,
}

/// Which forge lives at `host`, and where it is mounted — decided server-side.
///
/// The user's own accounts come first: adding a GitLab credential for
/// `git.corp.com` IS the statement that `git.corp.com` is a GitLab, and typing
/// `https://host/gitlab` as its server URL is the statement about where.
///
/// When nothing is declared the instance itself is asked ([`detect_forge`]),
/// because the hostname is a poor witness: a self-hosted GitLab is at least as
/// likely to be called `git.corp.com` or a bare IP as `gitlab.corp.com`, and
/// guessing GitHub there sends every call to `/api/v3`, which GitLab answers
/// with a 410 that means nothing to the person reading it. The hostname keeps
/// its vote as the last resort, so a host that cannot be reached behaves
/// exactly as it did before.
pub async fn host_profile(conn: &DatabaseConnection, server_host: &str) -> HostProfile {
    let accounts = load_accounts(conn).await.unwrap_or_default().accounts;
    let host = server_host.trim().to_ascii_lowercase();

    // Everything knowable without the network — the mount path, the provider
    // and the `recognized` rule. Deriving it HERE rather than restating it is
    // what keeps the two halves from drifting: the probe below can only
    // replace the provider, and only when it has a conclusive answer.
    let profile = host_profile_in(&host, &accounts);

    let authority = authority_in(&host, &accounts);
    // A declaration is the end of the question — never probe over it.
    if declared_provider(authority).is_some() {
        return profile;
    }

    // Nothing declared. Rather than guess from the hostname and be wrong for
    // every self-hosted GitLab that is not literally named `gitlab.*`, ASK the
    // instance what it is. Only a conclusive answer is taken; anything else
    // falls through to the same guess this has always made, so a host that is
    // slow, offline or behind a proxy is no worse off than before.
    let origin = server_origin(&host, authority.map_or("", |a| a.server_url.as_str()));
    match detect_forge(&host, &origin).await {
        // The instance ANSWERED, and that is the strongest witness there is:
        // stronger than an account (which vouches for a host without saying
        // what it runs) and stronger than the name (which is why this probe
        // exists). It is also the only witness a host with neither can
        // produce, so without `recognized` a `git.corp.com` the probe just
        // proved is a GitLab would still be shown as "only GitHub and GitLab
        // are supported" — the two halves contradicting each other.
        Some(detected) => HostProfile {
            provider: detected,
            recognized: true,
            ..profile
        },
        None => profile,
    }
}

/// Pure half of [`host_profile`] — the answer WITHOUT the network probe, which
/// is what every caller that only has a stored account list can know. The
/// async half agrees with this whenever a provider is declared, and improves on
/// it (never contradicts a declaration) when one is not.
pub fn host_profile_in(server_host: &str, accounts: &[GitHubAccount]) -> HostProfile {
    let host = server_host.trim().to_ascii_lowercase();
    let authority = authority_in(&host, accounts);

    // Self-hosted with nothing declared: the name is all there is, and
    // anything it does not name stays GitHub — what this codebase did before
    // GitLab existed.
    let provider = declared_provider(authority).unwrap_or_else(|| guess_provider(&host));

    // An account on the host counts even when it declares no provider: adding
    // a credential for a host means its token was validated against one of the
    // two APIs, which is a stronger statement about the host than its name is.
    // Note this asks whether the name says ANYTHING, which is not the same
    // question `provider` asked — `guess_provider` answers GitHub either way.
    let recognized = authority.is_some() || provider_from_host_name(&host).is_some();

    // An EMPTY path from the authoritative account is an answer, not a miss:
    // it says this instance is mounted at the root.
    let base_path = authority
        .map(|a| path_of_server_url(&a.server_url))
        .unwrap_or_default();

    HostProfile {
        provider,
        base_path,
        recognized,
    }
}

/// Which forge a HOSTNAME names, when nobody has said. `None` means the name
/// carries no claim either way — which, for a host with no account behind it,
/// is as close as codeg gets to "this is not a forge we speak".
///
/// A whole label, never a substring: `mygitlabhost.com` is somebody's domain,
/// and matching it would send their repository to a GitLab that is not there.
///
/// `forgejo` names a Gitea: it is a fork of it and serves the same `/api/v1`,
/// so the client that talks to one talks to the other.
pub fn provider_from_host_name(server_host: &str) -> Option<ForgeProvider> {
    let host = server_host.trim().to_ascii_lowercase();
    if host.is_empty() {
        return None;
    }
    let names = |wanted: &str| host.split('.').any(|label| label == wanted);
    if names("gitlab") {
        return Some(ForgeProvider::GitLab);
    }
    if names("github") {
        return Some(ForgeProvider::GitHub);
    }
    if names("gitea") || names("forgejo") {
        return Some(ForgeProvider::Gitea);
    }
    None
}

/// ONE account speaks for the host, and BOTH answers come from it. Taking them
/// from different accounts is how a stray secondary credential at
/// `https://host/gitlab` could strip a root install's `gitlab/team/app` down to
/// `team/app` and send every call to a repository that is not the one on
/// screen. Preference: the first account that declares a provider (that
/// declaration is the most deliberate thing a user can say about a host), else
/// the default one, else the first.
fn authority_in<'a>(host: &str, accounts: &'a [GitHubAccount]) -> Option<&'a GitHubAccount> {
    // A default account speaks for its host before a non-default one does.
    let on_host: Vec<&GitHubAccount> = {
        let (default, rest): (Vec<_>, Vec<_>) = accounts
            .iter()
            .filter(|a| host_of_server_url(&a.server_url) == host)
            .partition(|a| a.is_default);
        default.into_iter().chain(rest).collect()
    };
    on_host
        .iter()
        .find(|a| {
            a.provider
                .as_deref()
                .is_some_and(|p| ForgeProvider::parse(p).is_ok())
        })
        .or_else(|| on_host.first())
        .copied()
}

/// What the authoritative account SAYS this host is, if it says anything.
fn declared_provider(authority: Option<&GitHubAccount>) -> Option<ForgeProvider> {
    authority
        .and_then(|a| a.provider.as_deref())
        .and_then(|p| ForgeProvider::parse(p).ok())
}

/// Last resort when nothing is declared and the instance did not answer: the
/// name is all there is, and anything it does not name stays GitHub — what
/// this codebase did before GitLab existed.
///
/// The TOTAL half of [`provider_from_host_name`], and deliberately not a second
/// copy of the rule: the difference between them is only what "the name says
/// nothing" turns into. Here it is the GitHub incumbent, because a caller
/// picking a client needs an answer; there it stays `None`, because a caller
/// deciding what to TELL the user needs to know the answer was a guess.
fn guess_provider(host: &str) -> ForgeProvider {
    provider_from_host_name(host).unwrap_or(ForgeProvider::GitHub)
}

/// Hosts whose forge has been established by evidence rather than by spelling —
/// either the probe below got a conclusive answer, or the instance announced
/// itself in an error (see `github::finish`, where GitLab's "API V3 is no
/// longer supported" is exactly such an announcement).
///
/// Process-lifetime only, and deliberately so: it is a cache of something
/// re-derivable, not a setting. Nothing the user can see gets written, so a
/// wrong entry cannot outlive a restart.
/// An entry means the host ANSWERED; `None` inside it means the answer was
/// "neither a Gitea nor a GitLab" — a verdict worth keeping, because without it
/// every request to a GitHub Enterprise would re-probe
/// (`folder_forge_remote_core`, and so this function, runs on every forge
/// call).
static DETECTED_FORGE: LazyLock<RwLock<HashMap<String, Option<ForgeProvider>>>> =
    LazyLock::new(|| RwLock::new(HashMap::new()));

/// Record what a host turned out to be. Called from the probe and from the
/// error path that recognises a GitLab answering a GitHub Enterprise request.
pub(crate) fn remember_forge(host: &str, provider: ForgeProvider) {
    record_verdict(host, Some(provider));
}

fn record_verdict(host: &str, verdict: Option<ForgeProvider>) {
    let host = host.trim().to_ascii_lowercase();
    if host.is_empty() {
        return;
    }
    if let Ok(mut guard) = DETECTED_FORGE.write() {
        guard.insert(host, verdict);
    }
}

/// The positive answer only — "we know this host is X". Production code reads
/// [`recall_verdict`] instead, because it has to tell "not a GitLab" apart from
/// "no answer yet"; this is the shape the tests assert against.
#[cfg(test)]
pub(crate) fn recall_forge(host: &str) -> Option<ForgeProvider> {
    DETECTED_FORGE.read().ok()?.get(host).copied().flatten()
}

/// Whether the host has answered at all, and what it said. `Some(None)` is
/// "asked and answered: neither forge the probe can recognise"; `None` is
/// "never got a usable answer".
fn recall_verdict(host: &str) -> Option<Option<ForgeProvider>> {
    DETECTED_FORGE.read().ok()?.get(host).copied()
}

#[cfg(test)]
pub(crate) fn forget_forge(host: &str) {
    if let Ok(mut guard) = DETECTED_FORGE.write() {
        guard.remove(&host.trim().to_ascii_lowercase());
    }
}

/// A path no forge routes. Asking for it is how "this host serves the GitLab
/// API" is told apart from "this host answers everything the same way".
const NONEXISTENT_PATH: &str = "__codeg_forge_probe";

/// What one probe request came back as. Only the facts a verdict needs: the
/// status, whether the answer claimed to be JSON, and the first few bytes of it
/// — enough for the one probe below whose verdict rests on the BODY rather than
/// on the status alone.
struct Answer {
    status: u16,
    json: bool,
    body: String,
}

/// How much of a probe's answer is read. A version payload is forty bytes; this
/// is the ceiling on what an unidentified host — which is exactly what this
/// runs against — gets to put in memory before being ruled out. Anything longer
/// is TRUNCATED rather than refused, and truncated JSON does not parse, which
/// is the same verdict a page of HTML gets.
const PROBE_BODY_CAP: usize = 4096;

/// Statuses that mean "ask again later", not "this is not a GitLab". A GitLab
/// mid-deploy is a 502 from its own reverse proxy; recording that as a verdict
/// would pin the host to the hostname guess until codeg restarts, which is the
/// very failure this path exists to remove.
fn is_transient(status: u16) -> bool {
    status >= 500 || status == 408 || status == 429
}

async fn ask(client: &reqwest::Client, url: String) -> Option<Answer> {
    let mut response = client
        .get(url)
        .header("User-Agent", "codeg")
        .header("Accept", "application/json")
        // Short on purpose: this runs before the panel can draw, and a slow
        // answer is worth less than falling back to the guess immediately.
        .timeout(std::time::Duration::from_secs(5))
        .send()
        .await
        .ok()?;
    let json = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.to_ascii_lowercase().contains("json"));
    let status = response.status().as_u16();

    // Streamed to a cap rather than `text()`d whole. This asks an
    // UNIDENTIFIED host a question, and a host that answers every path with a
    // megabyte of HTML is one of the shapes it is meant to rule out — reading
    // that in full to look at its first forty bytes would let the thing being
    // ruled out decide how much memory the ruling costs.
    let mut body = Vec::new();
    while body.len() < PROBE_BODY_CAP {
        match response.chunk().await {
            Ok(Some(chunk)) => body.extend_from_slice(&chunk),
            _ => break,
        }
    }
    body.truncate(PROBE_BODY_CAP);
    Some(Answer {
        status,
        json,
        body: String::from_utf8_lossy(&body).into_owned(),
    })
}

/// Ask `origin` which forge it is, once per host per process.
///
/// Two questions, cheapest first.
///
/// **Gitea/Forgejo: `GET {origin}/api/v1/version`.** Deliberately the first
/// one, because it is the only probe here that needs no credential and whose
/// verdict rests on the BODY: the endpoint is public on every Gitea, and it
/// answers `{"version":"1.23.4"}`. A blanket gateway or a catch-all 200 does
/// not produce that key, so no control request is needed to rule one out.
/// Neither GitHub Enterprise (`/api/v3`) nor GitLab (`/api/v4`) mounts
/// `/api/v1` at all.
///
/// **GitLab: `GET {origin}/api/v4/version`.** GitLab mounts it and answers 200
/// with a token or 401 without — either way it EXISTS; GitHub Enterprise
/// answers 404.
///
/// A JSON 401 alone is NOT enough there. An authenticating gateway in front of
/// a GitHub Enterprise can answer exactly that to every request, and believing
/// it would break a setup that works today. So a 401 is confirmed against a
/// path nothing routes: GitLab answers `{"error":"404 Not Found"}` there, while
/// a blanket gateway answers 401 again and the probe declines to conclude.
///
/// Two failures are deliberately NOT recorded, so they are re-asked rather than
/// remembered: an unreachable host, and a transient server status
/// ([`is_transient`]). Everything else IS recorded — including "answered, and
/// it is neither" — because `folder_forge_remote_core` runs on every forge
/// call, and an uncached negative would put two probes in front of each one.
async fn detect_forge(host: &str, origin: &str) -> Option<ForgeProvider> {
    if let Some(verdict) = recall_verdict(host) {
        return verdict;
    }
    // The public hosts are not worth a round trip; their names ARE the answer.
    if host == "github.com" || host == "gitlab.com" {
        return None;
    }
    let client = super::http_client().ok()?;

    let gitea = ask(&client, format!("{origin}/api/v1/version")).await?;
    // A transient answer to this one does NOT end the question. Asking Gitea
    // first is new, and returning here on a 5xx would mean a GitLab behind a
    // proxy that errors on unknown `/api/v1` paths never gets asked the
    // question it used to be asked first — a host that detected fine before
    // this probe existed, silently falling back to the hostname guess.
    let gitea_answered = !is_transient(gitea.status);
    if gitea_answered && gitea.status == 200 && gitea.json && announces_version(&gitea.body) {
        record_verdict(host, Some(ForgeProvider::Gitea));
        return Some(ForgeProvider::Gitea);
    }

    let probe = ask(&client, format!("{origin}/api/v4/version")).await?;
    if is_transient(probe.status) {
        return None;
    }
    let looks_like_gitlab = matches!(probe.status, 200 | 401) && probe.json;

    let verdict = if looks_like_gitlab {
        let control = ask(&client, format!("{origin}/api/v4/{NONEXISTENT_PATH}")).await?;
        if is_transient(control.status) {
            return None;
        }
        // Routed endpoints exist and unrouted ones do not — the shape of a
        // real API, and what a catch-all cannot reproduce.
        (control.status == 404).then_some(ForgeProvider::GitLab)
    } else {
        None
    };

    // A NEGATIVE verdict is only worth remembering when both questions were
    // actually answered: "it is not a GitLab, and we never heard back about
    // Gitea" is not the "asked and answered: neither" this cache records, and
    // pinning it would keep a Gitea that was merely restarting unrecognised
    // until codeg does.
    if verdict.is_none() && !gitea_answered {
        return None;
    }
    record_verdict(host, verdict);
    verdict
}

/// Whether a probe body is Gitea's version payload — a JSON object with a
/// non-empty `version` string, and nothing else asked of it.
///
/// Parsed rather than substring-matched: `"version"` appears in plenty of JSON
/// a proxy or an unrelated service might answer with, and the whole point of
/// reading the body here is that it is a stronger witness than the status was.
fn announces_version(body: &str) -> bool {
    serde_json::from_str::<serde_json::Value>(body)
        .ok()
        .as_ref()
        .and_then(|v| v.get("version"))
        .and_then(|v| v.as_str())
        .is_some_and(|v| !v.trim().is_empty())
}

/// The path component of a stored `server_url`, without surrounding slashes.
fn path_of_server_url(server_url: &str) -> String {
    let trimmed = server_url.trim();
    let no_scheme = trimmed
        .split_once("://")
        .map(|(_, rest)| rest)
        .unwrap_or(trimmed);
    let after_host = match no_scheme.split_once('/') {
        Some((_, rest)) => rest,
        None => return String::new(),
    };
    after_host
        .split(['?', '#'])
        .next()
        .unwrap_or("")
        .trim_matches('/')
        .to_ascii_lowercase()
}

/// Drop the instance's mount path from a repository path parsed out of a git
/// remote. A no-op for the usual root install, and for anything that does not
/// actually start with that prefix — a wrong guess here would rename the
/// repository, so it only ever removes a prefix it can see.
pub fn strip_base_path(owner_repo: &str, base_path: &str) -> String {
    if base_path.is_empty() {
        return owner_repo.to_string();
    }
    let lowered = owner_repo.to_ascii_lowercase();
    let prefix = format!("{base_path}/");
    let Some(rest) = lowered.strip_prefix(&prefix) else {
        return owner_repo.to_string();
    };
    // What is left still has to look like a repository path; a project always
    // lives in a namespace, so a bare name means the prefix was not a mount
    // path at all and the original stands.
    if rest.contains('/') && !rest.starts_with('/') {
        rest.to_string()
    } else {
        owner_repo.to_string()
    }
}

async fn load_accounts(conn: &DatabaseConnection) -> Result<GitHubAccountsSettings, ForgeError> {
    let raw = app_metadata_service::get_value(conn, GITHUB_ACCOUNTS_KEY)
        .await
        .map_err(|e| ForgeError::Network(format!("failed to read accounts: {e}")))?;
    match raw {
        Some(raw) => serde_json::from_str::<GitHubAccountsSettings>(&raw)
            .map_err(|e| ForgeError::Auth(format!("stored accounts unreadable: {e}"))),
        None => Ok(GitHubAccountsSettings::default()),
    }
}

/// Host of a stored account `server_url`. Empty/blank means github.com — the
/// settings UI leaves the field empty for the public service.
pub fn host_of_server_url(server_url: &str) -> String {
    let trimmed = server_url.trim();
    if trimmed.is_empty() {
        return "github.com".to_string();
    }
    let no_scheme = trimmed
        .split_once("://")
        .map(|(_, rest)| rest)
        .unwrap_or(trimmed);
    let host_port = no_scheme.split(['/', '?', '#']).next().unwrap_or("");
    let host = host_port.split('@').next_back().unwrap_or("");
    host.split(':').next().unwrap_or("").trim().to_ascii_lowercase()
}

/// REST base for a host. github.com uses the dedicated API host; GitHub
/// Enterprise mounts its API under the instance (`{origin}/api/v3`, the exact
/// derivation `validate_github_token` already uses); GitLab — public and
/// self-hosted alike — always mounts `{origin}/api/v4`, and Gitea/Forgejo
/// `{origin}/api/v1`.
fn api_base_for(provider: ForgeProvider, host: &str, server_url: &str) -> String {
    if provider == ForgeProvider::GitHub && host == "github.com" {
        return "https://api.github.com".to_string();
    }
    let origin = server_origin(host, server_url);
    match provider {
        ForgeProvider::GitHub => format!("{origin}/api/v3"),
        ForgeProvider::GitLab => format!("{origin}/api/v4"),
        ForgeProvider::Gitea => format!("{origin}/api/v1"),
    }
}

/// `https://host[:port]` for a stored account. A stored `server_url` is
/// whatever the user typed, which is sometimes a bare hostname — pasting that
/// straight into a request URL would produce a relative path, so the scheme is
/// supplied when it is missing.
fn server_origin(host: &str, server_url: &str) -> String {
    let trimmed = server_url.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return format!("https://{host}");
    }
    if trimmed.contains("://") {
        return trimmed.to_string();
    }
    format!("https://{trimmed}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn host_extraction_covers_the_stored_shapes() {
        assert_eq!(host_of_server_url(""), "github.com");
        assert_eq!(host_of_server_url("   "), "github.com");
        assert_eq!(host_of_server_url("https://github.com"), "github.com");
        assert_eq!(host_of_server_url("https://GitHub.com/"), "github.com");
        assert_eq!(host_of_server_url("https://ghe.corp.com"), "ghe.corp.com");
        assert_eq!(host_of_server_url("http://ghe.corp.com:8443/x"), "ghe.corp.com");
        assert_eq!(host_of_server_url("ghe.corp.com"), "ghe.corp.com");
    }

    /// Build a stored account; every test that needs a variant tweaks the
    /// field it is about.
    fn account(id: &str, server_url: &str, provider: Option<&str>) -> GitHubAccount {
        GitHubAccount {
            id: id.into(),
            server_url: server_url.into(),
            username: "alice".into(),
            scopes: vec![],
            avatar_url: None,
            is_default: false,
            created_at: "2026-01-01".into(),
            provider: provider.map(str::to_string),
        }
    }

    #[test]
    fn api_base_matches_validate_github_token_derivation() {
        let gh = ForgeProvider::GitHub;
        assert_eq!(api_base_for(gh, "github.com", ""), "https://api.github.com");
        assert_eq!(
            api_base_for(gh, "github.com", "https://github.com"),
            "https://api.github.com"
        );
        assert_eq!(
            api_base_for(gh, "ghe.corp.com", "https://ghe.corp.com/"),
            "https://ghe.corp.com/api/v3"
        );
        assert_eq!(api_base_for(gh, "ghe.corp.com", ""), "https://ghe.corp.com/api/v3");
        // A bare hostname is what users actually type; without a scheme the
        // result would be a relative path rather than a request URL.
        assert_eq!(
            api_base_for(gh, "ghe.corp.com", "ghe.corp.com"),
            "https://ghe.corp.com/api/v3"
        );
    }

    /// GitLab mounts its API under the instance itself — public and
    /// self-hosted alike, there is no `api.gitlab.com`.
    #[test]
    fn gitlab_api_base_is_always_under_the_instance() {
        let gl = ForgeProvider::GitLab;
        assert_eq!(api_base_for(gl, "gitlab.com", ""), "https://gitlab.com/api/v4");
        assert_eq!(
            api_base_for(gl, "gitlab.com", "https://gitlab.com"),
            "https://gitlab.com/api/v4"
        );
        // The port has to survive: it is part of the origin the pushes use too.
        assert_eq!(
            api_base_for(gl, "gitlab.corp.com", "https://gitlab.corp.com:8443/"),
            "https://gitlab.corp.com:8443/api/v4"
        );
    }

    /// Gitea mounts at `/api/v1`, and — unlike GitHub — there is no public
    /// service with a dedicated API host to exempt. gitea.com and codeberg.org
    /// answer under their own origins like every self-hosted instance does.
    #[test]
    fn gitea_api_base_is_v1_under_the_instance() {
        let gt = ForgeProvider::Gitea;
        assert_eq!(api_base_for(gt, "gitea.com", ""), "https://gitea.com/api/v1");
        assert_eq!(
            api_base_for(gt, "codeberg.org", "https://codeberg.org/"),
            "https://codeberg.org/api/v1"
        );
        assert_eq!(
            api_base_for(gt, "git.corp.com", "http://git.corp.com:3000"),
            "http://git.corp.com:3000/api/v1"
        );
    }

    /// The user's own accounts decide what a host is; the hostname only gets a
    /// vote when nothing is declared, and GitHub stays the last resort so
    /// every existing install keeps behaving exactly as it did.
    #[test]
    fn a_hosts_forge_comes_from_its_accounts_first() {
        assert_eq!(host_profile_in("github.com", &[]).provider, ForgeProvider::GitHub);
        assert_eq!(host_profile_in("gitlab.com", &[]).provider, ForgeProvider::GitLab);
        assert_eq!(host_profile_in("gitlab.corp.com", &[]).provider, ForgeProvider::GitLab);
        // "gitlab" as a whole label only — `mygitlabhost.com` says nothing.
        assert_eq!(host_profile_in("mygitlabhost.com", &[]).provider, ForgeProvider::GitHub);
        assert_eq!(host_profile_in("ghe.corp.com", &[]).provider, ForgeProvider::GitHub);

        // A declared account overrides the hostname guess in both directions.
        let declared = [account("a", "https://git.corp.com", Some("gitlab"))];
        assert_eq!(host_profile_in("git.corp.com", &declared).provider, ForgeProvider::GitLab);
        let declared = [account("a", "https://gitlab.corp.com", Some("github"))];
        assert_eq!(
            host_profile_in("gitlab.corp.com", &declared).provider,
            ForgeProvider::GitHub
        );
        // Accounts on OTHER hosts have no say.
        let elsewhere = [account("a", "https://gitlab.com", Some("gitlab"))];
        assert_eq!(host_profile_in("ghe.corp.com", &elsewhere).provider, ForgeProvider::GitHub);
        // Undeclared accounts (everything stored before GitLab support) do not
        // vote either — they are credentials for a host, not a statement.
        let legacy = [account("a", "https://gitlab.corp.com", None)];
        assert_eq!(host_profile_in("gitlab.corp.com", &legacy).provider, ForgeProvider::GitLab);

        // Two declarations on one host: the default account speaks for it.
        let mut github_default = account("gh", "https://git.corp.com", Some("github"));
        github_default.is_default = true;
        let mixed = [account("gl", "https://git.corp.com", Some("gitlab")), github_default];
        assert_eq!(host_profile_in("git.corp.com", &mixed).provider, ForgeProvider::GitHub);
    }

    /// The GitHub fallback is a GUESS, and a host it was guessed for is not a
    /// host codeg can read. Saying which is which is the whole point of
    /// `recognized`: a Bitbucket or Gitee remote resolves to the same
    /// well-formed `(github, host, owner/repo)` triple a GitHub Enterprise
    /// does, and only this flag separates "your account is missing" from "that
    /// is not a forge we speak".
    #[test]
    fn a_guessed_host_is_marked_unrecognized() {
        // The two public services, and any instance whose NAME makes a claim.
        for host in ["github.com", "gitlab.com", "gitlab.corp.com", "github.corp.com"] {
            assert!(host_profile_in(host, &[]).recognized, "{host}");
        }
        // Nothing configured, and a name that says nothing.
        for host in ["bitbucket.org", "gitee.com", "codeberg.org", "ghe.corp.com"] {
            let profile = host_profile_in(host, &[]);
            assert!(!profile.recognized, "{host}");
            // Still GitHub — the fallback is unchanged, only labelled.
            assert_eq!(profile.provider, ForgeProvider::GitHub, "{host}");
        }

        // A configured host is attempted, declared provider or not. The
        // undeclared case is the deliberate optimism documented on
        // `HostProfile::recognized`: a legacy GitHub Enterprise account and a
        // plain-git push credential for a non-forge host are the same bytes,
        // and the group with a WORKING panel wins the tie.
        let declared = [account("a", "https://ghe.corp.com", Some("github"))];
        assert!(host_profile_in("ghe.corp.com", &declared).recognized);
        let legacy = [account("a", "https://ghe.corp.com", None)];
        assert!(host_profile_in("ghe.corp.com", &legacy).recognized);
        // …for THAT host. An account elsewhere vouches for nothing here.
        let elsewhere = [account("a", "https://github.com", Some("github"))];
        assert!(!host_profile_in("ghe.corp.com", &elsewhere).recognized);
    }

    /// The advice a failed auth resolution gives has to be advice that can
    /// work. "Add a GitHub account for gitee.com" is not — no such account
    /// would make the read succeed — so a host nothing vouches for is refused
    /// as unsupported instead, and only a host that IS one of the two gets the
    /// actionable "you have no account here".
    #[tokio::test]
    async fn an_unvouched_for_host_is_refused_as_unsupported_not_as_a_missing_account() {
        let db = crate::db::test_helpers::fresh_in_memory_db().await;
        let refuse = |host: &'static str| {
            let conn = db.conn.clone();
            async move {
                resolve_forge_auth(&conn, ForgeProvider::GitHub, host, None)
                    .await
                    .expect_err("nothing is configured, so nothing can resolve")
            }
        };

        assert!(
            matches!(refuse("gitee.com").await, ForgeError::UnsupportedHost { .. }),
            "a host that is neither forge"
        );
        assert!(
            matches!(refuse("github.com").await, ForgeError::NoAccount { .. }),
            "the public service is a forge with no credential yet"
        );
        assert!(
            matches!(refuse("gitlab.corp.com").await, ForgeError::NoAccount { .. }),
            "a name that claims a forge is a claim we take"
        );

        // A host the user has configured is a host they have vouched for,
        // whichever forge the CALLER happens to think it is — otherwise a task
        // whose provenance says "github" would report a GitLab install under an
        // unrelated name as unsupported.
        let stored = GitHubAccountsSettings {
            accounts: vec![account("a", "https://git.corp.com", Some("gitlab"))],
        };
        app_metadata_service::upsert_value(
            &db.conn,
            GITHUB_ACCOUNTS_KEY,
            &serde_json::to_string(&stored).expect("serialize accounts"),
        )
        .await
        .expect("seed accounts");
        assert!(
            matches!(refuse("git.corp.com").await, ForgeError::NoAccount { .. }),
            "configured for the host, just not for the forge asked about"
        );
    }

    /// Whole labels only, in both directions — the same rule the provider
    /// guess has always used. `mygitlabhost.com` is somebody's domain.
    #[test]
    fn a_hostname_claims_a_forge_only_by_whole_label() {
        assert_eq!(provider_from_host_name("gitlab.com"), Some(ForgeProvider::GitLab));
        assert_eq!(provider_from_host_name("GitHub.com"), Some(ForgeProvider::GitHub));
        assert_eq!(
            provider_from_host_name("git.gitlab.corp.com"),
            Some(ForgeProvider::GitLab)
        );
        assert_eq!(provider_from_host_name("mygitlabhost.com"), None);
        assert_eq!(provider_from_host_name("githubby.io"), None);
        assert_eq!(provider_from_host_name("bitbucket.org"), None);
        assert_eq!(provider_from_host_name(""), None);
        assert_eq!(provider_from_host_name("   "), None);
        // Forgejo is a Gitea fork serving the same `/api/v1`, so its name
        // claims the same client. `codeberg.org` deliberately does NOT — this
        // is a rule about what a name SAYS, not a list of instances we happen
        // to know about, and the probe identifies that one anyway.
        assert_eq!(provider_from_host_name("gitea.corp.com"), Some(ForgeProvider::Gitea));
        assert_eq!(provider_from_host_name("forgejo.example"), Some(ForgeProvider::Gitea));
        assert_eq!(provider_from_host_name("codeberg.org"), None);
        assert_eq!(provider_from_host_name("giteaish.dev"), None);
    }

    /// What the instance itself said vouches for it, exactly as an account or a
    /// forge-claiming name does. Without this the two halves of the forge work
    /// contradict each other on the SAME host: `host_profile` marks a detected
    /// GitLab `recognized` — which is what lets the panel spend a request on it
    /// — and this function then answers that request with "not a forge codeg
    /// speaks", about an instance the probe positively identified. What the
    /// user is actually missing is an account, and that is the actionable
    /// thing to say.
    ///
    /// Neither half had this alone: without the probe such a host was never
    /// `recognized`, so no request was spent and nothing contradicted anything.
    #[tokio::test]
    async fn a_detected_forge_is_vouched_for_even_when_nothing_else_speaks_for_the_host() {
        let db = crate::db::test_helpers::fresh_in_memory_db().await;
        // A real GitLab whose name claims nothing, with no account configured.
        let host = "vouched-by-probe.example";
        forget_forge(host);
        assert_eq!(provider_from_host_name(host), None, "the name says nothing");

        let refuse = || async {
            resolve_forge_auth(&db.conn, ForgeProvider::GitLab, host, None)
                .await
                .expect_err("nothing is configured, so nothing can resolve")
        };

        // Nothing vouches for it yet: the honest answer is "not a forge we speak".
        assert!(matches!(refuse().await, ForgeError::UnsupportedHost { .. }));

        // …until the instance answers for itself.
        remember_forge(host, ForgeProvider::GitLab);
        assert!(
            matches!(refuse().await, ForgeError::NoAccount { .. }),
            "a proven GitLab with no credential needs an account, not an explanation"
        );

        // A NEGATIVE verdict is not a vouching: "asked, and it is not a GitLab"
        // is the Bitbucket/Gitee case, which the name rule still owns.
        forget_forge(host);
        record_verdict(host, None);
        assert!(matches!(refuse().await, ForgeError::UnsupportedHost { .. }));

        forget_forge(host);
    }

    /// A GitLab mounted under a relative URL root (`https://host/gitlab`) puts
    /// that prefix in front of every repository path a git remote carries,
    /// while no API path has it. Without stripping, the project addressed over
    /// REST would be `gitlab%2Fgroup%2Fproj` — a project that does not exist —
    /// and the push URL would repeat the prefix twice.
    #[test]
    fn an_instance_mount_path_is_learned_from_its_account_and_stripped() {
        let mounted = [account("a", "https://host.example/gitlab", Some("gitlab"))];
        let profile = host_profile_in("host.example", &mounted);
        assert_eq!(profile.base_path, "gitlab");
        assert_eq!(profile.provider, ForgeProvider::GitLab);
        assert_eq!(strip_base_path("gitlab/group/proj", &profile.base_path), "group/proj");
        // Deeper mounts and trailing slashes are the same statement.
        let deep = [account("a", "https://host.example/tools/gitlab/", Some("gitlab"))];
        assert_eq!(host_profile_in("host.example", &deep).base_path, "tools/gitlab");

        // The ordinary root install: nothing to learn, nothing to strip.
        let root = [account("a", "https://gitlab.com", Some("gitlab"))];
        assert_eq!(host_profile_in("gitlab.com", &root).base_path, "");
        assert_eq!(strip_base_path("group/proj", ""), "group/proj");

        // BOTH answers come from ONE account. A stray second credential that
        // happens to name a path must not make a root install look mounted —
        // that would strip a real namespace off every repository on the host.
        let mut authoritative = account("root", "https://host.example", Some("gitlab"));
        authoritative.is_default = true;
        let mixed = [
            account("stray", "https://host.example/gitlab", None),
            authoritative,
        ];
        let profile = host_profile_in("host.example", &mixed);
        assert_eq!(profile.base_path, "", "the declaring account speaks, path and all");
        assert_eq!(profile.provider, ForgeProvider::GitLab);
        assert_eq!(strip_base_path("gitlab/team/app", &profile.base_path), "gitlab/team/app");

        // Stripping only ever removes a prefix it can actually see, and never
        // leaves something that is no longer a repository path — a project
        // always lives in a namespace.
        assert_eq!(strip_base_path("group/proj", "gitlab"), "group/proj");
        assert_eq!(strip_base_path("gitlab/proj", "gitlab"), "gitlab/proj");
        assert_eq!(strip_base_path("GitLab/Group/Proj", "gitlab"), "group/proj");
    }

    /// A GitLab token handed to the GitHub client buys a 401 that reads like
    /// an expired credential. Declared accounts serve only their own forge;
    /// undeclared ones serve whatever the host is.
    #[test]
    fn accounts_only_serve_the_forge_they_declare() {
        assert!(serves(&account("a", "", Some("gitlab")), ForgeProvider::GitLab));
        assert!(!serves(&account("a", "", Some("gitlab")), ForgeProvider::GitHub));
        assert!(serves(&account("a", "", Some("GitHub")), ForgeProvider::GitHub));
        assert!(serves(&account("a", "", None), ForgeProvider::GitLab));
        assert!(serves(&account("a", "", Some("  ")), ForgeProvider::GitHub));
    }

    /// Error paths never touch the token store, so they are safe to assert in
    /// BOTH modes (the happy path needs a token and is covered below in the
    /// server-mode-only test — the desktop build would write the real OS
    /// keyring, which a unit test must never do).
    #[tokio::test]
    async fn resolution_rejects_wrong_host_and_missing_accounts() {
        let db = crate::db::test_helpers::fresh_in_memory_db().await;
        let mut only = account("acc-x", "https://github.com", None);
        only.is_default = true;
        let settings = GitHubAccountsSettings {
            accounts: vec![only],
        };
        app_metadata_service::upsert_value(
            &db.conn,
            GITHUB_ACCOUNTS_KEY,
            &serde_json::to_string(&settings).unwrap(),
        )
        .await
        .unwrap();
        let gh = ForgeProvider::GitHub;
        // A pinned id on the WRONG host is an error, not a silent substitute.
        assert!(matches!(
            resolve_forge_auth(&db.conn, gh, "ghe.corp.com", Some("acc-x")).await,
            Err(ForgeError::Auth(_))
        ));
        // A forge host with no account: its OWN variant, because that is the
        // miss the workbench turns into "add an account". A host that is not a
        // forge at all takes a different variant — see
        // `an_unvouched_for_host_is_refused_as_unsupported_not_as_a_missing_account`.
        assert!(matches!(
            resolve_forge_auth(&db.conn, gh, "github.corp.com", None).await,
            Err(ForgeError::NoAccount { .. })
        ));
        // Blank host is invalid input, not an auth miss.
        assert!(matches!(
            resolve_forge_auth(&db.conn, gh, "  ", None).await,
            Err(ForgeError::Invalid(_))
        ));
    }

    /// Server mode only: the file-backed token store can be pointed at a temp
    /// dir. Desktop would hit the real OS keyring — never in a unit test.
    #[cfg(not(feature = "tauri-runtime"))]
    #[tokio::test]
    async fn resolution_prefers_pinned_id_then_default_and_redacts_debug() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let db = crate::db::test_helpers::fresh_in_memory_db().await;
        let db_conn = db.conn.clone();
        let dir = tmp.path().to_string_lossy().to_string();
        temp_env::async_with_vars([("CODEG_DATA_DIR", Some(dir.as_str()))], async move {
            let db = db_conn;
            resolution_happy_path(&db).await;
        })
        .await;
    }

    #[cfg(not(feature = "tauri-runtime"))]
    async fn resolution_happy_path(conn: &sea_orm::DatabaseConnection) {
        let mut default = account("acc-default", "https://github.com", None);
        default.is_default = true;
        default.scopes = vec!["repo".into()];
        let mut alt = account("acc-alt", "", None);
        alt.username = "bob".into();
        let mut ghe = account("acc-ghe", "https://ghe.corp.com", None);
        ghe.username = "carol".into();
        let mut gitlab = account("acc-gitlab", "https://gitlab.com", Some("gitlab"));
        gitlab.username = "dan".into();
        let settings = GitHubAccountsSettings {
            accounts: vec![default, alt, ghe, gitlab],
        };
        app_metadata_service::upsert_value(
            conn,
            GITHUB_ACCOUNTS_KEY,
            &serde_json::to_string(&settings).unwrap(),
        )
        .await
        .unwrap();
        crate::keyring_store::set_token("acc-alt", "tok-alt").unwrap();
        crate::keyring_store::set_token("acc-default", "tok-default").unwrap();
        crate::keyring_store::set_token("acc-gitlab", "tok-gitlab").unwrap();
        let gh = ForgeProvider::GitHub;

        // Pinned id wins over the default account.
        let pinned = resolve_forge_auth(conn, gh, "github.com", Some("acc-alt"))
            .await
            .unwrap();
        assert_eq!(pinned.account_id, "acc-alt");
        // The pinned account's own login rides along — the push identity.
        assert_eq!(pinned.username, "bob");
        assert_eq!(pinned.api_base, "https://api.github.com");
        let shown = format!("{pinned:?}");
        assert!(shown.contains("<redacted>") && !shown.contains("tok-alt"));

        // No pin → the host's default.
        let by_default = resolve_forge_auth(conn, gh, "github.com", None).await.unwrap();
        assert_eq!(by_default.account_id, "acc-default");

        // A pinned id on the WRONG host is an error, not a silent substitute.
        assert!(matches!(
            resolve_forge_auth(conn, gh, "ghe.corp.com", Some("acc-alt")).await,
            Err(ForgeError::Auth(_))
        ));
        // GHE host derives the /api/v3 base — but without a stored token the
        // resolution must fail rather than hand back an unusable identity.
        // Still plain `Auth`: an account IS configured here, so "add an
        // account" would be the wrong advice.
        assert!(matches!(
            resolve_forge_auth(conn, gh, "ghe.corp.com", None).await,
            Err(ForgeError::Auth(_))
        ));
        // A forge host with no account at all — the actionable variant.
        assert!(matches!(
            resolve_forge_auth(conn, gh, "github.corp.com", None).await,
            Err(ForgeError::NoAccount { .. })
        ));
        // A host that claims neither forge and that nothing is configured for
        // is not a missing account, it is a forge codeg does not speak — and
        // "add a GitHub account for nowhere.example" would be advice that
        // cannot work.
        assert!(matches!(
            resolve_forge_auth(conn, gh, "nowhere.example", None).await,
            Err(ForgeError::UnsupportedHost { .. })
        ));

        // The GitLab account resolves for GitLab, with GitLab's API base…
        let gl = resolve_forge_auth(conn, ForgeProvider::GitLab, "gitlab.com", None)
            .await
            .unwrap();
        assert_eq!((gl.account_id.as_str(), gl.api_base.as_str()), ("acc-gitlab", "https://gitlab.com/api/v4"));
        // …and is invisible to the GitHub client, which would only spend it on
        // a 401 that reads like an expired token.
        assert!(matches!(
            resolve_forge_auth(conn, gh, "gitlab.com", Some("acc-gitlab")).await,
            Err(ForgeError::Auth(_))
        ));
    }

    // ── forge detection ────────────────────────────────────────────────────

    /// A server that answers `/api/v4/version` with `status` and `content_type`
    /// and 404s everything else — the shape of a real API, and what the probe
    /// checks for. Axum's own fallback supplies the 404 for the control path,
    /// which is exactly what GitLab does there.
    async fn mock_instance(status: u16, content_type: &'static str) -> String {
        use axum::routing::get;
        let app = axum::Router::new().route(
            "/api/v4/version",
            get(move || async move {
                (
                    axum::http::StatusCode::from_u16(status).unwrap(),
                    [(axum::http::header::CONTENT_TYPE, content_type)],
                    "{\"message\":\"401 Unauthorized\"}",
                )
            }),
        );
        serve(app).await
    }

    /// A server that answers EVERY path the same way — an authenticating
    /// gateway, which is what the control request exists to catch.
    async fn mock_catch_all(status: u16, content_type: &'static str) -> String {
        let app = axum::Router::new().fallback(move || async move {
            (
                axum::http::StatusCode::from_u16(status).unwrap(),
                [(axum::http::header::CONTENT_TYPE, content_type)],
                "{\"message\":\"401 Unauthorized\"}",
            )
        });
        serve(app).await
    }

    async fn serve(app: axum::Router) -> String {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        format!("http://{addr}")
    }

    /// The whole point: a GitLab that is NOT called `gitlab.*`. The hostname
    /// says GitHub, the instance says otherwise, and the instance wins — which
    /// is what stops `/api/v3` (and its 410) from ever being requested.
    #[tokio::test]
    async fn an_instance_that_serves_v4_is_detected_as_gitlab() {
        let host = "probe-serves-v4.test";
        forget_forge(host);
        // Unauthenticated GitLab answers 401, and that is enough: the endpoint
        // EXISTS, which is the fact being tested for.
        let origin = mock_instance(401, "application/json").await;
        assert_eq!(detect_forge(host, &origin).await, Some(ForgeProvider::GitLab));
        // The guess this overrode would have been GitHub, and with it /api/v3.
        assert_eq!(guess_provider(host), ForgeProvider::GitHub);
        // Conclusive answers are cached, so the round trip is paid once.
        assert_eq!(recall_forge(host), Some(ForgeProvider::GitLab));
        forget_forge(host);
    }

    /// No `/api/v4` means "not a GitLab", which is NOT the same as "a GitHub":
    /// the caller keeps its existing guess.
    ///
    /// The host ANSWERED though, so that is recorded — `folder_forge_remote_core`
    /// runs on every forge call, and without a cached negative every GitHub
    /// Enterprise request would carry a fresh probe.
    #[tokio::test]
    async fn a_host_without_v4_leaves_the_guess_alone() {
        let host = "probe-no-v4.test";
        forget_forge(host);
        let origin = mock_instance(404, "text/plain").await;
        assert_eq!(detect_forge(host, &origin).await, None);
        assert_eq!(recall_verdict(host), Some(None), "answered: not a GitLab");
        assert_eq!(recall_forge(host), None);
        forget_forge(host);
    }

    /// An SSO portal in front of a GitHub Enterprise can answer 401 to
    /// anything — but it answers with a login page. Requiring JSON is what
    /// keeps that from being read as "this is a GitLab".
    #[tokio::test]
    async fn an_html_401_is_not_a_gitlab() {
        let host = "probe-sso-portal.test";
        forget_forge(host);
        let origin = mock_instance(401, "text/html; charset=utf-8").await;
        assert_eq!(detect_forge(host, &origin).await, None);
        forget_forge(host);
    }

    /// The regression this guards: a gateway that answers JSON 401 to EVERY
    /// path. It is indistinguishable from GitLab on `/api/v4/version` alone, so
    /// believing that one answer would move a working GitHub Enterprise onto
    /// the GitLab client and break it. A real API 404s a path it does not
    /// route; a catch-all cannot.
    #[tokio::test]
    async fn a_gateway_that_401s_everything_is_not_taken_for_a_gitlab() {
        let host = "probe-catch-all.test";
        forget_forge(host);
        let origin = mock_catch_all(401, "application/json").await;
        assert_eq!(detect_forge(host, &origin).await, None);
        // Still a verdict: the gateway is not going to change its mind, and
        // re-probing it on every forge call would be pure cost.
        assert_eq!(recall_verdict(host), Some(None));
        forget_forge(host);
    }

    /// A GitLab that is mid-deploy answers 502 through its own reverse proxy.
    /// That is "ask again later", NOT "not a GitLab" — recording it would pin
    /// the host to the hostname guess until codeg restarts, which is the exact
    /// failure this detection exists to remove.
    #[tokio::test]
    async fn a_transient_server_error_is_not_a_verdict() {
        let host = "probe-restarting.test";
        forget_forge(host);
        let origin = mock_catch_all(502, "text/html").await;
        assert_eq!(detect_forge(host, &origin).await, None);
        assert_eq!(recall_verdict(host), None, "502 is not an answer");
        forget_forge(host);
    }

    /// The cache has THREE states, and the middle one is the one worth having:
    /// "asked, and it is not a GitLab" is what stops a GitHub Enterprise from
    /// re-probing on every call, while "never got an answer" has to stay
    /// distinct from it so an unreachable host is re-asked instead of pinned to
    /// the hostname guess for the life of the process.
    ///
    /// Exercised through the recorder rather than through a dead port: this
    /// machine may sit behind a proxy, which answers for unreachable origins
    /// and would make a connection-level test assert the proxy's behaviour.
    #[test]
    fn the_cache_tells_a_negative_verdict_apart_from_no_verdict() {
        let (answered_gitlab, answered_not, unasked) = (
            "verdict-gitlab.test",
            "verdict-negative.test",
            "verdict-absent.test",
        );
        for h in [answered_gitlab, answered_not, unasked] {
            forget_forge(h);
        }

        remember_forge(answered_gitlab, ForgeProvider::GitLab);
        record_verdict(answered_not, None);

        assert_eq!(recall_verdict(answered_gitlab), Some(Some(ForgeProvider::GitLab)));
        assert_eq!(recall_forge(answered_gitlab), Some(ForgeProvider::GitLab));

        assert_eq!(recall_verdict(answered_not), Some(None), "asked: not a GitLab");
        assert_eq!(recall_forge(answered_not), None);

        assert_eq!(recall_verdict(unasked), None, "never asked");

        for h in [answered_gitlab, answered_not, unasked] {
            forget_forge(h);
        }
    }

    /// What `github::finish` does when GitLab announces itself in a 410: the
    /// answer is remembered, so the probe is not even consulted next time and
    /// an unreachable origin cannot undo the correction.
    #[tokio::test]
    async fn a_remembered_forge_short_circuits_the_probe() {
        let host = "probe-remembered.test";
        forget_forge(host);
        remember_forge(host, ForgeProvider::GitLab);
        // Nothing is listening on this origin; the cache answers anyway.
        assert_eq!(
            detect_forge(host, "http://127.0.0.1:1").await,
            Some(ForgeProvider::GitLab)
        );
        forget_forge(host);
    }

    /// The public hosts are decided by name and never probed — a round trip
    /// per panel load to learn something already known.
    #[tokio::test]
    async fn the_public_hosts_are_never_probed() {
        assert_eq!(detect_forge("github.com", "http://127.0.0.1:1").await, None);
        assert_eq!(detect_forge("gitlab.com", "http://127.0.0.1:1").await, None);
    }

    /// A Gitea that answers `/api/v1/version` — public on every instance, no
    /// token needed — and 404s everything else, which is what its own router
    /// does for an unrouted API path.
    async fn mock_gitea(body: &'static str) -> String {
        use axum::routing::get;
        let app = axum::Router::new().route(
            "/api/v1/version",
            get(move || async move {
                (
                    axum::http::StatusCode::OK,
                    [(axum::http::header::CONTENT_TYPE, "application/json;charset=utf-8")],
                    body,
                )
            }),
        );
        serve(app).await
    }

    /// The Gitea equivalent of the GitLab probe, and the reason it goes FIRST:
    /// `/api/v1/version` needs no credential, so a self-hosted instance whose
    /// name says nothing identifies itself before a single token is spent.
    #[tokio::test]
    async fn an_instance_that_announces_a_version_on_v1_is_detected_as_gitea() {
        let host = "probe-serves-v1.test";
        forget_forge(host);
        let origin = mock_gitea("{\"version\":\"1.23.4\"}").await;
        assert_eq!(detect_forge(host, &origin).await, Some(ForgeProvider::Gitea));
        // The guess this overrode would have been GitHub, and with it /api/v3.
        assert_eq!(guess_provider(host), ForgeProvider::GitHub);
        assert_eq!(recall_forge(host), Some(ForgeProvider::Gitea));
        forget_forge(host);
    }

    /// The BODY is what concludes it, not the status. A proxy that answers 200
    /// JSON to every path — the mirror image of the 401 gateway the GitLab
    /// control request exists to catch — carries no `version`, so it is not
    /// taken for a Gitea, and the probe falls through to the GitLab question
    /// rather than stopping there.
    #[tokio::test]
    async fn a_json_200_without_a_version_is_not_a_gitea() {
        let host = "probe-json-catch-all.test";
        forget_forge(host);
        let origin = mock_catch_all(200, "application/json").await;
        assert_eq!(detect_forge(host, &origin).await, None);
        // It answered — twice, in fact, since a non-Gitea falls through — and
        // neither question concluded anything. Recorded so a GitHub Enterprise
        // behind such a proxy does not re-probe on every forge call.
        assert_eq!(recall_verdict(host), Some(None));
        forget_forge(host);

        // A `version` that is present but empty says nothing either.
        let host = "probe-blank-version.test";
        forget_forge(host);
        let origin = mock_gitea("{\"version\":\"  \"}").await;
        assert_eq!(detect_forge(host, &origin).await, None);
        forget_forge(host);
    }

    /// A Gitea mid-restart answers 502 through whatever sits in front of it.
    /// That has to stay "ask again later" on the FIRST probe too — recording it
    /// would pin the host to the hostname guess for the life of the process,
    /// and never even ask the GitLab question.
    #[tokio::test]
    async fn a_transient_answer_to_the_gitea_probe_is_not_a_verdict() {
        let host = "probe-gitea-restarting.test";
        forget_forge(host);
        let origin = mock_catch_all(503, "application/json").await;
        assert_eq!(detect_forge(host, &origin).await, None);
        assert_eq!(recall_verdict(host), None, "503 is not an answer");
        forget_forge(host);
    }
}
