//! Why a Harness request failed, and how that reaches the frontend.
//!
//! Each failure is an [`AppCommandError`] carrying an i18n key under
//! `Harness.errors.` and, where the message has a number in it, the number as
//! a param. The Discover section sorts failures by that key
//! (`src/lib/harness/errors.ts`), so the keys are a wire contract: renaming one
//! silently demotes its message to the generic failure text.

use std::collections::BTreeMap;

use crate::app_error::{AppCommandError, AppErrorCode};

/// `CODEG_HARNESS=off`. No params.
pub const I18N_KEY_DISABLED: &str = "Harness.errors.disabled";
/// SpaceRing could not be reached: offline, DNS, TLS, a timeout. No params.
pub const I18N_KEY_NETWORK: &str = "Harness.errors.network";
/// HTTP 429. Params: `seconds`.
pub const I18N_KEY_RATE_LIMITED: &str = "Harness.errors.rateLimited";
/// HTTP 404. No params.
pub const I18N_KEY_NOT_FOUND: &str = "Harness.errors.notFound";
/// A malformed `itemRef`, `path` or `sha256`. No params.
pub const I18N_KEY_INVALID_REF: &str = "Harness.errors.invalidRef";
/// Any other answer that is not a success. Params: `status`.
pub const I18N_KEY_SERVER: &str = "Harness.errors.server";
/// The answer is over the size cap (for `harness_blob`, 256 KiB). No params.
pub const I18N_KEY_TOO_LARGE: &str = "Harness.errors.tooLarge";
/// The answer is not what was asked for (for `harness_blob`: not the file
/// the hash names, or not UTF-8 text). No params.
pub const I18N_KEY_INVALID_RESPONSE: &str = "Harness.errors.invalidResponse";
/// SpaceRing cannot confirm an item's current state: `POST /resolve` is not
/// there (answered 404). Nothing was installed. No params.
pub const I18N_KEY_RESOLVE_UNAVAILABLE: &str = "Harness.errors.resolveUnavailable";

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum HarnessError {
    /// The operator switched the catalog off; no request was made.
    #[error("Harness is switched off on this Codeg (CODEG_HARNESS=off)")]
    Disabled,
    /// The request did not get an answer. The text is the transport's own
    /// account, for the log and the error's `detail`.
    #[error("SRN Harness could not be reached")]
    Network(String),
    /// SpaceRing asked to be left alone for this long. Also what a request
    /// gets, unsent, while that time has not passed.
    #[error("SRN Harness asked for a pause of {seconds} s between requests")]
    RateLimited { seconds: u64 },
    #[error("SRN Harness has nothing at this address")]
    NotFound,
    /// An item address, an image path or a file's hash that cannot be one;
    /// no request was made.
    #[error("Not a Harness address")]
    InvalidRef,
    #[error("SRN Harness answered HTTP {status}")]
    Server { status: u16 },
    #[error("The answer from SRN Harness is larger than Codeg accepts")]
    TooLarge,
    /// The answer arrived but is not what this request is answered with. The
    /// text says what was wrong, for the log and the error's `detail`.
    #[error("The answer from SRN Harness is not what was asked for")]
    InvalidResponse(String),
    /// `POST /resolve` answered 404. `/resolve` never answers that for an
    /// item — one it does not have comes back in the body as `unavailable` —
    /// so the endpoint itself is not there (a site that does not serve it
    /// yet): an item's current state cannot be confirmed.
    #[error("SRN Harness cannot confirm this item's current state right now")]
    ResolveUnavailable,
}

impl HarnessError {
    pub fn i18n_key(&self) -> &'static str {
        match self {
            Self::Disabled => I18N_KEY_DISABLED,
            Self::Network(_) => I18N_KEY_NETWORK,
            Self::RateLimited { .. } => I18N_KEY_RATE_LIMITED,
            Self::NotFound => I18N_KEY_NOT_FOUND,
            Self::InvalidRef => I18N_KEY_INVALID_REF,
            Self::Server { .. } => I18N_KEY_SERVER,
            Self::TooLarge => I18N_KEY_TOO_LARGE,
            Self::InvalidResponse(_) => I18N_KEY_INVALID_RESPONSE,
            Self::ResolveUnavailable => I18N_KEY_RESOLVE_UNAVAILABLE,
        }
    }

    pub(crate) fn invalid_response(what: impl Into<String>) -> Self {
        Self::InvalidResponse(what.into())
    }
}

impl From<HarnessError> for AppCommandError {
    fn from(error: HarnessError) -> Self {
        // The code decides the HTTP status a web client sees
        // (`web/handlers/error.rs`); none of these is a 401, which the web
        // client would read as its own session having ended.
        let code = match &error {
            HarnessError::Disabled => AppErrorCode::PermissionDenied,
            HarnessError::NotFound => AppErrorCode::NotFound,
            HarnessError::InvalidRef => AppErrorCode::InvalidInput,
            HarnessError::Network(_)
            | HarnessError::RateLimited { .. }
            | HarnessError::Server { .. }
            | HarnessError::TooLarge
            | HarnessError::InvalidResponse(_)
            | HarnessError::ResolveUnavailable => AppErrorCode::NetworkError,
        };
        let mut params = BTreeMap::new();
        let mut detail = None;
        match &error {
            HarnessError::RateLimited { seconds } => {
                params.insert("seconds".to_string(), seconds.to_string());
            }
            HarnessError::Server { status } => {
                params.insert("status".to_string(), status.to_string());
            }
            HarnessError::Network(text) | HarnessError::InvalidResponse(text) => {
                detail = Some(text.clone());
            }
            HarnessError::Disabled
            | HarnessError::NotFound
            | HarnessError::InvalidRef
            | HarnessError::TooLarge
            | HarnessError::ResolveUnavailable => {}
        }
        let mut converted =
            AppCommandError::new(code, error.to_string()).with_i18n(error.i18n_key(), params);
        if let Some(detail) = detail.filter(|text| !text.is_empty()) {
            converted = converted.with_detail(detail);
        }
        converted
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};

    /// What the frontend reads is the JSON, so the keys and params are checked
    /// there: `skip_serializing_if` makes a conversion that forgot one look
    /// the same from Rust.
    fn wire(error: HarnessError) -> Value {
        serde_json::to_value(AppCommandError::from(error)).unwrap()
    }

    #[test]
    fn every_failure_carries_its_key_and_its_numbers() {
        let cases = [
            (
                HarnessError::Disabled,
                "Harness.errors.disabled",
                json!(null),
            ),
            (
                HarnessError::Network("dns".into()),
                "Harness.errors.network",
                json!(null),
            ),
            (
                HarnessError::RateLimited { seconds: 42 },
                "Harness.errors.rateLimited",
                json!({ "seconds": "42" }),
            ),
            (
                HarnessError::NotFound,
                "Harness.errors.notFound",
                json!(null),
            ),
            (
                HarnessError::InvalidRef,
                "Harness.errors.invalidRef",
                json!(null),
            ),
            (
                HarnessError::Server { status: 503 },
                "Harness.errors.server",
                json!({ "status": "503" }),
            ),
            (
                HarnessError::TooLarge,
                "Harness.errors.tooLarge",
                json!(null),
            ),
            (
                HarnessError::InvalidResponse("not JSON".into()),
                "Harness.errors.invalidResponse",
                json!(null),
            ),
            (
                HarnessError::ResolveUnavailable,
                "Harness.errors.resolveUnavailable",
                json!(null),
            ),
        ];
        for (error, key, params) in cases {
            let sent = wire(error.clone());
            assert_eq!(sent["i18n_key"], key, "{error:?}");
            assert_eq!(sent["i18n_params"], params, "{error:?}");
            let message = sent["message"].as_str().unwrap();
            assert!(!message.is_empty(), "{error:?} has no fallback text");
            // the service a person reads about is SRN Harness
            assert!(!message.contains("SpaceRing"), "{message}");
        }
    }

    #[test]
    fn the_transport_s_account_travels_as_detail() {
        let sent = wire(HarnessError::Network("connection refused".into()));
        assert_eq!(sent["detail"], "connection refused");
        assert_eq!(sent["code"], "network_error");
        assert!(wire(HarnessError::Network(String::new()))
            .get("detail")
            .is_none());
    }

    #[test]
    fn codes_map_to_the_statuses_a_web_client_expects() {
        assert_eq!(wire(HarnessError::Disabled)["code"], "permission_denied");
        assert_eq!(wire(HarnessError::NotFound)["code"], "not_found");
        assert_eq!(
            wire(HarnessError::ResolveUnavailable)["code"],
            "network_error",
            "not the item's not-found"
        );
        assert_eq!(wire(HarnessError::InvalidRef)["code"], "invalid_input");
        assert_eq!(
            wire(HarnessError::RateLimited { seconds: 60 })["code"],
            "network_error"
        );
    }
}
