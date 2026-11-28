use std::{io, path::Path};

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use url::Url;

use super::{McpOAuthGrantStatus, McpOAuthRouteInfo, McpOAuthTransport};

pub(super) const ROUTES_FILE: &str = "mcp-oauth-routes.json";

pub trait SecretStore: Send + Sync {
    fn get(&self, key: &str) -> Result<Option<String>, String>;
    fn set(&self, key: &str, value: &str) -> Result<(), String>;
    fn delete(&self, key: &str) -> Result<(), String>;
}

pub(super) struct KeyringStore;

impl SecretStore for KeyringStore {
    fn get(&self, key: &str) -> Result<Option<String>, String> {
        crate::keyring_store::get_secret(key)
    }

    fn set(&self, key: &str, value: &str) -> Result<(), String> {
        crate::keyring_store::set_secret(key, value)
    }

    fn delete(&self, key: &str) -> Result<(), String> {
        crate::keyring_store::delete_secret(key)
    }
}

pub(super) fn secret_key(route_id: &str) -> String {
    format!("mcp-oauth-route:{route_id}")
}

#[derive(Serialize, Deserialize)]
pub(super) struct Credentials {
    pub access_token: String,
    pub refresh_token: Option<String>,
    pub client_id: String,
    pub client_secret: Option<String>,
    pub token_endpoint: String,
    pub resource: String,
    pub bridge_token: String,
    #[serde(default)]
    pub client_auth: super::protocol::ClientAuth,
}

/// Separate from the API projection so transient fields never reach disk.
#[derive(Clone, Serialize, Deserialize)]
pub(super) struct RouteMetadata {
    pub route_id: String,
    pub upstream_url: String,
    pub transport: McpOAuthTransport,
    pub issuer: Option<String>,
    pub scopes: Vec<String>,
    pub expires_at: Option<DateTime<Utc>>,
    pub has_refresh_token: bool,
    pub status: McpOAuthGrantStatus,
    pub updated_at: DateTime<Utc>,
}

impl RouteMetadata {
    pub fn info(&self, base: Option<&str>, last_error: Option<String>) -> McpOAuthRouteInfo {
        McpOAuthRouteInfo {
            route_id: self.route_id.clone(),
            upstream_url: self.upstream_url.clone(),
            transport: self.transport,
            bridge_url: base.map(|base| format!("{base}/mcp/{}", self.route_id)),
            status: self.status,
            issuer: self.issuer.clone(),
            scopes: self.scopes.clone(),
            expires_at: self.expires_at,
            has_refresh_token: self.has_refresh_token,
            last_error,
            updated_at: self.updated_at,
        }
    }
}

#[derive(Default, Deserialize)]
pub(super) struct RoutesFile {
    pub preferred_port: Option<u16>,
    pub routes: Vec<RouteMetadata>,
}

impl RoutesFile {
    pub fn read(path: &Path) -> io::Result<Self> {
        let raw = match std::fs::read(path) {
            Ok(raw) => raw,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Self::default()),
            Err(error) => return Err(error),
        };
        let stored: Self = serde_json::from_slice(&raw)?;
        for route in &stored.routes {
            let upstream = super::protocol::upstream_url(&route.upstream_url)
                .map_err(|_| io::Error::other("invalid stored MCP OAuth route"))?;
            if route.route_id != super::route_id(&upstream)
                || route.status == McpOAuthGrantStatus::Authorizing
            {
                return Err(io::Error::other("invalid stored MCP OAuth route"));
            }
        }
        Ok(stored)
    }

    pub fn write<'a>(
        path: &Path,
        preferred_port: Option<u16>,
        routes: impl Iterator<Item = &'a RouteMetadata>,
    ) -> io::Result<()> {
        #[derive(Serialize)]
        struct Snapshot<'a> {
            preferred_port: Option<u16>,
            routes: Vec<&'a RouteMetadata>,
        }
        let bytes = serde_json::to_vec_pretty(&Snapshot {
            preferred_port,
            routes: routes.collect(),
        })?;
        super::super::fsio::write_atomic(path, &bytes)
    }
}

impl Credentials {
    pub fn endpoint(&self, upstream: &Url) -> super::Result<Url> {
        super::protocol::discovered_url(&self.token_endpoint, upstream)
    }
}

#[cfg(any(test, feature = "test-utils"))]
#[derive(Default)]
pub(super) struct MemorySecretStore(std::sync::Mutex<std::collections::BTreeMap<String, String>>);

#[cfg(any(test, feature = "test-utils"))]
impl SecretStore for MemorySecretStore {
    fn get(&self, key: &str) -> Result<Option<String>, String> {
        Ok(self.0.lock().unwrap().get(key).cloned())
    }

    fn set(&self, key: &str, value: &str) -> Result<(), String> {
        self.0.lock().unwrap().insert(key.into(), value.into());
        Ok(())
    }

    fn delete(&self, key: &str) -> Result<(), String> {
        self.0.lock().unwrap().remove(key);
        Ok(())
    }
}
