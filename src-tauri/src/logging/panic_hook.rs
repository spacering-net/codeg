//! The last thing a dying process gets to say.
//!
//! Without a hook, a Rust panic leaves **nothing** behind. On Windows the
//! runtime's `abort()` raises `STATUS_STACK_BUFFER_OVERRUN` (`0xc0000409`), so
//! all the user has is a Windows Error Reporting `BEX64` bucket naming
//! `codeg.exe`, and the rolling log simply stops mid-file: no message, no
//! location, no backtrace, nothing that names the code that failed. A report of
//! exactly that shape (0.30.6, faulting module `codeg.exe`, exception
//! `0xc0000409`, and a log whose last line predates the crash by days) is why
//! this module exists.
//!
//! The hook writes **twice**, in this order, because the two writes fail in
//! different ways:
//!
//! 1. **A synchronous append to today's rolling log file.** This is the write
//!    that has to survive, and it is the reason this module is more than a
//!    `tracing::error!`. The file sink is a `tracing_appender::non_blocking`
//!    writer: an event only pushes its formatted bytes onto a crossbeam channel
//!    and a *separate worker thread* does the writing. That writer's
//!    `io::Write::flush` is a documented no-op (`non_blocking.rs` in
//!    tracing-appender 0.2.5 returns `Ok(())` and nothing else), the sender is
//!    lossy by default (`try_send`, silently dropped when the queue is full),
//!    and the only real flush is `WorkerGuard::drop`, which this hook must not
//!    do: tokio catches panics in spawned tasks, so most panics do not end the
//!    process and tearing down the log writer would blind everything after.
//!    A process that aborts before that worker thread is next scheduled loses
//!    the line. Writing the record here removes the race.
//!    Bounded by [`MAX_APPEND_BYTES`], because this write is on the far side
//!    of the channel [`crate::logging::budget`] meters and so is not covered by
//!    the daily ceiling.
//! 2. **A `tracing::error!`**, so the same record also reaches stderr, the
//!    in-app Logs viewer's ring buffer, and its live tail.
//!
//! The two writes do NOT both land in the file: [`crate::logging::init`] gives
//! the file sink a per-layer filter that drops [`PANIC_TARGET`], since write 1
//! has already put that record there. Without it every survivable panic —
//! which is most of them, tokio catches panics in spawned tasks — would appear
//! twice in the log, in the same shape, and a reader counting panics would
//! count double.
//!
//! Then the previously installed hook runs, so the standard
//! `thread '...' panicked at ...` line still prints and anything the runtime
//! installed still fires.
//!
//! Nothing in here may panic: a panic inside a panic hook aborts the process
//! immediately and takes the record with it. Every fallible step is best
//! effort, and there is no `unwrap` on this path.

use std::backtrace::Backtrace;
use std::io::Write;
use std::panic::PanicHookInfo;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::OnceLock;

/// Tracing target for the panic record.
///
/// Deliberately **not** the module path, even though `tracing` would default to
/// it. The `TARGET_BACKSTOPS` table in [`crate::logging::init`] pins
/// `codeg_lib::logging` to `Off` so the logging stack cannot log about itself,
/// and a record emitted from `codeg_lib::logging::panic_hook` would inherit
/// that and be filtered out before it reached any sink. It is also the string a
/// user greps their log for, so it should name the event and not the plumbing.
pub const PANIC_TARGET: &str = "codeg_lib::panic";

/// Ceiling on the payload text carried in the record.
///
/// A panic message is normally one line; a formatted `assert_eq!` over two
/// large values is not. Bounded so one record cannot itself become the log
/// storm that [`crate::logging::budget`] exists to prevent.
const MAX_PAYLOAD_BYTES: usize = 4 * 1024;

/// Ceiling on the captured backtrace.
///
/// Deep enough for every frame that matters (the panicking function and its
/// callers sit at the top) and small enough that the whole record stays a
/// single modest write, which is what keeps the append atomic in practice
/// against the appender thread writing to the same file.
const MAX_BACKTRACE_BYTES: usize = 16 * 1024;

/// How much this hook may append to the log file over the life of the process.
///
/// Bounding ONE record is not enough, because the synchronous append
/// deliberately bypasses [`crate::logging::budget`] — that budget lives on the
/// far side of the channel this write exists to outrun, so the daily ceiling
/// does not see these bytes. Most panics do not end the process (tokio catches
/// them in spawned tasks), so a task that panics on every turn of a supervision
/// loop would write an unbudgeted ~20 KB record per turn, which is the exact
/// shape of the log storm the budget was added for.
///
/// 1 MiB is roughly the newest 50 full-size records — far more than anyone
/// reads, and the first one is the one that names the bug. Spending it does not
/// silence anything: [`write_report`] still emits the `tracing::error!`, and
/// that path is budgeted, throttled, and visible in the Logs viewer.
///
/// Per process, not per day: a panic hook must not read a clock it doesn't
/// have to, and a process that panics 50 times has already said what it has to
/// say.
const MAX_APPEND_BYTES: usize = 1024 * 1024;

/// Bytes [`append_to_log_file`] has reserved against [`MAX_APPEND_BYTES`].
static APPENDED_BYTES: AtomicUsize = AtomicUsize::new(0);

/// One captured panic.
///
/// Split out from the hook itself so the formatting is testable without
/// killing a test process: everything below takes a `PanicReport` rather than
/// a `PanicHookInfo`, which can only exist inside a real panic.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PanicReport {
    /// Thread name and id, e.g. `tokio-runtime-worker (ThreadId(7))`. The name
    /// is what says whether this was the UI thread, a tokio worker, or one of
    /// the detached OS threads.
    pub thread: String,
    /// `file:line:column` of the panic, or a placeholder when the runtime did
    /// not record one.
    pub location: String,
    /// The panic message.
    pub payload: String,
    /// A backtrace captured at the panic site.
    pub backtrace: String,
}

impl PanicReport {
    /// The one-line human summary: the tracing event's message, and the
    /// `message` field of the JSON line.
    pub fn summary(&self) -> String {
        format!(
            "panic in thread '{}' at {}: {}",
            self.thread, self.location, self.payload
        )
    }

    /// The record as **one** JSON line, in the same shape the file sink's
    /// `fmt::layer().json()` writes (`timestamp` / `level` / `fields` /
    /// `target`), so a reader of the file sees one uniform stream. One line,
    /// not several, so the worst case if the appender thread writes
    /// concurrently is two interleaved records rather than a mangled report.
    ///
    /// Ends with the newline that makes it a line.
    pub fn json_line(&self, timestamp: &str) -> String {
        let value = serde_json::json!({
            "timestamp": timestamp,
            "level": "ERROR",
            "fields": {
                "message": self.summary(),
                "thread": self.thread,
                "location": self.location,
                "payload": self.payload,
                "version": env!("CARGO_PKG_VERSION"),
                "backtrace": self.backtrace,
            },
            "target": PANIC_TARGET,
        });
        format!("{value}\n")
    }
}

/// Where the rolling file sink writes, so the hook can append to the same file.
///
/// Recorded by [`set_log_file`] once the appender it describes has been built.
/// Absent in the stderr-only modes (`codeg-mcp`, the `--supervise` supervisor,
/// the credential helper), which have no file to append to; there the hook
/// still emits its `tracing::error!` and stderr carries the record.
static FILE_SINK: OnceLock<FileSink> = OnceLock::new();

struct FileSink {
    dir: PathBuf,
    prefix: String,
    suffix: &'static str,
}

/// Record where the daily log file lives.
///
/// Called by [`crate::logging::init`] only after the appender was built
/// successfully, so the directory is known to exist and the name reconstructed
/// from these parts is the file actually being written.
pub(crate) fn set_log_file(dir: &Path, prefix: &str, suffix: &'static str) {
    let _ = FILE_SINK.set(FileSink {
        dir: dir.to_path_buf(),
        prefix: prefix.to_string(),
        suffix,
    });
}

/// Install the hook, chaining to whatever was installed before.
///
/// Idempotent: the first call wins, so the repeated subscriber init in
/// subprocess modes cannot stack hooks on top of each other.
///
/// Called from [`crate::logging::init`] as the last step of building the
/// subscriber, which makes it the earliest point at which a panic record has
/// somewhere to go. Every binary reaches it, since all five entry points build
/// their subscriber through that one function.
pub fn install() {
    static INSTALLED: OnceLock<()> = OnceLock::new();
    if INSTALLED.set(()).is_err() {
        return;
    }
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        write_report(&capture(info));
        // Chain, so the standard `thread '...' panicked at ...` line still
        // prints and anything the runtime installed still runs.
        previous(info);
    }));
}

/// Build the report for a panic in flight.
fn capture(info: &PanicHookInfo<'_>) -> PanicReport {
    let thread = std::thread::current();
    PanicReport {
        thread: format!(
            "{} ({:?})",
            thread.name().unwrap_or("<unnamed>"),
            thread.id()
        ),
        location: match info.location() {
            Some(l) => format!("{}:{}:{}", l.file(), l.line(), l.column()),
            None => "<unknown location>".to_string(),
        },
        payload: truncate(&payload_text(info), MAX_PAYLOAD_BYTES),
        // Forced, rather than left to `RUST_BACKTRACE`. A user who is about to
        // file a crash report has not set that variable, and a panic record
        // without a backtrace does not name the code that panicked, which is
        // the entire question being asked. Cost is paid once, at death.
        backtrace: truncate(&Backtrace::force_capture().to_string(), MAX_BACKTRACE_BYTES),
    }
}

/// Write the report to both sinks.
fn write_report(report: &PanicReport) {
    // Durable first. See the module docs for why the tracing sink alone can
    // lose this line when the process is seconds from aborting.
    append_to_log_file(report);
    tracing::error!(
        target: PANIC_TARGET,
        thread = %report.thread,
        location = %report.location,
        version = env!("CARGO_PKG_VERSION"),
        backtrace = %report.backtrace,
        "{}",
        report.summary()
    );
}

/// The panic payload as text.
///
/// `panic!`, `assert!` and friends produce a `&str` or a `String`. A
/// `panic_any` with some other type has no textual form, so it is named rather
/// than guessed at.
fn payload_text(info: &PanicHookInfo<'_>) -> String {
    let payload = info.payload();
    if let Some(s) = payload.downcast_ref::<&str>() {
        (*s).to_string()
    } else if let Some(s) = payload.downcast_ref::<String>() {
        s.clone()
    } else {
        "<non-string panic payload>".to_string()
    }
}

/// `s` capped at `max` bytes, cut on a character boundary, with a marker
/// naming the full length so a truncated record never reads as a complete one.
fn truncate(s: &str, max: usize) -> String {
    if s.len() <= max {
        return s.to_string();
    }
    let mut end = max;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}... [truncated, {} bytes total]", &s[..end], s.len())
}

/// Append the record to today's rolling log file, if there is one.
fn append_to_log_file(report: &PanicReport) {
    let Some(sink) = FILE_SINK.get() else {
        return;
    };
    let now = chrono::Utc::now();
    let line = report.json_line(&now.to_rfc3339_opts(chrono::SecondsFormat::Micros, true));

    match reserve_append(&APPENDED_BYTES, line.len()) {
        // Budget spent. Whoever crossed the line already wrote the notice
        // below, so there is nothing left to say here: the record still goes
        // to stderr and the Logs viewer, just not to this file.
        Reservation::Refused => {}
        Reservation::Granted => {
            append_line(&sink.dir, &sink.prefix, sink.suffix, now, &line);
        }
        Reservation::Last => {
            append_line(&sink.dir, &sink.prefix, sink.suffix, now, &line);
            // Exactly one caller crosses the line, so this is said once.
            // Without it the file would simply stop carrying panics, which
            // reads the same as the silence this module exists to end.
            //
            // "no longer in this file" is the literal truth: past the budget
            // the append returns early AND the file layer drops `PANIC_TARGET`
            // (`init::file_sink_has_own_copy`, which exists to stop this record
            // being written twice). The record still reaches stderr and the
            // in-app Logs viewer, neither of which is this file.
            append_line(
                &sink.dir,
                &sink.prefix,
                sink.suffix,
                now,
                &format!(
                    "{{\"timestamp\":\"{}\",\"level\":\"ERROR\",\"fields\":{{\"message\":\
                     \"panic record budget spent ({MAX_APPEND_BYTES} bytes); further panics \
                     are reported on stderr and in the Logs viewer, not in this \
                     file\"}},\"target\":\"{PANIC_TARGET}\"}}\n",
                    now.to_rfc3339_opts(chrono::SecondsFormat::Micros, true)
                ),
            );
        }
    }
}

/// What [`reserve_append`] decided about one record.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Reservation {
    /// Room for it. Write and say nothing.
    Granted,
    /// Room for it, and it is the one that spends the budget. Write it, then
    /// say the file will carry no more.
    Last,
    /// The budget was already spent. Write nothing.
    Refused,
}

/// Claim `len` bytes of [`MAX_APPEND_BYTES`] for one record.
///
/// Reserve-then-write, not check-then-write: the whole point of the counter is
/// that two threads panicking at once cannot both read an under-budget total
/// and both write. `fetch_add` hands each caller a distinct `before`, so at
/// most one of them can see the total cross the ceiling, which is what makes
/// [`Reservation::Last`] fire exactly once.
///
/// The counter is clamped rather than left to run: it only ever needs to
/// answer "spent or not", and a process that panicked often enough to wrap a
/// `usize` (≈215k records on a 32-bit target) would otherwise hand the next
/// caller a fresh budget and a second "budget spent" line.
///
/// Takes the counter as a parameter so the accounting itself is testable; the
/// caller passes the process-global [`APPENDED_BYTES`].
fn reserve_append(spent: &AtomicUsize, len: usize) -> Reservation {
    let before = spent.fetch_add(len, Ordering::Relaxed);
    if before >= MAX_APPEND_BYTES {
        spent.store(MAX_APPEND_BYTES, Ordering::Relaxed);
        return Reservation::Refused;
    }
    if before.saturating_add(len) >= MAX_APPEND_BYTES {
        Reservation::Last
    } else {
        Reservation::Granted
    }
}

/// Append `line` to the daily file covering `now`, best effort.
///
/// Takes the location explicitly rather than reading the global, so the write
/// is testable against a temporary directory.
///
/// Every step is deliberately swallowed: this runs inside a panic hook, where
/// a second panic aborts immediately and loses the very record being written.
fn append_line(
    dir: &Path,
    prefix: &str,
    suffix: &str,
    now: chrono::DateTime<chrono::Utc>,
    line: &str,
) {
    let path = dir.join(crate::logging::budget::daily_file_name(prefix, suffix, now));
    if let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
    {
        let _ = file.write_all(line.as_bytes());
        let _ = file.flush();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The record's target must escape the `codeg_lib::logging=off` backstop
    /// that every constructed filter carries. Emitting from the module path
    /// would land inside it and silently drop the one line the hook exists to
    /// write, with no symptom other than the original silence.
    #[test]
    fn the_panic_target_escapes_the_logging_backstop() {
        assert!(
            !PANIC_TARGET.starts_with("codeg_lib::logging"),
            "{PANIC_TARGET} would be filtered out by the logging backstop"
        );
        // And it is still a well-formed target, so the Settings UI and
        // CODEG_LOG can name it.
        assert!(PANIC_TARGET
            .split("::")
            .all(|seg| !seg.is_empty()
                && seg.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')));
    }

    fn sample() -> PanicReport {
        PanicReport {
            thread: "tokio-runtime-worker (ThreadId(7))".into(),
            location: "src/acp/idle_sweep.rs:42:9".into(),
            payload: "called `Option::unwrap()` on a `None` value".into(),
            backtrace: "0: codeg_lib::acp::idle_sweep::sweep".into(),
        }
    }

    #[test]
    fn summary_names_the_thread_the_location_and_the_payload() {
        let summary = sample().summary();
        assert!(summary.contains("tokio-runtime-worker"), "{summary}");
        assert!(summary.contains("src/acp/idle_sweep.rs:42:9"), "{summary}");
        assert!(summary.contains("Option::unwrap()"), "{summary}");
    }

    #[test]
    fn json_line_is_one_parseable_line_carrying_the_backtrace() {
        let line = sample().json_line("2026-09-09T19:26:25.000000Z");
        assert!(line.ends_with('\n'), "the record must be a whole line");
        assert_eq!(
            line.matches('\n').count(),
            1,
            "one line, so a concurrent appender write can at worst interleave \
             two records instead of mangling this one: {line}"
        );

        let parsed: serde_json::Value =
            serde_json::from_str(line.trim_end()).expect("valid JSON line");
        assert_eq!(parsed["level"], "ERROR");
        assert_eq!(parsed["target"], PANIC_TARGET);
        assert_eq!(parsed["timestamp"], "2026-09-09T19:26:25.000000Z");
        assert_eq!(parsed["fields"]["backtrace"], sample().backtrace);
        assert_eq!(parsed["fields"]["version"], env!("CARGO_PKG_VERSION"));
        assert!(parsed["fields"]["message"]
            .as_str()
            .is_some_and(|m| m.contains("idle_sweep.rs:42:9")));
    }

    #[test]
    fn truncate_keeps_short_input_and_marks_what_it_dropped() {
        assert_eq!(truncate("short", 64), "short");
        let long = "x".repeat(200);
        let cut = truncate(&long, 32);
        assert!(cut.starts_with(&"x".repeat(32)), "{cut}");
        assert!(cut.contains("truncated"), "{cut}");
        assert!(
            cut.contains("200"),
            "the marker names the full length: {cut}"
        );
    }

    #[test]
    fn truncate_never_splits_a_character() {
        // A 3-byte character straddling the cap must be dropped whole, not
        // sliced into invalid UTF-8 (which would panic inside the panic hook).
        //
        // Asserting on the KEPT PREFIX, not on `is_char_boundary(0)` — index 0
        // is a boundary of every `str` ever built, so that assertion held no
        // matter what `truncate` did.
        let s = "aa\u{4f60}\u{597d}";
        for max in 0..s.len() {
            let cut = truncate(s, max);
            let kept = cut.split("... [truncated").next().expect("split yields one");
            assert!(
                s.starts_with(kept),
                "max={max} kept {kept:?}, which is not a prefix of {s:?}"
            );
            assert!(
                kept.len() <= max,
                "max={max} kept {} bytes: {kept:?}",
                kept.len()
            );
        }
        // A cap landing inside the 3-byte `你` (bytes 2..5) drops it whole…
        assert_eq!(truncate(s, 3).split("...").next(), Some("aa"));
        assert_eq!(truncate(s, 4).split("...").next(), Some("aa"));
        // …while a cap that IS a boundary keeps the character it ends after.
        assert_eq!(truncate(s, 5).split("...").next(), Some("aa\u{4f60}"));
        assert_eq!(truncate(s, 0).split("...").next(), Some(""));
    }

    /// The synchronous append is not covered by the daily log budget (it runs
    /// on the near side of the appender's channel), so it carries a ceiling of
    /// its own — otherwise a task that panics on every turn of a restart loop
    /// writes unbudgeted 20 KB records forever, which is the storm the budget
    /// exists to prevent.
    #[test]
    fn the_append_budget_stops_the_file_growing_without_end() {
        let dir = tempfile::tempdir().unwrap();
        let now = chrono::Utc::now();
        let path = dir
            .path()
            .join(crate::logging::budget::daily_file_name("codeg", "log", now));

        // The REAL accounting, against a local counter — the process-global
        // one is shared with every other test in this binary and must not be
        // moved. `append_to_log_file` does exactly this match.
        let spent = AtomicUsize::new(0);
        let line = "x".repeat(511) + "\n";
        let mut notices = 0;
        for _ in 0..(MAX_APPEND_BYTES / line.len() + 100) {
            match reserve_append(&spent, line.len()) {
                Reservation::Refused => continue,
                Reservation::Granted => append_line(dir.path(), "codeg", "log", now, &line),
                Reservation::Last => {
                    append_line(dir.path(), "codeg", "log", now, &line);
                    notices += 1;
                }
            }
        }

        let written = std::fs::metadata(&path).expect("file written").len() as usize;
        assert!(written > 0, "the first records must still be written");
        assert!(
            written <= MAX_APPEND_BYTES + line.len(),
            "the append must stop within one record of the budget, wrote {written}"
        );
        assert_eq!(notices, 1, "the file says once that it will carry no more");
        assert_eq!(
            spent.load(Ordering::Relaxed),
            MAX_APPEND_BYTES,
            "the counter is clamped, so it cannot wrap around into a fresh budget"
        );
    }

    /// The reservation is what makes concurrent panics safe: `fetch_add` gives
    /// each caller a distinct `before`, so the records that fit are written
    /// once each and the boundary is crossed by exactly one of them, however
    /// many threads are dying at the same moment.
    #[test]
    fn concurrent_reservations_spend_the_budget_exactly_once() {
        let spent = std::sync::Arc::new(AtomicUsize::new(0));
        let len = 64 * 1024;
        let granted = std::sync::Arc::new(AtomicUsize::new(0));
        let last = std::sync::Arc::new(AtomicUsize::new(0));

        let threads: Vec<_> = (0..8)
            .map(|_| {
                let spent = spent.clone();
                let granted = granted.clone();
                let last = last.clone();
                std::thread::spawn(move || {
                    for _ in 0..8 {
                        match reserve_append(&spent, len) {
                            Reservation::Granted => {
                                granted.fetch_add(1, Ordering::Relaxed);
                            }
                            Reservation::Last => {
                                last.fetch_add(1, Ordering::Relaxed);
                            }
                            Reservation::Refused => {}
                        }
                    }
                })
            })
            .collect();
        for t in threads {
            t.join().expect("no thread panicked");
        }

        assert_eq!(last.load(Ordering::Relaxed), 1, "spent exactly once");
        // Written as a bracket rather than an equality so it stays true for any
        // `len` — `fetch_add` tiles the budget into disjoint spans, so the
        // granted ones fall short of it and adding the last one reaches it.
        let written = (granted.load(Ordering::Relaxed) + 1) * len;
        assert!(
            written >= MAX_APPEND_BYTES && written - len < MAX_APPEND_BYTES,
            "every byte of the budget is accounted for, none twice: {written}"
        );
    }

    #[test]
    fn append_line_creates_todays_file_and_appends_to_it() {
        let dir = tempfile::tempdir().unwrap();
        let now = chrono::Utc::now();
        append_line(dir.path(), "codeg", "log", now, "first\n");
        append_line(dir.path(), "codeg", "log", now, "second\n");

        let name = crate::logging::budget::daily_file_name("codeg", "log", now);
        let body = std::fs::read_to_string(dir.path().join(name)).expect("record written");
        assert_eq!(body, "first\nsecond\n");
    }

    #[test]
    fn append_line_swallows_a_bad_destination_instead_of_panicking() {
        // A panic here would abort the process outright, so an unwritable
        // location has to be a no-op.
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("no").join("such").join("dir");
        append_line(&missing, "codeg", "log", chrono::Utc::now(), "dropped\n");
    }

    /// The capture path, exercised against a real panic. `PanicHookInfo` cannot
    /// be constructed outside one, so this installs a hook of its own (not
    /// [`install`], which is process-global and permanent) and unwinds into it.
    #[test]
    fn a_real_panic_yields_payload_location_and_backtrace() {
        use std::sync::{Arc, Mutex};

        let captured: Arc<Mutex<Option<PanicReport>>> = Arc::new(Mutex::new(None));
        let sink = captured.clone();
        // Only record this thread's panic: `cargo test` runs tests in parallel,
        // and a `should_panic` test elsewhere would otherwise land here.
        let want = std::thread::current().id();
        let previous = std::panic::take_hook();
        std::panic::set_hook(Box::new(move |info| {
            if std::thread::current().id() == want {
                if let Ok(mut slot) = sink.lock() {
                    *slot = Some(capture(info));
                }
            }
        }));
        let unwound = std::panic::catch_unwind(|| panic!("boom {}", 7));
        std::panic::set_hook(previous);

        assert!(unwound.is_err(), "the closure must have panicked");
        let report = captured
            .lock()
            .ok()
            .and_then(|mut slot| slot.take())
            .expect("the hook ran");
        assert_eq!(report.payload, "boom 7");
        assert!(
            report.location.contains("panic_hook.rs"),
            "location must name the panic site: {}",
            report.location
        );
        assert!(
            !report.backtrace.is_empty(),
            "the backtrace is forced, so it must be present without RUST_BACKTRACE"
        );
        assert!(
            report.thread.contains("ThreadId"),
            "the thread id identifies which task died: {}",
            report.thread
        );
    }
}
