//! What the adapters of hosts with a marketplace share: Codeg's own
//! marketplace file in the plugin store, and the store's files as a host
//! sees them.
//!
//! The store is one local marketplace per host, named `codeg-harness`,
//! listing only the plugins installed natively for that host, each entry
//! pointing at its revision folder (`./<install name>/<revision>`). The
//! file is Codeg's: an entry it did not write, or one whose name is no
//! plain name, never reaches a command line or a path. Ownership goes by
//! the source alone — an entry whose source is a plugin's folder is that
//! plugin's — and a plugin has at most one entry.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

use crate::acp::registry::{self, AgentDistribution};
use crate::harness::mcp::model::Reason;
use crate::harness::skills::package::safe_path;
use crate::models::agent::AgentType;
use crate::skills::fsio::{remove_if_empty, write_private_atomic};

use super::super::ctx::{is_valid_install_name, InstallName};
use super::{codes, HostCli, HostCx, HostEnv, HostPlugin};

/// The marketplace's name, in every host and in every key a host writes.
pub const MARKETPLACE: &str = "codeg-harness";
const MARKETPLACE_FILE: &str = "marketplace.json";
/// A manifest larger than this is not read.
pub(crate) const MANIFEST_BYTES: u64 = 1024 * 1024;

/// Where a host wants the marketplace file, and how an entry names its
/// folder.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Layout {
    /// `<root>/.claude-plugin/marketplace.json`, `source: "./<name>/<rev>"`,
    /// with an `owner`.
    Claude,
    /// `<root>/.agents/plugins/marketplace.json`, `source: {source:
    /// "local", path: "./<name>/<rev>"}`.
    Codex,
}

impl Layout {
    /// The folders the file is in, from the store's root down.
    fn dirs(self) -> &'static [&'static str] {
        match self {
            Layout::Claude => &[".claude-plugin"],
            Layout::Codex => &[".agents", "plugins"],
        }
    }

    fn default_owner(self) -> Option<Value> {
        match self {
            Layout::Claude => Some(json!({ "name": "Codeg" })),
            Layout::Codex => None,
        }
    }

    /// The entry's source for `plugin`'s revision folder.
    pub(crate) fn source_of(self, plugin: &HostPlugin<'_>) -> Value {
        let path = relative_source(plugin);
        match self {
            Layout::Claude => Value::String(path),
            Layout::Codex => json!({ "source": "local", "path": path }),
        }
    }

    /// The folder an entry's source names, when it is a local one.
    pub(crate) fn source_path(self, source: &Value) -> Option<&str> {
        match self {
            Layout::Claude => source.as_str(),
            Layout::Codex => {
                (source.get("source")?.as_str()? == "local").then_some(())?;
                source.get("path")?.as_str()
            }
        }
    }
}

/// `./<install name>/<revision>`: where an entry points.
pub(crate) fn relative_source(plugin: &HostPlugin<'_>) -> String {
    format!("./{}/{}", plugin.name, plugin.revision)
}

/// `<name>@codeg-harness`.
pub(crate) fn plugin_key(name: &str) -> String {
    format!("{name}@{MARKETPLACE}")
}

/// A source for a person: the text, or the JSON.
pub(crate) fn source_text(source: &Value) -> String {
    match source {
        Value::String(text) => text.clone(),
        other => other.to_string(),
    }
}

pub(crate) fn same_name(a: &str, b: &InstallName) -> bool {
    a.eq_ignore_ascii_case(b.as_str())
}

/// Codeg's marketplace file for one host.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Marketplace {
    layout: Layout,
    file: MarketFile,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
struct MarketFile {
    name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    owner: Option<Value>,
    #[serde(default)]
    plugins: Vec<MarketEntry>,
    #[serde(flatten)]
    extra: Map<String, Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub(crate) struct MarketEntry {
    pub(crate) name: String,
    pub(crate) source: Value,
    #[serde(flatten)]
    extra: Map<String, Value>,
}

impl Marketplace {
    fn empty(layout: Layout) -> Self {
        Self {
            layout,
            file: MarketFile {
                name: MARKETPLACE.to_string(),
                owner: layout.default_owner(),
                plugins: Vec::new(),
                extra: Map::new(),
            },
        }
    }

    pub(crate) fn path(layout: Layout, root: &Path) -> PathBuf {
        Self::dir(layout, root).join(MARKETPLACE_FILE)
    }

    fn dir(layout: Layout, root: &Path) -> PathBuf {
        layout
            .dirs()
            .iter()
            .fold(root.to_path_buf(), |dir, name| dir.join(name))
    }

    /// The file as it is; an empty one when there is none.
    pub(crate) fn load(layout: Layout, root: &Path) -> Result<Self, Reason> {
        let path = Self::path(layout, root);
        let unreadable = |why: String| Reason::new(codes::MARKETPLACE_UNREADABLE).detail(why);
        if !Self::plain_dirs(layout, root)
            .map_err(|reason| unreadable(reason.detail.unwrap_or_default()))?
        {
            return Ok(Self::empty(layout));
        }
        match fs::symlink_metadata(&path) {
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                return Ok(Self::empty(layout))
            }
            Err(error) => return Err(unreadable(format!("{}: {error}", path.display()))),
            Ok(meta) if !meta.is_file() => {
                return Err(unreadable(format!(
                    "{} is not a plain file",
                    path.display()
                )))
            }
            Ok(_) => {}
        }
        let bytes =
            fs::read(&path).map_err(|error| unreadable(format!("{}: {error}", path.display())))?;
        let mut file: MarketFile = serde_json::from_slice(&bytes)
            .map_err(|error| unreadable(format!("{}: {error}", path.display())))?;
        if file.name != MARKETPLACE {
            return Err(unreadable(format!(
                "{} is the marketplace {:?}",
                path.display(),
                file.name
            )));
        }
        // A name goes into a command line and a cache path: only the kind
        // Codeg writes.
        if let Some(entry) = file
            .plugins
            .iter()
            .find(|entry| !is_valid_install_name(&entry.name))
        {
            return Err(unreadable(format!(
                "{} lists the plugin name {:?}",
                path.display(),
                entry.name
            )));
        }
        if file.owner.is_none() {
            file.owner = layout.default_owner();
        }
        Ok(Self { layout, file })
    }

    /// Write it whole, in one step. Its folders must be plain ones.
    pub(crate) fn save(&self, root: &Path) -> Result<(), Reason> {
        let mut dir = root.to_path_buf();
        for name in self.layout.dirs() {
            dir = dir.join(name);
            match fs::symlink_metadata(&dir) {
                Ok(meta) if meta.is_dir() => {}
                Ok(_) => return Err(files_error(&dir, "not a plain folder")),
                Err(error) if error.kind() == io::ErrorKind::NotFound => {
                    fs::create_dir_all(&dir).map_err(|error| files_error(&dir, error))?
                }
                Err(error) => return Err(files_error(&dir, error)),
            }
        }
        let path = Self::path(self.layout, root);
        if fs::symlink_metadata(&path).is_ok_and(|meta| !meta.is_file()) {
            return Err(files_error(&path, "not a plain file"));
        }
        let mut bytes =
            serde_json::to_vec_pretty(&self.file).map_err(|error| files_error(&path, error))?;
        bytes.push(b'\n');
        write_private_atomic(&path, &bytes).map_err(|error| files_error(&path, error))
    }

    /// Delete the file, and its folders when nothing else is in them.
    pub(crate) fn remove(layout: Layout, root: &Path) -> Result<(), Reason> {
        if !Self::plain_dirs(layout, root)? {
            return Ok(());
        }
        let path = Self::path(layout, root);
        match fs::symlink_metadata(&path) {
            Ok(meta) if !meta.is_file() => return Err(files_error(&path, "not a plain file")),
            _ => {}
        }
        match fs::remove_file(&path) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(files_error(&path, error)),
        }
        let mut dir = Self::dir(layout, root);
        for _ in layout.dirs() {
            remove_if_empty(&dir);
            match dir.parent() {
                Some(parent) => dir = parent.to_path_buf(),
                None => break,
            }
        }
        Ok(())
    }

    /// Whether the file's folders are all there as plain folders:
    /// `Ok(false)` when one is not there, an error when one is anything else
    /// (a link would take what is read, written or removed in it out of the
    /// store).
    fn plain_dirs(layout: Layout, root: &Path) -> Result<bool, Reason> {
        let mut dir = root.to_path_buf();
        for name in layout.dirs() {
            dir = dir.join(name);
            match fs::symlink_metadata(&dir) {
                Ok(meta) if meta.is_dir() => {}
                Ok(_) => return Err(files_error(&dir, "not a plain folder")),
                Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(false),
                Err(error) => return Err(files_error(&dir, error)),
            }
        }
        Ok(true)
    }

    pub(crate) fn is_empty(&self) -> bool {
        self.file.plugins.is_empty()
    }

    /// The install name and revision an entry of Codeg's points at.
    pub(crate) fn owner_of(&self, entry: &MarketEntry) -> Option<(String, u64)> {
        let rest = self.layout.source_path(&entry.source)?.strip_prefix("./")?;
        let (name, revision) = rest.split_once('/')?;
        if !is_valid_install_name(name)
            || revision.is_empty()
            || !revision.bytes().all(|b| b.is_ascii_digit())
        {
            return None;
        }
        Some((name.to_string(), revision.parse().ok()?))
    }

    fn is_of(&self, entry: &MarketEntry, name: &InstallName) -> bool {
        self.owner_of(entry)
            .is_some_and(|(owner, _)| same_name(&owner, name))
    }

    /// The entry of the plugin installed as `name`.
    pub(crate) fn entry_of(&self, name: &InstallName) -> Option<&MarketEntry> {
        self.file
            .plugins
            .iter()
            .find(|entry| self.is_of(entry, name))
    }

    /// The folder the plugin's entry points at, as written.
    pub(crate) fn entry_path(&self, entry: &MarketEntry) -> Option<String> {
        self.layout.source_path(&entry.source).map(str::to_string)
    }

    /// Take the plugin's entry out.
    pub(crate) fn drop_plugin(&mut self, name: &InstallName) {
        let owners: Vec<bool> = self
            .file
            .plugins
            .iter()
            .map(|entry| self.is_of(entry, name))
            .collect();
        let mut owned = owners.into_iter();
        self.file.plugins.retain(|_| !owned.next().unwrap_or(false));
    }

    /// Point the plugin's one entry, named `name`, at its revision. Refused
    /// when another entry goes by that name.
    pub(crate) fn claim(&mut self, plugin: &HostPlugin<'_>, name: &str) -> Result<(), Reason> {
        if let Some(other) =
            self.file.plugins.iter().find(|entry| {
                !self.is_of(entry, plugin.name) && entry.name.eq_ignore_ascii_case(name)
            })
        {
            let holder = self
                .owner_of(other)
                .map(|(owner, _)| owner)
                .unwrap_or_else(|| source_text(&other.source));
            return Err(Reason::new(codes::NAME_TAKEN)
                .param("name", name)
                .param("plugin", holder));
        }
        let source = self.layout.source_of(plugin);
        let mine: Vec<bool> = self
            .file
            .plugins
            .iter()
            .map(|entry| self.is_of(entry, plugin.name))
            .collect();
        match mine.iter().position(|&is| is) {
            Some(first) => {
                let entry = &mut self.file.plugins[first];
                entry.name = name.to_string();
                entry.source = source;
                // One entry per plugin.
                let mut index = 0;
                self.file.plugins.retain(|_| {
                    let keep = index == first || !mine[index];
                    index += 1;
                    keep
                });
            }
            None => self.file.plugins.push(MarketEntry {
                name: name.to_string(),
                source,
                extra: Map::new(),
            }),
        }
        Ok(())
    }

    /// The name the host has the plugin under, as far as Codeg can tell it
    /// is this plugin's: its marketplace entry's, else the one the record
    /// kept from its install — unless another plugin's entry goes by that
    /// name. `None`: nothing in the host is provably this plugin's.
    pub(crate) fn own_name(&self, plugin: &HostPlugin<'_>) -> Option<String> {
        if let Some(entry) = self.entry_of(plugin.name) {
            return Some(entry.name.clone());
        }
        let name = plugin
            .host_name
            .filter(|name| is_valid_install_name(name))?;
        let taken = self
            .file
            .plugins
            .iter()
            .any(|entry| entry.name.eq_ignore_ascii_case(name));
        (!taken).then(|| name.to_string())
    }
}

/// The ACP wrapper Codeg's sessions of `agent` run, found the way a
/// session's launch finds it; without one, the user's own CLI of the host.
pub(crate) async fn system_programs(agent: AgentType) -> (Option<PathBuf>, Option<PathBuf>) {
    let wrapper = match registry::get_agent_meta(agent).distribution {
        AgentDistribution::Npx { cmd, .. } => {
            crate::commands::acp::resolve_npx_command_for(agent, cmd).await
        }
        _ => None,
    };
    if wrapper.is_some() {
        return (wrapper, None);
    }
    let native = match registry::acp_adapter_relation(agent) {
        Some(relation) => {
            crate::commands::acp::resolve_vendor_cli(relation.native_cmd, relation.extra_dirs).await
        }
        None => None,
    };
    (None, native)
}

pub(crate) fn cli_of<'a>(cx: &HostCx<'a>) -> Result<&'a HostCli, Reason> {
    cx.cli.ok_or_else(|| Reason::new(codes::HOST_NOT_FOUND))
}

/// The store's folder as a host is to record it.
pub(crate) fn root_arg<'a>(cx: &HostCx<'a>) -> Result<&'a str, Reason> {
    cx.ctx.root.to_str().ok_or_else(|| {
        Reason::new(codes::HOST_FILES).detail(format!(
            "{} is not a path the host can record",
            cx.ctx.root.display()
        ))
    })
}

/// Where the commands run: always the store's folder (made when it is
/// not there yet), which a relative config folder of the host's is taken
/// from.
pub(crate) fn command_cwd(cx: &HostCx<'_>) -> Result<PathBuf, Reason> {
    let root = &cx.ctx.root;
    fs::create_dir_all(root).map_err(|error| files_error(root, error))?;
    Ok(root.clone())
}

/// The folder the agent's environment names in `var` (`CLAUDE_CONFIG_DIR`,
/// `CODEX_HOME`, `XDG_CONFIG_HOME`, …): `Ok(None)` when it names none. A
/// relative one is refused: each session takes it from the project it runs
/// in, so no one folder is the host's.
pub(crate) fn env_dir(env: &HostEnv, var: &str) -> Result<Option<PathBuf>, Reason> {
    match env.path_var(var) {
        Some(dir) if dir.is_absolute() => Ok(Some(dir)),
        Some(dir) => Err(Reason::new(codes::HOST_HOME_RELATIVE)
            .param("variable", var)
            .param("path", dir.to_string_lossy())),
        None => Ok(None),
    }
}

/// The plugin's revision folder, which must be there (not a link).
pub(crate) fn revision_dir(cx: &HostCx<'_>, plugin: &HostPlugin<'_>) -> Result<PathBuf, Reason> {
    let dir = cx.ctx.revision_dir(plugin.name, plugin.revision);
    if fs::symlink_metadata(&dir).is_ok_and(|meta| meta.is_dir()) {
        Ok(dir)
    } else {
        Err(Reason::new(codes::REVISION_MISSING).param("revision", plugin.revision.to_string()))
    }
}

/// The plugin's manifest for this host in its revision folder: the install
/// info's path, else `default`. `None` when it is not there as a plain
/// file of JSON.
pub(crate) fn read_manifest(
    cx: &HostCx<'_>,
    plugin: &HostPlugin<'_>,
    default: &str,
) -> Option<Value> {
    let manifest = plugin
        .manifest
        .filter(|path| !path.is_empty())
        .unwrap_or(default);
    if !safe_path(manifest) {
        return None;
    }
    read_json_file(
        &cx.ctx
            .revision_dir(plugin.name, plugin.revision)
            .join(manifest),
    )
}

/// A plain file of JSON (not a link), at most [`MANIFEST_BYTES`].
pub(crate) fn read_json_file(path: &Path) -> Option<Value> {
    let meta = fs::symlink_metadata(path).ok()?;
    if !meta.is_file() || meta.len() > MANIFEST_BYTES {
        return None;
    }
    serde_json::from_slice(&fs::read(path).ok()?).ok()
}

/// The name the revision's own manifest for this host gives the plugin;
/// else `PluginInfo.name`; else the install name.
pub(crate) fn manifest_name(cx: &HostCx<'_>, plugin: &HostPlugin<'_>, default: &str) -> String {
    read_manifest(cx, plugin, default)
        .as_ref()
        .and_then(|manifest| manifest.get("name")?.as_str())
        .filter(|name| is_valid_install_name(name))
        .map(str::to_string)
        .or_else(|| {
            plugin
                .info_name
                .filter(|name| is_valid_install_name(name))
                .map(str::to_string)
        })
        .unwrap_or_else(|| plugin.name.to_string())
}

/// Whether two paths name one folder.
pub(crate) fn same_dir(a: &Path, b: &Path) -> bool {
    match (fs::canonicalize(a), fs::canonicalize(b)) {
        (Ok(a), Ok(b)) => a == b,
        _ => a == b,
    }
}

pub(crate) fn files_error(path: &Path, error: impl std::fmt::Display) -> Reason {
    Reason::new(codes::HOST_FILES).detail(format!("{}: {error}", path.display()))
}

/// Remove `path` — a folder with what is in it, or a file or a link (never
/// what a link points at). Gone already is fine.
pub(crate) fn remove_path(path: &Path) -> Result<(), Reason> {
    let outcome = match fs::symlink_metadata(path) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => Err(error),
        Ok(meta) if meta.is_dir() => fs::remove_dir_all(path),
        Ok(_) => fs::remove_file(path),
    };
    outcome.map_err(|error| files_error(path, error))
}
