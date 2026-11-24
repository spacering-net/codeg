//! Shared mapping of Codex's structured goal object into codeg's canonical
//! `create_goal`/`update_goal` synthetic tool-call representation.
//!
//! codex-acp v1.1.0 (#263) stopped emitting `/goal` transitions as live
//! `"Goal updated (…)"` agent-message text and now ships them as structured
//! metadata: a `session_info_update` whose `_meta.codex.goal` carries the goal.
//! The same goal-object shape is what the Codex CLI has always persisted to its
//! rollout JSONL as `event_msg.thread_goal_updated.goal`. Both the live path
//! ([`crate::acp::connection`]) and the history parser ([`crate::parsers::codex`])
//! funnel a goal object through here so they produce byte-identical goal cards
//! via the frontend's `groupGoalRuns` / `GoalCard` pipeline.
//!
//! The frontend's canonical goal representation is a synthetic `create_goal`
//! (status `active`, opens a run) / `update_goal` (any other status, closes it)
//! tool call whose `raw_output` holds `{"goal":{…}}`. `GoalCard` reads
//! objective/status/token stats straight out of that object, and its
//! status→tone/label buckets only fold whitespace/hyphens — NOT camelCase — so
//! the codex `ThreadGoalStatus` (`budgetLimited`, `usageLimited`, …) MUST be
//! normalized to snake_case here before it reaches the UI.

use serde_json::{json, Value};

/// codex's bespoke pre-extension goal-control request (codex-acp #293,
/// v1.1.4) — still accepted by 1.2+ as an alias. The default
/// `SessionState.goal_control_method` until an adapter advertises the
/// provider-neutral `_meta.goal.controlMethod` at initialize.
pub(crate) const LEGACY_GOAL_CONTROL_METHOD: &str = "_codex/session/goal_control";

/// The action vocabulary the legacy method accepts. Resolved into
/// `SessionState.goal_actions` at initialize when the adapter advertises no
/// neutral goal surface, so a non-advertising (older PATH-resolved) codex keeps
/// today's Pause/Clear affordances. NOT a construction-time default: until
/// initialize lands the vocabulary is `None` (unknown), because a client that
/// reads the snapshot during the handshake latches whatever it finds.
pub(crate) const LEGACY_GOAL_ACTIONS: [&str; 2] = ["pause", "clear"];

/// A Codex goal object mapped to codeg's canonical synthetic goal marker.
///
/// The live path (`crate::acp::connection`) builds an `AcpEvent::ToolCall` from
/// `title` and `output_json`, letting the frontend backfill the input from the
/// title. The history parser (`crate::parsers::codex`) builds
/// `ContentBlock::ToolUse`/`ToolResult` from `tool_name`, `input_json` and
/// `output_json`. Both resolve to the same adapted tool-call part (identical
/// tool name, input and output), so live and history render identically. The id
/// is assigned per-occurrence at the call site (see `goal_tool_call_id`), not
/// carried on the marker.
pub(crate) struct CodexGoalMarker {
    /// Canonical tool name — `"create_goal"` (active / opening) or
    /// `"update_goal"` (any terminal / non-active status, or a cleared goal).
    pub tool_name: &'static str,
    /// The (trimmed) goal objective. Used by [`next_goal_marker`] to remember
    /// which run is open so a later `goal:null` clear can close it by objective.
    pub objective: String,
    /// Live tool-call title. For a goal with an objective this is
    /// `"Goal updated (<snake_status>): <objective>"` so the frontend
    /// (`inferLiveToolName` → `parseGoalUpdateTitle`) classifies it and backfills
    /// the input; for a cleared goal (no objective available) it is the bare
    /// `"update_goal"` alias, which `normalizeToolName` maps to `update_goal`.
    pub title: String,
    /// Tool-call `input` JSON — `{"objective":…}` (create) / `{"status":…,
    /// "objective":…}` (update), matching the frontend's `resolveLiveToolInput`.
    /// Used by the history parser's `ToolUse.input_preview`.
    pub input_json: String,
    /// `{"goal":{…}}` JSON for the tool call's `raw_output` (live) or the
    /// `tool_result` block (history). `GoalCard.parseGoal` reads
    /// objective/status/tokens from here with the highest precedence.
    pub output_json: String,
}

/// Synthetic tool-call id for a goal marker, from a per-path occurrence counter
/// (live: a per-connection sequence in `CodeBuddyLiveState`; history: the parser
/// message index). Occurrence — NOT content — addressing is deliberate: the live
/// reducer upserts blocks by `tool_call_id`, so two distinct runs sharing an
/// objective (`/goal "X"` … clear … `/goal "X"` again) must get DIFFERENT ids or
/// the second would merge into the first's card. The paired history
/// `ToolUse`/`ToolResult` still pass the same `occurrence` so they correlate.
pub(crate) fn goal_tool_call_id(occurrence: u64) -> String {
    format!("codex-goal-{occurrence}")
}

/// Map a Codex `goal` sub-object
/// (`{objective, status, tokenBudget, tokensUsed?, timeUsedSeconds?}`) into a
/// synthetic goal marker. Returns `None` when it lacks a usable objective.
pub(crate) fn goal_marker(goal: &Value) -> Option<CodexGoalMarker> {
    let objective = goal.get("objective").and_then(Value::as_str)?.trim();
    if objective.is_empty() {
        return None;
    }
    let raw_status = goal
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or("active");
    // Default a missing/blank status to `active` (a `Goal updated (): …` title
    // would fail the frontend's goal regex and the card would silently vanish).
    let mut status = normalize_goal_status(raw_status);
    if status.is_empty() {
        status = "active".to_string();
    }
    let tool_name = if status == "active" {
        "create_goal"
    } else {
        "update_goal"
    };

    // Re-emit the goal object with a snake_case status and trimmed objective so
    // the frontend renders the right tone/label and header. Preserve any extra
    // stats fields (tokensUsed / tokenBudget / timeUsedSeconds) the source carried.
    let mut normalized = goal.clone();
    if let Some(obj) = normalized.as_object_mut() {
        obj.insert("status".to_string(), Value::String(status.clone()));
        obj.insert(
            "objective".to_string(),
            Value::String(objective.to_string()),
        );
    } else {
        normalized = json!({ "objective": objective, "status": status });
    }
    let output_json = json!({ "goal": normalized }).to_string();

    // Mirror the frontend's `resolveLiveToolInput`: create → `{objective}`,
    // update → `{status, objective}`.
    let input_json = if tool_name == "create_goal" {
        json!({ "objective": objective })
    } else {
        json!({ "status": status, "objective": objective })
    }
    .to_string();

    let title = format!("Goal updated ({status}): {objective}");
    Some(CodexGoalMarker {
        tool_name,
        objective: objective.to_string(),
        title,
        input_json,
        output_json,
    })
}

/// Decide the goal marker (if any) for one live `session_info_update` goal,
/// updating the per-connection open-run objective.
///
/// - A goal object with `active` status opens a run (remember its objective).
/// - Any terminal status closes the run (forget it) — so a subsequent clear does
///   not emit a duplicate close card.
/// - `goal:null` closes the currently-open run by objective (and forgets it);
///   with no open run it is a no-op (avoids a blank standalone card).
pub(crate) fn next_goal_marker(
    open_goal: &mut Option<String>,
    goal: &Value,
) -> Option<CodexGoalMarker> {
    if goal.is_null() {
        return open_goal.take().map(|objective| cleared_marker(&objective));
    }
    let marker = goal_marker(goal)?;
    *open_goal = if marker.tool_name == "create_goal" {
        Some(marker.objective.clone())
    } else {
        None
    };
    Some(marker)
}

/// Marker that closes an open goal run when Codex clears the goal
/// (`session_info_update._meta.codex.goal = null`). The null payload carries no
/// objective, so [`next_goal_marker`] supplies the remembered one — closing the
/// run as `complete` with a non-blank card and an objective-derived id.
fn cleared_marker(objective: &str) -> CodexGoalMarker {
    CodexGoalMarker {
        tool_name: "update_goal",
        objective: objective.to_string(),
        title: format!("Goal updated (complete): {objective}"),
        input_json: json!({ "status": "complete", "objective": objective }).to_string(),
        output_json: json!({ "goal": { "objective": objective, "status": "complete" } })
            .to_string(),
    }
}

/// codex `ThreadGoalStatus` is camelCase (`budgetLimited`); the frontend's goal
/// status buckets are snake_case (`budget_limited`) and only fold whitespace and
/// hyphens. Insert `_` before each interior uppercase letter and lowercase it;
/// collapse runs of whitespace/hyphens to a single `_` (defensive — matches the
/// legacy `"budget limited"` spelling codex-acp used to emit as text).
pub(crate) fn normalize_goal_status(status: &str) -> String {
    let mut out = String::with_capacity(status.len() + 2);
    for (i, ch) in status.trim().chars().enumerate() {
        if ch.is_ascii_uppercase() {
            if i != 0 && !out.ends_with('_') {
                out.push('_');
            }
            out.push(ch.to_ascii_lowercase());
        } else if ch.is_whitespace() || ch == '-' {
            if !out.is_empty() && !out.ends_with('_') {
                out.push('_');
            }
        } else {
            out.push(ch);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn neutral_snapshot_maps_like_legacy_and_keeps_extra_fields() {
        // The provider-neutral `_meta.goal` snapshot (claude-agent-acp 0.66+,
        // codex-acp 1.2+): lowercase status vocabulary — usageLimited/
        // budgetLimited collapse to "limited" adapter-side — plus Unix-ms
        // timestamps and claude-only iterations/lastReason. Everything must
        // ride through the same marker: status passes normalization
        // unchanged, non-active closes the run, and the extra fields survive
        // in the raw goal object `GoalCard.parseGoal` reads.
        let snapshot = json!({
            "objective": "ship the release",
            "status": "limited",
            "tokenBudget": 500000,
            "tokensUsed": 500000,
            "timeUsedSeconds": 120,
            "createdAt": 1755200000000u64,
            "updatedAt": 1755200120000u64,
            "iterations": 3,
            "lastReason": "token budget exhausted",
            "controlMethod": "_session/goal",
        });
        let marker = goal_marker(&snapshot).expect("marker");
        assert_eq!(marker.tool_name, "update_goal");
        assert_eq!(marker.title, "Goal updated (limited): ship the release");
        let output: Value = serde_json::from_str(&marker.output_json).unwrap();
        let goal = output.get("goal").unwrap();
        assert_eq!(goal.get("status").and_then(Value::as_str), Some("limited"));
        assert_eq!(goal.get("iterations").and_then(Value::as_u64), Some(3));
        assert_eq!(
            goal.get("createdAt").and_then(Value::as_u64),
            Some(1755200000000)
        );

        // An active neutral snapshot opens a run exactly like the legacy shape.
        let mut open = None;
        let active = json!({"objective": "ship the release", "status": "active"});
        let opened = next_goal_marker(&mut open, &active).expect("open marker");
        assert_eq!(opened.tool_name, "create_goal");
        assert_eq!(open.as_deref(), Some("ship the release"));
        // The neutral clear (`_meta.goal = null`) closes it.
        let closed = next_goal_marker(&mut open, &Value::Null).expect("close marker");
        assert_eq!(closed.tool_name, "update_goal");
        assert!(open.is_none());
    }

    #[test]
    fn normalizes_camelcase_and_spaced_statuses() {
        assert_eq!(normalize_goal_status("active"), "active");
        assert_eq!(normalize_goal_status("complete"), "complete");
        assert_eq!(normalize_goal_status("blocked"), "blocked");
        assert_eq!(normalize_goal_status("paused"), "paused");
        // Neutral-snapshot vocabulary (goal extension v1) is already
        // lowercase; it must pass through untouched.
        assert_eq!(normalize_goal_status("limited"), "limited");
        // camelCase (codex-acp v1.1.0 raw ThreadGoalStatus)
        assert_eq!(normalize_goal_status("budgetLimited"), "budget_limited");
        assert_eq!(normalize_goal_status("usageLimited"), "usage_limited");
        // legacy space-separated spelling stays equivalent
        assert_eq!(normalize_goal_status("budget limited"), "budget_limited");
        assert_eq!(normalize_goal_status(" active "), "active");
    }

    #[test]
    fn active_goal_maps_to_create_goal_with_snake_status() {
        let goal = json!({
            "objective": "  Analyze the README  ",
            "status": "active",
            "tokenBudget": 1000,
        });
        let m = goal_marker(&goal).expect("goal marker");
        assert_eq!(m.tool_name, "create_goal");
        assert_eq!(m.title, "Goal updated (active): Analyze the README");
        let out: Value = serde_json::from_str(&m.output_json).unwrap();
        assert_eq!(out["goal"]["objective"], "Analyze the README");
        assert_eq!(out["goal"]["status"], "active");
        assert_eq!(out["goal"]["tokenBudget"], 1000);
        // create → `{objective}` only (mirrors resolveLiveToolInput)
        let input: Value = serde_json::from_str(&m.input_json).unwrap();
        assert_eq!(input["objective"], "Analyze the README");
        assert!(input.get("status").is_none());
    }

    #[test]
    fn terminal_goal_maps_to_update_goal_and_normalizes_status() {
        let goal = json!({
            "objective": "Fix the login bug",
            "status": "budgetLimited",
            "tokensUsed": 5200,
            "tokenBudget": 8000,
            "timeUsedSeconds": 19,
        });
        let m = goal_marker(&goal).expect("goal marker");
        assert_eq!(m.tool_name, "update_goal");
        assert_eq!(
            m.title,
            "Goal updated (budget_limited): Fix the login bug"
        );
        let out: Value = serde_json::from_str(&m.output_json).unwrap();
        assert_eq!(out["goal"]["status"], "budget_limited");
        assert_eq!(out["goal"]["tokensUsed"], 5200);
        assert_eq!(out["goal"]["timeUsedSeconds"], 19);
        // update → `{status, objective}` (mirrors resolveLiveToolInput)
        let input: Value = serde_json::from_str(&m.input_json).unwrap();
        assert_eq!(input["status"], "budget_limited");
        assert_eq!(input["objective"], "Fix the login bug");
    }

    #[test]
    fn preserves_v114_slimmed_snapshot_fields() {
        // codex-acp v1.1.4 (#293) slimmed the goal snapshot: it dropped
        // `tokensUsed` and added `createdAt` / `controlMethod` (alongside the
        // existing `tokenBudget` / `timeUsedSeconds`). `goal_marker` clones the
        // object through, so the new fields survive onto the card output and the
        // absent `tokensUsed` is simply not present — `GoalCard` reads it as null
        // and hides that stat, so no display breaks.
        let goal = json!({
            "objective": "  Ship the release  ",
            "status": "active",
            "tokenBudget": 200000,
            "timeUsedSeconds": 42,
            "createdAt": "2026-07-16T10:00:00Z",
            "controlMethod": "_codex/session/goal_control",
        });
        let m = goal_marker(&goal).expect("goal marker");
        assert_eq!(m.tool_name, "create_goal");
        let out: Value = serde_json::from_str(&m.output_json).unwrap();
        let g = &out["goal"];
        assert_eq!(g["objective"], "Ship the release"); // trimmed
        assert_eq!(g["status"], "active");
        assert_eq!(g["tokenBudget"], 200000);
        assert_eq!(g["timeUsedSeconds"], 42);
        assert_eq!(g["createdAt"], "2026-07-16T10:00:00Z");
        assert_eq!(g["controlMethod"], "_codex/session/goal_control");
        // Slimmed snapshot carries no tokensUsed → the card hides that stat.
        assert!(g.get("tokensUsed").is_none());
    }

    #[test]
    fn goal_tool_call_id_is_occurrence_unique() {
        // Occurrence-addressed so two runs sharing an objective never collide.
        assert_eq!(goal_tool_call_id(3), goal_tool_call_id(3));
        assert_ne!(goal_tool_call_id(3), goal_tool_call_id(4));
        assert!(goal_tool_call_id(3).starts_with("codex-goal-"));
    }

    #[test]
    fn missing_or_empty_objective_yields_no_marker() {
        assert!(goal_marker(&json!({ "status": "active" })).is_none());
        assert!(goal_marker(&json!({ "objective": "   ", "status": "active" })).is_none());
    }

    #[test]
    fn blank_status_defaults_to_active_not_empty_parens() {
        // Empty/whitespace status must not produce `Goal updated (): …`, which the
        // frontend goal regex rejects (the card would silently disappear).
        let m = goal_marker(&json!({ "objective": "X", "status": "" })).unwrap();
        assert_eq!(m.tool_name, "create_goal");
        assert_eq!(m.title, "Goal updated (active): X");
        let m2 = goal_marker(&json!({ "objective": "X", "status": "   " })).unwrap();
        assert_eq!(m2.tool_name, "create_goal");
    }

    fn status_of(m: &CodexGoalMarker) -> String {
        let out: Value = serde_json::from_str(&m.output_json).unwrap();
        out["goal"]["status"].as_str().unwrap().to_string()
    }

    #[test]
    fn clear_with_no_open_goal_is_a_noop() {
        let mut open = None;
        assert!(next_goal_marker(&mut open, &Value::Null).is_none());
        assert_eq!(open, None);
    }

    #[test]
    fn active_then_clear_closes_one_card_with_objective() {
        let mut open = None;
        let create =
            next_goal_marker(&mut open, &json!({ "objective": "Ship it", "status": "active" }))
                .unwrap();
        assert_eq!(create.tool_name, "create_goal");
        assert_eq!(open.as_deref(), Some("Ship it"));

        let close = next_goal_marker(&mut open, &Value::Null).unwrap();
        assert_eq!(close.tool_name, "update_goal");
        assert_eq!(close.objective, "Ship it");
        assert_eq!(status_of(&close), "complete");
        assert_eq!(open, None);
    }

    #[test]
    fn active_terminal_then_clear_does_not_emit_extra_card() {
        // active → budgetLimited already closes the run; a following clear must be
        // a no-op (no stray standalone "complete" card).
        let mut open = None;
        next_goal_marker(&mut open, &json!({ "objective": "Y", "status": "active" })).unwrap();
        let terminal =
            next_goal_marker(&mut open, &json!({ "objective": "Y", "status": "budgetLimited" }))
                .unwrap();
        assert_eq!(terminal.tool_name, "update_goal");
        assert_eq!(status_of(&terminal), "budget_limited");
        assert_eq!(open, None);
        assert!(next_goal_marker(&mut open, &Value::Null).is_none());
    }

    #[test]
    fn two_active_clear_runs_close_by_their_own_objective() {
        // Each run's clear inherits ITS objective (occurrence ids are then
        // assigned at the call site, so the two closes never collide).
        let mut open = None;
        next_goal_marker(&mut open, &json!({ "objective": "A", "status": "active" })).unwrap();
        let close_a = next_goal_marker(&mut open, &Value::Null).unwrap();
        next_goal_marker(&mut open, &json!({ "objective": "B", "status": "active" })).unwrap();
        let close_b = next_goal_marker(&mut open, &Value::Null).unwrap();
        assert_eq!(close_a.objective, "A");
        assert_eq!(close_b.objective, "B");
    }
}
