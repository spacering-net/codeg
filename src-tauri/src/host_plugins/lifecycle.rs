use std::collections::BTreeSet;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::{
    catalog_error, invalid, valid_id, HostPlugins, Invocation, ServerModule, MAX_CONTRIBUTIONS,
};
use crate::acp::types::{AcpEvent, ConnectionStatus};
use crate::app_error::{AppCommandError, AppErrorCode};
use crate::db::entities::folder::FolderKind;
use crate::models::FolderDetail;
use crate::web::event_bridge::{emit_event, EventEmitter};

pub const EVENT_CHANNEL: &str = "host-plugins://event";
const TRANSFORM_DEADLINE: Duration = Duration::from_secs(3);

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
    #[serde(rename = "session.permission.requested")]
    PermissionRequested,
    #[serde(rename = "session.permission.resolved")]
    PermissionResolved,
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

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Registration {
    event: Event,
    method: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct WorkspacePath {
    path: String,
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
    if hooks.len() > MAX_CONTRIBUTIONS
        || hooks.iter().any(|hook| {
            !events.insert(hook.event)
                || !valid_id(&hook.method)
                || hook.method == super::settings::MIGRATION_METHOD
                || server.methods.contains(&hook.method)
        })
    {
        return Err("Declare one private server method per lifecycle event".to_owned());
    }
    Ok(())
}

impl HostPlugins {
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
                let updated: WorkspacePath = serde_json::from_value(result).map_err(|_| {
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::folders::{
        close_folder_with_plugins, git_remove_worktree_core, git_worktree_add_with_plugins,
        open_folder_with_plugins, remove_folder_from_history_core, reopen_folder_with_plugins,
    };
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
    async fn workspace_worktree_hooks_report_successful_checkouts_and_archives() {
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
        let checkout = repo.join("checkout");
        let checkout_path = checkout.to_str().unwrap();
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
            )
            .await;
            assert_eq!(result.is_ok(), succeeds);
        }
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
