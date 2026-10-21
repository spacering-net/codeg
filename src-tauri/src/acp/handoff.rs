//! Native-family detection and presentation of saved handoff history.
//! Native copies live exclusively in `account_transfer`; portable archives
//! live in `handoff_context`. `handoff_service::commit` records the segment
//! and changes its account/session binding in one transaction. Legacy summary
//! records still render, but new handoffs never generate a clipped digest.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use crate::acp::registry::{self, AgentDistribution};
use crate::db::entities::conversation_handoff;
use crate::models::{AgentType, ContentBlock, MessageTurn, TurnRole};

/// First line of every seeded briefing. An HTML comment renders as nothing
/// wherever the prompt is shown as Markdown, and the detail read folds the
/// turn that starts with it into the handoff divider (`splice_handoffs`).
pub const BRIEFING_MARKER: &str = "<!-- codeg:handoff-briefing -->";

pub const HANDOFF_META_KEY: &str = "codeg.handoff";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HandoffPath {
    Native,
    Context,
    Summary,
}

impl HandoffPath {
    pub fn as_str(self) -> &'static str {
        match self {
            HandoffPath::Native => "native",
            HandoffPath::Context => "context",
            HandoffPath::Summary => "summary",
        }
    }

    pub fn parse(s: &str) -> Self {
        match s {
            "native" => HandoffPath::Native,
            "context" => HandoffPath::Context,
            _ => HandoffPath::Summary,
        }
    }
}

/// Agent families whose sessions codeg can move between homes losslessly.
///
/// Claude only, deliberately: `claude-agent-acp`'s `session/load` resolves a
/// session id by scanning `<CLAUDE_CONFIG_DIR>/projects/*/<id>.jsonl`, so a
/// transcript copied into another home loads there under the same id
/// (verified against the real adapter). Codex and Grok keep session stores
/// too, but their load paths have not been verified with a copied file, and
/// advertising a native transfer that silently starts an empty session would
/// be worse than the summary path.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NativeFamily {
    Claude,
}

/// npm packages that wrap Claude Code as an ACP agent. An extra isolated
/// Claude account in codeg is a custom agent running one of these with its own
/// `CLAUDE_CONFIG_DIR`, so its sessions are Claude sessions.
pub fn is_claude_adapter_package(package: &str) -> bool {
    // `@scope/name@1.2.3` → `@scope/name`; an unversioned `@scope/name` has its
    // only `@` at index 0, which `rsplit_once` would misread as a version split.
    let name = package
        .rsplit_once('@')
        .map(|(name, _)| name)
        .filter(|name| !name.is_empty())
        .unwrap_or(package);
    matches!(
        name,
        "@agentclientprotocol/claude-agent-acp"
            | "@zed-industries/claude-agent-acp"
            | "@zed-industries/claude-code-acp"
    )
}

/// [`native_family`] against an explicit distribution, so the decision can be
/// tested without the process-global custom registry.
pub fn native_family_of(
    agent_type: AgentType,
    distribution: &AgentDistribution,
) -> Option<NativeFamily> {
    match agent_type {
        AgentType::ClaudeCode => Some(NativeFamily::Claude),
        AgentType::Custom(_) => match distribution {
            AgentDistribution::Npx { package, .. } if is_claude_adapter_package(package) => {
                Some(NativeFamily::Claude)
            }
            _ => None,
        },
        _ => None,
    }
}

pub fn native_family(agent_type: AgentType) -> Option<NativeFamily> {
    let meta = registry::get_agent_meta(agent_type);
    native_family_of(agent_type, &meta.distribution)
}

/// Which path a handoff between two agents takes. Same family on both sides
/// means the transcript can move; anything else is briefed.
pub fn plan_path(source: AgentType, target: AgentType) -> HandoffPath {
    plan_path_of(native_family(source), native_family(target))
}

pub fn plan_path_of(source: Option<NativeFamily>, target: Option<NativeFamily>) -> HandoffPath {
    match (source, target) {
        (Some(a), Some(b)) if a == b => HandoffPath::Native,
        _ => HandoffPath::Summary,
    }
}

/// Recognize the internal initial prompt on the saved history path.
pub fn is_briefing_text(text: &str) -> bool {
    text.trim_start().starts_with(BRIEFING_MARKER)
}

// ─── Divider + splice ───────────────────────────────────────────────────────

/// One handoff in a conversation's chain, as the detail read consumes it.
#[derive(Debug, Clone, PartialEq)]
pub struct HandoffLink {
    pub from_agent_type: AgentType,
    pub from_external_id: Option<String>,
    pub to_agent_type: AgentType,
    pub to_external_id: String,
    pub path: HandoffPath,
    pub carried: bool,
    pub user_turns_before: usize,
    pub note: Option<String>,
    pub briefing: Option<String>,
    pub truncated: bool,
    pub at: DateTime<Utc>,
    pub context_id: Option<String>,
    pub source_stats: Option<serde_json::Value>,
    pub source_model: Option<String>,
}

impl HandoffLink {
    /// `None` when either agent's wire name no longer parses (a row written by
    /// a newer codeg); such a link is skipped rather than rendered wrongly.
    pub fn from_row(row: &conversation_handoff::Model) -> Option<Self> {
        Some(Self {
            from_agent_type: AgentType::from_wire(&row.from_agent_type)?,
            from_external_id: row.from_external_id.clone(),
            to_agent_type: AgentType::from_wire(&row.to_agent_type)?,
            to_external_id: row.to_external_id.clone(),
            path: HandoffPath::parse(&row.path),
            carried: row.carried,
            user_turns_before: usize::try_from(row.user_turns_before).unwrap_or(0),
            note: row.note.clone(),
            briefing: row.briefing.clone(),
            truncated: row.truncated,
            at: row.created_at,
            context_id: row.context_id.clone(),
            source_stats: row
                .source_stats_json
                .as_deref()
                .and_then(|s| serde_json::from_str(s).ok()),
            source_model: row.source_model.clone(),
        })
    }
}

/// The divider between two segments: a paired `ToolUse`/`ToolResult` carrying
/// `_meta["codeg.handoff"]`, the same shape the context-compaction divider
/// takes so the frontend hoists it to a standalone timeline item.
pub fn divider_turn(link: &HandoffLink, index: usize) -> MessageTurn {
    let tool_use_id = format!("handoff-{index}");
    let mut marker = serde_json::Map::new();
    marker.insert("version".into(), serde_json::json!(1));
    marker.insert(
        "from".into(),
        serde_json::json!(link.from_agent_type.as_wire()),
    );
    marker.insert("to".into(), serde_json::json!(link.to_agent_type.as_wire()));
    marker.insert("path".into(), serde_json::json!(link.path.as_str()));
    marker.insert("carried".into(), serde_json::json!(link.carried));
    marker.insert("sourceStats".into(), serde_json::json!(link.source_stats));
    marker.insert("sourceModel".into(), serde_json::json!(link.source_model));
    marker.insert("truncated".into(), serde_json::json!(link.truncated));
    marker.insert("at".into(), serde_json::json!(link.at.to_rfc3339()));
    if let Some(note) = link
        .note
        .as_deref()
        .map(str::trim)
        .filter(|n| !n.is_empty())
    {
        marker.insert("note".into(), serde_json::json!(note));
    }
    if let Some(briefing) = &link.briefing {
        marker.insert("briefing".into(), serde_json::json!(briefing));
    }
    let meta = serde_json::Value::Object(
        [(
            HANDOFF_META_KEY.to_string(),
            serde_json::Value::Object(marker),
        )]
        .into_iter()
        .collect(),
    );
    MessageTurn {
        id: tool_use_id.clone(),
        role: TurnRole::Assistant,
        blocks: vec![
            ContentBlock::ToolUse {
                tool_use_id: Some(tool_use_id.clone()),
                tool_name: "agent_handoff".to_string(),
                input_preview: None,
                status: None,
                meta: Some(meta),
            },
            ContentBlock::ToolResult {
                tool_use_id: Some(tool_use_id),
                output_preview: None,
                is_error: false,
                agent_stats: None,
                images: Vec::new(),
            },
        ],
        timestamp: link.at,
        usage: None,
        duration_ms: None,
        model: None,
        completed_at: Some(link.at),
        agent_message_id: None,
    }
}

pub fn count_user_turns(turns: &[MessageTurn]) -> usize {
    turns
        .iter()
        .filter(|t| matches!(t.role, TurnRole::User))
        .count()
}

/// True for a turn [`divider_turn`] produced: bookkeeping, not conversation,
/// so a briefing built from a spliced timeline leaves it out.
pub fn is_divider_turn(turn: &MessageTurn) -> bool {
    turn.blocks.iter().any(|b| {
        matches!(
            b,
            ContentBlock::ToolUse { meta: Some(meta), .. } if meta.get(HANDOFF_META_KEY).is_some()
        )
    })
}

fn is_briefing_turn(turn: &MessageTurn) -> bool {
    matches!(turn.role, TurnRole::User)
        && turn
            .blocks
            .iter()
            .find_map(|b| match b {
                ContentBlock::Text { text } => Some(text.as_str()),
                _ => None,
            })
            .is_some_and(is_briefing_text)
}

/// Assemble one timeline out of a conversation's handoff chain.
///
/// `segments[i]` is the history read from `links[i]`'s source (empty for a
/// carried link, whose target already holds it). Uncarried segments come first,
/// each followed by its divider; then the current session. A carried link's
/// divider is placed by the user-turn count recorded at handoff time, right
/// before the next user prompt, since its store holds both halves and nothing
/// else marks the seam. The prompt that seeded a summary handoff is folded
/// away: its text already rides on the divider, and a screen-long briefing is
/// not something the user wrote.
pub fn splice_handoffs(
    links: &[HandoffLink],
    segments: Vec<Vec<MessageTurn>>,
    current: Vec<MessageTurn>,
) -> Vec<MessageTurn> {
    if links.is_empty() {
        return current;
    }
    let current = clean_seeded_turns(current, links);

    let mut out: Vec<MessageTurn> = Vec::new();
    let mut segments = segments.into_iter();
    let mut carried: Vec<usize> = Vec::new();
    for (i, link) in links.iter().enumerate() {
        let segment = segments.next().unwrap_or_default();
        if link.carried {
            carried.push(i);
            continue;
        }
        out.extend(segment.into_iter().map(|mut turn| {
            turn.id = format!("handoff-{i}:{}", turn.id);
            turn
        }));
        out.push(divider_turn(link, i));
    }
    out.extend(current);

    for i in carried {
        let link = &links[i];
        let mut seen = 0usize;
        let mut pos = out.len();
        for (idx, turn) in out.iter().enumerate() {
            if matches!(turn.role, TurnRole::User) {
                if seen == link.user_turns_before {
                    pos = idx;
                    break;
                }
                seen += 1;
            }
        }
        out.insert(pos, divider_turn(link, i));
    }
    out
}

/// Hide only Codeg's recorded context seed, including a retry suffix attached
/// to a real user prompt. The real prompt and all original blocks stay visible.
pub fn clean_seeded_turns(turns: Vec<MessageTurn>, links: &[HandoffLink]) -> Vec<MessageTurn> {
    turns
        .into_iter()
        .filter_map(|mut turn| {
            if is_briefing_turn(&turn) {
                return None;
            }
            if matches!(turn.role, TurnRole::User) {
                for block in &mut turn.blocks {
                    if let ContentBlock::Text { text } = block {
                        for id in links.iter().filter_map(|l| l.context_id.as_deref()) {
                            let start_marker = format!("[codeg-context:{id}]");
                            let end_marker = format!("[/codeg-context:{id}]");
                            if let Some(start) = text.find(&start_marker) {
                                if let Some(end) = text[start..].find(&end_marker) {
                                    let before = text[..start]
                                        .trim_end()
                                        .trim_end_matches(BRIEFING_MARKER)
                                        .trim_end();
                                    let after = text[start + end + end_marker.len()..].trim_start();
                                    *text = match (before.is_empty(), after.is_empty()) {
                                        (false, false) => format!("{before}\n{after}"),
                                        (true, _) => after.to_string(),
                                        (_, true) => before.to_string(),
                                    };
                                }
                            }
                        }
                        for seed in links.iter().filter_map(|l| l.briefing.as_deref()) {
                            if let Some(before) = text.trim_end().strip_suffix(seed.trim_end()) {
                                *text = before.trim_end().to_string();
                            }
                        }
                    }
                }
                turn.blocks
                    .retain(|b| !matches!(b, ContentBlock::Text { text } if text.is_empty()));
            }
            (!turn.blocks.is_empty()).then_some(turn)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn text_turn(id: &str, role: TurnRole, text: &str) -> MessageTurn {
        MessageTurn {
            id: id.into(),
            role,
            blocks: vec![ContentBlock::Text { text: text.into() }],
            timestamp: Utc::now(),
            usage: None,
            duration_ms: None,
            model: None,
            completed_at: None,
            agent_message_id: None,
        }
    }

    fn npx(package: &'static str) -> AgentDistribution {
        AgentDistribution::Npx {
            version: "1",
            package,
            cmd: "x",
            args: &[],
            env: &[],
            node_required: None,
        }
    }

    fn link(carried: bool, user_turns_before: usize) -> HandoffLink {
        HandoffLink {
            from_agent_type: AgentType::ClaudeCode,
            from_external_id: Some("S1".into()),
            to_agent_type: AgentType::Codex,
            to_external_id: "S2".into(),
            path: if carried {
                HandoffPath::Native
            } else {
                HandoffPath::Summary
            },
            carried,
            user_turns_before,
            note: Some("finish it".into()),
            briefing: Some(format!("{BRIEFING_MARKER}\nbrief")),
            truncated: false,
            at: Utc::now(),
            context_id: None,
            source_stats: None,
            source_model: None,
        }
    }

    #[test]
    fn claude_adapter_packages_are_recognized_with_or_without_a_version() {
        assert!(is_claude_adapter_package(
            "@agentclientprotocol/claude-agent-acp@0.65.0"
        ));
        assert!(is_claude_adapter_package(
            "@agentclientprotocol/claude-agent-acp"
        ));
        assert!(is_claude_adapter_package(
            "@zed-industries/claude-code-acp@0.10.0"
        ));
        assert!(!is_claude_adapter_package(
            "@agentclientprotocol/codex-acp@1.1.9"
        ));
        assert!(!is_claude_adapter_package("@vibe-kit/grok-cli@1.0.5"));
        assert!(!is_claude_adapter_package(""));
    }

    #[test]
    fn same_family_is_native_and_everything_else_is_summary() {
        let claude_slot = AgentType::custom("claude-code-2").unwrap();
        let codex_slot = AgentType::custom("codex-2").unwrap();
        let claude_dist = npx("@agentclientprotocol/claude-agent-acp@0.65.0");
        let codex_dist = npx("@agentclientprotocol/codex-acp@1.1.9");

        let builtin = native_family_of(AgentType::ClaudeCode, &npx("unused"));
        let slot = native_family_of(claude_slot, &claude_dist);
        assert_eq!(builtin, Some(NativeFamily::Claude));
        assert_eq!(slot, Some(NativeFamily::Claude));
        assert_eq!(plan_path_of(builtin, slot), HandoffPath::Native);
        assert_eq!(plan_path_of(slot, builtin), HandoffPath::Native);

        // Codex and Grok have stores too, but no verified load-from-copy path:
        // they stay on the summary side until that is proven.
        assert_eq!(native_family_of(AgentType::Codex, &codex_dist), None);
        assert_eq!(native_family_of(codex_slot, &codex_dist), None);
        assert_eq!(
            native_family_of(AgentType::Grok, &npx("@vibe-kit/grok-cli@1")),
            None
        );
        assert_eq!(plan_path_of(builtin, None), HandoffPath::Summary);
        assert_eq!(plan_path_of(None, builtin), HandoffPath::Summary);
        assert_eq!(plan_path_of(None, None), HandoffPath::Summary);
        // A custom agent that is NOT a Claude wrapper never counts as Claude,
        // whatever its id says.
        assert_eq!(
            native_family_of(AgentType::custom("claude-ish").unwrap(), &codex_dist),
            None
        );
    }

    #[test]
    fn divider_carries_the_handoff_meta_the_frontend_hoists() {
        let l = link(false, 3);
        let turn = divider_turn(&l, 2);
        assert_eq!(turn.id, "handoff-2");
        assert!(matches!(turn.role, TurnRole::Assistant));
        let ContentBlock::ToolUse {
            tool_use_id,
            tool_name,
            meta: Some(meta),
            ..
        } = &turn.blocks[0]
        else {
            panic!("expected a ToolUse first");
        };
        assert_eq!(tool_use_id.as_deref(), Some("handoff-2"));
        assert_eq!(tool_name, "agent_handoff");
        let marker = meta.get(HANDOFF_META_KEY).expect("meta key");
        assert_eq!(marker["version"], 1);
        assert_eq!(marker["from"], "claude_code");
        assert_eq!(marker["to"], "codex");
        assert_eq!(marker["path"], "summary");
        assert_eq!(marker["carried"], false);
        assert_eq!(marker["note"], "finish it");
        assert!(marker["briefing"]
            .as_str()
            .unwrap()
            .starts_with(BRIEFING_MARKER));
        assert!(marker["at"].is_string());
        let ContentBlock::ToolResult { tool_use_id, .. } = &turn.blocks[1] else {
            panic!("expected the paired ToolResult");
        };
        assert_eq!(tool_use_id.as_deref(), Some("handoff-2"));
        assert!(is_divider_turn(&turn));
        assert!(!is_divider_turn(&text_turn(
            "t",
            TurnRole::Assistant,
            "plain"
        )));
    }

    #[test]
    fn divider_omits_a_blank_note() {
        let mut l = link(false, 0);
        l.note = Some("   ".into());
        l.briefing = None;
        let turn = divider_turn(&l, 0);
        let ContentBlock::ToolUse {
            meta: Some(meta), ..
        } = &turn.blocks[0]
        else {
            panic!("expected a ToolUse");
        };
        let marker = &meta[HANDOFF_META_KEY];
        assert!(marker.get("note").is_none());
        assert!(marker.get("briefing").is_none());
    }

    #[test]
    fn summary_segment_renders_before_its_divider_and_the_briefing_folds_away() {
        let segment = vec![
            text_turn("s1", TurnRole::User, "old prompt"),
            text_turn("s2", TurnRole::Assistant, "old reply"),
        ];
        let current = vec![
            text_turn(
                "c1",
                TurnRole::User,
                &format!("{BRIEFING_MARKER}\nseeded briefing"),
            ),
            text_turn("c2", TurnRole::Assistant, "new agent reply"),
            text_turn("c3", TurnRole::User, "follow-up"),
        ];
        let out = splice_handoffs(&[link(false, 1)], vec![segment], current);
        let ids: Vec<&str> = out.iter().map(|t| t.id.as_str()).collect();
        assert_eq!(
            ids,
            vec!["handoff-0:s1", "handoff-0:s2", "handoff-0", "c2", "c3"]
        );
        assert_eq!(count_user_turns(&out), 2);
    }

    #[test]
    fn carried_divider_lands_before_the_next_user_prompt() {
        // The native target holds both halves; the divider goes after the
        // reply to the last prompt the source answered (2 user turns before).
        let current = vec![
            text_turn("u1", TurnRole::User, "one"),
            text_turn("a1", TurnRole::Assistant, "reply one"),
            text_turn("u2", TurnRole::User, "two"),
            text_turn("a2", TurnRole::Assistant, "reply two"),
            text_turn("u3", TurnRole::User, "three (asked after the handoff)"),
            text_turn("a3", TurnRole::Assistant, "reply three"),
        ];
        let out = splice_handoffs(&[link(true, 2)], vec![Vec::new()], current.clone());
        let ids: Vec<&str> = out.iter().map(|t| t.id.as_str()).collect();
        assert_eq!(ids, vec!["u1", "a1", "u2", "a2", "handoff-0", "u3", "a3"]);

        // Handed off after the last reply: nothing follows, so the divider is
        // the tail. A count past the end lands there too.
        let out = splice_handoffs(&[link(true, 3)], vec![Vec::new()], current.clone());
        assert_eq!(out.last().unwrap().id, "handoff-0");
        let out = splice_handoffs(&[link(true, 99)], vec![Vec::new()], current);
        assert_eq!(out.last().unwrap().id, "handoff-0");
    }

    #[test]
    fn mixed_chain_keeps_every_segment_in_order() {
        // A → B (summary), then B → B2 (native, carried): the A segment first,
        // then B2's own store holding B's turns, with the second divider placed
        // by the user-turn count measured on the combined rendering.
        let a_segment = vec![
            text_turn("a-u1", TurnRole::User, "start"),
            text_turn("a-a1", TurnRole::Assistant, "hi"),
        ];
        let b2_store = vec![
            text_turn("b-u1", TurnRole::User, "under B"),
            text_turn("b-a1", TurnRole::Assistant, "B reply"),
            text_turn("b2-u1", TurnRole::User, "under B2"),
            text_turn("b2-a1", TurnRole::Assistant, "B2 reply"),
        ];
        // At the second handoff the rendering showed a-u1 and b-u1: 2 user turns.
        let links = vec![link(false, 1), link(true, 2)];
        let out = splice_handoffs(&links, vec![a_segment, Vec::new()], b2_store);
        let ids: Vec<&str> = out.iter().map(|t| t.id.as_str()).collect();
        assert_eq!(
            ids,
            vec![
                "handoff-0:a-u1",
                "handoff-0:a-a1",
                "handoff-0",
                "b-u1",
                "b-a1",
                "handoff-1",
                "b2-u1",
                "b2-a1"
            ]
        );
    }

    #[test]
    fn repeated_native_turn_ids_stay_unique_across_segments() {
        let a = text_turn("turn-0", TurnRole::User, "first agent");
        let b = text_turn("turn-0", TurnRole::User, "second agent");
        let c = text_turn("turn-0", TurnRole::User, "current agent");
        let out = splice_handoffs(
            &[link(false, 1), link(false, 2)],
            vec![vec![a], vec![b]],
            vec![c],
        );
        let ids: std::collections::HashSet<_> = out.iter().map(|t| &t.id).collect();
        assert_eq!(ids.len(), out.len());
        assert_eq!(count_user_turns(&out), 3);
    }

    #[test]
    fn retry_frame_keeps_the_real_user_prompt_when_whitespace_changes() {
        let mut record = link(false, 1);
        record.context_id = Some("context-id".into());
        record.briefing = Some("original unnormalized seed".into());
        let input = text_turn("u",TurnRole::User,&format!("Keep my instruction. {BRIEFING_MARKER} [codeg-context:context-id] normalized context [/codeg-context:context-id]"));
        let out = clean_seeded_turns(vec![input], &[record]);
        assert_eq!(out.len(), 1);
        assert!(
            matches!(&out[0].blocks[0],ContentBlock::Text { text } if text == "Keep my instruction.")
        );
    }

    #[test]
    fn no_links_means_no_change() {
        let current = vec![text_turn("u1", TurnRole::User, "hi")];
        let out = splice_handoffs(&[], Vec::new(), current.clone());
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].id, "u1");
    }

    #[test]
    fn links_round_trip_through_rows() {
        let row = conversation_handoff::Model {
            id: 1,
            conversation_id: 7,
            seq: 0,
            from_agent_type: "claude_code".into(),
            from_external_id: Some("S1".into()),
            to_agent_type: "custom:claude-code-2".into(),
            to_external_id: "S1".into(),
            path: "native".into(),
            carried: true,
            user_turns_before: 4,
            note: None,
            briefing: None,
            truncated: false,
            created_at: Utc::now(),
            from_account_id: None,
            to_account_id: None,
            history_json: None,
            context_id: None,
            context_pending: false,
            source_stats_json: None,
            source_model: None,
        };
        let link = HandoffLink::from_row(&row).expect("parses");
        assert_eq!(link.from_agent_type, AgentType::ClaudeCode);
        assert_eq!(
            link.to_agent_type,
            AgentType::custom("claude-code-2").unwrap()
        );
        assert_eq!(link.path, HandoffPath::Native);
        assert!(link.carried);
        assert_eq!(link.user_turns_before, 4);

        let mut unknown = row;
        unknown.to_agent_type = "not_an_agent".into();
        assert!(HandoffLink::from_row(&unknown).is_none());
    }
}
