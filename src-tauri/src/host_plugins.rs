use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use tokio::sync::{broadcast, Semaphore};
use uuid::Uuid;

use crate::acp::manager::ConnectionManager;
use crate::acp::types::{AcpEvent, EventEnvelope};
use crate::app_error::{AppCommandError, AppErrorCode};
use crate::web::event_bridge::{emit_event, EventEmitter};

pub mod lifecycle;
mod runtime;
mod schema;
mod settings;
pub mod source;
mod text;
mod theme;

pub use settings::Snapshot as PluginSettings;
use text::{valid_translations, Translations};

pub const CATALOG_CHANGED: &str = "host-plugins://changed";
const ACTIVITY_CHANGED: &str = "host-plugins://activity";
pub const MAX_MANIFEST_BYTES: usize = 64 * 1024;
const MAX_CLIENT_HTML_BYTES: usize = 256 * 1024;
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
    #[serde(default, skip_serializing_if = "Translations::is_empty")]
    name_translations: Translations,
    version: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    server: Option<ServerModule>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    client: Option<ClientModule>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    settings: Option<settings::Definition>,
    contributes: Contributions,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(deny_unknown_fields)]
struct ServerModule {
    entry: String,
    methods: Vec<String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    rpc: BTreeMap<String, schema::RpcDefinition>,
}

type RpcContracts = BTreeMap<String, Arc<schema::RpcContract>>;

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(deny_unknown_fields)]
struct ClientModule {
    entry: String,
}

struct PluginBundle {
    manifest: Manifest,
    server_code: Option<Arc<str>>,
    client_html: Option<Arc<str>>,
    rpc: RpcContracts,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    settings_panel: Option<HostPanel>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    plugin_detail: Option<HostPanel>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    activation_panel: Option<HostPanel>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    lifecycle_hooks: Vec<lifecycle::Registration>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    client_surfaces: Vec<ClientSurface>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    themes: Vec<theme::Theme>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    screens: Vec<HostPanel>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    sidebar_items: Vec<SidebarItem>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    slash_commands: Vec<SlashCommand>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SlashCommand {
    name: String,
    description: String,
    #[serde(default, skip_serializing_if = "Translations::is_empty")]
    description_translations: Translations,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    argument_hint: Option<String>,
    scope: SlashCommandScope,
    method: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
enum SlashCommandScope {
    Workspace,
    Session,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ClientSurface {
    id: String,
    title: String,
    #[serde(default, skip_serializing_if = "Translations::is_empty")]
    title_translations: Translations,
    slot: ClientSlot,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
enum ClientSlot {
    SessionHeader,
    Composer,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct HostPanel {
    id: String,
    title: String,
    #[serde(default, skip_serializing_if = "Translations::is_empty")]
    title_translations: Translations,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SidebarItem {
    id: String,
    title: String,
    #[serde(default, skip_serializing_if = "Translations::is_empty")]
    title_translations: Translations,
    placement: SidebarPlacement,
    screen_id: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
enum SidebarPlacement {
    Header,
    Footer,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WorkspacePanel {
    id: String,
    title: String,
    #[serde(default, skip_serializing_if = "Translations::is_empty")]
    title_translations: Translations,
    view: PanelView,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    text: Option<String>,
    #[serde(default, skip_serializing_if = "Translations::is_empty")]
    text_translations: Translations,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    method: Option<String>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
enum PanelView {
    TurnActivity,
    Text,
    ServerText,
    Client,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PluginCommand {
    id: String,
    title: String,
    #[serde(default, skip_serializing_if = "Translations::is_empty")]
    title_translations: Translations,
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
    #[serde(default, skip_serializing)]
    server_code: Option<Arc<str>>,
    #[serde(default, skip_serializing)]
    client_html: Option<Arc<str>>,
    #[serde(default, skip_serializing)]
    settings: Option<PluginSettings>,
    #[serde(skip)]
    rpc: RpcContracts,
    /// An in-flight download may commit only to the installed definition it read.
    /// Toggling the plugin does not replace its definition.
    #[serde(skip)]
    revision: Arc<()>,
    #[serde(skip)]
    activation: Arc<()>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginUpdate {
    pub updated: bool,
    version: String,
    disabled_for_update: bool,
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
    bundle: PluginBundle,
    source: source::InstalledSource,
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
pub enum Mutation {
    Install { manifest: String },
    SetEnabled { id: String, enabled: bool },
    Remove { id: String },
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
pub enum SettingsRequest {
    Read,
    Save {
        revision: Uuid,
        value: serde_json::Value,
    },
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
    runtime_slots: Arc<Semaphore>,
    observer_slots: Arc<Semaphore>,
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
            runtime_slots: Arc::new(Semaphore::new(4)),
            observer_slots: Arc::new(Semaphore::new(16)),
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
        let (id, enabled) = match mutation {
            Mutation::Install { manifest } => {
                let bundle = PluginBundle::manifest_only(Manifest::parse(&manifest)?)?;
                return self.install(bundle, None);
            }
            Mutation::SetEnabled { id, enabled } => (id, Some(enabled)),
            Mutation::Remove { id } => (id, None),
        };
        let mut guard = self.state.lock().expect("host plugin state lock");
        let state = guard.as_mut().map_err(|error| catalog_error(error))?;
        let mut next = state.catalog.clone();
        if let Some(enabled) = enabled {
            let plugin = next.get_mut(&id).ok_or_else(plugin_not_found)?;
            if plugin.enabled == enabled {
                return Ok(next.into_values().collect());
            }
            if enabled && plugin.needs_settings_migration() {
                let _slot = self.runtime_slots.try_acquire().map_err(|_| {
                    AppCommandError::new(
                        AppErrorCode::TaskExecutionFailed,
                        "Plugin runtime is busy",
                    )
                })?;
                plugin.migrate_settings()?;
            }
            plugin.enabled = enabled;
            plugin.activation = Arc::new(());
        } else {
            next.remove(&id).ok_or_else(plugin_not_found)?;
        }
        write_catalog(&self.path, &next)?;
        state.catalog = next;
        if enabled != Some(true) {
            state.turns.remove(&id);
        }
        Ok(state.catalog.values().cloned().collect())
    }

    fn install(
        &self,
        bundle: PluginBundle,
        source: Option<source::InstalledSource>,
    ) -> Result<Vec<InstalledPlugin>, AppCommandError> {
        let mut state = self.state.lock().expect("host plugin state lock");
        let state = state.as_mut().map_err(|error| catalog_error(error))?;
        let mut next = state.catalog.clone();
        check_install(&next, &bundle.manifest.id)?;
        let settings =
            bundle.manifest.settings.as_ref().map(|definition| {
                PluginSettings::new(definition.version, definition.defaults.clone())
            });
        next.insert(
            bundle.manifest.id.clone(),
            InstalledPlugin {
                manifest: bundle.manifest,
                enabled: false,
                source,
                server_code: bundle.server_code,
                client_html: bundle.client_html,
                settings,
                rpc: bundle.rpc,
                revision: Arc::new(()),
                activation: Arc::new(()),
            },
        );
        write_catalog(&self.path, &next)?;
        state.catalog = next;
        Ok(state.catalog.values().cloned().collect())
    }

    pub async fn preview_install(
        &self,
        input: &str,
        registry: source::Registry,
        expected: Option<ExpectedPlugin>,
    ) -> Result<InstallPreview, AppCommandError> {
        let (bundle, source) = source::resolve(input, registry).await?;
        let manifest = bundle.manifest.clone();
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
            bundle,
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
        self.install(pending.bundle, Some(pending.source))
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
        let (bundle, source) = source.refresh().await?;
        self.replace(id, &revision, bundle, source)
    }

    fn replace(
        &self,
        id: &str,
        revision: &Arc<()>,
        bundle: PluginBundle,
        source: source::InstalledSource,
    ) -> Result<PluginUpdate, AppCommandError> {
        let mut guard = self.state.lock().expect("host plugin state lock");
        let state = guard.as_mut().map_err(|error| catalog_error(error))?;
        let current = state.catalog.get(id).ok_or_else(plugin_not_found)?;
        let PluginBundle {
            manifest,
            server_code,
            client_html,
            rpc,
        } = bundle;
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
        let runtime_changed = current.manifest.server != manifest.server
            || current.server_code != server_code
            || current.manifest.client != manifest.client
            || current.client_html != client_html
            || current.manifest.contributes.lifecycle_hooks != manifest.contributes.lifecycle_hooks;
        let settings_changed = current.manifest.settings != manifest.settings;
        let settings = current.settings_for_update(manifest.settings.as_ref())?;
        if current.manifest == manifest
            && current.source.as_ref() == Some(&source)
            && !runtime_changed
        {
            return Ok(PluginUpdate {
                updated: false,
                version,
                disabled_for_update: false,
            });
        }
        let enabled = current.enabled && !runtime_changed && !settings_changed;
        let disabled_for_update = current.enabled && !enabled;
        let discard_activity =
            !enabled || manifest.contributes.hooks != current.manifest.contributes.hooks;
        let mut next = state.catalog.clone();
        next.insert(
            id.to_owned(),
            InstalledPlugin {
                manifest,
                enabled,
                source: Some(source),
                server_code,
                client_html,
                settings,
                rpc,
                revision: Arc::new(()),
                activation: Arc::new(()),
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
            disabled_for_update,
        })
    }

    pub async fn call(
        &self,
        id: &str,
        method: String,
        input: serde_json::Value,
    ) -> Result<serde_json::Value, AppCommandError> {
        let invocation = {
            let guard = self.state.lock().expect("host plugin state lock");
            let state = guard.as_ref().map_err(|error| catalog_error(error))?;
            let plugin = state
                .catalog
                .get(id)
                .filter(|plugin| plugin.enabled)
                .ok_or_else(plugin_not_found)?;
            let server = plugin
                .manifest
                .server
                .as_ref()
                .ok_or_else(plugin_not_found)?;
            if !server.methods.contains(&method) {
                return Err(AppCommandError::not_found(
                    "Plugin method is not registered",
                ));
            }
            Invocation::new(id, plugin, method).ok_or_else(plugin_not_found)?
        };
        self.invoke(invocation, input).await
    }

    async fn invoke(
        &self,
        invocation: Invocation,
        input: serde_json::Value,
    ) -> Result<serde_json::Value, AppCommandError> {
        let Invocation {
            id,
            entry,
            code,
            method,
            activation,
            settings,
            contract,
        } = invocation;
        let slot = self
            .runtime_slots
            .clone()
            .try_acquire_owned()
            .map_err(|_| {
                AppCommandError::new(AppErrorCode::TaskExecutionFailed, "Plugin runtime is busy")
            })?;
        let result = tokio::task::spawn_blocking(move || {
            let _slot = slot;
            runtime::call_with_settings(
                &entry,
                &code,
                &method,
                &input,
                settings.as_ref().map(|settings| &settings.value),
                contract.as_deref(),
            )
        })
        .await
        .map_err(|_| {
            AppCommandError::new(AppErrorCode::TaskExecutionFailed, "Plugin runtime stopped")
        })?;
        let guard = self.state.lock().expect("host plugin state lock");
        let state = guard.as_ref().map_err(|error| catalog_error(error))?;
        if !state
            .catalog
            .get(&id)
            .is_some_and(|plugin| Arc::ptr_eq(&plugin.activation, &activation))
        {
            return Err(plugin_not_found());
        }
        result
    }

    pub fn settings(&self, id: &str) -> Result<PluginSettings, AppCommandError> {
        let guard = self.state.lock().expect("host plugin state lock");
        let state = guard.as_ref().map_err(|error| catalog_error(error))?;
        state
            .catalog
            .get(id)
            .filter(|plugin| plugin.enabled && plugin.manifest.settings.is_some())
            .and_then(|plugin| plugin.settings.clone())
            .ok_or_else(plugin_not_found)
    }

    pub fn save_settings(
        &self,
        id: &str,
        revision: Uuid,
        value: serde_json::Value,
    ) -> Result<PluginSettings, AppCommandError> {
        let mut guard = self.state.lock().expect("host plugin state lock");
        let state = guard.as_mut().map_err(|error| catalog_error(error))?;
        let mut next = state.catalog.clone();
        let plugin = next
            .get_mut(id)
            .filter(|plugin| plugin.enabled)
            .ok_or_else(plugin_not_found)?;
        let definition = plugin
            .manifest
            .settings
            .as_ref()
            .ok_or_else(plugin_not_found)?;
        let old = plugin.settings.as_ref().ok_or_else(plugin_not_found)?;
        if old.revision != revision {
            return Err(invalid(
                "Plugin settings changed. Read the current settings before saving.",
            ));
        }
        definition.check_value(&value)?;
        let settings = PluginSettings::new(definition.version, value);
        plugin.settings = Some(settings.clone());
        write_catalog(&self.path, &next)?;
        state.catalog = next;
        Ok(settings)
    }

    pub fn client_html(&self, id: &str) -> Result<Arc<str>, AppCommandError> {
        let guard = self.state.lock().expect("host plugin state lock");
        let state = guard.as_ref().map_err(|error| catalog_error(error))?;
        state
            .catalog
            .get(id)
            .filter(|plugin| plugin.enabled)
            .and_then(|plugin| plugin.client_html.clone())
            .ok_or_else(plugin_not_found)
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

    pub async fn observe_sessions(
        self: &Arc<Self>,
        mut events: broadcast::Receiver<std::sync::Arc<EventEnvelope>>,
        connections: ConnectionManager,
        emitter: EventEmitter,
    ) {
        loop {
            let envelope = match events.recv().await {
                Ok(envelope) => envelope,
                Err(broadcast::error::RecvError::Lagged(count)) => {
                    tracing::debug!(count, "Host plugin session observer lagged");
                    continue;
                }
                Err(broadcast::error::RecvError::Closed) => break,
            };
            let Some(event) = lifecycle::Event::from_session(&envelope.payload) else {
                continue;
            };
            let Some(session) = connections.get_state(&envelope.connection_id).await else {
                continue;
            };
            let session = session.read().await;
            let Some(folder_id) = session.folder_id else {
                continue;
            };
            if event == lifecycle::Event::TurnCompleted
                && self.record_turn(folder_id, &envelope.payload)
            {
                emit_event(&emitter, ACTIVITY_CHANGED, folder_id);
            }
            let detail = match &envelope.payload {
                AcpEvent::SessionStarted { session_id } => {
                    serde_json::json!({ "sessionId": session_id })
                }
                AcpEvent::TurnComplete { stop_reason, .. } => {
                    serde_json::json!({ "stopReason": stop_reason })
                }
                AcpEvent::PermissionRequest {
                    request_id, queued, ..
                } => serde_json::json!({ "requestId": request_id, "queued": queued }),
                AcpEvent::PermissionResolved {
                    request_id,
                    option_id,
                    origin,
                    ..
                } => {
                    serde_json::json!({ "requestId": request_id, "optionId": option_id, "origin": origin })
                }
                _ => serde_json::Value::Null,
            };
            self.observe(
                &emitter,
                event,
                serde_json::json!({
                    "folderId": folder_id,
                    "conversationId": session.conversation_id,
                    "connectionId": envelope.connection_id,
                    "agentType": session.agent_type,
                    "detail": detail,
                }),
            );
        }
    }
}

struct Invocation {
    id: String,
    entry: String,
    code: Arc<str>,
    method: String,
    activation: Arc<()>,
    settings: Option<PluginSettings>,
    contract: Option<Arc<schema::RpcContract>>,
}

impl Invocation {
    fn new(id: &str, plugin: &InstalledPlugin, method: String) -> Option<Self> {
        let server = plugin.manifest.server.as_ref()?;
        Some(Self {
            id: id.to_owned(),
            entry: server.entry.clone(),
            code: plugin.server_code.clone()?,
            contract: plugin.rpc.get(&method).cloned(),
            method,
            activation: plugin.activation.clone(),
            settings: plugin
                .manifest
                .settings
                .as_ref()
                .and(plugin.settings.as_ref())
                .cloned(),
        })
    }
}

impl InstalledPlugin {
    fn settings_for_update(
        &self,
        definition: Option<&settings::Definition>,
    ) -> Result<Option<PluginSettings>, AppCommandError> {
        let Some(definition) = definition else {
            return Ok(self.settings.clone());
        };
        let Some(old) = &self.settings else {
            return Ok(Some(PluginSettings::new(
                definition.version,
                definition.defaults.clone(),
            )));
        };
        if definition.version < old.version {
            return Err(invalid(
                "The update declares an older settings schema version",
            ));
        }
        if definition.version == old.version || !definition.migrate {
            definition.check_value(&old.value)?;
            if self.manifest.settings.as_ref() == Some(definition) {
                return Ok(Some(old.clone()));
            }
            return Ok(Some(PluginSettings::new(
                definition.version,
                old.value.clone(),
            )));
        }
        // The update remains disabled until an explicit enable runs the migration.
        Ok(Some(old.clone()))
    }

    fn needs_settings_migration(&self) -> bool {
        self.manifest
            .settings
            .as_ref()
            .zip(self.settings.as_ref())
            .is_some_and(|(definition, old)| definition.version != old.version)
    }

    fn migrate_settings(&mut self) -> Result<(), AppCommandError> {
        let Some((definition, old)) = self.manifest.settings.as_ref().zip(self.settings.as_ref())
        else {
            return Ok(());
        };
        if definition.version == old.version {
            return Ok(());
        }
        let (server, code) = self
            .manifest
            .server
            .as_ref()
            .zip(self.server_code.as_deref())
            .ok_or_else(|| invalid("The plugin settings migration needs a server module"))?;
        let value = runtime::call_with_settings(
            &server.entry,
            code,
            settings::MIGRATION_METHOD,
            &serde_json::json!({ "fromVersion": old.version, "toVersion": definition.version, "value": old.value }),
            None,
            None,
        )?;
        definition.check_value(&value)?;
        self.settings = Some(PluginSettings::new(definition.version, value));
        Ok(())
    }
}

impl Manifest {
    fn compile_rpc(&self) -> Result<RpcContracts, String> {
        self.server
            .iter()
            .flat_map(|server| &server.rpc)
            .map(|(method, definition)| {
                definition
                    .compile()
                    .map(|contract| (method.clone(), Arc::new(contract)))
                    .map_err(|error| format!("Plugin method {method} has an {error}"))
            })
            .collect()
    }

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
        let bundled = self.server.is_some() || self.client.is_some();
        if !matches!((self.api_version, bundled), (1, false) | (2, true)) {
            return Err(format!(
                "Unsupported plugin API version: {}",
                self.api_version
            ));
        }
        if !valid_id(&self.id)
            || !valid_label(&self.name)
            || !valid_translations(&self.name_translations, valid_label)
        {
            return Err("Invalid plugin ID or name".to_owned());
        }
        if self.version.len() > 128 || semver::Version::parse(&self.version).is_err() {
            return Err("Invalid plugin version. Use semantic versioning.".to_owned());
        }
        if let Some(server) = &self.server {
            let mut methods = BTreeSet::new();
            if !server.entry.strip_suffix(".mjs").is_some_and(valid_id)
                || (server.methods.is_empty() && self.contributes.lifecycle_hooks.is_empty())
                || server.methods.len() > MAX_CONTRIBUTIONS
                || !server.methods.iter().all(|method| {
                    valid_id(method)
                        && method != settings::MIGRATION_METHOD
                        && methods.insert(method)
                })
            {
                return Err(
                    "Provide a root .mjs file and up to 16 unique plugin methods".to_owned(),
                );
            }
            if server.rpc.keys().any(|method| !methods.contains(method)) {
                return Err("RPC contracts must name declared server methods".to_owned());
            }
        }
        if let Some(definition) = &self.settings {
            if !bundled || (definition.migrate && self.server.is_none()) {
                return Err(
                    "Plugin settings need a module and executable migrations need a server entry"
                        .to_owned(),
                );
            }
            definition.validate().map_err(|error| error.to_string())?;
        }
        if self
            .client
            .as_ref()
            .is_some_and(|client| !client.entry.strip_suffix(".html").is_some_and(valid_id))
        {
            return Err("Provide a root .html file for the plugin client entry".to_owned());
        }
        let Contributions {
            workspace_panels,
            commands,
            hooks,
            settings_panel,
            plugin_detail,
            activation_panel,
            lifecycle_hooks,
            client_surfaces,
            themes,
            screens,
            sidebar_items,
            slash_commands,
        } = &self.contributes;
        if !bundled && workspace_panels.is_empty() && themes.is_empty() {
            return Err("A declarative plugin needs a workspace panel or theme".to_owned());
        }
        if workspace_panels.len() > MAX_CONTRIBUTIONS
            || commands.len() > MAX_CONTRIBUTIONS
            || hooks.len() > 1
        {
            return Err("Provide up to 16 panels, 16 commands and one turn hook".to_owned());
        }
        let mut panels = BTreeSet::new();
        for panel in workspace_panels {
            if !valid_id(&panel.id)
                || !valid_label(&panel.title)
                || !valid_translations(&panel.title_translations, valid_label)
                || !panels.insert(&panel.id)
            {
                return Err("Invalid or duplicate workspace panel".to_owned());
            }
            if !panel.text_translations.is_empty()
                && (panel.view != PanelView::Text
                    || !valid_translations(&panel.text_translations, valid_panel_text))
            {
                return Err("Invalid translations for workspace panel text".to_owned());
            }
            match (&panel.view, &panel.text, &panel.method) {
                (PanelView::TurnActivity, None, None) if !hooks.is_empty() => {}
                (PanelView::Text, Some(text), None) if valid_panel_text(text) => {}
                (PanelView::ServerText, None, Some(method)) if self.server.as_ref().is_some_and(|server| server.methods.contains(method)) => {}
                (PanelView::Client, None, None) if self.client.is_some() => {}
                _ => return Err("Invalid panel data. Provide text, a turn hook, a registered server method or a client entry for the selected view.".to_owned()),
            }
        }
        let mut command_ids = BTreeSet::new();
        for command in commands {
            let CommandAction::OpenWorkspacePanel { panel_id } = &command.action;
            if !valid_id(&command.id)
                || !valid_label(&command.title)
                || !valid_translations(&command.title_translations, valid_label)
                || !command_ids.insert(&command.id)
                || !panels.contains(panel_id)
            {
                return Err("Invalid or duplicate command, or unknown target panel".to_owned());
            }
        }
        for (label, panel) in [
            ("settings panel", settings_panel),
            ("detail panel", plugin_detail),
            ("activation panel", activation_panel),
        ] {
            if let Some(panel) = panel {
                if self.client.is_none()
                    || !valid_id(&panel.id)
                    || !valid_label(&panel.title)
                    || !valid_translations(&panel.title_translations, valid_label)
                {
                    return Err(format!(
                        "A plugin {label} needs a valid ID, title and client entry"
                    ));
                }
            }
        }
        if !client_surfaces.is_empty() {
            let mut surface_ids = BTreeSet::new();
            if self.client.is_none()
                || client_surfaces.len() > MAX_CONTRIBUTIONS
                || client_surfaces.iter().any(|surface| {
                    !valid_id(&surface.id)
                        || !valid_label(&surface.title)
                        || !valid_translations(&surface.title_translations, valid_label)
                        || !surface_ids.insert(&surface.id)
                })
            {
                return Err(
                    "Client surfaces need a client entry, unique IDs, and valid titles".to_owned(),
                );
            }
        }
        if (!screens.is_empty() || !sidebar_items.is_empty()) && self.client.is_none() {
            return Err("Plugin screens and sidebar items need a client entry".to_owned());
        }
        let mut screen_ids = BTreeSet::new();
        if screens.len() > MAX_CONTRIBUTIONS
            || screens.iter().any(|screen| {
                !valid_id(&screen.id)
                    || !valid_label(&screen.title)
                    || !valid_translations(&screen.title_translations, valid_label)
                    || !screen_ids.insert(&screen.id)
            })
        {
            return Err("Provide up to 16 plugin screens with unique IDs and valid titles".into());
        }
        let mut sidebar_ids = BTreeSet::new();
        if sidebar_items.len() > MAX_CONTRIBUTIONS
            || sidebar_items.iter().any(|item| {
                !valid_id(&item.id)
                    || !valid_label(&item.title)
                    || !valid_translations(&item.title_translations, valid_label)
                    || !sidebar_ids.insert(&item.id)
                    || !screen_ids.contains(&item.screen_id)
            })
        {
            return Err(
                "Provide up to 16 sidebar items with unique IDs, valid titles and a screen from this plugin"
                    .into(),
            );
        }
        validate_slash_commands(slash_commands, self.server.as_ref())?;
        lifecycle::validate(lifecycle_hooks, self.server.as_ref())?;
        theme::validate(themes)?;
        Ok(())
    }
}

impl PluginBundle {
    fn manifest_only(manifest: Manifest) -> Result<Self, AppCommandError> {
        if manifest.server.is_some() || manifest.client.is_some() {
            return Err(invalid("Review the plugin source to install its modules"));
        }
        Ok(Self {
            manifest,
            server_code: None,
            client_html: None,
            rpc: BTreeMap::new(),
        })
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

fn validate_slash_commands(
    commands: &[SlashCommand],
    server: Option<&ServerModule>,
) -> Result<(), String> {
    if commands.is_empty() {
        return Ok(());
    }
    let server = server.ok_or("Slash commands need a plugin server module")?;
    let mut names = BTreeSet::new();
    if commands.len() > MAX_CONTRIBUTIONS
        || commands.iter().any(|command| {
            command.name.len() > 48
                || !valid_id(&command.name)
                || command.name.contains('.')
                || !names.insert(&command.name)
                || !valid_label(&command.description)
                || !valid_translations(&command.description_translations, valid_label)
                || command
                    .argument_hint
                    .as_deref()
                    .is_some_and(|hint| !valid_label(hint))
                || !server.methods.contains(&command.method)
        })
    {
        return Err("Provide up to 16 slash commands with unique names, valid labels and declared server methods".into());
    }
    Ok(())
}

fn valid_panel_text(value: &str) -> bool {
    !value.trim().is_empty() && value.len() <= 4096
}

fn load_catalog(path: &Path) -> Result<Catalog, String> {
    let file = match std::fs::File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Catalog::new()),
        Err(error) => return Err(error.to_string()),
    };
    // A JSON string can expand each byte to a six-byte escape sequence.
    let max_bytes = ((MAX_MANIFEST_BYTES
        + (runtime::MAX_MODULE_BYTES + MAX_CLIENT_HTML_BYTES) * 6
        + settings::MAX_SETTINGS_BYTES
        + 4096)
        * MAX_PLUGINS) as u64;
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
    for mut plugin in catalog {
        plugin.manifest.validate()?;
        plugin.rpc = plugin.manifest.compile_rpc()?;
        match (&plugin.manifest.server, &plugin.server_code) {
            (None, None) => {}
            (Some(_), Some(code))
                if code.len() <= runtime::MAX_MODULE_BYTES && !code.trim().is_empty() => {}
            _ => return Err("Missing or invalid installed plugin module".to_owned()),
        }
        match (&plugin.manifest.client, &plugin.client_html) {
            (None, None) => {}
            (Some(_), Some(html))
                if html.len() <= MAX_CLIENT_HTML_BYTES && !html.trim().is_empty() => {}
            _ => return Err("Missing or invalid installed plugin client module".to_owned()),
        }
        if let Some(settings) = &plugin.settings {
            settings::check_size(&settings.value).map_err(|error| error.to_string())?;
            if let Some(definition) = &plugin.manifest.settings {
                if definition.version < settings.version
                    || (plugin.enabled && definition.version != settings.version)
                {
                    return Err("The installed plugin settings version is invalid".to_owned());
                }
                if definition.version == settings.version {
                    definition
                        .check_value(&settings.value)
                        .map_err(|error| error.to_string())?;
                }
            }
        } else if let Some(definition) = &plugin.manifest.settings {
            plugin.settings = Some(PluginSettings::new(
                definition.version,
                definition.defaults.clone(),
            ));
        }
        if result.insert(plugin.manifest.id.clone(), plugin).is_some() {
            return Err("Duplicate installed plugin ID".to_owned());
        }
    }
    Ok(result)
}

fn write_catalog(path: &Path, catalog: &Catalog) -> Result<(), AppCommandError> {
    #[derive(Serialize)]
    struct StoredPlugin<'a> {
        #[serde(flatten)]
        plugin: &'a InstalledPlugin,
        #[serde(skip_serializing_if = "Option::is_none")]
        server_code: Option<&'a str>,
        #[serde(skip_serializing_if = "Option::is_none")]
        client_html: Option<&'a str>,
        #[serde(skip_serializing_if = "Option::is_none")]
        settings: Option<&'a PluginSettings>,
    }
    let write = || -> Result<(), Box<dyn std::error::Error>> {
        let dir = path.parent().expect("host plugin catalog has a parent");
        std::fs::create_dir_all(dir)?;
        let mut file = tempfile::NamedTempFile::new_in(dir)?;
        let stored: Vec<_> = catalog
            .values()
            .map(|plugin| StoredPlugin {
                plugin,
                server_code: plugin.server_code.as_deref(),
                client_html: plugin.client_html.as_deref(),
                settings: plugin.settings.as_ref(),
            })
            .collect();
        serde_json::to_writer(&mut file, &stored)?;
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

    #[test]
    fn preserves_localized_manifest_text_after_reopening_the_catalog() {
        let data = tempfile::tempdir().unwrap();
        let example = include_str!("../../examples/plugins/localized-notes/codeg-plugin.json");
        let expected = Manifest::parse(example).unwrap();
        let host = HostPlugins::new(data.path());
        install(&host, SAMPLE).unwrap();
        install(&host, example).unwrap();

        let reopened = HostPlugins::new(data.path());
        let installed = reopened.list().unwrap();
        assert_eq!(installed.len(), 2);
        assert!(installed.iter().any(|plugin| plugin.manifest == expected));
        let legacy = Manifest::parse(SAMPLE).unwrap();
        assert!(installed.iter().any(|plugin| plugin.manifest == legacy));
        let legacy_wire = serde_json::to_value(legacy).unwrap();
        assert!(legacy_wire["name"].is_string());
        assert!(legacy_wire.get("nameTranslations").is_none());

        let rendered = serde_json::to_value(expected).unwrap();
        let original: serde_json::Value = serde_json::from_str(example).unwrap();
        assert_eq!(rendered["name"], original["name"]);
        assert_eq!(rendered["nameTranslations"], original["nameTranslations"]);
        for contribution in ["workspacePanels", "commands"] {
            assert_eq!(
                rendered["contributes"][contribution],
                original["contributes"][contribution]
            );
        }
    }

    #[test]
    fn rejects_invalid_localized_text_in_a_manifest() {
        use serde_json::json;

        let mut manifest: serde_json::Value = serde_json::from_str(SAMPLE).unwrap();
        for invalid in [
            json!({"zh-cn": "Wrong case"}),
            json!({"zh-Hans-CN": ""}),
            json!({"en": "Invalid\nlabel"}),
            json!({"en": "x".repeat(101)}),
            json!({"en": 1}),
        ] {
            manifest["contributes"]["workspacePanels"][0]["titleTranslations"] = invalid;
            assert!(Manifest::parse(&manifest.to_string()).is_err());
        }
        let mut manifest: serde_json::Value = serde_json::from_str(SAMPLE).unwrap();
        manifest["contributes"]["workspacePanels"][0]["textTranslations"] =
            json!({"en": "This view has no static text field"});
        assert!(Manifest::parse(&manifest.to_string()).is_err());
    }

    #[test]
    fn validates_client_slots_and_exposes_them_in_the_manifest() {
        let surfaces = serde_json::json!([
            { "id": "details", "title": "Session details", "slot": "sessionHeader" },
            { "id": "insert", "title": "Insert snippet", "slot": "composer" }
        ]);
        let manifest = serde_json::json!({
            "apiVersion": 2, "id": "test.client-slots", "name": "Client slots", "version": "1.0.0",
            "client": { "entry": "slots.html" }, "contributes": { "clientSurfaces": surfaces }
        });
        let parsed = Manifest::parse(&manifest.to_string()).unwrap();
        assert_eq!(
            serde_json::to_value(parsed).unwrap()["contributes"]["clientSurfaces"],
            surfaces
        );

        let mut missing_entry = manifest.clone();
        missing_entry.as_object_mut().unwrap().remove("client");
        missing_entry["apiVersion"] = 1.into();
        let mut duplicate = manifest.clone();
        duplicate["contributes"]["clientSurfaces"][1]["id"] = "details".into();
        let mut unknown = manifest;
        unknown["contributes"]["clientSurfaces"][0]["slot"] = "unknown".into();
        for rejected in [missing_entry, duplicate, unknown] {
            assert!(Manifest::parse(&rejected.to_string()).is_err());
        }
    }

    #[test]
    fn validates_plugin_navigation_and_limits_targets_to_the_same_manifest() {
        use serde_json::json;

        let source = include_str!("../../examples/plugins/plugin-navigation/codeg-plugin.json");
        let manifest: serde_json::Value = serde_json::from_str(source).unwrap();
        let wire = serde_json::to_value(Manifest::parse(source).unwrap()).unwrap();
        for key in ["screens", "sidebarItems"] {
            assert_eq!(wire["contributes"][key], manifest["contributes"][key]);
            let mut duplicate = manifest.clone();
            duplicate["contributes"][key][1]["id"] = json!("overview");
            assert!(Manifest::parse(&duplicate.to_string()).is_err());

            let mut too_many = manifest.clone();
            let entries = too_many["contributes"][key].as_array_mut().unwrap();
            let template = entries[0].clone();
            for i in entries.len()..=MAX_CONTRIBUTIONS {
                let mut entry = template.clone();
                entry["id"] = json!(format!("example-{i}"));
                entries.push(entry);
            }
            assert!(Manifest::parse(&too_many.to_string()).is_err());
        }

        let mut missing_client = manifest.clone();
        missing_client.as_object_mut().unwrap().remove("client");
        missing_client["server"] = json!({"entry": "server.mjs", "methods": ["describe"]});
        let error = Manifest::parse(&missing_client.to_string()).unwrap_err();
        assert!(error.to_string().contains("need a client entry"));

        for (field, value) in [("screenId", "other.overview"), ("placement", "middle")] {
            let mut invalid = manifest.clone();
            invalid["contributes"]["sidebarItems"][0][field] = json!(value);
            assert!(Manifest::parse(&invalid.to_string()).is_err());
        }
    }

    #[test]
    fn validates_slash_commands_against_their_own_server_methods() {
        use serde_json::json;

        let source = include_str!("../../examples/plugins/composer-commands/codeg-plugin.json");
        let manifest: serde_json::Value = serde_json::from_str(source).unwrap();
        let wire = serde_json::to_value(Manifest::parse(source).unwrap()).unwrap();
        assert_eq!(
            wire["contributes"]["slashCommands"],
            manifest["contributes"]["slashCommands"]
        );
        for (field, value) in [
            ("name", json!("/workspace-check")),
            ("name", json!("x".repeat(49))),
            ("name", json!("session-check")),
            ("name", json!("plugin.command")),
            ("description", json!("\n")),
            ("descriptionTranslations", json!({ "en": "" })),
            ("argumentHint", json!("")),
            ("scope", json!("global")),
            ("method", json!("not-registered")),
        ] {
            let mut invalid = manifest.clone();
            invalid["contributes"]["slashCommands"][0][field] = value;
            assert!(Manifest::parse(&invalid.to_string()).is_err(), "{field}");
        }

        let mut too_many = manifest.clone();
        let commands = too_many["contributes"]["slashCommands"]
            .as_array_mut()
            .unwrap();
        let template = commands[0].clone();
        for index in commands.len()..=MAX_CONTRIBUTIONS {
            let mut command = template.clone();
            command["name"] = json!(format!("command-{index}"));
            commands.push(command);
        }
        assert!(Manifest::parse(&too_many.to_string()).is_err());

        let mut missing_entry = manifest;
        missing_entry.as_object_mut().unwrap().remove("server");
        missing_entry["client"] = json!({ "entry": "panel.html" });
        let error = Manifest::parse(&missing_entry.to_string()).unwrap_err();
        assert!(error.to_string().contains("need a plugin server module"));
    }

    #[test]
    fn validates_detail_and_activation_contributions_in_the_reviewed_manifest() {
        use serde_json::json;

        let manifest = json!({
            "apiVersion": 2, "id": "test.plugin-settings", "name": "Plugin Settings", "version": "1.0.0",
            "server": { "entry": "settings.mjs", "methods": ["summary"] },
            "client": { "entry": "settings.html" },
            "contributes": {
                "pluginDetail": { "id": "details", "title": "Details" },
                "activationPanel": { "id": "setup", "title": "Get started" }
            }
        });
        let parsed = Manifest::parse(&manifest.to_string()).unwrap();
        let serialized = serde_json::to_value(parsed).unwrap();
        for field in ["pluginDetail", "activationPanel"] {
            assert_eq!(
                serialized["contributes"][field],
                manifest["contributes"][field]
            );
            for (key, value) in [("id", "bad/id"), ("title", "")] {
                let mut invalid = manifest.clone();
                invalid["contributes"][field][key] = json!(value);
                assert!(Manifest::parse(&invalid.to_string()).is_err());
            }
            let mut missing_entry = manifest.clone();
            missing_entry.as_object_mut().unwrap().remove("client");
            let other = if field == "pluginDetail" {
                "activationPanel"
            } else {
                "pluginDetail"
            };
            missing_entry["contributes"]
                .as_object_mut()
                .unwrap()
                .remove(other);
            assert!(Manifest::parse(&missing_entry.to_string()).is_err());
        }
    }

    #[tokio::test]
    async fn enforces_rpc_schemas_across_install_call_and_restart() {
        use serde_json::{json, Value};

        let data = tempfile::tempdir().unwrap();
        let source = tempfile::tempdir().unwrap();
        let manifest_path = source.path().join("codeg-plugin.json");
        let source_dir = source.path().to_str().unwrap();
        let id = "test.typed-rpc";
        let mut manifest = json!({
            "apiVersion": 2, "id": id, "name": "Typed RPC", "version": "1.0.0",
            "server": {
                "entry": "echo.mjs", "methods": ["echo", "legacy"],
                "rpc": { "echo": {
                    "input": { "$ref": "#/$defs/message", "$defs": {"message": {"type": "integer"}} },
                    "output": { "type": "integer" }
                }}
            },
            "contributes": {}
        });
        std::fs::write(source.path().join("echo.mjs"),
            "export const handle = (method, value) => method === 'echo' && value === 0 ? 'wrong result' : value;").unwrap();
        let plugins = HostPlugins::new(data.path());
        let mut remote_schema = manifest.clone();
        remote_schema["server"]["rpc"]["echo"]["input"] =
            json!({"$ref":"https://example.invalid/schema"});
        std::fs::write(&manifest_path, remote_schema.to_string()).unwrap();
        let error = plugins
            .preview_install(source_dir, source::Registry::Npm, None)
            .await
            .err()
            .unwrap();
        assert!(error.to_string().contains("invalid input JSON Schema"));

        std::fs::write(&manifest_path, manifest.to_string()).unwrap();
        let preview = plugins
            .preview_install(source_dir, source::Registry::Npm, None)
            .await
            .unwrap();
        plugins.confirm_install(preview.ticket).unwrap();
        plugins
            .apply(Mutation::SetEnabled {
                id: id.into(),
                enabled: true,
            })
            .unwrap();
        let reopened = HostPlugins::new(data.path());
        assert_eq!(
            reopened.call(id, "echo".into(), json!(2)).await.unwrap(),
            json!(2)
        );
        assert_eq!(
            reopened
                .call(id, "legacy".into(), Value::Null)
                .await
                .unwrap(),
            Value::Null
        );
        let bad_input = reopened
            .call(id, "echo".into(), json!("2"))
            .await
            .unwrap_err();
        assert!(matches!(bad_input.code, AppErrorCode::InvalidInput));
        let bad_output = reopened
            .call(id, "echo".into(), json!(0))
            .await
            .unwrap_err();
        assert!(matches!(bad_output.code, AppErrorCode::TaskExecutionFailed));

        manifest["server"]["rpc"]["echo"]["output"] = json!({"type":"string"});
        std::fs::write(&manifest_path, manifest.to_string()).unwrap();
        assert!(reopened.update(id).await.unwrap().disabled_for_update);
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

    #[tokio::test]
    async fn runs_only_an_enabled_snapshot_and_disables_changed_executable_updates() {
        let data = tempfile::tempdir().unwrap();
        let directory = tempfile::tempdir().unwrap();
        let manifest = include_str!("../../examples/plugins/workspace-summary/codeg-plugin.json");
        let code = include_str!("../../examples/plugins/workspace-summary/summary.mjs");
        let id = "codeg.workspace-summary";
        let input = serde_json::json!({ "folderId": 42 });
        let registry = source::Registry::Npm;
        let path = directory.path().to_str().unwrap();
        let entry = directory.path().join("summary.mjs");
        std::fs::write(directory.path().join("codeg-plugin.json"), manifest).unwrap();
        let host = HostPlugins::new(data.path());

        assert!(install(&host, manifest).is_err());
        assert!(host.preview_install(path, registry, None).await.is_err());
        std::fs::write(&entry, code).unwrap();
        assert!(source::install(&host, path, registry).await.is_err());
        let preview = host.preview_install(path, registry, None).await.unwrap();
        std::fs::write(&entry, "export const handle = () => 'changed';").unwrap();
        let catalog = host.confirm_install(preview.ticket).unwrap();
        assert!(serde_json::to_string(&catalog)
            .unwrap()
            .find("server_code")
            .is_none());
        assert!(host
            .call(id, "summary".into(), input.clone())
            .await
            .is_err());
        host.apply(Mutation::SetEnabled {
            id: id.into(),
            enabled: true,
        })
        .unwrap();

        let reopened = HostPlugins::new(data.path());
        assert!(reopened
            .call(id, "unknown".into(), input.clone())
            .await
            .is_err());
        assert_eq!(
            reopened
                .call(id, "summary".into(), input.clone())
                .await
                .unwrap(),
            "Workspace #42\nGenerated by the Workspace Summary plugin."
        );
        let update = reopened.update(id).await.unwrap();
        assert!(update.updated && update.disabled_for_update);
        assert!(reopened
            .call(id, "summary".into(), input.clone())
            .await
            .is_err());
        reopened
            .apply(Mutation::SetEnabled {
                id: id.into(),
                enabled: true,
            })
            .unwrap();
        assert_eq!(
            reopened
                .call(id, "summary".into(), input.clone())
                .await
                .unwrap(),
            "changed"
        );
        reopened.apply(Mutation::Remove { id: id.into() }).unwrap();
        assert!(reopened.call(id, "summary".into(), input).await.is_err());
    }

    #[tokio::test]
    async fn serves_the_reviewed_client_entry_only_while_enabled() {
        let data = tempfile::tempdir().unwrap();
        let directory = tempfile::tempdir().unwrap();
        let id = "codeg.workspace-inspector";
        let host = HostPlugins::new(data.path());
        let source = directory.path();
        let original = include_str!("../../examples/plugins/workspace-inspector/inspector.html");
        let manifest = include_str!("../../examples/plugins/workspace-inspector/codeg-plugin.json");
        let module = include_str!("../../examples/plugins/workspace-inspector/inspector.mjs");
        std::fs::write(source.join("codeg-plugin.json"), manifest).unwrap();
        std::fs::write(source.join("inspector.mjs"), module).unwrap();
        let input = source.to_str().unwrap();
        let registry = source::Registry::Npm;
        assert!(host.preview_install(input, registry, None).await.is_err());

        let entry = source.join("inspector.html");
        std::fs::write(&entry, original).unwrap();
        let preview = host.preview_install(input, registry, None).await.unwrap();
        std::fs::write(&entry, "<p>Updated client</p>").unwrap();
        let catalog = host.confirm_install(preview.ticket).unwrap();
        assert!(!serde_json::to_string(&catalog)
            .unwrap()
            .contains("client_html"));
        assert!(host.client_html(id).is_err());
        host.apply(Mutation::SetEnabled {
            id: id.into(),
            enabled: true,
        })
        .unwrap();

        let reopened = HostPlugins::new(data.path());
        assert_eq!(reopened.client_html(id).unwrap().as_ref(), original);
        assert!(reopened.update(id).await.unwrap().disabled_for_update);
        assert!(reopened.client_html(id).is_err());
        reopened
            .apply(Mutation::SetEnabled {
                id: id.into(),
                enabled: true,
            })
            .unwrap();
        assert_eq!(
            reopened.client_html(id).unwrap().as_ref(),
            "<p>Updated client</p>"
        );
    }

    #[tokio::test]
    async fn settings_are_validated_and_migrated_when_an_update_is_enabled() {
        let data = tempfile::tempdir().unwrap();
        let directory = tempfile::tempdir().unwrap();
        let id = "codeg.workspace-inspector";
        let host = HostPlugins::new(data.path());
        let source = directory.path();
        let path = source.join("codeg-plugin.json");
        let module = source.join("inspector.mjs");
        let enable = || Mutation::SetEnabled {
            id: id.into(),
            enabled: true,
        };
        let mut manifest: serde_json::Value = serde_json::from_str(include_str!(
            "../../examples/plugins/workspace-inspector/codeg-plugin.json"
        ))
        .unwrap();
        std::fs::write(&path, manifest.to_string()).unwrap();
        std::fs::write(
            &module,
            include_str!("../../examples/plugins/workspace-inspector/inspector.mjs"),
        )
        .unwrap();
        std::fs::write(source.join("inspector.html"), "<p>Test</p>").unwrap();
        let preview = host
            .preview_install(source.to_str().unwrap(), source::Registry::Npm, None)
            .await
            .unwrap();
        host.confirm_install(preview.ticket).unwrap();
        host.apply(enable()).unwrap();

        let defaults = host.settings(id).unwrap();
        assert_eq!(defaults.value, serde_json::json!({"label":"Workspace"}));
        assert!(host
            .save_settings(id, defaults.revision, serde_json::json!({"label":42}))
            .is_err());
        let saved = host
            .save_settings(
                id,
                defaults.revision,
                serde_json::json!({"label":"Project"}),
            )
            .unwrap();
        assert!(host
            .save_settings(id, defaults.revision, defaults.value)
            .is_err());
        assert_eq!(
            HostPlugins::new(data.path()).settings(id).unwrap().revision,
            saved.revision
        );

        manifest["version"] = serde_json::json!("2.0.0");
        manifest["settings"] = serde_json::json!({
            "version": 2, "migrate": true, "defaults": {"name": "Workspace"},
            "schema": {"type": "object", "properties": {"name": {"type": "string"}}, "required": ["name"], "additionalProperties": false}
        });
        std::fs::write(&path, manifest.to_string()).unwrap();
        std::fs::write(&module, "export const handle = () => null").unwrap();
        assert!(host.update(id).await.unwrap().disabled_for_update);
        assert!(host.apply(enable()).is_err());
        assert!(!host.list().unwrap()[0].enabled);

        std::fs::write(&module, "export function handle(method, input, settings) { if (method === 'settings.migrate') return {name: input.value.label}; return settings.name; }").unwrap();
        assert!(host.update(id).await.unwrap().updated);
        let reopened = HostPlugins::new(data.path());
        reopened.apply(enable()).unwrap();
        let settings = reopened.settings(id).unwrap();
        assert_eq!(settings.version, 2);
        assert_eq!(settings.value, serde_json::json!({"name":"Project"}));
        assert_ne!(settings.revision, saved.revision);
        assert!(reopened
            .call(
                id,
                settings::MIGRATION_METHOD.into(),
                serde_json::Value::Null
            )
            .await
            .is_err());
        assert_eq!(
            reopened
                .call(id, "describe".into(), serde_json::Value::Null)
                .await
                .unwrap(),
            "Project"
        );
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
            .install(
                PluginBundle::manifest_only(Manifest::parse(SAMPLE).unwrap()).unwrap(),
                Some(source.clone()),
            )
            .unwrap();
        let revision = &installed[0].revision;
        set_enabled(&host, true);
        let updated = Manifest::parse(&SAMPLE.replace("1.0.0", "1.1.0")).unwrap();
        host.replace(
            ID,
            revision,
            PluginBundle::manifest_only(updated.clone()).unwrap(),
            source.clone(),
        )
        .unwrap();
        assert!(host.list().unwrap()[0].enabled);
        assert!(host
            .replace(
                ID,
                revision,
                PluginBundle::manifest_only(updated).unwrap(),
                source
            )
            .is_err());
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
        let emitter = EventEmitter::web_only(broadcaster.clone(), bus.clone(), None);
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
                .observe_sessions(events, connections, emitter)
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
