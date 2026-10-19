//! `result` and `cancel`: a run this command did not start, or let go of —
//! one started with `--detach`, or one whose `codeg-cli` lost its runtime.
//!
//! A run is named by its id or by at least 8 characters from its start. The
//! runtime keeps a settled run's result for 30 minutes; `result` never
//! cancels a run, and `cancel` is the only command that does.

use std::sync::Arc;
use std::time::Duration;

use serde_json::json;
use tokio::time::Instant;

use crate::cli_run::service::MIN_RUN_PREFIX;
use crate::cli_run::wire::{
    capability, CancelReason, EventBody, FindRequest, FindResponse, GetRequest, GetResponse,
    RunEvent, RunState, RunStatus, Subtype, STILL_RUNNING_EXIT_CODE,
};

use super::args::{CancelArgs, GlobalArgs, OutputFormat, ResultArgs};
use super::connect::{self, Connection, Env};
use super::follow::{follow, LOOK_SLACK};
use super::render::{Output, RunRef};
use super::run::{finish, Signals};
use super::Failure;

pub async fn result(global: &GlobalArgs, args: &ResultArgs, env: &Env) -> i32 {
    let out = Output::new(args.output_format, global);
    let mut signals = Signals::install();
    let mut run_ref = RunRef::default();
    let outcome = tokio::select! {
        outcome = result_inner(global, args, env, &out, &mut run_ref) => outcome,
        code = signals.recv() => Err(Failure::interrupted(
            code,
            "interrupted; the run was not cancelled (`codeg-cli cancel` cancels it)",
        )),
    };
    match outcome {
        Ok(code) => code,
        Err(failure) => {
            out.failure(&failure, &run_ref);
            failure.exit_code()
        }
    }
}

async fn result_inner(
    global: &GlobalArgs,
    args: &ResultArgs,
    env: &Env,
    out: &Arc<Output>,
    run_ref: &mut RunRef,
) -> Result<i32, Failure> {
    let deadline = Instant::now() + args.wait.unwrap_or_default();
    let (conn, _) = connect::connect(global, env).await?;
    let run_id = resolve_run(&conn, &args.run).await?;
    run_ref.run_id = Some(run_id.clone());
    let conn_ref = &conn;
    let id = run_id.clone();
    let got = follow(
        Some(deadline),
        move |wait| {
            let request = GetRequest {
                run_id: id.clone(),
                wait_ms: Some(wait.as_millis() as u64),
            };
            async move {
                conn_ref
                    .post::<_, GetResponse>("cli_run_get", &request, wait + LOOK_SLACK)
                    .await
            }
        },
        |got| got.state == RunState::Settled,
    )
    .await?;
    run_ref.conversation_id = got.conversation_id;
    run_ref.link = got.link.clone();
    if got.state != RunState::Settled {
        out.still_running(&RunStatus::still_running(
            run_id,
            got.state,
            got.conversation_id,
            got.link,
        ));
        return Ok(STILL_RUNNING_EXIT_CODE);
    }
    let Some(result) = got.result else {
        return Err(Failure::new(
            Subtype::ErrorRuntimeUnavailable,
            "result_missing",
            "the run ended without a result",
        ));
    };
    let event = RunEvent::new(
        out.next_seq(),
        Some(run_id),
        EventBody::Result(Box::new(result)),
    );
    Ok(finish(out, args.output.as_deref(), &event, None))
}

pub async fn cancel(global: &GlobalArgs, args: &CancelArgs, env: &Env) -> i32 {
    let format = if args.json {
        OutputFormat::Json
    } else {
        OutputFormat::Text
    };
    let out = Output::new(format, global);
    let mut run_ref = RunRef::default();
    match cancel_inner(global, args, env, &mut run_ref).await {
        Ok(report) => {
            if args.json {
                println!("{report}");
            } else {
                println!(
                    "{}",
                    report["message"].as_str().unwrap_or("cancelled").to_owned()
                );
            }
            0
        }
        Err(failure) => {
            out.failure(&failure, &run_ref);
            failure.exit_code()
        }
    }
}

async fn cancel_inner(
    global: &GlobalArgs,
    args: &CancelArgs,
    env: &Env,
    run_ref: &mut RunRef,
) -> Result<serde_json::Value, Failure> {
    let (conn, _) = connect::connect(global, env).await?;
    let run_id = resolve_run(&conn, &args.run).await?;
    run_ref.run_id = Some(run_id.clone());
    // The runtime answers once the run is stopped, which waits for a launch
    // in progress to queue its prompt or give up.
    conn.post::<_, serde_json::Value>(
        "cli_run_cancel",
        &json!({ "runId": run_id, "reason": CancelReason::User }),
        Duration::from_secs(120),
    )
    .await?;
    let got = conn
        .post::<_, GetResponse>(
            "cli_run_get",
            &GetRequest {
                run_id: run_id.clone(),
                wait_ms: None,
            },
            Duration::from_secs(30),
        )
        .await;
    let got = match got {
        Ok(got) => got,
        // A reservation withdrawn: there is no run left to read.
        Err(f) if f.code == "run_not_found" => {
            return Ok(json!({
                "run_id": run_id,
                "cancelled": true,
                "subtype": null,
                "link": null,
                "message": format!("withdrew run {run_id}: it had not started"),
            }));
        }
        Err(f) => return Err(f),
    };
    let result = got.result.as_ref();
    let by_this = result
        .and_then(|r| r.error.as_ref())
        .is_some_and(|e| e.code == "cancelled");
    let message = match result {
        _ if by_this => format!("cancelled run {run_id}"),
        Some(r) => format!(
            "run {run_id} had already finished ({}): nothing to cancel",
            wire_name(r.subtype)
        ),
        None => format!("cancelling run {run_id}"),
    };
    Ok(json!({
        "run_id": run_id,
        "cancelled": by_this,
        "subtype": result.map(|r| r.subtype),
        "link": got.link.or_else(|| result.and_then(|r| r.link.clone())),
        "message": message,
    }))
}

/// The whole run id for `given`: the id itself, or the one run whose id
/// starts with it.
async fn resolve_run(conn: &Connection, given: &str) -> Result<String, Failure> {
    let given = given.trim().to_ascii_lowercase();
    if uuid::Uuid::parse_str(&given).is_ok() {
        return Ok(given);
    }
    if given.len() < MIN_RUN_PREFIX || !given.chars().all(|c| c.is_ascii_hexdigit() || c == '-') {
        return Err(Failure::usage(
            "bad_run_id",
            format!(
                "{given:?} is not a run id: give the id `--detach` printed, or at least \
                 {MIN_RUN_PREFIX} characters from its start"
            ),
        ));
    }
    if !conn.has(capability::RUN_LOOKUP) {
        return Err(Failure::new(
            Subtype::ErrorRuntimeIncompatible,
            "runtime_incompatible",
            format!(
                "{} cannot find a run by the start of its id; give the whole id",
                conn.source
            ),
        ));
    }
    let found: FindResponse = conn
        .post(
            "cli_run_find",
            &FindRequest {
                prefix: given.clone(),
            },
            Duration::from_secs(30),
        )
        .await?;
    pick(&given, &found, &conn.source)
}

/// The one run `found` holds for `given`, or why there is none.
fn pick(given: &str, found: &FindResponse, source: &str) -> Result<String, Failure> {
    match found.runs.as_slice() {
        [] => Err(Failure::new(
            Subtype::ErrorRuntimeUnavailable,
            "run_not_found",
            format!(
                "{source} has no run starting with {given}: it was never started there, or its \
                 result is past the 30-minute retention"
            ),
        )),
        [one] => Ok(one.run_id.clone()),
        many => Err(Failure::usage(
            "ambiguous_run",
            format!(
                "{} runs start with {given}; give more of the id",
                many.len()
            ),
        )
        .with_next_steps(many.iter().map(|r| {
            format!(
                "{}   ({}{})",
                r.run_id,
                wire_name(r.state),
                r.agent
                    .as_deref()
                    .map(|a| format!(", {a}"))
                    .unwrap_or_default()
            )
        }))),
    }
}

/// How `value` reads on the wire: `error_timeout`, `running`, …
fn wire_name(value: impl serde::Serialize) -> String {
    serde_json::to_value(value)
        .ok()
        .and_then(|v| v.as_str().map(str::to_owned))
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cli_run::wire::FoundRun;

    fn found(ids: &[&str]) -> FindResponse {
        FindResponse {
            runs: ids
                .iter()
                .map(|id| FoundRun {
                    run_id: id.to_string(),
                    state: RunState::Running,
                    conversation_id: Some(1),
                    agent: Some("codex".into()),
                })
                .collect(),
        }
    }

    #[test]
    fn a_prefix_stands_for_the_one_run_it_starts() {
        let id = "8d0c7c2e-3f0b-4a5e-9c1b-6f2d1e0a7b44";
        assert_eq!(pick("8d0c7c2e", &found(&[id]), "here").unwrap(), id);

        let none = pick("8d0c7c2e", &found(&[]), "here").unwrap_err();
        assert_eq!(none.code, "run_not_found");
        assert_eq!(none.exit_code(), 4);

        // Two: a usage error that lists both, written to be copied.
        let other = "8d0c7c2e-0000-4000-8000-000000000000";
        let two = pick("8d0c7c2e", &found(&[id, other]), "here").unwrap_err();
        assert_eq!(two.code, "ambiguous_run");
        assert_eq!(two.exit_code(), 2);
        assert_eq!(two.next_steps.len(), 2);
        assert!(two.next_steps[0].starts_with(id), "{:?}", two.next_steps);
        assert!(two.next_steps[1].contains("running, codex"));
    }
}
