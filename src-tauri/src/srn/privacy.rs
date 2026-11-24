//! Local privacy preference for SpaceRing account and catalog requests.
use std::io;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use tokio::sync::{RwLock, RwLockReadGuard};

pub const SWITCH_ENV: &str = "CODEG_SRN";
const MARKER: &str = "spacering-offline";

#[derive(Debug, Clone, Copy, serde::Serialize)]
pub struct OnlineSettings {
    pub enabled: bool,
    pub managed: bool,
}

fn marker() -> PathBuf {
    #[cfg(not(test))]
    let fallback = crate::paths::codeg_home_dir();
    #[cfg(test)]
    let fallback = std::env::temp_dir().join(format!("codeg-srn-policy-{}", std::process::id()));
    crate::paths::resolve_effective_data_dir(&fallback).join(MARKER)
}

fn policy(path: &Path, operator: Option<&str>) -> OnlineSettings {
    let managed = !crate::harness::enabled_by(operator);
    // Only an absent marker permits network access. An unreadable preference
    // must not silently re-enable outgoing requests.
    let allowed =
        matches!(std::fs::symlink_metadata(path), Err(e) if e.kind() == io::ErrorKind::NotFound);
    OnlineSettings {
        enabled: !managed && allowed,
        managed,
    }
}

pub(crate) fn settings() -> OnlineSettings {
    policy(&marker(), std::env::var(SWITCH_ENV).ok().as_deref())
}

pub(crate) fn enabled() -> bool {
    settings().enabled
}

fn gate() -> &'static RwLock<()> {
    static GATE: OnceLock<RwLock<()>> = OnceLock::new();
    GATE.get_or_init(RwLock::default)
}

/// Held until the HTTP response is read. Saving the preference waits for
/// earlier requests in this process before confirming that access is off.
pub(crate) async fn request() -> Option<RwLockReadGuard<'static, ()>> {
    let guard = gate().read().await;
    enabled().then_some(guard)
}

#[cfg(any(feature = "tauri-runtime", test))]
fn write_choice(path: &Path, enable: bool) -> io::Result<()> {
    if enable {
        return match std::fs::remove_file(path) {
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
            other => other,
        };
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    match std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
    {
        Ok(file) => file.sync_all(),
        Err(e) if e.kind() == io::ErrorKind::AlreadyExists => Ok(()),
        Err(e) => Err(e),
    }
}

#[cfg(feature = "tauri-runtime")]
pub(crate) async fn set(enable: bool) -> Result<OnlineSettings, crate::app_error::AppCommandError> {
    let _guard = gate().write().await;
    let path = marker();
    let operator = std::env::var(SWITCH_ENV).ok();
    let current = policy(&path, operator.as_deref());
    if current.managed {
        return Err(crate::app_error::AppCommandError::configuration_invalid(
            "SpaceRing is disabled by CODEG_SRN.",
        ));
    }
    write_choice(&path, enable).map_err(crate::app_error::AppCommandError::io)?;
    Ok(policy(&path, operator.as_deref()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_saved_choice_survives_reopening_and_an_operator_can_keep_it_off() {
        let dir = tempfile::tempdir().unwrap();
        let marker = dir.path().join("data").join(MARKER);
        assert!(policy(&marker, None).enabled);
        write_choice(&marker, false).unwrap();
        write_choice(&marker, false).unwrap();
        assert!(!policy(&marker, None).enabled);
        write_choice(&marker, true).unwrap();
        assert!(policy(&marker, None).enabled);
        let forced = policy(&marker, Some("OFF"));
        assert!(forced.managed && !forced.enabled);
    }
}
