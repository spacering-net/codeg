//! Which SpaceRing client, origin and keychain entry this build signs in
//! with.
//!
//! Decided the way `harness::origin` decides the origin, which it reuses: a
//! release build is fixed — `https://spacering.net`, the public client
//! `codeg-desktop`, the keychain entry
//! `srn-token:codeg-desktop:https://spacering.net` ([`RELEASE_SECRET_NAME`])
//! — and reads no variable. A development or staging build (one built
//! without `--release`, as `origin::is_release_build` tells) follows
//! `CODEG_SRN_ORIGIN` for the origin and [`CLIENT_ID_ENV`] for its client.
//! Unset, that is the release build's own `codeg-desktop`: a public client
//! with a loopback redirect on any port, which every SpaceRing registers
//! (spacering.net, and a local site after its migrations), so a build from
//! source signs in without anything registered for it. A build that should
//! be listed apart names its own `codeg-desktop-<1–24 lowercase letters or
//! digits>`, registered on that SpaceRing.
//!
//! Every development build keeps its token under one entry,
//! [`DEVELOPMENT_SECRET_NAME`], never the release build's, so a release and a
//! development build signed in side by side never read each other's token.
//! The record there names the origin and client it was issued for
//! (`store::kept_for`), so a development build pointed somewhere else does
//! not take it for its own sign-in or send its token there.

use crate::harness::origin::{self, Origin};

/// The release build's client.
pub(crate) const RELEASE_CLIENT_ID: &str = "codeg-desktop";

/// Read by development and staging builds only. Not `CODEG_SRN_CLIENT_ID`:
/// that names a Web instance's client, which the desktop's embedded Web
/// service has as well.
pub(crate) const CLIENT_ID_ENV: &str = "CODEG_SRN_DESKTOP_CLIENT_ID";

/// The release build's keychain entry (a named secret, `keyring_store`):
/// `srn-token:<client>:<origin>` for its fixed client and origin.
pub(crate) const RELEASE_SECRET_NAME: &str = "srn-token:codeg-desktop:https://spacering.net";

/// Every development build's keychain entry, whatever it talks to.
pub(crate) const DEVELOPMENT_SECRET_NAME: &str = "srn-token-dev";

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
            None => RELEASE_CLIENT_ID.to_string(),
            Some(value) if is_development_client(value) => value.to_string(),
            Some(_) => {
                tracing::warn!(
                    "[srn] {CLIENT_ID_ENV} is ignored (not {DEVELOPMENT_PREFIX}<1-24 lowercase \
                     letters or digits>); using {RELEASE_CLIENT_ID}"
                );
                RELEASE_CLIENT_ID.to_string()
            }
        };
        Self {
            origin,
            client_id,
            secret_name: DEVELOPMENT_SECRET_NAME.to_string(),
        }
    }
}

/// `codeg-desktop-<1–24 lowercase letters or digits>`: SpaceRing's
/// `DESKTOP_ID` without the release client, which is the default anyway.
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
            assert_eq!(
                env.secret_name,
                "srn-token:codeg-desktop:https://spacering.net"
            );
        }
    }

    #[test]
    fn a_development_build_keeps_its_token_apart_from_the_release_builds() {
        // the release build's client, which SpaceRing has registered, so a
        // build from source signs in as it is
        let env = Environment::resolve(false, None, None);
        assert_eq!(env.origin.as_str(), "https://spacering.net");
        assert_eq!(env.client_id, RELEASE_CLIENT_ID);
        assert_eq!(env.secret_name, "srn-token-dev");

        let staging = Environment::resolve(
            false,
            Some("https://staging.spacering.net"),
            Some("codeg-desktop-staging"),
        );
        assert_eq!(staging.origin.as_str(), "https://staging.spacering.net");
        assert_eq!(staging.client_id, "codeg-desktop-staging");

        let local = Environment::resolve(false, Some("http://127.0.0.1:4321"), None);
        assert_eq!(local.origin.as_str(), "http://127.0.0.1:4321");
        assert_eq!(local.client_id, RELEASE_CLIENT_ID);

        // one entry for every development build (the record inside says
        // which origin and client it is for), never the release build's
        for env in [env, staging, local] {
            assert_eq!(env.secret_name, DEVELOPMENT_SECRET_NAME);
            assert_ne!(env.secret_name, RELEASE_SECRET_NAME);
        }
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
                RELEASE_CLIENT_ID,
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
