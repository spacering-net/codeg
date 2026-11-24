//! The Web sign-in itself: starting a sign-in, completing it when the browser
//! comes back, reading a browser's account, signing out, and the hourly
//! cleanup. The HTTP side (cookies, `Origin`, JSON, status codes) is
//! `routes.rs`; this side gets the cookie values a request presented and
//! says which cookies to set.

use std::collections::HashSet;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use chrono::{DateTime, SecondsFormat, Utc};
use sea_orm::{DatabaseConnection, TransactionTrait};
use sha2::{Digest, Sha256};
use tokio_util::task::TaskTracker;

use super::config::{Settings, WebConfig};
use super::seal::{KeySource, Purpose, SealKey, Sealer};
use super::types::{
    OnlineStatus, RemoteSignOut, SrnIdentity, SrnOnline, SrnWebAccountState, SrnWebLoginStarted,
    SrnWebSignOutResult, WebProblem,
};
use crate::app_error::AppCommandError;
use crate::db::entities::{srn_web_login, srn_web_session};
use crate::db::service::srn_web_service as store;
use crate::harness::origin::Origin;
use crate::models::system::AppLocale;
use crate::srn::client::{ClientSecretBasic, CodeExchange, LoginRequest, SrnApi, REQUEST_TIMEOUT};
use crate::srn::error::{Problem, SrnError};
use crate::srn::pkce::{AccessToken, AuthCode, FlowSecret, RequestId};

/// A sign-in waits this long for the browser (SpaceRing's request lasts as
/// long).
pub const LOGIN_LIFETIME: Duration = Duration::from_secs(10 * 60);
/// A session ends after this long without use, as SpaceRing's connection
/// does.
pub const SESSION_LIFETIME: Duration = Duration::from_secs(30 * 24 * 60 * 60);
/// A use is written down at most this often (the session's expiry moves with
/// it).
pub const USE_RECORD_INTERVAL: Duration = Duration::from_secs(60 * 60);
/// After a check SpaceRing answered, the next one waits this long.
pub const CHECK_INTERVAL: Duration = Duration::from_secs(60 * 60);
/// After a check that got no answer, or while one is under way.
pub const CHECK_RETRY: Duration = Duration::from_secs(60);
/// How long a check waits for `/me` before it records that SpaceRing did
/// not answer ("could not confirm online").
pub const CHECK_DEADLINE: Duration = Duration::from_secs(10);
/// How long a status read waits for the check it started. A page should not
/// sit on "loading" while SpaceRing is slow or out of reach: past this, the
/// read answers with what the session's row says, and the check goes on to
/// record its outcome for the next read.
pub const CHECK_WAIT: Duration = Duration::from_secs(2);
/// How long a sign-out waits for SpaceRing to confirm. The person's buttons
/// wait with it, and the session here is already gone: no answer in time
/// counts as no answer at all.
pub const LOGOUT_DEADLINE: Duration = Duration::from_secs(5);
/// How often expired rows are removed.
pub const CLEANUP_INTERVAL: Duration = Duration::from_secs(60 * 60);

/// What SpaceRing's login request records as the client's platform: Codeg
/// Web is a server, whatever it runs on.
const PLATFORM: &str = "web";

fn span(duration: Duration) -> chrono::Duration {
    chrono::Duration::from_std(duration).expect("a short duration")
}

pub(crate) fn rfc3339(at: DateTime<Utc>) -> String {
    at.to_rfc3339_opts(SecondsFormat::Millis, true)
}

/// SHA-256, hex: how cookies and states are kept.
pub(crate) fn digest(value: &str) -> String {
    Sha256::digest(value.as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// The time, which tests move by hand.
#[derive(Clone)]
pub(crate) enum Clock {
    System,
    #[cfg(test)]
    Manual(Arc<Mutex<DateTime<Utc>>>),
}

impl Clock {
    fn now(&self) -> DateTime<Utc> {
        match self {
            Self::System => Utc::now(),
            #[cfg(test)]
            Self::Manual(at) => *at.lock().unwrap(),
        }
    }
}

/// How long requests wait on SpaceRing, which tests shorten.
#[derive(Debug, Clone, Copy)]
pub(crate) struct Waits {
    /// A status read, for the check it started ([`CHECK_WAIT`]).
    pub check: Duration,
    /// A sign-out, for SpaceRing's confirmation ([`LOGOUT_DEADLINE`]).
    pub logout: Duration,
}

impl Default for Waits {
    fn default() -> Self {
        Self {
            check: CHECK_WAIT,
            logout: LOGOUT_DEADLINE,
        }
    }
}

/// The cookie values a request carried (well-formed ones only).
#[derive(Debug, Default, Clone)]
pub struct Presented {
    pub session: Vec<String>,
    pub flow: Vec<String>,
}

impl Presented {
    fn session_hashes(&self) -> Vec<(String, String)> {
        self.session
            .iter()
            .map(|v| (digest(v), v.clone()))
            .collect()
    }

    fn flow_hashes(&self) -> Vec<String> {
        self.flow.iter().map(|v| digest(v)).collect()
    }
}

/// Which cookies the answer sets.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct CookieChanges {
    /// A session cookie to set, for the session's whole lifetime: a new one,
    /// or the one presented, renewed.
    pub session: Option<String>,
    pub clear_session: bool,
    /// A flow cookie to set, for a sign-in's lifetime.
    pub flow: Option<String>,
    pub clear_flow: bool,
}

/// How a sign-in that came back ended: `ok` or a problem's code — always one
/// of `types::CALLBACK_RESULTS`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Completed {
    pub result: &'static str,
    pub cookies: CookieChanges,
}

/// What the browser came back with.
#[derive(Debug)]
pub enum Callback {
    Code { code: AuthCode, state: String },
    Denied { state: String },
}

/// The service. One per process (`srn::web::install`); tests make their own.
pub struct SrnWeb {
    config: Option<WebConfig>,
    api: SrnApi,
    sealer: Sealer,
    db: DatabaseConnection,
    clock: Clock,
    waits: Waits,
    /// Sessions whose online check is under way here.
    checking: Arc<Mutex<HashSet<i32>>>,
    /// Online checks, and revocations of replaced and expired sessions:
    /// work that outlives the request that started it.
    background: TaskTracker,
}

impl SrnWeb {
    /// From the settings as read: a service that is on or off. Off, it still
    /// cleans up what an earlier configuration left.
    pub fn new(settings: Settings, key: KeySource, db: DatabaseConnection) -> Arc<Self> {
        let config = match settings {
            Settings::Enabled(config) => Some(config),
            Settings::Disabled(_) => None,
        };
        let origin = config
            .as_ref()
            .map(|config| config.srn_origin.clone())
            .unwrap_or_else(crate::harness::origin::current);
        Self::assemble(
            config,
            SrnApi::with_timeout(origin, REQUEST_TIMEOUT),
            key,
            db,
            Clock::System,
            Waits::default(),
        )
    }

    pub(crate) fn assemble(
        config: Option<WebConfig>,
        api: SrnApi,
        key: KeySource,
        db: DatabaseConnection,
        clock: Clock,
        waits: Waits,
    ) -> Arc<Self> {
        let api = match &config {
            Some(config) => api.with_client_credentials(ClientSecretBasic::new(
                &config.client_id,
                config.client_secret.expose(),
            )),
            None => api,
        };
        Arc::new(Self {
            config,
            api,
            sealer: Sealer::new(key),
            db,
            clock,
            waits,
            checking: Arc::default(),
            background: TaskTracker::new(),
        })
    }

    pub fn is_enabled(&self) -> bool {
        self.config.is_some()
    }

    /// The public origin browsers must send as `Origin`, when on.
    pub fn public_origin(&self) -> Option<&str> {
        self.config.as_ref().map(|c| c.public_origin.as_str())
    }

    fn origin(&self) -> &Origin {
        self.api.origin()
    }

    async fn key(&self) -> Result<Arc<SealKey>, WebProblem> {
        self.sealer.key().await.map_err(|detail| {
            tracing::warn!("[srn-web] the sign-in key is unavailable: {detail}");
            WebProblem::KeyUnavailable { detail }
        })
    }

    // ─── Starting ───────────────────────────────────────────────────────

    /// A new sign-in for this browser: SpaceRing's login request, the
    /// pending row, and the flow cookie it is bound to. A sign-in the same
    /// browser started before is dropped.
    pub async fn start_login(
        &self,
        presented: &Presented,
        locale: Option<AppLocale>,
    ) -> Result<(SrnWebLoginStarted, CookieChanges), WebProblem> {
        let config = self.config.as_ref().ok_or(WebProblem::NotEnabled)?;
        let key = self.key().await?;
        let internal = |error: rand::Error| {
            WebProblem::from(Problem::Internal {
                detail: error.to_string(),
            })
        };
        let state = FlowSecret::generate().map_err(internal)?;
        let verifier = FlowSecret::generate().map_err(internal)?;
        let flow = FlowSecret::generate().map_err(internal)?;
        let installation = FlowSecret::generate().map_err(internal)?;
        let challenge = verifier.challenge();
        let created = self
            .api
            .create_login_request(&LoginRequest {
                client_id: &config.client_id,
                redirect_uri: &config.redirect_uri,
                state: &state,
                code_challenge: &challenge,
                installation_id: installation.expose(),
                platform: PLATFORM,
                device_name: None,
            })
            .await
            .map_err(|error| {
                let problem = Problem::from_request(error);
                tracing::warn!(
                    "[srn-web] the login request was not created: {}",
                    problem.code()
                );
                WebProblem::from(problem)
            })?;
        let now = self.clock.now();
        let state_hash = digest(state.expose());
        let seal = |purpose, value: &str| {
            key.seal(purpose, &state_hash, value)
                .map_err(|detail| WebProblem::from(Problem::Internal { detail }))
        };
        let row = srn_web_login::Model {
            state_hash: state_hash.clone(),
            flow_hash: digest(flow.expose()),
            verifier: seal(Purpose::Verifier, verifier.expose())?,
            request_id: seal(Purpose::RequestId, created.request_id.expose())?,
            created_at: now,
            expires_at: now + span(LOGIN_LIFETIME),
        };
        let storage = |error: crate::db::error::DbError| {
            tracing::warn!("[srn-web] the sign-in could not be kept: {error}");
            WebProblem::Storage {
                detail: "the sign-in could not be kept".into(),
            }
        };
        store::delete_logins_of_flows(&self.db, &presented.flow_hashes())
            .await
            .map_err(storage)?;
        store::insert_login(&self.db, row).await.map_err(storage)?;
        tracing::info!("[srn-web] sign-in started");
        let url = localized(created.authorization_url, chinese(locale));
        Ok((
            SrnWebLoginStarted {
                authorization_url: url.to_string(),
                expires_at: rfc3339(now + span(LOGIN_LIFETIME)),
            },
            CookieChanges {
                flow: Some(flow.expose().to_string()),
                ..CookieChanges::default()
            },
        ))
    }

    // ─── Completing ─────────────────────────────────────────────────────

    /// The browser came back: take the pending sign-in bound to its flow
    /// cookie (once), exchange the code (once), confirm who it is, replace
    /// the browser's older session, and hand it a new session cookie.
    pub async fn complete(
        &self,
        callback: Result<Callback, ()>,
        presented: &Presented,
    ) -> Completed {
        let (result, session) = self.complete_inner(callback, presented).await;
        tracing::info!("[srn-web] sign-in came back: {result}");
        // The flow cookie goes with the sign-in it was bound to. One that
        // still has a sign-in waiting (this callback named another state)
        // stays: a stray address must not break the sign-in under way.
        let waiting = match store::find_live_login(
            &self.db,
            &presented.flow_hashes(),
            self.clock.now(),
        )
        .await
        {
            Ok(row) => row.is_some(),
            Err(_) => false,
        };
        Completed {
            result,
            cookies: CookieChanges {
                session,
                clear_flow: !waiting && !presented.flow.is_empty(),
                ..CookieChanges::default()
            },
        }
    }

    async fn complete_inner(
        &self,
        callback: Result<Callback, ()>,
        presented: &Presented,
    ) -> (&'static str, Option<String>) {
        let fail = |problem: WebProblem| (problem.code(), None);
        let Some(config) = self.config.as_ref() else {
            return fail(WebProblem::NotEnabled);
        };
        let Ok(callback) = callback else {
            return fail(WebProblem::InvalidCallback);
        };
        let flows = presented.flow_hashes();
        if flows.is_empty() {
            return fail(WebProblem::FlowMissing);
        }
        let state = match &callback {
            Callback::Code { state, .. } | Callback::Denied { state } => state,
        };
        let state_hash = digest(state);
        // Before the sign-in is taken: a key that will not open now leaves
        // it in place.
        let key = match self.key().await {
            Ok(key) => key,
            Err(problem) => return fail(problem),
        };
        let claimed = match store::claim_login(&self.db, &state_hash, &flows).await {
            Ok(Some(row)) => row,
            Ok(None) => return fail(Problem::Expired.into()),
            Err(error) => {
                tracing::warn!("[srn-web] the pending sign-in could not be read: {error}");
                return fail(WebProblem::Storage {
                    detail: String::new(),
                });
            }
        };
        if claimed.expires_at <= self.clock.now() {
            return fail(Problem::Expired.into());
        }
        let code = match callback {
            Callback::Denied { .. } => return fail(Problem::AccessDenied.into()),
            Callback::Code { code, .. } => code,
        };
        // Sealed under a key this server no longer has: the sign-in cannot
        // finish, and starting again is the way.
        let Some(verifier) = key
            .open(Purpose::Verifier, &state_hash, &claimed.verifier)
            .and_then(|v| FlowSecret::parse(&v))
        else {
            return fail(Problem::Expired.into());
        };
        // Once, whatever happens to the answer: a code presented again ends
        // the connection it opened.
        let exchanged = self
            .api
            .exchange_code_for_connection(&CodeExchange {
                client_id: &config.client_id,
                redirect_uri: &config.redirect_uri,
                code: &code,
                verifier: &verifier,
            })
            .await;
        let (grant, connection_id) = match exchanged {
            Ok(exchanged) => exchanged,
            Err(error) => return fail(Problem::from_exchange(error).into()),
        };
        let now = self.clock.now();
        let mut user = grant.user.clone();
        let mut check_problem = None;
        let mut confirmed_at = None;
        match self.api.me(&grant.token).await {
            Ok(me) if me.srn == grant.user.srn => {
                user = me;
                confirmed_at = Some(now);
            }
            Ok(_) => {
                self.revoke_in_background(vec![grant.token]);
                return fail(Problem::AccountChanged.into());
            }
            Err(SrnError::Unauthorized) => return fail(Problem::Revoked.into()),
            // Not confirmed online, for now: the identity is the exchange's.
            Err(error) => check_problem = Some(Problem::from_check(error)),
        }
        let Ok(srn) = i64::try_from(user.srn) else {
            self.revoke_in_background(vec![grant.token]);
            return fail(
                Problem::InvalidResponse {
                    detail: "the SRN number is out of range".into(),
                }
                .into(),
            );
        };
        let cookie = match FlowSecret::generate() {
            Ok(cookie) => cookie,
            Err(error) => {
                self.revoke_in_background(vec![grant.token]);
                return fail(
                    Problem::Internal {
                        detail: error.to_string(),
                    }
                    .into(),
                );
            }
        };
        let cookie_hash = digest(cookie.expose());
        let sealed = match key.seal(Purpose::Token, &cookie_hash, grant.token.expose()) {
            Ok(sealed) => sealed,
            Err(detail) => {
                self.revoke_in_background(vec![grant.token]);
                return fail(Problem::Internal { detail }.into());
            }
        };
        let next_check_at = now
            + span(match &check_problem {
                Some(Problem::Network { .. }) => CHECK_RETRY,
                Some(Problem::RateLimited { seconds }) => {
                    CHECK_INTERVAL.max(Duration::from_secs(*seconds))
                }
                _ => CHECK_INTERVAL,
            });
        let session = store::NewSession {
            cookie_hash,
            srn,
            display_name: user.name.clone(),
            avatar_path: user.avatar_path.clone(),
            connection_id,
            token: sealed,
            now,
            last_confirmed_at: confirmed_at,
            check_problem: check_problem.as_ref().map(stored_problem),
            next_check_at,
            expires_at: now + span(SESSION_LIFETIME),
        };
        let older: Vec<String> = presented
            .session_hashes()
            .into_iter()
            .map(|(hash, _)| hash)
            .collect();
        let replaced = match self.replace_sessions(&older, session).await {
            Ok(replaced) => replaced,
            Err(error) => {
                tracing::warn!("[srn-web] the session could not be kept: {error}");
                self.revoke_in_background(vec![grant.token]);
                return fail(WebProblem::Storage {
                    detail: String::new(),
                });
            }
        };
        // The browser's older sign-in ends here, and on SpaceRing as far as
        // it can be told.
        let tokens = replaced
            .iter()
            .filter_map(|row| open_token(&key, row))
            .collect::<Vec<_>>();
        if !replaced.is_empty() {
            tracing::info!("[srn-web] an older sign-in of this browser was replaced");
        }
        self.revoke_in_background(tokens);
        ("ok", Some(cookie.expose().to_string()))
    }

    async fn replace_sessions(
        &self,
        older: &[String],
        session: store::NewSession,
    ) -> Result<Vec<srn_web_session::Model>, crate::db::error::DbError> {
        let txn = self.db.begin().await?;
        let replaced = store::delete_sessions_of_cookies(&txn, older).await?;
        store::insert_session(&txn, session).await?;
        txn.commit().await?;
        Ok(replaced)
    }

    // ─── Reading ────────────────────────────────────────────────────────

    /// This browser's account. Confirms it with SpaceRing when the last
    /// confirmation is an hour old; SpaceRing's 401 ends the session here,
    /// anything else keeps it as "could not confirm online". A check that
    /// takes longer than [`CHECK_WAIT`] is answered by a later read.
    pub async fn account(
        self: &Arc<Self>,
        presented: &Presented,
        locale: Option<AppLocale>,
    ) -> (SrnWebAccountState, CookieChanges) {
        let mut cookies = CookieChanges::default();
        if !self.is_enabled() {
            return (SrnWebAccountState::NotEnabled, cookies);
        }
        let hashes = presented.session_hashes();
        if !hashes.is_empty() {
            let keys: Vec<String> = hashes.iter().map(|(hash, _)| hash.clone()).collect();
            let row = match store::find_session(&self.db, &keys).await {
                Ok(row) => row,
                Err(error) => return (unavailable_storage(error), cookies),
            };
            let now = self.clock.now();
            match row {
                Some(row) if row.expires_at > now => {
                    let value = hashes
                        .iter()
                        .find(|(hash, _)| *hash == row.cookie_hash)
                        .map(|(_, value)| value.clone());
                    return self.signed_in(row, value, cookies).await;
                }
                // Over, or never this server's: the cookie goes (the row,
                // if any, is the cleanup's).
                _ => cookies.clear_session = true,
            }
        }
        match self.pending(presented, locale).await {
            Ok(Some(pending)) => (pending, cookies),
            Ok(None) => (SrnWebAccountState::SignedOut { problem: None }, cookies),
            Err(problem) => (
                SrnWebAccountState::Unavailable {
                    problem: problem.to_app_error(),
                },
                cookies,
            ),
        }
    }

    async fn signed_in(
        self: &Arc<Self>,
        row: srn_web_session::Model,
        cookie: Option<String>,
        mut cookies: CookieChanges,
    ) -> (SrnWebAccountState, CookieChanges) {
        let key = match self.key().await {
            Ok(key) => key,
            Err(problem) => {
                return (
                    SrnWebAccountState::Unavailable {
                        problem: problem.to_app_error(),
                    },
                    cookies,
                )
            }
        };
        let Some(token) = open_token(&key, &row) else {
            // Sealed under a key this server does not have (a backup
            // restored elsewhere, a lost key): signed out, and the row goes.
            tracing::info!("[srn-web] a session that does not open was removed");
            if let Err(error) = store::delete_session(&self.db, row.id).await {
                return (unavailable_storage(error), cookies);
            }
            cookies.clear_session = true;
            return (
                SrnWebAccountState::SignedOut {
                    problem: Some(WebProblem::SessionUnreadable.to_app_error()),
                },
                cookies,
            );
        };
        let now = self.clock.now();
        if row.last_used_at + span(USE_RECORD_INTERVAL) <= now {
            match store::touch_session(&self.db, row.id, now, now + span(SESSION_LIFETIME)).await {
                Ok(()) => cookies.session = cookie,
                Err(error) => tracing::warn!("[srn-web] a use was not recorded: {error}"),
            }
        }
        if row.next_check_at <= now {
            match store::claim_check(&self.db, row.id, now, now + span(CHECK_RETRY)).await {
                Ok(true) => return self.check_briefly(row, token, cookies).await,
                Ok(false) => {}
                Err(error) => tracing::warn!("[srn-web] the online check was not claimed: {error}"),
            }
        }
        let checking = self.checking.lock().unwrap().contains(&row.id);
        (signed_in_state(&row, checking, None), cookies)
    }

    /// Runs the check as a task of its own and waits for it at most
    /// [`CHECK_WAIT`]. In time, its answer is this read's, as if the read
    /// had made it. Otherwise the read answers with the row as it stands,
    /// marked as checking, and the task records the outcome — a 401 or
    /// another account included — for the next read: the row goes, and
    /// that read clears the cookie of a session it no longer finds.
    async fn check_briefly(
        self: &Arc<Self>,
        row: srn_web_session::Model,
        token: AccessToken,
        cookies: CookieChanges,
    ) -> (SrnWebAccountState, CookieChanges) {
        let (kept_row, kept_cookies) = (row.clone(), cookies.clone());
        // Marked before the task is spawned, and until it ends (outcome
        // recorded): no read in between sees a check as not under way.
        let checking = Checking::start(&self.checking, row.id);
        let service = Arc::clone(self);
        let task = self.background.spawn(async move {
            let _checking = checking;
            service.check(row, token, cookies).await
        });
        match tokio::time::timeout(self.waits.check, task).await {
            Ok(Ok(answer)) => answer,
            Err(_) => (signed_in_state(&kept_row, true, None), kept_cookies),
            // The task is gone without an answer (it panicked): the claim
            // lapses after `CHECK_RETRY`, and a later read checks again.
            Ok(Err(error)) => {
                tracing::warn!("[srn-web] the online check ended without an outcome: {error}");
                (signed_in_state(&kept_row, false, None), kept_cookies)
            }
        }
    }

    /// `/me`, and what its answer does to the session. Its own deadline
    /// bounds it, whether a read still waits for it or not.
    async fn check(
        &self,
        row: srn_web_session::Model,
        token: AccessToken,
        cookies: CookieChanges,
    ) -> (SrnWebAccountState, CookieChanges) {
        let answer = tokio::time::timeout(CHECK_DEADLINE, self.api.me(&token))
            .await
            .unwrap_or_else(|_| Err(SrnError::Network("SRN did not answer in time".into())));
        let now = self.clock.now();
        let (state, outcome) = match answer {
            Ok(user) if user.srn == row.srn as u64 => {
                let outcome = store::CheckOutcome {
                    checked_at: now,
                    next_check_at: now + span(CHECK_INTERVAL),
                    confirmed: Some((user.name.clone(), user.avatar_path.clone())),
                    problem: None,
                };
                let mut row = row.clone();
                row.display_name = user.name;
                row.avatar_path = user.avatar_path;
                row.last_checked_at = now;
                row.last_confirmed_at = Some(now);
                row.check_problem = None;
                (signed_in_state(&row, false, None), outcome)
            }
            Ok(_) => {
                // Not the account this browser signed in as: nothing of it
                // is kept.
                self.revoke_in_background(vec![token]);
                return self
                    .end_session(&row, Problem::AccountChanged, cookies)
                    .await;
            }
            Err(SrnError::Unauthorized) => {
                return self.end_session(&row, Problem::Revoked, cookies).await;
            }
            Err(error) => {
                let answered = error.is_answer();
                let problem = Problem::from_check(error);
                let wait = match &problem {
                    Problem::RateLimited { seconds } => {
                        CHECK_INTERVAL.max(Duration::from_secs(*seconds))
                    }
                    _ if answered => CHECK_INTERVAL,
                    _ => CHECK_RETRY,
                };
                let outcome = store::CheckOutcome {
                    checked_at: now,
                    next_check_at: now + span(wait),
                    confirmed: None,
                    problem: Some(stored_problem(&problem)),
                };
                let mut row = row.clone();
                row.last_checked_at = now;
                row.check_problem = outcome.problem.clone();
                (signed_in_state(&row, false, Some(&problem)), outcome)
            }
        };
        if let Err(error) = store::record_check(&self.db, row.id, outcome).await {
            tracing::warn!("[srn-web] the online check was not recorded: {error}");
        }
        (state, cookies)
    }

    /// SpaceRing no longer accepts the session's token (or names someone
    /// else): it ends here.
    async fn end_session(
        &self,
        row: &srn_web_session::Model,
        problem: Problem,
        mut cookies: CookieChanges,
    ) -> (SrnWebAccountState, CookieChanges) {
        if let Err(error) = store::delete_session(&self.db, row.id).await {
            return (unavailable_storage(error), cookies);
        }
        tracing::info!("[srn-web] a session ended: {}", problem.code());
        cookies.clear_session = true;
        cookies.session = None;
        (
            SrnWebAccountState::SignedOut {
                problem: Some(problem.to_app_error()),
            },
            cookies,
        )
    }

    async fn pending(
        &self,
        presented: &Presented,
        locale: Option<AppLocale>,
    ) -> Result<Option<SrnWebAccountState>, WebProblem> {
        let flows = presented.flow_hashes();
        if flows.is_empty() {
            return Ok(None);
        }
        let row = store::find_live_login(&self.db, &flows, self.clock.now())
            .await
            .map_err(|error| storage_problem(&error))?;
        let Some(row) = row else {
            return Ok(None);
        };
        let key = self.key().await?;
        let Some(request_id) = key
            .open(Purpose::RequestId, &row.state_hash, &row.request_id)
            .and_then(|id| RequestId::parse(&id))
        else {
            return Ok(None);
        };
        let mut url = self.origin().join("/authorize/").map_err(|_| {
            WebProblem::from(Problem::Internal {
                detail: "the authorization page".into(),
            })
        })?;
        url.set_fragment(Some(&format!("request_id={}", request_id.expose())));
        Ok(Some(SrnWebAccountState::Pending {
            authorization_url: localized(url, chinese(locale)).to_string(),
            expires_at: rfc3339(row.expires_at),
        }))
    }

    // ─── Signing out ────────────────────────────────────────────────────

    /// Ends this browser's session: the row and the cookie first, then
    /// SpaceRing is told. `expected_srn`, when given, is the account the
    /// person saw: another one is `accountChanged`, and nothing happens.
    pub async fn sign_out(
        &self,
        presented: &Presented,
        expected_srn: Option<u64>,
        locale: Option<AppLocale>,
    ) -> Result<(SrnWebSignOutResult, CookieChanges), WebProblem> {
        if !self.is_enabled() {
            return Err(WebProblem::NotEnabled);
        }
        let signed_out = SrnWebAccountState::SignedOut { problem: None };
        let cleared = CookieChanges {
            clear_session: true,
            ..CookieChanges::default()
        };
        let not_signed_in = || {
            (
                SrnWebSignOutResult {
                    state: signed_out.clone(),
                    remote: RemoteSignOut::NotSignedIn,
                    manage_connections_url: None,
                    problem: None,
                },
                cleared.clone(),
            )
        };
        let hashes: Vec<String> = presented
            .session_hashes()
            .into_iter()
            .map(|(hash, _)| hash)
            .collect();
        let row = store::find_session(&self.db, &hashes)
            .await
            .map_err(|error| storage_problem(&error))?;
        let Some(row) = row.filter(|row| row.expires_at > self.clock.now()) else {
            return Ok(not_signed_in());
        };
        if expected_srn.is_some_and(|srn| srn != row.srn as u64) {
            return Err(Problem::AccountChanged.into());
        }
        let token = match self.key().await {
            Ok(key) => open_token(&key, &row).ok_or(WebProblem::SessionUnreadable),
            Err(problem) => Err(problem),
        };
        store::delete_session(&self.db, row.id)
            .await
            .map_err(|error| storage_problem(&error))?;
        let url = self.manage_connections_url(chinese(locale));
        let unconfirmed = |reason: WebProblem| {
            tracing::info!(
                "[srn-web] signed out here; SpaceRing did not confirm: {}",
                reason.code()
            );
            SrnWebSignOutResult {
                state: signed_out.clone(),
                remote: RemoteSignOut::Unconfirmed,
                manage_connections_url: Some(url.clone()),
                problem: Some(signed_out_locally(&url, &reason)),
            }
        };
        let result = match token {
            Err(reason) => unconfirmed(reason),
            Ok(token) => match tokio::time::timeout(self.waits.logout, self.api.logout(&token))
                .await
                .unwrap_or_else(|_| Err(SrnError::Network("SRN did not answer in time".into())))
            {
                Ok(()) | Err(SrnError::Unauthorized) => {
                    tracing::info!("[srn-web] signed out");
                    SrnWebSignOutResult {
                        state: signed_out.clone(),
                        remote: RemoteSignOut::Confirmed,
                        manage_connections_url: None,
                        problem: None,
                    }
                }
                Err(error) => unconfirmed(Problem::from_check(error).into()),
            },
        };
        Ok((result, cleared))
    }

    /// The website's list of connections, in the interface's language.
    pub fn manage_connections_url(&self, chinese: bool) -> String {
        let path = if chinese {
            "/zh/console/clients/"
        } else {
            "/console/clients/"
        };
        format!("{}{path}", self.origin().as_str())
    }

    // ─── Cleaning up ────────────────────────────────────────────────────

    /// Removes the sign-ins and sessions whose time is up, and tells
    /// SpaceRing the sessions' connections are over (best effort). Returns
    /// how many of each went.
    pub async fn cleanup(&self) -> (u64, usize) {
        let now = self.clock.now();
        let logins = store::delete_expired_logins(&self.db, now)
            .await
            .unwrap_or_else(|error| {
                tracing::warn!("[srn-web] expired sign-ins were not removed: {error}");
                0
            });
        let sessions = match store::delete_expired_sessions(&self.db, now).await {
            Ok(rows) => rows,
            Err(error) => {
                tracing::warn!("[srn-web] expired sessions were not removed: {error}");
                Vec::new()
            }
        };
        let removed = sessions.len();
        if removed > 0 {
            tracing::info!("[srn-web] {removed} expired session(s) removed");
            if let Ok(key) = self.key().await {
                let tokens = sessions
                    .iter()
                    .filter_map(|row| open_token(&key, row))
                    .collect::<Vec<_>>();
                self.revoke(tokens).await;
            }
        }
        (logins, removed)
    }

    /// The hourly cleanup, for the life of the process.
    pub fn spawn_cleanup(self: &Arc<Self>) {
        let service = Arc::downgrade(self);
        tokio::spawn(async move {
            // Not at the very start: the server has better things to do.
            tokio::time::sleep(Duration::from_secs(30)).await;
            let mut every = tokio::time::interval(CLEANUP_INTERVAL);
            loop {
                every.tick().await;
                let Some(service) = service.upgrade() else {
                    return;
                };
                service.cleanup().await;
            }
        });
    }

    fn revoke_in_background(&self, tokens: Vec<AccessToken>) {
        if tokens.is_empty() {
            return;
        }
        let api = self.api.clone();
        self.background.spawn(async move {
            revoke_with(&api, tokens).await;
        });
    }

    async fn revoke(&self, tokens: Vec<AccessToken>) {
        revoke_with(&self.api, tokens).await;
    }

    /// Waits for the checks and revocations under way (tests).
    #[cfg(test)]
    pub(crate) async fn settle(&self) {
        self.background.close();
        self.background.wait().await;
        self.background.reopen();
    }
}

/// Marks a session's check as under way while it lives.
struct Checking {
    set: Arc<Mutex<HashSet<i32>>>,
    id: i32,
}

impl Checking {
    fn start(set: &Arc<Mutex<HashSet<i32>>>, id: i32) -> Self {
        set.lock().unwrap().insert(id);
        Self {
            set: Arc::clone(set),
            id,
        }
    }
}

impl Drop for Checking {
    fn drop(&mut self) {
        self.set.lock().unwrap().remove(&self.id);
    }
}

async fn revoke_with(api: &SrnApi, tokens: Vec<AccessToken>) {
    for token in tokens {
        match api.logout(&token).await {
            Ok(()) | Err(SrnError::Unauthorized) => {}
            Err(error) => tracing::info!(
                "[srn-web] SpaceRing did not confirm the end of a connection: {}",
                Problem::from_check(error).code()
            ),
        }
    }
}

fn open_token(key: &SealKey, row: &srn_web_session::Model) -> Option<AccessToken> {
    key.open(Purpose::Token, &row.cookie_hash, &row.token)
        .and_then(|token| AccessToken::parse(&token))
}

fn chinese(locale: Option<AppLocale>) -> bool {
    matches!(locale, Some(AppLocale::ZhCn | AppLocale::ZhTw))
}

/// SpaceRing's Chinese authorization page for a Chinese interface.
fn localized(mut url: url::Url, chinese: bool) -> url::Url {
    if chinese && url.path() == "/authorize/" {
        url.set_path("/zh/authorize/");
    }
    url
}

fn storage_problem(error: &crate::db::error::DbError) -> WebProblem {
    tracing::warn!("[srn-web] the database did not answer: {error}");
    WebProblem::Storage {
        detail: String::new(),
    }
}

fn unavailable_storage(error: crate::db::error::DbError) -> SrnWebAccountState {
    SrnWebAccountState::Unavailable {
        problem: storage_problem(&error).to_app_error(),
    }
}

/// `signedOutLocally`, with `url` and the `reason`'s code (and its numbers).
fn signed_out_locally(url: &str, reason: &WebProblem) -> AppCommandError {
    let shared = match reason {
        WebProblem::Shared(problem) => problem.clone(),
        _ => Problem::Internal {
            detail: String::new(),
        },
    };
    let mut error = Problem::SignedOutLocally {
        url: url.to_string(),
        reason: Box::new(shared),
    }
    .to_app_error();
    if !matches!(reason, WebProblem::Shared(_)) {
        if let Some(params) = error.i18n_params.as_mut() {
            params.insert("reason".into(), reason.code().into());
        }
        error.detail = None;
    }
    error
}

/// A check's problem as the row keeps it.
fn stored_problem(problem: &Problem) -> String {
    match problem {
        Problem::Server { status } => format!("server:{status}"),
        Problem::RateLimited { seconds } => format!("rate_limited:{seconds}"),
        other => other.code().to_string(),
    }
}

fn kept_problem(stored: &str) -> Problem {
    let (code, number) = stored.split_once(':').unwrap_or((stored, ""));
    match code {
        "server" => Problem::Server {
            status: number.parse().unwrap_or(0),
        },
        "rate_limited" => Problem::RateLimited {
            seconds: number.parse().unwrap_or(0),
        },
        "invalid_response" => Problem::InvalidResponse {
            detail: String::new(),
        },
        _ => Problem::Network {
            detail: String::new(),
        },
    }
}

fn identity(row: &srn_web_session::Model) -> SrnIdentity {
    SrnIdentity {
        srn: row.srn as u64,
        name: row.display_name.clone(),
        avatar_path: row.avatar_path.clone(),
    }
}

fn signed_in_state(
    row: &srn_web_session::Model,
    checking: bool,
    live_problem: Option<&Problem>,
) -> SrnWebAccountState {
    let problem = live_problem
        .cloned()
        .or_else(|| row.check_problem.as_deref().map(kept_problem));
    let status = match (&problem, row.last_confirmed_at) {
        (Some(_), _) => OnlineStatus::Unconfirmed,
        (None, Some(_)) => OnlineStatus::Confirmed,
        (None, None) => OnlineStatus::Unchecked,
    };
    SrnWebAccountState::SignedIn {
        account: identity(row),
        online: SrnOnline {
            status,
            checking,
            checked_at: Some(rfc3339(row.last_checked_at)),
            confirmed_at: row.last_confirmed_at.map(rfc3339),
            problem: problem.map(|p| p.to_app_error()),
        },
    }
}
