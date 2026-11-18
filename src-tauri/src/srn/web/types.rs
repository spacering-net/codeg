//! Codeg Web's SRN account as the browser sees it: what the account routes
//! answer, the problems they report, and the `?srn=` result of a sign-in.
//! `/tmp/codeg-briefs/w2-api.md` is the reference for the status bar's Web
//! branch (W3).
//!
//! The shapes follow the desktop's (`srn::types`) wherever the two mean the
//! same thing, and the problems share its i18n namespace and keys
//! (`SrnAccount.errors.*`), so one popover renders both. None of it holds a
//! token, a code, a verifier, a state, a cookie or the client secret. The one
//! secret-ish value is a pending sign-in's `authorizationUrl`, whose fragment
//! holds the request ID; only the browser that started the sign-in gets it.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::app_error::{AppCommandError, AppErrorCode};
use crate::models::system::AppLocale;
use crate::srn::error::{Problem, I18N_NAMESPACE};

/// Who is signed in, as shown. As the desktop's `SrnIdentity`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SrnIdentity {
    pub srn: u64,
    /// May be empty: show `SRN <srn>` then.
    pub name: String,
    /// `/api/avatars/<id>/<file>` on SpaceRing, for the image proxy
    /// (`srn_asset`); `null` for none.
    pub avatar_path: Option<String>,
}

/// As the desktop's `OnlineStatus`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum OnlineStatus {
    Unchecked,
    Confirmed,
    Unconfirmed,
}

/// As the desktop's `SrnOnline`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SrnOnline {
    pub status: OnlineStatus,
    /// A check is under way in this server for this session.
    pub checking: bool,
    /// When the last check ended (RFC 3339, UTC).
    pub checked_at: Option<String>,
    /// When SpaceRing last confirmed the account.
    pub confirmed_at: Option<String>,
    /// Why the last check did not confirm it (`unconfirmed` only).
    pub problem: Option<AppCommandError>,
}

/// This browser's SRN account on this instance (`GET /api/account/srn`).
#[derive(Debug, Clone, Serialize)]
#[serde(
    tag = "status",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum SrnWebAccountState {
    /// This server has no SRN sign-in configured (or its configuration is
    /// invalid). Instance access is not affected.
    NotEnabled,
    /// This browser is not signed in. `problem` says why, when it was and is
    /// no longer: `revoked`, `accountChanged`, `sessionUnreadable`.
    SignedOut {
        #[serde(skip_serializing_if = "Option::is_none")]
        problem: Option<AppCommandError>,
    },
    /// This browser started a sign-in that has not come back yet.
    Pending {
        /// SpaceRing's authorization page: "open the page again".
        authorization_url: String,
        /// When the sign-in gives up (RFC 3339, UTC).
        expires_at: String,
    },
    SignedIn {
        account: SrnIdentity,
        online: SrnOnline,
    },
    /// The server cannot tell right now: its key or its database would not
    /// open. Not "signed out" — nothing was removed.
    Unavailable { problem: AppCommandError },
}

/// `POST /api/account/srn/login`'s answer.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SrnWebLoginStarted {
    /// Where to send this tab (`location.assign`).
    pub authorization_url: String,
    /// When the sign-in gives up (RFC 3339, UTC).
    pub expires_at: String,
}

/// As the desktop's `RemoteSignOut`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum RemoteSignOut {
    Confirmed,
    Unconfirmed,
    NotSignedIn,
}

/// `POST /api/account/srn/logout`'s answer. As the desktop's
/// `SrnSignOutResult`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SrnWebSignOutResult {
    /// Always `signedOut`.
    pub state: SrnWebAccountState,
    pub remote: RemoteSignOut,
    /// `unconfirmed` only: the website's connection list.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub manage_connections_url: Option<String>,
    /// `unconfirmed` only: `signedOutLocally` with `url` and `reason`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub problem: Option<AppCommandError>,
}

/// `POST /api/account/srn/login`'s body.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LoginBody {
    /// The interface's language: Chinese opens SpaceRing's Chinese page.
    #[serde(default)]
    pub locale: Option<AppLocale>,
}

/// `POST /api/account/srn/logout`'s body.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LogoutBody {
    /// The SRN the popover shows: another one signed in is `accountChanged`,
    /// and nothing happens.
    #[serde(default)]
    pub expected_srn: Option<u64>,
    #[serde(default)]
    pub locale: Option<AppLocale>,
}

/// What Codeg Web's sign-in reports. The problems the desktop also has are
/// its [`Problem`]s, with the same keys; the rest are the Web's own, in the
/// same namespace.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WebProblem {
    Shared(Problem),
    /// The server has no SRN sign-in configured.
    NotEnabled,
    /// A request to `login`/`logout` whose `Origin` is not exactly the
    /// configured public URL.
    OriginRefused,
    /// A request to `login`/`logout` that is not JSON (or not the JSON
    /// expected).
    InvalidRequest,
    /// The browser came back without the sign-in cookie this browser was
    /// given when it started (cookies blocked, another browser or profile,
    /// a different host name).
    FlowMissing,
    /// The address SpaceRing sent the browser back to is not one a sign-in
    /// ends with.
    InvalidCallback,
    /// The session kept here could not be read (sealed under a key this
    /// server no longer has): it was removed.
    SessionUnreadable,
    /// The key that seals sign-ins could not be loaded.
    KeyUnavailable {
        detail: String,
    },
    /// The database did not answer.
    Storage {
        detail: String,
    },
}

impl From<Problem> for WebProblem {
    fn from(problem: Problem) -> Self {
        Self::Shared(problem)
    }
}

impl WebProblem {
    /// The stable code: `i18n_params.code`, and a sign-in's `?srn=` value.
    pub fn code(&self) -> &'static str {
        match self {
            Self::Shared(problem) => problem.code(),
            Self::NotEnabled => "not_enabled",
            Self::OriginRefused => "origin_refused",
            Self::InvalidRequest => "invalid_request",
            Self::FlowMissing => "flow_missing",
            Self::InvalidCallback => "invalid_callback",
            Self::SessionUnreadable => "session_unreadable",
            Self::KeyUnavailable { .. } => "key_unavailable",
            Self::Storage { .. } => "storage_failed",
        }
    }

    pub fn i18n_key(&self) -> String {
        match self {
            Self::Shared(problem) => problem.i18n_key(),
            other => format!("{I18N_NAMESPACE}.{}", other.key_name()),
        }
    }

    fn key_name(&self) -> &'static str {
        match self {
            Self::Shared(_) => "",
            Self::NotEnabled => "notEnabled",
            Self::OriginRefused => "originRefused",
            Self::InvalidRequest => "invalidRequest",
            Self::FlowMissing => "flowMissing",
            Self::InvalidCallback => "invalidCallback",
            Self::SessionUnreadable => "sessionUnreadable",
            Self::KeyUnavailable { .. } => "keyUnavailable",
            Self::Storage { .. } => "storage",
        }
    }

    fn message(&self) -> &'static str {
        match self {
            Self::Shared(_) => "",
            Self::NotEnabled => "This server has not enabled SRN sign-in",
            Self::OriginRefused => "The request did not come from this server's page",
            Self::InvalidRequest => "The request is not the one expected",
            Self::FlowMissing => {
                "The browser came back without this sign-in's cookie; start the sign-in again in \
                 this browser"
            }
            Self::InvalidCallback => "The sign-in came back incomplete; start it again",
            Self::SessionUnreadable => {
                "The sign-in kept on this server could not be read; sign in again"
            }
            Self::KeyUnavailable { .. } => {
                "The server could not open the key it keeps sign-ins with"
            }
            Self::Storage { .. } => "The server's database did not answer",
        }
    }

    fn app_code(&self) -> AppErrorCode {
        match self {
            Self::Shared(_) => AppErrorCode::TaskExecutionFailed,
            Self::NotEnabled => AppErrorCode::ConfigurationMissing,
            Self::OriginRefused => AppErrorCode::PermissionDenied,
            Self::InvalidRequest | Self::FlowMissing | Self::InvalidCallback => {
                AppErrorCode::InvalidInput
            }
            Self::SessionUnreadable => AppErrorCode::ConfigurationInvalid,
            Self::KeyUnavailable { .. } => AppErrorCode::IoError,
            Self::Storage { .. } => AppErrorCode::DatabaseError,
        }
    }

    /// As the browser receives it.
    pub fn to_app_error(&self) -> AppCommandError {
        if let Self::Shared(problem) = self {
            return problem.to_app_error();
        }
        let mut params = BTreeMap::new();
        params.insert("code".to_string(), self.code().to_string());
        let error = AppCommandError::new(self.app_code(), self.message())
            .with_i18n(self.i18n_key(), params);
        match self {
            Self::KeyUnavailable { detail } | Self::Storage { detail } if !detail.is_empty() => {
                error.with_detail(detail.clone())
            }
            _ => error,
        }
    }
}

/// The `?srn=` values a sign-in can end with: `ok`, or one of these codes.
/// Nothing else is ever written into that address.
pub const CALLBACK_RESULTS: &[&str] = &[
    "ok",
    // the person declined on SpaceRing
    "access_denied",
    // no sign-in waiting for this browser matched: expired, already used,
    // or started elsewhere
    "expired",
    "flow_missing",
    "invalid_callback",
    // SpaceRing refused the code
    "exchange_failed",
    // SpaceRing does not know this instance's client (or its secret)
    "client_rejected",
    "network",
    "rate_limited",
    "server",
    "invalid_response",
    // `/me` named another account than the exchange
    "account_changed",
    // `/me` refused the new token
    "revoked",
    "not_enabled",
    "key_unavailable",
    "storage_failed",
    "internal",
];

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn web_only() -> Vec<WebProblem> {
        vec![
            WebProblem::NotEnabled,
            WebProblem::OriginRefused,
            WebProblem::InvalidRequest,
            WebProblem::FlowMissing,
            WebProblem::InvalidCallback,
            WebProblem::SessionUnreadable,
            WebProblem::KeyUnavailable {
                detail: "locked".into(),
            },
            WebProblem::Storage {
                detail: "busy".into(),
            },
        ]
    }

    /// The desktop's problems, by code and key, as `srn::error` defines them.
    fn desktop_problems() -> Vec<Problem> {
        vec![
            Problem::Network {
                detail: String::new(),
            },
            Problem::RateLimited { seconds: 1 },
            Problem::Server { status: 500 },
            Problem::InvalidResponse {
                detail: String::new(),
            },
            Problem::ClientRejected,
            Problem::ExchangeFailed,
            Problem::AccessDenied,
            Problem::Expired,
            Problem::AccountChanged,
            Problem::KeychainRead {
                detail: String::new(),
            },
            Problem::KeychainWrite {
                detail: String::new(),
            },
            Problem::KeychainDelete {
                detail: String::new(),
            },
            Problem::CredentialInvalid,
            Problem::Revoked,
            Problem::SignedOutLocally {
                url: String::new(),
                reason: Box::new(Problem::Revoked),
            },
            Problem::AlreadySignedIn,
            Problem::NoPendingSignIn,
            Problem::OpenBrowser,
            Problem::Loopback {
                detail: String::new(),
            },
            Problem::Internal {
                detail: String::new(),
            },
        ]
    }

    #[test]
    fn the_web_s_own_problems_are_new_keys_and_codes_in_the_shared_namespace() {
        let desktop_keys: Vec<String> = desktop_problems().iter().map(Problem::i18n_key).collect();
        let desktop_codes: Vec<&str> = desktop_problems().iter().map(Problem::code).collect();
        let mut seen = std::collections::BTreeSet::new();
        for problem in web_only() {
            let sent = serde_json::to_value(problem.to_app_error()).unwrap();
            let key = sent["i18n_key"].as_str().unwrap().to_string();
            assert!(key.starts_with("SrnAccount.errors."), "{key}");
            assert!(!desktop_keys.contains(&key), "{key} is the desktop's");
            assert!(
                !desktop_codes.contains(&problem.code()),
                "{}",
                problem.code()
            );
            assert_eq!(sent["i18n_params"], json!({ "code": problem.code() }));
            assert!(!sent["message"].as_str().unwrap().is_empty());
            assert!(seen.insert(key));
        }
        // a shared one is exactly the desktop's
        assert_eq!(
            serde_json::to_value(WebProblem::from(Problem::Revoked).to_app_error()).unwrap(),
            serde_json::to_value(Problem::Revoked.to_app_error()).unwrap()
        );
    }

    #[test]
    fn every_problem_a_sign_in_can_end_with_is_a_callback_result() {
        for problem in web_only() {
            if !matches!(
                problem,
                WebProblem::OriginRefused
                    | WebProblem::InvalidRequest
                    | WebProblem::SessionUnreadable
            ) {
                assert!(
                    CALLBACK_RESULTS.contains(&problem.code()),
                    "{}",
                    problem.code()
                );
            }
        }
        for code in [
            "access_denied",
            "expired",
            "exchange_failed",
            "client_rejected",
            "network",
            "rate_limited",
            "server",
            "invalid_response",
            "account_changed",
            "revoked",
            "internal",
        ] {
            assert!(
                desktop_problems().iter().any(|p| p.code() == code),
                "{code}"
            );
            assert!(CALLBACK_RESULTS.contains(&code), "{code}");
        }
        for code in CALLBACK_RESULTS {
            assert!(code.bytes().all(|b| b.is_ascii_lowercase() || b == b'_'));
        }
    }

    #[test]
    fn states_serialize_as_the_desktop_s_do() {
        let state = SrnWebAccountState::Pending {
            authorization_url: "https://spacering.net/authorize/#request_id=x".into(),
            expires_at: "2026-11-16T00:10:00.000Z".into(),
        };
        assert_eq!(
            serde_json::to_value(&state).unwrap(),
            json!({
                "status": "pending",
                "authorizationUrl": "https://spacering.net/authorize/#request_id=x",
                "expiresAt": "2026-11-16T00:10:00.000Z",
            })
        );
        assert_eq!(
            serde_json::to_value(SrnWebAccountState::NotEnabled).unwrap(),
            json!({ "status": "notEnabled" })
        );
        assert_eq!(
            serde_json::to_value(SrnWebAccountState::SignedOut { problem: None }).unwrap(),
            json!({ "status": "signedOut" })
        );
        let body: LogoutBody =
            serde_json::from_value(json!({ "expectedSrn": 10000, "locale": "zh_cn" })).unwrap();
        assert_eq!(body.expected_srn, Some(10000));
        assert_eq!(body.locale, Some(AppLocale::ZhCn));
        assert!(serde_json::from_value::<LoginBody>(json!({ "redirect": "x" })).is_err());
    }
}
