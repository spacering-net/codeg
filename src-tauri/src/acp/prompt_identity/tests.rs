use super::*;
use crate::models::message::TurnRole;

fn turn(index: usize, role: TurnRole, text: &str) -> MessageTurn {
    MessageTurn {
        id: format!("turn-{index}"),
        role,
        blocks: vec![ContentBlock::Text { text: text.into() }],
        timestamp: chrono::DateTime::from_timestamp(1_700_000_000 + index as i64 * 120, 0).unwrap(),
        usage: None,
        duration_ms: None,
        model: None,
        completed_at: None,
        agent_message_id: None,
    }
}
fn prompt(text: &str) -> Vec<PromptInputBlock> {
    vec![PromptInputBlock::Text { text: text.into() }]
}
fn fixture() -> (tempfile::TempDir, PathBuf, PathBuf) {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("workspace");
    fs::create_dir(&root).unwrap();
    let base = dir.path().join("receipts");
    (dir, root, base)
}

#[test]
fn durable_receipt_survives_long_delay_and_reopening_the_store() {
    let (_dir, root, base) = fixture();
    let prefix = vec![
        turn(0, TurnRole::User, "first"),
        turn(1, TurnRole::Assistant, "answer"),
    ];
    Store::at(&root, &base)
        .unwrap()
        .record(
            AgentType::Codex,
            "session",
            "client",
            &prefix,
            &prompt("next"),
        )
        .unwrap();
    let mut current = prefix;
    current.push(turn(2, TurnRole::User, "next"));
    let resolved = Store::at(&root, &base)
        .unwrap()
        .resolve(AgentType::Codex, "session", "client", &current)
        .unwrap();
    assert_eq!(resolved.id, "turn-2");
}

#[test]
fn identical_unflushed_or_failed_submissions_never_steal_a_later_turn() {
    let (_dir, root, base) = fixture();
    let store = Store::at(&root, &base).unwrap();
    store
        .record(AgentType::Codex, "session", "first", &[], &prompt("same"))
        .unwrap();
    assert!(store
        .resolve(AgentType::Codex, "session", "first", &[])
        .is_err());
    store
        .record(AgentType::Codex, "session", "retry", &[], &prompt("same"))
        .unwrap();
    let current = vec![turn(0, TurnRole::User, "same")];
    for client in ["first", "retry"] {
        assert!(store
            .resolve(AgentType::Codex, "session", client, &current)
            .unwrap_err()
            .contains("ambiguous"));
    }
}

#[test]
fn rewritten_prefix_wrong_session_agent_and_root_are_rejected() {
    let (_dir, root, base) = fixture();
    let store = Store::at(&root, &base).unwrap();
    let mut current = vec![turn(0, TurnRole::User, "first")];
    store
        .record(
            AgentType::Codex,
            "session",
            "client",
            &current,
            &prompt("next"),
        )
        .unwrap();
    current.push(turn(1, TurnRole::User, "next"));
    assert!(store
        .resolve(AgentType::ClaudeCode, "session", "client", &current)
        .is_err());
    assert!(store
        .resolve(AgentType::Codex, "other", "client", &current)
        .is_err());
    current[0].blocks = vec![ContentBlock::Text {
        text: "rewritten".into(),
    }];
    assert!(store
        .resolve(AgentType::Codex, "session", "client", &current)
        .is_err());
    let other = root.parent().unwrap().join("other-workspace");
    fs::create_dir(&other).unwrap();
    assert!(Store::at(&other, &base)
        .unwrap()
        .resolve(AgentType::Codex, "session", "client", &current)
        .is_err());
}

#[test]
fn receipt_checks_image_bytes_and_preserves_image_order() {
    let (_dir, root, base) = fixture();
    let store = Store::at(&root, &base).unwrap();
    let blocks = vec![
        PromptInputBlock::Image {
            data: "AQID".into(),
            mime_type: "image/png".into(),
            uri: None,
        },
        PromptInputBlock::Text {
            text: "describe".into(),
        },
    ];
    store
        .record(AgentType::ClaudeCode, "s", "client", &[], &blocks)
        .unwrap();
    let mut current = vec![turn(0, TurnRole::User, "describe")];
    current[0].blocks.push(ContentBlock::Image {
        data: "AQID".into(),
        mime_type: "image/png".into(),
        uri: None,
    });
    assert!(store
        .resolve(AgentType::ClaudeCode, "s", "client", &current)
        .is_ok());
    current[0].blocks[1] = ContentBlock::Image {
        data: "other".into(),
        mime_type: "image/png".into(),
        uri: None,
    };
    assert!(store
        .resolve(AgentType::ClaudeCode, "s", "client", &current)
        .is_err());
}

#[test]
fn unsupported_submission_invalidates_a_previously_unflushed_slot() {
    let (_dir, root, base) = fixture();
    let store = Store::at(&root, &base).unwrap();
    store
        .record(AgentType::Codex, "s", "text", &[], &prompt("same"))
        .unwrap();
    let resource = PromptInputBlock::ResourceLink {
        uri: "file:///workspace/attachment".into(),
        name: "attachment".into(),
        mime_type: None,
        description: None,
    };
    store
        .record(AgentType::Codex, "s", "resource", &[], &[resource])
        .unwrap();
    let current = [turn(0, TurnRole::User, "same")];
    assert!(store
        .resolve(AgentType::Codex, "s", "text", &current)
        .is_err());
    assert!(store
        .resolve(AgentType::Codex, "s", "resource", &current)
        .is_err());
}

#[test]
fn receipt_storage_evicts_old_metadata_and_still_accepts_new_submissions() {
    let (_dir, root, base) = fixture();
    let store = Store::at(&root, &base).unwrap();
    let entries: Vec<_> = (0..MAX_RECEIPTS)
        .map(|index| Receipt {
            reservation: format!("reservation-{index}"),
            client: format!("client-{index}"),
            agent: AgentType::Codex,
            session: "s".into(),
            prefix_len: index,
            prefix_hash: "unused".into(),
            prompt_hash: "unused".into(),
            ambiguous: false,
        })
        .collect();
    store.write(&entries).unwrap();
    store
        .record(AgentType::Codex, "s", "newest", &[], &prompt("new"))
        .unwrap();
    let receipts = store.read().unwrap();
    assert_eq!(receipts.len(), MAX_RECEIPTS);
    assert_eq!(receipts.first().unwrap().client, "client-1");
    assert!(store
        .resolve(
            AgentType::Codex,
            "s",
            "newest",
            &[turn(0, TurnRole::User, "new")]
        )
        .is_ok());
}

#[test]
fn codex_receipt_uses_the_same_normalization_as_the_real_parser() {
    let (_dir, root, base) = fixture();
    let store = Store::at(&root, &base).unwrap();
    let blocks = vec![
        PromptInputBlock::Text {
            text: "  explain a  b\t\tc".into(),
        },
        PromptInputBlock::Text {
            text: "second line  ".into(),
        },
    ];
    store
        .record(AgentType::Codex, "s", "client", &[], &blocks)
        .unwrap();
    let parsed = crate::parsers::codex::normalize_user_text("  explain a  b\t\tc\nsecond line  ");
    assert_eq!(parsed, "explain a b c\nsecond line");
    assert!(store
        .resolve(
            AgentType::Codex,
            "s",
            "client",
            &[turn(0, TurnRole::User, &parsed)]
        )
        .is_ok());
}

#[test]
fn workspace_patch_preview_changes_do_not_rewrite_the_receipt_prefix() {
    let (_dir, root, base) = fixture();
    let store = Store::at(&root, &base).unwrap();
    fs::write(root.join("a.txt"), "context\nold\n").unwrap();
    let mut original = turn(0, TurnRole::Assistant, "applied");
    original.blocks.push(ContentBlock::ToolUse {
        tool_use_id: Some("patch-1".into()),
        tool_name: "apply_patch".into(),
        input_preview: Some(
            "*** Begin Patch\n*** Update File: a.txt\n@@\n context\n-old\n+new\n*** End Patch\n"
                .into(),
        ),
        status: None,
        meta: None,
    });
    let mut before = vec![original.clone()];
    crate::parsers::resolve_patch_line_numbers(&mut before, root.to_str());
    store
        .record(AgentType::Codex, "s", "client", &before, &prompt("next"))
        .unwrap();
    fs::write(root.join("a.txt"), "inserted\ncontext\nold\n").unwrap();
    let mut after = vec![original];
    crate::parsers::resolve_patch_line_numbers(&mut after, root.to_str());
    assert_ne!(
        serde_json::to_string(&before).unwrap(),
        serde_json::to_string(&after).unwrap()
    );
    after.push(turn(1, TurnRole::User, "next"));
    assert!(store
        .resolve(AgentType::Codex, "s", "client", &after)
        .is_ok());
    if let ContentBlock::ToolUse {
        input_preview: Some(patch),
        ..
    } = &mut after[0].blocks[1]
    {
        *patch = patch.replace("+new", "+different");
    }
    assert!(store
        .resolve(AgentType::Codex, "s", "client", &after)
        .is_err());
}

#[test]
fn receipt_data_inside_workspace_is_rejected_for_normal_and_canonical_paths() {
    let (_dir, root, _) = fixture();
    assert!(Store::at(&root, &root.join(".codeg/receipts")).is_err());
    let canonical = fs::canonicalize(&root).unwrap();
    assert!(Store::at(&canonical, &root.join(".codeg/receipts")).is_err());
}

#[test]
fn definitely_unsent_receipt_does_not_poison_the_next_submission() {
    let (_dir, root, base) = fixture();
    let store = Store::at(&root, &base).unwrap();
    let reservation = store
        .record(AgentType::Codex, "s", "canceled", &[], &prompt("first"))
        .unwrap();
    store
        .discard(AgentType::Codex, "s", "canceled", &reservation)
        .unwrap();
    store
        .record(AgentType::Codex, "s", "next", &[], &prompt("next"))
        .unwrap();
    let current = [turn(0, TurnRole::User, "next")];
    assert!(store
        .resolve(AgentType::Codex, "s", "next", &current)
        .is_ok());
    assert!(store
        .resolve(AgentType::Codex, "s", "canceled", &current)
        .is_err());
}

#[test]
fn failed_duplicate_submission_cannot_delete_the_original_receipt() {
    let (_dir, root, base) = fixture();
    let store = Store::at(&root, &base).unwrap();
    store
        .record(AgentType::Codex, "s", "client", &[], &prompt("original"))
        .unwrap();
    let current = [turn(0, TurnRole::User, "original")];
    assert!(store
        .record(
            AgentType::Codex,
            "s",
            "client",
            &current,
            &prompt("duplicate")
        )
        .is_err());
    for unowned in ["", "another-preparation"] {
        store
            .discard(AgentType::Codex, "s", "client", unowned)
            .unwrap();
        assert!(store
            .resolve(AgentType::Codex, "s", "client", &current)
            .is_ok());
    }
    assert!(store
        .record(
            AgentType::Codex,
            "s",
            "client",
            &current,
            &prompt("duplicate")
        )
        .is_err());
}
