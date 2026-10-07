//! Update manifest fetching and version comparison.
//!
//! The manifest (`latest.json`) is the same artifact the desktop
//! `tauri-plugin-updater` consults, so desktop and server modes agree on
//! "what is the latest version". Server mode additionally downloads the
//! platform tarball from the deterministic `releases/latest/download/`
//! path (see `install.rs`).

use std::sync::LazyLock;
use std::time::Duration;

use serde::Deserialize;

use crate::app_error::AppCommandError;

/// Update manifest URL — mirrors the `endpoints` entry in `tauri.conf.json`
/// so desktop and server modes consult the same source of truth.
pub const UPDATE_MANIFEST_URL: &str =
    "https://github.com/spacering-net/codeg/releases/latest/download/latest.json";

/// Deterministic base for "latest" release assets (server tarballs + their
/// `.sig` detached signatures). Same channel as the manifest.
pub const RELEASE_DOWNLOAD_BASE: &str =
    "https://github.com/spacering-net/codeg/releases/latest/download";

/// Short-timeout client for the small manifest fetch. Proxy env vars are
/// sampled at build time, so `init_proxy_from_db` must run before the first
/// request — both startup paths already do that.
static MANIFEST_HTTP_CLIENT: LazyLock<Result<reqwest::Client, String>> = LazyLock::new(|| {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(8))
        .timeout(Duration::from_secs(15))
        .user_agent(concat!("codeg/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| format!("failed to initialize update manifest client: {e}"))
});

/// Long-lived client for asset downloads (tens of MB). No *overall* request
/// timeout — a slow-but-progressing download must not be killed mid-stream —
/// but a `read_timeout` bounds stalls: a connection that stops delivering
/// bytes is dropped instead of hanging forever and holding the update lock.
static DOWNLOAD_HTTP_CLIENT: LazyLock<Result<reqwest::Client, String>> = LazyLock::new(|| {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(8))
        .read_timeout(Duration::from_secs(120))
        .user_agent(concat!("codeg/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| format!("failed to initialize update download client: {e}"))
});

pub fn manifest_client() -> Result<&'static reqwest::Client, AppCommandError> {
    MANIFEST_HTTP_CLIENT.as_ref().map_err(|err| {
        AppCommandError::network("Failed to initialize update HTTP client").with_detail(err.clone())
    })
}

pub fn download_client() -> Result<&'static reqwest::Client, AppCommandError> {
    DOWNLOAD_HTTP_CLIENT.as_ref().map_err(|err| {
        AppCommandError::network("Failed to initialize update download client")
            .with_detail(err.clone())
    })
}

#[derive(Debug, Deserialize)]
pub struct LatestManifest {
    pub version: String,
    #[serde(default)]
    pub notes: Option<String>,
    #[serde(default)]
    pub pub_date: Option<String>,
}

pub async fn fetch_latest_manifest() -> Result<LatestManifest, AppCommandError> {
    let client = manifest_client()?;
    let response = client.get(UPDATE_MANIFEST_URL).send().await.map_err(|e| {
        AppCommandError::network("Failed to fetch update manifest").with_detail(e.to_string())
    })?;

    if !response.status().is_success() {
        return Err(AppCommandError::network(format!(
            "Update manifest returned status {}",
            response.status()
        )));
    }

    response.json::<LatestManifest>().await.map_err(|e| {
        AppCommandError::network("Failed to parse update manifest").with_detail(e.to_string())
    })
}

pub fn trim_v_prefix(v: &str) -> &str {
    v.strip_prefix('v').unwrap_or(v)
}

/// Strict-then-lenient version comparison. Prefer `semver` (handles
/// prerelease ordering correctly); fall back to plain inequality if either
/// side is not a clean semver string — that way an unexpected manifest
/// format still surfaces *something* rather than silently claiming
/// "already latest".
pub fn is_newer(latest: &str, current: &str) -> bool {
    use semver::Version;
    match (
        Version::parse(trim_v_prefix(latest)),
        Version::parse(trim_v_prefix(current)),
    ) {
        (Ok(l), Ok(c)) => l > c,
        _ => trim_v_prefix(latest) != trim_v_prefix(current),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn newer_by_semver() {
        assert!(is_newer("0.14.12", "0.14.11"));
        assert!(is_newer("v1.0.0", "0.14.11"));
        assert!(!is_newer("0.14.11", "0.14.11"));
        assert!(!is_newer("0.14.10", "0.14.11"));
    }

    #[test]
    fn prerelease_ordering() {
        // A prerelease is older than its release per semver.
        assert!(is_newer("1.0.0", "1.0.0-rc.1"));
        assert!(!is_newer("1.0.0-rc.1", "1.0.0"));
    }

    #[test]
    fn v_prefix_is_ignored() {
        assert!(!is_newer("v0.14.11", "0.14.11"));
    }

    #[test]
    fn non_semver_falls_back_to_inequality() {
        assert!(is_newer("nightly-2", "nightly-1"));
        assert!(!is_newer("same", "same"));
    }
}
