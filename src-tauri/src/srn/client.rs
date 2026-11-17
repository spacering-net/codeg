//! The SRN account API (`/api/client/v1/*` on SpaceRing), as a client of it.
//!
//! Four requests: create a login request, exchange its code, read the account
//! (`/me`), end the connection (`logout`). The rules, on top of those of the
//! Harness client whose pieces this shares (`harness/client.rs`: the user's
//! proxy, rebuilt when it changes; the `User-Agent`; the connect timeout):
//!
//! - **One origin, over HTTPS.** Every address is the build's SpaceRing origin
//!   (`harness::origin`) plus a path written here. A release build's origin is
//!   always `https://spacering.net`; only a development build pointed at a
//!   loopback dev server speaks plain HTTP, the one exception the origin rule
//!   allows.
//! - **No redirect is followed.** A request carries a code, a verifier or a
//!   token, so a 3xx is a failure, reported as its status.
//! - **Nothing is sent twice.** Not here, and not by reqwest either: its
//!   default retry of a request an HTTP/2 server refused (`REFUSED_STREAM`,
//!   `GOAWAY`) is off for this client. A caller decides; the code exchange
//!   must never be repeated (a code presented again ends the connection it
//!   opened).
//! - **Bounded.** A deadline per request, and at most [`MAX_ANSWER_BYTES`] of
//!   any answer.
//! - **No cookies**, and `Cache-Control: no-store` on every request.
//!
//! Nothing here knows about desktops or browsers: a request names its client
//! and its redirect, so the Web sign-in uses the same calls: an API made
//! [`SrnApi::with_client_credentials`] adds its confidential client's
//! `client_secret_basic` credentials to the two that name a client (the login
//! request and the exchange), never to a request that carries a token.
//! Answers are checked before anything is believed: a token, a code or a
//! request ID must look like what SpaceRing makes, an authorization page must
//! be on the origin, and an avatar is kept only as a path SpaceRing serves
//! under `/api/avatars/` ([`avatar_path`]).

use std::time::Duration;

use reqwest::header::{HeaderMap, HeaderValue, ACCEPT, AUTHORIZATION, CACHE_CONTROL, RETRY_AFTER};
use reqwest::{Method, StatusCode, Url};
use serde::Deserialize;
use serde_json::json;

use super::error::SrnError;
use super::pkce::{AccessToken, AuthCode, FlowSecret, RequestId};
use crate::harness::client as http;
use crate::harness::origin::Origin;

/// `scope` of every request: all SpaceRing grants to Codeg.
pub const SCOPE: &str = "profile:read";

/// The longest answer read. The API's answers are a few hundred bytes.
pub const MAX_ANSWER_BYTES: u64 = 64 * 1024;

/// A whole request, from sending it to the last byte of the answer. The
/// Harness client's number: long enough for a slow proxy, short enough that
/// "offline" shows as such.
pub const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

const LOGIN_REQUESTS: &str = "/api/client/v1/login-requests";
const TOKEN: &str = "/api/client/v1/token";
const ME: &str = "/api/client/v1/me";
const LOGOUT: &str = "/api/client/v1/logout";

/// Where SpaceRing serves its account pictures.
const AVATAR_PREFIX: &str = "/api/avatars/";

/// The longest name kept, in bytes. SpaceRing allows 32 characters (128
/// UTF-16 units); this leaves room for any of them.
const MAX_NAME_BYTES: usize = 512;

/// The account a token belongs to, as Codeg keeps it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SrnUser {
    /// The SRN number.
    pub srn: u64,
    /// The display name, with control and reordering characters taken out.
    /// May be empty.
    pub name: String,
    /// The picture, as a path on the origin under `/api/avatars/` that
    /// `srn_asset` accepts; `None` when there is none, or when the answer
    /// named something that is not such a path.
    pub avatar_path: Option<String>,
}

/// What creating a login request gave.
#[derive(Debug, Clone)]
pub struct CreatedLogin {
    pub request_id: RequestId,
    /// The authorization page, on the origin, with the request ID in its
    /// fragment and nothing else.
    pub authorization_url: Url,
}

/// What a successful exchange gave.
#[derive(Debug, Clone)]
pub struct Grant {
    pub token: AccessToken,
    pub user: SrnUser,
}

/// A login request, as `POST /api/client/v1/login-requests` takes it.
#[derive(Debug)]
pub struct LoginRequest<'a> {
    pub client_id: &'a str,
    pub redirect_uri: &'a str,
    pub state: &'a FlowSecret,
    /// The S256 challenge of the flow's verifier.
    pub code_challenge: &'a str,
    pub installation_id: &'a str,
    /// What the client runs on: `macos`, `windows`, `linux`.
    pub platform: &'a str,
    /// The computer's name, shown in the website's list of connections.
    pub device_name: Option<&'a str>,
}

/// A code exchange, as `POST /api/client/v1/token` takes it.
#[derive(Debug)]
pub struct CodeExchange<'a> {
    pub client_id: &'a str,
    /// Exactly the one the login request named.
    pub redirect_uri: &'a str,
    pub code: &'a AuthCode,
    pub verifier: &'a FlowSecret,
}

/// The SRN account API of one SpaceRing origin.
#[derive(Debug, Clone)]
pub struct SrnApi {
    origin: Origin,
    timeout: Duration,
    /// A confidential (Web) client's credentials, for the requests that name
    /// the client. None for the desktop's public client.
    client_credentials: Option<ClientSecretBasic>,
}

/// A confidential client's `client_secret_basic` credentials (RFC 6749
/// §2.3.1): its ID and secret, form-encoded, joined by `:`, in base64, as an
/// `Authorization: Basic` header SpaceRing's `client()` reads. Prints as
/// `[redacted]`.
#[derive(Clone)]
pub struct ClientSecretBasic(HeaderValue);

impl ClientSecretBasic {
    pub fn new(client_id: &str, secret: &str) -> Self {
        use base64::Engine as _;
        let form = |value: &str| {
            url::form_urlencoded::byte_serialize(value.as_bytes()).collect::<String>()
        };
        let pair = format!("{}:{}", form(client_id), form(secret));
        let text = format!(
            "Basic {}",
            base64::engine::general_purpose::STANDARD.encode(pair)
        );
        // Base64 and a fixed word: always a valid header value.
        let mut value = HeaderValue::from_str(&text).expect("base64 is a valid header value");
        // Kept out of the HTTP stack's own debug output, as `bearer_auth` does.
        value.set_sensitive(true);
        Self(value)
    }
}

impl std::fmt::Debug for ClientSecretBasic {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("ClientSecretBasic([redacted])")
    }
}

/// An answer, read.
struct Answer {
    status: StatusCode,
    /// The media type, lowercase, without parameters.
    content_type: String,
    retry_after: Option<String>,
    body: Vec<u8>,
}

impl SrnApi {
    pub fn new(origin: Origin) -> Self {
        Self::with_timeout(origin, REQUEST_TIMEOUT)
    }

    pub fn with_timeout(origin: Origin, timeout: Duration) -> Self {
        Self {
            origin,
            timeout,
            client_credentials: None,
        }
    }

    /// This API as a confidential client: `credentials` go with the login
    /// request and the code exchange.
    pub fn with_client_credentials(mut self, credentials: ClientSecretBasic) -> Self {
        self.client_credentials = Some(credentials);
        self
    }

    pub fn origin(&self) -> &Origin {
        &self.origin
    }

    /// `POST /api/client/v1/login-requests`. No retry: a request that fails
    /// is made again only by starting the sign-in again.
    pub async fn create_login_request(
        &self,
        request: &LoginRequest<'_>,
    ) -> Result<CreatedLogin, SrnError> {
        let mut body = json!({
            "client_id": request.client_id,
            "redirect_uri": request.redirect_uri,
            "response_type": "code",
            "scope": SCOPE,
            "state": request.state.expose(),
            "code_challenge": request.code_challenge,
            "code_challenge_method": "S256",
            "installation_id": request.installation_id,
            "platform": request.platform,
        });
        if let Some(name) = request.device_name {
            body["device_name"] = json!(name);
        }
        let answer = self
            .call(Method::POST, LOGIN_REQUESTS, None, Some(&body))
            .await?;
        #[derive(Deserialize)]
        struct Wire {
            request_id: String,
            authorization_url: String,
        }
        let wire: Wire = success(answer, false)?;
        let request_id = RequestId::parse(&wire.request_id)
            .ok_or(SrnError::InvalidResponse("the request ID is not one"))?;
        let authorization_url = self
            .authorization_page(&wire.authorization_url, &request_id)
            .ok_or(SrnError::InvalidResponse(
                "the authorization page is not on this origin",
            ))?;
        Ok(CreatedLogin {
            request_id,
            authorization_url,
        })
    }

    /// `POST /api/client/v1/token`. Made once per code, never again: if its
    /// answer is lost, the sign-in starts over.
    pub async fn exchange_code(&self, exchange: &CodeExchange<'_>) -> Result<Grant, SrnError> {
        self.exchange_code_for_connection(exchange)
            .await
            .map(|(grant, _)| grant)
    }

    /// [`Self::exchange_code`], with SpaceRing's ID of the connection it
    /// opened (`connection_id`), when the answer names one that looks like
    /// one.
    pub async fn exchange_code_for_connection(
        &self,
        exchange: &CodeExchange<'_>,
    ) -> Result<(Grant, Option<String>), SrnError> {
        let body = json!({
            "grant_type": "authorization_code",
            "client_id": exchange.client_id,
            "redirect_uri": exchange.redirect_uri,
            "code": exchange.code.expose(),
            "code_verifier": exchange.verifier.expose(),
        });
        let answer = self.call(Method::POST, TOKEN, None, Some(&body)).await?;
        #[derive(Deserialize)]
        struct Wire {
            access_token: String,
            token_type: String,
            user: UserWire,
            #[serde(default)]
            connection_id: serde_json::Value,
        }
        let wire: Wire = success(answer, false)?;
        if !wire.token_type.eq_ignore_ascii_case("bearer") {
            return Err(SrnError::InvalidResponse("the token is not a Bearer token"));
        }
        let token = AccessToken::parse(&wire.access_token)
            .ok_or(SrnError::InvalidResponse("the token is not one"))?;
        // A UUID as SpaceRing makes them; anything else is not kept.
        let connection_id = wire
            .connection_id
            .as_str()
            .filter(|id| {
                id.len() == 36
                    && id
                        .bytes()
                        .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b) || b == b'-')
            })
            .map(str::to_string);
        Ok((
            Grant {
                token,
                user: self.user(wire.user)?,
            },
            connection_id,
        ))
    }

    /// `GET /api/client/v1/me`: the account the token belongs to, which
    /// SpaceRing also counts as the connection being used (and renews, at
    /// most daily). A 401 is [`SrnError::Unauthorized`].
    pub async fn me(&self, token: &AccessToken) -> Result<SrnUser, SrnError> {
        let answer = self.call(Method::GET, ME, Some(token), None).await?;
        #[derive(Deserialize)]
        struct Wire {
            user: UserWire,
        }
        let wire: Wire = success(answer, true)?;
        self.user(wire.user)
    }

    /// `POST /api/client/v1/logout`: ends the connection. Idempotent on
    /// SpaceRing's side; `Ok` means it confirmed.
    pub async fn logout(&self, token: &AccessToken) -> Result<(), SrnError> {
        let answer = self.call(Method::POST, LOGOUT, Some(token), None).await?;
        #[derive(Deserialize)]
        struct Wire {
            ok: bool,
        }
        let wire: Wire = success(answer, true)?;
        if wire.ok {
            Ok(())
        } else {
            Err(SrnError::InvalidResponse("the sign-out was not confirmed"))
        }
    }

    /// The authorization page SpaceRing named, if it is one Codeg opens: on
    /// this origin, with no credentials, no query, and a fragment that is the
    /// request ID and nothing else.
    fn authorization_page(&self, raw: &str, request_id: &RequestId) -> Option<Url> {
        let url = Url::parse(raw).ok()?;
        let fragment = format!("request_id={}", request_id.expose());
        (self.origin.holds(&url)
            && url.username().is_empty()
            && url.password().is_none()
            && url.query().is_none()
            && url.fragment() == Some(fragment.as_str()))
        .then_some(url)
    }

    fn user(&self, wire: UserWire) -> Result<SrnUser, SrnError> {
        if wire.srn == 0 {
            return Err(SrnError::InvalidResponse("the SRN number is not one"));
        }
        Ok(SrnUser {
            srn: wire.srn,
            name: clean_name(&wire.name),
            avatar_path: wire
                .image
                .as_deref()
                .and_then(|image| avatar_path(image, &self.origin)),
        })
    }

    async fn call(
        &self,
        method: Method,
        path: &str,
        bearer: Option<&AccessToken>,
        body: Option<&serde_json::Value>,
    ) -> Result<Answer, SrnError> {
        // Every path is a constant of this file, so this cannot fail; it is
        // checked all the same, as `harness::client::send` checks its own.
        let url = self
            .origin
            .join(path)
            .map_err(|_| SrnError::InvalidResponse("not an address on the origin"))?;
        let client = http::account_api_client(self.origin.is_https())
            .map_err(|error| SrnError::Network(error.to_string()))?;
        let mut builder = client
            .request(method, url)
            .header(ACCEPT, "application/json")
            .header(CACHE_CONTROL, "no-store")
            .timeout(self.timeout);
        if let Some(token) = bearer {
            // `bearer_auth` marks the header sensitive, which keeps it out of
            // the HTTP stack's own debug output.
            builder = builder.bearer_auth(token.expose());
        } else if let Some(credentials) = &self.client_credentials {
            builder = builder.header(AUTHORIZATION, credentials.0.clone());
        }
        if let Some(body) = body {
            builder = builder.json(body);
        }
        let response = builder
            .send()
            .await
            .map_err(|error| SrnError::Network(http::describe(&error)))?;
        let status = response.status();
        let content_type = http::media_type(response.headers());
        let retry_after = header_text(response.headers(), RETRY_AFTER);
        let body = http::read_capped(response, MAX_ANSWER_BYTES)
            .await
            .map_err(|error| match error {
                crate::harness::HarnessError::Network(text) => SrnError::Network(text),
                _ => SrnError::InvalidResponse("the answer is larger than Codeg accepts"),
            })?;
        Ok(Answer {
            status,
            content_type,
            retry_after,
            body,
        })
    }
}

/// The JSON body of a success, or why it is not one. `bearer` says the
/// request carried a token, which makes a 401 [`SrnError::Unauthorized`].
fn success<T: serde::de::DeserializeOwned>(answer: Answer, bearer: bool) -> Result<T, SrnError> {
    let status = answer.status;
    if status == StatusCode::TOO_MANY_REQUESTS {
        return Err(SrnError::RateLimited {
            seconds: http::retry_after_seconds(answer.retry_after.as_deref()),
        });
    }
    if status == StatusCode::UNAUTHORIZED && bearer {
        return Err(SrnError::Unauthorized);
    }
    if !status.is_success() {
        return Err(SrnError::Status {
            status: status.as_u16(),
            error: error_code(&answer),
        });
    }
    if answer.content_type != "application/json" {
        return Err(SrnError::InvalidResponse("the answer is not JSON"));
    }
    // The parser's own message can quote the answer, which holds a token for
    // one of these requests: only a fixed description leaves here.
    serde_json::from_slice(&answer.body)
        .map_err(|_| SrnError::InvalidResponse("the answer is not the JSON expected"))
}

/// `{ "error": "<snake_case>" }`, the shape of SpaceRing's errors — kept only
/// when it is such a code, so no other text from an answer goes anywhere.
fn error_code(answer: &Answer) -> Option<String> {
    if answer.content_type != "application/json" {
        return None;
    }
    #[derive(Deserialize)]
    struct Wire {
        error: String,
    }
    let wire: Wire = serde_json::from_slice(&answer.body).ok()?;
    let plain = (1..=64).contains(&wire.error.len())
        && wire
            .error
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte == b'_');
    plain.then_some(wire.error)
}

fn header_text(headers: &HeaderMap, name: reqwest::header::HeaderName) -> Option<String> {
    headers
        .get(name)
        .and_then(|value| value.to_str().ok())
        .map(str::to_string)
}

/// `user` as both the exchange and `/me` answer it. Unknown fields are
/// ignored.
#[derive(Deserialize)]
struct UserWire {
    srn: u64,
    name: String,
    #[serde(default)]
    image: Option<String>,
}

/// The path of an account picture, from the address SpaceRing gave for it.
///
/// SpaceRing answers a full URL on its own origin (`profile()` in
/// `api/clients/routes.ts`); Codeg keeps only the path, and only when the
/// address is exactly such a picture: on this origin, with no credentials,
/// query or fragment, and a path `/api/avatars/<id>/<file>` of the shape
/// SpaceRing serves (lowercase letters, digits and `-` in the id; lowercase
/// letters, digits and `.` in the file) that `srn_asset` also accepts.
/// Anything else is no picture: the initial is shown instead.
pub fn avatar_path(image: &str, origin: &Origin) -> Option<String> {
    let url = Url::parse(image).ok()?;
    if !origin.holds(&url) {
        return None;
    }
    let path = url.path();
    // The address must be the origin and the path, exactly as written:
    // credentials, a query, a fragment, a port spelled out, or a path the
    // parser had to normalize (dot segments, escapes) make it something else.
    if image != format!("{}{path}", origin.as_str()) {
        return None;
    }
    let rest = path.strip_prefix(AVATAR_PREFIX)?;
    let (id, file) = rest.split_once('/')?;
    let id_ok = !id.is_empty()
        && id
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-');
    let file_ok = !file.is_empty()
        && !file.starts_with('.')
        && file
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'.');
    if !id_ok || !file_ok {
        return None;
    }
    crate::harness::validate_asset_path(path).ok()?;
    Some(path.to_string())
}

/// A display name as Codeg shows it: control characters and runs of white
/// space made one space, the invisible characters that reorder or hide text
/// taken out (the joiners emoji need stay), trimmed, and at most
/// [`MAX_NAME_BYTES`]. SpaceRing cleans names the same way before it keeps
/// them; this is for an answer that did not.
pub fn clean_name(raw: &str) -> String {
    let mut name = String::with_capacity(raw.len().min(MAX_NAME_BYTES));
    let mut space = false;
    for ch in raw.chars() {
        if is_hidden(ch) {
            continue;
        }
        if ch.is_control() || ch.is_whitespace() {
            space = true;
            continue;
        }
        if space && !name.is_empty() {
            name.push(' ');
        }
        space = false;
        if name.len() + ch.len_utf8() > MAX_NAME_BYTES {
            break;
        }
        name.push(ch);
    }
    name
}

/// Format characters that reorder or hide text: the bidirectional controls,
/// zero-width space and marks, word joiner and invisible operators, the
/// byte-order mark. Not the zero-width joiners, which emoji and some scripts
/// need.
fn is_hidden(ch: char) -> bool {
    matches!(
        ch,
        '\u{00AD}'
            | '\u{061C}'
            | '\u{180E}'
            | '\u{200B}'
            | '\u{200E}'
            | '\u{200F}'
            | '\u{202A}'..='\u{202E}'
            | '\u{2060}'..='\u{2064}'
            | '\u{2066}'..='\u{2069}'
            | '\u{FEFF}'
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::srn::test_support::{MockSrn, Reply};

    fn origin() -> Origin {
        Origin::release()
    }

    #[test]
    fn an_avatar_is_kept_only_as_a_path_spacering_serves() {
        let origin = origin();
        let id = "0199b5e2-6c4f-7d1a-9f2e-3c8a1b5d7e90";
        let good = format!("https://spacering.net/api/avatars/{id}/4f1c2a9e8b7d6c5a.png");
        assert_eq!(
            avatar_path(&good, &origin).as_deref(),
            Some(format!("/api/avatars/{id}/4f1c2a9e8b7d6c5a.png").as_str())
        );
        for bad in [
            // not on the origin
            format!("https://elsewhere.example/api/avatars/{id}/a.png"),
            format!("http://spacering.net/api/avatars/{id}/a.png"),
            format!("https://spacering.net:8443/api/avatars/{id}/a.png"),
            format!("https://user:pw@spacering.net/api/avatars/{id}/a.png"),
            format!("https://user@spacering.net/api/avatars/{id}/a.png"),
            // a path, not an address: the answer is always a full URL
            format!("/api/avatars/{id}/a.png"),
            // not a picture SpaceRing serves
            "https://spacering.net/api/me".to_string(),
            "https://spacering.net/api/avatars/".to_string(),
            format!("https://spacering.net/api/avatars/{id}"),
            format!("https://spacering.net/api/avatars/{id}/"),
            format!("https://spacering.net/api/avatars/{id}/a/b.png"),
            format!("https://spacering.net/api/avatars/{id}/.png"),
            format!("https://spacering.net/api/avatars/{id}/A.png"),
            format!("https://spacering.net/api/avatars/{id}/a_b.png"),
            format!(
                "https://spacering.net/api/avatars/{}/a.png",
                id.to_uppercase()
            ),
            format!("https://spacering.net/api/harness/v1/media/{id}.png"),
            // tricks
            format!("https://spacering.net/api/avatars/{id}/a.png?x=1"),
            format!("https://spacering.net/api/avatars/{id}/a.png#x"),
            format!("https://spacering.net/api/avatars/../me/{id}/a.png"),
            format!("https://spacering.net/api/x/../avatars/{id}/a.png"),
            format!("https://spacering.net/api/avatars/{id}/%2e%2e"),
            format!("https://spacering.net/api/avatars/%2e%2e/{id}"),
            format!("https://spacering.net/api/avatars/{id}/a%2Fb.png"),
            format!(
                "https://spacering.net/api/avatars/{}/a.png",
                "a".repeat(300)
            ),
            "javascript:alert(1)".to_string(),
            String::new(),
        ] {
            assert_eq!(avatar_path(&bad, &origin), None, "{bad}");
        }
    }

    #[test]
    fn every_kept_avatar_is_one_srn_asset_accepts() {
        let origin = origin();
        for file in ["a.png", "4f1c2a9e8b7d6c5a.webp", "x.y.gif", "0.jpg"] {
            let image = format!("https://spacering.net/api/avatars/u-1/{file}");
            let path = avatar_path(&image, &origin).expect(file);
            assert!(crate::harness::validate_asset_path(&path).is_ok(), "{path}");
        }
    }

    #[test]
    fn a_name_is_shown_as_text() {
        assert_eq!(clean_name("  Ada  Lovelace "), "Ada Lovelace");
        assert_eq!(clean_name("Ada\nLovelace\t"), "Ada Lovelace");
        assert_eq!(clean_name("\u{202E}nimda"), "nimda");
        assert_eq!(clean_name("a\u{200B}b\u{FEFF}"), "ab");
        // emoji sequences keep their joiners
        assert_eq!(clean_name("👩\u{200D}💻"), "👩\u{200D}💻");
        assert_eq!(clean_name("李\u{0000}雷"), "李 雷");
        assert_eq!(clean_name(""), "");
        let long = clean_name(&"名".repeat(1000));
        assert!(long.len() <= MAX_NAME_BYTES && long.chars().all(|c| c == '名'));
    }

    #[tokio::test]
    async fn the_client_of_an_https_origin_speaks_nothing_else() {
        assert!(Origin::release().is_https());
        let srn = MockSrn::start().await;
        let client = http::account_api_client(true).unwrap();
        let sent = client
            .get(format!("{}{ME}", srn.origin().as_str()))
            .send()
            .await;
        assert!(sent.is_err(), "plain HTTP was spoken");
        assert!(srn.seen().is_empty(), "the request left");
    }

    #[tokio::test]
    async fn no_request_follows_a_redirect_and_none_is_repeated() {
        let srn = MockSrn::start().await;
        srn.script_token(Reply::Redirect("/api/client/v1/token-elsewhere".into()));
        let api = srn.api();
        let created = srn.create(&api).await;
        let code = srn.approve(&created).unwrap();
        let verifier = srn.verifier_of(&created);
        let result = api
            .exchange_code(&CodeExchange {
                client_id: "codeg-desktop",
                redirect_uri: &srn.redirect_of(&created),
                code: &code,
                verifier: &verifier,
            })
            .await;
        assert_eq!(
            result.unwrap_err(),
            SrnError::Status {
                status: 302,
                error: None
            }
        );
        let paths = srn.paths();
        assert_eq!(
            paths
                .iter()
                .filter(|path| path.starts_with("/api/client/v1/token"))
                .count(),
            1,
            "{paths:?}"
        );
        assert!(!paths.iter().any(|p| p.ends_with("token-elsewhere")));
    }

    #[tokio::test]
    async fn a_request_names_its_client_its_redirect_and_its_challenge() {
        let srn = MockSrn::start().await;
        let api = srn.api();
        let created = srn.create(&api).await;
        let sent = srn.login_body(&created);
        assert_eq!(sent["client_id"], "codeg-desktop");
        assert_eq!(sent["response_type"], "code");
        assert_eq!(sent["scope"], "profile:read");
        assert_eq!(sent["code_challenge_method"], "S256");
        assert_eq!(sent["platform"], std::env::consts::OS);
        assert!(crate::srn::pkce::is_opaque(sent["state"].as_str().unwrap()));
        assert!(crate::srn::pkce::is_opaque(
            sent["code_challenge"].as_str().unwrap()
        ));
        assert_eq!(
            created.authorization_url.as_str(),
            format!(
                "{}/authorize/#request_id={}",
                srn.origin().as_str(),
                created.request_id.expose()
            )
        );
        let seen = srn.seen();
        let login = seen.iter().find(|s| s.path == LOGIN_REQUESTS).unwrap();
        assert_eq!(login.header("cache-control"), Some("no-store"));
        assert_eq!(login.header("cookie"), None);
        assert_eq!(login.header("authorization"), None);
        assert!(login
            .header("user-agent")
            .is_some_and(|ua| ua.starts_with("codeg/")));
    }

    #[tokio::test]
    async fn an_authorization_page_off_the_origin_is_refused() {
        let srn = MockSrn::start().await;
        let api = srn.api();
        for page in [
            "https://elsewhere.example/authorize/#request_id={id}",
            "{origin}/authorize/?x=1#request_id={id}",
            "{origin}/authorize/#request_id={id}&next=1",
            "{origin}/authorize/",
        ] {
            srn.script_authorization_url(page);
            let state = FlowSecret::generate().unwrap();
            let challenge = FlowSecret::generate().unwrap().challenge();
            let result = api
                .create_login_request(&LoginRequest {
                    client_id: "codeg-desktop",
                    redirect_uri: "http://127.0.0.1:43210/auth/callback",
                    state: &state,
                    code_challenge: &challenge,
                    installation_id: "installation-0123456789",
                    platform: "macos",
                    device_name: None,
                })
                .await;
            assert!(
                matches!(result, Err(SrnError::InvalidResponse(_))),
                "{page}: {result:?}"
            );
        }
    }

    #[tokio::test]
    async fn errors_are_read_by_their_status_and_code() {
        let srn = MockSrn::start().await;
        let api = srn.api();
        let token = AccessToken::parse(&"t".repeat(43)).unwrap();

        srn.script_me(Reply::Status(401, json!({ "error": "invalid_token" })));
        assert_eq!(api.me(&token).await.unwrap_err(), SrnError::Unauthorized);

        srn.script_me(Reply::RateLimited(17));
        assert_eq!(
            api.me(&token).await.unwrap_err(),
            SrnError::RateLimited { seconds: 17 }
        );

        srn.script_me(Reply::Status(503, json!({ "error": "server_error" })));
        assert_eq!(
            api.me(&token).await.unwrap_err(),
            SrnError::Status {
                status: 503,
                error: Some("server_error".into())
            }
        );

        // an error code that is not one is not kept
        srn.script_me(Reply::Status(500, json!({ "error": "Bad <b>thing</b>" })));
        assert_eq!(
            api.me(&token).await.unwrap_err(),
            SrnError::Status {
                status: 500,
                error: None
            }
        );

        srn.script_me(Reply::Text(200, "text/html", "<html>".into()));
        assert!(matches!(
            api.me(&token).await.unwrap_err(),
            SrnError::InvalidResponse(_)
        ));

        srn.script_me(Reply::Text(200, "application/json", "x".repeat(70_000)));
        assert!(matches!(
            api.me(&token).await.unwrap_err(),
            SrnError::InvalidResponse(_)
        ));

        srn.script_token(Reply::Status(400, json!({ "error": "invalid_grant" })));
        let code = AuthCode::parse(&"c".repeat(43)).unwrap();
        let verifier = FlowSecret::generate().unwrap();
        assert_eq!(
            api.exchange_code(&CodeExchange {
                client_id: "codeg-desktop",
                redirect_uri: "http://127.0.0.1:43210/auth/callback",
                code: &code,
                verifier: &verifier,
            })
            .await
            .unwrap_err(),
            SrnError::Status {
                status: 400,
                error: Some("invalid_grant".into())
            }
        );
    }

    #[tokio::test]
    async fn a_token_that_is_not_one_is_not_believed() {
        let srn = MockSrn::start().await;
        let api = srn.api();
        let created = srn.create(&api).await;
        let code = srn.approve(&created).unwrap();
        srn.script_token(Reply::Json(json!({
            "access_token": "short",
            "token_type": "Bearer",
            "scope": "profile:read",
            "expires_at": "2026-12-16T00:00:00.000Z",
            "connection_id": "c",
            "user": { "srn": 10000, "name": "Ada", "image": null }
        })));
        let result = api
            .exchange_code(&CodeExchange {
                client_id: "codeg-desktop",
                redirect_uri: &srn.redirect_of(&created),
                code: &code,
                verifier: &srn.verifier_of(&created),
            })
            .await;
        assert!(matches!(result, Err(SrnError::InvalidResponse(_))));
        // and the message says nothing of what the answer held
        assert!(!format!("{:?}", result.unwrap_err()).contains("short"));
    }

    #[tokio::test]
    async fn me_and_logout_carry_the_token_as_a_bearer_and_nothing_else() {
        let srn = MockSrn::start().await;
        let api = srn.api();
        let grant = srn.sign_in_directly(&api).await;
        let user = api.me(&grant.token).await.unwrap();
        assert_eq!(user.srn, srn.user_srn());
        assert_eq!(user.avatar_path.as_deref(), Some(srn.avatar_path()));
        api.logout(&grant.token).await.unwrap();
        assert_eq!(
            api.me(&grant.token).await.unwrap_err(),
            SrnError::Unauthorized
        );
        let seen = srn.seen();
        let me = seen.iter().find(|s| s.path == ME).unwrap();
        assert_eq!(
            me.header("authorization"),
            Some(format!("Bearer {}", grant.token.expose()).as_str())
        );
        assert_eq!(me.header("cookie"), None);
    }
}
