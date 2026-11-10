//! Token-authenticated API of the web-mode port bridge: the workbench asks
//! here (with codeg's token) for a grant, then loads the bridge listener's
//! entry URL in an iframe. See `web::browser_bridge` for the listener side.

use axum::http::HeaderMap;
use axum::Json;
use serde::{Deserialize, Serialize};

use crate::app_error::{AppCommandError, AppErrorCode};
use crate::web::browser_bridge::{self, BridgeError, BridgeGrant, BridgeStatus};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeOpenParams {
    /// The address as the user saw it (`http://localhost:3000/docs?x=1`).
    pub url: String,
    /// The workbench tab that will hold the grant; `browser_bridge_close`
    /// releases it by the same id.
    pub tab_id: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeOpenResult {
    #[serde(flatten)]
    pub grant: BridgeGrant,
    /// Path and query of `url`, for the entry redirect (`?to=`).
    pub path: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeCloseParams {
    pub tab_id: String,
}

pub async fn browser_bridge_status() -> Json<BridgeStatus> {
    Json(browser_bridge::status())
}

pub async fn browser_bridge_open(
    headers: HeaderMap,
    Json(params): Json<BridgeOpenParams>,
) -> Result<Json<BridgeOpenResult>, AppCommandError> {
    let (port, path) = bridgeable_target(&params.url)?;
    // The hostname this very request was addressed to is the workbench's own,
    // which is what a bridge hostname is built on (`CODEG_BRIDGE_HOST_PATTERN`
    // = `auto`); a bridge addressed by port ignores it.
    let workbench_host = browser_bridge::workbench_hostname(&headers);
    let grant = browser_bridge::open(port, &params.tab_id, workbench_host.as_deref())
        .await
        .map_err(|err| match err {
            BridgeError::Disabled | BridgeError::NoHostname(_) => {
                AppCommandError::configuration_missing(err.to_string())
            }
            BridgeError::Reserved(_) => AppCommandError::invalid_input(err.to_string()),
            BridgeError::NoPort(_) => {
                AppCommandError::new(AppErrorCode::IoError, "no bridge port is free")
                    .with_detail(err.to_string())
            }
        })?;
    Ok(Json(BridgeOpenResult { grant, path }))
}

pub async fn browser_bridge_close(
    Json(params): Json<BridgeCloseParams>,
) -> Json<serde_json::Value> {
    browser_bridge::close(&params.tab_id);
    Json(serde_json::json!({ "ok": true }))
}

/// The loopback port `url` names and the path to land on. Only plain `http`
/// to the host's own loopback can be bridged: the bridge speaks to the target
/// without TLS, and a private-network or public host would make codeg a
/// general-purpose proxy.
pub fn bridgeable_target(url: &str) -> Result<(u16, String), AppCommandError> {
    let parsed = reqwest::Url::parse(url.trim())
        .map_err(|e| AppCommandError::invalid_input(format!("not a URL: {e}")))?;
    if parsed.scheme() != "http" {
        return Err(AppCommandError::invalid_input(
            "only http:// addresses on the server's loopback can be bridged",
        ));
    }
    let host = parsed.host_str().unwrap_or_default();
    if !browser_bridge::is_loopback_host(host) {
        return Err(AppCommandError::invalid_input(format!(
            "{host} is not the server's loopback; only localhost ports can be bridged"
        )));
    }
    let port = parsed.port_or_known_default().unwrap_or(80);
    let mut path = parsed.path().to_string();
    if let Some(query) = parsed.query() {
        path.push('?');
        path.push_str(query);
    }
    Ok((port, path))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn loopback_http_is_bridgeable_and_keeps_its_path() {
        assert_eq!(
            bridgeable_target("http://localhost:3000/docs?x=1#frag").unwrap(),
            (3000, "/docs?x=1".to_string())
        );
        assert_eq!(bridgeable_target("http://127.0.0.1:5173").unwrap(), (5173, "/".to_string()));
        assert_eq!(bridgeable_target("http://[::1]:8080/a/b").unwrap(), (8080, "/a/b".to_string()));
        assert_eq!(bridgeable_target("http://0.0.0.0:3000/").unwrap(), (3000, "/".to_string()));
        assert_eq!(bridgeable_target("http://localhost/").unwrap(), (80, "/".to_string()));
    }

    #[test]
    fn everything_else_is_refused() {
        for url in [
            "https://localhost:3000/",
            "http://192.168.1.5:3000/",
            "http://example.com/",
            "ws://localhost:3000/",
            "localhost:3000",
            "",
        ] {
            assert!(bridgeable_target(url).is_err(), "{url}");
        }
    }
}
