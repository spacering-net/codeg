//! The two secrets config sync owns, kept out of the settings row.
//!
//! The WebDAV password and the (optional) snapshot passphrase used to live in
//! the same `app_metadata` JSON blob as the rest of the settings — plaintext in
//! the SQLite file, and therefore inside every backup archive that file is
//! packed into. Neither is portable and neither belongs to a snapshot, so they
//! go where this codebase already puts device-local credentials: the OS keyring
//! on desktop, the `0600` token store on a server ([`crate::keyring_store`]).
//!
//! Failures are surfaced, never swallowed. A password that silently failed to
//! save would present as "the server rejected your credentials" at the next
//! tick, minutes later and nowhere near the action that caused it.

use crate::app_error::AppCommandError;

/// Keyring entry names. Stable: renaming one orphans the stored secret.
pub const WEBDAV_PASSWORD: &str = "config-sync-webdav-password";
pub const SNAPSHOT_PASSPHRASE: &str = "config-sync-snapshot-passphrase";

/// Missing and unreadable collapse to "no secret". That is right for a caller
/// about to USE the secret — the next step, ask the user to type it again, is
/// the same either way — and wrong for one about to write anything back, which
/// must call [`read`] instead.
pub fn load(name: &str) -> String {
    read(name).ok().flatten().unwrap_or_default()
}

/// `Ok(None)` is "nothing stored"; `Err` is "the store would not open".
///
/// Keeping the two apart is what lets the save path write only the secrets it
/// was actually given: a value that reads back as `""` because the store could
/// not be opened must never travel out again as "delete this entry". See
/// `webdav_sync::save_settings_core`.
pub fn read(name: &str) -> Result<Option<String>, AppCommandError> {
    store::get(name).map_err(|e| {
        AppCommandError::io_error("Failed to read the config sync credentials")
            .with_detail(e)
            .with_i18n(
                crate::app_error::CONFIG_SYNC_I18N_KEY_CREDENTIALS_UNREADABLE,
                std::collections::BTreeMap::new(),
            )
    })
}

/// Stores, or removes the entry entirely when `value` is empty, so "cleared"
/// and "never set" stay the same state.
pub fn store(name: &str, value: &str) -> Result<(), AppCommandError> {
    let result = if value.is_empty() {
        store::delete(name)
    } else {
        store::set(name, value)
    };
    result.map_err(|e| {
        AppCommandError::io_error("Failed to store the config sync credential").with_detail(e)
    })
}

#[cfg(not(test))]
mod store {
    pub fn get(name: &str) -> Result<Option<String>, String> {
        crate::keyring_store::get_secret(name)
    }
    pub fn set(name: &str, value: &str) -> Result<(), String> {
        crate::keyring_store::set_secret(name, value)
    }
    pub fn delete(name: &str) -> Result<(), String> {
        crate::keyring_store::delete_secret(name)
    }
}

/// Tests must never reach the developer's real login keychain (macOS would
/// prompt, CI has none), so the test build swaps in a process-local map. The
/// keyring itself is third-party and not what these tests are about; what they
/// exercise is that the settings path stores and reads secrets *somewhere other
/// than the settings row*.
#[cfg(test)]
mod store {
    use std::collections::HashMap;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Mutex, OnceLock};

    fn map() -> &'static Mutex<HashMap<String, String>> {
        static MAP: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
        MAP.get_or_init(|| Mutex::new(HashMap::new()))
    }

    /// Stands in for a denied keychain prompt or an unreadable `tokens.json`,
    /// the one failure the in-process map cannot produce on its own.
    static UNREADABLE: AtomicBool = AtomicBool::new(false);

    pub fn set_unreadable(unreadable: bool) {
        UNREADABLE.store(unreadable, Ordering::SeqCst);
    }

    pub fn get(name: &str) -> Result<Option<String>, String> {
        if UNREADABLE.load(Ordering::SeqCst) {
            return Err("simulated keyring read failure".to_string());
        }
        Ok(map().lock().expect("credential map").get(name).cloned())
    }
    pub fn set(name: &str, value: &str) -> Result<(), String> {
        map()
            .lock()
            .expect("credential map")
            .insert(name.to_string(), value.to_string());
        Ok(())
    }
    pub fn delete(name: &str) -> Result<(), String> {
        map().lock().expect("credential map").remove(name);
        Ok(())
    }
}

/// The secret store is process-global by nature, so two tests that both save
/// settings would overwrite each other's password. Any test that goes through
/// [`store`] must hold this for its duration.
///
/// A `tokio` mutex rather than a `std` one because almost every holder is an
/// async test that awaits a database while holding it, which `std`'s guard is
/// not allowed to do. It also has no poisoning, so one failing test cannot
/// cascade into the rest of the file.
#[cfg(test)]
fn guard_lock() -> &'static tokio::sync::Mutex<()> {
    static GUARD: std::sync::OnceLock<tokio::sync::Mutex<()>> = std::sync::OnceLock::new();
    GUARD.get_or_init(|| tokio::sync::Mutex::new(()))
}

#[cfg(test)]
pub async fn test_guard() -> tokio::sync::MutexGuard<'static, ()> {
    guard_lock().lock().await
}

/// For the plain `#[test]` cases in this module, which have no runtime to
/// await on.
#[cfg(test)]
pub fn test_guard_blocking() -> tokio::sync::MutexGuard<'static, ()> {
    guard_lock().blocking_lock()
}

/// Make every read fail for as long as the returned value is alive. RAII so a
/// failing assertion cannot leave the flag set and redden every later test.
#[cfg(test)]
pub fn unreadable_store() -> UnreadableStore {
    store::set_unreadable(true);
    UnreadableStore
}

#[cfg(test)]
pub struct UnreadableStore;

#[cfg(test)]
impl Drop for UnreadableStore {
    fn drop(&mut self) {
        store::set_unreadable(false);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The distinction the whole save path rests on: a store that will not open
    /// must not look like a store with nothing in it, because "nothing in it"
    /// travels back out as a deletion.
    #[test]
    fn an_unreadable_store_is_not_an_empty_one() {
        let _guard = test_guard_blocking();
        store(WEBDAV_PASSWORD, "app-password").expect("store");
        assert_eq!(
            read(WEBDAV_PASSWORD).expect("readable"),
            Some("app-password".into())
        );
        // Absent reads as absent, not as a failure — that is what lets a fresh
        // install, and a server with no token file yet, save at all.
        assert_eq!(read(SNAPSHOT_PASSPHRASE).expect("readable"), None);

        {
            let _unreadable = unreadable_store();
            assert!(
                read(WEBDAV_PASSWORD).is_err(),
                "a failed read must not read as absent"
            );
            // `load` still collapses the two on purpose: its callers are about
            // to ask the user for the secret either way.
            assert_eq!(load(WEBDAV_PASSWORD), "");
        }

        assert!(read(WEBDAV_PASSWORD).is_ok(), "the guard must restore the store");
        store(WEBDAV_PASSWORD, "").expect("clean up");
    }

    #[test]
    fn a_secret_round_trips_and_clearing_removes_it() {
        let _guard = test_guard_blocking();
        store(WEBDAV_PASSWORD, "app-password").expect("store");
        assert_eq!(load(WEBDAV_PASSWORD), "app-password");

        // Empty is "gone", not "stored as an empty string" — the difference the
        // `hasPassword` flag in the settings view is computed from.
        store(WEBDAV_PASSWORD, "").expect("clear");
        assert_eq!(load(WEBDAV_PASSWORD), "");
    }

    #[test]
    fn the_two_secrets_do_not_share_an_entry() {
        let _guard = test_guard_blocking();
        store(WEBDAV_PASSWORD, "password").expect("store");
        store(SNAPSHOT_PASSPHRASE, "passphrase").expect("store");
        assert_eq!(load(WEBDAV_PASSWORD), "password");
        assert_eq!(load(SNAPSHOT_PASSPHRASE), "passphrase");
        store(WEBDAV_PASSWORD, "").expect("clear");
        assert_eq!(load(SNAPSHOT_PASSPHRASE), "passphrase");
        store(SNAPSHOT_PASSPHRASE, "").expect("clear");
    }
}
