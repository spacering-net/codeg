//! The HTTP side of Codeg Web's SRN sign-in: four routes, the two cookies,
//! and the request checks. Mounted by `web::router` beside — not inside —
//! the instance API, ahead of the static pages:
//!
//! | Route | Instance access | Also required |
//! | --- | --- | --- |
//! | `POST /api/account/srn/login` | yes | `Origin` = `CODEG_PUBLIC_URL`, JSON |
//! | `GET /auth/srn/callback` | **no** | the flow cookie the sign-in is bound to |
//! | `GET /api/account/srn` | yes | — (the session cookie says who) |
//! | `POST /api/account/srn/logout` | yes | `Origin`, JSON, the session cookie |
//!
//! The callback is the one exception to instance access: it is a top-level
//! navigation from SpaceRing, which carries neither the token (kept in the
//! page's storage) nor gets past proxy-jwt's refusal of cross-site requests.
//! It can only complete a sign-in an admitted page started in the same
//! browser (the flow cookie), and what it yields — the session cookie —
//! admits nothing: no instance API or WebSocket reads these cookies.
//!
//! None of these routes is under the instance API's wildcard CORS, and none
//! offers CORS of its own: a page elsewhere can neither read them nor send
//! them JSON. Every answer is `no-store`. The account domain never answers
//! 401 — that is the instance's "enter the token" — so a browser that is
//! merely signed out of SRN is not sent to the token page.

use std::sync::Arc;

use axum::body::Bytes;
use axum::extract::{DefaultBodyLimit, Extension, RawQuery, Request};
use axum::http::{header, HeaderMap, HeaderValue, Method, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::de::DeserializeOwned;
use serde::Serialize;

use super::config::CALLBACK_PATH;
use super::service::{
    Callback, Completed, CookieChanges, Presented, SrnWeb, LOGIN_LIFETIME, SESSION_LIFETIME,
};
use super::types::{LoginBody, LogoutBody, SrnWebAccountState, WebProblem, CALLBACK_RESULTS};
use crate::models::system::AppLocale;
use crate::srn::error::Problem;
use crate::srn::pkce::{is_opaque, AuthCode};
use crate::web::auth::{require_auth, WebAuth};

/// Which SRN user this browser is.
pub const SESSION_COOKIE: &str = "__Host-codeg_srn";
/// The sign-in this browser started, for ten minutes.
pub const FLOW_COOKIE: &str = "__Host-codeg_srn_flow";

pub const ACCOUNT_PATH: &str = "/api/account/srn";
pub const LOGIN_PATH: &str = "/api/account/srn/login";
pub const LOGOUT_PATH: &str = "/api/account/srn/logout";

/// Where a sign-in that came back sends the browser, with `?srn=<result>`.
pub const RETURN_PATH: &str = "/workspace";

/// The bodies are a few dozen bytes.
const MAX_BODY_BYTES: usize = 4096;

/// More cookies of one name than this are not looked at.
const MAX_COOKIES_PER_NAME: usize = 4;

/// The service, or none when this process never set one up (then SRN
/// sign-in is simply not enabled).
#[derive(Clone)]
struct Handle(Option<Arc<SrnWeb>>);

/// The routes. `auth` is the instance's own access check, the one every
/// instance API route has.
pub fn router(service: Option<Arc<SrnWeb>>, auth: WebAuth) -> Router {
    let admitted = Router::new()
        .route(ACCOUNT_PATH, get(account))
        .route(LOGIN_PATH, post(login))
        .route(LOGOUT_PATH, post(logout))
        .layer(DefaultBodyLimit::max(MAX_BODY_BYTES))
        .layer(middleware::from_fn(move |request, next| {
            require_auth(request, next, auth.clone())
        }));
    Router::new()
        .route(CALLBACK_PATH, get(callback))
        .merge(admitted)
        .layer(middleware::from_fn(protect))
        .layer(Extension(Handle(service)))
}

/// On every answer of these routes, the instance's 401s included.
async fn protect(request: Request, next: Next) -> Response {
    let mut response = next.run(request).await;
    let headers = response.headers_mut();
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    headers.insert(
        header::REFERRER_POLICY,
        HeaderValue::from_static("no-referrer"),
    );
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    response
}

// ─── Handlers ───────────────────────────────────────────────────────────

/// `GET /api/account/srn[?locale=<AppLocale>]`.
async fn account(
    Extension(handle): Extension<Handle>,
    headers: HeaderMap,
    RawQuery(query): RawQuery,
) -> Response {
    let Some(service) = handle.0 else {
        return answer(
            StatusCode::OK,
            &SrnWebAccountState::NotEnabled,
            &CookieChanges::default(),
        );
    };
    let (state, cookies) = service
        .account(&presented(&headers), locale_of(query.as_deref()))
        .await;
    answer(StatusCode::OK, &state, &cookies)
}

/// `POST /api/account/srn/login`, body `{ "locale"?: AppLocale }`.
async fn login(Extension(handle): Extension<Handle>, headers: HeaderMap, body: Bytes) -> Response {
    let service = match admitted_write(&handle, &headers) {
        Ok(service) => service,
        Err(problem) => return refusal(&problem),
    };
    let Some(body) = json_body::<LoginBody>(&headers, &body) else {
        return refusal(&WebProblem::InvalidRequest);
    };
    match service.start_login(&presented(&headers), body.locale).await {
        Ok((started, cookies)) => answer(StatusCode::OK, &started, &cookies),
        Err(problem) => refusal(&problem),
    }
}

/// `POST /api/account/srn/logout`, body
/// `{ "expectedSrn"?: number, "locale"?: AppLocale }`.
async fn logout(Extension(handle): Extension<Handle>, headers: HeaderMap, body: Bytes) -> Response {
    let service = match admitted_write(&handle, &headers) {
        Ok(service) => service,
        Err(problem) => return refusal(&problem),
    };
    let Some(body) = json_body::<LogoutBody>(&headers, &body) else {
        return refusal(&WebProblem::InvalidRequest);
    };
    match service
        .sign_out(&presented(&headers), body.expected_srn, body.locale)
        .await
    {
        Ok((result, cookies)) => answer(StatusCode::OK, &result, &cookies),
        Err(problem) => refusal(&problem),
    }
}

/// `GET /auth/srn/callback?code=…&state=…` (or `?error=access_denied&state=…`):
/// always a 303 to `/workspace?srn=<result>`.
async fn callback(
    Extension(handle): Extension<Handle>,
    method: Method,
    headers: HeaderMap,
    RawQuery(query): RawQuery,
) -> Response {
    // Axum answers HEAD with the GET handler; a HEAD (a link checker, a
    // preview) must not spend the sign-in.
    if method != Method::GET {
        return StatusCode::METHOD_NOT_ALLOWED.into_response();
    }
    let presented = presented(&headers);
    let completed = match handle.0 {
        Some(service) => {
            service
                .complete(parse_callback(query.as_deref()), &presented)
                .await
        }
        None => Completed {
            result: WebProblem::NotEnabled.code(),
            cookies: CookieChanges {
                clear_flow: true,
                ..CookieChanges::default()
            },
        },
    };
    let result = if CALLBACK_RESULTS.contains(&completed.result) {
        completed.result
    } else {
        "internal"
    };
    let mut response = (
        StatusCode::SEE_OTHER,
        [(header::LOCATION, format!("{RETURN_PATH}?srn={result}"))],
    )
        .into_response();
    set_cookies(response.headers_mut(), &completed.cookies);
    response
}

// ─── Checks ─────────────────────────────────────────────────────────────

/// A write (login, logout) is the instance's page asking: SRN sign-in is on,
/// and the request's `Origin` is exactly the public URL.
fn admitted_write(handle: &Handle, headers: &HeaderMap) -> Result<Arc<SrnWeb>, WebProblem> {
    let service = handle
        .0
        .clone()
        .filter(|service| service.is_enabled())
        .ok_or(WebProblem::NotEnabled)?;
    let expected = service.public_origin().unwrap_or_default();
    let mut origins = headers.get_all(header::ORIGIN).iter();
    match (origins.next(), origins.next()) {
        (Some(origin), None) if origin.to_str().is_ok_and(|o| o == expected) => Ok(service),
        _ => Err(WebProblem::OriginRefused),
    }
}

/// The body, when the request says it is JSON (`application/json`, UTF-8)
/// and it is a JSON object of the expected shape.
fn json_body<T: DeserializeOwned>(headers: &HeaderMap, body: &[u8]) -> Option<T> {
    let content_type = headers.get(header::CONTENT_TYPE)?.to_str().ok()?;
    let mut parts = content_type.split(';');
    if !parts
        .next()?
        .trim()
        .eq_ignore_ascii_case("application/json")
    {
        return None;
    }
    for parameter in parts {
        let (name, value) = parameter.split_once('=')?;
        if !name.trim().eq_ignore_ascii_case("charset")
            || !value.trim().trim_matches('"').eq_ignore_ascii_case("utf-8")
        {
            return None;
        }
    }
    let value: serde_json::Value = serde_json::from_slice(body).ok()?;
    if !value.is_object() {
        return None;
    }
    serde_json::from_value(value).ok()
}

/// The well-formed values of the two cookies this request carries.
fn presented(headers: &HeaderMap) -> Presented {
    Presented {
        session: cookie_values(headers, SESSION_COOKIE),
        flow: cookie_values(headers, FLOW_COOKIE),
    }
}

fn cookie_values(headers: &HeaderMap, name: &str) -> Vec<String> {
    let mut values: Vec<String> = Vec::new();
    for header in headers.get_all(header::COOKIE) {
        let Ok(text) = header.to_str() else {
            continue;
        };
        for pair in text.split(';') {
            let Some((key, value)) = pair.trim().split_once('=') else {
                continue;
            };
            let value = value.trim();
            if key.trim() == name
                && is_opaque(value)
                && !values.iter().any(|v| v == value)
                && values.len() < MAX_COOKIES_PER_NAME
            {
                values.push(value.to_string());
            }
        }
    }
    values
}

/// Exactly `code` and `state`, or `error=access_denied` and `state`; each
/// once, nothing else.
fn parse_callback(query: Option<&str>) -> Result<Callback, ()> {
    let mut code = None;
    let mut state = None;
    let mut error = None;
    for (name, value) in url::form_urlencoded::parse(query.unwrap_or_default().as_bytes()) {
        let slot = match name.as_ref() {
            "code" => &mut code,
            "state" => &mut state,
            "error" => &mut error,
            _ => return Err(()),
        };
        if slot.replace(value.into_owned()).is_some() {
            return Err(());
        }
    }
    let state = state.filter(|state| is_opaque(state)).ok_or(())?;
    match (code, error) {
        (Some(code), None) => Ok(Callback::Code {
            code: AuthCode::parse(&code).ok_or(())?,
            state,
        }),
        (None, Some(error)) if error == "access_denied" => Ok(Callback::Denied { state }),
        _ => Err(()),
    }
}

fn locale_of(query: Option<&str>) -> Option<AppLocale> {
    url::form_urlencoded::parse(query.unwrap_or_default().as_bytes())
        .find(|(name, _)| name == "locale")
        .and_then(|(_, value)| {
            serde_json::from_value(serde_json::Value::String(value.into_owned())).ok()
        })
}

// ─── Answers ────────────────────────────────────────────────────────────

fn answer<T: Serialize>(status: StatusCode, body: &T, cookies: &CookieChanges) -> Response {
    let mut response = (status, Json(body)).into_response();
    set_cookies(response.headers_mut(), cookies);
    response
}

/// A problem, as the account domain answers it: never 401.
fn refusal(problem: &WebProblem) -> Response {
    let status = match problem {
        WebProblem::NotEnabled | WebProblem::SessionUnreadable => StatusCode::CONFLICT,
        WebProblem::OriginRefused => StatusCode::FORBIDDEN,
        WebProblem::InvalidRequest | WebProblem::FlowMissing | WebProblem::InvalidCallback => {
            StatusCode::BAD_REQUEST
        }
        WebProblem::KeyUnavailable { .. } | WebProblem::Storage { .. } => {
            StatusCode::SERVICE_UNAVAILABLE
        }
        WebProblem::Shared(Problem::AccountChanged) => StatusCode::CONFLICT,
        WebProblem::Shared(
            Problem::Network { .. }
            | Problem::RateLimited { .. }
            | Problem::Server { .. }
            | Problem::InvalidResponse { .. }
            | Problem::ClientRejected,
        ) => StatusCode::BAD_GATEWAY,
        WebProblem::Shared(_) => StatusCode::INTERNAL_SERVER_ERROR,
    };
    (status, Json(problem.to_app_error())).into_response()
}

fn set_cookies(headers: &mut HeaderMap, cookies: &CookieChanges) {
    let mut add = |name: &str, value: Option<&str>, max_age: u64| {
        let text = format!(
            "{name}={}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age={max_age}",
            value.unwrap_or_default()
        );
        if let Ok(mut value) = HeaderValue::from_str(&text) {
            value.set_sensitive(true);
            headers.append(header::SET_COOKIE, value);
        }
    };
    match (&cookies.session, cookies.clear_session) {
        (Some(value), _) => add(SESSION_COOKIE, Some(value), SESSION_LIFETIME.as_secs()),
        (None, true) => add(SESSION_COOKIE, None, 0),
        (None, false) => {}
    }
    match (&cookies.flow, cookies.clear_flow) {
        (Some(value), _) => add(FLOW_COOKIE, Some(value), LOGIN_LIFETIME.as_secs()),
        (None, true) => add(FLOW_COOKIE, None, 0),
        (None, false) => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn opaque(c: char) -> String {
        c.to_string().repeat(43)
    }

    #[test]
    fn a_callback_is_code_and_state_or_a_refusal_and_state() {
        let state = opaque('s');
        let code = opaque('c');
        assert!(matches!(
            parse_callback(Some(&format!("code={code}&state={state}"))),
            Ok(Callback::Code { .. })
        ));
        assert!(matches!(
            parse_callback(Some(&format!("state={state}&error=access_denied"))),
            Ok(Callback::Denied { .. })
        ));
        for bad in [
            String::new(),
            format!("code={code}"),
            format!("state={state}"),
            format!("code={code}&state={state}&state={state}"),
            format!("code={code}&code={code}&state={state}"),
            format!("code={code}&state={state}&next=/x"),
            format!("code={code}&state={state}&error=access_denied"),
            format!("error=server_error&state={state}"),
            format!("code=short&state={state}"),
            format!("code={code}&state=short"),
            format!("code={code}%21&state={state}"),
        ] {
            assert!(parse_callback(Some(&bad)).is_err(), "{bad}");
        }
        assert!(parse_callback(None).is_err());
    }

    #[test]
    fn cookies_are_read_by_exact_name_and_shape() {
        let mut headers = HeaderMap::new();
        let good = opaque('a');
        let flow = opaque('f');
        headers.append(
            header::COOKIE,
            HeaderValue::from_str(&format!(
                "other=1; {SESSION_COOKIE}={good}; {FLOW_COOKIE}={flow}; \
                 x{SESSION_COOKIE}={}; {SESSION_COOKIE}=short",
                opaque('x')
            ))
            .unwrap(),
        );
        headers.append(
            header::COOKIE,
            HeaderValue::from_str(&format!("{SESSION_COOKIE}={good}")).unwrap(),
        );
        let presented = presented(&headers);
        assert_eq!(presented.session, vec![good]);
        assert_eq!(presented.flow, vec![flow]);
    }

    #[test]
    fn json_is_an_object_said_to_be_json() {
        let mut headers = HeaderMap::new();
        assert!(json_body::<LoginBody>(&headers, b"{}").is_none());
        headers.insert(header::CONTENT_TYPE, HeaderValue::from_static("text/plain"));
        assert!(json_body::<LoginBody>(&headers, b"{}").is_none());
        headers.insert(
            header::CONTENT_TYPE,
            HeaderValue::from_static("application/x-www-form-urlencoded"),
        );
        assert!(json_body::<LoginBody>(&headers, b"{}").is_none());
        for good in ["application/json", "Application/JSON; charset=UTF-8"] {
            headers.insert(header::CONTENT_TYPE, HeaderValue::from_static(good));
            assert!(json_body::<LoginBody>(&headers, b"{}").is_some(), "{good}");
            assert!(json_body::<LoginBody>(&headers, b"[]").is_none());
            assert!(json_body::<LoginBody>(&headers, b"").is_none());
            assert!(json_body::<LoginBody>(&headers, b"{\"x\":1}").is_none());
        }
        headers.insert(
            header::CONTENT_TYPE,
            HeaderValue::from_static("application/json; charset=latin1"),
        );
        assert!(json_body::<LoginBody>(&headers, b"{}").is_none());
    }

    #[test]
    fn a_locale_comes_from_the_query() {
        assert_eq!(locale_of(Some("locale=zh_cn")), Some(AppLocale::ZhCn));
        assert_eq!(locale_of(Some("locale=xx")), None);
        assert_eq!(locale_of(None), None);
    }
}
