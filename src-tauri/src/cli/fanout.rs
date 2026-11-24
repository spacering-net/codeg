//! One prompt, several runs: every `-a` and `-A` is a target, numbered from 1
//! in the order the command line gives them —
//! `codeg-cli -a claude_code -A reviewer -a codex -p "review the diff"`; the
//! same one twice is a best-of-N.
//!
//! The prompt is read and the runtime found once. Each target is then a run
//! of its own (reserve, start, events, result), at most `--max-parallel` at a
//! time, the rest waiting their turn within the same `--timeout`. A signal
//! cancels them all. Output keeps target order: `text` prints each reply
//! under a `== #<n> <name> (<run>) ==` line, `json` an array of result
//! objects, `stream-json` the runs' events as they come (each carries its
//! `run_id`) and each result as its run ends. `-o review.md` writes
//! `review.<n>-<name>.md`. The exit code is the first failed target's, in
//! target order — 0 when every run succeeded, 130/143 when interrupted.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicI32, Ordering};
use std::sync::Arc;
use std::time::Duration;

use serde_json::json;
use tokio::sync::{watch, Semaphore};
use tokio::time::Instant;

use crate::cli_run::wire::{CancelReason, EventBody, RunEvent};
use crate::cli_run::worktree::MAX_NAME;
use crate::cli_run::PermissionPolicy;

use super::args::{GlobalArgs, OutputFormat, RunArgs, Target};
use super::connect::Env;
use super::render::{self, Output, RunRef};
use super::run::{
    drive, prepare, reserve, start_request, within, write_output, Driven, Interrupts, Prepared,
    Signals,
};
use super::Failure;

/// What became of one target.
enum Outcome {
    /// Its result event, tagged with the target; the signal that interrupted
    /// it, if one did.
    Settled {
        event: RunEvent,
        signal_code: Option<i32>,
    },
    /// `--detach`: its `init`.
    Detached(RunEvent),
    /// It failed on this side; `event` is the result object made up for it.
    Failed { event: RunEvent, failure: Failure },
}

impl Outcome {
    fn result_event(&self) -> &RunEvent {
        match self {
            Self::Settled { event, .. } | Self::Failed { event, .. } => event,
            Self::Detached(init) => init,
        }
    }

    fn exit_code(&self) -> i32 {
        match self {
            Self::Settled { event, signal_code } => {
                render::exit_code(event.result().expect("a result"), *signal_code)
            }
            Self::Detached(_) => 0,
            Self::Failed { failure, .. } => failure.exit_code(),
        }
    }
}

pub async fn run(global: &GlobalArgs, args: RunArgs, env: &Env) -> i32 {
    let out = Output::new(args.output_format, global);
    out.hint_denials(PermissionPolicy::from(args.permissions) == PermissionPolicy::Deny);
    out.structured(args.output_schema.is_some());
    let heartbeat = out.spawn_heartbeat();
    let deadline = args.timeout.and_then(|d| Instant::now().checked_add(d));

    // One listener for the process's signals, counting them for every run —
    // a run that starts listening late still hears what came before — so
    // the first cancels them all and a second makes them all quit.
    let (signals_tx, signals_rx) = watch::channel((0u32, 0i32));
    let first_signal = Arc::new(AtomicI32::new(0));
    let listener = {
        let first = Arc::clone(&first_signal);
        let mut signals = Signals::install();
        tokio::spawn(async move {
            loop {
                let code = signals.recv().await;
                let _ = first.compare_exchange(0, code, Ordering::SeqCst, Ordering::SeqCst);
                signals_tx.send_modify(|(count, last)| {
                    *count += 1;
                    *last = code;
                });
            }
        })
    };

    let mut setup_interrupts = Interrupts::shared(signals_rx.clone());
    let prepared = tokio::select! {
        prepared = prepare(global, &args, env, &out, deadline) => prepared,
        code = setup_interrupts.recv() => Err(Failure::interrupted(
            code,
            "interrupted before the runs started; nothing was sent",
        )),
    };
    let outcomes = match prepared {
        Ok(prepared) => {
            let prepared = Arc::new(prepared);
            let mut outcomes = fan_out(
                &args,
                env,
                &out,
                deadline,
                Arc::clone(&prepared),
                &signals_rx,
            )
            .await;
            let signal = first_signal.load(Ordering::SeqCst);
            if args.detach && signal != 0 {
                cancel_detached(&out, &args, &prepared, &mut outcomes, signal).await;
            }
            outcomes
        }
        Err(failure) => {
            // Said once; but every target has its result object, so a script
            // reads the array the same way whatever failed.
            out.error_lines(&failure.message, &failure.next_steps);
            args.targets
                .iter()
                .enumerate()
                .map(|(i, target)| {
                    let event = tag(
                        out.failure_event(&failure, &RunRef::default()),
                        i + 1,
                        target,
                    );
                    if out.format() == OutputFormat::StreamJson {
                        Output::json_line(&event);
                    }
                    Outcome::Failed {
                        event,
                        failure: failure.clone(),
                    }
                })
                .collect()
        }
    };
    listener.abort();
    report(&out, &args, &outcomes);
    if let Some(h) = heartbeat {
        h.abort();
    }
    match first_signal.load(Ordering::SeqCst) {
        0 => outcomes
            .iter()
            .map(Outcome::exit_code)
            .find(|code| *code != 0)
            .unwrap_or(0),
        signal => signal,
    }
}

/// Every target's run, `--max-parallel` at a time; their outcomes in target
/// order. In `stream-json`, each result is printed the moment its run ends.
async fn fan_out(
    args: &RunArgs,
    env: &Env,
    out: &Arc<Output>,
    deadline: Option<Instant>,
    prepared: Arc<Prepared>,
    signals: &watch::Receiver<(u32, i32)>,
) -> Vec<Outcome> {
    if args.worktree.is_none()
        && PermissionPolicy::from(args.permissions) == PermissionPolicy::Allow
    {
        out.note(&format!(
            "codeg-cli: warning: {} runs may change {} at the same time; --worktree gives each \
             its own worktree",
            args.targets.len(),
            prepared.workspace
        ));
    }
    let permits = Arc::new(Semaphore::new(usize::from(args.max_parallel.max(1))));
    let args = Arc::new(args.clone());
    let mut tasks = tokio::task::JoinSet::new();
    for (i, target) in args.targets.iter().cloned().enumerate() {
        let index = i + 1;
        let child = out.child(format!("#{index} {}", target.label()));
        let job = Job {
            index,
            target,
            args: Arc::clone(&args),
            prepared: Arc::clone(&prepared),
            env: env.clone(),
            out: child,
            deadline,
            permits: Arc::clone(&permits),
        };
        let interrupts = Interrupts::shared(signals.clone());
        tasks.spawn(async move { (index, job.run(interrupts).await) });
    }
    let mut outcomes: Vec<Option<Outcome>> = (0..args.targets.len()).map(|_| None).collect();
    while let Some(joined) = tasks.join_next().await {
        let (index, outcome) = joined.expect("a run's task does not panic");
        if out.format() == OutputFormat::StreamJson {
            Output::json_line(outcome.result_event());
        }
        if let Outcome::Settled { event, .. } | Outcome::Failed { event, .. } = &outcome {
            if let Some(error) = event.result().and_then(|r| r.error.as_ref()) {
                out.child(format!("#{index} {}", args.targets[index - 1].label()))
                    .error_lines(&error.message, &error.next_steps);
            }
        }
        outcomes[index - 1] = Some(outcome);
    }
    outcomes
        .into_iter()
        .map(|o| o.expect("every target ran"))
        .collect()
}

/// Interrupted while it started detached runs: the ones already started are
/// cancelled too. The command never said their ids, so nothing else would
/// ever collect them.
async fn cancel_detached(
    out: &Output,
    args: &RunArgs,
    prepared: &Prepared,
    outcomes: &mut [Outcome],
    signal: i32,
) {
    let mut cancels = tokio::task::JoinSet::new();
    for (i, outcome) in outcomes.iter_mut().enumerate() {
        let Outcome::Detached(init) = outcome else {
            continue;
        };
        let Some(run_id) = init.run_id.clone() else {
            continue;
        };
        let conn = prepared.conn.clone();
        let cancel = json!({ "runId": run_id, "reason": CancelReason::Interrupt });
        cancels.spawn(async move {
            let _ = conn
                .post::<_, serde_json::Value>("cli_run_cancel", &cancel, Duration::from_secs(10))
                .await;
        });
        let run = match &init.body {
            EventBody::Init {
                conversation_id,
                link,
                agent,
                assistant,
                worktree,
                ..
            } => RunRef {
                run_id: init.run_id.clone(),
                conversation_id: Some(*conversation_id),
                link: Some(link.clone()),
                agent: Some(agent.clone()),
                assistant: assistant.clone(),
                worktree: worktree.clone(),
            },
            _ => RunRef::default(),
        };
        let failure = Failure::interrupted(signal, "interrupted; the run was cancelled");
        let event = tag(out.failure_event(&failure, &run), i + 1, &args.targets[i]);
        if out.format() == OutputFormat::StreamJson {
            Output::json_line(&event);
        }
        *outcome = Outcome::Failed { event, failure };
    }
    let _ = tokio::time::timeout(Duration::from_secs(10), async {
        while cancels.join_next().await.is_some() {}
    })
    .await;
}

/// One target's run.
struct Job {
    index: usize,
    target: Target,
    args: Arc<RunArgs>,
    prepared: Arc<Prepared>,
    env: Env,
    out: Arc<Output>,
    deadline: Option<Instant>,
    permits: Arc<Semaphore>,
}

impl Job {
    async fn run(self, mut interrupts: Interrupts) -> Outcome {
        let mut run_ref = RunRef {
            agent: self.target.agent(),
            ..RunRef::default()
        };
        let outcome = self.start_and_follow(&mut interrupts, &mut run_ref).await;
        match outcome {
            Ok(Driven::Settled { event, signal_code }) => {
                let output = self
                    .args
                    .output
                    .as_deref()
                    .map(|p| output_for(p, self.index, self.target.label()));
                let event = write_output(&self.out, output.as_deref(), &event);
                Outcome::Settled {
                    event: tag(event, self.index, &self.target),
                    signal_code,
                }
            }
            Ok(Driven::Detached(init)) => Outcome::Detached(init),
            Err(failure) => Outcome::Failed {
                event: tag(
                    self.out.failure_event(&failure, &run_ref),
                    self.index,
                    &self.target,
                ),
                failure,
            },
        }
    }

    async fn start_and_follow(
        &self,
        interrupts: &mut Interrupts,
        run_ref: &mut RunRef,
    ) -> Result<Driven, Failure> {
        // Its turn, then its run id: until both, nothing was sent for it.
        let reserved = tokio::select! {
            reserved = async {
                let permit = Arc::clone(&self.permits)
                    .acquire_owned()
                    .await
                    .expect("the permits are never closed");
                let reserved = within(self.deadline, reserve(&self.prepared.conn)).await??;
                Ok::<_, Failure>((permit, reserved))
            } => reserved?,
            code = interrupts.recv() => {
                return Err(Failure::interrupted(
                    code,
                    "interrupted before this run started; nothing was sent for it",
                ));
            }
        };
        let (_permit, reserved) = reserved;
        run_ref.run_id = Some(reserved.run_id.clone());
        let worktree = self.args.worktree.as_deref().map(|name| {
            if name.is_empty() {
                String::new()
            } else {
                // One worktree per target, told apart by its number.
                let room = MAX_NAME - 4;
                format!("{}-{}", &name[..name.len().min(room)], self.index)
            }
        });
        let request = start_request(
            &self.args,
            Some(&self.target),
            &self.prepared,
            reserved.run_id,
            worktree,
            self.deadline,
            &self.env,
        );
        drive(
            &self.prepared.conn,
            &self.args,
            &self.out,
            self.deadline,
            request,
            run_ref,
            interrupts,
        )
        .await
    }
}

/// `event`'s result, marked with the target it is for: its number, and the
/// agent asked for when the run never got to say which.
fn tag(mut event: RunEvent, index: usize, target: &Target) -> RunEvent {
    if let EventBody::Result(result) = &mut event.body {
        result.target_index = Some(index);
        if result.agent.is_none() && result.assistant.is_none() {
            result.agent = target.agent();
        }
    }
    event
}

/// The end of the command: in `text` each reply under its target's line, in
/// `json` the array of result objects (`--detach`: of `init` events) — both
/// in target order. `stream-json` printed its lines as the runs ended.
fn report(out: &Output, args: &RunArgs, outcomes: &[Outcome]) {
    match out.format() {
        OutputFormat::StreamJson => {}
        OutputFormat::Json => {
            let all: Vec<&RunEvent> = outcomes.iter().map(Outcome::result_event).collect();
            Output::json_line(&all);
        }
        OutputFormat::Text if args.detach => {
            // One line per target, its run's id — empty for one that failed —
            // so line n is target n's.
            for outcome in outcomes {
                match outcome {
                    Outcome::Detached(init) => {
                        println!("{}", init.run_id.as_deref().unwrap_or_default())
                    }
                    _ => println!(),
                }
            }
        }
        OutputFormat::Text => {
            for (i, outcome) in outcomes.iter().enumerate() {
                let event = outcome.result_event();
                let run = event
                    .run_id
                    .as_deref()
                    .map(|id| id.chars().take(8).collect::<String>())
                    .unwrap_or_else(|| "not started".into());
                let heading = format!("== #{} {} ({run}) ==", i + 1, args.targets[i].label());
                if args.output_schema.is_some() {
                    // stdout holds JSON alone: a line per target, so line n is
                    // target n's. The heading goes to stderr, which a terminal
                    // shows in the same place.
                    out.note(&heading);
                    Output::reply(&structured_line(event));
                    continue;
                }
                println!("{heading}");
                if let Some(reply) = event.result().and_then(render::reply_text) {
                    Output::reply(&reply);
                }
            }
        }
    }
    let refused: usize = outcomes
        .iter()
        .filter_map(|o| o.result_event().result())
        .map(|r| r.permission_denials.len())
        .sum();
    out.denial_hint(refused);
    if out.format() == OutputFormat::Text && !args.detach {
        for outcome in outcomes {
            if let Some(link) = outcome
                .result_event()
                .result()
                .and_then(|r| r.link.as_deref())
            {
                out.progress_line(&format!("conversation: {link}"));
            }
        }
    }
}

/// A target's line of `text` with `--output-schema`: its result's JSON, or
/// `null` when it has none.
fn structured_line(event: &RunEvent) -> String {
    event
        .result()
        .and_then(render::reply_text)
        .unwrap_or_else(|| "null".into())
}

/// `-o review.md` for target 2, `codex`: `review.2-codex.md`. The target's
/// name keeps only what a file name may hold on every platform (`custom:x`
/// becomes `custom_x`); the number keeps two runs of one agent apart.
pub fn output_for(path: &Path, index: usize, label: &str) -> PathBuf {
    let name: String = label
        .chars()
        .map(|c| {
            if c.is_control() || r#"<>:"/\|?*"#.contains(c) {
                '_'
            } else {
                c
            }
        })
        .collect();
    let name = name.trim_end_matches(['.', ' ']);
    let file = match (path.file_stem(), path.extension()) {
        (Some(stem), Some(ext)) => format!(
            "{}.{index}-{name}.{}",
            stem.to_string_lossy(),
            ext.to_string_lossy()
        ),
        _ => format!(
            "{}.{index}-{name}",
            path.file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_else(|| "output".into())
        ),
    };
    path.with_file_name(file)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cli_run::wire::Subtype;

    #[test]
    fn every_target_writes_a_file_of_its_own() {
        let p = Path::new("out/review.md");
        assert_eq!(
            output_for(p, 1, "codex"),
            PathBuf::from("out/review.1-codex.md")
        );
        assert_eq!(
            output_for(p, 2, "codex"),
            PathBuf::from("out/review.2-codex.md")
        );
        // What Windows would refuse in a file name becomes `_`.
        assert_eq!(
            output_for(p, 3, "custom:my/agent?"),
            PathBuf::from("out/review.3-custom_my_agent_.md")
        );
        assert_eq!(
            output_for(Path::new("review"), 1, "Reviewer."),
            PathBuf::from("review.1-Reviewer")
        );
        assert_eq!(
            output_for(Path::new("a.tar.gz"), 1, "x"),
            PathBuf::from("a.tar.1-x.gz")
        );
    }

    /// With `--output-schema`, a target's line is its result's JSON — or
    /// `null`, for one without, or for a run that never got that far.
    #[test]
    fn a_structured_targets_line_is_its_json_or_null() {
        let result = |structured_output| {
            RunEvent::new(
                3,
                Some("r".into()),
                EventBody::Result(Box::new(crate::cli_run::wire::RunResult {
                    subtype: Subtype::Success,
                    is_error: false,
                    result: Some("Done.".into()),
                    session_id: None,
                    stop_reason: None,
                    duration_ms: 0,
                    permission_denials: vec![],
                    launch: Default::default(),
                    pending: None,
                    conversation_id: None,
                    link: None,
                    agent: None,
                    assistant: None,
                    target_index: None,
                    worktree: None,
                    structured_output,
                    error: None,
                })),
            )
        };
        assert_eq!(
            structured_line(&result(Some(serde_json::json!({"ok": true})))),
            r#"{"ok":true}"#
        );
        assert_eq!(
            structured_line(&result(Some(serde_json::Value::Null))),
            "null"
        );
        let init = RunEvent::new(1, None, EventBody::Gap {});
        assert_eq!(structured_line(&init), "null");
    }

    #[test]
    fn a_result_is_marked_with_its_target() {
        let event = RunEvent::new(
            3,
            Some("r".into()),
            EventBody::Result(Box::new(crate::cli_run::wire::RunResult {
                subtype: Subtype::Success,
                is_error: false,
                result: None,
                session_id: None,
                stop_reason: None,
                duration_ms: 0,
                permission_denials: vec![],
                launch: Default::default(),
                pending: None,
                conversation_id: None,
                link: None,
                agent: None,
                assistant: None,
                target_index: None,
                worktree: None,
                structured_output: None,
                error: None,
            })),
        );
        let tagged = tag(event, 2, &Target::Agent("codex".into()));
        let result = tagged.result().unwrap();
        assert_eq!(result.target_index, Some(2));
        assert_eq!(result.agent.as_deref(), Some("codex"));
        let json = serde_json::to_value(&tagged).unwrap();
        assert_eq!(json["target_index"], 2);
    }
}
