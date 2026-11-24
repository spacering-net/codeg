//! Following something the runtime does on its own — a run, an automation
//! run, an install — until it ends or the command's `--wait` runs out.
//!
//! Each look is a request the runtime holds up to 25 s while nothing
//! changes. A runtime that answers at once instead (an older one) is looked
//! at again a second later, not straight away. One that stops answering is
//! given 30 s to come back.

use std::future::Future;
use std::time::Duration;

use tokio::time::Instant;

use crate::cli_run::wire::Subtype;

use super::Failure;

/// The longest one look waits on the runtime; the request itself, ten
/// seconds longer.
pub const LOOK_WAIT: Duration = Duration::from_secs(25);
pub const LOOK_SLACK: Duration = Duration::from_secs(10);
const RECHECK: Duration = Duration::from_secs(1);
const LOST_AFTER: Duration = Duration::from_secs(30);

/// Look with `look(wait)` until `over` says so or `deadline` (none: no end)
/// passes; the last answer, either way.
pub async fn follow<T, F, Fut>(
    deadline: Option<Instant>,
    mut look: F,
    over: impl Fn(&T) -> bool,
) -> Result<T, Failure>
where
    F: FnMut(Duration) -> Fut,
    Fut: Future<Output = Result<T, Failure>>,
{
    let mut unreachable_since: Option<Instant> = None;
    loop {
        let left = deadline.map(|d| d.saturating_duration_since(Instant::now()));
        let wait = left.unwrap_or(LOOK_WAIT).min(LOOK_WAIT);
        let asked = Instant::now();
        match look(wait).await {
            Ok(answer) => {
                unreachable_since = None;
                if over(&answer) || left.is_some_and(|l| l.is_zero()) {
                    return Ok(answer);
                }
                if deadline.is_some_and(|d| Instant::now() >= d) {
                    return Ok(answer);
                }
                if asked.elapsed() < wait / 2 {
                    pause(deadline).await;
                }
            }
            Err(f) if is_transient(&f) => {
                let since = *unreachable_since.get_or_insert(asked);
                if since.elapsed() > LOST_AFTER || deadline.is_some_and(|d| Instant::now() >= d) {
                    return Err(f);
                }
                pause(deadline).await;
            }
            Err(f) => return Err(f),
        }
    }
}

/// A second, or what is left before `deadline` if that is less.
async fn pause(deadline: Option<Instant>) {
    let pause = match deadline {
        Some(d) => RECHECK.min(d.saturating_duration_since(Instant::now())),
        None => RECHECK,
    };
    tokio::time::sleep(pause).await;
}

pub fn is_transient(failure: &Failure) -> bool {
    failure.subtype == Subtype::ErrorRuntimeUnavailable && failure.code == "runtime_unavailable"
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};
    use std::sync::Arc;

    #[tokio::test(start_paused = true)]
    async fn it_stops_when_the_thing_is_over() {
        let looks = Arc::new(AtomicU32::new(0));
        let counted = Arc::clone(&looks);
        let got = follow(
            None,
            move |_| {
                let n = counted.fetch_add(1, Ordering::SeqCst) + 1;
                async move { Ok::<_, Failure>(n) }
            },
            |n| *n == 3,
        )
        .await
        .unwrap();
        assert_eq!(got, 3);
        assert_eq!(looks.load(Ordering::SeqCst), 3);
    }

    #[tokio::test(start_paused = true)]
    async fn the_deadline_ends_it_with_the_last_answer() {
        let deadline = Instant::now() + Duration::from_secs(5);
        let got = follow(
            Some(deadline),
            |_| async { Ok::<_, Failure>("running") },
            |s| *s != "running",
        )
        .await
        .unwrap();
        assert_eq!(got, "running");
        assert!(Instant::now() >= deadline);
        // No deadline left at all: one look, then the answer as it stands.
        let past = Some(Instant::now());
        let looks = Arc::new(AtomicU32::new(0));
        let counted = Arc::clone(&looks);
        follow(
            past,
            move |_| {
                counted.fetch_add(1, Ordering::SeqCst);
                async { Ok::<_, Failure>(0) }
            },
            |_| false,
        )
        .await
        .unwrap();
        assert_eq!(looks.load(Ordering::SeqCst), 1);
    }

    #[tokio::test(start_paused = true)]
    async fn a_runtime_gone_for_good_ends_it() {
        let err = follow(
            None,
            |_| async {
                Err::<(), _>(Failure::new(
                    Subtype::ErrorRuntimeUnavailable,
                    "runtime_unavailable",
                    "nothing answered",
                ))
            },
            |_| true,
        )
        .await
        .unwrap_err();
        assert_eq!(err.code, "runtime_unavailable");
        // Anything else is not waited out.
        let err = follow(
            None,
            |_| async { Err::<(), _>(Failure::usage("bad", "no")) },
            |_| true,
        )
        .await
        .unwrap_err();
        assert_eq!(err.code, "bad");
    }
}
