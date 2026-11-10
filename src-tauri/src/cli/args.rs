//! The command line of `codeg-cli`.
//!
//! ```text
//! codeg-cli [GLOBAL] [run] [RUN OPTIONS] [PROMPT]
//! codeg-cli agents|assistants|status [--json]
//! codeg-cli open [--wait DUR] [--json]
//! ```
//!
//! No subcommand means `run`, so `codeg-cli "review it"` and
//! `codeg-cli run "review it"` are the same run. A first positional that IS a
//! subcommand name is that subcommand: `codeg-cli run status` or
//! `codeg-cli -p status` sends the word as a prompt.

use std::path::PathBuf;
use std::time::Duration;

use clap::{Args, Parser, Subcommand, ValueEnum};

use crate::cli_run::PermissionPolicy;

#[derive(Parser, Debug)]
#[command(
    name = "codeg-cli",
    // Fixed, so help, errors and `next_steps` name the command the way the
    // docs do whatever the file is called (`codeg-cli.exe`, a symlink, …).
    bin_name = "codeg-cli",
    version,
    about = "Run one prompt through a running codeg — the desktop app or codeg-server — \
             without opening its window.",
    disable_help_subcommand = true
)]
pub struct Cli {
    #[command(flatten)]
    pub global: GlobalArgs,

    #[command(subcommand)]
    pub command: Option<Command>,

    /// The options of `run`, for the default command.
    #[command(flatten)]
    pub run: RunArgs,
}

impl Cli {
    /// Parse `args` (the program name first), with what clap cannot check:
    /// run options belong to `run` — after it, or with no command at all.
    /// Written before `run` or with another command, they would be dropped
    /// without a word (`-w /safe run -p …` would run in the current
    /// directory), so that is a usage error — a default value written out
    /// on purpose included.
    pub fn parse_from<I, T>(args: I) -> Result<Self, clap::Error>
    where
        I: IntoIterator<Item = T>,
        T: Into<std::ffi::OsString> + Clone,
    {
        use clap::{CommandFactory, FromArgMatches};
        let mut command = Self::command();
        let matches = command.try_get_matches_from_mut(args)?;
        let mut cli = Self::from_arg_matches(&matches).map_err(|e| e.format(&mut command))?;
        // clap keeps `-a` and `-A` apart; a run is one per flag, in the order
        // the command line gives them.
        match &mut cli.command {
            None => cli.run.targets = targets_of(&matches),
            Some(Command::Run(run)) => {
                if let Some(sub) = matches.subcommand_matches("run") {
                    run.targets = targets_of(sub);
                }
            }
            Some(_) => {}
        }
        if cli.command.is_some() && run_options_given(&matches) {
            let message = match cli.command {
                Some(Command::Run(_)) => {
                    "run options go after `run` (`codeg-cli run -p …`), not before it"
                }
                _ => {
                    "run options (-p, -a, -w, …) go with `run` or with no command at all, not \
                     with another command"
                }
            };
            return Err(command.error(clap::error::ErrorKind::ArgumentConflict, message));
        }
        if cli.global.standalone {
            let refused = match &cli.command {
                Some(Command::Open(_)) => Some("open starts the desktop app"),
                Some(Command::Result(_)) | Some(Command::Cancel(_)) => Some(
                    "a --standalone server ends with its command, so it has no run of an earlier \
                     command",
                ),
                _ if cli.run_args().is_some_and(|r| r.detach) => Some(
                    "a --standalone server ends with its command, so a detached run would end \
                     with it",
                ),
                Some(Command::Agents(AgentsArgs {
                    action: Some(AgentsAction::Install(AgentInstallArgs { wait: Some(_), .. })),
                    ..
                }))
                | Some(Command::Automations(AutomationsArgs {
                    action: Some(AutomationsAction::Run(AutomationRunArgs { wait: Some(_), .. })),
                    ..
                })) => Some(
                    "a --standalone server ends with its command, so the command waits for what \
                     it started to end: leave out --wait",
                ),
                _ => None,
            };
            if let Some(why) = refused {
                return Err(command.error(
                    clap::error::ErrorKind::ArgumentConflict,
                    format!("--standalone does not go here: {why}"),
                ));
            }
        }
        if let Some(run) = cli.run_args() {
            if run.detach && run.targets.len() > usize::from(run.max_parallel) {
                return Err(command.error(
                    clap::error::ErrorKind::ArgumentConflict,
                    format!(
                        "--detach starts all {} runs at once, more than --max-parallel {}: give \
                         --max-parallel {} or more, or leave out --detach",
                        run.targets.len(),
                        run.max_parallel,
                        run.targets.len()
                    ),
                ));
            }
            if run.detach && run.output.is_some() {
                return Err(command.error(
                    clap::error::ErrorKind::ArgumentConflict,
                    "--detach does not wait for the reply, so it cannot write -o: collect it \
                     with `codeg-cli result RUN -o FILE`",
                ));
            }
        }
        Ok(cli)
    }

    /// The run options in effect: after `run`, or at the top level.
    pub fn run_args(&self) -> Option<&RunArgs> {
        match &self.command {
            None => Some(&self.run),
            Some(Command::Run(run)) => Some(run),
            Some(_) => None,
        }
    }
}

/// The `-a` and `-A` of `matches`, in command-line order.
fn targets_of(matches: &clap::ArgMatches) -> Vec<Target> {
    let mut targets: Vec<(usize, Target)> = Vec::new();
    for (id, make) in [
        ("agent", Target::Agent as fn(String) -> Target),
        ("assistant", Target::Assistant),
    ] {
        if let (Some(values), Some(indices)) =
            (matches.get_many::<String>(id), matches.indices_of(id))
        {
            targets.extend(indices.zip(values).map(|(i, v)| (i, make(v.clone()))));
        }
    }
    targets.sort_by_key(|(i, _)| *i);
    targets.into_iter().map(|(_, t)| t).collect()
}

/// One run of the prompt: what one `-a` or `-A` names.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Target {
    Agent(String),
    Assistant(String),
}

impl Target {
    pub fn agent(&self) -> Option<String> {
        match self {
            Self::Agent(slug) => Some(slug.clone()),
            Self::Assistant(_) => None,
        }
    }

    pub fn assistant(&self) -> Option<String> {
        match self {
            Self::Assistant(name) => Some(name.clone()),
            Self::Agent(_) => None,
        }
    }

    /// The agent's slug or the assistant's name, as written.
    pub fn label(&self) -> &str {
        match self {
            Self::Agent(s) | Self::Assistant(s) => s,
        }
    }
}

/// Whether one of `run`'s options was written at the top level.
fn run_options_given(matches: &clap::ArgMatches) -> bool {
    RunArgs::augment_args(clap::Command::new("run"))
        .get_arguments()
        .any(|arg| {
            matches.value_source(arg.get_id().as_str())
                == Some(clap::parser::ValueSource::CommandLine)
        })
}

#[derive(Args, Debug, Clone, Default)]
pub struct GlobalArgs {
    /// A codeg reachable over HTTP(S), e.g. a codeg-server: https://host:3080.
    #[arg(long, global = true, value_name = "URL")]
    pub url: Option<String>,

    /// The token for --url (the server's CODEG_TOKEN).
    #[arg(
        long,
        global = true,
        value_name = "TOKEN",
        conflicts_with = "token_file"
    )]
    pub token: Option<String>,

    /// Read the token for --url from a file.
    #[arg(long, global = true, value_name = "FILE")]
    pub token_file: Option<PathBuf>,

    /// Use the runtime that keeps its data in this directory. With
    /// --standalone: the data directory the command's own server uses.
    #[arg(long, global = true, value_name = "DIR", conflicts_with = "url")]
    pub data_dir: Option<PathBuf>,

    /// Start a codeg-server for this command alone, on a temporary data
    /// directory (or --data-dir), and stop it when the command ends.
    #[arg(long, global = true, conflicts_with = "url")]
    pub standalone: bool,

    /// Pick this kind when several runtimes answer.
    #[arg(long, global = true, value_enum, value_name = "KIND")]
    pub runtime: Option<RuntimeChoice>,

    /// No progress, no heartbeat; errors only.
    #[arg(short, long, global = true)]
    pub quiet: bool,

    /// Progress on stderr even when it is not a terminal, and diagnostics.
    #[arg(short, long, global = true)]
    pub verbose: bool,

    /// Plain progress lines, without color.
    #[arg(long, global = true)]
    pub no_color: bool,
}

#[derive(Copy, Clone, Debug, PartialEq, Eq, ValueEnum)]
pub enum RuntimeChoice {
    Desktop,
    Server,
}

#[derive(Subcommand, Debug)]
pub enum Command {
    /// Run one prompt (what `codeg-cli` does without a command).
    Run(Box<RunArgs>),
    /// The agents this codeg knows, and whether each is enabled and installed;
    /// `agents install SLUG` installs one.
    Agents(AgentsArgs),
    /// The assistants (named roles) to run with --assistant.
    Assistants(ListArgs),
    /// Which runtimes this command can reach, and which it would use.
    Status(ListArgs),
    /// Start the desktop app if it is not running, and wait until it answers.
    Open(OpenArgs),
    /// The result of a run started with --detach, or one this command lost.
    Result(ResultArgs),
    /// Cancel a run.
    Cancel(CancelArgs),
    /// The automations saved in Codeg; `automations run ID` runs one now.
    Automations(AutomationsArgs),
}

#[derive(Args, Debug, Clone, Default)]
#[command(args_conflicts_with_subcommands = true)]
pub struct AgentsArgs {
    #[command(subcommand)]
    pub action: Option<AgentsAction>,

    /// Print JSON instead of a table.
    #[arg(long)]
    pub json: bool,
}

#[derive(Subcommand, Debug, Clone)]
pub enum AgentsAction {
    /// Install an agent the way Codeg's settings do: its npm package, or its
    /// download.
    Install(AgentInstallArgs),
}

#[derive(Args, Debug, Clone)]
pub struct AgentInstallArgs {
    /// The agent: claude_code, codex, … (`codeg-cli agents`).
    #[arg(value_name = "SLUG")]
    pub agent: String,

    /// A version other than the one this codeg pins.
    #[arg(long, value_name = "VERSION")]
    pub version: Option<String>,

    /// How long to wait for the install (default: until it ends). It goes
    /// on in Codeg either way.
    #[arg(long, value_name = "DUR", value_parser = parse_duration)]
    pub wait: Option<Duration>,

    /// Print JSON instead of a line.
    #[arg(long)]
    pub json: bool,
}

#[derive(Args, Debug, Clone, Default)]
#[command(args_conflicts_with_subcommands = true)]
pub struct AutomationsArgs {
    #[command(subcommand)]
    pub action: Option<AutomationsAction>,

    /// Print JSON instead of a table.
    #[arg(long)]
    pub json: bool,
}

#[derive(Subcommand, Debug, Clone)]
pub enum AutomationsAction {
    /// The automations saved in Codeg (what `codeg-cli automations` prints).
    List(ListArgs),
    /// Run an automation now, as its Run now button does.
    Run(AutomationRunArgs),
}

#[derive(Args, Debug, Clone)]
pub struct AutomationRunArgs {
    /// The automation's id (`codeg-cli automations`).
    #[arg(value_name = "ID")]
    pub id: i32,

    /// Wait this long for the run to end (default: return once it started).
    /// The run is never cancelled for it.
    #[arg(long, value_name = "DUR", value_parser = parse_duration)]
    pub wait: Option<Duration>,

    /// Print JSON instead of a line.
    #[arg(long)]
    pub json: bool,
}

#[derive(Args, Debug, Clone, Default)]
pub struct ListArgs {
    /// Print JSON instead of a table.
    #[arg(long)]
    pub json: bool,
}

#[derive(Args, Debug, Clone)]
pub struct OpenArgs {
    /// How long to wait for the desktop to answer.
    #[arg(long, value_name = "DUR", value_parser = parse_duration, default_value = "60s")]
    pub wait: Duration,

    /// Print JSON instead of a line.
    #[arg(long)]
    pub json: bool,
}

#[derive(Args, Debug, Clone)]
pub struct ResultArgs {
    /// The run: its id, or at least 8 characters from its start.
    #[arg(value_name = "RUN")]
    pub run: String,

    /// Wait this long for the run to finish (default: look once). The run is
    /// never cancelled for it.
    #[arg(long, value_name = "DUR", value_parser = parse_duration)]
    pub wait: Option<Duration>,

    /// text: the final reply on stdout. json, stream-json: the result object.
    #[arg(
        long = "output-format",
        visible_alias = "format",
        value_enum,
        value_name = "FORMAT",
        default_value_t = OutputFormat::Text
    )]
    pub output_format: OutputFormat,

    /// Also write the final reply to FILE.
    #[arg(short = 'o', long, value_name = "FILE")]
    pub output: Option<PathBuf>,
}

#[derive(Args, Debug, Clone)]
pub struct CancelArgs {
    /// The run: its id, or at least 8 characters from its start.
    #[arg(value_name = "RUN")]
    pub run: String,

    /// Print JSON instead of a line.
    #[arg(long)]
    pub json: bool,
}

#[derive(Args, Debug, Clone, Default, PartialEq)]
pub struct RunArgs {
    /// The working directory of the run. On this machine's codeg: default the
    /// current directory, relative paths taken from it. With --url: a path on
    /// the server's machine, required, sent as written.
    #[arg(
        short = 'w',
        long,
        value_name = "DIR",
        visible_alias = "cd",
        short_alias = 'C'
    )]
    pub workspace: Option<String>,

    /// The prompt; `-` reads it from stdin. Without one, stdin is the prompt.
    #[arg(short = 'p', long, value_name = "TEXT", conflicts_with = "prompt_arg")]
    pub prompt: Option<String>,

    /// The prompt, as a positional argument.
    #[arg(value_name = "PROMPT")]
    pub prompt_arg: Option<String>,

    /// The agent to run: claude_code, codex, … (`codeg-cli agents`). Each -a
    /// and -A is a run of its own: `-a codex -a claude_code` runs the prompt
    /// twice.
    #[arg(short = 'a', long, value_name = "SLUG", action = clap::ArgAction::Append)]
    pub agent: Vec<String>,

    /// Run as an assistant, by name or id (`codeg-cli assistants`).
    #[arg(short = 'A', long, value_name = "NAME|ID", action = clap::ArgAction::Append)]
    pub assistant: Vec<String>,

    /// With several -a / -A: how many run at once; the rest wait their turn.
    #[arg(
        long,
        value_name = "N",
        default_value_t = 4,
        value_parser = clap::value_parser!(u16).range(1..=64)
    )]
    pub max_parallel: u16,

    /// The runs `-a` and `-A` name, in command-line order (filled in after
    /// parsing). None: one run, with the workspace's default agent.
    #[arg(skip)]
    pub targets: Vec<Target>,

    /// The model, as the agent lists it.
    #[arg(short = 'm', long, value_name = "VALUE")]
    pub model: Option<String>,

    /// The thinking effort, as the agent lists it.
    #[arg(long, value_name = "LEVEL")]
    pub effort: Option<String>,

    /// The session mode, e.g. plan or acceptEdits.
    #[arg(long, value_name = "ID")]
    pub mode: Option<String>,

    /// Another session option, by id. Repeatable.
    #[arg(short = 'c', long = "config", value_name = "ID=VALUE", value_parser = parse_config)]
    pub config: Vec<(String, String)>,

    /// Open the conversation in the desktop app once it exists.
    #[arg(long)]
    pub open: bool,

    /// What to answer when the agent asks for a permission.
    #[arg(long, value_enum, value_name = "POLICY", default_value_t = PolicyArg::Deny)]
    pub permissions: PolicyArg,

    /// Also write the final reply to FILE.
    #[arg(short = 'o', long, value_name = "FILE")]
    pub output: Option<PathBuf>,

    /// Have the agent hand in its result as JSON matching the JSON Schema in
    /// FILE. text and -o then give that JSON, on one line.
    #[arg(long, value_name = "FILE")]
    pub output_schema: Option<PathBuf>,

    /// text: the final reply on stdout. json: one result object.
    /// stream-json: one event per line, the result object last.
    #[arg(
        long = "output-format",
        visible_alias = "format",
        value_enum,
        value_name = "FORMAT",
        default_value_t = OutputFormat::Text
    )]
    pub output_format: OutputFormat,

    /// The conversation's title (kept: the agent's titles do not replace it).
    #[arg(long, value_name = "TEXT")]
    pub title: Option<String>,

    /// Give up after this long, counted from the start of the command (90s,
    /// 30m, 2h). The run is cancelled on the server too.
    #[arg(long, value_name = "DUR", value_parser = parse_duration)]
    pub timeout: Option<Duration>,

    /// Never read stdin.
    #[arg(long)]
    pub no_stdin: bool,

    /// Return once the prompt is with the agent, printing the run's id; the
    /// run goes on. `codeg-cli result RUN` collects it.
    #[arg(long)]
    pub detach: bool,

    /// Run in a new git worktree next to the repository, on branch cli/NAME
    /// (default: the start of the run's id). It stays for you to review.
    /// Written `--worktree=NAME`, so a prompt after it stays a prompt.
    #[arg(
        long,
        value_name = "NAME",
        num_args = 0..=1,
        require_equals = true,
        default_missing_value = "",
        value_parser = parse_worktree_name
    )]
    pub worktree: Option<String>,
}

#[derive(Copy, Clone, Debug, PartialEq, Eq, Default, ValueEnum)]
pub enum PolicyArg {
    /// Refuse every request, once (the default).
    #[default]
    Deny,
    /// Allow reads and searches, refuse the rest.
    Reads,
    /// Allow every request, once.
    Allow,
    /// Refuse, and end the run with exit code 5.
    Fail,
    /// Leave every request to a person in the Codeg window.
    Wait,
}

impl From<PolicyArg> for PermissionPolicy {
    fn from(p: PolicyArg) -> Self {
        match p {
            PolicyArg::Deny => Self::Deny,
            PolicyArg::Reads => Self::Reads,
            PolicyArg::Allow => Self::Allow,
            PolicyArg::Fail => Self::Fail,
            PolicyArg::Wait => Self::Wait,
        }
    }
}

#[derive(Copy, Clone, Debug, PartialEq, Eq, Default, ValueEnum)]
pub enum OutputFormat {
    #[default]
    Text,
    Json,
    StreamJson,
}

impl OutputFormat {
    pub fn is_json(self) -> bool {
        self != Self::Text
    }
}

/// The longest `--timeout` / `--wait`: a deadline that far off is no
/// deadline anyone needs, and one any further could not be represented.
pub const MAX_DURATION: Duration = Duration::from_secs(30 * 24 * 3600);

/// `90s`, `30m`, `2h`, `500ms`; a bare number is seconds.
pub fn parse_duration(raw: &str) -> Result<Duration, String> {
    let s = raw.trim();
    let split = s
        .find(|c: char| !(c.is_ascii_digit() || c == '.'))
        .unwrap_or(s.len());
    let (number, unit) = s.split_at(split);
    let value: f64 = number
        .parse()
        .map_err(|_| format!("{raw:?} is not a duration such as 90s, 30m or 2h"))?;
    let seconds = match unit.trim() {
        "" | "s" | "sec" => value,
        "ms" => value / 1000.0,
        "m" | "min" => value * 60.0,
        "h" => value * 3600.0,
        _ => return Err(format!("{raw:?} has an unknown unit; use ms, s, m or h")),
    };
    if !(seconds.is_finite() && seconds > 0.0) {
        return Err(format!("{raw:?} must be more than zero"));
    }
    Duration::try_from_secs_f64(seconds)
        .ok()
        .filter(|d| *d <= MAX_DURATION)
        .ok_or_else(|| format!("{raw:?} is too long; 30 days at most"))
}

/// A `--worktree` name, or none (`--worktree` alone).
fn parse_worktree_name(raw: &str) -> Result<String, String> {
    if raw.is_empty() {
        return Ok(String::new());
    }
    crate::cli_run::worktree::check_name(raw).map(|()| raw.to_string())
}

fn parse_config(raw: &str) -> Result<(String, String), String> {
    match raw.split_once('=') {
        Some((id, value)) if !id.trim().is_empty() => {
            Ok((id.trim().to_string(), value.to_string()))
        }
        _ => Err(format!("{raw:?} is not ID=VALUE")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(args: &[&str]) -> Result<Cli, clap::Error> {
        Cli::parse_from(std::iter::once("codeg-cli").chain(args.iter().copied()))
    }

    #[test]
    fn no_subcommand_is_run_with_a_positional_prompt() {
        let cli = parse(&["review it"]).unwrap();
        assert!(cli.command.is_none());
        assert_eq!(cli.run.prompt_arg.as_deref(), Some("review it"));
        let cli = parse(&["run", "review it"]).unwrap();
        match cli.command {
            Some(Command::Run(run)) => assert_eq!(run.prompt_arg.as_deref(), Some("review it")),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn a_subcommand_name_is_the_subcommand_unless_run_or_p_says_otherwise() {
        assert!(matches!(
            parse(&["status"]).unwrap().command,
            Some(Command::Status(_))
        ));
        match parse(&["run", "status"]).unwrap().command {
            Some(Command::Run(run)) => assert_eq!(run.prompt_arg.as_deref(), Some("status")),
            other => panic!("{other:?}"),
        }
        let cli = parse(&["-p", "status"]).unwrap();
        assert!(cli.command.is_none());
        assert_eq!(cli.run.prompt.as_deref(), Some("status"));
    }

    /// The two commands of issue #694, with the command name changed.
    #[test]
    fn the_issues_commands_parse() {
        let cli = parse(&[
            "-w",
            "./backend",
            "-p",
            "Review the changes",
            "--agent",
            "code-reviewer",
            "--output",
            "review.md",
        ])
        .unwrap();
        assert_eq!(cli.run.workspace.as_deref(), Some("./backend"));
        assert_eq!(cli.run.targets, [Target::Agent("code-reviewer".into())]);
        assert_eq!(cli.run.output, Some(PathBuf::from("review.md")));
        let cli = parse(&["--cd", "/repo", "-a", "codex", "explain"]).unwrap();
        assert_eq!(cli.run.workspace.as_deref(), Some("/repo"));
        assert_eq!(cli.run.prompt_arg.as_deref(), Some("explain"));
    }

    #[test]
    fn an_output_schema_is_a_run_option() {
        let cli = parse(&["--output-schema", "s.json", "-p", "review"]).unwrap();
        assert_eq!(cli.run.output_schema, Some(PathBuf::from("s.json")));
        let cli = parse(&["run", "--output-schema", "s.json", "review"]).unwrap();
        assert_eq!(
            cli.run_args().and_then(|r| r.output_schema.clone()),
            Some(PathBuf::from("s.json"))
        );
        assert!(parse(&["--output-schema", "s.json", "status"]).is_err());
    }

    #[test]
    fn globals_go_before_or_after_the_subcommand() {
        let cli = parse(&["--url", "https://h", "agents", "--json"]).unwrap();
        assert_eq!(cli.global.url.as_deref(), Some("https://h"));
        let cli = parse(&["agents", "--json", "--url", "https://h"]).unwrap();
        assert_eq!(cli.global.url.as_deref(), Some("https://h"));
    }

    #[test]
    fn conflicting_choices_are_usage_errors() {
        for args in [
            &["-p", "x", "y"][..],
            &["--url", "https://h", "--data-dir", "/d", "x"][..],
            &["--max-parallel", "0", "-a", "codex", "x"][..],
            &["--permissions", "yolo", "x"][..],
            &["--timeout", "soon", "x"][..],
            &["-c", "novalue", "x"][..],
        ] {
            let err = parse(args).expect_err(&format!("{args:?}"));
            assert_eq!(err.exit_code(), 2, "{args:?}");
        }
    }

    #[test]
    fn run_options_do_not_mix_with_another_command() {
        for args in [
            &["-a", "codex", "agents"][..],
            // A default written out on purpose is still a run option.
            &["--permissions", "deny", "agents"][..],
            &["--output-format", "text", "status"][..],
        ] {
            let err = parse(args).expect_err(&format!("{args:?}"));
            assert_eq!(err.exit_code(), 2, "{args:?}");
        }
    }

    /// Before `run` they would be dropped: `-w /safe` would run elsewhere.
    #[test]
    fn run_options_go_after_run() {
        let err = parse(&["-w", "/safe", "--permissions", "fail", "run", "-p", "x"]).unwrap_err();
        assert_eq!(err.exit_code(), 2);
        assert!(err.to_string().contains("after `run`"), "{err}");
        let cli = parse(&["run", "-w", "/safe", "-p", "x"]).unwrap();
        match cli.command {
            Some(Command::Run(run)) => assert_eq!(run.workspace.as_deref(), Some("/safe")),
            other => panic!("{other:?}"),
        }
        // Globals still go anywhere.
        assert!(parse(&["--url", "https://h", "run", "-p", "x"]).is_ok());
    }

    /// Each -a and -A is a run, numbered in the order written — the two kinds
    /// mixed — after `run` as well as without it.
    #[test]
    fn every_agent_and_assistant_is_a_run_in_the_order_written() {
        let want = [
            Target::Agent("claude_code".into()),
            Target::Assistant("reviewer".into()),
            Target::Agent("codex".into()),
            Target::Agent("codex".into()),
        ];
        let words = [
            "-a",
            "claude_code",
            "-A",
            "reviewer",
            "--agent",
            "codex",
            "-a",
            "codex",
            "x",
        ];
        assert_eq!(parse(&words).unwrap().run.targets, want);
        let after_run: Vec<&str> = std::iter::once("run").chain(words).collect();
        match parse(&after_run).unwrap().command {
            Some(Command::Run(run)) => assert_eq!(run.targets, want),
            other => panic!("{other:?}"),
        }
        assert!(parse(&["x"]).unwrap().run.targets.is_empty());
        assert_eq!(parse(&["x"]).unwrap().run.max_parallel, 4);
    }

    /// A detached run is out of this command's hands once started, so the
    /// command cannot hold back the ones over --max-parallel.
    #[test]
    fn detach_starts_no_more_runs_than_max_parallel() {
        let five = [
            "--detach", "-a", "a", "-a", "b", "-a", "c", "-a", "d", "-a", "e", "x",
        ];
        assert_eq!(parse(&five).unwrap_err().exit_code(), 2);
        let mut allowed: Vec<&str> = five.to_vec();
        allowed.extend(["--max-parallel", "5"]);
        assert!(parse(&allowed).is_ok());
        assert!(parse(&["--detach", "-a", "a", "-a", "b", "x"]).is_ok());
    }

    #[test]
    fn detach_does_not_go_with_a_reply_file() {
        let cli = parse(&["--detach", "-a", "codex", "x"]).unwrap();
        assert!(cli.run.detach);
        let err = parse(&["--detach", "-o", "review.md", "x"]).unwrap_err();
        assert_eq!(err.exit_code(), 2);
        assert!(err.to_string().contains("codeg-cli result"), "{err}");
        let err = parse(&["run", "--detach", "-o", "review.md", "x"]).unwrap_err();
        assert_eq!(err.exit_code(), 2);
    }

    #[test]
    fn result_and_cancel_take_a_run_and_their_own_options() {
        match parse(&[
            "result", "8d0c7c2e", "--wait", "5m", "-o", "r.md", "--format", "json",
        ])
        .unwrap()
        .command
        {
            Some(Command::Result(r)) => {
                assert_eq!(r.run, "8d0c7c2e");
                assert_eq!(r.wait, Some(Duration::from_secs(300)));
                assert_eq!(r.output, Some(PathBuf::from("r.md")));
                assert_eq!(r.output_format, OutputFormat::Json);
            }
            other => panic!("{other:?}"),
        }
        match parse(&["cancel", "8d0c7c2e", "--json"]).unwrap().command {
            Some(Command::Cancel(c)) => {
                assert_eq!(c.run, "8d0c7c2e");
                assert!(c.json);
            }
            other => panic!("{other:?}"),
        }
        // A run is required; run options do not go with them.
        assert_eq!(parse(&["result"]).unwrap_err().exit_code(), 2);
        assert_eq!(
            parse(&["-a", "codex", "cancel", "8d0c7c2e"])
                .unwrap_err()
                .exit_code(),
            2
        );
    }

    /// `--worktree "review this"` would swallow the prompt as a name: a name
    /// needs `=`, so the words after the flag stay the prompt.
    #[test]
    fn a_worktree_name_needs_an_equals_sign() {
        let cli = parse(&["--worktree", "review this"]).unwrap();
        assert_eq!(cli.run.worktree.as_deref(), Some(""));
        assert_eq!(cli.run.prompt_arg.as_deref(), Some("review this"));
        let cli = parse(&["--worktree=fix-1", "review this"]).unwrap();
        assert_eq!(cli.run.worktree.as_deref(), Some("fix-1"));
        assert_eq!(cli.run.prompt_arg.as_deref(), Some("review this"));
        assert!(parse(&["x"]).unwrap().run.worktree.is_none());
        for bad in ["--worktree=../up", "--worktree=a b", "--worktree=-x"] {
            assert_eq!(parse(&[bad, "x"]).unwrap_err().exit_code(), 2, "{bad}");
        }
    }

    #[test]
    fn the_command_line_is_well_formed() {
        use clap::CommandFactory;
        Cli::command().debug_assert();
    }

    #[test]
    fn agents_lists_or_installs() {
        match parse(&["agents", "--json"]).unwrap().command {
            Some(Command::Agents(a)) => assert!(a.json && a.action.is_none()),
            other => panic!("{other:?}"),
        }
        match parse(&[
            "agents",
            "install",
            "claude_code",
            "--version",
            "0.92.0",
            "--wait",
            "10m",
            "--json",
        ])
        .unwrap()
        .command
        {
            Some(Command::Agents(AgentsArgs {
                action: Some(AgentsAction::Install(i)),
                ..
            })) => {
                assert_eq!(i.agent, "claude_code");
                assert_eq!(i.version.as_deref(), Some("0.92.0"));
                assert_eq!(i.wait, Some(Duration::from_secs(600)));
                assert!(i.json);
            }
            other => panic!("{other:?}"),
        }
        assert_eq!(parse(&["agents", "install"]).unwrap_err().exit_code(), 2);
        // The program's own --version stays the program's.
        assert_eq!(parse(&["--version"]).unwrap_err().exit_code(), 0);
    }

    #[test]
    fn automations_lists_or_runs_one() {
        for words in [&["automations"][..], &["automations", "list"][..]] {
            match parse(words).unwrap().command {
                Some(Command::Automations(a)) => {
                    assert!(!matches!(a.action, Some(AutomationsAction::Run(_))))
                }
                other => panic!("{other:?}"),
            }
        }
        match parse(&["automations", "run", "3", "--wait", "5m"])
            .unwrap()
            .command
        {
            Some(Command::Automations(AutomationsArgs {
                action: Some(AutomationsAction::Run(r)),
                ..
            })) => {
                assert_eq!(r.id, 3);
                assert_eq!(r.wait, Some(Duration::from_secs(300)));
            }
            other => panic!("{other:?}"),
        }
        assert_eq!(
            parse(&["automations", "run", "three"])
                .unwrap_err()
                .exit_code(),
            2
        );
    }

    #[test]
    fn standalone_goes_with_what_lives_as_long_as_the_command() {
        assert!(
            parse(&["--standalone", "-a", "codex", "x"])
                .unwrap()
                .global
                .standalone
        );
        assert!(parse(&["agents", "install", "codex", "--standalone"]).is_ok());
        assert!(parse(&["--standalone", "--data-dir", "/d", "x"]).is_ok());
        for words in [
            &["--standalone", "--url", "https://h", "x"][..],
            &["--standalone", "--detach", "x"][..],
            &["--standalone", "result", "8d0c7c2e"][..],
            &["--standalone", "cancel", "8d0c7c2e"][..],
            &["--standalone", "open"][..],
            &["--standalone", "automations", "run", "3", "--wait", "1m"][..],
            &["--standalone", "agents", "install", "codex", "--wait", "1m"][..],
        ] {
            assert_eq!(parse(words).unwrap_err().exit_code(), 2, "{words:?}");
        }
    }

    #[test]
    fn durations_read_as_people_write_them() {
        assert_eq!(parse_duration("90s").unwrap(), Duration::from_secs(90));
        assert_eq!(parse_duration("30m").unwrap(), Duration::from_secs(1800));
        assert_eq!(parse_duration("2h").unwrap(), Duration::from_secs(7200));
        assert_eq!(parse_duration("500ms").unwrap(), Duration::from_millis(500));
        assert_eq!(parse_duration("5").unwrap(), Duration::from_secs(5));
        assert!(parse_duration("0s").is_err());
        assert!(parse_duration("5d").is_err());
        assert!(parse_duration("720h").is_ok());
        // Too far off to be a deadline at all: an error, not a panic.
        assert!(parse_duration("721h").is_err());
        assert!(parse_duration("18446744073709551616s").is_err());
        assert!(parse_duration("1e300").is_err());
    }

    #[test]
    fn config_options_split_on_the_first_equals() {
        let cli = parse(&["-c", "a=b=c", "-c", "auto=true", "x"]).unwrap();
        assert_eq!(
            cli.run.config,
            [("a".into(), "b=c".into()), ("auto".into(), "true".into())]
        );
    }

    #[test]
    fn help_names_the_command_as_the_docs_do() {
        let err = Cli::try_parse_from(["C:\\bin\\codeg-cli.exe", "--help"]).unwrap_err();
        let text = err.render().to_string();
        assert!(text.contains("Usage: codeg-cli"), "{text}");
        assert!(!text.contains(".exe"), "{text}");
        let err = Cli::try_parse_from(["/some/link/name", "--bogus"]).unwrap_err();
        assert!(err.render().to_string().contains("codeg-cli"));
    }
}
