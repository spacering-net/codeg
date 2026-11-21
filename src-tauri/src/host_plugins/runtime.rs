use std::rc::Rc;
use std::time::{Duration, Instant};

use rquickjs::{Context, Ctx, Error, Function, Module, Promise, Runtime, Value};
use serde_json::Value as Json;

use super::invalid;
use super::schema::RpcContract;
use super::services::Execution;
use crate::app_error::{AppCommandError, AppErrorCode};

pub(super) const MAX_MODULE_BYTES: usize = 256 * 1024;
pub(super) const MAX_MESSAGE_BYTES: usize = 64 * 1024;
const MEMORY_LIMIT: usize = 16 * 1024 * 1024;
const EXECUTION_LIMIT: Duration = Duration::from_millis(500);

pub(super) fn call_with_settings(
    entry: &str,
    code: &str,
    method: &str,
    input: &Json,
    settings: Option<&Json>,
    contract: Option<&RpcContract>,
) -> Result<Json, AppCommandError> {
    invoke(
        entry,
        code,
        method,
        input,
        settings,
        contract,
        Mode::Standalone,
    )
}

#[derive(Clone, Copy)]
pub(super) enum Mode<'a> {
    Standalone,
    Catalog {
        execution: &'a Rc<Execution>,
        bridge: bool,
        service: bool,
    },
}

pub(super) fn execution_deadline() -> Instant {
    Instant::now() + EXECUTION_LIMIT
}

pub(super) fn invoke(
    entry: &str,
    code: &str,
    method: &str,
    input: &Json,
    settings: Option<&Json>,
    contract: Option<&RpcContract>,
    mode: Mode<'_>,
) -> Result<Json, AppCommandError> {
    let input_json = serde_json::to_vec(input).map_err(|_| invalid("Invalid plugin input"))?;
    if input_json.len() > MAX_MESSAGE_BYTES {
        return Err(invalid("Plugin input exceeds 64 KiB"));
    }
    if let Some(contract) = contract {
        contract.check_input(method, input)?;
    }
    let settings = serde_json::to_vec(&settings).map_err(|_| invalid("Invalid plugin settings"))?;

    let deadline = match mode {
        Mode::Standalone => execution_deadline(),
        Mode::Catalog { execution, .. } => execution.deadline,
    };
    if Instant::now() >= deadline {
        return Err(timed_out());
    }
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
        let result: Value<'_> = match mode {
            Mode::Catalog {
                execution,
                bridge: true,
                ..
            } => handle.call((method, input, settings, execution.context(&ctx)?))?,
            _ => handle.call((method, input, settings))?,
        };
        let result = match result.as_promise() {
            Some(promise) => resolve(&ctx, promise.clone(), deadline)?,
            None => result,
        };
        match mode {
            Mode::Standalone => ctx.json_stringify(result),
            Mode::Catalog { execution, .. } => execution.stringify(&ctx, result),
        }?
            .ok_or_else(|| Error::new_from_js("undefined", "JSON"))?
            .to_string()
    });
    if Instant::now() >= deadline {
        return Err(timed_out());
    }
    let output = output.map_err(|_| failed())?;
    if let Mode::Catalog {
        execution,
        service: true,
        ..
    } = mode
    {
        execution.charge_service_bytes(output.len())?;
    }
    if output.len() > MAX_MESSAGE_BYTES {
        return Err(invalid("Plugin response exceeds 64 KiB"));
    }
    let value = serde_json::from_str(&output).map_err(|_| failed())?;
    if let Some(contract) = contract {
        contract.check_output(method, &value)?;
    }
    Ok(value)
}

pub(super) fn timed_out() -> AppCommandError {
    AppCommandError::new(
        AppErrorCode::TaskExecutionFailed,
        "The plugin exceeded its execution time limit",
    )
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
