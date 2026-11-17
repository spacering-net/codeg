//! W1: how an operator turns SRN sign-in on for a Codeg Web instance, and
//! the checks those settings pass before it is on.
//!
//! Three variables, read once when the service is set up:
//!
//! - [`PUBLIC_URL_ENV`] — the address browsers use for this instance: an
//!   exclusive HTTPS host name on the root path and the standard port, the
//!   rule SpaceRing's registration script (`scripts/register-codeg-client.mjs`)
//!   applies. It is what a browser's `Origin` must equal, and the only source
//!   of the redirect address, `<public URL>/auth/srn/callback` — never `Host`,
//!   `X-Forwarded-*` or a request parameter.
//! - [`CLIENT_ID_ENV`] — the instance's own Web client,
//!   `codeg-web-<16–128 of A–Z a–z 0–9 _ ->`. Never the desktop's client.
//! - [`CLIENT_SECRET_FILE_ENV`] — the restricted file the script wrote,
//!   holding the client secret (43–128 of the same characters). The secret is
//!   read from the file, never from a variable or an argument.
//!
//! A missing or invalid setting turns SRN sign-in off for this instance and
//! says why in the log, once, without the secret. It never touches instance
//! access (`CODEG_TOKEN`, proxy-jwt): that stays exactly as it was.
//!
//! None of the three reaches a program Codeg starts: the spawn layer drops
//! them ([`CHILD_HIDDEN_ENV`], `appimage_env::restore`), so an agent, a
//! terminal or an MCP server never sees them.

use std::io::Read;
use std::path::{Path, PathBuf};

use url::{Host, Url};

use crate::harness::origin::Origin;

pub const PUBLIC_URL_ENV: &str = "CODEG_PUBLIC_URL";
pub const CLIENT_ID_ENV: &str = "CODEG_SRN_CLIENT_ID";
pub const CLIENT_SECRET_FILE_ENV: &str = "CODEG_SRN_CLIENT_SECRET_FILE";

/// What no program Codeg starts inherits.
pub const CHILD_HIDDEN_ENV: &[&str] = &[PUBLIC_URL_ENV, CLIENT_ID_ENV, CLIENT_SECRET_FILE_ENV];

/// Where SpaceRing sends the browser back: the registered redirect is the
/// public URL plus this path, exactly.
pub const CALLBACK_PATH: &str = "/auth/srn/callback";

/// The secret file is a line of at most 128 characters; anything much larger
/// is not one, and is not read to its end.
const MAX_SECRET_FILE_BYTES: u64 = 4096;

const WEB_CLIENT_PREFIX: &str = "codeg-web-";

/// The client secret. Prints as `[redacted]`.
#[derive(Clone, PartialEq, Eq)]
pub struct ClientSecret(String);

impl ClientSecret {
    pub fn expose(&self) -> &str {
        &self.0
    }

    #[cfg(test)]
    pub(crate) fn from_test_value(value: &str) -> Self {
        Self(value.to_string())
    }
}

impl std::fmt::Debug for ClientSecret {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("ClientSecret([redacted])")
    }
}

/// SRN sign-in, on.
#[derive(Debug, Clone)]
pub struct WebConfig {
    /// `https://<host>`: what a browser's `Origin` must be exactly.
    pub public_origin: String,
    /// `<public_origin>/auth/srn/callback`, as registered.
    pub redirect_uri: String,
    pub client_id: String,
    pub client_secret: ClientSecret,
    /// The SpaceRing this build talks to (`harness::origin`): always
    /// `https://spacering.net` in a release build.
    pub srn_origin: Origin,
}

/// Why SRN sign-in is off.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Disabled {
    /// None of the three settings is there: the operator has not asked for it.
    NotConfigured,
    /// Some are, these are not.
    Missing(Vec<&'static str>),
    /// [`PUBLIC_URL_ENV`] is not an exclusive HTTPS host on the root path.
    PublicUrl(&'static str),
    /// [`CLIENT_ID_ENV`] is not a Web client's ID.
    ClientId,
    /// The secret file could not be read. The text is the system's.
    SecretFile(String),
    /// The secret file does not hold a secret.
    Secret,
}

impl std::fmt::Display for Disabled {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotConfigured => write!(
                f,
                "not configured ({PUBLIC_URL_ENV}, {CLIENT_ID_ENV}, {CLIENT_SECRET_FILE_ENV})"
            ),
            Self::Missing(names) => write!(f, "{} not set", names.join(", ")),
            Self::PublicUrl(reason) => write!(
                f,
                "{PUBLIC_URL_ENV} is not usable: {reason} (an exclusive https:// host name on \
                 the root path and the standard port is required)"
            ),
            Self::ClientId => write!(
                f,
                "{CLIENT_ID_ENV} is not a Web client ID ({WEB_CLIENT_PREFIX}<16-128 letters, \
                 digits, _ or ->)"
            ),
            Self::SecretFile(reason) => write!(
                f,
                "the file {CLIENT_SECRET_FILE_ENV} names could not be read: {reason}"
            ),
            Self::Secret => write!(
                f,
                "the file {CLIENT_SECRET_FILE_ENV} names does not hold a client secret \
                 (43-128 letters, digits, _ or -)"
            ),
        }
    }
}

/// The settings as read: on, or off and why.
#[derive(Debug, Clone)]
pub enum Settings {
    Enabled(WebConfig),
    Disabled(Disabled),
}

impl Settings {
    /// This process's, from its environment.
    pub fn from_env() -> Self {
        Self::read(
            |name| std::env::var(name).ok(),
            crate::harness::origin::current(),
        )
    }

    /// From `var` (a variable's value, or none), for SpaceRing at
    /// `srn_origin`.
    pub fn read(var: impl Fn(&str) -> Option<String>, srn_origin: Origin) -> Self {
        let value = |name: &str| var(name).filter(|value| !value.trim().is_empty());
        let public_url = value(PUBLIC_URL_ENV);
        let client_id = value(CLIENT_ID_ENV);
        let secret_file = value(CLIENT_SECRET_FILE_ENV);
        let missing: Vec<&'static str> = [
            (PUBLIC_URL_ENV, public_url.is_none()),
            (CLIENT_ID_ENV, client_id.is_none()),
            (CLIENT_SECRET_FILE_ENV, secret_file.is_none()),
        ]
        .into_iter()
        .filter_map(|(name, missing)| missing.then_some(name))
        .collect();
        let (Some(public_url), Some(client_id), Some(secret_file)) =
            (public_url, client_id, secret_file)
        else {
            return Self::Disabled(if missing.len() == 3 {
                Disabled::NotConfigured
            } else {
                Disabled::Missing(missing)
            });
        };
        let public_origin = match public_origin(&public_url) {
            Ok(origin) => origin,
            Err(reason) => return Self::Disabled(Disabled::PublicUrl(reason)),
        };
        let client_id = client_id.trim();
        if !is_web_client_id(client_id) {
            return Self::Disabled(Disabled::ClientId);
        }
        let client_secret = match read_secret_file(Path::new(secret_file.trim())) {
            Ok(secret) => secret,
            Err(disabled) => return Self::Disabled(disabled),
        };
        Self::Enabled(WebConfig {
            redirect_uri: format!("{public_origin}{CALLBACK_PATH}"),
            public_origin,
            client_id: client_id.to_string(),
            client_secret,
            srn_origin,
        })
    }

    /// Says in the log, once, whether SRN sign-in is on and why not.
    /// Never the secret.
    pub fn log(&self, secret_file: Option<&Path>) {
        match self {
            Self::Enabled(config) => {
                tracing::info!(
                    "[srn-web] SRN sign-in is on for {} (client {}, SpaceRing {})",
                    config.public_origin,
                    config.client_id,
                    config.srn_origin
                );
                if let Some(path) = secret_file {
                    warn_if_shared(path);
                }
            }
            Self::Disabled(Disabled::NotConfigured) => {
                tracing::info!("[srn-web] SRN sign-in is off: {}", Disabled::NotConfigured);
            }
            Self::Disabled(reason) => {
                tracing::warn!(
                    "[srn-web] SRN sign-in is off: {reason}. Instance access is not affected."
                );
            }
        }
    }

    pub fn is_enabled(&self) -> bool {
        matches!(self, Self::Enabled(_))
    }
}

/// The secret file this process's environment names, for the log's warning
/// about its mode.
pub fn secret_file_from_env() -> Option<PathBuf> {
    std::env::var_os(CLIENT_SECRET_FILE_ENV)
        .filter(|value| !value.is_empty())
        .map(|value| PathBuf::from(value.to_string_lossy().trim()))
}

/// `https://<host>` from the public URL, or why it is not one: HTTPS, a host
/// name with a dot (not an IP address), no credentials, the standard port,
/// the root path, no query or fragment — `register-codeg-client.mjs`'s rule.
/// The host comes out as the URL parser writes it (lowercase, IDNA), which is
/// how a browser writes it in `Origin`.
pub fn public_origin(raw: &str) -> Result<String, &'static str> {
    let url = Url::parse(raw.trim()).map_err(|_| "it is not a URL")?;
    if url.scheme() != "https" {
        return Err("it is not https");
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("it carries credentials");
    }
    if url.port().is_some() {
        return Err("it names a port other than 443");
    }
    if url.path() != "/" {
        return Err("it has a path");
    }
    if url.query().is_some() || url.fragment().is_some() {
        return Err("it has a query or a fragment");
    }
    match url.host() {
        Some(Host::Domain(name)) if name.contains('.') => Ok(format!("https://{name}")),
        Some(Host::Domain(_)) => Err("its host is not a full host name"),
        Some(Host::Ipv4(_) | Host::Ipv6(_)) => Err("its host is an IP address"),
        None => Err("it names no host"),
    }
}

/// `codeg-web-<16–128 of A–Z a–z 0–9 _ ->`: SpaceRing's `WEB_ID`.
pub fn is_web_client_id(value: &str) -> bool {
    value
        .strip_prefix(WEB_CLIENT_PREFIX)
        .is_some_and(|rest| (16..=128).contains(&rest.len()) && is_url_safe(rest))
}

fn is_url_safe(value: &str) -> bool {
    value
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}

/// The secret, from its file: one line, 43–128 URL-safe characters (what
/// SpaceRing's `opaque(secret, 43, 128)` accepts), white space around it
/// ignored. Nothing of the file's content goes into an error.
fn read_secret_file(path: &Path) -> Result<ClientSecret, Disabled> {
    let file =
        std::fs::File::open(path).map_err(|error| Disabled::SecretFile(io_reason(&error)))?;
    let mut bytes = Vec::new();
    file.take(MAX_SECRET_FILE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| Disabled::SecretFile(io_reason(&error)))?;
    if bytes.len() as u64 > MAX_SECRET_FILE_BYTES {
        return Err(Disabled::Secret);
    }
    let text = std::str::from_utf8(&bytes).map_err(|_| Disabled::Secret)?;
    let secret = text.trim();
    if !(43..=128).contains(&secret.len()) || !is_url_safe(secret) {
        return Err(Disabled::Secret);
    }
    Ok(ClientSecret(secret.to_string()))
}

/// The kind of an I/O failure, without the path or anything else.
fn io_reason(error: &std::io::Error) -> String {
    match error.kind() {
        std::io::ErrorKind::NotFound => "it does not exist".to_string(),
        std::io::ErrorKind::PermissionDenied => "permission denied".to_string(),
        kind => kind.to_string(),
    }
}

/// Whether others than the account running Codeg can read the file (Unix:
/// any group or other permission bit). `None` elsewhere, or when its mode
/// cannot be read.
pub fn shared_mode(path: &Path) -> Option<u32> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(path).ok()?.permissions().mode() & 0o777;
        (mode & 0o077 != 0).then_some(mode)
    }
    #[cfg(not(unix))]
    {
        let _ = path;
        None
    }
}

fn warn_if_shared(path: &Path) {
    if let Some(mode) = shared_mode(path) {
        tracing::warn!(
            "[srn-web] the client secret file {} can be read by other accounts (mode {mode:03o}); \
             restrict it to the account that runs Codeg (chmod 600)",
            path.display()
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    const SECRET: &str = "s3cr3t-0123456789_abcdefghijklmnopqrstuvwxyzABC";
    const CLIENT: &str = "codeg-web-AbCdEf0123456789_-xyz";

    fn read(vars: &[(&str, &str)]) -> Settings {
        let vars: HashMap<String, String> = vars
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect();
        Settings::read(|name| vars.get(name).cloned(), Origin::release())
    }

    fn secret_file(dir: &Path, content: &str) -> PathBuf {
        let path = dir.join("client-secret");
        std::fs::write(&path, content).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
        }
        path
    }

    #[test]
    fn three_good_settings_turn_it_on() {
        let dir = tempfile::tempdir().unwrap();
        let file = secret_file(dir.path(), &format!("{SECRET}\n"));
        let settings = read(&[
            (PUBLIC_URL_ENV, " https://Codeg.Example.com/ "),
            (CLIENT_ID_ENV, CLIENT),
            (CLIENT_SECRET_FILE_ENV, file.to_str().unwrap()),
        ]);
        let Settings::Enabled(config) = settings else {
            panic!("off: {settings:?}");
        };
        assert_eq!(config.public_origin, "https://codeg.example.com");
        assert_eq!(
            config.redirect_uri,
            "https://codeg.example.com/auth/srn/callback"
        );
        assert_eq!(config.client_id, CLIENT);
        assert_eq!(config.client_secret.expose(), SECRET);
        assert_eq!(config.srn_origin.as_str(), "https://spacering.net");
        // and the secret never prints
        assert!(!format!("{config:?}").contains(SECRET));
    }

    #[test]
    fn nothing_set_is_off_and_said_so_quietly() {
        assert!(matches!(
            read(&[]),
            Settings::Disabled(Disabled::NotConfigured)
        ));
        assert!(matches!(
            read(&[(PUBLIC_URL_ENV, "  ")]),
            Settings::Disabled(Disabled::NotConfigured)
        ));
    }

    #[test]
    fn a_missing_setting_turns_it_off() {
        let dir = tempfile::tempdir().unwrap();
        let file = secret_file(dir.path(), SECRET);
        let file = file.to_str().unwrap();
        let all = [
            (PUBLIC_URL_ENV, "https://codeg.example.com"),
            (CLIENT_ID_ENV, CLIENT),
            (CLIENT_SECRET_FILE_ENV, file),
        ];
        for skip in 0..3 {
            let some: Vec<_> = all
                .iter()
                .enumerate()
                .filter(|(i, _)| *i != skip)
                .map(|(_, pair)| *pair)
                .collect();
            match read(&some) {
                Settings::Disabled(Disabled::Missing(names)) => {
                    assert_eq!(names, vec![all[skip].0]);
                }
                other => panic!("{skip}: {other:?}"),
            }
        }
    }

    #[test]
    fn a_public_url_is_an_exclusive_https_host_at_the_root() {
        for good in [
            "https://codeg.example.com",
            "https://codeg.example.com/",
            "https://codeg.example.com:443/",
            "https://CODEG.example.com",
            "https://a.b",
        ] {
            assert!(public_origin(good).is_ok(), "{good}");
        }
        assert_eq!(
            public_origin("https://codeg.example.com:443").unwrap(),
            "https://codeg.example.com"
        );
        for bad in [
            "http://codeg.example.com",
            "https://codeg.example.com:8443",
            "https://codeg.example.com/codeg",
            "https://codeg.example.com/codeg/",
            "https://codeg.example.com/?x=1",
            "https://codeg.example.com/?",
            "https://codeg.example.com/#top",
            "https://user@codeg.example.com",
            "https://user:pw@codeg.example.com",
            "https://localhost",
            "https://codeg",
            "https://127.0.0.1",
            "https://[::1]",
            "https://10.0.0.8",
            "ftp://codeg.example.com",
            "codeg.example.com",
            "",
        ] {
            assert!(public_origin(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn every_invalid_shape_turns_it_off() {
        let dir = tempfile::tempdir().unwrap();
        let good = secret_file(dir.path(), SECRET);
        let good = good.to_str().unwrap().to_string();
        let off = |url: &str, client: &str, file: &str| {
            read(&[
                (PUBLIC_URL_ENV, url),
                (CLIENT_ID_ENV, client),
                (CLIENT_SECRET_FILE_ENV, file),
            ])
        };
        assert!(matches!(
            off("http://codeg.example.com", CLIENT, &good),
            Settings::Disabled(Disabled::PublicUrl(_))
        ));
        for client in [
            "codeg-desktop",
            "codeg-desktop-dev",
            "codeg-web-short",
            "codeg-web-has space in it 0123",
            "codeg-web-0123456789abcdef!",
            "Codeg-web-0123456789abcdef",
            &format!("codeg-web-{}", "a".repeat(129)),
        ] {
            assert!(
                matches!(
                    off("https://codeg.example.com", client, &good),
                    Settings::Disabled(Disabled::ClientId)
                ),
                "{client}"
            );
        }
        assert!(is_web_client_id(&format!("codeg-web-{}", "a".repeat(16))));
        assert!(is_web_client_id(&format!("codeg-web-{}", "a".repeat(128))));

        let missing = dir.path().join("nope");
        assert!(matches!(
            off(
                "https://codeg.example.com",
                CLIENT,
                missing.to_str().unwrap()
            ),
            Settings::Disabled(Disabled::SecretFile(_))
        ));
        let a_dir = dir.path().to_str().unwrap();
        assert!(matches!(
            off("https://codeg.example.com", CLIENT, a_dir),
            Settings::Disabled(Disabled::SecretFile(_) | Disabled::Secret)
        ));
        for content in [
            "short".to_string(),
            "a".repeat(129),
            format!("{SECRET}+"),
            format!("{SECRET} {SECRET}"),
            String::new(),
            "x".repeat(5000),
        ] {
            let sub = tempfile::tempdir_in(dir.path()).unwrap();
            let file = secret_file(sub.path(), &content);
            let settings = off("https://codeg.example.com", CLIENT, file.to_str().unwrap());
            assert!(
                matches!(settings, Settings::Disabled(Disabled::Secret)),
                "{content:.20}: {settings:?}"
            );
        }
    }

    #[test]
    fn a_reason_never_quotes_the_file() {
        let dir = tempfile::tempdir().unwrap();
        let almost = format!("{SECRET}!");
        let file = secret_file(dir.path(), &almost);
        let Settings::Disabled(reason) = read(&[
            (PUBLIC_URL_ENV, "https://codeg.example.com"),
            (CLIENT_ID_ENV, CLIENT),
            (CLIENT_SECRET_FILE_ENV, file.to_str().unwrap()),
        ]) else {
            panic!("on");
        };
        let text = format!("{reason} {reason:?}");
        assert!(!text.contains(SECRET), "{text}");
    }

    #[cfg(unix)]
    #[test]
    fn a_secret_file_others_can_read_is_named() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let file = secret_file(dir.path(), SECRET);
        assert_eq!(shared_mode(&file), None);
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o644)).unwrap();
        assert_eq!(shared_mode(&file), Some(0o644));
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o640)).unwrap();
        assert_eq!(shared_mode(&file), Some(0o640));
        // still on: a warning, not a refusal
        let settings = read(&[
            (PUBLIC_URL_ENV, "https://codeg.example.com"),
            (CLIENT_ID_ENV, CLIENT),
            (CLIENT_SECRET_FILE_ENV, file.to_str().unwrap()),
        ]);
        assert!(settings.is_enabled());
    }
}
