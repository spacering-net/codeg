//! TRAE CLI (`traecli`): the parts of its layout and sign-in codeg relies on.
//!
//! TRAE CLI 2.0 is ByteDance's terminal coding agent. It is a fork of OpenAI's
//! Codex CLI (the binary its installer ships is `traex`, linked into
//! `~/.local/bin` as `traecli`) with its own ACP server, `traecli acp serve`.
//! codeg launches the user's own install (see the registry entry). TRAE CLI
//! writes Codex-derived rollouts in a paginated format of its own
//! (`history_mutation` / `world_state` records under
//! `<TRAE_HOME>/cli/sessions/YYYY/MM/DD/rollout-*.jsonl`, plus SQLite state
//! beside them) that no public contract describes, so message history comes
//! from codeg's own ACP transcript (`parsers::acp_native`), like ZCode and
//! custom agents. The flat `token_usage_record` rows in those rollouts are
//! read separately by `parsers::trae_usage` to enrich that history with exact
//! usage.
//!
//! Everything here was verified against `traecli 0.209.1` (public channel)
//! with an isolated `HOME`:
//!
//! * `TRAE_HOME` names the `.trae` directory itself and relocates the whole
//!   tree: `traecli.toml`, `skills/`, and the `cli/` runtime dir (sessions,
//!   SQLite state, logs). The value is taken verbatim — `TRAE_HOME=~/x` is NOT
//!   expanded, and a path that does not exist is a startup error.
//!   `TRAECLI_HOME` relocates the `cli/` runtime dir alone.
//! * A rollout's thread id is the ACP session id. Every model request writes
//!   one `token_usage_record` row; a sub-agent's rows go to its own rollout,
//!   named by its own thread id. The prompt response's `usage` covers the
//!   session's own requests only, not its sub-agents'.
//! * MCP servers live in `traecli.toml` as Codex's `[mcp_servers.<name>]`
//!   tables, and `traecli acp serve` loads them itself. Servers sent over ACP
//!   `session/new` are loaded too (both reach the model as `mcp__<server>__*`),
//!   which is how the codeg-mcp companion gets in.
//! * Skills are directory bundles (`<id>/SKILL.md`; a flat `<id>.md` is not
//!   loaded) from `<TRAE_HOME>/skills`, `~/.agents/skills`, and the project's
//!   `.trae/skills` and `.agents/skills`.
//! * Sign-in is TRAE CLI's own. `traecli login` (enterprise SSO in the
//!   browser) or `traecli login --with-trae-pat` stores a credential the ACP
//!   server reuses. The ACP server also advertises two auth methods:
//!   `trae-tob-browser` and [`TRAE_PAT_AUTH_METHOD`]. A
//!   `TRAECLI_PERSONAL_ACCESS_TOKEN` in the environment is NOT used on its own
//!   — `session/new` still answers `Authentication required` — until the PAT
//!   method is invoked through ACP `authenticate`, which exchanges the token.
//!   See [`pat_sign_in_requested`].

use std::collections::BTreeMap;
use std::ffi::OsString;
use std::path::{Path, PathBuf};

use crate::acp::registry::AgentDistribution;
use crate::models::AgentType;
use crate::parsers::AgentEnv;

/// Overrides the `~/.trae` directory (config, skills, sessions).
pub(crate) const TRAE_HOME_ENV: &str = "TRAE_HOME";

/// Overrides TRAE CLI's runtime directory below [`TRAE_HOME_ENV`].
pub(crate) const TRAECLI_HOME_ENV: &str = "TRAECLI_HOME";

/// TRAE CLI's personal access token: the sign-in for a machine without a
/// browser (a server or Docker install). TRAE CLI reads it only when its PAT
/// auth method runs (`traecli login --with-trae-pat`, or ACP `authenticate`
/// with [`TRAE_PAT_AUTH_METHOD`]).
pub(crate) const TRAE_PAT_ENV: &str = "TRAECLI_PERSONAL_ACCESS_TOKEN";

/// The API base URL of an enterprise's own TRAE deployment. Read by the CLI at
/// run time; unset means TRAE's public service.
pub(crate) const TRAE_HOST_ENV: &str = "TRAECLI_HOST";

/// The ACP auth method that exchanges [`TRAE_PAT_ENV`] for a session
/// credential. `traecli 0.209.1` describes it as "Requires
/// `TRAECLI_PERSONAL_ACCESS_TOKEN` to be set before starting TRAE CLI."
pub(crate) const TRAE_PAT_AUTH_METHOD: &str = "trae-tob-pat";

/// Where the Settings page sends a user who has no `traecli` yet: the official
/// quick start, which carries the macOS/Linux and Windows install commands.
pub(crate) const TRAE_INSTALL_URL: &str = "https://docs.trae.cn/cli_get-started-with-trae-cli-2";

/// `TRAE_HOME` if set (and non-empty), else `~/.trae`.
pub(crate) fn resolve_trae_home_dir() -> PathBuf {
    resolve_trae_home_dir_for_env(&AgentEnv::inherited())
}

/// The `.trae` directory of the TRAE CLI launched with `env`.
pub(crate) fn resolve_trae_home_dir_for_env(env: &AgentEnv) -> PathBuf {
    resolve_trae_home_dir_from(env.var_os(TRAE_HOME_ENV), dirs::home_dir())
}

/// The runtime directory that owns TRAE's native session rollouts.
pub(crate) fn resolve_trae_cli_home_dir_for_env(env: &AgentEnv) -> PathBuf {
    env.var_os(TRAECLI_HOME_ENV)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| resolve_trae_home_dir_for_env(env).join("cli"))
}

/// `<TRAECLI_HOME>/sessions`, where `token_usage_record` rows are written.
pub(crate) fn resolve_trae_sessions_dir_for_env(env: &AgentEnv) -> PathBuf {
    resolve_trae_cli_home_dir_for_env(env).join("sessions")
}

fn resolve_trae_home_dir_from(trae_home: Option<OsString>, home: Option<PathBuf>) -> PathBuf {
    if let Some(dir) = trae_home.filter(|value| !value.is_empty()) {
        return PathBuf::from(dir);
    }
    home.unwrap_or_default().join(".trae")
}

/// Whether this agent is backed by TRAE CLI's native rollout store.
///
/// Besides the built-in, this recognizes installations created before TRAE
/// became built in, when users registered `traecli` as a custom ACP agent.
pub(crate) fn uses_trae_rollouts(agent_type: AgentType) -> bool {
    match agent_type {
        AgentType::Trae => true,
        AgentType::Custom(id) => {
            matches!(
                id.to_ascii_lowercase().as_str(),
                "trae" | "traecli" | "trae-cli"
            ) || crate::acp::custom_registry::get(id)
                .is_some_and(|meta| distribution_runs_trae(&meta.distribution))
        }
        _ => false,
    }
}

fn distribution_runs_trae(distribution: &AgentDistribution) -> bool {
    let command = match distribution {
        AgentDistribution::Npx { cmd, .. }
        | AgentDistribution::Binary { cmd, .. }
        | AgentDistribution::Uvx { cmd, .. }
        | AgentDistribution::System { cmd, .. } => cmd,
    };
    let trimmed = command.trim();
    let basename = Path::new(trimmed)
        .file_stem()
        .and_then(|name| name.to_str())
        .unwrap_or(trimmed);
    basename.eq_ignore_ascii_case("traecli") || basename.eq_ignore_ascii_case("traex")
}

/// `<TRAE_HOME>/traecli.toml`, the user config TRAE CLI loads at startup (and
/// where its `[mcp_servers]` live).
pub(crate) fn trae_config_toml_path() -> PathBuf {
    resolve_trae_home_dir().join("traecli.toml")
}

/// Whether a TRAE CLI launched with these per-agent overrides should be signed
/// in with its PAT before codeg opens a session.
///
/// True when the child will see a non-empty [`TRAE_PAT_ENV`]: from the agent's
/// own settings, or inherited from codeg's environment (the usual place for a
/// server or Docker install), unless the settings blank it out. Without the
/// `authenticate` call that this gates, the token would be ignored and every
/// session would be refused for want of a login.
pub(crate) fn pat_sign_in_requested(overrides: &BTreeMap<String, String>) -> bool {
    AgentEnv::from_overrides(overrides.clone())
        .var(TRAE_PAT_ENV)
        .is_some_and(|value| !value.trim().is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trae_home_is_taken_verbatim_and_defaults_to_dot_trae() {
        let home = Some(PathBuf::from("/home/u"));
        assert_eq!(
            resolve_trae_home_dir_from(None, home.clone()),
            PathBuf::from("/home/u/.trae")
        );
        // An empty value is unset, as everywhere else in codeg.
        assert_eq!(
            resolve_trae_home_dir_from(Some(OsString::new()), home.clone()),
            PathBuf::from("/home/u/.trae")
        );
        assert_eq!(
            resolve_trae_home_dir_from(Some(OsString::from("/srv/trae")), home.clone()),
            PathBuf::from("/srv/trae")
        );
        // TRAE CLI does not expand `~` (it refuses `TRAE_HOME=~/x` as a missing
        // path), so codeg must not either: it would read a directory the CLI
        // never uses.
        assert_eq!(
            resolve_trae_home_dir_from(Some(OsString::from("~/x")), home),
            PathBuf::from("~/x")
        );
    }

    #[test]
    fn traecli_home_relocates_the_native_sessions_store() {
        let env = AgentEnv::with_overrides(&[
            (TRAE_HOME_ENV, "/srv/trae"),
            (TRAECLI_HOME_ENV, "/data/trae-runtime"),
        ]);
        assert_eq!(
            resolve_trae_sessions_dir_for_env(&env),
            PathBuf::from("/data/trae-runtime/sessions")
        );

        let env = AgentEnv::with_overrides(&[(TRAE_HOME_ENV, "/srv/trae")]);
        assert_eq!(
            resolve_trae_sessions_dir_for_env(&env),
            PathBuf::from("/srv/trae/cli/sessions")
        );
    }

    #[test]
    fn builtin_and_legacy_custom_trae_agents_use_native_rollouts() {
        assert!(uses_trae_rollouts(AgentType::Trae));
        assert!(uses_trae_rollouts(
            AgentType::custom("traecli").unwrap()
        ));
        assert!(!uses_trae_rollouts(
            AgentType::custom("unrelated-agent").unwrap()
        ));
    }

    #[test]
    fn pat_sign_in_follows_what_the_child_will_see() {
        let with = |pairs: &[(&str, &str)]| -> BTreeMap<String, String> {
            pairs
                .iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect()
        };
        assert!(pat_sign_in_requested(&with(&[(TRAE_PAT_ENV, "pat-123")])));
        // Whitespace is not a token.
        assert!(!pat_sign_in_requested(&with(&[(TRAE_PAT_ENV, "   ")])));
        // An empty override removes the variable from the child's env, so a
        // token codeg itself inherited never reaches it.
        assert!(!pat_sign_in_requested(&with(&[(TRAE_PAT_ENV, "")])));
        // Only the PAT counts; the host alone is not a sign-in.
        if std::env::var_os(TRAE_PAT_ENV).is_none() {
            assert!(!pat_sign_in_requested(&with(&[(
                TRAE_HOST_ENV,
                "https://api.example.com"
            )])));
        }
    }
}
