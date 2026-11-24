//! What an install is decided on. No command reads these yet: they are here
//! for the install steps, which build on this client rather than on one of
//! their own.
//!
//! Two answers, with two different standings:
//!
//! - [`Harness::install_info`] — one version with what it takes to install
//!   it. It comes through caches (Codeg's `cache.rs`, and the site's edge for
//!   up to five minutes), which is fine for what cannot change about a
//!   revision: its file list, its hashes, where its files come from. Its
//!   status, risk, permissions and package verification are for display.
//! - [`Harness::resolve`] — how installed revisions stand **now**: status,
//!   risk, review, permissions, checks and package verification, with a hash
//!   over them. Never cached, here or on the way. This is what the
//!   confirmation dialog shows for everything that can change, and what is
//!   read again, and compared by `state_sha256`, right before the install is
//!   committed.

use serde::Deserialize;
use serde_json::json;

use super::catalog::{ItemRef, API_PREFIX};
use super::error::HarnessError;
use super::types::{InstallInfo, Installed, Resolved};
use super::Harness;

/// The most items one `/resolve` request may ask about (the API's limit).
/// [`Harness::resolve`] asks in as many requests as it takes.
pub const MAX_RESOLVE_ITEMS: usize = 100;

#[derive(Deserialize)]
struct ResolveAnswer {
    items: Vec<Resolved>,
}

impl Harness {
    /// `GET /items/{ref}/versions/{revision}`: one version, with its files,
    /// hashes, packages and permissions. See the module docs for which of its
    /// fields an install may rely on.
    pub async fn install_info(
        &self,
        item_ref: &ItemRef,
        revision: u64,
    ) -> Result<InstallInfo, HarnessError> {
        self.ensure_enabled()?;
        if revision == 0 {
            return Err(HarnessError::InvalidRef);
        }
        let answer = self
            .json(&item_ref.api_path(&format!("/versions/{revision}")), &[])
            .await?;
        let info: InstallInfo = serde_json::from_value(answer).map_err(|error| {
            HarnessError::invalid_response(format!("not an install info: {error}"))
        })?;
        if info.version.revision != revision {
            return Err(HarnessError::invalid_response(format!(
                "asked for revision {revision}, answered {}",
                info.version.revision
            )));
        }
        Ok(info)
    }

    /// `POST /resolve`: how each of `installed` stands now, one answer per
    /// item asked about and in the order asked. An item that is not out, is
    /// private or does not exist answers `Unavailable`, with nothing else.
    ///
    /// Read fresh every time: nothing is kept, and the request says
    /// `no-store`. An answer that does not pair up with what was asked — a
    /// different count, an id out of place, the state of another revision —
    /// is refused whole, so a caller can never read one item's state as
    /// another's.
    ///
    /// A 404 is [`HarnessError::ResolveUnavailable`], never `NotFound`:
    /// `/resolve` answers an item it does not have in its body, as
    /// `Unavailable`, so a 404 means the endpoint itself is not there (a site
    /// that does not serve it yet) — not that the item the caller just read
    /// is gone.
    pub async fn resolve(&self, installed: &[Installed]) -> Result<Vec<Resolved>, HarnessError> {
        self.ensure_enabled()?;
        let url = self.origin.join(&format!("{API_PREFIX}/resolve"))?;
        let mut resolved = Vec::with_capacity(installed.len());
        for asked in installed.chunks(MAX_RESOLVE_ITEMS) {
            let body = match self.post_json(&url, &json!({ "installed": asked })).await {
                Err(HarnessError::NotFound) => return Err(HarnessError::ResolveUnavailable),
                answer => answer?,
            };
            let answer: ResolveAnswer = serde_json::from_slice(&body).map_err(|error| {
                HarnessError::invalid_response(format!("not a /resolve answer: {error}"))
            })?;
            let paired = answer.items.len() == asked.len()
                && answer.items.iter().zip(asked).all(|(item, asked)| {
                    item.id == asked.id
                        && item
                            .installed
                            .as_ref()
                            .is_none_or(|state| state.revision == asked.revision)
                });
            if !paired {
                return Err(HarnessError::invalid_response(
                    "/resolve did not answer what was asked, in the order asked",
                ));
            }
            resolved.extend(answer.items);
        }
        Ok(resolved)
    }
}
