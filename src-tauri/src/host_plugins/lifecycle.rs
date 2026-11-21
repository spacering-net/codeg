use std::collections::BTreeSet;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::{
    catalog_error, invalid, valid_id, HostPlugins, Invocation, ServerModule, MAX_CONTRIBUTIONS,
};
use crate::app_error::{AppCommandError, AppErrorCode};
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
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Registration {
    event: Event,
    method: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct OpenRequest {
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

    pub async fn workspace_open_path(&self, mut path: String) -> Result<String, AppCommandError> {
        tokio::time::timeout(TRANSFORM_DEADLINE, async {
            for hook in self.lifecycle_handlers(Event::OpenBefore) {
                let source = hook.id.clone();
                let result = self
                    .invoke(hook, json!({ "path": path }))
                    .await
                    .map_err(|error| {
                        AppCommandError::new(
                            AppErrorCode::TaskExecutionFailed,
                            format!("Plugin {source} could not open the workspace"),
                        )
                        .with_detail(error.to_string())
                    })?;
                if result.is_null() {
                    continue;
                }
                let updated: OpenRequest = serde_json::from_value(result).map_err(|_| {
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
                                "pluginId": plugin_id, "event": event, "folderId": input.get("folderId"), "data": data
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
    use crate::commands::folders::{close_folder_with_plugins, open_folder_with_plugins};
    use crate::db::test_helpers::fresh_in_memory_db;
    use crate::host_plugins::{source::Registry, Mutation};
    use crate::web::event_bridge::WebEventBroadcaster;

    #[tokio::test]
    async fn user_folder_operations_use_the_hooks_and_publish_scoped_events() {
        let data = tempfile::tempdir().unwrap();
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path();
        let plugins = Arc::new(HostPlugins::new(data.path()));
        let id = "codeg.workspace-lifecycle";
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
                id: id.into(),
                enabled: true,
            })
            .unwrap();
        assert!(plugins
            .call(id, "before-open".into(), Value::Null)
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
        while received.len() < 2 {
            let event = tokio::time::timeout(Duration::from_secs(1), stream.recv())
                .await
                .unwrap()
                .unwrap();
            if event.channel == EVENT_CHANNEL {
                assert_eq!(event.payload["pluginId"], id);
                assert_eq!(event.payload["folderId"], folder.id);
                received.insert(event.payload["event"].as_str().unwrap().to_owned());
            }
        }
        assert_eq!(
            received,
            BTreeSet::from([
                "workspace.open.after".into(),
                "workspace.close.after".into()
            ])
        );
        plugins
            .apply(Mutation::SetEnabled {
                id: id.into(),
                enabled: false,
            })
            .unwrap();
        let alias = path.join("workspace-alias").to_string_lossy().into_owned();
        assert_eq!(
            plugins.workspace_open_path(alias.clone()).await.unwrap(),
            alias
        );
    }
}
