use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use tokio::sync::broadcast;

use crate::acp::manager::ConnectionManager;
use crate::acp::types::{AcpEvent, EventEnvelope};
use crate::app_error::{AppCommandError, AppErrorCode};
use crate::web::event_bridge::{emit_event, EventEmitter};

pub const CATALOG_CHANGED: &str = "host-plugins://changed";
const ACTIVITY_CHANGED: &str = "host-plugins://activity";
pub const MAX_MANIFEST_BYTES: usize = 64 * 1024;
const MAX_PLUGINS: usize = 32;
const MAX_CONTRIBUTIONS: usize = 16;
const MAX_TURNS: usize = 128;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Manifest {
    api_version: u32,
    id: String,
    name: String,
    version: String,
    contributes: Contributions,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Contributions {
    #[serde(default)]
    workspace_panels: Vec<WorkspacePanel>,
    #[serde(default)]
    commands: Vec<PluginCommand>,
    #[serde(default)]
    hooks: Vec<Hook>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WorkspacePanel {
    id: String,
    title: String,
    view: PanelView,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    text: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
enum PanelView {
    TurnActivity,
    Text,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PluginCommand {
    id: String,
    title: String,
    action: CommandAction,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
enum CommandAction {
    OpenWorkspacePanel { panel_id: String },
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Hook {
    event: HookEvent,
    action: HookAction,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
enum HookEvent {
    #[serde(rename = "session.turnCompleted")]
    TurnCompleted,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
enum HookAction {
    RecordTurnActivity,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct InstalledPlugin {
    manifest: Manifest,
    enabled: bool,
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
pub enum Mutation {
    Install { manifest: String },
    SetEnabled { id: String, enabled: bool },
    Remove { id: String },
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnActivity {
    timestamp: DateTime<Utc>,
    agent_type: String,
    stop_reason: String,
}

type Catalog = BTreeMap<String, InstalledPlugin>;

pub struct HostPlugins {
    path: PathBuf,
    state: Mutex<Result<PluginState, String>>,
}

struct PluginState {
    catalog: Catalog,
    turns: BTreeMap<String, VecDeque<(i32, TurnActivity)>>,
}

impl HostPlugins {
    pub fn new(data_dir: &Path) -> Self {
        let path = data_dir.join("host-plugins.json");
        let state = load_catalog(&path).map(|catalog| PluginState {
            catalog,
            turns: BTreeMap::new(),
        });
        if let Err(error) = &state {
            tracing::warn!(%error, "Could not load the host plugin catalog");
        }
        Self {
            path,
            state: Mutex::new(state),
        }
    }

    pub fn list(&self) -> Result<Vec<InstalledPlugin>, AppCommandError> {
        let state = self.state.lock().expect("host plugin state lock");
        Ok(state
            .as_ref()
            .map_err(|error| catalog_error(error))?
            .catalog
            .values()
            .cloned()
            .collect())
    }

    pub fn apply(&self, mutation: Mutation) -> Result<Vec<InstalledPlugin>, AppCommandError> {
        let mut state = self.state.lock().expect("host plugin state lock");
        let state = state.as_mut().map_err(|error| catalog_error(error))?;
        let mut next = state.catalog.clone();
        let discard = match mutation {
            Mutation::Install { manifest } => {
                if manifest.len() > MAX_MANIFEST_BYTES {
                    return Err(invalid("Plugin manifest exceeds 64 KiB"));
                }
                let manifest: Manifest = serde_json::from_str(&manifest)
                    .map_err(|error| invalid(format!("Invalid plugin manifest: {error}")))?;
                manifest.validate().map_err(invalid)?;
                if next.contains_key(&manifest.id) {
                    return Err(invalid("A plugin with this ID is already installed"));
                }
                if next.len() >= MAX_PLUGINS {
                    return Err(invalid("The host plugin limit has been reached"));
                }
                next.insert(
                    manifest.id.clone(),
                    InstalledPlugin {
                        manifest,
                        enabled: false,
                    },
                );
                None
            }
            Mutation::SetEnabled { id, enabled } => {
                let plugin = next.get_mut(&id).ok_or_else(plugin_not_found)?;
                if plugin.enabled == enabled {
                    return Ok(next.into_values().collect());
                }
                plugin.enabled = enabled;
                (!enabled).then_some(id)
            }
            Mutation::Remove { id } => {
                next.remove(&id).ok_or_else(plugin_not_found)?;
                Some(id)
            }
        };
        write_catalog(&self.path, &next)?;
        state.catalog = next;
        if let Some(id) = discard {
            state.turns.remove(&id);
        }
        Ok(state.catalog.values().cloned().collect())
    }

    pub fn activity(
        &self,
        plugin_id: &str,
        folder_id: i32,
    ) -> Result<Vec<TurnActivity>, AppCommandError> {
        let state = self.state.lock().expect("host plugin state lock");
        let state = state.as_ref().map_err(|error| catalog_error(error))?;
        state
            .catalog
            .get(plugin_id)
            .filter(|plugin| plugin.enabled)
            .ok_or_else(plugin_not_found)?;
        Ok(state
            .turns
            .get(plugin_id)
            .into_iter()
            .flatten()
            .rev()
            .filter(|(folder, _)| *folder == folder_id)
            .map(|(_, turn)| turn.clone())
            .collect())
    }

    fn record_turn(&self, folder_id: i32, payload: &AcpEvent) -> bool {
        let AcpEvent::TurnComplete {
            agent_type,
            stop_reason,
            ..
        } = payload
        else {
            return false;
        };
        let mut state = self.state.lock().expect("host plugin state lock");
        let Ok(state) = state.as_mut() else {
            return false;
        };
        let mut changed = false;
        for (id, plugin) in &state.catalog {
            if !plugin.enabled || plugin.manifest.contributes.hooks.is_empty() {
                continue;
            }
            let turns = state.turns.entry(id.clone()).or_default();
            if turns.len() == MAX_TURNS {
                turns.pop_front();
            }
            turns.push_back((
                folder_id,
                TurnActivity {
                    timestamp: Utc::now(),
                    agent_type: agent_type.chars().take(128).collect(),
                    stop_reason: stop_reason.chars().take(128).collect(),
                },
            ));
            changed = true;
        }
        changed
    }

    pub async fn observe_turns(
        &self,
        mut events: broadcast::Receiver<std::sync::Arc<EventEnvelope>>,
        connections: ConnectionManager,
        emitter: EventEmitter,
    ) {
        loop {
            let envelope = match events.recv().await {
                Ok(envelope) => envelope,
                Err(broadcast::error::RecvError::Lagged(count)) => {
                    tracing::debug!(count, "Host plugin turn observer lagged");
                    continue;
                }
                Err(broadcast::error::RecvError::Closed) => break,
            };
            if !matches!(envelope.payload, AcpEvent::TurnComplete { .. }) {
                continue;
            }
            let Some(session) = connections.get_state(&envelope.connection_id).await else {
                continue;
            };
            let folder_id = session.read().await.folder_id;
            if let Some(folder_id) = folder_id {
                if self.record_turn(folder_id, &envelope.payload) {
                    emit_event(&emitter, ACTIVITY_CHANGED, folder_id);
                }
            }
        }
    }
}

impl Manifest {
    fn validate(&self) -> Result<(), String> {
        if self.api_version != 1 {
            return Err(format!(
                "Unsupported plugin API version: {}",
                self.api_version
            ));
        }
        if !valid_id(&self.id) || !valid_label(&self.name) {
            return Err("Invalid plugin ID or name".to_owned());
        }
        if self.version.len() > 128 || semver::Version::parse(&self.version).is_err() {
            return Err("Invalid plugin version. Use semantic versioning.".to_owned());
        }
        let Contributions {
            workspace_panels,
            commands,
            hooks,
        } = &self.contributes;
        if workspace_panels.is_empty()
            || workspace_panels.len() > MAX_CONTRIBUTIONS
            || commands.len() > MAX_CONTRIBUTIONS
            || hooks.len() > 1
        {
            return Err(
                "Provide 1 to 16 panels, up to 16 commands and up to one turn hook".to_owned(),
            );
        }
        let mut panels = BTreeSet::new();
        for panel in workspace_panels {
            if !valid_id(&panel.id) || !valid_label(&panel.title) || !panels.insert(&panel.id) {
                return Err("Invalid or duplicate workspace panel".to_owned());
            }
            match (&panel.view, &panel.text) {
                (PanelView::TurnActivity, None) if !hooks.is_empty() => {}
                (PanelView::Text, Some(text)) if !text.trim().is_empty() && text.len() <= 4096 => {}
                _ => return Err("A text panel needs text up to 4 KiB and a turn activity panel needs a turn hook".to_owned()),
            }
        }
        let mut command_ids = BTreeSet::new();
        for command in commands {
            let CommandAction::OpenWorkspacePanel { panel_id } = &command.action;
            if !valid_id(&command.id)
                || !valid_label(&command.title)
                || !command_ids.insert(&command.id)
                || !panels.contains(panel_id)
            {
                return Err("Invalid or duplicate command, or unknown target panel".to_owned());
            }
        }
        Ok(())
    }
}

fn valid_id(value: &str) -> bool {
    value.len() <= 80
        && value.as_bytes().first().is_some_and(u8::is_ascii_lowercase)
        && value.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'-' | b'.')
        })
}

fn valid_label(value: &str) -> bool {
    !value.trim().is_empty() && value.chars().count() <= 100 && !value.chars().any(char::is_control)
}

fn load_catalog(path: &Path) -> Result<Catalog, String> {
    let file = match std::fs::File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Catalog::new()),
        Err(error) => return Err(error.to_string()),
    };
    let max_bytes = ((MAX_MANIFEST_BYTES + 1024) * MAX_PLUGINS) as u64;
    let mut bytes = Vec::new();
    file.take(max_bytes + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| error.to_string())?;
    if bytes.len() as u64 > max_bytes {
        return Err("Plugin catalog exceeds its size limit".to_owned());
    }
    let catalog: Vec<InstalledPlugin> =
        serde_json::from_slice(&bytes).map_err(|error| error.to_string())?;
    if catalog.len() > MAX_PLUGINS {
        return Err("Too many installed host plugins".to_owned());
    }
    let mut result = Catalog::new();
    for plugin in catalog {
        plugin.manifest.validate()?;
        if result.insert(plugin.manifest.id.clone(), plugin).is_some() {
            return Err("Duplicate installed plugin ID".to_owned());
        }
    }
    Ok(result)
}

fn write_catalog(path: &Path, catalog: &Catalog) -> Result<(), AppCommandError> {
    let write = || -> Result<(), Box<dyn std::error::Error>> {
        let dir = path.parent().expect("host plugin catalog has a parent");
        std::fs::create_dir_all(dir)?;
        let mut file = tempfile::NamedTempFile::new_in(dir)?;
        serde_json::to_writer(&mut file, &catalog.values().collect::<Vec<_>>())?;
        file.flush()?;
        file.as_file().sync_all()?;
        file.persist(path)?;
        Ok(())
    };
    write().map_err(|error| catalog_error(&error.to_string()))
}

fn catalog_error(error: &str) -> AppCommandError {
    AppCommandError::new(AppErrorCode::IoError, "Host plugin catalog is unavailable")
        .with_detail(error.to_owned())
}

fn invalid(message: impl Into<String>) -> AppCommandError {
    AppCommandError::new(AppErrorCode::InvalidInput, message)
}

fn plugin_not_found() -> AppCommandError {
    AppCommandError::new(AppErrorCode::NotFound, "Host plugin is not available")
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = include_str!("../../examples/plugins/turn-activity/codeg-plugin.json");
    const ID: &str = "codeg.turn-activity";

    fn install(
        host: &HostPlugins,
        manifest: &str,
    ) -> Result<Vec<InstalledPlugin>, AppCommandError> {
        host.apply(Mutation::Install {
            manifest: manifest.to_owned(),
        })
    }

    fn set_enabled(host: &HostPlugins, enabled: bool) {
        host.apply(Mutation::SetEnabled {
            id: ID.to_owned(),
            enabled,
        })
        .unwrap();
    }

    fn turn() -> AcpEvent {
        AcpEvent::TurnComplete {
            agent_type: "codex".into(),
            session_id: "session".into(),
            stop_reason: "end_turn".into(),
        }
    }

    #[test]
    fn activity_is_scoped_and_discarded_when_disabled() {
        let dir = tempfile::tempdir().unwrap();
        let host = HostPlugins::new(dir.path());
        assert!(!install(&host, SAMPLE).unwrap()[0].enabled);
        assert!(!host.record_turn(12, &turn()));
        set_enabled(&host, true);
        for _ in 0..MAX_TURNS + 1 {
            assert!(host.record_turn(12, &turn()));
        }
        assert_eq!(host.activity(ID, 12).unwrap().len(), MAX_TURNS);
        assert!(host.activity(ID, 13).unwrap().is_empty());
        let reopened = HostPlugins::new(dir.path());
        assert!(reopened.list().unwrap()[0].enabled);
        assert!(reopened.activity(ID, 12).unwrap().is_empty());
        set_enabled(&host, false);
        assert!(host.activity(ID, 12).is_err());
        assert!(!host.record_turn(12, &turn()));
        set_enabled(&host, true);
        assert!(host.activity(ID, 12).unwrap().is_empty());
        host.apply(Mutation::Remove { id: ID.to_owned() }).unwrap();
        assert!(HostPlugins::new(dir.path()).list().unwrap().is_empty());
    }

    #[test]
    fn rejects_incompatible_or_invalid_contributions_before_writing() {
        let dir = tempfile::tempdir().unwrap();
        let host = HostPlugins::new(dir.path());
        for manifest in [
            SAMPLE.replace("\"apiVersion\": 1", "\"apiVersion\": 2"),
            SAMPLE.replace("\"panelId\": \"activity\"", "\"panelId\": \"missing\""),
            SAMPLE.replace("\"version\": \"1.0.0\"", "\"version\": \"one\""),
            SAMPLE.replace("recordTurnActivity", "executeScript"),
        ] {
            assert!(install(&host, &manifest).is_err());
        }
        assert!(!host.path.exists());
        install(&host, SAMPLE).unwrap();
        assert!(install(&host, SAMPLE).is_err());
        assert_eq!(host.list().unwrap().len(), 1);
    }

    #[test]
    fn a_failed_write_leaves_the_catalog_and_activity_unchanged() {
        let dir = tempfile::tempdir().unwrap();
        let host = HostPlugins::new(dir.path());
        install(&host, SAMPLE).unwrap();
        set_enabled(&host, true);
        assert!(host.record_turn(12, &turn()));
        std::fs::remove_file(&host.path).unwrap();
        std::fs::create_dir(&host.path).unwrap();
        assert!(host
            .apply(Mutation::SetEnabled {
                id: ID.to_owned(),
                enabled: false
            })
            .is_err());
        assert!(host.list().unwrap()[0].enabled);
        assert_eq!(host.activity(ID, 12).unwrap().len(), 1);
    }

    #[tokio::test]
    async fn observes_a_live_workspace_turn_and_notifies_clients() {
        use crate::acp::{EventBusMetrics, InternalEventBus};
        use crate::models::agent::AgentType;
        use crate::web::event_bridge::WebEventBroadcaster;
        use std::sync::Arc;

        let dir = tempfile::tempdir().unwrap();
        let host = Arc::new(HostPlugins::new(dir.path()));
        install(&host, SAMPLE).unwrap();
        set_enabled(&host, true);

        let bus = Arc::new(InternalEventBus::new(Arc::new(EventBusMetrics::default())));
        let broadcaster = Arc::new(WebEventBroadcaster::new());
        let emitter = EventEmitter::web_only(broadcaster.clone(), bus.clone());
        let mut changes = broadcaster.subscribe();
        let connections = crate::app_state::default_connection_manager();
        connections
            .insert_test_connection("active", AgentType::Codex, None, emitter.clone())
            .await;
        connections
            .get_state("active")
            .await
            .unwrap()
            .write()
            .await
            .folder_id = Some(12);

        let events = bus.subscribe();
        let observed_host = host.clone();
        let observer = tokio::spawn(async move {
            observed_host
                .observe_turns(events, connections, emitter)
                .await
        });
        bus.send(Arc::new(EventEnvelope {
            seq: 1,
            connection_id: "unknown".into(),
            payload: turn(),
        }));
        bus.send(Arc::new(EventEnvelope {
            seq: 1,
            connection_id: "active".into(),
            payload: turn(),
        }));

        let change = tokio::time::timeout(std::time::Duration::from_secs(1), changes.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(change.channel, ACTIVITY_CHANGED);
        assert_eq!(change.payload.as_ref(), &serde_json::json!(12));
        assert_eq!(host.activity(ID, 12).unwrap().len(), 1);
        assert!(changes.try_recv().is_err());
        observer.abort();
    }
}
