//! A Harness item's `server.json`, made into what the install dialog offers
//! and, once the user has chosen, into the definition that is written.
//!
//! The conversion itself is the one the official registry's servers always
//! went through (`commands::mcp::harness_install_options` /
//! `harness_install_spec`, on `build_official_install_options`), with each
//! package's version replaced by the one Harness pinned. What is decided
//! here is Harness's policy on top of it:
//!
//! - only npm packages (run with `npx -y <pkg>@<version>`) and PyPI packages
//!   (`uvx <pkg>==<version>`) are run, and only at an exact pinned version;
//! - a remote address must pass [`is_public_https`] once the user's values
//!   are in it — `remotes` and a package's own remote transport alike;
//! - a secret never goes into a URL's query string.
//!
//! Some of an option's reasons hold whatever Harness says about the version
//! (the registry, the runtime, the address); the others come from the
//! `/resolve` snapshot — the pin and its verification ([`package_reasons`])
//! — and are decided on the fresh one only.

use std::collections::BTreeMap;
use std::sync::LazyLock;

use serde_json::{Map, Value};

use crate::app_error::{AppCommandError, AppErrorCode};
use crate::commands::mcp::{
    harness_install_options, harness_install_spec, npm_identifier_has_version,
    pypi_identifier_has_version, McpMarketplaceInstallParameter,
};
use crate::commands::mcp_engine::model::{McpDefinition, McpTransport};
use crate::harness::types::{PackageState, PermissionProfile, PinnedPackage, Verified};

use super::model::{codes, OptionSource, PlanPackage, PlanParameter, Reason};
use super::remote::{host_of, is_public_https};

/// One package's pin: what Harness says the package runs at.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct Pin {
    pub registry_type: String,
    pub identifier: String,
    pub version: Option<String>,
    pub verified: Option<Verified>,
    pub has_install_script: bool,
}

impl Pin {
    /// From the `/resolve` snapshot: the pins an install may rely on.
    pub fn from_state(state: &PackageState) -> Self {
        Self {
            registry_type: state.registry_type.clone(),
            identifier: state.identifier.clone(),
            version: state.version.clone(),
            verified: Some(state.verified),
            has_install_script: state.has_install_script,
        }
    }

    /// From the install info, which may come through a cache: good for the
    /// preflight's definition, never for a decision.
    pub fn from_info(package: &PinnedPackage) -> Self {
        Self {
            registry_type: package.registry_type.clone(),
            identifier: package.identifier.clone(),
            version: package.version.clone(),
            verified: Some(package.verified),
            has_install_script: package.has_install_script.unwrap_or(false),
        }
    }
}

/// The pin of `identifier` at `registry_type`: as written, else ignoring
/// case (registries compare names that way).
pub(super) fn find_pin<'a>(
    pins: &'a [Pin],
    registry_type: &str,
    identifier: &str,
) -> Option<&'a Pin> {
    pins.iter()
        .find(|pin| pin.registry_type == registry_type && pin.identifier == identifier)
        .or_else(|| {
            pins.iter().find(|pin| {
                pin.registry_type.eq_ignore_ascii_case(registry_type)
                    && pin.identifier.eq_ignore_ascii_case(identifier)
            })
        })
}

/// The package an option comes from, as the server.json names it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct PackageRef {
    pub registry_type: String,
    pub identifier: String,
    pub runtime: Option<String>,
    /// Its runtime arguments, by name (or value hint, or value).
    pub runtime_arguments: Vec<String>,
    /// The names of the environment variables it declares.
    pub environment: Vec<String>,
}

/// One option of a server.json, with what holds of it whatever the
/// snapshot says.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct Analyzed {
    pub id: String,
    pub transport: McpTransport,
    pub source: OptionSource,
    pub package: Option<PackageRef>,
    /// With the defaults filled in.
    pub definition: Option<McpDefinition>,
    /// The address as the server.json writes it, placeholders and all.
    pub url: Option<String>,
    pub parameters: Vec<PlanParameter>,
    pub blocking: Vec<Reason>,
    pub warnings: Vec<Reason>,
}

/// `official:<source>:<index>:<protocol>`.
pub(super) fn parse_option_id(id: &str) -> Option<(OptionSource, usize)> {
    let mut parts = id.split(':');
    if parts.next()? != "official" {
        return None;
    }
    let source = match parts.next()? {
        "package" => OptionSource::Package,
        "remote" => OptionSource::Remote,
        _ => return None,
    };
    Some((source, parts.next()?.parse().ok()?))
}

fn text_at<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
}

fn package_ref(server: &Value, index: usize) -> Option<PackageRef> {
    let package = server.get("packages")?.as_array()?.get(index)?;
    // A list of inputs, or a map of them by name, as the converter reads both.
    let listed = |key: &str| -> Vec<(Option<String>, &Value)> {
        match package.get(key) {
            Some(Value::Array(items)) => items.iter().map(|item| (None, item)).collect(),
            Some(Value::Object(items)) => items
                .iter()
                .map(|(name, item)| (Some(name.clone()), item))
                .collect(),
            _ => Vec::new(),
        }
    };
    let runtime_arguments = listed("runtimeArguments")
        .into_iter()
        .map(|(named, argument)| {
            named
                .or_else(|| {
                    ["name", "valueHint", "value"]
                        .iter()
                        .find_map(|key| text_at(argument, key))
                        .map(str::to_string)
                })
                .unwrap_or_else(|| "positional".to_string())
        })
        .collect();
    let environment = listed("environmentVariables")
        .into_iter()
        .filter_map(|(named, variable)| {
            named.or_else(|| text_at(variable, "name").map(str::to_string))
        })
        .collect();
    Some(PackageRef {
        registry_type: text_at(package, "registryType")
            .unwrap_or_default()
            .to_string(),
        identifier: text_at(package, "identifier")?.to_string(),
        runtime: text_at(package, "runtimeHint").map(str::to_string),
        runtime_arguments,
        environment,
    })
}

/// An environment variable the runner reads for itself: where packages come
/// from, what is loaded before the package, which interpreter paths count.
pub(super) fn steers_the_runner(name: &str) -> bool {
    let name = name.trim().to_ascii_uppercase();
    name.starts_with("NPM_CONFIG_")
        || name.starts_with("UV_")
        || name.starts_with("PIP_")
        || matches!(
            name.as_str(),
            "NODE_OPTIONS" | "NODE_PATH" | "PYTHONPATH" | "PYTHONHOME" | "PYTHONSTARTUP"
        )
}

/// The address a remote option's transport is written with.
fn template_url(server: &Value, source: OptionSource, index: usize) -> Option<String> {
    let transport = match source {
        OptionSource::Remote => server.get("remotes")?.as_array()?.get(index)?,
        OptionSource::Package => server
            .get("packages")?
            .as_array()?
            .get(index)?
            .get("transport")?,
    };
    text_at(transport, "url").map(str::to_string)
}

fn transport_of(protocol: &str) -> Option<McpTransport> {
    match protocol {
        "stdio" => Some(McpTransport::Stdio),
        "http" => Some(McpTransport::Http),
        "sse" => Some(McpTransport::Sse),
        _ => None,
    }
}

/// The runtime Harness runs a registry's packages with.
fn standard_runtime(registry_type: &str) -> Option<&'static str> {
    match registry_type {
        "npm" => Some("npx"),
        "pypi" => Some("uvx"),
        _ => None,
    }
}

/// Where `{name}` (or `{{name}}`) sits in `url` before its query: where a
/// secret may go.
fn placeholder_outside_query(url: &str, name: &str) -> bool {
    let query = url.find(['?', '#']).unwrap_or(url.len());
    [format!("{{{{{name}}}}}"), format!("{{{name}}}")]
        .iter()
        .any(|placeholder| {
            url.match_indices(placeholder.as_str())
                .any(|(at, _)| at < query)
        })
}

fn default_text(value: &Value) -> Option<String> {
    match value {
        Value::String(text) => Some(text.clone()),
        Value::Null => None,
        Value::Number(_) | Value::Bool(_) => Some(value.to_string()),
        Value::Array(_) | Value::Object(_) => serde_json::to_string(value).ok(),
    }
}

fn plan_parameter(parameter: &McpMarketplaceInstallParameter) -> PlanParameter {
    PlanParameter {
        key: parameter.key.clone(),
        name: parameter.label.clone(),
        location: parameter
            .location
            .clone()
            .unwrap_or_else(|| "arg".to_string()),
        description: parameter.description.clone(),
        required: parameter.required,
        secret: parameter.secret,
        kind: parameter.kind.clone(),
        default: parameter.default_value.as_ref().and_then(default_text),
        placeholder: parameter.placeholder.clone(),
        choices: parameter.enum_values.clone(),
        current: None,
    }
}

/// A URL variable's own name.
fn variable_name(parameter: &PlanParameter) -> Option<&str> {
    parameter.key.strip_prefix("variables.")
}

/// What can be told of a remote address before the user's values are in
/// it: `None` when its host is still a placeholder (the URL standard takes
/// `{host}` for a host name, so it would be judged as one).
fn remote_reason_now(url: &str) -> Option<Reason> {
    let host_pending = match url::Url::parse(url) {
        Ok(parsed) => parsed
            .host_str()
            .is_some_and(|host| host.contains(['{', '}'])),
        Err(_) => url.contains('{'),
    };
    (!host_pending && !is_public_https(url))
        .then(|| Reason::new(codes::REMOTE_NOT_PUBLIC).param("host", host_of(url)))
}

fn package_reason(code: &str, package: &PackageRef) -> Reason {
    Reason::new(code)
        .param("registry_type", package.registry_type.clone())
        .param("identifier", package.identifier.clone())
}

/// Every option of `server` (a server.json), converted with `pins`, with the
/// reasons that hold whatever the snapshot says. `Err` is the item's own
/// blocking reason: nothing to install, or a server.json that cannot be
/// read.
pub(super) fn analyze(server: &Value, pins: &[Pin]) -> Result<Vec<Analyzed>, Reason> {
    let pin = |registry_type: &str, identifier: &str| {
        find_pin(pins, registry_type, identifier).and_then(|pin| pin.version.clone())
    };
    let options = harness_install_options(server, &pin).map_err(|error| {
        if matches!(error.code, AppErrorCode::NotFound) {
            Reason::new(codes::NOTHING_TO_INSTALL)
        } else {
            Reason::new(codes::SERVER_UNREADABLE).detail(error.message)
        }
    })?;

    let mut out = Vec::new();
    for option in options {
        let (Some((source, index)), Some(transport)) =
            (parse_option_id(&option.id), transport_of(&option.protocol))
        else {
            continue;
        };
        let package = match source {
            OptionSource::Package => package_ref(server, index),
            OptionSource::Remote => None,
        };
        let definition = serde_json::from_value::<McpDefinition>(option.spec.clone()).ok();
        let url = transport
            .is_remote()
            .then(|| template_url(server, source, index))
            .flatten();
        let mut blocking = Vec::new();
        let mut warnings = Vec::new();
        let mut parameters = Vec::new();

        for parameter in option.parameters.iter().map(plan_parameter) {
            // A URL variable that is a secret goes only where the template
            // puts it outside the query; anywhere else, not at all.
            if let (Some(name), Some(url), true) =
                (variable_name(&parameter), url.as_deref(), parameter.secret)
            {
                if !placeholder_outside_query(url, name) {
                    if parameter.required {
                        blocking.push(Reason::new(codes::SECRET_IN_QUERY).param("name", name));
                    } else {
                        warnings.push(Reason::new(codes::SECRET_NOT_SENT).param("name", name));
                        continue;
                    }
                }
            }
            parameters.push(parameter);
        }

        if transport == McpTransport::Stdio {
            match &package {
                None => blocking.push(Reason::new(codes::SERVER_UNREADABLE)),
                Some(package) => match standard_runtime(&package.registry_type) {
                    None => blocking.push(
                        Reason::new(codes::REGISTRY_UNSUPPORTED)
                            .param("registry_type", package.registry_type.clone()),
                    ),
                    Some(runtime) => {
                        if let Some(hint) =
                            package.runtime.as_deref().filter(|hint| *hint != runtime)
                        {
                            blocking.push(
                                Reason::new(codes::RUNTIME_UNSUPPORTED)
                                    .param("registry_type", package.registry_type.clone())
                                    .param("runtime", hint),
                            );
                        }
                        let has_version = if runtime == "npx" {
                            npm_identifier_has_version(&package.identifier)
                                || package.identifier.starts_with("http")
                        } else {
                            pypi_identifier_has_version(&package.identifier)
                        };
                        if has_version {
                            blocking.push(package_reason(codes::IDENTIFIER_HAS_VERSION, package));
                        }
                        // The runner executes the first operand it is not told
                        // otherwise about: nothing may come before the pinned
                        // package.
                        if let Some(argument) = package.runtime_arguments.first() {
                            blocking.push(
                                package_reason(codes::RUNTIME_ARGUMENTS_UNSUPPORTED, package)
                                    .param("argument", argument.clone()),
                            );
                        }
                        for name in package
                            .environment
                            .iter()
                            .filter(|name| steers_the_runner(name))
                        {
                            blocking.push(
                                Reason::new(codes::RUNNER_ENVIRONMENT_UNSUPPORTED)
                                    .param("name", name.clone()),
                            );
                        }
                    }
                },
            }
        } else if let Some((written, _)) = definition.as_ref().and_then(McpDefinition::remote) {
            blocking.extend(remote_reason_now(written));
        }

        out.push(Analyzed {
            id: option.id,
            transport,
            source,
            package,
            definition,
            url,
            parameters,
            blocking,
            warnings,
        });
    }
    if out.is_empty() {
        return Err(Reason::new(codes::NOTHING_TO_INSTALL));
    }
    Ok(out)
}

/// PEP 440's version scheme, as `packaging` reads it, without the leading
/// `v` and the surrounding space it forgives: one exact version, no
/// wildcard, no range.
static PEP440: LazyLock<regex::Regex> = LazyLock::new(|| {
    regex::Regex::new(
        r"(?i)^(?:[0-9]+!)?[0-9]+(?:\.[0-9]+)*(?:[-_.]?(?:a|b|c|rc|alpha|beta|pre|preview)[-_.]?[0-9]*)?(?:-[0-9]+|[-_.]?(?:post|rev|r)[-_.]?[0-9]*)?(?:[-_.]?dev[-_.]?[0-9]*)?(?:\+[a-z0-9]+(?:[-_.][a-z0-9]+)*)?$",
    )
    .expect("the PEP 440 pattern compiles")
});

/// Whether `version` names exactly one release at `registry_type`: not
/// empty, not `latest`, not a range or a tag.
pub(crate) fn is_exact_version(registry_type: &str, version: &str) -> bool {
    if version.is_empty() || version.trim() != version || version.eq_ignore_ascii_case("latest") {
        return false;
    }
    match registry_type {
        "npm" => semver::Version::parse(version).is_ok(),
        "pypi" => PEP440.is_match(version),
        _ => {
            version.starts_with(|c: char| c.is_ascii_digit())
                && version
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || b".-+_".contains(&byte))
        }
    }
}

/// What the snapshot makes of an option's package: blocking reasons and
/// warnings. Nothing for an option without a package.
pub(super) fn package_reasons(
    option: &Analyzed,
    pins: &[Pin],
    permissions: Option<&PermissionProfile>,
) -> (Vec<Reason>, Vec<Reason>) {
    let mut blocking = Vec::new();
    let mut warnings = Vec::new();
    let Some(package) = &option.package else {
        return (blocking, warnings);
    };
    let Some(pin) = find_pin(pins, &package.registry_type, &package.identifier) else {
        blocking.push(package_reason(codes::PACKAGE_NOT_PINNED, package));
        return (blocking, warnings);
    };
    let version = pin.version.clone().unwrap_or_default();
    let with_version = |code: &str| package_reason(code, package).param("version", version.clone());
    if !is_exact_version(&package.registry_type, &version) {
        blocking.push(with_version(codes::PACKAGE_VERSION_INEXACT));
    }
    match pin.verified {
        Some(Verified::Ok) => {}
        Some(Verified::Missing) => blocking.push(with_version(codes::PACKAGE_MISSING)),
        Some(verified @ (Verified::Pending | Verified::Unchecked)) => {
            warnings.push(with_version(codes::VERSION_UNVERIFIED).param(
                "verified",
                if verified == Verified::Pending {
                    "pending"
                } else {
                    "unchecked"
                },
            ))
        }
        Some(Verified::Unknown) | None => {
            blocking.push(with_version(codes::PACKAGE_VERIFICATION_UNKNOWN))
        }
    }
    let named = format!("{}:{}", package.registry_type, package.identifier);
    let in_profile = permissions.is_some_and(|profile| {
        [&profile.declared, &profile.detected].iter().any(|listed| {
            listed
                .install_scripts
                .iter()
                .any(|entry| entry.eq_ignore_ascii_case(&named))
        })
    });
    if pin.has_install_script || in_profile {
        warnings.push(package_reason(codes::INSTALL_SCRIPT, package));
    }
    (blocking, warnings)
}

/// The option's package as the dialog shows it.
pub(super) fn plan_package(option: &Analyzed, pins: &[Pin]) -> Option<PlanPackage> {
    let package = option.package.as_ref()?;
    let pin = find_pin(pins, &package.registry_type, &package.identifier);
    Some(PlanPackage {
        registry_type: package.registry_type.clone(),
        identifier: package.identifier.clone(),
        version: pin.and_then(|pin| pin.version.clone()),
        verified: pin.and_then(|pin| pin.verified),
        has_install_script: pin.is_some_and(|pin| pin.has_install_script),
        runtime: package.runtime.clone(),
    })
}

fn conversion_failed(error: &AppCommandError) -> Reason {
    if error.i18n_key.as_deref() == Some("errors.secretInQuery") {
        let name = error
            .i18n_params
            .as_ref()
            .and_then(|params| params.get("name").cloned())
            .unwrap_or_default();
        return Reason::new(codes::SECRET_IN_QUERY).param("name", name);
    }
    Reason::new(codes::CONVERSION_FAILED).detail(error.message.clone())
}

/// The definition `option` makes with the user's `values` and `pins`.
///
/// `strict` (the commit): a package must run exactly at its pinned version
/// with its registry's runtime. A remote address is checked either way, now
/// that the values are in it.
pub(super) fn build(
    server: &Value,
    pins: &[Pin],
    option: &Analyzed,
    values: &BTreeMap<String, String>,
    strict: bool,
) -> Result<McpDefinition, Vec<Reason>> {
    let given = |key: &str| {
        values
            .get(key)
            .map(|value| value.trim())
            .filter(|value| !value.is_empty())
    };
    let missing: Vec<Reason> = option
        .parameters
        .iter()
        .filter(|parameter| {
            parameter.required && given(&parameter.key).is_none() && parameter.default.is_none()
        })
        .map(|parameter| Reason::new(codes::PARAMETER_REQUIRED).param("key", parameter.key.clone()))
        .collect();
    if !missing.is_empty() {
        return Err(missing);
    }
    // Only what the option offers reaches the conversion.
    let offered: Map<String, Value> = option
        .parameters
        .iter()
        .filter_map(|parameter| {
            given(&parameter.key)
                .map(|value| (parameter.key.clone(), Value::String(value.to_string())))
        })
        .collect();
    let pin = |registry_type: &str, identifier: &str| {
        find_pin(pins, registry_type, identifier).and_then(|pin| pin.version.clone())
    };
    let spec = harness_install_spec(server, &pin, &option.id, offered)
        .map_err(|error| vec![conversion_failed(&error)])?;
    let definition: McpDefinition = serde_json::from_value(spec)
        .map_err(|error| vec![Reason::new(codes::CONVERSION_FAILED).detail(error.to_string())])?;

    match &definition {
        McpDefinition::Stdio { command, args, env } => {
            if let (true, Some(package)) = (strict, &option.package) {
                let version = find_pin(pins, &package.registry_type, &package.identifier)
                    .and_then(|pin| pin.version.clone())
                    .filter(|version| is_exact_version(&package.registry_type, version));
                let expected = match (standard_runtime(&package.registry_type), version) {
                    (Some("npx"), Some(version)) => {
                        Some(("npx", format!("{}@{version}", package.identifier)))
                    }
                    (Some("uvx"), Some(version)) => {
                        Some(("uvx", format!("{}=={version}", package.identifier)))
                    }
                    _ => None,
                };
                // Exactly `npx -y <pkg>@<pin> …` or `uvx <pkg>==<pin> …`: the
                // operand the runner executes is the pinned package, with
                // nothing before it that could choose another (`-p`,
                // `--package`, `-c`, `--from`, `--with`, an operand), and
                // nothing in its environment that configures the runner.
                let runs_the_pin = expected.is_some_and(|(runtime, spec)| {
                    let operand = if runtime == "npx" {
                        args.first()
                            .filter(|arg| *arg == "-y")
                            .and_then(|_| args.get(1))
                    } else {
                        args.first()
                    };
                    command == runtime && operand == Some(&spec)
                });
                let steered = env.keys().any(|name| steers_the_runner(name));
                if !runs_the_pin || steered {
                    return Err(vec![Reason::new(codes::CONVERSION_FAILED)
                        .detail("the command would not run the pinned version")]);
                }
            }
        }
        McpDefinition::Http { url, .. } | McpDefinition::Sse { url, .. } => {
            // A variable left in the address was not given a value.
            let unfilled: Vec<Reason> = option
                .parameters
                .iter()
                .filter(|parameter| {
                    variable_name(parameter)
                        .is_some_and(|name| url.contains(&format!("{{{name}}}")))
                })
                .map(|parameter| {
                    Reason::new(codes::PARAMETER_REQUIRED).param("key", parameter.key.clone())
                })
                .collect();
            if !unfilled.is_empty() {
                return Err(unfilled);
            }
            // One the server.json does not declare: nothing can fill it.
            if url.contains('{') && url.contains('}') {
                return Err(vec![Reason::new(codes::CONVERSION_FAILED)
                    .detail("the address still holds a placeholder")]);
            }
            if !is_public_https(url) {
                return Err(vec![
                    Reason::new(codes::REMOTE_NOT_PUBLIC).param("host", host_of(url))
                ]);
            }
        }
    }
    Ok(definition)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn pin(
        registry_type: &str,
        identifier: &str,
        version: Option<&str>,
        verified: Verified,
    ) -> Pin {
        Pin {
            registry_type: registry_type.to_string(),
            identifier: identifier.to_string(),
            version: version.map(str::to_string),
            verified: Some(verified),
            has_install_script: false,
        }
    }

    fn codes_of(reasons: &[Reason]) -> Vec<&str> {
        reasons.iter().map(|reason| reason.code.as_str()).collect()
    }

    #[test]
    fn exact_versions_by_registry() {
        for good in ["1.2.3", "0.0.1-beta.1", "1.2.3+build.5"] {
            assert!(is_exact_version("npm", good), "{good}");
        }
        for bad in [
            "", "latest", "LATEST", "^1.2.3", "~1.2", "1.2", "1.x", ">=1", "v1.2.3", " 1.2.3",
            "next",
        ] {
            assert!(!is_exact_version("npm", bad), "{bad:?}");
        }
        for good in [
            "1.0",
            "2025.4.7",
            "1.2.3rc1",
            "1.0.post2",
            "1.0.dev3",
            "1!2.0",
            "1.0+local.1",
        ] {
            assert!(is_exact_version("pypi", good), "{good}");
        }
        for bad in [
            "",
            "latest",
            "1.*",
            ">=1.0",
            "==1.0",
            "1.0,<2",
            "v1.0 ",
            "1.0 ; python_version>'3'",
        ] {
            assert!(!is_exact_version("pypi", bad), "{bad:?}");
        }
    }

    #[test]
    fn a_pin_is_found_by_registry_and_name() {
        let pins = [pin("npm", "@Some/Notes", Some("1.0.0"), Verified::Ok)];
        assert!(find_pin(&pins, "npm", "@Some/Notes").is_some());
        assert!(find_pin(&pins, "npm", "@some/notes").is_some());
        assert!(find_pin(&pins, "pypi", "@some/notes").is_none());
    }

    #[test]
    fn only_npm_and_pypi_packages_run_and_only_with_their_runtime() {
        let server = json!({
            "name": "x",
            "packages": [
                { "registryType": "npm", "identifier": "@a/one", "transport": { "type": "stdio" } },
                { "registryType": "npm", "identifier": "@a/two", "runtimeHint": "npx", "transport": { "type": "stdio" } },
                { "registryType": "npm", "identifier": "@a/three", "runtimeHint": "bunx", "transport": { "type": "stdio" } },
                { "registryType": "pypi", "identifier": "four", "runtimeHint": "uvx", "transport": { "type": "stdio" } },
                { "registryType": "oci", "identifier": "a/five", "runtimeHint": "docker", "transport": { "type": "stdio" } },
                { "registryType": "npm", "identifier": "six@1.0.0", "transport": { "type": "stdio" } }
            ]
        });
        let options = analyze(&server, &[]).unwrap();
        let blocking: Vec<Vec<&str>> = options
            .iter()
            .map(|option| codes_of(&option.blocking))
            .collect();
        assert_eq!(
            blocking,
            vec![
                vec![],
                vec![],
                vec![codes::RUNTIME_UNSUPPORTED],
                vec![],
                vec![codes::REGISTRY_UNSUPPORTED],
                vec![codes::IDENTIFIER_HAS_VERSION],
            ]
        );
        assert_eq!(options[2].blocking[0].params["runtime"], "bunx");
    }

    #[test]
    fn the_snapshot_decides_the_pin_and_its_verification() {
        let server = json!({
            "name": "x",
            "packages": [{ "registryType": "npm", "identifier": "notes", "transport": { "type": "stdio" } }]
        });
        let permissions: PermissionProfile = serde_json::from_value(json!({
            "declared": {}, "detected": { "installScripts": ["npm:notes"] }
        }))
        .unwrap();
        let cases: Vec<(Vec<Pin>, Vec<&str>, Vec<&str>)> = vec![
            (vec![], vec![codes::PACKAGE_NOT_PINNED], vec![]),
            (
                vec![pin("npm", "notes", None, Verified::Ok)],
                vec![codes::PACKAGE_VERSION_INEXACT],
                vec![],
            ),
            (
                vec![pin("npm", "notes", Some("latest"), Verified::Ok)],
                vec![codes::PACKAGE_VERSION_INEXACT],
                vec![],
            ),
            (
                vec![pin("npm", "notes", Some("1.0.0"), Verified::Missing)],
                vec![codes::PACKAGE_MISSING],
                vec![],
            ),
            (
                vec![pin("npm", "notes", Some("1.0.0"), Verified::Unknown)],
                vec![codes::PACKAGE_VERIFICATION_UNKNOWN],
                vec![],
            ),
            (
                vec![pin("npm", "notes", Some("1.0.0"), Verified::Pending)],
                vec![],
                vec![codes::VERSION_UNVERIFIED],
            ),
            (
                vec![pin("npm", "notes", Some("1.0.0"), Verified::Unchecked)],
                vec![],
                vec![codes::VERSION_UNVERIFIED],
            ),
            (
                vec![pin("npm", "notes", Some("1.0.0"), Verified::Ok)],
                vec![],
                vec![],
            ),
        ];
        for (pins, blocking, warnings) in cases {
            let option = &analyze(&server, &pins).unwrap()[0];
            let (found_blocking, found_warnings) = package_reasons(option, &pins, None);
            assert_eq!(codes_of(&found_blocking), blocking, "{pins:?}");
            assert_eq!(codes_of(&found_warnings), warnings, "{pins:?}");
        }
        // install scripts: from the package, or from the permissions profile
        let pins = vec![pin("npm", "notes", Some("1.0.0"), Verified::Ok)];
        let option = &analyze(&server, &pins).unwrap()[0];
        let (_, warnings) = package_reasons(option, &pins, Some(&permissions));
        assert_eq!(codes_of(&warnings), [codes::INSTALL_SCRIPT]);
        let mut scripted = pins.clone();
        scripted[0].has_install_script = true;
        let (_, warnings) = package_reasons(option, &scripted, None);
        assert_eq!(codes_of(&warnings), [codes::INSTALL_SCRIPT]);
    }

    #[test]
    fn a_remote_address_is_checked_before_and_after_the_values_are_in_it() {
        let server = json!({
            "name": "x",
            "remotes": [
                { "type": "streamable-http", "url": "https://mcp.example.com/mcp" },
                { "type": "streamable-http", "url": "http://mcp.example.com/mcp" },
                { "type": "sse", "url": "https://10.0.0.5/sse" },
                { "type": "streamable-http", "url": "https://user:pw@mcp.example.com/mcp" },
                { "type": "streamable-http", "url": "https://{host}/mcp",
                  "variables": { "host": { "isRequired": true } } }
            ],
            "packages": [
                { "registryType": "npm", "identifier": "notes",
                  "transport": { "type": "streamable-http", "url": "http://localhost:3000/mcp" } }
            ]
        });
        let options = analyze(&server, &[]).unwrap();
        let by_id: BTreeMap<&str, Vec<&str>> = options
            .iter()
            .map(|option| (option.id.as_str(), codes_of(&option.blocking)))
            .collect();
        assert_eq!(by_id["official:remote:0:http"], Vec::<&str>::new());
        assert_eq!(by_id["official:remote:1:http"], [codes::REMOTE_NOT_PUBLIC]);
        assert_eq!(by_id["official:remote:2:sse"], [codes::REMOTE_NOT_PUBLIC]);
        assert_eq!(by_id["official:remote:3:http"], [codes::REMOTE_NOT_PUBLIC]);
        // the host is a placeholder: decided at the install
        assert_eq!(by_id["official:remote:4:http"], Vec::<&str>::new());
        // a package's own remote transport is checked as well
        assert_eq!(by_id["official:package:0:http"], [codes::REMOTE_NOT_PUBLIC]);

        let templated = options
            .iter()
            .find(|option| option.id == "official:remote:4:http")
            .unwrap();
        assert_eq!(templated.url.as_deref(), Some("https://{host}/mcp"));
        for (host, ok) in [
            ("mcp.example.com", true),
            ("127.0.0.1", false),
            ("intranet", false),
            ("printer.local", false),
        ] {
            let values = BTreeMap::from([("variables.host".to_string(), host.to_string())]);
            let built = build(&server, &[], templated, &values, true);
            match (built, ok) {
                (Ok(definition), true) => assert_eq!(
                    definition.remote().unwrap().0,
                    format!("https://{host}/mcp")
                ),
                (Err(reasons), false) => {
                    assert_eq!(codes_of(&reasons), [codes::REMOTE_NOT_PUBLIC], "{host}");
                    assert_eq!(reasons[0].params["host"], host);
                }
                (other, _) => panic!("{host}: {other:?}"),
            }
        }
        let built = build(&server, &[], templated, &BTreeMap::new(), true).unwrap_err();
        assert_eq!(codes_of(&built), [codes::PARAMETER_REQUIRED]);
    }

    /// Review finding: addresses the site's rule lets through — a trailing
    /// dot, IPv4 in IPv6, link-local past `fe80:`, reserved ranges — are not
    /// public, in `remotes` and in a package's own transport alike, written
    /// as such or filled in by the user.
    #[test]
    fn addresses_the_site_lets_through_are_refused_before_and_after_the_values_are_in() {
        let templated = json!({ "host": { "isRequired": true } });
        let server = json!({
            "name": "x",
            "remotes": [
                { "type": "streamable-http", "url": "https://localhost./mcp" },
                { "type": "streamable-http", "url": "https://[::ffff:127.0.0.1]/mcp" },
                { "type": "sse", "url": "https://198.18.0.1/sse" },
                { "type": "streamable-http", "url": "https://{host}/mcp", "variables": templated }
            ],
            "packages": [
                { "registryType": "npm", "identifier": "notes",
                  "transport": { "type": "streamable-http", "url": "https://[fe81::1]/mcp" } },
                { "registryType": "npm", "identifier": "notes",
                  "transport": { "type": "sse", "url": "https://{host}/sse", "variables": templated } }
            ]
        });
        let options = analyze(&server, &[]).unwrap();
        let by_id: BTreeMap<&str, Vec<&str>> = options
            .iter()
            .map(|option| (option.id.as_str(), codes_of(&option.blocking)))
            .collect();
        for id in [
            "official:remote:0:http",
            "official:remote:1:http",
            "official:remote:2:sse",
            "official:package:0:http",
        ] {
            assert_eq!(by_id[id], [codes::REMOTE_NOT_PUBLIC], "{id}");
        }
        for id in ["official:remote:3:http", "official:package:1:sse"] {
            assert!(by_id[id].is_empty(), "{id}: decided once the host is in");
            let option = options.iter().find(|option| option.id == id).unwrap();
            for host in [
                "localhost.",
                "app.localhost.",
                "198.18.0.5",
                "192.0.2.10",
                "203.0.113.4",
                "100.64.0.1",
            ] {
                let values = BTreeMap::from([("variables.host".to_string(), host.to_string())]);
                let refused = build(&server, &[], option, &values, true).unwrap_err();
                assert_eq!(
                    codes_of(&refused),
                    [codes::REMOTE_NOT_PUBLIC],
                    "{id} {host}"
                );
            }
            let values =
                BTreeMap::from([("variables.host".to_string(), "mcp.example.com.".to_string())]);
            assert!(build(&server, &[], option, &values, true).is_ok(), "{id}");
        }
    }

    /// The values a parameter may take, as the server.json lists them —
    /// read leniently, so a list the registry did not mean as text never
    /// loses the parameter.
    #[test]
    fn a_parameter_offers_its_choices() {
        let server = json!({
            "name": "x",
            "packages": [{
                "registryType": "npm", "identifier": "notes", "transport": { "type": "stdio" },
                "environmentVariables": [
                    { "name": "NOTES_MODE", "choices": ["fast", "slow"] },
                    { "name": "NOTES_LEVEL", "choices": [1, 2, true, { "x": 1 }] },
                    { "name": "NOTES_DIR", "choices": "fast" }
                ],
                "packageArguments": [{ "type": "positional", "valueHint": "format", "choices": ["md", "txt"] }]
            }],
            "remotes": [{
                "type": "streamable-http", "url": "https://mcp.example.com/{region}/mcp",
                "variables": { "region": { "choices": ["eu", "us"] } },
                "headers": [{ "name": "X-Tier", "choices": ["free", "pro"] }]
            }]
        });
        let options = analyze(&server, &[]).unwrap();
        let choices = |option: &Analyzed| -> Vec<(String, Vec<String>)> {
            option
                .parameters
                .iter()
                .map(|parameter| (parameter.key.clone(), parameter.choices.clone()))
                .collect()
        };
        let strings = |items: &[&str]| {
            items
                .iter()
                .map(|item| item.to_string())
                .collect::<Vec<_>>()
        };
        assert_eq!(
            choices(&options[0]),
            [
                ("package_arguments.0".to_string(), strings(&["md", "txt"])),
                ("env.NOTES_MODE".to_string(), strings(&["fast", "slow"])),
                ("env.NOTES_LEVEL".to_string(), strings(&["1", "2", "true"])),
                ("env.NOTES_DIR".to_string(), vec![]),
            ]
        );
        assert_eq!(
            choices(&options[1]),
            [
                ("headers.X-Tier".to_string(), strings(&["free", "pro"])),
                ("variables.region".to_string(), strings(&["eu", "us"])),
            ]
        );
        assert!(options
            .iter()
            .flat_map(|option| &option.parameters)
            .all(|parameter| parameter.current.is_none()));
    }

    #[test]
    fn secrets_stay_out_of_the_query_string() {
        let server = json!({
            "name": "x",
            "remotes": [
                { "type": "streamable-http", "url": "https://mcp.example.com/{token}/mcp",
                  "variables": { "token": { "isSecret": true, "isRequired": true } } },
                { "type": "streamable-http", "url": "https://mcp.example.com/mcp?key={key}",
                  "variables": { "key": { "isSecret": true, "isRequired": true } } },
                { "type": "streamable-http", "url": "https://mcp.example.com/mcp",
                  "variables": { "api_key": { "isRequired": false }, "region": {} } }
            ]
        });
        let options = analyze(&server, &[]).unwrap();
        assert!(options[0].blocking.is_empty());
        assert_eq!(options[0].parameters[0].key, "variables.token");
        assert_eq!(codes_of(&options[1].blocking), [codes::SECRET_IN_QUERY]);
        assert_eq!(options[1].blocking[0].params["name"], "key");
        // optional, named like a secret, and with nowhere to go but the
        // query: left out, and said so
        assert!(options[2].blocking.is_empty());
        assert_eq!(codes_of(&options[2].warnings), [codes::SECRET_NOT_SENT]);
        let offered: Vec<&str> = options[2]
            .parameters
            .iter()
            .map(|p| p.key.as_str())
            .collect();
        assert_eq!(offered, ["variables.region"]);
        // even when the call names it, it is not sent
        let values = BTreeMap::from([
            ("variables.api_key".to_string(), "s3cret".to_string()),
            ("variables.region".to_string(), "eu".to_string()),
        ]);
        let definition = build(&server, &[], &options[2], &values, true).unwrap();
        assert_eq!(
            definition.remote().unwrap().0,
            "https://mcp.example.com/mcp?region=eu"
        );

        let values = BTreeMap::from([("variables.token".to_string(), "s3cret".to_string())]);
        let definition = build(&server, &[], &options[0], &values, true).unwrap();
        assert_eq!(
            definition.remote().unwrap().0,
            "https://mcp.example.com/s3cret/mcp"
        );
    }

    /// Review finding: `npx -y other-mcp@latest @scope/notes@1.2.3` holds the
    /// pinned spec, but npx runs `other-mcp@latest`. Nothing may come before
    /// the pinned package, and nothing may configure the runner.
    #[test]
    fn nothing_before_the_pinned_package_can_choose_what_runs() {
        let npm = |extra: Value| {
            let mut package = json!({ "registryType": "npm", "identifier": "@scope/notes",
                                       "transport": { "type": "stdio" } });
            package
                .as_object_mut()
                .unwrap()
                .extend(extra.as_object().unwrap().clone());
            package
        };
        let pypi = |extra: Value| {
            let mut package = json!({ "registryType": "pypi", "identifier": "notes",
                                       "transport": { "type": "stdio" } });
            package
                .as_object_mut()
                .unwrap()
                .extend(extra.as_object().unwrap().clone());
            package
        };
        let server = json!({ "name": "x", "packages": [
            npm(json!({ "runtimeArguments": [{ "type": "positional", "value": "other-mcp@latest" }] })),
            npm(json!({ "runtimeArguments": [{ "type": "named", "name": "--package", "value": "other-mcp" }] })),
            npm(json!({ "runtimeArguments": [{ "type": "named", "name": "-c", "value": "other-mcp" }] })),
            npm(json!({ "runtimeArguments": [{ "type": "positional", "valueHint": "tool", "isRequired": true }] })),
            pypi(json!({ "runtimeArguments": [{ "type": "named", "name": "--from", "value": "other-mcp" }] })),
            pypi(json!({ "runtimeArguments": [{ "type": "named", "name": "--with", "value": "other-mcp" }] })),
            npm(json!({ "environmentVariables": [{ "name": "npm_config_registry",
                                                    "default": "https://registry.elsewhere.example" }] })),
            pypi(json!({ "environmentVariables": [{ "name": "UV_INDEX_URL",
                                                     "default": "https://elsewhere.example/simple" }] })),
            npm(json!({ "environmentVariables": [{ "name": "NODE_OPTIONS", "default": "--require ./x.js" }] })),
        ]});
        let pins = vec![
            pin("npm", "@scope/notes", Some("1.2.3"), Verified::Ok),
            pin("pypi", "notes", Some("1.0.0"), Verified::Ok),
        ];
        let options = analyze(&server, &pins).unwrap();
        assert_eq!(options.len(), 9);
        // what the review saw: the pinned spec is there, but not what runs
        assert_eq!(
            options[0].definition,
            Some(McpDefinition::Stdio {
                command: "npx".into(),
                args: vec![
                    "-y".into(),
                    "other-mcp@latest".into(),
                    "@scope/notes@1.2.3".into()
                ],
                env: BTreeMap::new(),
            })
        );
        for option in &options[..6] {
            assert_eq!(
                codes_of(&option.blocking),
                [codes::RUNTIME_ARGUMENTS_UNSUPPORTED],
                "{}",
                option.id
            );
        }
        assert_eq!(
            options[0].blocking[0].params["argument"],
            "other-mcp@latest"
        );
        assert_eq!(options[1].blocking[0].params["argument"], "--package");
        for option in &options[6..] {
            assert_eq!(
                codes_of(&option.blocking),
                [codes::RUNNER_ENVIRONMENT_UNSUPPORTED],
                "{}",
                option.id
            );
        }
        assert_eq!(options[6].blocking[0].params["name"], "npm_config_registry");

        // The commit refuses them itself, whatever the plan said — with the
        // user's own value in a runtime argument too.
        let values = BTreeMap::from([(
            "runtime_arguments.0".to_string(),
            "other-mcp@latest".to_string(),
        )]);
        for option in &options {
            let refused = build(&server, &pins, option, &values, true).unwrap_err();
            assert_eq!(
                codes_of(&refused),
                [codes::CONVERSION_FAILED],
                "{}",
                option.id
            );
        }
        // and the runner names are recognised however they are written
        for name in [
            "npm_config_registry",
            "NPM_CONFIG_REGISTRY",
            "UV_EXTRA_INDEX_URL",
            "PIP_INDEX_URL",
            "NODE_OPTIONS",
            "PYTHONPATH",
        ] {
            assert!(steers_the_runner(name), "{name}");
        }
        for name in [
            "NOTES_TOKEN",
            "UVICORN_PORT",
            "NODE_ENV",
            "PYTHONUNBUFFERED",
        ] {
            assert!(!steers_the_runner(name), "{name}");
        }
    }

    #[test]
    fn the_commit_runs_exactly_the_pinned_version() {
        let server = json!({
            "name": "x",
            "packages": [
                { "registryType": "npm", "identifier": "@scope/notes", "version": "latest",
                  "transport": { "type": "stdio" },
                  "environmentVariables": [{ "name": "NOTES_TOKEN", "isRequired": true, "isSecret": true }] },
                { "registryType": "pypi", "identifier": "notes", "transport": { "type": "stdio" } }
            ]
        });
        let pins = vec![
            pin("npm", "@scope/notes", Some("1.2.3"), Verified::Ok),
            pin("pypi", "notes", Some("2025.4.7"), Verified::Ok),
        ];
        let options = analyze(&server, &pins).unwrap();
        let values = BTreeMap::from([("env.NOTES_TOKEN".to_string(), "t".to_string())]);
        assert_eq!(
            build(&server, &pins, &options[0], &values, true).unwrap(),
            McpDefinition::Stdio {
                command: "npx".into(),
                args: vec!["-y".into(), "@scope/notes@1.2.3".into()],
                env: BTreeMap::from([("NOTES_TOKEN".into(), "t".into())]),
            }
        );
        assert_eq!(
            build(&server, &pins, &options[1], &BTreeMap::new(), true).unwrap(),
            McpDefinition::Stdio {
                command: "uvx".into(),
                args: vec!["notes==2025.4.7".into()],
                env: BTreeMap::new(),
            }
        );
        // the required secret, not given
        let missing = build(&server, &pins, &options[0], &BTreeMap::new(), true).unwrap_err();
        assert_eq!(codes_of(&missing), [codes::PARAMETER_REQUIRED]);
        assert_eq!(missing[0].params["key"], "env.NOTES_TOKEN");
        // no exact pin: the preflight may build it, the commit may not
        let loose = vec![pin("npm", "@scope/notes", Some("^1"), Verified::Ok)];
        assert!(build(&server, &loose, &options[0], &values, false).is_ok());
        let refused = build(&server, &loose, &options[0], &values, true).unwrap_err();
        assert_eq!(codes_of(&refused), [codes::CONVERSION_FAILED]);
    }
}
