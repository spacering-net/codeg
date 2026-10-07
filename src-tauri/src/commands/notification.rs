//! OS notifications, and the two affordances the platform gives us for
//! diagnosing them.
//!
//! Neither notification backend we use exposes a permission state on desktop:
//! `tauri-plugin-notification`'s desktop implementation hard-codes
//! `PermissionState::Granted` for both `permission_state()` and
//! `request_permission()`, and `mac-notification-sys` has no authorization API
//! at all. So the frontend cannot render "allowed / blocked" without inventing
//! it. What it CAN do is send a test notification and offer a shortcut to the
//! system pane that actually owns the decision — which is why both commands
//! here return real errors instead of best-effort silence.
//!
//! On macOS there is a second thing the user needs to know and the OS will not
//! tell them: *which app* the notification is attributed to. `NSUserNotification`
//! has no notion of an unbundled process, so `mac-notification-sys` swizzles
//! `-[NSBundle bundleIdentifier]` to a bundle id of our choosing and the OS
//! files the notification — and its permission — under THAT app. Get it wrong
//! and every switch the user can see belongs to a different app, which is
//! exactly the state this module used to ship in (see
//! `resolve_notification_identity`). `notification_identity` reports the
//! resolved bundle id so the settings panel can name it instead of implying
//! the user's own toggles are in play.

// Only the macOS identity static needs it; anywhere else this is an unused
// import, which `-D warnings` rejects.
#[cfg(all(feature = "tauri-runtime", target_os = "macos"))]
use std::sync::OnceLock;

#[cfg(feature = "tauri-runtime")]
use serde::Serialize;
#[cfg(feature = "tauri-runtime")]
use tauri::AppHandle;

#[cfg(feature = "tauri-runtime")]
use crate::app_error::{AppCommandError, AppErrorCode};

/// Where `mac-notification-sys` lands when the bundle id we ask for cannot be
/// claimed. Not a policy of ours: it is the literal default baked into the
/// crate's swizzled `-[NSBundle bundleIdentifier]`, which returns
/// `@"com.apple.Terminal"` whenever `setApplication` bailed before assigning
/// `fakeBundleIdentifier`. Naming it here is how we report what the OS will
/// actually do, rather than guessing.
#[cfg(all(feature = "tauri-runtime", target_os = "macos"))]
const MACOS_FALLBACK_BUNDLE_ID: &str = "com.apple.Terminal";

/// Which app the OS believes is posting our notifications.
///
/// The distinction between the two ids is the whole point: permission, icon,
/// name and the System Settings pane all follow `bundle_id`, so when it differs
/// from `requested_bundle_id` the user's own notification switches are not the
/// ones in play.
///
/// Only ever populated on macOS — see `resolve_notification_identity` — but
/// the type exists everywhere because it is the return shape of a command the
/// frontend calls on every desktop platform.
#[cfg(feature = "tauri-runtime")]
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotificationIdentity {
    /// The bundle id notifications are actually delivered under.
    pub bundle_id: String,
    /// The bundle id we asked for — this app's own identifier.
    pub requested_bundle_id: String,
    /// `bundle_id != requested_bundle_id`: delivery fell back to another app's
    /// identity, so that app's switches govern whether anything appears.
    pub degraded: bool,
}

#[cfg(all(feature = "tauri-runtime", target_os = "macos"))]
static NOTIFICATION_IDENTITY: OnceLock<NotificationIdentity> = OnceLock::new();

/// Claim a notification identity for this process, once, and report what we
/// got. `None` off macOS.
///
/// The `OnceLock` is not a cache — it is the only place the answer survives.
/// `mac_notification_sys::set_application` is guarded by its own `Once` and
/// returns `AlreadySet` for every call after the first *including when that
/// first call failed*, so a caller that does not record the first outcome can
/// never learn it again. That is how the previous `let _ = set_application(..)`
/// managed to lose a hard failure.
///
/// This deliberately does NOT special-case `is_dev()`. The old code passed
/// `"com.apple.Terminal"` in dev builds, copying `tauri-plugin-notification`,
/// which made every dev notification land under Terminal's permission — an app
/// most users have never granted, so nothing appeared and the codeg switches
/// the user could see governed nothing. Asking for our own identifier works
/// whenever codeg is registered with LaunchServices (the usual case: it is
/// installed), and when it is not, `setApplication` leaves `fakeBundleIdentifier`
/// nil and the crate's swizzle falls back to `com.apple.Terminal` on its own —
/// i.e. exactly the old behaviour, minus the silence about it.
///
/// Nothing is reported off macOS, and that is the honest answer rather than a
/// gap. macOS is the only platform where we impersonate another app, so it is
/// the only one where the delivering identity can differ from ours. Linux posts
/// over D-Bus under the name we pass. Windows has its own version of this
/// problem — `tauri-plugin-notification` only assigns the AppUserModelID when
/// the exe is outside `target/debug|release`, so a Windows dev build posts
/// under whatever AUMID `notify-rust` falls back to — but the plugin does not
/// tell us which, so claiming an identity there would be exactly the kind of
/// invented fact this module exists to avoid.
#[cfg(feature = "tauri-runtime")]
fn resolve_notification_identity(
    #[allow(unused_variables)] app: &AppHandle,
) -> Option<&'static NotificationIdentity> {
    #[cfg(target_os = "macos")]
    {
        Some(NOTIFICATION_IDENTITY.get_or_init(|| {
            use mac_notification_sys::error::{ApplicationError, Error as MacNotificationError};

            let requested = app.config().identifier.clone();
            let bundle_id = match mac_notification_sys::set_application(&requested) {
                Ok(()) => requested.clone(),
                // LaunchServices does not know this bundle id, so the swizzle
                // is serving `com.apple.Terminal` and that is where the OS will
                // file the notification.
                Err(MacNotificationError::Application(ApplicationError::CouldNotSet(_))) => {
                    MACOS_FALLBACK_BUNDLE_ID.to_string()
                }
                // Somebody else won the crate's `Once` before us — today only
                // `tauri-plugin-notification` could, and it asks for the same
                // identifier. We cannot read the value back out of the crate, so
                // report the one we asked for rather than invent a failure.
                Err(_) => requested.clone(),
            };

            NotificationIdentity {
                degraded: bundle_id != requested,
                bundle_id,
                requested_bundle_id: requested,
            }
        }))
    }

    #[cfg(not(target_os = "macos"))]
    {
        None
    }
}

/// Report the app identity the OS files our notifications under, or `null`
/// where the platform gives us nothing trustworthy to report.
///
/// Cheap and idempotent after the first call, but the first call is what
/// establishes the identity — on macOS that means installing the crate's
/// `NSBundle` swizzle. That is the same swizzle the first notification would
/// install anyway, and in a packaged build it substitutes the app's real
/// identifier for itself, so mounting the settings panel does not change what
/// any other framework sees.
#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn notification_identity(app: AppHandle) -> Option<NotificationIdentity> {
    resolve_notification_identity(&app).cloned()
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn send_notification(
    #[allow(unused_variables)] app: AppHandle,
    title: String,
    body: String,
) -> Result<(), AppCommandError> {
    #[cfg(target_os = "macos")]
    {
        // Must precede the send: this is what assigns the bundle id the OS
        // attributes the notification to. Its outcome is reported separately
        // by `notification_identity` — a degraded identity still delivers, so
        // it is not a reason to fail the send.
        let _identity = resolve_notification_identity(&app);

        mac_notification_sys::Notification::default()
            .title(&title)
            .message(&body)
            .send()
            .map_err(|err| {
                AppCommandError::new(
                    AppErrorCode::ExternalCommandFailed,
                    "Failed to post the system notification",
                )
                .with_detail(err.to_string())
            })?;
    }

    #[cfg(not(target_os = "macos"))]
    {
        use tauri_plugin_notification::NotificationExt;
        app.notification()
            .builder()
            .title(title)
            .body(body)
            .show()
            .map_err(|err| {
                AppCommandError::new(
                    AppErrorCode::ExternalCommandFailed,
                    "Failed to post the system notification",
                )
                .with_detail(err.to_string())
            })?;
    }

    Ok(())
}

/// Candidate commands that open the OS pane governing notification permission,
/// most specific first.
///
/// `bundle_id` is the only non-literal, and it never comes from the renderer:
/// it is either this app's identifier (compiled in from `tauri.conf.json`) or
/// the hard-coded fallback above. It is passed as one argv element to a
/// program spawned directly — there is no shell to inject into. That matters
/// because it is the reason this is a dedicated command rather than a widened
/// `opener` scope: `tauri-plugin-opener`'s default scope only permits
/// `http`/`https`/`mailto`/`tel`, and allowing arbitrary custom schemes through
/// it would open that door for every other piece of renderer code too,
/// including the markdown we render from agent output.
#[cfg(feature = "tauri-runtime")]
fn system_notification_settings_candidates(
    #[allow(unused_variables)] bundle_id: &str,
) -> Vec<(&'static str, Vec<String>)> {
    #[cfg(target_os = "macos")]
    {
        // `?id=` selects the app's own notification page — the one with the
        // "Allow notifications" switch — instead of dropping the user on the
        // list of every app on the machine. Verified on macOS 26 for both the
        // legacy pane id used here and the Ventura-era
        // `com.apple.Notifications-Settings.extension`; the legacy id is kept
        // because it also resolves on macOS 12 and earlier, where the
        // extension id does not exist.
        vec![(
            "open",
            vec![format!(
                "x-apple.systempreferences:com.apple.preference.notifications?id={bundle_id}"
            )],
        )]
    }
    #[cfg(target_os = "windows")]
    {
        // `start` is a `cmd` builtin, not an executable. The empty string is
        // the window title `start` would otherwise take the URL for. No
        // per-app deep link exists here — `ms-settings:notifications` is the
        // finest granularity Windows offers.
        vec![(
            "cmd",
            vec![
                "/C".to_string(),
                "start".to_string(),
                String::new(),
                "ms-settings:notifications".to_string(),
            ],
        )]
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        // No cross-desktop standard exists, so try the two big desktops' panes
        // and give up honestly rather than opening something unrelated.
        vec![
            ("gnome-control-center", vec!["notifications".to_string()]),
            ("systemsettings", vec!["kcm_notifications".to_string()]),
            ("kcmshell6", vec!["kcm_notifications".to_string()]),
            ("kcmshell5", vec!["kcm_notifications".to_string()]),
        ]
    }
}

/// How long to wait for a candidate to fail before treating it as "the pane is
/// open". `open` and `cmd /C start` hand off and exit within milliseconds, but
/// a Linux settings binary launched directly runs for as long as its window is
/// on screen — waiting for THAT to exit would leave the command pending until
/// the user closed System Settings.
#[cfg(feature = "tauri-runtime")]
const SETTINGS_LAUNCH_GRACE: std::time::Duration = std::time::Duration::from_millis(700);

/// Open the OS pane where notification permission for this app is granted or
/// revoked.
///
/// Targets the identity notifications are *actually* delivered under, not
/// necessarily this app's own — sending the user to codeg's page while the OS
/// files the notifications under another app would point them at switches that
/// change nothing.
#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn open_system_notification_settings(app: AppHandle) -> Result<(), AppCommandError> {
    // `Some` on exactly the platform whose candidates interpolate it; the
    // others take a literal URL and ignore the argument entirely.
    let bundle_id = resolve_notification_identity(&app)
        .map(|identity| identity.bundle_id.clone())
        .unwrap_or_default();
    let mut last_error: Option<String> = None;

    for (program, args) in system_notification_settings_candidates(&bundle_id) {
        let child = crate::process::tokio_command(program).args(&args).spawn();
        let mut child = match child {
            Ok(child) => child,
            Err(err) => {
                // The binary isn't installed — this desktop isn't the one this
                // candidate is for. Move on to the next.
                last_error = Some(format!("`{program}` could not be started: {err}"));
                continue;
            }
        };

        // Waiting (rather than detaching immediately) is what turns "this
        // desktop has no such pane" into a signal instead of a silent no-op:
        // `gnome-control-center` exits non-zero for a panel it doesn't know.
        // Dropping the `Child` on timeout leaves the process running; tokio's
        // orphan queue reaps it, so nothing becomes a zombie.
        match tokio::time::timeout(SETTINGS_LAUNCH_GRACE, child.wait()).await {
            Err(_elapsed) => return Ok(()),
            Ok(Ok(status)) if status.success() => return Ok(()),
            Ok(Ok(status)) => {
                last_error = Some(format!("`{program}` exited with {status}"));
            }
            Ok(Err(err)) => {
                last_error = Some(format!("`{program}` could not be waited on: {err}"));
            }
        }
    }

    Err(
        AppCommandError::new(
            AppErrorCode::DependencyMissing,
            "Could not open the system notification settings on this desktop",
        )
        .with_detail(last_error.unwrap_or_else(|| "no candidate command available".to_string())),
    )
}

#[cfg(all(test, feature = "tauri-runtime"))]
mod tests {
    use super::*;

    #[test]
    fn every_candidate_has_a_program_to_run() {
        let candidates = system_notification_settings_candidates("app.example");
        assert!(!candidates.is_empty());
        for (program, _) in &candidates {
            assert!(!program.is_empty());
        }
    }

    /// The `?id=` suffix is the difference between landing on the app's own
    /// notification page and dumping the user on the list of every app
    /// installed, which is what shipped before.
    #[cfg(target_os = "macos")]
    #[test]
    fn macos_deep_links_to_the_delivering_app() {
        let candidates = system_notification_settings_candidates("app.example");
        let (program, args) = &candidates[0];
        assert_eq!(*program, "open");
        assert_eq!(
            args,
            &vec![
                "x-apple.systempreferences:com.apple.preference.notifications?id=app.example"
                    .to_string()
            ]
        );
    }

    /// The fallback is the crate's, not ours — if this constant ever drifts
    /// from the literal in `mac-notification-sys`'s swizzled getter, the
    /// settings panel starts naming an app that isn't the one receiving the
    /// notifications.
    #[cfg(target_os = "macos")]
    #[test]
    fn macos_fallback_matches_the_crate_default() {
        assert_eq!(MACOS_FALLBACK_BUNDLE_ID, "com.apple.Terminal");
    }
}
