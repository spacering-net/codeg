//! Signing in to SpaceRing (SRN), the account behind spacering.net.
//!
//! The desktop app signs in with OAuth 2.0's authorization code grant, PKCE
//! (S256) and a loopback redirect (RFC 8252 §7.3), as `api/clients/` on the
//! SpaceRing side expects of a public client:
//!
//! 1. Codeg makes a `state` and a `verifier` (32 random bytes each), listens on
//!    `127.0.0.1` at a port the system picks, and creates a login request whose
//!    redirect is `http://127.0.0.1:<port>/auth/callback`.
//! 2. The system browser opens the authorization page; the request travels in
//!    its fragment, which no server ever receives.
//! 3. The page sends the browser back to the loopback address with a code (or
//!    `error=access_denied`). The listener takes exactly one such answer, whose
//!    `state` matches, and closes.
//! 4. Codeg exchanges the code once — never again, whatever happens to the
//!    answer — keeps the token in the OS keychain, and confirms who it belongs
//!    to with `/me`.
//!
//! What is here:
//!
//! - [`client`] — the SRN account API (login requests, the code exchange,
//!   `/me`, `logout`) under the rules of the Harness client it shares its
//!   pieces with: the user's proxy, HTTPS, bounded answers, and no redirect
//!   followed. Compiled in both runtimes: the Web sign-in builds on it.
//! - [`pkce`] — the flow's secrets and the opaque values SpaceRing hands out,
//!   none of which can be printed by accident.
//! - [`error`] — what can go wrong, as the stable codes and i18n keys the
//!   status-bar popover explains.
//! - The desktop account, desktop builds only: `account` (the app-level
//!   account service: the current account, the flow generations, the online
//!   check), `loopback` (the one-shot listener), `page` (what the browser
//!   shows when it comes back), `store` (the keychain record), `environment`
//!   (which client and keychain entry this build uses) and `desktop` (the
//!   Tauri side: the singleton, the event, the system browser, the window).
//!   The commands are in `commands::srn`.
//! - [`web`] — Codeg Web's own sign-in, both runtimes: the server completes
//!   the flow for the browser and keeps the session in `codeg.db`.
//!
//! The account belongs to this desktop app. No command hands the token out,
//! the account event reaches the desktop's own windows only (never the
//! embedded web server's clients, which hold SRN sessions of their own), and
//! neither codeg-server nor codeg-mcp compiles any of it. Nothing here logs a
//! token, a code, a verifier, a state or a request ID.

pub mod client;
pub mod error;
pub mod pkce;
pub mod web;

#[cfg(feature = "tauri-runtime")]
pub(crate) mod account;
#[cfg(feature = "tauri-runtime")]
pub(crate) mod desktop;
#[cfg(feature = "tauri-runtime")]
pub(crate) mod environment;
#[cfg(feature = "tauri-runtime")]
pub(crate) mod loopback;
#[cfg(feature = "tauri-runtime")]
pub(crate) mod page;
#[cfg(feature = "tauri-runtime")]
pub(crate) mod store;
#[cfg(feature = "tauri-runtime")]
pub mod types;

#[cfg(test)]
pub(crate) mod test_support;
#[cfg(all(test, feature = "tauri-runtime"))]
mod tests;
