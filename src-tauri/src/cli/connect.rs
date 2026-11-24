//! Finding the runtime to talk to, and proving it is the one we think.
//!
//! Command-line arguments first, then the runtime codeg pinned for this
//! terminal, then the user's global configuration:
//!
//! 1. `--url` (with `--token` / `--token-file`)
//! 2. `--data-dir` — scanned
//! 3. `CODEG_CLI_ENDPOINT_FILE` — the runtime that started this process
//! 4. `CODEG_URL` (with `CODEG_TOKEN`)
//! 5. `CODEG_DATA_DIR` — scanned
//! 6. the desktop's and the server's default data directories — scanned
//!
//! The first level that is given is the only one used: a failure there ends
//! the command ("nothing was sent"), it never falls through to another
//! runtime — a CLI in a codeg terminal that quietly reached a different codeg
//! would put its conversation in a database nobody is looking at. Only a
//! scanned directory skips over its individual bad files.

use std::path::{Path, PathBuf};
use std::time::Duration;

use reqwest::StatusCode;

use crate::cli_run::discovery::{self, DiscoveryRecord};
use crate::cli_run::hello;
use crate::cli_run::wire::{
    self, BuildKind, ErrorBody, HelloRequest, HelloResponse, RuntimeKind, Subtype,
};

use super::args::{GlobalArgs, RuntimeChoice};
use super::Failure;

/// How long a loopback request may take to connect, and a hello to answer.
const LOOPBACK_CONNECT: Duration = Duration::from_secs(3);
const HELLO_TIMEOUT: Duration = Duration::from_secs(10);

/// The process environment, as far as finding a runtime goes. Read once in
/// `main`; tests build their own.
#[derive(Debug, Clone, Default)]
pub struct Env {
    pub endpoint_file: Option<PathBuf>,
    pub url: Option<String>,
    pub token: Option<String>,
    pub data_dir: Option<PathBuf>,
    pub caller: Option<String>,
    /// The platform data directory (`dirs::data_dir`).
    pub platform_data_dir: Option<PathBuf>,
}

impl Env {
    pub fn from_process() -> Self {
        let var = |name: &str| std::env::var(name).ok().filter(|v| !v.is_empty());
        Self {
            endpoint_file: var(discovery::ENDPOINT_FILE_ENV).map(PathBuf::from),
            url: var("CODEG_URL"),
            token: var("CODEG_TOKEN"),
            data_dir: var("CODEG_DATA_DIR").map(PathBuf::from),
            caller: var(crate::cli_run::CLI_CALLER_ENV),
            platform_data_dir: dirs::data_dir(),
        }
    }
}

/// Which lookup level applies.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Level {
    Url {
        url: String,
        token: String,
        from_env: bool,
    },
    DataDirs {
        dirs: Vec<PathBuf>,
        label: &'static str,
    },
    EndpointFile(PathBuf),
}

impl Level {
    pub fn is_remote(&self) -> bool {
        matches!(self, Self::Url { .. })
    }

    pub fn describe(&self) -> String {
        match self {
            Self::Url { url, from_env, .. } => {
                let url = without_credentials(url);
                if *from_env {
                    format!("{url} (CODEG_URL)")
                } else {
                    url
                }
            }
            Self::DataDirs { dirs, label } => {
                let dirs: Vec<String> = dirs.iter().map(|d| d.display().to_string()).collect();
                format!("{label}: {}", dirs.join(", "))
            }
            Self::EndpointFile(path) => {
                format!("{} ({})", path.display(), discovery::ENDPOINT_FILE_ENV)
            }
        }
    }
}

pub fn level(global: &GlobalArgs, env: &Env) -> Result<Level, Failure> {
    if let Some(url) = &global.url {
        let token = match (&global.token, &global.token_file) {
            (Some(t), _) => t.clone(),
            (None, Some(file)) => std::fs::read_to_string(file)
                .map(|t| t.trim().to_string())
                .map_err(|e| {
                    Failure::usage(
                        "token_file_unreadable",
                        format!("cannot read --token-file {}: {e}", file.display()),
                    )
                })?,
            (None, None) => env.token.clone().ok_or_else(|| {
                Failure::usage(
                    "token_missing",
                    "--url needs a token: --token, --token-file or CODEG_TOKEN",
                )
            })?,
        };
        return Ok(Level::Url {
            url: trim_url(url),
            token,
            from_env: false,
        });
    }
    if let Some(dir) = &global.data_dir {
        return Ok(Level::DataDirs {
            dirs: vec![dir.clone()],
            label: "--data-dir",
        });
    }
    if let Some(file) = &env.endpoint_file {
        return Ok(Level::EndpointFile(file.clone()));
    }
    if let Some(url) = &env.url {
        let token = env.token.clone().ok_or_else(|| {
            Failure::usage("token_missing", "CODEG_URL is set but CODEG_TOKEN is not")
        })?;
        return Ok(Level::Url {
            url: trim_url(url),
            token,
            from_env: true,
        });
    }
    if let Some(dir) = &env.data_dir {
        return Ok(Level::DataDirs {
            dirs: vec![dir.clone()],
            label: "CODEG_DATA_DIR",
        });
    }
    let dirs = match &env.platform_data_dir {
        // The desktop's (`app.codeg`, its bundle identifier) and the server's.
        Some(base) => vec![base.join("app.codeg"), base.join("codeg")],
        None => Vec::new(),
    };
    Ok(Level::DataDirs {
        dirs,
        label: "the default data directories",
    })
}

fn trim_url(url: &str) -> String {
    url.trim().trim_end_matches('/').to_string()
}

/// What one candidate runtime turned out to be.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CandidateState {
    Ready,
    /// The file is there, its process is gone.
    Stale,
    /// Its process is alive, but nothing answered.
    Unreachable,
    /// Something answered, but not with the proof only it could give.
    Unverified,
    /// The connection was refused by the OS: a sandbox, most likely.
    AccessDenied,
    /// It answered, but speaks another API version or lacks a capability.
    Incompatible,
}

impl CandidateState {
    /// The state's name, as `status --json` writes it and docs/cli.md lists
    /// it.
    pub fn name(self) -> &'static str {
        match self {
            Self::Ready => "ready",
            Self::Stale => "stale",
            Self::Unreachable => "unreachable",
            Self::Unverified => "unverified",
            Self::AccessDenied => "access_denied",
            Self::Incompatible => "incompatible",
        }
    }
}

#[derive(Debug, Clone)]
pub struct Candidate {
    /// The discovery file, or the URL.
    pub source: String,
    pub record: Option<DiscoveryRecord>,
    pub state: CandidateState,
    pub detail: Option<String>,
    pub hello: Option<HelloResponse>,
    pub url: String,
    pub token: String,
}

/// A runtime that passed the challenge.
#[derive(Debug, Clone)]
pub struct Connection {
    pub client: reqwest::Client,
    pub url: String,
    pub token: String,
    pub hello: HelloResponse,
    pub remote: bool,
    pub source: String,
}

impl Connection {
    pub fn has(&self, capability: &str) -> bool {
        self.hello.capabilities.iter().any(|c| c == capability)
    }

    /// POST `body` to `/api/<route>` with the token; a structured error body
    /// comes back as the failure it describes.
    pub async fn post<B: serde::Serialize, R: serde::de::DeserializeOwned>(
        &self,
        route: &str,
        body: &B,
        timeout: Duration,
    ) -> Result<R, Failure> {
        let resp = self
            .client
            .post(format!("{}/api/{route}", self.url))
            .bearer_auth(&self.token)
            .timeout(timeout)
            .json(body)
            .send()
            .await
            .map_err(|e| transport_failure(&e, &self.source))?;
        let status = resp.status();
        if status.is_success() {
            return resp.json::<R>().await.map_err(|e| {
                Failure::new(
                    Subtype::ErrorRuntimeIncompatible,
                    "bad_response",
                    format!(
                        "{} answered {route} with something unexpected: {e}",
                        self.source
                    ),
                )
            });
        }
        let text = resp.text().await.unwrap_or_default();
        if let Ok(body) = serde_json::from_str::<ErrorBody>(&text) {
            return Err(Failure::from_body(body));
        }
        Err(if status == StatusCode::UNAUTHORIZED {
            Failure::new(
                Subtype::ErrorRuntimeUnavailable,
                "unauthorized",
                format!("{} refused the token", self.source),
            )
        } else {
            Failure::new(
                Subtype::ErrorDuringExecution,
                "http_error",
                format!(
                    "{} answered {route} with HTTP {status}: {}",
                    self.source,
                    text.trim()
                ),
            )
        })
    }
}

/// Every candidate the applicable level offers, each examined.
pub async fn examine(level: &Level) -> Vec<Candidate> {
    examine_by(level, None).await
}

/// Like [`examine`], with every probe bounded by `deadline`: one that has not
/// answered by then is unreachable, and the ones that did still count.
pub async fn examine_by(level: &Level, deadline: Option<tokio::time::Instant>) -> Vec<Candidate> {
    match level {
        Level::Url { url, token, .. } => {
            let source = without_credentials(url);
            let probing = probe(url.clone(), token.clone(), None, source.clone(), true);
            vec![bounded(deadline, source, None, probing).await]
        }
        Level::EndpointFile(path) => {
            vec![
                bounded(
                    deadline,
                    path.display().to_string(),
                    None,
                    examine_file(path),
                )
                .await,
            ]
        }
        Level::DataDirs { dirs, .. } => {
            let mut out = Vec::new();
            for dir in dirs {
                for (path, record) in discovery::read_records(&discovery::dir(dir)) {
                    out.push(match record {
                        Ok(record) => {
                            let kept = Some(record.clone());
                            let probing = examine_record(&path, record);
                            bounded(deadline, path.display().to_string(), kept, probing).await
                        }
                        Err(e) => Candidate {
                            source: path.display().to_string(),
                            record: None,
                            state: CandidateState::Unverified,
                            detail: Some(format!("unreadable: {e}")),
                            hello: None,
                            url: String::new(),
                            token: String::new(),
                        },
                    });
                }
            }
            out
        }
    }
}

async fn bounded(
    deadline: Option<tokio::time::Instant>,
    source: String,
    record: Option<DiscoveryRecord>,
    probing: impl std::future::Future<Output = Candidate>,
) -> Candidate {
    let Some(deadline) = deadline else {
        return probing.await;
    };
    tokio::time::timeout_at(deadline, probing)
        .await
        .unwrap_or_else(|_| Candidate {
            source,
            record,
            state: CandidateState::Unreachable,
            detail: Some("no answer in time".into()),
            hello: None,
            url: String::new(),
            token: String::new(),
        })
}

async fn examine_file(path: &Path) -> Candidate {
    match discovery::read_record(path) {
        Ok(record) => examine_record(path, record).await,
        Err(e) => Candidate {
            source: path.display().to_string(),
            record: None,
            state: CandidateState::Stale,
            detail: Some(if path.exists() {
                format!("unreadable: {e}")
            } else {
                "no such file: the codeg that started this terminal has exited, or has \
                 command-line access off"
                    .into()
            }),
            hello: None,
            url: String::new(),
            token: String::new(),
        },
    }
}

async fn examine_record(path: &Path, record: DiscoveryRecord) -> Candidate {
    let source = path.display().to_string();
    if discovery::pid_is_dead(record.pid) {
        return Candidate {
            source,
            state: CandidateState::Stale,
            detail: Some(format!("process {} has exited", record.pid)),
            hello: None,
            url: record.url.clone(),
            token: record.token.clone(),
            record: Some(record),
        };
    }
    let port = record
        .url
        .rsplit(':')
        .next()
        .and_then(|p| p.parse::<u16>().ok());
    let mut candidate = probe(
        record.url.clone(),
        record.token.clone(),
        port,
        source,
        false,
    )
    .await;
    candidate.record = Some(record);
    candidate
}

/// The challenge: a nonce out, WITHOUT the token; the proof back, checked
/// against the token we hold and the port we connected to.
async fn probe(
    url: String,
    token: String,
    port: Option<u16>,
    source: String,
    remote: bool,
) -> Candidate {
    let mut candidate = Candidate {
        source: source.clone(),
        record: None,
        state: CandidateState::Unreachable,
        detail: None,
        hello: None,
        url: url.clone(),
        token: token.clone(),
    };
    let client = client_for(&url);
    let nonce = hello::random_hex(16);
    let resp = client
        .post(format!("{url}/api/cli_hello"))
        .timeout(HELLO_TIMEOUT)
        .json(&HelloRequest {
            nonce: nonce.clone(),
            client_version: env!("CARGO_PKG_VERSION").to_string(),
            api_version: wire::API_VERSION,
        })
        .send()
        .await;
    let resp = match resp {
        Ok(resp) => resp,
        Err(e) => {
            let failure = transport_failure(&e, &source);
            candidate.state = if failure.subtype == Subtype::ErrorRuntimeAccessDenied {
                CandidateState::AccessDenied
            } else {
                CandidateState::Unreachable
            };
            candidate.detail = Some(failure.message);
            return candidate;
        }
    };
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    if status == StatusCode::CONFLICT {
        candidate.state = CandidateState::Incompatible;
        candidate.detail = Some(
            serde_json::from_str::<ErrorBody>(&text)
                .map(|b| b.error.message)
                .unwrap_or_else(|_| text.trim().to_string()),
        );
        return candidate;
    }
    let Ok(answer) = serde_json::from_str::<HelloResponse>(&text) else {
        candidate.state = CandidateState::Unverified;
        candidate.detail = Some(format!("not a codeg answer (HTTP {status})"));
        return candidate;
    };
    if !hello::verify(&token, &nonce, port, &answer.proof) {
        candidate.state = CandidateState::Unverified;
        candidate.detail = Some(if remote {
            "the answer does not prove the token: wrong token, or not that codeg".into()
        } else {
            "the answer does not prove this file's token: something else holds its port".into()
        });
        return candidate;
    }
    if answer.api_version != wire::API_VERSION {
        candidate.state = CandidateState::Incompatible;
        candidate.detail = Some(format!(
            "speaks CLI API {} (this codeg-cli speaks {})",
            answer.api_version,
            wire::API_VERSION
        ));
        candidate.hello = Some(answer);
        return candidate;
    }
    candidate.state = CandidateState::Ready;
    candidate.hello = Some(answer);
    candidate
}

/// A request to this machine never goes through a proxy from the environment,
/// and gives up connecting quickly — whether the URL came from a discovery
/// file or from `--url http://127.0.0.1:…`: a proxy would see the token. Any
/// other URL honours the user's proxy settings.
pub fn client_for(url: &str) -> reqwest::Client {
    let builder =
        reqwest::Client::builder().user_agent(concat!("codeg-cli/", env!("CARGO_PKG_VERSION")));
    let builder = if is_loopback_url(url) {
        builder.no_proxy().connect_timeout(LOOPBACK_CONNECT)
    } else {
        builder
    };
    builder.build().expect("an HTTP client")
}

fn is_loopback_url(url: &str) -> bool {
    let Ok(parsed) = reqwest::Url::parse(url) else {
        return false;
    };
    let host = parsed.host_str().unwrap_or_default();
    let host = host.trim_start_matches('[').trim_end_matches(']');
    host.eq_ignore_ascii_case("localhost")
        || host
            .parse::<std::net::IpAddr>()
            .is_ok_and(|ip| ip.is_loopback())
}

/// `url` as shown to people: without a user name or password in it — also
/// when it is not a URL reqwest can parse.
pub fn without_credentials(url: &str) -> String {
    match reqwest::Url::parse(url) {
        // Credentials the parser found go, whatever the scheme.
        Ok(mut parsed) if !parsed.username().is_empty() || parsed.password().is_some() => {
            let _ = parsed.set_username("");
            let _ = parsed.set_password(None);
            parsed.to_string().trim_end_matches('/').to_string()
        }
        Ok(parsed) if matches!(parsed.scheme(), "http" | "https") => url.to_string(),
        // Not an http(s) URL (`user:secret@host` even parses, with `user` for
        // a scheme): the authority is whatever follows the first `//` — or the
        // whole start, with no `//` at all — up to a path, query or fragment.
        _ => {
            let start = url.find("//").map_or(0, |i| i + 2);
            let (head, rest) = url.split_at(start);
            let end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
            let (authority, tail) = rest.split_at(end);
            match authority.rfind('@') {
                Some(at) => format!("{head}{}{tail}", &authority[at + 1..]),
                None => url.to_string(),
            }
        }
    }
}

/// Pick the runtime to use from a level's candidates.
pub fn choose<'a>(
    level: &Level,
    candidates: &'a [Candidate],
    runtime: Option<RuntimeChoice>,
) -> Result<&'a Candidate, Failure> {
    let ready: Vec<&Candidate> = candidates
        .iter()
        .filter(|c| c.state == CandidateState::Ready)
        .filter(|c| match (runtime, c.hello.as_ref().map(|h| h.runtime)) {
            (Some(RuntimeChoice::Desktop), Some(kind)) => kind == RuntimeKind::Desktop,
            (Some(RuntimeChoice::Server), Some(kind)) => kind == RuntimeKind::Server,
            _ => true,
        })
        .collect();
    let rank = |c: &Candidate| {
        let hello = c.hello.as_ref();
        let kind = match hello.map(|h| (h.runtime, h.build)) {
            Some((RuntimeKind::Desktop, BuildKind::Release)) => 0,
            Some((RuntimeKind::Desktop, BuildKind::Debug)) => 1,
            _ => 2,
        };
        // Newest first within a kind.
        let started = c
            .record
            .as_ref()
            .map(|r| r.started_at.clone())
            .unwrap_or_default();
        (kind, std::cmp::Reverse(started))
    };
    if let Some(best) = ready.iter().min_by_key(|c| rank(c)) {
        return Ok(best);
    }
    Err(no_runtime(level, candidates))
}

/// Why nothing could be used, with what to do about it.
fn no_runtime(level: &Level, candidates: &[Candidate]) -> Failure {
    if let Some(denied) = candidates
        .iter()
        .find(|c| c.state == CandidateState::AccessDenied)
    {
        return access_denied(&denied.source);
    }
    if let Some(old) = candidates
        .iter()
        .find(|c| c.state == CandidateState::Incompatible)
    {
        return Failure::new(
            Subtype::ErrorRuntimeIncompatible,
            "runtime_incompatible",
            format!(
                "{} cannot be used: {}. Nothing was sent.",
                old.source,
                old.detail.as_deref().unwrap_or("incompatible")
            ),
        )
        .with_next_steps(["use a codeg-cli from the same release as that codeg".to_string()]);
    }
    let pinned = matches!(level, Level::EndpointFile(_) | Level::Url { .. });
    let mut message = if pinned {
        format!("{} is not available. Nothing was sent.", level.describe())
    } else {
        format!(
            "no codeg is running for {}. Nothing was sent.",
            level.describe()
        )
    };
    if let Some(detail) = candidates.iter().find_map(|c| c.detail.as_deref()) {
        message.push_str(&format!(" ({detail})"));
    }
    let next = if level.is_remote() {
        vec!["check the URL and the token, and that the server is up".to_string()]
    } else {
        vec![
            "codeg-cli open   (starts the desktop app)".to_string(),
            "or start codeg-server, or point --url at one".to_string(),
        ]
    };
    Failure::new(
        Subtype::ErrorRuntimeUnavailable,
        "runtime_unavailable",
        message,
    )
    .with_next_steps(next)
}

/// Find the runtime and prove it, ready for `post`.
pub async fn connect(
    global: &GlobalArgs,
    env: &Env,
) -> Result<(Connection, Vec<Candidate>), Failure> {
    let level = level(global, env)?;
    let candidates = examine(&level).await;
    let chosen = choose(&level, &candidates, global.runtime)?;
    let connection = Connection {
        client: client_for(&chosen.url),
        url: chosen.url.clone(),
        token: chosen.token.clone(),
        hello: chosen.hello.clone().expect("a ready candidate answered"),
        remote: level.is_remote(),
        source: chosen.source.clone(),
    };
    Ok((connection, candidates))
}

/// A transport error, sorted: refused by the OS (a sandbox) is not the same
/// as nothing listening, and must not send the user off to restart codeg.
pub fn transport_failure(error: &reqwest::Error, source: &str) -> Failure {
    let mut cause: Option<&(dyn std::error::Error + 'static)> = Some(error);
    while let Some(err) = cause {
        if let Some(io) = err.downcast_ref::<std::io::Error>() {
            if io.kind() == std::io::ErrorKind::PermissionDenied {
                return Failure::new(
                    Subtype::ErrorRuntimeAccessDenied,
                    "runtime_access_denied",
                    format!("the operating system refused the connection to {source}: {io}"),
                );
            }
        }
        cause = err.source();
    }
    let what = if error.is_timeout() {
        "timed out"
    } else if error.is_connect() {
        "nothing answered"
    } else {
        "the request failed"
    };
    // The innermost cause, not the error itself: reqwest's own text names
    // the URL, which may carry credentials.
    let mut root: &(dyn std::error::Error + 'static) = error;
    while let Some(next) = root.source() {
        root = next;
    }
    let cause = if std::ptr::addr_eq(root, error as &(dyn std::error::Error + 'static)) {
        String::new()
    } else {
        format!(" ({root})")
    };
    Failure::new(
        Subtype::ErrorRuntimeUnavailable,
        "runtime_unavailable",
        format!("{source}: {what}{cause}"),
    )
}

/// The OS refused the connection to `source`: a sandbox, most likely.
pub fn access_denied(source: &str) -> Failure {
    Failure::new(
        Subtype::ErrorRuntimeAccessDenied,
        "runtime_access_denied",
        format!(
            "the connection to {source} was refused by the operating system — most likely this \
             command runs in a sandbox without local network access. Nothing was sent."
        ),
    )
    .with_next_steps([
        "allow local network access for this command, or run it outside the sandbox".to_string(),
    ])
}

#[cfg(test)]
mod tests {
    use super::*;

    fn global() -> GlobalArgs {
        GlobalArgs::default()
    }

    #[test]
    fn the_command_line_comes_first_then_the_pinned_runtime_then_the_environment() {
        let env = Env {
            endpoint_file: Some("/pinned/cli/endpoint-1.json".into()),
            url: Some("https://ci.example".into()),
            token: Some("t".into()),
            data_dir: Some("/env-data".into()),
            caller: None,
            platform_data_dir: Some("/platform".into()),
        };
        // --data-dir beats the pinned file.
        let g = GlobalArgs {
            data_dir: Some("/explicit".into()),
            ..global()
        };
        assert!(matches!(
            level(&g, &env).unwrap(),
            Level::DataDirs {
                label: "--data-dir",
                ..
            }
        ));
        // The pinned file beats CODEG_URL: a terminal of this desktop talks to
        // this desktop, whatever the shell profile exports.
        assert_eq!(
            level(&global(), &env).unwrap(),
            Level::EndpointFile("/pinned/cli/endpoint-1.json".into())
        );
        // --url beats everything.
        let g = GlobalArgs {
            url: Some("https://remote/".into()),
            token: Some("x".into()),
            ..global()
        };
        assert_eq!(
            level(&g, &env).unwrap(),
            Level::Url {
                url: "https://remote".into(),
                token: "x".into(),
                from_env: false
            }
        );
        let env = Env {
            endpoint_file: None,
            ..env
        };
        assert!(matches!(
            level(&global(), &env).unwrap(),
            Level::Url { from_env: true, .. }
        ));
        let env = Env { url: None, ..env };
        assert_eq!(
            level(&global(), &env).unwrap(),
            Level::DataDirs {
                dirs: vec!["/env-data".into()],
                label: "CODEG_DATA_DIR"
            }
        );
        let env = Env {
            data_dir: None,
            ..env
        };
        assert_eq!(
            level(&global(), &env).unwrap(),
            Level::DataDirs {
                dirs: vec!["/platform/app.codeg".into(), "/platform/codeg".into()],
                label: "the default data directories"
            }
        );
    }

    #[test]
    fn a_loopback_url_is_recognized_however_it_is_written() {
        for url in [
            "http://127.0.0.1:3080",
            "http://127.1.2.3:1",
            "http://localhost:3080",
            "http://LOCALHOST",
            "http://[::1]:3080",
        ] {
            assert!(is_loopback_url(url), "{url}");
        }
        for url in ["https://ci.example:3080", "http://10.0.0.2", "not a url"] {
            assert!(!is_loopback_url(url), "{url}");
        }
    }

    #[test]
    fn credentials_in_a_url_are_never_shown() {
        assert_eq!(
            without_credentials("https://user:secret@host:3080"),
            "https://host:3080"
        );
        assert_eq!(
            without_credentials("https://host:3080"),
            "https://host:3080"
        );
        // Not even a parseable URL: the credentials go all the same.
        assert_eq!(
            without_credentials("http://user:secret@host:badport/x"),
            "http://host:badport/x"
        );
        assert_eq!(without_credentials("//user:secret@host"), "//host");
        assert!(!without_credentials("ftp:/user:secret@host").contains("secret"));
        assert_eq!(without_credentials("user:secret@host:1"), "host:1");
        let level = Level::Url {
            url: "https://user:secret@host".into(),
            token: "t".into(),
            from_env: true,
        };
        assert!(!level.describe().contains("secret"), "{}", level.describe());
    }

    #[test]
    fn a_url_needs_a_token() {
        let g = GlobalArgs {
            url: Some("https://h".into()),
            ..global()
        };
        let err = level(&g, &Env::default()).unwrap_err();
        assert_eq!(err.subtype, Subtype::ErrorUsage);
        let env = Env {
            token: Some("from-env".into()),
            ..Env::default()
        };
        assert!(
            matches!(level(&g, &env).unwrap(), Level::Url { token, .. } if token == "from-env")
        );
    }

    fn ready(runtime: RuntimeKind, build: BuildKind, started_at: &str) -> Candidate {
        Candidate {
            source: format!("{runtime:?}-{build:?}-{started_at}"),
            record: Some(DiscoveryRecord {
                url: "http://127.0.0.1:1".into(),
                token: "t".into(),
                pid: 1,
                runtime,
                build,
                version: "v".into(),
                api_version: 1,
                data_dir: "/d".into(),
                started_at: started_at.into(),
            }),
            state: CandidateState::Ready,
            detail: None,
            hello: Some(HelloResponse {
                proof: String::new(),
                runtime,
                build,
                version: "v".into(),
                api_version: 1,
                capabilities: vec![],
            }),
            url: "http://127.0.0.1:1".into(),
            token: "t".into(),
        }
    }

    #[test]
    fn the_release_desktop_wins_unless_asked_otherwise() {
        let level = Level::DataDirs {
            dirs: vec![],
            label: "x",
        };
        let all = vec![
            ready(RuntimeKind::Server, BuildKind::Release, "3"),
            ready(RuntimeKind::Desktop, BuildKind::Debug, "2"),
            ready(RuntimeKind::Desktop, BuildKind::Release, "1"),
        ];
        assert_eq!(choose(&level, &all, None).unwrap().source, all[2].source);
        assert_eq!(
            choose(&level, &all, Some(RuntimeChoice::Server))
                .unwrap()
                .source,
            all[0].source
        );
        let two_servers = vec![
            ready(RuntimeKind::Server, BuildKind::Release, "2026-01-01"),
            ready(RuntimeKind::Server, BuildKind::Release, "2026-02-01"),
        ];
        assert_eq!(
            choose(&level, &two_servers, None).unwrap().source,
            two_servers[1].source,
            "the newer of two"
        );
    }

    #[test]
    fn a_refused_connection_is_told_apart_from_nothing_running() {
        let level = Level::DataDirs {
            dirs: vec![],
            label: "x",
        };
        let mut denied = ready(RuntimeKind::Desktop, BuildKind::Release, "1");
        denied.state = CandidateState::AccessDenied;
        let err = choose(&level, &[denied], None).unwrap_err();
        assert_eq!(err.subtype, Subtype::ErrorRuntimeAccessDenied);
        assert!(
            !err.next_steps.iter().any(|s| s.contains("open")),
            "{:?}",
            err.next_steps
        );

        let err = choose(&level, &[], None).unwrap_err();
        assert_eq!(err.subtype, Subtype::ErrorRuntimeUnavailable);
        assert!(err.message.contains("Nothing was sent"));
        assert!(err.next_steps.iter().any(|s| s.contains("codeg-cli open")));
    }

    /// The three ways an OS says "not allowed" all read as access denied:
    /// Unix EACCES / EPERM and Winsock's WSAEACCES (10013).
    #[test]
    fn every_permission_errno_maps_to_permission_denied() {
        #[cfg(unix)]
        for errno in [libc::EACCES, libc::EPERM] {
            assert_eq!(
                std::io::Error::from_raw_os_error(errno).kind(),
                std::io::ErrorKind::PermissionDenied,
                "{errno}"
            );
        }
        #[cfg(windows)]
        assert_eq!(
            std::io::Error::from_raw_os_error(10013).kind(),
            std::io::ErrorKind::PermissionDenied
        );
    }

    /// A probe that never answers is unreachable once the deadline comes —
    /// alone, so the candidates examined before it keep what they proved.
    #[tokio::test]
    async fn a_probe_that_never_answers_is_bounded_on_its_own() {
        let deadline = tokio::time::Instant::now() + Duration::from_millis(50);
        let stalled = bounded(
            Some(deadline),
            "file-2".into(),
            None,
            std::future::pending::<Candidate>(),
        )
        .await;
        assert_eq!(stalled.state, CandidateState::Unreachable);
        assert_eq!(stalled.source, "file-2");

        let ready = ready(RuntimeKind::Desktop, BuildKind::Release, "1");
        let kept = bounded(Some(deadline), "x".into(), None, async { ready.clone() }).await;
        assert_eq!(kept.state, CandidateState::Ready);
    }

    #[tokio::test]
    async fn a_pinned_runtime_that_is_gone_is_reported_not_replaced() {
        let dir = tempfile::tempdir().unwrap();
        let level = Level::EndpointFile(dir.path().join("cli").join("endpoint-1.json"));
        let candidates = examine(&level).await;
        assert_eq!(candidates.len(), 1);
        assert_eq!(candidates[0].state, CandidateState::Stale);
        let err = choose(&level, &candidates, None).unwrap_err();
        assert_eq!(err.subtype, Subtype::ErrorRuntimeUnavailable);
        assert!(err.message.contains("Nothing was sent"), "{}", err.message);
    }

    /// `status` shows a person the very names its JSON gives a script.
    #[test]
    fn a_state_is_named_as_its_json_names_it() {
        for state in [
            CandidateState::Ready,
            CandidateState::Stale,
            CandidateState::Unreachable,
            CandidateState::Unverified,
            CandidateState::AccessDenied,
            CandidateState::Incompatible,
        ] {
            assert_eq!(
                serde_json::to_value(state).unwrap(),
                serde_json::json!(state.name())
            );
        }
    }
}
