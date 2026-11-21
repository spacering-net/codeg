use std::collections::{BTreeMap, BTreeSet};
use std::io::{ErrorKind, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

use super::schema::Schema;
use super::text::{valid_translations, Translations};
use super::{invalid, valid_id, valid_label, MAX_CONTRIBUTIONS};
use crate::app_error::{AppCommandError, AppErrorCode};
use crate::web::event_bridge::{emit_event, EventEmitter};

const EVENT_CHANNEL: &str = "host-plugins://timeline";
pub(super) const MAX_DATA_BYTES: usize = 64 * 1024;
pub(super) const MAX_APPEND_BYTES: usize = MAX_DATA_BYTES + 512;
pub(super) const MAX_ITEMS: usize = 64;
const MAX_FILE_BYTES: usize = MAX_ITEMS * MAX_APPEND_BYTES;

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Renderer {
    kind: String,
    version: u32,
    title: String,
    #[serde(default, skip_serializing_if = "Translations::is_empty")]
    title_translations: Translations,
    #[serde(
        default,
        deserialize_with = "deserialize_schema",
        skip_serializing_if = "Option::is_none"
    )]
    data_schema: Option<Value>,
}

fn deserialize_schema<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<Value>, D::Error> {
    Value::deserialize(deserializer).map(Some)
}

pub(super) type Renderers = BTreeMap<(String, u32), Option<Arc<Schema>>>;

pub(super) fn compile(renderers: &[Renderer], has_client: bool) -> Result<Renderers, String> {
    if !renderers.is_empty() && !has_client {
        return Err("Timeline renderers need a plugin client entry".into());
    }
    if renderers.len() > MAX_CONTRIBUTIONS {
        return Err("Provide up to 16 timeline renderers".into());
    }

    let mut compiled = BTreeMap::new();
    for renderer in renderers {
        let key = (renderer.kind.clone(), renderer.version);
        if !valid_kind(&renderer.kind)
            || renderer.version == 0
            || !valid_label(&renderer.title)
            || !valid_translations(&renderer.title_translations, valid_label)
            || compiled.contains_key(&key)
        {
            return Err("Invalid or duplicate timeline renderer".into());
        }
        let schema = renderer
            .data_schema
            .as_ref()
            .map(|value| {
                Schema::compile(value)
                    .map(Arc::new)
                    .map_err(|_| "Invalid timeline renderer data JSON Schema")
            })
            .transpose()?;
        compiled.insert(key, schema);
    }
    Ok(compiled)
}

fn valid_kind(kind: &str) -> bool {
    kind.len() <= 32
        && kind.as_bytes().first().is_some_and(u8::is_ascii_lowercase)
        && kind
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
}

pub(super) fn valid_item_id(id: &str) -> bool {
    id.len() <= 64 && valid_id(id)
}

fn check_item(id: &str, kind: &str, version: u32, data: &Value) -> Result<(), AppCommandError> {
    if !valid_item_id(id) || !valid_kind(kind) || version == 0 {
        return Err(invalid("Invalid timeline item ID, kind, or version"));
    }
    if !valid_data_size(data) {
        return Err(invalid("Timeline item data exceeds 64 KiB"));
    }
    Ok(())
}

pub(super) fn valid_data_size(data: &Value) -> bool {
    serde_json::to_vec(data).is_ok_and(|bytes| bytes.len() <= MAX_DATA_BYTES)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Append {
    id: String,
    kind: String,
    version: u32,
    data: Value,
}

impl Append {
    pub(super) fn validate(&self, renderers: &Renderers) -> Result<(), AppCommandError> {
        check_item(&self.id, &self.kind, self.version, &self.data)?;
        let schema = renderers
            .get(&(self.kind.clone(), self.version))
            .ok_or_else(|| {
                invalid("Timeline items need a matching renderer from the same plugin")
            })?;
        if schema
            .as_ref()
            .is_some_and(|schema| !schema.matches(&self.data))
        {
            return Err(invalid("Timeline item data does not match its JSON Schema"));
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TimelineItem {
    id: String,
    plugin_id: String,
    conversation_id: i32,
    kind: String,
    version: u32,
    data: Value,
    updated_at: DateTime<Utc>,
}

pub(super) fn sort(items: &mut [TimelineItem]) {
    items.sort_unstable_by(|a, b| {
        (&a.updated_at, &a.plugin_id, &a.id).cmp(&(&b.updated_at, &b.plugin_id, &b.id))
    });
}

pub(super) fn invalidate(emitter: &EventEmitter, plugin_id: &str) {
    emit_event(
        emitter,
        EVENT_CHANNEL,
        serde_json::json!({ "pluginId": plugin_id, "conversationId": null, "item": null }),
    );
}

#[derive(Clone)]
pub(super) struct Store {
    root: PathBuf,
}

impl Store {
    pub(super) fn new(data_dir: &Path) -> Self {
        Self {
            root: data_dir.join("host-plugin-timeline"),
        }
    }

    fn path(&self, key: Uuid, conversation_id: i32) -> PathBuf {
        self.root
            .join(key.to_string())
            .join(format!("{conversation_id}.json"))
    }

    pub(super) fn load(
        &self,
        key: Uuid,
        plugin_id: &str,
        conversation_id: i32,
    ) -> Result<Vec<TimelineItem>, AppCommandError> {
        let file = match std::fs::File::open(self.path(key, conversation_id)) {
            Ok(file) => file,
            Err(error) if error.kind() == ErrorKind::NotFound => return Ok(Vec::new()),
            Err(error) => return Err(store_error(error)),
        };
        let mut bytes = Vec::new();
        file.take(MAX_FILE_BYTES as u64 + 1)
            .read_to_end(&mut bytes)
            .map_err(store_error)?;
        if bytes.len() > MAX_FILE_BYTES {
            return Err(store_error("Timeline file exceeds its size limit"));
        }
        let items: Vec<TimelineItem> = serde_json::from_slice(&bytes).map_err(store_error)?;
        let mut ids = BTreeSet::new();
        if items.len() > MAX_ITEMS
            || items.iter().any(|item| {
                item.plugin_id != plugin_id
                    || item.conversation_id != conversation_id
                    || !ids.insert(&item.id)
                    || check_item(&item.id, &item.kind, item.version, &item.data).is_err()
            })
        {
            return Err(store_error("Invalid stored timeline items"));
        }
        Ok(items)
    }

    pub(super) fn upsert(
        &self,
        key: Uuid,
        plugin_id: &str,
        conversation_id: i32,
        entries: Vec<Append>,
        emitter: &EventEmitter,
    ) -> Result<(), AppCommandError> {
        let mut rows = self
            .load(key, plugin_id, conversation_id)?
            .into_iter()
            .map(|item| (item.id.clone(), item))
            .collect::<BTreeMap<_, _>>();
        let mut changed = BTreeSet::new();
        let updated_at = Utc::now();
        for entry in entries {
            let item = TimelineItem {
                id: entry.id,
                plugin_id: plugin_id.to_owned(),
                conversation_id,
                kind: entry.kind,
                version: entry.version,
                data: entry.data,
                updated_at,
            };
            changed.insert(item.id.clone());
            rows.insert(item.id.clone(), item);
        }
        if rows.len() > MAX_ITEMS {
            return Err(invalid(
                "A plugin may have up to 64 items in one conversation",
            ));
        }

        let path = self.path(key, conversation_id);
        let dir = path.parent().expect("timeline path has a directory");
        std::fs::create_dir_all(dir).map_err(store_error)?;
        let mut file = tempfile::NamedTempFile::new_in(dir).map_err(store_error)?;
        let items: Vec<_> = rows.values().collect();
        serde_json::to_writer(&mut file, &items).map_err(store_error)?;
        file.flush().map_err(store_error)?;
        file.as_file().sync_all().map_err(store_error)?;
        file.persist(path).map_err(store_error)?;

        for id in changed {
            emit_event(
                emitter,
                EVENT_CHANNEL,
                serde_json::json!({
                    "pluginId": plugin_id,
                    "conversationId": conversation_id,
                    "item": rows[&id],
                }),
            );
        }
        Ok(())
    }

    pub(super) fn remove(&self, key: Uuid) {
        if let Err(error) = std::fs::remove_dir_all(self.root.join(key.to_string())) {
            if error.kind() != ErrorKind::NotFound {
                tracing::warn!(%key, %error, "Could not remove host plugin timeline files");
            }
        }
    }

    pub(super) fn clean_removed(&self, live_keys: &BTreeSet<Uuid>) {
        let dirs = match std::fs::read_dir(&self.root) {
            Ok(dirs) => dirs,
            Err(error) if error.kind() == ErrorKind::NotFound => return,
            Err(error) => {
                tracing::warn!(%error, "Could not enumerate host plugin timeline files");
                return;
            }
        };
        for dir in dirs.flatten() {
            let Some(key) = dir
                .file_name()
                .to_str()
                .and_then(|name| Uuid::parse_str(name).ok())
            else {
                continue;
            };
            if !live_keys.contains(&key) {
                self.remove(key);
            }
        }
    }
}

fn store_error(error: impl std::fmt::Display) -> AppCommandError {
    AppCommandError::new(AppErrorCode::IoError, "Host plugin timeline is unavailable")
        .with_detail(error.to_string())
}

#[cfg(test)]
mod tests;
