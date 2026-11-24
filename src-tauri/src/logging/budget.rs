//! Per-day byte ceiling for the rolling file sink.
//!
//! `Rotation::DAILY` + `max_log_files(N)` (see [`crate::logging::init`]) bounds
//! how many *days* of logs are retained — it does not bound how large a single
//! day's file may grow. Nothing else did either, so any per-message log on a hot
//! path could fill the user's disk before the next rotation: a field report had
//! the desktop app write **34.36 GB in 8.8 hours** (~1 MB/s) from the appender
//! worker, and an earlier server incident reached 217 GB in one file. Per-target
//! clamps (`TARGET_BACKSTOPS`) close known firehoses one at a time; this closes
//! the class, including firehoses we haven't met yet.
//!
//! [`DayBudget`] is the pure accounting core — no clock, no I/O, no globals, so
//! the rollover/exhaustion logic is unit-testable outright (same split as
//! [`crate::logging::throttle::LeadingEdgeThrottle`]). [`BudgetedWriter`] is the
//! thin `io::Write` shell that wraps the rolling appender, reads the clock, and
//! reports notices.
//!
//! The day boundary is **UTC**, matching `tracing_appender`'s own rotation
//! stamp (it calls `OffsetDateTime::now_utc()`), so the budget window and the
//! file it bounds start and end together.
//!
//! Two properties the accounting has to get right, both of which cost a
//! correctness bug if skipped:
//!
//! - **The day is read on every line, not amortized.** An earlier draft re-read
//!   the clock only once per 64 KiB offered, to keep it off the hot path. That
//!   is wrong in both directions: with sparse traffic an exhausted day stayed
//!   latched for arbitrarily long *wall-clock* time after midnight (a whole
//!   day's diagnostics silently dropped), and in the other direction
//!   post-midnight bytes were charged to yesterday, letting the new file overrun
//!   its own ceiling. [`unix_day`] avoids the trade entirely: Unix time has no
//!   leap seconds, so `floor(secs / 86_400)` *is* the UTC day and needs no
//!   civil-date conversion — one clock read plus one integer division, cheap
//!   enough to do per line.
//! - **A restart resumes the day it lands in.** `tracing_appender` opens an
//!   existing dated file with `append(true)` (`rolling.rs:791`), so a process
//!   restarted on the same day keeps writing to a file that already has bytes in
//!   it. Starting the count at zero would hand out a fresh ceiling on every
//!   launch — and this app restarts itself (the `--supervise` worker, auto
//!   update), so a crash loop could grow one file without bound. [`resume_point`]
//!   measures what is already there and [`DayBudget::resuming`] starts from it.

use std::io::{self, Write};
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

/// Default ceiling for one day's log file. Generous enough that ordinary
/// `debug`/`trace` sessions finish inside it, small enough that a runaway
/// firehose can't take the disk: at the reported 1 MB/s storm rate this caps
/// the damage at ~9 minutes of writing instead of a whole day.
pub const DEFAULT_MAX_BYTES_PER_DAY: u64 = 512 * 1024 * 1024;

/// Env var overriding [`DEFAULT_MAX_BYTES_PER_DAY`]. `0` removes the ceiling
/// (for a deliberate long protocol-trace capture); a malformed value falls back
/// to the default rather than silently removing the bound.
pub const MAX_BYTES_ENV: &str = "CODEG_LOG_MAX_BYTES";

/// Seconds in a day. Unix time has no leap seconds, so every UTC day is exactly
/// this long and the day number is plain integer division.
const SECS_PER_DAY: i64 = 86_400;

/// The UTC day `secs` (a Unix timestamp) falls in, as a day number.
///
/// `div_euclid` rather than `/` so pre-1970 timestamps floor instead of
/// truncating toward zero; the absolute value is meaningless, only "same day"
/// and "changed day" matter.
fn unix_day_from_secs(secs: i64) -> i32 {
    secs.div_euclid(SECS_PER_DAY) as i32
}

/// The current UTC day number. See the module docs for why this is called per
/// line rather than amortized.
///
/// Handles a pre-1970 clock by signing the offset rather than clamping to day 0:
/// clamping made this disagree with [`resume_point`] (which goes through
/// `chrono` and yields a negative day), and a mismatch there silently discards
/// the restart seed. Absurd clocks aren't worth a bug, but they are worth the
/// two lines it takes to stay consistent.
fn unix_day() -> i32 {
    let now = SystemTime::now();
    let secs = match now.duration_since(UNIX_EPOCH) {
        Ok(d) => d.as_secs() as i64,
        Err(e) => -(e.duration().as_secs() as i64),
    };
    unix_day_from_secs(secs)
}

/// The name `tracing_appender` gives the `Rotation::DAILY` file covering `now`:
/// `{prefix}.{%Y-%m-%d}.{suffix}`.
///
/// Shared, because two things other than the appender need to name that exact
/// file and neither may drift from it: [`resume_point`] measures it, and
/// [`crate::logging::panic_hook`] appends a crash record to it synchronously.
pub fn daily_file_name(prefix: &str, suffix: &str, now: chrono::DateTime<chrono::Utc>) -> String {
    format!("{prefix}.{}.{suffix}", now.format("%Y-%m-%d"))
}

/// What a fresh [`BudgetedWriter`] must resume from: the current UTC day, and
/// how many bytes that day's file already holds.
///
/// The filename is reconstructed the way `tracing_appender` builds it for
/// `Rotation::DAILY` (see [`daily_file_name`]) from the *same* instant as the
/// day number, so the two can't disagree across a midnight boundary. A missing
/// or unreadable file reads as `0`: a restart that can't measure the file gets
/// a full ceiling, which is the pre-existing behavior and strictly safer than
/// refusing to log.
pub fn resume_point(dir: &Path, prefix: &str, suffix: &str) -> (i32, u64) {
    let now = chrono::Utc::now();
    let day = unix_day_from_secs(now.timestamp());
    let existing = std::fs::metadata(dir.join(daily_file_name(prefix, suffix, now)))
        .map(|m| m.len())
        .unwrap_or(0);
    (day, existing)
}

/// The configured ceiling, or `None` for "no ceiling".
///
/// Pure except for the env read + the malformed-value notice, so `init` can call
/// it before the subscriber exists.
pub fn configured_max_bytes_per_day() -> Option<u64> {
    let Ok(raw) = std::env::var(MAX_BYTES_ENV) else {
        return Some(DEFAULT_MAX_BYTES_PER_DAY);
    };
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Some(DEFAULT_MAX_BYTES_PER_DAY);
    }
    match trimmed.parse::<u64>() {
        Ok(0) => None,
        Ok(n) => Some(n),
        Err(_) => {
            // Pre-subscriber-safe channel (this runs while the subscriber is
            // being built), same as the other bootstrap diagnostics in `init`.
            eprintln!(
                "[logging] {MAX_BYTES_ENV}={raw:?} is not a byte count; \
                 using the default {DEFAULT_MAX_BYTES_PER_DAY} bytes/day"
            );
            Some(DEFAULT_MAX_BYTES_PER_DAY)
        }
    }
}

/// Whether a line offered to the sink should reach the file.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Verdict {
    Write,
    Drop,
}

/// A budget state change worth telling the operator about. Emitted at most once
/// per transition, never per dropped line — the whole point is to not add a log
/// storm of our own on top of the one we're suppressing.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Notice {
    /// The ceiling was just crossed; file logging is off for the rest of the day.
    Exhausted { limit: u64, written: u64 },
    /// A new day opened the budget again; reports what the closed day lost.
    Reopened { dropped_lines: u64, dropped_bytes: u64 },
}

impl Notice {
    /// Operator-facing text. Always names the env var, so the message itself
    /// explains how to lift the ceiling.
    pub fn message(self) -> String {
        match self {
            Notice::Exhausted { limit, written } => format!(
                "[logging] file log budget reached ({written} bytes written, limit {limit}); \
                 dropping further lines until the next daily rotation. \
                 Lower the log level, or set {MAX_BYTES_ENV}=0 to remove the ceiling."
            ),
            Notice::Reopened {
                dropped_lines,
                dropped_bytes,
            } => format!(
                "[logging] daily rotation reopened the file log; \
                 the previous day dropped {dropped_lines} line(s) / {dropped_bytes} bytes \
                 over the {MAX_BYTES_ENV} ceiling"
            ),
        }
    }
}

/// Pure per-day byte accounting. Feed it the current day and each offered line
/// length; it answers write-or-drop and hands back a [`Notice`] only on a state
/// transition.
///
/// Crossing the ceiling **latches** the day off rather than continuing to admit
/// whatever still fits. Under a real storm the two are indistinguishable (once
/// the total is within a line's length of the ceiling, nothing more fits), but
/// latching is what the [`Notice::Exhausted`] text promises and it keeps the
/// file honest: a reader sees a clean cut-off with a reason, not a file that
/// silently kept some lines and dropped others with no visible pattern.
#[derive(Debug)]
pub struct DayBudget {
    /// `None` = unbounded; every line is admitted and nothing is tracked.
    limit: Option<u64>,
    /// `None` until the first offered line establishes the current day.
    day: Option<i32>,
    written: u64,
    dropped_lines: u64,
    dropped_bytes: u64,
    /// Latched once the ceiling is crossed, cleared on rollover. Doubles as the
    /// announce-once flag: [`Notice::Exhausted`] is emitted on the transition.
    exhausted: bool,
}

impl DayBudget {
    /// A budget with no history: the first line establishes the day and the
    /// count starts at zero.
    pub fn new(limit: Option<u64>) -> Self {
        Self {
            limit,
            day: None,
            written: 0,
            dropped_lines: 0,
            dropped_bytes: 0,
            exhausted: false,
        }
    }

    /// A budget resuming `day` with `already_written` bytes already on disk —
    /// what a restart into a same-day file needs (see the module docs).
    ///
    /// No special case for `already_written` past the ceiling: the first line
    /// offered then fails the same check any other overrun does, and reports
    /// [`Notice::Exhausted`] once. And if the first line arrives on a *different*
    /// day (the process started seconds before midnight), the ordinary rollover
    /// path resets it — which is why the day travels with the byte count instead
    /// of being applied to whatever day shows up first.
    pub fn resuming(limit: Option<u64>, day: i32, already_written: u64) -> Self {
        Self {
            limit,
            day: Some(day),
            written: already_written,
            dropped_lines: 0,
            dropped_bytes: 0,
            exhausted: false,
        }
    }

    /// Bytes admitted to the file so far on the current day. Always `0` when
    /// there is no ceiling — with nothing to enforce, nothing is counted.
    pub fn written_today(&self) -> u64 {
        self.written
    }

    /// Account for a `len`-byte line offered on calendar day `today`.
    ///
    /// A day change always resets first, so the very next line after midnight is
    /// admitted even if the previous day was exhausted.
    ///
    /// Returns every notice the transition produced, in order. Usually zero;
    /// two only when one line both opens a new day and blows its whole budget
    /// (possible with a small configured ceiling), and neither may be dropped —
    /// silently losing the previous day's tally is the failure mode this whole
    /// module exists to prevent. `Vec::new()` doesn't allocate, so the common
    /// path stays free.
    pub fn admit(&mut self, today: i32, len: usize) -> (Verdict, Vec<Notice>) {
        let Some(limit) = self.limit else {
            return (Verdict::Write, Vec::new());
        };

        let mut notices = Vec::new();
        if self.day != Some(today) {
            // Rollover (or the very first line). Report the closed day's losses
            // only if it actually lost something — a quiet day stays quiet.
            if self.day.is_some() && self.dropped_lines > 0 {
                notices.push(Notice::Reopened {
                    dropped_lines: self.dropped_lines,
                    dropped_bytes: self.dropped_bytes,
                });
            }
            self.day = Some(today);
            self.written = 0;
            self.dropped_lines = 0;
            self.dropped_bytes = 0;
            self.exhausted = false;
        }

        let len = len as u64;
        // Compare against the total the line *would* reach, so a single huge
        // line can't jump the ceiling and land on disk anyway.
        if self.exhausted || self.written.saturating_add(len) > limit {
            self.dropped_lines = self.dropped_lines.saturating_add(1);
            self.dropped_bytes = self.dropped_bytes.saturating_add(len);
            if !self.exhausted {
                self.exhausted = true;
                notices.push(Notice::Exhausted {
                    limit,
                    written: self.written,
                });
            }
            return (Verdict::Drop, notices);
        }

        self.written = self.written.saturating_add(len);
        (Verdict::Write, notices)
    }
}

/// Identity of "today" on the same UTC boundary `tracing_appender` rotates on.
///
/// A trait (rather than a direct clock call) so [`BudgetedWriter`] can be driven
/// across a midnight rollover in a test without waiting for one.
pub trait DayClock: Send + 'static {
    fn today(&self) -> i32;
}

/// Production clock: UTC calendar day, matching `tracing_appender`'s rotation
/// stamp. Local time would put the budget window out of phase with the file it
/// bounds by up to a day's worth of offset.
#[derive(Debug, Clone, Copy, Default)]
pub struct UtcDayClock;

impl DayClock for UtcDayClock {
    fn today(&self) -> i32 {
        unix_day()
    }
}

/// Where budget notices go. The real sink is stderr + the in-app Logs viewer's
/// ring buffer; **never** `tracing` — this runs inside the subscriber's own file
/// sink, and routing it back through the subscriber would be a feedback loop.
pub trait NoticeSink: Send + 'static {
    fn report(&self, notice: Notice);
}

/// Production sink: stderr (matching the other bootstrap diagnostics) plus a
/// synthetic WARN record pushed straight into [`crate::logging::hub::LogHub`],
/// so the Settings → Logs viewer shows *why* the file went quiet. The direct
/// push bypasses the subscriber, so the `codeg_lib::logging=off` backstop can't
/// swallow it and no re-entrancy is possible.
#[derive(Debug, Clone, Copy, Default)]
pub struct StderrAndHubSink;

impl NoticeSink for StderrAndHubSink {
    fn report(&self, notice: Notice) {
        let message = notice.message();
        eprintln!("{message}");
        if let Some(hub) = crate::logging::hub::log_hub() {
            hub.record(crate::logging::hub::LogRecord {
                seq: hub.next_seq(),
                timestamp_ms: std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_millis() as u64)
                    .unwrap_or(0),
                level: "WARN",
                target: "codeg_lib::logging".to_string(),
                message,
                fields: Default::default(),
                spans: Vec::new(),
            });
        }
    }
}

/// Rolling-appender wrapper enforcing a [`DayBudget`].
///
/// Lives on the `tracing_appender` worker thread (it is the `W` handed to
/// `non_blocking`), so it is single-owner: no locks, no atomics.
pub struct BudgetedWriter<W, C = UtcDayClock, S = StderrAndHubSink> {
    inner: W,
    clock: C,
    sink: S,
    budget: DayBudget,
}

impl<W: Write> BudgetedWriter<W> {
    /// Wrap `inner` with the configured ceiling, the UTC day clock, and the
    /// stderr + hub notice sink, resuming `day`'s budget from
    /// `already_written` bytes (see [`resume_point`]).
    pub fn resuming(inner: W, limit: Option<u64>, day: i32, already_written: u64) -> Self {
        Self {
            inner,
            clock: UtcDayClock,
            sink: StderrAndHubSink,
            budget: DayBudget::resuming(limit, day, already_written),
        }
    }
}

impl<W: Write, C: DayClock, S: NoticeSink> BudgetedWriter<W, C, S> {
    pub fn with_parts(inner: W, clock: C, sink: S, budget: DayBudget) -> Self {
        Self {
            inner,
            clock,
            sink,
            budget,
        }
    }

}

impl<W: Write, C: DayClock, S: NoticeSink> Write for BudgetedWriter<W, C, S> {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        // Read per line, not amortized — see the module docs for the two bugs
        // amortizing caused. `unix_day()` is a clock read plus a division.
        let (verdict, notices) = self.budget.admit(self.clock.today(), buf.len());
        for notice in notices {
            self.sink.report(notice);
        }
        match verdict {
            Verdict::Write => self.inner.write(buf),
            // Report the line as consumed. `tracing_appender`'s worker treats a
            // short write / error as a failure to log and retries or complains;
            // dropping *is* the intended outcome here, so it must look like a
            // clean write.
            Verdict::Drop => Ok(buf.len()),
        }
    }

    fn flush(&mut self) -> io::Result<()> {
        self.inner.flush()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    const DAY: i32 = 739_000;

    #[test]
    fn unbounded_budget_admits_everything() {
        let mut b = DayBudget::new(None);
        for _ in 0..1000 {
            assert_eq!(b.admit(DAY, 1_000_000), (Verdict::Write, vec![]));
        }
        // Nothing is tracked when there is no ceiling.
        assert_eq!(b.written_today(), 0);
    }

    #[test]
    fn admits_up_to_the_ceiling_then_drops() {
        let mut b = DayBudget::new(Some(100));
        assert_eq!(b.admit(DAY, 60), (Verdict::Write, vec![]));
        assert_eq!(b.admit(DAY, 40), (Verdict::Write, vec![]));
        assert_eq!(b.written_today(), 100);
        // Exactly at the ceiling: the next line would exceed it.
        assert_eq!(
            b.admit(DAY, 1),
            (
                Verdict::Drop,
                vec![Notice::Exhausted {
                    limit: 100,
                    written: 100,
                }]
            )
        );
    }

    #[test]
    fn exhaustion_is_announced_once_and_latches_the_day_off() {
        let mut b = DayBudget::new(Some(10));
        assert_eq!(
            b.admit(DAY, 20).0,
            Verdict::Drop,
            "oversized first line"
        );
        // Only the first drop carries the notice, and the latch keeps dropping
        // lines that would otherwise still fit under the ceiling.
        for _ in 0..50 {
            assert_eq!(b.admit(DAY, 5), (Verdict::Drop, vec![]));
        }
        assert_eq!(b.written_today(), 0);
    }

    #[test]
    fn oversized_line_cannot_jump_the_ceiling() {
        let mut b = DayBudget::new(Some(100));
        assert_eq!(b.admit(DAY, 99), (Verdict::Write, vec![]));
        // 500 bytes would land the total at 599 — dropped, not written.
        assert_eq!(b.admit(DAY, 500).0, Verdict::Drop);
        assert_eq!(b.written_today(), 99, "the file never exceeds the ceiling");
    }

    #[test]
    fn rollover_reopens_the_budget_and_reports_the_loss() {
        let mut b = DayBudget::new(Some(10));
        assert_eq!(b.admit(DAY, 10), (Verdict::Write, vec![]));
        assert!(matches!(
            b.admit(DAY, 4).1.as_slice(),
            [Notice::Exhausted { .. }]
        ));
        assert_eq!(b.admit(DAY, 6), (Verdict::Drop, vec![]));
        // Next day: admitted again, and the closed day's losses are reported.
        assert_eq!(
            b.admit(DAY + 1, 3),
            (
                Verdict::Write,
                vec![Notice::Reopened {
                    dropped_lines: 2,
                    dropped_bytes: 10,
                }]
            )
        );
        assert_eq!(b.written_today(), 3, "counters reset on the new day");
        // And the new day can be exhausted independently.
        assert!(matches!(
            b.admit(DAY + 1, 100).1.as_slice(),
            [Notice::Exhausted { .. }]
        ));
    }

    /// One line can both open a new day and blow its entire budget (small
    /// configured ceiling). Both notices are then due, and dropping the rollover
    /// one would silently lose the closed day's tally — the exact
    /// "logs disappeared and nothing said why" failure this module prevents.
    #[test]
    fn rollover_and_exhaustion_in_one_line_report_both() {
        let mut b = DayBudget::new(Some(10));
        assert_eq!(b.admit(DAY, 10), (Verdict::Write, vec![]));
        assert!(matches!(
            b.admit(DAY, 7).1.as_slice(),
            [Notice::Exhausted { .. }]
        ));
        // First line of the new day is itself over the whole ceiling.
        let (verdict, notices) = b.admit(DAY + 1, 99);
        assert_eq!(verdict, Verdict::Drop);
        assert!(
            matches!(
                notices.as_slice(),
                [
                    Notice::Reopened {
                        dropped_lines: 1,
                        dropped_bytes: 7,
                    },
                    Notice::Exhausted { limit: 10, written: 0 },
                ]
            ),
            "rollover first, then exhaustion: {notices:?}"
        );
    }

    /// `tracing_appender` re-opens an existing dated file with `append(true)`
    /// (`rolling.rs:791`), so a restart lands in a file that already has bytes.
    /// Starting the count at zero handed out a fresh ceiling per launch — and
    /// this app restarts itself (the `--supervise` worker, auto update), so a
    /// crash loop could grow one file without bound.
    #[test]
    fn resuming_counts_bytes_already_in_todays_file() {
        let mut b = DayBudget::resuming(Some(100), DAY, 90);
        assert_eq!(b.written_today(), 90);
        assert_eq!(b.admit(DAY, 10), (Verdict::Write, vec![]));
        // The resumed 90 count toward the ceiling, so this crosses it.
        assert!(matches!(
            b.admit(DAY, 1).1.as_slice(),
            [Notice::Exhausted { limit: 100, .. }]
        ));
    }

    #[test]
    fn resuming_past_the_ceiling_drops_from_the_first_line() {
        // A restart into a file that is already over budget must not write at
        // all — no special case needed, the ordinary overrun check covers it.
        let mut b = DayBudget::resuming(Some(100), DAY, 5_000);
        let (verdict, notices) = b.admit(DAY, 1);
        assert_eq!(verdict, Verdict::Drop);
        assert!(matches!(notices.as_slice(), [Notice::Exhausted { .. }]));
    }

    #[test]
    fn resuming_resets_when_the_first_line_lands_on_a_new_day() {
        // Process started just before midnight: the seeded bytes belong to the
        // day they were measured on, so the first line of the next day gets a
        // clean budget rather than inheriting yesterday's total.
        let mut b = DayBudget::resuming(Some(100), DAY, 95);
        assert_eq!(b.admit(DAY + 1, 60), (Verdict::Write, vec![]));
        assert_eq!(b.written_today(), 60);
    }

    #[test]
    fn quiet_rollover_reports_nothing() {
        let mut b = DayBudget::new(Some(100));
        assert_eq!(b.admit(DAY, 10), (Verdict::Write, vec![]));
        // No drops on the closed day ⇒ no notice, just a reset.
        assert_eq!(b.admit(DAY + 1, 10), (Verdict::Write, vec![]));
        assert_eq!(b.written_today(), 10);
    }

    #[test]
    fn clock_running_backwards_still_resets_cleanly() {
        // A day identity that decreases (system clock corrected backwards) is
        // treated like any other change: reset, don't wedge.
        let mut b = DayBudget::new(Some(10));
        assert_eq!(b.admit(DAY, 10), (Verdict::Write, vec![]));
        assert_eq!(b.admit(DAY, 1).0, Verdict::Drop);
        assert_eq!(b.admit(DAY - 1, 5).0, Verdict::Write);
    }

    // ---- BudgetedWriter ----

    #[derive(Clone)]
    struct FixedClock(Arc<Mutex<i32>>);
    impl DayClock for FixedClock {
        fn today(&self) -> i32 {
            *self.0.lock().unwrap()
        }
    }

    #[derive(Clone, Default)]
    struct RecordingSink(Arc<Mutex<Vec<Notice>>>);
    impl NoticeSink for RecordingSink {
        fn report(&self, notice: Notice) {
            self.0.lock().unwrap().push(notice);
        }
    }

    #[derive(Clone, Default)]
    struct CountingWriter(Arc<Mutex<Vec<u8>>>);
    impl Write for CountingWriter {
        fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(buf);
            Ok(buf.len())
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn writer_stops_writing_past_the_ceiling_but_reports_success() {
        let file = CountingWriter::default();
        let notices = RecordingSink::default();
        let clock = FixedClock(Arc::new(Mutex::new(DAY)));
        let mut w = BudgetedWriter::with_parts(
            file.clone(),
            clock.clone(),
            notices.clone(),
            DayBudget::new(Some(16)),
        );

        assert_eq!(w.write(b"12345678").unwrap(), 8);
        assert_eq!(w.write(b"12345678").unwrap(), 8);
        // Over the ceiling: still reported as fully written so the appender
        // worker doesn't treat it as an I/O failure, but nothing reaches disk.
        assert_eq!(w.write(b"dropped").unwrap(), 7);
        assert_eq!(file.0.lock().unwrap().len(), 16);
        assert!(matches!(
            notices.0.lock().unwrap().as_slice(),
            [Notice::Exhausted { limit: 16, .. }]
        ));
    }

    /// The day is read on EVERY line, so the very first line after midnight
    /// reopens the budget. An earlier draft amortized the clock read over 64 KiB
    /// of offered bytes, which meant a sparse-traffic app could stay latched for
    /// hours — or days — of wall time past the rollover, silently dropping a
    /// whole day of diagnostics.
    #[test]
    fn writer_reopens_on_the_first_line_of_the_new_day() {
        let file = CountingWriter::default();
        let notices = RecordingSink::default();
        let day = Arc::new(Mutex::new(DAY));
        let mut w = BudgetedWriter::with_parts(
            file.clone(),
            FixedClock(Arc::clone(&day)),
            notices.clone(),
            DayBudget::new(Some(4)),
        );

        w.write_all(b"aaaa").unwrap();
        w.write_all(b"bbbb").unwrap();
        assert_eq!(file.0.lock().unwrap().len(), 4, "second line dropped");

        // One tick past midnight, with no intervening traffic at all.
        *day.lock().unwrap() = DAY + 1;
        w.write_all(b"cccc").unwrap();
        assert_eq!(
            file.0.lock().unwrap().len(),
            8,
            "the first line of the new day must be admitted"
        );
        let seen = notices.0.lock().unwrap().clone();
        assert!(
            matches!(
                seen.as_slice(),
                [Notice::Exhausted { .. }, Notice::Reopened { .. }]
            ),
            "{seen:?}"
        );
    }

    #[test]
    fn writer_resumes_a_seeded_day() {
        // Restart into a file that already holds 3 of its 4 allowed bytes.
        let file = CountingWriter::default();
        let notices = RecordingSink::default();
        let mut w = BudgetedWriter::with_parts(
            file.clone(),
            FixedClock(Arc::new(Mutex::new(DAY))),
            notices.clone(),
            DayBudget::resuming(Some(4), DAY, 3),
        );
        w.write_all(b"a").unwrap();
        w.write_all(b"b").unwrap();
        assert_eq!(
            file.0.lock().unwrap().len(),
            1,
            "only the byte that fits under the resumed total is written"
        );
    }

    #[test]
    fn writer_without_a_ceiling_passes_everything_through() {
        let file = CountingWriter::default();
        let notices = RecordingSink::default();
        let mut w = BudgetedWriter::with_parts(
            file.clone(),
            FixedClock(Arc::new(Mutex::new(DAY))),
            notices.clone(),
            DayBudget::new(None),
        );
        for _ in 0..100 {
            w.write_all(b"0123456789").unwrap();
        }
        assert_eq!(file.0.lock().unwrap().len(), 1000);
        assert!(notices.0.lock().unwrap().is_empty());
    }

    #[test]
    fn unix_day_boundaries_land_on_utc_midnight() {
        // 1970-01-01T00:00:00Z .. 23:59:59Z is day 0; the next second is day 1.
        assert_eq!(unix_day_from_secs(0), 0);
        assert_eq!(unix_day_from_secs(SECS_PER_DAY - 1), 0);
        assert_eq!(unix_day_from_secs(SECS_PER_DAY), 1);
        // Pre-epoch floors instead of truncating toward zero, so a day is still
        // one contiguous range rather than two half-days sharing a number.
        assert_eq!(unix_day_from_secs(-1), -1);
        assert_eq!(unix_day_from_secs(-SECS_PER_DAY), -1);
        assert_eq!(unix_day_from_secs(-SECS_PER_DAY - 1), -2);
        // Cross-check one real date against chrono: 2026-08-08T00:00:00Z.
        let midnight = chrono::DateTime::parse_from_rfc3339("2026-08-08T00:00:00Z").unwrap();
        let before = chrono::DateTime::parse_from_rfc3339("2026-08-07T23:59:59Z").unwrap();
        assert_eq!(
            unix_day_from_secs(midnight.timestamp()),
            unix_day_from_secs(before.timestamp()) + 1
        );
    }

    /// Two readers now reconstruct this name (the budget's resume measurement
    /// and the panic hook's synchronous append), so the scheme is pinned rather
    /// than left implicit in each of them.
    #[test]
    fn daily_file_name_matches_the_appenders_scheme() {
        let day = chrono::DateTime::parse_from_rfc3339("2026-09-09T19:26:25Z")
            .unwrap()
            .with_timezone(&chrono::Utc);
        assert_eq!(daily_file_name("codeg", "log", day), "codeg.2026-09-09.log");
        assert_eq!(
            daily_file_name("codeg-server", "log", day),
            "codeg-server.2026-09-09.log"
        );
    }

    #[test]
    fn resume_point_measures_todays_file_and_ignores_other_days() {
        let dir = tempfile::tempdir().unwrap();
        let now = chrono::Utc::now();
        let today = now.format("%Y-%m-%d").to_string();
        // Same naming scheme tracing_appender uses for Rotation::DAILY.
        std::fs::write(dir.path().join(format!("codeg.{today}.log")), vec![b'x'; 77]).unwrap();
        // A different day's file, and an unrelated file, must not be counted.
        std::fs::write(dir.path().join("codeg.1999-01-01.log"), vec![b'x'; 5000]).unwrap();
        std::fs::write(dir.path().join("codeg-server.log"), vec![b'x'; 5000]).unwrap();

        let (day, existing) = resume_point(dir.path(), "codeg", "log");
        assert_eq!(existing, 77);
        assert_eq!(day, unix_day_from_secs(now.timestamp()));

        // A prefix with no file today reads as a clean slate, not an error.
        let (_, none) = resume_point(dir.path(), "codeg-server", "log");
        assert_eq!(none, 0);
    }

    #[test]
    fn notice_messages_name_the_env_var() {
        for notice in [
            Notice::Exhausted {
                limit: 1,
                written: 1,
            },
            Notice::Reopened {
                dropped_lines: 1,
                dropped_bytes: 1,
            },
        ] {
            assert!(
                notice.message().contains(MAX_BYTES_ENV),
                "the notice must tell the operator how to lift the ceiling: {}",
                notice.message()
            );
        }
    }

    #[test]
    fn configured_max_bytes_reads_the_env() {
        temp_env::with_var(MAX_BYTES_ENV, None::<&str>, || {
            assert_eq!(
                configured_max_bytes_per_day(),
                Some(DEFAULT_MAX_BYTES_PER_DAY)
            );
        });
        temp_env::with_var(MAX_BYTES_ENV, Some("0"), || {
            assert_eq!(configured_max_bytes_per_day(), None, "0 = no ceiling");
        });
        temp_env::with_var(MAX_BYTES_ENV, Some(" 4096 "), || {
            assert_eq!(configured_max_bytes_per_day(), Some(4096));
        });
        // Malformed must NOT silently remove the bound.
        temp_env::with_var(MAX_BYTES_ENV, Some("lots"), || {
            assert_eq!(
                configured_max_bytes_per_day(),
                Some(DEFAULT_MAX_BYTES_PER_DAY)
            );
        });
        temp_env::with_var(MAX_BYTES_ENV, Some(""), || {
            assert_eq!(
                configured_max_bytes_per_day(),
                Some(DEFAULT_MAX_BYTES_PER_DAY)
            );
        });
    }
}
