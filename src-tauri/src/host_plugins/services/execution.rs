use std::cell::{Cell, RefCell};
use std::rc::Rc;
use std::sync::Arc;
use std::time::Instant;

use rquickjs::{function::Opt, Ctx, Exception, Function, Object, Value};
use serde_json::Value as Json;

use super::events::{PublishedEvent, Target, MAX_EVENTS, MAX_PAYLOAD_BYTES};
use super::{provider, requirements, MAX_SERVICE_CALLS, MAX_SERVICE_CALL_DEPTH};
use crate::app_error::AppCommandError;
use crate::host_plugins::{
    catalog_error, invalid, plugin_not_found, runtime, InstalledPlugin, Invocation, PluginState,
    SharedPluginState,
};

#[derive(Clone)]
struct ActivePlugin {
    id: String,
    activation: Arc<()>,
}

impl ActivePlugin {
    fn find<'a>(&self, state: &'a PluginState) -> Result<&'a InstalledPlugin, AppCommandError> {
        state
            .catalog
            .get(&self.id)
            .filter(|plugin| plugin.enabled && Arc::ptr_eq(&plugin.activation, &self.activation))
            .ok_or_else(plugin_not_found)
    }
}

#[derive(Default)]
struct Progress {
    stack: Vec<ActivePlugin>,
    participants: Vec<ActivePlugin>,
    events: Vec<PublishedEvent>,
    service_calls: usize,
    service_bytes: usize,
    event_count: usize,
}

pub(in crate::host_plugins) struct Output {
    pub(in crate::host_plugins) value: Json,
    pub(in crate::host_plugins) events: Vec<PublishedEvent>,
    pub(in crate::host_plugins) deadline: Instant,
    participants: Vec<ActivePlugin>,
}

impl Output {
    pub(in crate::host_plugins) fn check_active(
        &self,
        state: &PluginState,
    ) -> Result<(), AppCommandError> {
        for plugin in &self.participants {
            plugin.find(state)?;
        }
        Ok(())
    }
}

pub(in crate::host_plugins) struct Execution {
    state: SharedPluginState,
    progress: RefCell<Progress>,
    encoding: Cell<bool>,
    pub(in crate::host_plugins) deadline: Instant,
}

impl Execution {
    pub(in crate::host_plugins) fn run(
        state: SharedPluginState,
        invocation: Invocation,
        input: Json,
    ) -> Result<Output, AppCommandError> {
        let execution = Rc::new(Self {
            state,
            progress: RefCell::default(),
            encoding: Cell::new(false),
            deadline: runtime::execution_deadline(),
        });
        let value = execution.invoke(invocation, input, false)?;
        let progress = execution.progress.take();
        Ok(Output {
            value,
            events: progress.events,
            deadline: execution.deadline,
            participants: progress.participants,
        })
    }

    fn invoke(
        self: &Rc<Self>,
        invocation: Invocation,
        input: Json,
        service: bool,
    ) -> Result<Json, AppCommandError> {
        let identity = ActivePlugin {
            id: invocation.id.clone(),
            activation: invocation.activation.clone(),
        };
        self.check_generation(&identity)?;
        let (events, participants) = {
            let mut progress = self.progress.borrow_mut();
            progress.stack.push(identity.clone());
            (progress.events.len(), progress.participants.len())
        };
        let result = runtime::invoke(
            &invocation.entry,
            &invocation.code,
            &invocation.method,
            &input,
            invocation.settings.as_ref().map(|settings| &settings.value),
            invocation.contract.as_deref(),
            runtime::Mode::Catalog {
                execution: self,
                bridge: invocation.has_runtime_context,
                service,
            },
        );
        let result = self.check_generation(&identity).and(result);
        let mut progress = self.progress.borrow_mut();
        progress.stack.pop();
        if result.is_ok() {
            progress.participants.push(identity);
        } else {
            // A caught provider failure still withdraws that call's events and its descendants.
            progress.events.truncate(events);
            progress.participants.truncate(participants);
        }
        result
    }

    fn check_generation(&self, identity: &ActivePlugin) -> Result<(), AppCommandError> {
        let state = self.state.lock().expect("host plugin state lock");
        identity.find(state.as_ref().map_err(|error| catalog_error(error))?)?;
        Ok(())
    }

    pub(in crate::host_plugins) fn charge_service_bytes(
        &self,
        bytes: usize,
    ) -> Result<(), AppCommandError> {
        let mut progress = self.progress.borrow_mut();
        progress.service_bytes = progress.service_bytes.saturating_add(bytes);
        if progress.service_bytes > runtime::MAX_MESSAGE_BYTES {
            return Err(invalid(
                "Plugin service calls exceed their shared 64 KiB message budget",
            ));
        }
        Ok(())
    }

    fn call_service(
        self: &Rc<Self>,
        name: &str,
        method: String,
        input: Json,
    ) -> Result<Json, AppCommandError> {
        {
            let mut progress = self.progress.borrow_mut();
            if progress.service_calls >= MAX_SERVICE_CALLS {
                return Err(invalid(
                    "A plugin invocation can make at most 8 service calls",
                ));
            }
            progress.service_calls += 1;
            if progress.stack.len() > MAX_SERVICE_CALL_DEPTH {
                return Err(invalid("Plugin service call depth exceeds 2"));
            }
            if progress.service_bytes > runtime::MAX_MESSAGE_BYTES {
                return Err(invalid(
                    "Plugin service calls exceed their shared 64 KiB message budget",
                ));
            }
        }
        let bytes =
            serde_json::to_vec(&input).map_err(|_| invalid("Invalid plugin service input"))?;
        self.charge_service_bytes(bytes.len())?;
        let invocation = {
            let progress = self.progress.borrow();
            let caller = progress.stack.last().expect("active plugin invocation");
            let state = self.state.lock().expect("host plugin state lock");
            let state = state.as_ref().map_err(|error| catalog_error(error))?;
            let plugin = caller.find(state)?;
            let dependency = requirements(plugin)
                .find(|dependency| dependency.service == name)
                .ok_or_else(|| invalid("Plugin service is not a declared dependency"))?;
            let (provider, contract) = provider(&state.catalog, name, &caller.id)
                .filter(|(_, contract)| contract.version >= dependency.min_version)
                .ok_or_else(|| {
                    AppCommandError::not_found(
                        "Plugin service is unavailable at the required version",
                    )
                })?;
            if !contract.methods.contains(&method) {
                return Err(invalid("Method is not exposed by the plugin service"));
            }
            let id = &provider.manifest.id;
            if progress.stack.iter().any(|active| active.id == *id) {
                return Err(invalid(
                    "Plugin service call would revisit an active plugin",
                ));
            }
            Invocation::new(id, provider, method).ok_or_else(plugin_not_found)?
        };
        self.invoke(invocation, input, true)
    }

    fn emit(&self, name: String, payload: Json, target: Target) -> Result<(), AppCommandError> {
        let mut progress = self.progress.borrow_mut();
        if progress.event_count >= MAX_EVENTS {
            return Err(invalid("A plugin invocation can publish up to 16 events"));
        }
        let active = progress.stack.last().expect("active plugin invocation");
        let contract = {
            let state = self.state.lock().expect("host plugin state lock");
            let plugin = active.find(state.as_ref().map_err(|error| catalog_error(error))?)?;
            plugin
                .event_contracts
                .get(&name)
                .cloned()
                .ok_or_else(|| invalid("Plugin event is not declared"))?
        };
        let event = contract.prepare(&active.id, name, payload, target)?;
        progress.events.push(event);
        progress.event_count += 1;
        Ok(())
    }

    pub(in crate::host_plugins) fn context<'js>(
        self: &Rc<Self>,
        ctx: &Ctx<'js>,
    ) -> rquickjs::Result<Object<'js>> {
        let host = Object::new(ctx.clone())?;
        let services = Object::new(ctx.clone())?;
        let execution = self.clone();
        services.set(
            "call",
            Function::new(
                ctx.clone(),
                move |name: String, method: String, input: Value<'js>| {
                    let ctx = input.ctx().clone();
                    let input = execution.decode_json(input, runtime::MAX_MESSAGE_BYTES)?;
                    let result = execution
                        .call_service(&name, method, input)
                        .map_err(|error| Exception::throw_type(&ctx, &error.message))?;
                    let encoded = serde_json::to_vec(&result).map_err(|_| {
                        Exception::throw_type(&ctx, "Invalid plugin service response")
                    })?;
                    ctx.json_parse(encoded)
                },
            )?,
        )?;
        host.set("services", services)?;

        let events = Object::new(ctx.clone())?;
        let execution = self.clone();
        events.set(
            "emit",
            Function::new(
                ctx.clone(),
                move |name: String, payload: Value<'js>, Opt(target): Opt<Value<'js>>| {
                    let ctx = payload.ctx().clone();
                    let payload = execution.decode_json(payload, MAX_PAYLOAD_BYTES)?;
                    let target = match target.filter(|value| !value.is_undefined()) {
                        None => Target::default(),
                        Some(value) => {
                            let value = execution.decode_json(value, 256)?;
                            if !value.is_object() {
                                return Err(Exception::throw_type(
                                    &ctx,
                                    "Expected a plugin event target object",
                                ));
                            }
                            serde_json::from_value(value).map_err(|_| {
                                Exception::throw_type(&ctx, "Invalid plugin event target")
                            })?
                        }
                    };
                    execution
                        .emit(name, payload, target)
                        .map_err(|error| Exception::throw_type(&ctx, &error.message))
                },
            )?,
        )?;
        host.set("events", events)?;
        Ok(host)
    }
    pub(in crate::host_plugins) fn stringify<'js>(
        &self,
        ctx: &Ctx<'js>,
        value: Value<'js>,
    ) -> rquickjs::Result<Option<rquickjs::String<'js>>> {
        if self.encoding.replace(true) {
            return Err(Exception::throw_type(
                ctx,
                "Plugin host calls are unavailable during JSON serialization",
            ));
        }
        let encoded = ctx.json_stringify(value);
        self.encoding.set(false);
        encoded
    }

    fn decode_json(&self, value: Value<'_>, limit: usize) -> rquickjs::Result<Json> {
        let ctx = value.ctx().clone();
        let serialized = self
            .stringify(&ctx, value)?
            .ok_or_else(|| Exception::throw_type(&ctx, "Expected a JSON plugin value"))?
            .to_string()?;
        if serialized.len() > limit {
            return Err(Exception::throw_range(
                &ctx,
                "Plugin value exceeds its byte limit",
            ));
        }
        serde_json::from_str(&serialized)
            .map_err(|_| Exception::throw_type(&ctx, "Invalid JSON plugin value"))
    }
}
