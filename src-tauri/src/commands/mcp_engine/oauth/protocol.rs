use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::sync::{Arc, LazyLock};
use std::time::Duration;

use chrono::{DateTime, Utc};
use regex::Regex;
use reqwest::{header, Client, RequestBuilder, StatusCode};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::json;
use url::{Host, Url};

use crate::app_error::{AppCommandError, AppErrorCode};

use super::{McpOAuthStartRequest, Result};

const CONTROL_LIMIT: usize = 256 * 1024;
const CONTROL_TIMEOUT: Duration = Duration::from_secs(15);

pub(super) fn network_error(message: &'static str) -> AppCommandError {
    AppCommandError::new(AppErrorCode::NetworkError, message)
}

fn loopback(url: &Url) -> bool {
    match url.host() {
        Some(Host::Ipv4(addr)) => addr == Ipv4Addr::LOCALHOST,
        Some(Host::Ipv6(addr)) => addr == Ipv6Addr::LOCALHOST,
        Some(Host::Domain(name)) => name == "localhost",
        None => false,
    }
}

fn public_address(ip: IpAddr) -> bool {
    match ip.to_canonical() {
        IpAddr::V4(addr) => {
            let [a, b, c, _] = addr.octets();
            !addr.is_private()
                && !addr.is_loopback()
                && !addr.is_link_local()
                && !addr.is_documentation()
                && !matches!(
                    (a, b, c),
                    (0 | 224..=255, _, _) | (100, 64..=127, _) | (192, 0, 0) | (198, 18..=19, _)
                )
        }
        IpAddr::V6(addr) => {
            let [a, b, ..] = addr.segments();
            // Only IPv6 global unicast. Exclude reserved protocol and transition ranges.
            (0x2000..0x4000).contains(&a)
                && a != 0x2002
                && a != 0x3fff
                && !(a == 0x2001 && (b < 0x0200 || b == 0x0db8))
        }
    }
}

/// Filter the actual connect addresses, including after a pooled connection
/// expires. A DNS rebinding between validation and dialing cannot take effect.
struct OAuthResolver;

impl reqwest::dns::Resolve for OAuthResolver {
    fn resolve(&self, name: reqwest::dns::Name) -> reqwest::dns::Resolving {
        Box::pin(async move {
            let candidates = if name.as_str() == "localhost" {
                vec![
                    SocketAddr::from((Ipv4Addr::LOCALHOST, 0)),
                    SocketAddr::from((Ipv6Addr::LOCALHOST, 0)),
                ]
            } else {
                tokio::net::lookup_host((name.as_str(), 0))
                    .await?
                    .filter(|addr| public_address(addr.ip()))
                    .collect()
            };
            if candidates.is_empty() {
                return Err(std::io::Error::other("No permitted OAuth host addresses").into());
            }
            Ok(Box::new(candidates.into_iter()) as reqwest::dns::Addrs)
        })
    }
}

pub(super) fn client() -> Result<Client> {
    Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .no_proxy()
        .dns_resolver(Arc::new(OAuthResolver))
        .connect_timeout(Duration::from_secs(5))
        .read_timeout(Duration::from_secs(120))
        .build()
        .map_err(|_| network_error("Could not initialize the MCP OAuth HTTP client"))
}

fn checked_url(raw: &str) -> Result<Url> {
    let invalid = || {
        AppCommandError::invalid_input("MCP OAuth URLs must use HTTPS or loopback HTTP without embedded credentials or fragments")
    };
    let url = Url::parse(raw).map_err(|_| invalid())?;
    if !url.username().is_empty() || url.password().is_some() || url.fragment().is_some() {
        return Err(invalid());
    }
    match (url.scheme(), url.host()) {
        ("http" | "https", _) if loopback(&url) => Ok(url),
        ("https", Some(Host::Domain(name)))
            if !name.ends_with(".localhost") && name != "localhost." =>
        {
            Ok(url)
        }
        ("https", Some(Host::Ipv4(addr))) if public_address(addr.into()) => Ok(url),
        ("https", Some(Host::Ipv6(addr))) if public_address(addr.into()) => Ok(url),
        _ => Err(invalid()),
    }
}

pub(super) fn upstream_url(raw: &str) -> Result<Url> {
    let url = checked_url(raw)?;
    // This URL goes to disk, snapshots and events. Query parameters may hold
    // credentials, and OAuth's resource indicator should be a stable URI.
    if url.query().is_some() {
        return Err(AppCommandError::invalid_input(
            "An MCP OAuth upstream URL must omit query parameters",
        ));
    }
    Ok(url)
}

pub(super) fn discovered_url(raw: &str, upstream: &Url) -> Result<Url> {
    let url = checked_url(raw)?;
    if loopback(&url) && !loopback(upstream) {
        return Err(AppCommandError::invalid_input(
            "A remote MCP OAuth service cannot discover a loopback endpoint",
        ));
    }
    Ok(url)
}

fn root(url: &Url) -> Url {
    let mut root = url.clone();
    root.set_path("/");
    root.set_query(None);
    root
}

fn well_known(url: &Url, name: &str, resource_path: bool) -> Url {
    let mut metadata = root(url);
    let path = if resource_path {
        url.path().trim_end_matches('/')
    } else {
        ""
    };
    metadata.set_path(&format!("/.well-known/{name}{path}"));
    metadata
}

fn oidc_metadata(issuer: &Url) -> Url {
    let mut metadata = issuer.clone();
    metadata.set_path(&format!(
        "{}/.well-known/openid-configuration",
        issuer.path().trim_end_matches('/')
    ));
    metadata
}

#[derive(Default, Deserialize)]
struct ResourceMetadata {
    resource: String,
    #[serde(default)]
    authorization_servers: Vec<String>,
    #[serde(default)]
    scopes_supported: Vec<String>,
}

#[derive(Deserialize)]
struct ServerMetadata {
    issuer: String,
    authorization_endpoint: String,
    token_endpoint: String,
    registration_endpoint: Option<String>,
    #[serde(default)]
    scopes_supported: Vec<String>,
    token_endpoint_auth_methods_supported: Option<Vec<String>>,
    code_challenge_methods_supported: Option<Vec<String>>,
}

pub(super) struct Discovery {
    pub issuer: Url,
    pub authorization_endpoint: Url,
    pub token_endpoint: Url,
    pub registration_endpoint: Option<Url>,
    pub scopes: Vec<String>,
    auth_methods: Option<Vec<String>>,
}

async fn control_response<T: DeserializeOwned>(
    request: RequestBuilder,
    message: &'static str,
    optional: bool,
) -> Result<Option<T>> {
    let error = || network_error(message);
    let mut response = request
        .timeout(CONTROL_TIMEOUT)
        .send()
        .await
        .map_err(|_| error())?;
    if optional
        && matches!(
            response.status(),
            StatusCode::NOT_FOUND | StatusCode::METHOD_NOT_ALLOWED
        )
    {
        return Ok(None);
    }
    if !response.status().is_success()
        || response
            .content_length()
            .is_some_and(|len| len > CONTROL_LIMIT as u64)
    {
        return Err(error());
    }
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| error())? {
        if chunk.len() > CONTROL_LIMIT - body.len() {
            return Err(error());
        }
        body.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&body).map(Some).map_err(|_| error())
}

async fn required_json<T: DeserializeOwned>(
    request: RequestBuilder,
    message: &'static str,
) -> Result<T> {
    control_response(request, message, false)
        .await?
        .ok_or_else(|| network_error(message))
}

fn bearer_metadata(header: &str) -> Option<String> {
    static BEARER: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"(?i)(?:^|,)\s*Bearer\s+").unwrap());
    static PARAM: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r#"^\s*([\w-]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^\s,]+))\s*(?:,|$)"#).unwrap()
    });
    static QUOTED_PAIR: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\\(.)").unwrap());
    for bearer in BEARER.find_iter(header) {
        let mut rest = &header[bearer.end()..];
        while let Some(param) = PARAM.captures(rest) {
            if param[1].eq_ignore_ascii_case("resource_metadata") {
                return Some(match param.get(2) {
                    Some(quoted) => QUOTED_PAIR.replace_all(quoted.as_str(), "$1").into_owned(),
                    None => param[3].to_owned(),
                });
            }
            rest = &rest[param.get(0)?.end()..];
        }
    }
    None
}

async fn discover_resource(
    client: &Client,
    upstream: &Url,
    explicit: Option<&str>,
) -> Result<ResourceMetadata> {
    const ERROR: &str = "Could not read MCP OAuth protected resource metadata";
    let advertised = if let Some(explicit) = explicit {
        Some(explicit.to_owned())
    } else {
        let probe = client
            .get(upstream.clone())
            .timeout(CONTROL_TIMEOUT)
            .send()
            .await;
        probe
            .ok()
            .filter(|response| response.status() == StatusCode::UNAUTHORIZED)
            .and_then(|response| {
                response
                    .headers()
                    .get_all(header::WWW_AUTHENTICATE)
                    .iter()
                    .filter_map(|value| value.to_str().ok())
                    .find_map(bearer_metadata)
            })
    };
    if let Some(url) = advertised {
        return required_json(client.get(discovered_url(&url, upstream)?), ERROR).await;
    }
    let path_specific = well_known(upstream, "oauth-protected-resource", true);
    let origin = well_known(upstream, "oauth-protected-resource", false);
    if path_specific != origin {
        if let Some(metadata) = control_response(client.get(path_specific), ERROR, true).await? {
            return Ok(metadata);
        }
    }
    Ok(control_response(client.get(origin), ERROR, true)
        .await?
        .unwrap_or_else(|| ResourceMetadata {
            resource: upstream.to_string(),
            ..ResourceMetadata::default()
        }))
}

pub(super) async fn discover(
    client: &Client,
    upstream: &Url,
    request: &McpOAuthStartRequest,
) -> Result<Discovery> {
    const ERROR: &str = "Could not read MCP OAuth authorization server metadata";
    let resource =
        discover_resource(client, upstream, request.resource_metadata_url.as_deref()).await?;
    if upstream_url(&resource.resource)? != *upstream {
        return Err(AppCommandError::configuration_invalid(
            "OAuth resource metadata identifies a different MCP server",
        ));
    }
    let issuer = match resource.authorization_servers.first() {
        Some(issuer) => discovered_url(issuer, upstream)?,
        None => root(upstream),
    };
    if issuer.query().is_some() {
        return Err(AppCommandError::configuration_invalid(
            "The MCP OAuth issuer URL must omit query parameters",
        ));
    }
    let metadata: ServerMetadata = match control_response(
        client.get(well_known(&issuer, "oauth-authorization-server", true)),
        ERROR,
        true,
    )
    .await?
    {
        Some(metadata) => metadata,
        None => required_json(client.get(oidc_metadata(&issuer)), ERROR).await?,
    };
    if discovered_url(&metadata.issuer, upstream)? != issuer {
        return Err(AppCommandError::configuration_invalid(
            "OAuth server metadata issuer does not match the discovered issuer",
        ));
    }
    if metadata
        .code_challenge_methods_supported
        .as_ref()
        .is_some_and(|methods| !methods.iter().any(|method| method == "S256"))
    {
        return Err(AppCommandError::configuration_invalid(
            "The OAuth server does not support PKCE S256",
        ));
    }
    let scopes = request.scopes.clone().unwrap_or({
        if resource.scopes_supported.is_empty() {
            metadata.scopes_supported
        } else {
            resource.scopes_supported
        }
    });
    validate_scopes(&scopes)?;
    Ok(Discovery {
        issuer,
        authorization_endpoint: discovered_url(&metadata.authorization_endpoint, upstream)?,
        token_endpoint: discovered_url(&metadata.token_endpoint, upstream)?,
        registration_endpoint: metadata
            .registration_endpoint
            .map(|url| discovered_url(&url, upstream))
            .transpose()?,
        scopes,
        auth_methods: metadata.token_endpoint_auth_methods_supported,
    })
}

fn validate_scopes(scopes: &[String]) -> Result<()> {
    if scopes.len() > 128
        || scopes.iter().any(|scope| {
            scope.is_empty()
                || scope.len() > 256
                || !scope
                    .bytes()
                    .all(|b| matches!(b, b'!' | b'#'..=b'[' | b']'..=b'~'))
        })
    {
        return Err(AppCommandError::invalid_input("Invalid MCP OAuth scopes"));
    }
    Ok(())
}

#[derive(Clone, Copy, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(super) enum ClientAuth {
    #[default]
    Basic,
    Post,
}

pub(super) struct Registration {
    pub client_id: String,
    pub client_secret: Option<String>,
    pub mode: super::McpOAuthRegistrationMode,
    pub auth: ClientAuth,
}

pub(super) async fn register(
    client: &Client,
    discovery: &Discovery,
    request: McpOAuthStartRequest,
    callback: &Url,
) -> Result<Registration> {
    use super::McpOAuthRegistrationMode::{Dynamic, Manual};
    if let Some(client_id) = request.client_id {
        let client_id = client_id.trim().to_owned();
        if client_id.is_empty()
            || client_id.len() > 4096
            || client_id.chars().any(char::is_control)
            || request.client_secret.as_ref().is_some_and(|secret| {
                secret.is_empty() || secret.len() > 4096 || secret.chars().any(char::is_control)
            })
        {
            return Err(AppCommandError::invalid_input(
                "Invalid manual MCP OAuth client credentials",
            ));
        }
        let auth = match &discovery.auth_methods {
            Some(methods)
                if !methods.iter().any(|method| method == "client_secret_basic")
                    && methods.iter().any(|method| method == "client_secret_post") =>
            {
                ClientAuth::Post
            }
            _ => ClientAuth::Basic,
        };
        return Ok(Registration {
            client_id,
            client_secret: request.client_secret,
            mode: Manual,
            auth,
        });
    }
    if request.client_secret.is_some() {
        return Err(AppCommandError::invalid_input(
            "Provide a client ID with a manual client secret",
        ));
    }
    let endpoint = discovery.registration_endpoint.as_ref().ok_or_else(|| {
        AppCommandError::configuration_missing(
            "This OAuth server requires a client ID. Enter one in Advanced options.",
        )
    })?;
    #[derive(Deserialize)]
    struct Registered {
        client_id: String,
    }
    let response: Registered = required_json(
        client.post(endpoint.clone()).json(&json!({
            "token_endpoint_auth_method": "none",
            "grant_types": ["authorization_code", "refresh_token"],
            "response_types": ["code"],
            "redirect_uris": [callback.as_str()],
            "client_name": "Codeg",
        })),
        "MCP OAuth dynamic client registration failed",
    )
    .await?;
    if response.client_id.trim().is_empty()
        || response.client_id.len() > 4096
        || response.client_id.chars().any(char::is_control)
    {
        return Err(network_error(
            "MCP OAuth dynamic registration returned an invalid client ID",
        ));
    }
    Ok(Registration {
        client_id: response.client_id,
        client_secret: None,
        mode: Dynamic,
        auth: ClientAuth::Basic,
    })
}

#[derive(Deserialize)]
pub(super) struct TokenResponse {
    pub access_token: String,
    pub refresh_token: Option<String>,
    token_type: String,
    expires_in: Option<u64>,
    scope: Option<String>,
}

impl TokenResponse {
    pub fn expires_at(&self) -> Option<DateTime<Utc>> {
        self.expires_in
            .and_then(|seconds| i64::try_from(seconds).ok())
            .and_then(chrono::Duration::try_seconds)
            .and_then(|duration| Utc::now().checked_add_signed(duration))
    }

    pub fn scopes(&self, previous: &[String]) -> Vec<String> {
        self.scope.as_deref().map_or_else(
            || previous.to_vec(),
            |scope| scope.split_ascii_whitespace().map(str::to_owned).collect(),
        )
    }
}

pub(super) async fn exchange(
    client: &Client,
    endpoint: Url,
    client_id: &str,
    secret: Option<&str>,
    auth: ClientAuth,
    mut form: Vec<(&str, &str)>,
) -> Result<TokenResponse> {
    const ERROR: &str = "MCP OAuth token exchange failed";
    let mut request = client.post(endpoint);
    match (secret, auth) {
        (Some(secret), ClientAuth::Basic) => {
            let encode = |value: &str| {
                url::form_urlencoded::byte_serialize(value.as_bytes()).collect::<String>()
            };
            request = request.basic_auth(encode(client_id), Some(encode(secret)));
        }
        (Some(secret), ClientAuth::Post) => {
            form.extend([("client_id", client_id), ("client_secret", secret)])
        }
        (None, _) => form.push(("client_id", client_id)),
    }
    let response: TokenResponse = required_json(request.form(&form), ERROR).await?;
    if !response.token_type.eq_ignore_ascii_case("bearer")
        || response.access_token.is_empty()
        || !response.access_token.bytes().all(|b| matches!(b, b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' | b'+' | b'/' | b'='))
        || response.refresh_token.as_ref().is_some_and(|token| token.is_empty() || token.chars().any(char::is_control))
        || response.expires_in.is_some() && response.expires_at().is_none()
        || response.scope.as_ref().is_some_and(|scope| validate_scopes(&scope.split_ascii_whitespace().map(str::to_owned).collect::<Vec<_>>()).is_err())
    {
        return Err(network_error("MCP OAuth token response is invalid"));
    }
    Ok(response)
}
