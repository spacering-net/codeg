use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;

use chrono::{DateTime, Utc};
use sea_orm::{ColumnTrait, DatabaseConnection, EntityTrait, QueryFilter};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::{present, valid_description};
use crate::app_error::{AppCommandError, AppErrorCode};
use crate::db::entities::{conversation, folder};
use crate::db::error::DbError;
use crate::host_plugins::{invalid, schema::Schema, valid_id, Translations, MAX_CONTRIBUTIONS};

pub(in crate::host_plugins) const EVENT_CHANNEL: &str = "host-plugins://plugin-event";
pub(super) const MAX_EVENTS: usize = 16;
pub(super) const MAX_PAYLOAD_BYTES: usize = 16 * 1024;

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(deny_unknown_fields)]
pub(in crate::host_plugins) struct Events {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    publishes: Vec<EventContract>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct EventContract {
    name: String,
    #[serde(default, skip_serializing_if = "Scope::is_host")]
    scope: Scope,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    payload_schema: Option<Value>,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    description: Option<String>,
    #[serde(default, skip_serializing_if = "Translations::is_empty")]
    description_translations: Translations,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", try_from = "String")]
enum Scope {
    #[default]
    Host,
    Workspace,
    Session,
}

impl TryFrom<String> for Scope {
    type Error = &'static str;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        match value.as_str() {
            "host" => Ok(Self::Host),
            "workspace" => Ok(Self::Workspace),
            "session" => Ok(Self::Session),
            _ => Err("scope must be host, workspace or session"),
        }
    }
}

impl Scope {
    fn is_host(&self) -> bool {
        *self == Self::Host
    }
}

#[derive(Clone, Debug)]
pub(in crate::host_plugins) struct CompiledContract {
    scope: Scope,
    payload: Option<Arc<Schema>>,
}

pub(in crate::host_plugins) type Contracts = BTreeMap<String, CompiledContract>;

pub(super) fn compile(events: Option<&Events>) -> Result<Contracts, String> {
    let mut contracts = BTreeMap::new();
    let Some(events) = events else {
        return Ok(contracts);
    };
    if events.publishes.len() > MAX_CONTRIBUTIONS {
        return Err("Provide up to 16 event contracts".into());
    }
    for event in &events.publishes {
        if !valid_id(&event.name)
            || contracts.contains_key(&event.name)
            || !valid_description(
                event.description.as_deref(),
                &event.description_translations,
            )
        {
            return Err(format!(
                "Invalid or duplicate plugin event contract {:?}",
                event.name
            ));
        }
        let payload = event
            .payload_schema
            .as_ref()
            .map(|schema| {
                Schema::compile(schema).map(Arc::new).map_err(|_| {
                    format!(
                        "Invalid payload JSON Schema for plugin event {:?}",
                        event.name
                    )
                })
            })
            .transpose()?;
        contracts.insert(
            event.name.clone(),
            CompiledContract {
                scope: event.scope,
                payload,
            },
        );
    }
    Ok(contracts)
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Target {
    #[serde(default, deserialize_with = "present")]
    folder_id: Option<i32>,
    #[serde(default, deserialize_with = "present")]
    conversation_id: Option<i32>,
}

impl CompiledContract {
    pub(super) fn prepare(
        &self,
        plugin_id: &str,
        event: String,
        payload: Value,
        target: Target,
    ) -> Result<PublishedEvent, AppCommandError> {
        match (self.scope, target.folder_id, target.conversation_id) {
            (Scope::Host, None, None) => {}
            (Scope::Workspace, Some(folder), None) if folder > 0 => {}
            (Scope::Session, folder, Some(conversation))
                if conversation > 0 && folder.is_none_or(|id| id > 0) => {}
            _ => return Err(invalid("Event target does not match its declared scope")),
        }
        if !serde_json::to_vec(&payload).is_ok_and(|bytes| bytes.len() <= MAX_PAYLOAD_BYTES) {
            return Err(invalid("Plugin event payload exceeds 16 KiB"));
        }
        if self
            .payload
            .as_ref()
            .is_some_and(|schema| !schema.matches(&payload))
        {
            return Err(invalid(
                "Plugin event payload does not match its JSON Schema",
            ));
        }
        Ok(PublishedEvent {
            plugin_id: plugin_id.into(),
            event,
            scope: self.scope,
            target,
            payload,
        })
    }
}

pub(in crate::host_plugins) struct PublishedEvent {
    plugin_id: String,
    event: String,
    scope: Scope,
    target: Target,
    payload: Value,
}

impl PublishedEvent {
    pub(in crate::host_plugins) fn into_wire(self, emitted_at: DateTime<Utc>) -> impl Serialize {
        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct Wire {
            plugin_id: String,
            event: String,
            scope: Scope,
            folder_id: Option<i32>,
            conversation_id: Option<i32>,
            payload: Value,
            emitted_at: DateTime<Utc>,
        }
        Wire {
            plugin_id: self.plugin_id,
            event: self.event,
            scope: self.scope,
            folder_id: self.target.folder_id,
            conversation_id: self.target.conversation_id,
            payload: self.payload,
            emitted_at,
        }
    }

    pub(in crate::host_plugins) async fn validate_targets(
        events: &[Self],
        db: Option<&DatabaseConnection>,
    ) -> Result<(), AppCommandError> {
        let mut folders = BTreeSet::new();
        let mut conversations = BTreeMap::new();
        for event in events.iter().filter(|event| event.scope != Scope::Host) {
            let db = db.ok_or_else(|| {
                AppCommandError::new(
                    AppErrorCode::TaskExecutionFailed,
                    "Plugin event target validation is unavailable",
                )
            })?;
            if let Some(id) = event.target.folder_id {
                if folders.insert(id) {
                    let exists = folder::Entity::find_by_id(id)
                        .filter(folder::Column::DeletedAt.is_null())
                        .one(db)
                        .await
                        .map_err(DbError::from)?
                        .is_some();
                    if !exists {
                        return Err(invalid("Unknown plugin event workspace"));
                    }
                }
            }
            if let Some(id) = event.target.conversation_id {
                let folder_id = match conversations.entry(id) {
                    std::collections::btree_map::Entry::Occupied(entry) => *entry.get(),
                    std::collections::btree_map::Entry::Vacant(entry) => {
                        let record = conversation::Entity::find_by_id(id)
                            .filter(conversation::Column::DeletedAt.is_null())
                            .one(db)
                            .await
                            .map_err(DbError::from)?;
                        *entry.insert(
                            record
                                .ok_or_else(|| invalid("Unknown plugin event conversation"))?
                                .folder_id,
                        )
                    }
                };
                if event.target.folder_id.is_some_and(|id| id != folder_id) {
                    return Err(invalid(
                        "Plugin event conversation belongs to a different workspace",
                    ));
                }
            }
        }
        Ok(())
    }
}
