//! Opt-in, billable smoke test against the installed Claude Code / Codex ACP adapters.
//!
//! PowerShell (from src-tauri, after the parent build has finished):
//!   $env:CODEG_MESSAGE_EDIT_LIVE = '1'
//!   $env:CODEG_MESSAGE_EDIT_LIVE_PROVIDERS = 'claude,codex'
//!   $env:CODEG_MESSAGE_EDIT_LIVE_RESTORE = '1' # optional exact-byte restore
//!   $env:CODEG_MESSAGE_EDIT_LIVE_CANCEL = '1' # optional cancel/restore lifecycle
//!   cargo test --no-default-features --features test-utils --test message_edit_live -- --ignored --exact message_edit_real_adapters --test-threads=1 --nocapture
//!
//! One test/process owns CODEG_HOME, set BEFORE constructing any app object or
//! Tokio runtime. No production database, app initialization, migrations of
//! installed state, adapter installation, or credential file reads/copies here.
//! Native HOME/USERPROFILE, CLAUDE_CONFIG_DIR, CODEX_HOME and PATH are inherited:
//! these npm adapters resolve independently of CODEG_HOME. Relocating native
//! homes could hide OAuth/keychain or provider configuration. The five short
//! prompts/provider (six with CANCEL=1) leave small native sessions in the native homes;
//! this harness NEVER removes native sessions (including its own).
//!
//! Optional CODEG_MESSAGE_EDIT_LIVE_TIMEOUT_SECS: 30..=600 per operation (180
//! default). The entire provider scenario is additionally capped at 20 minutes.
//! CANCEL=1 adds one prompt on the existing fixture session and enables its
//! checkpoints even without RESTORE=1. It restores a canceled turn, then watches
//! for late writes for 35 seconds (observation timeout is at least 40 seconds).
//! CODEG_ACP_HOST_TOOLS=agent uses native provider tools, not Codeg's terminal
//! runtime. Native cancellation latency is provider-specific: writes may finish
//! while preview refuses restoration as busy. A successful preview must cover
//! every completed fixture write; no writes are allowed after restoration.
//! This tests checkpoint settlement/restore safety, not immediate process kill.
//! Log label immediate_no_delayed_write means the delayed sentinel was absent;
//! settlement_ms records latency and does not imply instantaneous termination.
//! Only provider-specific PASS lines establish cancellation coverage.
//! Native content is withheld; diagnostics keep test stages and safe error codes.
//! Failure retains only the owned fixture for inspection; success removes it.

#![cfg(feature = "test-utils")]

use std::cell::Cell;
use std::collections::BTreeMap;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::time::Duration;

use codeg_lib::acp::error::AcpError;
use codeg_lib::acp::fork::{verify_fork_prefix, ForkOptions};
use codeg_lib::acp::manager::ConnectionManager;
use codeg_lib::acp::types::{ConnectionStatus, ForkResultInfo, PromptInputBlock};
use codeg_lib::acp::{LiveSessionSnapshot, PendingPermissionState};
use codeg_lib::db::error::DbError;
use codeg_lib::db::service::conversation_service;
use codeg_lib::db::test_helpers::{fresh_in_memory_db, seed_folder};
use codeg_lib::db::AppDatabase;
use codeg_lib::models::agent::AgentType;
use codeg_lib::models::message::{ContentBlock, MessageTurn, TurnRole};
use codeg_lib::parsers::{build_agent_parser, ParseError};
use codeg_lib::parsers::{claude::ClaudeParser, AgentParser};
use codeg_lib::web::event_bridge::EventEmitter;
use futures::FutureExt;

type Check<T = ()> = Result<T, String>;

/// Offline regression derived from the fixture-scoped Claude failure on
/// 2026-10-08. The child rewrote ONLY transport identity + assistant timestamp;
/// both message bodies and the native assistant message id were byte-identical.
/// Runs in normal test-utils CI without models, auth, or native files; only a
/// temporary parser fixture is used.
/// Reproduces the old timestamp-sensitive rejection and guards the parent's
/// narrow native-assistant-id exception.
#[test]
fn claude_fork_retimestamped_prefix_regression() {
    let fixture = tempfile::tempdir().expect("offline parser fixture");
    let project = fixture.path().join("only-fixture-project");
    std::fs::create_dir(&project).expect("create parser fixture project");
    let parent = "11111111-1111-4111-8111-111111111111";
    let child = "22222222-2222-4222-8222-222222222222";
    let cwd = fixture.path().to_string_lossy().into_owned();
    let message_id = "msg_fixture_same_native_message";
    for (session, user_id, assistant_id, assistant_timestamp) in [
        (
            parent,
            "parent-user",
            "parent-assistant",
            "2026-10-08T14:10:45.809Z",
        ),
        (
            child,
            "child-user",
            "child-assistant",
            "2026-10-08T14:11:39.118Z",
        ),
    ] {
        let records = [
            serde_json::json!({
                "type": "user", "uuid": user_id, "parentUuid": null,
                "sessionId": session, "cwd": cwd,
                "timestamp": "2026-10-08T14:10:21.528Z",
                "message": {"role": "user", "content": [{"type": "text", "text": "Reply exactly FRESH_OK."}]}
            }),
            serde_json::json!({
                "type": "assistant", "uuid": assistant_id, "parentUuid": user_id,
                "sessionId": session, "cwd": cwd, "timestamp": assistant_timestamp,
                "message": {"role": "assistant", "id": message_id,
                    "content": [{"type": "text", "text": "FRESH_OK"}]}
            }),
        ];
        let jsonl = records
            .iter()
            .map(|record| serde_json::to_string(record).unwrap())
            .collect::<Vec<_>>()
            .join("\n")
            + "\n";
        std::fs::write(project.join(format!("{session}.jsonl")), jsonl)
            .expect("write fixture transcript");
    }
    // Explicit fixture root: never scan any native Claude projects directory.
    let parser = ClaudeParser::with_base_dir(fixture.path().to_path_buf());
    let expected = parser
        .get_conversation(parent)
        .expect("parse fixture parent")
        .turns;
    let actual = parser
        .get_conversation(child)
        .expect("parse fixture child")
        .turns;
    assert_eq!(expected.len(), 2);
    assert_eq!(actual.len(), 2);
    for (left, right) in expected.iter().zip(&actual) {
        assert_eq!(
            std::mem::discriminant(&left.role),
            std::mem::discriminant(&right.role)
        );
        assert_eq!(
            serde_json::to_value(&left.blocks).unwrap(),
            serde_json::to_value(&right.blocks).unwrap()
        );
    }
    assert_eq!(expected[0].timestamp, actual[0].timestamp);
    assert_eq!(expected[1].agent_message_id.as_deref(), Some(message_id));
    assert_eq!(expected[1].agent_message_id, actual[1].agent_message_id);
    assert_eq!(
        (actual[1].timestamp - expected[1].timestamp).num_milliseconds(),
        53_309
    );
    eprintln!("fixture prefix: 2 turns, roles/blocks/native assistant id equal; assistant timestamp delta=53309ms");
    assert!(verify_fork_prefix(&expected, &actual).is_ok(),
        "Claude rewrites retained assistant timestamps on fork; equal context must not be rejected for this metadata change");

    // Timestamp drift needs positive native identity, not just identical text.
    for native_id in [
        Some("different-native-id".to_owned()),
        None,
        Some(String::new()),
    ] {
        let mut changed = actual.clone();
        changed[1].agent_message_id = native_id;
        assert!(
            verify_fork_prefix(&expected, &changed).is_err(),
            "re-stamped assistant without matching nonempty native id must be rejected"
        );
    }
    let mut empty_parent = expected.clone();
    let mut empty_child = actual.clone();
    empty_parent[1].agent_message_id = Some(String::new());
    empty_child[1].agent_message_id = Some(String::new());
    assert!(
        verify_fork_prefix(&empty_parent, &empty_child).is_err(),
        "two empty native ids are not identity evidence"
    );

    let mut changed_blocks = actual.clone();
    changed_blocks[1].blocks.push(ContentBlock::Text {
        text: "discarded context".into(),
    });
    assert!(
        verify_fork_prefix(&expected, &changed_blocks).is_err(),
        "matching native id must not permit changed assistant blocks"
    );

    let mut changed_user_time = actual.clone();
    changed_user_time[0].timestamp += chrono::Duration::milliseconds(1);
    assert!(
        verify_fork_prefix(&expected, &changed_user_time).is_err(),
        "user timestamps remain part of exact prefix identity"
    );

    let mut changed_role = actual.clone();
    changed_role[1].role = TurnRole::System;
    assert!(
        verify_fork_prefix(&expected, &changed_role).is_err(),
        "matching native id must not permit role changes"
    );
}

const POLL: Duration = Duration::from_millis(100);
const SCRIPT_NAME: &str = "message-edit-fixture.cjs";
const FIXTURE_COMMAND: &str = "node message-edit-fixture.cjs";
const CANCEL_SCRIPT_NAME: &str = "message-edit-cancel.cjs";
const CANCEL_COMMAND: &str = "node message-edit-cancel.cjs";
const CANCEL_MARKER: &str = "cancellation-file.txt";
const CANCEL_LATE: &str = "cancellation-late-write.txt";
const CANCEL_BYTES: &[u8] = b"cancel fixture started\r\n";
const CANCEL_LATE_BYTES: &[u8] = b"native fixture settled after delay\n";
// This intentionally outlives the script's 30-second delay. Keep them paired.
const CANCEL_OBSERVE: Duration = Duration::from_secs(35);
const CANCEL_SCRIPT: &str = r#"'use strict';
const fs = require('node:fs');
const path = require('node:path');
const root = fs.realpathSync(__dirname);
if (process.argv.length !== 2 || fs.realpathSync(process.cwd()) !== root) throw Error('fixture cwd');
fs.writeFileSync(path.join(root, 'cancellation-file.txt'), 'cancel fixture started\r\n', {flag: 'wx'});
setTimeout(() => {
  fs.writeFileSync(path.join(root, 'cancellation-late-write.txt'), 'native fixture settled after delay\n', {flag: 'wx'});
}, 30000);
"#;

#[derive(Clone, Copy)]
enum FixtureTool {
    Changes,
    Cancel,
}

impl FixtureTool {
    fn command(self) -> &'static str {
        match self {
            Self::Changes => FIXTURE_COMMAND,
            Self::Cancel => CANCEL_COMMAND,
        }
    }
    fn script(self) -> (&'static str, &'static str) {
        match self {
            Self::Changes => (SCRIPT_NAME, SCRIPT),
            Self::Cancel => (CANCEL_SCRIPT_NAME, CANCEL_SCRIPT),
        }
    }
}
const EDIT_BEFORE: &[u8] = b"user-edited before\r\nexact bytes\r\n";
const REMOVE_BEFORE: &[u8] = b"remove then restore\x00\xff\r\n";
const DIRTY_BEFORE: &[u8] = b"user-owned dirty file\r\n";
const DIRTY_AFTER: &[u8] = b"later manual edit\x00\xff\r\n";
const SCRIPT: &str = r#"'use strict';
const fs = require('node:fs');
const path = require('node:path');
const root = fs.realpathSync(__dirname);
if (process.argv.length !== 2 || fs.realpathSync(process.cwd()) !== root) throw Error('fixture cwd');
for (const name of ['edit.txt', 'remove.bin']) {
  const s = fs.lstatSync(path.join(root, name));
  if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1) throw Error('fixture file');
}
fs.writeFileSync(path.join(root, 'created.txt'), 'created\n', {flag: 'wx'});
fs.writeFileSync(path.join(root, 'edit.txt'), 'edited\n', {flag: 'r+'});
fs.truncateSync(path.join(root, 'edit.txt'), Buffer.byteLength('edited\n'));
fs.unlinkSync(path.join(root, 'remove.bin'));
"#;

fn require(condition: bool, message: &str) -> Check {
    if condition {
        Ok(())
    } else {
        Err(message.into())
    }
}

// Only test-authored strings pass through. Native Display/Debug bodies must
// never reach diagnostics: they can contain paths, headers or provider content.
trait SafeDiagnostic {
    fn diagnostic(&self) -> String;
}

impl SafeDiagnostic for String {
    fn diagnostic(&self) -> String {
        self.clone()
    }
}

impl SafeDiagnostic for AcpError {
    fn diagnostic(&self) -> String {
        if let Some(code) = self.code() {
            return format!("acp/{code}");
        }
        // Exact known application messages, not substring excerpts from a
        // native payload. Unknown protocol errors retain their category only.
        let code = match self {
            AcpError::Protocol(message) => match message.as_str() {
                "No durable prompt receipt; reload persisted history" => "receipt_missing",
                "Prompt has not been persisted" => "receipt_not_persisted",
                "Prompt receipt no longer matches native history" => "receipt_history_mismatch",
                "Prompt identity ambiguous after an unpersisted submission" => "receipt_ambiguous",
                "Prompt history changed" => "receipt_prefix_changed",
                "Session changed or a turn is running" => "receipt_session_changed_or_busy",
                "Transcript identity changed" => "transcript_identity_changed",
                "Client message id already submitted" => "client_message_id_reused",
                "Strict message fork is unsupported" => "strict_fork_unsupported",
                "Prompt destination session changed; reload before resending" => "resend_session_changed",
                "Provider did not preserve the exact prefix before the edited user turn; original session retained" => "fork_prefix_mismatch",
                "This provider cannot name the exact assistant boundary before the edit" => "fork_boundary_unavailable",
                "Session changed or a turn is running; reload before restoring files" => "restore_session_changed_or_busy",
                "Stop foreground and background work in this workspace before restoring files" => "restore_workspace_busy",
                "Another turn or restore is using this workspace" => "restore_activity_busy",
                message if message.strip_prefix("Incomplete checkpoint coverage at user ")
                    .is_some_and(|index| !index.is_empty() && index.bytes().all(|b| b.is_ascii_digit())) => "checkpoint_incomplete",
                _ => "protocol_body_withheld",
            },
            _ => "uncategorized_body_withheld",
        };
        format!("acp/{code}")
    }
}

impl SafeDiagnostic for DbError {
    fn diagnostic(&self) -> String {
        match self {
            Self::Database(_) => "db/database",
            Self::Migration(_) => "db/migration",
            Self::NotFound(_) => "db/not_found",
            Self::Validation(_) => "db/validation",
            Self::Conflict(_) => "db/conflict",
            Self::Io(_) => "db/io",
        }
        .into()
    }
}

impl SafeDiagnostic for ParseError {
    fn diagnostic(&self) -> String {
        match self {
            Self::Io(error) => format!("parser/io/{:?}", error.kind()),
            Self::Json(_) => "parser/json".into(),
            Self::Db(_) => "parser/database".into(),
            Self::ConversationNotFound(_) => "parser/conversation_not_found".into(),
            Self::InvalidData(_) => "parser/invalid_data".into(),
        }
    }
}

// Snapshot codes originate outside the harness. Never print an arbitrary code
// just because it is short or alphanumeric: use a closed vocabulary instead.
fn snapshot_error_code(code: Option<&str>) -> &'static str {
    match code {
        Some("agent_auth_required") => "agent_auth_required",
        Some("initialize_timeout") => "initialize_timeout",
        Some("sdk_not_installed") => "sdk_not_installed",
        Some("set_mode_failed") => "set_mode_failed",
        Some("set_config_option_failed") => "set_config_option_failed",
        Some("session_load_fallback") => "session_load_fallback",
        Some("turn_failed_auth_required") => "turn_failed_auth_required",
        Some("turn_failed_refusal") => "turn_failed_refusal",
        Some("turn_failed_max_tokens") => "turn_failed_max_tokens",
        Some("turn_failed_max_turn_requests") => "turn_failed_max_turn_requests",
        Some("turn_failed_unknown") => "turn_failed_unknown",
        Some(_) => "unrecognized_code_withheld",
        None => "no_code",
    }
}

async fn bounded<T, E: SafeDiagnostic>(
    limit: Duration,
    label: &str,
    future: impl Future<Output = Result<T, E>>,
) -> Check<T> {
    tokio::time::timeout(limit, future)
        .await
        .map_err(|_| format!("{label}: timeout after {}s", limit.as_secs()))?
        .map_err(|error| format!("{label}: {}", error.diagnostic()))
}

#[test]
#[ignore = "billable real providers; requires CODEG_MESSAGE_EDIT_LIVE=1 as well as --ignored"]
fn message_edit_real_adapters() {
    if std::env::var("CODEG_MESSAGE_EDIT_LIVE").as_deref() != Ok("1") {
        eprintln!("SKIP: real adapter test requires CODEG_MESSAGE_EDIT_LIVE=1");
        return;
    }
    let providers = match std::env::var("CODEG_MESSAGE_EDIT_LIVE_PROVIDERS")
        .unwrap_or_else(|_| "claude,codex".into())
        .as_str()
    {
        "claude" => vec![AgentType::ClaudeCode],
        "codex" => vec![AgentType::Codex],
        "claude,codex" => vec![AgentType::ClaudeCode, AgentType::Codex],
        _ => panic!("CODEG_MESSAGE_EDIT_LIVE_PROVIDERS must be claude, codex, or claude,codex"),
    };
    let restore = std::env::var("CODEG_MESSAGE_EDIT_LIVE_RESTORE").as_deref() == Ok("1");
    let cancel = std::env::var("CODEG_MESSAGE_EDIT_LIVE_CANCEL").as_deref() == Ok("1");
    let seconds = std::env::var("CODEG_MESSAGE_EDIT_LIVE_TIMEOUT_SECS")
        .map(|s| s.parse::<u64>().expect("timeout must be an integer"))
        .unwrap_or(180);
    assert!(
        (30..=600).contains(&seconds),
        "timeout must be 30..=600 seconds"
    );
    let fixture = tempfile::Builder::new()
        .prefix("codeg-message-edit-live-")
        .tempdir()
        .expect("create private fixture");
    let isolated_home = fixture.path().join("codeg-home");
    std::fs::create_dir(&isolated_home).expect("create isolated CODEG_HOME");
    // Exactly one env setup, before app APIs, caches, runtime, or child processes.
    // Do not redirect native provider homes or copy credentials into this home.
    std::env::set_var("CODEG_HOME", &isolated_home);
    std::env::set_var("CODEG_DATA_DIR", &isolated_home);
    std::env::set_var("CODEG_ACP_DEBUG", "0");
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .expect("create test runtime");
    let result: Check = runtime.block_on(async {
        for agent in providers {
            let manager = ConnectionManager::new();
            let workspace = fixture.path().join(agent.to_string());
            let stage = Cell::new("fixture setup");
            // Catch panics too, so disconnect_all's process-tree backstop runs
            // before failure reporting or fixture deletion.
            let outcome = std::panic::AssertUnwindSafe(tokio::time::timeout(
                Duration::from_secs(1200),
                exercise(
                    &manager,
                    agent,
                    workspace,
                    Duration::from_secs(seconds),
                    restore,
                    cancel,
                    &stage,
                ),
            ))
            .catch_unwind()
            .await;
            let cleanup =
                tokio::time::timeout(Duration::from_secs(30), manager.disconnect_all()).await;
            require(
                cleanup.is_ok(),
                "provider process cleanup timed out; fixture retained",
            )?;
            match outcome {
                Ok(Ok(result)) => result.map_err(|error| format!("provider={agent} stage={}: {error}", stage.get()))?,
                Ok(Err(_)) => return Err(format!("provider={agent} stage={}: scenario exceeded 20 minutes", stage.get())),
                Err(_) => return Err(format!("{agent}: scenario panicked; fixture retained")),
            }
            eprintln!(
                "PASS {agent}: durable receipt, fresh edit, historical prefix, guarded resend; restore={restore}; cancel={cancel}"
            );
        }
        Ok(())
    });
    if let Err(error) = result {
        let retained = fixture.keep();
        panic!(
            "{error}; owned fixture retained at {}. Native sessions were not deleted.",
            retained.display()
        );
    }
}

struct Harness<'a> {
    manager: &'a ConnectionManager,
    db: AppDatabase,
    agent: AgentType,
    connection: String,
    folder: i32,
    workspace: PathBuf,
    limit: Duration,
}

impl Harness<'_> {
    async fn snapshot(&self) -> Check<LiveSessionSnapshot> {
        let state = self
            .manager
            .get_state(&self.connection)
            .await
            .ok_or("connection disappeared")?;
        let snapshot = state.read().await.to_snapshot();
        if let Some(error) = &snapshot.last_error {
            return Err(format!(
                "snapshot status={:?} code={}",
                snapshot.status,
                snapshot_error_code(error.code.as_deref())
            ));
        }
        require(
            !matches!(
                snapshot.status,
                ConnectionStatus::Error | ConnectionStatus::Disconnected
            ),
            "snapshot: terminal connection status without an error code",
        )?;
        if let Some(failure) = snapshot
            .session_failures
            .iter()
            .find(|failure| !failure.resolved)
        {
            let category = match failure.category.as_str() {
                "connection" => "connection",
                "access" => "access",
                "limit" => "limit",
                "request" => "request",
                "service" => "service",
                _ => "unknown",
            };
            return Err(format!(
                "snapshot unresolved_session_failure category={category}; content withheld"
            ));
        }
        require(
            snapshot.pending_question.is_none() && snapshot.pending_plan_approval.is_none(),
            "unexpected interactive question or plan approval",
        )?;
        Ok(snapshot)
    }

    async fn ready(&self, mode: &str) -> Check<String> {
        let mut last_observation = "snapshot not completed".to_owned();
        let result = bounded(self.limit, "session initialization/mode", async {
            loop {
                let snapshot = self.snapshot().await?;
                last_observation = format!("status={:?}, selectors_ready={}, session_present={}, requested_mode={mode}, mode_matches={}",
                    snapshot.status, snapshot.selectors_ready, snapshot.external_id.is_some(),
                    snapshot.current_mode.as_deref() == Some(mode));
                if snapshot.status == ConnectionStatus::Connected
                    && snapshot.selectors_ready
                    && snapshot.current_mode.as_deref() == Some(mode)
                {
                    if let Some(session) = snapshot.external_id {
                        return Ok::<_, String>(session);
                    }
                }
                require(
                    snapshot.pending_permission.is_none(),
                    "unexpected startup permission request",
                )?;
                tokio::time::sleep(POLL).await;
            }
        })
        .await;
        result.map_err(|error| format!("{error}; last_observation={last_observation}"))
    }

    async fn session(&self) -> Check<String> {
        self.snapshot()
            .await?
            .external_id
            .ok_or_else(|| "missing native session id".into())
    }

    async fn send(&self, session: &str, id: &str, text: &str) -> Result<Option<i32>, AcpError> {
        self.manager
            .send_prompt_linked_guarded(
                &self.db,
                &self.connection,
                vec![PromptInputBlock::Text { text: text.into() }],
                Some(self.folder),
                None,
                None,
                Some(id.into()),
                Some(session.into()),
            )
            .await
    }

    async fn prompt(
        &self,
        session: &str,
        id: &str,
        text: &str,
        marker: &str,
        allow_script: bool,
    ) -> Check {
        let state = self
            .manager
            .get_state(&self.connection)
            .await
            .ok_or("connection disappeared")?;
        let before = state.read().await.turns_completed;
        bounded(
            self.limit,
            &format!("prompt admission/{id}"),
            self.send(session, id, text),
        )
        .await?;
        bounded(self.limit, &format!("provider turn/{id}"), async {
            let mut answered = None;
            loop {
                let snapshot = self.snapshot().await?;
                if let Some(permission) = snapshot.pending_permission {
                    require(
                        allow_script,
                        "unexpected permission request in text-only prompt",
                    )?;
                    if answered.as_deref() != Some(permission.request_id.as_str()) {
                        let option = self.fixture_permission(&permission, FixtureTool::Changes)?;
                        // No blanket/session grants, shell rewrites, or approval of
                        // arbitrary paths. Only the exact prewritten fixture command.
                        bounded(
                            self.limit,
                            "fixture permission",
                            self.manager.respond_permission(
                                &self.connection,
                                &permission.request_id,
                                &option,
                            ),
                        )
                        .await?;
                        answered = Some(permission.request_id);
                    }
                }
                let s = state.read().await;
                if !s.turn_in_flight && s.turns_completed > before {
                    require(
                        s.turns_completed == before + 1,
                        "unexpected extra completed turn",
                    )?;
                    require(
                        s.last_assistant_text.as_deref().map(str::trim) == Some(marker),
                        &format!("expected exact marker {marker}; response withheld"),
                    )?;
                    return Ok::<_, String>(());
                }
                drop(s);
                tokio::time::sleep(POLL).await;
            }
        })
        .await
    }

    fn fixture_permission(
        &self,
        permission: &PendingPermissionState,
        tool: FixtureTool,
    ) -> Check<String> {
        let raw = permission
            .tool_call
            .get("rawInput")
            .ok_or("permission lacks structured command")?;
        require(
            raw.get("command").and_then(|v| v.as_str()) == Some(tool.command()),
            "refusing permission for anything except the exact fixture command",
        )?;
        for key in ["cwd", "workdir", "working_directory"] {
            if let Some(cwd) = raw.get(key) {
                let path = cwd.as_str().ok_or("permission cwd is not a string")?;
                let requested =
                    std::fs::canonicalize(path).map_err(|_| "permission cwd cannot be resolved")?;
                let fixture = std::fs::canonicalize(&self.workspace)
                    .map_err(|_| "fixture cwd cannot be resolved")?;
                require(requested == fixture, "permission cwd differs from fixture")?;
            }
        }
        require(
            raw.get("env").is_none(),
            "refusing a command with environment overrides",
        )?;
        let (name, script) = tool.script();
        check_bytes(&self.workspace.join(name), script.as_bytes())?;
        permission
            .options
            .iter()
            .find(|option| option.kind == "allow_once")
            .map(|option| option.option_id.clone())
            .ok_or_else(|| "no allow_once permission option".into())
    }

    async fn history(&self, session: &str, users: usize) -> Check<Vec<MessageTurn>> {
        let mut last_observation = "read not completed".to_owned();
        let result = bounded(self.limit, "native transcript flush", async {
            loop {
                let agent = self.agent;
                let id = session.to_owned();
                let detail = tokio::task::spawn_blocking(move || {
                    build_agent_parser(agent).get_conversation(&id)
                })
                .await
                .map_err(|_| "transcript reader task failed")?;
                match detail {
                    Ok(detail) => {
                        require(
                            detail.summary.id == session,
                            "native transcript identity mismatch",
                        )?;
                        let count = detail
                            .turns
                            .iter()
                            .filter(|t| matches!(t.role, TurnRole::User))
                            .count();
                        last_observation = format!(
                            "user_count={count}, expected={users}, total_turns={}",
                            detail.turns.len()
                        );
                        require(
                            count <= users,
                            "native transcript contains discarded/extra user turns",
                        )?;
                        if count == users
                            && matches!(
                                detail.turns.last().map(|t| &t.role),
                                Some(TurnRole::Assistant)
                            )
                        {
                            return Ok::<_, String>(detail.turns);
                        }
                    }
                    Err(error) => last_observation = error.diagnostic(),
                }
                tokio::time::sleep(POLL).await;
            }
        })
        .await;
        result.map_err(|error| format!("{error}; last_observation={last_observation}"))
    }

    async fn resolve_completed_ui_turn(
        &self,
        session: &str,
        client_id: &str,
    ) -> Check<MessageTurn> {
        let mut last_observation = "resolve not completed".to_owned();
        let result = bounded(self.limit, "resolve_edit_turn/durable UI receipt", async {
            loop {
                self.snapshot().await?;
                match self
                    .manager
                    .resolve_edit_turn(&self.connection, session, client_id)
                    .await
                {
                    Ok(turn) => return Ok::<_, String>(turn),
                    Err(error) => last_observation = error.diagnostic(),
                }
                tokio::time::sleep(POLL).await;
            }
        })
        .await;
        result.map_err(|error| format!("{error}; last_observation={last_observation}"))
    }

    async fn cancel_and_restore(
        &self,
        retained: &[MessageTurn],
        stage: &Cell<&'static str>,
    ) -> Check {
        stage.set("cancel fixture setup");
        let session = self.session().await?;
        let cid = self
            .snapshot()
            .await?
            .conversation_id
            .ok_or("cancel fixture missing DB linkage")?;
        // The preceding prompt may be visible in history while its checkpoint
        // publisher is still finishing; do not confuse that with a cancel bug.
        bounded(self.limit, "enable cancel checkpoints", async {
            loop {
                match self.manager.configure_checkpoints(&self.connection, Some(true)).await {
                    Ok(_) => return Ok::<_, String>(()),
                    Err(AcpError::Protocol(message)) if matches!(message.as_str(),
                        "Another turn or restore is using this workspace" |
                        "Stop foreground and background work in this workspace before restoring files") => {},
                    Err(error) => return Err(error.diagnostic()),
                }
                self.snapshot().await?;
                tokio::time::sleep(POLL).await;
            }
        }).await?;
        // These files are new to this phase and cannot affect prior assertions.
        std::fs::write(self.workspace.join(CANCEL_SCRIPT_NAME), CANCEL_SCRIPT)
            .map_err(|_| "write cancel fixture script")?;
        for name in [CANCEL_MARKER, CANCEL_LATE] {
            require(
                !self
                    .workspace
                    .join(name)
                    .try_exists()
                    .map_err(|_| "inspect cancel fixture path")?,
                "cancel fixture path already exists",
            )?;
        }
        let state = self
            .manager
            .get_state(&self.connection)
            .await
            .ok_or("connection disappeared")?;
        let completed = state.read().await.turns_completed;
        let prompt = format!(
            "In the current fixture workspace run exactly `{CANCEL_COMMAND}` once in the foreground. \
             It creates cancellation-file.txt, waits 30 seconds, then writes cancellation-late-write.txt. \
             Do not read other files, rewrite the script, use other commands, background the command, \
             access the network, or change configuration. Wait for completion then reply exactly CANCEL_TOO_LATE."
        );
        stage.set("cancel prompt admission and started marker");
        bounded(
            self.limit,
            "cancel prompt admission",
            self.send(&session, "cancel-original", &prompt),
        )
        .await?;
        bounded(self.limit, "cancel fixture started marker", async {
            let mut answered = None;
            loop {
                let snapshot = self.snapshot().await?;
                if let Some(permission) = snapshot.pending_permission {
                    if answered.as_deref() != Some(permission.request_id.as_str()) {
                        let option = self.fixture_permission(&permission, FixtureTool::Cancel)?;
                        bounded(
                            self.limit,
                            "cancel fixture permission",
                            self.manager.respond_permission(
                                &self.connection,
                                &permission.request_id,
                                &option,
                            ),
                        )
                        .await?;
                        answered = Some(permission.request_id);
                    }
                }
                let s = state.read().await;
                require(
                    s.turn_in_flight && s.turns_completed == completed,
                    "cancel fixture turn completed before cancellation could be exercised",
                )?;
                drop(s);
                require(
                    !self
                        .workspace
                        .join(CANCEL_LATE)
                        .try_exists()
                        .map_err(|_| "inspect late-write sentinel")?,
                    "cancel fixture reached its delayed write before cancellation",
                )?;
                if self
                    .workspace
                    .join(CANCEL_MARKER)
                    .try_exists()
                    .map_err(|_| "inspect cancel marker")?
                {
                    // Marker existence may become visible before writeFileSync
                    // finishes; wait for the exact bytes before sending Cancel.
                    if std::fs::read(self.workspace.join(CANCEL_MARKER))
                        .ok()
                        .as_deref()
                        == Some(CANCEL_BYTES)
                    {
                        check_bytes(&self.workspace.join(CANCEL_MARKER), CANCEL_BYTES)?;
                        return Ok::<_, String>(());
                    }
                }
                tokio::time::sleep(POLL).await;
            }
        })
        .await?;

        stage.set("cancel restore admission while running");
        // Any target must be rejected at the busy gate before parsing. Reuse a
        // known retained user turn so no extra model call or synthetic turn is needed.
        let busy = tokio::time::timeout(
            self.limit,
            self.manager.preview_file_restore(
                &self.db,
                &self.connection,
                cid,
                self.folder,
                &session,
                retained
                    .first()
                    .ok_or("cancel fixture missing retained prefix")?,
            ),
        )
        .await
        .map_err(|_| "running restore admission timed out")?;
        match busy {
            Err(AcpError::Protocol(ref message))
                if message
                    == "Session changed or a turn is running; reload before restoring files" => {}
            Err(error) => {
                return Err(format!(
                    "running restore admission: expected busy; got {}",
                    error.diagnostic()
                ))
            }
            Ok(_) => return Err("restore preview admitted while cancel fixture was running".into()),
        }
        stage.set("cancel request");
        let cancel_requested_at = tokio::time::Instant::now();
        bounded(
            self.limit,
            "manager.cancel",
            self.manager.cancel(&self.db.conn, &self.connection),
        )
        .await?;

        stage.set("cancel receipt and provider checkpoint settlement");
        let target = self
            .resolve_completed_ui_turn(&session, "cancel-original")
            .await?;
        let mut last_observation = "preview not completed".to_owned();
        let mut busy_previews = 0usize;
        let mut late_seen_while_busy = false;
        let settled = bounded(self.limit.min(Duration::from_secs(120)), "cancel checkpoint settlement", async {
            loop {
                self.snapshot().await?;
                match self
                    .manager
                    .preview_file_restore(
                        &self.db,
                        &self.connection,
                        cid,
                        self.folder,
                        &session,
                        &target,
                    )
                    .await
                {
                    Ok(preview) => return Ok::<_, String>(preview),
                    Err(error) => {
                        // Retry only the public admission gates. Missing/failed
                        // checkpoint coverage, identity errors and other failures
                        // are not evidence of a still-settling native command.
                        let busy = matches!(&error, AcpError::Protocol(message) if matches!(message.as_str(),
                            "Session changed or a turn is running; reload before restoring files" |
                            "Stop foreground and background work in this workspace before restoring files" |
                            "Another turn or restore is using this workspace"));
                        if !busy { return Err(error.diagnostic()); }
                        require(self.session().await? == session, "cancel session changed while awaiting settlement")?;
                        busy_previews += 1;
                        late_seen_while_busy |= self.workspace.join(CANCEL_LATE).try_exists()
                            .map_err(|_| "inspect delayed native write")?;
                        last_observation = format!("{}; busy_previews={busy_previews}; late_seen_while_busy={late_seen_while_busy}", error.diagnostic());
                    }
                }
                tokio::time::sleep(POLL).await;
            }
        })
        .await;
        let preview =
            settled.map_err(|error| format!("{error}; last_observation={last_observation}"))?;
        // Freeze the expected file set at the FIRST successful preview. Do not
        // refresh preview or grow this set if a still-running tool writes later:
        // that would conceal premature checkpoint publication.
        let late_at_settlement = self
            .workspace
            .join(CANCEL_LATE)
            .try_exists()
            .map_err(|_| "inspect delayed native write at settlement")?;
        require(
            !late_seen_while_busy || late_at_settlement,
            "delayed native write disappeared before settlement",
        )?;
        // Cancel's eager TurnComplete is insufficient: only the successful
        // preview above proves the checkpoint publisher released its activity.
        let s = state.read().await;
        require(
            !s.turn_in_flight && s.turns_completed > completed && s.last_turn_ended_abnormally,
            "cancel did not settle as an interrupted turn",
        )?;
        drop(s);
        require(
            preview.conflicts.is_empty(),
            "canceled-turn restore has conflicts",
        )?;
        let mut expected_paths = std::collections::BTreeSet::from([CANCEL_MARKER]);
        if late_at_settlement {
            expected_paths.insert(CANCEL_LATE);
            check_bytes(&self.workspace.join(CANCEL_LATE), CANCEL_LATE_BYTES)?;
        }
        let covered_paths: std::collections::BTreeSet<_> = preview
            .files
            .iter()
            .map(|file| file.path.as_str())
            .collect();
        require(
            covered_paths == expected_paths
                && preview.files.len() == expected_paths.len()
                && preview.files.iter().all(|file| file.change == "deleted"),
            "canceled-turn checkpoint did not cover exactly all settled fixture writes",
        )?;
        check_bytes(&self.workspace.join(CANCEL_MARKER), CANCEL_BYTES)?;
        let cancel_behavior = if late_at_settlement {
            "settled_delayed"
        } else {
            "immediate_no_delayed_write"
        };
        eprintln!("{} cancel checkpoint ready: native_behavior={cancel_behavior}; settlement_ms={}; busy_previews={busy_previews}; late_seen_while_busy={late_seen_while_busy}; restore_files={}",
            self.agent, cancel_requested_at.elapsed().as_millis(), expected_paths.len());

        stage.set("cancel checkpoint restore fork");
        if !late_at_settlement {
            require(
                !self
                    .workspace
                    .join(CANCEL_LATE)
                    .try_exists()
                    .map_err(|_| "inspect late write before restore")?,
                "native command wrote after successful checkpoint preview",
            )?;
        }
        let child = self.fork(&session, &target, Some(preview.token)).await?;
        for name in [CANCEL_MARKER, CANCEL_LATE] {
            require(
                !self
                    .workspace
                    .join(name)
                    .try_exists()
                    .map_err(|_| "inspect cancel files immediately after restore")?,
                "restore left a settled fixture file or a write occurred after successful preview",
            )?;
        }
        let users = retained
            .iter()
            .filter(|turn| matches!(turn.role, TurnRole::User))
            .count();
        let prefix = self.history(&child.forked_session_id, users).await?;
        verify_fork_prefix(retained, &prefix)
            .map_err(|_| "cancel restore changed the retained context")?;
        assert_absent(
            &prefix,
            &["cancel-original", CANCEL_COMMAND, "CANCEL_TOO_LATE"],
        )?;

        stage.set("cancel post-restore late-write observation");
        // Run past the script's entire 30-second timer AFTER restoration. A
        // detached surviving shell cannot pass just by writing after preview.
        bounded(
            self.limit.max(CANCEL_OBSERVE + Duration::from_secs(5)),
            "cancel no subsequent writes",
            async {
                let until = tokio::time::Instant::now() + CANCEL_OBSERVE;
                loop {
                    self.snapshot().await?;
                    for name in [CANCEL_MARKER, CANCEL_LATE] {
                        require(
                            !self
                                .workspace
                                .join(name)
                                .try_exists()
                                .map_err(|_| "inspect restored cancel files")?,
                            "canceled fixture wrote after restoration or restore left its marker",
                        )?;
                    }
                    check_bytes(
                        &self.workspace.join(CANCEL_SCRIPT_NAME),
                        CANCEL_SCRIPT.as_bytes(),
                    )?;
                    check_bytes(&self.workspace.join(SCRIPT_NAME), SCRIPT.as_bytes())?;
                    check_bytes(&self.workspace.join("dirty.bin"), DIRTY_AFTER)?;
                    if tokio::time::Instant::now() >= until {
                        return Ok::<_, String>(());
                    }
                    tokio::time::sleep(POLL).await;
                }
            },
        )
        .await?;
        eprintln!("PASS {} cancel: native_behavior={cancel_behavior}; restored_files={}; no writes for 35s after restore", self.agent, expected_paths.len());
        Ok(())
    }

    async fn fork(
        &self,
        session: &str,
        target: &MessageTurn,
        token: Option<String>,
    ) -> Check<ForkResultInfo> {
        let result = bounded(
            self.limit,
            "strict edit fork",
            self.manager.fork_session_with_options(
                &self.db,
                &self.connection,
                None,
                None,
                ForkOptions {
                    fork_before_turn_id: Some(target.id.clone()),
                    expected_session_id: Some(session.into()),
                    expected_turn: Some(target.clone()),
                    restore_files_token: token,
                    ..Default::default()
                },
            ),
        )
        .await?;
        require(
            result.original_session_id == session && result.forked_session_id != session,
            "edit did not create a distinct native destination",
        )?;
        require(
            self.session().await? == result.forked_session_id,
            "snapshot not on fork destination",
        )?;
        let conversation = self
            .snapshot()
            .await?
            .conversation_id
            .ok_or("fork lost DB linkage")?;
        let current = bounded(
            self.limit,
            "current in-memory row",
            conversation_service::get_by_id(&self.db.conn, conversation),
        )
        .await?;
        let sibling = bounded(
            self.limit,
            "preserved in-memory row",
            conversation_service::get_by_id(&self.db.conn, result.sibling_conversation_id),
        )
        .await?;
        require(
            current.external_id.as_deref() == Some(result.forked_session_id.as_str())
                && sibling.external_id.as_deref() == Some(session),
            "fork DB rows do not preserve both sessions",
        )?;
        Ok(result)
    }

    async fn rejected_resend(&self, stale: &str, id: &str, text: &str) -> Check {
        let before = self.snapshot().await?;
        let state = self
            .manager
            .get_state(&self.connection)
            .await
            .ok_or("connection disappeared")?;
        let completed = state.read().await.turns_completed;
        let result = tokio::time::timeout(self.limit, self.send(stale, id, text))
            .await
            .map_err(|_| "stale resend timed out")?;
        require(
            matches!(result, Err(AcpError::Protocol(ref message)) if message.contains("Prompt destination session changed")),
            "stale-session resend was not rejected by the destination guard",
        )?;
        let after = self.snapshot().await?;
        let s = state.read().await;
        require(
            s.turns_completed == completed
                && !s.turn_in_flight
                && before.external_id == after.external_id
                && before.conversation_id == after.conversation_id
                && after.pending_user_message.is_none(),
            "rejected resend changed the live session",
        )
    }
}

fn check_bytes(path: &Path, expected: &[u8]) -> Check {
    let metadata = std::fs::symlink_metadata(path).map_err(|_| "fixture file missing")?;
    require(
        metadata.is_file() && !metadata.file_type().is_symlink(),
        "fixture file is not regular",
    )?;
    let bytes = std::fs::read(path).map_err(|_| "cannot read fixture bytes")?;
    require(bytes == expected, "fixture bytes differ from expectation")
}

fn text(turn: &MessageTurn) -> String {
    turn.blocks
        .iter()
        .filter_map(|block| match block {
            ContentBlock::Text { text } => Some(text.as_str()),
            _ => None,
        })
        .collect()
}

fn assert_absent(turns: &[MessageTurn], markers: &[&str]) -> Check {
    // Includes tools and other blocks as well as visible text. Never print it.
    let serialized =
        serde_json::to_string(turns).map_err(|_| "cannot inspect fixture transcript")?;
    require(
        markers.iter().all(|marker| !serialized.contains(marker)),
        "discarded marker leaked into destination history",
    )
}

async fn exercise(
    manager: &ConnectionManager,
    agent: AgentType,
    workspace: PathBuf,
    limit: Duration,
    restore: bool,
    cancel: bool,
    stage: &Cell<&'static str>,
) -> Check {
    std::fs::create_dir(&workspace).map_err(|_| "create fixture workspace")?;
    for (name, bytes) in [
        ("edit.txt", EDIT_BEFORE),
        ("remove.bin", REMOVE_BEFORE),
        ("dirty.bin", DIRTY_BEFORE),
        (SCRIPT_NAME, SCRIPT.as_bytes()),
    ] {
        std::fs::write(workspace.join(name), bytes).map_err(|_| "write fixture")?;
    }
    let db = fresh_in_memory_db().await;
    let folder = seed_folder(&db, workspace.to_str().ok_or("fixture path must be UTF-8")?).await;
    let mode = if agent == AgentType::ClaudeCode {
        "default"
    } else {
        "workspace-write"
    };
    let mut env = BTreeMap::from([
        ("CODEG_ACP_HOST_TOOLS".into(), "agent".into()),
        ("DISABLE_AUTOUPDATER".into(), "1".into()),
        (
            "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC".into(),
            "1".into(),
        ),
    ]);
    if agent == AgentType::Codex {
        env.insert("INITIAL_AGENT_MODE".into(), mode.into());
    }
    stage.set("spawn adapter and select safe mode");
    let connection = bounded(
        limit,
        "spawn installed adapter",
        manager.spawn_agent(
            agent,
            Some(workspace.to_string_lossy().into_owned()),
            None,
            env,
            "message-edit-live-fixture".into(),
            EventEmitter::Noop,
            Some(mode.into()),
            BTreeMap::new(),
        ),
    )
    .await?;
    let h = Harness {
        manager,
        db,
        agent,
        connection,
        folder,
        workspace,
        limit,
    };
    let original = h.ready(mode).await?;
    stage.set("configure checkpoints");
    if restore {
        bounded(
            limit,
            "enable fixture checkpoints",
            manager.configure_checkpoints(&h.connection, Some(true)),
        )
        .await?;
    }

    // Fresh edit: a random context token exists ONLY in the discarded prompt.
    stage.set("first UI prompt");
    let discarded_first = format!("FIRST_{}", uuid::Uuid::new_v4().simple());
    h.prompt(
        &original,
        "first-original",
        &format!("Do not use tools. Remember token {discarded_first}. Reply exactly ORIGINAL_OK."),
        "ORIGINAL_OK",
        false,
    )
    .await?;
    // Resolve from the durable UI client id before any fork or fallback to a
    // parser-only target. Never synthesize receipts or guess by prompt text.
    stage.set("first UI prompt durable receipt");
    let resolved_first = h
        .resolve_completed_ui_turn(&original, "first-original")
        .await?;
    let first_history = h.history(&original, 1).await?;
    let first = first_history
        .iter()
        .find(|t| matches!(t.role, TurnRole::User))
        .ok_or("missing first user turn")?;
    require(
        matches!(resolved_first.role, TurnRole::User) && resolved_first.id == first.id,
        "durable receipt resolved a different turn id or role",
    )?;
    verify_fork_prefix(
        std::slice::from_ref(first),
        std::slice::from_ref(&resolved_first),
    )
    .map_err(|_| "durable receipt resolved different timestamp or content blocks")?;
    stage.set("first-message fresh fork");
    let fresh = h.fork(&original, &resolved_first, None).await?;
    let fresh_prompt = "Do not use tools. If an earlier user message gave you a token, reply with that token. Otherwise reply exactly FRESH_OK.";
    stage.set("fresh fork stale resend and context probe");
    h.rejected_resend(&original, "first-replacement", fresh_prompt)
        .await?;
    h.prompt(
        &fresh.forked_session_id,
        "first-replacement",
        fresh_prompt,
        "FRESH_OK",
        false,
    )
    .await?;
    let retained = h.history(&fresh.forked_session_id, 1).await?;
    assert_absent(&retained, &[&discarded_first, "ORIGINAL_OK"])?;

    // Known byte changes are performed by the real adapter's shell tool, not
    // by the Rust test. A fixed script keeps the permission allowlist narrow.
    stage.set("historical target file mutation");
    let discarded_edit = format!("EDIT_{}", uuid::Uuid::new_v4().simple());
    let change_prompt = format!(
        "Remember token {discarded_edit}. In the current fixture workspace run exactly `{FIXTURE_COMMAND}` once. \
         The script only creates created.txt, edits edit.txt, and deletes remove.bin here. \
         Do not inspect other files, use other commands, rewrite the script, access the network, or touch configuration. \
         After success reply exactly FILES_OK."
    );
    h.prompt(
        &fresh.forked_session_id,
        "historical-original",
        &change_prompt,
        "FILES_OK",
        true,
    )
    .await?;
    check_bytes(&h.workspace.join("created.txt"), b"created\n")?;
    check_bytes(&h.workspace.join("edit.txt"), b"edited\n")?;
    require(
        !h.workspace.join("remove.bin").exists(),
        "provider did not delete fixture file",
    )?;
    check_bytes(&h.workspace.join("dirty.bin"), DIRTY_BEFORE)?;
    check_bytes(&h.workspace.join(SCRIPT_NAME), SCRIPT.as_bytes())?;

    stage.set("later discarded turn");
    let discarded_tail = format!("TAIL_{}", uuid::Uuid::new_v4().simple());
    h.prompt(
        &fresh.forked_session_id,
        "discarded-later",
        &format!("Do not use tools. Remember token {discarded_tail}. Reply exactly TAIL_OK."),
        "TAIL_OK",
        false,
    )
    .await?;
    let source = h.history(&fresh.forked_session_id, 3).await?;
    let target = source
        .iter()
        .find(|t| matches!(t.role, TurnRole::User) && text(t).contains(&discarded_edit))
        .ok_or("historical edit target missing")?;
    let target_index = source
        .iter()
        .position(|t| t.id == target.id)
        .ok_or("target index missing")?;
    require(
        source
            .iter()
            .rfind(|t| matches!(t.role, TurnRole::User))
            .is_some_and(|t| text(t).contains(&discarded_tail)),
        "target must have a later discarded turn",
    )?;

    stage.set("historical restore preview");
    let token = if restore {
        let cid = h
            .snapshot()
            .await?
            .conversation_id
            .ok_or("missing in-memory conversation")?;
        // TurnComplete can precede the checkpoint publisher. Poll the read-only
        // preview until coverage is durable; never manufacture checkpoints.
        let mut last_observation = "preview not completed".to_owned();
        let coverage = bounded(limit, "restore coverage", async {
            loop {
                match manager
                    .preview_file_restore(
                        &h.db,
                        &h.connection,
                        cid,
                        h.folder,
                        &fresh.forked_session_id,
                        target,
                    )
                    .await
                {
                    Ok(preview) => return Ok::<_, String>(preview),
                    Err(error) => last_observation = error.diagnostic(),
                }
                h.snapshot().await?;
                tokio::time::sleep(POLL).await;
            }
        })
        .await;
        coverage.map_err(|error| format!("{error}; last_observation={last_observation}"))?;
        // Wait for durable AFTER snapshots before this independent user edit;
        // otherwise a slow checkpoint could accidentally capture it as agent work.
        std::fs::write(h.workspace.join("dirty.bin"), DIRTY_AFTER)
            .map_err(|_| "write manual fixture edit")?;
        let preview = bounded(
            limit,
            "preview after manual edit",
            manager.preview_file_restore(
                &h.db,
                &h.connection,
                cid,
                h.folder,
                &fresh.forked_session_id,
                target,
            ),
        )
        .await?;
        require(
            preview.conflicts.is_empty(),
            "unexpected fixture restore conflict",
        )?;
        let paths: std::collections::BTreeSet<_> =
            preview.files.iter().map(|f| f.path.as_str()).collect();
        require(
            paths
                == ["created.txt", "edit.txt", "remove.bin"]
                    .into_iter()
                    .collect(),
            "restore preview touched unexpected files",
        )?;
        Some(preview.token)
    } else {
        std::fs::write(h.workspace.join("dirty.bin"), DIRTY_AFTER)
            .map_err(|_| "write manual fixture edit")?;
        None
    };
    stage.set("historical strict fork and exact prefix");
    let historical = h.fork(&fresh.forked_session_id, target, token).await?;
    let prefix = h.history(&historical.forked_session_id, 1).await?;
    verify_fork_prefix(&source[..target_index], &prefix)
        .map_err(|_| "historical fork did not preserve the exact prefix")?;
    assert_absent(
        &prefix,
        &[&discarded_edit, &discarded_tail, "FILES_OK", "TAIL_OK"],
    )?;
    stage.set("post-fork fixture byte verification");
    if restore {
        require(
            !h.workspace.join("created.txt").exists(),
            "restore left created file behind",
        )?;
        check_bytes(&h.workspace.join("edit.txt"), EDIT_BEFORE)?;
        check_bytes(&h.workspace.join("remove.bin"), REMOVE_BEFORE)?;
    } else {
        check_bytes(&h.workspace.join("created.txt"), b"created\n")?;
        check_bytes(&h.workspace.join("edit.txt"), b"edited\n")?;
        require(
            !h.workspace.join("remove.bin").exists(),
            "context-only edit changed workspace files",
        )?;
    }
    check_bytes(&h.workspace.join("dirty.bin"), DIRTY_AFTER)?;
    check_bytes(&h.workspace.join(SCRIPT_NAME), SCRIPT.as_bytes())?;

    let replacement = "Do not use tools. If any earlier user message gave you a token, reply with that token. Otherwise, if your previous reply was FRESH_OK, reply exactly HISTORY_OK. If neither applies reply MISSING_PREFIX.";
    stage.set("historical stale resend and retained-context probe");
    h.rejected_resend(
        &fresh.forked_session_id,
        "historical-replacement",
        replacement,
    )
    .await?;
    h.prompt(
        &historical.forked_session_id,
        "historical-replacement",
        replacement,
        "HISTORY_OK",
        false,
    )
    .await?;
    let edited = h.history(&historical.forked_session_id, 2).await?;
    assert_absent(
        &edited,
        &[
            &discarded_first,
            &discarded_edit,
            &discarded_tail,
            "FILES_OK",
            "TAIL_OK",
        ],
    )?;
    require(
        h.session().await? == historical.forked_session_id,
        "resend created another session",
    )?;
    stage.set("original histories unchanged");
    let preserved = h.history(&fresh.forked_session_id, 3).await?;
    verify_fork_prefix(&source, &preserved)
        .map_err(|_| "historical edit mutated original transcript")?;
    let preserved_first = h.history(&original, 1).await?;
    verify_fork_prefix(&first_history, &preserved_first)
        .map_err(|_| "first-message edit mutated original transcript")?;
    if cancel {
        h.cancel_and_restore(&edited, stage).await?;
    }
    Ok(())
}
