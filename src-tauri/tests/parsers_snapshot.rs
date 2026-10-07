//! Integration snapshot tests for the agent parsers.
//!
//! Each test materializes a minimal on-disk fixture under a `tempfile::tempdir`,
//! constructs the parser with `with_base_dir(...)`, and compares the
//! `list_conversations` + `get_conversation` outputs against committed `.snap`
//! files via `insta::assert_json_snapshot!`.
//!
//! Why redact timestamps: a few parser code paths fall back to `Utc::now()` when
//! a JSON value is missing a timestamp. Redacting `started_at`/`ended_at`/
//! `timestamp`/`completed_at` everywhere keeps snapshots stable even if such a
//! fallback fires unexpectedly.

use std::fs;
use std::path::Path;

use codeg_lib::parsers::{
    claude::ClaudeParser, cline::ClineParser, codex::CodexParser, gemini::GeminiParser,
    hermes::HermesParser, kimi_code::KimiCodeParser, openclaw::OpenClawParser,
    opencode::OpenCodeParser, AgentParser,
};
use insta::assert_json_snapshot;
use serde_json::json;

fn write(path: &Path, contents: &str) {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).expect("create parent dir");
    }
    fs::write(path, contents).expect("write fixture file");
}

// ────────────────────────────────────────────────────────────────────────────
// Claude
// ────────────────────────────────────────────────────────────────────────────

#[test]
fn claude_minimal_session_snapshot() {
    let temp = tempfile::tempdir().expect("create tempdir");
    let base = temp.path().to_path_buf();
    // Claude stores conversations under `<base>/<encoded-folder>/<id>.jsonl`.
    let project_dir = base.join("-tmp-demo");
    let session_id = "claude-sess-001";
    let jsonl = format!(
        "{}\n{}\n",
        json!({
            "type": "user",
            "sessionId": session_id,
            "timestamp": "2026-03-01T10:00:00Z",
            "uuid": "u1",
            "cwd": "/tmp/demo",
            "gitBranch": "main",
            "message": { "content": [{"type": "text", "text": "hello"}] }
        }),
        json!({
            "type": "assistant",
            "sessionId": session_id,
            "timestamp": "2026-03-01T10:00:02Z",
            "uuid": "a1",
            "message": {
                "model": "claude-sonnet-4-6",
                "content": [{"type": "text", "text": "world"}],
                "usage": {
                    "input_tokens": 1000,
                    "output_tokens": 200,
                    "cache_creation_input_tokens": 300,
                    "cache_read_input_tokens": 400
                }
            }
        }),
    );
    write(&project_dir.join(format!("{session_id}.jsonl")), &jsonl);

    let parser = ClaudeParser::with_base_dir(base);
    let summaries = parser.list_conversations().expect("list claude");
    let detail = parser.get_conversation(session_id).expect("detail claude");

    assert_json_snapshot!("claude_list", summaries, {
        ".**.started_at" => "[ts]",
        ".**.ended_at" => "[ts]",
    });
    assert_json_snapshot!("claude_detail", detail, {
        ".**.started_at" => "[ts]",
        ".**.ended_at" => "[ts]",
        ".**.timestamp" => "[ts]",
        ".**.completed_at" => "[ts]",
    });
}

// ────────────────────────────────────────────────────────────────────────────
// Codex
// ────────────────────────────────────────────────────────────────────────────

#[test]
fn codex_minimal_session_snapshot() {
    let temp = tempfile::tempdir().expect("create tempdir");
    let base = temp.path().to_path_buf();
    let session_id = "codex-sess-001";
    // Codex walks `<base>/**/*.jsonl` and requires the filename to start with
    // `rollout-` (real Codex CLI naming convention) for both list and detail.
    let jsonl_path = base
        .join("2026")
        .join("03")
        .join(format!("rollout-{session_id}.jsonl"));
    let jsonl = format!(
        "{}\n{}\n{}\n{}\n",
        json!({
            "timestamp": "2026-03-01T10:00:00Z",
            "type": "session_meta",
            "payload": {
                "id": session_id,
                "cwd": "/tmp/demo",
                "cli_version": "0.1.0",
                "git": {"branch": "main"}
            }
        }),
        json!({
            "timestamp": "2026-03-01T10:00:00.500Z",
            "type": "turn_context",
            "payload": {"model": "gpt-5.1-codex"}
        }),
        json!({
            "timestamp": "2026-03-01T10:00:01Z",
            "type": "event_msg",
            "payload": {"type": "user_message", "message": "ping"}
        }),
        json!({
            "timestamp": "2026-03-01T10:00:02Z",
            "type": "event_msg",
            "payload": {"type": "agent_message", "message": "pong"}
        }),
    );
    write(&jsonl_path, &jsonl);

    let parser = CodexParser::with_base_dir(base);
    let summaries = parser.list_conversations().expect("list codex");
    let detail = parser.get_conversation(session_id).expect("detail codex");

    assert_json_snapshot!("codex_list", summaries, {
        ".**.started_at" => "[ts]",
        ".**.ended_at" => "[ts]",
    });
    assert_json_snapshot!("codex_detail", detail, {
        ".**.started_at" => "[ts]",
        ".**.ended_at" => "[ts]",
        ".**.timestamp" => "[ts]",
        ".**.completed_at" => "[ts]",
    });
}

// ────────────────────────────────────────────────────────────────────────────
// Gemini
// ────────────────────────────────────────────────────────────────────────────

#[test]
fn gemini_minimal_session_snapshot() {
    let temp = tempfile::tempdir().expect("create tempdir");
    let base = temp.path().to_path_buf();
    // Gemini layout: <base>/tmp/<project>/chats/session-*.json + .project_root
    let project_dir = base.join("tmp").join("codeg");
    let chats_dir = project_dir.join("chats");
    write(
        &project_dir.join(".project_root"),
        "/Users/test/workspace/demo",
    );
    let session_id = "gemini-sess-001";
    let content = serde_json::to_string_pretty(&json!({
        "sessionId": session_id,
        "projectHash": "abc",
        "startTime": "2026-03-02T04:30:00.000Z",
        "lastUpdated": "2026-03-02T04:30:02.000Z",
        "messages": [
            {
                "id": "u1",
                "timestamp": "2026-03-02T04:30:00.000Z",
                "type": "user",
                "content": [{"text": "ping"}]
            },
            {
                "id": "a1",
                "timestamp": "2026-03-02T04:30:02.000Z",
                "type": "gemini",
                "content": "pong",
                "tokens": {"input": 10, "output": 20, "cached": 3},
                "model": "gemini-2.5-pro"
            }
        ]
    }))
    .expect("serialize gemini fixture");
    write(
        &chats_dir.join(format!("session-2026-03-02T04-30-{session_id}.json")),
        &content,
    );

    let parser = GeminiParser::with_base_dir(base);
    let summaries = parser.list_conversations().expect("list gemini");
    let detail = parser.get_conversation(session_id).expect("detail gemini");

    assert_json_snapshot!("gemini_list", summaries, {
        ".**.started_at" => "[ts]",
        ".**.ended_at" => "[ts]",
    });
    assert_json_snapshot!("gemini_detail", detail, {
        ".**.started_at" => "[ts]",
        ".**.ended_at" => "[ts]",
        ".**.timestamp" => "[ts]",
        ".**.completed_at" => "[ts]",
    });
}

// ────────────────────────────────────────────────────────────────────────────
// OpenClaw
// ────────────────────────────────────────────────────────────────────────────

#[test]
fn openclaw_minimal_session_snapshot() {
    let temp = tempfile::tempdir().expect("create tempdir");
    let base = temp.path().to_path_buf();
    // Layout: <base>/<agent_id>/sessions/<session_id>.jsonl
    let agent_id = "test-agent";
    let session_id = "openclaw-sess-001";
    let conversation_id = format!("{agent_id}/{session_id}");
    let sessions_dir = base.join(agent_id).join("sessions");
    let jsonl = format!(
        "{}\n{}\n{}\n",
        json!({
            "type": "session",
            "version": 3,
            "id": session_id,
            "timestamp": "2026-03-17T01:00:00.000Z",
            "cwd": "/tmp/demo"
        }),
        json!({
            "type": "message",
            "id": "u1",
            "parentId": null,
            "timestamp": "2026-03-17T01:00:01.000Z",
            "message": {
                "role": "user",
                "content": [{"type": "text", "text": "Hello"}]
            }
        }),
        json!({
            "type": "message",
            "id": "a1",
            "parentId": "u1",
            "timestamp": "2026-03-17T01:00:02.000Z",
            "message": {
                "role": "assistant",
                "content": [{"type": "text", "text": "Hi"}],
                "model": "gpt-5.4",
                "usage": {"input": 100, "output": 50, "cacheRead": 200, "cacheWrite": 0, "totalTokens": 350}
            }
        }),
    );
    write(&sessions_dir.join(format!("{session_id}.jsonl")), &jsonl);

    let parser = OpenClawParser::with_base_dir(base);
    let summaries = parser.list_conversations().expect("list openclaw");
    let detail = parser
        .get_conversation(&conversation_id)
        .expect("detail openclaw");

    assert_json_snapshot!("openclaw_list", summaries, {
        ".**.started_at" => "[ts]",
        ".**.ended_at" => "[ts]",
    });
    assert_json_snapshot!("openclaw_detail", detail, {
        ".**.started_at" => "[ts]",
        ".**.ended_at" => "[ts]",
        ".**.timestamp" => "[ts]",
        ".**.completed_at" => "[ts]",
    });
}

// ────────────────────────────────────────────────────────────────────────────
// Cline
// ────────────────────────────────────────────────────────────────────────────

#[test]
fn cline_minimal_session_snapshot() {
    let temp = tempfile::tempdir().expect("create tempdir");
    let base = temp.path().to_path_buf();
    // Layout:
    //   <base>/state/taskHistory.json
    //   <base>/tasks/<id>/api_conversation_history.json
    //   <base>/tasks/<id>/task_metadata.json  (optional)
    //
    // Note: started_at is derived by parsing the entry id as a unix-ms
    // timestamp, so use a real timestamp string here.
    let task_id = "1740825600000"; // 2026-03-01T08:00:00Z in ms
    let history = json!([
        {
            "id": task_id,
            "ts": 1_740_825_602_000_i64,
            "task": "ping",
            "tokensIn": 10,
            "tokensOut": 20,
            "totalCost": 0.0,
            "cwdOnTaskInitialization": "/tmp/demo",
            "modelId": "claude-sonnet-4-6"
        }
    ]);
    write(
        &base.join("state").join("taskHistory.json"),
        &serde_json::to_string(&history).unwrap(),
    );

    let api_history = json!([
        {
            "role": "user",
            "content": [{"type": "text", "text": "ping"}],
            "ts": 1_740_825_600_500_i64
        },
        {
            "role": "assistant",
            "content": [{"type": "text", "text": "pong"}],
            "ts": 1_740_825_601_500_i64,
            "modelInfo": {"modelId": "claude-sonnet-4-6"},
            "metrics": {"tokens": {"prompt": 10, "completion": 20, "cached": 3}}
        }
    ]);
    write(
        &base
            .join("tasks")
            .join(task_id)
            .join("api_conversation_history.json"),
        &serde_json::to_string(&api_history).unwrap(),
    );

    let parser = ClineParser::with_base_dir(base);
    let summaries = parser.list_conversations().expect("list cline");
    let detail = parser.get_conversation(task_id).expect("detail cline");

    assert_json_snapshot!("cline_list", summaries, {
        ".**.started_at" => "[ts]",
        ".**.ended_at" => "[ts]",
    });
    assert_json_snapshot!("cline_detail", detail, {
        ".**.started_at" => "[ts]",
        ".**.ended_at" => "[ts]",
        ".**.timestamp" => "[ts]",
        ".**.completed_at" => "[ts]",
    });
}

// ────────────────────────────────────────────────────────────────────────────
// OpenCode
// ────────────────────────────────────────────────────────────────────────────

/// OpenCode parser reads from a SeaORM-managed SQLite file. It does NOT import
/// the OpenCode CLI's migrations — it issues raw SELECTs against three tables
/// (`session`, `message`, `part`). So the test fixture just creates those
/// tables with the columns the parser actually queries and inserts a minimal
/// conversation.
///
/// `OpenCodeParser` builds its own current-thread runtime via `block_on` on
/// every call, so it's safe to drive from either `#[test]` (sync) or a
/// `#[tokio::test]`. We use sync here and spin up a local runtime only for
/// the async DB setup.
#[test]
fn opencode_minimal_session_snapshot() {
    use sea_orm::{ConnectionTrait, Database, DatabaseBackend, Statement};

    let temp = tempfile::tempdir().expect("create tempdir");
    let base = temp.path().to_path_buf();
    let db_path = base.join("opencode.db");
    let session_id = "oc-sess-001";

    // 2026-03-01T10:00:00Z in milliseconds.
    let t0: i64 = 1_772_020_800_000;
    let t_user_created = t0 + 500;
    let t_asst_created = t0 + 2_000;
    let t_asst_completed = t0 + 3_000;
    let t_updated = t0 + 4_000;

    // Build the fixture DB inside a one-off current-thread runtime.
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("build tokio runtime");
    rt.block_on(async {
        let conn = Database::connect(format!("sqlite:{}?mode=rwc", db_path.display()))
            .await
            .expect("open sqlite");

        for ddl in [
            "CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT, parent_id TEXT, \
             title TEXT, time_created INTEGER, time_updated INTEGER)",
            "CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, \
             time_created INTEGER, data TEXT)",
            "CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, \
             time_created INTEGER, data TEXT)",
        ] {
            conn.execute(Statement::from_string(DatabaseBackend::Sqlite, ddl))
                .await
                .expect("create table");
        }

        // Session row.
        conn.execute(Statement::from_sql_and_values(
            DatabaseBackend::Sqlite,
            "INSERT INTO session (id, directory, title, time_created, time_updated) \
             VALUES (?, ?, ?, ?, ?)",
            [
                session_id.into(),
                "/tmp/demo".into(),
                "OpenCode demo session".into(),
                t0.into(),
                t_updated.into(),
            ],
        ))
        .await
        .expect("insert session");

        // User message.
        let user_data = json!({
            "role": "user",
            "time": { "created": t_user_created },
        })
        .to_string();
        conn.execute(Statement::from_sql_and_values(
            DatabaseBackend::Sqlite,
            "INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)",
            [
                "m-user".into(),
                session_id.into(),
                t_user_created.into(),
                user_data.into(),
            ],
        ))
        .await
        .expect("insert user message");

        // Assistant message with usage + completion.
        let asst_data = json!({
            "role": "assistant",
            "modelID": "claude-sonnet-4-6",
            "time": { "created": t_asst_created, "completed": t_asst_completed },
            "tokens": {
                "input": 12,
                "output": 15,
                "cache": { "read": 0, "write": 0 },
            },
        })
        .to_string();
        conn.execute(Statement::from_sql_and_values(
            DatabaseBackend::Sqlite,
            "INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)",
            [
                "m-asst".into(),
                session_id.into(),
                t_asst_created.into(),
                asst_data.into(),
            ],
        ))
        .await
        .expect("insert assistant message");

        // Text parts for each message.
        for (pid, mid, t, text) in [
            ("p-user-text", "m-user", t_user_created, "hello opencode"),
            ("p-asst-text", "m-asst", t_asst_created + 500, "world!"),
        ] {
            let data = json!({ "type": "text", "text": text }).to_string();
            conn.execute(Statement::from_sql_and_values(
                DatabaseBackend::Sqlite,
                "INSERT INTO part (id, message_id, time_created, data) VALUES (?, ?, ?, ?)",
                [pid.into(), mid.into(), t.into(), data.into()],
            ))
            .await
            .expect("insert part");
        }
    });

    let parser = OpenCodeParser::with_base_dir(base);
    let conversations = parser.list_conversations().expect("list conversations");
    assert_json_snapshot!("opencode_list", conversations, {
        ".**.started_at" => "[ts]",
        ".**.ended_at" => "[ts]",
    });

    let detail = parser
        .get_conversation(session_id)
        .expect("get conversation");
    assert_json_snapshot!("opencode_detail", detail, {
        ".**.started_at" => "[ts]",
        ".**.ended_at" => "[ts]",
        ".**.timestamp" => "[ts]",
        ".**.completed_at" => "[ts]",
    });
}

/// Tool calls captured verbatim from a real opencode 1.18.14 run: OpenCode
/// spells its arguments in camelCase (`filePath`, `oldString`), keeps a failed
/// call's message in `state.error` rather than `state.output`, wraps `read`
/// results in an XML envelope with `N: ` line prefixes, and returns the whole
/// SKILL.md inside `<skill_content>`. This pins the rewrite onto codeg's shared
/// tool vocabulary, plus the sub-agent session nesting via `session.parent_id`.
#[test]
fn opencode_tool_call_session_snapshot() {
    use sea_orm::{ConnectionTrait, Database, DatabaseBackend, Statement};

    let temp = tempfile::tempdir().expect("create tempdir");
    let base = temp.path().to_path_buf();
    let db_path = base.join("opencode.db");
    let session_id = "oc-tools-001";
    let child_session_id = "oc-tools-001-child";

    // 2026-03-01T10:00:00Z in milliseconds.
    let t0: i64 = 1_772_020_800_000;

    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("build tokio runtime");
    rt.block_on(async {
        let conn = Database::connect(format!("sqlite:{}?mode=rwc", db_path.display()))
            .await
            .expect("open sqlite");

        for ddl in [
            "CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT, parent_id TEXT, \
             title TEXT, time_created INTEGER, time_updated INTEGER)",
            "CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, \
             time_created INTEGER, data TEXT)",
            "CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, \
             time_created INTEGER, data TEXT)",
        ] {
            conn.execute(Statement::from_string(DatabaseBackend::Sqlite, ddl))
                .await
                .expect("create table");
        }

        for (id, parent, title) in [
            (session_id, None, "OpenCode tool session"),
            (
                child_session_id,
                Some(session_id),
                "Inspect VERSION (@general subagent)",
            ),
        ] {
            conn.execute(Statement::from_sql_and_values(
                DatabaseBackend::Sqlite,
                "INSERT INTO session (id, directory, parent_id, title, time_created, \
                 time_updated) VALUES (?, ?, ?, ?, ?, ?)",
                [
                    id.into(),
                    "/tmp/demo".into(),
                    parent.into(),
                    title.into(),
                    t0.into(),
                    (t0 + 9_000).into(),
                ],
            ))
            .await
            .expect("insert session");
        }

        for (mid, sid, offset, data) in [
            (
                "m-tools-user",
                session_id,
                500_i64,
                json!({ "role": "user", "time": { "created": t0 + 500 } }),
            ),
            (
                "m-tools-asst",
                session_id,
                1_000,
                json!({
                    "role": "assistant",
                    "modelID": "claude-sonnet-4-6",
                    "time": { "created": t0 + 1_000, "completed": t0 + 8_000 },
                    "tokens": { "input": 400, "output": 340, "cache": { "read": 800, "write": 0 } },
                }),
            ),
            (
                "m-child-user",
                child_session_id,
                2_000,
                json!({ "role": "user", "time": { "created": t0 + 2_000 } }),
            ),
        ] {
            conn.execute(Statement::from_sql_and_values(
                DatabaseBackend::Sqlite,
                "INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)",
                [
                    mid.into(),
                    sid.into(),
                    (t0 + offset).into(),
                    data.to_string().into(),
                ],
            ))
            .await
            .expect("insert message");
        }

        let parts = [
            ("p-01", "m-tools-user", json!({ "type": "text", "text": "polish the greeting" })),
            ("p-02", "m-tools-asst", json!({ "type": "text", "text": "Loading the skill." })),
            ("p-03", "m-tools-asst", json!({
                "type": "tool", "tool": "skill", "callID": "call_skill",
                "state": {
                    "status": "completed",
                    "input": { "name": "demo-skill" },
                    "output": "<skill_content name=\"demo-skill\">\n# Skill: demo-skill\n\n1. Read the target file.\n2. Apply the change.\n\nBase directory for this skill: /cfg/skills/demo-skill\nNote: file list is sampled.\n\n<skill_files>\n<file>/cfg/skills/demo-skill/run.sh</file>\n</skill_files>\n</skill_content>",
                    "title": "Loaded skill: demo-skill",
                    "metadata": { "name": "demo-skill", "dir": "/cfg/skills/demo-skill" },
                    "time": { "start": t0 + 1_100, "end": t0 + 1_200 },
                },
            })),
            ("p-04", "m-tools-asst", json!({
                "type": "tool", "tool": "read", "callID": "call_read",
                "state": {
                    "status": "completed",
                    "input": { "filePath": "src/app.ts" },
                    "output": "<path>/tmp/demo/src/app.ts</path>\n<type>file</type>\n<content>\n1: export function greet(name: string) {\n2:   return `hello ${name}`\n3: }\n\n(End of file - total 3 lines)\n</content>",
                    "metadata": {
                        "preview": "export function greet(name: string) {",
                        "display": {
                            "type": "file",
                            "path": "/tmp/demo/src/app.ts",
                            "text": "export function greet(name: string) {\n  return `hello ${name}`\n}",
                            "lineStart": 1,
                            "lineEnd": 3,
                            "totalLines": 3,
                        },
                    },
                    "title": "src/app.ts",
                    "time": { "start": t0 + 1_300, "end": t0 + 1_400 },
                },
            })),
            ("p-05", "m-tools-asst", json!({
                "type": "tool", "tool": "edit", "callID": "call_edit",
                "state": {
                    "status": "completed",
                    "input": {
                        "filePath": "src/app.ts",
                        "oldString": "hello ${name}",
                        "newString": "Hello, ${name}!",
                    },
                    "output": "Edit applied successfully.",
                    "metadata": {
                        "diagnostics": {},
                        "diff": "Index: /tmp/demo/src/app.ts\n===================================================================\n--- /tmp/demo/src/app.ts\n+++ /tmp/demo/src/app.ts\n@@ -2,1 +2,1 @@\n-  return `hello ${name}`\n+  return `Hello, ${name}!`\n",
                        "filediff": {
                            "file": "/tmp/demo/src/app.ts",
                            "patch": "…",
                            "additions": 1,
                            "deletions": 1,
                        },
                    },
                    "title": "src/app.ts",
                    "time": { "start": t0 + 1_500, "end": t0 + 1_600 },
                },
            })),
            ("p-06", "m-tools-asst", json!({
                "type": "tool", "tool": "write", "callID": "call_write",
                "state": {
                    "status": "completed",
                    "input": { "filePath": "src/new.ts", "content": "export const A = 1\n" },
                    "output": "Wrote file successfully.",
                    "metadata": { "filepath": "/tmp/demo/src/new.ts", "exists": false },
                    "title": "src/new.ts",
                    "time": { "start": t0 + 1_700, "end": t0 + 1_800 },
                },
            })),
            ("p-07", "m-tools-asst", json!({
                "type": "tool", "tool": "grep", "callID": "call_grep",
                "state": {
                    "status": "completed",
                    "input": { "pattern": "VERSION", "path": ".", "include": "*.ts" },
                    "output": "Found 1 matches",
                    "metadata": { "matches": 1 },
                    "title": "VERSION",
                    "time": { "start": t0 + 1_900, "end": t0 + 2_000 },
                },
            })),
            ("p-08", "m-tools-asst", json!({
                "type": "tool", "tool": "task", "callID": "call_task",
                "state": {
                    "status": "completed",
                    "input": {
                        "subagent_type": "general",
                        "description": "Inspect VERSION",
                        "prompt": "Find the VERSION constant and report it.",
                    },
                    "output": "<task id=\"oc-tools-001-child\" state=\"completed\">\n<task_result>\nVERSION is 1.0.0\n</task_result>\n</task>",
                    "metadata": {
                        "sessionId": child_session_id,
                        "model": { "modelID": "claude-sonnet-4-6", "providerID": "anthropic" },
                    },
                    "title": "Inspect VERSION",
                    "time": { "start": t0 + 2_100, "end": t0 + 2_600 },
                },
            })),
            // Failure: the message lives in `state.error`, never `state.output`.
            ("p-09", "m-tools-asst", json!({
                "type": "tool", "tool": "edit", "callID": "call_edit_fail",
                "state": {
                    "status": "error",
                    "input": { "filePath": "src/missing.ts", "oldString": "nope", "newString": "yep" },
                    "error": "File /tmp/demo/src/missing.ts not found",
                    "time": { "start": t0 + 2_700, "end": t0 + 2_800 },
                },
            })),
            // OpenCode's own UI hides `patch` alongside step-start/step-finish.
            ("p-10", "m-tools-asst", json!({
                "type": "patch", "hash": "abc123", "files": ["/tmp/demo/src/app.ts"],
            })),
            ("p-11", "m-tools-asst", json!({
                "type": "step-finish",
                "reason": "stop",
                "tokens": { "total": 1540, "input": 400, "output": 340, "reasoning": 0,
                            "cache": { "read": 800, "write": 0 } },
            })),
            ("p-12", "m-child-user", json!({
                "type": "text", "text": "Find the VERSION constant and report it.",
            })),
            // Child-session tool calls surface as `agent_stats.tool_calls`
            // rows on the parent's Agent card (batch_load_subagent_tool_calls)
            // and must go through the same normalization: canonical snake_case
            // input, and `state.error` recovered for failures.
            ("p-13", "m-child-user", json!({
                "type": "tool", "tool": "edit", "callID": "call_child_edit",
                "state": {
                    "status": "completed",
                    "input": {
                        "filePath": "src/app.ts",
                        "oldString": "  VERSION = \"1.0.0\"\n",
                        "newString": "  VERSION = \"1.0.1\"\n",
                    },
                    "output": "Edit applied successfully.",
                    "title": "src/app.ts",
                    "time": { "start": t0 + 2_200, "end": t0 + 2_300 },
                },
            })),
            ("p-14", "m-child-user", json!({
                "type": "tool", "tool": "read", "callID": "call_child_read_fail",
                "state": {
                    "status": "error",
                    "input": { "filePath": "src/gone.ts" },
                    "error": "File not found: /tmp/demo/src/gone.ts",
                    "time": { "start": t0 + 2_400, "end": t0 + 2_500 },
                },
            })),
        ];

        for (i, (pid, mid, data)) in parts.iter().enumerate() {
            conn.execute(Statement::from_sql_and_values(
                DatabaseBackend::Sqlite,
                "INSERT INTO part (id, message_id, time_created, data) VALUES (?, ?, ?, ?)",
                [
                    (*pid).into(),
                    (*mid).into(),
                    (t0 + 1_000 + i as i64).into(),
                    data.to_string().into(),
                ],
            ))
            .await
            .expect("insert part");
        }
    });

    let parser = OpenCodeParser::with_base_dir(base);
    let conversations = parser.list_conversations().expect("list conversations");
    assert_json_snapshot!("opencode_tools_list", conversations, {
        ".**.started_at" => "[ts]",
        ".**.ended_at" => "[ts]",
    });

    let detail = parser
        .get_conversation(session_id)
        .expect("get conversation");
    assert_json_snapshot!("opencode_tools_detail", detail, {
        ".**.started_at" => "[ts]",
        ".**.ended_at" => "[ts]",
        ".**.timestamp" => "[ts]",
        ".**.completed_at" => "[ts]",
    });
}

/// The record shapes OpenCode writes AROUND the conversation, all verified
/// against a real `~/.local/share/opencode/opencode.db` (430 sessions, 12 804
/// parts):
///
///   - `synthetic` text — plan/build switch reminders and the post-compaction
///     continuation OpenCode injects into the USER message for the model's
///     benefit. Its own CLI filters them out of the transcript, and a message
///     left with nothing else is not a turn the user took;
///   - `compaction` parts, which are the sole part of their message, so the
///     compaction previously showed as an empty user bubble;
///   - an assistant `error`, whose message carries the only record of a turn
///     the provider rejected or the user cancelled;
///   - the `question` tool's positional `metadata.answers`.
#[test]
fn opencode_session_edges_snapshot() {
    use sea_orm::{ConnectionTrait, Database, DatabaseBackend, Statement};

    let temp = tempfile::tempdir().expect("create tempdir");
    let base = temp.path().to_path_buf();
    let db_path = base.join("opencode.db");
    let session_id = "oc-edges-001";

    // 2026-03-01T10:00:00Z in milliseconds.
    let t0: i64 = 1_772_020_800_000;

    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("build tokio runtime");
    rt.block_on(async {
        let conn = Database::connect(format!("sqlite:{}?mode=rwc", db_path.display()))
            .await
            .expect("open sqlite");

        for ddl in [
            "CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT, parent_id TEXT, \
             title TEXT, time_created INTEGER, time_updated INTEGER)",
            "CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, \
             time_created INTEGER, data TEXT)",
            "CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, \
             time_created INTEGER, data TEXT)",
        ] {
            conn.execute(Statement::from_string(DatabaseBackend::Sqlite, ddl))
                .await
                .expect("create table");
        }

        conn.execute(Statement::from_sql_and_values(
            DatabaseBackend::Sqlite,
            "INSERT INTO session (id, directory, title, time_created, time_updated) \
             VALUES (?, ?, ?, ?, ?)",
            [
                session_id.into(),
                "/tmp/demo".into(),
                "OpenCode session edges".into(),
                t0.into(),
                (t0 + 9_000).into(),
            ],
        ))
        .await
        .expect("insert session");

        for (mid, offset, data) in [
            // A real prompt with a reminder appended to the same message.
            (
                "m-user-mixed",
                500_i64,
                json!({ "role": "user", "time": { "created": t0 + 500 } }),
            ),
            // Nothing but the reminder: not a turn the user took.
            (
                "m-user-synthetic",
                1_000,
                json!({ "role": "user", "time": { "created": t0 + 1_000 } }),
            ),
            // The compaction boundary's own (synthetic) user message.
            (
                "m-user-compaction",
                1_500,
                json!({ "role": "user", "time": { "created": t0 + 1_500 } }),
            ),
            // A question answered in OpenCode's own TUI.
            (
                "m-asst-question",
                2_000,
                json!({
                    "role": "assistant",
                    "modelID": "claude-sonnet-4-6",
                    "time": { "created": t0 + 2_000, "completed": t0 + 2_400 },
                    "tokens": { "input": 10, "output": 4, "cache": { "read": 0, "write": 0 } },
                }),
            ),
            // A turn the provider rejected: no parts at all, only the error.
            (
                "m-asst-error",
                3_000,
                json!({
                    "role": "assistant",
                    "modelID": "claude-sonnet-4-6",
                    "time": { "created": t0 + 3_000, "completed": t0 + 3_100 },
                    "tokens": { "input": 3, "output": 0, "cache": { "read": 0, "write": 0 } },
                    "error": {
                        "name": "APIError",
                        "data": { "message": "Invalid Authentication" }
                    },
                }),
            ),
            // …and one the user stopped.
            (
                "m-asst-aborted",
                4_000,
                json!({
                    "role": "assistant",
                    "modelID": "claude-sonnet-4-6",
                    "time": { "created": t0 + 4_000, "completed": t0 + 4_100 },
                    "tokens": { "input": 2, "output": 0, "cache": { "read": 0, "write": 0 } },
                    "error": {
                        "name": "MessageAbortedError",
                        "data": { "message": "The operation was aborted." }
                    },
                }),
            ),
        ] {
            conn.execute(Statement::from_sql_and_values(
                DatabaseBackend::Sqlite,
                "INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)",
                [
                    mid.into(),
                    session_id.into(),
                    (t0 + offset).into(),
                    data.to_string().into(),
                ],
            ))
            .await
            .expect("insert message");
        }

        for (i, (pid, mid, data)) in [
            (
                "p-user-real",
                "m-user-mixed",
                json!({ "type": "text", "text": "ship the release notes" }),
            ),
            (
                "p-user-reminder",
                "m-user-mixed",
                json!({
                    "type": "text",
                    "synthetic": true,
                    "text": "You are now in build mode. You can edit files."
                }),
            ),
            (
                "p-user-only-reminder",
                "m-user-synthetic",
                json!({
                    "type": "text",
                    "synthetic": true,
                    "text": "Summarize the task tool output above and continue with your task."
                }),
            ),
            (
                "p-compaction",
                "m-user-compaction",
                json!({ "type": "compaction", "auto": true }),
            ),
            (
                "p-question",
                "m-asst-question",
                json!({
                    "type": "tool",
                    "tool": "question",
                    "callID": "question:2",
                    "state": {
                        "status": "completed",
                        "input": {
                            "questions": [{
                                "question": "Ship it now?",
                                "header": "Release",
                                "multiple": false,
                                "options": [
                                    { "label": "Yes", "description": "Publish" },
                                    { "label": "Not yet", "description": "Hold" }
                                ]
                            }]
                        },
                        "output": "User has answered your questions: \"Ship it now?\"=\"Not yet\". You can now continue with the user's answers in mind.",
                        "title": "Asked 1 question",
                        "metadata": { "answers": [["Not yet"]], "truncated": false },
                        "time": { "start": t0 + 2_100, "end": t0 + 2_300 }
                    }
                }),
            ),
        ]
        .into_iter()
        .enumerate()
        {
            conn.execute(Statement::from_sql_and_values(
                DatabaseBackend::Sqlite,
                "INSERT INTO part (id, message_id, time_created, data) VALUES (?, ?, ?, ?)",
                [
                    pid.into(),
                    mid.into(),
                    (t0 + 1_000 + i as i64).into(),
                    data.to_string().into(),
                ],
            ))
            .await
            .expect("insert part");
        }
    });

    let parser = OpenCodeParser::with_base_dir(base);
    let detail = parser
        .get_conversation(session_id)
        .expect("get conversation");
    assert_json_snapshot!("opencode_edges_detail", detail, {
        ".**.started_at" => "[ts]",
        ".**.ended_at" => "[ts]",
        ".**.timestamp" => "[ts]",
        ".**.completed_at" => "[ts]",
    });
}

/// OpenCode names a session `New session - <ISO>` at creation and is supposed to
/// replace that on the first turn — but the rename is forked and its errors
/// swallowed, so an unreachable small model leaves the placeholder as the
/// session's name forever (243 of the 432 sessions in the author's store, every
/// root session created since 2026-06-17). Both summary queries substitute the
/// opening user message instead, the way OpenCode's own TUI does.
///
/// Exercises the correlated subquery rather than `resolve_title` alone: the
/// `synthetic` filter and the ordering only exist in SQL, and a session whose
/// first part is an injected reminder is exactly the case that would otherwise
/// name the row after text nobody typed.
#[test]
fn opencode_placeholder_titles_fall_back_to_the_opening_message() {
    use sea_orm::{ConnectionTrait, Database, DatabaseBackend, Statement};

    let temp = tempfile::tempdir().expect("create tempdir");
    let base = temp.path().to_path_buf();
    let db_path = base.join("opencode.db");
    let t0: i64 = 1_772_020_800_000;

    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("build tokio runtime");
    rt.block_on(async {
        let conn = Database::connect(format!("sqlite:{}?mode=rwc", db_path.display()))
            .await
            .expect("open sqlite");

        for ddl in [
            "CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT, parent_id TEXT, \
             title TEXT, time_created INTEGER, time_updated INTEGER)",
            "CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, \
             time_created INTEGER, data TEXT)",
            "CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, \
             time_created INTEGER, data TEXT)",
        ] {
            conn.execute(Statement::from_string(DatabaseBackend::Sqlite, ddl))
                .await
                .expect("create table");
        }

        // (session id, stored title, opening user text, whether that text is a
        // synthetic injection the transcript also drops)
        let sessions = [
            (
                "oc-placeholder",
                "New session - 2026-03-01T10:00:00.000Z",
                "执行一下 pnpm build",
                false,
            ),
            (
                "oc-fork",
                "New session - 2026-03-01T10:00:00.000Z (fork #2)",
                "look at [notes.md](file:///tmp/a/very/long/path/notes.md)",
                false,
            ),
            ("oc-named", "Fix the login flow", "hi", false),
            (
                "oc-synthetic-only",
                "New session - 2026-03-01T10:00:00.000Z",
                "<system-reminder>switched to build mode</system-reminder>",
                true,
            ),
        ];

        for (i, (session_id, title, text, synthetic)) in sessions.iter().enumerate() {
            let created = t0 + i as i64 * 1_000;
            conn.execute(Statement::from_sql_and_values(
                DatabaseBackend::Sqlite,
                "INSERT INTO session (id, directory, title, time_created, time_updated) \
                 VALUES (?, ?, ?, ?, ?)",
                [
                    (*session_id).into(),
                    "/tmp/demo".into(),
                    (*title).into(),
                    created.into(),
                    created.into(),
                ],
            ))
            .await
            .expect("insert session");

            let message_id = format!("m-{session_id}");
            conn.execute(Statement::from_sql_and_values(
                DatabaseBackend::Sqlite,
                "INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)",
                [
                    message_id.clone().into(),
                    (*session_id).into(),
                    created.into(),
                    json!({ "role": "user", "time": { "created": created } })
                        .to_string()
                        .into(),
                ],
            ))
            .await
            .expect("insert message");

            let mut part = json!({ "type": "text", "text": text });
            if *synthetic {
                part["synthetic"] = json!(true);
            }
            conn.execute(Statement::from_sql_and_values(
                DatabaseBackend::Sqlite,
                "INSERT INTO part (id, message_id, time_created, data) VALUES (?, ?, ?, ?)",
                [
                    format!("p-{session_id}").into(),
                    message_id.into(),
                    created.into(),
                    part.to_string().into(),
                ],
            ))
            .await
            .expect("insert part");
        }
    });

    let parser = OpenCodeParser::with_base_dir(base);
    let titles: std::collections::HashMap<String, Option<String>> = parser
        .list_conversations()
        .expect("list conversations")
        .into_iter()
        .map(|c| (c.id, c.title))
        .collect();

    assert_eq!(
        titles["oc-placeholder"].as_deref(),
        Some("执行一下 pnpm build")
    );
    // The fork marker survives — it is the only thing telling the fork apart
    // from the session it came from — while the placeholder under it does not.
    // The message itself is folded the way every other derived title is.
    assert_eq!(
        titles["oc-fork"].as_deref(),
        Some("look at notes.md (fork #2)")
    );
    assert_eq!(titles["oc-named"].as_deref(), Some("Fix the login flow"));
    // Only synthetic text to go on: report untitled so the UI shows its own
    // label rather than naming the row after a reminder nobody typed.
    assert_eq!(titles["oc-synthetic-only"], None);

    // The single-session query has to agree with the listing, or a row renames
    // itself the moment it is opened.
    let detail = parser
        .get_conversation("oc-placeholder")
        .expect("get conversation");
    assert_eq!(detail.summary.title.as_deref(), Some("执行一下 pnpm build"));
}

// ────────────────────────────────────────────────────────────────────────────
// Hermes (reads ~/.hermes/state.db via sea-orm)
// ────────────────────────────────────────────────────────────────────────────

async fn hermes_exec(conn: &sea_orm::DatabaseConnection, sql: &str, values: Vec<sea_orm::Value>) {
    use sea_orm::ConnectionTrait;
    conn.execute(sea_orm::Statement::from_sql_and_values(
        sea_orm::DatabaseBackend::Sqlite,
        sql,
        values,
    ))
    .await
    .expect("exec sql");
}

#[allow(clippy::too_many_arguments)]
async fn hermes_ins_session(
    conn: &sea_orm::DatabaseConnection,
    id: &str,
    model_config: &str,
    cwd: &str,
    title: &str,
    started_at: f64,
    ended_at: f64,
    archived: i64,
    input_tokens: i64,
    output_tokens: i64,
) {
    hermes_exec(
        conn,
        "INSERT INTO sessions (id, source, model, model_config, parent_session_id, \
         started_at, ended_at, cwd, title, archived, input_tokens, output_tokens, \
         cache_read_tokens, cache_write_tokens) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        vec![
            id.into(),
            "acp".into(),
            "gpt-5.5".into(),
            model_config.into(),
            "".into(),
            started_at.into(),
            ended_at.into(),
            cwd.into(),
            title.into(),
            archived.into(),
            input_tokens.into(),
            output_tokens.into(),
            0i64.into(),
            0i64.into(),
        ],
    )
    .await;
}

#[allow(clippy::too_many_arguments)]
async fn hermes_ins_msg(
    conn: &sea_orm::DatabaseConnection,
    session_id: &str,
    role: &str,
    content: String,
    tool_call_id: &str,
    tool_calls: &str,
    tool_name: &str,
    reasoning_content: &str,
    ts: f64,
    finish_reason: &str,
    active: i64,
) {
    hermes_exec(
        conn,
        "INSERT INTO messages (session_id, role, content, tool_call_id, tool_calls, \
         tool_name, reasoning, reasoning_content, timestamp, finish_reason, active) \
         VALUES (?,?,?,?,?,?,?,?,?,?,?)",
        vec![
            session_id.into(),
            role.into(),
            content.into(),
            tool_call_id.into(),
            tool_calls.into(),
            tool_name.into(),
            "".into(),
            reasoning_content.into(),
            ts.into(),
            finish_reason.into(),
            active.into(),
        ],
    )
    .await;
}

/// Builds a `state.db` fixture covering Hermes-specific shapes and asserts both
/// `list_conversations` and `get_conversation`:
/// - `cwd` resolved from `model_config` JSON (the `cwd` column is empty)
/// - REAL epoch-**seconds** timestamps
/// - assistant `reasoning_content` → Thinking, then text, then two `tool_calls`
///   (one `arguments` string, one object) → ToolUse, with the two `role="tool"`
///   result rows folded back into the assistant turn
/// - multimodal user `content` (NUL-sentinel JSON: text + data-URI image)
/// - an `active = 0` (rewound) row excluded; a `system` row skipped
/// - an `archived = 1` session and an empty session excluded from the list
#[test]
fn hermes_minimal_session_snapshot() {
    use sea_orm::{ConnectionTrait, Database, DatabaseBackend, Statement};

    let temp = tempfile::tempdir().expect("create tempdir");
    let base = temp.path().to_path_buf();
    let db_path = base.join("state.db");
    let session_id = "hermes-sess-001";

    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("build tokio runtime");
    rt.block_on(async {
        let conn = Database::connect(format!("sqlite:{}?mode=rwc", db_path.display()))
            .await
            .expect("open sqlite");

        for ddl in [
            "CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT, model TEXT, \
             model_config TEXT, parent_session_id TEXT, started_at REAL, ended_at REAL, \
             cwd TEXT, title TEXT, archived INTEGER DEFAULT 0, input_tokens INTEGER, \
             output_tokens INTEGER, cache_read_tokens INTEGER, cache_write_tokens INTEGER)",
            "CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, \
             role TEXT, content TEXT, tool_call_id TEXT, tool_calls TEXT, tool_name TEXT, \
             reasoning TEXT, reasoning_content TEXT, timestamp REAL, finish_reason TEXT, \
             active INTEGER DEFAULT 1)",
        ] {
            conn.execute(Statement::from_string(DatabaseBackend::Sqlite, ddl))
                .await
                .expect("create table");
        }

        let t0 = 1_780_980_974.022845_f64;

        // Primary session: cwd column empty → resolved from model_config JSON.
        hermes_ins_session(
            &conn,
            session_id,
            r#"{"cwd":"/Users/demo/proj","provider":"openai-api"}"#,
            "",
            "助手能力介绍",
            t0,
            t0 + 25.5,
            0,
            11_446,
            203,
        )
        .await;
        // Archived session (excluded from list) + one message.
        hermes_ins_session(
            &conn,
            "hermes-sess-archived",
            "",
            "/Users/demo/arch",
            "archived one",
            t0 - 500.0,
            t0 - 400.0,
            1,
            0,
            0,
        )
        .await;
        hermes_ins_msg(
            &conn,
            "hermes-sess-archived",
            "user",
            "hi".to_string(),
            "",
            "",
            "",
            "",
            t0 - 450.0,
            "",
            1,
        )
        .await;
        // Empty session (only a system message → 0 countable → skipped in list).
        hermes_ins_session(
            &conn,
            "hermes-sess-empty",
            "",
            "/Users/demo/empty",
            "empty",
            t0 - 1_000.0,
            t0 - 900.0,
            0,
            0,
            0,
        )
        .await;
        hermes_ins_msg(
            &conn,
            "hermes-sess-empty",
            "system",
            "SYSTEM PROMPT".to_string(),
            "",
            "",
            "",
            "",
            t0 - 950.0,
            "",
            1,
        )
        .await;

        // Primary transcript (insertion order == id order).
        // 1) user multimodal: NUL-sentinel JSON content (text + data-URI image).
        let mm_content = format!(
            "\u{0000}json:{}",
            r#"[{"type":"text","text":"看这个并修复"},{"type":"image_url","image_url":{"url":"data:image/png;base64,QUJD"}}]"#
        );
        hermes_ins_msg(&conn, session_id, "user", mm_content, "", "", "", "", t0 + 1.0, "", 1).await;
        // 2) assistant: reasoning_content → Thinking, text, two tool_calls
        //    (call_1 arguments as JSON string, call_2 arguments as object).
        let tool_calls = r#"[{"id":"call_1","type":"function","function":{"name":"read_file","arguments":"{\"path\":\"a.txt\"}"}},{"id":"call_2","type":"function","function":{"name":"patch","arguments":{"path":"a.txt"}}}]"#;
        hermes_ins_msg(
            &conn,
            session_id,
            "assistant",
            "我来读取并修复".to_string(),
            "",
            tool_calls,
            "",
            "先读文件，再打补丁",
            t0 + 2.0,
            "tool_calls",
            1,
        )
        .await;
        // 3) + 4) tool results matched by tool_call_id.
        hermes_ins_msg(&conn, session_id, "tool", "line1\nline2".to_string(), "call_1", "", "read_file", "", t0 + 3.0, "", 1).await;
        hermes_ins_msg(&conn, session_id, "tool", "patched ok".to_string(), "call_2", "", "patch", "", t0 + 4.0, "", 1).await;
        // 5) assistant final text.
        hermes_ins_msg(&conn, session_id, "assistant", "完成".to_string(), "", "", "", "", t0 + 5.0, "stop", 1).await;
        // 6) rewound assistant draft (active = 0 → excluded).
        hermes_ins_msg(&conn, session_id, "assistant", "(rewound draft)".to_string(), "", "", "", "", t0 + 6.0, "stop", 0).await;
        // 7) system row (skipped by role).
        hermes_ins_msg(&conn, session_id, "system", "SYSTEM PROMPT".to_string(), "", "", "", "", t0 + 7.0, "", 1).await;
    });

    let parser = HermesParser::with_base_dir(base);
    let conversations = parser.list_conversations().expect("list conversations");
    assert_json_snapshot!("hermes_list", conversations, {
        ".**.started_at" => "[ts]",
        ".**.ended_at" => "[ts]",
    });

    let detail = parser
        .get_conversation(session_id)
        .expect("get conversation");
    assert_json_snapshot!("hermes_detail", detail, {
        ".**.started_at" => "[ts]",
        ".**.ended_at" => "[ts]",
        ".**.timestamp" => "[ts]",
        ".**.completed_at" => "[ts]",
    });
}

// ────────────────────────────────────────────────────────────────────────────
// Kimi Code
// ────────────────────────────────────────────────────────────────────────────

#[test]
fn kimi_code_minimal_session_snapshot() {
    let temp = tempfile::tempdir().expect("create tempdir");
    let home = temp.path().to_path_buf();
    // Kimi stores `<home>/sessions/<workDirKey>/<sessionId>/…`; the parser's
    // base_dir is the `sessions` directory and `session_index.jsonl` sits at the
    // home root (the only source of the session's working directory).
    let base = home.join("sessions");
    let bucket = "wd_demo_abcdef123456";
    let session_id = "session_kimi_001";
    let session_dir = base.join(bucket).join(session_id);

    // state.json carries the title (and no cwd — that is by design).
    write(
        &session_dir.join("state.json"),
        &json!({
            "title": "build the app",
            "createdAt": "2026-03-01T10:00:00Z",
            "isCustomTitle": false
        })
        .to_string(),
    );
    // session_index.jsonl → working directory.
    write(
        &home.join("session_index.jsonl"),
        &format!(
            "{}\n",
            json!({"sessionId": session_id, "sessionDir": "ignored", "workDir": "/tmp/demo"})
        ),
    );
    // The session log is the only place the real model id appears.
    write(
        &session_dir.join("logs").join("kimi-code.log"),
        "2026-03-01T10:00:00.000Z INFO  llm config  provider=kimi model=kimi-k2.7-code modelAlias=codeg-managed\n",
    );

    // The wire event stream: prompt → think → Read tool → result → text, with a
    // per-step usage record for each of the two steps.
    let wire = [
        json!({"type":"metadata","protocol_version":"1.4","created_at":1772359200000i64}),
        json!({"type":"config.update","modelAlias":"codeg-managed","thinkingLevel":"high","time":1772359200000i64}),
        json!({"type":"turn.prompt","input":[{"type":"text","text":"build the app"}],"origin":{"kind":"user"},"time":1772359201000i64}),
        json!({"type":"context.append_message","message":{"role":"user","content":[{"type":"text","text":"<system-reminder>ignored</system-reminder>"}],"origin":{"kind":"injection"}},"time":1772359201001i64}),
        json!({"type":"context.append_loop_event","event":{"type":"content.part","part":{"type":"think","think":"inspect the entry file first"}},"time":1772359202000i64}),
        json!({"type":"context.append_loop_event","event":{"type":"tool.call","toolCallId":"Read_0","name":"Read","args":{"file_path":"/tmp/demo/app.ts"}},"time":1772359203000i64}),
        json!({"type":"context.append_loop_event","event":{"type":"tool.result","parentUuid":"Read_0","toolCallId":"Read_0","result":{"output":"   1→export const x = 1\n   2→export const y = 2"}},"time":1772359204000i64}),
        json!({"type":"usage.record","model":"codeg-managed","usage":{"inputOther":1200,"output":40,"inputCacheRead":800,"inputCacheCreation":0},"usageScope":"turn","time":1772359204500i64}),
        json!({"type":"context.append_loop_event","event":{"type":"content.part","part":{"type":"text","text":"The app exports x and y."}},"time":1772359205000i64}),
        json!({"type":"usage.record","model":"codeg-managed","usage":{"inputOther":60,"output":80,"inputCacheRead":2000,"inputCacheCreation":0},"usageScope":"turn","time":1772359205500i64}),
    ];
    let wire_text = wire
        .iter()
        .map(|v| v.to_string())
        .collect::<Vec<_>>()
        .join("\n");
    write(
        &session_dir.join("agents").join("main").join("wire.jsonl"),
        &format!("{wire_text}\n"),
    );

    let parser = KimiCodeParser::with_base_dir(base);
    let summaries = parser.list_conversations().expect("list kimi");
    let detail = parser.get_conversation(session_id).expect("detail kimi");

    assert_json_snapshot!("kimi_code_list", summaries, {
        ".**.started_at" => "[ts]",
        ".**.ended_at" => "[ts]",
    });
    assert_json_snapshot!("kimi_code_detail", detail, {
        ".**.started_at" => "[ts]",
        ".**.ended_at" => "[ts]",
        ".**.timestamp" => "[ts]",
        ".**.completed_at" => "[ts]",
    });
}
