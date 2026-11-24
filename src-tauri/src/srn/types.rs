//! The desktop account as the frontend sees it: the state the `srn_*`
//! commands answer, the `srn://account-changed` event, and what a sign-out
//! reports. `/tmp/codeg-briefs/b1-api.md` is the reference for the status-bar
//! entry (B2).
//!
//! None of it holds a token, a code, a verifier or a state. The one secret-ish
//! value is the pending sign-in's `authorizationUrl`, whose fragment holds the
//! request ID: the person needs it to open the page again or copy the link,
//! so the state carries it — and the event, which goes to every window, does
//! not.

use serde::{Deserialize, Serialize};

use crate::app_error::AppCommandError;

/// Why an online check is asked for (`srn_check_online`'s `trigger`).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CheckTrigger {
    /// A window came to the front (Codeg sends this itself), or the
    /// frontend has no better reason: at most hourly, and not within a
    /// minute of a check that got no answer.
    #[default]
    Foreground,
    /// The network came back (the webview's `online` event): at most
    /// hourly, counted from the last check SpaceRing answered, and not
    /// within ten seconds of the last check (every window sends it).
    Online,
    /// The person asked: not throttled, but it joins a check under way and
    /// waits out SpaceRing's `Retry-After` (failing with `rateLimited`).
    User,
}

/// The `srn://account-changed` event: something about the account changed —
/// the status, the identity, the online check, a problem. Desktop windows
/// only. A window reads the rest with `srn_account`.
pub const ACCOUNT_CHANGED_EVENT: &str = "srn://account-changed";

/// Who is signed in, as shown.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SrnIdentity {
    /// The SRN number.
    pub srn: u64,
    /// The display name; may be empty (show `SRN <srn>` then).
    pub name: String,
    /// The picture's path on SpaceRing (`/api/avatars/…`), for `srn_asset`;
    /// `null` for none.
    pub avatar_path: Option<String>,
}

/// The online check: whether SpaceRing has confirmed the account.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum OnlineStatus {
    /// Not checked yet since Codeg started (the identity is the one kept
    /// with the token).
    Unchecked,
    /// The last check confirmed it.
    Confirmed,
    /// The last check could not: offline, SpaceRing unavailable or busy. The
    /// identity is kept; `problem` says why.
    Unconfirmed,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SrnOnline {
    pub status: OnlineStatus,
    /// A check is under way.
    pub checking: bool,
    /// When the last check ended, whatever it found (RFC 3339, UTC).
    pub checked_at: Option<String>,
    /// When SpaceRing last confirmed the account.
    pub confirmed_at: Option<String>,
    /// Why the last check did not confirm it (`unconfirmed` only).
    pub problem: Option<AppCommandError>,
}

/// The account.
#[derive(Debug, Clone, Serialize)]
#[serde(
    tag = "status",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum SrnAccountState {
    /// Codeg is still reading the keychain, just after it started.
    Loading,
    /// No sign-in on this computer. `problem` says why, when the last
    /// sign-in failed or SpaceRing ended the sign-in (`revoked`).
    SignedOut {
        #[serde(skip_serializing_if = "Option::is_none")]
        problem: Option<AppCommandError>,
    },
    /// A sign-in is waiting for the browser.
    Pending {
        /// The authorization page: "open the page again", "copy the link".
        authorization_url: String,
        /// When the sign-in gives up waiting (RFC 3339, UTC).
        expires_at: String,
        /// The browser has come back; Codeg is completing the sign-in.
        completing: bool,
        /// The browser could not be opened (`openBrowser`): the link is the
        /// way.
        #[serde(skip_serializing_if = "Option::is_none")]
        problem: Option<AppCommandError>,
    },
    SignedIn {
        account: SrnIdentity,
        online: SrnOnline,
    },
    /// The keychain holds a sign-in that could not be read. Not "signed
    /// out": `problem` says what failed (`keychainRead`, `credentialInvalid`,
    /// or a later sign-in's failure).
    CredentialUnreadable { problem: AppCommandError },
}

/// What the event carries: the status and who, nothing more.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SrnAccountChanged {
    /// As in [`SrnAccountState`]: `loading`, `signedOut`, `pending`,
    /// `signedIn`, `credentialUnreadable`.
    pub status: &'static str,
    /// Who, when `signedIn`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub account: Option<SrnIdentity>,
}

/// Whether SpaceRing confirmed a sign-out.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum RemoteSignOut {
    /// SpaceRing ended the connection.
    Confirmed,
    /// Signed out on this computer only: SpaceRing could not be reached or
    /// did not answer, or the token could not be read to tell it. The
    /// connection is listed on the website until it is removed there or
    /// expires.
    Unconfirmed,
    /// There was no sign-in to end.
    NotSignedIn,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SrnSignOutResult {
    /// The account now (`signedOut`).
    pub state: SrnAccountState,
    pub remote: RemoteSignOut,
    /// `unconfirmed` only: where the connection can be removed — the
    /// website's `/console/clients/` (`/zh/console/clients/` for a Chinese
    /// interface).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub manage_connections_url: Option<String>,
    /// `unconfirmed` only: `signedOutLocally`, with `url` and the `reason`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub problem: Option<AppCommandError>,
}
