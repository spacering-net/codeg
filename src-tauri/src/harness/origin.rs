//! Which SpaceRing origin this build talks to, and the one way an address on
//! it is made.
//!
//! A release build talks to `https://spacering.net` and nothing else. A
//! development or staging build follows `CODEG_SRN_ORIGIN` when it is set (a
//! staging site, or the website's dev server on this machine); a release build
//! does not read the variable at all, since anything that can set a launch
//! environment could otherwise point an installed Codeg at another catalog.
//!
//! Every address Codeg requests is this origin plus a path Codeg wrote itself
//! ([`Origin::join`]). Nothing an answer contains is ever used as a host.

use url::{Host, Position, Url};

use super::error::HarnessError;

/// The origin of every release build.
pub const RELEASE_ORIGIN: &str = "https://spacering.net";

/// Read by development and staging builds only. Shared with the SRN sign-in,
/// which talks to the same site.
pub const ORIGIN_ENV: &str = "CODEG_SRN_ORIGIN";

/// A SpaceRing origin: scheme, host and port, with no trailing slash.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Origin {
    text: String,
    url: Url,
}

impl Origin {
    /// `https://spacering.net`.
    pub fn release() -> Self {
        Self::parse(RELEASE_ORIGIN).expect("the release origin is a valid origin")
    }

    /// As written in links and in `harness_status`: no trailing slash.
    pub fn as_str(&self) -> &str {
        &self.text
    }

    pub fn is_https(&self) -> bool {
        self.url.scheme() == "https"
    }

    /// What an origin may be: `https://host[:port]`, or — only ever reached
    /// from a build that is not a release — `http://` on a loopback address.
    /// No credentials, path, query or fragment: those are not part of an
    /// origin, and one that carries them was probably meant as something else.
    pub(crate) fn parse(raw: &str) -> Result<Self, &'static str> {
        let url = Url::parse(raw.trim()).map_err(|_| "it is not a URL")?;
        let host = url.host().ok_or("it names no host")?;
        match url.scheme() {
            "https" => {}
            "http" if is_loopback(&host) => {}
            "http" => return Err("http is accepted for a loopback address only"),
            _ => return Err("it is neither https nor http"),
        }
        if !url.username().is_empty() || url.password().is_some() {
            return Err("it carries credentials");
        }
        if url.path() != "/" || url.query().is_some() || url.fragment().is_some() {
            return Err("it has a path, a query or a fragment");
        }
        let mut text = format!("{}://{}", url.scheme(), url.host_str().unwrap_or_default());
        if let Some(port) = url.port() {
            text.push_str(&format!(":{port}"));
        }
        let url = Url::parse(&text).map_err(|_| "it is not a URL")?;
        Ok(Self { text, url })
    }

    /// The address of `path` on this origin.
    ///
    /// `path` is site-relative: it starts with one `/` and has no query or
    /// fragment (a caller that needs a query adds it to the result). It must
    /// also be exactly what will be requested: a path the URL parser would
    /// rewrite — dot segments, a backslash, a space, a control character — is
    /// refused rather than normalized, so what was validated is what is sent.
    pub fn join(&self, path: &str) -> Result<Url, HarnessError> {
        if !path.starts_with('/') || path.starts_with("//") || path.contains(['?', '#']) {
            return Err(HarnessError::InvalidRef);
        }
        let url =
            Url::parse(&format!("{}{path}", self.text)).map_err(|_| HarnessError::InvalidRef)?;
        if &url[Position::BeforePath..] != path || !same_origin(&url, &self.url) {
            return Err(HarnessError::InvalidRef);
        }
        Ok(url)
    }

    /// Whether `url` is on this origin.
    pub(crate) fn holds(&self, url: &Url) -> bool {
        same_origin(url, &self.url)
    }
}

impl std::fmt::Display for Origin {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.text)
    }
}

/// Scheme, host and port: what "the same server" means, for a redirect as for
/// an address.
pub(crate) fn same_origin(a: &Url, b: &Url) -> bool {
    a.scheme() == b.scheme()
        && a.host_str().map(str::to_ascii_lowercase) == b.host_str().map(str::to_ascii_lowercase)
        && a.port_or_known_default() == b.port_or_known_default()
}

fn is_loopback(host: &Host<&str>) -> bool {
    match host {
        Host::Domain(name) => name.eq_ignore_ascii_case("localhost"),
        Host::Ipv4(ip) => ip.is_loopback(),
        Host::Ipv6(ip) => ip.is_loopback(),
    }
}

/// Whether this is a release build, the way the rest of the codebase tells
/// (`cli_run::wire::BuildKind`, `computer::local::locate_helper_binary`): by
/// the build profile. A staging build is therefore one built without
/// `--release`; if staging ever ships as an optimized build, this function is
/// the one place to teach about it.
pub fn is_release_build() -> bool {
    !cfg!(debug_assertions)
}

/// The origin this process talks to.
pub fn current() -> Origin {
    resolve(
        is_release_build(),
        std::env::var(ORIGIN_ENV).ok().as_deref(),
    )
}

/// [`current`], for a build kind and the variable's value.
///
/// An override that is not a usable origin is not followed: the build falls
/// back to the release origin and says so in the log, rather than talking to
/// whatever the text happened to parse as.
pub(crate) fn resolve(release: bool, value: Option<&str>) -> Origin {
    if release {
        return Origin::release();
    }
    let Some(raw) = value.map(str::trim).filter(|value| !value.is_empty()) else {
        return Origin::release();
    };
    match Origin::parse(raw) {
        Ok(origin) => origin,
        Err(reason) => {
            tracing::warn!("[harness] {ORIGIN_ENV} is ignored ({reason}); using {RELEASE_ORIGIN}");
            Origin::release()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_release_build_ignores_the_variable() {
        for value in [
            None,
            Some(""),
            Some("https://staging.spacering.net"),
            Some("http://127.0.0.1:4321"),
            Some("https://elsewhere.example"),
        ] {
            assert_eq!(resolve(true, value).as_str(), RELEASE_ORIGIN, "{value:?}");
        }
    }

    #[test]
    fn a_development_build_follows_the_variable() {
        assert_eq!(resolve(false, None).as_str(), RELEASE_ORIGIN);
        assert_eq!(resolve(false, Some("  ")).as_str(), RELEASE_ORIGIN);
        assert_eq!(
            resolve(false, Some("https://staging.spacering.net")).as_str(),
            "https://staging.spacering.net"
        );
        // as people write it: a trailing slash, a default port, capitals
        assert_eq!(
            resolve(false, Some(" HTTPS://Staging.SpaceRing.net:443/ ")).as_str(),
            "https://staging.spacering.net"
        );
        assert_eq!(
            resolve(false, Some("https://staging.spacering.net:8443")).as_str(),
            "https://staging.spacering.net:8443"
        );
    }

    #[test]
    fn http_is_followed_on_loopback_only() {
        for loopback in [
            "http://127.0.0.1:4321",
            "http://localhost:4321",
            "http://[::1]:4321",
            "http://127.8.9.10",
        ] {
            assert_eq!(resolve(false, Some(loopback)).as_str(), loopback);
        }
        for elsewhere in [
            "http://spacering.net",
            "http://staging.spacering.net:4321",
            "http://192.168.1.10:4321",
            "http://0.0.0.0:4321",
            "http://localhost.example:4321",
            "http://127.0.0.1.example:4321",
        ] {
            assert_eq!(
                resolve(false, Some(elsewhere)).as_str(),
                RELEASE_ORIGIN,
                "{elsewhere}"
            );
        }
    }

    #[test]
    fn an_override_that_is_not_an_origin_is_not_followed() {
        for bad in [
            "staging.spacering.net",
            "localhost:4321",
            "ftp://staging.spacering.net",
            "file:///etc/hosts",
            "https://",
            "https://user:secret@staging.spacering.net",
            "https://user@staging.spacering.net",
            "https://staging.spacering.net/api/harness/v1",
            "https://staging.spacering.net/?x=1",
            "https://staging.spacering.net/#x",
        ] {
            assert_eq!(resolve(false, Some(bad)).as_str(), RELEASE_ORIGIN, "{bad}");
        }
    }

    #[test]
    fn this_build_is_a_release_exactly_when_it_is_optimized_for_one() {
        assert_eq!(is_release_build(), !cfg!(debug_assertions));
        if is_release_build() {
            assert_eq!(current().as_str(), RELEASE_ORIGIN);
        }
    }

    #[test]
    fn an_address_is_the_origin_plus_the_path_as_written() {
        let origin = Origin::release();
        assert_eq!(
            origin.join("/api/harness/v1/config").unwrap().as_str(),
            "https://spacering.net/api/harness/v1/config"
        );
        let local = Origin::parse("http://127.0.0.1:4321").unwrap();
        assert_eq!(
            local.join("/api/avatars/a/b.png").unwrap().as_str(),
            "http://127.0.0.1:4321/api/avatars/a/b.png"
        );
    }

    #[test]
    fn no_path_changes_the_host_or_is_rewritten_on_the_way() {
        let origin = Origin::release();
        for bad in [
            "",
            "api/harness/v1/config",
            "https://elsewhere.example/api/harness/v1/config",
            "//elsewhere.example/api/harness/v1/config",
            "@elsewhere.example/api",
            ".elsewhere.example/api",
            ":8443/api",
            "/api/harness/v1/../../x",
            "/api/harness/v1/./config",
            "/api/harness/v1/..",
            "/api/harness/v1/%2e%2e/x",
            "/api/harness/v1/config?x=1",
            "/api/harness/v1/config#x",
            "/api/harness/v1/a b",
            "/api/harness/v1/a\tb",
            "/api/harness/v1/a\nb",
            "/api\\harness",
            "/\\elsewhere.example",
        ] {
            assert_eq!(origin.join(bad), Err(HarnessError::InvalidRef), "{bad:?}");
        }
    }
}
