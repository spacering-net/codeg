//! Installing, updating and removing MCP servers from Harness (plan §7.4).
//!
//! An install is three calls' worth of care around the MCP engine
//! (`commands::mcp_engine`), which does every write:
//!
//! 1. **Plan** ([`plan`]): the version's install info (its server.json and
//!    files — what never changes) and its `/resolve` snapshot (status, risk,
//!    review, permissions, checks, package verification and their
//!    fingerprint — read fresh, never from a cache), the options the
//!    server.json offers with what blocks or needs saying about each, the
//!    name to install under and what it would collide with, the agents to
//!    install to, and the basis of every agent's config.
//! 2. **Install** ([`install`]), with what the user confirmed: the engine's
//!    preflight with the basis the dialog showed (a file changed since:
//!    nothing written, plan again); the snapshot read once more and
//!    compared by fingerprint (worse: abort; otherwise different: show what
//!    changed and confirm again); then the commit with the preflight's basis,
//!    and the provenance record written in the step the engine runs before
//!    it lets the MCP write lock go.
//! 3. **Listing and uninstall** ([`installed`], [`uninstall`]): the record
//!    against the agents' configs as they are now. These touch only local
//!    files, so they work with `CODEG_HARNESS=off`.
//!
//! Nothing is installed except by [`install`], called with a person's
//! confirmation; `codeg-mcp` exposes none of this.

mod convert;
pub mod model;
pub(crate) mod record;
mod recover;
pub mod remote;
// The skills install (`harness::skills`) decides on the same snapshot.
pub(crate) mod snapshot;

#[cfg(test)]
mod tests;

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

use serde_json::{Map, Value};

use crate::app_error::{AppCommandError, AppErrorCode};
use crate::commands::mcp::McpAppType;
use crate::commands::mcp_engine::agents::EngineCtx;
use crate::commands::mcp_engine::apply::changed_agents;
use crate::commands::mcp_engine::model::codes as engine_codes;
use crate::commands::mcp_engine::model::{
    is_valid_new_key, McpApplyOutcome, McpApplyRequest, McpApplyResult, McpDefinition,
    McpFileStatus, McpInventory, McpIssue, McpOp, McpOpAction, McpOpEffect, McpTransport,
    KEY_PATTERN, RESERVED_KEY,
};
use crate::commands::mcp_engine::{self, inventory, lock};
use crate::db::AppDatabase;
use crate::web::event_bridge::{emit_event, EventEmitter};

use super::error::HarnessError;
use super::types::{Installed, Kind, Localized, Resolved, VersionState, VersionStatus};
use super::{Harness, ItemRef};

use convert::{Analyzed, Pin};
// Whether a pin names one exact release: the skills install asks it too.
pub(crate) use convert::is_exact_version;
pub use model::*;
use record::{AgentRead, Record, RecordAgent, RecordError, RecordItem};

/// The provenance record cannot be read (`listing`). Detail: why.
pub const I18N_KEY_RECORD_UNREADABLE: &str = "Harness.errors.recordUnreadable";

/// The longest server name: the engine's rule for new names.
const MAX_KEY: usize = 64;

/// The local side of these commands: the agents' config files as the engine
/// sees them, which agents are installed, and where the record is. Made per
/// command from the database; a test points all of it at a temp directory.
#[derive(Debug, Clone)]
pub(crate) struct Local {
    pub engine: EngineCtx,
    pub installed: BTreeMap<McpAppType, bool>,
    pub record_path: PathBuf,
}

impl Local {
    pub(crate) async fn from_db(db: &AppDatabase) -> Self {
        Self {
            engine: mcp_engine::engine_ctx(db).await,
            installed: mcp_engine::installed_agents(db).await,
            record_path: record::default_record_path(),
        }
    }
}

async fn off_thread<T: Send + 'static>(
    work: impl FnOnce() -> T + Send + 'static,
) -> Result<T, AppCommandError> {
    tokio::task::spawn_blocking(work)
        .await
        .map_err(|e| AppCommandError::task_execution_failed(format!("Harness MCP: {e}")))
}

async fn read_inventory(local: &Local) -> Result<McpInventory, AppCommandError> {
    let engine = local.engine.clone();
    let installed = local.installed.clone();
    off_thread(move || inventory::inventory(&engine, &installed)).await
}

/// What the inventory read of each agent, as the record's scan takes it.
fn reads_of(inventory: &McpInventory) -> BTreeMap<McpAppType, AgentRead> {
    inventory
        .agents
        .iter()
        .map(|agent| {
            let read = if agent.config.status == McpFileStatus::Unreadable {
                AgentRead::Unreadable
            } else {
                AgentRead::Entries(agent.entries.clone())
            };
            (agent.agent, read)
        })
        .collect()
}

fn record_error(error: &RecordError) -> AppCommandError {
    AppCommandError::new(
        AppErrorCode::IoError,
        "the record of what Codeg installed from Harness cannot be read",
    )
    .with_detail(error.detail())
    .with_i18n(I18N_KEY_RECORD_UNREADABLE, BTreeMap::new())
}

async fn latest_revision(harness: &Harness, item_ref: &ItemRef) -> Result<u64, HarnessError> {
    let item = harness.item(&item_ref.to_string()).await?;
    item.get("latest")
        .and_then(|latest| latest.get("revision"))
        .and_then(Value::as_u64)
        .filter(|revision| *revision > 0)
        .ok_or_else(|| HarnessError::invalid_response("the item names no latest revision"))
}

async fn resolve_one(harness: &Harness, id: &str, revision: u64) -> Result<Resolved, HarnessError> {
    harness
        .resolve(&[Installed {
            id: id.to_string(),
            revision,
        }])
        .await?
        .into_iter()
        .next()
        .ok_or_else(|| HarnessError::invalid_response("/resolve answered nothing"))
}

fn pins_of(state: Option<&VersionState>) -> Vec<Pin> {
    state
        .and_then(|state| state.packages.as_ref())
        .map(|packages| packages.iter().map(Pin::from_state).collect())
        .unwrap_or_default()
}

fn transport_priority(transport: McpTransport) -> u8 {
    match transport {
        McpTransport::Stdio => 0,
        McpTransport::Http => 1,
        McpTransport::Sse => 2,
    }
}

/// The item's name; else `<name>-<publisher>` (dots made dashes, cut to 64);
/// else that with `-2`, `-3`, … — the first `taken` does not refuse.
pub(super) fn default_key(name: &str, publisher: &str, taken: impl Fn(&str) -> bool) -> String {
    if !taken(name) {
        return name.to_string();
    }
    let cut = |text: &str, max: usize| -> String {
        let mut cut: String = text.chars().take(max).collect();
        while cut.ends_with('-') {
            cut.pop();
        }
        cut
    };
    let base = cut(&format!("{name}-{}", publisher.replace('.', "-")), MAX_KEY);
    if !taken(&base) {
        return base;
    }
    let mut number = 2u64;
    loop {
        let suffix = format!("-{number}");
        let candidate = format!("{}{suffix}", cut(&base, MAX_KEY - suffix.len()));
        if !taken(&candidate) {
            return candidate;
        }
        number += 1;
    }
}

// ─── harness_mcp_plan ───────────────────────────────────────────────────

/// Everything the install dialog shows, in one answer. Fails only when the
/// catalog cannot be asked (switched off, unreachable, no such item or
/// revision); everything about the item itself is in the answer.
pub(crate) async fn plan(
    local: &Local,
    harness: &Harness,
    item_ref: &str,
    revision: Option<u64>,
) -> Result<HarnessMcpPlan, AppCommandError> {
    harness.ensure_enabled()?;
    let item_ref = ItemRef::parse(item_ref)?;
    let revision = match revision {
        Some(revision) => revision,
        None => latest_revision(harness, &item_ref).await?,
    };
    let info = harness.install_info(&item_ref, revision).await?;
    let resolved = resolve_one(harness, &info.item.id, revision).await?;
    let snapshot = resolved.installed.clone();
    if let Some(state) = &snapshot {
        snapshot::remember(state);
    }
    let inventory = read_inventory(local).await?;

    let mut blocking = Vec::new();
    if info.item.kind != Kind::Mcp {
        blocking.push(
            Reason::new(codes::NOT_AN_MCP_SERVER).param("kind", snapshot::wire(&info.item.kind)),
        );
    }
    for reason in snapshot::item_blocking(&resolved, revision) {
        if !blocking.iter().any(|known| known.code == reason.code) {
            blocking.push(reason);
        }
    }
    let record = match record::load(&local.record_path) {
        Ok(record) => record,
        Err(error) => {
            blocking.push(error.reason());
            Record::default()
        }
    };
    let confirm = snapshot::confirmations(snapshot.as_ref());

    let pins = pins_of(snapshot.as_ref());
    let analyzed: Vec<Analyzed> = match &info.server {
        Some(server) => convert::analyze(server, &pins).unwrap_or_else(|reason| {
            blocking.push(reason);
            Vec::new()
        }),
        None => {
            blocking.push(Reason::new(codes::NOTHING_TO_INSTALL));
            Vec::new()
        }
    };

    let reads = reads_of(&inventory);
    let recorded = record.items.get(&info.item.id);
    let installed = recorded.and_then(|item| record::listed_item(&info.item.id, item, &reads));
    let recorded_agents: Option<BTreeSet<McpAppType>> = recorded.map(|item| {
        item.known_agents()
            .into_iter()
            .map(|(agent, _)| agent)
            .collect()
    });
    // An update goes to the agents that have it; a first install to those
    // installed here — each only where the option's transport is taken.
    let targets_for = |transport: McpTransport| -> Vec<McpAppType> {
        inventory
            .agents
            .iter()
            .filter(|agent| agent.writable && agent.transports.contains(&transport))
            .filter(|agent| match &recorded_agents {
                Some(recorded) => recorded.contains(&agent.agent),
                None => agent.installed == Some(true),
            })
            .map(|agent| agent.agent)
            .collect()
    };

    let permissions = snapshot
        .as_ref()
        .and_then(|state| state.permissions.as_ref());
    let mut options: Vec<PlanOption> = analyzed
        .iter()
        .map(|option| {
            let (more_blocking, more_warnings) =
                convert::package_reasons(option, &pins, permissions);
            let mut option_blocking = option.blocking.clone();
            option_blocking.extend(more_blocking);
            let mut warnings = option.warnings.clone();
            warnings.extend(more_warnings);
            PlanOption {
                id: option.id.clone(),
                transport: option.transport,
                source: option.source,
                package: convert::plan_package(option, &pins),
                definition: option.definition.clone(),
                url: option.url.clone(),
                parameters: option.parameters.clone(),
                selectable: option_blocking.is_empty() && blocking.is_empty(),
                blocking: option_blocking,
                warnings,
                default_targets: targets_for(option.transport),
                default_replace: Vec::new(),
                recovery: None,
            }
        })
        .collect();

    // The name, and what is already under it.
    let entry_of = |agent: McpAppType, key: &str| {
        inventory
            .agents
            .iter()
            .find(|found| found.agent == agent)
            .and_then(|found| found.entries.iter().find(|entry| entry.key == key))
    };
    let ours = |agent: McpAppType, key: &str| -> Option<&RecordAgent> {
        recorded
            .filter(|item| item.key == key)
            .and_then(|item| item.agents.get(&record::name_of(agent)))
    };
    let considered: BTreeSet<McpAppType> = {
        let selectable: Vec<&PlanOption> = options
            .iter()
            .filter(|option| option.blocking.is_empty())
            .collect();
        let pool = if selectable.is_empty() {
            options.iter().collect()
        } else {
            selectable
        };
        pool.iter()
            .flat_map(|option| option.default_targets.iter().copied())
            .collect()
    };
    let name = item_ref.name().to_string();
    let default = match recorded {
        Some(item) => item.key.clone(),
        None => default_key(&name, item_ref.publisher(), |key| {
            key == RESERVED_KEY
                || considered
                    .iter()
                    .any(|agent| entry_of(*agent, key).is_some() && ours(*agent, key).is_none())
        }),
    };
    // Who an entry under `key` in `agent` belongs to, by the record.
    let owner_of = |agent: McpAppType, key: &str| -> (EntryOwner, Option<String>, Option<String>) {
        if ours(agent, key).is_some() {
            return (
                EntryOwner::ThisItem,
                Some(info.item.id.clone()),
                Some(info.item.r#ref.clone()),
            );
        }
        match record.items.iter().find(|(id, item)| {
            **id != info.item.id
                && item.key == key
                && item.agents.contains_key(&record::name_of(agent))
        }) {
            Some((id, item)) => (
                EntryOwner::OtherItem,
                Some(id.clone()),
                Some(item.item_ref.clone()),
            ),
            None => (EntryOwner::Elsewhere, None, None),
        }
    };
    let mut conflicts = Vec::new();
    let mut keys = vec![name.clone()];
    if default != name {
        keys.push(default.clone());
    }
    for key in &keys {
        for agent in &inventory.agents {
            let Some(entry) = entry_of(agent.agent, key) else {
                continue;
            };
            let (owner, item_id, item_ref, state) = match ours(agent.agent, key) {
                Some(mine) => {
                    let state = if entry.fingerprint.as_deref() == Some(&mine.definition_sha256) {
                        LocalState::AsInstalled
                    } else {
                        LocalState::ChangedLocally
                    };
                    (EntryOwner::ThisItem, None, None, Some(state))
                }
                None => {
                    let (owner, item_id, item_ref) = owner_of(agent.agent, key);
                    (owner, item_id, item_ref, None)
                }
            };
            conflicts.push(KeyConflict {
                key: key.clone(),
                agent: agent.agent,
                owner,
                item_id,
                item_ref,
                state,
                definition: entry.definition.clone(),
                enabled: entry.enabled,
            });
        }
    }
    for option in &mut options {
        option.default_replace = option
            .default_targets
            .iter()
            .copied()
            .filter(|agent| {
                entry_of(*agent, &default).is_some() && ours(*agent, &default).is_some()
            })
            .collect();
    }
    // An installed item: what its own entries hold, read back into the
    // parameters of the option each was installed with — in the shape of
    // the revision it was installed from (its own server.json: the same
    // option id can be written otherwise in another revision).
    if let (Some(item), Some(server)) = (recorded, info.server.as_ref()) {
        let mut schemas: BTreeMap<u64, Option<recover::Schema>> = BTreeMap::new();
        for (_, recorded) in item.known_agents() {
            if schemas.contains_key(&recorded.revision) {
                continue;
            }
            let schema = if recorded.revision == revision {
                Some(server.clone())
            } else {
                // Unreadable (gone, offline): nothing of it is carried over.
                harness
                    .install_info(&item_ref, recorded.revision)
                    .await
                    .ok()
                    .and_then(|old| old.server)
            };
            schemas.insert(recorded.revision, schema.map(recover::Schema::new));
        }
        let sources: Vec<recover::Source<'_>> = item
            .known_agents()
            .into_iter()
            .filter_map(|(agent, recorded)| {
                let entry = entry_of(agent, &item.key)?;
                Some(recover::Source {
                    agent,
                    option: recorded.option.as_str(),
                    schema: schemas.get(&recorded.revision).and_then(Option::as_ref),
                    definition: entry.definition.as_ref(),
                })
            })
            .collect();
        for option in &mut options {
            recover::recover_into(option, server, &sources);
        }
    }

    let default_option = {
        let selectable = |id: &str| {
            options
                .iter()
                .any(|option| option.id == id && option.selectable)
        };
        let mut used: BTreeMap<String, usize> = BTreeMap::new();
        for (_, agent) in recorded.map(RecordItem::known_agents).unwrap_or_default() {
            *used.entry(agent.option.clone()).or_default() += 1;
        }
        used.into_iter()
            .filter(|(id, _)| selectable(id))
            .max_by_key(|(_, count)| *count)
            .map(|(id, _)| id)
            .or_else(|| {
                options
                    .iter()
                    .filter(|option| option.selectable)
                    .min_by_key(|option| transport_priority(option.transport))
                    .map(|option| option.id.clone())
            })
    };

    let agents = inventory
        .agents
        .iter()
        .map(|agent| PlanAgent {
            agent: agent.agent,
            installed: agent.installed,
            writable: agent.writable,
            transports: agent.transports.clone(),
            path: agent.config.path.clone(),
            status: agent.config.status,
            basis: agent.config.basis.clone(),
            keys: agent
                .entries
                .iter()
                .map(|entry| entry.key.clone())
                .collect(),
            reason: agent.config.reason.clone().or_else(|| {
                (!agent.writable).then(|| McpIssue::new(engine_codes::MANAGED_BY_AGENT))
            }),
            entries: agent
                .entries
                .iter()
                .map(|entry| {
                    let (owner, item_id, item_ref) = owner_of(agent.agent, &entry.key);
                    ExistingEntry {
                        key: entry.key.clone(),
                        owner,
                        item_id,
                        item_ref,
                    }
                })
                .collect(),
        })
        .collect();
    let basis = inventory
        .agents
        .iter()
        .filter_map(|agent| Some((agent.agent, agent.config.basis.clone()?)))
        .collect();

    Ok(HarnessMcpPlan {
        item: PlanItem {
            id: info.item.id.clone(),
            item_ref: info.item.r#ref.clone(),
            kind: info.item.kind,
            title: info.item.title.clone(),
            revision,
            version: info.version.version.clone(),
            published_at: info.version.published_at.clone(),
        },
        item_status: resolved.status,
        latest: resolved.latest.clone(),
        state_sha256: snapshot
            .as_ref()
            .and_then(|state| state.state_sha256.clone()),
        snapshot,
        blocking,
        confirm,
        options,
        default_option,
        key: KeyPlan {
            name,
            default,
            conflicts,
            pattern: KEY_PATTERN.to_string(),
        },
        agents,
        basis,
        installed,
    })
}

// ─── harness_mcp_install ────────────────────────────────────────────────

impl HarnessMcpInstallResult {
    fn new(outcome: InstallOutcome) -> Self {
        Self {
            outcome,
            issues: Vec::new(),
            changes: Vec::new(),
            snapshot: None,
            state_sha256: None,
            apply: None,
            record: None,
        }
    }

    fn refused(issues: Vec<Reason>, apply: Option<McpApplyResult>) -> Self {
        Self {
            issues,
            apply,
            ..Self::new(InstallOutcome::Refused)
        }
    }
}

impl RecordWrite {
    fn written() -> Self {
        Self {
            status: "written".to_string(),
            code: None,
            detail: None,
        }
    }

    fn unchanged() -> Self {
        Self {
            status: "unchanged".to_string(),
            code: None,
            detail: None,
        }
    }

    fn failed(code: &str, detail: String) -> Self {
        Self {
            status: "failed".to_string(),
            code: Some(code.to_string()),
            detail: Some(detail),
        }
    }
}

/// What an install puts in the record for each agent it wrote.
struct InstallMeta {
    id: String,
    item_ref: String,
    title: Localized,
    key: String,
    revision: u64,
    version: Option<String>,
    option: String,
    transport: McpTransport,
    packages: Vec<PinnedPackageRef>,
    state_sha256: String,
    /// The fingerprint of the definition as handed to the engine: what is
    /// recorded for an agent whose file changed again after the write (or
    /// cannot be read back), so that the change shows as `changed_locally`.
    intended: String,
}

fn set_ops(targets: &[McpAppType], key: &str, definition: &McpDefinition) -> Vec<McpOp> {
    targets
        .iter()
        .map(|agent| McpOp {
            agent: *agent,
            key: key.to_string(),
            action: McpOpAction::Set {
                definition: definition.clone(),
            },
        })
        .collect()
}

/// The basis each agent of a preflight result was found at.
fn basis_of(result: &McpApplyResult) -> BTreeMap<McpAppType, String> {
    result
        .agents
        .iter()
        .filter_map(|agent| Some((agent.agent, agent.basis.clone()?)))
        .collect()
}

/// The install's check under the MCP write lock, before any config is
/// written: the record can still be written, and does not have this item
/// under another name.
fn record_still_allows(path: &Path, meta: &InstallMeta) -> Result<(), Reason> {
    let record = record::load_for_write(path).map_err(|error| error.reason())?;
    match record.items.get(&meta.id) {
        Some(item) if item.key != meta.key && !item.agents.is_empty() => {
            Err(Reason::new(codes::INSTALLED_UNDER_OTHER_KEY).param("key", item.key.clone()))
        }
        _ => Ok(()),
    }
}

/// The fingerprint of what the engine wrote under `key` in `agent`'s config:
/// read back, but only from a file that is still byte for byte what the
/// engine left (`basis`, from its result). An edit made since — the agents
/// take no lock — is not what was installed; `None` then.
fn written_fingerprint(
    engine: &EngineCtx,
    agent: McpAppType,
    key: &str,
    basis: Option<&str>,
) -> Option<String> {
    let paths = engine.paths_of(agent)?;
    let (config, entries) = inventory::read_agent(agent, paths);
    if config.basis.is_none() || config.basis.as_deref() != basis {
        return None;
    }
    entries
        .into_iter()
        .find(|entry| entry.key == key)?
        .fingerprint
}

/// The record step of an install, run while the MCP write lock is held.
fn record_install(
    engine: &EngineCtx,
    path: &Path,
    meta: &InstallMeta,
    targets: &[McpAppType],
    result: &McpApplyResult,
) -> (RecordWrite, Option<InstalledChanged>) {
    if result.outcome != McpApplyOutcome::Applied {
        return (RecordWrite::unchanged(), None);
    }
    let mut record = match record::load_for_write(path) {
        Ok(record) => record,
        Err(error) => {
            return (
                RecordWrite::failed(codes::RECORD_UNREADABLE, error.detail()),
                None,
            )
        }
    };
    let mut ids = BTreeSet::from([meta.id.clone()]);
    // An entry another item had under this name in a target is replaced.
    for (id, item) in record.items.iter_mut() {
        if *id == meta.id || item.key != meta.key {
            continue;
        }
        for agent in targets {
            if item.agents.remove(&record::name_of(*agent)).is_some() {
                ids.insert(id.clone());
            }
        }
    }
    record.items.retain(|_, item| !item.agents.is_empty());
    let item = record
        .items
        .entry(meta.id.clone())
        .or_insert_with(|| RecordItem {
            item_ref: meta.item_ref.clone(),
            key: meta.key.clone(),
            title: None,
            agents: BTreeMap::new(),
            extra: Map::new(),
        });
    // Checked under this same lock before the write (`record_still_allows`):
    // a record that disagrees now was written without the lock, and is left
    // as it is rather than overwritten.
    if item.key != meta.key {
        return (
            RecordWrite::failed(
                codes::RECORD_CONFLICT,
                format!("recorded as `{}`", item.key),
            ),
            None,
        );
    }
    item.item_ref = meta.item_ref.clone();
    item.title = Some(meta.title.clone());
    let installed_at = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    for agent in targets {
        let basis = result
            .agents
            .iter()
            .find(|done| done.agent == *agent)
            .and_then(|done| done.basis.as_deref());
        let definition_sha256 = written_fingerprint(engine, *agent, &meta.key, basis)
            .unwrap_or_else(|| meta.intended.clone());
        item.agents.insert(
            record::name_of(*agent),
            RecordAgent {
                revision: meta.revision,
                version: meta.version.clone(),
                option: meta.option.clone(),
                transport: meta.transport,
                packages: meta.packages.clone(),
                definition_sha256,
                state_sha256: meta.state_sha256.clone(),
                installed_at: installed_at.clone(),
                extra: Map::new(),
            },
        );
    }
    match record::save(path, &record) {
        Ok(()) => {
            let mut agents = targets.to_vec();
            agents.sort();
            (
                RecordWrite::written(),
                Some(InstalledChanged {
                    item_ids: ids.into_iter().collect(),
                    agents,
                }),
            )
        }
        Err(error) => (
            RecordWrite::failed(codes::RECORD_WRITE_FAILED, error.to_string()),
            None,
        ),
    }
}

/// Install (or update) with what the user confirmed. See the module docs
/// for the order of the checks; every way back without writing is in the
/// answer, not an error.
pub(crate) async fn install(
    local: &Local,
    harness: &Harness,
    emitter: &EventEmitter,
    request: HarnessMcpInstallRequest,
) -> Result<HarnessMcpInstallResult, AppCommandError> {
    harness.ensure_enabled()?;
    let item_ref = ItemRef::parse(&request.item_ref)?;
    if request.revision == 0 {
        return Err(HarnessError::InvalidRef.into());
    }

    // The call itself, before anything is fetched.
    let key = request.key.clone();
    let mut targets: Vec<McpAppType> = Vec::new();
    for agent in &request.agents {
        if !targets.contains(agent) {
            targets.push(*agent);
        }
    }
    let replace: BTreeSet<McpAppType> = request.replace.iter().copied().collect();
    let mut issues = Vec::new();
    if key == RESERVED_KEY {
        issues.push(Reason::new(codes::KEY_RESERVED).param("key", key.clone()));
    } else if !is_valid_new_key(&key) {
        issues.push(Reason::new(codes::KEY_INVALID).param("key", key.clone()));
    }
    if targets.is_empty() {
        issues.push(Reason::new(codes::NO_TARGETS));
    }
    for agent in &replace {
        if !targets.contains(agent) {
            issues.push(
                Reason::new(codes::REPLACE_NOT_TARGET).param("agent", record::name_of(*agent)),
            );
        }
    }
    for agent in &targets {
        if !request.basis.contains_key(agent) {
            issues.push(Reason::new(codes::BASIS_REQUIRED).param("agent", record::name_of(*agent)));
        }
    }
    if !issues.is_empty() {
        return Ok(HarnessMcpInstallResult::refused(issues, None));
    }
    let record = match record::load_for_write(&local.record_path) {
        Ok(record) => record,
        Err(error) => return Ok(HarnessMcpInstallResult::refused(vec![error.reason()], None)),
    };

    // What never changes about the revision: its server.json.
    let info = harness.install_info(&item_ref, request.revision).await?;
    if info.item.kind != Kind::Mcp {
        return Ok(HarnessMcpInstallResult::refused(
            vec![Reason::new(codes::NOT_AN_MCP_SERVER)
                .param("kind", snapshot::wire(&info.item.kind))],
            None,
        ));
    }
    if let Some(item) = record.items.get(&info.item.id) {
        if item.key != key && !item.agents.is_empty() {
            return Ok(HarnessMcpInstallResult::refused(
                vec![Reason::new(codes::INSTALLED_UNDER_OTHER_KEY).param("key", item.key.clone())],
                None,
            ));
        }
    }
    let Some(server) = info.server.as_ref() else {
        return Ok(HarnessMcpInstallResult::refused(
            vec![Reason::new(codes::NOTHING_TO_INSTALL)],
            None,
        ));
    };
    let info_pins: Vec<Pin> = info.packages.iter().flatten().map(Pin::from_info).collect();
    let options = match convert::analyze(server, &info_pins) {
        Ok(options) => options,
        Err(reason) => return Ok(HarnessMcpInstallResult::refused(vec![reason], None)),
    };
    let Some(option) = options.iter().find(|option| option.id == request.option_id) else {
        return Ok(HarnessMcpInstallResult::refused(
            vec![Reason::new(codes::OPTION_NOT_FOUND).param("option", request.option_id.clone())],
            None,
        ));
    };
    if !option.blocking.is_empty() {
        return Ok(HarnessMcpInstallResult::refused(
            option.blocking.clone(),
            None,
        ));
    }
    let draft = match convert::build(server, &info_pins, option, &request.values, false) {
        Ok(definition) => definition,
        Err(reasons) => return Ok(HarnessMcpInstallResult::refused(reasons, None)),
    };

    // 1. The engine's preflight, with the basis the dialog showed.
    let basis: BTreeMap<McpAppType, String> = targets
        .iter()
        .map(|agent| (*agent, request.basis[agent].clone()))
        .collect();
    let preflight = mcp_engine::apply_in(
        &local.engine,
        &McpApplyRequest {
            basis,
            ops: set_ops(&targets, &key, &draft),
            preflight: true,
        },
    )
    .await;
    if preflight.outcome == McpApplyOutcome::ChangedElsewhere {
        return Ok(HarnessMcpInstallResult {
            apply: Some(preflight),
            ..HarnessMcpInstallResult::new(InstallOutcome::ChangedElsewhere)
        });
    }
    if !preflight.ok {
        return Ok(HarnessMcpInstallResult {
            apply: Some(preflight),
            ..HarnessMcpInstallResult::new(InstallOutcome::Invalid)
        });
    }
    // A name already taken in a target is overwritten only when the call
    // says so.
    let issues: Vec<Reason> = preflight
        .agents
        .iter()
        .filter(|agent| !replace.contains(&agent.agent))
        .filter(|agent| {
            agent
                .ops
                .iter()
                .any(|op| matches!(op.effect, McpOpEffect::Updated | McpOpEffect::Unchanged))
        })
        .map(|agent| {
            Reason::new(codes::REPLACE_REQUIRED)
                .param("agent", record::name_of(agent.agent))
                .param("key", key.clone())
        })
        .collect();
    if !issues.is_empty() {
        return Ok(HarnessMcpInstallResult::refused(issues, Some(preflight)));
    }

    // 2. The snapshot again, as close to the commit as it gets.
    let fresh = resolve_one(harness, &info.item.id, request.revision).await?;
    let pins = pins_of(fresh.installed.as_ref());
    let mut abort = snapshot::item_blocking(&fresh, request.revision);
    let permissions = fresh
        .installed
        .as_ref()
        .and_then(|state| state.permissions.as_ref());
    if abort.is_empty() {
        abort.extend(convert::package_reasons(option, &pins, permissions).0);
    }
    let state = match (abort.is_empty(), fresh.installed) {
        (true, Some(state)) => state,
        (_, state) => {
            if abort.is_empty() {
                abort.push(
                    Reason::new(codes::REVISION_UNAVAILABLE)
                        .param("revision", request.revision.to_string()),
                );
            }
            return Ok(HarnessMcpInstallResult {
                issues: abort,
                state_sha256: state.as_ref().and_then(|state| state.state_sha256.clone()),
                snapshot: state,
                apply: Some(preflight),
                ..HarnessMcpInstallResult::new(InstallOutcome::Aborted)
            });
        }
    };
    let fresh_sha = state.state_sha256.clone().unwrap_or_default();
    if fresh_sha != request.state_sha256 {
        snapshot::remember(&state);
        let confirmed = snapshot::recall(&request.state_sha256);
        return Ok(HarnessMcpInstallResult {
            changes: snapshot::changes(confirmed.as_ref(), &state),
            snapshot: Some(state),
            state_sha256: Some(fresh_sha),
            apply: Some(preflight),
            ..HarnessMcpInstallResult::new(InstallOutcome::StateChanged)
        });
    }
    if state.status == VersionStatus::Yanked && !request.accept_yanked {
        return Ok(HarnessMcpInstallResult::refused(
            vec![Reason::new(codes::YANKED_NOT_ACCEPTED)],
            Some(preflight),
        ));
    }

    // 3. The commit: the definition as the snapshot pins it, with the
    //    preflight's basis; the record before the lock is let go.
    let definition = match convert::build(server, &pins, option, &request.values, true) {
        Ok(definition) => definition,
        Err(reasons) => {
            return Ok(HarnessMcpInstallResult {
                issues: reasons,
                snapshot: Some(state),
                state_sha256: Some(fresh_sha),
                apply: Some(preflight),
                ..HarnessMcpInstallResult::new(InstallOutcome::Aborted)
            })
        }
    };
    let packages = option
        .package
        .as_ref()
        .and_then(|package| convert::find_pin(&pins, &package.registry_type, &package.identifier))
        .and_then(|pin| {
            Some(PinnedPackageRef {
                registry_type: pin.registry_type.clone(),
                identifier: pin.identifier.clone(),
                version: pin.version.clone()?,
            })
        })
        .into_iter()
        .collect();
    let meta = InstallMeta {
        id: info.item.id.clone(),
        item_ref: info.item.r#ref.clone(),
        title: info.item.title.clone(),
        key: key.clone(),
        revision: request.revision,
        version: info.version.version.clone(),
        option: option.id.clone(),
        transport: option.transport,
        packages,
        state_sha256: fresh_sha.clone(),
        intended: definition.fingerprint(),
    };
    let commit = McpApplyRequest {
        basis: basis_of(&preflight),
        ops: set_ops(&targets, &key, &definition),
        preflight: false,
    };
    let engine = &local.engine;
    let record_path = local.record_path.as_path();
    // The record is checked again once the lock is held, before anything is
    // written: another Codeg may have installed this item under another name
    // since it was read above.
    let guarded = mcp_engine::apply_in_guarded(
        engine,
        &commit,
        || record_still_allows(record_path, &meta),
        |result| record_install(engine, record_path, &meta, &targets, result),
    )
    .await;
    let (result, written) = match guarded {
        Ok(done) => done,
        Err(reason) => {
            return Ok(HarnessMcpInstallResult::refused(
                vec![reason],
                Some(preflight),
            ))
        }
    };
    mcp_engine::announce_changed(emitter, &changed_agents(&result));
    let (record_write, changed) = match written {
        Some((write, changed)) => (Some(write), changed),
        None => (None, None),
    };
    if let Some(changed) = changed {
        emit_event(emitter, INSTALLED_CHANGED_EVENT, changed);
        crate::harness::updates::records_changed();
    }
    let outcome = match result.outcome {
        McpApplyOutcome::Applied => InstallOutcome::Installed,
        McpApplyOutcome::ChangedElsewhere => InstallOutcome::ChangedElsewhere,
        McpApplyOutcome::Busy => InstallOutcome::Busy,
        McpApplyOutcome::WriteFailed => InstallOutcome::WriteFailed,
        McpApplyOutcome::Invalid | McpApplyOutcome::Preflight => InstallOutcome::Invalid,
    };
    Ok(HarnessMcpInstallResult {
        apply: Some(result),
        record: record_write,
        ..HarnessMcpInstallResult::new(outcome)
    })
}

// ─── harness_installed ──────────────────────────────────────────────────

/// Every installed Harness MCP item, with how it stands in each agent.
///
/// The scan behind it forgets an agent whose entry is gone (and an item
/// left with none) — under the MCP write lock, re-read there; when the lock
/// cannot be had in time, the next listing does it. Such an agent is listed
/// once, as `missing`, by the listing that forgets it. An agent whose config
/// cannot be read is kept, as `unknown`.
pub(crate) async fn installed(
    local: &Local,
    emitter: &EventEmitter,
) -> Result<HarnessInstalled, AppCommandError> {
    let record = record::load(&local.record_path).map_err(|error| record_error(&error))?;
    let engine = local.engine.clone();
    let agents = record::recorded_agents(&record);
    let reads = off_thread(move || record::read_agents(&engine, agents)).await?;
    let items = record::listing(&record, &reads);
    let gone = items.iter().any(|item| {
        item.agents
            .iter()
            .any(|agent| agent.state == LocalState::Missing)
    });
    if gone {
        if let Some(changed) = forget_missing(local).await {
            emit_event(emitter, INSTALLED_CHANGED_EVENT, changed);
            crate::harness::updates::records_changed();
        }
    }
    // The skills beside them are listed by `harness::skills`
    // (`commands::harness_mcp::harness_installed_core`).
    Ok(HarnessInstalled {
        mcp: items,
        skills: Vec::new(),
        mcp_problem: None,
        skills_problem: None,
    })
}

/// The scan's write: under the lock, from a fresh read of both sides.
async fn forget_missing(local: &Local) -> Option<InstalledChanged> {
    let _guard = lock::acquire_at(&local.engine.lock_path, local.engine.lock_wait)
        .await
        .ok()?;
    let engine = local.engine.clone();
    let path = local.record_path.clone();
    off_thread(move || {
        let mut record = record::load_for_write(&path).ok()?;
        let reads = record::read_agents(&engine, record::recorded_agents(&record));
        let (ids, agents) = record::drop_missing(&mut record, &reads);
        if ids.is_empty() {
            return None;
        }
        record::save(&path, &record).ok()?;
        Some(InstalledChanged {
            item_ids: ids.into_iter().collect(),
            agents: agents.into_iter().collect(),
        })
    })
    .await
    .ok()
    .flatten()
}

// ─── harness_mcp_uninstall ──────────────────────────────────────────────

impl HarnessMcpUninstallResult {
    fn new(outcome: UninstallOutcome) -> Self {
        Self {
            outcome,
            issues: Vec::new(),
            agents: Vec::new(),
            apply: None,
            record: None,
        }
    }
}

/// The record step of an uninstall, run while the MCP write lock is held:
/// the agents removed from, and those found gone (still gone now).
fn record_uninstall(
    engine: &EngineCtx,
    path: &Path,
    item_id: &str,
    key: &str,
    removed: &BTreeSet<McpAppType>,
    forgotten: &BTreeSet<McpAppType>,
    result: &McpApplyResult,
) -> (RecordWrite, Option<InstalledChanged>) {
    if result.outcome != McpApplyOutcome::Applied {
        return (RecordWrite::unchanged(), None);
    }
    let mut record = match record::load_for_write(path) {
        Ok(record) => record,
        Err(error) => {
            return (
                RecordWrite::failed(codes::RECORD_UNREADABLE, error.detail()),
                None,
            )
        }
    };
    let reads = record::read_agents(engine, forgotten.iter().copied());
    let Some(item) = record.items.get_mut(item_id).filter(|item| item.key == key) else {
        return (RecordWrite::unchanged(), None);
    };
    let mut dropped = BTreeSet::new();
    item.agents.retain(|name, recorded| {
        let Some(agent) = record::agent_named(name) else {
            return true;
        };
        let drop = removed.contains(&agent)
            || (forgotten.contains(&agent)
                && record::state_in(reads.get(&agent), key, &recorded.definition_sha256)
                    == LocalState::Missing);
        if drop {
            dropped.insert(agent);
        }
        !drop
    });
    if dropped.is_empty() {
        return (RecordWrite::unchanged(), None);
    }
    if item.agents.is_empty() {
        record.items.remove(item_id);
    }
    match record::save(path, &record) {
        Ok(()) => (
            RecordWrite::written(),
            Some(InstalledChanged {
                item_ids: vec![item_id.to_string()],
                agents: dropped.into_iter().collect(),
            }),
        ),
        Err(error) => (
            RecordWrite::failed(codes::RECORD_WRITE_FAILED, error.to_string()),
            None,
        ),
    }
}

/// Remove an installed item's server from the agents it was installed to,
/// and forget it. Run first with `preflight` (what would happen, and the
/// basis to send back), then for real with that basis. An entry changed
/// since it was installed is removed only from the agents in
/// `remove_changed`.
pub(crate) async fn uninstall(
    local: &Local,
    emitter: &EventEmitter,
    request: HarnessMcpUninstallRequest,
) -> Result<HarnessMcpUninstallResult, AppCommandError> {
    let refused = |issues: Vec<Reason>| HarnessMcpUninstallResult {
        issues,
        ..HarnessMcpUninstallResult::new(UninstallOutcome::Refused)
    };
    let record = match record::load_for_write(&local.record_path) {
        Ok(record) => record,
        Err(error) => return Ok(refused(vec![error.reason()])),
    };
    let Some(item) = record.items.get(&request.item_id) else {
        return Ok(refused(vec![
            Reason::new(codes::NOT_INSTALLED).param("item_id", request.item_id.clone())
        ]));
    };
    let key = item.key.clone();
    let recorded: Vec<(McpAppType, RecordAgent)> = item
        .known_agents()
        .into_iter()
        .map(|(agent, recorded)| (agent, recorded.clone()))
        .collect();
    let requested: BTreeSet<McpAppType> = match &request.agents {
        Some(agents) => agents.iter().copied().collect(),
        None => recorded.iter().map(|(agent, _)| *agent).collect(),
    };
    let changed_ok: BTreeSet<McpAppType> = request.remove_changed.iter().copied().collect();
    let engine = local.engine.clone();
    let to_read: Vec<McpAppType> = recorded.iter().map(|(agent, _)| *agent).collect();
    let reads = off_thread(move || record::read_agents(&engine, to_read)).await?;

    let agents: Vec<UninstallAgent> = recorded
        .iter()
        .map(|(agent, recorded)| {
            let state = record::state_in(reads.get(agent), &key, &recorded.definition_sha256);
            let action = if !requested.contains(agent) {
                UninstallAction::NotRequested
            } else {
                match state {
                    LocalState::AsInstalled => UninstallAction::Remove,
                    LocalState::ChangedLocally if changed_ok.contains(agent) => {
                        UninstallAction::Remove
                    }
                    LocalState::ChangedLocally => UninstallAction::KeepChanged,
                    LocalState::Missing => UninstallAction::Forget,
                    LocalState::Unknown => UninstallAction::KeepUnknown,
                }
            };
            UninstallAgent {
                agent: *agent,
                key: key.clone(),
                state,
                action,
            }
        })
        .collect();
    let with = |action: UninstallAction| -> BTreeSet<McpAppType> {
        agents
            .iter()
            .filter(|agent| agent.action == action)
            .map(|agent| agent.agent)
            .collect()
    };
    let removing = with(UninstallAction::Remove);
    let forgetting = with(UninstallAction::Forget);
    let ops: Vec<McpOp> = removing
        .iter()
        .map(|agent| McpOp {
            agent: *agent,
            key: key.clone(),
            action: McpOpAction::Remove,
        })
        .collect();
    let given: BTreeMap<McpAppType, String> = request
        .basis
        .iter()
        .filter(|(agent, _)| removing.contains(agent))
        .map(|(agent, basis)| (*agent, basis.clone()))
        .collect();

    if !request.preflight {
        let missing: Vec<Reason> = removing
            .iter()
            .filter(|agent| !given.contains_key(agent))
            .map(|agent| Reason::new(codes::BASIS_REQUIRED).param("agent", record::name_of(*agent)))
            .collect();
        if !missing.is_empty() {
            return Ok(HarnessMcpUninstallResult {
                agents,
                ..refused(missing)
            });
        }
    }
    let preflight = mcp_engine::apply_in(
        &local.engine,
        &McpApplyRequest {
            basis: given,
            ops: ops.clone(),
            preflight: true,
        },
    )
    .await;
    let early = if preflight.outcome == McpApplyOutcome::ChangedElsewhere {
        Some(UninstallOutcome::ChangedElsewhere)
    } else if !preflight.ok {
        Some(UninstallOutcome::Invalid)
    } else if request.preflight {
        Some(UninstallOutcome::Preflight)
    } else {
        None
    };
    if let Some(outcome) = early {
        return Ok(HarnessMcpUninstallResult {
            agents,
            apply: Some(preflight),
            ..HarnessMcpUninstallResult::new(outcome)
        });
    }

    let commit = McpApplyRequest {
        basis: basis_of(&preflight),
        ops,
        preflight: false,
    };
    let engine = &local.engine;
    let record_path = local.record_path.as_path();
    let item_id = request.item_id.as_str();
    let (result, written) = mcp_engine::apply_in_then(engine, &commit, |result| {
        record_uninstall(
            engine,
            record_path,
            item_id,
            &key,
            &removing,
            &forgetting,
            result,
        )
    })
    .await;
    mcp_engine::announce_changed(emitter, &changed_agents(&result));
    let (record_write, changed) = match written {
        Some((write, changed)) => (Some(write), changed),
        None => (None, None),
    };
    if let Some(changed) = changed {
        emit_event(emitter, INSTALLED_CHANGED_EVENT, changed);
        crate::harness::updates::records_changed();
    }
    let outcome = match result.outcome {
        McpApplyOutcome::Applied => UninstallOutcome::Uninstalled,
        McpApplyOutcome::ChangedElsewhere => UninstallOutcome::ChangedElsewhere,
        McpApplyOutcome::Busy => UninstallOutcome::Busy,
        McpApplyOutcome::WriteFailed => UninstallOutcome::WriteFailed,
        McpApplyOutcome::Invalid | McpApplyOutcome::Preflight => UninstallOutcome::Invalid,
    };
    Ok(HarnessMcpUninstallResult {
        agents,
        apply: Some(result),
        record: record_write,
        ..HarnessMcpUninstallResult::new(outcome)
    })
}
