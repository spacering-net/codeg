//! Hermes exposes the same edit policy through native config and legacy modes.
//! Keep their confirmed values coherent for snapshots, CLI and composer users.

use super::types::{SessionConfigKindInfo, SessionConfigOptionInfo};

pub(crate) const HERMES_MODE_OPTION_ID: &str = "mode";
pub(crate) const HERMES_EDIT_POLICY_OPTION_ID: &str = "edit_approval_policy";
pub(crate) const HERMES_EDIT_POLICY_MODES: [(&str, &str); 3] = [
    ("ask", "default"),
    ("workspace_session", "accept_edits"),
    ("session", "dont_ask"),
];

pub(crate) fn hermes_mode_for_edit_policy(policy: &str) -> Option<&'static str> {
    HERMES_EDIT_POLICY_MODES
        .iter()
        .find(|(known, _)| *known == policy)
        .map(|(_, mode)| *mode)
}

fn policy_for_mode(mode: &str) -> Option<&'static str> {
    HERMES_EDIT_POLICY_MODES
        .iter()
        .find(|(_, known)| *known == mode)
        .map(|(policy, _)| *policy)
}

pub(crate) fn mode_from_options(options: &[SessionConfigOptionInfo]) -> Option<&str> {
    let option = options
        .iter()
        .find(|o| o.id == HERMES_EDIT_POLICY_OPTION_ID)
        .or_else(|| options.iter().find(|o| o.id == HERMES_MODE_OPTION_ID))?;
    let SessionConfigKindInfo::Select(select) = &option.kind else {
        return None;
    };
    if option.id == HERMES_EDIT_POLICY_OPTION_ID {
        hermes_mode_for_edit_policy(&select.current_value)
    } else {
        Some(&select.current_value)
    }
}

pub(crate) fn sync_options_to_mode(options: &mut [SessionConfigOptionInfo], mode: &str) -> bool {
    let mut changed = false;
    for option in options {
        let value = match option.id.as_str() {
            HERMES_MODE_OPTION_ID => Some(mode),
            HERMES_EDIT_POLICY_OPTION_ID => policy_for_mode(mode),
            _ => None,
        };
        if let (Some(value), SessionConfigKindInfo::Select(select)) = (value, &mut option.kind) {
            if select.current_value != value {
                select.current_value = value.to_string();
                changed = true;
            }
        }
    }
    changed
}
