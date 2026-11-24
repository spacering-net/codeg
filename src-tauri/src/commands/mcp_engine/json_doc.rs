//! The agents whose servers live in a JSON document.
//!
//! Every one of them is read as JSON with comments and trailing commas
//! allowed (Gemini's and Qoder's settings files may have them, OpenCode's
//! does by design), and edited through the jsonc-parser CST — the way
//! `acp::opencode_config` edits OpenCode's file — so an edit changes the
//! entry it is about and leaves every other byte where it was.
//!
//! Where the servers are:
//! - `mcpServers` at the root, for most;
//! - `mcp.servers` for OpenClaw (listed only) and OpenCode 2, which also
//!   still loads 1.x's direct `mcp.<id>` entries;
//! - `mcpServers` or, when that key is absent, the root itself for Google
//!   Antigravity, whose loader does `data.get("mcpServers", data)`.
//!
//! **A key that is there twice.** JSON allows it, and the two ways into a
//! document disagree about it: a reader (the agent, and the listing here)
//! ends up with the last occurrence, a CST lookup finds the first. An edit
//! of such a key would be written, reported, and change nothing the agent
//! sees. So nothing is edited where the choice exists — see
//! [`JsonStore::duplicate_container`] for the whole document and
//! [`DuplicateKey`] for one entry — and the listing says so.

use std::collections::BTreeSet;

use jsonc_parser::cst::{CstInputValue, CstNode, CstObject, CstObjectProp, CstRootNode};
use serde_json::{Map, Value};

use crate::acp::opencode_config;
use crate::commands::mcp::{
    is_opencode_direct_entry, opencode_legacy_extras, McpAppType, OPENCODE_MCP_RESERVED,
};

use super::agents::EntryFlag;
use super::dialect::{self, FieldOp};
use super::model::{codes, McpIssue};
use super::store::{split_bom, with_bom, DuplicateKey, EntryStore, RawEntry, ServersView};

/// OpenCode 1.x switched a server off with `enabled: false`.
pub(crate) const OPENCODE_LEGACY_FLAG: EntryFlag = EntryFlag {
    key: "enabled",
    off: false,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Shape {
    /// The servers are the object under this root key.
    RootKey(&'static str),
    /// `mcp.servers`, plus 1.x's direct `mcp.<id>` entries.
    OpenCode,
    /// `mcp.servers`.
    OpenClaw,
    /// `mcpServers`, or the root itself while that key is absent.
    Antigravity,
}

fn shape(app: McpAppType) -> Shape {
    match app {
        McpAppType::OpenCode => Shape::OpenCode,
        McpAppType::OpenClaw => Shape::OpenClaw,
        McpAppType::Antigravity => Shape::Antigravity,
        _ => Shape::RootKey("mcpServers"),
    }
}

/// The name of an agent's root "off" list, when it is a JSON agent that has
/// one.
fn root_list_key(app: McpAppType) -> Option<&'static str> {
    super::agents::spec(app).disable.root_list
}

fn parse_root(text: &str) -> Result<Map<String, Value>, McpIssue> {
    match opencode_config::parse(text) {
        Ok(Value::Object(root)) => Ok(root),
        Ok(_) => Err(McpIssue::new(codes::ROOT_NOT_OBJECT)),
        Err(e) => Err(McpIssue::new(codes::INVALID_JSON).detail(e)),
    }
}

fn entries_of(map: &Map<String, Value>, legacy: bool) -> impl Iterator<Item = RawEntry> + '_ {
    map.iter().map(move |(key, value)| RawEntry {
        key: key.clone(),
        value: value.clone(),
        legacy,
        duplicate: None,
    })
}

/// OpenCode's `mcp.servers` when it is the server map and not a 1.x server
/// that happens to be named `servers`.
fn opencode_native(mcp: &Map<String, Value>) -> Result<Option<&Map<String, Value>>, ()> {
    match mcp.get("servers") {
        None => Ok(None),
        Some(servers) if is_opencode_direct_entry(servers) => Err(()),
        Some(Value::Object(servers)) => Ok(Some(servers)),
        Some(_) => Err(()),
    }
}

pub(crate) fn read_view(app: McpAppType, text: &str) -> Result<ServersView, McpIssue> {
    let (_, body) = split_bom(text);
    let root = parse_root(body)?;
    let mut view = ServersView::default();
    match shape(app) {
        Shape::RootKey(key) => match root.get(key) {
            None => {}
            Some(Value::Object(servers)) => view.entries.extend(entries_of(servers, false)),
            Some(_) => view.container_invalid = Some(key.to_string()),
        },
        Shape::OpenClaw => match root.get("mcp") {
            None => {}
            Some(Value::Object(mcp)) => match mcp.get("servers") {
                None => {}
                Some(Value::Object(servers)) => view.entries.extend(entries_of(servers, false)),
                Some(_) => view.container_invalid = Some("mcp.servers".to_string()),
            },
            Some(_) => view.container_invalid = Some("mcp".to_string()),
        },
        Shape::Antigravity => match root.get("mcpServers") {
            // The loader falls back to the root only while the key is absent.
            None => view.entries.extend(entries_of(&root, false)),
            Some(Value::Object(servers)) => view.entries.extend(entries_of(servers, false)),
            Some(_) => view.container_invalid = Some("mcpServers".to_string()),
        },
        Shape::OpenCode => match root.get("mcp") {
            None => {}
            Some(Value::Object(mcp)) => {
                match opencode_native(mcp) {
                    Ok(Some(servers)) => view.entries.extend(entries_of(servers, false)),
                    Ok(None) => {}
                    Err(()) => view.container_invalid = Some("mcp.servers".to_string()),
                }
                // 1.x entries OpenCode 2 still loads: every key of `mcp` but
                // `servers` and `timeout` that holds a server, unless a
                // current entry has the name.
                let native: BTreeSet<String> =
                    view.entries.iter().map(|entry| entry.key.clone()).collect();
                for (key, value) in mcp {
                    if OPENCODE_MCP_RESERVED.contains(&key.as_str())
                        || native.contains(key)
                        || !is_opencode_direct_entry(value)
                    {
                        continue;
                    }
                    view.entries.push(RawEntry {
                        key: key.clone(),
                        value: value.clone(),
                        legacy: true,
                        duplicate: None,
                    });
                }
            }
            Some(_) => view.container_invalid = Some("mcp".to_string()),
        },
    }
    if let Some(list) = root_list_key(app) {
        if let Some(Value::Array(names)) = root.get(list) {
            view.disabled_names = names
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect();
        }
    }
    Ok(view)
}

/// Mark in `view` — read from this same `text` — what cannot be edited for
/// being there twice: the container, and each entry. The answers are the
/// ones [`JsonStore`] gives `mcp_apply`, so the listing and a save agree.
pub(crate) fn mark_duplicates(app: McpAppType, text: &str, view: &mut ServersView) {
    // Text that does not open was refused by the read already.
    let Ok(store) = JsonStore::open(app, text) else {
        return;
    };
    view.duplicate_container = store.duplicate_container();
    for entry in &mut view.entries {
        entry.duplicate = store.duplicate_of(&entry.key);
    }
}

/// The properties of `object` named `name`, in document order.
fn named(object: &CstObject, name: &str) -> Vec<CstObjectProp> {
    object
        .properties()
        .into_iter()
        .filter(|prop| prop.decoded_name().as_deref() == Some(name))
        .collect()
}

/// How many of `object`'s keys are `name`.
pub(crate) fn occurrences(object: &CstObject, name: &str) -> usize {
    named(object, name).len()
}

/// The path of a key that occurs more than once in one object, anywhere
/// inside `node`: `disabled`, `env.TOKEN`, `oauth.0.scope`.
fn repeated_key_in(node: &CstNode) -> Option<String> {
    if let Some(object) = node.as_object() {
        let props = object.properties();
        let mut seen = BTreeSet::new();
        for prop in &props {
            if let Some(name) = prop.decoded_name() {
                if !seen.insert(name.clone()) {
                    return Some(name);
                }
            }
        }
        props.iter().find_map(|prop| {
            let inner = repeated_key_in(&prop.value()?)?;
            Some(format!("{}.{inner}", prop.decoded_name()?))
        })
    } else if let Some(array) = node.as_array() {
        array
            .elements()
            .iter()
            .enumerate()
            .find_map(|(index, element)| Some(format!("{index}.{}", repeated_key_in(element)?)))
    } else {
        None
    }
}

fn object_input(fields: &[(String, Value)]) -> CstInputValue {
    CstInputValue::Object(
        fields
            .iter()
            .map(|(key, value)| (key.clone(), opencode_config::cst_value(value)))
            .collect(),
    )
}

/// A node's value, read back from its own text.
fn node_value(node: &CstNode) -> Option<Value> {
    opencode_config::parse(&node.to_string()).ok()
}

fn scalar_reads_as(value: &Value, text: &str) -> bool {
    match value {
        Value::String(current) => current == text,
        Value::Number(n) => n.to_string() == text,
        Value::Bool(b) => b.to_string() == text,
        _ => false,
    }
}

pub(crate) struct JsonStore {
    app: McpAppType,
    root: CstRootNode,
    bom: bool,
    original: String,
    /// The document was empty: what is written ends with a newline.
    was_empty: bool,
    dirty: bool,
}

impl JsonStore {
    pub(crate) fn open(app: McpAppType, text: &str) -> Result<Self, McpIssue> {
        let (bom, body) = split_bom(text);
        let was_empty = body.trim().is_empty();
        let source = if was_empty { "{}" } else { body };
        parse_root(source)?;
        let root = CstRootNode::parse(source, &opencode_config::parse_options())
            .map_err(|e| McpIssue::new(codes::INVALID_JSON).detail(e.to_string()))?;
        if root.object_value().is_none() {
            return Err(McpIssue::new(codes::ROOT_NOT_OBJECT));
        }
        Ok(Self {
            app,
            root,
            bom,
            original: text.to_string(),
            was_empty,
            dirty: false,
        })
    }

    fn root_object(&self) -> Result<CstObject, String> {
        self.root
            .object_value()
            .ok_or_else(|| "the root is not an object".to_string())
    }

    /// OpenCode's `mcp`, when it is there.
    fn mcp(&self) -> Option<CstObject> {
        self.root.object_value()?.object_value("mcp")
    }

    /// The object the current entries are in, when the document has one.
    fn servers(&self) -> Option<CstObject> {
        let root = self.root.object_value()?;
        match shape(self.app) {
            Shape::RootKey(key) => root.object_value(key),
            Shape::OpenClaw => root.object_value("mcp")?.object_value("servers"),
            Shape::OpenCode => {
                let servers = root.object_value("mcp")?.object_value("servers")?;
                let value = node_value(&servers.clone().into())?;
                (!is_opencode_direct_entry(&value)).then_some(servers)
            }
            Shape::Antigravity => match root.get("mcpServers") {
                Some(prop) => prop.object_value(),
                None if root.properties().is_empty() => None,
                None => Some(root),
            },
        }
    }

    /// [`Self::servers`], made when the document has none yet.
    fn servers_or_create(&self) -> Result<CstObject, String> {
        if let Some(servers) = self.servers() {
            return Ok(servers);
        }
        let root = self.root_object()?;
        let not_a_map = |key: &str| format!("`{key}` is not a map of servers");
        match shape(self.app) {
            Shape::RootKey(key) => root
                .object_value_or_create(key)
                .ok_or_else(|| not_a_map(key)),
            Shape::Antigravity => root
                .object_value_or_create("mcpServers")
                .ok_or_else(|| not_a_map("mcpServers")),
            Shape::OpenClaw | Shape::OpenCode => {
                let mcp = root
                    .object_value_or_create("mcp")
                    .ok_or_else(|| not_a_map("mcp"))?;
                if mcp.get("servers").is_some() {
                    // There, and `servers()` refused it: not a server map.
                    return Err(not_a_map("mcp.servers"));
                }
                mcp.object_value_or_create("servers")
                    .ok_or_else(|| not_a_map("mcp.servers"))
            }
        }
    }

    /// Every occurrence of `key` in OpenCode 1.x's location, `mcp.<key>`, in
    /// document order. None for another agent, and for the two keys of `mcp`
    /// that are never a server's (`servers`, `timeout`).
    fn legacy_props(&self, key: &str) -> Vec<CstObjectProp> {
        if shape(self.app) != Shape::OpenCode || OPENCODE_MCP_RESERVED.contains(&key) {
            return Vec::new();
        }
        self.mcp().map(|mcp| named(&mcp, key)).unwrap_or_default()
    }

    /// The 1.x entry under `key`, when OpenCode would load it: the last
    /// occurrence, the one a reader of the file ends up with.
    fn legacy_value(&self, key: &str) -> Option<Value> {
        let value = node_value(&self.legacy_props(key).pop()?.value()?)?;
        is_opencode_direct_entry(&value).then_some(value)
    }

    /// What makes `key` a name no operation is carried out on, looked for
    /// everywhere an operation on it reads or writes: the current location
    /// and — for OpenCode, whether or not the current one has the name —
    /// the older one, once one of its occurrences there is a server.
    fn duplicate_of(&self, key: &str) -> Option<DuplicateKey> {
        let native = self
            .servers()
            .map(|servers| named(&servers, key))
            .unwrap_or_default();
        let mut legacy = self.legacy_props(key);
        let is_server = |prop: &CstObjectProp| {
            prop.value()
                .and_then(|node| node_value(&node))
                .is_some_and(|value| is_opencode_direct_entry(&value))
        };
        if !legacy.iter().any(is_server) {
            // Nothing there OpenCode loads or an operation touches.
            legacy.clear();
        }
        if native.len() > 1 || legacy.len() > 1 {
            return Some(DuplicateKey::Entry);
        }
        native
            .iter()
            .chain(&legacy)
            .find_map(|prop| repeated_key_in(&prop.value()?))
            .map(DuplicateKey::Field)
    }

    fn entry_object(&self, key: &str) -> Result<CstObject, String> {
        self.servers()
            .and_then(|servers| servers.object_value(key))
            .ok_or_else(|| format!("`{key}` is not an object"))
    }
}

impl EntryStore for JsonStore {
    fn get(&self, key: &str) -> Option<RawEntry> {
        // The last occurrence: the one a reader of the file ends up with.
        let native = self.servers().and_then(|servers| {
            let node = named(&servers, key).pop()?.value()?;
            node_value(&node)
        });
        let (value, legacy) = match native {
            Some(value) => (value, false),
            None => (self.legacy_value(key)?, true),
        };
        Some(RawEntry {
            key: key.to_string(),
            value,
            legacy,
            duplicate: self.duplicate_of(key),
        })
    }

    fn create(&mut self, key: &str, fields: &[(String, Value)]) -> Result<(), String> {
        let servers = self.servers_or_create()?;
        servers.append(key, object_input(fields));
        self.dirty = true;
        Ok(())
    }

    fn patch(&mut self, key: &str, ops: &[FieldOp]) -> Result<(), String> {
        if ops.is_empty() {
            return Ok(());
        }
        let entry = self.entry_object(key)?;
        for op in ops {
            match op {
                FieldOp::Set(name, value) => opencode_config::set_property(&entry, name, value),
                FieldOp::Remove(name) => {
                    opencode_config::remove_property(&entry, name);
                }
                FieldOp::SyncMap(name, wanted) => match entry.object_value(name) {
                    Some(map) => {
                        for prop in map.properties() {
                            let stale = prop
                                .decoded_name()
                                .is_none_or(|name| !wanted.contains_key(&name));
                            if stale {
                                prop.remove();
                            }
                        }
                        for (name, text) in wanted {
                            match map.get(name) {
                                Some(prop) => {
                                    // A value that already reads as this
                                    // text stays as it is written.
                                    let same = prop
                                        .value()
                                        .and_then(|node| node_value(&node))
                                        .is_some_and(|value| scalar_reads_as(&value, text));
                                    if !same {
                                        prop.set_value(CstInputValue::String(text.clone()));
                                    }
                                }
                                None => {
                                    map.append(name, CstInputValue::String(text.clone()));
                                }
                            }
                        }
                    }
                    None => {
                        let fresh: Vec<(String, Value)> = wanted
                            .iter()
                            .map(|(name, text)| (name.clone(), Value::String(text.clone())))
                            .collect();
                        match entry.get(name) {
                            Some(prop) => prop.set_value(object_input(&fresh)),
                            None => {
                                entry.append(name, object_input(&fresh));
                            }
                        }
                    }
                },
            }
        }
        self.dirty = true;
        Ok(())
    }

    fn replace(&mut self, key: &str, fields: &[(String, Value)]) -> Result<(), String> {
        let prop = self
            .servers()
            .and_then(|servers| servers.get(key))
            .ok_or_else(|| format!("`{key}` is not there"))?;
        prop.set_value(object_input(fields));
        self.dirty = true;
        Ok(())
    }

    fn remove(&mut self, key: &str) -> Result<bool, String> {
        let mut removed = false;
        if let Some(prop) = self.servers().and_then(|servers| servers.get(key)) {
            prop.remove();
            removed = true;
        }
        if self.legacy_value(key).is_some() {
            if let Some(prop) = self.legacy_props(key).pop() {
                prop.remove();
                removed = true;
            }
        }
        self.dirty |= removed;
        Ok(removed)
    }

    fn rename(&mut self, from: &str, to: &str) -> Result<(), String> {
        let prop = self
            .servers()
            .and_then(|servers| servers.get(from))
            .ok_or_else(|| format!("`{from}` is not there"))?;
        let name = prop
            .name()
            .and_then(|name| name.as_string_lit())
            .ok_or_else(|| format!("`{from}` has no quoted name"))?;
        let quoted = serde_json::to_string(to).map_err(|e| e.to_string())?;
        name.set_raw_value(quoted);
        self.dirty = true;
        Ok(())
    }

    fn promote(&mut self, key: &str) -> Result<(), String> {
        let Some(legacy) = self.legacy_value(key) else {
            return Ok(());
        };
        let read = dialect::read_entry(self.app, &legacy, Some(OPENCODE_LEGACY_FLAG));
        let definition = read
            .definition
            .ok_or_else(|| format!("`mcp.{key}` is not a server OpenCode 2 can take"))?;
        // The entry in OpenCode 2's shape, with the settings it carried
        // converted the way OpenCode converts them when it loads one.
        let mut fields = dialect::fresh_fields(self.app, &definition);
        let managed: Map<String, Value> = fields.iter().cloned().collect();
        for (name, value) in opencode_legacy_extras(&legacy, &managed) {
            if !fields.iter().any(|(existing, _)| *existing == name) {
                fields.push((name, value));
            }
        }
        if !read.enabled {
            fields.push(("disabled".to_string(), Value::Bool(true)));
        }
        let servers = self.servers_or_create()?;
        if let Some(prop) = self.legacy_props(key).pop() {
            prop.remove();
        }
        servers.append(key, object_input(&fields));
        self.dirty = true;
        Ok(())
    }

    fn root_list_contains(&self, list: &str, name: &str) -> bool {
        self.root
            .object_value()
            .and_then(|root| root.array_value(list))
            .is_some_and(|names| {
                names
                    .elements()
                    .iter()
                    .any(|node| node_value(node) == Some(Value::String(name.to_string())))
            })
    }

    fn set_root_list(&mut self, list: &str, name: &str, present: bool) -> Result<bool, String> {
        if self.root_list_contains(list, name) == present {
            return Ok(false);
        }
        let root = self.root_object()?;
        if present {
            let names = root
                .array_value_or_create(list)
                .ok_or_else(|| format!("`{list}` is not a list"))?;
            names.append(CstInputValue::String(name.to_string()));
        } else if let Some(names) = root.array_value(list) {
            for node in names.elements() {
                if node_value(&node) == Some(Value::String(name.to_string())) {
                    node.remove();
                }
            }
        }
        self.dirty = true;
        Ok(true)
    }

    fn duplicate_container(&self) -> Option<String> {
        let root = self.root.object_value()?;
        let twice = |object: &CstObject, name: &str| occurrences(object, name) > 1;
        let container = match shape(self.app) {
            Shape::RootKey(key) => twice(&root, key).then(|| key.to_string()),
            Shape::Antigravity => twice(&root, "mcpServers").then(|| "mcpServers".to_string()),
            Shape::OpenClaw | Shape::OpenCode => {
                if twice(&root, "mcp") {
                    Some("mcp".to_string())
                } else {
                    root.object_value("mcp")
                        .filter(|mcp| twice(mcp, "servers"))
                        .map(|_| "mcp.servers".to_string())
                }
            }
        };
        container.or_else(|| {
            root_list_key(self.app)
                .filter(|list| twice(&root, list))
                .map(str::to_string)
        })
    }

    fn is_structural_key(&self, key: &str) -> bool {
        // Antigravity's bare map: the root is the server map only while it
        // has no `mcpServers` key. A server of that name would become the map
        // itself, and every other server in the file would stop being one.
        shape(self.app) == Shape::Antigravity
            && key == "mcpServers"
            && self.root.object_value().is_some_and(|root| {
                root.get("mcpServers").is_none() && !root.properties().is_empty()
            })
    }

    fn finish(self: Box<Self>) -> String {
        if !self.dirty {
            return self.original;
        }
        let mut text = self.root.to_string();
        if self.was_empty && !text.ends_with('\n') {
            text.push('\n');
        }
        with_bom(self.bom, text)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::collections::BTreeMap;

    fn open(app: McpAppType, text: &str) -> Box<dyn EntryStore> {
        Box::new(JsonStore::open(app, text).expect("opens"))
    }

    fn fields(value: Value) -> Vec<(String, Value)> {
        value
            .as_object()
            .unwrap()
            .iter()
            .map(|(key, value)| (key.clone(), value.clone()))
            .collect()
    }

    const COMMENTED: &str = r#"{
  // my settings
  "theme": "dark", // trailing
  "mcpServers": {
    /* the first */
    "first": {
      "command": "npx", // keep
      "args": ["-y", "first"],
      "env": {
        "TOKEN": "abc", // secret
        "PORT": 8080
      },
      "trust": true
    },
    "second": { "url": "https://x.test/mcp", "type": "http" },
  },
  "other": [1, 2,],
}
"#;

    #[test]
    fn an_edit_keeps_every_other_byte() {
        let mut store = open(McpAppType::Gemini, COMMENTED);
        store
            .patch("first", &[FieldOp::Set("command".into(), json!("node"))])
            .unwrap();
        let out = store.finish();
        assert_eq!(out, COMMENTED.replace("\"npx\"", "\"node\""));
    }

    #[test]
    fn an_untouched_document_comes_back_as_it_was() {
        let text = "\u{feff}{ \"mcpServers\" : {  } }";
        let mut store = open(McpAppType::ClaudeCode, text);
        store.patch("nothing", &[]).unwrap();
        assert!(!store.remove("nothing").unwrap());
        assert_eq!(store.finish(), text);
    }

    #[test]
    fn a_map_is_synced_key_by_key() {
        let mut store = open(McpAppType::Gemini, COMMENTED);
        let wanted = BTreeMap::from([
            ("PORT".to_string(), "8080".to_string()),
            ("NEW".to_string(), "n".to_string()),
        ]);
        store
            .patch("first", &[FieldOp::SyncMap("env".into(), wanted)])
            .unwrap();
        let out = store.finish();
        // The number that already reads as "8080" stays a number, the token
        // is gone, the new key is added, and the comments elsewhere stay.
        assert!(out.contains("\"PORT\": 8080"), "{out}");
        assert!(!out.contains("TOKEN"), "{out}");
        assert!(out.contains("\"NEW\": \"n\""), "{out}");
        assert!(out.contains("// my settings"), "{out}");
        assert!(out.contains("/* the first */"), "{out}");
        assert!(out.contains("\"npx\", // keep"), "{out}");
        let value = opencode_config::parse(&out).unwrap();
        assert_eq!(
            value["mcpServers"]["first"]["env"],
            json!({"PORT": 8080, "NEW": "n"})
        );
        assert_eq!(value["other"], json!([1, 2]));
    }

    #[test]
    fn entries_are_created_renamed_and_removed_in_place() {
        let mut store = open(McpAppType::Gemini, COMMENTED);
        store
            .create(
                "third",
                &fields(json!({"type": "stdio", "command": "x", "args": ["a"]})),
            )
            .unwrap();
        store.rename("second", "renamed").unwrap();
        assert!(store.remove("first").unwrap());
        assert!(store.get("first").is_none());
        assert_eq!(
            store.get("renamed").unwrap().value,
            json!({"url": "https://x.test/mcp", "type": "http"})
        );
        let out = store.finish();
        assert!(out.contains("// my settings"), "{out}");
        assert!(out.contains("\"theme\": \"dark\", // trailing"), "{out}");
        let value = opencode_config::parse(&out).unwrap();
        let servers = value["mcpServers"].as_object().unwrap();
        assert_eq!(
            servers.keys().collect::<Vec<_>>(),
            ["renamed", "third"],
            "the renamed entry keeps its place"
        );
        assert_eq!(
            servers["third"],
            json!({"type": "stdio", "command": "x", "args": ["a"]})
        );
        assert_eq!(value["theme"], "dark");
    }

    #[test]
    fn an_empty_or_missing_file_becomes_a_document() {
        for text in ["", "  \n"] {
            let mut store = open(McpAppType::ClaudeCode, text);
            store
                .create("x", &fields(json!({"type": "stdio", "command": "x"})))
                .unwrap();
            let out = store.finish();
            assert!(out.ends_with('\n'), "{out:?}");
            assert_eq!(
                opencode_config::parse(&out).unwrap(),
                json!({"mcpServers": {"x": {"type": "stdio", "command": "x"}}})
            );
        }
    }

    /// Claude Code, Cline and Kimi read their file with a strict
    /// `JSON.parse`: what codeg adds to a strict document must leave it one.
    #[test]
    fn a_strict_json_document_stays_strict_json() {
        let strict: [&str; 4] = [
            "",
            "{}",
            "{\"mcpServers\":{\"a\":{\"command\":\"a\",\"env\":{\"K\":\"v\"}}},\"n\":1}",
            "{\n  \"mcpServers\": {\n    \"a\": {\n      \"command\": \"a\"\n    }\n  }\n}\n",
        ];
        for text in strict {
            let mut store = open(McpAppType::ClaudeCode, text);
            store
                .create(
                    "new",
                    &fields(
                        json!({"type": "http", "url": "https://n.test", "headers": {"A": "b"}}),
                    ),
                )
                .unwrap();
            if store.get("a").is_some() {
                store
                    .patch(
                        "a",
                        &[
                            FieldOp::Set("args".into(), json!(["x", "y"])),
                            FieldOp::SyncMap(
                                "env".into(),
                                BTreeMap::from([("N".to_string(), "1".to_string())]),
                            ),
                            FieldOp::Set("disabled".into(), json!(true)),
                        ],
                    )
                    .unwrap();
                store.rename("a", "b").unwrap();
            }
            store
                .set_root_list("disabledMcpServers", "new", true)
                .unwrap();
            let out = store.finish();
            let value: Value = serde_json::from_str(&out)
                .unwrap_or_else(|e| panic!("not strict JSON ({e}):\n{out}"));
            assert_eq!(
                value["mcpServers"]["new"],
                json!({"type": "http", "url": "https://n.test", "headers": {"A": "b"}})
            );
            assert_eq!(value["disabledMcpServers"], json!(["new"]));
            if let Some(entry) = value["mcpServers"].get("b") {
                assert_eq!(entry["args"], json!(["x", "y"]));
                assert_eq!(entry["env"], json!({"N": "1"}));
                assert_eq!(entry["disabled"], json!(true));
            }
        }
    }

    #[test]
    fn a_container_that_is_not_a_map_is_refused_not_replaced() {
        let text = r#"{"mcpServers": "oops"}"#;
        let view = read_view(McpAppType::ClaudeCode, text).unwrap();
        assert_eq!(view.container_invalid.as_deref(), Some("mcpServers"));
        assert!(view.entries.is_empty());
        let mut store = open(McpAppType::ClaudeCode, text);
        assert!(store.create("x", &fields(json!({"command": "x"}))).is_err());
        assert_eq!(store.finish(), text);

        assert_eq!(
            read_view(McpAppType::ClaudeCode, "[1]").unwrap_err().code,
            codes::ROOT_NOT_OBJECT
        );
        assert_eq!(
            read_view(McpAppType::ClaudeCode, "{ \"a\": ")
                .unwrap_err()
                .code,
            codes::INVALID_JSON
        );
        assert!(JsonStore::open(McpAppType::ClaudeCode, "{ \"a\": ").is_err());
    }

    #[test]
    fn antigravity_is_edited_in_the_shape_it_has() {
        // Bare: the root is the map, and stays it.
        let bare = "{\n  \"a\": { \"command\": \"a\" }\n}\n";
        let view = read_view(McpAppType::Antigravity, bare).unwrap();
        assert_eq!(view.entries.len(), 1);
        let mut store = open(McpAppType::Antigravity, bare);
        store
            .create("b", &fields(json!({"type": "stdio", "command": "b"})))
            .unwrap();
        let value = opencode_config::parse(&store.finish()).unwrap();
        assert_eq!(
            value,
            json!({"a": {"command": "a"}, "b": {"type": "stdio", "command": "b"}})
        );

        // Wrapped: the root's other keys are not servers.
        let wrapped = r#"{"note": 1, "mcpServers": {"a": {"command": "a"}}}"#;
        let view = read_view(McpAppType::Antigravity, wrapped).unwrap();
        assert_eq!(
            view.entries
                .iter()
                .map(|e| e.key.as_str())
                .collect::<Vec<_>>(),
            ["a"]
        );

        // Empty: codeg writes the wrapper.
        let mut store = open(McpAppType::Antigravity, "{}");
        store.create("a", &fields(json!({"command": "a"}))).unwrap();
        assert_eq!(
            opencode_config::parse(&store.finish()).unwrap(),
            json!({"mcpServers": {"a": {"command": "a"}}})
        );

        // A wrapper that is not a map: nothing is listed, nothing written.
        let broken = r#"{"mcpServers": 3, "a": {"command": "a"}}"#;
        let view = read_view(McpAppType::Antigravity, broken).unwrap();
        assert_eq!(view.container_invalid.as_deref(), Some("mcpServers"));
        let mut store = open(McpAppType::Antigravity, broken);
        assert!(store.create("b", &fields(json!({"command": "b"}))).is_err());
    }

    #[test]
    fn opencode_lists_both_generations_and_moves_the_old_one_on_edit() {
        let text = r#"{
  // providers
  "mcp": {
    "timeout": 5000,
    "old": { "type": "local", "command": ["old", "--x"], "enabled": false, "timeout": 900 },
    "shadowed": { "type": "remote", "url": "https://old.test" },
    "servers": {
      "shadowed": { "type": "remote", "url": "https://new.test" },
      "current": { "type": "local", "command": ["cur"], "disabled": true }
    }
  }
}
"#;
        let view = read_view(McpAppType::OpenCode, text).unwrap();
        let listed: Vec<(&str, bool)> = view
            .entries
            .iter()
            .map(|entry| (entry.key.as_str(), entry.legacy))
            .collect();
        assert_eq!(
            listed,
            [("shadowed", false), ("current", false), ("old", true)]
        );

        let mut store = open(McpAppType::OpenCode, text);
        assert!(store.get("old").unwrap().legacy);
        assert!(store.get("timeout").is_none(), "not a server");
        store.promote("old").unwrap();
        let moved = store.get("old").unwrap();
        assert!(!moved.legacy);
        assert_eq!(
            moved.value,
            json!({
                "type": "local", "command": ["old", "--x"],
                "timeout": {"startup": 900, "catalog": 900, "execution": 900},
                "disabled": true
            })
        );
        // Removing a name takes both generations of it.
        assert!(store.remove("shadowed").unwrap());
        let out = store.finish();
        assert!(out.contains("// providers"), "{out}");
        let value = opencode_config::parse(&out).unwrap();
        assert_eq!(
            value["mcp"].as_object().unwrap().keys().collect::<Vec<_>>(),
            ["timeout", "servers"]
        );
        assert_eq!(
            value["mcp"]["servers"]
                .as_object()
                .unwrap()
                .keys()
                .collect::<Vec<_>>(),
            ["current", "old"]
        );
    }

    #[test]
    fn opencode_refuses_a_servers_key_that_is_a_server() {
        let text = r#"{"mcp": {"servers": {"type": "local", "command": ["x"]}}}"#;
        let view = read_view(McpAppType::OpenCode, text).unwrap();
        assert_eq!(view.container_invalid.as_deref(), Some("mcp.servers"));
        let mut store = open(McpAppType::OpenCode, text);
        assert!(store
            .create("a", &fields(json!({"type": "local", "command": ["a"]})))
            .is_err());
        assert_eq!(store.finish(), text);
    }

    #[test]
    fn a_root_list_of_names_is_edited_in_place() {
        let text = "{\n  \"mcpServers\": { \"a\": { \"command\": \"a\" } },\n  \"disabledMcpServers\": [\"b\"] // off\n}\n";
        let view = read_view(McpAppType::CodeBuddy, text).unwrap();
        assert_eq!(view.disabled_names, BTreeSet::from(["b".to_string()]));

        let mut store = open(McpAppType::CodeBuddy, text);
        assert!(store.root_list_contains("disabledMcpServers", "b"));
        assert!(!store
            .set_root_list("disabledMcpServers", "b", true)
            .unwrap());
        assert!(store
            .set_root_list("disabledMcpServers", "a", true)
            .unwrap());
        assert!(store
            .set_root_list("disabledMcpServers", "b", false)
            .unwrap());
        let out = store.finish();
        assert!(out.contains("// off"), "{out}");
        assert_eq!(
            opencode_config::parse(&out).unwrap()["disabledMcpServers"],
            json!(["a"])
        );

        // No list yet: it is made.
        let mut store = open(McpAppType::CodeBuddy, "{}");
        assert!(store
            .set_root_list("disabledMcpServers", "a", true)
            .unwrap());
        assert_eq!(
            opencode_config::parse(&store.finish()).unwrap(),
            json!({"disabledMcpServers": ["a"]})
        );
    }

    /// JSON lets a key be there twice. A reader ends up with the last one, a
    /// lookup in the CST finds the first: the store says so rather than edit
    /// either.
    #[test]
    fn a_key_that_is_there_twice_is_reported_not_picked() {
        // The server's own name.
        let text = r#"{"mcpServers": {"x": {"command": "old"}, "y": {"command": "y"}, "x": {"command": "active"}}}"#;
        let store = open(McpAppType::ClaudeCode, text);
        let x = store.get("x").unwrap();
        assert_eq!(x.value, json!({"command": "active"}), "what a reader sees");
        assert_eq!(x.duplicate, Some(DuplicateKey::Entry));
        assert_eq!(store.get("y").unwrap().duplicate, None);
        assert_eq!(store.duplicate_container(), None);

        // The listing is marked with the store's own answers.
        let mut view = read_view(McpAppType::ClaudeCode, text).unwrap();
        assert!(
            view.entries.iter().all(|entry| entry.duplicate.is_none()),
            "a plain read does not look"
        );
        mark_duplicates(McpAppType::ClaudeCode, text, &mut view);
        let marked: Vec<(&str, Option<&DuplicateKey>)> = view
            .entries
            .iter()
            .map(|entry| (entry.key.as_str(), entry.duplicate.as_ref()))
            .collect();
        assert_eq!(marked, [("x", Some(&DuplicateKey::Entry)), ("y", None)]);
        assert_eq!(view.entries[0].value, json!({"command": "active"}));

        // A key inside the entry, at any depth.
        for (entry, path) in [
            (
                r#"{"command": "x", "disabled": true, "disabled": false}"#,
                "disabled",
            ),
            (r#"{"command": "x", "env": {"K": "a", "K": "b"}}"#, "env.K"),
            (
                r#"{"url": "https://x.test", "oauth": [{"scope": "a", "scope": "b"}]}"#,
                "oauth.0.scope",
            ),
        ] {
            let text = format!(r#"{{"mcpServers": {{"x": {entry}}}}}"#);
            let store = open(McpAppType::Cline, &text);
            assert_eq!(
                store.get("x").unwrap().duplicate,
                Some(DuplicateKey::Field(path.to_string())),
                "{entry}"
            );
        }
        // The same name in two different objects is no repeat.
        let store = open(
            McpAppType::Cline,
            r#"{"mcpServers": {"x": {"command": "x", "env": {"command": "y"}}, "command": {"command": "z"}}}"#,
        );
        assert_eq!(store.get("x").unwrap().duplicate, None);

        // OpenCode's older location is looked at the same way.
        let store = open(
            McpAppType::OpenCode,
            r#"{"mcp": {"old": {"type": "local", "command": ["a"]}, "old": {"type": "local", "command": ["b"]}}}"#,
        );
        let old = store.get("old").unwrap();
        assert!(old.legacy);
        assert_eq!(old.duplicate, Some(DuplicateKey::Entry));
    }

    #[test]
    fn a_container_that_is_there_twice_is_named() {
        let cases: &[(McpAppType, &str, Option<&str>)] = &[
            (
                McpAppType::Gemini,
                r#"{"mcpServers": {"a": {"command": "a"}}, "mcpServers": {"b": {"command": "b"}}}"#,
                Some("mcpServers"),
            ),
            (
                McpAppType::Antigravity,
                r#"{"mcpServers": {}, "mcpServers": {}}"#,
                Some("mcpServers"),
            ),
            (
                McpAppType::OpenCode,
                r#"{"mcp": {"servers": {}}, "mcp": {"servers": {}}}"#,
                Some("mcp"),
            ),
            (
                McpAppType::OpenCode,
                r#"{"mcp": {"servers": {}, "servers": {}}}"#,
                Some("mcp.servers"),
            ),
            (
                McpAppType::CodeBuddy,
                r#"{"mcpServers": {}, "disabledMcpServers": ["a"], "disabledMcpServers": []}"#,
                Some("disabledMcpServers"),
            ),
            // Keys codeg neither reads nor writes may repeat.
            (
                McpAppType::Gemini,
                r#"{"theme": "a", "theme": "b", "mcpServers": {}}"#,
                None,
            ),
            // Not this agent's list.
            (
                McpAppType::Gemini,
                r#"{"disabledMcpServers": [], "disabledMcpServers": []}"#,
                None,
            ),
        ];
        for (app, text, expected) in cases {
            let store = open(*app, text);
            assert_eq!(
                store.duplicate_container().as_deref(),
                *expected,
                "{app:?}: {text}"
            );
        }

        // What is listed is the last container, as a reader has it.
        let text = cases[0].1;
        let mut view = read_view(McpAppType::Gemini, text).unwrap();
        mark_duplicates(McpAppType::Gemini, text, &mut view);
        assert_eq!(view.duplicate_container.as_deref(), Some("mcpServers"));
        assert_eq!(
            view.entries
                .iter()
                .map(|entry| entry.key.as_str())
                .collect::<Vec<_>>(),
            ["b"]
        );
    }

    /// Antigravity's loader takes a root `mcpServers` for the server map. In
    /// a bare map a server of that name would become the map, and the
    /// servers beside it would stop being servers.
    #[test]
    fn antigravitys_container_name_is_no_server_name_in_a_bare_map() {
        let bare = open(McpAppType::Antigravity, r#"{"keep": {"command": "keep"}}"#);
        assert!(bare.is_structural_key("mcpServers"));
        assert!(!bare.is_structural_key("other"));
        // In the wrapper — and in a document with nothing in it yet, which
        // gets the wrapper — it is a server's name like any other.
        for text in [r#"{"mcpServers": {"keep": {"command": "keep"}}}"#, "{}", ""] {
            assert!(
                !open(McpAppType::Antigravity, text).is_structural_key("mcpServers"),
                "{text:?}"
            );
        }
        // Every other agent keeps its servers under a key of their own.
        for app in [
            McpAppType::ClaudeCode,
            McpAppType::OpenCode,
            McpAppType::Cursor,
            McpAppType::CodeBuddy,
        ] {
            let store = open(app, r#"{"keep": {"command": "keep"}}"#);
            for key in ["mcpServers", "mcp", "servers", "disabledMcpServers"] {
                assert!(!store.is_structural_key(key), "{app:?}: {key}");
            }
        }
    }

    /// An operation on an OpenCode server reaches both of its locations —
    /// `mcp.servers.<name>` and 1.x's `mcp.<name>` — so both are looked at,
    /// whether or not the current one has the name.
    #[test]
    fn opencodes_older_location_is_looked_at_whether_or_not_the_current_one_has_the_name() {
        let local = |command: &str| format!(r#"{{"type": "local", "command": ["{command}"]}}"#);
        let doc = |native: Option<&str>, legacy: &[String]| -> String {
            let mut mcp: Vec<String> = Vec::new();
            if let Some(native) = native {
                mcp.push(format!(r#""servers": {{"x": {native}}}"#));
            }
            mcp.extend(legacy.iter().map(|entry| format!(r#""x": {entry}"#)));
            format!(r#"{{"mcp": {{{}}}}}"#, mcp.join(", "))
        };
        let get = |text: &str| open(McpAppType::OpenCode, text).get("x");

        // The current entry is there once, the older one twice: the review's
        // case, where a remove reached the current one and the first older
        // one, and left the second in force.
        let text = doc(Some(&local("active")), &[local("old1"), local("old2")]);
        let x = get(&text).unwrap();
        assert!(!x.legacy);
        assert_eq!(x.value, json!({"type": "local", "command": ["active"]}));
        assert_eq!(x.duplicate, Some(DuplicateKey::Entry));
        // And the listing says so on the one entry it shows.
        let mut view = read_view(McpAppType::OpenCode, &text).unwrap();
        mark_duplicates(McpAppType::OpenCode, &text, &mut view);
        assert_eq!(view.entries.len(), 1);
        assert_eq!(view.entries[0].duplicate, Some(DuplicateKey::Entry));

        // The older one twice, and no current one: what is listed is the
        // last, as OpenCode has it.
        let text = doc(None, &[local("old1"), local("old2")]);
        let x = get(&text).unwrap();
        assert!(x.legacy);
        assert_eq!(x.value, json!({"type": "local", "command": ["old2"]}));
        assert_eq!(x.duplicate, Some(DuplicateKey::Entry));

        // A field twice inside the older one, with or without a current one.
        let twice = r#"{"type": "local", "command": ["o"], "enabled": true, "enabled": false}"#;
        for native in [Some(local("active")), None] {
            let text = doc(native.as_deref(), &[twice.to_string()]);
            assert_eq!(
                get(&text).unwrap().duplicate,
                Some(DuplicateKey::Field("enabled".to_string())),
                "{text}"
            );
        }

        // What OpenCode does not take for a server is nothing an operation
        // reaches: twice, it stops nothing.
        let not_a_server = r#"{"enabled": false}"#.to_string();
        let text = doc(
            Some(&local("active")),
            &[not_a_server.clone(), not_a_server.clone()],
        );
        assert_eq!(get(&text).unwrap().duplicate, None);
        // The last of two is no server: there is no server `x` to edit at
        // all — a new one goes into `mcp.servers`, which nothing else has.
        let text = doc(None, &[local("old"), not_a_server]);
        assert_eq!(get(&text), None);

        // `servers` and `timeout` are never a server's name.
        let text = r#"{"mcp": {"timeout": 1, "timeout": 2, "servers": {"timeout": {"type": "local", "command": ["t"]}}}}"#;
        assert_eq!(
            open(McpAppType::OpenCode, text)
                .get("timeout")
                .unwrap()
                .duplicate,
            None
        );
    }
}
