//! The desktop account against a stand-in for SpaceRing (`test_support`), a
//! keychain in memory, a host that records what it was asked to do and a
//! clock moved by hand. No network beyond loopback, no real keychain, no
//! home directory.

use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use super::account::{AccountService, Clock, Config, Host};
use super::client::{SrnApi, SrnUser};
use super::environment::Environment;
use super::error::Problem;
use super::page::PageLanguage;
use super::pkce::{AccessToken, FlowSecret};
use super::store::{self, memory::MemoryStore};
use super::test_support::{
    raw_get, wait_closed, MockSrn, RawResponse, Reply, AVATAR_PATH, USER_SRN,
};
use super::types::{CheckTrigger, SrnAccountChanged, SrnAccountState};
use crate::harness::origin::Origin;

const LOGIN: &str = "/api/client/v1/login-requests";
const TOKEN: &str = "/api/client/v1/token";
const ME: &str = "/api/client/v1/me";
const LOGOUT: &str = "/api/client/v1/logout";
const SECRET: &str = "srn-token-test";

// ─── The rig ────────────────────────────────────────────────────────────

#[derive(Default)]
struct FakeHost {
    events: Mutex<Vec<SrnAccountChanged>>,
    opened: Mutex<Vec<String>>,
    fronts: AtomicUsize,
    fail_open: AtomicBool,
    journal: Arc<Mutex<Vec<String>>>,
}

impl Host for FakeHost {
    fn announce(&self, event: &SrnAccountChanged) {
        self.journal
            .lock()
            .unwrap()
            .push(format!("event {}", event.status));
        self.events.lock().unwrap().push(event.clone());
    }

    fn open_url(&self, url: &str) -> Result<(), ()> {
        if self.fail_open.load(Ordering::SeqCst) {
            return Err(());
        }
        self.opened.lock().unwrap().push(url.to_string());
        Ok(())
    }

    fn bring_to_front(&self) {
        self.journal.lock().unwrap().push("front".into());
        self.fronts.fetch_add(1, Ordering::SeqCst);
    }
}

struct ManualClock {
    base: Instant,
    offset: Mutex<Duration>,
}

impl Clock for ManualClock {
    fn now(&self) -> Instant {
        self.base + *self.offset.lock().unwrap()
    }
}

impl ManualClock {
    fn advance(&self, by: Duration) {
        *self.offset.lock().unwrap() += by;
    }
}

struct Rig {
    srn: MockSrn,
    store: Arc<MemoryStore>,
    host: Arc<FakeHost>,
    clock: Arc<ManualClock>,
    account: Arc<AccountService>,
    journal: Arc<Mutex<Vec<String>>>,
}

async fn rig() -> Rig {
    rig_with(Config::default()).await
}

async fn rig_with(config: Config) -> Rig {
    let journal: Arc<Mutex<Vec<String>>> = Arc::default();
    let srn = MockSrn::start_with_journal(journal.clone()).await;
    let store = Arc::new(MemoryStore::with_journal(journal.clone()));
    let host = Arc::new(FakeHost {
        journal: journal.clone(),
        ..FakeHost::default()
    });
    let clock = Arc::new(ManualClock {
        base: Instant::now(),
        offset: Mutex::new(Duration::ZERO),
    });
    let env = Environment {
        origin: srn.origin().clone(),
        client_id: "codeg-desktop-test".into(),
        secret_name: SECRET.into(),
    };
    // A short deadline: an answer that never comes is a two-second wait.
    let api = SrnApi::with_timeout(srn.origin().clone(), Duration::from_secs(2));
    let account = AccountService::new(env, api, store.clone(), host.clone(), clock.clone(), config);
    Rig {
        srn,
        store,
        host,
        clock,
        account,
        journal,
    }
}

impl Rig {
    fn state(&self) -> Value {
        json(&self.account.state())
    }

    /// A sign-in another development Codeg, talking to another origin, wrote
    /// into the entry they share.
    fn foreign_record(&self) -> String {
        store::encode(
            &AccessToken::parse(&"f".repeat(43)).unwrap(),
            &SrnUser {
                srn: USER_SRN + 1,
                name: "Grace Hopper".into(),
                avatar_path: None,
            },
            &Environment {
                origin: Origin::parse("http://127.0.0.1:4321").unwrap(),
                client_id: "codeg-desktop-test".into(),
                secret_name: SECRET.into(),
            },
        )
    }

    /// The environment the service was made with.
    fn env(&self) -> Environment {
        Environment {
            origin: self.srn.origin().clone(),
            client_id: "codeg-desktop-test".into(),
            secret_name: SECRET.into(),
        }
    }

    /// A sign-in from before: a token SpaceRing issued, in the keychain.
    fn seed(&self) -> String {
        let token = self.srn.issue_token();
        self.store.put(
            SECRET,
            &store::encode(
                &AccessToken::parse(&token).unwrap(),
                &SrnUser {
                    srn: USER_SRN,
                    name: "Ada Lovelace".into(),
                    avatar_path: Some(AVATAR_PATH.into()),
                },
                &self.env(),
            ),
        );
        token
    }

    /// The token the keychain holds.
    fn kept_token(&self) -> Option<String> {
        let raw = self.store.value(SECRET)?;
        let (token, _) = store::decode(&raw, self.srn.origin())?;
        Some(token.expose().to_string())
    }

    /// The person approves the `index`-th sign-in in the browser, which goes
    /// back to Codeg.
    async fn approve(&self, index: usize) -> RawResponse {
        let (port, target) = self.srn.approve_nth(index);
        raw_get(port, &target, Some(&format!("127.0.0.1:{port}")))
            .await
            .expect("the listener answers")
    }

    /// A whole sign-in.
    async fn sign_in(&self) {
        self.account.sign_in(PageLanguage::English).await.unwrap();
        let index = self.srn.logins().len() - 1;
        assert_eq!(self.approve(index).await.status, 200);
        self.until_status("signedIn").await;
    }

    /// The loopback port the `index`-th sign-in listens on.
    fn port(&self, index: usize) -> u16 {
        let redirect = self.srn.logins()[index]["redirect_uri"]
            .as_str()
            .unwrap()
            .to_string();
        url::Url::parse(&redirect).unwrap().port().unwrap()
    }

    async fn until_status(&self, status: &str) -> Value {
        self.until_state(status, |state| state["status"] == status)
            .await
    }

    async fn until_state(&self, what: &str, test: impl Fn(&Value) -> bool) -> Value {
        for _ in 0..1000 {
            let state = self.state();
            if test(&state) {
                return state;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("never {what}: {}", self.state());
    }

    fn count(&self, what: &str) -> usize {
        self.journal
            .lock()
            .unwrap()
            .iter()
            .filter(|entry| *entry == what)
            .count()
    }

    fn position(&self, what: &str) -> usize {
        let journal = self.journal.lock().unwrap();
        journal
            .iter()
            .position(|entry| entry == what)
            .unwrap_or_else(|| panic!("no {what} in {journal:?}"))
    }

    /// Everything secret that went by: tokens and codes SpaceRing issued,
    /// request IDs, and the states and verifiers Codeg sent.
    fn secrets(&self) -> Vec<String> {
        let mut secrets = self.srn.issued();
        secrets.extend(self.srn.request_ids());
        secrets.extend(self.srn.verifiers_seen());
        for login in self.srn.logins() {
            secrets.push(login["state"].as_str().unwrap().to_string());
        }
        assert!(secrets.iter().all(|s| s.len() == 43), "{secrets:?}");
        secrets
    }
}

fn json(state: &SrnAccountState) -> Value {
    serde_json::to_value(state).unwrap()
}

async fn until(what: &str, test: impl Fn() -> bool) {
    for _ in 0..1000 {
        if test() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("never {what}");
}

fn key_of(value: &Value) -> &str {
    value["i18n_key"].as_str().unwrap_or("")
}

// ─── Signing in ─────────────────────────────────────────────────────────

#[tokio::test]
async fn a_sign_in_keeps_the_token_confirms_it_and_then_says_so() {
    let rig = rig().await;
    rig.account.startup().await;
    assert_eq!(rig.state()["status"], "signedOut");
    assert_eq!(rig.srn.count(ME), 0, "nothing to check");

    let pending = json(&rig.account.sign_in(PageLanguage::English).await.unwrap());
    assert_eq!(pending["status"], "pending");
    assert_eq!(pending["completing"], false);
    let url = format!(
        "{}/authorize/#request_id={}",
        rig.srn.origin().as_str(),
        rig.srn.request_ids()[0]
    );
    assert_eq!(pending["authorizationUrl"], url);
    assert!(pending["expiresAt"].is_string());
    assert_eq!(*rig.host.opened.lock().unwrap(), vec![url]);

    let login = &rig.srn.logins()[0];
    assert_eq!(login["client_id"], "codeg-desktop-test");
    let port = rig.port(0);
    assert!(port >= 1024);
    assert_eq!(
        login["redirect_uri"],
        format!("http://127.0.0.1:{port}/auth/callback")
    );
    assert!(login["installation_id"]
        .as_str()
        .is_some_and(|id| id.len() >= 16));

    let page = rig.approve(0).await;
    assert_eq!(page.status, 200);
    assert!(page.body.contains("Return to Codeg"), "{}", page.body);

    let state = rig.until_status("signedIn").await;
    assert_eq!(
        state["account"],
        json!({ "srn": USER_SRN, "name": "Ada Lovelace", "avatarPath": AVATAR_PATH })
    );
    assert_eq!(state["online"]["status"], "confirmed");
    assert!(state["online"]["confirmedAt"].is_string());

    // the token SpaceRing issued is the one the keychain holds
    let tokens = rig.srn.tokens();
    assert_eq!(tokens.len(), 1);
    assert_eq!(rig.kept_token().as_deref(), Some(tokens[0].as_str()));

    // in this order: exchange, keychain, /me, then the event and the window
    assert!(rig.position("srn token") < rig.position("store set"));
    assert!(rig.position("store set") < rig.position("srn me"));
    assert!(rig.position("srn me") < rig.position("event signedIn"));
    assert!(rig.position("event signedIn") < rig.position("front"));
    assert_eq!(rig.host.fronts.load(Ordering::SeqCst), 1);
    assert_eq!(rig.srn.count(TOKEN), 1);
}

#[tokio::test]
async fn only_the_right_callback_completes_the_sign_in() {
    let rig = rig().await;
    rig.account.startup().await;
    rig.account.sign_in(PageLanguage::English).await.unwrap();
    let state = rig.srn.logins()[0]["state"].as_str().unwrap().to_string();
    let (port, good) = rig.srn.approve_nth(0);
    let host = format!("127.0.0.1:{port}");
    let code = url::form_urlencoded::parse(good.split_once('?').unwrap().1.as_bytes())
        .find(|(name, _)| name == "code")
        .unwrap()
        .1
        .into_owned();
    let other_state = FlowSecret::generate().unwrap();
    let bad = [
        (good.clone(), format!("localhost:{port}")),
        (good.clone(), format!("127.0.0.1:{}", port.wrapping_add(1))),
        (format!("{good}&extra=1"), host.clone()),
        (format!("/auth/callback?code={code}"), host.clone()),
        (format!("/auth/callback?state={state}"), host.clone()),
        (
            format!("/auth/callback?code={code}&state={}", other_state.expose()),
            host.clone(),
        ),
        (
            format!("/auth/callback?error=server_error&state={state}"),
            host.clone(),
        ),
        (
            format!("/auth/callback?error=access_denied&error_description=x&state={state}"),
            host.clone(),
        ),
    ];
    for (target, host) in &bad {
        let answer = raw_get(port, target, Some(host)).await.unwrap();
        assert_eq!(answer.status, 404, "{target} with Host {host}");
    }
    assert_eq!(rig.state()["status"], "pending", "the flow is still there");
    assert_eq!(rig.srn.count(TOKEN), 0, "nothing was exchanged");

    assert_eq!(raw_get(port, &good, Some(&host)).await.unwrap().status, 200);
    rig.until_status("signedIn").await;
    // the listener closed: the same callback again finds nothing, and
    // nothing more is exchanged
    assert!(wait_closed(port).await);
    assert!(raw_get(port, &good, Some(&host)).await.is_err());
    assert_eq!(rig.srn.count(TOKEN), 1);
}

#[tokio::test]
async fn declining_in_the_browser_ends_the_sign_in() {
    let rig = rig().await;
    rig.account.startup().await;
    rig.account.sign_in(PageLanguage::English).await.unwrap();
    let (port, target) = rig.srn.deny_nth(0);
    let page = raw_get(port, &target, Some(&format!("127.0.0.1:{port}")))
        .await
        .unwrap();
    assert_eq!(page.status, 200);
    assert!(page.body.contains("Connection canceled"));
    let state = rig.until_status("signedOut").await;
    assert_eq!(key_of(&state["problem"]), "SrnAccount.errors.accessDenied");
    assert_eq!(state["problem"]["i18n_params"]["code"], "access_denied");
    assert_eq!(rig.srn.count(TOKEN), 0);
    assert_eq!(rig.host.fronts.load(Ordering::SeqCst), 1);
    assert!(wait_closed(port).await);
}

#[tokio::test]
async fn a_sign_in_the_browser_never_finishes_expires() {
    let rig = rig_with(Config {
        flow_ttl: Duration::from_millis(300),
        ..Config::default()
    })
    .await;
    rig.account.startup().await;
    rig.account.sign_in(PageLanguage::English).await.unwrap();
    let port = rig.port(0);
    let state = rig.until_status("signedOut").await;
    assert_eq!(key_of(&state["problem"]), "SrnAccount.errors.expired");
    assert!(wait_closed(port).await);
    // an approval after that finds nothing listening
    let (port, target) = rig.srn.approve_nth(0);
    assert!(raw_get(port, &target, Some(&format!("127.0.0.1:{port}")))
        .await
        .is_err());
    assert_eq!(rig.srn.count(TOKEN), 0);
    assert_eq!(rig.host.fronts.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn cancelling_ends_the_sign_in_and_its_listener() {
    let rig = rig().await;
    rig.account.startup().await;
    rig.account.sign_in(PageLanguage::English).await.unwrap();
    let port = rig.port(0);
    let state = json(&rig.account.cancel());
    assert_eq!(state, json!({ "status": "signedOut" }));
    assert!(wait_closed(port).await);
    let (port, target) = rig.srn.approve_nth(0);
    assert!(raw_get(port, &target, Some(&format!("127.0.0.1:{port}")))
        .await
        .is_err());
    assert_eq!(rig.srn.count(TOKEN), 0);
    assert_eq!(
        rig.host.events.lock().unwrap().last().unwrap().status,
        "signedOut"
    );
    // nothing to cancel: nothing happens
    let events = rig.host.events.lock().unwrap().len();
    rig.account.cancel();
    assert_eq!(rig.host.events.lock().unwrap().len(), events);
    assert_eq!(rig.account.reopen().unwrap_err(), Problem::NoPendingSignIn);
}

#[tokio::test]
async fn a_new_sign_in_closes_the_older_one_s_listener() {
    let rig = rig().await;
    rig.account.startup().await;
    rig.account.sign_in(PageLanguage::English).await.unwrap();
    let first = rig.port(0);
    rig.account.sign_in(PageLanguage::English).await.unwrap();
    assert!(wait_closed(first).await);
    let (port, target) = rig.srn.approve_nth(0);
    assert!(raw_get(port, &target, Some(&format!("127.0.0.1:{port}")))
        .await
        .is_err());
    assert_eq!(rig.state()["status"], "pending");
    assert_eq!(rig.srn.count(TOKEN), 0);
    // the newer one is the one that completes
    assert_eq!(rig.approve(1).await.status, 200);
    rig.until_status("signedIn").await;
}

#[tokio::test]
async fn an_older_sign_in_s_late_success_signs_nobody_in() {
    let rig = rig().await;
    rig.account.startup().await;
    rig.srn
        .script_token(Reply::Slow(Duration::from_millis(400)));
    rig.account.sign_in(PageLanguage::English).await.unwrap();
    assert_eq!(rig.approve(0).await.status, 200);
    rig.until_state("completing", |s| s["completing"] == true)
        .await;

    // a second sign-in while the first one's exchange is out
    rig.account.sign_in(PageLanguage::English).await.unwrap();
    until("the first token was issued", || rig.srn.tokens().len() == 1).await;
    let first = rig.srn.tokens()[0].clone();
    // it is ended on SpaceRing, and nothing of it is kept
    until("the first connection ended", || {
        !rig.srn.token_works(&first)
    })
    .await;
    assert_eq!(rig.state()["status"], "pending");
    assert_eq!(rig.state()["completing"], false);
    assert_eq!(rig.store.value(SECRET), None);

    rig.srn.script_token(Reply::Normal);
    assert_eq!(rig.approve(1).await.status, 200);
    rig.until_status("signedIn").await;
    let kept = rig.kept_token().unwrap();
    assert_ne!(kept, first);
    assert!(rig.srn.token_works(&kept));
}

#[tokio::test]
async fn cancelling_while_completing_keeps_nothing() {
    let rig = rig().await;
    rig.account.startup().await;
    // the keychain is written, then /me takes its time
    rig.srn.script_me_once(Reply::Late(
        Duration::from_millis(400),
        Box::new(Reply::Normal),
    ));
    rig.account.sign_in(PageLanguage::English).await.unwrap();
    assert_eq!(rig.approve(0).await.status, 200);
    until("the token was kept", || rig.store.value(SECRET).is_some()).await;
    rig.account.cancel();
    until("what was kept is gone", || {
        rig.store.value(SECRET).is_none()
    })
    .await;
    let token = rig.srn.tokens()[0].clone();
    until("the connection ended", || !rig.srn.token_works(&token)).await;
    assert_eq!(rig.state()["status"], "signedOut");
}

/// Cancelled once its token is in the keychain, with neither the removal nor
/// SpaceRing's end of the connection going through: the sign-in is still
/// there, and the account says so until a sign-out really removes it.
#[tokio::test]
async fn a_cancelled_sign_in_the_keychain_keeps_is_still_signed_out_of() {
    let rig = rig().await;
    rig.account.startup().await;
    rig.srn.script_me_once(Reply::Late(
        Duration::from_millis(400),
        Box::new(Reply::Normal),
    ));
    rig.srn
        .script_logout(Reply::Status(503, json!({ "error": "server_error" })));
    rig.account.sign_in(PageLanguage::English).await.unwrap();
    rig.approve(0).await;
    until("the token was kept", || rig.store.value(SECRET).is_some()).await;
    *rig.store.fail_delete.lock().unwrap() = true;
    rig.account.cancel();

    let state = rig
        .until_state("the failed cleanup is told", |s| {
            key_of(&s["problem"]) == "SrnAccount.errors.keychainCleanup"
        })
        .await;
    assert_eq!(state["status"], "signedOut");
    assert_eq!(
        state["problem"]["i18n_params"]["code"],
        "keychain_cleanup_failed"
    );
    assert!(state["problem"]["detail"]
        .as_str()
        .unwrap()
        .contains("locked"));
    until("SpaceRing was asked to end it", || {
        rig.srn.count(LOGOUT) == 1
    })
    .await;
    let token = rig.srn.tokens()[0].clone();
    assert!(rig.srn.token_works(&token));
    assert_eq!(rig.kept_token().as_deref(), Some(token.as_str()));
    assert_eq!(
        rig.host.events.lock().unwrap().last().unwrap().status,
        "signedOut"
    );

    // a sign-out tries the removal again, and is not done while it fails
    assert!(matches!(
        rig.account
            .sign_out(None, PageLanguage::English)
            .await
            .unwrap_err(),
        Problem::KeychainDelete { .. }
    ));
    assert_eq!(rig.kept_token().as_deref(), Some(token.as_str()));
    assert_eq!(
        key_of(&rig.state()["problem"]),
        "SrnAccount.errors.keychainCleanup"
    );

    // once it can: removed, and SpaceRing told with that sign-in's token
    *rig.store.fail_delete.lock().unwrap() = false;
    rig.srn.script_logout(Reply::Normal);
    let out = serde_json::to_value(
        rig.account
            .sign_out(None, PageLanguage::English)
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(out["remote"], "confirmed");
    assert_eq!(rig.store.value(SECRET), None);
    assert!(!rig.srn.token_works(&token));
    assert_eq!(rig.state(), json!({ "status": "signedOut" }));
}

/// The same for a sign-in SpaceRing ended (401) whose token the keychain
/// would not give up.
#[tokio::test]
async fn an_ended_sign_in_the_keychain_keeps_is_still_signed_out_of() {
    let rig = rig().await;
    rig.seed();
    rig.account.startup().await;
    *rig.store.fail_delete.lock().unwrap() = true;
    rig.srn
        .script_me(Reply::Status(401, json!({ "error": "invalid_token" })));
    let state = json(&rig.account.check(CheckTrigger::User).await.unwrap());
    assert_eq!(state["status"], "signedOut");
    assert_eq!(
        key_of(&state["problem"]),
        "SrnAccount.errors.keychainCleanup"
    );
    assert!(rig.store.value(SECRET).is_some());

    *rig.store.fail_delete.lock().unwrap() = false;
    let out = serde_json::to_value(
        rig.account
            .sign_out(None, PageLanguage::English)
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(out["state"], json!({ "status": "signedOut" }));
    assert_ne!(out["remote"], "notSignedIn");
    assert_eq!(rig.store.value(SECRET), None);
}

/// A sign-in written over a leftover one ends the leftover's connection.
#[tokio::test]
async fn a_new_sign_in_writes_over_a_leftover_and_ends_it() {
    let rig = rig().await;
    rig.account.startup().await;
    rig.srn.script_me_once(Reply::Late(
        Duration::from_millis(400),
        Box::new(Reply::Normal),
    ));
    rig.srn
        .script_logout(Reply::Status(503, json!({ "error": "server_error" })));
    rig.account.sign_in(PageLanguage::English).await.unwrap();
    rig.approve(0).await;
    until("the token was kept", || rig.store.value(SECRET).is_some()).await;
    *rig.store.fail_delete.lock().unwrap() = true;
    rig.account.cancel();
    rig.until_state("the leftover is told", |s| {
        key_of(&s["problem"]) == "SrnAccount.errors.keychainCleanup"
    })
    .await;
    let leftover = rig.srn.tokens()[0].clone();

    rig.srn.script_logout(Reply::Normal);
    rig.sign_in().await;
    let kept = rig.kept_token().unwrap();
    assert_ne!(kept, leftover);
    until("the leftover's connection ended", || {
        !rig.srn.token_works(&leftover)
    })
    .await;
    assert!(rig.srn.token_works(&kept));
}

#[tokio::test]
async fn the_exchange_is_made_once_and_follows_no_redirect() {
    let rig = rig().await;
    rig.account.startup().await;

    // a redirect is the answer, not a hop
    rig.srn
        .script_token(Reply::Redirect("/api/client/v1/token-again".into()));
    rig.account.sign_in(PageLanguage::English).await.unwrap();
    rig.approve(0).await;
    let state = rig.until_status("signedOut").await;
    assert_eq!(key_of(&state["problem"]), "SrnAccount.errors.server");
    assert_eq!(state["problem"]["i18n_params"]["status"], "302");
    assert_eq!(rig.srn.count(TOKEN), 1);
    assert!(!rig.srn.paths().iter().any(|p| p.ends_with("token-again")));

    // an answer that never comes: the sign-in failed, and is not tried again
    rig.srn.script_token(Reply::Slow(Duration::from_secs(5)));
    rig.account.sign_in(PageLanguage::English).await.unwrap();
    rig.approve(1).await;
    let state = rig
        .until_state("failed", |s| {
            s["status"] == "signedOut" && !s["problem"].is_null()
        })
        .await;
    assert_eq!(key_of(&state["problem"]), "SrnAccount.errors.network");
    assert_eq!(rig.srn.count(TOKEN), 2);

    // SpaceRing refusing the code
    rig.srn
        .script_token(Reply::Status(400, json!({ "error": "invalid_grant" })));
    rig.account.sign_in(PageLanguage::English).await.unwrap();
    rig.approve(2).await;
    let state = rig
        .until_state("refused", |s| {
            key_of(&s["problem"]) == "SrnAccount.errors.exchangeFailed"
        })
        .await;
    assert_eq!(state["status"], "signedOut");
    assert_eq!(rig.srn.count(TOKEN), 3);
    assert_eq!(rig.store.value(SECRET), None);
    // nothing about the exchanges went to /me
    assert_eq!(rig.srn.count(ME), 0);
}

#[tokio::test]
async fn a_keychain_that_will_not_keep_the_token_means_no_sign_in() {
    let rig = rig().await;
    rig.account.startup().await;
    *rig.store.fail_set.lock().unwrap() = true;
    rig.account.sign_in(PageLanguage::English).await.unwrap();
    rig.approve(0).await;
    let state = rig.until_status("signedOut").await;
    assert_eq!(key_of(&state["problem"]), "SrnAccount.errors.keychainWrite");
    assert_eq!(
        state["problem"]["i18n_params"]["code"],
        "keychain_write_failed"
    );
    assert!(state["problem"]["detail"]
        .as_str()
        .unwrap()
        .contains("locked"));
    assert_eq!(rig.store.value(SECRET), None);
    // the connection it opened is ended, and nothing was confirmed
    let token = rig.srn.tokens()[0].clone();
    until("the connection ended", || !rig.srn.token_works(&token)).await;
    assert_eq!(rig.srn.count(ME), 0);
    assert_eq!(rig.host.fronts.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn another_account_than_the_exchange_named_is_not_signed_in() {
    let rig = rig().await;
    rig.account.startup().await;
    rig.srn.issue_tokens_to(USER_SRN + 1);
    rig.account.sign_in(PageLanguage::English).await.unwrap();
    rig.approve(0).await;
    let state = rig.until_status("signedOut").await;
    assert_eq!(
        key_of(&state["problem"]),
        "SrnAccount.errors.accountChanged"
    );
    assert_eq!(state["problem"]["i18n_params"]["code"], "account_changed");
    assert_eq!(rig.store.value(SECRET), None);
    let token = rig.srn.tokens()[0].clone();
    until("the connection ended", || !rig.srn.token_works(&token)).await;
}

#[tokio::test]
async fn a_sign_in_that_cannot_start_leaves_nothing_listening() {
    let rig = rig().await;
    rig.account.startup().await;
    rig.srn.script_login(Reply::RateLimited(60));
    assert_eq!(
        rig.account
            .sign_in(PageLanguage::English)
            .await
            .unwrap_err(),
        Problem::RateLimited { seconds: 60 }
    );
    assert_eq!(rig.state(), json!({ "status": "signedOut" }));
    assert!(rig.host.opened.lock().unwrap().is_empty());
    let port = rig
        .srn
        .seen()
        .iter()
        .find(|s| s.path == LOGIN)
        .map(|s| url::Url::parse(s.json()["redirect_uri"].as_str().unwrap()).unwrap())
        .and_then(|url| url.port())
        .unwrap();
    assert!(wait_closed(port).await);

    // a build SpaceRing does not know
    rig.srn
        .script_login(Reply::Status(401, json!({ "error": "invalid_client" })));
    assert_eq!(
        rig.account
            .sign_in(PageLanguage::English)
            .await
            .unwrap_err(),
        Problem::ClientRejected
    );
}

#[tokio::test]
async fn a_sign_in_is_not_started_over_one_that_is_signed_in() {
    let rig = rig().await;
    rig.seed();
    rig.account.startup().await;
    assert_eq!(
        rig.account
            .sign_in(PageLanguage::English)
            .await
            .unwrap_err(),
        Problem::AlreadySignedIn
    );
    assert_eq!(rig.srn.count(LOGIN), 0);
}

#[tokio::test]
async fn a_browser_that_will_not_open_leaves_the_link() {
    let rig = rig().await;
    rig.account.startup().await;
    rig.host.fail_open.store(true, Ordering::SeqCst);
    let state = json(&rig.account.sign_in(PageLanguage::English).await.unwrap());
    assert_eq!(state["status"], "pending");
    assert_eq!(key_of(&state["problem"]), "SrnAccount.errors.openBrowser");
    assert!(state["authorizationUrl"].is_string());
    assert_eq!(rig.account.reopen().unwrap_err(), Problem::OpenBrowser);

    rig.host.fail_open.store(false, Ordering::SeqCst);
    let state = json(&rig.account.reopen().unwrap());
    assert!(state.get("problem").is_none(), "{state}");
    assert_eq!(rig.host.opened.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn a_chinese_interface_gets_the_chinese_pages() {
    let rig = rig().await;
    rig.account.startup().await;
    let state = json(
        &rig.account
            .sign_in(PageLanguage::SimplifiedChinese)
            .await
            .unwrap(),
    );
    let url = format!(
        "{}/zh/authorize/#request_id={}",
        rig.srn.origin().as_str(),
        rig.srn.request_ids()[0]
    );
    assert_eq!(state["authorizationUrl"], url);
    assert_eq!(*rig.host.opened.lock().unwrap(), vec![url]);
    let page = rig.approve(0).await;
    assert!(page.body.contains("请回到 Codeg"), "{}", page.body);
}

// ─── The keychain ───────────────────────────────────────────────────────

#[tokio::test]
async fn a_keychain_that_will_not_read_is_not_signed_out() {
    let rig = rig().await;
    *rig.store.fail_get.lock().unwrap() = true;
    rig.account.startup().await;
    let state = rig.state();
    assert_eq!(state["status"], "credentialUnreadable");
    assert_eq!(key_of(&state["problem"]), "SrnAccount.errors.keychainRead");
    assert_eq!(rig.srn.count(ME), 0);

    // a window coming forward does not read it again
    rig.account.check(CheckTrigger::Foreground).await.unwrap();
    assert_eq!(rig.count("store get"), 1);

    // asked to, it reads it again: it opens now, and holds a sign-in
    rig.seed();
    *rig.store.fail_get.lock().unwrap() = false;
    let state = json(&rig.account.check(CheckTrigger::User).await.unwrap());
    assert_eq!(state["status"], "signedIn");
    assert_eq!(state["online"]["status"], "confirmed");
    assert_eq!(rig.srn.count(ME), 1);
}

#[tokio::test]
async fn a_sign_in_that_is_not_one_is_unreadable_and_can_be_removed() {
    let rig = rig().await;
    rig.store.put(SECRET, "not a record");
    rig.account.startup().await;
    let state = rig.state();
    assert_eq!(state["status"], "credentialUnreadable");
    assert_eq!(
        key_of(&state["problem"]),
        "SrnAccount.errors.credentialInvalid"
    );
    let out = serde_json::to_value(
        rig.account
            .sign_out(None, PageLanguage::English)
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(out["state"]["status"], "signedOut");
    assert_eq!(out["remote"], "unconfirmed");
    assert_eq!(
        out["manageConnectionsUrl"],
        format!("{}/console/clients/", rig.srn.origin().as_str())
    );
    assert_eq!(
        out["problem"]["i18n_params"]["reason"],
        "credential_invalid"
    );
    assert_eq!(rig.store.value(SECRET), None);
    assert_eq!(rig.srn.count(LOGOUT), 0, "there was no token to tell it");
}

/// Development builds share one keychain entry: a sign-in another origin
/// or client wrote is not signed in here, its token goes nowhere, and it is
/// left alone until a sign-in here replaces it.
#[tokio::test]
async fn a_sign_in_kept_for_another_origin_or_client_is_not_this_ones() {
    for (origin, client) in [
        ("http://127.0.0.1:4321", "codeg-desktop-test"),
        ("https://spacering.net", "codeg-desktop-other"),
    ] {
        let rig = rig().await;
        let elsewhere = Environment {
            origin: Origin::parse(origin).unwrap(),
            client_id: client.into(),
            secret_name: SECRET.into(),
        };
        let theirs = store::encode(
            &AccessToken::parse(&"t".repeat(43)).unwrap(),
            &SrnUser {
                srn: USER_SRN,
                name: "Ada Lovelace".into(),
                avatar_path: None,
            },
            &elsewhere,
        );
        rig.store.put(SECRET, &theirs);
        rig.account.startup().await;
        assert_eq!(rig.state()["status"], "signedOut", "{origin} {client}");
        assert_eq!(rig.srn.count(ME), 0, "its token was sent here");
        // signing out here has nothing of its own to remove
        rig.account
            .sign_out(None, PageLanguage::English)
            .await
            .unwrap();
        assert_eq!(rig.store.value(SECRET).as_deref(), Some(theirs.as_str()));
        assert_eq!(rig.srn.count(LOGOUT), 0);
        // a sign-in here replaces it with this build's own
        rig.sign_in().await;
        let raw = rig.store.value(SECRET).unwrap();
        assert!(store::kept_for(&raw, &rig.env()));
    }
}

/// Another development Codeg, talking elsewhere, signed in over the shared
/// entry after this one read it: nothing this one does afterwards removes or
/// rewrites that sign-in, and its token goes nowhere.
#[tokio::test]
async fn a_sign_in_written_over_this_ones_is_left_alone() {
    // signing out: this one's own connection still ends on SpaceRing
    let rig = self::rig().await;
    let token = rig.seed();
    rig.account.startup().await;
    let theirs = rig.foreign_record();
    rig.store.put(SECRET, &theirs);
    rig.account
        .sign_out(None, PageLanguage::English)
        .await
        .unwrap();
    assert_eq!(rig.state()["status"], "signedOut");
    assert_eq!(rig.store.value(SECRET).as_deref(), Some(theirs.as_str()));
    assert_eq!(rig.srn.count(LOGOUT), 1);
    assert!(!rig.srn.token_works(&token));

    // SpaceRing ending this one's connection
    let rig = self::rig().await;
    rig.seed();
    rig.account.startup().await;
    let theirs = rig.foreign_record();
    rig.store.put(SECRET, &theirs);
    rig.srn
        .script_me(Reply::Status(401, json!({ "error": "invalid_token" })));
    let state = json(&rig.account.check(CheckTrigger::User).await.unwrap());
    assert_eq!(state["status"], "signedOut");
    assert_eq!(rig.store.value(SECRET).as_deref(), Some(theirs.as_str()));

    // a new name on SpaceRing
    let rig = self::rig().await;
    rig.seed();
    rig.account.startup().await;
    let theirs = rig.foreign_record();
    rig.store.put(SECRET, &theirs);
    rig.srn.rename_user("Ada L.", None);
    let state = json(&rig.account.check(CheckTrigger::User).await.unwrap());
    assert_eq!(state["account"]["name"], "Ada L.");
    assert_eq!(rig.store.value(SECRET).as_deref(), Some(theirs.as_str()));
    // none of it sent the other sign-in's token
    assert!(rig
        .srn
        .seen()
        .iter()
        .all(|seen| seen.header("authorization") != Some(&format!("Bearer {}", "f".repeat(43)))));
}

/// The keychain would not read at the start, and by the sign-out it holds
/// another environment's sign-in: not this one's to remove.
#[tokio::test]
async fn signing_out_an_unread_sign_in_leaves_another_environments_alone() {
    let rig = rig().await;
    *rig.store.fail_get.lock().unwrap() = true;
    rig.account.startup().await;
    assert_eq!(rig.state()["status"], "credentialUnreadable");
    *rig.store.fail_get.lock().unwrap() = false;
    let theirs = rig.foreign_record();
    rig.store.put(SECRET, &theirs);
    rig.account
        .sign_out(None, PageLanguage::English)
        .await
        .unwrap();
    assert_eq!(rig.state()["status"], "signedOut");
    assert_eq!(rig.store.value(SECRET).as_deref(), Some(theirs.as_str()));
}

#[tokio::test]
async fn the_console_and_its_connections_are_on_the_sign_ins_origin() {
    let rig = rig().await;
    let origin = rig.srn.origin().as_str().to_string();
    assert_eq!(
        rig.account.console_url(PageLanguage::English),
        format!("{origin}/console/")
    );
    assert_eq!(
        rig.account.console_url(PageLanguage::SimplifiedChinese),
        format!("{origin}/zh/console/")
    );
    assert_eq!(
        rig.account
            .manage_connections_url(PageLanguage::TraditionalChinese),
        format!("{origin}/zh/console/clients/")
    );
}

#[tokio::test]
async fn a_sign_in_over_an_unreadable_one_replaces_it() {
    let rig = rig().await;
    rig.store.put(SECRET, "not a record");
    rig.account.startup().await;
    rig.sign_in().await;
    assert!(rig.kept_token().is_some());
}

#[tokio::test]
async fn a_sign_in_over_an_unreadable_one_that_then_fails_leaves_nothing() {
    let rig = rig().await;
    rig.store.put(SECRET, "not a record");
    rig.account.startup().await;
    // the token is written over the unreadable entry, then refused
    rig.srn
        .script_me(Reply::Status(401, json!({ "error": "invalid_token" })));
    rig.account.sign_in(PageLanguage::English).await.unwrap();
    rig.approve(0).await;
    let state = rig.until_status("signedOut").await;
    assert_eq!(key_of(&state["problem"]), "SrnAccount.errors.revoked");
    assert_eq!(rig.store.value(SECRET), None);
}

// ─── Checking online ────────────────────────────────────────────────────

#[tokio::test]
async fn the_startup_check_confirms_a_kept_sign_in() {
    let rig = rig().await;
    assert_eq!(rig.state()["status"], "loading");
    let token = rig.seed();
    rig.account.startup().await;
    let state = rig.state();
    assert_eq!(state["status"], "signedIn");
    assert_eq!(state["online"]["status"], "confirmed");
    assert_eq!(state["account"]["srn"], USER_SRN);
    let me = rig.srn.seen().into_iter().find(|s| s.path == ME).unwrap();
    assert_eq!(
        me.header("authorization"),
        Some(format!("Bearer {token}").as_str())
    );
}

#[tokio::test]
async fn offline_keeps_the_identity() {
    let rig = rig().await;
    rig.seed();
    rig.srn.stop();
    rig.account.startup().await;
    let state = rig.state();
    assert_eq!(state["status"], "signedIn");
    assert_eq!(state["account"]["name"], "Ada Lovelace");
    assert_eq!(state["online"]["status"], "unconfirmed");
    assert_eq!(
        key_of(&state["online"]["problem"]),
        "SrnAccount.errors.network"
    );
    assert!(state["online"]["checkedAt"].is_string());
    assert!(state["online"]["confirmedAt"].is_null());
    assert!(rig.store.value(SECRET).is_some());
}

#[tokio::test]
async fn only_a_401_signs_out() {
    let rig = rig().await;
    rig.seed();
    rig.account.startup().await;
    assert_eq!(rig.state()["online"]["status"], "confirmed");

    for (reply, key, param) in [
        (
            Reply::Status(503, json!({ "error": "server_error" })),
            "SrnAccount.errors.server",
            ("status", "503"),
        ),
        (
            Reply::Status(500, json!({ "error": "server_error" })),
            "SrnAccount.errors.server",
            ("status", "500"),
        ),
        (
            Reply::Text(200, "text/html", "<html>".into()),
            "SrnAccount.errors.invalidResponse",
            ("code", "invalid_response"),
        ),
        (
            Reply::RateLimited(30),
            "SrnAccount.errors.rateLimited",
            ("seconds", "30"),
        ),
    ] {
        rig.srn.script_me(reply);
        rig.clock.advance(Duration::from_secs(61 * 60));
        let state = json(&rig.account.check(CheckTrigger::Foreground).await.unwrap());
        assert_eq!(state["status"], "signedIn", "{key}");
        assert_eq!(state["account"]["srn"], USER_SRN);
        assert_eq!(state["online"]["status"], "unconfirmed");
        assert_eq!(key_of(&state["online"]["problem"]), key);
        assert_eq!(state["online"]["problem"]["i18n_params"][param.0], param.1);
        assert!(
            state["online"]["confirmedAt"].is_string(),
            "kept from before"
        );
        assert!(rig.store.value(SECRET).is_some());
    }

    rig.srn
        .script_me(Reply::Status(401, json!({ "error": "invalid_token" })));
    rig.clock.advance(Duration::from_secs(61 * 60));
    let state = json(&rig.account.check(CheckTrigger::Foreground).await.unwrap());
    assert_eq!(state["status"], "signedOut");
    assert_eq!(key_of(&state["problem"]), "SrnAccount.errors.revoked");
    assert_eq!(rig.store.value(SECRET), None);
}

#[tokio::test]
async fn the_online_check_is_at_most_hourly_unless_asked_for() {
    let rig = rig().await;
    rig.seed();
    rig.account.startup().await;
    assert_eq!(rig.srn.count(ME), 1);

    rig.account.check(CheckTrigger::Foreground).await.unwrap();
    rig.account.check(CheckTrigger::Online).await.unwrap();
    assert_eq!(rig.srn.count(ME), 1, "within the hour");
    rig.account.check(CheckTrigger::User).await.unwrap();
    assert_eq!(rig.srn.count(ME), 2, "asked for");

    rig.clock.advance(Duration::from_secs(59 * 60));
    rig.account.check(CheckTrigger::Foreground).await.unwrap();
    assert_eq!(rig.srn.count(ME), 2);
    rig.clock.advance(Duration::from_secs(2 * 60));
    rig.account.check(CheckTrigger::Foreground).await.unwrap();
    assert_eq!(rig.srn.count(ME), 3, "an hour on");

    // no answer: a window coming forward waits a minute before trying again;
    // the network coming back waits ten seconds
    rig.srn.script_me(Reply::Slow(Duration::from_secs(5)));
    rig.clock.advance(Duration::from_secs(61 * 60));
    let state = json(&rig.account.check(CheckTrigger::Foreground).await.unwrap());
    assert_eq!(rig.srn.count(ME), 4);
    assert_eq!(
        key_of(&state["online"]["problem"]),
        "SrnAccount.errors.network"
    );
    rig.srn.script_me(Reply::Normal);
    rig.account.check(CheckTrigger::Foreground).await.unwrap();
    rig.account.check(CheckTrigger::Online).await.unwrap();
    assert_eq!(rig.srn.count(ME), 4, "just after the last try");
    rig.clock.advance(Duration::from_secs(11));
    rig.account.check(CheckTrigger::Foreground).await.unwrap();
    assert_eq!(rig.srn.count(ME), 4, "within a minute of the last try");
    let state = json(&rig.account.check(CheckTrigger::Online).await.unwrap());
    assert_eq!(rig.srn.count(ME), 5, "the network came back");
    assert_eq!(state["online"]["status"], "confirmed");

    // SpaceRing's Retry-After holds even the person's own check
    rig.srn.script_me(Reply::RateLimited(120));
    rig.account.check(CheckTrigger::User).await.unwrap();
    assert_eq!(rig.srn.count(ME), 6);
    assert_eq!(
        rig.account.check(CheckTrigger::User).await.unwrap_err(),
        Problem::RateLimited { seconds: 120 }
    );
    rig.clock.advance(Duration::from_secs(121));
    rig.account.check(CheckTrigger::Foreground).await.unwrap();
    assert_eq!(rig.srn.count(ME), 6, "an answered check waits its hour");
    rig.srn.script_me(Reply::Normal);
    let state = json(&rig.account.check(CheckTrigger::User).await.unwrap());
    assert_eq!(rig.srn.count(ME), 7, "the pause is over");
    assert_eq!(state["online"]["status"], "confirmed");
}

#[tokio::test]
async fn the_network_coming_back_in_every_window_is_one_check() {
    let rig = rig_with(Config {
        online_floor: Duration::from_secs(10),
        ..Config::default()
    })
    .await;
    rig.seed();
    rig.account.startup().await;
    rig.srn.stop();
    rig.clock.advance(Duration::from_secs(61 * 60));
    // each check ends with one event
    let checks = || rig.host.events.lock().unwrap().len();
    let before = checks();
    // the first window's check fails at once: not quite online yet
    rig.account.check(CheckTrigger::Online).await.unwrap();
    assert_eq!(checks(), before + 1);
    assert_eq!(rig.state()["online"]["status"], "unconfirmed");
    // the other windows say so after it ended, within the floor
    for _ in 0..3 {
        rig.clock.advance(Duration::from_secs(3));
        rig.account.check(CheckTrigger::Online).await.unwrap();
    }
    assert_eq!(checks(), before + 1, "one check for every window");
    // past it, the network coming back checks again
    rig.clock.advance(Duration::from_secs(2));
    rig.account.check(CheckTrigger::Online).await.unwrap();
    assert_eq!(checks(), before + 2, "past the floor");
}

#[tokio::test]
async fn the_person_s_check_ignores_the_online_floor() {
    let rig = rig().await;
    rig.seed();
    rig.srn.stop();
    rig.account.startup().await;
    // each check ends with one event
    let checks = || rig.host.events.lock().unwrap().len();
    let before = checks();
    rig.account.check(CheckTrigger::Online).await.unwrap();
    assert_eq!(checks(), before, "just after the startup check");
    for _ in 0..3 {
        rig.account.check(CheckTrigger::User).await.unwrap();
    }
    assert_eq!(checks(), before + 3, "each one asked for");
}

#[tokio::test]
async fn checks_asked_for_together_are_one() {
    let rig = rig().await;
    rig.seed();
    rig.account.startup().await;
    rig.srn.script_me(Reply::Slow(Duration::from_millis(300)));
    let (one, two) = tokio::join!(
        rig.account.check(CheckTrigger::User),
        rig.account.check(CheckTrigger::User)
    );
    assert_eq!(json(&one.unwrap())["online"]["status"], "confirmed");
    assert_eq!(json(&two.unwrap())["online"]["checking"], false);
    assert_eq!(rig.srn.count(ME), 2, "the startup check and one more");
}

#[tokio::test]
async fn an_older_check_s_late_401_signs_nobody_out() {
    let rig = rig().await;
    rig.seed();
    rig.account.startup().await;
    rig.srn.script_me_once(Reply::Late(
        Duration::from_millis(600),
        Box::new(Reply::Status(401, json!({ "error": "invalid_token" }))),
    ));
    let account = rig.account.clone();
    let late = tokio::spawn(async move { account.check(CheckTrigger::User).await });
    until("the check went out", || rig.srn.count(ME) == 2).await;

    // meanwhile: signed out, and signed in again
    rig.account
        .sign_out(Some(USER_SRN), PageLanguage::English)
        .await
        .unwrap();
    rig.sign_in().await;
    let kept = rig.kept_token().unwrap();

    late.await.unwrap().unwrap();
    let state = rig.state();
    assert_eq!(state["status"], "signedIn", "{state}");
    assert_eq!(rig.kept_token().as_deref(), Some(kept.as_str()));
}

#[tokio::test]
async fn the_name_and_the_picture_follow_spacering() {
    let rig = rig().await;
    rig.seed();
    rig.account.startup().await;
    rig.srn.rename_user("Ada L.", None);
    let state = json(&rig.account.check(CheckTrigger::User).await.unwrap());
    assert_eq!(
        state["account"],
        json!({ "srn": USER_SRN, "name": "Ada L.", "avatarPath": null })
    );
    let (_, who) = store::decode(&rig.store.value(SECRET).unwrap(), rig.srn.origin()).unwrap();
    assert_eq!(who.name, "Ada L.");
    assert_eq!(who.avatar_path, None);
}

// ─── Signing out ────────────────────────────────────────────────────────

#[tokio::test]
async fn signing_out_removes_the_token_here_first() {
    let rig = rig().await;
    let token = rig.seed();
    rig.account.startup().await;

    // the keychain will not let go: nothing is signed out
    *rig.store.fail_delete.lock().unwrap() = true;
    assert!(matches!(
        rig.account
            .sign_out(Some(USER_SRN), PageLanguage::English)
            .await
            .unwrap_err(),
        Problem::KeychainDelete { .. }
    ));
    assert_eq!(rig.state()["status"], "signedIn");
    assert_eq!(rig.srn.count(LOGOUT), 0);
    assert!(rig.srn.token_works(&token));
    *rig.store.fail_delete.lock().unwrap() = false;

    // the popover showed another account
    assert_eq!(
        rig.account
            .sign_out(Some(USER_SRN + 1), PageLanguage::English)
            .await
            .unwrap_err(),
        Problem::AccountChanged
    );
    assert_eq!(rig.state()["status"], "signedIn");

    // SpaceRing does not answer: signed out here, and where to finish it
    rig.srn
        .script_logout(Reply::Status(503, json!({ "error": "server_error" })));
    let out = serde_json::to_value(
        rig.account
            .sign_out(Some(USER_SRN), PageLanguage::SimplifiedChinese)
            .await
            .unwrap(),
    )
    .unwrap();
    let manage = format!("{}/zh/console/clients/", rig.srn.origin().as_str());
    assert_eq!(out["state"], json!({ "status": "signedOut" }));
    assert_eq!(out["remote"], "unconfirmed");
    assert_eq!(out["manageConnectionsUrl"], manage);
    assert_eq!(
        key_of(&out["problem"]),
        "SrnAccount.errors.signedOutLocally"
    );
    assert_eq!(
        out["problem"]["i18n_params"],
        json!({ "code": "signed_out_locally", "url": manage, "reason": "server", "status": "503" })
    );
    assert_eq!(rig.store.value(SECRET), None);
    assert!(rig.position("store delete") < rig.position("srn logout"));
    assert_eq!(rig.state()["status"], "signedOut");
}

#[tokio::test]
async fn a_sign_out_spacering_never_answers_is_unconfirmed_within_its_deadline() {
    let rig = rig_with(Config {
        logout_deadline: Duration::from_millis(150),
        ..Config::default()
    })
    .await;
    rig.seed();
    rig.account.startup().await;
    rig.srn.script_logout(Reply::Slow(Duration::from_secs(30)));
    let started = Instant::now();
    let out = serde_json::to_value(
        rig.account
            .sign_out(Some(USER_SRN), PageLanguage::English)
            .await
            .unwrap(),
    )
    .unwrap();
    // the deadline ended it, not the client's own two seconds
    assert!(
        started.elapsed() < Duration::from_millis(1500),
        "{:?}",
        started.elapsed()
    );
    let manage = format!("{}/console/clients/", rig.srn.origin().as_str());
    assert_eq!(out["state"], json!({ "status": "signedOut" }));
    assert_eq!(out["remote"], "unconfirmed");
    assert_eq!(out["manageConnectionsUrl"], manage);
    assert_eq!(
        key_of(&out["problem"]),
        "SrnAccount.errors.signedOutLocally"
    );
    assert_eq!(out["problem"]["i18n_params"]["reason"], "network");
    assert_eq!(rig.srn.count(LOGOUT), 1);
    assert_eq!(rig.store.value(SECRET), None);
    assert_eq!(rig.state()["status"], "signedOut");
}

#[tokio::test]
async fn a_confirmed_sign_out_ends_the_connection() {
    let rig = rig().await;
    rig.account.startup().await;
    rig.sign_in().await;
    let token = rig.kept_token().unwrap();
    let out = serde_json::to_value(
        rig.account
            .sign_out(Some(USER_SRN), PageLanguage::English)
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(
        out,
        json!({ "state": { "status": "signedOut" }, "remote": "confirmed" })
    );
    assert!(!rig.srn.token_works(&token));
    assert_eq!(rig.store.value(SECRET), None);

    let again = serde_json::to_value(
        rig.account
            .sign_out(None, PageLanguage::English)
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(again["remote"], "notSignedIn");
    assert_eq!(rig.srn.count(LOGOUT), 1);
}

// ─── What leaves ────────────────────────────────────────────────────────

/// A sign-in that fails at the keychain, one SpaceRing refuses, one that
/// works, a check, and a sign-out SpaceRing does not confirm: everything
/// secret any of them handled.
async fn everything(rig: &Rig) {
    rig.account.startup().await;
    *rig.store.fail_set.lock().unwrap() = true;
    rig.account.sign_in(PageLanguage::English).await.unwrap();
    rig.approve(0).await;
    rig.until_status("signedOut").await;
    *rig.store.fail_set.lock().unwrap() = false;

    rig.srn
        .script_token(Reply::Status(400, json!({ "error": "invalid_grant" })));
    rig.account.sign_in(PageLanguage::English).await.unwrap();
    rig.approve(1).await;
    rig.until_state("refused", |s| {
        key_of(&s["problem"]) == "SrnAccount.errors.exchangeFailed"
    })
    .await;
    rig.srn.script_token(Reply::Normal);

    rig.sign_in().await;
    rig.account.check(CheckTrigger::User).await.unwrap();
    rig.srn.script_logout(Reply::Status(502, json!({})));
    rig.account
        .sign_out(Some(USER_SRN), PageLanguage::English)
        .await
        .unwrap();
    rig.account.sign_in(PageLanguage::English).await.unwrap();
    rig.account.cancel();
}

#[tokio::test]
async fn the_account_event_says_who_and_nothing_secret() {
    let rig = rig().await;
    everything(&rig).await;
    let secrets = rig.secrets();
    assert!(secrets.len() >= 10, "{}", secrets.len());
    let events = rig.host.events.lock().unwrap().clone();
    let mut statuses = std::collections::BTreeSet::new();
    for event in &events {
        let value = serde_json::to_value(event).unwrap();
        let text = value.to_string();
        for secret in &secrets {
            assert!(!text.contains(secret.as_str()), "{text}");
        }
        assert!(!text.contains("authorize"), "{text}");
        let keys: Vec<&String> = value.as_object().unwrap().keys().collect();
        assert!(
            keys.iter().all(|k| *k == "status" || *k == "account"),
            "{text}"
        );
        if let Some(account) = value.get("account") {
            assert_eq!(
                account,
                &json!({ "srn": USER_SRN, "name": "Ada Lovelace", "avatarPath": AVATAR_PATH })
            );
        }
        statuses.insert(event.status);
    }
    for status in ["signedOut", "pending", "signedIn"] {
        assert!(statuses.contains(status), "{statuses:?}");
    }
}

/// Everything written to the log while it happens, at every level.
#[derive(Clone, Default)]
struct Captured(Arc<Mutex<Vec<u8>>>);

impl std::io::Write for Captured {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

#[tokio::test]
async fn nothing_secret_is_logged() {
    let captured = Captured::default();
    let writer = captured.clone();
    let subscriber = tracing_subscriber::fmt()
        .with_max_level(tracing::Level::TRACE)
        .with_ansi(false)
        .with_writer(move || writer.clone())
        .finish();
    // With one live dispatcher, tracing-core takes it for the global one and
    // lets a callsite another test's thread registers first be cached as
    // "never" (it asks that thread's default). A second live dispatcher makes
    // every registration ask all of them, this one included.
    let _second = tracing::Dispatch::new(tracing::subscriber::NoSubscriber::default());
    // This test's thread, which is the one its runtime and every task the
    // account spawns run on.
    let _guard = tracing::subscriber::set_default(subscriber);

    let rig = rig().await;
    everything(&rig).await;
    let logged = String::from_utf8_lossy(&captured.0.lock().unwrap()).to_string();
    assert!(
        logged.contains("[srn] signed in"),
        "the log was captured: {logged}"
    );
    assert!(logged.contains("keychain did not keep"), "{logged}");
    for secret in rig.secrets() {
        assert!(
            !logged.contains(secret.as_str()),
            "a secret in the log:\n{logged}"
        );
    }
}
