use std::time::{Duration, Instant};

use rquickjs::{Context, Ctx, Error, Function, Module, Promise, Runtime, Value};
use serde_json::Value as Json;

use super::invalid;
use super::schema::RpcContract;
use crate::app_error::{AppCommandError, AppErrorCode};

pub(super) const MAX_MODULE_BYTES: usize = 256 * 1024;
const MAX_MESSAGE_BYTES: usize = 64 * 1024;
// JSON can expand each input byte to a six-byte escape. Keep the larger
// envelope private to the prompt hook; the decoded replacement has its own cap.
pub(super) const MAX_PROMPT_BYTES: usize = 128 * 1024;
const MAX_PROMPT_MESSAGE_BYTES: usize = MAX_PROMPT_BYTES * 6 + 1024;
const MEMORY_LIMIT: usize = 16 * 1024 * 1024;
const EXECUTION_LIMIT: Duration = Duration::from_millis(500);

#[derive(Clone, Copy)]
pub(super) enum CallMode {
    Standard,
    SessionPrompt,
    SessionPermission,
}

pub(super) fn call_with_settings(
    entry: &str,
    code: &str,
    method: &str,
    input: &Json,
    settings: Option<&Json>,
    contract: Option<&RpcContract>,
) -> Result<Json, AppCommandError> {
    call(
        entry,
        code,
        method,
        input,
        settings,
        contract,
        CallMode::Standard,
    )
}

pub(super) fn call(
    entry: &str,
    code: &str,
    method: &str,
    input: &Json,
    settings: Option<&Json>,
    contract: Option<&RpcContract>,
    mode: CallMode,
) -> Result<Json, AppCommandError> {
    let (message_limit, input_error, output_error) = match mode {
        CallMode::SessionPrompt => (
            MAX_PROMPT_MESSAGE_BYTES,
            "Plugin prompt input exceeds the JSON size limit",
            "Plugin prompt response exceeds the JSON size limit",
        ),
        _ => (
            MAX_MESSAGE_BYTES,
            "Plugin input exceeds 64 KiB",
            "Plugin response exceeds 64 KiB",
        ),
    };
    let input_json = serde_json::to_vec(input).map_err(|_| invalid("Invalid plugin input"))?;
    if input_json.len() > message_limit {
        return Err(invalid(input_error));
    }
    if let Some(contract) = contract {
        contract.check_input(method, input)?;
    }
    let settings = serde_json::to_vec(&settings).map_err(|_| invalid("Invalid plugin settings"))?;

    let deadline = Instant::now() + EXECUTION_LIMIT;
    let runtime = Runtime::new().map_err(|_| failed())?;
    runtime.set_memory_limit(MEMORY_LIMIT);
    runtime.set_interrupt_handler(Some(Box::new(move || Instant::now() >= deadline)));
    let context = Context::full(&runtime).map_err(|_| failed())?;

    let output = context.with(|ctx| -> rquickjs::Result<String> {
        let module = Module::declare(ctx.clone(), entry, code)?;
        let (module, initialized) = module.eval()?;
        resolve(&ctx, initialized, deadline)?;
        let handle: Function<'_> = module.get("handle")?;
        let input = ctx.json_parse(input_json)?;
        let settings = ctx.json_parse(settings)?;
        let result: Value<'_> = handle.call((method, input, settings))?;
        let result = match result.as_promise() {
            Some(promise) => resolve(&ctx, promise.clone(), deadline)?,
            None => result,
        };
        if result.is_undefined() && !matches!(mode, CallMode::Standard) {
            return Ok("null".into());
        }
        let is_null = result.is_null();
        let output = ctx
            .json_stringify(result)?
            .ok_or_else(|| Error::new_from_js("undefined", "JSON"))?
            .to_string()?;
        if !matches!(mode, CallMode::Standard) && output == "null" && !is_null {
            return Err(Error::new_from_js("plugin hook result", "JSON object"));
        }
        Ok(output)
    });
    if Instant::now() >= deadline {
        return Err(AppCommandError::new(
            AppErrorCode::TaskExecutionFailed,
            "The plugin exceeded its execution time limit",
        ));
    }
    let output = output.map_err(|_| failed())?;
    if output.len() > message_limit {
        return Err(invalid(output_error));
    }
    let value = serde_json::from_str(&output).map_err(|_| failed())?;
    if let Some(contract) = contract {
        contract.check_output(method, &value)?;
    }
    Ok(value)
}

fn resolve<'js>(
    ctx: &Ctx<'js>,
    promise: Promise<'js>,
    deadline: Instant,
) -> rquickjs::Result<Value<'js>> {
    while Instant::now() < deadline {
        if let Some(result) = promise.result() {
            return result;
        }
        if !ctx.execute_pending_job() {
            break;
        }
    }
    Err(Error::WouldBlock)
}

fn failed() -> AppCommandError {
    AppCommandError::new(
        AppErrorCode::TaskExecutionFailed,
        "The plugin failed to return a JSON response",
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn resolves_json_promises_without_ambient_host_apis() {
        let output = call_with_settings(
            "fixture.mjs",
            "export async function handle(method, input) { return [method, input, typeof fetch, typeof process]; }",
            "echo",
            &json!({ "value": 42 }),
            None,
            None,
        ).unwrap();
        assert_eq!(
            output,
            json!(["echo", { "value": 42 }, "undefined", "undefined"])
        );
    }

    #[test]
    fn interrupts_a_nonterminating_handler() {
        let error = call_with_settings(
            "fixture.mjs",
            "export function handle() { while (true) {} }",
            "loop",
            &Json::Null,
            None,
            None,
        )
        .unwrap_err();
        assert!(error.to_string().contains("execution time limit"));
    }

    #[test]
    fn rejects_excessive_responses_and_unknown_imports() {
        for code in [
            "export const handle = () => 'a'.repeat(65536)",
            "import fs from 'node:fs'; export const handle = () => fs",
        ] {
            assert!(
                call_with_settings("fixture.mjs", code, "test", &Json::Null, None, None).is_err()
            );
        }
    }
}
