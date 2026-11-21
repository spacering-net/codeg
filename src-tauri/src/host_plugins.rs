use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use tokio::sync::broadcast;
use uuid::Uuid;

use crate::acp::manager::ConnectionManager;
use crate::acp::types::{AcpEvent, EventEnvelope};
use crate::app_error::{AppCommandError, AppErrorCode};
use crate::web::event_bridge::{emit_event, EventEmitter};

pub mod source;

pub const CATALOG_CHANGED: &str = "host-plugins://changed";
const ACTIVITY_CHANGED: &str = "host-plugins://activity";
pub const MAX_MANIFEST_BYTES: usize = 64 * 1024;
const MAX_PLUGINS: usize = 32;
const MAX_CONTRIBUTIONS: usize = 16;
const MAX_TURNS: usize = 128;
const MAX_INSTALL_PREVIEWS: usize = 16;
const INSTALL_PREVIEW_LIFETIME: Duration = Duration::from_secs(300);

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Manifest {
    api_version: u32,
    id: String,
    name: String,
    version: String,
    contributes: Contributions,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Contributions {
    #[serde(default)]
    workspace_panels: Vec<WorkspacePanel>,
    #[serde(default)]
    commands: Vec<PluginCommand>,
    #[serde(default)]
    hooks: Vec<Hook>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WorkspacePanel {
    id: String,
    title: String,
    view: PanelView,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    text: Option<String>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
enum PanelView {
    TurnActivity,
    Text,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PluginCommand {
    id: String,
    title: String,
    action: CommandAction,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
enum CommandAction {
    OpenWorkspacePanel { panel_id: String },
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(deny_unknown_fields)]
struct Hook {
    event: HookEvent,
    action: HookAction,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
enum HookEvent {
    #[serde(rename = "session.turnCompleted")]
    TurnCompleted,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
enum HookAction {
    RecordTurnActivity,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct InstalledPlugin {
    manifest: Manifest,
    enabled: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    source: Option<source::InstalledSource>,
    /// An in-flight download may commit only to the installed definition it read.
    /// Toggling the plugin does not replace its definition.
    #[serde(skip)]
    revision: Arc<()>,
}

#[derive(Clone, Debug, Serialize)]
pub struct PluginUpdate {
    pub updated: bool,
    version: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ExpectedPlugin {
    id: String,
    version: String,
}

#[derive(Serialize)]
pub struct InstallPreview {
    ticket: Uuid,
    manifest: Manifest,
    source: source::InstalledSource,
}

struct PendingInstall {
    ticket: Uuid,
    created: Instant,
    manifest: String,
    source: source::InstalledSource,
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
    pending_installs: VecDeque<PendingInstall>,
}

impl HostPlugins {
    pub fn new(data_dir: &Path) -> Self {
        let path = data_dir.join("host-plugins.json");
        let state = load_catalog(&path).map(|catalog| PluginState {
            catalog,
            turns: BTreeMap::new(),
            pending_installs: VecDeque::new(),
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
        self.apply_with_source(mutation, None)
    }

    fn apply_with_source(
        &self,
        mutation: Mutation,
        source: Option<source::InstalledSource>,
    ) -> Result<Vec<InstalledPlugin>, AppCommandError> {
        let mut state = self.state.lock().expect("host plugin state lock");
        let state = state.as_mut().map_err(|error| catalog_error(error))?;
        let mut next = state.catalog.clone();
        let discard = match mutation {
            Mutation::Install { manifest } => {
                let manifest = Manifest::parse(&manifest)?;
                check_install(&next, &manifest.id)?;
                next.insert(
                    manifest.id.clone(),
                    InstalledPlugin {
                        manifest,
                        enabled: false,
                        source,
                        revision: Arc::new(()),
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

    pub async fn preview_install(
        &self,
        input: &str,
        registry: source::Registry,
        expected: Option<ExpectedPlugin>,
    ) -> Result<InstallPreview, AppCommandError> {
        let (text, source) = source::resolve(input, registry).await?;
        let manifest = Manifest::parse(&text)?;
        if expected.is_some_and(|expected| {
            expected.id != manifest.id || expected.version != manifest.version
        }) {
            return Err(invalid(
                "The plugin manifest ID or version differs from the index entry",
            ));
        }

        let mut guard = self.state.lock().expect("host plugin state lock");
        let state = guard.as_mut().map_err(|error| catalog_error(error))?;
        check_install(&state.catalog, &manifest.id)?;
        state
            .pending_installs
            .retain(|pending| pending.created.elapsed() < INSTALL_PREVIEW_LIFETIME);
        if state.pending_installs.len() == MAX_INSTALL_PREVIEWS {
            state.pending_installs.pop_front();
        }
        let ticket = Uuid::new_v4();
        state.pending_installs.push_back(PendingInstall {
            ticket,
            created: Instant::now(),
            manifest: text,
            source: source.clone(),
        });
        Ok(InstallPreview {
            ticket,
            manifest,
            source,
        })
    }

    pub fn confirm_install(&self, ticket: Uuid) -> Result<Vec<InstalledPlugin>, AppCommandError> {
        let pending = {
            let mut guard = self.state.lock().expect("host plugin state lock");
            let state = guard.as_mut().map_err(|error| catalog_error(error))?;
            state
                .pending_installs
                .retain(|pending| pending.created.elapsed() < INSTALL_PREVIEW_LIFETIME);
            let index = state
                .pending_installs
                .iter()
                .position(|pending| pending.ticket == ticket);
            index
                .and_then(|index| state.pending_installs.remove(index))
                .ok_or_else(|| {
                    invalid("This installation preview expired. Review the source again.")
                })?
        };
        self.apply_with_source(
            Mutation::Install {
                manifest: pending.manifest,
            },
            Some(pending.source),
        )
    }

    pub async fn update(&self, id: &str) -> Result<PluginUpdate, AppCommandError> {
        let (revision, source) = {
            let guard = self.state.lock().expect("host plugin state lock");
            let state = guard.as_ref().map_err(|error| catalog_error(error))?;
            let plugin = state.catalog.get(id).ok_or_else(plugin_not_found)?;
            let source = plugin
                .source
                .clone()
                .ok_or_else(|| invalid("Install the plugin from a source to receive updates"))?;
            (plugin.revision.clone(), source)
        };
        let (manifest, source) = source.refresh().await?;
        self.replace(id, &revision, Manifest::parse(&manifest)?, source)
    }

    fn replace(
        &self,
        id: &str,
        revision: &Arc<()>,
        manifest: Manifest,
        source: source::InstalledSource,
    ) -> Result<PluginUpdate, AppCommandError> {
        let mut guard = self.state.lock().expect("host plugin state lock");
        let state = guard.as_mut().map_err(|error| catalog_error(error))?;
        let current = state.catalog.get(id).ok_or_else(plugin_not_found)?;
        if !Arc::ptr_eq(&current.revision, revision) {
            return Err(invalid(
                "The installed plugin changed while checking for an update. Try again.",
            ));
        }
        if manifest.id != id {
            return Err(invalid("The updated manifest has a different plugin ID"));
        }
        if older_version(&manifest.version, &current.manifest.version)
            || matches!(
                (&source, &current.source),
                (source::InstalledSource::Npm { version: new, .. }, Some(source::InstalledSource::Npm { version: old, .. }))
                    if older_version(new, old)
            )
        {
            return Err(invalid("The source returned an older plugin version"));
        }
        let version = manifest.version.clone();
        if current.manifest == manifest && current.source.as_ref() == Some(&source) {
            return Ok(PluginUpdate {
                updated: false,
                version,
            });
        }
        let discard_activity = manifest.contributes.hooks != current.manifest.contributes.hooks;
        let mut next = state.catalog.clone();
        next.insert(
            id.to_owned(),
            InstalledPlugin {
                manifest,
                enabled: current.enabled,
                source: Some(source),
                revision: Arc::new(()),
            },
        );
        write_catalog(&self.path, &next)?;
        state.catalog = next;
        if discard_activity {
            state.turns.remove(id);
        }
        Ok(PluginUpdate {
            updated: true,
            version,
        })
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
    fn parse(text: &str) -> Result<Self, AppCommandError> {
        if text.len() > MAX_MANIFEST_BYTES {
            return Err(invalid("Plugin manifest exceeds 64 KiB"));
        }
        let manifest: Self = serde_json::from_str(text)
            .map_err(|error| invalid(format!("Invalid plugin manifest: {error}")))?;
        manifest.validate().map_err(invalid)?;
        Ok(manifest)
    }

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

fn older_version(candidate: &str, current: &str) -> bool {
    match (
        semver::Version::parse(candidate),
        semver::Version::parse(current),
    ) {
        (Ok(candidate), Ok(current)) => candidate.cmp_precedence(&current).is_lt(),
        _ => false,
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
    let max_bytes = ((MAX_MANIFEST_BYTES + 4096) * MAX_PLUGINS) as u64;
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

fn check_install(catalog: &Catalog, id: &str) -> Result<(), AppCommandError> {
    if catalog.contains_key(id) {
        return Err(invalid("A plugin with this ID is already installed"));
    }
    if catalog.len() >= MAX_PLUGINS {
        return Err(invalid("The host plugin limit has been reached"));
    }
    Ok(())
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

    #[tokio::test]
    async fn confirm_install_uses_the_reviewed_manifest_once() {
        let data = tempfile::tempdir().unwrap();
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("codeg-plugin.json");
        std::fs::write(&path, SAMPLE).unwrap();
        let host = HostPlugins::new(data.path());
        let input = directory.path().to_str().unwrap();
        let registry = source::Registry::Npm;

        for (id, version) in [("different-plugin", "1.0.0"), (ID, "2.0.0")] {
            let expected = ExpectedPlugin {
                id: id.to_owned(),
                version: version.to_owned(),
            };
            assert!(host
                .preview_install(input, registry, Some(expected))
                .await
                .is_err());
        }

        let preview = host.preview_install(input, registry, None).await.unwrap();
        assert!(host.list().unwrap().is_empty());
        assert!(!host.path.exists());
        std::fs::write(&path, SAMPLE.replace("1.0.0", "2.0.0")).unwrap();

        let installed = host.confirm_install(preview.ticket).unwrap();
        assert_eq!(installed[0].manifest, preview.manifest);
        assert_eq!(installed[0].source.as_ref(), Some(&preview.source));
        assert!(!installed[0].enabled);
        host.apply(Mutation::Remove { id: ID.into() }).unwrap();
        assert!(host.confirm_install(preview.ticket).is_err());
        assert!(host.list().unwrap().is_empty());
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
    async fn directory_update_validates_before_replacing_the_enabled_plugin() {
        let data = tempfile::tempdir().unwrap();
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("codeg-plugin.json");
        std::fs::write(&path, SAMPLE).unwrap();
        let host = HostPlugins::new(data.path());
        source::install(
            &host,
            directory.path().to_str().unwrap(),
            source::Registry::Npm,
        )
        .await
        .unwrap();
        set_enabled(&host, true);
        assert!(host.record_turn(12, &turn()));
        assert!(!host.update(ID).await.unwrap().updated);

        for invalid in [
            SAMPLE.replace(ID, "different-plugin"),
            SAMPLE.replace("1.0.0", "0.9.0"),
            SAMPLE.replace("\"apiVersion\": 1", "\"apiVersion\": 2"),
        ] {
            std::fs::write(&path, invalid).unwrap();
            assert!(host.update(ID).await.is_err());
            assert_eq!(host.list().unwrap()[0].manifest.version, "1.0.0");
        }

        let updated = SAMPLE.replace("1.0.0", "1.1.0");
        std::fs::write(&path, updated).unwrap();
        let result = host.update(ID).await.unwrap();
        assert!(result.updated);
        assert_eq!(result.version, "1.1.0");
        assert_eq!(host.activity(ID, 12).unwrap().len(), 1);
        let reopened = HostPlugins::new(data.path());
        assert!(reopened.list().unwrap()[0].enabled);
        assert!(!reopened.update(ID).await.unwrap().updated);

        let text_panel = r#"{"apiVersion":1,"id":"codeg.turn-activity","name":"Activity","version":"1.2.0","contributes":{"workspacePanels":[{"id":"activity","title":"Activity","view":"text","text":"Updated"}]}}"#;
        std::fs::write(&path, text_panel).unwrap();
        std::fs::remove_file(&host.path).unwrap();
        std::fs::create_dir(&host.path).unwrap();
        assert!(host.update(ID).await.is_err());
        assert_eq!(host.list().unwrap()[0].manifest.version, "1.1.0");
        assert_eq!(host.activity(ID, 12).unwrap().len(), 1);

        std::fs::remove_dir(&host.path).unwrap();
        assert!(host.update(ID).await.unwrap().updated);
        assert!(host.activity(ID, 12).unwrap().is_empty());
    }

    #[test]
    fn update_preserves_a_concurrent_toggle_and_rejects_a_stale_definition() {
        let dir = tempfile::tempdir().unwrap();
        let host = HostPlugins::new(dir.path());
        let source = source::InstalledSource::Directory {
            path: dir.path().to_str().unwrap().to_owned(),
        };
        let installed = host
            .apply_with_source(
                Mutation::Install {
                    manifest: SAMPLE.into(),
                },
                Some(source.clone()),
            )
            .unwrap();
        let revision = &installed[0].revision;
        set_enabled(&host, true);
        let updated = Manifest::parse(&SAMPLE.replace("1.0.0", "1.1.0")).unwrap();
        host.replace(ID, revision, updated.clone(), source.clone())
            .unwrap();
        assert!(host.list().unwrap()[0].enabled);
        assert!(host.replace(ID, revision, updated, source).is_err());
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
