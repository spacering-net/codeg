//! `agents install` and `automations`: what Codeg's settings and its
//! Automations page do, from a script.
//!
//! Both follow something the runtime does on its own — an install, an
//! automation run — that goes on whether or not this command waits for it:
//! an interrupt, or the end of `--wait`, never cancels it.

use std::sync::Arc;
use std::time::Duration;

use serde_json::json;
use tokio::time::Instant;

use crate::cli_run::wire::{
    capability, AgentInstallGetRequest, AgentInstallRequest, AgentInstallState, AutomationEntry,
    AutomationRunGetRequest, AutomationRunRequest, AutomationRunState, Subtype,
    STILL_RUNNING_EXIT_CODE,
};

use super::args::{
    AgentInstallArgs, AutomationRunArgs, AutomationsAction, AutomationsArgs, GlobalArgs,
    OutputFormat,
};
use super::connect::{self, Connection, Env};
use super::follow::{follow, LOOK_SLACK};
use super::render::{Output, RunRef};
use super::run::Signals;
use super::Failure;

fn format(json: bool) -> OutputFormat {
    if json {
        OutputFormat::Json
    } else {
        OutputFormat::Text
    }
}

/// Run `body` until it is done, or a signal comes first: then exit with the
/// signal's code, saying that what was started goes on.
async fn interruptible(
    out: &Output,
    what_goes_on: &str,
    body: impl std::future::Future<Output = Result<i32, Failure>>,
) -> i32 {
    let mut signals = Signals::install();
    let outcome = tokio::select! {
        outcome = body => outcome,
        code = signals.recv() => Err(Failure::interrupted(
            code,
            format!("interrupted; {what_goes_on}"),
        )),
    };
    match outcome {
        Ok(code) => code,
        Err(failure) => {
            out.failure(&failure, &RunRef::default());
            failure.exit_code()
        }
    }
}

fn needs(conn: &Connection, capability: &str, what: &str) -> Result<(), Failure> {
    if conn.has(capability) {
        return Ok(());
    }
    Err(Failure::new(
        Subtype::ErrorRuntimeIncompatible,
        "runtime_incompatible",
        format!(
            "the codeg at {} ({}) cannot {what}; upgrade it",
            conn.source, conn.hello.version
        ),
    ))
}

// ── agents install ──────────────────────────────────────────────────────────

pub async fn install(global: &GlobalArgs, args: &AgentInstallArgs, env: &Env) -> i32 {
    let out = Output::new(format(args.json), global);
    let body = install_inner(global, args, env, &out);
    interruptible(&out, "the install goes on in Codeg", body).await
}

async fn install_inner(
    global: &GlobalArgs,
    args: &AgentInstallArgs,
    env: &Env,
    out: &Arc<Output>,
) -> Result<i32, Failure> {
    let deadline = args.wait.and_then(|w| Instant::now().checked_add(w));
    let (conn, _) = connect::connect(global, env).await?;
    needs(&conn, capability::AGENT_INSTALL, "install agents")?;
    let started: AgentInstallState = conn
        .post(
            "cli_agent_install",
            &AgentInstallRequest {
                agent: args.agent.clone(),
                version: args.version.clone(),
            },
            Duration::from_secs(60),
        )
        .await?;
    out.note(&format!(
        "codeg-cli: installing {} in Codeg; this can take a few minutes",
        started.agent
    ));
    let conn_ref = &conn;
    let id = started.install_id.clone();
    let state = follow(
        deadline,
        move |wait| {
            let request = AgentInstallGetRequest {
                install_id: id.clone(),
                wait_ms: Some(wait.as_millis() as u64),
            };
            async move {
                conn_ref
                    .post::<_, AgentInstallState>(
                        "cli_agent_install_get",
                        &request,
                        wait + LOOK_SLACK,
                    )
                    .await
            }
        },
        |s| s.state != "running",
    )
    .await?;
    if args.json {
        Output::json_line(&state);
    }
    match state.state.as_str() {
        "installed" => {
            if !args.json {
                println!(
                    "installed {}{}",
                    state.agent,
                    state
                        .version
                        .as_deref()
                        .map(|v| format!(" {v}"))
                        .unwrap_or_default()
                );
            }
            Ok(0)
        }
        "running" => {
            out.note(&format!(
                "codeg-cli: {} is still being installed; it goes on in Codeg",
                state.agent
            ));
            Ok(STILL_RUNNING_EXIT_CODE)
        }
        _ => {
            let error = state
                .error
                .clone()
                .unwrap_or_else(|| crate::cli_run::wire::ErrorInfo {
                    code: "install_failed".into(),
                    message: format!("{} could not be installed", state.agent),
                    next_steps: Vec::new(),
                });
            out.error_lines(&error.message, &error.next_steps);
            Ok(match error.code.as_str() {
                "bad_version" | "unknown_agent" | "not_installable" => {
                    Subtype::ErrorUsage.exit_code()
                }
                _ => Subtype::ErrorDuringExecution.exit_code(),
            })
        }
    }
}

// ── automations ─────────────────────────────────────────────────────────────

pub async fn automations(global: &GlobalArgs, args: &AutomationsArgs, env: &Env) -> i32 {
    match &args.action {
        None => list(global, args.json, env).await,
        Some(AutomationsAction::List(list_args)) => {
            list(global, args.json || list_args.json, env).await
        }
        Some(AutomationsAction::Run(run_args)) => run(global, run_args, env).await,
    }
}

async fn list(global: &GlobalArgs, json: bool, env: &Env) -> i32 {
    let out = Output::new(format(json), global);
    let listed = async {
        let (conn, _) = connect::connect(global, env).await?;
        needs(&conn, capability::AUTOMATIONS, "list automations")?;
        conn.post::<_, Vec<AutomationEntry>>("cli_automations", &json!({}), Duration::from_secs(60))
            .await
    };
    let automations = match listed.await {
        Ok(a) => a,
        Err(f) => {
            out.failure(&f, &RunRef::default());
            return f.exit_code();
        }
    };
    if json {
        println!(
            "{}",
            serde_json::to_string_pretty(&automations).expect("serializes")
        );
        return 0;
    }
    if automations.is_empty() {
        println!("no automations yet: create one on Codeg's Automations page");
        return 0;
    }
    let width = automations
        .iter()
        .map(|a| a.name.len())
        .max()
        .unwrap_or(4)
        .max(4);
    println!(
        "{:>4}  {:width$}  {:8}  {:9}  {:12}  {:13}  LAST RUN",
        "ID", "NAME", "ENABLED", "TRIGGER", "AGENT", "ACTION"
    );
    for a in &automations {
        println!(
            "{:>4}  {:width$}  {:8}  {:9}  {:12}  {:13}  {}",
            a.id,
            a.name,
            if a.enabled { "yes" } else { "no" },
            a.trigger,
            a.agent,
            a.action,
            a.last_run_status.as_deref().unwrap_or("-")
        );
    }
    0
}

async fn run(global: &GlobalArgs, args: &AutomationRunArgs, env: &Env) -> i32 {
    let out = Output::new(format(args.json), global);
    let body = run_inner(global, args, env, &out);
    interruptible(&out, "the automation's run goes on in Codeg", body).await
}

async fn run_inner(
    global: &GlobalArgs,
    args: &AutomationRunArgs,
    env: &Env,
    out: &Arc<Output>,
) -> Result<i32, Failure> {
    let (conn, _) = connect::connect(global, env).await?;
    needs(&conn, capability::AUTOMATIONS, "run automations")?;
    // Answered once the run is under way: its prompt queued, or its task.
    let started: AutomationRunState = conn
        .post(
            "cli_automation_run",
            &AutomationRunRequest {
                automation_id: args.id,
            },
            Duration::from_secs(300),
        )
        .await?;
    let Some(wait) = args.wait else {
        report_run(out, args.json, &started, false);
        return Ok(0);
    };
    let deadline = Instant::now().checked_add(wait);
    let conn_ref = &conn;
    let run_id = started.run_id;
    let state = follow(
        deadline,
        move |wait| {
            let request = AutomationRunGetRequest {
                run_id,
                wait_ms: Some(wait.as_millis() as u64),
            };
            async move {
                conn_ref
                    .post::<_, AutomationRunState>(
                        "cli_automation_run_get",
                        &request,
                        wait + LOOK_SLACK,
                    )
                    .await
            }
        },
        AutomationRunState::is_over,
    )
    .await?;
    report_run(out, args.json, &state, true);
    Ok(match state.status.as_str() {
        "running" => STILL_RUNNING_EXIT_CODE,
        "succeeded" => 0,
        _ => Subtype::ErrorDuringExecution.exit_code(),
    })
}

/// An automation run: in JSON, the run as it stands; as text, what a person
/// wants — once it ended, its reply on stdout; before, its id.
fn report_run(out: &Output, json: bool, state: &AutomationRunState, waited: bool) {
    if json {
        Output::json_line(state);
    } else if !state.is_over() {
        println!("{}", state.run_id);
    } else if let Some(summary) = state.summary.as_deref().filter(|_| state.task_id.is_none()) {
        Output::reply(summary);
    }
    let link = state
        .link
        .as_deref()
        .map(|l| format!(" ({l})"))
        .unwrap_or_default();
    let what = match (state.status.as_str(), state.task_id) {
        ("running", _) if waited => "still running; it goes on in Codeg".to_string(),
        ("running", _) => "started".to_string(),
        ("succeeded", Some(task)) => format!(
            "queued work task #{task}; the run is over, the task's own work is not part of it"
        ),
        (status, _) => status.to_string(),
    };
    out.note(&format!(
        "codeg-cli: automation {} run {}: {what}{link}",
        state.automation_id, state.run_id
    ));
    if let Some(error) = &state.error {
        out.error_lines(error, &[]);
    }
}
