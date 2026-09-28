//! A minimal WebDAV client: exactly the four verbs config sync needs.
//!
//! Deliberately does NOT parse WebDAV XML. `PROPFIND` is used only as a
//! "are these credentials good and does this path exist" probe and `MKCOL`
//! only as "make sure this directory exists", so status codes carry all the
//! information we need — and skipping the bodies means no XML dependency for
//! a feature that moves two JSON files.
//!
//! ## Secrets never reach a log line
//!
//! The base URL can embed a username, and `Authorization` carries the
//! password. [`WebdavError`]'s `Display` is therefore built only from the
//! method, the RELATIVE path, and the status code — never from the URL, the
//! headers, or a `reqwest::Error` (whose own `Display` includes the full URL).
//! A test asserts a password cannot appear in a rendered error.

use std::fmt;
use std::time::Duration;

use reqwest::{Client, Method, Response, StatusCode, Url};

use crate::app_error::{
    AppCommandError, CONFIG_SYNC_I18N_KEY_FORBIDDEN, CONFIG_SYNC_I18N_KEY_NETWORK,
    CONFIG_SYNC_I18N_KEY_QUOTA, CONFIG_SYNC_I18N_KEY_REMOTE_PATH, CONFIG_SYNC_I18N_KEY_SERVER,
    CONFIG_SYNC_I18N_KEY_UNAUTHORIZED,
};

/// Credentials and reachability: short, because a wrong URL should fail while
/// the user is still looking at the settings page.
const PROBE_TIMEOUT: Duration = Duration::from_secs(15);
/// Transfers: generous. The payload is tens of KB, so this is tolerance for
/// slow consumer cloud drives, not for size.
const TRANSFER_TIMEOUT: Duration = Duration::from_secs(120);
/// Hard cap on a downloaded body. A config snapshot is tens of KB; anything
/// near this is a misconfigured path or a hostile endpoint, and we refuse it
/// rather than buffering it into memory.
const MAX_DOWNLOAD_BYTES: usize = 8 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WebdavError {
    /// The server URL is not a usable http(s) URL.
    InvalidUrl,
    /// 401 — on most consumer drives this means "you used your login password
    /// where an app password is required", which the UI says explicitly.
    Unauthorized,
    /// 403 — authenticated, but not allowed to touch this path.
    Forbidden,
    /// 404/409 on a write — the remote directory is missing and could not be
    /// created.
    RemotePathMissing,
    /// 507 / 413 — the share is full.
    InsufficientStorage,
    /// The response body exceeded [`MAX_DOWNLOAD_BYTES`].
    ResponseTooLarge,
    /// Never reached the server: DNS, TLS, timeout, offline.
    Network,
    /// Reached the server, got something we do not handle.
    Server(u16),
}

impl fmt::Display for WebdavError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidUrl => write!(f, "invalid WebDAV server URL"),
            Self::Unauthorized => write!(f, "WebDAV authentication failed (401)"),
            Self::Forbidden => write!(f, "WebDAV access denied (403)"),
            Self::RemotePathMissing => write!(f, "WebDAV remote directory unavailable"),
            Self::InsufficientStorage => write!(f, "WebDAV storage quota exceeded"),
            Self::ResponseTooLarge => write!(f, "WebDAV response exceeded the size limit"),
            Self::Network => write!(f, "WebDAV request did not reach the server"),
            Self::Server(status) => write!(f, "WebDAV server returned status {status}"),
        }
    }
}

impl std::error::Error for WebdavError {}

impl From<WebdavError> for AppCommandError {
    fn from(err: WebdavError) -> Self {
        let message = err.to_string();
        match err {
            WebdavError::InvalidUrl => AppCommandError::invalid_input(message)
                .with_i18n(CONFIG_SYNC_I18N_KEY_REMOTE_PATH, Default::default()),
            WebdavError::Unauthorized => AppCommandError::network(message)
                .with_i18n(CONFIG_SYNC_I18N_KEY_UNAUTHORIZED, Default::default()),
            WebdavError::Forbidden => AppCommandError::network(message)
                .with_i18n(CONFIG_SYNC_I18N_KEY_FORBIDDEN, Default::default()),
            WebdavError::RemotePathMissing => AppCommandError::network(message)
                .with_i18n(CONFIG_SYNC_I18N_KEY_REMOTE_PATH, Default::default()),
            WebdavError::InsufficientStorage => AppCommandError::network(message)
                .with_i18n(CONFIG_SYNC_I18N_KEY_QUOTA, Default::default()),
            WebdavError::Network | WebdavError::ResponseTooLarge => {
                AppCommandError::network(message)
                    .with_i18n(CONFIG_SYNC_I18N_KEY_NETWORK, Default::default())
            }
            WebdavError::Server(status) => {
                let mut params = std::collections::BTreeMap::new();
                params.insert("status".to_string(), status.to_string());
                AppCommandError::network(message)
                    .with_i18n(CONFIG_SYNC_I18N_KEY_SERVER, params)
            }
        }
    }
}

pub struct WebdavClient {
    http: Client,
    /// Always ends in `/` so relative segments append rather than replace the
    /// last path component.
    base: Url,
    username: String,
    password: String,
}

impl WebdavClient {
    pub fn new(
        server_url: &str,
        username: &str,
        password: &str,
    ) -> Result<Self, WebdavError> {
        let trimmed = server_url.trim();
        if trimmed.is_empty() {
            return Err(WebdavError::InvalidUrl);
        }
        let mut base = Url::parse(trimmed).map_err(|_| WebdavError::InvalidUrl)?;
        if !matches!(base.scheme(), "http" | "https") {
            return Err(WebdavError::InvalidUrl);
        }
        // `Url::join`-style appending drops the final segment unless the path
        // ends in a slash, which would silently write into the parent of the
        // directory the user configured.
        if !base.path().ends_with('/') {
            let path = format!("{}/", base.path());
            base.set_path(&path);
        }

        let http = Client::builder()
            .timeout(TRANSFER_TIMEOUT)
            .build()
            .map_err(|_| WebdavError::Network)?;

        Ok(Self {
            http,
            base,
            username: username.to_string(),
            password: password.to_string(),
        })
    }

    /// Percent-encodes each segment, so a profile named `my drive` or a
    /// non-ASCII directory works without the caller pre-encoding anything.
    fn url_for(&self, rel: &str) -> Result<Url, WebdavError> {
        let mut url = self.base.clone();
        {
            let mut segments = url
                .path_segments_mut()
                .map_err(|_| WebdavError::InvalidUrl)?;
            // `base` always ends in `/`, i.e. a trailing empty segment;
            // pushing onto it without dropping that would yield `/dav//codeg`.
            segments.pop_if_empty();
            for part in rel.split('/').filter(|s| !s.is_empty()) {
                segments.push(part);
            }
        }
        Ok(url)
    }

    async fn send(
        &self,
        method: Method,
        rel: &str,
        timeout: Duration,
        body: Option<Vec<u8>>,
        depth_zero: bool,
    ) -> Result<Response, WebdavError> {
        let url = self.url_for(rel)?;
        let mut request = self
            .http
            .request(method.clone(), url)
            .basic_auth(&self.username, Some(&self.password))
            .timeout(timeout);
        if depth_zero {
            request = request.header("Depth", "0");
        }
        if let Some(body) = body {
            request = request
                .header(reqwest::header::CONTENT_TYPE, "application/json")
                .body(body);
        }

        // The reqwest error is dropped on purpose: its Display carries the
        // full URL, which may embed the username.
        request.send().await.map_err(|err| {
            tracing::warn!(
                "[WEBDAV] {} /{} failed before a response (timeout: {})",
                method,
                rel,
                err.is_timeout()
            );
            WebdavError::Network
        })
    }

    /// Credentials + reachability check against the configured base URL.
    pub async fn probe(&self, rel: &str) -> Result<(), WebdavError> {
        let response = self
            .send(propfind_method(), rel, PROBE_TIMEOUT, None, true)
            .await?;
        let status = response.status();
        log_status("PROPFIND", rel, status);
        if status.is_success() || status == StatusCode::MULTI_STATUS {
            return Ok(());
        }
        // A missing directory is not a probe failure: `ensure_dir` creates it
        // on the first upload. Only credentials and reachability matter here.
        if status == StatusCode::NOT_FOUND {
            return Ok(());
        }
        Err(classify(status))
    }

    /// Creates every level of `rel`, tolerating levels that already exist.
    pub async fn ensure_dir(&self, rel: &str) -> Result<(), WebdavError> {
        let mut prefix = String::new();
        for part in rel.split('/').filter(|s| !s.is_empty()) {
            if !prefix.is_empty() {
                prefix.push('/');
            }
            prefix.push_str(part);

            let response = self
                .send(mkcol_method(), &prefix, PROBE_TIMEOUT, None, false)
                .await?;
            let status = response.status();
            log_status("MKCOL", &prefix, status);
            // 405 = already a collection. Some servers answer 301 for an
            // existing directory addressed without a trailing slash.
            if status.is_success()
                || status == StatusCode::METHOD_NOT_ALLOWED
                || status.is_redirection()
            {
                continue;
            }
            return Err(classify(status));
        }
        Ok(())
    }

    pub async fn put(&self, rel: &str, body: Vec<u8>) -> Result<(), WebdavError> {
        let response = self
            .send(Method::PUT, rel, TRANSFER_TIMEOUT, Some(body), false)
            .await?;
        let status = response.status();
        log_status("PUT", rel, status);
        if status.is_success() {
            return Ok(());
        }
        Err(classify(status))
    }

    /// `Ok(None)` means "not there yet" — the normal state of a share nobody
    /// has uploaded to, not an error.
    pub async fn get(&self, rel: &str) -> Result<Option<Vec<u8>>, WebdavError> {
        let response = self
            .send(Method::GET, rel, TRANSFER_TIMEOUT, None, false)
            .await?;
        let status = response.status();
        log_status("GET", rel, status);
        if status == StatusCode::NOT_FOUND {
            return Ok(None);
        }
        if !status.is_success() {
            return Err(classify(status));
        }

        // Check the declared length first (cheap), then enforce the cap while
        // streaming, because Content-Length is advisory.
        if let Some(len) = response.content_length() {
            if len > MAX_DOWNLOAD_BYTES as u64 {
                return Err(WebdavError::ResponseTooLarge);
            }
        }

        let mut response = response;
        let mut buffer: Vec<u8> = Vec::new();
        loop {
            let chunk = response.chunk().await.map_err(|_| WebdavError::Network)?;
            let Some(chunk) = chunk else { break };
            if buffer.len() + chunk.len() > MAX_DOWNLOAD_BYTES {
                return Err(WebdavError::ResponseTooLarge);
            }
            buffer.extend_from_slice(&chunk);
        }
        Ok(Some(buffer))
    }
}

fn propfind_method() -> Method {
    Method::from_bytes(b"PROPFIND").expect("PROPFIND is a valid method token")
}

fn mkcol_method() -> Method {
    Method::from_bytes(b"MKCOL").expect("MKCOL is a valid method token")
}

/// Only `{method} {rel} -> {status}`: no URL, no headers, no credentials.
fn log_status(method: &str, rel: &str, status: StatusCode) {
    tracing::debug!("[WEBDAV] {method} /{rel} -> {}", status.as_u16());
}

fn classify(status: StatusCode) -> WebdavError {
    match status {
        StatusCode::UNAUTHORIZED => WebdavError::Unauthorized,
        StatusCode::FORBIDDEN => WebdavError::Forbidden,
        // 409 on a write means the parent collection is missing; from the
        // user's point of view that is the same problem as a missing remote
        // directory.
        StatusCode::NOT_FOUND | StatusCode::CONFLICT => WebdavError::RemotePathMissing,
        StatusCode::INSUFFICIENT_STORAGE | StatusCode::PAYLOAD_TOO_LARGE => {
            WebdavError::InsufficientStorage
        }
        other => WebdavError::Server(other.as_u16()),
    }
}

/// One path segment of a user-configured remote location. Rejects anything
/// that could climb out of the configured directory or split into extra
/// levels.
pub fn sanitize_path_segment(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty()
        || trimmed == "."
        || trimmed == ".."
        || trimmed.contains('/')
        || trimmed.contains('\\')
        || trimmed.contains('\0')
    {
        return None;
    }
    Some(trimmed.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn client() -> WebdavClient {
        WebdavClient::new("https://dav.example.com/dav", "user@example.com", "hunter2")
            .expect("client")
    }

    #[test]
    fn base_url_without_trailing_slash_still_appends() {
        let url = client().url_for("codeg/v1/default/config.json").expect("url");
        assert_eq!(
            url.as_str(),
            "https://dav.example.com/dav/codeg/v1/default/config.json"
        );
    }

    /// Users paste the base URL either way; both must hit the same path.
    #[test]
    fn trailing_slash_in_the_configured_url_changes_nothing() {
        let with_slash = WebdavClient::new("https://dav.example.com/dav/", "u", "p")
            .expect("client")
            .url_for("codeg/v1/default/config.json")
            .expect("url");
        assert_eq!(
            with_slash.as_str(),
            "https://dav.example.com/dav/codeg/v1/default/config.json"
        );
    }

    #[test]
    fn segments_are_percent_encoded() {
        let url = client().url_for("codeg/my drive/config.json").expect("url");
        assert!(url.as_str().contains("my%20drive"), "got {url}");
    }

    #[test]
    fn non_http_schemes_are_refused() {
        // `unwrap_err` is unavailable on purpose: the client holds the
        // password and must never gain a `Debug` impl that could print it.
        for raw in ["ftp://example.com", "   "] {
            match WebdavClient::new(raw, "u", "p") {
                Err(err) => assert_eq!(err, WebdavError::InvalidUrl, "for {raw:?}"),
                Ok(_) => panic!("{raw:?} should not be accepted as a WebDAV base URL"),
            }
        }
    }

    /// The whole point of hand-rolling these errors instead of wrapping
    /// `reqwest::Error`.
    #[test]
    fn rendered_errors_never_contain_credentials_or_host() {
        let variants = [
            WebdavError::InvalidUrl,
            WebdavError::Unauthorized,
            WebdavError::Forbidden,
            WebdavError::RemotePathMissing,
            WebdavError::InsufficientStorage,
            WebdavError::ResponseTooLarge,
            WebdavError::Network,
            WebdavError::Server(500),
        ];
        for variant in variants {
            let rendered = variant.to_string();
            assert!(!rendered.contains("hunter2"), "leaked password: {rendered}");
            assert!(
                !rendered.contains("dav.example.com"),
                "leaked host: {rendered}"
            );
            assert!(
                !rendered.contains("user@example.com"),
                "leaked username: {rendered}"
            );

            let app_error: AppCommandError = variant.into();
            assert!(app_error.i18n_key.is_some(), "every variant needs a message");
            assert!(!app_error.message.contains("hunter2"));
        }
    }

    #[test]
    fn status_codes_map_to_actionable_errors() {
        assert_eq!(classify(StatusCode::UNAUTHORIZED), WebdavError::Unauthorized);
        assert_eq!(classify(StatusCode::CONFLICT), WebdavError::RemotePathMissing);
        assert_eq!(
            classify(StatusCode::INSUFFICIENT_STORAGE),
            WebdavError::InsufficientStorage
        );
        assert_eq!(
            classify(StatusCode::INTERNAL_SERVER_ERROR),
            WebdavError::Server(500)
        );
    }

    #[test]
    fn path_segments_cannot_escape_the_configured_directory() {
        assert_eq!(sanitize_path_segment(" codeg "), Some("codeg".to_string()));
        for bad in ["", "..", ".", "a/b", "a\\b", "\0"] {
            assert!(
                sanitize_path_segment(bad).is_none(),
                "{bad:?} should be rejected"
            );
        }
    }
}
