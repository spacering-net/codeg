//! WHICH SIDE of the ACP connection actually touches the disk and spawns
//! commands — a peer of
//! [`FsAccessPolicy`](crate::acp::file_system_runtime::FsAccessPolicy), not a
//! part of it (it governs the `terminal/*` channel too).
//!
//! codeg advertises `fs.readTextFile` / `fs.writeTextFile` / `terminal` on
//! Initialize, and an agent that sees them stops using its own in-process
//! backends and delegates: grok, for instance, switches from its local file
//! reader to `fs/read_text_file` and from its local shell to `terminal/create`.
//! codeg then services both **in codeg's own process**
//! ([`crate::acp::file_system_runtime::FileSystemRuntime`],
//! [`crate::acp::terminal_runtime::TerminalRuntime`]).
//!
//! That is the whole of issue #436: an OS-level sandbox the agent applies to
//! ITSELF (grok's seatbelt/landlock profiles, `~/.grok/sandbox.toml`) covers the
//! agent's process tree. codeg's process is not in it, so a kernel deny on
//! `**/.env` is structurally unable to see the read — the audit log records the
//! profile as applied and enforced, and no violation, because from the kernel's
//! point of view the agent never touched the file.
//!
//! codeg cannot fix that by *containing* the agent. Refusing the capabilities
//! instead restores the agent's ability to contain ITSELF: the operations move
//! back inside its process, where its own sandbox and permission rules already
//! work. Measured against grok 1.0.0 with `deny = ["**/.env_test"]`: with the
//! capabilities advertised the secret is read and nothing is logged; with them
//! withheld the read fails `EPERM`, the agent's `cat`/`grep` fallbacks fail too
//! (they are children of ITS process), and `FsViolation` lands in the audit log.
//!
//! Opt-in, because it is not free — see [`HostToolsPolicy::Agent`].

use std::collections::BTreeMap;

use crate::acp::file_system_runtime::env_value;

/// Per-agent `env_json` / process-env key selecting which side hosts the
/// `fs/*` and `terminal/*` channels. `default` | `agent`; anything else warns
/// and falls back to `default`.
pub(crate) const HOST_TOOLS_ENV: &str = "CODEG_ACP_HOST_TOOLS";

/// The value that hands the channels back to the agent. Kept as a constant
/// because the settings UI writes this exact string into `env_json`.
pub(crate) const HOST_TOOLS_AGENT: &str = "agent";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HostToolsPolicy {
    /// codeg advertises and services `fs/*` + `terminal/*`. Historical
    /// behaviour and still the default: most agents ship no sandbox, so there
    /// is nothing to restore, and codeg's hosting buys a consistent cwd and a
    /// single place to apply
    /// [`FsAccessPolicy`](crate::acp::file_system_runtime::FsAccessPolicy)'s
    /// write roots.
    Default,
    /// codeg advertises NEITHER channel, and refuses both if called anyway.
    /// The agent falls back to its own file and shell backends, so its own
    /// OS sandbox and permission rules govern every read, write and command.
    ///
    /// It also withholds codeg-mcp's `delegation` tool group (see
    /// `inject_codeg_mcp`). `delegate_to_agent` is a third door into the same
    /// room: it has codeg spawn a SECOND agent, in codeg's process tree under
    /// that agent's own policy, and relays its output back — so a sandboxed
    /// agent that cannot read `.env` itself would simply ask a sibling to read
    /// it. The remaining companion groups (feedback, ask, session info, task
    /// reporting) surface codeg's own state rather than executing anything on
    /// the user's machine, so they stay.
    ///
    /// The cost, and why this is opt-in rather than the default: codeg's fs
    /// write-root policy no longer applies (the agent's does), commands no
    /// longer run through [`crate::acp::terminal_runtime::TerminalRuntime`],
    /// and this agent cannot delegate.
    /// Tool calls still stream as `session/update` notifications, so the
    /// timeline is unchanged, and the agent process already carries
    /// `GIT_CONFIG_*` and the OfficeCLI PATH entry (see `merge_agent_env`), so
    /// its own shell inherits them.
    Agent,
}

impl HostToolsPolicy {
    /// Resolve from [`HOST_TOOLS_ENV`], checking the agent's `runtime_env`
    /// first (so it rides along in the existing per-agent `env_json`) then
    /// codeg's own process env — the same precedence, and the same helper, as
    /// [`crate::acp::file_system_runtime::FsAccessPolicy::from_env`].
    pub fn from_env(runtime_env: &BTreeMap<String, String>) -> Self {
        match env_value(runtime_env, HOST_TOOLS_ENV).as_deref() {
            None | Some("") | Some("default") => Self::Default,
            Some(HOST_TOOLS_AGENT) => Self::Agent,
            Some(other) => {
                tracing::warn!(
                    "[ACP] unrecognized {HOST_TOOLS_ENV}={other:?}; falling back to \"default\""
                );
                Self::Default
            }
        }
    }

    /// Whether codeg hosts the `fs/*` and `terminal/*` channels this launch.
    /// One predicate for both because splitting them buys no boundary: an
    /// agent refused the read gate reaches the same file through a shell, and
    /// an agent refused the shell reads it through the fs channel. Only
    /// withholding BOTH moves the operations back under the agent's sandbox.
    pub fn hosts_channels(self) -> bool {
        matches!(self, Self::Default)
    }

    /// One-line summary for the connection log.
    pub fn describe(self) -> &'static str {
        match self {
            Self::Default => "codeg (fs + terminal advertised)",
            Self::Agent => "agent (fs + terminal withheld; the agent's own sandbox applies)",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn runtime(value: &str) -> BTreeMap<String, String> {
        BTreeMap::from([(HOST_TOOLS_ENV.to_string(), value.to_string())])
    }

    #[test]
    fn resolution_table() {
        // The knob is absent for virtually every launch, and that must stay
        // the historical behaviour — a default that withheld the channels
        // would silently break every agent's terminal.
        temp_env::with_var_unset(HOST_TOOLS_ENV, || {
            assert_eq!(
                HostToolsPolicy::from_env(&BTreeMap::new()),
                HostToolsPolicy::Default
            );
            assert_eq!(
                HostToolsPolicy::from_env(&runtime("")),
                HostToolsPolicy::Default
            );
            assert_eq!(
                HostToolsPolicy::from_env(&runtime("default")),
                HostToolsPolicy::Default
            );
            assert_eq!(
                HostToolsPolicy::from_env(&runtime("agent")),
                HostToolsPolicy::Agent
            );
            // Fail OPEN on a typo, not closed: a misspelled knob that silently
            // withheld the channels would look like a broken agent, not like a
            // misconfiguration. The warning is what points at the typo.
            assert_eq!(
                HostToolsPolicy::from_env(&runtime("strict")),
                HostToolsPolicy::Default
            );
        });
    }

    #[test]
    fn value_is_trimmed_and_case_sensitive() {
        temp_env::with_var_unset(HOST_TOOLS_ENV, || {
            // `env_value` trims — a value pasted with trailing whitespace must
            // still take effect.
            assert_eq!(
                HostToolsPolicy::from_env(&runtime("  agent  ")),
                HostToolsPolicy::Agent
            );
            // But it is not case-folded, matching CODEG_ACP_FS_POLICY. The UI
            // writes the exact constant, so only a hand-edit can hit this, and
            // it warns rather than guessing.
            assert_eq!(
                HostToolsPolicy::from_env(&runtime("Agent")),
                HostToolsPolicy::Default
            );
        });
    }

    #[test]
    fn per_agent_env_json_wins_over_process_env() {
        // The whole point of reading `runtime_env` first: the knob is set per
        // agent from the settings UI, so one sandboxed agent can hand its
        // channels back without changing how codeg hosts every other agent.
        temp_env::with_var(HOST_TOOLS_ENV, Some("default"), || {
            assert_eq!(
                HostToolsPolicy::from_env(&runtime("agent")),
                HostToolsPolicy::Agent
            );
        });
        temp_env::with_var(HOST_TOOLS_ENV, Some("agent"), || {
            // Process env applies when the agent says nothing...
            assert_eq!(
                HostToolsPolicy::from_env(&BTreeMap::new()),
                HostToolsPolicy::Agent
            );
            // ...and the agent can opt back out of it.
            assert_eq!(
                HostToolsPolicy::from_env(&runtime("default")),
                HostToolsPolicy::Default
            );
        });
    }

    #[test]
    fn hosts_channels_is_the_single_gate() {
        assert!(HostToolsPolicy::Default.hosts_channels());
        assert!(!HostToolsPolicy::Agent.hosts_channels());
    }

    #[test]
    fn the_reported_agent_mode_covers_the_process_env_layer() {
        // `AcpAgentInfo::host_tools_agent_mode` is exactly
        // `!from_env(&env).hosts_channels()`. The settings UI reads that field
        // rather than the agent's `env` map, because an operator who exported
        // the knob for codeg itself sets it for every agent whose own env_json
        // is silent — and those agents lose delegation with no warning if the
        // frontend only inspects `env`.
        let agent_mode = |env: &BTreeMap<String, String>| {
            !HostToolsPolicy::from_env(env).hosts_channels()
        };
        temp_env::with_var(HOST_TOOLS_ENV, Some("agent"), || {
            assert!(agent_mode(&BTreeMap::new()));
            assert!(!agent_mode(&runtime("default")));
        });
        temp_env::with_var_unset(HOST_TOOLS_ENV, || {
            assert!(!agent_mode(&BTreeMap::new()));
            assert!(agent_mode(&runtime("agent")));
        });
    }
}
