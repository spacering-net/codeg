use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::invalid;
use crate::app_error::{AppCommandError, AppErrorCode};

const SCHEMA_URL: &str = "https://codeg.invalid/plugin-schema.json";

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(deny_unknown_fields)]
pub(super) struct RpcDefinition {
    input: Value,
    output: Value,
}

#[derive(Debug)]
pub(super) struct RpcContract {
    input: Schema,
    output: Schema,
}

impl RpcDefinition {
    pub(super) fn compile(&self) -> Result<RpcContract, &'static str> {
        Ok(RpcContract {
            input: Schema::compile(&self.input).map_err(|_| "invalid input JSON Schema")?,
            output: Schema::compile(&self.output).map_err(|_| "invalid output JSON Schema")?,
        })
    }
}

impl RpcContract {
    pub(super) fn check_input(&self, method: &str, value: &Value) -> Result<(), AppCommandError> {
        if self.input.matches(value) {
            return Ok(());
        }
        Err(invalid(format!(
            "Plugin method {method} received input that does not match its schema"
        )))
    }

    pub(super) fn check_output(&self, method: &str, value: &Value) -> Result<(), AppCommandError> {
        if self.output.matches(value) {
            return Ok(());
        }
        Err(AppCommandError::new(
            AppErrorCode::TaskExecutionFailed,
            format!("Plugin method {method} returned output that does not match its schema"),
        ))
    }
}

pub(super) struct Schema {
    schemas: boon::Schemas,
    index: boon::SchemaIndex,
}

impl std::fmt::Debug for Schema {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.debug_struct("Schema").finish_non_exhaustive()
    }
}

impl Schema {
    pub(super) fn compile(schema: &Value) -> Result<Self, boon::CompileError> {
        let mut compiler = boon::Compiler::new();
        compiler.set_default_draft(boon::Draft::V2020_12);
        compiler.use_loader(Box::new(NoExternalSchemas));
        compiler.add_resource(SCHEMA_URL, schema.clone())?;
        let mut schemas = boon::Schemas::new();
        let index = compiler.compile(SCHEMA_URL, &mut schemas)?;
        Ok(Self { schemas, index })
    }

    pub(super) fn matches(&self, value: &Value) -> bool {
        self.schemas.validate(value, self.index).is_ok()
    }
}

struct NoExternalSchemas;

impl boon::UrlLoader for NoExternalSchemas {
    fn load(&self, _url: &str) -> Result<Value, Box<dyn std::error::Error>> {
        Err("Plugin schemas may only reference their own definitions".into())
    }
}
