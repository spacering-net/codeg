//! `create_automation` / `create_work_task` backing logic + settings
//! persistence.
//!
//! Two surfaces live here, mirroring `crate::commands::session_info`:
//!
//!   * [`DbChatAuthoring`] — the production [`ChatAuthoringAccess`] impl the
//!     delegation listener calls when a chat agent asks codeg to save an
//!     automation or queue a board task. It resolves the target project, builds
//!     the same drafts the editors build, and writes through
//!     `automation_create_core` / `work_task_create_core` so the lists get their
//!     broadcasts and the work-task pump its nudge.
//!   * The `chat_authoring.*` settings knobs (**default false, both**) — read at
//!     MCP injection time via [`ChatAuthoringRuntimeConfig`] to build
//!     `--features`, and AGAIN at write time by [`DbChatAuthoring`] so turning
//!     the switch off takes effect on sessions that are already running.

use std::collections::BTreeMap;
use std::path::Path;
use std::sync::Arc;

use async_trait::async_trait;
use sea_orm::DatabaseConnection;
use serde::{Deserialize, Serialize};

use crate::acp::chat_authoring::{
    local_timezone, AuthoringContext, AuthoringOutcome, ChatAuthoringAccess, ChatAuthoringConfig,
    ChatAuthoringRuntimeConfig, NewAutomationSpec, NewWorkTaskSpec,
};
use crate::acp::types::PromptInputBlock;
use crate::app_error::AppCommandError;
use crate::db::entities::automation::{IsolationMode, TriggerKind};
use crate::db::entities::folder::FolderKind;
use crate::db::service::{app_metadata_service, conversation_service, folder_service};
use crate::db::AppDatabase;
use crate::models::agent::AgentType;
use crate::models::{
    AutomationConfig, AutomationDraft, FolderDetail, WorkTaskConfig, WorkTaskDraft,
};
use crate::web::event_bridge::{emit_event, EventEmitter, CHAT_AUTHORING_SETTINGS_CHANGED_EVENT};

const KIND_AUTOMATION: &str = "automation";
const KIND_WORK_TASK: &str = "work_task";

/// Production [`ChatAuthoringAccess`]. Holds the DB plus the event emitter (so
/// creates broadcast exactly like a UI-driven create) and the runtime config it
/// re-checks before every write.
pub struct DbChatAuthoring {
    pub db: Arc<AppDatabase>,
    pub emitter: EventEmitter,
    pub config: ChatAuthoringRuntimeConfig,
}

impl DbChatAuthoring {
    pub fn new(
        db: Arc<AppDatabase>,
        emitter: EventEmitter,
        config: ChatAuthoringRuntimeConfig,
    ) -> Self {
        Self {
            db,
            emitter,
            config,
        }
    }

    /// Resolve the project the new automation / task belongs to.
    ///
    /// Order: an explicit `folder_path` wins; otherwise the caller's own
    /// conversation; otherwise the working directory the companion was launched
    /// with. Whatever matches is then normalized to its project root — a
    /// worktree folder resolves to the project it was cut from, mirroring the
    /// "turn this message into a task" action in the UI.
    async fn resolve_folder(
        &self,
        ctx: &AuthoringContext,
        folder_path: Option<&str>,
    ) -> Result<FolderDetail, String> {
        let conn = &self.db.conn;
        let folders = folder_service::list_all_folder_details(conn)
            .await
            .map_err(|e| format!("could not read the folder list: {e}"))?;

        let found = if let Some(raw) = folder_path {
            match match_folder_by_path(&folders, raw) {
                Some(f) => f,
                None => {
                    // "known to codeg" — the lookup spans every non-deleted
                    // folder row, which includes projects the user has opened
                    // before but currently has closed.
                    return Err(format!(
                        "no project matching '{raw}' is known to codeg. Open the project first, \
                         or omit folder_path to use the one this conversation is in."
                    ));
                }
            }
        } else {
            let from_conversation = match ctx.conversation_id {
                Some(id) => conversation_service::get_by_id(conn, id)
                    .await
                    .ok()
                    .and_then(|c| folders.iter().find(|f| f.id == c.folder_id).cloned()),
                None => None,
            };
            match from_conversation
                .or_else(|| match_folder_by_path(&folders, &ctx.working_dir.to_string_lossy()))
            {
                Some(f) => f,
                None => {
                    return Err(
                        "could not tell which project this conversation belongs to. \
                                Pass folder_path with the absolute path of the target project."
                            .to_string(),
                    );
                }
            }
        };

        // Worktree folders are flattened (a worktree of a worktree still points
        // at the original root), so one hop is always enough.
        let root = match found.parent_id {
            Some(parent_id) => folders
                .iter()
                .find(|f| f.id == parent_id)
                .cloned()
                .unwrap_or(found),
            None => found,
        };
        if root.kind != FolderKind::Regular || root.parent_id.is_some() {
            return Err(format!(
                "'{}' is not a project folder that can hold automations or tasks. \
                 Pass folder_path with the absolute path of the target project.",
                root.path
            ));
        }
        Ok(root)
    }
}

/// Match `raw` against the registered folders: an exact path first, then the
/// longest folder the path lives inside. Component-wise (`Path::starts_with`),
/// so `/repo/app-2` never matches `/repo/app`.
fn match_folder_by_path(folders: &[FolderDetail], raw: &str) -> Option<FolderDetail> {
    let candidate = Path::new(raw.trim());
    if candidate.as_os_str().is_empty() {
        return None;
    }
    folders
        .iter()
        .filter(|f| candidate.starts_with(Path::new(&f.path)))
        // Deepest match wins: a conversation inside a worktree should resolve to
        // that worktree (and then walk up to its project), not straight to some
        // ancestor project that also contains it.
        .max_by_key(|f| Path::new(&f.path).components().count())
        .cloned()
}

/// Validate an agent wire slug (`claude_code`, `custom:<id>`, …). `None` input
/// stays `None` — the caller decides what to fall back to.
fn parse_agent_slug(raw: Option<&str>) -> Result<Option<AgentType>, String> {
    match raw {
        None => Ok(None),
        Some(s) => AgentType::from_wire(s)
            .map(Some)
            .ok_or_else(|| format!("unknown agent_type '{s}'")),
    }
}

/// Wrap a plain prompt string as the single text block both editors produce for
/// a text-only prompt.
fn text_prompt_blocks(prompt: &str) -> Result<Vec<serde_json::Value>, String> {
    let block = PromptInputBlock::Text {
        text: prompt.to_string(),
    };
    Ok(vec![serde_json::to_value(&block).map_err(|e| {
        format!("could not encode the prompt: {e}")
    })?])
}

#[async_trait]
impl ChatAuthoringAccess for DbChatAuthoring {
    async fn create_automation(
        &self,
        ctx: AuthoringContext,
        spec: NewAutomationSpec,
    ) -> AuthoringOutcome {
        // Re-check at call time, not just at injection: a session launched while
        // the switch was on keeps the tool listed after the user turns it off,
        // and "off" has to stop the write.
        if !self.config.automations_enabled().await {
            return AuthoringOutcome::rejected(
                KIND_AUTOMATION,
                "Creating automations from chat is turned off in codeg's settings \
                 (Settings → General → Create from chat). Ask the user to enable it.",
            );
        }
        let folder = match self.resolve_folder(&ctx, spec.folder_path.as_deref()).await {
            Ok(f) => f,
            Err(note) => return AuthoringOutcome::rejected(KIND_AUTOMATION, note),
        };
        let agent = match parse_agent_slug(spec.agent_type.as_deref()) {
            Ok(a) => a,
            Err(note) => return AuthoringOutcome::rejected(KIND_AUTOMATION, note),
        };
        // An automation always runs as a concrete agent (the fire path parses
        // this slug), so resolve a default rather than storing an empty string:
        // the project's configured agent, else whatever the caller is running as.
        let agent = match agent.or(folder.default_agent_type) {
            Some(a) => a,
            None => {
                let from_caller = match ctx.conversation_id {
                    Some(id) => conversation_service::get_by_id(&self.db.conn, id)
                        .await
                        .ok()
                        .map(|c| c.agent_type),
                    None => None,
                };
                match from_caller {
                    Some(a) => a,
                    None => {
                        return AuthoringOutcome::rejected(
                            KIND_AUTOMATION,
                            "this project has no default agent — pass agent_type \
                             (e.g. 'claude_code').",
                        );
                    }
                }
            }
        };
        let prompt_blocks = match text_prompt_blocks(&spec.prompt) {
            Ok(b) => b,
            Err(note) => return AuthoringOutcome::rejected(KIND_AUTOMATION, note),
        };
        let config = AutomationConfig {
            action: spec.action,
            prompt_blocks,
            display_text: spec.prompt.clone(),
            mode_id: None,
            config_values: BTreeMap::new(),
            label_snapshot: None,
        };
        let config = match serde_json::to_value(&config) {
            Ok(v) => v,
            Err(e) => {
                return AuthoringOutcome::rejected(
                    KIND_AUTOMATION,
                    format!("could not encode the automation config: {e}"),
                );
            }
        };
        let cron = spec.cron.clone();
        let timezone = spec.timezone.clone().unwrap_or_else(local_timezone);
        let draft = AutomationDraft {
            name: spec.name.clone(),
            enabled: spec.enabled,
            trigger_kind: if cron.is_some() {
                TriggerKind::Schedule
            } else {
                TriggerKind::Manual
            },
            cron: cron.clone(),
            timezone: timezone.clone(),
            agent_type: agent.as_wire().into_owned(),
            root_folder_id: Some(folder.id),
            // A fresh worktree per run is the safe default and the only shape
            // `enqueue_task` accepts; branch / shared-in-root stay an editor-only
            // choice.
            isolation: IsolationMode::WorktreePerRun,
            branch: None,
            is_remote_branch: false,
            config,
        };
        match crate::commands::automation::automation_create_core(&self.emitter, &self.db, draft)
            .await
        {
            Ok(info) => AuthoringOutcome {
                created: true,
                kind: KIND_AUTOMATION.to_string(),
                id: Some(info.id),
                title: Some(info.name),
                folder_name: Some(folder.name),
                folder_path: Some(folder.path),
                agent_type: Some(info.agent_type),
                cron: info.cron,
                timezone: Some(info.timezone),
                next_run_at: info.next_run_at,
                note: (!info.enabled).then(|| {
                    "Saved switched off — the user can enable it on the Automations page."
                        .to_string()
                }),
            },
            // The service's validation errors (bad cron, unknown timezone, empty
            // prompt) are exactly what the LLM should read and retry against, so
            // they come back as a soft note rather than a tool error.
            Err(e) => AuthoringOutcome::rejected(KIND_AUTOMATION, e.to_string()),
        }
    }

    async fn create_work_task(
        &self,
        ctx: AuthoringContext,
        spec: NewWorkTaskSpec,
    ) -> AuthoringOutcome {
        if !self.config.work_tasks_enabled().await {
            return AuthoringOutcome::rejected(
                KIND_WORK_TASK,
                "Creating board tasks from chat is turned off in codeg's settings \
                 (Settings → General → Create from chat). Ask the user to enable it.",
            );
        }
        let folder = match self.resolve_folder(&ctx, spec.folder_path.as_deref()).await {
            Ok(f) => f,
            Err(note) => return AuthoringOutcome::rejected(KIND_WORK_TASK, note),
        };
        let agent = match parse_agent_slug(spec.agent_type.as_deref()) {
            Ok(a) => a,
            Err(note) => return AuthoringOutcome::rejected(KIND_WORK_TASK, note),
        };
        let prompt_blocks = match text_prompt_blocks(&spec.prompt) {
            Ok(b) => b,
            Err(note) => return AuthoringOutcome::rejected(KIND_WORK_TASK, note),
        };
        // `agent_type: None` deliberately stays None — that is "inherit the
        // board's settings", which is what the user configured for this project.
        let config = WorkTaskConfig {
            prompt_blocks,
            display_text: spec.prompt.clone(),
            agent_type: agent.map(|a| a.as_wire().into_owned()),
            mode_id: None,
            config_values: BTreeMap::new(),
            label_snapshot: None,
            deliverable: None,
            // No branch face on the authoring tool: the task branches from the
            // project folder's checkout, as it did before the choice existed.
            base_branch: None,
        };
        let config = match serde_json::to_value(&config) {
            Ok(v) => v,
            Err(e) => {
                return AuthoringOutcome::rejected(
                    KIND_WORK_TASK,
                    format!("could not encode the task config: {e}"),
                );
            }
        };
        let draft = WorkTaskDraft {
            folder_id: folder.id,
            title: spec.title.clone(),
            config,
        };
        match crate::commands::work_task::work_task_create_core(&self.emitter, &self.db, draft)
            .await
        {
            Ok(info) => AuthoringOutcome {
                created: true,
                kind: KIND_WORK_TASK.to_string(),
                id: Some(info.id),
                title: Some(info.title),
                folder_name: Some(folder.name),
                folder_path: Some(folder.path),
                agent_type: spec.agent_type.clone(),
                note: Some(
                    "Queued as a to-do; the user starts it from there \
                     (or auto-processing picks it up)."
                        .to_string(),
                ),
                ..Default::default()
            },
            Err(e) => AuthoringOutcome::rejected(KIND_WORK_TASK, e.to_string()),
        }
    }
}

// ===========================================================================
// Settings persistence — `chat_authoring.automations_enabled` /
// `chat_authoring.work_tasks_enabled` (both default OFF). Mirrors
// `crate::commands::session_info`.
// ===========================================================================

pub const KEY_CHAT_AUTHORING_AUTOMATIONS: &str = "chat_authoring.automations_enabled";
pub const KEY_CHAT_AUTHORING_WORK_TASKS: &str = "chat_authoring.work_tasks_enabled";

/// Off by default, unlike the read-only `get_session_info` / `ask_user_question`
/// toggles: these tools write app state and a scheduled automation goes on to
/// spawn agents unattended, so the user opts in.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct ChatAuthoringSettings {
    pub automations_enabled: bool,
    pub work_tasks_enabled: bool,
}

impl ChatAuthoringSettings {
    fn into_runtime_config(self) -> ChatAuthoringConfig {
        ChatAuthoringConfig {
            automations_enabled: self.automations_enabled,
            work_tasks_enabled: self.work_tasks_enabled,
        }
    }
}

async fn load_flag(conn: &DatabaseConnection, key: &str) -> bool {
    match app_metadata_service::get_value(conn, key).await {
        Ok(Some(raw)) => raw.parse::<bool>().unwrap_or(false),
        _ => false,
    }
}

/// Read the persisted keys from `app_metadata`, falling back to the default
/// (both off) for a missing or malformed value. Never errors hard.
pub async fn load_chat_authoring_settings(conn: &DatabaseConnection) -> ChatAuthoringSettings {
    ChatAuthoringSettings {
        automations_enabled: load_flag(conn, KEY_CHAT_AUTHORING_AUTOMATIONS).await,
        work_tasks_enabled: load_flag(conn, KEY_CHAT_AUTHORING_WORK_TASKS).await,
    }
}

/// Pull settings from the DB and push the resulting [`ChatAuthoringConfig`] onto
/// the shared runtime handle. Idempotent — safe on startup or after any save.
pub async fn apply_persisted_chat_authoring_config(
    conn: &DatabaseConnection,
    config: &ChatAuthoringRuntimeConfig,
) {
    let settings = load_chat_authoring_settings(conn).await;
    config.set(settings.into_runtime_config()).await;
}

/// Serializes every write to this record within the process.
///
/// Per-key upserts alone are not enough. Both writers below finish by re-reading
/// the record and pushing it onto the runtime config, and `load_*` reads the two
/// keys in two separate queries — so two writers can interleave such that the
/// database ends correct while the runtime handle (which is what the companion
/// injection actually reads) settles on a value neither writer intended, and
/// stays there until the next write or a restart. Holding this across
/// write → re-read → apply → broadcast makes the sequence atomic.
static AUTHORING_WRITE_LOCK: std::sync::LazyLock<tokio::sync::Mutex<()>> =
    std::sync::LazyLock::new(|| tokio::sync::Mutex::new(()));

/// Which of the two independent switches in the record to move.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChatAuthoringFlag {
    Automations,
    WorkTasks,
}

/// Move exactly one switch, leaving the sibling to whatever the database says
/// at the moment of the write.
///
/// [`set_chat_authoring_settings_core`] republishes both keys, which is right
/// for the settings form (it edits both) and wrong for any caller that only
/// means to move one: two such callers racing — the status-bar popover's two
/// adjacent switches are one click apart — each read the pair, each write the
/// pair back, and whoever lands second silently reverts the other's flip. This
/// writes one key and then re-reads the record, so concurrent flips of the two
/// switches commute and the broadcast carries the record as it now stands
/// rather than as the caller imagined it.
pub async fn set_chat_authoring_flag_core(
    conn: &DatabaseConnection,
    config: &ChatAuthoringRuntimeConfig,
    emitter: &EventEmitter,
    flag: ChatAuthoringFlag,
    enabled: bool,
) -> Result<ChatAuthoringSettings, AppCommandError> {
    let key = match flag {
        ChatAuthoringFlag::Automations => KEY_CHAT_AUTHORING_AUTOMATIONS,
        ChatAuthoringFlag::WorkTasks => KEY_CHAT_AUTHORING_WORK_TASKS,
    };
    let _guard = AUTHORING_WRITE_LOCK.lock().await;
    app_metadata_service::upsert_value(conn, key, &enabled.to_string())
        .await
        .map_err(AppCommandError::from)?;
    let settings = load_chat_authoring_settings(conn).await;
    config.set(settings.clone().into_runtime_config()).await;
    emit_event(emitter, CHAT_AUTHORING_SETTINGS_CHANGED_EVENT, &settings);
    Ok(settings)
}

/// Persist + apply + broadcast. Shared by the Tauri command and the HTTP handler
/// so the write + re-apply + notify chain lives in one place.
///
/// Takes [`AUTHORING_WRITE_LOCK`] too: its two upserts are not atomic either, so
/// a per-flag write landing between them would be half-overwritten.
pub async fn set_chat_authoring_settings_core(
    conn: &DatabaseConnection,
    config: &ChatAuthoringRuntimeConfig,
    emitter: &EventEmitter,
    desired: ChatAuthoringSettings,
) -> Result<ChatAuthoringSettings, AppCommandError> {
    let _guard = AUTHORING_WRITE_LOCK.lock().await;
    app_metadata_service::upsert_value(
        conn,
        KEY_CHAT_AUTHORING_AUTOMATIONS,
        &desired.automations_enabled.to_string(),
    )
    .await
    .map_err(AppCommandError::from)?;
    app_metadata_service::upsert_value(
        conn,
        KEY_CHAT_AUTHORING_WORK_TASKS,
        &desired.work_tasks_enabled.to_string(),
    )
    .await
    .map_err(AppCommandError::from)?;
    config.set(desired.clone().into_runtime_config()).await;
    emit_event(emitter, CHAT_AUTHORING_SETTINGS_CHANGED_EVENT, &desired);
    Ok(desired)
}

// -------- Tauri commands -----------------------------------------------------

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn get_chat_authoring_settings(
    #[cfg(feature = "tauri-runtime")] db: tauri::State<'_, crate::db::AppDatabase>,
) -> Result<ChatAuthoringSettings, AppCommandError> {
    #[cfg(feature = "tauri-runtime")]
    {
        Ok(load_chat_authoring_settings(&db.conn).await)
    }
    #[cfg(not(feature = "tauri-runtime"))]
    {
        Err(AppCommandError::configuration_invalid("tauri-only command"))
    }
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn set_chat_authoring_settings(
    #[cfg(feature = "tauri-runtime")] app: tauri::AppHandle,
    #[cfg(feature = "tauri-runtime")] db: tauri::State<'_, crate::db::AppDatabase>,
    #[cfg(feature = "tauri-runtime")] config: tauri::State<'_, ChatAuthoringRuntimeConfig>,
    settings: ChatAuthoringSettings,
) -> Result<ChatAuthoringSettings, AppCommandError> {
    #[cfg(feature = "tauri-runtime")]
    {
        let emitter = EventEmitter::Tauri(app);
        set_chat_authoring_settings_core(&db.conn, &config, &emitter, settings).await
    }
    #[cfg(not(feature = "tauri-runtime"))]
    {
        let _ = settings;
        Err(AppCommandError::configuration_invalid("tauri-only command"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Utc;

    fn folder(id: i32, path: &str, parent: Option<i32>, kind: FolderKind) -> FolderDetail {
        FolderDetail {
            id,
            name: path.rsplit('/').next().unwrap_or(path).to_string(),
            path: path.to_string(),
            git_branch: None,
            default_agent_type: None,
            last_opened_at: Utc::now(),
            sort_order: 0,
            color: "blue".into(),
            parent_id: parent,
            kind,
            alias: None,
            group_id: None,
        }
    }

    #[test]
    fn match_folder_by_path_prefers_exact_then_deepest() {
        let folders = vec![
            folder(1, "/repo/app", None, FolderKind::Regular),
            folder(2, "/repo/app-2", None, FolderKind::Regular),
            folder(3, "/repo/app/worktrees/wt", Some(1), FolderKind::Regular),
        ];
        // Exact hit.
        assert_eq!(match_folder_by_path(&folders, "/repo/app").unwrap().id, 1);
        // A sibling whose name merely shares a prefix must NOT match.
        assert_eq!(match_folder_by_path(&folders, "/repo/app-2").unwrap().id, 2);
        // A path inside a folder resolves to the deepest containing folder.
        assert_eq!(
            match_folder_by_path(&folders, "/repo/app/worktrees/wt/src/lib.rs")
                .unwrap()
                .id,
            3
        );
        assert_eq!(
            match_folder_by_path(&folders, "/repo/app/src/lib.rs")
                .unwrap()
                .id,
            1
        );
        // Nothing registered under this path.
        assert!(match_folder_by_path(&folders, "/elsewhere").is_none());
        assert!(match_folder_by_path(&folders, "   ").is_none());
    }

    #[test]
    fn parse_agent_slug_validates() {
        assert_eq!(parse_agent_slug(None).unwrap(), None);
        assert_eq!(
            parse_agent_slug(Some("claude_code")).unwrap(),
            Some(AgentType::ClaudeCode)
        );
        assert!(parse_agent_slug(Some("not_an_agent")).is_err());
    }

    #[test]
    fn text_prompt_blocks_is_one_text_block() {
        let blocks = text_prompt_blocks("do the thing").unwrap();
        assert_eq!(blocks.len(), 1);
        assert_eq!(blocks[0]["type"], "text");
        assert_eq!(blocks[0]["text"], "do the thing");
    }

    #[test]
    fn settings_default_is_both_off() {
        let s = ChatAuthoringSettings::default();
        assert!(!s.automations_enabled);
        assert!(!s.work_tasks_enabled);
    }

    // ── integration: the real write path against an in-memory DB ────────────

    use crate::db::service::{automation_service, work_task_service};
    use crate::db::test_helpers::fresh_in_memory_db;

    /// Wire a `DbChatAuthoring` over a fresh DB with both flags set as given.
    async fn harness(
        automations: bool,
        work_tasks: bool,
    ) -> (
        Arc<AppDatabase>,
        DbChatAuthoring,
        ChatAuthoringRuntimeConfig,
    ) {
        let db = Arc::new(fresh_in_memory_db().await);
        let config = ChatAuthoringRuntimeConfig::new();
        config
            .set(ChatAuthoringConfig {
                automations_enabled: automations,
                work_tasks_enabled: work_tasks,
            })
            .await;
        let access = DbChatAuthoring::new(db.clone(), EventEmitter::Noop, config.clone());
        (db, access, config)
    }

    fn ctx_at(dir: &str) -> AuthoringContext {
        AuthoringContext {
            conversation_id: None,
            working_dir: std::path::PathBuf::from(dir),
        }
    }

    fn automation_spec() -> NewAutomationSpec {
        NewAutomationSpec {
            name: "Nightly audit".into(),
            prompt: "audit the dependencies".into(),
            cron: Some("0 3 * * *".into()),
            timezone: Some("UTC".into()),
            action: Default::default(),
            agent_type: Some("claude_code".into()),
            folder_path: None,
            enabled: true,
        }
    }

    fn work_task_spec() -> NewWorkTaskSpec {
        NewWorkTaskSpec {
            title: "Fix the flake".into(),
            prompt: "the retry test is flaky".into(),
            agent_type: None,
            folder_path: None,
        }
    }

    /// The headline invariant: with the switch off the tool writes NOTHING, even
    /// though the companion may still be advertising it (it was injected while
    /// the switch was on). The injection-time check alone would let this through.
    #[tokio::test]
    async fn create_automation_refuses_and_writes_nothing_when_disabled() {
        let (db, access, _cfg) = harness(false, true).await;
        folder_service::add_folder(&db.conn, "/repo/app")
            .await
            .unwrap();

        let out = access
            .create_automation(ctx_at("/repo/app"), automation_spec())
            .await;

        assert!(!out.created);
        assert_eq!(out.kind, "automation");
        assert!(out.note.unwrap().contains("turned off"));
        assert!(automation_service::list(&db.conn).await.unwrap().is_empty());
    }

    /// …and the two flags gate independently: automations on must not unlock the
    /// board tool.
    #[tokio::test]
    async fn create_work_task_refuses_when_only_automations_enabled() {
        let (db, access, _cfg) = harness(true, false).await;
        folder_service::add_folder(&db.conn, "/repo/app")
            .await
            .unwrap();

        let out = access
            .create_work_task(ctx_at("/repo/app"), work_task_spec())
            .await;

        assert!(!out.created);
        assert!(out.note.unwrap().contains("turned off"));
        assert!(work_task_service::list(&db.conn, None)
            .await
            .unwrap()
            .is_empty());
    }

    /// Flipping the shared runtime handle takes effect on the NEXT call — no
    /// reconstruction of the access impl needed. This is what makes the call-time
    /// check meaningful for an already-running session.
    #[tokio::test]
    async fn flipping_the_flag_takes_effect_on_the_next_call() {
        let (db, access, cfg) = harness(false, false).await;
        folder_service::add_folder(&db.conn, "/repo/app")
            .await
            .unwrap();

        assert!(
            !access
                .create_automation(ctx_at("/repo/app"), automation_spec())
                .await
                .created
        );
        cfg.set(ChatAuthoringConfig {
            automations_enabled: true,
            work_tasks_enabled: false,
        })
        .await;
        let out = access
            .create_automation(ctx_at("/repo/app"), automation_spec())
            .await;
        assert!(out.created, "note: {:?}", out.note);
        assert_eq!(automation_service::list(&db.conn).await.unwrap().len(), 1);
    }

    /// A successful create lands a real row with the shape the fire path expects,
    /// and reports back the schedule the scheduler actually computed.
    #[tokio::test]
    async fn create_automation_persists_a_fireable_row() {
        let (db, access, _cfg) = harness(true, false).await;
        let folder = folder_service::add_folder(&db.conn, "/repo/app")
            .await
            .unwrap();

        let out = access
            .create_automation(ctx_at("/repo/app"), automation_spec())
            .await;
        assert!(out.created, "note: {:?}", out.note);
        assert_eq!(out.folder_path.as_deref(), Some("/repo/app"));
        assert!(
            out.next_run_at.is_some(),
            "a scheduled automation has a next run"
        );

        let row = automation_service::get(&db.conn, out.id.unwrap())
            .await
            .unwrap();
        assert_eq!(row.root_folder_id, Some(folder.id));
        assert_eq!(row.agent_type, "claude_code");
        assert_eq!(row.cron.as_deref(), Some("0 3 * * *"));
        assert_eq!(row.isolation, IsolationMode::WorktreePerRun);
        assert!(row.branch.is_none());
        // The fire path parses this slug and replays these blocks verbatim.
        let cfg: AutomationConfig = serde_json::from_value(row.config).unwrap();
        assert_eq!(cfg.prompt_blocks.len(), 1);
        assert_eq!(cfg.prompt_blocks[0]["text"], "audit the dependencies");
        assert_eq!(cfg.display_text, "audit the dependencies");
    }

    /// A chat running inside a worktree targets the PROJECT, not the worktree —
    /// the board and the automations list are both project-scoped.
    #[tokio::test]
    async fn create_work_task_resolves_a_worktree_to_its_project() {
        let (db, access, _cfg) = harness(false, true).await;
        let root = folder_service::add_folder(&db.conn, "/repo/app")
            .await
            .unwrap();
        folder_service::add_folder_with_parent(&db.conn, "/repo/app-task-1", Some(root.id))
            .await
            .unwrap();

        // Deep inside the worktree, so the deepest-match + parent-hop both run.
        let out = access
            .create_work_task(ctx_at("/repo/app-task-1/src"), work_task_spec())
            .await;

        assert!(out.created, "note: {:?}", out.note);
        let row = work_task_service::get(&db.conn, out.id.unwrap())
            .await
            .unwrap();
        assert_eq!(row.folder_id, root.id, "task belongs to the project root");
        // No agent override — the task inherits the board's configured default.
        let cfg: WorkTaskConfig = serde_json::from_value(row.config).unwrap();
        assert!(cfg.agent_type.is_none());
        assert_eq!(cfg.prompt_blocks.len(), 1);
    }

    /// An unresolvable target is a soft refusal telling the LLM what to pass —
    /// never a silent write to some arbitrary folder.
    #[tokio::test]
    async fn unresolvable_folder_is_a_soft_refusal() {
        let (db, access, _cfg) = harness(true, true).await;
        folder_service::add_folder(&db.conn, "/repo/app")
            .await
            .unwrap();

        // Working dir outside every registered folder.
        let out = access
            .create_automation(ctx_at("/somewhere/else"), automation_spec())
            .await;
        assert!(!out.created);
        assert!(out.note.unwrap().contains("folder_path"));

        // An explicit path that is not a registered folder.
        let mut spec = work_task_spec();
        spec.folder_path = Some("/not/registered".into());
        let out = access.create_work_task(ctx_at("/repo/app"), spec).await;
        assert!(!out.created);
        assert!(out.note.unwrap().contains("/not/registered"));
        assert!(work_task_service::list(&db.conn, None)
            .await
            .unwrap()
            .is_empty());
    }

    /// Settings persist and re-apply onto the shared runtime handle, so a save in
    /// one transport is visible to MCP injection and to the write path.
    #[tokio::test]
    async fn settings_persist_and_reapply_to_the_runtime_handle() {
        let db = fresh_in_memory_db().await;
        let config = ChatAuthoringRuntimeConfig::new();

        // Nothing stored yet → both off.
        apply_persisted_chat_authoring_config(&db.conn, &config).await;
        assert_eq!(config.snapshot().await, ChatAuthoringConfig::default());

        set_chat_authoring_settings_core(
            &db.conn,
            &config,
            &EventEmitter::Noop,
            ChatAuthoringSettings {
                automations_enabled: true,
                work_tasks_enabled: false,
            },
        )
        .await
        .unwrap();
        assert!(config.automations_enabled().await);
        assert!(!config.work_tasks_enabled().await);

        // Round-trips through the DB (what a fresh boot reads).
        let loaded = load_chat_authoring_settings(&db.conn).await;
        assert!(loaded.automations_enabled);
        assert!(!loaded.work_tasks_enabled);
        let fresh = ChatAuthoringRuntimeConfig::new();
        apply_persisted_chat_authoring_config(&db.conn, &fresh).await;
        assert!(fresh.automations_enabled().await);
        assert!(!fresh.work_tasks_enabled().await);
    }
}
