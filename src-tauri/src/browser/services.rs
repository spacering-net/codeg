//! The local servers codeg has seen start, and telling the workspace about a
//! new one.
//!
//! `service_url` reads an address out of terminal output; everything here is
//! about whether that address is real and who should hear about it.
//!
//! **Why a probe at all.** A line of output is a claim, not a fact: `cat
//! README.md` prints `http://localhost:3000` just as convincingly as vite
//! does. Connecting to the socket is the cheapest way to tell the two apart,
//! and it is the same question VS Code's `process` port source answers by
//! enumerating listening sockets — which on macOS means polling `lsof` and on
//! Linux means walking `/proc/*/fd`, for an answer we only ever need about
//! one port at a time.
//!
//! **Why retries.** Servers print before they are ready often enough that a
//! single attempt at the moment the banner appears would miss them; four
//! attempts over ~2 s covers the gap without keeping a thread around.
//!
//! **What is NOT decided here.** Whether a tab opens is the workspace's call
//! (`browser:service-auto-open` lives in localStorage with the rest of the
//! browser preferences). The backend watches unconditionally, so the list in
//! the "+" menu is populated even for someone who has turned the notification
//! off — the cost is one loopback connect per address printed.

use std::collections::VecDeque;
use std::net::{TcpStream, ToSocketAddrs};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use super::service_url::{ServiceCandidate, ServiceScanner};
use super::types::{DetectedService, ServiceSource, SERVICE_DETECTED_EVENT};
use crate::web::event_bridge::{emit_event, EventEmitter};

/// How long one connection attempt waits. Loopback either answers at once or
/// refuses at once; this only has to cover a server mid-`accept` backlog.
const PROBE_TIMEOUT: Duration = Duration::from_millis(300);

/// When to try, in milliseconds after the address was printed.
const PROBE_SCHEDULE: [u64; 4] = [0, 250, 750, 1500];

/// Most services kept in the list. Far more than a workspace has; the cap is
/// here so a machine that prints addresses in a loop cannot grow it forever.
const MAX_SERVICES: usize = 64;

/// How many `(terminal, origin)` pairs are remembered as already announced.
/// Evicting one costs a repeat notification, nothing more.
const MAX_ANNOUNCED: usize = 128;

/// Most probes in flight at once, across every terminal.
///
/// Each holds a thread for up to ~2 s, so this is the bound on what output
/// full of addresses can cost. A candidate that arrives over the cap is
/// dropped rather than queued: the scanner will offer the address again after
/// its rate limit, and by then the flood is over.
const MAX_IN_FLIGHT_PROBES: usize = 8;

static IN_FLIGHT_PROBES: AtomicUsize = AtomicUsize::new(0);

/// The right to run one probe, given back when it ends (including by panic).
struct ProbeSlot;

impl ProbeSlot {
    fn take() -> Option<Self> {
        IN_FLIGHT_PROBES
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |held| {
                (held < MAX_IN_FLIGHT_PROBES).then_some(held + 1)
            })
            .ok()
            .map(|_| ProbeSlot)
    }
}

impl Drop for ProbeSlot {
    fn drop(&mut self) {
        IN_FLIGHT_PROBES.fetch_sub(1, Ordering::AcqRel);
    }
}

/// Whether anything is listening on `authority` (`host:port`).
///
/// Blocking. A name that resolves to several addresses (`localhost` is
/// usually both `127.0.0.1` and `::1`) counts as live if any of them answers:
/// that is exactly what a browser would find.
pub fn is_live(authority: &str) -> bool {
    let Ok(addrs) = authority.to_socket_addrs() else {
        return false;
    };
    for addr in addrs {
        if TcpStream::connect_timeout(&addr, PROBE_TIMEOUT).is_ok() {
            return true;
        }
    }
    false
}

/// Retry `is_live` on [`PROBE_SCHEDULE`]. Blocking for up to ~2 s.
fn wait_until_live(authority: &str) -> bool {
    let mut waited = 0_u64;
    for at in PROBE_SCHEDULE {
        if at > waited {
            std::thread::sleep(Duration::from_millis(at - waited));
            waited = at;
        }
        if is_live(authority) {
            return true;
        }
    }
    false
}

#[derive(Default)]
struct Inner {
    /// Live services, oldest first.
    entries: Vec<DetectedService>,
    /// `(terminal_id, origin)` pairs already announced.
    announced: VecDeque<(String, String)>,
}

/// What the workspace's "local services" list is read from.
#[derive(Default)]
pub struct ServiceRegistry {
    inner: Mutex<Inner>,
}

impl ServiceRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Take `service` into the list; answer whether its terminal has ever
    /// announced this origin before.
    ///
    /// `false` means "keep it in the list, but say nothing": a dev server
    /// that reprints its banner on every rebuild is the same service, and a
    /// notification per rebuild would be the feature's worst failure mode.
    /// A DIFFERENT terminal serving the same address is a new thing someone
    /// just started, and does get announced.
    pub fn record(&self, service: DetectedService) -> bool {
        let mut inner = self.lock();
        let key = (service.terminal_id.clone(), service.origin.clone());
        let fresh = !inner.announced.contains(&key);
        if fresh {
            inner.announced.push_back(key);
            while inner.announced.len() > MAX_ANNOUNCED {
                inner.announced.pop_front();
            }
        }
        // One entry per address per window: the same page in two windows is
        // two lists, and the same address twice in one is one service.
        if let Some(existing) = inner
            .entries
            .iter_mut()
            .find(|e| e.owner_window == service.owner_window && e.origin == service.origin)
        {
            *existing = service;
        } else {
            inner.entries.push(service);
            while inner.entries.len() > MAX_SERVICES {
                inner.entries.remove(0);
            }
        }
        fresh
    }

    /// Everything recorded for `owner_window`, newest last — without asking
    /// whether any of it is still running.
    pub fn list(&self, owner_window: &str) -> Vec<DetectedService> {
        self.lock()
            .entries
            .iter()
            .filter(|e| e.owner_window == owner_window)
            .cloned()
            .collect()
    }

    /// Forget `origins` in `owner_window`, unless the entry has been replaced
    /// by a newer record since it was read.
    fn forget(&self, owner_window: &str, dead: &[DetectedService]) {
        if dead.is_empty() {
            return;
        }
        let mut inner = self.lock();
        inner.entries.retain(|entry| {
            !dead.iter().any(|gone| {
                entry.owner_window == owner_window
                    && entry.origin == gone.origin
                    && entry.terminal_id == gone.terminal_id
            })
        });
    }

    /// The services of `owner_window` that still answer, dropping the ones
    /// that do not.
    ///
    /// Pruning on read is the whole liveness story: a server that dies takes
    /// its entry with it the next time someone opens the menu, and nothing
    /// has to watch for it in between. Blocking (one connect per entry, run
    /// in parallel) — call it from `spawn_blocking`.
    pub fn list_live(&self, owner_window: &str) -> Vec<DetectedService> {
        let candidates = self.list(owner_window);
        if candidates.is_empty() {
            return candidates;
        }
        let alive: Vec<bool> = std::thread::scope(|scope| {
            let handles: Vec<_> = candidates
                .iter()
                .map(|service| scope.spawn(move || is_live(&service.authority)))
                .collect();
            handles
                .into_iter()
                .map(|handle| handle.join().unwrap_or(false))
                .collect()
        });
        let (live, dead): (Vec<_>, Vec<_>) = candidates
            .into_iter()
            .zip(alive)
            .partition(|(_, alive)| *alive);
        self.forget(
            owner_window,
            &dead.into_iter().map(|(service, _)| service).collect::<Vec<_>>(),
        );
        live.into_iter().map(|(service, _)| service).collect()
    }
}

/// The registry for this process.
///
/// A singleton rather than managed state because both of its writers are deep
/// in code that has no handle to reach for: the PTY reader thread in
/// `terminal::manager`, and an ACP terminal's output task, which is built
/// inside `acp::connection` in both runtimes. The registry itself is an
/// ordinary struct so the rules above are unit-tested without it.
pub fn registry() -> &'static ServiceRegistry {
    static REGISTRY: OnceLock<ServiceRegistry> = OnceLock::new();
    REGISTRY.get_or_init(ServiceRegistry::new)
}

/// One terminal's connection to the watch: who to tell, and on whose behalf.
///
/// Cloned into each terminal that has one. `None` anywhere upstream means the
/// watch is simply not installed — the ACP runtime is built without one in
/// tests and in the delegation probe.
#[derive(Clone)]
pub struct ServiceWatch {
    emitter: EventEmitter,
    owner_window: String,
    source: ServiceSource,
}

impl ServiceWatch {
    pub fn new(emitter: EventEmitter, owner_window: String, source: ServiceSource) -> Self {
        Self {
            emitter,
            owner_window,
            source,
        }
    }

    /// Feed one chunk of output; probing and announcing happen on threads of
    /// their own.
    ///
    /// The caller is a reader loop: it must not wait on a socket. A chunk that
    /// contains no address costs a substring search and returns here.
    pub fn feed(&self, scanner: &mut ServiceScanner, chunk: &str, terminal_id: &str) {
        for candidate in scanner.feed(chunk, std::time::Instant::now()) {
            let Some(slot) = ProbeSlot::take() else {
                // Too many probes already waiting on sockets. Dropping the
                // candidate is safe: the scanner offers it again after its
                // rate limit, by which time the flood has passed.
                return;
            };
            let service = self.service(candidate, terminal_id);
            let emitter = self.emitter.clone();
            // Named so a thread dump during a probe says what it is waiting
            // on. A failed spawn drops the candidate (and gives the slot back
            // with it); the next banner tries again.
            let _ = std::thread::Builder::new()
                .name("svc-probe".to_string())
                .spawn(move || {
                    let _slot = slot;
                    announce(&emitter, service);
                });
        }
    }

    fn service(&self, candidate: ServiceCandidate, terminal_id: &str) -> DetectedService {
        DetectedService {
            url: candidate.url,
            origin: candidate.origin,
            authority: candidate.authority,
            owner_window: self.owner_window.clone(),
            source: self.source,
            terminal_id: terminal_id.to_string(),
        }
    }
}

/// Probe, record, and tell the workspace. Blocking for up to ~2 s.
fn announce(emitter: &EventEmitter, service: DetectedService) {
    if !wait_until_live(&service.authority) {
        // Nothing there. Deliberately NOT recorded: the address was printed
        // by something that is not serving it (a README, a log line about
        // another machine's setup), and the same terminal printing it again
        // after the real server comes up must get its chance.
        return;
    }
    tracing::debug!(
        "[SVC] detected {} from terminal {} ({:?})",
        service.origin,
        service.terminal_id,
        service.source
    );
    if !registry().record(service.clone()) {
        return;
    }
    emit_event(emitter, SERVICE_DETECTED_EVENT, service);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;

    fn service(origin: &str, terminal: &str, window: &str) -> DetectedService {
        DetectedService {
            url: format!("{origin}/"),
            origin: origin.to_string(),
            authority: origin.trim_start_matches("http://").to_string(),
            owner_window: window.to_string(),
            source: ServiceSource::Terminal,
            terminal_id: terminal.to_string(),
        }
    }

    #[test]
    fn a_port_with_a_listener_is_live_and_one_without_is_not() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let authority = format!("127.0.0.1:{}", listener.local_addr().unwrap().port());
        assert!(is_live(&authority));
        drop(listener);
        assert!(!is_live(&authority));
    }

    /// The banner of a watcher that rebuilds twenty times an hour is the same
    /// service every time.
    #[test]
    fn the_same_terminal_announces_an_origin_once() {
        let registry = ServiceRegistry::new();
        assert!(registry.record(service("http://localhost:3000", "t1", "main")));
        assert!(!registry.record(service("http://localhost:3000", "t1", "main")));
        assert_eq!(registry.list("main").len(), 1);
    }

    /// Someone starting a server in a second terminal did something new, and
    /// hears about it — but the list still has one entry for the address.
    #[test]
    fn another_terminal_on_the_same_address_is_announced_again() {
        let registry = ServiceRegistry::new();
        assert!(registry.record(service("http://localhost:3000", "t1", "main")));
        assert!(registry.record(service("http://localhost:3000", "t2", "main")));
        let listed = registry.list("main");
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].terminal_id, "t2");
    }

    #[test]
    fn the_list_is_per_window() {
        let registry = ServiceRegistry::new();
        registry.record(service("http://localhost:3000", "t1", "main"));
        registry.record(service("http://localhost:4000", "t2", "second"));
        assert_eq!(registry.list("main").len(), 1);
        assert_eq!(registry.list("second").len(), 1);
        assert!(registry.list("third").is_empty());
    }

    #[test]
    fn the_list_is_capped_and_drops_the_oldest() {
        let registry = ServiceRegistry::new();
        for port in 3000..3000 + MAX_SERVICES + 3 {
            registry.record(service(&format!("http://localhost:{port}"), "t1", "main"));
        }
        let listed = registry.list("main");
        assert_eq!(listed.len(), MAX_SERVICES);
        assert_eq!(listed[0].origin, format!("http://localhost:{}", 3003));
    }

    /// The whole liveness story: an entry whose server has gone is dropped by
    /// the read that finds it gone, and a live one survives.
    #[test]
    fn reading_the_list_drops_what_no_longer_answers() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let live_port = listener.local_addr().unwrap().port();
        let dead = TcpListener::bind("127.0.0.1:0").expect("bind");
        let dead_port = dead.local_addr().unwrap().port();
        drop(dead);

        let registry = ServiceRegistry::new();
        registry.record(service(&format!("http://127.0.0.1:{live_port}"), "t1", "main"));
        registry.record(service(&format!("http://127.0.0.1:{dead_port}"), "t2", "main"));

        let live = registry.list_live("main");
        assert_eq!(live.len(), 1);
        assert_eq!(live[0].origin, format!("http://127.0.0.1:{live_port}"));
        // Pruned from the registry itself, not just from this answer.
        assert_eq!(registry.list("main").len(), 1);
    }

    /// Output full of addresses must not turn into output full of threads,
    /// each parked on a socket for two seconds.
    #[test]
    fn probes_are_capped_and_the_cap_is_given_back() {
        let held: Vec<ProbeSlot> = (0..MAX_IN_FLIGHT_PROBES)
            .map(|_| ProbeSlot::take().expect("under the cap"))
            .collect();
        assert!(ProbeSlot::take().is_none(), "the cap is a cap");
        drop(held);
        assert!(
            ProbeSlot::take().is_some(),
            "a finished probe frees its slot"
        );
    }

    /// A probe that never succeeds leaves nothing behind, so the next banner
    /// from the same terminal is still a candidate.
    #[test]
    fn a_dead_address_is_not_recorded_by_announcing_it() {
        let dead = TcpListener::bind("127.0.0.1:0").expect("bind");
        let port = dead.local_addr().unwrap().port();
        drop(dead);
        announce(
            &EventEmitter::Noop,
            service(&format!("http://127.0.0.1:{port}"), "t1", "probe-window"),
        );
        assert!(registry().list("probe-window").is_empty());
    }
}
