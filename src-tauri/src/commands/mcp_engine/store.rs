//! One agent's servers inside its config document, whatever the format.
//!
//! Two ways in: [`read_view`] lists the servers for the inventory, and
//! [`open_store`] opens the document for editing. An edit goes through the
//! format's own tree (`json_doc`: the jsonc-parser CST; `toml_doc`:
//! `toml_edit`), so what it does not touch — comments, key order, spacing —
//! comes out byte for byte; YAML (`yaml_doc`) is re-serialized.

use std::collections::BTreeSet;

use serde_json::Value;

use crate::commands::mcp::McpAppType;

use super::dialect::FieldOp;
use super::model::{codes, McpConfigFormat, McpIssue};

/// A name that occurs more than once where codeg would have to pick one.
///
/// In a JSON document a key may be there twice: a reader of it ends up with
/// the last occurrence, an edit through the CST would land on the first — the
/// edit would report success and change nothing the agent sees. In YAML two
/// keys can read as one name (`1` and `"1"`). TOML refuses a repeated key
/// when it is parsed, and so does YAML for one written the same way: such a
/// file is unreadable.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum DuplicateKey {
    /// The entry's own name, in the servers' container.
    Entry,
    /// A key inside the entry; its path there (`disabled`, `env.TOKEN`).
    Field(String),
}

/// One entry as it is in the document, as JSON.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct RawEntry {
    pub key: String,
    pub value: Value,
    /// It sits where an older release of the agent kept its servers
    /// (OpenCode 1.x's `mcp.<id>`, an old codeg's `[mcp.servers.<id>]` in
    /// Codex's file).
    pub legacy: bool,
    /// The entry cannot be edited: which of two occurrences an edit would
    /// reach is not the one a reader sees. Filled in by [`EntryStore::get`]
    /// and [`read_view_with_duplicates`]; a plain [`read_view`] leaves it out.
    pub duplicate: Option<DuplicateKey>,
}

/// What a document says about an agent's servers.
#[derive(Debug, Clone, PartialEq, Default)]
pub(crate) struct ServersView {
    /// In document order; the current location first, then the older one.
    pub entries: Vec<RawEntry>,
    /// The place the servers live in holds something else (a string, a
    /// list): codeg lists nothing and writes nothing. Names the key.
    pub container_invalid: Option<String>,
    /// The names in the agent's root "off" list, where it has one.
    pub disabled_names: BTreeSet<String>,
    /// The servers' container (or the root "off" list) occurs more than once
    /// in the document: what is listed is the last one, and codeg writes
    /// nothing. Names the key. Filled in by [`read_view_with_duplicates`].
    pub duplicate_container: Option<String>,
}

/// A document open for editing. Every method leaves it a valid document;
/// nothing reaches the disk until the caller writes [`EntryStore::finish`].
pub(crate) trait EntryStore {
    /// The entry under `key` as the document has it now.
    fn get(&self, key: &str) -> Option<RawEntry>;
    /// Add an entry with these fields, in this order.
    fn create(&mut self, key: &str, fields: &[(String, Value)]) -> Result<(), String>;
    /// Change fields of the entry under `key`, leaving the rest of it alone.
    fn patch(&mut self, key: &str, ops: &[FieldOp]) -> Result<(), String>;
    /// Put an entry with these fields in place of whatever `key` holds.
    fn replace(&mut self, key: &str, fields: &[(String, Value)]) -> Result<(), String>;
    /// Remove the entry, from the older location too. Whether it was there.
    fn remove(&mut self, key: &str) -> Result<bool, String>;
    /// Give the entry another name, in place.
    fn rename(&mut self, from: &str, to: &str) -> Result<(), String>;
    /// Move an entry from the older location to the current one, in the
    /// current shape.
    fn promote(&mut self, key: &str) -> Result<(), String>;
    fn root_list_contains(&self, list: &str, name: &str) -> bool;
    /// Add `name` to, or take it out of, the list of names at the root.
    /// Whether anything changed.
    fn set_root_list(&mut self, list: &str, name: &str, present: bool) -> Result<bool, String>;
    /// The document as text. Untouched, it is the text it was opened from.
    fn finish(self: Box<Self>) -> String;
    /// The key of the servers' container (or of the root "off" list) that
    /// occurs more than once, when one does: nothing in the document can be
    /// edited then. See [`DuplicateKey`] for why only JSON has an answer.
    fn duplicate_container(&self) -> Option<String> {
        None
    }
    /// Whether a new entry named `key` would be taken for part of the
    /// document's structure instead of for a server, as the document is now.
    fn is_structural_key(&self, _key: &str) -> bool {
        false
    }
}

/// Split a leading byte-order mark off `text`.
pub(crate) fn split_bom(text: &str) -> (bool, &str) {
    match text.strip_prefix('\u{feff}') {
        Some(rest) => (true, rest),
        None => (false, text),
    }
}

pub(crate) fn with_bom(bom: bool, text: String) -> String {
    if bom {
        format!("\u{feff}{text}")
    } else {
        text
    }
}

/// The file's bytes as text; a file that is not there reads as empty.
pub(crate) fn decode(bytes: Option<&[u8]>) -> Result<&str, McpIssue> {
    match bytes {
        None => Ok(""),
        Some(bytes) => std::str::from_utf8(bytes)
            .map_err(|e| McpIssue::new(codes::NOT_UTF8).detail(e.to_string())),
    }
}

/// List `app`'s servers in the document `text`.
pub(crate) fn read_view(
    app: McpAppType,
    format: McpConfigFormat,
    text: &str,
) -> Result<ServersView, McpIssue> {
    match format {
        McpConfigFormat::Json | McpConfigFormat::Jsonc => super::json_doc::read_view(app, text),
        McpConfigFormat::Toml => super::toml_doc::read_view(app, text),
        McpConfigFormat::Yaml => super::yaml_doc::read_view(text),
    }
}

/// [`read_view`], with what cannot be edited for being there twice marked:
/// [`ServersView::duplicate_container`] and each [`RawEntry::duplicate`]. For
/// the inventory; it costs a second parse of a JSON document, which a session
/// start has no use for.
pub(crate) fn read_view_with_duplicates(
    app: McpAppType,
    format: McpConfigFormat,
    text: &str,
) -> Result<ServersView, McpIssue> {
    let mut view = read_view(app, format, text)?;
    match format {
        McpConfigFormat::Json | McpConfigFormat::Jsonc => {
            super::json_doc::mark_duplicates(app, text, &mut view)
        }
        McpConfigFormat::Yaml => super::yaml_doc::mark_duplicates(text, &mut view),
        McpConfigFormat::Toml => {}
    }
    Ok(view)
}

/// Open the document `text` to edit `app`'s servers in it.
pub(crate) fn open_store(
    app: McpAppType,
    format: McpConfigFormat,
    text: &str,
) -> Result<Box<dyn EntryStore>, McpIssue> {
    Ok(match format {
        McpConfigFormat::Json | McpConfigFormat::Jsonc => {
            Box::new(super::json_doc::JsonStore::open(app, text)?)
        }
        McpConfigFormat::Toml => Box::new(super::toml_doc::TomlStore::open(app, text)?),
        McpConfigFormat::Yaml => Box::new(super::yaml_doc::YamlStore::open(text)?),
    })
}
