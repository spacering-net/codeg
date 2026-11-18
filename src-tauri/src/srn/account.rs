//! The desktop's SRN account: one per app ([`AccountService`]).
//!
//! It holds the account — read from the keychain once, at startup — and at
//! most one sign-in in progress, and is the only thing that changes either.
//!
//! **Generations.** Every sign-in has the flow generation current when it
//! started; starting another, cancelling, expiring or finishing moves the
//! generation on. Every check has the account generation current when it
//! started; signing in, signing out, a 401 or reading the keychain again
//! moves that on. Work that finishes late compares its generation with the
//! current one and, if they differ, changes nothing: an older flow's success
//! cannot sign anyone in, and an older check's 401 cannot sign anyone out.
//! Writes to the keychain are serialized ([`AccountService::commit`]), so a
//! late success that has already written its token can still take it back
//! before anything else is written.
//!
//! **The online check.** `/me` at startup, when a window comes to the front
//! and when the network comes back ([`CheckTrigger`]): at most once an hour
//! counted from the last check SpaceRing answered, and — after one that got
//! no answer — not again within a minute when the trigger is a window
//! coming forward, or within ten seconds when it is the network coming back
//! (every window hears that, and a network that comes and goes says it
//! again and again). A check the person asks for is not throttled, but joins
//! one under way and respects SpaceRing's `Retry-After`. Only a 401 clears
//! the sign-in; offline, 5xx and 429 keep the identity, marked unconfirmed
//! with the reason.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use chrono::{DateTime, SecondsFormat, Utc};
use futures::future::{BoxFuture, FutureExt, Shared};
use tokio_util::sync::CancellationToken;

use super::client::{clean_name, CodeExchange, Grant, LoginRequest, SrnApi, SrnUser};
use super::environment::Environment;
use super::error::{Problem, SrnError};
use super::loopback::{self, Callback, Listener};
use super::page::PageLanguage;
use super::pkce::{AccessToken, FlowSecret};
use super::store::{self, SecretStore};
use super::types::{
    CheckTrigger, OnlineStatus, RemoteSignOut, SrnAccountChanged, SrnAccountState, SrnIdentity,
    SrnOnline, SrnSignOutResult,
};

/// How long a sign-in waits for the browser: SpaceRing's login requests
/// last ten minutes.
pub(crate) const FLOW_TTL: Duration = Duration::from_secs(10 * 60);

/// The online check, at most this often.
pub(crate) const CHECK_INTERVAL: Duration = Duration::from_secs(60 * 60);

/// After a check that got no answer, a window coming to the front does not
/// start another sooner than this.
pub(crate) const RETRY_FLOOR: Duration = Duration::from_secs(60);

/// The network coming back does not start a check sooner than this after
/// the last one. Every window sends it, and a check that fails at once
/// (still offline) ends before the other windows' arrive: without a floor,
/// each would start its own.
pub(crate) const ONLINE_FLOOR: Duration = Duration::from_secs(10);

/// How long a sign-out waits for SpaceRing to confirm. The account's buttons
/// wait with it, and the sign-in here is already gone: no answer in time
/// counts as no answer at all.
pub(crate) const LOGOUT_DEADLINE: Duration = Duration::from_secs(5);

/// SpaceRing limits a device name to 80 UTF-16 units.
const MAX_DEVICE_NAME_UNITS: usize = 80;

#[derive(Debug, Clone)]
pub(crate) struct Config {
    pub flow_ttl: Duration,
    pub check_interval: Duration,
    pub retry_floor: Duration,
    pub online_floor: Duration,
    pub logout_deadline: Duration,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            flow_ttl: FLOW_TTL,
            check_interval: CHECK_INTERVAL,
            retry_floor: RETRY_FLOOR,
            online_floor: ONLINE_FLOOR,
            logout_deadline: LOGOUT_DEADLINE,
        }
    }
}

/// What the account does to the world around it.
pub(crate) trait Host: Send + Sync + 'static {
    /// `srn://account-changed`, to every desktop window.
    fn announce(&self, event: &SrnAccountChanged);
    /// Opens `url` in the system browser. The failure carries nothing: an
    /// opener's own text can quote the address, which holds a request ID.
    fn open_url(&self, url: &str) -> Result<(), ()>;
    /// Brings the main window to the front.
    fn bring_to_front(&self);
}

/// Monotonic time, which tests move by hand.
pub(crate) trait Clock: Send + Sync + 'static {
    fn now(&self) -> Instant;
}

pub(crate) struct SystemClock;

impl Clock for SystemClock {
    fn now(&self) -> Instant {
        Instant::now()
    }
}

enum Account {
    /// The keychain has not been read yet.
    Loading,
    SignedOut,
    SignedIn(Box<Session>),
    /// The keychain holds something that could not be read: why.
    Unreadable(Problem),
}

struct Session {
    token: AccessToken,
    user: SrnUser,
    online: Online,
}

struct Online {
    status: OnlineStatus,
    checked_at: Option<DateTime<Utc>>,
    confirmed_at: Option<DateTime<Utc>>,
    problem: Option<Problem>,
}

impl Online {
    fn unchecked() -> Self {
        Self {
            status: OnlineStatus::Unchecked,
            checked_at: None,
            confirmed_at: None,
            problem: None,
        }
    }

    fn confirmed(at: DateTime<Utc>) -> Self {
        Self {
            status: OnlineStatus::Confirmed,
            checked_at: Some(at),
            confirmed_at: Some(at),
            problem: None,
        }
    }

    fn unconfirmed(at: DateTime<Utc>, problem: Problem) -> Self {
        Self {
            status: OnlineStatus::Unconfirmed,
            checked_at: Some(at),
            confirmed_at: None,
            problem: Some(problem),
        }
    }
}

/// The sign-in in progress.
struct Flow {
    generation: u64,
    authorization_url: String,
    expires_at: DateTime<Utc>,
    /// The browser came back with a code; the exchange is under way.
    completing: bool,
    problem: Option<Problem>,
    /// Ends the flow's task and closes its listener.
    stop: CancellationToken,
}

/// The online check's bookkeeping, for the account it was made for.
#[derive(Default)]
struct Checks {
    running: Option<RunningCheck>,
    last_attempt: Option<Instant>,
    /// The last check SpaceRing answered (anything but no answer at all).
    last_answer: Option<Instant>,
    /// SpaceRing's `Retry-After`.
    paused_until: Option<Instant>,
}

struct RunningCheck {
    id: u64,
    done: Shared<BoxFuture<'static, ()>>,
}

struct Inner {
    account: Account,
    account_generation: u64,
    flow: Option<Flow>,
    flow_generation: u64,
    /// What the last sign-in ended with, or why the account was signed out
    /// (`revoked`): shown with `signedOut` and `credentialUnreadable`.
    problem: Option<Problem>,
    /// A sign-in the keychain may still hold although the account is not it.
    leftover: Option<Leftover>,
    checks: Checks,
    next_check: u64,
}

/// A sign-in that ended — cancelled, replaced, refused by `/me`, ended by
/// SpaceRing — after its token was written, and whose removal from the
/// keychain failed. Until it is removed, `signedOut` says so
/// (`keychainCleanup`) and a restart would find it; signing out removes it
/// (and tells SpaceRing, with its token), and a later sign-in writes over it.
struct Leftover {
    token: AccessToken,
    detail: String,
}

impl Inner {
    /// Ends the flow in progress, if any, and moves the flow generation on
    /// either way — which also abandons a sign-in still creating its login
    /// request. Whether there was a flow to end.
    fn invalidate_flow(&mut self) -> bool {
        self.flow_generation += 1;
        match self.flow.take() {
            Some(flow) => {
                flow.stop.cancel();
                true
            }
            None => false,
        }
    }

    /// A new account, with checks of its own.
    fn set_account(&mut self, account: Account) {
        self.account = account;
        self.account_generation += 1;
        self.checks = Checks::default();
    }

    /// After a sign-in removed what it wrote: an unreadable entry it had
    /// written over is gone as well, so the account is signed out. Whether
    /// that changed it.
    fn forget_unreadable(&mut self) -> bool {
        let unreadable = matches!(self.account, Account::Unreadable(_));
        if unreadable {
            self.set_account(Account::SignedOut);
        }
        unreadable
    }

    fn clear_running(&mut self, id: u64) {
        if self.checks.running.as_ref().is_some_and(|r| r.id == id) {
            self.checks.running = None;
        }
    }

    fn session_mut(&mut self) -> Option<&mut Session> {
        match &mut self.account {
            Account::SignedIn(session) => Some(session),
            _ => None,
        }
    }
}

/// What a sign-out found.
enum Had {
    Token(AccessToken),
    Unreadable(Problem),
    /// Signed out, but a [`Leftover`] is still in the keychain.
    Leftover(AccessToken),
    Nothing,
}

pub(crate) struct AccountService {
    env: Environment,
    api: SrnApi,
    store: Arc<dyn SecretStore>,
    host: Arc<dyn Host>,
    clock: Arc<dyn Clock>,
    config: Config,
    inner: Mutex<Inner>,
    /// Held across every change to what the keychain holds, and the change
    /// to the account that goes with it.
    commit: tokio::sync::Mutex<()>,
    loaded: tokio::sync::OnceCell<()>,
    load_started: AtomicBool,
}

impl AccountService {
    pub fn new(
        env: Environment,
        api: SrnApi,
        store: Arc<dyn SecretStore>,
        host: Arc<dyn Host>,
        clock: Arc<dyn Clock>,
        config: Config,
    ) -> Arc<Self> {
        Arc::new(Self {
            env,
            api,
            store,
            host,
            clock,
            config,
            inner: Mutex::new(Inner {
                account: Account::Loading,
                account_generation: 0,
                flow: None,
                flow_generation: 0,
                problem: None,
                leftover: None,
                checks: Checks::default(),
                next_check: 0,
            }),
            commit: tokio::sync::Mutex::new(()),
            loaded: tokio::sync::OnceCell::new(),
            load_started: AtomicBool::new(false),
        })
    }

    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Sends the event for the account as it is now. Called with the state
    /// locked, so that events go out in the order the changes were made.
    fn announce(&self, inner: &Inner) {
        self.host.announce(&event(inner));
    }

    // ─── Reading ────────────────────────────────────────────────────────

    /// The account as it is: `loading` until the keychain has been read,
    /// which this starts if nothing has yet. Never waits.
    pub fn state(self: &Arc<Self>) -> SrnAccountState {
        if !self.load_started.swap(true, Ordering::SeqCst) {
            let this = Arc::clone(self);
            tokio::spawn(async move { this.ensure_loaded().await });
        }
        public_state(&self.lock())
    }

    /// At startup: read the keychain, then check online.
    pub async fn startup(self: &Arc<Self>) {
        self.load_started.store(true, Ordering::SeqCst);
        self.ensure_loaded().await;
        let _ = self.check(CheckTrigger::Foreground).await;
    }

    /// Reads the keychain the first time it is called; later calls wait for
    /// that read.
    async fn ensure_loaded(&self) {
        self.loaded
            .get_or_init(|| async {
                let read = self.store_get().await;
                let account = self.account_from(read);
                let mut inner = self.lock();
                inner.set_account(account);
                self.announce(&inner);
            })
            .await;
    }

    fn account_from(&self, read: Result<Option<String>, String>) -> Account {
        match read {
            Ok(None) => Account::SignedOut,
            Ok(Some(raw)) if !store::kept_for(&raw, &self.env) => {
                tracing::info!(
                    "[srn] the keychain holds a sign-in for another origin or client; \
                     not signed in here"
                );
                Account::SignedOut
            }
            Ok(Some(raw)) => match store::decode(&raw, &self.env.origin) {
                Some((token, user)) => Account::SignedIn(Box::new(Session {
                    token,
                    user,
                    online: Online::unchecked(),
                })),
                None => {
                    tracing::warn!("[srn] the keychain holds a sign-in this Codeg cannot read");
                    Account::Unreadable(Problem::CredentialInvalid)
                }
            },
            Err(detail) => {
                tracing::warn!("[srn] the keychain did not give the sign-in back: {detail}");
                Account::Unreadable(Problem::KeychainRead { detail })
            }
        }
    }

    // ─── Signing in ─────────────────────────────────────────────────────

    /// Starts a sign-in: listens, creates the login request, opens the
    /// browser. Ends any sign-in already in progress. Answers the account
    /// as it is afterwards — `pending`, or whatever replaced it meanwhile.
    pub async fn sign_in(
        self: &Arc<Self>,
        language: PageLanguage,
    ) -> Result<SrnAccountState, Problem> {
        self.ensure_loaded().await;
        let (generation, stop) = {
            let mut inner = self.lock();
            if matches!(inner.account, Account::SignedIn(_)) {
                return Err(Problem::AlreadySignedIn);
            }
            inner.invalidate_flow();
            inner.problem = None;
            (inner.flow_generation, CancellationToken::new())
        };
        let started = self.start_flow(generation, stop.clone(), language).await;
        if let Err(problem) = &started {
            tracing::warn!("[srn] the sign-in could not start: {}", problem.code());
            stop.cancel();
        }
        let inner = self.lock();
        // Also when it failed: a sign-in it replaced is gone.
        self.announce(&inner);
        started.map(|()| public_state(&inner))
    }

    async fn start_flow(
        self: &Arc<Self>,
        generation: u64,
        stop: CancellationToken,
        language: PageLanguage,
    ) -> Result<(), Problem> {
        let internal = |error: rand::Error| Problem::Internal {
            detail: format!("no random bytes: {error}"),
        };
        let state = FlowSecret::generate().map_err(internal)?;
        let verifier = FlowSecret::generate().map_err(internal)?;
        let installation = FlowSecret::generate().map_err(internal)?;
        let listener = loopback::listen(state.clone(), language, &stop)
            .await
            .map_err(|error| Problem::Loopback {
                detail: error.to_string(),
            })?;
        let redirect_uri = listener.redirect_uri();
        let challenge = verifier.challenge();
        let device = device_name();
        let created = self
            .api
            .create_login_request(&LoginRequest {
                client_id: &self.env.client_id,
                redirect_uri: &redirect_uri,
                state: &state,
                code_challenge: &challenge,
                installation_id: installation.expose(),
                platform: std::env::consts::OS,
                device_name: device.as_deref(),
            })
            .await
            .map_err(Problem::from_request)?;
        let url = localized_page(created.authorization_url, language);
        {
            let mut inner = self.lock();
            if inner.flow_generation != generation {
                // Cancelled, or replaced, while the request was made.
                stop.cancel();
                return Ok(());
            }
            let ttl = chrono::Duration::from_std(self.config.flow_ttl).unwrap_or_default();
            inner.flow = Some(Flow {
                generation,
                authorization_url: url.to_string(),
                expires_at: Utc::now() + ttl,
                completing: false,
                problem: None,
                stop: stop.clone(),
            });
        }
        tracing::info!("[srn] sign-in started; waiting for the browser");
        let this = Arc::clone(self);
        tokio::spawn(async move {
            this.run_flow(generation, listener, verifier, redirect_uri, stop)
                .await
        });
        if self.host.open_url(url.as_str()).is_err() {
            tracing::warn!("[srn] the browser could not be opened; the page's link can be copied");
            let mut inner = self.lock();
            if let Some(flow) = inner.flow.as_mut().filter(|f| f.generation == generation) {
                flow.problem = Some(Problem::OpenBrowser);
            }
        }
        Ok(())
    }

    /// Waits for the browser (or the end of the flow), then completes the
    /// sign-in.
    async fn run_flow(
        self: Arc<Self>,
        generation: u64,
        listener: Listener,
        verifier: FlowSecret,
        redirect_uri: String,
        stop: CancellationToken,
    ) {
        let deadline = tokio::time::sleep(self.config.flow_ttl);
        tokio::pin!(deadline);
        let callback = tokio::select! {
            biased;
            () = stop.cancelled() => return,
            received = listener.callback => match received {
                Ok(callback) => callback,
                Err(_) => return,
            },
            () = &mut deadline => {
                if self.finish_flow(generation, Problem::Expired) {
                    tracing::info!("[srn] the sign-in expired");
                }
                return;
            }
        };
        let code = match callback {
            Callback::Declined => {
                if self.finish_flow(generation, Problem::AccessDenied) {
                    tracing::info!("[srn] the connection was declined in the browser");
                    self.host.bring_to_front();
                }
                return;
            }
            Callback::Code(code) => code,
        };
        {
            let mut inner = self.lock();
            match inner.flow.as_mut().filter(|f| f.generation == generation) {
                Some(flow) => flow.completing = true,
                None => return,
            }
            self.announce(&inner);
        }
        // Once, whatever happens to the answer: a code presented again ends
        // the connection it opened.
        let exchanged = self
            .api
            .exchange_code(&CodeExchange {
                client_id: &self.env.client_id,
                redirect_uri: &redirect_uri,
                code: &code,
                verifier: &verifier,
            })
            .await;
        match exchanged {
            Ok(grant) => self.commit_sign_in(generation, grant).await,
            Err(error) => {
                let problem = Problem::from_exchange(error);
                tracing::warn!("[srn] the code exchange failed: {}", problem.code());
                if self.finish_flow(generation, problem) {
                    self.host.bring_to_front();
                }
            }
        }
    }

    /// Ends flow `generation` with `problem`, if it is still the one in
    /// progress. Whether it was.
    fn finish_flow(&self, generation: u64, problem: Problem) -> bool {
        let mut inner = self.lock();
        if inner.flow_generation != generation {
            return false;
        }
        inner.invalidate_flow();
        inner.problem = Some(problem);
        self.announce(&inner);
        true
    }

    fn flow_is(&self, generation: u64) -> bool {
        self.lock().flow_generation == generation
    }

    /// The token is in hand: keep it, confirm it, and sign in — in that
    /// order, each step only if the flow is still the one in progress.
    async fn commit_sign_in(self: &Arc<Self>, generation: u64, grant: Grant) {
        let _commit = self.commit.lock().await;
        if !self.flow_is(generation) {
            self.end_unused(grant.token);
            return;
        }
        if let Err(detail) = self
            .store_set(store::encode(&grant.token, &grant.user, &self.env))
            .await
        {
            tracing::warn!("[srn] the keychain did not keep the sign-in: {detail}");
            if self.finish_flow(generation, Problem::KeychainWrite { detail }) {
                self.host.bring_to_front();
            }
            self.end_unused(grant.token);
            return;
        }
        // Written over: a sign-in left in the keychain before is gone, and its
        // connection, if SpaceRing never heard it end, is ended now.
        let replaced = self.lock().leftover.take();
        if let Some(replaced) = replaced {
            self.end_unused(replaced.token);
        }
        let confirmed = self.api.me(&grant.token).await;
        let now = self.clock.now();
        let at = Utc::now();
        let mut checks = Checks {
            last_attempt: Some(now),
            ..Checks::default()
        };
        let (user, online) = match confirmed {
            Ok(user) if user.srn == grant.user.srn => {
                checks.last_answer = Some(now);
                (user, Online::confirmed(at))
            }
            Ok(_) => {
                tracing::warn!("[srn] /me named another account than the exchange did");
                self.forget_written(&grant.token).await;
                self.lock().forget_unreadable();
                if self.finish_flow(generation, Problem::AccountChanged) {
                    self.host.bring_to_front();
                } else {
                    self.announce_leftover();
                }
                self.end_unused(grant.token);
                return;
            }
            Err(SrnError::Unauthorized) => {
                tracing::warn!("[srn] SpaceRing ended the sign-in before it was confirmed");
                self.forget_written(&grant.token).await;
                self.lock().forget_unreadable();
                if self.finish_flow(generation, Problem::Revoked) {
                    self.host.bring_to_front();
                } else {
                    self.announce_leftover();
                }
                return;
            }
            Err(error) => {
                // Signed in all the same: the exchange itself said who.
                note_answer(&mut checks, &error, now);
                let problem = Problem::from_check(error);
                tracing::info!(
                    "[srn] the sign-in could not be confirmed online: {}",
                    problem.code()
                );
                (grant.user.clone(), Online::unconfirmed(at, problem))
            }
        };
        if user != grant.user {
            if let Err(detail) = self
                .store_set_if_holds(&grant.token, store::encode(&grant.token, &user, &self.env))
                .await
            {
                tracing::warn!("[srn] the keychain did not take the confirmed name: {detail}");
            }
        }
        // The token, when the flow ended while it completed.
        let abandoned = {
            let mut inner = self.lock();
            if inner.flow_generation != generation {
                Some(grant.token)
            } else {
                inner.invalidate_flow();
                inner.set_account(Account::SignedIn(Box::new(Session {
                    token: grant.token,
                    user,
                    online,
                })));
                inner.checks = checks;
                inner.problem = None;
                self.announce(&inner);
                None
            }
        };
        match abandoned {
            None => {
                tracing::info!("[srn] signed in");
                self.host.bring_to_front();
            }
            Some(token) => {
                // Cancelled or replaced while it completed: what it wrote
                // goes, and so does the connection. Nothing else was written
                // since (the commit lock is held), so what is removed is its
                // own — and an unreadable entry it replaced is gone too.
                self.forget_written(&token).await;
                {
                    let mut inner = self.lock();
                    if inner.forget_unreadable() || inner.leftover.is_some() {
                        self.announce(&inner);
                    }
                }
                self.end_unused(token);
            }
        }
    }

    /// Removes what a sign-in that will not happen wrote (the commit lock is
    /// held), unless another Codeg has written over it since. If the keychain
    /// will not let go, it is a [`Leftover`]: kept in mind, shown, and
    /// removed by the next sign-out.
    async fn forget_written(&self, token: &AccessToken) {
        if let Err(detail) = self.store_delete_if_holds(token).await {
            tracing::warn!("[srn] the keychain did not remove an abandoned sign-in: {detail}");
            self.lock().leftover = Some(Leftover {
                token: token.clone(),
                detail,
            });
        }
    }

    /// Tells the windows about a [`Leftover`] that a flow which had already
    /// ended (so announced nothing) just left.
    fn announce_leftover(&self) {
        let inner = self.lock();
        if inner.leftover.is_some() {
            self.announce(&inner);
        }
    }

    /// Ends, on SpaceRing, a connection that will not be used. In the
    /// background: nothing waits for it, and nothing depends on it.
    fn end_unused(&self, token: AccessToken) {
        let api = self.api.clone();
        tokio::spawn(async move {
            if let Err(error) = api.logout(&token).await {
                tracing::info!(
                    "[srn] SpaceRing did not confirm the end of an unused connection: {}",
                    Problem::from_check(error).code()
                );
            }
        });
    }

    /// Opens the authorization page again.
    pub fn reopen(&self) -> Result<SrnAccountState, Problem> {
        let (generation, url) = {
            let inner = self.lock();
            let flow = inner.flow.as_ref().ok_or(Problem::NoPendingSignIn)?;
            (flow.generation, flow.authorization_url.clone())
        };
        let opened = self.host.open_url(&url);
        let mut inner = self.lock();
        let problem = opened.is_err().then_some(Problem::OpenBrowser);
        let changed = match inner.flow.as_mut().filter(|f| f.generation == generation) {
            Some(flow) if flow.problem != problem => {
                flow.problem = problem;
                true
            }
            _ => false,
        };
        if changed {
            self.announce(&inner);
        }
        opened.map_err(|()| Problem::OpenBrowser)?;
        Ok(public_state(&inner))
    }

    /// Ends the sign-in in progress, if any.
    pub fn cancel(&self) -> SrnAccountState {
        let mut inner = self.lock();
        if inner.invalidate_flow() {
            tracing::info!("[srn] sign-in canceled");
            self.announce(&inner);
        }
        public_state(&inner)
    }

    // ─── Checking ───────────────────────────────────────────────────────

    /// The online check, if `trigger` makes one due. Answers the account as
    /// it is afterwards. Fails only for a check the person asked for while
    /// SpaceRing's `Retry-After` has not passed (`rateLimited`).
    pub async fn check(
        self: &Arc<Self>,
        trigger: CheckTrigger,
    ) -> Result<SrnAccountState, Problem> {
        self.ensure_loaded().await;
        // Twice at most: a keychain read again on request, then its check.
        for _ in 0..2 {
            enum Next {
                Done,
                Wait(Shared<BoxFuture<'static, ()>>),
                ReadAgain,
            }
            let next = {
                let mut inner = self.lock();
                let now = self.clock.now();
                let signed_in = matches!(inner.account, Account::SignedIn(_));
                let unreadable = matches!(inner.account, Account::Unreadable(_));
                if inner.flow.is_some() {
                    Next::Done
                } else if unreadable {
                    if trigger == CheckTrigger::User {
                        Next::ReadAgain
                    } else {
                        Next::Done
                    }
                } else if !signed_in {
                    Next::Done
                } else if let Some(running) = &inner.checks.running {
                    Next::Wait(running.done.clone())
                } else if let Some(seconds) = paused_for(&inner.checks, now) {
                    if trigger == CheckTrigger::User {
                        return Err(Problem::RateLimited { seconds });
                    }
                    Next::Done
                } else if self.due(&inner.checks, trigger, now) {
                    Next::Wait(self.start_check(&mut inner))
                } else {
                    Next::Done
                }
            };
            match next {
                Next::Done => break,
                Next::Wait(done) => {
                    done.await;
                    break;
                }
                Next::ReadAgain => {
                    if !self.read_again().await {
                        break;
                    }
                }
            }
        }
        Ok(public_state(&self.lock()))
    }

    fn due(&self, checks: &Checks, trigger: CheckTrigger, now: Instant) -> bool {
        let within = |at: Option<Instant>, span: Duration| {
            at.is_some_and(|at| now.saturating_duration_since(at) < span)
        };
        let answered_lately = within(checks.last_answer, self.config.check_interval);
        let tried_lately = within(checks.last_attempt, self.config.retry_floor);
        let tried_just_now = within(checks.last_attempt, self.config.online_floor);
        match trigger {
            CheckTrigger::User => true,
            CheckTrigger::Online => !answered_lately && !tried_just_now,
            CheckTrigger::Foreground => !answered_lately && !tried_lately,
        }
    }

    /// Starts the check for the account signed in now. Its result is kept
    /// only if the account is still this one when it comes.
    fn start_check(self: &Arc<Self>, inner: &mut Inner) -> Shared<BoxFuture<'static, ()>> {
        let generation = inner.account_generation;
        let token = inner
            .session_mut()
            .map(|session| session.token.clone())
            .expect("a check starts for a signed-in account");
        inner.next_check += 1;
        let id = inner.next_check;
        let this = Arc::clone(self);
        let task = tokio::spawn(async move { this.finish_check(id, generation, token).await });
        // A check that ended without saying so (its task gone) must not hold
        // the place of the next one. Weak: the account keeps this future.
        let account = Arc::downgrade(self);
        let done = async move {
            let _ = task.await;
            if let Some(account) = account.upgrade() {
                account.lock().clear_running(id);
            }
        }
        .boxed()
        .shared();
        inner.checks.running = Some(RunningCheck {
            id,
            done: done.clone(),
        });
        done
    }

    async fn finish_check(self: Arc<Self>, id: u64, generation: u64, token: AccessToken) {
        let result = self.api.me(&token).await;
        if result == Err(SrnError::Unauthorized) {
            self.clear_revoked(id, generation).await;
            return;
        }
        let now = self.clock.now();
        let at = Utc::now();
        let renamed = {
            let mut inner = self.lock();
            inner.clear_running(id);
            if inner.account_generation != generation {
                return;
            }
            inner.checks.last_attempt = Some(now);
            let renamed = match result {
                Ok(user) => {
                    inner.checks.last_answer = Some(now);
                    let session = inner.session_mut().expect("the account checked");
                    session.online = Online::confirmed(at);
                    (session.user != user).then(|| {
                        session.user = user.clone();
                        (session.token.clone(), user)
                    })
                }
                Err(error) => {
                    note_answer(&mut inner.checks, &error, now);
                    let problem = Problem::from_check(error);
                    tracing::info!(
                        "[srn] the online check could not confirm the account: {}",
                        problem.code()
                    );
                    let session = inner.session_mut().expect("the account checked");
                    let confirmed_at = session.online.confirmed_at;
                    session.online = Online::unconfirmed(at, problem);
                    session.online.confirmed_at = confirmed_at;
                    None
                }
            };
            self.announce(&inner);
            renamed
        };
        if let Some((token, user)) = renamed {
            // The name or the picture changed on SpaceRing: the keychain's
            // copy follows, for the next start.
            let _commit = self.commit.lock().await;
            if self.lock().account_generation == generation {
                if let Err(detail) = self
                    .store_set_if_holds(&token, store::encode(&token, &user, &self.env))
                    .await
                {
                    tracing::warn!("[srn] the keychain did not take the new name: {detail}");
                }
            }
        }
    }

    /// SpaceRing answered 401: the connection has ended, so the sign-in
    /// here ends too, and its token leaves the keychain.
    async fn clear_revoked(&self, id: u64, generation: u64) {
        let _commit = self.commit.lock().await;
        {
            let mut inner = self.lock();
            if inner.account_generation != generation {
                inner.clear_running(id);
                return;
            }
        }
        tracing::info!("[srn] SpaceRing ended the sign-in; signing out here");
        let ended = self
            .lock()
            .session_mut()
            .map(|session| session.token.clone());
        let deleted = match &ended {
            Some(token) => self.store_delete_if_holds(token).await,
            None => Ok(()),
        };
        let mut inner = self.lock();
        inner.clear_running(id);
        if inner.account_generation != generation {
            return;
        }
        if let Err(detail) = deleted {
            // The token is dead, but still in the keychain: a sign-out
            // removes it.
            tracing::warn!("[srn] the keychain did not remove the ended sign-in: {detail}");
            if let Some(session) = inner.session_mut() {
                let token = session.token.clone();
                inner.leftover = Some(Leftover { token, detail });
            }
        }
        inner.set_account(Account::SignedOut);
        inner.problem = Some(Problem::Revoked);
        self.announce(&inner);
    }

    /// The keychain read again, for an account it could not be read for.
    /// Whether a sign-in came of it.
    async fn read_again(&self) -> bool {
        let _commit = self.commit.lock().await;
        let generation = {
            let inner = self.lock();
            if !matches!(inner.account, Account::Unreadable(_)) || inner.flow.is_some() {
                return false;
            }
            inner.account_generation
        };
        let account = self.account_from(self.store_get().await);
        let signed_in = matches!(account, Account::SignedIn(_));
        let mut inner = self.lock();
        if inner.account_generation != generation || inner.flow.is_some() {
            return false;
        }
        inner.set_account(account);
        inner.problem = None;
        self.announce(&inner);
        signed_in
    }

    // ─── Signing out ────────────────────────────────────────────────────

    /// Signs out: the token leaves the keychain first — if it cannot,
    /// nothing is signed out — and then SpaceRing is told. `expected_srn`,
    /// when given, is the account the person saw: another one signed in is
    /// `accountChanged`, and nothing happens.
    pub async fn sign_out(
        &self,
        expected_srn: Option<u64>,
        language: PageLanguage,
    ) -> Result<SrnSignOutResult, Problem> {
        self.ensure_loaded().await;
        let commit = self.commit.lock().await;
        let had = {
            let mut inner = self.lock();
            let had = match &inner.account {
                Account::SignedIn(session) => {
                    if expected_srn.is_some_and(|srn| srn != session.user.srn) {
                        return Err(Problem::AccountChanged);
                    }
                    Had::Token(session.token.clone())
                }
                Account::Unreadable(problem) => {
                    if expected_srn.is_some() {
                        return Err(Problem::AccountChanged);
                    }
                    Had::Unreadable(problem.clone())
                }
                Account::SignedOut | Account::Loading => match &inner.leftover {
                    Some(leftover) => Had::Leftover(leftover.token.clone()),
                    None => Had::Nothing,
                },
            };
            // A sign-in in progress ends with it.
            if inner.invalidate_flow() {
                self.announce(&inner);
            }
            had
        };
        let removed = match &had {
            Had::Nothing => Ok(()),
            Had::Token(token) | Had::Leftover(token) => self.store_delete_if_holds(token).await,
            Had::Unreadable(_) => self.store_delete_unless_foreign().await,
        };
        if let Err(detail) = removed {
            tracing::warn!("[srn] the keychain did not remove the sign-in: {detail}");
            return Err(Problem::KeychainDelete { detail });
        }
        let state = {
            let mut inner = self.lock();
            // The entry is gone, a leftover's with it.
            let leftover = inner.leftover.take();
            inner.set_account(Account::SignedOut);
            inner.problem = None;
            self.announce(&inner);
            if let (Some(leftover), Had::Token(_) | Had::Unreadable(_)) = (leftover, &had) {
                self.end_unused(leftover.token);
            }
            public_state(&inner)
        };
        drop(commit);
        let url = self.manage_connections_url(language);
        let unconfirmed = |reason: Problem| {
            tracing::info!(
                "[srn] signed out here; SpaceRing did not confirm: {}",
                reason.code()
            );
            SrnSignOutResult {
                state: state.clone(),
                remote: RemoteSignOut::Unconfirmed,
                manage_connections_url: Some(url.clone()),
                problem: Some(
                    Problem::SignedOutLocally {
                        url: url.clone(),
                        reason: Box::new(reason),
                    }
                    .to_app_error(),
                ),
            }
        };
        let confirmed = |remote: RemoteSignOut| SrnSignOutResult {
            state: state.clone(),
            remote,
            manage_connections_url: None,
            problem: None,
        };
        Ok(match had {
            Had::Nothing => confirmed(RemoteSignOut::NotSignedIn),
            Had::Unreadable(problem) => unconfirmed(problem),
            Had::Token(token) | Had::Leftover(token) => {
                match tokio::time::timeout(self.config.logout_deadline, self.api.logout(&token))
                    .await
                    .unwrap_or_else(|_| Err(SrnError::Network("SRN did not answer in time".into())))
                {
                    // A token SpaceRing does not accept is one whose connection
                    // is over: what signing out asks for.
                    Ok(()) | Err(SrnError::Unauthorized) => {
                        tracing::info!("[srn] signed out");
                        confirmed(RemoteSignOut::Confirmed)
                    }
                    Err(error) => unconfirmed(Problem::from_check(error)),
                }
            }
        })
    }

    /// Where the website lists the connections: `/console/clients/`, or
    /// `/zh/console/clients/` for a Chinese interface.
    pub fn manage_connections_url(&self, language: PageLanguage) -> String {
        let path = if language.is_chinese() {
            "/zh/console/clients/"
        } else {
            "/console/clients/"
        };
        format!("{}{path}", self.env.origin.as_str())
    }

    /// The website console's front page: `/console/`, or `/zh/console/` for
    /// a Chinese interface.
    pub fn console_url(&self, language: PageLanguage) -> String {
        let path = if language.is_chinese() {
            "/zh/console/"
        } else {
            "/console/"
        };
        format!("{}{path}", self.env.origin.as_str())
    }

    // ─── The keychain, off the async threads ────────────────────────────

    async fn store_get(&self) -> Result<Option<String>, String> {
        let store = Arc::clone(&self.store);
        let name = self.env.secret_name.clone();
        tokio::task::spawn_blocking(move || store.get(&name))
            .await
            .unwrap_or_else(|error| Err(format!("the keychain task did not run: {error}")))
    }

    async fn store_set(&self, value: String) -> Result<(), String> {
        let store = Arc::clone(&self.store);
        let name = self.env.secret_name.clone();
        tokio::task::spawn_blocking(move || store.set(&name, &value))
            .await
            .unwrap_or_else(|error| Err(format!("the keychain task did not run: {error}")))
    }

    async fn store_delete(&self) -> Result<(), String> {
        let store = Arc::clone(&self.store);
        let name = self.env.secret_name.clone();
        tokio::task::spawn_blocking(move || store.delete(&name))
            .await
            .unwrap_or_else(|error| Err(format!("the keychain task did not run: {error}")))
    }

    // Every development build shares one entry, and another Codeg may have
    // written over it since this one last read it (the commit lock is this
    // process's only). So what changes or removes a sign-in reads the entry
    // again first and touches it only while it is still this one's. A
    // keychain has no compare-and-swap; the read narrows the window to the
    // two calls.

    /// What the entry holds now, for this environment.
    async fn store_held(&self) -> Result<Held, String> {
        Ok(match self.store_get().await? {
            None => Held::Nothing,
            Some(raw) if !store::kept_for(&raw, &self.env) => Held::Foreign,
            Some(raw) => match store::decode(&raw, &self.env.origin) {
                Some((token, _)) => Held::Token(token),
                None => Held::Unreadable,
            },
        })
    }

    /// Removes the entry if it still holds `token`; anything else there is
    /// left alone, and that is not a failure.
    async fn store_delete_if_holds(&self, token: &AccessToken) -> Result<(), String> {
        match self.store_held().await? {
            Held::Token(held) if held == *token => self.store_delete().await,
            _ => Ok(()),
        }
    }

    /// Writes `value`, a record for `token`, if the entry still holds
    /// `token`.
    async fn store_set_if_holds(&self, token: &AccessToken, value: String) -> Result<(), String> {
        match self.store_held().await? {
            Held::Token(held) if held == *token => self.store_set(value).await,
            _ => Ok(()),
        }
    }

    /// Removes the entry unless it is another environment's sign-in: what a
    /// sign-out of an unreadable sign-in clears, which has no token to
    /// compare.
    async fn store_delete_unless_foreign(&self) -> Result<(), String> {
        match self.store_held().await? {
            Held::Nothing | Held::Foreign => Ok(()),
            Held::Token(_) | Held::Unreadable => self.store_delete().await,
        }
    }
}

/// What the keychain's entry holds, read again for a change to it.
enum Held {
    Nothing,
    /// A sign-in of this environment's, and its token.
    Token(AccessToken),
    /// Something that is not a record, or not one this Codeg can read.
    Unreadable,
    /// Another environment's sign-in (`store::kept_for`).
    Foreign,
}

/// What an error says about when to ask again: an answer counts for the
/// hourly throttle, and a 429 pauses for its `Retry-After`.
fn note_answer(checks: &mut Checks, error: &SrnError, now: Instant) {
    if error.is_answer() {
        checks.last_answer = Some(now);
    }
    if let SrnError::RateLimited { seconds } = error {
        checks.paused_until = Some(now + Duration::from_secs(*seconds));
    }
}

/// Whole seconds left of SpaceRing's pause, rounded up; `None` when there is
/// none.
fn paused_for(checks: &Checks, now: Instant) -> Option<u64> {
    let left = checks.paused_until?.checked_duration_since(now)?;
    if left.is_zero() {
        return None;
    }
    Some(left.as_secs() + u64::from(left.subsec_nanos() > 0))
}

fn rfc3339(at: DateTime<Utc>) -> String {
    at.to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn identity(user: &SrnUser) -> SrnIdentity {
    SrnIdentity {
        srn: user.srn,
        name: user.name.clone(),
        avatar_path: user.avatar_path.clone(),
    }
}

fn public_state(inner: &Inner) -> SrnAccountState {
    if let Some(flow) = &inner.flow {
        return SrnAccountState::Pending {
            authorization_url: flow.authorization_url.clone(),
            expires_at: rfc3339(flow.expires_at),
            completing: flow.completing,
            problem: flow.problem.as_ref().map(Problem::to_app_error),
        };
    }
    match &inner.account {
        Account::Loading => SrnAccountState::Loading,
        Account::SignedOut => SrnAccountState::SignedOut {
            problem: match &inner.leftover {
                Some(leftover) => Some(
                    Problem::KeychainCleanup {
                        detail: leftover.detail.clone(),
                    }
                    .to_app_error(),
                ),
                None => inner.problem.as_ref().map(Problem::to_app_error),
            },
        },
        Account::SignedIn(session) => SrnAccountState::SignedIn {
            account: identity(&session.user),
            online: SrnOnline {
                status: session.online.status,
                checking: inner.checks.running.is_some(),
                checked_at: session.online.checked_at.map(rfc3339),
                confirmed_at: session.online.confirmed_at.map(rfc3339),
                problem: session.online.problem.as_ref().map(Problem::to_app_error),
            },
        },
        Account::Unreadable(read) => SrnAccountState::CredentialUnreadable {
            problem: inner.problem.as_ref().unwrap_or(read).to_app_error(),
        },
    }
}

/// The event's payload: the status, and who when signed in.
fn event(inner: &Inner) -> SrnAccountChanged {
    let (status, account) = if inner.flow.is_some() {
        ("pending", None)
    } else {
        match &inner.account {
            Account::Loading => ("loading", None),
            Account::SignedOut => ("signedOut", None),
            Account::SignedIn(session) => ("signedIn", Some(identity(&session.user))),
            Account::Unreadable(_) => ("credentialUnreadable", None),
        }
    };
    SrnAccountChanged { status, account }
}

/// SpaceRing's Chinese authorization page for a Chinese interface. The page
/// reads the request from the fragment wherever it is served, and
/// `/zh/authorize/` is one of its two entries.
fn localized_page(mut url: url::Url, language: PageLanguage) -> url::Url {
    if language.is_chinese() && url.path() == "/authorize/" {
        url.set_path("/zh/authorize/");
    }
    url
}

/// The computer's name, as SpaceRing's list of connections shows it — the
/// one way to tell this computer's connection from another's. The name
/// config sync labels snapshots with, cleaned as a display name, without a
/// `.local` suffix, within SpaceRing's 80 UTF-16 units; none if there is
/// none.
fn device_name() -> Option<String> {
    let raw = crate::commands::config_sync::snapshot::source_device();
    (raw != "unknown")
        .then_some(raw)
        .and_then(|raw| clean_device_name(&raw))
}

fn clean_device_name(raw: &str) -> Option<String> {
    let name = clean_name(raw);
    let name = name.strip_suffix(".local").unwrap_or(&name);
    let mut kept = String::new();
    let mut units = 0;
    for ch in name.chars() {
        units += ch.len_utf16();
        if units > MAX_DEVICE_NAME_UNITS {
            break;
        }
        kept.push(ch);
    }
    let kept = kept.trim().to_string();
    (!kept.is_empty()).then_some(kept)
}

#[cfg(test)]
mod unit_tests {
    use super::*;

    #[test]
    fn a_device_name_is_what_spacering_takes() {
        assert_eq!(
            clean_device_name("Adas-MacBook-Pro.local").as_deref(),
            Some("Adas-MacBook-Pro")
        );
        assert_eq!(
            clean_device_name("  build-box  ").as_deref(),
            Some("build-box")
        );
        assert_eq!(
            clean_device_name("a\u{202E}b\u{0007}c").as_deref(),
            Some("ab c")
        );
        assert_eq!(clean_device_name(""), None);
        assert_eq!(clean_device_name(" \u{200B} "), None);
        let long = clean_device_name(&"名".repeat(200)).unwrap();
        assert_eq!(long.encode_utf16().count(), 80);
        let emoji = clean_device_name(&"😀".repeat(50)).unwrap();
        assert!(emoji.encode_utf16().count() <= 80);
    }

    #[test]
    fn a_chinese_interface_opens_the_chinese_page() {
        let url = url::Url::parse("https://spacering.net/authorize/#request_id=abc").unwrap();
        assert_eq!(
            localized_page(url.clone(), PageLanguage::SimplifiedChinese).as_str(),
            "https://spacering.net/zh/authorize/#request_id=abc"
        );
        assert_eq!(
            localized_page(url.clone(), PageLanguage::TraditionalChinese).as_str(),
            "https://spacering.net/zh/authorize/#request_id=abc"
        );
        assert_eq!(localized_page(url.clone(), PageLanguage::English), url);
        let other = url::Url::parse("https://spacering.net/other/#request_id=abc").unwrap();
        assert_eq!(
            localized_page(other.clone(), PageLanguage::SimplifiedChinese),
            other
        );
    }

    #[test]
    fn a_pause_is_whole_seconds_rounded_up() {
        let now = Instant::now();
        let mut checks = Checks::default();
        assert_eq!(paused_for(&checks, now), None);
        checks.paused_until = Some(now + Duration::from_millis(1500));
        assert_eq!(paused_for(&checks, now), Some(2));
        assert_eq!(paused_for(&checks, now + Duration::from_secs(2)), None);
    }
}
