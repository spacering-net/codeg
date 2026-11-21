use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

use super::invalid;
use crate::app_error::AppCommandError;

pub(super) const MAX_SETTINGS_BYTES: usize = 16 * 1024;
pub(super) const MIGRATION_METHOD: &str = "settings.migrate";
const SCHEMA_URL: &str = "https://codeg.invalid/plugin-settings.json";

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Definition {
    pub version: u32,
    pub schema: Value,
    pub defaults: Value,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub migrate: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Snapshot {
    pub(super) version: u32,
    pub(super) revision: Uuid,
    pub(super) value: Value,
}

impl Snapshot {
    pub(super) fn new(version: u32, value: Value) -> Self {
        Self {
            version,
            revision: Uuid::new_v4(),
            value,
        }
    }
}

impl Definition {
    pub(super) fn validate(&self) -> Result<(), AppCommandError> {
        if self.version == 0 || self.schema.get("type").and_then(Value::as_str) != Some("object") {
            return Err(invalid(
                "Plugin settings need a positive version and an object schema",
            ));
        }
        self.check_value(&self.defaults)
    }

    pub(super) fn check_value(&self, value: &Value) -> Result<(), AppCommandError> {
        check_size(value)?;
        let mut compiler = boon::Compiler::new();
        compiler.set_default_draft(boon::Draft::V2020_12);
        compiler.use_loader(Box::new(NoExternalSchemas));
        compiler
            .add_resource(SCHEMA_URL, self.schema.clone())
            .map_err(|_| invalid("Could not read the plugin settings schema"))?;
        let mut schemas = boon::Schemas::new();
        let index = compiler
            .compile(SCHEMA_URL, &mut schemas)
            .map_err(|_| invalid("Invalid plugin settings JSON Schema"))?;
        schemas
            .validate(value, index)
            .map_err(|_| invalid("Plugin settings do not match their JSON Schema"))
    }
}

pub(super) fn check_size(value: &Value) -> Result<(), AppCommandError> {
    if !value.is_object()
        || serde_json::to_vec(value).map_or(true, |bytes| bytes.len() > MAX_SETTINGS_BYTES)
    {
        return Err(invalid(
            "Plugin settings must be a JSON object up to 16 KiB",
        ));
    }
    Ok(())
}

struct NoExternalSchemas;

impl boon::UrlLoader for NoExternalSchemas {
    fn load(&self, _url: &str) -> Result<Value, Box<dyn std::error::Error>> {
        Err("Plugin settings schemas may only reference their own definitions".into())
    }
}
