//! Primary agents the CodeArts bridge advertises as a `mode` config option.
//!
//! `codearts agent list` prints one header line per agent followed by that
//! agent's permission JSON. Only headers ending in ` (primary)` are selectable
//! as a session mode (e.g. `build`, `plan`); subagents and hidden agents are
//! either omitted or marked differently. The name is everything before the
//! trailing ` (primary)` marker.

use std::time::{Duration, Instant};

use crate::acp::codearts_models::codearts_command;

const CACHE_TTL: Duration = Duration::from_secs(300);
const FETCH_TIMEOUT: Duration = Duration::from_secs(30);

/// Extract primary agent names from `codearts agent list` output.
///
/// A line qualifies when its trimmed form ends with the exact ` (primary)`
/// marker; the name is the prefix before that marker, trimmed. Blank names,
/// duplicates and non-primary lines are ignored. Order of first appearance is
/// preserved so the picker is stable.
pub fn parse_primary_agents(output: &str) -> Vec<String> {
    const MARKER: &str = " (primary)";
    let mut agents: Vec<String> = Vec::new();
    for line in output.lines() {
        let trimmed = line.trim();
        let Some(bare) = trimmed.strip_suffix(MARKER) else {
            continue;
        };
        let name = bare.trim();
        if name.is_empty() {
            continue;
        }
        if !agents.iter().any(|existing| existing == name) {
            agents.push(name.to_string());
        }
    }
    agents
}

/// Per-bridge-process cache so the CLI is not spawned on every prompt.
pub struct AgentCatalog {
    agents: Vec<String>,
    fetched_at: Option<Instant>,
}

impl Default for AgentCatalog {
    fn default() -> Self {
        Self::new()
    }
}

impl AgentCatalog {
    pub fn new() -> Self {
        Self {
            agents: Vec::new(),
            fetched_at: None,
        }
    }

    pub fn agents(&self) -> &[String] {
        &self.agents
    }

    /// Refresh unless still fresh; returns whether the list changed.
    pub async fn refresh(&mut self, force: bool) -> bool {
        let fresh = self
            .fetched_at
            .is_some_and(|at| at.elapsed() < CACHE_TTL);
        if !force && fresh {
            return false;
        }
        let fetched = tokio::time::timeout(FETCH_TIMEOUT, async {
            codearts_command(&["agent", "list"])
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::null())
                .output()
                .await
        })
        .await;
        let output = match fetched {
            Ok(Ok(out)) if out.status.success() => out,
            Ok(Ok(out)) => {
                tracing::warn!(
                    "[CodeArts] agent list exited {:?}; keeping cached agents",
                    out.status
                );
                return false;
            }
            Ok(Err(err)) => {
                tracing::warn!("[CodeArts] could not list agents: {err}; keeping cached agents");
                return false;
            }
            Err(_) => {
                tracing::warn!(
                    "[CodeArts] agent list timed out after {:?}; keeping cached agents",
                    FETCH_TIMEOUT
                );
                return false;
            }
        };
        let text = String::from_utf8_lossy(&output.stdout);
        let parsed = parse_primary_agents(&text);
        if parsed.is_empty() {
            tracing::warn!("[CodeArts] agent list had no primary agents; keeping cached agents");
            return false;
        }
        let changed = parsed != self.agents;
        self.agents = parsed;
        self.fetched_at = Some(Instant::now());
        changed
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_primary_headers_ignoring_permission_json() {
        let sample = "\
build (primary)
  [
    { \"permission\": \"*\", \"action\": \"allow\" }
  ]
plan (primary)
  []
general (subagent)
  []
title (primary)
  []
";
        assert_eq!(
            parse_primary_agents(sample),
            vec![
                "build".to_string(),
                "plan".to_string(),
                "title".to_string()
            ]
        );
    }

    #[test]
    fn deduplicates_and_ignores_malformed_markers() {
        let sample = "build (primary)\nbuild (primary)\n(primary)\n  x (primary) \nBuild (primary)";
        assert_eq!(
            parse_primary_agents(sample),
            vec!["build".to_string(), "x".to_string(), "Build".to_string()]
        );
    }

    #[test]
    fn no_primary_agents_means_empty() {
        assert!(parse_primary_agents("general (subagent)\n{}").is_empty());
    }
}
