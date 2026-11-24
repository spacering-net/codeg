//! The one-shot listener the browser comes back to (RFC 8252 §7.3).
//!
//! Bound to `127.0.0.1` on a port the system picks, and answering exactly one
//! request: `GET /auth/callback` with
//!
//! - a `Host` of `127.0.0.1:<its port>`, and no other;
//! - a query of exactly `code` and `state`, or exactly `error` and `state` with
//!   an `error` SpaceRing sends back ([`ERRORS`]); each once;
//! - a `state` equal, compared in constant time, to the flow's, and a code of
//!   the shape SpaceRing makes.
//!
//! That request gets the page that says to return to Codeg, and the listener
//! closes at once: a second callback finds nothing listening. Every other
//! request — another path, method or host, a parameter too many or too few,
//! another state, an error from outside the list — gets a 404 and changes
//! nothing, so the flow is still there for the real answer. The listener
//! also closes when its flow is cancelled, replaced or expires
//! (`CancellationToken`).
//!
//! Every response is `Cache-Control: no-store`, `Referrer-Policy:
//! no-referrer`, `Connection: close` and under the page's
//! `Content-Security-Policy` ([`page::CONTENT_SECURITY_POLICY`]: nothing may
//! load or run but the page's own inline stylesheet, by its hash). Nothing
//! about a request — its address, its query, a header — is logged.

use std::net::Ipv4Addr;
use std::sync::{Arc, LazyLock, Mutex};

use axum::extract::{Request, State};
use axum::http::{header, HeaderValue, Method, StatusCode};
use axum::response::{IntoResponse, Response};
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;

use super::page::{self, Outcome, PageLanguage};
use super::pkce::{AuthCode, FlowSecret};
use crate::harness::origin;

/// The redirect's path, as the registration names it.
pub(crate) const CALLBACK_PATH: &str = "/auth/callback";

/// The errors SpaceRing's authorization page sends back to a client
/// (`decision` in `api/clients/routes.ts`): declining is the only one.
pub(crate) const ERRORS: [&str; 1] = ["access_denied"];

/// What the browser brought back.
#[derive(Debug)]
pub(crate) enum Callback {
    Code(AuthCode),
    /// `error=access_denied`.
    Declined,
}

/// A listener, waiting.
#[derive(Debug)]
pub(crate) struct Listener {
    pub port: u16,
    /// The one callback, once it has come.
    pub callback: oneshot::Receiver<Callback>,
}

impl Listener {
    /// `http://127.0.0.1:<port>/auth/callback`: the redirect the login
    /// request names, and the exchange after it.
    pub fn redirect_uri(&self) -> String {
        format!("http://127.0.0.1:{}{CALLBACK_PATH}", self.port)
    }
}

/// What every request is checked against.
struct Expected {
    /// `127.0.0.1:<port>`.
    host: String,
    state: FlowSecret,
    language: PageLanguage,
    /// Taken by the one request that matches.
    sender: Mutex<Option<oneshot::Sender<Callback>>>,
    /// Closes the listener.
    close: CancellationToken,
}

/// Starts listening. The listener closes when `stop` is cancelled, or right
/// after the one callback it answers.
pub(crate) async fn listen(
    state: FlowSecret,
    language: PageLanguage,
    stop: &CancellationToken,
) -> std::io::Result<Listener> {
    let listener = tokio::net::TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await?;
    let port = listener.local_addr()?.port();
    // SpaceRing accepts loopback ports 1024–65535; a system that hands out
    // a privileged one has given something the redirect cannot name.
    if port < 1024 {
        return Err(std::io::Error::other("the system gave a port below 1024"));
    }
    let (sender, callback) = oneshot::channel();
    // A child: the flow's cancellation closes the listener, and the listener
    // closing (after its callback) does not cancel the flow.
    let close = stop.child_token();
    let expected = Arc::new(Expected {
        host: format!("127.0.0.1:{port}"),
        state,
        language,
        sender: Mutex::new(Some(sender)),
        close: close.clone(),
    });
    let app = axum::Router::new().fallback(answer).with_state(expected);
    tokio::spawn(async move {
        // `with_graceful_shutdown` drops the socket as soon as the token is
        // cancelled, so no connection is accepted after that; one already
        // answering finishes its response.
        let _ = axum::serve(listener, app)
            .with_graceful_shutdown(close.cancelled_owned())
            .await;
    });
    Ok(Listener { port, callback })
}

async fn answer(State(expected): State<Arc<Expected>>, request: Request) -> Response {
    match expected.accept(&request) {
        Some(outcome) => respond(
            StatusCode::OK,
            "text/html; charset=utf-8",
            // a link back to Codeg only where `codeg://` is this build's
            page::html(outcome, expected.language, origin::is_release_build()),
        ),
        None => respond(
            StatusCode::NOT_FOUND,
            "text/plain; charset=utf-8",
            "Not found".into(),
        ),
    }
}

impl Expected {
    /// The outcome, when `request` is the one callback; `None` for anything
    /// else, which leaves everything as it was.
    fn accept(&self, request: &Request) -> Option<Outcome> {
        if request.method() != Method::GET {
            return None;
        }
        // The request target as sent: a path, never an absolute URL naming
        // some host, exactly the callback's.
        let uri = request.uri();
        if uri.scheme().is_some() || uri.authority().is_some() || uri.path() != CALLBACK_PATH {
            return None;
        }
        let mut hosts = request.headers().get_all(header::HOST).iter();
        let host = hosts.next()?;
        if hosts.next().is_some() || host.as_bytes() != self.host.as_bytes() {
            return None;
        }
        let callback = read_query(uri.query()?, &self.state)?;
        // The first match takes the sender; a second has nothing to take.
        let sender = self
            .sender
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .take()?;
        self.close.cancel();
        let outcome = match callback {
            Callback::Code(_) => Outcome::Received,
            Callback::Declined => Outcome::Declined,
        };
        // If the flow is gone, nobody is waiting: the page is still the
        // right one to show.
        let _ = sender.send(callback);
        Some(outcome)
    }
}

/// `code` + `state`, or `error` + `state`, each exactly once and nothing else.
fn read_query(query: &str, expected: &FlowSecret) -> Option<Callback> {
    let (mut code, mut error, mut state) = (None, None, None);
    for (name, value) in url::form_urlencoded::parse(query.as_bytes()) {
        let slot = match name.as_ref() {
            "code" => &mut code,
            "error" => &mut error,
            "state" => &mut state,
            _ => return None,
        };
        if slot.replace(value.into_owned()).is_some() {
            return None;
        }
    }
    let state = state?;
    let callback = match (code, error) {
        (Some(code), None) => Callback::Code(AuthCode::parse(&code)?),
        (None, Some(error)) if ERRORS.contains(&error.as_str()) => Callback::Declined,
        _ => return None,
    };
    expected.matches(&state).then_some(callback)
}

/// The page's policy as a header value: visible ASCII (a base64 hash among
/// fixed directives), so it always is one.
static POLICY: LazyLock<HeaderValue> = LazyLock::new(|| {
    HeaderValue::from_str(&page::CONTENT_SECURITY_POLICY).expect("the policy is visible ASCII")
});

fn respond(status: StatusCode, content_type: &'static str, body: String) -> Response {
    let mut response = (status, body).into_response();
    let headers = response.headers_mut();
    headers.insert(header::CONTENT_SECURITY_POLICY, POLICY.clone());
    for (name, value) in [
        (header::CONTENT_TYPE, content_type),
        (header::CACHE_CONTROL, "no-store"),
        (header::REFERRER_POLICY, "no-referrer"),
        (header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
        // one request per connection: nothing is answered on it afterwards
        (header::CONNECTION, "close"),
    ] {
        headers.insert(name, HeaderValue::from_static(value));
    }
    response
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::srn::test_support::{raw_get, wait_closed};

    fn secret() -> FlowSecret {
        FlowSecret::generate().unwrap()
    }

    fn query(pairs: &[(&str, &str)]) -> String {
        let mut query = url::form_urlencoded::Serializer::new(String::new());
        for (name, value) in pairs {
            query.append_pair(name, value);
        }
        query.finish()
    }

    #[test]
    fn the_query_is_code_and_state_or_an_allowed_error_and_state() {
        let state = secret();
        let s = state.expose();
        let code = "c".repeat(43);
        assert!(matches!(
            read_query(&query(&[("code", &code), ("state", s)]), &state),
            Some(Callback::Code(_))
        ));
        assert!(matches!(
            read_query(&query(&[("state", s), ("code", &code)]), &state),
            Some(Callback::Code(_))
        ));
        assert!(matches!(
            read_query(&query(&[("error", "access_denied"), ("state", s)]), &state),
            Some(Callback::Declined)
        ));
        let other = secret();
        for bad in [
            query(&[("code", &code)]),
            query(&[("state", s)]),
            query(&[("error", "access_denied")]),
            query(&[("code", &code), ("state", other.expose())]),
            query(&[("code", &code), ("state", &s[..42])]),
            query(&[("code", &code), ("state", s), ("state", s)]),
            query(&[("code", &code), ("code", &code), ("state", s)]),
            query(&[("code", &code), ("error", "access_denied"), ("state", s)]),
            query(&[("code", &code), ("state", s), ("extra", "1")]),
            query(&[
                ("error", "access_denied"),
                ("state", s),
                ("error_description", "x"),
            ]),
            query(&[("error", "server_error"), ("state", s)]),
            query(&[("error", "invalid_request"), ("state", s)]),
            query(&[("error", "ACCESS_DENIED"), ("state", s)]),
            query(&[("code", "short"), ("state", s)]),
            query(&[("code", ""), ("state", s)]),
            format!("code={code}&state"),
            String::new(),
        ] {
            assert!(read_query(&bad, &state).is_none(), "{bad}");
        }
    }

    #[tokio::test]
    async fn only_the_one_callback_is_answered_and_then_nothing_is() {
        let state = secret();
        let stop = CancellationToken::new();
        let mut listener = listen(state.clone(), PageLanguage::English, &stop)
            .await
            .unwrap();
        let port = listener.port;
        let host = format!("127.0.0.1:{port}");
        let code = "k".repeat(43);
        let good = format!(
            "{CALLBACK_PATH}?{}",
            query(&[("code", &code), ("state", state.expose())])
        );

        for (target, host) in [
            (good.clone(), Some(format!("localhost:{port}"))),
            (good.clone(), Some("127.0.0.1".to_string())),
            (
                good.clone(),
                Some(format!("127.0.0.1:{}", port.wrapping_add(1))),
            ),
            (good.clone(), None),
            (
                good.replace(CALLBACK_PATH, "/auth/callback/"),
                Some(host.clone()),
            ),
            (
                good.replace(CALLBACK_PATH, "/auth/Callback"),
                Some(host.clone()),
            ),
            (good.replace(CALLBACK_PATH, "/"), Some(host.clone())),
            (format!("http://127.0.0.1:{port}{good}"), Some(host.clone())),
            (CALLBACK_PATH.to_string(), Some(host.clone())),
        ] {
            let answer = raw_get(port, &target, host.as_deref()).await.unwrap();
            assert_eq!(answer.status, 404, "{target} with {host:?}");
            assert_eq!(answer.header("cache-control"), Some("no-store"));
            assert_eq!(
                answer.header("content-security-policy"),
                Some(page::CONTENT_SECURITY_POLICY.as_str())
            );
        }
        let posted = crate::srn::test_support::raw_request(port, "POST", &good, Some(&host))
            .await
            .unwrap();
        assert_eq!(posted.status, 404);
        assert!(
            listener.callback.try_recv().is_err(),
            "nothing was taken yet"
        );

        let answer = raw_get(port, &good, Some(&host)).await.unwrap();
        assert_eq!(answer.status, 200);
        assert!(answer.body.contains("Return to Codeg"));
        assert_eq!(answer.header("cache-control"), Some("no-store"));
        // the policy the page was written for: its stylesheet's hash
        // (page.rs checks the hash against the stylesheet itself)
        assert_eq!(
            answer.header("content-security-policy"),
            Some(page::CONTENT_SECURITY_POLICY.as_str())
        );
        assert!(answer.body.contains("<style>"));
        assert_eq!(
            answer.body.contains("href=\"codeg://open\""),
            origin::is_release_build()
        );
        assert_eq!(answer.header("referrer-policy"), Some("no-referrer"));
        assert_eq!(answer.header("connection"), Some("close"));
        match listener.callback.await.unwrap() {
            Callback::Code(received) => assert_eq!(received.expose(), code),
            Callback::Declined => panic!("a code was sent"),
        }

        // closed: a second callback, even a right one, finds nothing
        assert!(wait_closed(port).await, "the listener is still accepting");
        assert!(raw_get(port, &good, Some(&host)).await.is_err());
        assert!(!stop.is_cancelled(), "closing the listener ends no flow");
    }

    #[tokio::test]
    async fn stopping_the_flow_closes_the_listener() {
        let stop = CancellationToken::new();
        let listener = listen(secret(), PageLanguage::English, &stop)
            .await
            .unwrap();
        let port = listener.port;
        assert!(raw_get(port, "/", Some(&format!("127.0.0.1:{port}")))
            .await
            .is_ok());
        stop.cancel();
        assert!(wait_closed(port).await);
    }
}
