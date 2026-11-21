use std::collections::{BTreeMap, BTreeSet};
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::{catalog_error, invalid, valid_id, HostPlugins, Invocation, ServerModule};
use crate::acp::session_state::{SessionState, ToolCallOutput, ToolCallStatus};
use crate::acp::types::{AcpEvent, ConnectionStatus};
use crate::app_error::{AppCommandError, AppErrorCode};
use crate::db::entities::conversation::{self, ConversationKind};
use crate::db::entities::folder::FolderKind;
use crate::models::{AgentType, FolderDetail};
use crate::web::event_bridge::{emit_event, EventEmitter};

pub const EVENT_CHANNEL: &str = "host-plugins://event";
const TRANSFORM_DEADLINE: Duration = Duration::from_secs(3);
const TOOL_PREVIEW_BYTES: usize = 4 * 1024;

#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
pub enum Event {
    #[serde(rename = "workspace.open.before")]
    OpenBefore,
    #[serde(rename = "workspace.open.after")]
    OpenAfter,
    #[serde(rename = "workspace.close.after")]
    CloseAfter,
    #[serde(rename = "workspace.create.before")]
    WorkspaceCreateBefore,
    #[serde(rename = "workspace.create.after")]
    WorkspaceCreated,
    #[serde(rename = "workspace.archive.after")]
    WorkspaceArchived,
    #[serde(rename = "worktree.create.before")]
    WorktreeCreateBefore,
    #[serde(rename = "worktree.create.after")]
    WorktreeCreated,
    #[serde(rename = "worktree.archive.after")]
    WorktreeArchived,
    #[serde(rename = "session.started")]
    SessionStarted,
    #[serde(rename = "session.turn.started")]
    TurnStarted,
    #[serde(rename = "session.turn.completed")]
    TurnCompleted,
    #[serde(rename = "session.tool.completed")]
    ToolCompleted,
    #[serde(rename = "session.permission.requested")]
    PermissionRequested,
    #[serde(rename = "session.permission.resolved")]
    PermissionResolved,
    #[serde(rename = "agent.close.after")]
    AgentClosed,
    #[serde(rename = "agent.archive.after")]
    AgentArchived,
    #[serde(rename = "agent.open.before")]
    AgentOpenBefore,
    #[serde(rename = "agent.create.before")]
    AgentCreateBefore,
    #[serde(rename = "agent.create.after")]
    AgentCreated,
}

pub(crate) async fn prepare_agent_title(
    emitter: &EventEmitter,
    agent_type: AgentType,
    folder_id: Option<i32>,
    kind: ConversationKind,
    parent_conversation_id: Option<i32>,
    mut title: Option<String>,
) -> Result<Option<String>, AppCommandError> {
    let Some(host) = emitter.host_plugins() else {
        return Ok(title);
    };
    tokio::time::timeout(TRANSFORM_DEADLINE, async {
        for hook in host.lifecycle_handlers(Event::AgentCreateBefore) {
            let source = hook.id.clone();
            let result = host
                .invoke(
                    hook,
                    json!({
                        "agentType": agent_type,
                        "folderId": folder_id,
                        "kind": kind,
                        "parentConversationId": parent_conversation_id,
                        "title": title,
                    }),
                )
                .await
                .map_err(|error| {
                    AppCommandError::new(
                        AppErrorCode::TaskExecutionFailed,
                        format!("Plugin {source} could not prepare the agent"),
                    )
                    .with_detail(error.to_string())
                })?;
            if result.is_null() {
                continue;
            }
            let bad_title = || invalid(format!("Plugin {source} returned an invalid title"));
            let replacement: TitleReplacement =
                serde_json::from_value(result).map_err(|_| bad_title())?;
            if replacement.title.trim().is_empty()
                || replacement.title.chars().count() > 200
                || replacement.title.chars().any(char::is_control)
            {
                return Err(bad_title());
            }
            title = Some(replacement.title);
        }
        Ok(title)
    })
    .await
    .map_err(|_| {
        AppCommandError::new(
            AppErrorCode::TaskExecutionFailed,
            "Agent creation plugin hooks timed out",
        )
    })?
}

pub(crate) fn observe_agent_created(emitter: &EventEmitter, agent: &conversation::Model) {
    if let Some(host) = emitter.host_plugins() {
        host.observe(
            emitter,
            Event::AgentCreated,
            json!({
                "folderId": agent.folder_id,
                "conversationId": agent.id,
                "agentType": agent.agent_type,
                "kind": agent.kind,
                "parentConversationId": agent.parent_id,
                "title": agent.title,
            }),
        );
    }
}

pub(crate) fn observe_agent_close(emitter: &EventEmitter, session: &SessionState, failed: bool) {
    let (Some(host), Some(session_id)) = (emitter.host_plugins(), session.external_id.as_ref())
    else {
        return;
    };
    host.observe(
        emitter,
        Event::AgentClosed,
        json!({
            "folderId": session.folder_id,
            "conversationId": session.conversation_id,
            "connectionId": session.connection_id,
            "agentType": session.agent_type,
            "sessionId": session_id,
            "outcome": if failed { "error" } else { "closed" },
        }),
    );
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum WorktreeOrigin {
    Workspace,
    Automation,
    Task,
    Cli,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Worktree<'a> {
    pub folder_id: Option<i32>,
    pub repository_path: &'a str,
    pub path: &'a str,
    pub branch: Option<&'a str>,
    pub origin: WorktreeOrigin,
}

impl Worktree<'_> {
    pub(crate) async fn destination(
        &self,
        emitter: &EventEmitter,
    ) -> Result<String, AppCommandError> {
        let Some(host) = emitter.host_plugins() else {
            return Ok(self.path.to_owned());
        };
        host.worktree_create_path(self).await
    }

    pub(crate) fn observe(self, emitter: &EventEmitter, event: Event) {
        if let Some(host) = emitter.host_plugins() {
            host.observe(emitter, event, json!(self));
        }
    }
}

impl Event {
    pub(super) fn from_session(payload: &AcpEvent) -> Option<Self> {
        match payload {
            AcpEvent::SessionStarted { .. } => Some(Self::SessionStarted),
            AcpEvent::StatusChanged {
                status: ConnectionStatus::Prompting,
            } => Some(Self::TurnStarted),
            AcpEvent::TurnComplete { .. } => Some(Self::TurnCompleted),
            AcpEvent::PermissionRequest { .. } => Some(Self::PermissionRequested),
            AcpEvent::PermissionResolved { .. } => Some(Self::PermissionResolved),
            _ => None,
        }
    }
}

pub(crate) fn pending_tool_result<'a>(
    emitter: &EventEmitter,
    session: &SessionState,
    payload: &'a AcpEvent,
) -> Option<(Arc<HostPlugins>, &'a str)> {
    let (tool_call_id, status) = match payload {
        AcpEvent::ToolCall {
            tool_call_id,
            status,
            ..
        } => (tool_call_id, status.as_str()),
        AcpEvent::ToolCallUpdate {
            tool_call_id,
            status: Some(status),
            ..
        } => (tool_call_id, status.as_str()),
        _ => return None,
    };
    if !matches!(status, "completed" | "failed")
        || tool_call_id.len() > 256
        || session.conversation_id.is_none()
        || session
            .active_tool_calls
            .get(tool_call_id)
            .is_some_and(|tool| {
                matches!(
                    tool.status,
                    ToolCallStatus::Completed | ToolCallStatus::Failed
                )
            })
    {
        return None;
    }
    let host = emitter.host_plugins()?;
    host.has_lifecycle_observer(Event::ToolCompleted)
        .then_some((host, tool_call_id.as_str()))
}

pub(crate) fn tool_result_input(session: &SessionState, tool_call_id: &str) -> Option<Value> {
    let tool = session.active_tool_calls.get(tool_call_id)?;
    let (output_kind, text) = match &tool.output {
        Some(ToolCallOutput::Text { content }) => ("text", Some(content.as_str())),
        Some(ToolCallOutput::Error { message }) => ("error", Some(message.as_str())),
        Some(ToolCallOutput::Json { .. }) => ("structured", None),
        None => (
            if tool.content.is_some() {
                "text"
            } else {
                "none"
            },
            tool.content.as_deref(),
        ),
    };
    let preview = text.map(|text| {
        let mut end = text.len().min(TOOL_PREVIEW_BYTES);
        while !text.is_char_boundary(end) {
            end -= 1;
        }
        &text[..end]
    });
    Some(json!({
        "folderId": session.folder_id,
        "conversationId": session.conversation_id,
        "connectionId": session.connection_id,
        "agentType": session.agent_type,
        "detail": {
            "toolCallId": tool_call_id,
            "kind": tool.kind,
            "status": tool.status,
            "outputKind": output_kind,
            "outputPreview": preview,
            "previewTruncated": text.zip(preview).is_some_and(|(text, preview)| text.len() != preview.len()),
        },
    }))
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Registration {
    event: Event,
    method: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PathReplacement {
    path: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct LaunchReplacement {
    env: BTreeMap<String, String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct TitleReplacement {
    title: String,
}

pub(super) fn validate(
    hooks: &[Registration],
    server: Option<&ServerModule>,
) -> Result<(), String> {
    if hooks.is_empty() {
        return Ok(());
    }
    let server = server.ok_or("Lifecycle hooks need a plugin server module")?;
    let mut events = BTreeSet::new();
    if hooks.iter().any(|hook| {
        !events.insert(hook.event)
            || !valid_id(&hook.method)
            || hook.method == super::settings::MIGRATION_METHOD
            || server.methods.contains(&hook.method)
    }) {
        return Err("Declare one private server method per lifecycle event".to_owned());
    }
    Ok(())
}

impl HostPlugins {
    fn has_lifecycle_observer(&self, event: Event) -> bool {
        let state = self.state.lock().expect("host plugin state lock");
        state.as_ref().is_ok_and(|state| {
            state.catalog.values().any(|plugin| {
                plugin.enabled
                    && plugin
                        .manifest
                        .contributes
                        .lifecycle_hooks
                        .iter()
                        .any(|hook| hook.event == event)
            })
        })
    }

    fn lifecycle_handlers(&self, event: Event) -> Vec<Invocation> {
        let guard = self.state.lock().expect("host plugin state lock");
        let Ok(state) = guard.as_ref().map_err(|error| catalog_error(error)) else {
            return Vec::new();
        };
        state
            .catalog
            .iter()
            .filter(|(_, plugin)| plugin.enabled)
            .filter_map(|(id, plugin)| {
                let hook = plugin
                    .manifest
                    .contributes
                    .lifecycle_hooks
                    .iter()
                    .find(|hook| hook.event == event)?;
                Invocation::new(id, plugin, hook.method.clone())
            })
            .collect()
    }

    pub async fn workspace_open_path(&self, path: String) -> Result<String, AppCommandError> {
        self.transform_workspace_path(Event::OpenBefore, "open", path)
            .await
    }

    pub(crate) async fn workspace_create_path(
        &self,
        path: String,
    ) -> Result<String, AppCommandError> {
        self.transform_workspace_path(Event::WorkspaceCreateBefore, "create", path)
            .await
    }

    pub(crate) async fn agent_launch_environment(
        &self,
        agent_type: AgentType,
        working_directory: Option<&str>,
        session_id: Option<&str>,
    ) -> Result<BTreeMap<String, String>, AppCommandError> {
        tokio::time::timeout(TRANSFORM_DEADLINE, async {
            let mut env = BTreeMap::new();
            for hook in self.lifecycle_handlers(Event::AgentOpenBefore) {
                let source = hook.id.clone();
                let result = self
                    .invoke(
                        hook,
                        json!({
                            "agentType": agent_type,
                            "workingDirectory": working_directory,
                            "sessionId": session_id,
                            "env": env,
                        }),
                    )
                    .await
                    .map_err(|error| {
                        AppCommandError::new(
                            AppErrorCode::TaskExecutionFailed,
                            format!("Plugin {source} could not prepare the agent launch"),
                        )
                        .with_detail(error.to_string())
                    })?;
                if result.is_null() {
                    continue;
                }
                let updated: LaunchReplacement = serde_json::from_value(result).map_err(|_| {
                    invalid(format!("Plugin {source} must return {{ env }} or null"))
                })?;
                if !valid_launch_environment(&updated.env) {
                    return Err(invalid(format!(
                        "Plugin {source} returned an invalid CODEG_PLUGIN_ environment"
                    )));
                }
                env = updated.env;
            }
            Ok(env)
        })
        .await
        .map_err(|_| {
            AppCommandError::new(
                AppErrorCode::TaskExecutionFailed,
                "Agent launch plugin hooks timed out",
            )
        })?
    }

    async fn transform_workspace_path(
        &self,
        event: Event,
        operation: &str,
        mut path: String,
    ) -> Result<String, AppCommandError> {
        tokio::time::timeout(TRANSFORM_DEADLINE, async {
            for hook in self.lifecycle_handlers(event) {
                let source = hook.id.clone();
                let result = self
                    .invoke(hook, json!({ "path": path }))
                    .await
                    .map_err(|error| {
                        AppCommandError::new(
                            AppErrorCode::TaskExecutionFailed,
                            format!("Plugin {source} could not {operation} the workspace"),
                        )
                        .with_detail(error.to_string())
                    })?;
                if result.is_null() {
                    continue;
                }
                let updated: PathReplacement = serde_json::from_value(result).map_err(|_| {
                    invalid(format!(
                        "Plugin {source} returned an invalid workspace path"
                    ))
                })?;
                if !Path::new(&updated.path).is_absolute() || updated.path.contains('\0') {
                    return Err(invalid(format!(
                        "Plugin {source} must return an absolute workspace path"
                    )));
                }
                path = updated.path;
            }
            Ok(path)
        })
        .await
        .map_err(|_| {
            AppCommandError::new(
                AppErrorCode::TaskExecutionFailed,
                "Workspace plugin hooks timed out",
            )
        })?
    }

    async fn worktree_create_path(
        &self,
        request: &Worktree<'_>,
    ) -> Result<String, AppCommandError> {
        let mut path = request.path.to_owned();
        tokio::time::timeout(TRANSFORM_DEADLINE, async {
            for hook in self.lifecycle_handlers(Event::WorktreeCreateBefore) {
                let source = hook.id.clone();
                let input = Worktree {
                    path: &path,
                    ..*request
                };
                let result = self.invoke(hook, json!(input)).await.map_err(|error| {
                    AppCommandError::new(
                        AppErrorCode::TaskExecutionFailed,
                        format!("Plugin {source} could not prepare the worktree"),
                    )
                    .with_detail(error.to_string())
                })?;
                if result.is_null() {
                    continue;
                }
                let updated: PathReplacement = serde_json::from_value(result).map_err(|_| {
                    invalid(format!("Plugin {source} returned an invalid worktree path"))
                })?;
                if updated.path != path {
                    path = validate_worktree_destination(&updated.path, request.repository_path)
                        .map_err(|error| {
                            invalid(format!(
                                "Plugin {source} returned an invalid worktree destination"
                            ))
                            .with_detail(error)
                        })?;
                }
            }
            Ok(path)
        })
        .await
        .map_err(|_| {
            AppCommandError::new(
                AppErrorCode::TaskExecutionFailed,
                "Worktree plugin hooks timed out",
            )
        })?
    }

    pub(crate) fn observe_workspace(
        self: &Arc<Self>,
        emitter: &EventEmitter,
        event: Event,
        folder: &FolderDetail,
    ) {
        if folder.kind == FolderKind::Regular {
            self.observe(
                emitter,
                event,
                json!({
                    "folderId": folder.id,
                    "path": folder.path,
                    "name": folder.name,
                    "parentId": folder.parent_id
                }),
            );
        }
    }

    pub fn observe(self: &Arc<Self>, emitter: &EventEmitter, event: Event, input: Value) {
        let hooks = self.lifecycle_handlers(event);
        if hooks.is_empty() {
            return;
        }
        let Ok(slot) = self.observer_slots.clone().try_acquire_owned() else {
            tracing::debug!(?event, "Plugin observer queue is full");
            return;
        };
        let host = self.clone();
        let emitter = emitter.clone();
        tokio::spawn(async move {
            let _slot = slot;
            for hook in hooks {
                let plugin_id = hook.id.clone();
                match host.invoke(hook, input.clone()).await {
                    Ok(data) if !data.is_null() => {
                        emit_event(
                            &emitter,
                            EVENT_CHANNEL,
                            json!({
                                "pluginId": plugin_id,
                                "event": event,
                                "folderId": input.get("folderId"),
                                "conversationId": input.get("conversationId"),
                                "data": data
                            }),
                        );
                    }
                    Ok(_) => {}
                    Err(error) => {
                        tracing::debug!(%plugin_id, ?event, %error, "Plugin observer did not complete")
                    }
                }
            }
        });
    }
}

fn valid_launch_environment(env: &BTreeMap<String, String>) -> bool {
    env.len() <= 16
        && env.iter().all(|(name, value)| {
            name.strip_prefix("CODEG_PLUGIN_").is_some_and(|suffix| {
                !suffix.is_empty()
                    && name.len() <= 80
                    && suffix.bytes().all(|byte| {
                        byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b'_'
                    })
            }) && value.len() <= 1024
                && !value.chars().any(char::is_control)
        })
}

fn validate_worktree_destination(path: &str, repository: &str) -> Result<String, String> {
    let destination = Path::new(path);
    if !destination.is_absolute()
        || path.contains('\0')
        || destination
            .components()
            .any(|component| matches!(component, Component::ParentDir))
    {
        return Err("Use an absolute path without parent-directory segments".into());
    }
    let in_git_dir = |path: &Path| {
        path.components().any(|component| {
            matches!(component, Component::Normal(name) if
                name.to_str().is_some_and(|name| name.eq_ignore_ascii_case(".git")))
        })
    };
    if in_git_dir(destination) {
        return Err("The destination is inside a .git directory".into());
    }
    match destination.symlink_metadata() {
        Ok(_) => return Err("The destination already exists".into()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.to_string()),
    }
    // Canonicalize the first existing ancestor so a symlink can neither send
    // Git into its own metadata nor make an existing location appear unused.
    let mut parent = destination
        .parent()
        .ok_or("The destination needs a parent directory")?;
    let parent = loop {
        match parent.canonicalize() {
            Ok(resolved) if resolved.is_dir() => break (parent, resolved),
            Ok(_) => return Err("The destination parent must be a directory".into()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                parent = parent
                    .parent()
                    .ok_or("The destination needs an existing ancestor")?;
            }
            Err(error) => return Err(error.to_string()),
        }
    };
    let suffix = destination
        .strip_prefix(parent.0)
        .map_err(|error| error.to_string())?;
    let resolved: PathBuf = parent.1.join(suffix);
    let repository = Path::new(repository)
        .canonicalize()
        .map_err(|error| error.to_string())?;
    if repository.starts_with(&resolved) || in_git_dir(&resolved) {
        return Err(
            "Choose a destination outside Git metadata and away from the source checkout".into(),
        );
    }
    let resolved = crate::paths::simplify_verbatim_path(&resolved);
    resolved
        .into_os_string()
        .into_string()
        .map_err(|_| "The destination is not UTF-8".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::folders::{
        close_folder_with_plugins, git_remove_worktree_core, git_worktree_add_with_plugins,
        open_folder_with_plugins, register_closed_workspace_with_plugins,
        remove_folder_from_history_core, reopen_folder_with_plugins,
    };
    use crate::db::service::conversation_service;
    use crate::db::service::folder_service;
    use crate::db::test_helpers::fresh_in_memory_db;
    use crate::host_plugins::{source::Registry, Mutation};
    use crate::web::event_bridge::WebEventBroadcaster;

    const EXAMPLE_ID: &str = "codeg.workspace-lifecycle";

    async fn install_lifecycle_example(plugins: &HostPlugins, path: &Path) {
        for (name, content) in [
            (
                "codeg-plugin.json",
                include_str!("../../../examples/plugins/workspace-lifecycle/codeg-plugin.json"),
            ),
            (
                "workspace.mjs",
                include_str!("../../../examples/plugins/workspace-lifecycle/workspace.mjs"),
            ),
            (
                "events.html",
                include_str!("../../../examples/plugins/workspace-lifecycle/events.html"),
            ),
        ] {
            std::fs::write(path.join(name), content).unwrap();
        }
        let preview = plugins
            .preview_install(path.to_str().unwrap(), Registry::Npm, None)
            .await
            .unwrap();
        plugins.confirm_install(preview.ticket).unwrap();
        plugins
            .apply(Mutation::SetEnabled {
                id: EXAMPLE_ID.into(),
                enabled: true,
            })
            .unwrap();
    }

    #[tokio::test]
    async fn user_folder_operations_use_the_hooks_and_publish_scoped_events() {
        let data = tempfile::tempdir().unwrap();
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path();
        let plugins = Arc::new(HostPlugins::new(data.path()));
        install_lifecycle_example(&plugins, path).await;
        assert!(plugins
            .call(EXAMPLE_ID, "before-open".into(), Value::Null)
            .await
            .is_err());

        let broadcaster = Arc::new(WebEventBroadcaster::new());
        let mut stream = broadcaster.subscribe();
        let emitter = EventEmitter::test_web_only(broadcaster);
        let db = fresh_in_memory_db().await;
        let real = path.join("workspace-real");
        std::fs::create_dir(&real).unwrap();
        let folder = open_folder_with_plugins(
            &plugins,
            &emitter,
            &db,
            path.join("workspace-alias").to_string_lossy().into_owned(),
        )
        .await
        .unwrap();
        assert!(folder.path.ends_with("workspace-real"));

        close_folder_with_plugins(&plugins, &emitter, &db, folder.id)
            .await
            .unwrap();
        let mut received = BTreeSet::new();
        while received.len() < 3 {
            let event = tokio::time::timeout(Duration::from_secs(1), stream.recv())
                .await
                .unwrap()
                .unwrap();
            if event.channel == EVENT_CHANNEL {
                assert_eq!(event.payload["pluginId"], EXAMPLE_ID);
                assert_eq!(event.payload["folderId"], folder.id);
                received.insert(event.payload["event"].as_str().unwrap().to_owned());
            }
        }
        assert_eq!(
            received,
            BTreeSet::from([
                "workspace.open.after".into(),
                "workspace.close.after".into(),
                "workspace.create.after".into()
            ])
        );
        plugins
            .apply(Mutation::SetEnabled {
                id: EXAMPLE_ID.into(),
                enabled: false,
            })
            .unwrap();
        let alias = path.join("workspace-alias").to_string_lossy().into_owned();
        assert_eq!(
            plugins.workspace_open_path(alias.clone()).await.unwrap(),
            alias
        );
    }

    #[tokio::test]
    async fn workspace_creation_and_archive_are_scoped_to_persisted_transitions() {
        let data = tempfile::tempdir().unwrap();
        let source = tempfile::tempdir().unwrap();
        let db = fresh_in_memory_db().await;
        let state = crate::app_state::AppState::new_for_test(db, data.path().to_owned());
        install_lifecycle_example(&state.host_plugins, source.path()).await;
        let mut events = state.event_broadcaster.subscribe();
        let alias = source.path().join("workspace-create-alias");
        let real = source.path().join("workspace-real");
        std::fs::create_dir(&real).unwrap();
        let open = || {
            open_folder_with_plugins(
                &state.host_plugins,
                &state.emitter,
                &state.db,
                alias.to_string_lossy().into_owned(),
            )
        };
        let (first, concurrent) = tokio::join!(open(), open());
        let folder = first.unwrap();
        assert_eq!(folder.path, real.to_string_lossy());
        assert_eq!(concurrent.unwrap().id, folder.id);

        close_folder_with_plugins(&state.host_plugins, &state.emitter, &state.db, folder.id)
            .await
            .unwrap();
        reopen_folder_with_plugins(&state.host_plugins, &state.emitter, &state.db, folder.id)
            .await
            .unwrap();
        let archive =
            || remove_folder_from_history_core(&state.emitter, &state.db, folder.path.clone());
        let (first, second) = tokio::join!(archive(), archive());
        first.unwrap();
        second.unwrap();
        assert!(
            crate::db::service::folder_service::get_folder_by_id(&state.db.conn, folder.id)
                .await
                .unwrap()
                .is_none()
        );
        assert!(real.is_dir());
        assert_eq!(open().await.unwrap().id, folder.id);

        let mut counts = std::collections::BTreeMap::new();
        let observe = async {
            while counts.values().sum::<usize>() < 7 {
                let event = events.recv().await.unwrap();
                if event.channel == EVENT_CHANNEL {
                    assert_eq!(event.payload["pluginId"], EXAMPLE_ID);
                    assert_eq!(event.payload["folderId"], folder.id);
                    let name = event.payload["event"].as_str().unwrap();
                    if matches!(name, "workspace.create.after" | "workspace.archive.after") {
                        assert_eq!(event.payload["data"]["path"], folder.path);
                    }
                    *counts.entry(name.to_owned()).or_default() += 1;
                }
            }
        };
        tokio::time::timeout(Duration::from_secs(3), observe)
            .await
            .unwrap();
        assert_eq!(
            counts,
            std::collections::BTreeMap::from([
                ("workspace.archive.after".to_owned(), 1),
                ("workspace.close.after".to_owned(), 1),
                ("workspace.create.after".to_owned(), 1),
                ("workspace.open.after".to_owned(), 4),
            ])
        );
    }

    #[tokio::test]
    async fn workspace_worktree_hooks_place_checkouts_and_report_the_final_path() {
        let data = tempfile::tempdir().unwrap();
        let source = tempfile::tempdir().unwrap();
        let db = fresh_in_memory_db().await;
        let state = crate::app_state::AppState::new_for_test(db, data.path().to_owned());
        install_lifecycle_example(&state.host_plugins, source.path()).await;

        let directory = tempfile::tempdir().unwrap();
        let repo = directory.path();
        for args in [
            vec!["init", "-b", "main"],
            vec![
                "-c",
                "user.name=Codeg",
                "-c",
                "user.email=codeg@example.test",
                "-c",
                "commit.gpgSign=false",
                "commit",
                "--allow-empty",
                "-m",
                "initial",
            ],
        ] {
            let result = crate::process::tokio_command("git")
                .args(args)
                .current_dir(repo)
                .output()
                .await
                .unwrap();
            assert!(
                result.status.success(),
                "{}",
                String::from_utf8_lossy(&result.stderr)
            );
        }
        let repo_path = repo.to_str().unwrap();
        let requested = repo.join("plugin-request");
        let checkout = repo.join("plugin-checkout");
        let checkout_path = requested.to_str().unwrap();
        let folder = open_folder_with_plugins(
            &state.host_plugins,
            &state.emitter,
            &state.db,
            repo_path.into(),
        )
        .await
        .unwrap();
        let mut events = state.event_broadcaster.subscribe();

        for (branch, succeeds) in [("main", false), ("topic", true)] {
            let result = git_worktree_add_with_plugins(
                &state.emitter,
                &state.db,
                repo_path,
                branch,
                checkout_path,
                None,
                true,
            )
            .await;
            assert_eq!(result.is_ok(), succeeds);
            if let Ok(actual) = result {
                let actual = actual.unwrap();
                assert_eq!(
                    Path::new(&actual).canonicalize().unwrap(),
                    checkout.canonicalize().unwrap()
                );
            }
        }
        assert!(!requested.exists());
        let removal = git_remove_worktree_core(
            &state.emitter,
            &state.db,
            repo_path.into(),
            "topic".into(),
            folder.id,
            false,
            false,
        )
        .await
        .unwrap();
        assert!(removal.worktree_path.is_some());
        assert!(!checkout.exists());
        assert!(!removal.branch_deleted);

        let mut received = BTreeSet::new();
        while received.len() < 2 {
            let event = tokio::time::timeout(Duration::from_secs(3), events.recv())
                .await
                .unwrap()
                .unwrap();
            if event.channel != EVENT_CHANNEL {
                continue;
            }
            let Some(name) = event.payload["event"]
                .as_str()
                .filter(|s| s.starts_with("worktree."))
            else {
                continue;
            };
            assert_eq!(event.payload["pluginId"], EXAMPLE_ID);
            assert_eq!(event.payload["folderId"], folder.id);
            let mut data = event.payload["data"].clone();
            let path = data.as_object_mut().unwrap().remove("path").unwrap();
            assert!(path.as_str().unwrap().ends_with("checkout"));
            assert_eq!(
                data,
                json!({
                    "folderId": folder.id,
                    "repositoryPath": repo_path,
                    "branch": "topic",
                    "origin": "workspace",
                })
            );
            assert!(received.insert(name.to_owned()));
        }
        assert_eq!(
            received,
            BTreeSet::from([
                "worktree.create.after".to_owned(),
                "worktree.archive.after".to_owned(),
            ])
        );
        let legacy = git_worktree_add_with_plugins(
            &state.emitter,
            &state.db,
            repo_path,
            "legacy-topic",
            checkout_path,
            None,
            false,
        )
        .await
        .unwrap();
        assert!(legacy.is_none());
        assert!(requested.is_dir());
    }

    #[tokio::test]
    async fn closed_background_registration_reports_only_its_first_insert() {
        let data = tempfile::tempdir().unwrap();
        let source = tempfile::tempdir().unwrap();
        let db = fresh_in_memory_db().await;
        let state = crate::app_state::AppState::new_for_test(db, data.path().to_owned());
        install_lifecycle_example(&state.host_plugins, source.path()).await;

        let project = tempfile::tempdir().unwrap();
        let parent = folder_service::ensure_folder_for_path(
            &state.db.conn,
            project.path().to_str().unwrap(),
        )
        .await
        .unwrap();
        let checkout = project.path().join("checkout");
        std::fs::create_dir(&checkout).unwrap();
        let path = checkout.to_str().unwrap();
        let mut events = state.event_broadcaster.subscribe();
        let register = || {
            register_closed_workspace_with_plugins(&state.emitter, &state.db, path, Some(parent.id))
        };
        let (first, second) = tokio::try_join!(register(), register()).unwrap();
        assert_eq!(first.id, second.id);
        assert_eq!(first.parent_id, Some(parent.id));
        assert!(!folder_service::is_open(&state.db.conn, first.id)
            .await
            .unwrap());

        let created = tokio::time::timeout(Duration::from_secs(3), events.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(created.channel, EVENT_CHANNEL);
        assert_eq!(created.payload["event"], "workspace.create.after");
        assert_eq!(created.payload["folderId"], first.id);
        assert_eq!(created.payload["data"]["parentId"], parent.id);
        assert_eq!(created.payload["data"]["path"], path);
        folder_service::remove_folder(&state.db.conn, path)
            .await
            .unwrap();
        let reopened = register().await.unwrap();
        assert_eq!(reopened.id, first.id);
        assert!(!folder_service::is_open(&state.db.conn, first.id)
            .await
            .unwrap());
        assert!(
            tokio::time::timeout(Duration::from_millis(250), events.recv())
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn agent_teardown_reports_the_closed_session_and_only_one_archive() {
        let data = tempfile::tempdir().unwrap();
        let source = tempfile::tempdir().unwrap();
        let db = fresh_in_memory_db().await;
        let state = crate::app_state::AppState::new_for_test(db, data.path().to_owned());
        install_lifecycle_example(&state.host_plugins, source.path()).await;
        let folder = folder_service::add_folder(&state.db.conn, "/test/teardown")
            .await
            .unwrap();
        let conversation =
            conversation_service::create(&state.db.conn, folder.id, AgentType::Codex, None, None)
                .await
                .unwrap();
        let session_id = "test-teardown-session";
        conversation_service::bind_external_id(&state.db.conn, conversation.id, session_id, &[])
            .await
            .unwrap();
        let mut events = state.event_broadcaster.subscribe();
        let mut session = SessionState::new(
            "closed-connection".into(),
            AgentType::Codex,
            None,
            "main".into(),
            Some(folder.id),
        );
        session.conversation_id = Some(conversation.id);
        session.external_id = Some(session_id.into());
        session.status = ConnectionStatus::Disconnected;
        observe_agent_close(&state.emitter, &session, false);

        let delete = || {
            crate::commands::conversations::delete_conversation_with_cleanup_core(
                &state.emitter,
                &state.db.conn,
                &state.connection_manager,
                conversation.id,
            )
        };
        let (first, second) = tokio::join!(delete(), delete());
        assert_ne!(first.is_ok(), second.is_ok());
        assert!(
            conversation_service::get_by_id(&state.db.conn, conversation.id)
                .await
                .is_err()
        );

        let read = async {
            let mut seen = BTreeSet::new();
            while seen.len() < 2 {
                let event = events.recv().await.unwrap();
                if event.channel != EVENT_CHANNEL {
                    continue;
                }
                assert_eq!(event.payload["folderId"], folder.id);
                assert_eq!(event.payload["conversationId"], conversation.id);
                let data = &event.payload["data"];
                assert_eq!(data["sessionId"], session_id);
                assert_eq!(data["agentType"], "codex");
                let event = event.payload["event"].as_str().unwrap();
                if event == "agent.close.after" {
                    assert_eq!(data["connectionId"], "closed-connection");
                    assert_eq!(data["outcome"], "closed");
                }
                assert!(seen.insert(event.to_owned()));
            }
            seen
        };
        let seen = tokio::time::timeout(Duration::from_secs(3), read)
            .await
            .unwrap();
        assert_eq!(
            seen,
            BTreeSet::from(["agent.archive.after".into(), "agent.close.after".into()])
        );
    }

    #[tokio::test]
    async fn agent_creation_validates_the_title_before_insert_and_observes_the_saved_row() {
        use sea_orm::EntityTrait;

        let data = tempfile::tempdir().unwrap();
        let source = tempfile::tempdir().unwrap();
        let db = fresh_in_memory_db().await;
        let state = crate::app_state::AppState::new_for_test(db, data.path().to_owned());
        std::fs::write(
            source.path().join("codeg-plugin.json"),
            json!({
                "apiVersion": 2,
                "id": "test.agent-creation",
                "name": "Agent Creation",
                "version": "1.0.0",
                "server": { "entry": "agent.mjs", "methods": [] },
                "contributes": { "lifecycleHooks": [
                    { "event": "agent.create.before", "method": "prepare" },
                    { "event": "agent.create.after", "method": "created" }
                ] }
            })
            .to_string(),
        )
        .unwrap();
        std::fs::write(
            source.path().join("agent.mjs"),
            r#"export function handle(method, input) {
                if (method === "created") return input;
                return { title: input.title === "reject" ? "\n" : "Prepared title" };
            }"#,
        )
        .unwrap();
        let preview = state
            .host_plugins
            .preview_install(source.path().to_str().unwrap(), Registry::Npm, None)
            .await
            .unwrap();
        state.host_plugins.confirm_install(preview.ticket).unwrap();
        state
            .host_plugins
            .apply(Mutation::SetEnabled {
                id: "test.agent-creation".into(),
                enabled: true,
            })
            .unwrap();

        let folder = folder_service::add_folder(&state.db.conn, "/test/agent-creation")
            .await
            .unwrap();
        let mut events = state.event_broadcaster.subscribe();
        let create = |title: &str| {
            crate::commands::conversations::create_conversation_with_plugins(
                &state.emitter,
                &state.db.conn,
                folder.id,
                AgentType::Codex,
                Some(title.to_owned()),
            )
        };
        let error = create("reject").await.unwrap_err();
        assert!(error.to_string().contains("invalid title"));
        assert!(conversation::Entity::find()
            .all(&state.db.conn)
            .await
            .unwrap()
            .is_empty());

        let id = create("original title").await.unwrap();
        let saved = conversation_service::get_by_id(&state.db.conn, id)
            .await
            .unwrap();
        assert_eq!(saved.title.as_deref(), Some("Prepared title"));
        let event = tokio::time::timeout(Duration::from_secs(3), events.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(event.channel, EVENT_CHANNEL);
        assert_eq!(event.payload["event"], "agent.create.after");
        assert_eq!(event.payload["folderId"], folder.id);
        assert_eq!(event.payload["conversationId"], id);
        assert_eq!(
            event.payload["data"],
            json!({
                "folderId": folder.id,
                "conversationId": id,
                "agentType": "codex",
                "kind": "regular",
                "parentConversationId": null,
                "title": "Prepared title",
            })
        );
        assert!(
            tokio::time::timeout(Duration::from_millis(250), events.recv())
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn tool_completion_emits_one_scoped_event_with_a_bounded_preview() {
        use crate::web::event_bridge::emit_with_state;

        let data = tempfile::tempdir().unwrap();
        let source = tempfile::tempdir().unwrap();
        let db = fresh_in_memory_db().await;
        let host = crate::app_state::AppState::new_for_test(db, data.path().to_owned());
        install_lifecycle_example(&host.host_plugins, source.path()).await;
        let mut events = host.event_broadcaster.subscribe();
        let mut state = SessionState::new(
            "tool-connection".into(),
            AgentType::Codex,
            None,
            "test".into(),
            Some(12),
        );
        state.conversation_id = Some(23);
        let state = Arc::new(tokio::sync::RwLock::new(state));
        let full_text = format!("{}é", "x".repeat(TOOL_PREVIEW_BYTES - 1));
        emit_with_state(
            &state,
            &host.emitter,
            AcpEvent::ToolCall {
                tool_call_id: "tool-1".into(),
                title: "Example tool".into(),
                kind: "execute".into(),
                status: "in_progress".into(),
                content: None,
                raw_input: Some(r#"{"secret":"example input"}"#.into()),
                raw_output: Some(full_text.clone()),
                locations: None,
                meta: None,
                images: None,
            },
        )
        .await;
        let settled = || AcpEvent::ToolCallUpdate {
            tool_call_id: "tool-1".into(),
            title: None,
            status: Some("completed".into()),
            content: None,
            raw_input: None,
            raw_output: None,
            raw_output_append: None,
            locations: None,
            meta: None,
            images: None,
        };
        emit_with_state(&state, &host.emitter, settled()).await;
        emit_with_state(&state, &host.emitter, settled()).await;
        {
            let state = state.read().await;
            let input = tool_result_input(&state, "tool-1").unwrap();
            assert_eq!(
                input["detail"]["outputPreview"],
                &full_text[..TOOL_PREVIEW_BYTES - 1]
            );
            assert_eq!(input["detail"]["previewTruncated"], true);
            assert!(input["detail"].get("input").is_none());
        }
        let event = tokio::time::timeout(Duration::from_secs(3), events.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(event.channel, EVENT_CHANNEL);
        assert_eq!(event.payload["pluginId"], EXAMPLE_ID);
        assert_eq!(event.payload["event"], "session.tool.completed");
        assert_eq!(event.payload["folderId"], 12);
        assert_eq!(event.payload["conversationId"], 23);
        assert_eq!(
            event.payload["data"],
            json!({ "toolCallId": "tool-1", "status": "completed", "outputKind": "text" })
        );
        assert!(
            tokio::time::timeout(Duration::from_millis(250), events.recv())
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn agent_launch_runs_the_enabled_environment_hook_before_spawning() {
        let data = tempfile::tempdir().unwrap();
        let source = tempfile::tempdir().unwrap();
        let db = fresh_in_memory_db().await;
        let state = crate::app_state::AppState::new_for_test(db, data.path().to_owned());
        install_lifecycle_example(&state.host_plugins, source.path()).await;

        let workspace = data.path().join("plugin-launch-demo");
        let working_directory = workspace.to_str().unwrap();
        let env = state
            .host_plugins
            .agent_launch_environment(AgentType::Codex, Some(working_directory), None)
            .await
            .unwrap();
        assert_eq!(
            env,
            BTreeMap::from([("CODEG_PLUGIN_WORKSPACE_LABEL".into(), "Launch demo".into())])
        );
        assert!(state
            .host_plugins
            .agent_launch_environment(AgentType::Codex, None, None)
            .await
            .unwrap()
            .is_empty());

        state
            .host_plugins
            .apply(Mutation::Remove {
                id: EXAMPLE_ID.into(),
            })
            .unwrap();
        std::fs::write(
            source.path().join("workspace.mjs"),
            r#"export function handle() { return { env: { PATH: "unapproved" } } }"#,
        )
        .unwrap();
        let preview = state
            .host_plugins
            .preview_install(source.path().to_str().unwrap(), Registry::Npm, None)
            .await
            .unwrap();
        state.host_plugins.confirm_install(preview.ticket).unwrap();
        state
            .host_plugins
            .apply(Mutation::SetEnabled {
                id: EXAMPLE_ID.into(),
                enabled: true,
            })
            .unwrap();
        let error = state
            .connection_manager
            .spawn_agent(
                AgentType::Codex,
                Some(working_directory.into()),
                None,
                BTreeMap::new(),
                "test-window".into(),
                state.emitter.clone(),
                None,
                BTreeMap::new(),
            )
            .await
            .unwrap_err();
        assert!(error.to_string().contains(EXAMPLE_ID));
        assert!(error.to_string().contains("CODEG_PLUGIN_"));
        assert!(state.connection_manager.list_connections().await.is_empty());
    }

    #[test]
    fn worktree_destination_rejects_existing_paths_and_git_metadata() {
        let repository = tempfile::tempdir().unwrap();
        let root = repository.path();
        std::fs::create_dir(root.join(".git")).unwrap();
        let source = root.to_str().unwrap();
        for destination in [
            PathBuf::from("relative"),
            root.to_owned(),
            root.join(".git/new"),
            root.join("parent/../checkout"),
        ] {
            assert!(validate_worktree_destination(destination.to_str().unwrap(), source).is_err());
        }
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(root.join(".git"), root.join("alias")).unwrap();
            assert!(validate_worktree_destination(
                root.join("alias/new").to_str().unwrap(),
                source
            )
            .is_err());
        }
        let destination = root.join("new/nested");
        assert!(validate_worktree_destination(destination.to_str().unwrap(), source).is_ok());
        assert!(!destination.exists());
    }

    #[tokio::test]
    async fn live_session_observers_receive_scoped_metadata() {
        use crate::acp::types::EventEnvelope;
        use crate::acp::{EventBusMetrics, InternalEventBus};
        use crate::models::agent::AgentType;

        let data = tempfile::tempdir().unwrap();
        let directory = tempfile::tempdir().unwrap();
        let plugins = Arc::new(HostPlugins::new(data.path()));
        let id = "test.session-hooks";
        let name = "session.permission.requested";
        let source = directory.path();
        std::fs::write(
            source.join("codeg-plugin.json"),
            json!({
                "apiVersion": 2, "id": id, "name": "Session hooks", "version": "1.0.0",
                "server": { "entry": "session.mjs", "methods": [] },
                "contributes": { "lifecycleHooks": [{ "event": name, "method": name }] }
            })
            .to_string(),
        )
        .unwrap();
        std::fs::write(
            source.join("session.mjs"),
            "export const handle = (_, input) => input;",
        )
        .unwrap();
        let preview = plugins
            .preview_install(source.to_str().unwrap(), Registry::Npm, None)
            .await
            .unwrap();
        plugins.confirm_install(preview.ticket).unwrap();
        plugins
            .apply(Mutation::SetEnabled {
                id: id.into(),
                enabled: true,
            })
            .unwrap();

        let bus = Arc::new(InternalEventBus::new(Arc::new(EventBusMetrics::default())));
        let broadcaster = Arc::new(WebEventBroadcaster::new());
        let mut outgoing = broadcaster.subscribe();
        let emitter = EventEmitter::web_only(broadcaster, bus.clone(), None);
        let connections = crate::app_state::default_connection_manager();
        connections
            .insert_test_connection("workspace-session", AgentType::Codex, None, emitter.clone())
            .await;
        let session = connections.get_state("workspace-session").await.unwrap();
        {
            let mut session = session.write().await;
            session.folder_id = Some(12);
            session.conversation_id = Some(23);
        }
        let receiver = bus.subscribe();
        let observer = tokio::spawn(async move {
            plugins
                .observe_sessions(receiver, connections, emitter)
                .await;
        });
        bus.send(Arc::new(EventEnvelope {
            seq: 1,
            connection_id: "workspace-session".into(),
            payload: AcpEvent::PermissionRequest {
                request_id: "request-1".into(),
                tool_call: json!({"input": "private"}),
                options: Vec::new(),
                queued: 1,
            },
        }));
        let event = tokio::time::timeout(Duration::from_secs(1), outgoing.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(event.channel, EVENT_CHANNEL);
        assert_eq!(event.payload["event"], name);
        assert_eq!(event.payload["pluginId"], id);
        assert_eq!(event.payload["folderId"], 12);
        assert_eq!(event.payload["conversationId"], 23);
        assert_eq!(event.payload["data"]["connectionId"], "workspace-session");
        assert_eq!(
            event.payload["data"]["detail"],
            json!({"requestId": "request-1", "queued": 1})
        );
        observer.abort();
    }
}
