mod events;
mod execution;

use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;

use serde::{Deserialize, Deserializer, Serialize};

use super::{
    valid_id, valid_label, valid_translations, Catalog, InstalledPlugin, Manifest, Translations,
    MAX_CONTRIBUTIONS,
};
use crate::app_error::{AppCommandError, AppErrorCode};

pub(super) use events::{
    Contracts as EventContracts, Events as EventsManifest, PublishedEvent, EVENT_CHANNEL,
};
pub(super) use execution::Execution;

const MAX_SERVICES: usize = 8;
const MAX_SERVICE_CALL_DEPTH: usize = 2;
const MAX_SERVICE_CALLS: usize = 8;

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Services {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    provides: Vec<ServiceContract>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    requires: Vec<ServiceDependency>,
}

impl Services {
    pub(super) fn has_dependencies(&self) -> bool {
        !self.requires.is_empty()
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ServiceContract {
    name: String,
    version: u32,
    methods: Vec<String>,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    description: Option<String>,
    #[serde(default, skip_serializing_if = "Translations::is_empty")]
    description_translations: Translations,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ServiceDependency {
    service: String,
    #[serde(
        default = "initial_version",
        skip_serializing_if = "is_initial_version"
    )]
    min_version: u32,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    optional: bool,
}

fn initial_version() -> u32 {
    1
}

fn is_initial_version(version: &u32) -> bool {
    *version == initial_version()
}

pub(super) fn present<'de, D: Deserializer<'de>, T: Deserialize<'de>>(
    deserializer: D,
) -> Result<Option<T>, D::Error> {
    T::deserialize(deserializer).map(Some)
}

fn valid_description(description: Option<&str>, translations: &Translations) -> bool {
    match description {
        Some(description) => {
            valid_label(description) && valid_translations(translations, valid_label)
        }
        None => translations.is_empty(),
    }
}

pub(super) fn validate_manifest(manifest: &Manifest) -> Result<(), String> {
    if (manifest.services.is_some() || manifest.events.is_some())
        && (manifest.api_version < 2 || manifest.server.is_none())
    {
        return Err("Plugin services and events require an API version 2 server entry".into());
    }

    if let Some(services) = &manifest.services {
        if services.provides.len() > MAX_SERVICES || services.requires.len() > MAX_SERVICES {
            return Err("Provide up to 8 service contracts and 8 service dependencies".into());
        }
        let server = manifest
            .server
            .as_ref()
            .expect("service module was validated");
        let mut provides = BTreeSet::new();
        for service in &services.provides {
            let mut methods = BTreeSet::new();
            if !valid_id(&service.name)
                || !provides.insert(&service.name)
                || service.version == 0
                || service.methods.is_empty()
                || service.methods.len() > MAX_CONTRIBUTIONS
                || service
                    .methods
                    .iter()
                    .any(|method| !server.methods.contains(method) || !methods.insert(method))
                || !valid_description(
                    service.description.as_deref(),
                    &service.description_translations,
                )
            {
                return Err(format!(
                    "Invalid or duplicate plugin service contract {:?}",
                    service.name
                ));
            }
        }
        let mut requires = BTreeSet::new();
        for dependency in &services.requires {
            if !valid_id(&dependency.service)
                || dependency.min_version == 0
                || provides.contains(&dependency.service)
                || !requires.insert(&dependency.service)
            {
                return Err(format!(
                    "Invalid, duplicate or self-referencing plugin service dependency {:?}",
                    dependency.service
                ));
            }
        }
    }
    events::compile(manifest.events.as_ref()).map(|_| ())
}

pub(super) fn compile_events(manifest: &Manifest) -> Result<EventContracts, String> {
    events::compile(manifest.events.as_ref())
}

fn services(plugin: &InstalledPlugin) -> impl Iterator<Item = &ServiceContract> {
    plugin
        .manifest
        .services
        .iter()
        .flat_map(|services| &services.provides)
}

fn requirements(plugin: &InstalledPlugin) -> impl Iterator<Item = &ServiceDependency> {
    plugin
        .manifest
        .services
        .iter()
        .flat_map(|services| &services.requires)
}

fn provider<'a>(
    catalog: &'a Catalog,
    name: &str,
    except: &str,
) -> Option<(&'a InstalledPlugin, &'a ServiceContract)> {
    catalog
        .values()
        .filter(|plugin| plugin.enabled && plugin.manifest.id != except)
        .find_map(|plugin| {
            services(plugin)
                .find(|service| service.name == name)
                .map(|service| (plugin, service))
        })
}

pub(super) fn check_enable(
    catalog: &Catalog,
    plugin: &InstalledPlugin,
) -> Result<(), AppCommandError> {
    let plugin_id = &plugin.manifest.id;
    for service in services(plugin) {
        if let Some((owner, _)) = provider(catalog, &service.name, plugin_id) {
            let provider_id = &owner.manifest.id;
            return Err(AppCommandError::new(
                AppErrorCode::AlreadyExists,
                format!(
                    "Plugin {} already provides service {}",
                    provider_id, service.name
                ),
            )
            .with_i18n(
                "errors.hostPluginServiceConflict",
                BTreeMap::from([
                    ("service".into(), service.name.clone()),
                    ("providerId".into(), provider_id.clone()),
                ]),
            ));
        }
    }
    let mut missing = Vec::new();
    let mut incompatible = Vec::new();
    let mut details = Vec::new();
    for dependency in requirements(plugin).filter(|dependency| !dependency.optional) {
        match provider(catalog, &dependency.service, plugin_id) {
            None => {
                missing.push(dependency.service.as_str());
                details.push(format!("{} (missing)", dependency.service));
            }
            Some((_, service)) if service.version < dependency.min_version => {
                incompatible.push(dependency.service.as_str());
                details.push(format!(
                    "{} (needs v{}, found v{})",
                    dependency.service, dependency.min_version, service.version
                ));
            }
            Some(_) => {}
        }
    }
    if details.is_empty() {
        return Ok(());
    }
    Err(AppCommandError::new(
        AppErrorCode::DependencyMissing,
        format!("Plugin services unavailable: {}", details.join(", ")),
    )
    .with_i18n(
        "errors.hostPluginServicesUnavailable",
        BTreeMap::from([
            ("missingServices".into(), missing.join(", ")),
            ("incompatibleServices".into(), incompatible.join(", ")),
        ]),
    ))
}

pub(super) fn disable_unsatisfied(catalog: &mut Catalog) -> Vec<String> {
    let mut disabled = Vec::new();
    loop {
        let batch: Vec<_> = catalog
            .values()
            .filter(|plugin| plugin.enabled)
            .filter(|plugin| {
                requirements(plugin)
                    .filter(|dependency| !dependency.optional)
                    .any(|dependency| {
                        provider(catalog, &dependency.service, &plugin.manifest.id)
                            .is_none_or(|(_, service)| service.version < dependency.min_version)
                    })
            })
            .map(|plugin| plugin.manifest.id.clone())
            .collect();
        if batch.is_empty() {
            return disabled;
        }
        for id in &batch {
            let plugin = catalog.get_mut(id).expect("catalog entry");
            plugin.enabled = false;
            plugin.activation = Arc::new(());
        }
        disabled.extend(batch);
    }
}

pub(super) fn validate_catalog(catalog: &Catalog) -> Result<(), String> {
    for plugin in catalog.values().filter(|plugin| plugin.enabled) {
        check_enable(catalog, plugin).map_err(|error| error.message)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests;
