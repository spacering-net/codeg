//! Pre-prompt context compaction for task runs.
//!
//! A task that goes through several rounds (retry, follow-up, merge) keeps
//! resuming the SAME agent session, so its context window only ever grows. Past
//! a certain occupancy the next round either truncates silently or fails
//! outright — which is why the folder's task settings can name a threshold
//! (`auto_compact_percent`): at or above it, a resumed launch sends the agent's
//! compact command and waits for that turn to land before sending the round's
//! own message.
//!
//! This module is the decision half — which command, and does the reading clear
//! the bar. The turn itself is driven by `engine::TaskEngine::compact_context`.

use crate::acp::types::AvailableCommandInfo;
use crate::models::agent::AgentType;

/// Slash-command names that mean "compact this session", most preferred first.
/// Matched against what the live session actually advertises, so an agent that
/// spells it `/compress` is handled without codeg knowing that agent by name.
const COMPACTION_COMMAND_NAMES: &[&str] = &["compact", "compress", "summarize", "summarise"];

/// The compact command for an agent that advertises no matching slash command.
///
/// Deliberately short: it lists only the agents whose compact command is known
/// first-hand. An agent that is missing here (and advertises nothing that
/// matches) resolves to `None`, and the launch records a skip on the timeline
/// rather than firing a guessed command at it — a wrong guess would spend a
/// whole turn writing the guess into the transcript as ordinary prose.
/// The settings' `compact_command` override is the escape hatch for the rest.
fn builtin_default(agent_type: AgentType) -> Option<&'static str> {
    match agent_type {
        AgentType::ClaudeCode | AgentType::Codex | AgentType::Grok => Some("/compact"),
        AgentType::Gemini => Some("/compress"),
        _ => None,
    }
}

/// Resolve the command that compacts this session, in precedence order:
///
/// 1. the folder setting's explicit `compact_command` (used VERBATIM — the
///    point of the override is that the user knows something we don't, so we
///    neither prepend a slash nor rewrite what they typed);
/// 2. a matching name in what the live session advertises;
/// 3. [`builtin_default`] for the agent.
///
/// Step 3 runs even when the session DID advertise commands: an agent's
/// catalog can list only project-defined commands while its built-ins (like
/// `/compact`) work perfectly well unlisted, so an advertised catalog that
/// misses the verb is treated as no information, not as a denial.
///
/// `None` means "this agent has no compact command we know of" — the caller
/// skips compaction and says so on the timeline.
pub fn resolve_compact_command(
    explicit: Option<&str>,
    agent_type: AgentType,
    advertised: &[AvailableCommandInfo],
) -> Option<String> {
    if let Some(explicit) = explicit.map(str::trim).filter(|c| !c.is_empty()) {
        return Some(explicit.to_string());
    }
    for candidate in COMPACTION_COMMAND_NAMES {
        if let Some(cmd) = advertised.iter().find(|c| {
            c.name
                .trim()
                .trim_start_matches('/')
                .eq_ignore_ascii_case(candidate)
        }) {
            return Some(format!("/{}", cmd.name.trim().trim_start_matches('/')));
        }
    }
    builtin_default(agent_type).map(str::to_string)
}

/// Context-window occupancy as a percentage, or `None` when the pair says
/// nothing: a zero/absent window size is "the agent never told us how big its
/// context is", and `used == 0` is how several adapters report a turn they
/// could not account for (see the composer's context ring, which treats it the
/// same way). Guessing from either would compact a session that may be nearly
/// empty.
pub fn occupancy_percent(used: Option<u64>, size: Option<u64>) -> Option<f64> {
    let (used, size) = (used?, size?);
    if used == 0 || size == 0 {
        return None;
    }
    Some((used as f64 / size as f64) * 100.0)
}

/// Whether a transcript recorded under `row_session` describes the context of
/// the live `connection_session` that is about to be compacted.
///
/// Only an exact match counts. The two normally agree — the launch resumed the
/// row's session — but an agent that swallowed a `session/load` failure and
/// started a fresh session instead still reports success to `spawn_agent`, so
/// the row can name a nearly full session while the connection holds an empty
/// one. An unknown id on either side is not a match: "we cannot tell" must read
/// as "do not measure", never as "close enough".
///
/// Deliberately NOT `continued_session_ids`: that relation answers "is this the
/// same CONVERSATION", and a continuation is exactly the case where the agent
/// restarted and rebuilt its context — the old transcript's occupancy would not
/// describe the new session.
pub fn transcript_describes_live_session(
    row_session: Option<&str>,
    connection_session: Option<&str>,
) -> bool {
    matches!((row_session, connection_session), (Some(row), Some(live)) if row == live)
}

/// Whether `percent` occupancy trips a `threshold`-percent setting. A
/// non-positive threshold is the off switch; anything above 100 can never
/// trip, which is a legitimate way to park the feature without losing the
/// command you configured beside it.
pub fn trips_threshold(percent: f64, threshold: i32) -> bool {
    threshold > 0 && percent >= threshold as f64
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cmd(name: &str) -> AvailableCommandInfo {
        AvailableCommandInfo {
            name: name.to_string(),
            description: String::new(),
            input_hint: None,
            skill: false,
            skill_path: None,
        }
    }

    #[test]
    fn an_explicit_setting_wins_verbatim() {
        assert_eq!(
            resolve_compact_command(
                Some("  /compact --force "),
                AgentType::ClaudeCode,
                &[cmd("compress")]
            ),
            Some("/compact --force".to_string())
        );
    }

    #[test]
    fn a_blank_setting_is_not_a_command() {
        assert_eq!(
            resolve_compact_command(Some("   "), AgentType::ClaudeCode, &[]),
            Some("/compact".to_string())
        );
    }

    #[test]
    fn an_advertised_command_beats_the_builtin_default() {
        // Codex's built-in default is `/compact`; a session advertising
        // `/compress` is answering the question directly, so it wins.
        assert_eq!(
            resolve_compact_command(None, AgentType::Codex, &[cmd("plan"), cmd("compress")]),
            Some("/compress".to_string())
        );
    }

    #[test]
    fn the_preference_order_decides_when_several_are_advertised() {
        assert_eq!(
            resolve_compact_command(
                None,
                AgentType::OpenCode,
                &[cmd("summarize"), cmd("compress"), cmd("compact")]
            ),
            Some("/compact".to_string())
        );
    }

    #[test]
    fn an_advertised_name_may_carry_its_own_slash() {
        assert_eq!(
            resolve_compact_command(None, AgentType::OpenCode, &[cmd("/Compact")]),
            Some("/Compact".to_string())
        );
    }

    #[test]
    fn a_catalog_without_the_verb_still_falls_back_to_the_builtin() {
        // Claude's catalog is mostly project-defined commands; `/compact` works
        // whether or not it is listed, so a non-matching catalog must not read
        // as "this agent cannot compact".
        assert_eq!(
            resolve_compact_command(None, AgentType::ClaudeCode, &[cmd("review"), cmd("goal")]),
            Some("/compact".to_string())
        );
    }

    #[test]
    fn an_unknown_agent_with_nothing_advertised_resolves_to_nothing() {
        assert_eq!(resolve_compact_command(None, AgentType::Pi, &[]), None);
    }

    #[test]
    fn occupancy_needs_both_halves_to_be_real() {
        assert_eq!(occupancy_percent(Some(50), Some(200)), Some(25.0));
        assert_eq!(occupancy_percent(None, Some(200)), None);
        assert_eq!(occupancy_percent(Some(50), None), None);
        assert_eq!(occupancy_percent(Some(0), Some(200)), None);
        assert_eq!(occupancy_percent(Some(50), Some(0)), None);
    }

    #[test]
    fn a_transcript_only_counts_for_the_session_actually_connected() {
        assert!(transcript_describes_live_session(Some("sess-a"), Some("sess-a")));
        // The row still names the session the launch asked to resume while the
        // connection is holding a fresh one — measuring the first and
        // compacting the second is the failure this guard exists for.
        assert!(!transcript_describes_live_session(
            Some("sess-a"),
            Some("sess-b")
        ));
        // "Unknown" is never "close enough".
        assert!(!transcript_describes_live_session(Some("sess-a"), None));
        assert!(!transcript_describes_live_session(None, Some("sess-a")));
        assert!(!transcript_describes_live_session(None, None));
    }

    #[test]
    fn the_threshold_is_inclusive_and_zero_is_off() {
        assert!(trips_threshold(80.0, 80));
        assert!(trips_threshold(99.9, 80));
        assert!(!trips_threshold(79.9, 80));
        assert!(!trips_threshold(100.0, 0));
        assert!(!trips_threshold(100.0, -1));
        assert!(!trips_threshold(100.0, 101));
    }
}
