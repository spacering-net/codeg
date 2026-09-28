//! Subscriber construction and per-binary initialization.
//!
//! Initialization is split into phases because the subscriber must be live as
//! early as possible (to capture startup diagnostics) but the persisted level
//! needs the database and the live-tail emitter needs `AppState`:
//!
//! 1. **Phase 1** — [`init_desktop`] / [`init_server`] / [`init_mcp`], called
//!    as the first statement in each binary's entry point. Resolves the logs
//!    dir from env (pure, no DB), installs the subscriber + [`crate::logging::
//!    hub::LogHub`], and returns a [`LogGuard`] the caller holds for the
//!    process lifetime so buffered file lines flush on a graceful exit.
//! 2. **Phase 2** — [`apply_persisted_level`], once the DB is open: overrides
//!    the default level from the `logging.level` KV value (unless `CODEG_LOG` /
//!    `RUST_LOG` is set, which wins).
//! 3. **Phase 3** — `LogHub::set_emitter`, once `AppState` exists: starts
//!    `logs://appended` delivery to the viewer.

use std::path::Path;

use tracing_appender::non_blocking::{NonBlocking, WorkerGuard};
use tracing_appender::rolling::Rotation;
use tracing_subscriber::filter::filter_fn;
use tracing_subscriber::{fmt, prelude::*, reload, EnvFilter, Registry};

use crate::logging::budget::{self, BudgetedWriter};
use crate::logging::hub::LogHub;
use crate::logging::layer::BufferEmitLayer;
use crate::logging::{LogLevel, LogSettings, LOGGING_LEVEL_KEY};

/// Reload handle stored in [`LogHub`]. The wrapped `EnvFilter` is applied as a
/// global filter on the registry, so swapping it changes the level for all
/// three sinks (stderr, file, buffer) at once. The second type parameter is
/// `Registry` because the reload layer is the first layer added — boxing later
/// layers is therefore unnecessary.
pub type ReloadHandle = reload::Handle<EnvFilter, Registry>;

/// Holds the non-blocking appender's `WorkerGuard`. Bind it in `main` (or the
/// desktop `run()`); dropping it flushes and shuts down the writer thread.
#[must_use = "hold the guard for the process lifetime so buffered logs flush on exit"]
pub struct LogGuard {
    _guard: Option<WorkerGuard>,
}

/// Standing per-target ceilings applied to EVERY constructed filter — the
/// default/configured level, a persisted level, AND an explicit `RUST_LOG` /
/// `CODEG_LOG` override. Each entry is the MOST VERBOSE level that target may
/// ever reach; see [`clamped_backstops`] for why that is a ceiling rather than a
/// pin.
///
/// - `kill_tree` → `Warn` — the `kill_tree` crate emits one DEBUG line per
///   inspected PID (~1500 on macOS, mostly EPERM on SIP-protected processes) on
///   every `kill_tree()` call. Under a global `debug` level that firehose grew a
///   server's log file to 217GB. We never want it: real kill failures are
///   already surfaced at our own call sites via `error!`. Clamped here so even
///   `RUST_LOG=debug` can't re-open it.
/// - `agent_client_protocol` → `Warn` — the ACP transport logs **every
///   JSON-RPC message in full**, several times per message: the transport and
///   outgoing actors TRACE each serialized line, and the incoming actor TRACEs
///   the parsed message again on every handler attempt it makes. Agent traffic
///   is the largest data stream in the process (reply text, file contents, tool
///   output), so at `debug` / `trace` this multiplies it several-fold onto disk
///   — the shape behind the 34GB-in-8.8h field report on 0.23.3 (issue #427,
///   when this crate was still called `sacp`). It also carries one **INFO**
///   line per unhandled request (`incoming_actor` "Rejecting request with error,
///   no handler") on the per-message hot path at the DEFAULT level. codeg keeps
///   its own throttled account of dropped / unclaimed messages
///   (`maybe_emit_ext_notification`, `TurnOutputProbe`), so none of that is
///   load-bearing.
///
///   `Warn` — not lower — because the crate's `warn!` sites are the actionable
///   transport faults ("Sending error response", "Transport parse error", a
///   handler that errored). Several of those are ALSO per-message under a
///   misbehaving agent, so this ceiling does not by itself bound the crate's
///   output; it removes the payload dumps and the INFO line, and
///   [`crate::logging::budget`] bounds whatever is left.
///
///   Protocol-level debugging stays reachable: a MORE SPECIFIC target beats a
///   crate-level ceiling, so setting `CODEG_LOG` to
///   `info,agent_client_protocol::jsonrpc::transport_actor=trace` still dumps
///   the wire.
/// - `tungstenite` → `Debug` — `handshake/client.rs` TRACEs the serialized
///   handshake **in full**: `trace!("Request: {:?}", …)` over the raw request
///   bytes. For a remote workspace connection that request carries the
///   connection's credentials — the bearer token (which travels as a
///   `Sec-WebSocket-Protocol` value) and every custom header the user
///   configured, which for the case the feature exists to serve is a Cloudflare
///   Access service token. `HeaderValue::set_sensitive` does not help: that
///   only governs HTTP/2 HPACK indexing and the `Debug` of the value itself,
///   and this line formats bytes tungstenite has already written out. So a user
///   who raises the level to trace to diagnose a connection problem and then
///   attaches the log to a bug report ships their secrets with it.
///
///   `Debug` — not lower — because the crate's `debug!` lines are the useful,
///   harmless ones ("Client handshake done.", "Trying to contact {uri}",
///   "Received close frame"). `trace!` is where both problems live: this dump,
///   and a line per WebSocket frame read and written (`protocol/frame/mod.rs`),
///   which is the ACP transport's firehose shape again — every ACP event
///   twice over.
/// - `tungstenite::handshake::client` → `Debug` — the same ceiling again, on
///   the exact target the dump is emitted from, and this one is not negotiable.
///   The crate-level entry above is a ceiling in the usual sense: a MORE
///   specific directive beats it, which is what keeps `tungstenite::protocol`
///   pinnable to trace for frame-level debugging. That escape hatch is right
///   for a firehose and wrong for a credential, so the dump gets its own entry.
///   Backstops are appended last and win at equal specificity (see
///   [`build_env_filter`]), so a plain `tungstenite::handshake::client=trace`
///   from the Settings UI or `CODEG_LOG` loses to this entry at any module
///   depth. Asking for LESS is still honored: the clamp never raises
///   verbosity, so `off` still means off.
///
///   This entry is not by itself sufficient, because a level table can only
///   answer directives that are about levels — a field-qualified directive
///   outranks it. [`is_credential_dump_target`] is what actually closes the
///   target; this keeps the level story coherent alongside it.
/// - `sqlx::query` → `Warn` — sqlx logs every executed statement, with its SQL
///   text, at INFO by default. Every `ConnectOptions` in the tree sets
///   `.sqlx_logging(false)`, but that is a per-call-site opt-out that a new
///   connection can forget; this makes forgetting harmless. Slow-query lines are
///   WARN and survive.
/// - `codeg_lib::logging` → `Off` — the logging stack must not log about itself
///   (cross-thread feedback-loop backstop; the layer's thread-local guard
///   handles the same-thread case).
///
/// Per-target ceilings close firehoses one at a time and only the ones we know
/// about; [`crate::logging::budget`] bounds the disk cost of the ones we don't.
const TARGET_BACKSTOPS: &[(&str, LogLevel)] = &[
    ("kill_tree", LogLevel::Warn),
    ("agent_client_protocol", LogLevel::Warn),
    ("tungstenite", LogLevel::Debug),
    ("tungstenite::handshake::client", LogLevel::Debug),
    ("sqlx::query", LogLevel::Warn),
    ("codeg_lib::logging", LogLevel::Off),
];

/// The one target that is refused structurally rather than by level.
///
/// [`TARGET_BACKSTOPS`] is a table of *levels*, and a level is negotiable:
/// `EnvFilter` ranks a field-qualified directive above a plain target one, so
/// `CODEG_LOG='tungstenite::handshake::client[{message}]=trace'` outranks the
/// entry there — and that `trace!` is a formatted event, so it has a `message`
/// field to match on. The entry in the table still earns its place (it keeps
/// the crate ceiling coherent and it is what the directive tests read), but it
/// cannot be the whole answer.
///
/// A ceiling is the wrong shape for this line anyway. There is no verbosity to
/// trade off: `handshake/client.rs` prints the serialized request, and in this
/// codebase the only tungstenite client is the remote-workspace WebSocket, so
/// every time that line prints at all it prints a bearer token and whatever
/// custom credential headers the connection carries. So it is dropped before
/// the level filter is consulted, and no directive in any syntax reaches it.
///
/// Anyone who genuinely needs the handshake bytes has `tungstenite::protocol`
/// for frames, or a local edit here.
fn is_credential_dump_target(target: &str) -> bool {
    target == "tungstenite::handshake::client"
}

/// Targets whose record is already in the rolling file by the time the
/// subscriber sees the event, so the file layer must not write it again.
///
/// One entry: [`crate::logging::panic_hook`] appends its record to that exact
/// file synchronously, because the write has to survive a process that is
/// seconds from aborting (the file sink is a `non_blocking` writer whose flush
/// is a no-op). Most panics do NOT end the process — tokio catches them in
/// spawned tasks — so without this every survivable panic appeared twice in the
/// log, in the same JSON shape, and anything counting them counted double.
///
/// Scoped to the file layer alone, unlike [`is_credential_dump_target`]: stderr,
/// the ring buffer and the Logs viewer's live tail have no synchronous copy and
/// still need the event.
fn file_sink_has_own_copy(target: &str) -> bool {
    target == crate::logging::panic_hook::PANIC_TARGET
}

/// How much a level lets through, ascending. Distinct from [`LogLevel::rank`],
/// which is a *severity* rank for filtering records (and puts `Off` at 0
/// alongside the most severe end); comparing verbosity needs `Off` to be the
/// least of all.
fn verbosity(level: LogLevel) -> u8 {
    match level {
        LogLevel::Off => 0,
        LogLevel::Error => 1,
        LogLevel::Warn => 2,
        LogLevel::Info => 3,
        LogLevel::Debug => 4,
        LogLevel::Trace => 5,
    }
}

/// The [`TARGET_BACKSTOPS`] directives, each clamped to no more verbose than
/// `asked_for` reports for that target.
///
/// A backstop exists to make a noisy target QUIETER than the level asks for. It
/// must never make one LOUDER — but a bare `target=warn` appended after a global
/// level does exactly that when the global is quieter, because `EnvFilter` treats
/// the more specific directive as authoritative rather than as a bound. Three
/// user-visible consequences before this clamped:
///
/// - `LogLevel::Off` is documented as "disables capture entirely"
///   ([`crate::logging::LogLevel`]), yet `off,agent_client_protocol=warn`
///   still captured the ACP transport's warnings — and it warns per message
///   under a misbehaving agent, so
///   "logging off" could still write on the hot path.
/// - A global `Error` silently gained back WARN lines from every clamped target.
/// - A user turning a clamped target DOWN (`agent_client_protocol=off` in the Settings UI) was
///   overruled back up to `warn` — the backstop refusing a request to be
///   quieter, which is the opposite of its job.
///
/// Taking the less verbose of the two fixes all three, and makes `Off` collapse
/// every entry to `off`.
fn clamped_backstops(asked_for: impl Fn(&str) -> LogLevel) -> String {
    TARGET_BACKSTOPS
        .iter()
        .map(|(target, backstop)| {
            let asked = asked_for(target);
            let level = if verbosity(*backstop) <= verbosity(asked) {
                *backstop
            } else {
                asked
            };
            format!("{target}={}", level.directive())
        })
        .collect::<Vec<_>>()
        .join(",")
}

/// Directive string for an explicit env-override level `s`, with the standing
/// backstops appended, each clamped to what `s` itself grants that target.
/// Extracted so the backstop application on the env-override path is
/// unit-testable without installing a global subscriber.
fn env_override_directives(s: &str) -> String {
    format!(
        "{s},{}",
        clamped_backstops(|target| env_level_for_target(s, target))
    )
}

/// The level a `RUST_LOG`-style expression grants `target`, as far as a ceiling
/// needs to know.
///
/// This has to predict `EnvFilter`'s own choice, because the ceiling is emitted
/// as another directive and therefore competes with the user's under
/// `EnvFilter`'s rules. Those rules, from
/// `tracing-subscriber-0.3.22/src/filter/env/directive.rs`:
///
/// - a directive's target matches by **raw `starts_with`** (`directive.rs:246`),
///   not module-awareness — so `kill_tree=off` would also govern a
///   `kill_tree_x`;
/// - the longest matching target wins, and among equal ones the last;
/// - a level may be named (case-insensitive) **or numeric** `0`..`5`
///   (`LevelFilter::from_str`);
/// - a bare word that isn't a level is a target at `TRACE` (`directive.rs:163`),
///   and so is `target=` with the level left off (`directive.rs:203`) — note
///   that is NOT `LevelFilter::from_str("")`, which would be `ERROR`;
/// - **whitespace is not normalized anywhere.** `Directive::parse` walks
///   `from.trim()` for its indices but slices the *untrimmed* `from`
///   (`directive.rs:143` vs `:215`/`:232`), so a padded part like `"info "`
///   fails `LevelFilter::from_str` and lands as the inert target `"info "`
///   rather than the global level. Trimming here — which an earlier draft did —
///   read that as `Info` and emitted a ceiling that `EnvFilter` had granted
///   nothing, i.e. louder than asked. So nothing is trimmed: parts come straight
///   out of `split(',')` and both sides of `=` are compared as-is.
///
/// **With nothing applicable the answer is `Off`, not "unbounded".** An
/// expression like `codeg_lib=info` enables nothing else — `EnvFilter::builder()`
/// leaves `default_directive` unset (`builder.rs:353`), so an unmatched target is
/// disabled — and a ceiling emitted as `agent_client_protocol=warn` there would *turn agent_client_protocol on*, a
/// floor masquerading as a ceiling, which is the whole bug this clamp prevents.
///
/// A directive naming a target this one does not cover is skipped, including a
/// MORE specific one: `EnvFilter` prefers it for events beneath it, which is
/// exactly the documented escape hatch and needs no help from us.
fn env_level_for_target(expr: &str, target: &str) -> LogLevel {
    // Specificity of the best candidate so far, so a later but broader directive
    // can't displace a narrower earlier one. `0` is the bare global level.
    let mut best: Option<(usize, LogLevel)> = None;
    // Untrimmed, matching `parse_lossy`'s `split(',').filter(|s| !s.is_empty())`.
    for part in expr.split(',') {
        if part.is_empty() {
            continue;
        }
        let (directive_target, level) = match part.split_once('=') {
            // `target=level`. An OMITTED level is TRACE (`directive.rs:203`); an
            // INVALID one makes the whole directive unparseable, and
            // `parse_lossy` drops those — so must we, or we'd emit a ceiling for
            // a directive `EnvFilter` never accepted. `CODEG_LOG=off,agent_client_protocol=bogus`
            // is the case that matters: EnvFilter keeps only `off`, so appending
            // `agent_client_protocol=warn` there would turn agent_client_protocol back on.
            //
            // Neither side is trimmed, per the whitespace note above: `agent_client_protocol = warn`
            // really does yield the target `"agent_client_protocol "` (which nothing matches) and
            // the level `" warn"` (invalid).
            Some((lhs, "")) => (Some(lhs), LogLevel::Trace),
            Some((lhs, rhs)) => match parse_level(rhs) {
                Some(level) => (Some(lhs), level),
                None => continue,
            },
            // No `=`: a bare level, or else a bare target meaning TRACE
            // (`directive.rs:163`).
            None => match parse_level(part) {
                Some(level) => (None, level),
                None => (Some(part), LogLevel::Trace),
            },
        };
        let specificity = match directive_target {
            None => 0,
            // Malformed (`=info`); `parse_lossy` drops it, so should we.
            Some("") => continue,
            // +1 so an empty-target match could never tie with the global level.
            Some(t) if target.starts_with(t) => t.len() + 1,
            Some(_) => continue,
        };
        if best.is_none_or(|(best_specificity, _)| specificity >= best_specificity) {
            best = Some((specificity, level));
        }
    }
    best.map_or(LogLevel::Off, |(_, level)| level)
}

/// `s` as a level, mirroring `LevelFilter::from_str`: numeric first (through
/// `usize`, so `00` and `005` are the same as `0` and `5`), then the named levels
/// case-insensitively. `None` if it is neither — which on a directive's left-hand
/// side means it is a target, and on the right-hand side means the directive is
/// invalid.
///
/// **Does not trim.** `LevelFilter::from_str` doesn't either, and the caller
/// hands over slices that deliberately keep the whitespace `Directive::parse`
/// would have kept (see the call site), so a padded level must read as invalid
/// exactly as it does there.
///
/// Does NOT map `""`, whose meaning depends on position: `EnvFilter`'s directive
/// parser reads an omitted level as `TRACE`, so the caller supplies that.
fn parse_level(s: &str) -> Option<LogLevel> {
    if let Ok(n) = s.parse::<usize>() {
        return match n {
            0 => Some(LogLevel::Off),
            1 => Some(LogLevel::Error),
            2 => Some(LogLevel::Warn),
            3 => Some(LogLevel::Info),
            4 => Some(LogLevel::Debug),
            5 => Some(LogLevel::Trace),
            _ => None,
        };
    }
    match s.to_ascii_lowercase().as_str() {
        "off" => Some(LogLevel::Off),
        "error" => Some(LogLevel::Error),
        "warn" => Some(LogLevel::Warn),
        "info" => Some(LogLevel::Info),
        "debug" => Some(LogLevel::Debug),
        "trace" => Some(LogLevel::Trace),
        _ => None,
    }
}

/// Build the `EnvFilter` for the full settings: the global level, then each
/// non-empty per-target override (`target=level`), then the standing backstops
/// clamped to the global level (see [`clamped_backstops`]). The backstops go last
/// so they win at equal specificity. `parse_lossy` silently drops any malformed
/// target directive — the UI constrains the input to avoid that.
pub fn build_env_filter(settings: &LogSettings) -> EnvFilter {
    let mut directives = settings.level.directive().to_string();
    for t in &settings.targets {
        // Validate server-side (don't trust the UI): only well-formed module
        // targets are interpolated, and the logging module can never be
        // overridden — it must stay `off` (the backstop appended below).
        let target = t.target.trim();
        if is_valid_target(target) {
            directives.push_str(&format!(",{}={}", target, t.level.directive()));
        }
    }
    directives.push(',');
    // What the settings asked for a backstopped target: its own override if the
    // user set one, else the global level. A per-target override that is QUIETER
    // than the backstop then stands — asking for less is always honored, and only
    // asking for more is what the backstop refuses.
    directives.push_str(&clamped_backstops(|target| {
        settings
            .targets
            .iter()
            .find(|t| t.target.trim() == target)
            .map(|t| t.level)
            .unwrap_or(settings.level)
    }));
    EnvFilter::builder().parse_lossy(directives)
}

/// A well-formed tracing target: `ident(::ident)*`, `ident = [A-Za-z0-9_]+`
/// (mirrors the frontend grammar). Also rejects the logging module's own target
/// (and submodules) so a persisted or client-supplied override can't defeat the
/// recursion backstop.
fn is_valid_target(target: &str) -> bool {
    if target.is_empty()
        || target == "codeg_lib::logging"
        || target.starts_with("codeg_lib::logging::")
    {
        return false;
    }
    target.split("::").all(|seg| {
        !seg.is_empty() && seg.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
    })
}

/// Build a reload handle not attached to any installed subscriber, for tests
/// that construct a detached [`crate::logging::hub::LogHub`] without touching
/// the process-global subscriber.
#[cfg(any(test, feature = "test-utils"))]
pub fn detached_reload_handle() -> ReloadHandle {
    let (_layer, handle): (reload::Layer<EnvFilter, Registry>, ReloadHandle) =
        reload::Layer::new(build_env_filter(&LogSettings::default()));
    handle
}

/// Extension on the rotated log files. Shared between the appender that writes
/// them and [`budget::resume_point`], which has to reconstruct the current day's
/// filename to measure it — they must not drift apart.
const LOG_FILE_SUFFIX: &str = "log";

/// Retention for rotated daily files. A disk-bound necessity (daily files would
/// otherwise accumulate forever), not a functional cap; generous default,
/// overridable via `CODEG_LOG_MAX_FILES`.
///
/// Note this bounds the number of **files**, not their size — a single day's
/// file is bounded separately by [`crate::logging::budget`].
fn file_retention() -> usize {
    std::env::var("CODEG_LOG_MAX_FILES")
        .ok()
        .and_then(|v| v.parse::<usize>().ok())
        .filter(|&n| n > 0)
        .unwrap_or(30)
}

/// The env-override directive, or `None`: the first non-empty (trimmed) value of
/// `CODEG_LOG` then `RUST_LOG`. Single source of truth for env-level precedence,
/// so the startup filter and the env-lock checks can't diverge — e.g. an empty
/// `CODEG_LOG` must not mask a valid `RUST_LOG` (a `var().or_else(var)` would
/// treat the empty `Ok("")` as present and skip `RUST_LOG`).
fn env_level_override() -> Option<String> {
    ["CODEG_LOG", "RUST_LOG"].iter().find_map(|key| {
        std::env::var(key)
            .ok()
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty())
    })
}

/// Whether an explicit `CODEG_LOG` / `RUST_LOG` is set (and non-empty). When
/// true the env var owns the live level: startup skips the persisted level and
/// the Settings UI locks the control (so it can't silently diverge).
pub fn env_level_is_set() -> bool {
    env_level_override().is_some()
}

/// Create the rotating file writer, returning `None` (degrading to stderr +
/// buffer only) if the directory or appender can't be initialized. Logging init
/// must never crash the app.
///
/// The appender is wrapped in a [`BudgetedWriter`] so one day's file can't grow
/// without bound: `Rotation::DAILY` decides *when* a new file starts, never how
/// large the current one may get, and a per-message log on a hot path can
/// otherwise write tens of GB before midnight. The budget **resumes** the day it
/// starts in rather than beginning at zero — the appender re-opens an existing
/// dated file in append mode, so a fresh count would hand out a whole new
/// ceiling on every relaunch.
fn init_file_writer(dir: &Path, prefix: &str) -> Option<(NonBlocking, WorkerGuard)> {
    // Pre-subscriber bootstrap: the subscriber isn't installed yet, so these
    // diagnostics legitimately go straight to stderr rather than via tracing.
    if let Err(e) = std::fs::create_dir_all(dir) {
        eprintln!("[logging] could not create log dir {}: {e}", dir.display());
        return None;
    }
    let appender = match tracing_appender::rolling::Builder::new()
        .rotation(Rotation::DAILY)
        .filename_prefix(prefix)
        .filename_suffix(LOG_FILE_SUFFIX)
        .max_log_files(file_retention())
        .build(dir)
    {
        Ok(appender) => appender,
        Err(e) => {
            eprintln!(
                "[logging] could not init log appender in {}: {e}",
                dir.display()
            );
            return None;
        }
    };
    // Measured with the SAME prefix/suffix the appender was just built with, so
    // the file the budget accounts for is the file being written.
    let (day, already_written) = budget::resume_point(dir, prefix, LOG_FILE_SUFFIX);
    let budgeted = BudgetedWriter::resuming(
        appender,
        budget::configured_max_bytes_per_day(),
        day,
        already_written,
    );
    // Tell the panic hook which file to append its record to. Recorded only now
    // that the appender exists, so the name it reconstructs is the file being
    // written and the directory is known to have been created above.
    crate::logging::panic_hook::set_log_file(dir, prefix, LOG_FILE_SUFFIX);
    Some(tracing_appender::non_blocking(budgeted))
}

/// Build and install the subscriber. `file_dir` is `None` for `codeg-mcp`
/// (stderr only). Returns the reload handle and the appender guard.
fn build_subscriber(
    initial: LogLevel,
    file_dir: Option<&Path>,
    file_prefix: &str,
) -> (ReloadHandle, Option<WorkerGuard>) {
    // Explicit env wins at startup; otherwise the passed-in default. Phase 2
    // (apply_persisted_level) later overrides the default from the DB. Uses the
    // same `env_level_override` precedence as `env_level_is_set`, so a level
    // applied here is exactly the one the UI reports as env-locked.
    let initial_filter = match env_level_override() {
        // Even an explicit env override gets the standing target backstops, so
        // `RUST_LOG=debug` still can't re-open the kill_tree per-PID firehose.
        Some(s) => EnvFilter::builder().parse_lossy(env_override_directives(&s)),
        // Phase 1 has no DB yet, so no persisted per-target overrides; just the
        // default level. Phase 2 (apply_persisted_level) rebuilds with targets.
        None => build_env_filter(&LogSettings {
            level: initial,
            targets: Vec::new(),
        }),
    };
    let (filter_layer, reload_handle) = reload::Layer::new(initial_filter);

    // stderr fmt layer — MUST target stderr (not the default stdout): in
    // codeg-mcp stdout is the JSON-RPC channel, and elsewhere the migrated
    // eprintln! all went to stderr.
    let file = file_dir.and_then(|dir| init_file_writer(dir, file_prefix));

    // The reloadable EnvFilter is added first, so it acts as a global filter
    // over every sibling layer; its reload handle's subscriber type is
    // therefore `Registry`. Building the optional file layer inline (per match
    // arm) lets the compiler infer each layer's subscriber type without boxing.
    let guard = match file {
        Some((non_blocking, guard)) => {
            Registry::default()
                .with(filter_layer)
                // A second global filter: an event must clear BOTH, so this one
                // cannot be argued with by any `EnvFilter` directive.
                .with(filter_fn(|meta| !is_credential_dump_target(meta.target())))
                .with(fmt::layer().with_writer(std::io::stderr))
                .with(BufferEmitLayer)
                // A PER-LAYER filter, so it applies to the file sink alone.
                // `panic_hook` has already appended its record to this exact
                // file, synchronously, because the write has to survive a
                // process that is seconds from aborting. Letting the event
                // through here too would write the same panic twice, in the
                // same shape, to the same file. Every other sink still gets
                // it: stderr, the ring buffer and the Logs viewer's live tail
                // have no synchronous copy.
                .with(
                    fmt::layer()
                        .json()
                        .with_writer(non_blocking)
                        .with_filter(filter_fn(|meta| !file_sink_has_own_copy(meta.target()))),
                )
                .init();
            Some(guard)
        }
        None => {
            Registry::default()
                .with(filter_layer)
                // A second global filter: an event must clear BOTH, so this one
                // cannot be argued with by any `EnvFilter` directive.
                .with(filter_fn(|meta| !is_credential_dump_target(meta.target())))
                .with(fmt::layer().with_writer(std::io::stderr))
                .with(BufferEmitLayer)
                .init();
            None
        }
    };

    // Last here, because the hook logs through the subscriber that was just
    // installed. Early everywhere else: every binary builds its subscriber
    // through this one function, so this single call covers the desktop app,
    // the server, `codeg-mcp`, the supervisor and the credential helper, and it
    // runs before any of them does real work.
    crate::logging::panic_hook::install();

    (reload_handle, guard)
}

/// Phase 1 for the desktop `codeg` binary: stderr + file (`codeg.<date>.log`) +
/// buffer. Default level is env-or-`info`; [`apply_persisted_level`] refines it
/// once the DB is open.
pub fn init_desktop() -> LogGuard {
    init_with_file("codeg")
}

/// Phase 1 for `codeg-server`: stderr + file (`codeg-server.<date>.log`) +
/// buffer.
pub fn init_server() -> LogGuard {
    init_with_file("codeg-server")
}

fn init_with_file(prefix: &str) -> LogGuard {
    let dir = crate::paths::codeg_logs_root();
    let (reload, guard) = build_subscriber(LogLevel::default(), Some(&dir), prefix);
    LogHub::install(reload);
    LogGuard { _guard: guard }
}

/// Install a **stderr-only** subscriber (no file / buffer / hub / emitter) for
/// process modes that run before — or instead of — the full logging stack:
/// `codeg-mcp`, the `--supervise` supervisor, and the `--credential-helper`
/// subprocess. Without an installed subscriber, `tracing` calls on those paths
/// are silently dropped (unlike the old `eprintln!`, which always hit stderr).
///
/// stderr (not stdout) is mandatory: in `codeg-mcp` and the credential helper,
/// stdout is a protocol channel. No file appender: those modes are short-lived
/// or multi-process and must not clobber a shared rolling file. No hub: nothing
/// to buffer/emit, so `BufferEmitLayer` short-circuits.
pub fn init_stderr_only() -> LogGuard {
    let (_reload, guard) = build_subscriber(LogLevel::default(), None, "");
    LogGuard { _guard: guard }
}

/// Phase 1 for `codeg-mcp`. See [`init_stderr_only`].
pub fn init_mcp() -> LogGuard {
    init_stderr_only()
}

/// Phase 2: override the default level from the persisted `logging.level` KV
/// value, unless an explicit `CODEG_LOG` / `RUST_LOG` is set (env wins). No-op
/// when no hub is installed (mcp) or the value is absent/unparseable.
pub async fn apply_persisted_level(conn: &sea_orm::DatabaseConnection) {
    if env_level_is_set() {
        return;
    }
    let Some(hub) = crate::logging::hub::log_hub() else {
        return;
    };
    if let Ok(Some(raw)) =
        crate::db::service::app_metadata_service::get_value(conn, LOGGING_LEVEL_KEY).await
    {
        if let Ok(settings) = serde_json::from_str::<LogSettings>(&raw) {
            hub.apply_settings(&settings);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::logging::TargetDirective;

    #[test]
    fn build_env_filter_includes_per_target_directives() {
        let settings = LogSettings {
            level: LogLevel::Info,
            targets: vec![
                TargetDirective {
                    target: "codeg_lib::acp".into(),
                    level: LogLevel::Debug,
                },
                // Whitespace-only target is skipped, not emitted as a bare "=trace".
                TargetDirective {
                    target: "  ".into(),
                    level: LogLevel::Trace,
                },
                TargetDirective {
                    target: "codeg_lib::web".into(),
                    level: LogLevel::Warn,
                },
            ],
        };
        let rendered = build_env_filter(&settings).to_string();
        assert!(
            rendered.contains("codeg_lib::acp=debug"),
            "missing acp override: {rendered}"
        );
        assert!(
            rendered.contains("codeg_lib::web=warn"),
            "missing web override: {rendered}"
        );
        assert!(
            rendered.contains("codeg_lib::logging=off"),
            "missing backstop: {rendered}"
        );
        assert!(
            !rendered.contains("=trace"),
            "empty-target row should be skipped: {rendered}"
        );
    }

    #[test]
    fn build_env_filter_rejects_invalid_and_logging_targets() {
        let settings = LogSettings {
            level: LogLevel::Info,
            targets: vec![
                TargetDirective {
                    target: "bad-target!".into(), // invalid chars → dropped
                    level: LogLevel::Trace,
                },
                TargetDirective {
                    target: "codeg_lib::logging".into(), // backstop override attempt → dropped
                    level: LogLevel::Trace,
                },
                TargetDirective {
                    target: "codeg_lib::acp".into(),
                    level: LogLevel::Debug,
                },
            ],
        };
        let rendered = build_env_filter(&settings).to_string();
        assert!(rendered.contains("codeg_lib::acp=debug"), "{rendered}");
        assert!(!rendered.contains("bad-target"), "{rendered}");
        // The logging module stays off; the override attempt is dropped.
        assert!(rendered.contains("codeg_lib::logging=off"), "{rendered}");
        assert!(!rendered.contains("codeg_lib::logging=trace"), "{rendered}");
    }

    #[test]
    fn build_env_filter_pins_noisy_third_party_targets() {
        // Every constructed filter clamps the known firehoses and keeps the
        // logging module's own target off.
        let rendered = build_env_filter(&LogSettings {
            level: LogLevel::Info,
            targets: Vec::new(),
        })
        .to_string();
        for pin in [
            // Per-PID DEBUG firehose; once grew a server log to 217GB.
            "kill_tree=warn",
            // Full JSON-RPC payload per message (TRACE), plus a per-message
            // INFO line — the 34GB-in-8.8h shape.
            "agent_client_protocol=warn",
            // The serialized WS handshake at TRACE — bearer token and every
            // custom header of a remote workspace connection, in the clear.
            // Clamped to the global `info` here: the ceiling never adds volume,
            // it only refuses trace.
            "tungstenite=info",
            // Every SQL statement at INFO if a ConnectOptions forgets to opt out.
            "sqlx::query=warn",
            "codeg_lib::logging=off",
        ] {
            assert!(rendered.contains(pin), "missing backstop {pin}: {rendered}");
        }
    }

    /// The specific accident the `tungstenite` ceiling exists to prevent: a user
    /// raises the level to trace to diagnose a remote-workspace connection, and
    /// the WS handshake dump takes their bearer token and every custom header —
    /// the Cloudflare Access secret the feature exists to carry — to disk with
    /// it. Both filter paths have to hold, since the env override builds its own.
    #[test]
    fn a_global_trace_cannot_capture_the_websocket_handshake_dump() {
        let rendered = build_env_filter(&LogSettings {
            level: LogLevel::Trace,
            targets: Vec::new(),
        })
        .to_string();
        assert!(
            rendered.contains("tungstenite=debug"),
            "global trace re-opened the handshake dump: {rendered}"
        );
        let env = env_override_directives("trace");
        assert!(
            EnvFilter::builder()
                .parse_lossy(&env)
                .to_string()
                .contains("tungstenite=debug"),
            "CODEG_LOG=trace re-opened the handshake dump: {env}"
        );
    }

    /// The crate ceiling stops the accident; this stops the deliberate act.
    /// A firehose ceiling is meant to be re-openable by naming a submodule —
    /// that is how `tungstenite::protocol=trace` stays available for frame
    /// debugging. A credential dump is not, so the exact target it is emitted
    /// on carries its own backstop, which wins at equal specificity, and no
    /// target is more specific than the module holding the `trace!`.
    #[test]
    fn the_handshake_dump_cannot_be_reopened_even_by_naming_its_target() {
        for asked in [
            "tungstenite::handshake::client=trace",
            "trace,tungstenite::handshake::client=trace",
        ] {
            let rendered = EnvFilter::builder()
                .parse_lossy(env_override_directives(asked))
                .to_string();
            assert!(
                !rendered.contains("tungstenite::handshake::client=trace"),
                "CODEG_LOG={asked} reopened the dump: {rendered}"
            );
        }

        // The Settings UI builds its filter down a different path.
        let rendered = build_env_filter(&LogSettings {
            level: LogLevel::Trace,
            targets: vec![TargetDirective {
                target: "tungstenite::handshake::client".into(),
                level: LogLevel::Trace,
            }],
        })
        .to_string();
        assert!(
            !rendered.contains("tungstenite::handshake::client=trace"),
            "the Settings UI reopened the dump: {rendered}"
        );

        // Asking for less is still honored — a ceiling never raises verbosity.
        assert!(
            env_override_directives("tungstenite::handshake::client=off")
                .contains("tungstenite::handshake::client=off"),
            "off must still mean off"
        );

        // And frame-level debugging stays reachable, which is the whole reason
        // the crate-level entry remains a re-openable ceiling.
        let frames = EnvFilter::builder()
            .parse_lossy(env_override_directives("info,tungstenite::protocol=trace"))
            .to_string();
        assert!(
            frames.contains("tungstenite::protocol=trace"),
            "frame tracing must survive the crate ceiling: {frames}"
        );
    }

    /// Why the level table cannot be the whole answer, pinned as a fact rather
    /// than an argument: `EnvFilter` ranks a field-qualified directive above a
    /// plain target one, and the dump is a formatted event so it has a
    /// `message` field to qualify on. The first assertion shows the ceiling
    /// losing; the second shows what actually holds the line.
    #[test]
    fn a_field_qualified_directive_defeats_the_ceiling_but_not_the_denial() {
        let rendered = EnvFilter::builder()
            .parse_lossy(env_override_directives(
                "tungstenite::handshake::client[{message}]=trace",
            ))
            .to_string();
        assert!(
            rendered.contains("tungstenite::handshake::client[{message}]=trace"),
            "expected the level table to be outranked here: {rendered}"
        );

        assert!(
            is_credential_dump_target("tungstenite::handshake::client"),
            "the dump's target must be denied outright, whatever the filter says"
        );
        // Exact match only — the denial must not swallow its neighbours.
        for neighbour in [
            "tungstenite::handshake::server",
            "tungstenite::handshake",
            "tungstenite::protocol",
            "tungstenite",
        ] {
            assert!(
                !is_credential_dump_target(neighbour),
                "{neighbour} must stay reachable"
            );
        }
    }

    /// The panic record reaches the rolling file by its own synchronous write,
    /// so the file layer must skip it — otherwise every survivable panic (most
    /// of them: tokio catches panics in spawned tasks) is in the log twice.
    /// Scoped to that one target, and to that one sink.
    #[test]
    fn the_file_sink_skips_only_the_record_the_panic_hook_already_wrote() {
        assert!(file_sink_has_own_copy(
            crate::logging::panic_hook::PANIC_TARGET
        ));
        for other in [
            "codeg_lib::acp::connection",
            "codeg_lib::panic_hook",
            "codeg_lib::panicky",
            "codeg_lib",
            "panic",
        ] {
            assert!(
                !file_sink_has_own_copy(other),
                "{other} has no synchronous copy and must still reach the file"
            );
        }
    }

    /// The predicate above is only half the claim; this exercises the wiring,
    /// with the same two global filters the real subscriber is built from and
    /// the most permissive directive anyone could write for the dump.
    #[test]
    fn the_denial_layer_drops_the_dump_and_nothing_else() {
        use std::sync::{Arc, Mutex};

        struct CaptureTargets(Arc<Mutex<Vec<String>>>);
        impl<S: tracing::Subscriber> tracing_subscriber::Layer<S> for CaptureTargets {
            fn on_event(
                &self,
                event: &tracing::Event<'_>,
                _ctx: tracing_subscriber::layer::Context<'_, S>,
            ) {
                self.0
                    .lock()
                    .unwrap()
                    .push(event.metadata().target().to_string());
            }
        }

        let seen = Arc::new(Mutex::new(Vec::new()));
        let subscriber = Registry::default()
            .with(EnvFilter::builder().parse_lossy(
                "trace,tungstenite::handshake::client[{message}]=trace",
            ))
            .with(filter_fn(|meta| !is_credential_dump_target(meta.target())))
            .with(CaptureTargets(seen.clone()));

        tracing::subscriber::with_default(subscriber, || {
            tracing::trace!(target: "tungstenite::handshake::client", "Request: bearer s3cret");
            tracing::trace!(target: "tungstenite::protocol", "frame");
            tracing::trace!(target: "codeg_lib::acp", "unrelated");
        });

        let seen = seen.lock().unwrap();
        assert!(
            !seen.iter().any(|t| t == "tungstenite::handshake::client"),
            "the dump reached a sink: {seen:?}"
        );
        assert!(
            seen.iter().any(|t| t == "tungstenite::protocol"),
            "frame tracing must still arrive: {seen:?}"
        );
        assert!(
            seen.iter().any(|t| t == "codeg_lib::acp"),
            "unrelated targets must still arrive: {seen:?}"
        );
    }

    /// The panic filter is PER-LAYER, which is the whole point: the file sink
    /// must lose the record it already holds while every other sink keeps it.
    /// A global filter here would have silenced the panic on stderr and in the
    /// Logs viewer too — which is the opposite of what this module is for.
    ///
    /// Built with the same layer stack `build_subscriber`'s file arm uses, so
    /// this exercises the wiring and not just the predicate.
    #[test]
    fn the_file_layer_alone_loses_the_record_the_hook_already_wrote() {
        use std::sync::{Arc, Mutex};

        struct CaptureTargets(&'static str, Arc<Mutex<Vec<(String, String)>>>);
        impl<S: tracing::Subscriber> tracing_subscriber::Layer<S> for CaptureTargets {
            fn on_event(
                &self,
                event: &tracing::Event<'_>,
                _ctx: tracing_subscriber::layer::Context<'_, S>,
            ) {
                self.1
                    .lock()
                    .unwrap()
                    .push((self.0.to_string(), event.metadata().target().to_string()));
            }
        }

        let seen = Arc::new(Mutex::new(Vec::new()));
        // The reloadable filter, not a bare `EnvFilter`: the real stack's first
        // layer is a `reload::Layer`, and a per-layer filter beneath one is the
        // combination this test exists to pin.
        let (reloadable, _handle) =
            reload::Layer::new(EnvFilter::builder().parse_lossy("trace"));
        let subscriber = Registry::default()
            .with(reloadable)
            .with(filter_fn(|meta| !is_credential_dump_target(meta.target())))
            // Stands in for the stderr fmt layer and the buffer layer.
            .with(CaptureTargets("other", seen.clone()))
            // Stands in for the JSON file layer, with its per-layer filter.
            .with(
                CaptureTargets("file", seen.clone())
                    .with_filter(filter_fn(|meta| !file_sink_has_own_copy(meta.target()))),
            );

        tracing::subscriber::with_default(subscriber, || {
            tracing::error!(target: crate::logging::panic_hook::PANIC_TARGET, "panic in thread …");
            tracing::info!(target: "codeg_lib::acp", "ordinary event");
        });

        let seen = seen.lock().unwrap();
        let panic_target = crate::logging::panic_hook::PANIC_TARGET;
        assert!(
            !seen
                .iter()
                .any(|(sink, target)| sink == "file" && target == panic_target),
            "the file sink must not write the record a second time: {seen:?}"
        );
        assert!(
            seen.iter()
                .any(|(sink, target)| sink == "other" && target == panic_target),
            "every other sink must still carry the panic: {seen:?}"
        );
        assert_eq!(
            seen.iter()
                .filter(|(_, target)| target == "codeg_lib::acp")
                .count(),
            2,
            "an ordinary event still reaches both sinks: {seen:?}"
        );
    }

    #[test]
    fn env_override_appends_backstops_so_debug_cannot_reopen_them() {
        // The explicit RUST_LOG/CODEG_LOG path bypasses build_env_filter, so it
        // must apply the same backstops itself — otherwise `RUST_LOG=debug`
        // re-opens the kill_tree per-PID firehose and the agent_client_protocol wire dump.
        assert_eq!(
            env_override_directives("debug"),
            "debug,kill_tree=warn,agent_client_protocol=warn,tungstenite=debug,\
             tungstenite::handshake::client=debug,sqlx::query=warn,codeg_lib::logging=off"
        );
        // And the parsed filter still carries the clamps under a global debug.
        let rendered = EnvFilter::builder()
            .parse_lossy(env_override_directives("debug"))
            .to_string();
        for pin in ["kill_tree=warn", "agent_client_protocol=warn", "sqlx::query=warn"] {
            assert!(
                rendered.contains(pin),
                "{pin} clamp must survive a global debug override: {rendered}"
            );
        }
    }

    /// A backstop is a CEILING, not a pin. `LogLevel::Off` is documented as
    /// "disables capture entirely", so a bare `target=warn` appended after it —
    /// which is what this used to emit — made "logging off" still write, and
    /// two of agent_client_protocol's `warn!` sites fire per message under a misbehaving agent.
    #[test]
    fn off_means_off_and_backstops_never_raise_verbosity() {
        let off = build_env_filter(&LogSettings {
            level: LogLevel::Off,
            targets: Vec::new(),
        })
        .to_string();
        for target in ["kill_tree", "agent_client_protocol", "sqlx::query"] {
            assert!(
                off.contains(&format!("{target}=off")),
                "{target} must collapse to off under a global Off: {off}"
            );
            assert!(
                !off.contains(&format!("{target}=warn")),
                "{target} must not be re-enabled under a global Off: {off}"
            );
        }

        // Same rule one step up: a global Error must not gain WARN lines back.
        let error = build_env_filter(&LogSettings {
            level: LogLevel::Error,
            targets: Vec::new(),
        })
        .to_string();
        assert!(error.contains("agent_client_protocol=error"), "{error}");
        assert!(!error.contains("agent_client_protocol=warn"), "{error}");

        // And the env-override path. `RUST_LOG=off` must be silent too.
        assert_eq!(
            env_override_directives("OFF"),
            "OFF,kill_tree=off,agent_client_protocol=off,tungstenite=off,\
             tungstenite::handshake::client=off,sqlx::query=off,codeg_lib::logging=off",
            "a bare off override collapses the ceilings, case-insensitively"
        );
    }

    /// The env path has no single global level to clamp against, so the ceiling
    /// is resolved per target against the expression itself. Clamping only when
    /// the whole expression was a bare level (the first attempt) left the two
    /// cases below still emitting `agent_client_protocol=warn` — overruling an explicit request
    /// for silence on a per-message path.
    #[test]
    fn env_override_clamps_per_target_not_just_bare_levels() {
        // An explicit directive for a backstopped target must be honored when it
        // asks for LESS. `agent_client_protocol=off` alone also enables nothing else, so every
        // other ceiling collapses to off too.
        assert_eq!(
            env_override_directives("agent_client_protocol=off"),
            "agent_client_protocol=off,kill_tree=off,agent_client_protocol=off,tungstenite=off,\
             tungstenite::handshake::client=off,sqlx::query=off,codeg_lib::logging=off"
        );
        // ...but the same target asking for MORE is still refused: that is the
        // firehose this whole clamp exists to keep shut.
        assert!(
            env_override_directives("agent_client_protocol=trace").contains("agent_client_protocol=warn"),
            "a crate-wide trace request must still be clamped"
        );
        // A compound expression's bare level is the ceiling for targets it
        // doesn't name.
        let compound = env_override_directives("off,codeg_lib::acp=trace");
        assert!(compound.contains("agent_client_protocol=off"), "{compound}");
        assert!(!compound.contains("agent_client_protocol=warn"), "{compound}");
        let error_compound = env_override_directives("error,codeg_lib::acp=info");
        assert!(error_compound.contains("agent_client_protocol=error"), "{error_compound}");
        assert!(!error_compound.contains("agent_client_protocol=warn"), "{error_compound}");
        // No bare level at all: EnvFilter leaves unmatched targets disabled, so a
        // ceiling of `off` is the honest answer — emitting `warn` here would turn
        // agent_client_protocol ON in an expression that never asked for it.
        let targeted = env_override_directives("codeg_lib::acp=info");
        assert!(targeted.contains("agent_client_protocol=off"), "{targeted}");
        assert!(!targeted.contains("agent_client_protocol=warn"), "{targeted}");
    }

    #[test]
    fn env_level_for_target_resolves_like_env_filter_would() {
        // Exact target beats the global, and the last exact wins.
        assert_eq!(env_level_for_target("info,agent_client_protocol=off", "agent_client_protocol"), LogLevel::Off);
        assert_eq!(
            env_level_for_target("agent_client_protocol=warn,agent_client_protocol=debug", "agent_client_protocol"),
            LogLevel::Debug
        );
        // A later but BROADER directive can't displace a narrower earlier one.
        assert_eq!(
            env_level_for_target("agent_client_protocol=off,trace", "agent_client_protocol"),
            LogLevel::Off
        );
        // A different target doesn't answer for this one.
        assert_eq!(
            env_level_for_target("info,other=trace", "agent_client_protocol"),
            LogLevel::Info
        );
        // A MORE specific target doesn't either — EnvFilter prefers it for events
        // beneath it, which is the escape hatch.
        assert_eq!(
            env_level_for_target("info,agent_client_protocol::jsonrpc=trace", "agent_client_protocol"),
            LogLevel::Info
        );
        // Span/field syntax falls through to the global by design.
        assert_eq!(
            env_level_for_target("info,agent_client_protocol[span]=trace", "agent_client_protocol"),
            LogLevel::Info
        );
        // Nothing applicable at all ⇒ off, not unbounded.
        assert_eq!(env_level_for_target("other=trace", "agent_client_protocol"), LogLevel::Off);
        assert_eq!(env_level_for_target("", "agent_client_protocol"), LogLevel::Off);
        // Case is tolerated in a level.
        assert_eq!(env_level_for_target("INFO,agent_client_protocol=WARN", "agent_client_protocol"), LogLevel::Warn);
        // Malformed `=level` is dropped, like `parse_lossy` does.
        assert_eq!(env_level_for_target("=info", "agent_client_protocol"), LogLevel::Off);
    }

    /// `EnvFilter` normalizes whitespace NOWHERE: `Directive::parse` walks
    /// `from.trim()` for its indices but slices the untrimmed `from`
    /// (`directive.rs:143` vs `:215`), so `"info "` fails `LevelFilter::from_str`
    /// and becomes the inert target `"info "`. A resolver that trimmed read it as
    /// the global `Info` and emitted a ceiling for something the filter had
    /// granted nothing — louder than asked.
    ///
    /// Asserted on the **parsed filter**, not just the resolver, so the two can't
    /// drift apart silently.
    #[test]
    fn padded_directives_are_inert_to_both_the_filter_and_the_ceiling() {
        for expr in ["info ,agent_client_protocol =off", " info,agent_client_protocol = off", "info , agent_client_protocol=off"] {
            let level = env_level_for_target(expr, "agent_client_protocol");
            assert_eq!(
                level,
                LogLevel::Off,
                "a padded directive grants nothing, so the ceiling is off: {expr}"
            );
            let rendered = EnvFilter::builder()
                .parse_lossy(env_override_directives(expr))
                .to_string();
            assert!(
                !rendered.contains("agent_client_protocol=warn"),
                "padded `{expr}` must not end up enabling agent_client_protocol: {rendered}"
            );
        }

        // The unpadded spelling of the same intent still works normally, so this
        // is fidelity to EnvFilter rather than a blanket refusal.
        assert_eq!(
            env_level_for_target("info,agent_client_protocol=off", "agent_client_protocol"),
            LogLevel::Off
        );
        assert_eq!(env_level_for_target("info,other=off", "agent_client_protocol"), LogLevel::Info);
    }

    /// `parse_lossy` DROPS a directive whose level is invalid — it does not
    /// reinterpret it. Treating an unparseable level as `Trace` made the ceiling
    /// louder than the expression: EnvFilter kept only the global, and we appended
    /// a `warn` for a target it had discarded.
    #[test]
    fn an_invalid_level_drops_the_directive_instead_of_widening_it() {
        // EnvFilter keeps only `off` here, so the ceiling must stay `off` too.
        assert_eq!(
            env_level_for_target("off,agent_client_protocol=bogus", "agent_client_protocol"),
            LogLevel::Off
        );
        let rendered = env_override_directives("off,agent_client_protocol=bogus");
        assert!(rendered.contains("agent_client_protocol=off"), "{rendered}");
        assert!(!rendered.contains("agent_client_protocol=warn"), "{rendered}");

        // Numeric spellings go through `usize` in `LevelFilter::from_str`, so
        // these are levels, not garbage — and `00` is `off`, not `trace`.
        assert_eq!(env_level_for_target("agent_client_protocol=00", "agent_client_protocol"), LogLevel::Off);
        assert_eq!(env_level_for_target("agent_client_protocol=005", "agent_client_protocol"), LogLevel::Trace);
        // Out-of-range numbers are invalid, so that directive drops.
        assert_eq!(env_level_for_target("off,agent_client_protocol=9", "agent_client_protocol"), LogLevel::Off);
        // A padded level is invalid to `LevelFilter::from_str`, so it drops too.
        assert_eq!(
            env_level_for_target("off,agent_client_protocol= warn", "agent_client_protocol"),
            LogLevel::Off
        );
    }

    /// The forms `EnvFilter` accepts that a naive "is it a bare level?" reader
    /// misses. Each of these used to resolve to `Off` and thus emit `agent_client_protocol=off`,
    /// silently disabling a target the expression had asked to see.
    #[test]
    fn env_level_for_target_understands_every_directive_form() {
        // Numeric levels (`LevelFilter::from_str`): 0=off .. 5=trace.
        assert_eq!(env_level_for_target("5", "agent_client_protocol"), LogLevel::Trace);
        assert_eq!(env_level_for_target("0", "agent_client_protocol"), LogLevel::Off);
        assert_eq!(env_level_for_target("agent_client_protocol=2", "agent_client_protocol"), LogLevel::Warn);
        // A bare target with no level means TRACE for it (directive.rs:163).
        assert_eq!(env_level_for_target("agent_client_protocol", "agent_client_protocol"), LogLevel::Trace);
        // So does `target=` with the level omitted (directive.rs:203) — NOT the
        // `ERROR` that `LevelFilter::from_str("")` alone would give.
        assert_eq!(env_level_for_target("agent_client_protocol=", "agent_client_protocol"), LogLevel::Trace);

        // EnvFilter matches targets by raw `starts_with`, so a shorter directive
        // target also governs longer ones: `tungstenite=off` covers
        // `tungstenite::handshake::client` too, and the ceiling for that longer
        // target must not re-enable it. Raw, not module-aware: `kill_tree=off`
        // answers for a `kill_tree_x` just the same.
        assert_eq!(
            env_level_for_target("info,tungstenite=off", "tungstenite::handshake::client"),
            LogLevel::Off
        );
        assert_eq!(
            env_level_for_target("info,kill_tree=off", "kill_tree_x"),
            LogLevel::Off
        );
        assert!(
            env_override_directives("info,tungstenite=off")
                .contains("tungstenite::handshake::client=off"),
            "a prefix directive governs the longer target as EnvFilter would"
        );

        // And the clamp still refuses "louder" for each of these forms.
        for expr in ["agent_client_protocol", "agent_client_protocol=", "agent_client_protocol=5", "5"] {
            assert!(
                env_override_directives(expr).contains("agent_client_protocol=warn"),
                "{expr} must still be clamped to warn"
            );
        }
    }

    /// The other direction: a user turning a clamped target DOWN must be obeyed.
    /// The backstop exists to refuse "louder", never "quieter".
    #[test]
    fn a_quieter_per_target_override_beats_the_backstop() {
        let rendered = build_env_filter(&LogSettings {
            level: LogLevel::Info,
            targets: vec![TargetDirective {
                target: "agent_client_protocol".into(),
                level: LogLevel::Off,
            }],
        })
        .to_string();
        assert!(rendered.contains("agent_client_protocol=off"), "{rendered}");
        assert!(!rendered.contains("agent_client_protocol=warn"), "{rendered}");
    }

    #[test]
    fn a_more_specific_target_still_beats_the_crate_level_backstop() {
        // The backstops are a floor for the *crate*, not a gag order: pinning
        // `agent_client_protocol=warn` must not take away protocol-level debugging. EnvFilter
        // matches the most specific directive, so a submodule override wins even
        // though the backstop is appended after it. This is the documented
        // escape hatch for capturing the ACP wire.
        let rendered = EnvFilter::builder()
            .parse_lossy(env_override_directives(
                "info,agent_client_protocol::jsonrpc::transport_actor=trace",
            ))
            .to_string();
        assert!(
            rendered.contains("agent_client_protocol::jsonrpc::transport_actor=trace"),
            "submodule override must survive the crate backstop: {rendered}"
        );
        assert!(
            rendered.contains("agent_client_protocol=warn"),
            "the crate-level floor stays for every other agent_client_protocol module: {rendered}"
        );
    }

    #[test]
    fn a_same_target_override_loses_to_the_backstop() {
        // The other half of the contract: a directive on the *same* target as a
        // backstop is overwritten by it (last one wins for equal specificity),
        // so neither the Settings UI nor `RUST_LOG=agent_client_protocol=trace` can reopen the
        // whole-crate firehose by accident.
        let rendered = EnvFilter::builder()
            .parse_lossy(env_override_directives("agent_client_protocol=trace"))
            .to_string();
        assert!(rendered.contains("agent_client_protocol=warn"), "{rendered}");
        assert!(!rendered.contains("agent_client_protocol=trace"), "{rendered}");
    }

    #[test]
    fn is_valid_target_grammar() {
        assert!(is_valid_target("codeg_lib::acp"));
        assert!(is_valid_target("codeg_lib::acp::delegation"));
        assert!(is_valid_target("a"));
        assert!(!is_valid_target(""));
        assert!(!is_valid_target("bad-target"));
        assert!(!is_valid_target("::leading"));
        assert!(!is_valid_target("trailing::"));
        assert!(!is_valid_target("a:::b"));
        assert!(!is_valid_target("has space"));
        assert!(!is_valid_target("codeg_lib::logging"));
        assert!(!is_valid_target("codeg_lib::logging::hub"));
    }

    #[test]
    fn env_level_override_precedence() {
        // Both unset → no override.
        temp_env::with_vars(
            [("CODEG_LOG", None::<&str>), ("RUST_LOG", None::<&str>)],
            || {
                assert_eq!(env_level_override(), None);
                assert!(!env_level_is_set());
            },
        );
        // Empty CODEG_LOG must NOT mask a valid RUST_LOG (the bug Codex caught).
        temp_env::with_vars(
            [("CODEG_LOG", Some("")), ("RUST_LOG", Some("debug"))],
            || {
                assert_eq!(env_level_override().as_deref(), Some("debug"));
                assert!(env_level_is_set());
            },
        );
        // Both empty / whitespace-only → no override.
        temp_env::with_vars(
            [("CODEG_LOG", Some("  ")), ("RUST_LOG", Some(""))],
            || {
                assert_eq!(env_level_override(), None);
                assert!(!env_level_is_set());
            },
        );
        // CODEG_LOG wins when both are non-empty.
        temp_env::with_vars(
            [("CODEG_LOG", Some("trace")), ("RUST_LOG", Some("debug"))],
            || {
                assert_eq!(env_level_override().as_deref(), Some("trace"));
            },
        );
    }
}
