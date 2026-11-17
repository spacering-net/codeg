//! Opt-in, process-wide app-command IPC indicators. No header values, command
//! names, callback IDs, arguments, replies, URLs or per-call history are read.
use serde::Serialize;

#[cfg(any(all(feature = "memory-diagnostics", feature = "tauri-runtime"), test))]
use std::sync::atomic::{AtomicU64, Ordering};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeIpcMemorySnapshot {
    pub calls_with_callback_header: u64,
    pub calls_without_callback_header: u64,
}

#[cfg(any(all(feature = "memory-diagnostics", feature = "tauri-runtime"), test))]
#[derive(Default)]
struct Counters {
    with_callback_header: AtomicU64,
    without_callback_header: AtomicU64,
}

#[cfg(any(all(feature = "memory-diagnostics", feature = "tauri-runtime"), test))]
impl Counters {
    const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

    fn record(&self, has_callback_header: bool) {
        let counter = if has_callback_header {
            &self.with_callback_header
        } else {
            &self.without_callback_header
        };
        let mut current = counter.load(Ordering::Relaxed);
        while current < Self::MAX_SAFE_INTEGER {
            match counter.compare_exchange_weak(
                current,
                current + 1,
                Ordering::Relaxed,
                Ordering::Relaxed,
            ) {
                Ok(_) => break,
                Err(value) => current = value,
            }
        }
    }

    fn snapshot(&self) -> NativeIpcMemorySnapshot {
        NativeIpcMemorySnapshot {
            calls_with_callback_header: self.with_callback_header.load(Ordering::Relaxed),
            calls_without_callback_header: self.without_callback_header.load(Ordering::Relaxed),
        }
    }
}

#[cfg(all(feature = "memory-diagnostics", feature = "tauri-runtime"))]
static COUNTERS: Counters = Counters {
    with_callback_header: AtomicU64::new(0),
    without_callback_header: AtomicU64::new(0),
};

pub fn snapshot() -> Option<NativeIpcMemorySnapshot> {
    #[cfg(all(feature = "memory-diagnostics", feature = "tauri-runtime"))]
    {
        Some(COUNTERS.snapshot())
    }
    #[cfg(not(all(feature = "memory-diagnostics", feature = "tauri-runtime")))]
    {
        None
    }
}

/// Tauri's standard custom-protocol request includes Tauri-Callback in its
/// native headers; the standard postMessage path forwards options.headers.
/// This counts that indicator, not an authoritative transport enum: callers
/// supplying custom headers can affect it. Core/plugin commands bypass this
/// app-command handler. HTTP readers of the snapshot do not increment it.
#[cfg(feature = "tauri-runtime")]
pub(crate) fn with_counters<R, F>(
    handler: F,
) -> impl Fn(tauri::ipc::Invoke<R>) -> bool + Send + Sync + 'static
where
    R: tauri::Runtime,
    F: Fn(tauri::ipc::Invoke<R>) -> bool + Send + Sync + 'static,
{
    #[cfg(feature = "memory-diagnostics")]
    {
        move |invoke| {
            COUNTERS.record(invoke.message.headers().contains_key("tauri-callback"));
            handler(invoke)
        }
    }
    #[cfg(not(feature = "memory-diagnostics"))]
    {
        handler
    }
}

// Keep the existing command list verbatim; only its generated handler is
// wrapped. Disabled builds return the original handler without a wrapper.
#[cfg(feature = "tauri-runtime")]
macro_rules! generate_handler {
    ($($command:path),* $(,)?) => {
        $crate::native_ipc_memory::with_counters(tauri::generate_handler![$($command),*])
    };
}

#[cfg(feature = "tauri-runtime")]
pub(crate) use generate_handler;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn partitions_calls_without_retaining_request_data() {
        let counters = Counters::default();
        for _ in 0..7 {
            counters.record(true);
        }
        for _ in 0..3 {
            counters.record(false);
        }
        let value = serde_json::to_value(counters.snapshot()).unwrap();
        assert_eq!(
            value,
            serde_json::json!({
                "callsWithCallbackHeader": 7,
                "callsWithoutCallbackHeader": 3,
            })
        );
    }

    #[test]
    fn saturates_within_json_integer_range() {
        let counters = Counters::default();
        counters
            .with_callback_header
            .store(Counters::MAX_SAFE_INTEGER - 1, Ordering::Relaxed);
        counters
            .without_callback_header
            .store(Counters::MAX_SAFE_INTEGER, Ordering::Relaxed);
        counters.record(true);
        counters.record(true);
        counters.record(false);
        let value = counters.snapshot();
        assert_eq!(value.calls_with_callback_header, Counters::MAX_SAFE_INTEGER);
        assert_eq!(
            value.calls_without_callback_header,
            Counters::MAX_SAFE_INTEGER
        );
    }

    #[test]
    fn snapshot_exposure_matches_build_feature() {
        assert_eq!(
            snapshot().is_some(),
            cfg!(all(
                feature = "memory-diagnostics",
                feature = "tauri-runtime"
            ))
        );
    }
}
