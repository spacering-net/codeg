use std::collections::BTreeMap;
use std::io;
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;

use axum::body::{to_bytes, Body, Bytes};
use axum::extract::{Path, Request, State};
use axum::response::{IntoResponse, Response};
use axum::{routing::any, Router};
use chrono::{DateTime, Utc};
use futures_util::{stream, StreamExt, TryStreamExt};
use http::{header, HeaderMap, HeaderName, HeaderValue, Method, StatusCode};
use http_body::Body as _;
use tokio::io::{AsyncBufRead, AsyncBufReadExt, BufReader};
use tokio_util::{io::StreamReader, sync::CancellationToken};
use url::Url;

use crate::srn::pkce::constant_time_eq;

use super::{
    expires_soon, protocol, random_secret, update_token_metadata, Credentials, McpOAuthBridge,
    McpOAuthGrantStatus, McpOAuthTransport,
};

const REQUEST_LIMIT: usize = 8 * 1024 * 1024;
const RESPONSE_LIMIT: usize = 64 * 1024 * 1024;
const EVENT_LIMIT: usize = 256 * 1024;
const UPSTREAM_HEADERS_TIMEOUT: Duration = Duration::from_secs(30);
const SESSION_ID: &str = "mcp-session-id";
const PROTOCOL_VERSION: &str = "mcp-protocol-version";
const LAST_EVENT_ID: &str = "last-event-id";
const SSE: &str = "text/event-stream";

pub(super) type LegacyEndpoints = Arc<Mutex<BTreeMap<String, (String, Url)>>>;

pub(super) fn router(bridge: Weak<McpOAuthBridge>) -> Router {
    Router::new()
        .route("/mcp/{route_id}", any(proxy_root))
        .route("/mcp/{route_id}/sse-msg/{key}", any(proxy_legacy))
        .with_state(bridge)
}

async fn proxy_root(
    State(bridge): State<Weak<McpOAuthBridge>>,
    Path(route_id): Path<String>,
    request: Request,
) -> Response {
    forward(bridge, route_id, None, request)
        .await
        .unwrap_or_else(IntoResponse::into_response)
}

async fn proxy_legacy(
    State(bridge): State<Weak<McpOAuthBridge>>,
    Path((route_id, key)): Path<(String, String)>,
    request: Request,
) -> Response {
    forward(bridge, route_id, Some(key), request)
        .await
        .unwrap_or_else(IntoResponse::into_response)
}

struct Access {
    upstream: Url,
    transport: McpOAuthTransport,
    expires_at: Option<DateTime<Utc>>,
    credentials: Arc<Credentials>,
    active: CancellationToken,
}

impl McpOAuthBridge {
    async fn authorize(
        &self,
        route_id: &str,
        bearer: &str,
        headers: &HeaderMap,
        authority: Option<&str>,
    ) -> Option<Access> {
        let mut state = self.state.lock().await;
        let base = state.base()?;
        let host = headers
            .get(header::HOST)
            .and_then(|value| value.to_str().ok())
            .or(authority)?;
        if host != base.strip_prefix("http://")?
            || authority.is_some_and(|authority| authority != host)
            || headers
                .get_all(header::ORIGIN)
                .iter()
                .any(|origin| origin.to_str().ok() != Some(base))
        {
            return None;
        }
        let route = state.routes.get_mut(route_id)?;
        if route.metadata.status != McpOAuthGrantStatus::Authorized || route.active.is_cancelled() {
            return None;
        }
        let credentials = route.credentials(self.store.as_ref()).ok()?;
        if !constant_time_eq(credentials.bridge_token.as_bytes(), bearer.as_bytes()) {
            return None;
        }
        Some(Access {
            upstream: protocol::upstream_url(&route.metadata.upstream_url).ok()?,
            transport: route.metadata.transport,
            expires_at: route.metadata.expires_at,
            credentials,
            active: route.active.clone(),
        })
    }

    async fn refresh(&self, route_id: &str, access: &Access) -> Option<Arc<Credentials>> {
        let lock = self.route_lock(route_id);
        let _guard = lock.lock().await;
        let metadata = {
            let state = self.state.lock().await;
            let route = state.routes.get(route_id)?;
            if route.metadata.status != McpOAuthGrantStatus::Authorized
                || access.active.is_cancelled()
            {
                return None;
            }
            let current = route.credentials.as_ref()?;
            if !Arc::ptr_eq(current, &access.credentials) {
                // A refresh (or re-authorization) completed while we waited.
                return Some(current.clone());
            }
            route.metadata.clone()
        };
        let old = &access.credentials;
        let refreshed = async {
            let refresh = old.refresh_token.as_deref()?;
            let endpoint = old.endpoint(&access.upstream).ok()?;
            let tokens = protocol::exchange(
                self.client().ok()?,
                endpoint,
                &old.client_id,
                old.client_secret.as_deref(),
                old.client_auth,
                vec![
                    ("grant_type", "refresh_token"),
                    ("refresh_token", refresh),
                    ("resource", &old.resource),
                ],
            )
            .await
            .ok()?;
            let mut metadata = metadata;
            update_token_metadata(&mut metadata, &tokens, true);
            Some((
                metadata,
                Credentials {
                    access_token: tokens.access_token,
                    refresh_token: tokens.refresh_token.or_else(|| old.refresh_token.clone()),
                    client_id: old.client_id.clone(),
                    client_secret: old.client_secret.clone(),
                    token_endpoint: old.token_endpoint.clone(),
                    resource: old.resource.clone(),
                    bridge_token: old.bridge_token.clone(),
                    client_auth: old.client_auth,
                },
            ))
        };
        let updated = access.active.run_until_cancelled(refreshed).await?;
        let mut state = self.state.lock().await;
        if access.active.is_cancelled() {
            return None;
        }
        if let Some((metadata, credentials)) = updated {
            if let Ok(credentials) = self.save_grant(&mut state, metadata.clone(), credentials) {
                self.announce(&metadata);
                return Some(credentials);
            }
        }
        let error = if old.refresh_token.is_some() {
            "MCP OAuth token refresh failed"
        } else {
            "MCP OAuth access token expired and no refresh token is available"
        };
        self.expire(&mut state, route_id, error);
        None
    }

    async fn expire_if_current(&self, route_id: &str, credentials: &Arc<Credentials>) {
        let lock = self.route_lock(route_id);
        let _guard = lock.lock().await;
        let mut state = self.state.lock().await;
        let current = state
            .routes
            .get(route_id)
            .and_then(|route| route.credentials.as_ref());
        if current.is_some_and(|current| Arc::ptr_eq(current, credentials)) {
            self.expire(
                &mut state,
                route_id,
                "The MCP server rejected the refreshed OAuth token",
            );
        }
    }

    fn expire(&self, state: &mut super::BridgeState, route_id: &str, error: &'static str) {
        let Some(route) = state.routes.get(route_id) else {
            return;
        };
        let mut metadata = route.metadata.clone();
        metadata.status = McpOAuthGrantStatus::Expired;
        metadata.updated_at = Utc::now();
        if state
            .write(&self.path, state.preferred_port, Some(&metadata))
            .is_err()
        {
            tracing::warn!("Could not persist expired MCP OAuth route status");
        }
        if let Some(route) = state.routes.get_mut(route_id) {
            route.metadata = metadata;
            route.last_error = Some(error.to_owned());
            route.active.cancel();
            route.credentials = None;
            self.announce(&route.metadata);
        }
    }
}

fn bearer(headers: &HeaderMap) -> Option<&str> {
    let mut values = headers.get_all(header::AUTHORIZATION).iter();
    let (scheme, value) = values.next()?.to_str().ok()?.split_once(' ')?;
    (scheme.eq_ignore_ascii_case("bearer") && values.next().is_none()).then_some(value)
}

fn copy_headers(source: &HeaderMap, names: &[HeaderName]) -> HeaderMap {
    let mut headers = HeaderMap::new();
    for name in names {
        // A sender may mark any header hop-by-hop with Connection.
        let hop_by_hop = source
            .get_all(header::CONNECTION)
            .iter()
            .filter_map(|value| value.to_str().ok())
            .flat_map(|value| value.split(','))
            .any(|value| value.trim().eq_ignore_ascii_case(name.as_str()));
        if !hop_by_hop {
            for value in source.get_all(name) {
                headers.append(name, value.clone());
            }
        }
    }
    headers
}

async fn forward(
    bridge: Weak<McpOAuthBridge>,
    route_id: String,
    legacy_key: Option<String>,
    request: Request,
) -> Result<Response, StatusCode> {
    let bridge = bridge.upgrade().ok_or(StatusCode::SERVICE_UNAVAILABLE)?;
    let (parts, body) = request.into_parts();
    let bearer = bearer(&parts.headers).ok_or(StatusCode::UNAUTHORIZED)?;
    let mut access = bridge
        .authorize(
            &route_id,
            bearer,
            &parts.headers,
            parts.uri.authority().map(http::uri::Authority::as_str),
        )
        .await
        .ok_or(StatusCode::UNAUTHORIZED)?;
    if !matches!(parts.method, Method::GET | Method::POST | Method::DELETE) {
        return Err(StatusCode::METHOD_NOT_ALLOWED);
    }
    let target = if let Some(key) = &legacy_key {
        if access.transport != McpOAuthTransport::Sse || parts.method != Method::POST {
            return Err(StatusCode::METHOD_NOT_ALLOWED);
        }
        bridge
            .legacy_endpoints
            .lock()
            .unwrap()
            .get(key)
            .filter(|(parent, _)| parent == &route_id)
            .map(|(_, url)| url.clone())
            .ok_or(StatusCode::NOT_FOUND)?
    } else {
        access.upstream.clone()
    };
    if expires_soon(access.expires_at)
        && (access.credentials.refresh_token.is_some()
            || access.expires_at.is_some_and(|expiry| expiry <= Utc::now()))
    {
        access.credentials = bridge
            .refresh(&route_id, &access)
            .await
            .ok_or(StatusCode::UNAUTHORIZED)?;
    }

    let request_headers = copy_headers(
        &parts.headers,
        &[
            header::ACCEPT,
            header::CONTENT_TYPE,
            HeaderName::from_static(SESSION_ID),
            HeaderName::from_static(PROTOCOL_VERSION),
            HeaderName::from_static(LAST_EVENT_ID),
        ],
    );
    let body_len = body.size_hint().exact();
    if body_len.is_some_and(|size| size > REQUEST_LIMIT as u64) {
        return Err(StatusCode::PAYLOAD_TOO_LARGE);
    }
    let replay = if body_len.is_some() {
        access
            .active
            .run_until_cancelled(to_bytes(body, REQUEST_LIMIT))
            .await
            .ok_or(StatusCode::UNAUTHORIZED)?
            .map_err(|_| StatusCode::BAD_REQUEST)?
    } else {
        // Forward genuine streaming uploads once, with a bound and without
        // retrying a body that may already have been consumed upstream.
        let data = body.into_data_stream().map_err(|_| body_error());
        let payload = reqwest::Body::wrap_stream(bounded(data, REQUEST_LIMIT));
        let upstream = send(
            &bridge,
            &parts.method,
            &target,
            &request_headers,
            payload,
            &access,
        )
        .await?;
        return response(
            &bridge,
            &route_id,
            legacy_key.is_none() && parts.method == Method::GET,
            &access,
            upstream,
        );
    };
    let mut upstream = send(
        &bridge,
        &parts.method,
        &target,
        &request_headers,
        replay.clone().into(),
        &access,
    )
    .await?;
    if upstream.status() == StatusCode::UNAUTHORIZED {
        drop(upstream);
        access.credentials = bridge
            .refresh(&route_id, &access)
            .await
            .ok_or(StatusCode::UNAUTHORIZED)?;
        upstream = send(
            &bridge,
            &parts.method,
            &target,
            &request_headers,
            replay.into(),
            &access,
        )
        .await?;
        if upstream.status() == StatusCode::UNAUTHORIZED {
            bridge
                .expire_if_current(&route_id, &access.credentials)
                .await;
            return Err(StatusCode::UNAUTHORIZED);
        }
    }
    response(
        &bridge,
        &route_id,
        legacy_key.is_none() && parts.method == Method::GET,
        &access,
        upstream,
    )
}

async fn send(
    bridge: &McpOAuthBridge,
    method: &Method,
    target: &Url,
    headers: &HeaderMap,
    body: reqwest::Body,
    access: &Access,
) -> Result<reqwest::Response, StatusCode> {
    if access.active.is_cancelled() {
        return Err(StatusCode::UNAUTHORIZED);
    }
    let client = bridge.client().map_err(|_| StatusCode::BAD_GATEWAY)?;
    let request = client
        .request(method.clone(), target.clone())
        .headers(headers.clone())
        .bearer_auth(&access.credentials.access_token)
        .body(body)
        .send();
    access
        .active
        .run_until_cancelled(tokio::time::timeout(UPSTREAM_HEADERS_TIMEOUT, request))
        .await
        .ok_or(StatusCode::UNAUTHORIZED)?
        .map_err(|_| StatusCode::GATEWAY_TIMEOUT)?
        .map_err(|_| StatusCode::BAD_GATEWAY)
}

fn body_error() -> io::Error {
    io::Error::other("MCP proxy body read failed or exceeded its limit")
}

fn bounded<S>(source: S, limit: usize) -> impl futures_util::Stream<Item = io::Result<Bytes>>
where
    S: futures_util::Stream<Item = io::Result<Bytes>> + Unpin,
{
    stream::try_unfold((source, limit), |(mut source, remaining)| async move {
        let Some(chunk) = source.try_next().await? else {
            return Ok(None);
        };
        let remaining = remaining.checked_sub(chunk.len()).ok_or_else(body_error)?;
        Ok(Some((chunk, (source, remaining))))
    })
}

fn response(
    bridge: &McpOAuthBridge,
    route_id: &str,
    root_get: bool,
    access: &Access,
    upstream: reqwest::Response,
) -> Result<Response, StatusCode> {
    let status = upstream.status();
    if status.is_redirection()
        || upstream
            .content_length()
            .is_some_and(|size| size > RESPONSE_LIMIT as u64)
    {
        return Err(StatusCode::BAD_GATEWAY);
    }
    if status == StatusCode::UNAUTHORIZED {
        return Err(StatusCode::UNAUTHORIZED);
    }
    let mut headers = copy_headers(
        upstream.headers(),
        &[
            header::CONTENT_TYPE,
            header::CONTENT_ENCODING,
            HeaderName::from_static(SESSION_ID),
            HeaderName::from_static(PROTOCOL_VERSION),
        ],
    );
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    headers.insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static("default-src 'none'; frame-ancestors 'none'; sandbox"),
    );
    // Legacy SSE advertises a separate POST target via an endpoint event.
    let legacy = root_get
        && access.transport == McpOAuthTransport::Sse
        && headers
            .get(header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .is_some_and(|value| {
                value
                    .split(';')
                    .next()
                    .is_some_and(|media| media.trim().eq_ignore_ascii_case(SSE))
            });
    if legacy
        && headers
            .get_all(header::CONTENT_ENCODING)
            .iter()
            .any(|encoding| !encoding.as_bytes().eq_ignore_ascii_case(b"identity"))
    {
        return Err(StatusCode::BAD_GATEWAY);
    }
    let data = bounded(
        Box::pin(upstream.bytes_stream().map_err(|_| body_error())),
        RESPONSE_LIMIT,
    );
    let stop = access.active.clone().cancelled_owned();
    let body = if legacy {
        let key = random_secret()
            .map_err(|_| StatusCode::BAD_GATEWAY)?
            .expose()
            .to_owned();
        let legacy = LegacyStream {
            key,
            route_id: route_id.to_owned(),
            upstream: access.upstream.clone(),
            endpoints: bridge.legacy_endpoints.clone(),
        };
        Body::from_stream(
            legacy_stream(BufReader::new(StreamReader::new(Box::pin(data))), legacy)
                .take_until(stop),
        )
    } else {
        Body::from_stream(data.take_until(stop))
    };
    let mut response = Response::new(body);
    *response.status_mut() = status;
    *response.headers_mut() = headers;
    Ok(response)
}

struct LegacyStream {
    key: String,
    route_id: String,
    upstream: Url,
    endpoints: LegacyEndpoints,
}

impl LegacyStream {
    fn endpoint(&self, target: &str) -> io::Result<Bytes> {
        let url = self.upstream.join(target).map_err(|_| body_error())?;
        let url =
            protocol::discovered_url(url.as_str(), &self.upstream).map_err(|_| body_error())?;
        if url.origin() != self.upstream.origin() {
            return Err(body_error());
        }
        self.endpoints
            .lock()
            .unwrap()
            .insert(self.key.clone(), (self.route_id.clone(), url));
        Ok(Bytes::from(format!(
            "event: endpoint\ndata: /mcp/{}/sse-msg/{}\n\n",
            self.route_id, self.key
        )))
    }
}

impl Drop for LegacyStream {
    fn drop(&mut self) {
        self.endpoints.lock().unwrap().remove(&self.key);
    }
}

/// SSE permits LF, CRLF and CR, and a single leading UTF-8 BOM. Recognize
/// all of them before looking for `endpoint` so none can pass through raw.
#[derive(Default)]
struct LineEnding {
    skip_lf: bool,
    saw_line: bool,
}

impl LineEnding {
    async fn next<R: AsyncBufRead + Unpin>(
        &mut self,
        reader: &mut R,
        limit: usize,
    ) -> io::Result<Option<Vec<u8>>> {
        let mut line = Vec::new();
        loop {
            let bytes = reader.fill_buf().await?;
            if bytes.is_empty() {
                return Ok(None);
            }
            if std::mem::take(&mut self.skip_lf) && bytes[0] == b'\n' {
                reader.consume(1);
                continue;
            }
            let break_at = bytes.iter().position(|byte| matches!(*byte, b'\r' | b'\n'));
            let content_len = break_at.unwrap_or(bytes.len());
            if content_len >= limit.saturating_sub(line.len()) {
                return Err(body_error());
            }
            line.extend_from_slice(&bytes[..content_len]);
            if let Some(index) = break_at {
                self.skip_lf = bytes[index] == b'\r';
                reader.consume(index + 1);
                if !std::mem::replace(&mut self.saw_line, true) && line.starts_with(b"\xEF\xBB\xBF")
                {
                    line.drain(..3);
                }
                return Ok(Some(line));
            }
            reader.consume(content_len);
        }
    }
}

fn legacy_stream<R: AsyncBufRead + Unpin>(
    reader: R,
    session: LegacyStream,
) -> impl futures_util::Stream<Item = io::Result<Bytes>> {
    stream::try_unfold(
        (reader, session, LineEnding::default()),
        |(mut reader, session, mut lines)| async move {
            let mut event = Vec::new();
            let mut kind = Vec::new();
            let mut data = Vec::new();
            while let Some(line) = lines.next(&mut reader, EVENT_LIMIT - event.len()).await? {
                event.extend_from_slice(&line);
                event.push(b'\n');
                if line.is_empty() {
                    let bytes = if kind == b"endpoint" {
                        let data = data.strip_suffix(b"\n").ok_or_else(body_error)?;
                        let target = std::str::from_utf8(data).map_err(|_| body_error())?;
                        if target.trim().is_empty() || target.chars().any(char::is_control) {
                            return Err(body_error());
                        }
                        session.endpoint(target.trim())?
                    } else {
                        Bytes::from(event)
                    };
                    return Ok(Some((bytes, (reader, session, lines))));
                }
                let split = line.iter().position(|byte| *byte == b':');
                let (field, value) = split.map_or((line.as_slice(), &[][..]), |index| {
                    (&line[..index], &line[index + 1..])
                });
                let value = value.strip_prefix(b" ").unwrap_or(value);
                match field {
                    b"event" => kind = value.to_vec(),
                    b"data" => {
                        data.extend_from_slice(value);
                        data.push(b'\n');
                    }
                    _ => {}
                }
            }
            Ok(None)
        },
    )
}
