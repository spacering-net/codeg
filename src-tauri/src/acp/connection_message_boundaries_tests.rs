use super::*;
use crate::acp::session_state::LiveContentBlock;

async fn emit_chunks(agent_type: AgentType, chunks: &[(Option<&str>, &str)]) -> (String, String) {
    let frames: Vec<_> = chunks
        .iter()
        .map(|(message_id, text)| {
            serde_json::json!({
                "sessionUpdate": "agent_message_chunk",
                "messageId": message_id,
                "content": {"type": "text", "text": text},
            })
        })
        .collect();
    emit_frames(agent_type, &frames).await
}

async fn emit_frames(agent_type: AgentType, frames: &[serde_json::Value]) -> (String, String) {
    let state = Arc::new(RwLock::new(SessionState::new(
        "message-boundaries".to_string(),
        agent_type,
        None,
        "win".to_string(),
        None,
    )));
    state.write().await.apply_event(&AcpEvent::StatusChanged {
        status: ConnectionStatus::Prompting,
    });
    let mut cache = ToolCallOutputCache::default();
    let mut cb = CodeBuddyLiveState::default();
    for frame in frames {
        let update = serde_json::from_value(frame.clone()).unwrap();
        emit_conversation_update(
            &state,
            &EventEmitter::Noop,
            agent_type,
            update,
            None,
            &mut cache,
            &mut cb,
        )
        .await;
    }
    let state = state.read().await;
    let streamed = state
        .recent_events_after(0)
        .unwrap()
        .iter()
        .filter_map(|event| match &event.payload {
            AcpEvent::ContentDelta { text, .. } => Some(text.as_str()),
            _ => None,
        })
        .collect::<String>();
    let snapshot = state
        .to_snapshot()
        .live_message
        .unwrap()
        .content
        .iter()
        .filter_map(|block| match block {
            LiveContentBlock::Text { text, .. } => Some(text.as_str()),
            _ => None,
        })
        .collect::<String>();
    (streamed, snapshot)
}

#[tokio::test]
async fn codex_message_boundaries_do_not_pad_separate_blocks() {
    for boundary in [
        serde_json::json!({
            "sessionUpdate": "agent_thought_chunk",
            "content": {"type": "text", "text": "thinking"},
        }),
        serde_json::json!({
            "sessionUpdate": "tool_call",
            "toolCallId": "call_1",
            "title": "Read",
            "kind": "read",
            "status": "completed",
        }),
    ] {
        let (streamed, snapshot) = emit_frames(
            AgentType::Codex,
            &[
                serde_json::json!({
                    "sessionUpdate": "agent_message_chunk",
                    "messageId": "commentary",
                    "content": {"type": "text", "text": "intro"},
                }),
                boundary,
                serde_json::json!({
                    "sessionUpdate": "agent_message_chunk",
                    "messageId": "answer",
                    "content": {"type": "text", "text": "answer"},
                }),
            ],
        )
        .await;
        assert_eq!(streamed, "introanswer");
        assert_eq!(snapshot, "introanswer");
    }
}

#[tokio::test]
async fn codex_message_boundaries_keep_mermaid_fences_on_their_own_line() {
    // Session 4531: commentary and final_answer are distinct messages, with
    // no tool or thinking block between them to break the live text run.
    let intro = "我先画一个简单的任务处理流程，看看 Mermaid 的渲染效果。";
    let diagram = "```mermaid\nflowchart TD\n    A([开始]) --> B[提交任务]\n    B --> C[分析需求]\n    C --> D{信息是否完整？}\n    D -->|是| E[执行任务]\n    D -->|否| F[补充信息]\n    F --> C\n    E --> G[检查结果]\n    G --> H{是否符合预期？}\n    H -->|是| I([完成])\n    H -->|否| J[调整方案]\n    J --> E\n```";
    let (streamed, snapshot) = emit_chunks(
        AgentType::Codex,
        &[
            (Some("commentary"), intro),
            (Some("answer"), "```mer"),
            (Some("answer"), &diagram[6..]),
        ],
    )
    .await;
    let expected = format!("{intro}\n\n{diagram}");
    assert_eq!(streamed, expected, "live clients need the message boundary");
    assert_eq!(
        snapshot, expected,
        "reconnecting clients must see the same text"
    );
}

#[tokio::test]
async fn codex_message_boundaries_preserve_chunks_and_existing_newlines() {
    for (chunks, expected) in [
        (vec![(Some("a"), "hel"), (Some("a"), "lo")], "hello"),
        (vec![(None, "hel"), (None, "lo")], "hello"),
        (vec![(Some("a"), "hel"), (None, "lo")], "hello"),
        (
            vec![(Some("a"), "hel"), (Some("b"), ""), (Some("a"), "lo")],
            "hello",
        ),
        (
            vec![(Some("a"), "intro\n\n"), (Some("b"), "```mermaid")],
            "intro\n\n```mermaid",
        ),
        (
            vec![(Some("a"), "intro\n"), (Some("b"), "\n```mermaid")],
            "intro\n\n```mermaid",
        ),
        (
            vec![(Some("a"), "intro"), (Some("b"), "\n```mermaid")],
            "intro\n\n```mermaid",
        ),
        (
            vec![(Some("a"), "intro\n"), (Some("b"), "```mermaid")],
            "intro\n\n```mermaid",
        ),
    ] {
        let (streamed, snapshot) = emit_chunks(AgentType::Codex, &chunks).await;
        assert_eq!(streamed, expected, "chunks: {chunks:?}");
        assert_eq!(snapshot, expected, "chunks: {chunks:?}");
    }
    let (streamed, snapshot) = emit_chunks(
        AgentType::ClaudeCode,
        &[(Some("a"), "hel"), (Some("b"), "lo")],
    )
    .await;
    assert_eq!(
        streamed, "hello",
        "other adapters keep their existing semantics"
    );
    assert_eq!(snapshot, "hello");
}
