//! What can go wrong with an SRN sign-in, and how the frontend is told.
//!
//! Two layers. [`SrnError`] is what a request to the account API ended with
//! (`client.rs`). [`Problem`] is what the account reports to the frontend: a
//! failed sign-in, a check that could not confirm the account online, a
//! keychain that would not open, a sign-out SpaceRing did not confirm. A
//! problem travels as an [`AppCommandError`] — a command's rejection, or the
//! `problem` of a state (`types.rs`) — with:
//!
//! - `i18n_key`: `SrnAccount.errors.<name>`, which the status-bar popover
//!   renders; the keys are a wire contract with the frontend;
//! - `i18n_params.code`: the problem's stable snake_case code, plus the
//!   numbers or the address its message needs (`seconds`, `status`, `url`,
//!   `reason`);
//! - `detail`, for some: the platform's or the transport's own account, for
//!   the log and a "details" disclosure. Never a token, a code, a verifier, a
//!   state or a request ID: none of those reaches any text made here.

use std::collections::BTreeMap;

use crate::app_error::{AppCommandError, AppErrorCode};

/// The namespace of every key below, in the frontend's messages.
pub const I18N_NAMESPACE: &str = "SrnAccount.errors";

/// What a request to the SRN account API ended with, when it was not what
/// was asked for.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum SrnError {
    /// No answer: offline, DNS, TLS, refused, timed out, cut off. The text is
    /// the transport's own account (no request ever carries a secret in its
    /// address, so neither does this).
    #[error("SRN could not be reached")]
    Network(String),
    /// HTTP 429, with the pause its `Retry-After` asked for.
    #[error("SRN asked for a pause of {seconds} s")]
    RateLimited { seconds: u64 },
    /// HTTP 401 to a request that carried a token: SpaceRing no longer
    /// accepts it (revoked, expired, or never known).
    #[error("SRN no longer accepts this sign-in")]
    Unauthorized,
    /// Any other answer that is not a success — a 3xx (never followed), a
    /// 4xx, a 5xx — with the `error` code its JSON body named, if it named
    /// one Codeg could keep.
    #[error("SRN answered HTTP {status}")]
    Status { status: u16, error: Option<String> },
    /// A success that is not what was asked for. The text is Codeg's own
    /// description of what was wrong, never a piece of the answer.
    #[error("SRN's answer is not what was asked for: {0}")]
    InvalidResponse(&'static str),
}

impl SrnError {
    /// Whether SpaceRing answered at all. What the online check's throttle
    /// counts: a check that reached SpaceRing waits its hour; one that did
    /// not may try again sooner.
    pub fn is_answer(&self) -> bool {
        !matches!(self, Self::Network(_))
    }

    fn error_code(&self) -> Option<&str> {
        match self {
            Self::Status { error, .. } => error.as_deref(),
            _ => None,
        }
    }
}

/// What the account reports. Each is one i18n key and one stable code; the
/// table in `/tmp/codeg-briefs/b1-api.md` says when each occurs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Problem {
    /// SpaceRing could not be reached.
    Network { detail: String },
    /// SpaceRing asked for a pause. Params: `seconds`.
    RateLimited { seconds: u64 },
    /// SpaceRing answered with an error. Params: `status`.
    Server { status: u16 },
    /// SpaceRing's answer could not be used.
    InvalidResponse { detail: String },
    /// SpaceRing does not know this build's client (`invalid_client`).
    ClientRejected,
    /// SpaceRing refused the code (`invalid_grant`), or the exchange was
    /// otherwise not completed: the sign-in has to start again.
    ExchangeFailed,
    /// The browser came back with `error=access_denied`: the person declined.
    AccessDenied,
    /// Ten minutes passed without the browser coming back.
    Expired,
    /// The account is not the one expected: `/me` named another SRN than the
    /// exchange did, or the command named an SRN that is no longer signed in.
    AccountChanged,
    /// The keychain would not give the stored sign-in back.
    KeychainRead { detail: String },
    /// The keychain would not keep the token: the sign-in did not complete.
    KeychainWrite { detail: String },
    /// The keychain would not remove the token: nothing was signed out.
    KeychainDelete { detail: String },
    /// A sign-in that ended after its token was kept (cancelled, replaced,
    /// refused, or ended by SpaceRing) could not be removed from the
    /// keychain. Signed out all the same; signing out removes it.
    KeychainCleanup { detail: String },
    /// What the keychain holds is not a sign-in this Codeg can read.
    CredentialInvalid,
    /// SpaceRing answered 401: the connection has ended (removed on the
    /// website, expired, or revoked). The sign-in here is cleared.
    Revoked,
    /// Signed out on this computer, but SpaceRing did not confirm the
    /// connection ended. Params: `url` (where to remove it), `reason` (the
    /// code of why it was not confirmed).
    SignedOutLocally { url: String, reason: Box<Problem> },
    /// A sign-in was asked for while one is signed in.
    AlreadySignedIn,
    /// "Open the page again" with no sign-in waiting for the browser.
    NoPendingSignIn,
    /// The system browser could not be opened. The sign-in is still waiting:
    /// its link can be copied.
    OpenBrowser,
    /// Codeg could not listen on `127.0.0.1` for the browser's return.
    Loopback { detail: String },
    /// Something in Codeg itself failed (no random bytes, a task that did not
    /// run).
    Internal { detail: String },
}

impl Problem {
    /// The stable code: `i18n_params.code`.
    pub fn code(&self) -> &'static str {
        match self {
            Self::Network { .. } => "network",
            Self::RateLimited { .. } => "rate_limited",
            Self::Server { .. } => "server",
            Self::InvalidResponse { .. } => "invalid_response",
            Self::ClientRejected => "client_rejected",
            Self::ExchangeFailed => "exchange_failed",
            Self::AccessDenied => "access_denied",
            Self::Expired => "expired",
            Self::AccountChanged => "account_changed",
            Self::KeychainRead { .. } => "keychain_read_failed",
            Self::KeychainWrite { .. } => "keychain_write_failed",
            Self::KeychainDelete { .. } => "keychain_delete_failed",
            Self::KeychainCleanup { .. } => "keychain_cleanup_failed",
            Self::CredentialInvalid => "credential_invalid",
            Self::Revoked => "revoked",
            Self::SignedOutLocally { .. } => "signed_out_locally",
            Self::AlreadySignedIn => "already_signed_in",
            Self::NoPendingSignIn => "no_pending_sign_in",
            Self::OpenBrowser => "open_browser_failed",
            Self::Loopback { .. } => "loopback_failed",
            Self::Internal { .. } => "internal",
        }
    }

    /// The last segment of the i18n key.
    fn key_name(&self) -> &'static str {
        match self {
            Self::Network { .. } => "network",
            Self::RateLimited { .. } => "rateLimited",
            Self::Server { .. } => "server",
            Self::InvalidResponse { .. } => "invalidResponse",
            Self::ClientRejected => "clientRejected",
            Self::ExchangeFailed => "exchangeFailed",
            Self::AccessDenied => "accessDenied",
            Self::Expired => "expired",
            Self::AccountChanged => "accountChanged",
            Self::KeychainRead { .. } => "keychainRead",
            Self::KeychainWrite { .. } => "keychainWrite",
            Self::KeychainDelete { .. } => "keychainDelete",
            Self::KeychainCleanup { .. } => "keychainCleanup",
            Self::CredentialInvalid => "credentialInvalid",
            Self::Revoked => "revoked",
            Self::SignedOutLocally { .. } => "signedOutLocally",
            Self::AlreadySignedIn => "alreadySignedIn",
            Self::NoPendingSignIn => "noPendingSignIn",
            Self::OpenBrowser => "openBrowser",
            Self::Loopback { .. } => "loopback",
            Self::Internal { .. } => "internal",
        }
    }

    /// `SrnAccount.errors.<name>`.
    pub fn i18n_key(&self) -> String {
        format!("{I18N_NAMESPACE}.{}", self.key_name())
    }

    /// The English text, for a frontend without the key.
    fn message(&self) -> String {
        match self {
            Self::Network { .. } => "SRN could not be reached".into(),
            Self::RateLimited { seconds } => {
                format!("SRN asked Codeg to wait {seconds} s before trying again")
            }
            Self::Server { status } => format!("SRN answered HTTP {status}"),
            Self::InvalidResponse { .. } => "SRN's answer could not be used".into(),
            Self::ClientRejected => {
                "SRN does not recognise this Codeg client, or has turned it off".into()
            }
            Self::ExchangeFailed => "The sign-in could not be completed; start it again".into(),
            Self::AccessDenied => "The connection was declined in the browser".into(),
            Self::Expired => "The sign-in expired before the browser came back".into(),
            Self::AccountChanged => "The SRN account changed".into(),
            Self::KeychainRead { .. } => {
                "The sign-in stored in the keychain could not be read".into()
            }
            Self::KeychainWrite { .. } => {
                "The keychain did not keep the sign-in, so it did not complete".into()
            }
            Self::KeychainDelete { .. } => {
                "The keychain did not remove the sign-in, so nothing was signed out".into()
            }
            Self::KeychainCleanup { .. } => {
                "A sign-in that did not complete is still in the keychain; sign out to remove it"
                    .into()
            }
            Self::CredentialInvalid => {
                "The sign-in stored in the keychain is not readable by this Codeg".into()
            }
            Self::Revoked => "SRN ended this sign-in".into(),
            Self::SignedOutLocally { url, .. } => format!(
                "Signed out on this computer; SRN did not confirm. Remove the connection at {url}"
            ),
            Self::AlreadySignedIn => "Already signed in".into(),
            Self::NoPendingSignIn => "No sign-in is waiting for the browser".into(),
            Self::OpenBrowser => "The browser could not be opened".into(),
            Self::Loopback { .. } => "Codeg could not listen for the browser's return".into(),
            Self::Internal { .. } => "The sign-in could not run".into(),
        }
    }

    fn app_code(&self) -> AppErrorCode {
        match self {
            Self::Network { .. }
            | Self::RateLimited { .. }
            | Self::Server { .. }
            | Self::InvalidResponse { .. }
            | Self::SignedOutLocally { .. } => AppErrorCode::NetworkError,
            Self::ClientRejected | Self::CredentialInvalid => AppErrorCode::ConfigurationInvalid,
            Self::ExchangeFailed | Self::AccessDenied | Self::Revoked => {
                AppErrorCode::PermissionDenied
            }
            Self::Expired | Self::AccountChanged => AppErrorCode::InvalidInput,
            Self::KeychainRead { .. }
            | Self::KeychainWrite { .. }
            | Self::KeychainDelete { .. }
            | Self::KeychainCleanup { .. }
            | Self::Loopback { .. } => AppErrorCode::IoError,
            Self::AlreadySignedIn => AppErrorCode::AlreadyExists,
            Self::NoPendingSignIn => AppErrorCode::NotFound,
            Self::OpenBrowser => AppErrorCode::ExternalCommandFailed,
            Self::Internal { .. } => AppErrorCode::TaskExecutionFailed,
        }
    }

    fn params(&self) -> BTreeMap<String, String> {
        let mut params = BTreeMap::new();
        params.insert("code".to_string(), self.code().to_string());
        match self {
            Self::RateLimited { seconds } => {
                params.insert("seconds".to_string(), seconds.to_string());
            }
            Self::Server { status } => {
                params.insert("status".to_string(), status.to_string());
            }
            Self::SignedOutLocally { url, reason } => {
                params.insert("url".to_string(), url.clone());
                params.insert("reason".to_string(), reason.code().to_string());
                for (name, value) in reason.params() {
                    if name != "code" {
                        params.entry(name).or_insert(value);
                    }
                }
            }
            _ => {}
        }
        params
    }

    fn detail(&self) -> Option<&str> {
        match self {
            Self::Network { detail }
            | Self::InvalidResponse { detail }
            | Self::KeychainRead { detail }
            | Self::KeychainWrite { detail }
            | Self::KeychainDelete { detail }
            | Self::KeychainCleanup { detail }
            | Self::Loopback { detail }
            | Self::Internal { detail } => Some(detail.as_str()),
            Self::SignedOutLocally { reason, .. } => reason.detail(),
            _ => None,
        }
        .filter(|detail| !detail.is_empty())
    }

    /// As the frontend receives it.
    pub fn to_app_error(&self) -> AppCommandError {
        let error = AppCommandError::new(self.app_code(), self.message())
            .with_i18n(self.i18n_key(), self.params());
        match self.detail() {
            Some(detail) => error.with_detail(detail),
            None => error,
        }
    }

    /// A login request that could not be created.
    pub fn from_request(error: SrnError) -> Self {
        match error {
            SrnError::Status { status: 401, .. } => Self::ClientRejected,
            ref other if other.error_code() == Some("invalid_client") => Self::ClientRejected,
            other => Self::from_transport(other),
        }
    }

    /// A code exchange that did not give a token. It is never repeated: a
    /// code is used once, and one presented again ends the connection it
    /// opened.
    pub fn from_exchange(error: SrnError) -> Self {
        match error {
            SrnError::Status { status: 401, .. } => Self::ClientRejected,
            ref other if other.error_code() == Some("invalid_client") => Self::ClientRejected,
            SrnError::Status { status: 400, .. } => Self::ExchangeFailed,
            other => Self::from_transport(other),
        }
    }

    /// A `/me` that did not confirm the account.
    pub fn from_check(error: SrnError) -> Self {
        Self::from_transport(error)
    }

    fn from_transport(error: SrnError) -> Self {
        match error {
            SrnError::Network(detail) => Self::Network { detail },
            SrnError::RateLimited { seconds } => Self::RateLimited { seconds },
            SrnError::Unauthorized => Self::Revoked,
            SrnError::Status { status, .. } => Self::Server { status },
            SrnError::InvalidResponse(what) => Self::InvalidResponse {
                detail: what.to_string(),
            },
        }
    }
}

impl From<Problem> for AppCommandError {
    fn from(problem: Problem) -> Self {
        problem.to_app_error()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};

    fn wire(problem: &Problem) -> Value {
        serde_json::to_value(problem.to_app_error()).unwrap()
    }

    fn every_problem() -> Vec<Problem> {
        vec![
            Problem::Network {
                detail: "dns".into(),
            },
            Problem::RateLimited { seconds: 60 },
            Problem::Server { status: 503 },
            Problem::InvalidResponse {
                detail: "not JSON".into(),
            },
            Problem::ClientRejected,
            Problem::ExchangeFailed,
            Problem::AccessDenied,
            Problem::Expired,
            Problem::AccountChanged,
            Problem::KeychainRead {
                detail: "locked".into(),
            },
            Problem::KeychainWrite {
                detail: "locked".into(),
            },
            Problem::KeychainDelete {
                detail: "locked".into(),
            },
            Problem::KeychainCleanup {
                detail: "locked".into(),
            },
            Problem::CredentialInvalid,
            Problem::Revoked,
            Problem::SignedOutLocally {
                url: "https://spacering.net/console/clients/".into(),
                reason: Box::new(Problem::Server { status: 502 }),
            },
            Problem::AlreadySignedIn,
            Problem::NoPendingSignIn,
            Problem::OpenBrowser,
            Problem::Loopback {
                detail: "in use".into(),
            },
            Problem::Internal {
                detail: "rng".into(),
            },
        ]
    }

    #[test]
    fn every_problem_has_a_key_a_code_and_a_message() {
        let problems = every_problem();
        let mut keys = std::collections::BTreeSet::new();
        let mut codes = std::collections::BTreeSet::new();
        for problem in &problems {
            let sent = wire(problem);
            let key = sent["i18n_key"].as_str().unwrap().to_string();
            assert!(key.starts_with("SrnAccount.errors."), "{key}");
            assert_eq!(sent["i18n_params"]["code"], problem.code(), "{problem:?}");
            let message = sent["message"].as_str().unwrap();
            assert!(!message.is_empty());
            // the product a person reads about is SRN
            assert!(!message.contains("SpaceRing"), "{message}");
            keys.insert(key);
            codes.insert(problem.code());
        }
        assert_eq!(keys.len(), problems.len(), "two problems share a key");
        assert_eq!(codes.len(), problems.len(), "two problems share a code");
    }

    #[test]
    fn the_keys_the_popover_explains_are_these() {
        let key = |p: Problem| p.i18n_key();
        assert_eq!(
            key(Problem::KeychainRead { detail: "x".into() }),
            "SrnAccount.errors.keychainRead"
        );
        assert_eq!(
            key(Problem::KeychainWrite { detail: "x".into() }),
            "SrnAccount.errors.keychainWrite"
        );
        assert_eq!(key(Problem::Expired), "SrnAccount.errors.expired");
        assert_eq!(key(Problem::AccessDenied), "SrnAccount.errors.accessDenied");
        assert_eq!(
            key(Problem::AccountChanged),
            "SrnAccount.errors.accountChanged"
        );
        assert_eq!(Problem::AccountChanged.code(), "account_changed");
        assert_eq!(
            key(Problem::SignedOutLocally {
                url: String::new(),
                reason: Box::new(Problem::Network {
                    detail: String::new()
                })
            }),
            "SrnAccount.errors.signedOutLocally"
        );
    }

    #[test]
    fn numbers_and_the_address_travel_as_params() {
        assert_eq!(
            wire(&Problem::RateLimited { seconds: 42 })["i18n_params"],
            json!({ "code": "rate_limited", "seconds": "42" })
        );
        assert_eq!(
            wire(&Problem::Server { status: 503 })["i18n_params"],
            json!({ "code": "server", "status": "503" })
        );
        let local = wire(&Problem::SignedOutLocally {
            url: "https://spacering.net/zh/console/clients/".into(),
            reason: Box::new(Problem::RateLimited { seconds: 60 }),
        });
        assert_eq!(
            local["i18n_params"],
            json!({
                "code": "signed_out_locally",
                "url": "https://spacering.net/zh/console/clients/",
                "reason": "rate_limited",
                "seconds": "60",
            })
        );
        assert_eq!(local["code"], "network_error");
    }

    #[test]
    fn the_platform_s_account_is_the_detail() {
        let sent = wire(&Problem::KeychainRead {
            detail: "keyring get error: locked".into(),
        });
        assert_eq!(sent["detail"], "keyring get error: locked");
        assert!(wire(&Problem::Network {
            detail: String::new()
        })
        .get("detail")
        .is_none());
        assert!(wire(&Problem::Expired).get("detail").is_none());
    }

    #[test]
    fn api_failures_are_named_by_where_they_happened() {
        let status = |status: u16, error: Option<&str>| SrnError::Status {
            status,
            error: error.map(str::to_string),
        };
        assert_eq!(
            Problem::from_request(status(401, Some("invalid_client"))),
            Problem::ClientRejected
        );
        assert_eq!(
            Problem::from_request(status(400, Some("invalid_request"))),
            Problem::Server { status: 400 }
        );
        assert_eq!(
            Problem::from_exchange(status(400, Some("invalid_grant"))),
            Problem::ExchangeFailed
        );
        assert_eq!(
            Problem::from_exchange(status(401, Some("invalid_client"))),
            Problem::ClientRejected
        );
        assert_eq!(
            Problem::from_exchange(status(500, Some("server_error"))),
            Problem::Server { status: 500 }
        );
        assert_eq!(
            Problem::from_exchange(SrnError::Network("timed out".into())),
            Problem::Network {
                detail: "timed out".into()
            }
        );
        assert_eq!(
            Problem::from_check(SrnError::Unauthorized),
            Problem::Revoked
        );
        assert_eq!(
            Problem::from_check(SrnError::RateLimited { seconds: 9 }),
            Problem::RateLimited { seconds: 9 }
        );
        assert!(!SrnError::Network("x".into()).is_answer());
        assert!(SrnError::Status {
            status: 503,
            error: None
        }
        .is_answer());
        assert!(SrnError::RateLimited { seconds: 1 }.is_answer());
    }
}
