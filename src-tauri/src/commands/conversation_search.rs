use std::collections::HashMap;

use crate::app_error::AppCommandError;
use crate::db::service::{agent_setting_service, folder_service};
use crate::models::{
    AgentType, ContentBlock, ConversationDetail, ConversationSearchMatch, ConversationSearchResult,
    DbConversationSummary, MessageTurn, TurnRole,
};
use crate::parsers::{build_agent_parser, path_eq_for_matching, AgentParser, ParseError};

/// 在已应用目录、状态和智能体筛选的候选会话中搜索，保持原有顺序。
/// 只读解析器返回的正文，不调用会更新会话元数据的详情接口。
pub(super) async fn filter_by_text(
    conn: &sea_orm::DatabaseConnection,
    rows: Vec<DbConversationSummary>,
    search: &str,
) -> Result<Vec<DbConversationSummary>, AppCommandError> {
    Ok(search_rows(conn, rows, search, false)
        .await?
        .into_iter()
        .map(|result| result.summary)
        .collect())
}

pub(super) async fn search_with_matches(
    conn: &sea_orm::DatabaseConnection,
    rows: Vec<DbConversationSummary>,
    search: &str,
) -> Result<Vec<ConversationSearchResult>, AppCommandError> {
    search_rows(conn, rows, search, true).await
}

async fn search_rows(
    conn: &sea_orm::DatabaseConnection,
    rows: Vec<DbConversationSummary>,
    search: &str,
    include_previews: bool,
) -> Result<Vec<ConversationSearchResult>, AppCommandError> {
    let needle = search.trim().to_lowercase();
    if needle.is_empty() || rows.is_empty() {
        return Ok(rows
            .into_iter()
            .map(|summary| ConversationSearchResult {
                summary,
                matches: vec![],
            })
            .collect());
    }
    let envs = agent_setting_service::load_agent_envs(conn).await;
    let folders: HashMap<_, _> = folder_service::list_all_folder_details(conn)
        .await?
        .into_iter()
        .map(|folder| (folder.id, folder.path))
        .collect();
    tokio::task::spawn_blocking(move || {
        let mut parsers: HashMap<AgentType, Box<dyn AgentParser>> = HashMap::new();
        rows.into_iter()
            .filter_map(|row| {
                let title_matches = row
                    .title
                    .as_ref()
                    .is_some_and(|title| title.to_lowercase().contains(&needle));
                if title_matches && !include_previews {
                    return Some(ConversationSearchResult {
                        summary: row,
                        matches: vec![],
                    });
                }
                let Some(external_id) = row.external_id.as_deref() else {
                    return title_matches.then_some(ConversationSearchResult {
                        summary: row,
                        matches: vec![],
                    });
                };
                let parser = parsers.entry(row.agent_type).or_insert_with(|| {
                    build_agent_parser(row.agent_type, &envs.get(row.agent_type))
                });
                let cwd = row
                    .origin_cwd
                    .as_ref()
                    .or_else(|| folders.get(&row.folder_id));
                let detail = read_detail(parser.as_ref(), &row, external_id, cwd);
                let matches = match detail {
                    Ok(detail) => preview_matches(&detail.turns, &needle),
                    Err(error) => {
                        tracing::debug!(conversation_id = row.id, %error, "搜索时无法读取会话正文");
                        vec![]
                    }
                };
                (title_matches || !matches.is_empty()).then_some(ConversationSearchResult {
                    summary: row,
                    matches,
                })
            })
            .collect()
    })
    .await
    .map_err(|error| {
        AppCommandError::task_execution_failed("Failed to search conversation content")
            .with_detail(error.to_string())
    })
}

fn preview_matches(turns: &[MessageTurn], needle: &str) -> Vec<ConversationSearchMatch> {
    turns
        .iter()
        .enumerate()
        .filter_map(|(turn_index, turn)| {
            if !matches!(turn.role, TurnRole::User | TurnRole::Assistant) {
                return None;
            }
            let text = turn
                .blocks
                .iter()
                .filter_map(|block| match block {
                    ContentBlock::Text { text } => Some(text.as_str()),
                    _ => None,
                })
                .collect::<Vec<_>>()
                .join("\n");
            let (before, matched_text, after) = snippet(&text, needle)?;
            Some(ConversationSearchMatch {
                turn_id: turn.id.clone(),
                turn_index,
                role: turn.role.clone(),
                before,
                matched_text,
                after,
            })
        })
        .take(3)
        .collect()
}

// 小写转换可能扩展字符（如 İ），因此将归一化字节映射回原始 UTF-8 边界。
fn snippet(text: &str, needle: &str) -> Option<(String, String, String)> {
    if needle.is_empty() {
        return None;
    }
    let lower = text.to_lowercase();
    let at = lower.find(needle)?;
    let mut normalized_offset = 0;
    let mut start = 0;
    let mut end = text.len();
    for (index, character) in text.char_indices() {
        let normalized_len: usize = character.to_lowercase().map(char::len_utf8).sum();
        let next = normalized_offset + normalized_len;
        if normalized_offset <= at && at < next {
            start = index;
        }
        if normalized_offset < at + needle.len() && at + needle.len() <= next {
            end = index + character.len_utf8();
            break;
        }
        normalized_offset = next;
    }
    let context_start = text[..start]
        .char_indices()
        .rev()
        .nth(47)
        .map_or(0, |(i, _)| i);
    let context_end = text[end..]
        .char_indices()
        .nth(96)
        .map_or(text.len(), |(i, _)| end + i);
    let before = format!(
        "{}{}",
        if context_start > 0 { "…" } else { "" },
        &text[context_start..start]
    );
    let after = format!(
        "{}{}",
        &text[end..context_end],
        if context_end < text.len() { "…" } else { "" }
    );
    Some((before, text[start..end].to_owned(), after))
}

fn read_detail(
    parser: &dyn AgentParser,
    row: &DbConversationSummary,
    external_id: &str,
    cwd: Option<&String>,
) -> Result<ConversationDetail, ParseError> {
    let result = parser.get_conversation(external_id);
    // 与详情读取保持一致：部分 ACP id 需要按原始目录和创建时间解析。
    if !matches!(result, Err(ParseError::ConversationNotFound(_)))
        || !matches!(
            row.agent_type,
            AgentType::OpenClaw | AgentType::Cline | AgentType::Gemini
        )
    {
        return result;
    }
    let matched = parser
        .list_conversations()?
        .into_iter()
        .filter(|conversation| {
            conversation
                .folder_path
                .as_ref()
                .zip(cwd)
                .is_some_and(|(a, b)| path_eq_for_matching(a, b))
        })
        .min_by_key(|conversation| {
            (conversation.started_at - row.created_at)
                .num_seconds()
                .unsigned_abs()
        })
        .filter(|conversation| {
            (conversation.started_at - row.created_at)
                .num_seconds()
                .unsigned_abs()
                < 300
        });
    match matched {
        Some(conversation) => parser.get_conversation(&conversation.id),
        None => result,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::MessageTurn;

    fn turn(id: &str, role: &str, text: &str) -> MessageTurn {
        serde_json::from_value(serde_json::json!({
            "id": id, "role": role,
            "blocks": [{"type":"text", "text":text}],
            "timestamp":"2026-01-01T00:00:00Z"
        }))
        .unwrap()
    }

    #[test]
    fn previews_keep_original_text_and_global_turn_positions() {
        let turns = vec![
            turn("system-0", "system", "timeout"),
            turn("user-1", "user", "检查 CONNECTION Timeout 的原因"),
            turn(
                "assistant-2",
                "assistant",
                "Repair the connection timeout now",
            ),
        ];
        let matches = preview_matches(&turns, "connection timeout");
        assert_eq!(matches.len(), 2);
        assert_eq!(matches[0].turn_id, "user-1");
        assert_eq!(matches[0].turn_index, 1);
        assert_eq!(matches[0].before, "检查 ");
        assert_eq!(matches[0].matched_text, "CONNECTION Timeout");
        assert_eq!(matches[0].after, " 的原因");
        assert_eq!(matches[1].turn_id, "assistant-2");
        assert_eq!(matches[1].turn_index, 2);
    }

    #[test]
    fn previews_are_limited_to_three_messages_and_bounded_context() {
        let turns: Vec<_> = (0..8)
            .map(|i| {
                turn(
                    &format!("turn-{i}"),
                    "assistant",
                    &format!("{}命中{}", "前".repeat(1000), "后".repeat(1000)),
                )
            })
            .collect();
        let matches = preview_matches(&turns, "命中");
        assert_eq!(matches.len(), 3);
        for item in matches {
            assert_eq!(item.matched_text, "命中");
            assert!(item.before.chars().count() <= 49);
            assert!(item.after.chars().count() <= 97);
            assert!(item.before.starts_with('…'));
            assert!(item.after.ends_with('…'));
        }
    }

    #[test]
    fn previews_handle_unicode_lowercase_expansion_and_emoji() {
        let turns = vec![turn("turn-1", "assistant", "😀İ 前文连接超时后文")];
        let matches = preview_matches(&turns, "i\u{307}");
        assert_eq!(matches[0].before, "😀");
        assert_eq!(matches[0].matched_text, "İ");
        assert_eq!(matches[0].after, " 前文连接超时后文");
    }
}
