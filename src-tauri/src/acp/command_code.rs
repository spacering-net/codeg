//! Command Code (`command-code`): the parts of its layout and sign-in codeg
//! relies on.
//!
//! Command Code is a terminal coding agent distributed as the npm package
//! `command-code`, whose own `command-code acp` subcommand is its ACP server
//! (see the registry entry). codeg keeps no parser for its store: sessions are
//! trees of entries in `~/.commandcode/projects/<slug>/<id>.jsonl` with sidecar
//! files beside them, a format of its own that no public contract describes, so
//! history comes from codeg's own ACP transcript (`parsers::acp_native`), like
//! TRAE CLI and custom agents. `session/load` still replays a session the CLI
//! stored, which is how a reopened conversation keeps its context.
//!
//! Everything here was verified against `command-code 1.84.0`, and again
//! against 1.86.3, with an isolated `HOME`:
//!
//! * Everything lives in `.commandcode` under the home directory (`HOME`, else
//!   `USERPROFILE`), with no variable to relocate it: `auth.json`,
//!   `config.json`, `mcp.json`, `providers.json`, `skills/`, `projects/`.
//! * User-scope MCP servers live in `mcp.json` as `mcpServers.<name>` entries
//!   of `transport` (`stdio` or `http`; `type` is accepted as an alias, and an
//!   entry without either is inferred from `command` / `url`), `enabled`,
//!   `command` / `args` / `env` and `url` / `headers`, plus an `oauth` block.
//!   There is no `cwd`. Its `mcp` commands drop an `sse` entry, but a session
//!   still connects one through its HTTP client (see the Command Code notes in
//!   `commands/mcp.rs`). `command-code acp` loads this file itself and ALSO
//!   starts the servers `session/new` carries (both reach the model as
//!   deferred `mcp__<server>__<tool>` tools), which is how the codeg-mcp
//!   companion gets in.
//! * Skills are directory bundles (`<id>/SKILL.md`, found recursively; a flat
//!   `<id>.md` is not loaded) from `.commandcode/skills` and the shared
//!   `.agents/skills`, each in the project and under the home directory.
//!   `.claude/skills` is not read.
//! * Sign-in is the CLI's own. `command-code login` stores an API key in
//!   `auth.json`, which the ACP server reuses; a non-empty
//!   [`COMMAND_CODE_API_KEY_ENV`] in its environment outranks that file. The
//!   server checks for one of the two when it opens a session and answers
//!   `authRequired` without, so there is no ACP `authenticate` to send.

use std::path::PathBuf;

/// The API key Command Code reads from its environment ahead of the login in
/// `~/.commandcode/auth.json`: the sign-in for a machine where `command-code
/// login` cannot run its browser flow (a server or Docker install).
pub(crate) const COMMAND_CODE_API_KEY_ENV: &str = "COMMAND_CODE_API_KEY";

/// `~/.commandcode`, where Command Code keeps its login, config, MCP servers,
/// skills and sessions.
pub(crate) fn command_code_home_dir() -> PathBuf {
    command_code_home_dir_from(dirs::home_dir())
}

fn command_code_home_dir_from(home: Option<PathBuf>) -> PathBuf {
    home.unwrap_or_default().join(".commandcode")
}

/// `~/.commandcode/mcp.json`, the user-scope MCP config (`cmd mcp add --scope
/// user`) the CLI loads in every project.
pub(crate) fn command_code_mcp_json_path() -> PathBuf {
    command_code_home_dir().join("mcp.json")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn everything_lives_in_dot_commandcode_under_home() {
        assert_eq!(
            command_code_home_dir_from(Some(PathBuf::from("/home/u"))),
            PathBuf::from("/home/u/.commandcode")
        );
        assert!(command_code_mcp_json_path().ends_with(".commandcode/mcp.json"));
    }
}
