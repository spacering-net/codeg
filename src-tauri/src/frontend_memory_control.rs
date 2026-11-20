//! Opt-in RAM-only experiment controls. No application data or persistent log.
use std::collections::BTreeMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::app_error::AppCommandError;
use crate::web::event_bridge::{emit_event, EventEmitter};

pub const CONTROL_EVENT: &str = "frontend-memory://control";
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
const MAX_REPORTERS: usize = 16;
const TTL: Duration = Duration::from_secs(300);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FrontendMemoryControl {
    pub epoch: u64,
    pub reporting_enabled: bool,
    pub browser_counters_enabled: bool,
    pub sample_sequence: u64,
}

impl Default for FrontendMemoryControl {
    fn default() -> Self {
        Self {
            epoch: 0,
            reporting_enabled: true,
            browser_counters_enabled: true,
            sample_sequence: 0,
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SetFrontendMemoryControl {
    pub reporting_enabled: bool,
    pub browser_counters_enabled: bool,
    #[serde(default)]
    pub sample_once: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FrontendMemoryControlAck {
    pub reporter_id: String,
    pub epoch: u64,
    pub reporting_enabled: bool,
    pub browser_counters_enabled: bool,
    pub sample_sequence: u64,
    pub applied_at_ms: u64,
    /// Epoch and start time of the last successful explicit sample. A later
    /// mode change must not relabel that sample as taken under the new mode.
    pub sampled_epoch: u64,
    pub sample_started_at_ms: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReceivedControlAck {
    #[serde(flatten)]
    pub ack: FrontendMemoryControlAck,
    pub received_at_ms: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FrontendMemoryControlSnapshot {
    pub enabled: bool,
    pub control: Option<FrontendMemoryControl>,
    pub acknowledgements: Vec<ReceivedControlAck>,
}

#[derive(Default)]
struct Store {
    control: FrontendMemoryControl,
    acknowledgements: BTreeMap<String, (Instant, ReceivedControlAck)>,
}

fn invalid(message: &str) -> AppCommandError {
    AppCommandError::invalid_input(message)
}

impl Store {
    fn set(
        &mut self,
        request: SetFrontendMemoryControl,
    ) -> Result<FrontendMemoryControl, AppCommandError> {
        let next = FrontendMemoryControl {
            epoch: self
                .control
                .epoch
                .checked_add(1)
                .filter(|n| *n <= MAX_SAFE_INTEGER)
                .ok_or_else(|| invalid("Diagnostic control epoch exhausted"))?,
            reporting_enabled: request.reporting_enabled,
            browser_counters_enabled: request.browser_counters_enabled,
            sample_sequence: self.control.sample_sequence + u64::from(request.sample_once),
        };
        // sample_sequence <= epoch: one increment at most per accepted setter.
        self.control = next;
        Ok(next)
    }

    fn prune(&mut self, now: Instant) {
        self.acknowledgements
            .retain(|_, (seen, _)| now.saturating_duration_since(*seen) < TTL);
    }

    fn acknowledge(
        &mut self,
        ack: FrontendMemoryControlAck,
        now: Instant,
        wall_ms: u64,
    ) -> Result<(), AppCommandError> {
        if ack.reporter_id.len() != 36
            || uuid::Uuid::parse_str(&ack.reporter_id).is_err()
            || ack.applied_at_ms > MAX_SAFE_INTEGER
            || ack.sample_started_at_ms > MAX_SAFE_INTEGER
            || ack.sample_started_at_ms > ack.applied_at_ms
            || ack.sampled_epoch > ack.epoch
            || ack.sampled_epoch < ack.sample_sequence
            || (ack.sample_sequence == 0
                && (ack.sampled_epoch != 0 || ack.sample_started_at_ms != 0))
            || ack.epoch != self.control.epoch
            || ack.reporting_enabled != self.control.reporting_enabled
            || ack.browser_counters_enabled != self.control.browser_counters_enabled
            || ack.sample_sequence != self.control.sample_sequence
        {
            return Err(invalid("Invalid or obsolete diagnostic acknowledgement"));
        }
        self.prune(now);
        if !self.acknowledgements.contains_key(&ack.reporter_id)
            && self.acknowledgements.len() >= MAX_REPORTERS
        {
            if let Some(oldest) = self
                .acknowledgements
                .iter()
                .min_by_key(|(_, (seen, _))| *seen)
                .map(|(key, _)| key.clone())
            {
                self.acknowledgements.remove(&oldest);
            }
        }
        self.acknowledgements.insert(
            ack.reporter_id.clone(),
            (
                now,
                ReceivedControlAck {
                    ack,
                    received_at_ms: wall_ms,
                },
            ),
        );
        Ok(())
    }
}

static STORE: OnceLock<Mutex<Store>> = OnceLock::new();

fn enabled() -> Result<(), AppCommandError> {
    if cfg!(feature = "memory-diagnostics") {
        Ok(())
    } else {
        Err(invalid(
            "Frontend memory diagnostics are disabled in this build",
        ))
    }
}

fn store() -> &'static Mutex<Store> {
    STORE.get_or_init(|| Mutex::new(Store::default()))
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub fn get_frontend_memory_control() -> Result<FrontendMemoryControl, AppCommandError> {
    enabled()?;
    Ok(store().lock().unwrap_or_else(|e| e.into_inner()).control)
}

pub fn set_frontend_memory_control_core(
    emitter: &EventEmitter,
    request: SetFrontendMemoryControl,
) -> Result<FrontendMemoryControl, AppCommandError> {
    enabled()?;
    let control = store()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .set(request)?;
    // Emit outside the lock. Concurrent emits can arrive out of order; renderers
    // discard stale epochs and backend acknowledgements require the latest.
    emit_event(emitter, CONTROL_EVENT, control);
    Ok(control)
}

#[cfg(feature = "tauri-runtime")]
#[tauri::command]
pub fn set_frontend_memory_control(
    state: tauri::State<'_, std::sync::Arc<crate::app_state::AppState>>,
    request: SetFrontendMemoryControl,
) -> Result<FrontendMemoryControl, AppCommandError> {
    set_frontend_memory_control_core(&state.emitter, request)
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub fn ack_frontend_memory_control(ack: FrontendMemoryControlAck) -> Result<(), AppCommandError> {
    enabled()?;
    let wall_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u64::MAX as u128) as u64;
    store()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .acknowledge(ack, Instant::now(), wall_ms)
}

pub fn frontend_memory_control_snapshot() -> FrontendMemoryControlSnapshot {
    let enabled = cfg!(feature = "memory-diagnostics");
    let (control, acknowledgements) = if enabled {
        let mut store = store().lock().unwrap_or_else(|e| e.into_inner());
        store.prune(Instant::now());
        (
            Some(store.control),
            store
                .acknowledgements
                .values()
                .map(|(_, ack)| ack.clone())
                .collect(),
        )
    } else {
        (None, Vec::new())
    };
    FrontendMemoryControlSnapshot {
        enabled,
        control,
        acknowledgements,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(sample_once: bool) -> SetFrontendMemoryControl {
        SetFrontendMemoryControl {
            reporting_enabled: false,
            browser_counters_enabled: false,
            sample_once,
        }
    }

    fn ack(control: FrontendMemoryControl, serial: u64) -> FrontendMemoryControlAck {
        FrontendMemoryControlAck {
            reporter_id: uuid::Uuid::from_u128(serial as u128).to_string(),
            epoch: control.epoch,
            reporting_enabled: control.reporting_enabled,
            browser_counters_enabled: control.browser_counters_enabled,
            sample_sequence: control.sample_sequence,
            applied_at_ms: 1234,
            sampled_epoch: if control.sample_sequence == 0 {
                0
            } else {
                control.epoch
            },
            sample_started_at_ms: if control.sample_sequence == 0 {
                0
            } else {
                1230
            },
        }
    }

    #[test]
    fn assigns_safe_monotonic_epochs_and_explicit_sample_sequences() {
        let mut store = Store::default();
        assert_eq!(store.control, FrontendMemoryControl::default());
        assert_eq!(store.set(request(false)).unwrap().epoch, 1);
        let control = store.set(request(true)).unwrap();
        assert_eq!((control.epoch, control.sample_sequence), (2, 1));
        store.control.epoch = MAX_SAFE_INTEGER;
        assert!(store.set(request(true)).is_err());
        assert_eq!(store.control.sample_sequence, 1);
    }

    #[test]
    fn rejects_stale_mismatched_and_non_numeric_acknowledgements() {
        let mut store = Store::default();
        let now = Instant::now();
        let old = store.set(request(false)).unwrap();
        let current = store.set(request(true)).unwrap();
        assert!(store.acknowledge(ack(old, 1), now, 1).is_err());
        for field in 0..6 {
            let mut bad = ack(current, 1);
            match field {
                0 => bad.reporter_id = "/private/path".to_owned(),
                1 => bad.reporting_enabled = true,
                2 => bad.browser_counters_enabled = true,
                3 => bad.applied_at_ms = MAX_SAFE_INTEGER + 1,
                4 => bad.sample_sequence += 1,
                _ => bad.sampled_epoch = current.epoch + 1,
            }
            assert!(store.acknowledge(bad, now, 1).is_err());
        }
        assert!(store.acknowledgements.is_empty());
        store.acknowledge(ack(current, 1), now, 1235).unwrap();
        assert_eq!(store.acknowledgements.len(), 1);
    }

    #[test]
    fn bounds_latest_acknowledgements_and_expires_without_wall_clock() {
        let mut store = Store::default();
        let now = Instant::now();
        for serial in 1..=20 {
            store
                .acknowledge(
                    ack(store.control, serial),
                    now + Duration::from_secs(serial),
                    u64::MAX,
                )
                .unwrap();
        }
        assert_eq!(store.acknowledgements.len(), MAX_REPORTERS);
        assert!(!store
            .acknowledgements
            .contains_key(&uuid::Uuid::from_u128(1).to_string()));
        store.prune(now + TTL + Duration::from_secs(20));
        assert!(store.acknowledgements.is_empty());
    }

    #[test]
    fn rejects_payload_fields_and_non_boolean_requests() {
        for text in [
            r#"{"reportingEnabled":false,"browserCountersEnabled":false,"payload":"private"}"#,
            r#"{"reportingEnabled":0,"browserCountersEnabled":false}"#,
            r#"{"reportingEnabled":false,"browserCountersEnabled":false,"epoch":3}"#,
        ] {
            assert!(serde_json::from_str::<SetFrontendMemoryControl>(text).is_err());
        }
    }

    #[cfg(not(feature = "memory-diagnostics"))]
    #[test]
    fn disabled_build_allocates_no_control_store() {
        assert!(get_frontend_memory_control().is_err());
        assert!(set_frontend_memory_control_core(&EventEmitter::Noop, request(true)).is_err());
        assert!(ack_frontend_memory_control(ack(FrontendMemoryControl::default(), 1)).is_err());
        let snapshot = frontend_memory_control_snapshot();
        assert!(!snapshot.enabled);
        assert!(snapshot.control.is_none());
        assert!(snapshot.acknowledgements.is_empty());
        assert!(STORE.get().is_none());
    }
}
