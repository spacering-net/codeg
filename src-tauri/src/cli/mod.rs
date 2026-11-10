//! `codeg-cli`: run a prompt through a running codeg — the desktop app or a
//! `codeg-server` — from a script or a CI job, without opening its window
//! (issue #694).
//!
//! A thin HTTP client: the run is owned by the runtime (`cli_run`), which
//! answers permissions by the run's policy, fixes the result when the turn
//! ends and cancels on time even if this process is gone. This side finds the
//! runtime and proves it (`connect`), sends the prompt, prints what happens
//! (`render`) and exits with the code `docs/cli.md` documents.

mod args;
mod commands;
mod connect;
mod fanout;
mod follow;
mod manage;
mod render;
mod run;
mod runs;
mod standalone;
mod stdin;

use std::process::ExitCode;

use crate::cli_run::wire::{ErrorBody, ErrorInfo, Subtype};

pub use args::Cli;

/// A failure this side knows the cause of: a usage error, no runtime, a
/// structured error the runtime sent. Printed as a result object in the JSON
/// formats, as a message otherwise.
#[derive(Debug, Clone)]
pub struct Failure {
    pub subtype: Subtype,
    pub code: String,
    pub message: String,
    pub next_steps: Vec<String>,
    /// The exit code, when it is not the subtype's: the 130 or 143 of the
    /// signal that interrupted the run.
    pub signal_exit: Option<i32>,
}

impl Failure {
    pub fn new(subtype: Subtype, code: &str, message: impl Into<String>) -> Self {
        Self {
            subtype,
            code: code.to_string(),
            message: message.into(),
            next_steps: Vec::new(),
            signal_exit: None,
        }
    }

    /// Interrupted by the signal whose exit code is `code` (130 / 143).
    pub fn interrupted(code: i32, message: impl Into<String>) -> Self {
        Self {
            signal_exit: Some(code),
            ..Self::new(Subtype::ErrorInterrupted, "interrupted", message)
        }
    }

    pub fn exit_code(&self) -> i32 {
        self.signal_exit.unwrap_or_else(|| self.subtype.exit_code())
    }

    pub fn usage(code: &str, message: impl Into<String>) -> Self {
        Self::new(Subtype::ErrorUsage, code, message)
    }

    pub fn with_next_steps(mut self, steps: impl IntoIterator<Item = String>) -> Self {
        self.next_steps.extend(steps);
        self
    }

    pub fn from_body(body: ErrorBody) -> Self {
        Self {
            subtype: body.subtype,
            code: body.error.code,
            message: body.error.message,
            next_steps: body.error.next_steps,
            signal_exit: None,
        }
    }

    pub fn info(&self) -> ErrorInfo {
        ErrorInfo {
            code: self.code.clone(),
            message: self.message.clone(),
            next_steps: self.next_steps.clone(),
        }
    }
}

/// The process entry point of the `codeg-cli` binary.
pub fn main() -> ExitCode {
    let cli = match Cli::parse_from(std::env::args_os()) {
        Ok(cli) => cli,
        Err(err) => {
            // Usage errors exit 2 (before the output format is known, so on
            // stderr only); --help and --version exit 0.
            let _ = err.print();
            return ExitCode::from(err.exit_code().clamp(0, 255) as u8);
        }
    };
    let runtime = match tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
    {
        Ok(rt) => rt,
        Err(e) => {
            eprintln!("codeg-cli: cannot start: {e}");
            return ExitCode::from(1);
        }
    };
    let env = connect::Env::from_process();
    let code = runtime.block_on(async move {
        if !cli.global.standalone {
            return dispatch(cli, env).await;
        }
        // The command's own server, up before anything else is asked of it,
        // and on its way out after: its time counts in --timeout.
        let started = tokio::time::Instant::now();
        let timeout = cli.run_args().and_then(|r| r.timeout);
        let deadline = timeout.and_then(|t| started.checked_add(t));
        let mut signals = run::Signals::install();
        let server = tokio::select! {
            server = standalone::Standalone::start(cli.global.data_dir.as_deref(), deadline) => server,
            code = signals.recv() => Err(Failure::interrupted(
                code,
                "interrupted while the --standalone server started; nothing was sent",
            )),
        };
        drop(signals);
        let server = match server {
            Ok(server) => server,
            Err(failure) => {
                let out = render::Output::new(output_format(&cli), &cli.global);
                out.failure(&failure, &render::RunRef::default());
                return failure.exit_code();
            }
        };
        let env = server.env(&env);
        let mut cli = cli;
        cli.global.data_dir = None;
        cli.global.standalone = false;
        let left = timeout.map(|t| t.saturating_sub(started.elapsed()));
        match &mut cli.command {
            None => cli.run.timeout = left.or(cli.run.timeout),
            Some(args::Command::Run(run)) => run.timeout = left.or(run.timeout),
            // The server goes with the command: an automation's run is
            // waited for to its end, not just to its start.
            Some(args::Command::Automations(args::AutomationsArgs {
                action: Some(args::AutomationsAction::Run(run)),
                ..
            })) => run.wait = Some(args::MAX_DURATION),
            Some(_) => {}
        }
        let code = dispatch(cli, env).await;
        server.stop().await;
        code
    });
    // A stdin reader still blocked on a pipe must not keep the process alive.
    runtime.shutdown_background();
    ExitCode::from(code.clamp(0, 255) as u8)
}

/// The format a command prints a failure in, from its options.
fn output_format(cli: &Cli) -> args::OutputFormat {
    use args::{AgentsAction, AutomationsAction, Command, OutputFormat};
    let json = |on: bool| {
        if on {
            OutputFormat::Json
        } else {
            OutputFormat::Text
        }
    };
    match &cli.command {
        None => cli.run.output_format,
        Some(Command::Run(run)) => run.output_format,
        Some(Command::Result(r)) => r.output_format,
        Some(Command::Agents(a)) => match &a.action {
            Some(AgentsAction::Install(i)) => json(i.json),
            None => json(a.json),
        },
        Some(Command::Automations(a)) => match &a.action {
            Some(AutomationsAction::Run(r)) => json(r.json),
            Some(AutomationsAction::List(l)) => json(a.json || l.json),
            None => json(a.json),
        },
        Some(Command::Assistants(l)) | Some(Command::Status(l)) => json(l.json),
        Some(Command::Open(o)) => json(o.json),
        Some(Command::Cancel(c)) => json(c.json),
    }
}

async fn dispatch(cli: Cli, env: connect::Env) -> i32 {
    match cli.command {
        None => run::run(&cli.global, cli.run, &env).await,
        Some(args::Command::Run(run_args)) => run::run(&cli.global, *run_args, &env).await,
        Some(args::Command::Agents(agents)) => match &agents.action {
            Some(args::AgentsAction::Install(install)) => {
                manage::install(&cli.global, install, &env).await
            }
            None => {
                let list = args::ListArgs { json: agents.json };
                commands::agents(&cli.global, &list, &env).await
            }
        },
        Some(args::Command::Assistants(list)) => {
            commands::assistants(&cli.global, &list, &env).await
        }
        Some(args::Command::Status(list)) => commands::status(&cli.global, &list, &env).await,
        Some(args::Command::Open(open)) => commands::open(&cli.global, &open, &env).await,
        Some(args::Command::Result(result)) => runs::result(&cli.global, &result, &env).await,
        Some(args::Command::Cancel(cancel)) => runs::cancel(&cli.global, &cancel, &env).await,
        Some(args::Command::Automations(automations)) => {
            manage::automations(&cli.global, &automations, &env).await
        }
    }
}
