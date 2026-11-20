//! The agents whose servers live in a TOML document: Codex and TRAE CLI
//! (`[mcp_servers.<name>]` in Codex's schema) and Grok (the same table, its
//! own keys).
//!
//! Edited through `toml_edit`, touching the `mcp_servers` tables and nothing
//! else, so the rest of the file — comments, key order, the other tables —
//! comes out as it went in. The one key outside them the engine ever changes
//! is Grok's `disabled_mcp_servers`, a list of names that turns servers off:
//! a name is taken out of it when that server is turned on.
//!
//! Codex's file may also hold `[mcp.servers.<name>]` tables, which older
//! codeg releases wrote and Codex never read. They are listed (codeg sends
//! Codex its servers itself) and moved to `mcp_servers` the first time one is
//! edited.

use std::collections::BTreeSet;

use serde_json::{Map, Value};
use toml_edit::{Document, InlineTable, Item, Table, TableLike};

use crate::commands::mcp::McpAppType;

use super::dialect::FieldOp;
use super::model::{codes, McpIssue};
use super::store::{split_bom, with_bom, EntryStore, RawEntry, ServersView};

const SERVERS: &str = "mcp_servers";

fn has_legacy_location(app: McpAppType) -> bool {
    app == McpAppType::Codex
}

fn root_list_key(app: McpAppType) -> Option<&'static str> {
    super::agents::spec(app).disable.root_list
}

fn value_to_json(value: &toml_edit::Value) -> Value {
    match value {
        toml_edit::Value::String(text) => Value::String(text.value().clone()),
        toml_edit::Value::Integer(number) => Value::Number((*number.value()).into()),
        toml_edit::Value::Float(number) => serde_json::Number::from_f64(*number.value())
            .map(Value::Number)
            .unwrap_or(Value::Null),
        toml_edit::Value::Boolean(flag) => Value::Bool(*flag.value()),
        toml_edit::Value::Datetime(when) => Value::String(when.value().to_string()),
        toml_edit::Value::Array(items) => Value::Array(items.iter().map(value_to_json).collect()),
        toml_edit::Value::InlineTable(table) => Value::Object(
            table
                .iter()
                .map(|(key, value)| (key.to_string(), value_to_json(value)))
                .collect(),
        ),
    }
}

pub(crate) fn item_to_json(item: &Item) -> Value {
    match item {
        Item::None => Value::Null,
        Item::Value(value) => value_to_json(value),
        Item::Table(table) => Value::Object(
            table
                .iter()
                .map(|(key, item)| (key.to_string(), item_to_json(item)))
                .collect(),
        ),
        Item::ArrayOfTables(tables) => Value::Array(
            tables
                .iter()
                .map(|table| {
                    Value::Object(
                        table
                            .iter()
                            .map(|(key, item)| (key.to_string(), item_to_json(item)))
                            .collect::<Map<String, Value>>(),
                    )
                })
                .collect(),
        ),
    }
}

fn json_to_value(value: &Value) -> Option<toml_edit::Value> {
    Some(match value {
        Value::Null => return None,
        Value::Bool(flag) => (*flag).into(),
        Value::Number(number) => match number.as_i64() {
            Some(integer) => integer.into(),
            None => number.as_f64()?.into(),
        },
        Value::String(text) => text.as_str().into(),
        Value::Array(items) => {
            let mut array = toml_edit::Array::new();
            for item in items.iter().filter_map(json_to_value) {
                array.push(item);
            }
            toml_edit::Value::Array(array)
        }
        Value::Object(map) => {
            let mut table = InlineTable::new();
            for (key, item) in map {
                if let Some(item) = json_to_value(item) {
                    table.insert(key, item);
                }
            }
            toml_edit::Value::InlineTable(table)
        }
    })
}

/// A JSON value as a TOML item: a map becomes a table of its own
/// (`[mcp_servers.<name>.env]`), which is how the agents themselves write
/// one.
fn json_to_item(value: &Value) -> Item {
    match value {
        Value::Object(map) => {
            let mut table = Table::new();
            for (key, item) in map {
                let item = json_to_item(item);
                if !item.is_none() {
                    table.insert(key, item);
                }
            }
            Item::Table(table)
        }
        other => json_to_value(other).map(Item::Value).unwrap_or(Item::None),
    }
}

fn entry_table(fields: &[(String, Value)]) -> Item {
    let mut table = Table::new();
    for (key, value) in fields {
        let item = json_to_item(value);
        if !item.is_none() {
            table.insert(key, item);
        }
    }
    Item::Table(table)
}

/// Set `key`, keeping the spacing and the comment around a value that is
/// replaced by another value.
fn set_item(entry: &mut dyn TableLike, key: &str, value: &Value) {
    let in_place = match (entry.get_mut(key), json_to_value(value)) {
        (Some(Item::Value(existing)), Some(mut fresh)) if !value.is_object() => {
            *fresh.decor_mut() = existing.decor().clone();
            *existing = fresh;
            true
        }
        _ => false,
    };
    if !in_place {
        let item = json_to_item(value);
        if !item.is_none() {
            entry.insert(key, item);
        }
    }
}

fn item_reads_as(item: &Item, text: &str) -> bool {
    match item_to_json(item) {
        Value::String(current) => current == text,
        Value::Number(number) => number.to_string() == text,
        Value::Bool(flag) => flag.to_string() == text,
        _ => false,
    }
}

fn apply_ops(entry: &mut dyn TableLike, ops: &[FieldOp]) {
    for op in ops {
        match op {
            FieldOp::Set(key, value) => set_item(entry, key, value),
            FieldOp::Remove(key) => {
                entry.remove(key);
            }
            FieldOp::SyncMap(key, wanted) => {
                match entry.get_mut(key).and_then(Item::as_table_like_mut) {
                    Some(map) => {
                        let stale: Vec<String> = map
                            .iter()
                            .map(|(name, _)| name.to_string())
                            .filter(|name| !wanted.contains_key(name))
                            .collect();
                        for name in stale {
                            map.remove(&name);
                        }
                        for (name, text) in wanted {
                            // A value that already reads as this text stays
                            // as it is written.
                            let same = map.get(name).is_some_and(|item| item_reads_as(item, text));
                            if !same {
                                set_item(map, name, &Value::String(text.clone()));
                            }
                        }
                    }
                    None => {
                        let fresh: Map<String, Value> = wanted
                            .iter()
                            .map(|(name, text)| (name.clone(), Value::String(text.clone())))
                            .collect();
                        entry.insert(key, json_to_item(&Value::Object(fresh)));
                    }
                }
            }
        }
    }
}

fn parse(text: &str) -> Result<Document, McpIssue> {
    text.parse::<Document>()
        .map_err(|e| McpIssue::new(codes::INVALID_TOML).detail(e.to_string()))
}

fn legacy_servers(doc: &Document) -> Option<&dyn TableLike> {
    doc.get("mcp")?
        .as_table_like()?
        .get("servers")?
        .as_table_like()
}

pub(crate) fn read_view(app: McpAppType, text: &str) -> Result<ServersView, McpIssue> {
    let (_, body) = split_bom(text);
    let doc = parse(body)?;
    let mut view = ServersView::default();
    match doc.get(SERVERS) {
        None => {}
        Some(item) => match item.as_table_like() {
            Some(servers) => view
                .entries
                .extend(servers.iter().map(|(key, item)| RawEntry {
                    key: key.to_string(),
                    value: item_to_json(item),
                    legacy: false,
                    duplicate: None,
                })),
            None => view.container_invalid = Some(SERVERS.to_string()),
        },
    }
    if has_legacy_location(app) {
        if let Some(legacy) = legacy_servers(&doc) {
            let native: BTreeSet<String> =
                view.entries.iter().map(|entry| entry.key.clone()).collect();
            view.entries
                .extend(legacy.iter().filter(|(key, _)| !native.contains(*key)).map(
                    |(key, item)| RawEntry {
                        key: key.to_string(),
                        value: item_to_json(item),
                        legacy: true,
                        duplicate: None,
                    },
                ));
        }
    }
    if let Some(list) = root_list_key(app) {
        if let Some(names) = doc.get(list).and_then(Item::as_array) {
            view.disabled_names = names
                .iter()
                .filter_map(toml_edit::Value::as_str)
                .map(str::to_string)
                .collect();
        }
    }
    Ok(view)
}

pub(crate) struct TomlStore {
    app: McpAppType,
    doc: Document,
    bom: bool,
    original: String,
    dirty: bool,
}

impl TomlStore {
    pub(crate) fn open(app: McpAppType, text: &str) -> Result<Self, McpIssue> {
        let (bom, body) = split_bom(text);
        Ok(Self {
            app,
            doc: parse(body)?,
            bom,
            original: text.to_string(),
            dirty: false,
        })
    }

    fn servers(&self) -> Option<&dyn TableLike> {
        self.doc.get(SERVERS)?.as_table_like()
    }

    fn servers_mut(&mut self) -> Option<&mut dyn TableLike> {
        self.doc.get_mut(SERVERS)?.as_table_like_mut()
    }

    fn servers_or_create(&mut self) -> Result<&mut dyn TableLike, String> {
        if self.doc.get(SERVERS).is_none() {
            // Implicit: only `[mcp_servers.<name>]` headers are written, the
            // way the agents write them.
            let mut table = Table::new();
            table.set_implicit(true);
            self.doc.as_table_mut().insert(SERVERS, Item::Table(table));
        }
        self.servers_mut()
            .ok_or_else(|| format!("`{SERVERS}` is not a table of servers"))
    }

    fn legacy_mut(&mut self) -> Option<&mut dyn TableLike> {
        if !has_legacy_location(self.app) {
            return None;
        }
        self.doc
            .get_mut("mcp")?
            .as_table_like_mut()?
            .get_mut("servers")?
            .as_table_like_mut()
    }

    /// Take the entry out of `[mcp.servers]`, and the tables themselves once
    /// they are empty.
    fn take_legacy(&mut self, key: &str) -> Option<Item> {
        let taken = self.legacy_mut()?.remove(key)?;
        let servers_empty = self.legacy_mut().is_some_and(|servers| servers.is_empty());
        if servers_empty {
            if let Some(mcp) = self.doc.get_mut("mcp").and_then(Item::as_table_like_mut) {
                mcp.remove("servers");
                if mcp.is_empty() {
                    self.doc.as_table_mut().remove("mcp");
                }
            }
        }
        Some(taken)
    }
}

impl EntryStore for TomlStore {
    fn get(&self, key: &str) -> Option<RawEntry> {
        if let Some(item) = self.servers().and_then(|servers| servers.get(key)) {
            return Some(RawEntry {
                key: key.to_string(),
                value: item_to_json(item),
                legacy: false,
                duplicate: None,
            });
        }
        if !has_legacy_location(self.app) {
            return None;
        }
        legacy_servers(&self.doc)?.get(key).map(|item| RawEntry {
            key: key.to_string(),
            value: item_to_json(item),
            legacy: true,
            duplicate: None,
        })
    }

    fn create(&mut self, key: &str, fields: &[(String, Value)]) -> Result<(), String> {
        self.servers_or_create()?.insert(key, entry_table(fields));
        self.dirty = true;
        Ok(())
    }

    fn patch(&mut self, key: &str, ops: &[FieldOp]) -> Result<(), String> {
        if ops.is_empty() {
            return Ok(());
        }
        let entry = self
            .servers_mut()
            .and_then(|servers| servers.get_mut(key))
            .and_then(Item::as_table_like_mut)
            .ok_or_else(|| format!("`{SERVERS}.{key}` is not a table"))?;
        apply_ops(entry, ops);
        self.dirty = true;
        Ok(())
    }

    fn replace(&mut self, key: &str, fields: &[(String, Value)]) -> Result<(), String> {
        self.servers_or_create()?.insert(key, entry_table(fields));
        self.dirty = true;
        Ok(())
    }

    fn remove(&mut self, key: &str) -> Result<bool, String> {
        let native = self
            .servers_mut()
            .and_then(|servers| servers.remove(key))
            .is_some();
        let legacy = self.take_legacy(key).is_some();
        self.dirty |= native || legacy;
        Ok(native || legacy)
    }

    fn rename(&mut self, from: &str, to: &str) -> Result<(), String> {
        let servers = self
            .servers_mut()
            .ok_or_else(|| format!("`{SERVERS}` is not a table of servers"))?;
        let item = servers
            .remove(from)
            .ok_or_else(|| format!("`{SERVERS}.{from}` is not there"))?;
        servers.insert(to, item);
        self.dirty = true;
        Ok(())
    }

    fn promote(&mut self, key: &str) -> Result<(), String> {
        if self
            .servers()
            .is_some_and(|servers| servers.contains_key(key))
        {
            return Ok(());
        }
        let Some(item) = self.take_legacy(key) else {
            return Ok(());
        };
        self.servers_or_create()?.insert(key, item);
        self.dirty = true;
        Ok(())
    }

    fn root_list_contains(&self, list: &str, name: &str) -> bool {
        self.doc
            .get(list)
            .and_then(Item::as_array)
            .is_some_and(|names| names.iter().any(|item| item.as_str() == Some(name)))
    }

    fn set_root_list(&mut self, list: &str, name: &str, present: bool) -> Result<bool, String> {
        if self.root_list_contains(list, name) == present {
            return Ok(false);
        }
        if present {
            if self.doc.get(list).is_none() {
                self.doc
                    .as_table_mut()
                    .insert(list, Item::Value(toml_edit::Array::new().into()));
            }
            self.doc
                .get_mut(list)
                .and_then(Item::as_array_mut)
                .ok_or_else(|| format!("`{list}` is not a list"))?
                .push(name);
        } else if let Some(names) = self.doc.get_mut(list).and_then(Item::as_array_mut) {
            names.retain(|item| item.as_str() != Some(name));
        }
        self.dirty = true;
        Ok(true)
    }

    fn finish(self: Box<Self>) -> String {
        if !self.dirty {
            return self.original;
        }
        with_bom(self.bom, self.doc.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::collections::BTreeMap;

    fn open(app: McpAppType, text: &str) -> Box<dyn EntryStore> {
        Box::new(TomlStore::open(app, text).expect("opens"))
    }

    fn fields(value: Value) -> Vec<(String, Value)> {
        value
            .as_object()
            .unwrap()
            .iter()
            .map(|(key, value)| (key.clone(), value.clone()))
            .collect()
    }

    const CODEX: &str = r#"# my codex config
model = "gpt-5.5" # the default
model_provider = "codeg"

[model_providers.codeg]
name = "codeg"
base_url = "https://example.test/v1"

# browser automation
[mcp_servers.playwright]
command = "npx" # the launcher
args = ["-y", "@playwright/mcp"]
startup_timeout_sec = 20

[mcp_servers.playwright.env]
DEBUG = "1"   # verbose
PORT = 8080

[mcp_servers.linear]
url = "https://mcp.linear.app/mcp"
bearer_token_env_var = "LINEAR_TOKEN"
enabled = false

[profiles.fast]
model = "gpt-5.5-mini"
"#;

    #[test]
    fn an_edit_keeps_every_other_byte() {
        let mut store = open(McpAppType::Codex, CODEX);
        store
            .patch(
                "playwright",
                &[FieldOp::Set("command".into(), json!("pnpm"))],
            )
            .unwrap();
        assert_eq!(
            store.finish(),
            CODEX.replace(
                "command = \"npx\" # the launcher",
                "command = \"pnpm\" # the launcher"
            )
        );
    }

    #[test]
    fn an_untouched_document_comes_back_as_it_was() {
        let mut store = open(McpAppType::Codex, CODEX);
        store.patch("playwright", &[]).unwrap();
        assert!(!store.remove("absent").unwrap());
        assert_eq!(store.finish(), CODEX);
    }

    #[test]
    fn a_table_of_strings_is_synced_key_by_key() {
        let mut store = open(McpAppType::Codex, CODEX);
        let wanted = BTreeMap::from([
            ("PORT".to_string(), "8080".to_string()),
            ("NEW".to_string(), "n".to_string()),
        ]);
        store
            .patch("playwright", &[FieldOp::SyncMap("env".into(), wanted)])
            .unwrap();
        let out = store.finish();
        assert!(out.contains("PORT = 8080"), "{out}");
        assert!(!out.contains("DEBUG"), "{out}");
        assert!(out.contains("NEW = \"n\""), "{out}");
        assert!(out.contains("# my codex config"), "{out}");
        assert!(out.contains("# browser automation"), "{out}");
        let parsed: toml::Table = out.parse().unwrap();
        assert_eq!(parsed["model"].as_str(), Some("gpt-5.5"));
        assert_eq!(
            parsed["profiles"]["fast"]["model"].as_str(),
            Some("gpt-5.5-mini")
        );
    }

    #[test]
    fn entries_are_created_after_the_others_and_renamed_and_removed_in_place() {
        let mut store = open(McpAppType::Codex, CODEX);
        store.rename("linear", "linear-app").unwrap();
        store
            .create(
                "fresh",
                &fields(json!({"command": "uvx", "args": ["server"], "env": {"K": "v"}})),
            )
            .unwrap();
        let out = store.finish();
        let playwright = out.find("[mcp_servers.playwright]").unwrap();
        let renamed = out.find("[mcp_servers.linear-app]").unwrap();
        let fresh = out.find("[mcp_servers.fresh]").unwrap();
        let fresh_env = out.find("[mcp_servers.fresh.env]").unwrap();
        let profiles = out.find("[profiles.fast]").unwrap();
        assert!(playwright < renamed, "{out}");
        assert!(renamed < fresh && fresh < fresh_env, "{out}");
        assert!(
            fresh_env < profiles,
            "a new server goes with the others: {out}"
        );
        assert!(!out.contains("[mcp_servers.linear]"), "{out}");
        assert!(out.contains("# the default"), "{out}");
        let parsed: toml::Table = out.parse().unwrap();
        assert_eq!(
            parsed["mcp_servers"]["linear-app"]["bearer_token_env_var"].as_str(),
            Some("LINEAR_TOKEN")
        );
        assert_eq!(
            parsed["mcp_servers"]["fresh"]["env"]["K"].as_str(),
            Some("v")
        );

        let mut store = open(McpAppType::Codex, &out);
        assert!(store.remove("playwright").unwrap());
        let out = store.finish();
        assert!(!out.contains("playwright"), "{out}");
        assert!(
            !out.contains("# browser automation"),
            "its comment goes with it: {out}"
        );
        assert!(out.contains("[model_providers.codeg]"), "{out}");
    }

    #[test]
    fn a_file_with_no_servers_yet_gets_only_their_tables() {
        let mut store = open(McpAppType::Grok, "[ui]\ntheme = \"dark\"\n");
        store
            .create("x", &fields(json!({"command": "x", "args": ["a"]})))
            .unwrap();
        assert_eq!(
            store.finish(),
            "[ui]\ntheme = \"dark\"\n\n[mcp_servers.x]\ncommand = \"x\"\nargs = [\"a\"]\n"
        );

        let mut store = open(McpAppType::Grok, "");
        store.create("x", &fields(json!({"command": "x"}))).unwrap();
        assert_eq!(store.finish(), "[mcp_servers.x]\ncommand = \"x\"\n");
    }

    #[test]
    fn inline_tables_are_edited_as_they_are() {
        let text = "mcp_servers = { a = { command = \"a\" } }\n";
        let view = read_view(McpAppType::Codex, text).unwrap();
        assert_eq!(view.entries[0].value, json!({"command": "a"}));
        let mut store = open(McpAppType::Codex, text);
        store
            .patch(
                "a",
                &[
                    FieldOp::Set("command".into(), json!("b")),
                    FieldOp::Set("args".into(), json!(["x"])),
                ],
            )
            .unwrap();
        let out = store.finish();
        let parsed: toml::Table = out.parse().unwrap();
        assert_eq!(parsed["mcp_servers"]["a"]["command"].as_str(), Some("b"));
        assert_eq!(
            parsed["mcp_servers"]["a"]["args"].as_array().map(Vec::len),
            Some(1)
        );
    }

    #[test]
    fn a_container_that_is_not_a_table_is_refused_not_replaced() {
        let text = "mcp_servers = \"oops\"\n";
        let view = read_view(McpAppType::Codex, text).unwrap();
        assert_eq!(view.container_invalid.as_deref(), Some("mcp_servers"));
        let mut store = open(McpAppType::Codex, text);
        assert!(store.create("x", &fields(json!({"command": "x"}))).is_err());
        assert_eq!(store.finish(), text);
        assert_eq!(
            read_view(McpAppType::Codex, "model = ").unwrap_err().code,
            codes::INVALID_TOML
        );
    }

    #[test]
    fn codexs_old_location_is_listed_and_moved_on_edit() {
        let text = r#"[mcp_servers.current]
command = "cur"

# from an old codeg
[mcp.servers.old]
command = "old"
tool_timeout_sec = 9

[mcp.servers.current]
command = "shadowed"
"#;
        let view = read_view(McpAppType::Codex, text).unwrap();
        let listed: Vec<(&str, bool)> = view
            .entries
            .iter()
            .map(|entry| (entry.key.as_str(), entry.legacy))
            .collect();
        assert_eq!(listed, [("current", false), ("old", true)]);
        // Only Codex has the old location.
        assert_eq!(read_view(McpAppType::Trae, text).unwrap().entries.len(), 1);

        let mut store = open(McpAppType::Codex, text);
        assert!(store.get("old").unwrap().legacy);
        store.promote("old").unwrap();
        assert!(!store.get("old").unwrap().legacy);
        // Removing a name takes both locations of it.
        assert!(store.remove("current").unwrap());
        let out = store.finish();
        let parsed: toml::Table = out.parse().unwrap();
        assert!(parsed.get("mcp").is_none(), "{out}");
        assert_eq!(
            parsed["mcp_servers"]["old"]["tool_timeout_sec"].as_integer(),
            Some(9)
        );
        assert!(parsed["mcp_servers"].get("current").is_none());
        assert!(out.contains("# from an old codeg"), "{out}");
    }

    #[test]
    fn groks_list_of_names_is_edited_in_place() {
        let text =
            "disabled_mcp_servers = [\"a\", \"b\"] # off\n\n[mcp_servers.a]\ncommand = \"a\"\n";
        let view = read_view(McpAppType::Grok, text).unwrap();
        assert_eq!(
            view.disabled_names,
            BTreeSet::from(["a".to_string(), "b".to_string()])
        );
        // Codex has no such list.
        assert!(read_view(McpAppType::Codex, text)
            .unwrap()
            .disabled_names
            .is_empty());

        let mut store = open(McpAppType::Grok, text);
        assert!(store.root_list_contains("disabled_mcp_servers", "a"));
        assert!(store
            .set_root_list("disabled_mcp_servers", "a", false)
            .unwrap());
        assert!(!store
            .set_root_list("disabled_mcp_servers", "a", false)
            .unwrap());
        let out = store.finish();
        assert!(out.contains("# off"), "{out}");
        let parsed: toml::Table = out.parse().unwrap();
        assert_eq!(
            parsed["disabled_mcp_servers"].as_array().map(Vec::len),
            Some(1)
        );
    }

    /// TOML has no repeated keys: a file with one does not parse, for the
    /// listing and for an edit alike. There is never a first and a last
    /// occurrence to tell apart, as there is in JSON (see `json_doc`).
    #[test]
    fn a_key_that_is_there_twice_is_a_file_that_does_not_parse() {
        for text in [
            "[mcp_servers.x]\ncommand = \"old\"\n\n[mcp_servers.x]\ncommand = \"active\"\n",
            "[mcp_servers.x]\ncommand = \"x\"\nenabled = true\nenabled = false\n",
            "[mcp_servers.x]\ncommand = \"x\"\n\n[mcp_servers.x.env]\nK = \"a\"\nK = \"b\"\n",
            "disabled_mcp_servers = [\"x\"]\ndisabled_mcp_servers = []\n",
            "mcp_servers = { x = { command = \"a\" } }\n\n[mcp_servers.x]\ncommand = \"b\"\n",
        ] {
            for app in [McpAppType::Codex, McpAppType::Grok] {
                assert_eq!(
                    read_view(app, text).unwrap_err().code,
                    codes::INVALID_TOML,
                    "{text}"
                );
                assert_eq!(
                    TomlStore::open(app, text).err().map(|problem| problem.code),
                    Some(codes::INVALID_TOML.to_string()),
                    "{text}"
                );
            }
        }
    }
}
