//! Reading the AIR tool-call contract that claude-agent-acp 0.82.0 and
//! codex-acp 2.0.0 put on the wire, back into the shapes the rest of codeg
//! already reads.
//!
//! codeg declares `clientCapabilities._meta.jetbrains.air` to both adapters —
//! for `sessionFailure`, `asyncTasks` and `recommendedValue` (see
//! `build_client_capabilities`). From these two releases on, that declaration
//! ALONE also switches the adapters onto a different tool-call contract: both
//! test `isAirClient` as "the `_meta.jetbrains.air` object is present", with no
//! capability of its own. Recorded off both adapters' own scenario harnesses,
//! run with codeg's exact client capabilities against the old and the new pin,
//! the contract changes these things codeg reads:
//!
//! * **`_meta` is merged, not replaced.** A `tool_call_update` leaves out every
//!   `_meta` key that did not change since the last report of the same call.
//!   claude compares the keys INSIDE `claudeCode` and `jetbrains.air` one by
//!   one (plus the `is_mcp_tool_call` / `terminal_info` flags); codex compares
//!   whole top-level keys. Both are explicit that only an AIR client gets this,
//!   "because AIR merges these `_meta` keys". codeg replaces a tool call's
//!   `_meta` on every update that carries one (`SessionState::upsert_tool_call`,
//!   the frontend reducer), so an update carrying only a changed marker would
//!   wipe `claudeCode.toolName` / `parentToolUseId` — un-nesting a subagent's
//!   child call mid-flight. [`ToolCallMetaLedger`] keeps the merged state and
//!   hands every consumer the whole of it, which is what the adapters sent
//!   before.
//! * **Keys moved under `_meta.jetbrains.air`**, and the old key is sent to NO
//!   client: the permission presentation record, the goal extension, the mode
//!   `kind`, codex's command actions and message phase, and the compaction
//!   record. claude also stopped sending `claudeCode.title` / `subagent` /
//!   `skill` / `skillPath` to anyone; an AIR client reads `commandTitle`,
//!   `subagent` and `skill` under the AIR namespace instead.
//!   [`translate_air_meta`] re-derives the legacy keys, so the readers keep one
//!   spelling each; every reader of a moved SESSION-level key reads both
//!   places, because an older adapter on PATH still writes the old one.
//!
//! Everything here is keyed to the two adapters that speak the contract
//! ([`speaks_air_contract`]): the keys are unnamespaced conventions another
//! agent could mean something else by.

use std::collections::{HashMap, VecDeque};

use serde_json::{Map, Value};

use crate::models::agent::AgentType;

/// Whether codeg reads this agent's tool calls through the AIR contract — the
/// two agents `build_client_capabilities` declares `_meta.jetbrains.air` to.
pub(crate) fn speaks_air_contract(agent_type: AgentType) -> bool {
    matches!(agent_type, AgentType::ClaudeCode | AgentType::Codex)
}

/// `_meta.jetbrains.air.<key>`, wherever the adapter put its AIR payload.
///
/// The envelope's `version` is deliberately NOT required here. The adapters
/// write it next to every payload, but on a tool call the merge filter drops
/// it from any update after the first (it never changes), so a `backgrounded`
/// marker legitimately arrives as `{"jetbrains":{"air":{"asyncTasks":…}}}`.
/// Records whose SHAPE is versioned (`sessionFailure`, `recommendedValue`)
/// keep their own version checks at their readers.
pub(crate) fn air_meta_value<'a>(
    meta: Option<&'a Map<String, Value>>,
    key: &str,
) -> Option<&'a Value> {
    meta?.get("jetbrains")?.get("air")?.get(key)
}

/// A moved session-level key: the legacy top-level spelling first (what every
/// adapter before claude 0.82.0 / codex 2.0.0 writes, and what one resolved
/// off PATH may still write), then the AIR namespace.
pub(crate) fn legacy_or_air<'a>(
    meta: Option<&'a Map<String, Value>>,
    key: &str,
) -> Option<&'a Value> {
    meta.and_then(|m| m.get(key))
        .or_else(|| air_meta_value(meta, key))
}

/// `_meta` keys that carry DATA for one frame rather than state of the call:
/// the client appends each value (terminal output, stdin, MCP progress) or acts
/// on it once (the exit line). Neither adapter's merge filter ever compares
/// them, so they are never folded into the ledger — re-sending a stored
/// `terminal_exit` on a later frame would print the exit line twice.
const FRAME_DATA_KEYS: [&str; 5] = [
    "terminal_output",
    "terminal_output_delta",
    "terminal_exit",
    "terminal_input",
    "mcp_output_delta",
];

/// The `_meta` namespaces claude merges key by key (its `ChangedMetaFilter`):
/// `claudeCode.*` and `jetbrains.air.*`. codex compares whole top-level keys
/// (`ToolCallReports.reportedFields`), so for codex these are replaced whole
/// like any other key.
fn merges_per_key(agent_type: AgentType) -> bool {
    agent_type == AgentType::ClaudeCode
}

/// Fold `frame` into `state` under the agent's own merge rule. Frame-data keys
/// are skipped (see [`FRAME_DATA_KEYS`]).
fn merge_state(agent_type: AgentType, state: &mut Map<String, Value>, frame: &Map<String, Value>) {
    for (key, value) in frame {
        if FRAME_DATA_KEYS.contains(&key.as_str()) {
            continue;
        }
        if merges_per_key(agent_type) {
            if key == "claudeCode" {
                if let (Some(incoming), Some(held)) = (
                    value.as_object(),
                    state
                        .entry(key.clone())
                        .or_insert_with(|| Value::Object(Map::new()))
                        .as_object_mut(),
                ) {
                    for (k, v) in incoming {
                        held.insert(k.clone(), v.clone());
                    }
                    continue;
                }
            }
            if key == "jetbrains" {
                if let (Some(incoming_air), Some(held)) = (
                    value.get("air").and_then(Value::as_object),
                    state
                        .entry(key.clone())
                        .or_insert_with(|| Value::Object(Map::new()))
                        .as_object_mut(),
                ) {
                    // Any sibling of `air` under `jetbrains` is replaced whole.
                    if let Some(incoming) = value.as_object() {
                        for (k, v) in incoming {
                            if k != "air" {
                                held.insert(k.clone(), v.clone());
                            }
                        }
                    }
                    if let Some(held_air) = held
                        .entry("air")
                        .or_insert_with(|| Value::Object(Map::new()))
                        .as_object_mut()
                    {
                        for (k, v) in incoming_air {
                            held_air.insert(k.clone(), v.clone());
                        }
                    }
                    continue;
                }
            }
        }
        state.insert(key.clone(), value.clone());
    }
}

/// Re-derive the legacy `_meta` keys codeg reads from the AIR spellings that
/// replaced them. Never overwrites a key that is already there: an adapter
/// that still writes the legacy key is authoritative for it.
///
/// * both: `jetbrains.air.contextCompaction` → `contextCompaction` — the key
///   `isContextCompactionMeta` and `compaction_failure_error` read.
/// * claude: `jetbrains.air.commandTitle` → `claudeCode.title` (the tool-card
///   and permission heading), `jetbrains.air.subagent: true` →
///   `claudeCode.subagent` (what classifies an `Agent`/`Task` call as a
///   capsule), `jetbrains.air.skill = {name, path}` → `claudeCode.skill` /
///   `claudeCode.skillPath` (the `Skill: <name>` header).
pub(crate) fn translate_air_meta(agent_type: AgentType, meta: &mut Map<String, Value>) {
    let Some(air) = meta
        .get("jetbrains")
        .and_then(|jetbrains| jetbrains.get("air"))
        .and_then(Value::as_object)
        .cloned()
    else {
        return;
    };
    if let Some(compaction) = air.get("contextCompaction").filter(|v| v.is_object()) {
        meta.entry("contextCompaction")
            .or_insert_with(|| compaction.clone());
    }
    if agent_type != AgentType::ClaudeCode {
        return;
    }
    let mut derived = Map::new();
    if let Some(title) = air.get("commandTitle").filter(|v| v.is_string()) {
        derived.insert("title".to_string(), title.clone());
    }
    if air.get("subagent") == Some(&Value::Bool(true)) {
        derived.insert("subagent".to_string(), Value::Bool(true));
    }
    if let Some(skill) = air.get("skill") {
        if let Some(name) = skill.get("name").filter(|v| v.is_string()) {
            derived.insert("skill".to_string(), name.clone());
        }
        if let Some(path) = skill.get("path").filter(|v| v.is_string()) {
            derived.insert("skillPath".to_string(), path.clone());
        }
    }
    if derived.is_empty() {
        return;
    }
    let Some(claude) = meta
        .entry("claudeCode")
        .or_insert_with(|| Value::Object(Map::new()))
        .as_object_mut()
    else {
        // A non-object `claudeCode` is malformed; leave it as the agent sent it.
        return;
    };
    for (key, value) in derived {
        claude.entry(key).or_insert(value);
    }
}

/// The merged `_meta` of every tool call the adapter is still reporting on
/// this connection — see the module doc for why codeg has to keep it.
///
/// Bounded, least-recently-reported first out. The adapters themselves stop
/// merging past a bound — claude's filter remembers 2048 tool calls and codex
/// forgets a call's record when its turn ends — and in both cases the NEXT
/// report of a forgotten call carries every key again, so a ledger that
/// outlives the adapter's own record is all that is required. The capacity is
/// twice claude's for slack; an evicted call degrades to exactly the pre-AIR
/// behaviour (the frame's own `_meta`, replaced whole downstream).
#[derive(Default)]
pub(crate) struct ToolCallMetaLedger {
    entries: HashMap<String, LedgerEntry>,
    /// `(stamp, id)` in report order; an entry is live only while its stamp
    /// matches, so re-reporting a call just pushes a newer stamp.
    order: VecDeque<(u64, String)>,
    next_stamp: u64,
}

struct LedgerEntry {
    stamp: u64,
    state: Map<String, Value>,
}

impl ToolCallMetaLedger {
    const CAPACITY: usize = 4096;

    /// The opening `tool_call` of `id`. Both adapters restart their record of a
    /// call on a `tool_call` (a replay re-announces it whole), so the ledger
    /// does too. Returns the frame's `_meta` with the legacy keys derived; the
    /// ledger stores the frame's own keys, so a later AIR key is never shadowed
    /// by a derived one.
    pub(crate) fn open(
        &mut self,
        agent_type: AgentType,
        id: &str,
        frame: Option<Map<String, Value>>,
    ) -> Option<Map<String, Value>> {
        if !speaks_air_contract(agent_type) {
            return frame;
        }
        let mut state = Map::new();
        if let Some(frame) = frame.as_ref() {
            merge_state(agent_type, &mut state, frame);
        }
        self.store(id, state);
        frame.map(|mut meta| {
            translate_air_meta(agent_type, &mut meta);
            meta
        })
    }

    /// Record `extra` keys codeg itself stamped onto an opening frame (e.g.
    /// `codeg.codexSearchAction`), so the merged `_meta` of later updates keeps
    /// them instead of silently dropping the stamp downstream.
    pub(crate) fn remember_stamps(&mut self, id: &str, meta: &Map<String, Value>) {
        if let Some(entry) = self.entries.get_mut(id) {
            for (key, value) in meta {
                if key.starts_with("codeg.") {
                    entry.state.insert(key.clone(), value.clone());
                }
            }
        }
    }

    /// A `tool_call_update` of `id`: fold the frame in and return the call's
    /// whole `_meta` — the merged state plus this frame's own frame-data keys,
    /// with the legacy keys derived.
    ///
    /// `None` only when the frame carries no `_meta` AND the ledger has nothing
    /// for the call: there is then nothing to say, exactly as before.
    pub(crate) fn update(
        &mut self,
        agent_type: AgentType,
        id: &str,
        frame: Option<Map<String, Value>>,
    ) -> Option<Map<String, Value>> {
        if !speaks_air_contract(agent_type) {
            return frame;
        }
        let mut state = self
            .entries
            .remove(id)
            .map(|entry| entry.state)
            .unwrap_or_default();
        if let Some(frame) = frame.as_ref() {
            merge_state(agent_type, &mut state, frame);
        }
        if state.is_empty() && frame.is_none() {
            return None;
        }
        let mut effective = state.clone();
        self.store(id, state);
        if let Some(frame) = frame.as_ref() {
            for key in FRAME_DATA_KEYS {
                if let Some(value) = frame.get(key) {
                    effective.insert(key.to_string(), value.clone());
                }
            }
        }
        translate_air_meta(agent_type, &mut effective);
        Some(effective)
    }

    /// The SDK tool name claude reported for `id` (`claudeCode.toolName`, on
    /// the opening frame only under the AIR contract).
    pub(crate) fn claude_tool_name(&self, id: &str) -> Option<&str> {
        self.entries
            .get(id)?
            .state
            .get("claudeCode")?
            .get("toolName")?
            .as_str()
    }

    fn store(&mut self, id: &str, state: Map<String, Value>) {
        self.next_stamp += 1;
        let stamp = self.next_stamp;
        self.entries
            .insert(id.to_string(), LedgerEntry { stamp, state });
        self.order.push_back((stamp, id.to_string()));
        while self.entries.len() > Self::CAPACITY {
            let Some((stamp, id)) = self.order.pop_front() else {
                break;
            };
            if self
                .entries
                .get(&id)
                .is_some_and(|entry| entry.stamp == stamp)
            {
                self.entries.remove(&id);
            }
        }
        // Stale `(stamp, id)` pairs pile up behind re-reported calls; compact
        // before they outgrow the live set by much.
        if self.order.len() > Self::CAPACITY * 4 {
            let entries = &self.entries;
            self.order
                .retain(|(stamp, id)| entries.get(id).is_some_and(|entry| entry.stamp == *stamp));
        }
    }
}

/// The permission presentation record of a `session/request_permission`, from
/// wherever this adapter version put it — `_meta.permission` through claude
/// 0.81 / codex 1.13, `_meta.jetbrains.air.permission` from claude 0.82.0 /
/// codex 2.0.0 (which send the old key to no client).
pub(crate) fn permission_record(meta: Option<&Map<String, Value>>) -> Option<&Value> {
    legacy_or_air(meta, "permission")
}

/// An option's `_meta` with codex's option-level presentation record (MCP
/// elicitation options only) copied back to `_meta.permission`, where the
/// permission card reads it. A no-op when the legacy key is present.
pub(crate) fn normalize_permission_option_meta(meta: Option<&Map<String, Value>>) -> Option<Value> {
    let meta = meta?;
    let mut out = meta.clone();
    if !out.contains_key("permission") {
        if let Some(record) = air_meta_value(Some(meta), "permission") {
            out.insert("permission".to_string(), record.clone());
        }
    }
    Some(Value::Object(out))
}

/// codex's Plan-mode review gate, recognised by its tool-call id.
///
/// codex-acp 1.1.8–1.13.x also marked the request `_meta.codex = {kind:
/// "plan_review", planItemId}`; 2.0.0 sends that marker to no client. The id
/// shape `plan-review:<planItemId>` is the one constant across every version
/// (`PlanReviewReporter`), so it is what identifies the gate from now on.
pub(crate) const CODEX_PLAN_REVIEW_ID_PREFIX: &str = "plan-review:";

/// The `planItemId` of a codex plan-review tool-call id, if it is one.
pub(crate) fn codex_plan_review_item_id(tool_call_id: &str) -> Option<&str> {
    tool_call_id
        .strip_prefix(CODEX_PLAN_REVIEW_ID_PREFIX)
        .filter(|rest| !rest.is_empty())
}

/// A codex `subAgentActivity` item, read off its `rawInput`
/// (`{agentThreadId, agentPath, activityKind}`).
///
/// codex-acp 1.4.0–1.13.x mirrored the same three facts into
/// `_meta.codex.subagent = {threadId, path, activity}`; 2.0.0 sends that key to
/// no client and marks the call with the AIR `subagent: true` flag instead —
/// which a `spawnAgent` collaboration call ALSO carries. The `rawInput` is
/// present on every version's opening frame and is specific to activity
/// items, so it is the stable identity. Returned in the legacy `_meta` shape so
/// `classify_codex_subagent_activity` reads one spelling.
pub(crate) fn codex_activity_meta_from_raw_input(raw_input: Option<&Value>) -> Option<Value> {
    let input = raw_input?.as_object()?;
    let activity = input.get("activityKind")?.as_str()?;
    let path = input.get("agentPath").and_then(Value::as_str);
    let thread_id = input.get("agentThreadId").and_then(Value::as_str);
    let mut subagent = Map::new();
    subagent.insert("activity".to_string(), Value::String(activity.to_string()));
    if let Some(path) = path {
        subagent.insert("path".to_string(), Value::String(path.to_string()));
    }
    if let Some(thread_id) = thread_id {
        subagent.insert("threadId".to_string(), Value::String(thread_id.to_string()));
    }
    Some(serde_json::json!({ "codex": { "subagent": Value::Object(subagent) } }))
}

/// The tool names whose result claude-agent-acp 0.82.0 withholds from an AIR
/// client when the call names a path: "AIR shows a read or a search that names
/// a path as the list of viewed files. That view does not show the text of the
/// result, so it stays out" (`AcpToolCallRenderer.result`). A Glob or Grep
/// with no path still sends its result; that case never reaches the stash
/// consumer, because the stash only fills a completion that carried nothing.
pub(crate) fn claude_viewed_file_tool(tool_name: &str) -> bool {
    matches!(tool_name, "Read" | "Grep" | "Glob")
}

/// One `tool_result` block out of a raw SDK `user` message
/// (`_claude/sdkMessage`, `{type: "user", message: {content: [...]}}`).
pub(crate) struct SdkToolResult<'a> {
    pub tool_use_id: &'a str,
    pub block: &'a Value,
    pub is_error: bool,
}

/// Every `tool_result` block a raw SDK message carries — empty for anything
/// but a `user` message.
pub(crate) fn claude_sdk_tool_results(message: &Value) -> Vec<SdkToolResult<'_>> {
    if message.get("type").and_then(Value::as_str) != Some("user") {
        return Vec::new();
    }
    let Some(blocks) = message
        .get("message")
        .and_then(|m| m.get("content"))
        .and_then(Value::as_array)
    else {
        return Vec::new();
    };
    blocks
        .iter()
        .filter(|block| block.get("type").and_then(Value::as_str) == Some("tool_result"))
        .filter_map(|block| {
            let tool_use_id = block
                .get("tool_use_id")
                .and_then(Value::as_str)
                .filter(|id| !id.is_empty())?;
            Some(SdkToolResult {
                tool_use_id,
                block,
                is_error: block.get("is_error").and_then(Value::as_bool) == Some(true),
            })
        })
        .collect()
}

/// Whether a codex tool call's `rawInput` is a hosted web search.
///
/// Through 1.13.x the live input was the whole app-server item
/// (`{type: "webSearch", id, query, action}`); 2.0.0 sends an AIR client just
/// `{query, action}` (`WebSearchReporter`). No other codex item carries both of
/// those keys — a fuzzy file search is `{query}` alone.
pub(crate) fn is_codex_web_search_input(raw_input: Option<&Value>) -> bool {
    let Some(input) = raw_input.and_then(Value::as_object) else {
        return false;
    };
    input.get("type").and_then(Value::as_str) == Some("webSearch")
        || (input.contains_key("query") && input.contains_key("action"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn obj(value: Value) -> Map<String, Value> {
        value.as_object().cloned().expect("object")
    }

    #[test]
    fn claude_merges_claude_code_and_air_keys_one_by_one() {
        // claude 0.82.0, recorded: the opening frame names the tool and the
        // parent; a later update carries only the key that changed.
        let mut ledger = ToolCallMetaLedger::default();
        let opened = ledger.open(
            AgentType::ClaudeCode,
            "toolu_1",
            Some(obj(json!({
                "claudeCode": {"toolName": "Bash", "parentToolUseId": "toolu_task"}
            }))),
        );
        assert_eq!(opened.unwrap()["claudeCode"]["toolName"], "Bash");
        let merged = ledger
            .update(
                AgentType::ClaudeCode,
                "toolu_1",
                Some(obj(json!({
                    "jetbrains": {"air": {"commandTitle": "Build", "version": 1}}
                }))),
            )
            .unwrap();
        assert_eq!(merged["claudeCode"]["toolName"], "Bash");
        assert_eq!(merged["claudeCode"]["parentToolUseId"], "toolu_task");
        // …and the moved key is readable under its legacy name too.
        assert_eq!(merged["claudeCode"]["title"], "Build");
        // A later partial `claudeCode` keeps the earlier keys.
        let merged = ledger
            .update(
                AgentType::ClaudeCode,
                "toolu_1",
                Some(obj(
                    json!({"claudeCode": {"toolResponse": {"status": "completed"}}}),
                )),
            )
            .unwrap();
        assert_eq!(merged["claudeCode"]["parentToolUseId"], "toolu_task");
        assert_eq!(merged["claudeCode"]["toolResponse"]["status"], "completed");
        assert_eq!(merged["jetbrains"]["air"]["commandTitle"], "Build");
    }

    #[test]
    fn an_update_without_meta_still_answers_with_the_merged_state() {
        let mut ledger = ToolCallMetaLedger::default();
        ledger.open(
            AgentType::ClaudeCode,
            "toolu_1",
            Some(obj(json!({"claudeCode": {"toolName": "Read"}}))),
        );
        let merged = ledger
            .update(AgentType::ClaudeCode, "toolu_1", None)
            .expect("the call has state");
        assert_eq!(merged["claudeCode"]["toolName"], "Read");
        // Nothing known and nothing sent: nothing to say.
        assert!(ledger
            .update(AgentType::ClaudeCode, "unknown", None)
            .is_none());
    }

    #[test]
    fn frame_data_keys_ride_one_frame_and_are_never_stored() {
        let mut ledger = ToolCallMetaLedger::default();
        ledger.open(
            AgentType::Codex,
            "cmd-1",
            Some(obj(
                json!({"terminal_info": {"terminal_id": "cmd-1", "cwd": "/w"}}),
            )),
        );
        let exit = ledger
            .update(
                AgentType::Codex,
                "cmd-1",
                Some(obj(json!({
                    "terminal_exit": {"exit_code": 0, "signal": null, "terminal_id": "cmd-1"},
                    "terminal_output_delta": {"data": "ok\n", "terminal_id": "cmd-1"}
                }))),
            )
            .unwrap();
        assert!(exit.contains_key("terminal_exit"));
        assert!(exit.contains_key("terminal_output_delta"));
        assert!(exit.contains_key("terminal_info"));
        // The exit line is acted on once: a later frame must not carry it again.
        let later = ledger.update(AgentType::Codex, "cmd-1", None).unwrap();
        assert!(!later.contains_key("terminal_exit"));
        assert!(!later.contains_key("terminal_output_delta"));
        assert!(later.contains_key("terminal_info"));
    }

    #[test]
    fn codex_replaces_whole_top_level_keys() {
        // codex compares whole top-level `_meta` values, so a changed
        // `jetbrains` object is sent — and taken — whole.
        let mut ledger = ToolCallMetaLedger::default();
        ledger.open(
            AgentType::Codex,
            "c",
            Some(obj(
                json!({"jetbrains": {"air": {"subagent": true, "version": 1}}}),
            )),
        );
        let merged = ledger
            .update(
                AgentType::Codex,
                "c",
                Some(obj(
                    json!({"jetbrains": {"air": {"asyncTasks": {"backgrounded": true}}}}),
                )),
            )
            .unwrap();
        assert_eq!(
            merged["jetbrains"]["air"]["asyncTasks"]["backgrounded"],
            true
        );
        assert!(merged["jetbrains"]["air"].get("subagent").is_none());
    }

    #[test]
    fn a_replayed_tool_call_restarts_the_record() {
        let mut ledger = ToolCallMetaLedger::default();
        ledger.open(
            AgentType::ClaudeCode,
            "t",
            Some(obj(
                json!({"claudeCode": {"toolName": "Edit", "parentToolUseId": "p"}}),
            )),
        );
        ledger.open(
            AgentType::ClaudeCode,
            "t",
            Some(obj(json!({"claudeCode": {"toolName": "Edit"}}))),
        );
        let merged = ledger.update(AgentType::ClaudeCode, "t", None).unwrap();
        assert!(merged["claudeCode"].get("parentToolUseId").is_none());
    }

    #[test]
    fn other_agents_pass_through_untouched() {
        let mut ledger = ToolCallMetaLedger::default();
        let frame = obj(json!({"jetbrains": {"air": {"commandTitle": "x"}}}));
        assert_eq!(
            ledger.open(AgentType::Gemini, "t", Some(frame.clone())),
            Some(frame.clone())
        );
        assert_eq!(ledger.update(AgentType::Gemini, "t", None), None);
        assert_eq!(
            ledger.update(AgentType::Gemini, "t", Some(frame.clone())),
            Some(frame)
        );
    }

    #[test]
    fn codeg_stamps_on_the_opening_frame_survive_later_updates() {
        let mut ledger = ToolCallMetaLedger::default();
        ledger.open(AgentType::Codex, "search-1", None);
        ledger.remember_stamps(
            "search-1",
            &obj(json!({"codeg.codexSearchAction": true, "other": 1})),
        );
        let merged = ledger
            .update(
                AgentType::Codex,
                "search-1",
                Some(obj(json!({"is_mcp_tool_call": false}))),
            )
            .unwrap();
        assert_eq!(merged["codeg.codexSearchAction"], true);
        assert!(merged.get("other").is_none(), "only codeg's own stamps");
    }

    #[test]
    fn the_ledger_is_bounded_least_recently_reported_first() {
        let mut ledger = ToolCallMetaLedger::default();
        ledger.open(
            AgentType::ClaudeCode,
            "oldest",
            Some(obj(json!({"claudeCode": {"toolName": "Bash"}}))),
        );
        ledger.open(
            AgentType::ClaudeCode,
            "busy",
            Some(obj(json!({"claudeCode": {"toolName": "Bash"}}))),
        );
        for i in 0..ToolCallMetaLedger::CAPACITY - 1 {
            // Keep `busy` recently reported while the rest churn through.
            if i % 100 == 0 {
                ledger.update(AgentType::ClaudeCode, "busy", None);
            }
            ledger.open(AgentType::ClaudeCode, &format!("t{i}"), None);
        }
        assert!(ledger.entries.len() <= ToolCallMetaLedger::CAPACITY);
        assert!(ledger
            .update(AgentType::ClaudeCode, "oldest", None)
            .is_none());
        assert!(ledger.update(AgentType::ClaudeCode, "busy", None).is_some());
        assert!(ledger.order.len() <= ToolCallMetaLedger::CAPACITY * 4);
    }

    #[test]
    fn claude_legacy_keys_are_derived_but_never_overwrite_the_agent() {
        let mut meta = obj(json!({
            "claudeCode": {"toolName": "Skill", "title": "kept"},
            "jetbrains": {"air": {
                "commandTitle": "ignored",
                "subagent": true,
                "skill": {"name": "commits", "path": "/p/SKILL.md"},
                "contextCompaction": {"version": 1, "preTokens": 10}
            }}
        }));
        translate_air_meta(AgentType::ClaudeCode, &mut meta);
        assert_eq!(meta["claudeCode"]["title"], "kept");
        assert_eq!(meta["claudeCode"]["subagent"], true);
        assert_eq!(meta["claudeCode"]["skill"], "commits");
        assert_eq!(meta["claudeCode"]["skillPath"], "/p/SKILL.md");
        assert_eq!(meta["contextCompaction"]["preTokens"], 10);

        // codex gets the shared compaction key only.
        let mut codex = obj(json!({"jetbrains": {"air": {"subagent": true, "commandTitle": "x"}}}));
        translate_air_meta(AgentType::Codex, &mut codex);
        assert!(codex.get("claudeCode").is_none());

        // Nothing to derive leaves no empty `claudeCode` behind.
        let mut bare = obj(json!({"jetbrains": {"air": {"version": 1}}}));
        translate_air_meta(AgentType::ClaudeCode, &mut bare);
        assert!(bare.get("claudeCode").is_none());
    }

    #[test]
    fn moved_session_keys_read_the_legacy_spelling_first() {
        let legacy = obj(
            json!({"permission": {"title": "old"}, "jetbrains": {"air": {"permission": {"title": "new"}}}}),
        );
        assert_eq!(permission_record(Some(&legacy)).unwrap()["title"], "old");
        let air =
            obj(json!({"jetbrains": {"air": {"version": 1, "permission": {"title": "new"}}}}));
        assert_eq!(permission_record(Some(&air)).unwrap()["title"], "new");
        assert!(permission_record(None).is_none());
    }

    #[test]
    fn option_permission_record_is_copied_to_the_legacy_key() {
        let air = obj(
            json!({"jetbrains": {"air": {"version": 1, "permission": {"version": 1, "description": "Run"}}}}),
        );
        let normalized = normalize_permission_option_meta(Some(&air)).unwrap();
        assert_eq!(normalized["permission"]["description"], "Run");
        assert_eq!(
            normalized["jetbrains"]["air"]["permission"]["description"],
            "Run"
        );
        let legacy = obj(json!({"permission": {"version": 1, "description": "old"}}));
        assert_eq!(
            normalize_permission_option_meta(Some(&legacy)).unwrap()["permission"]["description"],
            "old"
        );
        assert!(normalize_permission_option_meta(None).is_none());
    }

    #[test]
    fn codex_plan_review_is_recognised_by_its_id() {
        assert_eq!(
            codex_plan_review_item_id("plan-review:plan-2"),
            Some("plan-2")
        );
        assert_eq!(codex_plan_review_item_id("plan-review:"), None);
        assert_eq!(codex_plan_review_item_id("cmd-1"), None);
    }

    #[test]
    fn codex_activity_meta_is_rebuilt_from_the_raw_input() {
        let meta = codex_activity_meta_from_raw_input(Some(&json!({
            "activityKind": "started", "agentPath": "/root/weather", "agentThreadId": "child-thread"
        })))
        .unwrap();
        assert_eq!(
            meta,
            json!({"codex": {"subagent": {"activity": "started", "path": "/root/weather", "threadId": "child-thread"}}})
        );
        // A collaboration call's input is not an activity.
        assert!(codex_activity_meta_from_raw_input(Some(&json!({
            "senderThreadId": "s", "receiverThreadIds": ["c"], "agentsStates": {}
        })))
        .is_none());
        assert!(codex_activity_meta_from_raw_input(None).is_none());
    }

    #[test]
    fn web_search_input_is_recognised_in_both_shapes() {
        // 1.13.x: the whole app-server item.
        assert!(is_codex_web_search_input(Some(&json!({
            "type": "webSearch", "id": "web-1", "query": "", "action": null
        }))));
        // 2.0.0 (AIR): `{query, action}` only — `action` may be null.
        assert!(is_codex_web_search_input(Some(
            &json!({"query": "", "action": null})
        )));
        assert!(is_codex_web_search_input(Some(&json!({
            "query": "acp", "action": {"type": "search", "query": "acp", "queries": null}
        }))));
        // A fuzzy file search is `{query}` alone.
        assert!(!is_codex_web_search_input(Some(
            &json!({"query": "handler"})
        )));
        assert!(!is_codex_web_search_input(None));
    }

    #[test]
    fn sdk_tool_results_come_only_from_user_messages() {
        let message = json!({
            "type": "user",
            "message": {"role": "user", "content": [
                {"type": "tool_result", "tool_use_id": "toolu_read", "content": "1\tx"},
                {"type": "text", "text": "not a result"},
                {"type": "tool_result", "tool_use_id": "toolu_bad", "content": "boom", "is_error": true}
            ]}
        });
        let results = claude_sdk_tool_results(&message);
        assert_eq!(results.len(), 2);
        assert_eq!(results[0].tool_use_id, "toolu_read");
        assert!(!results[0].is_error);
        assert!(results[1].is_error);
        assert!(claude_sdk_tool_results(&json!({"type": "assistant"})).is_empty());
    }
}
