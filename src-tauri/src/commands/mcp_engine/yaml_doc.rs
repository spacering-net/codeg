//! Hermes' `config.yaml`: servers under `mcp_servers`.
//!
//! There is no format-preserving YAML editor in the tree, so a change
//! re-serializes the document through `serde_yaml`: every key and value
//! survives, in order, but the comments and the layout do not. The inventory
//! says so ([`has_comments`]) and the page warns before the first save. A
//! document nothing changed in is handed back as it was read.
//!
//! **Two keys that are one name.** The parser refuses a key that is there
//! twice, but `1` and `"1"` are two keys to it — a number and a string — and
//! one name to codeg, which names a server (and reads a field) by the key's
//! text. Codeg would have to pick one of them, so, as with a JSON key that is
//! there twice (`json_doc`), it lists what is there and edits neither.

use std::collections::BTreeSet;

use serde_json::{Map, Value};
use serde_yaml::{Mapping, Value as Yaml};

use super::dialect::{self, FieldOp};
use super::model::{codes, McpIssue};
use super::store::{split_bom, with_bom, DuplicateKey, EntryStore, RawEntry, ServersView};

const SERVERS: &str = "mcp_servers";

fn parse(text: &str) -> Result<Mapping, McpIssue> {
    if text.trim().is_empty() {
        return Ok(Mapping::new());
    }
    match serde_yaml::from_str::<Yaml>(text) {
        Ok(Yaml::Mapping(root)) => Ok(root),
        // A document of nothing but comments.
        Ok(Yaml::Null) => Ok(Mapping::new()),
        Ok(_) => Err(McpIssue::new(codes::ROOT_NOT_OBJECT)),
        Err(e) => Err(McpIssue::new(codes::INVALID_YAML).detail(e.to_string())),
    }
}

/// A mapping key as the name of a server: Hermes takes the key's text.
fn key_text(key: &Yaml) -> Option<String> {
    match key {
        Yaml::String(text) => Some(text.clone()),
        Yaml::Number(number) => Some(number.to_string()),
        Yaml::Bool(flag) => Some(flag.to_string()),
        _ => None,
    }
}

/// The path of two keys of one mapping that read as the same text, anywhere
/// inside `value`: `env.1`, `headers.0.true`.
fn repeated_text_key_in(value: &Yaml) -> Option<String> {
    match value {
        Yaml::Mapping(map) => {
            let mut seen = BTreeSet::new();
            for key in map.keys() {
                if let Some(text) = key_text(key) {
                    if !seen.insert(text.clone()) {
                        return Some(text);
                    }
                }
            }
            map.iter().find_map(|(key, value)| {
                let inner = repeated_text_key_in(value)?;
                Some(format!("{}.{inner}", key_text(key)?))
            })
        }
        Yaml::Sequence(items) => items
            .iter()
            .enumerate()
            .find_map(|(index, item)| Some(format!("{index}.{}", repeated_text_key_in(item)?))),
        Yaml::Tagged(tagged) => repeated_text_key_in(&tagged.value),
        _ => None,
    }
}

/// Mark in `view` — read from this same `text` — the entries no operation is
/// carried out on (see the module docs), with the answers [`YamlStore`] gives
/// `mcp_apply`.
pub(crate) fn mark_duplicates(text: &str, view: &mut ServersView) {
    let Ok(store) = YamlStore::open(text) else {
        return;
    };
    for entry in &mut view.entries {
        entry.duplicate = store.duplicate_of(&entry.key);
    }
}

fn to_json(value: &Yaml) -> Value {
    serde_json::to_value(value).unwrap_or(Value::Null)
}

fn to_yaml(fields: &Map<String, Value>) -> Result<Yaml, String> {
    serde_yaml::to_value(fields).map_err(|e| e.to_string())
}

fn ordered(fields: &[(String, Value)]) -> Map<String, Value> {
    fields.iter().cloned().collect()
}

pub(crate) fn read_view(text: &str) -> Result<ServersView, McpIssue> {
    let (_, body) = split_bom(text);
    let root = parse(body)?;
    let mut view = ServersView::default();
    match root.get(SERVERS) {
        None | Some(Yaml::Null) => {}
        Some(Yaml::Mapping(servers)) => {
            view.entries
                .extend(servers.iter().filter_map(|(key, value)| {
                    Some(RawEntry {
                        key: key_text(key)?,
                        value: to_json(value),
                        legacy: false,
                        duplicate: None,
                    })
                }))
        }
        Some(_) => view.container_invalid = Some(SERVERS.to_string()),
    }
    Ok(view)
}

/// Whether the document has comments a save would drop: a `#` at the start
/// of a line or after whitespace, outside a quoted scalar. A `#` inside a
/// block scalar reads as one too — the warning errs on the side of being
/// shown.
pub(crate) fn has_comments(text: &str) -> bool {
    text.lines().any(|line| {
        let mut quote: Option<char> = None;
        let mut previous = ' ';
        for c in line.chars() {
            match quote {
                Some(open) => {
                    if c == open && !(open == '"' && previous == '\\') {
                        quote = None;
                    }
                }
                None => match c {
                    '#' if previous.is_whitespace() => return true,
                    '"' | '\'' => quote = Some(c),
                    _ => {}
                },
            }
            previous = c;
        }
        false
    })
}

pub(crate) struct YamlStore {
    root: Mapping,
    bom: bool,
    original: String,
    dirty: bool,
}

impl YamlStore {
    pub(crate) fn open(text: &str) -> Result<Self, McpIssue> {
        let (bom, body) = split_bom(text);
        Ok(Self {
            root: parse(body)?,
            bom,
            original: text.to_string(),
            dirty: false,
        })
    }

    fn servers(&self) -> Option<&Mapping> {
        self.root.get(SERVERS)?.as_mapping()
    }

    fn servers_mut(&mut self) -> Option<&mut Mapping> {
        self.root.get_mut(SERVERS)?.as_mapping_mut()
    }

    fn servers_or_create(&mut self) -> Result<&mut Mapping, String> {
        // `mcp_servers:` with nothing under it is a null: an empty section.
        if matches!(self.root.get(SERVERS), None | Some(Yaml::Null)) {
            self.root.insert(
                Yaml::String(SERVERS.to_string()),
                Yaml::Mapping(Mapping::new()),
            );
        }
        self.servers_mut()
            .ok_or_else(|| format!("`{SERVERS}` is not a mapping of servers"))
    }

    /// The key the entry named `key` is stored under.
    fn stored_key(&self, key: &str) -> Option<Yaml> {
        self.servers()?
            .keys()
            .find(|candidate| key_text(candidate).as_deref() == Some(key))
            .cloned()
    }

    /// What makes `key` a name no operation is carried out on: two keys of
    /// `mcp_servers` read as it, or two keys inside its entry read alike.
    fn duplicate_of(&self, key: &str) -> Option<DuplicateKey> {
        let servers = self.servers()?;
        let mut stored = servers
            .iter()
            .filter(|(candidate, _)| key_text(candidate).as_deref() == Some(key));
        let (_, value) = stored.next()?;
        if stored.next().is_some() {
            return Some(DuplicateKey::Entry);
        }
        repeated_text_key_in(value).map(DuplicateKey::Field)
    }
}

impl EntryStore for YamlStore {
    fn get(&self, key: &str) -> Option<RawEntry> {
        let stored = self.stored_key(key)?;
        Some(RawEntry {
            key: key.to_string(),
            value: to_json(self.servers()?.get(&stored)?),
            legacy: false,
            duplicate: self.duplicate_of(key),
        })
    }

    fn create(&mut self, key: &str, fields: &[(String, Value)]) -> Result<(), String> {
        let entry = to_yaml(&ordered(fields))?;
        self.servers_or_create()?
            .insert(Yaml::String(key.to_string()), entry);
        self.dirty = true;
        Ok(())
    }

    fn patch(&mut self, key: &str, ops: &[FieldOp]) -> Result<(), String> {
        if ops.is_empty() {
            return Ok(());
        }
        let stored = self
            .stored_key(key)
            .ok_or_else(|| format!("`{SERVERS}.{key}` is not there"))?;
        let entry = self
            .servers_mut()
            .and_then(|servers| servers.get_mut(&stored))
            .ok_or_else(|| format!("`{SERVERS}.{key}` is not there"))?;
        let Value::Object(mut fields) = to_json(entry) else {
            return Err(format!("`{SERVERS}.{key}` is not a mapping"));
        };
        dialect::apply_ops_to_map(&mut fields, ops);
        *entry = to_yaml(&fields)?;
        self.dirty = true;
        Ok(())
    }

    fn replace(&mut self, key: &str, fields: &[(String, Value)]) -> Result<(), String> {
        let stored = self
            .stored_key(key)
            .unwrap_or_else(|| Yaml::String(key.to_string()));
        let entry = to_yaml(&ordered(fields))?;
        // In place when the key is there: `insert` keeps its position.
        self.servers_or_create()?.insert(stored, entry);
        self.dirty = true;
        Ok(())
    }

    fn remove(&mut self, key: &str) -> Result<bool, String> {
        let Some(stored) = self.stored_key(key) else {
            return Ok(false);
        };
        let removed = self
            .servers_mut()
            .and_then(|servers| servers.shift_remove(&stored))
            .is_some();
        self.dirty |= removed;
        Ok(removed)
    }

    fn rename(&mut self, from: &str, to: &str) -> Result<(), String> {
        let stored = self
            .stored_key(from)
            .ok_or_else(|| format!("`{SERVERS}.{from}` is not there"))?;
        let servers = self
            .servers_mut()
            .ok_or_else(|| format!("`{SERVERS}` is not a mapping of servers"))?;
        // Rebuilt, so the entry keeps its place among the others.
        let renamed: Mapping = std::mem::take(servers)
            .into_iter()
            .map(|(key, value)| {
                if key == stored {
                    (Yaml::String(to.to_string()), value)
                } else {
                    (key, value)
                }
            })
            .collect();
        *servers = renamed;
        self.dirty = true;
        Ok(())
    }

    fn promote(&mut self, _key: &str) -> Result<(), String> {
        Ok(())
    }

    fn root_list_contains(&self, _list: &str, _name: &str) -> bool {
        false
    }

    fn set_root_list(&mut self, list: &str, _name: &str, _present: bool) -> Result<bool, String> {
        Err(format!("`{list}` is not a key of this document"))
    }

    fn finish(self: Box<Self>) -> String {
        if !self.dirty {
            return self.original;
        }
        match serde_yaml::to_string(&Yaml::Mapping(self.root)) {
            Ok(text) => with_bom(self.bom, text),
            // A mapping read from YAML always serializes back; should it
            // not, the document stays as it was rather than being emptied.
            Err(_) => self.original,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::collections::BTreeMap;

    const HERMES: &str = r#"# hermes settings
model:
  provider: anthropic   # the default
  name: "claude#4"
mcp_servers:
  files:
    command: npx
    args: ["-y", "server-files"]
    env:
      ROOT: /tmp
  remote:
    url: https://x.test/sse
    transport: sse
    enabled: false
    client_cert: /c.pem
toolsets: [web]
"#;

    fn open(text: &str) -> Box<dyn EntryStore> {
        Box::new(YamlStore::open(text).expect("opens"))
    }

    fn fields(value: Value) -> Vec<(String, Value)> {
        value
            .as_object()
            .unwrap()
            .iter()
            .map(|(key, value)| (key.clone(), value.clone()))
            .collect()
    }

    #[test]
    fn comments_are_noticed_outside_quotes_only() {
        assert!(has_comments(HERMES));
        assert!(has_comments("a: 1 # note\n"));
        assert!(has_comments("  # indented\n"));
        assert!(!has_comments(
            "name: \"claude#4\"\nurl: http://x.test/#frag\n"
        ));
        assert!(!has_comments("name: 'a # b'\n"));
        assert!(!has_comments(""));
    }

    #[test]
    fn an_untouched_document_comes_back_as_it_was() {
        let mut store = open(HERMES);
        store.patch("files", &[]).unwrap();
        assert!(!store.remove("absent").unwrap());
        assert_eq!(store.finish(), HERMES);
    }

    #[test]
    fn an_edit_keeps_every_key_and_the_order_and_drops_only_comments() {
        let view = read_view(HERMES).unwrap();
        assert_eq!(
            view.entries
                .iter()
                .map(|e| e.key.as_str())
                .collect::<Vec<_>>(),
            ["files", "remote"]
        );
        assert_eq!(
            view.entries[1].value,
            json!({"url": "https://x.test/sse", "transport": "sse", "enabled": false, "client_cert": "/c.pem"})
        );

        let mut store = open(HERMES);
        store
            .patch(
                "files",
                &[
                    FieldOp::Set("command".into(), json!("uvx")),
                    FieldOp::SyncMap(
                        "env".into(),
                        BTreeMap::from([("ROOT".to_string(), "/srv".to_string())]),
                    ),
                ],
            )
            .unwrap();
        store
            .create("new", &fields(json!({"url": "https://n.test/mcp"})))
            .unwrap();
        store.rename("remote", "renamed").unwrap();
        let out = store.finish();
        assert!(!out.contains("hermes settings"), "{out}");
        assert!(!out.contains("the default"), "{out}");
        let value: Value =
            serde_json::to_value(serde_yaml::from_str::<Yaml>(&out).unwrap()).unwrap();
        assert_eq!(
            value.as_object().unwrap().keys().collect::<Vec<_>>(),
            ["model", "mcp_servers", "toolsets"]
        );
        assert_eq!(
            value["model"],
            json!({"provider": "anthropic", "name": "claude#4"})
        );
        assert_eq!(value["toolsets"], json!(["web"]));
        let servers = value["mcp_servers"].as_object().unwrap();
        assert_eq!(
            servers.keys().collect::<Vec<_>>(),
            ["files", "renamed", "new"]
        );
        assert_eq!(
            servers["files"],
            json!({"command": "uvx", "args": ["-y", "server-files"], "env": {"ROOT": "/srv"}})
        );
        assert_eq!(
            servers["renamed"],
            json!({"url": "https://x.test/sse", "transport": "sse", "enabled": false, "client_cert": "/c.pem"})
        );
    }

    #[test]
    fn an_empty_section_or_file_takes_a_first_server() {
        for text in ["", "# only a comment\n", "model: x\nmcp_servers:\n"] {
            let mut store = open(text);
            store.create("a", &fields(json!({"command": "a"}))).unwrap();
            let value: Value =
                serde_json::to_value(serde_yaml::from_str::<Yaml>(&store.finish()).unwrap())
                    .unwrap();
            assert_eq!(
                value["mcp_servers"],
                json!({"a": {"command": "a"}}),
                "{text:?}"
            );
        }
    }

    #[test]
    fn what_is_not_a_mapping_is_refused() {
        assert_eq!(
            read_view("- a\n- b\n").unwrap_err().code,
            codes::ROOT_NOT_OBJECT
        );
        assert_eq!(read_view("a: [1\n").unwrap_err().code, codes::INVALID_YAML);
        let text = "mcp_servers: nope\n";
        assert_eq!(
            read_view(text).unwrap().container_invalid.as_deref(),
            Some("mcp_servers")
        );
        let mut store = open(text);
        assert!(store.create("a", &fields(json!({"command": "a"}))).is_err());
        assert_eq!(store.finish(), text);
    }

    /// The YAML parser refuses a mapping key that is there twice, so the
    /// listing and an edit never disagree about which one counts: the file
    /// is unreadable to both. (Hermes itself would take the last.)
    #[test]
    fn a_key_that_is_there_twice_is_a_file_that_does_not_parse() {
        for text in [
            "mcp_servers:\n  x:\n    command: old\n  x:\n    command: active\n",
            "mcp_servers:\n  x:\n    command: x\n    enabled: true\n    enabled: false\n",
            "mcp_servers:\n  x:\n    command: a\nmcp_servers:\n  y:\n    command: b\n",
        ] {
            assert_eq!(
                read_view(text).unwrap_err().code,
                codes::INVALID_YAML,
                "{text}"
            );
            assert_eq!(
                YamlStore::open(text).err().map(|problem| problem.code),
                Some(codes::INVALID_YAML.to_string()),
                "{text}"
            );
        }
    }

    /// `1` and `"1"` are two keys to the parser and one name to codeg: the
    /// store says so rather than pick one.
    #[test]
    fn two_keys_that_read_as_one_name_are_reported_not_picked() {
        let text = "mcp_servers:\n  1:\n    command: number\n  \"1\":\n    command: string\n  ok:\n    command: ok\n";
        let view = read_view(text).unwrap();
        assert_eq!(
            view.entries
                .iter()
                .map(|entry| entry.key.as_str())
                .collect::<Vec<_>>(),
            ["1", "1", "ok"],
            "both are listed"
        );
        let store = open(text);
        assert_eq!(store.get("1").unwrap().duplicate, Some(DuplicateKey::Entry));
        assert_eq!(store.get("ok").unwrap().duplicate, None);
        let mut view = view;
        mark_duplicates(text, &mut view);
        assert_eq!(
            view.entries
                .iter()
                .map(|entry| entry.duplicate.clone())
                .collect::<Vec<_>>(),
            [Some(DuplicateKey::Entry), Some(DuplicateKey::Entry), None]
        );

        // Inside an entry, at any depth.
        for (entry, path) in [
            ("{command: x, env: {1: a, \"1\": b}}", "env.1"),
            ("{command: x, true: a, \"true\": b}", "true"),
            ("{url: u, auth: [{2: a, \"2\": b}]}", "auth.0.2"),
        ] {
            let text = format!("mcp_servers:\n  x: {entry}\n");
            assert_eq!(
                open(&text).get("x").unwrap().duplicate,
                Some(DuplicateKey::Field(path.to_string())),
                "{entry}"
            );
        }
    }
}
