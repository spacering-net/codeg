use serde::{de::Error as _, Deserialize, Deserializer, Serialize, Serializer};
use std::borrow::Cow;
use std::fmt;

/// Wire prefix marking a custom (user-registered) ACP agent. The full wire
/// form is `custom:<registry-id>`, e.g. `custom:goose`.
pub const CUSTOM_AGENT_WIRE_PREFIX: &str = "custom:";

/// Which agent backs a conversation.
///
/// The fifteen named variants are compile-time built-ins with hand-written
/// launch metadata (`acp::registry`) and a dedicated transcript parser
/// (`parsers::*`). [`AgentType::Custom`] is the open end: a user-registered
/// ACP agent whose launch metadata lives in the database
/// (`acp::custom_registry`) and whose history comes from codeg's own ACP
/// transcript (`parsers::acp_native`) rather than an agent-specific store.
///
/// The `Custom` payload is an **interned** slug (`crate::intern`), not a
/// `String`, so this type stays `Copy` — it is passed by value through
/// hundreds of call sites and lives in `HashMap` keys, and making it non-`Copy`
/// would cascade across the crate.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum AgentType {
    ClaudeCode,
    Codex,
    OpenCode,
    Gemini,
    OpenClaw,
    Cline,
    Hermes,
    CodeBuddy,
    KimiCode,
    Pi,
    Grok,
    Cursor,
    DeepSeek,
    Qoder,
    Antigravity,
    /// A user-registered ACP agent, identified by its ACP-registry id
    /// (interned). Ordered last so built-ins keep their relative order.
    Custom(&'static str),
}

/// The fifteen compile-time agents, in declaration order. Does NOT include
/// custom agents — use [`crate::acp::registry::all_acp_agents`] for the live
/// set that includes them.
pub const BUILTIN_AGENT_TYPES: &[AgentType] = &[
    AgentType::ClaudeCode,
    AgentType::Codex,
    AgentType::OpenCode,
    AgentType::Gemini,
    AgentType::OpenClaw,
    AgentType::Cline,
    AgentType::Hermes,
    AgentType::CodeBuddy,
    AgentType::KimiCode,
    AgentType::Pi,
    AgentType::Grok,
    AgentType::Cursor,
    AgentType::DeepSeek,
    AgentType::Qoder,
    AgentType::Antigravity,
];

impl AgentType {
    /// True for a user-registered agent.
    pub fn is_custom(&self) -> bool {
        matches!(self, AgentType::Custom(_))
    }

    /// Grok's initialize still advertises `image: false`. Native Image
    /// blocks run its describe sidecar; a Resource blob does not. Built-in
    /// Grok and extra isolated Grok slots (`custom:grok-2`, …) share that
    /// sidecar. Other custom agents are left on the advertised bit.
    pub fn uses_grok_image_sidecar(&self) -> bool {
        match self {
            AgentType::Grok => true,
            AgentType::Custom(id) => {
                let id = id.to_ascii_lowercase();
                id == "grok" || id.starts_with("grok-") || id.starts_with("grok_")
            }
            _ => false,
        }
    }

    /// The custom agent's registry id, or `None` for a built-in.
    pub fn custom_id(&self) -> Option<&'static str> {
        match self {
            AgentType::Custom(id) => Some(id),
            _ => None,
        }
    }

    /// Build a custom agent type from a raw registry id, interning the slug.
    /// Returns `None` when the id is not a valid slug (see
    /// [`is_valid_custom_agent_id`]).
    pub fn custom(id: &str) -> Option<Self> {
        if !is_valid_custom_agent_id(id) {
            return None;
        }
        Some(AgentType::Custom(crate::intern::intern(id)))
    }

    /// Stable wire/storage representation. Built-ins keep their historical
    /// snake_case names (this is what is already persisted in
    /// `conversation.agent_type` and `agent_setting.agent_type`); custom
    /// agents serialize as `custom:<id>`.
    pub fn as_wire(&self) -> Cow<'static, str> {
        match self {
            AgentType::ClaudeCode => Cow::Borrowed("claude_code"),
            AgentType::Codex => Cow::Borrowed("codex"),
            AgentType::OpenCode => Cow::Borrowed("open_code"),
            AgentType::Gemini => Cow::Borrowed("gemini"),
            AgentType::OpenClaw => Cow::Borrowed("open_claw"),
            AgentType::Cline => Cow::Borrowed("cline"),
            AgentType::Hermes => Cow::Borrowed("hermes"),
            AgentType::CodeBuddy => Cow::Borrowed("code_buddy"),
            AgentType::KimiCode => Cow::Borrowed("kimi_code"),
            AgentType::Pi => Cow::Borrowed("pi"),
            AgentType::Grok => Cow::Borrowed("grok"),
            AgentType::Cursor => Cow::Borrowed("cursor"),
            AgentType::DeepSeek => Cow::Borrowed("deepseek"),
            AgentType::Qoder => Cow::Borrowed("qoder"),
            AgentType::Antigravity => Cow::Borrowed("antigravity"),
            AgentType::Custom(id) => Cow::Owned(format!("{CUSTOM_AGENT_WIRE_PREFIX}{id}")),
        }
    }

    /// Parse the wire/storage representation produced by [`Self::as_wire`].
    /// Unknown built-in names and malformed `custom:` slugs yield `None`.
    pub fn from_wire(s: &str) -> Option<Self> {
        match s {
            "claude_code" => Some(AgentType::ClaudeCode),
            "codex" => Some(AgentType::Codex),
            "open_code" => Some(AgentType::OpenCode),
            "gemini" => Some(AgentType::Gemini),
            "open_claw" => Some(AgentType::OpenClaw),
            "cline" => Some(AgentType::Cline),
            "hermes" => Some(AgentType::Hermes),
            "code_buddy" => Some(AgentType::CodeBuddy),
            "kimi_code" => Some(AgentType::KimiCode),
            "pi" => Some(AgentType::Pi),
            "grok" => Some(AgentType::Grok),
            "cursor" => Some(AgentType::Cursor),
            "deepseek" => Some(AgentType::DeepSeek),
            "qoder" => Some(AgentType::Qoder),
            "antigravity" => Some(AgentType::Antigravity),
            other => other
                .strip_prefix(CUSTOM_AGENT_WIRE_PREFIX)
                .and_then(AgentType::custom),
        }
    }
}

/// Whether `id` is usable as a custom-agent registry id.
///
/// The id is chosen by the user (or copied from the ACP registry) and is then
/// used as a **filesystem path component** for the binary cache and the ACP
/// transcript store, and embedded in the `custom:<id>` wire form. Keep it to a
/// conservative slug so it can never escape a directory, collide with the
/// wire-form separator, or shadow a built-in name.
pub fn is_valid_custom_agent_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
        // A leading dot would produce a hidden directory (and `.`/`..` would
        // escape one); reject the whole class rather than special-case it.
        && !id.starts_with('.')
        // Must not collide with a built-in wire name, or `from_wire` would be
        // ambiguous and the custom agent could shadow a real one.
        && !matches!(
            id,
            "claude_code"
                | "codex"
                | "open_code"
                | "gemini"
                | "open_claw"
                | "cline"
                | "hermes"
                | "code_buddy"
                | "kimi_code"
                | "pi"
                | "grok"
                | "cursor"
                | "deepseek"
                | "qoder"
                | "antigravity"
        )
}

impl Serialize for AgentType {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.as_wire())
    }
}

impl<'de> Deserialize<'de> for AgentType {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let raw = Cow::<'de, str>::deserialize(deserializer)?;
        AgentType::from_wire(&raw)
            .ok_or_else(|| D::Error::custom(format!("unknown agent type: {raw}")))
    }
}

impl fmt::Display for AgentType {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            AgentType::ClaudeCode => write!(f, "Claude Code"),
            AgentType::Codex => write!(f, "Codex CLI"),
            AgentType::OpenCode => write!(f, "OpenCode"),
            AgentType::Gemini => write!(f, "Gemini CLI"),
            AgentType::OpenClaw => write!(f, "OpenClaw"),
            AgentType::Cline => write!(f, "Cline"),
            AgentType::Hermes => write!(f, "Hermes Agent"),
            AgentType::CodeBuddy => write!(f, "CodeBuddy"),
            AgentType::KimiCode => write!(f, "Kimi Code"),
            AgentType::Pi => write!(f, "Pi"),
            AgentType::Grok => write!(f, "Grok"),
            AgentType::Cursor => write!(f, "Cursor"),
            AgentType::DeepSeek => write!(f, "DeepSeek Harness"),
            AgentType::Qoder => write!(f, "Qoder"),
            AgentType::Antigravity => write!(f, "Google Antigravity"),
            // Prefer the registered display name; fall back to the raw id when
            // the registry has not been hydrated (or the agent was deleted
            // while conversations still reference it).
            AgentType::Custom(id) => match crate::acp::custom_registry::display_name(id) {
                Some(name) => write!(f, "{name}"),
                None => write!(f, "{id}"),
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builtin_wire_names_are_unchanged() {
        // These strings are persisted in `conversation.agent_type` and
        // `agent_setting.agent_type`; changing one silently orphans rows.
        let expected = [
            (AgentType::ClaudeCode, "claude_code"),
            (AgentType::Codex, "codex"),
            (AgentType::OpenCode, "open_code"),
            (AgentType::Gemini, "gemini"),
            (AgentType::OpenClaw, "open_claw"),
            (AgentType::Cline, "cline"),
            (AgentType::Hermes, "hermes"),
            (AgentType::CodeBuddy, "code_buddy"),
            (AgentType::KimiCode, "kimi_code"),
            (AgentType::Pi, "pi"),
            (AgentType::Grok, "grok"),
            (AgentType::Cursor, "cursor"),
            (AgentType::DeepSeek, "deepseek"),
            (AgentType::Qoder, "qoder"),
            (AgentType::Antigravity, "antigravity"),
        ];
        for (agent, wire) in expected {
            assert_eq!(agent.as_wire(), wire);
            assert_eq!(AgentType::from_wire(wire), Some(agent));
            // The JSON form is what `serde_json::to_string` writes to the DB.
            assert_eq!(serde_json::to_string(&agent).unwrap(), format!("\"{wire}\""));
            assert_eq!(
                serde_json::from_str::<AgentType>(&format!("\"{wire}\"")).unwrap(),
                agent
            );
        }
        assert_eq!(BUILTIN_AGENT_TYPES.len(), expected.len());
    }

    #[test]
    fn custom_agents_round_trip_through_serde() {
        let agent = AgentType::custom("goose").expect("valid slug");
        assert!(agent.is_custom());
        assert_eq!(agent.custom_id(), Some("goose"));
        assert_eq!(agent.as_wire(), "custom:goose");
        assert_eq!(serde_json::to_string(&agent).unwrap(), "\"custom:goose\"");
        assert_eq!(
            serde_json::from_str::<AgentType>("\"custom:goose\"").unwrap(),
            agent
        );
        // Interning makes equality cheap AND makes the type usable as a map key.
        let again = AgentType::custom("goose").unwrap();
        assert_eq!(agent, again);
        let mut set = std::collections::HashSet::new();
        set.insert(agent);
        assert!(set.contains(&again));
    }

    #[test]
    fn builtins_are_not_custom() {
        for agent in BUILTIN_AGENT_TYPES {
            assert!(!agent.is_custom());
            assert_eq!(agent.custom_id(), None);
        }
    }

    #[test]
    fn grok_image_sidecar_covers_builtin_and_extra_slots() {
        assert!(AgentType::Grok.uses_grok_image_sidecar());
        assert!(
            AgentType::custom("grok-2")
                .unwrap()
                .uses_grok_image_sidecar()
        );
        assert!(
            AgentType::custom("grok_work")
                .unwrap()
                .uses_grok_image_sidecar()
        );
        assert!(!AgentType::ClaudeCode.uses_grok_image_sidecar());
        assert!(!AgentType::custom("goose").unwrap().uses_grok_image_sidecar());
    }

    #[test]
    fn unknown_wire_forms_are_rejected() {
        assert_eq!(AgentType::from_wire("nope"), None);
        assert_eq!(AgentType::from_wire(""), None);
        // An empty or malformed slug must not produce a usable custom agent.
        assert_eq!(AgentType::from_wire("custom:"), None);
        assert_eq!(AgentType::from_wire("custom:../escape"), None);
        assert_eq!(AgentType::from_wire("custom:a/b"), None);
        assert!(serde_json::from_str::<AgentType>("\"nope\"").is_err());
    }

    #[test]
    fn custom_id_rejects_path_traversal_and_builtin_shadowing() {
        for bad in [
            "",
            ".",
            "..",
            ".hidden",
            "a/b",
            "a\\b",
            "a:b",
            "a b",
            "with\0nul",
            // Shadowing a built-in would make `from_wire` ambiguous.
            "codex",
            "claude_code",
            "deepseek",
            "qoder",
            "antigravity",
        ] {
            assert!(
                !is_valid_custom_agent_id(bad),
                "{bad:?} must be rejected as a custom agent id"
            );
            assert_eq!(AgentType::custom(bad), None);
        }
        assert!(is_valid_custom_agent_id("goose"));
        assert!(is_valid_custom_agent_id("qwen-code"));
        assert!(is_valid_custom_agent_id("github-copilot-cli"));
        assert!(is_valid_custom_agent_id("my_agent.v2"));
        // 64 chars is the ceiling.
        assert!(is_valid_custom_agent_id(&"a".repeat(64)));
        assert!(!is_valid_custom_agent_id(&"a".repeat(65)));
    }

    #[test]
    fn ordering_places_custom_after_builtins() {
        assert!(AgentType::Antigravity < AgentType::custom("goose").unwrap());
        assert!(AgentType::ClaudeCode < AgentType::Cursor);
        assert!(AgentType::Cursor < AgentType::DeepSeek);
        assert!(AgentType::DeepSeek < AgentType::Qoder);
        assert!(AgentType::Qoder < AgentType::Antigravity);
        // Custom agents order lexicographically among themselves.
        assert!(AgentType::custom("aaa").unwrap() < AgentType::custom("bbb").unwrap());
    }

    #[test]
    fn display_falls_back_to_id_when_registry_is_empty() {
        // No registry hydration in this test, so Display must degrade to the
        // raw slug rather than panic or print `Custom("…")`.
        let agent = AgentType::custom("some-unregistered-agent").unwrap();
        assert_eq!(agent.to_string(), "some-unregistered-agent");
    }
}
