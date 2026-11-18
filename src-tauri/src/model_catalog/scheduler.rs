//! Keeps the model catalog cache current in the background.
//!
//! One loop per process, started by the desktop setup and by codeg-server. It
//! reads the settings on every tick, so turning auto-update off takes effect
//! without a restart. A stale cache is refreshed; a fresh one is left alone.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use sea_orm::DatabaseConnection;

use crate::web::event_bridge::{emit_event, EventEmitter};

use super::{
    cache_is_fresh, load_settings, resolve, CatalogStatus, MODEL_CATALOG_REFRESHED_EVENT,
};

/// Let the app finish starting before the first fetch.
const FIRST_WAKE: Duration = Duration::from_secs(60);
/// How often the loop re-checks the switch and the cache age.
const IDLE_INTERVAL: Duration = Duration::from_secs(60 * 60);
/// After 1, 2, 3, 4+ failures in a row, the next try waits this many minutes.
const BACKOFF_MINUTES: [u64; 4] = [5, 30, 120, 360];

fn backoff(failures: u32) -> Duration {
    let step = (failures.max(1) as usize - 1).min(BACKOFF_MINUTES.len() - 1);
    Duration::from_secs(BACKOFF_MINUTES[step] * 60)
}

pub async fn run_loop(conn: DatabaseConnection, data_dir: PathBuf, emitter: Arc<EventEmitter>) {
    tokio::time::sleep(FIRST_WAKE).await;
    let mut failures: u32 = 0;
    loop {
        let settings = match load_settings(&conn).await {
            Ok(settings) => settings,
            Err(err) => {
                tracing::warn!("[model-catalog] failed to read settings: {}", err.message);
                tokio::time::sleep(backoff(failures + 1)).await;
                failures = failures.saturating_add(1);
                continue;
            }
        };
        if !settings.auto_update || cache_is_fresh(&data_dir) {
            tokio::time::sleep(IDLE_INTERVAL).await;
            continue;
        }

        let resolved = resolve(&data_dir, &settings.url, false).await;
        let status = CatalogStatus {
            url: settings.url.clone(),
            auto_update: settings.auto_update,
            entry_count: resolved.file.entries.len(),
            updated_at: (resolved.file.fetched_at > 0).then_some(resolved.file.fetched_at),
            source: resolved.source.as_str().to_string(),
            error: resolved.error.clone(),
        };
        if let Some(error) = resolved.error {
            failures = failures.saturating_add(1);
            tracing::warn!(
                "[model-catalog] refresh failed ({} in a row): {}",
                failures,
                error
            );
            tokio::time::sleep(backoff(failures)).await;
        } else {
            failures = 0;
            emit_event(&emitter, MODEL_CATALOG_REFRESHED_EVENT, &status);
            tokio::time::sleep(IDLE_INTERVAL).await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backoff_grows_then_caps() {
        assert_eq!(backoff(0), Duration::from_secs(5 * 60));
        assert_eq!(backoff(1), Duration::from_secs(5 * 60));
        assert_eq!(backoff(2), Duration::from_secs(30 * 60));
        assert_eq!(backoff(3), Duration::from_secs(120 * 60));
        assert_eq!(backoff(4), Duration::from_secs(360 * 60));
        assert_eq!(backoff(40), Duration::from_secs(360 * 60));
    }
}
