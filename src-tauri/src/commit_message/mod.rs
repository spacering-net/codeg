//! Writing a commit message with an agent: the ✨ button by the commit box.
//!
//! One click is one run: read exactly what the commit would contain
//! ([`scope`]), turn it into a request ([`prompt`]), and have the chosen agent
//! answer it on a hidden throwaway session ([`crate::acp::one_shot`]) — no
//! conversation row, no tools, nothing for anyone to approve. The answer goes
//! back to the box it was asked from, with whether the settings want it
//! committed right away; the commit is the box's own, as if the user had
//! pressed it.
//!
//! Which settings: the folder's own, else its repository's (for a worktree
//! folder), else the global ones ([`effective_settings`]). Which agent: the
//! one picked there, else the agent of the session the user is looking at
//! (the caller's `fallback_agent`), else the folder's default agent.

pub(crate) mod prompt;
pub(crate) mod scope;

use std::collections::{BTreeMap, HashMap};
use std::path::Path;
use std::sync::{Mutex, OnceLock};

use serde::{Deserialize, Deserializer, Serialize};
use tokio_util::sync::CancellationToken;

use crate::acp::manager::ConnectionManager;
use crate::acp::one_shot::{self, OneShotError, OneShotRequest};
use crate::app_error::{AppCommandError, AppErrorCode};
use crate::db::service::{app_metadata_service, folder_service};
use crate::db::AppDatabase;
use crate::models::agent::AgentType;
use crate::models::AssistantAgentConfig;

/// `app_metadata` key of the global settings. A project folder's own settings
/// are kept under `<this>:folder:<id>`.
const SETTINGS_KEY: &str = "commit_message_generation";

fn settings_key(folder_id: Option<i32>) -> String {
    match folder_id {
        Some(id) => format!("{SETTINGS_KEY}:folder:{id}"),
        None => SETTINGS_KEY.to_string(),
    }
}

/// How the generator runs, saved globally and, if the user wants, for a
/// project folder — whose own settings then replace the global ones whole.
/// Everything optional: with nothing set it follows the session in front of
/// the user (see the module docs).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct CommitMessageSettings {
    /// The agent that writes messages with every option it offers picked —
    /// an assistant's kind of selection, checked the same way. `None` follows
    /// the active session. One that no longer reads (its agent is gone) reads
    /// back as `None`, without taking the rest of the settings with it.
    #[serde(deserialize_with = "lenient_agent_config")]
    pub agent: Option<AssistantAgentConfig>,
    /// The user's standing instructions, e.g. "write in Chinese".
    pub instructions: String,
    /// Commit as soon as the message is written.
    pub auto_commit: bool,
}

fn lenient_agent<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<AgentType>, D::Error> {
    let raw = Option::<String>::deserialize(deserializer)?;
    Ok(raw.as_deref().and_then(AgentType::from_wire))
}

fn lenient_agent_config<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<AssistantAgentConfig>, D::Error> {
    let raw = Option::<serde_json::Value>::deserialize(deserializer)?;
    Ok(raw.and_then(|value| serde_json::from_value(value).ok()))
}

/// The settings saved for a project folder, or with `None` the global ones;
/// `None` when there are none — a folder that follows the global settings.
pub async fn load_settings(
    conn: &sea_orm::DatabaseConnection,
    folder_id: Option<i32>,
) -> Option<CommitMessageSettings> {
    let key = settings_key(folder_id);
    match app_metadata_service::get_value(conn, &key).await {
        Ok(Some(raw)) => serde_json::from_str(&raw)
            .map_err(|e| tracing::warn!("[commit-message] unreadable settings {key}, skipped: {e}"))
            .ok(),
        Ok(None) => None,
        Err(e) => {
            tracing::warn!("[commit-message] could not read settings {key}: {e}");
            None
        }
    }
}

/// What a generation in `folder_id` runs with: the folder's own settings,
/// else its repository's (a worktree folder's parent), else the global ones,
/// else the defaults.
pub async fn effective_settings(
    conn: &sea_orm::DatabaseConnection,
    folder_id: Option<i32>,
) -> CommitMessageSettings {
    let mut next = folder_id;
    for _ in 0..2 {
        let Some(id) = next else { break };
        if let Some(own) = load_settings(conn, Some(id)).await {
            return own;
        }
        next = match folder_service::get_folder_by_id(conn, id).await {
            Ok(Some(folder)) => folder.parent_id,
            _ => None,
        };
    }
    load_settings(conn, None).await.unwrap_or_default()
}

/// Save a project folder's own settings, or with `None` the global ones.
pub async fn save_settings(
    conn: &sea_orm::DatabaseConnection,
    folder_id: Option<i32>,
    settings: &CommitMessageSettings,
) -> Result<(), AppCommandError> {
    if let Some(agent) = &settings.agent {
        agent.validate().map_err(|e| {
            AppCommandError::invalid_input("Invalid agent selection").with_detail(e)
        })?;
    }
    let raw = serde_json::to_string(settings).map_err(|e| {
        AppCommandError::invalid_input("Invalid settings").with_detail(e.to_string())
    })?;
    app_metadata_service::upsert_value(conn, &settings_key(folder_id), &raw)
        .await
        .map_err(AppCommandError::from)
}

/// Drop a project folder's own settings: it follows the global ones again.
pub async fn delete_settings(
    conn: &sea_orm::DatabaseConnection,
    folder_id: i32,
) -> Result<(), AppCommandError> {
    app_metadata_service::delete_value(conn, &settings_key(Some(folder_id)))
        .await
        .map_err(AppCommandError::from)
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GenerateRequest {
    /// Chosen by the caller, so it can cancel the run while waiting for it.
    pub request_id: String,
    /// The repository folder, as `git_commit` takes it.
    pub path: String,
    pub folder_id: Option<i32>,
    /// The files the commit would stage (see `git_commit_core`).
    pub files: Vec<String>,
    /// What the user had already typed, if anything: the run's hint.
    #[serde(default)]
    pub draft: Option<String>,
    /// The agent of the session the user is looking at, used when the
    /// settings name none.
    #[serde(default, deserialize_with = "lenient_agent")]
    pub fallback_agent: Option<AgentType>,
}

#[derive(Debug, Clone, Serialize)]
pub struct GeneratedCommitMessage {
    pub message: String,
    pub agent_type: AgentType,
    /// The settings the run used want the message committed right away.
    pub auto_commit: bool,
}

/// i18n keys of the errors the UI words itself (namespace
/// `CommitMessageGeneration`). Everything else carries the agent's or git's
/// own message.
const ERR_NO_CHANGES: &str = "errors.noChanges";
const ERR_NO_AGENT: &str = "errors.noAgent";
const ERR_EMPTY_ANSWER: &str = "errors.emptyAnswer";
const ERR_CANCELLED: &str = "errors.cancelled";

fn localized(code: AppErrorCode, key: &str, message: &str) -> AppCommandError {
    AppCommandError::new(code, message).with_i18n(key, BTreeMap::new())
}

/// Write a message for `request`. See the module docs.
pub async fn generate(
    db: &AppDatabase,
    manager: &ConnectionManager,
    data_dir: &Path,
    request: GenerateRequest,
) -> Result<GeneratedCommitMessage, AppCommandError> {
    let GenerateRequest {
        request_id,
        path,
        folder_id,
        files,
        draft,
        fallback_agent,
    } = request;
    // First, so a cancel for this id is honoured however early it came.
    let registration = Inflight::register(&request_id)?;

    let settings = effective_settings(&db.conn, folder_id).await;
    let (agent_type, mode_id, config_values) =
        resolve_agent(&db.conn, &settings, fallback_agent, folder_id).await?;
    let scope = scope::read(&path, &files).await?;
    if scope.files.is_empty() {
        return Err(localized(
            AppErrorCode::InvalidInput,
            ERR_NO_CHANGES,
            "There are no changes to describe",
        ));
    }
    let nonce = uuid::Uuid::new_v4().simple().to_string();
    let prompt = prompt::build(&prompt::PromptInput {
        scope: &scope,
        draft: draft.as_deref(),
        instructions: Some(settings.instructions.as_str()),
        nonce: &nonce[..12],
    });

    let answer = one_shot::run(
        manager,
        db,
        data_dir,
        OneShotRequest {
            agent_type,
            mode_id,
            config_values,
            prompt,
        },
        &registration.token,
    )
    .await
    .map_err(|e| match e {
        OneShotError::Unavailable(message) => {
            AppCommandError::new(AppErrorCode::DependencyMissing, message)
        }
        OneShotError::Failed(message) => AppCommandError::task_execution_failed(message),
        OneShotError::Cancelled => localized(
            AppErrorCode::TaskExecutionFailed,
            ERR_CANCELLED,
            "Generation was stopped",
        ),
    })?;
    let message = prompt::clean(&answer);
    if message.is_empty() {
        return Err(localized(
            AppErrorCode::TaskExecutionFailed,
            ERR_EMPTY_ANSWER,
            "The agent's answer had no commit message in it",
        ));
    }
    Ok(GeneratedCommitMessage {
        message,
        agent_type,
        auto_commit: settings.auto_commit,
    })
}

/// Stop the run started under `request_id`. Also works when the cancel
/// overtakes its own request: the run then stops as soon as it starts.
pub fn cancel(request_id: &str) {
    let mut runs = inflight().lock().unwrap_or_else(|e| e.into_inner());
    match runs.get(request_id) {
        Some(token) => token.cancel(),
        None => {
            // A tombstone for a request still on its way; consumed when it
            // registers. Ones that never arrive are cleared out before the
            // map grows past a handful of them.
            if runs.len() >= MAX_TOMBSTONES {
                runs.retain(|_, token| !token.is_cancelled());
            }
            let token = CancellationToken::new();
            token.cancel();
            runs.insert(request_id.to_string(), token);
        }
    }
}

const MAX_TOMBSTONES: usize = 64;

fn inflight() -> &'static Mutex<HashMap<String, CancellationToken>> {
    static RUNS: OnceLock<Mutex<HashMap<String, CancellationToken>>> = OnceLock::new();
    RUNS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// A run's entry in the in-flight map, removed however the run ends.
struct Inflight {
    request_id: String,
    token: CancellationToken,
}

impl Inflight {
    fn register(request_id: &str) -> Result<Self, AppCommandError> {
        if request_id.trim().is_empty() {
            return Err(AppCommandError::invalid_input("A request id is required"));
        }
        let mut runs = inflight().lock().unwrap_or_else(|e| e.into_inner());
        if let Some(existing) = runs.get(request_id) {
            if existing.is_cancelled() {
                runs.remove(request_id);
                return Err(localized(
                    AppErrorCode::TaskExecutionFailed,
                    ERR_CANCELLED,
                    "Generation was stopped",
                ));
            }
            return Err(AppCommandError::already_exists(
                "A generation with this request id is already running",
            ));
        }
        let token = CancellationToken::new();
        runs.insert(request_id.to_string(), token.clone());
        Ok(Self {
            request_id: request_id.to_string(),
            token,
        })
    }
}

impl Drop for Inflight {
    fn drop(&mut self) {
        let mut runs = inflight().lock().unwrap_or_else(|e| e.into_inner());
        runs.remove(&self.request_id);
    }
}

/// The agent to run, with the selections to start it with.
async fn resolve_agent(
    conn: &sea_orm::DatabaseConnection,
    settings: &CommitMessageSettings,
    fallback_agent: Option<AgentType>,
    folder_id: Option<i32>,
) -> Result<(AgentType, Option<String>, BTreeMap<String, String>), AppCommandError> {
    if let Some(agent) = &settings.agent {
        return Ok((
            agent.agent_type,
            agent.agent_options.mode_id.clone(),
            agent.agent_options.config_values.clone(),
        ));
    }
    if let Some(agent) = fallback_agent {
        return Ok((agent, None, BTreeMap::new()));
    }
    // The folder's default agent, or its repository's for a worktree folder.
    let mut next = folder_id;
    for _ in 0..2 {
        let Some(id) = next else { break };
        let Ok(Some(folder)) = folder_service::get_folder_by_id(conn, id).await else {
            break;
        };
        if let Some(agent) = folder.default_agent_type {
            return Ok((agent, None, BTreeMap::new()));
        }
        next = folder.parent_id;
    }
    Err(localized(
        AppErrorCode::ConfigurationMissing,
        ERR_NO_AGENT,
        "No agent to write the commit message: pick one in the commit message settings",
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::acp::delegation::types::AgentDelegationDefaults;
    use crate::db::test_helpers::{fresh_in_memory_db, seed_folder};
    use crate::models::{AssistantLabelSnapshot, AssistantOptionKind, AssistantOptionLabel};

    fn claude_on_haiku() -> AssistantAgentConfig {
        AssistantAgentConfig {
            agent_type: AgentType::ClaudeCode,
            agent_options: AgentDelegationDefaults {
                mode_id: None,
                config_values: BTreeMap::from([("model".to_string(), "haiku".to_string())]),
            },
            label_snapshot: AssistantLabelSnapshot {
                agent: "Claude Code".to_string(),
                mode: None,
                options: vec![AssistantOptionLabel {
                    id: "model".to_string(),
                    kind: AssistantOptionKind::Select,
                    name: "Model".to_string(),
                    value_label: "Haiku".to_string(),
                }],
            },
        }
    }

    #[test]
    fn settings_round_trip_and_tolerate_a_vanished_agent() {
        let settings = CommitMessageSettings {
            agent: Some(claude_on_haiku()),
            instructions: "Write in Chinese.".to_string(),
            auto_commit: true,
        };
        let raw = serde_json::to_string(&settings).unwrap();
        assert_eq!(
            serde_json::from_str::<CommitMessageSettings>(&raw).unwrap(),
            settings
        );

        // An agent that is gone takes its selection along, not the rest.
        let mut stale: serde_json::Value = serde_json::from_str(&raw).unwrap();
        stale["agent"]["agent_type"] = "no_such_agent".into();
        let stale: CommitMessageSettings = serde_json::from_value(stale).unwrap();
        assert_eq!(stale.agent, None);
        assert_eq!(stale.instructions, "Write in Chinese.");
        assert!(stale.auto_commit);

        let empty: CommitMessageSettings = serde_json::from_str("{}").unwrap();
        assert_eq!(empty, CommitMessageSettings::default());
    }

    #[tokio::test]
    async fn a_folder_runs_with_its_own_settings_else_its_repositorys_else_the_global_ones() {
        let db = fresh_in_memory_db().await;
        let repo = seed_folder(&db, "/tmp/cm-repo").await;
        let worktree =
            folder_service::add_folder_with_parent(&db.conn, "/tmp/cm-repo-wt", Some(repo))
                .await
                .unwrap()
                .id;
        let other = seed_folder(&db, "/tmp/cm-other").await;
        assert_eq!(
            effective_settings(&db.conn, Some(worktree)).await,
            CommitMessageSettings::default()
        );

        let global = CommitMessageSettings {
            instructions: "Write in Chinese.".to_string(),
            ..Default::default()
        };
        save_settings(&db.conn, None, &global).await.unwrap();
        let own = CommitMessageSettings {
            agent: Some(claude_on_haiku()),
            auto_commit: true,
            ..Default::default()
        };
        save_settings(&db.conn, Some(repo), &own).await.unwrap();

        // Whole settings: the repository's own don't pick up the global
        // instructions.
        assert_eq!(effective_settings(&db.conn, Some(repo)).await, own);
        assert_eq!(effective_settings(&db.conn, Some(worktree)).await, own);
        assert_eq!(effective_settings(&db.conn, Some(other)).await, global);
        assert_eq!(effective_settings(&db.conn, None).await, global);
        assert_eq!(load_settings(&db.conn, Some(other)).await, None);

        delete_settings(&db.conn, repo).await.unwrap();
        assert_eq!(load_settings(&db.conn, Some(repo)).await, None);
        assert_eq!(effective_settings(&db.conn, Some(worktree)).await, global);
    }

    #[tokio::test]
    async fn an_agent_with_an_option_left_unpicked_is_not_saved() {
        let db = fresh_in_memory_db().await;
        let mut agent = claude_on_haiku();
        agent.agent_options.config_values.clear();
        let settings = CommitMessageSettings {
            agent: Some(agent),
            ..Default::default()
        };
        assert!(save_settings(&db.conn, None, &settings).await.is_err());
        assert_eq!(load_settings(&db.conn, None).await, None);
    }

    #[test]
    fn a_cancel_that_overtakes_its_request_stops_it_at_registration() {
        let id = format!("test-{}", uuid::Uuid::new_v4());
        cancel(&id);
        let err = Inflight::register(&id)
            .err()
            .expect("cancelled before it started");
        assert_eq!(err.i18n_key.as_deref(), Some(ERR_CANCELLED));
        // The tombstone is consumed: the id is free again.
        let run = Inflight::register(&id).expect("registers");
        drop(run);
        assert!(!inflight().lock().unwrap().contains_key(&id));
    }

    #[test]
    fn a_cancel_reaches_a_running_request() {
        let id = format!("test-{}", uuid::Uuid::new_v4());
        let run = Inflight::register(&id).expect("registers");
        assert!(Inflight::register(&id).is_err(), "one run per id");
        cancel(&id);
        assert!(run.token.is_cancelled());
    }
}
