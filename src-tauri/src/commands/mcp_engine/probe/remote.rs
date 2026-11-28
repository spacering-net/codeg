use futures_util::TryStreamExt;
use reqwest::header::{self, HeaderMap, HeaderName, HeaderValue};
use reqwest::{Client, Response, StatusCode};
use serde_json::Value;
use tokio::io::{AsyncBufRead, BufReader};
use tokio_util::io::StreamReader;
use url::Url;

use super::{
    decode_message, initialize, initialized, read_line, rpc_result, McpProbeAuthHint,
    McpProbeResult, McpProbeStatus, ProbeError, ProbeResult, Redact, ToolPages, MAX_READ_BYTES,
};

const SESSION_ID: &str = "mcp-session-id";
const PROTOCOL_VERSION: &str = "mcp-protocol-version";
const SSE: &str = "text/event-stream";
const STREAMABLE_ACCEPT: &str = "application/json, text/event-stream";

pub(super) struct Remote {
    url: Url,
    headers: HeaderMap,
    client: Client,
}

impl Remote {
    pub fn new(
        url: &str,
        headers: &std::collections::BTreeMap<String, String>,
    ) -> ProbeResult<Self> {
        let url = Url::parse(url).ok().filter(is_http_url).ok_or_else(|| {
            ProbeError::config("MCP URL must use HTTP(S) without user credentials")
        })?;
        let mut request_headers = HeaderMap::new();
        for (key, value) in headers {
            let name = HeaderName::from_bytes(key.as_bytes())
                .map_err(|_| ProbeError::config("Invalid MCP request header name"))?;
            let mut value = HeaderValue::from_str(value)
                .map_err(|_| ProbeError::config("Invalid MCP request header value"))?;
            value.set_sensitive(true);
            request_headers.insert(name, value);
        }
        // Only the handshake sets routing, body framing, and MCP protocol headers.
        for name in [
            "host",
            "content-length",
            "transfer-encoding",
            SESSION_ID,
            PROTOCOL_VERSION,
        ] {
            request_headers.remove(name);
        }
        let client = Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|_| network_error())?;
        Ok(Self {
            url,
            headers: request_headers,
            client,
        })
    }

    async fn post(
        &self,
        endpoint: &Url,
        body: &Value,
        session: Option<&Session>,
        accept: &'static str,
        redact: &Redact,
    ) -> ProbeResult<Response> {
        let mut headers = self.headers.clone();
        headers.insert(header::ACCEPT, HeaderValue::from_static(accept));
        headers.insert(
            header::CONTENT_TYPE,
            HeaderValue::from_static("application/json"),
        );
        if let Some(session) = session {
            if let Some(id) = &session.id {
                headers.insert(SESSION_ID, id.clone());
            }
            headers.insert(PROTOCOL_VERSION, session.version.clone());
        }
        let response = self
            .client
            .post(endpoint.clone())
            .headers(headers)
            .json(body)
            .send()
            .await
            .map_err(|_| network_error())?;
        let has_session_id = session.and_then(|session| session.id.as_ref()).is_some();
        let response = check_status(response, has_session_id, redact)?;
        if let Some(session) = session {
            if let Some(id) = response.headers().get(SESSION_ID) {
                if Some(id) != session.id.as_ref() {
                    let mut error = ProbeError::new(
                        McpProbeStatus::SessionIdMismatch,
                        "MCP session ID changed during the handshake",
                    );
                    error.http_status = Some(response.status().as_u16());
                    return Err(error);
                }
            }
        }
        Ok(response)
    }

    pub async fn probe_http(
        &self,
        report: &mut McpProbeResult,
        redact: &Redact,
    ) -> ProbeResult<()> {
        let mut remaining = MAX_READ_BYTES;
        let response = self
            .post(&self.url, &initialize(), None, STREAMABLE_ACCEPT, redact)
            .await?;
        report.http_status = Some(response.status().as_u16());
        let id = response.headers().get(SESSION_ID).cloned().map(|mut id| {
            id.set_sensitive(true);
            id
        });
        let result = reply(response, 1, &mut remaining).await?;
        let version = report.record_server(&result, redact)?;
        let version = HeaderValue::from_str(&version)
            .map_err(|_| ProbeError::protocol("Invalid MCP protocol version header"))?;
        let session = Session { id, version };
        self.post(
            &self.url,
            &initialized(),
            Some(&session),
            STREAMABLE_ACCEPT,
            redact,
        )
        .await?;
        let mut pages = ToolPages::new();
        loop {
            let (id, request) = pages.request();
            let response = self
                .post(
                    &self.url,
                    &request,
                    Some(&session),
                    STREAMABLE_ACCEPT,
                    redact,
                )
                .await?;
            report.http_status = Some(response.status().as_u16());
            let result = reply(response, id, &mut remaining).await?;
            if !pages.advance(report.record_tools(&result, redact)?)? {
                return Ok(());
            }
        }
    }

    pub async fn probe_sse(&self, report: &mut McpProbeResult, redact: &Redact) -> ProbeResult<()> {
        let mut headers = self.headers.clone();
        headers.insert(header::ACCEPT, HeaderValue::from_static(SSE));
        let response = self
            .client
            .get(self.url.clone())
            .headers(headers)
            .send()
            .await
            .map_err(|_| network_error())?;
        let response = check_status(response, false, redact)?;
        report.http_status = Some(response.status().as_u16());
        if !is_event_stream(&response) {
            return Err(ProbeError::protocol(
                "Legacy MCP endpoint did not return an SSE stream",
            ));
        }
        let mut events = event_stream(response);
        let mut remaining = MAX_READ_BYTES;
        let endpoint = loop {
            let frame = events.next(&mut remaining).await?;
            if frame.event == "endpoint" {
                let path = std::str::from_utf8(&frame.data)
                    .ok()
                    .map(str::trim)
                    .filter(|path| !path.is_empty())
                    .ok_or_else(|| ProbeError::protocol("Invalid MCP SSE endpoint"))?;
                let endpoint = self
                    .url
                    .join(path)
                    .ok()
                    .filter(is_http_url)
                    .ok_or_else(|| ProbeError::protocol("Invalid MCP SSE endpoint"))?;
                // The SSE server can select a path on its own origin. Credentials
                // and requests never follow an endpoint on a different origin.
                if endpoint.origin() != self.url.origin() {
                    return Err(ProbeError::protocol(
                        "MCP SSE endpoint has a different origin",
                    ));
                }
                break endpoint;
            }
        };
        self.post(&endpoint, &initialize(), None, "application/json", redact)
            .await?;
        let result = events.reply(1, &mut remaining).await?;
        report.record_server(&result, redact)?;
        self.post(&endpoint, &initialized(), None, "application/json", redact)
            .await?;
        let mut pages = ToolPages::new();
        loop {
            let (id, request) = pages.request();
            self.post(&endpoint, &request, None, "application/json", redact)
                .await?;
            let result = events.reply(id, &mut remaining).await?;
            if !pages.advance(report.record_tools(&result, redact)?)? {
                return Ok(());
            }
        }
    }
}

struct Session {
    id: Option<HeaderValue>,
    version: HeaderValue,
}

fn is_http_url(url: &Url) -> bool {
    matches!(url.scheme(), "http" | "https")
        && url.host().is_some()
        && url.username().is_empty()
        && url.password().is_none()
}

fn network_error() -> ProbeError {
    ProbeError::new(
        McpProbeStatus::NetworkError,
        "Could not connect to or read from MCP server",
    )
}

fn check_status(
    response: Response,
    has_session_id: bool,
    redact: &Redact,
) -> ProbeResult<Response> {
    let code = response.status();
    if code.is_success() {
        return Ok(response);
    }
    let (status, detail) = match code {
        StatusCode::UNAUTHORIZED => (
            McpProbeStatus::AuthRequired,
            "MCP server requires authentication",
        ),
        StatusCode::FORBIDDEN => (McpProbeStatus::Forbidden, "MCP server refused access"),
        StatusCode::NOT_FOUND if has_session_id => (
            McpProbeStatus::SessionIdMismatch,
            "MCP session ID was rejected or expired by the server",
        ),
        _ => (McpProbeStatus::ProtocolError, "Unexpected MCP HTTP status"),
    };
    let mut error = ProbeError::new(status, detail);
    error.http_status = Some(code.as_u16());
    if code == StatusCode::UNAUTHORIZED {
        error.auth_hint = auth_hint(response.headers(), redact);
    }
    Err(error)
}

/// Split challenge fields at commas outside quoted strings (RFC 9110).
fn challenge_fields(text: &str) -> impl Iterator<Item = &str> {
    let mut quoted = false;
    let mut escaped = false;
    text.split(move |c| {
        if escaped {
            escaped = false;
        } else if c == '\\' && quoted {
            escaped = true;
        } else if c == '"' {
            quoted = !quoted;
        } else if c == ',' && !quoted {
            return true;
        }
        false
    })
    .map(str::trim)
}

fn auth_hint(headers: &HeaderMap, redact: &Redact) -> Option<McpProbeAuthHint> {
    let mut hint = McpProbeAuthHint::default();
    for header in headers.get_all(header::WWW_AUTHENTICATE) {
        let Ok(header) = header.to_str() else {
            continue;
        };
        let mut bearer = false;
        for field in challenge_fields(header) {
            let token_end = field
                .find(|c: char| c == '=' || c.is_ascii_whitespace())
                .unwrap_or(field.len());
            let (name, rest) = field.split_at(token_end);
            let mut param = field;
            if !name.is_empty() && !rest.trim_start().starts_with('=') {
                bearer = name.eq_ignore_ascii_case("bearer");
                if bearer || hint.scheme.is_none() {
                    let scheme = redact.bounded(name, 64);
                    if !scheme.is_empty()
                        && scheme
                            .bytes()
                            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
                    {
                        hint.scheme = Some(scheme);
                    }
                }
                param = rest.trim_start();
            }
            if bearer {
                if let Some((name, value)) = param.split_once('=') {
                    if name.trim().eq_ignore_ascii_case("resource_metadata") {
                        let value = value.trim().trim_matches('"');
                        if value.len() <= 1024
                            && redact.clean(value) == value
                            && Url::parse(value).ok().is_some_and(|url| is_http_url(&url))
                        {
                            hint.resource_metadata = Some(value.to_owned());
                        }
                    }
                }
            }
        }
    }
    (hint.scheme.is_some() || hint.resource_metadata.is_some()).then_some(hint)
}

fn is_event_stream(response: &Response) -> bool {
    response
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|content| {
            content
                .split(';')
                .next()
                .is_some_and(|mime| mime.trim().eq_ignore_ascii_case(SSE))
        })
}

async fn reply(mut response: Response, id: u64, remaining: &mut usize) -> ProbeResult<Value> {
    if is_event_stream(&response) {
        return event_stream(response).reply(id, remaining).await;
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| network_error())? {
        *remaining = remaining
            .checked_sub(chunk.len())
            .ok_or_else(|| ProbeError::protocol("MCP response exceeded 2 MiB"))?;
        bytes.extend_from_slice(&chunk);
    }
    rpc_result(decode_message(&bytes)?, id)?
        .ok_or_else(|| ProbeError::protocol("Unexpected MCP response ID"))
}

struct Frame {
    event: String,
    data: Vec<u8>,
}

struct EventStream<R>(R);

fn event_stream(response: Response) -> EventStream<impl AsyncBufRead + Unpin> {
    EventStream(BufReader::new(StreamReader::new(
        response.bytes_stream().map_err(std::io::Error::other),
    )))
}

impl<R: AsyncBufRead + Unpin> EventStream<R> {
    async fn next(&mut self, remaining: &mut usize) -> ProbeResult<Frame> {
        let mut frame = Frame {
            event: String::new(),
            data: Vec::new(),
        };
        let mut line = Vec::new();
        while read_line(&mut self.0, &mut line, remaining, network_error).await? {
            let line = line.strip_suffix(b"\n").unwrap_or(&line);
            let line = line.strip_suffix(b"\r").unwrap_or(line);
            if line.is_empty() {
                if !frame.data.is_empty() {
                    frame.data.pop(); // The final data-line separator is not part of the event.
                    return Ok(frame);
                }
                frame.event.clear();
            } else if let Some(data) = line.strip_prefix(b"data:") {
                frame
                    .data
                    .extend_from_slice(data.strip_prefix(b" ").unwrap_or(data));
                frame.data.push(b'\n');
            } else if let Some(event) = line.strip_prefix(b"event:") {
                frame.event =
                    String::from_utf8_lossy(event.strip_prefix(b" ").unwrap_or(event)).into_owned();
            }
        }
        Err(ProbeError::protocol(
            "MCP event stream closed before responding",
        ))
    }

    async fn reply(&mut self, id: u64, remaining: &mut usize) -> ProbeResult<Value> {
        loop {
            let frame = self.next(remaining).await?;
            if frame.event.is_empty() || frame.event == "message" {
                if let Some(result) = rpc_result(decode_message(&frame.data)?, id)? {
                    return Ok(result);
                }
            }
        }
    }
}
