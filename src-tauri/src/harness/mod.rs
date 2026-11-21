//! The SpaceRing Harness catalog, as Codeg's backend reads it.
//!
//! Every request to the catalog is made here, never by the frontend, for
//! three reasons: an item is installed on the machine the agents run on (this
//! one, a remote workspace's host, or the server behind a browser), a request
//! goes through the user's proxy settings, and there is one cache. The
//! frontend calls the commands in `commands::harness`, which both runtimes
//! register; `codeg-mcp` exposes none of this — an install is something only
//! a person confirms, in the interface.
//!
//! What is here:
//!
//! - [`origin`] — which SpaceRing origin this build talks to, and the one way
//!   an address on it is made;
//! - `client` — the rules every request follows (HTTPS, one host, anonymous,
//!   bounded, patient after a 429, the user's proxy);
//! - `cache` — answers kept on disk with their ETags, for revalidation only;
//! - `catalog` — browsing: `/config`, lists, an item, its versions,
//!   description and prompt text, one file of a package by its hash, and
//!   the image proxy;
//! - `resolve` — what an install is decided on: one version's install info,
//!   and `POST /resolve`;
//! - [`types`] — those two answers as Rust types;
//! - [`mcp`] — installing, updating and removing MCP servers, and the
//!   record of what was installed (step H4);
//! - [`skills`] — installing, updating and removing skills through the
//!   skills engine, the manifest of what was installed, and the journal
//!   that makes each of those survive a crash (step H3);
//! - [`updates`] — the update check: what `/resolve` says of what was
//!   installed, asked daily in the background and kept in the cache; it
//!   only tells (step H6). It builds on [`Harness`] and adds no HTTP client
//!   of its own.

mod cache;
mod catalog;
// The SRN account API (`srn::client`) shares the client's rules and pieces.
pub(crate) mod client;
mod error;
pub mod mcp;
pub mod origin;
mod resolve;
pub mod skills;
pub mod types;
pub mod updates;

#[cfg(test)]
mod tests;

use std::path::Path;

use sha2::{Digest, Sha256};

pub use cache::cache_dir;
pub use catalog::{Asset, ItemRef, ListQuery};
// What `srn_asset` accepts, which an SRN account's avatar path must be.
pub(crate) use catalog::validate_asset_path;
pub use error::{
    HarnessError, I18N_KEY_DISABLED, I18N_KEY_INVALID_REF, I18N_KEY_INVALID_RESPONSE,
    I18N_KEY_NETWORK, I18N_KEY_NOT_FOUND, I18N_KEY_RATE_LIMITED, I18N_KEY_RESOLVE_UNAVAILABLE,
    I18N_KEY_SERVER, I18N_KEY_TOO_LARGE,
};
pub use origin::Origin;
pub use resolve::MAX_RESOLVE_ITEMS;

use cache::{unix_now, Cache, Entry, PICTURE_FRESH_SECS};
use client::{Backoff, Expect, Incoming, Limits, Outgoing};

/// The operator's switch: `CODEG_HARNESS=off` turns the catalog off, for
/// deployments that may not reach the internet. Read by both binaries.
pub const SWITCH_ENV: &str = "CODEG_HARNESS";

/// Whether the catalog is offered on this Codeg. The update check asks this
/// too: switched off, nothing here makes a request.
pub fn enabled() -> bool {
    enabled_by(std::env::var(SWITCH_ENV).ok().as_deref())
}

/// [`enabled`], for the variable's value: on unless it says off (`off`, `0`,
/// `false` or `no`, in any case). Anything else — unset, empty, a typo —
/// leaves it on, as an installation without the variable is.
fn enabled_by(value: Option<&str>) -> bool {
    !value.is_some_and(|value| {
        matches!(
            value.trim().to_ascii_lowercase().as_str(),
            "off" | "0" | "false" | "no"
        )
    })
}

/// The catalog as one Codeg process reads it: whether it may, from where,
/// and the cache it keeps.
///
/// Cheap to make, and made per command ([`Harness::from_env`]): what must
/// outlive a command — the HTTP client, the pause after a 429 — is shared by
/// the process, and the cache is on disk.
pub struct Harness {
    enabled: bool,
    origin: Origin,
    cache: Cache,
    limits: Limits,
    backoff: &'static Backoff,
}

impl Harness {
    /// As this process is configured: the operator's switch, the build's
    /// origin, and the cache under `data_dir`.
    pub fn from_env(data_dir: &Path) -> Self {
        Self {
            enabled: enabled(),
            origin: origin::current(),
            cache: Cache::in_data_dir(data_dir),
            limits: Limits::default(),
            backoff: Backoff::shared(),
        }
    }

    /// Whether the operator left the catalog on.
    pub fn enabled(&self) -> bool {
        self.enabled
    }

    /// The SpaceRing origin every request goes to.
    pub fn origin(&self) -> &Origin {
        &self.origin
    }

    fn ensure_enabled(&self) -> Result<(), HarnessError> {
        if self.enabled {
            Ok(())
        } else {
            Err(HarnessError::Disabled)
        }
    }

    /// GETs `url` through the cache: the stored copy's ETag goes out as
    /// `If-None-Match`, a 304 serves that copy, and anything newer replaces
    /// it. Returns the media type and the body.
    ///
    /// A picture the site marked immutable is the one thing served here
    /// without asking, for as long as `cache.rs` allows. (A package's file,
    /// read by its hash, is served without asking for good: that is
    /// [`Self::fetch_by_hash`].)
    async fn fetch(
        &self,
        url: &reqwest::Url,
        expect: Expect,
        cap: u64,
    ) -> Result<(String, Vec<u8>), HarnessError> {
        // The whole address: an entry answers one origin's path and query.
        let key = url.as_str().to_string();
        let held = self
            .cached(|cache, key| cache.load(key), &key)
            .await
            .flatten()
            // one kept under another expectation is not offered back
            .filter(|entry| expect.accepts(&entry.content_type));
        let held = match held {
            Some(entry) if expect == Expect::Image && entry.is_fresh_at(unix_now()) => {
                self.cached(|cache, key| cache.touch(key), &key).await;
                return Ok((entry.content_type, entry.body));
            }
            held => held,
        };
        // Only a picture is ever kept as fresh, whatever an answer claims.
        let fresh_until = |immutable: bool| {
            (immutable && expect == Expect::Image).then(|| unix_now() + PICTURE_FRESH_SECS)
        };

        let answer = client::send(
            &self.origin,
            self.backoff,
            self.limits.request_timeout,
            Outgoing {
                url,
                expect,
                cap,
                if_none_match: held.as_ref().map(|entry| entry.etag.as_str()),
                json_body: None,
                idempotent: true,
            },
        )
        .await;

        match answer {
            Ok(Incoming::NotModified { immutable }) => {
                // `send` answers this only to a request that carried an ETag.
                let mut entry =
                    held.ok_or_else(|| HarnessError::invalid_response("a 304 with nothing kept"))?;
                match fresh_until(immutable) {
                    // a picture confirmed unchanged is fresh again
                    Some(until) => {
                        entry.fresh_until = Some(until);
                        let kept = entry.clone();
                        self.cached(move |cache, key| cache.store(key, &kept), &key)
                            .await;
                    }
                    None => {
                        self.cached(|cache, key| cache.touch(key), &key).await;
                    }
                }
                Ok((entry.content_type, entry.body))
            }
            Ok(Incoming::Body {
                etag,
                content_type,
                immutable,
                body,
            }) => {
                match etag {
                    Some(etag) => {
                        let entry = Entry {
                            etag,
                            content_type: content_type.clone(),
                            fresh_until: fresh_until(immutable),
                            body: body.clone(),
                        };
                        self.cached(move |cache, key| cache.store(key, &entry), &key)
                            .await;
                    }
                    // nothing to revalidate with: the copy before it is stale
                    None => {
                        self.cached(|cache, key| cache.remove(key), &key).await;
                    }
                }
                Ok((content_type, body))
            }
            Err(HarnessError::NotFound) => {
                self.cached(|cache, key| cache.remove(key), &key).await;
                Err(HarnessError::NotFound)
            }
            Err(error) => Err(error),
        }
    }

    /// GETs the file at a content-addressed `url`: the one whose SHA-256 is
    /// `sha256` (lowercase hex), of at most `cap` bytes.
    ///
    /// What is at such an address never changes, so a copy kept is served
    /// without asking — no revalidation, and no request at all, a pause after
    /// a 429 included. The address being the hash, a body is the file only if
    /// it hashes to it: one that does not is refused and never kept, and a
    /// copy that no longer does (a damaged file) is dropped and fetched again.
    /// The copy is an entry like any other, within the cache's bounds.
    async fn fetch_by_hash(
        &self,
        url: &reqwest::Url,
        sha256: &str,
        cap: u64,
    ) -> Result<Vec<u8>, HarnessError> {
        let key = url.as_str().to_string();
        let is_the_file = |body: &[u8]| {
            body.len() as u64 <= cap && format!("{:x}", Sha256::digest(body)) == sha256
        };
        if let Some(entry) = self
            .cached(|cache, key| cache.load(key), &key)
            .await
            .flatten()
        {
            if is_the_file(&entry.body) {
                self.cached(|cache, key| cache.touch(key), &key).await;
                return Ok(entry.body);
            }
            self.cached(|cache, key| cache.remove(key), &key).await;
        }

        let answer = client::send(
            &self.origin,
            self.backoff,
            self.limits.request_timeout,
            Outgoing {
                url,
                expect: Expect::File,
                cap,
                if_none_match: None,
                json_body: None,
                idempotent: true,
            },
        )
        .await?;
        let (etag, content_type, body) = match answer {
            Incoming::Body {
                etag,
                content_type,
                body,
                ..
            } => (etag, content_type, body),
            Incoming::NotModified { .. } => {
                return Err(HarnessError::invalid_response(
                    "a 304 to a request that offered no ETag",
                ))
            }
        };
        if !is_the_file(&body) {
            return Err(HarnessError::invalid_response(
                "the file does not match its hash",
            ));
        }
        let entry = Entry {
            // kept for the record: a copy of this is never revalidated
            etag: etag.unwrap_or_default(),
            content_type,
            fresh_until: None,
            body: body.clone(),
        };
        self.cached(move |cache, key| cache.store(key, &entry), &key)
            .await;
        Ok(body)
    }

    /// Runs a piece of cache work off the async threads: it is file I/O.
    /// `None` if the work could not run, which to a cache is a miss.
    async fn cached<T: Send + 'static>(
        &self,
        work: impl FnOnce(&Cache, &str) -> T + Send + 'static,
        key: &str,
    ) -> Option<T> {
        let cache = self.cache.clone();
        let key = key.to_string();
        tokio::task::spawn_blocking(move || work(&cache, &key))
            .await
            .ok()
    }

    /// POSTs `body` as JSON and reads a JSON answer. Never through the cache,
    /// and marked `no-store` so that nothing on the way keeps it either.
    /// Only `/resolve` is posted — a query that changes nothing — so the
    /// request may be sent again after a dropped connection (`client::send`).
    async fn post_json(
        &self,
        url: &reqwest::Url,
        body: &serde_json::Value,
    ) -> Result<Vec<u8>, HarnessError> {
        match client::send(
            &self.origin,
            self.backoff,
            self.limits.request_timeout,
            Outgoing {
                url,
                expect: Expect::Json,
                cap: self.limits.json_bytes,
                if_none_match: None,
                json_body: Some(body),
                // The one POST: `/resolve`, a query that changes nothing.
                idempotent: true,
            },
        )
        .await?
        {
            Incoming::Body { body, .. } => Ok(body),
            Incoming::NotModified { .. } => Err(HarnessError::invalid_response("a 304 to a POST")),
        }
    }
}

#[cfg(test)]
mod switch_tests {
    use super::*;

    #[test]
    fn the_catalog_is_on_unless_the_operator_says_off() {
        for on in [
            None,
            Some(""),
            Some("on"),
            Some("1"),
            Some("true"),
            Some("offf"),
        ] {
            assert!(enabled_by(on), "{on:?}");
        }
        for off in [
            Some("off"),
            Some("OFF"),
            Some(" Off "),
            Some("0"),
            Some("false"),
            Some("no"),
        ] {
            assert!(!enabled_by(off), "{off:?}");
        }
    }
}
