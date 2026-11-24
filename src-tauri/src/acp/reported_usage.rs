//! Prompt-response counters are adapter contracts, not a universal ACP ledger.
//!
//! The official Claude adapter reports cache-exclusive, per-prompt main-loop
//! counters. Command Code reports cumulative, cache-inclusive counters, while
//! TRAE has its own native usage enrichment. Unknown adapters stay unsupported
//! until their counter contract is established. ZCode's existing metrics path
//! remains separate. This policy is captured from the launch definition so a
//! registration edit cannot change the interpretation of a running process.

use crate::acp::registry::AgentDistribution;
use crate::models::agent::AgentType;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) enum PromptUsageMode {
    #[default]
    Unsupported,
    PerPromptCacheExclusive,
}

impl PromptUsageMode {
    pub(crate) fn for_distribution(agent: AgentType, distribution: &AgentDistribution) -> Self {
        if !matches!(agent, AgentType::Custom(_)) {
            return Self::Unsupported;
        }
        let AgentDistribution::Npx {
            package,
            cmd,
            version,
            ..
        } = distribution
        else {
            return Self::Unsupported;
        };
        const PACKAGE: &str = "@agentclientprotocol/claude-agent-acp";
        // Accept a version/tag of this package, never an npm alias, URL, fork,
        // or a different executable installed alongside it.
        let version_or_tag = |s: &str| {
            !s.is_empty()
                && s.bytes()
                    .all(|c| c.is_ascii_alphanumeric() || b"._-+^~*".contains(&c))
        };
        let official = *package == PACKAGE
            || package
                .strip_prefix(PACKAGE)
                .and_then(|suffix| suffix.strip_prefix('@'))
                .is_some_and(version_or_tag);
        if official && *cmd == "claude-agent-acp" && version_or_tag(version) {
            Self::PerPromptCacheExclusive
        } else {
            Self::Unsupported
        }
    }

    pub(crate) fn select(
        self,
        usage: Option<&agent_client_protocol::schema::v1::Usage>,
    ) -> Option<&agent_client_protocol::schema::v1::Usage> {
        match self {
            Self::PerPromptCacheExclusive => usage,
            Self::Unsupported => None,
        }
    }

    /// The one model a response's counters were spent on, when the adapter
    /// names it. Without it a turn records the model selector's value, which
    /// for this adapter is an alias (`opus`, `default`) that neither a price
    /// list nor the by-model breakdown can resolve.
    ///
    /// Since 0.71.0 the response's `_meta.quota.model_usage` splits the
    /// prompt's own tally by model id: the prompt's sub-agents are included,
    /// work the agent started on its own is not, and a model with nothing to
    /// report is left out. A single model there is the one every recorded
    /// counter was spent on. Several cannot say which one the main loop used.
    pub(crate) fn reported_model(
        self,
        meta: Option<&agent_client_protocol::schema::v1::Meta>,
    ) -> Option<String> {
        if self != Self::PerPromptCacheExclusive {
            return None;
        }
        let mut spent = meta?
            .get("quota")?
            .get("model_usage")?
            .as_array()?
            .iter()
            .filter(|row| {
                row.pointer("/token_count/totalTokens")
                    .and_then(serde_json::Value::as_u64)
                    .is_some_and(|total| total > 0)
            })
            .map(|row| row.get("model").and_then(serde_json::Value::as_str));
        let model = spent.next()??.trim();
        if model.is_empty() || !spent.all(|other| other.map(str::trim) == Some(model)) {
            return None;
        }
        Some(model.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn npx(package: &'static str, cmd: &'static str, version: &'static str) -> AgentDistribution {
        AgentDistribution::Npx {
            package,
            cmd,
            version,
            args: &[],
            env: &[],
            node_required: None,
        }
    }

    #[test]
    fn recognizes_the_producer_not_the_custom_id_or_display_name() {
        let source = npx(
            "@agentclientprotocol/claude-agent-acp",
            "claude-agent-acp",
            "0.97.0",
        );
        assert_eq!(
            PromptUsageMode::for_distribution(AgentType::Custom("review-seat"), &source),
            PromptUsageMode::PerPromptCacheExclusive
        );
        for source in [
            npx("command-code", "command-code", "1.86.3"),
            npx("trae-cli", "trae", "0.209.1"),
            npx("@example/claude-agent-acp", "claude-agent-acp", "1.0.0"),
            npx(
                "@agentclientprotocol/claude-agent-acp-extra",
                "claude-agent-acp",
                "1.0.0",
            ),
            npx(
                "@agentclientprotocol/claude-agent-acp@npm:other",
                "claude-agent-acp",
                "latest",
            ),
            npx(
                "@agentclientprotocol/claude-agent-acp",
                "other-command",
                "0.97.0",
            ),
            npx(
                "@agentclientprotocol/claude-agent-acp",
                "claude-agent-acp",
                "npm:other",
            ),
        ] {
            assert_eq!(
                PromptUsageMode::for_distribution(AgentType::Custom("claude-code-2"), &source),
                PromptUsageMode::Unsupported
            );
        }
    }

    #[test]
    fn official_versions_keep_native_store_agents_on_their_existing_paths() {
        let source = npx(
            "@agentclientprotocol/claude-agent-acp@0.97.0",
            "claude-agent-acp",
            "latest",
        );
        assert_eq!(
            PromptUsageMode::for_distribution(AgentType::Custom("work"), &source),
            PromptUsageMode::PerPromptCacheExclusive
        );
        for agent in crate::models::agent::BUILTIN_AGENT_TYPES {
            assert_eq!(
                PromptUsageMode::for_distribution(*agent, &source),
                PromptUsageMode::Unsupported
            );
        }
    }

    /// What the manual add form saves: the package spec alone, so the launch
    /// command is derived from it and the version label falls back to
    /// `custom`. That definition must still select the adapter's contract.
    #[test]
    fn a_manually_added_official_adapter_is_recognized_from_its_saved_definition() {
        use crate::acp::custom_registry::{
            build_meta, CustomAgentDef, CustomAgentSpec, CustomDistributionKind, NpxSpec,
        };
        let mode = |package: &str| {
            let meta = build_meta(&CustomAgentDef {
                registry_id: "work-claude".into(),
                name: "Work Claude".into(),
                description: String::new(),
                version: String::new(),
                distribution_kind: CustomDistributionKind::Npx,
                spec: CustomAgentSpec {
                    npx: Some(NpxSpec {
                        package: package.into(),
                        ..Default::default()
                    }),
                    ..Default::default()
                },
                icon_url: None,
                skills_shared_store: false,
                skills_dir: None,
                source: Default::default(),
                version_probe: None,
                supports_mcp: true,
            })
            .unwrap();
            PromptUsageMode::for_distribution(meta.agent_type, &meta.distribution)
        };
        for package in [
            "@agentclientprotocol/claude-agent-acp",
            "@agentclientprotocol/claude-agent-acp@0.97.0",
            "@agentclientprotocol/claude-agent-acp@latest",
        ] {
            assert_eq!(
                mode(package),
                PromptUsageMode::PerPromptCacheExclusive,
                "{package}"
            );
        }
        assert_eq!(
            mode("@zed-industries/claude-code-acp@0.16.0"),
            PromptUsageMode::Unsupported
        );
    }

    #[test]
    fn a_response_names_its_model_only_when_one_model_did_the_work() {
        let meta = |rows: serde_json::Value| -> agent_client_protocol::schema::v1::Meta {
            serde_json::from_value(serde_json::json!({"quota": {"model_usage": rows}})).unwrap()
        };
        let row = |model: &str, total: u64| serde_json::json!({"model": model, "token_count": {"totalTokens": total}});
        let mode = PromptUsageMode::PerPromptCacheExclusive;
        let one = meta(serde_json::json!([row("claude-opus-5-5", 4010)]));
        assert_eq!(
            mode.reported_model(Some(&one)).as_deref(),
            Some("claude-opus-5-5")
        );
        // A model with nothing to report does not make the answer ambiguous.
        let idle = meta(serde_json::json!([
            row("claude-opus-5-5", 4010),
            row("claude-haiku-5-5", 0)
        ]));
        assert_eq!(
            mode.reported_model(Some(&idle)).as_deref(),
            Some("claude-opus-5-5")
        );
        // A sub-agent on another model: which one the main loop used is unknown.
        let two = meta(serde_json::json!([
            row("claude-opus-5-5", 4010),
            row("claude-haiku-5-5", 2005)
        ]));
        assert_eq!(mode.reported_model(Some(&two)), None);
        assert_eq!(
            mode.reported_model(Some(&meta(serde_json::json!([])))),
            None
        );
        assert_eq!(mode.reported_model(None), None);
        assert_eq!(
            PromptUsageMode::Unsupported.reported_model(Some(&one)),
            None
        );
    }

    #[test]
    fn counters_are_not_guessed_for_unknown_or_cumulative_adapters() {
        let usage: agent_client_protocol::schema::v1::Usage = serde_json::from_value(serde_json::json!({
            "inputTokens": 234, "outputTokens": 56, "cachedReadTokens": 1000, "totalTokens": 1290,
        })).unwrap();
        assert!(PromptUsageMode::Unsupported.select(Some(&usage)).is_none());
        assert!(PromptUsageMode::PerPromptCacheExclusive
            .select(Some(&usage))
            .is_some());
        assert!(PromptUsageMode::PerPromptCacheExclusive
            .select(None)
            .is_none());
    }
}
