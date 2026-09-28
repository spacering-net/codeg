//! The allowlist of `app_metadata` keys a config snapshot may carry.
//!
//! `app_metadata` is a junk drawer: language, appearance, delegation toggles,
//! OAuth tokens, the local web-service port, and this feature's own WebDAV
//! credentials all share it. An allowlist — not a denylist — is the only safe
//! shape here: a key added by a future feature is device-local until somebody
//! deliberately puts it in this table, so nobody can leak a machine-bound
//! value to another machine by simply forgetting to exclude it.
//!
//! [`FORBIDDEN_PREFERENCE_KEYS`] names the keys that must NEVER travel, with
//! `allowlist_and_credential_keys_are_disjoint` guarding the intersection.

/// `app_metadata` keys that are genuinely user preferences rather than
/// device-local state, and carry no credential.
pub const PORTABLE_PREFERENCE_KEYS: &[&str] = &[
    // Language / appearance.
    "system_language_settings",
    "appearance_mode",
    "appearance_zoom_level",
    // Close-button behavior. Safe to carry: the close path short-circuits on
    // `can_hide_to_tray()` before it ever reads the preference, so pushing
    // `minimize` to a machine without a tray cannot make the window unclosable.
    "system_close_behavior_settings",
    "logging.level",
    // Sub-agent delegation.
    "delegation.enabled",
    "delegation.depth_limit",
    "delegation.agent_defaults",
    "delegation.completed_cache_max_mb",
    // Agent-facing tool toggles.
    "feedback.enabled",
    "question.enabled",
    "session_info.enabled",
    "chat_authoring.automations_enabled",
    "chat_authoring.work_tasks_enabled",
    // Chat channel behavior that carries no credential.
    "chat_command_prefix",
    "chat_message_language",
    "chat_event_filter",
];

/// Keys whose presence in a snapshot would leak a credential or clobber
/// device-local state. Not consulted at runtime — [`is_portable_key`] already
/// answers from the allowlist — but asserted against it in tests so a careless
/// addition to [`PORTABLE_PREFERENCE_KEYS`] fails loudly.
///
/// The sync's own two keys come from `webdav_sync` rather than being spelled
/// again here: a second copy of the literal would let the guard keep passing
/// against a key nothing writes (which is exactly what it did while a stale
/// `config_sync_last_upload` stood in for the real `config_sync_state`).
#[cfg(test)]
pub const FORBIDDEN_PREFERENCE_KEYS: &[&str] = &[
    super::webdav_sync::CONFIG_SYNC_SETTINGS_KEY,
    super::webdav_sync::CONFIG_SYNC_STATE_KEY,
    "system_proxy_settings",
    "system_terminal_settings",
    "web_service_port",
    "web_service_token",
    "web_service_auto_start",
    "github_accounts",
    "chat_event_webhooks",
    "git_settings",
    "pet.config",
    "forge_workbench_settings",
    "canvas_revision",
    "opened_tabs_version",
    "token_usage_fact_schema_version",
];

/// Whether `key` may be collected into, and applied from, a snapshot.
///
/// Applied on BOTH sides on purpose: collection keeps a device-local value out
/// of the uploaded file, and application keeps a hand-edited or hostile
/// snapshot from writing, say, `github_accounts` into this machine.
pub fn is_portable_key(key: &str) -> bool {
    PORTABLE_PREFERENCE_KEYS.contains(&key)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allowlist_has_no_duplicates_and_no_empty_keys() {
        let mut seen = std::collections::HashSet::new();
        for key in PORTABLE_PREFERENCE_KEYS {
            assert!(!key.is_empty());
            assert!(seen.insert(*key), "duplicate portable key: {key}");
        }
    }

    #[test]
    fn allowlist_and_credential_keys_are_disjoint() {
        for key in FORBIDDEN_PREFERENCE_KEYS {
            assert!(
                !is_portable_key(key),
                "{key} must never be synced but is in the allowlist"
            );
        }
    }
}
