//! Which SpaceRing client, origin and keychain entry this build signs in
//! with.
//!
//! Decided the way `harness::origin` decides the origin, which it reuses: a
//! release build is fixed — `https://spacering.net`, the public client
//! `codeg-desktop`, the keychain entry `srn-token-prod` — and reads no
//! variable. A development or staging build (one built without `--release`,
//! as `origin::is_release_build` tells) follows `CODEG_SRN_ORIGIN` for the
//! origin and [`CLIENT_ID_ENV`] for its client — `codeg-desktop-<1–24
//! lowercase letters or digits>`, registered on that SpaceRing; `-dev` when
//! unset — and keeps its token under a name of its own for each client and
//! origin ([`development_secret_name`]). So a release and a development build
//! signed in side by side, to the same site or to different ones, never read
//! each other's token, and SpaceRing lists their connections apart.

use crate::harness::origin::{self, Origin};

/// The release build's client.
pub(crate) const RELEASE_CLIENT_ID: &str = "codeg-desktop";

/// A development build's client when [`CLIENT_ID_ENV`] does not name one.
pub(crate) const DEVELOPMENT_CLIENT_ID: &str = "codeg-desktop-dev";

/// Read by development and staging builds only. Not `CODEG_SRN_CLIENT_ID`:
/// that names a Web instance's client, which the desktop's embedded Web
/// service has as well.
pub(crate) const CLIENT_ID_ENV: &str = "CODEG_SRN_DESKTOP_CLIENT_ID";

/// The release build's keychain entry (a named secret, `keyring_store`).
pub(crate) const RELEASE_SECRET_NAME: &str = "srn-token-prod";

const DEVELOPMENT_PREFIX: &str = "codeg-desktop-";

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Environment {
    pub origin: Origin,
    pub client_id: String,
    /// The named secret the token is kept under.
    pub secret_name: String,
}

impl Environment {
    /// This process's.
    pub fn current() -> Self {
        Self::resolve(
            origin::is_release_build(),
            std::env::var(origin::ORIGIN_ENV).ok().as_deref(),
            std::env::var(CLIENT_ID_ENV).ok().as_deref(),
        )
    }

    /// [`Self::current`], for a build kind and the two variables' values.
    pub fn resolve(release: bool, origin_value: Option<&str>, client_value: Option<&str>) -> Self {
        let origin = origin::resolve(release, origin_value);
        if release {
            return Self {
                origin,
                client_id: RELEASE_CLIENT_ID.to_string(),
                secret_name: RELEASE_SECRET_NAME.to_string(),
            };
        }
        let client_id = match client_value
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            None => DEVELOPMENT_CLIENT_ID.to_string(),
            Some(value) if is_development_client(value) => value.to_string(),
            Some(_) => {
                tracing::warn!(
                    "[srn] {CLIENT_ID_ENV} is ignored (not {DEVELOPMENT_PREFIX}<1-24 lowercase \
                     letters or digits>); using {DEVELOPMENT_CLIENT_ID}"
                );
                DEVELOPMENT_CLIENT_ID.to_string()
            }
        };
        let secret_name = development_secret_name(&client_id, &origin);
        Self {
            origin,
            client_id,
            secret_name,
        }
    }
}

/// `codeg-desktop-<1–24 lowercase letters or digits>`: SpaceRing's
/// `DESKTOP_ID` without the release client, which only a release build uses.
fn is_development_client(value: &str) -> bool {
    value
        .strip_prefix(DEVELOPMENT_PREFIX)
        .is_some_and(|suffix| {
            (1..=24).contains(&suffix.len())
                && suffix
                    .bytes()
                    .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
        })
}

/// A development build's keychain entry: `srn-token:<client id>:<origin>`,
/// e.g. `srn-token:codeg-desktop-dev:https://spacering.net`.
///
/// One name per client and origin, and never one for two of them: the client
/// id holds no `:` (`is_development_client`), so the first `:` after the
/// prefix ends it, and the rest is the whole origin as `Origin` writes it —
/// scheme, lowercase host, the port unless it is the scheme's own — so
/// `http://localhost:3000` and `https://localhost:3000`, or
/// `https://srn-staging:8443` and `https://srn-staging-8443`, are two entries,
/// while one origin spelled two ways is one. It cannot be the release build's
/// [`RELEASE_SECRET_NAME`], which has no `:`.
fn development_secret_name(client_id: &str, origin: &Origin) -> String {
    format!("srn-token:{client_id}:{}", origin.as_str())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_release_build_is_fixed() {
        for (origin, client) in [
            (None, None),
            (
                Some("https://staging.spacering.net"),
                Some("codeg-desktop-staging"),
            ),
            (Some("http://127.0.0.1:4321"), Some("codeg-desktop-dev")),
        ] {
            let env = Environment::resolve(true, origin, client);
            assert_eq!(env.origin.as_str(), "https://spacering.net");
            assert_eq!(env.client_id, "codeg-desktop");
            assert_eq!(env.secret_name, "srn-token-prod");
        }
    }

    #[test]
    fn a_development_build_has_a_client_and_an_entry_of_its_own() {
        let env = Environment::resolve(false, None, None);
        assert_eq!(env.origin.as_str(), "https://spacering.net");
        assert_eq!(env.client_id, "codeg-desktop-dev");
        assert_eq!(
            env.secret_name,
            "srn-token:codeg-desktop-dev:https://spacering.net"
        );

        let staging = Environment::resolve(
            false,
            Some("https://staging.spacering.net"),
            Some("codeg-desktop-staging"),
        );
        assert_eq!(staging.client_id, "codeg-desktop-staging");
        assert_eq!(
            staging.secret_name,
            "srn-token:codeg-desktop-staging:https://staging.spacering.net"
        );

        let local = Environment::resolve(false, Some("http://127.0.0.1:4321"), None);
        assert_eq!(local.origin.as_str(), "http://127.0.0.1:4321");
        assert_eq!(
            local.secret_name,
            "srn-token:codeg-desktop-dev:http://127.0.0.1:4321"
        );

        // never the release build's entry, whatever it talks to
        for env in [env, staging, local] {
            assert_ne!(env.secret_name, RELEASE_SECRET_NAME);
            assert_ne!(env.client_id, RELEASE_CLIENT_ID);
        }
    }

    /// Two development origins never share an entry: one environment's
    /// token is never sent to another, and a 401 there never deletes it.
    #[test]
    fn two_origins_or_two_clients_never_share_an_entry() {
        let name = |origin: &str, client: Option<&str>| {
            let env = Environment::resolve(false, Some(origin), client);
            assert_eq!(env.origin.as_str(), origin, "not followed: {origin}");
            env.secret_name
        };
        // the scheme counts
        assert_ne!(
            name("http://localhost:3000", None),
            name("https://localhost:3000", None)
        );
        // a port is not a piece of the host
        assert_ne!(
            name("https://srn-staging:8443", None),
            name("https://srn-staging-8443", None)
        );
        assert_ne!(
            name("https://staging.spacering.net", None),
            name("https://staging.spacering.net:8443", None)
        );
        // the client counts
        assert_ne!(
            name("https://staging.spacering.net", Some("codeg-desktop-a")),
            name("https://staging.spacering.net", Some("codeg-desktop-b"))
        );
        // and one origin spelled two ways is one entry
        assert_eq!(
            Environment::resolve(false, Some("HTTPS://Staging.SpaceRing.net:443/"), None)
                .secret_name,
            name("https://staging.spacering.net", None)
        );
    }

    #[test]
    fn a_client_that_is_not_a_development_one_is_not_followed() {
        for bad in [
            "codeg-desktop",
            "codeg-desktop-",
            "codeg-desktop-Dev",
            "codeg-desktop-dev_1",
            "codeg-desktop-dev-1",
            "codeg-desktop-0123456789012345678901234",
            "codeg-web-abcdefghijklmnop",
            "other",
        ] {
            assert_eq!(
                Environment::resolve(false, None, Some(bad)).client_id,
                DEVELOPMENT_CLIENT_ID,
                "{bad}"
            );
        }
        assert_eq!(
            Environment::resolve(false, None, Some(" codeg-desktop-qa1 ")).client_id,
            "codeg-desktop-qa1"
        );
        assert_eq!(
            Environment::resolve(false, None, Some("codeg-desktop-012345678901234567890123"))
                .client_id,
            "codeg-desktop-012345678901234567890123"
        );
    }
}
