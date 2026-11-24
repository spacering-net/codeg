//! The provenance record: `~/.codeg/harness/mcp.json`, what Codeg installed
//! from Harness into which agent's MCP configuration.
//!
//! It lives under the **real** user home, beside the MCP write lock and the
//! pre-write copies (`commands::mcp_engine::agents::real_codeg_dir`): the
//! agents' config files are per user, shared by the desktop app and any
//! codeg-server of that user, and so is what was written into them. Like
//! those files it is not part of Codeg's backup.
//!
//! It is written whole (a temp file beside it, synced, renamed over it, mode
//! 0600) and only while the MCP write lock is held, so that it moves in step
//! with the config files it describes: an install writes it in the step
//! `mcp_engine::apply_in_then` runs before letting the lock go.
//!
//! ```json
//! { "format": 1,
//!   "items": {
//!     "<item id>": {
//!       "ref": "publisher/name", "key": "notes",
//!       "agents": {
//!         "claude_code": {
//!           "revision": 3, "version": "1.2.0",
//!           "option": "official:package:0:stdio", "transport": "stdio",
//!           "packages": [{ "registry_type": "npm", "identifier": "@x/notes", "version": "1.2.3" }],
//!           "definition_sha256": "…", "state_sha256": "…",
//!           "installed_at": "2026-11-16T09:30:00.000Z" } } } } }
//! ```
//!
//! An item has one key; each agent carries its own revision, so an update
//! that leaves an agent out leaves that agent at the revision it has. What
//! the daily update check (H6) asks `/resolve` about is each distinct
//! `(item id, revision)`, and `state_sha256` is the fingerprint the user
//! agreed to, to tell a version's state changing under an installed copy.
//! Fields a newer Codeg adds are kept when an older one rewrites the file.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::commands::mcp::McpAppType;
use crate::commands::mcp_engine::agents::EngineCtx;
use crate::commands::mcp_engine::fsio;
use crate::commands::mcp_engine::inventory::read_agent;
use crate::commands::mcp_engine::model::{McpEntry, McpFileStatus, McpTransport};

use super::model::{codes, InstalledAgent, InstalledItem, LocalState, PinnedPackageRef, Reason};
use crate::harness::types::Localized;

/// The format this Codeg reads and writes.
pub(crate) const FORMAT: u32 = 1;

/// `~/.codeg/harness/mcp.json`. Unit tests get a file of their own under the
/// system temp dir: nothing in a test may touch the real home.
pub(crate) fn default_record_path() -> PathBuf {
    #[cfg(test)]
    {
        std::env::temp_dir()
            .join(format!("codeg-test-harness-{}", std::process::id()))
            .join("mcp.json")
    }
    #[cfg(not(test))]
    {
        crate::commands::mcp_engine::agents::real_codeg_dir()
            .join("harness")
            .join("mcp.json")
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub(crate) struct Record {
    #[serde(default)]
    pub format: u32,
    /// By item id.
    #[serde(default)]
    pub items: BTreeMap<String, RecordItem>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

impl Default for Record {
    fn default() -> Self {
        Self {
            format: FORMAT,
            items: BTreeMap::new(),
            extra: Map::new(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub(crate) struct RecordItem {
    #[serde(rename = "ref")]
    pub item_ref: String,
    pub key: String,
    /// As the catalog gave it at the last install or update. Absent from a
    /// record written before titles were kept.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<Localized>,
    /// By agent, as the agent is named on the wire. A name this Codeg does
    /// not know (a newer one wrote it) is kept and left alone.
    #[serde(default)]
    pub agents: BTreeMap<String, RecordAgent>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub(crate) struct RecordAgent {
    pub revision: u64,
    pub version: Option<String>,
    pub option: String,
    pub transport: McpTransport,
    #[serde(default)]
    pub packages: Vec<PinnedPackageRef>,
    /// The engine's fingerprint of the definition as it was read back from
    /// the agent's config right after the write.
    pub definition_sha256: String,
    pub state_sha256: String,
    pub installed_at: String,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

impl RecordItem {
    /// Its agents this Codeg knows, in the engine's order.
    pub fn known_agents(&self) -> Vec<(McpAppType, &RecordAgent)> {
        let mut known: Vec<(McpAppType, &RecordAgent)> = self
            .agents
            .iter()
            .filter_map(|(name, agent)| Some((agent_named(name)?, agent)))
            .collect();
        known.sort_by_key(|(app, _)| *app);
        known
    }
}

pub(crate) fn agent_named(name: &str) -> Option<McpAppType> {
    serde_json::from_value(Value::String(name.to_string())).ok()
}

pub(crate) fn name_of(agent: McpAppType) -> String {
    serde_json::to_value(agent)
        .ok()
        .and_then(|value| value.as_str().map(str::to_string))
        .unwrap_or_default()
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum RecordError {
    /// It is there and cannot be read as a record.
    Unreadable(String),
    /// A newer Codeg wrote it in a format this one does not know.
    Newer(u32),
}

impl RecordError {
    pub fn detail(&self) -> String {
        match self {
            RecordError::Unreadable(why) => why.clone(),
            RecordError::Newer(format) => {
                format!("written by a newer Codeg (format {format})")
            }
        }
    }

    pub fn reason(&self) -> Reason {
        Reason::new(codes::RECORD_UNREADABLE).detail(self.detail())
    }
}

/// The record; an empty one when there is none yet.
pub(crate) fn load(path: &Path) -> Result<Record, RecordError> {
    match fsio::read_bytes(path) {
        Ok(None) => Ok(Record::default()),
        Ok(Some(bytes)) => serde_json::from_slice(&bytes)
            .map_err(|error| RecordError::Unreadable(format!("{}: {error}", path.display()))),
        Err(error) => Err(RecordError::Unreadable(format!(
            "{}: {error}",
            path.display()
        ))),
    }
}

/// [`load`], for a caller that will write it back: a format this Codeg does
/// not know is not rewritten.
pub(crate) fn load_for_write(path: &Path) -> Result<Record, RecordError> {
    let record = load(path)?;
    if record.format > FORMAT {
        return Err(RecordError::Newer(record.format));
    }
    Ok(record)
}

/// Write the record whole. The caller holds the MCP write lock.
pub(crate) fn save(path: &Path, record: &Record) -> std::io::Result<()> {
    #[cfg(test)]
    hooks::before_save(path);
    let mut record = record.clone();
    record.format = FORMAT;
    let mut bytes = serde_json::to_vec_pretty(&record).map_err(std::io::Error::other)?;
    bytes.push(b'\n');
    fsio::write_atomic(path, &bytes)
}

// ─── The scan ───────────────────────────────────────────────────────────

/// One agent's servers as its config says now, or that it cannot be read.
#[derive(Debug, Clone)]
pub(crate) enum AgentRead {
    Entries(Vec<McpEntry>),
    Unreadable,
}

/// Read `agents`' configs. Blocking file I/O: run it off the async workers.
pub(crate) fn read_agents(
    engine: &EngineCtx,
    agents: impl IntoIterator<Item = McpAppType>,
) -> BTreeMap<McpAppType, AgentRead> {
    agents
        .into_iter()
        .map(|agent| {
            let read = match engine.paths_of(agent) {
                None => AgentRead::Unreadable,
                Some(paths) => {
                    let (config, entries) = read_agent(agent, paths);
                    if config.status == McpFileStatus::Unreadable {
                        AgentRead::Unreadable
                    } else {
                        AgentRead::Entries(entries)
                    }
                }
            };
            (agent, read)
        })
        .collect()
}

/// Every agent any item of `record` names.
pub(crate) fn recorded_agents(record: &Record) -> BTreeSet<McpAppType> {
    record
        .items
        .values()
        .flat_map(|item| item.known_agents().into_iter().map(|(agent, _)| agent))
        .collect()
}

/// The entry under `key` in what was read, if any.
pub(crate) fn entry_in<'a>(read: &'a AgentRead, key: &str) -> Option<&'a McpEntry> {
    match read {
        AgentRead::Entries(entries) => entries.iter().find(|entry| entry.key == key),
        AgentRead::Unreadable => None,
    }
}

/// How the install of `definition_sha256` under `key` stands in what was
/// read of one agent.
pub(crate) fn state_in(read: Option<&AgentRead>, key: &str, definition_sha256: &str) -> LocalState {
    match read {
        None | Some(AgentRead::Unreadable) => LocalState::Unknown,
        Some(read) => match entry_in(read, key) {
            None => LocalState::Missing,
            Some(entry) if entry.fingerprint.as_deref() == Some(definition_sha256) => {
                LocalState::AsInstalled
            }
            Some(_) => LocalState::ChangedLocally,
        },
    }
}

fn installed_agent(agent: McpAppType, record: &RecordAgent, state: LocalState) -> InstalledAgent {
    InstalledAgent {
        agent,
        state,
        revision: record.revision,
        version: record.version.clone(),
        option: record.option.clone(),
        transport: record.transport,
        packages: record.packages.clone(),
        state_sha256: record.state_sha256.clone(),
        installed_at: record.installed_at.clone(),
    }
}

/// One recorded item as the listing shows it.
pub(crate) fn listed_item(
    id: &str,
    item: &RecordItem,
    reads: &BTreeMap<McpAppType, AgentRead>,
) -> Option<InstalledItem> {
    let agents: Vec<InstalledAgent> = item
        .known_agents()
        .into_iter()
        .map(|(agent, recorded)| {
            let state = state_in(reads.get(&agent), &item.key, &recorded.definition_sha256);
            installed_agent(agent, recorded, state)
        })
        .collect();
    if agents.is_empty() {
        return None;
    }
    let any = |state: LocalState| agents.iter().any(|agent| agent.state == state);
    let state = if any(LocalState::ChangedLocally) {
        LocalState::ChangedLocally
    } else if any(LocalState::AsInstalled) {
        LocalState::AsInstalled
    } else if any(LocalState::Unknown) {
        LocalState::Unknown
    } else {
        LocalState::Missing
    };
    // The revision an update starts from: the lowest one still there.
    let present: Vec<&InstalledAgent> = agents
        .iter()
        .filter(|agent| agent.state != LocalState::Missing)
        .collect();
    let lowest = if present.is_empty() {
        agents.iter().min_by_key(|agent| agent.revision)
    } else {
        present.into_iter().min_by_key(|agent| agent.revision)
    }?;
    Some(InstalledItem {
        id: id.to_string(),
        item_ref: item.item_ref.clone(),
        title: item.title.clone(),
        key: item.key.clone(),
        revision: lowest.revision,
        version: lowest.version.clone(),
        state,
        agents,
    })
}

/// Every recorded item, as the listing shows it.
pub(crate) fn listing(
    record: &Record,
    reads: &BTreeMap<McpAppType, AgentRead>,
) -> Vec<InstalledItem> {
    record
        .items
        .iter()
        .filter_map(|(id, item)| listed_item(id, item, reads))
        .collect()
}

/// Forget every agent whose entry is gone, and every item left with none.
/// An agent whose config cannot be read is kept: unread is not removed.
/// Returns the items and agents it changed.
pub(crate) fn drop_missing(
    record: &mut Record,
    reads: &BTreeMap<McpAppType, AgentRead>,
) -> (BTreeSet<String>, BTreeSet<McpAppType>) {
    let mut ids = BTreeSet::new();
    let mut agents = BTreeSet::new();
    for (id, item) in record.items.iter_mut() {
        let key = item.key.clone();
        item.agents.retain(|name, recorded| {
            let Some(agent) = agent_named(name) else {
                return true;
            };
            let gone = state_in(reads.get(&agent), &key, &recorded.definition_sha256)
                == LocalState::Missing;
            if gone {
                ids.insert(id.clone());
                agents.insert(agent);
            }
            !gone
        });
    }
    record.items.retain(|_, item| !item.agents.is_empty());
    (ids, agents)
}

#[cfg(test)]
pub(crate) mod hooks {
    //! A step a test runs right before the record is written, on the thread
    //! that writes it.
    use std::cell::RefCell;
    use std::path::Path;

    type BeforeSave = Box<dyn Fn(&Path)>;

    thread_local! {
        static BEFORE_SAVE: RefCell<Option<BeforeSave>> = const { RefCell::new(None) };
    }

    pub(crate) fn set_before_save(run: Option<BeforeSave>) {
        BEFORE_SAVE.with(|slot| *slot.borrow_mut() = run);
    }

    pub(super) fn before_save(path: &Path) {
        BEFORE_SAVE.with(|slot| {
            if let Some(run) = slot.borrow().as_ref() {
                run(path);
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::mcp_engine::model::McpDefinition;
    use serde_json::json;

    fn entry(key: &str, command: &str) -> McpEntry {
        let definition = McpDefinition::Stdio {
            command: command.into(),
            args: vec![],
            env: BTreeMap::new(),
        };
        McpEntry {
            key: key.into(),
            fingerprint: Some(definition.fingerprint()),
            definition: Some(definition),
            extra: Map::new(),
            enabled: true,
            read_only: false,
            reserved: false,
            legacy: false,
            problems: vec![],
        }
    }

    fn sha(command: &str) -> String {
        entry("x", command).fingerprint.unwrap()
    }

    fn agent(revision: u64, command: &str) -> RecordAgent {
        RecordAgent {
            revision,
            version: Some(format!("1.{revision}.0")),
            option: "official:package:0:stdio".into(),
            transport: McpTransport::Stdio,
            packages: vec![],
            definition_sha256: sha(command),
            state_sha256: "s".into(),
            installed_at: "2026-11-16T00:00:00.000Z".into(),
            extra: Map::new(),
        }
    }

    fn record() -> Record {
        let mut record = Record::default();
        record.items.insert(
            "id-1".into(),
            RecordItem {
                item_ref: "acme/notes".into(),
                key: "notes".into(),
                title: None,
                agents: BTreeMap::from([
                    ("claude_code".into(), agent(3, "npx")),
                    ("codex".into(), agent(2, "npx")),
                    ("gemini".into(), agent(3, "npx")),
                    ("cline".into(), agent(3, "npx")),
                ]),
                extra: Map::new(),
            },
        );
        record
    }

    #[test]
    fn the_scan_tells_each_state_and_drops_only_what_is_gone() {
        let reads = BTreeMap::from([
            (
                McpAppType::ClaudeCode,
                AgentRead::Entries(vec![entry("notes", "npx")]),
            ),
            (
                McpAppType::Codex,
                AgentRead::Entries(vec![entry("notes", "node")]),
            ),
            (
                McpAppType::Gemini,
                AgentRead::Entries(vec![entry("other", "npx")]),
            ),
            (McpAppType::Cline, AgentRead::Unreadable),
        ]);
        let items = listing(&record(), &reads);
        assert_eq!(items.len(), 1);
        let states: Vec<(McpAppType, LocalState)> = items[0]
            .agents
            .iter()
            .map(|agent| (agent.agent, agent.state))
            .collect();
        assert_eq!(
            states,
            [
                (McpAppType::ClaudeCode, LocalState::AsInstalled),
                (McpAppType::Codex, LocalState::ChangedLocally),
                (McpAppType::Gemini, LocalState::Missing),
                (McpAppType::Cline, LocalState::Unknown),
            ]
        );
        assert_eq!(items[0].state, LocalState::ChangedLocally);
        assert_eq!(items[0].revision, 2);
        assert_eq!(items[0].version.as_deref(), Some("1.2.0"));

        let mut kept = record();
        let (ids, agents) = drop_missing(&mut kept, &reads);
        assert_eq!(ids, BTreeSet::from(["id-1".to_string()]));
        assert_eq!(agents, BTreeSet::from([McpAppType::Gemini]));
        let left: Vec<&String> = kept.items["id-1"].agents.keys().collect();
        assert_eq!(left, ["claude_code", "cline", "codex"]);

        // nothing left: the item goes
        let none = BTreeMap::from([
            (McpAppType::ClaudeCode, AgentRead::Entries(vec![])),
            (McpAppType::Codex, AgentRead::Entries(vec![])),
            (McpAppType::Gemini, AgentRead::Entries(vec![])),
            (McpAppType::Cline, AgentRead::Entries(vec![])),
        ]);
        let mut emptied = record();
        drop_missing(&mut emptied, &none);
        assert!(emptied.items.is_empty());
    }

    #[test]
    fn the_file_is_written_whole_privately_and_keeps_what_it_does_not_know() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("harness").join("mcp.json");
        assert_eq!(load(&path).unwrap(), Record::default());
        // made by Codeg: its owner's alone, directory included
        save(&path, &record()).unwrap();
        assert_eq!(load(&path).unwrap(), record());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = |path: &Path| std::fs::metadata(path).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode(&path), 0o600);
            assert_eq!(mode(path.parent().unwrap()), 0o700);
        }

        let mut written = serde_json::to_value(record()).unwrap();
        written["later"] = json!({ "x": 1 });
        written["items"]["id-1"]["pinnedBy"] = json!("h6");
        written["items"]["id-1"]["agents"]["claude_code"]["lastChecked"] = json!("t");
        written["items"]["id-1"]["agents"]["future_agent"] =
            serde_json::to_value(agent(1, "x")).unwrap();
        std::fs::write(&path, serde_json::to_vec(&written).unwrap()).unwrap();

        let read = load_for_write(&path).unwrap();
        assert_eq!(
            read.items["id-1"].known_agents().len(),
            4,
            "the unknown agent is not one of them"
        );
        save(&path, &read).unwrap();
        let again: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(again["later"], json!({ "x": 1 }));
        assert_eq!(again["items"]["id-1"]["pinnedBy"], "h6");
        assert_eq!(
            again["items"]["id-1"]["agents"]["claude_code"]["lastChecked"],
            "t"
        );
        assert!(again["items"]["id-1"]["agents"]
            .get("future_agent")
            .is_some());
        assert_eq!(again["format"], 1);
        let names: Vec<String> = std::fs::read_dir(path.parent().unwrap())
            .unwrap()
            .flatten()
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, ["mcp.json"], "no temp file is left behind");

        // a newer format is read, never rewritten
        written["format"] = json!(2);
        std::fs::write(&path, serde_json::to_vec(&written).unwrap()).unwrap();
        assert!(load(&path).is_ok());
        assert_eq!(load_for_write(&path), Err(RecordError::Newer(2)));
        std::fs::write(&path, "{ not json").unwrap();
        assert!(matches!(load(&path), Err(RecordError::Unreadable(_))));
    }

    /// A record written before titles were kept still reads, with none;
    /// one written with a title gives it back to the listing.
    #[test]
    fn a_title_is_kept_and_an_older_record_has_none() {
        let older = json!({ "format": 1, "items": { "id-1": {
            "ref": "acme/notes", "key": "notes",
            "agents": { "claude_code": serde_json::to_value(agent(3, "npx")).unwrap() } } } });
        let record: Record = serde_json::from_value(older).unwrap();
        assert_eq!(record.items["id-1"].title, None);
        let reads = BTreeMap::from([(
            McpAppType::ClaudeCode,
            AgentRead::Entries(vec![entry("notes", "npx")]),
        )]);
        assert_eq!(listing(&record, &reads)[0].title, None);
        // and it is not written as `null` either
        assert!(serde_json::to_value(&record).unwrap()["items"]["id-1"]
            .get("title")
            .is_none());

        let mut titled = record.clone();
        titled.items.get_mut("id-1").unwrap().title = Some(Localized {
            en: Some("Notes".into()),
            zh: Some("笔记".into()),
        });
        let written = serde_json::to_value(&titled).unwrap();
        assert_eq!(
            written["items"]["id-1"]["title"],
            json!({ "en": "Notes", "zh": "笔记" })
        );
        let read: Record = serde_json::from_value(written).unwrap();
        assert_eq!(
            listing(&read, &reads)[0]
                .title
                .as_ref()
                .unwrap()
                .en
                .as_deref(),
            Some("Notes")
        );
    }

    #[test]
    fn the_record_of_a_test_run_is_not_in_the_real_home() {
        assert!(default_record_path().starts_with(std::env::temp_dir()));
    }
}
