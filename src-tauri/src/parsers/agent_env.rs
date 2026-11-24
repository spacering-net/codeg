//! The environment an agent is launched with, as far as finding its own files
//! goes.

use std::collections::{BTreeMap, HashMap};
use std::ffi::OsString;

use crate::models::AgentType;

/// The per-agent environment codeg launches an agent with, seen through the
/// variables a history parser reads to find that agent's data directory.
///
/// Every agent CLI picks its data directory from its environment
/// (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `GROK_HOME`, …), and codeg launches it
/// with the agent settings' `env_json` laid over codeg's own environment
/// (`acp::connection::merge_agent_env`). A parser that consults codeg's own
/// environment alone looks in the default directory while the agent writes
/// somewhere else: the import finds nothing, and a conversation codeg ran
/// itself opens with no messages (#948).
///
/// A lookup answers what the launched child sees for the variable:
/// * a non-empty override → that value, verbatim;
/// * an override of exactly `""` → nothing: the spawn layer `env_remove`s it
///   (`acp::agent_process`), so the agent falls back to its default rather
///   than inheriting codeg's value;
/// * no override → codeg's own value, which the child inherits.
///
/// Only the overrides are stored, and only the resolvers in `crate::parsers`
/// read them — nothing here touches codeg's own process environment.
/// [`AgentEnv::inherited`] (no overrides) answers exactly what `std::env`
/// does, which is how the resolvers' no-argument forms keep their meaning for
/// every caller that is not reading history.
///
/// The home directory the defaults hang off is still codeg's: a `HOME`
/// override is not followed here.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct AgentEnv {
    overrides: BTreeMap<String, String>,
}

impl AgentEnv {
    /// No overrides: the environment of an agent launched without per-agent
    /// settings, which is codeg's own.
    pub fn inherited() -> Self {
        Self::default()
    }

    /// The overrides a launch lays over codeg's environment — the
    /// `runtime_env` of `acp::connection`.
    pub fn from_overrides(overrides: BTreeMap<String, String>) -> Self {
        Self { overrides }
    }

    /// The overrides an agent settings row's `env_json` holds. JSON that does
    /// not parse contributes none, which is what the launch makes of it too
    /// (`commands::acp::build_runtime_env_from_setting`).
    pub fn from_env_json(env_json: Option<&str>) -> Self {
        Self::from_overrides(
            env_json
                .and_then(|raw| serde_json::from_str::<BTreeMap<String, String>>(raw).ok())
                .unwrap_or_default(),
        )
    }

    /// `key` as the launched agent sees it — the `std::env::var_os` of an
    /// agent's own resolver. See the type docs for the three cases.
    pub fn var_os(&self, key: &str) -> Option<OsString> {
        match self.override_for(key) {
            Some("") => None,
            Some(value) => Some(OsString::from(value)),
            None => std::env::var_os(key),
        }
    }

    /// [`Self::var_os`] as UTF-8 text, for the resolvers that read their
    /// variable through `std::env::var`: a value that is not valid Unicode
    /// counts as unset, as it does there.
    pub fn var(&self, key: &str) -> Option<String> {
        self.var_os(key).and_then(|value| value.into_string().ok())
    }

    /// The override for `key`, matched the way the spawn applies it. Names
    /// are case-insensitive on Windows — `claude_config_dir` in `env_json` IS
    /// the `CLAUDE_CONFIG_DIR` the child reads — and when several spellings
    /// are present the spawn applies them in map order, so the last one wins
    /// (the rule `commands::acp::launch_env_value` follows).
    fn override_for(&self, key: &str) -> Option<&str> {
        if cfg!(windows) {
            self.overrides
                .iter()
                .rev()
                .find(|(name, _)| name.eq_ignore_ascii_case(key))
                .map(|(_, value)| value.as_str())
        } else {
            self.overrides.get(key).map(String::as_str)
        }
    }
}

/// [`AgentEnv`] per agent, for a caller that reads several agents' histories
/// in one pass. An agent with no entry gets [`AgentEnv::inherited`].
#[derive(Clone, Debug, Default)]
pub struct AgentEnvs(HashMap<AgentType, AgentEnv>);

impl AgentEnvs {
    pub fn insert(&mut self, agent_type: AgentType, env: AgentEnv) {
        self.0.insert(agent_type, env);
    }

    pub fn get(&self, agent_type: AgentType) -> AgentEnv {
        self.0.get(&agent_type).cloned().unwrap_or_default()
    }
}

#[cfg(test)]
impl AgentEnv {
    /// Exactly these overrides — shorthand for tests.
    pub(crate) fn with_overrides(pairs: &[(&str, &str)]) -> Self {
        Self::from_overrides(
            pairs
                .iter()
                .map(|(key, value)| (key.to_string(), value.to_string()))
                .collect(),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env(pairs: &[(&str, &str)]) -> AgentEnv {
        AgentEnv::with_overrides(pairs)
    }

    /// A key no test process sets, so "inherited" has a known answer.
    const UNSET_KEY: &str = "CODEG_TEST_AGENT_ENV_NEVER_SET_948";

    #[test]
    fn an_override_wins_verbatim() {
        let env = env(&[(UNSET_KEY, " /srv/claude ")]);
        assert_eq!(env.var_os(UNSET_KEY), Some(OsString::from(" /srv/claude ")));
        assert_eq!(env.var(UNSET_KEY).as_deref(), Some(" /srv/claude "));
    }

    /// An empty override is a REMOVAL for the child, so it must not read
    /// through to codeg's own value: `PATH` is set in every test process, and
    /// the child launched with `PATH=""` still sees no `PATH` at all.
    #[test]
    fn an_empty_override_removes_the_variable_instead_of_inheriting_it() {
        assert!(std::env::var_os("PATH").is_some(), "test needs PATH set");
        let env = env(&[("PATH", "")]);
        assert_eq!(env.var_os("PATH"), None);
        assert_eq!(env.var("PATH"), None);
    }

    #[test]
    fn no_override_inherits_codegs_own_environment() {
        let env = env(&[(UNSET_KEY, "/elsewhere")]);
        assert_eq!(env.var_os("PATH"), std::env::var_os("PATH"));
        assert_eq!(
            AgentEnv::inherited().var_os("PATH"),
            std::env::var_os("PATH")
        );
        assert_eq!(AgentEnv::inherited().var_os(UNSET_KEY), None);
    }

    #[test]
    fn env_json_is_read_like_the_launch_reads_it() {
        let parsed = AgentEnv::from_env_json(Some(r#"{"CLAUDE_CONFIG_DIR":"/srv/claude"}"#));
        assert_eq!(parsed, env(&[("CLAUDE_CONFIG_DIR", "/srv/claude")]));
        // Unparseable JSON and a missing row both mean "no overrides".
        assert_eq!(
            AgentEnv::from_env_json(Some("{oops")),
            AgentEnv::inherited()
        );
        assert_eq!(AgentEnv::from_env_json(None), AgentEnv::inherited());
    }

    #[cfg(windows)]
    #[test]
    fn windows_matches_names_case_insensitively_and_the_last_spelling_wins() {
        let lower = UNSET_KEY.to_lowercase();
        let env = env(&[(UNSET_KEY, "/upper"), (lower.as_str(), "/lower")]);
        assert_eq!(env.var_os(UNSET_KEY), Some(OsString::from("/lower")));
    }

    #[test]
    fn a_missing_agent_gets_the_inherited_env() {
        let mut envs = AgentEnvs::default();
        envs.insert(AgentType::ClaudeCode, env(&[(UNSET_KEY, "/x")]));
        assert_eq!(envs.get(AgentType::ClaudeCode), env(&[(UNSET_KEY, "/x")]));
        assert_eq!(envs.get(AgentType::Codex), AgentEnv::inherited());
    }
}
