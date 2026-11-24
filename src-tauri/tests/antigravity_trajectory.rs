//! Oracle test for the Antigravity trajectory decoder.
//!
//! `src-tauri/src/parsers/antigravity.rs` declares a hand-written SUBSET of
//! Google's `gemini_coder.Step` — only the fields a transcript reader needs, at
//! the real field numbers. A test that both encodes and decodes with that
//! subset would be a tautology: it would pass just as happily if every tag in
//! it were wrong.
//!
//! So the fixture in `tests/fixtures/antigravity/` is NOT written by the codeg
//! decoder. It was produced by Python's protobuf runtime driving the
//! `FileDescriptorProto`s extracted from the shipped `agy_acp_server.par`
//! (build `agy_acp_server_20260818_01_RC01`) — Google's own schema, Google's own
//! encoder — and laid out in the `steps(idx, step_payload)` SQLite table the Go
//! harness writes. What this test proves is that codeg's subset agrees with the
//! real thing on the wire.
//!
//! Regenerating it needs the shipped archive; the generator is not vendored
//! because it depends on that 314 MB download. The committed fixture is the
//! artifact.
//!
//! The step shapes below were since checked against a real signed-in session's
//! trajectory (`run_command`, the `call_mcp_tool` dispatch envelope,
//! `agency_tool_call`), so those three are known-faithful and not merely
//! schema-legal. The rest of the arms remain schema-derived, which is why the
//! parser stays conservative about steps it does not recognize — see the
//! settling result the last two blocks assert.

use std::path::PathBuf;

use codeg_lib::models::{ContentBlock, TurnRole};
use codeg_lib::parsers::{antigravity::AntigravityParser, AgentParser};

fn fixture_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
        .join("antigravity")
}

const SESSION_ID: &str = "agy-fixture-001";

#[test]
fn decodes_a_trajectory_encoded_by_googles_own_descriptors() {
    let parser = AntigravityParser::with_base_dir(fixture_dir());

    let listed = parser.list_conversations().expect("list");
    assert_eq!(listed.len(), 1, "one fixture session");
    let summary = &listed[0];
    assert_eq!(summary.id, SESSION_ID);
    // `cwd` comes from the `.meta` sidecar, the title from the first prompt
    // (the server writes no title of its own).
    assert_eq!(summary.folder_path.as_deref(), Some("/work/proj"));
    assert_eq!(summary.title.as_deref(), Some("refactor the parser"));
    assert_eq!(summary.model.as_deref(), Some("gemini-3.7-flash-high"));

    let detail = parser.get_conversation(SESSION_ID).expect("detail");
    assert_eq!(detail.turns.len(), 2, "one user turn, one assistant turn");

    // ── user turn ──────────────────────────────────────────────────────────
    assert!(matches!(detail.turns[0].role, TurnRole::User));
    assert!(matches!(
        &detail.turns[0].blocks[0],
        ContentBlock::Text { text } if text == "refactor the parser"
    ));

    // ── assistant turn ─────────────────────────────────────────────────────
    let assistant = &detail.turns[1];
    assert!(matches!(assistant.role, TurnRole::Assistant));
    assert_eq!(assistant.model.as_deref(), Some("gemini-3.7-flash-high"));

    let blocks = &assistant.blocks;
    assert!(matches!(
        &blocks[0],
        ContentBlock::Thinking { text } if text == "look at the file first"
    ));
    assert!(matches!(
        &blocks[1],
        ContentBlock::Text { text } if text == "I'll start by reading it."
    ));
    match &blocks[2] {
        ContentBlock::ToolUse {
            tool_use_id,
            tool_name,
            input_preview,
            ..
        } => {
            assert_eq!(tool_use_id.as_deref(), Some("tc-001"));
            assert_eq!(tool_name, "view_file");
            assert_eq!(
                input_preview.as_deref(),
                Some(r#"{"AbsolutePath":"/work/proj/src/main.rs"}"#)
            );
        }
        other => panic!("expected the announced view_file call, got {other:?}"),
    }
    match &blocks[3] {
        ContentBlock::ToolResult {
            tool_use_id,
            output_preview,
            is_error,
            ..
        } => {
            assert_eq!(tool_use_id.as_deref(), Some("tc-001"));
            let output = output_preview.as_deref().expect("view_file output");
            assert!(output.contains("/work/proj/src/main.rs"), "{output}");
            assert!(output.contains("fn main() {}"), "{output}");
            assert!(!is_error);
        }
        other => panic!("expected the view_file result, got {other:?}"),
    }

    // The failing command was never announced by a planner_response, so its
    // call card is synthesized from `metadata.tool_call` before the result.
    match &blocks[4] {
        ContentBlock::ToolUse {
            tool_use_id,
            tool_name,
            ..
        } => {
            assert_eq!(tool_use_id.as_deref(), Some("tc-002"));
            assert_eq!(tool_name, "run_command");
        }
        other => panic!("expected a synthesized run_command call, got {other:?}"),
    }
    match &blocks[5] {
        ContentBlock::ToolResult {
            tool_use_id,
            output_preview,
            is_error,
            ..
        } => {
            assert_eq!(tool_use_id.as_deref(), Some("tc-002"));
            let output = output_preview.as_deref().expect("run_command output");
            assert!(output.contains("$ cargo test"), "{output}");
            assert!(output.contains("error: test failed"), "{output}");
            // exit_code 101 AND CORTEX_STEP_STATUS_ERROR both say "failed".
            assert!(is_error);
        }
        other => panic!("expected the run_command result, got {other:?}"),
    }

    // ── MCP dispatch ───────────────────────────────────────────────────────
    // Every MCP call arrives under the `call_mcp_tool` sentinel with the real
    // identity buried in a PascalCase envelope — on the planner's announcement
    // (which is what builds this card) as well as on the executing step.
    // Projected verbatim, every MCP call in a session is named "call_mcp_tool"
    // and none of codeg's MCP-aware cards can match it. The server does not
    // ship that shape to ACP clients either, so this mirrors its own rewrite.
    match &blocks[6] {
        ContentBlock::ToolUse {
            tool_use_id,
            tool_name,
            input_preview,
            ..
        } => {
            assert_eq!(tool_use_id.as_deref(), Some("tc-003"));
            assert_eq!(tool_name, "codeg-mcp_delegate_to_agent");
            let input = input_preview.as_deref().expect("mcp input");
            // `{"arguments": {…}}` is the wrapper key every codeg card peels;
            // the raw `Arguments`/`ServerName`/`ToolName` envelope is a shape
            // none of them can read.
            assert_eq!(
                input,
                r#"{"arguments":{"agent_type":"codex","task":"run pnpm build"},"prompt":"Delegating pnpm build to Codex CLI"}"#
            );
        }
        other => panic!("expected the unwrapped MCP call, got {other:?}"),
    }
    match &blocks[7] {
        ContentBlock::ToolResult {
            tool_use_id,
            output_preview,
            is_error,
            ..
        } => {
            assert_eq!(tool_use_id.as_deref(), Some("tc-003"));
            assert!(output_preview
                .as_deref()
                .is_some_and(|out| out.contains("Delegation successful")));
            assert!(!is_error);
        }
        other => panic!("expected the MCP result, got {other:?}"),
    }

    // ── a tool the Go harness ran itself ───────────────────────────────────
    // `agency_tool_call` is a generic envelope carrying the response as a
    // packed `google.protobuf.Any`, so the same tool can arrive either through
    // its own step arm or through here depending on which side executed it.
    match &blocks[8] {
        ContentBlock::ToolUse {
            tool_use_id,
            tool_name,
            ..
        } => {
            assert_eq!(tool_use_id.as_deref(), Some("tc-004"));
            assert_eq!(tool_name, "view_file");
        }
        other => panic!("expected the harness view_file call, got {other:?}"),
    }
    match &blocks[9] {
        ContentBlock::ToolResult {
            tool_use_id,
            output_preview,
            ..
        } => {
            assert_eq!(tool_use_id.as_deref(), Some("tc-004"));
            // Unwrapped from the harness's `{"result": …}` envelope.
            assert_eq!(output_preview.as_deref(), Some("harness read the file"));
        }
        other => panic!("expected the harness view_file result, got {other:?}"),
    }

    // ── a step arm codeg does not model ────────────────────────────────────
    // It still has to SETTLE. A `ToolUse` with no matching `ToolResult` adapts
    // to `input-available` and renders as a spinner — and nothing will ever
    // finish it, because a persisted transcript has no live channel behind it.
    match &blocks[10] {
        ContentBlock::ToolUse {
            tool_use_id,
            tool_name,
            ..
        } => {
            assert_eq!(tool_use_id.as_deref(), Some("tc-005"));
            assert_eq!(tool_name, "notify_user");
        }
        other => panic!("expected the unmodelled call, got {other:?}"),
    }
    match &blocks[11] {
        ContentBlock::ToolResult {
            tool_use_id,
            output_preview,
            is_error,
            ..
        } => {
            assert_eq!(tool_use_id.as_deref(), Some("tc-005"));
            assert_eq!(output_preview.as_deref(), None);
            assert!(!is_error);
        }
        other => panic!("expected a settling result, got {other:?}"),
    }
    assert_eq!(blocks.len(), 12, "no stray blocks: {blocks:?}");

    // That last step also carries `task_details` (tag 148) and a packed `Any`
    // in `attachments` (tag 155) — real fields codeg deliberately does not
    // model. Reaching this line at all means they were skipped by wire type
    // rather than derailing the decode.

    // Per-step usage sums into the turn; the window gauge takes only the
    // latest step's input side, so it must be the 4 200 + 61 000 of the single
    // step that reported usage, never a running total.
    let usage = assistant.usage.as_ref().expect("usage");
    assert_eq!(usage.input_tokens, 4_200);
    assert_eq!(usage.output_tokens, 350);
    assert_eq!(usage.cache_read_input_tokens, 61_000);
    assert_eq!(usage.cache_creation_input_tokens, 120);
    let stats = detail.session_stats.expect("session stats");
    assert_eq!(stats.context_window_used_tokens, Some(65_200));
}
