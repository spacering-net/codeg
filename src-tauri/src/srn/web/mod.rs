//! SRN sign-in for Codeg Web: the browser UI served by `codeg-server`, and by
//! the desktop app's embedded web service.
//!
//! The server does the whole OAuth flow on the browser's behalf (a
//! backend-for-frontend): it creates the login request with the instance's
//! confidential client (`client_secret_basic`), takes the browser's return
//! at `/auth/srn/callback`, exchanges the code, and keeps the SRN token in
//! `codeg.db`, sealed. The browser holds only two `HttpOnly` cookies. Plan:
//! `docs/codeg-srn-login-plan.md` §4.4 on the website's side; the routes and
//! their answers: `routes.rs` and `/tmp/codeg-briefs/w2-api.md`.
//!
//! An SRN identity in a browser says which SRN user that browser is, and
//! nothing more: it never grants or replaces access to the instance
//! (`CODEG_TOKEN`, proxy-jwt), the instance stays one shared workspace, and
//! browsers' identities are independent of one another and of the desktop's
//! own account (`srn::account`).
//!
//! - [`config`] — W1: `CODEG_PUBLIC_URL`, `CODEG_SRN_CLIENT_ID`,
//!   `CODEG_SRN_CLIENT_SECRET_FILE`, checked at startup; anything wrong only
//!   turns SRN sign-in off.
//! - [`seal`] — AES-256-GCM for the token, the verifier and the request ID;
//!   the key in `<data dir>/srn-web.key` (server) or the keychain's
//!   `srn-web-key` (desktop), never in the database or the backup.
//! - [`service`] — the flow, the sessions, the hourly online check, the
//!   cleanup.
//! - [`routes`] — the HTTP routes and cookies.
//! - [`types`] — what the browser receives.
//!
//! Built on the desktop sign-in's pieces: its SpaceRing client (`client`),
//! secrets (`pkce`) and problems (`error`), and the origin rule (a release
//! build talks to `https://spacering.net` only; a development build follows
//! `CODEG_SRN_ORIGIN`). Nothing here logs a token, a code, a verifier, a
//! state, a request ID, a cookie or the client secret.

pub mod config;
pub mod routes;
pub mod seal;
pub mod service;
pub mod types;

#[cfg(test)]
mod tests;

use std::path::Path;
use std::sync::{Arc, OnceLock};

use sea_orm::DatabaseConnection;

pub use service::SrnWeb;

static INSTALLED: OnceLock<Arc<SrnWeb>> = OnceLock::new();

/// The service this process set up, if it did: the router mounts its routes
/// either way, and without one they answer "not enabled".
pub fn installed() -> Option<Arc<SrnWeb>> {
    INSTALLED.get().cloned()
}

/// codeg-server: reads the settings (and says in the log whether SRN sign-in
/// is on), keeps the key in `<data dir>/srn-web.key`, and starts the hourly
/// cleanup. Once per process; later calls return the first service.
pub fn start_for_server(db: &DatabaseConnection, data_dir: &Path) -> Arc<SrnWeb> {
    install(db, seal::KeySource::server_file(data_dir))
}

/// The desktop app's embedded web service, when it starts: the same
/// settings, read from the same variables; the key in the keychain
/// (`srn-web-key`). The desktop's own sign-in is untouched: another client
/// (`codeg-desktop`), another keychain entry, no shared state.
#[cfg(feature = "tauri-runtime")]
pub fn start_for_desktop(db: &DatabaseConnection) -> Arc<SrnWeb> {
    install(db, seal::KeySource::Keychain)
}

fn install(db: &DatabaseConnection, key: seal::KeySource) -> Arc<SrnWeb> {
    INSTALLED
        .get_or_init(|| {
            let settings = config::Settings::from_env();
            settings.log(config::secret_file_from_env().as_deref());
            let service = SrnWeb::new(settings, key, db.clone());
            service.spawn_cleanup();
            service
        })
        .clone()
}
