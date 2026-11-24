//! Headless runs for `codeg-cli`: one prompt, one turn, owned by the runtime.
//!
//! The CLI is a thin HTTP client. Everything that has to keep working when it
//! goes away — answering permissions by the run's policy, settling the result,
//! waiting for the conversation row to reach its final status before the
//! connection is let go — happens here, in the runtime that runs the agent.

pub mod agent_install;
pub mod automations;
pub mod command_tool;
pub mod discovery;
pub mod events;
pub mod hello;
pub mod http;
pub mod listener;
pub mod output_schema;
pub mod policy;
pub mod service;
pub mod shim;
pub mod wire;
pub mod worktree;

pub use output_schema::OutputSchema;
pub use policy::{CliRunTag, PermissionPolicy, RootSeed};
pub use listener::{CliAccess, CliAccessStatus};
pub use service::{CliError, CliRunService, SessionOpener};

/// The variable every agent process, and every command it runs through an ACP
/// terminal, gets: the id of the connection it belongs to. A `codeg-cli` run
/// from inside it sends this as its caller, so the runtime — not the caller —
/// decides its depth and its policy ceiling from that connection's record.
pub const CLI_CALLER_ENV: &str = "CODEG_CLI_CALLER";
