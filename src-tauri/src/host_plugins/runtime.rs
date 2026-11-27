use std::cell::{Cell, RefCell};
use std::rc::Rc;
use std::time::{Duration, Instant};

use rquickjs::{Context, Ctx, Error, Exception, Function, Module, Object, Promise, Runtime, Value};
use serde_json::Value as Json;

use super::invalid;
use super::schema::RpcContract;
use super::timeline;
use super::timeline_transform;
use crate::app_error::{AppCommandError, AppErrorCode};

pub(super) const MAX_MODULE_BYTES: usize = 256 * 1024;
const MAX_MESSAGE_BYTES: usize = 64 * 1024;
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
    Ok(invoke(
        entry,
        code,
        method,
        input,
        settings,
        contract,
        InvocationMode::Rpc(None),
    )?
    .value)
}

#[derive(Clone, Copy)]
pub(super) enum InvocationMode {
    Rpc(Option<i32>),
    TimelineTransform,
}

pub(super) struct Output {
    pub value: Json,
    pub timeline: Vec<timeline::Append>,
}

pub(super) fn invoke(
    entry: &str,
    code: &str,
    method: &str,
    input: &Json,
    settings: Option<&Json>,
    contract: Option<&RpcContract>,
    mode: InvocationMode,
) -> Result<Output, AppCommandError> {
    let (input_limit, output_limit) = match mode {
        InvocationMode::Rpc(_) => (MAX_MESSAGE_BYTES, MAX_MESSAGE_BYTES),
        InvocationMode::TimelineTransform => (
            timeline_transform::MAX_INPUT_BYTES,
            timeline_transform::MAX_OUTPUT_BYTES,
        ),
    };
    let input_json = serde_json::to_vec(input).map_err(|_| invalid("Invalid plugin input"))?;
    if input_json.len() > input_limit {
        return Err(invalid(match mode {
            InvocationMode::Rpc(_) => "Plugin input exceeds 64 KiB",
            InvocationMode::TimelineTransform => "Timeline transform input exceeds its size limit",
        }));
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

    let appends = Rc::new(RefCell::new(Vec::new()));
    let append_error = Rc::new(Cell::new(None));
    let output = context.with(|ctx| -> rquickjs::Result<String> {
        let module = Module::declare(ctx.clone(), entry, code)?;
        let (module, initialized) = module.eval()?;
        resolve(&ctx, initialized, deadline)?;
        let handle: Function<'_> = module.get("handle")?;
        let input = ctx.json_parse(input_json)?;
        let settings = ctx.json_parse(settings)?;
        let result: Value<'_> = if let InvocationMode::Rpc(Some(conversation_id)) = mode {
            let host = Object::new(ctx.clone())?;
            host.set("conversationId", conversation_id)?;
            let timeline = Object::new(ctx.clone())?;
            let appends = appends.clone();
            let append_error = append_error.clone();
            let append = Function::new(ctx.clone(), move |item: Value<'_>| {
                let ctx = item.ctx().clone();
                let serialized = ctx
                    .json_stringify(item)?
                    .ok_or_else(|| Exception::throw_type(&ctx, "Expected a JSON timeline item"))?
                    .to_string()?;
                let mut pending = appends.borrow_mut();
                let error = if serialized.len() > timeline::MAX_APPEND_BYTES {
                    Some("Timeline item data exceeds 64 KiB")
                } else if pending.len() >= timeline::MAX_ITEMS {
                    Some("A plugin call can append up to 64 timeline items")
                } else {
                    None
                };
                if let Some(error) = error {
                    append_error.set(Some(error));
                    return Err(Exception::throw_range(&ctx, error));
                }
                pending.push(serialized);
                Ok(())
            })?;
            timeline.set("append", append)?;
            host.set("timeline", timeline)?;
            handle.call((method, input, settings, host))?
        } else {
            handle.call((method, input, settings))?
        };
        let result = match result.as_promise() {
            Some(promise) => resolve(&ctx, promise.clone(), deadline)?,
            None => result,
        };
        if matches!(mode, InvocationMode::TimelineTransform) && result.is_undefined() {
            return Ok("null".to_owned());
        }
        ctx.json_stringify(result)?
            .ok_or_else(|| Error::new_from_js("undefined", "JSON"))?
            .to_string()
    });
    if Instant::now() >= deadline {
        return Err(AppCommandError::new(
            AppErrorCode::TaskExecutionFailed,
            "The plugin exceeded its execution time limit",
        ));
    }
    if let Some(error) = append_error.get() {
        return Err(invalid(error));
    }
    let output = output.map_err(|_| failed())?;
    if output.len() > output_limit {
        return Err(invalid(match mode {
            InvocationMode::Rpc(_) => "Plugin response exceeds 64 KiB",
            InvocationMode::TimelineTransform => {
                "Timeline transform response exceeds its size limit"
            }
        }));
    }
    let value = serde_json::from_str(&output).map_err(|_| failed())?;
    if let Some(contract) = contract {
        contract.check_output(method, &value)?;
    }
    let timeline = appends
        .take()
        .iter()
        .map(|item| serde_json::from_str(item).map_err(|_| invalid("Invalid timeline item")))
        .collect::<Result<_, _>>()?;
    Ok(Output { value, timeline })
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
